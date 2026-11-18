import { readPsd, initializeCanvas, Layer as PsdLayer } from 'ag-psd';
import { BlendMode, CanvasColorMode, LayerItem, LoadedDocument } from '../types/editor';
import { createCanvasThumbnail } from './canvasUtils';

if (typeof document !== 'undefined') {
  initializeCanvas(
    (w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    },
    (w, h) => {
      const c = document.createElement('canvas');
      return c.getContext('2d')!.createImageData(w, h);
    }
  );
}

/**
 * Maps Photoshop blend mode string to Ink Studio BlendMode.
 */
function mapPsdBlendMode(psdBlendMode?: string): BlendMode {
  if (!psdBlendMode) return 'normal';
  const mode = psdBlendMode.toLowerCase();

  switch (mode) {
    case 'multiply':
      return 'multiply';
    case 'screen':
      return 'screen';
    case 'overlay':
      return 'overlay';
    case 'darken':
    case 'darker color':
      return 'darken';
    case 'lighten':
    case 'lighter color':
      return 'lighten';
    case 'color dodge':
    case 'linear dodge':
      return 'color-dodge';
    case 'color burn':
    case 'linear burn':
      return 'color-burn';
    case 'hard light':
    case 'vivid light':
    case 'linear light':
    case 'pin light':
    case 'hard mix':
      return 'hard-light';
    case 'soft light':
      return 'soft-light';
    case 'difference':
    case 'subtract':
    case 'subtraction':
      return 'difference';
    case 'exclusion':
    case 'divide':
      return 'exclusion';
    case 'normal':
    case 'pass through':
    default:
      return 'normal';
  }
}

/**
 * Parses a Photoshop .psd or .psb file ArrayBuffer into a LoadedDocument.
 */
export async function parsePsdFile(buffer: ArrayBuffer, fileName: string): Promise<LoadedDocument> {
  const psd = readPsd(buffer, {
    skipLayerImageData: false,
    skipThumbnail: true,
  });

  const width = psd.width || 1440;
  const height = psd.height || 900;
  const dpi = psd.imageResources?.resolutionInfo?.horizontalResolution
    ? Math.round(psd.imageResources.resolutionInfo.horizontalResolution)
    : 300;
  const colorMode: CanvasColorMode = psd.colorMode === 1 ? 'grayscale' : 'color';

  const layers: LayerItem[] = [];
  const layerCanvases = new Map<string, HTMLCanvasElement>();

  // Process recursive layers and folders
  function processPsdLayer(psdLayer: PsdLayer, parentId: string | null) {
    const isFolder = Array.isArray(psdLayer.children) && psdLayer.children.length > 0;
    const id = `psd-${isFolder ? 'folder' : 'layer'}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const name = psdLayer.name || (isFolder ? 'Folder' : 'Layer');
    const visible = !psdLayer.hidden;
    const rawOpacity = typeof psdLayer.opacity === 'number' ? psdLayer.opacity : 1;
    const normalizedOpacity = rawOpacity > 1 ? rawOpacity / 255 : rawOpacity;
    const opacity = Math.max(0, Math.min(1, normalizedOpacity));
    const blendMode = mapPsdBlendMode(psdLayer.blendMode);
    const locked = Boolean(
      psdLayer.protected?.transparency ||
      psdLayer.protected?.position ||
      psdLayer.protected?.composite
    );

    if (isFolder) {
      const folderItem: LayerItem = {
        id,
        name,
        type: 'folder',
        visible,
        opacity,
        blendMode,
        locked,
        collapsed: false,
        parentId,
      };
      layers.push(folderItem);

      // Process children in reverse (ag-psd is bottom-to-top; Ink Studio is top-to-bottom)
      if (psdLayer.children) {
        for (let i = psdLayer.children.length - 1; i >= 0; i--) {
          processPsdLayer(psdLayer.children[i], id);
        }
      }
    } else {
      // Raster Layer: composite onto full canvas dimensions
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      if (ctx) {
        if (psdLayer.canvas) {
          const dx = psdLayer.left ?? 0;
          const dy = psdLayer.top ?? 0;
          ctx.drawImage(psdLayer.canvas, dx, dy);
        } else if (psdLayer.imageData) {
          const dx = psdLayer.left ?? 0;
          const dy = psdLayer.top ?? 0;
          const w = psdLayer.imageData.width;
          const h = psdLayer.imageData.height;
          if (w > 0 && h > 0) {
            const imgData = ctx.createImageData(w, h);
            imgData.data.set(psdLayer.imageData.data);
            ctx.putImageData(imgData, dx, dy);
          }
        }
      }

      layerCanvases.set(id, canvas);
      const thumb = createCanvasThumbnail(canvas, true);

      const rasterItem: LayerItem = {
        id,
        name,
        type: 'raster',
        visible,
        opacity,
        blendMode,
        locked,
        parentId,
        thumbnailUrl: thumb,
      };
      layers.push(rasterItem);
    }
  }

  if (psd.children && psd.children.length > 0) {
    // ag-psd stores layers bottom-to-top; reverse to match Ink Studio's top-to-bottom stack order
    for (let i = psd.children.length - 1; i >= 0; i--) {
      processPsdLayer(psd.children[i], null);
    }
  } else if (psd.canvas) {
    // Single flattened composite
    const id = `psd-layer-base-${Date.now()}`;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(psd.canvas, 0, 0);
    }
    layerCanvases.set(id, canvas);
    const thumb = createCanvasThumbnail(canvas, true);

    layers.push({
      id,
      name: 'Background',
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      locked: false,
      parentId: null,
      thumbnailUrl: thumb,
    });
  }

  // Ensure there's at least one layer
  if (layers.length === 0) {
    const id = `layer-${Date.now()}`;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
    layerCanvases.set(id, canvas);
    const thumb = createCanvasThumbnail(canvas, false);

    layers.push({
      id,
      name: 'Layer 1',
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      locked: false,
      parentId: null,
      thumbnailUrl: thumb,
    });
  }

  return {
    name: fileName.replace(/\.[^/.]+$/, ''),
    dimensions: { width, height, dpi },
    colorMode,
    layers,
    layerCanvases,
  };
}
