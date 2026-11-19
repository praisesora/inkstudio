/**
 * Large-Canvas Virtual Memory and SSD Scratch Disk Engine
 * Sparse Virtual Tile Engine & Color Expression System
 *
 * Designed for 600 DPI professional manga production (B4: 7016 x 9921 px, ~70 MP)
 * and Webtoons (800 x 50,000+ px) with zero allocation for empty space, multi-format pixel packing
 * (1-bit monochrome at 8KB, 8-bit grayscale at 64KB, 32-bit RGBA at 256KB),
 * LRU tile memory budgeting with transparent background SSD scratch paging via Rust LZ4,
 * and an on-demand multi-resolution Mipmap Tile Pyramid (LOD 0 to LOD 3).
 */

import { TileDelta } from '../types/editor';

export const TILE_SIZE = 256;
export const TILE_PIXELS = TILE_SIZE * TILE_SIZE; // 65,536 pixels
export const BYTES_1BIT = TILE_PIXELS >> 3; // 8,192 bytes (8 KB)
export const BYTES_8BIT = TILE_PIXELS; // 65,536 bytes (64 KB)
export const BYTES_32BIT = TILE_PIXELS << 2; // 262,144 bytes (256 KB)

export type TileFormat = 'monochrome-1bit' | 'grayscale-8bit' | 'color-32bit';

export interface TileBuffer {
  layerId: string;
  tileX: number;
  tileY: number;
  format: TileFormat;
  data: Uint8Array | null; // null when paged out to disk
  dirty: boolean;
  version: number;
  isPagedToDisk: boolean;
  lastAccessTimestamp: number;
  lod: number; // 0 = 1:1 (256x256 doc area), 1 = 1/2 (512x512), 2 = 1/4 (1024x1024), 3 = 1/8 (2048x2048)
}

export function getTileByteSize(format: TileFormat): number {
  if (format === 'monochrome-1bit') return BYTES_1BIT;
  if (format === 'grayscale-8bit') return BYTES_8BIT;
  return BYTES_32BIT;
}

