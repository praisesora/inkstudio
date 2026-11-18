import { useState, useRef, useCallback, useEffect } from 'react';
import { LayerItem, BlendMode, CanvasDimensions, CanvasColorMode, LoadedDocument, ExpressionColor, CanvasSelection, DirtyRect, AdjustmentLayerData, LayerStyles } from '../types/editor';
import { ResizeCanvasOptions } from '../types/settings';
import { createCanvasThumbnail, get2DContext } from '../utils/canvasUtils';
import { applyLayerEffects, applyExpressionColorToImageData } from '../utils/layerEffectsEngine';
import { HalftoneDotShape } from '../utils/screentoneEngine';
import { globalTileGrid } from '../utils/tileEngine';
import { recoveryService } from '../services/recoveryService';

interface UseLayerManagerProps {
  dimensions: CanvasDimensions;
  activeSessionId?: string | null;
}

export function isBackgroundLayerId(id: string): boolean {
  return id === 'layer-bg' || id.startsWith('layer-bg');
}

// Helper to generate the next collaborative layer name (e.g. "Sora 1", "Sora 2", "Alex 1")
export function getNextCollabLayerName(username: string, layers: LayerItem[]): string {
  const cleanName = (username || 'User').trim();
  let maxNum = 0;
  const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped}\\s*(\\d*)$`, 'i');

  layers.forEach((l) => {
    const match = l.name.match(regex);
    if (match) {
      const num = match[1] ? parseInt(match[1], 10) : 1;
      if (!isNaN(num) && num > maxNum) {
        maxNum = num;
      }
    }
  });

  return `${cleanName} ${maxNum + 1}`;
}

// Pure selection computation for single, Shift (range), and Ctrl/Cmd (toggle) clicks
export function computeLayerSelection(
  layers: LayerItem[],
  currentSelectedIds: string[],
  activeId: string,
  pivotId: string | null,
  targetId: string,
  isShift: boolean,
  isCtrl: boolean
): { nextSelectedIds: string[]; nextActiveId: string; nextPivotId: string } {
  const targetIndex = layers.findIndex((l) => l.id === targetId);
  if (targetIndex === -1) {
    return {
      nextSelectedIds: currentSelectedIds,
      nextActiveId: activeId,
      nextPivotId: pivotId || activeId,
    };
  }

  if (isShift) {
    const effectivePivot = pivotId || activeId || targetId;
    const pivotIndex = layers.findIndex((l) => l.id === effectivePivot);
    const safePivotIdx = pivotIndex >= 0 ? pivotIndex : targetIndex;
    const start = Math.min(safePivotIdx, targetIndex);
    const end = Math.max(safePivotIdx, targetIndex);
    const rangeIds = layers.slice(start, end + 1).map((l) => l.id);

    if (isCtrl) {
      return {
        nextSelectedIds: Array.from(new Set([...currentSelectedIds, ...rangeIds])),
        nextActiveId: targetId,
        nextPivotId: effectivePivot,
      };
    } else {
      return {
        nextSelectedIds: rangeIds,
        nextActiveId: targetId,
        nextPivotId: effectivePivot,
      };
    }
  } else if (isCtrl) {
    const exists = currentSelectedIds.includes(targetId);
    if (exists) {
      const next = currentSelectedIds.filter((item) => item !== targetId);
      const nextActive = activeId === targetId && next.length > 0 ? next[next.length - 1] : activeId;
      return {
        nextSelectedIds: next,
        nextActiveId: nextActive,
        nextPivotId: targetId,
      };
    } else {
      return {
        nextSelectedIds: [...currentSelectedIds, targetId],
        nextActiveId: targetId,
        nextPivotId: targetId,
      };
    }
  } else {
    return {
      nextSelectedIds: [targetId],
      nextActiveId: targetId,
      nextPivotId: targetId,
    };
  }
}

// Pure batch deletion helper
export function computeBatchDeleteLayers(
  layers: LayerItem[],
  selectedIds: string[],
  activeId: string
): { nextLayers: LayerItem[]; deletedIds: string[]; nextActiveId: string } {
  let targets = [...selectedIds];
  if (targets.length === 0 && activeId) {
    targets = [activeId];
  }
  if (targets.length === 0) {
    return { nextLayers: layers, deletedIds: [], nextActiveId: activeId };
  }

  const targetSet = new Set(targets);
  const allToDelete = new Set<string>();

  const collectDescendants = (parentId: string) => {
    for (const l of layers) {
      if (l.parentId === parentId) {
        allToDelete.add(l.id);
        if (l.type === 'folder') collectDescendants(l.id);
      }
    }
  };

  for (const id of targetSet) {
    allToDelete.add(id);
    const item = layers.find((l) => l.id === id);
    if (item?.type === 'folder') {
      collectDescendants(id);
    }
  }

  // Ensure we don't delete all raster layers if user tries to delete everything
  const remainingRaster = layers.filter((l) => l.type === 'raster' && !allToDelete.has(l.id));
  if (remainingRaster.length === 0) {
    const preserved = layers.find((l) => l.id === 'layer-bg' || l.id.startsWith('layer-bg')) || layers.find((l) => l.type === 'raster');
    if (preserved) {
      allToDelete.delete(preserved.id);
    }
  }

  const nextLayers = layers.filter((l) => !allToDelete.has(l.id));
  const nextActive = nextLayers.find((l) => l.type === 'raster') || nextLayers[0];
  const nextActiveId = nextActive ? nextActive.id : '';

  return {
    nextLayers,
    deletedIds: Array.from(allToDelete),
    nextActiveId,
  };
}

// Pure group selected layers helper
export function computeGroupLayers(
  layers: LayerItem[],
  selectedIds: string[],
  activeId: string,
  customFolderId?: string
): { nextLayers: LayerItem[]; newFolder: LayerItem } | null {
  let targets = [...selectedIds];
  if (targets.length === 0 && activeId) {
    targets = [activeId];
  }
  if (targets.length === 0) return null;

  const targetSet = new Set(targets);
  const selectedItems = layers.filter((l) => targetSet.has(l.id));
  if (selectedItems.length === 0) return null;

  const indices = selectedItems.map((l) => layers.indexOf(l)).filter((idx) => idx >= 0);
  const minIdx = Math.min(...indices);

  const firstParent = selectedItems[0].parentId;
  const allSameParent = selectedItems.every((l) => l.parentId === firstParent);
  const folderParentId = allSameParent ? firstParent : null;

  const folderId = customFolderId || `folder-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
  let count = 1;
  layers.forEach((l) => {
    if (l.type === 'folder' && l.name.startsWith('Folder ')) {
      const num = parseInt(l.name.replace('Folder ', ''), 10);
      if (!isNaN(num) && num >= count) count = num + 1;
    }
  });

  const newFolder: LayerItem = {
    id: folderId,
    name: `Folder ${count}`,
    type: 'folder',
    visible: true,
    opacity: 1,
    blendMode: 'pass-through',
    locked: false,
    collapsed: false,
    parentId: folderParentId,
    thumbnailUrl: '',
  };

  const movingIds = new Set<string>();
  const getDescendants = (parentId: string) => {
    for (const l of layers) {
      if (l.parentId === parentId) {
        movingIds.add(l.id);
        if (l.type === 'folder') getDescendants(l.id);
      }
    }
  };
  for (const item of selectedItems) {
    movingIds.add(item.id);
    if (item.type === 'folder') getDescendants(item.id);
  }

  const movingItems = layers
    .filter((l) => movingIds.has(l.id))
    .map((l) => {
      if (!l.parentId || !movingIds.has(l.parentId)) {
        return { ...l, parentId: folderId };
      }
      return l;
    });

  const remaining = layers.filter((l) => !movingIds.has(l.id));
  const targetInsertIdx = Math.min(minIdx, remaining.length);

  const nextLayers = [
    ...remaining.slice(0, targetInsertIdx),
    newFolder,
    ...movingItems,
    ...remaining.slice(targetInsertIdx),
  ];

  return { nextLayers, newFolder };
}

// Pure drag-and-drop / reordering helper
export function computeBatchReorderLayers(
  layers: LayerItem[],
  selectedIds: string[],
  draggedId: string,
  targetId: string,
  position: 'above' | 'below' | 'inside'
): LayerItem[] {
  if (draggedId === targetId) return layers;

  const isMultiDrag = selectedIds.length > 1 && selectedIds.includes(draggedId);
  const rootIds = isMultiDrag ? selectedIds : [draggedId];

  const targetIdx = layers.findIndex((l) => l.id === targetId);
  if (targetIdx < 0) return layers;
  const targetItem = layers[targetIdx];

  const getDescendantIds = (parentId: string): string[] => {
    const ids: string[] = [];
    for (const item of layers) {
      if (item.parentId === parentId) {
        ids.push(item.id);
        ids.push(...getDescendantIds(item.id));
      }
    }
    return ids;
  };

  const movingIds = new Set<string>();
  for (const id of rootIds) {
    movingIds.add(id);
    const item = layers.find((l) => l.id === id);
    if (item?.type === 'folder') {
      getDescendantIds(id).forEach((descId) => movingIds.add(descId));
    }
  }

  if (movingIds.has(targetId)) return layers;

  let currCheck: LayerItem | undefined = targetItem;
  while (currCheck) {
    if (movingIds.has(currCheck.id)) return layers;
    currCheck = layers.find((l) => l.id === currCheck?.parentId);
  }

  const newParentId = (position === 'inside' && targetItem.type === 'folder')
    ? targetItem.id
    : targetItem.parentId;

  const movingItems = layers
    .filter((l) => movingIds.has(l.id))
    .map((l) => {
      if (!l.parentId || !movingIds.has(l.parentId)) {
        return { ...l, parentId: newParentId };
      }
      return l;
    });

  const remaining = layers.filter((l) => !movingIds.has(l.id));
  const newTargetIdx = remaining.findIndex((l) => l.id === targetId);
  if (newTargetIdx < 0) return layers;

  let insertIdx = newTargetIdx;
  if (position === 'above') {
    insertIdx = newTargetIdx;
  } else if (position === 'below' || position === 'inside') {
    insertIdx = newTargetIdx + 1;
  }

  remaining.splice(insertIdx, 0, ...movingItems);
  return remaining;
}

