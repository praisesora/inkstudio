/**
 * Sparse Virtual Tile Engine & Color Expression System
 *
 * Designed for 600 DPI professional manga production (B4: 4961 x 7016 px, 70MP double spreads)
 * with zero allocation for empty space, multi-format pixel packing (1-bit monochrome,
 * 8-bit grayscale, 32-bit RGBA), SIMD/bitwise rasterizers, and fast RLE compression.
 */

import { TileDelta } from '../types/editor';

export const TILE_SIZE = 256;
export const TILE_PIXELS = TILE_SIZE * TILE_SIZE; // 65,536 pixels
export const BYTES_1BIT = TILE_PIXELS >> 3; // 8,192 bytes
export const BYTES_8BIT = TILE_PIXELS; // 65,536 bytes
export const BYTES_32BIT = TILE_PIXELS << 2; // 262,144 bytes

export type TileFormat = 'monochrome-1bit' | 'grayscale-8bit' | 'color-32bit';

export interface TileBuffer {
  layerId: string;
  tileX: number;
  tileY: number;
  format: TileFormat;
  data: Uint8Array;
  dirty: boolean;
  version: number;
}

// System endianness detection for 32-bit operations
export const isLittleEndian = (() => {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = 0x11223344;
  return new Uint8Array(buf)[0] === 0x44;
})();

// Default binary colors in system byte order
// Black ink: RGBA(0, 0, 0, 255)
export const INK_BLACK_U32 = isLittleEndian ? 0xff000000 : 0x000000ff;
// Transparent: RGBA(0, 0, 0, 0)
export const TRANSPARENT_U32 = 0x00000000;
// Paper white: RGBA(255, 255, 255, 255)
export const PAPER_WHITE_U32 = 0xffffffff;

/**
 * 256-entry lookup table mapping a 1-bit byte (8 pixels)
 * into eight 32-bit pixel values for ultra-fast zero-loop unpacking.
 */
const LUT_1BIT_TO_RGBA_BLACK = new Uint32Array(256 * 8);
const LUT_1BIT_TO_RGBA_WHITE = new Uint32Array(256 * 8);

for (let b = 0; b < 256; b++) {
  const offset = b * 8;
  for (let bit = 0; bit < 8; bit++) {
    // MSB first: bit 7 is the leftmost pixel
    const isSet = (b & (1 << (7 - bit))) !== 0;
    LUT_1BIT_TO_RGBA_BLACK[offset + bit] = isSet ? INK_BLACK_U32 : TRANSPARENT_U32;
    LUT_1BIT_TO_RGBA_WHITE[offset + bit] = isSet ? PAPER_WHITE_U32 : TRANSPARENT_U32;
  }
}

/**
 * Get tile coordinate from document pixel coordinate.
 */
export function pixelToTileCoord(pixel: number): number {
  return Math.floor(pixel / TILE_SIZE);
}

/**
 * Spatial hash map key for tiles.
 */
export function getTileKey(layerId: string, tileX: number, tileY: number): string {
  return `${layerId}:${tileX}:${tileY}`;
}

/**
 * Parse spatial hash map key into components.
 */
export function parseTileKey(key: string): { layerId: string; tileX: number; tileY: number } {
  const parts = key.split(':');
  return {
    layerId: parts[0],
    tileX: parseInt(parts[1], 10),
    tileY: parseInt(parts[2], 10),
  };
}

/**
 * Allocate a new TileBuffer with zero-initialized memory.
 */
export function createTileBuffer(
  layerId: string,
  tileX: number,
  tileY: number,
  format: TileFormat
): TileBuffer {
  let size = BYTES_32BIT;
  if (format === 'monochrome-1bit') size = BYTES_1BIT;
  else if (format === 'grayscale-8bit') size = BYTES_8BIT;

  return {
    layerId,
    tileX,
    tileY,
    format,
    data: new Uint8Array(size),
    dirty: true,
    version: 1,
  };
}

/**
 * Set a single 1-bit pixel (MSB first packing).
 */
export function setPixel1Bit(data: Uint8Array, x: number, y: number, value: boolean | number): void {
  const pixelIndex = y * TILE_SIZE + x;
  const byteIndex = pixelIndex >> 3;
  const bitOffset = 7 - (pixelIndex & 7);
  if (value) {
    data[byteIndex] |= (1 << bitOffset);
  } else {
    data[byteIndex] &= ~(1 << bitOffset);
  }
}

/**
 * Get a single 1-bit pixel (MSB first packing). Returns 0 or 1.
 */
export function getPixel1Bit(data: Uint8Array, x: number, y: number): number {
  const pixelIndex = y * TILE_SIZE + x;
  const byteIndex = pixelIndex >> 3;
  const bitOffset = 7 - (pixelIndex & 7);
  return (data[byteIndex] >> bitOffset) & 1;
}

