import { useCallback } from 'react';
import {
  CanvasDimensions,
  LayerItem,
  hasTileBackedLayer,
} from '../../types/editor';
import {
  LayerClearableField,
  LayerMaskDataMessage,
  WireLayerItem,
} from '../../types/multiplayer';
import { createCanvasThumbnail, get2DContext } from '../../utils/canvasUtils';
import {
  applyMaskDataToCanvas,
  applyRemoteLayerPatch,
  deepEqualWireValue,
  mergeRemoteWireLayerIntoLocal,
} from '../../utils/collabSyncUtils';
import { documentStore } from '../../utils/documentStore';
import { SparseTileGrid, releaseTemporaryCanvas } from '../../utils/tileEngine';
import { renderVectorLayer } from '../../utils/vectorEngine';
import { syncVectorObjectLayerToGrid } from '../../utils/vectorLayerRenderer';
import { computeBatchDeleteLayers, isBackgroundLayerId } from './layerTreeOps';
import { LayerManagerContext } from './types';

function rerenderVectorLayerToGrid(
  layer: LayerItem,
  dims: CanvasDimensions,
  grid: SparseTileGrid
): void {
  if (typeof document === 'undefined' || dims.width <= 0 || dims.height <= 0) return;
  const strokes = layer.vectorStrokes || [];
  const isMono = layer.expressionColor === 'monochrome';
  const format = isMono ? 'monochrome-1bit' : 'color-32bit';

  grid.clearLayer(layer.id);
  grid.setLayerFormat(layer.id, format);
  grid.markLayerIngested(layer.id);

  if (strokes.length === 0) return;

  let minX = dims.width;
  let minY = dims.height;
  let maxX = 0;
  let maxY = 0;
  for (const st of strokes) {
    if (st.deleted || !st.bounds) continue;
    const pad = Math.ceil(Math.max(16, (st.baseWidth || 10) * 1.5));
    if (st.bounds.minX - pad < minX) minX = st.bounds.minX - pad;
    if (st.bounds.minY - pad < minY) minY = st.bounds.minY - pad;
    if (st.bounds.maxX + pad > maxX) maxX = st.bounds.maxX + pad;
    if (st.bounds.maxY + pad > maxY) maxY = st.bounds.maxY + pad;
  }

  const vx = Math.max(0, Math.floor(minX));
  const vy = Math.max(0, Math.floor(minY));
  const vw = Math.max(0, Math.min(dims.width, Math.ceil(maxX)) - vx);
  const vh = Math.max(0, Math.min(dims.height, Math.ceil(maxY)) - vy);
  if (vw <= 0 || vh <= 0) return;

  const temp = document.createElement('canvas');
  temp.width = vw;
  temp.height = vh;
  const ctx = get2DContext(temp);
  if (ctx) {
    ctx.save();
    ctx.translate(-vx, -vy);
    renderVectorLayer(ctx, strokes);
    ctx.restore();
    const imgData = ctx.getImageData(0, 0, vw, vh);
    grid.writeImageData(layer.id, imgData, vx, vy, format, true);
  }
  releaseTemporaryCanvas(temp);
}

function resolveTileFormatForLayer(layer: Pick<LayerItem, 'id' | 'expressionColor'>) {
  if (isBackgroundLayerId(layer.id)) return 'color-32bit' as const;
  if (layer.expressionColor === 'monochrome') return 'monochrome-1bit' as const;
  if (layer.expressionColor === 'gray') return 'grayscale-8bit' as const;
  return 'color-32bit' as const;
}

