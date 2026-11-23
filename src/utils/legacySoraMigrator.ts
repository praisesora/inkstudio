import {
  CanvasColorMode,
  CanvasDimensions,
  LayerItem,
  LoadedDocument,
  isFolderLikeLayer,
} from '../types/editor';
import { SparseTileGrid, releaseTemporaryCanvas } from './tileEngine';
import { renderVectorLayer } from './vectorEngine';
import { renderBalloonLayerData, renderTextLayerData } from './vectorLayerRenderer';
import {
  MAX_DOCUMENT_DIM,
  ParsedInkProject,
  SaveProgress,
  isInkProjectBytes,
  sanitizeJsonLayer,
} from './saveManager/types';
import { extractZipPreview, parseInkZipBytes } from './saveManager/inkParse';
import { extractWorkTimeMsFromManifest } from './artworkTimeTracker';

/**
 * Read-only migrator for legacy `.sora` project files (v1 JSON and v2 binary/wrapped containers).
 * Never writes `.sora`; callers save migrated documents in the primary `.ink` format.
 */
export const LEGACY_SORA_EXTENSION = '.sora';

export interface LegacySoraV1Project {
  format: 'sora-v1';
  app: string;
  version: string;
  name: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  canvases: Record<string, string>;
  masks: Record<string, string>;
  workTimeMs?: number;
}

export type MigratedSoraProject =
  | (ParsedInkProject & { migratedFrom: 'sora-v2' })
  | (LegacySoraV1Project & { migratedFrom: 'sora-v1' });

export function isLegacySoraExtension(filenameOrPath: string): boolean {
  const dot = filenameOrPath.lastIndexOf('.');
  return dot > 0 && filenameOrPath.slice(dot).toLowerCase() === LEGACY_SORA_EXTENSION;
}

/**
 * Detects the legacy 8-byte `SORA\x00\x02` binary wrapper prefix.
 */
export function hasLegacySoraHeader(input: Uint8Array | ArrayBuffer): boolean {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x53 &&
    bytes[1] === 0x4f &&
    bytes[2] === 0x52 &&
    bytes[3] === 0x41 &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x02
  );
}

/**
 * Strips the optional 8-byte `SORA\x00\x02` header prefix from legacy v2 containers.
 */
export function unwrapLegacySoraBytes(bytes: Uint8Array): Uint8Array {
  return hasLegacySoraHeader(bytes) ? bytes.subarray(8) : bytes;
}

/**
 * Checks whether binary input is a legacy `.sora` v2 archive (raw ZIP or `SORA\x00\x02`-prefixed ZIP).
 */
export function isLegacySoraV2Bytes(input: Uint8Array | ArrayBuffer): boolean {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (hasLegacySoraHeader(bytes)) return true;
  return isInkProjectBytes(bytes);
}

/**
 * Extracts `preview.png` from a legacy `.sora` v2 file without decompressing tile payloads.
 */
export function extractLegacySoraPreview(input: ArrayBuffer | Uint8Array): Uint8Array | null {
  const raw = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isLegacySoraV2Bytes(raw)) return null;
  return extractZipPreview(unwrapLegacySoraBytes(raw));
}

/**
 * Pure read-only parser for legacy `.sora` v1.x JSON payloads.
 */
export function parseLegacySoraV1Json(jsonText: string): LegacySoraV1Project {
  const cleanText = jsonText.charCodeAt(0) === 0xfeff ? jsonText.slice(1) : jsonText;
  const parsed = JSON.parse(cleanText);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.layers)) {
    throw new Error('Invalid legacy .sora project payload: missing layers array');
  }
  const layers = parsed.layers.map((l: any) => sanitizeJsonLayer(l));
  return {
    format: 'sora-v1',
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
    workTimeMs: extractWorkTimeMsFromManifest(parsed),
  };
}

/**
 * Read-only migration parser for legacy `.sora` payloads (both v2 binary and v1 JSON).
 */
export async function migrateLegacySoraBytes(
  input: ArrayBuffer | Uint8Array | string,
  options?: { onProgress?: (progress: SaveProgress) => void }
): Promise<MigratedSoraProject> {
  if (typeof input === 'string') {
    const v1 = parseLegacySoraV1Json(input);
    return { ...v1, migratedFrom: 'sora-v1' };
  }

  const rawBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (isLegacySoraV2Bytes(rawBytes)) {
    const zipBytes = unwrapLegacySoraBytes(rawBytes);
    const parsed = await parseInkZipBytes(zipBytes, {
      onProgress: options?.onProgress,
      containerLabel: 'legacy .sora',
    });
    return { ...parsed, migratedFrom: 'sora-v2' };
  }

  const text = new TextDecoder('utf-8').decode(rawBytes);
  const v1 = parseLegacySoraV1Json(text);
  return { ...v1, migratedFrom: 'sora-v1' };
}

