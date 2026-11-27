import React from 'react';
import { Point } from '../../../types/editor';
import { calculateStrokeWidth, get2DContext } from '../../../utils/canvasUtils';
import { PaintReservoir, LayerPixelSampler } from '../../../utils/colorMixingEngine';
import { detectWhitePaperGround } from '../../../utils/pigmentEngine';
import {
  isNaturalPaintBrush,
  NaturalPaintStrokeSession,
} from '../../../engine/NaturalPaintRenderer';
import { isRibbonBrush, RibbonStrokeSession } from '../../../engine/RibbonBrushEngine';
import {
  buildSecondaryBrushSettings,
  needsStrokeLevelPaperTexture,
  resolveDualBrushConfig,
} from '../../../engine/BrushEngine';
import {
  prepareDualDraftCanvases,
  prepareRawDraftCanvasForStrokeTexture,
  resolveStrokePigmentStrength,
  syncDualBrushRegionToDraft,
  syncStrokePaperTextureRegionToDraft,
} from './strokeHelpers';
import { useUiStore } from '../../../stores';
import { recoveryService } from '../../../services/recoveryService';
import { isLinearPressureCurve } from '../../../utils/pressureCurve';
import { DraftCanvasElement, isBackgroundLayerId } from '../types';
import {
  StrokeSessionHelpers,
  StrokeSessionState,
  UseBrushStrokeSessionParams,
} from './types';
import {
  renderInitialStrokeDot,
  renderShiftLineInitialSegment,
  setupDraftCanvasSurface,
} from './pointerDownInitialStamp';
import { NATIVE_PEN_POINTER_ID } from './nativeTabletBridge';

