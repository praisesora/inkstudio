import React from 'react';
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
} from '../../../types/editor';
import { SparseTileGrid } from '../../../utils/tileEngine';
import { StrokePipeline } from '../../../engine/StrokePipeline';
import { CubicBezierSegment } from '../../../engine/SplineGenerator';
import { BrushRenderOptions } from '../../../engine/BrushEngine';
import { GpuDab } from '../../../engine/WebGlBrushEngine';
import { NaturalPaintStrokeSession } from '../../../engine/NaturalPaintRenderer';
import { PaintReservoir, LayerPixelSampler } from '../../../utils/colorMixingEngine';
import { PerspectiveRuler, StraightRuler, ConstraintAxis } from '../../../types/perspective';
import { PerspectiveSnapSession } from '../../../utils/perspectiveSnapping';
import { StraightRulerSnapSession } from '../../../utils/straightRulerMath';
import { LastStrokeEndState, PushHistoryStepFn } from '../types';

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
  effectiveDraftCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  predictedCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  activeTileGridRef: React.MutableRefObject<SparseTileGrid>;
  rulerRef: React.MutableRefObject<PerspectiveRuler | null | undefined>;
  straightRulerRef?: React.MutableRefObject<StraightRuler | null | undefined>;
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
  getActiveMaskCanvas: (layerId?: string) => HTMLCanvasElement | null;
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

export interface DirtyBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TouchedTileSpan {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecentPointSample {
  x: number;
  y: number;
  t: number;
  pressure: number;
  width: number;
}

export interface PredictedFrameData {
  predEvents: PointerEvent[];
  vRect: DOMRect;
}

export interface StrokeSessionState {
  currentStrokeId: string | null;
  activePointerId: number | null;
  isPredictedCanvasDirty: boolean;
  latestPredicted: PredictedFrameData | null;
  snapSession: PerspectiveSnapSession;
  straightSnapSession: StraightRulerSnapSession;
  lastEmittedAxis: ConstraintAxis | null;
  allStrokePoints: Point[];
  strokePipeline: StrokePipeline;
  frameGpuDabs: GpuDab[];
  reusableRegionCanvas: HTMLCanvasElement | null;
  scratchDocCoord: { x: number; y: number };
  predCoordPool: Array<{ x: number; y: number; pressure?: number }>;
  predDocCoords: Array<{ x: number; y: number; pressure?: number }>;
  predDabCounter: { count: number };
  lastQueuedPressure: number;
  stabilizedPoint: Point | null;
  stampRemainderDist: number;
  liveDabCounter: { count: number; lastAngle?: number; lastStepDist?: number };
  activeReservoir: PaintReservoir | null;
  layerPixelSampler: LayerPixelSampler | null;
  naturalPaintSession: NaturalPaintStrokeSession | null;
  naturalStrokeSeed: number;
  isWetColorStroke: boolean;
  liveNeedsNotify: boolean;
  isShiftLineStroke: boolean;
  lastPointTime: number;
  recentPointsTrail: RecentPointSample[];
  strokeTotalDistance: number;
  dirtyRect: DirtyBounds | null;
  touchedTiles: Set<number>;
  lastProcessedPoint: { x: number; y: number };
  hasLastProcessedPoint: boolean;
  drawRafId: number | null;
  clearDraftRaf: number | null;
  statRaf: number | null;
  pendingStat: { x: number | null; y: number | null; pressure: number } | null;
  cachedViewportRect: DOMRect | null;
}

export function createInitialStrokeSessionState(): StrokeSessionState {
  return {
    currentStrokeId: null,
    activePointerId: null,
    isPredictedCanvasDirty: false,
    latestPredicted: null,
    snapSession: new PerspectiveSnapSession(),
    straightSnapSession: new StraightRulerSnapSession(),
    lastEmittedAxis: null,
    allStrokePoints: [],
    strokePipeline: new StrokePipeline(),
    frameGpuDabs: [],
    reusableRegionCanvas: null,
    scratchDocCoord: { x: 0, y: 0 },
    predCoordPool: [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 0, y: 0, pressure: 0.5 },
      { x: 0, y: 0, pressure: 0.5 },
      { x: 0, y: 0, pressure: 0.5 },
    ],
    predDocCoords: [],
    predDabCounter: { count: 0 },
    lastQueuedPressure: 0.5,
    stabilizedPoint: null,
    stampRemainderDist: 0,
    liveDabCounter: { count: 0 },
    activeReservoir: null,
    layerPixelSampler: null,
    naturalPaintSession: null,
    naturalStrokeSeed: 1337,
    isWetColorStroke: false,
    liveNeedsNotify: false,
    isShiftLineStroke: false,
    lastPointTime: 0,
    recentPointsTrail: [],
    strokeTotalDistance: 0,
    dirtyRect: null,
    touchedTiles: new Set<number>(),
    lastProcessedPoint: { x: 0, y: 0 },
    hasLastProcessedPoint: false,
    drawRafId: null,
    clearDraftRaf: null,
    statRaf: null,
    pendingStat: null,
    cachedViewportRect: null,
  };
}

export type EmitLiveSegmentFn = (
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
) => void;

export type BuildLiveBrushOptionsFn = (
  bs: BrushSettings,
  strokeFlow: number,
  strokeSpacing: number,
  strokeHardness: number,
  isMonochrome: boolean,
  canvas: HTMLCanvasElement | null,
  activeLayer: LayerItem | undefined,
  isEraser: boolean,
  isBgEraser: boolean,
  isolatedPass?: boolean,
  effectiveAntiAlias?: number
) => BrushRenderOptions;

export interface StrokeSessionHelpers {
  getTool: () => ToolType;
  getBrushSettings: () => BrushSettings;
  getPredictedCanvas: () => HTMLCanvasElement | null;
  clearPredictedCanvas: () => void;
  emitConstraintAxisChange: (newAxis: ConstraintAxis | null) => void;
  markTouchedTiles: (minX: number, minY: number, maxX: number, maxY: number) => void;
  getViewportRect: () => DOMRect | null;
  dispatchPointerStat: (x: number | null, y: number | null, pressure: number) => void;
  abortActiveStroke: () => void;
  getCanvasPoint: (e: React.PointerEvent<HTMLElement> | PointerEvent) => Point;
  resolveEffectiveOpacitySensor: (
    bs: BrushSettings,
    isMonochrome: boolean,
    isEraser: boolean
  ) => BrushSettings['opacitySensor'];
  resolveLiveAntiAlias: (
    bs: BrushSettings,
    isMonochrome: boolean,
    scale: number
  ) => number | undefined;
  buildTouchedTileSpans: (sx: number, sy: number, dw: number, dh: number) => TouchedTileSpan[];
  buildLiveBrushOptions: BuildLiveBrushOptionsFn;
  resolveStrokeColor: (
    bs: BrushSettings,
    isEraser: boolean,
    isBgEraser: boolean,
    isMonochrome: boolean,
    mode: CanvasColorMode
  ) => string;
  emitLiveSegment: EmitLiveSegmentFn;
  renderPredictedStroke: (predEvents: PointerEvent[], vRect: DOMRect) => void;
  flushPendingPoints: (skipDisplayArg?: boolean | number) => void;
}
