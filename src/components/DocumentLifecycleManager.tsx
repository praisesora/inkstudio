import React, { useRef, useEffect, useCallback } from 'react';
import {
  CanvasColorMode,
  CanvasDimensions,
  DocumentTab,
  LayerItem,
  LoadedDocument,
  NewCanvasOptions,
} from '../types/editor';
import { AppSettings, ResizeCanvasOptions } from '../types/settings';
import { openFile } from '../utils/imageLoader';
import {
  promptExportPngImage,
  promptSaveAs,
  SaveDocumentData,
  SaveProgress,
  saveToExistingHandle,
} from '../utils/saveManager';
import { globalTimelapseManager } from '../utils/timelapseEngine';
import { saveRecentDocument, RecentDocument } from '../utils/recentDocumentsManager';
import { enforceColorMode } from '../utils/colorUtils';
import { importBrushFile, isSupportedBrushFileName } from '../utils/inkbBrushFormat';
import { documentStore } from '../utils/documentStore';
import { shortcutManager } from '../utils/shortcutManager';
import { recoveryService, CrashedSessionInfo } from '../services/recoveryService';
import { multiplayerService } from '../services/multiplayerService';
import {
  documentStoreActions,
  toolStoreActions,
  uiStoreActions,
  useDocumentStore,
  useToolStore,
  useUiStore,
} from '../stores';
import { PushHistoryStepFn } from '../hooks/drawing';
import { isTauriEnvironment } from '../hooks/useMultiplayer';
import {
  SaveDocumentResult,
  isFinalizingAppClose,
  requestAppClose,
} from '../utils/appCloseFlow';

function computeEffectiveOpacityForLayers(allLayers: LayerItem[], layer: LayerItem): number {
  let opacity = layer.opacity;
  let parentId = layer.parentId;
  const visited = new Set<string>([layer.id]);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = allLayers.find((l) => l.id === parentId);
    if (!parent) break;
    opacity *= parent.opacity;
    parentId = parent.parentId;
  }
  return opacity;
}

function computeLayerVisibleForLayers(allLayers: LayerItem[], layer: LayerItem): boolean {
  if (!layer.visible) return false;
  let parentId = layer.parentId;
  const visited = new Set<string>([layer.id]);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = allLayers.find((l) => l.id === parentId);
    if (!parent) break;
    if (!parent.visible) return false;
    parentId = parent.parentId;
  }
  return true;
}

interface FileWithOptionalPath extends File {
  path?: string;
}

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

export interface UseDocumentLifecycleParams {
  layers: LayerItem[];
  activeLayer: LayerItem | undefined;
  activeLayerId: string;
  getEffectiveOpacity: (layer: LayerItem) => number;
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean;
  setActiveLayerId: (id: string) => void;
  resetToNewCanvas: (
    dims: CanvasDimensions,
    bgColor: string,
    mode: CanvasColorMode,
    defaultFreq: number,
    docId: string
  ) => { layers: LayerItem[]; activeLayerId: string };
  setDefaultToneFrequency: (freq: number) => void;
  clearDocument: () => void;
  loadDocument: (
    doc: Pick<LoadedDocument, 'name' | 'dimensions' | 'colorMode' | 'layers'>,
    sessionId?: string,
    alreadyInGrid?: boolean
  ) => void;
  switchDocumentSession: (
    docId: string,
    layers: LayerItem[],
    activeLayerId: string,
    dimensions: CanvasDimensions
  ) => void;
  resizeCanvas: (newDims: CanvasDimensions, options: ResizeCanvasOptions) => void;
  copyLayer: (id: string) => LayerItem | null;
  pasteLayer: () => Promise<{
    success: boolean;
    layerId?: string;
    layerName?: string;
    tileDeltas?: import('../types/editor').TileDelta[];
  }>;
  onDeselectAfterPaste?: () => void;
  deleteLayer: (id: string) => void;
  pasteLayerFromFile: (file: File) => Promise<string>;
  resetZoomAndCenter: (dims?: CanvasDimensions) => void;
  resetHistory: (targetDocumentId?: string) => void;
  pushHistoryStep: PushHistoryStepFn;
  showToast: (msg: string) => void;
}

