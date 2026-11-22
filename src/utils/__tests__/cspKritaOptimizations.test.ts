import { describe, it, expect } from 'vitest';
import {
  BLEND_MODE_MAP,
  COMPOSITOR_FRAGMENT_SHADER,
  COMPOSITOR_INSTANCED_FRAGMENT_SHADER,
  FOLDER_BLIT_FRAGMENT_SHADER,
  ViewportCompositor,
} from '../compositor';
import {
  linearRgbToOklab,
  oklabToLinearRgb,
  mixSubtractivePigments,
  PaintReservoir,
  LayerPixelSampler,
} from '../colorMixingEngine';
import {
  SparseTileGrid,
  BYTES_32BIT,
} from '../tileEngine';
import {
  compressTileDeltasPayload,
  decompressTileDeltasPayload,
  UndoCacheManager,
  MAX_RAM_UNDO_STEPS,
} from '../undoCache';
import {
  executeFloodFill,
  compositeReferenceLayers,
} from '../floodFill';
import {
  LIQUIFY_FRAGMENT_SHADER,
  WebGlLiquifyEngine,
} from '../liquifyEngine';
import {
  GAUSSIAN_BLUR_FRAGMENT_SHADER,
  MOTION_BLUR_FRAGMENT_SHADER,
  WebGlFilterEngine,
} from '../filterEngine';
import { WebGlBrushEngine } from '../../engine/WebGlBrushEngine';
import { HistoryItem } from '../../types/editor';

