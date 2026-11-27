import { Point } from '../../../types/editor';
import { calculateStrokeWidth, get2DContext } from '../../../utils/canvasUtils';
import {
  buildSecondaryBrushSettings,
  canUseWebGlForBrush,
  flushGpuDabs,
  resolveDualBrushConfig,
} from '../../../engine/BrushEngine';
import { evaluateGlobalPressureCurve, isLinearPressureCurve } from '../../../utils/pressureCurve';
import { DraftCanvasElement, isBackgroundLayerId } from '../types';
import {
  syncDualBrushRegionToDraft,
  syncStrokePaperTextureRegionToDraft,
} from './strokeHelpers';
import { flushLiveDualSecondaryGpuBatch } from './liveSegmentEmitter';
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
  const dualCfg = state.isDualBrushStroke ? resolveDualBrushConfig(bs) : null;
  const dualSecSize = dualCfg ? buildSecondaryBrushSettings(bs, dualCfg).settings.size : 0;
  const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0, dualCfg?.scatter ?? 0);
  const maxBrushDim = Math.max(bs.size || 10, dualSecSize);
  const blurMargin = (1 - strokeHardness) * ((bs.size || 10) * 1.5);
  const dirtyPadExtra = Math.ceil(maxBrushDim * (1.8 + scatterFactor * 2) + blurMargin + 24);

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
  state.dualFrameSecondaryGpuDabs.length = 0;

  const collabActive = Boolean(state.currentStrokeId && params.onCollabStrokeChunkRef.current);
  const chunkPts: Point[] | null = collabActive ? [] : null;
  let drewAnySegment = false;
  const activeDrawCtx =
    state.isDualBrushStroke && state.dualPrimaryCanvas
      ? get2DContext(state.dualPrimaryCanvas) || draftCtx
      : state.isStrokePaperTextureActive && state.rawDraftCanvas
      ? get2DContext(state.rawDraftCanvas) || draftCtx
      : draftCtx;
  let frameMinX = Infinity;
  let frameMinY = Infinity;
  let frameMaxX = -Infinity;
  let frameMaxY = -Infinity;

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

      let effectiveStabP = stabPressure;
      const isPlaceholderDown =
        Math.abs(state.deferredStartRawPressure - 0.5) < 1e-4 ||
        (state.deferredStartRawPressure <= 0.015 && rawPressure > 0.015);
      if (
        state.deferredInitialDot &&
        state.allStrokePoints.length === 1 &&
        (rawPressure < state.deferredStartRawPressure - 0.01 || isPlaceholderDown)
      ) {
        // Clear any sentinel / unpopulated WM_POINTERDOWN (0.006) / click-impulse pressure
        // seeded on pointerdown so neither InputStabilizer nor TaperEngine's 8-sample
        // smoother drags the opening samples of a firm or light stroke off hardware pressure.
        pipeline.getStabilizer().resetPressureState(rawPressure, state.lastPointTime);
        taperEngine.reset();
        effectiveStabP = evaluateGlobalPressureCurve(rawPressure, globalCurve);
      }

      const rawBaseP = bs.usePressure
        ? hasCustomCurve
          ? effectiveStabP
          : taperEngine.mapPressure(effectiveStabP)
        : rawPressure > 0
        ? 1.0
        : 0;
      // Preserve light continuous stylus contact (> 0.005) above zero collapse mid-stroke
      const baseP =
        bs.usePressure && rawPressure > 0.005 ? Math.max(0.015, rawBaseP) : rawBaseP;
      const mappedP = bs.usePressure ? taperEngine.smoothPressure(baseP) : baseP;
      const effectiveP =
        bs.usePressure && rawPressure > 0.005 ? Math.max(0.015, mappedP) : mappedP;
      let width = calculateStrokeWidth(
        bs.size,
        effectiveP,
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
      out.pressure = effectiveP;
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
      if (state.deferredInitialDot) {
        state.deferredInitialDot = false;
        if (state.allStrokePoints.length === 1) {
          const p0 = state.allStrokePoints[0];
          const wasSentinel =
            Math.abs(state.deferredStartRawPressure - 0.5) < 1e-4 ||
            (state.deferredStartRawPressure <= 0.015 && pt.pressure > 0.015);
          if (wasSentinel || pt.pressure < p0.pressure) {
            p0.pressure = pt.pressure;
            p0.width = pt.width;
            const p0HadNoTilt = (p0.tiltX ?? 0) === 0 && (p0.tiltY ?? 0) === 0;
            const ptHasTilt = (pt.tiltX ?? 0) !== 0 || (pt.tiltY ?? 0) !== 0;
            if (p0HadNoTilt && ptHasTilt) {
              p0.tiltX = pt.tiltX;
              p0.tiltY = pt.tiltY;
            }
            pipeline.updateSeedKnotPressure(
              pt.pressure,
              pt.width,
              sample.timestamp,
              p0.tiltX,
              p0.tiltY
            );
          }
        }
      }
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
      const segPad = Math.ceil(
        Math.max(seg.p0.width, seg.p3.width, maxBrushDim) * (2.2 + scatterFactor * 2) + 16
      );
      const sMinX = Math.min(seg.p0.x, seg.c1.x, seg.c2.x, seg.p3.x) - segPad;
      const sMinY = Math.min(seg.p0.y, seg.c1.y, seg.c2.y, seg.p3.y) - segPad;
      const sMaxX = Math.max(seg.p0.x, seg.c1.x, seg.c2.x, seg.p3.x) + segPad;
      const sMaxY = Math.max(seg.p0.y, seg.c1.y, seg.c2.y, seg.p3.y) + segPad;
      if (sMinX < frameMinX) frameMinX = sMinX;
      if (sMinY < frameMinY) frameMinY = sMinY;
      if (sMaxX > frameMaxX) frameMaxX = sMaxX;
      if (sMaxY > frameMaxY) frameMaxY = sMaxY;
      helpers.emitLiveSegment(
        activeDrawCtx,
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
        useGpuBatch ? gpuBatch : undefined,
        liveBrushOpts
      );
    },
  });

  if (state.naturalPaintSession) {
    const natDirty = state.naturalPaintSession.flushPendingDirtyToContext(activeDrawCtx, true);
    if (natDirty) {
      const natPad = 14;
      if (natDirty.minX - natPad < frameMinX) frameMinX = natDirty.minX - natPad;
      if (natDirty.minY - natPad < frameMinY) frameMinY = natDirty.minY - natPad;
      if (natDirty.maxX + natPad > frameMaxX) frameMaxX = natDirty.maxX + natPad;
      if (natDirty.maxY + natPad > frameMaxY) frameMaxY = natDirty.maxY + natPad;
    }
  }

  if (useGpuBatch && gpuBatch.length > 0) {
    const liveColor =
      (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;
    const flushed = flushGpuDabs(activeDrawCtx, gpuBatch, liveColor, liveBrushOpts);
    if (!flushed) {
      const pts = state.allStrokePoints;
      if (pts.length >= 2) {
        const pA = pts[pts.length - 2];
        const pB = pts[pts.length - 1];
        const fallbackSeg = pipeline.getSplineGenerator().generateCornerSegment(pA, pB);
        helpers.emitLiveSegment(
          activeDrawCtx,
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

  if (state.isDualBrushStroke) {
    flushLiveDualSecondaryGpuBatch(state, helpers, bs, isMonochrome, draftScale);
    if (drewAnySegment && Number.isFinite(frameMinX)) {
      syncDualBrushRegionToDraft(
        state,
        draftCanvas,
        draftCtx,
        bs,
        frameMinX,
        frameMinY,
        frameMaxX,
        frameMaxY
      );
    }
  } else if (state.isStrokePaperTextureActive && drewAnySegment && Number.isFinite(frameMinX)) {
    syncStrokePaperTextureRegionToDraft(
      state,
      draftCanvas,
      draftCtx,
      bs,
      frameMinX,
      frameMinY,
      frameMaxX,
      frameMaxY
    );
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
    // Record pixel-space dirty sub-rect on draftCanvas so WebGL2 compositor uploads ONLY
    // the freshly painted region instead of the entire 38MB draft texture every animation frame.
    if (Number.isFinite(frameMinX) && Number.isFinite(frameMaxX) && draftCanvas.__draftDocRect) {
      const docRect = draftCanvas.__draftDocRect;
      const scale = draftCanvas.__draftScale ?? 1.0;
      const px0 = Math.max(0, Math.floor((frameMinX - docRect.x) * scale) - 4);
      const py0 = Math.max(0, Math.floor((frameMinY - docRect.y) * scale) - 4);
      const px1 = Math.min(draftCanvas.width, Math.ceil((frameMaxX - docRect.x) * scale) + 4);
      const py1 = Math.min(draftCanvas.height, Math.ceil((frameMaxY - docRect.y) * scale) + 4);
      if (px1 > px0 && py1 > py0) {
        const prevDirty = draftCanvas.__draftFrameDirtyRect;
        if (prevDirty) {
          const ux0 = Math.min(prevDirty.x, px0);
          const uy0 = Math.min(prevDirty.y, py0);
          const ux1 = Math.max(prevDirty.x + prevDirty.width, px1);
          const uy1 = Math.max(prevDirty.y + prevDirty.height, py1);
          draftCanvas.__draftFrameDirtyRect = { x: ux0, y: uy0, width: ux1 - ux0, height: uy1 - uy0 };
        } else {
          draftCanvas.__draftFrameDirtyRect = { x: px0, y: py0, width: px1 - px0, height: py1 - py0 };
        }
      }
    }
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
