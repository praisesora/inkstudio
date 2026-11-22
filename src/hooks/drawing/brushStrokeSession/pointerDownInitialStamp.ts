import { BrushSettings, CanvasDimensions, LayerItem, Point } from '../../../types/editor';
import { getVisibleCanvasBounds } from '../../../utils/canvasUtils';
import {
  drawBrushDot,
  canUseWebGlForBrush,
  flushGpuDabs,
} from '../../../engine/BrushEngine';
import { DraftCanvasElement, applySelectionCanvasClip } from '../types';
import {
  StrokeSessionHelpers,
  StrokeSessionState,
  UseBrushStrokeSessionParams,
} from './types';

export function setupDraftCanvasSurface(
  params: UseBrushStrokeSessionParams,
  draftCanvas: DraftCanvasElement,
  draftCtx: CanvasRenderingContext2D,
  vRect: DOMRect,
  dims: CanvasDimensions,
  draftCompositeOp: GlobalCompositeOperation,
  isMonochrome: boolean
): number {
  const rawVis = getVisibleCanvasBounds(
    vRect,
    params.panRef.current,
    params.zoomRef.current,
    params.rotationRef.current,
    dims,
    128,
    params.flipXRef.current,
    params.flipYRef.current
  );
  const visMinX = rawVis.maxX > rawVis.minX ? rawVis.minX : 0;
  const visMinY = rawVis.maxY > rawVis.minY ? rawVis.minY : 0;
  const visW = Math.max(1, rawVis.maxX > rawVis.minX ? rawVis.maxX - rawVis.minX : dims.width);
  const visH = Math.max(1, rawVis.maxY > rawVis.minY ? rawVis.maxY - rawVis.minY : dims.height);
  const MAX_DRAFT_DIM = 3072;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const screenMatchedScale = Math.max(0.05, (params.zoomRef.current || 1) * dpr * 1.25);
  const draftScale = Math.min(1.0, screenMatchedScale, MAX_DRAFT_DIM / Math.max(visW, visH));
  const surfaceW = Math.max(1, Math.ceil(visW * draftScale));
  const surfaceH = Math.max(1, Math.ceil(visH * draftScale));
  if (draftCanvas.width !== surfaceW || draftCanvas.height !== surfaceH) {
    draftCanvas.width = surfaceW;
    draftCanvas.height = surfaceH;
  }

  draftCtx.resetTransform();
  draftCtx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
  draftCanvas.__draftHasContent = false;
  draftCanvas.__draftCompositeOp = draftCompositeOp;
  draftCanvas.__draftSpace = 'document';
  draftCanvas.__draftDocRect = {
    x: visMinX,
    y: visMinY,
    width: surfaceW / draftScale,
    height: surfaceH / draftScale,
  };
  draftCanvas.__draftScale = draftScale;
  draftCanvas.__draftMonochrome = isMonochrome;
  draftCanvas.__draftVersion = (draftCanvas.__draftVersion || 0) + 1;

  draftCtx.setTransform(
    draftScale,
    0,
    0,
    draftScale,
    -visMinX * draftScale,
    -visMinY * draftScale
  );
  draftCtx.save();
  draftCtx.beginPath();
  draftCtx.rect(0, 0, dims.width, dims.height);
  draftCtx.clip();
  applySelectionCanvasClip(draftCtx, params.selectionRef.current);

  return draftScale;
}

export interface InitialStampParams {
  draftCtx: CanvasRenderingContext2D;
  firstDotPoint: Point;
  bs: BrushSettings;
  strokeColor: string;
  strokeHardness: number;
  strokeFlow: number;
  strokeSpacing: number;
  isMonochrome: boolean;
  isEraser: boolean;
  isBgEraser: boolean;
  useWireframeEraser: boolean;
  draftScale: number;
  zoom: number;
  canvas: HTMLCanvasElement | null;
  activeLayer: LayerItem | undefined;
}

export type InitialStampHelpers = Pick<
  StrokeSessionHelpers,
  'resolveLiveAntiAlias' | 'buildLiveBrushOptions' | 'emitLiveSegment'
>;

