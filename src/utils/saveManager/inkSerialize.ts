import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { LayerItem, hasTileBackedLayer } from '../../types/editor';
import {
  SparseTileGrid,
  TILE_SIZE,
  TileBuffer,
  TileFormat,
  getTileByteSize,
} from '../tileEngine';
import { documentStore } from '../documentStore';
import { sanitizeWorkTimeMs } from '../artworkTimeTracker';
import {
  CHUNK_YIELD_INTERVAL,
  InkProjectManifest,
  SaveDocumentData,
  concatUint8Arrays,
  toPngDataUrl,
  toSafeZipKey,
  yieldToMainThread,
} from './types';
import { inferLayerTileFormat } from './exportGridPrep';
import {
  encodeMaskBinary,
  encodeNativeTileRecord,
  generatePreviewPng,
} from './inkCodec';

/**
 * Serializes a document into the native binary `.ink` ZIP container:
 * - `manifest.json` (metadata: document, layers, folders, masks, vectors, text, balloons, perspective, animation, timelapse)
 * - `preview.png` (downscaled preview for Recent Documents)
 * - `tiles/<layerKey>/<tx>_<ty>.bin` (native 1-bit/8-bit/32-bit SparseTileGrid buffers)
 * - `masks/<layerKey>.bin` (8-bit mask luminance buffers)
 */
export async function serializeInkProject(
  data: SaveDocumentData,
  tileGrid?: SparseTileGrid
): Promise<{
  bytes: Uint8Array;
  previewBytes: Uint8Array | null;
  previewDataUrl?: string;
  manifest: InkProjectManifest;
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

        const canvas = data.layerCanvasesMap?.get(layer.id);
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

  onProgress?.({
    phase: 'preview',
    current: 0,
    total: 1,
    percent: 8,
    message: 'Generating preview thumbnail...',
  });
  const preview = await generatePreviewPng(data, resolvedGrid);

  const manifest: InkProjectManifest = {
    format: 'ink-v2',
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
    workTimeMs: sanitizeWorkTimeMs(data.workTimeMs),
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
    const manifestEntry = new ZipDeflate('manifest.json', { level: 6 });
    zip.add(manifestEntry);
    manifestEntry.push(manifestBytes, true);
    if (zipError) throw zipError;

    if (preview) {
      const previewEntry = new ZipPassThrough('preview.png');
      zip.add(previewEntry);
      previewEntry.push(preview.bytes, true);
      if (zipError) throw zipError;
    }

    const totalTiles = pendingTiles.length;
    for (let i = 0; i < totalTiles; i++) {
      const { tile, sourceGrid, path } = pendingTiles[i];

      let rawBytes: Uint8Array | null = tile.data;
      if (!rawBytes && tile.isPagedToDisk) {
        const mm = sourceGrid.getMemoryManager();
        if (mm) {
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
      message: 'Finalizing .ink archive...',
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
