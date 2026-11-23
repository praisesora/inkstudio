import { useRef, useCallback } from 'react';
import {
  BlendMode,
  CanvasSelection,
  LayerItem,
  LayerTreeDelta,
  isFolderLikeLayer,
} from '../../types/editor';
import { createCanvasThumbnail } from '../../utils/canvasUtils';
import { LayerInsertTarget, sanitizeImportedLayerName } from '../../utils/fileDropImport';
import { HalftoneDotShape } from '../../utils/screentoneEngine';
import {
  SelectionTileSnapshot,
  extractSelectionTileSnapshot,
  fillSelectionInTileGrid,
} from '../../utils/selectionUtils';
import {
  TILE_SIZE,
  TileDelta,
  TileFormat,
  getTileKey,
  releaseTemporaryCanvas,
  unpack1BitToRGBA,
  unpack8BitToRGBA,
} from '../../utils/tileEngine';
import { createLayerTreeSnapshotDelta } from './layerTreeOps';
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
    recordLayerHistory,
  } = ctx;

  // Internal Layer Clipboard (tile-backed; zero full-doc HTMLCanvasElement allocation)
  const layerClipboardRef = useRef<{
    name: string;
    type: LayerItem['type'];
    blendMode: BlendMode;
    opacity: number;
    isSelection?: boolean;
    expressionColor?: LayerItem['expressionColor'];
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
    ): LayerItem[] => {
      const prev = layersRef.current;
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
      setLayers(nextLayers);
      return nextLayers;
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
      const beforeLayers = layersRef.current;
      const beforeActiveLayerId = activeLayerIdRef.current;
      const newId = customId || `raster-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const grid = activeTileGridRef.current;
      const isMono = layerOverrides?.expressionColor === 'monochrome';
      grid.ingestCanvas(newId, sourceCanvas, isMono ? 'monochrome-1bit' : 'color-32bit');
      grid.notifyChange(true);

      const dims = dimensionsRef.current;
      const tileDeltas = grid.computeDeltasFromSnapshot(new Map(), newId, {
        x: 0,
        y: 0,
        width: Math.max(dims.width, sourceCanvas.width),
        height: Math.max(dims.height, sourceCanvas.height),
      });
      const thumb = createCanvasThumbnail({ grid, layerId: newId, dimensions: dims }, true);
      const nextLayers = insertNewLayerItem(newId, layerName, blendMode, opacity, thumb, layerOverrides, insertTarget);
      setActiveLayerId(newId);
      recordLayerHistory(
        `Paste Layer (${layerName})`,
        newId,
        createLayerTreeSnapshotDelta(beforeLayers, nextLayers, beforeActiveLayerId, newId),
        tileDeltas,
        'layer'
      );
      return newId;
    },
    [activeLayerIdRef, activeTileGridRef, dimensionsRef, insertNewLayerItem, layersRef, recordLayerHistory, setActiveLayerId]
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
    ): { id: string; tileDeltas: TileDelta[]; layerTreeDelta: LayerTreeDelta } => {
      const beforeLayers = layersRef.current;
      const beforeActiveLayerId = activeLayerIdRef.current;
      const resolvedFreq = frequency || defaultToneFrequencyRef.current || 60;
      const resolvedDensity = Math.max(1, Math.min(100, Math.round(density <= 1.0 && density > 0 ? density * 100 : density)));
      const newId = `raster-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const grid = activeTileGridRef.current;
      const dims = dimensionsRef.current;

      // Continuous source value: black ink in 'specified' mode, grayscale value in 'image' mode
      const grayVal = densityType === 'specified' ? 0 : Math.round(255 * (1 - resolvedDensity / 100));
      const fillCss = `rgb(${grayVal},${grayVal},${grayVal})`;

      let tileDeltas: TileDelta[] = [];
      if (selection) {
        const res = fillSelectionInTileGrid({
          grid,
          layerId: newId,
          dimensions: dims,
          selection,
          colorCss: fillCss,
          targetFormat: 'color-32bit',
        });
        tileDeltas = res.tileDeltas;
      } else {
        const beforeSnapshot = grid.snapshotLayerTiles(newId);
        grid.fillLayerSolidColor(newId, dims.width, dims.height, fillCss, 'color-32bit');
        tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, newId, {
          x: 0,
          y: 0,
          width: dims.width,
          height: dims.height,
        });
      }

      const thumb = createCanvasThumbnail({ grid, layerId: newId, dimensions: dims }, true);
      const activeIdx = beforeLayers.findIndex((l) => l.id === beforeActiveLayerId);
      const activeItem = activeIdx >= 0 ? beforeLayers[activeIdx] : undefined;
      const isActiveFolderLike = Boolean(activeItem && isFolderLikeLayer(activeItem));
      const parentId = isActiveFolderLike ? activeItem!.id : (activeItem?.parentId || null);

      let name = 'Screen Tone';
      let count = 1;
      beforeLayers.forEach((l) => {
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

      const newLayer: LayerItem = {
        id: newId,
        name,
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        collapsed: false,
        parentId,
        thumbnailUrl: thumb,
        isToneLayer: densityType === 'specified',
        toneEnabled: true,
        toneFrequency: resolvedFreq,
        toneAngle: angle,
        toneDotShape: dotShape,
        toneDensity: resolvedDensity,
        toneDensityType: densityType,
      };

      const insertIdx = isActiveFolderLike ? activeIdx + 1 : (activeIdx >= 0 ? activeIdx : 0);
      let nextLayers =
        isActiveFolderLike && activeItem?.collapsed
          ? beforeLayers.map((l) => (l.id === activeItem.id ? { ...l, collapsed: false } : l))
          : [...beforeLayers];
      nextLayers.splice(insertIdx, 0, newLayer);

      const hasBg = beforeLayers.some((l) => l.id.startsWith('layer-bg') || l.name.toLowerCase() === 'background');
      if (!hasBg) {
        const bgId = `layer-bg-${Date.now()}`;
        grid.fillLayerSolidWhite(bgId, dims.width, dims.height, 'color-32bit');
        const bgDeltas = grid.computeDeltasFromSnapshot(new Map(), bgId, {
          x: 0,
          y: 0,
          width: dims.width,
          height: dims.height,
        });
        tileDeltas = [...tileDeltas, ...bgDeltas];
        const bgThumb = createCanvasThumbnail({ grid, layerId: bgId, dimensions: dims }, false);
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

      layersRef.current = nextLayers;
      setLayers(nextLayers);
      grid.notifyChange(true);
      setActiveLayerId(newId);

      const layerTreeDelta = createLayerTreeSnapshotDelta(
        beforeLayers,
        nextLayers,
        beforeActiveLayerId,
        newId
      );
      return { id: newId, tileDeltas, layerTreeDelta };
    },
    [activeLayerIdRef, activeTileGridRef, defaultToneFrequencyRef, dimensionsRef, layersRef, setActiveLayerId, setLayers]
  );

  // Create a new raster layer directly from a sparse tile snapshot (zero full-doc canvas)
  const createLayerFromTileSnapshot = useCallback(
    (
      tileSnapshot: {
        format: TileFormat;
        tiles: Array<{ tileX: number; tileY: number; format: TileFormat; data: Uint8Array }>;
      },
      layerName: string,
      blendMode: BlendMode = 'normal',
      opacity: number = 1,
      layerOverrides?: Partial<LayerItem>,
      insertTarget?: LayerInsertTarget
    ): { id: string; name: string; tileDeltas: TileDelta[]; layerTreeDelta: LayerTreeDelta } => {
      const beforeLayers = layersRef.current;
      const beforeActiveLayerId = activeLayerIdRef.current;
      const newId = `raster-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const grid = activeTileGridRef.current;
      grid.pasteLayerTilesSnapshot(newId, tileSnapshot);
      const tileDeltas: TileDelta[] = tileSnapshot.tiles.map((entry) => ({
        key: getTileKey(newId, entry.tileX, entry.tileY, 0),
        format: entry.format,
        beforeData: null,
        afterData: new Uint8Array(entry.data),
      }));
      const thumb = createCanvasThumbnail({ grid, layerId: newId, dimensions: dimensionsRef.current }, true);
      const resolvedOverrides: Partial<LayerItem> = {
        ...(tileSnapshot.format === 'monochrome-1bit' ? { expressionColor: 'monochrome' as const } : {}),
        ...layerOverrides,
      };
      const nextLayers = insertNewLayerItem(newId, layerName, blendMode, opacity, thumb, resolvedOverrides, insertTarget);
      setActiveLayerId(newId);
      const layerTreeDelta = createLayerTreeSnapshotDelta(
        beforeLayers,
        nextLayers,
        beforeActiveLayerId,
        newId
      );
      return { id: newId, name: layerName, tileDeltas, layerTreeDelta };
    },
    [activeLayerIdRef, activeTileGridRef, dimensionsRef, insertNewLayerItem, layersRef, setActiveLayerId]
  );

  // Copy ONLY the selected pixels from a single layer into the sparse tile clipboard
  const copySelectionToClipboard = useCallback(
    (
      selection: CanvasSelection,
      targetId?: string
    ): { copied: boolean; empty?: boolean; layerName?: string; snapshot?: SelectionTileSnapshot } => {
      const id = targetId || activeLayerId;
      const targetLayer = layers.find((l) => l.id === id);
      if (!targetLayer || targetLayer.type !== 'raster') {
        return { copied: false };
      }

      const grid = activeTileGridRef.current;
      const dims = dimensionsRef.current;
      const snapshot = extractSelectionTileSnapshot({
        grid,
        layerId: id,
        dimensions: dims,
        selection,
      });

      if (!snapshot || snapshot.tiles.length === 0) {
        return { copied: false, empty: true, layerName: targetLayer.name };
      }

      layerClipboardRef.current = {
        name: targetLayer.name,
        type: 'raster',
        blendMode: targetLayer.blendMode,
        opacity: targetLayer.opacity,
        isSelection: true,
        expressionColor: targetLayer.expressionColor,
        tileSnapshot: {
          format: snapshot.format,
          tiles: snapshot.tiles.map((t) => ({
            tileX: t.tileX,
            tileY: t.tileY,
            format: t.format,
            data: new Uint8Array(t.data),
          })),
        },
      };

      // Best-effort export tight cutout to system clipboard
      try {
        const b = snapshot.bounds;
        if (navigator.clipboard && window.isSecureContext && b.width > 0 && b.height > 0 && b.width * b.height <= 4096 * 4096) {
          const temp = document.createElement('canvas');
          temp.width = b.width;
          temp.height = b.height;
          const tCtx = temp.getContext('2d');
          if (tCtx) {
            const outImg = tCtx.createImageData(b.width, b.height);
            const out = outImg.data;
            const scratch = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
            for (const entry of snapshot.tiles) {
              let rgba: Uint8ClampedArray;
              if (entry.format === 'color-32bit') {
                rgba = new Uint8ClampedArray(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
              } else if (entry.format === 'monochrome-1bit') {
                unpack1BitToRGBA(entry.data, scratch);
                rgba = scratch;
              } else {
                unpack8BitToRGBA(entry.data, scratch);
                rgba = scratch;
              }
              const tx0 = entry.tileX * TILE_SIZE;
              const ty0 = entry.tileY * TILE_SIZE;
              const x0 = Math.max(b.x, tx0);
              const y0 = Math.max(b.y, ty0);
              const x1 = Math.min(b.x + b.width, tx0 + TILE_SIZE);
              const y1 = Math.min(b.y + b.height, ty0 + TILE_SIZE);
              for (let gy = y0; gy < y1; gy++) {
                const srcRow = (gy - ty0) * TILE_SIZE * 4;
                const dstRow = (gy - b.y) * b.width * 4;
                const srcStart = srcRow + (x0 - tx0) * 4;
                const dstStart = dstRow + (x0 - b.x) * 4;
                out.set(rgba.subarray(srcStart, srcStart + (x1 - x0) * 4), dstStart);
              }
            }
            tCtx.putImageData(outImg, 0, 0);
            temp.toBlob((blob) => {
              releaseTemporaryCanvas(temp);
              if (blob && navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {});
              }
            });
          } else {
            releaseTemporaryCanvas(temp);
          }
        }
      } catch {
        // Ignore clipboard write restrictions
      }

      return { copied: true, layerName: targetLayer.name, snapshot };
    },
    [activeLayerId, activeTileGridRef, dimensionsRef, layers]
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
        isSelection: false,
        expressionColor: targetLayer.expressionColor,
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
  const pasteLayer = useCallback(async (): Promise<{
    success: boolean;
    layerId?: string;
    layerName?: string;
    tileDeltas?: TileDelta[];
    layerTreeDelta?: LayerTreeDelta;
  }> => {
    // 1. Check internal tile-backed clipboard (zero full-doc canvas)
    if (layerClipboardRef.current) {
      const data = layerClipboardRef.current;
      const newName = data.isSelection ? `${data.name} (Selection)` : `${data.name} Copy`;
      const overrides = data.expressionColor ? { expressionColor: data.expressionColor } : undefined;
      const created = createLayerFromTileSnapshot(
        data.tileSnapshot,
        newName,
        data.blendMode,
        data.opacity,
        overrides
      );
      return {
        success: true,
        layerId: created.id,
        layerName: created.name,
        tileDeltas: created.tileDeltas,
        layerTreeDelta: created.layerTreeDelta,
      };
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

            const beforeLayers = layersRef.current;
            const beforeActiveLayerId = activeLayerIdRef.current;
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

            const tileDeltas = grid.computeDeltasFromSnapshot(new Map(), newId, {
              x: dx,
              y: dy,
              width: dw,
              height: dh,
            });
            const newName = 'Pasted Image';
            const thumb = createCanvasThumbnail({ grid, layerId: newId, dimensions }, true);
            const nextLayers = insertNewLayerItem(newId, newName, 'normal', 1, thumb);
            setActiveLayerId(newId);
            grid.notifyChange(true);
            const layerTreeDelta = createLayerTreeSnapshotDelta(
              beforeLayers,
              nextLayers,
              beforeActiveLayerId,
              newId
            );
            return { success: true, layerId: newId, layerName: newName, tileDeltas, layerTreeDelta };
          }
        }
      }
    } catch (err) {
      console.warn('System clipboard read failed:', err);
    }

    return { success: false };
  }, [activeLayerIdRef, activeTileGridRef, createLayerFromTileSnapshot, dimensions, insertNewLayerItem, layersRef, setActiveLayerId]);

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

      const beforeLayers = layersRef.current;
      const beforeActiveLayerId = activeLayerIdRef.current;
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

      const tileDeltas = grid.computeDeltasFromSnapshot(new Map(), newId, {
        x: dx,
        y: dy,
        width: dw,
        height: dh,
      });
      const layerName = sanitizeImportedLayerName(file.name);
      const thumb = createCanvasThumbnail({ grid, layerId: newId, dimensions: dims }, true);
      const nextLayers = insertNewLayerItem(newId, layerName, 'normal', 1, thumb, undefined, insertTarget);
      setActiveLayerId(newId);
      grid.notifyChange(true);
      recordLayerHistory(
        `Import Image (${layerName})`,
        newId,
        createLayerTreeSnapshotDelta(beforeLayers, nextLayers, beforeActiveLayerId, newId),
        tileDeltas,
        'layer'
      );
      return { id: newId, name: layerName };
    },
    [activeLayerIdRef, activeTileGridRef, dimensionsRef, insertNewLayerItem, layersRef, recordLayerHistory, setActiveLayerId]
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
    copySelectionToClipboard,
    createLayerFromTileSnapshot,
    pasteLayer,
    importImageFileAsLayer,
    pasteLayerFromFile,
  };
}
