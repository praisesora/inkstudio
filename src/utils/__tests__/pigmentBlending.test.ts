import { describe, it, expect } from 'vitest';
import {
  mixSubtractivePigments,
  mixPigmentsWithStrength,
  mixPigmentRgbOut,
  parseColorToRgb,
} from '../colorMixingEngine';
import {
  DEFAULT_RETOUCH_SETTINGS,
  applyRetouchStrokeSegment,
  createRetouchStrokeSession,
} from '../retouchEngine';
import { sampleGradientStops, ParsedRgbaStop } from '../gradientEngine';
import { buildPigmentPreviewGradient } from '../../components/PigmentBlendControl';
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
) {
  grid.setLayerFormat(layerId, 'color-32bit');
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = a;
  }
  grid.writeImageData(layerId, { data, width: w, height: h }, x, y, 'color-32bit', true);
}

describe('7-Band Spectral Kubelka-Munk Pigment Blending', () => {
  it('mixes Blue + Yellow into vibrant Green (vs dull gray in Regular RGB)', () => {
    const blue = { r: 0, g: 136, b: 255 };
    const yellow = { r: 255, g: 244, b: 0 };

    const pigment = mixSubtractivePigments(blue, yellow, 0.5);
    const regular = mixPigmentsWithStrength(blue, yellow, 0.5, 0);

    // Regular RGB collapses toward gray-olive (r ≈ b ≈ 128)
    expect(Math.abs(regular.r - regular.b)).toBeLessThan(2);

    // Spectral pigment produces clearly green-dominant emerald hue
    expect(pigment.g).toBeGreaterThan(pigment.r + 50);
    expect(pigment.g).toBeGreaterThan(pigment.b + 50);
  });

  it('mixes Green + Magenta into warm golden-amber instead of muddy gray', () => {
    const green = { r: 40, g: 255, b: 0 };
    const magenta = { r: 255, g: 0, b: 170 };

    const pigment = mixSubtractivePigments(green, magenta, 0.5);

    // Warm golden-amber: red & green strongly exceed blue
    expect(pigment.r).toBeGreaterThan(pigment.b + 70);
    expect(pigment.g).toBeGreaterThan(pigment.b + 50);
  });

  it('mixes Red + Yellow into vibrant Orange and Red + Blue into rich Violet', () => {
    const red = { r: 235, g: 20, b: 20 };
    const yellow = { r: 255, g: 240, b: 0 };
    const blue = { r: 15, g: 60, b: 240 };

    const orange = mixSubtractivePigments(red, yellow, 0.5);
    expect(orange.r).toBeGreaterThan(220);
    expect(orange.g).toBeGreaterThan(110);
    expect(orange.b).toBeLessThan(30);

    const violet = mixSubtractivePigments(red, blue, 0.5);
    expect(violet.r).toBeGreaterThan(violet.g + 60);
    expect(violet.b).toBeGreaterThan(violet.g + 60);
  });

  it('keeps Black + White strictly neutral gray and preserves exact self-mix invariance', () => {
    const gray50 = mixSubtractivePigments({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5);
    expect(Math.abs(gray50.r - gray50.g)).toBeLessThan(1.5);
    expect(Math.abs(gray50.g - gray50.b)).toBeLessThan(1.5);

    const testColors = [
      { r: 0, g: 136, b: 255 },
      { r: 255, g: 244, b: 0 },
      { r: 40, g: 255, b: 0 },
      { r: 255, g: 0, b: 170 },
      { r: 155, g: 0, b: 255 },
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
    ];
    const out = { r: 0, g: 0, b: 0 };
    for (const c of testColors) {
      mixPigmentRgbOut(c.r, c.g, c.b, c.r, c.g, c.b, 0.5, 1.0, out);
      expect(Math.abs(out.r - c.r)).toBeLessThan(1.5);
      expect(Math.abs(out.g - c.g)).toBeLessThan(1.5);
      expect(Math.abs(out.b - c.b)).toBeLessThan(1.5);
    }
  });

  it('Retouch Smudge produces vibrant Green when blending Blue into Yellow with Pigment Blending enabled', () => {
    const runSmudge = (pigmentBlending: boolean) => {
      const grid = new SparseTileGrid();
      const dims = { width: 128, height: 128 };
      const layerId = 'layer-pigment-smudge';
      // Left half: Blue, Right half: Yellow
      fillRectRgba(grid, layerId, 0, 0, 64, 128, 0, 120, 255, 255);
      fillRectRgba(grid, layerId, 64, 0, 64, 128, 255, 240, 0, 255);

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
        size: 32,
        strength: 75,
        hardness: 70,
        usePressure: false,
        pigmentBlending,
        pigmentStrength: 100,
      };

      applyRetouchStrokeSegment({ grid, session, pt: { x: 48, y: 64 }, pressure: 1, settings, primaryColor: '#000000' });
      applyRetouchStrokeSegment({ grid, session, pt: { x: 76, y: 64 }, pressure: 1, settings, primaryColor: '#000000' });

      // Peak green dominance across the smudged Blue -> Yellow transition zone (x = 64..90)
      let maxGreenDom = -999;
      for (let x = 64; x <= 90; x++) {
        const px = grid.getPixelRGBA(layerId, x, 64);
        const dom = px[1] - Math.max(px[0], px[2]);
        if (dom > maxGreenDom) maxGreenDom = dom;
      }
      return maxGreenDom;
    };

    const pigGreenDom = runSmudge(true);
    const regGreenDom = runSmudge(false);

    // Pigment smudge pushes vibrant green well above regular RGB smudge
    expect(pigGreenDom).toBeGreaterThan(40);
    expect(pigGreenDom).toBeGreaterThan(regGreenDom + 25);
  });

  it('Retouch Blur produces Green across a Blue | Yellow seam when Pigment Blending is enabled', () => {
    const runBlur = (pigmentBlending: boolean) => {
      const grid = new SparseTileGrid();
      const dims = { width: 128, height: 128 };
      const layerId = 'layer-pigment-blur';
      fillRectRgba(grid, layerId, 0, 0, 64, 128, 0, 110, 255, 255);
      fillRectRgba(grid, layerId, 64, 0, 64, 128, 255, 242, 0, 255);

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
        size: 36,
        strength: 100,
        hardness: 80,
        usePressure: false,
        pigmentBlending,
        pigmentStrength: 100,
      };

      applyRetouchStrokeSegment({ grid, session, pt: { x: 64, y: 64 }, pressure: 1, settings, primaryColor: '#000000' });
      return grid.getPixelRGBA(layerId, 64, 64);
    };

    const pigPx = runBlur(true);
    const regPx = runBlur(false);

    const pigGreenDom = pigPx[1] - Math.max(pigPx[0], pigPx[2]);
    const regGreenDom = regPx[1] - Math.max(regPx[0], regPx[2]);
    expect(pigGreenDom).toBeGreaterThan(35);
    expect(pigGreenDom).toBeGreaterThan(regGreenDom + 25);
  });

  it('Gradient stop sampling blends Blue -> Yellow through Green when pigmentBlending is enabled', () => {
    const stops: ParsedRgbaStop[] = [
      { offset: 0, r: 0, g: 120, b: 255, a: 255 },
      { offset: 1, r: 255, g: 244, b: 0, a: 255 },
    ];
    const regOut: [number, number, number, number] = [0, 0, 0, 0];
    const pigOut: [number, number, number, number] = [0, 0, 0, 0];

    sampleGradientStops(stops, 0.5, 'clamp', false, regOut, false);
    sampleGradientStops(stops, 0.5, 'clamp', false, pigOut, true);

    expect(pigOut[1]).toBeGreaterThan(pigOut[0] + 50);
    expect(pigOut[1]).toBeGreaterThan(pigOut[2] + 50);
    expect(Math.abs(regOut[0] - regOut[2])).toBeLessThan(2);
  });

  it('PigmentBlendControl preview gradient visually distinguishes Regular vs Pigment midpoints', () => {
    const regGrad = buildPigmentPreviewGradient('#0084ff', '#fff000', false, 1.0);
    const pigGrad = buildPigmentPreviewGradient('#0084ff', '#fff000', true, 1.0);
    expect(regGrad).not.toBe(pigGrad);

    // Extract the 50% stop hex from both CSS gradients
    const regMidMatch = regGrad.match(/(#[0-9a-f]{6}) 50%/i);
    const pigMidMatch = pigGrad.match(/(#[0-9a-f]{6}) 50%/i);
    expect(regMidMatch).toBeTruthy();
    expect(pigMidMatch).toBeTruthy();

    const regMid = parseColorToRgb(regMidMatch![1]);
    const pigMid = parseColorToRgb(pigMidMatch![1]);
    expect(pigMid.g - Math.max(pigMid.r, pigMid.b)).toBeGreaterThan(
      regMid.g - Math.max(regMid.r, regMid.b) + 30
    );
  });
});
