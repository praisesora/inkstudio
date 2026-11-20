import type {
  BlendMode as AgPsdBlendMode,
  Layer as AgPsdLayer,
  LayerMaskData as AgPsdMaskData,
} from 'ag-psd';
import { Zip, ZipDeflate, ZipPassThrough, unzipSync } from 'fflate';
import {
  CanvasDimensions,
  LayerItem,
  CanvasColorMode,
  BlendMode,
  AnimationTimeline,
  SoraTimelapseMetadata,
  isFolderLikeLayer,
  hasTileBackedLayer,
} from '../types/editor';
import type { PerspectiveRuler } from '../types/perspective';
import { getCanvasCompositeOperation } from './canvasUtils';
import {
  buildLayerTree,
  groupTreeNodesForCompositing,
  LayerTreeNode,
  ViewportCompositor,
  ViewportTransform,
} from './compositor';
import { applyAdjustment } from './tonalEngine';
import { applyMultiFrameClip, renderFrameBorder } from './frameEngine';
import { renderVectorLayer } from './vectorEngine';
import { renderBalloonLayerData, renderTextLayerData } from './vectorLayerRenderer';
import { recoveryService } from '../services/recoveryService';
import {
  SparseTileGrid,
  TILE_SIZE,
  TileBuffer,
  TileFormat,
  getTileByteSize,
  releaseTemporaryCanvas,
} from './tileEngine';
import { documentStore } from './documentStore';

export interface SavedFileInfo {
  handle?: any; // FileSystemFileHandle
  name: string;
  extension: string;
  size?: number;
  previewDataUrl?: string;
}

export interface SaveProgress {
  phase: 'preparing' | 'preview' | 'tiles' | 'masks' | 'compositing' | 'encoding' | 'finalizing' | 'done';
  current: number;
  total: number;
  percent: number;
  message: string;
}

export interface SaveDocumentData {
  name: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  layerCanvasesMap: Map<string, HTMLCanvasElement>;
  tileGrid?: SparseTileGrid;
  getEffectiveOpacity: (layer: LayerItem) => number;
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean;
  tabId?: string;
  perspectiveRuler?: PerspectiveRuler | null;
  animationTimeline?: AnimationTimeline | null;
  timelapse?: SoraTimelapseMetadata | null;
  onProgress?: (progress: SaveProgress) => void;
  compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export interface SoraV2Manifest {
  format: 'sora-v2';
  app: string;
  version: '2.0';
  tileSize: number;
  name: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: Array<Omit<LayerItem, 'maskCanvas'>>;
  layerFormats: Record<string, TileFormat>;
  layerTileKeys: Record<string, string>;
  masksMeta: Record<string, { width: number; height: number; format: 'alpha-8bit' }>;
  perspectiveRuler?: PerspectiveRuler | null;
  animationTimeline?: AnimationTimeline | null;
  timelapse?: SoraTimelapseMetadata | null;
  preview: { path: string; width: number; height: number } | null;
  savedAt: number;
}

export interface ParsedSoraProject {
  format: 'v2' | 'v1';
  app: string;
  version: string;
  name: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  tileGrid?: SparseTileGrid;
  canvases: Record<string, string>;
  masks: Record<string, string>;
  masksBinary?: Map<string, { width: number; height: number; data: Uint8Array }>;
  perspectiveRuler?: PerspectiveRuler | null;
  animationTimeline?: AnimationTimeline | null;
  timelapse?: SoraTimelapseMetadata | null;
  previewBytes?: Uint8Array | null;
  previewDataUrl?: string;
}

export interface ExportImageOptions {
  format?: 'png' | 'jpg' | 'jpeg' | 'webp';
  quality?: number;
  fillWhiteBackground?: boolean;
  tileSize?: number;
  onProgress?: (progress: SaveProgress) => void;
}

export interface ExportImageResult {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  usedGpu: boolean;
}

export interface CompositeCanvasOptions {
  tileSize?: number;
  colorMode?: CanvasColorMode;
  onProgress?: (progress: SaveProgress) => void;
}

export const SORA_V2_DEFAULT_TILE_EXPORT_SIZE = 2048;

const SORA_V2_FORMAT_TO_BYTE: Record<TileFormat, number> = {
  'monochrome-1bit': 0,
  'grayscale-8bit': 1,
  'color-32bit': 2,
};

const SORA_V2_BYTE_TO_FORMAT: Record<number, TileFormat> = {
  0: 'monochrome-1bit',
  1: 'grayscale-8bit',
  2: 'color-32bit',
};

const TILE_BINARY_HEADER_BYTES = 9; // [format:u8][version:u32 LE][dataLen:u32 LE]
const MASK_BINARY_HEADER_BYTES = 8; // [width:u32 LE][height:u32 LE]
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_DIM = 65536;
const MAX_TILE_ENTRIES = 120000;
const CHUNK_YIELD_INTERVAL = 8;
const MAX_STYLE_MARGIN_PX = 256;
const PREVIEW_MAX_DIM = 512;

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode(...slice);
    }
    return btoa(binary);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET[(triple >> 18) & 63];
    out += BASE64_ALPHABET[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : '=';
  }
  return out;
}

function toPngDataUrl(bytes: Uint8Array | null | undefined): string | undefined {
  if (!bytes || bytes.byteLength === 0) return undefined;
  const b64 = bytesToBase64(bytes);
  return b64 ? `data:image/png;base64,${b64}` : undefined;
}

function toSafeZipKey(rawId: string, usedKeys: Set<string>): string {
  let base = rawId.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!base || base === '.' || base === '..') {
    base = 'layer';
  }
  // Prevent hidden or traversal-looking segments
  base = base.replace(/\.{2,}/g, '_');
  let candidate = base;
  let suffix = 1;
  while (usedKeys.has(candidate)) {
    candidate = `${base}_${suffix++}`;
  }
  usedKeys.add(candidate);
  return candidate;
}

function isSafeZipPath(path: string): boolean {
  if (!path || path.includes('\0') || path.includes('\\') || path.startsWith('/')) {
    return false;
  }
  const segments = path.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      return false;
    }
  }
  return true;
}

function sanitizeJsonLayer(raw: any): LayerItem {
  const clean: any = Object.create(null);
  for (const key of Object.keys(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    clean[key] = raw[key];
  }
  const normalized: LayerItem = { ...clean };
  if (normalized.maskCanvas && typeof normalized.maskCanvas.getContext !== 'function') {
    normalized.maskCanvas = undefined;
  }
  return normalized;
}

/**
 * Checks whether binary input begins with `.sora` v2 container magic bytes:
 * - Standard ZIP local file header (`PK\x03\x04`) or empty ZIP (`PK\x05\x06`)
 * - Optional explicit `SORA\x00\x02` wrapper prefix
 */
export function isSoraV2Bytes(input: Uint8Array | ArrayBuffer): boolean {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 4) return false;
  // PK\x03\x04 or PK\x05\x06 (ZIP container)
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  ) {
    return true;
  }
  // Optional SORA\x00\x02 wrapper prefix
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x53 &&
    bytes[1] === 0x4f &&
    bytes[2] === 0x52 &&
    bytes[3] === 0x41 &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x02
  ) {
    return true;
  }
  return false;
}

function unwrapZipPayload(bytes: Uint8Array): Uint8Array {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x53 &&
    bytes[1] === 0x4f &&
    bytes[2] === 0x52 &&
    bytes[3] === 0x41 &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x02
  ) {
    return bytes.subarray(8);
  }
  return bytes;
}

/**
 * Maps Ink Studio BlendMode to ag-psd BlendMode format.
 */
export function toAgPsdBlendMode(mode: BlendMode): AgPsdBlendMode {
  switch (mode) {
    case 'color-dodge':
    case 'color-dodge-glow':
      return 'color dodge';
    case 'color-burn':
      return 'color burn';
    case 'linear-burn':
      return 'linear burn';
    case 'add-glow':
      return 'linear dodge';
    case 'hard-light':
      return 'hard light';
    case 'soft-light':
      return 'soft light';
    case 'divide':
      return 'divide';
    case 'pass-through':
      return 'pass through';
    case 'normal':
    case 'multiply':
    case 'screen':
    case 'overlay':
    case 'darken':
    case 'lighten':
    case 'difference':
    case 'exclusion':
      return mode;
    default:
      return 'normal';
  }
}

function extractLayerMaskForPsd(layer: LayerItem): AgPsdMaskData | undefined {
  const maskCanvas = layer.maskCanvas;
  if (!maskCanvas || maskCanvas.width <= 0 || maskCanvas.height <= 0) {
    return undefined;
  }

  const mw = maskCanvas.width;
  const mh = maskCanvas.height;
  const maskMeta: AgPsdMaskData = {
    top: 0,
    left: 0,
    bottom: mh,
    right: mw,
    defaultColor: 255,
    disabled: layer.maskEnabled === false,
    positionRelativeToLayer: layer.maskLinked === false,
  };

  const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (ctx && typeof ctx.getImageData === 'function') {
    const src = ctx.getImageData(0, 0, mw, mh).data;
    const out = new Uint8ClampedArray(mw * mh * 4);
    for (let i = 0; i < src.length; i += 4) {
      const lum = Math.round(((0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) * src[i + 3]) / 255);
      out[i] = lum;
      out[i + 1] = lum;
      out[i + 2] = lum;
      out[i + 3] = 255;
    }
    maskMeta.imageData = { data: out, width: mw, height: mh };
  } else {
    maskMeta.canvas = maskCanvas;
  }

  return maskMeta;
}

