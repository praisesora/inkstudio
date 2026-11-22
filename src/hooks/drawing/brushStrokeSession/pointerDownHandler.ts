import React from 'react';
import { Point } from '../../../types/editor';
import { calculateStrokeWidth, get2DContext } from '../../../utils/canvasUtils';
import { PaintReservoir, LayerPixelSampler } from '../../../utils/colorMixingEngine';
import {
  isNaturalPaintBrush,
  NaturalPaintStrokeSession,
} from '../../../engine/NaturalPaintRenderer';
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
    helpers.abortActiveStroke();
  }

  const dims = params.dimensionsRef.current;
  const currentLayerIdCheck = params.activeLayerIdRef.current;
  if (!currentLayerIdCheck || dims.width <= 0 || dims.height <= 0) return;

  const maskCanvas = params.getActiveMaskCanvas();
  if (params.isMaskModeRef.current) {
    params.flushPendingHistoryTasks();
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
      : isEraser || bs.isTransparentInk
      ? 'destination-out'
      : activeLayer?.alphaLocked
      ? 'source-atop'
      : 'source-over';

  const draftScale = setupDraftCanvasSurface(
    params,
    draftCanvas,
    draftCtx,
    vRect,
    dims,
    draftCompositeOp,
    isMonochrome
  );

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
    const baseStartP = hasCustomCurve
      ? startPoint.pressure
      : taperEngine.mapPressure(startPoint.pressure);
    const smoothStartP = taperEngine.smoothPressure(baseStartP);
    startPoint.pressure = smoothStartP;
    startPoint.width = calculateStrokeWidth(
      bs.size,
      smoothStartP,
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

  const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
  const blurMargin = (1 - strokeHardness) * (startPoint.width * 1.5);
  const r = Math.max(
    32,
    Math.ceil(
      Math.max(startPoint.width, bs.size || 10) * (2.8 + scatterFactor * 2) + blurMargin + 32
    )
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

  const strokeId = `stroke-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  state.currentStrokeId = strokeId;
  params.onCollabStrokeStartRef.current?.(strokeId, currentLayerId, bs, currentTool, startPoint);

  state.liveDabCounter.count = 0;
  state.stampRemainderDist = bs.customTipImage
    ? Math.max(0.15, startPoint.width * (bs.spacing ?? 0.07))
    : Math.max(0.12, startPoint.width * (bs.spacing ?? 0.08));

  const firstDotPoint = state.allStrokePoints[0];

  renderInitialStrokeDot(state, helpers, {
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
    zoom: params.zoomRef.current,
    canvas: maskCanvas,
    activeLayer,
  });

  if (isShiftLine && prevStrokeEnd) {
    renderShiftLineInitialSegment(state, helpers, {
      draftCtx,
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

  draftCanvas.__draftHasContent = true;
  draftCanvas.__draftVersion = (draftCanvas.__draftVersion || 0) + 1;
  params.activeTileGridRef.current.notifyChange(true);
  state.liveNeedsNotify = false;

  if (pipeline.getPendingCount() > 0 && state.drawRafId === null) {
    state.drawRafId = requestAnimationFrame(helpers.flushPendingPoints);
  }
}
