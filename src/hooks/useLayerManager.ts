import { useState, useRef, useCallback, useEffect } from 'react';
import { CanvasDimensions, LayerItem } from '../types/editor';
import { SparseTileGrid, globalTileGrid } from '../utils/tileEngine';
import { documentStore } from '../utils/documentStore';
import { recoveryService } from '../services/recoveryService';
import { computeLayerSelection } from './layerManager/layerTreeOps';
import { LayerManagerContext, UseLayerManagerProps } from './layerManager/types';
import { useLayerCanvasRegistry } from './layerManager/useLayerCanvasRegistry';
import { useLayerCrud } from './layerManager/useLayerCrud';
import { useLayerCollabSync } from './layerManager/useLayerCollabSync';
import { useLayerPropertiesAndMasks } from './layerManager/useLayerPropertiesAndMasks';
import { useLayerEffects } from './layerManager/useLayerEffects';
import { useLayerDocumentOps } from './layerManager/useLayerDocumentOps';
import { useLayerResize } from './layerManager/useLayerResize';
import { useLayerClipboard } from './layerManager/useLayerClipboard';
import { useLayerSpecialLayers } from './layerManager/useLayerSpecialLayers';

export {
  isBackgroundLayerId,
  getNextCollabLayerName,
  computeLayerSelection,
  computeBatchDeleteLayers,
  computeGroupLayers,
  computeBatchReorderLayers,
  computeBatchVisibility,
  computeBatchLock,
} from './layerManager/layerTreeOps';

