import initSqlJs, { Database } from 'sql.js';
import { inflateSync } from 'fflate';
import { BlendMode, LayerItem, LoadedDocument } from '../types/editor';
import { createCanvasThumbnail } from './canvasUtils';

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
 * Maps Clip Studio Paint composite mode integer to Sora Paint BlendMode.
 */
function mapCspBlendMode(val: number): BlendMode {
  switch (val) {
    case 1:
      return 'multiply';
    case 2:
      return 'screen';
    case 3:
      return 'overlay';
    case 4:
      return 'lighten';
    case 5:
      return 'darken';
    case 6:
      return 'color-dodge';
    case 7:
      return 'color-burn';
    case 8:
      return 'hard-light';
    case 9:
      return 'soft-light';
    case 10:
      return 'difference';
    case 11:
      return 'exclusion';
    case 0:
    default:
      return 'normal';
  }
}

interface CspChunk {
  name: string;
  data: Uint8Array;
}

/**
 * Iterates top-level chunks of a Clip Studio Paint binary file.
 */
function parseCspChunks(buffer: Uint8Array): CspChunk[] {
  const chunks: CspChunk[] = [];
  const fileHeaderSize = 24;

  if (buffer.length < fileHeaderSize) return chunks;

  // Verify CSFCHUNK magic header
  const magic = new TextDecoder('ascii').decode(buffer.slice(0, 8));
  if (magic !== 'CSFCHUNK') {
    // If not standard CSFCHUNK, search for embedded SQLite directly
    return chunks;
  }

  let offset = fileHeaderSize;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  while (offset + 16 <= buffer.length) {
    const chunkTag = new TextDecoder('ascii').decode(buffer.slice(offset, offset + 4));
    if (chunkTag !== 'CHNK') {
      break;
    }

    const chunkName = new TextDecoder('ascii').decode(buffer.slice(offset + 4, offset + 8));
    const chunkSize = view.getUint32(offset + 12, false); // big-endian

    const dataStart = offset + 16;
    const dataEnd = dataStart + chunkSize;

    if (dataEnd > buffer.length) break;

    chunks.push({
      name: chunkName,
      data: buffer.slice(dataStart, dataEnd),
    });

    offset = dataEnd;
  }

  return chunks;
}

/**
 * Finds the SQLite database byte array from chunks or raw buffer.
 */
function findSqliteData(chunks: CspChunk[], rawBuffer: Uint8Array): Uint8Array | null {
  // First check CHNKSQLi chunk
  const sqliChunk = chunks.find((c) => c.name === 'SQLi');
  if (sqliChunk) {
    // Check if it starts directly with "SQLite format 3\0"
    const sig = 'SQLite format 3\0';
    const textHead = new TextDecoder('ascii').decode(sqliChunk.data.slice(0, 16));
    if (textHead === sig) {
      return sqliChunk.data;
    }
    // Search within chunk
    const idx = indexOfSequence(sqliChunk.data, [
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
    ]);
    if (idx >= 0) {
      return sqliChunk.data.slice(idx);
    }
  }

  // Fallback: search anywhere in buffer for SQLite header
  const idx = indexOfSequence(rawBuffer, [
    0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
  ]);
  if (idx >= 0) {
    return rawBuffer.slice(idx);
  }

  return null;
}