export function useLayerCollabSync(
  ctx: LayerManagerContext,
  updateLayerThumbnail?: (id: string, immediate?: boolean) => void
) {
  const {
    activeTileGridRef,
    dimensionsRef,
    activeSessionIdRef,
    thumbDebounceTimersRef,
    setLayers,
    layersRef,
    activeLayerIdRef,
    setActiveLayerId,
    setSelectedLayerIds,
  } = ctx;

  // Add a layer that originated from a remote peer (raster pixels arrive via BINARY_TILE)
  const addRemoteLayer = useCallback(
    (
      wireLayer: LayerItem | WireLayerItem,
      insertIndex?: number,
      onCommitted?: (nextLayers: LayerItem[]) => void
    ) => {
      const grid = activeTileGridRef.current;
      const dims = dimensionsRef.current;
      const hydrated = mergeRemoteWireLayerIntoLocal(undefined, wireLayer as WireLayerItem, dims);

      if (hasTileBackedLayer(hydrated)) {
        grid.setLayerFormat(hydrated.id, resolveTileFormatForLayer(hydrated));
        grid.markLayerIngested(hydrated.id);
      }

      if (
        (hydrated.type === 'text' && hydrated.textData) ||
        (hydrated.type === 'balloon' && hydrated.balloonData)
      ) {
        syncVectorObjectLayerToGrid(hydrated, dims, grid);
      } else if (hydrated.type === 'vector' && hydrated.vectorStrokes?.length) {
        rerenderVectorLayerToGrid(hydrated, dims, grid);
      }

      setLayers((prev) => {
        if (prev.some((l) => l.id === hydrated.id)) {
          onCommitted?.(prev);
          return prev;
        }
        const next = [...prev];
        if (insertIndex !== undefined && insertIndex >= 0 && insertIndex <= next.length) {
          next.splice(insertIndex, 0, hydrated);
        } else {
          const bgIdx = next.findIndex((l) => isBackgroundLayerId(l.id));
          if (bgIdx >= 0) {
            next.splice(bgIdx, 0, hydrated);
          } else {
            next.push(hydrated);
          }
        }
        layersRef.current = next;
        onCommitted?.(next);
        return next;
      });

      grid.notifyChange(true);
      if (hydrated.type === 'text' || hydrated.type === 'balloon' || hydrated.type === 'vector') {
        updateLayerThumbnail?.(hydrated.id, true);
      }
    },
    [activeTileGridRef, dimensionsRef, layersRef, setLayers, updateLayerThumbnail]
  );

  // Delete a layer or folder subtree triggered remotely
  const deleteRemoteLayer = useCallback(
    (layerId: string, onCommitted?: (nextLayers: LayerItem[]) => void) => {
      const grid = activeTileGridRef.current;
      setLayers((prev) => {
        const res = computeBatchDeleteLayers(prev, [layerId], activeLayerIdRef.current);
        if (res.deletedIds.length === 0) {
          onCommitted?.(prev);
          return prev;
        }
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
          setSelectedLayerIds((prevSel) => prevSel.filter((sid) => !res.deletedIds.includes(sid)));
        }
        layersRef.current = res.nextLayers;
        onCommitted?.(res.nextLayers);
        return res.nextLayers;
      });
      grid.notifyChange(true);
    },
    [
      activeLayerIdRef,
      activeTileGridRef,
      layersRef,
      setActiveLayerId,
      setLayers,
      setSelectedLayerIds,
      thumbDebounceTimersRef,
    ]
  );

  // Apply an incremental remote property patch (blendMode, clipped, alphaLocked, styles, text, balloon, frames, vectorStrokes, etc.)
  const applyRemoteLayerUpdate = useCallback(
    (
      layerId: string,
      patch: Partial<WireLayerItem>,
      clearedFields?: LayerClearableField[],
      onCommitted?: (nextLayers: LayerItem[]) => void
    ) => {
      const grid = activeTileGridRef.current;
      const dims = dimensionsRef.current;
      let needsTextBalloonRender: LayerItem | null = null;
      let needsVectorRender: LayerItem | null = null;
      let needsMaskThumb = false;

      setLayers((prev) => {
        let found = false;
        const next = prev.map((l) => {
          if (l.id !== layerId) return l;
          found = true;
          const updated = applyRemoteLayerPatch(l, patch, clearedFields, dims);
          if (
            (updated.type === 'text' && updated.textData && !deepEqualWireValue(l.textData, updated.textData)) ||
            (updated.type === 'balloon' && updated.balloonData && !deepEqualWireValue(l.balloonData, updated.balloonData))
          ) {
            needsTextBalloonRender = updated;
          }
          if (
            updated.type === 'vector' &&
            patch.vectorStrokes !== undefined &&
            !deepEqualWireValue(l.vectorStrokes, updated.vectorStrokes)
          ) {
            needsVectorRender = updated;
          }
          if (updated.maskCanvas && !l.maskCanvas) {
            needsMaskThumb = true;
            updated.maskThumbnailUrl = createCanvasThumbnail(updated.maskCanvas, false);
          }
          return updated;
        });
        if (!found) {
          onCommitted?.(prev);
          return prev;
        }
        layersRef.current = next;
        onCommitted?.(next);
        return next;
      });

      if (needsTextBalloonRender) {
        syncVectorObjectLayerToGrid(needsTextBalloonRender, dims, grid);
        updateLayerThumbnail?.(layerId, true);
      } else if (needsVectorRender) {
        rerenderVectorLayerToGrid(needsVectorRender, dims, grid);
        updateLayerThumbnail?.(layerId, true);
      } else if (needsMaskThumb) {
        grid.notifyChange(true);
      } else {
        grid.notifyChange(true);
      }
    },
    [activeTileGridRef, dimensionsRef, layersRef, setLayers, updateLayerThumbnail]
  );

  // Apply an authoritative full layer tree sync (reorder, group, multi-delete, duplicate, mergeDown, split-folder, batch ops)
  const applyRemoteLayerTree = useCallback(
    (
      wireLayers: WireLayerItem[],
      removedLayerIds?: string[],
      onCommitted?: (nextLayers: LayerItem[]) => void
    ) => {
      const grid = activeTileGridRef.current;
      const dims = dimensionsRef.current;
      const toRenderTextBalloon: LayerItem[] = [];
      const toRenderVector: LayerItem[] = [];

      setLayers((prev) => {
        const prevById = new Map(prev.map((l) => [l.id, l]));
        const nextIds = new Set(wireLayers.map((l) => l.id));

        const removedSet = new Set<string>(removedLayerIds || []);
        for (const oldLayer of prev) {
          if (!nextIds.has(oldLayer.id)) {
            removedSet.add(oldLayer.id);
          }
        }

        for (const remId of removedSet) {
          const timer = thumbDebounceTimersRef.current.get(remId);
          if (timer) {
            clearTimeout(timer);
            thumbDebounceTimersRef.current.delete(remId);
          }
          const oldLayer = prevById.get(remId);
          if (oldLayer?.maskCanvas) {
            releaseTemporaryCanvas(oldLayer.maskCanvas);
          }
          grid.clearLayer(remId);
        }

        const next: LayerItem[] = wireLayers.map((wire) => {
          const existing = prevById.get(wire.id);
          const merged = mergeRemoteWireLayerIntoLocal(existing, wire, dims);
          if (!existing && hasTileBackedLayer(merged)) {
            grid.setLayerFormat(merged.id, resolveTileFormatForLayer(merged));
            grid.markLayerIngested(merged.id);
          }
          if (merged.maskCanvas && !existing?.maskCanvas) {
            merged.maskThumbnailUrl = createCanvasThumbnail(merged.maskCanvas, false);
          }
          if (
            (merged.type === 'text' &&
              merged.textData &&
              (!existing || !deepEqualWireValue(existing.textData, merged.textData))) ||
            (merged.type === 'balloon' &&
              merged.balloonData &&
              (!existing || !deepEqualWireValue(existing.balloonData, merged.balloonData)))
          ) {
            toRenderTextBalloon.push(merged);
          }
          if (
            merged.type === 'vector' &&
            merged.vectorStrokes &&
            (!existing || !deepEqualWireValue(existing.vectorStrokes, merged.vectorStrokes))
          ) {
            toRenderVector.push(merged);
          }
          return merged;
        });

        if (!nextIds.has(activeLayerIdRef.current)) {
          const fallback =
            next.find((l) => l.type === 'raster' && !isBackgroundLayerId(l.id))?.id ||
            next[0]?.id ||
            '';
          setActiveLayerId(fallback);
        } else {
          setSelectedLayerIds((prevSel) => {
            const filtered = prevSel.filter((id) => nextIds.has(id));
            return filtered.length > 0 ? filtered : [activeLayerIdRef.current];
          });
        }

        layersRef.current = next;
        onCommitted?.(next);
        return next;
      });

      for (const layer of toRenderTextBalloon) {
        syncVectorObjectLayerToGrid(layer, dims, grid);
        updateLayerThumbnail?.(layer.id, true);
      }
      for (const layer of toRenderVector) {
        rerenderVectorLayerToGrid(layer, dims, grid);
        updateLayerThumbnail?.(layer.id, true);
      }

      grid.notifyChange(true);
    },
    [
      activeLayerIdRef,
      activeTileGridRef,
      dimensionsRef,
      layersRef,
      setActiveLayerId,
      setLayers,
      setSelectedLayerIds,
      thumbDebounceTimersRef,
      updateLayerThumbnail,
    ]
  );

  // Apply binary grayscale mask patch/full mask received via BINARY_MASK
  const applyRemoteMaskData = useCallback(
    (msg: LayerMaskDataMessage, onCommitted?: (nextLayers: LayerItem[]) => void) => {
      const dims = dimensionsRef.current;
      const grid = activeTileGridRef.current;

      setLayers((prev) => {
        let changed = false;
        const next = prev.map((l) => {
          if (l.id !== msg.layerId) return l;
          const updatedCanvas = applyMaskDataToCanvas(l.maskCanvas, dims, msg);
          if (!updatedCanvas) return l;
          changed = true;
          const thumb = createCanvasThumbnail(updatedCanvas, false);
          return {
            ...l,
            maskCanvas: updatedCanvas,
            maskEnabled: l.maskEnabled ?? true,
            maskLinked: l.maskLinked ?? true,
            maskThumbnailUrl: thumb,
            maskVersion: (l.maskVersion || 0) + 1,
          };
        });
        if (!changed) {
          onCommitted?.(prev);
          return prev;
        }
        layersRef.current = next;
        onCommitted?.(next);
        return next;
      });

      grid.notifyChange(true);
    },
    [activeTileGridRef, dimensionsRef, layersRef, setLayers]
  );

  // Sync document metadata from remote host (raster pixels stream via BINARY_TILE, masks via BINARY_MASK)
  const syncRemoteDocument = useCallback(
    (
      syncedLayers: Array<LayerItem | WireLayerItem>,
      assignedLayerId?: string,
      targetDocumentId?: string,
      syncDims?: CanvasDimensions,
      onCommitted?: (nextLayers: LayerItem[]) => void
    ) => {
      for (const timer of thumbDebounceTimersRef.current.values()) {
        clearTimeout(timer);
      }
      thumbDebounceTimersRef.current.clear();

      let grid = activeTileGridRef.current;
      if (targetDocumentId) {
        const session =
          documentStore.setActiveDocument(targetDocumentId) ??
          documentStore.getOrCreateSession(targetDocumentId);
        activeSessionIdRef.current = targetDocumentId;
        activeTileGridRef.current = session.tileGrid;
        grid = session.tileGrid;
      }
      if (syncDims) {
        dimensionsRef.current = syncDims;
      }

      const dims = syncDims || dimensionsRef.current;
      grid.clearAll();

      const hydratedLayers: LayerItem[] = syncedLayers.map((raw) => {
        const hydrated = mergeRemoteWireLayerIntoLocal(undefined, raw as WireLayerItem, dims);
        if (hydrated.maskCanvas) {
          hydrated.maskThumbnailUrl = createCanvasThumbnail(hydrated.maskCanvas, false);
        }
        return hydrated;
      });

      setLayers(hydratedLayers);
      layersRef.current = hydratedLayers;
      onCommitted?.(hydratedLayers);

      if (assignedLayerId && hydratedLayers.some((l) => l.id === assignedLayerId)) {
        setActiveLayerId(assignedLayerId);
      } else {
        const topRaster = hydratedLayers.find(
          (l) => l.type === 'raster' && !isBackgroundLayerId(l.id)
        );
        if (topRaster) {
          setActiveLayerId(topRaster.id);
        } else if (hydratedLayers[0]) {
          setActiveLayerId(hydratedLayers[0].id);
        }
      }

      hydratedLayers.forEach((layer) => {
        if (hasTileBackedLayer(layer)) {
          grid.setLayerFormat(layer.id, resolveTileFormatForLayer(layer));
          grid.markLayerIngested(layer.id);
        }
        if (
          (layer.type === 'text' && layer.textData) ||
          (layer.type === 'balloon' && layer.balloonData)
        ) {
          syncVectorObjectLayerToGrid(layer, dims, grid);
        } else if (layer.type === 'vector' && layer.vectorStrokes?.length) {
          rerenderVectorLayerToGrid(layer, dims, grid);
        }
      });

      grid.notifyChange(true);
    },
    [
      activeSessionIdRef,
      activeTileGridRef,
      dimensionsRef,
      layersRef,
      setActiveLayerId,
      setLayers,
      thumbDebounceTimersRef,
    ]
  );

  return {
    addRemoteLayer,
    deleteRemoteLayer,
    applyRemoteLayerUpdate,
    applyRemoteLayerTree,
    applyRemoteMaskData,
    syncRemoteDocument,
  };
}
