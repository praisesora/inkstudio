/**
 * Binary snapshot serialization (INKG v1) and TileDelta serialization (TD v1)
 * with both synchronous and time-sliced asynchronous codecs.
 */

import type { TileDelta } from '../../types/editor';
import { yieldToMain } from '../asyncCompression';
import type { SparseTileGrid } from '../tileEngine';
import type { TileBuffer, TileFormat } from './types';

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

const _sharedTileEncoder = new TextEncoder();

function encodeLayerIdCached(cache: Map<string, Uint8Array>, layerId: string): Uint8Array {
  let bytes = cache.get(layerId);
  if (!bytes) {
    bytes = _sharedTileEncoder.encode(layerId);
    cache.set(layerId, bytes);
  }
  return bytes;
}

export function serializeSparseTileGrid(grid: SparseTileGrid): Uint8Array {
  const layerKeyCache = new Map<string, Uint8Array>();
  const layerFormats = grid.getAllLayerFormats();

  let totalBytes = 4 + 1 + 4;

  const encodedFormats: Array<{ keyBytes: Uint8Array; format: TileFormat }> = [];
  for (const [layerId, fmt] of layerFormats.entries()) {
    const keyBytes = encodeLayerIdCached(layerKeyCache, layerId);
    encodedFormats.push({ keyBytes, format: fmt });
    totalBytes += 2 + keyBytes.length + 1;
  }

  totalBytes += 4;

  const encodedTiles: Array<{ keyBytes: Uint8Array; tile: TileBuffer; data: Uint8Array | null }> = [];
  for (const t of grid.tilesIterable()) {
    if ((t.lod ?? 0) !== 0) continue;
    const keyBytes = encodeLayerIdCached(layerKeyCache, t.layerId);
    const data = t.data;
    encodedTiles.push({ keyBytes, tile: t, data });
    const dataLen = data ? data.byteLength : 0;
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

    const data = item.data;
    const dataLen = data ? data.byteLength : 0;
    view.setUint32(offset, dataLen, true);
    offset += 4;
    if (data) {
      out.set(data, offset);
      offset += dataLen;
    }
  }

  return out;
}

/**
 * Time-sliced asynchronous SparseTileGrid serializer for background recovery checkpoints.
 * Yields to the browser event loop every ~4ms and supports cooperative cancellation
 * if the user resumes drawing mid-snapshot. Produces identical INKG v1 output.
 */
export async function serializeSparseTileGridAsync(
  grid: SparseTileGrid,
  options?: { shouldAbort?: () => boolean; chunkBudgetMs?: number }
): Promise<Uint8Array | null> {
  if (options?.shouldAbort?.()) return null;

  const budgetMs = options?.chunkBudgetMs ?? 4;
  const layerKeyCache = new Map<string, Uint8Array>();
  const layerFormats = grid.getAllLayerFormats();

  let totalBytes = 4 + 1 + 4;

  const encodedFormats: Array<{ keyBytes: Uint8Array; format: TileFormat }> = [];
  for (const [layerId, fmt] of layerFormats.entries()) {
    const keyBytes = encodeLayerIdCached(layerKeyCache, layerId);
    encodedFormats.push({ keyBytes, format: fmt });
    totalBytes += 2 + keyBytes.length + 1;
  }

  totalBytes += 4;

  // Capture immutable per-tile references (data ref + metadata) before yielding
  const encodedTiles: Array<{
    keyBytes: Uint8Array;
    tileX: number;
    tileY: number;
    formatByte: number;
    version: number;
    data: Uint8Array | null;
  }> = [];

  for (const t of grid.tilesIterable()) {
    if ((t.lod ?? 0) !== 0) continue;
    const keyBytes = encodeLayerIdCached(layerKeyCache, t.layerId);
    const data = t.data;
    encodedTiles.push({
      keyBytes,
      tileX: t.tileX,
      tileY: t.tileY,
      formatByte: FORMAT_TO_BYTE[t.format] ?? 2,
      version: t.version,
      data,
    });
    const dataLen = data ? data.byteLength : 0;
    totalBytes += 2 + keyBytes.length + 4 + 4 + 1 + 4 + 4 + dataLen;
  }

  if (options?.shouldAbort?.()) return null;

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

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let sliceStart = now();

  for (let i = 0; i < encodedTiles.length; i++) {
    const item = encodedTiles[i];
    view.setUint16(offset, item.keyBytes.length, true);
    offset += 2;
    out.set(item.keyBytes, offset);
    offset += item.keyBytes.length;

    view.setInt32(offset, item.tileX, true);
    offset += 4;
    view.setInt32(offset, item.tileY, true);
    offset += 4;
    out[offset++] = item.formatByte;
    view.setUint32(offset, item.version, true);
    offset += 4;

    const dataLen = item.data ? item.data.byteLength : 0;
    view.setUint32(offset, dataLen, true);
    offset += 4;
    if (item.data) {
      out.set(item.data, offset);
      offset += dataLen;
    }

    if ((i & 15) === 15 && i + 1 < encodedTiles.length && now() - sliceStart >= budgetMs) {
      await yieldToMain();
      if (options?.shouldAbort?.()) return null;
      sliceStart = now();
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
  let totalBytes = 2 + 1 + 4;
  const encodedKeys: Uint8Array[] = new Array(deltas.length);

  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    const keyBytes = _sharedTileEncoder.encode(d.key);
    encodedKeys[i] = keyBytes;

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

/**
 * Time-sliced asynchronous TileDelta serializer for large multi-tile operations
 * (full-canvas fills, filters, transforms, clears). Yields every ~4ms so UI stays responsive.
 */
export async function serializeTileDeltasAsync(
  deltas: TileDelta[],
  chunkBudgetMs: number = 4
): Promise<Uint8Array> {
  if (deltas.length <= 16) {
    return serializeTileDeltas(deltas);
  }

  let totalBytes = 2 + 1 + 4;
  const encodedKeys: Uint8Array[] = new Array(deltas.length);

  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i];
    const keyBytes = _sharedTileEncoder.encode(d.key);
    encodedKeys[i] = keyBytes;

    totalBytes += 2 + keyBytes.length + 1 + 1 + 1;
    if (d.beforeData && d.beforeData.byteLength > 0) {
      totalBytes += 4 + d.beforeData.byteLength;
    }
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

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let sliceStart = now();

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

    if ((i & 7) === 7 && i + 1 < deltas.length && now() - sliceStart >= chunkBudgetMs) {
      await yieldToMain();
      sliceStart = now();
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