function indexOfSequence(haystack: Uint8Array, needle: number[]): number {
  const nLen = needle.length;
  const hLen = haystack.length;
  if (nLen > hLen) return -1;

  for (let i = 0; i <= hLen - nLen; i++) {
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
 * Extracts external chunks by ID from CHNKExta chunks.
 */
function extractExtaChunks(chunks: CspChunk[]): Map<string, Uint8Array> {
  const extaMap = new Map<string, Uint8Array>();

  for (const c of chunks) {
    if (c.name !== 'Exta' || c.data.length < 24) continue;
    const view = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
    // name_length at offset 0 (u64 big-endian)
    const nameLen = view.getUint32(4, false); // low 32 bits of 64-bit int
    if (nameLen <= 0 || nameLen > 100 || 8 + nameLen + 8 > c.data.length) continue;

    const chunkId = new TextDecoder('ascii').decode(c.data.slice(8, 8 + nameLen));
    const payload = c.data.slice(8 + nameLen + 8);
    extaMap.set(chunkId, payload);
  }

  return extaMap;
}

/**
 * Decodes 256x256 subblocks from an Exta bitmap chunk into an offscreen canvas.
 */
function renderCspBitmapToCanvas(
  blockData: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  offsetX: number = 0,
  offsetY: number = 0
): HTMLCanvasElement | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Scan for zlib header 0x78 (0x78 0x9c or 0x78 0x01 or 0x78 0xda)
    // and try inflating 256x256 pixel blocks
    const BLOCK_SIZE = 256;
    let blockIndex = 0;

    for (let i = 0; i < blockData.length - 8; i++) {
      if (blockData[i] === 0x78 && (blockData[i + 1] === 0x9c || blockData[i + 1] === 0x01 || blockData[i + 1] === 0xda)) {
        try {
          const slice = blockData.slice(i);
          const decompressed = inflateSync(slice);

          // Expected: 256*256 bytes alpha + 256*256*4 bytes BGRX = 327680 bytes
          if (decompressed.length >= BLOCK_SIZE * BLOCK_SIZE * 5) {
            const k = BLOCK_SIZE * BLOCK_SIZE;
            const imgData = ctx.createImageData(BLOCK_SIZE, BLOCK_SIZE);
            const d = imgData.data;

            for (let p = 0; p < k; p++) {
              const alpha = decompressed[p];
              const b = decompressed[k + p * 4];
              const g = decompressed[k + p * 4 + 1];
              const r = decompressed[k + p * 4 + 2];

              const targetIdx = p * 4;
              d[targetIdx] = r;
              d[targetIdx + 1] = g;
              d[targetIdx + 2] = b;
              d[targetIdx + 3] = alpha;
            }

            const bx = (blockIndex % Math.ceil(canvasWidth / BLOCK_SIZE)) * BLOCK_SIZE + offsetX;
            const by = Math.floor(blockIndex / Math.ceil(canvasWidth / BLOCK_SIZE)) * BLOCK_SIZE + offsetY;
            ctx.putImageData(imgData, bx, by);
            blockIndex++;
            i += 100; // Skip ahead
          }
        } catch {
          // Not a valid zlib block at this offset, continue scanning
        }
      }
    }

    return blockIndex > 0 ? canvas : null;
  } catch (err) {
    console.warn('renderCspBitmapToCanvas failed:', err);
    return null;
  }
}

/**
 * Loads a PNG/JPEG blob/Uint8Array into an HTMLCanvasElement.
 */
function imageBytesToCanvas(bytes: Uint8Array, width?: number, height?: number): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy]);
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = width || img.naturalWidth || 1440;
      const h = height || img.naturalHeight || 900;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, w, h);
      }
      resolve(canvas);
    };

    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };

    img.src = url;
  });
}

/**
 * Main parser for Clip Studio Paint (.clip / .csp) files.
 */
