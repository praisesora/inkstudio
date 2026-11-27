import { unzlibSync, inflateSync } from 'fflate';
import {
  BrushDynamics,
  CspAngleDynamicsMode,
  CspBlendTipsMode,
  CspBrush,
  CspBrushCombineMode,
  CspDualBrushConfig,
  CspPaperTextureMode,
  CspSensorConfig,
  CspSpraySettings,
  CspSubTip,
  CspSubTipOrder,
  CspTaperSettings,
  CspTipFlipMode,
  DEFAULT_BRUSH_DYNAMICS,
  GrainMappingMode,
} from '../types/editor';
import { evaluateFastSpline } from '../engine/BrushEngine';
import { normalizeDualBrushCompositeMode } from '../engine/DualBrushEngine';
import {
  CspExpressionColor,
  isNativeRustAvailable,
  NativeSutExtract,
  parseSutSqliteNative,
} from './nativeBackend';

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

const CSP_UUID_RE = /[a-f0-9]{10}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{10}/gi;
const CSP_CATALOG_PATH_RE = /\.:[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_.-]+){2,}/g;

function extractCatalogIdsFromBlob(blob: Uint8Array | null | undefined): string[] {
  if (!blob || blob.length === 0) return [];
  const catalogPaths: string[] = [];
  const standaloneUuids: string[] = [];

  const addMatches = (text: string) => {
    CSP_CATALOG_PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CSP_CATALOG_PATH_RE.exec(text)) !== null) {
      if (!catalogPaths.includes(match[0])) {
        catalogPaths.push(match[0]);
      }
    }
    CSP_UUID_RE.lastIndex = 0;
    while ((match = CSP_UUID_RE.exec(text)) !== null) {
      if (!standaloneUuids.includes(match[0])) {
        standaloneUuids.push(match[0]);
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

  const results = [...catalogPaths];
  for (const uuid of standaloneUuids) {
    const lowerUuid = uuid.toLowerCase();
    const alreadyCovered = catalogPaths.some((p) => p.toLowerCase().includes(lowerUuid));
    if (!alreadyCovered) {
      results.push(uuid);
    }
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
  pressureMin: number;
  tiltMin: number;
  tiltMax: number;
  velocityMin: number;
  randomMin: number;
  invertTilt: boolean;
  invertVelocity: boolean;
  sourceFlags: number;
  pressureCurve?: [number, number][];
  tiltCurve?: [number, number][];
  velocityCurve?: [number, number][];
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function parseCspEffector(blob: Uint8Array | null | undefined): DecodedEffector | null {
  if (!blob || blob.length < 44) return null;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);

  const headerLen = view.getUint32(0, false);
  const sourceFlags = view.getUint32(8, false);
  // Real CSP Effector source bitmask (verified across CSP .sut Variant blobs):
  //  0x10 = Pen Pressure
  //  0x20 = Tilt
  //  0x40 = Velocity
  //  0x80 = Random (legacy synthetic fallback: 0x01)
  const usePressure = Boolean(sourceFlags & 0x10);
  const useTilt = Boolean(sourceFlags & 0x20);
  const useVelocity = Boolean(sourceFlags & 0x40);
  const useRandom = Boolean(sourceFlags & (0x80 | 0x01));

  // CSP's 48-byte big-endian Effector header layout:
  //  [0]  headerLen (48 = 0x30)
  //  [4]  supportedSourcesMask (0x0f0 or 0x1f0)
  //  [8]  sourceFlags (0x10=Pressure, 0x20=Tilt, 0x40=Velocity, 0x80=Random)
  //  [12] pressureMin (0..100)
  //  [16] tiltMin (0..100)
  //  [20] velocityMin (0..100)
  //  [24] randomMin (signed i32: 0..100, or -100 for Hue/Sat/Val color jitter effectors)
  //  [28] reserved / 5th source min (0)
  //  [32] pressureCurveByteLen (0 or 12 + numPts * 16)
  //  [36] tiltCurveByteLen (0 or 12 + numPts * 16)
  //  [40] maxScale / reference range (100, 150, or 500)
  //  [44] velocityCurveByteLen (0 or 12 + numPts * 16)
  const rawPressureMin = Math.max(0, view.getInt32(12, false));
  const rawTiltMin = Math.max(0, view.getInt32(16, false));
  const rawVelocityMin = Math.max(0, view.getInt32(20, false));
  const rawRandomMin = Math.max(0, view.getInt32(24, false));
  const pCurveLen = blob.length >= 36 ? view.getUint32(32, false) : 0;
  const tCurveLen = blob.length >= 40 ? view.getUint32(36, false) : 0;
  const rawTiltMax = headerLen >= 48 && blob.length >= 44 ? view.getUint32(40, false) : 100;
  const vCurveLen = blob.length >= 48 ? view.getUint32(44, false) : 0;

  const hasPerSourceNonZero = rawTiltMin > 0 || rawVelocityMin > 0 || rawRandomMin > 0;
  const pressureMin = clamp01(rawPressureMin / 100.0);
  let tiltMin = clamp01(rawTiltMin / 100.0);
  const tiltMax = rawTiltMax > 100 && rawTiltMax <= 1000 ? rawTiltMax / 100.0 : 1.0;
  let velocityMin = clamp01(rawVelocityMin / 100.0);
  let randomMin = clamp01(rawRandomMin / 100.0);

  // Backward compatibility with legacy single-min effectors where offset 12 holds the shared min
  if (!usePressure && !hasPerSourceNonZero && rawPressureMin > 0) {
    if (useTilt) tiltMin = pressureMin;
    if (useVelocity) velocityMin = pressureMin;
    if (useRandom) randomMin = pressureMin;
  }

  const minValue = usePressure
    ? pressureMin
    : useTilt
      ? tiltMin
      : useVelocity
        ? velocityMin
        : useRandom
          ? randomMin
          : pressureMin;
  const maxValue = 1.0;

  const invertTilt = Boolean(sourceFlags & 0x2000) || Boolean(sourceFlags & 0x0200);
  const invertVelocity = Boolean(sourceFlags & 0x8000) || Boolean(sourceFlags & 0x0800);

  let offset = headerLen >= 44 && headerLen <= blob.length ? headerLen : 48;
  if (
    offset + 12 <= blob.length &&
    view.getUint32(offset, false) !== 12 &&
    blob.length >= 56 &&
    view.getUint32(44, false) === 12
  ) {
    offset = 44;
  }

  const readSingleCurve = (
    start: number,
    endLimit: number
  ): { pts: [number, number][]; nextOffset: number } | null => {
    if (start + 12 > endLimit || start + 12 > blob.length) return null;
    const magic = view.getUint32(start, false);
    const numPts = view.getUint32(start + 4, false);
    const ptSize = view.getUint32(start + 8, false);
    const byteEnd = start + 12 + numPts * 16;
    if (magic !== 12 || ptSize !== 16 || numPts > 256 || byteEnd > endLimit || byteEnd > blob.length) {
      return null;
    }
    const pts: [number, number][] = [];
    let cur = start + 12;
    for (let i = 0; i < numPts; i++) {
      const x = view.getFloat64(cur, false);
      const y = view.getFloat64(cur + 8, false);
      pts.push([clamp01(x), clamp01(y)]);
      cur += 16;
    }
    return pts.length > 0 ? { pts, nextOffset: cur } : null;
  };

  let pressureCurve: [number, number][] | undefined = undefined;
  let tiltCurve: [number, number][] | undefined = undefined;
  let velocityCurve: [number, number][] | undefined = undefined;

  const tailBytes = blob.length - offset;
  const hasExactCurveLengths =
    headerLen >= 48 &&
    blob.length >= 48 &&
    tailBytes > 0 &&
    (pCurveLen > 0 || tCurveLen > 0 || vCurveLen > 0) &&
    pCurveLen + tCurveLen + vCurveLen === tailBytes;

  if (hasExactCurveLengths) {
    // Exact CSP curve slot slicing: CSP often retains saved curves for disabled sources
    // (e.g., saved pressure curve before an active tilt curve), indexed by header byte lengths.
    let cursor = offset;
    if (pCurveLen > 0) {
      const parsed = readSingleCurve(cursor, cursor + pCurveLen);
      if (usePressure && parsed) pressureCurve = parsed.pts;
      cursor += pCurveLen;
    }
    if (tCurveLen > 0) {
      const parsed = readSingleCurve(cursor, cursor + tCurveLen);
      if (useTilt && parsed) tiltCurve = parsed.pts;
      cursor += tCurveLen;
    }
    if (vCurveLen > 0) {
      const parsed = readSingleCurve(cursor, cursor + vCurveLen);
      if (useVelocity && parsed) velocityCurve = parsed.pts;
    }
  } else {
    // Fallback for compact / legacy synthetic effectors without explicit curve byte-length fields
    const curves: [number, number][][] = [];
    let cursor = offset;
    while (cursor + 12 <= blob.length) {
      const parsed = readSingleCurve(cursor, blob.length);
      if (!parsed) break;
      curves.push(parsed.pts);
      cursor = parsed.nextOffset;
    }

    const enabledCurveSources = (usePressure ? 1 : 0) + (useTilt ? 1 : 0) + (useVelocity ? 1 : 0);
    if (curves.length === 3 && enabledCurveSources < 3) {
      if (usePressure) pressureCurve = curves[0];
      if (useTilt) tiltCurve = curves[1];
      if (useVelocity) velocityCurve = curves[2];
    } else {
      let curveIdx = 0;
      if (usePressure && curveIdx < curves.length) {
        pressureCurve = curves[curveIdx++];
      }
      if (useTilt && curveIdx < curves.length) {
        tiltCurve = curves[curveIdx++];
      }
      if (useVelocity && curveIdx < curves.length) {
        velocityCurve = curves[curveIdx++];
      }
    }
  }

  return {
    usePressure,
    useTilt,
    useVelocity,
    useRandom,
    minValue,
    maxValue,
    pressureMin,
    tiltMin,
    tiltMax,
    velocityMin,
    randomMin,
    invertTilt,
    invertVelocity,
    sourceFlags,
    pressureCurve,
    tiltCurve,
    velocityCurve,
  };
}

function effectorToSensorConfig(
  eff: DecodedEffector,
  allowTiltAboveOne: boolean = false
): CspSensorConfig {
  const cfg: CspSensorConfig = {
    usePressure: eff.usePressure,
    pressureMin: eff.pressureMin,
    pressureCurve: eff.pressureCurve,
    useTilt: eff.useTilt,
    tiltMin: eff.tiltMin,
    tiltCurve: eff.tiltCurve,
    invertTilt: eff.invertTilt,
    useVelocity: eff.useVelocity,
    velocityMin: eff.velocityMin,
    velocityCurve: eff.velocityCurve,
    invertVelocity: eff.invertVelocity,
    useRandom: eff.useRandom,
    randomMin: eff.randomMin,
  };
  if (allowTiltAboveOne && eff.useTilt && eff.tiltMax > 1.0) {
    cfg.tiltMax = eff.tiltMax;
  }
  return cfg;
}

function parseEffectorSensor(
  raw: unknown,
  allowTiltAboveOne: boolean = false
): CspSensorConfig | undefined {
  if (!(raw instanceof Uint8Array)) return undefined;
  const eff = parseCspEffector(raw);
  if (eff && (eff.usePressure || eff.useTilt || eff.useVelocity || eff.useRandom)) {
    return effectorToSensorConfig(eff, allowTiltAboveOne);
  }
  return undefined;
}

/**
 * Evaluates a value through a Clip Studio Paint cubic Hermite spline curve (PCHIP)
 * using the O(1) precompiled Float32Array(256) LUT in CspBrushEngine.
 */
export function evaluateCspSpline(x: number, pts?: [number, number][]): number {
  return evaluateFastSpline(x, pts);
}

export interface BrushTipProcessHints {
  width?: number;
  height?: number;
  expressionColor?: CspExpressionColor;
  hasSubColor?: boolean;
  fromNativeLayer?: boolean;
}

/**
 * Normalizes brush tip alpha and transparency while preserving full-resolution
 * Rust-decoded `data/*.layer` 2-channel monochrome/gray and full-color semantics.
 */
export async function processBrushTipImage(
  dataUrl: string,
  fallbackProcedural?: { hardness: number; thickness: number; antiAlias: number },
  hints?: BrushTipProcessHints
): Promise<{ dataUrl: string; width: number; height: number; isColor: boolean; isDualToneTip: boolean }> {
  // Fast lossless path: Rust already decoded full-resolution `data/*.layer` RGBA8 with exact
  // expression color & 2-channel semantics (alpha = opacity, gray = Main/Sub blend).
  if (hints?.fromNativeLayer && hints.width && hints.height) {
    const isColor = hints.expressionColor === 'color';
    const isDualToneTip = !isColor && Boolean(hints.hasSubColor);
    return {
      dataUrl,
      width: hints.width,
      height: hints.height,
      isColor,
      isDualToneTip,
    };
  }

  // Headless / Node environment fallback (e.g., vitest without DOM Image loader)
  if (typeof Image === 'undefined') {
    const isColor = hints?.expressionColor === 'color';
    return {
      dataUrl,
      width: hints?.width || 64,
      height: hints?.height || 64,
      isColor,
      isDualToneTip: !isColor && Boolean(hints?.hasSubColor),
    };
  }

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
          resolve({
            dataUrl: proc.dataUrl,
            width: proc.width,
            height: proc.height,
            isColor: false,
            isDualToneTip: false,
          });
        } else {
          resolve({ dataUrl, width: 64, height: 64, isColor: false, isDualToneTip: false });
        }
        return;
      }

      if (hints?.expressionColor === 'color') {
        resolve({ dataUrl, width: w, height: h, isColor: true, isDualToneTip: false });
        return;
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve({
          dataUrl,
          width: w,
          height: h,
          isColor: false,
          isDualToneTip: Boolean(hints?.hasSubColor),
        });
        return;
      }

      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;

      let hasAlpha = false;
      let hasColor = false;
      let maxAlpha = 0;
      let nonZeroCount = 0;
      let opaqueCount = 0;
      let darkCount = 0;
      let lightCount = 0;

      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a > maxAlpha) maxAlpha = a;
        if (a > 0) nonZeroCount++;
        if (a < 240) {
          hasAlpha = true;
        }
        if (a >= 16) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          opaqueCount++;
          const lum = (77 * r + 150 * g + 29 * b) >> 8;
          if (lum <= 120) darkCount++;
          if (lum >= 160) lightCount++;
          if (a > 20 && (Math.abs(r - g) > 20 || Math.abs(g - b) > 20 || Math.abs(r - b) > 20)) {
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
        resolve({
          dataUrl: proc.dataUrl,
          width: proc.width,
          height: proc.height,
          isColor: false,
          isDualToneTip: false,
        });
        return;
      }

      const minSig = Math.max(1, Math.floor(opaqueCount / 500));
      const detectedDualTone =
        Boolean(hints?.hasSubColor) ||
        (hasAlpha && opaqueCount > 0 && darkCount >= minSig && lightCount >= minSig);

      if (hasColor) {
        resolve({ dataUrl, width: w, height: h, isColor: true, isDualToneTip: false });
      } else if (!hasAlpha) {
        for (let i = 0; i < data.length; i += 4) {
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          const alpha = Math.max(0, Math.min(255, Math.round(255 - lum)));
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          data[i + 3] = alpha;
        }
        ctx.putImageData(imgData, 0, 0);
        resolve({
          dataUrl: canvas.toDataURL('image/png'),
          width: w,
          height: h,
          isColor: false,
          isDualToneTip: false,
        });
      } else if (detectedDualTone) {
        // Preserve exact 2-channel monochrome/gray semantics (alpha = opacity, gray = Main/Sub blend)
        resolve({ dataUrl, width: w, height: h, isColor: false, isDualToneTip: true });
      } else {
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
        resolve({
          dataUrl: canvas.toDataURL('image/png'),
          width: w,
          height: h,
          isColor: false,
          isDualToneTip: false,
        });
      }
    };

    img.onerror = () => {
      if (fallbackProcedural) {
        const proc = generateProceduralTip(
          fallbackProcedural.hardness,
          fallbackProcedural.thickness,
          fallbackProcedural.antiAlias
        );
        resolve({
          dataUrl: proc.dataUrl,
          width: proc.width,
          height: proc.height,
          isColor: false,
          isDualToneTip: false,
        });
      } else {
        resolve({ dataUrl, width: 64, height: 64, isColor: false, isDualToneTip: false });
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
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (
      s === 'normal' ||
      s === 'multiply' ||
      s === 'subtract' ||
      s === 'compare' ||
      s === 'overlay' ||
      s === 'color-burn' ||
      s === 'linear-burn' ||
      s === 'height' ||
      s === 'outline'
    ) {
      return s;
    }
  }
  const n = Number(val);
  // CSP TextureCompositeMode: 0=Normal, 1=Multiply, 2=Subtract, 3=Compare density,
  // 4=Overlay, 5=Color burn, 6=Linear burn, 7=Height, 8=Outline
  switch (n) {
    case 0:
      return 'normal';
    case 1:
      return 'multiply';
    case 2:
      return 'subtract';
    case 3:
      return 'compare';
    case 4:
      return 'overlay';
    case 5:
      return 'color-burn';
    case 6:
      return 'linear-burn';
    case 7:
      return 'height';
    case 8:
      return 'outline';
    default:
      return 'multiply';
  }
}

