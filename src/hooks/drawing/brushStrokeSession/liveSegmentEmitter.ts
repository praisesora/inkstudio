import { BrushSettings, LayerItem } from '../../../types/editor';
import {
  screenToCanvasInto,
  getCanvasToViewportMatrix,
  get2DContext,
} from '../../../utils/canvasUtils';
import { CubicBezierSegment } from '../../../engine/SplineGenerator';
import {
  drawBrushCubicBezierSegment,
  canUseWebGlForBrush,
  flushGpuDabs,
  buildBrushRenderOptions,
} from '../../../engine/BrushEngine';
import { GpuDab } from '../../../engine/WebGlBrushEngine';
import { DraftCanvasElement, applySelectionCanvasClip } from '../types';
import {
  StrokeSessionHelpers,
  StrokeSessionState,
  UseBrushStrokeSessionParams,
} from './types';

export function emitLiveSegmentToDraft(
  state: StrokeSessionState,
  params: UseBrushStrokeSessionParams,
  helpers: StrokeSessionHelpers,
  draftCtx: CanvasRenderingContext2D,
  seg: CubicBezierSegment,
  bs: BrushSettings,
  strokeColor: string,
  strokeHardness: number,
  strokeFlow: number,
  strokeSpacing: number,
  isMonochrome: boolean,
  isEraser: boolean,
  isBgEraser: boolean,
  useWireframeEraser: boolean,
  canvas: HTMLCanvasElement | null,
  activeLayer: LayerItem | undefined,
  gpuBatch: GpuDab[] | undefined
): void {
  const sStart = seg.p0;
  const c1Pt = seg.c1;
  const c2Pt = seg.c2;
  const sEnd = seg.p3;

  const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
  const segPad = Math.ceil(
    Math.max(sStart.width, sEnd.width, bs.size || 10) * (2.8 + scatterFactor * 2) + 32
  );
  const segMinX = Math.min(sStart.x, c1Pt.x, c2Pt.x, sEnd.x) - segPad;
  const segMinY = Math.min(sStart.y, c1Pt.y, c2Pt.y, sEnd.y) - segPad;
  const segMaxX = Math.max(sStart.x, c1Pt.x, c2Pt.x, sEnd.x) + segPad;
  const segMaxY = Math.max(sStart.y, c1Pt.y, c2Pt.y, sEnd.y) + segPad;
  state.strokePipeline.expandDirtyRectBounds(segMinX, segMinY, segMaxX, segMaxY);
  helpers.markTouchedTiles(segMinX, segMinY, segMaxX, segMaxY);

  if (useWireframeEraser) {
    draftCtx.save();
    draftCtx.lineCap = 'round';
    draftCtx.lineJoin = 'round';
    draftCtx.setLineDash([4, 4]);
    draftCtx.strokeStyle = 'rgba(255, 80, 80, 0.75)';
    draftCtx.lineWidth = Math.max(1, (sStart.width + sEnd.width) / 2);
    draftCtx.beginPath();
    draftCtx.moveTo(sStart.x, sStart.y);
    draftCtx.bezierCurveTo(c1Pt.x, c1Pt.y, c2Pt.x, c2Pt.y, sEnd.x, sEnd.y);
    draftCtx.stroke();
    draftCtx.restore();
    return;
  }

  const liveColor =
    (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;
  const draftCanvas = params.effectiveDraftCanvasRef?.current as
    | DraftCanvasElement
    | null
    | undefined;
  const draftScale = draftCanvas?.__draftScale ?? 1.0;
  const liveAA = helpers.resolveLiveAntiAlias(bs, isMonochrome, draftScale);

  const brushOpts = helpers.buildLiveBrushOptions(
    bs,
    strokeFlow,
    strokeSpacing,
    strokeHardness,
    isMonochrome,
    canvas,
    activeLayer,
    isEraser,
    isBgEraser,
    true,
    liveAA
  );

  state.stampRemainderDist = drawBrushCubicBezierSegment(
    draftCtx,
    sStart,
    c1Pt,
    c2Pt,
    sEnd,
    liveColor,
    brushOpts,
    state.stampRemainderDist,
    state.liveDabCounter,
    gpuBatch
  );
}

export function renderPredictedStrokeOverlay(
  state: StrokeSessionState,
  params: UseBrushStrokeSessionParams,
  helpers: StrokeSessionHelpers,
  predEvents: PointerEvent[],
  vRect: DOMRect
): void {
  helpers.clearPredictedCanvas();
  const bs = helpers.getBrushSettings();
  if (helpers.getTool() === 'eraser' || bs.isTransparentInk || bs.colorMixing) return;
  const pipeline = state.strokePipeline;
  if (pipeline.getKnotCount() < 2) return;
  const pCanvas = helpers.getPredictedCanvas();
  if (!pCanvas) return;
  const pCtx = get2DContext(pCanvas);
  if (!pCtx) return;

  const dims = params.dimensionsRef.current;
  const mode = params.colorModeRef.current;
  const currentLayerId = params.activeLayerIdRef.current;
  const activeLayer = params.layersRef.current?.find((l) => l.id === currentLayerId);
  const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
  const isMonochrome = mode === 'monochrome' || isMonoLayer;
  const strokeColor = helpers.resolveStrokeColor(bs, false, false, isMonochrome, mode);
  const strokeHardness = isMonochrome ? 1.0 : bs.hardness ?? 1.0;
  const strokeFlow = isMonochrome ? 1.0 : bs.flow ?? 1.0;
  const strokeSpacing = bs.spacing ?? 0.08;

  const maxPredDist = Math.min(20, Math.max(4, (bs.size || 10) * 1.15));
  const predCoords = state.predDocCoords;
  predCoords.length = 0;

  if (predEvents && predEvents.length > 0) {
    const scratch = state.scratchDocCoord;
    const pool = state.predCoordPool;
    const limit = Math.min(predEvents.length, pool.length);
    for (let i = 0; i < limit; i++) {
      const ev = predEvents[i];
      screenToCanvasInto(
        ev.clientX,
        ev.clientY,
        vRect,
        params.panRef.current,
        params.zoomRef.current,
        params.rotationRef.current,
        dims,
        scratch,
        params.flipXRef.current,
        params.flipYRef.current
      );
      const slot = pool[i];
      slot.x = scratch.x;
      slot.y = scratch.y;
      slot.pressure = ev.pressure;
      predCoords.push(slot);
    }
  }

  const scaleX = pCanvas.width / Math.max(1, vRect.width);
  const scaleY = pCanvas.height / Math.max(1, vRect.height);
  const matrix = getCanvasToViewportMatrix(
    params.panRef.current,
    params.zoomRef.current,
    params.rotationRef.current,
    dims,
    scaleX,
    scaleY,
    params.flipXRef.current,
    params.flipYRef.current
  );

  pCtx.save();
  pCtx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  pCtx.beginPath();
  pCtx.rect(0, 0, dims.width, dims.height);
  pCtx.clip();
  applySelectionCanvasClip(pCtx, params.selectionRef.current);

  let predRem = state.stampRemainderDist;
  const predAA = helpers.resolveLiveAntiAlias(bs, isMonochrome, params.zoomRef.current);
  const predOpts = buildBrushRenderOptions(bs, {
    opacity: 1.0,
    flow: strokeFlow,
    spacing: strokeSpacing,
    hardness: strokeHardness,
    antiAlias: predAA,
    opacitySensor: helpers.resolveEffectiveOpacitySensor(bs, isMonochrome, false),
    wetEdge: 0,
    colorMixing: false,
    isEraser: false,
    isBgEraser: false,
    alphaLocked: false,
    isTransparentInk: false,
  });

  const predGpuDabs = state.frameGpuDabs;
  predGpuDabs.length = 0;
  const useGpuPred = canUseWebGlForBrush(predOpts);

  state.predDabCounter.count = state.liveDabCounter.count;

  const drew = pipeline.buildPredictedSegments(null, maxPredDist, (seg) => {
    predRem = drawBrushCubicBezierSegment(
      pCtx,
      seg.p0,
      seg.c1,
      seg.c2,
      seg.p3,
      strokeColor,
      predOpts,
      predRem,
      state.predDabCounter,
      useGpuPred ? predGpuDabs : undefined
    );
  });

  if (useGpuPred && predGpuDabs.length > 0) {
    flushGpuDabs(pCtx, predGpuDabs, strokeColor, predOpts);
    predGpuDabs.length = 0;
  }

  pCtx.restore();
  if (drew) {
    state.isPredictedCanvasDirty = true;
  }
}
