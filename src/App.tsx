import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { AnimationTimeline, LayerItem } from './types/editor';
import {
  createDefaultAnimationTimeline,
  removeFrameCel,
  setFrameCel,
} from './utils/animationEngine';
import { screenToCanvas } from './utils/canvasUtils';
import { globalTileGrid } from './utils/tileEngine';
import { documentStore } from './utils/documentStore';
import { multiplayerService } from './services/multiplayerService';
import { useCanvasDrawing } from './hooks/useCanvasDrawing';
import {
  PushHistoryStepFn,
  useSelectionTools,
  useShapeAndFillTools,
  useVectorDrawing,
} from './hooks/drawing';
import { useCanvasNavigation } from './hooks/useCanvasNavigation';
import { useLayerManager } from './hooks/useLayerManager';
import { useCollabSync } from './hooks/useCollabSync';
import { useTonalAndFilterActions } from './hooks/useTonalAndFilterActions';
import { useAppMenuSections } from './hooks/useAppMenuSections';
import {
  documentStoreActions,
  selectHasOpenDocument,
  uiStoreActions,
  useDocumentStore,
  useToolStore,
  useUiStore,
} from './stores';
import {
  DocumentLifecycleManager,
  useDocumentLifecycle,
} from './components/DocumentLifecycleManager';
import { GlobalShortcutListener } from './components/GlobalShortcutListener';
import { ModalHost } from './components/ModalHost';
import { AppShell } from './components/AppShell';

