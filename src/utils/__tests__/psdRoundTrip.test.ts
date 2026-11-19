import { describe, it, expect, afterEach } from 'vitest';
import { writePsd } from 'ag-psd';
import { BlendMode, LayerItem } from '../../types/editor';
import { BLEND_MODES } from '../canvasUtils';
import { mapPsdBlendMode, parsePsdFile } from '../psdParser';
import { serializeDocument, toAgPsdBlendMode } from '../saveManager';
import { SparseTileGrid } from '../tileEngine';

/**
 * Minimal pixel-backed mock canvas for Node/Vitest mask round-trip verification.
 */
function createPixelCanvas(width: number, height: number) {
  let w = width;
  let h = height;
  let pixels = new Uint8ClampedArray(w * h * 4);

  const ctx = {
    createImageData(iw: number, ih: number) {
      return { data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih };
    },
    putImageData(img: { data: Uint8ClampedArray; width: number; height: number }, dx: number, dy: number) {
      for (let y = 0; y < img.height; y++) {
        const ty = dy + y;
        if (ty < 0 || ty >= h) continue;
        for (let x = 0; x < img.width; x++) {
          const tx = dx + x;
          if (tx < 0 || tx >= w) continue;
          const si = (y * img.width + x) * 4;
          const di = (ty * w + tx) * 4;
          pixels[di] = img.data[si];
          pixels[di + 1] = img.data[si + 1];
          pixels[di + 2] = img.data[si + 2];
          pixels[di + 3] = img.data[si + 3];
        }
      }
    },
    getImageData(sx: number, sy: number, sw: number, sh: number) {
      const out = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y++) {
        const py = sy + y;
        if (py < 0 || py >= h) continue;
        for (let x = 0; x < sw; x++) {
          const px = sx + x;
          if (px < 0 || px >= w) continue;
          const si = (py * w + px) * 4;
          const di = (y * sw + x) * 4;
          out[di] = pixels[si];
          out[di + 1] = pixels[si + 1];
          out[di + 2] = pixels[si + 2];
          out[di + 3] = pixels[si + 3];
        }
      }
      return { data: out, width: sw, height: sh };
    },
    clearRect() {
      pixels.fill(0);
    },
    fillRect() {},
    drawImage() {},
  };

  const canvas = {
    get width() {
      return w;
    },
    set width(val: number) {
      w = val;
      pixels = new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4);
    },
    get height() {
      return h;
    },
    set height(val: number) {
      h = val;
      pixels = new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4);
    },
    getContext(type: string) {
      return type === '2d' ? ctx : null;
    },
    toDataURL() {
      return 'data:image/png;base64,MOCK';
    },
  };

  return canvas as unknown as HTMLCanvasElement;
}