export function useDocumentLifecycle({
  layers,
  activeLayer,
  activeLayerId,
  getEffectiveOpacity,
  isLayerEffectivelyVisible,
  setActiveLayerId,
  resetToNewCanvas,
  setDefaultToneFrequency,
  clearDocument,
  loadDocument,
  switchDocumentSession,
  resizeCanvas,
  copyLayer,
  pasteLayer,
  onDeselectAfterPaste,
  deleteLayer,
  pasteLayerFromFile,
  resetZoomAndCenter,
  resetHistory,
  pushHistoryStep,
  showToast,
}: UseDocumentLifecycleParams) {
  const activeDocumentId = useDocumentStore((s) => s.activeDocumentId);
  const dimensions = useDocumentStore((s) => s.dimensions);
  const colorMode = useDocumentStore((s) => s.colorMode);
  const documentName = useDocumentStore((s) => s.documentName);
  const savedFileInfo = useDocumentStore((s) => s.savedFileInfo);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pasteFileInputRef = useRef<HTMLInputElement>(null);
  const import3DFileInputRef = useRef<HTMLInputElement>(null);
  const needsAdaptiveFitRef = useRef<boolean>(true);
  const pendingFitDimsRef = useRef<CanvasDimensions | null>(null);
  const layersRef = useRef<LayerItem[]>(layers);
  layersRef.current = layers;

  const handleViewportReady = useCallback(
    (viewport: HTMLDivElement) => {
      if (needsAdaptiveFitRef.current) {
        if (viewport.clientWidth <= 0 || viewport.clientHeight <= 0) {
          return;
        }
        needsAdaptiveFitRef.current = false;
        const targetDims = pendingFitDimsRef.current || useDocumentStore.getState().dimensions;
        pendingFitDimsRef.current = null;
        resetZoomAndCenter(targetDims);
      }
    },
    [resetZoomAndCenter]
  );

  const handleCreateNewCanvas = useCallback(
    (options: NewCanvasOptions) => {
      const newDims: CanvasDimensions = {
        width: options.width,
        height: options.height,
        dpi: options.dpi,
      };
      documentStoreActions.setDimensions(newDims);
      documentStoreActions.setColorMode(options.colorMode);
      let name = (options.name || 'Untitled').trim();
      if (!/\.[a-zA-Z0-9]+$/.test(name) && !name.endsWith('*')) {
        name = `${name}*`;
      }
      documentStoreActions.setDocumentName(name);
      documentStoreActions.setSavedFileInfo(null);

      const primaryColor = useToolStore.getState().primaryColor;
      if (options.colorMode === 'monochrome') {
        const snapPrimary = enforceColorMode(primaryColor, 'monochrome');
        toolStoreActions.setPrimaryColor(snapPrimary, false, 'monochrome');
        toolStoreActions.updateBrushSettings({ color: snapPrimary, hardness: 1.0 });
      } else if (options.colorMode === 'grayscale') {
        const snapPrimary = enforceColorMode(primaryColor, 'grayscale');
        toolStoreActions.setPrimaryColor(snapPrimary, false, 'grayscale');
        toolStoreActions.updateBrushSettings({ color: snapPrimary });
      }

      const defaultFreq = options.defaultFrequency ?? 60;
      const newDocId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const { layers: initialLayers, activeLayerId: topId } = resetToNewCanvas(
        newDims,
        options.backgroundColor,
        options.colorMode,
        defaultFreq,
        newDocId
      );
      needsAdaptiveFitRef.current = true;
      pendingFitDimsRef.current = newDims;
      resetZoomAndCenter(newDims);
      resetHistory(newDocId);

      const newDoc: DocumentTab = {
        id: newDocId,
        name,
        dimensions: newDims,
        colorMode: options.colorMode,
        layers: initialLayers,
        activeLayerId: topId,
        perspectiveRuler: null,
        defaultFrequency: defaultFreq,
      };

      documentStoreActions.setPerspectiveRuler(null);
      documentStoreActions.setStraightRuler(null);
      documentStoreActions.setDocuments((prev) => [...prev, newDoc]);
      documentStoreActions.setActiveDocumentId(newDocId);
      uiStoreActions.setAppView('workspace');
      showToast(`Created ${name}`);
    },
    [resetHistory, resetToNewCanvas, resetZoomAndCenter, showToast]
  );

  const handleCopySelectedLayer = useCallback(() => {
    if (!activeLayer) return;
    const copied = copyLayer(activeLayerId);
    if (copied) {
      showToast(`Copied layer "${copied.name}"`);
    }
  }, [activeLayer, activeLayerId, copyLayer, showToast]);

  const handlePasteSelectedLayer = useCallback(async () => {
    const res = await pasteLayer();
    if (res.success && res.layerName) {
      if (res.layerId && res.tileDeltas && res.tileDeltas.length > 0) {
        pushHistoryStep(
          'selection-move',
          `Paste "${res.layerName}"`,
          null,
          null,
          res.layerId,
          undefined,
          res.tileDeltas
        );
      }
      onDeselectAfterPaste?.();
      showToast(`Pasted into "${res.layerName}"`);
    } else {
      showToast('Clipboard is empty');
    }
  }, [onDeselectAfterPaste, pasteLayer, pushHistoryStep, showToast]);

  const handleDeleteSelectedLayer = useCallback(() => {
    const rasterCount = layers.filter((l) => l.type === 'raster').length;
    if (rasterCount <= 1) {
      showToast('Cannot delete the only raster layer');
      return;
    }
    const layerName = activeLayer?.name || 'layer';
    deleteLayer(activeLayerId);
    showToast(`Deleted layer "${layerName}"`);
  }, [activeLayer, activeLayerId, deleteLayer, layers, showToast]);

  const handleTriggerPasteFromFile = useCallback(() => {
    pasteFileInputRef.current?.click();
  }, []);

  const handlePasteFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        try {
          const layerName = await pasteLayerFromFile(file);
          documentStoreActions.markDocumentDirty(useDocumentStore.getState().activeDocumentId, true);
          showToast(`Pasted "${layerName}" from file`);
        } catch (err: unknown) {
          console.error('Failed to paste from file:', err);
          const errMsg = err instanceof Error ? err.message : String(err);
          alert(`Failed to paste image from file: ${errMsg}`);
        } finally {
          if (pasteFileInputRef.current) {
            pasteFileInputRef.current.value = '';
          }
        }
      }
    },
    [pasteLayerFromFile, showToast]
  );

  const handleTriggerImport3DFile = useCallback(() => {
    import3DFileInputRef.current?.click();
  }, []);

  const handleImport3DFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        uiStoreActions.set3DLayerOpen(true, file);
        showToast(`Importing 3D model "${file.name}" into local ghost layer...`);
        if (import3DFileInputRef.current) {
          import3DFileInputRef.current.value = '';
        }
      }
    },
    [showToast]
  );

  const handleResizeCanvas = useCallback(
    (options: ResizeCanvasOptions) => {
      const curDims = useDocumentStore.getState().dimensions;
      const newDims: CanvasDimensions = {
        width: options.width,
        height: options.height,
        dpi: options.dpi || curDims.dpi,
      };

      resizeCanvas(newDims, options);
      documentStoreActions.setDimensions(newDims);
      documentStoreActions.markDocumentDirty(useDocumentStore.getState().activeDocumentId, true);
      pendingFitDimsRef.current = newDims;
      needsAdaptiveFitRef.current = true;
      resetZoomAndCenter(newDims);
      resetHistory();
      if (multiplayerService.isConnected()) {
        multiplayerService.sendCanvasResize(newDims, options);
      }
      showToast(`Canvas resized to ${newDims.width} × ${newDims.height} px`);
    },
    [resetHistory, resetZoomAndCenter, resizeCanvas, showToast]
  );

  const handleUpdateSettings = useCallback((newSettings: AppSettings) => {
    const prev = useUiStore.getState().appSettings;
    uiStoreActions.updateAppSettings(newSettings);
    shortcutManager.setOverrides(newSettings.shortcuts);
    if (prev.tileMemoryBudgetMb !== newSettings.tileMemoryBudgetMb) {
      documentStore.setTileBudgetMb(newSettings.tileMemoryBudgetMb || 1024);
    }
    if (
      prev.defaultStabilization !== newSettings.defaultStabilization ||
      prev.usePressureByDefault !== newSettings.usePressureByDefault ||
      prev.smoothingEnabled !== newSettings.smoothingEnabled
    ) {
      toolStoreActions.updateBrushSettings({
        stabilization: newSettings.defaultStabilization,
        usePressure: newSettings.usePressureByDefault,
        smoothing: newSettings.smoothingEnabled,
      });
    }
  }, []);

  const handleProcessFile = useCallback(
    async (file: File) => {
      if (isSupportedBrushFileName(file.name)) {
        try {
          uiStoreActions.setLoading(true, `Importing Brush: ${file.name}...`);
          const parsedBrush = await importBrushFile(file);
          showToast(`Imported brush "${parsedBrush.name}"`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Failed to import brush file.';
          showToast(msg);
        } finally {
          uiStoreActions.setLoading(false, '');
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
        }
        return;
      }

      try {
        uiStoreActions.setLoading(true, `Loading ${file.name}...`);

        const doc = await openFile(file);
        const newDocId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        documentStoreActions.setDimensions(doc.dimensions);
        documentStoreActions.setColorMode(doc.colorMode);
        documentStoreActions.setDocumentName(doc.name);
        documentStoreActions.setSavedFileInfo(null);

        loadDocument(doc, newDocId);
        needsAdaptiveFitRef.current = true;
        pendingFitDimsRef.current = doc.dimensions;
        resetZoomAndCenter(doc.dimensions);
        resetHistory(newDocId);

        const topEditableLayer = doc.layers.find((l) => l.type === 'raster');
        const newDoc: DocumentTab = {
          id: newDocId,
          name: doc.name,
          dimensions: doc.dimensions,
          colorMode: doc.colorMode,
          layers: doc.layers,
          activeLayerId: topEditableLayer?.id || doc.layers[0]?.id || 'layer-1',
          perspectiveRuler: doc.perspectiveRuler ?? null,
        };

        documentStoreActions.setPerspectiveRuler(doc.perspectiveRuler ?? null);
        documentStoreActions.setStraightRuler(null);
        if (doc.animationTimeline !== undefined) {
          documentStoreActions.setAnimationTimeline(doc.animationTimeline);
        }
        documentStoreActions.setDocuments((prev) => [...prev, newDoc]);
        documentStoreActions.setActiveDocumentId(newDocId);

        const fileWithPath = file as FileWithOptionalPath;
        saveRecentDocument({
          id: newDocId,
          title: file.name,
          path: fileWithPath.path || `C:\\Users\\Artist\\Documents\\InkStudio\\${file.name}`,
          size: file.size || 1048576,
          coverUrl: doc.previewDataUrl || doc.layers[0]?.thumbnailUrl,
          isStarred: false,
          fileType: file.name.slice(file.name.lastIndexOf('.')),
          isSaved: true,
        }).catch(console.warn);

        const openedExt = file.name.includes('.')
          ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
          : '';
        showToast(
          openedExt === '.sora'
            ? `Migrated legacy ${file.name} (read-only) — save as .ink`
            : `Opened ${file.name}`
        );
      } catch (err: unknown) {
        console.error('Failed to open file:', err);
        const errMsg = err instanceof Error ? err.message : String(err);
        alert(`Could not open "${file.name}":\n${errMsg || 'Unsupported or corrupted file.'}`);
      } finally {
        uiStoreActions.setLoading(false, '');
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [loadDocument, resetHistory, resetZoomAndCenter, showToast]
  );

  const handleSelectDocument = useCallback(
    (id: string) => {
      const storeState = useDocumentStore.getState();
      if (id === storeState.activeDocumentId) {
        uiStoreActions.setAppView('workspace');
        return;
      }
      const doc = storeState.documents.find((d) => d.id === id);
      if (!doc) return;
      uiStoreActions.setAppView('workspace');
      documentStoreActions.setDimensions(doc.dimensions);
      documentStoreActions.setColorMode(doc.colorMode);
      documentStoreActions.setDocumentName(doc.name);
      if (doc.defaultFrequency) {
        setDefaultToneFrequency(doc.defaultFrequency);
      }
      if (doc.savedFileInfo && doc.savedFileInfo.extension) {
        documentStoreActions.setSavedFileInfo({
          name: doc.savedFileInfo.name,
          handle: doc.savedFileInfo.handle,
          extension: doc.savedFileInfo.extension,
        });
      } else {
        documentStoreActions.setSavedFileInfo(null);
      }
      switchDocumentSession(id, doc.layers || [], doc.activeLayerId || '', doc.dimensions);
      documentStoreActions.setActiveDocumentId(id);
      documentStoreActions.setPerspectiveRuler(doc.perspectiveRuler ?? null);
      documentStoreActions.setStraightRuler(doc.straightRuler ?? null);
      needsAdaptiveFitRef.current = true;
      pendingFitDimsRef.current = doc.dimensions;
      resetZoomAndCenter(doc.dimensions);
    },
    [resetZoomAndCenter, setDefaultToneFrequency, switchDocumentSession]
  );

  const handleCloseDocument = useCallback(
    (id: string) => {
      documentStoreActions.setDocuments((prev) => {
        const next = prev.filter((d) => d.id !== id);
        if (id === activeDocumentId) {
          if (next.length > 0) {
            const nextActive = next[next.length - 1];
            documentStoreActions.setDimensions(nextActive.dimensions);
            documentStoreActions.setColorMode(nextActive.colorMode);
            documentStoreActions.setDocumentName(nextActive.name);
            documentStoreActions.setPerspectiveRuler(nextActive.perspectiveRuler ?? null);
            documentStoreActions.setStraightRuler(nextActive.straightRuler ?? null);
            if (nextActive.savedFileInfo && nextActive.savedFileInfo.extension) {
              documentStoreActions.setSavedFileInfo({
                name: nextActive.savedFileInfo.name,
                handle: nextActive.savedFileInfo.handle,
                extension: nextActive.savedFileInfo.extension,
              });
            } else {
              documentStoreActions.setSavedFileInfo(null);
            }
            if (nextActive.layers && nextActive.layers.length > 0) {
              switchDocumentSession(
                nextActive.id,
                nextActive.layers,
                nextActive.activeLayerId || '',
                nextActive.dimensions
              );
              documentStoreActions.setActiveDocumentId(nextActive.id);
              needsAdaptiveFitRef.current = true;
              pendingFitDimsRef.current = nextActive.dimensions;
              resetZoomAndCenter(nextActive.dimensions);
            } else {
              documentStoreActions.setActiveDocumentId(nextActive.id);
              clearDocument();
            }
          } else {
            documentStore.setActiveDocument(null);
            documentStoreActions.setActiveDocumentId(null);
            documentStoreActions.setDocumentName('');
            documentStoreActions.setSavedFileInfo(null);
            clearDocument();
            documentStoreActions.setPerspectiveRuler(null);
            documentStoreActions.setStraightRuler(null);
            uiStoreActions.setAppView('home');
          }
        }
        return next;
      });
      if (id) {
        documentStore.closeSession(id).catch(console.warn);
        recoveryService.closeSession(id).catch(console.warn);
      }
    },
    [activeDocumentId, clearDocument, resetZoomAndCenter, switchDocumentSession]
  );

  const handleRestoreCrashedSession = useCallback(
    async (session: CrashedSessionInfo) => {
      try {
        const replayData = await recoveryService.loadSessionData(session.session_id);
        const restoredSession = documentStore.getOrCreateSession(session.session_id);
        const { manifest, replayedStrokesCount, replayedMutationsCount } =
          recoveryService.replaySessionData(replayData, restoredSession.tileGrid);

        const restoredDims: CanvasDimensions = {
          width: manifest.width,
          height: manifest.height,
          dpi: manifest.dpi,
        };

        loadDocument(
          {
            name: manifest.documentName,
            dimensions: restoredDims,
            colorMode: manifest.colorMode,
            layers: manifest.layers,
          },
          session.session_id,
          true
        );
        if (manifest.activeLayerId) {
          setActiveLayerId(manifest.activeLayerId);
        }

        documentStoreActions.setDimensions(restoredDims);
        documentStoreActions.setColorMode(manifest.colorMode);
        documentStoreActions.setDocumentName(manifest.documentName);

        const restoredDoc: DocumentTab = {
          id: session.session_id,
          name: manifest.documentName,
          isDirty: true,
          dimensions: restoredDims,
          colorMode: manifest.colorMode,
          layers: manifest.layers,
          activeLayerId: manifest.activeLayerId || manifest.layers[0]?.id || '',
        };

        documentStoreActions.setDocuments((prev) => {
          const filtered = prev.filter((d) => d.id !== session.session_id);
          return [restoredDoc, ...filtered];
        });
        documentStoreActions.setActiveDocumentId(session.session_id);
        uiStoreActions.setAppView('workspace');

        needsAdaptiveFitRef.current = true;
        pendingFitDimsRef.current = restoredDims;
        resetZoomAndCenter(restoredDims);
        resetHistory(session.session_id);

        pushHistoryStep(
          'initial',
          'Session restored from crash',
          null,
          null,
          manifest.activeLayerId || manifest.layers[0]?.id || ''
        );

        restoredSession.tileGrid.notifyChange(true);

        uiStoreActions.setRecoveryModal(false);
        uiStoreActions.setCrashedSessions((prev) =>
          prev.filter((s) => s.session_id !== session.session_id)
        );
        showToast(
          `Restored "${manifest.documentName}" (${replayedStrokesCount} strokes, ${replayedMutationsCount} mutations recovered)`
        );
      } catch (err: unknown) {
        console.error('[Recovery] Restore error:', err);
        const msg = err instanceof Error ? err.message : String(err);
        alert('Failed to restore crashed session: ' + msg);
      }
    },
    [loadDocument, resetHistory, resetZoomAndCenter, showToast, pushHistoryStep, setActiveLayerId]
  );

  const handleDiscardCrashedSession = useCallback(
    async (session: CrashedSessionInfo) => {
      try {
        await recoveryService.discardCrashedSession(session.session_id);
        uiStoreActions.setCrashedSessions((prev) => {
          const next = prev.filter((s) => s.session_id !== session.session_id);
          if (next.length === 0) {
            uiStoreActions.setRecoveryModal(false);
          }
          return next;
        });
        showToast('Crashed session discarded');
      } catch (err: unknown) {
        console.warn('[Recovery] Discard error:', err);
      }
    },
    [showToast]
  );

  const handleRenameDocument = useCallback(
    (id: string, newName: string) => {
      documentStoreActions.setDocuments((prev) =>
        prev.map((d) => (d.id === id ? { ...d, name: newName } : d))
      );
      if (id === activeDocumentId) {
        documentStoreActions.setDocumentName(newName);
      }
    },
    [activeDocumentId]
  );

  const handleTriggerOpenFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleProcessFile(file);
      }
    },
    [handleProcessFile]
  );

  const buildSaveData = useCallback(
    (onProgress?: (p: SaveProgress) => void): SaveDocumentData => {
      const cleanNameForSave = documentName.replace(/\*+$/, '') || 'Untitled';
      const docStoreState = useDocumentStore.getState();
      const tlStats = globalTimelapseManager.getStats(activeDocumentId);
      return {
        name: cleanNameForSave,
        dimensions,
        colorMode,
        layers,
        tileGrid: documentStore.getActiveTileGrid(),
        getEffectiveOpacity,
        isLayerEffectivelyVisible,
        tabId: activeDocumentId || undefined,
        perspectiveRuler: docStoreState.perspectiveRuler,
        animationTimeline: docStoreState.animationTimeline,
        timelapse:
          tlStats.enabled || tlStats.frameCount > 0
            ? { enabled: tlStats.enabled, frameCount: tlStats.frameCount }
            : null,
        onProgress,
      };
    },
    [
      activeDocumentId,
      colorMode,
      dimensions,
      documentName,
      getEffectiveOpacity,
      isLayerEffectivelyVisible,
      layers,
    ]
  );

  const handleSaveDocumentById = useCallback(
    async (docId: string): Promise<SaveDocumentResult> => {
      const storeState = useDocumentStore.getState();
      const targetDoc = storeState.documents.find((d) => d.id === docId);
      if (!targetDoc) return 'error';

      const isActive = storeState.activeDocumentId === docId;
      const docLayers = isActive ? layersRef.current : targetDoc.layers;
      const docSavedInfo = isActive
        ? storeState.savedFileInfo ?? targetDoc.savedFileInfo ?? null
        : targetDoc.savedFileInfo ?? null;
      const docTileGrid =
        documentStore.getSession(docId)?.tileGrid ?? documentStore.getActiveTileGrid();
      const cleanNameForSave = targetDoc.name.replace(/\*+$/, '') || 'Untitled';
      const tlStats = globalTimelapseManager.getStats(docId);

      const onProgress = (p: SaveProgress) => {
        uiStoreActions.setLoading(true, `${p.message} (${p.percent}%)`);
      };

      const docData: SaveDocumentData = {
        name: cleanNameForSave,
        dimensions: targetDoc.dimensions,
        colorMode: targetDoc.colorMode,
        layers: docLayers,
        tileGrid: docTileGrid,
        getEffectiveOpacity: (layer) => computeEffectiveOpacityForLayers(docLayers, layer),
        isLayerEffectivelyVisible: (layer) => computeLayerVisibleForLayers(docLayers, layer),
        tabId: docId,
        perspectiveRuler: isActive
          ? storeState.perspectiveRuler
          : targetDoc.perspectiveRuler ?? null,
        animationTimeline:
          targetDoc.animation !== undefined
            ? targetDoc.animation
            : isActive
              ? storeState.animationTimeline
              : null,
        timelapse:
          tlStats.enabled || tlStats.frameCount > 0
            ? { enabled: tlStats.enabled, frameCount: tlStats.frameCount }
            : null,
        onProgress,
      };

      const preferredExt =
        docSavedInfo?.extension && docSavedInfo.extension.toLowerCase() !== '.sora'
          ? docSavedInfo.extension
          : '.ink';

      const applySavedMetadata = (
        info: { name: string; handle?: any; extension: string; size?: number; previewDataUrl?: string },
        updateHandle: boolean
      ) => {
        const latestActiveId = useDocumentStore.getState().activeDocumentId;
        if (latestActiveId === docId) {
          if (updateHandle) {
            documentStoreActions.setSavedFileInfo(info);
          }
          documentStoreActions.setDocumentName(info.name);
        }
        documentStoreActions.setDocuments((prev) =>
          prev.map((d) =>
            d.id === docId
              ? {
                  ...d,
                  name: info.name,
                  ...(updateHandle ? { savedFileInfo: info } : {}),
                  isDirty: false,
                }
              : d
          )
        );
        saveRecentDocument({
          id: docId,
          title: info.name,
          path: `InkStudio\\${info.name}`,
          size: info.size || 1572864,
          coverUrl: info.previewDataUrl || docLayers[0]?.thumbnailUrl,
          isStarred: false,
          fileType: info.extension,
          isSaved: true,
        }).catch(console.warn);
        showToast(`Saved to ${info.name}`);
      };

      if (!docSavedInfo?.handle || docSavedInfo.extension?.toLowerCase() === '.sora') {
        try {
          const info = await promptSaveAs(docData, preferredExt);
          applySavedMetadata(info, true);
          return 'saved';
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === 'Save canceled') {
            return 'canceled';
          }
          alert('Failed to save file: ' + msg);
          return 'error';
        } finally {
          uiStoreActions.setLoading(false, '');
        }
      }

      try {
        const saveRes = await saveToExistingHandle(docData, docSavedInfo);
        applySavedMetadata(
          {
            name: docSavedInfo.name,
            handle: docSavedInfo.handle,
            extension: docSavedInfo.extension,
            size: saveRes.size,
            previewDataUrl: saveRes.previewDataUrl,
          },
          false
        );
        return 'saved';
      } catch (err: unknown) {
        console.warn('Direct handle save failed, prompting with Save As:', err);
        try {
          const info = await promptSaveAs(docData, preferredExt);
          applySavedMetadata(info, true);
          return 'saved';
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === 'Save canceled') {
            return 'canceled';
          }
          alert('Failed to save file: ' + msg);
          return 'error';
        }
      } finally {
        uiStoreActions.setLoading(false, '');
      }
    },
    [showToast]
  );

  const handleSave = useCallback(async () => {
    const currentId = useDocumentStore.getState().activeDocumentId;
    if (!currentId) return;
    await handleSaveDocumentById(currentId);
  }, [handleSaveDocumentById]);

  const handleSaveAs = useCallback(async () => {
    const onProgress = (p: SaveProgress) => {
      uiStoreActions.setLoading(true, `${p.message} (${p.percent}%)`);
    };
    const docData = buildSaveData(onProgress);

    try {
      const defaultExt =
        savedFileInfo?.extension && savedFileInfo.extension.toLowerCase() !== '.sora'
          ? savedFileInfo.extension
          : '.ink';
      const info = await promptSaveAs(docData, defaultExt);
      documentStoreActions.setSavedFileInfo(info);
      documentStoreActions.setDocumentName(info.name);
      documentStoreActions.setDocuments((prev) =>
        prev.map((d) =>
          d.id === activeDocumentId ? { ...d, name: info.name, savedFileInfo: info, isDirty: false } : d
        )
      );
      saveRecentDocument({
        id: activeDocumentId || `doc-${Date.now()}`,
        title: info.name,
        path: `InkStudio\\${info.name}`,
        size: info.size || 1572864,
        coverUrl: info.previewDataUrl || layers[0]?.thumbnailUrl,
        isStarred: false,
        fileType: info.extension,
        isSaved: true,
      }).catch(console.warn);
      showToast(`Saved as ${info.name}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'Save canceled') {
        alert('Failed to save file: ' + msg);
      }
    } finally {
      uiStoreActions.setLoading(false, '');
    }
  }, [activeDocumentId, buildSaveData, layers, savedFileInfo, showToast]);

  const handleExportImage = useCallback(async () => {
    const cleanNameForSave = documentName.replace(/\*+$/, '') || 'Untitled';
    const onProgress = (p: SaveProgress) => {
      uiStoreActions.setLoading(true, `${p.message} (${p.percent}%)`);
    };
    const docData = buildSaveData(onProgress);

    try {
      const exportedName = await promptExportPngImage(docData, cleanNameForSave);
      showToast(`Exported image to ${exportedName}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'Export canceled') {
        alert('Failed to export image: ' + msg);
      }
    } finally {
      uiStoreActions.setLoading(false, '');
    }
  }, [buildSaveData, documentName, showToast]);

  const handleSelectWelcomeDocument = useCallback(
    async (doc: RecentDocument) => {
      if (typeof window !== 'undefined' && (window as TauriWindow).__TAURI_INTERNALS__) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const bytes = await invoke<number[]>('read_file_from_disk', { path: doc.path });
          if (bytes && bytes.length > 0) {
            const uint8 = new Uint8Array(bytes);
            const file = new File([uint8], doc.title, { type: 'application/octet-stream' });
            await handleProcessFile(file);
            uiStoreActions.setAppView('workspace');
            return;
          }
        } catch (err) {
          console.warn('Direct disk read via Tauri failed, fallback:', err);
        }
      }

      handleCreateNewCanvas({
        width: 1920,
        height: 1080,
        dpi: 300,
        colorMode: 'color',
        name: doc.title,
        backgroundColor: '#ffffff',
        aspectRatioPreset: '16:9',
        aspectRatioX: 16,
        aspectRatioY: 9,
        lockAspectRatio: true,
      });
      showToast(`Loaded workspace for "${doc.title}"`);
    },
    [handleCreateNewCanvas, handleProcessFile, showToast]
  );

  return {
    fileInputRef,
    pasteFileInputRef,
    import3DFileInputRef,
    needsAdaptiveFitRef,
    pendingFitDimsRef,
    handleViewportReady,
    handleCreateNewCanvas,
    handleCopySelectedLayer,
    handlePasteSelectedLayer,
    handleDeleteSelectedLayer,
    handleTriggerPasteFromFile,
    handlePasteFileInputChange,
    handleTriggerImport3DFile,
    handleImport3DFileInputChange,
    handleResizeCanvas,
    handleUpdateSettings,
    handleProcessFile,
    handleSelectDocument,
    handleCloseDocument,
    handleRestoreCrashedSession,
    handleDiscardCrashedSession,
    handleRenameDocument,
    handleTriggerOpenFile,
    handleFileInputChange,
    handleSave,
    handleSaveDocumentById,
    handleSaveAs,
    handleExportImage,
    handleSelectWelcomeDocument,
  };
}

