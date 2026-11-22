/**
 * Direct tile-native pixel operations for SparseTileGrid.
 * Eliminates full-document HTMLCanvasElement materialization across tools,
 * transforms, merges, masks, resizes, and clipboard operations.
 */

import type { BlendMode, CanvasDimensions, DirtyRect } from '../../types/editor';
import { getCanvasCompositeOperation } from '../canvasUtils';
import { getPixel1Bit, packRGBATo1Bit, packRGBATo8Bit, unpack1BitToRGBA, unpack8BitToRGBA } from './pixelCodec';
import {
  BYTES_32BIT,
  ISparseTileGridHost,
  PAPER_WHITE_U32,
  TILE_PIXELS,
  TILE_SIZE,
  TileBuffer,
  TileFormat,
  TileSnapshotEntry,
  allocateTileVersion,
  getTileByteSize,
  getTileKey,
  parseTileKey,
  pixelToTileCoord,
  releaseTemporaryCanvas,
} from './types';

function isBufferAllZero(buf: Uint8Array): boolean {
  const len = buf.byteLength;
  if (buf.byteOffset % 4 === 0 && len % 4 === 0) {
    const u32 = new Uint32Array(buf.buffer, buf.byteOffset, len >>> 2);
    for (let i = 0; i < u32.length; i++) {
      if (u32[i] !== 0) return false;
    }
    return true;
  }
  for (let i = 0; i < len; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

function isRgbaAllTransparent(rgba: Uint8ClampedArray | Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 0) return false;
  }
  return true;
}

/**
 * O(1) zero-allocation single-pixel RGBA read from LOD 0 tiles.
 */
export function getPixelRGBA(
  host: ISparseTileGridHost,
  layerId: string,
  x: number,
  y: number,
  out: [number, number, number, number] = [0, 0, 0, 0]
): [number, number, number, number] {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const tx = pixelToTileCoord(ix, 0);
  const ty = pixelToTileCoord(iy, 0);
  const tile = host.getTile(layerId, tx, ty, 0);
  if (!tile || !tile.data) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    return out;
  }
  const lx = ix - tx * TILE_SIZE;
  const ly = iy - ty * TILE_SIZE;
  if (tile.format === 'color-32bit') {
    const off = (ly * TILE_SIZE + lx) << 2;
    out[0] = tile.data[off];
    out[1] = tile.data[off + 1];
    out[2] = tile.data[off + 2];
    out[3] = tile.data[off + 3];
    return out;
  }
  if (tile.format === 'monochrome-1bit') {
    const ink = getPixel1Bit(tile.data, lx, ly);
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = ink ? 255 : 0;
    return out;
  }
  const gray = tile.data[ly * TILE_SIZE + lx];
  out[0] = gray;
  out[1] = gray;
  out[2] = gray;
  out[3] = 255 - gray;
  return out;
}

/**
 * Lazily records a single LOD 0 tile's pre-edit bytes into `snapshotOut` if not yet recorded.
 */
export function snapshotSingleTileInto(
  host: ISparseTileGridHost,
  layerId: string,
  tileX: number,
  tileY: number,
  snapshotOut: Map<string, TileSnapshotEntry>
): void {
  const key = getTileKey(layerId, tileX, tileY, 0);
  if (snapshotOut.has(key)) return;
  const tile = host.getTile(layerId, tileX, tileY, 0);
  if (tile && tile.data) {
    const copy = new Uint8Array(tile.data.length);
    copy.set(tile.data);
    snapshotOut.set(key, { format: tile.format, data: copy });
  } else {
    snapshotOut.set(key, { format: host.getLayerFormat(layerId), data: null });
  }
}

/**
 * Restores a layer's LOD 0 tiles from a pre-edit snapshot map (for cancel/revert operations).
 */
export function restoreLayerSnapshot(
  host: ISparseTileGridHost,
  layerId: string,
  snapshot: Map<string, TileSnapshotEntry>,
  suppressNotify: boolean = false
): void {
  const memoryManager = host.getMemoryManager();
  // Delete any tiles that currently exist for this layer if snapshot says they didn't exist
  for (const [key, entry] of snapshot.entries()) {
    const parsed = parseTileKey(key);
    if (parsed.layerId !== layerId) continue;
    const { tileX, tileY } = parsed;
    if (!entry.data) {
      host.deleteTile(layerId, tileX, tileY, 0);
    } else {
      let tile = host.getTile(layerId, tileX, tileY, 0);
      if (!tile) {
        tile = host.getOrCreateTile(layerId, tileX, tileY, entry.format, 0);
      }
      if (!tile.data || tile.data.byteLength !== entry.data.byteLength) {
        if (tile.data) memoryManager?.notifyTileFreed(tile);
        tile.data = new Uint8Array(entry.data.length);
        memoryManager?.notifyTileAllocated(tile);
      }
      tile.data.set(entry.data);
      tile.format = entry.format;
      tile.solidColorU32 = undefined;
      tile.dirty = true;
      tile.version = allocateTileVersion();
      host.setLayerFormat(layerId, entry.format);
      host.markLodAncestorsDirty(layerId, tileX, tileY);
    }
  }
  host.bumpLayerVersion(layerId);
  if (!suppressNotify) {
    host.notifyChange(true);
  }
}

/**
 * Computes the union bounding box of allocated LOD 0 tiles clamped to document dimensions.
 */
