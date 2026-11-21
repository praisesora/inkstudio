import initSqlJs, { Database, SqlValue } from 'sql.js';
import { Unzlib, inflateSync } from 'fflate';
import {
  BlendMode,
  CanvasColorMode,
  LayerItem,
  LoadedDocument,
} from '../types/editor';
import { createCanvasThumbnail } from './canvasUtils';
import { SparseTileGrid, TILE_SIZE, TILE_PIXELS } from './tileEngine';

const MAX_CANVAS_DIM = 32768;
const MAX_BLOCKS_PER_LAYER = 16384; // 128x128 tiles = 32768x32768 px
const MAX_COMPRESSED_TILE_BYTES = 2 * 1024 * 1024;
const MAX_DECOMPRESSED_TILE_BYTES = 2 * 1024 * 1024;
const MAX_FOLDER_DEPTH = 64;
const MAX_LAYERS = 4096;

const SQLITE_SIG = new Uint8Array([
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);

function encodeUtf16BeTagged(ascii: string): Uint8Array {
  const out = new Uint8Array(4 + ascii.length * 2);
  const view = new DataView(out.buffer);
  view.setUint32(0, ascii.length, false);
  for (let i = 0; i < ascii.length; i++) {
    out[4 + i * 2] = 0;
    out[4 + i * 2 + 1] = ascii.charCodeAt(i) & 0xff;
  }
  return out;
}

const TAG_BLOCK_BEGIN = encodeUtf16BeTagged('BlockDataBeginChunk');
const TAG_BLOCK_END = encodeUtf16BeTagged('BlockDataEndChunk');
const TAG_PARAMETER = encodeUtf16BeTagged('Parameter');
const TAG_INIT_COLOR = encodeUtf16BeTagged('InitColor');

let sqlJsPromise: Promise<Awaited<ReturnType<typeof initSqlJs>>> | null = null;

async function getSql() {
  if (!sqlJsPromise) {
    const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
    sqlJsPromise = initSqlJs(
      isBrowser ? { locateFile: () => '/sql-wasm.wasm' } : undefined
    ).catch((err) => {
      sqlJsPromise = null;
      throw err;
    });
  }
  return await sqlJsPromise;
}

/**
 * Maps Clip Studio Paint LayerComposite integer to Ink Studio BlendMode.
 * Reference: CSP internal composite mode enum (0..36).
 */
export function mapCspBlendMode(val: number): BlendMode {
  switch (val) {
    case 0:
      return 'normal';
    case 1:
      return 'darken';
    case 2:
      return 'multiply';
    case 3:
      return 'color-burn';
    case 4:
      return 'linear-burn';
    case 5:
      return 'difference'; // Subtract
    case 6:
      return 'darken'; // Darker Color
    case 7:
      return 'lighten';
    case 8:
      return 'screen';
    case 9:
      return 'color-dodge';
    case 10:
      return 'color-dodge-glow'; // Glow Dodge
    case 11:
      return 'add-glow'; // Add (Linear Dodge)
    case 12:
      return 'add-glow'; // Add (Glow)
    case 13:
      return 'lighten'; // Lighter Color
    case 14:
      return 'overlay';
    case 15:
      return 'soft-light';
    case 16:
    case 17: // Vivid Light
    case 18: // Linear Light
    case 19: // Pin Light
    case 20: // Hard Mix
      return 'hard-light';
    case 21:
      return 'difference';
    case 22:
      return 'exclusion';
    case 30:
      return 'pass-through'; // Through (folder)
    case 36:
      return 'divide';
    default:
      return 'normal';
  }
}

function readU64BE(view: DataView, offset: number): number {
  if (offset < 0 || offset + 8 > view.byteLength) return -1;
  const hi = view.getUint32(offset, false);
  const lo = view.getUint32(offset + 4, false);
  if (hi > 0x1fffff) return -1; // exceeds MAX_SAFE_INTEGER
  return hi * 0x100000000 + lo;
}

function readAscii(bytes: Uint8Array, start: number, len: number): string {
  let out = '';
  const end = Math.min(bytes.length, start + len);
  for (let i = start; i < end; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, fromIndex: number = 0): number {
  const nLen = needle.length;
  const limit = haystack.length - nLen;
  if (nLen === 0 || fromIndex > limit) return -1;
  const first = needle[0];
  let idx = fromIndex;
  while (idx <= limit) {
    idx = haystack.indexOf(first, idx);
    if (idx === -1 || idx > limit) return -1;
    let match = true;
    for (let j = 1; j < nLen; j++) {
      if (haystack[idx + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return idx;
    idx++;
  }
  return -1;
}

function isZlibHeader(b0: number, b1: number): boolean {
  if (b0 !== 0x78) return false;
  return b1 === 0x01 || b1 === 0x5e || b1 === 0x9c || b1 === 0xda;
}

/**
 * Bounded zlib decompression immune to zip bombs.
 */
function safeUnzlib(src: Uint8Array, maxOutBytes: number = MAX_DECOMPRESSED_TILE_BYTES): Uint8Array | null {
  if (src.byteLength < 6 || src.byteLength > MAX_COMPRESSED_TILE_BYTES) return null;
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let exceeded = false;
    const stream = new Unzlib((chunk) => {
      total += chunk.byteLength;
      if (total > maxOutBytes) {
        exceeded = true;
        throw new Error('Decompressed tile exceeds safety cap');
      }
      chunks.push(chunk);
    });
    stream.push(src, true);
    if (exceeded || total === 0) return null;
    if (chunks.length === 1) return chunks[0];
    const merged = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      merged.set(c, pos);
      pos += c.byteLength;
    }
    return merged;
  } catch {
    // Fallback for raw deflate streams lacking valid adler32 trailer
    if (src.byteLength > 2 && isZlibHeader(src[0], src[1])) {
      try {
        const raw = inflateSync(src.subarray(2));
        if (raw.byteLength > 0 && raw.byteLength <= maxOutBytes) return raw;
      } catch {
        // invalid stream
      }
    }
    return null;
  }
}

export interface CspChunk {
  name: string;
  data: Uint8Array;
}

/**
 * Parses top-level CSFCHUNK binary container without copying payloads.
 */
export function parseCspChunks(buffer: Uint8Array): CspChunk[] {
  const chunks: CspChunk[] = [];
  if (buffer.length < 24) return chunks;
  if (readAscii(buffer, 0, 8) !== 'CSFCHUNK') return chunks;

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 24;

  while (offset + 16 <= buffer.length) {
    if (readAscii(buffer, offset, 4) !== 'CHNK') break;
    const chunkName = readAscii(buffer, offset + 4, 4);
    const chunkSize = readU64BE(view, offset + 8);
    if (chunkSize < 0) break;

    const dataStart = offset + 16;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > buffer.length) break;

    chunks.push({
      name: chunkName,
      data: buffer.subarray(dataStart, dataEnd),
    });

    offset = dataEnd;
    if (chunkName === 'Foot') break;
  }

  return chunks;
}

function findSqliteData(chunks: CspChunk[], rawBuffer: Uint8Array): Uint8Array | null {
  const sqliChunk = chunks.find((c) => c.name === 'SQLi');
  if (sqliChunk) {
    const idx = indexOfBytes(sqliChunk.data, SQLITE_SIG, 0);
    if (idx >= 0) return sqliChunk.data.subarray(idx);
  }
  const idx = indexOfBytes(rawBuffer, SQLITE_SIG, 0);
  return idx >= 0 ? rawBuffer.subarray(idx) : null;
}

/**
 * Extracts CHNKExta external payloads keyed by external ID (e.g. "extrnlid...").
 */
export function extractExtaChunks(chunks: CspChunk[]): Map<string, Uint8Array> {
  const extaMap = new Map<string, Uint8Array>();

  for (const c of chunks) {
    if (c.name !== 'Exta' || c.data.length < 16) continue;
    const view = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
    const idLen = readU64BE(view, 0);
    if (idLen <= 0 || idLen > 256 || 8 + idLen > c.data.length) continue;

    const externalId = readAscii(c.data, 8, idLen).replace(/\0+$/, '');
    const afterId = 8 + idLen;

    let payloadStart = afterId;
    if (afterId + 8 <= c.data.length) {
      const maybePayloadLen = readU64BE(view, afterId);
      const remainingAfterLen = c.data.length - (afterId + 8);
      if (maybePayloadLen === remainingAfterLen) {
        payloadStart = afterId + 8;
      } else {
        // Also check if BlockDataBeginChunk starts right after an 8-byte header
        const firstTagAt8 = indexOfBytes(c.data, TAG_BLOCK_BEGIN, afterId + 8);
        const firstTagAt0 = indexOfBytes(c.data, TAG_BLOCK_BEGIN, afterId);
        if (firstTagAt8 >= 0 && firstTagAt0 === firstTagAt8) {
          payloadStart = afterId + 8;
        }
      }
    }

    extaMap.set(externalId, c.data.subarray(payloadStart));
  }

  return extaMap;
}

interface ParsedOffscreenAttribute {
  bitmapWidth: number;
  bitmapHeight: number;
  blockGridWidth: number;
  blockGridHeight: number;
  defaultFill: number; // 0 = transparent/black, 1 = white/filled
  firstPackingChannels: number;
  secondPackingChannels: number;
  bitDepthFlag: number;
  initColor: [number, number, number, number] | null; // RGBA 0..255
}

/**
 * Parses Offscreen.Attribute binary blob ("Parameter" + optional "InitColor").
 */
export function parseOffscreenAttribute(
  blob: Uint8Array | null,
  fallbackW: number,
  fallbackH: number
): ParsedOffscreenAttribute {
  const def: ParsedOffscreenAttribute = {
    bitmapWidth: fallbackW,
    bitmapHeight: fallbackH,
    blockGridWidth: Math.max(1, Math.ceil(fallbackW / TILE_SIZE)),
    blockGridHeight: Math.max(1, Math.ceil(fallbackH / TILE_SIZE)),
    defaultFill: 0,
    firstPackingChannels: 1,
    secondPackingChannels: 4,
    bitDepthFlag: 8,
    initColor: null,
  };

  if (!blob || blob.byteLength < 32) return def;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);

  const paramIdx = indexOfBytes(blob, TAG_PARAMETER, 0);
  if (paramIdx >= 0) {
    const afterParam = paramIdx + TAG_PARAMETER.length;
    // Locate (bitmapWidth, bitmapHeight, blockGridWidth, blockGridHeight) using exact tile-grid invariant
    let base = -1;
    for (const shift of [0, 4, 8, 12]) {
      const p = afterParam + shift;
      if (p + 16 > blob.byteLength) break;
      const bw = view.getUint32(p, false);
      const bh = view.getUint32(p + 4, false);
      const gw = view.getUint32(p + 8, false);
      const gh = view.getUint32(p + 12, false);
      if (
        bw > 0 &&
        bh > 0 &&
        bw <= MAX_CANVAS_DIM &&
        bh <= MAX_CANVAS_DIM &&
        gw === Math.ceil(bw / TILE_SIZE) &&
        gh === Math.ceil(bh / TILE_SIZE)
      ) {
        base = p;
        break;
      }
    }

    if (base >= 0) {
      def.bitmapWidth = view.getUint32(base, false);
      def.bitmapHeight = view.getUint32(base + 4, false);
      def.blockGridWidth = view.getUint32(base + 8, false);
      def.blockGridHeight = view.getUint32(base + 12, false);

      if (base + 20 <= blob.byteLength) {
        def.defaultFill = view.getUint32(base + 16, false);
      }
      // Packing parameters follow defaultFill (up to 11 u32 values)
      if (base + 32 <= blob.byteLength) {
        const ch1 = view.getUint32(base + 24, false);
        const ch2 = view.getUint32(base + 28, false);
        if (ch1 <= 4 && ch2 <= 4) {
          def.firstPackingChannels = ch1;
          def.secondPackingChannels = ch2;
        }
      }
      if (base + 56 <= blob.byteLength) {
        def.bitDepthFlag = view.getUint32(base + 52, false);
      }
    }
  }

  const initIdx = indexOfBytes(blob, TAG_INIT_COLOR, 0);
  if (initIdx >= 0) {
    const p = initIdx + TAG_INIT_COLOR.length;
    // InitColor stores either:
    // - 4 u32 BE (flag + R/G/B or A/R/G/B in 0..255 or 0..65535 or 0..0xffffffff)
    // - or u32 enable + 3/4 u32 color channels
    if (p + 16 <= blob.byteLength) {
      const a0 = view.getUint32(p, false);
      const a1 = view.getUint32(p + 4, false);
      const a2 = view.getUint32(p + 8, false);
      const a3 = view.getUint32(p + 12, false);
      // Detect normalized 8-bit or 16-bit or 32-bit color values
      if (p + 20 <= blob.byteLength) {
        const enabled = a0;
        const c0 = a1;
        const c1 = a2;
        const c2 = a3;
        const c3 = view.getUint32(p + 16, false);
        if (enabled === 1 && c0 <= 0xffffffff && c1 <= 0xffffffff && c2 <= 0xffffffff) {
          const norm = (v: number) =>
            v <= 255 ? v : v <= 65535 ? (v >> 8) & 0xff : (v >>> 24) & 0xff;
          def.initColor = [norm(c0), norm(c1), norm(c2), c3 > 0 ? norm(c3) : 255];
        }
      }
    }
  }

  return def;
}

function isValidTileByteLength(len: number): boolean {
  return (
    len === TILE_PIXELS * 5 ||
    len === TILE_PIXELS * 4 ||
    len === TILE_PIXELS * 2 ||
    len === TILE_PIXELS ||
    len === 16384 ||
    len === 8192
  );
}

function mergePlanes(planes: Uint8Array[]): Uint8Array | null {
  if (planes.length === 0) return null;
  if (planes.length === 1) return planes[0];
  let total = 0;
  for (const p of planes) total += p.byteLength;
  if (total > MAX_DECOMPRESSED_TILE_BYTES) return null;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of planes) {
    merged.set(p, off);
    off += p.byteLength;
  }
  return merged;
}

