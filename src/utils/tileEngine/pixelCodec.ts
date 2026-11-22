/**
 * Multi-format pixel packing/unpacking (1-bit, 8-bit, 32-bit RGBA)
 * and LZ4-compressed single-tile binary packet serialization.
 */

import { lz4CompressBlock, lz4DecompressBlock } from '../lz4';
import {
  compressTilesLz4BatchNative,
  decompressTilesLz4BatchNative,
  isNativeRustAvailable,
} from '../nativeBackend';
import {
  BYTES_1BIT,
  BYTES_32BIT,
  INK_BLACK_U32,
  PAPER_WHITE_U32,
  TILE_PIXELS,
  TILE_SIZE,
  TRANSPARENT_U32,
  TileBuffer,
  TileFormat,
  createTileBuffer,
  getTileByteSize,
  isLittleEndian,
} from './types';

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

export const TILE_CODEC_EMPTY = 0;
export const TILE_CODEC_RAW = 1;
export const TILE_CODEC_LZ4 = 2;
const TILE_PACKET_HEADER_BYTES = 14;

/**
 * Serializes a single tile into a compact LZ4-compressed binary packet:
 * [tileX: i32][tileY: i32][formatCode: u8][version: u32][codec: u8][payload...]
 * Empty/deleted tiles (tile.data === null) serialize to a 14-byte tombstone (codec = 0).
 */
export function serializeTileBuffer(tile: TileBuffer): Uint8Array {
  const formatCode =
    tile.format === 'monochrome-1bit' ? 1 : tile.format === 'grayscale-8bit' ? 2 : 4;

  if (tile.data === null) {
    const packet = new Uint8Array(TILE_PACKET_HEADER_BYTES);
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    view.setInt32(0, tile.tileX, true);
    view.setInt32(4, tile.tileY, true);
    view.setUint8(8, formatCode);
    view.setUint32(9, tile.version, true);
    view.setUint8(13, TILE_CODEC_EMPTY);
    return packet;
  }

  const expectedLen = getTileByteSize(tile.format);
  const rawBytes =
    tile.data.byteLength === expectedLen ? tile.data : new Uint8Array(expectedLen);
  const compressed = lz4CompressBlock(rawBytes);

  // Use LZ4 whenever it does not exceed raw size; otherwise raw fallback prevents expansion on noise
  const useLz4 = compressed.byteLength <= rawBytes.byteLength;
  const payload = useLz4 ? compressed : rawBytes;
  const codec = useLz4 ? TILE_CODEC_LZ4 : TILE_CODEC_RAW;

  const packet = new Uint8Array(TILE_PACKET_HEADER_BYTES + payload.byteLength);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  view.setInt32(0, tile.tileX, true);
  view.setInt32(4, tile.tileY, true);
  view.setUint8(8, formatCode);
  view.setUint32(9, tile.version, true);
  view.setUint8(13, codec);
  packet.set(payload, TILE_PACKET_HEADER_BYTES);

  return packet;
}

/**
 * Strictly validates and deserializes an LZ4-compressed tile packet.
 * Returns null on malformed headers, unsupported codecs, or corrupt LZ4 streams.
 */