export function getLayerTileBounds(
  host: ISparseTileGridHost,
  layerId: string,
  dims: CanvasDimensions
): DirtyRect | null {
  const tiles = host.getLayerTiles(layerId, 0);
  if (tiles.length === 0) return null;

  let minX = dims.width;
  let minY = dims.height;
  let maxX = 0;
  let maxY = 0;

  for (const tile of tiles) {
    const x0 = tile.tileX * TILE_SIZE;
    const y0 = tile.tileY * TILE_SIZE;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x0 + TILE_SIZE > maxX) maxX = x0 + TILE_SIZE;
    if (y0 + TILE_SIZE > maxY) maxY = y0 + TILE_SIZE;
  }

  const x = Math.max(0, minX);
  const y = Math.max(0, minY);
  const x1 = Math.min(dims.width, maxX);
  const y1 = Math.min(dims.height, maxY);
  if (x1 <= x || y1 <= y) return null;
  return { x, y, width: x1 - x, height: y1 - y };
}

/**
 * Computes tight pixel bounding box of non-transparent (or non-white for background) pixels
 * by scanning ONLY populated LOD 0 tiles. Zero full-canvas reads.
 */
export function getLayerContentBounds(
  host: ISparseTileGridHost,
  layerId: string,
  dims: CanvasDimensions,
  isBackground: boolean = false
): DirtyRect | null {
  const tiles = host.getLayerTiles(layerId, 0);
  if (tiles.length === 0 || dims.width <= 0 || dims.height <= 0) return null;

  let minX = dims.width;
  let minY = dims.height;
  let maxX = -1;
  let maxY = -1;

  for (const tile of tiles) {
    if (!tile.data) continue;
    if (isBackground && tile.solidColorU32 === PAPER_WHITE_U32) continue;

    const tileDocX = tile.tileX * TILE_SIZE;
    const tileDocY = tile.tileY * TILE_SIZE;
    if (tileDocX >= dims.width || tileDocY >= dims.height) continue;
    if (tileDocX + TILE_SIZE <= 0 || tileDocY + TILE_SIZE <= 0) continue;

    const startLX = Math.max(0, -tileDocX);
    const startLY = Math.max(0, -tileDocY);
    const endLX = Math.min(TILE_SIZE, dims.width - tileDocX);
    const endLY = Math.min(TILE_SIZE, dims.height - tileDocY);

    if (tile.format === 'monochrome-1bit') {
      const data = tile.data;
      for (let ly = startLY; ly < endLY; ly++) {
        const rowByteBase = ly << 5;
        const docY = tileDocY + ly;
        for (let bx = startLX >> 3, endBx = (endLX + 7) >> 3; bx < endBx; bx++) {
          const byte = data[rowByteBase + bx];
          if (byte === 0) continue;
          for (let bit = 7; bit >= 0; bit--) {
            if ((byte & (1 << bit)) === 0) continue;
            const lx = (bx << 3) + (7 - bit);
            if (lx < startLX || lx >= endLX) continue;
            const docX = tileDocX + lx;
            if (docX < minX) minX = docX;
            if (docX > maxX) maxX = docX;
            if (docY < minY) minY = docY;
            if (docY > maxY) maxY = docY;
          }
        }
      }
      continue;
    }

    const rgba = host.getTileAsRGBA(tile);
    for (let ly = startLY; ly < endLY; ly++) {
      const docY = tileDocY + ly;
      let off = (ly * TILE_SIZE + startLX) << 2;
      for (let lx = startLX; lx < endLX; lx++, off += 4) {
        const a = rgba[off + 3];
        if (a === 0) continue;
        if (isBackground && rgba[off] === 255 && rgba[off + 1] === 255 && rgba[off + 2] === 255) {
          continue;
        }
        const docX = tileDocX + lx;
        if (docX < minX) minX = docX;
        if (docX > maxX) maxX = docX;
        if (docY < minY) minY = docY;
        if (docY > maxY) maxY = docY;
      }
    }
  }

  if (maxX < 0 || maxY < 0) return null;

  const pad = 4;
  const clampedMinX = Math.max(0, minX - pad);
  const clampedMinY = Math.max(0, minY - pad);
  const clampedMaxX = Math.min(dims.width - 1, maxX + pad);
  const clampedMaxY = Math.min(dims.height - 1, maxY + pad);

  return {
    x: clampedMinX,
    y: clampedMinY,
    width: Math.min(dims.width - clampedMinX, Math.max(10, clampedMaxX - clampedMinX + 1)),
    height: Math.min(dims.height - clampedMinY, Math.max(10, clampedMaxY - clampedMinY + 1)),
  };
}

/**
 * Deletes any LOD 0 tiles in `layerId` whose pixel buffers are completely zero/transparent.
 */
export function pruneEmptyTiles(host: ISparseTileGridHost, layerId: string): number {
  const tiles = host.getLayerTiles(layerId, 0);
  let pruned = 0;
  for (const tile of tiles) {
    if (!tile.data) continue;
    const isEmpty =
      tile.format === 'color-32bit'
        ? isRgbaAllTransparent(tile.data)
        : isBufferAllZero(tile.data);
    if (isEmpty) {
      host.deleteTile(layerId, tile.tileX, tile.tileY, 0);
      pruned++;
    }
  }
  return pruned;
}

/**
 * Clears (or fills solid white for background layers) an arbitrary document rect directly in LOD 0 tiles.
 */