// System endianness detection for 32-bit operations
export const isLittleEndian = (() => {
  if (typeof ArrayBuffer === 'undefined') return true;
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
export function pixelToTileCoord(pixel: number, lod: number = 0): number {
  const tileSizeDoc = TILE_SIZE << lod;
  return Math.floor(pixel / tileSizeDoc);
}

/**
 * Spatial hash map key for tiles.
 * LOD 0 produces backwards-compatible key: `${layerId}:${tileX}:${tileY}`.
 * LOD > 0 produces: `${layerId}:${lod}:${tileX}:${tileY}`.
 */
export function getTileKey(layerId: string, tileX: number, tileY: number, lod: number = 0): string {
  return lod === 0 ? `${layerId}:${tileX}:${tileY}` : `${layerId}:${lod}:${tileX}:${tileY}`;
}

/**
 * Parse spatial hash map key into components.
 */
export function parseTileKey(key: string): { layerId: string; tileX: number; tileY: number; lod: number } {
  const parts = key.split(':');
  if (parts.length === 4) {
    return {
      layerId: parts[0],
      lod: parseInt(parts[1], 10),
      tileX: parseInt(parts[2], 10),
      tileY: parseInt(parts[3], 10),
    };
  }
  return {
    layerId: parts[0],
    tileX: parseInt(parts[1], 10),
    tileY: parseInt(parts[2], 10),
    lod: 0,
  };
}

/**
 * Allocate a new TileBuffer with zero-initialized memory.
 */
export function createTileBuffer(
  layerId: string,
  tileX: number,
  tileY: number,
  format: TileFormat,
  lod: number = 0
): TileBuffer {
  const size = getTileByteSize(format);

  return {
    layerId,
    tileX,
    tileY,
    format,
    data: new Uint8Array(size),
    dirty: true,
    version: 1,
    isPagedToDisk: false,
    lastAccessTimestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    lod,
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
    data[byteIndex] |= 1 << bitOffset;
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
          byteVal |= 1 << bit;
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
 * High-speed Run-Length Encoding (RLE) for compressing tile data.
 */
export function compressRLE(data: Uint8Array): Uint8Array {
  const len = data.length;
  if (len === 0) return new Uint8Array(0);

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

  while (inIdx + 1 < inLen && outIdx < expectedLength) {
    const count = compressed[inIdx++];
    const val = compressed[inIdx++];
    for (let c = 0; c < count && outIdx < expectedLength; c++) {
      output[outIdx++] = val;
    }
  }

  return output;
}

export function serializeTileBuffer(tile: TileBuffer): Uint8Array {
  const tileBytes = tile.data || new Uint8Array(getTileByteSize(tile.format));
  const rle = compressRLE(tileBytes);
  const headerSize = 13;
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

export function deserializeTileBuffer(layerId: string, packet: Uint8Array): TileBuffer {
  if (!packet || packet.byteLength < 13) {
    return createTileBuffer(layerId, 0, 0, 'color-32bit', 0);
  }
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const tileX = view.getInt32(0, true);
  const tileY = view.getInt32(4, true);
  const formatCode = view.getUint8(8);
  const version = view.getUint32(9, true);

  const format: TileFormat = formatCode === 1 ? 'monochrome-1bit' : formatCode === 2 ? 'grayscale-8bit' : 'color-32bit';
  const expectedLen = getTileByteSize(format);

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
    isPagedToDisk: false,
    lastAccessTimestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    lod: 0,
  };
}

// ============================================================================
// Multi-Resolution Mipmap Downsampling (2x2 Child Tiles -> 1 Parent LOD Tile)
// ============================================================================

const _downsampleRgbaScratch = new Uint8ClampedArray(BYTES_32BIT);
const _downsampleRgbaView = new Uint8Array(_downsampleRgbaScratch.buffer);
const _downsample8BitScratch = new Uint8Array(BYTES_8BIT);
const _downsample1BitScratch = new Uint8Array(BYTES_1BIT);

// Precomputed 256-entry LUT mapping an 8-bit 1-bit-row byte to a 4-bit downsampled nibble (2x1 horizontal OR)
const _lut1BitByteToNibble = (() => {
  const lut = new Uint8Array(256);
  for (let b = 0; b < 256; b++) {
    let nib = 0;
    if (b & 0xc0) nib |= 0x08;
    if (b & 0x30) nib |= 0x04;
    if (b & 0x0c) nib |= 0x02;
    if (b & 0x03) nib |= 0x01;
    lut[b] = nib;
  }
  return lut;
})();

/**
 * Downsample 4 child tiles (2x2 cluster) at LOD k-1 into a single destination tile at LOD k.
 * Reuses pre-allocated scratch buffers for zero 256KB heap allocations during zoom-out LOD builds.
 */
export function downsample2x2ToParentTile(
  childTiles: [TileBuffer | null, TileBuffer | null, TileBuffer | null, TileBuffer | null],
  dstTile: TileBuffer
): boolean {
  if (!dstTile.data) {
    dstTile.data = new Uint8Array(getTileByteSize(dstTile.format));
  }
  dstTile.data.fill(0);

  const hasAnyChild = childTiles.some((c) => c && c.data !== null);
  if (!hasAnyChild) {
    return false;
  }

  const format = dstTile.format;
  const dst = dstTile.data;

  for (let q = 0; q < 4; q++) {
    const child = childTiles[q];
    if (!child || !child.data) continue;

    let childData = child.data;
    const xBase = (q & 1) ? 128 : 0;
    const yBase = (q >= 2) ? 128 : 0;

    if (format === 'color-32bit') {
      if (child.format === 'monochrome-1bit') {
        unpack1BitToRGBA(childData, _downsampleRgbaScratch);
        childData = _downsampleRgbaView;
      } else if (child.format === 'grayscale-8bit') {
        unpack8BitToRGBA(childData, _downsampleRgbaScratch);
        childData = _downsampleRgbaView;
      }
      for (let ly = 0; ly < 128; ly++) {
        const sy0 = ly << 1;
        const sy1 = sy0 + 1;
        const dy = yBase + ly;
        const dstRowOffset = dy * TILE_SIZE;
        const srcRowOffset0 = sy0 * TILE_SIZE;
        const srcRowOffset1 = sy1 * TILE_SIZE;

        for (let lx = 0; lx < 128; lx++) {
          const sx0 = lx << 1;
          const sx1 = sx0 + 1;
          const dx = xBase + lx;

          const p00 = (srcRowOffset0 + sx0) << 2;
          const p10 = (srcRowOffset0 + sx1) << 2;
          const p01 = (srcRowOffset1 + sx0) << 2;
          const p11 = (srcRowOffset1 + sx1) << 2;
          const outIdx = (dstRowOffset + dx) << 2;

          const a0 = childData[p00 + 3];
          const a1 = childData[p10 + 3];
          const a2 = childData[p01 + 3];
          const a3 = childData[p11 + 3];
          const sumA = a0 + a1 + a2 + a3;

          if (sumA === 0) {
            dst[outIdx] = 0;
            dst[outIdx + 1] = 0;
            dst[outIdx + 2] = 0;
            dst[outIdx + 3] = 0;
          } else if (sumA === 1020) {
            dst[outIdx] = (childData[p00] + childData[p10] + childData[p01] + childData[p11] + 2) >> 2;
            dst[outIdx + 1] = (childData[p00 + 1] + childData[p10 + 1] + childData[p01 + 1] + childData[p11 + 1] + 2) >> 2;
            dst[outIdx + 2] = (childData[p00 + 2] + childData[p10 + 2] + childData[p01 + 2] + childData[p11 + 2] + 2) >> 2;
            dst[outIdx + 3] = 255;
          } else {
            dst[outIdx + 3] = sumA >> 2;
            dst[outIdx] = Math.round(
              (childData[p00] * a0 + childData[p10] * a1 + childData[p01] * a2 + childData[p11] * a3) / sumA
            );
            dst[outIdx + 1] = Math.round(
              (childData[p00 + 1] * a0 + childData[p10 + 1] * a1 + childData[p01 + 1] * a2 + childData[p11 + 1] * a3) / sumA
            );
            dst[outIdx + 2] = Math.round(
              (childData[p00 + 2] * a0 + childData[p10 + 2] * a1 + childData[p01 + 2] * a2 + childData[p11 + 2] * a3) / sumA
            );
          }
        }
      }
    } else if (format === 'grayscale-8bit') {
      if (child.format === 'color-32bit') {
        packRGBATo8Bit(childData, _downsample8BitScratch);
        childData = _downsample8BitScratch;
      } else if (child.format === 'monochrome-1bit') {
        unpack1BitToRGBA(childData, _downsampleRgbaScratch);
        packRGBATo8Bit(_downsampleRgbaScratch, _downsample8BitScratch);
        childData = _downsample8BitScratch;
      }
      for (let ly = 0; ly < 128; ly++) {
        const sy0 = ly << 1;
        const sy1 = sy0 + 1;
        const dy = yBase + ly;
        const dstRowOffset = dy * TILE_SIZE;
        const srcRowOffset0 = sy0 * TILE_SIZE;
        const srcRowOffset1 = sy1 * TILE_SIZE;

        for (let lx = 0; lx < 128; lx++) {
          const sx0 = lx << 1;
          const sx1 = sx0 + 1;
          const dx = xBase + lx;

          const v00 = childData[srcRowOffset0 + sx0];
          const v10 = childData[srcRowOffset0 + sx1];
          const v01 = childData[srcRowOffset1 + sx0];
          const v11 = childData[srcRowOffset1 + sx1];

          dst[dstRowOffset + dx] = (v00 + v10 + v01 + v11) >> 2;
        }
      }
    } else {
      if (child.format === 'color-32bit') {
        packRGBATo1Bit(childData, _downsample1BitScratch);
        childData = _downsample1BitScratch;
      } else if (child.format === 'grayscale-8bit') {
        unpack8BitToRGBA(childData, _downsampleRgbaScratch);
        packRGBATo1Bit(_downsampleRgbaScratch, _downsample1BitScratch);
        childData = _downsample1BitScratch;
      }
      const dstByteBaseX = xBase >> 3;
      for (let ly = 0; ly < 128; ly++) {
        const sy0 = ly << 1;
        const srcRow0 = sy0 << 5;
        const srcRow1 = (sy0 + 1) << 5;
        const dstRow = ((yBase + ly) << 5) + dstByteBaseX;

        for (let bx = 0; bx < 16; bx++) {
          const sBx = bx << 1;
          const comb0 = childData[srcRow0 + sBx] | childData[srcRow1 + sBx];
          const comb1 = childData[srcRow0 + sBx + 1] | childData[srcRow1 + sBx + 1];
          dst[dstRow + bx] = (_lut1BitByteToNibble[comb0] << 4) | _lut1BitByteToNibble[comb1];
        }
      }
    }
  }

  dstTile.dirty = false;
  dstTile.version++;
  return true;
}

// ============================================================================
// Scratch Disk Driver Interface & Implementations
// ============================================================================

export interface TileWritePayload {
  layerId: string;
  tileX: number;
  tileY: number;
  data: Uint8Array;
}

export interface IScratchDiskDriver {
  init(sessionId: string): Promise<void>;
  writeTiles(sessionId: string, tiles: TileWritePayload[]): Promise<number>;
  readTile(sessionId: string, layerId: string, tileX: number, tileY: number): Promise<Uint8Array>;
  clear(sessionId: string): Promise<void>;
}

export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as any).__TAURI_INTERNALS__ ||
    (window as any).__TAURI__ ||
    (window as any).isTauri
  );
}

/**
 * Production Tauri v2 Rust Scratch Disk Driver.
 * Direct IPC with high-throughput LZ4 compression and atomic file index tables.
 */
export class TauriScratchDiskDriver implements IScratchDiskDriver {
  public async init(sessionId: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('scratch_disk_init', { sessionId });
  }

  public async writeTiles(sessionId: string, tiles: TileWritePayload[]): Promise<number> {
    if (tiles.length === 0) return 0;
    const { invoke } = await import('@tauri-apps/api/core');
    const count = await invoke<number>('scratch_disk_write_tiles', {
      sessionId,
      tiles: tiles.map((t) => ({
        layerId: t.layerId,
        tileX: t.tileX,
        tileY: t.tileY,
        data: Array.from(t.data),
      })),
    });
    return count;
  }

  public async readTile(sessionId: string, layerId: string, tileX: number, tileY: number): Promise<Uint8Array> {
    const { invoke } = await import('@tauri-apps/api/core');
    const bytes = await invoke<number[] | Uint8Array>('scratch_disk_read_tile', {
      sessionId,
      layerId,
      tileX,
      tileY,
    });
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  public async clear(sessionId: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('scratch_disk_clear', { sessionId });
  }
}

/**
 * High-speed In-Memory / Fallback Scratch Disk Driver.
 * Used during automated Vitest suites and pure browser previews without Tauri.
 */
export class InMemoryScratchDiskDriver implements IScratchDiskDriver {
  private storage: Map<string, Uint8Array> = new Map();

  public async init(_sessionId: string): Promise<void> {
    this.storage.clear();
  }

  public async writeTiles(sessionId: string, tiles: TileWritePayload[]): Promise<number> {
    for (const t of tiles) {
      const copy = new Uint8Array(t.data.byteLength);
      copy.set(t.data);
      this.storage.set(`${sessionId}:${t.layerId}:${t.tileX}:${t.tileY}`, copy);
    }
    return tiles.length;
  }

  public async readTile(sessionId: string, layerId: string, tileX: number, tileY: number): Promise<Uint8Array> {
    const key = `${sessionId}:${layerId}:${tileX}:${tileY}`;
    const found = this.storage.get(key);
    if (!found) {
      throw new Error(`Tile not found on in-memory scratch disk: ${key}`);
    }
    const copy = new Uint8Array(found.byteLength);
    copy.set(found);
    return copy;
  }

  public async clear(sessionId: string): Promise<void> {
    const prefix = `${sessionId}:`;
    for (const key of Array.from(this.storage.keys())) {
      if (key.startsWith(prefix)) {
        this.storage.delete(key);
      }
    }
  }
}

export function createDefaultScratchDiskDriver(): IScratchDiskDriver {
  return isTauriEnvironment() ? new TauriScratchDiskDriver() : new InMemoryScratchDiskDriver();
}

// ============================================================================
// TileMemoryManager (LRU Eviction & Transparent Page-In)
// ============================================================================

export interface TileMemoryManagerOptions {
  budgetMb?: number;
  driver?: IScratchDiskDriver;
  sessionId?: string;
}

export class TileMemoryManager {
  private sessionId: string;
  private budgetBytes: number;
  private activeBytes: number = 0;
  private grid: SparseTileGrid;
  private driver: IScratchDiskDriver;
  private viewportFrustum: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  private activeLayerId: string | null = null;
  private layerVisibility: Map<string, boolean> = new Map();
  private inFlightPageIns: Map<string, Promise<Uint8Array>> = new Map();
  private evictionPromise: Promise<void> | null = null;
  private needsAnotherEvictionPass: boolean = false;

  constructor(grid: SparseTileGrid, options?: TileMemoryManagerOptions) {
    this.grid = grid;
    const mb = options?.budgetMb ?? 1024;
    this.budgetBytes = Math.max(1, mb) * 1024 * 1024;
    this.sessionId = options?.sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.driver = options?.driver || createDefaultScratchDiskDriver();
    void this.driver.init(this.sessionId);
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getDriver(): IScratchDiskDriver {
    return this.driver;
  }

  public setDriver(driver: IScratchDiskDriver): void {
    this.driver = driver;
    void this.driver.init(this.sessionId);
  }

  public setBudgetMb(mb: number): void {
    this.budgetBytes = Math.max(1, mb) * 1024 * 1024;
    void this.checkBudgetAndEvict();
  }

  public getBudgetBytes(): number {
    return this.budgetBytes;
  }

  public getActiveMemoryBytes(): number {
    return this.activeBytes;
  }

  public updateViewport(
    frustum: { minX: number; minY: number; maxX: number; maxY: number } | null,
    activeLayerId?: string | null,
    layerVisibility?: Map<string, boolean>
  ): void {
    this.viewportFrustum = frustum;
    if (activeLayerId !== undefined) this.activeLayerId = activeLayerId;
    if (layerVisibility !== undefined) this.layerVisibility = layerVisibility;
  }

  public notifyTileAllocated(tile: TileBuffer): void {
    if (tile.data !== null) {
      this.activeBytes += tile.data.byteLength;
      tile.lastAccessTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (tile.lod === 0) {
        void this.checkBudgetAndEvict();
      }
    }
  }

  public notifyTileFreed(tile: TileBuffer): void {
    if (tile.data !== null) {
      this.activeBytes -= tile.data.byteLength;
    }
  }

  public touchTile(tile: TileBuffer): void {
    tile.lastAccessTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * Transparent Page-In: Asynchronously loads and decompresses a tile from scratch disk.
   */
  public async requestTileData(tile: TileBuffer): Promise<Uint8Array> {
    if (tile.data !== null) {
      this.touchTile(tile);
      return tile.data;
    }

    if (!tile.isPagedToDisk) {
      const size = getTileByteSize(tile.format);
      tile.data = new Uint8Array(size);
      this.notifyTileAllocated(tile);
      return tile.data;
    }

    const key = getTileKey(tile.layerId, tile.tileX, tile.tileY, tile.lod);
    let inFlight = this.inFlightPageIns.get(key);
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const raw = await this.driver.readTile(this.sessionId, tile.layerId, tile.tileX, tile.tileY);
          if (tile.data === null) {
            tile.data = raw;
            this.activeBytes += raw.byteLength;
          }
          tile.isPagedToDisk = true;
          tile.dirty = true;
          tile.version++;
          this.touchTile(tile);
          void this.checkBudgetAndEvict();
          this.grid.bumpLayerVersion(tile.layerId);
          this.grid.notifyChange();
          return tile.data;
        } finally {
          this.inFlightPageIns.delete(key);
        }
      })();
      this.inFlightPageIns.set(key, inFlight);
    }
    return inFlight;
  }

  /**
   * Evaluates memory consumption against the configured RAM budget.
   * Runs an LRU eviction pass prioritizing hidden layers, outside frustum, and inactive layers.
   */
  public async checkBudgetAndEvict(): Promise<void> {
    if (this.evictionPromise) {
      this.needsAnotherEvictionPass = true;
      return this.evictionPromise;
    }

    if (this.activeBytes <= this.budgetBytes) {
      return;
    }

    this.evictionPromise = (async () => {
      try {
        while (this.activeBytes > this.budgetBytes) {
          this.needsAnotherEvictionPass = false;
          const evictedCount = await this.performEvictionPass();
          if (evictedCount === 0) {
            break;
          }
          if (!this.needsAnotherEvictionPass && this.activeBytes <= this.budgetBytes) {
            break;
          }
        }
      } finally {
        this.evictionPromise = null;
        this.needsAnotherEvictionPass = false;
      }
    })();

    return this.evictionPromise;
  }

  private async performEvictionPass(): Promise<number> {
    // 1. First drop any in-memory LOD > 0 tiles (they can always be re-downsampled on demand with 0 IO)
    let droppedLodBytes = 0;
    for (const tile of this.grid.getAllTiles()) {
      if (tile.lod > 0 && tile.data !== null) {
        this.activeBytes -= tile.data.byteLength;
        droppedLodBytes += tile.data.byteLength;
        tile.data = null;
        tile.dirty = true;
      }
    }

    if (this.activeBytes <= this.budgetBytes) {
      return droppedLodBytes > 0 ? 1 : 0;
    }

    // 2. Gather candidate LOD 0 tiles with active data
    const candidates: TileBuffer[] = [];
    for (const tile of this.grid.getAllTiles()) {
      if (tile.lod === 0 && tile.data !== null) {
        candidates.push(tile);
      }
    }

    if (candidates.length === 0) {
      return droppedLodBytes > 0 ? 1 : 0;
    }

    const frustum = this.viewportFrustum;
    const activeLayer = this.activeLayerId;
    const layerVis = this.layerVisibility;

    // 3. Score candidate eviction priority
    const scored = candidates.map((tile) => {
      const isHidden = layerVis.get(tile.layerId) === false;
      const isInactiveLayer = activeLayer !== null && tile.layerId !== activeLayer;

      let frustumDist = 0;
      if (frustum) {
        const minTx = pixelToTileCoord(frustum.minX, 0);
        const maxTx = pixelToTileCoord(frustum.maxX, 0);
        const minTy = pixelToTileCoord(frustum.minY, 0);
        const maxTy = pixelToTileCoord(frustum.maxY, 0);

        const dx = tile.tileX < minTx ? minTx - tile.tileX : tile.tileX > maxTx ? tile.tileX - maxTx : 0;
        const dy = tile.tileY < minTy ? minTy - tile.tileY : tile.tileY > maxTy ? tile.tileY - maxTy : 0;
        frustumDist = dx * dx + dy * dy;
      }

      let tier = 2;
      if (isHidden) {
        tier = 0; // Tier 0: Hidden layer tiles (evict first)
      } else if (frustumDist > 0) {
        tier = 1; // Tier 1: Outside viewport frustum (farthest first)
      } else if (isInactiveLayer) {
        tier = 2; // Tier 2: Inside frustum, but inactive layer (LRU)
      } else {
        tier = 3; // Tier 3: Inside frustum and active drawing layer (protected, evicted last if needed)
      }

      return {
        tile,
        tier,
        frustumDist,
        lastAccess: tile.lastAccessTimestamp,
      };
    });

    scored.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier === 1 && a.frustumDist !== b.frustumDist) {
        return b.frustumDist - a.frustumDist; // Farthest distance outside frustum first
      }
      return a.lastAccess - b.lastAccess; // Oldest access timestamp first
    });

    // 4. Batch evict until within 90% of budget
    const targetBytes = this.budgetBytes * 0.9;
    const toEvict: TileBuffer[] = [];
    let projectedBytes = this.activeBytes;

    for (const item of scored) {
      if (projectedBytes <= targetBytes) break;
      toEvict.push(item.tile);
      projectedBytes -= item.tile.data?.byteLength || 0;
    }

    if (toEvict.length > 0) {
      await this.evictTiles(toEvict);
      return toEvict.length;
    }

    return droppedLodBytes > 0 ? 1 : 0;
  }

  public async evictTiles(tiles: TileBuffer[]): Promise<void> {
    const payloads: TileWritePayload[] = [];
    const validTiles: TileBuffer[] = [];

    for (const tile of tiles) {
      if (tile.data !== null) {
        payloads.push({
          layerId: tile.layerId,
          tileX: tile.tileX,
          tileY: tile.tileY,
          data: tile.data,
        });
        validTiles.push(tile);
      }
    }

    if (payloads.length > 0) {
      await this.driver.writeTiles(this.sessionId, payloads);
      for (const tile of validTiles) {
        if (tile.data) {
          this.activeBytes -= tile.data.byteLength;
          tile.data = null;
          tile.isPagedToDisk = true;
          tile.dirty = false;
        }
      }
    }
  }

  public async clear(): Promise<void> {
    this.inFlightPageIns.clear();
    this.activeBytes = 0;
    await this.driver.clear(this.sessionId);
  }
}

