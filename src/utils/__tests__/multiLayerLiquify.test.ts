import { describe, it, expect } from 'vitest';
import { LayerItem } from '../../types/editor';
import {
  LiquifyWarpField,
  resampleLayerFromWarpField,
  resolveLiquifyTargetLayers,
} from '../liquifyEngine';
import { SparseTileGrid, TileSnapshotEntry } from '../tileEngine';

function makeLayer(overrides: Partial<LayerItem> & { id: string }): LayerItem {
  return {
    name: overrides.id,
    type: 'raster',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    locked: false,
    parentId: null,
    ...overrides,
  };
}

describe('Multi-layer Liquify target resolution', () => {
  const folder = makeLayer({ id: 'folder-1', type: 'folder' });
  const lockedFolder = makeLayer({ id: 'folder-locked', type: 'folder', locked: true });
  const l1 = makeLayer({ id: 'layer-1', parentId: 'folder-1' });
  const l2 = makeLayer({ id: 'layer-2', parentId: 'folder-1' });
  const l3 = makeLayer({ id: 'layer-3' });
  const lHidden = makeLayer({ id: 'layer-hidden', visible: false });
  const lLocked = makeLayer({ id: 'layer-locked', locked: true });
  const lInLockedFolder = makeLayer({ id: 'layer-in-locked', parentId: 'folder-locked' });
  const lBg = makeLayer({ id: 'layer-bg', locked: true });
  const lText = makeLayer({ id: 'layer-text', type: 'text' });

  const allLayers = [
    folder,
    l1,
    l2,
    lockedFolder,
    lInLockedFolder,
    l3,
    lHidden,
    lLocked,
    lText,
    lBg,
  ];
  const isVisible = (l: LayerItem) => l.visible;

  it('targets only the active layer when multiLayer is false', () => {
    const res = resolveLiquifyTargetLayers(allLayers, l1, ['layer-1', 'layer-2'], isVisible, false);
    expect(res.map((l) => l.id)).toEqual(['layer-1']);

    const lockedRes = resolveLiquifyTargetLayers(allLayers, lLocked, [], isVisible, false);
    expect(lockedRes).toEqual([]);
  });

  it('targets all visible unlocked raster layers when multiLayer is true and single layer is active', () => {
    const res = resolveLiquifyTargetLayers(allLayers, l1, ['layer-1'], isVisible, true);
    expect(res.map((l) => l.id)).toEqual(['layer-1', 'layer-2', 'layer-3']);
  });

  it('targets only visible unlocked descendants when active layer is a folder in multi-layer mode', () => {
    const res = resolveLiquifyTargetLayers(allLayers, folder, ['folder-1'], isVisible, true);
    expect(res.map((l) => l.id)).toEqual(['layer-1', 'layer-2']);
  });

  it('targets explicitly multi-selected layers (expanding selected folders) in multi-layer mode', () => {
    const res = resolveLiquifyTargetLayers(
      allLayers,
      l1,
      ['layer-1', 'layer-3', 'layer-locked'],
      isVisible,
      true
    );
    expect(res.map((l) => l.id)).toEqual(['layer-1', 'layer-3']);

    const folderMulti = resolveLiquifyTargetLayers(
      allLayers,
      folder,
      ['folder-1', 'layer-3'],
      isVisible,
      true
    );
    expect(folderMulti.map((l) => l.id)).toEqual(['layer-1', 'layer-2', 'layer-3']);
  });
});