export function clearRectInLayer(
  host: ISparseTileGridHost,
  layerId: string,
  rect: DirtyRect,
  fillWhite: boolean = false,
  snapshotOut?: Map<string, TileSnapshotEntry>,
  suppressNotify: boolean = false
): void {
  const x0 = Math.floor(rect.x);
  const y0 = Math.floor(rect.y);
  const x1 = Math.ceil(rect.x + rect.width);
  const y1 = Math.ceil(rect.y + rect.height);
  if (x1 <= x0 || y1 <= y0) return;

  const minTx = pixelToTileCoord(x0, 0);
  const minTy = pixelToTileCoord(y0, 0);
  const maxTx = pixelToTileCoord(x1 - 1, 0);
  const maxTy = pixelToTileCoord(y1 - 1, 0);
  const layerFmt = host.getLayerFormat(layerId);

  for (let ty = minTy; ty <= maxTy; ty++) {
    const tileDocY = ty * TILE_SIZE;
    const startLY = Math.max(0, y0 - tileDocY);
    const endLY = Math.min(TILE_SIZE, y1 - tileDocY);
    if (startLY >= endLY) continue;

    for (let tx = minTx; tx <= maxTx; tx++) {
      const tileDocX = tx * TILE_SIZE;
      const startLX = Math.max(0, x0 - tileDocX);
      const endLX = Math.min(TILE_SIZE, x1 - tileDocX);
      if (startLX >= endLX) continue;

      const existing = host.getTile(layerId, tx, ty, 0);
      if (!fillWhite && !existing) continue;

      if (snapshotOut) {
        snapshotSingleTileInto(host, layerId, tx, ty, snapshotOut);
      }

      const fullTile = startLX === 0 && startLY === 0 && endLX === TILE_SIZE && endLY === TILE_SIZE;
      if (!fillWhite && fullTile) {
        host.deleteTile(layerId, tx, ty, 0);
        continue;
      }

      const tile = existing ?? host.getOrCreateTile(layerId, tx, ty, layerFmt, 0);
      if (!tile.data) {
        tile.data = new Uint8Array(getTileByteSize(tile.format));
        host.getMemoryManager()?.notifyTileAllocated(tile);
      }

      if (tile.format === 'color-32bit') {
        const u32 = new Uint32Array(tile.data.buffer, tile.data.byteOffset, TILE_PIXELS);
        const fillVal = fillWhite ? PAPER_WHITE_U32 : 0;
        if (fullTile) {
          u32.fill(fillVal);
          tile.solidColorU32 = fillWhite ? PAPER_WHITE_U32 : undefined;
        } else {
          tile.solidColorU32 = undefined;
          for (let ly = startLY; ly < endLY; ly++) {
            const row = ly * TILE_SIZE;
            u32.fill(fillVal, row + startLX, row + endLX);
          }
        }
        if (!fillWhite && isRgbaAllTransparent(tile.data)) {
          host.deleteTile(layerId, tx, ty, 0);
          continue;
        }
      } else if (tile.format === 'monochrome-1bit') {
        const dst = tile.data;
        for (let ly = startLY; ly < endLY; ly++) {
          const rowBase = ly << 5;
          for (let lx = startLX; lx < endLX; lx++) {
            dst[rowBase + (lx >> 3)] &= ~(1 << (7 - (lx & 7)));
          }
        }
        if (isBufferAllZero(dst)) {
          host.deleteTile(layerId, tx, ty, 0);
          continue;
        }
      } else {
        const fillByte = fillWhite ? 255 : 0;
        for (let ly = startLY; ly < endLY; ly++) {
          const row = ly * TILE_SIZE;
          tile.data.fill(fillByte, row + startLX, row + endLX);
        }
        if (!fillWhite && isBufferAllZero(tile.data)) {
          host.deleteTile(layerId, tx, ty, 0);
          continue;
        }
      }

      tile.dirty = true;
      tile.version = allocateTileVersion();
      host.markLodAncestorsDirty(layerId, tx, ty);
    }
  }

  host.bumpLayerVersion(layerId);
  if (!suppressNotify) {
    host.notifyChange(true);
  }
}

/**
 * Applies an in-place RGBA transform callback to every populated LOD 0 tile of `layerId`.
 * Automatically unpacks/repacks 1-bit/8-bit/32-bit tiles and deletes tiles that become empty.
 */
export function transformLayerTiles(
  host: ISparseTileGridHost,
  layerId: string,
  visitor: (rgba: Uint8ClampedArray, tileX: number, tileY: number) => boolean | void,
  options?: {
    targetFormat?: TileFormat;
    monoThreshold?: number;
    snapshotOut?: Map<string, TileSnapshotEntry>;
    suppressNotify?: boolean;
  }
): boolean {
  const tiles = host.getLayerTiles(layerId, 0);
  if (tiles.length === 0) return false;

  const targetFormat = options?.targetFormat ?? host.getLayerFormat(layerId);
  const monoThreshold = options?.monoThreshold ?? 128;
  const memoryManager = host.getMemoryManager();
  let anyModified = false;

  for (const tile of tiles) {
    if (!tile.data) continue;
    if (options?.snapshotOut) {
      snapshotSingleTileInto(host, layerId, tile.tileX, tile.tileY, options.snapshotOut);
    }

    const workRgba =
      tile.format === 'color-32bit' && targetFormat === 'color-32bit'
        ? new Uint8ClampedArray(tile.data.buffer, tile.data.byteOffset, BYTES_32BIT)
        : new Uint8ClampedArray(host.getTileAsRGBA(tile));

    const changed = visitor(workRgba, tile.tileX, tile.tileY);
    if (changed === false) continue;

    if (isRgbaAllTransparent(workRgba)) {
      host.deleteTile(layerId, tile.tileX, tile.tileY, 0);
      anyModified = true;
      continue;
    }

    if (tile.format !== targetFormat) {
      memoryManager?.notifyTileFreed(tile);
      tile.format = targetFormat;
      tile.data = new Uint8Array(getTileByteSize(targetFormat));
      memoryManager?.notifyTileAllocated(tile);
    }

    if (targetFormat === 'color-32bit') {
      if (workRgba.buffer !== tile.data.buffer) {
        tile.data.set(workRgba);
      }
    } else if (targetFormat === 'monochrome-1bit') {
      packRGBATo1Bit(workRgba, tile.data, monoThreshold);
      if (isBufferAllZero(tile.data)) {
        host.deleteTile(layerId, tile.tileX, tile.tileY, 0);
        anyModified = true;
        continue;
      }
    } else {
      packRGBATo8Bit(workRgba, tile.data);
    }

    tile.solidColorU32 = undefined;
    tile.dirty = true;
    tile.version = allocateTileVersion();
    host.markLodAncestorsDirty(layerId, tile.tileX, tile.tileY);
    anyModified = true;
  }

  host.setLayerFormat(layerId, targetFormat);
  if (anyModified) {
    host.bumpLayerVersion(layerId);
    if (!options?.suppressNotify) {
      host.notifyChange(true);
    }
  }
  return anyModified;
}

