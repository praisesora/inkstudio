import type {
  CanvasDimensions,
  LayerItem,
  CanvasColorMode,
  AnimationTimeline,
  InkTimelapseMetadata,
} from '../../types/editor';
import type { PerspectiveRuler } from '../../types/perspective';
import type { SparseTileGrid, TileFormat } from '../tileEngine';

export const PRIMARY_PROJECT_EXTENSION = '.ink';

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
  layerCanvasesMap?: Map<string, HTMLCanvasElement>;
  tileGrid?: SparseTileGrid;
  getEffectiveOpacity: (layer: LayerItem) => number;
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean;
  tabId?: string;
  perspectiveRuler?: PerspectiveRuler | null;
  animationTimeline?: AnimationTimeline | null;
  timelapse?: InkTimelapseMetadata | null;
  workTimeMs?: number;
  onProgress?: (progress: SaveProgress) => void;
  compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export interface InkProjectManifest {
  format: 'ink-v2';
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
  timelapse?: InkTimelapseMetadata | null;
  workTimeMs?: number;
  preview: { path: string; width: number; height: number } | null;
  savedAt: number;
}

export interface ParsedInkProject {
  format: 'ink-v2';
  app: string;
  version: string;
  name: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  tileGrid: SparseTileGrid;
  masksBinary: Map<string, { width: number; height: number; data: Uint8Array }>;
  perspectiveRuler?: PerspectiveRuler | null;
  animationTimeline?: AnimationTimeline | null;
  timelapse?: InkTimelapseMetadata | null;
  workTimeMs?: number;
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

export const INK_DEFAULT_TILE_EXPORT_SIZE = 2048;

export const INK_TILE_FORMAT_TO_BYTE: Record<TileFormat, number> = {
  'monochrome-1bit': 0,
  'grayscale-8bit': 1,
  'color-32bit': 2,
};

export const INK_BYTE_TO_TILE_FORMAT: Record<number, TileFormat> = {
  0: 'monochrome-1bit',
  1: 'grayscale-8bit',
  2: 'color-32bit',
};

export const TILE_BINARY_HEADER_BYTES = 9; // [format:u8][version:u32 LE][dataLen:u32 LE]
export const MASK_BINARY_HEADER_BYTES = 8; // [width:u32 LE][height:u32 LE]
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
export const MAX_DOCUMENT_DIM = 65536;
export const MAX_TILE_ENTRIES = 120000;
export const CHUNK_YIELD_INTERVAL = 8;
export const MAX_STYLE_MARGIN_PX = 256;
export const PREVIEW_MAX_DIM = 512;

export function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
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

export function toPngDataUrl(bytes: Uint8Array | null | undefined): string | undefined {
  if (!bytes || bytes.byteLength === 0) return undefined;
  const b64 = bytesToBase64(bytes);
  return b64 ? `data:image/png;base64,${b64}` : undefined;
}

export function toSafeZipKey(rawId: string, usedKeys: Set<string>): string {
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

export function isSafeZipPath(path: string): boolean {
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

export function sanitizeJsonLayer(raw: any): LayerItem {
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
 * Checks whether binary input begins with standard ZIP container magic bytes
 * (`PK\x03\x04` local file header or `PK\x05\x06` empty archive).
 */
export function isInkProjectBytes(input: Uint8Array | ArrayBuffer): boolean {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 4) return false;
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

export function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
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
