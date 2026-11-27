import {
  BrushSettings,
  CanvasColorMode,
  CanvasDimensions,
  CanvasSelection,
  DirtyRect,
  LayerItem,
  Point,
  ToolType,
} from '../../../types/editor';
import {
  SparseTileGrid,
  TILE_SIZE,
  TileFormat,
} from '../../../utils/tileEngine';
import { get2DContext, getReusableBakeCanvas } from '../../../utils/canvasUtils';
import { CubicBezierSegment } from '../../../engine/SplineGenerator';
import {
  applyCspWatercolorEdge,
  normalizeWetEdgePower01,
  renderCompleteStroke,
  resolveDualBrushConfig,
} from '../../../engine/BrushEngine';
import { isRibbonBrush } from '../../../engine/RibbonBrushEngine';
import { LayerPixelSampler } from '../../../utils/colorMixingEngine';
import { detectWhitePaperGround } from '../../../utils/pigmentEngine';
import {
  DraftCanvasElement,
  PushHistoryStepFn,
  applySelectionCanvasClip,
} from '../types';
import { resolveStrokePigmentStrength } from './strokeHelpers';
import { StrokeSessionHelpers, StrokeSessionState } from './types';
import { StrokeHistoryToolType } from './pointerUpSpecialCommit';
import {
  commitDirectDraftToTiles,
  createRasterPostPresentWork,
} from './pointerUpDirectCommit';

export interface CommitRasterStrokeParams {
  state: StrokeSessionState;
  helpers: Pick<
    StrokeSessionHelpers,
    | 'markTouchedTiles'
    | 'resolveLiveAntiAlias'
    | 'buildLiveBrushOptions'
    | 'emitLiveSegment'
    | 'buildTouchedTileSpans'
    | 'resolveEffectiveOpacitySensor'
  >;
  grid: SparseTileGrid;
  draftCanvas: DraftCanvasElement | null | undefined;
  dirtyRect: DirtyRect;
  dims: CanvasDimensions;
  bs: BrushSettings;
  currentTool: ToolType;
  currentLayerId: string;
  activeLayer: LayerItem | undefined;
  allLayers?: LayerItem[];
  activeSelection: CanvasSelection | null;
  effectiveMode: CanvasColorMode;
  targetFormat: TileFormat;
  isEraser: boolean;
  isBgEraser: boolean;
  isMonochrome: boolean;
  hasWetEdge: boolean;
  shouldTaper: boolean;
  exitSpeed?: number;
  strokeColor: string;
  allPoints: Point[];
  tailSegments: CubicBezierSegment[];
  toolForHistory: StrokeHistoryToolType;
  label: string;
  strokeIdForHistory: string | undefined;
  enqueueHistoryTask: (task: () => void) => void;
  pushHistoryStep: PushHistoryStepFn;
}