function mapTexturePosition(val: unknown): GrainMappingMode | undefined {
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (
      s === 'canvas-locked' ||
      s === 'brush-aligned' ||
      s === 'stroke-flow' ||
      s === 'random-per-stroke'
    ) {
      return s;
    }
  }
  const n = Number(val);
  if (!Number.isFinite(n)) return undefined;
  switch (n) {
    case 0:
      return 'canvas-locked';
    case 1:
      return 'brush-aligned';
    case 2:
      return 'stroke-flow';
    case 3:
      return 'random-per-stroke';
    default:
      return 'canvas-locked';
  }
}

/**
 * Decodes CSP BrushSize accurately using BrushSizeUnit / BrushSizeSpecifiedByScreen
 * without corrupting large pixel brushes (e.g., 300px airbrush -> 300px, max 2000px).
 * Legacy tenth-pixel values (> 2000px or explicit tenth-pixel unit) are scaled cleanly.
 */
export function decodeCspBrushSize(
  rawSize: number,
  rawUnit?: unknown,
  _rawSpecifiedByScreen?: unknown
): number {
  if (!Number.isFinite(rawSize) || rawSize <= 0) return 16;

  // Explicit tenth-pixel unit indicator (if present)
  if (rawUnit === 'tenth-px' || rawUnit === 10) {
    return Math.max(0.5, Math.min(2000, rawSize / 10));
  }

  // Standard CSP BrushSizeUnit (0=px, 1=mm, 2=cm, 3=in, 4=pt, 5=Q) stores BrushSize in pixels (0.5..2000).
  // Values strictly above CSP's 2000px ceiling originate from legacy tenth-pixel / hundredth-pixel encoders.
  if (rawSize > 20000) {
    return Math.max(0.5, Math.min(2000, rawSize / 100));
  }
  if (rawSize > 2000) {
    return Math.max(0.5, Math.min(2000, rawSize / 10));
  }
  return Math.max(0.5, Math.min(2000, rawSize));
}

