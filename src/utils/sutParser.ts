import { unzlibSync, inflateSync } from 'fflate';
import {
  CspAngleDynamicsMode,
  CspBlendTipsMode,
  CspBrush,
  CspPaperTextureMode,
  CspSensorConfig,
  CspSpraySettings,
  CspSubTip,
  CspTaperSettings,
  CspTipFlipMode,
} from '../types/editor';
import { evaluateFastSpline } from '../engine/BrushEngine';
import { isNativeRustAvailable, NativeSutExtract, parseSutSqliteNative } from './nativeBackend';

const MAX_DECOMPRESSED_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESSED_BLOB_BYTES = 16 * 1024 * 1024;

/**
 * Searches for a byte sequence in a Uint8Array.
 */
function indexOfSequence(haystack: Uint8Array, needle: number[], startOffset: number = 0): number {
  const nLen = needle.length;
  const hLen = haystack.length;
  if (nLen > hLen || startOffset + nLen > hLen) return -1;

  for (let i = startOffset; i <= hLen - nLen; i++) {
    let match = true;
    for (let j = 0; j < nLen; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * Extracts SQLite 3 database bytes from raw SUT buffer (handling CSFCHUNK or direct SQLite).
 */
export function extractSqliteFromBuffer(buffer: Uint8Array): Uint8Array | null {
  const sqliteSig = [
    0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
  ];

  // 1. Direct SQLite 3 file
  if (buffer.length >= 16) {
    let directMatch = true;
    for (let i = 0; i < 16; i++) {
      if (buffer[i] !== sqliteSig[i]) {
        directMatch = false;
        break;
      }
    }
    if (directMatch) return buffer;
  }

  // 2. CSFCHUNK container (Clip Studio Format Chunk)
  if (buffer.length >= 24) {
    const magic = new TextDecoder('ascii').decode(buffer.subarray(0, 8));
    if (magic === 'CSFCHUNK') {
      let offset = 24;
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

      while (offset + 16 <= buffer.length) {
        const chunkTag = new TextDecoder('ascii').decode(buffer.subarray(offset, offset + 4));
        if (chunkTag !== 'CHNK') break;

        const chunkName = new TextDecoder('ascii').decode(buffer.subarray(offset + 4, offset + 8));
        const chunkSize = view.getUint32(offset + 12, false);
        const dataStart = offset + 16;
        const dataEnd = dataStart + chunkSize;
        if (dataEnd > buffer.length || chunkSize > buffer.length) break;

        if (chunkName === 'SQLi') {
          const sqliData = buffer.slice(dataStart, dataEnd);
          const sigIdx = indexOfSequence(sqliData, sqliteSig, 0);
          return sigIdx >= 0 ? sqliData.slice(sigIdx) : sqliData;
        }

        offset = dataEnd;
      }
    }
  }

  // 3. Fallback: Search anywhere in buffer for SQLite header
  const idx = indexOfSequence(buffer, sqliteSig, 0);
  if (idx >= 0) {
    return buffer.slice(idx);
  }

  return null;
}

/**
 * Walks PNG chunk headers starting after the 8-byte PNG signature to find the exact byte end
 * (avoiding false-positive 'IEND' byte sequences inside compressed IDAT payloads).
 */
function findExactPngEnd(buf: Uint8Array, startIdx: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = startIdx + 8;
  while (offset + 12 <= buf.length) {
    const chunkLen = view.getUint32(offset, false);
    if (chunkLen > 0x7fffffff || offset + 12 + chunkLen > buf.length) {
      return -1;
    }
    const c0 = buf[offset + 4];
    const c1 = buf[offset + 5];
    const c2 = buf[offset + 6];
    const c3 = buf[offset + 7];
    offset += 12 + chunkLen;
    // 'IEND' = 0x49 0x45 0x4e 0x44
    if (c0 === 0x49 && c1 === 0x45 && c2 === 0x4e && c3 === 0x44) {
      return offset;
    }
  }
  return -1;
}

/**
 * Extracts PNG byte arrays from binary BLOB (handling raw PNG, tar archives, or zlib compression).
 */
export function extractPngImagesFromBlob(data: Uint8Array): Uint8Array[] {
  const pngs: Uint8Array[] = [];
  if (!data || data.length < 16) return pngs;

  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  const tryScan = (buf: Uint8Array) => {
    let pos = 0;
    while (pos < buf.length - 16) {
      const startIdx = indexOfSequence(buf, pngMagic, pos);
      if (startIdx === -1) break;

      const exactEnd = findExactPngEnd(buf, startIdx);
      if (exactEnd > startIdx) {
        pngs.push(buf.slice(startIdx, exactEnd));
        pos = exactEnd;
      } else {
        pos = startIdx + 8;
      }
    }
  };

  tryScan(data);

  if (
    pngs.length === 0 &&
    data.length > 2 &&
    data.length <= MAX_COMPRESSED_BLOB_BYTES &&
    data[0] === 0x78
  ) {
    try {
      const decompressed = unzlibSync(data);
      if (decompressed.byteLength <= MAX_DECOMPRESSED_BLOB_BYTES) {
        tryScan(decompressed);
      }
    } catch {
      try {
        const decompressed = inflateSync(data.subarray(2));
        if (decompressed.byteLength <= MAX_DECOMPRESSED_BLOB_BYTES) {
          tryScan(decompressed);
        }
      } catch {
        // Ignore decompression error
      }
    }
  }

  return pngs;
}

interface TarEntry {
  name: string;
  size: number;
  data: Uint8Array;
}

/**
 * Extracts files from an uncompressed USTAR/TAR archive.
 */
export function extractTarEntries(buffer: Uint8Array): TarEntry[] {
  let offset = 0;
  const entries: TarEntry[] = [];
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    let isZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        isZero = false;
        break;
      }
    }
    if (isZero) break;

    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
    const name = new TextDecoder('utf-8').decode(header.subarray(0, nameEnd));

    const sizeStr = new TextDecoder('ascii')
      .decode(header.subarray(124, 136))
      .trim()
      .replace(/\0.*$/, '');
    const size = parseInt(sizeStr, 8);

    offset += 512;
    if (isNaN(size) || size < 0 || offset + size > buffer.length) {
      break;
    }

    const data = buffer.subarray(offset, offset + size);
    entries.push({ name, size, data });
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function isPng(buf: Uint8Array): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

/**
 * Checks whether a MaterialFile TAR archive is tagged as a PaperTexture in icedata/layerData.xml.
 */
export function isMaterialPaperTexture(fileData: Uint8Array): boolean {
  if (!fileData || fileData.length < 512) return false;
  try {
    const entries = extractTarEntries(fileData);
    const xmlEntry = entries.find((e) => e.name.toLowerCase().endsWith('layerdata.xml'));
    if (xmlEntry && xmlEntry.data.length > 0) {
      const xml = new TextDecoder('utf-8', { fatal: false }).decode(xmlEntry.data);
      return xml.includes('<data>PaperTexture</data>');
    }
  } catch {
    // Ignore malformed TAR
  }
  return false;
}

/**
 * Extracts the primary raster image from a Clip Studio Paint MaterialFile BLOB.
 */
export function extractMaterialPng(fileData: Uint8Array): Uint8Array | null {
  if (!fileData || fileData.length < 16) return null;

  try {
    const tarEntries = extractTarEntries(fileData);
    if (tarEntries.length > 0) {
      const thumb = tarEntries.find((e) => e.name.toLowerCase().endsWith('thumbnail.png'));
      if (thumb && isPng(thumb.data)) {
        return thumb.data;
      }
      const anyPng = tarEntries.find((e) => e.name.toLowerCase().endsWith('.png') && isPng(e.data));
      if (anyPng) {
        return anyPng.data;
      }
    }
  } catch {
    // Fall back to direct scan
  }

  const pngs = extractPngImagesFromBlob(fileData);
  if (pngs.length > 0) {
    pngs.sort((a, b) => b.length - a.length);
    return pngs[0];
  }

  return null;
}

/**
 * Converts a Uint8Array of image bytes to a Base64 data URL in 8KB chunks (O(N) zero quadratic alloc).
 */
export function bytesToDataUrl(bytes: Uint8Array, mime: string = 'image/png'): string {
  const CHUNK_SIZE = 8192;
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
    const slice = bytes.subarray(i, Math.min(bytes.byteLength, i + CHUNK_SIZE));
    parts.push(String.fromCharCode.apply(null, slice as unknown as number[]));
  }
  return `data:${mime};base64,${btoa(parts.join(''))}`;
}

function extractCatalogIdsFromBlob(blob: Uint8Array | null | undefined): string[] {
  if (!blob || blob.length === 0) return [];
  const results: string[] = [];

  const addMatches = (text: string) => {
    const re = /\.:\d+:\d+:[a-zA-Z0-9-]+/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (!results.includes(match[0])) {
        results.push(match[0]);
      }
    }
    const uuidRe = /[a-f0-9]{10}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{10}/gi;
    while ((match = uuidRe.exec(text)) !== null) {
      if (!results.includes(match[0])) {
        results.push(match[0]);
      }
    }
  };

  try {
    addMatches(new TextDecoder('utf-16le', { fatal: false }).decode(blob));
  } catch {
    // Ignore
  }
  try {
    addMatches(new TextDecoder('utf-16be', { fatal: false }).decode(blob));
  } catch {
    // Ignore
  }
  try {
    addMatches(new TextDecoder('latin1', { fatal: false }).decode(blob));
  } catch {
    // Ignore
  }

  return results;
}