export function commitRasterStrokeToTiles(
  opts: CommitRasterStrokeParams
): (() => void) | null {
  const {
    state,
    helpers,
    grid,
    draftCanvas,
    dirtyRect,
    dims,
    bs,
    currentTool,
    currentLayerId,
    activeLayer,
    allLayers,
    activeSelection,
    effectiveMode,
    targetFormat,
    isEraser,
    isBgEraser,
    isMonochrome,
    hasWetEdge,
    shouldTaper,
    exitSpeed,
    strokeColor,
    allPoints,
    tailSegments,
    toolForHistory,
    label,
    strokeIdForHistory,
    enqueueHistoryTask,
    pushHistoryStep,
  } = opts;

  const { x: sx, y: sy, width: dw, height: dh } = dirtyRect;
  const draftCtx = draftCanvas ? get2DContext(draftCanvas) : null;
  const draftScale = draftCanvas?.__draftScale ?? 0;
  const draftDocRect = draftCanvas?.__draftDocRect;
  const effectiveBrushCombineMode =
    (isEraser && !isBgEraser) || bs.isTransparentInk ? undefined : bs.brushCombineMode;
  const compositeOp: 'source-over' | 'destination-out' | 'source-atop' =
    (isEraser && !isBgEraser) || bs.isTransparentInk || effectiveBrushCombineMode === 'clear'
      ? 'destination-out'
      : activeLayer?.alphaLocked
      ? 'source-atop'
      : 'source-over';
  const normWetAlphaPower = normalizeWetEdgePower01(bs.wetEdgeAlphaPower, 0.25);
  const normWetValuePower = normalizeWetEdgePower01(bs.wetEdgeValuePower, 0.15);
  const monoOpts =
    targetFormat === 'monochrome-1bit'
      ? {
          threshold: activeLayer?.monoThreshold ?? 128,
          expressBlack: activeLayer?.monoExpressBlack ?? true,
          expressWhite: activeLayer?.monoExpressWhite ?? true,
        }
      : undefined;
  const selMaskOpts = activeSelection?.mask
    ? { mask: activeSelection.mask, bounds: activeSelection.bounds }
    : null;
  const pigmentStrength = resolveStrokePigmentStrength(
    bs,
    isEraser,
    isBgEraser,
    isMonochrome
  );
  const pigmentWhiteGround =
    pigmentStrength > 0.005
      ? draftCanvas?.__draftPigmentWhiteGround ??
        detectWhitePaperGround(allLayers, currentLayerId, grid)
      : false;

  const draftOriginX = draftDocRect ? Math.round(draftDocRect.x) : 0;
  const draftOriginY = draftDocRect ? Math.round(draftDocRect.y) : 0;
  const canDirectDraftCommit = Boolean(
    draftCanvas &&
      draftCtx &&
      Math.abs(draftScale - 1.0) < 1e-6 &&
      draftDocRect &&
      Math.abs(draftDocRect.x - draftOriginX) < 1e-6 &&
      Math.abs(draftDocRect.y - draftOriginY) < 1e-6 &&
      !hasWetEdge &&
      !isRibbonBrush(bs) &&
      !(state.isDualBrushStroke && Boolean(resolveDualBrushConfig(bs)?.isRibbon)) &&
      !(state.isStrokePaperTextureActive && Boolean(bs.opacitySensor?.usePressure)) &&
      (bs.postCorrection ?? 0) === 0 &&
      !shouldTaper &&
      sx >= draftOriginX &&
      sy >= draftOriginY &&
      sx + dw <= draftOriginX + draftCanvas.width &&
      sy + dh <= draftOriginY + draftCanvas.height
  );

  // For single taps or small strokes, ensure every tile overlapping the padded bake rect is included
  if (dw * dh <= 4 * TILE_SIZE * TILE_SIZE) {
    helpers.markTouchedTiles(sx, sy, sx + dw, sy + dh);
  }

  // Zero-pop Natural Paint commit: flush remaining tail segments into the exact live
  // NaturalPaintStrokeSession and composite its shaded RGBA directly into the sparse tiles.
  if (state.naturalPaintSession) {
    const natSession = state.naturalPaintSession;
    state.naturalPaintSession = null;

    for (let i = 0; i < tailSegments.length; i++) {
      const seg = tailSegments[i];
      const batch = natSession.engine.emitCubicSegment(
        seg.p0,
        seg.c1,
        seg.c2,
        seg.p3,
        state.layerPixelSampler || undefined
      );
      natSession.rasterizeBatch(batch);
    }
    if (tailSegments.length === 0) {
      natSession.flushPendingTapIfNeeded(state.layerPixelSampler || undefined);
    }

    const beforeSnapshot = new Map<
      string,
      { format: TileFormat; data: Uint8Array | null }
    >();
    const spans = helpers.buildTouchedTileSpans(sx, sy, dw, dh);
    for (let i = 0; i < spans.length; i++) {
      const sp = spans[i];
      const rgba = new Uint8ClampedArray(sp.width * sp.height * 4);
      natSession.shadeRectToBuffer(sp.x, sp.y, sp.width, sp.height, rgba);
      const spanData =
        typeof ImageData !== 'undefined'
          ? new ImageData(rgba, sp.width, sp.height)
          : ({ data: rgba, width: sp.width, height: sp.height } as ImageData);
      grid.compositeStrokeToTiles({
        layerId: currentLayerId,
        strokeData: spanData,
        destX: sp.x,
        destY: sp.y,
        format: targetFormat,
        compositeOp,
        brushCombineMode: effectiveBrushCombineMode,
        opacity: bs.opacity ?? 1.0,
        pigmentStrength,
        pigmentWhiteGround,
        monochrome: monoOpts,
        selectionMask: selMaskOpts,
        snapshotOut: beforeSnapshot,
        suppressNotify: true,
      });
    }

    natSession.finishAndDispose();

    return createRasterPostPresentWork(
      grid,
      beforeSnapshot,
      currentLayerId,
      dirtyRect,
      toolForHistory,
      label,
      strokeIdForHistory,
      enqueueHistoryTask,
      pushHistoryStep
    );
  }

  if (canDirectDraftCommit && draftCanvas && draftCtx && draftDocRect) {
    return commitDirectDraftToTiles({
      state,
      helpers,
      grid,
      draftCtx,
      draftScale,
      draftOriginX,
      draftOriginY,
      dirtyRect,
      bs,
      currentLayerId,
      activeLayer,
      targetFormat,
      compositeOp,
      brushCombineMode: effectiveBrushCombineMode,
      pigmentStrength,
      pigmentWhiteGround,
      monoOpts,
      selMaskOpts,
      isEraser,
      isBgEraser,
      isMonochrome,
      strokeColor,
      tailSegments,
      toolForHistory,
      label,
      strokeIdForHistory,
      enqueueHistoryTask,
      pushHistoryStep,
    });
  }

  // Isolated 1:1 re-bake onto a clean transparent surface for BOTH standard and color-mixing brushes.
  // Accumulating low-alpha dabs on a transparent bakeCanvas (matching live draftCanvas) and
  // compositing once via grid.compositeStrokeToTiles avoids 8-bit rounding wipeout of faint strokes
  // over opaque backgrounds/paint, skips unpacking existing tiles via createRegionCanvas, and
  // supports Watercolor Edge, BrushCombineMode, Alpha Lock, Selection Masks, and 1-bit monochrome.
  const bakeCanvas = getReusableBakeCanvas(dw, dh);
  const bCtx = get2DContext(bakeCanvas);
  if (!bCtx) return null;

  bCtx.resetTransform();
  bCtx.clearRect(0, 0, dw, dh);
  bCtx.save();
  bCtx.translate(-sx, -sy);
  bCtx.beginPath();
  bCtx.rect(sx, sy, dw, dh);
  bCtx.clip();
  applySelectionCanvasClip(bCtx, activeSelection);

  const effectiveOpacitySensor = helpers.resolveEffectiveOpacitySensor(
    bs,
    isMonochrome,
    isEraser
  );
  const bakeBs: BrushSettings =
    effectiveOpacitySensor && !bs.opacitySensor
      ? { ...bs, opacitySensor: effectiveOpacitySensor }
      : bs;
  const allowGpuMonoBake =
    isMonochrome && (bakeBs.antiAlias ?? 2) !== 0 && bakeBs.useGpu !== false;
  const bakeSampler =
    bs.colorMixing && !isEraser
      ? new LayerPixelSampler(dims, currentLayerId, grid)
      : undefined;

  renderCompleteStroke(
    bCtx,
    allPoints,
    {
      ...bakeBs,
      opacity: 1.0,
      isTransparentInk: false,
      wetEdge: 0,
      brushCombineMode: undefined,
      color: isEraser && !isBgEraser ? '#000000' : bakeBs.color,
    },
    isEraser && !isBgEraser ? 'brush' : currentTool,
    effectiveMode,
    isBgEraser,
    undefined,
    false,
    bakeSampler,
    allowGpuMonoBake,
    exitSpeed
  );
  bCtx.restore();

  if (hasWetEdge) {
    const bakeImg = bCtx.getImageData(0, 0, dw, dh);
    applyCspWatercolorEdge(
      bakeImg,
      bs.wetEdge ?? 0,
      bs.wetEdgeRadius ?? 3.0,
      normWetAlphaPower,
      normWetValuePower
    );
    bCtx.putImageData(bakeImg, 0, 0);
  }

  const beforeSnapshot = new Map<
    string,
    { format: TileFormat; data: Uint8Array | null }
  >();
  const spans = helpers.buildTouchedTileSpans(sx, sy, dw, dh);
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    const spanData = bCtx.getImageData(sp.x - sx, sp.y - sy, sp.width, sp.height);
    grid.compositeStrokeToTiles({
      layerId: currentLayerId,
      strokeData: spanData,
      destX: sp.x,
      destY: sp.y,
      format: targetFormat,
      compositeOp,
      brushCombineMode: effectiveBrushCombineMode,
      opacity: bakeBs.opacity ?? 1.0,
      pigmentStrength,
      pigmentWhiteGround,
      monochrome: monoOpts,
      selectionMask: selMaskOpts,
      snapshotOut: beforeSnapshot,
      suppressNotify: true,
    });
  }

  return createRasterPostPresentWork(
    grid,
    beforeSnapshot,
    currentLayerId,
    dirtyRect,
    toolForHistory,
    label,
    strokeIdForHistory,
    enqueueHistoryTask,
    pushHistoryStep
  );
}
