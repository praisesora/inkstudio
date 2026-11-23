import { buildLayerTree } from '../compositor';
import { recoveryService } from '../../services/recoveryService';
import { releaseTemporaryCanvas } from '../tileEngine';
import { documentStore } from '../documentStore';
import { buildInkStudioXmpMetadata, sanitizeWorkTimeMs } from '../artworkTimeTracker';
import {
  ExportImageOptions,
  ExportImageResult,
  INK_DEFAULT_TILE_EXPORT_SIZE,
  PRIMARY_PROJECT_EXTENSION,
  SaveDocumentData,
  SavedFileInfo,
  canvasToBlob,
} from './types';
import { hydratePagedTilesForLayers } from './exportGridPrep';
import { buildPsdLayerTree } from './psdExport';
import { compositeCanvasAsync } from './gpuComposite';
import { serializeInkProject } from './inkSerialize';

/**
 * Pixel-accurate tiled GPU image exporter (PNG / JPEG / WebP) with automatic
 * CPU fallback when WebGL2 is unavailable.
 */
export async function exportImage(
  data: SaveDocumentData,
  options: ExportImageOptions = {}
): Promise<ExportImageResult> {
  const format = options.format ?? 'png';
  const isJpeg = format === 'jpg' || format === 'jpeg';
  const isWebp = format === 'webp';
  const mimeType = isJpeg ? 'image/jpeg' : isWebp ? 'image/webp' : 'image/png';
  const quality = isJpeg || isWebp ? (options.quality ?? 0.92) : undefined;
  const fillWhite = options.fillWhiteBackground ?? isJpeg;
  const tileGrid =
    data.tileGrid ??
    (data.tabId ? documentStore.getSession(data.tabId)?.tileGrid : documentStore.getActiveTileGrid());

  const onProgress = options.onProgress ?? data.onProgress;

  const { canvas, usedGpu } = await compositeCanvasAsync(
    data.dimensions,
    data.layers,
    data.layerCanvasesMap,
    data.getEffectiveOpacity,
    data.isLayerEffectivelyVisible,
    fillWhite,
    tileGrid,
    {
      tileSize: options.tileSize ?? INK_DEFAULT_TILE_EXPORT_SIZE,
      colorMode: data.colorMode,
      onProgress,
    }
  );

  try {
    onProgress?.({
      phase: 'encoding',
      current: 1,
      total: 1,
      percent: 92,
      message: `Encoding ${format.toUpperCase()}...`,
    });
    const blob = await canvasToBlob(canvas, mimeType, quality);
    onProgress?.({
      phase: 'done',
      current: 1,
      total: 1,
      percent: 100,
      message: 'Export complete',
    });
    return {
      blob,
      mimeType,
      width: data.dimensions.width,
      height: data.dimensions.height,
      usedGpu,
    };
  } finally {
    releaseTemporaryCanvas(canvas);
  }
}

/**
 * Serializes the document according to the requested file extension.
 */
