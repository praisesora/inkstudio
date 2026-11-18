import {
  CanvasDimensions,
  LayerItem,
  CanvasColorMode,
  BlendMode,
} from '../types/editor';
import { getCanvasCompositeOperation } from './canvasUtils';
import { groupLayersForCompositing } from './compositor';
import { applyAdjustment } from './tonalEngine';
import { recoveryService } from '../services/recoveryService';

export interface SavedFileInfo {
  handle?: any; // FileSystemFileHandle
  name: string;
  extension: string;
}

export interface SaveDocumentData {
  name: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  layerCanvasesMap: Map<string, HTMLCanvasElement>;
  getEffectiveOpacity: (layer: LayerItem) => number;
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean;
  tabId?: string;
}

/**
 * Maps Ink Studio BlendMode to ag-psd BlendMode format.
 */
function toAgPsdBlendMode(mode: BlendMode): any {
  switch (mode) {
    case 'color-dodge':
      return 'color dodge';
    case 'color-burn':
      return 'color burn';
    case 'hard-light':
      return 'hard light';
    case 'soft-light':
      return 'soft light';
    default:
      return mode;
  }
}

/**
 * Composites all visible layers with their blend modes and opacities onto a single canvas.
 */
export function compositeCanvas(
  dimensions: CanvasDimensions,
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  getEffectiveOpacity: (layer: LayerItem) => number,
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean,
  fillWhiteBackground: boolean = false
): HTMLCanvasElement {
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = dimensions.width;
  exportCanvas.height = dimensions.height;
  const ctx = exportCanvas.getContext('2d');
  if (!ctx) return exportCanvas;

  if (fillWhiteBackground) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dimensions.width, dimensions.height);
  }

  // Render layers bottom-to-top grouped by clipping masks
  const renderOrder = layers.slice().reverse();
  const groups = groupLayersForCompositing(renderOrder);

  const getMaskedLayerCanvas = (layer: LayerItem, srcCanvas: HTMLCanvasElement): HTMLCanvasElement => {
    if (!layer.maskCanvas || layer.maskEnabled === false) return srcCanvas;
    const masked = document.createElement('canvas');
    masked.width = dimensions.width;
    masked.height = dimensions.height;
    const mCtx = masked.getContext('2d');
    const maskCtx = layer.maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!mCtx || !maskCtx) return srcCanvas;
    mCtx.drawImage(srcCanvas, 0, 0);
    const imgData = mCtx.getImageData(0, 0, dimensions.width, dimensions.height);
    const maskData = maskCtx.getImageData(0, 0, dimensions.width, dimensions.height).data;
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const maskLum = ((0.299 * maskData[i] + 0.587 * maskData[i + 1] + 0.114 * maskData[i + 2]) / 255) * (maskData[i + 3] / 255);
      d[i + 3] = Math.round(d[i + 3] * maskLum);
    }
    mCtx.putImageData(imgData, 0, 0);
    return masked;
  };

  for (const group of groups) {
    const baseLayer = group.baseLayer;
    if (baseLayer.type === 'folder' || !isLayerEffectivelyVisible(baseLayer)) continue;

    if (baseLayer.type === 'adjustment' && baseLayer.adjustmentData) {
      const imgData = ctx.getImageData(0, 0, dimensions.width, dimensions.height);
      applyAdjustment(
        imgData,
        baseLayer.adjustmentData,
        baseLayer.maskEnabled !== false ? baseLayer.maskCanvas : undefined,
        getEffectiveOpacity(baseLayer)
      );
      ctx.putImageData(imgData, 0, 0);
      continue;
    }

    const rawBaseCanvas = layerCanvasesMap.get(baseLayer.id);
    if (!rawBaseCanvas) continue;
    const baseCanvas = getMaskedLayerCanvas(baseLayer, rawBaseCanvas);

    const activeClipped = group.clippedLayers.filter(
      (cl) => cl.type !== 'folder' && cl.type !== 'adjustment' && isLayerEffectivelyVisible(cl)
    );

    if (activeClipped.length === 0) {
      ctx.save();
      ctx.globalAlpha = getEffectiveOpacity(baseLayer);
      ctx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
      ctx.drawImage(baseCanvas, 0, 0);
      ctx.restore();
    } else {
      // Group isolated offscreen canvas for base + clipped layers
      const groupCanvas = document.createElement('canvas');
      groupCanvas.width = dimensions.width;
      groupCanvas.height = dimensions.height;
      const gCtx = groupCanvas.getContext('2d');
      if (!gCtx) continue;

      gCtx.save();
      gCtx.globalAlpha = getEffectiveOpacity(baseLayer);
      gCtx.drawImage(baseCanvas, 0, 0);
      gCtx.restore();

      for (const clipped of activeClipped) {
        const rawClippedCanvas = layerCanvasesMap.get(clipped.id);
        if (!rawClippedCanvas) continue;
        const cCanvas = getMaskedLayerCanvas(clipped, rawClippedCanvas);

        gCtx.save();
        gCtx.globalAlpha = getEffectiveOpacity(clipped);
        gCtx.globalCompositeOperation = 'source-atop';
        gCtx.drawImage(cCanvas, 0, 0);
        gCtx.restore();
      }

      ctx.save();
      ctx.globalAlpha = 1.0;
      ctx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
      ctx.drawImage(groupCanvas, 0, 0);
      ctx.restore();
    }
  }

  return exportCanvas;
}

