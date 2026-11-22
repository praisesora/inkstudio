import { useCallback, useEffect } from 'react';
import { createCanvasThumbnail } from '../../utils/canvasUtils';
import { isBackgroundLayerId } from './layerTreeOps';
import { LayerCanvasRegistryApi, LayerManagerContext } from './types';

export function useLayerCanvasRegistry(ctx: LayerManagerContext): LayerCanvasRegistryApi {
  const {
    dimensions,
    activeTileGridRef,
    dimensionsRef,
    activeSessionIdRef,
    thumbDebounceTimersRef,
    setLayers,
  } = ctx;

  // Cleanup debounce timers on unmount
  useEffect(() => {
    const timers = thumbDebounceTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, [thumbDebounceTimersRef]);

  // Update a single layer's thumbnail directly from SparseTileGrid LOD 3 (zero full-canvas read)
  const updateLayerThumbnail = useCallback((id: string, immediate: boolean = false) => {
    const capturedGrid = activeTileGridRef.current;
    const capturedDocId = activeSessionIdRef.current;
    const run = () => {
      if (capturedDocId !== activeSessionIdRef.current) return;
      const dims = dimensionsRef.current;
      const thumb = createCanvasThumbnail(
        { grid: capturedGrid, layerId: id, dimensions: dims },
        !isBackgroundLayerId(id)
      );

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
      const isLargeDoc = dimensions.width * dimensions.height > 1024 * 1024;
      const delayMs = isLargeDoc ? 900 : 350;
      const timer = setTimeout(() => {
        thumbDebounceTimersRef.current.delete(id);
        run();
      }, delayMs);
      thumbDebounceTimersRef.current.set(id, timer);
    }
  }, [dimensions, activeSessionIdRef, activeTileGridRef, dimensionsRef, setLayers, thumbDebounceTimersRef]);

  return {
    updateLayerThumbnail,
  };
}
