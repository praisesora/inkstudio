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
  releaseTemporaryCanvas,
} from '../../../utils/tileEngine';
import { get2DContext, getReusableBakeCanvas } from '../../../utils/canvasUtils';
import { CubicBezierSegment } from '../../../engine/SplineGenerator';
import { applyCspWatercolorEdge, renderCompleteStroke } from '../../../engine/BrushEngine';
import { binarizeImageDataBuffer } from '../../../utils/colorUtils';
import { LayerPixelSampler } from '../../../utils/colorMixingEngine';
import {
  DraftCanvasElement,
  PushHistoryStepFn,
  applySelectionCanvasClip,
  applySelectionMaskToImageData,
} from '../types';
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
  const compositeOp: 'source-over' | 'destination-out' | 'source-atop' =
    (isEraser && !isBgEraser) || bs.isTransparentInk
      ? 'destination-out'
      : activeLayer?.alphaLocked
      ? 'source-atop'
      : 'source-over';
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
      !bs.colorMixing &&
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
        opacity: bs.opacity ?? 1.0,
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

  if (!bs.colorMixing) {
    // Fast isolated 1:1 re-bake: never allocates/unpacks existing tiles via createRegionCanvas
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

    renderCompleteStroke(
      bCtx,
      allPoints,
      {
        ...bakeBs,
        opacity: 1.0,
        isTransparentInk: false,
        wetEdge: 0,
        color: isEraser && !isBgEraser ? '#000000' : bakeBs.color,
      },
      isEraser && !isBgEraser ? 'brush' : currentTool,
      effectiveMode,
      isBgEraser,
      undefined,
      false,
      undefined,
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
        bs.wetEdgeAlphaPower ?? 25,
        bs.wetEdgeValuePower ?? 15
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
        opacity: bakeBs.opacity ?? 1.0,
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

  // Wet color-mixing path requires existing layer pixels on the same canvas
  const canPoolRegion = dw <= 2048 && dh <= 2048;
  let pooledCanvas: HTMLCanvasElement | null = null;
  if (canPoolRegion && typeof document !== 'undefined') {
    if (!state.reusableRegionCanvas) {
      state.reusableRegionCanvas = document.createElement('canvas');
    }
    pooledCanvas = state.reusableRegionCanvas;
  }
  const regionCanvas = grid.createRegionCanvas(currentLayerId, dirtyRect, pooledCanvas);
  const rCtx = regionCanvas ? get2DContext(regionCanvas) : null;
  if (!regionCanvas || !rCtx) return null;

  const beforeSelectionData = activeSelection?.mask ? rCtx.getImageData(0, 0, dw, dh) : null;

  rCtx.save();
  rCtx.translate(-sx, -sy);
  rCtx.beginPath();
  rCtx.rect(sx, sy, dw, dh);
  rCtx.clip();
  applySelectionCanvasClip(rCtx, activeSelection);

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
  const needsIsolatedBake = (bakeBs.opacity ?? 1.0) < 0.999 || hasWetEdge;
  const bakeSampler = !isEraser
    ? new LayerPixelSampler(dims, currentLayerId, grid)
    : undefined;

  if (!needsIsolatedBake) {
    renderCompleteStroke(
      rCtx,
      allPoints,
      bakeBs,
      currentTool,
      effectiveMode,
      isBgEraser,
      undefined,
      Boolean(activeLayer?.alphaLocked),
      bakeSampler,
      allowGpuMonoBake,
      exitSpeed
    );
  } else {
    rCtx.globalAlpha = Math.max(0.01, Math.min(1.0, bakeBs.opacity ?? 1.0));
    rCtx.globalCompositeOperation = compositeOp;
    const bakeCanvas = getReusableBakeCanvas(dw, dh);
    const bCtx = get2DContext(bakeCanvas);
    if (bCtx) {
      bCtx.resetTransform();
      bCtx.clearRect(0, 0, dw, dh);
      bCtx.save();
      bCtx.translate(-sx, -sy);
      renderCompleteStroke(
        bCtx,
        allPoints,
        {
          ...bakeBs,
          opacity: 1.0,
          isTransparentInk: false,
          wetEdge: 0,
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
          bs.wetEdgeAlphaPower ?? 25,
          bs.wetEdgeValuePower ?? 15
        );
        bCtx.putImageData(bakeImg, 0, 0);
      }

      rCtx.drawImage(bakeCanvas, 0, 0, dw, dh, sx, sy, dw, dh);
    }
  }

  rCtx.restore();

  if (beforeSelectionData && activeSelection?.mask) {
    const fullAfter = rCtx.getImageData(0, 0, dw, dh);
    applySelectionMaskToImageData(beforeSelectionData, fullAfter, sx, sy, activeSelection);
    rCtx.putImageData(fullAfter, 0, 0);
  }

  const spans = helpers.buildTouchedTileSpans(sx, sy, dw, dh);
  const beforeSnapshot = new Map<
    string,
    { format: TileFormat; data: Uint8Array | null }
  >();
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    const subSnap = grid.snapshotTilesInRect(currentLayerId, sp);
    for (const [k, v] of subSnap) {
      if (!beforeSnapshot.has(k)) beforeSnapshot.set(k, v);
    }
    const spanData = rCtx.getImageData(sp.x - sx, sp.y - sy, sp.width, sp.height);
    if (targetFormat === 'monochrome-1bit') {
      binarizeImageDataBuffer(
        spanData,
        activeLayer?.monoThreshold ?? 128,
        activeLayer?.monoExpressBlack ?? true,
        activeLayer?.monoExpressWhite ?? true
      );
    }
    grid.writeImageData(currentLayerId, spanData, sp.x, sp.y, targetFormat, true);
  }

  if (!canPoolRegion) {
    releaseTemporaryCanvas(regionCanvas);
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