// ============================================================================
// SparseTileGrid
// ============================================================================

/**
 * Sparse Virtual Tile Grid
 *
 * Sole authoritative backing store for all layer pixel data in Ink Studio.
 * Completely deprecates multi-gigabyte full-sized DOM layer canvases.
 */
export class SparseTileGrid {
  private tiles: Map<string, TileBuffer> = new Map();
  private layerFormats: Map<string, TileFormat> = new Map();
  private ingestedLayers: Set<string> = new Set();
  private dirtyLodTiles: Set<string> = new Set();
  private scratchRGBA: Uint8ClampedArray = new Uint8ClampedArray(BYTES_32BIT);
  private writeScratchRGBA: Uint8ClampedArray = new Uint8ClampedArray(BYTES_32BIT);
  private thumbCanvas: HTMLCanvasElement | null = null;
  private listeners: Set<(immediate?: boolean) => void> = new Set();
  private memoryManager: TileMemoryManager | null = null;
  private layerVersions: Map<string, number> = new Map();
  private globalVersionCounter: number = 1;
  private gridEpoch: number = 0;

  constructor(memoryManagerOptions?: TileMemoryManagerOptions) {
    this.memoryManager = new TileMemoryManager(this, memoryManagerOptions);
  }

  public getLayerVersion(layerId: string): number {
    return this.layerVersions.get(layerId) ?? 0;
  }