describe('PSD/PSB Blend Mode Mapping & Full Round-Trip', () => {
  const prevDocument = (globalThis as Record<string, unknown>).document;

  afterEach(() => {
    if (prevDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = prevDocument;
    }
  });

  it('maps all Photoshop blend modes accurately without lossy substitutions', () => {
    expect(mapPsdBlendMode('linear burn')).toBe('linear-burn');
    expect(mapPsdBlendMode('linear dodge')).toBe('add-glow');
    expect(mapPsdBlendMode('divide')).toBe('divide');
    expect(mapPsdBlendMode('pass through')).toBe('pass-through');
    expect(mapPsdBlendMode('color dodge')).toBe('color-dodge');
    expect(mapPsdBlendMode('color burn')).toBe('color-burn');
    expect(mapPsdBlendMode('exclusion')).toBe('exclusion');
    expect(mapPsdBlendMode('difference')).toBe('difference');
    expect(mapPsdBlendMode('hard light')).toBe('hard-light');
    expect(mapPsdBlendMode('soft light')).toBe('soft-light');
    expect(mapPsdBlendMode('multiply')).toBe('multiply');
    expect(mapPsdBlendMode('screen')).toBe('screen');
    expect(mapPsdBlendMode('overlay')).toBe('overlay');
    expect(mapPsdBlendMode('darken')).toBe('darken');
    expect(mapPsdBlendMode('lighten')).toBe('lighten');
    expect(mapPsdBlendMode('normal')).toBe('normal');

    expect(toAgPsdBlendMode('linear-burn')).toBe('linear burn');
    expect(toAgPsdBlendMode('add-glow')).toBe('linear dodge');
    expect(toAgPsdBlendMode('color-dodge-glow')).toBe('color dodge');
    expect(toAgPsdBlendMode('divide')).toBe('divide');
    expect(toAgPsdBlendMode('pass-through')).toBe('pass through');
  });

  it('round-trips all blend modes through binary PSD export and import', async () => {
    const dims = { width: 32, height: 32, dpi: 300 };
    const tileGrid = new SparseTileGrid();

    const allModes: BlendMode[] = BLEND_MODES.map((m) => m.value);
    const layers: LayerItem[] = allModes.map((mode, idx) => {
      const id = `layer-mode-${idx}`;
      if (mode === 'pass-through') {
        return {
          id,
          name: `Mode ${mode}`,
          type: 'folder',
          visible: true,
          opacity: 1,
          blendMode: mode,
          locked: false,
          parentId: null,
        };
      }
      const px = new Uint8ClampedArray(4 * 4 * 4);
      for (let i = 0; i < px.length; i += 4) {
        px[i] = 100 + idx;
        px[i + 1] = 150;
        px[i + 2] = 200;
        px[i + 3] = 255;
      }
      tileGrid.writeImageData(id, { data: px, width: 4, height: 4 }, 2, 2, 'color-32bit', true);
      return {
        id,
        name: `Mode ${mode}`,
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: mode,
        locked: false,
        parentId: null,
      };
    });

    const exported = await serializeDocument(
      {
        name: 'BlendModes',
        dimensions: dims,
        colorMode: 'color',
        layers,
        layerCanvasesMap: new Map(),
        tileGrid,
        getEffectiveOpacity: (l) => l.opacity,
        isLayerEffectivelyVisible: (l) => l.visible,
      },
      '.psd'
    );

    expect(exported.data).toBeInstanceOf(ArrayBuffer);
    const parsed = await parsePsdFile(exported.data as ArrayBuffer, 'BlendModes.psd');

    // No full-size HTMLCanvasElement map should be retained on PSD import
    expect(parsed.layerCanvases).toBeUndefined();
    expect(parsed.tileGrid).toBeDefined();
    expect(parsed.layers.length).toBe(allModes.length);

    for (let i = 0; i < allModes.length; i++) {
      const origMode = allModes[i];
      const imported = parsed.layers.find((l) => l.name === `Mode ${origMode}`);
      expect(imported).toBeDefined();
      const expectedMode: BlendMode = origMode === 'color-dodge-glow' ? 'color-dodge' : origMode;
      expect(imported!.blendMode).toBe(expectedMode);
    }
  });

  it('round-trips nested folders, frame-folders, clipping, alphaLock vs locked, opacity, masks, and sparse tiles', async () => {
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return createPixelCanvas(1, 1);
        return {};
      },
    };

    const dims = { width: 64, height: 64, dpi: 600 };
    const tileGrid = new SparseTileGrid();

    // Base raster pixels at (10, 12)
    const basePixels = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < basePixels.length; i += 4) {
      basePixels[i] = 220;
      basePixels[i + 1] = 40;
      basePixels[i + 2] = 90;
      basePixels[i + 3] = 255;
    }
    tileGrid.writeImageData('base-raster', { data: basePixels, width: 4, height: 4 }, 10, 12, 'color-32bit', true);

    // Clipped raster pixels
    const clipPixels = new Uint8ClampedArray(2 * 2 * 4);
    clipPixels.set([10, 200, 30, 255, 10, 200, 30, 255, 10, 200, 30, 255, 10, 200, 30, 255]);
    tileGrid.writeImageData('clipped-layer', { data: clipPixels, width: 2, height: 2 }, 10, 12, 'color-32bit', true);

    // Build real grayscale mask for base-raster: top-left 16x16 = 255, rest = 64
    const maskCanvas = createPixelCanvas(dims.width, dims.height);
    const mCtx = maskCanvas.getContext('2d')!;
    const maskImg = mCtx.createImageData(dims.width, dims.height);
    for (let y = 0; y < dims.height; y++) {
      for (let x = 0; x < dims.width; x++) {
        const val = x < 16 && y < 16 ? 255 : 64;
        const idx = (y * dims.width + x) * 4;
        maskImg.data[idx] = val;
        maskImg.data[idx + 1] = val;
        maskImg.data[idx + 2] = val;
        maskImg.data[idx + 3] = 255;
      }
    }
    mCtx.putImageData(maskImg, 0, 0);

    // Disabled & unlinked mask on folder
    const folderMaskCanvas = createPixelCanvas(dims.width, dims.height);
    const fmCtx = folderMaskCanvas.getContext('2d')!;
    const fMaskImg = fmCtx.createImageData(dims.width, dims.height);
    for (let i = 0; i < fMaskImg.data.length; i += 4) {
      fMaskImg.data[i] = 128;
      fMaskImg.data[i + 1] = 128;
      fMaskImg.data[i + 2] = 128;
      fMaskImg.data[i + 3] = 255;
    }
    fmCtx.putImageData(fMaskImg, 0, 0);

    const layers: LayerItem[] = [
      {
        id: 'root-folder',
        name: 'Character Group',
        type: 'folder',
        visible: true,
        opacity: 0.8,
        blendMode: 'pass-through',
        locked: false,
        collapsed: true,
        parentId: null,
        maskCanvas: folderMaskCanvas,
        maskEnabled: false,
        maskLinked: false,
      },
      {
        id: 'clipped-layer',
        name: 'Shadow Clip',
        type: 'raster',
        visible: true,
        opacity: 0.5,
        blendMode: 'linear-burn',
        locked: false,
        alphaLocked: true,
        clipped: true,
        parentId: 'root-folder',
      },
      {
        id: 'base-raster',
        name: 'Base Color',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        alphaLocked: true,
        clipped: false,
        parentId: 'root-folder',
        maskCanvas,
        maskEnabled: true,
        maskLinked: true,
      },
      {
        id: 'panel-frame',
        name: 'Panel 1',
        type: 'frame-folder',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: true,
        alphaLocked: false,
        collapsed: false,
        parentId: null,
      },
      {
        id: 'panel-ink',
        name: 'Panel Ink',
        type: 'raster',
        visible: false,
        opacity: 1,
        blendMode: 'divide',
        locked: true,
        alphaLocked: true,
        parentId: 'panel-frame',
      },
    ];

    // Test both .psd and .psb exports
    for (const ext of ['.psd', '.psb'] as const) {
      const exported = await serializeDocument(
        {
          name: 'MangaPage',
          dimensions: dims,
          colorMode: 'color',
          layers,
          layerCanvasesMap: new Map(),
          tileGrid,
          getEffectiveOpacity: (l) => l.opacity,
          isLayerEffectivelyVisible: (l) => l.visible,
        },
        ext
      );

      const parsed = await parsePsdFile(exported.data as ArrayBuffer, `MangaPage${ext}`);
      expect(parsed.dimensions).toEqual({ width: 64, height: 64, dpi: 600 });
      expect(parsed.layerCanvases).toBeUndefined();
      expect(parsed.tileGrid).toBeDefined();

      const byName = new Map(parsed.layers.map((l) => [l.name, l]));
      expect(parsed.layers.map((l) => l.name)).toEqual([
        'Character Group',
        'Shadow Clip',
        'Base Color',
        'Panel 1',
        'Panel Ink',
      ]);

      const group = byName.get('Character Group')!;
      expect(group.type).toBe('folder');
      expect(group.blendMode).toBe('pass-through');
      expect(group.collapsed).toBe(true);
      expect(group.opacity).toBeCloseTo(0.8, 2);
      expect(group.parentId).toBeNull();
      expect(group.maskCanvas).toBeDefined();
      expect(group.maskEnabled).toBe(false);
      expect(group.maskLinked).toBe(false);
      const groupMaskPx = group.maskCanvas!.getContext('2d')!.getImageData(5, 5, 1, 1).data;
      expect(groupMaskPx[0]).toBe(128);

      const shadow = byName.get('Shadow Clip')!;
      expect(shadow.type).toBe('raster');
      expect(shadow.parentId).toBe(group.id);
      expect(shadow.clipped).toBe(true);
      expect(shadow.alphaLocked).toBe(true);
      expect(shadow.locked).toBe(false); // transparency protection must NOT set full locked!
      expect(shadow.blendMode).toBe('linear-burn');
      expect(shadow.opacity).toBeCloseTo(0.5, 2);

      const base = byName.get('Base Color')!;
      expect(base.parentId).toBe(group.id);
      expect(base.clipped).toBe(false);
      expect(base.alphaLocked).toBe(true);
      expect(base.locked).toBe(false);
      expect(base.maskCanvas).toBeDefined();
      expect(base.maskEnabled).toBe(true);
      expect(base.maskLinked).toBe(true);

      // Verify mask pixel values
      const insideMask = base.maskCanvas!.getContext('2d')!.getImageData(4, 4, 1, 1).data;
      const outsideMask = base.maskCanvas!.getContext('2d')!.getImageData(32, 32, 1, 1).data;
      expect(insideMask[0]).toBe(255);
      expect(outsideMask[0]).toBe(64);

      // Verify raster pixels directly in SparseTileGrid
      const readPx = parsed.tileGrid!.readImageData(base.id, 10, 12, 1, 1).data;
      expect(Array.from(readPx)).toEqual([220, 40, 90, 255]);

      const panel = byName.get('Panel 1')!;
      expect(panel.type).toBe('folder');
      expect(panel.parentId).toBeNull();
      expect(panel.locked).toBe(true);
      expect(panel.alphaLocked).toBe(false);
      expect(panel.collapsed).toBe(false);

      const ink = byName.get('Panel Ink')!;
      expect(ink.parentId).toBe(panel.id);
      expect(ink.visible).toBe(false);
      expect(ink.blendMode).toBe('divide');
      expect(ink.locked).toBe(true);
      expect(ink.alphaLocked).toBe(true);
    }
  });

  it('imports partial-bounds PSD mask with defaultColor and loads sparse tiles without canvas allocation', async () => {
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return createPixelCanvas(1, 1);
        return {};
      },
    };

    const maskData = new Uint8ClampedArray(10 * 10 * 4);
    for (let i = 0; i < maskData.length; i += 4) {
      maskData[i] = 200;
      maskData[i + 1] = 200;
      maskData[i + 2] = 200;
      maskData[i + 3] = 255;
    }

    const layerData = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < layerData.length; i += 4) {
      layerData[i] = 33;
      layerData[i + 1] = 66;
      layerData[i + 2] = 99;
      layerData[i + 3] = 255;
    }

    const buffer = writePsd({
      width: 600,
      height: 600,
      children: [
        {
          name: 'SparseOffset',
          left: 300,
          top: 300,
          right: 308,
          bottom: 308,
          blendMode: 'linear dodge',
          clipping: true,
          protected: { transparency: true },
          imageData: { data: layerData, width: 8, height: 8 },
          mask: {
            left: 20,
            top: 20,
            right: 30,
            bottom: 30,
            defaultColor: 0,
            imageData: { data: maskData, width: 10, height: 10 },
          },
        },
      ],
    });

    const parsed = await parsePsdFile(buffer, 'SparseOffset.psd');
    expect(parsed.layerCanvases).toBeUndefined();
    const layer = parsed.layers[0];
    expect(layer.blendMode).toBe('add-glow');
    expect(layer.clipped).toBe(true);
    expect(layer.alphaLocked).toBe(true);
    expect(layer.locked).toBe(false);

    // Only the single tile (1, 1) covering (300..308, 300..308) should be allocated
    const tiles = parsed.tileGrid!.getLayerTiles(layer.id, 0);
    expect(tiles.length).toBe(1);
    expect(tiles[0].tileX).toBe(1);
    expect(tiles[0].tileY).toBe(1);

    const sampled = parsed.tileGrid!.readImageData(layer.id, 302, 302, 1, 1).data;
    expect(Array.from(sampled)).toEqual([33, 66, 99, 255]);

    // Verify partial mask composited with defaultColor=0 outside [20..30, 20..30]
    expect(layer.maskCanvas).toBeDefined();
    const mCtx = layer.maskCanvas!.getContext('2d')!;
    expect(mCtx.getImageData(25, 25, 1, 1).data[0]).toBe(200);
    expect(mCtx.getImageData(5, 5, 1, 1).data[0]).toBe(0);
  });
});
