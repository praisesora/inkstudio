import { unzipSync } from 'fflate';
import { CanvasColorMode, LayerItem, hasTileBackedLayer } from '../../types/editor';
import { SparseTileGrid, TileBuffer, TileFormat } from '../tileEngine';
import {
  CHUNK_YIELD_INTERVAL,
  MAX_DOCUMENT_DIM,
  MAX_MANIFEST_BYTES,
  MAX_TILE_ENTRIES,
  ParsedInkProject,
  SaveProgress,
  isInkProjectBytes,
  isSafeZipPath,
  sanitizeJsonLayer,
  toPngDataUrl,
  yieldToMainThread,
} from './types';
import { inferLayerTileFormat } from './exportGridPrep';
import {
  createMaskCanvasFromAlpha,
  decodeMaskBinary,
  decodeNativeTileRecord,
} from './inkCodec';

/**
 * Extracts `preview.png` from raw ZIP container bytes without inflating tile entries.
 */
export function extractZipPreview(zipBytes: Uint8Array): Uint8Array | null {
  if (!isInkProjectBytes(zipBytes)) return null;
  try {
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
 * Fast preview-only extraction from a `.ink` archive for Recent Documents.
 */
export function extractInkPreview(input: ArrayBuffer | Uint8Array): Uint8Array | null {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);
  return extractZipPreview(raw);
}

/**
 * Unpacks and validates a binary v2 ZIP container (used by `.ink` and the read-only `.sora` migrator).
 */
export async function parseInkZipBytes(
  zipBytes: Uint8Array,
  options?: { onProgress?: (progress: SaveProgress) => void; containerLabel?: string }
): Promise<ParsedInkProject> {
  const onProgress = options?.onProgress;
  const label = options?.containerLabel ?? '.ink';

  onProgress?.({
    phase: 'preparing',
    current: 0,
    total: 1,
    percent: 5,
    message: `Unpacking ${label} container...`,
  });

  const files = unzipSync(zipBytes);

  const fileNames = Object.keys(files);
  for (const name of fileNames) {
    if (!isSafeZipPath(name)) {
      throw new Error(`Unsafe archive path in ${label} file: "${name}"`);
    }
  }

  const manifestRaw = files['manifest.json'];
  if (!manifestRaw || manifestRaw.byteLength === 0) {
    throw new Error(`Invalid ${label} project: missing manifest.json`);
  }
  if (manifestRaw.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error(`Invalid ${label} project: manifest.json exceeds size limit`);
  }

  const manifestText = new TextDecoder('utf-8').decode(manifestRaw);
  const parsedManifest = JSON.parse(manifestText);
  if (
    !parsedManifest ||
    typeof parsedManifest !== 'object' ||
    !Array.isArray(parsedManifest.layers)
  ) {
    throw new Error(`Invalid ${label} manifest: missing layers array`);
  }

  const width = Math.floor(Number(parsedManifest.dimensions?.width) || 0);
  const height = Math.floor(Number(parsedManifest.dimensions?.height) || 0);
  if (width <= 0 || height <= 0 || width > MAX_DOCUMENT_DIM || height > MAX_DOCUMENT_DIM) {
    throw new Error(`Invalid ${label} dimensions: ${width}x${height}`);
  }
  const dpi = Number(parsedManifest.dimensions?.dpi) || 300;
  const colorMode: CanvasColorMode = parsedManifest.colorMode || 'color';
  const layers: LayerItem[] = parsedManifest.layers.map((l: any) => sanitizeJsonLayer(l));

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
        throw new Error(`Invalid tile coordinates in ${label} archive: ${path}`);
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
    throw new Error(`Invalid ${label} project: tile count ${tileEntries.length} exceeds limit`);
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
    format: 'ink-v2',
    app: typeof parsedManifest.app === 'string' ? parsedManifest.app : 'Ink Studio',
    version: typeof parsedManifest.version === 'string' ? parsedManifest.version : '2.0',
    name: typeof parsedManifest.name === 'string' ? parsedManifest.name : 'Untitled',
    dimensions: { width, height, dpi },
    colorMode,
    layers,
    tileGrid,
    masksBinary,
    perspectiveRuler: parsedManifest.perspectiveRuler ?? null,
    animationTimeline: parsedManifest.animationTimeline ?? null,
    timelapse: parsedManifest.timelapse ?? null,
    previewBytes,
    previewDataUrl,
  };
}

/**
 * Parses a native binary `.ink` project archive.
 */
export async function parseInkProject(
  input: ArrayBuffer | Uint8Array,
  options?: { onProgress?: (progress: SaveProgress) => void }
): Promise<ParsedInkProject> {
  const rawBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isInkProjectBytes(rawBytes)) {
    throw new Error('Invalid .ink project: expected binary ZIP container');
  }
  return parseInkZipBytes(rawBytes, { ...options, containerLabel: '.ink' });
}