export interface DocumentLifecycleManagerProps {
  layers: LayerItem[];
  activeLayerId: string;
  needsAdaptiveFitRef: React.MutableRefObject<boolean>;
  pendingFitDimsRef: React.MutableRefObject<CanvasDimensions | null>;
  resetToNewCanvas: (
    dims: CanvasDimensions,
    bgColor: string,
    mode: CanvasColorMode,
    defaultFreq: number,
    docId: string
  ) => { layers: LayerItem[]; activeLayerId: string };
  resetZoomAndCenter: (dims?: CanvasDimensions) => void;
  resetHistory: (targetDocumentId?: string) => void;
  onSelectDocument: (id: string) => void;
}

/**
 * Headless lifecycle coordinator: handles startup crash recovery detection,
 * initial canvas creation, WAL checkpointing, tile memory budget sync,
 * active document tab metadata synchronization, and app close confirmation guard.
 */
export const DocumentLifecycleManager: React.FC<DocumentLifecycleManagerProps> = React.memo(
  ({
    layers,
    activeLayerId,
    needsAdaptiveFitRef,
    pendingFitDimsRef,
    resetToNewCanvas,
    resetZoomAndCenter,
    resetHistory,
    onSelectDocument,
  }) => {
    const documents = useDocumentStore((s) => s.documents);
    const activeDocumentId = useDocumentStore((s) => s.activeDocumentId);
    const dimensions = useDocumentStore((s) => s.dimensions);
    const colorMode = useDocumentStore((s) => s.colorMode);
    const documentName = useDocumentStore((s) => s.documentName);
    const appSettings = useUiStore((s) => s.appSettings);
    const appClosePrompt = useUiStore((s) => s.appClosePrompt);

    // 1. Scan for unfinalized crashed WAL sessions on launch
    useEffect(() => {
      recoveryService
        .checkForCrashedSessions()
        .then((sessions) => {
          if (sessions && sessions.length > 0) {
            uiStoreActions.setRecoveryModal(true, sessions);
          }
        })
        .catch((err) => {
          console.warn('[Recovery] Error scanning for crashed sessions:', err);
        });
    }, []);

    // 2. Synchronize tile memory budget across all open documents
    useEffect(() => {
      documentStore.setTileBudgetMb(appSettings.tileMemoryBudgetMb || 1024);
    }, [appSettings.tileMemoryBudgetMb]);

    // 3. Auto-create initial white canvas on launch
    const hasAutoCreatedInitialDocRef = useRef(false);
    useEffect(() => {
      if (hasAutoCreatedInitialDocRef.current || documents.length > 0) return;
      hasAutoCreatedInitialDocRef.current = true;
      const initDims: CanvasDimensions = {
        width: appSettings.defaultWidth || 1920,
        height: appSettings.defaultHeight || 1080,
        dpi: appSettings.defaultDpi || 300,
      };
      const initColorMode = appSettings.defaultColorMode || 'color';
      const initBg = appSettings.defaultBgColor || '#ffffff';
      const initName = 'Untitled*';
      const newDocId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      documentStoreActions.setDimensions(initDims);
      documentStoreActions.setColorMode(initColorMode);
      documentStoreActions.setDocumentName(initName);
      const { layers: initialLayers, activeLayerId: topId } = resetToNewCanvas(
        initDims,
        initBg,
        initColorMode,
        60,
        newDocId
      );
      needsAdaptiveFitRef.current = true;
      pendingFitDimsRef.current = initDims;
      resetZoomAndCenter(initDims);
      resetHistory(newDocId);
      documentStoreActions.setDocuments([
        {
          id: newDocId,
          name: initName,
          dimensions: initDims,
          colorMode: initColorMode,
          layers: initialLayers,
          activeLayerId: topId,
          perspectiveRuler: null,
          defaultFrequency: 60,
        },
      ]);
      documentStoreActions.setActiveDocumentId(newDocId);
      uiStoreActions.setAppView('workspace');
    }, [
      appSettings.defaultBgColor,
      appSettings.defaultColorMode,
      appSettings.defaultDpi,
      appSettings.defaultHeight,
      appSettings.defaultWidth,
      documents.length,
      needsAdaptiveFitRef,
      pendingFitDimsRef,
      resetHistory,
      resetToNewCanvas,
      resetZoomAndCenter,
    ]);

    // 4. Sync active document recovery session & WAL periodic checkpointing
    const recoveryStateRef = useRef({
      documents,
      documentName,
      dimensions,
      colorMode,
      layers,
      activeLayerId,
    });
    recoveryStateRef.current = {
      documents,
      documentName,
      dimensions,
      colorMode,
      layers,
      activeLayerId,
    };

    useEffect(() => {
      if (!activeDocumentId) return;
      const st = recoveryStateRef.current;
      const initDoc = st.documents.find((d) => d.id === activeDocumentId);
      if (!initDoc) return;

      recoveryService.initSession(
        activeDocumentId,
        () => {
          const cur = recoveryStateRef.current;
          const doc = cur.documents.find((d) => d.id === activeDocumentId);
          return {
            sessionId: activeDocumentId,
            documentName: doc?.name || cur.documentName || 'Untitled Document',
            width: doc?.dimensions.width || cur.dimensions.width,
            height: doc?.dimensions.height || cur.dimensions.height,
            dpi: doc?.dimensions.dpi || cur.dimensions.dpi || 600,
            colorMode: doc?.colorMode || cur.colorMode || 'color',
            layers: doc?.layers || cur.layers,
            activeLayerId: doc?.activeLayerId || cur.activeLayerId,
            timestamp: Date.now(),
          };
        },
        async () => {
          const cur = recoveryStateRef.current;
          const doc = cur.documents.find((d) => d.id === activeDocumentId);
          const targetLayerId = doc?.activeLayerId || cur.activeLayerId;
          const dims = doc?.dimensions || cur.dimensions;
          if (!targetLayerId || dims.width <= 0 || dims.height <= 0) return null;
          try {
            const thumbW = 120;
            const thumbH = Math.max(
              68,
              Math.round((dims.height / Math.max(1, dims.width)) * thumbW)
            );
            const dataUrl = documentStore
              .getActiveTileGrid()
              .generateThumbnail(targetLayerId, thumbW, thumbH, dims);
            const commaIdx = dataUrl.indexOf(',');
            if (commaIdx < 0) return null;
            const b64 = dataUrl.slice(commaIdx + 1);
            const binStr = atob(b64);
            const bytes = new Uint8Array(binStr.length);
            for (let i = 0; i < binStr.length; i++) {
              bytes[i] = binStr.charCodeAt(i);
            }
            return bytes;
          } catch {
            return null;
          }
        }
      );
    }, [activeDocumentId]);

    // 5. Keep active document tab's metadata in sync
    useEffect(() => {
      if (!activeDocumentId) return;
      documentStoreActions.setActiveLayerId(activeLayerId);
      documentStoreActions.setDocuments((prev) => {
        const curr = prev.find((d) => d.id === activeDocumentId);
        if (!curr) return prev;
        if (curr.layers === layers && curr.activeLayerId === activeLayerId) {
          return prev;
        }
        return prev.map((d) =>
          d.id === activeDocumentId
            ? {
                ...d,
                layers,
                activeLayerId,
              }
            : d
        );
      });
    }, [layers, activeLayerId, activeDocumentId]);

    // 6. Intercept OS/window close requests (Alt+F4, taskbar close, WM close) and show quit confirmation
    useEffect(() => {
      if (isTauriEnvironment()) {
        let disposed = false;
        let unlisten: (() => void) | undefined;

        void import('@tauri-apps/api/window')
          .then(({ getCurrentWindow }) =>
            getCurrentWindow().onCloseRequested((event) => {
              if (isFinalizingAppClose()) return;
              event.preventDefault();
              requestAppClose();
            })
          )
          .then((fn) => {
            if (disposed) {
              fn();
            } else {
              unlisten = fn;
            }
          })
          .catch((err) => {
            console.warn('Failed to register Tauri close-requested guard:', err);
          });

        return () => {
          disposed = true;
          if (unlisten) unlisten();
        };
      }

      // Browser fallback: warn via native beforeunload dialog when closing tab with unsaved work
      const handleBeforeUnload = (e: BeforeUnloadEvent) => {
        if (isFinalizingAppClose()) return;
        const hasDirty = useDocumentStore.getState().documents.some((d) => Boolean(d.isDirty));
        if (hasDirty) {
          e.preventDefault();
          e.returnValue = '';
        }
      };
      window.addEventListener('beforeunload', handleBeforeUnload);
      return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, []);

    // 7. Focus the canvas currently being confirmed during the per-canvas save prompt
    const pendingCloseDocId =
      appClosePrompt.isOpen && appClosePrompt.step === 'per-canvas'
        ? appClosePrompt.pendingDocIds[appClosePrompt.currentIndex] ?? null
        : null;
    useEffect(() => {
      if (!pendingCloseDocId) return;
      onSelectDocument(pendingCloseDocId);
    }, [pendingCloseDocId, onSelectDocument]);

    return null;
  }
);

DocumentLifecycleManager.displayName = 'DocumentLifecycleManager';
