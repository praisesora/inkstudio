import {
  PRESSURE_CURVE_PRESETS,
  PressureCurvePoint,
  PressureCurvePreset,
  PressureCurveSettings,
} from '../types/settings';
import { evaluateFastSpline } from '../engine/CspBrushEngine';

export { PRESSURE_CURVE_PRESETS };

const MIN_POINT_SPACING_X = 0.02;

/**
 * Clamps, sorts, and deduplicates pressure curve control points while pinning endpoints at x=0 and x=1.
 */
export function sanitizePressureCurvePoints(
  points: readonly PressureCurvePoint[]
): PressureCurvePoint[] {
  if (!points || points.length < 2) {
    return [
      [0, 0],
      [1, 1],
    ];
  }

  const clamped: PressureCurvePoint[] = points
    .filter(
      (p) =>
        Array.isArray(p) &&
        p.length >= 2 &&
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1])
    )
    .map(([x, y]) => [
      Math.max(0, Math.min(1, x)),
      Math.max(0, Math.min(1, y)),
    ]);

  if (clamped.length < 2) {
    return [
      [0, 0],
      [1, 1],
    ];
  }

  clamped.sort((a, b) => a[0] - b[0]);

  const dedup: PressureCurvePoint[] = [clamped[0]];
  for (let i = 1; i < clamped.length; i++) {
    const prev = dedup[dedup.length - 1];
    if (clamped[i][0] - prev[0] >= MIN_POINT_SPACING_X) {
      dedup.push(clamped[i]);
    } else if (i === clamped.length - 1) {
      dedup[dedup.length - 1] = clamped[i];
    }
  }

  if (dedup.length < 2) {
    return [
      [0, dedup[0][1]],
      [1, dedup[0][1]],
    ];
  }

  // Ensure endpoints span [0, 1]
  if (dedup[0][0] > 0.001) {
    dedup.unshift([0, dedup[0][1]]);
  } else {
    dedup[0] = [0, dedup[0][1]];
  }
  const lastIdx = dedup.length - 1;
  if (dedup[lastIdx][0] < 0.999) {
    dedup.push([1, dedup[lastIdx][1]]);
  } else {
    dedup[lastIdx] = [1, dedup[lastIdx][1]];
  }

  return dedup;
}

/**
 * Fast identity check to avoid unnecessary LUT lookups on default linear curve.
 */
export function isLinearPressureCurve(points?: readonly PressureCurvePoint[] | null): boolean {
  if (!points || points.length < 2) return true;
  if (points.length !== 2) return false;
  return (
    Math.abs(points[0][0]) < 1e-4 &&
    Math.abs(points[0][1]) < 1e-4 &&
    Math.abs(points[1][0] - 1) < 1e-4 &&
    Math.abs(points[1][1] - 1) < 1e-4
  );
}

/**
 * Evaluates the global stylus pressure curve in O(1) via precompiled 256-entry PCHIP spline LUT.
 * Input & output are clamped to [0, 1].
 */
export function evaluateGlobalPressureCurve(
  rawPressure: number,
  settings?: PressureCurveSettings | null
): number {
  if (!Number.isFinite(rawPressure) || rawPressure <= 0) return 0;
  const clamped = rawPressure >= 1 ? 1 : rawPressure;
  if (!settings || !settings.enabled || isLinearPressureCurve(settings.points)) {
    return clamped;
  }
  return evaluateFastSpline(clamped, settings.points);
}

/**
 * Samples the curve into N+1 points for SVG/Canvas plotting.
 */
export function samplePressureCurve(
  settings?: PressureCurveSettings | null,
  steps: number = 64
): PressureCurvePoint[] {
  const n = Math.max(2, Math.floor(steps));
  const out: PressureCurvePoint[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    out[i] = [x, evaluateGlobalPressureCurve(x, settings)];
  }
  return out;
}

/**
 * Creates a fresh preset PressureCurveSettings object.
 */
export function createPressureCurvePreset(
  preset: Exclude<PressureCurvePreset, 'custom'>,
  enabled: boolean = true
): PressureCurveSettings {
  const pts = PRESSURE_CURVE_PRESETS[preset];
  return {
    enabled,
    preset,
    points: pts.map(([x, y]) => [x, y] as PressureCurvePoint),
  };
}

/**
 * Computes effective stroke/dab opacity modulated by pressure and optional global pressure curve.
 */
export function calculatePressureOpacity(
  baseOpacity: number,
  pressure: number,
  usePressure: boolean,
  minOpacityFactor: number = 0.0,
  globalCurve?: PressureCurveSettings | null
): number {
  const safeBase = Math.max(0, Math.min(1, Number.isFinite(baseOpacity) ? baseOpacity : 1));
  if (!usePressure) return safeBase;
  const p = globalCurve
    ? evaluateGlobalPressureCurve(pressure, globalCurve)
    : Math.max(0, Math.min(1, Number.isFinite(pressure) ? pressure : 0));
  const minFloor = Math.max(0, Math.min(1, minOpacityFactor));
  return Math.max(0, Math.min(1, safeBase * (minFloor + (1 - minFloor) * p)));
}
