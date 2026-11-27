import { describe, it, expect } from 'vitest';
import {
  LayerPixelSampler,
  PaintReservoir,
  mixSubtractivePigments,
  mixPigmentsWithStrength,
  mixPigmentRgbOut,
  parseColorToRgb,
} from '../colorMixingEngine';
import {
  buildPigmentLutRgba,
  encodePigmentOverWhiteOut,
} from '../pigmentEngine';
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

function compositeOverWhite(px: readonly [number, number, number, number]): [number, number, number] {
  const a = px[3] / 255;
  const inv = 1 - a;
  return [
    Math.round(px[0] * a + 255 * inv),
    Math.round(px[1] * a + 255 * inv),
    Math.round(px[2] * a + 255 * inv),
  ];
}

describe('Physical Kubelka-Munk Pigment Blending Engine', () => {
  it('mixes Cobalt Blue + Hansa Yellow and Cyan-Blue + Yellow into vibrant Green (vs muddy gray/olive in Regular RGB)', () => {
    const pairs = [
      { blue: { r: 0, g: 33, b: 133 }, yellow: { r: 252, g: 211, b: 0 } },
      { blue: { r: 0, g: 136, b: 255 }, yellow: { r: 255, g: 244, b: 0 } },
    ];

    for (const { blue, yellow } of pairs) {
      const pigment = mixSubtractivePigments(blue, yellow, 0.5);
      const regular = mixPigmentsWithStrength(blue, yellow, 0.5, 0);

      const pigGreenDom = pigment.g - Math.max(pigment.r, pigment.b);
      const regGreenDom = regular.g - Math.max(regular.r, regular.b);
      expect(pigGreenDom).toBeGreaterThan(55);
      expect(pigGreenDom).toBeGreaterThan(regGreenDom + 45);
    }
  });

  it('dilutes dark pigments over white into luminous cerulean, rose-magenta, turquoise, royal blue & violet (vs dull slate/gray in Regular RGB)', () => {
    const white = { r: 255, g: 255, b: 255 };

    // Phthalo Blue + White -> electric cerulean blue
    const phthaloBlue = { r: 13, g: 27, b: 68 };
    const pbPig = mixSubtractivePigments(phthaloBlue, white, 0.5);
    const pbReg = mixPigmentsWithStrength(phthaloBlue, white, 0.5, 0);
    expect(pbPig.b - pbPig.r).toBeGreaterThan(130);
    expect(pbPig.g - pbPig.r).toBeGreaterThan(60);
    expect(pbReg.b - pbReg.r).toBeLessThan(35);

    // Quinacridone Magenta + White -> vivid rose-magenta
    const quinMagenta = { r: 128, g: 2, b: 46 };
    const qmPig = mixSubtractivePigments(quinMagenta, white, 0.5);
    const qmReg = mixPigmentsWithStrength(quinMagenta, white, 0.5, 0);
    expect(qmPig.r - qmPig.g).toBeGreaterThan(100);
    expect(qmPig.b - qmPig.g).toBeGreaterThan(55);
    expect(qmReg.b - qmReg.g).toBeLessThan(30);

    // Phthalo Green + White -> vibrant turquoise-teal
    const phthaloGreen = { r: 0, g: 60, b: 50 };
    const pgPig = mixSubtractivePigments(phthaloGreen, white, 0.5);
    const pgReg = mixPigmentsWithStrength(phthaloGreen, white, 0.5, 0);
    expect(pgPig.g - pgPig.r).toBeGreaterThan(65);
    expect(pgPig.b - pgPig.r).toBeGreaterThan(60);
    expect(pgReg.g - pgReg.r).toBeLessThan(35);

    // Ultramarine + White -> electric royal blue
    const ultramarine = { r: 25, g: 0, b: 89 };
    const umPig = mixSubtractivePigments(ultramarine, white, 0.5);
    expect(umPig.b - umPig.r).toBeGreaterThan(110);

    // Cobalt Violet + White -> vibrant magenta-violet
    const cobaltViolet = { r: 78, g: 0, b: 66 };
    const cvPig = mixSubtractivePigments(cobaltViolet, white, 0.5);
    expect(cvPig.r - cvPig.g).toBeGreaterThan(75);
    expect(cvPig.b - cvPig.g).toBeGreaterThan(75);
  });

  it('mixes Green + Magenta into warm amber-ochre and Red + Yellow/Blue into Orange and Violet', () => {
    const green = { r: 40, g: 255, b: 0 };
    const magenta = { r: 255, g: 0, b: 170 };
    const amber = mixSubtractivePigments(green, magenta, 0.5);
    expect(amber.r).toBeGreaterThan(amber.b + 70);
    expect(amber.g).toBeGreaterThan(amber.b + 35);

    const red = { r: 235, g: 20, b: 20 };
    const yellow = { r: 255, g: 240, b: 0 };
    const blue = { r: 15, g: 60, b: 240 };

    const orange = mixSubtractivePigments(red, yellow, 0.5);
    expect(orange.r).toBeGreaterThan(220);
    expect(orange.g).toBeGreaterThan(100);
    expect(orange.g).toBeGreaterThan(orange.b + 55);
    expect(orange.b).toBeLessThan(45);

    const violet = mixSubtractivePigments(red, blue, 0.5);
    expect(violet.r).toBeGreaterThan(violet.g + 55);
    expect(violet.b).toBeGreaterThan(violet.g + 55);
  });

  it('keeps Black + White strictly neutral gray, preserves self-mix invariance, and returns exact RGB at strength=0', () => {
    const gray50 = mixSubtractivePigments({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5);
    expect(Math.abs(gray50.r - gray50.g)).toBeLessThan(1.5);
    expect(Math.abs(gray50.g - gray50.b)).toBeLessThan(1.5);

    const testColors = [
      { r: 0, g: 33, b: 133 },
      { r: 252, g: 211, b: 0 },
      { r: 13, g: 27, b: 68 },
      { r: 128, g: 2, b: 46 },
      { r: 0, g: 60, b: 50 },
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

    // Strength 0 reproduces exact linear RGB
    mixPigmentRgbOut(0, 33, 133, 252, 211, 0, 0.5, 0, out);
    expect(out.r).toBeCloseTo(126, 0);
    expect(out.g).toBeCloseTo(122, 0);
    expect(out.b).toBeCloseTo(66.5, 0);
  });

  it('encodePigmentOverWhiteOut reconstructs exact physical pigment dilution over white across alphas', () => {
    const darkPigments = [
      [13, 27, 68],
      [128, 2, 46],
      [0, 60, 50],
      [25, 0, 89],
    ] as const;
    const enc: [number, number, number, number] = [0, 0, 0, 0];

    for (const [r, g, b] of darkPigments) {
      for (const alpha of [0.15, 0.35, 0.5, 0.75]) {
        const expected = mixSubtractivePigments({ r: 255, g: 255, b: 255 }, { r, g, b }, alpha);
        encodePigmentOverWhiteOut(r, g, b, alpha, 1.0, enc);
        const [vr, vg, vb] = compositeOverWhite(enc);
        expect(Math.abs(vr - expected.r)).toBeLessThanOrEqual(2);
        expect(Math.abs(vg - expected.g)).toBeLessThanOrEqual(2);
        expect(Math.abs(vb - expected.b)).toBeLessThanOrEqual(2);
      }
    }
  });

  it('buildPigmentLutRgba generates a valid 512x512 RGBA8 GPU concentration lookup table', () => {
    const rgba = buildPigmentLutRgba();
    expect(rgba.length).toBe(512 * 512 * 4);
    // Blue corner (r=0, g=0, b=63) sits at slice 63 (tile x=7*64, y=7*64)
    const blueCornerIdx = ((7 * 64 + 0) * 512 + (7 * 64 + 0)) * 4;
    expect(rgba[blueCornerIdx]).toBeGreaterThan(150); // high c0 (blue pigment)
    expect(rgba[blueCornerIdx + 3]).toBe(255);
  });

  it('compositeStrokeToTiles blends glazing strokes in pigment space and supports Regular vs Pigment on the same layer', () => {
    const grid = new SparseTileGrid();
    const layerId = 'layer-glaze';

    // 1. Opaque Cobalt Blue base on left & right; glaze 50% Hansa Yellow over both
    fillRectRgba(grid, layerId, 0, 0, 64, 32, 0, 33, 133, 255);
    const yellowDab = new Uint8ClampedArray(20 * 20 * 4);
    for (let i = 0; i < yellowDab.length; i += 4) {
      yellowDab[i] = 252;
      yellowDab[i + 1] = 211;
      yellowDab[i + 2] = 0;
      yellowDab[i + 3] = 255;
    }

    // Left: Regular RGB (pigmentStrength = 0)
    grid.compositeStrokeToTiles({
      layerId,
      strokeData: { data: yellowDab, width: 20, height: 20 },
      destX: 4,
      destY: 4,
      format: 'color-32bit',
      compositeOp: 'source-over',
      opacity: 0.5,
      pigmentStrength: 0,
      pigmentWhiteGround: true,
    });
    // Right: Pigment (pigmentStrength = 1.0)
    grid.compositeStrokeToTiles({
      layerId,
      strokeData: { data: yellowDab, width: 20, height: 20 },
      destX: 36,
      destY: 4,
      format: 'color-32bit',
      compositeOp: 'source-over',
      opacity: 0.5,
      pigmentStrength: 1.0,
      pigmentWhiteGround: true,
    });

    const regPx = grid.getPixelRGBA(layerId, 12, 12);
    const pigPx = grid.getPixelRGBA(layerId, 44, 12);
    const regGreenDom = regPx[1] - Math.max(regPx[0], regPx[2]);
    const pigGreenDom = pigPx[1] - Math.max(pigPx[0], pigPx[2]);
    expect(regGreenDom).toBeLessThan(10); // muddy olive-gray in regular RGB
    expect(pigGreenDom).toBeGreaterThan(60); // vibrant green in pigment mode

    // 2. Transparent region over white paper: 50% Phthalo Blue (Regular left vs Pigment right)
    const navyDab = new Uint8ClampedArray(20 * 20 * 4);
    for (let i = 0; i < navyDab.length; i += 4) {
      navyDab[i] = 13;
      navyDab[i + 1] = 27;
      navyDab[i + 2] = 68;
      navyDab[i + 3] = 255;
    }
    grid.compositeStrokeToTiles({
      layerId,
      strokeData: { data: navyDab, width: 20, height: 20 },
      destX: 4,
      destY: 60,
      format: 'color-32bit',
      compositeOp: 'source-over',
      opacity: 0.5,
      pigmentStrength: 0,
      pigmentWhiteGround: true,
    });
    grid.compositeStrokeToTiles({
      layerId,
      strokeData: { data: navyDab, width: 20, height: 20 },
      destX: 36,
      destY: 60,
      format: 'color-32bit',
      compositeOp: 'source-over',
      opacity: 0.5,
      pigmentStrength: 1.0,
      pigmentWhiteGround: true,
    });

    const regOverWhite = compositeOverWhite(grid.getPixelRGBA(layerId, 12, 68));
    const pigOverWhite = compositeOverWhite(grid.getPixelRGBA(layerId, 44, 68));
    expect(regOverWhite[2] - regOverWhite[0]).toBeLessThan(35); // slate gray
    expect(pigOverWhite[2] - pigOverWhite[0]).toBeGreaterThan(130); // luminous cerulean

    // 3. Multi-pass translucent layering over transparent white paper (two 25% passes of Phthalo Blue)
    for (let pass = 0; pass < 2; pass++) {
      grid.compositeStrokeToTiles({
        layerId,
        strokeData: { data: navyDab, width: 20, height: 20 },
        destX: 36,
        destY: 96,
        format: 'color-32bit',
        compositeOp: 'source-over',
        opacity: 0.25,
        pigmentStrength: 1.0,
        pigmentWhiteGround: true,
      });
    }
    const twoPassOverWhite = compositeOverWhite(grid.getPixelRGBA(layerId, 44, 104));
    expect(twoPassOverWhite[2] - twoPassOverWhite[0]).toBeGreaterThan(130); // stays electric cerulean across passes
  });

  it('LayerPixelSampler and PaintReservoir average and mix Blue | Yellow in pigment latent space (vs muddy gray in Regular mode)', () => {
    const grid = new SparseTileGrid();
    const layerId = 'layer-sampler-pigment';
    fillRectRgba(grid, layerId, 0, 0, 64, 128, 0, 33, 133, 255);
    fillRectRgba(grid, layerId, 64, 0, 64, 128, 252, 211, 0, 255);

    const sampler = new LayerPixelSampler({ width: 128, height: 128 }, layerId, grid);

    // 1. Neighborhood sampling across the Blue | Yellow seam
    const pigSample = sampler.sampleColor(64, 64, 16, true);
    const regSample = sampler.sampleColor(64, 64, 16, false);
    const pigSampleGreen = pigSample.g - Math.max(pigSample.r, pigSample.b);
    const regSampleGreen = regSample.g - Math.max(regSample.r, regSample.b);
    expect(pigSampleGreen).toBeGreaterThan(50);
    expect(pigSampleGreen).toBeGreaterThan(regSampleGreen + 40);

    // 2. PaintReservoir mixing Yellow brush over Blue canvas across stroke travel
    const pigRes = new PaintReservoir('#fcd300');
    const regRes = new PaintReservoir('#fcd300');
    const blueCanvas = { r: 0, g: 33, b: 133, a: 1 };
    let pigMixed = pigRes.mixWithCanvas(blueCanvas, 0.35, 0.7, 0.7, 'blend', 0.6, 0.85, 8, true, false, 1.0);
    let regMixed = regRes.mixWithCanvas(blueCanvas, 0.35, 0.7, 0.7, 'blend', 0.6, 0.85, 8, false, false, 0.0);
    for (let step = 0; step < 5; step++) {
      pigMixed = pigRes.mixWithCanvas(blueCanvas, 0.35, 0.7, 0.7, 'blend', 0.6, 0.85, 8, true, false, 1.0);
      regMixed = regRes.mixWithCanvas(blueCanvas, 0.35, 0.7, 0.7, 'blend', 0.6, 0.85, 8, false, false, 0.0);
    }
    const pigResGreen = pigMixed.g - Math.max(pigMixed.r, pigMixed.b);
    const regResGreen = regMixed.g - Math.max(regMixed.r, regMixed.b);
    expect(pigResGreen).toBeGreaterThan(55);
    expect(pigResGreen).toBeGreaterThan(regResGreen + 45);

    // 3. depositDab updates in-memory sampler in pigment space
    sampler.depositDab(20, 20, 8, 252, 211, 0, 0.5, 1.0);
    const deposited = sampler.sampleColor(20, 20, 2, true);
    expect(deposited.g - Math.max(deposited.r, deposited.b)).toBeGreaterThan(45);
  });

  it('Retouch Smudge produces vibrant Green across Blue|Yellow and luminous Cerulean when dragging Phthalo Blue onto transparent white paper', () => {
    const runSmudge = (pigmentBlending: boolean) => {
      const grid = new SparseTileGrid();
      const dims = { width: 128, height: 128 };
      const layerId = 'layer-pigment-smudge';
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
    expect(pigGreenDom).toBeGreaterThan(40);
    expect(pigGreenDom).toBeGreaterThan(regGreenDom + 25);

    // Dragging dark Phthalo Blue into empty transparent pixels over white ground
    const runDarkSmudgeToWhite = (pigmentBlending: boolean) => {
      const grid = new SparseTileGrid();
      const dims = { width: 128, height: 128 };
      const layerId = 'layer-navy-smudge';
      fillRectRgba(grid, layerId, 0, 0, 48, 128, 13, 27, 68, 255);

      const session = createRetouchStrokeSession({
        mode: 'smudge',
        layerId,
        targetFormat: 'color-32bit',
        alphaLock: false,
        pigmentWhiteGround: true,
        dimensions: dims,
        selectionMask: null,
      });
      const settings = {
        ...DEFAULT_RETOUCH_SETTINGS,
        mode: 'smudge' as const,
        size: 30,
        strength: 65,
        hardness: 60,
        usePressure: false,
        pigmentBlending,
        pigmentStrength: 100,
      };

      applyRetouchStrokeSegment({ grid, session, pt: { x: 32, y: 64 }, pressure: 1, settings, primaryColor: '#000000' });
      applyRetouchStrokeSegment({ grid, session, pt: { x: 74, y: 64 }, pressure: 1, settings, primaryColor: '#000000' });

      let maxBlueChroma = 0;
      for (let x = 50; x <= 74; x++) {
        const px = grid.getPixelRGBA(layerId, x, 64);
        if (px[3] > 20 && px[3] < 240) {
          const [vr, , vb] = compositeOverWhite(px);
          maxBlueChroma = Math.max(maxBlueChroma, vb - vr);
        }
      }
      return maxBlueChroma;
    };

    const pigCerulean = runDarkSmudgeToWhite(true);
    const regSlate = runDarkSmudgeToWhite(false);
    expect(pigCerulean).toBeGreaterThan(100);
    expect(pigCerulean).toBeGreaterThan(regSlate + 60);
  });

  it('Retouch Blur produces vibrant Green across a Blue | Yellow seam via 7-channel pigment latent convolution', () => {
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
    expect(pigGreenDom).toBeGreaterThan(45);
    expect(pigGreenDom).toBeGreaterThan(regGreenDom + 35);
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
    const regGrad = buildPigmentPreviewGradient('#002185', '#fcd300', false, 1.0);
    const pigGrad = buildPigmentPreviewGradient('#002185', '#fcd300', true, 1.0);
    expect(regGrad).not.toBe(pigGrad);

    const regMidMatch = regGrad.match(/(#[0-9a-f]{6}) 50%/i);
    const pigMidMatch = pigGrad.match(/(#[0-9a-f]{6}) 50%/i);
    expect(regMidMatch).toBeTruthy();
    expect(pigMidMatch).toBeTruthy();

    const regMid = parseColorToRgb(regMidMatch![1]);
    const pigMid = parseColorToRgb(pigMidMatch![1]);
    expect(pigMid.g - Math.max(pigMid.r, pigMid.b)).toBeGreaterThan(
      regMid.g - Math.max(regMid.r, regMid.b) + 45
    );
  });
});