function attachRasterPixelsForPsd(
  target: AgPsdLayer,
  layer: LayerItem,
  dimensions: CanvasDimensions,
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  tileGrid: SparseTileGrid | undefined,
  tempCanvases: HTMLCanvasElement[]
): void {
  const isVectorText =
    (layer.type === 'text' && Boolean(layer.textData)) ||
    (layer.type === 'balloon' && Boolean(layer.balloonData));

  if (!isVectorText && !layerCanvasesMap.has(layer.id) && tileGrid && tileGrid.hasLayerTiles(layer.id)) {
    const tiles = tileGrid.getLayerTiles(layer.id, 0);
    if (tiles.length === 0) return;

    let minX = dimensions.width;
    let minY = dimensions.height;
    let maxX = 0;
    let maxY = 0;
    for (const tile of tiles) {
      const tx0 = tile.tileX * TILE_SIZE;
      const ty0 = tile.tileY * TILE_SIZE;
      if (tx0 < minX) minX = tx0;
      if (ty0 < minY) minY = ty0;
      if (tx0 + TILE_SIZE > maxX) maxX = tx0 + TILE_SIZE;
      if (ty0 + TILE_SIZE > maxY) maxY = ty0 + TILE_SIZE;
    }
    const left = Math.max(0, minX);
    const top = Math.max(0, minY);
    const right = Math.min(dimensions.width, maxX);
    const bottom = Math.min(dimensions.height, maxY);
    if (left < right && top < bottom) {
      const imgData = tileGrid.readImageData(layer.id, left, top, right - left, bottom - top);
      target.left = left;
      target.top = top;
      target.right = right;
      target.bottom = bottom;
      target.imageData = imgData;
    }
    return;
  }

  const acq = acquireLayerExportCanvas(layer, dimensions, layerCanvasesMap, tileGrid);
  if (!acq.canvas) return;
  if (acq.isTemporary) tempCanvases.push(acq.canvas);

  const w = acq.canvas.width;
  const h = acq.canvas.height;
  if (w <= 0 || h <= 0) return;

  const ctx = acq.canvas.getContext('2d', { willReadFrequently: true });
  if (ctx && typeof ctx.getImageData === 'function') {
    const imgData = ctx.getImageData(0, 0, w, h);
    target.left = 0;
    target.top = 0;
    target.right = w;
    target.bottom = h;
    target.imageData = { data: imgData.data, width: w, height: h };
  } else {
    target.canvas = acq.canvas;
  }
}

function buildPsdLayerTree(
  nodes: LayerTreeNode[],
  dimensions: CanvasDimensions,
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  tileGrid: SparseTileGrid | undefined,
  tempCanvases: HTMLCanvasElement[]
): AgPsdLayer[] {
  const result: AgPsdLayer[] = [];

  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const layer = node.layer;
    const isFolder = isFolderLikeLayer(layer);
    if (!isFolder && !hasTileBackedLayer(layer)) continue;

    const psdLayer: AgPsdLayer = {
      name: layer.name,
      hidden: !layer.visible,
      opacity: Math.max(0, Math.min(1, layer.opacity ?? 1)),
      blendMode: toAgPsdBlendMode(layer.blendMode),
    };

    if (layer.clipped) {
      psdLayer.clipping = true;
    }

    if (layer.alphaLocked || layer.locked) {
      psdLayer.protected = {
        transparency: Boolean(layer.alphaLocked),
        composite: Boolean(layer.locked),
        position: Boolean(layer.locked),
      };
      if (layer.alphaLocked) {
        psdLayer.transparencyProtected = true;
      }
    }

    const mask = extractLayerMaskForPsd(layer);
    if (mask) {
      psdLayer.mask = mask;
    }

    if (isFolder) {
      psdLayer.opened = !layer.collapsed;
      psdLayer.children = buildPsdLayerTree(
        node.children,
        dimensions,
        layerCanvasesMap,
        tileGrid,
        tempCanvases
      );
    } else {
      attachRasterPixelsForPsd(
        psdLayer,
        layer,
        dimensions,
        layerCanvasesMap,
        tileGrid,
        tempCanvases
      );
    }

    result.push(psdLayer);
  }

  return result;
}

/**
 * Resolves a layer's canvas from either the map or temporarily from SparseTileGrid.
 * Returns `{ canvas, isTemporary }` so caller immediately releases temporary canvases.
 */
function acquireLayerExportCanvas(
  layer: LayerItem,
  dimensions: CanvasDimensions,
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  tileGrid?: SparseTileGrid
): { canvas: HTMLCanvasElement | null; isTemporary: boolean } {
  if (layer.type === 'text' && layer.textData && typeof document !== 'undefined') {
    const temp = document.createElement('canvas');
    temp.width = dimensions.width;
    temp.height = dimensions.height;
    const ctx = temp.getContext('2d');
    if (ctx) renderTextLayerData(ctx, layer.textData);
    return { canvas: temp, isTemporary: true };
  }
  if (layer.type === 'balloon' && layer.balloonData && typeof document !== 'undefined') {
    const temp = document.createElement('canvas');
    temp.width = dimensions.width;
    temp.height = dimensions.height;
    const ctx = temp.getContext('2d');
    if (ctx) renderBalloonLayerData(ctx, layer.balloonData);
    return { canvas: temp, isTemporary: true };
  }
  const existing = layerCanvasesMap.get(layer.id);
  if (existing) {
    return { canvas: existing, isTemporary: false };
  }
  if (tileGrid && tileGrid.hasLayerTiles(layer.id)) {
    const temp = tileGrid.exportLayerToCanvas(layer.id, dimensions.width, dimensions.height);
    return { canvas: temp, isTemporary: true };
  }
  return { canvas: null, isTemporary: false };
}

// ============================================================================
// Pixel-Accurate GPU Tiled Export Engine (ViewportCompositor FBO Pipeline)
// ============================================================================

/**
 * Computes the maximum pixel halo margin required around export tiles so GPU
 * Layer Styles (Stroke, Drop Shadow, Outer Glow) render seamlessly across tile seams.
 */
export function computeMaxLayerStyleMargin(layers: LayerItem[]): number {
  let maxMargin = 0;
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0.001 || !layer.styles) continue;
    const { stroke, dropShadow, outerGlow } = layer.styles;
    if (stroke?.enabled && stroke.size > 0 && stroke.opacity > 0) {
      maxMargin = Math.max(maxMargin, Math.ceil(stroke.size) + 2);
    }
    if (dropShadow?.enabled && dropShadow.opacity > 0) {
      const extent = Math.ceil((dropShadow.distance || 0) + (dropShadow.blur || 0) * 1.5) + 2;
      maxMargin = Math.max(maxMargin, extent);
    }
    if (outerGlow?.enabled && outerGlow.opacity > 0 && outerGlow.blur > 0) {
      const extent = Math.ceil(outerGlow.blur * 1.5) + 2;
      maxMargin = Math.max(maxMargin, extent);
    }
  }
  return Math.min(MAX_STYLE_MARGIN_PX, Math.max(0, maxMargin));
}

function inferLayerTileFormat(layer: LayerItem): TileFormat {
  if (layer.expressionColor === 'monochrome') return 'monochrome-1bit';
  if (layer.expressionColor === 'gray') return 'grayscale-8bit';
  return 'color-32bit';
}

/**
 * Prepares a SparseTileGrid containing all visible tile-backed layers for GPU compositing.
 * Zero-copy fast path when `tileGrid` already holds all visible raster/vector/text/balloon layers.
 */
function prepareExportTileGrid(
  dimensions: CanvasDimensions,
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  tileGrid?: SparseTileGrid
): { grid: SparseTileGrid; isTemporary: boolean } {
  const missingLayers: LayerItem[] = [];

  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0.001) continue;
    if (!hasTileBackedLayer(layer)) continue;
    const hasTiles = Boolean(tileGrid && tileGrid.hasLayerTiles(layer.id));
    if (hasTiles) continue;

    const hasVectorSource =
      (layer.type === 'text' && Boolean(layer.textData)) ||
      (layer.type === 'balloon' && Boolean(layer.balloonData)) ||
      (layer.type === 'vector' && Boolean(layer.vectorStrokes && layer.vectorStrokes.length > 0));
    if (hasVectorSource || layerCanvasesMap.has(layer.id)) {
      missingLayers.push(layer);
    }
  }

  if (tileGrid && missingLayers.length === 0) {
    return { grid: tileGrid, isTemporary: false };
  }

  const tempGrid = new SparseTileGrid();
  if (tileGrid) {
    // Share existing TileBuffer references without duplicating pixel buffers
    for (const [layerId, fmt] of tileGrid.getAllLayerFormats().entries()) {
      tempGrid.setLayerFormat(layerId, fmt);
    }
    for (const tile of tileGrid.getAllTiles()) {
      if ((tile.lod ?? 0) === 0) {
        tempGrid.setTile(tile.layerId, tile.tileX, tile.tileY, tile);
      }
    }
  }

  if (typeof document !== 'undefined') {
    for (const layer of missingLayers) {
      const fmt = inferLayerTileFormat(layer);
      if (layer.type === 'text' && layer.textData) {
        const temp = document.createElement('canvas');
        temp.width = dimensions.width;
        temp.height = dimensions.height;
        const ctx = temp.getContext('2d');
        if (ctx) renderTextLayerData(ctx, layer.textData);
        tempGrid.ingestCanvas(layer.id, temp, fmt);
        releaseTemporaryCanvas(temp);
      } else if (layer.type === 'balloon' && layer.balloonData) {
        const temp = document.createElement('canvas');
        temp.width = dimensions.width;
        temp.height = dimensions.height;
        const ctx = temp.getContext('2d');
        if (ctx) renderBalloonLayerData(ctx, layer.balloonData);
        tempGrid.ingestCanvas(layer.id, temp, fmt);
        releaseTemporaryCanvas(temp);
      } else {
        const existingCanvas = layerCanvasesMap.get(layer.id);
        if (existingCanvas) {
          tempGrid.ingestCanvas(layer.id, existingCanvas, fmt);
        } else if (layer.type === 'vector' && layer.vectorStrokes && layer.vectorStrokes.length > 0) {
          const temp = document.createElement('canvas');
          temp.width = dimensions.width;
          temp.height = dimensions.height;
          const ctx = temp.getContext('2d');
          if (ctx) renderVectorLayer(ctx, layer.vectorStrokes);
          tempGrid.ingestCanvas(layer.id, temp, fmt);
          releaseTemporaryCanvas(temp);
        }
      }
    }
  }

  return { grid: tempGrid, isTemporary: true };
}

/**
 * Ensures any tiles paged out to SSD scratch disk for visible layers are hydrated in RAM
 * before GPU or CPU export begins.
 */
async function hydratePagedTilesForLayers(
  tileGrid: SparseTileGrid | undefined,
  layers: LayerItem[],
  visibleOnly: boolean
): Promise<void> {
  if (!tileGrid) return;
  const mm = tileGrid.getMemoryManager();
  if (!mm) return;

  for (const layer of layers) {
    if (visibleOnly && (!layer.visible || layer.opacity <= 0.001)) continue;
    if (!hasTileBackedLayer(layer)) continue;
    const tiles = tileGrid.getLayerTiles(layer.id, 0);
    for (const tile of tiles) {
      if (tile.data === null && tile.isPagedToDisk) {
        await mm.requestTileData(tile);
      }
    }
  }
}

