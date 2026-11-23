import { useCallback } from 'react';
import {
  AdjustmentLayerData,
  BlendMode,
  LayerItem,
  LayerStyles,
  TileDelta,
  isFolderLikeLayer,
} from '../../types/editor';
import { createCanvasThumbnail, get2DContext } from '../../utils/canvasUtils';
import { multiplayerService } from '../../services/multiplayerService';
import {
  computeBatchLock,
  computeBatchVisibility,
  createLayerTreeSnapshotDelta,
  isBackgroundLayerId,
} from './layerTreeOps';
import { LayerCanvasRegistryApi, LayerManagerContext } from './types';

export function useLayerPropertiesAndMasks(
  ctx: LayerManagerContext,
  canvasRegistry: Pick<LayerCanvasRegistryApi, 'updateLayerThumbnail'>
) {
  const {
    dimensions,
    activeTileGridRef,
    setLayers,
    layersRef,
    activeLayerIdRef,
    setActiveLayerId,
    selectedLayerIdsRef,
    recordLayerHistory,
  } = ctx;
  const { updateLayerThumbnail } = canvasRegistry;

  // Toggle visibility of a layer or folder (batch toggle if part of multi-selection)
  const toggleVisibility = useCallback((id: string) => {
    const prev = layersRef.current;
    const next = computeBatchVisibility(prev, selectedLayerIdsRef.current, id);
    if (next === prev) return;
    layersRef.current = next;
    setLayers(next);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Toggle Visibility',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, selectedLayerIdsRef, setLayers]);

  // Set layer opacity (0.0 to 1.0)
  const setOpacity = useCallback((id: string, opacity: number) => {
    const clamped = Math.max(0, Math.min(1, opacity));
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || Math.abs(target.opacity - clamped) < 0.0001) return;
    const next = prev.map((l) => (l.id === id ? { ...l, opacity: clamped } : l));
    layersRef.current = next;
    setLayers(next);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Layer Opacity',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current, {
        coalesceKey: `opacity:${id}`,
      }),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Set layer blend mode
  const setBlendMode = useCallback((id: string, blendMode: BlendMode) => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || target.blendMode === blendMode) return;
    const next = prev.map((l) => (l.id === id ? { ...l, blendMode } : l));
    layersRef.current = next;
    setLayers(next);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      `Blend Mode (${blendMode})`,
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Toggle locked state (batch toggle if part of multi-selection)
  const toggleLock = useCallback((id: string) => {
    const prev = layersRef.current;
    const next = computeBatchLock(prev, selectedLayerIdsRef.current, id);
    if (next === prev) return;
    layersRef.current = next;
    setLayers(next);
    recordLayerHistory(
      'Toggle Layer Lock',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, layersRef, recordLayerHistory, selectedLayerIdsRef, setLayers]);

  // Toggle folder collapse state
  const toggleCollapse = useCallback((id: string) => {
    setLayers((prev) => {
      const next = prev.map((l) => (l.id === id ? { ...l, collapsed: !l.collapsed } : l));
      layersRef.current = next;
      return next;
    });
  }, [layersRef, setLayers]);

  // Toggle clipping mask state (Clip to Layer Below)
  const toggleClipping = useCallback((id: string) => {
    const prev = layersRef.current;
    const idx = prev.findIndex((l) => l.id === id);
    if (idx === -1 || idx === prev.length - 1 || isBackgroundLayerId(id)) {
      return;
    }
    const next = prev.map((l) => (l.id === id ? { ...l, clipped: !l.clipped } : l));
    layersRef.current = next;
    setLayers(next);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Toggle Clipping Mask',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Toggle alpha locked state (Lock Transparent Pixels)
  const toggleAlphaLock = useCallback((id: string) => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target) return;
    const next = prev.map((l) => (l.id === id ? { ...l, alphaLocked: !l.alphaLocked } : l));
    layersRef.current = next;
    setLayers(next);
    recordLayerHistory(
      'Toggle Alpha Lock',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, layersRef, recordLayerHistory, setLayers]);

  // Add a non-destructive grayscale Layer Mask
  const addLayerMask = useCallback((layerId: string) => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === layerId);
    if (!target || target.maskCanvas) return;

    const mask = document.createElement('canvas');
    mask.width = dimensions.width;
    mask.height = dimensions.height;
    const mCtx = get2DContext(mask);
    if (mCtx) {
      mCtx.fillStyle = '#ffffff';
      mCtx.fillRect(0, 0, mask.width, mask.height);
    }
    const thumb = createCanvasThumbnail(mask, false);
    const next = prev.map((l) =>
      l.id === layerId
        ? {
            ...l,
            maskCanvas: mask,
            maskEnabled: true,
            maskLinked: true,
            maskThumbnailUrl: thumb,
            maskVersion: 1,
          }
        : l
    );
    layersRef.current = next;
    setLayers(next);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Add Layer Mask',
      layerId,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current, {
        cloneMasks: true,
      }),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, dimensions, layersRef, recordLayerHistory, setLayers]);

  // Remove or apply layer mask (directly onto SparseTileGrid tiles, zero full-doc layer canvas)
  const removeLayerMask = useCallback(
    (layerId: string, apply: boolean = false) => {
      const prev = layersRef.current;
      const target = prev.find((l) => l.id === layerId);
      if (!target || !target.maskCanvas) return;

      const grid = activeTileGridRef.current;
      let tileDeltas: TileDelta[] = [];

      if (apply) {
        const beforeSnap = grid.snapshotLayerTiles(layerId);
        grid.applyMaskCanvasToLayer(layerId, target.maskCanvas, dimensions);
        tileDeltas = grid.computeDeltasFromSnapshot(beforeSnap, layerId);
        if (tileDeltas.length > 0 && multiplayerService.isConnected()) {
          multiplayerService.sendTileDeltas(tileDeltas, grid, { force: true });
        }
        updateLayerThumbnail(layerId, true);
      }

      const next = prev.map((l) =>
        l.id === layerId
          ? {
              ...l,
              maskCanvas: undefined,
              maskEnabled: undefined,
              maskLinked: undefined,
              maskThumbnailUrl: undefined,
              maskVersion: undefined,
            }
          : l
      );
      const delta = createLayerTreeSnapshotDelta(
        prev,
        next,
        activeLayerIdRef.current,
        activeLayerIdRef.current,
        { cloneMasks: true }
      );
      layersRef.current = next;
      setLayers(next);
      grid.notifyChange(true);
      recordLayerHistory(
        apply ? 'Apply Layer Mask' : 'Delete Layer Mask',
        layerId,
        delta,
        tileDeltas,
        'layer'
      );
    },
    [activeLayerIdRef, activeTileGridRef, dimensions, layersRef, recordLayerHistory, setLayers, updateLayerThumbnail]
  );

  // Toggle layer mask enabled state
  const toggleLayerMask = useCallback((layerId: string) => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === layerId);
    if (!target || !target.maskCanvas) return;
    const next = prev.map((l) => (l.id === layerId ? { ...l, maskEnabled: !l.maskEnabled } : l));
    layersRef.current = next;
    setLayers(next);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Toggle Layer Mask',
      layerId,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Toggle mask linked state
  const toggleMaskLinked = useCallback((layerId: string) => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === layerId);
    if (!target || !target.maskCanvas) return;
    const next = prev.map((l) => (l.id === layerId ? { ...l, maskLinked: !l.maskLinked } : l));
    layersRef.current = next;
    setLayers(next);
    recordLayerHistory(
      'Toggle Mask Link',
      layerId,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, layersRef, recordLayerHistory, setLayers]);

  // Update mask thumbnail
  const updateMaskThumbnail = useCallback((layerId: string, immediate: boolean = false) => {
    const run = () => {
      const target = layersRef.current.find((l) => l.id === layerId);
      if (!target?.maskCanvas) return;
      const thumb = createCanvasThumbnail(target.maskCanvas, false);
      setLayers((prev) =>
        prev.map((l) =>
          l.id === layerId
            ? { ...l, maskThumbnailUrl: thumb, maskVersion: (l.maskVersion || 0) + 1 }
            : l
        )
      );
      activeTileGridRef.current.notifyChange(true);
    };

    if (immediate) {
      run();
    } else {
      setTimeout(run, 150);
    }
  }, [activeTileGridRef, layersRef, setLayers]);

  // Add non-destructive adjustment layer
  const addAdjustmentLayer = useCallback(
    (
      type: 'curves' | 'gradient-map' | 'levels' | 'color-balance',
      customData?: AdjustmentLayerData
    ): LayerItem => {
      const prev = layersRef.current;
      const beforeActiveLayerId = activeLayerIdRef.current;
      const id = `adjustment-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

      let defaultData: AdjustmentLayerData;
      let layerName: string;

      switch (type) {
        case 'curves':
          layerName = 'Curves 1';
          defaultData = customData || {
            type: 'curves',
            curves: {
              rgb: [[0, 0], [255, 255]],
              r: [[0, 0], [255, 255]],
              g: [[0, 0], [255, 255]],
              b: [[0, 0], [255, 255]],
            },
          };
          break;
        case 'gradient-map':
          layerName = 'Gradient Map 1';
          defaultData = customData || {
            type: 'gradient-map',
            stops: [
              { position: 0, color: '#000000' },
              { position: 1, color: '#ffffff' },
            ],
            interpolation: 'smooth',
          };
          break;
        case 'levels':
          layerName = 'Levels 1';
          defaultData = customData || {
            type: 'levels',
            blackPoint: 0,
            gamma: 1.0,
            whitePoint: 255,
            outputMin: 0,
            outputMax: 255,
            channel: 'rgb',
          };
          break;
        case 'color-balance':
          layerName = 'Color Balance 1';
          defaultData = customData || {
            type: 'color-balance',
            shadows: [0, 0, 0],
            midtones: [0, 0, 0],
            highlights: [0, 0, 0],
            preserveLuminosity: true,
          };
          break;
      }

      const activeIdx = prev.findIndex((l) => l.id === beforeActiveLayerId);
      const activeLayer = prev[activeIdx];
      const parentId = activeLayer
        ? isFolderLikeLayer(activeLayer)
          ? activeLayer.id
          : activeLayer.parentId
        : null;

      let count = 1;
      const base = layerName.replace(/ \d+$/, '');
      prev.forEach((l) => {
        if (l.name.startsWith(base)) {
          const num = parseInt(l.name.replace(`${base} `, ''), 10);
          if (!isNaN(num) && num >= count) count = num + 1;
        }
      });
      const name = `${base} ${count}`;

      const newLayer: LayerItem = {
        id,
        name,
        type: 'adjustment',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        collapsed: false,
        parentId,
        adjustmentData: defaultData,
      };

      const insertIndex = activeIdx >= 0 ? activeIdx : 0;
      const next = [...prev];
      next.splice(insertIndex, 0, newLayer);
      layersRef.current = next;
      setLayers(next);
      setActiveLayerId(id);
      activeTileGridRef.current.notifyChange(true);
      recordLayerHistory(
        `Add ${name}`,
        id,
        createLayerTreeSnapshotDelta(prev, next, beforeActiveLayerId, id),
        undefined,
        'layer'
      );
      return newLayer;
    },
    [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setActiveLayerId, setLayers]
  );

  // Update adjustment layer data
  const updateAdjustmentData = useCallback((layerId: string, data: AdjustmentLayerData) => {
    const prev = layersRef.current;
    if (!prev.some((l) => l.id === layerId)) return;
    const next = prev.map((l) => (l.id === layerId ? { ...l, adjustmentData: data } : l));
    layersRef.current = next;
    setLayers(next);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Update Adjustment',
      layerId,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Update Layer Styles (Stroke, Drop Shadow, Outer Glow)
  const updateLayerStyles = useCallback((id: string, styles: LayerStyles) => {
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || isFolderLikeLayer(target)) return;
    const next = prev.map((l) => (l.id === id ? { ...l, styles } : l));
    layersRef.current = next;
    setLayers(next);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Layer Styles',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  return {
    toggleVisibility,
    setOpacity,
    setBlendMode,
    toggleLock,
    toggleCollapse,
    toggleClipping,
    toggleAlphaLock,
    addLayerMask,
    removeLayerMask,
    toggleLayerMask,
    toggleMaskLinked,
    updateMaskThumbnail,
    addAdjustmentLayer,
    updateAdjustmentData,
    updateLayerStyles,
  };
}