function hydrateMissingVectorLayers(
  grid: SparseTileGrid,
  layers: LayerItem[],
  width: number,
  height: number
): void {
  if (typeof document === 'undefined') return;
  for (const layer of layers) {
    if (grid.hasLayerTiles(layer.id)) continue;
    if (layer.type === 'text' && layer.textData) {
      const temp = document.createElement('canvas');
      temp.width = width;
      temp.height = height;
      const ctx = temp.getContext('2d');
      if (ctx) renderTextLayerData(ctx, layer.textData);
      grid.ingestCanvas(layer.id, temp, grid.getLayerFormat(layer.id));
      releaseTemporaryCanvas(temp);
    } else if (layer.type === 'balloon' && layer.balloonData) {
      const temp = document.createElement('canvas');
      temp.width = width;
      temp.height = height;
      const ctx = temp.getContext('2d');
      if (ctx) renderBalloonLayerData(ctx, layer.balloonData);
      grid.ingestCanvas(layer.id, temp, grid.getLayerFormat(layer.id));
      releaseTemporaryCanvas(temp);
    } else if (layer.type === 'vector' && layer.vectorStrokes && layer.vectorStrokes.length > 0) {
      const temp = document.createElement('canvas');
      temp.width = width;
      temp.height = height;
      const ctx = temp.getContext('2d');
      if (ctx) renderVectorLayer(ctx, layer.vectorStrokes);
      grid.ingestCanvas(layer.id, temp, grid.getLayerFormat(layer.id));
      releaseTemporaryCanvas(temp);
    }
  }
}

/**
 * Loads a legacy `.sora` file in read-only mode and converts it into an in-memory `LoadedDocument`.
 */
export async function migrateLegacySoraFile(file: File): Promise<LoadedDocument> {
  const buffer = await file.arrayBuffer();
  const migrated = await migrateLegacySoraBytes(buffer);
  const width = migrated.dimensions.width;
  const height = migrated.dimensions.height;
  const dpi = migrated.dimensions.dpi || 300;
  const colorMode: CanvasColorMode = migrated.colorMode || 'color';
  const layers = migrated.layers;
  const fallbackName = file.name.replace(/\.[^/.]+$/, '');

  if (migrated.migratedFrom === 'sora-v2') {
    hydrateMissingVectorLayers(migrated.tileGrid, layers, width, height);
    return {
      name: migrated.name || fallbackName,
      dimensions: { width, height, dpi },
      colorMode,
      layers,
      tileGrid: migrated.tileGrid,
      perspectiveRuler: migrated.perspectiveRuler ?? null,
      animationTimeline: migrated.animationTimeline ?? null,
      timelapse: migrated.timelapse ?? null,
      workTimeMs: migrated.workTimeMs,
      previewDataUrl: migrated.previewDataUrl,
    };
  }

  // Legacy v1 JSON: ingest base64 canvas/mask PNGs into SparseTileGrid
  const grid = new SparseTileGrid();
  if (typeof document !== 'undefined') {
    const loadPromises = layers.map((layer) => {
      const tasks: Promise<void>[] = [];

      const maskDataUrl = migrated.masks[layer.id];
      if (maskDataUrl) {
        tasks.push(
          new Promise<void>((resolve) => {
            const mCanvas = document.createElement('canvas');
            mCanvas.width = width;
            mCanvas.height = height;
            const mImg = new Image();
            mImg.onload = () => {
              mCanvas.getContext('2d')?.drawImage(mImg, 0, 0);
              layer.maskCanvas = mCanvas;
              layer.maskVersion = (layer.maskVersion || 0) + 1;
              resolve();
            };
            mImg.onerror = () => resolve();
            mImg.src = maskDataUrl;
          })
        );
      }

      if (!isFolderLikeLayer(layer) && layer.type !== 'adjustment') {
        tasks.push(
          new Promise<void>((resolve) => {
            const fmt =
              layer.expressionColor === 'monochrome'
                ? 'monochrome-1bit'
                : layer.expressionColor === 'gray'
                  ? 'grayscale-8bit'
                  : 'color-32bit';

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const finishIngest = () => {
              grid.ingestCanvas(layer.id, canvas, fmt);
              releaseTemporaryCanvas(canvas);
              resolve();
            };

            if (layer.type === 'text' && layer.textData) {
              const ctx = canvas.getContext('2d');
              if (ctx) renderTextLayerData(ctx, layer.textData);
              finishIngest();
              return;
            }
            if (layer.type === 'balloon' && layer.balloonData) {
              const ctx = canvas.getContext('2d');
              if (ctx) renderBalloonLayerData(ctx, layer.balloonData);
              finishIngest();
              return;
            }

            const dataUrl = migrated.canvases[layer.id];
            if (dataUrl) {
              const img = new Image();
              img.onload = () => {
                canvas.getContext('2d')?.drawImage(img, 0, 0);
                finishIngest();
              };
              img.onerror = () => {
                releaseTemporaryCanvas(canvas);
                resolve();
              };
              img.src = dataUrl;
            } else if (layer.type === 'vector' && layer.vectorStrokes && layer.vectorStrokes.length > 0) {
              const ctx = canvas.getContext('2d');
              if (ctx) renderVectorLayer(ctx, layer.vectorStrokes);
              finishIngest();
            } else {
              releaseTemporaryCanvas(canvas);
              resolve();
            }
          })
        );
      }

      return Promise.all(tasks).then(() => {});
    });

    await Promise.all(loadPromises);
  }

  return {
    name: migrated.name || fallbackName,
    dimensions: { width, height, dpi },
    colorMode,
    layers,
    tileGrid: grid,
    workTimeMs: migrated.workTimeMs,
  };
}