/**
 * Extracts compressed sub-block payload(s) inside a single BlockDataBeginChunk..BlockDataEndChunk span.
 */
function decompressBlockSpan(span: Uint8Array): Uint8Array | null {
  if (span.byteLength < 6) return null;
  const view = new DataView(span.buffer, span.byteOffset, span.byteLength);

  // Path 1: Standard CSP framed sub-blocks: [u32BE outerLen][u32LE innerLen][zlib...] (1 or 2 planes)
  const planes: Uint8Array[] = [];
  let pos = 0;

  while (pos + 8 <= span.byteLength) {
    const outerLen = view.getUint32(pos, false);
    if (outerLen < 6 || pos + 4 + outerLen > span.byteLength) {
      break;
    }

    let zStart = pos + 8;
    const zEnd = pos + 4 + outerLen;

    // Verify zlib header at +8 (after u32LE innerLen) or at +4 (no innerLen)
    if (zStart + 2 <= zEnd && isZlibHeader(span[zStart], span[zStart + 1])) {
      // standard CSP [u32BE outerLen][u32LE innerLen][zlib]
    } else if (pos + 6 <= zEnd && isZlibHeader(span[pos + 4], span[pos + 5])) {
      zStart = pos + 4;
    } else {
      break;
    }

    const decoded = safeUnzlib(span.subarray(zStart, zEnd));
    if (!decoded) break;
    planes.push(decoded);
    pos = zEnd;
  }

  if (planes.length > 0) {
    const merged = mergePlanes(planes);
    if (merged && (pos === span.byteLength || isValidTileByteLength(merged.byteLength))) {
      return merged;
    }
  }

  // Path 2: Direct zlib stream at start or offset +4/+8
  for (const offset of [0, 4, 8]) {
    if (offset + 6 <= span.byteLength && isZlibHeader(span[offset], span[offset + 1])) {
      const decoded = safeUnzlib(span.subarray(offset));
      if (decoded) return decoded;
    }
  }

  return null;
}

