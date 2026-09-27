import { useState, useRef, useCallback, useEffect } from 'react';
import { LayerItem, BlendMode, CanvasDimensions, CanvasColorMode, LoadedDocument, ExpressionColor, CanvasSelection, DirtyRect } from '../types/editor';
import { ResizeCanvasOptions } from '../types/settings';
import { createCanvasThumbnail, get2DContext } from '../utils/canvasUtils';
import { applyLayerEffects, applyExpressionColorToImageData } from '../utils/layerEffectsEngine';
import { HalftoneDotShape } from '../utils/screentoneEngine';

interface UseLayerManagerProps {
  dimensions: CanvasDimensions;
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

export function useLayerManager({ dimensions: _dimensions }: UseLayerManagerProps) {
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
  const [activeLayerId, setActiveLayerId] = useState<string>('');

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
            }
          } else {
            ctx.drawImage(initialData, 0, 0);
          }
        }
        pendingInitialDataRef.current.delete(id);
      } else if (id === 'layer-bg' || id.startsWith('layer-bg')) {
        // If it's the background layer and uninitialized, fill with solid white
        const ctx = get2DContext(canvas);
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
      }

      // Defer initial thumbnail generation to avoid triggering re-render during ref attachment
      requestAnimationFrame(() => {
        const c = layerCanvasesRef.current.get(id);
        if (c) {
          const thumb = createCanvasThumbnail(c, id !== 'layer-bg');
          setLayers((prev) =>
            prev.map((l) => (l.id === id && !l.thumbnailUrl ? { ...l, thumbnailUrl: thumb } : l))
          );
        }
      });
    } else {
      layerCanvasesRef.current.delete(id);
    }
  }, []);

  const thumbDebounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Update a single layer's thumbnail after drawing or editing (debounced to avoid React re-renders during rapid sketching)
  const updateLayerThumbnail = useCallback((id: string, immediate: boolean = false) => {
    const run = () => {
      const canvas = layerCanvasesRef.current.get(id);
      if (!canvas) return;

      const thumb = createCanvasThumbnail(canvas, id !== 'layer-bg');
      setLayers((prev) =>
        prev.map((l) => (l.id === id ? { ...l, thumbnailUrl: thumb } : l))
      );
    };

    const existing = thumbDebounceTimersRef.current.get(id);
    if (existing) clearTimeout(existing);

    if (immediate) {
      thumbDebounceTimersRef.current.delete(id);
      run();
    } else {
      const timer = setTimeout(() => {
        thumbDebounceTimersRef.current.delete(id);
        run();
      }, 150);
      thumbDebounceTimersRef.current.set(id, timer);
    }
  }, []);

  // Add a new raster layer or folder
  const addLayer = useCallback(
    (
      type: 'raster' | 'folder' = 'raster',
      explicitParentId?: string | null,
      customName?: string,
      customId?: string
    ): LayerItem => {
      let createdLayer: LayerItem | null = null;
      const id = customId || `${type}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

      setLayers((prev) => {
        // Find active layer to determine placement
        const activeIdx = prev.findIndex((l) => l.id === activeLayerId);
        const activeLayer = prev[activeIdx];

        let parentId: string | null = null;
        if (explicitParentId !== undefined) {
          parentId = explicitParentId;
        } else if (activeLayer) {
          if (activeLayer.type === 'folder') {
            parentId = activeLayer.id;
          } else {
            parentId = activeLayer.parentId;
          }
        }

        let name = customName;
        if (!name) {
          let count = 1;
          const prefix = type === 'folder' ? 'Folder ' : 'Layer ';
          prev.forEach((l) => {
            if (l.type === type && l.name.startsWith(prefix)) {
              const num = parseInt(l.name.replace(prefix, ''), 10);
              if (!isNaN(num) && num >= count) {
                count = num + 1;
              }
            }
          });
          name = `${prefix}${count}`;
        }

        const newLayer: LayerItem = {
          id,
          name,
          type,
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          collapsed: false,
          parentId,
          thumbnailUrl: '',
          expressionColor: activeLayer?.expressionColor === 'monochrome' ? 'monochrome' : activeLayer?.expressionColor === 'gray' ? 'gray' : 'color',
          monoThreshold: activeLayer?.monoThreshold ?? 128,
          monoExpressBlack: activeLayer?.monoExpressBlack ?? true,
          monoExpressWhite: activeLayer?.monoExpressWhite ?? true,
        };
        createdLayer = newLayer;

        const insertIndex = activeIdx >= 0 ? activeIdx : 0;
        const nextLayers = [...prev];
        nextLayers.splice(insertIndex, 0, newLayer);
        return nextLayers;
      });

      setActiveLayerId(id);
      return createdLayer!;
    },
    [activeLayerId]
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
        const bgIdx = next.findIndex((l) => l.id === 'layer-bg' || l.id.startsWith('layer-bg'));
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
        const topRaster = syncedLayers.find((l) => l.type === 'raster' && l.id !== 'layer-bg' && !l.id.startsWith('layer-bg'));
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
    [updateLayerThumbnail]
  );

  // Duplicate an existing layer with a single click
  const duplicateLayer = useCallback((id: string) => {
    setLayers((prev) => {
      const sourceIdx = prev.findIndex((l) => l.id === id);
      if (sourceIdx < 0) return prev;

      const source = prev[sourceIdx];
      const newId = `${source.type}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

      if (source.type === 'raster') {
        // Record pending copy so when canvas mounts it copies pixel data
        pendingCanvasCopiesRef.current.set(newId, source.id);

        // Also duplicate offscreen source canvas if it exists
        const srcSource = layerSourceCanvasesRef.current.get(source.id);
        if (srcSource) {
          const newSource = document.createElement('canvas');
          newSource.width = srcSource.width;
          newSource.height = srcSource.height;
          get2DContext(newSource)?.drawImage(srcSource, 0, 0);
          layerSourceCanvasesRef.current.set(newId, newSource);
        }

        const newLayer: LayerItem = {
          ...source,
          id: newId,
          name: `${source.name} Copy`,
          thumbnailUrl: source.thumbnailUrl,
        };

        const nextLayers = [...prev];
        nextLayers.splice(sourceIdx, 0, newLayer);
        setActiveLayerId(newId);
        return nextLayers;
      } else {
        // Duplicate folder and all child layers inside
        const folderCopyId = newId;
        const newFolder: LayerItem = {
          ...source,
          id: folderCopyId,
          name: `${source.name} Copy`,
        };

        // Find all child layers inside this folder
        const childLayers = prev.filter((l) => l.parentId === source.id);
        const childCopies: LayerItem[] = childLayers.map((child) => {
          const childCopyId = `raster-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
          pendingCanvasCopiesRef.current.set(childCopyId, child.id);
          return {
            ...child,
            id: childCopyId,
            name: `${child.name} Copy`,
            parentId: folderCopyId,
          };
        });

        const nextLayers = [...prev];
        nextLayers.splice(sourceIdx, 0, newFolder, ...childCopies);
        setActiveLayerId(folderCopyId);
        return nextLayers;
      }
    });
  }, []);

  // Delete a layer or folder
  const deleteLayer = useCallback((id: string) => {
    setLayers((prev) => {
      // Don't delete if it's the only raster layer
      const rasterCount = prev.filter((l) => l.type === 'raster').length;
      const target = prev.find((l) => l.id === id);
      if (!target) return prev;

      if (target.type === 'raster' && rasterCount <= 1) {
        return prev;
      }

      // If deleting folder, also delete all child layers
      let nextLayers: LayerItem[];
      if (target.type === 'folder') {
        nextLayers = prev.filter((l) => l.id !== id && l.parentId !== id);
      } else {
        nextLayers = prev.filter((l) => l.id !== id);
      }

      // If deleted active layer, choose next available layer
      if (activeLayerId === id || (target.type === 'folder' && prev.find((l) => l.id === activeLayerId)?.parentId === id)) {
        const nextActive = nextLayers.find((l) => l.type === 'raster') || nextLayers[0];
        if (nextActive) {
          setActiveLayerId(nextActive.id);
        }
      }

      layerCanvasesRef.current.delete(id);
      layerSourceCanvasesRef.current.delete(id);
      return nextLayers;
    });
  }, [activeLayerId]);

  // Toggle visibility of a layer or folder
  const toggleVisibility = useCallback((id: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l))
    );
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

  // Toggle locked state
  const toggleLock = useCallback((id: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, locked: !l.locked } : l))
    );
  }, []);

  // Toggle folder collapse state
  const toggleCollapse = useCallback((id: string) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, collapsed: !l.collapsed } : l))
    );
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

  // Reorder layer via drag-and-drop
  const reorderLayers = useCallback((draggedId: string, targetId: string, position: 'above' | 'below' | 'inside') => {
    if (draggedId === targetId) return;

    setLayers((prev) => {
      const draggedIdx = prev.findIndex((l) => l.id === draggedId);
      const targetIdx = prev.findIndex((l) => l.id === targetId);
      if (draggedIdx < 0 || targetIdx < 0) return prev;

      const draggedItem = { ...prev[draggedIdx] };
      const targetItem = prev[targetIdx];

      if (position === 'inside' && targetItem.type === 'folder') {
        draggedItem.parentId = targetItem.id;
      } else {
        draggedItem.parentId = targetItem.parentId;
      }

      const next = [...prev];
      next.splice(draggedIdx, 1);

      const newTargetIdx = next.findIndex((l) => l.id === targetId);
      let insertIdx = newTargetIdx;

      if (position === 'above') {
        insertIdx = newTargetIdx;
      } else if (position === 'below' || position === 'inside') {
        insertIdx = newTargetIdx + 1;
      }

      next.splice(insertIdx, 0, draggedItem);
      return next;
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

    if (activeLayerId === 'layer-bg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    const sCanvas = layerSourceCanvasesRef.current.get(activeLayerId);
    if (sCanvas) {
      const sCtx = get2DContext(sCanvas);
      if (sCtx) {
        if (activeLayerId === 'layer-bg') {
          sCtx.fillStyle = '#ffffff';
          sCtx.fillRect(0, 0, sCanvas.width, sCanvas.height);
        } else {
          sCtx.clearRect(0, 0, sCanvas.width, sCanvas.height);
        }
      }
    }

    updateLayerThumbnail(activeLayerId);
  }, [activeLayerId, updateLayerThumbnail]);

  // Reset layers to a fresh canvas with specified background color
  const resetToNewCanvas = useCallback(
    (_dims: CanvasDimensions, backgroundColor: string = '#ffffff', _mode: CanvasColorMode = 'color', defaultToneFrequency: number = 60) => {
      defaultToneFrequencyRef.current = Math.max(20, Math.min(85, Math.round(defaultToneFrequency || 60)));
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
    []
  );

  // Clear all layers and canvas references when no document is active
  const clearDocument = useCallback(() => {
    pendingCanvasCopiesRef.current.clear();
    pendingInitialDataRef.current.clear();
    layerCanvasesRef.current.clear();
    layerSourceCanvasesRef.current.clear();
    setLayers([]);
    setActiveLayerId('');
  }, []);

  // Load an entire document (from PSD, CSP, or Image)
  const loadDocument = useCallback((doc: LoadedDocument) => {
    pendingCanvasCopiesRef.current.clear();
    pendingInitialDataRef.current.clear();
    layerCanvasesRef.current.clear();
    layerSourceCanvasesRef.current.clear();

    if (doc.layerCanvases) {
      doc.layerCanvases.forEach((c, id) => {
        pendingInitialDataRef.current.set(id, c);
        const layerMeta = doc.layers.find((l) => l.id === id);
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
  }, []);

  // Internal Layer Clipboard
  const layerClipboardRef = useRef<{
    name: string;
    type: 'raster' | 'folder';
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
      customId?: string
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
        const parentId = activeItem?.type === 'folder' ? activeItem.id : (activeItem?.parentId || null);

        const newLayer: LayerItem = {
          id: newId,
          name: layerName,
          type: 'raster',
          visible: true,
          opacity,
          blendMode,
          locked: false,
          collapsed: false,
          parentId,
          thumbnailUrl: thumb,
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
          if (selection.type === 'rect') {
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

      // Re-apply screentone and layer effects for layers that have them enabled
      layers.forEach((l) => {
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

      setLayers((prev) =>
        prev.map((l) => {
          const newThumb = updatedThumbnails.get(l.id);
          return newThumb ? { ...l, thumbnailUrl: newThumb } : l;
        })
      );
    },
    [_dimensions, layers]
  );

  // Get active layer object
  const activeLayer = layers.find((l) => l.id === activeLayerId) || layers[0];

  return {
    layers,
    setLayers,
    activeLayerId,
    setActiveLayerId,
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
  };
}