export async function serializeDocument(
  data: SaveDocumentData,
  extension: string
): Promise<{ data: Blob | ArrayBuffer; mimeType: string; previewDataUrl?: string }> {
  const ext = extension.toLowerCase();
  const tileGrid =
    data.tileGrid ??
    (data.tabId ? documentStore.getSession(data.tabId)?.tileGrid : documentStore.getActiveTileGrid());

  // 1. PSD/PSB format with full folder hierarchy, blend modes, clipping, alphaLock, and masks
  if (ext === '.psd' || ext === '.psb') {
    await hydratePagedTilesForLayers(tileGrid, data.layers, false);
    const tempCanvases: HTMLCanvasElement[] = [];
    try {
      const tree = buildLayerTree(data.layers);
      const children = buildPsdLayerTree(
        tree,
        data.dimensions,
        data.layerCanvasesMap,
        tileGrid,
        tempCanvases
      );

      const dpi = data.dimensions.dpi || 300;
      const workTimeMs = sanitizeWorkTimeMs(data.workTimeMs);
      const { writePsd } = await import('ag-psd');
      const psdBuffer = writePsd(
        {
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
            ...(workTimeMs > 0 ? { xmpMetadata: buildInkStudioXmpMetadata(workTimeMs) } : {}),
          },
        },
        {
          psb: ext === '.psb',
          noBackground: true,
        }
      );

      return {
        data: psdBuffer,
        mimeType: 'image/vnd.adobe.photoshop',
      };
    } finally {
      for (const temp of tempCanvases) {
        releaseTemporaryCanvas(temp);
      }
    }
  }

  // 2. Native Ink Studio Project (.ink) — Binary v2 container (.sora is read-only)
  if (ext === '.sora') {
    throw new Error('Legacy .sora format is read-only. Save as .ink instead.');
  }
  if (ext === PRIMARY_PROJECT_EXTENSION) {
    const result = await serializeInkProject(data, tileGrid);
    return {
      data: new Blob([result.bytes as BlobPart], { type: 'application/octet-stream' }),
      mimeType: 'application/octet-stream',
      previewDataUrl: result.previewDataUrl,
    };
  }

  // 3. JPEG format (tiled GPU compositor with white background)
  if (ext === '.jpg' || ext === '.jpeg') {
    const exported = await exportImage(
      { ...data, tileGrid },
      { format: 'jpg', quality: 0.92, fillWhiteBackground: true }
    );
    return { data: exported.blob, mimeType: exported.mimeType };
  }

  // 4. WebP format (tiled GPU compositor with transparency)
  if (ext === '.webp') {
    const exported = await exportImage(
      { ...data, tileGrid },
      { format: 'webp', quality: 0.92, fillWhiteBackground: false }
    );
    return { data: exported.blob, mimeType: exported.mimeType };
  }

  // 5. Default: PNG format (tiled GPU compositor with transparency)
  const exported = await exportImage(
    { ...data, tileGrid },
    { format: 'png', fillWhiteBackground: false }
  );
  return { data: exported.blob, mimeType: exported.mimeType };
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

function getSerializedByteSize(content: Blob | ArrayBuffer): number {
  return content instanceof Blob ? content.size : content.byteLength;
}

/**
 * Prompts user to select save location and extension via File System Access API or fallback.
 */
export async function promptSaveAs(
  data: SaveDocumentData,
  defaultExtension: string = PRIMARY_PROJECT_EXTENSION,
  fallbackToDownload: boolean = true
): Promise<SavedFileInfo> {
  const resolvedDefaultExt =
    defaultExtension.toLowerCase() === '.sora' ? PRIMARY_PROJECT_EXTENSION : defaultExtension;
  const safeName = data.name.trim().replace(/[^a-zA-Z0-9_\- ]/g, '_') || 'Untitled';
  const suggestedName = `${safeName}${resolvedDefaultExt}`;

  const types = [
    {
      description: 'Ink Studio Project (*.ink)',
      accept: { 'application/octet-stream': ['.ink'] },
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
        : resolvedDefaultExt;

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
        size: getSerializedByteSize(serialized.data),
        previewDataUrl: serialized.previewDataUrl,
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('Save canceled');
      }
      console.warn('showSaveFilePicker failed or unsupported, using download fallback:', err);
    }
  }

  if (fallbackToDownload) {
    const ext = resolvedDefaultExt;
    const serialized = await serializeDocument(data, ext);
    downloadFile(serialized.data, suggestedName, serialized.mimeType);

    if (data.tabId) {
      recoveryService.markCleanSaved(data.tabId).catch(console.warn);
    }

    return {
      name: suggestedName,
      extension: ext,
      size: getSerializedByteSize(serialized.data),
      previewDataUrl: serialized.previewDataUrl,
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
): Promise<{ size: number; previewDataUrl?: string }> {
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

  return {
    size: getSerializedByteSize(serialized.data),
    previewDataUrl: serialized.previewDataUrl,
  };
}

/**
 * Prompts user to choose a download/save path specifically for an exported image (PNG / JPG / WebP).
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

      const fileName: string = handle.name;
      const ext = fileName.includes('.')
        ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
        : '.png';
      const serialized = await serializeDocument(data, ext);
      const writable = await handle.createWritable();
      await writable.write(serialized.data);
      await writable.close();

      return fileName;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('Export canceled');
      }
      console.warn('showSaveFilePicker failed for export, falling back to download:', err);
    }
  }

  const serialized = await serializeDocument(data, '.png');
  downloadFile(serialized.data, suggestedName, 'image/png');
  return suggestedName;
}