export function renderInitialStrokeDot(
  state: StrokeSessionState,
  helpers: InitialStampHelpers,
  opts: InitialStampParams
): void {
  const {
    draftCtx,
    firstDotPoint,
    bs,
    strokeColor,
    strokeHardness,
    strokeFlow,
    strokeSpacing,
    isMonochrome,
    isEraser,
    isBgEraser,
    useWireframeEraser,
    draftScale,
    zoom,
    canvas,
    activeLayer,
  } = opts;

  if (useWireframeEraser) {
    draftCtx.save();
    draftCtx.strokeStyle = 'rgba(255, 80, 80, 0.75)';
    draftCtx.setLineDash([3, 3]);
    draftCtx.lineWidth = Math.max(1, 1.5 / Math.max(0.05, zoom));
    draftCtx.beginPath();
    draftCtx.arc(
      firstDotPoint.x,
      firstDotPoint.y,
      Math.max(1, firstDotPoint.width / 2),
      0,
      Math.PI * 2
    );
    draftCtx.stroke();
    draftCtx.restore();
    return;
  }

  if (state.naturalPaintSession) {
    state.naturalPaintSession.stampInitialPoint(
      draftCtx,
      firstDotPoint,
      state.layerPixelSampler || undefined,
      true
    );
    return;
  }

  const liveColor =
    (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;
  const liveAA = helpers.resolveLiveAntiAlias(bs, isMonochrome, draftScale);
  const gpuBatch = state.frameGpuDabs;
  gpuBatch.length = 0;

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
  const useGpu = canUseWebGlForBrush(brushOpts);
  drawBrushDot(draftCtx, firstDotPoint, liveColor, brushOpts, useGpu ? gpuBatch : undefined);

  if (useGpu && gpuBatch.length > 0) {
    if (!flushGpuDabs(draftCtx, gpuBatch, liveColor, brushOpts)) {
      drawBrushDot(draftCtx, firstDotPoint, liveColor, brushOpts);
    }
    gpuBatch.length = 0;
  }
}

export interface ShiftLineSegmentParams extends Omit<InitialStampParams, 'firstDotPoint' | 'zoom'> {
  startPoint: Point;
  startNow: number;
  dirtyRadius: number;
}

export function renderShiftLineInitialSegment(
  state: StrokeSessionState,
  helpers: InitialStampHelpers,
  opts: ShiftLineSegmentParams
): void {
  const {
    draftCtx,
    startPoint,
    startNow,
    dirtyRadius,
    bs,
    strokeColor,
    strokeHardness,
    strokeFlow,
    strokeSpacing,
    isMonochrome,
    isEraser,
    isBgEraser,
    useWireframeEraser,
    draftScale,
    canvas,
    activeLayer,
  } = opts;

  const pipeline = state.strokePipeline;
  const lineSeg = pipeline
    .getSplineGenerator()
    .generateCornerSegment(state.allStrokePoints[0], startPoint);
  const liveAA = helpers.resolveLiveAntiAlias(bs, isMonochrome, draftScale);
  const liveOpts = helpers.buildLiveBrushOptions(
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
  const useGpuLine = !useWireframeEraser && canUseWebGlForBrush(liveOpts);
  const gpuBatch = state.frameGpuDabs;
  gpuBatch.length = 0;

  helpers.emitLiveSegment(
    draftCtx,
    lineSeg,
    bs,
    strokeColor,
    strokeHardness,
    strokeFlow,
    strokeSpacing,
    isMonochrome,
    isEraser,
    isBgEraser,
    useWireframeEraser,
    canvas,
    activeLayer,
    useGpuLine ? gpuBatch : undefined
  );

  if (useGpuLine && gpuBatch.length > 0) {
    const liveColor =
      (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;
    flushGpuDabs(draftCtx, gpuBatch, liveColor, liveOpts);
    gpuBatch.length = 0;
  }

  pipeline.seedKnot(
    startPoint.x,
    startPoint.y,
    startPoint.pressure,
    startPoint.width,
    startPoint.tiltX ?? 0,
    startPoint.tiltY ?? 0,
    startPoint.twist ?? 0,
    startNow,
    dirtyRadius
  );
}