export interface GpuTilePlanEntry {
  tileX: number;
  tileY: number;
  width: number;
  height: number;
  padLeft: number;
  padTop: number;
  padRight: number;
  padBottom: number;
  originX: number;
  originY: number;
  fboWidth: number;
  fboHeight: number;
}

/**
 * Pure geometry planner for tiled GPU FBO export with seam-free Layer Style halo padding.
 */
export function buildGpuExportTilePlan(
  docWidth: number,
  docHeight: number,
  maxTileSize: number = SORA_V2_DEFAULT_TILE_EXPORT_SIZE,
  styleMargin: number = 0
): { fboWidth: number; fboHeight: number; tiles: GpuTilePlanEntry[] } {
  const safeMaxTile = Math.max(256, Math.floor(maxTileSize));
  const clampedMargin = Math.max(0, Math.min(styleMargin, Math.floor((safeMaxTile - 256) / 2)));
  const innerStep = Math.max(256, safeMaxTile - clampedMargin * 2);

  const tiles: GpuTilePlanEntry[] = [];
  let maxFboW = 1;
  let maxFboH = 1;

  for (let tileY = 0; tileY < docHeight; tileY += innerStep) {
    const height = Math.min(innerStep, docHeight - tileY);
    const padTop = Math.min(clampedMargin, tileY);
    const padBottom = Math.min(clampedMargin, docHeight - (tileY + height));
    const fboHeight = height + padTop + padBottom;
    if (fboHeight > maxFboH) maxFboH = fboHeight;

    for (let tileX = 0; tileX < docWidth; tileX += innerStep) {
      const width = Math.min(innerStep, docWidth - tileX);
      const padLeft = Math.min(clampedMargin, tileX);
      const padRight = Math.min(clampedMargin, docWidth - (tileX + width));
      const fboWidth = width + padLeft + padRight;
      if (fboWidth > maxFboW) maxFboW = fboWidth;

      tiles.push({
        tileX,
        tileY,
        width,
        height,
        padLeft,
        padTop,
        padRight,
        padBottom,
        originX: tileX - padLeft,
        originY: tileY - padTop,
        fboWidth,
        fboHeight,
      });
    }
  }

  return { fboWidth: maxFboW, fboHeight: maxFboH, tiles };
}

function tryCompositeCanvasGpuSync(
  dimensions: CanvasDimensions,
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  fillWhiteBackground: boolean,
  tileGrid?: SparseTileGrid,
  options?: CompositeCanvasOptions
): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || dimensions.width <= 0 || dimensions.height <= 0) {
    return null;
  }

  const probeCanvas = document.createElement('canvas');
  const requestedTileSize = options?.tileSize ?? SORA_V2_DEFAULT_TILE_EXPORT_SIZE;
  probeCanvas.width = Math.min(requestedTileSize, dimensions.width);
  probeCanvas.height = Math.min(requestedTileSize, dimensions.height);

  const compositor = new ViewportCompositor(probeCanvas, { preserveDrawingBuffer: true });
  if (!compositor.isReady()) {
    compositor.dispose();
    releaseTemporaryCanvas(probeCanvas);
    return null;
  }

  const prepared = prepareExportTileGrid(dimensions, layers, layerCanvasesMap, tileGrid);
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = dimensions.width;
  exportCanvas.height = dimensions.height;
  const dstCtx = exportCanvas.getContext('2d');

  try {
    if (!dstCtx) {
      return exportCanvas;
    }

    const maxGpuTile = Math.min(requestedTileSize, compositor.getMaxTextureSize());
    const styleMargin = computeMaxLayerStyleMargin(layers);
    const plan = buildGpuExportTilePlan(dimensions.width, dimensions.height, maxGpuTile, styleMargin);

    if (probeCanvas.width !== plan.fboWidth) probeCanvas.width = plan.fboWidth;
    if (probeCanvas.height !== plan.fboHeight) probeCanvas.height = plan.fboHeight;

    const total = plan.tiles.length;
    for (let i = 0; i < total; i++) {
      const entry = plan.tiles[i];
      const transform: ViewportTransform = {
        pan: {
          x: dimensions.width * 0.5 - entry.originX,
          y: dimensions.height * 0.5 - entry.originY,
        },
        zoom: 1.0,
        rotation: 0,
        flipX: false,
        flipY: false,
      };

      compositor.render(layers, transform, dimensions, prepared.grid, {
        dimensions,
        colorMode: options?.colorMode,
        showCheckerboard: false,
        transparentBackground: !fillWhiteBackground,
        bypassStackCache: true,
        devicePixelRatio: 1,
      });

      dstCtx.drawImage(
        probeCanvas,
        entry.padLeft,
        entry.padTop,
        entry.width,
        entry.height,
        entry.tileX,
        entry.tileY,
        entry.width,
        entry.height
      );

      if (options?.onProgress) {
        const done = i + 1;
        options.onProgress({
          phase: 'compositing',
          current: done,
          total,
          percent: Math.round((done / total) * 100),
          message: `Compositing GPU tile ${done}/${total}...`,
        });
      }
    }

    return exportCanvas;
  } catch (err) {
    console.warn('GPU tiled export failed, falling back to CPU compositor:', err);
    releaseTemporaryCanvas(exportCanvas);
    return null;
  } finally {
    compositor.dispose();
    releaseTemporaryCanvas(probeCanvas);
    if (prepared.isTemporary) {
      prepared.grid.clearAll();
    }
  }
}

/**
 * Asynchronous tiled GPU compositor with paged-tile hydration, progress reporting,
 * and event-loop yields between tiles. Falls back to CPU only when WebGL2 is unavailable.
 */
export async function compositeCanvasAsync(
  dimensions: CanvasDimensions,
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  getEffectiveOpacity: (layer: LayerItem) => number,
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean,
  fillWhiteBackground: boolean = false,
  tileGrid?: SparseTileGrid,
  options?: CompositeCanvasOptions
): Promise<{ canvas: HTMLCanvasElement; usedGpu: boolean }> {
  await hydratePagedTilesForLayers(tileGrid, layers, true);

  if (typeof document !== 'undefined' && dimensions.width > 0 && dimensions.height > 0) {
    const requestedTileSize = options?.tileSize ?? SORA_V2_DEFAULT_TILE_EXPORT_SIZE;
    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = Math.min(requestedTileSize, dimensions.width);
    probeCanvas.height = Math.min(requestedTileSize, dimensions.height);

    const compositor = new ViewportCompositor(probeCanvas, { preserveDrawingBuffer: true });
    if (compositor.isReady()) {
      const prepared = prepareExportTileGrid(dimensions, layers, layerCanvasesMap, tileGrid);
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = dimensions.width;
      exportCanvas.height = dimensions.height;
      const dstCtx = exportCanvas.getContext('2d');

      try {
        if (dstCtx) {
          const maxGpuTile = Math.min(requestedTileSize, compositor.getMaxTextureSize());
          const styleMargin = computeMaxLayerStyleMargin(layers);
          const plan = buildGpuExportTilePlan(dimensions.width, dimensions.height, maxGpuTile, styleMargin);

          if (probeCanvas.width !== plan.fboWidth) probeCanvas.width = plan.fboWidth;
          if (probeCanvas.height !== plan.fboHeight) probeCanvas.height = plan.fboHeight;

          const total = plan.tiles.length;
          for (let i = 0; i < total; i++) {
            const entry = plan.tiles[i];
            const transform: ViewportTransform = {
              pan: {
                x: dimensions.width * 0.5 - entry.originX,
                y: dimensions.height * 0.5 - entry.originY,
              },
              zoom: 1.0,
              rotation: 0,
              flipX: false,
              flipY: false,
            };

            compositor.render(layers, transform, dimensions, prepared.grid, {
              dimensions,
              colorMode: options?.colorMode,
              showCheckerboard: false,
              transparentBackground: !fillWhiteBackground,
              bypassStackCache: true,
              devicePixelRatio: 1,
            });

            dstCtx.drawImage(
              probeCanvas,
              entry.padLeft,
              entry.padTop,
              entry.width,
              entry.height,
              entry.tileX,
              entry.tileY,
              entry.width,
              entry.height
            );

            if (options?.onProgress) {
              const done = i + 1;
              options.onProgress({
                phase: 'compositing',
                current: done,
                total,
                percent: Math.round((done / total) * 85),
                message: `Compositing GPU tile ${done}/${total}...`,
              });
            }

            if (i + 1 < total) {
              await yieldToMainThread();
            }
          }
        }
        return { canvas: exportCanvas, usedGpu: true };
      } catch (err) {
        console.warn('Async GPU tiled export failed, falling back to CPU compositor:', err);
        releaseTemporaryCanvas(exportCanvas);
      } finally {
        compositor.dispose();
        releaseTemporaryCanvas(probeCanvas);
        if (prepared.isTemporary) {
          prepared.grid.clearAll();
        }
      }
    } else {
      compositor.dispose();
      releaseTemporaryCanvas(probeCanvas);
    }
  }

  const cpuCanvas = compositeCanvasCpuFallback(
    dimensions,
    layers,
    layerCanvasesMap,
    getEffectiveOpacity,
    isLayerEffectivelyVisible,
    fillWhiteBackground,
    tileGrid
  );
  return { canvas: cpuCanvas, usedGpu: false };
}

/**
 * Creates a reusable GPU region renderer (with CPU fallback) for rendering arbitrary
 * document strips (e.g., tall 800x50,000px Webtoon chapter slices without allocating
 * a monolithic full-height canvas). Caller MUST call `dispose()` when done.
 */
