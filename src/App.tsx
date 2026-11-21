import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimationTimeline, BlendMode, ExpressionColor, FilterType, LayerItem } from './types/editor';
import {
  createDefaultAnimationTimeline,
  removeFrameCel,
  setFrameCel,
} from './utils/animationEngine';
import { screenToCanvas } from './utils/canvasUtils';
import { createDefaultPageFrame } from './utils/frameEngine';
import { AutoAction, AutoActionExecutionContext, executeAutoAction } from './utils/autoActionEngine';
import { globalTimelapseManager } from './utils/timelapseEngine';
import { globalTileGrid, parseTileKey } from './utils/tileEngine';
import { documentStore } from './utils/documentStore';
import { multiplayerService } from './services/multiplayerService';
import { updaterService } from './services/updaterService';
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
  autoActionStoreActions,
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
  const straightRuler = useDocumentStore((s) => s.straightRuler);
  const activeEditTarget = useDocumentStore((s) => s.activeEditTarget);
  const animationTimeline = useDocumentStore((s) => s.animationTimeline);
  const isWebtoonMode = useUiStore((s) => s.isWebtoonMode);

  // Delayed silent startup check for desktop Tauri updates (never blocks startup or crash recovery)
  useEffect(() => {
    return updaterService.scheduleStartupUpdateCheck(4500);
  }, []);

  const draftCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokeCanvasRef = draftCanvasRef;
  const selectiveUndoRef = useRef<(peerId?: string | number, strokeId?: string) => unknown>(() => {});
  const pushHistoryStepRef = useRef<PushHistoryStepFn | null>(null);
  const getActiveCanvasRef = useRef<() => HTMLCanvasElement | null>(() => null);
  const flushPendingHistoryTasksRef = useRef<() => void>(() => {});
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
    materializeLayerCanvas: layerMgr.materializeLayerCanvas,
    pushHistoryStepRef,
    selectiveUndoRef,
    resetZoomAndCenter: nav.resetZoomAndCenter,
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
  const stableFlushPendingHistoryTasks = useCallback(
    () => flushPendingHistoryTasksRef.current(),
    []
  );
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
    materializeLayerCanvas: layerMgr.materializeLayerCanvas,
    tileGrid: activeTileGrid,
    flushPendingHistoryTasks: stableFlushPendingHistoryTasks,
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
    straightRuler: hasOpenDocument ? straightRuler : null,
    onActiveConstraintAxisChange: documentStoreActions.setActiveLockedAxis,
    selection: hasOpenDocument ? selectionTools.selection : null,
  });

  selectiveUndoRef.current = drawing.selectiveUndo;
  pushHistoryStepRef.current = drawing.pushHistoryStep;
  getActiveCanvasRef.current = drawing.getActiveCanvas;
  flushPendingHistoryTasksRef.current = drawing.flushPendingHistoryTasks;

  const handleUndo = useCallback(() => {
    if (selectionTools.transformSession?.active) {
      selectionTools.handleCancelTransform();
      return;
    }
    if (collab.isConnected && collab.myPeer.id) {
      void drawing.selectiveUndo('local').then((undone) => {
        if (!undone || !multiplayerService.isConnected()) return;
        if (undone.strokeId) {
          multiplayerService.sendSelectiveUndo(undone.strokeId);
        } else if (undone.tileDeltas && undone.tileDeltas.length > 0) {
          const grid = documentStore.getActiveTileGrid();
          for (const delta of undone.tileDeltas) {
            const { layerId, tileX, tileY } = parseTileKey(delta.key);
            const tile = grid.getTile(layerId, tileX, tileY, 0);
            if (tile) {
              multiplayerService.sendTileDelta(layerId, tile);
            } else {
              multiplayerService.sendTileDelta(layerId, {
                layerId,
                tileX,
                tileY,
                format: delta.format,
                data: null,
                dirty: true,
                version: 0,
                isPagedToDisk: false,
                lastAccessTimestamp: Date.now(),
                lod: 0,
              });
            }
          }
        }
      });
    } else {
      drawing.undo();
    }
  }, [collab.isConnected, collab.myPeer.id, drawing, selectionTools]);

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

  // Modular Shape, Fill, Eyedropper, Text, Balloon, Frame Folder & Liquify Tools
  const shapeFillTools = useShapeAndFillTools({
    dimensions,
    colorMode,
    layers: layerMgr.layers,
    activeLayer: layerMgr.activeLayer,
    activeLayerId: layerMgr.activeLayerId,
    selectedLayerIds: layerMgr.selectedLayerIds,
    selection: selectionTools.selection,
    layerCanvasesRef: layerMgr.layerCanvasesRef,
    layerSourceCanvasesRef: layerMgr.layerSourceCanvasesRef,
    materializeLayerCanvas: layerMgr.materializeLayerCanvas,
    flushPendingHistoryTasks: drawing.flushPendingHistoryTasks,
    isLayerEffectivelyVisible: layerMgr.isLayerEffectivelyVisible,
    getEffectiveOpacity: layerMgr.getEffectiveOpacity,
    getActiveCanvas: drawing.getActiveCanvas,
    getCanvasCoords,
    setActiveLayerId: layerMgr.setActiveLayerId,
    upsertTextLayer: layerMgr.upsertTextLayer,
    upsertBalloonLayer: layerMgr.upsertBalloonLayer,
    createFrameFolder: layerMgr.createFrameFolder,
    divideFrameFolder: layerMgr.divideFrameFolder,
    deleteLayer: layerMgr.deleteLayer,
    updateLayerThumbnail: layerMgr.updateLayerThumbnail,
    pushHistoryStep: drawing.pushHistoryStep,
    showToast,
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
      autoActionStoreActions.recordStep('merge-down', 'Merge Down');
      showToast('Merged layer down');
    } else {
      showToast('Cannot merge down: need an unlocked raster layer below');
    }
  }, [layerMgr.mergeDown, activeDocumentId, showToast]);

  const handleAddDefaultFrameFolder = useCallback(() => {
    const dpi = dimensions.dpi ?? 600;
    const defaultFrame = createDefaultPageFrame('', dimensions.width, dimensions.height, dpi, 15);
    const { folder } = layerMgr.createFrameFolder([defaultFrame], undefined, true);
    drawing.pushHistoryStep('frame', 'New Frame Border Folder', null, null, folder.id);
    autoActionStoreActions.recordStep('create-frame-folder', 'New Frame Border Folder');
    showToast('Created Frame Border Folder');
  }, [dimensions, layerMgr.createFrameFolder, drawing.pushHistoryStep, showToast]);

  const handleRasterizeLayer = useCallback(
    (layerId: string) => {
      const ok = layerMgr.rasterizeLayer(layerId);
      if (ok) {
        drawing.pushHistoryStep('layer-convert', 'Rasterize Layer', null, null, layerId);
        autoActionStoreActions.recordStep('rasterize-layer', 'Rasterize Layer');
        showToast('Layer rasterized');
      } else {
        showToast('Only Text, Speech Balloon, or Vector layers can be rasterized');
      }
    },
    [layerMgr.rasterizeLayer, drawing.pushHistoryStep, showToast]
  );

  // Auto-Action Recording Wrappers for common layer/filter commands
  const handleRecordedAddLayer = useCallback(
    (type: 'raster' | 'folder' = 'raster') => {
      collab.handleAddLayer(type);
      autoActionStoreActions.recordStep(
        type === 'folder' ? 'create-folder' : 'create-layer',
        type === 'folder' ? 'Create Folder' : 'Create Layer'
      );
    },
    [collab.handleAddLayer]
  );

  const handleRecordedDuplicateLayer = useCallback(
    (id: string) => {
      layerMgr.duplicateLayer(id);
      autoActionStoreActions.recordStep('duplicate-layer', 'Duplicate Layer');
    },
    [layerMgr.duplicateLayer]
  );

  const handleRecordedSetBlendMode = useCallback(
    (id: string, blendMode: BlendMode) => {
      layerMgr.setBlendMode(id, blendMode);
      autoActionStoreActions.recordStep('set-blend-mode', `Blend Mode: ${blendMode}`, { blendMode });
    },
    [layerMgr.setBlendMode]
  );

  const handleRecordedSetOpacity = useCallback(
    (id: string, opacity: number) => {
      collab.handleSetOpacity(id, opacity);
      autoActionStoreActions.recordStep('set-opacity', `Opacity: ${Math.round(opacity * 100)}%`, {
        opacity,
      });
    },
    [collab.handleSetOpacity]
  );

  const handleRecordedToggleClipping = useCallback(
    (id: string) => {
      layerMgr.toggleClipping(id);
      autoActionStoreActions.recordStep('toggle-clipping', 'Toggle Clipping Mask');
    },
    [layerMgr.toggleClipping]
  );

  const handleRecordedApplyFilter = useCallback(
    (type: FilterType, params?: import('./hooks/useTonalAndFilterActions').AnyFilterParams) => {
      tonalActions.handleApplyFilter(type, params);
      autoActionStoreActions.recordStep('apply-filter', `Filter: ${type}`, {
        filterType: type,
        ...(params || {}),
      });
    },
    [tonalActions.handleApplyFilter]
  );

  const handleRecordedSetExpressionColor = useCallback(
    (id: string, mode: ExpressionColor) => {
      layerMgr.setLayerExpressionColor(id, mode);
      autoActionStoreActions.recordStep('set-expression-color', `Expression Color: ${mode}`, { mode });
    },
    [layerMgr.setLayerExpressionColor]
  );

  const handlePlayAutoAction = useCallback(
    async (action: AutoAction) => {
      if (!hasOpenDocument) return;
      autoActionStoreActions.setIsPlaying(true);
      let currentLayerId = layerMgr.activeLayerId;
      let groupStartBefore: ImageData | null = null;
      let groupTargetLayerId = currentLayerId;

      const ctx: AutoActionExecutionContext = {
        getActiveLayerId: () => currentLayerId,
        createLayer: (name, type = 'raster') => {
          const created = layerMgr.addLayer(type, undefined, name, undefined, true);
          currentLayerId = created.id;
          return created.id;
        },
        createFolder: (name) => {
          const created = layerMgr.addLayer('folder', undefined, name, undefined, true);
          currentLayerId = created.id;
          return created.id;
        },
        createFrameFolder: (name) => {
          const dpi = dimensions.dpi ?? 600;
          const df = createDefaultPageFrame('', dimensions.width, dimensions.height, dpi, 15);
          const { folder } = layerMgr.createFrameFolder([df], name, true);
          currentLayerId = folder.id;
          return folder.id;
        },
        duplicateLayer: (id) => layerMgr.duplicateLayer(id),
        deleteLayer: (id) => layerMgr.deleteLayer(id),
        renameLayer: (id, name) => layerMgr.renameLayer(id, name),
        setBlendMode: (id, blendMode) => layerMgr.setBlendMode(id, blendMode),
        setOpacity: (id, opacity) => layerMgr.setOpacity(id, opacity),
        setVisibility: (id) => layerMgr.toggleVisibility(id),
        setClipping: (id, clipped) => {
          const existing = layerMgr.layers.find((l) => l.id === id);
          if (clipped === undefined || Boolean(existing?.clipped) !== clipped) {
            layerMgr.toggleClipping(id);
          }
        },
        setAlphaLock: (id) => layerMgr.toggleAlphaLock(id),
        setExpressionColor: (id, mode) => layerMgr.setLayerExpressionColor(id, mode),
        setLayerColor: (id, enabled, color) => {
          if (color) layerMgr.setLayerColor(id, color);
          const existing = layerMgr.layers.find((l) => l.id === id);
          if (Boolean(existing?.layerColorEnabled) !== enabled) {
            layerMgr.toggleLayerColor(id);
          }
        },
        setTone: (id, enabled, opts) => {
          const existing = layerMgr.layers.find((l) => l.id === id);
          if (Boolean(existing?.toneEnabled) !== enabled) {
            layerMgr.toggleTone(id);
          }
          if (opts?.frequency !== undefined) layerMgr.setToneFrequency(id, opts.frequency);
          if (opts?.density !== undefined) layerMgr.setToneDensity(id, opts.density);
          if (opts?.angle !== undefined) layerMgr.setToneAngle(id, opts.angle);
        },
        fillLayer: (id, color) => {
          const canvas = layerMgr.materializeLayerCanvas(id);
          if (!canvas) return;
          const c2d = canvas.getContext('2d');
          if (!c2d) return;
          if (!groupStartBefore) {
            groupStartBefore = c2d.getImageData(0, 0, canvas.width, canvas.height);
            groupTargetLayerId = id;
          }
          c2d.save();
          c2d.fillStyle = color;
          c2d.fillRect(0, 0, canvas.width, canvas.height);
          c2d.restore();
          activeTileGrid.ingestCanvas(id, canvas, 'color-32bit');
          activeTileGrid.notifyChange(true);
          layerMgr.updateLayerThumbnail(id, true);
        },
        clearLayer: (id) => {
          activeTileGrid.clearLayer(id);
          const canvas = layerMgr.layerCanvasesRef.current.get(id);
          if (canvas) {
            canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
          }
          activeTileGrid.notifyChange(true);
          layerMgr.updateLayerThumbnail(id, true);
        },
        mergeDown: () => {
          layerMgr.mergeDown();
        },
        rasterizeLayer: (id) => {
          layerMgr.rasterizeLayer(id);
        },
        applyFilter: (type, params) => {
          tonalActions.handleApplyFilter(
            type,
            params as unknown as import('./hooks/useTonalAndFilterActions').AnyFilterParams
          );
        },
        exportImage: () => {
          docLifecycle.handleExportImage();
        },
        endHistoryGroup: (label) => {
          const targetCanvas = groupTargetLayerId
            ? layerMgr.layerCanvasesRef.current.get(groupTargetLayerId)
            : null;
          const afterImg =
            groupStartBefore && targetCanvas
              ? targetCanvas.getContext('2d')?.getImageData(0, 0, targetCanvas.width, targetCanvas.height) ?? null
              : null;
          drawing.pushHistoryStep(
            'auto-action',
            label,
            groupStartBefore,
            afterImg,
            groupTargetLayerId || currentLayerId
          );
        },
      };

      try {
        const res = await executeAutoAction(action, ctx);
        if (res.errors.length > 0) {
          showToast(`Auto Action "${action.name}" finished with ${res.errors.length} error(s)`);
        } else {
          showToast(`Played "${action.name}" (${res.executedSteps} steps)`);
        }
      } finally {
        autoActionStoreActions.setIsPlaying(false);
      }
    },
    [
      hasOpenDocument,
      layerMgr,
      dimensions,
      activeTileGrid,
      tonalActions.handleApplyFilter,
      docLifecycle.handleExportImage,
      drawing.pushHistoryStep,
      showToast,
    ]
  );

  // Time-lapse recording reactive toggle & keyframe capture on committed history steps
  const [isTimelapseRecording, setIsTimelapseRecording] = useState<boolean>(() =>
    globalTimelapseManager.isRecording(activeDocumentId)
  );
  useEffect(() => {
    setIsTimelapseRecording(globalTimelapseManager.isRecording(activeDocumentId));
    return globalTimelapseManager.subscribe(() => {
      setIsTimelapseRecording(globalTimelapseManager.isRecording(activeDocumentId));
    });
  }, [activeDocumentId]);

  const handleCaptureTimelapseNow = useCallback(() => {
    if (!activeDocumentId) return;
    globalTimelapseManager
      .captureKeyframe(activeDocumentId, layerMgr.layers, dimensions, activeTileGrid, true)
      .catch(() => {});
  }, [activeDocumentId, layerMgr.layers, dimensions, activeTileGrid]);

  const handleToggleTimelapseRecording = useCallback(() => {
    if (!activeDocumentId) return;
    const next = globalTimelapseManager.toggleRecording(activeDocumentId);
    if (next) {
      globalTimelapseManager
        .captureKeyframe(activeDocumentId, layerMgr.layers, dimensions, activeTileGrid, true)
        .catch(() => {});
      showToast('Time-lapse recording started');
    } else {
      showToast('Time-lapse recording paused');
    }
  }, [activeDocumentId, layerMgr.layers, dimensions, activeTileGrid, showToast]);

  // Mark active document dirty & record time-lapse keyframe whenever a new history step is committed
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
      if (globalTimelapseManager.isRecording(activeDocumentId)) {
        globalTimelapseManager
          .captureKeyframe(activeDocumentId, layerMgr.layers, dimensions, activeTileGrid)
          .catch(() => {});
      }
    }
    lastHistoryMetaRef.current = { docId: activeDocumentId, itemId: currentItemId };
  }, [activeDocumentId, drawing.historyList, drawing.historyIndex, layerMgr.layers, dimensions, activeTileGrid]);

  // Unified Pointer Dispatcher reading tool imperatively from useToolStore
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, coalescedEvents?: PointerEvent[]) => {
      if (!hasOpenDocument || e.button !== 0) return;
      if (selectionTools.transformSession?.active) return;
      const tool = useToolStore.getState().tool;
      const pt = getCanvasCoords(e);

      if (tool === 'brush' || tool === 'eraser') {
        const curLayer = layerMgr.activeLayer;
        if (curLayer?.type === 'text' || curLayer?.type === 'balloon') {
          showToast('Use Text/Object tool to edit, or Rasterize Layer to paint directly');
          return;
        }
        if (curLayer?.type === 'frame-folder') {
          showToast('Select a child layer inside the Frame Border Folder to draw');
          return;
        }
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
    straightRuler,
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
    handleAddLayer: handleRecordedAddLayer,
    handleOpenAdjustmentModal: tonalActions.handleOpenAdjustmentModal,
    addLayerMask: layerMgr.addLayerMask,
    removeLayerMask: layerMgr.removeLayerMask,
    toggleLayerMask: layerMgr.toggleLayerMask,
    toggleMaskLinked: layerMgr.toggleMaskLinked,
    duplicateLayer: handleRecordedDuplicateLayer,
    handleMergeDown,
    handleOpenLayerStylesModal: tonalActions.handleOpenLayerStylesModal,
    toggleLayerColor: layerMgr.toggleLayerColor,
    handleConvertLayer: tonalActions.handleConvertLayer,
    deleteLayer: layerMgr.deleteLayer,
    handleApplyFilter: handleRecordedApplyFilter,
    zoomIn: nav.zoomIn,
    zoomOut: nav.zoomOut,
    resetZoomAndCenter: nav.resetZoomAndCenter,
    resetRotation: nav.resetRotation,
    toggleFlipHorizontal: nav.toggleFlipHorizontal,
    toggleFlipVertical: nav.toggleFlipVertical,
    resetViewFlip: nav.resetViewFlip,
    handleUpdateAnimationTimeline,
    handleAddAnimationCel,
    handleAddDefaultFrameFolder,
    handleRasterizeLayer,
    isTimelapseRecording,
    handleToggleTimelapseRecording,
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
      frameDragPreview: shapeFillTools.frameDragPreview,
      shapeDragPreview: shapeFillTools.shapeDragPreview,
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
      shapeFillTools.frameDragPreview,
      shapeFillTools.shapeDragPreview,
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
      handleAddLayer={handleRecordedAddLayer}
      duplicateLayer={handleRecordedDuplicateLayer}
      handleDeleteLayer={collab.handleDeleteLayer}
      handleToggleVisibility={collab.handleToggleVisibility}
      handleSetOpacity={handleRecordedSetOpacity}
      setBlendMode={handleRecordedSetBlendMode}
      toggleLock={layerMgr.toggleLock}
      toggleAlphaLock={layerMgr.toggleAlphaLock}
      toggleClipping={handleRecordedToggleClipping}
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
      setLayerExpressionColor={handleRecordedSetExpressionColor}
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
      onEditVectorLayer={shapeFillTools.openLayerForEditing}
      onRasterizeLayer={handleRasterizeLayer}
      onPlayAutoAction={handlePlayAutoAction}
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
        joinByInviteUrl={collab.joinByInviteUrl}
        leaveRoom={collab.leaveRoom}
        clipboardInvite={collab.clipboardInvite}
        setClipboardInvite={collab.setClipboardInvite}
        webLandingInvite={collab.webLandingInvite}
        setWebLandingInvite={collab.setWebLandingInvite}
        joinRoom={collab.joinRoom}
        onCaptureTimelapseNow={handleCaptureTimelapseNow}
        handleSave={docLifecycle.handleSave}
        showToast={showToast}
      />
    </AppShell>
  );
}

export default App;