/**
 * Parses a CSP BlockData external payload into a sparse map of gridIndex -> decompressed tile bytes.
 */
export function parseBlockDataPayload(
  payload: Uint8Array,
  expectedBlocks: number
): Map<number, Uint8Array> {
  const tiles = new Map<number, Uint8Array>();
  const maxBlocks = Math.min(Math.max(expectedBlocks, 1), MAX_BLOCKS_PER_LAYER);
  const parsedEntries: Array<{ rawIndex: number; data: Uint8Array | null }> = [];

  let cursor = 0;
  let seqIdx = 0;
  let foundTagged = false;

  while (cursor < payload.length && seqIdx < maxBlocks * 2) {
    const beginPos = indexOfBytes(payload, TAG_BLOCK_BEGIN, cursor);
    if (beginPos < 0) break;
    foundTagged = true;

    const afterBegin = beginPos + TAG_BLOCK_BEGIN.length;
    const endPos = indexOfBytes(payload, TAG_BLOCK_END, afterBegin);
    const nextBegin = indexOfBytes(payload, TAG_BLOCK_BEGIN, afterBegin);

    // Guard against empty blocks lacking an explicit BlockDataEndChunk
    if (nextBegin >= 0 && (endPos < 0 || nextBegin < endPos)) {
      parsedEntries.push({ rawIndex: seqIdx, data: null });
      seqIdx++;
      cursor = nextBegin;
      continue;
    }
    if (endPos < 0) break;

    const inner = payload.subarray(afterBegin, endPos);
    const rawIndex =
      inner.byteLength >= 4
        ? new DataView(inner.buffer, inner.byteOffset, inner.byteLength).getUint32(0, false)
        : seqIdx;

    let decompressed: Uint8Array | null = null;
    if (inner.byteLength > 20) {
      const view = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
      const hasDataAt16 = view.getUint32(16, false);

      if (hasDataAt16 !== 0) {
        decompressed = decompressBlockSpan(inner.subarray(20));
      }

      // Probe alternate CSP version header offsets if standard +20 offset did not match
      if (!decompressed && inner.byteLength > 28) {
        for (const hdrLen of [16, 24, 12, 8]) {
          if (inner.byteLength <= hdrLen + 6) continue;
          const candidate = decompressBlockSpan(inner.subarray(hdrLen));
          if (candidate && isValidTileByteLength(candidate.byteLength)) {
            decompressed = candidate;
            break;
          }
        }
      }
    }

    parsedEntries.push({ rawIndex, data: decompressed });
    seqIdx++;
    cursor = endPos + TAG_BLOCK_END.length;
  }

  if (foundTagged) {
    // Standard CSP emits every grid cell sequentially (empty or populated): use exact seqIdx.
    // Only trust rawIndex when empty cells were omitted and rawIndex is strictly increasing within bounds.
    let useRawIndex = parsedEntries.length < expectedBlocks && parsedEntries.length > 0;
    if (useRawIndex) {
      let prev = -1;
      for (const e of parsedEntries) {
        if (e.rawIndex <= prev || e.rawIndex >= maxBlocks) {
          useRawIndex = false;
          break;
        }
        prev = e.rawIndex;
      }
    }
    for (let i = 0; i < parsedEntries.length; i++) {
      const e = parsedEntries[i];
      if (e.data) {
        tiles.set(useRawIndex ? e.rawIndex : i, e.data);
      }
    }
    return tiles;
  }

  // Fallback for non-tagged raw zlib block streams
  let blockIdx = 0;
  for (let i = 0; i < payload.length - 8 && blockIdx < maxBlocks; i++) {
    if (isZlibHeader(payload[i], payload[i + 1])) {
      const decoded = safeUnzlib(payload.subarray(i));
      if (decoded && isValidTileByteLength(decoded.byteLength)) {
        tiles.set(blockIdx, decoded);
        blockIdx++;
        i += 32;
      }
    }
  }

  return tiles;
}

/**
 * Unpacks a single 256x256 decompressed CSP tile into RGBA (Uint8ClampedArray of length 262144).
 * Returns true if any non-transparent pixel was written.
 */
