import { readPsd, initializeCanvas, Layer as PsdLayer, LayerMaskData, PixelData } from 'ag-psd';
import { BlendMode, CanvasColorMode, LayerItem, LoadedDocument } from '../types/editor';
import { createCanvasThumbnail } from './canvasUtils';
import { isNativeRustAvailable, parsePsdNative } from './nativeBackend';
import { SparseTileGrid, releaseTemporaryCanvas } from './tileEngine';

initializeCanvas(
  (w, h) => {
    if (typeof document === 'undefined') {
      throw new Error('Canvas unavailable in headless environment');
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  },
  (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }) as ImageData
);

/**
 * Maps Photoshop blend mode string to Ink Studio BlendMode.
 */
export function mapPsdBlendMode(psdBlendMode?: string): BlendMode {
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
      return 'darken';
    case 'darker color':
      return 'darker-color';
    case 'lighten':
      return 'lighten';
    case 'lighter color':
      return 'lighter-color';
    case 'color dodge':
      return 'color-dodge';
    case 'linear dodge':
      return 'add-glow';
    case 'color burn':
      return 'color-burn';
    case 'linear burn':
      return 'linear-burn';
    case 'hard light':
      return 'hard-light';
    case 'vivid light':
      return 'vivid-light';
    case 'linear light':
      return 'linear-light';
    case 'pin light':
      return 'pin-light';
    case 'hard mix':
      return 'hard-mix';
    case 'soft light':
      return 'soft-light';
    case 'difference':
      return 'difference';
    case 'subtract':
    case 'subtraction':
      return 'subtract';
    case 'exclusion':
      return 'exclusion';
    case 'divide':
      return 'divide';
    case 'hue':
      return 'hue';
    case 'saturation':
      return 'saturation';
    case 'color':
      return 'color';
    case 'luminosity':
      return 'luminosity';
    case 'pass through':
      return 'pass-through';
    case 'normal':
    default:
      return 'normal';
  }
}

function toRgbaUint8(pixelData: PixelData): { data: Uint8ClampedArray; width: number; height: number } {
  const { width, height, data } = pixelData;
  if (data instanceof Uint8ClampedArray) {
    return { data, width, height };
  }
  if (data instanceof Uint8Array) {
    return {
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      width,
      height,
    };
  }
  const out = new Uint8ClampedArray(width * height * 4);
  if (data instanceof Uint16Array) {
    for (let i = 0; i < out.length; i++) {
      out[i] = data[i] >> 8;
    }
  } else {
    // Float32Array (0..1 linear/sRGB)
    for (let i = 0; i < out.length; i++) {
      out[i] = Math.max(0, Math.min(255, Math.round(data[i] * 255)));
    }
  }
  return { data: out, width, height };
}

