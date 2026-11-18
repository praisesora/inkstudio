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
  catmullRomToBezier,
  drawDot,
  screenToCanvas,
  getCanvasToViewportMatrix,
  createCanvasThumbnail,
  formatTime,
  get2DContext,
  getReusableBakeCanvas,
  renderCompleteStroke,
  applyParametricTaper,
} from '../utils/canvasUtils';
import { InputStabilizer } from '../engine/InputStabilizer';
import { TaperEngine } from '../engine/TaperEngine';
import { applyCspWatercolorEdge } from '../engine/CspBrushEngine';
import { enforceColorMode, binarizeImageDataBuffer } from '../utils/colorUtils';
import { drawPencilCubicBezierSegment, drawPencilDot, PencilGrade } from '../utils/pencilEngine';
import {
  drawTexturedCubicBezierSegment,
  drawTexturedDot,
  TexturedBrushOptions,
  RadialMixingOptions,
} from '../utils/stampEngine';
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
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  const rotationRef = useRef(rotation);
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

  // Synchronously keep refs fresh during render execution
  panRef.current = pan;
  zoomRef.current = zoom;
  rotationRef.current = rotation;
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
    panRef.current = pan;
    zoomRef.current = zoom;
    rotationRef.current = rotation;
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

  // Full sequence of points for baking onto the high-resolution canvas on pointerup
  const allStrokePointsRef = useRef<Point[]>([]);

  // Sliding window of points for real-time Bézier smoothing on the draft overlay canvas
  const strokePointsRef = useRef<Point[]>([]);

  // Raw points window buffer for symmetric Gaussian FIR stabilization
  const rawPointsBufferRef = useRef<{ x: number; y: number; pressure: number; pointerType: string; tiltX?: number; tiltY?: number; twist?: number; timestamp?: number }[]>([]);

  // Stabilizer tracking ref
  const stabilizedPointRef = useRef<Point | null>(null);
  const inputStabilizerRef = useRef(new InputStabilizer());
  const taperEngineRef = useRef(new TaperEngine());

  // Distance accumulator for textured brush dab stepping
  const stampRemainderDistRef = useRef<number>(0);
  const liveDabCounterRef = useRef<{ count: number }>({ count: 0 });

  // Active color mixing reservoir and pre-stroke backup canvas for real-time wet blending/smudging
  const activeReservoirRef = useRef<PaintReservoir | null>(null);
  const layerPixelSamplerRef = useRef<LayerPixelSampler | null>(null);
  const strokeBackupCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const isWetColorStrokeRef = useRef<boolean>(false);
  const drewDirectlyOnLayerCanvasRef = useRef<boolean>(false);
  const liveStrokeIsolationRef = useRef<boolean>(false);
  const liveAccumCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const liveOrigCanvasTilesRef = useRef<Map<number, ImageData>>(new Map());
  const liveBeforeTileSnapshotRef = useRef<Map<string, { format: TileFormat; data: Uint8Array | null }>>(new Map());
  const liveNeedsNotifyRef = useRef<boolean>(false);
  const lastStrokeEndRef = useRef<{ x: number; y: number; pressure: number; width: number; layerId: string } | null>(null);
  const isShiftLineStrokeRef = useRef<boolean>(false);
  const historyQueueRef = useRef<Promise<void>>(Promise.resolve());
  const lastPointTimeRef = useRef<number>(0);
  const recentPointsTrailRef = useRef<{ x: number; y: number; t: number; pressure: number; width: number }[]>([]);
  const strokeTotalDistanceRef = useRef<number>(0);

  // Dirty bounding box for the active stroke
  const dirtyRectRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);
  const touchedTilesRef = useRef<Set<number>>(new Set());
  const lastProcessedPointRef = useRef<{ x: number; y: number } | null>(null);

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

  // Queue of incoming pointer coordinates to be batched and processed via requestAnimationFrame (rAF)
  const pendingPointsQueueRef = useRef<{ x: number; y: number; pressure: number; pointerType: string; tiltX?: number; tiltY?: number; twist?: number; timestamp?: number }[]>([]);
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
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && viewportRef.current) {
      ro = new ResizeObserver(handleResize);
      ro.observe(viewportRef.current);
    }
    return () => {
      window.removeEventListener('resize', handleResize);
      ro?.disconnect();
      if (clearDraftRafRef.current !== null) {
        cancelAnimationFrame(clearDraftRafRef.current);
      }
      if (drawRafIdRef.current !== null) {
        cancelAnimationFrame(drawRafIdRef.current);
      }
    };
  }, [viewportRef]);

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
        const targetH = Math.max(38, Math.round((canvas.height / Math.max(1, canvas.width)) * 60));
        item.thumbnailUrl = isLarge
          ? globalTileGrid.generateThumbnail(targetLayerId, 60, targetH, { width: canvas.width, height: canvas.height })
          : createCanvasThumbnail(canvas, !isBackgroundLayerId(targetLayerId));
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
          idleCallbackIdRef.current = (window as any).requestIdleCallback(runTasks, { timeout: 250 });
        } else {
          idleCallbackIdRef.current = setTimeout(runTasks, 32);
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

  // Helper to restore all live-backed-up tiles back onto a layer canvas
  const restoreLiveOrigTilesToCanvas = useCallback((canvas: HTMLCanvasElement) => {
    if (liveOrigCanvasTilesRef.current.size === 0) return;
    const cCtx = get2DContext(canvas);
    if (!cCtx) return;
    for (const [numKey, tileImg] of liveOrigCanvasTilesRef.current) {
      const ty = Math.floor(numKey / 65536);
      const tx = numKey % 65536;
      cCtx.putImageData(tileImg, tx * TILE_SIZE, ty * TILE_SIZE);
    }
  }, []);

  // Helper to restore a specific sub-rectangle on `canvasCtx` from `liveOrigCanvasTilesRef`
  const restoreLiveRectFromOrigTiles = useCallback(
    (canvasCtx: CanvasRenderingContext2D, rx: number, ry: number, rw: number, rh: number) => {
      if (rw <= 0 || rh <= 0 || liveOrigCanvasTilesRef.current.size === 0) return;
      const minTx = rx >> 8;
      const minTy = ry >> 8;
      const maxTx = (rx + rw - 1) >> 8;
      const maxTy = (ry + rh - 1) >> 8;
      for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          const tileImg = liveOrigCanvasTilesRef.current.get(ty * 65536 + tx);
          if (!tileImg) continue;
          const tileOriginX = tx * TILE_SIZE;
          const tileOriginY = ty * TILE_SIZE;
          const ix0 = Math.max(rx, tileOriginX);
          const iy0 = Math.max(ry, tileOriginY);
          const ix1 = Math.min(rx + rw, tileOriginX + tileImg.width);
          const iy1 = Math.min(ry + rh, tileOriginY + tileImg.height);
          if (ix1 > ix0 && iy1 > iy0) {
            canvasCtx.putImageData(
              tileImg,
              tileOriginX,
              tileOriginY,
              ix0 - tileOriginX,
              iy0 - tileOriginY,
              ix1 - ix0,
              iy1 - iy0
            );
          }
        }
      }
    },
    []
  );

  // Lazily snapshot pre-stroke tiles in both SparseTileGrid and canvas ImageData before live mutation
  const ensureLiveTileSnapshots = useCallback(
    (
      canvas: HTMLCanvasElement,
      canvasCtx: CanvasRenderingContext2D,
      layerId: string,
      minX: number,
      minY: number,
      maxX: number,
      maxY: number
    ) => {
      const cMinX = Math.max(0, Math.floor(minX));
      const cMinY = Math.max(0, Math.floor(minY));
      const cMaxX = Math.min(canvas.width, Math.ceil(maxX));
      const cMaxY = Math.min(canvas.height, Math.ceil(maxY));
      if (cMaxX <= cMinX || cMaxY <= cMinY) return;

      const minTx = cMinX >> 8;
      const minTy = cMinY >> 8;
      const maxTx = (cMaxX - 1) >> 8;
      const maxTy = (cMaxY - 1) >> 8;

      for (let ty = minTy; ty <= maxTy; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          const numKey = ty * 65536 + tx;
          touchedTilesRef.current.add(numKey);
          if (!liveOrigCanvasTilesRef.current.has(numKey)) {
            const ox = tx * TILE_SIZE;
            const oy = ty * TILE_SIZE;
            const tw = Math.min(TILE_SIZE, canvas.width - ox);
            const th = Math.min(TILE_SIZE, canvas.height - oy);
            if (tw <= 0 || th <= 0) continue;
            const origImg = canvasCtx.getImageData(ox, oy, tw, th);
            liveOrigCanvasTilesRef.current.set(numKey, origImg);
            if (!globalTileGrid.isLayerIngested(layerId) && !globalTileGrid.getTile(layerId, tx, ty, 0)) {
              const activeLayer = layersRef.current?.find((l) => l.id === layerId);
              const isMono =
                !isBackgroundLayerId(layerId) &&
                (colorModeRef.current === 'monochrome' || activeLayer?.expressionColor === 'monochrome');
              globalTileGrid.writeImageData(
                layerId,
                origImg,
                ox,
                oy,
                isMono ? 'monochrome-1bit' : 'color-32bit',
                true
              );
            }
            const subSnap = globalTileGrid.snapshotTilesInRect(layerId, {
              x: ox,
              y: oy,
              width: tw,
              height: th,
            });
            for (const [k, v] of subSnap) {
              if (!liveBeforeTileSnapshotRef.current.has(k)) {
                liveBeforeTileSnapshotRef.current.set(k, v);
              }
            }
          }
        }
      }
    },
    []
  );

  // Sync a small mutated region of `canvas` into `globalTileGrid` during Live WYSIWYG preview
  const syncLiveRegionToTiles = useCallback(
    (
      canvas: HTMLCanvasElement,
      canvasCtx: CanvasRenderingContext2D,
      layerId: string,
      minX: number,
      minY: number,
      maxX: number,
      maxY: number,
      isMonochrome: boolean,
      activeLayer: LayerItem | undefined,
      bs: BrushSettings,
      isEraser: boolean,
      isBgEraser: boolean
    ) => {
      const rx = Math.max(0, Math.floor(minX));
      const ry = Math.max(0, Math.floor(minY));
      const rw = Math.min(canvas.width, Math.ceil(maxX)) - rx;
      const rh = Math.min(canvas.height, Math.ceil(maxY)) - ry;
      if (rw <= 0 || rh <= 0) return;

      ensureLiveTileSnapshots(canvas, canvasCtx, layerId, rx, ry, rx + rw, ry + rh);

      if (liveStrokeIsolationRef.current && liveAccumCanvasRef.current) {
        restoreLiveRectFromOrigTiles(canvasCtx, rx, ry, rw, rh);
        canvasCtx.save();
        canvasCtx.beginPath();
        canvasCtx.rect(rx, ry, rw, rh);
        canvasCtx.clip();
        applySelectionCanvasClip(canvasCtx, selectionRef.current);
        canvasCtx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.opacity ?? 1.0));
        if ((isEraser && !isBgEraser) || bs.isTransparentInk) {
          canvasCtx.globalCompositeOperation = 'destination-out';
        } else if (activeLayer?.alphaLocked) {
          canvasCtx.globalCompositeOperation = 'source-atop';
        } else {
          canvasCtx.globalCompositeOperation = 'source-over';
        }
        canvasCtx.drawImage(liveAccumCanvasRef.current, rx, ry, rw, rh, rx, ry, rw, rh);
        canvasCtx.restore();
      }

      const segData = canvasCtx.getImageData(rx, ry, rw, rh);
      if (selectionRef.current?.mask) {
        // Reconstruct before pixels for exact 8-bit selection mask blending
        restoreLiveRectFromOrigTiles(canvasCtx, rx, ry, rw, rh);
        const beforeSub = canvasCtx.getImageData(rx, ry, rw, rh);
        applySelectionMaskToImageData(beforeSub, segData, rx, ry, selectionRef.current);
        canvasCtx.putImageData(segData, rx, ry);
      }

      if (isMonochrome) {
        binarizeImageDataBuffer(
          segData,
          activeLayer?.monoThreshold ?? 128,
          activeLayer?.monoExpressBlack ?? true,
          activeLayer?.monoExpressWhite ?? true
        );
        canvasCtx.putImageData(segData, rx, ry);
      }

      globalTileGrid.writeImageData(
        layerId,
        segData,
        rx,
        ry,
        isMonochrome ? 'monochrome-1bit' : 'color-32bit',
        true
      );
      liveNeedsNotifyRef.current = true;
    },
    [ensureLiveTileSnapshots, restoreLiveRectFromOrigTiles]
  );

  // Abort any in-progress stroke session immediately
  const abortActiveStroke = useCallback(() => {
    if (!isDrawingRef.current) return;
    if (drawRafIdRef.current !== null) {
      cancelAnimationFrame(drawRafIdRef.current);
      drawRafIdRef.current = null;
    }
    const draftCanvas = effectiveDraftCanvasRef?.current;
    if (draftCanvas) {
      const dCtx = get2DContext(draftCanvas);
      if (dCtx) {
        try {
          dCtx.restore();
        } catch (_) {}
        dCtx.resetTransform();
        dCtx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
      }
    }
    clearPredictedCanvas();
    if (drewDirectlyOnLayerCanvasRef.current) {
      const currentLayerId = activeLayerIdRef.current;
      const canvas = layerCanvasesRef.current.get(currentLayerId) || getActiveCanvas();
      if (canvas) {
        restoreLiveOrigTilesToCanvas(canvas);
        const cCtx = get2DContext(canvas);
        if (cCtx) {
          const activeLayer = layersRef.current?.find((l) => l.id === currentLayerId);
          const isMono =
            !isBackgroundLayerId(currentLayerId) &&
            (colorModeRef.current === 'monochrome' || activeLayer?.expressionColor === 'monochrome');
          for (const [numKey, tileImg] of liveOrigCanvasTilesRef.current) {
            const ty = Math.floor(numKey / 65536);
            const tx = numKey % 65536;
            globalTileGrid.writeImageData(
              currentLayerId,
              tileImg,
              tx * TILE_SIZE,
              ty * TILE_SIZE,
              isMono ? 'monochrome-1bit' : 'color-32bit',
              true
            );
          }
          globalTileGrid.notifyChange(true);
        }
      }
    }
    isDrawingRef.current = false;
    activePointerIdRef.current = null;
    allStrokePointsRef.current = [];
    strokePointsRef.current = [];
    stabilizedPointRef.current = null;
    lastProcessedPointRef.current = null;
    dirtyRectRef.current = null;
    touchedTilesRef.current.clear();
    pendingPointsQueueRef.current = [];
    drewDirectlyOnLayerCanvasRef.current = false;
    liveStrokeIsolationRef.current = false;
    liveOrigCanvasTilesRef.current.clear();
    liveBeforeTileSnapshotRef.current.clear();
    liveNeedsNotifyRef.current = false;
    isShiftLineStrokeRef.current = false;
    isToneStrokeRef.current = false;
    strokeBackupCanvasRef.current = null;
    layerPixelSamplerRef.current = null;
    activeReservoirRef.current = null;
    snapSessionRef.current.endStroke();
    emitConstraintAxisChange(null);
  }, [clearPredictedCanvas, effectiveDraftCanvasRef, emitConstraintAxisChange, getActiveCanvas, layerCanvasesRef, restoreLiveOrigTilesToCanvas]);

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
        dims
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
      useGpu: bs.useGpu,
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
      useGpu: bs.useGpu,
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

  // Render a single smooth segment onto either Live Direct Layer/Tile preview or the viewport draft overlay
  const renderDraftSegment = useCallback((draftCtx: CanvasRenderingContext2D, point: Point) => {
    const pts = strokePointsRef.current;

    const isEraser = toolRef.current === 'eraser';
    const isBgEraser = isEraser && isBackgroundLayerId(activeLayerIdRef.current);
    const bs = brushSettingsRef.current;
    const mode = colorModeRef.current;
    const isPencil = !isEraser && !bs.customTipImage && (bs.preset?.startsWith('pencil') ?? false);
    const canvas = getActiveCanvas();
    const currentLayerId = activeLayerIdRef.current;
    const activeLayer = layersRef.current?.find((l) => l.id === currentLayerId);
    const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
    const isMonochrome = mode === 'monochrome' || isMonoLayer;

    let strokeColor: string;
    if (isMaskModeRef.current) {
      if (isEraser) {
        strokeColor = '#000000';
      } else {
        let clean = bs.color.replace('#', '');
        if (clean.length === 3) clean = clean.split('').map((c) => c + c).join('');
        const r = parseInt(clean.slice(0, 2), 16) || 0;
        const g = parseInt(clean.slice(2, 4), 16) || 0;
        const b = parseInt(clean.slice(4, 6), 16) || 0;
        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        const hexVal = gray.toString(16).padStart(2, '0');
        strokeColor = `#${hexVal}${hexVal}${hexVal}`;
      }
    } else {
      strokeColor = isBgEraser ? '#ffffff' : enforceColorMode(bs.color, isMonochrome ? 'monochrome' : mode);
    }
    const strokeHardness = isMonochrome ? 1.0 : (bs.hardness ?? 1.0);
    const strokeFlow = isMonochrome ? 1.0 : (bs.flow ?? 1.0);
    const strokeSpacing = bs.spacing ?? 0.08;

    const renderSegmentToContext = (
      ctx: CanvasRenderingContext2D,
      sStart: Point,
      c1Pt: Point,
      c2Pt: Point,
      sEnd: Point,
      isolatedPass: boolean = false
    ): number => {
      if (bs.customTipImage) {
        const tipOptions = buildLiveTexturedOptions(
          bs,
          bs.flow ?? 0.85,
          bs.spacing ?? 0.08,
          strokeHardness,
          isMonochrome,
          canvas,
          activeLayer,
          isEraser,
          isBgEraser,
          isolatedPass
        );
        return drawTexturedCubicBezierSegment(
          ctx,
          sStart,
          c1Pt,
          c2Pt,
          sEnd,
          isolatedPass && isEraser && !isBgEraser ? '#000000' : strokeColor,
          bs.customTipImage,
          tipOptions,
          stampRemainderDistRef.current,
          liveDabCounterRef.current
        );
      } else if (isPencil) {
        const grade = (bs.preset as PencilGrade) || 'pencil-2b';
        return drawPencilCubicBezierSegment(
          ctx,
          sStart,
          c1Pt,
          c2Pt,
          sEnd,
          strokeColor,
          grade,
          isMonochrome ? 1.0 : (bs.flow ?? 0.74),
          bs.grain ?? 1.0,
          strokeHardness,
          stampRemainderDistRef.current,
          isolatedPass ? false : Boolean(activeLayer?.alphaLocked),
          isolatedPass ? false : Boolean(bs.isTransparentInk),
          bs.useTilt ?? true
        );
      } else {
        const radialMixingOptions = buildLiveRadialOptions(
          bs,
          isMonochrome,
          canvas,
          activeLayer,
          isolatedPass
        );
        return drawSmoothCubicBezierSegment(
          ctx,
          sStart,
          c1Pt,
          c2Pt,
          sEnd,
          isolatedPass && isEraser && !isBgEraser ? '#000000' : strokeColor,
          isolatedPass ? false : isEraser && !isBgEraser,
          strokeHardness,
          strokeFlow,
          strokeSpacing,
          stampRemainderDistRef.current,
          bs.thickness ?? 1.0,
          ((bs.customTipAngle ?? 0) * Math.PI) / 180,
          radialMixingOptions
        );
      }
    };

    pts.push(point);

    if (pts.length < 3) {
      return;
    }

    let k0: Point, k1: Point, k2: Point, k3: Point;
    if (pts.length === 3) {
      k0 = pts[0];
      k1 = pts[0];
      k2 = pts[1];
      k3 = pts[2];
    } else {
      const n = pts.length;
      k0 = pts[n - 4];
      k1 = pts[n - 3];
      k2 = pts[n - 2];
      k3 = pts[n - 1];
    }

    if (pts.length > 5) {
      pts.shift();
    }

    const { c1, c2 } = catmullRomToBezier(k0, k1, k2, k3);
    const segStart = k1;
    const segEnd = k2;

    const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
    const segPad = Math.ceil(Math.max(segStart.width, segEnd.width, bs.size || 10) * (2.8 + scatterFactor * 2) + 32);
    const segMinX = Math.min(segStart.x, c1.x, c2.x, segEnd.x) - segPad;
    const segMinY = Math.min(segStart.y, c1.y, c2.y, segEnd.y) - segPad;
    const segMaxX = Math.max(segStart.x, c1.x, c2.x, segEnd.x) + segPad;
    const segMaxY = Math.max(segStart.y, c1.y, c2.y, segEnd.y) + segPad;
    if (dirtyRectRef.current) {
      const docW = canvas ? canvas.width : dimensionsRef.current.width;
      const docH = canvas ? canvas.height : dimensionsRef.current.height;
      dirtyRectRef.current.minX = Math.min(dirtyRectRef.current.minX, Math.max(0, Math.floor(segMinX)));
      dirtyRectRef.current.minY = Math.min(dirtyRectRef.current.minY, Math.max(0, Math.floor(segMinY)));
      dirtyRectRef.current.maxX = Math.max(dirtyRectRef.current.maxX, Math.min(docW, Math.ceil(segMaxX)));
      dirtyRectRef.current.maxY = Math.max(dirtyRectRef.current.maxY, Math.min(docH, Math.ceil(segMaxY)));
    }
    markTouchedTiles(segMinX, segMinY, segMaxX, segMaxY);

    // Live WYSIWYG Direct Layer/Tile Preview (Eraser, Transparent Ink, Alpha Lock, Color Mixing, Translucent, Clipped, Blend, Under-Layer)
    if (drewDirectlyOnLayerCanvasRef.current && canvas) {
      const canvasCtx = get2DContext(canvas);
      if (canvasCtx) {
        ensureLiveTileSnapshots(canvas, canvasCtx, currentLayerId, segMinX, segMinY, segMaxX, segMaxY);
        const clipRx = Math.max(0, Math.floor(segMinX));
        const clipRy = Math.max(0, Math.floor(segMinY));
        const clipRw = Math.min(canvas.width, Math.ceil(segMaxX)) - clipRx;
        const clipRh = Math.min(canvas.height, Math.ceil(segMaxY)) - clipRy;
        if (liveStrokeIsolationRef.current && liveAccumCanvasRef.current) {
          const accumCtx = get2DContext(liveAccumCanvasRef.current);
          if (accumCtx) {
            accumCtx.save();
            if (clipRw > 0 && clipRh > 0) {
              accumCtx.beginPath();
              accumCtx.rect(clipRx, clipRy, clipRw, clipRh);
              accumCtx.clip();
            }
            applySelectionCanvasClip(accumCtx, selectionRef.current);
            stampRemainderDistRef.current = renderSegmentToContext(accumCtx, segStart, c1, c2, segEnd, true);
            accumCtx.restore();
          }
        } else {
          canvasCtx.save();
          if (clipRw > 0 && clipRh > 0) {
            canvasCtx.beginPath();
            canvasCtx.rect(clipRx, clipRy, clipRw, clipRh);
            canvasCtx.clip();
          }
          applySelectionCanvasClip(canvasCtx, selectionRef.current);
          stampRemainderDistRef.current = renderSegmentToContext(canvasCtx, segStart, c1, c2, segEnd, false);
          canvasCtx.restore();
        }
        syncLiveRegionToTiles(
          canvas,
          canvasCtx,
          currentLayerId,
          segMinX,
          segMinY,
          segMaxX,
          segMaxY,
          isMonochrome,
          activeLayer,
          bs,
          isEraser,
          isBgEraser
        );
        return;
      }
    }

    // Fallback wireframe only for Vector / Screentone / Mask Eraser when direct preview is disabled
    if (isEraser && !isBgEraser) {
      draftCtx.save();
      draftCtx.lineCap = 'round';
      draftCtx.lineJoin = 'round';
      draftCtx.setLineDash([4, 4]);
      draftCtx.strokeStyle = 'rgba(255, 80, 80, 0.75)';
      draftCtx.lineWidth = Math.max(1, (segStart.width + segEnd.width) / 2);
      draftCtx.beginPath();
      draftCtx.moveTo(segStart.x, segStart.y);
      draftCtx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, segEnd.x, segEnd.y);
      draftCtx.stroke();
      draftCtx.restore();
      return;
    }

    // Ultra-fast viewport draft overlay for top-layer opaque strokes
    stampRemainderDistRef.current = renderSegmentToContext(draftCtx, segStart, c1, c2, segEnd, false);
  }, [buildLiveRadialOptions, buildLiveTexturedOptions, ensureLiveTileSnapshots, getActiveCanvas, markTouchedTiles, syncLiveRegionToTiles]);

  // Stabilize and render point onto draft canvas
  const applyStabilizedPointAndRender = useCallback(
    (
      draftCtx: CanvasRenderingContext2D,
      rawX: number,
      rawY: number,
      rawPressure: number,
      pointerType: string,
      rawTiltX: number = 0,
      rawTiltY: number = 0,
      rawTwist: number = 0,
      timestamp?: number
    ) => {
      const bs = brushSettingsRef.current;
      const dims = dimensionsRef.current;
      const stab = Math.min(50, Math.max(0, bs.stabilization ?? 0));

      const now = timestamp ?? performance.now();
      const dt = Math.max(1, now - (lastPointTimeRef.current || now));
      lastPointTimeRef.current = now;

      let velocityScale = 1.0;
      if (bs.velocityDynamics && stabilizedPointRef.current) {
        const dist = Math.hypot(rawX - stabilizedPointRef.current.x, rawY - stabilizedPointRef.current.y);
        const speed = dist / dt; // px / ms
        velocityScale = Math.max(0.65, Math.min(1.0, 1.0 - Math.max(0, speed - 0.5) * 0.12));
      }

      const hasCustomCurve = Boolean(bs.pressureCurve && bs.pressureCurve.length > 0);
      let pt: Point;
      if (stab <= 0) {
        const baseP = bs.usePressure
          ? (hasCustomCurve ? rawPressure : taperEngineRef.current.mapPressure(rawPressure))
          : (rawPressure > 0 ? 1.0 : 0);
        const mappedP = bs.usePressure ? taperEngineRef.current.smoothPressure(baseP) : baseP;
        const width = calculateStrokeWidth(
          bs.size,
          mappedP,
          bs.minSizeFactor,
          bs.usePressure,
          pointerType,
          bs.pressureCurveGamma ?? 1.0,
          velocityScale,
          bs.pressureCurve
        );
        pt = { x: rawX, y: rawY, pressure: mappedP, width, tiltX: rawTiltX, tiltY: rawTiltY, twist: rawTwist, timestamp: now, isCorner: false };
        stabilizedPointRef.current = pt;
      } else {
        const sample = inputStabilizerRef.current.process(rawX, rawY, rawPressure, now);
        const baseP = bs.usePressure
          ? (hasCustomCurve ? sample.pressure : taperEngineRef.current.mapPressure(sample.pressure))
          : (rawPressure > 0 ? 1.0 : 0);
        const mappedP = bs.usePressure ? taperEngineRef.current.smoothPressure(baseP) : baseP;
        const smoothWidth = calculateStrokeWidth(
          bs.size,
          mappedP,
          bs.minSizeFactor,
          bs.usePressure,
          pointerType,
          bs.pressureCurveGamma ?? 1.0,
          velocityScale,
          bs.pressureCurve
        );
        pt = {
          x: sample.x,
          y: sample.y,
          pressure: mappedP,
          width: smoothWidth,
          tiltX: rawTiltX,
          tiltY: rawTiltY,
          twist: rawTwist,
          timestamp: now,
          isCorner: sample.isCorner,
        };
        stabilizedPointRef.current = pt;
      }

      // Track recent trail for exit velocity & tangent calculation
      if (allStrokePointsRef.current.length > 0) {
        const lastPt = allStrokePointsRef.current[allStrokePointsRef.current.length - 1];
        strokeTotalDistanceRef.current += Math.hypot(pt.x - lastPt.x, pt.y - lastPt.y);
      }
      recentPointsTrailRef.current.push({ x: pt.x, y: pt.y, t: now, pressure: pt.pressure, width: pt.width });
      if (recentPointsTrailRef.current.length > 16) {
        recentPointsTrailRef.current.shift();
      }

      // Expand dirty rectangle in canvas coordinates
      const blurMargin = (1 - (bs.hardness ?? 1.0)) * (pt.width * 1.5);
      const r = Math.max(24, Math.ceil(pt.width + blurMargin + 24));
      if (dirtyRectRef.current) {
        dirtyRectRef.current.minX = Math.max(0, Math.min(dirtyRectRef.current.minX, Math.floor(pt.x - r)));
        dirtyRectRef.current.minY = Math.max(0, Math.min(dirtyRectRef.current.minY, Math.floor(pt.y - r)));
        dirtyRectRef.current.maxX = Math.min(dims.width, Math.max(dirtyRectRef.current.maxX, Math.ceil(pt.x + r)));
        dirtyRectRef.current.maxY = Math.min(dims.height, Math.max(dirtyRectRef.current.maxY, Math.ceil(pt.y + r)));
      }

      allStrokePointsRef.current.push(pt);
      renderDraftSegment(draftCtx, pt);
    },
    [renderDraftSegment]
  );

  // Zero-gap provisional + predicted tip overlay matching exact brush geometry
  const renderPredictedStroke = useCallback(
    (predEvents: PointerEvent[], vRect: DOMRect) => {
      clearPredictedCanvas();
      if (toolRef.current === 'eraser' || drewDirectlyOnLayerCanvasRef.current) return;
      const pts = strokePointsRef.current;
      if (pts.length < 2) return;
      const pCanvas = getPredictedCanvas();
      if (!pCanvas) return;
      const pCtx = get2DContext(pCanvas);
      if (!pCtx) return;

      const bs = brushSettingsRef.current;
      const dims = dimensionsRef.current;
      const mode = colorModeRef.current;
      const currentLayerId = activeLayerIdRef.current;
      const activeLayer = layersRef.current?.find((l) => l.id === currentLayerId);
      const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
      const isMonochrome = mode === 'monochrome' || isMonoLayer;
      const isPencil = bs.preset?.startsWith('pencil') ?? false;

      let strokeColor: string;
      if (isMaskModeRef.current) {
        let clean = bs.color.replace('#', '');
        if (clean.length === 3) clean = clean.split('').map((c) => c + c).join('');
        const r = parseInt(clean.slice(0, 2), 16) || 0;
        const g = parseInt(clean.slice(2, 4), 16) || 0;
        const b = parseInt(clean.slice(4, 6), 16) || 0;
        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        const hexVal = gray.toString(16).padStart(2, '0');
        strokeColor = `#${hexVal}${hexVal}${hexVal}`;
      } else {
        strokeColor = enforceColorMode(bs.color, isMonochrome ? 'monochrome' : mode);
      }

      const strokeHardness = isMonochrome ? 1.0 : (bs.hardness ?? 1.0);
      const strokeFlow = isMonochrome ? 1.0 : (bs.flow ?? 1.0);
      const strokeSpacing = bs.spacing ?? 0.08;

      const pLast = pts[pts.length - 1];
      const pPrev = pts[pts.length - 2];
      const pPrev2 = pts.length >= 3 ? pts[pts.length - 3] : pPrev;

      let predPt: Point | null = null;
      if (predEvents && predEvents.length > 0) {
        const maxPredDist = Math.min(20, Math.max(4, (bs.size || 10) * 1.15));
        const ev = predEvents[0];
        const rawPred = screenToCanvas(
          ev.clientX,
          ev.clientY,
          vRect,
          panRef.current,
          zoomRef.current,
          rotationRef.current,
          dims
        );
        const dx = rawPred.x - pLast.x;
        const dy = rawPred.y - pLast.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= 0.5 && dist <= maxPredDist * 2.5) {
          const clampedScale = dist > maxPredDist ? maxPredDist / dist : 1.0;
          predPt = {
            x: pLast.x + dx * clampedScale,
            y: pLast.y + dy * clampedScale,
            pressure: pLast.pressure * 0.9,
            width: Math.max(0.5, pLast.width * 0.9),
            tiltX: pLast.tiltX,
            tiltY: pLast.tiltY,
            twist: pLast.twist,
          };
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
        scaleY
      );

      pCtx.save();
      pCtx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
      pCtx.beginPath();
      pCtx.rect(0, 0, dims.width, dims.height);
      pCtx.clip();
      applySelectionCanvasClip(pCtx, selectionRef.current);

      const drawProvisionalSeg = (s0: Point, c1Pt: Point, c2Pt: Point, s3: Point, rem: number): number => {
        if (bs.customTipImage) {
          return drawTexturedCubicBezierSegment(
            pCtx,
            s0,
            c1Pt,
            c2Pt,
            s3,
            strokeColor,
            bs.customTipImage,
            {
              size: bs.size,
              minSizeFactor: bs.minSizeFactor,
              opacity: bs.opacity,
              flow: strokeFlow,
              spacing: strokeSpacing,
              thickness: bs.thickness,
              thicknessVertical: bs.thicknessVertical,
              angle: bs.customTipAngle,
              angleDynamics: bs.customTipAngleDynamics,
              rotationRandomScale: bs.customTipRotationRandomScale,
              hardness: strokeHardness,
              antiAlias: isMonochrome ? 0 : bs.antiAlias,
              pressureCurve: bs.pressureCurve,
              usePressure: bs.usePressure,
              subTips: bs.subTips,
              subTipOrder: bs.subTipOrder,
              subTipImages: bs.subTipImages,
              spray: bs.spray,
              wetEdge: bs.wetEdge,
              grain: bs.grain ?? bs.textureDensity,
              dualBrush: bs.dualBrush,
              dualTipImage: bs.dualTipImage,
              dualBrushCompositeMode: bs.dualBrushCompositeMode,
              alphaLocked: Boolean(activeLayer?.alphaLocked),
              isTransparentInk: Boolean(bs.isTransparentInk),
              dynamics: bs.dynamics,
              secondaryColor: bs.secondaryColor,
            },
            rem
          );
        } else if (isPencil) {
          const grade = (bs.preset as PencilGrade) || 'pencil-2b';
          return drawPencilCubicBezierSegment(
            pCtx,
            s0,
            c1Pt,
            c2Pt,
            s3,
            strokeColor,
            grade,
            isMonochrome ? 1.0 : (bs.flow ?? 0.74),
            bs.grain ?? 1.0,
            strokeHardness,
            rem,
            Boolean(activeLayer?.alphaLocked),
            Boolean(bs.isTransparentInk)
          );
        } else {
          return drawSmoothCubicBezierSegment(
            pCtx,
            s0,
            c1Pt,
            c2Pt,
            s3,
            strokeColor,
            false,
            strokeHardness,
            strokeFlow,
            strokeSpacing,
            rem,
            bs.thickness ?? 1.0,
            ((bs.customTipAngle ?? 0) * Math.PI) / 180,
            {
              alphaLocked: Boolean(activeLayer?.alphaLocked),
              isTransparentInk: Boolean(bs.isTransparentInk),
              dynamics: bs.dynamics,
              secondaryColor: bs.secondaryColor,
              dualBrush: bs.dualBrush,
              dualTipImage: bs.dualTipImage,
              dualBrushCompositeMode: bs.dualBrushCompositeMode,
            }
          );
        }
      };

      // 1. Provisional unsealed segment (pPrev -> pLast) bridging draftCanvas to current stylus head
      const provNextKnot = predPt || pLast;
      const provCtrl = catmullRomToBezier(pPrev2, pPrev, pLast, provNextKnot);
      const remAfterProv = drawProvisionalSeg(pPrev, provCtrl.c1, provCtrl.c2, pLast, stampRemainderDistRef.current);

      // 2. Speculative lookahead segment (pLast -> predPt) if predicted events exist
      if (predPt) {
        const predCtrl = catmullRomToBezier(pPrev, pLast, predPt, predPt);
        drawProvisionalSeg(pLast, predCtrl.c1, predCtrl.c2, predPt, remAfterProv);
      }

      pCtx.restore();
    },
    [clearPredictedCanvas, getPredictedCanvas]
  );

  // Flush batched points on requestAnimationFrame
  const flushPendingPoints = useCallback(() => {
    drawRafIdRef.current = null;
    if (!isDrawingRef.current) return;

    const queue = pendingPointsQueueRef.current;
    if (queue.length === 0) {
      // Update predicted stroke overlay throttled to rAF
      const predData = latestPredictedRef.current;
      latestPredictedRef.current = null;
      const vRect = getViewportRect();
      if (vRect && allStrokePointsRef.current.length > 0) {
        renderPredictedStroke(predData ? predData.predEvents : [], vRect);
        isPredictedCanvasDirtyRef.current = true;
      } else if (isPredictedCanvasDirtyRef.current) {
        clearPredictedCanvas();
      }
      return;
    }

    const draftCanvas = effectiveDraftCanvasRef?.current;
    if (!draftCanvas) return;
    const draftCtx = get2DContext(draftCanvas);
    if (!draftCtx) return;

    const queueLen = queue.length;
    const chunkPts: Point[] = [];
    let batchMinX = Infinity;
    let batchMinY = Infinity;
    let batchMaxX = -Infinity;
    let batchMaxY = -Infinity;
    let maxStrokeWidth = 0;

    for (let i = 0; i < queueLen; i++) {
      const item = queue[i];
      applyStabilizedPointAndRender(
        draftCtx,
        item.x,
        item.y,
        item.pressure,
        item.pointerType,
        item.tiltX,
        item.tiltY,
        item.twist,
        item.timestamp
      );
      if (allStrokePointsRef.current.length > 0) {
        const lastPt = allStrokePointsRef.current[allStrokePointsRef.current.length - 1];
        chunkPts.push(lastPt);
        batchMinX = Math.min(batchMinX, lastPt.x);
        batchMinY = Math.min(batchMinY, lastPt.y);
        batchMaxX = Math.max(batchMaxX, lastPt.x);
        batchMaxY = Math.max(batchMaxY, lastPt.y);
        maxStrokeWidth = Math.max(maxStrokeWidth, lastPt.width);
      }
    }
    queue.length = 0;


    if (batchMinX <= batchMaxX) {
      const dims = dimensionsRef.current;
      const margin = Math.ceil(maxStrokeWidth * 1.5 + 32);
      const segMinX = Math.max(0, Math.floor(batchMinX - margin));
      const segMinY = Math.max(0, Math.floor(batchMinY - margin));
      const segMaxX = Math.min(dims.width, Math.ceil(batchMaxX + margin));
      const segMaxY = Math.min(dims.height, Math.ceil(batchMaxY + margin));

      if (dirtyRectRef.current) {
        dirtyRectRef.current.minX = Math.min(dirtyRectRef.current.minX, segMinX);
        dirtyRectRef.current.minY = Math.min(dirtyRectRef.current.minY, segMinY);
        dirtyRectRef.current.maxX = Math.max(dirtyRectRef.current.maxX, segMaxX);
        dirtyRectRef.current.maxY = Math.max(dirtyRectRef.current.maxY, segMaxY);
      }
    }

    if (currentStrokeIdRef.current && chunkPts.length > 0) {
      onCollabStrokeChunkRef.current?.(currentStrokeIdRef.current, chunkPts);
    }

    if (liveNeedsNotifyRef.current) {
      liveNeedsNotifyRef.current = false;
      globalTileGrid.notifyChange();
    }

    // Update predicted stroke overlay throttled to rAF
    const predData = latestPredictedRef.current;
    latestPredictedRef.current = null;
    const vRect = getViewportRect();
    if (vRect && allStrokePointsRef.current.length > 0) {
      renderPredictedStroke(predData ? predData.predEvents : [], vRect);
      isPredictedCanvasDirtyRef.current = true;
    } else if (isPredictedCanvasDirtyRef.current) {
      clearPredictedCanvas();
    }
  }, [
    applyStabilizedPointAndRender,
    clearPredictedCanvas,
    effectiveDraftCanvasRef,
    getActiveCanvas,
    getViewportRect,
    renderPredictedStroke,
  ]);


  // Pointer Down handler: initialize lightweight live stroke overlay without touching base canvas
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, coalescedEvents?: PointerEvent[]) => {
      const isBrushOrEraser = toolRef.current === 'brush' || toolRef.current === 'eraser';
      if (!isBrushOrEraser || disabled || e.button !== 0 || activeLayerLockedRef.current || !activeLayerVisibleRef.current) return;
      e.preventDefault();
      if (isDrawingRef.current) {
        abortActiveStroke();
      }
      flushPendingHistoryTasks();

      const canvas = getActiveCanvas();
      if (!canvas) return;

      const vRect = getViewportRect();
      if (!vRect) return;

      const dims = dimensionsRef.current;
      const draftCanvas = effectiveDraftCanvasRef?.current;
      if (!draftCanvas) return;

      // Update cached viewport rect on stroke start
      if (viewportRef.current) {
        cachedViewportRectRef.current = viewportRef.current.getBoundingClientRect();
      }

      // Cancel any pending clear rAF from previous stroke and reset draft canvas immediately
      if (clearDraftRafRef.current !== null) {
        cancelAnimationFrame(clearDraftRafRef.current);
        clearDraftRafRef.current = null;
      }

      const draftCtx = get2DContext(draftCanvas);
      if (!draftCtx) return;

      // Reset and clear draft canvas with viewport transform
      draftCtx.resetTransform();
      draftCtx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);

      const scaleX = draftCanvas.width / vRect.width;
      const scaleY = draftCanvas.height / vRect.height;
      const matrix = getCanvasToViewportMatrix(
        panRef.current,
        zoomRef.current,
        rotationRef.current,
        dimensionsRef.current,
        scaleX,
        scaleY
      );
      draftCtx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
      draftCtx.save();
      draftCtx.beginPath();
      draftCtx.rect(0, 0, dimensionsRef.current.width, dimensionsRef.current.height);
      draftCtx.clip();
      applySelectionCanvasClip(draftCtx, selectionRef.current);

      clearPredictedCanvas();

      const isEraser = toolRef.current === 'eraser';
      const isBgEraser = isEraser && isBackgroundLayerId(activeLayerIdRef.current);

      const currentLayerId = activeLayerIdRef.current;
      const allLayers = layersRef.current || [];
      const activeIdx = allLayers.findIndex((l) => l.id === currentLayerId);
      const activeLayer = activeIdx >= 0 ? allLayers[activeIdx] : undefined;
      const bs = brushSettingsRef.current;
      const mode = colorModeRef.current;
      const isPencil = !isEraser && !bs.customTipImage && (bs.preset?.startsWith('pencil') ?? false);

      const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
      const isMonochrome = mode === 'monochrome' || isMonoLayer;
      const isTone = Boolean(activeLayer?.toneEnabled);
      isToneStrokeRef.current = isTone;

      let sourceCanvas: HTMLCanvasElement | null = null;
      if (isTone) {
        sourceCanvas = layerSourceCanvasesRef?.current?.get(currentLayerId) || null;
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

      const rawCoalesced = coalescedEvents ?? (e as any).coalescedEvents ?? (typeof e.nativeEvent?.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : null);
      const events: PointerEvent[] = (rawCoalesced && rawCoalesced.length > 0) ? Array.from(rawCoalesced) : [e.nativeEvent];
      const firstEvent = events[0] || e.nativeEvent;
      const rawStartPoint = getCanvasPoint(firstEvent);
      const isAltOverride = e.altKey;
      const startPoint = snapSessionRef.current.snapPoint(rawStartPoint, rulerRef.current, isAltOverride);
      emitConstraintAxisChange(snapSessionRef.current.getActiveAxis());

      inputStabilizerRef.current.reset();
      inputStabilizerRef.current.setStabilizerLevel(bs.stabilization ?? 0);
      inputStabilizerRef.current.setZoomScale(zoomRef.current || 1.0);
      inputStabilizerRef.current.setSharpCorners(bs.sharpCorners !== false);
      taperEngineRef.current.reset();

      const startNow = startPoint.timestamp ?? performance.now();
      lastPointTimeRef.current = startNow;
      if ((bs.stabilization ?? 0) > 0) {
        inputStabilizerRef.current.process(startPoint.x, startPoint.y, startPoint.pressure, startNow);
      }
      const hasCustomCurve = Boolean(bs.pressureCurve && bs.pressureCurve.length > 0);
      if (bs.usePressure) {
        const baseStartP = hasCustomCurve ? startPoint.pressure : taperEngineRef.current.mapPressure(startPoint.pressure);
        const smoothStartP = taperEngineRef.current.smoothPressure(baseStartP);
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
        strokePointsRef.current = [pLineStart, pLineMid];
      } else {
        allStrokePointsRef.current = [startPoint];
        strokePointsRef.current = [startPoint];
      }

      rawPointsBufferRef.current = [{
        x: startPoint.x,
        y: startPoint.y,
        pressure: startPoint.pressure,
        pointerType: firstEvent.pointerType,
        tiltX: startPoint.tiltX ?? 0,
        tiltY: startPoint.tiltY ?? 0,
        twist: startPoint.twist ?? 0,
        timestamp: startPoint.timestamp,
      }];
      stabilizedPointRef.current = { ...startPoint };
      lastProcessedPointRef.current = { x: startPoint.x, y: startPoint.y };
      pendingPointsQueueRef.current = [];
      recentPointsTrailRef.current = [{
        x: startPoint.x,
        y: startPoint.y,
        t: performance.now(),
        pressure: startPoint.pressure,
        width: startPoint.width,
      }];
      strokeTotalDistanceRef.current = isShiftLine && prevStrokeEnd
        ? Math.hypot(startPoint.x - prevStrokeEnd.x, startPoint.y - prevStrokeEnd.y)
        : 0;

      if (!isShiftLine && events.length > 1) {
        for (let i = 1; i < events.length; i++) {
          const cEv = events[i];
          const rawPt = getCanvasPoint(cEv);
          const snapped = snapSessionRef.current.processPoint({ x: rawPt.x, y: rawPt.y }, rulerRef.current, isAltOverride);
          let cPressure = 0;
          if (cEv.pointerType === 'mouse') {
            cPressure = (cEv.buttons & 1) ? 0.5 : 0;
          } else {
            cPressure = cEv.pressure !== undefined ? Math.max(0, Math.min(1.0, cEv.pressure)) : 0;
          }
          pendingPointsQueueRef.current.push({
            x: snapped.x,
            y: snapped.y,
            pressure: cPressure,
            pointerType: cEv.pointerType,
            tiltX: cEv.tiltX ?? 0,
            tiltY: cEv.tiltY ?? 0,
            twist: cEv.twist ?? 0,
            timestamp: cEv.timeStamp,
          });
        }
      }

      dispatchPointerStat(startPoint.x, startPoint.y, startPoint.pressure);

      const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
      const blurMargin = (1 - (bs.hardness ?? 1.0)) * (startPoint.width * 1.5);
      const r = Math.max(
        32,
        Math.ceil(Math.max(startPoint.width, bs.size || 10) * (2.8 + scatterFactor * 2) + blurMargin + 32)
      );
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
      touchedTilesRef.current.clear();
      markTouchedTiles(
        dirtyRectRef.current.minX,
        dirtyRectRef.current.minY,
        dirtyRectRef.current.maxX,
        dirtyRectRef.current.maxY
      );

      let strokeColor: string;
      if (isMaskModeRef.current) {
        if (isEraser) {
          strokeColor = '#000000';
        } else {
          let clean = bs.color.replace('#', '');
          if (clean.length === 3) clean = clean.split('').map((c) => c + c).join('');
          const cr = parseInt(clean.slice(0, 2), 16) || 0;
          const cg = parseInt(clean.slice(2, 4), 16) || 0;
          const cb = parseInt(clean.slice(4, 6), 16) || 0;
          const gray = Math.round(0.299 * cr + 0.587 * cg + 0.114 * cb);
          const hexVal = gray.toString(16).padStart(2, '0');
          strokeColor = `#${hexVal}${hexVal}${hexVal}`;
        }
      } else {
        strokeColor = isBgEraser ? '#ffffff' : enforceColorMode(bs.color, isMonochrome ? 'monochrome' : mode);
      }
      const strokeHardness = isMonochrome ? 1.0 : (bs.hardness ?? 1.0);
      const strokeFlow = bs.flow ?? 1.0;

      const isWetColor = !isEraser && Boolean(bs.colorMixing);
      isWetColorStrokeRef.current = isWetColor;
      liveOrigCanvasTilesRef.current.clear();
      liveBeforeTileSnapshotRef.current.clear();
      liveNeedsNotifyRef.current = false;
      strokeBackupCanvasRef.current = null;

      const useDirectLayerPreview =
        !isTone &&
        activeLayer?.type !== 'vector' &&
        !isMaskModeRef.current;

      drewDirectlyOnLayerCanvasRef.current = useDirectLayerPreview;
      const needsIsolation = useDirectLayerPreview && (bs.opacity ?? 1.0) < 0.999;
      liveStrokeIsolationRef.current = needsIsolation;
      if (needsIsolation) {
        if (
          !liveAccumCanvasRef.current ||
          liveAccumCanvasRef.current.width !== canvas.width ||
          liveAccumCanvasRef.current.height !== canvas.height
        ) {
          liveAccumCanvasRef.current = document.createElement('canvas');
          liveAccumCanvasRef.current.width = canvas.width;
          liveAccumCanvasRef.current.height = canvas.height;
        } else {
          const accCtx = get2DContext(liveAccumCanvasRef.current);
          accCtx?.clearRect(0, 0, canvas.width, canvas.height);
        }
      }

      if (isWetColor && canvas) {
        layerPixelSamplerRef.current = new LayerPixelSampler(
          canvas,
          activeLayerIdRef.current,
          globalTileGrid,
          liveOrigCanvasTilesRef.current
        );
        activeReservoirRef.current = new PaintReservoir(strokeColor);
      } else {
        layerPixelSamplerRef.current = null;
        activeReservoirRef.current = null;
      }

      const strokeId = `stroke-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      currentStrokeIdRef.current = strokeId;
      onCollabStrokeStartRef.current?.(strokeId, activeLayerIdRef.current, bs, toolRef.current, startPoint);

      liveDabCounterRef.current.count = 0;
      stampRemainderDistRef.current = bs.customTipImage
        ? Math.max(0.15, startPoint.width * (bs.spacing ?? 0.07))
        : Math.max(0.12, startPoint.width * (bs.spacing ?? 0.08));

      const firstDotPoint = allStrokePointsRef.current[0];

      const drawInitialDotToCtx = (targetCtx: CanvasRenderingContext2D, isolatedPass: boolean) => {
        if (bs.customTipImage) {
          const tipOptions = buildLiveTexturedOptions(
            bs,
            bs.flow ?? 0.85,
            bs.spacing ?? 0.08,
            strokeHardness,
            isMonochrome,
            canvas,
            activeLayer,
            isEraser,
            isBgEraser,
            isolatedPass
          );
          drawTexturedDot(
            targetCtx,
            firstDotPoint,
            isolatedPass && isEraser && !isBgEraser ? '#000000' : strokeColor,
            bs.customTipImage,
            tipOptions
          );
        } else if (isPencil) {
          const grade = (bs.preset as PencilGrade) || 'pencil-2b';
          drawPencilDot(
            targetCtx,
            firstDotPoint,
            strokeColor,
            grade,
            isMonochrome ? 1.0 : (bs.flow ?? 0.74),
            bs.grain ?? 1.0,
            strokeHardness,
            isolatedPass ? false : Boolean(activeLayer?.alphaLocked),
            isolatedPass ? false : Boolean(bs.isTransparentInk)
          );
        } else {
          const radialMixingOptions = buildLiveRadialOptions(
            bs,
            isMonochrome,
            canvas,
            activeLayer,
            isolatedPass
          );
          drawDot(
            targetCtx,
            firstDotPoint,
            isolatedPass && isEraser && !isBgEraser ? '#000000' : strokeColor,
            isolatedPass ? false : isEraser && !isBgEraser,
            strokeHardness,
            isMonochrome ? 1.0 : strokeFlow,
            radialMixingOptions,
            bs.thickness ?? 1.0,
            ((bs.customTipAngle ?? 0) * Math.PI) / 180
          );
        }
      };

      if (useDirectLayerPreview) {
        const cCtx = get2DContext(canvas);
        if (cCtx) {
          const d = dirtyRectRef.current;
          ensureLiveTileSnapshots(canvas, cCtx, currentLayerId, d.minX, d.minY, d.maxX, d.maxY);
          if (needsIsolation && liveAccumCanvasRef.current) {
            const accCtx = get2DContext(liveAccumCanvasRef.current);
            if (accCtx) {
              accCtx.save();
              accCtx.beginPath();
              accCtx.rect(d.minX, d.minY, Math.max(1, d.maxX - d.minX), Math.max(1, d.maxY - d.minY));
              accCtx.clip();
              applySelectionCanvasClip(accCtx, selectionRef.current);
              drawInitialDotToCtx(accCtx, true);
              accCtx.restore();
            }
          } else {
            cCtx.save();
            cCtx.beginPath();
            cCtx.rect(d.minX, d.minY, Math.max(1, d.maxX - d.minX), Math.max(1, d.maxY - d.minY));
            cCtx.clip();
            applySelectionCanvasClip(cCtx, selectionRef.current);
            drawInitialDotToCtx(cCtx, false);
            cCtx.restore();
          }
          syncLiveRegionToTiles(
            canvas,
            cCtx,
            currentLayerId,
            firstDotPoint.x - r,
            firstDotPoint.y - r,
            firstDotPoint.x + r,
            firstDotPoint.y + r,
            isMonochrome,
            activeLayer,
            bs,
            isEraser,
            isBgEraser
          );
          if (isShiftLine) {
            renderDraftSegment(draftCtx, startPoint);
          }
          globalTileGrid.notifyChange();
          liveNeedsNotifyRef.current = false;
        }
      } else if (isEraser && !isBgEraser) {
        draftCtx.save();
        draftCtx.strokeStyle = 'rgba(255, 80, 80, 0.75)';
        draftCtx.setLineDash([3, 3]);
        draftCtx.lineWidth = Math.max(1, 1.5 / Math.max(0.05, zoomRef.current));
        draftCtx.beginPath();
        draftCtx.arc(firstDotPoint.x, firstDotPoint.y, Math.max(1, firstDotPoint.width / 2), 0, Math.PI * 2);
        draftCtx.stroke();
        draftCtx.restore();
        if (isShiftLine) {
          renderDraftSegment(draftCtx, startPoint);
        }
      } else {
        drawInitialDotToCtx(draftCtx, false);
        if (isShiftLine) {
          renderDraftSegment(draftCtx, startPoint);
        }
      }

      if (pendingPointsQueueRef.current.length > 0 && drawRafIdRef.current === null) {
        drawRafIdRef.current = requestAnimationFrame(flushPendingPoints);
      }
    },
    [buildLiveRadialOptions, buildLiveTexturedOptions, clearPredictedCanvas, disabled, dispatchPointerStat, effectiveDraftCanvasRef, emitConstraintAxisChange, ensureLiveTileSnapshots, flushPendingHistoryTasks, flushPendingPoints, getActiveCanvas, getCanvasPoint, getViewportRect, markTouchedTiles, renderDraftSegment, syncLiveRegionToTiles, viewportRef]
  );

  // Pointer Move handler: throttled & batched coordinate ingestion via rAF with coalesced and predicted events
  const handlePointerMove = useCallback(
    (
      e: React.PointerEvent<HTMLElement>,
      coalescedEvents?: PointerEvent[],
      _predictedEvents?: PointerEvent[]
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

      const rawCoalesced =
        coalescedEvents ??
        (e as any).coalescedEvents ??
        (typeof e.nativeEvent?.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : null);
      const events: PointerEvent[] =
        rawCoalesced && rawCoalesced.length > 0 ? Array.from(rawCoalesced) : [e.nativeEvent];

      const minStepDoc = Math.min(0.25, 0.25 / Math.max(0.05, zoomRef.current));
      let lastQueuedX = 0;
      let lastQueuedY = 0;
      let lastQueuedPressure = 0.5;
      let hasQueued = false;

      for (let i = 0; i < events.length; i++) {
        const cEvent = events[i];
        const rawCoords = screenToCanvas(
          cEvent.clientX,
          cEvent.clientY,
          vRect,
          panRef.current,
          zoomRef.current,
          rotationRef.current,
          dims
        );

        const isAltOverride = e.altKey;
        const snapRes = snapSessionRef.current.processPoint(rawCoords, rulerRef.current, isAltOverride);
        let cx = snapRes.x;
        let cy = snapRes.y;
        if (snapRes.axis) {
          emitConstraintAxisChange(snapRes.axis);
        } else if (
          !isShiftLineStrokeRef.current &&
          e.shiftKey &&
          !rulerRef.current?.enabled &&
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

        const last = lastProcessedPointRef.current;
        if (
          last &&
          Math.hypot(cx - last.x, cy - last.y) < minStepDoc &&
          Math.abs(cPressure - lastQueuedPressure) <= 0.04
        ) {
          continue;
        }

        lastProcessedPointRef.current = { x: cx, y: cy };

        pendingPointsQueueRef.current.push({
          x: cx,
          y: cy,
          pressure: cPressure,
          pointerType: cEvent.pointerType,
          tiltX: cEvent.tiltX ?? 0,
          tiltY: cEvent.tiltY ?? 0,
          twist: cEvent.twist ?? 0,
          timestamp: cEvent.timeStamp,
        });
        lastQueuedX = cx;
        lastQueuedY = cy;
        lastQueuedPressure = cPressure;
        hasQueued = true;
      }

      if (_predictedEvents && _predictedEvents.length > 0) {
        latestPredictedRef.current = { predEvents: _predictedEvents, vRect };
      } else {
        latestPredictedRef.current = null;
      }

      if (hasQueued) {
        dispatchPointerStat(lastQueuedX, lastQueuedY, lastQueuedPressure);
        onCollabCursorMoveRef.current?.(lastQueuedX, lastQueuedY, true, toolRef.current);
      }

      if (pendingPointsQueueRef.current.length > 0 && drawRafIdRef.current === null) {
        drawRafIdRef.current = requestAnimationFrame(flushPendingPoints);
      }
    },
    [dispatchPointerStat, emitConstraintAxisChange, flushPendingPoints, getCanvasPoint, getViewportRect]
  );

  // Pointer Up / Cancel handler: composite and bake stroke into high-res canvas at dirty rect
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

      // Cancel any pending rAF and flush remaining points synchronously
      if (drawRafIdRef.current !== null) {
        cancelAnimationFrame(drawRafIdRef.current);
        drawRafIdRef.current = null;
      }
      flushPendingPoints();

      const bs = brushSettingsRef.current;
      const endPoint = getCanvasPoint(e);
      const draftCanvas = effectiveDraftCanvasRef?.current;
      const draftCtx = draftCanvas ? get2DContext(draftCanvas) : null;
      const canvas = getActiveCanvas();
      if (canvas) {
        (canvas as any).__isBlank = false;
        (canvas as any).__isSolidWhite = false;
      }

      // Finalize tail segment on draft canvas using Catmull-Rom cubic Bézier
      const pts = strokePointsRef.current;
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
      const targetTailCtx = draftCtx;

      let strokeColor: string;
      if (isMaskModeRef.current) {
        if (isEraser) {
          strokeColor = '#000000';
        } else {
          let clean = bs.color.replace('#', '');
          if (clean.length === 3) clean = clean.split('').map((c) => c + c).join('');
          const r = parseInt(clean.slice(0, 2), 16) || 0;
          const g = parseInt(clean.slice(2, 4), 16) || 0;
          const b = parseInt(clean.slice(4, 6), 16) || 0;
          const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
          const hexVal = gray.toString(16).padStart(2, '0');
          strokeColor = `#${hexVal}${hexVal}${hexVal}`;
        }
      } else {
        strokeColor = isBgEraser ? '#ffffff' : enforceColorMode(bs.color, isMonochrome ? 'monochrome' : mode);
      }
      const strokeHardness = isMonochrome ? 1.0 : (bs.hardness ?? 1.0);

      const renderTailSegmentToCtx = (
        ctx: CanvasRenderingContext2D,
        pPrev: Point,
        c1: Point,
        c2: Point,
        pLast: Point,
        isolatedPass: boolean
      ) => {
        if (bs.customTipImage) {
          const tipOptions = buildLiveTexturedOptions(
            bs,
            bs.flow ?? 0.85,
            bs.spacing ?? 0.08,
            strokeHardness,
            isMonochrome,
            canvas,
            activeLayer,
            isEraser,
            isBgEraser,
            isolatedPass
          );
          stampRemainderDistRef.current = drawTexturedCubicBezierSegment(
            ctx,
            pPrev,
            c1,
            c2,
            pLast,
            isolatedPass && isEraser && !isBgEraser ? '#000000' : strokeColor,
            bs.customTipImage,
            tipOptions,
            stampRemainderDistRef.current,
            liveDabCounterRef.current
          );
        } else if (isPencil) {
          const grade = (bs.preset as PencilGrade) || 'pencil-2b';
          stampRemainderDistRef.current = drawPencilCubicBezierSegment(
            ctx,
            pPrev,
            c1,
            c2,
            pLast,
            strokeColor,
            grade,
            isMonochrome ? 1.0 : (bs.flow ?? 0.74),
            bs.grain ?? 1.0,
            strokeHardness,
            stampRemainderDistRef.current,
            isolatedPass ? false : Boolean(activeLayer?.alphaLocked),
            isolatedPass ? false : Boolean(bs.isTransparentInk),
            bs.useTilt ?? true
          );
        } else {
          const radialMixingOptions = buildLiveRadialOptions(
            bs,
            isMonochrome,
            canvas,
            activeLayer,
            isolatedPass
          );
          stampRemainderDistRef.current = drawSmoothCubicBezierSegment(
            ctx,
            pPrev,
            c1,
            c2,
            pLast,
            isolatedPass && isEraser && !isBgEraser ? '#000000' : strokeColor,
            isolatedPass ? false : isEraser && !isBgEraser,
            strokeHardness,
            isMonochrome ? 1.0 : (bs.flow ?? 1.0),
            bs.spacing ?? 0.08,
            stampRemainderDistRef.current,
            bs.thickness ?? 1.0,
            ((bs.customTipAngle ?? 0) * Math.PI) / 180,
            radialMixingOptions
          );
        }
      };

      if (pts.length >= 2) {
        const pLast = pts[pts.length - 1];
        const pPrev = pts[pts.length - 2];
        const pPrev2 = pts.length >= 3 ? pts[pts.length - 3] : pPrev;
        const { c1, c2 } = catmullRomToBezier(pPrev2, pPrev, pLast, pLast);

        const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
        const tailMargin = Math.ceil(
          Math.max(pLast.width, pPrev.width, bs.size || 10) * (2.8 + scatterFactor * 2) + 32
        );
        const docW = canvas ? canvas.width : dimensionsRef.current.width;
        const docH = canvas ? canvas.height : dimensionsRef.current.height;
        const tMinX = Math.max(0, Math.floor(Math.min(pPrev.x, c1.x, c2.x, pLast.x) - tailMargin));
        const tMinY = Math.max(0, Math.floor(Math.min(pPrev.y, c1.y, c2.y, pLast.y) - tailMargin));
        const tMaxX = Math.min(docW, Math.ceil(Math.max(pPrev.x, c1.x, c2.x, pLast.x) + tailMargin));
        const tMaxY = Math.min(docH, Math.ceil(Math.max(pPrev.y, c1.y, c2.y, pLast.y) + tailMargin));

        if (dirtyRectRef.current) {
          dirtyRectRef.current.minX = Math.min(dirtyRectRef.current.minX, tMinX);
          dirtyRectRef.current.minY = Math.min(dirtyRectRef.current.minY, tMinY);
          dirtyRectRef.current.maxX = Math.max(dirtyRectRef.current.maxX, tMaxX);
          dirtyRectRef.current.maxY = Math.max(dirtyRectRef.current.maxY, tMaxY);
        }
        markTouchedTiles(tMinX, tMinY, tMaxX, tMaxY);

        if (drewDirectlyOnLayerCanvasRef.current && canvas) {
          const canvasCtx = get2DContext(canvas);
          if (canvasCtx && tMaxX > tMinX && tMaxY > tMinY) {
            ensureLiveTileSnapshots(canvas, canvasCtx, currentLayerId, tMinX, tMinY, tMaxX, tMaxY);
            const clipRw = tMaxX - tMinX;
            const clipRh = tMaxY - tMinY;
            if (liveStrokeIsolationRef.current && liveAccumCanvasRef.current) {
              const accumCtx = get2DContext(liveAccumCanvasRef.current);
              if (accumCtx) {
                accumCtx.save();
                accumCtx.beginPath();
                accumCtx.rect(tMinX, tMinY, clipRw, clipRh);
                accumCtx.clip();
                applySelectionCanvasClip(accumCtx, selectionRef.current);
                renderTailSegmentToCtx(accumCtx, pPrev, c1, c2, pLast, true);
                accumCtx.restore();
              }
            } else {
              canvasCtx.save();
              canvasCtx.beginPath();
              canvasCtx.rect(tMinX, tMinY, clipRw, clipRh);
              canvasCtx.clip();
              applySelectionCanvasClip(canvasCtx, selectionRef.current);
              renderTailSegmentToCtx(canvasCtx, pPrev, c1, c2, pLast, false);
              canvasCtx.restore();
            }
            syncLiveRegionToTiles(
              canvas,
              canvasCtx,
              currentLayerId,
              tMinX,
              tMinY,
              tMaxX,
              tMaxY,
              isMonochrome,
              activeLayer,
              bs,
              isEraser,
              isBgEraser
            );
          }
        } else if (targetTailCtx) {
          if (isEraser && !isBgEraser) {
            targetTailCtx.save();
            targetTailCtx.lineCap = 'round';
            targetTailCtx.lineJoin = 'round';
            targetTailCtx.setLineDash([4, 4]);
            targetTailCtx.strokeStyle = 'rgba(255, 80, 80, 0.75)';
            targetTailCtx.lineWidth = Math.max(1, (pPrev.width + pLast.width) / 2);
            targetTailCtx.beginPath();
            targetTailCtx.moveTo(pPrev.x, pPrev.y);
            targetTailCtx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, pLast.x, pLast.y);
            targetTailCtx.stroke();
            targetTailCtx.restore();
          } else {
            renderTailSegmentToCtx(targetTailCtx, pPrev, c1, c2, pLast, false);
          }
        }
      }

      // BAKE STROKE INTO HIGH-RESOLUTION BASE CANVAS (Dirty Rect only)
      const dirty = dirtyRectRef.current;
      let exitSpeed = 0;
      if (recentPointsTrailRef.current.length >= 2) {
        const trail = recentPointsTrailRef.current;
        const sampleIdx = Math.max(0, trail.length - 4);
        const pA = trail[sampleIdx];
        const pB = trail[trail.length - 1];
        const dwellMs = Math.max(0, performance.now() - pB.t);
        const dt = Math.max(1, (pB.t - pA.t) + dwellMs);
        const dx = pB.x - pA.x;
        const dy = pB.y - pA.y;
        const dist = Math.hypot(dx, dy);
        exitSpeed = dist / dt;
      }

      const shouldTaper = Boolean(bs.taper?.useIn) || Boolean(bs.taper?.useOut);
      if (shouldTaper && allStrokePointsRef.current.length >= 3) {
        applyParametricTaper(allStrokePointsRef.current, {
          useIn: Boolean(bs.taper?.useIn),
          useOut: Boolean(bs.taper?.useOut),
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

          let minX = dirty ? dirty.minX : 0;
          let minY = dirty ? dirty.minY : 0;
          let maxX = dirty ? dirty.maxX : canvas.width;
          let maxY = dirty ? dirty.maxY : canvas.height;
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
      } else if (canvas && dirty && allPoints.length > 0) {
        const wetMargin = (bs.wetEdge ?? 0) > 0.01 ? Math.ceil((bs.wetEdgeRadius ?? 3.0) * 2 + 8) : 0;
        const pad = Math.ceil(Math.max(32, (bs.size || 10) * 1.5)) + wetMargin;
        const sx = Math.max(0, Math.floor(dirty.minX - pad));
        const sy = Math.max(0, Math.floor(dirty.minY - pad));
        const maxX = Math.min(canvas.width, Math.ceil(dirty.maxX + pad));
        const maxY = Math.min(canvas.height, Math.ceil(dirty.maxY + pad));
        const dw = maxX - sx;
        const dh = maxY - sy;

        if (dw > 0 && dh > 0) {
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

            const dirtyRect = { x: sx, y: sy, width: dw, height: dh };
            const toolForHistory = currentTool === 'eraser' ? 'eraser' : (isPencil ? 'pencil' : 'brush');
            const targetFormat = isMonochrome ? 'monochrome-1bit' : 'color-32bit';
            const effectiveMode: CanvasColorMode = isMonochrome ? 'monochrome' : mode;
            const activeSelection = selectionRef.current;
            const hasWetEdge =
              !isMonochrome &&
              !isEraser &&
              !bs.isTransparentInk &&
              (bs.wetEdge ?? 0) > 0.01;
            const needsPostBake =
              !drewDirectlyOnLayerCanvasRef.current ||
              isMaskModeRef.current ||
              (isToneLayer && Boolean(sourceCanvas)) ||
              hasWetEdge ||
              (((bs.postCorrection ?? 0) > 0 || shouldTaper) && allPoints.length >= 3);

            if (!needsPostBake && drewDirectlyOnLayerCanvasRef.current) {
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

              const beforeSnapshot = new Map<string, { format: TileFormat; data: Uint8Array | null }>(
                liveBeforeTileSnapshotRef.current
              );
              const tileDeltas = globalTileGrid.computeDeltasFromSnapshot(beforeSnapshot, currentLayerId, dirtyRect);
              enqueueHistoryTask(() => {
                pushHistoryStep(toolForHistory, label, null, null, currentLayerId, dirtyRect, tileDeltas);
              });
            } else {
              if (drewDirectlyOnLayerCanvasRef.current) {
                restoreLiveOrigTilesToCanvas(canvas);
                for (const [numKey, tileImg] of liveOrigCanvasTilesRef.current) {
                  touchedTilesRef.current.add(numKey);
                  const ty = Math.floor(numKey / 65536);
                  const tx = numKey % 65536;
                  globalTileGrid.writeImageData(
                    currentLayerId,
                    tileImg,
                    tx * TILE_SIZE,
                    ty * TILE_SIZE,
                    targetFormat,
                    true
                  );
                }
              }

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

                  const beforeSnapshot = new Map<string, { format: TileFormat; data: Uint8Array | null }>(
                    liveBeforeTileSnapshotRef.current
                  );
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
                  const beforeSnapshot = new Map<string, { format: TileFormat; data: Uint8Array | null }>(
                    liveBeforeTileSnapshotRef.current
                  );
                  const subSnap = globalTileGrid.snapshotTilesInRect(currentLayerId, dirtyRect);
                  for (const [k, v] of subSnap) {
                    if (!beforeSnapshot.has(k)) beforeSnapshot.set(k, v);
                  }

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
      }

      // Synchronously notify tile grid compositor AND synchronously clear draft overlay in the same frame (zero double-alpha flash!)
      globalTileGrid.notifyChange(true);

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
      }
      clearPredictedCanvas();

      if (currentStrokeIdRef.current) {
        onCollabStrokeFinishRef.current?.(
          currentStrokeIdRef.current,
          currentLayerId,
          endPoint,
          dirty ? {
            x: Math.max(0, Math.floor(dirty.minX)),
            y: Math.max(0, Math.floor(dirty.minY)),
            width: Math.max(1, Math.ceil(dirty.maxX) - Math.max(0, Math.floor(dirty.minX))),
            height: Math.max(1, Math.ceil(dirty.maxY) - Math.max(0, Math.floor(dirty.minY))),
          } : undefined,
          createdVectorStroke
        );
        currentStrokeIdRef.current = null;
      }

      isDrawingRef.current = false;
      activePointerIdRef.current = null;
      allStrokePointsRef.current = [];
      strokePointsRef.current = [];
      stabilizedPointRef.current = null;
      lastProcessedPointRef.current = null;
      dirtyRectRef.current = null;
      touchedTilesRef.current.clear();
      pendingPointsQueueRef.current = [];
      drewDirectlyOnLayerCanvasRef.current = false;
      liveStrokeIsolationRef.current = false;
      liveOrigCanvasTilesRef.current.clear();
      liveBeforeTileSnapshotRef.current.clear();
      liveNeedsNotifyRef.current = false;
      isShiftLineStrokeRef.current = false;
      isToneStrokeRef.current = false;
      strokeBackupCanvasRef.current = null;
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
      buildLiveRadialOptions,
      buildLiveTexturedOptions,
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
      restoreLiveOrigTilesToCanvas,
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