/**
 * Unpacks an 8,192-byte 1-bit tile into a 262,144-byte RGBA buffer
 * using the precomputed 32-bit LUT.
 */
export function unpack1BitToRGBA(
  src1Bit: Uint8Array,
  dstRGBA: Uint8ClampedArray | Uint8Array,
  inkColorU32: number = INK_BLACK_U32,
  paperColorU32: number = TRANSPARENT_U32
): void {
  const dst32 = new Uint32Array(dstRGBA.buffer, dstRGBA.byteOffset, TILE_PIXELS);

  if (inkColorU32 === INK_BLACK_U32 && paperColorU32 === TRANSPARENT_U32) {
    // Fast path: direct copy from black ink LUT
    let dstOffset = 0;
    for (let i = 0; i < BYTES_1BIT; i++) {
      const lutOffset = src1Bit[i] * 8;
      dst32[dstOffset] = LUT_1BIT_TO_RGBA_BLACK[lutOffset];
      dst32[dstOffset + 1] = LUT_1BIT_TO_RGBA_BLACK[lutOffset + 1];
      dst32[dstOffset + 2] = LUT_1BIT_TO_RGBA_BLACK[lutOffset + 2];
      dst32[dstOffset + 3] = LUT_1BIT_TO_RGBA_BLACK[lutOffset + 3];
      dst32[dstOffset + 4] = LUT_1BIT_TO_RGBA_BLACK[lutOffset + 4];
      dst32[dstOffset + 5] = LUT_1BIT_TO_RGBA_BLACK[lutOffset + 5];
      dst32[dstOffset + 6] = LUT_1BIT_TO_RGBA_BLACK[lutOffset + 6];
      dst32[dstOffset + 7] = LUT_1BIT_TO_RGBA_BLACK[lutOffset + 7];
      dstOffset += 8;
    }
  } else {
    // General path with custom colors
    let dstOffset = 0;
    for (let i = 0; i < BYTES_1BIT; i++) {
      const b = src1Bit[i];
      dst32[dstOffset] = (b & 0x80) ? inkColorU32 : paperColorU32;
      dst32[dstOffset + 1] = (b & 0x40) ? inkColorU32 : paperColorU32;
      dst32[dstOffset + 2] = (b & 0x20) ? inkColorU32 : paperColorU32;
      dst32[dstOffset + 3] = (b & 0x10) ? inkColorU32 : paperColorU32;
      dst32[dstOffset + 4] = (b & 0x08) ? inkColorU32 : paperColorU32;
      dst32[dstOffset + 5] = (b & 0x04) ? inkColorU32 : paperColorU32;
      dst32[dstOffset + 6] = (b & 0x02) ? inkColorU32 : paperColorU32;
      dst32[dstOffset + 7] = (b & 0x01) ? inkColorU32 : paperColorU32;
      dstOffset += 8;
    }
  }
}

/**
 * Packs a 256x256 RGBA buffer (262,144 bytes) into an 8,192-byte 1-bit tile.
 * Applies perceptual ITU-R BT.601 luminance thresholding and alpha checking.
 */
export function packRGBATo1Bit(
  srcRGBA: Uint8ClampedArray | Uint8Array,
  dst1Bit: Uint8Array,
  threshold: number = 128
): void {
  dst1Bit.fill(0);
  let srcOffset = 0;
  let dstByte = 0;

  for (let i = 0; i < BYTES_1BIT; i++) {
    let byteVal = 0;
    for (let bit = 7; bit >= 0; bit--) {
      const r = srcRGBA[srcOffset];
      const g = srcRGBA[srcOffset + 1];
      const b = srcRGBA[srcOffset + 2];
      const a = srcRGBA[srcOffset + 3];

      if (a >= 24) {
        // Luminance: 0.299*R + 0.587*G + 0.114*B
        const lum = (r * 299 + g * 587 + b * 114) / 1000;
        // Dark pixels become ink (1), light pixels transparent (0)
        if (lum < threshold) {
          byteVal |= (1 << bit);
        }
      }
      srcOffset += 4;
    }
    dst1Bit[dstByte++] = byteVal;
  }
}

/**
 * Unpacks an 8-bit grayscale tile into RGBA.
 */
