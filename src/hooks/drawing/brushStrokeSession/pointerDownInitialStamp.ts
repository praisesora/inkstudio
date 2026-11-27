import { BrushSettings, CanvasDimensions, LayerItem, Point } from '../../../types/editor';
import { get2DContext, getVisibleCanvasBounds } from '../../../utils/canvasUtils';
import {
  drawBrushDot,
  canUseWebGlForBrush,
  flushGpuDabs,
  buildSecondaryBrushSettings,
  resolveDualBrushConfig,
  scalePointForSecondaryBrush,
} from '../../../engine/BrushEngine';
import { isRibbonBrush } from '../../../engine/RibbonBrushEngine';
import { DraftCanvasElement, applySelectionCanvasClip } from '../types';
import { buildLiveSecondaryBrushOptions } from './strokeHelpers';
import { flushLiveDualSecondaryGpuBatch } from './liveSegmentEmitter';
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
  isMonochrome: boolean,
  preferNativeScale: boolean = false
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
  const visMinX = rawVis.maxX > rawVis.minX ? Math.floor(rawVis.minX) : 0;
  const visMinY = rawVis.maxY > rawVis.minY ? Math.floor(rawVis.minY) : 0;
  const visW = Math.max(1, rawVis.maxX > rawVis.minX ? Math.ceil(rawVis.maxX) - visMinX : dims.width);
  const visH = Math.max(1, rawVis.maxY > rawVis.minY ? Math.ceil(rawVis.maxY) - visMinY : dims.height);
  const MAX_DRAFT_DIM = 3072;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const screenMatchedScale = Math.max(0.05, (params.zoomRef.current || 1) * dpr * 1.25);
  const maxDimScale = MAX_DRAFT_DIM / Math.max(visW, visH);
  // Keep 1:1 native document resolution for textured custom tips and SpatialTipMixer color-mixing
  // brushes whenever the visible canvas fits within MAX_DRAFT_DIM, avoiding bilinear dilution of
  // porous 1px tip pores during live drawing and enabling zero-pop direct draft commit on pointerUp.
  const draftScale = preferNativeScale
    ? Math.min(1.0, maxDimScale)
    : Math.min(1.0, screenMatchedScale, maxDimScale);
  const surfaceW = Math.max(1, Math.ceil(visW * draftScale));
  const surfaceH = Math.max(1, Math.ceil(visH * draftScale));
  const resized = draftCanvas.width !== surfaceW || draftCanvas.height !== surfaceH;
  if (resized) {
    draftCanvas.width = surfaceW;
    draftCanvas.height = surfaceH;
    draftCanvas.__clipSaved = false;
  } else if (draftCanvas.__clipSaved) {
    try {
      draftCtx.restore();
    } catch {
      // Ignore restore underflow
    }
    draftCanvas.__clipSaved = false;
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
  draftCanvas.__draftFrameDirtyRect = null;
  draftCanvas.__draftForceFullUpload = true;

  draftCtx.setTransform(
    draftScale,
    0,
    0,
    draftScale,
    -visMinX * draftScale,
    -visMinY * draftScale
  );
  draftCtx.save();
  draftCanvas.__clipSaved = true;
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

  if (state.isDualBrushStroke && state.dualSecondaryCanvas) {
    const dualCfg = resolveDualBrushConfig(bs);
    const secCtx = get2DContext(state.dualSecondaryCanvas);
    if (dualCfg && secCtx) {
      const secInfo = buildSecondaryBrushSettings(bs, dualCfg);
      if (!isRibbonBrush(secInfo.settings)) {
        const secPt = scalePointForSecondaryBrush(
          firstDotPoint,
          secInfo.sizeRatio,
          secInfo.settings.size
        );
        const secAA = helpers.resolveLiveAntiAlias(secInfo.settings, isMonochrome, draftScale);
        const secOpts = buildLiveSecondaryBrushOptions(secInfo.settings, isMonochrome, secAA, 0);
        const useSecGpu = canUseWebGlForBrush(secOpts);
        const secBatch = state.dualFrameSecondaryGpuDabs;
        secBatch.length = 0;
        drawBrushDot(secCtx, secPt, '#ffffff', secOpts, useSecGpu ? secBatch : undefined);
        if (useSecGpu && secBatch.length > 0) {
          if (!flushGpuDabs(secCtx, secBatch, '#ffffff', secOpts)) {
            drawBrushDot(secCtx, secPt, '#ffffff', secOpts);
          }
          secBatch.length = 0;
        }
      }
    }
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
  if (state.isDualBrushStroke) {
    flushLiveDualSecondaryGpuBatch(state, helpers, bs, isMonochrome, draftScale);
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