/**
 * Converts a canvas element into a Blob with the specified mime-type.
 */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string = 'image/png',
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob failed'));
      },
      mimeType,
      quality
    );
  });
}

/**
 * Serializes the document according to the requested file extension.
 */
export async function serializeDocument(
  data: SaveDocumentData,
  extension: string
): Promise<{ data: Blob | ArrayBuffer; mimeType: string }> {
  const ext = extension.toLowerCase();

  // 1. PSD format with layers (ag-psd expects bottom-to-top order and opacity 0..255)
  if (ext === '.psd' || ext === '.psb') {
    const children = data.layers
      .slice()
      .reverse()
      .filter((l) => l.type === 'raster' || l.type === 'vector' || l.type === 'frame')
      .map((layer) => {
        const c = data.layerCanvasesMap.get(layer.id);
        return {
          name: layer.name,
          hidden: !layer.visible,
          opacity: Math.round(Math.max(0, Math.min(1, layer.opacity ?? 1)) * 255),
          blendMode: toAgPsdBlendMode(layer.blendMode),
          canvas: c || undefined,
        };
      });

    const dpi = data.dimensions.dpi || 300;
    const { writePsd } = await import('ag-psd');
    const psdBuffer = writePsd({
      width: data.dimensions.width,
      height: data.dimensions.height,
      children,
      imageResources: {
        resolutionInfo: {
          horizontalResolution: dpi,
          horizontalResolutionUnit: 'PPI',
          widthUnit: 'Inches',
          verticalResolution: dpi,
          verticalResolutionUnit: 'PPI',
          heightUnit: 'Inches',
        },
      },
    });

    return {
      data: psdBuffer,
      mimeType: 'image/vnd.adobe.photoshop',
    };
  }

  // 2. Native Ink Studio Project (.ink, .sora) format
  if (ext === '.ink' || ext === '.sora') {
    const layerImages: Record<string, string> = {};
    const maskImages: Record<string, string> = {};
    const serializableLayers = data.layers.map((l) => {
      if (l.type === 'raster' || l.type === 'vector' || l.type === 'frame') {
        const c = data.layerCanvasesMap.get(l.id);
        if (c) {
          layerImages[l.id] = c.toDataURL('image/png');
        }
      }
      if (l.maskCanvas && typeof l.maskCanvas.toDataURL === 'function') {
        maskImages[l.id] = l.maskCanvas.toDataURL('image/png');
      }
      const { maskCanvas: _mc, ...rest } = l;
      return rest;
    });

    const projectData = {
      app: 'Ink Studio',
      version: '1.1',
      name: data.name,
      dimensions: data.dimensions,
      colorMode: data.colorMode,
      layers: serializableLayers,
      canvases: layerImages,
      masks: maskImages,
    };

    const json = JSON.stringify(projectData);
    return {
      data: new Blob([json], { type: 'application/json' }),
      mimeType: 'application/json',
    };
  }

  // 3. JPEG format
  if (ext === '.jpg' || ext === '.jpeg') {
    const compCanvas = compositeCanvas(
      data.dimensions,
      data.layers,
      data.layerCanvasesMap,
      data.getEffectiveOpacity,
      data.isLayerEffectivelyVisible,
      true // white background for JPEG
    );
    const blob = await canvasToBlob(compCanvas, 'image/jpeg', 0.92);
    return { data: blob, mimeType: 'image/jpeg' };
  }

  // 4. WebP format
  if (ext === '.webp') {
    const compCanvas = compositeCanvas(
      data.dimensions,
      data.layers,
      data.layerCanvasesMap,
      data.getEffectiveOpacity,
      data.isLayerEffectivelyVisible,
      false
    );
    const blob = await canvasToBlob(compCanvas, 'image/webp', 0.92);
    return { data: blob, mimeType: 'image/webp' };
  }

  // 5. Default: PNG format
  const compCanvas = compositeCanvas(
    data.dimensions,
    data.layers,
    data.layerCanvasesMap,
    data.getEffectiveOpacity,
    data.isLayerEffectivelyVisible,
    false
  );
  const blob = await canvasToBlob(compCanvas, 'image/png');
  return { data: blob, mimeType: 'image/png' };
}