  public bumpLayerVersion(layerId: string): void {
    this.layerVersions.set(layerId, ++this.globalVersionCounter);
  }

  public getGridEpoch(): number {
    return this.gridEpoch;
  }

  public setMemoryManager(manager: TileMemoryManager | null): void {
    this.memoryManager = manager;
  }

  public getMemoryManager(): TileMemoryManager | null {
    return this.memoryManager;
  }

  public subscribe(listener: (immediate?: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public notifyChange(immediate?: boolean): void {
    this.listeners.forEach((fn) => fn(immediate));
  }

  public setLayerFormat(layerId: string, format: TileFormat): void {
    this.layerFormats.set(layerId, format);
  }

  public getLayerFormat(layerId: string): TileFormat {
    return this.layerFormats.get(layerId) || 'color-32bit';
  }

  public isLayerIngested(layerId: string): boolean {
    return this.ingestedLayers.has(layerId);
  }

  public markLayerIngested(layerId: string): void {
    this.ingestedLayers.add(layerId);
  }

  public hasTile(layerId: string, tileX: number, tileY: number, lod: number = 0): boolean {
    return this.tiles.has(getTileKey(layerId, tileX, tileY, lod));
  }

  public getTile(layerId: string, tileX: number, tileY: number, lod: number = 0): TileBuffer | null {
    const tile = this.tiles.get(getTileKey(layerId, tileX, tileY, lod)) || null;
    if (tile && this.memoryManager) {
      this.memoryManager.touchTile(tile);
    }
    return tile;
  }

  public getOrCreateTile(
    layerId: string,
    tileX: number,
    tileY: number,
    format?: TileFormat,
    lod: number = 0
  ): TileBuffer {
    const key = getTileKey(layerId, tileX, tileY, lod);
    let tile = this.tiles.get(key);
    if (!tile) {
      const fmt = format || this.getLayerFormat(layerId);
      tile = createTileBuffer(layerId, tileX, tileY, fmt, lod);
      this.tiles.set(key, tile);
      if (this.memoryManager) {
        this.memoryManager.notifyTileAllocated(tile);
      }
    } else if (tile.data === null && tile.isPagedToDisk && this.memoryManager) {
      void this.memoryManager.requestTileData(tile);
    } else if (this.memoryManager) {
      this.memoryManager.touchTile(tile);
    }
    return tile;
  }

  public setTile(layerId: string, tileX: number, tileY: number, tile: TileBuffer): void {
    const key = getTileKey(layerId, tileX, tileY, tile.lod);
    const existing = this.tiles.get(key);
    if (existing && this.memoryManager) {
      this.memoryManager.notifyTileFreed(existing);
    }
    this.tiles.set(key, tile);
    if (this.memoryManager) {
      this.memoryManager.notifyTileAllocated(tile);
    }
    if (tile.lod === 0) {
      this.setLayerFormat(layerId, tile.format);
      this.markLodAncestorsDirty(layerId, tileX, tileY);
      this.bumpLayerVersion(layerId);
    }
    this.notifyChange();
  }

  public deleteTile(layerId: string, tileX: number, tileY: number, lod: number = 0): void {
    const key = getTileKey(layerId, tileX, tileY, lod);
    const tile = this.tiles.get(key);
    if (tile) {
      if (this.memoryManager) {
        this.memoryManager.notifyTileFreed(tile);
      }
      this.tiles.delete(key);
      if (lod === 0) {
        this.markLodAncestorsDirty(layerId, tileX, tileY);
        this.bumpLayerVersion(layerId);
      }
    }
  }

  public getLayerTiles(layerId: string, lod: number = 0): TileBuffer[] {
    const result: TileBuffer[] = [];
    for (const tile of this.tiles.values()) {
      if (tile.layerId === layerId && (tile.lod ?? 0) === lod) {
        result.push(tile);
      }
    }
    return result;
  }

  public getTilesInBounds(
    layerId: string,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    lod: number = 0
  ): TileBuffer[] {
    const minTileX = pixelToTileCoord(minX, lod);
    const minTileY = pixelToTileCoord(minY, lod);
    const maxTileX = pixelToTileCoord(maxX, lod);
    const maxTileY = pixelToTileCoord(maxY, lod);

    const result: TileBuffer[] = [];
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        let tile = this.getTile(layerId, tx, ty, lod);
        if (lod > 0 && (!tile || this.isLodTileDirty(layerId, tx, ty, lod))) {
          tile = this.generateLodTile(layerId, tx, ty, lod);
        }
        if (tile) {
          result.push(tile);
        }
      }
    }
    return result;
  }

