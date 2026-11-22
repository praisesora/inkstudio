import { Unzlib, inflateSync } from 'fflate';
import { BlendMode, LoadedDocument } from '../types/editor';
import { isNativeRustAvailable, parseClipNative } from './nativeBackend';
import { SparseTileGrid, TILE_SIZE, TILE_PIXELS } from './tileEngine';

const MAX_CANVAS_DIM = 32768;
const MAX_BLOCKS_PER_LAYER = 16384; // 128x128 tiles = 32768x32768 px
const MAX_COMPRESSED_TILE_BYTES = 2 * 1024 * 1024;
const MAX_DECOMPRESSED_TILE_BYTES = 2 * 1024 * 1024;

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
      return 'subtract'; // Subtract
    case 6:
      return 'darker-color'; // Darker Color
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
      return 'lighter-color'; // Lighter Color
    case 14:
      return 'overlay';
    case 15:
      return 'soft-light';
    case 16:
      return 'hard-light';
    case 17:
      return 'vivid-light'; // Vivid Light
    case 18:
      return 'linear-light'; // Linear Light
    case 19:
      return 'pin-light'; // Pin Light
    case 20:
      return 'hard-mix'; // Hard Mix
    case 21:
      return 'difference';
    case 22:
      return 'exclusion';
    case 23:
      return 'hue';
    case 24:
      return 'saturation';
    case 25:
      return 'color';
    case 26:
      return 'luminosity';
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
 * Main parser for Clip Studio Paint (.clip / .csp / .lip) files.
 * Delegates SQLite extraction and Rayon-parallel tile decoding to the native Rust backend
 * (zero WASM sql.js dependency on the JS main thread).
 */
export async function parseCspFile(
  buffer: ArrayBuffer,
  fileName: string,
  targetGrid?: SparseTileGrid
): Promise<LoadedDocument> {
  if (!isNativeRustAvailable()) {
    throw new Error(
      'Parsing .clip/.csp files requires the native desktop Rust backend (WASM sql.js was removed).'
    );
  }
  return await parseClipNative(buffer, fileName, targetGrid);
}