/**
 * Merges `srcLayerId` down onto `dstLayerId` strictly tile-by-tile (peak scratch: two 256x256 canvases = 512 KB).
 */
export function mergeLayersInGrid(
  host: ISparseTileGridHost,
  srcLayerId: string,
  dstLayerId: string,
  options: {
    opacity: number;
    blendMode: BlendMode;
    visible: boolean;
    maskCanvas?: HTMLCanvasElement;
    maskEnabled?: boolean;
    dimensions: CanvasDimensions;
    dstFormat?: TileFormat;
  }
): void {
  const { opacity, blendMode, visible, maskCanvas, maskEnabled, dimensions } = options;
  const effectiveAlpha = visible ? Math.max(0, Math.min(1, opacity)) : 0;
  if (effectiveAlpha <= 0.001 || !host.hasLayerTiles(srcLayerId)) {
    host.clearLayer(srcLayerId);
    host.notifyChange(true);
    return;
  }

  const srcTiles = host.getLayerTiles(srcLayerId, 0);
  const dstFormat = options.dstFormat ?? host.getLayerFormat(dstLayerId);

  if (typeof document === 'undefined') {
    // Headless fallback: straight alpha-over per tile
    for (const srcTile of srcTiles) {
      if (!srcTile.data) continue;
      const srcRgba = new Uint8ClampedArray(host.getTileAsRGBA(srcTile));
      const dstTile = host.getOrCreateTile(dstLayerId, srcTile.tileX, srcTile.tileY, dstFormat, 0);
      const dstRgba = new Uint8ClampedArray(host.getTileAsRGBA(dstTile));
      for (let i = 0; i < BYTES_32BIT; i += 4) {
        const sA = (srcRgba[i + 3] / 255) * effectiveAlpha;
        if (sA <= 0) continue;
        const dA = dstRgba[i + 3] / 255;
        const outA = sA + dA * (1 - sA);
        if (outA > 0) {
          dstRgba[i] = Math.round((srcRgba[i] * sA + dstRgba[i] * dA * (1 - sA)) / outA);
          dstRgba[i + 1] = Math.round((srcRgba[i + 1] * sA + dstRgba[i + 1] * dA * (1 - sA)) / outA);
          dstRgba[i + 2] = Math.round((srcRgba[i + 2] * sA + dstRgba[i + 2] * dA * (1 - sA)) / outA);
          dstRgba[i + 3] = Math.round(outA * 255);
        }
      }
      host.writeImageData(
        dstLayerId,
        { data: dstRgba, width: TILE_SIZE, height: TILE_SIZE },
        srcTile.tileX * TILE_SIZE,
        srcTile.tileY * TILE_SIZE,
        dstFormat,
        true
      );
    }
    host.clearLayer(srcLayerId);
    host.notifyChange(true);
    return;
  }

  const srcTileCanvas = document.createElement('canvas');
  srcTileCanvas.width = TILE_SIZE;
  srcTileCanvas.height = TILE_SIZE;
  const sCtx = srcTileCanvas.getContext('2d', { willReadFrequently: true });

  const dstTileCanvas = document.createElement('canvas');
  dstTileCanvas.width = TILE_SIZE;
  dstTileCanvas.height = TILE_SIZE;
  const dCtx = dstTileCanvas.getContext('2d', { willReadFrequently: true });

  const hasMask = Boolean(maskCanvas && maskEnabled !== false);
  const maskCtx = hasMask && maskCanvas ? maskCanvas.getContext('2d', { willReadFrequently: true }) : null;
  const compositeOp = getCanvasCompositeOperation(blendMode);

  try {
    if (!sCtx || !dCtx) return;

    for (const srcTile of srcTiles) {
      if (!srcTile.data) continue;
      const tx = srcTile.tileX;
      const ty = srcTile.tileY;
      const docX = tx * TILE_SIZE;
      const docY = ty * TILE_SIZE;
      const validW = Math.min(TILE_SIZE, dimensions.width - docX);
      const validH = Math.min(TILE_SIZE, dimensions.height - docY);
      if (validW <= 0 || validH <= 0) continue;

      const srcRgba = new Uint8ClampedArray(host.getTileAsRGBA(srcTile));

      if (hasMask && maskCtx && maskCanvas) {
        const mw = Math.min(validW, Math.max(0, maskCanvas.width - docX));
        const mh = Math.min(validH, Math.max(0, maskCanvas.height - docY));
        if (mw > 0 && mh > 0) {
          const mData = maskCtx.getImageData(docX, docY, mw, mh).data;
          for (let py = 0; py < validH; py++) {
            for (let px = 0; px < validW; px++) {
              const pOff = (py * TILE_SIZE + px) << 2;
              if (srcRgba[pOff + 3] === 0) continue;
              if (px < mw && py < mh) {
                const mOff = (py * mw + px) << 2;
                const maskLum =
                  ((0.299 * mData[mOff] + 0.587 * mData[mOff + 1] + 0.114 * mData[mOff + 2]) / 255) *
                  (mData[mOff + 3] / 255);
                srcRgba[pOff + 3] = Math.round(srcRgba[pOff + 3] * maskLum);
              } else {
                srcRgba[pOff + 3] = 0;
              }
            }
          }
        }
      }

      sCtx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
      sCtx.putImageData(new ImageData(srcRgba, TILE_SIZE, TILE_SIZE), 0, 0);

      dCtx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
      const existingDst = host.getTile(dstLayerId, tx, ty, 0);
      if (existingDst && existingDst.data) {
        const dstRgba = new Uint8ClampedArray(host.getTileAsRGBA(existingDst));
        dCtx.putImageData(new ImageData(dstRgba, TILE_SIZE, TILE_SIZE), 0, 0);
      }

      dCtx.save();
      dCtx.globalAlpha = effectiveAlpha;
      dCtx.globalCompositeOperation = compositeOp;
      dCtx.drawImage(srcTileCanvas, 0, 0);
      dCtx.restore();

      const merged = dCtx.getImageData(0, 0, validW, validH);
      host.writeImageData(dstLayerId, merged, docX, docY, dstFormat, true);
    }
  } finally {
    releaseTemporaryCanvas(srcTileCanvas);
    releaseTemporaryCanvas(dstTileCanvas);
  }

  host.clearLayer(srcLayerId);
  host.notifyChange(true);
}