export function unpack8BitToRGBA(
  src8Bit: Uint8Array,
  dstRGBA: Uint8ClampedArray | Uint8Array
): void {
  const dst32 = new Uint32Array(dstRGBA.buffer, dstRGBA.byteOffset, TILE_PIXELS);
  for (let i = 0; i < TILE_PIXELS; i++) {
    const val = src8Bit[i];
    if (val === 0) {
      dst32[i] = TRANSPARENT_U32;
    } else {
      // Manga grayscale: val is ink darkness (0 = white/transparent, 255 = solid black ink)
      // or standard luminance (0 = black, 255 = white).
      // Here: standard luminance with full opacity
      const a = 255;
      dst32[i] = isLittleEndian
        ? (a << 24) | (val << 16) | (val << 8) | val
        : (val << 24) | (val << 16) | (val << 8) | a;
    }
  }
}

/**
 * Packs RGBA to 8-bit grayscale using perceptual ITU-R BT.601 luminance.
 */
export function packRGBATo8Bit(
  srcRGBA: Uint8ClampedArray | Uint8Array,
  dst8Bit: Uint8Array
): void {
  let srcOffset = 0;
  for (let i = 0; i < TILE_PIXELS; i++) {
    const a = srcRGBA[srcOffset + 3];
    if (a < 10) {
      dst8Bit[i] = 0;
    } else {
      const r = srcRGBA[srcOffset];
      const g = srcRGBA[srcOffset + 1];
      const b = srcRGBA[srcOffset + 2];
      dst8Bit[i] = Math.round((r * 299 + g * 587 + b * 114) / 1000);
    }
    srcOffset += 4;
  }
}

/**
 * High-speed Run-Length Encoding (RLE) for compressing tile data
 * for network streaming and tile-delta history storage.
 *
 * Encoding format:
 * [Count: 1 byte, Value: 1 byte] for repeating bytes up to 255 runs.
 */
export function compressRLE(data: Uint8Array): Uint8Array {
  const len = data.length;
  if (len === 0) return new Uint8Array(0);

  // Worst-case capacity: 2x input length
  const output = new Uint8Array(len * 2);
  let outIdx = 0;
  let i = 0;

  while (i < len) {
    const val = data[i];
    let run = 1;
    while (i + run < len && data[i + run] === val && run < 255) {
      run++;
    }
    output[outIdx++] = run;
    output[outIdx++] = val;
    i += run;
  }

  return output.subarray(0, outIdx);
}

/**
 * Decompresses RLE-encoded byte buffer back to target length.
 */
export function decompressRLE(compressed: Uint8Array, expectedLength: number): Uint8Array {
  const output = new Uint8Array(expectedLength);
  let inIdx = 0;
  let outIdx = 0;
  const inLen = compressed.length;

  while (inIdx < inLen && outIdx < expectedLength) {
    const count = compressed[inIdx++];
    const val = compressed[inIdx++];
    for (let c = 0; c < count && outIdx < expectedLength; c++) {
      output[outIdx++] = val;
    }
  }

  return output;
}

/**
 * Compresses a TileBuffer into a compact binary package.
 * Header:
 * [tileX: Int32, tileY: Int32, formatId: Uint8, version: Uint32, rlePayload...]
 */
export function serializeTileBuffer(tile: TileBuffer): Uint8Array {
  const rle = compressRLE(tile.data);
  const headerSize = 13; // 4 + 4 + 1 + 4
  const packet = new Uint8Array(headerSize + rle.length);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

  view.setInt32(0, tile.tileX, true);
  view.setInt32(4, tile.tileY, true);
  const formatCode = tile.format === 'monochrome-1bit' ? 1 : tile.format === 'grayscale-8bit' ? 2 : 4;
  view.setUint8(8, formatCode);
  view.setUint32(9, tile.version, true);

  packet.set(rle, headerSize);
  return packet;
}

/**
 * Deserializes a TileBuffer from a binary packet.
 */
export function deserializeTileBuffer(layerId: string, packet: Uint8Array): TileBuffer {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const tileX = view.getInt32(0, true);
  const tileY = view.getInt32(4, true);
  const formatCode = view.getUint8(8);
  const version = view.getUint32(9, true);

  const format: TileFormat = formatCode === 1 ? 'monochrome-1bit' : formatCode === 2 ? 'grayscale-8bit' : 'color-32bit';
  let expectedLen = BYTES_32BIT;
  if (format === 'monochrome-1bit') expectedLen = BYTES_1BIT;
  else if (format === 'grayscale-8bit') expectedLen = BYTES_8BIT;

  const rlePayload = packet.subarray(13);
  const data = decompressRLE(rlePayload, expectedLen);

  return {
    layerId,
    tileX,
    tileY,
    format,
    data,
    dirty: true,
    version,
  };
}

/**
 * Sparse Virtual Tile Grid
 *
 * Spatial hash map allocating memory only where ink exists.
 * At 600 DPI B4 (4961 x 7016 px), a blank canvas consumes 0 bytes of tile memory!
 */