export function createDocumentRegionRenderer(
  dimensions: CanvasDimensions,
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  getEffectiveOpacity: (layer: LayerItem) => number,
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean,
  tileGrid?: SparseTileGrid,
  options?: { colorMode?: CanvasColorMode; maxTileSize?: number }
): {
  usedGpu: boolean;
  renderRegion: (
    x: number,
    y: number,
    width: number,
    height: number,
    targetCanvas: HTMLCanvasElement,
    fillWhiteBackground: boolean
  ) => void;
  dispose: () => void;
} {
  const maxTileSize = options?.maxTileSize ?? SORA_V2_DEFAULT_TILE_EXPORT_SIZE;
  const styleMargin = computeMaxLayerStyleMargin(layers);
  const prepared = prepareExportTileGrid(dimensions, layers, layerCanvasesMap, tileGrid);

  let gpuCanvas: HTMLCanvasElement | null = null;
  let compositor: ViewportCompositor | null = null;
  let usedGpu = false;
  let cpuFullCache: HTMLCanvasElement | null = null;
  let cpuFullCacheWhite = false;

  if (typeof document !== 'undefined') {
    gpuCanvas = document.createElement('canvas');
    gpuCanvas.width = Math.min(maxTileSize, Math.max(1, dimensions.width));
    gpuCanvas.height = Math.min(maxTileSize, Math.max(1, dimensions.height));
    const candidate = new ViewportCompositor(gpuCanvas, { preserveDrawingBuffer: true });
    if (candidate.isReady()) {
      compositor = candidate;
      usedGpu = true;
    } else {
      candidate.dispose();
      releaseTemporaryCanvas(gpuCanvas);
      gpuCanvas = null;
    }
  }

  const renderRegion = (
    x: number,
    y: number,
    width: number,
    height: number,
    targetCanvas: HTMLCanvasElement,
    fillWhiteBackground: boolean
  ): void => {
    const dstCtx = targetCanvas.getContext('2d');
    if (!dstCtx || width <= 0 || height <= 0) return;

    if (fillWhiteBackground) {
      dstCtx.fillStyle = '#ffffff';
      dstCtx.fillRect(0, 0, width, height);
    } else {
      dstCtx.clearRect(0, 0, width, height);
    }

    if (compositor && gpuCanvas) {
      const maxGpuTile = Math.min(maxTileSize, compositor.getMaxTextureSize());
      const clampedMargin = Math.max(0, Math.min(styleMargin, Math.floor((maxGpuTile - 256) / 2)));
      const innerStep = Math.max(256, maxGpuTile - clampedMargin * 2);

      for (let sy = 0; sy < height; sy += innerStep) {
        const subH = Math.min(innerStep, height - sy);
        const docY = y + sy;
        const padTop = Math.min(clampedMargin, docY);
        const padBottom = Math.min(clampedMargin, Math.max(0, dimensions.height - (docY + subH)));

        for (let sx = 0; sx < width; sx += innerStep) {
          const subW = Math.min(innerStep, width - sx);
          const docX = x + sx;
          const padLeft = Math.min(clampedMargin, docX);
          const padRight = Math.min(clampedMargin, Math.max(0, dimensions.width - (docX + subW)));

          const fboW = subW + padLeft + padRight;
          const fboH = subH + padTop + padBottom;
          if (gpuCanvas.width < fboW) gpuCanvas.width = fboW;
          if (gpuCanvas.height < fboH) gpuCanvas.height = fboH;

          const transform: ViewportTransform = {
            pan: {
              x: dimensions.width * 0.5 - (docX - padLeft),
              y: dimensions.height * 0.5 - (docY - padTop),
            },
            zoom: 1.0,
            rotation: 0,
            flipX: false,
            flipY: false,
          };

          compositor.render(layers, transform, dimensions, prepared.grid, {
            dimensions,
            colorMode: options?.colorMode,
            showCheckerboard: false,
            transparentBackground: !fillWhiteBackground,
            bypassStackCache: true,
            devicePixelRatio: 1,
          });

          dstCtx.drawImage(gpuCanvas, padLeft, padTop, subW, subH, sx, sy, subW, subH);
        }
      }
      return;
    }

    // CPU fallback when WebGL2 is unavailable
    if (!cpuFullCache || cpuFullCacheWhite !== fillWhiteBackground) {
      if (cpuFullCache) releaseTemporaryCanvas(cpuFullCache);
      cpuFullCache = compositeCanvasCpuFallback(
        dimensions,
        layers,
        layerCanvasesMap,
        getEffectiveOpacity,
        isLayerEffectivelyVisible,
        fillWhiteBackground,
        tileGrid
      );
      cpuFullCacheWhite = fillWhiteBackground;
    }
    dstCtx.drawImage(cpuFullCache, x, y, width, height, 0, 0, width, height);
  };

  const dispose = (): void => {
    if (compositor) {
      compositor.dispose();
      compositor = null;
    }
    if (gpuCanvas) {
      releaseTemporaryCanvas(gpuCanvas);
      gpuCanvas = null;
    }
    if (cpuFullCache) {
      releaseTemporaryCanvas(cpuFullCache);
      cpuFullCache = null;
    }
    if (prepared.isTemporary) {
      prepared.grid.clearAll();
    }
  };

  return { usedGpu, renderRegion, dispose };
}

/**
 * CPU 2D fallback compositor — used strictly when WebGL2 is unavailable.
 */
export function compositeCanvasCpuFallback(
  dimensions: CanvasDimensions,
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  getEffectiveOpacity: (layer: LayerItem) => number,
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean,
  fillWhiteBackground: boolean = false,
  tileGrid?: SparseTileGrid
): HTMLCanvasElement {
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = dimensions.width;
  exportCanvas.height = dimensions.height;
  const ctx = exportCanvas.getContext('2d');
  if (!ctx) return exportCanvas;

  if (fillWhiteBackground) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dimensions.width, dimensions.height);
  }

  const getMaskedLayerCanvas = (
    layer: LayerItem,
    srcCanvas: HTMLCanvasElement
  ): { canvas: HTMLCanvasElement; isTemporary: boolean } => {
    if (!layer.maskCanvas || layer.maskEnabled === false) {
      return { canvas: srcCanvas, isTemporary: false };
    }
    const masked = document.createElement('canvas');
    masked.width = dimensions.width;
    masked.height = dimensions.height;
    const mCtx = masked.getContext('2d');
    const maskCtx = layer.maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!mCtx || !maskCtx) {
      releaseTemporaryCanvas(masked);
      return { canvas: srcCanvas, isTemporary: false };
    }
    mCtx.drawImage(srcCanvas, 0, 0);
    const imgData = mCtx.getImageData(0, 0, dimensions.width, dimensions.height);
    const maskData = maskCtx.getImageData(0, 0, dimensions.width, dimensions.height).data;
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const maskLum = ((0.299 * maskData[i] + 0.587 * maskData[i + 1] + 0.114 * maskData[i + 2]) / 255) * (maskData[i + 3] / 255);
      d[i + 3] = Math.round(d[i + 3] * maskLum);
    }
    mCtx.putImageData(imgData, 0, 0);
    return { canvas: masked, isTemporary: true };
  };

  const renderTreeNodes = (
    targetCtx: CanvasRenderingContext2D,
    nodes: LayerTreeNode[],
    opacityMul: number
  ) => {
    const renderOrder = nodes.slice().reverse();
    const groups = groupTreeNodesForCompositing(renderOrder);

    for (const group of groups) {
      const baseNode = group.baseNode;
      const baseLayer = baseNode.layer;
      if (!baseLayer.visible || baseLayer.opacity <= 0.001) continue;

      if (baseLayer.type === 'frame-folder') {
        const folderAlpha = opacityMul * baseLayer.opacity;
        const frames = (baseLayer.comicFrames || []).filter((f) => f.polygon.length >= 3);
        const shouldClip = frames.length > 0 && frames.some((f) => f.clipChildren !== false);
        const folderCanvas = document.createElement('canvas');
        folderCanvas.width = dimensions.width;
        folderCanvas.height = dimensions.height;
        const fCtx = folderCanvas.getContext('2d');
        if (fCtx) {
          fCtx.save();
          if (shouldClip) {
            applyMultiFrameClip(fCtx, frames);
          }
          for (const frame of frames) {
            if (frame.fillBackground !== false) {
              fCtx.fillStyle = frame.fillColor || '#ffffff';
              fCtx.beginPath();
              fCtx.moveTo(frame.polygon[0].x, frame.polygon[0].y);
              for (let i = 1; i < frame.polygon.length; i++) {
                fCtx.lineTo(frame.polygon[i].x, frame.polygon[i].y);
              }
              fCtx.closePath();
              fCtx.fill();
            }
          }
          if (baseNode.children.length > 0) {
            renderTreeNodes(fCtx, baseNode.children, 1.0);
          }
          fCtx.restore();
          for (const frame of frames) {
            renderFrameBorder(fCtx, frame, false);
          }
          targetCtx.save();
          targetCtx.globalAlpha = Math.max(0, Math.min(1, folderAlpha));
          const blend = baseLayer.blendMode === 'pass-through' ? 'normal' : baseLayer.blendMode;
          targetCtx.globalCompositeOperation = getCanvasCompositeOperation(blend);
          targetCtx.drawImage(folderCanvas, 0, 0);
          targetCtx.restore();
        }
        releaseTemporaryCanvas(folderCanvas);
        continue;
      }

      if (baseLayer.type === 'folder') {
        const folderAlpha = opacityMul * baseLayer.opacity;
        if (baseLayer.blendMode === 'pass-through') {
          if (baseNode.children.length > 0) {
            renderTreeNodes(targetCtx, baseNode.children, folderAlpha);
          }
        } else {
          const folderCanvas = document.createElement('canvas');
          folderCanvas.width = dimensions.width;
          folderCanvas.height = dimensions.height;
          const fCtx = folderCanvas.getContext('2d');
          if (fCtx) {
            if (baseNode.children.length > 0) {
              renderTreeNodes(fCtx, baseNode.children, 1.0);
            }
            targetCtx.save();
            targetCtx.globalAlpha = Math.max(0, Math.min(1, folderAlpha));
            targetCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
            targetCtx.drawImage(folderCanvas, 0, 0);
            targetCtx.restore();
          }
          releaseTemporaryCanvas(folderCanvas);
        }
        continue;
      }

      if (!isLayerEffectivelyVisible(baseLayer)) continue;

      if (baseLayer.type === 'adjustment' && baseLayer.adjustmentData) {
        const imgData = targetCtx.getImageData(0, 0, dimensions.width, dimensions.height);
        applyAdjustment(
          imgData,
          baseLayer.adjustmentData,
          baseLayer.maskEnabled !== false ? baseLayer.maskCanvas : undefined,
          baseLayer.opacity * opacityMul
        );
        targetCtx.putImageData(imgData, 0, 0);
        continue;
      }

      const baseAcq = acquireLayerExportCanvas(baseLayer, dimensions, layerCanvasesMap, tileGrid);
      if (!baseAcq.canvas) continue;
      const maskedBase = getMaskedLayerCanvas(baseLayer, baseAcq.canvas);

      const activeClipped = group.clippedNodes
        .map((n) => n.layer)
        .filter((cl) => !isFolderLikeLayer(cl) && cl.type !== 'adjustment' && cl.visible && cl.opacity > 0.001);

      if (activeClipped.length === 0) {
        targetCtx.save();
        targetCtx.globalAlpha = Math.max(0, Math.min(1, baseLayer.opacity * opacityMul));
        targetCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
        targetCtx.drawImage(maskedBase.canvas, 0, 0);
        targetCtx.restore();
      } else {
        const groupCanvas = document.createElement('canvas');
        groupCanvas.width = dimensions.width;
        groupCanvas.height = dimensions.height;
        const gCtx = groupCanvas.getContext('2d');
        if (gCtx) {
          gCtx.save();
          gCtx.globalAlpha = Math.max(0, Math.min(1, baseLayer.opacity * opacityMul));
          gCtx.drawImage(maskedBase.canvas, 0, 0);
          gCtx.restore();

          for (const clipped of activeClipped) {
            const clipAcq = acquireLayerExportCanvas(clipped, dimensions, layerCanvasesMap, tileGrid);
            if (!clipAcq.canvas) continue;
            const maskedClip = getMaskedLayerCanvas(clipped, clipAcq.canvas);

            gCtx.save();
            gCtx.globalAlpha = Math.max(0, Math.min(1, clipped.opacity * opacityMul));
            gCtx.globalCompositeOperation = 'source-atop';
            gCtx.drawImage(maskedClip.canvas, 0, 0);
            gCtx.restore();

            if (maskedClip.isTemporary) releaseTemporaryCanvas(maskedClip.canvas);
            if (clipAcq.isTemporary) releaseTemporaryCanvas(clipAcq.canvas);
          }

          targetCtx.save();
          targetCtx.globalAlpha = 1.0;
          targetCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
          targetCtx.drawImage(groupCanvas, 0, 0);
          targetCtx.restore();
        }
        releaseTemporaryCanvas(groupCanvas);
      }

      if (maskedBase.isTemporary) releaseTemporaryCanvas(maskedBase.canvas);
      if (baseAcq.isTemporary) releaseTemporaryCanvas(baseAcq.canvas);
    }
  };

  const tree = buildLayerTree(layers);
  renderTreeNodes(ctx, tree, 1.0);
  void getEffectiveOpacity;

  return exportCanvas;
}

