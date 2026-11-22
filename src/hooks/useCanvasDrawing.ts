import { useRef, useEffect, useCallback } from 'react';
import {
  LastStrokeEndState,
  UseCanvasDrawingProps,
  useBrushStrokeSession,
  useDrawingHistory,
} from './drawing';

export type { UseCanvasDrawingProps, PushHistoryStepFn } from './drawing';

/**
 * Thin canvas drawing dispatcher coordinating history, raster/WebGL brush sessions,
 * and vector stroke commit/erase via modular hooks in `src/hooks/drawing/`.
 */
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
  activeLayerLocked = false,
  activeLayerVisible = true,
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
  straightRuler = null,
  onActiveConstraintAxisChange,
  activeSessionId = null,
  tileGrid,
}: UseCanvasDrawingProps) {
  const effectiveDraftCanvasRef = draftCanvasRef ?? strokeCanvasRef;

  const interactionRef = useRef<HTMLDivElement | null>(null);
  const isDrawingRef = useRef(false);
  const lastStrokeEndRef = useRef<LastStrokeEndState | null>(null);
  const abortActiveStrokeRef = useRef<() => void>(() => {});

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

  const toolOverrideRef = useRef(tool);
  const brushSettingsOverrideRef = useRef(brushSettings);
  const colorModeRef = useRef(colorMode);
  const activeLayerIdRef = useRef(activeLayerId);
  const activeLayerLockedRef = useRef(activeLayerLocked);
  const activeLayerVisibleRef = useRef(activeLayerVisible);
  const dimensionsRef = useRef(dimensions);
  const selectionRef = useRef(selection);
  const isMaskModeRef = useRef(isMaskMode);
  const layersRef = useRef(layers);
  const onUpdateMaskThumbnailRef = useRef(onUpdateMaskThumbnail);
  const onCollabStrokeStartRef = useRef(onCollabStrokeStart);
  const onCollabStrokeChunkRef = useRef(onCollabStrokeChunk);
  const onCollabStrokeFinishRef = useRef(onCollabStrokeFinish);
  const onCollabCursorMoveRef = useRef(onCollabCursorMove);
  const rulerRef = useRef(perspectiveRuler);
  const straightRulerRef = useRef(straightRuler);
  const onActiveConstraintAxisChangeRef = useRef(onActiveConstraintAxisChange);

  useEffect(() => {
    if (!navigation) {
      fallbackPanRef.current = pan;
      fallbackZoomRef.current = zoom;
      fallbackRotationRef.current = rotation;
      fallbackFlipXRef.current = flipX;
      fallbackFlipYRef.current = flipY;
    }
    toolOverrideRef.current = tool;
    brushSettingsOverrideRef.current = brushSettings;
    colorModeRef.current = colorMode;
    activeLayerIdRef.current = activeLayerId;
    activeLayerLockedRef.current = activeLayerLocked;
    activeLayerVisibleRef.current = activeLayerVisible;
    dimensionsRef.current = dimensions;
    selectionRef.current = selection;
    isMaskModeRef.current = isMaskMode;
    layersRef.current = layers;
    onUpdateMaskThumbnailRef.current = onUpdateMaskThumbnail;
    onCollabStrokeStartRef.current = onCollabStrokeStart;
    onCollabStrokeChunkRef.current = onCollabStrokeChunk;
    onCollabStrokeFinishRef.current = onCollabStrokeFinish;
    onCollabCursorMoveRef.current = onCollabCursorMove;
    rulerRef.current = perspectiveRuler;
    straightRulerRef.current = straightRuler;
    onActiveConstraintAxisChangeRef.current = onActiveConstraintAxisChange;
  }, [
    navigation,
    pan,
    zoom,
    rotation,
    flipX,
    flipY,
    tool,
    brushSettings,
    colorMode,
    activeLayerId,
    activeLayerLocked,
    activeLayerVisible,
    dimensions,
    selection,
    isMaskMode,
    layers,
    onUpdateMaskThumbnail,
    onCollabStrokeStart,
    onCollabStrokeChunk,
    onCollabStrokeFinish,
    onCollabCursorMove,
    perspectiveRuler,
    straightRuler,
    onActiveConstraintAxisChange,
  ]);

  const getActiveMaskCanvas = useCallback(
    (layerId?: string): HTMLCanvasElement | null => {
      if (!isMaskModeRef.current) return null;
      const targetId = layerId || activeLayerIdRef.current || activeLayerId;
      const activeLayer = layersRef.current?.find((l) => l.id === targetId);
      return activeLayer?.maskCanvas || null;
    },
    [activeLayerId]
  );

  const history = useDrawingHistory({
    activeSessionId,
    tileGrid,
    activeLayerId,
    activeLayerLocked,
    dimensions,
    dimensionsRef,
    activeLayerIdRef,
    colorModeRef,
    layersRef,
    onUpdateLayerThumbnail,
    onUpdateMaskThumbnailRef,
    isDrawingRef,
    lastStrokeEndRef,
    abortActiveStrokeRef,
  });

  const brushSession = useBrushStrokeSession({
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
    effectiveDraftCanvasRef,
    predictedCanvasRef,
    activeTileGridRef: history.activeTileGridRef,
    rulerRef,
    straightRulerRef,
    onActiveConstraintAxisChangeRef,
    onUpdateLayerThumbnail,
    onUpdateMaskThumbnailRef,
    onCollabStrokeStartRef,
    onCollabStrokeChunkRef,
    onCollabStrokeFinishRef,
    onCollabCursorMoveRef,
    getActiveMaskCanvas,
    pushHistoryStep: history.pushHistoryStep,
    flushPendingHistoryTasks: history.flushPendingHistoryTasks,
    enqueueHistoryTask: history.enqueueHistoryTask,
  });

  abortActiveStrokeRef.current = brushSession.abortActiveStroke;

  return {
    interactionRef,
    isDrawingRef,
    pushHistoryStep: history.pushHistoryStep,
    flushPendingHistoryTasks: history.flushPendingHistoryTasks,
    handlePointerDown: brushSession.handlePointerDown,
    handlePointerMove: brushSession.handlePointerMove,
    handlePointerUp: brushSession.handlePointerUp,
    handlePointerEnter: brushSession.handlePointerEnter,
    handlePointerLeave: brushSession.handlePointerLeave,
    undo: history.undo,
    redo: history.redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    historyList: history.historyList,
    historyIndex: history.historyIndex,
    jumpToHistoryIndex: history.jumpToHistoryIndex,
    clearCanvas: history.clearCanvas,
    resetHistory: history.resetHistory,
    selectiveUndo: history.selectiveUndo,
    cursorPos: null as { x: number; y: number } | null,
    currentPressure: 0,
    isHovering: false,
  };
}