export interface DecodedEffector {
  usePressure: boolean;
  useTilt: boolean;
  useVelocity: boolean;
  useRandom: boolean;
  minValue: number;
  maxValue: number;
  pressureCurve?: [number, number][];
  tiltCurve?: [number, number][];
  velocityCurve?: [number, number][];
}

export function parseCspEffector(blob: Uint8Array | null | undefined): DecodedEffector | null {
  if (!blob || blob.length < 44) return null;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);

  const sourceFlags = view.getUint32(8, false);
  const usePressure = Boolean(sourceFlags & 0x10);
  const useTilt = Boolean(sourceFlags & 0x20);
  const useVelocity = Boolean(sourceFlags & 0x80);
  const useRandom = Boolean(sourceFlags & 0x01);

  const rawMin = view.getUint32(12, false);
  const rawMax = view.getUint32(16, false);
  const minValue = Math.max(0, Math.min(1.0, rawMin / 100.0));
  const maxValue = rawMax > 0 ? Math.max(0, Math.min(1.0, rawMax / 100.0)) : 1.0;

  const curves: [number, number][][] = [];
  const headerLen = view.getUint32(0, false);
  let offset = headerLen >= 44 && headerLen <= blob.length ? headerLen : 48;
  if (offset + 12 <= blob.length && view.getUint32(offset, false) !== 12 && blob.length >= 56 && view.getUint32(44, false) === 12) {
    offset = 44;
  }

  while (offset + 12 <= blob.length) {
    const magic = view.getUint32(offset, false);
    const numPts = view.getUint32(offset + 4, false);
    const ptSize = view.getUint32(offset + 8, false);

    if (magic !== 12 || ptSize !== 16 || numPts > 256 || offset + 12 + numPts * 16 > blob.length) {
      break;
    }

    offset += 12;
    const pts: [number, number][] = [];
    for (let i = 0; i < numPts; i++) {
      const x = view.getFloat64(offset, false);
      const y = view.getFloat64(offset + 8, false);
      pts.push([Math.max(0, Math.min(1.0, x)), Math.max(0, Math.min(1.0, y))]);
      offset += 16;
    }
    if (pts.length > 0) {
      curves.push(pts);
    }
  }

  let curveIdx = 0;
  let pressureCurve: [number, number][] | undefined = undefined;
  let tiltCurve: [number, number][] | undefined = undefined;
  let velocityCurve: [number, number][] | undefined = undefined;

  if (usePressure && curveIdx < curves.length) {
    pressureCurve = curves[curveIdx++];
  }
  if (useTilt && curveIdx < curves.length) {
    tiltCurve = curves[curveIdx++];
  }
  if (useVelocity && curveIdx < curves.length) {
    velocityCurve = curves[curveIdx++];
  }

  return {
    usePressure,
    useTilt,
    useVelocity,
    useRandom,
    minValue,
    maxValue,
    pressureCurve,
    tiltCurve,
    velocityCurve,
  };
}