export function App() {
  const dimensions = useDocumentStore((s) => s.dimensions);
  const colorMode = useDocumentStore((s) => s.colorMode);
  const documents = useDocumentStore((s) => s.documents);
  const activeDocumentId = useDocumentStore((s) => s.activeDocumentId);
  const hasOpenDocument = useDocumentStore(selectHasOpenDocument);
  const softProofSettings = useDocumentStore((s) => s.softProofSettings);
  const perspectiveRuler = useDocumentStore((s) => s.perspectiveRuler);
  const activeEditTarget = useDocumentStore((s) => s.activeEditTarget);
  const animationTimeline = useDocumentStore((s) => s.animationTimeline);
  const isWebtoonMode = useUiStore((s) => s.isWebtoonMode);

  const draftCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokeCanvasRef = draftCanvasRef;
  const selectiveUndoRef = useRef<(peerId?: string | number) => void>(() => {});
  const pushHistoryStepRef = useRef<PushHistoryStepFn | null>(null);
  const getActiveCanvasRef = useRef<() => HTMLCanvasElement | null>(() => null);
  const showToast = uiStoreActions.showToast;

  const activeTileGrid = useMemo(
    () =>
      activeDocumentId
        ? documentStore.getOrCreateSession(activeDocumentId).tileGrid
        : globalTileGrid,
    [activeDocumentId]
  );

  // Layer Management System
  const layerMgr = useLayerManager({
    dimensions,
    activeSessionId: activeDocumentId,
    tileGrid: activeTileGrid,
  });

  const activeDoc = documents.find((d) => d.id === activeDocumentId);
  const activeAnimationTimeline =
    activeDoc?.animation !== undefined ? activeDoc.animation : animationTimeline;

  const handleUpdateAnimationTimeline = useCallback(
    (timeline: AnimationTimeline | null) => {
      documentStoreActions.setAnimationTimeline(timeline);
      if (activeDocumentId) {
        documentStoreActions.setDocuments((docs) =>
          docs.map((d) => (d.id === activeDocumentId ? { ...d, animation: timeline } : d))
        );
      }
    },
    [activeDocumentId]
  );

  const handleAddAnimationCel = useCallback(
    (frameIndex: number) => {
      const newLayerId = `layer-cel-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const newCelLayer: LayerItem = {
        id: newLayerId,
        name: `Cel Frame ${frameIndex + 1}`,
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        collapsed: false,
        parentId: null,
      };
      const canvas = document.createElement('canvas');
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      layerMgr.registerLayerCanvas(newLayerId, canvas);

      layerMgr.setLayers((prev) => [newCelLayer, ...prev]);
      layerMgr.setActiveLayerId(newLayerId);

      const currentTl = activeAnimationTimeline || createDefaultAnimationTimeline(layerMgr.layers);
      handleUpdateAnimationTimeline(setFrameCel(currentTl, frameIndex, newLayerId));
      showToast(`Cel added for frame ${frameIndex + 1}`);
    },
    [activeAnimationTimeline, dimensions, handleUpdateAnimationTimeline, layerMgr, showToast]
  );

  const handleDeleteAnimationCel = useCallback(
    (frameIndex: number) => {
      if (!activeAnimationTimeline) return;
      handleUpdateAnimationTimeline(removeFrameCel(activeAnimationTimeline, frameIndex));
      showToast(`Cel removed from frame ${frameIndex + 1}`);
    },
    [activeAnimationTimeline, handleUpdateAnimationTimeline, showToast]
  );

  // Canvas Navigation
  const nav = useCanvasNavigation({
    dimensions,
    isWebtoonMode,
    activeDocumentId,
  });

  // Multiplayer & Collaborative Layer Sync
  const collab = useCollabSync({
    hasOpenDocument,
    dimensions,
    colorMode,
    layers: layerMgr.layers,
    activeLayerId: layerMgr.activeLayerId,
    selectedLayerIds: layerMgr.selectedLayerIds,
    layerCanvasesRef: layerMgr.layerCanvasesRef,
    selectiveUndoRef,
    setActiveLayerId: layerMgr.setActiveLayerId,
    addLayer: layerMgr.addLayer,
    addRemoteLayer: layerMgr.addRemoteLayer,
    deleteLayer: layerMgr.deleteLayer,
    deleteRemoteLayer: layerMgr.deleteRemoteLayer,
    deleteSelectedLayers: layerMgr.deleteSelectedLayers,
    groupSelectedLayers: layerMgr.groupSelectedLayers,
    syncRemoteDocument: layerMgr.syncRemoteDocument,
    renameLayer: layerMgr.renameLayer,
    toggleVisibility: layerMgr.toggleVisibility,
    setOpacity: layerMgr.setOpacity,
    clearActiveLayer: layerMgr.clearActiveLayer,
    updateLayerThumbnail: layerMgr.updateLayerThumbnail,
    showToast,
  });

  const stableGetActiveCanvas = useCallback(() => getActiveCanvasRef.current(), []);
  const stablePushHistoryStep = useCallback<PushHistoryStepFn>(
    (...args) => {
      pushHistoryStepRef.current?.(...args);
    },
    []
  );

  // Modular Selection & Transform Tools (mounted before useCanvasDrawing so selection is always synchronous)
  const selectionTools = useSelectionTools({
    dimensions,
    colorMode,
    layers: layerMgr.layers,
    activeLayer: layerMgr.activeLayer,
    activeLayerId: layerMgr.activeLayerId,
    selectedLayerIds: layerMgr.selectedLayerIds,
    layerCanvasesRef: layerMgr.layerCanvasesRef,
    layerSourceCanvasesRef: layerMgr.layerSourceCanvasesRef,
    getActiveCanvas: stableGetActiveCanvas,
    updateLayerThumbnail: layerMgr.updateLayerThumbnail,
    pushHistoryStep: stablePushHistoryStep,
    showToast,
  });

  const handleCollabStrokeStart = useCallback(
    (
      strokeId: string,
      layerId: string,
      bs: import('./types/editor').BrushSettings,
      t: import('./types/editor').ToolType,
      startPt: import('./types/editor').Point
    ) => {
      if (multiplayerService.isConnected()) {
        multiplayerService.sendStrokeStart(strokeId, layerId, bs, t, startPt);
      }
    },
    []
  );

  const handleCollabStrokeChunk = useCallback(
    (strokeId: string, pts: import('./types/editor').Point[]) => {
      if (multiplayerService.isConnected()) {
        multiplayerService.sendStrokeChunk(strokeId, pts);
      }
    },
    []
  );

  const handleCollabStrokeFinish = useCallback(
    (
      strokeId: string,
      layerId: string,
      endPt: import('./types/editor').Point,
      dirty?: import('./types/editor').DirtyRect,
      vectorStroke?: import('./types/editor').VectorStroke
    ) => {
      if (multiplayerService.isConnected()) {
        multiplayerService.sendStrokeFinish(strokeId, layerId, endPt, dirty, vectorStroke);
      }
    },
    []
  );

  const handleCollabCursorMove = useCallback(
    (x: number, y: number, isDrawing: boolean, t: import('./types/editor').ToolType) => {
      if (multiplayerService.isConnected()) {
        multiplayerService.sendCursor(x, y, isDrawing, t);
      }
    },
    []
  );

  // Thin Canvas Drawing Dispatcher (reads tool & brushSettings from useToolStore without subscribing!)
  const drawing = useCanvasDrawing({
    dimensions,
    colorMode,
    disabled: !hasOpenDocument || nav.isSpaceDown || nav.isPanning || nav.isRotating || nav.isZoomDragging,
    viewportRef: nav.viewportRef,
    pan: nav.pan,
    zoom: nav.zoom,
    rotation: nav.rotation,
    flipX: nav.flipX,
    flipY: nav.flipY,
    navigation: nav.navigation,
    activeLayerId: layerMgr.activeLayerId,
    activeSessionId: activeDocumentId,
    tileGrid: activeTileGrid,
    materializeLayerCanvas: layerMgr.materializeLayerCanvas,
    activeLayerLocked: layerMgr.activeLayer?.locked ?? false,
    activeLayerVisible: layerMgr.activeLayer
      ? layerMgr.isLayerEffectivelyVisible(layerMgr.activeLayer)
      : true,
    layerCanvasesRef: layerMgr.layerCanvasesRef,
    layerSourceCanvasesRef: layerMgr.layerSourceCanvasesRef,
    layers: hasOpenDocument ? layerMgr.layers : [],
    onUpdateLayerThumbnail: layerMgr.updateLayerThumbnail,
    isMaskMode: activeEditTarget === 'mask',
    onUpdateMaskThumbnail: layerMgr.updateMaskThumbnail,
    draftCanvasRef,
    strokeCanvasRef,
    onCollabStrokeStart: handleCollabStrokeStart,
    onCollabStrokeChunk: handleCollabStrokeChunk,
    onCollabStrokeFinish: handleCollabStrokeFinish,
    onCollabCursorMove: handleCollabCursorMove,
    perspectiveRuler: hasOpenDocument ? perspectiveRuler : null,
    onActiveConstraintAxisChange: documentStoreActions.setActiveLockedAxis,
    selection: hasOpenDocument ? selectionTools.selection : null,
  });

  selectiveUndoRef.current = drawing.selectiveUndo;
  pushHistoryStepRef.current = drawing.pushHistoryStep;
  getActiveCanvasRef.current = drawing.getActiveCanvas;

  const handleUndo = useCallback(() => {
    if (collab.isConnected && collab.myPeer.id) {
      drawing.selectiveUndo(collab.myPeer.id);
      multiplayerService.sendSelectiveUndo(collab.myPeer.id.toString());
    } else {
      drawing.undo();
    }
  }, [collab.isConnected, collab.myPeer.id, drawing]);

  const getCanvasCoords = useCallback(
    (e: React.PointerEvent<HTMLElement> | PointerEvent) => {
      if (!nav.viewportRef.current) return { x: 0, y: 0 };
      const vRect = nav.viewportRef.current.getBoundingClientRect();
      return screenToCanvas(
        e.clientX,
        e.clientY,
        vRect,
        nav.navigation.panRef.current,
        nav.navigation.zoomRef.current,
        nav.navigation.rotationRef.current,
        dimensions,
        nav.navigation.flipXRef.current,
        nav.navigation.flipYRef.current
      );
    },
    [nav.viewportRef, nav.navigation, dimensions]
  );

  // Modular Shape, Fill, Eyedropper, Text, Balloon & Liquify Tools
  const shapeFillTools = useShapeAndFillTools({
    dimensions,
    colorMode,
    layers: layerMgr.layers,
    activeLayer: layerMgr.activeLayer,
    activeLayerId: layerMgr.activeLayerId,
    selection: selectionTools.selection,
    layerCanvasesRef: layerMgr.layerCanvasesRef,
    layerSourceCanvasesRef: layerMgr.layerSourceCanvasesRef,
    isLayerEffectivelyVisible: layerMgr.isLayerEffectivelyVisible,
    getEffectiveOpacity: layerMgr.getEffectiveOpacity,
    getActiveCanvas: drawing.getActiveCanvas,
    getCanvasCoords,
    updateLayerThumbnail: layerMgr.updateLayerThumbnail,
    pushHistoryStep: drawing.pushHistoryStep,
  });

  // Modular Vector Edit Tool
  const vectorTools = useVectorDrawing({
    activeLayer: layerMgr.activeLayer,
    activeLayerId: layerMgr.activeLayerId,
    colorMode,
    getActiveCanvas: drawing.getActiveCanvas,
    getCanvasCoords,
    updateLayerThumbnail: layerMgr.updateLayerThumbnail,
    pushHistoryStep: drawing.pushHistoryStep,
    showToast,
  });

  // Tonal, Filter, Adjustment, Styles, Screentone & Expression Color Actions
  const tonalActions = useTonalAndFilterActions({
    hasOpenDocument,
    dimensions,
    colorMode,
    layers: layerMgr.layers,
    activeLayer: layerMgr.activeLayer,
    activeLayerId: layerMgr.activeLayerId,
    selection: selectionTools.selection,
    layerCanvasesRef: layerMgr.layerCanvasesRef,
    layerSourceCanvasesRef: layerMgr.layerSourceCanvasesRef,
    materializeLayerCanvas: layerMgr.materializeLayerCanvas,
    releaseLayerCanvas: layerMgr.releaseLayerCanvas,
    setActiveLayerId: layerMgr.setActiveLayerId,
    getActiveCanvas: drawing.getActiveCanvas,
    updateLayerThumbnail: layerMgr.updateLayerThumbnail,
    handleCommitFloatingSelection: selectionTools.handleCommitFloatingSelection,
    pushHistoryStepRef,
    addLayer: layerMgr.addLayer,
    pasteLayerFromCanvas: layerMgr.pasteLayerFromCanvas,
    addAdjustmentLayer: layerMgr.addAdjustmentLayer,
    updateAdjustmentData: layerMgr.updateAdjustmentData,
    updateLayerStyles: layerMgr.updateLayerStyles,
    fillScreentoneSelection: layerMgr.fillScreentoneSelection,
    applyExpressionColorOfPreview: layerMgr.applyExpressionColorOfPreview,
    applyLayerColorPermanently: layerMgr.applyLayerColorPermanently,
    convertLayer: layerMgr.convertLayer,
    showToast,
  });

  // Document Lifecycle Operations
  const docLifecycle = useDocumentLifecycle({
    layers: layerMgr.layers,
    activeLayer: layerMgr.activeLayer,
    activeLayerId: layerMgr.activeLayerId,
    layerCanvasesRef: layerMgr.layerCanvasesRef,
    getEffectiveOpacity: layerMgr.getEffectiveOpacity,
    isLayerEffectivelyVisible: layerMgr.isLayerEffectivelyVisible,
    setActiveLayerId: layerMgr.setActiveLayerId,
    resetToNewCanvas: layerMgr.resetToNewCanvas,
    setDefaultToneFrequency: layerMgr.setDefaultToneFrequency,
    clearDocument: layerMgr.clearDocument,
    loadDocument: layerMgr.loadDocument,
    switchDocumentSession: layerMgr.switchDocumentSession,
    resizeCanvas: layerMgr.resizeCanvas,
    copyLayer: layerMgr.copyLayer,
    pasteLayer: layerMgr.pasteLayer,
    deleteLayer: layerMgr.deleteLayer,
    pasteLayerFromFile: layerMgr.pasteLayerFromFile,
    resetZoomAndCenter: nav.resetZoomAndCenter,
    resetHistory: drawing.resetHistory,
    pushHistoryStep: drawing.pushHistoryStep,
    showToast,
  });

  const handleToggleReferenceLayer = useCallback(
    (layerId: string) => {
      layerMgr.setLayers((prev) =>
        prev.map((l) => (l.id === layerId ? { ...l, isReference: !l.isReference } : l))
      );
    },
    [layerMgr.setLayers]
  );

  const handleMergeDown = useCallback(() => {
    const res = layerMgr.mergeDown();
    if (res) {
      documentStoreActions.markDocumentDirty(activeDocumentId, true);
      showToast('Merged layer down');
    } else {
      showToast('Cannot merge down: need an unlocked raster layer below');
    }
  }, [layerMgr.mergeDown, activeDocumentId, showToast]);

  // Mark active document dirty whenever a new history step is committed on the same document
  const lastHistoryMetaRef = useRef<{ docId: string | null; itemId: string | null }>({
    docId: null,
    itemId: null,
  });
  useEffect(() => {
    const currentItem = drawing.historyList[drawing.historyIndex];
    const currentItemId = currentItem?.id ?? null;
    const prev = lastHistoryMetaRef.current;
    if (
      activeDocumentId &&
      prev.docId === activeDocumentId &&
      currentItemId &&
      currentItemId !== prev.itemId &&
      drawing.historyIndex > 0
    ) {
      documentStoreActions.markDocumentDirty(activeDocumentId, true);
    }
    lastHistoryMetaRef.current = { docId: activeDocumentId, itemId: currentItemId };
  }, [activeDocumentId, drawing.historyList, drawing.historyIndex]);

  // Unified Pointer Dispatcher reading tool imperatively from useToolStore
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, coalescedEvents?: PointerEvent[]) => {
      if (!hasOpenDocument || e.button !== 0) return;
      const tool = useToolStore.getState().tool;
      const pt = getCanvasCoords(e);

      if (tool === 'brush' || tool === 'eraser') {
        if (selectionTools.selection?.floating) {
          selectionTools.handleCommitFloatingSelection();
        }
        drawing.handlePointerDown(e, coalescedEvents);
        return;
      }

      if (tool === 'vector-edit') {
        vectorTools.handleVectorEditPointerDown(e, pt);
        return;
      }

      if (selectionTools.handleSelectionPointerDown(e, pt)) return;
      shapeFillTools.handleShapeFillPointerDown(e, pt);
    },
    [hasOpenDocument, getCanvasCoords, selectionTools, drawing, vectorTools, shapeFillTools]
  );

  const handlePointerMove = useCallback(
    (
      e: React.PointerEvent<HTMLElement>,
      coalescedEvents?: PointerEvent[],
      predictedEvents?: PointerEvent[]
    ) => {
      const tool = useToolStore.getState().tool;
      if (tool === 'brush' || tool === 'eraser') {
        drawing.handlePointerMove(e, coalescedEvents, predictedEvents);
        return;
      }
      if (tool === 'vector-edit') {
        vectorTools.handleVectorEditPointerMove(e);
        return;
      }
      if (shapeFillTools.handleShapeFillPointerMove(e)) return;
      selectionTools.handleSelectionPointerMove(getCanvasCoords(e));
    },
    [drawing, vectorTools, shapeFillTools, selectionTools, getCanvasCoords]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const tool = useToolStore.getState().tool;
      if (tool === 'brush' || tool === 'eraser') {
        drawing.handlePointerUp(e);
        return;
      }
      if (tool === 'vector-edit') {
        vectorTools.handleVectorEditPointerUp();
        return;
      }
      const pt = getCanvasCoords(e);
      if (selectionTools.handleSelectionPointerUp(pt)) return;
      shapeFillTools.handleShapeFillPointerUp(e, pt);
    },
    [drawing, vectorTools, getCanvasCoords, selectionTools, shapeFillTools]
  );

  // Memoized Top Menu Bar Sections (independent of brush size & color)
  const menuSections = useAppMenuSections({
    hasOpenDocument,
    dimensions,
    layers: layerMgr.layers,
    activeLayer: layerMgr.activeLayer,
    activeLayerId: layerMgr.activeLayerId,
    selection: selectionTools.selection,
    canUndo: drawing.canUndo,
    canRedo: drawing.canRedo,
    flipX: nav.flipX,
    flipY: nav.flipY,
    isWebtoonMode,
    perspectiveRuler,
    softProofSettings,
    activeAnimationTimeline,
    clearCanvas: drawing.clearCanvas,
    handleUndo,
    redo: drawing.redo,
    handleTriggerOpenFile: docLifecycle.handleTriggerOpenFile,
    handleTriggerImport3DFile: docLifecycle.handleTriggerImport3DFile,
    handleSave: docLifecycle.handleSave,
    handleSaveAs: docLifecycle.handleSaveAs,
    handleExportImage: docLifecycle.handleExportImage,
    handleCopySelectedLayer: docLifecycle.handleCopySelectedLayer,
    handlePasteSelectedLayer: docLifecycle.handlePasteSelectedLayer,
    handleTriggerPasteFromFile: docLifecycle.handleTriggerPasteFromFile,
    handleDeleteSelectedLayer: docLifecycle.handleDeleteSelectedLayer,
    handleClearActiveLayer: collab.handleClearActiveLayer,
    handleStartTransform: selectionTools.handleStartTransform,
    handleDeselect: selectionTools.handleDeselect,
    handleFillSelectionColor: selectionTools.handleFillSelectionColor,
    handleOpenTonalModal: tonalActions.handleOpenTonalModal,
    handleApplyReverseGradient: tonalActions.handleApplyReverseGradient,
    handleSelectAll: selectionTools.handleSelectAll,
    handleInvertSelection: selectionTools.handleInvertSelection,
    handleExpandSelection: selectionTools.handleExpandSelection,
    handleContractSelection: selectionTools.handleContractSelection,
    handleFeatherSelection: selectionTools.handleFeatherSelection,
    handleAddLayer: collab.handleAddLayer,
    handleOpenAdjustmentModal: tonalActions.handleOpenAdjustmentModal,
    addLayerMask: layerMgr.addLayerMask,
    removeLayerMask: layerMgr.removeLayerMask,
    toggleLayerMask: layerMgr.toggleLayerMask,
    toggleMaskLinked: layerMgr.toggleMaskLinked,
    duplicateLayer: layerMgr.duplicateLayer,
    handleMergeDown,
    handleOpenLayerStylesModal: tonalActions.handleOpenLayerStylesModal,
    toggleLayerColor: layerMgr.toggleLayerColor,
    handleConvertLayer: tonalActions.handleConvertLayer,
    deleteLayer: layerMgr.deleteLayer,
    handleApplyFilter: tonalActions.handleApplyFilter,
    zoomIn: nav.zoomIn,
    zoomOut: nav.zoomOut,
    resetZoomAndCenter: nav.resetZoomAndCenter,
    resetRotation: nav.resetRotation,
    toggleFlipHorizontal: nav.toggleFlipHorizontal,
    toggleFlipVertical: nav.toggleFlipVertical,
    resetViewFlip: nav.resetViewFlip,
    handleUpdateAnimationTimeline,
    handleAddAnimationCel,
    showToast,
  });

  const handleOpenCollabModal = useCallback(() => {
    collab.setIsHostModalOpen(true);
  }, [collab.setIsHostModalOpen]);

  const canvasProps = useMemo(
    () => ({
      viewportRef: nav.viewportRef,
      onViewportReady: docLifecycle.handleViewportReady,
      zoom: nav.zoom,
      pan: nav.pan,
      rotation: nav.rotation,
      flipX: nav.flipX,
      flipY: nav.flipY,
      navigation: nav.navigation,
      isSpaceDown: nav.isSpaceDown,
      isShiftDown: nav.isShiftDown,
      isRotateModifier: nav.isRotateModifier,
      isPanning: nav.isPanning,
      isRotating: nav.isRotating,
      isZoomDragging: nav.isZoomDragging,
      startPan: nav.startPan,
      startRotate: nav.startRotate,
      startZoomDrag: nav.startZoomDrag,
      onSampleColor: shapeFillTools.handleSampleColor,
      onUndo: handleUndo,
      onRedo: drawing.redo,
      onFlipHorizontal: nav.toggleFlipHorizontal,
      isHovering: drawing.isHovering,
      cursorPos: drawing.cursorPos,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerEnter: drawing.handlePointerEnter,
      onPointerLeave: drawing.handlePointerLeave,
      layers: layerMgr.layers,
      activeLayerId: layerMgr.activeLayerId,
      tileGrid: activeTileGrid,
      layerCanvasesRef: layerMgr.layerCanvasesRef,
      registerLayerCanvas: layerMgr.registerLayerCanvas,
      getEffectiveOpacity: layerMgr.getEffectiveOpacity,
      isLayerEffectivelyVisible: layerMgr.isLayerEffectivelyVisible,
      interactionRef: drawing.interactionRef,
      draftCanvasRef,
      strokeCanvasRef,
      peers: collab.peers,
      activePings: collab.activePings,
      remoteDraftCanvasesRef: collab.remoteDraftCanvasesRef,
      selection: selectionTools.selection,
      onDeselect: selectionTools.handleDeselect,
      onTransformSelection: selectionTools.handleStartTransform,
      onFillScreentone: tonalActions.handleFillScreentone,
      onFillColor: selectionTools.handleFillSelectionColor,
      onClearSelection: selectionTools.handleClearSelection,
      onInvertSelection: selectionTools.handleInvertSelection,
      onExpandSelection: selectionTools.handleExpandSelection,
      onContractSelection: selectionTools.handleContractSelection,
      onFeatherSelection: selectionTools.handleFeatherSelection,
      transformSession: selectionTools.transformSession,
      setTransformSession: selectionTools.setTransformSession,
      onApplyTransform: selectionTools.handleApplyTransform,
      onCancelTransform: selectionTools.handleCancelTransform,
      textSession: shapeFillTools.textSession,
      setTextSession: shapeFillTools.setTextSession,
      onConfirmText: shapeFillTools.handleConfirmText,
      onCancelText: shapeFillTools.handleCancelText,
      onInsertRasterLayer: tonalActions.handleInsert3DRasterLayer,
      activeBalloon: shapeFillTools.activeBalloon,
      setActiveBalloon: shapeFillTools.setActiveBalloon,
      onConfirmBalloon: shapeFillTools.handleConfirmBalloon,
      onDeleteBalloon: shapeFillTools.handleDeleteBalloon,
      animationTimeline: activeAnimationTimeline,
      onUpdateAnimationTimeline: handleUpdateAnimationTimeline,
      onAddAnimationCel: handleAddAnimationCel,
      onDeleteAnimationCel: handleDeleteAnimationCel,
      onSelectCelLayer: layerMgr.setActiveLayerId,
    }),
    [
      nav,
      docLifecycle.handleViewportReady,
      drawing.isHovering,
      drawing.cursorPos,
      drawing.handlePointerEnter,
      drawing.handlePointerLeave,
      drawing.interactionRef,
      handlePointerDown,
      handlePointerMove,
      handlePointerUp,
      layerMgr.layers,
      layerMgr.activeLayerId,
      layerMgr.layerCanvasesRef,
      layerMgr.registerLayerCanvas,
      layerMgr.getEffectiveOpacity,
      layerMgr.isLayerEffectivelyVisible,
      layerMgr.setActiveLayerId,
      activeTileGrid,
      collab.peers,
      collab.activePings,
      collab.remoteDraftCanvasesRef,
      selectionTools,
      tonalActions.handleFillScreentone,
      tonalActions.handleInsert3DRasterLayer,
      shapeFillTools.textSession,
      shapeFillTools.setTextSession,
      shapeFillTools.handleConfirmText,
      shapeFillTools.handleCancelText,
      shapeFillTools.activeBalloon,
      shapeFillTools.setActiveBalloon,
      shapeFillTools.handleConfirmBalloon,
      shapeFillTools.handleDeleteBalloon,
      shapeFillTools.handleSampleColor,
      handleUndo,
      drawing.redo,
      activeAnimationTimeline,
      handleUpdateAnimationTimeline,
      handleAddAnimationCel,
      handleDeleteAnimationCel,
    ]
  );

  return (
    <AppShell
      fileInputRef={docLifecycle.fileInputRef}
      pasteFileInputRef={docLifecycle.pasteFileInputRef}
      import3DFileInputRef={docLifecycle.import3DFileInputRef}
      handleFileInputChange={docLifecycle.handleFileInputChange}
      handlePasteFileInputChange={docLifecycle.handlePasteFileInputChange}
      handleImport3DFileInputChange={docLifecycle.handleImport3DFileInputChange}
      canUndo={drawing.canUndo}
      canRedo={drawing.canRedo}
      handleUndo={handleUndo}
      redo={drawing.redo}
      zoom={nav.zoom}
      zoomIn={nav.zoomIn}
      zoomOut={nav.zoomOut}
      resetZoomAndCenter={nav.resetZoomAndCenter}
      rotation={nav.rotation}
      resetRotation={nav.resetRotation}
      flipX={nav.flipX}
      flipY={nav.flipY}
      toggleFlipHorizontal={nav.toggleFlipHorizontal}
      toggleFlipVertical={nav.toggleFlipVertical}
      resetViewFlip={nav.resetViewFlip}
      menuSections={menuSections}
      handleSelectDocument={docLifecycle.handleSelectDocument}
      handleCloseDocument={docLifecycle.handleCloseDocument}
      handleRenameDocument={docLifecycle.handleRenameDocument}
      handleSave={docLifecycle.handleSave}
      handleSaveAs={docLifecycle.handleSaveAs}
      handleClearActiveLayer={collab.handleClearActiveLayer}
      handleMergeDown={handleMergeDown}
      isCollabConnected={collab.isConnected}
      collabPeerCount={collab.peers.length + 1}
      onOpenCollabModal={handleOpenCollabModal}
      handleTriggerOpenFile={docLifecycle.handleTriggerOpenFile}
      handleSelectWelcomeDocument={docLifecycle.handleSelectWelcomeDocument}
      showToast={showToast}
      canvasProps={canvasProps}
      historyList={drawing.historyList}
      historyIndex={drawing.historyIndex}
      jumpToHistoryIndex={drawing.jumpToHistoryIndex}
      layers={layerMgr.layers}
      activeLayerId={layerMgr.activeLayerId}
      selectedLayerIds={layerMgr.selectedLayerIds}
      setActiveLayerId={layerMgr.setActiveLayerId}
      toggleLayerSelection={layerMgr.toggleLayerSelection}
      handleGroupSelectedLayers={collab.handleGroupSelectedLayers}
      handleDeleteSelectedLayers={collab.handleDeleteSelectedLayers}
      handleAddLayer={collab.handleAddLayer}
      duplicateLayer={layerMgr.duplicateLayer}
      handleDeleteLayer={collab.handleDeleteLayer}
      handleToggleVisibility={collab.handleToggleVisibility}
      handleSetOpacity={collab.handleSetOpacity}
      setBlendMode={layerMgr.setBlendMode}
      toggleLock={layerMgr.toggleLock}
      toggleAlphaLock={layerMgr.toggleAlphaLock}
      toggleClipping={layerMgr.toggleClipping}
      toggleCollapse={layerMgr.toggleCollapse}
      handleRenameLayer={collab.handleRenameLayer}
      moveLayer={layerMgr.moveLayer}
      moveLayerToFolder={layerMgr.moveLayerToFolder}
      reorderLayers={layerMgr.reorderLayers}
      handleToggleReferenceLayer={handleToggleReferenceLayer}
      toggleTone={layerMgr.toggleTone}
      setToneFrequency={layerMgr.setToneFrequency}
      setToneAngle={layerMgr.setToneAngle}
      setToneDotShape={layerMgr.setToneDotShape}
      setToneDensity={layerMgr.setToneDensity}
      setToneDensityType={layerMgr.setToneDensityType}
      toggleLayerColor={layerMgr.toggleLayerColor}
      setLayerColor={layerMgr.setLayerColor}
      setLayerSubColor={layerMgr.setLayerSubColor}
      setLayerExpressionColor={layerMgr.setLayerExpressionColor}
      setLayerMonoThreshold={layerMgr.setLayerMonoThreshold}
      setLayerMonoExpressMode={layerMgr.setLayerMonoExpressMode}
      handleApplyExpressionColor={tonalActions.handleApplyExpressionColor}
      handleApplyLayerColor={tonalActions.handleApplyLayerColor}
      addLayerMask={layerMgr.addLayerMask}
      removeLayerMask={layerMgr.removeLayerMask}
      toggleLayerMask={layerMgr.toggleLayerMask}
      toggleMaskLinked={layerMgr.toggleMaskLinked}
      handleOpenAdjustmentModal={tonalActions.handleOpenAdjustmentModal}
      handleOpenLayerStylesModal={tonalActions.handleOpenLayerStylesModal}
    >
      <DocumentLifecycleManager
        layers={layerMgr.layers}
        activeLayerId={layerMgr.activeLayerId}
        layerCanvasesRef={layerMgr.layerCanvasesRef}
        needsAdaptiveFitRef={docLifecycle.needsAdaptiveFitRef}
        pendingFitDimsRef={docLifecycle.pendingFitDimsRef}
        resetToNewCanvas={layerMgr.resetToNewCanvas}
        resetZoomAndCenter={nav.resetZoomAndCenter}
        resetHistory={drawing.resetHistory}
      />

      <GlobalShortcutListener
        hasOpenDocument={hasOpenDocument}
        dimensions={dimensions}
        layers={layerMgr.layers}
        activeLayer={layerMgr.activeLayer}
        activeLayerId={layerMgr.activeLayerId}
        selection={selectionTools.selection}
        transformSession={selectionTools.transformSession}
        textSession={shapeFillTools.textSession}
        activeAnimationTimeline={activeAnimationTimeline}
        isSpaceDown={nav.isSpaceDown}
        isHostModalOpen={collab.isHostModalOpen}
        isDrawingRef={drawing.isDrawingRef}
        isSelectionPenDrawingRef={selectionTools.isSelectionPenDrawingRef}
        isPipetteSamplingRef={shapeFillTools.isPipetteSamplingRef}
        handleUndo={handleUndo}
        redo={drawing.redo}
        handleAddLayer={collab.handleAddLayer}
        handleTriggerOpenFile={docLifecycle.handleTriggerOpenFile}
        handleSave={docLifecycle.handleSave}
        handleSaveAs={docLifecycle.handleSaveAs}
        duplicateLayer={layerMgr.duplicateLayer}
        handleCopySelectedLayer={docLifecycle.handleCopySelectedLayer}
        handlePasteSelectedLayer={docLifecycle.handlePasteSelectedLayer}
        handleGroupSelectedLayers={collab.handleGroupSelectedLayers}
        handleStartTransform={selectionTools.handleStartTransform}
        handleSelectAll={selectionTools.handleSelectAll}
        handleDeselect={selectionTools.handleDeselect}
        handleInvertSelection={selectionTools.handleInvertSelection}
        handleApplyReverseGradient={tonalActions.handleApplyReverseGradient}
        handleOpenTonalModal={tonalActions.handleOpenTonalModal}
        handleUpdateAnimationTimeline={handleUpdateAnimationTimeline}
        handleAddAnimationCel={handleAddAnimationCel}
        zoomIn={nav.zoomIn}
        zoomOut={nav.zoomOut}
        resetZoomAndCenter={nav.resetZoomAndCenter}
        resetRotation={nav.resetRotation}
        toggleFlipHorizontal={nav.toggleFlipHorizontal}
        toggleFlipVertical={nav.toggleFlipVertical}
        handleClearSelection={selectionTools.handleClearSelection}
        handleDeleteSelectedLayer={docLifecycle.handleDeleteSelectedLayer}
        handleCancelTransform={selectionTools.handleCancelTransform}
        handleCancelText={shapeFillTools.handleCancelText}
        handleApplyTransform={selectionTools.handleApplyTransform}
        handleProcessFile={docLifecycle.handleProcessFile}
        showToast={showToast}
      />

      <ModalHost
        layers={layerMgr.layers}
        activeLayer={layerMgr.activeLayer}
        layerCanvasesRef={layerMgr.layerCanvasesRef}
        getEffectiveOpacity={layerMgr.getEffectiveOpacity}
        isLayerEffectivelyVisible={layerMgr.isLayerEffectivelyVisible}
        handleCreateNewCanvas={docLifecycle.handleCreateNewCanvas}
        handleResizeCanvas={docLifecycle.handleResizeCanvas}
        handleUpdateSettings={docLifecycle.handleUpdateSettings}
        handleRestoreCrashedSession={docLifecycle.handleRestoreCrashedSession}
        handleDiscardCrashedSession={docLifecycle.handleDiscardCrashedSession}
        handleTonalCancel={tonalActions.handleTonalCancel}
        handleTonalApply={tonalActions.handleTonalApply}
        handleTonalPreviewChange={tonalActions.handleTonalPreviewChange}
        handleApplyAdjustment={tonalActions.handleApplyAdjustment}
        handleApplyLayerStyles={tonalActions.handleApplyLayerStyles}
        handleConfirmTone={tonalActions.handleConfirmTone}
        handleApplyMangaEffects={tonalActions.handleApplyMangaEffects}
        isHostModalOpen={collab.isHostModalOpen}
        setIsHostModalOpen={collab.setIsHostModalOpen}
        isCollabHost={collab.isHost}
        isCollabConnected={collab.isConnected}
        collabHostInfo={collab.hostInfo}
        collabPeers={collab.peers}
        collabMyPeer={collab.myPeer}
        updateMyName={collab.updateMyName}
        handleStartHosting={collab.handleStartHosting}
        stopHosting={collab.stopHosting}
        clipboardInvite={collab.clipboardInvite}
        setClipboardInvite={collab.setClipboardInvite}
        webLandingInvite={collab.webLandingInvite}
        setWebLandingInvite={collab.setWebLandingInvite}
        joinRoom={collab.joinRoom}
        showToast={showToast}
      />
    </AppShell>
  );
}

export default App;
