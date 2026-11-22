import { describe, it, expect } from 'vitest';
import { SparseTileGrid, BYTES_32BIT, TILE_SIZE, type TileSnapshotEntry } from '../tileEngine';
import { executeFloodFillOnTileGrid } from '../floodFill';
import {
  clearSelectionInTileGrid,
  fillSelectionInTileGrid,
  floodSelectWandOnTileGrid,
} from '../selectionUtils';
import { applyFilterToTileGrid } from '../filterEngine';
import { computeHistogramsFromTileSnapshot, applyTonalToTileGrid } from '../tonalEngine';
import { applyLiquifyStepOnTileGrid } from '../liquifyEngine';
import { sampleCompositedColor } from '../canvasUtils';
import type { CanvasDimensions, CanvasSelection, LayerItem } from '../../types/editor';

const DOC_600_DPI: CanvasDimensions = { width: 7016, height: 9921 };

if (typeof (globalThis as unknown as { ImageData?: unknown }).ImageData === 'undefined') {
  class PolyfillImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    colorSpace = 'srgb' as const;
    constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, maybeHeight?: number) {
      if (typeof dataOrWidth === 'number') {
        this.width = dataOrWidth;
        this.height = widthOrHeight;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      } else {
        this.data = dataOrWidth;
        this.width = widthOrHeight;
        this.height = maybeHeight ?? Math.floor(dataOrWidth.length / (widthOrHeight * 4));
      }
    }
  }
  (globalThis as unknown as { ImageData: unknown }).ImageData = PolyfillImageData;
}

function makeImageData(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number]
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const [r, g, b, a] = fill(x, y);
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = a;
    }
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

function makeSolid(width: number, height: number, r: number, g: number, b: number, a: number): ImageData {
  return makeImageData(width, height, () => [r, g, b, a]);
}

function makeRasterLayer(id: string, overrides: Partial<LayerItem> = {}): LayerItem {
  return {
    id,
    name: id,
    type: 'raster',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    locked: false,
    parentId: null,
    ...overrides,
  };
}

