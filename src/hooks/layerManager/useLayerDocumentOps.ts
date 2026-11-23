import { useCallback } from 'react';
import {
  CanvasColorMode,
  CanvasDimensions,
  LayerItem,
  LoadedDocument,
  TileDelta,
  hasTileBackedLayer,
  isFolderLikeLayer,
} from '../../types/editor';
import { createCanvasThumbnail } from '../../utils/canvasUtils';
import { documentStore } from '../../utils/documentStore';
import { multiplayerService } from '../../services/multiplayerService';
import { compositeCanvas } from '../../utils/saveManager/gpuComposite';
import { releaseTemporaryCanvas } from '../../utils/tileEngine';
import {
  computeMergeFolderLayers,
  createLayerTreeSnapshotDelta,
  isBackgroundLayerId,
} from './layerTreeOps';
import { LayerCanvasRegistryApi, LayerManagerContext } from './types';

export function useLayerDocumentOps(
  ctx: LayerManagerContext,
  canvasRegistry: Pick<LayerCanvasRegistryApi, 'updateLayerThumbnail'>
) {
  const {
    activeTileGridRef,
    dimensionsRef,
    activeSessionIdRef,
    defaultToneFrequencyRef,
    thumbDebounceTimersRef,
    setLayers,
    layersRef,
    activeLayerId,
    activeLayerIdRef,
    setActiveLayerId,
    setSelectedLayerIds,
    recordLayerHistory,
  } = ctx;
  const { updateLayerThumbnail } = canvasRegistry;

  // Clear active layer content directly in SparseTileGrid (zero forced full canvas allocation)
  const clearActiveLayer = useCallback(() => {
    const targetId = activeLayerIdRef.current || activeLayerId;
    if (!targetId) return;
    const grid = activeTileGridRef.current;
    const dims = dimensionsRef.current;
    const isBg = isBackgroundLayerId(targetId);

    const beforeSnapshot = grid.snapshotLayerTiles(targetId);
    if (isBg) {
      grid.fillLayerSolidWhite(targetId, dims.width, dims.height, 'color-32bit');
    } else {
      grid.clearLayer(targetId);
      grid.markLayerIngested(targetId);
    }

    const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, targetId, {
      x: 0,
      y: 0,
      width: dims.width,
      height: dims.height,
    });
    grid.notifyChange(true);
    updateLayerThumbnail(targetId, true);

    if (tileDeltas.length > 0) {
      recordLayerHistory('Clear Layer', targetId, undefined, tileDeltas, 'clear');
    }
  }, [activeLayerId, activeLayerIdRef, activeTileGridRef, dimensionsRef, recordLayerHistory, updateLayerThumbnail]);

  // Merge active raster layer down onto the raster layer directly below it (tile-by-tile, zero full-doc canvas)
  const mergeDown = useCallback(
    (targetLayerId?: string): { targetId: string; removedId: string } | null => {
      const currentLayers = layersRef.current;
      const beforeActiveLayerId = activeLayerIdRef.current;
      const srcId = targetLayerId || activeLayerIdRef.current || activeLayerId;
      const srcIdx = currentLayers.findIndex((l) => l.id === srcId);
      if (srcIdx < 0) return null;

      const srcLayer = currentLayers[srcIdx];
      if (!srcLayer || srcLayer.type !== 'raster' || srcLayer.locked) return null;

      // Find the next raster layer below (higher index in top-to-bottom stack)
      let dstIdx = -1;
      for (let i = srcIdx + 1; i < currentLayers.length; i++) {
        if (currentLayers[i].type === 'raster') {
          dstIdx = i;
          break;
        }
      }
      if (dstIdx < 0) return null;
      const dstLayer = currentLayers[dstIdx];
      if (dstLayer.locked) return null;

      const grid = activeTileGridRef.current;
      const dims = dimensionsRef.current;
      const dstFormat =
        dstLayer.expressionColor === 'monochrome'
          ? 'monochrome-1bit'
          : dstLayer.expressionColor === 'gray'
            ? 'grayscale-8bit'
            : 'color-32bit';

      // Snapshot both source layer tiles (which will be removed) and destination layer tiles (before merge)
      const srcTileDeltas: TileDelta[] = [];
      for (const t of grid.getLayerTiles(srcLayer.id, 0)) {
        if (t.data) {
          srcTileDeltas.push({
            key: `${srcLayer.id}:${t.tileX}:${t.tileY}`,
            format: t.format,
            beforeData: new Uint8Array(t.data),
            afterData: null,
          });
        }
      }
      const dstBeforeSnapshot = grid.snapshotLayerTiles(dstLayer.id);

      grid.mergeLayersInGrid(srcLayer.id, dstLayer.id, {
        opacity: srcLayer.opacity,
        blendMode: srcLayer.blendMode,
        visible: srcLayer.visible,
        maskCanvas: srcLayer.maskCanvas,
        maskEnabled: srcLayer.maskEnabled,
        dimensions: dims,
        dstFormat,
      });

      const dstTileDeltas = grid.computeDeltasFromSnapshot(dstBeforeSnapshot, dstLayer.id, {
        x: 0,
        y: 0,
        width: dims.width,
        height: dims.height,
      });
      // Ensure any newly created tiles on dstLayer that weren't in dstBeforeSnapshot are captured too
      const seenDstKeys = new Set(dstTileDeltas.map((d) => d.key));
      for (const t of grid.getLayerTiles(dstLayer.id, 0)) {
        const key = `${dstLayer.id}:${t.tileX}:${t.tileY}`;
        if (!seenDstKeys.has(key) && t.data && !dstBeforeSnapshot.has(key)) {
          dstTileDeltas.push({
            key,
            format: t.format,
            beforeData: null,
            afterData: new Uint8Array(t.data),
          });
        }
      }

      if (multiplayerService.isConnected()) {
        multiplayerService.streamLayerTiles(dstLayer.id, grid, { force: true });
      }

      const nextLayers = currentLayers.filter((l) => l.id !== srcLayer.id);
      const layerTreeDelta = createLayerTreeSnapshotDelta(
        currentLayers,
        nextLayers,
        beforeActiveLayerId,
        dstLayer.id,
        { cloneMasks: true }
      );
      layersRef.current = nextLayers;
      setLayers(nextLayers);
      setActiveLayerId(dstLayer.id);
      setSelectedLayerIds([dstLayer.id]);

      updateLayerThumbnail(dstLayer.id, true);
      recordLayerHistory(
        'Merge Down',
        dstLayer.id,
        layerTreeDelta,
        [...srcTileDeltas, ...dstTileDeltas],
        'layer'
      );
      return { targetId: dstLayer.id, removedId: srcLayer.id };
    },
    [activeLayerId, activeLayerIdRef, activeTileGridRef, dimensionsRef, layersRef, recordLayerHistory, setActiveLayerId, setLayers, setSelectedLayerIds, updateLayerThumbnail]
  );

  // Merge a folder (or frame-folder) and all of its descendants into a single raster layer
  const mergeFolder = useCallback(
    (
      targetFolderId?: string,
      customMergedId?: string
    ): {
      mergedLayerId: string;
      removedFolderId: string;
      removedDescendantIds: string[];
    } | null => {
      const currentLayers = layersRef.current;
      const beforeActiveLayerId = activeLayerIdRef.current;
      const folderId = targetFolderId || activeLayerIdRef.current || activeLayerId;
      const mergePlan = computeMergeFolderLayers(currentLayers, folderId, customMergedId);
      if (!mergePlan) return null;

      const { folder, descendantLayers, descendantIds, mergedLayer, nextLayers } = mergePlan;
      const grid = activeTileGridRef.current;
      const dims = dimensionsRef.current;

      const mergedFormat =
        mergedLayer.expressionColor === 'monochrome'
          ? 'monochrome-1bit'
          : mergedLayer.expressionColor === 'gray'
            ? 'grayscale-8bit'
            : 'color-32bit';

      // Snapshot all descendant tiles before mutating grid so undo restores everything atomically
      const removedTileDeltas: TileDelta[] = [];
      for (const descId of descendantIds) {
        for (const t of grid.getLayerTiles(descId, 0)) {
          if (t.data) {
            removedTileDeltas.push({
              key: `${descId}:${t.tileX}:${t.tileY}`,
              format: t.format,
              beforeData: new Uint8Array(t.data),
              afterData: null,
            });
          }
        }
      }

      // Render subtree with the root folder normalized to visible=true, opacity=1, blendMode='normal'
      // so the folder's own visibility, opacity, and blend mode stay non-destructively on mergedLayer.
      const rootForComposite: LayerItem = {
        ...folder,
        parentId: null,
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        maskCanvas: undefined,
        maskEnabled: false,
      };
      const subtreeLayers: LayerItem[] = [rootForComposite, ...descendantLayers];
      const subtreeMap = new Map<string, LayerItem>(subtreeLayers.map((l) => [l.id, l]));

      const getSubtreeOpacity = (layer: LayerItem): number => {
        let alpha = layer.opacity;
        let currParentId = layer.parentId;
        while (currParentId) {
          const parent = subtreeMap.get(currParentId);
          if (!parent) break;
          alpha *= parent.opacity;
          currParentId = parent.parentId;
        }
        return alpha;
      };

      const isSubtreeVisible = (layer: LayerItem): boolean => {
        let curr: LayerItem | undefined = layer;
        while (curr) {
          if (!curr.visible) return false;
          curr = curr.parentId ? subtreeMap.get(curr.parentId) : undefined;
        }
        return true;
      };

      const hasRenderableContent =
        folder.type === 'frame-folder' ||
        descendantLayers.some(
          (l) => !isFolderLikeLayer(l) && isSubtreeVisible(l) && getSubtreeOpacity(l) > 0.001
        );

      grid.setLayerFormat(mergedLayer.id, mergedFormat);
      grid.markLayerIngested(mergedLayer.id);

      if (hasRenderableContent && dims.width > 0 && dims.height > 0) {
        let hasCanvas2D = false;
        if (typeof document !== 'undefined') {
          const probe = document.createElement('canvas');
          probe.width = 1;
          probe.height = 1;
          hasCanvas2D = Boolean(probe.getContext('2d'));
          releaseTemporaryCanvas(probe);
        }

        if (hasCanvas2D) {
          const composited = compositeCanvas(
            dims,
            subtreeLayers,
            undefined,
            getSubtreeOpacity,
            isSubtreeVisible,
            false,
            grid
          );
          grid.ingestCanvas(mergedLayer.id, composited, mergedFormat);
          releaseTemporaryCanvas(composited);
        } else {
          // Headless / jsdom fallback when neither WebGL2 nor Canvas2D is available
          const bottomToTop = descendantLayers.slice().reverse();
          for (const child of bottomToTop) {
            if (!hasTileBackedLayer(child)) continue;
            if (!isSubtreeVisible(child)) continue;
            const effOpacity = getSubtreeOpacity(child);
            if (effOpacity <= 0.001 || !grid.hasLayerTiles(child.id)) continue;
            grid.mergeLayersInGrid(child.id, mergedLayer.id, {
              opacity: effOpacity,
              blendMode: child.blendMode,
              visible: true,
              maskCanvas: child.maskCanvas,
              maskEnabled: child.maskEnabled,
              dimensions: dims,
              dstFormat: mergedFormat,
            });
          }
        }
      }

      for (const remId of [folder.id, ...descendantIds]) {
        const timer = thumbDebounceTimersRef.current.get(remId);
        if (timer) {
          clearTimeout(timer);
          thumbDebounceTimersRef.current.delete(remId);
        }
        grid.clearLayer(remId);
      }

      const mergedTileDeltas: TileDelta[] = [];
      for (const t of grid.getLayerTiles(mergedLayer.id, 0)) {
        if (t.data) {
          mergedTileDeltas.push({
            key: `${mergedLayer.id}:${t.tileX}:${t.tileY}`,
            format: t.format,
            beforeData: null,
            afterData: new Uint8Array(t.data),
          });
        }
      }

      if (multiplayerService.isConnected()) {
        multiplayerService.streamLayerTiles(mergedLayer.id, grid, { force: true });
      }

      const layerTreeDelta = createLayerTreeSnapshotDelta(
        currentLayers,
        nextLayers,
        beforeActiveLayerId,
        mergedLayer.id,
        { cloneMasks: true }
      );
      layersRef.current = nextLayers;
      setLayers(nextLayers);
      setActiveLayerId(mergedLayer.id);
      setSelectedLayerIds([mergedLayer.id]);
      grid.notifyChange(true);
      updateLayerThumbnail(mergedLayer.id, true);

      recordLayerHistory(
        'Merge Folder',
        mergedLayer.id,
        layerTreeDelta,
        [...removedTileDeltas, ...mergedTileDeltas],
        'layer'
      );

      return {
        mergedLayerId: mergedLayer.id,
        removedFolderId: folder.id,
        removedDescendantIds: descendantIds,
      };
    },
    [
      activeLayerId,
      activeLayerIdRef,
      activeTileGridRef,
      dimensionsRef,
      layersRef,
      recordLayerHistory,
      setActiveLayerId,
      setLayers,
      setSelectedLayerIds,
      thumbDebounceTimersRef,
      updateLayerThumbnail,
    ]
  );

  // Switch active document tab in O(1): binds session's SparseTileGrid without clearing or re-slicing
  const switchDocumentSession = useCallback(
    (documentId: string, nextLayers: LayerItem[], nextActiveLayerId: string, nextDims?: CanvasDimensions) => {
      for (const timer of thumbDebounceTimersRef.current.values()) {
        clearTimeout(timer);
      }
      thumbDebounceTimersRef.current.clear();

      const session = documentStore.setActiveDocument(documentId) ?? documentStore.getOrCreateSession(documentId);
      activeSessionIdRef.current = documentId;
      activeTileGridRef.current = session.tileGrid;
      if (nextDims) {
        dimensionsRef.current = nextDims;
      }

      setLayers(nextLayers);
      layersRef.current = nextLayers;
      const resolvedActiveId =
        nextActiveLayerId && nextLayers.some((l) => l.id === nextActiveLayerId)
          ? nextActiveLayerId
          : (nextLayers.find((l) => l.type === 'raster')?.id || nextLayers[0]?.id || '');
      setActiveLayerId(resolvedActiveId);
      session.tileGrid.notifyChange(true);
    },
    [activeSessionIdRef, activeTileGridRef, dimensionsRef, layersRef, setActiveLayerId, setLayers, thumbDebounceTimersRef]
  );

  // Reset layers to a fresh canvas with specified background color (allocated directly in SparseTileGrid)
  const resetToNewCanvas = useCallback(
    (
      _dims: CanvasDimensions,
      backgroundColor: string = '#ffffff',
      _mode: CanvasColorMode = 'color',
      defaultToneFrequency: number = 60,
      targetDocumentId?: string
    ) => {
      defaultToneFrequencyRef.current = Math.max(20, Math.min(85, Math.round(defaultToneFrequency || 60)));
      dimensionsRef.current = _dims;

      for (const timer of thumbDebounceTimersRef.current.values()) {
        clearTimeout(timer);
      }
      thumbDebounceTimersRef.current.clear();

      let grid = activeTileGridRef.current;
      if (targetDocumentId) {
        const session = documentStore.setActiveDocument(targetDocumentId) ?? documentStore.getOrCreateSession(targetDocumentId);
        activeSessionIdRef.current = targetDocumentId;
        activeTileGridRef.current = session.tileGrid;
        grid = session.tileGrid;
      }

      grid.clearAll();

      const now = Date.now();
      const bgId = `layer-bg-${now}`;
      const topId = `layer-1-${now}`;

      // Initialize background directly in SparseTileGrid without creating full-size HTMLCanvasElement
      if (backgroundColor !== 'transparent') {
        grid.fillLayerSolidColor(bgId, _dims.width, _dims.height, backgroundColor, 'color-32bit');
      } else {
        grid.setLayerFormat(bgId, 'color-32bit');
        grid.markLayerIngested(bgId);
      }

      // Empty top layer: 0 tiles, 0 HTMLCanvasElement allocated
      const topFormat = _mode === 'monochrome' ? 'monochrome-1bit' : 'color-32bit';
      grid.setLayerFormat(topId, topFormat);
      grid.markLayerIngested(topId);

      const bgThumb = createCanvasThumbnail({ grid, layerId: bgId, dimensions: _dims }, false);

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
          thumbnailUrl: bgThumb,
        },
      ];

      setLayers(initialLayers);
      layersRef.current = initialLayers;
      setActiveLayerId(topId);
      grid.notifyChange(true);
      return { layers: initialLayers, activeLayerId: topId };
    },
    [activeSessionIdRef, activeTileGridRef, defaultToneFrequencyRef, dimensionsRef, layersRef, setActiveLayerId, setLayers, thumbDebounceTimersRef]
  );

  // Clear all layers and canvas references when no document is active
  const clearDocument = useCallback(() => {
    for (const timer of thumbDebounceTimersRef.current.values()) {
      clearTimeout(timer);
    }
    thumbDebounceTimersRef.current.clear();
    setLayers([]);
    layersRef.current = [];
    setActiveLayerId('');
  }, [layersRef, setActiveLayerId, setLayers, thumbDebounceTimersRef]);

  // Import an external document (from PSD, CSP, Image, or Crash Recovery) into its own isolated session.
  // Any legacy import canvases are immediately ingested into SparseTileGrid and released.
  const loadDocument = useCallback(
    (doc: LoadedDocument, targetDocumentId?: string, skipIngest: boolean = false) => {
      for (const timer of thumbDebounceTimersRef.current.values()) {
        clearTimeout(timer);
      }
      thumbDebounceTimersRef.current.clear();

      dimensionsRef.current = doc.dimensions;
      let grid = activeTileGridRef.current;
      if (targetDocumentId) {
        const session = documentStore.setActiveDocument(targetDocumentId) ?? documentStore.getOrCreateSession(targetDocumentId);
        activeSessionIdRef.current = targetDocumentId;
        activeTileGridRef.current = session.tileGrid;
        grid = session.tileGrid;
      }

      const restoredFormats = doc.tileGrid ? doc.tileGrid.getAllLayerFormats() : null;
      if (!skipIngest) {
        if (doc.tileGrid && doc.tileGrid !== grid) {
          grid.restoreFromSnapshot(doc.tileGrid.getAllTiles(), restoredFormats || undefined);
          doc.tileGrid.clearAll();
        } else if (!doc.tileGrid) {
          grid.clearAll();
        }
      }

      for (const l of doc.layers) {
        if (hasTileBackedLayer(l)) {
          const existingFormat = restoredFormats?.get(l.id);
          const inferredFormat =
            existingFormat ??
            (l.expressionColor === 'monochrome'
              ? 'monochrome-1bit'
              : l.expressionColor === 'gray'
                ? 'grayscale-8bit'
                : 'color-32bit');
          grid.setLayerFormat(l.id, inferredFormat);
          grid.markLayerIngested(l.id);
        }
      }

      if (!skipIngest && doc.layerCanvases) {
        doc.layerCanvases.forEach((c, id) => {
          const layerMeta = doc.layers.find((l) => l.id === id);
          const isMono = layerMeta?.expressionColor === 'monochrome';
          grid.ingestCanvas(id, c, isMono ? 'monochrome-1bit' : 'color-32bit');
          releaseTemporaryCanvas(c);
        });
      }

      setLayers(doc.layers);
      layersRef.current = doc.layers;
      const topRaster = doc.layers.find((l) => l.type === 'raster');
      setActiveLayerId(topRaster ? topRaster.id : doc.layers[0]?.id || '');
      grid.notifyChange(true);
    },
    [activeSessionIdRef, activeTileGridRef, dimensionsRef, layersRef, setActiveLayerId, setLayers, thumbDebounceTimersRef]
  );

  return {
    clearActiveLayer,
    mergeDown,
    mergeFolder,
    switchDocumentSession,
    resetToNewCanvas,
    clearDocument,
    loadDocument,
  };
}
