import React, { useRef, useCallback, useEffect } from 'react';
import {
  ToolType,
  BrushSettings,
  Point,
  CanvasDimensions,
  CanvasSelection,
  CanvasColorMode,
  DirtyRect,
  LayerItem,
  VectorStroke,
} from '../../types/editor';
import { SparseTileGrid, TILE_SIZE, TileFormat, releaseTemporaryCanvas } from '../../utils/tileEngine';
import {
  calculateStrokeWidth,
  drawSmoothCubicBezierSegment,
  drawDot,
  screenToCanvas,
  screenToCanvasInto,
  getCanvasToViewportMatrix,
  getVisibleCanvasBounds,
  get2DContext,
  getReusableBakeCanvas,
  renderCompleteStroke,
  applyParametricTaper,
} from '../../utils/canvasUtils';
import {
  StrokePipeline,
  computeClampedBakeDirtyRect,
  encodePointerType,
} from '../../engine/StrokePipeline';
import { CubicBezierSegment } from '../../engine/SplineGenerator';
import { applyCspWatercolorEdge } from '../../engine/CspBrushEngine';
import { enforceColorMode, binarizeImageDataBuffer } from '../../utils/colorUtils';
import { drawPencilCubicBezierSegment, drawPencilDot, PencilGrade } from '../../utils/pencilEngine';
import {
  drawTexturedCubicBezierSegment,
  drawTexturedDot,
  TexturedBrushOptions,
  RadialMixingOptions,
  canUseWebGlForTexturedBrush,
  canUseWebGlForRadialBrush,
  flushTexturedGpuDabs,
  flushRadialGpuDabs,
} from '../../utils/stampEngine';
import { GpuDab } from '../../utils/webglBrushEngine';
import { PaintReservoir, LayerPixelSampler } from '../../utils/colorMixingEngine';
import { applyLayerEffects } from '../../utils/layerEffectsEngine';
import { PerspectiveRuler, ConstraintAxis } from '../../types/perspective';
import { PerspectiveSnapSession } from '../../utils/perspectiveSnapping';
import { useToolStore, useUiStore } from '../../stores';
import { evaluateGlobalPressureCurve, isLinearPressureCurve } from '../../utils/pressureCurve';
import {
  DraftCanvasElement,
  ExtendedPointerEvent,
  LastStrokeEndState,
  PushHistoryStepFn,
  applySelectionCanvasClip,
  applySelectionMaskToImageData,
  isBackgroundLayerId,
} from './types';
import { commitVectorStrokeOrErase } from './useVectorDrawing';

export interface UseBrushStrokeSessionParams {
  disabled: boolean;
  activeSessionId?: string | null;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  interactionRef: React.MutableRefObject<HTMLDivElement | null>;
  isDrawingRef: React.MutableRefObject<boolean>;
  lastStrokeEndRef: React.MutableRefObject<LastStrokeEndState | null>;
  panRef: React.MutableRefObject<{ x: number; y: number }>;
  zoomRef: React.MutableRefObject<number>;
  rotationRef: React.MutableRefObject<number>;
  flipXRef: React.MutableRefObject<boolean>;
  flipYRef: React.MutableRefObject<boolean>;
  toolOverrideRef: React.MutableRefObject<ToolType | undefined>;
  brushSettingsOverrideRef: React.MutableRefObject<BrushSettings | undefined>;
  colorModeRef: React.MutableRefObject<CanvasColorMode>;
  activeLayerIdRef: React.MutableRefObject<string>;
  activeLayerLockedRef: React.MutableRefObject<boolean>;
  activeLayerVisibleRef: React.MutableRefObject<boolean>;
  dimensionsRef: React.MutableRefObject<CanvasDimensions>;
  selectionRef: React.MutableRefObject<CanvasSelection | null>;
  isMaskModeRef: React.MutableRefObject<boolean>;
  layersRef: React.MutableRefObject<LayerItem[] | undefined>;
  layerSourceCanvasesRef?: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  effectiveDraftCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  predictedCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  activeTileGridRef: React.MutableRefObject<SparseTileGrid>;
  rulerRef: React.MutableRefObject<PerspectiveRuler | null | undefined>;
  onActiveConstraintAxisChangeRef: React.MutableRefObject<
    ((axis: ConstraintAxis | null) => void) | undefined
  >;
  onUpdateLayerThumbnail: (layerId: string) => void;
  onUpdateMaskThumbnailRef: React.MutableRefObject<((layerId: string) => void) | undefined>;
  onCollabStrokeStartRef: React.MutableRefObject<
    | ((
        strokeId: string,
        layerId: string,
        brushSettings: BrushSettings,
        tool: ToolType,
        startPoint: Point
      ) => void)
    | undefined
  >;
  onCollabStrokeChunkRef: React.MutableRefObject<
    ((strokeId: string, points: Point[]) => void) | undefined
  >;
  onCollabStrokeFinishRef: React.MutableRefObject<
    | ((
        strokeId: string,
        layerId: string,
        endPoint: Point,
        dirtyRect?: DirtyRect,
        vectorStroke?: VectorStroke
      ) => void)
    | undefined
  >;
  onCollabCursorMoveRef: React.MutableRefObject<
    ((x: number, y: number, isDrawing: boolean, tool: ToolType) => void) | undefined
  >;
  getCachedLayerCanvas: (layerId?: string) => HTMLCanvasElement | null;
  pushHistoryStep: PushHistoryStepFn;
  flushPendingHistoryTasks: () => void;
  enqueueHistoryTask: (task: () => void) => void;
}

export interface UseBrushStrokeSessionResult {
  abortActiveStroke: () => void;
  handlePointerDown: (e: React.PointerEvent<HTMLElement>, coalescedEvents?: PointerEvent[]) => void;
  handlePointerMove: (
    e: React.PointerEvent<HTMLElement>,
    coalescedEvents?: PointerEvent[],
    predictedEvents?: PointerEvent[]
  ) => void;
  handlePointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  handlePointerEnter: () => void;
  handlePointerLeave: () => void;
}