/**
 * Composites all visible layers using tiled offscreen WebGL2 rendering via `ViewportCompositor`
 * (preserving 100% of GPU blend modes, Layer Styles, Screentones, Layer Color Tint,
 * Expression Color, Frame Folders, and Adjustment Layers).
 * Falls back to 2D CPU compositing strictly when WebGL2 is unavailable.
 */
export function compositeCanvas(
  dimensions: CanvasDimensions,
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  getEffectiveOpacity: (layer: LayerItem) => number,
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean,
  fillWhiteBackground: boolean = false,
  tileGrid?: SparseTileGrid,
  options?: CompositeCanvasOptions
): HTMLCanvasElement {
  const gpuResult = tryCompositeCanvasGpuSync(
    dimensions,
    layers,
    layerCanvasesMap,
    fillWhiteBackground,
    tileGrid,
    options
  );
  if (gpuResult) {
    return gpuResult;
  }

  return compositeCanvasCpuFallback(
    dimensions,
    layers,
    layerCanvasesMap,
    getEffectiveOpacity,
    isLayerEffectivelyVisible,
    fillWhiteBackground,
    tileGrid
  );
}

/**
 * Pixel-accurate tiled GPU image exporter (PNG / JPEG / WebP) with automatic
 * CPU fallback when WebGL2 is unavailable.
 */
export async function exportImage(
  data: SaveDocumentData,
  options: ExportImageOptions = {}
): Promise<ExportImageResult> {
  const format = options.format ?? 'png';
  const isJpeg = format === 'jpg' || format === 'jpeg';
  const isWebp = format === 'webp';
  const mimeType = isJpeg ? 'image/jpeg' : isWebp ? 'image/webp' : 'image/png';
  const quality = isJpeg || isWebp ? (options.quality ?? 0.92) : undefined;
  const fillWhite = options.fillWhiteBackground ?? isJpeg;
  const tileGrid =
    data.tileGrid ??
    (data.tabId ? documentStore.getSession(data.tabId)?.tileGrid : documentStore.getActiveTileGrid());

  const onProgress = options.onProgress ?? data.onProgress;

  const { canvas, usedGpu } = await compositeCanvasAsync(
    data.dimensions,
    data.layers,
    data.layerCanvasesMap,
    data.getEffectiveOpacity,
    data.isLayerEffectivelyVisible,
    fillWhite,
    tileGrid,
    {
      tileSize: options.tileSize ?? SORA_V2_DEFAULT_TILE_EXPORT_SIZE,
      colorMode: data.colorMode,
      onProgress,
    }
  );

  try {
    onProgress?.({
      phase: 'encoding',
      current: 1,
      total: 1,
      percent: 92,
      message: `Encoding ${format.toUpperCase()}...`,
    });
    const blob = await canvasToBlob(canvas, mimeType, quality);
    onProgress?.({
      phase: 'done',
      current: 1,
      total: 1,
      percent: 100,
      message: 'Export complete',
    });
    return {
      blob,
      mimeType,
      width: data.dimensions.width,
      height: data.dimensions.height,
      usedGpu,
    };
  } finally {
    releaseTemporaryCanvas(canvas);
  }
}

/**
 * Converts a canvas element into a Blob with the specified mime-type.
 */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string = 'image/png',
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob failed'));
      },
      mimeType,
      quality
    );
  });
}

// ============================================================================
// Binary `.sora` v2 Container (fflate ZIP) & Legacy v1.2 JSON Support
// ============================================================================

export interface SerializedSoraProject {
  app: string;
  version: string;
  name: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: Array<Omit<LayerItem, 'maskCanvas'>>;
  canvases: Record<string, string>;
  masks: Record<string, string>;
}

/**
 * Legacy v1.2 JSON serializer — kept exported for backward compatibility and tests.
 */
export function buildSoraProjectPayload(
  data: SaveDocumentData,
  tileGrid?: SparseTileGrid
): SerializedSoraProject {
  const layerImages: Record<string, string> = {};
  const maskImages: Record<string, string> = {};
  const serializableLayers = data.layers.map((l) => {
    if (hasTileBackedLayer(l)) {
      const acq = acquireLayerExportCanvas(l, data.dimensions, data.layerCanvasesMap, tileGrid);
      if (acq.canvas && typeof acq.canvas.toDataURL === 'function') {
        layerImages[l.id] = acq.canvas.toDataURL('image/png');
        if (acq.isTemporary) releaseTemporaryCanvas(acq.canvas);
      }
    }
    if (l.maskCanvas && typeof l.maskCanvas.toDataURL === 'function') {
      maskImages[l.id] = l.maskCanvas.toDataURL('image/png');
    }
    const { maskCanvas: _mc, ...rest } = l;
    return rest;
  });

  return {
    app: 'Ink Studio',
    version: '1.2',
    name: data.name,
    dimensions: data.dimensions,
    colorMode: data.colorMode,
    layers: serializableLayers,
    canvases: layerImages,
    masks: maskImages,
  };
}

/**
 * Pure parser for legacy `.sora` / `.ink` v1.x JSON strings.
 */
export function parseSoraProjectJson(jsonText: string): SerializedSoraProject {
  const cleanText = jsonText.charCodeAt(0) === 0xfeff ? jsonText.slice(1) : jsonText;
  const parsed = JSON.parse(cleanText);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.layers)) {
    throw new Error('Invalid .sora project payload: missing layers array');
  }
  const layers = parsed.layers.map((l: any) => sanitizeJsonLayer(l));
  return {
    app: typeof parsed.app === 'string' ? parsed.app : 'Ink Studio',
    version: typeof parsed.version === 'string' ? parsed.version : '1.0',
    name: typeof parsed.name === 'string' ? parsed.name : 'Untitled',
    dimensions: {
      width: Math.max(1, Math.min(MAX_DOCUMENT_DIM, Number(parsed.dimensions?.width) || 1440)),
      height: Math.max(1, Math.min(MAX_DOCUMENT_DIM, Number(parsed.dimensions?.height) || 900)),
      dpi: Number(parsed.dimensions?.dpi) || 300,
    },
    colorMode: parsed.colorMode || 'color',
    layers,
    canvases: parsed.canvases && typeof parsed.canvases === 'object' ? parsed.canvases : {},
    masks: parsed.masks && typeof parsed.masks === 'object' ? parsed.masks : {},
  };
}

function encodeNativeTileRecord(tile: TileBuffer, rawBytes: Uint8Array): Uint8Array {
  const fmtByte = SORA_V2_FORMAT_TO_BYTE[tile.format] ?? 2;
  const out = new Uint8Array(TILE_BINARY_HEADER_BYTES + rawBytes.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, fmtByte);
  view.setUint32(1, tile.version >>> 0, true);
  view.setUint32(5, rawBytes.byteLength >>> 0, true);
  out.set(rawBytes, TILE_BINARY_HEADER_BYTES);
  return out;
}