/**
 * Decodes CSP BrushCombineMode (brush blending mode against the layer) cleanly,
 * completely distinct from within-stroke BlendBrushTips.
 */
export function mapCspBrushCombineMode(val: unknown): CspBrushCombineMode | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    const validStrings: CspBrushCombineMode[] = [
      'normal',
      'darken',
      'multiply',
      'color-burn',
      'linear-burn',
      'subtract',
      'darker-color',
      'lighten',
      'screen',
      'color-dodge',
      'color-dodge-glow',
      'add',
      'add-glow',
      'lighter-color',
      'overlay',
      'soft-light',
      'hard-light',
      'vivid-light',
      'linear-light',
      'pin-light',
      'hard-mix',
      'difference',
      'exclusion',
      'hue',
      'saturation',
      'color',
      'luminosity',
      'pass-through',
      'divide',
      'behind',
      'clear',
      'compare-density',
    ];
    if ((validStrings as string[]).includes(s)) {
      return s as CspBrushCombineMode;
    }
    if (s === 'glow-dodge') return 'color-dodge-glow';
  }
  const n = Number(val);
  if (!Number.isFinite(n)) return undefined;
  switch (n) {
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
      return 'subtract';
    case 6:
      return 'darker-color';
    case 7:
      return 'lighten';
    case 8:
      return 'screen';
    case 9:
      return 'color-dodge';
    case 10:
      return 'color-dodge-glow';
    case 11:
      return 'add';
    case 12:
      return 'add-glow';
    case 13:
      return 'lighter-color';
    case 14:
      return 'overlay';
    case 15:
      return 'soft-light';
    case 16:
      return 'hard-light';
    case 17:
      return 'vivid-light';
    case 18:
      return 'linear-light';
    case 19:
      return 'pin-light';
    case 20:
      return 'hard-mix';
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
    case 27:
    case 32:
      return 'behind';
    case 28:
    case 33:
      return 'clear';
    case 29:
    case 31:
      return 'compare-density';
    case 30:
      return 'pass-through';
    case 36:
      return 'divide';
    default:
      return 'normal';
  }
}

function mapBlendTipsMode(val: unknown): CspBlendTipsMode {
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (s === 'normal' || s === 'darken' || s === 'compare') return s;
  }
  if (typeof val === 'boolean') {
    return val ? 'compare' : 'normal';
  }
  const n = Number(val);
  if (n === 0) return 'normal';
  if (n === 1) return 'compare';
  if (n === 2) return 'darken';
  return 'darken';
}

function mapPatternOrderType(val: unknown): CspSubTipOrder | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    if (
      s === 'sequential' ||
      s === 'reverse' ||
      s === 'random' ||
      s === 'random-no-repeat' ||
      s === 'once' ||
      s === 'direction'
    ) {
      return s;
    }
  }
  const n = Number(val);
  if (!Number.isFinite(n)) return undefined;
  switch (n) {
    case 0:
      return 'sequential';
    case 1:
      return 'reverse';
    case 2:
      return 'once';
    case 3:
      return 'random';
    case 4:
      return 'random-no-repeat';
    case 5:
      return 'direction';
    default:
      return 'sequential';
  }
}

/**
 * Decodes CSP BrushHardness, distinguishing discrete 1..5 hardness levels
 * (1=0.2 .. 5=1.0) from 0..100% continuous values and already-normalized 0..1 values.
 */
export function decodeCspHardness(rawHardness: number, rawHardnessMode?: unknown): number {
  if (!Number.isFinite(rawHardness)) return 1.0;
  if (rawHardness <= 0) return 0.05;
  if (rawHardness < 1) {
    return Math.max(0.05, Math.min(1.0, rawHardness));
  }
  const forcePercent = rawHardnessMode === 100 || rawHardnessMode === 'percent';
  if (!forcePercent && Number.isInteger(rawHardness) && rawHardness >= 1 && rawHardness <= 5) {
    return Math.max(0.05, Math.min(1.0, rawHardness / 5));
  }
  return Math.max(0.05, Math.min(1.0, rawHardness / 100));
}

/**
 * Normalizes CSP wet edge alpha/value power from 0..100 (or legacy 0..1) into 0..1.
 */
export function normalizeWetEdgePower(val: number): number {
  if (!Number.isFinite(val) || val <= 0) return 0;
  if (val > 0 && val < 1) return clamp01(val);
  return clamp01(val / 100);
}

function normalizePercent01(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  if (raw === 0) return 0;
  if (raw > 0 && raw < 1) return clamp01(raw);
  return clamp01(raw / 100);
}

function parseRotationEffector(rawRotEff: unknown): {
  mode?: CspAngleDynamicsMode;
  sensor?: CspSensorConfig;
  usesTilt: boolean;
} {
  if (rawRotEff instanceof Uint8Array) {
    const eff = parseCspEffector(rawRotEff);
    if (!eff) return { usesTilt: false };
    const flags = eff.sourceFlags;
    const sensor =
      eff.usePressure || eff.useTilt || eff.useVelocity || eff.useRandom || Boolean(flags & 0x02)
        ? effectorToSensorConfig(eff)
        : undefined;

    let mode: CspAngleDynamicsMode = 'none';
    if (eff.useVelocity && eff.useRandom) {
      mode = 'direction-random';
    } else if (flags & 0x02) {
      mode = 'initial-direction';
    } else if (eff.useTilt) {
      mode = 'tilt';
    } else if (eff.useVelocity) {
      mode = 'direction';
    } else if (eff.useRandom) {
      mode = 'random';
    }
    return { mode, sensor, usesTilt: mode === 'tilt' || eff.useTilt };
  }

  if (typeof rawRotEff === 'number' && Number.isFinite(rawRotEff)) {
    const rotMode = rawRotEff & 0x0f;
    // Authentic CSP Variant.BrushRotationEffector integer encoding:
    // Low nibble is 0x03; upper bits select the angle dynamics source:
    //   3   (0x03) = None (fixed angle)
    //   19  (0x13) = Direction of pen (Tilt)
    //   35  (0x23) = Rotation of pen axis (Barrel Twist)
    //   67  (0x43) = Direction of line
    //   131 (0x83) = Random
    //   195 (0xc3) = Direction of line + Random
    //   259 (0x103) = Initial direction
    if (rotMode === 3) {
      if ((rawRotEff & 0x40) && (rawRotEff & 0x80)) {
        return { mode: 'direction-random', usesTilt: false };
      }
      if (rawRotEff & 0x100) {
        return { mode: 'initial-direction', usesTilt: false };
      }
      if (rawRotEff & 0x40) {
        return { mode: 'direction', usesTilt: false };
      }
      if (rawRotEff & 0x80) {
        return { mode: 'random', usesTilt: false };
      }
      if (rawRotEff & 0x20) {
        return { mode: 'twist', usesTilt: false };
      }
      if (rawRotEff & 0x10) {
        return { mode: 'tilt', usesTilt: true };
      }
      return { mode: 'none', usesTilt: false };
    }
    if (rotMode === 2) {
      return { mode: 'tilt', usesTilt: true };
    }
    if (rotMode === 4) {
      return { mode: 'random', usesTilt: false };
    }
    if (rotMode === 5) {
      return { mode: 'twist', usesTilt: false };
    }
    if (rotMode === 6) {
      return { mode: 'initial-direction', usesTilt: false };
    }
    if (rotMode === 7) {
      return { mode: 'direction-random', usesTilt: false };
    }
    if (rotMode === 1) {
      return { mode: 'none', usesTilt: false };
    }
    // rotMode === 0: inspect higher flag bits
    if ((rawRotEff & 0x40) && (rawRotEff & 0x80)) {
      return { mode: 'direction-random', usesTilt: false };
    }
    if (rawRotEff & 0x100) {
      return { mode: 'initial-direction', usesTilt: false };
    }
    if (rawRotEff & 0x40) {
      return { mode: 'direction', usesTilt: false };
    }
    if (rawRotEff & 0x80) {
      return { mode: 'random', usesTilt: false };
    }
    if (rawRotEff & 0x20) {
      return { mode: 'twist', usesTilt: false };
    }
    if (rawRotEff & 0x10) {
      return { mode: 'tilt', usesTilt: true };
    }
    if (rawRotEff & 0x02) {
      return { mode: 'initial-direction', usesTilt: false };
    }
    if (rawRotEff & 0x01) {
      return { mode: 'random', usesTilt: false };
    }
    return { mode: 'none', usesTilt: false };
  }

  return { usesTilt: false };
}