export class SparseTileGrid {
  private tiles: Map<string, TileBuffer> = new Map();
  private layerFormats: Map<string, TileFormat> = new Map();
  private scratchRGBA: Uint8ClampedArray = new Uint8ClampedArray(BYTES_32BIT);
  private listeners: Set<(immediate?: boolean) => void> = new Set();

  constructor() {}

  public subscribe(listener: (immediate?: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public notifyChange(immediate?: boolean): void {
    this.listeners.forEach((fn) => fn(immediate));
  }

  /**
   * Set the default pixel format for a layer.
   */
  public setLayerFormat(layerId: string, format: TileFormat): void {
    this.layerFormats.set(layerId, format);
  }

  /**
   * Get the format for a layer, defaulting to color-32bit.
   */
  public getLayerFormat(layerId: string): TileFormat {
    return this.layerFormats.get(layerId) || 'color-32bit';
  }

  /**
   * Check if a tile exists in memory.
   */
  public hasTile(layerId: string, tileX: number, tileY: number): boolean {
    return this.tiles.has(getTileKey(layerId, tileX, tileY));
  }

  /**
   * Get an existing tile buffer or null if unpainted.
   */
  public getTile(layerId: string, tileX: number, tileY: number): TileBuffer | null {
    return this.tiles.get(getTileKey(layerId, tileX, tileY)) || null;
  }

  /**
   * Get an existing tile buffer or allocate a new zero-initialized tile.
   */
  public getOrCreateTile(layerId: string, tileX: number, tileY: number, format?: TileFormat): TileBuffer {
    const key = getTileKey(layerId, tileX, tileY);
    let tile = this.tiles.get(key);
    if (!tile) {
      const fmt = format || this.getLayerFormat(layerId);
      tile = createTileBuffer(layerId, tileX, tileY, fmt);
      this.tiles.set(key, tile);
    }
    return tile;
  }

  /**
   * Set or replace a tile buffer.
   */
  public setTile(layerId: string, tileX: number, tileY: number, tile: TileBuffer): void {
    const key = getTileKey(layerId, tileX, tileY);
    this.tiles.set(key, tile);
    this.notifyChange();
  }

  /**
   * Delete a tile from memory (reclaiming space).
   */
  public deleteTile(layerId: string, tileX: number, tileY: number): void {
    this.tiles.delete(getTileKey(layerId, tileX, tileY));
  }

  /**
   * Get all allocated tiles for a layer.
   */
  public getLayerTiles(layerId: string): TileBuffer[] {
    const prefix = `${layerId}:`;
    const result: TileBuffer[] = [];
    for (const [key, tile] of this.tiles.entries()) {
      if (key.startsWith(prefix)) {
        result.push(tile);
      }
    }
    return result;
  }

  /**
   * Get all tiles overlapping the given bounding box in document coordinates.
   */
  public getTilesInBounds(
    layerId: string,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
  ): TileBuffer[] {
    const minTileX = pixelToTileCoord(minX);
    const minTileY = pixelToTileCoord(minY);
    const maxTileX = pixelToTileCoord(maxX);
    const maxTileY = pixelToTileCoord(maxY);

    const result: TileBuffer[] = [];
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const tile = this.getTile(layerId, tx, ty);
        if (tile) {
          result.push(tile);
        }
      }
    }
    return result;
  }

