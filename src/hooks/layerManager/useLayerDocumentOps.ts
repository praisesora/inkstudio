import { useCallback } from 'react';
import {
  CanvasColorMode,
  CanvasDimensions,
  LayerItem,
  LoadedDocument,
  hasTileBackedLayer,
} from '../../types/editor';
import { createCanvasThumbnail } from '../../utils/canvasUtils';
import { documentStore } from '../../utils/documentStore';
import { multiplayerService } from '../../services/multiplayerService';
import { releaseTemporaryCanvas } from '../../utils/tileEngine';
import { isBackgroundLayerId } from './layerTreeOps';
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
    setActiveLayerId,
    setSelectedLayerIds,
  } = ctx;
  const { updateLayerThumbnail } = canvasRegistry;

  // Clear active layer content directly in SparseTileGrid (zero forced full canvas allocation)
  const clearActiveLayer = useCallback(() => {
    const grid = activeTileGridRef.current;
    const dims = dimensionsRef.current;
    const isBg = isBackgroundLayerId(activeLayerId);

    if (isBg) {
      grid.fillLayerSolidWhite(activeLayerId, dims.width, dims.height, 'color-32bit');
    } else {
      grid.clearLayer(activeLayerId);
      grid.markLayerIngested(activeLayerId);
    }

    grid.notifyChange(true);
    updateLayerThumbnail(activeLayerId);
  }, [activeLayerId, activeTileGridRef, dimensionsRef, updateLayerThumbnail]);

  // Merge active raster layer down onto the raster layer directly below it (tile-by-tile, zero full-doc canvas)
  const mergeDown = useCallback(
    (targetLayerId?: string): { targetId: string; removedId: string } | null => {
      const currentLayers = layersRef.current;
      const srcId = targetLayerId || activeLayerId;
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
      const dstFormat =
        dstLayer.expressionColor === 'monochrome'
          ? 'monochrome-1bit'
          : dstLayer.expressionColor === 'gray'
            ? 'grayscale-8bit'
            : 'color-32bit';

      grid.mergeLayersInGrid(srcLayer.id, dstLayer.id, {
        opacity: srcLayer.opacity,
        blendMode: srcLayer.blendMode,
        visible: srcLayer.visible,
        maskCanvas: srcLayer.maskCanvas,
        maskEnabled: srcLayer.maskEnabled,
        dimensions: dimensionsRef.current,
        dstFormat,
      });

      if (multiplayerService.isConnected()) {
        multiplayerService.streamLayerTiles(dstLayer.id, grid, { force: true });
      }

      if (srcLayer.maskCanvas) {
        releaseTemporaryCanvas(srcLayer.maskCanvas);
      }

      const nextLayers = currentLayers.filter((l) => l.id !== srcLayer.id);
      layersRef.current = nextLayers;
      setLayers(nextLayers);
      setActiveLayerId(dstLayer.id);
      setSelectedLayerIds([dstLayer.id]);

      updateLayerThumbnail(dstLayer.id);
      return { targetId: dstLayer.id, removedId: srcLayer.id };
    },
    [activeLayerId, activeTileGridRef, dimensionsRef, layersRef, setActiveLayerId, setLayers, setSelectedLayerIds, updateLayerThumbnail]
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
    switchDocumentSession,
    resetToNewCanvas,
    clearDocument,
    loadDocument,
  };
}
