/**
 * Raw-binary Tauri v2 IPC bridge to the Rust backend (src-tauri/src/lib.rs).
 * Zero JSON pixel encoding: all buffers cross IPC as raw Uint8Array / ArrayBuffer frames.
 */

import { BlendMode, CanvasColorMode, DirtyRect, FilterType, LayerItem, LoadedDocument } from '../types/editor';
import { createCanvasThumbnail } from './canvasUtils';
import { lz4DecompressBlock } from './lz4';
import { BYTES_32BIT, SparseTileGrid } from './tileEngine';
import { isTauriEnvironment } from './tileEngine/scratchDriver';
import { performanceManager } from './performanceManager';
import type { LiquifyMode } from './liquifyEngine';

type TauriInvoke = typeof import('@tauri-apps/api/core').invoke;

let cachedInvokePromise: Promise<TauriInvoke> | null = null;

export function isNativeRustAvailable(): boolean {
  return isTauriEnvironment() && performanceManager.getConfig().useNativeRustAcceleration;
}

function getInvoke(): Promise<TauriInvoke> {
  if (!cachedInvokePromise) {
    cachedInvokePromise = import('@tauri-apps/api/core').then((m) => m.invoke);
  }
  return cachedInvokePromise;
}

function toUint8Array(raw: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return new Uint8Array(raw);
}

// ---------------------------------------------------------------------------
// Shared INKD binary document hydrator (.clip and .psd/.psb)
// ---------------------------------------------------------------------------

interface WirePreviewRef {
  offset: number;
  len: number;
  mime: string;
}

interface WireTileRef {
  tx: number;
  ty: number;
  codec: number;
  offset: number;
  len: number;
}

interface WireMaskRef {
  enabled: boolean;
  linked: boolean;
  defaultColor: number;
  left: number;
  top: number;
  width: number;
  height: number;
  codec: number;
  offset: number;
  len: number;
}

interface WireLayerMeta {
  id: string;
  name: string;
  type: 'raster' | 'folder';
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  locked: boolean;
  alphaLocked: boolean;
  clipped: boolean;
  collapsed: boolean;
  parentId: string | null;
  solidFillHex: string | null;
  tiles: WireTileRef[];
  mask: WireMaskRef | null;
}

interface WireDocumentMeta {
  width: number;
  height: number;
  dpi: number;
  colorMode: CanvasColorMode;
  preview: WirePreviewRef | null;
  layers: WireLayerMeta[];
}

const utf8Decoder = new TextDecoder('utf-8');

function bytesToDataUrl(bytes: Uint8Array, mime: string): string | undefined {
  if (typeof btoa !== 'function' || bytes.byteLength === 0) return undefined;
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.byteLength, i + step)));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