  /**
   * Get tile coordinates intersecting document bounds.
   */
  public getIntersectingCoords(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
  ): Array<{ tileX: number; tileY: number }> {
    const minTileX = pixelToTileCoord(minX);
    const minTileY = pixelToTileCoord(minY);
    const maxTileX = pixelToTileCoord(maxX);
    const maxTileY = pixelToTileCoord(maxY);

    const coords: Array<{ tileX: number; tileY: number }> = [];
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        coords.push({ tileX: tx, tileY: ty });
      }
    }
    return coords;
  }

  /**
   * Converts any tile to a 256x256 RGBA Uint8ClampedArray for WebGL texture upload or 2D blitting.
   */
  public getTileAsRGBA(tile: TileBuffer): Uint8ClampedArray {
    if (tile.format === 'color-32bit') {
      return new Uint8ClampedArray(tile.data.buffer, tile.data.byteOffset, BYTES_32BIT);
    }
    if (tile.format === 'monochrome-1bit') {
      unpack1BitToRGBA(tile.data, this.scratchRGBA);
      return this.scratchRGBA;
    }
    // 8-bit grayscale
    unpack8BitToRGBA(tile.data, this.scratchRGBA);
    return this.scratchRGBA;
  }

  /**
   * Writes an ImageData or RGBA buffer into the sparse tile grid.
   * Only allocates tiles that actually intersect the drawn rectangle.
   */
  public writeImageData(
    layerId: string,
    imgData: { data: Uint8ClampedArray | Uint8Array; width: number; height: number },
    destX: number,
    destY: number,
    format?: TileFormat
  ): { minTileX: number; minTileY: number; maxTileX: number; maxTileY: number } {
    const targetFormat = format || this.getLayerFormat(layerId);
    const w = imgData.width;
    const h = imgData.height;
    if (w <= 0 || h <= 0) {
      return { minTileX: 0, minTileY: 0, maxTileX: 0, maxTileY: 0 };
    }

    const minTileX = pixelToTileCoord(destX);
    const minTileY = pixelToTileCoord(destY);
    const maxTileX = pixelToTileCoord(destX + w - 1);
    const maxTileY = pixelToTileCoord(destY + h - 1);

    const tileScratch = new Uint8ClampedArray(BYTES_32BIT);

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      const tileDocY = ty * TILE_SIZE;
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const tileDocX = tx * TILE_SIZE;

        // Intersection of tile with source rectangle
        const srcStartX = Math.max(0, tileDocX - destX);
        const srcStartY = Math.max(0, tileDocY - destY);
        const srcEndX = Math.min(w, tileDocX + TILE_SIZE - destX);
        const srcEndY = Math.min(h, tileDocY + TILE_SIZE - destY);

        if (srcStartX >= srcEndX || srcStartY >= srcEndY) continue;

        const tile = this.getOrCreateTile(layerId, tx, ty, targetFormat);

        // If tile is 32-bit RGBA
        if (tile.format === 'color-32bit') {
          for (let sy = srcStartY; sy < srcEndY; sy++) {
            const tileLocalY = destY + sy - tileDocY;
            const tileLocalX = destX + srcStartX - tileDocX;
            const copyWidth = srcEndX - srcStartX;

            const srcByteOffset = (sy * w + srcStartX) * 4;
            const tileByteOffset = (tileLocalY * TILE_SIZE + tileLocalX) * 4;

            tile.data.set(
              imgData.data.subarray(srcByteOffset, srcByteOffset + copyWidth * 4),
              tileByteOffset
            );
          }
        } else if (tile.format === 'monochrome-1bit') {
          // Read existing 1-bit tile as RGBA to preserve non-overlapping parts
          unpack1BitToRGBA(tile.data, tileScratch);

          // Overwrite intersecting region
          for (let sy = srcStartY; sy < srcEndY; sy++) {
            const tileLocalY = destY + sy - tileDocY;
            const tileLocalX = destX + srcStartX - tileDocX;
            const copyWidth = srcEndX - srcStartX;

            const srcByteOffset = (sy * w + srcStartX) * 4;
            const tileByteOffset = (tileLocalY * TILE_SIZE + tileLocalX) * 4;

            tileScratch.set(
              imgData.data.subarray(srcByteOffset, srcByteOffset + copyWidth * 4),
              tileByteOffset
            );
          }

          // Pack back to 1-bit
          packRGBATo1Bit(tileScratch, tile.data);
        } else {
          // Grayscale 8-bit
          unpack8BitToRGBA(tile.data, tileScratch);
          for (let sy = srcStartY; sy < srcEndY; sy++) {
            const tileLocalY = destY + sy - tileDocY;
            const tileLocalX = destX + srcStartX - tileDocX;
            const copyWidth = srcEndX - srcStartX;

            const srcByteOffset = (sy * w + srcStartX) * 4;
            const tileByteOffset = (tileLocalY * TILE_SIZE + tileLocalX) * 4;

            tileScratch.set(
              imgData.data.subarray(srcByteOffset, srcByteOffset + copyWidth * 4),
              tileByteOffset
            );
          }
          packRGBATo8Bit(tileScratch, tile.data);
        }

        tile.dirty = true;
        tile.version++;
      }
    }

    this.notifyChange();
    return { minTileX, minTileY, maxTileX, maxTileY };
  }

  /**
   * Reads a document rectangular region into an RGBA ImageData-compatible buffer.
   * If a tile doesn't exist, it contributes transparent pixels (zero allocation).
   */
  public readImageData(
    layerId: string,
    x: number,
    y: number,
    width: number,
    height: number
  ): { data: Uint8ClampedArray; width: number; height: number } {
    const outData = new Uint8ClampedArray(width * height * 4);
    if (width <= 0 || height <= 0) return { data: outData, width, height };

    const minTileX = pixelToTileCoord(x);
    const minTileY = pixelToTileCoord(y);
    const maxTileX = pixelToTileCoord(x + width - 1);
    const maxTileY = pixelToTileCoord(y + height - 1);

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      const tileDocY = ty * TILE_SIZE;
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const tile = this.getTile(layerId, tx, ty);
        if (!tile) continue; // Unpainted tile is transparent

        const tileDocX = tx * TILE_SIZE;
        const tileRGBA = this.getTileAsRGBA(tile);

        const interStartX = Math.max(x, tileDocX);
        const interStartY = Math.max(y, tileDocY);
        const interEndX = Math.min(x + width, tileDocX + TILE_SIZE);
        const interEndY = Math.min(y + height, tileDocY + TILE_SIZE);

        for (let py = interStartY; py < interEndY; py++) {
          const tileLocalY = py - tileDocY;
          const tileLocalX = interStartX - tileDocX;
          const outLocalY = py - y;
          const outLocalX = interStartX - x;
          const copyWidth = interEndX - interStartX;

          const tileOffset = (tileLocalY * TILE_SIZE + tileLocalX) * 4;
          const outOffset = (outLocalY * width + outLocalX) * 4;

          outData.set(tileRGBA.subarray(tileOffset, tileOffset + copyWidth * 4), outOffset);
        }
      }
    }

    return { data: outData, width, height };
  }

  /**
   * Render an entire layer or a dirtyRect directly onto a standard HTMLCanvasElement.
   */
  public renderLayerToCanvas(
    layerId: string,
    targetCanvas: HTMLCanvasElement,
    dirtyRect?: { x: number; y: number; width: number; height: number }
  ): void {
    const ctx = targetCanvas.getContext('2d');
    if (!ctx) return;

    let minX = 0;
    let minY = 0;
    let maxX = targetCanvas.width;
    let maxY = targetCanvas.height;

    if (dirtyRect) {
      minX = Math.max(0, Math.floor(dirtyRect.x));
      minY = Math.max(0, Math.floor(dirtyRect.y));
      maxX = Math.min(targetCanvas.width, Math.ceil(dirtyRect.x + dirtyRect.width));
      maxY = Math.min(targetCanvas.height, Math.ceil(dirtyRect.y + dirtyRect.height));
    }

    ctx.clearRect(minX, minY, maxX - minX, maxY - minY);

    const minTileX = pixelToTileCoord(minX);
    const minTileY = pixelToTileCoord(minY);
    const maxTileX = pixelToTileCoord(maxX - 1);
    const maxTileY = pixelToTileCoord(maxY - 1);

    // Reuse helper canvas to draw tiles
    let helperCanvas: HTMLCanvasElement | null = null;
    let helperCtx: CanvasRenderingContext2D | null = null;

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      const tileDocY = ty * TILE_SIZE;
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const tile = this.getTile(layerId, tx, ty);
        if (!tile) continue;

        const tileDocX = tx * TILE_SIZE;
        const rgba = this.getTileAsRGBA(tile);

        if (!helperCanvas) {
          helperCanvas = document.createElement('canvas');
          helperCanvas.width = TILE_SIZE;
          helperCanvas.height = TILE_SIZE;
          helperCtx = helperCanvas.getContext('2d');
        }

        if (helperCtx) {
          const clamped = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, BYTES_32BIT);
          const imgData = new ImageData(clamped, TILE_SIZE, TILE_SIZE);
          helperCtx.putImageData(imgData, 0, 0);
          ctx.drawImage(helperCanvas, tileDocX, tileDocY);
        }
      }
    }
  }

  /**
   * Ingest an existing HTMLCanvasElement into the tile grid.
   */
  public ingestCanvas(layerId: string, canvas: HTMLCanvasElement, format?: TileFormat): void {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || canvas.width <= 0 || canvas.height <= 0) return;

    this.clearLayer(layerId);
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    this.writeImageData(layerId, imgData, 0, 0, format);
    this.notifyChange();
  }

  /**
   * Clear all tiles associated with a layer.
   */
  public clearLayer(layerId: string): void {
    const prefix = `${layerId}:`;
    const toDelete: string[] = [];
    for (const key of this.tiles.keys()) {
      if (key.startsWith(prefix)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this.tiles.delete(key);
    }
    this.notifyChange();
  }

  /**
   * Clone all tiles from one layer into another.
   */
  public cloneLayer(srcLayerId: string, dstLayerId: string): void {
    this.clearLayer(dstLayerId);
    const srcTiles = this.getLayerTiles(srcLayerId);
    for (const srcTile of srcTiles) {
      const clonedData = new Uint8Array(srcTile.data.length);
      clonedData.set(srcTile.data);
      const clonedTile: TileBuffer = {
        layerId: dstLayerId,
        tileX: srcTile.tileX,
        tileY: srcTile.tileY,
        format: srcTile.format,
        data: clonedData,
        dirty: true,
        version: 1,
      };
      this.setTile(dstLayerId, srcTile.tileX, srcTile.tileY, clonedTile);
    }
  }

  /**
   * Calculate exact memory consumption metrics.
   */
  public getMemoryStats(): {
    totalBytes: number;
    tileCount: number;
    formatCounts: Record<TileFormat, number>;
  } {
    let totalBytes = 0;
    const formatCounts: Record<TileFormat, number> = {
      'monochrome-1bit': 0,
      'grayscale-8bit': 0,
      'color-32bit': 0,
    };

    for (const tile of this.tiles.values()) {
      totalBytes += tile.data.byteLength;
      formatCounts[tile.format]++;
    }

    return {
      totalBytes,
      tileCount: this.tiles.size,
      formatCounts,
    };
  }

  /**
   * Take an in-memory snapshot of all tiles in a document bounding box.
   */
  public snapshotTilesInRect(
    layerId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): Map<string, { format: TileFormat; data: Uint8Array | null }> {
    const snapshot = new Map<string, { format: TileFormat; data: Uint8Array | null }>();
    if (bounds.width <= 0 || bounds.height <= 0) return snapshot;

    const minTileX = pixelToTileCoord(bounds.x);
    const minTileY = pixelToTileCoord(bounds.y);
    const maxTileX = pixelToTileCoord(bounds.x + bounds.width - 1);
    const maxTileY = pixelToTileCoord(bounds.y + bounds.height - 1);

    const layerFormat = this.getLayerFormat(layerId);

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const key = getTileKey(layerId, tx, ty);
        const tile = this.getTile(layerId, tx, ty);
        if (tile) {
          const copy = new Uint8Array(tile.data.length);
          copy.set(tile.data);
          snapshot.set(key, { format: tile.format, data: copy });
        } else {
          snapshot.set(key, { format: layerFormat, data: null });
        }
      }
    }

    return snapshot;
  }

  /**
   * Compare current tiles in bounding box against the snapshot to produce minimal TileDeltas.
   */
  public computeDeltasFromSnapshot(
    beforeSnapshot: Map<string, { format: TileFormat; data: Uint8Array | null }>,
    layerId: string,
    bounds?: { x: number; y: number; width: number; height: number }
  ): TileDelta[] {
    const deltas: TileDelta[] = [];
    const keysToCheck = new Set<string>(beforeSnapshot.keys());

    // Also include any newly created tiles in the current bounding box
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      const minTileX = pixelToTileCoord(bounds.x);
      const minTileY = pixelToTileCoord(bounds.y);
      const maxTileX = pixelToTileCoord(bounds.x + bounds.width - 1);
      const maxTileY = pixelToTileCoord(bounds.y + bounds.height - 1);
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        for (let tx = minTileX; tx <= maxTileX; tx++) {
          keysToCheck.add(getTileKey(layerId, tx, ty));
        }
      }
    }

    for (const key of keysToCheck) {
      const before = beforeSnapshot.get(key);
      const { tileX, tileY } = parseTileKey(key);
      const currentTile = this.getTile(layerId, tileX, tileY);

      const beforeData = before ? before.data : null;
      const afterData = currentTile ? new Uint8Array(currentTile.data) : null;
      const format = currentTile ? currentTile.format : (before ? before.format : this.getLayerFormat(layerId));

      if (beforeData === null && afterData === null) continue;

      let changed = false;
      if ((beforeData === null) !== (afterData === null)) {
        changed = true;
      } else if (beforeData && afterData) {
        if (beforeData.byteLength !== afterData.byteLength) {
          changed = true;
        } else {
          for (let i = 0; i < beforeData.byteLength; i++) {
            if (beforeData[i] !== afterData[i]) {
              changed = true;
              break;
            }
          }
        }
      }

      if (changed) {
        deltas.push({
          key,
          format,
          beforeData,
          afterData,
        });
      }
    }

    return deltas;
  }

  /**
   * Apply a list of TileDeltas in either undo or redo direction.
   */
  public applyTileDeltas(deltas: TileDelta[], direction: 'undo' | 'redo'): void {
    for (const delta of deltas) {
      const { layerId, tileX, tileY } = parseTileKey(delta.key);
      const targetData = direction === 'undo' ? delta.beforeData : delta.afterData;

      if (!targetData) {
        this.deleteTile(layerId, tileX, tileY);
      } else {
        let tile = this.getTile(layerId, tileX, tileY);
        if (!tile) {
          tile = this.getOrCreateTile(layerId, tileX, tileY, delta.format);
        }
        if (tile.data.byteLength === targetData.byteLength) {
          tile.data.set(targetData);
        } else {
          tile.data = new Uint8Array(targetData.length);
          tile.data.set(targetData);
          tile.format = delta.format;
        }
        tile.dirty = true;
        tile.version++;
      }
    }
    this.notifyChange();
  }

  /**
   * Reset the entire grid.
   */
  public clearAll(): void {
    this.tiles.clear();
    this.layerFormats.clear();
  }
}

