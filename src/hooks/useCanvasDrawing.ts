import { useRef, useEffect, useState, useCallback } from 'react';
import {
  ToolType,
  BrushSettings,
  Point,
  CanvasDimensions,
  CanvasSelection,
  HistoryActionType,
  HistoryItem,
  HistoryItemMeta,
  CanvasColorMode,
  DirtyRect,
  LayerItem,
  TileDelta,
  VectorStroke,
  VectorKnot,
} from '../types/editor';
import { globalTileGrid, TILE_SIZE, TileFormat } from '../utils/tileEngine';
import { globalUndoCache } from '../utils/undoCache';
import { recoveryService } from '../services/recoveryService';
import {
  applyVectorEraser,
  renderVectorLayer,
  renderVectorStroke,
  computeStrokeBounds,
  simplifyPathPoints,
} from '../utils/vectorEngine';
import {
  calculateStrokeWidth,
  drawSmoothCubicBezierSegment,
  drawDot,
  screenToCanvas,
  screenToCanvasInto,
  getCanvasToViewportMatrix,
  getVisibleCanvasBounds,
  createCanvasThumbnail,
  formatTime,
  get2DContext,
  getReusableBakeCanvas,
  renderCompleteStroke,
  applyParametricTaper,
} from '../utils/canvasUtils';
import {
  StrokePipeline,
  computeClampedBakeDirtyRect,
  encodePointerType,
} from '../engine/StrokePipeline';
import { CubicBezierSegment } from '../engine/SplineGenerator';
import { CanvasNavigationHandle } from './useCanvasNavigation';
import { applyCspWatercolorEdge } from '../engine/CspBrushEngine';
import { enforceColorMode, binarizeImageDataBuffer } from '../utils/colorUtils';
import { drawPencilCubicBezierSegment, drawPencilDot, PencilGrade } from '../utils/pencilEngine';
import {
  drawTexturedCubicBezierSegment,
  drawTexturedDot,
  TexturedBrushOptions,
  RadialMixingOptions,
  canUseWebGlForTexturedBrush,
  canUseWebGlForRadialBrush,
  flushTexturedGpuDabs,
  flushRadialGpuDabs,
} from '../utils/stampEngine';
import { GpuDab } from '../utils/webglBrushEngine';
import { PaintReservoir, LayerPixelSampler } from '../utils/colorMixingEngine';
import { applyLayerEffects } from '../utils/layerEffectsEngine';
import { PerspectiveRuler, ConstraintAxis } from '../types/perspective';
import { PerspectiveSnapSession } from '../utils/perspectiveSnapping';

function isBackgroundLayerId(id: string): boolean {
  return id === 'layer-bg' || id.startsWith('layer-bg');
}

function applySelectionCanvasClip(
  ctx: CanvasRenderingContext2D,
  sel: CanvasSelection | null | undefined
): void {
  if (!sel) return;
  if (sel.type === 'rect') {
    ctx.beginPath();
    ctx.rect(sel.bounds.x, sel.bounds.y, sel.bounds.width, sel.bounds.height);
    ctx.clip();
  } else if (sel.type === 'lasso' && sel.polygon && sel.polygon.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(sel.polygon[0].x, sel.polygon[0].y);
    for (let i = 1; i < sel.polygon.length; i++) {
      ctx.lineTo(sel.polygon[i].x, sel.polygon[i].y);
    }
    ctx.closePath();
    ctx.clip();
  } else if (sel.svgPath && typeof Path2D !== 'undefined') {
    try {
      ctx.clip(new Path2D(sel.svgPath), 'evenodd');
    } catch {
      // Fallback to bounds clip if svgPath fails
      ctx.beginPath();
      ctx.rect(sel.bounds.x, sel.bounds.y, sel.bounds.width, sel.bounds.height);
      ctx.clip();
    }
  }
}

function applySelectionMaskToImageData(
  beforeData: ImageData,
  afterData: ImageData,
  rx: number,
  ry: number,
  sel: CanvasSelection | null | undefined
): void {
  if (!sel || !sel.mask || !sel.maskWidth || !sel.maskHeight) return;
  const mask = sel.mask;
  const mw = sel.maskWidth;
  const mh = sel.maskHeight;
  const w = afterData.width;
  const h = afterData.height;
  const src = beforeData.data;
  const dst = afterData.data;

  for (let ly = 0; ly < h; ly++) {
    const docY = ry + ly;
    const inY = docY >= 0 && docY < mh;
    const maskRow = docY * mw;
    const imgRow = ly * w;
    for (let lx = 0; lx < w; lx++) {
      const docX = rx + lx;
      const mAlpha = inY && docX >= 0 && docX < mw ? mask[maskRow + docX] : 0;
      if (mAlpha === 255) continue;
      const idx = (imgRow + lx) * 4;
      if (mAlpha === 0) {
        dst[idx] = src[idx];
        dst[idx + 1] = src[idx + 1];
        dst[idx + 2] = src[idx + 2];
        dst[idx + 3] = src[idx + 3];
      } else {
        const wAfter = mAlpha / 255;
        const wBefore = 1 - wAfter;
        const aB = (src[idx + 3] / 255) * wBefore;
        const aA = (dst[idx + 3] / 255) * wAfter;
        const outA = aB + aA;
        if (outA <= 0.0001) {
          dst[idx] = 0;
          dst[idx + 1] = 0;
          dst[idx + 2] = 0;
          dst[idx + 3] = 0;
        } else {
          dst[idx] = Math.round((src[idx] * aB + dst[idx] * aA) / outA);
          dst[idx + 1] = Math.round((src[idx + 1] * aB + dst[idx + 1] * aA) / outA);
          dst[idx + 2] = Math.round((src[idx + 2] * aB + dst[idx + 2] * aA) / outA);
          dst[idx + 3] = Math.round(outA * 255);
        }
      }
    }
  }
}

interface UseCanvasDrawingProps {
  tool: ToolType;
  brushSettings: BrushSettings;
  dimensions: CanvasDimensions;
  selection?: CanvasSelection | null;
  colorMode?: CanvasColorMode;
  disabled?: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  pan: { x: number; y: number };
  zoom: number;
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
  navigation?: CanvasNavigationHandle;
  activeLayerId: string;
  activeLayerLocked?: boolean;
  activeLayerVisible?: boolean;
  layerCanvasesRef: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  layerSourceCanvasesRef?: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  layers?: LayerItem[];
  onUpdateLayerThumbnail: (layerId: string) => void;
  isMaskMode?: boolean;
  onUpdateMaskThumbnail?: (layerId: string) => void;
  draftCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  strokeCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  predictedCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  onCollabStrokeStart?: (strokeId: string, layerId: string, brushSettings: BrushSettings, tool: ToolType, startPoint: Point) => void;
  onCollabStrokeChunk?: (strokeId: string, points: Point[]) => void;
  onCollabStrokeFinish?: (strokeId: string, layerId: string, endPoint: Point, dirtyRect?: DirtyRect, vectorStroke?: VectorStroke) => void;
  onCollabCursorMove?: (x: number, y: number, isDrawing: boolean, tool: ToolType) => void;
  perspectiveRuler?: PerspectiveRuler | null;
  onActiveConstraintAxisChange?: (axis: ConstraintAxis | null) => void;
  activeSessionId?: string | null;
}

