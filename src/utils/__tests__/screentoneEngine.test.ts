import { describe, it, expect } from 'vitest';
import {
  applyScreentoneCPU,
  computeRationalHalftoneBasis,
  evaluateHalftoneDot,
  fract,
} from '../screentoneEngine';
import { isDedicatedToneLayer, resolveToneDensityType } from '../../types/editor';
import { sanitizeWireLayer } from '../collabSyncUtils';

function createMockCanvas(width: number, height: number, pixels: Uint8ClampedArray) {
  let stored = new Uint8ClampedArray(pixels);
  const ctx = {
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    getImageData: (x: number, y: number, w: number, h: number) => {
      const out = new Uint8ClampedArray(w * h * 4);
      for (let row = 0; row < h; row++) {
        const srcStart = ((y + row) * width + x) * 4;
        out.set(stored.subarray(srcStart, srcStart + w * 4), row * w * 4);
      }
      return { width: w, height: h, data: out };
    },
    putImageData: (img: ImageData, x: number, y: number) => {
      for (let row = 0; row < img.height; row++) {
        const dstStart = ((y + row) * width + x) * 4;
        const srcStart = row * img.width * 4;
        stored.set(img.data.subarray(srcStart, srcStart + img.width * 4), dstStart);
      }
    },
  };
  return {
    width,
    height,
    getContext: () => ctx,
    getData: () => stored,
  } as unknown as HTMLCanvasElement & { getData: () => Uint8ClampedArray };
}