const FORMAT_TO_BYTE: Record<TileFormat, number> = {
  'monochrome-1bit': 0,
  'grayscale-8bit': 1,
  'color-32bit': 2,
};

const BYTE_TO_FORMAT: TileFormat[] = [
  'monochrome-1bit',
  'grayscale-8bit',
  'color-32bit',
];

/**
 * Binary serialization for TileDelta array.
 * Magic header: 0x54, 0x44 ('TD')
 * Version: 1 (uint8)
 * Count: uint32
 */
export function serializeTileDeltas(deltas: TileDelta[]): Uint8Array {
  const encoder = new TextEncoder();
  let totalBytes = 2 + 1 + 4; // Magic (2) + Version (1) + Count (4)
  const encodedKeys: Uint8Array[] = [];

  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    const keyBytes = encoder.encode(d.key);
    encodedKeys.push(keyBytes);

    totalBytes += 2 + keyBytes.length; // keyLen (2) + bytes
    totalBytes += 1; // format (1)
    totalBytes += 1; // hasBefore (1)
    if (d.beforeData && d.beforeData.byteLength > 0) {
      totalBytes += 4 + d.beforeData.byteLength;
    }
    totalBytes += 1; // hasAfter (1)
    if (d.afterData && d.afterData.byteLength > 0) {
      totalBytes += 4 + d.afterData.byteLength;
    }
  }

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer, out.byteOffset, totalBytes);

  let offset = 0;
  out[offset++] = 0x54; // 'T'
  out[offset++] = 0x44; // 'D'
  out[offset++] = 1; // Version
  view.setUint32(offset, deltas.length, true);
  offset += 4;

  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    const keyBytes = encodedKeys[i];

    view.setUint16(offset, keyBytes.length, true);
    offset += 2;
    out.set(keyBytes, offset);
    offset += keyBytes.length;

    out[offset++] = FORMAT_TO_BYTE[d.format] ?? 2;

    if (d.beforeData && d.beforeData.byteLength > 0) {
      out[offset++] = 1;
      view.setUint32(offset, d.beforeData.byteLength, true);
      offset += 4;
      out.set(d.beforeData, offset);
      offset += d.beforeData.byteLength;
    } else {
      out[offset++] = 0;
    }

    if (d.afterData && d.afterData.byteLength > 0) {
      out[offset++] = 1;
      view.setUint32(offset, d.afterData.byteLength, true);
      offset += 4;
      out.set(d.afterData, offset);
      offset += d.afterData.byteLength;
    } else {
      out[offset++] = 0;
    }
  }

  return out;
}

