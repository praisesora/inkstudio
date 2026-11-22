import { useCallback } from 'react';
import {
  AdjustmentLayerData,
  BlendMode,
  LayerItem,
  LayerStyles,
  isFolderLikeLayer,
} from '../../types/editor';
import { createCanvasThumbnail, get2DContext } from '../../utils/canvasUtils';
import { multiplayerService } from '../../services/multiplayerService';
import { releaseTemporaryCanvas } from '../../utils/tileEngine';
import {
  computeBatchLock,
  computeBatchVisibility,
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
    activeLayerId,
    setActiveLayerId,
    selectedLayerIdsRef,
  } = ctx;
  const { updateLayerThumbnail } = canvasRegistry;

  // Toggle visibility of a layer or folder (batch toggle if part of multi-selection)
  const toggleVisibility = useCallback((id: string) => {
    setLayers((prev) => computeBatchVisibility(prev, selectedLayerIdsRef.current, id));
  }, [selectedLayerIdsRef, setLayers]);

  // Set layer opacity (0.0 to 1.0)
  const setOpacity = useCallback((id: string, opacity: number) => {
    const clamped = Math.max(0, Math.min(1, opacity));
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, opacity: clamped } : l))
    );
  }, [setLayers]);

  // Set layer blend mode
  const setBlendMode = useCallback((id: string, blendMode: BlendMode) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, blendMode } : l))
    );
  }, [setLayers]);

  // Toggle locked state (batch toggle if part of multi-selection)
  const toggleLock = useCallback((id: string) => {
    setLayers((prev) => computeBatchLock(prev, selectedLayerIdsRef.current, id));
  }, [selectedLayerIdsRef, setLayers]);

  // Toggle folder collapse state
  const toggleCollapse = useCallback((id: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, collapsed: !l.collapsed } : l))
    );
  }, [setLayers]);

  // Toggle clipping mask state (Clip to Layer Below)
  const toggleClipping = useCallback((id: string) => {
    setLayers((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (idx === -1 || idx === prev.length - 1 || isBackgroundLayerId(id)) {
        return prev;
      }
      return prev.map((l) => (l.id === id ? { ...l, clipped: !l.clipped } : l));
    });
  }, [setLayers]);

  // Toggle alpha locked state (Lock Transparent Pixels)
  const toggleAlphaLock = useCallback((id: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, alphaLocked: !l.alphaLocked } : l))
    );
  }, [setLayers]);

  // Add a non-destructive grayscale Layer Mask
  const addLayerMask = useCallback((layerId: string) => {
    setLayers((prev) =>
      prev.map((l) => {
        if (l.id !== layerId) return l;
        if (l.maskCanvas) return l; // Already has mask

        const mask = document.createElement('canvas');
        mask.width = dimensions.width;
        mask.height = dimensions.height;
        const mCtx = get2DContext(mask);
        if (mCtx) {
          mCtx.fillStyle = '#ffffff';
          mCtx.fillRect(0, 0, mask.width, mask.height);
        }
        const thumb = createCanvasThumbnail(mask, false);
        return {
          ...l,
          maskCanvas: mask,
          maskEnabled: true,
          maskLinked: true,
          maskThumbnailUrl: thumb,
          maskVersion: 1,
        };
      })
    );
    activeTileGridRef.current.notifyChange(true);
  }, [activeTileGridRef, dimensions, setLayers]);

  // Remove or apply layer mask (directly onto SparseTileGrid tiles, zero full-doc layer canvas)
  const removeLayerMask = useCallback(
    (layerId: string, apply: boolean = false) => {
      const grid = activeTileGridRef.current;
      setLayers((prev) =>
        prev.map((l) => {
          if (l.id !== layerId || !l.maskCanvas) return l;

          if (apply) {
            const beforeSnap = multiplayerService.isConnected()
              ? grid.snapshotLayerTiles(layerId)
              : null;
            grid.applyMaskCanvasToLayer(layerId, l.maskCanvas, dimensions);
            if (beforeSnap && multiplayerService.isConnected()) {
              const deltas = grid.computeDeltasFromSnapshot(beforeSnap, layerId);
              if (deltas.length > 0) {
                multiplayerService.sendTileDeltas(deltas, grid, { force: true });
              }
            }
            updateLayerThumbnail(layerId, true);
          }

          releaseTemporaryCanvas(l.maskCanvas);

          return {
            ...l,
            maskCanvas: undefined,
            maskEnabled: undefined,
            maskLinked: undefined,
            maskThumbnailUrl: undefined,
            maskVersion: undefined,
          };
        })
      );
      grid.notifyChange(true);
    },
    [activeTileGridRef, dimensions, setLayers, updateLayerThumbnail]
  );

  // Toggle layer mask enabled state
  const toggleLayerMask = useCallback((layerId: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === layerId ? { ...l, maskEnabled: !l.maskEnabled } : l))
    );
    activeTileGridRef.current.notifyChange(true);
  }, [activeTileGridRef, setLayers]);

  // Toggle mask linked state
  const toggleMaskLinked = useCallback((layerId: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === layerId ? { ...l, maskLinked: !l.maskLinked } : l))
    );
  }, [setLayers]);

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
      let createdLayer: LayerItem | null = null;
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

      setLayers((prev) => {
        const activeIdx = prev.findIndex((l) => l.id === activeLayerId);
        const activeLayer = prev[activeIdx];
        const parentId = activeLayer ? (activeLayer.type === 'folder' ? activeLayer.id : activeLayer.parentId) : null;

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
        createdLayer = newLayer;

        const insertIndex = activeIdx >= 0 ? activeIdx : 0;
        const next = [...prev];
        next.splice(insertIndex, 0, newLayer);
        return next;
      });

      setActiveLayerId(id);
      activeTileGridRef.current.notifyChange(true);
      return createdLayer!;
    },
    [activeLayerId, activeTileGridRef, setActiveLayerId, setLayers]
  );

  // Update adjustment layer data
  const updateAdjustmentData = useCallback((layerId: string, data: AdjustmentLayerData) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === layerId ? { ...l, adjustmentData: data } : l))
    );
    activeTileGridRef.current.notifyChange(true);
  }, [activeTileGridRef, setLayers]);

  // Update Layer Styles (Stroke, Drop Shadow, Outer Glow)
  const updateLayerStyles = useCallback((id: string, styles: LayerStyles) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || isFolderLikeLayer(target)) return prev;
      return prev.map((l) => (l.id === id ? { ...l, styles } : l));
    });
  }, [setLayers]);

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
