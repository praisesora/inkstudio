/**
 * Solid layer fills and full-canvas ingestion operations for SparseTileGrid.
 */

import { setPixel1Bit } from './pixelCodec';
import {
  ISparseTileGridHost,
  PAPER_WHITE_U32,
  TILE_PIXELS,
  TILE_SIZE,
  TileFormat,
  allocateTileVersion,
  getTileByteSize,
  isLittleEndian,
  pixelToTileCoord,
} from './types';

export function fillLayerSolidColor(
  host: ISparseTileGridHost,
  layerId: string,
  width: number,
  height: number,
  colorCss: string,
  format?: TileFormat
): void {
  const lower = (colorCss || '').trim().toLowerCase();
  if (!lower || lower === 'transparent') {
    host.clearLayer(layerId);
    host.ingestedLayers.add(layerId);
    if (format) host.setLayerFormat(layerId, format);
    return;
  }
  if (lower === '#ffffff' || lower === '#fff' || lower === 'white') {
    host.fillLayerSolidWhite(layerId, width, height, format);
    return;
  }

  let r = 255, g = 255, b = 255, a = 255;
  if (lower.startsWith('#')) {
    const hex = lower.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16) || 0;
      g = parseInt(hex[1] + hex[1], 16) || 0;
      b = parseInt(hex[2] + hex[2], 16) || 0;
    } else if (hex.length >= 6) {
      r = parseInt(hex.slice(0, 2), 16) || 0;
      g = parseInt(hex.slice(2, 4), 16) || 0;
      b = parseInt(hex.slice(4, 6), 16) || 0;
      if (hex.length === 8) {
        const parsedA = parseInt(hex.slice(6, 8), 16);
        a = Number.isNaN(parsedA) ? 255 : parsedA;
      }
    }
  } else if (lower === 'black') {
    r = 0; g = 0; b = 0;
  } else {
    const rgbaMatch = lower.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
    if (rgbaMatch) {
      r = Math.max(0, Math.min(255, parseInt(rgbaMatch[1], 10)));
      g = Math.max(0, Math.min(255, parseInt(rgbaMatch[2], 10)));
      b = Math.max(0, Math.min(255, parseInt(rgbaMatch[3], 10)));
      a = rgbaMatch[4] !== undefined
        ? Math.max(0, Math.min(255, Math.round(parseFloat(rgbaMatch[4]) * 255)))
        : 255;
    }
  }

  host.clearLayer(layerId);
  host.ingestedLayers.add(layerId);
  if (format) host.setLayerFormat(layerId, format);
  if (width <= 0 || height <= 0) return;

  const targetFormat = format || host.getLayerFormat(layerId);
  const pixelU32 = isLittleEndian
    ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  const grayVal = Math.round((r * 299 + g * 587 + b * 114) / 1000);
  const isInk1Bit = a >= 24 && grayVal < 128;

  if (targetFormat === 'monochrome-1bit' && !isInk1Bit) {
    host.notifyChange();
    return;
  }

  const maxTileX = pixelToTileCoord(width - 1, 0);
  const maxTileY = pixelToTileCoord(height - 1, 0);
  const memoryManager = host.getMemoryManager();

  for (let ty = 0; ty <= maxTileY; ty++) {
    const tileDocY = ty * TILE_SIZE;
    const validH = Math.min(TILE_SIZE, height - tileDocY);
    for (let tx = 0; tx <= maxTileX; tx++) {
      const tileDocX = tx * TILE_SIZE;
      const validW = Math.min(TILE_SIZE, width - tileDocX);
      const tile = host.getOrCreateTile(layerId, tx, ty, targetFormat, 0);
      if (!tile.data) {
        tile.data = new Uint8Array(getTileByteSize(tile.format));
        memoryManager?.notifyTileAllocated(tile);
      }
      if (tile.format === 'color-32bit') {
        const dst32 = new Uint32Array(tile.data.buffer, tile.data.byteOffset, TILE_PIXELS);
        if (validW === TILE_SIZE && validH === TILE_SIZE) {
          dst32.fill(pixelU32);
          tile.solidColorU32 = pixelU32;
        } else {
          tile.solidColorU32 = undefined;
          dst32.fill(0);
          for (let y = 0; y < validH; y++) {
            const rowStart = y * TILE_SIZE;
            dst32.fill(pixelU32, rowStart, rowStart + validW);
          }
        }
      } else if (tile.format === 'grayscale-8bit') {
        tile.solidColorU32 = undefined;
        if (validW === TILE_SIZE && validH === TILE_SIZE) {
          tile.data.fill(grayVal);
        } else {
          tile.data.fill(0);
          for (let y = 0; y < validH; y++) {
            const rowStart = y * TILE_SIZE;
            tile.data.fill(grayVal, rowStart, rowStart + validW);
          }
        }
      } else {
        tile.solidColorU32 = undefined;
        tile.data.fill(0);
        for (let y = 0; y < validH; y++) {
          for (let x = 0; x < validW; x++) {
            setPixel1Bit(tile.data, x, y, true);
          }
        }
      }
      tile.dirty = true;
      tile.version = allocateTileVersion();
      host.markLodAncestorsDirty(layerId, tx, ty);
    }
  }
  host.bumpLayerVersion(layerId);
  host.notifyChange();
}