/**
 * Permanently applies a grayscale mask canvas directly to populated tiles of `layerId`.
 * Peak memory: 1 tile (256 KB).
 */
export function applyMaskCanvasToLayer(
  host: ISparseTileGridHost,
  layerId: string,
  maskCanvas: HTMLCanvasElement,
  dimensions: CanvasDimensions
): void {
  const mCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!mCtx) return;

  transformLayerTiles(host, layerId, (rgba, tx, ty) => {
    const docX = tx * TILE_SIZE;
    const docY = ty * TILE_SIZE;
    const validW = Math.min(TILE_SIZE, dimensions.width - docX, maskCanvas.width - docX);
    const validH = Math.min(TILE_SIZE, dimensions.height - docY, maskCanvas.height - docY);
    if (validW <= 0 || validH <= 0) {
      rgba.fill(0);
      return true;
    }
    const mData = mCtx.getImageData(docX, docY, validW, validH).data;
    for (let py = 0; py < TILE_SIZE; py++) {
      for (let px = 0; px < TILE_SIZE; px++) {
        const off = (py * TILE_SIZE + px) << 2;
        if (rgba[off + 3] === 0) continue;
        if (px < validW && py < validH) {
          const mOff = (py * validW + px) << 2;
          const lum =
            ((0.299 * mData[mOff] + 0.587 * mData[mOff + 1] + 0.114 * mData[mOff + 2]) / 255) *
            (mData[mOff + 3] / 255);
          rgba[off + 3] = Math.round(rgba[off + 3] * lum);
        } else {
          rgba[off + 3] = 0;
        }
      }
    }
    return true;
  });
}

/**
 * Resizes a single layer directly in SparseTileGrid (anchor shift/crop or chunked bilinear scale)
 * without allocating monolithic old/new full-document HTMLCanvasElements.
 */