function effectorToSensorConfig(eff: DecodedEffector): CspSensorConfig {
  return {
    usePressure: eff.usePressure,
    pressureMin: eff.minValue,
    pressureCurve: eff.pressureCurve,
    useTilt: eff.useTilt,
    tiltMin: eff.minValue,
    useVelocity: eff.useVelocity,
    velocityMin: eff.minValue,
    useRandom: eff.useRandom,
    randomMin: eff.minValue,
  };
}

/**
 * Evaluates a value through a Clip Studio Paint cubic Hermite spline curve (PCHIP)
 * using the O(1) precompiled Float32Array(256) LUT in CspBrushEngine.
 */
export function evaluateCspSpline(x: number, pts?: [number, number][]): number {
  return evaluateFastSpline(x, pts);
}

/**
 * Normalizes brush tip alpha and transparency.
 */
export async function processBrushTipImage(
  dataUrl: string,
  fallbackProcedural?: { hardness: number; thickness: number; antiAlias: number }
): Promise<{ dataUrl: string; width: number; height: number; isColor: boolean }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w === 0 || h === 0) {
        if (fallbackProcedural) {
          const proc = generateProceduralTip(
            fallbackProcedural.hardness,
            fallbackProcedural.thickness,
            fallbackProcedural.antiAlias
          );
          resolve({ dataUrl: proc.dataUrl, width: proc.width, height: proc.height, isColor: false });
        } else {
          resolve({ dataUrl, width: 64, height: 64, isColor: false });
        }
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve({ dataUrl, width: w, height: h, isColor: false });
        return;
      }

      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;

      let hasAlpha = false;
      let hasColor = false;
      let maxAlpha = 0;
      let nonZeroCount = 0;

      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a > maxAlpha) maxAlpha = a;
        if (a > 0) nonZeroCount++;
        if (a < 240) {
          hasAlpha = true;
        }
        if (a > 20) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          if (Math.abs(r - g) > 20 || Math.abs(g - b) > 20 || Math.abs(r - b) > 20) {
            hasColor = true;
          }
        }
      }

      if (maxAlpha === 0 || nonZeroCount === 0) {
        const proc = generateProceduralTip(
          fallbackProcedural?.hardness ?? 1.0,
          fallbackProcedural?.thickness ?? 1.0,
          fallbackProcedural?.antiAlias ?? 2
        );
        resolve({ dataUrl: proc.dataUrl, width: proc.width, height: proc.height, isColor: false });
        return;
      }

      if (!hasAlpha) {
        for (let i = 0; i < data.length; i += 4) {
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          const alpha = Math.max(0, Math.min(255, Math.round(255 - lum)));
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          data[i + 3] = alpha;
        }
        ctx.putImageData(imgData, 0, 0);
        resolve({ dataUrl: canvas.toDataURL('image/png'), width: w, height: h, isColor: false });
      } else if (!hasColor) {
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
        resolve({ dataUrl: canvas.toDataURL('image/png'), width: w, height: h, isColor: false });
      } else {
        resolve({ dataUrl, width: w, height: h, isColor: true });
      }
    };

    img.onerror = () => {
      if (fallbackProcedural) {
        const proc = generateProceduralTip(
          fallbackProcedural.hardness,
          fallbackProcedural.thickness,
          fallbackProcedural.antiAlias
        );
        resolve({ dataUrl: proc.dataUrl, width: proc.width, height: proc.height, isColor: false });
      } else {
        resolve({ dataUrl, width: 64, height: 64, isColor: false });
      }
    };

    img.src = dataUrl;
  });
}

/**
 * Generates an authentic Clip Studio Paint procedural tip.
 */
