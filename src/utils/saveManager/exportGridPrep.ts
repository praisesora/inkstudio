import { CanvasDimensions, LayerItem, hasTileBackedLayer } from '../../types/editor';
import { renderVectorLayer } from '../vectorEngine';
import { renderBalloonLayerData, renderTextLayerData } from '../vectorLayerRenderer';
import { SparseTileGrid, TileFormat, releaseTemporaryCanvas } from '../tileEngine';
import {
  GpuTilePlanEntry,
  INK_DEFAULT_TILE_EXPORT_SIZE,
  MAX_STYLE_MARGIN_PX,
} from './types';

/**
 * Resolves a layer's canvas from either the map or temporarily from SparseTileGrid.
 * Returns `{ canvas, isTemporary }` so caller immediately releases temporary canvases.
 */
export function acquireLayerExportCanvas(
  layer: LayerItem,
  dimensions: CanvasDimensions,
  layerCanvasesMap?: Map<string, HTMLCanvasElement>,
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
  const existing = layerCanvasesMap?.get(layer.id);
  if (existing) {
    return { canvas: existing, isTemporary: false };
  }
  if (tileGrid && tileGrid.hasLayerTiles(layer.id)) {
    const temp = tileGrid.exportLayerToCanvas(layer.id, dimensions.width, dimensions.height);
    return { canvas: temp, isTemporary: true };
  }
  return { canvas: null, isTemporary: false };
}

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

export function inferLayerTileFormat(layer: LayerItem): TileFormat {
  if (layer.expressionColor === 'monochrome') return 'monochrome-1bit';
  if (layer.expressionColor === 'gray') return 'grayscale-8bit';
  return 'color-32bit';
}

/**
 * Prepares a SparseTileGrid containing all visible tile-backed layers for GPU compositing.
 * Zero-copy fast path when `tileGrid` already holds all visible raster/vector/text/balloon layers.
 */
export function prepareExportTileGrid(
  dimensions: CanvasDimensions,
  layers: LayerItem[],
  layerCanvasesMap?: Map<string, HTMLCanvasElement>,
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
    if (hasVectorSource || layerCanvasesMap?.has(layer.id)) {
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
        const existingCanvas = layerCanvasesMap?.get(layer.id);
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
export async function hydratePagedTilesForLayers(
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

/**
 * Pure geometry planner for tiled GPU FBO export with seam-free Layer Style halo padding.
 */
export function buildGpuExportTilePlan(
  docWidth: number,
  docHeight: number,
  maxTileSize: number = INK_DEFAULT_TILE_EXPORT_SIZE,
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
