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
  buildSecondaryBrushSettings,
  resolveDualBrushConfig,
  scalePointsForSecondaryBrush,
  scaleSegmentForSecondaryBrush,
} from '../../../engine/BrushEngine';
import {
  buildRibbonRenderOptionsFromBrushSettings,
  isRibbonBrush,
  renderCompleteRibbonStroke,
  resolveRibbonRepeatMode,
  RibbonStrokeSession,
} from '../../../engine/RibbonBrushEngine';
import { GpuDab } from '../../../engine/WebGlBrushEngine';
import { DraftCanvasElement, applySelectionCanvasClip } from '../types';
import { buildLiveSecondaryBrushOptions } from './strokeHelpers';
import {
  StrokeSessionHelpers,
  StrokeSessionState,
  UseBrushStrokeSessionParams,
} from './types';

function emitLiveDualSecondarySegment(
  state: StrokeSessionState,
  params: UseBrushStrokeSessionParams,
  helpers: Pick<StrokeSessionHelpers, 'resolveLiveAntiAlias' | 'markTouchedTiles'>,
  seg: CubicBezierSegment,
  bs: BrushSettings,
  isMonochrome: boolean
): void {
  const dualCfg = resolveDualBrushConfig(bs);
  if (!dualCfg || !state.dualSecondaryCanvas) return;
  const secCtx = get2DContext(state.dualSecondaryCanvas);
  if (!secCtx) return;

  const secInfo = buildSecondaryBrushSettings(bs, dualCfg);
  const secBs = secInfo.settings;
  const secSeg = scaleSegmentForSecondaryBrush(seg, secInfo.sizeRatio, secBs.size);

  const secScatter = Math.max(0, dualCfg.scatter ?? 0);
  const secPad = Math.ceil(
    Math.max(secSeg.p0.width, secSeg.p3.width, secBs.size || 10) * (2.8 + secScatter * 2) + 32
  );
  const sMinX = Math.min(secSeg.p0.x, secSeg.c1.x, secSeg.c2.x, secSeg.p3.x) - secPad;
  const sMinY = Math.min(secSeg.p0.y, secSeg.c1.y, secSeg.c2.y, secSeg.p3.y) - secPad;
  const sMaxX = Math.max(secSeg.p0.x, secSeg.c1.x, secSeg.c2.x, secSeg.p3.x) + secPad;
  const sMaxY = Math.max(secSeg.p0.y, secSeg.c1.y, secSeg.c2.y, secSeg.p3.y) + secPad;
  state.strokePipeline.expandDirtyRectBounds(sMinX, sMinY, sMaxX, sMaxY);
  helpers.markTouchedTiles(sMinX, sMinY, sMaxX, sMaxY);

  const draftCanvas = params.effectiveDraftCanvasRef?.current as
    | DraftCanvasElement
    | null
    | undefined;
  const draftScale = draftCanvas?.__draftScale ?? 1.0;
  const liveAA = helpers.resolveLiveAntiAlias(secBs, isMonochrome, draftScale);

  if (isRibbonBrush(secBs)) {
    const repeatMode = resolveRibbonRepeatMode(secBs.subTipOrder);
    const ribbonOpts = buildRibbonRenderOptionsFromBrushSettings(
      secBs,
      'color',
      false,
      false,
      false,
      false,
      undefined,
      {
        opacity: 1.0,
        flow: secBs.flow ?? 1.0,
        hardness: secBs.hardness ?? 1.0,
        antiAlias: liveAA ?? secBs.antiAlias ?? 2,
        primaryColor: '#ffffff',
        isEraser: false,
        isBgEraser: false,
        alphaLocked: false,
        isTransparentInk: false,
      }
    );

    if (repeatMode === 'once' && state.allStrokePoints.length >= 2 && draftCanvas) {
      const docRect = draftCanvas.__draftDocRect;
      if (docRect) {
        secCtx.clearRect(docRect.x, docRect.y, docRect.width, docRect.height);
      } else {
        secCtx.clearRect(0, 0, state.dualSecondaryCanvas.width, state.dualSecondaryCanvas.height);
      }
      const scaledPts = scalePointsForSecondaryBrush(
        state.allStrokePoints,
        secInfo.sizeRatio,
        secBs.size
      );
      renderCompleteRibbonStroke(
        secCtx,
        scaledPts,
        {
          ...secBs,
          opacity: 1.0,
          antiAlias: liveAA ?? secBs.antiAlias,
          color: '#ffffff',
          isTransparentInk: false,
        },
        'brush',
        'color',
        false,
        false,
        false,
        undefined,
        ribbonOpts
      );
      return;
    }

    if (!state.dualSecondaryRibbonSession) {
      state.dualSecondaryRibbonSession = new RibbonStrokeSession();
    }
    state.dualSecondaryRibbonSession.appendCubicSegment(secCtx, secSeg, ribbonOpts, 'brush');
    return;
  }

  const secOpts = buildLiveSecondaryBrushOptions(
    secBs,
    isMonochrome,
    liveAA,
    state.strokeTotalDistance
  );
  const useSecGpu = canUseWebGlForBrush(secOpts);

  state.dualSecondaryRemainderDist = drawBrushCubicBezierSegment(
    secCtx,
    secSeg.p0,
    secSeg.c1,
    secSeg.c2,
    secSeg.p3,
    '#ffffff',
    secOpts,
    state.dualSecondaryRemainderDist,
    state.dualSecondaryDabCounter,
    useSecGpu ? state.dualFrameSecondaryGpuDabs : undefined
  );
}

