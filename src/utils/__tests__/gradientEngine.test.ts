import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GRADIENT_SETTINGS,
  constrainGradientEndpoint,
  createDefaultGradientMesh,
  rasterizeMeshGradientToRgba,
  renderGradientToTileGrid,
  resolveGradientStops,
  sampleGradientStops,
} from '../gradientEngine';
import { SparseTileGrid } from '../tileEngine';

describe('Gradient Engine (Linear / Radial / Mesh)', () => {
  it('interpolates multi-stop RGBA colors with clamp, repeat, reflect, and reverse', () => {
    const stops = resolveGradientStops(
      {
        ...DEFAULT_GRADIENT_SETTINGS,
        useForegroundBackground: false,
        stops: [
          { id: 'a', offset: 0, color: '#000000', opacity: 1 },
          { id: 'b', offset: 1, color: '#ffffff', opacity: 0.5 },
        ],
      },
      '#ff0000',
      '#00ff00'
    );

    const out: [number, number, number, number] = [0, 0, 0, 0];
    sampleGradientStops(stops, 0.5, 'clamp', false, out);
    expect(out[0]).toBeCloseTo(127.5, 1);
    expect(out[3]).toBeCloseTo(191.25, 1);

    // Clamp outside [0,1]
    sampleGradientStops(stops, 1.5, 'clamp', false, out);
    expect(out[0]).toBe(255);

    // Repeat wraps 1.25 -> 0.25
    sampleGradientStops(stops, 1.25, 'repeat', false, out);
    expect(out[0]).toBeCloseTo(63.75, 1);

    // Reflect bounces 1.25 -> 0.75
    sampleGradientStops(stops, 1.25, 'reflect', false, out);
    expect(out[0]).toBeCloseTo(191.25, 1);

    // Reverse inverts t
    sampleGradientStops(stops, 0.25, 'clamp', true, out);
    expect(out[0]).toBeCloseTo(191.25, 1);
  });

  it('snaps gradient endpoints to 15-degree increments when constrained', () => {
    const snapped = constrainGradientEndpoint({ x: 0, y: 0 }, { x: 100, y: 12 });
    expect(Math.atan2(snapped.y, snapped.x)).toBeCloseTo(0, 5);
    expect(Math.hypot(snapped.x, snapped.y)).toBeCloseTo(Math.hypot(100, 12), 4);
  });

  it('renders linear gradient into SparseTileGrid respecting selection mask and undo tileDeltas', () => {
    const grid = new SparseTileGrid();
    const dims = { width: 128, height: 128 };
    const layerId = 'layer-grad';

    const res = renderGradientToTileGrid({
      grid,
      layerId,
      dimensions: dims,
      targetFormat: 'color-32bit',
      settings: {
        ...DEFAULT_GRADIENT_SETTINGS,
        type: 'linear',
        dither: false,
        useForegroundBackground: true,
      },
      primaryColor: '#ff0000',
      secondaryColor: '#0000ff',
      start: { x: 10, y: 50 },
      end: { x: 110, y: 50 },
      selection: {
        type: 'rect',
        bounds: { x: 20, y: 20, width: 80, height: 80 },
      },
    });

    expect(res.modified).toBe(true);
    expect(res.tileDeltas.length).toBeGreaterThan(0);

    // Outside selection must stay transparent
    expect(grid.getPixelRGBA(layerId, 5, 5)[3]).toBe(0);

    // Inside selection: left side reddish, right side bluish
    const leftPx = grid.getPixelRGBA(layerId, 22, 50);
    const rightPx = grid.getPixelRGBA(layerId, 98, 50);
    expect(leftPx[0]).toBeGreaterThan(200);
    expect(leftPx[2]).toBeLessThan(60);
    expect(rightPx[2]).toBeGreaterThan(200);
    expect(rightPx[0]).toBeLessThan(60);

    // Undo restores clean empty layer
    grid.applyTileDeltas(res.tileDeltas, 'undo');
    expect(grid.getPixelRGBA(layerId, 50, 50)[3]).toBe(0);
  });

  it('renders radial gradient centered at start with radius to end and respects alphaLock', () => {
    const grid = new SparseTileGrid();
    const dims = { width: 100, height: 100 };
    const layerId = 'layer-rad';
    // Paint an opaque 40x40 square at (30,30)
    const sq = new Uint8ClampedArray(40 * 40 * 4);
    for (let i = 0; i < sq.length; i += 4) {
      sq[i] = 128;
      sq[i + 1] = 128;
      sq[i + 2] = 128;
      sq[i + 3] = 255;
    }
    grid.writeImageData(layerId, { data: sq, width: 40, height: 40 }, 30, 30, 'color-32bit', true);

    const res = renderGradientToTileGrid({
      grid,
      layerId,
      dimensions: dims,
      targetFormat: 'color-32bit',
      settings: {
        ...DEFAULT_GRADIENT_SETTINGS,
        type: 'radial',
        dither: false,
        useForegroundBackground: true,
      },
      primaryColor: '#ffffff',
      secondaryColor: '#000000',
      start: { x: 50, y: 50 },
      end: { x: 70, y: 50 },
      alphaLock: true,
    });

    expect(res.modified).toBe(true);
    // Transparent pixel outside opaque square stays transparent under alphaLock
    expect(grid.getPixelRGBA(layerId, 10, 10)[3]).toBe(0);
    // Center is bright white, outer edge of circle is dark
    expect(grid.getPixelRGBA(layerId, 50, 50)[0]).toBeGreaterThan(230);
    expect(grid.getPixelRGBA(layerId, 69, 50)[0]).toBeLessThan(35);
  });

  it('renders bicubic Mesh Gradient with displaced nodes cleanly into RGBA and SparseTileGrid', () => {
    const mesh = createDefaultGradientMesh(
      { x: 0, y: 0, width: 64, height: 64 },
      3,
      3,
      '#ff0000',
      '#00ff00'
    );
    // Override corners for deterministic verification
    mesh.nodes[0].color = '#ff0000';
    mesh.nodes[2].color = '#00ff00';
    mesh.nodes[6].color = '#0000ff';
    mesh.nodes[8].color = '#ffff00';
    // Displace center node
    mesh.nodes[4].x = 40;
    mesh.nodes[4].y = 40;
    mesh.nodes[4].color = '#ffffff';

    const buf = rasterizeMeshGradientToRgba(mesh, 0, 0, 64, 64, 1, 1, false, 6);
    // Top-left pixel near red
    expect(buf[(2 * 64 + 2) * 4]).toBeGreaterThan(200);
    expect(buf[(2 * 64 + 2) * 4 + 3]).toBe(255);
    // Displaced center node pixel near white
    const cOff = (40 * 64 + 40) * 4;
    expect(buf[cOff]).toBeGreaterThan(220);
    expect(buf[cOff + 1]).toBeGreaterThan(220);
    expect(buf[cOff + 2]).toBeGreaterThan(220);

    // Commit to tile grid
    const grid = new SparseTileGrid();
    const res = renderGradientToTileGrid({
      grid,
      layerId: 'layer-mesh',
      dimensions: { width: 64, height: 64 },
      targetFormat: 'color-32bit',
      settings: { ...DEFAULT_GRADIENT_SETTINGS, type: 'mesh', dither: false },
      primaryColor: '#000000',
      secondaryColor: '#ffffff',
      mesh,
    });
    expect(res.modified).toBe(true);
    expect(grid.getPixelRGBA('layer-mesh', 40, 40)[0]).toBeGreaterThan(220);
  });
});
