import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RETOUCH_SETTINGS,
  applyRetouchStrokeSegment,
  computeBrushFalloff,
  createRetouchStrokeSession,
} from '../retouchEngine';
import { SparseTileGrid } from '../tileEngine';

function fillRectRgba(
  grid: SparseTileGrid,
  layerId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a: number
): void {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  grid.writeImageData(layerId, { data, width: w, height: h }, x, y, 'color-32bit', true);
}

describe('Retouch Engine (Smudge / Blur / Dodge / Burn / Clone Stamp)', () => {
  it('computes smooth radial brush falloff respecting hardness', () => {
    expect(computeBrushFalloff(0, 0.5)).toBe(1);
    expect(computeBrushFalloff(0.4, 0.5)).toBe(1);
    expect(computeBrushFalloff(1.0, 0.5)).toBe(0);
    const mid = computeBrushFalloff(0.75, 0.5);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
  });

  it('Smudge drags pigment into adjacent pixels without dark alpha fringes', () => {
    const grid = new SparseTileGrid();
    const dims = { width: 128, height: 128 };
    const layerId = 'layer-smudge';
    fillRectRgba(grid, layerId, 10, 30, 30, 40, 255, 0, 0, 255);

    const session = createRetouchStrokeSession({
      mode: 'smudge',
      layerId,
      targetFormat: 'color-32bit',
      alphaLock: false,
      dimensions: dims,
      selectionMask: null,
    });
    const settings = {
      ...DEFAULT_RETOUCH_SETTINGS,
      mode: 'smudge' as const,
      size: 20,
      strength: 85,
      hardness: 80,
      usePressure: false,
    };

    applyRetouchStrokeSegment({ grid, session, pt: { x: 25, y: 50 }, pressure: 1, settings, primaryColor: '#000000' });
    applyRetouchStrokeSegment({ grid, session, pt: { x: 52, y: 50 }, pressure: 1, settings, primaryColor: '#000000' });

    // Smudged pigment should appear past x=40 with pure red hue (no black fringe)
    const smudged = grid.getPixelRGBA(layerId, 46, 50);
    expect(smudged[3]).toBeGreaterThan(40);
    expect(smudged[0]).toBeGreaterThan(220);
    expect(smudged[1]).toBeLessThan(15);
    expect(smudged[2]).toBeLessThan(15);

    // Undoable tile deltas restore original state
    const deltas = grid.computeDeltasFromSnapshot(session.beforeSnapshot, layerId, session.dirtyRect!);
    expect(deltas.length).toBeGreaterThan(0);
    grid.applyTileDeltas(deltas, 'undo');
    expect(grid.getPixelRGBA(layerId, 46, 50)[3]).toBe(0);
  });

  it('Blur softens sharp color transitions via separable premultiplied pass', () => {
    const grid = new SparseTileGrid();
    const dims = { width: 100, height: 100 };
    const layerId = 'layer-blur';
    fillRectRgba(grid, layerId, 0, 0, 50, 100, 0, 0, 0, 255);
    fillRectRgba(grid, layerId, 50, 0, 50, 100, 255, 255, 255, 255);

    const session = createRetouchStrokeSession({
      mode: 'blur',
      layerId,
      targetFormat: 'color-32bit',
      alphaLock: false,
      dimensions: dims,
      selectionMask: null,
    });
    const settings = {
      ...DEFAULT_RETOUCH_SETTINGS,
      mode: 'blur' as const,
      size: 30,
      strength: 100,
      hardness: 100,
      usePressure: false,
    };

    applyRetouchStrokeSegment({ grid, session, pt: { x: 50, y: 50 }, pressure: 1, settings, primaryColor: '#000000' });

    const edgeLeft = grid.getPixelRGBA(layerId, 49, 50)[0];
    const edgeRight = grid.getPixelRGBA(layerId, 50, 50)[0];
    expect(edgeLeft).toBeGreaterThan(30);
    expect(edgeRight).toBeLessThan(225);
  });

  it('Dodge lightens and Burn darkens pixels while respecting tonal range and transparency', () => {
    const grid = new SparseTileGrid();
    const dims = { width: 100, height: 100 };
    const layerId = 'layer-db';
    fillRectRgba(grid, layerId, 20, 20, 60, 60, 120, 100, 80, 255);

    const dodgeSession = createRetouchStrokeSession({
      mode: 'dodge',
      layerId,
      targetFormat: 'color-32bit',
      alphaLock: false,
      dimensions: dims,
      selectionMask: null,
    });
    applyRetouchStrokeSegment({
      grid,
      session: dodgeSession,
      pt: { x: 40, y: 50 },
      pressure: 1,
      settings: {
        ...DEFAULT_RETOUCH_SETTINGS,
        mode: 'dodge',
        size: 20,
        strength: 80,
        hardness: 100,
        tonalRange: 'midtones',
        usePressure: false,
      },
      primaryColor: '#000000',
    });

    const dodged = grid.getPixelRGBA(layerId, 40, 50);
    expect(dodged[0]).toBeGreaterThan(135);
    expect(dodged[1]).toBeGreaterThan(110);

    const burnSession = createRetouchStrokeSession({
      mode: 'burn',
      layerId,
      targetFormat: 'color-32bit',
      alphaLock: false,
      dimensions: dims,
      selectionMask: null,
    });
    applyRetouchStrokeSegment({
      grid,
      session: burnSession,
      pt: { x: 65, y: 50 },
      pressure: 1,
      settings: {
        ...DEFAULT_RETOUCH_SETTINGS,
        mode: 'burn',
        size: 20,
        strength: 80,
        hardness: 100,
        tonalRange: 'midtones',
        usePressure: false,
      },
      primaryColor: '#000000',
    });

    const burned = grid.getPixelRGBA(layerId, 65, 50);
    expect(burned[0]).toBeLessThan(105);
    // Transparent region stays untouched
    expect(grid.getPixelRGBA(layerId, 5, 5)[3]).toBe(0);
  });

  it('Clone Stamp copies pixels cleanly from offset source anchor without self-feedback', () => {
    const grid = new SparseTileGrid();
    const dims = { width: 128, height: 128 };
    const layerId = 'layer-clone';
    fillRectRgba(grid, layerId, 10, 10, 24, 24, 30, 210, 90, 255);

    const session = createRetouchStrokeSession({
      mode: 'clone-stamp',
      layerId,
      targetFormat: 'color-32bit',
      alphaLock: false,
      dimensions: dims,
      selectionMask: null,
      // Source (22,22) -> Dest (80,80) => offset (-58, -58)
      cloneOffset: { x: -58, y: -58 },
    });

    applyRetouchStrokeSegment({
      grid,
      session,
      pt: { x: 80, y: 80 },
      pressure: 1,
      settings: {
        ...DEFAULT_RETOUCH_SETTINGS,
        mode: 'clone-stamp',
        size: 20,
        strength: 100,
        hardness: 100,
        usePressure: false,
      },
      primaryColor: '#000000',
    });

    const cloned = grid.getPixelRGBA(layerId, 80, 80);
    expect(cloned[0]).toBe(30);
    expect(cloned[1]).toBe(210);
    expect(cloned[2]).toBe(90);
    expect(cloned[3]).toBe(255);
  });
});
