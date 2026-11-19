import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculatePressureOpacity,
  createPressureCurvePreset,
  evaluateGlobalPressureCurve,
  isLinearPressureCurve,
  samplePressureCurve,
  sanitizePressureCurvePoints,
} from '../pressureCurve';
import { calculateStrokeWidth } from '../canvasUtils';
import { POINTER_TYPE_PEN, StrokePipeline } from '../../engine/StrokePipeline';
import {
  DEFAULT_APP_SETTINGS,
  PressureCurveSettings,
  loadAppSettings,
  saveAppSettings,
} from '../../types/settings';

describe('Global Pen Pressure Curve Interpolation', () => {
  beforeEach(() => {
    const storage: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => {
        storage[k] = String(v);
      },
      removeItem: (k: string) => {
        delete storage[k];
      },
      clear: () => {
        Object.keys(storage).forEach((k) => delete storage[k]);
      },
    };
  });

  it('sanitizes control points by clamping, sorting, deduplicating, and pinning endpoints', () => {
    const clean = sanitizePressureCurvePoints([
      [0.8, 1.5],
      [0.2, -0.2],
      [0.205, 0.4],
      [0.5, 0.6],
    ]);
    expect(clean[0][0]).toBe(0);
    expect(clean[clean.length - 1][0]).toBe(1);
    for (let i = 1; i < clean.length; i++) {
      expect(clean[i][0]).toBeGreaterThan(clean[i - 1][0]);
    }
    for (const [x, y] of clean) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(1);
    }
  });

  it('evaluates Linear, Soft, and Hard presets monotonically within [0, 1]', () => {
    const linear = createPressureCurvePreset('linear');
    const soft = createPressureCurvePreset('soft');
    const hard = createPressureCurvePreset('hard');

    expect(isLinearPressureCurve(linear.points)).toBe(true);
    expect(isLinearPressureCurve(soft.points)).toBe(false);
    expect(isLinearPressureCurve(hard.points)).toBe(false);

    // Mid-pressure comparison: Soft > Linear > Hard
    const midSoft = evaluateGlobalPressureCurve(0.4, soft);
    const midLinear = evaluateGlobalPressureCurve(0.4, linear);
    const midHard = evaluateGlobalPressureCurve(0.4, hard);

    expect(midLinear).toBeCloseTo(0.4, 4);
    expect(midSoft).toBeGreaterThan(midLinear + 0.15);
    expect(midHard).toBeLessThan(midLinear - 0.15);

    // Monotonicity & bounds check across all presets
    for (const curve of [linear, soft, hard]) {
      const samples = samplePressureCurve(curve, 50);
      expect(samples[0][1]).toBeCloseTo(0, 3);
      expect(samples[samples.length - 1][1]).toBeCloseTo(1, 3);
      for (let i = 1; i < samples.length; i++) {
        expect(samples[i][1]).toBeGreaterThanOrEqual(samples[i - 1][1] - 1e-4);
        expect(samples[i][1]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('bypasses custom points when curve is disabled', () => {
    const disabledSoft: PressureCurveSettings = {
      ...createPressureCurvePreset('soft'),
      enabled: false,
    };
    expect(evaluateGlobalPressureCurve(0.35, disabledSoft)).toBeCloseTo(0.35, 5);
  });

  it('alters both stroke thickness and opacity across Soft, Linear, and Hard curves', () => {
    const soft = createPressureCurvePreset('soft');
    const linear = createPressureCurvePreset('linear');
    const hard = createPressureCurvePreset('hard');

    const rawP = 0.4;
    const pSoft = evaluateGlobalPressureCurve(rawP, soft);
    const pLinear = evaluateGlobalPressureCurve(rawP, linear);
    const pHard = evaluateGlobalPressureCurve(rawP, hard);

    const wSoft = calculateStrokeWidth(40, pSoft, 0.1, true, 'pen');
    const wLinear = calculateStrokeWidth(40, pLinear, 0.1, true, 'pen');
    const wHard = calculateStrokeWidth(40, pHard, 0.1, true, 'pen');

    expect(wSoft).toBeGreaterThan(wLinear);
    expect(wLinear).toBeGreaterThan(wHard);

    const opSoft = calculatePressureOpacity(1.0, rawP, true, 0.1, soft);
    const opLinear = calculatePressureOpacity(1.0, rawP, true, 0.1, linear);
    const opHard = calculatePressureOpacity(1.0, rawP, true, 0.1, hard);

    expect(opSoft).toBeGreaterThan(opLinear);
    expect(opLinear).toBeGreaterThan(opHard);
  });

  it('applies configured global pressure curve inside StrokePipeline to alter thickness and opacity', () => {
    const runPipelineWithCurve = (curve: PressureCurveSettings) => {
      const pipeline = new StrokePipeline();
      pipeline.beginStroke({
        stabilizerLevel: 0,
        brushSize: 30,
        globalPressureCurve: curve,
      });
      pipeline.enqueueSample(10, 10, 0.35, 0, 0, 0, 100, POINTER_TYPE_PEN);
      pipeline.enqueueSample(25, 10, 0.35, 0, 0, 0, 116, POINTER_TYPE_PEN);
      pipeline.enqueueSample(40, 10, 0.35, 0, 0, 0, 132, POINTER_TYPE_PEN);

      let lastSample = { pressure: 0, width: 0, opacity: 0 };
      pipeline.drain({
        onPoint: (pt) => {
          lastSample = { pressure: pt.pressure, width: pt.width, opacity: pt.opacity };
        },
      });
      return lastSample;
    };

    const softOut = runPipelineWithCurve(createPressureCurvePreset('soft'));
    const linearOut = runPipelineWithCurve(createPressureCurvePreset('linear'));
    const hardOut = runPipelineWithCurve(createPressureCurvePreset('hard'));

    expect(softOut.pressure).toBeGreaterThan(linearOut.pressure);
    expect(linearOut.pressure).toBeGreaterThan(hardOut.pressure);

    expect(softOut.width).toBeGreaterThan(linearOut.width);
    expect(linearOut.width).toBeGreaterThan(hardOut.width);

    expect(softOut.opacity).toBeGreaterThan(linearOut.opacity);
    expect(linearOut.opacity).toBeGreaterThan(hardOut.opacity);
  });

  it('persists custom pressure curve points in AppSettings', () => {
    const customCurve: PressureCurveSettings = {
      enabled: true,
      preset: 'custom',
      points: [
        [0, 0.05],
        [0.3, 0.6],
        [0.7, 0.9],
        [1, 1],
      ],
    };
    saveAppSettings({ ...DEFAULT_APP_SETTINGS, pressureCurve: customCurve });
    const loaded = loadAppSettings();
    expect(loaded.pressureCurve).toEqual(customCurve);
  });
});