/**
 * Binary deserialization for TileDelta array.
 */
export function deserializeTileDeltas(buffer: Uint8Array): TileDelta[] {
  if (buffer.byteLength < 7) {
    throw new Error('Invalid TileDelta buffer: too short');
  }
  if (buffer[0] !== 0x54 || buffer[1] !== 0x44) {
    throw new Error('Invalid TileDelta buffer: bad magic');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const version = buffer[2];
  if (version !== 1) {
    throw new Error(`Unsupported TileDelta version: ${version}`);
  }

  let offset = 3;
  const count = view.getUint32(offset, true);
  offset += 4;

  const decoder = new TextDecoder();
  const deltas: TileDelta[] = [];

  for (let i = 0; i < count; i++) {
    const keyLen = view.getUint16(offset, true);
    offset += 2;
    const keyBytes = buffer.subarray(offset, offset + keyLen);
    const key = decoder.decode(keyBytes);
    offset += keyLen;

    const formatByte = buffer[offset++];
    const format = BYTE_TO_FORMAT[formatByte] || 'color-32bit';

    const hasBefore = buffer[offset++];
    let beforeData: Uint8Array | null = null;
    if (hasBefore === 1) {
      const bLen = view.getUint32(offset, true);
      offset += 4;
      beforeData = new Uint8Array(bLen);
      beforeData.set(buffer.subarray(offset, offset + bLen));
      offset += bLen;
    }

    const hasAfter = buffer[offset++];
    let afterData: Uint8Array | null = null;
    if (hasAfter === 1) {
      const aLen = view.getUint32(offset, true);
      offset += 4;
      afterData = new Uint8Array(aLen);
      afterData.set(buffer.subarray(offset, offset + aLen));
      offset += aLen;
    }

    deltas.push({
      key,
      format,
      beforeData,
      afterData,
    });
  }

  return deltas;
}

// Global sparse tile grid singleton
export const globalTileGrid = new SparseTileGrid();
