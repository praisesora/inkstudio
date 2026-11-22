import { Point } from '../../../types/editor';
import { calculateStrokeWidth, get2DContext } from '../../../utils/canvasUtils';
import { canUseWebGlForBrush, flushGpuDabs } from '../../../engine/BrushEngine';
import { isLinearPressureCurve } from '../../../utils/pressureCurve';
import { DraftCanvasElement, isBackgroundLayerId } from '../types';
import {
  StrokeSessionHelpers,
  StrokeSessionState,
  UseBrushStrokeSessionParams,
} from './types';

export function runFlushPendingPoints(
  state: StrokeSessionState,
  params: UseBrushStrokeSessionParams,
  helpers: StrokeSessionHelpers,
  skipDisplayArg?: boolean | number
): void {
  state.drawRafId = null;
  if (!params.isDrawingRef.current) return;
  const isSkipDisplay = skipDisplayArg === true;

  const pipeline = state.strokePipeline;
  if (pipeline.getPendingCount() === 0) {
    if (isSkipDisplay) {
      state.latestPredicted = null;
      return;
    }
    const predData = state.latestPredicted;
    state.latestPredicted = null;
    const vRect = helpers.getViewportRect();
    if (vRect && state.allStrokePoints.length > 0) {
      helpers.renderPredictedStroke(predData ? predData.predEvents : [], vRect);
    } else if (state.isPredictedCanvasDirty) {
      helpers.clearPredictedCanvas();
    }
    return;
  }

  const draftCanvas = params.effectiveDraftCanvasRef?.current as
    | DraftCanvasElement
    | null
    | undefined;
  if (!draftCanvas) return;
  const draftCtx = get2DContext(draftCanvas);
  if (!draftCtx) return;

  const bs = helpers.getBrushSettings();
  const mode = params.colorModeRef.current;
  const isEraser = helpers.getTool() === 'eraser';
  const currentLayerId = params.activeLayerIdRef.current;
  const isBgEraser = isEraser && isBackgroundLayerId(currentLayerId);
  const activeLayer = params.layersRef.current?.find((l) => l.id === currentLayerId);
  const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
  const isMonochrome = mode === 'monochrome' || isMonoLayer;
  const isVectorOrMask =
    activeLayer?.type === 'vector' || params.isMaskModeRef.current;
  const useWireframeEraser = isVectorOrMask && isEraser && !isBgEraser;
  const canvas = params.getActiveMaskCanvas();
  const strokeColor = helpers.resolveStrokeColor(bs, isEraser, isBgEraser, isMonochrome, mode);
  const strokeHardness = isMonochrome ? 1.0 : bs.hardness ?? 1.0;
  const strokeFlow = isMonochrome ? 1.0 : bs.flow ?? 1.0;
  const strokeSpacing = bs.spacing ?? 0.08;
  const hasTaper = Boolean(bs.taper?.useOut || bs.taper?.useIn);
  const globalCurve = pipeline.getGlobalPressureCurve();
  const hasCustomGlobalCurve = Boolean(
    globalCurve && globalCurve.enabled && !isLinearPressureCurve(globalCurve.points)
  );
  const hasCustomCurve =
    hasCustomGlobalCurve || Boolean(bs.pressureCurve && bs.pressureCurve.length > 0);
  const taperEngine = pipeline.getTaperEngine();
  const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
  const blurMargin = (1 - strokeHardness) * ((bs.size || 10) * 1.5);
  const dirtyPadExtra = Math.ceil((bs.size || 10) * (1.8 + scatterFactor * 2) + blurMargin + 24);

  const draftScale = draftCanvas.__draftScale ?? 1.0;
  const liveAA = helpers.resolveLiveAntiAlias(bs, isMonochrome, draftScale);
  const liveBrushOpts = helpers.buildLiveBrushOptions(
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
  const useGpuBatch = !useWireframeEraser && canUseWebGlForBrush(liveBrushOpts);

  const gpuBatch = state.frameGpuDabs;
  gpuBatch.length = 0;

  const collabActive = Boolean(state.currentStrokeId && params.onCollabStrokeChunkRef.current);
  const chunkPts: Point[] | null = collabActive ? [] : null;
  let drewAnySegment = false;

  pipeline.drain({
    dirtyPadExtra,
    resolvePoint: (rawX, rawY, rawPressure, stabPressure, pointerType, _vx, _vy, dtMs, out) => {
      let velocityScale = 1.0;
      if (bs.velocityDynamics && state.stabilizedPoint) {
        const dist = Math.hypot(
          rawX - state.stabilizedPoint.x,
          rawY - state.stabilizedPoint.y
        );
        const speed = dist / Math.max(1, dtMs);
        velocityScale = Math.max(0.65, Math.min(1.0, 1.0 - Math.max(0, speed - 0.5) * 0.12));
      }

      const baseP = bs.usePressure
        ? hasCustomCurve
          ? stabPressure
          : taperEngine.mapPressure(stabPressure)
        : rawPressure > 0
        ? 1.0
        : 0;
      const mappedP = bs.usePressure ? taperEngine.smoothPressure(baseP) : baseP;
      let width = calculateStrokeWidth(
        bs.size,
        mappedP,
        bs.minSizeFactor,
        bs.usePressure,
        pointerType,
        bs.pressureCurveGamma ?? 1.0,
        velocityScale,
        bs.pressureCurve
      );
      if (isMonochrome && !hasTaper && width < 1.25) {
        width = 1.25;
      }
      out.pressure = mappedP;
      out.width = width;
    },
    onPoint: (sample) => {
      const pt: Point = {
        x: sample.x,
        y: sample.y,
        pressure: sample.pressure,
        width: sample.width,
        tiltX: sample.tiltX,
        tiltY: sample.tiltY,
        twist: sample.twist,
        timestamp: sample.timestamp,
        isCorner: sample.isCorner,
      };
      if (state.allStrokePoints.length > 0) {
        const prev = state.allStrokePoints[state.allStrokePoints.length - 1];
        state.strokeTotalDistance += Math.hypot(pt.x - prev.x, pt.y - prev.y);
      }
      state.stabilizedPoint = pt;
      state.lastPointTime = sample.timestamp;
      state.allStrokePoints.push(pt);
      state.recentPointsTrail.push({
        x: pt.x,
        y: pt.y,
        t: sample.timestamp || performance.now(),
        pressure: pt.pressure,
        width: pt.width,
      });
      if (state.recentPointsTrail.length > 16) {
        state.recentPointsTrail.shift();
      }
      if (chunkPts) {
        chunkPts.push(pt);
      }
    },
    onSegment: (seg) => {
      drewAnySegment = true;
      helpers.emitLiveSegment(
        draftCtx,
        seg,
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
        useGpuBatch ? gpuBatch : undefined
      );
    },
  });

  if (useGpuBatch && gpuBatch.length > 0) {
    const liveColor =
      (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;
    const flushed = flushGpuDabs(draftCtx, gpuBatch, liveColor, liveBrushOpts);
    if (!flushed) {
      const pts = state.allStrokePoints;
      if (pts.length >= 2) {
        const pA = pts[pts.length - 2];
        const pB = pts[pts.length - 1];
        const fallbackSeg = pipeline.getSplineGenerator().generateCornerSegment(pA, pB);
        helpers.emitLiveSegment(
          draftCtx,
          fallbackSeg,
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
          undefined
        );
      }
    }
    gpuBatch.length = 0;
  }

  const pDirty = pipeline.dirtyRect;
  if (Number.isFinite(pDirty.minX) && Number.isFinite(pDirty.maxX)) {
    const dims = params.dimensionsRef.current;
    if (!state.dirtyRect) {
      state.dirtyRect = {
        minX: Math.max(0, pDirty.minX),
        minY: Math.max(0, pDirty.minY),
        maxX: Math.min(dims.width, pDirty.maxX),
        maxY: Math.min(dims.height, pDirty.maxY),
      };
    } else {
      state.dirtyRect.minX = Math.max(0, Math.min(state.dirtyRect.minX, pDirty.minX));
      state.dirtyRect.minY = Math.max(0, Math.min(state.dirtyRect.minY, pDirty.minY));
      state.dirtyRect.maxX = Math.min(dims.width, Math.max(state.dirtyRect.maxX, pDirty.maxX));
      state.dirtyRect.maxY = Math.min(dims.height, Math.max(state.dirtyRect.maxY, pDirty.maxY));
    }
  }

  if (drewAnySegment) {
    draftCanvas.__draftHasContent = true;
    draftCanvas.__draftVersion = (draftCanvas.__draftVersion || 0) + 1;
    state.liveNeedsNotify = true;
  }

  if (state.currentStrokeId && chunkPts && chunkPts.length > 0) {
    params.onCollabStrokeChunkRef.current?.(state.currentStrokeId, chunkPts);
  }

  if (!isSkipDisplay && state.liveNeedsNotify) {
    state.liveNeedsNotify = false;
    params.activeTileGridRef.current.notifyChange(true);
  }

  const predData = state.latestPredicted;
  state.latestPredicted = null;
  if (!isSkipDisplay) {
    const vRect = helpers.getViewportRect();
    if (vRect && state.allStrokePoints.length > 0) {
      helpers.renderPredictedStroke(predData ? predData.predEvents : [], vRect);
    } else if (state.isPredictedCanvasDirty) {
      helpers.clearPredictedCanvas();
    }
  }
}
