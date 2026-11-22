import { useCallback } from 'react';
import {
  ComicFrame,
  FrameDivideMode,
  LayerItem,
  LayerType,
  SpeechBalloon,
  TextLayerData,
  hasTileBackedLayer,
} from '../../types/editor';
import { divideFramesInFolder, Point2D } from '../../utils/frameEngine';
import { syncVectorObjectLayerToGrid } from '../../utils/vectorLayerRenderer';
import { LayerManagerContext } from './types';

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
    setLayers,
    layersRef,
  } = ctx;

  // Create or update a non-destructive Vector Text Layer (re-renders crisply into tileGrid)
  const upsertTextLayer = useCallback(
    (textData: TextLayerData, editingLayerId?: string | null): LayerItem => {
      const grid = activeTileGridRef.current;
      const dims = dimensionsRef.current;
      const snippet = textData.text.trim().replace(/\s+/g, ' ').slice(0, 22) || 'Text';

      if (editingLayerId) {
        const existing = layersRef.current.find((l) => l.id === editingLayerId);
        if (existing && existing.type === 'text') {
          const updated: LayerItem = {
            ...existing,
            name: snippet,
            textData: { ...textData },
          };
          setLayers((prev) => {
            const next = prev.map((l) => (l.id === editingLayerId ? updated : l));
            layersRef.current = next;
            return next;
          });
          syncVectorObjectLayerToGrid(updated, dims, grid);
          updateLayerThumbnail(editingLayerId, true);
          return updated;
        }
      }

      const created = addLayer('text', undefined, snippet, undefined, true);
      const withData: LayerItem = {
        ...created,
        textData: { ...textData },
      };
      setLayers((prev) => {
        const next = prev.map((l) => (l.id === created.id ? { ...l, textData: { ...textData } } : l));
        layersRef.current = next;
        return next;
      });
      syncVectorObjectLayerToGrid(withData, dims, grid);
      updateLayerThumbnail(created.id, true);
      return withData;
    },
    [activeTileGridRef, addLayer, dimensionsRef, layersRef, setLayers, updateLayerThumbnail]
  );

  // Create or update a non-destructive Speech Balloon Layer (re-renders crisply into tileGrid)
  const upsertBalloonLayer = useCallback(
    (balloonData: SpeechBalloon, editingLayerId?: string | null): LayerItem => {
      const grid = activeTileGridRef.current;
      const dims = dimensionsRef.current;
      const clonedBalloon: SpeechBalloon = JSON.parse(JSON.stringify(balloonData));
      const snippet = clonedBalloon.text.trim().replace(/\s+/g, ' ').slice(0, 18);
      const label = snippet ? `Balloon: ${snippet}` : undefined;

      if (editingLayerId) {
        const existing = layersRef.current.find((l) => l.id === editingLayerId);
        if (existing && existing.type === 'balloon') {
          const updated: LayerItem = {
            ...existing,
            name: label || existing.name,
            balloonData: clonedBalloon,
          };
          setLayers((prev) => {
            const next = prev.map((l) => (l.id === editingLayerId ? updated : l));
            layersRef.current = next;
            return next;
          });
          syncVectorObjectLayerToGrid(updated, dims, grid);
          updateLayerThumbnail(editingLayerId, true);
          return updated;
        }
      }

      const created = addLayer('balloon', undefined, label, undefined, true);
      const withData: LayerItem = {
        ...created,
        balloonData: clonedBalloon,
      };
      setLayers((prev) => {
        const next = prev.map((l) => (l.id === created.id ? { ...l, balloonData: clonedBalloon } : l));
        layersRef.current = next;
        return next;
      });
      syncVectorObjectLayerToGrid(withData, dims, grid);
      updateLayerThumbnail(created.id, true);
      return withData;
    },
    [activeTileGridRef, addLayer, dimensionsRef, layersRef, setLayers, updateLayerThumbnail]
  );

  // Create a true Manga Frame Border Folder with auto-clipping & initial child raster layer
  const createFrameFolder = useCallback(
    (
      frames: ComicFrame[],
      customName?: string,
      addInitialChildLayer = true
    ): { folder: LayerItem; childLayer: LayerItem | null } => {
      const folder = addLayer('frame-folder', null, customName, undefined, !addInitialChildLayer);
      const normalizedFrames = frames.map((f) => ({
        ...f,
        layerId: folder.id,
        clipChildren: f.clipChildren !== false,
      }));
      const updatedFolder: LayerItem = {
        ...folder,
        comicFrames: normalizedFrames,
      };
      setLayers((prev) => {
        const next = prev.map((l) =>
          l.id === folder.id ? { ...l, comicFrames: normalizedFrames } : l
        );
        layersRef.current = next;
        return next;
      });

      let childLayer: LayerItem | null = null;
      if (addInitialChildLayer) {
        childLayer = addLayer('raster', folder.id, 'Panel Layer', undefined, true);
      }

      activeTileGridRef.current.notifyChange(true);
      return { folder: updatedFolder, childLayer };
    },
    [activeTileGridRef, addLayer, layersRef, setLayers]
  );

  // Divide a Frame Border Folder along a cut line (single folder split polygons or 2 independent folders)
  const divideFrameFolder = useCallback(
    (
      folderId: string,
      cutStart: Point2D,
      cutEnd: Point2D,
      dpi = 600,
      mode: FrameDivideMode = 'same-folder'
    ): boolean => {
      const current = layersRef.current;
      const folderIdx = current.findIndex((l) => l.id === folderId && l.type === 'frame-folder');
      if (folderIdx < 0) return false;
      const folder = current[folderIdx];
      const frames = folder.comicFrames || [];
      if (frames.length === 0) return false;

      const result = divideFramesInFolder(frames, cutStart, cutEnd, dpi, mode);
      if (!result.divided) return false;

      const grid = activeTileGridRef.current;

      if (mode === 'same-folder' || result.folderGroups.length < 2) {
        const nextFrames = result.frames.map((f) => ({ ...f, layerId: folder.id }));
        setLayers((prev) => {
          const next = prev.map((l) =>
            l.id === folder.id ? { ...l, comicFrames: nextFrames } : l
          );
          layersRef.current = next;
          return next;
        });
        grid.notifyChange(true);
        return true;
      }

      // Split into 2 independent frame folders, cloning child layers into the 2nd folder so artwork stays intact
      const [group1, group2] = result.folderGroups;
      const newFolderId = `frame-folder-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const updatedFolder1: LayerItem = {
        ...folder,
        comicFrames: group1.map((f) => ({ ...f, layerId: folder.id })),
      };
      const newFolder2: LayerItem = {
        ...folder,
        id: newFolderId,
        name: `${folder.name} B`,
        comicFrames: group2.map((f) => ({ ...f, layerId: newFolderId })),
      };

      const directChildren = current.filter((l) => l.parentId === folder.id);
      const clonedChildren: LayerItem[] = directChildren.map((child) => {
        const cloneId = `${child.type}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        if (hasTileBackedLayer(child)) {
          grid.cloneLayer(child.id, cloneId);
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

      setLayers((prev) => {
        const idx = prev.findIndex((l) => l.id === folder.id);
        if (idx < 0) return prev;
        const next = prev.map((l) => (l.id === folder.id ? updatedFolder1 : l));
        next.splice(idx, 0, newFolder2, ...clonedChildren);
        layersRef.current = next;
        return next;
      });

      grid.notifyChange(true);
      return true;
    },
    [activeTileGridRef, layersRef, setLayers]
  );

  // Rasterize a non-destructive text, balloon, or vector layer into a standard raster layer
  const rasterizeLayer = useCallback(
    (id: string): boolean => {
      const target = layersRef.current.find((l) => l.id === id);
      if (!target) return false;
      if (target.type !== 'text' && target.type !== 'balloon' && target.type !== 'vector') {
        return false;
      }

      const grid = activeTileGridRef.current;
      const dims = dimensionsRef.current;

      if (target.type === 'text' || target.type === 'balloon') {
        syncVectorObjectLayerToGrid(target, dims, grid);
      }

      setLayers((prev) => {
        const next = prev.map((l) => {
          if (l.id !== id) return l;
          const { textData: _td, balloonData: _bd, vectorStrokes: _vs, ...rest } = l;
          return {
            ...rest,
            type: 'raster' as const,
          };
        });
        layersRef.current = next;
        return next;
      });

      updateLayerThumbnail(id, true);
      grid.notifyChange(true);
      return true;
    },
    [activeTileGridRef, dimensionsRef, layersRef, setLayers, updateLayerThumbnail]
  );

  return {
    upsertTextLayer,
    upsertBalloonLayer,
    createFrameFolder,
    divideFrameFolder,
    rasterizeLayer,
  };
}