function decodeNativeTileRecord(
  layerId: string,
  tileX: number,
  tileY: number,
  payload: Uint8Array
): TileBuffer {
  if (payload.byteLength < TILE_BINARY_HEADER_BYTES) {
    throw new Error(`Corrupted .sora v2 tile (${layerId} ${tileX}_${tileY}): header truncated`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const fmtByte = view.getUint8(0);
  const format = SORA_V2_BYTE_TO_FORMAT[fmtByte];
  if (!format) {
    throw new Error(`Corrupted .sora v2 tile (${layerId} ${tileX}_${tileY}): unknown format byte ${fmtByte}`);
  }
  const version = view.getUint32(1, true);
  const dataLen = view.getUint32(5, true);
  const expectedLen = getTileByteSize(format);
  if (dataLen !== expectedLen || payload.byteLength !== TILE_BINARY_HEADER_BYTES + expectedLen) {
    throw new Error(
      `Corrupted .sora v2 tile (${layerId} ${tileX}_${tileY}): length mismatch (expected ${expectedLen}, got ${dataLen}/${payload.byteLength - TILE_BINARY_HEADER_BYTES})`
    );
  }
  const data = new Uint8Array(expectedLen);
  data.set(payload.subarray(TILE_BINARY_HEADER_BYTES, TILE_BINARY_HEADER_BYTES + expectedLen));
  return {
    layerId,
    tileX,
    tileY,
    format,
    data,
    dirty: true,
    version: version || 1,
    isPagedToDisk: false,
    lastAccessTimestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    lod: 0,
  };
}

function encodeMaskBinary(maskCanvas: HTMLCanvasElement): { width: number; height: number; record: Uint8Array } | null {
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  if (w <= 0 || h <= 0 || w > MAX_DOCUMENT_DIM || h > MAX_DOCUMENT_DIM) return null;
  const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || typeof ctx.getImageData !== 'function') return null;

  const src = ctx.getImageData(0, 0, w, h).data;
  const pixelCount = w * h;
  const record = new Uint8Array(MASK_BINARY_HEADER_BYTES + pixelCount);
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  view.setUint32(0, w >>> 0, true);
  view.setUint32(4, h >>> 0, true);

  for (let p = 0, i = 0; p < pixelCount; p++, i += 4) {
    record[MASK_BINARY_HEADER_BYTES + p] = Math.round(
      ((0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) * src[i + 3]) / 255
    );
  }
  return { width: w, height: h, record };
}

function decodeMaskBinary(payload: Uint8Array): { width: number; height: number; data: Uint8Array } {
  if (payload.byteLength < MASK_BINARY_HEADER_BYTES) {
    throw new Error('Corrupted .sora v2 mask: header truncated');
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  if (width === 0 || height === 0 || width > MAX_DOCUMENT_DIM || height > MAX_DOCUMENT_DIM) {
    throw new Error(`Invalid .sora v2 mask dimensions: ${width}x${height}`);
  }
  const expectedPixels = width * height;
  if (payload.byteLength !== MASK_BINARY_HEADER_BYTES + expectedPixels) {
    throw new Error(
      `Corrupted .sora v2 mask: expected ${expectedPixels} bytes, got ${payload.byteLength - MASK_BINARY_HEADER_BYTES}`
    );
  }
  const data = new Uint8Array(expectedPixels);
  data.set(payload.subarray(MASK_BINARY_HEADER_BYTES));
  return { width, height, data };
}

function createMaskCanvasFromAlpha(width: number, height: number, alpha: Uint8Array): HTMLCanvasElement | undefined {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.putImageData !== 'function') return undefined;

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < alpha.length; p++, i += 4) {
    const v = alpha[p];
    rgba[i] = v;
    rgba[i + 1] = v;
    rgba[i + 2] = v;
    rgba[i + 3] = 255;
  }
  if (typeof ImageData !== 'undefined') {
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  } else if (typeof ctx.createImageData === 'function') {
    const imgData = ctx.createImageData(width, height);
    imgData.data.set(rgba);
    ctx.putImageData(imgData, 0, 0);
  }
  return canvas;
}

async function generatePreviewPng(
  data: SaveDocumentData,
  tileGrid: SparseTileGrid | undefined
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  if (typeof document === 'undefined' || data.dimensions.width <= 0 || data.dimensions.height <= 0) {
    return null;
  }
  const scale = Math.min(1, PREVIEW_MAX_DIM / Math.max(data.dimensions.width, data.dimensions.height));
  const outW = Math.max(1, Math.round(data.dimensions.width * scale));
  const outH = Math.max(1, Math.round(data.dimensions.height * scale));
  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = outW;
  previewCanvas.height = outH;

  if (typeof previewCanvas.toBlob !== 'function') {
    releaseTemporaryCanvas(previewCanvas);
    return null;
  }

  try {
    if (tileGrid) {
      ViewportCompositor.renderLowResPreview(previewCanvas, data.layers, data.dimensions, tileGrid, {
        showCheckerboard: false,
      });
    } else {
      const ctx = previewCanvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outW, outH);
      for (let i = data.layers.length - 1; i >= 0; i--) {
        const layer = data.layers[i];
        if (!layer.visible || layer.opacity <= 0.001) continue;
        const src = data.layerCanvasesMap.get(layer.id);
        if (!src) continue;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
        ctx.drawImage(src, 0, 0, outW, outH);
        ctx.restore();
      }
    }

    const blob = await canvasToBlob(previewCanvas, 'image/png');
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength === 0) return null;
    return { bytes, width: outW, height: outH };
  } catch {
    return null;
  } finally {
    releaseTemporaryCanvas(previewCanvas);
  }
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Serializes a document into the compact binary `.sora` v2 ZIP container:
 * - `manifest.json` (metadata: document, layers, folders, masks, vectors, text, balloons, perspective, animation, timelapse)
 * - `preview.png` (downscaled preview for Recent Documents)
 * - `tiles/<layerKey>/<tx>_<ty>.bin` (native 1-bit/8-bit/32-bit SparseTileGrid buffers, zero `toDataURL`, zero full-canvas assembly)
 * - `masks/<layerKey>.bin` (8-bit mask luminance buffers)
 *
 * Uses chunked non-blocking streaming compression via `fflate.Zip` with progress reporting.
 */
export async function serializeSoraV2(
  data: SaveDocumentData,
  tileGrid?: SparseTileGrid
): Promise<{
  bytes: Uint8Array;
  previewBytes: Uint8Array | null;
  previewDataUrl?: string;
  manifest: SoraV2Manifest;
}> {
  const onProgress = data.onProgress;
  const tileCompressionLevel = data.compressionLevel ?? 3;
  const resolvedGrid =
    tileGrid ??
    data.tileGrid ??
    (data.tabId ? documentStore.getSession(data.tabId)?.tileGrid : undefined);

  onProgress?.({
    phase: 'preparing',
    current: 0,
    total: 1,
    percent: 2,
    message: 'Preparing project metadata...',
  });

  const usedKeys = new Set<string>();
  const layerTileKeys: Record<string, string> = {};
  const layerFormats: Record<string, TileFormat> = {};
  const masksMeta: Record<string, { width: number; height: number; format: 'alpha-8bit' }> = {};
  const encodedMasks: Array<{ path: string; record: Uint8Array }> = [];

  // Fallback temporary tile grid strictly for legacy layers only present in layerCanvasesMap
  let fallbackTempGrid: SparseTileGrid | null = null;

  type PendingTileSource = {
    path: string;
    tile: TileBuffer;
    sourceGrid: SparseTileGrid;
  };
  const pendingTiles: PendingTileSource[] = [];

  const serializableLayers: Array<Omit<LayerItem, 'maskCanvas'>> = [];

  for (const layer of data.layers) {
    const safeKey = toSafeZipKey(layer.id, usedKeys);
    layerTileKeys[layer.id] = safeKey;

    if (hasTileBackedLayer(layer)) {
      const gridHasTiles = Boolean(resolvedGrid && resolvedGrid.hasLayerTiles(layer.id));
      if (resolvedGrid && gridHasTiles) {
        const tiles = resolvedGrid.getLayerTiles(layer.id, 0);
        const fmt = tiles[0]?.format ?? resolvedGrid.getLayerFormat(layer.id);
        layerFormats[layer.id] = fmt;
        for (const tile of tiles) {
          pendingTiles.push({
            path: `tiles/${safeKey}/${tile.tileX}_${tile.tileY}.bin`,
            tile,
            sourceGrid: resolvedGrid,
          });
        }
      } else {
        const fmt = resolvedGrid?.getLayerFormat(layer.id) ?? inferLayerTileFormat(layer);
        layerFormats[layer.id] = fmt;

        // Legacy fallback when raster data exists only on layerCanvasesMap (no toDataURL!)
        const canvas = data.layerCanvasesMap.get(layer.id);
        if (canvas && canvas.width > 0 && canvas.height > 0) {
          if (!fallbackTempGrid) {
            fallbackTempGrid = new SparseTileGrid();
          }
          fallbackTempGrid.ingestCanvas(layer.id, canvas, fmt);
          const tiles = fallbackTempGrid.getLayerTiles(layer.id, 0);
          for (const tile of tiles) {
            pendingTiles.push({
              path: `tiles/${safeKey}/${tile.tileX}_${tile.tileY}.bin`,
              tile,
              sourceGrid: fallbackTempGrid,
            });
          }
        }
      }
    }

    if (layer.maskCanvas) {
      const encodedMask = encodeMaskBinary(layer.maskCanvas);
      if (encodedMask) {
        masksMeta[layer.id] = {
          width: encodedMask.width,
          height: encodedMask.height,
          format: 'alpha-8bit',
        };
        encodedMasks.push({
          path: `masks/${safeKey}.bin`,
          record: encodedMask.record,
        });
      }
    }

    const { maskCanvas: _mc, ...rest } = layer;
    serializableLayers.push(rest);
  }

  // Generate downscaled preview.png
  onProgress?.({
    phase: 'preview',
    current: 0,
    total: 1,
    percent: 8,
    message: 'Generating preview thumbnail...',
  });
  const preview = await generatePreviewPng(data, resolvedGrid);

  const manifest: SoraV2Manifest = {
    format: 'sora-v2',
    app: 'Ink Studio',
    version: '2.0',
    tileSize: TILE_SIZE,
    name: data.name,
    dimensions: {
      width: data.dimensions.width,
      height: data.dimensions.height,
      dpi: data.dimensions.dpi ?? 300,
    },
    colorMode: data.colorMode,
    layers: serializableLayers,
    layerFormats,
    layerTileKeys,
    masksMeta,
    perspectiveRuler: data.perspectiveRuler ?? null,
    animationTimeline: data.animationTimeline ?? null,
    timelapse: data.timelapse ?? null,
    preview: preview ? { path: 'preview.png', width: preview.width, height: preview.height } : null,
    savedAt: Date.now(),
  };

  const encoder = new TextEncoder();
  const manifestBytes = encoder.encode(JSON.stringify(manifest));

  const chunks: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((err, chunk, _final) => {
    if (err) {
      zipError = err;
      return;
    }
    if (chunk && chunk.byteLength > 0) {
      chunks.push(chunk);
    }
  });

  try {
    // 1. manifest.json
    const manifestEntry = new ZipDeflate('manifest.json', { level: 6 });
    zip.add(manifestEntry);
    manifestEntry.push(manifestBytes, true);
    if (zipError) throw zipError;

    // 2. preview.png (store uncompressed — PNG is already DEFLATE-compressed)
    if (preview) {
      const previewEntry = new ZipPassThrough('preview.png');
      zip.add(previewEntry);
      previewEntry.push(preview.bytes, true);
      if (zipError) throw zipError;
    }

    // 3. Stream native SparseTileGrid tiles in non-blocking chunks
    const totalTiles = pendingTiles.length;
    for (let i = 0; i < totalTiles; i++) {
      const item = pendingTiles[i];
      const { tile, sourceGrid, path } = item;

      let rawBytes: Uint8Array | null = tile.data;
      if (!rawBytes && tile.isPagedToDisk) {
        const mm = sourceGrid.getMemoryManager();
        if (mm) {
          // Read directly from scratch driver without inflating RAM cache
          rawBytes = await mm.getDriver().readTile(mm.getSessionId(), tile.layerId, tile.tileX, tile.tileY);
        }
      }
      if (!rawBytes) {
        rawBytes = new Uint8Array(getTileByteSize(tile.format));
      }

      const record = encodeNativeTileRecord(tile, rawBytes);
      const entry = new ZipDeflate(path, { level: tileCompressionLevel });
      zip.add(entry);
      entry.push(record, true);
      if (zipError) throw zipError;

      const done = i + 1;
      if (done % CHUNK_YIELD_INTERVAL === 0 || done === totalTiles) {
        const pct = 10 + Math.round((done / Math.max(1, totalTiles)) * 75);
        onProgress?.({
          phase: 'tiles',
          current: done,
          total: totalTiles,
          percent: Math.min(85, pct),
          message: `Saving tiles (${done}/${totalTiles})...`,
        });
        if (done < totalTiles) {
          await yieldToMainThread();
        }
      }
    }

    // 4. Layer masks
    const totalMasks = encodedMasks.length;
    for (let i = 0; i < totalMasks; i++) {
      const m = encodedMasks[i];
      const entry = new ZipDeflate(m.path, { level: tileCompressionLevel });
      zip.add(entry);
      entry.push(m.record, true);
      if (zipError) throw zipError;

      const done = i + 1;
      onProgress?.({
        phase: 'masks',
        current: done,
        total: totalMasks,
        percent: 85 + Math.round((done / Math.max(1, totalMasks)) * 10),
        message: `Saving layer masks (${done}/${totalMasks})...`,
      });
      if (done % CHUNK_YIELD_INTERVAL === 0 && done < totalMasks) {
        await yieldToMainThread();
      }
    }

    onProgress?.({
      phase: 'finalizing',
      current: 1,
      total: 1,
      percent: 96,
      message: 'Finalizing .sora archive...',
    });

    zip.end();
    if (zipError) throw zipError;

    const bytes = concatUint8Arrays(chunks);
    const previewBytes = preview ? preview.bytes : null;
    const previewDataUrl = toPngDataUrl(previewBytes);

    onProgress?.({
      phase: 'done',
      current: 1,
      total: 1,
      percent: 100,
      message: 'Saved successfully',
    });

    return { bytes, previewBytes, previewDataUrl, manifest };
  } finally {
    if (fallbackTempGrid) {
      fallbackTempGrid.clearAll();
    }
  }
}

