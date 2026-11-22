import React from 'react';
import { CanvasColorMode, VectorStroke } from '../../../types/editor';
import { TileFormat } from '../../../utils/tileEngine';
import { get2DContext, applyParametricTaper } from '../../../utils/canvasUtils';
import { computeClampedBakeDirtyRect } from '../../../engine/StrokePipeline';
import { CubicBezierSegment } from '../../../engine/SplineGenerator';
import { recoveryService } from '../../../services/recoveryService';
import { DraftCanvasElement, isBackgroundLayerId } from '../types';
import { commitVectorStrokeOrErase } from '../useVectorDrawing';
import {
  StrokeSessionHelpers,
  StrokeSessionState,
  UseBrushStrokeSessionParams,
} from './types';
import {
  StrokeHistoryToolType,
  commitMaskModeStroke,
  resolveStrokeHistoryLabel,
} from './pointerUpSpecialCommit';
import { commitRasterStrokeToTiles } from './pointerUpRasterCommit';

export function runPointerUp(
  state: StrokeSessionState,
  params: UseBrushStrokeSessionParams,
  helpers: StrokeSessionHelpers,
  e: React.PointerEvent<HTMLElement>
): void {
  if (!params.isDrawingRef.current || e.pointerId !== state.activePointerId) {
    return;
  }

  e.preventDefault();
  helpers.clearPredictedCanvas();

  if (params.interactionRef.current && params.interactionRef.current.hasPointerCapture(e.pointerId)) {
    try {
      params.interactionRef.current.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore release errors
    }
  }

  if (state.drawRafId !== null) {
    cancelAnimationFrame(state.drawRafId);
    state.drawRafId = null;
  }
  helpers.flushPendingPoints(true);

  const bs = helpers.getBrushSettings();
  const dims = params.dimensionsRef.current;
  const grid = params.activeTileGridRef.current;
  const endPoint = helpers.getCanvasPoint(e);
  const draftCanvas = params.effectiveDraftCanvasRef?.current as
    | DraftCanvasElement
    | null
    | undefined;
  const maskCanvas = params.getActiveMaskCanvas();

  const currentTool = helpers.getTool();
  const currentLayerId = params.activeLayerIdRef.current;
  const isEraser = currentTool === 'eraser';
  const isBgEraser = isEraser && isBackgroundLayerId(currentLayerId);
  const mode = params.colorModeRef.current;
  const isPencil =
    !isEraser && !bs.customTipImage && (bs.preset?.startsWith('pencil') ?? false);

  const activeLayer = params.layersRef.current?.find((l) => l.id === currentLayerId);
  const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
  const isMonochrome = mode === 'monochrome' || isMonoLayer;
  const strokeColor = helpers.resolveStrokeColor(bs, isEraser, isBgEraser, isMonochrome, mode);

  const pipeline = state.strokePipeline;
  const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
  const tailPadExtra = Math.ceil((bs.size || 10) * (1.8 + scatterFactor * 2) + 24);
  const enableFlickTaper =
    !isEraser &&
    !state.isShiftLineStroke &&
    activeLayer?.type !== 'vector' &&
    Boolean(bs.taper?.useOut);

  let addedFlickPoints = false;
  const tailSegments: CubicBezierSegment[] = [];
  pipeline.finalizeStroke(e.nativeEvent?.timeStamp || e.timeStamp || performance.now(), {
    enableFlickTaper,
    dirtyPadExtra: tailPadExtra,
    onPoint: (sample) => {
      addedFlickPoints = true;
      state.allStrokePoints.push({
        x: sample.x,
        y: sample.y,
        pressure: sample.pressure,
        width: sample.width,
        tiltX: sample.tiltX,
        tiltY: sample.tiltY,
        twist: sample.twist,
        timestamp: sample.timestamp,
        isCorner: sample.isCorner,
      });
    },
    onSegment: (seg) => {
      tailSegments.push({
        p0: { ...seg.p0 },
        c1: { ...seg.c1 },
        c2: { ...seg.c2 },
        p3: { ...seg.p3 },
      });
      const segPad = Math.ceil(
        Math.max(seg.p0.width, seg.p3.width, bs.size || 10) * (2.8 + scatterFactor * 2) + 32
      );
      const tMinX = Math.min(seg.p0.x, seg.c1.x, seg.c2.x, seg.p3.x) - segPad;
      const tMinY = Math.min(seg.p0.y, seg.c1.y, seg.c2.y, seg.p3.y) - segPad;
      const tMaxX = Math.max(seg.p0.x, seg.c1.x, seg.c2.x, seg.p3.x) + segPad;
      const tMaxY = Math.max(seg.p0.y, seg.c1.y, seg.c2.y, seg.p3.y) + segPad;
      pipeline.expandDirtyRectBounds(tMinX, tMinY, tMaxX, tMaxY);
      helpers.markTouchedTiles(tMinX, tMinY, tMaxX, tMaxY);
    },
  });

  const pDirty = pipeline.dirtyRect;
  const mergedDirty = state.dirtyRect
    ? {
        minX: Math.min(
          state.dirtyRect.minX,
          Number.isFinite(pDirty.minX) ? pDirty.minX : state.dirtyRect.minX
        ),
        minY: Math.min(
          state.dirtyRect.minY,
          Number.isFinite(pDirty.minY) ? pDirty.minY : state.dirtyRect.minY
        ),
        maxX: Math.max(
          state.dirtyRect.maxX,
          Number.isFinite(pDirty.maxX) ? pDirty.maxX : state.dirtyRect.maxX
        ),
        maxY: Math.max(
          state.dirtyRect.maxY,
          Number.isFinite(pDirty.maxY) ? pDirty.maxY : state.dirtyRect.maxY
        ),
      }
    : Number.isFinite(pDirty.minX) && Number.isFinite(pDirty.maxX)
    ? { ...pDirty }
    : null;

  let exitSpeed = 0;
  if (state.recentPointsTrail.length >= 2) {
    const trail = state.recentPointsTrail;
    const sampleIdx = Math.max(0, trail.length - 4);
    const pA = trail[sampleIdx];
    const pB = trail[trail.length - 1];
    const dwellMs = Math.max(0, performance.now() - pB.t);
    const dt = Math.max(1, pB.t - pA.t + dwellMs);
    exitSpeed = Math.hypot(pB.x - pA.x, pB.y - pA.y) / dt;
  }

  const shouldTaper =
    Boolean(bs.taper?.useIn) || (Boolean(bs.taper?.useOut) && !addedFlickPoints);
  if (shouldTaper && state.allStrokePoints.length >= 3) {
    applyParametricTaper(state.allStrokePoints, {
      useIn: Boolean(bs.taper?.useIn),
      useOut: Boolean(bs.taper?.useOut) && !addedFlickPoints,
      minSizeFactor: bs.minSizeFactor,
      exitSpeed,
    });
  }

  const allPoints = state.allStrokePoints;
  let createdVectorStroke: VectorStroke | undefined;
  let postPresentWork: (() => void) | null = null;

  if (allPoints.length > 0 && !params.isMaskModeRef.current) {
    const finalPt = allPoints[allPoints.length - 1];
    params.lastStrokeEndRef.current = {
      x: finalPt.x,
      y: finalPt.y,
      pressure: finalPt.pressure,
      width: finalPt.width,
      layerId: currentLayerId,
    };
  }

  if (
    activeLayer?.type === 'vector' &&
    allPoints.length > 0 &&
    dims.width > 0 &&
    dims.height > 0
  ) {
    createdVectorStroke = commitVectorStrokeOrErase({
      activeLayer,
      currentLayerId,
      allPoints,
      bs,
      isEraser,
      isPencil,
      isMonochrome,
      strokeColor,
      dims,
      grid,
      mergedDirty,
      strokeId: state.currentStrokeId,
      pushHistoryStep: params.pushHistoryStep,
    });
  } else if (mergedDirty && allPoints.length > 0 && dims.width > 0 && dims.height > 0) {
    const hasWetEdge =
      !isMonochrome && !isEraser && !bs.isTransparentInk && (bs.wetEdge ?? 0) > 0.01;
    const clampedBakeRect = computeClampedBakeDirtyRect(
      mergedDirty,
      dims.width,
      dims.height,
      bs.size || 10,
      hasWetEdge ? bs.wetEdge ?? 0 : 0,
      bs.wetEdgeRadius ?? 3.0
    );

    if (clampedBakeRect) {
      const strokeIdForHistory = state.currentStrokeId || undefined;
      const label = resolveStrokeHistoryLabel(bs, currentTool, isMonochrome);
      const dirtyRect = clampedBakeRect;
      const toolForHistory: StrokeHistoryToolType =
        currentTool === 'eraser' ? 'eraser' : isPencil ? 'pencil' : 'brush';
      const targetFormat: TileFormat =
        isMonochrome && !isBackgroundLayerId(currentLayerId) ? 'monochrome-1bit' : 'color-32bit';
      const effectiveMode: CanvasColorMode = isMonochrome ? 'monochrome' : mode;
      const activeSelection = params.selectionRef.current;

      if (params.isMaskModeRef.current && maskCanvas) {
        commitMaskModeStroke({
          canvas: maskCanvas,
          dirtyRect,
          bs,
          strokeColor,
          isEraser,
          currentTool,
          allPoints,
          activeSelection,
          activeLayer,
          currentLayerId,
          toolForHistory,
          strokeIdForHistory,
          enqueueHistoryTask: params.enqueueHistoryTask,
          pushHistoryStep: params.pushHistoryStep,
        });
      } else {
        postPresentWork = commitRasterStrokeToTiles({
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
          strokeColor,
          allPoints,
          tailSegments,
          toolForHistory,
          label,
          strokeIdForHistory,
          enqueueHistoryTask: params.enqueueHistoryTask,
          pushHistoryStep: params.pushHistoryStep,
        });
      }
    }
  }

  if (state.clearDraftRaf !== null) {
    cancelAnimationFrame(state.clearDraftRaf);
    state.clearDraftRaf = null;
  }
  if (draftCanvas) {
    const dCtx = get2DContext(draftCanvas);
    if (dCtx) {
      try {
        dCtx.restore();
      } catch {
        // Ignore restore underflow
      }
      dCtx.resetTransform();
      dCtx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
    }
    draftCanvas.__draftHasContent = false;
    draftCanvas.__draftCompositeOp = 'source-over';
    draftCanvas.__draftMonochrome = false;
    draftCanvas.__draftVersion = (draftCanvas.__draftVersion || 0) + 1;
  }
  helpers.clearPredictedCanvas();

  grid.notifyChange(true);
  postPresentWork?.();

  if (state.currentStrokeId) {
    params.onCollabStrokeFinishRef.current?.(
      state.currentStrokeId,
      currentLayerId,
      endPoint,
      mergedDirty
        ? {
            x: Math.max(0, Math.floor(mergedDirty.minX)),
            y: Math.max(0, Math.floor(mergedDirty.minY)),
            width: Math.max(
              1,
              Math.ceil(mergedDirty.maxX) - Math.max(0, Math.floor(mergedDirty.minX))
            ),
            height: Math.max(
              1,
              Math.ceil(mergedDirty.maxY) - Math.max(0, Math.floor(mergedDirty.minY))
            ),
          }
        : undefined,
      createdVectorStroke
    );
    state.currentStrokeId = null;
  }

  state.strokePipeline.abortStroke();
  state.frameGpuDabs.length = 0;
  params.isDrawingRef.current = false;
  recoveryService.setDrawingActive(false);
  state.activePointerId = null;
  state.allStrokePoints = [];
  state.stabilizedPoint = null;
  state.hasLastProcessedPoint = false;
  state.dirtyRect = null;
  state.touchedTiles.clear();
  state.liveNeedsNotify = false;
  state.isShiftLineStroke = false;
  state.layerPixelSampler = null;
  state.activeReservoir = null;
  state.snapSession.endStroke();
  state.straightSnapSession.endStroke();
  helpers.emitConstraintAxisChange(null);

  if (params.isMaskModeRef.current) {
    params.onUpdateMaskThumbnailRef.current?.(currentLayerId);
    grid.notifyChange(true);
  } else {
    params.enqueueHistoryTask(() => {
      params.onUpdateLayerThumbnail(currentLayerId);
    });
  }
}