export function decodeCspTileToRgba(
  raw: Uint8Array,
  outRgba: Uint8ClampedArray,
  attr: ParsedOffscreenAttribute
): boolean {
  const len = raw.byteLength;
  let hasPixels = false;

  // 1. Standard CSP 32-bit Color: 1-byte Alpha plane (65536) + 4-byte BGRX plane (262144) = 327680
  if (len >= TILE_PIXELS * 5) {
    const colorOff = TILE_PIXELS;
    for (let p = 0; p < TILE_PIXELS; p++) {
      const a = raw[p];
      const di = p << 2;
      if (a === 0) {
        outRgba[di] = 0;
        outRgba[di + 1] = 0;
        outRgba[di + 2] = 0;
        outRgba[di + 3] = 0;
      } else {
        const ci = colorOff + di;
        outRgba[di] = raw[ci + 2];     // R
        outRgba[di + 1] = raw[ci + 1]; // G
        outRgba[di + 2] = raw[ci];     // B
        outRgba[di + 3] = a;
        hasPixels = true;
      }
    }
    return hasPixels;
  }

  // 2. Single-plane 4-byte BGRA / BGRX (262144)
  if (len >= TILE_PIXELS * 4) {
    let anyAlpha = false;
    for (let p = 0; p < TILE_PIXELS; p++) {
      if (raw[(p << 2) + 3] !== 0) {
        anyAlpha = true;
        break;
      }
    }
    for (let p = 0; p < TILE_PIXELS; p++) {
      const i = p << 2;
      const b = raw[i];
      const g = raw[i + 1];
      const r = raw[i + 2];
      const a = anyAlpha ? raw[i + 3] : (r | g | b) !== 0 ? 255 : 0;
      outRgba[i] = r;
      outRgba[i + 1] = g;
      outRgba[i + 2] = b;
      outRgba[i + 3] = a;
      if (a !== 0) hasPixels = true;
    }
    return hasPixels;
  }

  // 3. CSP Grayscale 2-plane: Alpha (65536) + Gray luminance (65536) = 131072
  if (len >= TILE_PIXELS * 2) {
    for (let p = 0; p < TILE_PIXELS; p++) {
      const a = raw[p];
      const di = p << 2;
      if (a === 0) {
        outRgba[di] = 0;
        outRgba[di + 1] = 0;
        outRgba[di + 2] = 0;
        outRgba[di + 3] = 0;
      } else {
        const g = raw[TILE_PIXELS + p];
        outRgba[di] = g;
        outRgba[di + 1] = g;
        outRgba[di + 2] = g;
        outRgba[di + 3] = a;
        hasPixels = true;
      }
    }
    return hasPixels;
  }

  // 4. Single-channel 8-bit (65536): Alpha-only ink layer (black or white depending on defaultFill)
  if (len >= TILE_PIXELS) {
    const ink = attr.defaultFill === 1 ? 255 : 0;
    for (let p = 0; p < TILE_PIXELS; p++) {
      const a = raw[p];
      const di = p << 2;
      if (a === 0) {
        outRgba[di] = 0;
        outRgba[di + 1] = 0;
        outRgba[di + 2] = 0;
        outRgba[di + 3] = 0;
      } else {
        outRgba[di] = ink;
        outRgba[di + 1] = ink;
        outRgba[di + 2] = ink;
        outRgba[di + 3] = a;
        hasPixels = true;
      }
    }
    return hasPixels;
  }

  // 5. Monochrome 2-plane 1-bit: Alpha bits (8192) + White/Black color bits (8192) = 16384
  if (len >= 16384) {
    for (let byteIdx = 0; byteIdx < 8192; byteIdx++) {
      const aByte = raw[byteIdx];
      const cByte = raw[8192 + byteIdx];
      const baseP = byteIdx << 3;
      if (aByte === 0) {
        outRgba.fill(0, baseP << 2, (baseP + 8) << 2);
        continue;
      }
      for (let bit = 0; bit < 8; bit++) {
        const mask = 1 << (7 - bit);
        const di = (baseP + bit) << 2;
        if ((aByte & mask) !== 0) {
          const c = (cByte & mask) !== 0 ? 255 : 0;
          outRgba[di] = c;
          outRgba[di + 1] = c;
          outRgba[di + 2] = c;
          outRgba[di + 3] = 255;
          hasPixels = true;
        } else {
          outRgba[di] = 0;
          outRgba[di + 1] = 0;
          outRgba[di + 2] = 0;
          outRgba[di + 3] = 0;
        }
      }
    }
    return hasPixels;
  }

  // 6. Monochrome 1-plane 1-bit (8192): Black (or white) ink bits
  if (len >= 8192) {
    const ink = attr.defaultFill === 1 ? 255 : 0;
    for (let byteIdx = 0; byteIdx < 8192; byteIdx++) {
      const aByte = raw[byteIdx];
      const baseP = byteIdx << 3;
      if (aByte === 0) {
        outRgba.fill(0, baseP << 2, (baseP + 8) << 2);
        continue;
      }
      for (let bit = 0; bit < 8; bit++) {
        const di = (baseP + bit) << 2;
        if ((aByte & (1 << (7 - bit))) !== 0) {
          outRgba[di] = ink;
          outRgba[di + 1] = ink;
          outRgba[di + 2] = ink;
          outRgba[di + 3] = 255;
          hasPixels = true;
        } else {
          outRgba[di] = 0;
          outRgba[di + 1] = 0;
          outRgba[di + 2] = 0;
          outRgba[di + 3] = 0;
        }
      }
    }
    return hasPixels;
  }

  return false;
}

/**
 * Unpacks a single 256x256 mask tile into 65536 grayscale bytes (0 = hidden, 255 = revealed).
 */
function decodeCspTileToMaskValues(raw: Uint8Array, outMask: Uint8Array): boolean {
  if (raw.byteLength >= TILE_PIXELS) {
    outMask.set(raw.subarray(0, TILE_PIXELS));
    return true;
  }
  if (raw.byteLength >= 8192) {
    for (let byteIdx = 0; byteIdx < 8192; byteIdx++) {
      const b = raw[byteIdx];
      const baseP = byteIdx << 3;
      for (let bit = 0; bit < 8; bit++) {
        outMask[baseP + bit] = (b & (1 << (7 - bit))) !== 0 ? 255 : 0;
      }
    }
    return true;
  }
  return false;
}

/**
 * Writes a clipped tile rectangle into SparseTileGrid without allocating a full-document canvas.
 */
function writeClippedTileToGrid(
  tileGrid: SparseTileGrid,
  layerId: string,
  tileRgba: Uint8ClampedArray,
  tileDocX: number,
  tileDocY: number,
  maxBitmapW: number,
  maxBitmapH: number,
  offsetX: number,
  offsetY: number,
  docWidth: number,
  docHeight: number
): void {
  const validRight = Math.min(docWidth, offsetX + maxBitmapW);
  const validBottom = Math.min(docHeight, offsetY + maxBitmapH);

  const srcX0 = Math.max(0, -tileDocX);
  const srcY0 = Math.max(0, -tileDocY);
  const srcX1 = Math.min(TILE_SIZE, validRight - tileDocX);
  const srcY1 = Math.min(TILE_SIZE, validBottom - tileDocY);
  if (srcX0 >= srcX1 || srcY0 >= srcY1) return;

  if (srcX0 === 0 && srcY0 === 0 && srcX1 === TILE_SIZE && srcY1 === TILE_SIZE) {
    tileGrid.writeImageData(
      layerId,
      { data: tileRgba, width: TILE_SIZE, height: TILE_SIZE },
      tileDocX,
      tileDocY,
      'color-32bit',
      true
    );
    return;
  }

  const cw = srcX1 - srcX0;
  const ch = srcY1 - srcY0;
  const cropped = new Uint8ClampedArray(cw * ch * 4);
  const rowBytes = cw * 4;
  for (let row = 0; row < ch; row++) {
    const srcOff = ((srcY0 + row) * TILE_SIZE + srcX0) * 4;
    cropped.set(tileRgba.subarray(srcOff, srcOff + rowBytes), row * rowBytes);
  }
  tileGrid.writeImageData(
    layerId,
    { data: cropped, width: cw, height: ch },
    tileDocX + srcX0,
    tileDocY + srcY0,
    'color-32bit',
    true
  );
}

/**
 * Decodes a CSP mask offscreen into an Ink Studio maskCanvas (grayscale RGB, alpha=255).
 */