export function deserializeTileBufferStrict(
  layerId: string,
  packet: Uint8Array
): TileBuffer | null {
  if (!packet || packet.byteLength < TILE_PACKET_HEADER_BYTES) {
    return null;
  }
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const tileX = view.getInt32(0, true);
  const tileY = view.getInt32(4, true);
  const formatCode = view.getUint8(8);
  const version = view.getUint32(9, true);
  const codec = view.getUint8(13);

  let format: TileFormat;
  if (formatCode === 1) {
    format = 'monochrome-1bit';
  } else if (formatCode === 2) {
    format = 'grayscale-8bit';
  } else if (formatCode === 4) {
    format = 'color-32bit';
  } else {
    return null;
  }

  const expectedLen = getTileByteSize(format);
  const payload = packet.subarray(TILE_PACKET_HEADER_BYTES);
  let data: Uint8Array | null;

  if (codec === TILE_CODEC_EMPTY) {
    if (payload.byteLength !== 0) return null;
    data = null;
  } else if (codec === TILE_CODEC_LZ4) {
    data = lz4DecompressBlock(payload, expectedLen, BYTES_32BIT);
    if (!data) return null;
  } else if (codec === TILE_CODEC_RAW) {
    if (payload.byteLength !== expectedLen) return null;
    data = new Uint8Array(expectedLen);
    data.set(payload);
  } else {
    return null;
  }

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

export function deserializeTileBuffer(layerId: string, packet: Uint8Array): TileBuffer {
  return (
    deserializeTileBufferStrict(layerId, packet) ??
    createTileBuffer(layerId, 0, 0, 'color-32bit', 0)
  );
}

/**
 * Parallel batch tile serialization via Rust Rayon + LZ4 when in Tauri,
 * falling back to synchronous JS compression outside Tauri.
 */
export async function serializeTileBatchAsync(tiles: TileBuffer[]): Promise<Uint8Array[]> {
  if (tiles.length === 0) return [];
  if (!isNativeRustAvailable() || tiles.length < 2) {
    return tiles.map(serializeTileBuffer);
  }

  const nonEmptyIndices: number[] = [];
  const rawPayloads: Uint8Array[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (t.data !== null) {
      const expectedLen = getTileByteSize(t.format);
      nonEmptyIndices.push(i);
      rawPayloads.push(t.data.byteLength === expectedLen ? t.data : new Uint8Array(expectedLen));
    }
  }

  const compressed =
    rawPayloads.length > 0 ? await compressTilesLz4BatchNative(rawPayloads) : [];
  const out: Uint8Array[] = new Array(tiles.length);
  let compCursor = 0;

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const formatCode =
      tile.format === 'monochrome-1bit' ? 1 : tile.format === 'grayscale-8bit' ? 2 : 4;
    if (tile.data === null) {
      const packet = new Uint8Array(TILE_PACKET_HEADER_BYTES);
      const view = new DataView(packet.buffer);
      view.setInt32(0, tile.tileX, true);
      view.setInt32(4, tile.tileY, true);
      view.setUint8(8, formatCode);
      view.setUint32(9, tile.version, true);
      view.setUint8(13, TILE_CODEC_EMPTY);
      out[i] = packet;
    } else {
      const entry = compressed[compCursor++];
      const packet = new Uint8Array(TILE_PACKET_HEADER_BYTES + entry.data.byteLength);
      const view = new DataView(packet.buffer);
      view.setInt32(0, tile.tileX, true);
      view.setInt32(4, tile.tileY, true);
      view.setUint8(8, formatCode);
      view.setUint32(9, tile.version, true);
      view.setUint8(13, entry.codec);
      packet.set(entry.data, TILE_PACKET_HEADER_BYTES);
      out[i] = packet;
    }
  }
  return out;
}

/**
 * Parallel batch tile deserialization via Rust Rayon + LZ4 when in Tauri.
 */
export async function deserializeTileBatchAsync(
  layerId: string,
  packets: Uint8Array[]
): Promise<Array<TileBuffer | null>> {
  if (packets.length === 0) return [];
  if (!isNativeRustAvailable() || packets.length < 2) {
    return packets.map((p) => deserializeTileBufferStrict(layerId, p));
  }

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const results: Array<TileBuffer | null> = new Array(packets.length).fill(null);
  const batchMeta: Array<{
    idx: number;
    tileX: number;
    tileY: number;
    format: TileFormat;
    version: number;
  }> = [];
  const batchItems: Array<{ codec: number; expectedLen: number; data: Uint8Array }> = [];

  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i];
    if (!packet || packet.byteLength < TILE_PACKET_HEADER_BYTES) continue;
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const tileX = view.getInt32(0, true);
    const tileY = view.getInt32(4, true);
    const formatCode = view.getUint8(8);
    const version = view.getUint32(9, true);
    const codec = view.getUint8(13);

    const format: TileFormat | null =
      formatCode === 1
        ? 'monochrome-1bit'
        : formatCode === 2
          ? 'grayscale-8bit'
          : formatCode === 4
            ? 'color-32bit'
            : null;
    if (!format) continue;

    const payload = packet.subarray(TILE_PACKET_HEADER_BYTES);
    if (codec === TILE_CODEC_EMPTY) {
      if (payload.byteLength === 0) {
        results[i] = {
          layerId,
          tileX,
          tileY,
          format,
          data: null,
          dirty: true,
          version,
          isPagedToDisk: false,
          lastAccessTimestamp: now,
          lod: 0,
        };
      }
      continue;
    }

    if (codec === TILE_CODEC_RAW || codec === TILE_CODEC_LZ4) {
      batchMeta.push({ idx: i, tileX, tileY, format, version });
      batchItems.push({ codec, expectedLen: getTileByteSize(format), data: payload });
    }
  }

  if (batchItems.length > 0) {
    const decoded = await decompressTilesLz4BatchNative(batchItems);
    for (let k = 0; k < batchMeta.length; k++) {
      const m = batchMeta[k];
      results[m.idx] = {
        layerId,
        tileX: m.tileX,
        tileY: m.tileY,
        format: m.format,
        data: decoded[k],
        dirty: true,
        version: m.version,
        isPagedToDisk: false,
        lastAccessTimestamp: now,
        lod: 0,
      };
    }
  }

  return results;
}