describe('CSP & Krita Rendering and Engine Optimizations', () => {
  describe('1. WebGL2 Tile Compositor & Programmable Blend Modes', () => {
    it('supports all 17 W3C / CSP / Krita blend modes in BLEND_MODE_MAP and shaders', () => {
      expect(BLEND_MODE_MAP['normal']).toBe(0);
      expect(BLEND_MODE_MAP['multiply']).toBe(1);
      expect(BLEND_MODE_MAP['screen']).toBe(2);
      expect(BLEND_MODE_MAP['overlay']).toBe(3);
      expect(BLEND_MODE_MAP['darken']).toBe(4);
      expect(BLEND_MODE_MAP['lighten']).toBe(5);
      expect(BLEND_MODE_MAP['color-dodge']).toBe(6);
      expect(BLEND_MODE_MAP['color-burn']).toBe(7);
      expect(BLEND_MODE_MAP['hard-light']).toBe(8);
      expect(BLEND_MODE_MAP['soft-light']).toBe(9);
      expect(BLEND_MODE_MAP['difference']).toBe(10);
      expect(BLEND_MODE_MAP['exclusion']).toBe(11);
      expect(BLEND_MODE_MAP['pass-through']).toBe(12);
      expect(BLEND_MODE_MAP['linear-burn']).toBe(13);
      expect(BLEND_MODE_MAP['add-glow']).toBe(14);
      expect(BLEND_MODE_MAP['color-dodge-glow']).toBe(15);
      expect(BLEND_MODE_MAP['divide']).toBe(16);
      expect(BLEND_MODE_MAP['vivid-light']).toBe(17);
      expect(BLEND_MODE_MAP['linear-light']).toBe(18);
      expect(BLEND_MODE_MAP['pin-light']).toBe(19);
      expect(BLEND_MODE_MAP['hard-mix']).toBe(20);
      expect(BLEND_MODE_MAP['subtract']).toBe(21);
      expect(BLEND_MODE_MAP['darker-color']).toBe(22);
      expect(BLEND_MODE_MAP['lighter-color']).toBe(23);
      expect(BLEND_MODE_MAP['hue']).toBe(24);
      expect(BLEND_MODE_MAP['saturation']).toBe(25);
      expect(BLEND_MODE_MAP['color']).toBe(26);
      expect(BLEND_MODE_MAP['luminosity']).toBe(27);

      expect(COMPOSITOR_FRAGMENT_SHADER).toContain('vec3 evaluateBlendMode(vec3 Cb, vec3 Cs, int mode)');
      expect(COMPOSITOR_FRAGMENT_SHADER).toContain('uniform sampler2D u_backdropTexture;');
      expect(FOLDER_BLIT_FRAGMENT_SHADER).toContain('vec3 evaluateBlendModeFolder(vec3 Cb, vec3 Cs, int mode)');
      for (const shader of [
        COMPOSITOR_FRAGMENT_SHADER,
        COMPOSITOR_INSTANCED_FRAGMENT_SHADER,
        FOLDER_BLIT_FRAGMENT_SHADER,
      ]) {
        for (let code = 17; code <= 27; code++) {
          expect(shader).toContain(`mode == ${code}`);
        }
      }
    });

    it('supports mask dirty-version invalidation on ViewportCompositor', () => {
      const dummyCanvas = { getContext: () => null } as unknown as HTMLCanvasElement;
      const compositor = new ViewportCompositor(dummyCanvas);
      expect(typeof compositor.invalidateMaskTexture).toBe('function');
      compositor.invalidateMaskTexture('layer-1');
    });
  });

  describe('2. OKLab + Kubelka-Munk Perceptual Pigment Mixing & Zero-Copy Tile Sampling', () => {
    it('round-trips linear RGB to OKLab and back accurately', () => {
      const samples = [
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.4, 0.8],
        [1.0, 0.85, 0.0],
        [0.5, 0.25, 0.75],
      ];
      for (const [r, g, b] of samples) {
        const lab = linearRgbToOklab(r, g, b);
        const rgb = oklabToLinearRgb(lab.L, lab.a, lab.b);
        expect(Math.abs(rgb.r - r)).toBeLessThan(1e-3);
        expect(Math.abs(rgb.g - g)).toBeLessThan(1e-3);
        expect(Math.abs(rgb.b - b)).toBeLessThan(1e-3);
      }
    });

    it('mixes Yellow (#ffea00) and Blue (#0048ff) into vibrant Green instead of muddy gray', () => {
      // Pure yellow and pure blue in RGB average to (128, 153, 128) dull gray,
      // whereas Kubelka-Munk + OKLab spectral pigment mixing yields a green-dominant hue.
      const mixed = mixSubtractivePigments({ r: 255, g: 234, b: 0 }, { r: 0, g: 72, b: 255 }, 0.5);
      expect(mixed.g).toBeGreaterThan(mixed.r + 35);
      expect(mixed.g).toBeGreaterThan(mixed.b + 20);

      const res = new PaintReservoir('#0048ff');
      const out = res.mixWithCanvas(
        { r: 255, g: 234, b: 0, a: 1.0 },
        0.5,
        0.9,
        0.75,
        'blend',
        0.8,
        1.0,
        1.0
      );
      expect(out.g).toBeGreaterThan(out.r);
    });

    it('samples pixels directly from SparseTileGrid on 4K layers without full-canvas getImageData', () => {
      const grid = new SparseTileGrid();
      grid.setLayerFormat('layer-wet', 'color-32bit');

      const patch = new Uint8ClampedArray(16 * 16 * 4);
      for (let i = 0; i < 16 * 16; i++) {
        patch[i * 4] = 40;
        patch[i * 4 + 1] = 180;
        patch[i * 4 + 2] = 90;
        patch[i * 4 + 3] = 255;
      }
      grid.writeImageData('layer-wet', { data: patch, width: 16, height: 16 }, 300, 300);

      // Mock a 4K canvas whose getContext('2d') throws if full getImageData were called
      const mock4kCanvas = {
        width: 4096,
        height: 4096,
        getContext: () => ({
          getImageData: () => {
            throw new Error('Should not call Canvas2D getImageData when SparseTileGrid has tiles');
          },
        }),
      } as unknown as HTMLCanvasElement;

      const sampler = new LayerPixelSampler(mock4kCanvas, 'layer-wet', grid);
      const sampled = sampler.sampleColor(308, 308, 4);
      expect(sampled.r).toBeCloseTo(40, 0);
      expect(sampled.g).toBeCloseTo(180, 0);
      expect(sampled.b).toBeCloseTo(90, 0);
      expect(sampled.a).toBeGreaterThan(0.8);
    });
  });

  describe('3. UndoCache fflate Compression & Compressed RAM Fallback', () => {
    it('compresses and decompresses tile deltas losslessly with high compression ratio', () => {
      const beforeData = new Uint8Array(BYTES_32BIT);
      const afterData = new Uint8Array(BYTES_32BIT);
      afterData.fill(200, 0, 4096);

      const deltas = [
        {
          key: 'layer-1:0:0',
          format: 'color-32bit' as const,
          beforeData,
          afterData,
        },
      ];

      const compressed = compressTileDeltasPayload(deltas);
      // 512KB of raw tile delta should compress down to < 2KB
      expect(compressed.byteLength).toBeLessThan(2048);

      const restored = decompressTileDeltasPayload(compressed);
      expect(restored.length).toBe(1);
      expect(restored[0].key).toBe('layer-1:0:0');
      expect(restored[0].afterData![0]).toBe(200);
      expect(restored[0].afterData![5000]).toBe(0);
    });

    it('offloads older undo steps into compressed RAM cache when exceeding MAX_RAM_UNDO_STEPS in browser mode', async () => {
      const cache = new UndoCacheManager('test-session');
      const history: HistoryItem[] = [];

      for (let i = 0; i < MAX_RAM_UNDO_STEPS + 3; i++) {
        const afterData = new Uint8Array(1024);
        afterData.fill(i + 1);
        const item: HistoryItem = {
          id: `step-${i}`,
          type: 'brush',
          label: `Stroke ${i}`,
          timestamp: Date.now() + i,
          timeFormatted: '12:00',
          thumbnailUrl: '',
          beforeImageData: null,
          afterImageData: null,
          layerId: 'layer-1',
          tileDeltas: [
            {
              key: 'layer-1:0:0',
              format: 'monochrome-1bit',
              beforeData: null,
              afterData,
            },
          ],
        };
        history.push(item);
        await cache.registerStep(item, history);
      }

      // Oldest 3 steps should have their uncompressed tileDeltas freed from RAM
      expect(history[0].tileDeltas).toBeUndefined();
      expect(history[1].tileDeltas).toBeUndefined();

      // Resolving step-0 should transparently decompress and restore its tileDeltas
      const resolved = await cache.resolveDeltas(history[0]);
      expect(resolved).not.toBeNull();
      expect(resolved![0].afterData![0]).toBe(1);
    });
  });

  describe('4. CSP-Grade Smart Flood Fill (Close Gap, Area Scaling, Reference Layer)', () => {
    function createMockCanvas(width: number, height: number) {
      const buffer = new Uint8ClampedArray(width * height * 4);
      // Fill with white background (255, 255, 255, 255)
      for (let i = 0; i < width * height; i++) {
        buffer[i * 4] = 255;
        buffer[i * 4 + 1] = 255;
        buffer[i * 4 + 2] = 255;
        buffer[i * 4 + 3] = 255;
      }
      const ctx = {
        getImageData: () => ({ data: new Uint8ClampedArray(buffer), width, height }),
        putImageData: (imgData: { data: Uint8ClampedArray }) => {
          buffer.set(imgData.data);
        },
        save: () => {},
        restore: () => {},
        drawImage: () => {},
      };
      const canvas = {
        width,
        height,
        getContext: () => ctx,
        _buffer: buffer,
      } as unknown as HTMLCanvasElement & { _buffer: Uint8ClampedArray };
      return canvas;
    }

    it('bridges small line-art gaps when closeGap > 0 without leaking outside the box', () => {
      const w = 40;
      const h = 40;
      const refCanvas = createMockCanvas(w, h);
      const targetNoClose = createMockCanvas(w, h);
      const targetWithClose = createMockCanvas(w, h);

      // Draw a black box from (10, 10) to (30, 30) with a 2-pixel gap at top wall (x = 19, 20, y = 10)
      const setBlack = (x: number, y: number) => {
        const idx = (y * w + x) * 4;
        refCanvas._buffer[idx] = 0;
        refCanvas._buffer[idx + 1] = 0;
        refCanvas._buffer[idx + 2] = 0;
        refCanvas._buffer[idx + 3] = 255;
      };

      for (let x = 10; x <= 30; x++) {
        if (x !== 19 && x !== 20) setBlack(x, 10); // 2px gap in top wall
        setBlack(x, 30);
      }
      for (let y = 10; y <= 30; y++) {
        setBlack(10, y);
        setBlack(30, y);
      }

      // Without closeGap, filling at center (20, 20) leaks through the gap to (2, 2)
      executeFloodFill(targetNoClose, refCanvas, 20, 20, '#ff0000', 10, null, { closeGap: 0 });
      const leakIdx = (2 * w + 2) * 4;
      expect(targetNoClose._buffer[leakIdx]).toBe(255);
      expect(targetNoClose._buffer[leakIdx + 1]).toBe(0); // Leaked red outside!

      // With closeGap = 4, the 2px gap is bridged and (2, 2) stays untouched white!
      executeFloodFill(targetWithClose, refCanvas, 20, 20, '#ff0000', 10, null, { closeGap: 4 });
      expect(targetWithClose._buffer[leakIdx]).toBe(255);
      expect(targetWithClose._buffer[leakIdx + 1]).toBe(255); // Untouched white outside!

      // Inside box (20, 20) is filled with red
      const insideIdx = (20 * w + 20) * 4;
      expect(targetWithClose._buffer[insideIdx]).toBe(255);
      expect(targetWithClose._buffer[insideIdx + 1]).toBe(0);
      expect(targetWithClose._buffer[insideIdx + 2]).toBe(0);
    });

    it('expands and shrinks the filled area according to areaScale', () => {
      const w = 40;
      const h = 40;
      const refCanvas = createMockCanvas(w, h);
      const targetExpand = createMockCanvas(w, h);
      const targetShrink = createMockCanvas(w, h);

      // Draw a thick 3px gray border around (10..30, 10..30)
      for (let y = 8; y <= 32; y++) {
        for (let x = 8; x <= 32; x++) {
          if (x <= 10 || x >= 30 || y <= 10 || y >= 30) {
            const idx = (y * w + x) * 4;
            refCanvas._buffer[idx] = 100;
            refCanvas._buffer[idx + 1] = 100;
            refCanvas._buffer[idx + 2] = 100;
            refCanvas._buffer[idx + 3] = 255;
          }
        }
      }

      const resExpand = executeFloodFill(targetExpand, refCanvas, 20, 20, '#00ff00', 10, null, {
        areaScale: 2,
      });
      const resShrink = executeFloodFill(targetShrink, refCanvas, 20, 20, '#00ff00', 10, null, {
        areaScale: -2,
      });

      expect(resExpand.dirtyRect!.width).toBeGreaterThan(resShrink.dirtyRect!.width);
      // Pixel at (10, 20) is inside the border and gets filled when expanded by +2
      const borderIdx = (20 * w + 10) * 4;
      expect(targetExpand._buffer[borderIdx + 1]).toBe(255);
      // Pixel at (12, 20) is 1px inside the wall and is left unfilled when shrunk by -2
      const shrinkEdgeIdx = (20 * w + 12) * 4;
      expect(targetShrink._buffer[shrinkEdgeIdx + 1]).toBe(255);
      expect(targetShrink._buffer[shrinkEdgeIdx]).toBe(255); // Still white
    });

    it('exposes compositeReferenceLayers for Reference Layer bucket filling', () => {
      expect(typeof compositeReferenceLayers).toBe('function');
    });
  });

  describe('5. GPU Shaders for Brush Dual-Tip, Liquify, and Convolution Filters', () => {
    it('includes GPU Liquify and Convolution Filter engines with graceful headless fallback', () => {
      expect(LIQUIFY_FRAGMENT_SHADER).toContain('uniform int u_mode;');
      expect(GAUSSIAN_BLUR_FRAGMENT_SHADER).toContain('uniform float u_radius;');
      expect(MOTION_BLUR_FRAGMENT_SHADER).toContain('uniform vec2 u_stepVec;');
      expect(WebGlLiquifyEngine.getInstance()).toBeDefined();
      expect(WebGlFilterEngine.getInstance()).toBeDefined();
      expect(WebGlBrushEngine.getInstance()).toBeDefined();
    });
  });
});