function mapDualBrushCompositeMode(val: unknown): string {
  if (typeof val === 'string' && val.trim().length > 0) {
    return val.trim().toLowerCase();
  }
  const dm = Number(val);
  if (!Number.isFinite(dm)) return 'multiply';
  switch (dm) {
    case 0:
      return 'multiply';
    case 1:
      return 'subtract';
    case 2:
      return 'darken';
    case 3:
      return 'lighten';
    case 4:
      return 'screen';
    case 5:
      return 'color-burn';
    case 6:
      return 'linear-burn';
    case 7:
      return 'color-dodge';
    case 8:
      return 'color-dodge-glow';
    case 9:
      return 'add';
    case 10:
      return 'add-glow';
    case 11:
      return 'overlay';
    case 12:
      return 'soft-light';
    case 13:
      return 'hard-light';
    case 14:
      return 'vivid-light';
    case 15:
      return 'linear-light';
    case 16:
      return 'pin-light';
    case 17:
      return 'hard-mix';
    case 18:
      return 'difference';
    case 19:
      return 'exclusion';
    case 20:
      return 'darker-color';
    case 21:
      return 'lighter-color';
    case 22:
      return 'divide';
    case 23:
      return 'hue';
    case 24:
      return 'saturation';
    case 25:
      return 'color';
    case 26:
      return 'luminosity';
    case 27:
      return 'normal';
    case 28:
      return 'height';
    case 29:
      return 'compare-density';
    default:
      return 'multiply';
  }
}

function decodeAutoOrFixedSpacing(rawAutoInterval: unknown, rawSpacing: unknown): number | undefined {
  if (typeof rawAutoInterval === 'number' && rawAutoInterval > 0) {
    if (rawAutoInterval === 1) return 0.04;
    if (rawAutoInterval === 2) return 0.1;
    if (rawAutoInterval === 3) return 0.22;
  }
  if (typeof rawSpacing === 'number' && rawSpacing > 0) {
    // In CSP, BrushInterval in Fixed mode is ALWAYS a percentage (0.1%..200% -> 0.001..2.0)
    return Math.max(0.003, Math.min(2.0, rawSpacing / 100));
  }
  return undefined;
}