/**
 * Fast preview-only extraction from a `.sora` v2 archive for Recent Documents.
 * Inflates ONLY `preview.png` without decompressing any tile payloads.
 */
export function extractSoraPreview(input: ArrayBuffer | Uint8Array): Uint8Array | null {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isSoraV2Bytes(raw)) return null;
  try {
    const zipBytes = unwrapZipPayload(raw);
    const extracted = unzipSync(zipBytes, {
      filter: (file) => file.name === 'preview.png',
    });
    const png = extracted['preview.png'];
    return png && png.byteLength > 0 ? png : null;
  } catch {
    return null;
  }
}

/**
 * Parses a `.sora` / `.ink` project with automatic format detection:
 * - Binary `.sora` v2 (ZIP container magic bytes) -> restores native SparseTileGrid tiles, masks, preview, and full metadata
 * - Legacy v1.2 JSON -> falls back to `parseSoraProjectJson` seamlessly
 */
export async function parseSoraProject(
  input: ArrayBuffer | Uint8Array | string,
  options?: { onProgress?: (progress: SaveProgress) => void }
): Promise<ParsedSoraProject> {
  const onProgress = options?.onProgress;

  if (typeof input === 'string') {
    const v1 = parseSoraProjectJson(input);
    return {
      format: 'v1',
      ...v1,
    };
  }

  const rawBytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  // Automatic format detection: v2 binary magic bytes vs legacy JSON v1.2
  if (!isSoraV2Bytes(rawBytes)) {
    const text = new TextDecoder('utf-8').decode(rawBytes);
    const v1 = parseSoraProjectJson(text);
    return {
      format: 'v1',
      ...v1,
    };
  }

  onProgress?.({
    phase: 'preparing',
    current: 0,
    total: 1,
    percent: 5,
    message: 'Unpacking .sora v2 container...',
  });

  const zipBytes = unwrapZipPayload(rawBytes);
  const files = unzipSync(zipBytes);

  // Validate all entry paths against path traversal attacks
  const fileNames = Object.keys(files);
  for (const name of fileNames) {
    if (!isSafeZipPath(name)) {
      throw new Error(`Unsafe archive path in .sora v2 file: "${name}"`);
    }
  }

  const manifestRaw = files['manifest.json'];
  if (!manifestRaw || manifestRaw.byteLength === 0) {
    throw new Error('Invalid .sora v2 project: missing manifest.json');
  }
  if (manifestRaw.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error('Invalid .sora v2 project: manifest.json exceeds size limit');
  }

  const manifestText = new TextDecoder('utf-8').decode(manifestRaw);
  const parsedManifest = JSON.parse(manifestText);
  if (
    !parsedManifest ||
    typeof parsedManifest !== 'object' ||
    !Array.isArray(parsedManifest.layers)
  ) {
    throw new Error('Invalid .sora v2 manifest: missing layers array');
  }

  const width = Math.floor(Number(parsedManifest.dimensions?.width) || 0);
  const height = Math.floor(Number(parsedManifest.dimensions?.height) || 0);
  if (width <= 0 || height <= 0 || width > MAX_DOCUMENT_DIM || height > MAX_DOCUMENT_DIM) {
    throw new Error(`Invalid .sora v2 dimensions: ${width}x${height}`);
  }
  const dpi = Number(parsedManifest.dimensions?.dpi) || 300;
  const colorMode: CanvasColorMode = parsedManifest.colorMode || 'color';
  const layers: LayerItem[] = parsedManifest.layers.map((l: any) => sanitizeJsonLayer(l));

  // Reverse map safeKey -> layerId from manifest
  const keyToLayerId = new Map<string, string>();
  if (parsedManifest.layerTileKeys && typeof parsedManifest.layerTileKeys === 'object') {
    for (const [layerId, safeKey] of Object.entries(parsedManifest.layerTileKeys)) {
      if (typeof safeKey === 'string' && safeKey.length > 0) {
        keyToLayerId.set(safeKey, layerId);
      }
    }
  }
  for (const layer of layers) {
    if (!keyToLayerId.has(layer.id)) {
      keyToLayerId.set(layer.id, layer.id);
    }
  }

  const layerFormats = new Map<string, TileFormat>();
  if (parsedManifest.layerFormats && typeof parsedManifest.layerFormats === 'object') {
    for (const [layerId, fmt] of Object.entries(parsedManifest.layerFormats)) {
      if (fmt === 'monochrome-1bit' || fmt === 'grayscale-8bit' || fmt === 'color-32bit') {
        layerFormats.set(layerId, fmt);
      }
    }
  }

  const tileRegex = /^tiles\/([^/]+)\/(-?\d+)_(-?\d+)\.bin$/;
  const maskRegex = /^masks\/([^/]+)\.bin$/;

  const tileEntries: Array<{ path: string; layerId: string; tx: number; ty: number }> = [];
  const maskEntries: Array<{ path: string; layerId: string }> = [];

  for (const path of fileNames) {
    const tileMatch = tileRegex.exec(path);
    if (tileMatch) {
      const safeKey = tileMatch[1];
      const layerId = keyToLayerId.get(safeKey);
      if (!layerId) continue;
      const tx = parseInt(tileMatch[2], 10);
      const ty = parseInt(tileMatch[3], 10);
      if (!Number.isSafeInteger(tx) || !Number.isSafeInteger(ty)) {
        throw new Error(`Invalid tile coordinates in .sora v2 archive: ${path}`);
      }
      tileEntries.push({ path, layerId, tx, ty });
      continue;
    }

    const maskMatch = maskRegex.exec(path);
    if (maskMatch) {
      const safeKey = maskMatch[1];
      const layerId = keyToLayerId.get(safeKey);
      if (layerId) {
        maskEntries.push({ path, layerId });
      }
    }
  }

  if (tileEntries.length > MAX_TILE_ENTRIES) {
    throw new Error(`Invalid .sora v2 project: tile count ${tileEntries.length} exceeds limit`);
  }

  const restoredTiles: TileBuffer[] = [];
  for (let i = 0; i < tileEntries.length; i++) {
    const entry = tileEntries[i];
    const payload = files[entry.path];
    const tile = decodeNativeTileRecord(entry.layerId, entry.tx, entry.ty, payload);
    restoredTiles.push(tile);
    if (!layerFormats.has(entry.layerId)) {
      layerFormats.set(entry.layerId, tile.format);
    }

    const done = i + 1;
    if (done % (CHUNK_YIELD_INTERVAL * 2) === 0 && done < tileEntries.length) {
      onProgress?.({
        phase: 'tiles',
        current: done,
        total: tileEntries.length,
        percent: 15 + Math.round((done / tileEntries.length) * 70),
        message: `Loading tiles (${done}/${tileEntries.length})...`,
      });
      await yieldToMainThread();
    }
  }

  const tileGrid = new SparseTileGrid();
  tileGrid.restoreFromSnapshot(restoredTiles, layerFormats);
  for (const layer of layers) {
    if (hasTileBackedLayer(layer)) {
      const fmt = layerFormats.get(layer.id) ?? inferLayerTileFormat(layer);
      tileGrid.setLayerFormat(layer.id, fmt);
      tileGrid.markLayerIngested(layer.id);
    }
  }

  const masksBinary = new Map<string, { width: number; height: number; data: Uint8Array }>();
  const layerById = new Map<string, LayerItem>();
  for (const l of layers) layerById.set(l.id, l);

  for (const mEntry of maskEntries) {
    const decoded = decodeMaskBinary(files[mEntry.path]);
    masksBinary.set(mEntry.layerId, decoded);
    const layer = layerById.get(mEntry.layerId);
    if (layer) {
      const maskCanvas = createMaskCanvasFromAlpha(decoded.width, decoded.height, decoded.data);
      if (maskCanvas) {
        layer.maskCanvas = maskCanvas;
        layer.maskVersion = (layer.maskVersion || 0) + 1;
      }
    }
  }

  const previewPath =
    typeof parsedManifest.preview?.path === 'string' && isSafeZipPath(parsedManifest.preview.path)
      ? parsedManifest.preview.path
      : 'preview.png';
  const previewRaw = files[previewPath];
  const previewBytes = previewRaw && previewRaw.byteLength > 0 ? new Uint8Array(previewRaw) : null;
  const previewDataUrl = toPngDataUrl(previewBytes);

  onProgress?.({
    phase: 'done',
    current: 1,
    total: 1,
    percent: 100,
    message: 'Project loaded',
  });

  return {
    format: 'v2',
    app: typeof parsedManifest.app === 'string' ? parsedManifest.app : 'Ink Studio',
    version: typeof parsedManifest.version === 'string' ? parsedManifest.version : '2.0',
    name: typeof parsedManifest.name === 'string' ? parsedManifest.name : 'Untitled',
    dimensions: { width, height, dpi },
    colorMode,
    layers,
    tileGrid,
    canvases: {},
    masks: {},
    masksBinary,
    perspectiveRuler: parsedManifest.perspectiveRuler ?? null,
    animationTimeline: parsedManifest.animationTimeline ?? null,
    timelapse: parsedManifest.timelapse ?? null,
    previewBytes,
    previewDataUrl,
  };
}

