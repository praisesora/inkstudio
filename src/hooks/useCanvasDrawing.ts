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
} from '../types/editor';
import {
  calculateStrokeWidth,
  drawSmoothCubicBezierSegment,
  catmullRomToBezier,
  drawDot,
  screenToCanvas,
  createCanvasThumbnail,
  formatTime,
  get2DContext,
  getCanvasToViewportMatrix,
  getReusableBakeCanvas,
  renderCompleteStroke,
} from '../utils/canvasUtils';
import { enforceColorMode, binarizeCanvasRect } from '../utils/colorUtils';
import { drawPencilCubicBezierSegment, drawPencilDot, PencilGrade } from '../utils/pencilEngine';
import {
  drawTexturedCubicBezierSegment,
  drawTexturedDot,
  TexturedBrushOptions,
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
  draftCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  strokeCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  onCollabStrokeStart?: (strokeId: string, layerId: string, brushSettings: BrushSettings, tool: ToolType, startPoint: Point) => void;
  onCollabStrokeChunk?: (strokeId: string, points: Point[]) => void;
  onCollabStrokeFinish?: (strokeId: string, layerId: string, endPoint: Point, dirtyRect?: DirtyRect) => void;
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
  draftCanvasRef,
  strokeCanvasRef,
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

  const onCollabStrokeStartRef = useRef(onCollabStrokeStart);
  const onCollabStrokeChunkRef = useRef(onCollabStrokeChunk);
  const onCollabStrokeFinishRef = useRef(onCollabStrokeFinish);
  const onCollabCursorMoveRef = useRef(onCollabCursorMove);

  const rulerRef = useRef(perspectiveRuler);
  rulerRef.current = perspectiveRuler;
  const onActiveConstraintAxisChangeRef = useRef(onActiveConstraintAxisChange);
  onActiveConstraintAxisChangeRef.current = onActiveConstraintAxisChange;
  const snapSessionRef = useRef(new PerspectiveSnapSession());

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
  const rawPointsBufferRef = useRef<{ x: number; y: number; pressure: number; pointerType: string }[]>([]);

  // Stabilizer tracking ref
  const stabilizedPointRef = useRef<Point | null>(null);

  // Distance accumulator for textured brush dab stepping
  const stampRemainderDistRef = useRef<number>(0);

  // Active color mixing reservoir and pre-stroke backup canvas for real-time wet blending/smudging
  const activeReservoirRef = useRef<PaintReservoir | null>(null);
  const layerPixelSamplerRef = useRef<LayerPixelSampler | null>(null);
  const strokeBackupCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dedicatedBackupCanvasRef = useRef<HTMLCanvasElement | null>(null);

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

  const isWetColorStrokeRef = useRef<boolean>(false);
  const drewDirectlyOnLayerCanvasRef = useRef<boolean>(false);
  const lastPointTimeRef = useRef<number>(0);
  const recentPointsTrailRef = useRef<{ x: number; y: number; t: number; pressure: number; width: number }[]>([]);
  const strokeTotalDistanceRef = useRef<number>(0);

  // Dirty bounding box for the active stroke
  const dirtyRectRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);
  const lastProcessedPointRef = useRef<{ x: number; y: number } | null>(null);

  // Queue of incoming pointer coordinates to be batched and processed via requestAnimationFrame (rAF)
  const pendingPointsQueueRef = useRef<{ x: number; y: number; pressure: number; pointerType: string }[]>([]);
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
      dirtyRect?: DirtyRect
    ) => {
      const now = Date.now();
      const canvas = layerCanvasesRef.current.get(targetLayerId) || getActiveCanvas();

      const item: HistoryItem = {
        id: `hist-${now}-${Math.random().toString(36).substring(2, 7)}`,
        type: actionType,
        label,
        timestamp: now,
        timeFormatted: formatTime(now),
        thumbnailUrl: '',
        layerId: targetLayerId,
        beforeImageData: beforeData,
        afterImageData: afterData,
        imageData: afterData || undefined,
        dirtyRect,
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
    onActiveConstraintAxisChangeRef.current?.(null);
  }, [effectiveDraftCanvasRef, getActiveCanvas, layerCanvasesRef]);

  // Jump directly to any past or future history step
  const jumpToHistoryIndex = useCallback(
    (targetIndex: number) => {
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

            if (isToneStep && sourceCanvas) {
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

            if (isToneStep && sourceCanvas) {
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
    },
    [abortActiveStroke, activeLayerId, getActiveCanvas, layerCanvasesRef, onUpdateLayerThumbnail, syncHistoryState]
  );

  // Undo action
  const undo = useCallback(() => {
    if (isDrawingRef.current) {
      abortActiveStroke();
    }
    if (historyIndexRef.current <= 0) return;
    jumpToHistoryIndex(historyIndexRef.current - 1);
  }, [abortActiveStroke, jumpToHistoryIndex]);

  // Redo action
  const redo = useCallback(() => {
    if (isDrawingRef.current) {
      abortActiveStroke();
    }
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    jumpToHistoryIndex(historyIndexRef.current + 1);
  }, [abortActiveStroke, jumpToHistoryIndex]);

  // Clear active layer action
  const clearCanvas = useCallback(() => {
    const canvas = getActiveCanvas();
    if (!canvas || activeLayerLocked) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const beforeData = ctx.getImageData(0, 0, canvas.width, canvas.height);

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
    pushHistoryStep('clear', 'Clear Layer', beforeData, afterData, activeLayerId, {
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
    });
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
      if (!vRect) return { x: 0, y: 0, pressure: 0.5, width: bs.size };

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

      return { x, y, pressure, width };
    },
    [getViewportRect]
  );

  // Render a single smooth segment onto the draft overlay context using Catmull-Rom cubic splines
  const renderDraftSegment = useCallback((draftCtx: CanvasRenderingContext2D, point: Point) => {
    const pts = strokePointsRef.current;
    pts.push(point);

    if (pts.length < 3) {
      return;
    }

    let k0: Point, k1: Point, k2: Point, k3: Point;
    if (pts.length === 3) {
      // First segment: P0 -> P1 with knots (P0, P0, P1, P2)
      k0 = pts[0];
      k1 = pts[0];
      k2 = pts[1];
      k3 = pts[2];
    } else {
      // Subsequent segments: P_{n-2} -> P_{n-1} with knots (P_{n-3}, P_{n-2}, P_{n-1}, P_n)
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
    const isWetColor = isWetColorStrokeRef.current;
    const isTranslucentBrush = !isEraser && !isMonochrome && (bs.opacity ?? 1.0) < 0.999;
    const isDirectRender = isMonochrome || isWetColor || isEraser || (!isTranslucentBrush && !isToneLayer);

    let targetCtx: CanvasRenderingContext2D | null = null;
    if (isToneLayer && sourceCanvas) {
      targetCtx = get2DContext(sourceCanvas);
      drewDirectlyOnLayerCanvasRef.current = true;
    } else if (isDirectRender && canvas) {
      targetCtx = get2DContext(canvas);
      drewDirectlyOnLayerCanvasRef.current = true;
    } else {
      targetCtx = draftCtx;
    }
    if (!targetCtx) return;

    const strokeColor = isBgEraser ? '#ffffff' : enforceColorMode(bs.color, isMonochrome ? 'monochrome' : mode);
    const strokeHardness = isMonochrome ? 1.0 : (bs.hardness ?? 1.0);
    const strokeFlow = bs.flow ?? 1.0;
    const strokeSpacing = bs.spacing ?? 0.08;

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
        currentStrokeDist: strokeTotalDistanceRef.current,
      };

      stampRemainderDistRef.current = drawTexturedCubicBezierSegment(
        targetCtx,
        segStart,
        c1,
        c2,
        segEnd,
        strokeColor,
        bs.customTipImage,
        tipOptions,
        stampRemainderDistRef.current
      );
    } else if (isPencil) {
      const grade = (bs.preset as PencilGrade) || 'pencil-2b';
      const pFlow = bs.flow ?? 0.74;
      const pGrain = bs.grain ?? 1.0;

      drawPencilCubicBezierSegment(
        targetCtx,
        segStart,
        c1,
        c2,
        segEnd,
        strokeColor,
        grade,
        pFlow,
        pGrain,
        bs.hardness
      );
    } else {
      drawSmoothCubicBezierSegment(
        targetCtx,
        segStart,
        c1,
        c2,
        segEnd,
        strokeColor,
        isEraser && !isBgEraser,
        strokeHardness,
        strokeFlow,
        strokeSpacing
      );
    }
  }, [getActiveCanvas]);

  // Stabilize and render point onto draft canvas
  const applyStabilizedPointAndRender = useCallback(
    (draftCtx: CanvasRenderingContext2D, rawX: number, rawY: number, rawPressure: number, pointerType: string) => {
      const bs = brushSettingsRef.current;
      const dims = dimensionsRef.current;
      const stab = Math.min(50, Math.max(0, bs.stabilization ?? 0));

      const now = performance.now();
      const dt = Math.max(1, now - (lastPointTimeRef.current || now));
      lastPointTimeRef.current = now;

      let velocityScale = 1.0;
      if (bs.velocityDynamics && stabilizedPointRef.current) {
        const dist = Math.hypot(rawX - stabilizedPointRef.current.x, rawY - stabilizedPointRef.current.y);
        const speed = dist / dt; // px / ms
        velocityScale = Math.max(0.65, Math.min(1.0, 1.0 - Math.max(0, speed - 0.5) * 0.12));
      }

      rawPointsBufferRef.current.push({ x: rawX, y: rawY, pressure: rawPressure, pointerType });

      let pt: Point;
      if (stab <= 0) {
        rawPointsBufferRef.current.length = 0;
        const width = calculateStrokeWidth(
          bs.size,
          rawPressure,
          bs.minSizeFactor,
          bs.usePressure,
          pointerType,
          bs.pressureCurveGamma ?? 1.0,
          velocityScale,
          bs.pressureCurve
        );
        pt = { x: rawX, y: rawY, pressure: rawPressure, width };
        stabilizedPointRef.current = pt;
      } else {
        const W = Math.min(9, Math.max(3, 1 + 2 * Math.floor(stab / 7)));
        if (rawPointsBufferRef.current.length < W) {
          return;
        }

        const buf = rawPointsBufferRef.current;
        const mid = Math.floor(W / 2);
        let sumX = 0, sumY = 0, sumP = 0, sumW = 0;
        for (let i = 0; i < W; i++) {
          const w = Math.pow(2, mid - Math.abs(i - mid));
          sumX += buf[i].x * w;
          sumY += buf[i].y * w;
          sumP += buf[i].pressure * w;
          sumW += w;
        }
        buf.shift();

        const smoothX = sumX / sumW;
        const smoothY = sumY / sumW;
        const smoothPressure = sumP / sumW;
        const smoothWidth = calculateStrokeWidth(
          bs.size,
          smoothPressure,
          bs.minSizeFactor,
          bs.usePressure,
          pointerType,
          bs.pressureCurveGamma ?? 1.0,
          velocityScale,
          bs.pressureCurve
        );
        pt = { x: smoothX, y: smoothY, pressure: smoothPressure, width: smoothWidth };
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

  // Flush batched points on requestAnimationFrame
  const flushPendingPoints = useCallback(() => {
    drawRafIdRef.current = null;
    if (!isDrawingRef.current) return;

    const queue = pendingPointsQueueRef.current;
    if (queue.length === 0) return;

    const draftCanvas = effectiveDraftCanvasRef?.current;
    if (!draftCanvas) return;
    const draftCtx = get2DContext(draftCanvas);
    if (!draftCtx) return;

    const batch = queue.splice(0, queue.length);
    const chunkPts: Point[] = [];
    let batchMinX = Infinity;
    let batchMinY = Infinity;
    let batchMaxX = -Infinity;
    let batchMaxY = -Infinity;
    let maxStrokeWidth = 0;

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      applyStabilizedPointAndRender(draftCtx, item.x, item.y, item.pressure, item.pointerType);
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

    if (batchMinX <= batchMaxX) {
      const currentLayerId = activeLayerIdRef.current;
      const canvas = getActiveCanvas();
      const activeLayer = layersRef.current?.find((l) => l.id === currentLayerId);
      const isToneLayer = Boolean(activeLayer?.toneEnabled);
      const isMonoLayer = activeLayer?.expressionColor === 'monochrome';
      const isMonochrome = colorModeRef.current === 'monochrome' || isMonoLayer;
      const dims = dimensionsRef.current;
      const margin = Math.ceil(maxStrokeWidth * 1.5 + 32);
      const segMinX = Math.max(0, Math.floor(batchMinX - margin));
      const segMinY = Math.max(0, Math.floor(batchMinY - margin));
      const segMaxX = Math.min(dims.width, Math.ceil(batchMaxX + margin));
      const segMaxY = Math.min(dims.height, Math.ceil(batchMaxY + margin));
      const segW = segMaxX - segMinX;
      const segH = segMaxY - segMinY;

      if (dirtyRectRef.current) {
        dirtyRectRef.current.minX = Math.min(dirtyRectRef.current.minX, segMinX);
        dirtyRectRef.current.minY = Math.min(dirtyRectRef.current.minY, segMinY);
        dirtyRectRef.current.maxX = Math.max(dirtyRectRef.current.maxX, segMaxX);
        dirtyRectRef.current.maxY = Math.max(dirtyRectRef.current.maxY, segMaxY);
      }

      if (segW > 0 && segH > 0 && canvas) {
        if (isMonochrome) {
          const cCtx = get2DContext(canvas);
          if (cCtx) {
            binarizeCanvasRect(
              cCtx,
              { x: segMinX, y: segMinY, width: segW, height: segH },
              activeLayer?.monoThreshold ?? 128,
              activeLayer?.monoExpressBlack ?? true,
              activeLayer?.monoExpressWhite ?? true
            );
          }
          if (layerSourceCanvasesRef?.current?.has(currentLayerId)) {
            const sourceCanvas = layerSourceCanvasesRef.current.get(currentLayerId);
            if (sourceCanvas) {
              const sCtx = get2DContext(sourceCanvas);
              if (sCtx) {
                sCtx.clearRect(segMinX, segMinY, segW, segH);
                sCtx.drawImage(canvas, segMinX, segMinY, segW, segH, segMinX, segMinY, segW, segH);
              }
            }
          }
        } else if (isToneLayer && isToneStrokeRef.current) {
          const sourceCanvas = layerSourceCanvasesRef?.current?.get(currentLayerId);
          if (sourceCanvas && activeLayer) {
            applyLayerEffects(
              sourceCanvas,
              canvas,
              activeLayer,
              dims.dpi ?? 600,
              {
                x: segMinX,
                y: segMinY,
                width: segW,
                height: segH,
              }
            );
          }
        }
      }
    }

    if (currentStrokeIdRef.current && chunkPts.length > 0) {
      onCollabStrokeChunkRef.current?.(currentStrokeIdRef.current, chunkPts);
    }
  }, [applyStabilizedPointAndRender, effectiveDraftCanvasRef, getActiveCanvas, layerSourceCanvasesRef]);


  // Pointer Down handler: initialize lightweight live stroke overlay without touching base canvas
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const isBrushOrEraser = toolRef.current === 'brush' || toolRef.current === 'eraser';
      if (!isBrushOrEraser || disabled || e.button !== 0 || activeLayerLockedRef.current || !activeLayerVisibleRef.current) return;
      e.preventDefault();

      const canvas = getActiveCanvas();
      if (!canvas) return;

      const vRect = getViewportRect();
      if (!vRect) return;

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

      // Ensure draft canvas buffer resolution matches screen viewport * DPR
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.max(1, Math.ceil(vRect.width * dpr));
      const targetH = Math.max(1, Math.ceil(vRect.height * dpr));
      if (draftCanvas.width !== targetW || draftCanvas.height !== targetH) {
        draftCanvas.width = targetW;
        draftCanvas.height = targetH;
      }

      const draftCtx = get2DContext(draftCanvas);
      if (!draftCtx) return;

      // Reset and configure draft canvas matrix & clipping to artboard
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

      const isEraser = toolRef.current === 'eraser';
      const isBgEraser = isEraser && activeLayerIdRef.current === 'layer-bg';

      const currentLayerId = activeLayerIdRef.current;
      const activeLayer = layersRef.current?.find((l) => l.id === currentLayerId);
      const bs = brushSettingsRef.current;
      const mode = colorModeRef.current;
      const dims = dimensionsRef.current;
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
      const rawStartPoint = getCanvasPoint(e);
      const isAltOverride = e.altKey;
      const startPoint = snapSessionRef.current.snapPoint(rawStartPoint, rulerRef.current, isAltOverride);
      onActiveConstraintAxisChangeRef.current?.(snapSessionRef.current.getActiveAxis());

      allStrokePointsRef.current = [startPoint];
      strokePointsRef.current = [startPoint];
      rawPointsBufferRef.current = [{
        x: startPoint.x,
        y: startPoint.y,
        pressure: startPoint.pressure,
        pointerType: e.pointerType,
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

      dispatchPointerStat(startPoint.x, startPoint.y, startPoint.pressure);

      const blurMargin = (1 - (bs.hardness ?? 1.0)) * (startPoint.width * 1.5);
      const r = Math.max(32, Math.ceil(startPoint.width + blurMargin + 32));
      dirtyRectRef.current = {
        minX: Math.max(0, Math.floor(startPoint.x - r)),
        minY: Math.max(0, Math.floor(startPoint.y - r)),
        maxX: Math.min(dims.width, Math.ceil(startPoint.x + r)),
        maxY: Math.min(dims.height, Math.ceil(startPoint.y + r)),
      };

      const strokeColor = isBgEraser ? '#ffffff' : enforceColorMode(bs.color, isMonochrome ? 'monochrome' : mode);
      const strokeHardness = isMonochrome ? 1.0 : (bs.hardness ?? 1.0);

      const isWetColor = !isEraser && Boolean(bs.colorMixing) && Boolean(bs.customTipImage);
      isWetColorStrokeRef.current = isWetColor;

      const isTranslucentBrush = !isEraser && !isMonochrome && (bs.opacity ?? 1.0) < 0.999;
      const isDirectRender = isMonochrome || isWetColor || isEraser || (!isTranslucentBrush && !isToneLayer);
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
      } else if ((isDirectRender || isWetColor) && canvas) {
        const backupCanvas = getDedicatedBackupCanvas(canvas.width, canvas.height);
        const backupCtx = get2DContext(backupCanvas);
        if (backupCtx) {
          backupCtx.clearRect(0, 0, canvas.width, canvas.height);
          backupCtx.drawImage(canvas, 0, 0);
          strokeBackupCanvasRef.current = backupCanvas;
        }
        if (isWetColor) {
          layerPixelSamplerRef.current = new LayerPixelSampler(canvas);
          activeReservoirRef.current = new PaintReservoir(strokeColor);
        } else {
          layerPixelSamplerRef.current = null;
          activeReservoirRef.current = null;
        }
      } else {
        strokeBackupCanvasRef.current = null;
        layerPixelSamplerRef.current = null;
        activeReservoirRef.current = null;
      }

      const strokeId = `stroke-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      currentStrokeIdRef.current = strokeId;
      onCollabStrokeStartRef.current?.(strokeId, activeLayerIdRef.current, bs, toolRef.current, startPoint);

      stampRemainderDistRef.current = Math.max(0.2, startPoint.width * (bs.spacing ?? 0.08));

      const targetStartCtx = isToneLayer && sourceCanvas
        ? get2DContext(sourceCanvas)
        : (isDirectRender && canvas ? get2DContext(canvas) : draftCtx);
      if (targetStartCtx && targetStartCtx !== draftCtx) {
        drewDirectlyOnLayerCanvasRef.current = true;
      }

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
        };
        if (targetStartCtx) {
          drawTexturedDot(targetStartCtx, startPoint, strokeColor, bs.customTipImage, tipOptions);
        }
      } else if (isPencil) {
        const grade = (bs.preset as PencilGrade) || 'pencil-2b';
        if (targetStartCtx) {
          drawPencilDot(
            targetStartCtx,
            startPoint,
            strokeColor,
            grade,
            bs.flow ?? 0.74,
            bs.grain ?? 1.0,
            bs.hardness
          );
        }
      } else {
        if (targetStartCtx) {
          drawDot(
            targetStartCtx,
            startPoint,
            strokeColor,
            isEraser && !isBgEraser,
            strokeHardness,
            bs.flow ?? 1.0
          );
        }
      }

      if (isMonochrome && canvas && dirtyRectRef.current) {
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
          if (sourceCanvas && targetStartCtx !== get2DContext(sourceCanvas)) {
            const sCtx = get2DContext(sourceCanvas);
            sCtx?.drawImage(canvas, dotDirty.minX, dotDirty.minY, dw, dh, dotDirty.minX, dotDirty.minY, dw, dh);
          }
        }
      } else if (isToneLayer && sourceCanvas && canvas && activeLayer) {
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
    },
    [disabled, dispatchPointerStat, effectiveDraftCanvasRef, getActiveCanvas, getCanvasPoint, getViewportRect, viewportRef]
  );

  // Pointer Move handler: throttled & batched coordinate ingestion via rAF
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const point = getCanvasPoint(e);
      dispatchPointerStat(point.x, point.y, point.pressure);
      onCollabCursorMoveRef.current?.(point.x, point.y, isDrawingRef.current, toolRef.current);


      if (!isDrawingRef.current || e.pointerId !== activePointerIdRef.current) {
        return;
      }

      e.preventDefault();

      const nativeEvent = e.nativeEvent as PointerEvent;
      const vRect = getViewportRect();
      const dims = dimensionsRef.current;

      if (typeof nativeEvent.getCoalescedEvents === 'function' && vRect) {
        const coalesced = nativeEvent.getCoalescedEvents();
        if (coalesced && coalesced.length > 0) {
          for (let i = 0; i < coalesced.length; i++) {
            const cEvent = coalesced[i];
            const isLast = i === coalesced.length - 1;
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
              onActiveConstraintAxisChangeRef.current?.(snapRes.axis);
            }

            const last = lastProcessedPointRef.current;
            if (last && !isLast) {
              const distSq = (cx - last.x) * (cx - last.x) + (cy - last.y) * (cy - last.y);
              if (distSq < 2.0) {
                continue;
              }
            }

            lastProcessedPointRef.current = { x: cx, y: cy };
            let cPressure = 0;
            if (cEvent.pointerType === 'mouse') {
              cPressure = (cEvent.buttons & 1) ? 0.5 : 0;
            } else {
              cPressure = cEvent.pressure !== undefined ? Math.max(0, Math.min(1.0, cEvent.pressure)) : 0;
            }

            pendingPointsQueueRef.current.push({
              x: cx,
              y: cy,
              pressure: cPressure,
              pointerType: cEvent.pointerType,
            });
          }

          if (drawRafIdRef.current === null) {
            drawRafIdRef.current = requestAnimationFrame(flushPendingPoints);
          }
          return;
        }
      }

      const isAltOverride = e.altKey;
      const snapRes = snapSessionRef.current.processPoint({ x: point.x, y: point.y }, rulerRef.current, isAltOverride);
      const finalX = snapRes.x;
      const finalY = snapRes.y;
      if (snapRes.axis) {
        onActiveConstraintAxisChangeRef.current?.(snapRes.axis);
      }

      const last = lastProcessedPointRef.current;
      if (last) {
        const distSq = (finalX - last.x) * (finalX - last.x) + (finalY - last.y) * (finalY - last.y);
        if (distSq < 1.0) {
          return;
        }
      }

      lastProcessedPointRef.current = { x: finalX, y: finalY };
      pendingPointsQueueRef.current.push({
        x: finalX,
        y: finalY,
        pressure: point.pressure,
        pointerType: e.pointerType,
      });

      if (drawRafIdRef.current === null) {
        drawRafIdRef.current = requestAnimationFrame(flushPendingPoints);
      }
    },
    [dispatchPointerStat, flushPendingPoints, getCanvasPoint, getViewportRect]
  );

  // Pointer Up / Cancel handler: composite and bake stroke into high-res canvas at dirty rect
  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!isDrawingRef.current || e.pointerId !== activePointerIdRef.current) {
        return;
      }

      e.preventDefault();

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

      // Drain any buffered raw points through the stabilizer
      while (rawPointsBufferRef.current.length > 0) {
        const buf = rawPointsBufferRef.current;
        const len = buf.length;
        const mid = Math.floor(len / 2);
        let sumX = 0, sumY = 0, sumP = 0, sumW = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.pow(2, mid - Math.abs(i - mid));
          sumX += buf[i].x * w;
          sumY += buf[i].y * w;
          sumP += buf[i].pressure * w;
          sumW += w;
        }
        const ptType = buf[0].pointerType;
        buf.shift();

        const sX = sumX / sumW;
        const sY = sumY / sumW;
        const sP = sumP / sumW;
        const sW = calculateStrokeWidth(
          bs.size,
          sP,
          bs.minSizeFactor,
          bs.usePressure,
          ptType,
          bs.pressureCurveGamma ?? 1.0,
          1.0,
          bs.pressureCurve
        );
        const pt: Point = { x: sX, y: sY, pressure: sP, width: sW };
        allStrokePointsRef.current.push(pt);
        if (draftCtx) {
          renderDraftSegment(draftCtx, pt);
        }
      }

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
        const strokeColor = isBgEraser ? '#ffffff' : enforceColorMode(bs.color, isMonochrome ? 'monochrome' : mode);
        const strokeHardness = isMonochrome ? 1.0 : (bs.hardness ?? 1.0);

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
            currentStrokeDist: strokeTotalDistanceRef.current,
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
            bs.hardness
          );
        } else if (bs.smoothing) {
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
            bs.spacing ?? 0.08
          );
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

        if (isMonochrome && canvas) {
          const tW = tMaxX - tMinX;
          const tH = tMaxY - tMinY;
          if (tW > 0 && tH > 0) {
            const cCtx = get2DContext(canvas);
            if (cCtx) {
              binarizeCanvasRect(
                cCtx,
                { x: tMinX, y: tMinY, width: tW, height: tH },
                activeLayer?.monoThreshold ?? 128,
                activeLayer?.monoExpressBlack ?? true,
                activeLayer?.monoExpressWhite ?? true
              );
            }
            if (sourceCanvas) {
              const sCtx = get2DContext(sourceCanvas);
              sCtx?.drawImage(canvas, tMinX, tMinY, tW, tH, tMinX, tMinY, tW, tH);
            }
          }
        }
      }

      // BAKE STROKE INTO HIGH-RESOLUTION BASE CANVAS (Dirty Rect only)
      const dirty = dirtyRectRef.current;

      if (isToneLayer && sourceCanvas && canvas) {
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
      const allPoints = allStrokePointsRef.current;

      if (canvas && dirty && allPoints.length > 0) {
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
            let beforeData: ImageData | null = null;
            let afterData: ImageData | null = null;

            if (isToneLayer && strokeBackupCanvasRef.current && sourceCanvas) {
              const bCtx = get2DContext(strokeBackupCanvasRef.current);
              beforeData = bCtx ? bCtx.getImageData(sx, sy, dw, dh) : null;
              const sCtx = get2DContext(sourceCanvas);
              afterData = sCtx ? sCtx.getImageData(sx, sy, dw, dh) : null;
            } else if (drewDirectlyOnLayerCanvasRef.current && strokeBackupCanvasRef.current) {
              // Direct render: stroke is ALREADY drawn on canvas with real-time binarization/effects!
              // Zero re-rendering, zero delay, zero lag, zero flicker!
              const bCtx = get2DContext(strokeBackupCanvasRef.current);
              beforeData = bCtx ? bCtx.getImageData(sx, sy, dw, dh) : null;
              afterData = ctx.getImageData(sx, sy, dw, dh);

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
            } else {
              // Translucent brushes drawn onto draft canvas overlay:
              beforeData = ctx.getImageData(sx, sy, dw, dh);

              ctx.save();
              ctx.beginPath();
              ctx.rect(sx, sy, dw, dh);
              ctx.clip();

              const bakeCanvas = getReusableBakeCanvas(dw, dh);
              const bCtx = bakeCanvas.getContext('2d', { alpha: true });
              if (bCtx) {
                bCtx.clearRect(0, 0, bakeCanvas.width, bakeCanvas.height);
                bCtx.save();
                bCtx.translate(-sx, -sy);
                renderCompleteStroke(bCtx, allPoints, bs, currentTool, mode, isBgEraser);
                bCtx.restore();

                ctx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.opacity ?? 1.0));
                ctx.globalCompositeOperation = 'source-over';
                ctx.drawImage(bakeCanvas, 0, 0, dw, dh, sx, sy, dw, dh);
              }

              ctx.restore();

              afterData = ctx.getImageData(sx, sy, dw, dh);
            }

            let label = 'Brush Stroke';
            if (currentTool === 'eraser') {
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
            } else if (bs.preset === 'oil-thick') {
              label = 'Thick Oil Paint';
            } else if (bs.preset === 'oil-glaze') {
              label = 'Oil Glaze Brush';
            } else if (bs.preset === 'blend-smudge') {
              label = 'Smudge & Blender';
            } else {
              label = isMonochrome ? 'Monochrome Pen' : 'Round Brush';
            }

            if (beforeData && afterData) {
              pushHistoryStep(
                currentTool === 'eraser' ? 'eraser' : (isPencil ? 'pencil' : 'brush'),
                label,
                beforeData,
                afterData,
                currentLayerId,
                { x: sx, y: sy, width: dw, height: dh }
              );
            }
          }
        }
      }

      // Synchronously clear draftCanvas immediately in the exact same render turn to guarantee zero flicker
      if (clearDraftRafRef.current !== null) {
        cancelAnimationFrame(clearDraftRafRef.current);
        clearDraftRafRef.current = null;
      }
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
          } : undefined
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
      onActiveConstraintAxisChangeRef.current?.(null);

      onUpdateLayerThumbnail(currentLayerId);
    },
    [
      applyStabilizedPointAndRender,
      effectiveDraftCanvasRef,
      flushPendingPoints,
      getActiveCanvas,
      getCanvasPoint,
      onUpdateLayerThumbnail,
      pushHistoryStep,
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
      const isY = key === 'y' || e.code === 'KeyY';

      if ((e.ctrlKey || e.metaKey) && isZ) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && isY) {
        e.preventDefault();
        e.stopPropagation();
        redo();
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
    cursorPos: null as { x: number; y: number } | null,
    currentPressure: 0,
    isHovering: false,
  };
}
