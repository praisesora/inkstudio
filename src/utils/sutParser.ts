import initSqlJs from 'sql.js';
import { inflateSync } from 'fflate';
import { CspBrush, CspSubTip, CspSpraySettings, CspTaperSettings } from '../types/editor';

let sqlJsPromise: Promise<any> | null = null;

async function getSql() {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      locateFile: () => '/sql-wasm.wasm',
    });
  }
  return await sqlJsPromise;
}

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
  ]; // 'SQLite format 3\0'

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
    const magic = new TextDecoder('ascii').decode(buffer.slice(0, 8));
    if (magic === 'CSFCHUNK') {
      let offset = 24;
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

      while (offset + 16 <= buffer.length) {
        const chunkTag = new TextDecoder('ascii').decode(buffer.slice(offset, offset + 4));
        if (chunkTag !== 'CHNK') break;

        const chunkName = new TextDecoder('ascii').decode(buffer.slice(offset + 4, offset + 8));
        const chunkSize = view.getUint32(offset + 12, false); // big-endian
        const dataStart = offset + 16;
        const dataEnd = dataStart + chunkSize;
        if (dataEnd > buffer.length) break;

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
 * Extracts PNG byte arrays from binary BLOB (handling raw PNG, tar archives, or zlib compression).
 */
export function extractPngImagesFromBlob(data: Uint8Array): Uint8Array[] {
  const pngs: Uint8Array[] = [];
  if (!data || data.length < 16) return pngs;

  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const iendTag = [0x49, 0x45, 0x4e, 0x44]; // 'IEND'

  const tryScan = (buf: Uint8Array) => {
    let pos = 0;
    while (pos < buf.length - 8) {
      const startIdx = indexOfSequence(buf, pngMagic, pos);
      if (startIdx === -1) break;

      const iendIdx = indexOfSequence(buf, iendTag, startIdx + 8);
      if (iendIdx === -1) {
        pos = startIdx + 8;
        continue;
      }

      // IEND is: 4 bytes length + 4 bytes 'IEND' + 4 bytes CRC = +8 past iendIdx
      const endIdx = iendIdx + 8;
      if (endIdx <= buf.length) {
        pngs.push(buf.slice(startIdx, endIdx));
        pos = endIdx;
      } else {
        pos = startIdx + 8;
      }
    }
  };

  // Direct scan
  tryScan(data);

  // If none found and looks like zlib compressed (first byte 0x78), try decompressing
  if (pngs.length === 0 && data.length > 2 && data[0] === 0x78) {
    try {
      const decompressed = inflateSync(data);
      tryScan(decompressed);
    } catch {
      // Ignore decompression error
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
 * Extracts the primary raster image from a Clip Studio Paint MaterialFile BLOB.
 * MaterialFile.FileData is an uncompressed USTAR archive.
 * The authentic brush tip or paper texture is stored in 'thumbnail/thumbnail.png'.
 * (data/material_0.layer is a C2F file containing empty 0-alpha layer canvas tiles).
 */
export function extractMaterialPng(fileData: Uint8Array): Uint8Array | null {
  if (!fileData || fileData.length < 16) return null;

  try {
    const tarEntries = extractTarEntries(fileData);
    if (tarEntries.length > 0) {
      // 1. Prioritize thumbnail/thumbnail.png (authentic rendered tip or paper texture)
      const thumb = tarEntries.find((e) => e.name.toLowerCase().endsWith('thumbnail.png'));
      if (thumb && isPng(thumb.data)) {
        return thumb.data;
      }
      // 2. Any other valid PNG in the archive
      const anyPng = tarEntries.find((e) => e.name.toLowerCase().endsWith('.png') && isPng(e.data));
      if (anyPng) {
        return anyPng.data;
      }
    }
  } catch {
    // Fall back to direct scan
  }

  // 3. Fallback: direct scan for PNG chunks (sort descending by size to ignore 4KB 0-alpha layer dummies)
  const pngs = extractPngImagesFromBlob(fileData);
  if (pngs.length > 0) {
    pngs.sort((a, b) => b.length - a.length);
    return pngs[0];
  }

  return null;
}

/**
 * Converts a Uint8Array of image bytes to a Base64 data URL.
 */
export function bytesToDataUrl(bytes: Uint8Array, mime: string = 'image/png'): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * Decodes strings from a binary buffer (handles UTF-16LE, UTF-16BE, and ASCII).
 * Extracts Clip Studio Paint catalog identifiers: e.g. ".:36:98:acedf7c35d-144c-1ab1-39df-ec7fb2dbe4"
 */
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
    // Also UUIDs directly
    const uuidRe = /[a-f0-9]{10}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{10}/gi;
    while ((match = uuidRe.exec(text)) !== null) {
      if (!results.includes(match[0])) {
        results.push(match[0]);
      }
    }
  };

  try {
    const le = new TextDecoder('utf-16le', { fatal: false }).decode(blob);
    addMatches(le);
  } catch {
    // Ignore decoding errors
  }

  try {
    const be = new TextDecoder('utf-16be', { fatal: false }).decode(blob);
    addMatches(be);
  } catch {
    // Ignore decoding errors
  }

  try {
    const latin = new TextDecoder('latin1', { fatal: false }).decode(blob);
    addMatches(latin);
  } catch {
    // Ignore decoding errors
  }

  return results;
}

/**
 * Decodes Clip Studio Paint *Effector binary blobs.
 * Contains stylus pressure, tilt, and velocity dynamics curves.
 */
export interface DecodedEffector {
  usePressure: boolean;
  useTilt: boolean;
  useVelocity: boolean;
  useRandom: boolean;
  minValue: number; // 0.0 to 1.0
  maxValue: number; // 0.0 to 1.0
  pressureCurve?: [number, number][];
  velocityCurve?: [number, number][];
}

export function parseCspEffector(blob: Uint8Array | null | undefined): DecodedEffector | null {
  if (!blob || blob.length < 44) return null;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);

  const sourceFlags = view.getUint32(8, false); // big-endian
  const usePressure = Boolean(sourceFlags & 0x10);
  const useTilt = Boolean(sourceFlags & 0x20);
  const useVelocity = Boolean(sourceFlags & 0x80);
  const useRandom = Boolean(sourceFlags & 0x01);

  const rawMin = view.getUint32(12, false);
  const rawMax = view.getUint32(16, false);
  const minValue = Math.max(0, Math.min(1.0, rawMin / 100.0));
  const maxValue = rawMax > 0 ? Math.max(0, Math.min(1.0, rawMax / 100.0)) : 1.0;

  const curves: [number, number][][] = [];
  let offset = 44;

  while (offset + 12 <= blob.length) {
    const magic = view.getUint32(offset, false);
    const numPts = view.getUint32(offset + 4, false);
    const ptSize = view.getUint32(offset + 8, false);

    if (magic !== 12 || ptSize !== 16 || offset + 12 + numPts * 16 > blob.length) {
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

  let pressureCurve: [number, number][] | undefined = undefined;
  let velocityCurve: [number, number][] | undefined = undefined;

  if (curves.length > 0) {
    if (usePressure) {
      pressureCurve = curves[0];
      if (useVelocity && curves.length > 1) {
        velocityCurve = curves[1];
      }
    } else if (useVelocity) {
      velocityCurve = curves[0];
    }
  }

  return {
    usePressure,
    useTilt,
    useVelocity,
    useRandom,
    minValue,
    maxValue,
    pressureCurve,
    velocityCurve,
  };
}

/**
 * Evaluates a value through a Clip Studio Paint cubic Hermite spline curve (PCHIP).
 * Monotonic without overshoot, guaranteeing 100% authentic pen response.
 */
export function evaluateCspSpline(x: number, pts?: [number, number][]): number {
  if (!pts || pts.length === 0) return x;
  if (pts.length === 1) return pts[0][1];
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];

  const n = pts.length;
  // Calculate secant slopes
  const deltas: number[] = new Array(n - 1);
  for (let k = 0; k < n - 1; k++) {
    const dx = pts[k + 1][0] - pts[k][0];
    deltas[k] = dx === 0 ? 0 : (pts[k + 1][1] - pts[k][1]) / dx;
  }

  // Calculate tangents
  const m: number[] = new Array(n).fill(0);
  m[0] = deltas[0];
  m[n - 1] = deltas[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (deltas[k - 1] * deltas[k] <= 0) {
      m[k] = 0;
    } else {
      const dxPrev = pts[k][0] - pts[k - 1][0];
      const dxNext = pts[k + 1][0] - pts[k][0];
      m[k] =
        (3 * (dxPrev + dxNext)) /
        ((2 * dxNext + dxPrev) / deltas[k - 1] + (dxNext + 2 * dxPrev) / deltas[k]);
    }
  }

  // Interpolate segment
  for (let k = 0; k < n - 1; k++) {
    if (pts[k][0] <= x && x <= pts[k + 1][0]) {
      const h = pts[k + 1][0] - pts[k][0];
      if (h === 0) return pts[k][1];
      const t = (x - pts[k][0]) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      return h00 * pts[k][1] + h10 * h * m[k] + h01 * pts[k + 1][1] + h11 * h * m[k + 1];
    }
  }

  return pts[pts.length - 1][1];
}

/**
 * Normalizes brush tip alpha and transparency:
 * If the image is opaque (black ink on white canvas), it converts luminance to alpha.
 * Detects chromatic multi-colored stamps and preserves color channels.
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

      // Check transparency, chromatic color variance, and max alpha
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

      // If the image is completely empty / 0-alpha (dummy layer tile or corrupt blob)
      if (maxAlpha === 0 || nonZeroCount === 0) {
        const proc = generateProceduralTip(
          fallbackProcedural?.hardness ?? 1.0,
          fallbackProcedural?.thickness ?? 1.0,
          fallbackProcedural?.antiAlias ?? 2
        );
        resolve({ dataUrl: proc.dataUrl, width: proc.width, height: proc.height, isColor: false });
        return;
      }

      // If opaque (white background with dark markings), map luminance to alpha
      if (!hasAlpha) {
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          // Invert: 255 (white) => 0 alpha, 0 (black) => 255 alpha
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const alpha = Math.max(0, Math.min(255, Math.round(255 - lum)));
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          data[i + 3] = alpha;
        }
        ctx.putImageData(imgData, 0, 0);
        resolve({ dataUrl: canvas.toDataURL('image/png'), width: w, height: h, isColor: false });
      } else if (!hasColor) {
        // Ensure monochrome color channels are white so tinting via 'source-in' & shaders works accurately
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
        resolve({ dataUrl: canvas.toDataURL('image/png'), width: w, height: h, isColor: false });
      } else {
        // Multi-color pattern brush: retain original colors and alpha
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
 * Generates an authentic Clip Studio Paint procedural tip (e.g. for Turnip Pen, G-Pen, Textured Pen).
 * Accurately models hardness falloff, elliptical thickness squeeze, and anti-aliasing.
 */
export function generateProceduralTip(
  hardness: number = 1.0, // 0.05 to 1.0
  thickness: number = 1.0, // 0.05 to 1.0
  antiAlias: number = 2 // 0: none/binary, 1: low, 2: mid, 3: high
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
          // Hermite smoothstep
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

/**
 * Parses a Clip Studio Paint .sut (Sub Tool) brush file.
 * Returns a fully configured CspBrush object ready for painting and saving.
 */
export async function parseSutFile(
  fileBuffer: ArrayBuffer | Uint8Array,
  fileName: string = 'Brush.sut'
): Promise<CspBrush> {
  const rawBytes = fileBuffer instanceof Uint8Array ? fileBuffer : new Uint8Array(fileBuffer);
  const sqliteData = extractSqliteFromBuffer(rawBytes);

  if (!sqliteData) {
    throw new Error('Invalid Clip Studio Paint file: No SQLite database header found in .sut');
  }

  const SQL = await getSql();
  let db: any = null;

  try {
    db = new SQL.Database(sqliteData);

    // 1. Get Tables List
    const tablesQuery = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const tables: string[] = [];
    if (tablesQuery.length > 0 && tablesQuery[0].values) {
      for (const row of tablesQuery[0].values) {
        if (row[0]) tables.push(String(row[0]));
      }
    }

    // 2. Brush Name & Target Variant ID from Node table
    let brushName = fileName.replace(/\.sut$/i, '').trim();
    let variantId: number | null = null;

    if (tables.includes('Node')) {
      try {
        const nodeRes = db.exec('SELECT NodeName, NodeVariantId FROM Node LIMIT 1');
        if (nodeRes.length > 0 && nodeRes[0].values && nodeRes[0].values.length > 0) {
          const row = nodeRes[0].values[0];
          if (row[0] && typeof row[0] === 'string' && row[0].trim().length > 0) {
            brushName = row[0].trim();
          }
          if (row[1] !== null && row[1] !== undefined) {
            variantId = Number(row[1]);
          }
        }
      } catch {
        // Fallback to filename
      }
    }

    // 3. Variant Parameters from Variant table
    let brushSize = 16;
    let minSizeFactor = 0.2;
    let opacity = 1.0;
    let flow = 0.85;
    let spacing = 0.08;
    let hardness = 1.0;
    let thickness = 1.0;
    let thicknessVertical = false;
    let angle = 0;
    let angleDynamics: 'none' | 'direction' | 'random' = 'none';
    let rotationRandomScale = 0;
    let antiAlias = 2;
    let stabilization = 0;
    let usePressure = true;
    let useVelocity = false;
    let pressureCurve: [number, number][] | undefined = undefined;
    let velocityCurve: [number, number][] | undefined = undefined;
    let colorMixing = false;
    let amountOfPaint = 0.7;
    let densityOfPaint = 0.8;
    let colorStretch = 0.6;
    let mixingMode: 'blend' | 'running_color' = 'blend';
    let wetEdge = 0;
    let wetEdgeRadius = 3.0;
    let wetEdgeAlphaPower = 20;
    let wetEdgeValuePower = 0;
    let textureDensity = 0;
    let paperTextureScale = 1.0;
    let paperTextureRotate = 0;
    let spray: CspSpraySettings | undefined = undefined;
    let taper: CspTaperSettings | undefined = undefined;
    let isRibbon = false;
    let dualBrush = false;
    let dualBrushCompositeMode = 'multiply';
    let rawPatternArrayBlob: Uint8Array | null = null;
    let rawTextureImageBlob: Uint8Array | null = null;
    let rawDualPatternBlob: Uint8Array | null = null;

    if (tables.includes('Variant')) {
      try {
        const pragmaCols = db.exec('PRAGMA table_info(Variant)');
        const colNames: string[] = [];
        if (pragmaCols.length > 0 && pragmaCols[0].values) {
          for (const row of pragmaCols[0].values) {
            colNames.push(String(row[1]));
          }
        }

        const colMap = new Map<string, string>();
        for (const c of colNames) {
          colMap.set(c.toLowerCase(), c);
        }

        const sql =
          variantId !== null
            ? `SELECT * FROM Variant WHERE _PW_ID = ${variantId} LIMIT 1`
            : 'SELECT * FROM Variant LIMIT 1';

        const varRes = db.exec(sql);
        if (varRes.length > 0 && varRes[0].values && varRes[0].values.length > 0) {
          const row = varRes[0].values[0];
          const getVal = (aliases: string[]): any => {
            for (const a of aliases) {
              const exact = colMap.get(a.toLowerCase());
              if (exact) {
                const idx = varRes[0].columns.indexOf(exact);
                if (idx !== -1 && row[idx] !== null && row[idx] !== undefined) {
                  return row[idx];
                }
              }
            }
            return null;
          };

          // Size
          const rawSize = getVal(['BrushSize', 'Size', 'PenSize', 'BrushSizeVal', 'LineWidth']);
          if (typeof rawSize === 'number' && rawSize > 0) {
            if (rawSize > 500) {
              brushSize = Math.max(2, Math.min(300, rawSize / 100));
            } else if (rawSize > 250) {
              brushSize = Math.max(2, Math.min(300, rawSize / 10));
            } else {
              brushSize = Math.max(1, Math.min(300, rawSize));
            }
          }

          // Size Dynamics Effector (Pressure, Velocity, MinSize, Spline curve)
          const sizeEffBlob = getVal(['BrushSizeEffector', 'SizeEffector']);
          if (sizeEffBlob instanceof Uint8Array) {
            const eff = parseCspEffector(sizeEffBlob);
            if (eff) {
              usePressure = eff.usePressure;
              useVelocity = eff.useVelocity;
              minSizeFactor = eff.minValue;
              pressureCurve = eff.pressureCurve;
              velocityCurve = eff.velocityCurve;
            }
          }

          // Spacing / Interval
          const rawSpacing = getVal(['BrushInterval', 'Interval', 'Spacing', 'BrushSpacing']);
          if (typeof rawSpacing === 'number' && rawSpacing > 0) {
            spacing = rawSpacing > 1.0 ? Math.max(0.01, Math.min(1.0, rawSpacing / 100)) : Math.max(0.01, Math.min(1.0, rawSpacing));
          }

          // Opacity
          const rawOpacity = getVal(['Opacity', 'BrushOpacity', 'BrushDensity', 'Density']);
          if (typeof rawOpacity === 'number' && rawOpacity > 0) {
            opacity = rawOpacity > 1.0 ? Math.min(1.0, rawOpacity / 100) : rawOpacity;
          }

          // Flow
          const rawFlow = getVal(['BrushFlow', 'Flow', 'PaintAmount', 'InkAmount']);
          if (typeof rawFlow === 'number' && rawFlow > 0) {
            flow = rawFlow > 1.0 ? Math.min(1.0, rawFlow / 100) : rawFlow;
          }

          // Hardness
          const rawHardness = getVal(['BrushHardness', 'Hardness']);
          if (typeof rawHardness === 'number' && rawHardness > 0) {
            if (rawHardness <= 5) {
              hardness = Math.max(0.05, Math.min(1.0, rawHardness / 5));
            } else {
              hardness = Math.max(0.05, Math.min(1.0, rawHardness / 100));
            }
          }

          // Thickness (Elliptical squeeze)
          const rawThickness = getVal(['BrushThickness', 'Thickness']);
          if (typeof rawThickness === 'number' && rawThickness > 0) {
            thickness = Math.max(0.05, Math.min(1.0, rawThickness / 100));
          }
          const rawVertThick = getVal(['BrushVerticalThicknes', 'VerticalThickness']);
          if (rawVertThick !== null) {
            thicknessVertical = Boolean(rawVertThick);
          }

          // Rotation & Rotation Dynamics
          const rawAngle = getVal(['BrushRotation', 'Rotation', 'BrushAngle', 'Angle']);
          if (typeof rawAngle === 'number') {
            angle = (rawAngle % 360 + 360) % 360;
          }

          const rawRotEff = getVal(['BrushRotationEffector', 'RotationEffector', 'AngleDynamics']);
          if (typeof rawRotEff === 'number') {
            // In CSP: bit 7 (128) or bit 1/2 indicate direction / line direction
            if (rawRotEff & 0x80 || rawRotEff === 3 || rawRotEff === 67 || rawRotEff === 131) {
              angleDynamics = 'direction';
            }
          }

          const rawRandRot = getVal(['BrushRotationRandomScale', 'RotationRandomScale']);
          if (typeof rawRandRot === 'number' && rawRandRot > 0) {
            rotationRandomScale = Math.min(1.0, rawRandRot / 100);
            if (angleDynamics === 'none') {
              angleDynamics = 'random';
            }
          }

          // Anti-Aliasing
          const rawAA = getVal(['AntiAlias', 'BrushAntiAlias']);
          if (typeof rawAA === 'number') {
            antiAlias = Math.max(0, Math.min(3, Math.round(rawAA)));
          }

          // Stabilization
          const rawRev = getVal(['BrushRevision', 'Revision', 'FlickerReduction', 'BrushStabilization']);
          if (typeof rawRev === 'number' && rawRev >= 0) {
            stabilization = Math.min(50, Math.max(0, Math.round(rawRev)));
          }

          // Ribbon Mode
          const rawRibbon = getVal(['BrushRibbon', 'Ribbon']);
          if (rawRibbon !== null) {
            isRibbon = Boolean(rawRibbon);
          }

          // Color Mixing & Smear
          const rawMixing = getVal(['BrushUseWaterColor', 'BrushUseWaterColor2', 'ColorMixing', 'EnableColorMixing']);
          if (rawMixing !== null) {
            colorMixing = Boolean(rawMixing);
          }

          const rawMixColor = getVal(['BrushMixColor', 'AmountOfPaint', 'PaintAmount', 'ColorMixAmount']);
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

          const rawMixMode = getVal(['BrushColorMixingMode', 'MixingMode']);
          if (rawMixMode !== null) {
            mixingMode = Number(rawMixMode) === 1 ? 'running_color' : 'blend';
          }

          // Wet Edge (Water Edge)
          const rawWetEdge = getVal(['BrushUseWaterEdge', 'UseWaterEdge']);
          if (rawWetEdge !== null) {
            wetEdge = Boolean(rawWetEdge) ? 0.75 : 0;
          }
          const rawWetRad = getVal(['BrushWaterEdgeRadius', 'WaterEdgeRadius']);
          if (typeof rawWetRad === 'number' && rawWetRad > 0) {
            wetEdgeRadius = rawWetRad;
          }
          const rawWetAlpha = getVal(['BrushWaterEdgeAlphaPower', 'WaterEdgeAlphaPower']);
          if (typeof rawWetAlpha === 'number' && rawWetAlpha > 0) {
            wetEdgeAlphaPower = rawWetAlpha;
            if (!rawWetEdge) wetEdge = Math.min(1.0, rawWetAlpha / 100);
          }
          const rawWetVal = getVal(['BrushWaterEdgeValuePower', 'WaterEdgeValuePower']);
          if (typeof rawWetVal === 'number' && rawWetVal > 0) {
            wetEdgeValuePower = rawWetVal;
          }

          // Paper Grain / Texture
          const rawTexDensity = getVal(['TextureDensity', 'Grain', 'BrushTextureDensity']);
          if (typeof rawTexDensity === 'number' && rawTexDensity > 0) {
            textureDensity = rawTexDensity > 1.0 ? Math.min(1.0, rawTexDensity / 100) : rawTexDensity;
          }
          const rawTexScale = getVal(['TextureScale2', 'TextureScale']);
          if (typeof rawTexScale === 'number' && rawTexScale > 0) {
            paperTextureScale = rawTexScale / 100;
          }
          const rawTexRotate = getVal(['TextureRotate']);
          if (typeof rawTexRotate === 'number') {
            paperTextureRotate = rawTexRotate;
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
              density: typeof rawSprayDensity === 'number' ? Math.max(1, Math.min(50, rawSprayDensity)) : 5,
              bias: typeof rawSprayBias === 'number' ? Math.max(-1, Math.min(1, rawSprayBias / 100)) : 0,
            };
          }

          // Taper (In / Out)
          const rawUseIn = getVal(['BrushUseIn']);
          const rawUseOut = getVal(['BrushUseOut']);
          const useIn = rawUseIn !== null ? Boolean(rawUseIn) : false;
          const useOut = rawUseOut !== null ? Boolean(rawUseOut) : false;
          const inLength = Number(getVal(['BrushInLength']) || 0);
          const inRatio = Number(getVal(['BrushInRatio']) || 0);
          const outLength = Number(getVal(['BrushOutLength']) || 0);
          const outRatio = Number(getVal(['BrushOutRatio']) || 0);
          const inOutType = Number(getVal(['BrushInOutType']) || 0);
          const inOutBySpeed = Boolean(getVal(['BrushInOutBySpeed']));

          if (useIn || useOut || inLength > 0 || outLength > 0 || inRatio > 0 || outRatio > 0) {
            taper = {
              useIn,
              inLength,
              inRatio,
              useOut,
              outLength,
              outRatio,
              inOutType,
              inOutBySpeed,
            };
          }

          // Dual Brush
          const rawDual = getVal(['UseDualBrush']);
          if (Boolean(rawDual)) {
            dualBrush = true;
          }

          // Blobs for image arrays
          rawPatternArrayBlob = getVal(['BrushPatternImageArray']);
          rawTextureImageBlob = getVal(['TextureImage']);
          rawDualPatternBlob = getVal(['DualPatternImageArray']);
        }
      } catch {
        // Variant query fallback
      }
    }

    // 4. MaterialFile extraction and mapping
    const materialMap = new Map<string, { mainPng: Uint8Array; width: number; height: number }>();
    const allMaterialsList: { mainPng: Uint8Array; catalogPath: string; width: number; height: number }[] = [];

    if (tables.includes('MaterialFile')) {
      try {
        const matRes = db.exec('SELECT _PW_ID, OriginalPath, FileData, CatalogPath FROM MaterialFile');
        if (matRes.length > 0 && matRes[0].values) {
          for (const row of matRes[0].values) {
            const fileData = row[2];
            const catPath = row[3] ? String(row[3]) : '';
            const pwId = String(row[0]);

            if (fileData instanceof Uint8Array && fileData.length > 0) {
              const mainPng = extractMaterialPng(fileData);
              if (mainPng) {
                let width = 64;
                let height = 64;
                if (mainPng.length >= 24) {
                  const view = new DataView(mainPng.buffer, mainPng.byteOffset, mainPng.byteLength);
                  width = view.getUint32(16, false);
                  height = view.getUint32(20, false);
                }

                const entry = { mainPng, width, height };
                if (catPath) materialMap.set(catPath, entry);
                materialMap.set(pwId, entry);

                // Index by UUID
                const uuidMatch = catPath.match(/[a-f0-9]{10}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{10}/i);
                if (uuidMatch) {
                  materialMap.set(uuidMatch[0], entry);
                }

                allMaterialsList.push({ mainPng, catalogPath: catPath, width, height });
              }
            }
          }
        }
      } catch {
        // MaterialFile fallback
      }
    }

    // 5. Match Paper Texture from TextureImage
    let paperTexture: string | undefined = undefined;
    let paperTextureEntry: { mainPng: Uint8Array } | null = null;

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

    // 6. Match Brush Tip(s) from BrushPatternImageArray
    const tipPngEntries: { mainPng: Uint8Array; width: number; height: number }[] = [];

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

    // If no pattern array match, but materials exist, assign non-texture materials as tips
    if (tipPngEntries.length === 0 && allMaterialsList.length > 0) {
      for (const m of allMaterialsList) {
        if (m !== paperTextureEntry && !tipPngEntries.some((e) => e.mainPng === m.mainPng)) {
          tipPngEntries.push(m);
        }
      }
    }

    // 7. Process extracted tips or generate authentic procedural tip
    let tipDataUrl: string | undefined = undefined;
    let tipWidth: number | undefined = undefined;
    let tipHeight: number | undefined = undefined;
    const subTips: CspSubTip[] = [];
    const fallbackProc = { hardness, thickness, antiAlias };

    if (tipPngEntries.length > 0) {
      // Primary Tip
      const primaryEntry = tipPngEntries[0];
      const rawUrl = bytesToDataUrl(primaryEntry.mainPng, 'image/png');
      const processed = await processBrushTipImage(rawUrl, fallbackProc);
      tipDataUrl = processed.dataUrl;
      tipWidth = processed.width;
      tipHeight = processed.height;

      // All sub-tips
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
    } else {
      // Authentic CSP Procedural Pen Tip (Turnip pen, G-pen, Textured pen, Calligraphy oval)
      const proc = generateProceduralTip(hardness, thickness, antiAlias);
      tipDataUrl = proc.dataUrl;
      tipWidth = proc.width;
      tipHeight = proc.height;
    }

    // Secondary Tip for Dual Brush
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
      desc: tipPngEntries.length > 0 ? 'Clip Studio Paint Textured Brush' : 'Clip Studio Paint Inking Pen',
      tipDataUrl,
      tipWidth,
      tipHeight,
      secondaryTipDataUrl,
      secondaryTipWidth,
      secondaryTipHeight,
      subTips: subTips.length > 1 ? subTips : undefined,
      size: brushSize,
      minSizeFactor,
      opacity,
      flow,
      spacing,
      hardness,
      thickness,
      thicknessVertical,
      angle,
      angleDynamics,
      rotationRandomScale,
      antiAlias,
      usePressure,
      useVelocity,
      smoothing: true,
      stabilization,
      pressureCurve,
      velocityCurve,
      colorMixing,
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
      dualBrush,
      dualBrushCompositeMode,
      spray,
      taper,
      isRibbon,
      pressureCurveGamma: 1.0,
      importedAt: Date.now(),
    };

    return cspBrush;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close error
      }
    }
  }
}