export function resizeLayerInGrid(
  host: ISparseTileGridHost,
  layerId: string,
  oldDims: CanvasDimensions,
  newDims: CanvasDimensions,
  options: {
    scaleContent: boolean;
    offsetX: number;
    offsetY: number;
    isBackground: boolean;
    backgroundColor: string;
    targetFormat: TileFormat;
  }
): void {
  const { scaleContent, offsetX, offsetY, isBackground, backgroundColor, targetFormat } = options;
  const newW = newDims.width;
  const newH = newDims.height;

  const oldTiles = host.getLayerTiles(layerId, 0);
  if (oldTiles.length === 0) {
    host.clearLayer(layerId);
    if (isBackground && backgroundColor !== 'transparent') {
      // Caller handles solid fill via fillLayerSolidColor
      host.fillLayerSolidWhite(layerId, newW, newH, 'color-32bit');
    } else {
      host.setLayerFormat(layerId, targetFormat);
      host.ingestedLayers.add(layerId);
    }
    return;
  }

  // Detach a snapshot of old LOD 0 tiles so we can rebuild layerId cleanly
  const oldTileMap = new Map<string, { format: TileFormat; data: Uint8Array }>();
  for (const t of oldTiles) {
    if (!t.data) continue;
    const copy = new Uint8Array(t.data.length);
    copy.set(t.data);
    oldTileMap.set(`${t.tileX}:${t.tileY}`, { format: t.format, data: copy });
  }

  const readOldRgba = (tx: number, ty: number, scratch: Uint8ClampedArray): Uint8ClampedArray | null => {
    const entry = oldTileMap.get(`${tx}:${ty}`);
    if (!entry) return null;
    if (entry.format === 'color-32bit') {
      return new Uint8ClampedArray(entry.data.buffer, entry.data.byteOffset, BYTES_32BIT);
    }
    if (entry.format === 'monochrome-1bit') {
      unpack1BitToRGBA(entry.data, scratch);
      return scratch;
    }
    unpack8BitToRGBA(entry.data, scratch);
    return scratch;
  };

  host.clearLayer(layerId);
  host.setLayerFormat(layerId, targetFormat);
  host.ingestedLayers.add(layerId);

  const bgRgb = isBackground && backgroundColor !== 'transparent' ? parseHexSimple(backgroundColor) : null;

  if (!scaleContent) {
    // Fast exact tile-aligned shift when offset is a multiple of TILE_SIZE and no bg fill needed
    if (!bgRgb && offsetX % TILE_SIZE === 0 && offsetY % TILE_SIZE === 0) {
      const dTx = offsetX / TILE_SIZE;
      const dTy = offsetY / TILE_SIZE;
      const maxNewTx = pixelToTileCoord(newW - 1, 0);
      const maxNewTy = pixelToTileCoord(newH - 1, 0);

      for (const [k, entry] of oldTileMap.entries()) {
        const [otxStr, otyStr] = k.split(':');
        const ntx = parseInt(otxStr, 10) + dTx;
        const nty = parseInt(otyStr, 10) + dTy;
        if (ntx < 0 || nty < 0 || ntx > maxNewTx || nty > maxNewTy) continue;

        const docX = ntx * TILE_SIZE;
        const docY = nty * TILE_SIZE;
        const validW = Math.min(TILE_SIZE, newW - docX);
        const validH = Math.min(TILE_SIZE, newH - docY);
        if (validW === TILE_SIZE && validH === TILE_SIZE && entry.format === targetFormat) {
          const newTile: TileBuffer = {
            layerId,
            tileX: ntx,
            tileY: nty,
            format: entry.format,
            data: entry.data,
            dirty: true,
            version: allocateTileVersion(),
            isPagedToDisk: false,
            lastAccessTimestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
            lod: 0,
          };
          host.setTile(layerId, ntx, nty, newTile);
        } else {
          const scratch = new Uint8ClampedArray(BYTES_32BIT);
          const rgba = readOldRgba(parseInt(otxStr, 10), parseInt(otyStr, 10), scratch);
          if (rgba) {
            const cropped = new Uint8ClampedArray(validW * validH * 4);
            for (let y = 0; y < validH; y++) {
              cropped.set(rgba.subarray(y * TILE_SIZE * 4, y * TILE_SIZE * 4 + validW * 4), y * validW * 4);
            }
            host.writeImageData(layerId, { data: cropped, width: validW, height: validH }, docX, docY, targetFormat, true);
          }
        }
      }
      host.bumpLayerVersion(layerId);
      return;
    }

    // General anchor offset (tile-by-tile, zero monolithic canvas)
    const dstTileCoords = new Set<string>();
    const maxNewTx = pixelToTileCoord(newW - 1, 0);
    const maxNewTy = pixelToTileCoord(newH - 1, 0);

    if (bgRgb) {
      for (let ty = 0; ty <= maxNewTy; ty++) {
        for (let tx = 0; tx <= maxNewTx; tx++) {
          dstTileCoords.add(`${tx}:${ty}`);
        }
      }
    } else {
      for (const k of oldTileMap.keys()) {
        const [otxStr, otyStr] = k.split(':');
        const nx0 = Math.max(0, parseInt(otxStr, 10) * TILE_SIZE + offsetX);
        const ny0 = Math.max(0, parseInt(otyStr, 10) * TILE_SIZE + offsetY);
        const nx1 = Math.min(newW, (parseInt(otxStr, 10) + 1) * TILE_SIZE + offsetX);
        const ny1 = Math.min(newH, (parseInt(otyStr, 10) + 1) * TILE_SIZE + offsetY);
        if (nx1 <= nx0 || ny1 <= ny0) continue;
        const tx0 = pixelToTileCoord(nx0, 0);
        const ty0 = pixelToTileCoord(ny0, 0);
        const tx1 = pixelToTileCoord(nx1 - 1, 0);
        const ty1 = pixelToTileCoord(ny1 - 1, 0);
        for (let ty = ty0; ty <= ty1; ty++) {
          for (let tx = tx0; tx <= tx1; tx++) {
            dstTileCoords.add(`${tx}:${ty}`);
          }
        }
      }
    }

    const srcScratch = new Uint8ClampedArray(BYTES_32BIT);
    const dstRgba = new Uint8ClampedArray(BYTES_32BIT);

    for (const key of dstTileCoords) {
      const [txStr, tyStr] = key.split(':');
      const tx = parseInt(txStr, 10);
      const ty = parseInt(tyStr, 10);
      const docX = tx * TILE_SIZE;
      const docY = ty * TILE_SIZE;
      const validW = Math.min(TILE_SIZE, newW - docX);
      const validH = Math.min(TILE_SIZE, newH - docY);
      if (validW <= 0 || validH <= 0) continue;

      dstRgba.fill(0);
      if (bgRgb) {
        for (let y = 0; y < validH; y++) {
          let off = y * TILE_SIZE * 4;
          for (let x = 0; x < validW; x++, off += 4) {
            dstRgba[off] = bgRgb[0];
            dstRgba[off + 1] = bgRgb[1];
            dstRgba[off + 2] = bgRgb[2];
            dstRgba[off + 3] = bgRgb[3];
          }
        }
      }

      const oldMinX = Math.max(0, docX - offsetX);
      const oldMinY = Math.max(0, docY - offsetY);
      const oldMaxX = Math.min(oldDims.width, docX + validW - offsetX);
      const oldMaxY = Math.min(oldDims.height, docY + validH - offsetY);

      if (oldMaxX > oldMinX && oldMaxY > oldMinY) {
        const oTx0 = pixelToTileCoord(oldMinX, 0);
        const oTy0 = pixelToTileCoord(oldMinY, 0);
        const oTx1 = pixelToTileCoord(oldMaxX - 1, 0);
        const oTy1 = pixelToTileCoord(oldMaxY - 1, 0);

        for (let oty = oTy0; oty <= oTy1; oty++) {
          const oDocY = oty * TILE_SIZE;
          for (let otx = oTx0; otx <= oTx1; otx++) {
            const srcRgba = readOldRgba(otx, oty, srcScratch);
            if (!srcRgba) continue;
            const oDocX = otx * TILE_SIZE;

            const sx0 = Math.max(oldMinX, oDocX);
            const sy0 = Math.max(oldMinY, oDocY);
            const sx1 = Math.min(oldMaxX, oDocX + TILE_SIZE);
            const sy1 = Math.min(oldMaxY, oDocY + TILE_SIZE);
            const copyW = sx1 - sx0;
            if (copyW <= 0 || sy1 <= sy0) continue;

            for (let sy = sy0; sy < sy1; sy++) {
              const sLocalY = sy - oDocY;
              const sLocalX = sx0 - oDocX;
              const dLocalY = sy + offsetY - docY;
              const dLocalX = sx0 + offsetX - docX;
              const sOff = (sLocalY * TILE_SIZE + sLocalX) << 2;
              const dOff = (dLocalY * TILE_SIZE + dLocalX) << 2;
              if (bgRgb) {
                // Alpha-over onto background color
                for (let k = 0; k < copyW; k++) {
                  const si = sOff + (k << 2);
                  const di = dOff + (k << 2);
                  const sa = srcRgba[si + 3];
                  if (sa === 255) {
                    dstRgba[di] = srcRgba[si];
                    dstRgba[di + 1] = srcRgba[si + 1];
                    dstRgba[di + 2] = srcRgba[si + 2];
                    dstRgba[di + 3] = 255;
                  } else if (sa > 0) {
                    const a = sa / 255;
                    const inv = 1 - a;
                    dstRgba[di] = Math.round(srcRgba[si] * a + dstRgba[di] * inv);
                    dstRgba[di + 1] = Math.round(srcRgba[si + 1] * a + dstRgba[di + 1] * inv);
                    dstRgba[di + 2] = Math.round(srcRgba[si + 2] * a + dstRgba[di + 2] * inv);
                    dstRgba[di + 3] = 255;
                  }
                }
              } else {
                dstRgba.set(srcRgba.subarray(sOff, sOff + (copyW << 2)), dOff);
              }
            }
          }
        }
      }

      if (!isRgbaAllTransparent(dstRgba)) {
        const outBuf =
          validW === TILE_SIZE && validH === TILE_SIZE
            ? dstRgba
            : cropTileRgba(dstRgba, validW, validH);
        host.writeImageData(layerId, { data: outBuf, width: validW, height: validH }, docX, docY, targetFormat, true);
      }
    }
    host.bumpLayerVersion(layerId);
    return;
  }

  // Scaled resize: process destination tiles one by one via bilinear sampling from oldTileMap (zero monolithic canvas!)
  const scaleX = oldDims.width / Math.max(1, newW);
  const scaleY = oldDims.height / Math.max(1, newH);
  const maxNewTx = pixelToTileCoord(newW - 1, 0);
  const maxNewTy = pixelToTileCoord(newH - 1, 0);

  // Determine which destination tiles overlap any populated old tile
  const dstTileCoords = new Set<string>();
  if (bgRgb) {
    for (let ty = 0; ty <= maxNewTy; ty++) {
      for (let tx = 0; tx <= maxNewTx; tx++) {
        dstTileCoords.add(`${tx}:${ty}`);
      }
    }
  } else {
    for (const k of oldTileMap.keys()) {
      const [otxStr, otyStr] = k.split(':');
      const ox0 = parseInt(otxStr, 10) * TILE_SIZE;
      const oy0 = parseInt(otyStr, 10) * TILE_SIZE;
      const nx0 = Math.max(0, Math.floor(ox0 / scaleX) - 1);
      const ny0 = Math.max(0, Math.floor(oy0 / scaleY) - 1);
      const nx1 = Math.min(newW, Math.ceil((ox0 + TILE_SIZE) / scaleX) + 1);
      const ny1 = Math.min(newH, Math.ceil((oy0 + TILE_SIZE) / scaleY) + 1);
      if (nx1 <= nx0 || ny1 <= ny0) continue;
      for (let ty = pixelToTileCoord(ny0, 0); ty <= pixelToTileCoord(ny1 - 1, 0); ty++) {
        for (let tx = pixelToTileCoord(nx0, 0); tx <= pixelToTileCoord(nx1 - 1, 0); tx++) {
          dstTileCoords.add(`${tx}:${ty}`);
        }
      }
    }
  }

  // Small LRU cache of unpacked old tiles during scaling
  const unpackedCache = new Map<string, Uint8ClampedArray | null>();
  const sampleOld = (ix: number, iy: number, out: [number, number, number, number]) => {
    const cx = Math.max(0, Math.min(oldDims.width - 1, ix));
    const cy = Math.max(0, Math.min(oldDims.height - 1, iy));
    const otx = cx >> 8;
    const oty = cy >> 8;
    const key = `${otx}:${oty}`;
    let rgba = unpackedCache.get(key);
    if (rgba === undefined) {
      if (unpackedCache.size > 64) unpackedCache.clear();
      const scratch = new Uint8ClampedArray(BYTES_32BIT);
      rgba = readOldRgba(otx, oty, scratch);
      unpackedCache.set(key, rgba);
    }
    if (!rgba) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
      return;
    }
    const off = ((cy & 255) * TILE_SIZE + (cx & 255)) << 2;
    out[0] = rgba[off];
    out[1] = rgba[off + 1];
    out[2] = rgba[off + 2];
    out[3] = rgba[off + 3];
  };

  const dstRgba = new Uint8ClampedArray(BYTES_32BIT);
  const p00: [number, number, number, number] = [0, 0, 0, 0];
  const p10: [number, number, number, number] = [0, 0, 0, 0];
  const p01: [number, number, number, number] = [0, 0, 0, 0];
  const p11: [number, number, number, number] = [0, 0, 0, 0];

  for (const key of dstTileCoords) {
    const [txStr, tyStr] = key.split(':');
    const tx = parseInt(txStr, 10);
    const ty = parseInt(tyStr, 10);
    const docX = tx * TILE_SIZE;
    const docY = ty * TILE_SIZE;
    const validW = Math.min(TILE_SIZE, newW - docX);
    const validH = Math.min(TILE_SIZE, newH - docY);
    if (validW <= 0 || validH <= 0) continue;

    dstRgba.fill(0);
    for (let ly = 0; ly < validH; ly++) {
      const sy = (docY + ly + 0.5) * scaleY - 0.5;
      const y0 = Math.floor(sy);
      const fy = sy - y0;
      for (let lx = 0; lx < validW; lx++) {
        const sx = (docX + lx + 0.5) * scaleX - 0.5;
        const x0 = Math.floor(sx);
        const fx = sx - x0;

        sampleOld(x0, y0, p00);
        sampleOld(x0 + 1, y0, p10);
        sampleOld(x0, y0 + 1, p01);
        sampleOld(x0 + 1, y0 + 1, p11);

        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;

        const a = Math.round(p00[3] * w00 + p10[3] * w10 + p01[3] * w01 + p11[3] * w11);
        const off = (ly * TILE_SIZE + lx) << 2;
        if (a > 0) {
          const r = Math.round(p00[0] * w00 + p10[0] * w10 + p01[0] * w01 + p11[0] * w11);
          const g = Math.round(p00[1] * w00 + p10[1] * w10 + p01[1] * w01 + p11[1] * w11);
          const b = Math.round(p00[2] * w00 + p10[2] * w10 + p01[2] * w01 + p11[2] * w11);
          if (bgRgb && a < 255) {
            const af = a / 255;
            const inv = 1 - af;
            dstRgba[off] = Math.round(r * af + bgRgb[0] * inv);
            dstRgba[off + 1] = Math.round(g * af + bgRgb[1] * inv);
            dstRgba[off + 2] = Math.round(b * af + bgRgb[2] * inv);
            dstRgba[off + 3] = 255;
          } else {
            dstRgba[off] = r;
            dstRgba[off + 1] = g;
            dstRgba[off + 2] = b;
            dstRgba[off + 3] = a;
          }
        } else if (bgRgb) {
          dstRgba[off] = bgRgb[0];
          dstRgba[off + 1] = bgRgb[1];
          dstRgba[off + 2] = bgRgb[2];
          dstRgba[off + 3] = bgRgb[3];
        }
      }
    }

    if (!isRgbaAllTransparent(dstRgba)) {
      const outBuf =
        validW === TILE_SIZE && validH === TILE_SIZE
          ? dstRgba
          : cropTileRgba(dstRgba, validW, validH);
      host.writeImageData(layerId, { data: outBuf, width: validW, height: validH }, docX, docY, targetFormat, true);
    }
  }
  host.bumpLayerVersion(layerId);
}