export function useBrushStrokeSession({
  disabled,
  activeSessionId,
  viewportRef,
  interactionRef,
  isDrawingRef,
  lastStrokeEndRef,
  panRef,
  zoomRef,
  rotationRef,
  flipXRef,
  flipYRef,
  toolOverrideRef,
  brushSettingsOverrideRef,
  colorModeRef,
  activeLayerIdRef,
  activeLayerLockedRef,
  activeLayerVisibleRef,
  dimensionsRef,
  selectionRef,
  isMaskModeRef,
  layersRef,
  layerSourceCanvasesRef,
  effectiveDraftCanvasRef,
  predictedCanvasRef,
  activeTileGridRef,
  rulerRef,
  onActiveConstraintAxisChangeRef,
  onUpdateLayerThumbnail,
  onUpdateMaskThumbnailRef,
  onCollabStrokeStartRef,
  onCollabStrokeChunkRef,
  onCollabStrokeFinishRef,
  onCollabCursorMoveRef,
  getCachedLayerCanvas,
  pushHistoryStep,
  flushPendingHistoryTasks,
  enqueueHistoryTask,
}: UseBrushStrokeSessionParams): UseBrushStrokeSessionResult {
  const getTool = useCallback(
    (): ToolType => toolOverrideRef.current ?? useToolStore.getState().tool,
    [toolOverrideRef]
  );
  const getBrushSettings = useCallback(
    (): BrushSettings =>
      brushSettingsOverrideRef.current ?? useToolStore.getState().brushSettings,
    [brushSettingsOverrideRef]
  );

  const currentStrokeIdRef = useRef<string | null>(null);
  const isToneStrokeRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);

  const isPredictedCanvasDirtyRef = useRef(false);
  const latestPredictedRef = useRef<{ predEvents: PointerEvent[]; vRect: DOMRect } | null>(null);

  const getPredictedCanvas = useCallback((): HTMLCanvasElement | null => {
    if (predictedCanvasRef?.current) return predictedCanvasRef.current;
    if (typeof document !== 'undefined') {
      return document.getElementById('ink-predicted-canvas') as HTMLCanvasElement | null;
    }
    return null;
  }, [predictedCanvasRef]);

  const clearPredictedCanvas = useCallback(() => {
    latestPredictedRef.current = null;
    if (!isPredictedCanvasDirtyRef.current) return;
    const pCanvas = getPredictedCanvas();
    if (pCanvas) {
      const pCtx = get2DContext(pCanvas);
      if (pCtx) {
        pCtx.resetTransform();
        pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);
      }
    }
    isPredictedCanvasDirtyRef.current = false;
  }, [getPredictedCanvas]);

  const snapSessionRef = useRef(new PerspectiveSnapSession());
  const lastEmittedAxisRef = useRef<ConstraintAxis | null>(null);
  const emitConstraintAxisChange = useCallback(
    (newAxis: ConstraintAxis | null) => {
      const prev = lastEmittedAxisRef.current;
      if (prev === newAxis) return;
      if (
        prev &&
        newAxis &&
        prev.type === newAxis.type &&
        prev.origin.x === newAxis.origin.x &&
        prev.origin.y === newAxis.origin.y &&
        prev.dir.x === newAxis.dir.x &&
        prev.dir.y === newAxis.dir.y
      ) {
        return;
      }
      lastEmittedAxisRef.current = newAxis;
      onActiveConstraintAxisChangeRef.current?.(newAxis);
    },
    [onActiveConstraintAxisChangeRef]
  );

  const allStrokePointsRef = useRef<Point[]>([]);
  const strokePipelineRef = useRef(new StrokePipeline());
  const frameGpuDabsRef = useRef<GpuDab[]>([]);
  const reusableRegionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scratchDocCoordRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const predCoordPoolRef = useRef<Array<{ x: number; y: number; pressure?: number }>>([
    { x: 0, y: 0, pressure: 0.5 },
    { x: 0, y: 0, pressure: 0.5 },
    { x: 0, y: 0, pressure: 0.5 },
    { x: 0, y: 0, pressure: 0.5 },
  ]);
  const predDocCoordsRef = useRef<Array<{ x: number; y: number; pressure?: number }>>([]);
  const predDabCounterRef = useRef<{ count: number }>({ count: 0 });
  const lastQueuedPressureRef = useRef<number>(0.5);
  const stabilizedPointRef = useRef<Point | null>(null);
  const stampRemainderDistRef = useRef<number>(0);
  const liveDabCounterRef = useRef<{ count: number }>({ count: 0 });
  const activeReservoirRef = useRef<PaintReservoir | null>(null);
  const layerPixelSamplerRef = useRef<LayerPixelSampler | null>(null);
  const isWetColorStrokeRef = useRef<boolean>(false);
  const liveNeedsNotifyRef = useRef<boolean>(false);
  const isShiftLineStrokeRef = useRef<boolean>(false);
  const lastPointTimeRef = useRef<number>(0);
  const recentPointsTrailRef = useRef<
    { x: number; y: number; t: number; pressure: number; width: number }[]
  >([]);
  const strokeTotalDistanceRef = useRef<number>(0);
  const dirtyRectRef = useRef<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null>(null);
  const touchedTilesRef = useRef<Set<number>>(new Set());
  const lastProcessedPointRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const hasLastProcessedPointRef = useRef<boolean>(false);
  const drawRafIdRef = useRef<number | null>(null);
  const clearDraftRafRef = useRef<number | null>(null);

  const markTouchedTiles = useCallback(
    (minX: number, minY: number, maxX: number, maxY: number) => {
      const dims = dimensionsRef.current;
      const cx0 = Math.max(0, Math.floor(minX));
      const cy0 = Math.max(0, Math.floor(minY));
      const cx1 = Math.min(dims.width, Math.ceil(maxX));
      const cy1 = Math.min(dims.height, Math.ceil(maxY));
      if (cx1 <= cx0 || cy1 <= cy0) return;
      const tx0 = Math.floor(cx0 / TILE_SIZE);
      const ty0 = Math.floor(cy0 / TILE_SIZE);
      const tx1 = Math.floor((cx1 - 1) / TILE_SIZE);
      const ty1 = Math.floor((cy1 - 1) / TILE_SIZE);
      const set = touchedTilesRef.current;
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          set.add(ty * 65536 + tx);
        }
      }
    },
    [dimensionsRef]
  );

  const statRafRef = useRef<number | null>(null);
  const pendingStatRef = useRef<{ x: number | null; y: number | null; pressure: number } | null>(
    null
  );
  const cachedViewportRectRef = useRef<DOMRect | null>(null);

  const getViewportRect = useCallback((): DOMRect | null => {
    if (!cachedViewportRectRef.current && viewportRef.current) {
      cachedViewportRectRef.current = viewportRef.current.getBoundingClientRect();
    }
    return cachedViewportRectRef.current;
  }, [viewportRef]);

  useEffect(() => {
    const handleResize = () => {
      cachedViewportRectRef.current = null;
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && viewportRef.current) {
      ro = new ResizeObserver(handleResize);
      ro.observe(viewportRef.current);
    }
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
      ro?.disconnect();
      if (clearDraftRafRef.current !== null) {
        cancelAnimationFrame(clearDraftRafRef.current);
      }
      if (drawRafIdRef.current !== null) {
        cancelAnimationFrame(drawRafIdRef.current);
      }
    };
  }, [viewportRef, disabled, activeSessionId]);

  const dispatchPointerStat = useCallback(
    (x: number | null, y: number | null, pressure: number) => {
      pendingStatRef.current = {
        x: x !== null ? Math.round(x) : null,
        y: y !== null ? Math.round(y) : null,
        pressure,
      };
      if (statRafRef.current === null) {
        statRafRef.current = requestAnimationFrame(() => {
          statRafRef.current = null;
          if (pendingStatRef.current) {
            window.dispatchEvent(
              new CustomEvent('canvas-pointer-stat', {
                detail: {
                  ...pendingStatRef.current,
                  isHovering: pendingStatRef.current.x !== null,
                },
              })
            );
          }
        });
      }
    },
    []
  );

  const abortActiveStroke = useCallback(() => {
    if (!isDrawingRef.current) return;
    if (drawRafIdRef.current !== null) {
      cancelAnimationFrame(drawRafIdRef.current);
      drawRafIdRef.current = null;
    }
    const draftCanvas = effectiveDraftCanvasRef?.current as DraftCanvasElement | null | undefined;
    let clearedActiveDraft = false;
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
      if (draftCanvas.__draftHasContent) {
        clearedActiveDraft = true;
      }
      draftCanvas.__draftHasContent = false;
      draftCanvas.__draftCompositeOp = 'source-over';
      draftCanvas.__draftMonochrome = false;
      draftCanvas.__draftVersion = (draftCanvas.__draftVersion || 0) + 1;
    }
    clearPredictedCanvas();
    if (clearedActiveDraft) {
      activeTileGridRef.current.notifyChange(true);
    }
    strokePipelineRef.current.abortStroke();
    frameGpuDabsRef.current.length = 0;
    isDrawingRef.current = false;
    activePointerIdRef.current = null;
    allStrokePointsRef.current = [];
    stabilizedPointRef.current = null;
    hasLastProcessedPointRef.current = false;
    dirtyRectRef.current = null;
    touchedTilesRef.current.clear();
    liveNeedsNotifyRef.current = false;
    isShiftLineStrokeRef.current = false;
    isToneStrokeRef.current = false;
    layerPixelSamplerRef.current = null;
    activeReservoirRef.current = null;
    snapSessionRef.current.endStroke();
    emitConstraintAxisChange(null);
  }, [
    activeTileGridRef,
    clearPredictedCanvas,
    effectiveDraftCanvasRef,
    emitConstraintAxisChange,
    isDrawingRef,
  ]);

  const getCanvasPoint = useCallback(
    (e: React.PointerEvent<HTMLElement> | PointerEvent): Point => {
      const vRect = getViewportRect();
      const dims = dimensionsRef.current;
      const bs = getBrushSettings();
      if (!vRect) {
        return { x: 0, y: 0, pressure: 0.5, width: bs.size, timestamp: e.timeStamp };
      }

      const { x, y } = screenToCanvas(
        e.clientX,
        e.clientY,
        vRect,
        panRef.current,
        zoomRef.current,
        rotationRef.current,
        dims,
        flipXRef.current,
        flipYRef.current
      );

      let pressure = 0;
      if (e.pointerType === 'mouse') {
        pressure = e.buttons & 1 ? 0.5 : 0;
      } else {
        const rawP = e.pressure !== undefined ? Math.max(0, Math.min(1.0, e.pressure)) : 0;
        pressure = evaluateGlobalPressureCurve(
          rawP,
          useUiStore.getState().appSettings.pressureCurve
        );
      }

      const width = calculateStrokeWidth(
        bs.size,
        pressure,
        bs.minSizeFactor,
        bs.usePressure,
        e.pointerType,
        bs.pressureCurveGamma ?? 1.0,
        1.0,
        bs.pressureCurve
      );

      return {
        x,
        y,
        pressure,
        width,
        tiltX: e.tiltX ?? 0,
        tiltY: e.tiltY ?? 0,
        twist: e.twist ?? 0,
        timestamp: e.timeStamp,
      };
    },
    [dimensionsRef, flipXRef, flipYRef, getBrushSettings, getViewportRect, panRef, rotationRef, zoomRef]
  );

  const resolveEffectiveOpacitySensor = useCallback(
    (bs: BrushSettings, isMonochrome: boolean, isEraser: boolean) => {
      if (bs.opacitySensor) return bs.opacitySensor;
      if (bs.usePressure && !isMonochrome && !isEraser && (bs.flow ?? 1.0) < 0.99) {
        return { usePressure: true, pressureMin: 0.2 };
      }
      return undefined;
    },
    []
  );

  const resolveLiveAntiAlias = useCallback(
    (bs: BrushSettings, isMonochrome: boolean, scale: number): number | undefined => {
      const downscaled = scale < 0.999;
      if (isMonochrome) {
        const allowGpuMono = (bs.antiAlias ?? 2) !== 0 && bs.useGpu !== false;
        if (allowGpuMono || downscaled) {
          return (bs.antiAlias ?? 2) !== 0 ? (bs.antiAlias ?? 2) : 2;
        }
        return 0;
      }
      if (bs.antiAlias === 0 && downscaled) {
        return 2;
      }
      return bs.antiAlias;
    },
    []
  );

  const buildTouchedTileSpans = useCallback(
    (
      sx: number,
      sy: number,
      dw: number,
      dh: number
    ): Array<{ x: number; y: number; width: number; height: number }> => {
      if (dw * dh <= TILE_SIZE * TILE_SIZE || touchedTilesRef.current.size === 0) {
        return [{ x: sx, y: sy, width: dw, height: dh }];
      }
      const rows = new Map<number, number[]>();
      for (const key of touchedTilesRef.current) {
        const ty = Math.floor(key / 65536);
        const tx = key % 65536;
        let list = rows.get(ty);
        if (!list) {
          list = [];
          rows.set(ty, list);
        }
        list.push(tx);
      }
      const spans: Array<{ x: number; y: number; width: number; height: number }> = [];
      for (const [ty, txList] of rows) {
        txList.sort((a, b) => a - b);
        let spanStart = txList[0];
        let spanEnd = txList[0];
        const pushClampedSpan = (s0: number, s1: number) => {
          const rx = Math.max(sx, s0 * TILE_SIZE);
          const ry = Math.max(sy, ty * TILE_SIZE);
          const rxEnd = Math.min(sx + dw, (s1 + 1) * TILE_SIZE);
          const ryEnd = Math.min(sy + dh, (ty + 1) * TILE_SIZE);
          const rw = rxEnd - rx;
          const rh = ryEnd - ry;
          if (rw > 0 && rh > 0) spans.push({ x: rx, y: ry, width: rw, height: rh });
        };
        for (let i = 1; i < txList.length; i++) {
          if (txList[i] <= spanEnd + 1) {
            spanEnd = txList[i];
          } else {
            pushClampedSpan(spanStart, spanEnd);
            spanStart = txList[i];
            spanEnd = txList[i];
          }
        }
        pushClampedSpan(spanStart, spanEnd);
      }
      return spans.length > 0 ? spans : [{ x: sx, y: sy, width: dw, height: dh }];
    },
    []
  );

  const buildLiveTexturedOptions = useCallback(
    (
      bs: BrushSettings,
      strokeFlow: number,
      strokeSpacing: number,
      strokeHardness: number,
      isMonochrome: boolean,
      canvas: HTMLCanvasElement | null,
      activeLayer: LayerItem | undefined,
      isEraser: boolean,
      isBgEraser: boolean,
      isolatedPass: boolean = false,
      effectiveAntiAlias?: number
    ): TexturedBrushOptions => ({
      size: bs.size,
      minSizeFactor: bs.minSizeFactor,
      opacity: isolatedPass ? 1.0 : bs.opacity,
      flow: strokeFlow,
      adjustDensityByGap: bs.adjustDensityByGap,
      blendTipsMode: bs.blendTipsMode,
      spacing: strokeSpacing,
      thickness: bs.thickness,
      thicknessVertical: bs.thicknessVertical,
      flipH: bs.flipH,
      flipV: bs.flipV,
      isColorTip: bs.isColorTip,
      angle: bs.customTipAngle,
      angleDynamics: bs.customTipAngleDynamics,
      rotationRandomScale: bs.customTipRotationRandomScale,
      hardness: strokeHardness,
      antiAlias: effectiveAntiAlias !== undefined ? effectiveAntiAlias : isMonochrome ? 0 : bs.antiAlias,
      pressureCurve: bs.pressureCurve,
      velocityCurve: bs.velocityCurve,
      usePressure: bs.usePressure,
      useVelocity: bs.useVelocity,
      useTilt: Boolean(bs.useTilt),
      tiltScale: bs.tiltScale,
      sizeSensor: bs.sizeSensor,
      opacitySensor: resolveEffectiveOpacitySensor(bs, isMonochrome, isEraser),
      densitySensor: bs.densitySensor,
      subTips: bs.subTips,
      subTipOrder: bs.subTipOrder,
      subTipImages: bs.subTipImages,
      spray: bs.spray,
      taper: bs.taper,
      colorMixing: bs.colorMixing,
      perceptualMixing: bs.perceptualMixing,
      amountOfPaint: bs.amountOfPaint,
      densityOfPaint: bs.densityOfPaint,
      colorStretch: bs.colorStretch,
      mixingMode: bs.mixingMode,
      wetEdge: 0,
      grain: bs.grain ?? bs.textureDensity,
      paperTextureMode: bs.paperTextureMode,
      paperTextureBrightness: bs.paperTextureBrightness,
      paperTextureContrast: bs.paperTextureContrast,
      paperTextureInverted: bs.paperTextureInverted,
      paperTextureImage: bs.paperTextureImage,
      paperTextureScale: bs.paperTextureScale,
      paperTextureRotate: bs.paperTextureRotate,
      dualBrush: bs.dualBrush,
      dualTipImage: bs.dualTipImage,
      dualBrushCompositeMode: bs.dualBrushCompositeMode,
      useGpu: bs.useGpu !== false,
      underlyingCanvas: canvas || undefined,
      sampler: layerPixelSamplerRef.current || undefined,
      reservoir: activeReservoirRef.current || undefined,
      isEraser: isolatedPass ? false : isEraser && !isBgEraser,
      isBgEraser: isolatedPass ? false : isBgEraser,
      alphaLocked: isolatedPass ? false : Boolean(activeLayer?.alphaLocked),
      isTransparentInk: isolatedPass ? false : Boolean(bs.isTransparentInk),
      currentStrokeDist: strokeTotalDistanceRef.current,
      dynamics: bs.dynamics,
      secondaryColor: bs.secondaryColor,
    }),
    [resolveEffectiveOpacitySensor]
  );

  const buildLiveRadialOptions = useCallback(
    (
      bs: BrushSettings,
      isMonochrome: boolean,
      canvas: HTMLCanvasElement | null,
      activeLayer: LayerItem | undefined,
      isolatedPass: boolean = false,
      effectiveAntiAlias?: number
    ): RadialMixingOptions => ({
      colorMixing: bs.colorMixing,
      perceptualMixing: bs.perceptualMixing,
      amountOfPaint: bs.amountOfPaint,
      densityOfPaint: bs.densityOfPaint,
      colorStretch: bs.colorStretch,
      mixingMode: bs.mixingMode,
      underlyingCanvas: canvas || undefined,
      sampler: layerPixelSamplerRef.current || undefined,
      reservoir: activeReservoirRef.current || undefined,
      alphaLocked: isolatedPass ? false : Boolean(activeLayer?.alphaLocked),
      isTransparentInk: isolatedPass ? false : Boolean(bs.isTransparentInk),
      dynamics: bs.dynamics,
      secondaryColor: bs.secondaryColor,
      useGpu: bs.useGpu !== false,
      dualBrush: bs.dualBrush,
      dualTipImage: bs.dualTipImage,
      dualBrushCompositeMode: bs.dualBrushCompositeMode,
      useTilt: Boolean(bs.useTilt),
      tiltScale: bs.tiltScale,
      thicknessVertical: bs.thicknessVertical,
      flipH: bs.flipH,
      flipV: bs.flipV,
      antiAlias: effectiveAntiAlias !== undefined ? effectiveAntiAlias : isMonochrome ? 0 : bs.antiAlias,
      angleDynamics: bs.customTipAngleDynamics,
      rotationRandomScale: bs.customTipRotationRandomScale,
      adjustDensityByGap: bs.adjustDensityByGap,
      blendTipsMode: bs.blendTipsMode,
      grain: bs.grain ?? bs.textureDensity,
      paperTextureMode: bs.paperTextureMode,
      paperTextureBrightness: bs.paperTextureBrightness,
      paperTextureContrast: bs.paperTextureContrast,
      paperTextureInverted: bs.paperTextureInverted,
      paperTextureImage: bs.paperTextureImage,
      paperTextureScale: bs.paperTextureScale,
      paperTextureRotate: bs.paperTextureRotate,
      sizeSensor: bs.sizeSensor,
      opacitySensor: resolveEffectiveOpacitySensor(bs, isMonochrome, false),
      densitySensor: bs.densitySensor,
      taper: bs.taper,
    }),
    [resolveEffectiveOpacitySensor]
  );

  const resolveStrokeColor = useCallback(
    (
      bs: BrushSettings,
      isEraser: boolean,
      isBgEraser: boolean,
      isMonochrome: boolean,
      mode: CanvasColorMode
    ): string => {
      if (isMaskModeRef.current) {
        if (isEraser) return '#000000';
        let clean = bs.color.replace('#', '');
        if (clean.length === 3) {
          clean = clean
            .split('')
            .map((c) => c + c)
            .join('');
        }
        const r = parseInt(clean.slice(0, 2), 16) || 0;
        const g = parseInt(clean.slice(2, 4), 16) || 0;
        const b = parseInt(clean.slice(4, 6), 16) || 0;
        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        const hexVal = gray.toString(16).padStart(2, '0');
        return `#${hexVal}${hexVal}${hexVal}`;
      }
      return isBgEraser
        ? '#ffffff'
        : enforceColorMode(bs.color, isMonochrome ? 'monochrome' : mode);
    },
    [isMaskModeRef]
  );

  const emitLiveSegment = useCallback(
    (
      draftCtx: CanvasRenderingContext2D,
      seg: CubicBezierSegment,
      bs: BrushSettings,
      strokeColor: string,
      strokeHardness: number,
      strokeFlow: number,
      strokeSpacing: number,
      isMonochrome: boolean,
      isPencil: boolean,
      isEraser: boolean,
      isBgEraser: boolean,
      useWireframeEraser: boolean,
      canvas: HTMLCanvasElement | null,
      activeLayer: LayerItem | undefined,
      gpuBatch: GpuDab[] | undefined
    ) => {
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
      strokePipelineRef.current.expandDirtyRectBounds(segMinX, segMinY, segMaxX, segMaxY);
      markTouchedTiles(segMinX, segMinY, segMaxX, segMaxY);

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
      const draftCanvas = effectiveDraftCanvasRef?.current as
        | DraftCanvasElement
        | null
        | undefined;
      const draftScale = draftCanvas?.__draftScale ?? 1.0;
      const liveAA = resolveLiveAntiAlias(bs, isMonochrome, draftScale);

      if (bs.customTipImage) {
        const tipOptions = buildLiveTexturedOptions(
          bs,
          isMonochrome ? 1.0 : bs.flow ?? 1.0,
          bs.spacing ?? 0.08,
          strokeHardness,
          isMonochrome,
          canvas,
          activeLayer,
          isEraser,
          isBgEraser,
          true,
          liveAA
        );
        stampRemainderDistRef.current = drawTexturedCubicBezierSegment(
          draftCtx,
          sStart,
          c1Pt,
          c2Pt,
          sEnd,
          liveColor,
          bs.customTipImage,
          tipOptions,
          stampRemainderDistRef.current,
          liveDabCounterRef.current,
          gpuBatch
        );
      } else if (isPencil) {
        const grade = (bs.preset as PencilGrade) || 'pencil-2b';
        stampRemainderDistRef.current = drawPencilCubicBezierSegment(
          draftCtx,
          sStart,
          c1Pt,
          c2Pt,
          sEnd,
          liveColor,
          grade,
          isMonochrome ? 1.0 : bs.flow ?? 0.74,
          bs.grain ?? 1.0,
          strokeHardness,
          stampRemainderDistRef.current,
          false,
          false,
          bs.useTilt ?? true
        );
      } else {
        const radialMixingOptions = buildLiveRadialOptions(
          bs,
          isMonochrome,
          canvas,
          activeLayer,
          true,
          liveAA
        );
        stampRemainderDistRef.current = drawSmoothCubicBezierSegment(
          draftCtx,
          sStart,
          c1Pt,
          c2Pt,
          sEnd,
          liveColor,
          false,
          strokeHardness,
          strokeFlow,
          strokeSpacing,
          stampRemainderDistRef.current,
          bs.thickness ?? 1.0,
          ((bs.customTipAngle ?? 0) * Math.PI) / 180,
          radialMixingOptions,
          gpuBatch
        );
      }
    },
    [
      buildLiveRadialOptions,
      buildLiveTexturedOptions,
      effectiveDraftCanvasRef,
      markTouchedTiles,
      resolveLiveAntiAlias,
    ]
  );

  const renderPredictedStroke = useCallback(
    (predEvents: PointerEvent[], vRect: DOMRect) => {
      clearPredictedCanvas();
      const bs = getBrushSettings();
      if (getTool() === 'eraser' || bs.isTransparentInk || bs.colorMixing) return;
      const pipeline = strokePipelineRef.current;
      if (pipeline.getKnotCount() < 2) return;
      const pCanvas = getPredictedCanvas();
      if (!pCanvas) return;
      const pCtx = get2DContext(pCanvas);
      if (!pCtx) return;

      const dims = dimensionsRef.current;
      const mode = colorModeRef.current;
      const currentLayerId = activeLayerIdRef.current;
      const activeLayer = layersRef.current?.find((l) => l.id === currentLayerId);
      const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
      const isMonochrome = mode === 'monochrome' || isMonoLayer;
      const isPencil = !bs.customTipImage && (bs.preset?.startsWith('pencil') ?? false);
      const strokeColor = resolveStrokeColor(bs, false, false, isMonochrome, mode);
      const strokeHardness = isMonochrome ? 1.0 : bs.hardness ?? 1.0;
      const strokeFlow = isMonochrome ? 1.0 : bs.flow ?? 1.0;
      const strokeSpacing = bs.spacing ?? 0.08;

      const maxPredDist = Math.min(20, Math.max(4, (bs.size || 10) * 1.15));
      const predCoords = predDocCoordsRef.current;
      predCoords.length = 0;

      if (predEvents && predEvents.length > 0) {
        const scratch = scratchDocCoordRef.current;
        const pool = predCoordPoolRef.current;
        const limit = Math.min(predEvents.length, pool.length);
        for (let i = 0; i < limit; i++) {
          const ev = predEvents[i];
          screenToCanvasInto(
            ev.clientX,
            ev.clientY,
            vRect,
            panRef.current,
            zoomRef.current,
            rotationRef.current,
            dims,
            scratch,
            flipXRef.current,
            flipYRef.current
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
        panRef.current,
        zoomRef.current,
        rotationRef.current,
        dims,
        scaleX,
        scaleY,
        flipXRef.current,
        flipYRef.current
      );

      pCtx.save();
      pCtx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
      pCtx.beginPath();
      pCtx.rect(0, 0, dims.width, dims.height);
      pCtx.clip();
      applySelectionCanvasClip(pCtx, selectionRef.current);

      let predRem = stampRemainderDistRef.current;
      const predAA = resolveLiveAntiAlias(bs, isMonochrome, zoomRef.current);
      const predTipOpts: TexturedBrushOptions | null = bs.customTipImage
        ? {
            size: bs.size,
            minSizeFactor: bs.minSizeFactor,
            opacity: 1.0,
            flow: strokeFlow,
            adjustDensityByGap: bs.adjustDensityByGap,
            spacing: strokeSpacing,
            thickness: bs.thickness,
            thicknessVertical: bs.thicknessVertical,
            flipH: bs.flipH,
            flipV: bs.flipV,
            angle: bs.customTipAngle,
            angleDynamics: bs.customTipAngleDynamics,
            rotationRandomScale: bs.customTipRotationRandomScale,
            hardness: strokeHardness,
            antiAlias: predAA,
            pressureCurve: bs.pressureCurve,
            usePressure: bs.usePressure,
            useTilt: Boolean(bs.useTilt),
            tiltScale: bs.tiltScale,
            sizeSensor: bs.sizeSensor,
            opacitySensor: resolveEffectiveOpacitySensor(bs, isMonochrome, false),
            densitySensor: bs.densitySensor,
            subTips: bs.subTips,
            subTipOrder: bs.subTipOrder,
            subTipImages: bs.subTipImages,
            spray: bs.spray,
            wetEdge: 0,
            grain: bs.grain ?? bs.textureDensity,
            paperTextureMode: bs.paperTextureMode,
            paperTextureBrightness: bs.paperTextureBrightness,
            paperTextureContrast: bs.paperTextureContrast,
            paperTextureInverted: bs.paperTextureInverted,
            paperTextureImage: bs.paperTextureImage,
            paperTextureScale: bs.paperTextureScale,
            paperTextureRotate: bs.paperTextureRotate,
            dualBrush: bs.dualBrush,
            dualTipImage: bs.dualTipImage,
            dualBrushCompositeMode: bs.dualBrushCompositeMode,
            useGpu: bs.useGpu !== false,
            dynamics: bs.dynamics,
            secondaryColor: bs.secondaryColor,
          }
        : null;
      const predRadialOpts: RadialMixingOptions = {
        useGpu: bs.useGpu !== false,
        antiAlias: predAA,
        useTilt: Boolean(bs.useTilt),
        tiltScale: bs.tiltScale,
        adjustDensityByGap: bs.adjustDensityByGap,
        dynamics: bs.dynamics,
        secondaryColor: bs.secondaryColor,
        dualBrush: bs.dualBrush,
        dualTipImage: bs.dualTipImage,
        dualBrushCompositeMode: bs.dualBrushCompositeMode,
        grain: bs.grain ?? bs.textureDensity,
        paperTextureMode: bs.paperTextureMode,
        paperTextureBrightness: bs.paperTextureBrightness,
        paperTextureContrast: bs.paperTextureContrast,
        paperTextureInverted: bs.paperTextureInverted,
        paperTextureImage: bs.paperTextureImage,
        paperTextureScale: bs.paperTextureScale,
        paperTextureRotate: bs.paperTextureRotate,
        sizeSensor: bs.sizeSensor,
        opacitySensor: resolveEffectiveOpacitySensor(bs, isMonochrome, false),
        densitySensor: bs.densitySensor,
      };

      const predGpuDabs = frameGpuDabsRef.current;
      predGpuDabs.length = 0;
      const useGpuPred = bs.customTipImage
        ? Boolean(predTipOpts && canUseWebGlForTexturedBrush(predTipOpts))
        : !isPencil && canUseWebGlForRadialBrush(predRadialOpts);

      predDabCounterRef.current.count = liveDabCounterRef.current.count;

      const drew = pipeline.buildPredictedSegments(null, maxPredDist, (seg) => {
        if (bs.customTipImage && predTipOpts) {
          predRem = drawTexturedCubicBezierSegment(
            pCtx,
            seg.p0,
            seg.c1,
            seg.c2,
            seg.p3,
            strokeColor,
            bs.customTipImage,
            predTipOpts,
            predRem,
            predDabCounterRef.current,
            useGpuPred ? predGpuDabs : undefined
          );
        } else if (isPencil) {
          const grade = (bs.preset as PencilGrade) || 'pencil-2b';
          predRem = drawPencilCubicBezierSegment(
            pCtx,
            seg.p0,
            seg.c1,
            seg.c2,
            seg.p3,
            strokeColor,
            grade,
            isMonochrome ? 1.0 : bs.flow ?? 0.74,
            bs.grain ?? 1.0,
            strokeHardness,
            predRem,
            false,
            false
          );
        } else {
          predRem = drawSmoothCubicBezierSegment(
            pCtx,
            seg.p0,
            seg.c1,
            seg.c2,
            seg.p3,
            strokeColor,
            false,
            strokeHardness,
            strokeFlow,
            strokeSpacing,
            predRem,
            bs.thickness ?? 1.0,
            ((bs.customTipAngle ?? 0) * Math.PI) / 180,
            predRadialOpts,
            useGpuPred ? predGpuDabs : undefined
          );
        }
      });

      if (useGpuPred && predGpuDabs.length > 0) {
        if (bs.customTipImage && predTipOpts) {
          flushTexturedGpuDabs(pCtx, predGpuDabs, bs.customTipImage, strokeColor, predTipOpts);
        } else {
          flushRadialGpuDabs(
            pCtx,
            predGpuDabs,
            strokeColor,
            strokeHardness,
            false,
            false,
            predRadialOpts
          );
        }
        predGpuDabs.length = 0;
      }

      pCtx.restore();
      if (drew) {
        isPredictedCanvasDirtyRef.current = true;
      }
    },
    [
      activeLayerIdRef,
      clearPredictedCanvas,
      colorModeRef,
      dimensionsRef,
      flipXRef,
      flipYRef,
      getBrushSettings,
      getPredictedCanvas,
      getTool,
      layersRef,
      panRef,
      resolveEffectiveOpacitySensor,
      resolveLiveAntiAlias,
      resolveStrokeColor,
      rotationRef,
      selectionRef,
      zoomRef,
    ]
  );

  const flushPendingPoints = useCallback((skipDisplayArg?: boolean | number) => {
    drawRafIdRef.current = null;
    if (!isDrawingRef.current) return;
    const isSkipDisplay = skipDisplayArg === true;

    const pipeline = strokePipelineRef.current;
    if (pipeline.getPendingCount() === 0) {
      if (isSkipDisplay) {
        latestPredictedRef.current = null;
        return;
      }
      const predData = latestPredictedRef.current;
      latestPredictedRef.current = null;
      const vRect = getViewportRect();
      if (vRect && allStrokePointsRef.current.length > 0) {
        renderPredictedStroke(predData ? predData.predEvents : [], vRect);
      } else if (isPredictedCanvasDirtyRef.current) {
        clearPredictedCanvas();
      }
      return;
    }

    const draftCanvas = effectiveDraftCanvasRef?.current as
      | DraftCanvasElement
      | null
      | undefined;
    if (!draftCanvas) return;
    const draftCtx = get2DContext(draftCanvas);
    if (!draftCtx) return;

    const bs = getBrushSettings();
    const mode = colorModeRef.current;
    const isEraser = getTool() === 'eraser';
    const currentLayerId = activeLayerIdRef.current;
    const isBgEraser = isEraser && isBackgroundLayerId(currentLayerId);
    const activeLayer = layersRef.current?.find((l) => l.id === currentLayerId);
    const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
    const isMonochrome = mode === 'monochrome' || isMonoLayer;
    const isPencil = !isEraser && !bs.customTipImage && (bs.preset?.startsWith('pencil') ?? false);
    const isVectorOrToneOrMask =
      activeLayer?.type === 'vector' || isToneStrokeRef.current || isMaskModeRef.current;
    const useWireframeEraser = isVectorOrToneOrMask && isEraser && !isBgEraser;
    const canvas = getCachedLayerCanvas();
    const strokeColor = resolveStrokeColor(bs, isEraser, isBgEraser, isMonochrome, mode);
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
    const liveAA = resolveLiveAntiAlias(bs, isMonochrome, draftScale);
    const liveTipOpts = bs.customTipImage
      ? buildLiveTexturedOptions(
          bs,
          isMonochrome ? 1.0 : bs.flow ?? 1.0,
          strokeSpacing,
          strokeHardness,
          isMonochrome,
          canvas,
          activeLayer,
          isEraser,
          isBgEraser,
          true,
          liveAA
        )
      : null;
    const liveRadialOpts =
      !bs.customTipImage && !isPencil
        ? buildLiveRadialOptions(
            bs,
            isMonochrome,
            canvas,
            activeLayer,
            true,
            liveAA
          )
        : null;
    const useGpuBatch =
      !useWireframeEraser &&
      (bs.customTipImage
        ? Boolean(liveTipOpts && canUseWebGlForTexturedBrush(liveTipOpts))
        : !isPencil && Boolean(liveRadialOpts && canUseWebGlForRadialBrush(liveRadialOpts)));

    const gpuBatch = frameGpuDabsRef.current;
    gpuBatch.length = 0;

    const collabActive = Boolean(currentStrokeIdRef.current && onCollabStrokeChunkRef.current);
    const chunkPts: Point[] | null = collabActive ? [] : null;
    let drewAnySegment = false;

    pipeline.drain({
      dirtyPadExtra,
      resolvePoint: (rawX, rawY, rawPressure, stabPressure, pointerType, _vx, _vy, dtMs, out) => {
        let velocityScale = 1.0;
        if (bs.velocityDynamics && stabilizedPointRef.current) {
          const dist = Math.hypot(
            rawX - stabilizedPointRef.current.x,
            rawY - stabilizedPointRef.current.y
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
        if (allStrokePointsRef.current.length > 0) {
          const prev = allStrokePointsRef.current[allStrokePointsRef.current.length - 1];
          strokeTotalDistanceRef.current += Math.hypot(pt.x - prev.x, pt.y - prev.y);
        }
        stabilizedPointRef.current = pt;
        lastPointTimeRef.current = sample.timestamp;
        allStrokePointsRef.current.push(pt);
        recentPointsTrailRef.current.push({
          x: pt.x,
          y: pt.y,
          t: sample.timestamp || performance.now(),
          pressure: pt.pressure,
          width: pt.width,
        });
        if (recentPointsTrailRef.current.length > 16) {
          recentPointsTrailRef.current.shift();
        }
        if (chunkPts) {
          chunkPts.push(pt);
        }
      },
      onSegment: (seg) => {
        drewAnySegment = true;
        emitLiveSegment(
          draftCtx,
          seg,
          bs,
          strokeColor,
          strokeHardness,
          strokeFlow,
          strokeSpacing,
          isMonochrome,
          isPencil,
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
      let flushed = false;
      if (bs.customTipImage && liveTipOpts) {
        flushed = flushTexturedGpuDabs(draftCtx, gpuBatch, bs.customTipImage, liveColor, liveTipOpts);
      } else if (liveRadialOpts) {
        flushed = flushRadialGpuDabs(
          draftCtx,
          gpuBatch,
          liveColor,
          strokeHardness,
          false,
          false,
          liveRadialOpts
        );
      }
      if (!flushed) {
        const pts = allStrokePointsRef.current;
        if (pts.length >= 2) {
          const pA = pts[pts.length - 2];
          const pB = pts[pts.length - 1];
          const fallbackSeg = pipeline.getSplineGenerator().generateCornerSegment(pA, pB);
          emitLiveSegment(
            draftCtx,
            fallbackSeg,
            bs,
            strokeColor,
            strokeHardness,
            strokeFlow,
            strokeSpacing,
            isMonochrome,
            isPencil,
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
      const dims = dimensionsRef.current;
      if (!dirtyRectRef.current) {
        dirtyRectRef.current = {
          minX: Math.max(0, pDirty.minX),
          minY: Math.max(0, pDirty.minY),
          maxX: Math.min(dims.width, pDirty.maxX),
          maxY: Math.min(dims.height, pDirty.maxY),
        };
      } else {
        dirtyRectRef.current.minX = Math.max(0, Math.min(dirtyRectRef.current.minX, pDirty.minX));
        dirtyRectRef.current.minY = Math.max(0, Math.min(dirtyRectRef.current.minY, pDirty.minY));
        dirtyRectRef.current.maxX = Math.min(dims.width, Math.max(dirtyRectRef.current.maxX, pDirty.maxX));
        dirtyRectRef.current.maxY = Math.min(dims.height, Math.max(dirtyRectRef.current.maxY, pDirty.maxY));
      }
    }

    if (drewAnySegment) {
      draftCanvas.__draftHasContent = true;
      draftCanvas.__draftVersion = (draftCanvas.__draftVersion || 0) + 1;
      liveNeedsNotifyRef.current = true;
    }

    if (currentStrokeIdRef.current && chunkPts && chunkPts.length > 0) {
      onCollabStrokeChunkRef.current?.(currentStrokeIdRef.current, chunkPts);
    }

    if (!isSkipDisplay && liveNeedsNotifyRef.current) {
      liveNeedsNotifyRef.current = false;
      activeTileGridRef.current.notifyChange(true);
    }

    const predData = latestPredictedRef.current;
    latestPredictedRef.current = null;
    if (!isSkipDisplay) {
      const vRect = getViewportRect();
      if (vRect && allStrokePointsRef.current.length > 0) {
        renderPredictedStroke(predData ? predData.predEvents : [], vRect);
      } else if (isPredictedCanvasDirtyRef.current) {
        clearPredictedCanvas();
      }
    }
  }, [
    activeLayerIdRef,
    activeTileGridRef,
    buildLiveRadialOptions,
    buildLiveTexturedOptions,
    clearPredictedCanvas,
    colorModeRef,
    dimensionsRef,
    effectiveDraftCanvasRef,
    emitLiveSegment,
    getBrushSettings,
    getCachedLayerCanvas,
    getTool,
    getViewportRect,
    isDrawingRef,
    isMaskModeRef,
    layersRef,
    onCollabStrokeChunkRef,
    renderPredictedStroke,
    resolveLiveAntiAlias,
    resolveStrokeColor,
  ]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, _coalescedEvents?: PointerEvent[]) => {
      const currentTool = getTool();
      const isBrushOrEraser = currentTool === 'brush' || currentTool === 'eraser';
      if (
        !isBrushOrEraser ||
        disabled ||
        e.button !== 0 ||
        activeLayerLockedRef.current ||
        !activeLayerVisibleRef.current
      ) {
        return;
      }
      e.preventDefault();
      if (isDrawingRef.current) {
        abortActiveStroke();
      }
      flushPendingHistoryTasks();

      const dims = dimensionsRef.current;
      const currentLayerIdCheck = activeLayerIdRef.current;
      if (!currentLayerIdCheck || dims.width <= 0 || dims.height <= 0) return;

      const canvas = getCachedLayerCanvas();
      if (isMaskModeRef.current && !canvas) return;

      if (viewportRef.current) {
        cachedViewportRectRef.current = viewportRef.current.getBoundingClientRect();
      }
      const vRect = getViewportRect();
      if (!vRect) return;

      const draftCanvas = effectiveDraftCanvasRef?.current as
        | DraftCanvasElement
        | null
        | undefined;
      if (!draftCanvas) return;

      if (clearDraftRafRef.current !== null) {
        cancelAnimationFrame(clearDraftRafRef.current);
        clearDraftRafRef.current = null;
      }

      const draftCtx = get2DContext(draftCanvas);
      if (!draftCtx) return;

      const isEraser = currentTool === 'eraser';
      const currentLayerId = activeLayerIdRef.current;
      const isBgEraser = isEraser && isBackgroundLayerId(currentLayerId);
      const allLayers = layersRef.current || [];
      const activeLayer = allLayers.find((l) => l.id === currentLayerId);
      const bs = getBrushSettings();
      const mode = colorModeRef.current;
      const isPencil =
        !isEraser && !bs.customTipImage && (bs.preset?.startsWith('pencil') ?? false);
      const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
      const isMonochrome = mode === 'monochrome' || isMonoLayer;
      const isTone = Boolean(activeLayer?.toneEnabled);
      const isVectorLayer = activeLayer?.type === 'vector';
      const isVectorOrToneOrMask = isVectorLayer || isTone || isMaskModeRef.current;
      const useWireframeEraser = isVectorOrToneOrMask && isEraser && !isBgEraser;
      isToneStrokeRef.current = isTone;

      const draftCompositeOp: GlobalCompositeOperation =
        isVectorOrToneOrMask || isBgEraser
          ? 'source-over'
          : isEraser || bs.isTransparentInk
          ? 'destination-out'
          : activeLayer?.alphaLocked
          ? 'source-atop'
          : 'source-over';

      const rawVis = getVisibleCanvasBounds(
        vRect,
        panRef.current,
        zoomRef.current,
        rotationRef.current,
        dims,
        128,
        flipXRef.current,
        flipYRef.current
      );
      const visMinX = rawVis.maxX > rawVis.minX ? rawVis.minX : 0;
      const visMinY = rawVis.maxY > rawVis.minY ? rawVis.minY : 0;
      const visW = Math.max(1, rawVis.maxX > rawVis.minX ? rawVis.maxX - rawVis.minX : dims.width);
      const visH = Math.max(1, rawVis.maxY > rawVis.minY ? rawVis.maxY - rawVis.minY : dims.height);
      const MAX_DRAFT_DIM = 3072;
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      const screenMatchedScale = Math.max(0.05, (zoomRef.current || 1) * dpr * 1.25);
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
      applySelectionCanvasClip(draftCtx, selectionRef.current);

      clearPredictedCanvas();

      if (isTone) {
        let sourceCanvas = layerSourceCanvasesRef?.current?.get(currentLayerId) || null;
        if (!sourceCanvas) {
          sourceCanvas = document.createElement('canvas');
          sourceCanvas.width = dims.width;
          sourceCanvas.height = dims.height;
          if (canvas) {
            const sCtx = get2DContext(sourceCanvas);
            sCtx?.drawImage(canvas, 0, 0);
          } else {
            activeTileGridRef.current.renderLayerToCanvas(currentLayerId, sourceCanvas);
          }
          layerSourceCanvasesRef?.current?.set(currentLayerId, sourceCanvas);
        }
      }

      if (interactionRef.current) {
        try {
          interactionRef.current.setPointerCapture(e.pointerId);
        } catch {
          // Ignore pointer capture errors
        }
      }
      activePointerIdRef.current = e.pointerId;
      isDrawingRef.current = true;

      const firstEvent = e.nativeEvent;
      const rawStartPoint = getCanvasPoint(firstEvent);
      const isAltOverride = e.altKey;
      const startPoint = snapSessionRef.current.snapPoint(
        rawStartPoint,
        rulerRef.current ?? null,
        isAltOverride
      );
      emitConstraintAxisChange(snapSessionRef.current.getActiveAxis());

      const strokeColor = resolveStrokeColor(bs, isEraser, isBgEraser, isMonochrome, mode);
      const strokeHardness = isMonochrome ? 1.0 : bs.hardness ?? 1.0;
      const strokeFlow = isMonochrome ? 1.0 : bs.flow ?? 1.0;
      const strokeSpacing = bs.spacing ?? 0.08;

      const globalPressureCurve = useUiStore.getState().appSettings.pressureCurve;
      const hasCustomGlobalCurve = Boolean(
        globalPressureCurve &&
          globalPressureCurve.enabled &&
          !isLinearPressureCurve(globalPressureCurve.points)
      );

      const pipeline = strokePipelineRef.current;
      pipeline.beginStroke({
        stabilizerLevel: bs.stabilization ?? 0,
        zoom: zoomRef.current || 1.0,
        sharpCorners: bs.sharpCorners !== false,
        brushSize: bs.size,
        color: strokeColor,
        pointerId: e.pointerId,
        globalPressureCurve,
      });

      const startNow = startPoint.timestamp ?? performance.now();
      lastPointTimeRef.current = startNow;
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
      const prevStrokeEnd = lastStrokeEndRef.current;
      const isShiftLine =
        Boolean(e.shiftKey) &&
        shiftAction === 'straight-line' &&
        !isMaskModeRef.current &&
        prevStrokeEnd !== null &&
        prevStrokeEnd.layerId === currentLayerId;
      isShiftLineStrokeRef.current = isShiftLine;

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
        allStrokePointsRef.current = [pLineStart, pLineMid, startPoint];
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
        allStrokePointsRef.current = [startPoint];
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

      stabilizedPointRef.current = { ...startPoint };
      lastProcessedPointRef.current.x = startPoint.x;
      lastProcessedPointRef.current.y = startPoint.y;
      hasLastProcessedPointRef.current = true;
      lastQueuedPressureRef.current = startPoint.pressure;
      recentPointsTrailRef.current = [
        {
          x: startPoint.x,
          y: startPoint.y,
          t: startNow,
          pressure: startPoint.pressure,
          width: startPoint.width,
        },
      ];
      strokeTotalDistanceRef.current =
        isShiftLine && prevStrokeEnd
          ? Math.hypot(startPoint.x - prevStrokeEnd.x, startPoint.y - prevStrokeEnd.y)
          : 0;

      dispatchPointerStat(startPoint.x, startPoint.y, startPoint.pressure);

      const minInitX =
        isShiftLine && prevStrokeEnd ? Math.min(startPoint.x, prevStrokeEnd.x) : startPoint.x;
      const minInitY =
        isShiftLine && prevStrokeEnd ? Math.min(startPoint.y, prevStrokeEnd.y) : startPoint.y;
      const maxInitX =
        isShiftLine && prevStrokeEnd ? Math.max(startPoint.x, prevStrokeEnd.x) : startPoint.x;
      const maxInitY =
        isShiftLine && prevStrokeEnd ? Math.max(startPoint.y, prevStrokeEnd.y) : startPoint.y;
      dirtyRectRef.current = {
        minX: Math.max(0, Math.floor(minInitX - r)),
        minY: Math.max(0, Math.floor(minInitY - r)),
        maxX: Math.min(dims.width, Math.ceil(maxInitX + r)),
        maxY: Math.min(dims.height, Math.ceil(maxInitY + r)),
      };
      pipeline.expandDirtyRectBounds(
        dirtyRectRef.current.minX,
        dirtyRectRef.current.minY,
        dirtyRectRef.current.maxX,
        dirtyRectRef.current.maxY
      );
      touchedTilesRef.current.clear();
      markTouchedTiles(
        dirtyRectRef.current.minX,
        dirtyRectRef.current.minY,
        dirtyRectRef.current.maxX,
        dirtyRectRef.current.maxY
      );

      const isWetColor = !isEraser && Boolean(bs.colorMixing);
      isWetColorStrokeRef.current = isWetColor;
      liveNeedsNotifyRef.current = false;

      if (isWetColor) {
        layerPixelSamplerRef.current = new LayerPixelSampler(
          canvas || dims,
          currentLayerId,
          activeTileGridRef.current
        );
        activeReservoirRef.current = new PaintReservoir(strokeColor);
      } else {
        layerPixelSamplerRef.current = null;
        activeReservoirRef.current = null;
      }

      const strokeId = `stroke-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      currentStrokeIdRef.current = strokeId;
      onCollabStrokeStartRef.current?.(strokeId, currentLayerId, bs, currentTool, startPoint);

      liveDabCounterRef.current.count = 0;
      stampRemainderDistRef.current = bs.customTipImage
        ? Math.max(0.15, startPoint.width * (bs.spacing ?? 0.07))
        : isPencil
        ? Math.max(0.25, startPoint.width * (bs.spacing ?? 0.07))
        : Math.max(0.12, startPoint.width * (bs.spacing ?? 0.08));

      const firstDotPoint = allStrokePointsRef.current[0];

      if (useWireframeEraser) {
        draftCtx.save();
        draftCtx.strokeStyle = 'rgba(255, 80, 80, 0.75)';
        draftCtx.setLineDash([3, 3]);
        draftCtx.lineWidth = Math.max(1, 1.5 / Math.max(0.05, zoomRef.current));
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
      } else {
        const liveColor =
          (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;
        const liveAA = resolveLiveAntiAlias(bs, isMonochrome, draftScale);
        const gpuBatch = frameGpuDabsRef.current;
        gpuBatch.length = 0;

        if (bs.customTipImage) {
          const tipOptions = buildLiveTexturedOptions(
            bs,
            isMonochrome ? 1.0 : bs.flow ?? 1.0,
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
          const useGpu = canUseWebGlForTexturedBrush(tipOptions);
          drawTexturedDot(
            draftCtx,
            firstDotPoint,
            liveColor,
            bs.customTipImage,
            tipOptions,
            useGpu ? gpuBatch : undefined
          );
          if (useGpu && gpuBatch.length > 0) {
            if (
              !flushTexturedGpuDabs(draftCtx, gpuBatch, bs.customTipImage, liveColor, tipOptions)
            ) {
              drawTexturedDot(draftCtx, firstDotPoint, liveColor, bs.customTipImage, tipOptions);
            }
            gpuBatch.length = 0;
          }
        } else if (isPencil) {
          const grade = (bs.preset as PencilGrade) || 'pencil-2b';
          drawPencilDot(
            draftCtx,
            firstDotPoint,
            liveColor,
            grade,
            isMonochrome ? 1.0 : bs.flow ?? 0.74,
            bs.grain ?? 1.0,
            strokeHardness,
            false,
            false
          );
        } else {
          const radialMixingOptions = buildLiveRadialOptions(
            bs,
            isMonochrome,
            canvas,
            activeLayer,
            true,
            liveAA
          );
          const useGpu = canUseWebGlForRadialBrush(radialMixingOptions);
          drawDot(
            draftCtx,
            firstDotPoint,
            liveColor,
            false,
            strokeHardness,
            strokeFlow,
            radialMixingOptions,
            bs.thickness ?? 1.0,
            ((bs.customTipAngle ?? 0) * Math.PI) / 180,
            useGpu ? gpuBatch : undefined
          );
          if (useGpu && gpuBatch.length > 0) {
            if (
              !flushRadialGpuDabs(
                draftCtx,
                gpuBatch,
                liveColor,
                strokeHardness,
                false,
                false,
                radialMixingOptions
              )
            ) {
              drawDot(
                draftCtx,
                firstDotPoint,
                liveColor,
                false,
                strokeHardness,
                strokeFlow,
                radialMixingOptions,
                bs.thickness ?? 1.0,
                ((bs.customTipAngle ?? 0) * Math.PI) / 180
              );
            }
            gpuBatch.length = 0;
          }
        }
      }

      if (isShiftLine && prevStrokeEnd) {
        const lineSeg = pipeline
          .getSplineGenerator()
          .generateCornerSegment(allStrokePointsRef.current[0], startPoint);
        const liveAA = resolveLiveAntiAlias(bs, isMonochrome, draftScale);
        const liveTipOpts = bs.customTipImage
          ? buildLiveTexturedOptions(
              bs,
              isMonochrome ? 1.0 : bs.flow ?? 1.0,
              strokeSpacing,
              strokeHardness,
              isMonochrome,
              canvas,
              activeLayer,
              isEraser,
              isBgEraser,
              true,
              liveAA
            )
          : null;
        const liveRadialOpts =
          !bs.customTipImage && !isPencil
            ? buildLiveRadialOptions(
                bs,
                isMonochrome,
                canvas,
                activeLayer,
                true,
                liveAA
              )
            : null;
        const useGpuLine =
          !useWireframeEraser &&
          (bs.customTipImage
            ? Boolean(liveTipOpts && canUseWebGlForTexturedBrush(liveTipOpts))
            : !isPencil && Boolean(liveRadialOpts && canUseWebGlForRadialBrush(liveRadialOpts)));
        const gpuBatch = frameGpuDabsRef.current;
        gpuBatch.length = 0;
        emitLiveSegment(
          draftCtx,
          lineSeg,
          bs,
          strokeColor,
          strokeHardness,
          strokeFlow,
          strokeSpacing,
          isMonochrome,
          isPencil,
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
          if (bs.customTipImage && liveTipOpts) {
            flushTexturedGpuDabs(draftCtx, gpuBatch, bs.customTipImage, liveColor, liveTipOpts);
          } else if (liveRadialOpts) {
            flushRadialGpuDabs(
              draftCtx,
              gpuBatch,
              liveColor,
              strokeHardness,
              false,
              false,
              liveRadialOpts
            );
          }
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
          r
        );
      }

      draftCanvas.__draftHasContent = true;
      draftCanvas.__draftVersion = (draftCanvas.__draftVersion || 0) + 1;
      activeTileGridRef.current.notifyChange(true);
      liveNeedsNotifyRef.current = false;

      if (pipeline.getPendingCount() > 0 && drawRafIdRef.current === null) {
        drawRafIdRef.current = requestAnimationFrame(flushPendingPoints);
      }
    },
    [
      abortActiveStroke,
      activeLayerIdRef,
      activeLayerLockedRef,
      activeLayerVisibleRef,
      activeTileGridRef,
      buildLiveRadialOptions,
      buildLiveTexturedOptions,
      clearPredictedCanvas,
      colorModeRef,
      dimensionsRef,
      disabled,
      dispatchPointerStat,
      effectiveDraftCanvasRef,
      emitConstraintAxisChange,
      emitLiveSegment,
      flipXRef,
      flipYRef,
      flushPendingHistoryTasks,
      flushPendingPoints,
      getBrushSettings,
      getCachedLayerCanvas,
      getCanvasPoint,
      getTool,
      getViewportRect,
      interactionRef,
      isDrawingRef,
      isMaskModeRef,
      lastStrokeEndRef,
      layerSourceCanvasesRef,
      layersRef,
      markTouchedTiles,
      onCollabStrokeStartRef,
      panRef,
      resolveLiveAntiAlias,
      resolveStrokeColor,
      rotationRef,
      rulerRef,
      selectionRef,
      viewportRef,
      zoomRef,
    ]
  );

  const handlePointerMove = useCallback(
    (
      e: React.PointerEvent<HTMLElement>,
      coalescedEvents?: PointerEvent[],
      predictedEvents?: PointerEvent[]
    ) => {
      const extEvent = e as ExtendedPointerEvent;
      if (!isDrawingRef.current || e.pointerId !== activePointerIdRef.current) {
        const point = getCanvasPoint(e);
        dispatchPointerStat(point.x, point.y, point.pressure);
        onCollabCursorMoveRef.current?.(point.x, point.y, false, getTool());
        return;
      }

      e.preventDefault();

      const vRect = getViewportRect();
      if (!vRect) return;
      const dims = dimensionsRef.current;

      const candidateCoalesced: PointerEvent[] | readonly PointerEvent[] | null =
        coalescedEvents ??
        extEvent.coalescedEvents ??
        (typeof e.nativeEvent?.getCoalescedEvents === 'function'
          ? e.nativeEvent.getCoalescedEvents()
          : null);
      let rawCoalesced: PointerEvent[] | readonly PointerEvent[] | null = null;
      if (candidateCoalesced && candidateCoalesced.length > 0) {
        const lastC = candidateCoalesced[candidateCoalesced.length - 1];
        const nativeEvt = e.nativeEvent;
        if (
          lastC &&
          nativeEvt &&
          Number.isFinite(lastC.clientX) &&
          Number.isFinite(lastC.clientY) &&
          Math.hypot(lastC.clientX - nativeEvt.clientX, lastC.clientY - nativeEvt.clientY) <= 1.5
        ) {
          rawCoalesced = candidateCoalesced;
        }
      }
      const count = rawCoalesced && rawCoalesced.length > 0 ? rawCoalesced.length : 1;

      const pipeline = strokePipelineRef.current;
      const scratch = scratchDocCoordRef.current;
      const lastProc = lastProcessedPointRef.current;
      const minStepDoc = Math.min(0.25, 0.25 / Math.max(0.05, zoomRef.current));
      const isAltOverride = e.altKey;
      const isShiftKey = e.shiftKey;
      const ruler = rulerRef.current ?? null;
      const curPan = panRef.current;
      const curZoom = zoomRef.current;
      const curRot = rotationRef.current;
      const curFlipX = flipXRef.current;
      const curFlipY = flipYRef.current;

      let lastQueuedX = 0;
      let lastQueuedY = 0;
      let lastQueuedPressure = lastQueuedPressureRef.current;
      let hasQueued = false;

      for (let i = 0; i < count; i++) {
        const cEvent = rawCoalesced && rawCoalesced.length > 0 ? rawCoalesced[i] : e.nativeEvent;
        screenToCanvasInto(
          cEvent.clientX,
          cEvent.clientY,
          vRect,
          curPan,
          curZoom,
          curRot,
          dims,
          scratch,
          curFlipX,
          curFlipY
        );

        const snapRes = snapSessionRef.current.processPoint(scratch, ruler, isAltOverride);
        let cx = snapRes.x;
        let cy = snapRes.y;
        if (snapRes.axis) {
          emitConstraintAxisChange(snapRes.axis);
        } else if (
          !isShiftLineStrokeRef.current &&
          isShiftKey &&
          useUiStore.getState().appSettings.modifierKeys.shift === 'straight-line' &&
          !ruler?.enabled &&
          allStrokePointsRef.current.length > 0
        ) {
          const originPt = allStrokePointsRef.current[0];
          const dx = cx - originPt.x;
          const dy = cy - originPt.y;
          const dist = Math.hypot(dx, dy);
          if (dist > 0.5) {
            const snapAngle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
            cx = originPt.x + Math.cos(snapAngle) * dist;
            cy = originPt.y + Math.sin(snapAngle) * dist;
          }
        }

        let cPressure = 0;
        if (cEvent.pointerType === 'mouse') {
          cPressure = cEvent.buttons & 1 ? 0.5 : 0;
        } else {
          cPressure =
            cEvent.pressure !== undefined ? Math.max(0, Math.min(1.0, cEvent.pressure)) : 0;
        }

        if (
          hasLastProcessedPointRef.current &&
          Math.hypot(cx - lastProc.x, cy - lastProc.y) < minStepDoc &&
          Math.abs(cPressure - lastQueuedPressure) <= 0.04
        ) {
          continue;
        }

        lastProc.x = cx;
        lastProc.y = cy;
        hasLastProcessedPointRef.current = true;

        pipeline.enqueueSample(
          cx,
          cy,
          cPressure,
          cEvent.tiltX ?? 0,
          cEvent.tiltY ?? 0,
          cEvent.twist ?? 0,
          cEvent.timeStamp,
          encodePointerType(cEvent.pointerType)
        );
        lastQueuedX = cx;
        lastQueuedY = cy;
        lastQueuedPressure = cPressure;
        hasQueued = true;
      }

      lastQueuedPressureRef.current = lastQueuedPressure;

      const rawPredicted =
        predictedEvents ??
        extEvent.predictedEvents ??
        (typeof e.nativeEvent?.getPredictedEvents === 'function'
          ? e.nativeEvent.getPredictedEvents()
          : null);

      if (rawPredicted && rawPredicted.length > 0) {
        latestPredictedRef.current = { predEvents: rawPredicted, vRect };
      } else {
        latestPredictedRef.current = null;
      }

      if (hasQueued) {
        dispatchPointerStat(lastQueuedX, lastQueuedY, lastQueuedPressure);
        onCollabCursorMoveRef.current?.(lastQueuedX, lastQueuedY, true, getTool());
      }

      if (
        (pipeline.getPendingCount() > 0 || latestPredictedRef.current !== null) &&
        drawRafIdRef.current === null
      ) {
        drawRafIdRef.current = requestAnimationFrame(flushPendingPoints);
      }
    },
    [
      dimensionsRef,
      dispatchPointerStat,
      emitConstraintAxisChange,
      flipXRef,
      flipYRef,
      flushPendingPoints,
      getCanvasPoint,
      getTool,
      getViewportRect,
      isDrawingRef,
      onCollabCursorMoveRef,
      panRef,
      rotationRef,
      rulerRef,
      zoomRef,
    ]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!isDrawingRef.current || e.pointerId !== activePointerIdRef.current) {
        return;
      }

      e.preventDefault();
      clearPredictedCanvas();

      if (interactionRef.current && interactionRef.current.hasPointerCapture(e.pointerId)) {
        try {
          interactionRef.current.releasePointerCapture(e.pointerId);
        } catch {
          // Ignore release errors
        }
      }

      if (drawRafIdRef.current !== null) {
        cancelAnimationFrame(drawRafIdRef.current);
        drawRafIdRef.current = null;
      }
      flushPendingPoints(true);

      const bs = getBrushSettings();
      const dims = dimensionsRef.current;
      const grid = activeTileGridRef.current;
      const endPoint = getCanvasPoint(e);
      const draftCanvas = effectiveDraftCanvasRef?.current as
        | DraftCanvasElement
        | null
        | undefined;
      const canvas = getCachedLayerCanvas() as DraftCanvasElement | null;
      if (canvas) {
        canvas.__isBlank = false;
        canvas.__isSolidWhite = false;
      }

      const currentTool = getTool();
      const currentLayerId = activeLayerIdRef.current;
      const isEraser = currentTool === 'eraser';
      const isBgEraser = isEraser && isBackgroundLayerId(currentLayerId);
      const mode = colorModeRef.current;
      const isPencil =
        !isEraser && !bs.customTipImage && (bs.preset?.startsWith('pencil') ?? false);

      const isTone = isToneStrokeRef.current;
      const activeLayer = layersRef.current?.find((l) => l.id === currentLayerId);
      const isToneLayer = Boolean(activeLayer?.toneEnabled);
      const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
      const isMonochrome = mode === 'monochrome' || isMonoLayer;
      const sourceCanvas = isTone ? layerSourceCanvasesRef?.current?.get(currentLayerId) : null;
      const strokeColor = resolveStrokeColor(bs, isEraser, isBgEraser, isMonochrome, mode);

      const pipeline = strokePipelineRef.current;
      const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
      const tailPadExtra = Math.ceil((bs.size || 10) * (1.8 + scatterFactor * 2) + 24);
      const enableFlickTaper =
        !isEraser &&
        !isShiftLineStrokeRef.current &&
        activeLayer?.type !== 'vector' &&
        Boolean(bs.taper?.useOut);

      let addedFlickPoints = false;
      const tailSegments: CubicBezierSegment[] = [];
      pipeline.finalizeStroke(e.nativeEvent?.timeStamp || e.timeStamp || performance.now(), {
        enableFlickTaper,
        dirtyPadExtra: tailPadExtra,
        onPoint: (sample) => {
          addedFlickPoints = true;
          allStrokePointsRef.current.push({
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
          markTouchedTiles(tMinX, tMinY, tMaxX, tMaxY);
        },
      });

      const pDirty = pipeline.dirtyRect;
      const mergedDirty = dirtyRectRef.current
        ? {
            minX: Math.min(
              dirtyRectRef.current.minX,
              Number.isFinite(pDirty.minX) ? pDirty.minX : dirtyRectRef.current.minX
            ),
            minY: Math.min(
              dirtyRectRef.current.minY,
              Number.isFinite(pDirty.minY) ? pDirty.minY : dirtyRectRef.current.minY
            ),
            maxX: Math.max(
              dirtyRectRef.current.maxX,
              Number.isFinite(pDirty.maxX) ? pDirty.maxX : dirtyRectRef.current.maxX
            ),
            maxY: Math.max(
              dirtyRectRef.current.maxY,
              Number.isFinite(pDirty.maxY) ? pDirty.maxY : dirtyRectRef.current.maxY
            ),
          }
        : Number.isFinite(pDirty.minX) && Number.isFinite(pDirty.maxX)
        ? { ...pDirty }
        : null;

      let exitSpeed = 0;
      if (recentPointsTrailRef.current.length >= 2) {
        const trail = recentPointsTrailRef.current;
        const sampleIdx = Math.max(0, trail.length - 4);
        const pA = trail[sampleIdx];
        const pB = trail[trail.length - 1];
        const dwellMs = Math.max(0, performance.now() - pB.t);
        const dt = Math.max(1, pB.t - pA.t + dwellMs);
        exitSpeed = Math.hypot(pB.x - pA.x, pB.y - pA.y) / dt;
      }

      const shouldTaper =
        Boolean(bs.taper?.useIn) || (Boolean(bs.taper?.useOut) && !addedFlickPoints);
      if (shouldTaper && allStrokePointsRef.current.length >= 3) {
        applyParametricTaper(allStrokePointsRef.current, {
          useIn: Boolean(bs.taper?.useIn),
          useOut: Boolean(bs.taper?.useOut) && !addedFlickPoints,
          minSizeFactor: bs.minSizeFactor,
          exitSpeed,
        });
      }

      const allPoints = allStrokePointsRef.current;
      let createdVectorStroke: VectorStroke | undefined;
      let postPresentWork: (() => void) | null = null;

      if (allPoints.length > 0 && !isMaskModeRef.current) {
        const finalPt = allPoints[allPoints.length - 1];
        lastStrokeEndRef.current = {
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
          canvas,
          mergedDirty,
          strokeId: currentStrokeIdRef.current,
          pushHistoryStep,
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
          const strokeIdForHistory = currentStrokeIdRef.current || undefined;
          const { x: sx, y: sy, width: dw, height: dh } = clampedBakeRect;
          let label = 'Brush Stroke';
          if (bs.isTransparentInk) {
            label = 'Transparent Ink';
          } else if (currentTool === 'eraser') {
            label = 'Eraser';
          } else if (bs.brushName) {
            label = bs.brushName;
          } else if (bs.preset === 'pencil-f') {
            label = 'Pencil (F)';
          } else if (bs.preset === 'pencil-2b') {
            label = 'Pencil (2B)';
          } else if (bs.preset === 'pencil-4b') {
            label = 'Pencil (4B)';
          } else if (bs.preset === 'pencil-hb') {
            label = 'Pencil (HB)';
          } else {
            label = isMonochrome ? 'Monochrome Pen' : 'Round Brush';
          }

          const dirtyRect = clampedBakeRect;
          const toolForHistory =
            currentTool === 'eraser' ? 'eraser' : isPencil ? 'pencil' : 'brush';
          const targetFormat: TileFormat =
            isMonochrome && !isBackgroundLayerId(currentLayerId)
              ? 'monochrome-1bit'
              : 'color-32bit';
          const effectiveMode: CanvasColorMode = isMonochrome ? 'monochrome' : mode;
          const activeSelection = selectionRef.current;

          if (isMaskModeRef.current && canvas) {
            const ctx = get2DContext(canvas);
            if (ctx) {
              const beforeMaskData = ctx.getImageData(sx, sy, dw, dh);
              const maskBs: BrushSettings = {
                ...bs,
                color: strokeColor,
                isTransparentInk: false,
                colorMixing: false,
              };
              const maskTool: ToolType = isEraser ? 'brush' : currentTool;

              ctx.save();
              ctx.beginPath();
              ctx.rect(sx, sy, dw, dh);
              ctx.clip();
              applySelectionCanvasClip(ctx, activeSelection);

              if ((bs.opacity ?? 1.0) >= 0.999) {
                renderCompleteStroke(
                  ctx,
                  allPoints,
                  maskBs,
                  maskTool,
                  'grayscale',
                  false,
                  canvas,
                  false
                );
              } else {
                ctx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.opacity ?? 1.0));
                ctx.globalCompositeOperation = 'source-over';
                const bakeCanvas = getReusableBakeCanvas(dw, dh);
                const bCtx = bakeCanvas.getContext('2d', { alpha: true });
                if (bCtx) {
                  bCtx.clearRect(0, 0, dw, dh);
                  bCtx.save();
                  bCtx.translate(-sx, -sy);
                  renderCompleteStroke(
                    bCtx,
                    allPoints,
                    { ...maskBs, opacity: 1.0 },
                    maskTool,
                    'grayscale',
                    false,
                    canvas,
                    false
                  );
                  bCtx.restore();
                  ctx.drawImage(bakeCanvas, 0, 0, dw, dh, sx, sy, dw, dh);
                }
              }
              ctx.restore();

              const afterMaskData = ctx.getImageData(sx, sy, dw, dh);
              if (activeSelection?.mask) {
                applySelectionMaskToImageData(
                  beforeMaskData,
                  afterMaskData,
                  sx,
                  sy,
                  activeSelection
                );
                ctx.putImageData(afterMaskData, sx, sy);
              }
              if (activeLayer) {
                activeLayer.maskVersion = (activeLayer.maskVersion || 0) + 1;
              }
              enqueueHistoryTask(() => {
                pushHistoryStep(
                  toolForHistory,
                  'Layer Mask Stroke',
                  beforeMaskData,
                  afterMaskData,
                  currentLayerId,
                  dirtyRect,
                  undefined,
                  undefined,
                  undefined,
                  strokeIdForHistory,
                  true
                );
              });
            }
          } else if (isToneLayer && sourceCanvas) {
            if (!grid.isLayerIngested(currentLayerId)) {
              grid.ingestCanvas(currentLayerId, sourceCanvas, targetFormat);
            }
            const sCtx = get2DContext(sourceCanvas);
            const beforeSelectionData =
              activeSelection?.mask && sCtx ? sCtx.getImageData(sx, sy, dw, dh) : null;
            if (sCtx) {
              sCtx.save();
              sCtx.beginPath();
              sCtx.rect(sx, sy, dw, dh);
              sCtx.clip();
              applySelectionCanvasClip(sCtx, activeSelection);

              const needsIsolatedBake = (bs.opacity ?? 1.0) < 0.999;
              if (!needsIsolatedBake) {
                renderCompleteStroke(
                  sCtx,
                  allPoints,
                  bs,
                  currentTool,
                  effectiveMode,
                  isBgEraser,
                  sourceCanvas,
                  Boolean(activeLayer?.alphaLocked)
                );
              } else {
                sCtx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.opacity ?? 1.0));
                if ((isEraser && !isBgEraser) || bs.isTransparentInk) {
                  sCtx.globalCompositeOperation = 'destination-out';
                } else if (activeLayer?.alphaLocked) {
                  sCtx.globalCompositeOperation = 'source-atop';
                } else {
                  sCtx.globalCompositeOperation = 'source-over';
                }
                const bakeCanvas = getReusableBakeCanvas(dw, dh);
                const bCtxBake = bakeCanvas.getContext('2d', { alpha: true });
                if (bCtxBake) {
                  bCtxBake.clearRect(0, 0, dw, dh);
                  bCtxBake.save();
                  bCtxBake.translate(-sx, -sy);
                  renderCompleteStroke(
                    bCtxBake,
                    allPoints,
                    {
                      ...bs,
                      opacity: 1.0,
                      isTransparentInk: false,
                      color: isEraser && !isBgEraser ? '#000000' : bs.color,
                    },
                    isEraser && !isBgEraser ? 'brush' : currentTool,
                    effectiveMode,
                    isBgEraser,
                    sourceCanvas,
                    false
                  );
                  bCtxBake.restore();
                  sCtx.drawImage(bakeCanvas, 0, 0, dw, dh, sx, sy, dw, dh);
                }
              }
              sCtx.restore();
            }

            const beforeSnapshot = grid.snapshotTilesInRect(currentLayerId, dirtyRect);
            const afterData = sCtx ? sCtx.getImageData(sx, sy, dw, dh) : null;
            if (afterData && beforeSelectionData && activeSelection?.mask && sCtx) {
              applySelectionMaskToImageData(
                beforeSelectionData,
                afterData,
                sx,
                sy,
                activeSelection
              );
              sCtx.putImageData(afterData, sx, sy);
            }

            if (activeLayer && canvas) {
              const freq = activeLayer.toneFrequency ?? 60;
              const cellSize = Math.max(3.5, (dimensionsRef.current.dpi ?? 600) / freq);
              const cellMargin = isEraser ? Math.ceil(cellSize * 2 + 32) : 0;
              const fxX = Math.max(0, sx - cellMargin);
              const fxY = Math.max(0, sy - cellMargin);
              const fxW = Math.min(canvas.width, sx + dw + cellMargin) - fxX;
              const fxH = Math.min(canvas.height, sy + dh + cellMargin) - fxY;
              applyLayerEffects(
                sourceCanvas,
                canvas,
                activeLayer,
                dimensionsRef.current.dpi ?? 600,
                { x: fxX, y: fxY, width: fxW, height: fxH }
              );
            }

            if (afterData) {
              grid.writeImageData(currentLayerId, afterData, sx, sy, targetFormat);
            }
            const tileDeltas = grid.computeDeltasFromSnapshot(
              beforeSnapshot,
              currentLayerId,
              dirtyRect
            );

            enqueueHistoryTask(() => {
              pushHistoryStep(
                toolForHistory,
                label,
                null,
                null,
                currentLayerId,
                dirtyRect,
                tileDeltas,
                undefined,
                undefined,
                strokeIdForHistory
              );
            });
          } else {
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

            const canDirectDraftCommit = Boolean(
              draftCanvas &&
                draftCtx &&
                draftScale >= 0.999 &&
                draftDocRect &&
                !hasWetEdge &&
                !bs.colorMixing &&
                (bs.postCorrection ?? 0) === 0 &&
                !shouldTaper &&
                sx >= draftDocRect.x &&
                sy >= draftDocRect.y &&
                sx + dw <= draftDocRect.x + draftCanvas.width &&
                sy + dh <= draftDocRect.y + draftCanvas.height
            );

            if (canDirectDraftCommit && draftCanvas && draftCtx && draftDocRect) {
              // Fast path: 1:1 draft canvas already has the rendered stroke; emit only sealed tail segments
              if (tailSegments.length > 0) {
                const strokeHardness = isMonochrome ? 1.0 : bs.hardness ?? 1.0;
                const strokeFlow = isMonochrome ? 1.0 : bs.flow ?? 1.0;
                const strokeSpacing = bs.spacing ?? 0.08;
                const liveAA = resolveLiveAntiAlias(bs, isMonochrome, draftScale);
                const liveTipOpts = bs.customTipImage
                  ? buildLiveTexturedOptions(
                      bs,
                      isMonochrome ? 1.0 : bs.flow ?? 1.0,
                      strokeSpacing,
                      strokeHardness,
                      isMonochrome,
                      canvas,
                      activeLayer,
                      isEraser,
                      isBgEraser,
                      true,
                      liveAA
                    )
                  : null;
                const liveRadialOpts =
                  !bs.customTipImage && !isPencil
                    ? buildLiveRadialOptions(
                        bs,
                        isMonochrome,
                        canvas,
                        activeLayer,
                        true,
                        liveAA
                      )
                    : null;
                const useGpuTail = bs.customTipImage
                  ? Boolean(liveTipOpts && canUseWebGlForTexturedBrush(liveTipOpts))
                  : !isPencil && Boolean(liveRadialOpts && canUseWebGlForRadialBrush(liveRadialOpts));
                const gpuBatch = frameGpuDabsRef.current;
                gpuBatch.length = 0;

                for (let i = 0; i < tailSegments.length; i++) {
                  emitLiveSegment(
                    draftCtx,
                    tailSegments[i],
                    bs,
                    strokeColor,
                    strokeHardness,
                    strokeFlow,
                    strokeSpacing,
                    isMonochrome,
                    isPencil,
                    isEraser,
                    isBgEraser,
                    false,
                    canvas,
                    activeLayer,
                    useGpuTail ? gpuBatch : undefined
                  );
                }

                if (useGpuTail && gpuBatch.length > 0) {
                  const liveColor =
                    (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;
                  let flushed = false;
                  if (bs.customTipImage && liveTipOpts) {
                    flushed = flushTexturedGpuDabs(
                      draftCtx,
                      gpuBatch,
                      bs.customTipImage,
                      liveColor,
                      liveTipOpts
                    );
                  } else if (liveRadialOpts) {
                    flushed = flushRadialGpuDabs(
                      draftCtx,
                      gpuBatch,
                      liveColor,
                      strokeHardness,
                      false,
                      false,
                      liveRadialOpts
                    );
                  }
                  if (!flushed) {
                    for (let i = 0; i < tailSegments.length; i++) {
                      emitLiveSegment(
                        draftCtx,
                        tailSegments[i],
                        bs,
                        strokeColor,
                        strokeHardness,
                        strokeFlow,
                        strokeSpacing,
                        isMonochrome,
                        isPencil,
                        isEraser,
                        isBgEraser,
                        false,
                        canvas,
                        activeLayer,
                        undefined
                      );
                    }
                  }
                  gpuBatch.length = 0;
                }
              }

              const beforeSnapshot = new Map<
                string,
                { format: TileFormat; data: Uint8Array | null }
              >();
              const spans = buildTouchedTileSpans(sx, sy, dw, dh);
              const draftOriginX = Math.round(draftDocRect.x);
              const draftOriginY = Math.round(draftDocRect.y);
              for (let i = 0; i < spans.length; i++) {
                const sp = spans[i];
                const spanData = draftCtx.getImageData(
                  sp.x - draftOriginX,
                  sp.y - draftOriginY,
                  sp.width,
                  sp.height
                );
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

              postPresentWork = () => {
                const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, currentLayerId);
                enqueueHistoryTask(() => {
                  if (canvas) {
                    grid.renderLayerToCanvas(currentLayerId, canvas, dirtyRect);
                  }
                  if (layerSourceCanvasesRef?.current?.has(currentLayerId)) {
                    const existingSource = layerSourceCanvasesRef.current.get(currentLayerId);
                    if (existingSource) {
                      grid.renderLayerToCanvas(currentLayerId, existingSource, dirtyRect);
                    }
                  }
                  pushHistoryStep(
                    toolForHistory,
                    label,
                    null,
                    null,
                    currentLayerId,
                    dirtyRect,
                    tileDeltas,
                    undefined,
                    undefined,
                    strokeIdForHistory
                  );
                });
              };
            } else if (!bs.colorMixing) {
              // Fast isolated 1:1 re-bake: never allocates/unpacks existing tiles via createRegionCanvas
              const bakeCanvas = getReusableBakeCanvas(dw, dh);
              const bCtx = get2DContext(bakeCanvas);
              if (bCtx) {
                bCtx.clearRect(0, 0, dw, dh);
                bCtx.save();
                bCtx.translate(-sx, -sy);
                bCtx.beginPath();
                bCtx.rect(sx, sy, dw, dh);
                bCtx.clip();
                applySelectionCanvasClip(bCtx, activeSelection);

                const effectiveOpacitySensor = resolveEffectiveOpacitySensor(
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
                  canvas || undefined,
                  false,
                  undefined,
                  allowGpuMonoBake
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
                const spans = buildTouchedTileSpans(sx, sy, dw, dh);
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

                postPresentWork = () => {
                  const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, currentLayerId);
                  enqueueHistoryTask(() => {
                    if (canvas) {
                      grid.renderLayerToCanvas(currentLayerId, canvas, dirtyRect);
                    }
                    if (layerSourceCanvasesRef?.current?.has(currentLayerId)) {
                      const existingSource = layerSourceCanvasesRef.current.get(currentLayerId);
                      if (existingSource) {
                        grid.renderLayerToCanvas(currentLayerId, existingSource, dirtyRect);
                      }
                    }
                    pushHistoryStep(
                      toolForHistory,
                      label,
                      null,
                      null,
                      currentLayerId,
                      dirtyRect,
                      tileDeltas,
                      undefined,
                      undefined,
                      strokeIdForHistory
                    );
                  });
                };
              }
            } else {
              // Wet color-mixing path requires existing layer pixels on the same canvas
              const canPoolRegion = dw <= 2048 && dh <= 2048;
              let pooledCanvas: HTMLCanvasElement | null = null;
              if (canPoolRegion && typeof document !== 'undefined') {
                if (!reusableRegionCanvasRef.current) {
                  reusableRegionCanvasRef.current = document.createElement('canvas');
                }
                pooledCanvas = reusableRegionCanvasRef.current;
              }
              const regionCanvas = grid.createRegionCanvas(currentLayerId, dirtyRect, pooledCanvas);
              const rCtx = regionCanvas ? get2DContext(regionCanvas) : null;
              if (regionCanvas && rCtx) {
                const beforeSelectionData = activeSelection?.mask
                  ? rCtx.getImageData(0, 0, dw, dh)
                  : null;

                rCtx.save();
                rCtx.translate(-sx, -sy);
                rCtx.beginPath();
                rCtx.rect(sx, sy, dw, dh);
                rCtx.clip();
                applySelectionCanvasClip(rCtx, activeSelection);

                const effectiveOpacitySensor = resolveEffectiveOpacitySensor(
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
                  ? new LayerPixelSampler(canvas || dims, currentLayerId, grid)
                  : undefined;

                if (!needsIsolatedBake) {
                  renderCompleteStroke(
                    rCtx,
                    allPoints,
                    bakeBs,
                    currentTool,
                    effectiveMode,
                    isBgEraser,
                    canvas || undefined,
                    Boolean(activeLayer?.alphaLocked),
                    bakeSampler,
                    allowGpuMonoBake
                  );
                } else {
                  rCtx.globalAlpha = Math.max(0.01, Math.min(1.0, bakeBs.opacity ?? 1.0));
                  rCtx.globalCompositeOperation = compositeOp;
                  const bakeCanvas = getReusableBakeCanvas(dw, dh);
                  const bCtx = get2DContext(bakeCanvas);
                  if (bCtx) {
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
                      canvas || undefined,
                      false,
                      bakeSampler,
                      allowGpuMonoBake
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
                  applySelectionMaskToImageData(
                    beforeSelectionData,
                    fullAfter,
                    sx,
                    sy,
                    activeSelection
                  );
                  rCtx.putImageData(fullAfter, 0, 0);
                }

                const spans = buildTouchedTileSpans(sx, sy, dw, dh);
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

                postPresentWork = () => {
                  const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, currentLayerId);
                  enqueueHistoryTask(() => {
                    if (canvas) {
                      grid.renderLayerToCanvas(currentLayerId, canvas, dirtyRect);
                    }
                    if (layerSourceCanvasesRef?.current?.has(currentLayerId)) {
                      const existingSource = layerSourceCanvasesRef.current.get(currentLayerId);
                      if (existingSource) {
                        grid.renderLayerToCanvas(currentLayerId, existingSource, dirtyRect);
                      }
                    }
                    pushHistoryStep(
                      toolForHistory,
                      label,
                      null,
                      null,
                      currentLayerId,
                      dirtyRect,
                      tileDeltas,
                      undefined,
                      undefined,
                      strokeIdForHistory
                    );
                  });
                };
              }
            }
          }
        }
      }

      if (clearDraftRafRef.current !== null) {
        cancelAnimationFrame(clearDraftRafRef.current);
        clearDraftRafRef.current = null;
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
      clearPredictedCanvas();

      grid.notifyChange(true);
      postPresentWork?.();

      if (currentStrokeIdRef.current) {
        onCollabStrokeFinishRef.current?.(
          currentStrokeIdRef.current,
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
        currentStrokeIdRef.current = null;
      }

      strokePipelineRef.current.abortStroke();
      frameGpuDabsRef.current.length = 0;
      isDrawingRef.current = false;
      activePointerIdRef.current = null;
      allStrokePointsRef.current = [];
      stabilizedPointRef.current = null;
      hasLastProcessedPointRef.current = false;
      dirtyRectRef.current = null;
      touchedTilesRef.current.clear();
      liveNeedsNotifyRef.current = false;
      isShiftLineStrokeRef.current = false;
      isToneStrokeRef.current = false;
      layerPixelSamplerRef.current = null;
      activeReservoirRef.current = null;
      snapSessionRef.current.endStroke();
      emitConstraintAxisChange(null);

      if (isMaskModeRef.current) {
        onUpdateMaskThumbnailRef.current?.(currentLayerId);
        grid.notifyChange(true);
      } else {
        enqueueHistoryTask(() => {
          onUpdateLayerThumbnail(currentLayerId);
        });
      }
    },
    [
      activeLayerIdRef,
      activeTileGridRef,
      buildLiveRadialOptions,
      buildLiveTexturedOptions,
      buildTouchedTileSpans,
      clearPredictedCanvas,
      colorModeRef,
      dimensionsRef,
      effectiveDraftCanvasRef,
      emitConstraintAxisChange,
      emitLiveSegment,
      enqueueHistoryTask,
      flushPendingPoints,
      getBrushSettings,
      getCachedLayerCanvas,
      getCanvasPoint,
      getTool,
      interactionRef,
      isDrawingRef,
      isMaskModeRef,
      lastStrokeEndRef,
      layerSourceCanvasesRef,
      layersRef,
      markTouchedTiles,
      onCollabStrokeFinishRef,
      onUpdateLayerThumbnail,
      onUpdateMaskThumbnailRef,
      pushHistoryStep,
      resolveEffectiveOpacitySensor,
      resolveLiveAntiAlias,
      resolveStrokeColor,
      selectionRef,
    ]
  );

  const handlePointerEnter = useCallback(() => {
    if (viewportRef.current) {
      cachedViewportRectRef.current = viewportRef.current.getBoundingClientRect();
    }
    dispatchPointerStat(null, null, 0);
  }, [dispatchPointerStat, viewportRef]);

  const handlePointerLeave = useCallback(() => {
    if (!isDrawingRef.current) {
      dispatchPointerStat(null, null, 0);
    }
  }, [dispatchPointerStat, isDrawingRef]);

  return {
    abortActiveStroke,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerEnter,
    handlePointerLeave,
  };
}