export function flushLiveDualSecondaryGpuBatch(
  state: StrokeSessionState,
  helpers: Pick<StrokeSessionHelpers, 'resolveLiveAntiAlias'>,
  bs: BrushSettings,
  isMonochrome: boolean,
  draftScale: number
): void {
  if (!state.isDualBrushStroke || state.dualFrameSecondaryGpuDabs.length === 0) return;
  const dualCfg = resolveDualBrushConfig(bs);
  if (!dualCfg || !state.dualSecondaryCanvas) {
    state.dualFrameSecondaryGpuDabs.length = 0;
    return;
  }
  const secCtx = get2DContext(state.dualSecondaryCanvas);
  if (!secCtx) {
    state.dualFrameSecondaryGpuDabs.length = 0;
    return;
  }
  const secInfo = buildSecondaryBrushSettings(bs, dualCfg);
  const liveAA = helpers.resolveLiveAntiAlias(secInfo.settings, isMonochrome, draftScale);
  const secOpts = buildLiveSecondaryBrushOptions(
    secInfo.settings,
    isMonochrome,
    liveAA,
    state.strokeTotalDistance
  );
  flushGpuDabs(secCtx, state.dualFrameSecondaryGpuDabs, '#ffffff', secOpts);
  state.dualFrameSecondaryGpuDabs.length = 0;
}

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
  gpuBatch: GpuDab[] | undefined,
  precomputedBrushOpts?: import('../../../engine/BrushEngine').BrushRenderOptions
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

  if (state.naturalPaintSession) {
    state.naturalPaintSession.appendCubicSegment(
      sStart,
      c1Pt,
      c2Pt,
      sEnd,
      state.layerPixelSampler || undefined
    );
    return;
  }

  if (isRibbonBrush(bs)) {
    const liveColor =
      (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;
    const draftCanvas = params.effectiveDraftCanvasRef?.current as
      | DraftCanvasElement
      | null
      | undefined;
    const draftScale = draftCanvas?.__draftScale ?? 1.0;
    const liveAA = helpers.resolveLiveAntiAlias(bs, isMonochrome, draftScale);
    const repeatMode = resolveRibbonRepeatMode(bs.subTipOrder);

    const ribbonOpts = buildRibbonRenderOptionsFromBrushSettings(
      bs,
      isMonochrome ? 'monochrome' : params.colorModeRef.current,
      isBgEraser,
      false,
      false,
      isMonochrome && (liveAA ?? bs.antiAlias ?? 2) !== 0 && bs.useGpu !== false,
      undefined,
      {
        opacity: 1.0,
        flow: strokeFlow,
        hardness: strokeHardness,
        antiAlias: liveAA ?? (isMonochrome ? 0 : bs.antiAlias ?? 2),
        opacitySensor: helpers.resolveEffectiveOpacitySensor(bs, isMonochrome, isEraser),
        primaryColor: liveColor,
        isEraser: false,
        isBgEraser: false,
        alphaLocked: false,
        isTransparentInk: false,
      }
    );

    if (repeatMode === 'once' && state.allStrokePoints.length >= 2 && draftCanvas) {
      const docRect = draftCanvas.__draftDocRect;
      if (docRect) {
        draftCtx.clearRect(docRect.x, docRect.y, docRect.width, docRect.height);
      } else {
        draftCtx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
      }
      renderCompleteRibbonStroke(
        draftCtx,
        state.allStrokePoints,
        {
          ...bs,
          opacity: 1.0,
          flow: strokeFlow,
          hardness: strokeHardness,
          antiAlias: liveAA ?? bs.antiAlias,
          color: liveColor,
          isTransparentInk: false,
        },
        'brush',
        isMonochrome ? 'monochrome' : params.colorModeRef.current,
        false,
        false,
        isMonochrome && (liveAA ?? bs.antiAlias ?? 2) !== 0 && bs.useGpu !== false,
        undefined,
        ribbonOpts
      );
      if (state.isDualBrushStroke) {
        emitLiveDualSecondarySegment(state, params, helpers, seg, bs, isMonochrome);
      }
      return;
    }

    if (!state.ribbonSession) {
      state.ribbonSession = new RibbonStrokeSession();
    }
    state.ribbonSession.appendCubicSegment(draftCtx, seg, ribbonOpts, 'brush');
    if (state.isDualBrushStroke) {
      emitLiveDualSecondarySegment(state, params, helpers, seg, bs, isMonochrome);
    }
    return;
  }

  const liveColor =
    (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;

  let brushOpts = precomputedBrushOpts;
  if (brushOpts) {
    brushOpts.currentStrokeDist = state.strokeTotalDistance;
  } else {
    const draftCanvas = params.effectiveDraftCanvasRef?.current as
      | DraftCanvasElement
      | null
      | undefined;
    const draftScale = draftCanvas?.__draftScale ?? 1.0;
    const liveAA = helpers.resolveLiveAntiAlias(bs, isMonochrome, draftScale);

    brushOpts = helpers.buildLiveBrushOptions(
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
  }

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

  if (state.isDualBrushStroke) {
    emitLiveDualSecondarySegment(state, params, helpers, seg, bs, isMonochrome);
  }
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
  const draftCanvas = params.effectiveDraftCanvasRef?.current as
    | DraftCanvasElement
    | null
    | undefined;
  const isTranslucentPigment =
    (draftCanvas?.__draftPigmentStrength ?? 0) > 0.005 &&
    ((bs.opacity ?? 1) < 0.995 ||
      (bs.flow ?? 1) < 0.995 ||
      (bs.hardness ?? 1) < 0.98 ||
      Boolean(bs.opacitySensor?.usePressure));
  if (
    helpers.getTool() === 'eraser' ||
    bs.isTransparentInk ||
    bs.colorMixing ||
    isTranslucentPigment ||
    state.naturalPaintSession ||
    isRibbonBrush(bs) ||
    Boolean(resolveDualBrushConfig(bs))
  ) {
    return;
  }
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

  const safeZoom = Math.max(0.15, params.zoomRef.current || 1.0);
  const maxPredDist = Math.min(24 / safeZoom, Math.max(6 / safeZoom, (bs.size || 10) * 1.25));
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

  const drew = pipeline.buildPredictedSegments(
    predCoords.length > 0 ? predCoords : null,
    maxPredDist,
    (seg) => {
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
    }
  );

  if (useGpuPred && predGpuDabs.length > 0) {
    flushGpuDabs(pCtx, predGpuDabs, strokeColor, predOpts);
    predGpuDabs.length = 0;
  }

  pCtx.restore();
  if (drew) {
    state.isPredictedCanvasDirty = true;
  }
}