export function runPointerDown(
  state: StrokeSessionState,
  params: UseBrushStrokeSessionParams,
  helpers: StrokeSessionHelpers,
  e: React.PointerEvent<HTMLElement>,
  _coalescedEvents?: PointerEvent[]
): void {
  const currentTool = helpers.getTool();
  const isBrushOrEraser = currentTool === 'brush' || currentTool === 'eraser';
  if (
    !isBrushOrEraser ||
    params.disabled ||
    e.button !== 0 ||
    params.activeLayerLockedRef.current ||
    !params.activeLayerVisibleRef.current
  ) {
    return;
  }
  e.preventDefault();
  if (params.isDrawingRef.current) {
    // Defense-in-depth: never let a WinTab CXO_SYSTEM-synthesized DOM mouse pointerdown
    // abort an active native pen stroke that carries true hardware pressure.
    if (
      state.activePointerId === NATIVE_PEN_POINTER_ID &&
      e.pointerId !== NATIVE_PEN_POINTER_ID
    ) {
      return;
    }
    helpers.abortActiveStroke();
  }

  const dims = params.dimensionsRef.current;
  const currentLayerIdCheck = params.activeLayerIdRef.current;
  if (!currentLayerIdCheck || dims.width <= 0 || dims.height <= 0) return;

  // Flush any deferred idle history tasks from previous strokes before starting a new stroke
  // so undo/redo order and tile deltas stay strictly consistent during rapid sketching.
  params.flushPendingHistoryTasks();

  const maskCanvas = params.getActiveMaskCanvas();
  if (params.isMaskModeRef.current) {
    if (!maskCanvas) return;
  }

  if (params.viewportRef.current) {
    state.cachedViewportRect = params.viewportRef.current.getBoundingClientRect();
  }
  const vRect = helpers.getViewportRect();
  if (!vRect) return;

  const draftCanvas = params.effectiveDraftCanvasRef?.current as
    | DraftCanvasElement
    | null
    | undefined;
  if (!draftCanvas) return;

  if (state.clearDraftRaf !== null) {
    cancelAnimationFrame(state.clearDraftRaf);
    state.clearDraftRaf = null;
  }

  const draftCtx = get2DContext(draftCanvas);
  if (!draftCtx) return;

  const isEraser = currentTool === 'eraser';
  const currentLayerId = params.activeLayerIdRef.current;
  const isBgEraser = isEraser && isBackgroundLayerId(currentLayerId);
  const allLayers = params.layersRef.current || [];
  const activeLayer = allLayers.find((l) => l.id === currentLayerId);
  const bs = helpers.getBrushSettings();
  const mode = params.colorModeRef.current;
  const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
  const isMonochrome = mode === 'monochrome' || isMonoLayer;
  const isVectorLayer = activeLayer?.type === 'vector';
  const isVectorOrMask = isVectorLayer || params.isMaskModeRef.current;
  const useWireframeEraser = isVectorOrMask && isEraser && !isBgEraser;

  const draftCompositeOp: GlobalCompositeOperation =
    isVectorOrMask || isBgEraser
      ? 'source-over'
      : isEraser || bs.isTransparentInk || bs.brushCombineMode === 'clear'
      ? 'destination-out'
      : bs.brushCombineMode === 'behind'
      ? 'destination-over'
      : activeLayer?.alphaLocked
      ? 'source-atop'
      : 'source-over';

  const preferNativeDraftScale = Boolean(
    !isVectorOrMask &&
      (bs.colorMixing || bs.customTipImage || bs.paperTextureImage)
  );
  const draftScale = setupDraftCanvasSurface(
    params,
    draftCanvas,
    draftCtx,
    vRect,
    dims,
    draftCompositeOp,
    isMonochrome,
    preferNativeDraftScale
  );

  const draftPigmentStrength = isVectorOrMask
    ? 0
    : resolveStrokePigmentStrength(bs, isEraser, isBgEraser, isMonochrome);
  draftCanvas.__draftPigmentStrength = draftPigmentStrength;
  draftCanvas.__draftPigmentWhiteGround =
    draftPigmentStrength > 0.005
      ? detectWhitePaperGround(allLayers, currentLayerId, params.activeTileGridRef.current)
      : false;
  draftCanvas.__draftCombineMode =
    (isEraser && !isBgEraser) || bs.isTransparentInk ? undefined : bs.brushCombineMode;

  helpers.clearPredictedCanvas();

  if (params.interactionRef.current) {
    try {
      params.interactionRef.current.setPointerCapture(e.pointerId);
    } catch {
      // Ignore pointer capture errors
    }
  }
  state.activePointerId = e.pointerId;
  params.isDrawingRef.current = true;
  recoveryService.setDrawingActive(true);

  const firstEvent = e.nativeEvent;
  const rawStartPoint = helpers.getCanvasPoint(firstEvent);
  const isAltOverride = e.altKey;
  const activeStraightRuler = params.straightRulerRef?.current ?? null;
  const straightStart = state.straightSnapSession.startStrokePoint(
    rawStartPoint,
    activeStraightRuler,
    params.zoomRef.current || 1.0,
    isAltOverride
  );
  let startPoint = straightStart;
  if (state.straightSnapSession.isActive()) {
    state.snapSession.endStroke();
    helpers.emitConstraintAxisChange(null);
  } else {
    state.snapSession.startStroke(rawStartPoint, params.rulerRef.current ?? null, isAltOverride);
    startPoint = state.snapSession.snapPoint(
      rawStartPoint,
      params.rulerRef.current ?? null,
      isAltOverride
    );
    helpers.emitConstraintAxisChange(state.snapSession.getActiveAxis());
  }

  const strokeColor = helpers.resolveStrokeColor(bs, isEraser, isBgEraser, isMonochrome, mode);
  const strokeHardness = isMonochrome ? 1.0 : bs.hardness ?? 1.0;
  const strokeFlow = isMonochrome ? 1.0 : bs.flow ?? 1.0;
  const strokeSpacing = bs.spacing ?? 0.08;

  const globalPressureCurve = useUiStore.getState().appSettings.pressureCurve;
  const hasCustomGlobalCurve = Boolean(
    globalPressureCurve &&
      globalPressureCurve.enabled &&
      !isLinearPressureCurve(globalPressureCurve.points)
  );

  const pipeline = state.strokePipeline;
  pipeline.beginStroke({
    stabilizerLevel: bs.stabilization ?? 0,
    zoom: params.zoomRef.current || 1.0,
    sharpCorners: bs.sharpCorners !== false,
    brushSize: bs.size,
    color: strokeColor,
    pointerId: e.pointerId,
    globalPressureCurve,
  });

  const startNow = startPoint.timestamp ?? performance.now();
  state.lastPointTime = startNow;
  const hasCustomCurve =
    hasCustomGlobalCurve || Boolean(bs.pressureCurve && bs.pressureCurve.length > 0);
  const taperEngine = pipeline.getTaperEngine();
  if (bs.usePressure) {
    const rawStartP = firstEvent.pointerType === 'mouse' ? 0.5 : firstEvent.pressure ?? 0;
    const rawBaseStartP = hasCustomCurve
      ? startPoint.pressure
      : taperEngine.mapPressure(startPoint.pressure);
    const baseStartP = rawStartP > 0.005 ? Math.max(0.015, rawBaseStartP) : rawBaseStartP;
    const smoothStartP = taperEngine.smoothPressure(baseStartP);
    const effectiveStartP = rawStartP > 0.005 ? Math.max(0.015, smoothStartP) : smoothStartP;
    startPoint.pressure = effectiveStartP;
    startPoint.width = calculateStrokeWidth(
      bs.size,
      effectiveStartP,
      bs.minSizeFactor,
      bs.usePressure,
      firstEvent.pointerType,
      bs.pressureCurveGamma ?? 1.0,
      1.0,
      bs.pressureCurve
    );
  }
  const hasTaper = Boolean(bs.taper?.useOut || bs.taper?.useIn);
  if (isMonochrome && !hasTaper && startPoint.width < 1.25) {
    startPoint.width = 1.25;
  }

  const dualCfg = resolveDualBrushConfig(bs);
  const dualSecInfo = dualCfg ? buildSecondaryBrushSettings(bs, dualCfg) : null;
  const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0, dualCfg?.scatter ?? 0);
  const maxBrushDim = Math.max(startPoint.width, bs.size || 10, dualSecInfo?.settings.size || 0);
  const blurMargin = (1 - strokeHardness) * (startPoint.width * 1.5);
  const r = Math.max(
    32,
    Math.ceil(maxBrushDim * (2.8 + scatterFactor * 2) + blurMargin + 32)
  );

  const shiftAction = useUiStore.getState().appSettings.modifierKeys.shift;
  const prevStrokeEnd = params.lastStrokeEndRef.current;
  const isShiftLine =
    Boolean(e.shiftKey) &&
    shiftAction === 'straight-line' &&
    !params.isMaskModeRef.current &&
    prevStrokeEnd !== null &&
    prevStrokeEnd.layerId === currentLayerId;
  state.isShiftLineStroke = isShiftLine;

  if (isShiftLine && prevStrokeEnd) {
    const pLineStart: Point = {
      x: prevStrokeEnd.x,
      y: prevStrokeEnd.y,
      pressure: startPoint.pressure,
      width: startPoint.width,
      tiltX: startPoint.tiltX,
      tiltY: startPoint.tiltY,
      twist: startPoint.twist,
      timestamp: startNow - 16,
    };
    const pLineMid: Point = {
      x: (pLineStart.x + startPoint.x) * 0.5,
      y: (pLineStart.y + startPoint.y) * 0.5,
      pressure: startPoint.pressure,
      width: startPoint.width,
      tiltX: startPoint.tiltX,
      tiltY: startPoint.tiltY,
      twist: startPoint.twist,
      timestamp: startNow - 8,
    };
    state.allStrokePoints = [pLineStart, pLineMid, startPoint];
    pipeline.seedKnot(
      pLineStart.x,
      pLineStart.y,
      pLineStart.pressure,
      pLineStart.width,
      pLineStart.tiltX ?? 0,
      pLineStart.tiltY ?? 0,
      pLineStart.twist ?? 0,
      pLineStart.timestamp ?? 0,
      r
    );
    pipeline.seedKnot(
      pLineMid.x,
      pLineMid.y,
      pLineMid.pressure,
      pLineMid.width,
      pLineMid.tiltX ?? 0,
      pLineMid.tiltY ?? 0,
      pLineMid.twist ?? 0,
      pLineMid.timestamp ?? 0,
      r
    );
  } else {
    state.allStrokePoints = [startPoint];
    pipeline.seedKnot(
      startPoint.x,
      startPoint.y,
      startPoint.pressure,
      startPoint.width,
      startPoint.tiltX ?? 0,
      startPoint.tiltY ?? 0,
      startPoint.twist ?? 0,
      startNow,
      r
    );
  }

  state.stabilizedPoint = { ...startPoint };
  state.lastProcessedPoint.x = startPoint.x;
  state.lastProcessedPoint.y = startPoint.y;
  state.hasLastProcessedPoint = true;
  state.lastQueuedPressure = startPoint.pressure;
  state.recentPointsTrail = [
    {
      x: startPoint.x,
      y: startPoint.y,
      t: startNow,
      pressure: startPoint.pressure,
      width: startPoint.width,
    },
  ];
  state.strokeTotalDistance =
    isShiftLine && prevStrokeEnd
      ? Math.hypot(startPoint.x - prevStrokeEnd.x, startPoint.y - prevStrokeEnd.y)
      : 0;

  helpers.dispatchPointerStat(startPoint.x, startPoint.y, startPoint.pressure);

  const minInitX =
    isShiftLine && prevStrokeEnd ? Math.min(startPoint.x, prevStrokeEnd.x) : startPoint.x;
  const minInitY =
    isShiftLine && prevStrokeEnd ? Math.min(startPoint.y, prevStrokeEnd.y) : startPoint.y;
  const maxInitX =
    isShiftLine && prevStrokeEnd ? Math.max(startPoint.x, prevStrokeEnd.x) : startPoint.x;
  const maxInitY =
    isShiftLine && prevStrokeEnd ? Math.max(startPoint.y, prevStrokeEnd.y) : startPoint.y;
  state.dirtyRect = {
    minX: Math.max(0, Math.floor(minInitX - r)),
    minY: Math.max(0, Math.floor(minInitY - r)),
    maxX: Math.min(dims.width, Math.ceil(maxInitX + r)),
    maxY: Math.min(dims.height, Math.ceil(maxInitY + r)),
  };
  pipeline.expandDirtyRectBounds(
    state.dirtyRect.minX,
    state.dirtyRect.minY,
    state.dirtyRect.maxX,
    state.dirtyRect.maxY
  );
  state.touchedTiles.clear();
  helpers.markTouchedTiles(
    state.dirtyRect.minX,
    state.dirtyRect.minY,
    state.dirtyRect.maxX,
    state.dirtyRect.maxY
  );

  const isNaturalBrush =
    !isEraser &&
    !isBgEraser &&
    !isMonochrome &&
    !bs.isTransparentInk &&
    !isVectorOrMask &&
    isNaturalPaintBrush(bs);
  const isWetColor =
    !isEraser &&
    bs.colorMixing !== false &&
    (Boolean(bs.colorMixing) || (isNaturalBrush && Boolean(bs.naturalPaint?.spatialMixing)));
  state.isWetColorStroke = isWetColor;
  state.liveNeedsNotify = false;

  if (state.naturalPaintSession) {
    state.naturalPaintSession.finishAndDispose();
    state.naturalPaintSession = null;
  }

  if (isWetColor) {
    state.layerPixelSampler = new LayerPixelSampler(
      maskCanvas || dims,
      currentLayerId,
      params.activeTileGridRef.current
    );
    state.activeReservoir = new PaintReservoir(strokeColor);
  } else {
    state.layerPixelSampler = null;
    state.activeReservoir = null;
  }

  if (isNaturalBrush) {
    state.naturalStrokeSeed = (state.naturalStrokeSeed + 9973) & 0x7fffffff;
    state.naturalPaintSession = new NaturalPaintStrokeSession(
      bs,
      strokeColor,
      undefined,
      state.naturalStrokeSeed
    );
  }

  const isRibbonStroke =
    !useWireframeEraser &&
    !state.naturalPaintSession &&
    isRibbonBrush(bs);
  state.ribbonSession = isRibbonStroke ? new RibbonStrokeSession() : null;

  state.isStrokePaperTextureActive =
    !isEraser &&
    !isBgEraser &&
    !isMonochrome &&
    !isVectorOrMask &&
    !state.naturalPaintSession &&
    !isRibbonStroke &&
    needsStrokeLevelPaperTexture(bs);

  state.isDualBrushStroke = Boolean(
    dualCfg && !useWireframeEraser && !isVectorOrMask && !state.naturalPaintSession
  );
  state.dualSecondaryDabCounter.count = 0;
  state.dualSecondaryDabCounter.lastAngle = undefined;
  state.dualSecondaryDabCounter.lastStepDist = undefined;
  state.dualFrameSecondaryGpuDabs.length = 0;
  state.dualSecondaryRibbonSession =
    state.isDualBrushStroke && dualSecInfo && isRibbonBrush(dualSecInfo.settings)
      ? new RibbonStrokeSession()
      : null;

  let activeDrawCtx: CanvasRenderingContext2D = draftCtx;
  if (state.isDualBrushStroke) {
    const dualPair = prepareDualDraftCanvases(
      state,
      draftCanvas,
      dims,
      params.selectionRef.current
    );
    if (dualPair) {
      activeDrawCtx = dualPair.primaryCtx;
    } else {
      state.isDualBrushStroke = false;
    }
  }
  if (!state.isDualBrushStroke && state.isStrokePaperTextureActive) {
    const rawCtx = prepareRawDraftCanvasForStrokeTexture(
      state,
      draftCanvas,
      dims,
      params.selectionRef.current
    );
    if (rawCtx) {
      activeDrawCtx = rawCtx;
    } else {
      state.isStrokePaperTextureActive = false;
    }
  }

  const strokeId = `stroke-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  state.currentStrokeId = strokeId;
  params.onCollabStrokeStartRef.current?.(strokeId, currentLayerId, bs, currentTool, startPoint);

  state.liveDabCounter.count = 0;
  state.liveDabCounter.lastAngle = undefined;
  state.liveDabCounter.lastStepDist = undefined;
  state.liveDabCounter.lockedInitialAngle = undefined;
  state.liveDabCounter.initOriginX = undefined;
  state.liveDabCounter.initOriginY = undefined;
  state.dualSecondaryDabCounter.lockedInitialAngle = undefined;
  state.dualSecondaryDabCounter.initOriginX = undefined;
  state.dualSecondaryDabCounter.initOriginY = undefined;
  state.stampRemainderDist = bs.customTipImage
    ? Math.max(0.15, startPoint.width * (bs.spacing ?? 0.07))
    : Math.max(0.12, startPoint.width * (bs.spacing ?? 0.08));
  if (state.isDualBrushStroke && dualSecInfo) {
    const secStartW = Math.max(0.2, startPoint.width * dualSecInfo.sizeRatio);
    const secSpacing = dualSecInfo.settings.spacing ?? 0.1;
    state.dualSecondaryRemainderDist = dualSecInfo.settings.customTipImage
      ? Math.max(0.15, secStartW * secSpacing)
      : Math.max(0.12, secStartW * secSpacing);
  } else {
    state.dualSecondaryRemainderDist = 0;
  }

  const firstDotPoint = state.allStrokePoints[0];

  // For flat/elliptical direction-following brushes, wait for the first real movement segment
  // to determine tangent orientation instead of stamping a sideways notch at baseAngleRad on pointerdown.
  const deferDirectionInitialDot =
    !isShiftLine &&
    !state.naturalPaintSession &&
    !useWireframeEraser &&
    (isRibbonStroke ||
      ((bs.customTipAngleDynamics === 'direction' ||
        bs.customTipAngleDynamics === 'direction-random' ||
        bs.customTipAngleDynamics === 'initial-direction') &&
        (bs.thickness ?? 1.0) < 0.85));

  // For stylus strokes with pressure-sensitive opacity/density/curve or an unpopulated 0.5
  // Windows Ink / W3C pointerdown sentinel, defer the initial dot until the first real
  // pointermove delivers confirmed hardware pressure (single taps still stamp cleanly on pointerup).
  const isPenDown = firstEvent.pointerType === 'pen';
  const rawPenDownP = firstEvent.pressure ?? 0;
  const isSentinelPenDown = isPenDown && Math.abs(rawPenDownP - 0.5) < 1e-4;
  const hasPressureDensityOrCurve = Boolean(
    bs.usePressure &&
      (bs.densitySensor?.usePressure ||
        bs.opacitySensor?.usePressure ||
        bs.densityOfPaintSensor?.usePressure ||
        (bs.pressureCurve && bs.pressureCurve.length > 0))
  );
  const deferPenInitialDot =
    !isShiftLine &&
    !state.naturalPaintSession &&
    !useWireframeEraser &&
    isPenDown &&
    (hasPressureDensityOrCurve || isSentinelPenDown);

  state.deferredInitialDot = deferPenInitialDot;
  state.deferredStartRawPressure = rawPenDownP;

  if (!deferDirectionInitialDot && !deferPenInitialDot) {
    renderInitialStrokeDot(state, helpers, {
      draftCtx: activeDrawCtx,
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
      zoom: params.zoomRef.current,
      canvas: maskCanvas,
      activeLayer,
    });
  } else {
    // Start stamping right at distance 0 on the first movement segment so there is no gap at stroke start
    state.stampRemainderDist = 0;
    if (state.isDualBrushStroke) {
      state.dualSecondaryRemainderDist = 0;
    }
  }

  if (isShiftLine && prevStrokeEnd) {
    renderShiftLineInitialSegment(state, helpers, {
      draftCtx: activeDrawCtx,
      startPoint,
      startNow,
      dirtyRadius: r,
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
      canvas: maskCanvas,
      activeLayer,
    });
  }

  if (state.isDualBrushStroke && state.dirtyRect) {
    syncDualBrushRegionToDraft(
      state,
      draftCanvas,
      draftCtx,
      bs,
      state.dirtyRect.minX,
      state.dirtyRect.minY,
      state.dirtyRect.maxX,
      state.dirtyRect.maxY
    );
  } else if (state.isStrokePaperTextureActive && state.dirtyRect) {
    syncStrokePaperTextureRegionToDraft(
      state,
      draftCanvas,
      draftCtx,
      bs,
      state.dirtyRect.minX,
      state.dirtyRect.minY,
      state.dirtyRect.maxX,
      state.dirtyRect.maxY
    );
  }

  const hasInitialVisualContent =
    (!deferDirectionInitialDot && !deferPenInitialDot) || (isShiftLine && Boolean(prevStrokeEnd));
  if (hasInitialVisualContent) {
    draftCanvas.__draftHasContent = true;
    draftCanvas.__draftVersion = (draftCanvas.__draftVersion || 0) + 1;
    params.activeTileGridRef.current.notifyChange(true);
  } else {
    draftCanvas.__draftHasContent = false;
  }
  state.liveNeedsNotify = false;

  if (pipeline.getPendingCount() > 0 && state.drawRafId === null) {
    state.drawRafId = requestAnimationFrame(helpers.flushPendingPoints);
  }
}