/**
 * Deep-clones populated LOD 0 tiles of `layerId` for tile-backed clipboard storage.
 */
export function copyLayerTilesSnapshot(
  host: ISparseTileGridHost,
  layerId: string
): { format: TileFormat; tiles: Array<{ tileX: number; tileY: number; format: TileFormat; data: Uint8Array }> } {
  const format = host.getLayerFormat(layerId);
  const tiles: Array<{ tileX: number; tileY: number; format: TileFormat; data: Uint8Array }> = [];
  for (const tile of host.getLayerTiles(layerId, 0)) {
    if (!tile.data) continue;
    const copy = new Uint8Array(tile.data.length);
    copy.set(tile.data);
    tiles.push({ tileX: tile.tileX, tileY: tile.tileY, format: tile.format, data: copy });
  }
  return { format, tiles };
}

/**
 * Pastes a tile snapshot directly into `dstLayerId` without touching HTMLCanvasElement.
 */
export function pasteLayerTilesSnapshot(
  host: ISparseTileGridHost,
  dstLayerId: string,
  snapshot: { format: TileFormat; tiles: Array<{ tileX: number; tileY: number; format: TileFormat; data: Uint8Array }> }
): void {
  host.clearLayer(dstLayerId);
  host.setLayerFormat(dstLayerId, snapshot.format);
  host.ingestedLayers.add(dstLayerId);
  for (const entry of snapshot.tiles) {
    const copy = new Uint8Array(entry.data.length);
    copy.set(entry.data);
    host.setTile(dstLayerId, entry.tileX, entry.tileY, {
      layerId: dstLayerId,
      tileX: entry.tileX,
      tileY: entry.tileY,
      format: entry.format,
      data: copy,
      dirty: true,
      version: allocateTileVersion(),
      isPagedToDisk: false,
      lastAccessTimestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      lod: 0,
    });
  }
  host.notifyChange(true);
}