export async function parseCspFile(buffer: ArrayBuffer, fileName: string): Promise<LoadedDocument> {
  const bytes = new Uint8Array(buffer);
  const chunks = parseCspChunks(bytes);
  const sqliteData = findSqliteData(chunks, bytes);

  if (!sqliteData) {
    throw new Error('Could not find SQLite database metadata within Clip Studio Paint file.');
  }

  const SQL = await getSql();
  const db: Database = new SQL.Database(sqliteData);

  // 1. Get Canvas Dimensions
  let width = 1440;
  let height = 900;
  try {
    const res = db.exec('SELECT CanvasWidth, CanvasHeight FROM Canvas LIMIT 1');
    if (res.length > 0 && res[0].values.length > 0) {
      width = Number(res[0].values[0][0]) || 1440;
      height = Number(res[0].values[0][1]) || 900;
    }
  } catch (e) {
    console.warn('Could not read Canvas table in CSP file:', e);
  }

  // 2. Extract composite preview image if present
  let previewCanvas: HTMLCanvasElement | null = null;
  try {
    const previewRes = db.exec('SELECT ImageData FROM CanvasPreview LIMIT 1');
    if (previewRes.length > 0 && previewRes[0].values.length > 0) {
      const previewBytes = previewRes[0].values[0][0] as Uint8Array;
      if (previewBytes && previewBytes.length > 0) {
        previewCanvas = await imageBytesToCanvas(previewBytes, width, height);
      }
    }
  } catch (e) {
    console.warn('Could not read CanvasPreview in CSP file:', e);
  }

  // 3. Extract External Data Chunks
  const extaChunks = extractExtaChunks(chunks);

  // 4. Query Layers
  const layers: LayerItem[] = [];
  const layerCanvases = new Map<string, HTMLCanvasElement>();

  try {
    // Check if Layer table exists
    const layerRes = db.exec(
      'SELECT MainId, LayerName, LayerType, LayerComposite, LayerOpacity, LayerVisibility, LayerLock, LayerOffsetX, LayerOffsetY FROM Layer'
    );

    if (layerRes.length > 0 && layerRes[0].values.length > 0) {
      // Also query Offscreen table if available for raster chunks
      const offscreenMap = new Map<number, string>();
      try {
        const offRes = db.exec('SELECT LayerId, BlockData FROM Offscreen');
        if (offRes.length > 0) {
          for (const row of offRes[0].values) {
            const layerId = Number(row[0]);
            const blockDataId = String(row[1]);
            offscreenMap.set(layerId, blockDataId);
          }
        }
      } catch {
        // Offscreen table optional
      }

      for (const row of layerRes[0].values) {
        const mainId = Number(row[0]);
        const name = String(row[1] || `Layer ${mainId}`);
        const layerType = Number(row[2]); // 0 = folder, 1/2 = raster
        const compositeVal = Number(row[3] || 0);
        const opacityVal = Number(row[4] ?? 255);
        const visibilityVal = Number(row[5] ?? 1);
        const lockVal = Number(row[6] ?? 0);
        const offsetX = Number(row[7] ?? 0);
        const offsetY = Number(row[8] ?? 0);

        const isFolder = layerType === 0;
        const id = `csp-${isFolder ? 'folder' : 'layer'}-${mainId}-${Date.now()}`;
        const blendMode = mapCspBlendMode(compositeVal);
        const opacity = Math.max(0, Math.min(1, opacityVal / 255));
        const visible = visibilityVal !== 0;
        const locked = lockVal !== 0;

        if (isFolder) {
          layers.push({
            id,
            name,
            type: 'folder',
            visible,
            opacity,
            blendMode,
            locked,
            collapsed: false,
            parentId: null,
          });
        } else {
          // Attempt to decode raster subblocks
          let canvas: HTMLCanvasElement | null = null;
          const blockId = offscreenMap.get(mainId);
          if (blockId && extaChunks.has(blockId)) {
            const rawBlock = extaChunks.get(blockId)!;
            canvas = renderCspBitmapToCanvas(rawBlock, width, height, offsetX, offsetY);
          }

          if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
          }

          layerCanvases.set(id, canvas);
          const thumb = createCanvasThumbnail(canvas, true);

          layers.push({
            id,
            name,
            type: 'raster',
            visible,
            opacity,
            blendMode,
            locked,
            parentId: null,
            thumbnailUrl: thumb,
          });
        }
      }
    }
  } catch (err) {
    console.warn('Error reading layers table from CSP:', err);
  }

  // If no raster layers could be decoded or layers array is empty, fallback to composite preview
  const hasRasterPixels = Array.from(layerCanvases.values()).some((c) => {
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const sample = ctx.getImageData(0, 0, Math.min(100, c.width), Math.min(100, c.height));
    return sample.data.some((byte) => byte !== 0);
  });

  if (!hasRasterPixels && previewCanvas) {
    const bgId = `csp-preview-base-${Date.now()}`;
    layerCanvases.set(bgId, previewCanvas);
    const thumb = createCanvasThumbnail(previewCanvas, false);

    // Replace or prepend the preview canvas layer
    layers.unshift({
      id: bgId,
      name: 'CSP Composite Artwork',
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      locked: false,
      parentId: null,
      thumbnailUrl: thumb,
    });
  }

  // Ensure at least one valid layer exists
  if (layers.length === 0) {
    const fallbackId = `layer-${Date.now()}`;
    const canvas = previewCanvas || document.createElement('canvas');
    if (!previewCanvas) {
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
      }
    }
    layerCanvases.set(fallbackId, canvas);

    layers.push({
      id: fallbackId,
      name: 'Layer 1',
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      locked: false,
      parentId: null,
      thumbnailUrl: createCanvasThumbnail(canvas, false),
    });
  }

  db.close();

  return {
    name: fileName.replace(/\.[^/.]+$/, ''),
    dimensions: { width, height },
    colorMode: 'color',
    layers,
    layerCanvases,
  };
}