describe('Tile-Native Pipeline (Zero Duplicate Full-Doc HTMLCanvasElement at 600 DPI)', () => {
  it('computes tight content bounds, samples pixels, and prunes empty tiles on 7016x9921 without allocating untouched tiles', () => {
    const grid = new SparseTileGrid();
    // Draw a 32x24 red block at (5010, 8020)
    grid.writeImageData('ink', makeSolid(32, 24, 220, 40, 30, 255), 5010, 8020, 'color-32bit');

    expect(grid.getMemoryStats().tileCount).toBe(1);
    expect(grid.getMemoryStats().activeBytes).toBe(BYTES_32BIT);

    expect(grid.getPixelRGBA('ink', 5020, 8030)).toEqual([220, 40, 30, 255]);
    expect(grid.getPixelRGBA('ink', 0, 0)).toEqual([0, 0, 0, 0]);

    const bounds = grid.getLayerContentBounds('ink', DOC_600_DPI, false);
    // getLayerContentBounds includes a 4px transform margin around the tight pixel box
    expect(bounds).toEqual({ x: 5006, y: 8016, width: 40, height: 32 });

    // Clearing the region auto-prunes the emptied tile
    grid.clearRectInLayer('ink', { x: 5010, y: 8020, width: 32, height: 24 }, false);
    expect(grid.getMemoryStats().tileCount).toBe(0);

    // Explicit pruneEmptyTiles reclaims any all-transparent tiles created directly
    grid.getOrCreateTile('ink', 3, 4, 'color-32bit', 0);
    expect(grid.getMemoryStats().tileCount).toBe(1);
    expect(grid.pruneEmptyTiles('ink')).toBe(1);
    expect(grid.getMemoryStats().tileCount).toBe(0);
  });

  it('executes bounded flood fill directly on SparseTileGrid at 600 DPI with undo/redo tile deltas', () => {
    const grid = new SparseTileGrid();
    const layers = [makeRasterLayer('lineart'), makeRasterLayer('fill')];

    // Draw a closed 80x80 black box border at (3000, 4000) on lineart
    const box = makeImageData(80, 80, (x, y) => {
      if (x < 3 || x >= 77 || y < 3 || y >= 77) return [0, 0, 0, 255];
      return [0, 0, 0, 0];
    });
    grid.writeImageData('lineart', box, 3000, 4000, 'color-32bit');

    const res = executeFloodFillOnTileGrid({
      grid,
      targetLayerId: 'fill',
      layers,
      dimensions: DOC_600_DPI,
      startX: 3040,
      startY: 4040,
      fillColorHex: '#3366ff',
      tolerance: 10,
      referMode: 'refer-all',
      targetFormat: 'color-32bit',
    });

    expect(res.modified).toBe(true);
    expect(res.tileDeltas.length).toBeGreaterThan(0);
    // Inside box filled with #3366ff
    expect(grid.getPixelRGBA('fill', 3040, 4040)).toEqual([0x33, 0x66, 0xff, 255]);
    // Outside box untouched
    expect(grid.getPixelRGBA('fill', 2990, 4040)).toEqual([0, 0, 0, 0]);
    // At most 4 tiles allocated for fill layer (spanning at most a 2x2 tile corner) — nowhere near 7016x9921 (1092 tiles)
    expect(grid.getLayerTiles('fill', 0).length).toBeLessThanOrEqual(4);

    // Undo restores exact transparency; redo restores exact fill
    grid.applyTileDeltas(res.tileDeltas, 'undo');
    expect(grid.getPixelRGBA('fill', 3040, 4040)).toEqual([0, 0, 0, 0]);
    grid.applyTileDeltas(res.tileDeltas, 'redo');
    expect(grid.getPixelRGBA('fill', 3040, 4040)).toEqual([0x33, 0x66, 0xff, 255]);
  });

  it('runs clearSelectionInTileGrid, fillSelectionInTileGrid, and floodSelectWandOnTileGrid directly on tiles', () => {
    const grid = new SparseTileGrid();
    const layers = [makeRasterLayer('layer-1')];
    const sel: CanvasSelection = {
      type: 'rect',
      bounds: { x: 2000, y: 3000, width: 60, height: 40 },
    };

    const fillRes = fillSelectionInTileGrid({
      grid,
      layerId: 'layer-1',
      dimensions: DOC_600_DPI,
      selection: sel,
      colorCss: '#10a050',
      targetFormat: 'color-32bit',
    });
    expect(fillRes.tileDeltas.length).toBeGreaterThan(0);
    expect(grid.getPixelRGBA('layer-1', 2025, 3015)).toEqual([0x10, 0xa0, 0x50, 255]);
    expect(grid.getLayerTiles('layer-1', 0).length).toBeLessThanOrEqual(2);

    // Magic wand selects the exact 60x40 filled region without scanning 7016x9921
    const wand = floodSelectWandOnTileGrid({
      grid,
      layers,
      activeLayerId: 'layer-1',
      dimensions: DOC_600_DPI,
      startX: 2025,
      startY: 3015,
      settings: {
        tolerance: 5,
        contiguous: true,
        referMode: 'active',
        antiAlias: false,
      },
    });
    expect(wand.bounds).toEqual({ x: 2000, y: 3000, width: 60, height: 40 });
    expect(wand.mask[3015 * DOC_600_DPI.width + 2025]).toBe(255);
    expect(wand.mask[2999 * DOC_600_DPI.width + 2025]).toBe(0);

    const clearRes = clearSelectionInTileGrid({
      grid,
      layerId: 'layer-1',
      dimensions: DOC_600_DPI,
      selection: sel,
      isBackground: false,
      targetFormat: 'color-32bit',
    });
    expect(clearRes.tileDeltas.length).toBeGreaterThan(0);
    expect(grid.getPixelRGBA('layer-1', 2025, 3015)).toEqual([0, 0, 0, 0]);
  });

  it('applies Gaussian blur across a tile boundary on 7016x9921 touching only populated tiles + halo', () => {
    const grid = new SparseTileGrid();
    // Place a 40x40 white square straddling tile boundary x=256, y=256
    grid.writeImageData('fx', makeSolid(40, 40, 255, 255, 255, 255), 236, 236, 'color-32bit');

    const res = applyFilterToTileGrid({
      grid,
      layerId: 'fx',
      dimensions: DOC_600_DPI,
      type: 'gaussian-blur',
      filterParams: { radius: 4 },
      targetFormat: 'color-32bit',
    });

    expect(res.tileDeltas.length).toBeGreaterThan(0);
    // Center stays bright opaque, edge softens across boundary
    const center = grid.getPixelRGBA('fx', 256, 256);
    const halo = grid.getPixelRGBA('fx', 278, 256);
    expect(center[3]).toBeGreaterThan(200);
    expect(halo[3]).toBeGreaterThan(0);
    expect(halo[3]).toBeLessThan(255);
    // Only the 4 tiles around (256, 256) were allocated — not 1092 tiles
    expect(grid.getLayerTiles('fx', 0).length).toBeLessThanOrEqual(4);
  });

  it('computes tonal histograms, previews tonal corrections, and restores exact snapshot on cancel', () => {
    const grid = new SparseTileGrid();
    grid.writeImageData('tone', makeSolid(30, 30, 100, 150, 200, 255), 1024, 2048, 'color-32bit');

    const beforeSnapshot = grid.snapshotLayerTiles('tone');
    const hist = computeHistogramsFromTileSnapshot(beforeSnapshot, DOC_600_DPI);
    expect(hist.r[100]).toBe(900);
    expect(hist.g[150]).toBe(900);
    expect(hist.b[200]).toBe(900);

    // Live preview brightness/contrast shift
    const { tileDeltas } = applyTonalToTileGrid({
      grid,
      layerId: 'tone',
      dimensions: DOC_600_DPI,
      beforeSnapshot,
      type: 'brightness-contrast',
      tonalParams: { brightness: 40, contrast: 0 },
      targetFormat: 'color-32bit',
    });
    expect(tileDeltas.length).toBe(1);
    const previewPx = grid.getPixelRGBA('tone', 1030, 2055);
    expect(previewPx[0]).toBeGreaterThan(100);

    // Cancel restores exact original pixels
    grid.restoreLayerSnapshot('tone', beforeSnapshot);
    expect(grid.getPixelRGBA('tone', 1030, 2055)).toEqual([100, 150, 200, 255]);
    expect(grid.getLayerTiles('tone', 0).length).toBe(1);
  });

  it('executes liquify push and reconstruct lazily on tiles without full-document snapshots', () => {
    const grid = new SparseTileGrid();
    // Draw a crisp red vertical bar at x=250..260, y=240..280 (straddling tile x=0 and x=1)
    grid.writeImageData('liq', makeSolid(10, 40, 240, 20, 20, 255), 250, 240, 'color-32bit');

    const beforeTileSnapshot = new Map<string, TileSnapshotEntry>();
    const dirty = applyLiquifyStepOnTileGrid({
      grid,
      layerId: 'liq',
      dimensions: DOC_600_DPI,
      targetFormat: 'color-32bit',
      cx: 268,
      cy: 260,
      prevX: 254,
      prevY: 260,
      settings: { mode: 'push', size: 48, strength: 100, hardness: 80, usePressure: false },
      beforeTileSnapshot,
    });

    expect(dirty).not.toBeNull();
    expect(beforeTileSnapshot.size).toBeLessThanOrEqual(4);
    // Pixels were pushed right past x=260
    expect(grid.getPixelRGBA('liq', 263, 260)[3]).toBeGreaterThan(0);

    // Reconstruct restores original pixel state from beforeTileSnapshot
    for (let i = 0; i < 6; i++) {
      applyLiquifyStepOnTileGrid({
        grid,
        layerId: 'liq',
        dimensions: DOC_600_DPI,
        targetFormat: 'color-32bit',
        cx: 263,
        cy: 260,
        prevX: 263,
        prevY: 260,
        settings: { mode: 'reconstruct', size: 60, strength: 100, hardness: 100, usePressure: false },
        beforeTileSnapshot,
      });
    }
    expect(grid.getPixelRGBA('liq', 263, 260)[3]).toBeLessThan(20);
  });

  it('merges layers, resizes with tile-aligned shift and offset, copies/pastes tiles, and samples composited color directly from SparseTileGrid', () => {
    const grid = new SparseTileGrid();
    // Bottom opaque blue, top 50% red at (512, 512)
    grid.writeImageData('bottom', makeSolid(32, 32, 0, 0, 200, 255), 512, 512, 'color-32bit');
    grid.writeImageData('top', makeSolid(32, 32, 200, 0, 0, 255), 512, 512, 'color-32bit');

    const layers: LayerItem[] = [
      makeRasterLayer('top', { opacity: 0.5 }),
      makeRasterLayer('bottom', { opacity: 1 }),
    ];

    // Eyedropper samples directly from SparseTileGrid without any HTMLCanvasElement
    const sampled = sampleCompositedColor(
      layers,
      grid,
      520,
      520,
      (l) => l.visible,
      (l) => l.opacity,
      DOC_600_DPI.width,
      DOC_600_DPI.height
    );
    expect(sampled).toBe('#640064');

    // Merge top into bottom directly in SparseTileGrid
    grid.mergeLayersInGrid('top', 'bottom', {
      opacity: 0.5,
      blendMode: 'normal',
      visible: true,
      dimensions: DOC_600_DPI,
      dstFormat: 'color-32bit',
    });
    const merged = grid.getPixelRGBA('bottom', 520, 520);
    expect(merged[0]).toBeGreaterThanOrEqual(99);
    expect(merged[0]).toBeLessThanOrEqual(101);
    expect(merged[2]).toBeGreaterThanOrEqual(99);
    expect(merged[2]).toBeLessThanOrEqual(101);
    expect(merged[3]).toBe(255);

    // Copy & paste tile snapshot
    const clip = grid.copyLayerTilesSnapshot('bottom');
    grid.pasteLayerTilesSnapshot('pasted', clip);
    expect(grid.getPixelRGBA('pasted', 520, 520)).toEqual(merged);

    // Tile-aligned shift (+256, +512) moves zero-copy
    grid.resizeLayerInGrid('pasted', DOC_600_DPI, DOC_600_DPI, {
      scaleContent: false,
      offsetX: TILE_SIZE,
      offsetY: TILE_SIZE * 2,
      isBackground: false,
      backgroundColor: '#ffffff',
      targetFormat: 'color-32bit',
    });
    expect(grid.getPixelRGBA('pasted', 520 + TILE_SIZE, 520 + TILE_SIZE * 2)).toEqual(merged);
    expect(grid.getPixelRGBA('pasted', 520, 520)).toEqual([0, 0, 0, 0]);

    // Sub-tile offset shift (+10, +15)
    grid.resizeLayerInGrid('pasted', DOC_600_DPI, DOC_600_DPI, {
      scaleContent: false,
      offsetX: 10,
      offsetY: 15,
      isBackground: false,
      backgroundColor: '#ffffff',
      targetFormat: 'color-32bit',
    });
    expect(grid.getPixelRGBA('pasted', 530 + TILE_SIZE, 535 + TILE_SIZE * 2)).toEqual(merged);
  });
});