function cropTileRgba(fullTile: Uint8ClampedArray, validW: number, validH: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(validW * validH * 4);
  for (let y = 0; y < validH; y++) {
    const srcOff = y * TILE_SIZE * 4;
    out.set(fullTile.subarray(srcOff, srcOff + validW * 4), y * validW * 4);
  }
  return out;
}

function parseHexSimple(css: string): [number, number, number, number] {
  const lower = css.trim().toLowerCase();
  if (lower === 'white' || lower === '#fff' || lower === '#ffffff') return [255, 255, 255, 255];
  if (lower === 'black' || lower === '#000' || lower === '#000000') return [0, 0, 0, 255];
  if (lower.startsWith('#')) {
    const hex = lower.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16) || 0,
        parseInt(hex[1] + hex[1], 16) || 0,
        parseInt(hex[2] + hex[2], 16) || 0,
        255,
      ];
    }
    if (hex.length >= 6) {
      return [
        parseInt(hex.slice(0, 2), 16) || 0,
        parseInt(hex.slice(2, 4), 16) || 0,
        parseInt(hex.slice(4, 6), 16) || 0,
        hex.length === 8 ? parseInt(hex.slice(6, 8), 16) || 255 : 255,
      ];
    }
  }
  return [255, 255, 255, 255];
}