describe('Anti-Moiré Manga Screentone GPU & CPU Pipeline', () => {
  it('evaluates Clip Studio Paint circle & Euclidean halftone dot formulas accurately', () => {
    const cosA = Math.cos(Math.PI / 4);
    const sinA = Math.sin(Math.PI / 4);
    const cellSize = 10; // 600 DPI / 60 LPI -> rational basis (7, 7), denom = 98

    // True center of a 45° cell: xr = 7*7 - 0*7 = 49 = denom/2, yr = 7*7 + 0*7 = 49 = denom/2 -> (u=0, v=0)
    expect(evaluateHalftoneDot(7, 0, 0.2, cellSize, cosA, sinA, 'circle')).toBe(true);
    expect(evaluateHalftoneDot(7, 0, 0.5, cellSize, cosA, sinA, 'euclidean')).toBe(true);

    // Far corner of cell (x = 0, y = 0 -> u = -0.5, v = -0.5) with 10% density should be white paper
    expect(evaluateHalftoneDot(0, 0, 0.1, cellSize, cosA, sinA, 'circle')).toBe(false);
    expect(evaluateHalftoneDot(0, 0, 0.1, cellSize, cosA, sinA, 'euclidean')).toBe(false);
  });

  it('produces strictly 1-bit binary Clip Studio dots with zero gray anti-aliasing fringe and exact periodicity', () => {
    const w = 84; // 6 full 14px periods at 600 DPI / 60 LPI / 45°
    const h = 84;
    const srcPixels = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < srcPixels.length; i += 4) {
      srcPixels[i] = 0;
      srcPixels[i + 1] = 0;
      srcPixels[i + 2] = 0;
      srcPixels[i + 3] = 255;
    }

    const srcCanvas = createMockCanvas(w, h, srcPixels);
    const dstCanvas = createMockCanvas(w, h, new Uint8ClampedArray(w * h * 4));
    // Default options (no antiAliasing flag needed -> strict 1-bit binary by default)
    applyScreentoneCPU(srcCanvas, dstCanvas, {
      frequency: 60,
      dpi: 600,
      angle: 45,
      dotShape: 'circle',
      densityType: 'specified',
      specifiedDensity: 0.4,
    });

    const out = dstCanvas.getData();
    const { a, b } = computeRationalHalftoneBasis(10, Math.cos(Math.PI / 4), Math.sin(Math.PI / 4));
    expect(a).toBe(7);
    expect(b).toBe(7);

    let blackCount = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const alpha = out[idx + 3];
        // Strictly 1-bit binary: zero gray anti-aliasing pixels
        expect(alpha === 0 || alpha === 255).toBe(true);
        if (alpha === 255) blackCount++;

        // Exact integer-lattice periodicity: every dot separated by (14, 0) or (7, 7) is bit-for-bit identical
        if (x + 14 < w) {
          expect(out[(y * w + (x + 14)) * 4 + 3]).toBe(alpha);
        }
        if (x + 7 < w && y + 7 < h) {
          expect(out[((y + 7) * w + (x + 7)) * 4 + 3]).toBe(alpha);
        }
      }
    }

    // Area-calibrated coverage at 40% density should be closely centered near 40%
    const coverage = blackCount / (w * h);
    expect(coverage).toBeGreaterThan(0.35);
    expect(coverage).toBeLessThan(0.45);
  });

  it('fract function strictly yields [0.0, 1.0)', () => {
    expect(fract(0.5)).toBeCloseTo(0.5);
    expect(fract(1.0)).toBeCloseTo(0.0);
    expect(fract(-0.25)).toBeCloseTo(0.75);
    expect(fract(-1.5)).toBeCloseTo(0.5);
  });

  it('distinguishes dedicated screen tone layers from existing layers with tone effect', () => {
    // Dedicated screen tone layer -> editable flat specified density
    expect(isDedicatedToneLayer({ isToneLayer: true, toneDensityType: 'specified' })).toBe(true);
    expect(resolveToneDensityType({ isToneLayer: true, toneDensityType: 'specified' })).toBe('specified');

    // Existing normal layer with screentone toggled on -> adapts to layer tones
    expect(isDedicatedToneLayer({ toneDensityType: undefined })).toBe(false);
    expect(resolveToneDensityType({ toneDensityType: undefined })).toBe('image');
    expect(isDedicatedToneLayer({ isToneLayer: false, toneDensityType: 'image' })).toBe(false);
    expect(resolveToneDensityType({ isToneLayer: false, toneDensityType: 'image' })).toBe('image');

    // Legacy saved screen tone layer without isToneLayer flag preserves specified density
    expect(isDedicatedToneLayer({ toneDensityType: 'specified' })).toBe(true);
    expect(resolveToneDensityType({ toneDensityType: 'specified' })).toBe('specified');
  });

  it('adapts screentone dot density to layer brightness in image mode vs flat density in specified mode', () => {
    const w = 60;
    const h = 20;
    const srcPixels = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        // 3 horizontal bands: dark gray (51), light gray (204), pure white (255)
        const v = x < 20 ? 51 : x < 40 ? 204 : 255;
        srcPixels[i] = v;
        srcPixels[i + 1] = v;
        srcPixels[i + 2] = v;
        srcPixels[i + 3] = 255;
      }
    }

    const srcCanvas = createMockCanvas(w, h, srcPixels);
    const imgTarget = createMockCanvas(w, h, new Uint8ClampedArray(w * h * 4));
    applyScreentoneCPU(srcCanvas, imgTarget, {
      frequency: 60,
      dpi: 600,
      angle: 45,
      densityType: 'image',
      specifiedDensity: 0.4,
      antiAliasing: false,
    });

    const countBandInk = (data: Uint8ClampedArray, x0: number, x1: number) => {
      let ink = 0;
      for (let y = 0; y < h; y++) {
        for (let x = x0; x < x1; x++) {
          if (data[(y * w + x) * 4 + 3] > 0) ink++;
        }
      }
      return ink;
    };

    const imgData = imgTarget.getData();
    const darkInk = countBandInk(imgData, 0, 20);
    const lightInk = countBandInk(imgData, 20, 40);
    const whiteInk = countBandInk(imgData, 40, 60);

    // Image tone mode adapts smoothly to layer brightness
    expect(darkInk).toBeGreaterThan(lightInk * 2);
    expect(lightInk).toBeGreaterThan(0);
    expect(whiteInk).toBe(0);

    // Specified density mode (dedicated tone layer) produces flat uniform density across all opaque bands
    const specTarget = createMockCanvas(w, h, new Uint8ClampedArray(w * h * 4));
    applyScreentoneCPU(srcCanvas, specTarget, {
      frequency: 60,
      dpi: 600,
      angle: 45,
      densityType: 'specified',
      specifiedDensity: 0.4,
      antiAliasing: false,
    });
    const specData = specTarget.getData();
    const specBand1 = countBandInk(specData, 0, 20);
    const specBand3 = countBandInk(specData, 40, 60);
    expect(specBand1).toBeGreaterThan(0);
    expect(specBand3).toBeGreaterThan(0);
    expect(Math.abs(specBand1 - specBand3)).toBeLessThan(15);
  });

  it('preserves isToneLayer through multiplayer wire sanitization', () => {
    const sanitized = sanitizeWireLayer({
      id: 'tone-1',
      name: 'Screen Tone',
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      locked: false,
      parentId: null,
      isToneLayer: true,
      toneEnabled: true,
      toneDensity: 35,
      toneDensityType: 'specified',
    });
    expect(sanitized?.isToneLayer).toBe(true);
    expect(sanitized?.toneDensityType).toBe('specified');
  });
});
