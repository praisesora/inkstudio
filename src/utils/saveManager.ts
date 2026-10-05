import {
  CanvasDimensions,
  LayerItem,
  CanvasColorMode,
  BlendMode,
} from '../types/editor';
import { getCanvasCompositeOperation } from './canvasUtils';
import { groupLayersForCompositing } from './compositor';

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

  for (const group of groups) {
    const baseLayer = group.baseLayer;
    if (baseLayer.type === 'folder' || !isLayerEffectivelyVisible(baseLayer)) continue;
    const baseCanvas = layerCanvasesMap.get(baseLayer.id);
    if (!baseCanvas) continue;

    const activeClipped = group.clippedLayers.filter(
      (cl) => cl.type !== 'folder' && isLayerEffectivelyVisible(cl)
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
        const cCanvas = layerCanvasesMap.get(clipped.id);
        if (!cCanvas) continue;

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

  // 1. PSD format with layers
  if (ext === '.psd' || ext === '.psb') {
    const children = data.layers
      .filter((l) => l.type === 'raster')
      .map((layer) => {
        const c = data.layerCanvasesMap.get(layer.id);
        return {
          name: layer.name,
          hidden: !layer.visible,
          opacity: layer.opacity,
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
    data.layers.forEach((l) => {
      if (l.type === 'raster') {
        const c = data.layerCanvasesMap.get(l.id);
        if (c) {
          layerImages[l.id] = c.toDataURL('image/png');
        }
      }
    });

    const projectData = {
      app: 'Ink Studio',
      version: '1.0',
      name: data.name,
      dimensions: data.dimensions,
      colorMode: data.colorMode,
      layers: data.layers,
      canvases: layerImages,
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
  defaultExtension: string = '.png',
  fallbackToDownload: boolean = true
): Promise<SavedFileInfo> {
  const safeName = data.name.trim().replace(/[^a-zA-Z0-9_\- ]/g, '_') || 'Untitled';
  const suggestedName = `${safeName}${defaultExtension}`;

  const types = [
    {
      description: 'PNG Image (*.png)',
      accept: { 'image/png': ['.png'] },
    },
    {
      description: 'Photoshop Document with Layers (*.psd)',
      accept: { 'image/vnd.adobe.photoshop': ['.psd'] },
    },
    {
      description: 'Ink Studio Layered Project (*.ink, *.sora)',
      accept: { 'application/json': ['.ink', '.sora'] },
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