export function useCanvasDrawing({
  tool,
  brushSettings,
  dimensions,
  selection = null,
  colorMode = 'color',
  disabled = false,
  viewportRef,
  pan,
  zoom,
  rotation,
  flipX = false,
  flipY = false,
  navigation,
  activeLayerId,
  activeSessionId,
  activeLayerLocked = false,
  activeLayerVisible = true,
  layerCanvasesRef,
  layerSourceCanvasesRef,
  layers,
  onUpdateLayerThumbnail,
  isMaskMode = false,
  onUpdateMaskThumbnail,
  draftCanvasRef,
  strokeCanvasRef,
  predictedCanvasRef,
  onCollabStrokeStart,
  onCollabStrokeChunk,
  onCollabStrokeFinish,
  onCollabCursorMove,
  perspectiveRuler = null,
  onActiveConstraintAxisChange,
}: UseCanvasDrawingProps) {
  // Current active collaborative stroke ID
  const currentStrokeIdRef = useRef<string | null>(null);

  // Active stroke is on a screentone layer
  const isToneStrokeRef = useRef(false);

  // Synchronous reference to layers list
  const layersRef = useRef(layers);
  layersRef.current = layers;

  // Support both draftCanvasRef and legacy strokeCanvasRef prop
  const effectiveDraftCanvasRef = draftCanvasRef || strokeCanvasRef;

  const getPredictedCanvas = useCallback((): HTMLCanvasElement | null => {
    if (predictedCanvasRef?.current) return predictedCanvasRef.current;
    const draft = effectiveDraftCanvasRef?.current;
    if (draft?.parentElement) {
      return draft.parentElement.querySelector<HTMLCanvasElement>('canvas.predicted-overlay-canvas');
    }
    return null;
  }, [effectiveDraftCanvasRef, predictedCanvasRef]);

  const isPredictedCanvasDirtyRef = useRef(false);
  const latestPredictedRef = useRef<{ predEvents: PointerEvent[]; vRect: DOMRect } | null>(null);

  const clearPredictedCanvas = useCallback(() => {
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

  // Top overlay interaction reference for pointer capture and events
  const interactionRef = useRef<HTMLDivElement | null>(null);
  const isDrawingRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);

  // Keep navigation transforms and editor settings updated in synchronous refs
  // When `navigation` handle is provided, read directly from its live refs so strokes hit exact document pixels even before debounced React state commits
  const fallbackPanRef = useRef(pan);
  const fallbackZoomRef = useRef(zoom);
  const fallbackRotationRef = useRef(rotation);
  const fallbackFlipXRef = useRef(flipX);
  const fallbackFlipYRef = useRef(flipY);
  const panRef = navigation?.panRef ?? fallbackPanRef;
  const zoomRef = navigation?.zoomRef ?? fallbackZoomRef;
  const rotationRef = navigation?.rotationRef ?? fallbackRotationRef;
  const flipXRef = navigation?.flipXRef ?? fallbackFlipXRef;
  const flipYRef = navigation?.flipYRef ?? fallbackFlipYRef;
  const brushSettingsRef = useRef(brushSettings);
  const toolRef = useRef(tool);
  const colorModeRef = useRef(colorMode);
  const activeLayerIdRef = useRef(activeLayerId);
  const activeLayerLockedRef = useRef(activeLayerLocked);
  const activeLayerVisibleRef = useRef(activeLayerVisible);
  const dimensionsRef = useRef(dimensions);
  const selectionRef = useRef(selection);
  const isMaskModeRef = useRef(isMaskMode);
  const onUpdateMaskThumbnailRef = useRef(onUpdateMaskThumbnail);

  // Synchronously keep fallback & editor refs fresh during render execution
  fallbackPanRef.current = pan;
  fallbackZoomRef.current = zoom;
  fallbackRotationRef.current = rotation;
  fallbackFlipXRef.current = flipX;
  fallbackFlipYRef.current = flipY;
  brushSettingsRef.current = brushSettings;
  toolRef.current = tool;
  colorModeRef.current = colorMode;
  activeLayerIdRef.current = activeLayerId;
  activeLayerLockedRef.current = activeLayerLocked;
  activeLayerVisibleRef.current = activeLayerVisible;
  dimensionsRef.current = dimensions;
  selectionRef.current = selection;
  layersRef.current = layers;
  isMaskModeRef.current = isMaskMode;
  onUpdateMaskThumbnailRef.current = onUpdateMaskThumbnail;

  const onCollabStrokeStartRef = useRef(onCollabStrokeStart);
  const onCollabStrokeChunkRef = useRef(onCollabStrokeChunk);
  const onCollabStrokeFinishRef = useRef(onCollabStrokeFinish);
  const onCollabCursorMoveRef = useRef(onCollabCursorMove);

  const rulerRef = useRef(perspectiveRuler);
  rulerRef.current = perspectiveRuler;
  const onActiveConstraintAxisChangeRef = useRef(onActiveConstraintAxisChange);
  onActiveConstraintAxisChangeRef.current = onActiveConstraintAxisChange;
  const snapSessionRef = useRef(new PerspectiveSnapSession());

  const lastEmittedAxisRef = useRef<ConstraintAxis | null>(null);
  const emitConstraintAxisChange = useCallback((newAxis: ConstraintAxis | null) => {
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
  }, []);

  useEffect(() => {
    fallbackPanRef.current = pan;
    fallbackZoomRef.current = zoom;
    fallbackRotationRef.current = rotation;
    fallbackFlipXRef.current = flipX;
    fallbackFlipYRef.current = flipY;
    brushSettingsRef.current = brushSettings;
    toolRef.current = tool;
    colorModeRef.current = colorMode;
    activeLayerIdRef.current = activeLayerId;
    activeLayerLockedRef.current = activeLayerLocked;
    activeLayerVisibleRef.current = activeLayerVisible;
    dimensionsRef.current = dimensions;
    layersRef.current = layers;
    isMaskModeRef.current = isMaskMode;
    onUpdateMaskThumbnailRef.current = onUpdateMaskThumbnail;
    rulerRef.current = perspectiveRuler;
    onActiveConstraintAxisChangeRef.current = onActiveConstraintAxisChange;

    onCollabStrokeStartRef.current = onCollabStrokeStart;
    onCollabStrokeChunkRef.current = onCollabStrokeChunk;
    onCollabStrokeFinishRef.current = onCollabStrokeFinish;
    onCollabCursorMoveRef.current = onCollabCursorMove;
  });

  // Full sequence of points for high-resolution baking on pointerup
  const allStrokePointsRef = useRef<Point[]>([]);

  // Zero-allocation input ring buffer, 1-Euro corner-snapping stabilizer, spline generator, and taper engine
  const strokePipelineRef = useRef(new StrokePipeline());

  // Reusable per-frame GPU dab batch (eliminates per-frame array allocation on hot path)
  const frameGpuDabsRef = useRef<GpuDab[]>([]);

  // Pre-allocated scratch coordinates for zero-GC pointermove ingestion & prediction
  const scratchDocCoordRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const predCoordPoolRef = useRef<Array<{ x: number; y: number; pressure?: number }>>([
    { x: 0, y: 0, pressure: 0.5 },
    { x: 0, y: 0, pressure: 0.5 },
    { x: 0, y: 0, pressure: 0.5 },
  ]);
  const predDocCoordsRef = useRef<Array<{ x: number; y: number; pressure?: number }>>([]);
  const predDabCounterRef = useRef<{ count: number }>({ count: 0 });
  const lastQueuedPressureRef = useRef<number>(0.5);

  // Stabilizer tracking ref (previous stabilized point for velocity dynamics)
  const stabilizedPointRef = useRef<Point | null>(null);

  // Distance accumulator for textured brush dab stepping
  const stampRemainderDistRef = useRef<number>(0);
  const liveDabCounterRef = useRef<{ count: number }>({ count: 0 });

  // Active color mixing reservoir & lazy tile sampler (reads clean pre-stroke SparseTileGrid)
  const activeReservoirRef = useRef<PaintReservoir | null>(null);
  const layerPixelSamplerRef = useRef<LayerPixelSampler | null>(null);

  const isWetColorStrokeRef = useRef<boolean>(false);
  const liveNeedsNotifyRef = useRef<boolean>(false);
  const lastStrokeEndRef = useRef<{ x: number; y: number; pressure: number; width: number; layerId: string } | null>(null);
  const isShiftLineStrokeRef = useRef<boolean>(false);
  const historyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastPointTimeRef = useRef<number>(0);
  const recentPointsTrailRef = useRef<{ x: number; y: number; t: number; pressure: number; width: number }[]>([]);
  const strokeTotalDistanceRef = useRef<number>(0);

  // Dirty bounding box for the active stroke (mirrored from StrokePipeline.dirtyRect)
  const dirtyRectRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);
  const touchedTilesRef = useRef<Set<number>>(new Set());
  const lastProcessedPointRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const hasLastProcessedPointRef = useRef<boolean>(false);

  const markTouchedTiles = useCallback((minX: number, minY: number, maxX: number, maxY: number) => {
    const dims = dimensionsRef.current;
    const clampedMinX = Math.max(0, Math.floor(minX));
    const clampedMinY = Math.max(0, Math.floor(minY));
    const clampedMaxX = Math.min(dims.width, Math.ceil(maxX));
    const clampedMaxY = Math.min(dims.height, Math.ceil(maxY));
    if (clampedMaxX <= clampedMinX || clampedMaxY <= clampedMinY) return;
    const minTx = clampedMinX >> 8;
    const minTy = clampedMinY >> 8;
    const maxTx = (clampedMaxX - 1) >> 8;
    const maxTy = (clampedMaxY - 1) >> 8;
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        touchedTilesRef.current.add(ty * 65536 + tx);
      }
    }
  }, []);

  const drawRafIdRef = useRef<number | null>(null);
  const clearDraftRafRef = useRef<number | null>(null);


  // Undo / Redo history stack of rich history items
  const historyRef = useRef<HistoryItem[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const [historyList, setHistoryList] = useState<HistoryItemMeta[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Real-time hover / draw stats dispatched via lightweight custom events without triggering React re-renders
  const statRafRef = useRef<number | null>(null);
  const pendingStatRef = useRef<{ x: number | null; y: number | null; pressure: number } | null>(null);

  // Cached viewport bounds to eliminate forced layout reflow during pointer movement
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

  const dispatchPointerStat = useCallback((x: number | null, y: number | null, pressure: number) => {
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
              detail: { ...pendingStatRef.current, isHovering: pendingStatRef.current.x !== null },
            })
          );
        }
      });
    }
  }, []);

  const getActiveCanvas = useCallback(() => {
    const targetId = activeLayerIdRef.current || activeLayerId;
    if (isMaskModeRef.current) {
      const activeLayer = layersRef.current?.find((l) => l.id === targetId);
      if (activeLayer?.maskCanvas) {
        return activeLayer.maskCanvas;
      }
    }
    return (
      layerCanvasesRef.current.get(targetId) ||
      layerCanvasesRef.current.get('layer-1') ||
      layerCanvasesRef.current.values().next().value ||
      null
    );
  }, [activeLayerId, layerCanvasesRef]);

  const syncHistoryState = useCallback(() => {
    const idx = historyIndexRef.current;
    const len = historyRef.current.length;
    setHistoryIndex(idx);
    setCanUndo(idx > 0);
    setCanRedo(idx >= 0 && idx < len - 1);
    setHistoryList(
      historyRef.current.map((item) => ({
        id: item.id,
        type: item.type,
        label: item.label,
        timestamp: item.timestamp,
        timeFormatted: item.timeFormatted,
        thumbnailUrl: item.thumbnailUrl,
        layerId: item.layerId,
      }))
    );
  }, []);

  const ensureInitialHistory = useCallback(
    (canvas: HTMLCanvasElement, _ctx: CanvasRenderingContext2D) => {
      if (historyRef.current.length === 0) {
        const now = Date.now();
        const isMono = !isBackgroundLayerId(activeLayerIdRef.current) && colorModeRef.current === 'monochrome';
        if (!globalTileGrid.isLayerIngested(activeLayerIdRef.current)) {
          globalTileGrid.ingestCanvas(activeLayerIdRef.current, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
        }
        const isLarge = canvas.width * canvas.height > 1024 * 1024;
        const targetH = Math.max(38, Math.round((canvas.height / Math.max(1, canvas.width)) * 60));
        const initialThumb = isLarge
          ? globalTileGrid.generateThumbnail(activeLayerIdRef.current, 60, targetH, { width: canvas.width, height: canvas.height })
          : createCanvasThumbnail(canvas, !isBackgroundLayerId(activeLayerIdRef.current));

        const initialItem: HistoryItem = {
          id: `hist-init-${now}`,
          type: 'initial',
          label: 'New Document',
          timestamp: now,
          timeFormatted: formatTime(now),
          thumbnailUrl: initialThumb,
          imageData: undefined,
          beforeImageData: null,
          afterImageData: null,
          layerId: activeLayerIdRef.current,
        };

        historyRef.current = [initialItem];
        historyIndexRef.current = 0;
        syncHistoryState();
      }
    },
    [syncHistoryState]
  );

  const pushHistoryStep = useCallback(
    (
      actionType: HistoryActionType,
      label: string,
      beforeData: ImageData | null,
      afterData: ImageData | null,
      targetLayerId: string,
      dirtyRect?: DirtyRect,
      explicitTileDeltas?: TileDelta[],
      vectorDelta?: { before: VectorStroke[]; after: VectorStroke[] },
      peerId?: string | number,
      strokeId?: string,
      isMaskEdit?: boolean
    ) => {
      const now = Date.now();
      const canvas = layerCanvasesRef.current.get(targetLayerId) || getActiveCanvas();

      let tileDeltas = explicitTileDeltas;

      const effectiveDirtyRect = dirtyRect || (canvas ? { x: 0, y: 0, width: canvas.width, height: canvas.height } : undefined);

      // Automatically convert ImageData change into minimal SparseTileGrid TileDeltas (skip for mask edits)
      if (!isMaskEdit && !tileDeltas && effectiveDirtyRect && (beforeData || afterData)) {
        const activeLayer = layersRef.current?.find((l) => l.id === targetLayerId);
        const isMono = !isBackgroundLayerId(targetLayerId) && (colorModeRef.current === 'monochrome' || activeLayer?.expressionColor === 'monochrome');
        const targetFormat = isMono ? 'monochrome-1bit' : 'color-32bit';

        if (beforeData) {
          const bx = beforeData.width === effectiveDirtyRect.width && beforeData.height === effectiveDirtyRect.height ? effectiveDirtyRect.x : 0;
          const by = beforeData.width === effectiveDirtyRect.width && beforeData.height === effectiveDirtyRect.height ? effectiveDirtyRect.y : 0;
          globalTileGrid.writeImageData(targetLayerId, beforeData, bx, by, targetFormat);
        }

        const beforeSnapshot = globalTileGrid.snapshotTilesInRect(targetLayerId, effectiveDirtyRect);

        if (afterData) {
          const ax = afterData.width === effectiveDirtyRect.width && afterData.height === effectiveDirtyRect.height ? effectiveDirtyRect.x : 0;
          const ay = afterData.width === effectiveDirtyRect.width && afterData.height === effectiveDirtyRect.height ? effectiveDirtyRect.y : 0;
          globalTileGrid.writeImageData(targetLayerId, afterData, ax, ay, targetFormat);
        } else if (actionType === 'clear') {
          globalTileGrid.clearLayer(targetLayerId);
        }

        tileDeltas = globalTileGrid.computeDeltasFromSnapshot(beforeSnapshot, targetLayerId, effectiveDirtyRect);
      }

      const hasDeltas = Boolean(tileDeltas && tileDeltas.length > 0);

      const item: HistoryItem = {
        id: `hist-${now}-${Math.random().toString(36).substring(2, 7)}`,
        type: actionType,
        label,
        timestamp: now,
        timeFormatted: formatTime(now),
        thumbnailUrl: '',
        layerId: targetLayerId,
        // Memory optimization for 600 DPI manga: eliminate large 35MP ImageData arrays in RAM when tile deltas exist
        beforeImageData: hasDeltas ? null : beforeData,
        afterImageData: hasDeltas ? null : afterData,
        imageData: hasDeltas ? undefined : (afterData || undefined),
        dirtyRect: effectiveDirtyRect,
        tileDeltas: hasDeltas ? tileDeltas : undefined,
        vectorStrokesDelta: vectorDelta,
        peerId,
        strokeId,
        isMaskEdit,
      };

      // Branching: truncate any future redo steps
      const newHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
      newHistory.push(item);

      // Keep max 50 states to maintain smooth memory & performance
      if (newHistory.length > 50) {
        newHistory.shift();
      }

      historyRef.current = newHistory;
      historyIndexRef.current = newHistory.length - 1;

      if (canvas) {
        const isLarge = canvas.width * canvas.height > 1024 * 1024 && globalTileGrid.isLayerIngested(targetLayerId);
        if (isLarge && hasDeltas) {
          const existingLayerThumb = layersRef.current?.find((l) => l.id === targetLayerId)?.thumbnailUrl || '';
          item.thumbnailUrl = existingLayerThumb;
        } else {
          const targetH = Math.max(38, Math.round((canvas.height / Math.max(1, canvas.width)) * 60));
          item.thumbnailUrl = isLarge
            ? globalTileGrid.generateThumbnail(targetLayerId, 60, targetH, { width: canvas.width, height: canvas.height })
            : createCanvasThumbnail(canvas, !isBackgroundLayerId(targetLayerId));
        }
      }
      syncHistoryState();

      // Seamless LRU disk cache offloading via Tauri v2 Rust IPC
      if (tileDeltas && tileDeltas.length > 0) {
        globalUndoCache.registerStep(item, historyRef.current).catch((err) => {
          console.warn('[History] LRU cache registration failed:', err);
        });
      }

      // Non-blocking WAL journaling for crash recovery
      if ((tileDeltas && tileDeltas.length > 0) || vectorDelta) {
        const sessionKey = activeSessionId || recoveryService.getCurrentSessionId() || 'default-session';
        recoveryService.logStrokeDelta(sessionKey, tileDeltas, vectorDelta, targetLayerId);
      }
    },
    [getActiveCanvas, layerCanvasesRef, syncHistoryState]
  );

  // Background history serialization queue to eliminate main-thread hitches on stroke lift-off
  const pendingHistoryTasksRef = useRef<Array<() => void>>([]);
  const idleCallbackIdRef = useRef<any>(null);

  const flushPendingHistoryTasks = useCallback(() => {
    if (idleCallbackIdRef.current !== null) {
      if (typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
        (window as any).cancelIdleCallback(idleCallbackIdRef.current);
      } else {
        clearTimeout(idleCallbackIdRef.current);
      }
      idleCallbackIdRef.current = null;
    }
    const tasks = pendingHistoryTasksRef.current.splice(0);
    for (const task of tasks) {
      try {
        task();
      } catch (err) {
        console.warn('[History] Error flushing pending history task:', err);
      }
    }
  }, []);

  const enqueueHistoryTask = useCallback((task: () => void) => {
    pendingHistoryTasksRef.current.push(task);
    if (idleCallbackIdRef.current === null) {
      const scheduleRun = () => {
        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
          idleCallbackIdRef.current = (window as any).requestIdleCallback(runTasks, { timeout: 1200 });
        } else {
          idleCallbackIdRef.current = setTimeout(runTasks, 64);
        }
      };
      const runTasks = () => {
        idleCallbackIdRef.current = null;
        if (isDrawingRef.current) {
          scheduleRun();
          return;
        }
        const tasks = pendingHistoryTasksRef.current.splice(0);
        for (const t of tasks) {
          try {
            t();
          } catch (err) {
            console.warn('[History] Error running idle history task:', err);
          }
        }
      };
      scheduleRun();
    }
  }, []);

  // Abort any in-progress stroke session immediately (zero base-layer mutation to undo!)
  const abortActiveStroke = useCallback(() => {
    if (!isDrawingRef.current) return;
    if (drawRafIdRef.current !== null) {
      cancelAnimationFrame(drawRafIdRef.current);
      drawRafIdRef.current = null;
    }
    const draftCanvas = effectiveDraftCanvasRef?.current;
    let clearedActiveDraft = false;
    if (draftCanvas) {
      const dCtx = get2DContext(draftCanvas);
      if (dCtx) {
        try {
          dCtx.restore();
        } catch (_) {}
        dCtx.resetTransform();
        dCtx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
      }
      if ((draftCanvas as any).__draftHasContent) {
        clearedActiveDraft = true;
      }
      (draftCanvas as any).__draftHasContent = false;
      (draftCanvas as any).__draftCompositeOp = 'source-over';
      (draftCanvas as any).__draftMonochrome = false;
      (draftCanvas as any).__draftVersion = ((draftCanvas as any).__draftVersion || 0) + 1;
    }
    clearPredictedCanvas();
    if (clearedActiveDraft) {
      globalTileGrid.notifyChange(true);
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
  }, [clearPredictedCanvas, effectiveDraftCanvasRef, emitConstraintAxisChange]);

  // Jump directly to any past or future history step (serialized via historyQueueRef to prevent async race on rapid Ctrl+Z)
  const jumpToHistoryIndex = useCallback(
    (targetIndex: number): Promise<void> => {
      flushPendingHistoryTasks();
      if (isDrawingRef.current) {
        abortActiveStroke();
      }
      const nextOp = historyQueueRef.current.then(async () => {
        if (targetIndex < 0 || targetIndex >= historyRef.current.length) return;
        const currentIndex = historyIndexRef.current;
        if (targetIndex === currentIndex) return;

        if (targetIndex < currentIndex) {
          // Rolling back (undoing) in reverse chronological order
          for (let i = currentIndex; i > targetIndex; i--) {
            const item = historyRef.current[i];
            if (item) {
              const targetLayerId = item.layerId || activeLayerId;
              const canvas = layerCanvasesRef.current.get(targetLayerId) || null;
              const sourceCanvas = layerSourceCanvasesRef?.current?.get(targetLayerId);
              const targetLayer = layersRef.current?.find((l) => l.id === targetLayerId);
              const isToneStep = Boolean(targetLayer?.toneEnabled && sourceCanvas);
              const deltas = await globalUndoCache.resolveDeltas(item);

            // Restore mask canvas if mask edit
            if (item.isMaskEdit && targetLayer?.maskCanvas) {
              const mCtx = get2DContext(targetLayer.maskCanvas);
              if (mCtx && item.beforeImageData) {
                const mx = item.dirtyRect && item.beforeImageData.width === item.dirtyRect.width ? item.dirtyRect.x : 0;
                const my = item.dirtyRect && item.beforeImageData.height === item.dirtyRect.height ? item.dirtyRect.y : 0;
                mCtx.putImageData(item.beforeImageData, mx, my);
                targetLayer.maskVersion = (targetLayer.maskVersion || 0) + 1;
                onUpdateMaskThumbnailRef.current?.(targetLayerId);
              }
            } else if (item.vectorStrokesDelta && targetLayer && canvas) {
              targetLayer.vectorStrokes = item.vectorStrokesDelta.before;
              const cCtx = get2DContext(canvas);
              if (cCtx) {
                cCtx.clearRect(0, 0, canvas.width, canvas.height);
                renderVectorLayer(cCtx, targetLayer.vectorStrokes);
                const fullData = cCtx.getImageData(0, 0, canvas.width, canvas.height);
                const isMono = targetLayer.expressionColor === 'monochrome';
                globalTileGrid.writeImageData(targetLayerId, fullData, 0, 0, isMono ? 'monochrome-1bit' : 'color-32bit');
              }
            } else if (deltas && deltas.length > 0) {
              globalTileGrid.applyTileDeltas(deltas, 'undo');

              if (isToneStep && sourceCanvas) {
                globalTileGrid.renderLayerToCanvas(targetLayerId, sourceCanvas, item.dirtyRect);
                if (canvas && targetLayer) {
                  applyLayerEffects(
                    sourceCanvas,
                    canvas,
                    targetLayer,
                    dimensionsRef.current.dpi ?? 600,
                    item.dirtyRect
                  );
                }
              } else if (canvas) {
                globalTileGrid.renderLayerToCanvas(targetLayerId, canvas, item.dirtyRect);
                if (sourceCanvas) {
                  globalTileGrid.renderLayerToCanvas(targetLayerId, sourceCanvas, item.dirtyRect);
                }
              }
            } else if (isToneStep && sourceCanvas) {
              const sCtx = get2DContext(sourceCanvas);
              if (sCtx) {
                if (item.dirtyRect && item.beforeImageData) {
                  sCtx.putImageData(item.beforeImageData, item.dirtyRect.x, item.dirtyRect.y);
                } else if (item.beforeImageData) {
                  sCtx.putImageData(item.beforeImageData, 0, 0);
                } else if (item.type === 'initial') {
                  if (isBackgroundLayerId(targetLayerId)) {
                    sCtx.fillStyle = '#ffffff';
                    sCtx.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
                  } else {
                    sCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
                  }
                }
              }

              if (canvas && targetLayer) {
                applyLayerEffects(
                  sourceCanvas,
                  canvas,
                  targetLayer,
                  dimensionsRef.current.dpi ?? 600,
                  item.dirtyRect
                );
              }
            } else {
              // Direct canvas restoration for monochrome, color, gray, normal pen, eraser, etc.
              if (canvas) {
                const cCtx = get2DContext(canvas);
                if (cCtx) {
                  if (item.dirtyRect && item.beforeImageData && item.beforeImageData.width === item.dirtyRect.width && item.beforeImageData.height === item.dirtyRect.height) {
                    cCtx.putImageData(item.beforeImageData, item.dirtyRect.x, item.dirtyRect.y);
                  } else if (item.beforeImageData) {
                    cCtx.putImageData(item.beforeImageData, 0, 0);
                  } else if (item.type === 'initial') {
                    if (isBackgroundLayerId(targetLayerId)) {
                      cCtx.fillStyle = '#ffffff';
                      cCtx.fillRect(0, 0, canvas.width, canvas.height);
                    } else {
                      cCtx.clearRect(0, 0, canvas.width, canvas.height);
                    }
                  }
                  const isMono = !isBackgroundLayerId(targetLayerId) && (targetLayer?.expressionColor === 'monochrome' || colorModeRef.current === 'monochrome');
                  globalTileGrid.ingestCanvas(targetLayerId, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
                }
              }

              // Keep sourceCanvas synchronized if present
              if (sourceCanvas) {
                const sCtx = get2DContext(sourceCanvas);
                if (sCtx) {
                  if (item.dirtyRect && item.beforeImageData && item.beforeImageData.width === item.dirtyRect.width && item.beforeImageData.height === item.dirtyRect.height) {
                    sCtx.putImageData(item.beforeImageData, item.dirtyRect.x, item.dirtyRect.y);
                  } else if (item.beforeImageData) {
                    sCtx.putImageData(item.beforeImageData, 0, 0);
                  } else if (item.type === 'initial') {
                    if (isBackgroundLayerId(targetLayerId)) {
                      sCtx.fillStyle = '#ffffff';
                      sCtx.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
                    } else {
                      sCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
                    }
                  }
                }
              }
            }

            if (canvas) {
              onUpdateLayerThumbnail(targetLayerId);
            }
          }
        }
      } else {
        // Rolling forward (redoing) in forward chronological order
        for (let i = currentIndex + 1; i <= targetIndex; i++) {
          const item = historyRef.current[i];
          const dataToApply = item?.afterImageData || item?.imageData;
          if (item) {
            const targetLayerId = item.layerId || activeLayerId;
            const canvas = layerCanvasesRef.current.get(targetLayerId) || null;
            const sourceCanvas = layerSourceCanvasesRef?.current?.get(targetLayerId);
            const targetLayer = layersRef.current?.find((l) => l.id === targetLayerId);
            const isToneStep = Boolean(targetLayer?.toneEnabled && sourceCanvas);
            const deltas = await globalUndoCache.resolveDeltas(item);

            // Restore mask canvas if mask edit
            if (item.isMaskEdit && targetLayer?.maskCanvas) {
              const mCtx = get2DContext(targetLayer.maskCanvas);
              if (mCtx && dataToApply) {
                const mx = item.dirtyRect && dataToApply.width === item.dirtyRect.width ? item.dirtyRect.x : 0;
                const my = item.dirtyRect && dataToApply.height === item.dirtyRect.height ? item.dirtyRect.y : 0;
                mCtx.putImageData(dataToApply, mx, my);
                targetLayer.maskVersion = (targetLayer.maskVersion || 0) + 1;
                onUpdateMaskThumbnailRef.current?.(targetLayerId);
              }
            } else if (item.vectorStrokesDelta && targetLayer && canvas) {
              targetLayer.vectorStrokes = item.vectorStrokesDelta.after;
              const cCtx = get2DContext(canvas);
              if (cCtx) {
                cCtx.clearRect(0, 0, canvas.width, canvas.height);
                renderVectorLayer(cCtx, targetLayer.vectorStrokes);
                const fullData = cCtx.getImageData(0, 0, canvas.width, canvas.height);
                const isMono = targetLayer.expressionColor === 'monochrome';
                globalTileGrid.writeImageData(targetLayerId, fullData, 0, 0, isMono ? 'monochrome-1bit' : 'color-32bit');
              }
            } else if (deltas && deltas.length > 0) {
              globalTileGrid.applyTileDeltas(deltas, 'redo');

              if (isToneStep && sourceCanvas) {
                globalTileGrid.renderLayerToCanvas(targetLayerId, sourceCanvas, item.dirtyRect);
                if (canvas && targetLayer) {
                  applyLayerEffects(
                    sourceCanvas,
                    canvas,
                    targetLayer,
                    dimensionsRef.current.dpi ?? 600,
                    item.dirtyRect
                  );
                }
              } else if (canvas) {
                globalTileGrid.renderLayerToCanvas(targetLayerId, canvas, item.dirtyRect);
                if (sourceCanvas) {
                  globalTileGrid.renderLayerToCanvas(targetLayerId, sourceCanvas, item.dirtyRect);
                }
              }
            } else if (isToneStep && sourceCanvas) {
              const sCtx = get2DContext(sourceCanvas);
              if (sCtx) {
                if (item.dirtyRect && dataToApply) {
                  sCtx.putImageData(dataToApply, item.dirtyRect.x, item.dirtyRect.y);
                } else if (dataToApply) {
                  sCtx.putImageData(dataToApply, 0, 0);
                } else if (item.type === 'initial') {
                  if (isBackgroundLayerId(targetLayerId)) {
                    sCtx.fillStyle = '#ffffff';
                    sCtx.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
                  } else {
                    sCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
                  }
                }
              }

              if (canvas && targetLayer) {
                applyLayerEffects(
                  sourceCanvas,
                  canvas,
                  targetLayer,
                  dimensionsRef.current.dpi ?? 600,
                  item.dirtyRect
                );
              }
            } else {
              // Direct canvas restoration for monochrome, color, gray, normal pen, eraser, etc.
              if (canvas) {
                const cCtx = get2DContext(canvas);
                if (cCtx) {
                  if (item.dirtyRect && dataToApply && dataToApply.width === item.dirtyRect.width && dataToApply.height === item.dirtyRect.height) {
                    cCtx.putImageData(dataToApply, item.dirtyRect.x, item.dirtyRect.y);
                  } else if (dataToApply) {
                    cCtx.putImageData(dataToApply, 0, 0);
                  } else if (item.type === 'initial') {
                    if (isBackgroundLayerId(targetLayerId)) {
                      cCtx.fillStyle = '#ffffff';
                      cCtx.fillRect(0, 0, canvas.width, canvas.height);
                    } else {
                      cCtx.clearRect(0, 0, canvas.width, canvas.height);
                    }
                  }
                  const isMono = !isBackgroundLayerId(targetLayerId) && (targetLayer?.expressionColor === 'monochrome' || colorModeRef.current === 'monochrome');
                  globalTileGrid.ingestCanvas(targetLayerId, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
                }
              }

              // Keep sourceCanvas synchronized if present
              if (sourceCanvas) {
                const sCtx = get2DContext(sourceCanvas);
                if (sCtx) {
                  if (item.dirtyRect && dataToApply && dataToApply.width === item.dirtyRect.width && dataToApply.height === item.dirtyRect.height) {
                    sCtx.putImageData(dataToApply, item.dirtyRect.x, item.dirtyRect.y);
                  } else if (dataToApply) {
                    sCtx.putImageData(dataToApply, 0, 0);
                  } else if (item.type === 'initial') {
                    if (isBackgroundLayerId(targetLayerId)) {
                      sCtx.fillStyle = '#ffffff';
                      sCtx.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
                    } else {
                      sCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
                    }
                  }
                }
              }
            }

            if (canvas) {
              onUpdateLayerThumbnail(targetLayerId);
            }
          }
        }
      }

        historyIndexRef.current = targetIndex;
        syncHistoryState();
        globalTileGrid.notifyChange(true);
      });
      historyQueueRef.current = nextOp.catch((err) => {
        console.warn('[History] Error during jumpToHistoryIndex:', err);
      });
      return historyQueueRef.current;
    },
    [abortActiveStroke, activeLayerId, flushPendingHistoryTasks, layerCanvasesRef, layerSourceCanvasesRef, onUpdateLayerThumbnail, syncHistoryState]
  );

  // Undo action
  const undo = useCallback(() => {
    flushPendingHistoryTasks();
    if (isDrawingRef.current) {
      abortActiveStroke();
    }
    if (historyIndexRef.current <= 0) return;
    jumpToHistoryIndex(historyIndexRef.current - 1);
  }, [abortActiveStroke, flushPendingHistoryTasks, jumpToHistoryIndex]);

  // Redo action
  const redo = useCallback(() => {
    flushPendingHistoryTasks();
    if (isDrawingRef.current) {
      abortActiveStroke();
    }
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    jumpToHistoryIndex(historyIndexRef.current + 1);
  }, [abortActiveStroke, flushPendingHistoryTasks, jumpToHistoryIndex]);

  // Selective Undo per Peer
  const selectiveUndo = useCallback(
    async (peerIdToUndo?: string | number) => {
      flushPendingHistoryTasks();
      if (isDrawingRef.current) {
        abortActiveStroke();
      }

      const history = historyRef.current;
      const currIdx = historyIndexRef.current;
      if (currIdx < 0 || history.length === 0) return;

      // Find the most recent history item matching the requested peerId (or local)
      let targetItemIdx = -1;
      for (let i = currIdx; i >= 0; i--) {
        const item = history[i];
        if (!peerIdToUndo || item.peerId === peerIdToUndo || (peerIdToUndo === 'local' && !item.peerId)) {
          targetItemIdx = i;
          break;
        }
      }

      if (targetItemIdx === -1) return;

      const item = history[targetItemIdx];
      const targetLayerId = item.layerId || activeLayerId;
      const canvas = layerCanvasesRef.current.get(targetLayerId) || getActiveCanvas();
      const targetLayer = layersRef.current?.find((l) => l.id === targetLayerId);

      // Revert vector strokes if vector delta exists
      if (item.vectorStrokesDelta && targetLayer && canvas) {
        targetLayer.vectorStrokes = item.vectorStrokesDelta.before;
        const cCtx = get2DContext(canvas);
        if (cCtx) {
          cCtx.clearRect(0, 0, canvas.width, canvas.height);
          renderVectorLayer(cCtx, targetLayer.vectorStrokes);
          const fullData = cCtx.getImageData(0, 0, canvas.width, canvas.height);
          const isMono = targetLayer.expressionColor === 'monochrome';
          globalTileGrid.writeImageData(targetLayerId, fullData, 0, 0, isMono ? 'monochrome-1bit' : 'color-32bit');
        }
      } else {
        // Revert tile deltas or image data
        const deltas = await globalUndoCache.resolveDeltas(item);
        if (deltas && deltas.length > 0) {
          globalTileGrid.applyTileDeltas(deltas, 'undo');
          if (canvas) {
            globalTileGrid.renderLayerToCanvas(targetLayerId, canvas, item.dirtyRect);
          }
        } else if (canvas && item.beforeImageData) {
          const cCtx = get2DContext(canvas);
          if (cCtx) {
            if (item.dirtyRect) {
              cCtx.putImageData(item.beforeImageData, item.dirtyRect.x, item.dirtyRect.y);
            } else {
              cCtx.putImageData(item.beforeImageData, 0, 0);
            }
          }
        }
      }

      // Remove the undone item from history
      historyRef.current.splice(targetItemIdx, 1);
      historyIndexRef.current = Math.min(historyIndexRef.current - 1, historyRef.current.length - 1);
      syncHistoryState();

      if (canvas) {
        onUpdateLayerThumbnail(targetLayerId);
      }
      globalTileGrid.notifyChange(true);
    },
    [abortActiveStroke, activeLayerId, flushPendingHistoryTasks, getActiveCanvas, layerCanvasesRef, onUpdateLayerThumbnail, syncHistoryState]
  );

  // Clear active layer action
  const clearCanvas = useCallback(() => {
    const canvas = getActiveCanvas();
    if (!canvas || activeLayerLocked) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const beforeData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const activeLayer = layersRef.current?.find((l) => l.id === activeLayerId);

    let vectorDelta: { before: VectorStroke[]; after: VectorStroke[] } | undefined;
    if (activeLayer?.type === 'vector') {
      const beforeStrokes = [...(activeLayer.vectorStrokes || [])];
      activeLayer.vectorStrokes = [];
      vectorDelta = { before: beforeStrokes, after: [] };
    }

    const isBg = isBackgroundLayerId(activeLayerId);
    if (isBg) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    const sourceCanvas = layerSourceCanvasesRef?.current?.get(activeLayerId);
    if (sourceCanvas) {
      const sCtx = get2DContext(sourceCanvas);
      if (sCtx) {
        if (isBg) {
          sCtx.fillStyle = '#ffffff';
          sCtx.fillRect(0, 0, sourceCanvas.width, sourceCanvas.height);
        } else {
          sCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
        }
      }
    }

    const afterData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    onUpdateLayerThumbnail(activeLayerId);
    pushHistoryStep(
      'clear',
      'Clear Layer',
      beforeData,
      afterData,
      activeLayerId,
      {
        x: 0,
        y: 0,
        width: canvas.width,
        height: canvas.height,
      },
      undefined,
      vectorDelta
    );
    globalTileGrid.notifyChange(true);
  }, [activeLayerId, activeLayerLocked, getActiveCanvas, layerSourceCanvasesRef, onUpdateLayerThumbnail, pushHistoryStep]);

  // Initialize canvas first history state as soon as canvas is mounted
  useEffect(() => {
    if (historyRef.current.length > 0) return;
    const canvas =
      layerCanvasesRef.current.get(activeLayerId) ||
      layerCanvasesRef.current.get('layer-1') ||
      layerCanvasesRef.current.values().next().value;
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    ensureInitialHistory(canvas, ctx);
  }, [activeLayerId, ensureInitialHistory, layerCanvasesRef]);

  // Convert client pointer event coordinates to canvas pixel space
  const getCanvasPoint = useCallback(
    (e: React.PointerEvent<HTMLElement> | PointerEvent): Point => {
      const vRect = getViewportRect();
      const dims = dimensionsRef.current;
      const bs = brushSettingsRef.current;
      if (!vRect) return { x: 0, y: 0, pressure: 0.5, width: bs.size, timestamp: e.timeStamp };

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
        pressure = (e.buttons & 1) ? 0.5 : 0;
      } else {
        pressure = e.pressure !== undefined ? Math.max(0, Math.min(1.0, e.pressure)) : 0;
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

      const tiltX = e.tiltX ?? 0;
      const tiltY = e.tiltY ?? 0;
      const twist = e.twist ?? 0;

      return { x, y, pressure, width, tiltX, tiltY, twist, timestamp: e.timeStamp };
    },
    [getViewportRect]
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
      isolatedPass: boolean = false
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
      antiAlias: isMonochrome ? 0 : bs.antiAlias,
      pressureCurve: bs.pressureCurve,
      velocityCurve: bs.velocityCurve,
      usePressure: bs.usePressure,
      useVelocity: bs.useVelocity,
      useTilt: Boolean(bs.useTilt),
      sizeSensor: bs.sizeSensor,
      opacitySensor: bs.opacitySensor,
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
    []
  );

  const buildLiveRadialOptions = useCallback(
    (
      bs: BrushSettings,
      isMonochrome: boolean,
      canvas: HTMLCanvasElement | null,
      activeLayer: LayerItem | undefined,
      isolatedPass: boolean = false
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
      thicknessVertical: bs.thicknessVertical,
      flipH: bs.flipH,
      flipV: bs.flipV,
      antiAlias: isMonochrome ? 0 : bs.antiAlias,
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
      opacitySensor: bs.opacitySensor,
      densitySensor: bs.densitySensor,
      taper: bs.taper,
    }),
    []
  );

  // Helper: compute effective live stroke color for current mode/mask/bg-eraser
  const resolveStrokeColor = useCallback(
    (bs: BrushSettings, isEraser: boolean, isBgEraser: boolean, isMonochrome: boolean, mode: CanvasColorMode): string => {
      if (isMaskModeRef.current) {
        if (isEraser) return '#000000';
        let clean = bs.color.replace('#', '');
        if (clean.length === 3) clean = clean.split('').map((c) => c + c).join('');
        const r = parseInt(clean.slice(0, 2), 16) || 0;
        const g = parseInt(clean.slice(2, 4), 16) || 0;
        const b = parseInt(clean.slice(4, 6), 16) || 0;
        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        const hexVal = gray.toString(16).padStart(2, '0');
        return `#${hexVal}${hexVal}${hexVal}`;
      }
      return isBgEraser ? '#ffffff' : enforceColorMode(bs.color, isMonochrome ? 'monochrome' : mode);
    },
    []
  );

  // Renders a sealed CubicBezierSegment onto draftCtx (either pushing into GPU batch or Canvas 2D fallback)
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
      const segPad = Math.ceil(Math.max(sStart.width, sEnd.width, bs.size || 10) * (2.8 + scatterFactor * 2) + 32);
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

      const liveColor = (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;
      const draftCanvas = effectiveDraftCanvasRef?.current;
      const draftScale = (draftCanvas as any)?.__draftScale ?? 1.0;
      const downscaledBinary = (isMonochrome || bs.antiAlias === 0) && draftScale < 0.999;

      if (bs.customTipImage) {
        const tipOptions = buildLiveTexturedOptions(
          bs,
          isMonochrome ? 1.0 : (bs.flow ?? 1.0),
          bs.spacing ?? 0.08,
          strokeHardness,
          downscaledBinary ? false : isMonochrome,
          canvas,
          activeLayer,
          isEraser,
          isBgEraser,
          true
        );
        if (downscaledBinary && tipOptions.antiAlias === 0) {
          tipOptions.antiAlias = 2;
        }
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
          isMonochrome ? 1.0 : (bs.flow ?? 0.74),
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
          downscaledBinary ? false : isMonochrome,
          canvas,
          activeLayer,
          true
        );
        if (downscaledBinary && radialMixingOptions.antiAlias === 0) {
          radialMixingOptions.antiAlias = 2;
        }
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
    [buildLiveRadialOptions, buildLiveTexturedOptions, effectiveDraftCanvasRef, markTouchedTiles]
  );

  // Ephemeral predicted tail overlay rendered strictly onto effectivePredictedCanvasRef (never leaks into layer data)
  const renderPredictedStroke = useCallback(
    (predEvents: PointerEvent[], vRect: DOMRect) => {
      clearPredictedCanvas();
      const bs = brushSettingsRef.current;
      if (toolRef.current === 'eraser' || bs.isTransparentInk) return;
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
      const strokeHardness = isMonochrome ? 1.0 : (bs.hardness ?? 1.0);
      const strokeFlow = isMonochrome ? 1.0 : (bs.flow ?? 1.0);
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
      // On viewport-sized predictedCanvas when zoomed out in monochrome, use smooth AA=2 (thresholded by SVG filter) so pixels never drop
      const predAA = isMonochrome && zoomRef.current < 1.0 ? 2 : (isMonochrome ? 0 : bs.antiAlias);
      const predTipOpts: TexturedBrushOptions | null = bs.customTipImage
        ? {
            size: bs.size,
            minSizeFactor: bs.minSizeFactor,
            opacity: 1.0,
            flow: strokeFlow,
            spacing: strokeSpacing,
            thickness: bs.thickness,
            thicknessVertical: bs.thicknessVertical,
            angle: bs.customTipAngle,
            angleDynamics: bs.customTipAngleDynamics,
            rotationRandomScale: bs.customTipRotationRandomScale,
            hardness: strokeHardness,
            antiAlias: predAA,
            pressureCurve: bs.pressureCurve,
            usePressure: bs.usePressure,
            subTips: bs.subTips,
            subTipOrder: bs.subTipOrder,
            subTipImages: bs.subTipImages,
            spray: bs.spray,
            wetEdge: 0,
            grain: bs.grain ?? bs.textureDensity,
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
        dynamics: bs.dynamics,
        secondaryColor: bs.secondaryColor,
        dualBrush: bs.dualBrush,
        dualTipImage: bs.dualTipImage,
        dualBrushCompositeMode: bs.dualBrushCompositeMode,
        grain: bs.grain ?? bs.textureDensity,
      };

      const predGpuDabs = frameGpuDabsRef.current;
      predGpuDabs.length = 0;
      const useGpuPred = bs.customTipImage
        ? Boolean(predTipOpts && canUseWebGlForTexturedBrush(predTipOpts))
        : (!isPencil && canUseWebGlForRadialBrush(predRadialOpts));

      predDabCounterRef.current.count = liveDabCounterRef.current.count;
      // In zoomed-out monochrome mode, committed LOD tiles (OR-downsampled) and mipmapped draftCanvas
      // preserve sub-pixel ink at ~1.35 CSS px; lift transient predicted-bridge widths to match.
      const minPredMonoWidth = isMonochrome && zoomRef.current < 0.99 ? 1.35 / Math.max(0.01, zoomRef.current) : 0;
      // Render ONLY the real unsealed Catmull-Rom bridge (knotP1 -> knotP2), avoiding speculative
      // ahead-of-cursor overshoot that snaps back / disappears upon pointerup.
      const drew = pipeline.buildPredictedSegments(
        null,
        maxPredDist,
        (seg) => {
          const p0 = minPredMonoWidth > 0 && seg.p0.width < minPredMonoWidth ? { ...seg.p0, width: minPredMonoWidth } : seg.p0;
          const p3 = minPredMonoWidth > 0 && seg.p3.width < minPredMonoWidth ? { ...seg.p3, width: minPredMonoWidth } : seg.p3;
          if (bs.customTipImage && predTipOpts) {
            predRem = drawTexturedCubicBezierSegment(
              pCtx,
              p0,
              seg.c1,
              seg.c2,
              p3,
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
              p0,
              seg.c1,
              seg.c2,
              p3,
              strokeColor,
              grade,
              isMonochrome ? 1.0 : (bs.flow ?? 0.74),
              bs.grain ?? 1.0,
              strokeHardness,
              predRem,
              false,
              false
            );
          } else {
            predRem = drawSmoothCubicBezierSegment(
              pCtx,
              p0,
              seg.c1,
              seg.c2,
              p3,
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
        }
      );

      if (useGpuPred && predGpuDabs.length > 0) {
        if (bs.customTipImage && predTipOpts) {
          flushTexturedGpuDabs(pCtx, predGpuDabs, bs.customTipImage, strokeColor, predTipOpts);
        } else {
          flushRadialGpuDabs(pCtx, predGpuDabs, strokeColor, strokeHardness, false, false, predRadialOpts);
        }
        predGpuDabs.length = 0;
      }

      pCtx.restore();
      if (drew) {
        isPredictedCanvasDirtyRef.current = true;
      }
    },
    [clearPredictedCanvas, getPredictedCanvas, resolveStrokeColor]
  );

  // Flush batched points from StrokePipeline ring buffer on requestAnimationFrame (ZERO getImageData!)
  const flushPendingPoints = useCallback(() => {
    drawRafIdRef.current = null;
    if (!isDrawingRef.current) return;

    const pipeline = strokePipelineRef.current;
    if (pipeline.getPendingCount() === 0) {
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

    const draftCanvas = effectiveDraftCanvasRef?.current;
    if (!draftCanvas) return;
    const draftCtx = get2DContext(draftCanvas);
    if (!draftCtx) return;

    const bs = brushSettingsRef.current;
    const mode = colorModeRef.current;
    const isEraser = toolRef.current === 'eraser';
    const currentLayerId = activeLayerIdRef.current;
    const isBgEraser = isEraser && isBackgroundLayerId(currentLayerId);
    const activeLayer = layersRef.current?.find((l) => l.id === currentLayerId);
    const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
    const isMonochrome = mode === 'monochrome' || isMonoLayer;
    const isPencil = !isEraser && !bs.customTipImage && (bs.preset?.startsWith('pencil') ?? false);
    const isVectorOrToneOrMask = activeLayer?.type === 'vector' || isToneStrokeRef.current || isMaskModeRef.current;
    const useWireframeEraser = isVectorOrToneOrMask && isEraser && !isBgEraser;
    const canvas = getActiveCanvas();
    const strokeColor = resolveStrokeColor(bs, isEraser, isBgEraser, isMonochrome, mode);
    const strokeHardness = isMonochrome ? 1.0 : (bs.hardness ?? 1.0);
    const strokeFlow = isMonochrome ? 1.0 : (bs.flow ?? 1.0);
    const strokeSpacing = bs.spacing ?? 0.08;
    const hasCustomCurve = Boolean(bs.pressureCurve && bs.pressureCurve.length > 0);
    const taperEngine = pipeline.getTaperEngine();
    const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
    const blurMargin = (1 - strokeHardness) * ((bs.size || 10) * 1.5);
    const dirtyPadExtra = Math.ceil((bs.size || 10) * (1.8 + scatterFactor * 2) + blurMargin + 24);

    // Check GPU instanced dab batch eligibility for this frame
    const draftScale = (draftCanvas as any).__draftScale ?? 1.0;
    const downscaledBinary = (isMonochrome || bs.antiAlias === 0) && draftScale < 0.999;
    const liveTipOpts = bs.customTipImage
      ? buildLiveTexturedOptions(bs, isMonochrome ? 1.0 : (bs.flow ?? 1.0), strokeSpacing, strokeHardness, downscaledBinary ? false : isMonochrome, canvas, activeLayer, isEraser, isBgEraser, true)
      : null;
    if (liveTipOpts && downscaledBinary && liveTipOpts.antiAlias === 0) {
      liveTipOpts.antiAlias = 2;
    }
    const liveRadialOpts = !bs.customTipImage && !isPencil
      ? buildLiveRadialOptions(bs, downscaledBinary ? false : isMonochrome, canvas, activeLayer, true)
      : null;
    if (liveRadialOpts && downscaledBinary && liveRadialOpts.antiAlias === 0) {
      liveRadialOpts.antiAlias = 2;
    }
    const useGpuBatch =
      !useWireframeEraser &&
      (bs.customTipImage
        ? Boolean(liveTipOpts && canUseWebGlForTexturedBrush(liveTipOpts))
        : (!isPencil && Boolean(liveRadialOpts && canUseWebGlForRadialBrush(liveRadialOpts))));

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
          const dist = Math.hypot(rawX - stabilizedPointRef.current.x, rawY - stabilizedPointRef.current.y);
          const speed = dist / Math.max(1, dtMs);
          velocityScale = Math.max(0.65, Math.min(1.0, 1.0 - Math.max(0, speed - 0.5) * 0.12));
        }

        const baseP = bs.usePressure
          ? (hasCustomCurve ? stabPressure : taperEngine.mapPressure(stabPressure))
          : (rawPressure > 0 ? 1.0 : 0);
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
        if (isMonochrome && width < 1.25) {
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

    // Flush the entire frame's GPU dab batch in a single WebGlBrushEngine FBO instanced draw call
    if (useGpuBatch && gpuBatch.length > 0) {
      const liveColor = (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;
      let flushed = false;
      if (bs.customTipImage && liveTipOpts) {
        flushed = flushTexturedGpuDabs(draftCtx, gpuBatch, bs.customTipImage, liveColor, liveTipOpts);
      } else if (liveRadialOpts) {
        flushed = flushRadialGpuDabs(draftCtx, gpuBatch, liveColor, strokeHardness, false, false, liveRadialOpts);
      }
      if (!flushed) {
        // Rare context-lost fallback: draw recent points onto draftCtx via Canvas 2D
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

    // Mirror StrokePipeline dirtyRect bounds
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
      (draftCanvas as any).__draftHasContent = true;
      (draftCanvas as any).__draftVersion = ((draftCanvas as any).__draftVersion || 0) + 1;
      liveNeedsNotifyRef.current = true;
    }

    if (currentStrokeIdRef.current && chunkPts && chunkPts.length > 0) {
      onCollabStrokeChunkRef.current?.(currentStrokeIdRef.current, chunkPts);
    }

    if (liveNeedsNotifyRef.current) {
      liveNeedsNotifyRef.current = false;
      globalTileGrid.notifyChange();
    }

    // Update ephemeral predicted stroke overlay throttled to rAF
    const predData = latestPredictedRef.current;
    latestPredictedRef.current = null;
    const vRect = getViewportRect();
    if (vRect && allStrokePointsRef.current.length > 0) {
      renderPredictedStroke(predData ? predData.predEvents : [], vRect);
    } else if (isPredictedCanvasDirtyRef.current) {
      clearPredictedCanvas();
    }
  }, [
    buildLiveRadialOptions,
    buildLiveTexturedOptions,
    clearPredictedCanvas,
    effectiveDraftCanvasRef,
    emitLiveSegment,
    getActiveCanvas,
    getViewportRect,
    renderPredictedStroke,
    resolveStrokeColor,
  ]);

  // Pointer Down handler: initialize lightweight draft surface & StrokePipeline without touching base canvas or getImageData
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, _coalescedEvents?: PointerEvent[]) => {
      const isBrushOrEraser = toolRef.current === 'brush' || toolRef.current === 'eraser';
      if (!isBrushOrEraser || disabled || e.button !== 0 || activeLayerLockedRef.current || !activeLayerVisibleRef.current) return;
      e.preventDefault();
      if (isDrawingRef.current) {
        abortActiveStroke();
      }
      flushPendingHistoryTasks();

      const canvas = getActiveCanvas();
      if (!canvas) return;

      if (viewportRef.current) {
        cachedViewportRectRef.current = viewportRef.current.getBoundingClientRect();
      }
      const vRect = getViewportRect();
      if (!vRect) return;

      const dims = dimensionsRef.current;
      const draftCanvas = effectiveDraftCanvasRef?.current;
      if (!draftCanvas) return;

      if (clearDraftRafRef.current !== null) {
        cancelAnimationFrame(clearDraftRafRef.current);
        clearDraftRafRef.current = null;
      }

      const draftCtx = get2DContext(draftCanvas);
      if (!draftCtx) return;

      const isEraser = toolRef.current === 'eraser';
      const currentLayerId = activeLayerIdRef.current;
      const isBgEraser = isEraser && isBackgroundLayerId(currentLayerId);
      const allLayers = layersRef.current || [];
      const activeLayer = allLayers.find((l) => l.id === currentLayerId);
      const bs = brushSettingsRef.current;
      const mode = colorModeRef.current;
      const isPencil = !isEraser && !bs.customTipImage && (bs.preset?.startsWith('pencil') ?? false);
      const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
      const isMonochrome = mode === 'monochrome' || isMonoLayer;
      const isTone = Boolean(activeLayer?.toneEnabled);
      const isVectorLayer = activeLayer?.type === 'vector';
      const isVectorOrToneOrMask = isVectorLayer || isTone || isMaskModeRef.current;
      const useWireframeEraser = isVectorOrToneOrMask && isEraser && !isBgEraser;
      isToneStrokeRef.current = isTone;

      // Configure GPU in-stack draft composite mode for ViewportCompositor (zero getImageData!)
      const draftCompositeOp: GlobalCompositeOperation =
        isVectorOrToneOrMask || isBgEraser
          ? 'source-over'
          : isEraser || bs.isTransparentInk
          ? 'destination-out'
          : activeLayer?.alphaLocked
          ? 'source-atop'
          : 'source-over';

      // Size draftCanvas in document space covering the visible document region (1:1 document pixels up to 2048px)
      // Guarantees 100% live-vs-baked parity at any zoom level with zero getImageData!
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
      const MAX_DRAFT_DIM = 2048;
      const draftScale = Math.min(1.0, MAX_DRAFT_DIM / Math.max(visW, visH));
      const surfaceW = Math.max(1, Math.ceil(visW * draftScale));
      const surfaceH = Math.max(1, Math.ceil(visH * draftScale));
      if (draftCanvas.width !== surfaceW || draftCanvas.height !== surfaceH) {
        draftCanvas.width = surfaceW;
        draftCanvas.height = surfaceH;
      }

      draftCtx.resetTransform();
      draftCtx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
      (draftCanvas as any).__draftHasContent = false;
      (draftCanvas as any).__draftCompositeOp = draftCompositeOp;
      (draftCanvas as any).__draftSpace = 'document';
      (draftCanvas as any).__draftDocRect = {
        x: visMinX,
        y: visMinY,
        width: surfaceW / draftScale,
        height: surfaceH / draftScale,
      };
      (draftCanvas as any).__draftScale = draftScale;
      (draftCanvas as any).__draftMonochrome = isMonochrome;
      (draftCanvas as any).__draftVersion = ((draftCanvas as any).__draftVersion || 0) + 1;

      draftCtx.setTransform(draftScale, 0, 0, draftScale, -visMinX * draftScale, -visMinY * draftScale);
      draftCtx.save();
      draftCtx.beginPath();
      draftCtx.rect(0, 0, dims.width, dims.height);
      draftCtx.clip();
      applySelectionCanvasClip(draftCtx, selectionRef.current);

      clearPredictedCanvas();

      if (isTone) {
        let sourceCanvas = layerSourceCanvasesRef?.current?.get(currentLayerId) || null;
        if (!sourceCanvas && canvas) {
          sourceCanvas = document.createElement('canvas');
          sourceCanvas.width = canvas.width;
          sourceCanvas.height = canvas.height;
          const sCtx = get2DContext(sourceCanvas);
          sCtx?.drawImage(canvas, 0, 0);
          layerSourceCanvasesRef?.current?.set(currentLayerId, sourceCanvas);
        }
      }

      if (interactionRef.current) {
        try {
          interactionRef.current.setPointerCapture(e.pointerId);
        } catch {}
      }
      activePointerIdRef.current = e.pointerId;
      isDrawingRef.current = true;

      // Always anchor pointerdown strictly to e.nativeEvent so the stroke begins at the
      // exact center of the brush cursor ring even if Windows/WebView2 stylus drivers emit
      // stale or DPI-offset coalesced packets on pointerdown.
      const firstEvent = e.nativeEvent;
      const rawStartPoint = getCanvasPoint(firstEvent);
      const isAltOverride = e.altKey;
      const startPoint = snapSessionRef.current.snapPoint(rawStartPoint, rulerRef.current, isAltOverride);
      emitConstraintAxisChange(snapSessionRef.current.getActiveAxis());

      const strokeColor = resolveStrokeColor(bs, isEraser, isBgEraser, isMonochrome, mode);
      const strokeHardness = isMonochrome ? 1.0 : (bs.hardness ?? 1.0);
      const strokeFlow = isMonochrome ? 1.0 : (bs.flow ?? 1.0);
      const strokeSpacing = bs.spacing ?? 0.08;

      const pipeline = strokePipelineRef.current;
      pipeline.beginStroke({
        stabilizerLevel: bs.stabilization ?? 0,
        zoom: zoomRef.current || 1.0,
        sharpCorners: bs.sharpCorners !== false,
        brushSize: bs.size,
        color: strokeColor,
        pointerId: e.pointerId,
      });

      const startNow = startPoint.timestamp ?? performance.now();
      lastPointTimeRef.current = startNow;
      const hasCustomCurve = Boolean(bs.pressureCurve && bs.pressureCurve.length > 0);
      const taperEngine = pipeline.getTaperEngine();
      if (bs.usePressure) {
        const baseStartP = hasCustomCurve ? startPoint.pressure : taperEngine.mapPressure(startPoint.pressure);
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
      if (isMonochrome && startPoint.width < 1.25) {
        startPoint.width = 1.25;
      }

      const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
      const blurMargin = (1 - strokeHardness) * (startPoint.width * 1.5);
      const r = Math.max(
        32,
        Math.ceil(Math.max(startPoint.width, bs.size || 10) * (2.8 + scatterFactor * 2) + blurMargin + 32)
      );

      // CSP Shift + Click Straight Line from previous stroke end on the same layer
      const prevStrokeEnd = lastStrokeEndRef.current;
      const isShiftLine =
        Boolean(e.shiftKey) &&
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
        pipeline.seedKnot(pLineStart.x, pLineStart.y, pLineStart.pressure, pLineStart.width, pLineStart.tiltX ?? 0, pLineStart.tiltY ?? 0, pLineStart.twist ?? 0, pLineStart.timestamp ?? 0, r);
        pipeline.seedKnot(pLineMid.x, pLineMid.y, pLineMid.pressure, pLineMid.width, pLineMid.tiltX ?? 0, pLineMid.tiltY ?? 0, pLineMid.twist ?? 0, pLineMid.timestamp ?? 0, r);
      } else {
        allStrokePointsRef.current = [startPoint];
        pipeline.seedKnot(startPoint.x, startPoint.y, startPoint.pressure, startPoint.width, startPoint.tiltX ?? 0, startPoint.tiltY ?? 0, startPoint.twist ?? 0, startNow, r);
      }

      stabilizedPointRef.current = { ...startPoint };
      lastProcessedPointRef.current.x = startPoint.x;
      lastProcessedPointRef.current.y = startPoint.y;
      hasLastProcessedPointRef.current = true;
      lastQueuedPressureRef.current = startPoint.pressure;
      recentPointsTrailRef.current = [{
        x: startPoint.x,
        y: startPoint.y,
        t: startNow,
        pressure: startPoint.pressure,
        width: startPoint.width,
      }];
      strokeTotalDistanceRef.current = isShiftLine && prevStrokeEnd
        ? Math.hypot(startPoint.x - prevStrokeEnd.x, startPoint.y - prevStrokeEnd.y)
        : 0;

      dispatchPointerStat(startPoint.x, startPoint.y, startPoint.pressure);

      const minInitX = isShiftLine && prevStrokeEnd ? Math.min(startPoint.x, prevStrokeEnd.x) : startPoint.x;
      const minInitY = isShiftLine && prevStrokeEnd ? Math.min(startPoint.y, prevStrokeEnd.y) : startPoint.y;
      const maxInitX = isShiftLine && prevStrokeEnd ? Math.max(startPoint.x, prevStrokeEnd.x) : startPoint.x;
      const maxInitY = isShiftLine && prevStrokeEnd ? Math.max(startPoint.y, prevStrokeEnd.y) : startPoint.y;
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

      if (isWetColor && canvas) {
        layerPixelSamplerRef.current = new LayerPixelSampler(
          canvas,
          currentLayerId,
          globalTileGrid
        );
        activeReservoirRef.current = new PaintReservoir(strokeColor);
      } else {
        layerPixelSamplerRef.current = null;
        activeReservoirRef.current = null;
      }

      const strokeId = `stroke-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      currentStrokeIdRef.current = strokeId;
      onCollabStrokeStartRef.current?.(strokeId, currentLayerId, bs, toolRef.current, startPoint);

      liveDabCounterRef.current.count = 0;
      stampRemainderDistRef.current = bs.customTipImage
        ? Math.max(0.15, startPoint.width * (bs.spacing ?? 0.07))
        : isPencil
        ? Math.max(0.25, startPoint.width * (bs.spacing ?? 0.07))
        : Math.max(0.12, startPoint.width * (bs.spacing ?? 0.08));

      const firstDotPoint = allStrokePointsRef.current[0];

      // Draw initial dot strictly onto draftCanvas (GPU instanced batch or Canvas 2D fallback) — ZERO getImageData!
      if (useWireframeEraser) {
        draftCtx.save();
        draftCtx.strokeStyle = 'rgba(255, 80, 80, 0.75)';
        draftCtx.setLineDash([3, 3]);
        draftCtx.lineWidth = Math.max(1, 1.5 / Math.max(0.05, zoomRef.current));
        draftCtx.beginPath();
        draftCtx.arc(firstDotPoint.x, firstDotPoint.y, Math.max(1, firstDotPoint.width / 2), 0, Math.PI * 2);
        draftCtx.stroke();
        draftCtx.restore();
      } else {
        const liveColor = (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;
        const downscaledBinary = (isMonochrome || bs.antiAlias === 0) && draftScale < 0.999;
        const gpuBatch = frameGpuDabsRef.current;
        gpuBatch.length = 0;

        if (bs.customTipImage) {
          const tipOptions = buildLiveTexturedOptions(
            bs,
            isMonochrome ? 1.0 : (bs.flow ?? 1.0),
            strokeSpacing,
            strokeHardness,
            downscaledBinary ? false : isMonochrome,
            canvas,
            activeLayer,
            isEraser,
            isBgEraser,
            true
          );
          if (downscaledBinary && tipOptions.antiAlias === 0) {
            tipOptions.antiAlias = 2;
          }
          const useGpu = canUseWebGlForTexturedBrush(tipOptions);
          drawTexturedDot(draftCtx, firstDotPoint, liveColor, bs.customTipImage, tipOptions, useGpu ? gpuBatch : undefined);
          if (useGpu && gpuBatch.length > 0) {
            if (!flushTexturedGpuDabs(draftCtx, gpuBatch, bs.customTipImage, liveColor, tipOptions)) {
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
            isMonochrome ? 1.0 : (bs.flow ?? 0.74),
            bs.grain ?? 1.0,
            strokeHardness,
            false,
            false
          );
        } else {
          const radialMixingOptions = buildLiveRadialOptions(bs, downscaledBinary ? false : isMonochrome, canvas, activeLayer, true);
          if (downscaledBinary && radialMixingOptions.antiAlias === 0) {
            radialMixingOptions.antiAlias = 2;
          }
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
            if (!flushRadialGpuDabs(draftCtx, gpuBatch, liveColor, strokeHardness, false, false, radialMixingOptions)) {
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
        const lineSeg = pipeline.getSplineGenerator().generateCornerSegment(allStrokePointsRef.current[0], startPoint);
        const downscaledBinary = (isMonochrome || bs.antiAlias === 0) && draftScale < 0.999;
        const liveTipOpts = bs.customTipImage
          ? buildLiveTexturedOptions(bs, isMonochrome ? 1.0 : (bs.flow ?? 1.0), strokeSpacing, strokeHardness, downscaledBinary ? false : isMonochrome, canvas, activeLayer, isEraser, isBgEraser, true)
          : null;
        if (liveTipOpts && downscaledBinary && liveTipOpts.antiAlias === 0) {
          liveTipOpts.antiAlias = 2;
        }
        const liveRadialOpts = !bs.customTipImage && !isPencil
          ? buildLiveRadialOptions(bs, downscaledBinary ? false : isMonochrome, canvas, activeLayer, true)
          : null;
        if (liveRadialOpts && downscaledBinary && liveRadialOpts.antiAlias === 0) {
          liveRadialOpts.antiAlias = 2;
        }
        const useGpuLine =
          !useWireframeEraser &&
          (bs.customTipImage
            ? Boolean(liveTipOpts && canUseWebGlForTexturedBrush(liveTipOpts))
            : (!isPencil && Boolean(liveRadialOpts && canUseWebGlForRadialBrush(liveRadialOpts))));
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
          const liveColor = (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;
          if (bs.customTipImage && liveTipOpts) {
            flushTexturedGpuDabs(draftCtx, gpuBatch, bs.customTipImage, liveColor, liveTipOpts);
          } else if (liveRadialOpts) {
            flushRadialGpuDabs(draftCtx, gpuBatch, liveColor, strokeHardness, false, false, liveRadialOpts);
          }
          gpuBatch.length = 0;
        }
        pipeline.seedKnot(startPoint.x, startPoint.y, startPoint.pressure, startPoint.width, startPoint.tiltX ?? 0, startPoint.tiltY ?? 0, startPoint.twist ?? 0, startNow, r);
      }

      (draftCanvas as any).__draftHasContent = true;
      (draftCanvas as any).__draftVersion = ((draftCanvas as any).__draftVersion || 0) + 1;
      globalTileGrid.notifyChange();
      liveNeedsNotifyRef.current = false;

      if (pipeline.getPendingCount() > 0 && drawRafIdRef.current === null) {
        drawRafIdRef.current = requestAnimationFrame(flushPendingPoints);
      }
    },
    [
      abortActiveStroke,
      buildLiveRadialOptions,
      buildLiveTexturedOptions,
      clearPredictedCanvas,
      disabled,
      dispatchPointerStat,
      effectiveDraftCanvasRef,
      emitConstraintAxisChange,
      emitLiveSegment,
      flushPendingHistoryTasks,
      flushPendingPoints,
      getActiveCanvas,
      getCanvasPoint,
      getViewportRect,
      layerSourceCanvasesRef,
      markTouchedTiles,
      resolveStrokeColor,
      viewportRef,
    ]
  );

  // Pointer Move handler: zero-allocation ingestion of getCoalescedEvents() & getPredictedEvents() into StrokePipeline ring buffer
  const handlePointerMove = useCallback(
    (
      e: React.PointerEvent<HTMLElement>,
      coalescedEvents?: PointerEvent[],
      predictedEvents?: PointerEvent[]
    ) => {
      if (!isDrawingRef.current || e.pointerId !== activePointerIdRef.current) {
        const point = getCanvasPoint(e);
        dispatchPointerStat(point.x, point.y, point.pressure);
        onCollabCursorMoveRef.current?.(point.x, point.y, false, toolRef.current);
        return;
      }

      e.preventDefault();

      const vRect = getViewportRect();
      if (!vRect) return;
      const dims = dimensionsRef.current;

      const candidateCoalesced: PointerEvent[] | readonly PointerEvent[] | null =
        coalescedEvents ??
        (e as any).coalescedEvents ??
        (typeof e.nativeEvent?.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : null);
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
      const ruler = rulerRef.current;
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
          cPressure = (cEvent.buttons & 1) ? 0.5 : 0;
        } else {
          cPressure = cEvent.pressure !== undefined ? Math.max(0, Math.min(1.0, cEvent.pressure)) : 0;
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
        (e as any).predictedEvents ??
        (typeof e.nativeEvent?.getPredictedEvents === 'function' ? e.nativeEvent.getPredictedEvents() : null);

      if (rawPredicted && rawPredicted.length > 0) {
        latestPredictedRef.current = { predEvents: rawPredicted, vRect };
      } else {
        latestPredictedRef.current = null;
      }

      if (hasQueued) {
        dispatchPointerStat(lastQueuedX, lastQueuedY, lastQueuedPressure);
        onCollabCursorMoveRef.current?.(lastQueuedX, lastQueuedY, true, toolRef.current);
      }

      if ((pipeline.getPendingCount() > 0 || latestPredictedRef.current !== null) && drawRafIdRef.current === null) {
        drawRafIdRef.current = requestAnimationFrame(flushPendingPoints);
      }
    },
    [dispatchPointerStat, emitConstraintAxisChange, flushPendingPoints, getCanvasPoint, getViewportRect]
  );

  // Pointer Up / Cancel handler: finalize StrokePipeline, bake dirty rect ONCE into base layer + SparseTileGrid + Undo delta
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
        } catch {}
      }

      // Cancel any pending rAF and flush remaining buffered points synchronously
      if (drawRafIdRef.current !== null) {
        cancelAnimationFrame(drawRafIdRef.current);
        drawRafIdRef.current = null;
      }
      flushPendingPoints();

      const bs = brushSettingsRef.current;
      const endPoint = getCanvasPoint(e);
      const draftCanvas = effectiveDraftCanvasRef?.current;
      const canvas = getActiveCanvas();
      if (canvas) {
        (canvas as any).__isBlank = false;
        (canvas as any).__isSolidWhite = false;
      }

      const currentTool = toolRef.current;
      const currentLayerId = activeLayerIdRef.current;
      const isEraser = currentTool === 'eraser';
      const isBgEraser = isEraser && isBackgroundLayerId(currentLayerId);
      const mode = colorModeRef.current;
      const isPencil = !isEraser && !bs.customTipImage && (bs.preset?.startsWith('pencil') ?? false);

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

      // Seal final Catmull-Rom segment & optional ballistic exit flick taper in StrokePipeline
      let addedFlickPoints = false;
      pipeline.finalizeStroke(e.timeStamp || performance.now(), {
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
          const segPad = Math.ceil(Math.max(seg.p0.width, seg.p3.width, bs.size || 10) * (2.8 + scatterFactor * 2) + 32);
          const tMinX = Math.min(seg.p0.x, seg.c1.x, seg.c2.x, seg.p3.x) - segPad;
          const tMinY = Math.min(seg.p0.y, seg.c1.y, seg.c2.y, seg.p3.y) - segPad;
          const tMaxX = Math.max(seg.p0.x, seg.c1.x, seg.c2.x, seg.p3.x) + segPad;
          const tMaxY = Math.max(seg.p0.y, seg.c1.y, seg.c2.y, seg.p3.y) + segPad;
          pipeline.expandDirtyRectBounds(tMinX, tMinY, tMaxX, tMaxY);
          markTouchedTiles(tMinX, tMinY, tMaxX, tMaxY);
        },
      });

      // Merge pipeline dirtyRect with dirtyRectRef
      const pDirty = pipeline.dirtyRect;
      const mergedDirty = dirtyRectRef.current
        ? {
            minX: Math.min(dirtyRectRef.current.minX, Number.isFinite(pDirty.minX) ? pDirty.minX : dirtyRectRef.current.minX),
            minY: Math.min(dirtyRectRef.current.minY, Number.isFinite(pDirty.minY) ? pDirty.minY : dirtyRectRef.current.minY),
            maxX: Math.max(dirtyRectRef.current.maxX, Number.isFinite(pDirty.maxX) ? pDirty.maxX : dirtyRectRef.current.maxX),
            maxY: Math.max(dirtyRectRef.current.maxY, Number.isFinite(pDirty.maxY) ? pDirty.maxY : dirtyRectRef.current.maxY),
          }
        : (Number.isFinite(pDirty.minX) && Number.isFinite(pDirty.maxX) ? { ...pDirty } : null);

      let exitSpeed = 0;
      if (recentPointsTrailRef.current.length >= 2) {
        const trail = recentPointsTrailRef.current;
        const sampleIdx = Math.max(0, trail.length - 4);
        const pA = trail[sampleIdx];
        const pB = trail[trail.length - 1];
        const dwellMs = Math.max(0, performance.now() - pB.t);
        const dt = Math.max(1, (pB.t - pA.t) + dwellMs);
        exitSpeed = Math.hypot(pB.x - pA.x, pB.y - pA.y) / dt;
      }

      const shouldTaper = Boolean(bs.taper?.useIn) || (Boolean(bs.taper?.useOut) && !addedFlickPoints);
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

      // Track final stroke point for Shift + Click straight line continuation
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

      if (activeLayer?.type === 'vector' && canvas && allPoints.length > 0) {
        const knots: VectorKnot[] = allPoints.map((pt, idx) => ({
          x: pt.x,
          y: pt.y,
          pressure: pt.pressure,
          width: pt.width || Math.max(0.5, (bs.size || 10) * pt.pressure),
          timestamp: Date.now() + idx,
        }));
        const prevStrokes = [...(activeLayer.vectorStrokes || [])];

        if (isEraser) {
          const eraserRadius = Math.max(1, (bs.size || 10) * 0.5);
          const eraserPath = allPoints.map((p) => ({ x: p.x, y: p.y }));
          const eraserResult = applyVectorEraser(eraserPath, eraserRadius, prevStrokes, 'intersection');
          const updatedStrokes = eraserResult.updatedStrokes;
          activeLayer.vectorStrokes = updatedStrokes;

          let minX = mergedDirty ? mergedDirty.minX : 0;
          let minY = mergedDirty ? mergedDirty.minY : 0;
          let maxX = mergedDirty ? mergedDirty.maxX : canvas.width;
          let maxY = mergedDirty ? mergedDirty.maxY : canvas.height;
          for (const st of prevStrokes) {
            if (st.bounds) {
              minX = Math.min(minX, st.bounds.minX);
              minY = Math.min(minY, st.bounds.minY);
              maxX = Math.max(maxX, st.bounds.maxX);
              maxY = Math.max(maxY, st.bounds.maxY);
            }
          }
          const vPad = Math.ceil(Math.max(16, (bs.size || 10)));
          const vx = Math.max(0, Math.floor(minX - vPad));
          const vy = Math.max(0, Math.floor(minY - vPad));
          const vw = Math.max(0, Math.min(canvas.width, Math.ceil(maxX + vPad)) - vx);
          const vh = Math.max(0, Math.min(canvas.height, Math.ceil(maxY + vPad)) - vy);

          const ctx = get2DContext(canvas);
          if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            renderVectorLayer(ctx, updatedStrokes);
            if (vw > 0 && vh > 0) {
              const subData = ctx.getImageData(vx, vy, vw, vh);
              globalTileGrid.writeImageData(
                currentLayerId,
                subData,
                vx,
                vy,
                isMonochrome ? 'monochrome-1bit' : 'color-32bit'
              );
            }
          }

          pushHistoryStep(
            'eraser',
            'Vector Eraser',
            null,
            null,
            currentLayerId,
            vw > 0 && vh > 0 ? { x: vx, y: vy, width: vw, height: vh } : { x: 0, y: 0, width: canvas.width, height: canvas.height },
            undefined,
            { before: prevStrokes, after: updatedStrokes },
            undefined,
            currentStrokeIdRef.current || undefined
          );
        } else {
          const simplifiedKnots = simplifyPathPoints(knots, 0.5);
          const strokeKnots = simplifiedKnots.length >= 2 ? simplifiedKnots : knots;
          const bounds = computeStrokeBounds(strokeKnots);
          const newStroke: VectorStroke = {
            id: currentStrokeIdRef.current || `vec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            layerId: currentLayerId,
            tool: isPencil ? 'pencil' : 'brush',
            knots: strokeKnots,
            color: strokeColor,
            baseWidth: bs.size || 10,
            opacity: bs.opacity ?? 1.0,
            bounds,
          };
          createdVectorStroke = newStroke;

          const updatedStrokes = [...prevStrokes, newStroke];
          activeLayer.vectorStrokes = updatedStrokes;

          const vPad = Math.ceil(Math.max(16, (bs.size || 10)));
          const vx = Math.max(0, Math.floor(bounds.minX - vPad));
          const vy = Math.max(0, Math.floor(bounds.minY - vPad));
          const vw = Math.max(0, Math.min(canvas.width, Math.ceil(bounds.maxX + vPad)) - vx);
          const vh = Math.max(0, Math.min(canvas.height, Math.ceil(bounds.maxY + vPad)) - vy);

          const ctx = get2DContext(canvas);
          if (ctx) {
            renderVectorStroke(ctx, newStroke);
            if (vw > 0 && vh > 0) {
              const subData = ctx.getImageData(vx, vy, vw, vh);
              globalTileGrid.writeImageData(
                currentLayerId,
                subData,
                vx,
                vy,
                isMonochrome ? 'monochrome-1bit' : 'color-32bit'
              );
            }
          }

          pushHistoryStep(
            isPencil ? 'pencil' : 'brush',
            bs.brushName || (isPencil ? 'Vector Pencil' : 'Vector Pen'),
            null,
            null,
            currentLayerId,
            vw > 0 && vh > 0 ? { x: vx, y: vy, width: vw, height: vh } : { x: 0, y: 0, width: canvas.width, height: canvas.height },
            undefined,
            { before: prevStrokes, after: updatedStrokes },
            undefined,
            currentStrokeIdRef.current || undefined
          );
        }
      } else if (canvas && mergedDirty && allPoints.length > 0) {
        const hasWetEdge =
          !isMonochrome &&
          !isEraser &&
          !bs.isTransparentInk &&
          (bs.wetEdge ?? 0) > 0.01;
        const clampedBakeRect = computeClampedBakeDirtyRect(
          mergedDirty,
          canvas.width,
          canvas.height,
          bs.size || 10,
          hasWetEdge ? (bs.wetEdge ?? 0) : 0,
          bs.wetEdgeRadius ?? 3.0
        );

        if (clampedBakeRect) {
          const { x: sx, y: sy, width: dw, height: dh } = clampedBakeRect;
          const ctx = get2DContext(canvas);
          if (ctx) {
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
            const toolForHistory = currentTool === 'eraser' ? 'eraser' : (isPencil ? 'pencil' : 'brush');
            const targetFormat = isMonochrome ? 'monochrome-1bit' : 'color-32bit';
            const effectiveMode: CanvasColorMode = isMonochrome ? 'monochrome' : mode;
            const activeSelection = selectionRef.current;

            if (isMaskModeRef.current) {
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
                renderCompleteStroke(ctx, allPoints, maskBs, maskTool, 'grayscale', false, canvas, false);
              } else {
                ctx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.opacity ?? 1.0));
                ctx.globalCompositeOperation = 'source-over';
                const bakeCanvas = getReusableBakeCanvas(dw, dh);
                const bCtx = bakeCanvas.getContext('2d', { alpha: true });
                if (bCtx) {
                  bCtx.clearRect(0, 0, dw, dh);
                  bCtx.save();
                  bCtx.translate(-sx, -sy);
                  renderCompleteStroke(bCtx, allPoints, { ...maskBs, opacity: 1.0 }, maskTool, 'grayscale', false, canvas, false);
                  bCtx.restore();
                  ctx.drawImage(bakeCanvas, 0, 0, dw, dh, sx, sy, dw, dh);
                }
              }
              ctx.restore();

              const afterMaskData = ctx.getImageData(sx, sy, dw, dh);
              if (activeSelection?.mask) {
                applySelectionMaskToImageData(beforeMaskData, afterMaskData, sx, sy, activeSelection);
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
                  undefined,
                  true
                );
              });
            } else if (isToneLayer && sourceCanvas) {
              if (!globalTileGrid.isLayerIngested(currentLayerId)) {
                globalTileGrid.ingestCanvas(currentLayerId, sourceCanvas, targetFormat);
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
                  renderCompleteStroke(sCtx, allPoints, bs, currentTool, effectiveMode, isBgEraser, sourceCanvas, Boolean(activeLayer?.alphaLocked));
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
                      { ...bs, opacity: 1.0, isTransparentInk: false, color: isEraser && !isBgEraser ? '#000000' : bs.color },
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

              const beforeSnapshot = globalTileGrid.snapshotTilesInRect(currentLayerId, dirtyRect);
              const afterData = sCtx ? sCtx.getImageData(sx, sy, dw, dh) : null;
              if (afterData && beforeSelectionData && activeSelection?.mask && sCtx) {
                applySelectionMaskToImageData(beforeSelectionData, afterData, sx, sy, activeSelection);
                sCtx.putImageData(afterData, sx, sy);
              }

              if (activeLayer) {
                const freq = activeLayer?.toneFrequency ?? 60;
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
                globalTileGrid.writeImageData(currentLayerId, afterData, sx, sy, targetFormat);
              }
              const tileDeltas = globalTileGrid.computeDeltasFromSnapshot(beforeSnapshot, currentLayerId, dirtyRect);

              enqueueHistoryTask(() => {
                pushHistoryStep(toolForHistory, label, null, null, currentLayerId, dirtyRect, tileDeltas);
              });
            } else {
              // Standard raster bake (single pointerup bake + SparseTileGrid write + Undo TileDelta)
              if (!globalTileGrid.isLayerIngested(currentLayerId)) {
                globalTileGrid.ingestCanvas(currentLayerId, canvas, targetFormat);
              }

              const beforeSelectionData =
                activeSelection?.mask ? ctx.getImageData(sx, sy, dw, dh) : null;

              ctx.save();
              ctx.beginPath();
              ctx.rect(sx, sy, dw, dh);
              ctx.clip();
              applySelectionCanvasClip(ctx, activeSelection);

              const needsIsolatedBake = (bs.opacity ?? 1.0) < 0.999 || hasWetEdge;

              if (!needsIsolatedBake) {
                renderCompleteStroke(ctx, allPoints, bs, currentTool, effectiveMode, isBgEraser, canvas, Boolean(activeLayer?.alphaLocked));
              } else {
                ctx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.opacity ?? 1.0));
                if ((isEraser && !isBgEraser) || bs.isTransparentInk) {
                  ctx.globalCompositeOperation = 'destination-out';
                } else if (activeLayer?.alphaLocked) {
                  ctx.globalCompositeOperation = 'source-atop';
                } else {
                  ctx.globalCompositeOperation = 'source-over';
                }
                const bakeCanvas = getReusableBakeCanvas(dw, dh);
                const bCtx = bakeCanvas.getContext('2d', { alpha: true, willReadFrequently: hasWetEdge });
                if (bCtx) {
                  bCtx.clearRect(0, 0, dw, dh);
                  bCtx.save();
                  bCtx.translate(-sx, -sy);
                  renderCompleteStroke(
                    bCtx,
                    allPoints,
                    {
                      ...bs,
                      opacity: 1.0,
                      isTransparentInk: false,
                      wetEdge: 0,
                      color: isEraser && !isBgEraser ? '#000000' : bs.color,
                    },
                    isEraser && !isBgEraser ? 'brush' : currentTool,
                    effectiveMode,
                    isBgEraser,
                    canvas,
                    false
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

                  ctx.drawImage(bakeCanvas, 0, 0, dw, dh, sx, sy, dw, dh);
                }
              }

              ctx.restore();

              if (beforeSelectionData && activeSelection?.mask) {
                const fullAfter = ctx.getImageData(sx, sy, dw, dh);
                applySelectionMaskToImageData(beforeSelectionData, fullAfter, sx, sy, activeSelection);
                ctx.putImageData(fullAfter, sx, sy);
              }

              const useSparseTileSpans = dw * dh > 512 * 512 && touchedTilesRef.current.size > 0;
              if (useSparseTileSpans) {
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
                  for (let i = 1; i < txList.length; i++) {
                    if (txList[i] <= spanEnd + 1) {
                      spanEnd = txList[i];
                    } else {
                      const rx = Math.max(0, spanStart * TILE_SIZE);
                      const ry = Math.max(0, ty * TILE_SIZE);
                      const rw = Math.min(canvas.width, (spanEnd + 1) * TILE_SIZE) - rx;
                      const rh = Math.min(canvas.height, (ty + 1) * TILE_SIZE) - ry;
                      if (rw > 0 && rh > 0) spans.push({ x: rx, y: ry, width: rw, height: rh });
                      spanStart = txList[i];
                      spanEnd = txList[i];
                    }
                  }
                  const rx = Math.max(0, spanStart * TILE_SIZE);
                  const ry = Math.max(0, ty * TILE_SIZE);
                  const rw = Math.min(canvas.width, (spanEnd + 1) * TILE_SIZE) - rx;
                  const rh = Math.min(canvas.height, (ty + 1) * TILE_SIZE) - ry;
                  if (rw > 0 && rh > 0) spans.push({ x: rx, y: ry, width: rw, height: rh });
                }

                const beforeSnapshot = new Map<string, { format: TileFormat; data: Uint8Array | null }>();
                for (let i = 0; i < spans.length; i++) {
                  const sp = spans[i];
                  const subSnap = globalTileGrid.snapshotTilesInRect(currentLayerId, sp);
                  for (const [k, v] of subSnap) {
                    if (!beforeSnapshot.has(k)) beforeSnapshot.set(k, v);
                  }
                  const spanData = ctx.getImageData(sp.x, sp.y, sp.width, sp.height);
                  if (isMonochrome) {
                    binarizeImageDataBuffer(
                      spanData,
                      activeLayer?.monoThreshold ?? 128,
                      activeLayer?.monoExpressBlack ?? true,
                      activeLayer?.monoExpressWhite ?? true
                    );
                    ctx.putImageData(spanData, sp.x, sp.y);
                  }
                  globalTileGrid.writeImageData(currentLayerId, spanData, sp.x, sp.y, targetFormat, true);
                }

                if (layerSourceCanvasesRef?.current?.has(currentLayerId)) {
                  const existingSource = layerSourceCanvasesRef.current.get(currentLayerId);
                  if (existingSource) {
                    const sCtx = get2DContext(existingSource);
                    if (sCtx) {
                      for (let i = 0; i < spans.length; i++) {
                        const sp = spans[i];
                        sCtx.clearRect(sp.x, sp.y, sp.width, sp.height);
                        sCtx.drawImage(canvas, sp.x, sp.y, sp.width, sp.height, sp.x, sp.y, sp.width, sp.height);
                      }
                    }
                  }
                }

                const tileDeltas = globalTileGrid.computeDeltasFromSnapshot(beforeSnapshot, currentLayerId);
                enqueueHistoryTask(() => {
                  pushHistoryStep(toolForHistory, label, null, null, currentLayerId, dirtyRect, tileDeltas);
                });
              } else {
                const beforeSnapshot = globalTileGrid.snapshotTilesInRect(currentLayerId, dirtyRect);
                const afterData = ctx.getImageData(sx, sy, dw, dh);
                if (isMonochrome) {
                  binarizeImageDataBuffer(
                    afterData,
                    activeLayer?.monoThreshold ?? 128,
                    activeLayer?.monoExpressBlack ?? true,
                    activeLayer?.monoExpressWhite ?? true
                  );
                  ctx.putImageData(afterData, sx, sy);
                }

                if (layerSourceCanvasesRef?.current?.has(currentLayerId)) {
                  const existingSource = layerSourceCanvasesRef.current.get(currentLayerId);
                  if (existingSource) {
                    const sCtx = get2DContext(existingSource);
                    if (sCtx) {
                      sCtx.clearRect(sx, sy, dw, dh);
                      sCtx.drawImage(canvas, sx, sy, dw, dh, sx, sy, dw, dh);
                    }
                  }
                }

                globalTileGrid.writeImageData(currentLayerId, afterData, sx, sy, targetFormat);
                const tileDeltas = globalTileGrid.computeDeltasFromSnapshot(beforeSnapshot, currentLayerId, dirtyRect);

                enqueueHistoryTask(() => {
                  pushHistoryStep(toolForHistory, label, null, null, currentLayerId, dirtyRect, tileDeltas);
                });
              }
            }
          }
        }
      }

      // Clear draft overlay BEFORE synchronous tile grid notification so in-stack compositor
      // swaps from live draft to committed tiles in a single atomic frame (zero double-alpha flash!)
      if (clearDraftRafRef.current !== null) {
        cancelAnimationFrame(clearDraftRafRef.current);
        clearDraftRafRef.current = null;
      }
      if (draftCanvas) {
        const dCtx = get2DContext(draftCanvas);
        if (dCtx) {
          try {
            dCtx.restore();
          } catch (_) {}
          dCtx.resetTransform();
          dCtx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
        }
        (draftCanvas as any).__draftHasContent = false;
        (draftCanvas as any).__draftCompositeOp = 'source-over';
        (draftCanvas as any).__draftMonochrome = false;
        (draftCanvas as any).__draftVersion = ((draftCanvas as any).__draftVersion || 0) + 1;
      }
      clearPredictedCanvas();

      globalTileGrid.notifyChange(true);

      if (currentStrokeIdRef.current) {
        onCollabStrokeFinishRef.current?.(
          currentStrokeIdRef.current,
          currentLayerId,
          endPoint,
          mergedDirty ? {
            x: Math.max(0, Math.floor(mergedDirty.minX)),
            y: Math.max(0, Math.floor(mergedDirty.minY)),
            width: Math.max(1, Math.ceil(mergedDirty.maxX) - Math.max(0, Math.floor(mergedDirty.minX))),
            height: Math.max(1, Math.ceil(mergedDirty.maxY) - Math.max(0, Math.floor(mergedDirty.minY))),
          } : undefined,
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
        globalTileGrid.notifyChange(true);
      } else {
        enqueueHistoryTask(() => {
          onUpdateLayerThumbnail(currentLayerId);
        });
      }
    },
    [
      clearPredictedCanvas,
      effectiveDraftCanvasRef,
      emitConstraintAxisChange,
      enqueueHistoryTask,
      flushPendingPoints,
      getActiveCanvas,
      getCanvasPoint,
      layerSourceCanvasesRef,
      markTouchedTiles,
      onUpdateLayerThumbnail,
      pushHistoryStep,
      resolveStrokeColor,
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
  }, [dispatchPointerStat]);

  const resetHistory = useCallback(() => {
    historyRef.current = [];
    historyIndexRef.current = -1;
    lastStrokeEndRef.current = null;
    setHistoryList([]);
    setHistoryIndex(-1);
    setCanUndo(false);
    setCanRedo(false);
    globalUndoCache.clearCache().catch(() => {});

    // Re-seed initial history state after DOM canvas updates without heavy getImageData readback
    setTimeout(() => {
      const canvas = layerCanvasesRef.current.get(activeLayerId) || layerCanvasesRef.current.values().next().value;
      if (!canvas) return;

      const thumbnail = createCanvasThumbnail(canvas, !isBackgroundLayerId(activeLayerId));
      const now = Date.now();

      const initialItem: HistoryItem = {
        id: `hist-init-${now}`,
        type: 'initial',
        label: 'New Document',
        timestamp: now,
        timeFormatted: formatTime(now),
        thumbnailUrl: thumbnail,
        imageData: undefined,
        beforeImageData: null,
        afterImageData: null,
        layerId: activeLayerId,
      };

      historyRef.current = [initialItem];
      historyIndexRef.current = 0;
      syncHistoryState();
    }, 60);
  }, [activeLayerId, layerCanvasesRef, syncHistoryState]);

  return {
    interactionRef,
    isDrawingRef,
    getActiveCanvas,
    pushHistoryStep,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerEnter,
    handlePointerLeave,
    undo,
    redo,
    canUndo,
    canRedo,
    historyList,
    historyIndex,
    jumpToHistoryIndex,
    clearCanvas,
    resetHistory,
    selectiveUndo,
    cursorPos: null as { x: number; y: number } | null,
    currentPressure: 0,
    isHovering: false,
  };
}
