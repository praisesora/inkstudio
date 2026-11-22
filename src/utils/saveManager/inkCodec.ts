import { ViewportCompositor } from '../compositor';
import {
  SparseTileGrid,
  TileBuffer,
  getTileByteSize,
  releaseTemporaryCanvas,
} from '../tileEngine';
import {
  INK_BYTE_TO_TILE_FORMAT,
  INK_TILE_FORMAT_TO_BYTE,
  MASK_BINARY_HEADER_BYTES,
  MAX_DOCUMENT_DIM,
  PREVIEW_MAX_DIM,
  SaveDocumentData,
  TILE_BINARY_HEADER_BYTES,
  canvasToBlob,
} from './types';

export function encodeNativeTileRecord(tile: TileBuffer, rawBytes: Uint8Array): Uint8Array {
  const fmtByte = INK_TILE_FORMAT_TO_BYTE[tile.format] ?? 2;
  const out = new Uint8Array(TILE_BINARY_HEADER_BYTES + rawBytes.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, fmtByte);
  view.setUint32(1, tile.version >>> 0, true);
  view.setUint32(5, rawBytes.byteLength >>> 0, true);
  out.set(rawBytes, TILE_BINARY_HEADER_BYTES);
  return out;
}

export function decodeNativeTileRecord(
  layerId: string,
  tileX: number,
  tileY: number,
  payload: Uint8Array
): TileBuffer {
  if (payload.byteLength < TILE_BINARY_HEADER_BYTES) {
    throw new Error(`Corrupted .ink tile (${layerId} ${tileX}_${tileY}): header truncated`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const fmtByte = view.getUint8(0);
  const format = INK_BYTE_TO_TILE_FORMAT[fmtByte];
  if (!format) {
    throw new Error(`Corrupted .ink tile (${layerId} ${tileX}_${tileY}): unknown format byte ${fmtByte}`);
  }
  const version = view.getUint32(1, true);
  const dataLen = view.getUint32(5, true);
  const expectedLen = getTileByteSize(format);
  if (dataLen !== expectedLen || payload.byteLength !== TILE_BINARY_HEADER_BYTES + expectedLen) {
    throw new Error(
      `Corrupted .ink tile (${layerId} ${tileX}_${tileY}): length mismatch (expected ${expectedLen}, got ${dataLen}/${payload.byteLength - TILE_BINARY_HEADER_BYTES})`
    );
  }
  const data = new Uint8Array(expectedLen);
  data.set(payload.subarray(TILE_BINARY_HEADER_BYTES, TILE_BINARY_HEADER_BYTES + expectedLen));
  return {
    layerId,
    tileX,
    tileY,
    format,
    data,
    dirty: true,
    version: version || 1,
    isPagedToDisk: false,
    lastAccessTimestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    lod: 0,
  };
}

export function encodeMaskBinary(maskCanvas: HTMLCanvasElement): { width: number; height: number; record: Uint8Array } | null {
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  if (w <= 0 || h <= 0 || w > MAX_DOCUMENT_DIM || h > MAX_DOCUMENT_DIM) return null;
  const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || typeof ctx.getImageData !== 'function') return null;

  const src = ctx.getImageData(0, 0, w, h).data;
  const pixelCount = w * h;
  const record = new Uint8Array(MASK_BINARY_HEADER_BYTES + pixelCount);
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  view.setUint32(0, w >>> 0, true);
  view.setUint32(4, h >>> 0, true);

  for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
    record[MASK_BINARY_HEADER_BYTES + p] = Math.round(
      ((0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) * src[i + 3]) / 255
    );
  }
  return { width: w, height: h, record };
}

export function decodeMaskBinary(payload: Uint8Array): { width: number; height: number; data: Uint8Array } {
  if (payload.byteLength < MASK_BINARY_HEADER_BYTES) {
    throw new Error('Corrupted .ink mask: header truncated');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  if (width === 0 || height === 0 || width > MAX_DOCUMENT_DIM || height > MAX_DOCUMENT_DIM) {
    throw new Error(`Invalid .ink mask dimensions: ${width}x${height}`);
  }
  const expectedPixels = width * height;
  if (payload.byteLength !== MASK_BINARY_HEADER_BYTES + expectedPixels) {
    throw new Error(
      `Corrupted .ink mask: expected ${expectedPixels} bytes, got ${payload.byteLength - MASK_BINARY_HEADER_BYTES}`
    );
  }
  const data = new Uint8Array(expectedPixels);
  data.set(payload.subarray(MASK_BINARY_HEADER_BYTES));
  return { width, height, data };
}

export function createMaskCanvasFromAlpha(width: number, height: number, alpha: Uint8Array): HTMLCanvasElement | undefined {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.putImageData !== 'function') return undefined;

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < alpha.length; p++, i += 4) {
    const v = alpha[p];
    rgba[i] = v;
    rgba[i + 1] = v;
    rgba[i + 2] = v;
    rgba[i + 3] = 255;
  }
  if (typeof ImageData !== 'undefined') {
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  } else if (typeof ctx.createImageData === 'function') {
    const imgData = ctx.createImageData(width, height);
    imgData.data.set(rgba);
    ctx.putImageData(imgData, 0, 0);
  }
  return canvas;
}

export async function generatePreviewPng(
  data: SaveDocumentData,
  tileGrid: SparseTileGrid | undefined
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  if (typeof document === 'undefined' || data.dimensions.width <= 0 || data.dimensions.height <= 0) {
    return null;
  }
  const scale = Math.min(1, PREVIEW_MAX_DIM / Math.max(data.dimensions.width, data.dimensions.height));
  const outW = Math.max(1, Math.round(data.dimensions.width * scale));
  const outH = Math.max(1, Math.round(data.dimensions.height * scale));
  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = outW;
  previewCanvas.height = outH;

  if (typeof previewCanvas.toBlob !== 'function') {
    releaseTemporaryCanvas(previewCanvas);
    return null;
  }

  try {
    if (tileGrid) {
      ViewportCompositor.renderLowResPreview(previewCanvas, data.layers, data.dimensions, tileGrid, {
        showCheckerboard: false,
      });
    } else {
      const ctx = previewCanvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outW, outH);
      for (let i = data.layers.length - 1; i >= 0; i--) {
        const layer = data.layers[i];
        if (!layer.visible || layer.opacity <= 0.001) continue;
        const src = data.layerCanvasesMap?.get(layer.id);
        if (!src) continue;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
        ctx.drawImage(src, 0, 0, outW, outH);
        ctx.restore();
      }
    }

    const blob = await canvasToBlob(previewCanvas, 'image/png');
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength === 0) return null;
    return { bytes, width: outW, height: outH };
  } catch {
    return null;
  } finally {
    releaseTemporaryCanvas(previewCanvas);
  }
}