  public getIntersectingCoords(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    lod: number = 0
  ): Array<{ tileX: number; tileY: number }> {
    const minTileX = pixelToTileCoord(minX, lod);
    const minTileY = pixelToTileCoord(minY, lod);
    const maxTileX = pixelToTileCoord(maxX, lod);
    const maxTileY = pixelToTileCoord(maxY, lod);

    const coords: Array<{ tileX: number; tileY: number }> = [];
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        coords.push({ tileX: tx, tileY: ty });
      }
    }
    return coords;
  }

  /**
   * Transparently returns a 256x256 RGBA Uint8ClampedArray for WebGL texture upload or 2D blitting.
   * If tile data is paged to disk, kicks off an asynchronous fetch without freezing rendering.
   */
  public getTileAsRGBA(tile: TileBuffer): Uint8ClampedArray {
    if (tile.data === null) {
      if (tile.isPagedToDisk && this.memoryManager) {
        void this.memoryManager.requestTileData(tile);
      }
      this.scratchRGBA.fill(0);
      return this.scratchRGBA;
    }

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
    format?: TileFormat,
    suppressNotify: boolean = false
  ): { minTileX: number; minTileY: number; maxTileX: number; maxTileY: number } {
    this.ingestedLayers.add(layerId);
    if (format) {
      this.setLayerFormat(layerId, format);
    }
    const targetFormat = format || this.getLayerFormat(layerId);
    const w = imgData.width;
    const h = imgData.height;
    if (w <= 0 || h <= 0) {
      return { minTileX: 0, minTileY: 0, maxTileX: 0, maxTileY: 0 };
    }

    const minTileX = pixelToTileCoord(destX, 0);
    const minTileY = pixelToTileCoord(destY, 0);
    const maxTileX = pixelToTileCoord(destX + w - 1, 0);
    const maxTileY = pixelToTileCoord(destY + h - 1, 0);

    const tileScratch = this.writeScratchRGBA;
    const srcData = imgData.data;

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      const tileDocY = ty * TILE_SIZE;
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const tileDocX = tx * TILE_SIZE;

        const srcStartX = Math.max(0, tileDocX - destX);
        const srcStartY = Math.max(0, tileDocY - destY);
        const srcEndX = Math.min(w, tileDocX + TILE_SIZE - destX);
        const srcEndY = Math.min(h, tileDocY + TILE_SIZE - destY);

        if (srcStartX >= srcEndX || srcStartY >= srcEndY) continue;

        let existingTile = this.getTile(layerId, tx, ty, 0);
        if (!existingTile) {
          let hasNonZero = false;
          outer: for (let sy = srcStartY; sy < srcEndY; sy++) {
            let idx = (sy * w + srcStartX) * 4;
            const endIdx = (sy * w + srcEndX) * 4;
            for (; idx < endIdx; idx += 4) {
              if (srcData[idx + 3] !== 0 || srcData[idx] !== 0 || srcData[idx + 1] !== 0 || srcData[idx + 2] !== 0) {
                hasNonZero = true;
                break outer;
              }
            }
          }
          if (!hasNonZero) continue;
          existingTile = this.getOrCreateTile(layerId, tx, ty, targetFormat, 0);
        }

        const tile = existingTile;
        if (tile.format !== targetFormat) {
          if (tile.data !== null) {
            this.memoryManager?.notifyTileFreed(tile);
          }
          tile.format = targetFormat;
          tile.data = new Uint8Array(getTileByteSize(targetFormat));
          this.memoryManager?.notifyTileAllocated(tile);
        } else if (tile.data === null) {
          tile.data = new Uint8Array(getTileByteSize(tile.format));
          this.memoryManager?.notifyTileAllocated(tile);
        }

        if (tile.format === 'color-32bit') {
          for (let sy = srcStartY; sy < srcEndY; sy++) {
            const tileLocalY = destY + sy - tileDocY;
            const tileLocalX = destX + srcStartX - tileDocX;
            const copyWidth = srcEndX - srcStartX;

            const srcByteOffset = (sy * w + srcStartX) * 4;
            const tileByteOffset = (tileLocalY * TILE_SIZE + tileLocalX) * 4;

            tile.data.set(
              srcData.subarray(srcByteOffset, srcByteOffset + copyWidth * 4),
              tileByteOffset
            );
          }
        } else if (tile.format === 'monochrome-1bit') {
          unpack1BitToRGBA(tile.data, tileScratch);

          for (let sy = srcStartY; sy < srcEndY; sy++) {
            const tileLocalY = destY + sy - tileDocY;
            const tileLocalX = destX + srcStartX - tileDocX;
            const copyWidth = srcEndX - srcStartX;

            const srcByteOffset = (sy * w + srcStartX) * 4;
            const tileByteOffset = (tileLocalY * TILE_SIZE + tileLocalX) * 4;

            tileScratch.set(
              srcData.subarray(srcByteOffset, srcByteOffset + copyWidth * 4),
              tileByteOffset
            );
          }

          packRGBATo1Bit(tileScratch, tile.data);
        } else {
          unpack8BitToRGBA(tile.data, tileScratch);
          for (let sy = srcStartY; sy < srcEndY; sy++) {
            const tileLocalY = destY + sy - tileDocY;
            const tileLocalX = destX + srcStartX - tileDocX;
            const copyWidth = srcEndX - srcStartX;

            const srcByteOffset = (sy * w + srcStartX) * 4;
            const tileByteOffset = (tileLocalY * TILE_SIZE + tileLocalX) * 4;

            tileScratch.set(
              srcData.subarray(srcByteOffset, srcByteOffset + copyWidth * 4),
              tileByteOffset
            );
          }
          packRGBATo8Bit(tileScratch, tile.data);
        }

        tile.dirty = true;
        tile.version++;
        this.markLodAncestorsDirty(layerId, tx, ty);
      }
    }

    this.bumpLayerVersion(layerId);
    if (!suppressNotify) {
      this.notifyChange();
    }
    return { minTileX, minTileY, maxTileX, maxTileY };
  }

  public readImageData(
    layerId: string,
    x: number,
    y: number,
    width: number,
    height: number
  ): { data: Uint8ClampedArray; width: number; height: number } {
    const outData = new Uint8ClampedArray(width * height * 4);
    if (width <= 0 || height <= 0) return { data: outData, width, height };

    const minTileX = pixelToTileCoord(x, 0);
    const minTileY = pixelToTileCoord(y, 0);
    const maxTileX = pixelToTileCoord(x + width - 1, 0);
    const maxTileY = pixelToTileCoord(y + height - 1, 0);

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      const tileDocY = ty * TILE_SIZE;
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const tile = this.getTile(layerId, tx, ty, 0);
        if (!tile) continue;

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

    if (maxX <= minX || maxY <= minY) return;

    const minTileX = pixelToTileCoord(minX, 0);
    const minTileY = pixelToTileCoord(minY, 0);
    const maxTileX = pixelToTileCoord(maxX - 1, 0);
    const maxTileY = pixelToTileCoord(maxY - 1, 0);

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      const tileDocY = ty * TILE_SIZE;
      const validH = Math.min(TILE_SIZE, targetCanvas.height - tileDocY);
      if (validH <= 0) continue;
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const tileDocX = tx * TILE_SIZE;
        const validW = Math.min(TILE_SIZE, targetCanvas.width - tileDocX);
        if (validW <= 0) continue;
        const tile = this.getTile(layerId, tx, ty, 0);
        if (!tile) {
          ctx.clearRect(tileDocX, tileDocY, validW, validH);
          continue;
        }

        const rgba = this.getTileAsRGBA(tile);
        if (typeof ImageData !== 'undefined') {
          const clamped = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, BYTES_32BIT);
          const imgData = new ImageData(clamped, TILE_SIZE, TILE_SIZE);
          ctx.putImageData(imgData, tileDocX, tileDocY, 0, 0, validW, validH);
        }
      }
    }
  }

  /**
   * Generates a layer thumbnail directly from the sparse tile grid or LOD mipmaps.
   * Completely bypasses full-size canvas allocation.
   */
  public generateThumbnail(
    layerId: string,
    thumbWidth: number,
    thumbHeight: number,
    docDimensions: { width: number; height: number }
  ): string {
    if (typeof document === 'undefined') return '';
    if (!this.thumbCanvas) {
      this.thumbCanvas = document.createElement('canvas');
    }
    const canvas = this.thumbCanvas;
    if (canvas.width !== thumbWidth) canvas.width = thumbWidth;
    if (canvas.height !== thumbHeight) canvas.height = thumbHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    ctx.clearRect(0, 0, thumbWidth, thumbHeight);

    const docW = Math.max(1, docDimensions.width);
    const docH = Math.max(1, docDimensions.height);

    // Sample directly from LOD 0 tiles without flushing full mipmap pyramids
    let renderLod = 0;
    let tiles = this.getLayerTiles(layerId, 0);
    if (tiles.length === 0) {
      renderLod = 3;
      tiles = this.getLayerTiles(layerId, 3);
    }

    if (tiles.length === 0) {
      return canvas.toDataURL('image/png');
    }

    const lodDocSize = TILE_SIZE << renderLod;
    const thumbImg = ctx.createImageData(thumbWidth, thumbHeight);
    const outData = thumbImg.data;
    const scaleX = docW / thumbWidth;
    const scaleY = docH / thumbHeight;

    for (const tile of tiles) {
      const tileDocX = tile.tileX * lodDocSize;
      const tileDocY = tile.tileY * lodDocSize;

      const x0 = Math.max(0, Math.floor((tileDocX / docW) * thumbWidth));
      const y0 = Math.max(0, Math.floor((tileDocY / docH) * thumbHeight));
      const x1 = Math.min(thumbWidth, Math.ceil(((tileDocX + lodDocSize) / docW) * thumbWidth));
      const y1 = Math.min(thumbHeight, Math.ceil(((tileDocY + lodDocSize) / docH) * thumbHeight));

      if (x0 >= x1 || y0 >= y1) continue;

      const rgba = this.getTileAsRGBA(tile);

      for (let py = y0; py < y1; py++) {
        const docY = (py + 0.5) * scaleY;
        const ly = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(((docY - tileDocY) / lodDocSize) * TILE_SIZE)));
        const ly2 = Math.min(TILE_SIZE - 1, ly + 1);
        for (let px = x0; px < x1; px++) {
          const docX = (px + 0.5) * scaleX;
          const lx = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(((docX - tileDocX) / lodDocSize) * TILE_SIZE)));
          const lx2 = Math.min(TILE_SIZE - 1, lx + 1);

          let srcIdx = (ly * TILE_SIZE + lx) * 4;
          if (rgba[srcIdx + 3] === 0) {
            const alt1 = (ly * TILE_SIZE + lx2) * 4;
            const alt2 = (ly2 * TILE_SIZE + lx) * 4;
            const alt3 = (ly2 * TILE_SIZE + lx2) * 4;
            if (rgba[alt1 + 3] > 0) srcIdx = alt1;
            else if (rgba[alt2 + 3] > 0) srcIdx = alt2;
            else if (rgba[alt3 + 3] > 0) srcIdx = alt3;
          }

          if (rgba[srcIdx + 3] > 0) {
            const dstIdx = (py * thumbWidth + px) * 4;
            outData[dstIdx] = rgba[srcIdx];
            outData[dstIdx + 1] = rgba[srcIdx + 1];
            outData[dstIdx + 2] = rgba[srcIdx + 2];
            outData[dstIdx + 3] = rgba[srcIdx + 3];
          }
        }
      }
    }

    ctx.putImageData(thumbImg, 0, 0);
    return canvas.toDataURL('image/png');
  }

  // ==========================================================================
  // On-Demand Mipmap Pyramid Management
  // ==========================================================================

  public isLodTileDirty(layerId: string, tileX: number, tileY: number, lod: number): boolean {
    if (lod <= 0) return false;
    return this.dirtyLodTiles.has(getTileKey(layerId, tileX, tileY, lod));
  }

  public markLodAncestorsDirty(layerId: string, tileX: number, tileY: number): void {
    let tx = tileX;
    let ty = tileY;
    for (let lod = 1; lod <= 3; lod++) {
      tx = tx >> 1;
      ty = ty >> 1;
      const key = getTileKey(layerId, tx, ty, lod);
      this.dirtyLodTiles.add(key);
      const existing = this.tiles.get(key);
      if (existing) {
        existing.dirty = true;
      }
    }
  }

  /**
   * Generates or downsamples a specific LOD tile from its 4 child tiles at LOD - 1.
   */
  public generateLodTile(layerId: string, lodTx: number, lodTy: number, targetLod: number): TileBuffer | null {
    if (targetLod <= 0) {
      return this.getTile(layerId, lodTx, lodTy, 0);
    }

    const childLod = targetLod - 1;
    const cX0 = lodTx << 1;
    const cY0 = lodTy << 1;

    let c00 = this.getTile(layerId, cX0, cY0, childLod);
    let c10 = this.getTile(layerId, cX0 + 1, cY0, childLod);
    let c01 = this.getTile(layerId, cX0, cY0 + 1, childLod);
    let c11 = this.getTile(layerId, cX0 + 1, cY0 + 1, childLod);

    if (childLod > 0) {
      if (!c00 || this.isLodTileDirty(layerId, cX0, cY0, childLod)) {
        c00 = this.generateLodTile(layerId, cX0, cY0, childLod);
      }
      if (!c10 || this.isLodTileDirty(layerId, cX0 + 1, cY0, childLod)) {
        c10 = this.generateLodTile(layerId, cX0 + 1, cY0, childLod);
      }
      if (!c01 || this.isLodTileDirty(layerId, cX0, cY0 + 1, childLod)) {
        c01 = this.generateLodTile(layerId, cX0, cY0 + 1, childLod);
      }
      if (!c11 || this.isLodTileDirty(layerId, cX0 + 1, cY0 + 1, childLod)) {
        c11 = this.generateLodTile(layerId, cX0 + 1, cY0 + 1, childLod);
      }
    }

    const firstChild = c00 || c10 || c01 || c11;
    const format = firstChild ? firstChild.format : this.getLayerFormat(layerId);

    const key = getTileKey(layerId, lodTx, lodTy, targetLod);
    let tile = this.tiles.get(key);

    let allocatedNew = false;
    if (!tile) {
      tile = createTileBuffer(layerId, lodTx, lodTy, format, targetLod);
      this.tiles.set(key, tile);
      allocatedNew = true;
    } else if (tile.format !== format) {
      if (tile.data !== null) {
        this.memoryManager?.notifyTileFreed(tile);
      }
      tile.format = format;
      tile.data = new Uint8Array(getTileByteSize(format));
      allocatedNew = true;
    } else if (tile.data === null) {
      allocatedNew = true;
    }

    const success = downsample2x2ToParentTile([c00, c10, c01, c11], tile);
    if (!success) {
      if (!allocatedNew) {
        this.memoryManager?.notifyTileFreed(tile);
      }
      this.tiles.delete(key);
      this.dirtyLodTiles.delete(key);
      return null;
    }

    if (allocatedNew) {
      this.memoryManager?.notifyTileAllocated(tile);
    }
    tile.dirty = true;
    tile.version++;
    this.dirtyLodTiles.delete(key);
    return tile;
  }

  /**
   * Progressively downsamples up to `maxCount` dirty mipmap tiles.
   */
  public updateDirtyMipmaps(maxCount: number = 16): number {
    let count = 0;
    const keys = Array.from(this.dirtyLodTiles);

    // Process lower LODs (LOD 1) before higher LODs (LOD 2, 3)
    keys.sort((a, b) => {
      const pa = parseTileKey(a);
      const pb = parseTileKey(b);
      return pa.lod - pb.lod;
    });

    for (const key of keys) {
      if (count >= maxCount) break;
      this.dirtyLodTiles.delete(key);
      const { layerId, tileX, tileY, lod } = parseTileKey(key);
      this.generateLodTile(layerId, tileX, tileY, lod);
      count++;
    }

    return count;
  }

  /**
   * Flushes all pending dirty mipmap tiles immediately.
   */
  public flushMipmaps(layerId?: string): void {
    const keys = Array.from(this.dirtyLodTiles);
    keys.sort((a, b) => {
      const pa = parseTileKey(a);
      const pb = parseTileKey(b);
      return pa.lod - pb.lod;
    });

    for (const key of keys) {
      const { layerId: lId, tileX, tileY, lod } = parseTileKey(key);
      if (!layerId || lId === layerId) {
        this.dirtyLodTiles.delete(key);
        this.generateLodTile(lId, tileX, tileY, lod);
      }
    }
  }

  public fillLayerSolidWhite(layerId: string, width: number, height: number, format?: TileFormat): void {
    this.clearLayer(layerId);
    this.ingestedLayers.add(layerId);
    if (format) {
      this.setLayerFormat(layerId, format);
    }
    if (width <= 0 || height <= 0) return;

    const targetFormat = format || this.getLayerFormat(layerId);
    if (targetFormat === 'monochrome-1bit') {
      // Solid white in monochrome-1bit has 0 black ink bits
      this.notifyChange();
      return;
    }

    const maxTileX = pixelToTileCoord(width - 1, 0);
    const maxTileY = pixelToTileCoord(height - 1, 0);

    for (let ty = 0; ty <= maxTileY; ty++) {
      const tileDocY = ty * TILE_SIZE;
      const validH = Math.min(TILE_SIZE, height - tileDocY);
      for (let tx = 0; tx <= maxTileX; tx++) {
        const tileDocX = tx * TILE_SIZE;
        const validW = Math.min(TILE_SIZE, width - tileDocX);
        const tile = this.getOrCreateTile(layerId, tx, ty, targetFormat, 0);
        if (!tile.data) {
          tile.data = new Uint8Array(getTileByteSize(tile.format));
          this.memoryManager?.notifyTileAllocated(tile);
        }
        if (validW === TILE_SIZE && validH === TILE_SIZE) {
          tile.data.fill(255);
        } else if (tile.format === 'color-32bit') {
          tile.data.fill(0);
          for (let y = 0; y < validH; y++) {
            const rowStart = y * TILE_SIZE * 4;
            tile.data.fill(255, rowStart, rowStart + validW * 4);
          }
        } else {
          tile.data.fill(0);
          for (let y = 0; y < validH; y++) {
            const rowStart = y * TILE_SIZE;
            tile.data.fill(255, rowStart, rowStart + validW);
          }
        }
        tile.dirty = true;
        tile.version++;
        this.markLodAncestorsDirty(layerId, tx, ty);
      }
    }
    this.bumpLayerVersion(layerId);
    this.notifyChange();
  }

  public ingestCanvas(layerId: string, canvas: HTMLCanvasElement, format?: TileFormat): void {
    if (canvas.width <= 0 || canvas.height <= 0) return;
    if (format) {
      this.setLayerFormat(layerId, format);
    }
    if ((canvas as any).__isBlank) {
      this.clearLayer(layerId);
      this.ingestedLayers.add(layerId);
      if (format) {
        this.setLayerFormat(layerId, format);
      }
      return;
    }
    if ((canvas as any).__isSolidWhite) {
      this.fillLayerSolidWhite(layerId, canvas.width, canvas.height, format);
      return;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    this.clearLayer(layerId);
    this.ingestedLayers.add(layerId);
    if (format) {
      this.setLayerFormat(layerId, format);
    }
    const w = canvas.width;
    const h = canvas.height;
    if (w * h <= 1024 * 1024) {
      const imgData = ctx.getImageData(0, 0, w, h);
      this.writeImageData(layerId, imgData, 0, 0, format, true);
    } else {
      const stripH = TILE_SIZE;
      for (let y = 0; y < h; y += stripH) {
        const curH = Math.min(stripH, h - y);
        const stripData = ctx.getImageData(0, y, w, curH);
        this.writeImageData(layerId, stripData, 0, y, format, true);
      }
    }
    this.notifyChange();
  }

  public clearLayer(layerId: string): void {
    this.ingestedLayers.delete(layerId);
    const prefix = `${layerId}:`;
    const toDelete: string[] = [];
    for (const [key, tile] of this.tiles.entries()) {
      if (key.startsWith(prefix)) {
        toDelete.push(key);
        if (this.memoryManager) {
          this.memoryManager.notifyTileFreed(tile);
        }
      }
    }
    for (const key of toDelete) {
      this.tiles.delete(key);
      this.dirtyLodTiles.delete(key);
    }
    this.bumpLayerVersion(layerId);
    this.notifyChange();
  }

  public cloneLayer(srcLayerId: string, dstLayerId: string): void {
    this.clearLayer(dstLayerId);
    this.ingestedLayers.add(dstLayerId);
    this.setLayerFormat(dstLayerId, this.getLayerFormat(srcLayerId));
    const srcTiles = this.getLayerTiles(srcLayerId, 0);
    for (const srcTile of srcTiles) {
      if (!srcTile.data && srcTile.isPagedToDisk && this.memoryManager) {
        void this.memoryManager.requestTileData(srcTile);
      }
      const clonedData = srcTile.data ? new Uint8Array(srcTile.data.length) : new Uint8Array(getTileByteSize(srcTile.format));
      if (srcTile.data) clonedData.set(srcTile.data);

      const clonedTile: TileBuffer = {
        layerId: dstLayerId,
        tileX: srcTile.tileX,
        tileY: srcTile.tileY,
        format: srcTile.format,
        data: clonedData,
        dirty: true,
        version: 1,
        isPagedToDisk: false,
        lastAccessTimestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
        lod: 0,
      };
      this.setTile(dstLayerId, srcTile.tileX, srcTile.tileY, clonedTile);
    }
  }

  public getMemoryStats(): {
    totalBytes: number;
    activeBytes: number;
    pagedBytes: number;
    tileCount: number;
    activeTileCount: number;
    pagedTileCount: number;
    formatCounts: Record<TileFormat, number>;
    lodCounts: Record<number, number>;
  } {
    let totalBytes = 0;
    let activeBytes = 0;
    let pagedBytes = 0;
    let activeTileCount = 0;
    let pagedTileCount = 0;

    const formatCounts: Record<TileFormat, number> = {
      'monochrome-1bit': 0,
      'grayscale-8bit': 0,
      'color-32bit': 0,
    };
    const lodCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };

    for (const tile of this.tiles.values()) {
      const bSize = getTileByteSize(tile.format);
      totalBytes += bSize;
      lodCounts[tile.lod ?? 0] = (lodCounts[tile.lod ?? 0] || 0) + 1;

      if (tile.data !== null) {
        activeBytes += tile.data.byteLength;
        activeTileCount++;
        formatCounts[tile.format]++;
      } else if (tile.isPagedToDisk) {
        pagedBytes += bSize;
        pagedTileCount++;
      }
    }

    return {
      totalBytes,
      activeBytes,
      pagedBytes,
      tileCount: this.tiles.size,
      activeTileCount,
      pagedTileCount,
      formatCounts,
      lodCounts,
    };
  }

  public snapshotTilesInRect(
    layerId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): Map<string, { format: TileFormat; data: Uint8Array | null }> {
    const snapshot = new Map<string, { format: TileFormat; data: Uint8Array | null }>();
    if (bounds.width <= 0 || bounds.height <= 0) return snapshot;

    const minTileX = pixelToTileCoord(bounds.x, 0);
    const minTileY = pixelToTileCoord(bounds.y, 0);
    const maxTileX = pixelToTileCoord(bounds.x + bounds.width - 1, 0);
    const maxTileY = pixelToTileCoord(bounds.y + bounds.height - 1, 0);

    const layerFormat = this.getLayerFormat(layerId);

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const key = getTileKey(layerId, tx, ty, 0);
        const tile = this.getTile(layerId, tx, ty, 0);
        if (tile && tile.data) {
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

  public computeDeltasFromSnapshot(
    beforeSnapshot: Map<string, { format: TileFormat; data: Uint8Array | null }>,
    layerId: string,
    bounds?: { x: number; y: number; width: number; height: number }
  ): TileDelta[] {
    const deltas: TileDelta[] = [];
    const keysToCheck = new Set<string>(beforeSnapshot.keys());

    if (beforeSnapshot.size === 0 && bounds && bounds.width > 0 && bounds.height > 0) {
      const minTileX = pixelToTileCoord(bounds.x, 0);
      const minTileY = pixelToTileCoord(bounds.y, 0);
      const maxTileX = pixelToTileCoord(bounds.x + bounds.width - 1, 0);
      const maxTileY = pixelToTileCoord(bounds.y + bounds.height - 1, 0);
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        for (let tx = minTileX; tx <= maxTileX; tx++) {
          keysToCheck.add(getTileKey(layerId, tx, ty, 0));
        }
      }
    }

    for (const key of keysToCheck) {
      if (beforeSnapshot.size > 0 && !beforeSnapshot.has(key)) continue;
      const before = beforeSnapshot.get(key);
      const { tileX, tileY } = parseTileKey(key);
      const currentTile = this.getTile(layerId, tileX, tileY, 0);

      const beforeData = before ? before.data : null;
      const afterData = currentTile && currentTile.data ? new Uint8Array(currentTile.data) : null;
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

  public applyTileDeltas(deltas: TileDelta[], direction: 'undo' | 'redo'): void {
    for (const delta of deltas) {
      const { layerId, tileX, tileY } = parseTileKey(delta.key);
      const targetData = direction === 'undo' ? delta.beforeData : delta.afterData;

      if (!targetData) {
        this.deleteTile(layerId, tileX, tileY, 0);
      } else {
        let tile = this.getTile(layerId, tileX, tileY, 0);
        if (!tile) {
          tile = this.getOrCreateTile(layerId, tileX, tileY, delta.format, 0);
        }
        if (!tile.data || tile.data.byteLength !== targetData.byteLength) {
          if (tile.data) {
            this.memoryManager?.notifyTileFreed(tile);
          }
          tile.data = new Uint8Array(targetData.length);
          this.memoryManager?.notifyTileAllocated(tile);
        }
        tile.data.set(targetData);
        tile.format = delta.format;
        this.setLayerFormat(layerId, delta.format);
        tile.dirty = true;
        tile.version++;
        this.markLodAncestorsDirty(layerId, tileX, tileY);
        this.bumpLayerVersion(layerId);
      }
    }
    this.notifyChange();
  }

  public clearAll(): void {
    if (this.memoryManager) {
      for (const tile of this.tiles.values()) {
        this.memoryManager.notifyTileFreed(tile);
      }
    }
    this.tiles.clear();
    this.layerFormats.clear();
    this.ingestedLayers.clear();
    this.dirtyLodTiles.clear();
    this.layerVersions.clear();
    this.gridEpoch++;
    this.notifyChange(true);
  }

  public getAllTiles(): TileBuffer[] {
    return Array.from(this.tiles.values());
  }

  public getAllLayerFormats(): Map<string, TileFormat> {
    return new Map(this.layerFormats);
  }

  public restoreFromSnapshot(tiles: TileBuffer[], layerFormats?: Map<string, TileFormat>): void {
    this.clearAll();
    if (layerFormats) {
      for (const [layerId, fmt] of layerFormats.entries()) {
        this.layerFormats.set(layerId, fmt);
      }
    }
    for (const tile of tiles) {
      this.tiles.set(getTileKey(tile.layerId, tile.tileX, tile.tileY, tile.lod ?? 0), tile);
      if (this.memoryManager) {
        this.memoryManager.notifyTileAllocated(tile);
      }
      if ((tile.lod ?? 0) === 0) {
        this.bumpLayerVersion(tile.layerId);
      }
    }
    this.notifyChange(true);
  }
}

// ============================================================================
// Snapshot Serialization
// ============================================================================

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

export function serializeSparseTileGrid(grid: SparseTileGrid): Uint8Array {
  const encoder = new TextEncoder();
  const tiles = grid.getAllTiles().filter((t) => (t.lod ?? 0) === 0);
  const layerFormats = grid.getAllLayerFormats();

  let totalBytes = 4 + 1 + 4;

  const encodedFormats: Array<{ keyBytes: Uint8Array; format: TileFormat }> = [];
  for (const [layerId, fmt] of layerFormats.entries()) {
    const keyBytes = encoder.encode(layerId);
    encodedFormats.push({ keyBytes, format: fmt });
    totalBytes += 2 + keyBytes.length + 1;
  }

  totalBytes += 4;

  const encodedTiles: Array<{ keyBytes: Uint8Array; tile: TileBuffer }> = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const keyBytes = encoder.encode(t.layerId);
    encodedTiles.push({ keyBytes, tile: t });
    const dataLen = t.data ? t.data.byteLength : 0;
    totalBytes += 2 + keyBytes.length + 4 + 4 + 1 + 4 + 4 + dataLen;
  }

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer, out.byteOffset, totalBytes);

  let offset = 0;
  out[offset++] = 0x49; // 'I'
  out[offset++] = 0x4e; // 'N'
  out[offset++] = 0x4b; // 'K'
  out[offset++] = 0x47; // 'G'
  out[offset++] = 1; // Version

  view.setUint32(offset, encodedFormats.length, true);
  offset += 4;

  for (const item of encodedFormats) {
    view.setUint16(offset, item.keyBytes.length, true);
    offset += 2;
    out.set(item.keyBytes, offset);
    offset += item.keyBytes.length;
    out[offset++] = FORMAT_TO_BYTE[item.format] ?? 2;
  }

  view.setUint32(offset, encodedTiles.length, true);
  offset += 4;

  for (const item of encodedTiles) {
    const t = item.tile;
    view.setUint16(offset, item.keyBytes.length, true);
    offset += 2;
    out.set(item.keyBytes, offset);
    offset += item.keyBytes.length;

    view.setInt32(offset, t.tileX, true);
    offset += 4;
    view.setInt32(offset, t.tileY, true);
    offset += 4;
    out[offset++] = FORMAT_TO_BYTE[t.format] ?? 2;
    view.setUint32(offset, t.version, true);
    offset += 4;

    const dataLen = t.data ? t.data.byteLength : 0;
    view.setUint32(offset, dataLen, true);
    offset += 4;
    if (t.data) {
      out.set(t.data, offset);
      offset += dataLen;
    }
  }

  return out;
}

