import { useCallback } from 'react';
import {
  LayerItem,
  LayerType,
  TileDelta,
  isFolderLikeLayer,
  hasTileBackedLayer,
} from '../../types/editor';
import { get2DContext } from '../../utils/canvasUtils';
import {
  computeBatchDeleteLayers,
  computeBatchReorderLayers,
  computeGroupLayers,
  createLayerTreeSnapshotDelta,
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
    recordLayerHistory,
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
      const beforeLayers = layersRef.current;
      const beforeActiveLayerId = activeLayerIdRef.current;
      const currentActiveIdx = beforeLayers.findIndex((l) => l.id === beforeActiveLayerId);
      const currentActiveLayer = beforeLayers[currentActiveIdx];

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
        name: resolveLayerName(beforeLayers),
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

      let nextLayers = beforeLayers;
      if (!beforeLayers.some((l) => l.id === id)) {
        const insertIndex = currentActiveIdx >= 0 ? currentActiveIdx : 0;
        nextLayers = [...beforeLayers];
        nextLayers.splice(insertIndex, 0, createdLayer);
        layersRef.current = nextLayers;
        setLayers(nextLayers);
      }

      if (hasTileBackedLayer({ type })) {
        const grid = activeTileGridRef.current;
        const isMono = createdLayer.expressionColor === 'monochrome';
        grid.setLayerFormat(id, isMono ? 'monochrome-1bit' : 'color-32bit');
        grid.markLayerIngested(id);
      }

      const afterActiveId = selectNewLayer ? id : beforeActiveLayerId;
      if (selectNewLayer) {
        setActiveLayerId(id);
      }

      if (nextLayers !== beforeLayers) {
        const label =
          type === 'folder' ? 'Add Folder' :
          type === 'vector' ? 'Add Vector Layer' :
          type === 'frame-folder' ? 'Add Frame Folder' :
          'Add Layer';
        recordLayerHistory(
          label,
          id,
          createLayerTreeSnapshotDelta(beforeLayers, nextLayers, beforeActiveLayerId, afterActiveId),
          undefined,
          'layer'
        );
      }

      return createdLayer;
    },
    [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setActiveLayerId, setLayers]
  );

  // Duplicate an existing layer or folder hierarchy with a single click
  const duplicateLayer = useCallback((id: string) => {
    const prev = layersRef.current;
    const beforeActiveLayerId = activeLayerIdRef.current;
    const sourceIdx = prev.findIndex((l) => l.id === id);
    if (sourceIdx < 0) return;
    const grid = activeTileGridRef.current;
    const allTileDeltas: TileDelta[] = [];

    const cloneSingleLayer = (source: LayerItem, newParentId: string | null, nameSuffix: string = ' Copy'): LayerItem => {
      const newId = `${source.type}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

      if (hasTileBackedLayer(source)) {
        grid.cloneLayer(source.id, newId);
        const clonedTiles = grid.getLayerTiles(newId, 0);
        for (const t of clonedTiles) {
          if (t.data) {
            allTileDeltas.push({
              key: `${newId}:${t.tileX}:${t.tileY}`,
              format: t.format,
              beforeData: null,
              afterData: new Uint8Array(t.data),
            });
          }
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
        textData: source.textData ? JSON.parse(JSON.stringify(source.textData)) : undefined,
        balloonData: source.balloonData ? JSON.parse(JSON.stringify(source.balloonData)) : undefined,
        balloons: source.balloons ? JSON.parse(JSON.stringify(source.balloons)) : undefined,
        adjustmentData: source.adjustmentData ? JSON.parse(JSON.stringify(source.adjustmentData)) : undefined,
        styles: source.styles ? JSON.parse(JSON.stringify(source.styles)) : undefined,
      };
    };

    const source = prev[sourceIdx];
    let nextLayers: LayerItem[];
    let nextActiveId = beforeActiveLayerId;

    if (!isFolderLikeLayer(source)) {
      const newLayer = cloneSingleLayer(source, source.parentId, ' Copy');
      nextLayers = [...prev];
      nextLayers.splice(sourceIdx, 0, newLayer);
      nextActiveId = newLayer.id;
    } else {
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
      nextLayers = [...prev];
      nextLayers.splice(sourceIdx, 0, ...clonedItems);
      if (clonedItems[0]) {
        nextActiveId = clonedItems[0].id;
      }
    }

    layersRef.current = nextLayers;
    setLayers(nextLayers);
    setActiveLayerId(nextActiveId);
    grid.notifyChange(true);
    recordLayerHistory(
      'Duplicate Layer',
      nextActiveId,
      createLayerTreeSnapshotDelta(prev, nextLayers, beforeActiveLayerId, nextActiveId),
      allTileDeltas,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setActiveLayerId, setLayers]);

  // Delete a layer or folder (including nested folder hierarchies)
  const deleteLayer = useCallback((id: string) => {
    const prev = layersRef.current;
    const beforeActiveLayerId = activeLayerIdRef.current;
    const res = computeBatchDeleteLayers(prev, [id], beforeActiveLayerId);
    if (res.deletedIds.length === 0) return;

    const grid = activeTileGridRef.current;
    const deletedTileDeltas: TileDelta[] = [];

    for (const delId of res.deletedIds) {
      const timer = thumbDebounceTimersRef.current.get(delId);
      if (timer) {
        clearTimeout(timer);
        thumbDebounceTimersRef.current.delete(delId);
      }

      const tiles = grid.getLayerTiles(delId, 0);
      for (const t of tiles) {
        if (t.data) {
          deletedTileDeltas.push({
            key: `${delId}:${t.tileX}:${t.tileY}`,
            format: t.format,
            beforeData: new Uint8Array(t.data),
            afterData: null,
          });
        }
      }

      grid.clearLayer(delId);
    }

    layersRef.current = res.nextLayers;
    setLayers(res.nextLayers);

    let afterActiveId = beforeActiveLayerId;
    if (res.deletedIds.includes(beforeActiveLayerId)) {
      afterActiveId = res.nextActiveId;
      setActiveLayerId(res.nextActiveId);
    } else {
      setSelectedLayerIds((prevSelected) => prevSelected.filter((sid) => !res.deletedIds.includes(sid)));
    }

    recordLayerHistory(
      'Delete Layer',
      afterActiveId || id,
      createLayerTreeSnapshotDelta(prev, res.nextLayers, beforeActiveLayerId, afterActiveId, {
        cloneMasks: true,
      }),
      deletedTileDeltas,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setActiveLayerId, setLayers, setSelectedLayerIds, thumbDebounceTimersRef]);

  // Delete all selected layers or folders
  const deleteSelectedLayers = useCallback(() => {
    const prev = layersRef.current;
    const beforeActiveLayerId = activeLayerIdRef.current;
    const res = computeBatchDeleteLayers(prev, selectedLayerIdsRef.current, beforeActiveLayerId);
    if (res.deletedIds.length === 0) return;

    const grid = activeTileGridRef.current;
    const deletedTileDeltas: TileDelta[] = [];

    for (const delId of res.deletedIds) {
      const timer = thumbDebounceTimersRef.current.get(delId);
      if (timer) {
        clearTimeout(timer);
        thumbDebounceTimersRef.current.delete(delId);
      }

      const tiles = grid.getLayerTiles(delId, 0);
      for (const t of tiles) {
        if (t.data) {
          deletedTileDeltas.push({
            key: `${delId}:${t.tileX}:${t.tileY}`,
            format: t.format,
            beforeData: new Uint8Array(t.data),
            afterData: null,
          });
        }
      }

      grid.clearLayer(delId);
    }

    layersRef.current = res.nextLayers;
    setLayers(res.nextLayers);
    setActiveLayerId(res.nextActiveId);

    recordLayerHistory(
      res.deletedIds.length > 1 ? `Delete ${res.deletedIds.length} Layers` : 'Delete Layer',
      res.nextActiveId || beforeActiveLayerId,
      createLayerTreeSnapshotDelta(prev, res.nextLayers, beforeActiveLayerId, res.nextActiveId, {
        cloneMasks: true,
      }),
      deletedTileDeltas,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, selectedLayerIdsRef, setActiveLayerId, setLayers, thumbDebounceTimersRef]);

  // Group all currently selected layers into a new folder
  const groupSelectedLayers = useCallback(() => {
    const prev = layersRef.current;
    const beforeActiveLayerId = activeLayerIdRef.current;
    const res = computeGroupLayers(prev, selectedLayerIdsRef.current, beforeActiveLayerId);
    if (!res) return;

    layersRef.current = res.nextLayers;
    setLayers(res.nextLayers);
    setActiveLayerId(res.newFolder.id);

    recordLayerHistory(
      'Group Layers',
      res.newFolder.id,
      createLayerTreeSnapshotDelta(prev, res.nextLayers, beforeActiveLayerId, res.newFolder.id),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, layersRef, recordLayerHistory, selectedLayerIdsRef, setActiveLayerId, setLayers]);

  // Rename a layer
  const renameLayer = useCallback((id: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const prev = layersRef.current;
    const target = prev.find((l) => l.id === id);
    if (!target || target.name === trimmed) return;

    const next = prev.map((l) => (l.id === id ? { ...l, name: trimmed } : l));
    layersRef.current = next;
    setLayers(next);
    recordLayerHistory(
      'Rename Layer',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, layersRef, recordLayerHistory, setLayers]);

  // Move layer up or down in visual stack
  const moveLayer = useCallback((id: string, direction: 'up' | 'down') => {
    const prev = layersRef.current;
    const idx = prev.findIndex((l) => l.id === id);
    if (idx < 0) return;

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= prev.length) return;

    const next = [...prev];
    const [item] = next.splice(idx, 1);
    next.splice(targetIdx, 0, item);
    layersRef.current = next;
    setLayers(next);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Reorder Layer',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Move layer into a specific folder or to root
  const moveLayerToFolder = useCallback((id: string, targetFolderId: string | null) => {
    const prev = layersRef.current;
    const item = prev.find((l) => l.id === id);
    if (!item || item.id === targetFolderId || item.parentId === targetFolderId) return;

    // If moving a folder into itself, ignore
    if (isFolderLikeLayer(item) && targetFolderId) {
      let curr: LayerItem | undefined = prev.find((l) => l.id === targetFolderId);
      while (curr) {
        if (curr.id === id) return;
        curr = prev.find((l) => l.id === curr?.parentId);
      }
    }

    const next = prev.map((l) => (l.id === id ? { ...l, parentId: targetFolderId } : l));
    layersRef.current = next;
    setLayers(next);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Move Layer to Folder',
      id,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, setLayers]);

  // Reorder layer via drag-and-drop (supports multi-layer selection)
  const reorderLayers = useCallback((draggedId: string, targetId: string, position: 'above' | 'below' | 'inside') => {
    const prev = layersRef.current;
    const next = computeBatchReorderLayers(prev, selectedLayerIdsRef.current, draggedId, targetId, position);
    if (next === prev) return;
    layersRef.current = next;
    setLayers(next);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Reorder Layers',
      draggedId,
      createLayerTreeSnapshotDelta(prev, next, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, selectedLayerIdsRef, setLayers]);

  // Move selected layers into a target parent folder or index
  const moveSelectedLayers = useCallback((targetParentId: string | null, targetIndex?: number) => {
    const prev = layersRef.current;
    const selectedIds = selectedLayerIdsRef.current.length > 0
      ? selectedLayerIdsRef.current
      : activeLayerIdRef.current ? [activeLayerIdRef.current] : [];
    if (selectedIds.length === 0) return;

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

    if (targetParentId && movingIds.has(targetParentId)) return;

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
    layersRef.current = remaining;
    setLayers(remaining);
    activeTileGridRef.current.notifyChange(true);
    recordLayerHistory(
      'Move Layers',
      activeLayerIdRef.current,
      createLayerTreeSnapshotDelta(prev, remaining, activeLayerIdRef.current, activeLayerIdRef.current),
      undefined,
      'layer'
    );
  }, [activeLayerIdRef, activeTileGridRef, layersRef, recordLayerHistory, selectedLayerIdsRef, setLayers]);

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