export function fillLayerSolidWhite(
  host: ISparseTileGridHost,
  layerId: string,
  width: number,
  height: number,
  format?: TileFormat
): void {
  host.clearLayer(layerId);
  host.ingestedLayers.add(layerId);
  if (format) {
    host.setLayerFormat(layerId, format);
  }
  if (width <= 0 || height <= 0) return;

  const targetFormat = format || host.getLayerFormat(layerId);
  if (targetFormat === 'monochrome-1bit') {
    // Solid white in monochrome-1bit has 0 black ink bits
    host.notifyChange();
    return;
  }

  const maxTileX = pixelToTileCoord(width - 1, 0);
  const maxTileY = pixelToTileCoord(height - 1, 0);
  const memoryManager = host.getMemoryManager();

  for (let ty = 0; ty <= maxTileY; ty++) {
    const tileDocY = ty * TILE_SIZE;
    const validH = Math.min(TILE_SIZE, height - tileDocY);
    for (let tx = 0; tx <= maxTileX; tx++) {
      const tileDocX = tx * TILE_SIZE;
      const validW = Math.min(TILE_SIZE, width - tileDocX);
      const tile = host.getOrCreateTile(layerId, tx, ty, targetFormat, 0);
      if (!tile.data) {
        tile.data = new Uint8Array(getTileByteSize(tile.format));
        memoryManager?.notifyTileAllocated(tile);
      }
      if (validW === TILE_SIZE && validH === TILE_SIZE) {
        if (tile.format === 'color-32bit') {
          new Uint32Array(tile.data.buffer, tile.data.byteOffset, TILE_PIXELS).fill(PAPER_WHITE_U32);
          tile.solidColorU32 = PAPER_WHITE_U32;
        } else {
          tile.data.fill(255);
          tile.solidColorU32 = undefined;
        }
      } else if (tile.format === 'color-32bit') {
        tile.solidColorU32 = undefined;
        const dst32 = new Uint32Array(tile.data.buffer, tile.data.byteOffset, TILE_PIXELS);
        dst32.fill(0);
        for (let y = 0; y < validH; y++) {
          const rowStart = y * TILE_SIZE;
          dst32.fill(PAPER_WHITE_U32, rowStart, rowStart + validW);
        }
      } else {
        tile.solidColorU32 = undefined;
        tile.data.fill(0);
        for (let y = 0; y < validH; y++) {
          const rowStart = y * TILE_SIZE;
          tile.data.fill(255, rowStart, rowStart + validW);
        }
      }
      tile.dirty = true;
      tile.version = allocateTileVersion();
      host.markLodAncestorsDirty(layerId, tx, ty);
    }
  }
  host.bumpLayerVersion(layerId);
  host.notifyChange();
}

export function ingestCanvas(
  host: ISparseTileGridHost,
  layerId: string,
  canvas: HTMLCanvasElement,
  format?: TileFormat
): void {
  if (canvas.width <= 0 || canvas.height <= 0) return;
  if (format) {
    host.setLayerFormat(layerId, format);
  }
  if ((canvas as any).__isBlank) {
    host.clearLayer(layerId);
    host.ingestedLayers.add(layerId);
    if (format) {
      host.setLayerFormat(layerId, format);
    }
    return;
  }
  if ((canvas as any).__isSolidWhite) {
    host.fillLayerSolidWhite(layerId, canvas.width, canvas.height, format);
    return;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  host.clearLayer(layerId);
  host.ingestedLayers.add(layerId);
  if (format) {
    host.setLayerFormat(layerId, format);
  }
  const w = canvas.width;
  const h = canvas.height;
  if (w * h <= 1024 * 1024) {
    const imgData = ctx.getImageData(0, 0, w, h);
    host.writeImageData(layerId, imgData, 0, 0, format, true);
  } else {
    const stripH = TILE_SIZE;
    for (let y = 0; y < h; y += stripH) {
      const curH = Math.min(stripH, h - y);
      const stripData = ctx.getImageData(0, y, w, curH);
      host.writeImageData(layerId, stripData, 0, y, format, true);
    }
  }
  host.notifyChange();
}
