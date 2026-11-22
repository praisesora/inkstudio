import { describe, it, expect } from 'vitest';
import {
  getCompiledCurveLut,
  evaluateFastSpline,
  dabHashFloat,
  evaluateCspSensor,
  computeEllipticalStepDistance,
  computeGapAdjustedAlpha,
  computeSubpixelDabDimensions,
  getCspAntiAliasFeather,
  resolveTipFlipSigns,
  applyCspPaperTextureAlpha,
  applyCspPostCorrection,
  applyCspWatercolorEdge,
  CSP_PRESSURE_CURVE_PRESETS,
} from '../../engine/BrushEngine';
import { stepBrushSizePreset } from '../brushPresetManager';
import { BUILTIN_BRUSHES } from '../presetBrushes';
import { Point } from '../../types/editor';

describe('CSP Brush Engine V2 - Mathematics, Sensors & Post-Processing', () => {
  it('compiles PCHIP LUTs with strict monotonicity and caches identical curves', () => {
    const curve = CSP_PRESSURE_CURVE_PRESETS['g-pen'].points;
    const lut1 = getCompiledCurveLut(curve);
    const lut2 = getCompiledCurveLut(curve);
    expect(lut1).not.toBeNull();
    expect(lut1).toBe(lut2);
    expect(lut1!.length).toBe(256);

    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const y = evaluateFastSpline(i / 100, curve);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
      prev = y;
    }
    expect(evaluateFastSpline(0, curve)).toBeCloseTo(0, 4);
    expect(evaluateFastSpline(1, curve)).toBeCloseTo(1, 4);
  });

  it('produces deterministic dab hashes across repeated calls', () => {
    const h1 = dabHashFloat(128.45, 256.9, 17, 3);
    const h2 = dabHashFloat(128.45, 256.9, 17, 3);
    const hDiff = dabHashFloat(128.45, 256.9, 18, 3);
    expect(h1).toBe(h2);
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThan(1);
    expect(h1).not.toBe(hDiff);
  });

  it('evaluates multiplicative CSP multi-sensor dynamics (Pressure x Tilt x Velocity x Random)', () => {
    const val = evaluateCspSensor(
      {
        usePressure: true,
        pressureMin: 0.2,
        useTilt: true,
        tiltMin: 0.5,
        useVelocity: true,
        velocityMin: 0.4,
        invertVelocity: true,
        useRandom: true,
        randomMin: 0.5,
      },
      0.5, // pFactor = 0.2 + 0.8 * 0.5 = 0.6
      0.5, // tFactor = 0.5 + 0.5 * 0.5 = 0.75
      1.75, // vNorm = 0.5 -> inverted 0.5 -> vFactor = 0.4 + 0.6 * 0.5 = 0.7
      0.5 // rFactor = 0.5 + 0.5 * 0.5 = 0.75
    );
    expect(val).toBeCloseTo(0.6 * 0.75 * 0.7 * 0.75, 5);
  });

  it('computes directional elliptical step distance to prevent calligraphic gaps', () => {
    // 40px wide, 4px tall flat nib at 0 rad
    const alongWide = computeEllipticalStepDistance(40, 4, 0, 1, 0, 0.1);
    const alongThin = computeEllipticalStepDistance(40, 4, 0, 0, 1, 0.1);
    expect(alongWide).toBeCloseTo(4.0, 3);
    expect(alongThin).toBeCloseTo(0.4, 3);
    expect(alongThin).toBeLessThan(alongWide * 0.2);
  });

  it('compensates dab density by gap using Beer-Lambert transmittance', () => {
    const tightAlpha = computeGapAdjustedAlpha(0.3, 0.08, true, 0.08);
    const wideAlpha = computeGapAdjustedAlpha(0.3, 0.24, true, 0.08);
    expect(tightAlpha).toBeCloseTo(0.3, 4);
    // 3x wider gap should yield 1 - (1 - 0.3)^3 = 0.657
    expect(wideAlpha).toBeCloseTo(1 - Math.pow(0.7, 3), 3);
    expect(wideAlpha).toBeGreaterThan(tightAlpha);
  });

  it('conserves 2D sub-pixel hairline coverage and maps 4-stage CSP anti-aliasing', () => {
    const sub = computeSubpixelDabDimensions(0.375, 0.375, 0.8, 0.75);
    expect(sub.renderW).toBe(0.75);
    expect(sub.renderH).toBe(0.75);
    // 0.5 * 0.5 = 0.25 area ratio -> 0.8 * 0.25 = 0.2
    expect(sub.effAlpha).toBeCloseTo(0.2, 4);

    expect(getCspAntiAliasFeather(0)).toBe(0);
    expect(getCspAntiAliasFeather(1)).toBeLessThan(getCspAntiAliasFeather(2));
    expect(getCspAntiAliasFeather(2)).toBeLessThan(getCspAntiAliasFeather(3));
  });

  it('supports tip flip modes and all 5 CSP paper texture physics modes', () => {
    const alt0 = resolveTipFlipSigns('alternate', 'none', 0, 10, 10);
    const alt1 = resolveTipFlipSigns('alternate', 'none', 1, 10, 10);
    expect(alt0.signX).toBe(1);
    expect(alt1.signX).toBe(-1);

    const modes = ['multiply', 'subtract', 'compare', 'overlay', 'outline'] as const;
    for (const mode of modes) {
      const a = applyCspPaperTextureAlpha(0.7, 0.35, 0.8, 0.4, mode, 0, 10, false);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }

    // Subtract valley-fill: higher stylus pressure penetrates deeper -> higher alpha
    const lightTouch = applyCspPaperTextureAlpha(0.6, 0.3, 0.85, 0.1, 'subtract');
    const heavyTouch = applyCspPaperTextureAlpha(0.6, 0.3, 0.85, 0.95, 'subtract');
    expect(heavyTouch).toBeGreaterThan(lightTouch);
  });

  it('applies post-correction smoothing while preserving sharp corners and endpoints', () => {
    const pts: Point[] = [
      { x: 0, y: 0, pressure: 0.5, width: 4 },
      { x: 10, y: 2, pressure: 0.5, width: 4 },
      { x: 20, y: -2, pressure: 0.5, width: 4 },
      { x: 30, y: 0, pressure: 0.5, width: 4, isCorner: true },
      { x: 30, y: 30, pressure: 0.5, width: 4 },
    ];
    const smoothed = applyCspPostCorrection(pts, 4, true);
    expect(smoothed[0].x).toBe(0);
    expect(smoothed[0].y).toBe(0);
    expect(smoothed[3].x).toBe(30);
    expect(smoothed[3].y).toBe(0);
    expect(smoothed[4].x).toBe(30);
    expect(smoothed[4].y).toBe(30);
    // Jittered interior point y=2 should be damped toward 0
    expect(Math.abs(smoothed[1].y)).toBeLessThan(2);
  });

  it('applies stroke-silhouette watercolor edge darkening at outer rim without fish-scale interior artifacts', () => {
    const w = 24;
    const h = 24;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 4; y < 20; y++) {
      for (let x = 4; x < 20; x++) {
        const p = (y * w + x) * 4;
        data[p] = 200;
        data[p + 1] = 150;
        data[p + 2] = 100;
        data[p + 3] = 180;
      }
    }
    applyCspWatercolorEdge({ data, width: w, height: h }, 0.9, 2, 0.7, 0.6);

    const centerIdx = (12 * w + 12) * 4;
    const rimIdx = (4 * w + 12) * 4;
    // Deep center remains untouched while outer rim darkens and concentrates alpha
    expect(data[centerIdx]).toBe(200);
    expect(data[centerIdx + 3]).toBe(180);
    expect(data[rimIdx]).toBeLessThan(200);
    expect(data[rimIdx + 3]).toBeGreaterThan(180);
  });

  it('steps brush size presets cleanly and exposes G-Pen builtin preset', () => {
    expect(stepBrushSizePreset(10, 1)).toBe(12);
    expect(stepBrushSizePreset(10, -1)).toBe(8);
    expect(stepBrushSizePreset(0.5, -1)).toBe(0.5);
    expect(stepBrushSizePreset(2000, 1)).toBe(2000);
    expect(BUILTIN_BRUSHES.map((b) => b.id)).toContain('g-pen');
    expect(BUILTIN_BRUSHES.length).toBe(17);
  });
});