/**
 * Serializes the document according to the requested file extension.
 */
export async function serializeDocument(
  data: SaveDocumentData,
  extension: string
): Promise<{ data: Blob | ArrayBuffer; mimeType: string; previewDataUrl?: string }> {
  const ext = extension.toLowerCase();
  const tileGrid =
    data.tileGrid ??
    (data.tabId ? documentStore.getSession(data.tabId)?.tileGrid : documentStore.getActiveTileGrid());

  // 1. PSD/PSB format with full folder hierarchy, blend modes, clipping, alphaLock, and masks
  if (ext === '.psd' || ext === '.psb') {
    await hydratePagedTilesForLayers(tileGrid, data.layers, false);
    const tempCanvases: HTMLCanvasElement[] = [];
    try {
      const tree = buildLayerTree(data.layers);
      const children = buildPsdLayerTree(
        tree,
        data.dimensions,
        data.layerCanvasesMap,
        tileGrid,
        tempCanvases
      );

      const dpi = data.dimensions.dpi || 300;
      const { writePsd } = await import('ag-psd');
      const psdBuffer = writePsd(
        {
          width: data.dimensions.width,
          height: data.dimensions.height,
          children,
          imageResources: {
            resolutionInfo: {
              horizontalResolution: dpi,
              horizontalResolutionUnit: 'PPI',
              widthUnit: 'Inches',
              verticalResolution: dpi,
              verticalResolutionUnit: 'PPI',
              heightUnit: 'Inches',
            },
          },
        },
        {
          psb: ext === '.psb',
          noBackground: true,
        }
      );

      return {
        data: psdBuffer,
        mimeType: 'image/vnd.adobe.photoshop',
      };
    } finally {
      for (const temp of tempCanvases) {
        releaseTemporaryCanvas(temp);
      }
    }
  }

  // 2. Native Ink Studio Project (.sora, .ink) — Binary v2 container
  if (ext === '.ink' || ext === '.sora') {
    const result = await serializeSoraV2(data, tileGrid);
    return {
      data: new Blob([result.bytes as BlobPart], { type: 'application/octet-stream' }),
      mimeType: 'application/octet-stream',
      previewDataUrl: result.previewDataUrl,
    };
  }

  // 3. JPEG format (tiled GPU compositor with white background)
  if (ext === '.jpg' || ext === '.jpeg') {
    const exported = await exportImage(
      { ...data, tileGrid },
      { format: 'jpg', quality: 0.92, fillWhiteBackground: true }
    );
    return { data: exported.blob, mimeType: exported.mimeType };
  }

  // 4. WebP format (tiled GPU compositor with transparency)
  if (ext === '.webp') {
    const exported = await exportImage(
      { ...data, tileGrid },
      { format: 'webp', quality: 0.92, fillWhiteBackground: false }
    );
    return { data: exported.blob, mimeType: exported.mimeType };
  }

  // 5. Default: PNG format (tiled GPU compositor with transparency)
  const exported = await exportImage(
    { ...data, tileGrid },
    { format: 'png', fillWhiteBackground: false }
  );
  return { data: exported.blob, mimeType: exported.mimeType };
}

/**
 * Triggers fallback download using standard anchor element.
 */
export function downloadFile(
  content: Blob | ArrayBuffer,
  fileName: string,
  mimeType: string
) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

function getSerializedByteSize(content: Blob | ArrayBuffer): number {
  return content instanceof Blob ? content.size : content.byteLength;
}

/**
 * Prompts user to select save location and extension via File System Access API or fallback.
 */
export async function promptSaveAs(
  data: SaveDocumentData,
  defaultExtension: string = '.sora',
  fallbackToDownload: boolean = true
): Promise<SavedFileInfo> {
  const safeName = data.name.trim().replace(/[^a-zA-Z0-9_\- ]/g, '_') || 'Untitled';
  const suggestedName = `${safeName}${defaultExtension}`;

  const types = [
    {
      description: 'Ink Studio Layered Project (*.sora, *.ink)',
      accept: { 'application/octet-stream': ['.sora', '.ink'] },
    },
    {
      description: 'Photoshop Document with Layers (*.psd)',
      accept: { 'image/vnd.adobe.photoshop': ['.psd'] },
    },
    {
      description: 'PNG Image (*.png)',
      accept: { 'image/png': ['.png'] },
    },
    {
      description: 'JPEG Image (*.jpg, *.jpeg)',
      accept: { 'image/jpeg': ['.jpg', '.jpeg'] },
    },
    {
      description: 'WebP Image (*.webp)',
      accept: { 'image/webp': ['.webp'] },
    },
  ];

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types,
      });

      const fileName = handle.name;
      const ext = fileName.includes('.')
        ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
        : defaultExtension;

      const serialized = await serializeDocument(data, ext);
      const writable = await handle.createWritable();
      await writable.write(serialized.data);
      await writable.close();

      if (data.tabId) {
        recoveryService.markCleanSaved(data.tabId).catch(console.warn);
      }

      return {
        handle,
        name: fileName,
        extension: ext,
        size: getSerializedByteSize(serialized.data),
        previewDataUrl: serialized.previewDataUrl,
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('Save canceled');
      }
      console.warn('showSaveFilePicker failed or unsupported, using download fallback:', err);
    }
  }

  if (fallbackToDownload) {
    const ext = defaultExtension;
    const serialized = await serializeDocument(data, ext);
    downloadFile(serialized.data, suggestedName, serialized.mimeType);

    if (data.tabId) {
      recoveryService.markCleanSaved(data.tabId).catch(console.warn);
    }

    return {
      name: suggestedName,
      extension: ext,
      size: getSerializedByteSize(serialized.data),
      previewDataUrl: serialized.previewDataUrl,
    };
  }

  throw new Error('Save dialog was not available');
}

/**
 * Writes directly to an already selected FileSystemFileHandle without prompting.
 */
export async function saveToExistingHandle(
  data: SaveDocumentData,
  fileInfo: SavedFileInfo
): Promise<{ size: number; previewDataUrl?: string }> {
  if (!fileInfo.handle || typeof fileInfo.handle.createWritable !== 'function') {
    throw new Error('No valid file handle to save to');
  }

  const serialized = await serializeDocument(data, fileInfo.extension);
  const writable = await fileInfo.handle.createWritable();
  await writable.write(serialized.data);
  await writable.close();

  if (data.tabId) {
    recoveryService.markCleanSaved(data.tabId).catch(console.warn);
  }

  return {
    size: getSerializedByteSize(serialized.data),
    previewDataUrl: serialized.previewDataUrl,
  };
}

/**
 * Prompts user to choose a download/save path specifically for an exported image (PNG / JPG / WebP).
 */
export async function promptExportPngImage(
  data: SaveDocumentData,
  defaultName?: string
): Promise<string> {
  const safeName = (defaultName || data.name || 'artwork').trim().replace(/[^a-zA-Z0-9_\- ]/g, '_');
  const suggestedName = `${safeName}.png`;

  const types = [
    {
      description: 'PNG Image (*.png)',
      accept: { 'image/png': ['.png'] },
    },
    {
      description: 'JPEG Image (*.jpg, *.jpeg)',
      accept: { 'image/jpeg': ['.jpg', '.jpeg'] },
    },
    {
      description: 'WebP Image (*.webp)',
      accept: { 'image/webp': ['.webp'] },
    },
  ];

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types,
      });

      const fileName: string = handle.name;
      const ext = fileName.includes('.')
        ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
        : '.png';
      const serialized = await serializeDocument(data, ext);
      const writable = await handle.createWritable();
      await writable.write(serialized.data);
      await writable.close();

      return fileName;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('Export canceled');
      }
      console.warn('showSaveFilePicker failed for export, falling back to download:', err);
    }
  }

  const serialized = await serializeDocument(data, '.png');
  downloadFile(serialized.data, suggestedName, 'image/png');
  return suggestedName;
}