function writePixelDataToTileGrid(
  tileGrid: SparseTileGrid,
  layerId: string,
  pixelData: PixelData,
  dx: number,
  dy: number,
  docWidth: number,
  docHeight: number
): void {
  const rgba = toRgbaUint8(pixelData);
  const w = rgba.width;
  const h = rgba.height;
  if (w <= 0 || h <= 0) return;

  const srcX0 = Math.max(0, -dx);
  const srcY0 = Math.max(0, -dy);
  const srcX1 = Math.min(w, docWidth - dx);
  const srcY1 = Math.min(h, docHeight - dy);
  if (srcX0 >= srcX1 || srcY0 >= srcY1) return;

  if (srcX0 === 0 && srcY0 === 0 && srcX1 === w && srcY1 === h) {
    tileGrid.writeImageData(layerId, rgba, dx, dy, 'color-32bit', true);
    return;
  }

  const cw = srcX1 - srcX0;
  const ch = srcY1 - srcY0;
  const cropped = new Uint8ClampedArray(cw * ch * 4);
  const rowBytes = cw * 4;
  for (let row = 0; row < ch; row++) {
    const srcOffset = ((srcY0 + row) * w + srcX0) * 4;
    const dstOffset = row * rowBytes;
    cropped.set(rgba.data.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
  }
  tileGrid.writeImageData(
    layerId,
    { data: cropped, width: cw, height: ch },
    dx + srcX0,
    dy + srcY0,
    'color-32bit',
    true
  );
}

function importPsdMask(
  mask: LayerMaskData | undefined,
  docWidth: number,
  docHeight: number
): Pick<LayerItem, 'maskCanvas' | 'maskEnabled' | 'maskLinked' | 'maskVersion' | 'maskThumbnailUrl'> {
  if (!mask) return {};

  const maskEnabled = !mask.disabled;
  const maskLinked = !mask.positionRelativeToLayer;

  if (typeof document === 'undefined') {
    return {
      maskEnabled,
      maskLinked,
      maskVersion: 1,
    };
  }

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = docWidth;
  maskCanvas.height = docHeight;
  const mCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

  if (mCtx) {
    const defaultVal =
      typeof mask.defaultColor === 'number'
        ? Math.max(0, Math.min(255, Math.round(mask.defaultColor)))
        : 0;
    const outImg = mCtx.createImageData(docWidth, docHeight);
    const out = outImg.data;
    for (let i = 0; i < out.length; i += 4) {
      out[i] = defaultVal;
      out[i + 1] = defaultVal;
      out[i + 2] = defaultVal;
      out[i + 3] = 255;
    }

    const mx = mask.left ?? 0;
    const my = mask.top ?? 0;

    if (mask.imageData && mask.imageData.width > 0 && mask.imageData.height > 0) {
      const src = toRgbaUint8(mask.imageData);
      const x0 = Math.max(0, -mx);
      const y0 = Math.max(0, -my);
      const x1 = Math.min(src.width, docWidth - mx);
      const y1 = Math.min(src.height, docHeight - my);
      for (let sy = y0; sy < y1; sy++) {
        const dy = my + sy;
        for (let sx = x0; sx < x1; sx++) {
          const dx = mx + sx;
          const si = (sy * src.width + sx) * 4;
          const di = (dy * docWidth + dx) * 4;
          const v = src.data[si];
          out[di] = v;
          out[di + 1] = v;
          out[di + 2] = v;
          out[di + 3] = 255;
        }
      }
      mCtx.putImageData(outImg, 0, 0);
    } else {
      mCtx.putImageData(outImg, 0, 0);
      if (mask.canvas) {
        mCtx.drawImage(mask.canvas, mx, my);
        releaseTemporaryCanvas(mask.canvas);
      }
    }
  }

  mask.imageData = undefined;
  mask.canvas = undefined;

  const maskThumbnailUrl = createCanvasThumbnail(maskCanvas, false);

  return {
    maskCanvas,
    maskEnabled,
    maskLinked,
    maskVersion: 1,
    maskThumbnailUrl,
  };
}

/**
 * Parses a Photoshop .psd or .psb file ArrayBuffer directly into a SparseTileGrid-backed LoadedDocument
 * without retaining duplicate full-size HTMLCanvasElement instances.
 */
export async function parsePsdFile(
  buffer: ArrayBuffer,
  fileName: string,
  targetGrid?: SparseTileGrid
): Promise<LoadedDocument> {
  if (isNativeRustAvailable()) {
    return await parsePsdNative(buffer, fileName, targetGrid);
  }

  const psd = readPsd(buffer, {
    skipLayerImageData: false,
    skipCompositeImageData: true,
    skipThumbnail: true,
    useImageData: true,
  });

  const width = psd.width || 1440;
  const height = psd.height || 900;
  const dpi = psd.imageResources?.resolutionInfo?.horizontalResolution
    ? Math.round(psd.imageResources.resolutionInfo.horizontalResolution)
    : 300;
  const colorMode: CanvasColorMode = psd.colorMode === 1 ? 'grayscale' : 'color';

  const layers: LayerItem[] = [];
  const tileGrid = targetGrid ?? new SparseTileGrid();
  let seq = 0;

  function processPsdLayer(psdLayer: PsdLayer, parentId: string | null) {
    const isFolder = Array.isArray(psdLayer.children);
    seq += 1;
    const id = `psd-${isFolder ? 'folder' : 'layer'}-${Date.now()}-${seq}-${Math.random().toString(36).substring(2, 6)}`;
    const name = psdLayer.name || (isFolder ? 'Folder' : 'Layer');
    const visible = !psdLayer.hidden;
    const rawOpacity = typeof psdLayer.opacity === 'number' ? psdLayer.opacity : 1;
    const normalizedOpacity = rawOpacity > 1 ? rawOpacity / 255 : rawOpacity;
    const opacity = Math.max(0, Math.min(1, normalizedOpacity));
    const blendMode = mapPsdBlendMode(psdLayer.blendMode);
    const clipped = Boolean(psdLayer.clipping);
    const alphaLocked = Boolean(psdLayer.protected?.transparency || psdLayer.transparencyProtected);
    const locked = Boolean(psdLayer.protected?.position || psdLayer.protected?.composite);
    const maskFields = importPsdMask(psdLayer.mask, width, height);

    if (isFolder) {
      const folderItem: LayerItem = {
        id,
        name,
        type: 'folder',
        visible,
        opacity,
        blendMode,
        locked,
        alphaLocked,
        clipped,
        collapsed: psdLayer.opened === false,
        parentId,
        ...maskFields,
      };
      layers.push(folderItem);

      // Process children in reverse (ag-psd is bottom-to-top; Ink Studio is top-to-bottom)
      if (psdLayer.children) {
        for (let i = psdLayer.children.length - 1; i >= 0; i--) {
          processPsdLayer(psdLayer.children[i], id);
        }
      }
    } else {
      tileGrid.setLayerFormat(id, 'color-32bit');
      tileGrid.markLayerIngested(id);

      const dx = psdLayer.left ?? 0;
      const dy = psdLayer.top ?? 0;
      if (psdLayer.imageData) {
        writePixelDataToTileGrid(tileGrid, id, psdLayer.imageData, dx, dy, width, height);
        psdLayer.imageData = undefined;
      } else if (psdLayer.canvas) {
        const srcCtx = psdLayer.canvas.getContext('2d', { willReadFrequently: true });
        if (srcCtx && psdLayer.canvas.width > 0 && psdLayer.canvas.height > 0) {
          const imgData = srcCtx.getImageData(0, 0, psdLayer.canvas.width, psdLayer.canvas.height);
          writePixelDataToTileGrid(tileGrid, id, imgData, dx, dy, width, height);
        }
        releaseTemporaryCanvas(psdLayer.canvas);
        psdLayer.canvas = undefined;
      }

      const thumb = createCanvasThumbnail(
        { grid: tileGrid, layerId: id, dimensions: { width, height } },
        true
      );

      const rasterItem: LayerItem = {
        id,
        name,
        type: 'raster',
        visible,
        opacity,
        blendMode,
        locked,
        alphaLocked,
        clipped,
        parentId,
        thumbnailUrl: thumb,
        ...maskFields,
      };
      layers.push(rasterItem);
    }
  }

  if (psd.children && psd.children.length > 0) {
    // ag-psd stores layers bottom-to-top; reverse to match Ink Studio's top-to-bottom stack order
    for (let i = psd.children.length - 1; i >= 0; i--) {
      processPsdLayer(psd.children[i], null);
    }
  } else if (psd.imageData || psd.canvas) {
    // Single flattened composite
    const id = `psd-layer-base-${Date.now()}`;
    tileGrid.setLayerFormat(id, 'color-32bit');
    tileGrid.markLayerIngested(id);

    if (psd.imageData) {
      writePixelDataToTileGrid(tileGrid, id, psd.imageData, 0, 0, width, height);
      psd.imageData = undefined;
    } else if (psd.canvas) {
      const srcCtx = psd.canvas.getContext('2d', { willReadFrequently: true });
      if (srcCtx && psd.canvas.width > 0 && psd.canvas.height > 0) {
        const imgData = srcCtx.getImageData(0, 0, psd.canvas.width, psd.canvas.height);
        writePixelDataToTileGrid(tileGrid, id, imgData, 0, 0, width, height);
      }
      releaseTemporaryCanvas(psd.canvas);
      psd.canvas = undefined;
    }

    const thumb = createCanvasThumbnail(
      { grid: tileGrid, layerId: id, dimensions: { width, height } },
      true
    );

    layers.push({
      id,
      name: 'Background',
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      locked: false,
      alphaLocked: false,
      clipped: false,
      parentId: null,
      thumbnailUrl: thumb,
    });
  }

  // Ensure there's at least one layer
  if (layers.length === 0) {
    const id = `layer-${Date.now()}`;
    tileGrid.fillLayerSolidWhite(id, width, height, 'color-32bit');
    const thumb = createCanvasThumbnail(
      { grid: tileGrid, layerId: id, dimensions: { width, height } },
      false
    );

    layers.push({
      id,
      name: 'Layer 1',
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      locked: false,
      alphaLocked: false,
      clipped: false,
      parentId: null,
      thumbnailUrl: thumb,
    });
  }

  return {
    name: fileName.replace(/\.[^/.]+$/, ''),
    dimensions: { width, height, dpi },
    colorMode,
    layers,
    tileGrid,
  };
}
