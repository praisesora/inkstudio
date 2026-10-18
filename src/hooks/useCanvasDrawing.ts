import { useRef, useEffect, useState, useCallback } from 'react';
import {
  ToolType,
  BrushSettings,
  Point,
  CanvasDimensions,
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
import { globalTileGrid } from '../utils/tileEngine';
import { globalUndoCache } from '../utils/undoCache';
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
import { enforceColorMode, binarizeCanvasRect, binarizeImageDataBuffer } from '../utils/colorUtils';
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

interface UseCanvasDrawingProps {
  tool: ToolType;
  brushSettings: BrushSettings;
  dimensions: CanvasDimensions;
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
}

export function useCanvasDrawing({
  tool,
  brushSettings,
  dimensions,
  colorMode = 'color',
  disabled = false,
  viewportRef,
  pan,
  zoom,
  rotation,
  activeLayerId,
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

  // Active color mixing reservoir and pre-stroke backup canvas for real-time wet blending/smudging
  const activeReservoirRef = useRef<PaintReservoir | null>(null);
  const layerPixelSamplerRef = useRef<LayerPixelSampler | null>(null);
  const strokeBackupCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dedicatedBackupCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const docDraftCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const getDedicatedBackupCanvas = useCallback((width: number, height: number): HTMLCanvasElement => {
    if (!dedicatedBackupCanvasRef.current) {
      dedicatedBackupCanvasRef.current = document.createElement('canvas');
    }
    const c = dedicatedBackupCanvasRef.current;
    if (c.width !== width || c.height !== height) {
      c.width = width;
      c.height = height;
    }
    return c;
  }, []);

  const getDocDraftCanvas = useCallback((width: number, height: number): HTMLCanvasElement => {
    if (!docDraftCanvasRef.current) {
      docDraftCanvasRef.current = document.createElement('canvas');
    }
    const c = docDraftCanvasRef.current;
    if (c.width !== width || c.height !== height) {
      c.width = width;
      c.height = height;
    }
    return c;
  }, []);

  const isWetColorStrokeRef = useRef<boolean>(false);
  const drewDirectlyOnLayerCanvasRef = useRef<boolean>(false);
  const lastPointTimeRef = useRef<number>(0);
  const recentPointsTrailRef = useRef<{ x: number; y: number; t: number; pressure: number; width: number }[]>([]);
  const strokeTotalDistanceRef = useRef<number>(0);

  // Dirty bounding box for the active stroke
  const dirtyRectRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);
  const lastProcessedPointRef = useRef<{ x: number; y: number } | null>(null);

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
    return () => {
      window.removeEventListener('resize', handleResize);
      if (clearDraftRafRef.current !== null) {
        cancelAnimationFrame(clearDraftRafRef.current);
      }
      if (drawRafIdRef.current !== null) {
        cancelAnimationFrame(drawRafIdRef.current);
      }
    };
  }, []);

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
        const initialThumb = createCanvasThumbnail(canvas, activeLayerIdRef.current !== 'layer-bg');
        const now = Date.now();

        const isMono = colorModeRef.current === 'monochrome';
        globalTileGrid.ingestCanvas(activeLayerIdRef.current, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');

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
      strokeId?: string
    ) => {
      const now = Date.now();
      const canvas = layerCanvasesRef.current.get(targetLayerId) || getActiveCanvas();

      let tileDeltas = explicitTileDeltas;

      const effectiveDirtyRect = dirtyRect || (canvas ? { x: 0, y: 0, width: canvas.width, height: canvas.height } : undefined);

      // Automatically convert ImageData change into minimal SparseTileGrid TileDeltas
      if (!tileDeltas && effectiveDirtyRect && (beforeData || afterData)) {
        const activeLayer = layersRef.current?.find((l) => l.id === targetLayerId);
        const isMono = colorModeRef.current === 'monochrome' || activeLayer?.expressionColor === 'monochrome';
        const targetFormat = isMono ? 'monochrome-1bit' : 'color-32bit';

        const beforeSnapshot = globalTileGrid.snapshotTilesInRect(targetLayerId, effectiveDirtyRect);

        if (afterData) {
          globalTileGrid.writeImageData(targetLayerId, afterData, effectiveDirtyRect.x, effectiveDirtyRect.y, targetFormat);
        } else if (actionType === 'clear') {
          globalTileGrid.clearLayer(targetLayerId);
        }

        tileDeltas = globalTileGrid.computeDeltasFromSnapshot(beforeSnapshot, targetLayerId, effectiveDirtyRect);
      }

      const item: HistoryItem = {
        id: `hist-${now}-${Math.random().toString(36).substring(2, 7)}`,
        type: actionType,
        label,
        timestamp: now,
        timeFormatted: formatTime(now),
        thumbnailUrl: '',
        layerId: targetLayerId,
        // Memory optimization for 600 DPI manga: eliminate large 35MP ImageData arrays in RAM when tile deltas exist
        beforeImageData: tileDeltas ? null : beforeData,
        afterImageData: tileDeltas ? null : afterData,
        imageData: tileDeltas ? undefined : (afterData || undefined),
        dirtyRect: effectiveDirtyRect,
        tileDeltas,
        vectorStrokesDelta: vectorDelta,
        peerId,
        strokeId,
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
      syncHistoryState();

      // Seamless LRU disk cache offloading via Tauri v2 Rust IPC
      if (tileDeltas && tileDeltas.length > 0) {
        globalUndoCache.registerStep(item, historyRef.current).catch((err) => {
          console.warn('[History] LRU cache registration failed:', err);
        });
      }

      // Defer thumbnail generation so stroke release is 100% instant
      requestAnimationFrame(() => {
        if (canvas) {
          item.thumbnailUrl = createCanvasThumbnail(canvas, targetLayerId !== 'layer-bg');
          syncHistoryState();
        }
      });
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
      const runTasks = () => {
        idleCallbackIdRef.current = null;
        const tasks = pendingHistoryTasksRef.current.splice(0);
        for (const t of tasks) {
          try {
            t();
          } catch (err) {
            console.warn('[History] Error running idle history task:', err);
          }
        }
      };
      if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        idleCallbackIdRef.current = (window as any).requestIdleCallback(runTasks, { timeout: 120 });
      } else {
        idleCallbackIdRef.current = setTimeout(runTasks, 0);
      }
    }
  }, []);

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
    if (docDraftCanvasRef.current) {
      const docCtx = get2DContext(docDraftCanvasRef.current);
      docCtx?.clearRect(0, 0, docDraftCanvasRef.current.width, docDraftCanvasRef.current.height);
    }
    clearPredictedCanvas();
    if (drewDirectlyOnLayerCanvasRef.current && strokeBackupCanvasRef.current) {
      const currentLayerId = activeLayerIdRef.current;
      const canvas = layerCanvasesRef.current.get(currentLayerId) || getActiveCanvas();
      if (canvas && strokeBackupCanvasRef.current) {
        const cCtx = get2DContext(canvas);
        if (cCtx) {
          cCtx.clearRect(0, 0, canvas.width, canvas.height);
          cCtx.drawImage(strokeBackupCanvasRef.current, 0, 0);
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
    pendingPointsQueueRef.current = [];
    drewDirectlyOnLayerCanvasRef.current = false;
    isToneStrokeRef.current = false;
    strokeBackupCanvasRef.current = null;
    layerPixelSamplerRef.current = null;
    activeReservoirRef.current = null;
    snapSessionRef.current.endStroke();
    emitConstraintAxisChange(null);
  }, [clearPredictedCanvas, effectiveDraftCanvasRef, emitConstraintAxisChange, getActiveCanvas, layerCanvasesRef]);

  // Jump directly to any past or future history step
  const jumpToHistoryIndex = useCallback(
    async (targetIndex: number) => {
      flushPendingHistoryTasks();
      if (isDrawingRef.current) {
        abortActiveStroke();
      }
      if (targetIndex < 0 || targetIndex >= historyRef.current.length) return;
      const currentIndex = historyIndexRef.current;
      if (targetIndex === currentIndex) return;

      if (targetIndex < currentIndex) {
        // Rolling back (undoing) in reverse chronological order
        for (let i = currentIndex; i > targetIndex; i--) {
          const item = historyRef.current[i];
          if (item) {
            const targetLayerId = item.layerId || activeLayerId;
            const canvas = layerCanvasesRef.current.get(targetLayerId) || getActiveCanvas();
            const sourceCanvas = layerSourceCanvasesRef?.current?.get(targetLayerId);
            const targetLayer = layersRef.current?.find((l) => l.id === targetLayerId);
            const isToneStep = Boolean(targetLayer?.toneEnabled && sourceCanvas);
            const deltas = await globalUndoCache.resolveDeltas(item);

            // Restore vector strokes if vector delta exists
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
                  if (targetLayerId === 'layer-bg') {
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
                  if (item.dirtyRect && item.beforeImageData) {
                    cCtx.putImageData(item.beforeImageData, item.dirtyRect.x, item.dirtyRect.y);
                  } else if (item.beforeImageData) {
                    cCtx.putImageData(item.beforeImageData, 0, 0);
                  } else if (item.type === 'initial') {
                    if (targetLayerId === 'layer-bg') {
                      cCtx.fillStyle = '#ffffff';
                      cCtx.fillRect(0, 0, canvas.width, canvas.height);
                    } else {
                      cCtx.clearRect(0, 0, canvas.width, canvas.height);
                    }
                  }
                }
              }

              // Keep sourceCanvas synchronized if present
              if (sourceCanvas) {
                const sCtx = get2DContext(sourceCanvas);
                if (sCtx) {
                  if (item.dirtyRect && item.beforeImageData) {
                    sCtx.putImageData(item.beforeImageData, item.dirtyRect.x, item.dirtyRect.y);
                  } else if (item.beforeImageData) {
                    sCtx.putImageData(item.beforeImageData, 0, 0);
                  } else if (item.type === 'initial') {
                    if (targetLayerId === 'layer-bg') {
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
            const canvas = layerCanvasesRef.current.get(targetLayerId) || getActiveCanvas();
            const sourceCanvas = layerSourceCanvasesRef?.current?.get(targetLayerId);
            const targetLayer = layersRef.current?.find((l) => l.id === targetLayerId);
            const isToneStep = Boolean(targetLayer?.toneEnabled && sourceCanvas);
            const deltas = await globalUndoCache.resolveDeltas(item);

            // Restore vector strokes if vector delta exists
            if (item.vectorStrokesDelta && targetLayer && canvas) {
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
                  if (targetLayerId === 'layer-bg') {
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
                  if (item.dirtyRect && dataToApply) {
                    cCtx.putImageData(dataToApply, item.dirtyRect.x, item.dirtyRect.y);
                  } else if (dataToApply) {
                    cCtx.putImageData(dataToApply, 0, 0);
                  } else if (item.type === 'initial') {
                    if (targetLayerId === 'layer-bg') {
                      cCtx.fillStyle = '#ffffff';
                      cCtx.fillRect(0, 0, canvas.width, canvas.height);
                    } else {
                      cCtx.clearRect(0, 0, canvas.width, canvas.height);
                    }
                  }
                }
              }

              // Keep sourceCanvas synchronized if present
              if (sourceCanvas) {
                const sCtx = get2DContext(sourceCanvas);
                if (sCtx) {
                  if (item.dirtyRect && dataToApply) {
                    sCtx.putImageData(dataToApply, item.dirtyRect.x, item.dirtyRect.y);
                  } else if (dataToApply) {
                    sCtx.putImageData(dataToApply, 0, 0);
                  } else if (item.type === 'initial') {
                    if (targetLayerId === 'layer-bg') {
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
    },
    [abortActiveStroke, activeLayerId, flushPendingHistoryTasks, getActiveCanvas, layerCanvasesRef, layerSourceCanvasesRef, onUpdateLayerThumbnail, syncHistoryState]
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

    if (activeLayerId === 'layer-bg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    const sourceCanvas = layerSourceCanvasesRef?.current?.get(activeLayerId);
    if (sourceCanvas) {
      const sCtx = get2DContext(sourceCanvas);
      if (sCtx) {
        if (activeLayerId === 'layer-bg') {
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

  // Render a single smooth segment onto the draft overlay context using Catmull-Rom cubic splines
  const renderDraftSegment = useCallback((draftCtx: CanvasRenderingContext2D, point: Point) => {
    const pts = strokePointsRef.current;

    const isEraser = toolRef.current === 'eraser';
    const isBgEraser = isEraser && activeLayerIdRef.current === 'layer-bg';
    const bs = brushSettingsRef.current;
    const mode = colorModeRef.current;
    const isPencil = !isEraser && (bs.preset?.startsWith('pencil') ?? false);
    const canvas = getActiveCanvas();
    const currentLayerId = activeLayerIdRef.current;
    const activeLayer = layersRef.current?.find((l) => l.id === currentLayerId);
    const isToneLayer = Boolean(activeLayer?.toneEnabled);
    const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
    const isMonochrome = mode === 'monochrome' || isMonoLayer;
    const isTone = isToneStrokeRef.current;
    const sourceCanvas = isTone ? layerSourceCanvasesRef?.current?.get(currentLayerId) : null;

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
    const strokeFlow = bs.flow ?? 1.0;
    const strokeSpacing = bs.spacing ?? 0.08;

    const renderSegmentToContext = (ctx: CanvasRenderingContext2D, sStart: Point, c1Pt: Point, c2Pt: Point, sEnd: Point): number => {
      if (bs.customTipImage) {
        const tipOptions: TexturedBrushOptions = {
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
          velocityCurve: bs.velocityCurve,
          usePressure: bs.usePressure,
          useVelocity: bs.useVelocity,
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
          wetEdge: bs.wetEdge,
          wetEdgeRadius: bs.wetEdgeRadius,
          wetEdgeAlphaPower: bs.wetEdgeAlphaPower,
          wetEdgeValuePower: bs.wetEdgeValuePower,
          grain: bs.grain ?? bs.textureDensity,
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
          isEraser: isEraser && !isBgEraser,
          isBgEraser,
          alphaLocked: Boolean(activeLayer?.alphaLocked),
          isTransparentInk: Boolean(bs.isTransparentInk),
          currentStrokeDist: strokeTotalDistanceRef.current,
          dynamics: bs.dynamics,
          secondaryColor: bs.secondaryColor,
        };

        return drawTexturedCubicBezierSegment(
          ctx,
          sStart,
          c1Pt,
          c2Pt,
          sEnd,
          strokeColor,
          bs.customTipImage,
          tipOptions,
          stampRemainderDistRef.current
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
          bs.flow ?? 0.74,
          bs.grain ?? 1.0,
          bs.hardness,
          stampRemainderDistRef.current,
          Boolean(activeLayer?.alphaLocked),
          Boolean(bs.isTransparentInk)
        );
      } else {
        const radialMixingOptions: RadialMixingOptions = {
          colorMixing: bs.colorMixing,
          perceptualMixing: bs.perceptualMixing,
          amountOfPaint: bs.amountOfPaint,
          densityOfPaint: bs.densityOfPaint,
          colorStretch: bs.colorStretch,
          mixingMode: bs.mixingMode,
          underlyingCanvas: canvas || undefined,
          sampler: layerPixelSamplerRef.current || undefined,
          reservoir: activeReservoirRef.current || undefined,
          alphaLocked: Boolean(activeLayer?.alphaLocked),
          isTransparentInk: Boolean(bs.isTransparentInk),
          dynamics: bs.dynamics,
          secondaryColor: bs.secondaryColor,
          useGpu: bs.useGpu,
          dualBrush: bs.dualBrush,
          dualTipImage: bs.dualTipImage,
          dualBrushCompositeMode: bs.dualBrushCompositeMode,
        };
        return drawSmoothCubicBezierSegment(
          ctx,
          sStart,
          c1Pt,
          c2Pt,
          sEnd,
          strokeColor,
          isEraser && !isBgEraser,
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

    if (isEraser) {
      drewDirectlyOnLayerCanvasRef.current = true;
      if (canvas) {
        const cCtx = get2DContext(canvas);
        if (cCtx) {
          drawSmoothCubicBezierSegment(
            cCtx,
            segStart,
            c1,
            c2,
            segEnd,
            strokeColor,
            !isBgEraser,
            strokeHardness,
            strokeFlow,
            strokeSpacing
          );
        }
      }
      if (isToneLayer && sourceCanvas) {
        const sCtx = get2DContext(sourceCanvas);
        if (sCtx) {
          drawSmoothCubicBezierSegment(
            sCtx,
            segStart,
            c1,
            c2,
            segEnd,
            strokeColor,
            !isBgEraser,
            strokeHardness,
            strokeFlow,
            strokeSpacing
          );
        }
      }

      // Eraser path preview on draft overlay
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

    // Single-pass document draft rendering + dirty-ROI blit to draft overlay (50% less CPU/GPU work & 100% identical scatter/reservoir state)
    drewDirectlyOnLayerCanvasRef.current = false;
    const docDraftCanvas = docDraftCanvasRef.current;
    const docCtx = docDraftCanvas ? get2DContext(docDraftCanvas) : null;
    if (docCtx && docDraftCanvas) {
      stampRemainderDistRef.current = renderSegmentToContext(docCtx, segStart, c1, c2, segEnd);
      const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
      const maxW = Math.max(segStart.width, segEnd.width, bs.size || 10) * (1.5 + scatterFactor * 2) + 24;
      const sx = Math.max(0, Math.floor(Math.min(segStart.x, c1.x, c2.x, segEnd.x) - maxW));
      const sy = Math.max(0, Math.floor(Math.min(segStart.y, c1.y, c2.y, segEnd.y) - maxW));
      const ex = Math.min(docDraftCanvas.width, Math.ceil(Math.max(segStart.x, c1.x, c2.x, segEnd.x) + maxW));
      const ey = Math.min(docDraftCanvas.height, Math.ceil(Math.max(segStart.y, c1.y, c2.y, segEnd.y) + maxW));
      const sw = ex - sx;
      const sh = ey - sy;
      if (sw > 0 && sh > 0) {
        draftCtx.clearRect(sx, sy, sw, sh);
        draftCtx.drawImage(docDraftCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
      }
    } else {
      stampRemainderDistRef.current = renderSegmentToContext(draftCtx, segStart, c1, c2, segEnd);
    }
  }, [getActiveCanvas]);

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

      let pt: Point;
      if (stab <= 0) {
        const mappedP = bs.usePressure ? taperEngineRef.current.mapPressure(rawPressure) : (rawPressure > 0 ? 1.0 : 0);
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
        const mappedP = bs.usePressure ? taperEngineRef.current.mapPressure(sample.pressure) : (rawPressure > 0 ? 1.0 : 0);
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

  // Low-latency speculative predicted tip overlay with tangent/distance guard to prevent stray streaks
  const renderPredictedStroke = useCallback(
    (predEvents: PointerEvent[], vRect: DOMRect) => {
      clearPredictedCanvas();
      if (!predEvents || predEvents.length === 0 || toolRef.current === 'eraser') return;
      const pCanvas = getPredictedCanvas();
      const lastPt = stabilizedPointRef.current;
      if (!pCanvas || !lastPt) return;
      const pCtx = get2DContext(pCanvas);
      if (!pCtx) return;

      const bs = brushSettingsRef.current;
      const dims = dimensionsRef.current;
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
      const dx = rawPred.x - lastPt.x;
      const dy = rawPred.y - lastPt.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.5 || dist > maxPredDist * 2.5) return;

      const clampedScale = dist > maxPredDist ? maxPredDist / dist : 1.0;
      const targetX = lastPt.x + dx * clampedScale;
      const targetY = lastPt.y + dy * clampedScale;

      pCtx.save();
      pCtx.globalAlpha = Math.min(0.65, (bs.opacity ?? 1.0) * 0.65);
      pCtx.strokeStyle = bs.color || '#000000';
      pCtx.lineCap = 'round';
      pCtx.lineWidth = Math.max(0.5, lastPt.width * 0.85);
      pCtx.beginPath();
      pCtx.moveTo(lastPt.x, lastPt.y);
      pCtx.lineTo(targetX, targetY);
      pCtx.stroke();
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

      clearPredictedCanvas();

      const isEraser = toolRef.current === 'eraser';
      const isBgEraser = isEraser && activeLayerIdRef.current === 'layer-bg';

      const currentLayerId = activeLayerIdRef.current;
      const activeLayer = layersRef.current?.find((l) => l.id === currentLayerId);
      const bs = brushSettingsRef.current;
      const mode = colorModeRef.current;
      const isPencil = !isEraser && (bs.preset?.startsWith('pencil') ?? false);

      const isToneLayer = Boolean(activeLayer?.toneEnabled);
      const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
      const isMonochrome = mode === 'monochrome' || isMonoLayer;
      const isTone = Boolean(
        activeLayer?.toneEnabled ||
        activeLayer?.layerColorEnabled ||
        (activeLayer?.expressionColor && activeLayer.expressionColor !== 'color')
      );
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

      allStrokePointsRef.current = [startPoint];
      strokePointsRef.current = [startPoint];
      inputStabilizerRef.current.reset();
      inputStabilizerRef.current.setStabilizerLevel(bs.stabilization ?? 0);
      taperEngineRef.current.reset();
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
      strokeTotalDistanceRef.current = 0;

      if (events.length > 1) {
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

      const blurMargin = (1 - (bs.hardness ?? 1.0)) * (startPoint.width * 1.5);
      const r = Math.max(32, Math.ceil(startPoint.width + blurMargin + 32));
      dirtyRectRef.current = {
        minX: Math.max(0, Math.floor(startPoint.x - r)),
        minY: Math.max(0, Math.floor(startPoint.y - r)),
        maxX: Math.min(dims.width, Math.ceil(startPoint.x + r)),
        maxY: Math.min(dims.height, Math.ceil(startPoint.y + r)),
      };

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
      const strokeFlow = bs.flow ?? 1.0;

      const isWetColor = !isEraser && Boolean(bs.colorMixing);
      isWetColorStrokeRef.current = isWetColor;
      drewDirectlyOnLayerCanvasRef.current = false;

      if (isToneLayer && sourceCanvas) {
        const backupCanvas = getDedicatedBackupCanvas(sourceCanvas.width, sourceCanvas.height);
        const backupCtx = get2DContext(backupCanvas);
        if (backupCtx) {
          backupCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
          backupCtx.drawImage(sourceCanvas, 0, 0);
          strokeBackupCanvasRef.current = backupCanvas;
        }
        layerPixelSamplerRef.current = null;
        activeReservoirRef.current = null;
      } else if (isEraser && canvas) {
        const backupCanvas = getDedicatedBackupCanvas(canvas.width, canvas.height);
        const backupCtx = get2DContext(backupCanvas);
        if (backupCtx) {
          backupCtx.clearRect(0, 0, canvas.width, canvas.height);
          backupCtx.drawImage(canvas, 0, 0);
          strokeBackupCanvasRef.current = backupCanvas;
        }
        layerPixelSamplerRef.current = null;
        activeReservoirRef.current = null;
      } else {
        strokeBackupCanvasRef.current = null;
        if (isWetColor && canvas) {
          layerPixelSamplerRef.current = new LayerPixelSampler(canvas, activeLayerIdRef.current);
          activeReservoirRef.current = new PaintReservoir(strokeColor);
        } else {
          layerPixelSamplerRef.current = null;
          activeReservoirRef.current = null;
        }
      }

      const strokeId = `stroke-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      currentStrokeIdRef.current = strokeId;
      onCollabStrokeStartRef.current?.(strokeId, activeLayerIdRef.current, bs, toolRef.current, startPoint);

      stampRemainderDistRef.current = Math.max(0.2, startPoint.width * (bs.spacing ?? 0.08));

      if (isEraser) {
        drewDirectlyOnLayerCanvasRef.current = true;
        if (canvas) {
          const cCtx = get2DContext(canvas);
          if (cCtx) {
            drawDot(cCtx, startPoint, strokeColor, !isBgEraser, strokeHardness, strokeFlow);
          }
        }
        if (isToneLayer && sourceCanvas) {
          const sCtx = get2DContext(sourceCanvas);
          if (sCtx) {
            drawDot(sCtx, startPoint, strokeColor, !isBgEraser, strokeHardness, strokeFlow);
          }
        }
        draftCtx.save();
        draftCtx.strokeStyle = 'rgba(255, 80, 80, 0.75)';
        draftCtx.setLineDash([3, 3]);
        draftCtx.lineWidth = 1.5;
        draftCtx.beginPath();
        draftCtx.arc(startPoint.x, startPoint.y, Math.max(1, startPoint.width / 2), 0, Math.PI * 2);
        draftCtx.stroke();
        draftCtx.restore();
      } else {
        drewDirectlyOnLayerCanvasRef.current = false;
        const docDraft = canvas ? getDocDraftCanvas(canvas.width, canvas.height) : null;
        const docCtx = docDraft ? get2DContext(docDraft) : null;
        if (docCtx && canvas) {
          docCtx.clearRect(0, 0, canvas.width, canvas.height);
        }

        const primaryTargetCtx = docCtx || draftCtx;
        if (bs.customTipImage) {
          const tipOptions: TexturedBrushOptions = {
            size: bs.size,
            minSizeFactor: bs.minSizeFactor,
            opacity: bs.opacity,
            flow: bs.flow ?? 0.85,
            spacing: bs.spacing ?? 0.08,
            thickness: bs.thickness,
            thicknessVertical: bs.thicknessVertical,
            angle: bs.customTipAngle,
            angleDynamics: bs.customTipAngleDynamics,
            rotationRandomScale: bs.customTipRotationRandomScale,
            hardness: strokeHardness,
            antiAlias: isMonochrome ? 0 : bs.antiAlias,
            pressureCurve: bs.pressureCurve,
            velocityCurve: bs.velocityCurve,
            useVelocity: bs.useVelocity,
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
            wetEdge: bs.wetEdge,
            wetEdgeRadius: bs.wetEdgeRadius,
            wetEdgeAlphaPower: bs.wetEdgeAlphaPower,
            wetEdgeValuePower: bs.wetEdgeValuePower,
            grain: bs.grain ?? bs.textureDensity,
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
            isEraser: false,
            isBgEraser: false,
            alphaLocked: Boolean(activeLayer?.alphaLocked),
            isTransparentInk: Boolean(bs.isTransparentInk),
            dynamics: bs.dynamics,
            secondaryColor: bs.secondaryColor,
          };
          drawTexturedDot(primaryTargetCtx, startPoint, strokeColor, bs.customTipImage, tipOptions);
        } else if (isPencil) {
          const grade = (bs.preset as PencilGrade) || 'pencil-2b';
          drawPencilDot(
            primaryTargetCtx,
            startPoint,
            strokeColor,
            grade,
            bs.flow ?? 0.74,
            bs.grain ?? 1.0,
            bs.hardness,
            Boolean(activeLayer?.alphaLocked),
            Boolean(bs.isTransparentInk)
          );
        } else {
          const radialMixingOptions: RadialMixingOptions = {
            colorMixing: bs.colorMixing,
            perceptualMixing: bs.perceptualMixing,
            amountOfPaint: bs.amountOfPaint,
            densityOfPaint: bs.densityOfPaint,
            colorStretch: bs.colorStretch,
            mixingMode: bs.mixingMode,
            underlyingCanvas: canvas || undefined,
            sampler: layerPixelSamplerRef.current || undefined,
            reservoir: activeReservoirRef.current || undefined,
            alphaLocked: Boolean(activeLayer?.alphaLocked),
            isTransparentInk: Boolean(bs.isTransparentInk),
            dynamics: bs.dynamics,
            secondaryColor: bs.secondaryColor,
            useGpu: bs.useGpu,
            dualBrush: bs.dualBrush,
            dualTipImage: bs.dualTipImage,
            dualBrushCompositeMode: bs.dualBrushCompositeMode,
          };
          drawDot(
            primaryTargetCtx,
            startPoint,
            strokeColor,
            false,
            strokeHardness,
            bs.flow ?? 1.0,
            radialMixingOptions
          );
        }

        if (docCtx && docDraft) {
          const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
          const pad = Math.max(startPoint.width, bs.size || 10) * (1.5 + scatterFactor * 2) + 24;
          const sx = Math.max(0, Math.floor(startPoint.x - pad));
          const sy = Math.max(0, Math.floor(startPoint.y - pad));
          const ex = Math.min(docDraft.width, Math.ceil(startPoint.x + pad));
          const ey = Math.min(docDraft.height, Math.ceil(startPoint.y + pad));
          const sw = ex - sx;
          const sh = ey - sy;
          if (sw > 0 && sh > 0) {
            draftCtx.drawImage(docDraft, sx, sy, sw, sh, sx, sy, sw, sh);
          }
        }
      }

      if (isEraser && isMonochrome && canvas && dirtyRectRef.current) {
        const dotDirty = dirtyRectRef.current;
        const dw = dotDirty.maxX - dotDirty.minX;
        const dh = dotDirty.maxY - dotDirty.minY;
        if (dw > 0 && dh > 0) {
          binarizeCanvasRect(
            get2DContext(canvas)!,
            { x: dotDirty.minX, y: dotDirty.minY, width: dw, height: dh },
            activeLayer?.monoThreshold ?? 128,
            activeLayer?.monoExpressBlack ?? true,
            activeLayer?.monoExpressWhite ?? true
          );
          if (sourceCanvas) {
            const sCtx = get2DContext(sourceCanvas);
            sCtx?.drawImage(canvas, dotDirty.minX, dotDirty.minY, dw, dh, dotDirty.minX, dotDirty.minY, dw, dh);
          }
        }
      } else if (isEraser && isToneLayer && sourceCanvas && canvas && activeLayer) {
        applyLayerEffects(
          sourceCanvas,
          canvas,
          activeLayer,
          dims.dpi ?? 600,
          {
            x: dirtyRectRef.current.minX,
            y: dirtyRectRef.current.minY,
            width: dirtyRectRef.current.maxX - dirtyRectRef.current.minX,
            height: dirtyRectRef.current.maxY - dirtyRectRef.current.minY,
          }
        );
      }
      if (pendingPointsQueueRef.current.length > 0 && drawRafIdRef.current === null) {
        drawRafIdRef.current = requestAnimationFrame(flushPendingPoints);
      }
    },
    [clearPredictedCanvas, disabled, dispatchPointerStat, effectiveDraftCanvasRef, emitConstraintAxisChange, flushPendingHistoryTasks, flushPendingPoints, getActiveCanvas, getCanvasPoint, getDocDraftCanvas, getPredictedCanvas, getViewportRect, viewportRef]
  );

  // Pointer Move handler: throttled & batched coordinate ingestion via rAF with coalesced and predicted events
  const handlePointerMove = useCallback(
    (
      e: React.PointerEvent<HTMLElement>,
      coalescedEvents?: PointerEvent[],
      _predictedEvents?: PointerEvent[]
    ) => {
      const point = getCanvasPoint(e);
      dispatchPointerStat(point.x, point.y, point.pressure);
      onCollabCursorMoveRef.current?.(point.x, point.y, isDrawingRef.current, toolRef.current);

      if (!isDrawingRef.current || e.pointerId !== activePointerIdRef.current) {
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

      const draftCanvas = effectiveDraftCanvasRef?.current;
      const draftCtx = draftCanvas ? get2DContext(draftCanvas) : null;

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
        const cx = snapRes.x;
        const cy = snapRes.y;
        if (snapRes.axis) {
          emitConstraintAxisChange(snapRes.axis);
        }

        const last = lastProcessedPointRef.current;
        if (last && Math.hypot(cx - last.x, cy - last.y) < 0.25) {
          continue;
        }

        lastProcessedPointRef.current = { x: cx, y: cy };
        let cPressure = 0;
        if (cEvent.pointerType === 'mouse') {
          cPressure = (cEvent.buttons & 1) ? 0.5 : 0;
        } else {
          cPressure = cEvent.pressure !== undefined ? Math.max(0, Math.min(1.0, cEvent.pressure)) : 0;
        }

        // Render segment immediately on draft canvas for zero-latency stylus tracking (CSP style)
        if (draftCtx) {
          applyStabilizedPointAndRender(
            draftCtx,
            cx,
            cy,
            cPressure,
            cEvent.pointerType,
            cEvent.tiltX ?? 0,
            cEvent.tiltY ?? 0,
            cEvent.twist ?? 0,
            cEvent.timeStamp
          );
        }
      }
    },
    [applyStabilizedPointAndRender, dispatchPointerStat, effectiveDraftCanvasRef, emitConstraintAxisChange, getCanvasPoint, getViewportRect]
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

      // Finalize tail segment on draft canvas using Catmull-Rom cubic Bézier
      const pts = strokePointsRef.current;
      const currentTool = toolRef.current;
      const currentLayerId = activeLayerIdRef.current;
      const isEraser = currentTool === 'eraser';
      const isBgEraser = isEraser && currentLayerId === 'layer-bg';
      const mode = colorModeRef.current;
      const isPencil = !isEraser && (bs.preset?.startsWith('pencil') ?? false);

      const isTone = isToneStrokeRef.current;
      const activeLayer = layersRef.current?.find((l) => l.id === currentLayerId);
      const isToneLayer = Boolean(activeLayer?.toneEnabled);
      const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
      const isMonochrome = mode === 'monochrome' || isMonoLayer;
      const sourceCanvas = isTone ? layerSourceCanvasesRef?.current?.get(currentLayerId) : null;
      const targetTailCtx = isToneLayer && sourceCanvas
        ? get2DContext(sourceCanvas)
        : (drewDirectlyOnLayerCanvasRef.current && canvas ? get2DContext(canvas) : draftCtx);

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

      if (targetTailCtx && pts.length >= 2) {
        const pLast = pts[pts.length - 1];
        const pPrev = pts[pts.length - 2];
        const pPrev2 = pts.length >= 3 ? pts[pts.length - 3] : pPrev;

        // If stylus pen is lifted, naturally taper pressure to 0 at release point
        if (bs.usePressure && e.pointerType === 'pen') {
          pLast.pressure = 0;
          pLast.width = Math.max(0.1, bs.size * (bs.minSizeFactor ?? 0));
        }

        const { c1, c2 } = catmullRomToBezier(pPrev2, pPrev, pLast, pLast);
        const docCtx = (!isEraser && docDraftCanvasRef.current) ? get2DContext(docDraftCanvasRef.current) : null;

        if (bs.customTipImage) {
          const tipOptions: TexturedBrushOptions = {
            size: bs.size,
            minSizeFactor: bs.minSizeFactor,
            opacity: bs.opacity,
            flow: bs.flow ?? 0.85,
            spacing: bs.spacing ?? 0.08,
            thickness: bs.thickness,
            thicknessVertical: bs.thicknessVertical,
            angle: bs.customTipAngle,
            angleDynamics: bs.customTipAngleDynamics,
            rotationRandomScale: bs.customTipRotationRandomScale,
            hardness: strokeHardness,
            antiAlias: isMonochrome ? 0 : bs.antiAlias,
            pressureCurve: bs.pressureCurve,
            velocityCurve: bs.velocityCurve,
            usePressure: bs.usePressure,
            useVelocity: bs.useVelocity,
            subTips: bs.subTips,
            subTipOrder: bs.subTipOrder,
            subTipImages: bs.subTipImages,
            spray: bs.spray,
            taper: bs.taper,
            colorMixing: bs.colorMixing,
            amountOfPaint: bs.amountOfPaint,
            densityOfPaint: bs.densityOfPaint,
            colorStretch: bs.colorStretch,
            mixingMode: bs.mixingMode,
            wetEdge: bs.wetEdge,
            wetEdgeRadius: bs.wetEdgeRadius,
            wetEdgeAlphaPower: bs.wetEdgeAlphaPower,
            wetEdgeValuePower: bs.wetEdgeValuePower,
            grain: bs.grain ?? bs.textureDensity,
            paperTextureImage: bs.paperTextureImage,
            paperTextureScale: bs.paperTextureScale,
            paperTextureRotate: bs.paperTextureRotate,
            useGpu: bs.useGpu,
            underlyingCanvas: canvas || undefined,
            sampler: layerPixelSamplerRef.current || undefined,
            reservoir: activeReservoirRef.current || undefined,
            isEraser: isEraser && !isBgEraser,
            isBgEraser,
            alphaLocked: Boolean(activeLayer?.alphaLocked),
            isTransparentInk: Boolean(bs.isTransparentInk),
            currentStrokeDist: strokeTotalDistanceRef.current,
            dynamics: bs.dynamics,
            secondaryColor: bs.secondaryColor,
          };
          drawTexturedCubicBezierSegment(
            targetTailCtx,
            pPrev,
            c1,
            c2,
            pLast,
            strokeColor,
            bs.customTipImage,
            tipOptions,
            stampRemainderDistRef.current
          );
          if (docCtx) {
            drawTexturedCubicBezierSegment(
              docCtx,
              pPrev,
              c1,
              c2,
              pLast,
              strokeColor,
              bs.customTipImage,
              tipOptions,
              stampRemainderDistRef.current
            );
          }
        } else if (isPencil) {
          const grade = (bs.preset as PencilGrade) || 'pencil-2b';
          drawPencilCubicBezierSegment(
            targetTailCtx,
            pPrev,
            c1,
            c2,
            pLast,
            strokeColor,
            grade,
            bs.flow ?? 0.74,
            bs.grain ?? 1.0,
            bs.hardness,
            stampRemainderDistRef.current,
            Boolean(activeLayer?.alphaLocked),
            Boolean(bs.isTransparentInk)
          );
          if (docCtx) {
            drawPencilCubicBezierSegment(
              docCtx,
              pPrev,
              c1,
              c2,
              pLast,
              strokeColor,
              grade,
              bs.flow ?? 0.74,
              bs.grain ?? 1.0,
              bs.hardness,
              stampRemainderDistRef.current,
              Boolean(activeLayer?.alphaLocked),
              Boolean(bs.isTransparentInk)
            );
          }
        } else {
          const radialMixingOptions: RadialMixingOptions = {
            colorMixing: bs.colorMixing,
            amountOfPaint: bs.amountOfPaint,
            densityOfPaint: bs.densityOfPaint,
            colorStretch: bs.colorStretch,
            mixingMode: bs.mixingMode,
            underlyingCanvas: canvas || undefined,
            sampler: layerPixelSamplerRef.current || undefined,
            reservoir: activeReservoirRef.current || undefined,
            alphaLocked: Boolean(activeLayer?.alphaLocked),
            isTransparentInk: Boolean(bs.isTransparentInk),
            dynamics: bs.dynamics,
            secondaryColor: bs.secondaryColor,
          };
          drawSmoothCubicBezierSegment(
            targetTailCtx,
            pPrev,
            c1,
            c2,
            pLast,
            strokeColor,
            isEraser && !isBgEraser,
            strokeHardness,
            bs.flow ?? 1.0,
            bs.spacing ?? 0.06,
            stampRemainderDistRef.current,
            bs.thickness ?? 1.0,
            ((bs.customTipAngle ?? 0) * Math.PI) / 180,
            radialMixingOptions
          );
          if (docCtx) {
            drawSmoothCubicBezierSegment(
              docCtx,
              pPrev,
              c1,
              c2,
              pLast,
              strokeColor,
              false,
              strokeHardness,
              bs.flow ?? 1.0,
              bs.spacing ?? 0.06,
              stampRemainderDistRef.current,
              bs.thickness ?? 1.0,
              ((bs.customTipAngle ?? 0) * Math.PI) / 180,
              radialMixingOptions
            );
          }
        }

        if (isEraser && draftCtx) {
          draftCtx.save();
          draftCtx.lineCap = 'round';
          draftCtx.lineJoin = 'round';
          draftCtx.setLineDash([4, 4]);
          draftCtx.strokeStyle = 'rgba(255, 80, 80, 0.75)';
          draftCtx.lineWidth = Math.max(1, (pPrev.width + pLast.width) / 2);
          draftCtx.beginPath();
          draftCtx.moveTo(pPrev.x, pPrev.y);
          draftCtx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, pLast.x, pLast.y);
          draftCtx.stroke();
          draftCtx.restore();
        }
      }

      if (pts.length >= 2) {
        const pLast = pts[pts.length - 1];
        const pPrev = pts[pts.length - 2];
        const tailMargin = Math.ceil(Math.max(pLast.width, pPrev.width) * 1.5 + 32);
        const tMinX = Math.max(0, Math.floor(Math.min(pLast.x, pPrev.x) - tailMargin));
        const tMinY = Math.max(0, Math.floor(Math.min(pLast.y, pPrev.y) - tailMargin));
        const tMaxX = Math.min(canvas ? canvas.width : dimensionsRef.current.width, Math.ceil(Math.max(pLast.x, pPrev.x) + tailMargin));
        const tMaxY = Math.min(canvas ? canvas.height : dimensionsRef.current.height, Math.ceil(Math.max(pLast.y, pPrev.y) + tailMargin));

        if (dirtyRectRef.current) {
          dirtyRectRef.current.minX = Math.min(dirtyRectRef.current.minX, tMinX);
          dirtyRectRef.current.minY = Math.min(dirtyRectRef.current.minY, tMinY);
          dirtyRectRef.current.maxX = Math.max(dirtyRectRef.current.maxX, tMaxX);
          dirtyRectRef.current.maxY = Math.max(dirtyRectRef.current.maxY, tMaxY);
        }

        if (isEraser && isMonochrome && canvas && dirtyRectRef.current) {
          const eDirty = dirtyRectRef.current;
          const eMinX = Math.max(0, Math.floor(eDirty.minX));
          const eMinY = Math.max(0, Math.floor(eDirty.minY));
          const eMaxX = Math.min(canvas.width, Math.ceil(eDirty.maxX));
          const eMaxY = Math.min(canvas.height, Math.ceil(eDirty.maxY));
          const eW = eMaxX - eMinX;
          const eH = eMaxY - eMinY;
          if (eW > 0 && eH > 0) {
            const cCtx = get2DContext(canvas);
            if (cCtx) {
              binarizeCanvasRect(
                cCtx,
                { x: eMinX, y: eMinY, width: eW, height: eH },
                activeLayer?.monoThreshold ?? 128,
                activeLayer?.monoExpressBlack ?? true,
                activeLayer?.monoExpressWhite ?? true
              );
            }
            if (sourceCanvas) {
              const sCtx = get2DContext(sourceCanvas);
              sCtx?.drawImage(canvas, eMinX, eMinY, eW, eH, eMinX, eMinY, eW, eH);
            }
          }
        }
      }

      // BAKE STROKE INTO HIGH-RESOLUTION BASE CANVAS (Dirty Rect only)
      const dirty = dirtyRectRef.current;

      if (isEraser && isToneLayer && sourceCanvas && canvas) {
        if (activeLayer) {
          const freq = activeLayer?.toneFrequency ?? 60;
          const cellSize = Math.max(3.5, (dimensionsRef.current.dpi ?? 600) / freq);
          const cellMargin = Math.ceil(cellSize * 2 + 32);
          applyLayerEffects(
            sourceCanvas,
            canvas,
            activeLayer,
            dimensionsRef.current.dpi ?? 600,
            dirty ? {
              x: Math.max(0, Math.floor(dirty.minX - cellMargin)),
              y: Math.max(0, Math.floor(dirty.minY - cellMargin)),
              width: Math.min(canvas.width, Math.ceil(dirty.maxX + cellMargin)) - Math.max(0, Math.floor(dirty.minX - cellMargin)),
              height: Math.min(canvas.height, Math.ceil(dirty.maxY + cellMargin)) - Math.max(0, Math.floor(dirty.minY - cellMargin)),
            } : undefined
          );
        }
      }
      let exitSpeed = 0;
      if (recentPointsTrailRef.current.length >= 2) {
        const trail = recentPointsTrailRef.current;
        const sampleIdx = Math.max(0, trail.length - 4);
        const pA = trail[sampleIdx];
        const pB = trail[trail.length - 1];
        const dt = Math.max(1, pB.t - pA.t);
        const dist = Math.hypot(pB.x - pA.x, pB.y - pA.y);
        exitSpeed = dist / dt;
      }

      const shouldTaperOut = (bs.usePressure && e.pointerType === 'pen') || exitSpeed > 0.5 || Boolean(bs.taper?.useOut) || Boolean(bs.velocityDynamics);
      if (shouldTaperOut && allStrokePointsRef.current.length >= 3) {
        applyParametricTaper(allStrokePointsRef.current, {
          useIn: Boolean(bs.taper?.useIn),
          useOut: true,
          minSizeFactor: bs.minSizeFactor,
          exitSpeed,
        });
      }

      const allPoints = allStrokePointsRef.current;
      let createdVectorStroke: VectorStroke | undefined;

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
        const pad = Math.ceil(Math.max(32, (bs.size || 10) * 1.5));
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

            const docDraft = docDraftCanvasRef.current;
            const dirtyRect = { x: sx, y: sy, width: dw, height: dh };
            const toolForHistory = currentTool === 'eraser' ? 'eraser' : (isPencil ? 'pencil' : 'brush');

            if (isEraser && strokeBackupCanvasRef.current) {
              // Synchronize dirty bounding box to sourceCanvas so tone can be toggled without losing edits
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

              // Synchronously snapshot and write committed tiles to globalTileGrid
              const targetFormat = isMonochrome ? 'monochrome-1bit' : 'color-32bit';
              const beforeSnapshot = globalTileGrid.snapshotTilesInRect(currentLayerId, dirtyRect);
              const afterData = ctx.getImageData(sx, sy, dw, dh);
              globalTileGrid.writeImageData(currentLayerId, afterData, sx, sy, targetFormat);

              // Offload history step and tile delta generation to background task
              enqueueHistoryTask(() => {
                const tileDeltas = globalTileGrid.computeDeltasFromSnapshot(beforeSnapshot, currentLayerId, dirtyRect);
                pushHistoryStep('eraser', label, null, null, currentLayerId, dirtyRect, tileDeltas);
              });
            } else if (isToneLayer && sourceCanvas) {
              const sCtx = get2DContext(sourceCanvas);
              if (sCtx) {
                sCtx.save();
                sCtx.beginPath();
                sCtx.rect(sx, sy, dw, dh);
                sCtx.clip();
                sCtx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.opacity ?? 1.0));
                if (bs.isTransparentInk) {
                  sCtx.globalCompositeOperation = 'destination-out';
                } else if (activeLayer?.alphaLocked) {
                  sCtx.globalCompositeOperation = 'source-atop';
                } else {
                  sCtx.globalCompositeOperation = 'source-over';
                }

                if (docDraft) {
                  sCtx.drawImage(docDraft, sx, sy, dw, dh, sx, sy, dw, dh);
                } else {
                  const bakeCanvas = getReusableBakeCanvas(dw, dh);
                  const bCtxBake = bakeCanvas.getContext('2d', { alpha: true });
                  if (bCtxBake) {
                    bCtxBake.clearRect(0, 0, bakeCanvas.width, bakeCanvas.height);
                    bCtxBake.save();
                    bCtxBake.translate(-sx, -sy);
                    renderCompleteStroke(bCtxBake, allPoints, bs, currentTool, mode, isBgEraser, sourceCanvas, Boolean(activeLayer?.alphaLocked));
                    bCtxBake.restore();
                    sCtx.drawImage(bakeCanvas, 0, 0, dw, dh, sx, sy, dw, dh);
                  }
                }
                sCtx.restore();
              }

              if (activeLayer) {
                applyLayerEffects(
                  sourceCanvas,
                  canvas,
                  activeLayer,
                  dimensionsRef.current.dpi ?? 600,
                  { x: sx, y: sy, width: dw, height: dh }
                );
              }

              if (docDraft) {
                const dCtx = get2DContext(docDraft);
                dCtx?.clearRect(sx, sy, dw, dh);
              }

              // Synchronously snapshot and write committed tiles to globalTileGrid
              const targetFormat = isMonochrome ? 'monochrome-1bit' : 'color-32bit';
              const beforeSnapshot = globalTileGrid.snapshotTilesInRect(currentLayerId, dirtyRect);
              const afterData = sCtx ? sCtx.getImageData(sx, sy, dw, dh) : null;
              if (afterData) {
                globalTileGrid.writeImageData(currentLayerId, afterData, sx, sy, targetFormat);
              }

              enqueueHistoryTask(() => {
                const tileDeltas = globalTileGrid.computeDeltasFromSnapshot(beforeSnapshot, currentLayerId, dirtyRect);
                pushHistoryStep(toolForHistory, label, null, null, currentLayerId, dirtyRect, tileDeltas);
              });
            } else {
              // Direct zero-stall GPU blit from docDraft to layer canvas (<0.2 ms)
              ctx.save();
              ctx.beginPath();
              ctx.rect(sx, sy, dw, dh);
              ctx.clip();

              ctx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.opacity ?? 1.0));
              if (bs.isTransparentInk) {
                ctx.globalCompositeOperation = 'destination-out';
              } else if (activeLayer?.alphaLocked) {
                ctx.globalCompositeOperation = 'source-atop';
              } else {
                ctx.globalCompositeOperation = 'source-over';
              }

              if (docDraft) {
                ctx.drawImage(docDraft, sx, sy, dw, dh, sx, sy, dw, dh);
              } else {
                const bakeCanvas = getReusableBakeCanvas(dw, dh);
                const bCtx = bakeCanvas.getContext('2d', { alpha: true });
                if (bCtx) {
                  bCtx.clearRect(0, 0, bakeCanvas.width, bakeCanvas.height);
                  bCtx.save();
                  bCtx.translate(-sx, -sy);
                  renderCompleteStroke(bCtx, allPoints, bs, currentTool, mode, isBgEraser, canvas, Boolean(activeLayer?.alphaLocked));
                  bCtx.restore();
                  ctx.drawImage(bakeCanvas, 0, 0, dw, dh, sx, sy, dw, dh);
                }
              }

              ctx.restore();

              // Single-pass snapshot: read pixel buffer once, binarize in-place if monochrome, then write
              const targetFormat = isMonochrome ? 'monochrome-1bit' : 'color-32bit';
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

              if (docDraft) {
                const dCtx = get2DContext(docDraft);
                dCtx?.clearRect(sx, sy, dw, dh);
              }

              globalTileGrid.writeImageData(currentLayerId, afterData, sx, sy, targetFormat);

              enqueueHistoryTask(() => {
                const tileDeltas = globalTileGrid.computeDeltasFromSnapshot(beforeSnapshot, currentLayerId, dirtyRect);
                pushHistoryStep(toolForHistory, label, null, null, currentLayerId, dirtyRect, tileDeltas);
              });
            }
          }
        }
      }

      // Synchronously notify tile grid compositor
      globalTileGrid.notifyChange(true);

      // Atomic Zero-Flicker handoff: wait 1 frame for WebGL compositor to present its swap chain, then clear draft overlay
      if (clearDraftRafRef.current !== null) {
        cancelAnimationFrame(clearDraftRafRef.current);
      }
      clearDraftRafRef.current = requestAnimationFrame(() => {
        clearDraftRafRef.current = null;
        if (draftCanvas) {
          const dCtx = get2DContext(draftCanvas);
          if (dCtx) {
            try {
              dCtx.restore(); // Restore artboard clip
            } catch (_) {}
            dCtx.resetTransform();
            dCtx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
          }
        }
      });
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
      pendingPointsQueueRef.current = [];
      drewDirectlyOnLayerCanvasRef.current = false;
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
      applyStabilizedPointAndRender,
      clearPredictedCanvas,
      effectiveDraftCanvasRef,
      emitConstraintAxisChange,
      enqueueHistoryTask,
      flushPendingPoints,
      getActiveCanvas,
      getCanvasPoint,
      onUpdateLayerThumbnail,
      pushHistoryStep,
      renderDraftSegment,
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

  // Keyboard shortcut listener (Ctrl+Z for undo, Ctrl+Y / Ctrl+Shift+Z for redo)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in text inputs or textareas
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      const key = e.key.toLowerCase();
      const isZ = key === 'z' || e.code === 'KeyZ';

      if ((e.ctrlKey || e.metaKey) && isZ) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [undo, redo]);

  const resetHistory = useCallback(() => {
    historyRef.current = [];
    historyIndexRef.current = -1;
    setHistoryList([]);
    setHistoryIndex(-1);
    setCanUndo(false);
    setCanRedo(false);

    // Re-seed initial history state after DOM canvas updates without heavy getImageData readback
    setTimeout(() => {
      const canvas = layerCanvasesRef.current.get(activeLayerId) || layerCanvasesRef.current.values().next().value;
      if (!canvas) return;

      const thumbnail = createCanvasThumbnail(canvas, activeLayerId !== 'layer-bg');
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