export function useLayerManager({ dimensions: _dimensions, activeSessionId, tileGrid }: UseLayerManagerProps) {
  // Active document's SparseTileGrid (isolated per document tab)
  const activeTileGridRef = useRef<SparseTileGrid>(
    tileGrid ?? (activeSessionId ? documentStore.getOrCreateSession(activeSessionId).tileGrid : globalTileGrid)
  );
  if (tileGrid) {
    activeTileGridRef.current = tileGrid;
  } else if (activeSessionId) {
    activeTileGridRef.current = documentStore.getOrCreateSession(activeSessionId).tileGrid;
  }

  const dimensionsRef = useRef<CanvasDimensions>(_dimensions);
  dimensionsRef.current = _dimensions;

  const activeSessionIdRef = useRef<string | null>(activeSessionId ?? null);
  if (activeSessionId !== undefined && activeSessionId !== activeSessionIdRef.current) {
    activeSessionIdRef.current = activeSessionId;
    if (activeSessionId) {
      const sess = documentStore.getOrCreateSession(activeSessionId);
      activeTileGridRef.current = tileGrid ?? sess.tileGrid;
    } else {
      activeTileGridRef.current = tileGrid ?? globalTileGrid;
    }
  }

  // Default canvas tone frequency (20 to 85 LPI, default: 60)
  const defaultToneFrequencyRef = useRef<number>(60);

  // Debounce timers for thumbnail refreshes
  const thumbDebounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Default initial layers: starts empty until a document is created or opened
  const [layers, setLayers] = useState<LayerItem[]>([]);
  const [activeLayerId, setActiveLayerIdState] = useState<string>('');
  const [selectedLayerIds, setSelectedLayerIdsState] = useState<string[]>([]);
  const activeLayerIdRef = useRef<string>(activeLayerId);
  activeLayerIdRef.current = activeLayerId;
  const selectedLayerIdsRef = useRef<string[]>(selectedLayerIds);
  selectedLayerIdsRef.current = selectedLayerIds;
  const selectionPivotIdRef = useRef<string>('');
  const layersRef = useRef(layers);
  layersRef.current = layers;

  // Track structural layer mutations and log to recovery service WAL (ignore pure thumbnailUrl refreshes)
  const isInitialLayerMount = useRef(true);
  const lastLoggedLayersSigRef = useRef<string>('');
  useEffect(() => {
    if (isInitialLayerMount.current) {
      isInitialLayerMount.current = false;
      return;
    }
    const sId = activeSessionId || recoveryService.getCurrentSessionId();
    if (sId && layers.length > 0) {
      const sig = `${activeLayerId}|` + layers
        .map((l) => `${l.id}:${l.name}:${l.visible ? 1 : 0}:${l.opacity}:${l.blendMode}:${l.locked ? 1 : 0}:${l.clipped ? 1 : 0}:${l.alphaLocked ? 1 : 0}:${l.parentId || ''}:${l.expressionColor || ''}:${l.toneEnabled ? 1 : 0}`)
        .join(';');
      if (sig === lastLoggedLayersSigRef.current) return;
      lastLoggedLayersSigRef.current = sig;
      recoveryService.logLayerMutation(sId, 'update', layers, activeLayerId);
    }
  }, [layers, activeSessionId, activeLayerId]);

  const setSelectedLayerIds = useCallback((ids: string[] | ((prev: string[]) => string[])) => {
    setSelectedLayerIdsState((prev) => {
      const next = typeof ids === 'function' ? ids(prev) : ids;
      selectedLayerIdsRef.current = next;
      return next;
    });
  }, []);

  const setActiveLayerId = useCallback((id: string) => {
    setActiveLayerIdState(id);
    activeLayerIdRef.current = id;
    selectionPivotIdRef.current = id;
    if (id) {
      setSelectedLayerIds([id]);
    } else {
      setSelectedLayerIds([]);
    }
  }, [setSelectedLayerIds]);

  // Toggle or range-select layers via Shift and Ctrl/Cmd modifiers
  const toggleLayerSelection = useCallback((id: string, isShift: boolean, isCtrl: boolean) => {
    const res = computeLayerSelection(
      layersRef.current,
      selectedLayerIdsRef.current,
      activeLayerIdRef.current,
      selectionPivotIdRef.current,
      id,
      isShift,
      isCtrl
    );
    selectionPivotIdRef.current = res.nextPivotId;
    setActiveLayerIdState(res.nextActiveId);
    activeLayerIdRef.current = res.nextActiveId;
    setSelectedLayerIds(res.nextSelectedIds);
  }, [setSelectedLayerIds]);

  const ctx: LayerManagerContext = {
    dimensions: _dimensions,
    activeTileGridRef,
    dimensionsRef,
    activeSessionIdRef,
    defaultToneFrequencyRef,
    thumbDebounceTimersRef,
    layers,
    setLayers,
    layersRef,
    activeLayerId,
    setActiveLayerId,
    activeLayerIdRef,
    selectedLayerIds,
    setSelectedLayerIds,
    selectedLayerIdsRef,
  };

  const canvasRegistry = useLayerCanvasRegistry(ctx);
  const crud = useLayerCrud(ctx);
  const collabSync = useLayerCollabSync(ctx, canvasRegistry.updateLayerThumbnail);
  const propertiesAndMasks = useLayerPropertiesAndMasks(ctx, canvasRegistry);
  const effects = useLayerEffects(ctx, canvasRegistry);
  const documentOps = useLayerDocumentOps(ctx, canvasRegistry);
  const resize = useLayerResize(ctx);
  const clipboard = useLayerClipboard(ctx);
  const specialLayers = useLayerSpecialLayers(ctx, crud.addLayer, canvasRegistry.updateLayerThumbnail);

  // Get active layer object
  const activeLayer = layers.find((l) => l.id === activeLayerId) || layers[0];

  return {
    layers,
    setLayers,
    activeLayerId,
    setActiveLayerId,
    selectedLayerIds,
    setSelectedLayerIds,
    toggleLayerSelection,
    deleteSelectedLayers: crud.deleteSelectedLayers,
    groupSelectedLayers: crud.groupSelectedLayers,
    moveSelectedLayers: crud.moveSelectedLayers,
    activeLayer,
    toggleTone: effects.toggleTone,
    setToneFrequency: effects.setToneFrequency,
    setToneAngle: effects.setToneAngle,
    setToneDotShape: effects.setToneDotShape,
    setToneDensity: effects.setToneDensity,
    setToneDensityType: effects.setToneDensityType,
    toggleLayerColor: effects.toggleLayerColor,
    setLayerColor: effects.setLayerColor,
    setLayerSubColor: effects.setLayerSubColor,
    setLayerExpressionColor: effects.setLayerExpressionColor,
    setLayerMonoThreshold: effects.setLayerMonoThreshold,
    setLayerMonoExpressMode: effects.setLayerMonoExpressMode,
    applyExpressionColorOfPreview: effects.applyExpressionColorOfPreview,
    applyLayerColorPermanently: effects.applyLayerColorPermanently,
    convertLayer: effects.convertLayer,
    updateLayerThumbnail: canvasRegistry.updateLayerThumbnail,
    addLayer: crud.addLayer,
    addRemoteLayer: collabSync.addRemoteLayer,
    deleteRemoteLayer: collabSync.deleteRemoteLayer,
    applyRemoteLayerUpdate: collabSync.applyRemoteLayerUpdate,
    applyRemoteLayerTree: collabSync.applyRemoteLayerTree,
    applyRemoteMaskData: collabSync.applyRemoteMaskData,
    syncRemoteDocument: collabSync.syncRemoteDocument,
    duplicateLayer: crud.duplicateLayer,
    deleteLayer: crud.deleteLayer,
    copyLayer: clipboard.copyLayer,
    pasteLayer: clipboard.pasteLayer,
    pasteLayerFromCanvas: clipboard.pasteLayerFromCanvas,
    fillScreentoneSelection: clipboard.fillScreentoneSelection,
    importImageFileAsLayer: clipboard.importImageFileAsLayer,
    pasteLayerFromFile: clipboard.pasteLayerFromFile,
    resizeCanvas: resize.resizeCanvas,
    toggleVisibility: propertiesAndMasks.toggleVisibility,
    setOpacity: propertiesAndMasks.setOpacity,
    setBlendMode: propertiesAndMasks.setBlendMode,
    toggleLock: propertiesAndMasks.toggleLock,
    toggleAlphaLock: propertiesAndMasks.toggleAlphaLock,
    toggleClipping: propertiesAndMasks.toggleClipping,
    toggleCollapse: propertiesAndMasks.toggleCollapse,
    renameLayer: crud.renameLayer,
    moveLayer: crud.moveLayer,
    moveLayerToFolder: crud.moveLayerToFolder,
    reorderLayers: crud.reorderLayers,
    getEffectiveOpacity: crud.getEffectiveOpacity,
    isLayerEffectivelyVisible: crud.isLayerEffectivelyVisible,
    clearActiveLayer: documentOps.clearActiveLayer,
    mergeDown: documentOps.mergeDown,
    resetToNewCanvas: documentOps.resetToNewCanvas,
    setDefaultToneFrequency: (freq: number) => {
      defaultToneFrequencyRef.current = Math.max(20, Math.min(85, Math.round(freq || 60)));
    },
    clearDocument: documentOps.clearDocument,
    loadDocument: documentOps.loadDocument,
    switchDocumentSession: documentOps.switchDocumentSession,
    addLayerMask: propertiesAndMasks.addLayerMask,
    removeLayerMask: propertiesAndMasks.removeLayerMask,
    toggleLayerMask: propertiesAndMasks.toggleLayerMask,
    toggleMaskLinked: propertiesAndMasks.toggleMaskLinked,
    updateMaskThumbnail: propertiesAndMasks.updateMaskThumbnail,
    addAdjustmentLayer: propertiesAndMasks.addAdjustmentLayer,
    updateAdjustmentData: propertiesAndMasks.updateAdjustmentData,
    updateLayerStyles: propertiesAndMasks.updateLayerStyles,
    upsertTextLayer: specialLayers.upsertTextLayer,
    upsertBalloonLayer: specialLayers.upsertBalloonLayer,
    createFrameFolder: specialLayers.createFrameFolder,
    divideFrameFolder: specialLayers.divideFrameFolder,
    rasterizeLayer: specialLayers.rasterizeLayer,
  };
}
