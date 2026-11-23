import { useCallback } from 'react';
import {
  ComicFrame,
  FrameDivideMode,
  LayerItem,
  LayerTreeDelta,
  LayerType,
  SpeechBalloon,
  TextLayerData,
  TileDelta,
  hasTileBackedLayer,
} from '../../types/editor';
import { divideFramesInFolder, Point2D } from '../../utils/frameEngine';
import { getTileKey } from '../../utils/tileEngine';
import { syncVectorObjectLayerToGrid } from '../../utils/vectorLayerRenderer';
import {
  ApplyLayerTreeDeltaResult,
  applyLayerTreeDelta as applyLayerTreeDeltaPure,
  cloneComicFrames,
  cloneLayerItemForHistory,
  createLayerTreeSnapshotDelta,
} from './layerTreeOps';
import { LayerManagerContext } from './types';

export interface CreateFrameFolderResult {
  folder: LayerItem;
  childLayer: LayerItem | null;
  layerTreeDelta: LayerTreeDelta;
}

export interface DivideFrameFolderActionResult {
  divided: boolean;
  layerTreeDelta?: LayerTreeDelta;
  tileDeltas?: TileDelta[];
}

export function useLayerSpecialLayers(
  ctx: LayerManagerContext,
  addLayer: (
    type?: LayerType,
    explicitParentId?: string | null,
    customName?: string,
    customId?: string,
    selectNewLayer?: boolean
  ) => LayerItem,
  updateLayerThumbnail: (id: string, immediate?: boolean) => void
) {
  const {
    activeTileGridRef,
    dimensionsRef,
    thumbDebounceTimersRef,
    setLayers,
    layersRef,
    setActiveLayerId,
    activeLayerIdRef,
    suppressHistoryDepthRef,
    recordLayerHistory,
  } = ctx;

  // Create or update a non-destructive Vector Text Layer (re-renders crisply into tileGrid)
  const upsertTextLayer = useCallback(
    (textData: TextLayerData, editingLayerId?: string | null): LayerItem => {
      const grid = activeTileGridRef.current;
      const dims = dimensionsRef.current;
      const snippet = textData.text.trim().replace(/\s+/g, ' ').slice(0, 22) || 'Text';
      const beforeLayers = layersRef.current;
      const beforeActiveLayerId = activeLayerIdRef.current;

      if (editingLayerId) {
        const existing = beforeLayers.find((l) => l.id === editingLayerId);
        if (existing && existing.type === 'text') {
          const beforeTileSnap = grid.snapshotLayerTiles(editingLayerId);
          const updated: LayerItem = {
            ...existing,
            name: snippet,
            textData: { ...textData },
          };
          const nextLayers = beforeLayers.map((l) => (l.id === editingLayerId ? updated : l));
          layersRef.current = nextLayers;
          setLayers(nextLayers);
          syncVectorObjectLayerToGrid(updated, dims, grid);
          const tileDeltas = grid.computeDeltasFromSnapshot(beforeTileSnap, editingLayerId, {
            x: 0,
            y: 0,
            width: dims.width,
            height: dims.height,
          });
          for (const t of grid.getLayerTiles(editingLayerId, 0)) {
            const key = getTileKey(editingLayerId, t.tileX, t.tileY, 0);
            if (t.data && !beforeTileSnap.has(key) && !tileDeltas.some((d) => d.key === key)) {
              tileDeltas.push({ key, format: t.format, beforeData: null, afterData: new Uint8Array(t.data) });
            }
          }
          updateLayerThumbnail(editingLayerId, true);
          recordLayerHistory(
            'Edit Text Layer',
            editingLayerId,
            createLayerTreeSnapshotDelta(
              beforeLayers,
              layersRef.current,
              beforeActiveLayerId,
              activeLayerIdRef.current
            ),
            tileDeltas,
            'text'
          );
          return updated;
        }
      }

      suppressHistoryDepthRef.current += 1;
      let created: LayerItem;
      try {
        created = addLayer('text', undefined, snippet, undefined, true);
      } finally {
        suppressHistoryDepthRef.current = Math.max(0, suppressHistoryDepthRef.current - 1);
      }
      const withData: LayerItem = {
        ...created,
        textData: { ...textData },
      };
      const nextLayers = layersRef.current.map((l) =>
        l.id === created.id ? { ...l, textData: { ...textData } } : l
      );
      layersRef.current = nextLayers;
      setLayers(nextLayers);
      const beforeTileSnap = grid.snapshotLayerTiles(created.id);
      syncVectorObjectLayerToGrid(withData, dims, grid);
      const tileDeltas = grid.computeDeltasFromSnapshot(beforeTileSnap, created.id, {
        x: 0,
        y: 0,
        width: dims.width,
        height: dims.height,
      });
      updateLayerThumbnail(created.id, true);
      recordLayerHistory(
        'Add Text Layer',
        created.id,
        createLayerTreeSnapshotDelta(beforeLayers, layersRef.current, beforeActiveLayerId, created.id),
        tileDeltas,
        'text'
      );
      return withData;
    },
    [
      activeLayerIdRef,
      activeTileGridRef,
      addLayer,
      dimensionsRef,
      layersRef,
      recordLayerHistory,
      setLayers,
      suppressHistoryDepthRef,
      updateLayerThumbnail,
    ]
  );

  // Create or update a non-destructive Speech Balloon Layer (re-renders crisply into tileGrid)
  const upsertBalloonLayer = useCallback(
    (balloonData: SpeechBalloon, editingLayerId?: string | null): LayerItem => {
      const grid = activeTileGridRef.current;
      const dims = dimensionsRef.current;
      const clonedBalloon: SpeechBalloon = JSON.parse(JSON.stringify(balloonData));
      const snippet = clonedBalloon.text.trim().replace(/\s+/g, ' ').slice(0, 18);
      const label = snippet ? `Balloon: ${snippet}` : undefined;
      const beforeLayers = layersRef.current;
      const beforeActiveLayerId = activeLayerIdRef.current;

      if (editingLayerId) {
        const existing = beforeLayers.find((l) => l.id === editingLayerId);
        if (existing && existing.type === 'balloon') {
          const beforeTileSnap = grid.snapshotLayerTiles(editingLayerId);
          const updated: LayerItem = {
            ...existing,
            name: label || existing.name,
            balloonData: clonedBalloon,
          };
          const nextLayers = beforeLayers.map((l) => (l.id === editingLayerId ? updated : l));
          layersRef.current = nextLayers;
          setLayers(nextLayers);
          syncVectorObjectLayerToGrid(updated, dims, grid);
          const tileDeltas = grid.computeDeltasFromSnapshot(beforeTileSnap, editingLayerId, {
            x: 0,
            y: 0,
            width: dims.width,
            height: dims.height,
          });
          for (const t of grid.getLayerTiles(editingLayerId, 0)) {
            const key = getTileKey(editingLayerId, t.tileX, t.tileY, 0);
            if (t.data && !beforeTileSnap.has(key) && !tileDeltas.some((d) => d.key === key)) {
              tileDeltas.push({ key, format: t.format, beforeData: null, afterData: new Uint8Array(t.data) });
            }
          }
          updateLayerThumbnail(editingLayerId, true);
          recordLayerHistory(
            'Edit Speech Balloon',
            editingLayerId,
            createLayerTreeSnapshotDelta(
              beforeLayers,
              layersRef.current,
              beforeActiveLayerId,
              activeLayerIdRef.current
            ),
            tileDeltas,
            'balloon'
          );
          return updated;
        }
      }

      suppressHistoryDepthRef.current += 1;
      let created: LayerItem;
      try {
        created = addLayer('balloon', undefined, label, undefined, true);
      } finally {
        suppressHistoryDepthRef.current = Math.max(0, suppressHistoryDepthRef.current - 1);
      }
      const withData: LayerItem = {
        ...created,
        balloonData: clonedBalloon,
      };
      const nextLayers = layersRef.current.map((l) =>
        l.id === created.id ? { ...l, balloonData: clonedBalloon } : l
      );
      layersRef.current = nextLayers;
      setLayers(nextLayers);
      const beforeTileSnap = grid.snapshotLayerTiles(created.id);
      syncVectorObjectLayerToGrid(withData, dims, grid);
      const tileDeltas = grid.computeDeltasFromSnapshot(beforeTileSnap, created.id, {
        x: 0,
        y: 0,
        width: dims.width,
        height: dims.height,
      });
      updateLayerThumbnail(created.id, true);
      recordLayerHistory(
        'Add Speech Balloon',
        created.id,
        createLayerTreeSnapshotDelta(beforeLayers, layersRef.current, beforeActiveLayerId, created.id),
        tileDeltas,
        'balloon'
      );
      return withData;
    },
    [
      activeLayerIdRef,
      activeTileGridRef,
      addLayer,
      dimensionsRef,
      layersRef,
      recordLayerHistory,
      setLayers,
      suppressHistoryDepthRef,
      updateLayerThumbnail,
    ]
  );

  // Create a true Manga Frame Border Folder with auto-clipping & initial child raster layer
  const createFrameFolder = useCallback(
    (
      frames: ComicFrame[],
      customName?: string,
      addInitialChildLayer = true
    ): CreateFrameFolderResult => {
      const beforeLayers = layersRef.current;
      const beforeActiveLayerId = activeLayerIdRef.current;
      const activeIdx = beforeLayers.findIndex((l) => l.id === beforeActiveLayerId);
      const currentActiveLayer = activeIdx >= 0 ? beforeLayers[activeIdx] : undefined;
      const insertIndex = activeIdx >= 0 ? activeIdx : 0;
      const insertBeforeLayerId = beforeLayers[insertIndex]?.id ?? null;

      const folderId = `frame-folder-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      let frameCount = 1;
      for (const l of beforeLayers) {
        if (l.type === 'frame-folder' && l.name.startsWith('Frame ')) {
          const num = parseInt(l.name.replace('Frame ', ''), 10);
          if (!isNaN(num) && num >= frameCount) frameCount = num + 1;
        }
      }

      const expressionColor =
        currentActiveLayer?.expressionColor === 'monochrome'
          ? 'monochrome'
          : currentActiveLayer?.expressionColor === 'gray'
          ? 'gray'
          : 'color';
      const monoThreshold = currentActiveLayer?.monoThreshold ?? 128;
      const monoExpressBlack = currentActiveLayer?.monoExpressBlack ?? true;
      const monoExpressWhite = currentActiveLayer?.monoExpressWhite ?? true;

      const normalizedFrames = frames.map((f) => ({
        ...f,
        layerId: folderId,
        clipChildren: f.clipChildren !== false,
        polygon: f.polygon.map((p) => ({ x: p.x, y: p.y })),
      }));

      const updatedFolder: LayerItem = {
        id: folderId,
        name: customName || `Frame ${frameCount}`,
        type: 'frame-folder',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        collapsed: false,
        parentId: null,
        thumbnailUrl: '',
        expressionColor,
        monoThreshold,
        monoExpressBlack,
        monoExpressWhite,
        comicFrames: normalizedFrames,
      };

      const grid = activeTileGridRef.current;
      let childLayer: LayerItem | null = null;
      if (addInitialChildLayer) {
        const childId = `raster-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        childLayer = {
          id: childId,
          name: 'Panel Layer',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          collapsed: false,
          parentId: folderId,
          thumbnailUrl: '',
          expressionColor,
          monoThreshold,
          monoExpressBlack,
          monoExpressWhite,
        };
        const isMono = expressionColor === 'monochrome';
        grid.setLayerFormat(childId, isMono ? 'monochrome-1bit' : 'color-32bit');
        grid.markLayerIngested(childId);
      }

      const addedLayers = childLayer ? [updatedFolder, childLayer] : [updatedFolder];
      const syncNext = [...beforeLayers];
      syncNext.splice(insertIndex, 0, ...addedLayers);
      layersRef.current = syncNext;

      setLayers((prev) => {
        if (prev.some((l) => l.id === folderId)) return prev;
        const anchorIdx = insertBeforeLayerId
          ? prev.findIndex((l) => l.id === insertBeforeLayerId)
          : -1;
        const targetIdx = anchorIdx >= 0 ? anchorIdx : Math.min(insertIndex, prev.length);
        const next = [...prev];
        next.splice(targetIdx, 0, ...addedLayers);
        layersRef.current = next;
        return next;
      });

      const afterActiveLayerId = childLayer ? childLayer.id : updatedFolder.id;
      setActiveLayerId(afterActiveLayerId);
      grid.notifyChange(true);

      const layerTreeDelta: LayerTreeDelta = {
        addedLayers: addedLayers.map((l) => cloneLayerItemForHistory(l)),
        insertBeforeLayerId,
        insertIndex,
        beforeActiveLayerId,
        afterActiveLayerId,
      };

      return { folder: updatedFolder, childLayer, layerTreeDelta };
    },
    [activeLayerIdRef, activeTileGridRef, layersRef, setActiveLayerId, setLayers]
  );

  // Divide a Frame Border Folder along a cut line (single folder split polygons or 2 independent folders)
  const divideFrameFolder = useCallback(
    (
      folderId: string,
      cutStart: Point2D,
      cutEnd: Point2D,
      dpi = 600,
      mode: FrameDivideMode = 'same-folder'
    ): DivideFrameFolderActionResult => {
      const current = layersRef.current;
      const folderIdx = current.findIndex((l) => l.id === folderId && l.type === 'frame-folder');
      if (folderIdx < 0) return { divided: false };
      const folder = current[folderIdx];
      const frames = folder.comicFrames || [];
      if (frames.length === 0) return { divided: false };

      const result = divideFramesInFolder(frames, cutStart, cutEnd, dpi, mode);
      if (!result.divided) return { divided: false };

      const grid = activeTileGridRef.current;
      const beforeFrames = cloneComicFrames(frames);
      const currentActiveId = activeLayerIdRef.current;

      if (mode === 'same-folder' || result.folderGroups.length < 2) {
        const nextFrames = result.frames.map((f) => ({ ...f, layerId: folder.id }));
        const syncNext = current.map((l) =>
          l.id === folder.id ? { ...l, comicFrames: nextFrames } : l
        );
        layersRef.current = syncNext;
        setLayers((prev) => {
          const next = prev.map((l) =>
            l.id === folder.id ? { ...l, comicFrames: nextFrames } : l
          );
          layersRef.current = next;
          return next;
        });
        grid.notifyChange(true);
        return {
          divided: true,
          layerTreeDelta: {
            updatedLayers: [
              {
                layerId: folder.id,
                beforeComicFrames: beforeFrames,
                afterComicFrames: cloneComicFrames(nextFrames),
              },
            ],
            beforeActiveLayerId: currentActiveId,
            afterActiveLayerId: currentActiveId,
          },
        };
      }

      // Split into 2 independent frame folders, cloning child layers into the 2nd folder so artwork stays intact
      const [group1, group2] = result.folderGroups;
      const newFolderId = `frame-folder-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const group1Frames = group1.map((f) => ({ ...f, layerId: folder.id }));
      const group2Frames = group2.map((f) => ({ ...f, layerId: newFolderId }));
      const updatedFolder1: LayerItem = {
        ...folder,
        comicFrames: group1Frames,
      };
      const newFolder2: LayerItem = {
        ...folder,
        id: newFolderId,
        name: `${folder.name} B`,
        comicFrames: group2Frames,
      };

      const directChildren = current.filter((l) => l.parentId === folder.id);
      const clonedTileDeltas: TileDelta[] = [];
      const clonedChildren: LayerItem[] = directChildren.map((child) => {
        const cloneId = `${child.type}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        if (hasTileBackedLayer(child)) {
          grid.cloneLayer(child.id, cloneId);
          for (const tile of grid.getLayerTiles(cloneId, 0)) {
            if (!tile.data) continue;
            const copy = new Uint8Array(tile.data.length);
            copy.set(tile.data);
            clonedTileDeltas.push({
              key: getTileKey(cloneId, tile.tileX, tile.tileY, 0),
              format: tile.format,
              beforeData: null,
              afterData: copy,
            });
          }
        }
        return {
          ...child,
          id: cloneId,
          parentId: newFolderId,
          textData: child.textData ? JSON.parse(JSON.stringify(child.textData)) : undefined,
          balloonData: child.balloonData ? JSON.parse(JSON.stringify(child.balloonData)) : undefined,
          vectorStrokes: child.vectorStrokes ? JSON.parse(JSON.stringify(child.vectorStrokes)) : undefined,
        };
      });

      const addedLayers = [newFolder2, ...clonedChildren];
      const syncNext = current.map((l) => (l.id === folder.id ? updatedFolder1 : l));
      syncNext.splice(folderIdx, 0, ...addedLayers);
      layersRef.current = syncNext;

      setLayers((prev) => {
        if (prev.some((l) => l.id === newFolderId)) return prev;
        const idx = prev.findIndex((l) => l.id === folder.id);
        if (idx < 0) return prev;
        const next = prev.map((l) => (l.id === folder.id ? updatedFolder1 : l));
        next.splice(idx, 0, ...addedLayers);
        layersRef.current = next;
        return next;
      });

      grid.notifyChange(true);
      return {
        divided: true,
        layerTreeDelta: {
          addedLayers: addedLayers.map((l) => cloneLayerItemForHistory(l)),
          insertBeforeLayerId: folder.id,
          insertIndex: folderIdx,
          updatedLayers: [
            {
              layerId: folder.id,
              beforeComicFrames: beforeFrames,
              afterComicFrames: cloneComicFrames(group1Frames),
            },
          ],
          beforeActiveLayerId: currentActiveId,
          afterActiveLayerId: currentActiveId,
        },
        tileDeltas: clonedTileDeltas.length > 0 ? clonedTileDeltas : undefined,
      };
    },
    [activeLayerIdRef, activeTileGridRef, layersRef, setLayers]
  );

  // Apply a targeted LayerTreeDelta during Undo/Redo (keeps React state, refs, and SparseTileGrid synchronized)
  const applyLayerTreeDelta = useCallback(
    (delta: LayerTreeDelta, direction: 'undo' | 'redo'): ApplyLayerTreeDeltaResult => {
      const grid = activeTileGridRef.current;
      const syncResult = applyLayerTreeDeltaPure(
        layersRef.current,
        activeLayerIdRef.current,
        delta,
        direction
      );
      layersRef.current = syncResult.nextLayers;

      setLayers((prev) => {
        const nextRes = applyLayerTreeDeltaPure(prev, activeLayerIdRef.current, delta, direction);
        layersRef.current = nextRes.nextLayers;
        return nextRes.nextLayers;
      });

      for (const delId of syncResult.removedLayerIds) {
        const timer = thumbDebounceTimersRef.current.get(delId);
        if (timer) {
          clearTimeout(timer);
          thumbDebounceTimersRef.current.delete(delId);
        }
        grid.clearLayer(delId);
      }

      for (const added of syncResult.addedLayers) {
        if (hasTileBackedLayer(added)) {
          const isMono = added.expressionColor === 'monochrome';
          grid.setLayerFormat(added.id, isMono ? 'monochrome-1bit' : 'color-32bit');
          grid.markLayerIngested(added.id);
        }
      }

      if (syncResult.nextActiveLayerId !== null) {
        setActiveLayerId(syncResult.nextActiveLayerId);
      }

      grid.notifyChange(true);
      return syncResult;
    },
    [activeLayerIdRef, activeTileGridRef, layersRef, setActiveLayerId, setLayers, thumbDebounceTimersRef]
  );

  // Rasterize a non-destructive text, balloon, or vector layer into a standard raster layer
  const rasterizeLayer = useCallback(
    (id: string): boolean => {
      const beforeLayers = layersRef.current;
      const beforeActiveLayerId = activeLayerIdRef.current;
      const target = beforeLayers.find((l) => l.id === id);
      if (!target) return false;
      if (target.type !== 'text' && target.type !== 'balloon' && target.type !== 'vector') {
        return false;
      }

      const grid = activeTileGridRef.current;
      const dims = dimensionsRef.current;
      const beforeTileSnap = grid.snapshotLayerTiles(id);

      if (target.type === 'text' || target.type === 'balloon') {
        syncVectorObjectLayerToGrid(target, dims, grid);
      }

      const nextLayers = beforeLayers.map((l) => {
        if (l.id !== id) return l;
        const { textData: _td, balloonData: _bd, vectorStrokes: _vs, ...rest } = l;
        return {
          ...rest,
          type: 'raster' as const,
        };
      });
      layersRef.current = nextLayers;
      setLayers(nextLayers);

      const tileDeltas = grid.computeDeltasFromSnapshot(beforeTileSnap, id, {
        x: 0,
        y: 0,
        width: dims.width,
        height: dims.height,
      });
      for (const t of grid.getLayerTiles(id, 0)) {
        const key = getTileKey(id, t.tileX, t.tileY, 0);
        if (t.data && !beforeTileSnap.has(key) && !tileDeltas.some((d) => d.key === key)) {
          tileDeltas.push({ key, format: t.format, beforeData: null, afterData: new Uint8Array(t.data) });
        }
      }

      updateLayerThumbnail(id, true);
      grid.notifyChange(true);
      recordLayerHistory(
        'Rasterize Layer',
        id,
        createLayerTreeSnapshotDelta(beforeLayers, nextLayers, beforeActiveLayerId, activeLayerIdRef.current),
        tileDeltas,
        'layer-convert'
      );
      return true;
    },
    [activeLayerIdRef, activeTileGridRef, dimensionsRef, layersRef, recordLayerHistory, setLayers, updateLayerThumbnail]
  );

  return {
    upsertTextLayer,
    upsertBalloonLayer,
    createFrameFolder,
    divideFrameFolder,
    applyLayerTreeDelta,
    rasterizeLayer,
  };
}