// Pure batch visibility toggle
export function computeBatchVisibility(
  layers: LayerItem[],
  selectedIds: string[],
  targetId: string
): LayerItem[] {
  const isMulti = selectedIds.length > 1 && selectedIds.includes(targetId);
  if (!isMulti) {
    return layers.map((l) => (l.id === targetId ? { ...l, visible: !l.visible } : l));
  }
  const target = layers.find((l) => l.id === targetId);
  const newVisible = target ? !target.visible : true;
  const selectedSet = new Set(selectedIds);
  return layers.map((l) => (selectedSet.has(l.id) ? { ...l, visible: newVisible } : l));
}

// Pure batch lock toggle
export function computeBatchLock(
  layers: LayerItem[],
  selectedIds: string[],
  targetId: string
): LayerItem[] {
  const isMulti = selectedIds.length > 1 && selectedIds.includes(targetId);
  if (!isMulti) {
    return layers.map((l) => (l.id === targetId ? { ...l, locked: !l.locked } : l));
  }
  const target = layers.find((l) => l.id === targetId);
  const newLocked = target ? !target.locked : true;
  const selectedSet = new Set(selectedIds);
  return layers.map((l) => (selectedSet.has(l.id) ? { ...l, locked: newLocked } : l));
}

export function useLayerManager({ dimensions: _dimensions, activeSessionId }: UseLayerManagerProps) {
  // Store canvas DOM elements for each raster layer by layer ID
  const layerCanvasesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());

  // Store original offscreen raster source canvases for non-destructive screentone processing
  const layerSourceCanvasesRef = useRef<Map<string, HTMLCanvasElement>>(new Map());

  // Default canvas tone frequency (20 to 85 LPI, default: 60)
  const defaultToneFrequencyRef = useRef<number>(60);

  // Pending copy queue: targetId -> sourceId
  const pendingCanvasCopiesRef = useRef<Map<string, string>>(new Map());

  // Pending initial canvas or fill color queue: layerId -> HTMLCanvasElement | HTMLImageElement | string
  const pendingInitialDataRef = useRef<Map<string, HTMLCanvasElement | HTMLImageElement | string>>(new Map());

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

  // Register or unregister canvas element for a layer
  const registerLayerCanvas = useCallback((id: string, canvas: HTMLCanvasElement | null) => {
    if (canvas) {
      if (layerCanvasesRef.current.get(id) === canvas) {
        return; // Already registered with same canvas element, avoid re-running
      }

      layerCanvasesRef.current.set(id, canvas);

      // Check if this new canvas was duplicated from another layer
      const sourceId = pendingCanvasCopiesRef.current.get(id);
      if (sourceId) {
        const sourceCanvas = layerCanvasesRef.current.get(sourceId);
        if (sourceCanvas) {
          const ctx = get2DContext(canvas);
          if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(sourceCanvas, 0, 0);
          }
        }
        pendingCanvasCopiesRef.current.delete(id);
      }

      // Check if this new canvas has pending initial content (from loaded file or new canvas background)
      const initialData = pendingInitialDataRef.current.get(id);
      if (initialData) {
        const ctx = get2DContext(canvas);
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          if (typeof initialData === 'string') {
            if (initialData !== 'transparent') {
              ctx.fillStyle = initialData;
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              if (initialData.toLowerCase() === '#ffffff' || initialData.toLowerCase() === '#fff' || initialData.toLowerCase() === 'white') {
                (canvas as any).__isSolidWhite = true;
              }
            } else {
              (canvas as any).__isBlank = true;
            }
          } else {
            ctx.drawImage(initialData, 0, 0);
          }
        }
        pendingInitialDataRef.current.delete(id);
      } else if (isBackgroundLayerId(id)) {
        // If it's the background layer and uninitialized, fill with solid white
        const ctx = get2DContext(canvas);
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          (canvas as any).__isSolidWhite = true;
        }
      } else if (!sourceId) {
        if (globalTileGrid.isLayerIngested(id)) {
          globalTileGrid.renderLayerToCanvas(id, canvas);
        } else {
          (canvas as any).__isBlank = true;
        }
      }

      // Ingest into globalTileGrid if unindexed or if freshly copied/initialized
      if (!globalTileGrid.isLayerIngested(id) || sourceId || initialData) {
        const layer = layersRef.current.find((l) => l.id === id);
        const isMono = layer?.expressionColor === 'monochrome';
        globalTileGrid.ingestCanvas(id, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
      }

      // Defer initial thumbnail generation to avoid triggering re-render during ref attachment
      requestAnimationFrame(() => {
        const c = layerCanvasesRef.current.get(id);
        if (c) {
          const targetW = 60;
          const targetH = Math.max(38, Math.round((c.height / Math.max(1, c.width)) * targetW));
          const thumb = (c.width * c.height > 1024 * 1024 && globalTileGrid.isLayerIngested(id))
            ? globalTileGrid.generateThumbnail(id, targetW, targetH, { width: c.width, height: c.height })
            : createCanvasThumbnail(c, !isBackgroundLayerId(id));
          setLayers((prev) =>
            prev.map((l) => (l.id === id && !l.thumbnailUrl ? { ...l, thumbnailUrl: thumb } : l))
          );
        }
      });
    } else {
      layerCanvasesRef.current.delete(id);
      globalTileGrid.clearLayer(id);
    }
  }, []);

  // Automatically instantiate and manage offscreen backing canvases for all layers
  useEffect(() => {
    layers.forEach((layer) => {
      if ((layer.type === 'raster' || layer.type === 'vector' || layer.type === 'frame') && !layerCanvasesRef.current.has(layer.id)) {
        const offscreen = document.createElement('canvas');
        offscreen.width = _dimensions.width;
        offscreen.height = _dimensions.height;
        registerLayerCanvas(layer.id, offscreen);
      }
    });

    // When a layer is removed, delete its canvas from layerCanvasesRef.current and clean up tile grid
    const currentLayerIds = new Set(layers.map((l) => l.id));
    for (const id of Array.from(layerCanvasesRef.current.keys())) {
      if (!currentLayerIds.has(id)) {
        layerCanvasesRef.current.delete(id);
        globalTileGrid.clearLayer(id);
      }
    }
  }, [layers, _dimensions, registerLayerCanvas]);

  const thumbDebounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Update a single layer's thumbnail after drawing or editing (debounced to avoid React re-renders during rapid sketching)
  const updateLayerThumbnail = useCallback((id: string, immediate: boolean = false) => {
    const run = () => {
      const canvas = layerCanvasesRef.current.get(id);
      const dims = canvas ? { width: canvas.width, height: canvas.height } : _dimensions;
      const targetW = 60;
      const targetH = Math.max(38, Math.round((dims.height / Math.max(1, dims.width)) * targetW));
      const isLarge = dims.width * dims.height > 1024 * 1024;
      const thumb = (isLarge && globalTileGrid.isLayerIngested(id))
        ? globalTileGrid.generateThumbnail(id, targetW, targetH, dims)
        : (canvas ? createCanvasThumbnail(canvas, !isBackgroundLayerId(id)) : globalTileGrid.generateThumbnail(id, targetW, targetH, dims));

      if (!thumb) return;

      setLayers((prev) => {
        const existingLayer = prev.find((l) => l.id === id);
        if (!existingLayer || existingLayer.thumbnailUrl === thumb) return prev;
        return prev.map((l) => (l.id === id ? { ...l, thumbnailUrl: thumb } : l));
      });
    };

    const existing = thumbDebounceTimersRef.current.get(id);
    if (existing) clearTimeout(existing);

    if (immediate) {
      thumbDebounceTimersRef.current.delete(id);
      run();
    } else {
      const isLargeDoc = _dimensions.width * _dimensions.height > 1024 * 1024;
      const delayMs = isLargeDoc ? 900 : 350;
      const timer = setTimeout(() => {
        thumbDebounceTimersRef.current.delete(id);
        run();
      }, delayMs);
      thumbDebounceTimersRef.current.set(id, timer);
    }
  }, [_dimensions]);

  // Add a new raster layer, folder, or adjustment layer
  const addLayer = useCallback(
    (
      type: 'raster' | 'folder' | 'vector' | 'frame' | 'adjustment' = 'raster',
      explicitParentId?: string | null,
      customName?: string,
      customId?: string,
      selectNewLayer: boolean = true
    ): LayerItem => {
      const id = customId || `${type}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const currentLayers = layersRef.current;
      const currentActiveIdx = currentLayers.findIndex((l) => l.id === activeLayerIdRef.current);
      const currentActiveLayer = currentLayers[currentActiveIdx];

      let initialParentId: string | null = null;
      if (explicitParentId !== undefined) {
        initialParentId = explicitParentId;
      } else if (currentActiveLayer) {
        initialParentId = currentActiveLayer.type === 'folder' ? currentActiveLayer.id : currentActiveLayer.parentId;
      }

      const resolveLayerName = (list: LayerItem[]) => {
        if (customName) return customName;
        let count = 1;
        const prefix =
          type === 'folder' ? 'Folder ' :
          type === 'vector' ? 'Vector ' :
          type === 'frame' ? 'Frame ' :
          type === 'adjustment' ? 'Adjustment ' : 'Layer ';
        list.forEach((l) => {
          if (l.type === type && l.name.startsWith(prefix)) {
            const num = parseInt(l.name.replace(prefix, ''), 10);
            if (!isNaN(num) && num >= count) {
              count = num + 1;
            }
          }
        });
        return `${prefix}${count}`;
      };

      const createdLayer: LayerItem = {
        id,
        name: resolveLayerName(currentLayers),
        type,
        visible: true,
        opacity: 1,
        blendMode: type === 'folder' ? 'pass-through' : 'normal',
        locked: false,
        collapsed: false,
        parentId: initialParentId,
        thumbnailUrl: '',
        expressionColor:
          currentActiveLayer?.expressionColor === 'monochrome'
            ? 'monochrome'
            : currentActiveLayer?.expressionColor === 'gray'
            ? 'gray'
            : 'color',
        monoThreshold: currentActiveLayer?.monoThreshold ?? 128,
        monoExpressBlack: currentActiveLayer?.monoExpressBlack ?? true,
        monoExpressWhite: currentActiveLayer?.monoExpressWhite ?? true,
      };

      setLayers((prev) => {
        if (prev.some((l) => l.id === id)) return prev;
        const activeIdx = prev.findIndex((l) => l.id === activeLayerIdRef.current);
        const activeLayer = prev[activeIdx];

        let parentId: string | null = null;
        if (explicitParentId !== undefined) {
          parentId = explicitParentId;
        } else if (activeLayer) {
          parentId = activeLayer.type === 'folder' ? activeLayer.id : activeLayer.parentId;
        }

        const newLayer: LayerItem = {
          ...createdLayer,
          name: resolveLayerName(prev),
          parentId,
        };

        const insertIndex = activeIdx >= 0 ? activeIdx : 0;
        const nextLayers = [...prev];
        nextLayers.splice(insertIndex, 0, newLayer);
        layersRef.current = nextLayers;
        return nextLayers;
      });

      if (selectNewLayer) {
        setActiveLayerId(id);
      }
      return createdLayer;
    },
    [setActiveLayerId]
  );

  // Add a layer that originated from a remote peer
  const addRemoteLayer = useCallback(
    (layerItem: LayerItem, initialDataUrl?: string) => {
      if (initialDataUrl) {
        const img = new Image();
        img.onload = () => {
          const canvas = layerCanvasesRef.current.get(layerItem.id);
          if (canvas) {
            const ctx = get2DContext(canvas);
            if (ctx) {
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(img, 0, 0);
              const isMono = layerItem.expressionColor === 'monochrome';
              globalTileGrid.ingestCanvas(layerItem.id, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
              globalTileGrid.notifyChange(true);
              updateLayerThumbnail(layerItem.id, true);
            }
          } else {
            pendingInitialDataRef.current.set(layerItem.id, img);
          }
        };
        img.src = initialDataUrl;
      }

      setLayers((prev) => {
        if (prev.some((l) => l.id === layerItem.id)) return prev;
        const next = [...prev];
        const bgIdx = next.findIndex((l) => isBackgroundLayerId(l.id));
        if (bgIdx >= 0) {
          next.splice(bgIdx, 0, layerItem);
        } else {
          next.push(layerItem);
        }
        return next;
      });
    },
    [updateLayerThumbnail]
  );

  // Delete a layer triggered remotely
  const deleteRemoteLayer = useCallback((layerId: string) => {
    setLayers((prev) => prev.filter((l) => l.id !== layerId));
    layerCanvasesRef.current.delete(layerId);
    layerSourceCanvasesRef.current.delete(layerId);
    globalTileGrid.clearLayer(layerId);
  }, []);

  // Sync entire document state from remote host
  const syncRemoteDocument = useCallback(
    (
      syncedLayers: LayerItem[],
      layerDataUrls: Record<string, string>,
      assignedLayerId?: string
    ) => {
      setLayers(syncedLayers);

      if (assignedLayerId) {
        setActiveLayerId(assignedLayerId);
      } else {
        const topRaster = syncedLayers.find((l) => l.type === 'raster' && !isBackgroundLayerId(l.id));
        if (topRaster) {
          setActiveLayerId(topRaster.id);
        }
      }

      // Load snapshot images onto canvases
      syncedLayers.forEach((layer) => {
        const dataUrl = layerDataUrls[layer.id];
        if (dataUrl) {
          const img = new Image();
          img.onload = () => {
            const canvas = layerCanvasesRef.current.get(layer.id);
            if (canvas) {
              const ctx = get2DContext(canvas);
              if (ctx) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0);
                const isMono = layer.expressionColor === 'monochrome';
                globalTileGrid.ingestCanvas(layer.id, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
                globalTileGrid.notifyChange(true);
                updateLayerThumbnail(layer.id, true);
              }
            } else {
              const offscreen = document.createElement('canvas');
              offscreen.width = img.naturalWidth || img.width;
              offscreen.height = img.naturalHeight || img.height;
              get2DContext(offscreen)?.drawImage(img, 0, 0);
              pendingInitialDataRef.current.set(layer.id, offscreen);
            }
          };
          img.src = dataUrl;
        }
      });
    },
    [setActiveLayerId, updateLayerThumbnail]
  );

  // Duplicate an existing layer or folder hierarchy with a single click
  const duplicateLayer = useCallback((id: string) => {
    setLayers((prev) => {
      const sourceIdx = prev.findIndex((l) => l.id === id);
      if (sourceIdx < 0) return prev;

      const cloneSingleLayer = (source: LayerItem, newParentId: string | null, nameSuffix: string = ' Copy'): LayerItem => {
        const newId = `${source.type}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

        if (source.type === 'raster' || source.type === 'vector' || source.type === 'frame') {
          pendingCanvasCopiesRef.current.set(newId, source.id);

          const srcSource = layerSourceCanvasesRef.current.get(source.id);
          if (srcSource) {
            const newSource = document.createElement('canvas');
            newSource.width = srcSource.width;
            newSource.height = srcSource.height;
            get2DContext(newSource)?.drawImage(srcSource, 0, 0);
            layerSourceCanvasesRef.current.set(newId, newSource);
          }
        }

        let newMaskCanvas: HTMLCanvasElement | undefined;
        let newMaskThumb: string | undefined;
        if (source.maskCanvas) {
          newMaskCanvas = document.createElement('canvas');
          newMaskCanvas.width = source.maskCanvas.width;
          newMaskCanvas.height = source.maskCanvas.height;
          const mCtx = get2DContext(newMaskCanvas);
          if (mCtx) mCtx.drawImage(source.maskCanvas, 0, 0);
          newMaskThumb = source.maskThumbnailUrl;
        }

        return {
          ...source,
          id: newId,
          name: `${source.name}${nameSuffix}`,
          parentId: newParentId,
          thumbnailUrl: source.thumbnailUrl,
          maskCanvas: newMaskCanvas,
          maskThumbnailUrl: newMaskThumb,
          maskVersion: source.maskCanvas ? 1 : undefined,
          vectorStrokes: source.vectorStrokes ? JSON.parse(JSON.stringify(source.vectorStrokes)) : undefined,
          comicFrames: source.comicFrames ? JSON.parse(JSON.stringify(source.comicFrames)) : undefined,
          balloons: source.balloons ? JSON.parse(JSON.stringify(source.balloons)) : undefined,
          adjustmentData: source.adjustmentData ? JSON.parse(JSON.stringify(source.adjustmentData)) : undefined,
          styles: source.styles ? JSON.parse(JSON.stringify(source.styles)) : undefined,
        };
      };

      const source = prev[sourceIdx];
      if (source.type !== 'folder') {
        const newLayer = cloneSingleLayer(source, source.parentId, ' Copy');
        const nextLayers = [...prev];
        nextLayers.splice(sourceIdx, 0, newLayer);
        setActiveLayerId(newLayer.id);
        return nextLayers;
      }

      // Recursively duplicate folder and all nested descendants in stack order
      const clonedItems: LayerItem[] = [];
      const cloneFolderSubtree = (folder: LayerItem, targetParentId: string | null, isRootFolder: boolean) => {
        const folderCopy = cloneSingleLayer(folder, targetParentId, isRootFolder ? ' Copy' : '');
        clonedItems.push(folderCopy);
        const directChildren = prev.filter((l) => l.parentId === folder.id);
        for (const child of directChildren) {
          if (child.type === 'folder') {
            cloneFolderSubtree(child, folderCopy.id, false);
          } else {
            clonedItems.push(cloneSingleLayer(child, folderCopy.id, ' Copy'));
          }
        }
      };

      cloneFolderSubtree(source, source.parentId, true);
      const nextLayers = [...prev];
      nextLayers.splice(sourceIdx, 0, ...clonedItems);
      if (clonedItems[0]) {
        setActiveLayerId(clonedItems[0].id);
      }
      return nextLayers;
    });
  }, [setActiveLayerId]);

  // Delete a layer or folder (including nested folder hierarchies)
  const deleteLayer = useCallback((id: string) => {
    setLayers((prev) => {
      const res = computeBatchDeleteLayers(prev, [id], activeLayerIdRef.current);
      if (res.deletedIds.length === 0) return prev;

      for (const delId of res.deletedIds) {
        layerCanvasesRef.current.delete(delId);
        layerSourceCanvasesRef.current.delete(delId);
        globalTileGrid.clearLayer(delId);
      }

      if (res.deletedIds.includes(activeLayerIdRef.current)) {
        setActiveLayerId(res.nextActiveId);
      } else {
        setSelectedLayerIds((prevSelected) => prevSelected.filter((sid) => !res.deletedIds.includes(sid)));
      }
      return res.nextLayers;
    });
  }, [setActiveLayerId, setSelectedLayerIds]);

  // Delete all selected layers or folders
  const deleteSelectedLayers = useCallback(() => {
    setLayers((prev) => {
      const res = computeBatchDeleteLayers(prev, selectedLayerIdsRef.current, activeLayerIdRef.current);
      if (res.deletedIds.length === 0) return prev;

      for (const id of res.deletedIds) {
        layerCanvasesRef.current.delete(id);
        layerSourceCanvasesRef.current.delete(id);
        globalTileGrid.clearLayer(id);
      }

      setActiveLayerId(res.nextActiveId);
      return res.nextLayers;
    });
  }, [setActiveLayerId]);

  // Group all currently selected layers into a new folder
  const groupSelectedLayers = useCallback(() => {
    setLayers((prev) => {
      const res = computeGroupLayers(prev, selectedLayerIdsRef.current, activeLayerIdRef.current);
      if (!res) return prev;

      setActiveLayerId(res.newFolder.id);
      return res.nextLayers;
    });
  }, [setActiveLayerId]);

  // Toggle visibility of a layer or folder (batch toggle if part of multi-selection)
  const toggleVisibility = useCallback((id: string) => {
    setLayers((prev) => computeBatchVisibility(prev, selectedLayerIdsRef.current, id));
  }, []);

  // Set layer opacity (0.0 to 1.0)
  const setOpacity = useCallback((id: string, opacity: number) => {
    const clamped = Math.max(0, Math.min(1, opacity));
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, opacity: clamped } : l))
    );
  }, []);

  // Set layer blend mode
  const setBlendMode = useCallback((id: string, blendMode: BlendMode) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, blendMode } : l))
    );
  }, []);

  // Toggle locked state (batch toggle if part of multi-selection)
  const toggleLock = useCallback((id: string) => {
    setLayers((prev) => computeBatchLock(prev, selectedLayerIdsRef.current, id));
  }, []);

  // Toggle folder collapse state
  const toggleCollapse = useCallback((id: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, collapsed: !l.collapsed } : l))
    );
  }, []);

  // Toggle clipping mask state (Clip to Layer Below)
  const toggleClipping = useCallback((id: string) => {
    setLayers((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (idx === -1 || idx === prev.length - 1 || isBackgroundLayerId(id)) {
        return prev;
      }
      return prev.map((l) => (l.id === id ? { ...l, clipped: !l.clipped } : l));
    });
  }, []);

  // Toggle alpha locked state (Lock Transparent Pixels)
  const toggleAlphaLock = useCallback((id: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, alphaLocked: !l.alphaLocked } : l))
    );
  }, []);

  // Add a non-destructive grayscale Layer Mask
  const addLayerMask = useCallback((layerId: string) => {
    setLayers((prev) =>
      prev.map((l) => {
        if (l.id !== layerId) return l;
        if (l.maskCanvas) return l; // Already has mask

        const mask = document.createElement('canvas');
        mask.width = _dimensions.width;
        mask.height = _dimensions.height;
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
    globalTileGrid.notifyChange(true);
  }, [_dimensions]);

  // Remove or apply layer mask
  const removeLayerMask = useCallback(
    (layerId: string, apply: boolean = false) => {
      setLayers((prev) =>
        prev.map((l) => {
          if (l.id !== layerId || !l.maskCanvas) return l;

          if (apply) {
            const c = layerCanvasesRef.current.get(layerId);
            if (c) {
              const ctx = get2DContext(c);
              const mCtx = get2DContext(l.maskCanvas);
              if (ctx && mCtx) {
                const imgData = ctx.getImageData(0, 0, c.width, c.height);
                const maskData = mCtx.getImageData(0, 0, c.width, c.height).data;
                const d = imgData.data;
                for (let i = 0; i < d.length; i += 4) {
                  if (d[i + 3] === 0) continue;
                  const maskLum =
                    ((0.299 * maskData[i] + 0.587 * maskData[i + 1] + 0.114 * maskData[i + 2]) / 255) *
                    (maskData[i + 3] / 255);
                  d[i + 3] = Math.round(d[i + 3] * maskLum);
                }
                ctx.putImageData(imgData, 0, 0);

                const sCanvas = layerSourceCanvasesRef.current.get(layerId);
                if (sCanvas) {
                  const sCtx = get2DContext(sCanvas);
                  if (sCtx) {
                    const sData = sCtx.getImageData(0, 0, sCanvas.width, sCanvas.height);
                    const sd = sData.data;
                    for (let i = 0; i < sd.length; i += 4) {
                      if (sd[i + 3] === 0) continue;
                      const maskLum =
                        ((0.299 * maskData[i] + 0.587 * maskData[i + 1] + 0.114 * maskData[i + 2]) / 255) *
                        (maskData[i + 3] / 255);
                      sd[i + 3] = Math.round(sd[i + 3] * maskLum);
                    }
                    sCtx.putImageData(sData, 0, 0);
                  }
                }

                const isMono = l.expressionColor === 'monochrome';
                globalTileGrid.ingestCanvas(layerId, c, isMono ? 'monochrome-1bit' : 'color-32bit');
                updateLayerThumbnail(layerId, true);
              }
            }
          }

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
      globalTileGrid.notifyChange(true);
    },
    [updateLayerThumbnail]
  );

  // Toggle layer mask enabled state
  const toggleLayerMask = useCallback((layerId: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === layerId ? { ...l, maskEnabled: !l.maskEnabled } : l))
    );
    globalTileGrid.notifyChange(true);
  }, []);

  // Toggle mask linked state
  const toggleMaskLinked = useCallback((layerId: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === layerId ? { ...l, maskLinked: !l.maskLinked } : l))
    );
  }, []);

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
      globalTileGrid.notifyChange(true);
    };

    if (immediate) {
      run();
    } else {
      setTimeout(run, 150);
    }
  }, []);

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
      globalTileGrid.notifyChange(true);
      return createdLayer!;
    },
    [activeLayerId]
  );

  // Update adjustment layer data
  const updateAdjustmentData = useCallback((layerId: string, data: AdjustmentLayerData) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === layerId ? { ...l, adjustmentData: data } : l))
    );
    globalTileGrid.notifyChange(true);
  }, []);

  // Ensure offscreen source canvas exists for non-destructive operations
  const ensureSourceCanvas = useCallback(
    (id: string, copyFromDisplay = true, forceCopy = false) => {
      let sourceCanvas = layerSourceCanvasesRef.current.get(id);
      const displayCanvas = layerCanvasesRef.current.get(id);
      const targetW = displayCanvas?.width || _dimensions.width;
      const targetH = displayCanvas?.height || _dimensions.height;

      if (!sourceCanvas) {
        sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = targetW;
        sourceCanvas.height = targetH;
        if (copyFromDisplay && displayCanvas) {
          const sCtx = get2DContext(sourceCanvas);
          sCtx?.drawImage(displayCanvas, 0, 0);
        }
        layerSourceCanvasesRef.current.set(id, sourceCanvas);
      } else {
        const sizeMismatch = sourceCanvas.width !== targetW || sourceCanvas.height !== targetH;
        if (sizeMismatch) {
          sourceCanvas.width = targetW;
          sourceCanvas.height = targetH;
        }
        if ((forceCopy || (copyFromDisplay && sizeMismatch)) && displayCanvas) {
          const sCtx = get2DContext(sourceCanvas);
          if (sCtx) {
            sCtx.clearRect(0, 0, targetW, targetH);
            sCtx.drawImage(displayCanvas, 0, 0);
          }
        }
      }
      return sourceCanvas;
    },
    [_dimensions]
  );

  const pendingEffectRendersRef = useRef<Map<string, { layer: LayerItem; dirtyRect?: DirtyRect }>>(new Map());
  const effectRafIdRef = useRef<number | null>(null);

  const scheduleLayerEffectRender = useCallback((layer: LayerItem, dirtyRect?: DirtyRect) => {
    pendingEffectRendersRef.current.set(layer.id, { layer, dirtyRect });
    if (effectRafIdRef.current === null) {
      effectRafIdRef.current = requestAnimationFrame(() => {
        effectRafIdRef.current = null;
        const queue = new Map(pendingEffectRendersRef.current);
        pendingEffectRendersRef.current.clear();

        queue.forEach(({ layer: l, dirtyRect: rect }, id) => {
          const sourceCanvas = ensureSourceCanvas(id, true, false);
          const displayCanvas = layerCanvasesRef.current.get(id);
          if (sourceCanvas && displayCanvas) {
            applyLayerEffects(sourceCanvas, displayCanvas, l, _dimensions.dpi ?? 600, rect);
            updateLayerThumbnail(id, false);
          }
        });
      });
    }
  }, [_dimensions.dpi, ensureSourceCanvas, updateLayerThumbnail]);

  useEffect(() => {
    return () => {
      if (effectRafIdRef.current !== null) {
        cancelAnimationFrame(effectRafIdRef.current);
        effectRafIdRef.current = null;
      }
    };
  }, []);

  // Toggle non-destructive Clip Studio Paint style screentone effect on a layer
  // Toggle non-destructive Clip Studio Paint style screentone effect on a layer
  const toggleTone = useCallback((id: string) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const newEnabled = !target.toneEnabled;
      const freq = target.toneFrequency ?? defaultToneFrequencyRef.current ?? 60;
      const angle = target.toneAngle ?? 45;
      const shape = target.toneDotShape ?? 'circle';
      const density = target.toneDensity ?? 40;
      const densityType = target.toneDensityType ?? 'specified';

      const updatedLayer: LayerItem = {
        ...target,
        toneEnabled: newEnabled,
        toneFrequency: freq,
        toneAngle: angle,
        toneDotShape: shape,
        toneDensity: density,
        toneDensityType: densityType,
      };

      const displayCanvas = layerCanvasesRef.current.get(id);
      if (displayCanvas) {
        if (newEnabled) {
          // Initialize sourceCanvas only if not already present; never force-overwrite existing continuous-tone source
          const sourceCanvas = ensureSourceCanvas(id, true, false);
          if (sourceCanvas) {
            applyLayerEffects(sourceCanvas, displayCanvas, updatedLayer, _dimensions.dpi ?? 600);
          }
        } else {
          // Turning off tone: restore continuous raster from sourceCanvas
          let sourceCanvas = layerSourceCanvasesRef.current.get(id);
          if (!sourceCanvas) {
            sourceCanvas = ensureSourceCanvas(id, true, false);
          }
          if (sourceCanvas) {
            applyLayerEffects(sourceCanvas, displayCanvas, updatedLayer, _dimensions.dpi ?? 600);
          }
        }
        updateLayerThumbnail(id, true);
      }

      let nextLayers = prev.map((l) => (l.id === id ? updatedLayer : l));

      // If turning ON and there is no background layer in the document, create one
      // so screentone transparent holes render against clean white paper instead of dark checkerboard
      const hasBg = prev.some((l) => l.id.startsWith('layer-bg') || l.name.toLowerCase() === 'background');
      if (newEnabled && !hasBg) {
        const bgId = `layer-bg-${Date.now()}`;
        pendingInitialDataRef.current.set(bgId, '#ffffff');
        const bgLayer: LayerItem = {
          id: bgId,
          name: 'Background',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: true,
          parentId: null,
          thumbnailUrl: '',
        };
        nextLayers = [...nextLayers, bgLayer];
      }

      return nextLayers;
    });
  }, [_dimensions.dpi, ensureSourceCanvas, updateLayerThumbnail]);

  // Update screentone frequency (Lines / LPI, 20 to 85)
  const setToneFrequency = useCallback((id: string, frequency: number) => {
    const clampedFreq = Math.max(20, Math.min(85, Math.round(frequency)));
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const updatedLayer: LayerItem = { ...target, toneFrequency: clampedFreq };
      if (target.toneEnabled) {
        scheduleLayerEffectRender(updatedLayer);
      }
      return prev.map((l) => (l.id === id ? updatedLayer : l));
    });
  }, [scheduleLayerEffectRender]);

  // Update screentone angle (0 to 90 degrees)
  const setToneAngle = useCallback((id: string, angle: number) => {
    const clampedAngle = Math.max(0, Math.min(90, Math.round(angle)));
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const updatedLayer: LayerItem = { ...target, toneAngle: clampedAngle };
      if (target.toneEnabled) {
        scheduleLayerEffectRender(updatedLayer);
      }
      return prev.map((l) => (l.id === id ? updatedLayer : l));
    });
  }, [scheduleLayerEffectRender]);

  // Update screentone dot shape (default: circle)
  const setToneDotShape = useCallback((id: string, dotShape: HalftoneDotShape) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const updatedLayer: LayerItem = { ...target, toneDotShape: dotShape };
      if (target.toneEnabled) {
        scheduleLayerEffectRender(updatedLayer);
      }
      return prev.map((l) => (l.id === id ? updatedLayer : l));
    });
  }, [scheduleLayerEffectRender]);

  // Update screentone density (1 to 100%)
  const setToneDensity = useCallback((id: string, density: number) => {
    const clampedDensity = Math.max(1, Math.min(100, Math.round(density)));
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const updatedLayer: LayerItem = { ...target, toneDensity: clampedDensity };
      if (target.toneEnabled) {
        scheduleLayerEffectRender(updatedLayer);
      }
      return prev.map((l) => (l.id === id ? updatedLayer : l));
    });
  }, [scheduleLayerEffectRender]);

  // Update screentone density mode ('specified' vs 'image')
  const setToneDensityType = useCallback((id: string, densityType: 'specified' | 'image') => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const updatedLayer: LayerItem = { ...target, toneDensityType: densityType };
      if (target.toneEnabled) {
        scheduleLayerEffectRender(updatedLayer);
      }
      return prev.map((l) => (l.id === id ? updatedLayer : l));
    });
  }, [scheduleLayerEffectRender]);

  // Toggle Clip Studio Paint style Layer Color (Tint) effect on a layer
  const toggleLayerColor = useCallback((id: string) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const newEnabled = !target.layerColorEnabled;
      const layerColor = target.layerColor || '#1c73c2';
      const layerSubColor = target.layerSubColor || '#ffffff';

      const updatedLayer: LayerItem = {
        ...target,
        layerColorEnabled: newEnabled,
        layerColor,
        layerSubColor,
      };

      const displayCanvas = layerCanvasesRef.current.get(id);
      if (displayCanvas) {
        const sourceCanvas = ensureSourceCanvas(id, true, false);
        if (sourceCanvas) {
          applyLayerEffects(sourceCanvas, displayCanvas, updatedLayer, _dimensions.dpi ?? 600);
        }
        updateLayerThumbnail(id, true);
      }

      return prev.map((l) => (l.id === id ? updatedLayer : l));
    });
  }, [_dimensions.dpi, ensureSourceCanvas, updateLayerThumbnail]);

  // Update Layer Color (Tint primary color)
  const setLayerColor = useCallback((id: string, color: string) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const updatedLayer: LayerItem = {
        ...target,
        layerColor: color,
      };
      if (target.layerColorEnabled) {
        scheduleLayerEffectRender(updatedLayer);
      }
      return prev.map((l) => (l.id === id ? updatedLayer : l));
    });
  }, [scheduleLayerEffectRender]);

  // Update Layer Sub Color (Tint secondary color)
  const setLayerSubColor = useCallback((id: string, color: string) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const updatedLayer: LayerItem = {
        ...target,
        layerSubColor: color,
      };
      if (target.layerColorEnabled) {
        scheduleLayerEffectRender(updatedLayer);
      }
      return prev.map((l) => (l.id === id ? updatedLayer : l));
    });
  }, [scheduleLayerEffectRender]);

  // Update Expression Color ('color' | 'gray' | 'monochrome')
  const setLayerExpressionColor = useCallback((id: string, mode: ExpressionColor) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const updatedLayer: LayerItem = {
        ...target,
        expressionColor: mode,
        monoThreshold: target.monoThreshold ?? 128,
        monoExpressBlack: target.monoExpressBlack ?? true,
        monoExpressWhite: target.monoExpressWhite ?? true,
      };

      const displayCanvas = layerCanvasesRef.current.get(id);
      if (displayCanvas) {
        const sourceCanvas = ensureSourceCanvas(id, true, false);
        if (sourceCanvas) {
          applyLayerEffects(sourceCanvas, displayCanvas, updatedLayer, _dimensions.dpi ?? 600);
        }
        updateLayerThumbnail(id, true);
      }

      return prev.map((l) => (l.id === id ? updatedLayer : l));
    });
  }, [_dimensions.dpi, ensureSourceCanvas, updateLayerThumbnail]);

  // Update Monochrome Color threshold (1 - 255)
  const setLayerMonoThreshold = useCallback((id: string, threshold: number) => {
    const clamped = Math.max(1, Math.min(255, Math.round(threshold)));
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const updatedLayer: LayerItem = {
        ...target,
        monoThreshold: clamped,
      };
      if (target.expressionColor === 'monochrome') {
        scheduleLayerEffectRender(updatedLayer);
      }
      return prev.map((l) => (l.id === id ? updatedLayer : l));
    });
  }, [scheduleLayerEffectRender]);

  // Update Monochrome Express Colors (express black, express white)
  const setLayerMonoExpressMode = useCallback((id: string, expressBlack: boolean, expressWhite: boolean) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;

      const updatedLayer: LayerItem = {
        ...target,
        monoExpressBlack: expressBlack,
        monoExpressWhite: expressWhite,
      };
      if (target.expressionColor === 'monochrome') {
        scheduleLayerEffectRender(updatedLayer);
      }
      return prev.map((l) => (l.id === id ? updatedLayer : l));
    });
  }, [scheduleLayerEffectRender]);

  // Apply previewed expression color permanently into layer pixel buffer
  const applyExpressionColorOfPreview = useCallback(
    (id: string): { beforeImageData: ImageData | null; afterImageData: ImageData | null } | null => {
      const target = layers.find((l) => l.id === id);
      if (!target || target.type === 'folder') return null;

      const displayCanvas = layerCanvasesRef.current.get(id);
      let sourceCanvas = layerSourceCanvasesRef.current.get(id);
      if (!displayCanvas) return null;

      if (!sourceCanvas) {
        sourceCanvas = ensureSourceCanvas(id, true, true);
      }

      const sCtx = sourceCanvas ? get2DContext(sourceCanvas) : null;
      const dCtx = get2DContext(displayCanvas);
      if (!sCtx || !dCtx) return null;

      const beforeImageData = sCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      const afterImageData = dCtx.getImageData(0, 0, displayCanvas.width, displayCanvas.height);

      // Bake displayCanvas into sourceCanvas permanently
      sCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
      sCtx.drawImage(displayCanvas, 0, 0);

      const isMono = target.expressionColor === 'monochrome';
      globalTileGrid.ingestCanvas(id, displayCanvas, isMono ? 'monochrome-1bit' : 'color-32bit');
      globalTileGrid.notifyChange(true);
      updateLayerThumbnail(id, true);

      return { beforeImageData, afterImageData };
    },
    [layers, ensureSourceCanvas, updateLayerThumbnail]
  );

  // Apply layer color tint permanently into layer pixel buffer
  const applyLayerColorPermanently = useCallback(
    (id: string): { beforeImageData: ImageData | null; afterImageData: ImageData | null } | null => {
      const target = layers.find((l) => l.id === id);
      if (!target || target.type === 'folder' || !target.layerColorEnabled) return null;

      const displayCanvas = layerCanvasesRef.current.get(id);
      let sourceCanvas = layerSourceCanvasesRef.current.get(id);
      if (!displayCanvas) return null;

      if (!sourceCanvas) {
        sourceCanvas = ensureSourceCanvas(id, true, true);
      }

      const sCtx = sourceCanvas ? get2DContext(sourceCanvas) : null;
      const dCtx = get2DContext(displayCanvas);
      if (!sCtx || !dCtx) return null;

      const beforeImageData = sCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
      const afterImageData = dCtx.getImageData(0, 0, displayCanvas.width, displayCanvas.height);

      // Bake displayCanvas into sourceCanvas permanently and turn off layerColorEnabled
      sCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
      sCtx.drawImage(displayCanvas, 0, 0);

      setLayers((prev) =>
        prev.map((l) => (l.id === id ? { ...l, layerColorEnabled: false } : l))
      );

      const isMono = target.expressionColor === 'monochrome';
      globalTileGrid.ingestCanvas(id, displayCanvas, isMono ? 'monochrome-1bit' : 'color-32bit');
      globalTileGrid.notifyChange(true);
      updateLayerThumbnail(id, true);

      return { beforeImageData, afterImageData };
    },
    [layers, ensureSourceCanvas, updateLayerThumbnail]
  );

  // Direct permanent conversion of any layer (including imported image) to Color, Gray, or Monochrome
  const convertLayer = useCallback(
    (
      id: string,
      targetMode: ExpressionColor,
      options?: { threshold?: number; expressBlack?: boolean; expressWhite?: boolean }
    ): { beforeImageData: ImageData | null; afterImageData: ImageData | null } | null => {
      const target = layers.find((l) => l.id === id);
      if (!target || target.type === 'folder') return null;

      const displayCanvas = layerCanvasesRef.current.get(id);
      if (!displayCanvas) return null;

      const sourceCanvas = ensureSourceCanvas(id, true, false);
      if (!sourceCanvas) return null;

      const sCtx = get2DContext(sourceCanvas);
      const dCtx = get2DContext(displayCanvas);
      if (!sCtx || !dCtx) return null;

      const beforeImageData = sCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);

      const updatedLayer: LayerItem = {
        ...target,
        expressionColor: targetMode,
        monoThreshold: options?.threshold ?? target.monoThreshold ?? 128,
        monoExpressBlack: options?.expressBlack ?? target.monoExpressBlack ?? true,
        monoExpressWhite: options?.expressWhite ?? target.monoExpressWhite ?? true,
      };

      if (updatedLayer.toneEnabled) {
        // If tone is enabled, apply expression color to sourceCanvas directly, then update displayCanvas
        const sData = sCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
        applyExpressionColorToImageData(sData, targetMode, options);
        sCtx.putImageData(sData, 0, 0);
        applyLayerEffects(sourceCanvas, displayCanvas, updatedLayer, _dimensions.dpi ?? 600);
      } else {
        applyLayerEffects(sourceCanvas, displayCanvas, updatedLayer, _dimensions.dpi ?? 600);
        sCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
        sCtx.drawImage(displayCanvas, 0, 0);
      }

      const afterImageData = dCtx.getImageData(0, 0, displayCanvas.width, displayCanvas.height);

      const isMono = targetMode === 'monochrome';
      globalTileGrid.ingestCanvas(id, displayCanvas, isMono ? 'monochrome-1bit' : 'color-32bit');
      globalTileGrid.notifyChange(true);
      setLayers((prev) => prev.map((l) => (l.id === id ? updatedLayer : l)));
      updateLayerThumbnail(id, true);

      return { beforeImageData, afterImageData };
    },
    [layers, ensureSourceCanvas, _dimensions.dpi, updateLayerThumbnail]
  );

  // Rename a layer
  const renameLayer = useCallback((id: string, newName: string) => {
    if (!newName.trim()) return;
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, name: newName.trim() } : l))
    );
  }, []);

  // Move layer up or down in visual stack
  const moveLayer = useCallback((id: string, direction: 'up' | 'down') => {
    setLayers((prev) => {
      const idx = prev.findIndex((l) => l.id === id);
      if (idx < 0) return prev;

      const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;

      const next = [...prev];
      const [item] = next.splice(idx, 1);
      next.splice(targetIdx, 0, item);
      return next;
    });
  }, []);

  // Move layer into a specific folder or to root
  const moveLayerToFolder = useCallback((id: string, targetFolderId: string | null) => {
    setLayers((prev) => {
      const item = prev.find((l) => l.id === id);
      if (!item || item.id === targetFolderId) return prev;

      // If moving a folder into itself, ignore
      if (item.type === 'folder' && targetFolderId) {
        let curr: LayerItem | undefined = prev.find((l) => l.id === targetFolderId);
        while (curr) {
          if (curr.id === id) return prev;
          curr = prev.find((l) => l.id === curr?.parentId);
        }
      }

      return prev.map((l) => (l.id === id ? { ...l, parentId: targetFolderId } : l));
    });
  }, []);

  // Reorder layer via drag-and-drop (supports multi-layer selection)
  const reorderLayers = useCallback((draggedId: string, targetId: string, position: 'above' | 'below' | 'inside') => {
    setLayers((prev) => computeBatchReorderLayers(prev, selectedLayerIdsRef.current, draggedId, targetId, position));
  }, []);

  // Move selected layers into a target parent folder or index
  const moveSelectedLayers = useCallback((targetParentId: string | null, targetIndex?: number) => {
    setLayers((prev) => {
      const selectedIds = selectedLayerIdsRef.current.length > 0
        ? selectedLayerIdsRef.current
        : activeLayerIdRef.current ? [activeLayerIdRef.current] : [];
      if (selectedIds.length === 0) return prev;

      const getDescendantIds = (parentId: string): string[] => {
        const ids: string[] = [];
        for (const item of prev) {
          if (item.parentId === parentId) {
            ids.push(item.id);
            ids.push(...getDescendantIds(item.id));
          }
        }
        return ids;
      };

      const movingIds = new Set<string>();
      for (const id of selectedIds) {
        movingIds.add(id);
        const item = prev.find((l) => l.id === id);
        if (item?.type === 'folder') {
          getDescendantIds(id).forEach((descId) => movingIds.add(descId));
        }
      }

      if (targetParentId && movingIds.has(targetParentId)) return prev;

      const movingItems = prev
        .filter((l) => movingIds.has(l.id))
        .map((l) => {
          if (!l.parentId || !movingIds.has(l.parentId)) {
            return { ...l, parentId: targetParentId };
          }
          return l;
        });

      const remaining = prev.filter((l) => !movingIds.has(l.id));

      let insertIdx = remaining.length;
      if (typeof targetIndex === 'number') {
        insertIdx = Math.max(0, Math.min(remaining.length, targetIndex));
      } else if (targetParentId) {
        const parentIdx = remaining.findIndex((l) => l.id === targetParentId);
        insertIdx = parentIdx >= 0 ? parentIdx + 1 : remaining.length;
      }

      remaining.splice(insertIdx, 0, ...movingItems);
      return remaining;
    });
  }, []);

  // Calculate effective opacity accounting for parent folders
  const getEffectiveOpacity = useCallback((layer: LayerItem): number => {
    if (!layer.parentId) return layer.opacity;
    const parent = layers.find((l) => l.id === layer.parentId);
    if (!parent) return layer.opacity;
    return layer.opacity * getEffectiveOpacity(parent);
  }, [layers]);

  // Check if layer is visible accounting for parent folders
  const isLayerEffectivelyVisible = useCallback((layer: LayerItem): boolean => {
    if (!layer.visible) return false;
    if (!layer.parentId) return true;
    const parent = layers.find((l) => l.id === layer.parentId);
    if (!parent) return true;
    return isLayerEffectivelyVisible(parent);
  }, [layers]);

  // Clear active layer content
  const clearActiveLayer = useCallback(() => {
    const canvas = layerCanvasesRef.current.get(activeLayerId);
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const isBg = isBackgroundLayerId(activeLayerId);
    if (isBg) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      (canvas as any).__isSolidWhite = true;
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      (canvas as any).__isBlank = true;
    }

    const sCanvas = layerSourceCanvasesRef.current.get(activeLayerId);
    if (sCanvas) {
      const sCtx = get2DContext(sCanvas);
      if (sCtx) {
        if (isBg) {
          sCtx.fillStyle = '#ffffff';
          sCtx.fillRect(0, 0, sCanvas.width, sCanvas.height);
        } else {
          sCtx.clearRect(0, 0, sCanvas.width, sCanvas.height);
        }
      }
    }

    if (isBg) {
      globalTileGrid.ingestCanvas(activeLayerId, canvas, 'color-32bit');
    } else {
      globalTileGrid.clearLayer(activeLayerId);
    }
    globalTileGrid.notifyChange(true);
    updateLayerThumbnail(activeLayerId);
  }, [activeLayerId, updateLayerThumbnail]);

  // Reset layers to a fresh canvas with specified background color
  const resetToNewCanvas = useCallback(
    (_dims: CanvasDimensions, backgroundColor: string = '#ffffff', _mode: CanvasColorMode = 'color', defaultToneFrequency: number = 60) => {
      defaultToneFrequencyRef.current = Math.max(20, Math.min(85, Math.round(defaultToneFrequency || 60)));
      for (const oldId of Array.from(layerCanvasesRef.current.keys())) {
        globalTileGrid.clearLayer(oldId);
      }
      for (const l of layersRef.current) {
        globalTileGrid.clearLayer(l.id);
      }
      pendingCanvasCopiesRef.current.clear();
      pendingInitialDataRef.current.clear();
      layerCanvasesRef.current.clear();
      layerSourceCanvasesRef.current.clear();

      const bgId = `layer-bg-${Date.now()}`;
      const topId = `layer-1-${Date.now()}`;

      if (backgroundColor !== 'transparent') {
        pendingInitialDataRef.current.set(bgId, backgroundColor);
      }

      const initialLayers: LayerItem[] = [
        {
          id: topId,
          name: 'Layer 1',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          parentId: null,
          thumbnailUrl: '',
          toneFrequency: defaultToneFrequencyRef.current,
          expressionColor: _mode === 'monochrome' ? 'monochrome' : _mode === 'grayscale' ? 'gray' : 'color',
          monoThreshold: 128,
          monoExpressBlack: true,
          monoExpressWhite: true,
        },
        {
          id: bgId,
          name: 'Background',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: true,
          parentId: null,
          thumbnailUrl: '',
        },
      ];

      setLayers(initialLayers);
      setActiveLayerId(topId);
      return { layers: initialLayers, activeLayerId: topId };
    },
    [setActiveLayerId]
  );

  // Clear all layers and canvas references when no document is active
  const clearDocument = useCallback(() => {
    for (const oldId of Array.from(layerCanvasesRef.current.keys())) {
      globalTileGrid.clearLayer(oldId);
    }
    for (const l of layersRef.current) {
      globalTileGrid.clearLayer(l.id);
    }
    pendingCanvasCopiesRef.current.clear();
    pendingInitialDataRef.current.clear();
    layerCanvasesRef.current.clear();
    layerSourceCanvasesRef.current.clear();
    setLayers([]);
    setActiveLayerId('');
    globalTileGrid.notifyChange(true);
  }, [setActiveLayerId]);

  // Load an entire document (from PSD, CSP, or Image)
  const loadDocument = useCallback((doc: LoadedDocument) => {
    for (const oldId of Array.from(layerCanvasesRef.current.keys())) {
      globalTileGrid.clearLayer(oldId);
    }
    for (const l of layersRef.current) {
      globalTileGrid.clearLayer(l.id);
    }
    pendingCanvasCopiesRef.current.clear();
    pendingInitialDataRef.current.clear();
    layerCanvasesRef.current.clear();
    layerSourceCanvasesRef.current.clear();

    if (doc.layerCanvases) {
      doc.layerCanvases.forEach((c, id) => {
        layerCanvasesRef.current.set(id, c);
        pendingInitialDataRef.current.set(id, c);
        const layerMeta = doc.layers.find((l) => l.id === id);
        const isMono = layerMeta?.expressionColor === 'monochrome';
        globalTileGrid.ingestCanvas(id, c, isMono ? 'monochrome-1bit' : 'color-32bit');
        if (
          layerMeta &&
          (layerMeta.toneEnabled ||
            layerMeta.layerColorEnabled ||
            (layerMeta.expressionColor && layerMeta.expressionColor !== 'color'))
        ) {
          const sClone = document.createElement('canvas');
          sClone.width = c.width;
          sClone.height = c.height;
          get2DContext(sClone)?.drawImage(c, 0, 0);
          layerSourceCanvasesRef.current.set(id, sClone);
        }
      });
    }

    setLayers(doc.layers);
    const topRaster = doc.layers.find((l) => l.type === 'raster');
    setActiveLayerId(topRaster ? topRaster.id : doc.layers[0]?.id || '');
    globalTileGrid.notifyChange(true);
  }, [setActiveLayerId]);

  // Internal Layer Clipboard
  const layerClipboardRef = useRef<{
    name: string;
    type: LayerItem['type'];
    blendMode: BlendMode;
    opacity: number;
    canvas: HTMLCanvasElement;
  } | null>(null);

  // Paste a canvas as a new raster layer
  const pasteLayerFromCanvas = useCallback(
    (
      sourceCanvas: HTMLCanvasElement,
      layerName: string = 'Pasted Layer',
      blendMode: BlendMode = 'normal',
      opacity: number = 1,
      customId?: string,
      layerOverrides?: Partial<LayerItem>
    ) => {
      const newId = customId || `raster-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

      // Clone offscreen canvas so modifications won't mutate source
      const clone = document.createElement('canvas');
      clone.width = sourceCanvas.width;
      clone.height = sourceCanvas.height;
      get2DContext(clone)?.drawImage(sourceCanvas, 0, 0);

      pendingInitialDataRef.current.set(newId, clone);
      const thumb = createCanvasThumbnail(clone, true);

      setLayers((prev) => {
        const activeIdx = prev.findIndex((l) => l.id === activeLayerId);
        const activeItem = prev[activeIdx];
        const defaultParentId = activeItem?.type === 'folder' ? activeItem.id : (activeItem?.parentId || null);

        const newLayer: LayerItem = {
          id: newId,
          name: layerName,
          type: layerOverrides?.type || 'raster',
          visible: true,
          opacity,
          blendMode,
          locked: false,
          collapsed: false,
          parentId: layerOverrides?.parentId !== undefined ? layerOverrides.parentId : defaultParentId,
          thumbnailUrl: thumb,
          ...layerOverrides,
        };

        const insertIdx = activeIdx >= 0 ? activeIdx : 0;
        const nextLayers = [...prev];
        nextLayers.splice(insertIdx, 0, newLayer);
        return nextLayers;
      });

      setActiveLayerId(newId);
      return newId;
    },
    [activeLayerId]
  );

  // Fill selection with non-destructive Clip Studio Paint screentone layer
  const fillScreentoneSelection = useCallback(
    (
      selection: CanvasSelection | null,
      density: number = 40,
      frequency: number = defaultToneFrequencyRef.current ?? 60,
      angle: number = 45,
      dotShape: HalftoneDotShape = 'circle',
      densityType: 'specified' | 'image' = 'specified'
    ): { id: string; canvas: HTMLCanvasElement; sourceCanvas: HTMLCanvasElement } => {
      const resolvedFreq = frequency || defaultToneFrequencyRef.current || 60;
      const resolvedDensity = Math.max(1, Math.min(100, Math.round(density <= 1.0 && density > 0 ? density * 100 : density)));
      const newId = `raster-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const targetW = _dimensions.width;
      const targetH = _dimensions.height;

      // 1. Offscreen source canvas with continuous mask/tone
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = targetW;
      sourceCanvas.height = targetH;
      const sCtx = get2DContext(sourceCanvas);
      if (sCtx) {
        sCtx.save();
        // In "specified" mode, solid black ink acts as the mask
        // In "image" mode, grayscale value corresponds to density
        const grayVal = densityType === 'specified' ? 0 : Math.round(255 * (1 - resolvedDensity / 100));
        sCtx.fillStyle = `rgb(${grayVal},${grayVal},${grayVal})`;

        if (selection) {
          if (selection.mask) {
            const imgData = sCtx.createImageData(targetW, targetH);
            const d = imgData.data;
            const m = selection.mask;
            const len = Math.min(m.length, targetW * targetH);
            for (let i = 0; i < len; i++) {
              const a = m[i];
              if (a > 0) {
                const p = i * 4;
                d[p] = grayVal;
                d[p + 1] = grayVal;
                d[p + 2] = grayVal;
                d[p + 3] = a;
              }
            }
            sCtx.putImageData(imgData, 0, 0);
          } else if (selection.type === 'rect') {
            sCtx.fillRect(
              selection.bounds.x,
              selection.bounds.y,
              selection.bounds.width,
              selection.bounds.height
            );
          } else if (selection.type === 'lasso' && selection.polygon && selection.polygon.length >= 3) {
            sCtx.beginPath();
            sCtx.moveTo(selection.polygon[0].x, selection.polygon[0].y);
            for (let i = 1; i < selection.polygon.length; i++) {
              sCtx.lineTo(selection.polygon[i].x, selection.polygon[i].y);
            }
            sCtx.closePath();
            sCtx.fill();
          }
        } else {
          // If no active selection, fill full canvas
          sCtx.fillRect(0, 0, targetW, targetH);
        }
        sCtx.restore();
      }

      // 2. Offscreen display canvas with rendered screentone dots
      const displayCanvas = document.createElement('canvas');
      displayCanvas.width = targetW;
      displayCanvas.height = targetH;

      const newLayer: LayerItem = {
        id: newId,
        name: 'Screen Tone',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        collapsed: false,
        parentId: null,
        thumbnailUrl: '',
        toneEnabled: true,
        toneFrequency: resolvedFreq,
        toneAngle: angle,
        toneDotShape: dotShape,
        toneDensity: resolvedDensity,
        toneDensityType: densityType,
      };

      globalTileGrid.ingestCanvas(newId, sourceCanvas, 'color-32bit');
      applyLayerEffects(sourceCanvas, displayCanvas, newLayer, _dimensions.dpi ?? 600, selection ? selection.bounds : undefined);

      const thumb = createCanvasThumbnail(displayCanvas, true);
      newLayer.thumbnailUrl = thumb;

      // Register both offscreen canvases synchronously
      layerSourceCanvasesRef.current.set(newId, sourceCanvas);
      pendingInitialDataRef.current.set(newId, displayCanvas);

      setLayers((prev) => {
        const activeIdx = prev.findIndex((l) => l.id === activeLayerId);
        const activeItem = prev[activeIdx];
        const parentId = activeItem?.type === 'folder' ? activeItem.id : (activeItem?.parentId || null);
        newLayer.parentId = parentId;

        let name = 'Screen Tone';
        let count = 1;
        prev.forEach((l) => {
          if (l.name.startsWith('Screen Tone')) {
            const num = parseInt(l.name.replace('Screen Tone', '').trim(), 10);
            if (!isNaN(num) && num >= count) {
              count = num + 1;
            } else if (num === 1 || count === 1) {
              count = Math.max(count, 2);
            }
          }
        });
        if (count > 1) {
          name = `Screen Tone ${count}`;
        }
        newLayer.name = name;

        const insertIdx = activeIdx >= 0 ? activeIdx : 0;
        let nextLayers = [...prev];
        nextLayers.splice(insertIdx, 0, newLayer);

        const hasBg = prev.some((l) => l.id.startsWith('layer-bg') || l.name.toLowerCase() === 'background');
        if (!hasBg) {
          const bgId = `layer-bg-${Date.now()}`;
          pendingInitialDataRef.current.set(bgId, '#ffffff');
          const bgLayer: LayerItem = {
            id: bgId,
            name: 'Background',
            type: 'raster',
            visible: true,
            opacity: 1,
            blendMode: 'normal',
            locked: true,
            parentId: null,
            thumbnailUrl: '',
          };
          nextLayers = [...nextLayers, bgLayer];
        }

        return nextLayers;
      });

      setActiveLayerId(newId);
      return { id: newId, canvas: displayCanvas, sourceCanvas };
    },
    [_dimensions, activeLayerId]
  );

  // Copy selected layer (internal clipboard & system clipboard)
  const copyLayer = useCallback(
    (targetId?: string): LayerItem | null => {
      const id = targetId || activeLayerId;
      const targetLayer = layers.find((l) => l.id === id);
      if (!targetLayer) return null;

      const canvas = layerCanvasesRef.current.get(id);
      if (!canvas) return null;

      const clone = document.createElement('canvas');
      clone.width = canvas.width;
      clone.height = canvas.height;
      get2DContext(clone)?.drawImage(canvas, 0, 0);

      layerClipboardRef.current = {
        name: targetLayer.name,
        type: targetLayer.type,
        blendMode: targetLayer.blendMode,
        opacity: targetLayer.opacity,
        canvas: clone,
      };

      // Try copying to system clipboard
      try {
        clone.toBlob((blob) => {
          if (blob && navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {});
          }
        });
      } catch (err) {
        // Ignore clipboard write restrictions
      }

      return targetLayer;
    },
    [activeLayerId, layers]
  );

  // Paste layer from internal or system clipboard
  const pasteLayer = useCallback(async (): Promise<{ success: boolean; layerName?: string }> => {
    // 1. Check internal clipboard
    if (layerClipboardRef.current) {
      const data = layerClipboardRef.current;
      const newName = `${data.name} Copy`;
      pasteLayerFromCanvas(data.canvas, newName, data.blendMode, data.opacity);
      return { success: true, layerName: newName };
    }

    // 2. Check system clipboard
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith('image/'));
          if (imageType) {
            const blob = await item.getType(imageType);
            const img = new Image();
            const url = URL.createObjectURL(blob);
            await new Promise<void>((resolve, reject) => {
              img.onload = () => resolve();
              img.onerror = reject;
              img.src = url;
            });

            const offscreen = document.createElement('canvas');
            offscreen.width = _dimensions.width;
            offscreen.height = _dimensions.height;
            const ctx = offscreen.getContext('2d');
            if (ctx) {
              const scale = Math.min(1, Math.min(_dimensions.width / img.naturalWidth, _dimensions.height / img.naturalHeight));
              const dw = Math.round(img.naturalWidth * scale);
              const dh = Math.round(img.naturalHeight * scale);
              const dx = Math.round((_dimensions.width - dw) / 2);
              const dy = Math.round((_dimensions.height - dh) / 2);
              ctx.drawImage(img, dx, dy, dw, dh);
            }
            URL.revokeObjectURL(url);

            const newName = 'Pasted Image';
            pasteLayerFromCanvas(offscreen, newName);
            return { success: true, layerName: newName };
          }
        }
      }
    } catch (err) {
      console.warn('System clipboard read failed:', err);
    }

    return { success: false };
  }, [_dimensions, pasteLayerFromCanvas]);

  // Paste a photo from file
  const pasteLayerFromFile = useCallback(
    async (file: File): Promise<string> => {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            const offscreen = document.createElement('canvas');
            offscreen.width = _dimensions.width;
            offscreen.height = _dimensions.height;
            const ctx = offscreen.getContext('2d');
            if (ctx) {
              const scale = Math.min(1, Math.min(_dimensions.width / img.naturalWidth, _dimensions.height / img.naturalHeight));
              const dw = Math.round(img.naturalWidth * scale);
              const dh = Math.round(img.naturalHeight * scale);
              const dx = Math.round((_dimensions.width - dw) / 2);
              const dy = Math.round((_dimensions.height - dh) / 2);
              ctx.drawImage(img, dx, dy, dw, dh);
            }

            const layerName = file.name.replace(/\.[^/.]+$/, '') || 'Pasted Image';
            pasteLayerFromCanvas(offscreen, layerName);
            resolve(layerName);
          };
          img.onerror = () => reject(new Error('Failed to decode image file.'));
          img.src = e.target?.result as string;
        };
        reader.onerror = () => reject(new Error('Failed to read file.'));
        reader.readAsDataURL(file);
      });
    },
    [_dimensions, pasteLayerFromCanvas]
  );

  // Resize canvas dimensions (content scaling or anchor expansion/crop)
  const resizeCanvas = useCallback(
    (
      newDims: CanvasDimensions,
      options: ResizeCanvasOptions = { width: newDims.width, height: newDims.height }
    ) => {
      const {
        scaleContent = false,
        anchor = 'center',
        backgroundColor = '#ffffff',
      } = options;

      const currentW = _dimensions.width;
      const currentH = _dimensions.height;
      const newW = newDims.width;
      const newH = newDims.height;

      // Calculate anchor offsets
      let offsetX = 0;
      let offsetY = 0;

      if (!scaleContent) {
        if (anchor === 'top-left' || anchor === 'left' || anchor === 'bottom-left') {
          offsetX = 0;
        } else if (anchor === 'top-right' || anchor === 'right' || anchor === 'bottom-right') {
          offsetX = newW - currentW;
        } else {
          offsetX = Math.round((newW - currentW) / 2);
        }

        if (anchor === 'top-left' || anchor === 'top' || anchor === 'top-right') {
          offsetY = 0;
        } else if (anchor === 'bottom-left' || anchor === 'bottom' || anchor === 'bottom-right') {
          offsetY = newH - currentH;
        } else {
          offsetY = Math.round((newH - currentH) / 2);
        }
      }

      const updatedThumbnails = new Map<string, string>();

      layerCanvasesRef.current.forEach((canvas, layerId) => {
        // Clone old contents
        const temp = document.createElement('canvas');
        temp.width = canvas.width;
        temp.height = canvas.height;
        const tempCtx = get2DContext(temp);
        tempCtx?.drawImage(canvas, 0, 0);

        // Resize actual canvas DOM element
        canvas.width = newW;
        canvas.height = newH;
        const ctx = get2DContext(canvas);
        if (!ctx) return;

        ctx.clearRect(0, 0, newW, newH);

        const isBg = layerId === 'layer-bg' || layerId.startsWith('layer-bg');
        if (isBg && backgroundColor !== 'transparent') {
          ctx.fillStyle = backgroundColor;
          ctx.fillRect(0, 0, newW, newH);
        }

        if (scaleContent) {
          ctx.drawImage(temp, 0, 0, temp.width, temp.height, 0, 0, newW, newH);
        } else {
          ctx.drawImage(temp, offsetX, offsetY);
        }

        const thumb = createCanvasThumbnail(canvas, !isBg);
        updatedThumbnails.set(layerId, thumb);
      });

      // Resize offscreen source canvases
      layerSourceCanvasesRef.current.forEach((sCanvas, layerId) => {
        const temp = document.createElement('canvas');
        temp.width = sCanvas.width;
        temp.height = sCanvas.height;
        get2DContext(temp)?.drawImage(sCanvas, 0, 0);

        sCanvas.width = newW;
        sCanvas.height = newH;
        const sCtx = get2DContext(sCanvas);
        if (!sCtx) return;
        sCtx.clearRect(0, 0, newW, newH);

        const isBg = layerId === 'layer-bg' || layerId.startsWith('layer-bg');
        if (isBg && backgroundColor !== 'transparent') {
          sCtx.fillStyle = backgroundColor;
          sCtx.fillRect(0, 0, newW, newH);
        }

        if (scaleContent) {
          sCtx.drawImage(temp, 0, 0, temp.width, temp.height, 0, 0, newW, newH);
        } else {
          sCtx.drawImage(temp, offsetX, offsetY);
        }
      });

      // Re-apply screentone and layer effects for layers that have them enabled, and resize mask canvases
      const updatedMasks = new Map<string, { maskCanvas: HTMLCanvasElement; maskThumb: string }>();
      layers.forEach((l) => {
        if (l.maskCanvas) {
          const tempMask = document.createElement('canvas');
          tempMask.width = l.maskCanvas.width;
          tempMask.height = l.maskCanvas.height;
          get2DContext(tempMask)?.drawImage(l.maskCanvas, 0, 0);

          l.maskCanvas.width = newW;
          l.maskCanvas.height = newH;
          const mCtx = get2DContext(l.maskCanvas);
          if (mCtx) {
            mCtx.fillStyle = '#ffffff';
            mCtx.fillRect(0, 0, newW, newH);
            if (scaleContent) {
              mCtx.drawImage(tempMask, 0, 0, tempMask.width, tempMask.height, 0, 0, newW, newH);
            } else {
              mCtx.drawImage(tempMask, offsetX, offsetY);
            }
          }
          updatedMasks.set(l.id, {
            maskCanvas: l.maskCanvas,
            maskThumb: createCanvasThumbnail(l.maskCanvas, false),
          });
        }

        if (l.toneEnabled || l.layerColorEnabled || (l.expressionColor && l.expressionColor !== 'color')) {
          const sCanvas = layerSourceCanvasesRef.current.get(l.id);
          const dCanvas = layerCanvasesRef.current.get(l.id);
          if (sCanvas && dCanvas) {
            applyLayerEffects(sCanvas, dCanvas, l, newDims.dpi ?? _dimensions.dpi ?? 600);
            const thumb = createCanvasThumbnail(dCanvas, true);
            updatedThumbnails.set(l.id, thumb);
          }
        }
      });

      // Re-ingest all resized canvases into globalTileGrid
      layerCanvasesRef.current.forEach((canvas, layerId) => {
        const l = layers.find((item) => item.id === layerId);
        const isMono = l?.expressionColor === 'monochrome';
        globalTileGrid.clearLayer(layerId);
        globalTileGrid.ingestCanvas(layerId, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
      });
      globalTileGrid.notifyChange(true);

      setLayers((prev) =>
        prev.map((l) => {
          const newThumb = updatedThumbnails.get(l.id);
          const maskInfo = updatedMasks.get(l.id);
          if (!newThumb && !maskInfo) return l;
          return {
            ...l,
            ...(newThumb ? { thumbnailUrl: newThumb } : {}),
            ...(maskInfo
              ? {
                  maskCanvas: maskInfo.maskCanvas,
                  maskThumbnailUrl: maskInfo.maskThumb,
                  maskVersion: (l.maskVersion || 0) + 1,
                }
              : {}),
          };
        })
      );
    },
    [_dimensions, layers]
  );

  // Get active layer object
  const activeLayer = layers.find((l) => l.id === activeLayerId) || layers[0];

  // Update Layer Styles (Stroke, Drop Shadow, Outer Glow)
  const updateLayerStyles = useCallback((id: string, styles: LayerStyles) => {
    setLayers((prev) => {
      const target = prev.find((l) => l.id === id);
      if (!target || target.type === 'folder') return prev;
      return prev.map((l) => (l.id === id ? { ...l, styles } : l));
    });
  }, []);

  return {
    layers,
    setLayers,
    activeLayerId,
    setActiveLayerId,
    selectedLayerIds,
    setSelectedLayerIds,
    toggleLayerSelection,
    deleteSelectedLayers,
    groupSelectedLayers,
    moveSelectedLayers,
    activeLayer,
    layerCanvasesRef,
    layerSourceCanvasesRef,
    ensureSourceCanvas,
    toggleTone,
    setToneFrequency,
    setToneAngle,
    setToneDotShape,
    setToneDensity,
    setToneDensityType,
    toggleLayerColor,
    setLayerColor,
    setLayerSubColor,
    setLayerExpressionColor,
    setLayerMonoThreshold,
    setLayerMonoExpressMode,
    applyExpressionColorOfPreview,
    applyLayerColorPermanently,
    convertLayer,
    registerLayerCanvas,
    updateLayerThumbnail,
    addLayer,
    addRemoteLayer,
    deleteRemoteLayer,
    syncRemoteDocument,
    duplicateLayer,
    deleteLayer,
    copyLayer,
    pasteLayer,
    pasteLayerFromCanvas,
    fillScreentoneSelection,
    pasteLayerFromFile,
    resizeCanvas,
    toggleVisibility,
    setOpacity,
    setBlendMode,
    toggleLock,
    toggleAlphaLock,
    toggleClipping,
    toggleCollapse,
    renameLayer,
    moveLayer,
    moveLayerToFolder,
    reorderLayers,
    getEffectiveOpacity,
    isLayerEffectivelyVisible,
    clearActiveLayer,
    resetToNewCanvas,
    setDefaultToneFrequency: (freq: number) => {
      defaultToneFrequencyRef.current = Math.max(20, Math.min(85, Math.round(freq || 60)));
    },
    clearDocument,
    loadDocument,
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