describe('LiquifyWarpField quality (zero dark fringes, single-pass bicubic, exact reconstruct)', () => {
  const dims = { width: 320, height: 320 };

  it('preserves pure brush/smudge RGB on semi-transparent edges with zero black alpha fringing', () => {
    const grid = new SparseTileGrid();
    // Bright yellow stroke (255, 220, 60, 255) on transparent background (0, 0, 0, 0)
    const barW = 12;
    const barH = 40;
    const data = new Uint8ClampedArray(barW * barH * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 220;
      data[i + 2] = 60;
      data[i + 3] = 255;
    }
    grid.writeImageData('brush', { data, width: barW, height: barH }, 100, 100, 'color-32bit');

    const warpField = new LiquifyWarpField();
    const beforeSnap = new Map<string, TileSnapshotEntry>();
    const origCache = new Map<number, Uint8ClampedArray | null>();

    // Push across 12 sub-steps (would severely blur and darken edges with iterative straight-alpha bilinear)
    const steps = [];
    for (let i = 0; i < 12; i++) {
      steps.push({ cx: 106 + (i + 1) * 2.3, cy: 120, prevX: 106 + i * 2.3, prevY: 120, pressure: 1 });
    }
    const dirty = warpField.applySubSteps(steps, dims, {
      mode: 'push',
      size: 60,
      strength: 80,
      hardness: 70,
      usePressure: false,
    });
    expect(dirty).not.toBeNull();

    resampleLayerFromWarpField({
      grid,
      layerId: 'brush',
      dimensions: dims,
      targetFormat: 'color-32bit',
      warpField,
      dirtyRect: dirty!,
      beforeTileSnapshot: beforeSnap,
      origRgbaCache: origCache,
    });

    // Check every semi-transparent edge pixel produced by the warp: RGB must stay pure yellow (no black mixing)
    let semiTransparentChecked = 0;
    let maxCoreAlpha = 0;
    for (let x = dirty!.x; x < dirty!.x + dirty!.width; x++) {
      const [r, g, b, a] = grid.getPixelRGBA('brush', x, 120);
      if (a > maxCoreAlpha) maxCoreAlpha = a;
      if (a > 10 && a < 245) {
        semiTransparentChecked++;
        expect(r).toBeGreaterThanOrEqual(250);
        expect(g).toBeGreaterThanOrEqual(215);
        expect(b).toBeGreaterThanOrEqual(55);
        expect(b).toBeLessThanOrEqual(65);
      }
    }
    expect(semiTransparentChecked).toBeGreaterThan(0);
    expect(maxCoreAlpha).toBe(255);
  });

  it('reconstructs warped pixels back to exact original state across strokes without ghosting', () => {
    const grid = new SparseTileGrid();
    // Crisp 4px vertical cyan line straddling tile boundary x=254..257
    const w = 4;
    const h = 40;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 40;
      data[i + 1] = 210;
      data[i + 2] = 240;
      data[i + 3] = 255;
    }
    grid.writeImageData('line', { data, width: w, height: h }, 254, 140, 'color-32bit');

    const warpField = new LiquifyWarpField();
    const origCache = new Map<number, Uint8ClampedArray | null>();

    // Stroke 1: push right by 2 steps (4px line at 254..257 shifts right into x >= 262)
    const snap1 = new Map<string, TileSnapshotEntry>();
    const dirty1 = warpField.applySubSteps(
      [
        { cx: 260, cy: 160, prevX: 254, prevY: 160, pressure: 1 },
        { cx: 266, cy: 160, prevX: 260, prevY: 160, pressure: 1 },
      ],
      dims,
      { mode: 'push', size: 64, strength: 100, hardness: 80, usePressure: false }
    );
    expect(dirty1).not.toBeNull();
    resampleLayerFromWarpField({
      grid,
      layerId: 'line',
      dimensions: dims,
      targetFormat: 'color-32bit',
      warpField,
      dirtyRect: dirty1!,
      beforeTileSnapshot: snap1,
      origRgbaCache: origCache,
    });
    let shiftedMaxAlpha = 0;
    for (let x = 262; x <= 275; x++) {
      shiftedMaxAlpha = Math.max(shiftedMaxAlpha, grid.getPixelRGBA('line', x, 160)[3]);
    }
    expect(shiftedMaxAlpha).toBeGreaterThan(200);

    // Stroke 2: reconstruct relaxes displacement field back to 0 -> exact original pixels restored
    const snap2 = new Map<string, TileSnapshotEntry>();
    const reconSteps = Array.from({ length: 30 }, () => ({
      cx: 260,
      cy: 160,
      prevX: 260,
      prevY: 160,
      pressure: 1,
    }));
    const dirty2 = warpField.applySubSteps(reconSteps, dims, {
      mode: 'reconstruct',
      size: 120,
      strength: 100,
      hardness: 100,
      usePressure: false,
    });
    expect(dirty2).not.toBeNull();
    resampleLayerFromWarpField({
      grid,
      layerId: 'line',
      dimensions: dims,
      targetFormat: 'color-32bit',
      warpField,
      dirtyRect: dirty2!,
      beforeTileSnapshot: snap2,
      origRgbaCache: origCache,
    });

    expect(grid.getPixelRGBA('line', 255, 160)).toEqual([40, 210, 240, 255]);
    for (let x = 262; x <= 275; x++) {
      expect(grid.getPixelRGBA('line', x, 160)[3]).toBe(0);
    }
  });
});