export function deserializeSparseTileGrid(grid: SparseTileGrid, buffer: Uint8Array): void {
  if (buffer.byteLength < 9) {
    throw new Error('Invalid SparseTileGrid buffer: too short');
  }
  if (
    buffer[0] !== 0x49 ||
    buffer[1] !== 0x4e ||
    buffer[2] !== 0x4b ||
    buffer[3] !== 0x47
  ) {
    throw new Error('Invalid SparseTileGrid buffer: bad magic');
  }
  const version = buffer[4];
  if (version !== 1) {
    throw new Error(`Unsupported SparseTileGrid version: ${version}`);
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const decoder = new TextDecoder();
  let offset = 5;

  const formatCount = view.getUint32(offset, true);
  offset += 4;

  const layerFormats = new Map<string, TileFormat>();
  for (let i = 0; i < formatCount; i++) {
    const kLen = view.getUint16(offset, true);
    offset += 2;
    const kBytes = buffer.subarray(offset, offset + kLen);
    const layerId = decoder.decode(kBytes);
    offset += kLen;
    const fmtByte = buffer[offset++];
    layerFormats.set(layerId, BYTE_TO_FORMAT[fmtByte] || 'color-32bit');
  }

  const tileCount = view.getUint32(offset, true);
  offset += 4;

  const restoredTiles: TileBuffer[] = [];
  for (let i = 0; i < tileCount; i++) {
    const kLen = view.getUint16(offset, true);
    offset += 2;
    const kBytes = buffer.subarray(offset, offset + kLen);
    const layerId = decoder.decode(kBytes);
    offset += kLen;

    const tileX = view.getInt32(offset, true);
    offset += 4;
    const tileY = view.getInt32(offset, true);
    offset += 4;
    const fmtByte = buffer[offset++];
    const format = BYTE_TO_FORMAT[fmtByte] || 'color-32bit';
    const ver = view.getUint32(offset, true);
    offset += 4;

    const dLen = view.getUint32(offset, true);
    offset += 4;
    const data = new Uint8Array(dLen);
    data.set(buffer.subarray(offset, offset + dLen));
    offset += dLen;

    restoredTiles.push({
      layerId,
      tileX,
      tileY,
      format,
      data,
      dirty: true,
      version: ver,
      isPagedToDisk: false,
      lastAccessTimestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      lod: 0,
    });
  }

  grid.restoreFromSnapshot(restoredTiles, layerFormats);
}

export function serializeTileDeltas(deltas: TileDelta[]): Uint8Array {
  const encoder = new TextEncoder();
  let totalBytes = 2 + 1 + 4;
  const encodedKeys: Uint8Array[] = [];

  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    const keyBytes = encoder.encode(d.key);
    encodedKeys.push(keyBytes);

    totalBytes += 2 + keyBytes.length;
    totalBytes += 1;
    totalBytes += 1;
    if (d.beforeData && d.beforeData.byteLength > 0) {
      totalBytes += 4 + d.beforeData.byteLength;
    }
    totalBytes += 1;
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
export const globalTileMemoryManager = globalTileGrid.getMemoryManager()!;