function buildMaskCanvasFromOffscreen(
  offscreen: OffscreenRecord,
  extaChunks: Map<string, Uint8Array>,
  maskOffsetX: number,
  maskOffsetY: number,
  docWidth: number,
  docHeight: number,
  maskScratch: Uint8Array
): HTMLCanvasElement | undefined {
  if (typeof document === 'undefined') return undefined;

  const attr = parseOffscreenAttribute(offscreen.attribute, docWidth, docHeight);
  const defaultVal = attr.defaultFill !== 0 ? 255 : 0;

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = docWidth;
  maskCanvas.height = docHeight;
  const mCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!mCtx) return undefined;

  const outImg = mCtx.createImageData(docWidth, docHeight);
  const out = outImg.data;
  for (let i = 0; i < out.length; i += 4) {
    out[i] = defaultVal;
    out[i + 1] = defaultVal;
    out[i + 2] = defaultVal;
    out[i + 3] = 255;
  }

  const payload = offscreen.blockDataId ? extaChunks.get(offscreen.blockDataId) : undefined;
  if (payload) {
    const totalBlocks = attr.blockGridWidth * attr.blockGridHeight;
    const tiles = parseBlockDataPayload(payload, totalBlocks);
    for (const [blockIdx, raw] of tiles.entries()) {
      if (!decodeCspTileToMaskValues(raw, maskScratch)) continue;
      const col = blockIdx % attr.blockGridWidth;
      const row = Math.floor(blockIdx / attr.blockGridWidth);
      const tileDocX = col * TILE_SIZE + maskOffsetX;
      const tileDocY = row * TILE_SIZE + maskOffsetY;

      const x0 = Math.max(0, -tileDocX);
      const y0 = Math.max(0, -tileDocY);
      const x1 = Math.min(TILE_SIZE, docWidth - tileDocX, attr.bitmapWidth - col * TILE_SIZE);
      const y1 = Math.min(TILE_SIZE, docHeight - tileDocY, attr.bitmapHeight - row * TILE_SIZE);
      if (x0 >= x1 || y0 >= y1) continue;

      for (let sy = y0; sy < y1; sy++) {
        const dy = tileDocY + sy;
        const srcRow = sy * TILE_SIZE;
        const dstRow = dy * docWidth;
        for (let sx = x0; sx < x1; sx++) {
          const v = maskScratch[srcRow + sx];
          const di = (dstRow + tileDocX + sx) << 2;
          out[di] = v;
          out[di + 1] = v;
          out[di + 2] = v;
          out[di + 3] = 255;
        }
      }
    }
  }

  mCtx.putImageData(outImg, 0, 0);
  return maskCanvas;
}

type SqlRow = Record<string, SqlValue>;

function getTableNames(db: Database): Set<string> {
  const names = new Set<string>();
  try {
    const res = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    if (res.length > 0) {
      for (const row of res[0].values) {
        if (typeof row[0] === 'string') names.add(row[0]);
      }
    }
  } catch {
    // ignore
  }
  return names;
}

function queryTable(db: Database, tables: Set<string>, tableName: string): SqlRow[] {
  if (!tables.has(tableName)) return [];
  try {
    const res = db.exec(`SELECT * FROM "${tableName.replace(/"/g, '""')}"`);
    if (res.length === 0) return [];
    const { columns, values } = res[0];
    const out: SqlRow[] = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const obj: SqlRow = {};
      const row = values[i];
      for (let c = 0; c < columns.length; c++) {
        obj[columns[c]] = row[c];
      }
      out[i] = obj;
    }
    return out;
  } catch {
    return [];
  }
}

function getNum(row: SqlRow, keys: string[], fallback: number): number {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return fallback;
}

function getOptNum(row: SqlRow, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

function getStr(row: SqlRow, keys: string[], fallback: string): string {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.length > 0) return v.replace(/\0+$/, '');
    if (v instanceof Uint8Array && v.byteLength > 0) {
      const decoded = utf8Decoder.decode(v).replace(/\0+$/, '');
      if (decoded.length > 0) return decoded;
    }
  }
  return fallback;
}

function getBytes(row: SqlRow, keys: string[]): Uint8Array | null {
  for (const k of keys) {
    const v = row[k];
    if (v instanceof Uint8Array && v.byteLength > 0) return v;
  }
  return null;
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return (
    '#' +
    ((1 << 24) | (clamp(r) << 16) | (clamp(g) << 8) | clamp(b))
      .toString(16)
      .slice(1)
  );
}

function normalizeColorChannel(v: number): number {
  if (v <= 255) return Math.max(0, Math.round(v));
  if (v <= 65535) return (v >> 8) & 0xff;
  return (v >>> 24) & 0xff;
}

function bytesToPngDataUrl(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < 8) return undefined;
  // Detect PNG or JPEG magic
  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!isPng && !isJpeg) return undefined;
  const mime = isPng ? 'image/png' : 'image/jpeg';
  if (typeof btoa === 'function') {
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.byteLength; i += step) {
      bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.byteLength, i + step)));
    }
    return `data:${mime};base64,${btoa(bin)}`;
  }
  return undefined;
}

function decodeImageBytesToTileGrid(
  bytes: Uint8Array,
  tileGrid: SparseTileGrid,
  layerId: string,
  width: number,
  height: number
): Promise<boolean> {
  if (typeof document === 'undefined' || typeof Image === 'undefined' || typeof URL === 'undefined') {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy]);
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
        tileGrid.ingestCanvas(layerId, canvas, 'color-32bit');
      }
      canvas.width = 0;
      canvas.height = 0;
      resolve(Boolean(ctx));
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(false);
    };

    img.src = url;
  });
}

interface OffscreenRecord {
  mainId: number;
  layerId: number;
  blockDataId: string;
  attribute: Uint8Array | null;
}

interface MipmapInfoRecord {
  mainId: number;
  offscreenId: number;
  thisScale: number;
  nextIndex: number;
}

/**
 * Extracts Paper / Solid Color fill hex if the layer row or associated fill tables specify one.
 */
function extractSolidFillColor(
  layerRow: SqlRow,
  attr: ParsedOffscreenAttribute | null,
  fillByLayerId: Map<number, string>,
  isBottomMost: boolean
): string | null {
  const mainId = getNum(layerRow, ['MainId'], -1);
  if (fillByLayerId.has(mainId)) {
    return fillByLayerId.get(mainId)!;
  }

  // Check explicit fill color columns on Layer (present in some CSP versions)
  const r = getOptNum(layerRow, ['LayerFillRed', 'FillColorRed', 'PaperRed']);
  const g = getOptNum(layerRow, ['LayerFillGreen', 'FillColorGreen', 'PaperGreen']);
  const b = getOptNum(layerRow, ['LayerFillBlue', 'FillColorBlue', 'PaperBlue']);
  if (r !== null && g !== null && b !== null) {
    return rgbToHex(normalizeColorChannel(r), normalizeColorChannel(g), normalizeColorChannel(b));
  }

  // Check packed ARGB/RGB color integer on Paper/Fill layers
  const packedColor = getOptNum(layerRow, ['LayerFillColor', 'SolidColor', 'PaperColor']);
  if (packedColor !== null && packedColor !== 0) {
    return rgbToHex((packedColor >>> 16) & 0xff, (packedColor >>> 8) & 0xff, packedColor & 0xff);
  }

  // Check Offscreen Attribute InitColor (opaque)
  if (attr?.initColor && attr.initColor[3] > 0) {
    return rgbToHex(attr.initColor[0], attr.initColor[1], attr.initColor[2]);
  }

  // CSP Paper layer heuristic: bottom-most layer named Paper / 用紙 or defaultFill=1 with no tiles
  const name = getStr(layerRow, ['LayerName'], '').trim().toLowerCase();
  const isPaperName = name === 'paper' || name === '用紙' || name === 'papier' || name === 'papel';
  const layerType = getNum(layerRow, ['LayerType'], -1);
  // CSP Paper layer frequently has LayerType = 1 with no offscreen, or specific fill type, or defaultFill = 1
  if (isPaperName || (isBottomMost && attr?.defaultFill === 1) || layerType === 1280) {
    return '#ffffff';
  }

  return null;
}

