import { useCallback } from 'react';
import {
  LayerItem,
  LayerType,
  isFolderLikeLayer,
  hasTileBackedLayer,
} from '../../types/editor';
import { get2DContext } from '../../utils/canvasUtils';
import { releaseTemporaryCanvas } from '../../utils/tileEngine';
import {
  computeBatchDeleteLayers,
  computeBatchReorderLayers,
  computeGroupLayers,
} from './layerTreeOps';
import { LayerManagerContext } from './types';

export function useLayerCrud(ctx: LayerManagerContext) {
  const {
    activeTileGridRef,
    thumbDebounceTimersRef,
    layers,
    setLayers,
    layersRef,
    setActiveLayerId,
    activeLayerIdRef,
    setSelectedLayerIds,
    selectedLayerIdsRef,
  } = ctx;

  // Add a new raster layer, folder, frame-folder, text, balloon, or adjustment layer
  const addLayer = useCallback(
    (
      type: LayerType = 'raster',
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
        initialParentId = isFolderLikeLayer(currentActiveLayer) ? currentActiveLayer.id : currentActiveLayer.parentId;
      }

      const resolveLayerName = (list: LayerItem[]) => {
        if (customName) return customName;
        let count = 1;
        const prefix =
          type === 'folder' ? 'Folder ' :
          type === 'frame-folder' ? 'Frame ' :
          type === 'vector' ? 'Vector ' :
          type === 'frame' ? 'Frame ' :
          type === 'text' ? 'Text ' :
          type === 'balloon' ? 'Balloon ' :
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
          parentId = isFolderLikeLayer(activeLayer) ? activeLayer.id : activeLayer.parentId;
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

      if (hasTileBackedLayer({ type })) {
        const grid = activeTileGridRef.current;
        const isMono = createdLayer.expressionColor === 'monochrome';
        grid.setLayerFormat(id, isMono ? 'monochrome-1bit' : 'color-32bit');
        grid.markLayerIngested(id);
      }

      if (selectNewLayer) {
        setActiveLayerId(id);
      }
      return createdLayer;
    },
    [activeLayerIdRef, activeTileGridRef, layersRef, setActiveLayerId, setLayers]
  );

  // Duplicate an existing layer or folder hierarchy with a single click
  const duplicateLayer = useCallback((id: string) => {
    setLayers((prev) => {
      const sourceIdx = prev.findIndex((l) => l.id === id);
      if (sourceIdx < 0) return prev;
      const grid = activeTileGridRef.current;

      const cloneSingleLayer = (source: LayerItem, newParentId: string | null, nameSuffix: string = ' Copy'): LayerItem => {
        const newId = `${source.type}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

        if (hasTileBackedLayer(source)) {
          grid.cloneLayer(source.id, newId);
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
          textData: source.textData ? JSON.parse(JSON.stringify(source.textData)) : undefined,
          balloonData: source.balloonData ? JSON.parse(JSON.stringify(source.balloonData)) : undefined,
          balloons: source.balloons ? JSON.parse(JSON.stringify(source.balloons)) : undefined,
          adjustmentData: source.adjustmentData ? JSON.parse(JSON.stringify(source.adjustmentData)) : undefined,
          styles: source.styles ? JSON.parse(JSON.stringify(source.styles)) : undefined,
        };
      };

      const source = prev[sourceIdx];
      if (!isFolderLikeLayer(source)) {
        const newLayer = cloneSingleLayer(source, source.parentId, ' Copy');
        const nextLayers = [...prev];
        nextLayers.splice(sourceIdx, 0, newLayer);
        setActiveLayerId(newLayer.id);
        return nextLayers;
      }

      // Recursively duplicate folder or frame-folder and all nested descendants in stack order
      const clonedItems: LayerItem[] = [];
      const cloneFolderSubtree = (folder: LayerItem, targetParentId: string | null, isRootFolder: boolean) => {
        const folderCopy = cloneSingleLayer(folder, targetParentId, isRootFolder ? ' Copy' : '');
        clonedItems.push(folderCopy);
        const directChildren = prev.filter((l) => l.parentId === folder.id);
        for (const child of directChildren) {
          if (isFolderLikeLayer(child)) {
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
  }, [activeTileGridRef, setActiveLayerId, setLayers]);

  // Delete a layer or folder (including nested folder hierarchies)
  const deleteLayer = useCallback((id: string) => {
    setLayers((prev) => {
      const res = computeBatchDeleteLayers(prev, [id], activeLayerIdRef.current);
      if (res.deletedIds.length === 0) return prev;
      const grid = activeTileGridRef.current;

      for (const delId of res.deletedIds) {
        const timer = thumbDebounceTimersRef.current.get(delId);
        if (timer) {
          clearTimeout(timer);
          thumbDebounceTimersRef.current.delete(delId);
        }

        const deletedLayer = prev.find((l) => l.id === delId);
        if (deletedLayer?.maskCanvas) {
          releaseTemporaryCanvas(deletedLayer.maskCanvas);
        }

        grid.clearLayer(delId);
      }

      if (res.deletedIds.includes(activeLayerIdRef.current)) {
        setActiveLayerId(res.nextActiveId);
      } else {
        setSelectedLayerIds((prevSelected) => prevSelected.filter((sid) => !res.deletedIds.includes(sid)));
      }
      return res.nextLayers;
    });
  }, [activeLayerIdRef, activeTileGridRef, setActiveLayerId, setLayers, setSelectedLayerIds, thumbDebounceTimersRef]);

  // Delete all selected layers or folders
  const deleteSelectedLayers = useCallback(() => {
    setLayers((prev) => {
      const res = computeBatchDeleteLayers(prev, selectedLayerIdsRef.current, activeLayerIdRef.current);
      if (res.deletedIds.length === 0) return prev;
      const grid = activeTileGridRef.current;

      for (const delId of res.deletedIds) {
        const timer = thumbDebounceTimersRef.current.get(delId);
        if (timer) {
          clearTimeout(timer);
          thumbDebounceTimersRef.current.delete(delId);
        }

        const deletedLayer = prev.find((l) => l.id === delId);
        if (deletedLayer?.maskCanvas) {
          releaseTemporaryCanvas(deletedLayer.maskCanvas);
        }

        grid.clearLayer(delId);
      }

      setActiveLayerId(res.nextActiveId);
      return res.nextLayers;
    });
  }, [activeLayerIdRef, activeTileGridRef, selectedLayerIdsRef, setActiveLayerId, setLayers, thumbDebounceTimersRef]);

  // Group all currently selected layers into a new folder
  const groupSelectedLayers = useCallback(() => {
    setLayers((prev) => {
      const res = computeGroupLayers(prev, selectedLayerIdsRef.current, activeLayerIdRef.current);
      if (!res) return prev;

      setActiveLayerId(res.newFolder.id);
      return res.nextLayers;
    });
  }, [activeLayerIdRef, selectedLayerIdsRef, setActiveLayerId, setLayers]);

  // Rename a layer
  const renameLayer = useCallback((id: string, newName: string) => {
    if (!newName.trim()) return;
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, name: newName.trim() } : l))
    );
  }, [setLayers]);

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
  }, [setLayers]);

  // Move layer into a specific folder or to root
  const moveLayerToFolder = useCallback((id: string, targetFolderId: string | null) => {
    setLayers((prev) => {
      const item = prev.find((l) => l.id === id);
      if (!item || item.id === targetFolderId) return prev;

      // If moving a folder into itself, ignore
      if (isFolderLikeLayer(item) && targetFolderId) {
        let curr: LayerItem | undefined = prev.find((l) => l.id === targetFolderId);
        while (curr) {
          if (curr.id === id) return prev;
          curr = prev.find((l) => l.id === curr?.parentId);
        }
      }

      return prev.map((l) => (l.id === id ? { ...l, parentId: targetFolderId } : l));
    });
  }, [setLayers]);

  // Reorder layer via drag-and-drop (supports multi-layer selection)
  const reorderLayers = useCallback((draggedId: string, targetId: string, position: 'above' | 'below' | 'inside') => {
    setLayers((prev) => computeBatchReorderLayers(prev, selectedLayerIdsRef.current, draggedId, targetId, position));
  }, [selectedLayerIdsRef, setLayers]);

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
        if (isFolderLikeLayer(item)) {
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
  }, [activeLayerIdRef, selectedLayerIdsRef, setLayers]);

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

  return {
    addLayer,
    duplicateLayer,
    deleteLayer,
    deleteSelectedLayers,
    groupSelectedLayers,
    renameLayer,
    moveLayer,
    moveLayerToFolder,
    reorderLayers,
    moveSelectedLayers,
    getEffectiveOpacity,
    isLayerEffectivelyVisible,
  };
}