function parseSprayConfig(
  getVal: (aliases: string[]) => any,
  prefix: '' | 'Dual' = ''
): CspSpraySettings | undefined {
  const p = prefix;
  const rawSpray = getVal(
    p ? [`${p}BrushUseSpray`, `${p}UseSpray`] : ['BrushUseSpray', 'UseSpray']
  );
  if (!Boolean(rawSpray)) return undefined;

  const rawSpraySize = getVal(
    p ? [`${p}BrushSpraySize`, `${p}SpraySize`] : ['BrushSpraySize', 'SpraySize']
  );
  const rawSprayDensity = getVal(
    p ? [`${p}BrushSprayDensity`, `${p}SprayDensity`] : ['BrushSprayDensity', 'SprayDensity']
  );
  const rawSprayBias = getVal(
    p ? [`${p}BrushSprayBias`, `${p}SprayBias`] : ['BrushSprayBias', 'SprayBias']
  );
  const rawDeviation = getVal(
    p ? [`${p}BrushSprayDeviation`, `${p}SprayDeviation`] : ['BrushSprayDeviation', 'SprayDeviation']
  );
  const rawParticleSize = getVal(
    p
      ? [`${p}BrushSprayParticleSize`, `${p}SprayParticleSize`]
      : ['BrushSprayParticleSize', 'SprayParticleSize']
  );
  const rawLinkSize = getVal(
    p ? [`${p}BrushSprayLinkSize`, `${p}SprayLinkSize`] : ['BrushSprayLinkSize', 'SprayLinkSize']
  );
  const rawSizeEff = getVal(
    p
      ? [`${p}BrushSpraySizeEffector`, `${p}SpraySizeEffector`]
      : ['BrushSpraySizeEffector', 'SpraySizeEffector']
  );
  const rawDensityEff = getVal(
    p
      ? [`${p}BrushSprayDensityEffector`, `${p}SprayDensityEffector`]
      : ['BrushSprayDensityEffector', 'SprayDensityEffector']
  );
  const rawDir = getVal(
    p ? [`${p}BrushSprayDirection`, `${p}SprayDirection`] : ['BrushSprayDirection', 'SprayDirection']
  );
  const rawDirEff = getVal(
    p
      ? [`${p}BrushSprayDirectionEffector`, `${p}SprayDirectionEffector`]
      : ['BrushSprayDirectionEffector', 'SprayDirectionEffector']
  );

  const deviation =
    typeof rawDeviation === 'number' && Number.isFinite(rawDeviation)
      ? Math.max(-1, Math.min(1, rawDeviation / 100))
      : undefined;
  const bias =
    typeof rawSprayBias === 'number' && Number.isFinite(rawSprayBias)
      ? Math.max(-1, Math.min(1, rawSprayBias / 100))
      : (deviation ?? 0);

  const dirDecoded = parseRotationEffector(rawDirEff);

  const spray: CspSpraySettings = {
    enabled: true,
    size: typeof rawSpraySize === 'number' && rawSpraySize > 0 ? Math.max(1, rawSpraySize) : 2.0,
    density:
      typeof rawSprayDensity === 'number' && rawSprayDensity > 0
        ? Math.max(1, Math.min(50, rawSprayDensity))
        : 5,
    bias,
  };
  if (typeof rawParticleSize === 'number' && rawParticleSize > 0) {
    spray.particleSize = decodeCspBrushSize(rawParticleSize);
  }
  if (rawLinkSize !== null) {
    spray.linkSize = Boolean(rawLinkSize);
  }
  const sizeSensor = parseEffectorSensor(rawSizeEff, true);
  if (sizeSensor) spray.sizeSensor = sizeSensor;
  const densitySensor = parseEffectorSensor(rawDensityEff, true);
  if (densitySensor) spray.densitySensor = densitySensor;
  if (typeof rawDir === 'number' && Number.isFinite(rawDir)) {
    spray.direction = ((rawDir % 360) + 360) % 360;
  }
  if (dirDecoded.mode && dirDecoded.mode !== 'none') {
    spray.directionDynamics = dirDecoded.mode;
  }
  if (dirDecoded.sensor) {
    spray.directionSensor = dirDecoded.sensor;
  }
  if (deviation !== undefined) {
    spray.deviation = deviation;
  }
  return spray;
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
  let brushSizeUnit: number | undefined = undefined;
  let brushSizeSpecifiedByScreen: boolean | undefined = undefined;
  let minSizeFactor = 0.2;
  let opacity = 1.0;
  let flow = 0.85;
  let adjustDensityByGap = false;
  let blendTipsMode: CspBlendTipsMode = 'darken';
  let brushCombineMode: CspBrushCombineMode | undefined = undefined;
  let spacing = 0.08;
  let hardness = 1.0;
  let thickness = 1.0;
  let thicknessVertical = false;
  let thicknessSensor: CspSensorConfig | undefined = undefined;
  let subTipOrder: CspSubTipOrder | undefined = undefined;
  let flipH: CspTipFlipMode = 'none';
  let flipV: CspTipFlipMode = 'none';
  let angle = 0;
  let angleDynamics: CspAngleDynamicsMode = 'none';
  let angleSensor: CspSensorConfig | undefined = undefined;
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
  let intervalSensor: CspSensorConfig | undefined = undefined;
  let textureDensitySensor: CspSensorConfig | undefined = undefined;
  let colorMixing = false;
  let perceptualMixing = false;
  let amountOfPaint = 0.7;
  let densityOfPaint = 0.8;
  let colorStretch = 0.6;
  let amountOfPaintSensor: CspSensorConfig | undefined = undefined;
  let densityOfPaintSensor: CspSensorConfig | undefined = undefined;
  let colorStretchSensor: CspSensorConfig | undefined = undefined;
  let mixGroundColor: boolean | undefined = undefined;
  let useBlur: boolean | undefined = undefined;
  let blurStrength: number | undefined = undefined;
  let mixingMode: 'blend' | 'running_color' | 'smear' = 'blend';
  let wetEdge = 0;
  let wetEdgeRadius = 3.0;
  let wetEdgeAlphaPower = 0.2;
  let wetEdgeValuePower = 0;
  let textureDensity = 0;
  let grainMappingMode: GrainMappingMode | undefined = undefined;
  let paperTextureScale = 1.0;
  let paperTextureRotate = 0;
  let paperTextureOffsetX: number | undefined = undefined;
  let paperTextureOffsetY: number | undefined = undefined;
  let paperTextureMode: CspPaperTextureMode = 'multiply';
  let paperTextureBrightness = 0;
  let paperTextureContrast = 0;
  let paperTextureApplyEachPlot = false;
  let paperTextureEmphasizeDensity = false;
  let paperTextureInverted = false;
  let spray: CspSpraySettings | undefined = undefined;
  let taper: CspTaperSettings | undefined = undefined;
  let dynamics: BrushDynamics | undefined = undefined;
  let isRibbon = false;
  let dualBrush = false;
  let dualBrushCompositeMode = 'multiply';
  let dualSize: number | undefined = undefined;
  let dualLinkSize: boolean | undefined = undefined;
  let dualSpacing: number | undefined = undefined;
  let dualThickness: number | undefined = undefined;
  let dualThicknessVertical: boolean | undefined = undefined;
  let dualAngle: number | undefined = undefined;
  let dualAngleDynamics: CspAngleDynamicsMode | undefined = undefined;
  let dualAngleSensor: CspSensorConfig | undefined = undefined;
  let dualHardness: number | undefined = undefined;
  let dualDensity: number | undefined = undefined;
  let dualSubTipOrder: CspSubTipOrder | undefined = undefined;
  let dualFlipH: CspTipFlipMode | undefined = undefined;
  let dualFlipV: CspTipFlipMode | undefined = undefined;
  let dualSpray: CspSpraySettings | undefined = undefined;
  let dualIsRibbon: boolean | undefined = undefined;
  let usePatternImage: boolean | null = null;
  let rawPatternArrayBlob: Uint8Array | null = null;
  let rawTextureImageBlob: Uint8Array | null = null;
  let rawDualPatternBlob: Uint8Array | null = null;
  const importWarnings: string[] = [];

  const getVal = (aliases: string[]): any => {
    for (const a of aliases) {
      const v = extracted.variantValues.get(a.toLowerCase());
      if (v !== undefined && v !== null) {
        return v;
      }
    }
    return null;
  };

  if (extracted.variantValues.size > 0) {
    // Detect unsupported non-brush CSP sub-tools (e.g., Liquify, Fill, Gradient, Selection, Ruler, Text)
    const nonBrushCategories: Array<{ label: string; keys: string[] }> = [
      {
        label: 'Liquify',
        keys: ['liquifymode', 'liquifystrength', 'liquifysize', 'liquifyhardness', 'liquifydirection'],
      },
      {
        label: 'Fill',
        keys: ['fillclosegap', 'fillareascale', 'fillreferlayer', 'filltolerance'],
      },
      {
        label: 'Gradient',
        keys: ['gradationnode', 'gradationedgeprocess', 'gradationshape'],
      },
      {
        label: 'Selection',
        keys: ['selectionaddtype', 'selectionareamode'],
      },
      {
        label: 'Text',
        keys: ['textfontsize', 'textfontname', 'textwritingmode'],
      },
      {
        label: 'Ruler',
        keys: ['rulertype', 'perspectiverulertype', 'symmetryrulerlines'],
      },
    ];
    const hasCoreBrushParam =
      extracted.variantValues.has('brushsize') ||
      extracted.variantValues.has('brushdensity') ||
      extracted.variantValues.has('brushinterval') ||
      extracted.variantValues.has('brushhardness');

    for (const cat of nonBrushCategories) {
      const matched = cat.keys.some((k) => {
        const v = extracted.variantValues.get(k);
        return v !== undefined && v !== null;
      });
      if (matched && (cat.label === 'Liquify' || !hasCoreBrushParam)) {
        importWarnings.push(
          `Unsupported CSP non-brush sub-tool detected (${cat.label}): imported with fallback brush parameters.`
        );
        break;
      }
    }

    try {
      // Size (honoring BrushSizeUnit and BrushSizeSpecifiedByScreen)
      const rawSizeUnit = getVal(['BrushSizeUnit', 'SizeUnit']);
      if (typeof rawSizeUnit === 'number' && Number.isFinite(rawSizeUnit)) {
        brushSizeUnit = Math.round(rawSizeUnit);
      }
      const rawSizeByScreen = getVal(['BrushSizeSpecifiedByScreen', 'SizeSpecifiedByScreen']);
      if (rawSizeByScreen !== null) {
        brushSizeSpecifiedByScreen = Boolean(rawSizeByScreen);
      }
      const rawSize = getVal(['BrushSize', 'Size', 'PenSize', 'BrushSizeVal', 'LineWidth']);
      if (typeof rawSize === 'number' && rawSize > 0) {
        brushSize = decodeCspBrushSize(rawSize, rawSizeUnit, rawSizeByScreen);
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
          sizeSensor = effectorToSensorConfig(eff, true);
        }
      }

      // Opacity, Density, Interval, Texture Density, Thickness Effectors
      opacitySensor = parseEffectorSensor(getVal(['OpacityEffector', 'BrushOpacityEffector']), true);
      densitySensor = parseEffectorSensor(
        getVal(['BrushDensityEffector', 'BrushFlowEffector', 'DensityEffector']),
        true
      );
      intervalSensor = parseEffectorSensor(getVal(['BrushIntervalEffector', 'IntervalEffector']), true);
      textureDensitySensor = parseEffectorSensor(getVal(['TextureDensityEffector']), true);
      thicknessSensor = parseEffectorSensor(getVal(['BrushThicknessEffector', 'ThicknessEffector']), true);
      if (
        opacitySensor?.useTilt ||
        densitySensor?.useTilt ||
        intervalSensor?.useTilt ||
        textureDensitySensor?.useTilt ||
        thicknessSensor?.useTilt
      ) {
        useTilt = true;
      }

      // Spacing / Interval (CSP BrushAutoIntervalType: 0=Fixed %, 1=Narrow, 2=Normal, 3=Wide)
      const decodedSpacing = decodeAutoOrFixedSpacing(
        getVal(['BrushAutoIntervalType']),
        getVal(['BrushInterval', 'Interval', 'Spacing', 'BrushSpacing'])
      );
      if (decodedSpacing !== undefined) {
        spacing = decodedSpacing;
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

      const rawAdjustGap = getVal([
        'BrushAdjustFlowByInterval',
        'BrushAdjustDensityByGap',
        'AdjustDensityByGap',
      ]);
      if (rawAdjustGap !== null) {
        adjustDensityByGap = Boolean(rawAdjustGap);
      }

      // Strictly separate BrushCombineMode (brush-against-layer blend mode) from BlendBrushTips (within-stroke dab combine)!
      const rawCombineMode = getVal(['BrushCombineMode', 'BrushBlendMode', 'CompositeMode']);
      if (rawCombineMode !== null) {
        brushCombineMode = mapCspBrushCombineMode(rawCombineMode);
      }

      const rawBlendTips = getVal([
        'BlendBrushTips',
        'BrushMixMode',
        'BrushAlphaCombine',
        'BrushTipCombineMode',
      ]);
      if (rawBlendTips !== null) {
        blendTipsMode = mapBlendTipsMode(rawBlendTips);
      }

      // Hardness (distinguish discrete 1..5 levels vs 0..100%)
      const rawHardness = getVal(['BrushHardness', 'Hardness']);
      const rawHardnessMode = getVal(['BrushHardnessUnit', 'BrushHardnessType']);
      if (typeof rawHardness === 'number' && rawHardness >= 0) {
        hardness = decodeCspHardness(rawHardness, rawHardnessMode);
      }

      // Sub-tip Order / Repeat
      const rawPatternOrder = getVal(['BrushPatternOrderType', 'BrushPatternRepeatType']);
      if (rawPatternOrder !== null) {
        subTipOrder = mapPatternOrderType(rawPatternOrder);
      }

      // Thickness & Flip
      // In CSP, BrushThickness spans 1..2000% (e.g. 17%, 51%, 135%).
      // CSP BrushVerticalThicknes=0 ("Horizontal") scales the tip's local X axis (width),
      // whereas BrushVerticalThicknes=1 ("Vertical") scales local Y (height).
      // In BrushEngine, thicknessVertical=true scales X (width) and false scales Y (height).
      const rawThickness = getVal(['BrushThickness', 'Thickness']);
      if (typeof rawThickness === 'number' && rawThickness > 0) {
        thickness = Math.max(0.05, Math.min(20.0, rawThickness / 100));
      }
      const rawVertThick = getVal([
        'BrushVerticalThicknes',
        'BrushVerticalThickness',
        'VerticalThickness',
      ]);
      if (rawVertThick !== null) {
        thicknessVertical = !Boolean(rawVertThick);
      } else {
        // CSP defaults to Horizontal (BrushVerticalThicknes=0 -> scales X axis)
        thicknessVertical = true;
      }

      const rawFlipH = getVal(['BrushPatternReverseHorizontal', 'BrushFlipX', 'FlipHorizontal']);
      if (rawFlipH !== null) flipH = mapFlipMode(rawFlipH);
      const rawFlipV = getVal(['BrushPatternReverseVertical', 'BrushFlipY', 'FlipVertical']);
      if (rawFlipV !== null) flipV = mapFlipMode(rawFlipV);

      // Rotation & Complete Angle Dynamics (integer bitmask OR binary Effector BLOB)
      const rawAngle = getVal(['BrushRotation', 'Rotation', 'BrushAngle', 'Angle']);
      if (typeof rawAngle === 'number') {
        angle = ((rawAngle % 360) + 360) % 360;
      }

      const rawRotEff = getVal(['BrushRotationEffector', 'RotationEffector', 'AngleDynamics']);
      if (rawRotEff !== null) {
        const decodedRot = parseRotationEffector(rawRotEff);
        if (decodedRot.mode !== undefined) {
          angleDynamics = decodedRot.mode;
        }
        if (decodedRot.sensor) {
          angleSensor = decodedRot.sensor;
        }
        if (decodedRot.usesTilt) {
          useTilt = true;
        }
      }

      // CSP stores BrushRotationRandomScale=100 by default even when Random rotation is OFF!
      // Only apply random scale when random rotation mode is explicitly enabled.
      if (angleDynamics === 'random' || angleDynamics === 'direction-random') {
        const rawRandRot = getVal(['BrushRotationRandomScale', 'RotationRandomScale']);
        if (typeof rawRandRot === 'number' && rawRandRot > 0) {
          rotationRandomScale = Math.min(1.0, rawRandRot / 100);
        }
      } else {
        rotationRandomScale = 0;
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

      // Color Jitter
      const rawColorJitter = getVal(['BrushChangeBrushColor', 'BrushColorJitter']);
      const rawColorPerStroke = getVal([
        'BrushChangeColorPerStroke',
        'BrushChangeBrushColorPerStroke',
        'ColorJitterPerStroke',
      ]);
      const rawSubColorMix = getVal(['BrushSubColorMix', 'BrushMixSubColor', 'SubColorMix']);
      const subColorMixSensor = parseEffectorSensor(
        getVal(['BrushSubColorMixEffector', 'SubColorMixEffector'])
      );
      const rawRandomHue = getVal(['BrushRandomHue', 'BrushHueJitter', 'RandomHue']);
      const hueJitterSensor = parseEffectorSensor(
        getVal(['BrushRandomHueEffector', 'BrushHueEffector', 'RandomHueEffector'])
      );
      const rawRandomSat = getVal([
        'BrushRandomSaturation',
        'BrushSaturationJitter',
        'RandomSaturation',
      ]);
      const saturationJitterSensor = parseEffectorSensor(
        getVal([
          'BrushRandomSaturationEffector',
          'BrushSaturationEffector',
          'RandomSaturationEffector',
        ])
      );
      const rawRandomLum = getVal([
        'BrushRandomLuminance',
        'BrushRandomBrightness',
        'BrushLuminanceJitter',
        'RandomLuminance',
      ]);
      const luminanceJitterSensor = parseEffectorSensor(
        getVal([
          'BrushRandomLuminanceEffector',
          'BrushRandomBrightnessEffector',
          'BrushLuminanceEffector',
          'RandomLuminanceEffector',
        ])
      );

      const hasColorJitterFields =
        rawColorJitter !== null ||
        rawColorPerStroke !== null ||
        rawSubColorMix !== null ||
        rawRandomHue !== null ||
        rawRandomSat !== null ||
        rawRandomLum !== null ||
        Boolean(
          subColorMixSensor || hueJitterSensor || saturationJitterSensor || luminanceJitterSensor
        );

      if (hasColorJitterFields) {
        const subMix = normalizePercent01(rawSubColorMix) ?? 0;
        const hueJ = normalizePercent01(rawRandomHue) ?? 0;
        const satJ = normalizePercent01(rawRandomSat) ?? 0;
        const lumJ = normalizePercent01(rawRandomLum) ?? 0;
        const enabled =
          rawColorJitter !== null
            ? Boolean(rawColorJitter)
            : subMix > 0 || hueJ > 0 || satJ > 0 || lumJ > 0;

        dynamics = {
          ...DEFAULT_BRUSH_DYNAMICS,
          colorJitterEnabled: enabled,
          colorJitterPerStroke:
            rawColorPerStroke !== null ? Boolean(rawColorPerStroke) : undefined,
          foregroundBackgroundJitter: subMix,
          hueJitter: hueJ,
          saturationJitter: satJ,
          brightnessJitter: lumJ,
          subColorMixSensor,
          hueJitterSensor,
          saturationJitterSensor,
          luminanceJitterSensor,
        };
      }

      // Color Mixing, Effectors, Ground Mixing & Blur
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

      amountOfPaintSensor = parseEffectorSensor(
        getVal(['BrushMixColorEffector', 'AmountOfPaintEffector'])
      );
      densityOfPaintSensor = parseEffectorSensor(
        getVal(['BrushMixAlphaEffector', 'DensityOfPaintEffector'])
      );
      colorStretchSensor = parseEffectorSensor(
        getVal(['BrushMixColorExtensionEffector', 'ColorStretchEffector'])
      );

      const rawMixGround = getVal(['BrushMixGroundColor', 'MixGroundColor']);
      if (rawMixGround !== null) {
        mixGroundColor = Boolean(rawMixGround);
      }

      const rawUseBlur = getVal(['BrushUseBlur', 'UseBlur']);
      if (rawUseBlur !== null) {
        useBlur = Boolean(rawUseBlur);
      }
      const rawBlur = getVal(['BrushBlur', 'BlurStrength', 'BrushBlurStrength']);
      if (typeof rawBlur === 'number' && rawBlur >= 0) {
        blurStrength = normalizePercent01(rawBlur);
      }

      // CSP Variant.BrushWaterColor selects Mixing Mode: 0=Blend, 1=Running color, 2=Smear, 3=Blur/Finger tip.
      // CSP Variant.BrushColorMixingMode (CSP 2.0+) selects Color Space: 0=Standard, 1=Perceptual.
      const rawMixMode = getVal(['BrushWaterColor', 'MixingMode']);
      if (rawMixMode !== null) {
        const m = Number(rawMixMode);
        if (m === 3) {
          mixingMode = 'smear';
          if (useBlur === undefined) useBlur = true;
        } else {
          mixingMode = m === 2 ? 'smear' : m === 1 ? 'running_color' : 'blend';
        }
      }
      const rawColorSpaceMode = getVal(['BrushColorMixingMode', 'PerceptualMixing']);
      if (rawColorSpaceMode !== null) {
        perceptualMixing = Number(rawColorSpaceMode) === 1;
      }

      // Wet Edge (strictly gated on BrushUseWaterEdge! Alpha/Value power normalized to 0..1)
      const rawWetEdge = getVal(['BrushUseWaterEdge', 'UseWaterEdge']);
      const wetEdgeEnabled = Boolean(rawWetEdge);
      const rawWetRad = getVal(['BrushWaterEdgeRadius', 'WaterEdgeRadius']);
      if (typeof rawWetRad === 'number' && rawWetRad > 0) {
        wetEdgeRadius = rawWetRad;
      }
      const rawWetAlpha = getVal(['BrushWaterEdgeAlphaPower', 'WaterEdgeAlphaPower']);
      if (typeof rawWetAlpha === 'number' && rawWetAlpha >= 0) {
        wetEdgeAlphaPower = normalizeWetEdgePower(rawWetAlpha);
      }
      const rawWetVal = getVal(['BrushWaterEdgeValuePower', 'WaterEdgeValuePower']);
      if (typeof rawWetVal === 'number' && rawWetVal >= 0) {
        wetEdgeValuePower = normalizeWetEdgePower(rawWetVal);
      }
      wetEdge = wetEdgeEnabled
        ? Math.max(0.15, Math.min(1.0, wetEdgeAlphaPower > 0 ? wetEdgeAlphaPower : 0.75))
        : 0;

      // Paper Grain / Texture (all 9 TextureCompositeMode values + Position + OffsetX/Y)
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
      const rawTexPos = getVal(['TexturePosition', 'TextureMappingMode']);
      if (rawTexPos !== null) {
        grainMappingMode = mapTexturePosition(rawTexPos);
      }
      const rawTexOffX = getVal(['TextureOffsetX', 'PaperTextureOffsetX']);
      if (typeof rawTexOffX === 'number' && Number.isFinite(rawTexOffX)) {
        paperTextureOffsetX = rawTexOffX;
      }
      const rawTexOffY = getVal(['TextureOffsetY', 'PaperTextureOffsetY']);
      if (typeof rawTexOffY === 'number' && Number.isFinite(rawTexOffY)) {
        paperTextureOffsetY = rawTexOffY;
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
      const rawTexStress = getVal(['TextureStressDensity']);
      if (rawTexStress !== null) {
        paperTextureEmphasizeDensity = Boolean(rawTexStress);
      }
      const rawTexBright = getVal(['TextureBrightness']);
      if (typeof rawTexBright === 'number') {
        paperTextureBrightness = Math.max(-100, Math.min(100, rawTexBright));
      }
      const rawTexContrast = getVal(['TextureContrast']);
      if (typeof rawTexContrast === 'number') {
        paperTextureContrast = Math.max(-100, Math.min(100, rawTexContrast));
      }

      // Extended Spray / Airbrush
      spray = parseSprayConfig(getVal, '');

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

      // Dual Brush toggle & composite mode
      const rawDual = getVal(['UseDualBrush']);
      if (Boolean(rawDual)) {
        dualBrush = true;
      }
      const rawDualMode = getVal(['DualBrushCompositeMode', 'DualBrushMode', 'DualCompositeMode']);
      if (rawDualMode !== null) {
        dualBrushCompositeMode = mapDualBrushCompositeMode(rawDualMode);
      }

      const rawUsePattern = getVal(['BrushUsePatternImage']);
      if (rawUsePattern !== null) {
        usePatternImage = Boolean(rawUsePattern);
      }
      rawPatternArrayBlob = getVal(['BrushPatternImageArray']);
      rawTextureImageBlob = getVal(['TextureImage']);
      rawDualPatternBlob = getVal(['DualPatternImageArray']);
    } catch {
      // Variant query fallback
    }
  }

  // 3b. Complete Dual Brush configuration (merges primary Variant DualBrush* columns with extracted.dualVariantValues)
  if (dualBrush) {
    const dualMap = extracted.dualVariantValues;
    const getDualMerged = (dualVariantAliases: string[], primaryDualAliases: string[]): any => {
      if (dualMap && dualMap.size > 0) {
        for (const a of dualVariantAliases) {
          const v = dualMap.get(a.toLowerCase());
          if (v !== undefined && v !== null) return v;
        }
      }
      for (const a of primaryDualAliases) {
        const v = extracted.variantValues.get(a.toLowerCase());
        if (v !== undefined && v !== null) return v;
      }
      return null;
    };

    const rawDualSizeUnit = getDualMerged(['BrushSizeUnit', 'SizeUnit'], ['DualBrushSizeUnit']);
    const rawDualSize = getDualMerged(
      ['BrushSize', 'Size', 'DualBrushSize'],
      ['DualBrushSize']
    );
    if (typeof rawDualSize === 'number' && rawDualSize > 0) {
      dualSize = decodeCspBrushSize(rawDualSize, rawDualSizeUnit);
    }

    const rawDualLinkSize = getDualMerged(
      ['BrushLinkSize', 'DualBrushLinkSize', 'LinkSize'],
      ['DualBrushLinkSize']
    );
    if (rawDualLinkSize !== null) {
      dualLinkSize = Boolean(rawDualLinkSize);
    }

    const decodedDualSpacing = decodeAutoOrFixedSpacing(
      getDualMerged(['BrushAutoIntervalType', 'DualBrushAutoIntervalType'], ['DualBrushAutoIntervalType']),
      getDualMerged(
        ['BrushInterval', 'Interval', 'Spacing', 'DualBrushInterval'],
        ['DualBrushInterval']
      )
    );
    if (decodedDualSpacing !== undefined) {
      dualSpacing = decodedDualSpacing;
    }

    const rawDualThickness = getDualMerged(
      ['BrushThickness', 'Thickness', 'DualBrushThickness'],
      ['DualBrushThickness']
    );
    if (typeof rawDualThickness === 'number' && rawDualThickness > 0) {
      dualThickness = Math.max(0.05, Math.min(20.0, rawDualThickness / 100));
    }

    const rawDualVertThick = getDualMerged(
      ['BrushVerticalThicknes', 'BrushVerticalThickness', 'DualBrushVerticalThicknes'],
      ['DualBrushVerticalThicknes', 'DualBrushVerticalThickness']
    );
    if (rawDualVertThick !== null) {
      dualThicknessVertical = !Boolean(rawDualVertThick);
    }

    const rawDualAngle = getDualMerged(
      ['BrushRotation', 'Rotation', 'BrushAngle', 'Angle', 'DualBrushRotation'],
      ['DualBrushRotation', 'DualBrushAngle']
    );
    if (typeof rawDualAngle === 'number') {
      dualAngle = ((rawDualAngle % 360) + 360) % 360;
    }

    const rawDualRotEff = getDualMerged(
      ['BrushRotationEffector', 'RotationEffector', 'DualBrushRotationEffector'],
      ['DualBrushRotationEffector']
    );
    if (rawDualRotEff !== null) {
      const decodedDualRot = parseRotationEffector(rawDualRotEff);
      if (decodedDualRot.mode !== undefined) {
        dualAngleDynamics = decodedDualRot.mode;
      }
      if (decodedDualRot.sensor) {
        dualAngleSensor = decodedDualRot.sensor;
      }
    }

    const rawDualHardness = getDualMerged(
      ['BrushHardness', 'Hardness', 'DualBrushHardness'],
      ['DualBrushHardness']
    );
    if (typeof rawDualHardness === 'number' && rawDualHardness >= 0) {
      dualHardness = decodeCspHardness(rawDualHardness);
    }

    const rawDualDensity = getDualMerged(
      ['BrushDensity', 'BrushFlow', 'Density', 'Flow', 'DualBrushDensity'],
      ['DualBrushDensity', 'DualBrushFlow']
    );
    if (typeof rawDualDensity === 'number' && rawDualDensity >= 0) {
      dualDensity = rawDualDensity > 1.0 ? Math.min(1.0, rawDualDensity / 100) : rawDualDensity;
    }

    const rawDualPatternOrder = getDualMerged(
      ['BrushPatternOrderType', 'BrushPatternRepeatType', 'DualBrushPatternOrderType'],
      ['DualBrushPatternOrderType', 'DualBrushPatternRepeatType']
    );
    if (rawDualPatternOrder !== null) {
      dualSubTipOrder = mapPatternOrderType(rawDualPatternOrder);
    }

    const rawDualFlipH = getDualMerged(
      ['BrushPatternReverseHorizontal', 'BrushFlipX', 'DualBrushFlipH'],
      ['DualBrushFlipH', 'DualBrushPatternReverseHorizontal', 'DualBrushFlipX']
    );
    if (rawDualFlipH !== null) dualFlipH = mapFlipMode(rawDualFlipH);

    const rawDualFlipV = getDualMerged(
      ['BrushPatternReverseVertical', 'BrushFlipY', 'DualBrushFlipV'],
      ['DualBrushFlipV', 'DualBrushPatternReverseVertical', 'DualBrushFlipY']
    );
    if (rawDualFlipV !== null) dualFlipV = mapFlipMode(rawDualFlipV);

    const rawDualRibbon = getDualMerged(
      ['BrushRibbon', 'Ribbon', 'DualBrushRibbon'],
      ['DualBrushRibbon']
    );
    if (rawDualRibbon !== null) {
      dualIsRibbon = Boolean(rawDualRibbon);
    }

    // Dual spray settings (prefer dualVariantValues if BrushUseSpray is set there, else primary DualBrushUseSpray*)
    if (dualMap && dualMap.size > 0) {
      const getDualOnly = (aliases: string[]): any => {
        for (const a of aliases) {
          const v = dualMap.get(a.toLowerCase());
          if (v !== undefined && v !== null) return v;
        }
        return null;
      };
      dualSpray = parseSprayConfig(getDualOnly, '');
    }
    if (!dualSpray) {
      dualSpray = parseSprayConfig(getVal, 'Dual');
    }

    if (!rawDualPatternBlob) {
      const dualBlob = getDualMerged(
        ['BrushPatternImageArray', 'DualPatternImageArray'],
        ['DualPatternImageArray']
      );
      if (dualBlob instanceof Uint8Array) {
        rawDualPatternBlob = dualBlob;
      }
    }
  }

  // 4. MaterialFile extraction (prefer full-resolution Rust-decoded data/*.layer PNG over thumbnail.png)
  interface ExtractedMaterial {
    mainPng: Uint8Array;
    catalogPath: string;
    width: number;
    height: number;
    isPaperTexture: boolean;
    expressionColor?: CspExpressionColor;
    hasSubColor: boolean;
    fromNativeLayer: boolean;
    thumbnailScaleComp: number;
  }
  const estimatePaperThumbnailScaleFactor = (
    fileData: Uint8Array,
    thumbByteLen: number,
    thumbW: number,
    thumbH: number
  ): number => {
    if (!fileData || fileData.length < 512 || thumbByteLen <= 0 || Math.max(thumbW, thumbH) > 320) {
      return 1.0;
    }
    try {
      const entries = extractTarEntries(fileData);
      const layerEntry = entries.find((e) => {
        const n = e.name.toLowerCase();
        return n.startsWith('data/') && n.endsWith('.layer') && e.size > 0;
      });
      if (!layerEntry || layerEntry.size <= thumbByteLen * 3) {
        return 1.0;
      }
      // Encrypted C2F paper texture fell back to CSP's <=300px thumbnail.png;
      // byte area scales ~linearly with pixel count, so linear downscale ≈ sqrt(layerBytes / thumbBytes).
      const ratio = Math.sqrt(layerEntry.size / thumbByteLen);
      return Math.max(1.0, Math.min(5.0, ratio));
    } catch {
      return 1.0;
    }
  };
  const materialMap = new Map<string, ExtractedMaterial>();
  const allMaterialsList: ExtractedMaterial[] = [];

  const indexMaterialKey = (rawKey: string, entry: ExtractedMaterial) => {
    const trimmed = rawKey.trim();
    if (!trimmed) return;
    materialMap.set(trimmed, entry);
    // CSP Paint003/Install materials frequently store ".:Paint003:<uuid>:data:material.layer"
    // in OriginalPath while CatalogPath is empty; also index base/data prefixes and lowercase UUID.
    const dataIdx = trimmed.indexOf(':data');
    if (dataIdx > 0) {
      const basePrefix = trimmed.slice(0, dataIdx);
      if (basePrefix) materialMap.set(basePrefix, entry);
      materialMap.set(`${basePrefix}:data`, entry);
    }
    const uuidMatch = trimmed.match(
      /[a-f0-9]{10}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{10}/i
    );
    if (uuidMatch) {
      materialMap.set(uuidMatch[0].toLowerCase(), entry);
    }
  };

  for (const mat of extracted.materials) {
    const fileData = mat.fileData;
    const catPath = mat.catalogPath || '';
    const origPath = mat.originalPath || '';
    const pwId = mat.pwId;

    const hasNativeDecodedPng = Boolean(
      mat.decodedPng && mat.decodedPng.length > 0 && isPng(mat.decodedPng)
    );
    const mainPng = hasNativeDecodedPng
      ? mat.decodedPng!
      : fileData.length > 0
        ? extractMaterialPng(fileData)
        : null;

    if (mainPng) {
      let width = typeof mat.width === 'number' && mat.width > 0 ? mat.width : 64;
      let height = typeof mat.height === 'number' && mat.height > 0 ? mat.height : 64;
      if ((!mat.width || !mat.height) && mainPng.length >= 24) {
        const view = new DataView(mainPng.buffer, mainPng.byteOffset, mainPng.byteLength);
        width = view.getUint32(16, false);
        height = view.getUint32(20, false);
      }

      const fromNativeLayer =
        typeof mat.decodedFromLayer === 'boolean'
          ? mat.decodedFromLayer
          : hasNativeDecodedPng;
      const isPaperTex =
        typeof mat.isPaperTexture === 'boolean'
          ? mat.isPaperTexture
          : isMaterialPaperTexture(fileData);
      const entry: ExtractedMaterial = {
        mainPng,
        catalogPath: catPath || origPath,
        width,
        height,
        isPaperTexture: isPaperTex,
        expressionColor: mat.expressionColor,
        hasSubColor: Boolean(mat.hasSubColor),
        fromNativeLayer,
        thumbnailScaleComp:
          isPaperTex && !fromNativeLayer
            ? estimatePaperThumbnailScaleFactor(fileData, mainPng.length, width, height)
            : 1.0,
      };
      indexMaterialKey(catPath, entry);
      indexMaterialKey(origPath, entry);
      if (pwId) materialMap.set(pwId, entry);

      allMaterialsList.push(entry);
    }
  }

  const resolveMaterialRef = (ref: string): ExtractedMaterial | undefined => {
    const trimmed = ref.trim();
    if (!trimmed) return undefined;
    const direct = materialMap.get(trimmed);
    if (direct) return direct;
    const dataIdx = trimmed.indexOf(':data');
    if (dataIdx > 0) {
      const byBase = materialMap.get(trimmed.slice(0, dataIdx));
      if (byBase) return byBase;
    }
    const uuidMatch = trimmed.match(/[a-f0-9]{10}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{10}/i);
    if (uuidMatch) {
      return materialMap.get(uuidMatch[0].toLowerCase());
    }
    return undefined;
  };

  // 5. Match Paper Texture (with missing external material diagnostics)
  let paperTexture: string | undefined = undefined;
  let paperTextureEntry: ExtractedMaterial | null = null;

  if (rawTextureImageBlob) {
    const texIds = extractCatalogIdsFromBlob(rawTextureImageBlob);
    for (const tid of texIds) {
      const entry = resolveMaterialRef(tid);
      if (entry) {
        paperTextureEntry = entry;
        paperTexture = bytesToDataUrl(paperTextureEntry.mainPng, 'image/png');
        if (entry.thumbnailScaleComp > 1.001) {
          paperTextureScale = Math.min(20.0, paperTextureScale * entry.thumbnailScaleComp);
        }
        break;
      }
    }
    if (!paperTexture && texIds.length > 0) {
      importWarnings.push(
        `Missing external paper texture material (${texIds[0]}): not embedded in MaterialFile; paper grain disabled.`
      );
    }
  }
  if (!paperTexture) {
    // CSP stores TextureDensity=50 even when no texture image is bound; avoid ghost grain.
    textureDensity = 0;
  }

  // 6. Match Brush Tip(s) — NEVER hijack a PaperTexture or ignore BrushUsePatternImage=0!
  const tipPngEntries: ExtractedMaterial[] = [];

  if (usePatternImage !== false) {
    let referencedPatternIds: string[] = [];
    if (rawPatternArrayBlob) {
      referencedPatternIds = extractCatalogIdsFromBlob(rawPatternArrayBlob);
      const missingTipRefs: string[] = [];
      for (const pid of referencedPatternIds) {
        const entry = resolveMaterialRef(pid);
        if (entry) {
          if (entry !== paperTextureEntry && !entry.isPaperTexture && !tipPngEntries.includes(entry)) {
            tipPngEntries.push(entry);
          }
        } else {
          missingTipRefs.push(pid);
        }
      }
      if (missingTipRefs.length > 0) {
        importWarnings.push(
          `Missing external brush tip material (${missingTipRefs.join(', ')}): not embedded in MaterialFile; using procedural tip fallback.`
        );
      }
    }

    if (
      tipPngEntries.length === 0 &&
      referencedPatternIds.length === 0 &&
      allMaterialsList.length > 0 &&
      usePatternImage === true
    ) {
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

  // 7. Process extracted custom tips; for Circle tips (BrushUsePatternImage=0) or missing external tips,
  // leave tipDataUrl undefined so BrushEngine renders its analytical/SDF circular/elliptical tip cleanly.
  let tipDataUrl: string | undefined = undefined;
  let tipWidth: number | undefined = undefined;
  let tipHeight: number | undefined = undefined;
  let isColorTip = false;
  let isDualToneTip = false;
  const subTips: CspSubTip[] = [];
  const fallbackProc = { hardness, thickness: 1.0, antiAlias };

  if (tipPngEntries.length > 0) {
    for (let i = 0; i < tipPngEntries.length; i++) {
      const entry = tipPngEntries[i];
      const u = bytesToDataUrl(entry.mainPng, 'image/png');
      const p = await processBrushTipImage(u, fallbackProc, {
        width: entry.width,
        height: entry.height,
        expressionColor: entry.expressionColor,
        hasSubColor: entry.hasSubColor,
        fromNativeLayer: entry.fromNativeLayer,
      });
      if (i === 0) {
        tipDataUrl = p.dataUrl;
        tipWidth = p.width;
        tipHeight = p.height;
        isColorTip = p.isColor;
        isDualToneTip = p.isDualToneTip;
      }
      subTips.push({
        dataUrl: p.dataUrl,
        width: p.width,
        height: p.height,
        isColor: p.isColor,
        isDualToneTip: p.isDualToneTip,
      });
    }
  }

  let secondaryTipDataUrl: string | undefined = undefined;
  let secondaryTipWidth: number | undefined = undefined;
  let secondaryTipHeight: number | undefined = undefined;
  const dualSubTips: CspSubTip[] = [];

  if (dualBrush && rawDualPatternBlob) {
    const dualIds = extractCatalogIdsFromBlob(rawDualPatternBlob);
    const missingDualRefs: string[] = [];
    for (const did of dualIds) {
      const entry = resolveMaterialRef(did);
      if (entry && entry !== paperTextureEntry && !entry.isPaperTexture) {
        const u = bytesToDataUrl(entry.mainPng, 'image/png');
        const p = await processBrushTipImage(u, fallbackProc, {
          width: entry.width,
          height: entry.height,
          expressionColor: entry.expressionColor,
          hasSubColor: entry.hasSubColor,
          fromNativeLayer: entry.fromNativeLayer,
        });
        if (!secondaryTipDataUrl) {
          secondaryTipDataUrl = p.dataUrl;
          secondaryTipWidth = p.width;
          secondaryTipHeight = p.height;
        }
        dualSubTips.push({
          dataUrl: p.dataUrl,
          width: p.width,
          height: p.height,
          isColor: p.isColor,
          isDualToneTip: p.isDualToneTip,
        });
      } else if (!entry) {
        missingDualRefs.push(did);
      }
    }
    if (missingDualRefs.length > 0) {
      importWarnings.push(
        `Missing external dual brush tip material (${missingDualRefs.join(', ')}): not embedded in MaterialFile; using procedural fallback.`
      );
    }
  }

  const uniqueId = `csp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const dualBrushConfig: CspDualBrushConfig | undefined = dualBrush
    ? {
        enabled: true,
        compositeMode: normalizeDualBrushCompositeMode(dualBrushCompositeMode),
        linkSizeWithMain: dualLinkSize,
        size: dualSize,
        sizeRatio:
          dualSize !== undefined && brushSize > 0 ? dualSize / brushSize : undefined,
        spacing: dualSpacing,
        thickness: dualThickness,
        thicknessVertical: dualThicknessVertical,
        hardness: dualHardness,
        density: dualDensity,
        angle: dualAngle,
        angleDynamics: dualAngleDynamics,
        angleSensor: dualAngleSensor,
        flipH: dualFlipH,
        flipV: dualFlipV,
        spray: dualSpray,
        tipDataUrl: secondaryTipDataUrl,
        subTips: dualSubTips.length > 1 ? dualSubTips : undefined,
        subTipOrder: dualSubTipOrder,
        isRibbon: dualIsRibbon,
      }
    : undefined;

  const cspBrush: CspBrush = {
    id: uniqueId,
    name: brushName,
    badge: 'CSP',
    desc: tipPngEntries.length > 0 ? 'Clip Studio Paint Textured Brush' : 'Clip Studio Paint Brush',
    tipDataUrl,
    tipWidth,
    tipHeight,
    isColorTip,
    isDualToneTip,
    secondaryTipDataUrl,
    secondaryTipWidth,
    secondaryTipHeight,
    subTips: subTips.length > 1 ? subTips : undefined,
    subTipOrder,
    size: brushSize,
    brushSizeUnit,
    brushSizeSpecifiedByScreen,
    minSizeFactor,
    opacity,
    flow,
    adjustDensityByGap,
    blendTipsMode,
    brushCombineMode,
    spacing,
    hardness,
    thickness,
    thicknessVertical,
    thicknessSensor,
    flipH,
    flipV,
    angle,
    angleDynamics,
    angleSensor,
    rotationRandomScale,
    antiAlias,
    usePressure,
    useVelocity,
    useTilt,
    sizeSensor,
    opacitySensor,
    densitySensor,
    intervalSensor,
    textureDensitySensor,
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
    amountOfPaintSensor,
    densityOfPaintSensor,
    colorStretchSensor,
    mixGroundColor,
    useBlur,
    blurStrength,
    mixingMode,
    wetEdge,
    wetEdgeRadius,
    wetEdgeAlphaPower,
    wetEdgeValuePower,
    paperTexture,
    grainMappingMode,
    textureDensity,
    paperTextureScale,
    paperTextureRotate,
    paperTextureOffsetX,
    paperTextureOffsetY,
    paperTextureMode,
    paperTextureBrightness,
    paperTextureContrast,
    paperTextureApplyEachPlot,
    paperTextureEmphasizeDensity,
    paperTextureInverted,
    dualBrush,
    dualBrushConfig,
    dualBrushCompositeMode,
    dualSize,
    dualLinkSize,
    dualSpacing,
    dualThickness,
    dualThicknessVertical,
    dualAngle,
    dualAngleDynamics,
    dualAngleSensor,
    dualHardness,
    dualDensity,
    dualSubTips: dualSubTips.length > 1 ? dualSubTips : undefined,
    dualSubTipOrder,
    dualFlipH,
    dualFlipV,
    dualSpray,
    dualIsRibbon,
    spray,
    taper,
    dynamics,
    isRibbon,
    pressureCurveGamma: 1.0,
    importWarnings: importWarnings.length > 0 ? importWarnings : undefined,
    importedAt: Date.now(),
  };

  return cspBrush;
}