/**
 * Triggers fallback download using standard anchor element.
 */
export function downloadFile(
  content: Blob | ArrayBuffer,
  fileName: string,
  mimeType: string
) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

/**
 * Prompts user to select save location and extension via File System Access API or fallback.
 */
export async function promptSaveAs(
  data: SaveDocumentData,
  defaultExtension: string = '.sora',
  fallbackToDownload: boolean = true
): Promise<SavedFileInfo> {
  const safeName = data.name.trim().replace(/[^a-zA-Z0-9_\- ]/g, '_') || 'Untitled';
  const suggestedName = `${safeName}${defaultExtension}`;

  const types = [
    {
      description: 'Ink Studio Layered Project (*.sora, *.ink)',
      accept: { 'application/json': ['.sora', '.ink'] },
    },
    {
      description: 'Photoshop Document with Layers (*.psd)',
      accept: { 'image/vnd.adobe.photoshop': ['.psd'] },
    },
    {
      description: 'PNG Image (*.png)',
      accept: { 'image/png': ['.png'] },
    },
    {
      description: 'JPEG Image (*.jpg, *.jpeg)',
      accept: { 'image/jpeg': ['.jpg', '.jpeg'] },
    },
    {
      description: 'WebP Image (*.webp)',
      accept: { 'image/webp': ['.webp'] },
    },
  ];

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types,
      });

      const fileName = handle.name;
      const ext = fileName.includes('.')
        ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
        : defaultExtension;

      const serialized = await serializeDocument(data, ext);
      const writable = await handle.createWritable();
      await writable.write(serialized.data);
      await writable.close();

      if (data.tabId) {
        recoveryService.markCleanSaved(data.tabId).catch(console.warn);
      }

      return {
        handle,
        name: fileName,
        extension: ext,
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('Save canceled');
      }
      console.warn('showSaveFilePicker failed or unsupported, using download fallback:', err);
    }
  }

  // Fallback if File System Access API is unavailable or rejected
  if (fallbackToDownload) {
    const ext = defaultExtension;
    const serialized = await serializeDocument(data, ext);
    downloadFile(serialized.data, suggestedName, serialized.mimeType);

    if (data.tabId) {
      recoveryService.markCleanSaved(data.tabId).catch(console.warn);
    }

    return {
      name: suggestedName,
      extension: ext,
    };
  }

  throw new Error('Save dialog was not available');
}

/**
 * Writes directly to an already selected FileSystemFileHandle without prompting.
 */
export async function saveToExistingHandle(
  data: SaveDocumentData,
  fileInfo: SavedFileInfo
): Promise<void> {
  if (!fileInfo.handle || typeof fileInfo.handle.createWritable !== 'function') {
    throw new Error('No valid file handle to save to');
  }

  const serialized = await serializeDocument(data, fileInfo.extension);
  const writable = await fileInfo.handle.createWritable();
  await writable.write(serialized.data);
  await writable.close();

  if (data.tabId) {
    recoveryService.markCleanSaved(data.tabId).catch(console.warn);
  }
}

/**
 * Prompts user to choose a download/save path specifically for a PNG image.
 */
export async function promptExportPngImage(
  data: SaveDocumentData,
  defaultName?: string
): Promise<string> {
  const safeName = (defaultName || data.name || 'artwork').trim().replace(/[^a-zA-Z0-9_\- ]/g, '_');
  const suggestedName = `${safeName}.png`;

  const types = [
    {
      description: 'PNG Image (*.png)',
      accept: { 'image/png': ['.png'] },
    },
  ];

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types,
      });

      const serialized = await serializeDocument(data, '.png');
      const writable = await handle.createWritable();
      await writable.write(serialized.data);
      await writable.close();

      return handle.name;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('Export canceled');
      }
      console.warn('showSaveFilePicker failed for export, falling back to download:', err);
    }
  }

  // Fallback download
  const serialized = await serializeDocument(data, '.png');
  downloadFile(serialized.data, suggestedName, 'image/png');
  return suggestedName;
}