function decodeMaskCanvas(
  maskRef: WireMaskRef,
  blobSection: Uint8Array
): Pick<LayerItem, 'maskCanvas' | 'maskEnabled' | 'maskLinked' | 'maskVersion' | 'maskThumbnailUrl'> {
  const base = {
    maskEnabled: maskRef.enabled,
    maskLinked: maskRef.linked,
    maskVersion: 1,
  };
  if (typeof document === 'undefined') return base;

  const expectedLen = maskRef.width * maskRef.height;
  const payload = blobSection.subarray(maskRef.offset, maskRef.offset + maskRef.len);
  const gray =
    maskRef.codec === 2
      ? lz4DecompressBlock(payload, expectedLen, expectedLen)
      : payload.byteLength === expectedLen
        ? payload
        : null;
  if (!gray) return base;

  const canvas = document.createElement('canvas');
  canvas.width = maskRef.width;
  canvas.height = maskRef.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return base;

  const img = ctx.createImageData(maskRef.width, maskRef.height);
  const out = img.data;
  for (let i = 0; i < expectedLen; i++) {
    const v = gray[i];
    const di = i << 2;
    out[di] = v;
    out[di + 1] = v;
    out[di + 2] = v;
    out[di + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  return {
    ...base,
    maskCanvas: canvas,
    maskThumbnailUrl: createCanvasThumbnail(canvas, false),
  };
}

/**
 * Hydrates a Rust `INKD` binary response directly into a SparseTileGrid-backed LoadedDocument.
 */
export function hydrateParsedDocumentBinary(
  wire: Uint8Array,
  fileName: string,
  targetGrid?: SparseTileGrid
): LoadedDocument {
  if (
    wire.byteLength < 12 ||
    wire[0] !== 0x49 ||
    wire[1] !== 0x4e ||
    wire[2] !== 0x4b ||
    wire[3] !== 0x44
  ) {
    throw new Error('Invalid INKD binary document response from Rust backend');
  }
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  const metaLen = view.getUint32(8, true);
  if (12 + metaLen > wire.byteLength) {
    throw new Error('Truncated INKD metadata header');
  }
  const meta: WireDocumentMeta = JSON.parse(
    utf8Decoder.decode(wire.subarray(12, 12 + metaLen))
  );
  const blobSection = wire.subarray(12 + metaLen);

  const width = meta.width || 1440;
  const height = meta.height || 900;
  const dpi = meta.dpi || 300;
  const colorMode: CanvasColorMode = meta.colorMode === 'grayscale' ? 'grayscale' : 'color';
  const tileGrid = targetGrid ?? new SparseTileGrid();
  const stamp = Date.now();
  const idMap = new Map<string, string>();
  const layers: LayerItem[] = [];

  for (const wl of meta.layers) {
    const uniqueId = `${wl.id}-${stamp}`;
    idMap.set(wl.id, uniqueId);
  }

  for (const wl of meta.layers) {
    const id = idMap.get(wl.id)!;
    const parentId = wl.parentId ? (idMap.get(wl.parentId) ?? null) : null;
    const maskFields = wl.mask ? decodeMaskCanvas(wl.mask, blobSection) : {};

    if (wl.type === 'folder') {
      layers.push({
        id,
        name: wl.name,
        type: 'folder',
        visible: wl.visible,
        opacity: wl.opacity,
        blendMode: wl.blendMode,
        locked: wl.locked,
        alphaLocked: wl.alphaLocked,
        clipped: wl.clipped,
        collapsed: wl.collapsed,
        parentId,
        ...maskFields,
      });
      continue;
    }

    tileGrid.setLayerFormat(id, 'color-32bit');
    tileGrid.markLayerIngested(id);

    if (wl.tiles.length > 0) {
      for (const t of wl.tiles) {
        const payload = blobSection.subarray(t.offset, t.offset + t.len);
        let rgba: Uint8Array | null;
        if (t.codec === 2) {
          rgba = lz4DecompressBlock(payload, BYTES_32BIT, BYTES_32BIT);
        } else if (t.codec === 1 && payload.byteLength === BYTES_32BIT) {
          rgba = payload.slice();
        } else {
          rgba = null;
        }
        if (rgba) {
          tileGrid.setTile(id, t.tx, t.ty, {
            layerId: id,
            tileX: t.tx,
            tileY: t.ty,
            format: 'color-32bit',
            data: rgba,
            dirty: true,
            version: 1,
            isPagedToDisk: false,
            lastAccessTimestamp: stamp,
            lod: 0,
          });
        }
      }
    } else if (wl.solidFillHex) {
      tileGrid.fillLayerSolidColor(id, width, height, wl.solidFillHex, 'color-32bit');
    }

    const thumb = createCanvasThumbnail(
      { grid: tileGrid, layerId: id, dimensions: { width, height } },
      true
    );

    layers.push({
      id,
      name: wl.name,
      type: 'raster',
      visible: wl.visible,
      opacity: wl.opacity,
      blendMode: wl.blendMode,
      locked: wl.locked,
      alphaLocked: wl.alphaLocked,
      clipped: wl.clipped,
      parentId,
      thumbnailUrl: thumb,
      ...maskFields,
    });
  }

  if (layers.length === 0) {
    const id = `layer-${stamp}`;
    tileGrid.fillLayerSolidWhite(id, width, height, 'color-32bit');
    const thumb = createCanvasThumbnail(
      { grid: tileGrid, layerId: id, dimensions: { width, height } },
      false
    );
    layers.push({
      id,
      name: 'Layer 1',
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

  const previewDataUrl = meta.preview
    ? bytesToDataUrl(
        blobSection.subarray(meta.preview.offset, meta.preview.offset + meta.preview.len),
        meta.preview.mime
      )
    : undefined;

  return {
    name: fileName.replace(/\.[^/.]+$/, ''),
    dimensions: { width, height, dpi },
    colorMode,
    layers,
    tileGrid,
    previewDataUrl,
  };
}

export async function parseClipNative(
  buffer: ArrayBuffer | Uint8Array,
  fileName: string,
  targetGrid?: SparseTileGrid
): Promise<LoadedDocument> {
  const invoke = await getInvoke();
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('parse_clip_file', bytes);
  return hydrateParsedDocumentBinary(toUint8Array(raw), fileName, targetGrid);
}

export async function parsePsdNative(
  buffer: ArrayBuffer | Uint8Array,
  fileName: string,
  targetGrid?: SparseTileGrid
): Promise<LoadedDocument> {
  const invoke = await getInvoke();
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('parse_psd_file', bytes);
  return hydrateParsedDocumentBinary(toUint8Array(raw), fileName, targetGrid);
}

export type CspExpressionColor = 'color' | 'gray' | 'monochrome';

export interface NativeSutMaterial {
  pwId: string;
  originalPath: string;
  catalogPath: string;
  fileData: Uint8Array;
  decodedPng?: Uint8Array;
  width?: number;
  height?: number;
  expressionColor?: CspExpressionColor;
  isPaperTexture?: boolean;
  hasSubColor?: boolean;
  decodedFromLayer?: boolean;
}

export interface NativeSutExtract {
  nodeName: string | null;
  nodeUuid?: string | null;
  variantId: number | null;
  nodeInitVariantId?: number | null;
  variantValues: Map<string, unknown>;
  dualVariantValues?: Map<string, unknown>;
  materials: NativeSutMaterial[];
}

function normalizeExpressionColor(val: unknown): CspExpressionColor | undefined {
  if (val === 'color' || val === 'gray' || val === 'monochrome') {
    return val;
  }
  return undefined;
}

export async function parseSutSqliteNative(bytes: Uint8Array): Promise<NativeSutExtract> {
  const invoke = await getInvoke();
  const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('parse_sut_sqlite', bytes);
  const wire = toUint8Array(raw);
  if (
    wire.byteLength < 8 ||
    wire[0] !== 0x53 ||
    wire[1] !== 0x55 ||
    wire[2] !== 0x54 ||
    wire[3] !== 0x44
  ) {
    throw new Error('Invalid SUTD binary response from Rust backend');
  }
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  const metaLen = view.getUint32(4, true);
  if (8 + metaLen > wire.byteLength) {
    throw new Error('Truncated SUTD metadata header');
  }
  const meta = JSON.parse(utf8Decoder.decode(wire.subarray(8, 8 + metaLen))) as {
    nodeName: string | null;
    nodeUuid?: string | null;
    variantId: number | null;
    nodeInitVariantId?: number | null;
    variantScalars: Record<string, unknown>;
    variantBlobs: Record<string, { offset: number; len: number }>;
    dualVariantScalars?: Record<string, unknown>;
    dualVariantBlobs?: Record<string, { offset: number; len: number }>;
    materials: Array<{
      pwId: string;
      originalPath: string;
      catalogPath: string;
      fileDataOffset: number;
      fileDataLen: number;
      decodedPngOffset?: number;
      decodedPngLen?: number;
      width?: number;
      height?: number;
      expressionColor?: string;
      isPaperTexture?: boolean;
      hasSubColor?: boolean;
      decodedFromLayer?: boolean;
    }>;
  };
  const blobs = wire.subarray(8 + metaLen);
  const variantValues = new Map<string, unknown>();
  for (const [k, v] of Object.entries(meta.variantScalars)) {
    variantValues.set(k.toLowerCase(), v);
  }
  for (const [k, ref] of Object.entries(meta.variantBlobs)) {
    variantValues.set(k.toLowerCase(), blobs.subarray(ref.offset, ref.offset + ref.len));
  }

  let dualVariantValues: Map<string, unknown> | undefined = undefined;
  if (meta.dualVariantScalars || meta.dualVariantBlobs) {
    const dualMap = new Map<string, unknown>();
    if (meta.dualVariantScalars) {
      for (const [k, v] of Object.entries(meta.dualVariantScalars)) {
        dualMap.set(k.toLowerCase(), v);
      }
    }
    if (meta.dualVariantBlobs) {
      for (const [k, ref] of Object.entries(meta.dualVariantBlobs)) {
        dualMap.set(k.toLowerCase(), blobs.subarray(ref.offset, ref.offset + ref.len));
      }
    }
    if (dualMap.size > 0) {
      dualVariantValues = dualMap;
    }
  }

  const materials: NativeSutMaterial[] = meta.materials.map((m) => ({
    pwId: m.pwId,
    originalPath: m.originalPath,
    catalogPath: m.catalogPath,
    fileData: blobs.subarray(m.fileDataOffset, m.fileDataOffset + m.fileDataLen),
    decodedPng:
      typeof m.decodedPngOffset === 'number' &&
      typeof m.decodedPngLen === 'number' &&
      m.decodedPngLen > 0
        ? blobs.subarray(m.decodedPngOffset, m.decodedPngOffset + m.decodedPngLen)
        : undefined,
    width: m.width,
    height: m.height,
    expressionColor: normalizeExpressionColor(m.expressionColor),
    isPaperTexture: m.isPaperTexture,
    hasSubColor: m.hasSubColor,
    decodedFromLayer: m.decodedFromLayer,
  }));
  return {
    nodeName: meta.nodeName,
    nodeUuid: meta.nodeUuid ?? null,
    variantId: meta.variantId,
    nodeInitVariantId: meta.nodeInitVariantId ?? null,
    variantValues,
    dualVariantValues,
    materials,
  };
}

// ---------------------------------------------------------------------------
// Native Parallel Raster Ops (Filters, FloodFill, Liquify, Tile Compression)
// ---------------------------------------------------------------------------

export async function applyFilterNative(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  type: FilterType,
  params: Record<string, unknown>
): Promise<Uint8ClampedArray> {
  const invoke = await getInvoke();
  let pA = 0;
  let pB = 0;
  let pC = 0;
  let pD = 0;
  if (type === 'gaussian-blur') {
    pA = Number(params?.radius ?? 5);
  } else if (type === 'motion-blur') {
    pA = Number(params?.distance ?? 15);
    pB = Number(params?.angle ?? 0);
  } else if (type === 'unsharp-mask') {
    pA = Number(params?.radius ?? 2);
    pB = Number(params?.amount ?? 1.5);
    pC = Number(params?.threshold ?? 0);
  } else if (type === 'film-grain') {
    pA = Number(params?.intensity ?? 25);
    pB = Number(params?.size ?? 1);
    pC = (params?.monochromatic ?? true) ? 1 : 0;
    pD = Number(params?.seed ?? 1337) >>> 0;
  }

  const body =
    rgba instanceof Uint8Array
      ? rgba
      : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);

  const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('native_apply_filter', body, {
    headers: {
      'x-filter-type': encodeURIComponent(type),
      'x-width': String(width),
      'x-height': String(height),
      'x-param-a': String(pA),
      'x-param-b': String(pB),
      'x-param-c': String(pC),
      'x-param-d': String(pD),
    },
  });
  const bytes = toUint8Array(raw);
  return new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export async function floodFillNative(params: {
  refRgba: Uint8ClampedArray | Uint8Array;
  targetRgba?: Uint8ClampedArray | Uint8Array | null;
  selectionMask?: Uint8Array | null;
  width: number;
  height: number;
  startX: number;
  startY: number;
  fillRgba: [number, number, number, number];
  tolerance: number;
  closeGap: number;
  areaScale: number;
  antiAlias: boolean;
}): Promise<{ modified: boolean; dirtyRect: DirtyRect | null; dirtyRgba: Uint8ClampedArray | null }> {
  const invoke = await getInvoke();
  const sameSurface = !params.targetRgba || params.targetRgba === params.refRgba;
  const hasMask = Boolean(params.selectionMask && params.selectionMask.byteLength === params.width * params.height);

  const refView = new Uint8Array(
    params.refRgba.buffer,
    params.refRgba.byteOffset,
    params.refRgba.byteLength
  );
  let body: Uint8Array;
  if (sameSurface && !hasMask) {
    body = refView;
  } else {
    const total =
      refView.byteLength +
      (sameSurface ? 0 : params.targetRgba!.byteLength) +
      (hasMask ? params.selectionMask!.byteLength : 0);
    body = new Uint8Array(total);
    let off = 0;
    body.set(refView, off);
    off += refView.byteLength;
    if (!sameSurface) {
      const tgt = params.targetRgba!;
      body.set(new Uint8Array(tgt.buffer, tgt.byteOffset, tgt.byteLength), off);
      off += tgt.byteLength;
    }
    if (hasMask) {
      body.set(params.selectionMask!, off);
    }
  }

  const [r, g, b, a] = params.fillRgba;
  const packedColor = (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff)) >>> 0;

  const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('native_flood_fill', body, {
    headers: {
      'x-width': String(params.width),
      'x-height': String(params.height),
      'x-start-x': String(Math.floor(params.startX)),
      'x-start-y': String(Math.floor(params.startY)),
      'x-fill-rgba': String(packedColor),
      'x-tolerance': String(params.tolerance),
      'x-close-gap': String(params.closeGap),
      'x-area-scale': String(params.areaScale),
      'x-anti-alias': params.antiAlias ? '1' : '0',
      'x-same-surface': sameSurface ? '1' : '0',
      'x-has-mask': hasMask ? '1' : '0',
    },
  });

  const resp = toUint8Array(raw);
  if (resp.byteLength < 17 || resp[0] === 0) {
    return { modified: false, dirtyRect: null, dirtyRgba: null };
  }
  const view = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
  const x = view.getInt32(1, true);
  const y = view.getInt32(5, true);
  const width = view.getInt32(9, true);
  const height = view.getInt32(13, true);
  const pixels = resp.subarray(17);
  return {
    modified: true,
    dirtyRect: { x, y, width, height },
    dirtyRgba: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength),
  };
}

const LIQUIFY_MODE_CODE: Record<LiquifyMode, number> = {
  push: 0,
  'push-left': 1,
  'push-right': 2,
  expand: 3,
  pinch: 4,
  'twirl-cw': 5,
  'twirl-ccw': 6,
  reconstruct: 7,
};

export async function liquifyStepNative(params: {
  srcRoi: Uint8ClampedArray | Uint8Array;
  initRoi?: Uint8ClampedArray | Uint8Array | null;
  selMaskRoi?: Uint8Array | null;
  roiW: number;
  roiH: number;
  minX: number;
  minY: number;
  cx: number;
  cy: number;
  ux: number;
  uy: number;
  vLen: number;
  radius: number;
  hardness: number;
  strength: number;
  mode: LiquifyMode;
}): Promise<Uint8ClampedArray> {
  const invoke = await getInvoke();
  const hasInit = Boolean(params.initRoi);
  const hasMask = Boolean(params.selMaskRoi);
  const srcView = new Uint8Array(
    params.srcRoi.buffer,
    params.srcRoi.byteOffset,
    params.srcRoi.byteLength
  );

  let body: Uint8Array;
  if (!hasInit && !hasMask) {
    body = srcView;
  } else {
    const total =
      srcView.byteLength +
      (hasInit ? params.initRoi!.byteLength : 0) +
      (hasMask ? params.selMaskRoi!.byteLength : 0);
    body = new Uint8Array(total);
    let off = 0;
    body.set(srcView, off);
    off += srcView.byteLength;
    if (hasInit) {
      const init = params.initRoi!;
      body.set(new Uint8Array(init.buffer, init.byteOffset, init.byteLength), off);
      off += init.byteLength;
    }
    if (hasMask) {
      body.set(params.selMaskRoi!, off);
    }
  }

  const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('native_liquify_step', body, {
    headers: {
      'x-roi-w': String(params.roiW),
      'x-roi-h': String(params.roiH),
      'x-min-x': String(params.minX),
      'x-min-y': String(params.minY),
      'x-cx': String(params.cx),
      'x-cy': String(params.cy),
      'x-ux': String(params.ux),
      'x-uy': String(params.uy),
      'x-vlen': String(params.vLen),
      'x-radius': String(params.radius),
      'x-hardness': String(params.hardness),
      'x-strength': String(params.strength),
      'x-mode': String(LIQUIFY_MODE_CODE[params.mode]),
      'x-has-init': hasInit ? '1' : '0',
      'x-has-mask': hasMask ? '1' : '0',
    },
  });

  const out = toUint8Array(raw);
  return new Uint8ClampedArray(out.buffer, out.byteOffset, out.byteLength);
}

export async function compressTilesLz4BatchNative(
  tiles: Uint8Array[]
): Promise<Array<{ codec: number; data: Uint8Array }>> {
  const invoke = await getInvoke();
  let total = 4;
  for (const t of tiles) total += 4 + t.byteLength;
  const req = new Uint8Array(total);
  const view = new DataView(req.buffer);
  view.setUint32(0, tiles.length, true);
  let off = 4;
  for (const t of tiles) {
    view.setUint32(off, t.byteLength, true);
    off += 4;
    req.set(t, off);
    off += t.byteLength;
  }

  const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('native_compress_tiles_lz4', req);
  const resp = toUint8Array(raw);
  const rview = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
  const count = rview.getUint32(0, true);
  const out: Array<{ codec: number; data: Uint8Array }> = new Array(count);
  let roff = 4;
  for (let i = 0; i < count; i++) {
    const codec = resp[roff];
    const len = rview.getUint32(roff + 1, true);
    roff += 5;
    out[i] = { codec, data: resp.slice(roff, roff + len) };
    roff += len;
  }
  return out;
}

export async function decompressTilesLz4BatchNative(
  items: Array<{ codec: number; expectedLen: number; data: Uint8Array }>
): Promise<Uint8Array[]> {
  const invoke = await getInvoke();
  let total = 4;
  for (const it of items) total += 9 + it.data.byteLength;
  const req = new Uint8Array(total);
  const view = new DataView(req.buffer);
  view.setUint32(0, items.length, true);
  let off = 4;
  for (const it of items) {
    req[off] = it.codec;
    view.setUint32(off + 1, it.expectedLen, true);
    view.setUint32(off + 5, it.data.byteLength, true);
    off += 9;
    req.set(it.data, off);
    off += it.data.byteLength;
  }

  const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('native_decompress_tiles_lz4', req);
  const resp = toUint8Array(raw);
  const rview = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
  const count = rview.getUint32(0, true);
  const out: Uint8Array[] = new Array(count);
  let roff = 4;
  for (let i = 0; i < count; i++) {
    const len = rview.getUint32(roff, true);
    roff += 4;
    out[i] = resp.slice(roff, roff + len);
    roff += len;
  }
  return out;
}

export async function flateCompressNative(
  op: 'deflate' | 'zlib',
  data: Uint8Array,
  level: number = 1
): Promise<Uint8Array> {
  const invoke = await getInvoke();
  const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('native_flate_compress', data, {
    headers: {
      'x-op': op,
      'x-level': String(level),
    },
  });
  return toUint8Array(raw);
}

export async function flateDecompressNative(
  op: 'inflate' | 'unzlib',
  data: Uint8Array,
  maxOutputBytes?: number
): Promise<Uint8Array> {
  const invoke = await getInvoke();
  const headers: Record<string, string> = { 'x-op': op };
  if (maxOutputBytes !== undefined) {
    headers['x-max-output-bytes'] = String(maxOutputBytes);
  }
  const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('native_flate_decompress', data, {
    headers,
  });
  return toUint8Array(raw);
}
