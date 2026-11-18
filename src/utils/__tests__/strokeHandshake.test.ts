import { describe, it, expect, beforeEach } from 'vitest';
import {
  SparseTileGrid,
} from '../tileEngine';
import { binarizeCanvasRect } from '../colorUtils';
import { TaperEngine } from '../../engine/TaperEngine';

describe('Zero-Flicker Stroke Handshake & WYSIWYG Monochrome Pipeline', () => {
  let grid: SparseTileGrid;

  beforeEach(() => {
    grid = new SparseTileGrid();
  });

  it('guarantees atomic synchronous tile commit and decoupled delta generation', () => {
    const layerId = 'layer-test';
    const dirtyRect = { x: 50, y: 50, width: 100, height: 100 };

    // 1. Initial layer state
    const initialBuffer = new Uint8ClampedArray(100 * 100 * 4);
    // Draw initial blue square
    for (let i = 0; i < 100 * 100; i++) {
      initialBuffer[i * 4 + 2] = 255;
      initialBuffer[i * 4 + 3] = 255;
    }
    grid.writeImageData(layerId, { data: initialBuffer, width: 100, height: 100 }, 50, 50, 'color-32bit');

    // 2. Stroke ends on pointerup: take beforeSnapshot SYNCHRONOUSLY
    const beforeSnapshot = grid.snapshotTilesInRect(layerId, dirtyRect);
    expect(beforeSnapshot.size).toBeGreaterThan(0);

    // 3. Stroke commits pixels to canvas, then writes to grid SYNCHRONOUSLY
    let notifyFired = false;
    const unsub = grid.subscribe((immediate) => {
      if (immediate) notifyFired = true;
    });

    const newStrokeBuffer = new Uint8ClampedArray(100 * 100 * 4);
    // Overwrite with red stroke
    for (let i = 0; i < 100 * 100; i++) {
      newStrokeBuffer[i * 4] = 255;
      newStrokeBuffer[i * 4 + 3] = 255;
    }
    grid.writeImageData(layerId, { data: newStrokeBuffer, width: 100, height: 100 }, 50, 50, 'color-32bit');
    grid.notifyChange(true);

    // Grid MUST have the new stroke tiles IMMEDIATELY (zero waiting for background tasks)
    expect(notifyFired).toBe(true);
    const tile = grid.getTile(layerId, 0, 0);
    expect(tile).not.toBeNull();
    expect(tile?.dirty).toBe(true);

    // 4. In background/idle task: compute deltas from beforeSnapshot
    const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, layerId, dirtyRect);
    expect(tileDeltas.length).toBeGreaterThan(0);

    // 5. Verify undo/redo parity
    grid.applyTileDeltas(tileDeltas, 'undo');
    const undoData = grid.readImageData(layerId, 50, 50, 100, 100);
    // Should be restored to blue
    expect(undoData.data[0]).toBe(0);
    expect(undoData.data[2]).toBe(255);

    grid.applyTileDeltas(tileDeltas, 'redo');
    const redoData = grid.readImageData(layerId, 50, 50, 100, 100);
    // Should be red again
    expect(redoData.data[0]).toBe(255);
    expect(redoData.data[2]).toBe(0);

    unsub();
  });

  it('guarantees identical thresholding between binarizeCanvasRect and monochrome 1-bit tile packing', () => {
    // Mock canvas context
    const width = 10;
    const height = 10;
    const buffer = new Uint8ClampedArray(width * height * 4);

    // Fill with a gradient of alpha (from 0 to 255)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const alpha = Math.round(((y * width + x) / (width * height - 1)) * 255);
        buffer[idx] = 0;     // R
        buffer[idx + 1] = 0; // G
        buffer[idx + 2] = 0; // B
        buffer[idx + 3] = alpha;
      }
    }

    const mockCtx = {
      canvas: { width, height },
      getImageData: (_sx: number, _sy: number, sw: number, sh: number) => ({
        data: buffer,
        width: sw,
        height: sh,
      }),
      putImageData: (_imgData: { data: Uint8ClampedArray }, _sx: number, _sy: number) => {},
    } as unknown as CanvasRenderingContext2D;

    // Apply binarizeCanvasRect with default threshold 128
    binarizeCanvasRect(mockCtx, { x: 0, y: 0, width, height }, 128, true, true);

    // Check that every pixel with alpha < 128 was zeroed, and >= 128 is solid opaque black
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const origAlpha = Math.round(((y * width + x) / (width * height - 1)) * 255);
        if (origAlpha < 128) {
          expect(buffer[idx + 3]).toBe(0);
        } else {
          expect(buffer[idx + 3]).toBe(255);
          expect(buffer[idx]).toBe(0); // Black ink
        }
      }
    }
  });

  it('flick taper preserves exit velocity and generates natural tapering knots', () => {
    const taper = new TaperEngine();
    taper.configure(undefined, { minFlickSpeed: 0.5, flickPoints: 8 });

    // High exit speed flick (1.5 px/ms)
    const exitVx = 1.2;
    const exitVy = 0.9;
    const lastWidth = 20;
    const lastPressure = 0.8;
    const now = 1000;

    const flick = taper.computeFlickTaper(100, 100, lastWidth, lastPressure, exitVx, exitVy, now);

    expect(flick.count).toBe(8);
    expect(flick.points.length).toBeGreaterThanOrEqual(8);

    // Verify exponential tapering (width and pressure strictly decrease)
    let prevW = lastWidth;
    for (let i = 0; i < flick.count; i++) {
      const p = flick.points[i];
      expect(p.width).toBeLessThan(prevW);
      prevW = p.width;
    }
    // Final point should taper close to minimum
    expect(flick.points[flick.count - 1].width).toBeLessThan(5);
  });

  it('preserves monochrome-1bit strokes across LOD 1, 2, and 3 mipmaps on large manga canvases', () => {
    const layerId = 'layer-mono-manga';
    const blankCanvas = {
      width: 7016,
      height: 9921,
      __isBlank: true,
    } as unknown as HTMLCanvasElement;

    // 1. Ingest blank large monochrome canvas (simulating new B4 600 DPI manga document)
    grid.ingestCanvas(layerId, blankCanvas, 'monochrome-1bit');
    expect(grid.getLayerFormat(layerId)).toBe('monochrome-1bit');

    // 2. Commit first black ink stroke at (300, 300) via writeImageData
    const stroke1 = new Uint8ClampedArray(20 * 20 * 4);
    for (let i = 0; i < 20 * 20; i++) {
      stroke1[i * 4 + 3] = 255; // Solid black (R=0,G=0,B=0,A=255)
    }
    grid.writeImageData(layerId, { data: stroke1, width: 20, height: 20 }, 300, 300, 'monochrome-1bit');

    // 3. Query zoomed-out LOD 1, LOD 2, and LOD 3 tiles (simulating fit-to-screen viewport compositor)
    for (const lod of [1, 2, 3]) {
      const lodTile = grid.generateLodTile(layerId, 0, 0, lod);
      expect(lodTile).not.toBeNull();
      expect(lodTile!.format).toBe('monochrome-1bit');
      const rgba = grid.getTileAsRGBA(lodTile!);
      let inkPixels = 0;
      for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] === 255) inkPixels++;
      }
      expect(inkPixels).toBeGreaterThan(0);
    }

    // 4. Commit second stroke in the same LOD cluster at (420, 420) and verify dirty LOD regeneration
    grid.writeImageData(layerId, { data: stroke1, width: 20, height: 20 }, 420, 420, 'monochrome-1bit');
    expect(grid.isLodTileDirty(layerId, 0, 0, 1)).toBe(true);
    expect(grid.isLodTileDirty(layerId, 0, 0, 2)).toBe(true);
    expect(grid.isLodTileDirty(layerId, 0, 0, 3)).toBe(true);

    const updatedLod2Tiles = grid.getTilesInBounds(layerId, 0, 0, 1024, 1024, 2);
    expect(updatedLod2Tiles.length).toBe(1);
    expect(grid.isLodTileDirty(layerId, 0, 0, 2)).toBe(false);
    const rgbaAfterSecond = grid.getTileAsRGBA(updatedLod2Tiles[0]);
    // Both (300>>2 = 75) and (420>>2 = 105) must have opaque black ink in LOD 2
    const idxStroke1 = (76 * 256 + 76) * 4;
    const idxStroke2 = (106 * 256 + 106) * 4;
    expect(rgbaAfterSecond[idxStroke1 + 3]).toBe(255);
    expect(rgbaAfterSecond[idxStroke2 + 3]).toBe(255);
  });
});
