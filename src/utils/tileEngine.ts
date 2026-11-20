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
  solidColorU32?: number; // When defined on a color-32bit tile, all 65,536 pixels share this exact U32 RGBA value
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
  const thresh1000 = threshold * 1000;
  const src32 =
    srcRGBA.byteOffset % 4 === 0
      ? new Uint32Array(srcRGBA.buffer, srcRGBA.byteOffset, TILE_PIXELS)
      : null;
  let srcOffset = 0;

  for (let i = 0; i < BYTES_1BIT; i++) {
    if (src32 !== null) {
      const p = i << 3;
      if (
        (src32[p] |
          src32[p + 1] |
          src32[p + 2] |
          src32[p + 3] |
          src32[p + 4] |
          src32[p + 5] |
          src32[p + 6] |
          src32[p + 7]) === 0
      ) {
        dst1Bit[i] = 0;
        srcOffset += 32;
        continue;
      }
    }
    let byteVal = 0;
    for (let bit = 7; bit >= 0; bit--) {
      const a = srcRGBA[srcOffset + 3];
      if (a >= 24) {
        // Luminance: 0.299*R + 0.587*G + 0.114*B (integer scaled x1000)
        const lum1000 =
          srcRGBA[srcOffset] * 299 +
          srcRGBA[srcOffset + 1] * 587 +
          srcRGBA[srcOffset + 2] * 114;
        // Dark pixels become ink (1), light pixels transparent (0)
        if (lum1000 < thresh1000) {
          byteVal |= 1 << bit;
        }
      }
      srcOffset += 4;
    }
    dst1Bit[i] = byteVal;
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

// Fast 2-bit popcount and coverage RGBA LUT for box-filtering monochrome-1bit -> color-32bit LOD tiles
const _pop2 = new Uint8Array([0, 1, 1, 2]);
const _monoCovU32 = new Uint32Array(
  isLittleEndian
    ? [0x00000000, 0x40000000, 0x80000000, 0xbf000000, 0xff000000]
    : [0x00000000, 0x00000040, 0x00000080, 0x000000bf, 0x000000ff]
);

/**
 * Downsample 4 child tiles (2x2 cluster) at LOD k-1 into a single destination tile at LOD k.
 * Reuses pre-allocated scratch buffers for zero 256KB heap allocations during zoom-out LOD builds.
 */
export function downsample2x2ToParentTile(
  childTiles: [TileBuffer | null, TileBuffer | null, TileBuffer | null, TileBuffer | null],
  dstTile: TileBuffer
): boolean {
  const c0 = childTiles[0];
  const c1 = childTiles[1];
  const c2 = childTiles[2];
  const c3 = childTiles[3];
  if (
    (!c0 || c0.data === null) &&
    (!c1 || c1.data === null) &&
    (!c2 || c2.data === null) &&
    (!c3 || c3.data === null)
  ) {
    dstTile.solidColorU32 = undefined;
    return false;
  }

  if (!dstTile.data) {
    dstTile.data = new Uint8Array(getTileByteSize(dstTile.format));
  }

  const format = dstTile.format;
  const dst = dstTile.data;
  dstTile.solidColorU32 = undefined;

  // Fast path #1: All 4 child tiles are identical solid color-32bit tiles (e.g. solid white paper)
  if (
    format === 'color-32bit' &&
    c0 && c1 && c2 && c3 &&
    c0.solidColorU32 !== undefined &&
    c0.solidColorU32 === c1.solidColorU32 &&
    c0.solidColorU32 === c2.solidColorU32 &&
    c0.solidColorU32 === c3.solidColorU32
  ) {
    const dst32 = new Uint32Array(dst.buffer, dst.byteOffset, TILE_PIXELS);
    dst32.fill(c0.solidColorU32);
    dstTile.solidColorU32 = c0.solidColorU32;
    dstTile.dirty = false;
    dstTile.version++;
    return true;
  }

  dst.fill(0);
  const dst32 = format === 'color-32bit'
    ? new Uint32Array(dst.buffer, dst.byteOffset, TILE_PIXELS)
    : null;

  for (let q = 0; q < 4; q++) {
    const child = childTiles[q];
    if (!child || !child.data) continue;

    let childData = child.data;
    const xBase = (q & 1) ? 128 : 0;
    const yBase = (q >= 2) ? 128 : 0;

    if (format === 'color-32bit') {
      // Fast path #2: Uniform solid quadrant
      if (child.solidColorU32 !== undefined && dst32) {
        const fillU32 = child.solidColorU32;
        for (let ly = 0; ly < 128; ly++) {
          const rowStart = (yBase + ly) * TILE_SIZE + xBase;
          dst32.fill(fillU32, rowStart, rowStart + 128);
        }
        continue;
      }

      if (child.format === 'monochrome-1bit' && dst32) {
        // Fast zero-unpack 2x2 bit-counting box filter: 1-bit ink -> anti-aliased black coverage RGBA
        for (let ly = 0; ly < 128; ly++) {
          const sy0 = ly << 1;
          const srcRow0 = sy0 << 5;
          const srcRow1 = (sy0 + 1) << 5;
          const dstRowBase = (yBase + ly) * TILE_SIZE + xBase;
          for (let bx = 0; bx < 32; bx++) {
            const b0 = childData[srcRow0 + bx];
            const b1 = childData[srcRow1 + bx];
            if ((b0 | b1) === 0) continue;
            const outOff = dstRowBase + (bx << 2);
            dst32[outOff] = _monoCovU32[_pop2[(b0 >> 6) & 3] + _pop2[(b1 >> 6) & 3]];
            dst32[outOff + 1] = _monoCovU32[_pop2[(b0 >> 4) & 3] + _pop2[(b1 >> 4) & 3]];
            dst32[outOff + 2] = _monoCovU32[_pop2[(b0 >> 2) & 3] + _pop2[(b1 >> 2) & 3]];
            dst32[outOff + 3] = _monoCovU32[_pop2[b0 & 3] + _pop2[b1 & 3]];
          }
        }
        continue;
      } else if (child.format === 'monochrome-1bit') {
        unpack1BitToRGBA(childData, _downsampleRgbaScratch);
        childData = _downsampleRgbaView;
      } else if (child.format === 'grayscale-8bit') {
        unpack8BitToRGBA(childData, _downsampleRgbaScratch);
        childData = _downsampleRgbaView;
      }
      for (let ly = 0; ly < 128; ly++) {
        const sy0 = ly << 1;
        const dy = yBase + ly;
        const dstRowOffset = dy * TILE_SIZE + xBase;
        const srcRowOffset0 = sy0 * TILE_SIZE;
        const srcRowOffset1 = (sy0 + 1) * TILE_SIZE;

        for (let lx = 0; lx < 128; lx++) {
          const sx0 = lx << 1;
          const p00 = (srcRowOffset0 + sx0) << 2;
          const p10 = p00 + 4;
          const p01 = (srcRowOffset1 + sx0) << 2;
          const p11 = p01 + 4;

          const a0 = childData[p00 + 3];
          const a1 = childData[p10 + 3];
          const a2 = childData[p01 + 3];
          const a3 = childData[p11 + 3];
          const sumA = a0 + a1 + a2 + a3;

          if (sumA === 0) {
            continue; // dst is already zero-initialized
          }
          const outIdx = (dstRowOffset + lx) << 2;
          if (sumA === 1020) {
            dst[outIdx] = (childData[p00] + childData[p10] + childData[p01] + childData[p11] + 2) >> 2;
            dst[outIdx + 1] = (childData[p00 + 1] + childData[p10 + 1] + childData[p01 + 1] + childData[p11 + 1] + 2) >> 2;
            dst[outIdx + 2] = (childData[p00 + 2] + childData[p10 + 2] + childData[p01 + 2] + childData[p11 + 2] + 2) >> 2;
            dst[outIdx + 3] = 255;
          } else {
            const halfA = sumA >> 1;
            dst[outIdx + 3] = sumA >> 2;
            dst[outIdx] = ((childData[p00] * a0 + childData[p10] * a1 + childData[p01] * a2 + childData[p11] * a3 + halfA) / sumA) | 0;
            dst[outIdx + 1] = ((childData[p00 + 1] * a0 + childData[p10 + 1] * a1 + childData[p01 + 1] * a2 + childData[p11 + 1] * a3 + halfA) / sumA) | 0;
            dst[outIdx + 2] = ((childData[p00 + 2] * a0 + childData[p10 + 2] * a1 + childData[p01 + 2] * a2 + childData[p11 + 2] * a3 + halfA) / sumA) | 0;
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

const _tileBatchEncoder = new TextEncoder();
const _tileBatchDecoder = new TextDecoder();
const MIN_TILE_BATCH_RECORD_BYTES = 14; // layerIdLen(u16) + tx(i32) + ty(i32) + dataLen(u32)

/**
 * Packs a batch of tiles into a compact little-endian binary frame for raw Tauri IPC:
 * `[count:u32][layerIdLen:u16, layerId(utf8), tx:i32, ty:i32, dataLen:u32, data]...`
 */
export function packTileWriteBatch(tiles: TileWritePayload[]): Uint8Array {
  const encodedIds: Uint8Array[] = new Array(tiles.length);
  let totalBytes = 4;

  for (let i = 0; i < tiles.length; i++) {
    const idBytes = _tileBatchEncoder.encode(tiles[i].layerId);
    if (idBytes.byteLength > 0xffff) {
      throw new Error(`Layer ID exceeds u16 byte length limit: ${tiles[i].layerId}`);
    }
    encodedIds[i] = idBytes;
    totalBytes += MIN_TILE_BATCH_RECORD_BYTES + idBytes.byteLength + tiles[i].data.byteLength;
  }

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, tiles.length, true);

  let offset = 4;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const idBytes = encodedIds[i];

    view.setUint16(offset, idBytes.byteLength, true);
    offset += 2;

    out.set(idBytes, offset);
    offset += idBytes.byteLength;

    view.setInt32(offset, t.tileX, true);
    offset += 4;

    view.setInt32(offset, t.tileY, true);
    offset += 4;

    view.setUint32(offset, t.data.byteLength, true);
    offset += 4;

    out.set(t.data, offset);
    offset += t.data.byteLength;
  }

  return out;
}

/**
 * Unpacks a compact binary tile batch frame back into TileWritePayload entries.
 */
export function unpackTileWriteBatch(buffer: Uint8Array | ArrayBuffer): TileWritePayload[] {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 4) {
    throw new Error('Truncated tile batch header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count > Math.floor((bytes.byteLength - 4) / MIN_TILE_BATCH_RECORD_BYTES)) {
    throw new Error('Truncated tile batch payload');
  }

  const tiles: TileWritePayload[] = new Array(count);
  let offset = 4;

  for (let i = 0; i < count; i++) {
    if (offset + 2 > bytes.byteLength) {
      throw new Error('Truncated tile record layerIdLen');
    }
    const idLen = view.getUint16(offset, true);
    offset += 2;

    if (offset + idLen + 12 > bytes.byteLength) {
      throw new Error('Truncated tile record metadata');
    }
    const layerId = _tileBatchDecoder.decode(bytes.subarray(offset, offset + idLen));
    offset += idLen;

    const tileX = view.getInt32(offset, true);
    offset += 4;
    const tileY = view.getInt32(offset, true);
    offset += 4;
    const dataLen = view.getUint32(offset, true);
    offset += 4;

    if (offset + dataLen > bytes.byteLength) {
      throw new Error('Truncated tile record data');
    }
    const data = bytes.slice(offset, offset + dataLen);
    offset += dataLen;

    tiles[i] = { layerId, tileX, tileY, data };
  }

  if (offset !== bytes.byteLength) {
    throw new Error('Unexpected trailing bytes in tile batch payload');
  }

  return tiles;
}

/**
 * Production Tauri v2 Rust Scratch Disk Driver.
 * Direct raw binary IPC with high-throughput LZ4 compression and atomic file index tables.
 */
export class TauriScratchDiskDriver implements IScratchDiskDriver {
  public async init(sessionId: string): Promise<void> {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('scratch_disk_init', { sessionId });
  }

  public async writeTiles(sessionId: string, tiles: TileWritePayload[]): Promise<number> {
    if (tiles.length === 0) return 0;
    const { invoke } = await import('@tauri-apps/api/core');
    const packed = packTileWriteBatch(tiles);
    return invoke<number>('scratch_disk_write_tiles', packed, {
      headers: {
        'x-session-id': encodeURIComponent(sessionId),
      },
    });
  }

  public async readTile(sessionId: string, layerId: string, tileX: number, tileY: number): Promise<Uint8Array> {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('scratch_disk_read_tile', undefined, {
      headers: {
        'x-session-id': encodeURIComponent(sessionId),
        'x-layer-id': encodeURIComponent(layerId),
        'x-tile-x': String(tileX),
        'x-tile-y': String(tileY),
      },
    });
    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    return new Uint8Array(raw);
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

  public async init(sessionId: string): Promise<void> {
    await this.clear(sessionId);
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
  onMemoryChanged?: () => void;
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
  private onMemoryChanged?: () => void;

  constructor(grid: SparseTileGrid, options?: TileMemoryManagerOptions) {
    this.grid = grid;
    const mb = options?.budgetMb ?? 1024;
    this.budgetBytes = Math.max(1, mb) * 1024 * 1024;
    this.sessionId = options?.sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.driver = options?.driver || createDefaultScratchDiskDriver();
    this.onMemoryChanged = options?.onMemoryChanged;
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
        if (this.onMemoryChanged) {
          this.onMemoryChanged();
        } else {
          void this.checkBudgetAndEvict();
        }
      }
    }
  }

  public notifyTileFreed(tile: TileBuffer): void {
    if (tile.data !== null) {
      this.activeBytes = Math.max(0, this.activeBytes - tile.data.byteLength);
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
          this.activeBytes = Math.max(0, this.activeBytes - tile.data.byteLength);
          tile.data = null;
          tile.isPagedToDisk = true;
          tile.dirty = false;
        }
      }
    }
  }

  /**
   * Drops all cached LOD > 0 tiles and evicts up to `bytesToFree` of LOD 0 tiles to scratch disk.
   * Used by DocumentStore to cooperatively reclaim RAM from inactive document tabs.
   */
  public async evictBytesToDisk(bytesToFree: number): Promise<number> {
    if (bytesToFree <= 0 || this.activeBytes <= 0) return 0;
    let freed = 0;

    // 1. Drop regenerable LOD > 0 tiles first (zero disk I/O)
    for (const tile of this.grid.getAllTiles()) {
      if (tile.lod > 0 && tile.data !== null) {
        const sz = tile.data.byteLength;
        this.activeBytes = Math.max(0, this.activeBytes - sz);
        freed += sz;
        tile.data = null;
        tile.dirty = true;
      }
    }

    if (freed >= bytesToFree) return freed;

    // 2. Evict LOD 0 tiles oldest-first to scratch disk
    const lod0: TileBuffer[] = [];
    for (const tile of this.grid.getAllTiles()) {
      if (tile.lod === 0 && tile.data !== null) {
        lod0.push(tile);
      }
    }
    lod0.sort((a, b) => a.lastAccessTimestamp - b.lastAccessTimestamp);

    const toEvict: TileBuffer[] = [];
    for (const tile of lod0) {
      if (freed >= bytesToFree) break;
      toEvict.push(tile);
      freed += tile.data?.byteLength || 0;
    }

    if (toEvict.length > 0) {
      await this.evictTiles(toEvict);
    }

    return freed;
  }

  /**
   * Offloads all in-memory tiles of this document to scratch disk.
   */
  public async evictAllToDisk(): Promise<number> {
    return this.evictBytesToDisk(this.activeBytes);
  }

  public async clear(): Promise<void> {
    this.inFlightPageIns.clear();
    this.activeBytes = 0;
    await this.driver.clear(this.sessionId);
  }
}

let nextSparseTileGridId = 1;

/**
 * Releases an HTMLCanvasElement's backing store immediately so Chromium/WebView2 reclaims RAM.
 */
export function releaseTemporaryCanvas(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // Ignore read-only or detached mock canvases in tests
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
const TILE_COORD_BIAS = 32768;
const TILE_COORD_STRIDE = 65536;

function packTileCoord(tx: number, ty: number): number {
  return (ty + TILE_COORD_BIAS) * TILE_COORD_STRIDE + (tx + TILE_COORD_BIAS);
}

function unpackTileCoordX(packed: number): number {
  return (packed % TILE_COORD_STRIDE) - TILE_COORD_BIAS;
}

function unpackTileCoordY(packed: number): number {
  return Math.floor(packed / TILE_COORD_STRIDE) - TILE_COORD_BIAS;
}

export class SparseTileGrid {
  private readonly gridId: number = nextSparseTileGridId++;
  private tiles: Map<string, TileBuffer> = new Map();
  private layerLod0Tiles: Map<string, Set<TileBuffer>> = new Map();
  private layerLodOccupancy: Map<string, [Map<number, number>, Map<number, number>, Map<number, number>]> = new Map();
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
  private contentVersion: number = 1;
  private gridEpoch: number = 0;

  constructor(memoryManagerOptions?: TileMemoryManagerOptions) {
    this.memoryManager = new TileMemoryManager(this, memoryManagerOptions);
  }

  private registerLod0Tile(tile: TileBuffer): void {
    if ((tile.lod ?? 0) !== 0) return;
    let set = this.layerLod0Tiles.get(tile.layerId);
    if (!set) {
      set = new Set<TileBuffer>();
      this.layerLod0Tiles.set(tile.layerId, set);
    }
    if (set.has(tile)) return;
    set.add(tile);

    let occ = this.layerLodOccupancy.get(tile.layerId);
    if (!occ) {
      occ = [new Map<number, number>(), new Map<number, number>(), new Map<number, number>()];
      this.layerLodOccupancy.set(tile.layerId, occ);
    }
    let tx = tile.tileX;
    let ty = tile.tileY;
    for (let i = 0; i < 3; i++) {
      tx = tx >> 1;
      ty = ty >> 1;
      const pk = packTileCoord(tx, ty);
      occ[i].set(pk, (occ[i].get(pk) ?? 0) + 1);
    }
  }

  private unregisterLod0Tile(tile: TileBuffer): void {
    if ((tile.lod ?? 0) !== 0) return;
    const set = this.layerLod0Tiles.get(tile.layerId);
    if (!set || !set.delete(tile)) return;
    if (set.size === 0) {
      this.layerLod0Tiles.delete(tile.layerId);
    }

    const occ = this.layerLodOccupancy.get(tile.layerId);
    if (!occ) return;
    let tx = tile.tileX;
    let ty = tile.tileY;
    for (let i = 0; i < 3; i++) {
      tx = tx >> 1;
      ty = ty >> 1;
      const pk = packTileCoord(tx, ty);
      const next = (occ[i].get(pk) ?? 0) - 1;
      if (next <= 0) {
        occ[i].delete(pk);
      } else {
        occ[i].set(pk, next);
      }
    }
    if (set.size === 0) {
      this.layerLodOccupancy.delete(tile.layerId);
    }
  }

  public getGridId(): number {
    return this.gridId;
  }

  public hasLayerTiles(layerId: string): boolean {
    const set = this.layerLod0Tiles.get(layerId);
    return set !== undefined && set.size > 0;
  }

  public hasPopulatedLodTile(layerId: string, tileX: number, tileY: number, lod: number): boolean {
    if (lod <= 0) {
      return this.tiles.has(getTileKey(layerId, tileX, tileY, 0));
    }
    const idx = lod - 1;
    if (idx < 0 || idx > 2) return false;
    const occ = this.layerLodOccupancy.get(layerId);
    return occ !== undefined && (occ[idx].get(packTileCoord(tileX, tileY)) ?? 0) > 0;
  }

  public getContentVersion(): number {
    return this.contentVersion;
  }

  public getLayerVersion(layerId: string): number {
    return this.layerVersions.get(layerId) ?? 0;
  }

  public bumpLayerVersion(layerId: string): void {
    this.layerVersions.set(layerId, ++this.globalVersionCounter);
    this.contentVersion++;
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
      if (lod === 0) {
        this.registerLod0Tile(tile);
      }
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
    if (existing) {
      if ((existing.lod ?? 0) === 0) {
        this.unregisterLod0Tile(existing);
      }
      if (this.memoryManager) {
        this.memoryManager.notifyTileFreed(existing);
      }
    }
    this.tiles.set(key, tile);
    if ((tile.lod ?? 0) === 0) {
      this.registerLod0Tile(tile);
    }
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
      if ((tile.lod ?? 0) === 0) {
        this.unregisterLod0Tile(tile);
      }
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
    if (lod === 0) {
      const set = this.layerLod0Tiles.get(layerId);
      return set ? Array.from(set) : [];
    }
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
    if (lod === 0 && !this.hasLayerTiles(layerId)) {
      return [];
    }
    const minTileX = pixelToTileCoord(minX, lod);
    const minTileY = pixelToTileCoord(minY, lod);
    const maxTileX = pixelToTileCoord(maxX, lod);
    const maxTileY = pixelToTileCoord(maxY, lod);

    const result: TileBuffer[] = [];
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        if (lod > 0 && !this.hasPopulatedLodTile(layerId, tx, ty, lod)) {
          const direct = this.getTile(layerId, tx, ty, lod);
          if (direct) result.push(direct);
          continue;
        }
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
    const src32 =
      srcData.byteOffset % 4 === 0 && srcData.byteLength >= w * h * 4
        ? new Uint32Array(srcData.buffer, srcData.byteOffset, w * h)
        : null;

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
          if (src32 !== null) {
            outer32: for (let sy = srcStartY; sy < srcEndY; sy++) {
              const rowOff = sy * w;
              for (let sx = rowOff + srcStartX, end = rowOff + srcEndX; sx < end; sx++) {
                if (src32[sx] !== 0) {
                  hasNonZero = true;
                  break outer32;
                }
              }
            }
          } else {
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
          const dst = tile.data;
          const localStartX = destX + srcStartX - tileDocX;
          const copyWidth = srcEndX - srcStartX;
          const localEndX = localStartX + copyWidth;

          for (let sy = srcStartY; sy < srcEndY; sy++) {
            const tileLocalY = destY + sy - tileDocY;
            const rowByteBase = tileLocalY << 5; // TILE_SIZE / 8 = 32
            let lx = localStartX;
            let srcPixIdx = sy * w + srcStartX;
            let srcOff = srcPixIdx << 2;

            // Leading unaligned pixels before an 8-pixel boundary
            if ((lx & 7) !== 0) {
              const byteIdx = rowByteBase + (lx >> 3);
              let byteVal = dst[byteIdx];
              const stop = Math.min(localEndX, (lx + 7) & ~7);
              while (lx < stop) {
                const mask = 1 << (7 - (lx & 7));
                const a = srcData[srcOff + 3];
                if (
                  a >= 24 &&
                  srcData[srcOff] * 299 + srcData[srcOff + 1] * 587 + srcData[srcOff + 2] * 114 < 128000
                ) {
                  byteVal |= mask;
                } else {
                  byteVal &= ~mask;
                }
                lx++;
                srcPixIdx++;
                srcOff += 4;
              }
              dst[byteIdx] = byteVal;
            }

            // Full 8-pixel aligned bytes
            while (lx + 8 <= localEndX) {
              const byteIdx = rowByteBase + (lx >> 3);
              if (
                src32 !== null &&
                (src32[srcPixIdx] |
                  src32[srcPixIdx + 1] |
                  src32[srcPixIdx + 2] |
                  src32[srcPixIdx + 3] |
                  src32[srcPixIdx + 4] |
                  src32[srcPixIdx + 5] |
                  src32[srcPixIdx + 6] |
                  src32[srcPixIdx + 7]) === 0
              ) {
                dst[byteIdx] = 0;
                lx += 8;
                srcPixIdx += 8;
                srcOff += 32;
                continue;
              }
              let byteVal = 0;
              for (let bit = 7; bit >= 0; bit--) {
                const a = srcData[srcOff + 3];
                if (
                  a >= 24 &&
                  srcData[srcOff] * 299 + srcData[srcOff + 1] * 587 + srcData[srcOff + 2] * 114 < 128000
                ) {
                  byteVal |= 1 << bit;
                }
                srcOff += 4;
              }
              dst[byteIdx] = byteVal;
              lx += 8;
              srcPixIdx += 8;
            }

            // Trailing unaligned pixels
            if (lx < localEndX) {
              const byteIdx = rowByteBase + (lx >> 3);
              let byteVal = dst[byteIdx];
              while (lx < localEndX) {
                const mask = 1 << (7 - (lx & 7));
                const a = srcData[srcOff + 3];
                if (
                  a >= 24 &&
                  srcData[srcOff] * 299 + srcData[srcOff + 1] * 587 + srcData[srcOff + 2] * 114 < 128000
                ) {
                  byteVal |= mask;
                } else {
                  byteVal &= ~mask;
                }
                lx++;
                srcOff += 4;
              }
              dst[byteIdx] = byteVal;
            }
          }
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

        tile.solidColorU32 = undefined;
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

  /**
   * Composites an isolated stroke RGBA buffer directly onto LOD 0 tiles in-place,
   * avoiding full-region canvas allocation, existing-tile unpacking, and separate
   * binarization passes. Records pre-edit tile snapshots into `snapshotOut` only
   * for tiles with non-zero stroke pixels.
   */
  public compositeStrokeToTiles(options: {
    layerId: string;
    strokeData: { data: Uint8ClampedArray | Uint8Array; width: number; height: number };
    destX: number;
    destY: number;
    format: TileFormat;
    compositeOp: 'source-over' | 'destination-out' | 'source-atop';
    opacity: number;
    monochrome?: {
      threshold: number;
      expressBlack: boolean;
      expressWhite: boolean;
    };
    selectionMask?: {
      mask: Uint8Array;
      bounds: { x: number; y: number; width: number; height: number };
    } | null;
    snapshotOut?: Map<string, { format: TileFormat; data: Uint8Array | null }>;
    suppressNotify?: boolean;
  }): boolean {
    const {
      layerId,
      strokeData,
      destX,
      destY,
      format: targetFormat,
      compositeOp,
      monochrome,
      selectionMask,
      snapshotOut,
      suppressNotify = false,
    } = options;
    const opacity = Math.max(0, Math.min(1, options.opacity));
    const w = strokeData.width;
    const h = strokeData.height;
    if (w <= 0 || h <= 0 || opacity <= 0.001) return false;

    this.ingestedLayers.add(layerId);
    this.setLayerFormat(layerId, targetFormat);

    const minTileX = pixelToTileCoord(destX, 0);
    const minTileY = pixelToTileCoord(destY, 0);
    const maxTileX = pixelToTileCoord(destX + w - 1, 0);
    const maxTileY = pixelToTileCoord(destY + h - 1, 0);

    const srcData = strokeData.data;
    const src32 =
      srcData.byteOffset % 4 === 0 && srcData.byteLength >= w * h * 4
        ? new Uint32Array(srcData.buffer, srcData.byteOffset, w * h)
        : null;

    const monoThresh = Math.max(1, Math.min(255, monochrome?.threshold ?? 128));
    const monoExpressBlack = monochrome?.expressBlack !== false;
    const hasSelMask = Boolean(selectionMask?.mask);
    const selMask = selectionMask?.mask ?? null;
    const selBx = selectionMask ? Math.floor(selectionMask.bounds.x) : 0;
    const selBy = selectionMask ? Math.floor(selectionMask.bounds.y) : 0;
    const selBw = selectionMask ? Math.ceil(selectionMask.bounds.width) : 0;
    const selBh = selectionMask ? Math.ceil(selectionMask.bounds.height) : 0;
    const fullOpacity = opacity >= 0.999;

    let anyModified = false;

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

        // Erasing or alpha-locking against an empty tile is a no-op
        if ((compositeOp === 'destination-out' || compositeOp === 'source-atop') && (!existingTile || !existingTile.data)) {
          continue;
        }

        // Fast zero-scan: skip tiles where the stroke overlap is completely transparent
        let hasNonZero = false;
        if (src32 !== null) {
          outerZero32: for (let sy = srcStartY; sy < srcEndY; sy++) {
            const rowOff = sy * w;
            for (let sx = rowOff + srcStartX, end = rowOff + srcEndX; sx < end; sx++) {
              if ((src32[sx] >>> 24) !== 0) {
                hasNonZero = true;
                break outerZero32;
              }
            }
          }
        } else {
          outerZero8: for (let sy = srcStartY; sy < srcEndY; sy++) {
            let off = (sy * w + srcStartX) << 2;
            const endOff = (sy * w + srcEndX) << 2;
            for (; off < endOff; off += 4) {
              if (srcData[off + 3] !== 0) {
                hasNonZero = true;
                break outerZero8;
              }
            }
          }
        }
        if (!hasNonZero) continue;

        // Snapshot pre-edit tile state before mutating
        if (snapshotOut) {
          const tileKey = getTileKey(layerId, tx, ty, 0);
          if (!snapshotOut.has(tileKey)) {
            snapshotOut.set(tileKey, {
              format: existingTile ? existingTile.format : targetFormat,
              data: existingTile?.data ? new Uint8Array(existingTile.data) : null,
            });
          }
        }

        const tile = existingTile ?? this.getOrCreateTile(layerId, tx, ty, targetFormat, 0);
        if (tile.format !== targetFormat) {
          const prevRGBA = tile.data ? new Uint8Array(this.getTileAsRGBA(tile)) : null;
          if (tile.data !== null) {
            this.memoryManager?.notifyTileFreed(tile);
          }
          tile.format = targetFormat;
          tile.data = new Uint8Array(getTileByteSize(targetFormat));
          if (prevRGBA) {
            if (targetFormat === 'color-32bit') {
              tile.data.set(prevRGBA);
            } else if (targetFormat === 'monochrome-1bit') {
              packRGBATo1Bit(prevRGBA, tile.data, monoThresh);
            } else {
              packRGBATo8Bit(prevRGBA, tile.data);
            }
          }
          this.memoryManager?.notifyTileAllocated(tile);
        } else if (tile.data === null) {
          tile.data = new Uint8Array(getTileByteSize(tile.format));
          this.memoryManager?.notifyTileAllocated(tile);
        }

        const localStartX = destX + srcStartX - tileDocX;
        const copyWidth = srcEndX - srcStartX;

        if (tile.format === 'monochrome-1bit') {
          const dst = tile.data;
          for (let sy = srcStartY; sy < srcEndY; sy++) {
            const tileLocalY = destY + sy - tileDocY;
            const docY = destY + sy;
            const rowByteBase = tileLocalY << 5;
            let srcOff = (sy * w + srcStartX) << 2;
            const selRowValid = hasSelMask && docY >= selBy && docY < selBy + selBh;
            const selRowOff = selRowValid ? (docY - selBy) * selBw : 0;

            for (let dx = 0; dx < copyWidth; dx++, srcOff += 4) {
              const sa = srcData[srcOff + 3];
              if (sa === 0) continue;

              let effA = fullOpacity ? sa : Math.round(sa * opacity);
              if (hasSelMask) {
                const docX = destX + srcStartX + dx;
                if (!selRowValid || docX < selBx || docX >= selBx + selBw) continue;
                const ma = selMask![selRowOff + (docX - selBx)];
                if (ma === 0) continue;
                if (ma < 255) {
                  effA = Math.round((effA * ma) / 255);
                }
              }

              const lx = localStartX + dx;
              const byteIdx = rowByteBase + (lx >> 3);
              const mask = 1 << (7 - (lx & 7));

              if (compositeOp === 'destination-out') {
                if (effA >= 128) {
                  dst[byteIdx] &= ~mask;
                }
              } else if (compositeOp === 'source-atop') {
                if ((dst[byteIdx] & mask) === 0) continue;
                const r = srcData[srcOff];
                const g = srcData[srcOff + 1];
                const b = srcData[srcOff + 2];
                const lum = (19595 * r + 38470 * g + 7471 * b + 32768) >> 16;
                const outLum = (lum * effA) / 255;
                if (outLum < monoThresh && monoExpressBlack) {
                  dst[byteIdx] |= mask;
                } else {
                  dst[byteIdx] &= ~mask;
                }
              } else {
                const hadInk = (dst[byteIdx] & mask) !== 0;
                const r = srcData[srcOff];
                const g = srcData[srcOff + 1];
                const b = srcData[srcOff + 2];
                const lum = (19595 * r + 38470 * g + 7471 * b + 32768) >> 16;
                if (!hadInk) {
                  if (effA >= 128 && lum < monoThresh && monoExpressBlack) {
                    dst[byteIdx] |= mask;
                  }
                } else {
                  const outLum = (lum * effA) / 255;
                  if (outLum >= monoThresh || !monoExpressBlack) {
                    dst[byteIdx] &= ~mask;
                  }
                }
              }
            }
          }
        } else if (tile.format === 'color-32bit') {
          const dst = tile.data;
          for (let sy = srcStartY; sy < srcEndY; sy++) {
            const tileLocalY = destY + sy - tileDocY;
            const docY = destY + sy;
            let srcOff = (sy * w + srcStartX) << 2;
            let dstOff = (tileLocalY * TILE_SIZE + localStartX) << 2;
            const selRowValid = hasSelMask && docY >= selBy && docY < selBy + selBh;
            const selRowOff = selRowValid ? (docY - selBy) * selBw : 0;

            for (let dx = 0; dx < copyWidth; dx++, srcOff += 4, dstOff += 4) {
              const sa = srcData[srcOff + 3];
              if (sa === 0) continue;

              let effA = fullOpacity ? sa : Math.round(sa * opacity);
              if (effA === 0) continue;

              let maskFrac = 1.0;
              if (hasSelMask) {
                const docX = destX + srcStartX + dx;
                if (!selRowValid || docX < selBx || docX >= selBx + selBw) continue;
                const ma = selMask![selRowOff + (docX - selBx)];
                if (ma === 0) continue;
                if (ma < 255) maskFrac = ma / 255;
              }

              const sr = srcData[srcOff];
              const sg = srcData[srcOff + 1];
              const sb = srcData[srcOff + 2];
              const da = dst[dstOff + 3];

              let outR = dst[dstOff];
              let outG = dst[dstOff + 1];
              let outB = dst[dstOff + 2];
              let outA = da;

              if (compositeOp === 'destination-out') {
                if (da === 0) continue;
                if (effA === 255) {
                  outR = 0;
                  outG = 0;
                  outB = 0;
                  outA = 0;
                } else {
                  outA = Math.round(da * (1 - effA / 255));
                  if (outA === 0) {
                    outR = 0;
                    outG = 0;
                    outB = 0;
                  }
                }
              } else if (compositeOp === 'source-atop') {
                if (da === 0) continue;
                if (effA === 255) {
                  outR = sr;
                  outG = sg;
                  outB = sb;
                } else {
                  const sA = effA / 255;
                  const inv = 1 - sA;
                  outR = Math.round(sr * sA + outR * inv);
                  outG = Math.round(sg * sA + outG * inv);
                  outB = Math.round(sb * sA + outB * inv);
                }
              } else {
                if (effA === 255 || da === 0) {
                  outR = sr;
                  outG = sg;
                  outB = sb;
                  outA = effA;
                } else {
                  const sA = effA / 255;
                  const dA = da / 255;
                  const invSA = 1 - sA;
                  const compA = sA + dA * invSA;
                  if (compA > 0) {
                    const invOut = 1 / compA;
                    outR = Math.round((sr * sA + outR * dA * invSA) * invOut);
                    outG = Math.round((sg * sA + outG * dA * invSA) * invOut);
                    outB = Math.round((sb * sA + outB * dA * invSA) * invOut);
                    outA = Math.round(compA * 255);
                  }
                }
              }

              if (maskFrac < 1.0) {
                const invM = 1 - maskFrac;
                const bA = da / 255;
                const aA = outA / 255;
                const mixA = bA * invM + aA * maskFrac;
                if (mixA <= 0.0001) {
                  dst[dstOff] = 0;
                  dst[dstOff + 1] = 0;
                  dst[dstOff + 2] = 0;
                  dst[dstOff + 3] = 0;
                } else {
                  const invMixA = 1 / mixA;
                  dst[dstOff] = Math.round((dst[dstOff] * bA * invM + outR * aA * maskFrac) * invMixA);
                  dst[dstOff + 1] = Math.round((dst[dstOff + 1] * bA * invM + outG * aA * maskFrac) * invMixA);
                  dst[dstOff + 2] = Math.round((dst[dstOff + 2] * bA * invM + outB * aA * maskFrac) * invMixA);
                  dst[dstOff + 3] = Math.round(mixA * 255);
                }
              } else {
                dst[dstOff] = outR;
                dst[dstOff + 1] = outG;
                dst[dstOff + 2] = outB;
                dst[dstOff + 3] = outA;
              }
            }
          }
        } else {
          // grayscale-8bit fallback
          const tileScratch = this.writeScratchRGBA;
          unpack8BitToRGBA(tile.data, tileScratch);
          for (let sy = srcStartY; sy < srcEndY; sy++) {
            const tileLocalY = destY + sy - tileDocY;
            let srcOff = (sy * w + srcStartX) << 2;
            let dstOff = (tileLocalY * TILE_SIZE + localStartX) << 2;
            for (let dx = 0; dx < copyWidth; dx++, srcOff += 4, dstOff += 4) {
              const sa = srcData[srcOff + 3];
              if (sa === 0) continue;
              const effA = fullOpacity ? sa : Math.round(sa * opacity);
              if (compositeOp === 'destination-out') {
                tileScratch[dstOff + 3] = Math.round(tileScratch[dstOff + 3] * (1 - effA / 255));
              } else if (effA > 0) {
                const sA = effA / 255;
                const inv = 1 - sA;
                tileScratch[dstOff] = Math.round(srcData[srcOff] * sA + tileScratch[dstOff] * inv);
                tileScratch[dstOff + 1] = Math.round(srcData[srcOff + 1] * sA + tileScratch[dstOff + 1] * inv);
                tileScratch[dstOff + 2] = Math.round(srcData[srcOff + 2] * sA + tileScratch[dstOff + 2] * inv);
                tileScratch[dstOff + 3] = Math.min(255, Math.round(tileScratch[dstOff + 3] * inv + effA));
              }
            }
          }
          packRGBATo8Bit(tileScratch, tile.data);
        }

        tile.solidColorU32 = undefined;
        tile.dirty = true;
        tile.version++;
        this.markLodAncestorsDirty(layerId, tx, ty);
        anyModified = true;
      }
    }

    if (anyModified) {
      this.bumpLayerVersion(layerId);
      if (!suppressNotify) {
        this.notifyChange();
      }
    }
    return anyModified;
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
   * Populates a temporary (or caller-supplied pooled) HTMLCanvasElement strictly sized to `rect` from tiles.
   * When `targetCanvas` is omitted, caller must release the returned canvas via `releaseTemporaryCanvas(canvas)`.
   */
  public createRegionCanvas(
    layerId: string,
    rect: { x: number; y: number; width: number; height: number },
    targetCanvas?: HTMLCanvasElement | null
  ): HTMLCanvasElement | null {
    if (typeof document === 'undefined' || rect.width <= 0 || rect.height <= 0) return null;
    const w = Math.max(1, Math.ceil(rect.width));
    const h = Math.max(1, Math.ceil(rect.height));
    const canvas = targetCanvas || document.createElement('canvas');
    const resized = canvas.width !== w || canvas.height !== h;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return canvas;
    if (!resized) {
      ctx.clearRect(0, 0, w, h);
    }

    if (this.hasLayerTiles(layerId) && typeof ImageData !== 'undefined') {
      const originX = Math.floor(rect.x);
      const originY = Math.floor(rect.y);
      const minTileX = pixelToTileCoord(originX, 0);
      const minTileY = pixelToTileCoord(originY, 0);
      const maxTileX = pixelToTileCoord(originX + w - 1, 0);
      const maxTileY = pixelToTileCoord(originY + h - 1, 0);

      for (let ty = minTileY; ty <= maxTileY; ty++) {
        const tileDocY = ty * TILE_SIZE;
        const interStartY = Math.max(originY, tileDocY);
        const interEndY = Math.min(originY + h, tileDocY + TILE_SIZE);
        const dirtyH = interEndY - interStartY;
        if (dirtyH <= 0) continue;
        const dirtyY = interStartY - tileDocY;

        for (let tx = minTileX; tx <= maxTileX; tx++) {
          const tile = this.getTile(layerId, tx, ty, 0);
          if (!tile) continue;

          const tileDocX = tx * TILE_SIZE;
          const interStartX = Math.max(originX, tileDocX);
          const interEndX = Math.min(originX + w, tileDocX + TILE_SIZE);
          const dirtyW = interEndX - interStartX;
          if (dirtyW <= 0) continue;
          const dirtyX = interStartX - tileDocX;

          const rgba = this.getTileAsRGBA(tile);
          const clamped = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, BYTES_32BIT);
          const imgData = new ImageData(clamped, TILE_SIZE, TILE_SIZE);
          ctx.putImageData(
            imgData,
            tileDocX - originX,
            tileDocY - originY,
            dirtyX,
            dirtyY,
            dirtyW,
            dirtyH
          );
        }
      }
    }
    return canvas;
  }

  /**
   * Materializes a full-layer temporary HTMLCanvasElement from tiles (for export/filters).
   * Caller MUST release it immediately after use via `releaseTemporaryCanvas(canvas)`.
   */
  public exportLayerToCanvas(layerId: string, width: number, height: number): HTMLCanvasElement | null {
    if (typeof document === 'undefined' || width <= 0 || height <= 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    if (this.hasLayerTiles(layerId)) {
      this.renderLayerToCanvas(layerId, canvas);
    }
    return canvas;
  }

  /**
   * Ensures mipmap tiles at `targetLod` (0..3) exist and are up-to-date for all populated regions of `layerId`.
   */
  public getOrBuildLodTiles(layerId: string, targetLod: number): TileBuffer[] {
    const lod = Math.max(0, Math.min(3, Math.floor(targetLod)));
    if (lod === 0) {
      return this.getLayerTiles(layerId);
    }

    const occ = this.layerLodOccupancy.get(layerId);
    const lodOccMap = occ ? occ[lod - 1] : null;
    if (!lodOccMap || lodOccMap.size === 0) {
      return this.getLayerTiles(layerId, lod);
    }

    const result: TileBuffer[] = [];
    for (const packed of lodOccMap.keys()) {
      const tx = unpackTileCoordX(packed);
      const ty = unpackTileCoordY(packed);
      let tile = this.getTile(layerId, tx, ty, lod);
      if (!tile || tile.data === null || this.isLodTileDirty(layerId, tx, ty, lod)) {
        tile = this.generateLodTile(layerId, tx, ty, lod);
      }
      if (tile && tile.data !== null) {
        result.push(tile);
      }
    }
    return result;
  }

  /**
   * Ensures LOD 3 mipmap tiles exist and are up-to-date for all populated regions of `layerId`.
   */
  public getOrBuildLod3Tiles(layerId: string): TileBuffer[] {
    return this.getOrBuildLodTiles(layerId, 3);
  }

  /**
   * Generates a layer thumbnail directly from LOD 3 mipmap tiles (1/8 resolution: 2048px per tile).
   * Completely bypasses full-size canvas allocation and full-resolution pixel reads.
   */
  public generateThumbnail(
    layerId: string,
    thumbWidth: number,
    thumbHeight: number,
    docDimensions: { width: number; height: number },
    preserveAlpha: boolean = true
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

    const docW = Math.max(1, docDimensions.width);
    const docH = Math.max(1, docDimensions.height);

    const tiles = this.getOrBuildLod3Tiles(layerId);

    if (tiles.length === 0) {
      if (preserveAlpha) {
        ctx.clearRect(0, 0, thumbWidth, thumbHeight);
        return canvas.toDataURL('image/png');
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, thumbWidth, thumbHeight);
      return canvas.toDataURL('image/jpeg', 0.65);
    }

    const renderLod = 3;
    const lodDocSize = TILE_SIZE << renderLod; // 2048 document pixels per LOD 3 tile
    const thumbImg = ctx.createImageData(thumbWidth, thumbHeight);
    const outData = thumbImg.data;
    if (!preserveAlpha) {
      outData.fill(255);
    }
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

          const sa = rgba[srcIdx + 3];
          if (sa > 0) {
            const dstIdx = (py * thumbWidth + px) * 4;
            if (preserveAlpha || sa === 255) {
              outData[dstIdx] = rgba[srcIdx];
              outData[dstIdx + 1] = rgba[srcIdx + 1];
              outData[dstIdx + 2] = rgba[srcIdx + 2];
              outData[dstIdx + 3] = sa;
            } else {
              const a = sa / 255;
              const inv = 1 - a;
              outData[dstIdx] = Math.round(rgba[srcIdx] * a + 255 * inv);
              outData[dstIdx + 1] = Math.round(rgba[srcIdx + 1] * a + 255 * inv);
              outData[dstIdx + 2] = Math.round(rgba[srcIdx + 2] * a + 255 * inv);
              outData[dstIdx + 3] = 255;
            }
          }
        }
      }
    }

    ctx.putImageData(thumbImg, 0, 0);
    return preserveAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.65);
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

    const key = getTileKey(layerId, lodTx, lodTy, targetLod);

    // O(1) empty-region fast-out: if no LOD 0 tile exists anywhere under this LOD node,
    // never recurse or allocate a temporary 256KB TileBuffer.
    if (!this.hasPopulatedLodTile(layerId, lodTx, lodTy, targetLod)) {
      const stale = this.tiles.get(key);
      if (stale) {
        this.memoryManager?.notifyTileFreed(stale);
        this.tiles.delete(key);
      }
      this.dirtyLodTiles.delete(key);
      return null;
    }

    const childLod = targetLod - 1;
    const cX0 = lodTx << 1;
    const cY0 = lodTy << 1;

    let c00 = this.getTile(layerId, cX0, cY0, childLod);
    let c10 = this.getTile(layerId, cX0 + 1, cY0, childLod);
    let c01 = this.getTile(layerId, cX0, cY0 + 1, childLod);
    let c11 = this.getTile(layerId, cX0 + 1, cY0 + 1, childLod);

    if (childLod > 0) {
      if (this.hasPopulatedLodTile(layerId, cX0, cY0, childLod)) {
        if (!c00 || c00.data === null || this.isLodTileDirty(layerId, cX0, cY0, childLod)) {
          c00 = this.generateLodTile(layerId, cX0, cY0, childLod);
        }
      } else {
        c00 = null;
      }
      if (this.hasPopulatedLodTile(layerId, cX0 + 1, cY0, childLod)) {
        if (!c10 || c10.data === null || this.isLodTileDirty(layerId, cX0 + 1, cY0, childLod)) {
          c10 = this.generateLodTile(layerId, cX0 + 1, cY0, childLod);
        }
      } else {
        c10 = null;
      }
      if (this.hasPopulatedLodTile(layerId, cX0, cY0 + 1, childLod)) {
        if (!c01 || c01.data === null || this.isLodTileDirty(layerId, cX0, cY0 + 1, childLod)) {
          c01 = this.generateLodTile(layerId, cX0, cY0 + 1, childLod);
        }
      } else {
        c01 = null;
      }
      if (this.hasPopulatedLodTile(layerId, cX0 + 1, cY0 + 1, childLod)) {
        if (!c11 || c11.data === null || this.isLodTileDirty(layerId, cX0 + 1, cY0 + 1, childLod)) {
          c11 = this.generateLodTile(layerId, cX0 + 1, cY0 + 1, childLod);
        }
      } else {
        c11 = null;
      }
    }

    const firstChild =
      (c00 && c00.data !== null ? c00 : null) ||
      (c10 && c10.data !== null ? c10 : null) ||
      (c01 && c01.data !== null ? c01 : null) ||
      (c11 && c11.data !== null ? c11 : null);

    let tile = this.tiles.get(key);
    if (!firstChild) {
      if (tile) {
        this.memoryManager?.notifyTileFreed(tile);
        this.tiles.delete(key);
      }
      this.dirtyLodTiles.delete(key);
      return null;
    }

    // Ephemeral display LOD > 0 tiles for monochrome-1bit layers use box-filtered color-32bit
    // coverage instead of bitwise-OR dilation so zoomed-out lines match live mipmapped drafts.
    const format: TileFormat =
      firstChild.format === 'monochrome-1bit' ? 'color-32bit' : firstChild.format;

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

  public fillLayerSolidColor(
    layerId: string,
    width: number,
    height: number,
    colorCss: string,
    format?: TileFormat
  ): void {
    const lower = (colorCss || '').trim().toLowerCase();
    if (!lower || lower === 'transparent') {
      this.clearLayer(layerId);
      this.ingestedLayers.add(layerId);
      if (format) this.setLayerFormat(layerId, format);
      return;
    }
    if (lower === '#ffffff' || lower === '#fff' || lower === 'white') {
      this.fillLayerSolidWhite(layerId, width, height, format);
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
          a = parseInt(hex.slice(6, 8), 16) || 255;
        }
      }
    } else if (lower === 'black') {
      r = 0; g = 0; b = 0;
    }

    this.clearLayer(layerId);
    this.ingestedLayers.add(layerId);
    if (format) this.setLayerFormat(layerId, format);
    if (width <= 0 || height <= 0) return;

    const targetFormat = format || this.getLayerFormat(layerId);
    const pixelU32 = isLittleEndian
      ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
      : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    const grayVal = Math.round((r * 299 + g * 587 + b * 114) / 1000);
    const isInk1Bit = a >= 24 && grayVal < 128;

    if (targetFormat === 'monochrome-1bit' && !isInk1Bit) {
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
        tile.version++;
        this.markLodAncestorsDirty(layerId, tx, ty);
      }
    }
    this.bumpLayerVersion(layerId);
    this.notifyChange();
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
    this.layerLod0Tiles.delete(layerId);
    this.layerLodOccupancy.delete(layerId);
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
        solidColorU32: srcTile.solidColorU32,
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

  public snapshotLayerTiles(
    layerId: string
  ): Map<string, { format: TileFormat; data: Uint8Array | null }> {
    const snapshot = new Map<string, { format: TileFormat; data: Uint8Array | null }>();
    for (const tile of this.getLayerTiles(layerId, 0)) {
      const key = getTileKey(layerId, tile.tileX, tile.tileY, 0);
      if (tile.data) {
        const copy = new Uint8Array(tile.data.length);
        copy.set(tile.data);
        snapshot.set(key, { format: tile.format, data: copy });
      } else {
        snapshot.set(key, { format: tile.format, data: null });
      }
    }
    return snapshot;
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
      const currentData = currentTile && currentTile.data ? currentTile.data : null;
      const format = currentTile ? currentTile.format : (before ? before.format : this.getLayerFormat(layerId));

      if (beforeData === null && currentData === null) continue;

      let changed = false;
      if ((beforeData === null) !== (currentData === null)) {
        changed = true;
      } else if (beforeData && currentData) {
        if (beforeData.byteLength !== currentData.byteLength) {
          changed = true;
        } else if (
          beforeData.byteLength % 4 === 0 &&
          beforeData.byteOffset % 4 === 0 &&
          currentData.byteOffset % 4 === 0
        ) {
          const len32 = beforeData.byteLength >>> 2;
          const b32 = new Uint32Array(beforeData.buffer, beforeData.byteOffset, len32);
          const c32 = new Uint32Array(currentData.buffer, currentData.byteOffset, len32);
          for (let i = 0; i < len32; i++) {
            if (b32[i] !== c32[i]) {
              changed = true;
              break;
            }
          }
        } else {
          for (let i = 0; i < beforeData.byteLength; i++) {
            if (beforeData[i] !== currentData[i]) {
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
          afterData: currentData ? new Uint8Array(currentData) : null,
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
        tile.solidColorU32 = undefined;
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
    this.layerLod0Tiles.clear();
    this.layerLodOccupancy.clear();
    this.layerFormats.clear();
    this.ingestedLayers.clear();
    this.dirtyLodTiles.clear();
    this.layerVersions.clear();
    this.gridEpoch++;
    this.contentVersion++;
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
      if ((tile.lod ?? 0) === 0) {
        this.registerLod0Tile(tile);
      }
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