/**
 * Main parser for Clip Studio Paint (.clip / .csp / .lip) files.
 * Decodes full layer hierarchy, folders, raster/vector/text cached bitmaps,
 * layer masks, blend modes, opacity, clipping, locks, and paper fills
 * directly into a SparseTileGrid-backed LoadedDocument.
 */
export async function parseCspFile(
  buffer: ArrayBuffer,
  fileName: string,
  targetGrid?: SparseTileGrid
): Promise<LoadedDocument> {
  const bytes = new Uint8Array(buffer);
  const chunks = parseCspChunks(bytes);
  const sqliteData = findSqliteData(chunks, bytes);

  if (!sqliteData) {
    throw new Error('Could not find SQLite database metadata within Clip Studio Paint file.');
  }

  const SQL = await getSql();
  // sql.js requires a standalone Uint8Array copy when given a subarray view
  const dbBytes =
    sqliteData.byteOffset === 0 && sqliteData.byteLength === sqliteData.buffer.byteLength
      ? sqliteData
      : sqliteData.slice();
  const db: Database = new SQL.Database(dbBytes);

  try {
    const tables = getTableNames(db);

    // 1. Canvas metadata
    let width = 1440;
    let height = 900;
    let dpi = 300;
    let rootFolderId: number | null = null;
    const colorMode: CanvasColorMode = 'color';

    const canvasRows = queryTable(db, tables, 'Canvas');
    if (canvasRows.length > 0) {
      const c = canvasRows[0];
      const w = getNum(c, ['CanvasWidth'], 1440);
      const h = getNum(c, ['CanvasHeight'], 900);
      width = Math.max(1, Math.min(MAX_CANVAS_DIM, Math.round(w)));
      height = Math.max(1, Math.min(MAX_CANVAS_DIM, Math.round(h)));
      const res = getNum(c, ['CanvasResolution', 'CanvasDpi'], 300);
      dpi = Math.max(1, Math.min(2400, Math.round(res)));
      rootFolderId = getOptNum(c, ['CanvasRootFolder']);
    }

    // 2. Preview image bytes (for recent-doc thumbnail & last-resort fallback)
    let previewBytes: Uint8Array | null = null;
    const previewRows = queryTable(db, tables, 'CanvasPreview');
    if (previewRows.length > 0) {
      previewBytes = getBytes(previewRows[0], ['ImageData']);
    }
    const previewDataUrl = previewBytes ? bytesToPngDataUrl(previewBytes) : undefined;

    // 3. External CHNKExta map
    const extaChunks = extractExtaChunks(chunks);

    // 4. Build Mipmap -> MipmapInfo -> Offscreen lookup tables
    const mipmapBaseInfoById = new Map<number, number>();
    for (const row of queryTable(db, tables, 'Mipmap')) {
      const id = getNum(row, ['MainId'], -1);
      const baseInfo = getNum(row, ['BaseMipmapInfo'], 0);
      if (id >= 0 && baseInfo > 0) {
        mipmapBaseInfoById.set(id, baseInfo);
      }
    }

    const mipmapInfoById = new Map<number, MipmapInfoRecord>();
    const mipmapInfoTable = tables.has('MipmapInfo')
      ? 'MipmapInfo'
      : tables.has('MipmapStoring')
        ? 'MipmapStoring'
        : '';
    if (mipmapInfoTable) {
      for (const row of queryTable(db, tables, mipmapInfoTable)) {
        const mainId = getNum(row, ['MainId'], -1);
        const offscreenId = getNum(row, ['Offscreen'], 0);
        const thisScale = getNum(row, ['ThisScale'], 1);
        const nextIndex = getNum(row, ['NextIndex'], 0);
        if (mainId >= 0) {
          mipmapInfoById.set(mainId, { mainId, offscreenId, thisScale, nextIndex });
        }
      }
    }

    const offscreenById = new Map<number, OffscreenRecord>();
    const offscreensByLayerId = new Map<number, OffscreenRecord[]>();
    for (const row of queryTable(db, tables, 'Offscreen')) {
      const mainId = getNum(row, ['MainId'], -1);
      const layerId = getNum(row, ['LayerId'], -1);
      const blockDataId = getStr(row, ['BlockData'], '');
      const attribute = getBytes(row, ['Attribute']);
      if (mainId < 0) continue;
      const rec: OffscreenRecord = { mainId, layerId, blockDataId, attribute };
      offscreenById.set(mainId, rec);
      if (layerId >= 0) {
        let list = offscreensByLayerId.get(layerId);
        if (!list) {
          list = [];
          offscreensByLayerId.set(layerId, list);
        }
        list.push(rec);
      }
    }

    // Optional solid-color / paper fill tables (CSP stores Paper/Fill color in Fill / SolidColor / Paper when present)
    const fillByLayerId = new Map<number, string>();
    for (const fillTable of ['SolidColor', 'FillLayer', 'Paper', 'Fill']) {
      for (const row of queryTable(db, tables, fillTable)) {
        const lid = getNum(row, ['LayerId', 'MainId'], -1);
        if (lid < 0) continue;
        const r = getOptNum(row, ['Red', 'ColorRed', 'FillRed', 'R']);
        const g = getOptNum(row, ['Green', 'ColorGreen', 'FillGreen', 'G']);
        const b = getOptNum(row, ['Blue', 'ColorBlue', 'FillBlue', 'B']);
        if (r !== null && g !== null && b !== null) {
          fillByLayerId.set(
            lid,
            rgbToHex(normalizeColorChannel(r), normalizeColorChannel(g), normalizeColorChannel(b))
          );
        }
      }
    }

    const resolveMipmapToOffscreen = (mipmapId: number): OffscreenRecord | null => {
      if (mipmapId <= 0) return null;
      let infoId = mipmapBaseInfoById.get(mipmapId);
      if (!infoId) return null;

      let best: OffscreenRecord | null = null;
      const seen = new Set<number>();
      while (infoId && infoId > 0 && !seen.has(infoId)) {
        seen.add(infoId);
        const info = mipmapInfoById.get(infoId);
        if (!info) break;
        const off = offscreenById.get(info.offscreenId) ?? null;
        if (off) {
          if (Math.abs(info.thisScale - 1) < 0.001) return off;
          if (!best) best = off;
        }
        infoId = info.nextIndex;
      }
      return best;
    };

    // 5. Query Layer table and reconstruct full tree
    const layerRows = queryTable(db, tables, 'Layer');
    const layerRowById = new Map<number, SqlRow>();
    const referencedAsMaskOffscreen = new Set<number>();

    for (const row of layerRows) {
      const mainId = getNum(row, ['MainId'], -1);
      if (mainId < 0) continue;
      layerRowById.set(mainId, row);
      const maskMipmapId = getNum(row, ['LayerLayerMaskMipmap', 'LayerMaskMipmap'], 0);
      const maskOff = resolveMipmapToOffscreen(maskMipmapId);
      if (maskOff) referencedAsMaskOffscreen.add(maskOff.mainId);
    }

    // Collect ordered siblings (bottom-to-top in CSP) from a parent folder
    const collectChildrenBottomToTop = (
      firstChildId: number,
      visitedNodes: Set<number>
    ): SqlRow[] => {
      const list: SqlRow[] = [];
      let curId = firstChildId;
      while (curId > 0 && !visitedNodes.has(curId) && list.length < MAX_LAYERS) {
        const row = layerRowById.get(curId);
        if (!row) break;
        visitedNodes.add(curId);
        list.push(row);
        curId = getNum(row, ['LayerNextIndex'], 0);
      }
      return list;
    };

    const tileGrid = targetGrid ?? new SparseTileGrid();
    const layers: LayerItem[] = [];
    const tileRgbaScratch = new Uint8ClampedArray(TILE_PIXELS * 4);
    const maskTileScratch = new Uint8Array(TILE_PIXELS);
    const runStamp = Date.now();
    let seq = 0;
    let decodedAnyPixels = false;

    const resolveLayerRenderOffscreen = (row: SqlRow, mainId: number): OffscreenRecord | null => {
      const renderMipmapId = getNum(row, ['LayerRenderMipmap'], 0);
      const fromMipmap = resolveMipmapToOffscreen(renderMipmapId);
      if (fromMipmap) return fromMipmap;

      const directOffId = getNum(row, ['LayerRenderOffscreen'], 0);
      if (directOffId > 0 && offscreenById.has(directOffId)) {
        return offscreenById.get(directOffId)!;
      }

      // Fallback: pick largest non-mask offscreen associated with this LayerId
      const candidates = offscreensByLayerId.get(mainId);
      if (!candidates || candidates.length === 0) return null;
      let best: OffscreenRecord | null = null;
      let bestArea = -1;
      for (const c of candidates) {
        if (referencedAsMaskOffscreen.has(c.mainId)) continue;
        if (!c.blockDataId || !extaChunks.has(c.blockDataId)) continue;
        const a = parseOffscreenAttribute(c.attribute, width, height);
        const area = a.bitmapWidth * a.bitmapHeight;
        if (area > bestArea) {
          bestArea = area;
          best = c;
        }
      }
      return best;
    };

    const emitLayerNode = (
      row: SqlRow,
      parentId: string | null,
      visitedNodes: Set<number>,
      depth: number,
      isBottomMostRoot: boolean,
      parentOffsetX: number,
      parentOffsetY: number
    ): void => {
      if (depth > MAX_FOLDER_DEPTH || layers.length >= MAX_LAYERS) return;

      const mainId = getNum(row, ['MainId'], seq + 1);
      const name = getStr(row, ['LayerName'], `Layer ${mainId}`);
      const layerFolder = getOptNum(row, ['LayerFolder']);
      const firstChildId = getNum(row, ['LayerFirstChildIndex'], 0);
      const layerType = getNum(row, ['LayerType'], 1);
      const compositeVal = getNum(row, ['LayerComposite'], 0);
      const rawOpacity = getNum(row, ['LayerOpacity'], 256);
      const visibilityVal = getNum(row, ['LayerVisibility'], 1);
      const lockVal = getNum(row, ['LayerLock'], 0);
      const clipVal = getNum(row, ['LayerClip'], 0);
      const layerSelect = getOptNum(row, ['LayerSelect']);

      // CSP accumulates folder LayerOffsetX/Y onto all descendants, and adds
      // per-offscreen origin offsets (LayerRenderOffscrOffsetX/Y, LayerMaskOffscrOffsetX/Y).
      const baseOffsetX = parentOffsetX + getNum(row, ['LayerOffsetX', 'LayerMoveOffsetX'], 0);
      const baseOffsetY = parentOffsetY + getNum(row, ['LayerOffsetY', 'LayerMoveOffsetY'], 0);
      const offsetX = Math.round(
        baseOffsetX + getNum(row, ['LayerRenderOffscrOffsetX', 'LayerRenderOffsetX'], 0)
      );
      const offsetY = Math.round(
        baseOffsetY + getNum(row, ['LayerRenderOffscrOffsetY', 'LayerRenderOffsetY'], 0)
      );
      const maskOffsetX = Math.round(
        baseOffsetX +
          getNum(row, ['LayerMaskOffsetX'], 0) +
          getNum(row, ['LayerMaskOffscrOffsetX'], 0)
      );
      const maskOffsetY = Math.round(
        baseOffsetY +
          getNum(row, ['LayerMaskOffsetY'], 0) +
          getNum(row, ['LayerMaskOffscrOffsetY'], 0)
      );

      const hasRenderOffscreen = Boolean(resolveLayerRenderOffscreen(row, mainId));
      const isFolder =
        (layerFolder !== null && layerFolder !== 0) ||
        firstChildId > 0 ||
        (layerFolder === null && layerType === 0 && !hasRenderOffscreen);

      seq += 1;
      const id = `csp-${isFolder ? 'folder' : 'layer'}-${mainId}-${runStamp}-${seq}`;
      const blendMode = mapCspBlendMode(compositeVal);
      // CSP stores opacity in [0..256] (256 = 100%)
      const opacity = Math.max(0, Math.min(1, rawOpacity / 256));
      const visible = (visibilityVal & 1) !== 0;
      const locked = (lockVal & 1) !== 0;
      const alphaLocked =
        (lockVal & 16) !== 0 || getNum(row, ['LayerLockTransparentPixel', 'LayerAlphaLock'], 0) !== 0;
      const clipped = clipVal !== 0;

      // Optional layer mask
      const maskMipmapId = getNum(row, ['LayerLayerMaskMipmap', 'LayerMaskMipmap'], 0);
      const maskOffscreen = resolveMipmapToOffscreen(maskMipmapId);
      let maskFields: Pick<
        LayerItem,
        'maskCanvas' | 'maskEnabled' | 'maskLinked' | 'maskVersion' | 'maskThumbnailUrl'
      > = {};
      if (maskOffscreen) {
        const maskCanvas = buildMaskCanvasFromOffscreen(
          maskOffscreen,
          extaChunks,
          maskOffsetX,
          maskOffsetY,
          width,
          height,
          maskTileScratch
        );
        // CSP exact bitflags: LayerVisibility & 2 = mask enabled; LayerSelect & 256 = mask linked
        const maskEnabled =
          row['LayerVisibility'] !== undefined ? (visibilityVal & 2) !== 0 : true;
        const maskLinked = layerSelect !== null ? (layerSelect & 256) !== 0 : true;
        maskFields = {
          maskCanvas,
          maskEnabled,
          maskLinked,
          maskVersion: 1,
          maskThumbnailUrl: maskCanvas ? createCanvasThumbnail(maskCanvas, false) : undefined,
        };
      }

      if (isFolder) {
        const collapsed = layerFolder !== null ? (layerFolder & 16) !== 0 : false;
        layers.push({
          id,
          name,
          type: 'folder',
          visible,
          opacity,
          blendMode,
          locked,
          alphaLocked,
          clipped,
          collapsed,
          parentId,
          ...maskFields,
        });

        if (firstChildId > 0) {
          const childrenBottomToTop = collectChildrenBottomToTop(firstChildId, visitedNodes);
          // Reverse bottom-to-top into Ink Studio's top-to-bottom stack order
          for (let i = childrenBottomToTop.length - 1; i >= 0; i--) {
            emitLayerNode(
              childrenBottomToTop[i],
              id,
              visitedNodes,
              depth + 1,
              false,
              baseOffsetX,
              baseOffsetY
            );
          }
        }
        return;
      }

      // Editable raster layer (including cached raster render of vector/text/balloon/tone/3D layers)
      tileGrid.setLayerFormat(id, 'color-32bit');
      tileGrid.markLayerIngested(id);

      const offscreen = resolveLayerRenderOffscreen(row, mainId);
      const attr = offscreen ? parseOffscreenAttribute(offscreen.attribute, width, height) : null;
      let layerHasPixels = false;

      if (offscreen && offscreen.blockDataId && extaChunks.has(offscreen.blockDataId)) {
        const payload = extaChunks.get(offscreen.blockDataId)!;
        const resolvedAttr = attr!;
        const expectedBlocks = resolvedAttr.blockGridWidth * resolvedAttr.blockGridHeight;
        const decodedTiles = parseBlockDataPayload(payload, expectedBlocks);

        for (const [blockIdx, rawTile] of decodedTiles.entries()) {
          if (decodeCspTileToRgba(rawTile, tileRgbaScratch, resolvedAttr)) {
            const col = blockIdx % resolvedAttr.blockGridWidth;
            const rowIdx = Math.floor(blockIdx / resolvedAttr.blockGridWidth);
            const tileDocX = col * TILE_SIZE + offsetX;
            const tileDocY = rowIdx * TILE_SIZE + offsetY;
            writeClippedTileToGrid(
              tileGrid,
              id,
              tileRgbaScratch,
              tileDocX,
              tileDocY,
              resolvedAttr.bitmapWidth,
              resolvedAttr.bitmapHeight,
              offsetX,
              offsetY,
              width,
              height
            );
            layerHasPixels = true;
            decodedAnyPixels = true;
          }
        }
      }

      // Handle Paper / Solid Color Fill layers (no raster tiles, solid fill color)
      if (!layerHasPixels) {
        const fillHex = extractSolidFillColor(row, attr, fillByLayerId, isBottomMostRoot);
        if (fillHex) {
          tileGrid.fillLayerSolidColor(id, width, height, fillHex, 'color-32bit');
          layerHasPixels = true;
          decodedAnyPixels = true;
        }
      }

      const thumb = createCanvasThumbnail(
        { grid: tileGrid, layerId: id, dimensions: { width, height } },
        true
      );

      layers.push({
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
      });
    };

    // Determine root container and traverse hierarchy
    const visited = new Set<number>();
    let rootRow: SqlRow | undefined;

    if (rootFolderId !== null && layerRowById.has(rootFolderId)) {
      rootRow = layerRowById.get(rootFolderId);
    } else {
      // Heuristic: find an unreferenced root folder that has children
      const referenced = new Set<number>();
      for (const row of layerRows) {
        const nextId = getNum(row, ['LayerNextIndex'], 0);
        const childId = getNum(row, ['LayerFirstChildIndex'], 0);
        if (nextId > 0) referenced.add(nextId);
        if (childId > 0) referenced.add(childId);
      }
      for (const row of layerRows) {
        const id = getNum(row, ['MainId'], -1);
        const childId = getNum(row, ['LayerFirstChildIndex'], 0);
        if (id >= 0 && childId > 0 && !referenced.has(id)) {
          rootRow = row;
          break;
        }
      }
    }

    if (rootRow) {
      const rootMainId = getNum(rootRow, ['MainId'], -1);
      if (rootMainId >= 0) visited.add(rootMainId);
      const rootOffsetX = getNum(rootRow, ['LayerOffsetX', 'LayerMoveOffsetX'], 0);
      const rootOffsetY = getNum(rootRow, ['LayerOffsetY', 'LayerMoveOffsetY'], 0);
      const firstChild = getNum(rootRow, ['LayerFirstChildIndex'], 0);
      if (firstChild > 0) {
        const topLevelBottomToTop = collectChildrenBottomToTop(firstChild, visited);
        for (let i = topLevelBottomToTop.length - 1; i >= 0; i--) {
          emitLayerNode(
            topLevelBottomToTop[i],
            null,
            visited,
            0,
            i === 0,
            rootOffsetX,
            rootOffsetY
          );
        }
      }
    }

    // Fallback: if linked-list traversal yielded nothing (minimal/legacy schema), emit flat Layer rows
    if (layers.length === 0 && layerRows.length > 0) {
      for (let i = layerRows.length - 1; i >= 0; i--) {
        const row = layerRows[i];
        const mid = getNum(row, ['MainId'], -1);
        if (rootFolderId !== null && mid === rootFolderId) continue;
        emitLayerNode(row, null, visited, 0, i === 0, 0, 0);
      }
    }

    // Last-resort fallback: ONLY if zero raster pixels were decoded from any layer AND preview exists
    if (!decodedAnyPixels && previewBytes && previewBytes.byteLength > 0) {
      const bgId = `csp-preview-base-${runStamp}`;
      const loaded = await decodeImageBytesToTileGrid(previewBytes, tileGrid, bgId, width, height);
      if (loaded) {
        const thumb = createCanvasThumbnail(
          { grid: tileGrid, layerId: bgId, dimensions: { width, height } },
          false
        );
        layers.push({
          id: bgId,
          name: 'CSP Composite Preview',
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
    }

    // Guarantee at least one editable layer
    if (layers.length === 0) {
      const fallbackId = `layer-${runStamp}`;
      tileGrid.fillLayerSolidWhite(fallbackId, width, height, 'color-32bit');
      layers.push({
        id: fallbackId,
        name: 'Layer 1',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        alphaLocked: false,
        clipped: false,
        parentId: null,
        thumbnailUrl: createCanvasThumbnail(
          { grid: tileGrid, layerId: fallbackId, dimensions: { width, height } },
          false
        ),
      });
    }

    return {
      name: fileName.replace(/\.[^/.]+$/, ''),
      dimensions: { width, height, dpi },
      colorMode,
      layers,
      tileGrid,
      previewDataUrl,
    };
  } finally {
    db.close();
  }
}