export function generateProceduralTip(
  hardness: number = 1.0,
  thickness: number = 1.0,
  antiAlias: number = 2
): { dataUrl: string; width: number; height: number } {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { dataUrl: '', width: size, height: size };

  const cx = size / 2;
  const cy = size / 2;
  const rx = size / 2 - 2;
  const ry = Math.max(1, rx * thickness);

  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;

  const hNorm = Math.max(0.05, Math.min(1.0, hardness));
  const isBinary = antiAlias === 0;

  for (let y = 0; y < size; y++) {
    const dy = (y - cy) / ry;
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / rx;
      const dist = Math.hypot(dx, dy);
      if (dist <= 1.0) {
        let alpha = 1.0;
        if (dist > hNorm) {
          alpha = 1.0 - (dist - hNorm) / (1.0 - hNorm);
          alpha = alpha * alpha * (3 - 2 * alpha);
        }
        if (isBinary) {
          alpha = alpha > 0.5 ? 1.0 : 0.0;
        }
        if (alpha > 0.001) {
          const idx = (y * size + x) * 4;
          data[idx] = 255;
          data[idx + 1] = 255;
          data[idx + 2] = 255;
          data[idx + 3] = Math.round(alpha * 255);
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: size,
    height: size,
  };
}

function mapFlipMode(val: unknown): CspTipFlipMode {
  const n = Number(val);
  if (n === 1 || n === 2) return 'alternate';
  if (n === 3) return 'random';
  return 'none';
}

export interface DecodedInOutTarget {
  affectSize: boolean;
  minSizeRatio: number;
  affectDensity: boolean;
  minDensityRatio: number;
  affectOpacity: boolean;
  affectAmountOfPaint: boolean;
  minAmountRatio: number;
  affectDensityOfPaint: boolean;
  minPaintDensityRatio: number;
}

/**
 * Parses CSP Variant.BrushInOutTarget binary table:
 * [header: magic(u32BE=12), count(u32BE), entrySize(u32BE=12)]
 * followed by `count` entries of [paramId(u32BE), enabled(u32BE), minVal(u32BE)].
 * Exact CSP param IDs (ordered by Sub Tool Detail -> Starting and Ending):
 *  - 0x03e9 (1001): Opacity
 *  - 0x03fd (1021): Brush Size (minVal in 0..100%)
 *  - 0x0411 (1041): Brush Density / Flow (minVal in 0..100%)
 *  - 0x043a (1082): Amount of Paint / BrushMixColor (minVal in 0..100%)
 *  - 0x043c (1084): Density of Paint / BrushMixAlpha (minVal in 0..100%)
 */
export function parseCspInOutTarget(blob: Uint8Array | null | undefined): DecodedInOutTarget | null {
  if (!blob || blob.length < 12) return null;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const magic = view.getUint32(0, false);
  const count = view.getUint32(4, false);
  const entrySize = view.getUint32(8, false);
  if (magic !== 12 || entrySize !== 12 || count === 0 || 12 + count * 12 > blob.length) {
    return null;
  }

  let affectSize = false;
  let minSizeRatio = 0;
  let affectDensity = false;
  let minDensityRatio = 0;
  let affectOpacity = false;
  let affectAmountOfPaint = false;
  let minAmountRatio = 0;
  let affectDensityOfPaint = false;
  let minPaintDensityRatio = 0;
  let anyEnabled = false;

  for (let i = 0; i < count; i++) {
    const off = 12 + i * 12;
    const paramId = view.getUint32(off, false);
    const enabled = view.getUint32(off + 4, false) !== 0;
    const val = view.getUint32(off + 8, false);
    if (!enabled) continue;
    anyEnabled = true;
    const norm = Math.max(0, Math.min(1, val / 100));
    if (paramId === 0x03fd) {
      affectSize = true;
      minSizeRatio = norm;
    } else if (paramId === 0x03e9 || paramId === 0x03fc) {
      affectOpacity = true;
    } else if (paramId === 0x0411) {
      affectDensity = true;
      minDensityRatio = norm;
    } else if (paramId === 0x043a) {
      affectAmountOfPaint = true;
      minAmountRatio = norm;
    } else if (paramId === 0x043c) {
      affectDensityOfPaint = true;
      minPaintDensityRatio = norm;
    }
  }

  if (!anyEnabled) return null;
  return {
    affectSize,
    minSizeRatio,
    affectDensity,
    minDensityRatio,
    affectOpacity,
    affectAmountOfPaint,
    minAmountRatio,
    affectDensityOfPaint,
    minPaintDensityRatio,
  };
}

function mapTextureMode(val: unknown): CspPaperTextureMode {
  const n = Number(val);
  // CSP TextureCompositeMode: 0=Normal, 1=Multiply, 2=Subtract, 3=Compare density,
  // 4=Overlay, 5=Color burn, 6=Linear burn, 7=Height, 8=Outline
  if (n === 0 || n === 1 || n === 5 || n === 6) return 'multiply';
  if (n === 2) return 'subtract';
  if (n === 3 || n === 7) return 'compare';
  if (n === 4) return 'overlay';
  if (n === 8) return 'outline';
  return 'multiply';
}

/**
 * Parses a Clip Studio Paint .sut (Sub Tool) brush file.
 */
export async function parseSutFile(
  fileBuffer: ArrayBuffer | Uint8Array,
  fileName: string = 'Brush.sut'
): Promise<CspBrush> {
  const rawBytes = fileBuffer instanceof Uint8Array ? fileBuffer : new Uint8Array(fileBuffer);
  if (!isNativeRustAvailable()) {
    throw new Error('Parsing .sut files requires the native desktop Rust SQLite backend.');
  }

  const extracted = await parseSutSqliteNative(rawBytes);
  return parseSutExtractedData(extracted, fileName);
}

/**
 * Pure mapper from extracted SQLite rows (Node/Variant/MaterialFile) to CspBrush.
 * Exported directly for deterministic unit testing without Tauri IPC.
 */
export async function parseSutExtractedData(
  extracted: NativeSutExtract,
  fileName: string = 'Brush.sut'
): Promise<CspBrush> {
  let brushName = extracted.nodeName || fileName.replace(/\.sut$/i, '').trim();

  let brushSize = 16;
  let minSizeFactor = 0.2;
  let opacity = 1.0;
  let flow = 0.85;
  let adjustDensityByGap = false;
  let blendTipsMode: CspBlendTipsMode = 'darken';
  let spacing = 0.08;
  let hardness = 1.0;
  let thickness = 1.0;
  let thicknessVertical = false;
  let flipH: CspTipFlipMode = 'none';
  let flipV: CspTipFlipMode = 'none';
  let angle = 0;
  let angleDynamics: CspAngleDynamicsMode = 'none';
  let rotationRandomScale = 0;
  let antiAlias = 2;
  let stabilization = 0;
  let postCorrection = 0;
  let sharpCorners = true;
  let usePressure = true;
  let useVelocity = false;
  let useTilt = false;
  let pressureCurve: [number, number][] | undefined = undefined;
  let velocityCurve: [number, number][] | undefined = undefined;
  let sizeSensor: CspSensorConfig | undefined = undefined;
  let opacitySensor: CspSensorConfig | undefined = undefined;
  let densitySensor: CspSensorConfig | undefined = undefined;
  let colorMixing = false;
  let perceptualMixing = false;
  let amountOfPaint = 0.7;
  let densityOfPaint = 0.8;
  let colorStretch = 0.6;
  let mixingMode: 'blend' | 'running_color' | 'smear' = 'blend';
  let wetEdge = 0;
  let wetEdgeRadius = 3.0;
  let wetEdgeAlphaPower = 20;
  let wetEdgeValuePower = 0;
  let textureDensity = 0;
  let paperTextureScale = 1.0;
  let paperTextureRotate = 0;
  let paperTextureMode: CspPaperTextureMode = 'multiply';
  let paperTextureBrightness = 0;
  let paperTextureContrast = 0;
  let paperTextureApplyEachPlot = false;
  let paperTextureInverted = false;
  let spray: CspSpraySettings | undefined = undefined;
  let taper: CspTaperSettings | undefined = undefined;
  let isRibbon = false;
  let dualBrush = false;
  let dualBrushCompositeMode = 'multiply';
  let usePatternImage: boolean | null = null;
  let rawPatternArrayBlob: Uint8Array | null = null;
  let rawTextureImageBlob: Uint8Array | null = null;
  let rawDualPatternBlob: Uint8Array | null = null;

  if (extracted.variantValues.size > 0) {
    try {
      {
        const getVal = (aliases: string[]): any => {
          for (const a of aliases) {
            const v = extracted.variantValues.get(a.toLowerCase());
            if (v !== undefined && v !== null) {
              return v;
            }
          }
          return null;
        };

          // Size
          const rawSize = getVal(['BrushSize', 'Size', 'PenSize', 'BrushSizeVal', 'LineWidth']);
          if (typeof rawSize === 'number' && rawSize > 0) {
            if (rawSize > 500) {
              brushSize = Math.max(1, Math.min(500, rawSize / 100));
            } else if (rawSize > 250) {
              brushSize = Math.max(1, Math.min(500, rawSize / 10));
            } else {
              brushSize = Math.max(0.5, Math.min(500, rawSize));
            }
          }

          // Size Dynamics Effector
          const sizeEffBlob = getVal(['BrushSizeEffector', 'SizeEffector']);
          if (sizeEffBlob instanceof Uint8Array) {
            const eff = parseCspEffector(sizeEffBlob);
            if (eff) {
              usePressure = eff.usePressure;
              useVelocity = eff.useVelocity;
              useTilt = eff.useTilt;
              minSizeFactor = eff.minValue;
              pressureCurve = eff.pressureCurve;
              velocityCurve = eff.velocityCurve;
              sizeSensor = effectorToSensorConfig(eff);
            }
          }

          // Opacity & Density Effectors
          const opacityEffBlob = getVal(['OpacityEffector', 'BrushOpacityEffector']);
          if (opacityEffBlob instanceof Uint8Array) {
            const eff = parseCspEffector(opacityEffBlob);
            if (eff && (eff.usePressure || eff.useTilt || eff.useVelocity || eff.useRandom)) {
              opacitySensor = effectorToSensorConfig(eff);
            }
          }

          const densityEffBlob = getVal(['BrushDensityEffector', 'BrushFlowEffector', 'DensityEffector']);
          if (densityEffBlob instanceof Uint8Array) {
            const eff = parseCspEffector(densityEffBlob);
            if (eff && (eff.usePressure || eff.useTilt || eff.useVelocity || eff.useRandom)) {
              densitySensor = effectorToSensorConfig(eff);
            }
          }

          // Spacing / Interval (CSP BrushAutoIntervalType: 0=Fixed %, 1=Wide, 2=Normal, 3=Narrow)
          const rawAutoInterval = getVal(['BrushAutoIntervalType']);
          const rawSpacing = getVal(['BrushInterval', 'Interval', 'Spacing', 'BrushSpacing']);
          if (typeof rawAutoInterval === 'number' && rawAutoInterval > 0) {
            if (rawAutoInterval === 1) spacing = 0.25;
            else if (rawAutoInterval === 2) spacing = 0.1;
            else if (rawAutoInterval === 3) spacing = 0.04;
          } else if (typeof rawSpacing === 'number' && rawSpacing > 0) {
            // In CSP, BrushInterval in Fixed mode is ALWAYS a percentage (0.1%..200% -> 0.001..2.0)
            spacing = Math.max(0.003, Math.min(2.0, rawSpacing / 100));
          }

          // Opacity (strictly stroke ceiling opacity, distinct from BrushDensity!)
          const rawOpacity = getVal(['Opacity', 'BrushOpacity']);
          if (typeof rawOpacity === 'number' && rawOpacity > 0) {
            opacity = rawOpacity > 1.0 ? Math.min(1.0, rawOpacity / 100) : rawOpacity;
          }

          // Brush Density / Flow (per-dab alpha)
          const rawFlow = getVal(['BrushDensity', 'Density', 'BrushFlow', 'Flow', 'InkAmount']);
          if (typeof rawFlow === 'number' && rawFlow > 0) {
            flow = rawFlow > 1.0 ? Math.min(1.0, rawFlow / 100) : rawFlow;
          }

          const rawAdjustGap = getVal(['BrushAdjustFlowByInterval', 'BrushAdjustDensityByGap', 'AdjustDensityByGap']);
          if (rawAdjustGap !== null) {
            adjustDensityByGap = Boolean(rawAdjustGap);
          }

          const rawBlendTips = getVal(['BlendBrushTips', 'BrushCombineMode', 'BrushBlendMode']);
          if (rawBlendTips !== null && Number(rawBlendTips) === 1) {
            blendTipsMode = 'compare';
          }

          // Hardness
          const rawHardness = getVal(['BrushHardness', 'Hardness']);
          if (typeof rawHardness === 'number' && rawHardness > 0) {
            hardness =
              rawHardness <= 5
                ? Math.max(0.05, Math.min(1.0, rawHardness / 5))
                : Math.max(0.05, Math.min(1.0, rawHardness / 100));
          }

          // Thickness & Flip
          const rawThickness = getVal(['BrushThickness', 'Thickness']);
          if (typeof rawThickness === 'number' && rawThickness > 0) {
            thickness = Math.max(0.05, Math.min(1.0, rawThickness / 100));
          }
          const rawVertThick = getVal(['BrushVerticalThicknes', 'BrushVerticalThickness', 'VerticalThickness']);
          if (rawVertThick !== null) {
            thicknessVertical = Boolean(rawVertThick);
          }

          const rawFlipH = getVal(['BrushPatternReverseHorizontal', 'BrushFlipX', 'FlipHorizontal']);
          if (rawFlipH !== null) flipH = mapFlipMode(rawFlipH);
          const rawFlipV = getVal(['BrushPatternReverseVertical', 'BrushFlipY', 'FlipVertical']);
          if (rawFlipV !== null) flipV = mapFlipMode(rawFlipV);

          // Rotation & Rotation Dynamics
          // CSP BrushRotationEffector low nibble: 1=None, 2=Pen direction (tilt), 3=Direction of line, 4=Random, 5=Pen rotation (twist)
          const rawAngle = getVal(['BrushRotation', 'Rotation', 'BrushAngle', 'Angle']);
          if (typeof rawAngle === 'number') {
            angle = ((rawAngle % 360) + 360) % 360;
          }

          const rawRotEff = getVal(['BrushRotationEffector', 'RotationEffector', 'AngleDynamics']);
          if (typeof rawRotEff === 'number') {
            const rotMode = rawRotEff & 0x0f;
            if (rotMode === 3) {
              angleDynamics = 'direction';
            } else if (rotMode === 2) {
              angleDynamics = 'tilt';
              useTilt = true;
            } else if (rotMode === 4) {
              angleDynamics = 'random';
            } else if (rotMode === 5) {
              angleDynamics = 'twist';
            } else if (rotMode === 1) {
              angleDynamics = 'none';
            } else if (rawRotEff & 0x80) {
              angleDynamics = 'direction';
            } else if (rawRotEff & 0x20) {
              angleDynamics = 'tilt';
              useTilt = true;
            }
          }

          // CSP stores BrushRotationRandomScale=100 by default even when Random rotation is OFF!
          // Only apply random scale when random rotation mode is explicitly enabled.
          if (angleDynamics === 'random') {
            const rawRandRot = getVal(['BrushRotationRandomScale', 'RotationRandomScale']);
            if (typeof rawRandRot === 'number' && rawRandRot > 0) {
              rotationRandomScale = Math.min(1.0, rawRandRot / 100);
            }
          } else {
            rotationRandomScale = 0;
          }

          // CSP "Direction of line" aligns 12 o'clock (-Y) with the stroke tangent,
          // whereas Ink Studio aligns 3 o'clock (+X) with atan2(dy, dx). Offset +90 deg to match CSP exactly.
          if (angleDynamics === 'direction') {
            angle = (angle + 90) % 360;
          }

          // Anti-Aliasing
          const rawAA = getVal(['AntiAlias', 'BrushAntiAlias']);
          if (typeof rawAA === 'number') {
            antiAlias = Math.max(0, Math.min(3, Math.round(rawAA)));
          }

          // Stabilization & Post-Correction
          const rawRev = getVal(['FlickerReduction', 'BrushStabilization']);
          if (typeof rawRev === 'number' && rawRev >= 0) {
            stabilization = Math.min(50, Math.max(0, Math.round(rawRev)));
          }
          const rawUseRev = getVal(['BrushUseRevision']);
          const rawPostCorr = getVal(['BrushRevision', 'BrushPostCorrection', 'PostCorrection']);
          if (Boolean(rawUseRev) && typeof rawPostCorr === 'number' && rawPostCorr >= 0) {
            postCorrection = Math.min(5, Math.max(0, Math.round(rawPostCorr / 2)));
          }
          const rawSharp = getVal(['BrushSharpenCorner', 'BrushSharpAngles', 'SharpAngles']);
          if (rawSharp !== null) {
            sharpCorners = Boolean(rawSharp);
          }

          // Ribbon Mode
          const rawRibbon = getVal(['BrushRibbon', 'Ribbon']);
          if (rawRibbon !== null) {
            isRibbon = Boolean(rawRibbon);
          }

          // Color Mixing & Smear
          const rawMixing = getVal([
            'BrushUseWaterColor',
            'BrushUseWaterColor2',
            'ColorMixing',
            'EnableColorMixing',
          ]);
          if (rawMixing !== null) {
            colorMixing = Boolean(rawMixing);
          }

          const rawMixColor = getVal([
            'BrushMixColor',
            'AmountOfPaint',
            'PaintAmount',
            'ColorMixAmount',
          ]);
          if (typeof rawMixColor === 'number' && rawMixColor >= 0) {
            amountOfPaint = rawMixColor > 1.0 ? Math.min(1.0, rawMixColor / 100) : rawMixColor;
          }

          const rawMixAlpha = getVal(['BrushMixAlpha', 'DensityOfPaint', 'PaintDensity']);
          if (typeof rawMixAlpha === 'number' && rawMixAlpha >= 0) {
            densityOfPaint = rawMixAlpha > 1.0 ? Math.min(1.0, rawMixAlpha / 100) : rawMixAlpha;
          }

          const rawMixExt = getVal(['BrushMixColorExtension', 'ColorStretch', 'Stretch']);
          if (typeof rawMixExt === 'number' && rawMixExt >= 0) {
            colorStretch = rawMixExt > 1.0 ? Math.min(1.0, rawMixExt / 100) : rawMixExt;
          }

          // CSP Variant.BrushWaterColor selects Mixing Mode: 0=Blend, 1=Running color, 2=Smear/Blur.
          // CSP Variant.BrushColorMixingMode (CSP 2.0+) selects Color Space: 0=Standard, 1=Perceptual.
          const rawMixMode = getVal(['BrushWaterColor', 'MixingMode']);
          if (rawMixMode !== null) {
            const m = Number(rawMixMode);
            mixingMode = m === 2 ? 'smear' : m === 1 ? 'running_color' : 'blend';
          }
          const rawColorSpaceMode = getVal(['BrushColorMixingMode', 'PerceptualMixing']);
          if (rawColorSpaceMode !== null) {
            perceptualMixing = Number(rawColorSpaceMode) === 1;
          }

          // Wet Edge (strictly gated on BrushUseWaterEdge!)
          const rawWetEdge = getVal(['BrushUseWaterEdge', 'UseWaterEdge']);
          const wetEdgeEnabled = Boolean(rawWetEdge);
          const rawWetRad = getVal(['BrushWaterEdgeRadius', 'WaterEdgeRadius']);
          if (typeof rawWetRad === 'number' && rawWetRad > 0) {
            wetEdgeRadius = rawWetRad;
          }
          const rawWetAlpha = getVal(['BrushWaterEdgeAlphaPower', 'WaterEdgeAlphaPower']);
          if (typeof rawWetAlpha === 'number' && rawWetAlpha > 0) {
            wetEdgeAlphaPower = rawWetAlpha;
          }
          const rawWetVal = getVal(['BrushWaterEdgeValuePower', 'WaterEdgeValuePower']);
          if (typeof rawWetVal === 'number' && rawWetVal > 0) {
            wetEdgeValuePower = rawWetVal;
          }
          wetEdge = wetEdgeEnabled
            ? Math.max(0.15, Math.min(1.0, (wetEdgeAlphaPower || 75) / 100))
            : 0;

          // Paper Grain / Texture
          const rawTexDensity = getVal(['TextureDensity', 'Grain', 'BrushTextureDensity']);
          if (typeof rawTexDensity === 'number' && rawTexDensity > 0) {
            textureDensity =
              rawTexDensity > 1.0 ? Math.min(1.0, rawTexDensity / 100) : rawTexDensity;
          }
          const rawTexScale = getVal(['TextureScale2', 'TextureScale']);
          if (typeof rawTexScale === 'number' && rawTexScale > 0) {
            paperTextureScale = rawTexScale / 100;
          }
          const rawTexRotate = getVal(['TextureRotate']);
          if (typeof rawTexRotate === 'number') {
            paperTextureRotate = rawTexRotate;
          }
          const rawTexMode = getVal(['TextureCompositeMode', 'TextureMode', 'BrushTextureMode']);
          if (rawTexMode !== null) {
            paperTextureMode = mapTextureMode(rawTexMode);
          }
          const rawTexInvert = getVal(['TextureReverseDensity', 'TextureInvert', 'BrushTextureInvert']);
          if (rawTexInvert !== null) {
            paperTextureInverted = Boolean(rawTexInvert);
          }
          const rawTexForPlot = getVal(['TextureForPlot']);
          if (rawTexForPlot !== null) {
            paperTextureApplyEachPlot = Boolean(rawTexForPlot);
          }
          const rawTexBright = getVal(['TextureBrightness']);
          if (typeof rawTexBright === 'number') {
            paperTextureBrightness = Math.max(-100, Math.min(100, rawTexBright));
          }
          const rawTexContrast = getVal(['TextureContrast']);
          if (typeof rawTexContrast === 'number') {
            paperTextureContrast = Math.max(-100, Math.min(100, rawTexContrast));
          }

          // Spray / Airbrush
          const rawSpray = getVal(['BrushUseSpray', 'UseSpray']);
          if (Boolean(rawSpray)) {
            const rawSpraySize = getVal(['BrushSpraySize', 'SpraySize']) || 2.0;
            const rawSprayDensity = getVal(['BrushSprayDensity', 'SprayDensity']) || 5;
            const rawSprayBias = getVal(['BrushSprayBias', 'SprayBias']) || 0;
            spray = {
              enabled: true,
              size: typeof rawSpraySize === 'number' ? Math.max(1, rawSpraySize) : 2.0,
              density:
                typeof rawSprayDensity === 'number'
                  ? Math.max(1, Math.min(50, rawSprayDensity))
                  : 5,
              bias:
                typeof rawSprayBias === 'number'
                  ? Math.max(-1, Math.min(1, rawSprayBias / 100))
                  : 0,
            };
          }

          // Taper (Starting and Ending)
          const rawUseIn = getVal(['BrushUseIn']);
          const rawUseOut = getVal(['BrushUseOut']);
          const useIn = rawUseIn !== null ? Boolean(rawUseIn) : false;
          const useOut = rawUseOut !== null ? Boolean(rawUseOut) : false;
          const inLength = Number(getVal(['BrushInLength']) || 0);
          const rawInRatio = Number(getVal(['BrushInRatio']) || 0);
          const inRatio = rawInRatio > 1 ? Math.min(1, rawInRatio / 100) : Math.max(0, rawInRatio);
          const outLength = Number(getVal(['BrushOutLength']) || 0);
          const rawOutRatio = Number(getVal(['BrushOutRatio']) || 0);
          const outRatio = rawOutRatio > 1 ? Math.min(1, rawOutRatio / 100) : Math.max(0, rawOutRatio);
          const inOutType = Number(getVal(['BrushInOutType']) || 0);
          const inOutBySpeed = Boolean(getVal(['BrushInOutBySpeed']));
          const decodedInOut = parseCspInOutTarget(getVal(['BrushInOutTarget']));

          if ((useIn || useOut) && inOutType !== 0) {
            taper = {
              useIn,
              inLength,
              inRatio,
              useOut,
              outLength,
              outRatio,
              inOutType,
              inOutBySpeed,
              affectSize: decodedInOut ? decodedInOut.affectSize : true,
              minSizeRatio: decodedInOut ? decodedInOut.minSizeRatio : 0,
              affectDensity: decodedInOut ? decodedInOut.affectDensity : false,
              minDensityRatio: decodedInOut ? decodedInOut.minDensityRatio : 0,
              affectOpacity: decodedInOut ? decodedInOut.affectOpacity : false,
              affectAmountOfPaint: decodedInOut ? decodedInOut.affectAmountOfPaint : false,
              minAmountRatio: decodedInOut ? decodedInOut.minAmountRatio : 0,
              affectDensityOfPaint: decodedInOut ? decodedInOut.affectDensityOfPaint : false,
              minPaintDensityRatio: decodedInOut ? decodedInOut.minPaintDensityRatio : 0,
            };
          }

          // Dual Brush
          const rawDual = getVal(['UseDualBrush']);
          if (Boolean(rawDual)) {
            dualBrush = true;
          }
          const rawDualMode = getVal(['DualBrushCompositeMode', 'DualBrushMode', 'DualCompositeMode']);
          if (rawDualMode !== null) {
            const dm = Number(rawDualMode);
            if (dm === 1) dualBrushCompositeMode = 'subtract';
            else if (dm === 2) dualBrushCompositeMode = 'darken';
            else if (dm === 3) dualBrushCompositeMode = 'lighten';
            else if (dm === 4) dualBrushCompositeMode = 'screen';
          }

          const rawUsePattern = getVal(['BrushUsePatternImage']);
          if (rawUsePattern !== null) {
            usePatternImage = Boolean(rawUsePattern);
          }
          rawPatternArrayBlob = getVal(['BrushPatternImageArray']);
          rawTextureImageBlob = getVal(['TextureImage']);
          rawDualPatternBlob = getVal(['DualPatternImageArray']);
        }
      } catch {
        // Variant query fallback
      }
    }

    // 4. MaterialFile extraction (from native Rust rusqlite rows)
    interface ExtractedMaterial {
      mainPng: Uint8Array;
      catalogPath: string;
      width: number;
      height: number;
      isPaperTexture: boolean;
    }
    const materialMap = new Map<string, ExtractedMaterial>();
    const allMaterialsList: ExtractedMaterial[] = [];

    for (const mat of extracted.materials) {
      const fileData = mat.fileData;
      const catPath = mat.catalogPath || '';
      const pwId = mat.pwId;

      if (fileData.length > 0) {
        const mainPng = extractMaterialPng(fileData);
        if (mainPng) {
          let width = 64;
          let height = 64;
          if (mainPng.length >= 24) {
            const view = new DataView(mainPng.buffer, mainPng.byteOffset, mainPng.byteLength);
            width = view.getUint32(16, false);
            height = view.getUint32(20, false);
          }

          const entry: ExtractedMaterial = {
            mainPng,
            catalogPath: catPath,
            width,
            height,
            isPaperTexture: isMaterialPaperTexture(fileData),
          };
          if (catPath) materialMap.set(catPath, entry);
          materialMap.set(pwId, entry);

          const uuidMatch = catPath.match(
            /[a-f0-9]{10}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{10}/i
          );
          if (uuidMatch) {
            materialMap.set(uuidMatch[0], entry);
          }

          allMaterialsList.push(entry);
        }
      }
    }

    // 5. Match Paper Texture
    let paperTexture: string | undefined = undefined;
    let paperTextureEntry: ExtractedMaterial | null = null;

    if (rawTextureImageBlob) {
      const texIds = extractCatalogIdsFromBlob(rawTextureImageBlob);
      for (const tid of texIds) {
        if (materialMap.has(tid)) {
          paperTextureEntry = materialMap.get(tid)!;
          paperTexture = bytesToDataUrl(paperTextureEntry.mainPng, 'image/png');
          break;
        }
      }
    }
    if (!paperTexture) {
      // CSP stores TextureDensity=50 even when no texture image is bound; avoid ghost grain.
      textureDensity = 0;
    }

    // 6. Match Brush Tip(s) — NEVER hijack a PaperTexture or ignore BrushUsePatternImage=0!
    const tipPngEntries: ExtractedMaterial[] = [];

    if (usePatternImage !== false) {
      if (rawPatternArrayBlob) {
        const patternIds = extractCatalogIdsFromBlob(rawPatternArrayBlob);
        for (const pid of patternIds) {
          if (materialMap.has(pid)) {
            const entry = materialMap.get(pid)!;
            if (entry !== paperTextureEntry && !tipPngEntries.includes(entry)) {
              tipPngEntries.push(entry);
            }
          }
        }
      }

      if (tipPngEntries.length === 0 && allMaterialsList.length > 0 && usePatternImage === true) {
        for (const m of allMaterialsList) {
          if (
            m !== paperTextureEntry &&
            !m.isPaperTexture &&
            !tipPngEntries.some((e) => e.mainPng === m.mainPng)
          ) {
            tipPngEntries.push(m);
          }
        }
      }
    }

    // 7. Process extracted custom tips; for Circle tips (BrushUsePatternImage=0), leave tipDataUrl undefined
    // so BrushEngine renders its analytical/SDF circular/elliptical tip at native crisp resolution
    // without double-applying thickness!
    let tipDataUrl: string | undefined = undefined;
    let tipWidth: number | undefined = undefined;
    let tipHeight: number | undefined = undefined;
    let isColorTip = false;
    const subTips: CspSubTip[] = [];
    const fallbackProc = { hardness, thickness: 1.0, antiAlias };

    if (tipPngEntries.length > 0) {
      const primaryEntry = tipPngEntries[0];
      const rawUrl = bytesToDataUrl(primaryEntry.mainPng, 'image/png');
      const processed = await processBrushTipImage(rawUrl, fallbackProc);
      tipDataUrl = processed.dataUrl;
      tipWidth = processed.width;
      tipHeight = processed.height;
      isColorTip = processed.isColor;

      for (const entry of tipPngEntries) {
        const u = bytesToDataUrl(entry.mainPng, 'image/png');
        const p = await processBrushTipImage(u, fallbackProc);
        subTips.push({
          dataUrl: p.dataUrl,
          width: p.width,
          height: p.height,
          isColor: p.isColor,
        });
      }
    }

    let secondaryTipDataUrl: string | undefined = undefined;
    let secondaryTipWidth: number | undefined = undefined;
    let secondaryTipHeight: number | undefined = undefined;

    if (dualBrush && rawDualPatternBlob) {
      const dualIds = extractCatalogIdsFromBlob(rawDualPatternBlob);
      for (const did of dualIds) {
        if (materialMap.has(did)) {
          const entry = materialMap.get(did)!;
          const u = bytesToDataUrl(entry.mainPng, 'image/png');
          const p = await processBrushTipImage(u, fallbackProc);
          secondaryTipDataUrl = p.dataUrl;
          secondaryTipWidth = p.width;
          secondaryTipHeight = p.height;
          break;
        }
      }
    }

    const uniqueId = `csp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    const cspBrush: CspBrush = {
      id: uniqueId,
      name: brushName,
      badge: 'CSP',
      desc: tipPngEntries.length > 0 ? 'Clip Studio Paint Textured Brush' : 'Clip Studio Paint Brush',
      tipDataUrl,
      tipWidth,
      tipHeight,
      isColorTip,
      secondaryTipDataUrl,
      secondaryTipWidth,
      secondaryTipHeight,
      subTips: subTips.length > 1 ? subTips : undefined,
      size: brushSize,
      minSizeFactor,
      opacity,
      flow,
      adjustDensityByGap,
      blendTipsMode,
      spacing,
      hardness,
      thickness,
      thicknessVertical,
      flipH,
      flipV,
      angle,
      angleDynamics,
      rotationRandomScale,
      antiAlias,
      usePressure,
      useVelocity,
      useTilt,
      sizeSensor,
      opacitySensor,
      densitySensor,
      smoothing: true,
      stabilization,
      postCorrection,
      sharpCorners,
      pressureCurve,
      velocityCurve,
      colorMixing,
      perceptualMixing,
      amountOfPaint,
      densityOfPaint,
      colorStretch,
      mixingMode,
      wetEdge,
      wetEdgeRadius,
      wetEdgeAlphaPower,
      wetEdgeValuePower,
      paperTexture,
      textureDensity,
      paperTextureScale,
      paperTextureRotate,
      paperTextureMode,
      paperTextureBrightness,
      paperTextureContrast,
      paperTextureApplyEachPlot,
      paperTextureInverted,
      dualBrush,
      dualBrushCompositeMode,
      spray,
      taper,
      isRibbon,
      pressureCurveGamma: 1.0,
      importedAt: Date.now(),
    };

    return cspBrush;
}
