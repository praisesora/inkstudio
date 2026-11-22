import { useRef, useCallback } from 'react';
import {
  BlendMode,
  CanvasSelection,
  LayerItem,
  isFolderLikeLayer,
} from '../../types/editor';
import { createCanvasThumbnail } from '../../utils/canvasUtils';
import { LayerInsertTarget, sanitizeImportedLayerName } from '../../utils/fileDropImport';
import { HalftoneDotShape } from '../../utils/screentoneEngine';
import { fillSelectionInTileGrid } from '../../utils/selectionUtils';
import { TileDelta, TileFormat, releaseTemporaryCanvas } from '../../utils/tileEngine';
import { LayerManagerContext } from './types';

export function useLayerClipboard(ctx: LayerManagerContext) {
  const {
    dimensions,
    activeTileGridRef,
    dimensionsRef,
    defaultToneFrequencyRef,
    layers,
    setLayers,
    layersRef,
    activeLayerId,
    setActiveLayerId,
    activeLayerIdRef,
  } = ctx;

  // Internal Layer Clipboard (tile-backed; zero full-doc HTMLCanvasElement allocation)
  const layerClipboardRef = useRef<{
    name: string;
    type: LayerItem['type'];
    blendMode: BlendMode;
    opacity: number;
    tileSnapshot: {
      format: TileFormat;
      tiles: Array<{ tileX: number; tileY: number; format: TileFormat; data: Uint8Array }>;
    };
  } | null>(null);

  const insertNewLayerItem = useCallback(
    (
      newId: string,
      layerName: string,
      blendMode: BlendMode,
      opacity: number,
      thumb: string,
      layerOverrides?: Partial<LayerItem>,
      insertTarget?: LayerInsertTarget
    ) => {
      setLayers((prev) => {
        const getSubtreeEndIndex = (list: LayerItem[], folderIndex: number): number => {
          const folderId = list[folderIndex].id;
          const subtreeIds = new Set<string>([folderId]);
          let endIdx = folderIndex + 1;
          while (endIdx < list.length) {
            const item = list[endIdx];
            if (item.parentId && subtreeIds.has(item.parentId)) {
              subtreeIds.add(item.id);
              endIdx++;
            } else {
              break;
            }
          }
          return endIdx;
        };

        let insertIdx = 0;
        let resolvedParentId: string | null = null;
        let expandFolderId: string | null = null;

        const targetIdx = insertTarget?.targetLayerId
          ? prev.findIndex((l) => l.id === insertTarget.targetLayerId)
          : -1;

        if (targetIdx >= 0) {
          const targetItem = prev[targetIdx];
          const pos = insertTarget?.position || (isFolderLikeLayer(targetItem) ? 'inside' : 'above');
          if (pos === 'inside' && isFolderLikeLayer(targetItem)) {
            resolvedParentId = targetItem.id;
            insertIdx = targetIdx + 1;
            if (targetItem.collapsed) expandFolderId = targetItem.id;
          } else if (pos === 'below') {
            resolvedParentId = targetItem.parentId;
            insertIdx = isFolderLikeLayer(targetItem)
              ? getSubtreeEndIndex(prev, targetIdx)
              : targetIdx + 1;
          } else {
            resolvedParentId = targetItem.parentId;
            insertIdx = targetIdx;
          }
        } else {
          const activeIdx = prev.findIndex((l) => l.id === activeLayerIdRef.current);
          const activeItem = activeIdx >= 0 ? prev[activeIdx] : undefined;
          if (activeItem && isFolderLikeLayer(activeItem)) {
            resolvedParentId = activeItem.id;
            insertIdx = activeIdx + 1;
            if (activeItem.collapsed) expandFolderId = activeItem.id;
          } else {
            resolvedParentId = activeItem?.parentId || null;
            insertIdx = activeIdx >= 0 ? activeIdx : 0;
          }
        }

        const newLayer: LayerItem = {
          id: newId,
          name: layerName,
          type: layerOverrides?.type || 'raster',
          visible: true,
          opacity,
          blendMode,
          locked: false,
          collapsed: false,
          parentId: layerOverrides?.parentId !== undefined ? layerOverrides.parentId : resolvedParentId,
          thumbnailUrl: thumb,
          ...layerOverrides,
        };

        const nextLayers = expandFolderId
          ? prev.map((l) => (l.id === expandFolderId ? { ...l, collapsed: false } : l))
          : [...prev];
        nextLayers.splice(insertIdx, 0, newLayer);
        layersRef.current = nextLayers;
        return nextLayers;
      });
    },
    [activeLayerIdRef, layersRef, setLayers]
  );

  // Paste a canvas directly into SparseTileGrid as a new raster layer (no duplicate full canvas retained)
  const pasteLayerFromCanvas = useCallback(
    (
      sourceCanvas: HTMLCanvasElement,
      layerName: string = 'Pasted Layer',
      blendMode: BlendMode = 'normal',
      opacity: number = 1,
      customId?: string,
      layerOverrides?: Partial<LayerItem>,
      insertTarget?: LayerInsertTarget
    ) => {
      const newId = customId || `raster-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const grid = activeTileGridRef.current;
      const isMono = layerOverrides?.expressionColor === 'monochrome';
      grid.ingestCanvas(newId, sourceCanvas, isMono ? 'monochrome-1bit' : 'color-32bit');
      grid.notifyChange(true);

      const dims = dimensionsRef.current;
      const thumb = createCanvasThumbnail({ grid, layerId: newId, dimensions: dims }, true);
      insertNewLayerItem(newId, layerName, blendMode, opacity, thumb, layerOverrides, insertTarget);
      setActiveLayerId(newId);
      return newId;
    },
    [activeTileGridRef, dimensionsRef, insertNewLayerItem, setActiveLayerId]
  );

  // Fill selection with non-destructive screentone layer directly in SparseTileGrid (GPU renders dots)
  const fillScreentoneSelection = useCallback(
    (
      selection: CanvasSelection | null,
      density: number = 40,
      frequency: number = defaultToneFrequencyRef.current ?? 60,
      angle: number = 45,
      dotShape: HalftoneDotShape = 'circle',
      densityType: 'specified' | 'image' = 'specified'
    ): { id: string; tileDeltas: TileDelta[] } => {
      const resolvedFreq = frequency || defaultToneFrequencyRef.current || 60;
      const resolvedDensity = Math.max(1, Math.min(100, Math.round(density <= 1.0 && density > 0 ? density * 100 : density)));
      const newId = `raster-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const grid = activeTileGridRef.current;

      // Continuous source value: black ink in 'specified' mode, grayscale value in 'image' mode
      const grayVal = densityType === 'specified' ? 0 : Math.round(255 * (1 - resolvedDensity / 100));
      const fillCss = `rgb(${grayVal},${grayVal},${grayVal})`;

      let tileDeltas: TileDelta[] = [];
      if (selection) {
        const res = fillSelectionInTileGrid({
          grid,
          layerId: newId,
          dimensions,
          selection,
          colorCss: fillCss,
          targetFormat: 'color-32bit',
        });
        tileDeltas = res.tileDeltas;
      } else {
        const beforeSnapshot = grid.snapshotLayerTiles(newId);
        grid.fillLayerSolidColor(newId, dimensions.width, dimensions.height, fillCss, 'color-32bit');
        tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, newId);
      }

      const thumb = createCanvasThumbnail({ grid, layerId: newId, dimensions }, true);
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
        thumbnailUrl: thumb,
        toneEnabled: true,
        toneFrequency: resolvedFreq,
        toneAngle: angle,
        toneDotShape: dotShape,
        toneDensity: resolvedDensity,
        toneDensityType: densityType,
      };

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
          grid.fillLayerSolidWhite(bgId, dimensions.width, dimensions.height, 'color-32bit');
          const bgThumb = createCanvasThumbnail({ grid, layerId: bgId, dimensions }, false);
          const bgLayer: LayerItem = {
            id: bgId,
            name: 'Background',
            type: 'raster',
            visible: true,
            opacity: 1,
            blendMode: 'normal',
            locked: true,
            parentId: null,
            thumbnailUrl: bgThumb,
          };
          nextLayers = [...nextLayers, bgLayer];
        }

        return nextLayers;
      });

      grid.notifyChange(true);
      setActiveLayerId(newId);
      return { id: newId, tileDeltas };
    },
    [activeLayerId, activeTileGridRef, defaultToneFrequencyRef, dimensions, setActiveLayerId, setLayers]
  );

  // Copy selected layer into sparse tile snapshot (zero retained full-doc HTMLCanvasElement)
  const copyLayer = useCallback(
    (targetId?: string): LayerItem | null => {
      const id = targetId || activeLayerId;
      const targetLayer = layers.find((l) => l.id === id);
      if (!targetLayer) return null;

      const grid = activeTileGridRef.current;
      const tileSnapshot = grid.copyLayerTilesSnapshot(id);

      layerClipboardRef.current = {
        name: targetLayer.name,
        type: targetLayer.type,
        blendMode: targetLayer.blendMode,
        opacity: targetLayer.opacity,
        tileSnapshot,
      };

      // Best-effort export to system clipboard (only bounded tight region to avoid 278MB transient spikes)
      try {
        if (navigator.clipboard && window.isSecureContext) {
          const dims = dimensionsRef.current;
          const bounds = grid.getLayerContentBounds(id, dims, false);
          if (bounds && bounds.width * bounds.height <= 4096 * 4096) {
            const temp = grid.createRegionCanvas(id, bounds);
            if (temp) {
              temp.toBlob((blob) => {
                releaseTemporaryCanvas(temp);
                if (blob && navigator.clipboard && window.isSecureContext) {
                  navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {});
                }
              });
            }
          }
        }
      } catch {
        // Ignore clipboard write restrictions
      }

      return targetLayer;
    },
    [activeLayerId, activeTileGridRef, dimensionsRef, layers]
  );

  // Paste layer from internal sparse tile clipboard or system clipboard
  const pasteLayer = useCallback(async (): Promise<{ success: boolean; layerName?: string }> => {
    // 1. Check internal tile-backed clipboard (zero full-doc canvas)
    if (layerClipboardRef.current) {
      const data = layerClipboardRef.current;
      const newName = `${data.name} Copy`;
      const newId = `raster-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const grid = activeTileGridRef.current;
      grid.pasteLayerTilesSnapshot(newId, data.tileSnapshot);
      const thumb = createCanvasThumbnail({ grid, layerId: newId, dimensions: dimensionsRef.current }, true);
      insertNewLayerItem(newId, newName, data.blendMode, data.opacity, thumb);
      setActiveLayerId(newId);
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

            const scale = Math.min(1, Math.min(dimensions.width / img.naturalWidth, dimensions.height / img.naturalHeight));
            const dw = Math.max(1, Math.round(img.naturalWidth * scale));
            const dh = Math.max(1, Math.round(img.naturalHeight * scale));
            const dx = Math.round((dimensions.width - dw) / 2);
            const dy = Math.round((dimensions.height - dh) / 2);

            const tight = document.createElement('canvas');
            tight.width = dw;
            tight.height = dh;
            const c2d = tight.getContext('2d', { willReadFrequently: true });
            const newId = `raster-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
            const grid = activeTileGridRef.current;
            if (c2d) {
              c2d.drawImage(img, 0, 0, dw, dh);
              const imgData = c2d.getImageData(0, 0, dw, dh);
              grid.writeImageData(newId, imgData, dx, dy, 'color-32bit');
            }
            URL.revokeObjectURL(url);
            releaseTemporaryCanvas(tight);

            const newName = 'Pasted Image';
            const thumb = createCanvasThumbnail({ grid, layerId: newId, dimensions }, true);
            insertNewLayerItem(newId, newName, 'normal', 1, thumb);
            setActiveLayerId(newId);
            grid.notifyChange(true);
            return { success: true, layerName: newName };
          }
        }
      }
    } catch (err) {
      console.warn('System clipboard read failed:', err);
    }

    return { success: false };
  }, [activeTileGridRef, dimensions, dimensionsRef, insertNewLayerItem, setActiveLayerId]);

  // Import an image file directly as a centered/fitted raster layer (tight-sized canvas -> tiles)
  const importImageFileAsLayer = useCallback(
    async (file: File, insertTarget?: LayerInsertTarget): Promise<{ id: string; name: string }> => {
      const decodeImage = (): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const canUseObjectUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
          if (canUseObjectUrl) {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
              URL.revokeObjectURL(url);
              resolve(img);
            };
            img.onerror = () => {
              URL.revokeObjectURL(url);
              reject(new Error(`Failed to decode image "${file.name}".`));
            };
            img.src = url;
            return;
          }

          const reader = new FileReader();
          reader.onload = (e) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Failed to decode image "${file.name}".`));
            img.src = e.target?.result as string;
          };
          reader.onerror = () => reject(new Error(`Failed to read file "${file.name}".`));
          reader.readAsDataURL(file);
        });

      const img = await decodeImage();
      const natW = img.naturalWidth || img.width;
      const natH = img.naturalHeight || img.height;
      if (natW <= 0 || natH <= 0) {
        throw new Error(`Image "${file.name}" has invalid dimensions.`);
      }

      const dims = dimensionsRef.current;
      const scale = Math.min(1, dims.width / natW, dims.height / natH);
      const dw = Math.max(1, Math.round(natW * scale));
      const dh = Math.max(1, Math.round(natH * scale));
      const dx = Math.round((dims.width - dw) / 2);
      const dy = Math.round((dims.height - dh) / 2);

      const newId = `raster-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const grid = activeTileGridRef.current;
      const tight = document.createElement('canvas');
      tight.width = dw;
      tight.height = dh;
      const c2d = tight.getContext('2d', { willReadFrequently: true });
      if (c2d) {
        c2d.imageSmoothingEnabled = true;
        c2d.imageSmoothingQuality = 'high';
        c2d.drawImage(img, 0, 0, dw, dh);
        const imgData = c2d.getImageData(0, 0, dw, dh);
        grid.writeImageData(newId, imgData, dx, dy, 'color-32bit');
      }
      releaseTemporaryCanvas(tight);

      const layerName = sanitizeImportedLayerName(file.name);
      const thumb = createCanvasThumbnail({ grid, layerId: newId, dimensions: dims }, true);
      insertNewLayerItem(newId, layerName, 'normal', 1, thumb, undefined, insertTarget);
      setActiveLayerId(newId);
      grid.notifyChange(true);
      return { id: newId, name: layerName };
    },
    [activeTileGridRef, dimensionsRef, insertNewLayerItem, setActiveLayerId]
  );

  // Paste a photo from file
  const pasteLayerFromFile = useCallback(
    async (file: File, insertTarget?: LayerInsertTarget): Promise<string> => {
      const { name } = await importImageFileAsLayer(file, insertTarget);
      return name;
    },
    [importImageFileAsLayer]
  );

  return {
    pasteLayerFromCanvas,
    fillScreentoneSelection,
    copyLayer,
    pasteLayer,
    importImageFileAsLayer,
    pasteLayerFromFile,
  };
}
