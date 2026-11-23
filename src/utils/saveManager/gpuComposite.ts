import type { CanvasColorMode, CanvasDimensions, LayerItem } from '../../types/editor';
import { ViewportCompositor, ViewportTransform } from '../compositor';
import { performanceManager } from '../performanceManager';
import { SparseTileGrid, releaseTemporaryCanvas } from '../tileEngine';
import {
  CompositeCanvasOptions,
  INK_DEFAULT_TILE_EXPORT_SIZE,
  yieldToMainThread,
} from './types';
import {
  buildGpuExportTilePlan,
  computeMaxLayerStyleMargin,
  hydratePagedTilesForLayers,
  prepareExportTileGrid,
} from './exportGridPrep';
import { compositeCanvasCpuFallback } from './cpuComposite';

function tryCompositeCanvasGpuSync(
  dimensions: CanvasDimensions,
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement> | undefined,
  fillWhiteBackground: boolean,
  tileGrid?: SparseTileGrid,
  options?: CompositeCanvasOptions
): HTMLCanvasElement | null {
  if (
    typeof document === 'undefined' ||
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    performanceManager.getConfig().renderBackend === 'canvas2d'
  ) {
    return null;
  }

  const probeCanvas = document.createElement('canvas');
  const requestedTileSize = options?.tileSize ?? INK_DEFAULT_TILE_EXPORT_SIZE;
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
  layerCanvasesMap: Map<string, HTMLCanvasElement> | undefined,
  getEffectiveOpacity: (layer: LayerItem) => number,
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean,
  fillWhiteBackground: boolean = false,
  tileGrid?: SparseTileGrid,
  options?: CompositeCanvasOptions
): Promise<{ canvas: HTMLCanvasElement; usedGpu: boolean }> {
  await hydratePagedTilesForLayers(tileGrid, layers, true);

  if (
    typeof document !== 'undefined' &&
    dimensions.width > 0 &&
    dimensions.height > 0 &&
    performanceManager.getConfig().renderBackend !== 'canvas2d'
  ) {
    const requestedTileSize = options?.tileSize ?? INK_DEFAULT_TILE_EXPORT_SIZE;
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
  layerCanvasesMap: Map<string, HTMLCanvasElement> | undefined,
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
  const maxTileSize = options?.maxTileSize ?? INK_DEFAULT_TILE_EXPORT_SIZE;
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
 * Composites all visible layers using tiled offscreen WebGL2 rendering via `ViewportCompositor`
 * (preserving 100% of GPU blend modes, Layer Styles, Screentones, Layer Color Tint,
 * Expression Color, Frame Folders, and Adjustment Layers).
 * Falls back to 2D CPU compositing strictly when WebGL2 is unavailable.
 */
export function compositeCanvas(
  dimensions: CanvasDimensions,
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement> | undefined,
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
