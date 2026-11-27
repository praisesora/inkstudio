/**
 * BrushEngine.ts
 * Unified Brush & Stroke Engine (CSP Mathematics + Paper Grain + WebGL Dispatch + Single CPU Fallback).
 *
 * Consolidates all brush rendering (textured tips, analytical radial tips, pencil presets,
 * color mixing, spray, multi-sensor dynamics, post-correction, and watercolor edge) into one
 * deterministic pipeline: WebGL instanced GPU path first, with a single Canvas2D CPU fallback.
 */

import {
  Point,
  BrushSettings,
  BrushDynamics,
  BrushRenderMode,
  BristleSettings,
  GrainMappingMode,
  ImpastoSettings,
  NaturalMixingMode,
  NaturalPaintSettings,
  SurfaceTextureId,
  ToolType,
  CanvasColorMode,
  CspSensorConfig,
  CspPaperTextureMode,
  CspSubTipOrder,
  CspTipFlipMode,
  CspAngleDynamicsMode,
  CspBlendTipsMode,
  CspBrushCombineMode,
  CspSpraySettings,
  CspTaperSettings,
  CspSubTip,
  CspDualBrushConfig,
  DualBrushCompositeMode,
} from '../types/editor';
import { enforceColorMode } from '../utils/colorUtils';
import { getSurfaceTextureHeightField, SURFACE_TEXTURE_SIZE } from '../utils/proceduralBrushTips';
import { compositeBrushPixelInto, isCustomBrushCombineMode } from '../utils/tileEngine/strokeComposite';
import {
  PaintReservoir,
  SpatialTipMixer,
  LayerPixelSampler,
  sampleCanvasColor,
  parseColorToRgb,
  rgbToHex,
} from '../utils/colorMixingEngine';
import { GpuDab, WebGlBrushEngine } from './WebGlBrushEngine';
import { performanceManager } from '../utils/performanceManager';
import { isNaturalPaintBrush, renderCompleteNaturalPaintStroke } from './NaturalPaintRenderer';
import {
  isRibbonBrush,
  renderCompleteRibbonStroke,
  RibbonRepeatMode,
} from './RibbonBrushEngine';
import {
  buildSecondaryBrushSettings,
  combineDualBrushAlpha,
  combineDualBrushImageData,
  computeSecondaryBrushSize,
  dualBrushCompositeModeToIndex,
  normalizeDualBrushCompositeMode,
  resolveDualBrushConfig,
  scalePointForSecondaryBrush,
  scalePointsForSecondaryBrush,
  scaleSegmentForSecondaryBrush,
} from './DualBrushEngine';

export {
  buildSecondaryBrushSettings,
  combineDualBrushAlpha,
  combineDualBrushImageData,
  computeSecondaryBrushSize,
  dualBrushCompositeModeToIndex,
  normalizeDualBrushCompositeMode,
  resolveDualBrushConfig,
  scalePointForSecondaryBrush,
  scalePointsForSecondaryBrush,
  scaleSegmentForSecondaryBrush,
};

// ============================================================================
// 1. Types & Unified Brush Render Options
// ============================================================================

export interface BrushRenderOptions {
  size?: number;
  minSizeFactor?: number;
  opacity?: number;
  flow?: number;
  brushDensity?: number;
  adjustDensityByGap?: boolean;
  blendTipsMode?: CspBlendTipsMode;
  brushCombineMode?: CspBrushCombineMode;
  spacing?: number;
  thickness?: number;
  thicknessVertical?: boolean;
  thicknessSensor?: CspSensorConfig;
  flipH?: CspTipFlipMode;
  flipV?: CspTipFlipMode;
  angle?: number; // degrees
  angleDynamics?: CspAngleDynamicsMode;
  rotationRandomScale?: number;
  hardness?: number;
  antiAlias?: number;
  tipImage?: HTMLImageElement;
  isColorTip?: boolean;
  isDualToneTip?: boolean;
  isRibbon?: boolean;
  ribbonRepeatMode?: RibbonRepeatMode;
  pressureCurve?: [number, number][];
  velocityCurve?: [number, number][];
  usePressure?: boolean;
  useTilt?: boolean;
  tiltScale?: number;
  useVelocity?: boolean;
  sizeSensor?: CspSensorConfig;
  opacitySensor?: CspSensorConfig;
  densitySensor?: CspSensorConfig;
  intervalSensor?: CspSensorConfig;
  textureDensitySensor?: CspSensorConfig;
  bristleSplaySensor?: CspSensorConfig;
  paintLoadSensor?: CspSensorConfig;
  grainPenetrationSensor?: CspSensorConfig;
  angleSensor?: CspSensorConfig;
  scatterSensor?: CspSensorConfig;
  subTips?: CspSubTip[];
  subTipOrder?: CspSubTipOrder;
  subTipImages?: HTMLImageElement[];
  spray?: CspSpraySettings;
  taper?: CspTaperSettings;
  colorMixing?: boolean;
  perceptualMixing?: boolean;
  pigmentMixingStrength?: number;
  amountOfPaint?: number;
  densityOfPaint?: number;
  colorStretch?: number;
  amountOfPaintSensor?: CspSensorConfig;
  densityOfPaintSensor?: CspSensorConfig;
  colorStretchSensor?: CspSensorConfig;
  useBlur?: boolean;
  blurStrength?: number;
  mixingMode?: NaturalMixingMode;
  wetEdge?: number;
  wetEdgeRadius?: number;
  wetEdgeAlphaPower?: number;
  wetEdgeValuePower?: number;
  grain?: number;
  textureDensity?: number;
  surfaceTextureId?: SurfaceTextureId;
  grainMappingMode?: GrainMappingMode;
  paperTextureMode?: CspPaperTextureMode;
  paperTextureBrightness?: number;
  paperTextureContrast?: number;
  paperTextureApplyEachPlot?: boolean;
  paperTextureEmphasizeDensity?: boolean;
  paperTextureInverted?: boolean;
  paperTextureImage?: HTMLImageElement;
  paperTextureScale?: number;
  paperTextureRotate?: number;
  /** Internal flag: skip per-dab paper grain when per-stroke texture pass handles it. */
  skipPerDabPaperGrain?: boolean;
  dualBrush?: boolean;
  dualBrushConfig?: CspDualBrushConfig;
  dualTipDataUrl?: string;
  dualTipImage?: HTMLImageElement;
  dualBrushCompositeMode?: DualBrushCompositeMode | string;
  dualSize?: number;
  dualLinkSize?: boolean;
  dualSpacing?: number;
  dualScale?: number;
  dualThickness?: number;
  dualThicknessVertical?: boolean;
  dualAngle?: number;
  dualAngleDynamics?: CspAngleDynamicsMode;
  dualAngleSensor?: CspSensorConfig;
  dualHardness?: number;
  dualDensity?: number;
  dualSubTips?: CspSubTip[];
  dualSubTipImages?: HTMLImageElement[];
  dualSubTipOrder?: CspSubTipOrder;
  dualFlipH?: CspTipFlipMode;
  dualFlipV?: CspTipFlipMode;
  dualSpray?: CspSpraySettings;
  dualIsRibbon?: boolean;
  dualScatter?: number;
  dualSurfaceTextureId?: SurfaceTextureId;
  dualGrainDepth?: number;
  renderMode?: BrushRenderMode;
  bristle?: BristleSettings;
  naturalPaint?: NaturalPaintSettings;
  impasto?: ImpastoSettings;
  useGpu?: boolean;
  underlyingCanvas?: HTMLCanvasElement;
  sampler?: LayerPixelSampler;
  reservoir?: PaintReservoir;
  isEraser?: boolean;
  isBgEraser?: boolean;
  alphaLocked?: boolean;
  isTransparentInk?: boolean;
  strokeIndex?: number;
  totalLength?: number;
  currentStrokeDist?: number;
  exitSpeed?: number;
  initialAngleRad?: number;
  dynamics?: BrushDynamics;
  secondaryColor?: string;
  strokeJitterColor?: { r: number; g: number; b: number; hex: string };
}

export interface EvaluatedBezierSample {
  x: number;
  y: number;
  width: number;
  pressure: number;
  dx: number;
  dy: number;
  speed: number;
  tiltX: number;
  tiltY: number;
  twist: number;
}

export interface ArcLengthTable {
  totalLength: number;
  distances: number[];
}

// ============================================================================
// 2. Legacy Pencil Preset Mapping (No Separate Pencil Engine)
// ============================================================================

export type LegacyPencilGrade = 'pencil-f' | 'pencil-hb' | 'pencil-2b' | 'pencil-4b';

export const LEGACY_PENCIL_PRESETS: Record<LegacyPencilGrade, Partial<BrushSettings>> = {
  'pencil-f': {
    size: 2.5,
    minSizeFactor: 0.35,
    hardness: 0.85,
    flow: 0.55,
    spacing: 0.08,
    grain: 0.55,
    textureDensity: 0.55,
    useTilt: true,
    tiltScale: 1.15,
    paperTextureMode: 'compare',
    opacitySensor: { usePressure: true, pressureMin: 0.25 },
  },
  'pencil-hb': {
    size: 3.2,
    minSizeFactor: 0.25,
    hardness: 0.75,
    flow: 0.65,
    spacing: 0.07,
    grain: 0.65,
    textureDensity: 0.65,
    useTilt: true,
    tiltScale: 1.25,
    paperTextureMode: 'compare',
    opacitySensor: { usePressure: true, pressureMin: 0.2 },
  },
  'pencil-2b': {
    size: 4.5,
    minSizeFactor: 0.2,
    hardness: 0.65,
    flow: 0.74,
    spacing: 0.06,
    grain: 0.75,
    textureDensity: 0.75,
    useTilt: true,
    tiltScale: 1.4,
    paperTextureMode: 'compare',
    opacitySensor: { usePressure: true, pressureMin: 0.18 },
  },
  'pencil-4b': {
    size: 6.5,
    minSizeFactor: 0.15,
    hardness: 0.5,
    flow: 0.88,
    spacing: 0.05,
    grain: 0.85,
    textureDensity: 0.85,
    useTilt: true,
    tiltScale: 1.6,
    paperTextureMode: 'compare',
    opacitySensor: { usePressure: true, pressureMin: 0.15 },
  },
};

export function getLegacyPencilPresetDefaults(preset?: string): Partial<BrushSettings> | null {
  if (!preset) return null;
  return (LEGACY_PENCIL_PRESETS as Record<string, Partial<BrushSettings>>)[preset] ?? null;
}

/**
 * Resolves legacy pencil-* presets into standard grain + tilt brush settings.
 * Returns the original object untouched for all modern presets.
 */
export function resolveBrushPresetSettings(bs: BrushSettings): BrushSettings {
  if (bs.customTipImage || !bs.preset) return bs;
  const legacy = getLegacyPencilPresetDefaults(bs.preset);
  if (!legacy) return bs;
  return {
    ...legacy,
    ...bs,
    grain: bs.grain ?? legacy.grain,
    textureDensity: bs.textureDensity ?? bs.grain ?? legacy.textureDensity,
    useTilt: bs.useTilt ?? true,
    tiltScale: bs.tiltScale ?? legacy.tiltScale,
    paperTextureMode: bs.paperTextureMode ?? legacy.paperTextureMode,
    opacitySensor: bs.opacitySensor ?? legacy.opacitySensor,
  };
}

// ============================================================================
// 3. Seamless 512x512 Procedural Cold-Press Paper Grain
// ============================================================================

export const GRAIN_SIZE = 512;
const GRAIN_MASK = GRAIN_SIZE - 1;
export const paperGrainTable = new Uint8Array(GRAIN_SIZE * GRAIN_SIZE);

function sfc32(a: number, b: number, c: number, d: number) {
  return function () {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

(function initPaperGrain() {
  const rand = sfc32(0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x8aed2a6b);
  const makeGrid = (res: number) => {
    const g = new Float32Array(res * res);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    return g;
  };
  const samplePeriodic = (grid: Float32Array, res: number, fx: number, fy: number): number => {
    const mask = res - 1;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const ix0 = x0 & mask;
    const iy0 = y0 & mask;
    const ix1 = (ix0 + 1) & mask;
    const iy1 = (iy0 + 1) & mask;
    const v00 = grid[iy0 * res + ix0];
    const v10 = grid[iy0 * res + ix1];
    const v01 = grid[iy1 * res + ix0];
    const v11 = grid[iy1 * res + ix1];
    const top = v00 + (v10 - v00) * sx;
    const bot = v01 + (v11 - v01) * sx;
    return top + (bot - top) * sy;
  };

  const gCoarse = makeGrid(64);
  const gMedium = makeGrid(128);
  const gFine = makeGrid(256);
  const gMicro = makeGrid(512);

  for (let y = 0; y < GRAIN_SIZE; y++) {
    const row = y * GRAIN_SIZE;
    for (let x = 0; x < GRAIN_SIZE; x++) {
      const warpX = x + Math.sin(y * 0.09817477) * 1.4;
      const warpY = y + Math.cos(x * 0.09817477) * 1.4;
      const nCoarse = samplePeriodic(gCoarse, 64, x * 0.125, y * 0.125);
      const nMedium = samplePeriodic(gMedium, 128, warpX * 0.25, warpY * 0.25);
      const nFine = samplePeriodic(gFine, 256, warpX * 0.5, warpY * 0.5);
      const nMicro = gMicro[row + x];
      const combined = nCoarse * 0.28 + nMedium * 0.36 + nFine * 0.24 + nMicro * 0.12;
      const stretched = Math.max(0, Math.min(1, (combined - 0.18) / 0.64));
      const curved = Math.pow(stretched, 1.18);
      paperGrainTable[row + x] = Math.min(255, Math.max(0, Math.round(curved * 255)));
    }
  }

  WebGlBrushEngine.setBuiltinPaperGrain(paperGrainTable, GRAIN_SIZE);
})();

export function getPaperGrain(x: number, y: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const tx = x - fx;
  const ty = y - fy;

  const x0 = (fx & GRAIN_MASK) >>> 0;
  const y0 = (fy & GRAIN_MASK) >>> 0;
  const x1 = ((fx + 1) & GRAIN_MASK) >>> 0;
  const y1 = ((fy + 1) & GRAIN_MASK) >>> 0;

  const v00 = paperGrainTable[y0 * GRAIN_SIZE + x0];
  const v10 = paperGrainTable[y0 * GRAIN_SIZE + x1];
  const v01 = paperGrainTable[y1 * GRAIN_SIZE + x0];
  const v11 = paperGrainTable[y1 * GRAIN_SIZE + x1];

  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return Math.round(top + (bottom - top) * ty);
}

// ============================================================================
// 4. CSP Mathematics, PCHIP LUTs, Sensors, Post-Correction & Watercolor Edge
// ============================================================================

const LUT_SIZE = 256;
const LUT_MAX_IDX = LUT_SIZE - 1;
const curveWeakCache = new WeakMap<readonly [number, number][], Float32Array>();
const curveStringCache = new Map<string, Float32Array>();
const MAX_STRING_CURVE_CACHE = 128;

export function getCompiledCurveLut(curve?: readonly [number, number][]): Float32Array | null {
  if (!curve || curve.length === 0) return null;

  const weakHit = curveWeakCache.get(curve);
  if (weakHit) return weakHit;

  let key = '';
  for (let i = 0; i < curve.length; i++) {
    key += `${curve[i][0].toFixed(4)},${curve[i][1].toFixed(4)};`;
  }
  const strHit = curveStringCache.get(key);
  if (strHit) {
    curveWeakCache.set(curve, strHit);
    return strHit;
  }

  const lut = new Float32Array(LUT_SIZE);
  const pts = curve.slice().sort((a, b) => a[0] - b[0]);
  const dedup: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] - dedup[dedup.length - 1][0] > 1e-5) {
      dedup.push(pts[i]);
    }
  }

  const n = dedup.length;
  if (n === 1) {
    lut.fill(Math.max(0, Math.min(1, dedup[0][1])));
  } else if (n === 2) {
    const [x0, y0] = dedup[0];
    const [x1, y1] = dedup[1];
    const span = Math.max(1e-5, x1 - x0);
    for (let s = 0; s < LUT_SIZE; s++) {
      const x = s / LUT_MAX_IDX;
      if (x <= x0) lut[s] = Math.max(0, Math.min(1, y0));
      else if (x >= x1) lut[s] = Math.max(0, Math.min(1, y1));
      else {
        const t = (x - x0) / span;
        lut[s] = Math.max(0, Math.min(1, y0 + t * (y1 - y0)));
      }
    }
  } else {
    const hArr = new Float64Array(n - 1);
    const deltas = new Float64Array(n - 1);
    const m = new Float64Array(n);
    for (let k = 0; k < n - 1; k++) {
      hArr[k] = Math.max(1e-5, dedup[k + 1][0] - dedup[k][0]);
      deltas[k] = (dedup[k + 1][1] - dedup[k][1]) / hArr[k];
    }
    m[0] = deltas[0];
    for (let k = 1; k < n - 1; k++) {
      if (deltas[k - 1] * deltas[k] <= 0) {
        if (
          k === 1 &&
          Math.abs(deltas[0]) < 1e-6 &&
          hArr[0] < 0.025 &&
          Math.abs(deltas[1]) > 1e-6
        ) {
          // Tiny leading deadzone stub (e.g. (0,0)->(0.0043,0) in CSP effector curves) acts as a
          // shifted origin rather than a plateau that collapses light-pressure slopes to 0.
          m[k] = deltas[1];
        } else if (
          k === n - 2 &&
          Math.abs(deltas[n - 2]) < 1e-6 &&
          hArr[n - 2] < 0.025 &&
          Math.abs(deltas[n - 3]) > 1e-6
        ) {
          m[k] = deltas[n - 3];
        } else {
          m[k] = 0;
        }
      } else {
        // Standard Fritsch-Carlson / Brodlie weighted harmonic mean preserves
        // light-pressure ramps on asymmetric steep-tail CSP effector curves.
        const w1 = 2 * hArr[k] + hArr[k - 1];
        const w2 = hArr[k] + 2 * hArr[k - 1];
        m[k] = (w1 + w2) / (w1 / deltas[k - 1] + w2 / deltas[k]);
      }
    }
    m[n - 1] = deltas[n - 2];

    for (let k = 0; k < n - 1; k++) {
      const dk = deltas[k];
      if (Math.abs(dk) < 1e-6) {
        if (k === 0 && hArr[0] < 0.025) {
          m[0] = 0;
        } else if (k === n - 2 && hArr[n - 2] < 0.025) {
          m[n - 1] = 0;
        } else {
          m[k] = 0;
          m[k + 1] = 0;
        }
      } else {
        const alpha = m[k] / dk;
        const beta = m[k + 1] / dk;
        const sumSq = alpha * alpha + beta * beta;
        if (sumSq > 9) {
          const tau = 3 / Math.sqrt(sumSq);
          m[k] = tau * alpha * dk;
          m[k + 1] = tau * beta * dk;
        }
      }
    }

    let segIdx = 0;
    for (let s = 0; s < LUT_SIZE; s++) {
      const x = s / LUT_MAX_IDX;
      if (x <= dedup[0][0]) {
        lut[s] = Math.max(0, Math.min(1, dedup[0][1]));
        continue;
      }
      if (x >= dedup[n - 1][0]) {
        lut[s] = Math.max(0, Math.min(1, dedup[n - 1][1]));
        continue;
      }
      while (segIdx < n - 2 && x > dedup[segIdx + 1][0]) segIdx++;
      const [x0, y0] = dedup[segIdx];
      const [x1, y1] = dedup[segIdx + 1];
      const h = Math.max(1e-5, x1 - x0);
      const t = (x - x0) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      const y =
        (2 * t3 - 3 * t2 + 1) * y0 +
        (t3 - 2 * t2 + t) * h * m[segIdx] +
        (-2 * t3 + 3 * t2) * y1 +
        (t3 - t2) * h * m[segIdx + 1];
      lut[s] = Math.max(0, Math.min(1, y));
    }
  }

  if (curveStringCache.size >= MAX_STRING_CURVE_CACHE) {
    const oldest = curveStringCache.keys().next().value;
    if (oldest !== undefined) curveStringCache.delete(oldest);
  }
  curveStringCache.set(key, lut);
  curveWeakCache.set(curve, lut);
  return lut;
}

export function evaluateFastSpline(x: number, curve?: readonly [number, number][]): number {
  const clamped = x <= 0 ? 0 : x >= 1 ? 1 : x;
  if (!curve || curve.length === 0) return clamped;
  const lut = getCompiledCurveLut(curve);
  if (!lut) return clamped;

  const pos = clamped * LUT_MAX_IDX;
  const idx = pos | 0;
  if (idx >= LUT_MAX_IDX) return lut[LUT_MAX_IDX];
  const frac = pos - idx;
  return lut[idx] + (lut[idx + 1] - lut[idx]) * frac;
}

export function dabHashFloat(x: number, y: number, dabIndex: number, salt: number): number {
  const ix = (x * 100) | 0;
  const iy = (y * 100) | 0;
  let h =
    (Math.imul(ix, 73856093) ^
      Math.imul(iy, 19349663) ^
      Math.imul(dabIndex + 1, 83492791) ^
      Math.imul(salt + 1, 0x9e3779b9)) |
    0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function evaluateCspSensor(
  sensor: CspSensorConfig | undefined,
  pressure: number,
  tiltMagnitude: number,
  speedPxPerMs: number,
  randomVal: number,
  twistDeg: number = 0,
  strokeDistPx: number = 0
): number {
  if (!sensor) return 1.0;

  let factor = 1.0;
  if (sensor.usePressure) {
    const pMin = Math.max(0, Math.min(1, sensor.pressureMin ?? 0));
    const curvedP = sensor.pressureCurve
      ? evaluateFastSpline(pressure, sensor.pressureCurve)
      : Math.max(0, Math.min(1, pressure));
    factor *= pMin + (1.0 - pMin) * curvedP;
  }
  if (sensor.useTilt) {
    const tMin = Math.max(0, Math.min(1, sensor.tiltMin ?? 0));
    const tMax =
      typeof sensor.tiltMax === 'number' && Number.isFinite(sensor.tiltMax) && sensor.tiltMax > tMin
        ? Math.min(10.0, sensor.tiltMax)
        : 1.0;
    const clampedTilt = Math.max(0, Math.min(1, tiltMagnitude));
    // CSP Tilt curves plot pen altitude on X (0 = flat/tilted, 1 = upright),
    // whereas tiltMagnitude is 0 (upright) -> 1 (flat).
    const curveX = sensor.invertTilt ? clampedTilt : 1.0 - clampedTilt;
    const curvedT = sensor.tiltCurve
      ? evaluateFastSpline(curveX, sensor.tiltCurve)
      : sensor.invertTilt
      ? 1.0 - clampedTilt
      : clampedTilt;
    factor *= tMin + (tMax - tMin) * curvedT;
  }
  if (sensor.useBarrelTwist) {
    const twMin = Math.max(0, Math.min(1, sensor.twistMin ?? 0));
    const twNorm = (((twistDeg % 360) + 360) % 360) / 360;
    factor *= twMin + (1.0 - twMin) * twNorm;
  }
  if (sensor.useVelocity) {
    const vMin = Math.max(0, Math.min(1, sensor.velocityMin ?? 0));
    const vNorm = Math.max(0, Math.min(1, speedPxPerMs / 3.5));
    const vVal = sensor.velocityCurve
      ? evaluateFastSpline(vNorm, sensor.velocityCurve)
      : sensor.invertVelocity !== false
      ? 1.0 - vNorm
      : vNorm;
    factor *= vMin + (1.0 - vMin) * vVal;
  }
  if (sensor.useDistance) {
    const dMin = Math.max(0, Math.min(1, sensor.distanceMin ?? 0));
    const maxDist = Math.max(10, sensor.distanceMaxPx ?? 600);
    const dNorm = Math.max(0, Math.min(1, 1.0 - strokeDistPx / maxDist));
    factor *= dMin + (1.0 - dMin) * dNorm;
  }
  if (sensor.useRandom) {
    const rMin = Math.max(0, Math.min(1, sensor.randomMin ?? 0));
    factor *= rMin + (1.0 - rMin) * Math.max(0, Math.min(1, randomVal));
  }
  const maxFactor =
    sensor.useTilt && typeof sensor.tiltMax === 'number' && Number.isFinite(sensor.tiltMax) && sensor.tiltMax > 1.0
      ? Math.min(10.0, sensor.tiltMax)
      : 1.0;
  return Math.max(0, Math.min(maxFactor, factor));
}

/**
 * Computes normalized linear pen tilt magnitude in [0, 1] from W3C/WinTab (tiltX, tiltY) degrees:
 *   0.0 = vertical/upright (90° altitude), 1.0 = flat/horizontal (0° altitude).
 * Uses exact spherical tilt angle `atan(hypot(tan(tx), tan(ty))) / 90°` so CSP tilt curves
 * (plotted linearly against pen altitude 0..90°) match CSP without sin()-curve distortion.
 */
export function computeCspTiltMagnitude(tiltX: number, tiltY: number): number {
  if (tiltX === 0 && tiltY === 0) return 0;
  const cx = Math.max(-89.9, Math.min(89.9, tiltX));
  const cy = Math.max(-89.9, Math.min(89.9, tiltY));
  const tanX = Math.tan((cx * Math.PI) / 180);
  const tanY = Math.tan((cy * Math.PI) / 180);
  const tiltAngleDeg = (Math.atan(Math.hypot(tanX, tanY)) * 180) / Math.PI;
  return Math.max(0, Math.min(1, tiltAngleDeg / 90));
}

function resolveTiltBehavior(options: BrushRenderOptions): {
  readTiltInput: boolean;
  useSyntheticTiltShading: boolean;
} {
  const hasExplicitCspTiltControl = Boolean(
    options.angleDynamics === 'tilt' ||
      options.sizeSensor?.useTilt ||
      options.opacitySensor?.useTilt ||
      options.densitySensor?.useTilt ||
      options.intervalSensor?.useTilt ||
      options.thicknessSensor?.useTilt ||
      options.textureDensitySensor?.useTilt ||
      options.amountOfPaintSensor?.useTilt ||
      options.densityOfPaintSensor?.useTilt ||
      options.colorStretchSensor?.useTilt
  );
  // Built-in pencil/chalk presets opt into synthetic elliptical side-shading via useTilt + tiltScale > 0.
  // CSP .sut brushes with explicit tilt effectors control size/density/interval/thickness/texture/angle
  // individually and must NEVER trigger synthetic elliptical stretching even if tiltScale defaults to 1.0.
  const useSyntheticTiltShading = Boolean(
    options.useTilt &&
      !hasExplicitCspTiltControl &&
      (typeof options.tiltScale === 'number' ? options.tiltScale > 0 : true)
  );
  const readTiltInput = Boolean(options.useTilt || hasExplicitCspTiltControl);
  return { readTiltInput, useSyntheticTiltShading };
}

export function computeEllipticalStepDistance(
  width: number,
  height: number,
  dabAngleRad: number,
  tangentDx: number,
  tangentDy: number,
  spacingRatio: number,
  minStepPx: number = 0.12
): number {
  const ratio = Math.max(0.003, Math.min(2.0, spacingRatio));
  const w = Math.max(0.1, width);
  const h = Math.max(0.1, height);

  if (Math.abs(w - h) < 1e-2) {
    return Math.max(minStepPx, w * ratio);
  }

  const tLen = Math.hypot(tangentDx, tangentDy);
  if (tLen < 1e-4) {
    return Math.max(minStepPx, Math.min(w, h) * ratio);
  }

  const ux = tangentDx / tLen;
  const uy = tangentDy / tLen;
  const cosA = Math.cos(dabAngleRad);
  const sinA = Math.sin(dabAngleRad);
  const localX = ux * cosA + uy * sinA;
  const localY = -ux * sinA + uy * cosA;

  const denom = Math.hypot(localX / w, localY / h);
  const effectiveDiameter = denom > 1e-5 ? 1.0 / denom : Math.min(w, h);
  return Math.max(minStepPx, effectiveDiameter * ratio);
}

export function computeGapAdjustedAlpha(
  baseAlpha: number,
  spacingRatio: number,
  adjustByGap: boolean = false,
  referenceSpacing: number = 0.08
): number {
  const a = Math.max(0, Math.min(1, baseAlpha));
  if (!adjustByGap || a >= 0.998 || a <= 0.001) return a;
  const ratio = Math.max(0.12, Math.min(4.0, spacingRatio / Math.max(0.01, referenceSpacing)));
  return Math.max(0.002, Math.min(1.0, 1.0 - Math.pow(1.0 - a, ratio)));
}

export function computeSubpixelDabDimensions(
  width: number,
  height: number,
  alpha: number,
  minRenderDim: number = 0.75
): { renderW: number; renderH: number; effAlpha: number } {
  const renderW = Math.max(minRenderDim, width);
  const renderH = Math.max(minRenderDim, height);
  if (width >= minRenderDim && height >= minRenderDim) {
    return { renderW, renderH, effAlpha: alpha };
  }
  const scaleW = width < minRenderDim ? Math.max(0.04, width / renderW) : 1.0;
  const scaleH = height < minRenderDim ? Math.max(0.04, height / renderH) : 1.0;
  return {
    renderW,
    renderH,
    effAlpha: Math.max(0.003, Math.min(1.0, alpha * scaleW * scaleH)),
  };
}

export function getCspAntiAliasFeather(antiAlias: number = 2): number {
  switch (antiAlias) {
    case 0:
      return 0.0;
    case 1:
      return 0.65;
    case 3:
      return 1.95;
    case 2:
    default:
      return 1.15;
  }
}

export function resolveTipFlipSigns(
  flipH: CspTipFlipMode | undefined,
  flipV: CspTipFlipMode | undefined,
  dabSeq: number,
  x: number,
  y: number
): { signX: number; signY: number } {
  let signX = 1;
  let signY = 1;
  if (flipH === 'alternate') signX = (dabSeq & 1) === 0 ? 1 : -1;
  else if (flipH === 'random') signX = dabHashFloat(x, y, dabSeq, 71) < 0.5 ? 1 : -1;
  if (flipV === 'alternate') signY = (dabSeq & 1) === 0 ? 1 : -1;
  else if (flipV === 'random') signY = dabHashFloat(x, y, dabSeq, 73) < 0.5 ? 1 : -1;
  return { signX, signY };
}

/**
 * Computes CSP-accurate dab bounding dimensions so BrushSize always represents the
 * maximum axis of the thickness-scaled tip (preventing tall tips like 56x300 from blowing up).
 */
export function computeTipStampDimensions(
  baseSize: number,
  thickness: number = 1.0,
  thicknessVertical: boolean = false,
  tipW: number = 1,
  tipH: number = 1
): { width: number; height: number } {
  const safeW = tipW > 0 ? tipW : 1;
  const safeH = tipH > 0 ? tipH : 1;
  const effThick = Math.max(0.05, Math.min(20.0, thickness || 1.0));
  const rawW = thicknessVertical ? safeW * effThick : safeW;
  const rawH = thicknessVertical ? safeH : safeH * effThick;
  const maxRaw = Math.max(rawW, rawH, 1e-4);
  return {
    width: (baseSize * rawW) / maxRaw,
    height: (baseSize * rawH) / maxRaw,
  };
}

export function applyCspPaperTextureAlpha(
  tipAlpha: number,
  grainNorm: number,
  textureDensity: number,
  pressure: number,
  mode: CspPaperTextureMode = 'subtract',
  brightness: number = 0,
  contrast: number = 0,
  inverted: boolean = false,
  preserveDensity: boolean = false,
  emphasizeDensity: boolean = false
): number {
  if (textureDensity <= 0.001 || tipAlpha <= 0.001) return tipAlpha;

  let g = inverted ? 1.0 - grainNorm : grainNorm;
  if (emphasizeDensity) {
    g = Math.max(0, Math.min(1, (g - 0.5) * 2.2 + 0.35));
  }
  if (brightness !== 0) g += brightness / 100.0;
  if (contrast !== 0) {
    const cFactor = Math.pow(Math.max(0.05, (contrast + 100.0) / 100.0), 2);
    g = (g - 0.5) * cFactor + 0.5;
  }
  g = Math.max(0, Math.min(1, g));

  const p = Math.max(0, Math.min(1, pressure));
  const heavyExcess = Math.max(0, (p - 0.52) / 0.48);
  const penetration = Math.min(0.92, p * 0.28 + heavyExcess * heavyExcess * 0.64);
  const effDensity = preserveDensity
    ? textureDensity
    : textureDensity * (1.0 - penetration * 0.85);

  switch (mode) {
    case 'normal': {
      const sil = Math.min(1.0, tipAlpha * 4.0);
      return Math.max(0, Math.min(1, tipAlpha * (1.0 - effDensity) + g * sil * effDensity));
    }
    case 'multiply':
      return Math.max(0, Math.min(1, tipAlpha * (1.0 - effDensity * (1.0 - g))));
    case 'subtract': {
      const sub = (1.0 - g) * effDensity;
      return Math.max(0, Math.min(1, tipAlpha - sub * (preserveDensity ? 1.0 : 1.0 - penetration * 0.5)));
    }
    case 'compare': {
      const contactHeight = g * (0.22 + 0.78 * tipAlpha);
      const cutoff = effDensity * 0.68;
      const edgeLow = cutoff - 0.05;
      const edgeHigh = cutoff + 0.16;
      const t = Math.max(0, Math.min(1, (contactHeight - edgeLow) / Math.max(0.01, edgeHigh - edgeLow)));
      return Math.max(0, Math.min(1, tipAlpha * t * t * (3.0 - 2.0 * t)));
    }
    case 'overlay': {
      // CSP Overlay texture mode: carves valleys strongly at light/medium density
      // and retains crisp impasto relief even on solid tips (tipAlpha -> 1.0).
      const dMod = tipAlpha * (1.0 - effDensity * 0.32 * (1.0 - g));
      const ov = dMod < 0.5 ? 2.0 * dMod * g : 1.0 - 2.0 * (1.0 - dMod) * (1.0 - g);
      return Math.max(0, Math.min(1, tipAlpha + (ov - tipAlpha) * effDensity));
    }
    case 'color-burn': {
      const burned = g <= 0.001 ? 0 : Math.max(0, 1.0 - (1.0 - tipAlpha) / g);
      return Math.max(0, Math.min(1, tipAlpha + (burned - tipAlpha) * effDensity));
    }
    case 'linear-burn': {
      const burned = Math.max(0, tipAlpha + g - 1.0);
      return Math.max(0, Math.min(1, tipAlpha + (burned - tipAlpha) * effDensity));
    }
    case 'height': {
      const sil = Math.min(1.0, tipAlpha * 4.0);
      const relief = Math.max(0, Math.min(1, (tipAlpha + g - 0.5) * 1.6)) * sil;
      return Math.max(0, Math.min(1, tipAlpha * (1.0 - effDensity) + relief * effDensity));
    }
    case 'outline': {
      const edgeFactor = 4.0 * tipAlpha * (1.0 - tipAlpha);
      return Math.max(0, Math.min(1, tipAlpha * (1.0 - effDensity * (1.0 - g) * (0.35 + 0.65 * edgeFactor))));
    }
    default:
      return tipAlpha;
  }
}

/**
 * Returns true when a brush should apply its paper texture once at the stroke level
 * (CSP TextureForPlot = 0) instead of cumulatively per dab.
 */
export function needsStrokeLevelPaperTexture(options: {
  paperTextureApplyEachPlot?: boolean;
  grain?: number;
  textureDensity?: number;
  colorMixing?: boolean;
  isEraser?: boolean;
  isBgEraser?: boolean;
}): boolean {
  if (options.paperTextureApplyEachPlot !== false) return false;
  if (options.colorMixing || options.isEraser || options.isBgEraser) return false;
  const density = options.grain ?? options.textureDensity ?? 0;
  return density > 0.005;
}

/**
 * Applies CSP per-stroke paper texture (TextureForPlot = 0) to a rendered stroke ImageData
 * anchored at world coordinate (originX, originY) with optional uniform canvas scale.
 */
export function applyStrokePaperTextureToImageData(
  imgData: { data: Uint8ClampedArray; width: number; height: number },
  originX: number,
  originY: number,
  options: {
    textureDensity?: number;
    grain?: number;
    surfaceTextureId?: SurfaceTextureId;
    paperTextureImage?: HTMLImageElement;
    paperTextureScale?: number;
    paperTextureRotate?: number;
    paperTextureMode?: CspPaperTextureMode;
    paperTextureBrightness?: number;
    paperTextureContrast?: number;
    paperTextureInverted?: boolean;
    paperTextureEmphasizeDensity?: boolean;
    paperTextureApplyEachPlot?: boolean;
    grainPenetrationSensor?: CspSensorConfig;
  },
  surfaceScale: number = 1.0
): void {
  const density = options.grain ?? options.textureDensity ?? 0;
  if (density <= 0.005) return;

  const customPaper = options.paperTextureImage
    ? getCustomPaperLuminance(options.paperTextureImage)
    : null;
  const surfacePaper =
    !customPaper && options.surfaceTextureId
      ? getSurfaceTextureHeightField(options.surfaceTextureId)
      : null;
  const paperData = customPaper ? customPaper.lum : surfacePaper ?? paperGrainTable;
  const paperW = customPaper ? customPaper.width : surfacePaper ? SURFACE_TEXTURE_SIZE : GRAIN_SIZE;
  const paperH = customPaper ? customPaper.height : surfacePaper ? SURFACE_TEXTURE_SIZE : GRAIN_SIZE;
  if (paperW <= 0 || paperH <= 0) return;

  const paperPow2 = (paperW & (paperW - 1)) === 0 && (paperH & (paperH - 1)) === 0;
  const paperMaskW = paperW - 1;
  const paperMaskH = paperH - 1;
  const invScale = 1.0 / Math.max(0.05, options.paperTextureScale ?? 1.0);
  const rotRad = ((options.paperTextureRotate ?? 0) * Math.PI) / 180;
  const hasRot = Math.abs(rotRad) > 1e-4;
  const cosR = hasRot ? Math.cos(rotRad) : 1;
  const sinR = hasRot ? Math.sin(rotRad) : 0;
  const mode = options.paperTextureMode ?? 'multiply';
  const bright = options.paperTextureBrightness ?? 0;
  const contrast = options.paperTextureContrast ?? 0;
  const inv = Boolean(options.paperTextureInverted);
  const emphasize = Boolean(options.paperTextureEmphasizeDensity);
  const preserveDensity = !options.grainPenetrationSensor?.usePressure;
  const invSurfScale = surfaceScale > 1e-4 ? 1.0 / surfaceScale : 1.0;

  const { data, width, height } = imgData;
  const inv255 = 1 / 255;

  for (let y = 0; y < height; y++) {
    const wy = originY + (y + 0.5) * invSurfScale;
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const pOff = (rowOff + x) << 2;
      const aByte = data[pOff + 3];
      if (aByte === 0) continue;

      const wx = originX + (x + 0.5) * invSurfScale;
      let rotX = wx;
      let rotY = wy;
      if (hasRot) {
        rotX = wx * cosR - wy * sinR;
        rotY = wx * sinR + wy * cosR;
      }
      const psx = rotX * invScale - 0.5;
      const psy = rotY * invScale - 0.5;

      const pfx = Math.floor(psx);
      const pfy = Math.floor(psy);
      const ptx = psx - pfx;
      const pty = psy - pfy;
      let px0: number, py0: number, px1: number, py1: number;
      if (paperPow2) {
        px0 = pfx & paperMaskW;
        py0 = pfy & paperMaskH;
        px1 = (px0 + 1) & paperMaskW;
        py1 = (py0 + 1) & paperMaskH;
      } else {
        px0 = ((pfx % paperW) + paperW) % paperW;
        py0 = ((pfy % paperH) + paperH) % paperH;
        px1 = px0 + 1 < paperW ? px0 + 1 : 0;
        py1 = py0 + 1 < paperH ? py0 + 1 : 0;
      }

      const pr0 = py0 * paperW;
      const pr1 = py1 * paperW;
      const pvTop = paperData[pr0 + px0] + (paperData[pr0 + px1] - paperData[pr0 + px0]) * ptx;
      const pvBot = paperData[pr1 + px0] + (paperData[pr1 + px1] - paperData[pr1 + px0]) * ptx;
      const gNorm = (pvTop + (pvBot - pvTop) * pty) * inv255;

      const origAlpha = aByte * inv255;
      const modAlpha = applyCspPaperTextureAlpha(
        origAlpha,
        gNorm,
        density,
        0.5,
        mode,
        bright,
        contrast,
        inv,
        preserveDensity,
        emphasize
      );
      data[pOff + 3] = Math.max(0, Math.min(255, Math.round(modAlpha * 255)));
    }
  }
}

export function applyCspPostCorrection(
  points: Point[],
  level: number = 0,
  preserveSharpCorners: boolean = true
): Point[] {
  const passes = Math.max(0, Math.min(5, Math.round(level)));
  if (passes <= 0 || points.length < 4) return points;

  const current = points.map((p) => ({ ...p }));
  const next = points.map((p) => ({ ...p }));

  for (let pass = 0; pass < passes; pass++) {
    const n = current.length;
    next[0] = { ...current[0] };
    next[n - 1] = { ...current[n - 1] };

    for (let i = 1; i < n - 1; i++) {
      const cur = current[i];
      if (preserveSharpCorners && cur.isCorner) {
        next[i] = { ...cur };
        continue;
      }
      const prev = current[i - 1];
      const nxt = current[i + 1];

      if (preserveSharpCorners) {
        const ax = cur.x - prev.x;
        const ay = cur.y - prev.y;
        const bx = nxt.x - cur.x;
        const by = nxt.y - cur.y;
        const la = Math.hypot(ax, ay);
        const lb = Math.hypot(bx, by);
        if (la > 1.5 && lb > 1.5 && (ax * bx + ay * by) / (la * lb) < 0.35) {
          next[i] = { ...cur };
          continue;
        }
      }

      next[i] = {
        ...cur,
        x: prev.x * 0.25 + cur.x * 0.5 + nxt.x * 0.25,
        y: prev.y * 0.25 + cur.y * 0.5 + nxt.y * 0.25,
        width: prev.width * 0.2 + cur.width * 0.6 + nxt.width * 0.2,
        pressure: prev.pressure * 0.2 + cur.pressure * 0.6 + nxt.pressure * 0.2,
      };
    }

    for (let i = 0; i < n; i++) current[i] = next[i];
  }

  return current;
}

/**
 * Strictly normalizes CSP wet edge alpha/value power into 0..1.
 * Defensively converts legacy/persisted 0..100 values (> 1.0) by dividing by 100.
 */
export function normalizeWetEdgePower01(value: number | undefined, fallback: number = 0): number {
  const v = value !== undefined && Number.isFinite(value) ? value : fallback;
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v > 1.0) return Math.min(1.0, v / 100.0);
  return Math.min(1.0, v);
}

export function applyCspWatercolorEdge(
  strokeImageData: { data: Uint8ClampedArray; width: number; height: number },
  wetEdge: number,
  radiusPx: number = 2.5,
  alphaPower: number = 0.65,
  valuePower: number = 0.55
): void {
  if (wetEdge <= 0.01) return;
  const { data, width, height } = strokeImageData;
  if (width < 3 || height < 3) return;

  const strength = Math.max(0, Math.min(1, wetEdge));
  const r = Math.max(1, Math.min(12, Math.round(radiusPx)));
  const totalPixels = width * height;

  const alphaOrig = new Float32Array(totalPixels);
  const alphaTemp = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    alphaOrig[i] = data[i * 4 + 3] / 255.0;
  }

  // Clean separable 1D Gaussian blur kernel of exact radius `r` (zero interior pollution beyond `r`)
  const sigma = Math.max(0.85, radiusPx * 0.72);
  const twoSigmaSq = 2.0 * sigma * sigma;
  const kernel = new Float32Array(2 * r + 1);
  let kSum = 0;
  for (let k = -r; k <= r; k++) {
    const w = Math.exp(-(k * k) / twoSigmaSq);
    kernel[k + r] = w;
    kSum += w;
  }
  const invKSum = 1.0 / kSum;
  for (let k = 0; k < kernel.length; k++) {
    kernel[k] *= invKSum;
  }

  // Horizontal separable pass
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const sx = x + k < 0 ? 0 : x + k >= width ? width - 1 : x + k;
        acc += alphaOrig[row + sx] * kernel[k + r];
      }
      alphaTemp[row + x] = acc;
    }
  }

  const normAlphaPower = normalizeWetEdgePower01(alphaPower, 0.25);
  const normValuePower = normalizeWetEdgePower01(valuePower, 0.15);
  const aBoost = strength * (0.35 + normAlphaPower * 1.15);
  const vDarken = strength * (0.18 + normValuePower * 0.55);

  // Vertical separable pass + smooth inner rim alpha boost & chroma-preserving pigment darkening
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const idx = y * width + x;
      const origA = alphaOrig[idx];
      // Strictly skip transparent pixels to guarantee zero black-fringe halo
      if (origA <= 0.015) continue;

      let blurredA = 0;
      for (let k = -r; k <= r; k++) {
        const sy = y + k < 0 ? 0 : y + k >= height ? height - 1 : y + k;
        blurredA += alphaTemp[sy * width + x] * kernel[k + r];
      }

      // Normalize rim gradient by local wash opacity so translucent watercolor washes
      // form authentic crisp inner drying rims just like Clip Studio Paint.
      const relDrop = Math.max(0, origA - blurredA) / Math.max(0.22, origA);
      const rawRim = relDrop * 2.2;
      if (rawRim > 0.008) {
        // Smooth edge guard prevents faint antialiased outer pixels from getting dark fringes
        const alphaMask = Math.min(1.0, (origA - 0.015) / 0.085);
        const rim = Math.min(1.0, rawRim) * alphaMask;
        const p = idx * 4;

        const r0 = data[p] / 255.0;
        const g0 = data[p + 1] / 255.0;
        const b0 = data[p + 2] / 255.0;

        const darkScale = Math.max(0.28, 1.0 - rim * vDarken);
        const dr = r0 * darkScale;
        const dg = g0 * darkScale;
        const db = b0 * darkScale;

        // Subtle chroma preservation as pigment concentrates along the drying rim
        const lum = 0.299 * dr + 0.587 * dg + 0.114 * db;
        const satBoost = 1.0 + Math.min(0.32, rim * vDarken * 0.42);
        const outR = Math.max(0, Math.min(r0, lum + (dr - lum) * satBoost));
        const outG = Math.max(0, Math.min(g0, lum + (dg - lum) * satBoost));
        const outB = Math.max(0, Math.min(b0, lum + (db - lum) * satBoost));

        data[p] = Math.round(outR * 255);
        data[p + 1] = Math.round(outG * 255);
        data[p + 2] = Math.round(outB * 255);
        data[p + 3] = Math.round(Math.min(1.0, origA * (1.0 + rim * aBoost)) * 255);
      }
    }
  }
}

export const CSP_PRESSURE_CURVE_PRESETS: Record<string, { label: string; points: [number, number][] }> = {
  linear: { label: 'Linear', points: [[0, 0], [1, 1]] },
  'g-pen': { label: 'G-Pen S-Curve', points: [[0, 0], [0.2, 0.08], [0.55, 0.52], [0.82, 0.88], [1, 1]] },
  soft: { label: 'Soft Touch', points: [[0, 0], [0.25, 0.48], [0.65, 0.84], [1, 1]] },
  firm: { label: 'Firm Nib', points: [[0, 0], [0.35, 0.12], [0.7, 0.48], [1, 1]] },
  chisel: { label: 'Steep Threshold', points: [[0, 0], [0.15, 0.03], [0.45, 0.72], [1, 1]] },
};

// ============================================================================
// 5. Color Dynamics (HSV Jitter)
// ============================================================================

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (max !== min) {
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, v];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hp >= 0 && hp < 1) { r1 = c; g1 = x; }
  else if (hp < 2) { r1 = x; g1 = c; }
  else if (hp < 3) { g1 = c; b1 = x; }
  else if (hp < 4) { g1 = x; b1 = c; }
  else if (hp < 5) { r1 = x; b1 = c; }
  else if (hp < 6) { r1 = c; b1 = x; }

  const m = v - c;
  return [
    Math.max(0, Math.min(1, r1 + m)),
    Math.max(0, Math.min(1, g1 + m)),
    Math.max(0, Math.min(1, b1 + m)),
  ];
}

export function applyColorDynamics(
  primaryRgb: { r: number; g: number; b: number },
  secondaryRgb: { r: number; g: number; b: number },
  dynamics?: BrushDynamics,
  rng: () => number = Math.random
): { r: number; g: number; b: number; hex: string } {
  if (!dynamics || !dynamics.colorJitterEnabled) {
    return {
      r: primaryRgb.r,
      g: primaryRgb.g,
      b: primaryRgb.b,
      hex: rgbToHex(Math.round(primaryRgb.r * 255), Math.round(primaryRgb.g * 255), Math.round(primaryRgb.b * 255)),
    };
  }

  let r = primaryRgb.r;
  let g = primaryRgb.g;
  let b = primaryRgb.b;

  if (dynamics.foregroundBackgroundJitter > 0) {
    const mix = rng() * dynamics.foregroundBackgroundJitter;
    r += (secondaryRgb.r - r) * mix;
    g += (secondaryRgb.g - g) * mix;
    b += (secondaryRgb.b - b) * mix;
  }

  if (dynamics.hueJitter > 0 || dynamics.saturationJitter > 0 || dynamics.brightnessJitter > 0) {
    let [h, s, v] = rgbToHsv(r, g, b);
    if (dynamics.hueJitter > 0) h = (h + (rng() - 0.5) * dynamics.hueJitter * 360 + 360) % 360;
    if (dynamics.saturationJitter > 0) s = Math.max(0, Math.min(1, s * (1.0 + (rng() * 2 - 1) * dynamics.saturationJitter)));
    if (dynamics.brightnessJitter > 0) v = Math.max(0, Math.min(1, v * (1.0 + (rng() * 2 - 1) * dynamics.brightnessJitter)));
    [r, g, b] = hsvToRgb(h, s, v);
  }

  if (dynamics.temperatureJitter && dynamics.temperatureJitter > 0) {
    const shift = (rng() * 2 - 1) * dynamics.temperatureJitter * 0.22;
    r = Math.max(0, Math.min(1, r + shift));
    b = Math.max(0, Math.min(1, b - shift));
  }

  r = Math.max(0, Math.min(1, r));
  g = Math.max(0, Math.min(1, g));
  b = Math.max(0, Math.min(1, b));
  return { r, g, b, hex: rgbToHex(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)) };
}

// ============================================================================
// 6. Cubic Bézier & Centripetal Catmull-Rom Spline Math
// ============================================================================

const sharedBezierSample: EvaluatedBezierSample = {
  x: 0,
  y: 0,
  width: 0,
  pressure: 0,
  dx: 0,
  dy: 0,
  speed: 0,
  tiltX: 0,
  tiltY: 0,
  twist: 0,
};

const peekBezierSample: EvaluatedBezierSample = {
  x: 0,
  y: 0,
  width: 0,
  pressure: 0,
  dx: 0,
  dy: 0,
  speed: 0,
  tiltX: 0,
  tiltY: 0,
  twist: 0,
};

function evalCubicBezierInto(
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  t: number,
  out: EvaluatedBezierSample
): EvaluatedBezierSample {
  const invT = 1.0 - t;
  const invT2 = invT * invT;
  const invT3 = invT2 * invT;
  const t2 = t * t;
  const t3 = t2 * t;
  const b = 3.0 * invT2 * t;
  const c = 3.0 * invT * t2;

  out.x = invT3 * p0.x + b * c1.x + c * c2.x + t3 * p3.x;
  out.y = invT3 * p0.y + b * c1.y + c * c2.y + t3 * p3.y;
  out.width = invT3 * p0.width + b * c1.width + c * c2.width + t3 * p3.width;
  out.pressure = invT3 * p0.pressure + b * c1.pressure + c * c2.pressure + t3 * p3.pressure;
  out.tiltX = invT * (p0.tiltX ?? 0) + t * (p3.tiltX ?? 0);
  out.tiltY = invT * (p0.tiltY ?? 0) + t * (p3.tiltY ?? 0);
  out.twist = invT * (p0.twist ?? 0) + t * (p3.twist ?? 0);

  const dx = 3.0 * invT2 * (c1.x - p0.x) + 6.0 * invT * t * (c2.x - c1.x) + 3.0 * t2 * (p3.x - c2.x);
  const dy = 3.0 * invT2 * (c1.y - p0.y) + 6.0 * invT * t * (c2.y - c1.y) + 3.0 * t2 * (p3.y - c2.y);
  out.dx = dx;
  out.dy = dy;
  out.speed = Math.hypot(dx, dy);
  return out;
}

export function evalCubicBezier(p0: Point, c1: Point, c2: Point, p3: Point, t: number): EvaluatedBezierSample {
  return evalCubicBezierInto(p0, c1, c2, p3, t, {
    x: 0, y: 0, width: 0, pressure: 0, dx: 0, dy: 0, speed: 0, tiltX: 0, tiltY: 0, twist: 0,
  });
}

const _fastArcDistances = new Float64Array(65);

function buildFastArcLengthScratch(p0: Point, c1: Point, c2: Point, p3: Point): { totalLength: number; steps: number } {
  const polyLen =
    Math.hypot(c1.x - p0.x, c1.y - p0.y) +
    Math.hypot(c2.x - c1.x, c2.y - c1.y) +
    Math.hypot(p3.x - c2.x, p3.y - c2.y);
  const steps = Math.max(24, Math.min(64, Math.ceil(polyLen * 0.5)));
  _fastArcDistances[0] = 0;
  let total = 0;
  let prevX = p0.x;
  let prevY = p0.y;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const invT = 1.0 - t;
    const invT2 = invT * invT;
    const invT3 = invT2 * invT;
    const t2 = t * t;
    const t3 = t2 * t;

    const x = invT3 * p0.x + 3.0 * invT2 * t * c1.x + 3.0 * invT * t2 * c2.x + t3 * p3.x;
    const y = invT3 * p0.y + 3.0 * invT2 * t * c1.y + 3.0 * invT * t2 * c2.y + t3 * p3.y;

    total += Math.hypot(x - prevX, y - prevY);
    _fastArcDistances[i] = total;
    prevX = x;
    prevY = y;
  }

  return { totalLength: total, steps };
}

function sampleFastArcLengthInto(
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  targetDist: number,
  totalLength: number,
  steps: number,
  out: EvaluatedBezierSample
): EvaluatedBezierSample {
  if (totalLength <= 0.0001 || targetDist <= 0) return evalCubicBezierInto(p0, c1, c2, p3, 0, out);
  if (targetDist >= totalLength) return evalCubicBezierInto(p0, c1, c2, p3, 1.0, out);

  let low = 0;
  let high = steps - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (_fastArcDistances[mid] <= targetDist) low = mid;
    else high = mid - 1;
  }
  const d0 = _fastArcDistances[low];
  const d1 = _fastArcDistances[low + 1];
  const frac = d1 > d0 ? (targetDist - d0) / (d1 - d0) : 0;
  return evalCubicBezierInto(p0, c1, c2, p3, Math.max(0, Math.min(1.0, (low + frac) / steps)), out);
}

export function buildCubicArcLengthTable(p0: Point, c1: Point, c2: Point, p3: Point): ArcLengthTable {
  const { totalLength, steps } = buildFastArcLengthScratch(p0, c1, c2, p3);
  const distances: number[] = new Array(steps + 1);
  for (let i = 0; i <= steps; i++) distances[i] = _fastArcDistances[i];
  return { totalLength, distances };
}

export function getCubicPointAtArcLength(
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  targetDist: number,
  table: ArcLengthTable
): EvaluatedBezierSample {
  const { totalLength, distances } = table;
  if (totalLength <= 0.0001 || targetDist <= 0) return evalCubicBezier(p0, c1, c2, p3, 0);
  if (targetDist >= totalLength) return evalCubicBezier(p0, c1, c2, p3, 1.0);

  const steps = distances.length - 1;
  let low = 0;
  let high = steps - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (distances[mid] <= targetDist) low = mid;
    else high = mid - 1;
  }
  const d0 = distances[low];
  const d1 = distances[low + 1];
  const frac = d1 > d0 ? (targetDist - d0) / (d1 - d0) : 0;
  return evalCubicBezier(p0, c1, c2, p3, Math.max(0, Math.min(1.0, (low + frac) / steps)));
}

export function centripetalCatmullRomToBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point
): { c1: Point; c2: Point } {
  const rawD01 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const rawD23 = Math.hypot(p3.x - p2.x, p3.y - p2.y);
  const effP0 = p1.isCorner || rawD01 < 1e-3 ? p1 : p0;
  const effP3 = p2.isCorner || rawD23 < 1e-3 ? p2 : p3;

  const d01 = p1.isCorner || rawD01 < 1e-3 ? 0 : rawD01;
  const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const d23 = p2.isCorner || rawD23 < 1e-3 ? 0 : rawD23;

  const dt0 = Math.max(1e-4, Math.sqrt(d01));
  const dt1 = Math.max(1e-4, Math.sqrt(d12));
  const dt2 = Math.max(1e-4, Math.sqrt(d23));

  const t1x = (p1.x - effP0.x) / dt0 - (p2.x - effP0.x) / (dt0 + dt1) + (p2.x - p1.x) / dt1;
  const t1y = (p1.y - effP0.y) / dt0 - (p2.y - effP0.y) / (dt0 + dt1) + (p2.y - p1.y) / dt1;
  const t2x = (p2.x - p1.x) / dt1 - (effP3.x - p1.x) / (dt1 + dt2) + (effP3.x - p2.x) / dt2;
  const t2y = (p2.y - p1.y) / dt1 - (effP3.y - p1.y) / (dt1 + dt2) + (effP3.y - p2.y) / dt2;

  let dx1 = (t1x * dt1) / 3;
  let dy1 = (t1y * dt1) / 3;
  let dx2 = (t2x * dt1) / 3;
  let dy2 = (t2y * dt1) / 3;

  if (d12 > 0.001) {
    const maxHandle = d12 * 0.48;
    const len1 = Math.hypot(dx1, dy1);
    if (len1 > maxHandle) {
      const s = maxHandle / len1;
      dx1 *= s;
      dy1 *= s;
    }
    const len2 = Math.hypot(dx2, dy2);
    if (len2 > maxHandle) {
      const s = maxHandle / len2;
      dx2 *= s;
      dy2 *= s;
    }
  }

  const minP = Math.min(p1.pressure, p2.pressure);
  const maxP = Math.max(p1.pressure, p2.pressure);
  const minW = Math.min(p1.width, p2.width);
  const maxW = Math.max(p1.width, p2.width);

  return {
    c1: {
      x: p1.x + dx1,
      y: p1.y + dy1,
      pressure: Math.max(minP, Math.min(maxP, p1.pressure + (p2.pressure - effP0.pressure) / 6)),
      width: Math.max(minW, Math.min(maxW, p1.width + (p2.width - effP0.width) / 6)),
    },
    c2: {
      x: p2.x - dx2,
      y: p2.y - dy2,
      pressure: Math.max(minP, Math.min(maxP, p2.pressure - (effP3.pressure - p1.pressure) / 6)),
      width: Math.max(minW, Math.min(maxW, p2.width - (effP3.width - p1.width) / 6)),
    },
  };
}

// ============================================================================
// 7. Single General CPU Canvas2D Fallback (Tip Cache, Paper Mask, Stamper)
// ============================================================================

const MAX_CACHE_ENTRIES = 160;
const MAX_RADIAL_MASKS = 96;
const tintedMasterCache = new Map<string, HTMLCanvasElement>();
const radialMaskCache = new Map<string, HTMLCanvasElement>();
const canvasPool: HTMLCanvasElement[] = [];
const sourceIdMap = new WeakMap<object, number>();
let nextSourceId = 1;

function getUniqueSourceKey(source: CanvasImageSource, fallbackPrefix: string): string {
  if (typeof source === 'object' && source !== null) {
    let id = sourceIdMap.get(source);
    if (!id) {
      id = nextSourceId++;
      sourceIdMap.set(source, id);
    }
    return `${fallbackPrefix}_${id}`;
  }
  return fallbackPrefix;
}

function getPooledCanvas(w: number, h: number): HTMLCanvasElement {
  const targetW = Math.max(1, w);
  const targetH = Math.max(1, h);
  for (let i = 0; i < canvasPool.length; i++) {
    const c = canvasPool[i];
    if (c.width === targetW && c.height === targetH) {
      canvasPool.splice(i, 1);
      return c;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  return canvas;
}

function evictOrAllocateMasterCanvas(w: number, h: number): HTMLCanvasElement {
  const targetW = Math.max(1, w);
  const targetH = Math.max(1, h);
  if (tintedMasterCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = tintedMasterCache.keys().next().value;
    if (oldestKey) {
      const canvas = tintedMasterCache.get(oldestKey)!;
      tintedMasterCache.delete(oldestKey);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      return canvas;
    }
  }
  return getPooledCanvas(targetW, targetH);
}

export function getTintedMasterCanvas(
  source: CanvasImageSource,
  sourceKey: string,
  color: string,
  w: number,
  h: number,
  isColorTip: boolean = false,
  isDualToneTip: boolean = false,
  secondaryColor?: string
): HTMLCanvasElement {
  if (isColorTip) {
    const key = `color_${sourceKey}_${w}x${h}`;
    const cached = tintedMasterCache.get(key);
    if (cached) return cached;
    const canvas = evictOrAllocateMasterCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    }
    tintedMasterCache.set(key, canvas);
    return canvas;
  }

  if (isDualToneTip) {
    const primRgb = parseColorToRgb(color);
    const secRgb = parseColorToRgb(secondaryColor || '#ffffff');
    const primHex = rgbToHex(primRgb.r, primRgb.g, primRgb.b);
    const secHex = rgbToHex(secRgb.r, secRgb.g, secRgb.b);
    const key = `dualtone_${sourceKey}_${primHex}_${secHex}_${w}x${h}`;
    const cached = tintedMasterCache.get(key);
    if (cached) return cached;

    const canvas = evictOrAllocateMasterCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (typeof ctx.getImageData === 'function' && typeof ctx.putImageData === 'function') {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      const dr = secRgb.r - primRgb.r;
      const dg = secRgb.g - primRgb.g;
      const db = secRgb.b - primRgb.b;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255.0;
        d[i] = Math.max(0, Math.min(255, Math.round(primRgb.r + dr * lum)));
        d[i + 1] = Math.max(0, Math.min(255, Math.round(primRgb.g + dg * lum)));
        d[i + 2] = Math.max(0, Math.min(255, Math.round(primRgb.b + db * lum)));
      }
      ctx.putImageData(img, 0, 0);
    }

    tintedMasterCache.set(key, canvas);
    return canvas;
  }

  const rgb = parseColorToRgb(color);
  const quantizedHex = rgbToHex(rgb.r & ~1, rgb.g & ~1, rgb.b & ~1);
  const key = `${sourceKey}_${quantizedHex}_${w}x${h}`;
  const cached = tintedMasterCache.get(key);
  if (cached) return cached;

  const canvas = evictOrAllocateMasterCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = quantizedHex;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  tintedMasterCache.set(key, canvas);
  return canvas;
}

export function getTintedTipMaster(
  tipImage: HTMLImageElement,
  color: string,
  isColorTip: boolean = false,
  isDualToneTip: boolean = false,
  secondaryColor?: string
): HTMLCanvasElement {
  const w = tipImage.naturalWidth || tipImage.width || 64;
  const h = tipImage.naturalHeight || tipImage.height || 64;
  return getTintedMasterCanvas(
    tipImage,
    getUniqueSourceKey(tipImage, 'tip'),
    color,
    w,
    h,
    isColorTip,
    isDualToneTip,
    secondaryColor
  );
}

export function getRadialDabMaster(
  hardness: number,
  color: string,
  isEraser: boolean = false,
  targetSize?: number,
  antiAlias: number = 2
): HTMLCanvasElement {
  const clampedH = Math.max(0, Math.min(1.0, hardness));
  const qH = Math.round(clampedH * 20) / 20;
  const aaLevel = Math.max(0, Math.min(3, Math.round(antiAlias)));

  let size = 128;
  let qDiameter = 124;
  if (targetSize !== undefined && targetSize > 0) {
    if (targetSize <= 8) {
      size = 24;
      qDiameter = Math.max(1, Math.round(targetSize));
    } else if (targetSize <= 24) {
      size = 48;
      qDiameter = Math.max(4, Math.round(targetSize / 2) * 2);
    } else if (targetSize <= 64) {
      size = 64;
      qDiameter = Math.max(16, Math.round(targetSize / 4) * 4);
    }
  }

  const aaKeySuffix = aaLevel === 2 ? '' : `_aa${aaLevel}`;
  const maskKey =
    targetSize === undefined ? `${qH}_128${aaKeySuffix}` : `${qH}_${size}_${qDiameter}${aaKeySuffix}`;
  let maskCanvas = radialMaskCache.get(maskKey);
  if (!maskCanvas) {
    if (radialMaskCache.size >= MAX_RADIAL_MASKS) {
      const oldest = radialMaskCache.keys().next().value;
      if (oldest !== undefined) radialMaskCache.delete(oldest);
    }
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = size;
    maskCanvas.height = size;
    const ctx = maskCanvas.getContext('2d');
    if (ctx) {
      const imgData = ctx.createImageData(size, size);
      const data = imgData.data;
      const cx = size / 2;
      const cy = size / 2;
      const radius = size / 2 - 1;
      const aaScale = aaLevel === 0 ? 0 : aaLevel === 1 ? 0.6 : aaLevel === 3 ? 1.65 : 1.0;
      const baseAaTexels =
        qH >= 0.98
          ? 1.15
          : targetSize === undefined
          ? 1.0
          : Math.max(0.85, Math.min(2.4, (radius / Math.max(1.5, qDiameter * 0.5)) * 0.85));
      const aaTexels = baseAaTexels * aaScale;
      const rCore = Math.min(radius - Math.max(0, aaTexels), radius * qH);

      for (let y = 0; y < size; y++) {
        const dy = y - cy + 0.5;
        const rowOffset = y * size * 4;
        for (let x = 0; x < size; x++) {
          const dx = x - cx + 0.5;
          const dist = Math.hypot(dx, dy);
          let alpha = 0;
          if (aaLevel === 0) {
            alpha = dist <= radius ? 1.0 : 0.0;
          } else if (qH >= 0.98) {
            const u = Math.max(0, Math.min(1.0, (radius - dist) / Math.max(0.25, aaTexels) + 0.5));
            alpha = u * u * (3.0 - 2.0 * u);
          } else if (dist <= rCore) {
            alpha = 1.0;
          } else if (dist < radius) {
            const t = (dist - rCore) / Math.max(1e-4, radius - rCore);
            alpha = qH <= 0.05 ? 0.5 * (1.0 + Math.cos(t * Math.PI)) : 1.0 - (3.0 * t * t - 2.0 * t * t * t);
          }

          if (alpha > 0.002) {
            const idx = rowOffset + x * 4;
            data[idx] = 255;
            data[idx + 1] = 255;
            data[idx + 2] = 255;
            data[idx + 3] = Math.round(alpha * 255);
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }
    radialMaskCache.set(maskKey, maskCanvas);
  }

  return getTintedMasterCanvas(maskCanvas, `radial_${maskKey}`, isEraser ? '#000000' : color, size, size);
}

let _compareScratchCanvas: HTMLCanvasElement | null = null;
let _compareScratchCtx: CanvasRenderingContext2D | null = null;

function drawCompareDensityStampCpu(
  ctx: CanvasRenderingContext2D,
  stampSource: CanvasImageSource,
  x: number,
  y: number,
  renderW: number,
  renderH: number,
  angleRad: number,
  effAlpha: number,
  flipX: number,
  flipY: number,
  antiAlias: number
): boolean {
  if (
    typeof document === 'undefined' ||
    typeof ctx.getImageData !== 'function' ||
    typeof ctx.putImageData !== 'function' ||
    !ctx.canvas ||
    ctx.canvas.width <= 0 ||
    ctx.canvas.height <= 0
  ) {
    return false;
  }

  const m =
    typeof ctx.getTransform === 'function'
      ? ctx.getTransform()
      : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  const halfW = renderW * 0.5;
  const halfH = renderH * 0.5;
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  // Compute world-space axis-aligned bounding box of rotated stamp, then map through ctx transform
  const extX = Math.abs(halfW * cosA) + Math.abs(halfH * sinA);
  const extY = Math.abs(halfW * sinA) + Math.abs(halfH * cosA);
  const corners: [number, number][] = [
    [x - extX, y - extY],
    [x + extX, y - extY],
    [x - extX, y + extY],
    [x + extX, y + extY],
  ];
  let dMinX = Infinity;
  let dMinY = Infinity;
  let dMaxX = -Infinity;
  let dMaxY = -Infinity;
  for (let i = 0; i < 4; i++) {
    const wx = corners[i][0];
    const wy = corners[i][1];
    const dx = m.a * wx + m.c * wy + m.e;
    const dy = m.b * wx + m.d * wy + m.f;
    if (dx < dMinX) dMinX = dx;
    if (dy < dMinY) dMinY = dy;
    if (dx > dMaxX) dMaxX = dx;
    if (dy > dMaxY) dMaxY = dy;
  }

  const bx = Math.max(0, Math.floor(dMinX) - 1);
  const by = Math.max(0, Math.floor(dMinY) - 1);
  const ex = Math.min(ctx.canvas.width, Math.ceil(dMaxX) + 1);
  const ey = Math.min(ctx.canvas.height, Math.ceil(dMaxY) + 1);
  const bw = ex - bx;
  const bh = ey - by;
  if (bw <= 0 || bh <= 0 || bw > 2048 || bh > 2048) return false;

  if (!_compareScratchCanvas) {
    _compareScratchCanvas = document.createElement('canvas');
    _compareScratchCanvas.width = Math.max(64, bw);
    _compareScratchCanvas.height = Math.max(64, bh);
    _compareScratchCtx = _compareScratchCanvas.getContext('2d', { willReadFrequently: true });
  } else if (_compareScratchCanvas.width < bw || _compareScratchCanvas.height < bh) {
    _compareScratchCanvas.width = Math.max(_compareScratchCanvas.width, bw);
    _compareScratchCanvas.height = Math.max(_compareScratchCanvas.height, bh);
    _compareScratchCtx = _compareScratchCanvas.getContext('2d', { willReadFrequently: true });
  }
  const sCtx = _compareScratchCtx;
  if (!sCtx || typeof sCtx.getImageData !== 'function') return false;

  sCtx.save();
  if (typeof sCtx.setTransform === 'function') {
    sCtx.setTransform(1, 0, 0, 1, 0, 0);
  }
  sCtx.clearRect(0, 0, bw, bh);
  if (typeof sCtx.setTransform === 'function') {
    sCtx.setTransform(m.a, m.b, m.c, m.d, m.e - bx, m.f - by);
  } else {
    sCtx.translate(m.e - bx, m.f - by);
  }
  if (antiAlias === 0) sCtx.imageSmoothingEnabled = false;
  sCtx.globalCompositeOperation = 'source-over';
  sCtx.globalAlpha = effAlpha;
  sCtx.translate(x, y);
  if (Math.abs(angleRad) >= 0.001) sCtx.rotate(angleRad);
  if ((flipX < 0 || flipY < 0) && typeof sCtx.scale === 'function') {
    sCtx.scale(flipX < 0 ? -1 : 1, flipY < 0 ? -1 : 1);
  }
  sCtx.drawImage(stampSource, -halfW, -halfH, renderW, renderH);
  sCtx.restore();

  const srcData = sCtx.getImageData(0, 0, bw, bh).data;
  let hasSrc = false;
  for (let i = 3; i < srcData.length; i += 4) {
    if (srcData[i] !== 0) {
      hasSrc = true;
      break;
    }
  }
  if (!hasSrc) return false;

  const dstImg = ctx.getImageData(bx, by, bw, bh);
  const dstData = dstImg.data;

  // CSP Compare Density: alpha = max(dstAlpha, srcAlpha); never accumulates translucent self-overlap
  for (let i = 0; i < dstData.length; i += 4) {
    const sa = srcData[i + 3];
    if (sa === 0) continue;
    const da = dstData[i + 3];
    if (sa > da) {
      if (da === 0) {
        dstData[i] = srcData[i];
        dstData[i + 1] = srcData[i + 1];
        dstData[i + 2] = srcData[i + 2];
        dstData[i + 3] = sa;
      } else {
        const blendT = (sa - da) / sa;
        dstData[i] = Math.round(dstData[i] + (srcData[i] - dstData[i]) * blendT);
        dstData[i + 1] = Math.round(dstData[i + 1] + (srcData[i + 1] - dstData[i + 1]) * blendT);
        dstData[i + 2] = Math.round(dstData[i + 2] + (srcData[i + 2] - dstData[i + 2]) * blendT);
        dstData[i + 3] = sa;
      }
    }
  }

  ctx.putImageData(dstImg, bx, by);
  return true;
}

export function drawSingleStamp(
  ctx: CanvasRenderingContext2D,
  stampSource: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
  angleRad: number,
  alpha: number,
  isEraser: boolean = false,
  isBgEraser: boolean = false,
  alphaLocked: boolean = false,
  isTransparentInk: boolean = false,
  flipX: number = 1,
  flipY: number = 1,
  antiAlias: number = 2,
  blendTipsMode?: CspBlendTipsMode
): void {
  if (width < 0.08 || height < 0.08 || alpha <= 0.002) return;

  const minRenderDim = antiAlias === 0 ? 1.0 : 0.75;
  const sub = computeSubpixelDabDimensions(width, height, alpha, minRenderDim);
  const renderW = sub.renderW;
  const renderH = sub.renderH;
  const effAlpha = antiAlias === 0 ? (sub.effAlpha >= 0.45 ? 1.0 : 0) : sub.effAlpha;
  if (effAlpha <= 0.002) return;

  // CSP "Compare density" (blendTipsMode === 'compare'): max(dstAlpha, srcAlpha) inside stroke buffer
  if (
    blendTipsMode === 'compare' &&
    !isEraser &&
    !isBgEraser &&
    !isTransparentInk &&
    !alphaLocked
  ) {
    if (
      drawCompareDensityStampCpu(
        ctx,
        stampSource,
        x,
        y,
        renderW,
        renderH,
        angleRad,
        effAlpha,
        flipX,
        flipY,
        antiAlias
      )
    ) {
      return;
    }
  }

  const targetOp: GlobalCompositeOperation = isBgEraser
    ? 'source-over'
    : isTransparentInk || isEraser
    ? 'destination-out'
    : alphaLocked
    ? 'source-atop'
    : 'source-over';

  const prevSmooth = ctx.imageSmoothingEnabled;
  if (antiAlias === 0 && prevSmooth !== false) ctx.imageSmoothingEnabled = false;

  if (Math.abs(angleRad) < 0.001 && flipX >= 0 && flipY >= 0) {
    const prevAlpha = ctx.globalAlpha;
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = targetOp;
    ctx.globalAlpha = effAlpha;
    const drawX = antiAlias === 0 ? Math.round(x - renderW / 2) : x - renderW / 2;
    const drawY = antiAlias === 0 ? Math.round(y - renderH / 2) : y - renderH / 2;
    ctx.drawImage(stampSource, drawX, drawY, renderW, renderH);
    ctx.globalAlpha = prevAlpha;
    ctx.globalCompositeOperation = prevOp;
    if (antiAlias === 0 && prevSmooth !== false) ctx.imageSmoothingEnabled = prevSmooth;
    return;
  }

  ctx.save();
  ctx.globalCompositeOperation = targetOp;
  ctx.globalAlpha = effAlpha;
  ctx.translate(x, y);
  if (Math.abs(angleRad) >= 0.001) ctx.rotate(angleRad);
  if ((flipX < 0 || flipY < 0) && typeof ctx.scale === 'function') {
    ctx.scale(flipX < 0 ? -1 : 1, flipY < 0 ? -1 : 1);
  }
  ctx.drawImage(stampSource, -renderW / 2, -renderH / 2, renderW, renderH);
  ctx.restore();
  if (antiAlias === 0 && prevSmooth !== false) ctx.imageSmoothingEnabled = prevSmooth;
}

function selectTipIndex(
  tipImages: HTMLImageElement[] | undefined,
  order: CspSubTipOrder = 'sequential',
  dabIndex: number = 0,
  tangentAngle: number = 0,
  x: number = 0,
  y: number = 0
): number {
  if (!tipImages || tipImages.length <= 1) return 0;
  const count = tipImages.length;
  if (order === 'random') return Math.floor(dabHashFloat(x, y, dabIndex, 97) * count) % count;
  if (order === 'random-no-repeat') {
    const cur = Math.floor(dabHashFloat(x, y, dabIndex, 97) * count) % count;
    if (dabIndex > 0) {
      const prev = Math.floor(dabHashFloat(x, y, dabIndex - 1, 97) * count) % count;
      if (cur === prev) return (cur + 1) % count;
    }
    return cur;
  }
  if (order === 'once') return Math.min(dabIndex, count - 1);
  if (order === 'reverse') return (count - 1 - (dabIndex % count)) % count;
  if (order === 'direction') {
    const normAngle = ((tangentAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return Math.floor((normAngle / (2 * Math.PI)) * count) % count;
  }
  return dabIndex % count;
}

function selectTipImage(
  tipImages: HTMLImageElement[] | undefined,
  fallbackTip: HTMLImageElement,
  order: CspSubTipOrder = 'sequential',
  dabIndex: number = 0,
  tangentAngle: number = 0,
  x: number = 0,
  y: number = 0
): HTMLImageElement {
  if (!tipImages || tipImages.length <= 1) {
    return tipImages && tipImages.length === 1 ? tipImages[0] : fallbackTip;
  }
  const idx = selectTipIndex(tipImages, order, dabIndex, tangentAngle, x, y);
  return tipImages[idx] ?? fallbackTip;
}

let _grainScratchCanvas: HTMLCanvasElement | null = null;
let _grainScratchCtx: CanvasRenderingContext2D | null = null;

interface CpuPaperGrainOptions {
  paperTextureMode?: CspPaperTextureMode;
  paperTextureScale?: number;
  paperTextureRotate?: number;
  paperTextureBrightness?: number;
  paperTextureContrast?: number;
  paperTextureInverted?: boolean;
  paperTextureEmphasizeDensity?: boolean;
  preservePaperDensity?: boolean;
  paperTextureImage?: HTMLImageElement;
  surfaceTextureId?: SurfaceTextureId;
  grainMappingMode?: GrainMappingMode;
  strokeDist?: number;
  grainRandomOffsetX?: number;
  grainRandomOffsetY?: number;
  grainRandomRot?: number;
}

/**
 * Exact per-pixel CPU paper grain modulation matching `WebGlBrushEngine.ts` fragment shader
 * across all 9 CSP `TextureCompositeMode` modes, rotation, scale, brightness, contrast,
 * invert, emphasizeDensity, preserveDensity, surfaceTextureId, and dab rotation/flip.
 * Bakes `dabAlpha` before applying non-linear paper modes for <= 3/255 WebGL parity.
 */
function applyCpuPerPixelPaperGrain(
  master: CanvasImageSource,
  worldX: number,
  worldY: number,
  renderW: number,
  renderH: number,
  angleRad: number,
  flipX: number,
  flipY: number,
  dabAlpha: number,
  grainAmount: number,
  pressure: number,
  paperOpts: CpuPaperGrainOptions
): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || grainAmount <= 0.001 || dabAlpha <= 0.002) return null;

  const bufW = Math.max(2, Math.min(256, Math.ceil(renderW)));
  const bufH = Math.max(2, Math.min(256, Math.ceil(renderH)));

  if (!_grainScratchCanvas) {
    _grainScratchCanvas = document.createElement('canvas');
    _grainScratchCanvas.width = bufW;
    _grainScratchCanvas.height = bufH;
    _grainScratchCtx = _grainScratchCanvas.getContext('2d', { willReadFrequently: true });
  } else if (_grainScratchCanvas.width !== bufW || _grainScratchCanvas.height !== bufH) {
    _grainScratchCanvas.width = bufW;
    _grainScratchCanvas.height = bufH;
    _grainScratchCtx = _grainScratchCanvas.getContext('2d', { willReadFrequently: true });
  }
  const sCtx = _grainScratchCtx;
  if (!sCtx || typeof sCtx.getImageData !== 'function' || typeof sCtx.putImageData !== 'function') {
    return null;
  }

  sCtx.save();
  sCtx.globalCompositeOperation = 'source-over';
  sCtx.globalAlpha = 1.0;
  sCtx.clearRect(0, 0, bufW, bufH);
  if (flipX < 0 || flipY < 0) {
    sCtx.translate(flipX < 0 ? bufW : 0, flipY < 0 ? bufH : 0);
    sCtx.scale(flipX < 0 ? -1 : 1, flipY < 0 ? -1 : 1);
  }
  sCtx.drawImage(master, 0, 0, bufW, bufH);
  sCtx.restore();

  const imgData = sCtx.getImageData(0, 0, bufW, bufH);
  const data = imgData.data;

  // Verify the canvas backing store actually rasterized pixels (protects mock Canvas2D unit tests)
  let hasAnyNonZero = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) {
      hasAnyNonZero = true;
      break;
    }
  }
  if (!hasAnyNonZero) return null;

  const customPaper = paperOpts.paperTextureImage
    ? getCustomPaperLuminance(paperOpts.paperTextureImage)
    : null;
  const surfacePaper =
    !customPaper && paperOpts.surfaceTextureId
      ? getSurfaceTextureHeightField(paperOpts.surfaceTextureId)
      : null;
  const paperData = customPaper ? customPaper.lum : surfacePaper ?? paperGrainTable;
  const paperW = customPaper ? customPaper.width : surfacePaper ? SURFACE_TEXTURE_SIZE : GRAIN_SIZE;
  const paperH = customPaper ? customPaper.height : surfacePaper ? SURFACE_TEXTURE_SIZE : GRAIN_SIZE;
  if (paperW <= 0 || paperH <= 0) return null;

  const paperPow2 = (paperW & (paperW - 1)) === 0 && (paperH & (paperH - 1)) === 0;
  const paperMaskW = paperW - 1;
  const paperMaskH = paperH - 1;

  const invScale = 1.0 / Math.max(0.05, paperOpts.paperTextureScale ?? 1.0);
  const rotRad = ((paperOpts.paperTextureRotate ?? 0) * Math.PI) / 180;
  const hasRot = Math.abs(rotRad) > 1e-4;
  const cosR = hasRot ? Math.cos(rotRad) : 1;
  const sinR = hasRot ? Math.sin(rotRad) : 0;

  const mode = paperOpts.paperTextureMode ?? 'subtract';
  const bright = paperOpts.paperTextureBrightness ?? 0;
  const contrast = paperOpts.paperTextureContrast ?? 0;
  const inv = Boolean(paperOpts.paperTextureInverted);
  const emphasize = Boolean(paperOpts.paperTextureEmphasizeDensity);
  const preserveDensity = Boolean(paperOpts.preservePaperDensity);

  const gmMode = paperOpts.grainMappingMode ?? 'canvas-locked';
  const strokeDist = paperOpts.strokeDist ?? 0;
  const randOffX = paperOpts.grainRandomOffsetX ?? 0;
  const randOffY = paperOpts.grainRandomOffsetY ?? 0;
  const randRot = paperOpts.grainRandomRot ?? 0;
  const randCos = gmMode === 'random-per-stroke' ? Math.cos(randRot) : 1;
  const randSin = gmMode === 'random-per-stroke' ? Math.sin(randRot) : 0;

  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const maxDim = Math.max(renderW, renderH);
  const invBufW = 1 / bufW;
  const invBufH = 1 / bufH;
  const inv255 = 1 / 255;

  for (let py = 0; py < bufH; py++) {
    const vNorm = (py + 0.5) * invBufH - 0.5; // [-0.5, 0.5]
    const localY = vNorm * renderH;
    const rowOff = py * bufW;

    for (let px = 0; px < bufW; px++) {
      const pOff = (rowOff + px) << 2;
      const aByte = data[pOff + 3];
      if (aByte === 0) continue;

      const uNorm = (px + 0.5) * invBufW - 0.5; // [-0.5, 0.5]
      const localX = uNorm * renderW;

      let baseX: number;
      let baseY: number;
      if (gmMode === 'brush-aligned') {
        baseX = uNorm * maxDim;
        baseY = vNorm * maxDim;
      } else if (gmMode === 'stroke-flow') {
        baseX = strokeDist + localX;
        baseY = localY;
      } else {
        const wx = worldX + localX * cosA - localY * sinA;
        const wy = worldY + localX * sinA + localY * cosA;
        if (gmMode === 'random-per-stroke') {
          baseX = wx * randCos - wy * randSin + randOffX;
          baseY = wx * randSin + wy * randCos + randOffY;
        } else {
          baseX = wx;
          baseY = wy;
        }
      }

      let rotX = baseX;
      let rotY = baseY;
      if (hasRot) {
        rotX = baseX * cosR - baseY * sinR;
        rotY = baseX * sinR + baseY * cosR;
      }
      const psx = rotX * invScale - 0.5;
      const psy = rotY * invScale - 0.5;

      const pfx = Math.floor(psx);
      const pfy = Math.floor(psy);
      const ptx = psx - pfx;
      const pty = psy - pfy;
      let px0: number, py0: number, px1: number, py1: number;
      if (paperPow2) {
        px0 = pfx & paperMaskW;
        py0 = pfy & paperMaskH;
        px1 = (px0 + 1) & paperMaskW;
        py1 = (py0 + 1) & paperMaskH;
      } else {
        px0 = ((pfx % paperW) + paperW) % paperW;
        py0 = ((pfy % paperH) + paperH) % paperH;
        px1 = px0 + 1 < paperW ? px0 + 1 : 0;
        py1 = py0 + 1 < paperH ? py0 + 1 : 0;
      }

      const pr0 = py0 * paperW;
      const pr1 = py1 * paperW;
      const pvTop = paperData[pr0 + px0] + (paperData[pr0 + px1] - paperData[pr0 + px0]) * ptx;
      const pvBot = paperData[pr1 + px0] + (paperData[pr1 + px1] - paperData[pr1 + px0]) * ptx;
      const gNorm = (pvTop + (pvBot - pvTop) * pty) * inv255;

      // Modulate brush tip profile (0..1) BEFORE scaling by per-dab flow (matching CSP TextureForPlot=1 & SpatialTipMixer)
      const tipAlpha = Math.max(0, Math.min(1, aByte * inv255));
      const modTipAlpha = applyCspPaperTextureAlpha(
        tipAlpha,
        gNorm,
        grainAmount,
        pressure,
        mode,
        bright,
        contrast,
        inv,
        preserveDensity,
        emphasize
      );
      const modAlpha = Math.max(0, Math.min(1, modTipAlpha * dabAlpha));
      data[pOff + 3] = modTipAlpha <= 0.002 ? 0 : Math.max(0, Math.min(255, Math.round(modAlpha * 255)));
    }
  }

  sCtx.putImageData(imgData, 0, 0);
  return _grainScratchCanvas;
}

// ============================================================================
// 8. Unified WebGL Dispatch
// ============================================================================

export function canUseWebGlForBrush(options?: BrushRenderOptions): boolean {
  const perf = performanceManager.getConfig();
  if (perf.renderBackend === 'canvas2d' || !perf.gpuBrushAcceleration) {
    return false;
  }
  const gpu = WebGlBrushEngine.getInstance();
  if (!options) return gpu.isAvailable();
  if (options.useGpu === false) return false;
  if (options.colorMixing) return false;
  if ((options.antiAlias ?? 2) === 0) return false;
  if (
    options.renderMode === 'bristle-ribbon' ||
    options.renderMode === 'bristle-hybrid' ||
    options.naturalPaint?.enabled ||
    options.impasto?.enabled
  ) {
    return false;
  }
  if (options.blendTipsMode === 'compare') {
    const isMultiColor = Boolean(
      options.isColorTip ||
        options.isDualToneTip ||
        options.subTips?.[0]?.isColor ||
        options.subTips?.[0]?.isDualToneTip ||
        options.dynamics?.colorJitterEnabled
    );
    if (isMultiColor || !gpu.supportsBlendMax()) {
      return false;
    }
  }
  return gpu.isAvailable();
}

function buildGpuBrushSettingsFromOptions(
  color: string,
  options: BrushRenderOptions
): BrushSettings & { alphaLocked?: boolean; isBgEraser?: boolean } {
  const isBgEraser = Boolean(options.isBgEraser);
  const grainVal = options.skipPerDabPaperGrain ? 0 : (options.grain ?? options.textureDensity ?? 0);
  return {
    size: options.size ?? 10,
    minSizeFactor: options.minSizeFactor ?? 0,
    color,
    secondaryColor: options.secondaryColor,
    opacity: options.opacity ?? 1.0,
    flow: options.flow ?? 1.0,
    blendTipsMode: options.blendTipsMode,
    brushCombineMode: options.brushCombineMode,
    spacing: options.spacing ?? 0.08,
    usePressure: options.usePressure !== false,
    smoothing: false,
    stabilization: 0,
    hardness: options.hardness ?? 1.0,
    antiAlias: options.antiAlias ?? 2,
    wetEdge: options.wetEdge ?? 0,
    grain: grainVal,
    textureDensity: options.skipPerDabPaperGrain ? 0 : options.textureDensity,
    opacitySensor: options.opacitySensor,
    textureDensitySensor: options.textureDensitySensor,
    grainPenetrationSensor: options.grainPenetrationSensor,
    surfaceTextureId: options.surfaceTextureId,
    grainMappingMode: options.grainMappingMode,
    paperTextureMode: options.paperTextureMode,
    paperTextureBrightness: options.paperTextureBrightness,
    paperTextureContrast: options.paperTextureContrast,
    paperTextureApplyEachPlot: options.paperTextureApplyEachPlot,
    paperTextureEmphasizeDensity: options.paperTextureEmphasizeDensity,
    paperTextureInverted: options.paperTextureInverted,
    paperTextureImage: options.paperTextureImage,
    paperTextureScale: options.paperTextureScale,
    paperTextureRotate: options.paperTextureRotate,
    customTipImage: options.tipImage,
    isColorTip: options.isColorTip,
    isDualToneTip: options.isDualToneTip,
    subTips: options.subTips,
    subTipImages: options.subTipImages,
    naturalPaint: options.naturalPaint,
    colorMixing: false,
    isTransparentInk: Boolean(options.isTransparentInk),
    alphaLocked: Boolean(options.alphaLocked),
    isBgEraser,
  };
}

export function flushGpuDabs(
  ctx: CanvasRenderingContext2D,
  dabs: GpuDab[],
  color: string,
  options: BrushRenderOptions
): boolean {
  if (dabs.length === 0) return true;
  const gpu = WebGlBrushEngine.getInstance();
  if (!gpu.isAvailable()) return false;

  const isEraser = Boolean(options.isEraser);
  const isBgEraser = Boolean(options.isBgEraser);
  const tool: ToolType = isEraser || isBgEraser ? 'eraser' : 'brush';
  const settings = buildGpuBrushSettingsFromOptions(color, options);

  const docW = options.underlyingCanvas?.width || ctx.canvas?.width || 1024;
  const docH = options.underlyingCanvas?.height || ctx.canvas?.height || 1024;
  return gpu.renderDabsToContext(ctx, dabs, settings, tool, docW, docH, options.underlyingCanvas);
}

// ============================================================================
// 9. Unified Dab & Stroke Renderer (Textured, Radial & Pencil Presets)
// ============================================================================

const _customGrainLumCache = new WeakMap<
  HTMLImageElement,
  { width: number; height: number; lum: Uint8Array }
>();

export function getCustomPaperLuminance(
  img: HTMLImageElement
): { width: number; height: number; lum: Uint8Array } | null {
  const cached = _customGrainLumCache.get(img);
  if (cached) return cached;
  if (typeof document === 'undefined') return null;
  if (img.complete === false) return null;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (w <= 0 || h <= 0) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const gCtx = c.getContext('2d', { willReadFrequently: true });
  if (!gCtx || typeof gCtx.getImageData !== 'function') return null;
  gCtx.drawImage(img, 0, 0, w, h);
  const d = gCtx.getImageData(0, 0, w, h).data;
  const lum = new Uint8Array(w * h);
  for (let i = 0; i < lum.length; i++) {
    const p = i << 2;
    const aNorm = d[p + 3] / 255;
    const rgbLum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    // CSP paper textures encode density in alpha with RGB=0; composite over white to recover height
    lum[i] = Math.round(rgbLum * aNorm + 255 * (1 - aNorm));
  }
  const entry = { width: w, height: h, lum };
  _customGrainLumCache.set(img, entry);
  return entry;
}

export function evaluateCspTaperFactors(
  taper: CspTaperSettings | undefined,
  strokeDist: number,
  totalLength: number | undefined,
  exitSpeed?: number
): { sizeScale: number; alphaScale: number; amountScale: number; paintDensityScale: number } {
  if (!taper || taper.inOutType === 0 || (!taper.useIn && !taper.useOut)) {
    return { sizeScale: 1.0, alphaScale: 1.0, amountScale: 1.0, paintDensityScale: 1.0 };
  }

  const inSharp = 0.35 + (1.0 - (taper.startingSharpness ?? 0.5)) * 1.1;
  const outSharp = 0.35 + (1.0 - (taper.endingSharpness ?? 0.5)) * 1.1;
  const minSize = Math.max(0, Math.min(1, taper.minSizeRatio ?? 0));
  const minDens = Math.max(0, Math.min(1, taper.minDensityRatio ?? 0));
  const minAmount = Math.max(0, Math.min(1, taper.minAmountRatio ?? 0));
  const minPaintDens = Math.max(0, Math.min(1, taper.minPaintDensityRatio ?? 0));
  const affectSize = taper.affectSize !== false;
  const affectFlow = Boolean(taper.affectDensity || taper.affectOpacity);
  const affectAmount = Boolean(taper.affectAmountOfPaint || taper.affectOpacity);
  const affectPaintDensity = Boolean(taper.affectDensityOfPaint);

  // CSP BrushInOutType enum:
  //  0 = Off
  //  1 = Specify by percentage (inRatio / outRatio of totalLength)
  //  2 = Specify by length (inLength px at start, outLength px at END — never kills mid-stroke!)
  //  3 = Fade (continuous decay from strokeDist=0 over outLength px)
  if (taper.inOutType === 3 && taper.useOut) {
    const fadeLen = taper.outLength > 0 ? taper.outLength : 200;
    const remain = Math.max(0, Math.min(1, 1.0 - strokeDist / fadeLen));
    return {
      sizeScale: affectSize ? minSize + (1.0 - minSize) * remain : 1.0,
      alphaScale: affectFlow ? minDens + (1.0 - minDens) * Math.pow(remain, 1.1) : 1.0,
      amountScale: affectAmount ? minAmount + (1.0 - minAmount) * remain : 1.0,
      paintDensityScale: affectPaintDensity ? minPaintDens + (1.0 - minPaintDens) * remain : 1.0,
    };
  }

  const usePercentage = taper.inOutType === 1 && (taper.inRatio > 0 || taper.outRatio > 0);

  let inLen = 0;
  if (taper.useIn) {
    if (usePercentage && totalLength && totalLength > 0) {
      inLen = totalLength * Math.max(0, Math.min(1, taper.inRatio));
    } else {
      inLen = taper.inLength > 0 ? taper.inLength : taper.inRatio > 0 ? taper.inRatio * 120 : 0;
    }
    if (taper.inOutBySpeed) {
      // Pen lands near zero entry velocity in CSP "Starting and ending by speed"
      inLen *= 0.15;
    }
  }

  let outLen = 0;
  if (taper.useOut && totalLength && totalLength > 0) {
    if (usePercentage) {
      outLen = totalLength * Math.max(0, Math.min(1, taper.outRatio));
    } else {
      outLen = taper.outLength > 0 ? taper.outLength : taper.outRatio > 0 ? taper.outRatio * 180 : 0;
    }
    if (taper.inOutBySpeed && exitSpeed !== undefined && Number.isFinite(exitSpeed)) {
      // Faster flick exits stretch the ending taper toward full outLength; deliberate stops stay crisp
      const speedNorm = Math.max(0, Math.min(1, exitSpeed / 1.1));
      outLen *= 0.35 + 0.65 * speedNorm;
    }
    if (inLen + outLen > totalLength && inLen + outLen > 0) {
      const ratio = totalLength / (inLen + outLen);
      inLen *= ratio;
      outLen *= ratio;
    }
  }

  let sizeScale = 1.0;
  let alphaScale = 1.0;
  let amountScale = 1.0;
  let paintDensityScale = 1.0;

  if (taper.useIn && inLen > 0 && strokeDist < inLen) {
    const u = Math.max(0.08, Math.min(1.0, strokeDist / inLen));
    const smoothU = u * u * (3 - 2 * u);
    const t = Math.pow(smoothU, inSharp);
    if (affectSize) sizeScale *= minSize + (1.0 - minSize) * t;
    if (affectFlow) alphaScale *= minDens + (1.0 - minDens) * t;
    if (affectAmount) amountScale *= minAmount + (1.0 - minAmount) * t;
    if (affectPaintDensity) paintDensityScale *= minPaintDens + (1.0 - minPaintDens) * t;
  }

  if (taper.useOut && outLen > 0 && totalLength && totalLength > 0) {
    const distFromEnd = Math.max(0, totalLength - strokeDist);
    if (distFromEnd < outLen) {
      const u = Math.max(0.0, Math.min(1.0, distFromEnd / outLen));
      const smoothU = u * u * (3 - 2 * u);
      const t = Math.pow(smoothU, outSharp);
      if (affectSize) sizeScale *= minSize + (1.0 - minSize) * t;
      if (affectFlow) alphaScale *= minDens + (1.0 - minDens) * t;
      if (affectAmount) amountScale *= minAmount + (1.0 - minAmount) * t;
      if (affectPaintDensity) paintDensityScale *= minPaintDens + (1.0 - minPaintDens) * t;
    }
  }

  return { sizeScale, alphaScale, amountScale, paintDensityScale };
}

function sampleScalarPaperGrainNorm(x: number, y: number, width: number, scale: number): number {
  const invScale = 1.0 / Math.max(0.1, scale);
  const sx = x * invScale;
  const sy = y * invScale;
  if (width > 3.0) {
    const off = width * 0.25 * invScale;
    const avg =
      (getPaperGrain(sx, sy) * 2 +
        getPaperGrain(sx - off, sy - off) +
        getPaperGrain(sx + off, sy - off) +
        getPaperGrain(sx - off, sy + off) +
        getPaperGrain(sx + off, sy + off)) /
      6;
    return avg / 255.0;
  }
  return getPaperGrain(sx, sy) / 255.0;
}

function resolveCpuMaster(
  activeTip: HTMLImageElement | undefined,
  color: string,
  hardness: number,
  isEraser: boolean,
  isBgEraser: boolean,
  isColorTip: boolean,
  targetWidth: number,
  aaMode: number,
  isDualToneTip: boolean = false,
  secondaryColor?: string
): HTMLCanvasElement {
  if (activeTip) {
    return getTintedTipMaster(activeTip, color, isColorTip, isDualToneTip, secondaryColor);
  }
  return getRadialDabMaster(hardness, color, isEraser && !isBgEraser, targetWidth, aaMode);
}

function sampleAndMixColor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  pressure: number,
  flow: number,
  stepDist: number,
  options: BrushRenderOptions,
  spacingRatio: number = 0.08,
  dirX: number = 0,
  dirY: number = 0,
  amountOverride?: number,
  densityOverride?: number,
  stretchOverride?: number
): { colorHex: string; alpha: number; r: number; g: number; b: number } {
  const reservoir = options.reservoir!;
  const effPigmentStrength =
    options.perceptualMixing !== false
      ? Math.max(0, Math.min(1, options.pigmentMixingStrength ?? 1.0))
      : 0;
  const usePigmentSample = effPigmentStrength > 0.005;
  let sampled = { r: 255, g: 255, b: 255, a: 0 };
  if (options.sampler) {
    sampled = options.sampler.sampleColor(x, y, radius, usePigmentSample);
  } else {
    const sampleCanvas = options.underlyingCanvas || ctx.canvas;
    const sampleCtx = sampleCanvas ? sampleCanvas.getContext('2d') : null;
    if (sampleCtx) {
      sampled = sampleCanvasColor(sampleCtx, x, y, radius);
    }
  }

  const pressureAlreadyApplied = Boolean(
    options.opacitySensor?.usePressure ||
      options.densitySensor?.usePressure ||
      options.densityOfPaintSensor?.usePressure
  );

  const mixed = reservoir.mixWithCanvas(
    sampled,
    amountOverride !== undefined ? amountOverride : options.amountOfPaint ?? 0.65,
    densityOverride !== undefined ? densityOverride : options.densityOfPaint ?? 0.9,
    stretchOverride !== undefined ? stretchOverride : options.colorStretch ?? 0.75,
    options.mixingMode ?? 'blend',
    pressure,
    flow,
    stepDist,
    options.perceptualMixing !== false,
    pressureAlreadyApplied,
    options.pigmentMixingStrength ?? 1.0
  );

  // Spacing-aware alpha normalization for dense mixing strokes: prevents hard opaque walls
  // at low/medium density or light pressure so transitions glaze & blend smoothly!
  let effectiveAlpha = mixed.alpha;
  if (stepDist > 0 && effectiveAlpha > 0.002 && effectiveAlpha < 0.99 && spacingRatio < 0.2) {
    const overlapExp = Math.max(0.18, Math.min(1.0, spacingRatio * 4.5));
    effectiveAlpha = Math.max(0.004, Math.min(1.0, 1.0 - Math.pow(1.0 - effectiveAlpha, overlapExp)));
  }

  // Deposit strictly behind the sample radius so forward motion reads true underlying canvas
  // (never bulldozing paint ahead or faking canvas alpha on blank canvas), while loops/reversals mix cleanly
  if (options.sampler && effectiveAlpha > 0.002 && (dirX !== 0 || dirY !== 0)) {
    const depRad = Math.max(1, radius * 0.32);
    const trailOffset = radius + depRad + 0.5;
    const depX = x - dirX * trailOffset;
    const depY = y - dirY * trailOffset;
    options.sampler.depositDab(
      depX,
      depY,
      depRad,
      mixed.r,
      mixed.g,
      mixed.b,
      effectiveAlpha * 0.45,
      effPigmentStrength
    );
  }
  return { ...mixed, alpha: effectiveAlpha };
}

/**
 * Renders a single brush dot (pointerdown / single tap) via GPU batching or single CPU fallback.
 */
export function drawBrushDot(
  ctx: CanvasRenderingContext2D,
  point: Point,
  color: string,
  options: BrushRenderOptions = {},
  batchGpuDabs?: GpuDab[]
): void {
  const isEraser = Boolean(options.isEraser);
  const isBgEraser = Boolean(options.isBgEraser);
  const hardness = options.hardness ?? 1.0;
  const thickness = options.thickness ?? 1.0;
  const isVert = Boolean(options.thicknessVertical);
  const aaMode = options.antiAlias ?? 2;
  const spacing = options.spacing ?? 0.08;
  const { readTiltInput, useSyntheticTiltShading } = resolveTiltBehavior(options);
  const grainAmount = options.skipPerDabPaperGrain ? 0 : (options.grain ?? options.textureDensity ?? 0);
  const preservePaperDensity =
    Boolean(options.textureDensitySensor) ||
    (options.paperTextureApplyEachPlot !== undefined && !options.grainPenetrationSensor?.usePressure);

  let effectiveColor = isBgEraser ? '#ffffff' : color;
  const rawDensity = options.brushDensity ?? options.flow ?? (options.tipImage ? 0.85 : 1.0);
  let effectiveFlow = computeGapAdjustedAlpha(rawDensity, spacing, options.adjustDensityByGap);

  const effPressure = Math.max(0, Math.min(1, point.pressure ?? 1.0));
  const curvedPressure = options.pressureCurve ? evaluateFastSpline(effPressure, options.pressureCurve) : effPressure;
  const minFactor = Math.max(0, Math.min(1.0, options.minSizeFactor ?? 0.2));
  let effWidth =
    point.width > 0
      ? Math.max(0.4, point.width)
      : options.usePressure !== false
      ? Math.max(0.5, (options.size ?? 10) * (minFactor + (1.0 - minFactor) * curvedPressure))
      : Math.max(0.5, options.size ?? 10);

  let startAmountScale = 1.0;
  let startPaintDensityScale = 1.0;
  if (options.taper && options.totalLength && options.totalLength > 0) {
    const startTaper = evaluateCspTaperFactors(options.taper, 0, options.totalLength, options.exitSpeed);
    effWidth *= startTaper.sizeScale;
    effectiveFlow *= startTaper.alphaScale;
    startAmountScale = startTaper.amountScale;
    startPaintDensityScale = startTaper.paintDensityScale;
  }

  const tiltX = readTiltInput ? point.tiltX ?? 0 : 0;
  const tiltY = readTiltInput ? point.tiltY ?? 0 : 0;
  const tiltMagnitude = computeCspTiltMagnitude(tiltX, tiltY);
  const tiltSpread = tiltMagnitude * (options.tiltScale ?? 1.0);
  const grainPressure =
    useSyntheticTiltShading && tiltMagnitude > 0.01 ? effPressure * (1.0 - tiltMagnitude * 0.55) : effPressure;
  let effGrainAmount = grainAmount;
  if (grainAmount > 0.005 && options.textureDensitySensor) {
    const tdFactor = evaluateCspSensor(
      options.textureDensitySensor,
      effPressure,
      tiltMagnitude,
      0,
      dabHashFloat(point.x, point.y, 0, 58),
      point.twist ?? 0,
      0
    );
    effGrainAmount = Math.max(0, Math.min(1, grainAmount * tdFactor));
  }

  if (options.sizeSensor) {
    // Avoid double-applying pressure when point.width already has pressure baked from calculateStrokeWidth
    const effectiveSizeSensor =
      point.width > 0 && options.usePressure !== false && options.sizeSensor.usePressure
        ? { ...options.sizeSensor, usePressure: false }
        : options.sizeSensor;
    effWidth = Math.max(
      0.15,
      effWidth * evaluateCspSensor(effectiveSizeSensor, effPressure, tiltMagnitude, 0, dabHashFloat(point.x, point.y, 0, 50))
    );
  }
  const isColorMixing = Boolean(options.colorMixing) && !isEraser && !isBgEraser;
  const hasConcurrentDensityAndPaintDensityPressure = Boolean(
    isColorMixing && options.densitySensor?.usePressure && options.densityOfPaintSensor?.usePressure
  );

  let effDensityOfPaint = (options.densityOfPaint ?? 0.9) * startPaintDensityScale;
  let paintDensitySensorFactor = 1.0;
  if (options.densityOfPaintSensor) {
    paintDensitySensorFactor = evaluateCspSensor(
      options.densityOfPaintSensor,
      effPressure,
      tiltMagnitude,
      0,
      dabHashFloat(point.x, point.y, 0, 56),
      point.twist ?? 0,
      0
    );
    if (!hasConcurrentDensityAndPaintDensityPressure) {
      effDensityOfPaint *= paintDensitySensorFactor;
    } else if (paintDensitySensorFactor <= 0.002) {
      effDensityOfPaint = 0;
    }
  }

  let flowSensorFactor = 1.0;
  if (hasConcurrentDensityAndPaintDensityPressure) {
    // In CSP Color Mixing (Blend), BrushFlowEffector drives per-plot brush density while
    // BrushMixAlphaEffector shapes paint-covering translucency without bottlenecking BrushFlow.
    const dnF = evaluateCspSensor(options.densitySensor, effPressure, tiltMagnitude, 0, dabHashFloat(point.x, point.y, 0, 52));
    flowSensorFactor = dnF;
    if (options.opacitySensor) {
      flowSensorFactor *= evaluateCspSensor(options.opacitySensor, effPressure, tiltMagnitude, 0, dabHashFloat(point.x, point.y, 0, 51));
    }
  } else if (options.opacitySensor && options.densitySensor && (isColorMixing || options.paperTextureApplyEachPlot === false)) {
    const opF = evaluateCspSensor(options.opacitySensor, effPressure, tiltMagnitude, 0, dabHashFloat(point.x, point.y, 0, 51));
    const dnF = evaluateCspSensor(options.densitySensor, effPressure, tiltMagnitude, 0, dabHashFloat(point.x, point.y, 0, 52));
    flowSensorFactor = Math.min(opF, dnF);
  } else {
    if (options.opacitySensor) {
      flowSensorFactor *= evaluateCspSensor(options.opacitySensor, effPressure, tiltMagnitude, 0, dabHashFloat(point.x, point.y, 0, 51));
    }
    if (options.densitySensor) {
      flowSensorFactor *= evaluateCspSensor(options.densitySensor, effPressure, tiltMagnitude, 0, dabHashFloat(point.x, point.y, 0, 52));
    }
  }
  effectiveFlow = Math.max(0, Math.min(1, effectiveFlow * flowSensorFactor));
  if (useSyntheticTiltShading && tiltMagnitude > 0.03 && (options.tipImage || grainAmount > 0.005)) {
    effectiveFlow *= 1.0 - tiltMagnitude * 0.28;
  }

  const gpuDabs = batchGpuDabs || null;
  const activeTip = options.tipImage
    ? selectTipImage(options.subTipImages, options.tipImage, options.subTipOrder, 0, 0, point.x, point.y)
    : undefined;
  const isColorTip = Boolean(options.isColorTip || (options.subTips && options.subTips[0]?.isColor));
  const isDualToneTip = !isColorTip && Boolean(options.isDualToneTip || (options.subTips && options.subTips[0]?.isDualToneTip));
  const tipNaturalW = activeTip ? (activeTip.naturalWidth || activeTip.width || 1) : 1;
  const tipNaturalH = activeTip ? (activeTip.naturalHeight || activeTip.height || 1) : 1;

  let effThickness = thickness;
  if (options.thicknessSensor) {
    // CSP Brush Thickness minimum is 10% (0.10); never collapse below 0.10 unless base thickness itself is thinner.
    const minThicknessFloor = Math.min(thickness, 0.1);
    effThickness = Math.max(
      minThicknessFloor,
      thickness *
        evaluateCspSensor(
          options.thicknessSensor,
          effPressure,
          tiltMagnitude,
          0,
          dabHashFloat(point.x, point.y, 0, 54),
          point.twist ?? 0,
          0
        )
    );
  }

  let effAmountOfPaint = (options.amountOfPaint ?? 0.65) * startAmountScale;
  if (options.amountOfPaintSensor) {
    effAmountOfPaint *= evaluateCspSensor(
      options.amountOfPaintSensor,
      effPressure,
      tiltMagnitude,
      0,
      dabHashFloat(point.x, point.y, 0, 55),
      point.twist ?? 0,
      0
    );
  }
  let effColorStretch = options.colorStretch ?? 0.75;
  if (options.colorStretchSensor) {
    effColorStretch *= evaluateCspSensor(
      options.colorStretchSensor,
      effPressure,
      tiltMagnitude,
      0,
      dabHashFloat(point.x, point.y, 0, 57),
      point.twist ?? 0,
      0
    );
  }

  let angleRad =
    options.initialAngleRad !== undefined
      ? options.initialAngleRad
      : ((options.angle ?? 0) * Math.PI) / 180;
  if (options.angleDynamics === 'tilt' && tiltMagnitude > 0.05) {
    angleRad = Math.atan2(tiltX, -tiltY) + ((options.angle ?? 0) * Math.PI) / 180;
  } else if (useSyntheticTiltShading && tiltMagnitude > 0.05) {
    angleRad = Math.atan2(tiltY, tiltX) + ((options.angle ?? 0) * Math.PI) / 180;
  }
  if (point.twist && (options.angleDynamics === 'twist' || useSyntheticTiltShading)) {
    angleRad += (point.twist * Math.PI) / 180;
  }

  const dynamics = options.dynamics;
  const colorJitterEnabled = Boolean(dynamics?.colorJitterEnabled);
  const colorJitterPerStroke = Boolean(colorJitterEnabled && dynamics?.colorJitterPerStroke);
  if (colorJitterPerStroke && dynamics) {
    if (!options.strokeJitterColor) {
      const prim0 = parseColorToRgb(effectiveColor);
      const sec0 = parseColorToRgb(options.secondaryColor || '#ffffff');
      let salt = 200;
      const strokeIdx = options.strokeIndex ?? 0;
      options.strokeJitterColor = applyColorDynamics(
        { r: prim0.r / 255, g: prim0.g / 255, b: prim0.b / 255 },
        { r: sec0.r / 255, g: sec0.g / 255, b: sec0.b / 255 },
        dynamics,
        () => dabHashFloat(point.x, point.y, strokeIdx, salt++)
      );
    }
    effectiveColor = options.strokeJitterColor.hex;
  }
  const perDabColorJitter = colorJitterEnabled && !colorJitterPerStroke;

  const useSpatialTipMixing =
    isColorMixing &&
    !gpuDabs &&
    !isColorTip &&
    !options.spray?.enabled;

  if (useSpatialTipMixing) {
    if (!options.reservoir) options.reservoir = new PaintReservoir(effectiveColor);
    if (!options.reservoir.spatialMixer) {
      options.reservoir.spatialMixer = new SpatialTipMixer(effectiveColor);
    }
    let freshColorOverride: { r: number; g: number; b: number } | undefined;
    if (perDabColorJitter && dynamics) {
      const prim0 = parseColorToRgb(effectiveColor);
      const sec0 = parseColorToRgb(options.secondaryColor || '#ffffff');
      let salt = 20;
      const cd = applyColorDynamics(
        { r: prim0.r / 255, g: prim0.g / 255, b: prim0.b / 255 },
        { r: sec0.r / 255, g: sec0.g / 255, b: sec0.b / 255 },
        dynamics,
        () => dabHashFloat(point.x, point.y, 0, salt++)
      );
      freshColorOverride = { r: cd.r * 255, g: cd.g * 255, b: cd.b * 255 };
    }
    const pressureAlreadyApplied = Boolean(
      options.opacitySensor?.usePressure ||
        options.densitySensor?.usePressure ||
        options.densityOfPaintSensor?.usePressure
    );
    const tipDims = computeTipStampDimensions(effWidth, effThickness, isVert, tipNaturalW, tipNaturalH);
    let finalW = tipDims.width;
    let finalH = tipDims.height;
    if (useSyntheticTiltShading && tiltMagnitude > 0.01) {
      finalW *= 1.0 + tiltSpread * 1.85;
      finalH *= Math.max(0.55, 1.0 / (1.0 + tiltMagnitude * 0.45));
    }
    const flips = resolveTipFlipSigns(options.flipH, options.flipV, 0, point.x, point.y);
    const customPaper = options.paperTextureImage ? getCustomPaperLuminance(options.paperTextureImage) : null;
    const surfacePaper =
      !customPaper && options.surfaceTextureId ? getSurfaceTextureHeightField(options.surfaceTextureId) : null;
    const texScale = options.paperTextureScale ?? 1.0;
    const texRot = options.paperTextureRotate ?? 0;
    const texMode = options.paperTextureMode ?? 'multiply';
    const texBright = options.paperTextureBrightness ?? 0;
    const texContrast = options.paperTextureContrast ?? 0;
    const texInv = Boolean(options.paperTextureInverted);

    const built = options.reservoir.spatialMixer.stepAndBuildStamp({
      x: point.x,
      y: point.y,
      width: finalW,
      height: finalH,
      angleRad,
      dirX: 0,
      dirY: 0,
      stepDist: 0,
      spacingRatio: spacing,
      adjustDensityByGap: Boolean(options.adjustDensityByGap),
      hardness,
      antiAlias: aaMode,
      flipX: flips.signX,
      flipY: flips.signY,
      flow: effectiveFlow,
      pressure: effPressure,
      pressureAlreadyApplied,
      amountOfPaint: effAmountOfPaint,
      densityOfPaint: effDensityOfPaint,
      colorStretch: effColorStretch,
      isPureBlender: (options.amountOfPaint ?? 0.65) <= 0.005 || options.mixingMode === 'smear',
      mixingMode: options.mixingMode ?? 'blend',
      perceptualMixing: options.perceptualMixing !== false,
      pigmentMixingStrength: options.pigmentMixingStrength ?? 1.0,
      useBlur: Boolean(options.useBlur),
      blurStrength: options.blurStrength,
      tipImage: activeTip,
      isDualToneTip,
      secondaryColor: options.secondaryColor,
      freshColor: freshColorOverride,
      sampler: options.sampler,
      grainDensity: effGrainAmount,
      paperTextureMode: texMode,
      paperLumData:
        effGrainAmount > 0.005 ? (customPaper ? customPaper.lum : surfacePaper ?? paperGrainTable) : undefined,
      paperLumWidth:
        effGrainAmount > 0.005 ? (customPaper ? customPaper.width : surfacePaper ? SURFACE_TEXTURE_SIZE : GRAIN_SIZE) : undefined,
      paperLumHeight:
        effGrainAmount > 0.005 ? (customPaper ? customPaper.height : surfacePaper ? SURFACE_TEXTURE_SIZE : GRAIN_SIZE) : undefined,
      paperTextureScale: texScale,
      paperTextureRotate: texRot,
      paperTextureBrightness: texBright,
      paperTextureContrast: texContrast,
      paperTextureInverted: texInv,
      paperTexturePreserveDensity: preservePaperDensity,
      paperTextureEmphasizeDensity: Boolean(options.paperTextureEmphasizeDensity),
      grainPressure,
    });
    if (built) {
      options.reservoir.r = built.avgR;
      options.reservoir.g = built.avgG;
      options.reservoir.b = built.avgB;
      options.reservoir.a = built.avgA;
      if (built.pickedUpCanvas) options.reservoir.isLoadedWithCanvasColor = true;
    }
    if (built && built.hasVisiblePixels) {
      drawSingleStamp(
        ctx,
        built.canvas,
        point.x,
        point.y,
        built.drawW,
        built.drawH,
        angleRad,
        1.0,
        false,
        false,
        options.alphaLocked,
        options.isTransparentInk,
        1,
        1,
        aaMode,
        options.blendTipsMode
      );
    }
    return;
  }

  if (isColorMixing) {
    if (!options.reservoir) options.reservoir = new PaintReservoir(effectiveColor);
    const mixed = sampleAndMixColor(
      ctx,
      point.x,
      point.y,
      Math.max(1, effWidth * 0.5),
      effPressure,
      effectiveFlow,
      0,
      options,
      spacing,
      0,
      0,
      effAmountOfPaint,
      effDensityOfPaint,
      effColorStretch
    );
    effectiveColor = mixed.colorHex;
    effectiveFlow = mixed.alpha;
  }
  if (effectiveFlow <= 0.002) return;

  const tryPerPixelCpuGrain = !gpuDabs && effGrainAmount > 0.005 && typeof document !== 'undefined';
  const dotSeed = Math.abs(Math.sin(point.x * 12.9898 + point.y * 78.233));
  const dotRandOffX = dotSeed * 256;
  const dotRandOffY = ((dotSeed * 397) % 1) * 256;
  const dotRandRot = Math.abs(Math.cos(point.x * 39.346 + point.y * 11.135)) * Math.PI * 2;
  const dotPaperOpts: CpuPaperGrainOptions = {
    paperTextureMode: options.paperTextureMode ?? 'subtract',
    paperTextureScale: options.paperTextureScale ?? 1.0,
    paperTextureRotate: options.paperTextureRotate ?? 0,
    paperTextureBrightness: options.paperTextureBrightness ?? 0,
    paperTextureContrast: options.paperTextureContrast ?? 0,
    paperTextureInverted: Boolean(options.paperTextureInverted),
    paperTextureEmphasizeDensity: Boolean(options.paperTextureEmphasizeDensity),
    preservePaperDensity,
    paperTextureImage: options.paperTextureImage,
    surfaceTextureId: options.surfaceTextureId,
    grainMappingMode: options.grainMappingMode,
    strokeDist: 0,
    grainRandomOffsetX: dotRandOffX,
    grainRandomOffsetY: dotRandOffY,
    grainRandomRot: dotRandRot,
  };

  const baseMaster = gpuDabs
    ? null
    : resolveCpuMaster(
        activeTip,
        effectiveColor,
        hardness,
        isEraser,
        isBgEraser,
        isColorTip,
        effWidth,
        aaMode,
        isDualToneTip,
        options.secondaryColor
      );

  const dabCount = Math.max(1, Math.min(10, Math.round(dynamics?.count ?? 1)));
  const sizeJitter = Math.max(0, Math.min(1, dynamics?.sizeJitter ?? 0));
  const angleJitter = Math.max(0, Math.min(1, dynamics?.angleJitter ?? 0));
  const roundnessJitter = Math.max(0, Math.min(1, dynamics?.roundnessJitter ?? 0));
  const scatter = Math.max(0, Math.min(5, dynamics?.scatter ?? 0));
  const flowJitter = Math.max(0, Math.min(1, dynamics?.flowJitter ?? 0));
  const primRgb = perDabColorJitter || gpuDabs ? parseColorToRgb(effectiveColor) : null;
  const secRgb = perDabColorJitter ? parseColorToRgb(options.secondaryColor || '#ffffff') : null;

  for (let k = 0; k < dabCount; k++) {
    let curDabW = effWidth;
    if (sizeJitter > 0) curDabW *= Math.max(0.01, 1.0 - dabHashFloat(point.x, point.y, k, 1) * sizeJitter);
    curDabW = Math.max(0.1, curDabW);

    let curDabThickness = effThickness;
    if (roundnessJitter > 0) curDabThickness *= Math.max(0.05, 1.0 - dabHashFloat(point.x, point.y, k, 2) * roundnessJitter);

    let curDabAngle = angleRad;
    if (angleJitter > 0) curDabAngle += (dabHashFloat(point.x, point.y, k, 3) - 0.5) * Math.PI * 2 * angleJitter;

    let curDabX = point.x;
    let curDabY = point.y;
    if (scatter > 0) {
      const th = dabHashFloat(point.x, point.y, k, 4) * Math.PI * 2;
      const sDist = dabHashFloat(point.x, point.y, k, 5) * effWidth * scatter;
      curDabX += Math.cos(th) * sDist;
      curDabY += Math.sin(th) * sDist;
    }

    let curDabAlpha = effectiveFlow;
    if (flowJitter > 0) curDabAlpha *= Math.max(0.005, 1.0 - dabHashFloat(point.x, point.y, k, 6) * flowJitter);

    let curMaster: CanvasImageSource | null = baseMaster;
    let dabR = primRgb ? primRgb.r / 255 : 0;
    let dabG = primRgb ? primRgb.g / 255 : 0;
    let dabB = primRgb ? primRgb.b / 255 : 0;
    if (perDabColorJitter && primRgb && secRgb && dynamics) {
      let salt = 20;
      const cd = applyColorDynamics(
        { r: primRgb.r / 255, g: primRgb.g / 255, b: primRgb.b / 255 },
        { r: secRgb.r / 255, g: secRgb.g / 255, b: secRgb.b / 255 },
        dynamics,
        () => dabHashFloat(point.x, point.y, k, salt++)
      );
      dabR = cd.r;
      dabG = cd.g;
      dabB = cd.b;
      if (!gpuDabs) {
        curMaster = resolveCpuMaster(
          activeTip,
          cd.hex,
          hardness,
          isEraser,
          isBgEraser,
          isColorTip,
          curDabW,
          aaMode,
          isDualToneTip,
          options.secondaryColor
        );
      }
    }

    const dabDims = computeTipStampDimensions(curDabW, curDabThickness, isVert, tipNaturalW, tipNaturalH);
    let finalW = dabDims.width;
    let finalH = dabDims.height;
    if (useSyntheticTiltShading && tiltMagnitude > 0.01) {
      finalW *= 1.0 + tiltSpread * 1.85;
      finalH *= Math.max(0.55, 1.0 / (1.0 + tiltMagnitude * 0.45));
    }

    const flips = resolveTipFlipSigns(options.flipH, options.flipV, k, curDabX, curDabY);

    let stampAlpha = curDabAlpha;
    let stampFlipX = flips.signX;
    let stampFlipY = flips.signY;
    if (curMaster && tryPerPixelCpuGrain) {
      const sub = computeSubpixelDabDimensions(finalW, finalH, curDabAlpha, aaMode === 0 ? 1.0 : 0.75);
      const grained = applyCpuPerPixelPaperGrain(
        curMaster,
        curDabX,
        curDabY,
        sub.renderW,
        sub.renderH,
        curDabAngle,
        flips.signX,
        flips.signY,
        sub.effAlpha,
        effGrainAmount,
        grainPressure,
        dotPaperOpts
      );
      if (grained) {
        curMaster = grained;
        stampAlpha = 1.0;
        stampFlipX = 1;
        stampFlipY = 1;
      } else {
        const gNorm = sampleScalarPaperGrainNorm(curDabX, curDabY, curDabW, options.paperTextureScale ?? 1.0);
        const scalarMode = options.paperTextureMode === 'compare' ? 'subtract' : (options.paperTextureMode ?? 'subtract');
        const modTip = applyCspPaperTextureAlpha(
          1.0,
          gNorm,
          effGrainAmount,
          grainPressure,
          scalarMode,
          options.paperTextureBrightness ?? 0,
          options.paperTextureContrast ?? 0,
          Boolean(options.paperTextureInverted),
          preservePaperDensity,
          Boolean(options.paperTextureEmphasizeDensity)
        );
        stampAlpha = Math.max(0, Math.min(1, curDabAlpha * modTip));
      }
    }

    const dabGrainDensity = options.textureDensitySensor ? effGrainAmount : undefined;
    if (options.spray?.enabled) {
      const pCount = options.spray.density;
      const pSize = Math.max(1, options.spray.size);
      const radius = curDabW / 2;
      for (let i = 0; i < pCount; i++) {
        const u1 = dabHashFloat(curDabX, curDabY, k * 64 + i, 31);
        const u2 = dabHashFloat(curDabX, curDabY, k * 64 + i, 32);
        const r = radius * Math.sqrt(u1) * (1 - (options.spray.bias || 0) * (1 - u2));
        const th = Math.PI * 2 * dabHashFloat(curDabX, curDabY, k * 64 + i, 33);
        const spX = curDabX + r * Math.cos(th);
        const spY = curDabY + r * Math.sin(th);
        const spDims = computeTipStampDimensions(pSize, curDabThickness, isVert, tipNaturalW, tipNaturalH);
        const spW = spDims.width;
        const spH = spDims.height;
        if (gpuDabs) {
          gpuDabs.push({
            x: spX, y: spY, width: spW, height: spH, angle: curDabAngle,
            r: dabR, g: dabG, b: dabB, alpha: curDabAlpha, pressure: grainPressure,
            strokeDist: 0, flipX: flips.signX, flipY: flips.signY,
            grainDensity: dabGrainDensity,
          });
        } else if (curMaster) {
          drawSingleStamp(
            ctx, curMaster, spX, spY, spW, spH, curDabAngle, stampAlpha,
            isEraser, isBgEraser, options.alphaLocked, options.isTransparentInk,
            stampFlipX, stampFlipY, aaMode, options.blendTipsMode
          );
        }
      }
    } else if (gpuDabs) {
      gpuDabs.push({
        x: curDabX, y: curDabY, width: finalW, height: finalH, angle: curDabAngle,
        r: dabR, g: dabG, b: dabB, alpha: curDabAlpha, pressure: grainPressure,
        strokeDist: 0, flipX: flips.signX, flipY: flips.signY,
        grainDensity: dabGrainDensity,
      });
    } else if (curMaster) {
      drawSingleStamp(
        ctx, curMaster, curDabX, curDabY, finalW, finalH, curDabAngle, stampAlpha,
        isEraser, isBgEraser, options.alphaLocked, options.isTransparentInk,
        stampFlipX, stampFlipY, aaMode, options.blendTipsMode
      );
    }
  }
}

/**
 * Renders brush dabs along a cubic Bézier segment using zero-allocation arc-length stepping.
 */
export function drawBrushCubicBezierSegment(
  ctx: CanvasRenderingContext2D,
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  color: string,
  options: BrushRenderOptions = {},
  remainderDist: number = 0,
  dabCounter: {
    count: number;
    lastAngle?: number;
    lastStepDist?: number;
    lockedInitialAngle?: number;
    initOriginX?: number;
    initOriginY?: number;
  } = { count: 0 },
  batchGpuDabs?: GpuDab[]
): number {
  const { totalLength: totalCurveLength, steps: arcSteps } = buildFastArcLengthScratch(p0, c1, c2, p3);
  if (totalCurveLength < 0.08) {
    return Math.max(0, remainderDist - totalCurveLength);
  }

  const isEraser = Boolean(options.isEraser);
  const isBgEraser = Boolean(options.isBgEraser);
  const dynamics = options.dynamics;
  const colorJitterEnabled = Boolean(dynamics?.colorJitterEnabled);
  const colorJitterPerStroke = Boolean(colorJitterEnabled && dynamics?.colorJitterPerStroke);
  let baseColor = isBgEraser ? '#ffffff' : color;
  if (colorJitterPerStroke && dynamics) {
    if (!options.strokeJitterColor) {
      const prim0 = parseColorToRgb(baseColor);
      const sec0 = parseColorToRgb(options.secondaryColor || '#ffffff');
      let salt = 200;
      const strokeIdx = options.strokeIndex ?? 0;
      options.strokeJitterColor = applyColorDynamics(
        { r: prim0.r / 255, g: prim0.g / 255, b: prim0.b / 255 },
        { r: sec0.r / 255, g: sec0.g / 255, b: sec0.b / 255 },
        dynamics,
        () => dabHashFloat(p0.x, p0.y, strokeIdx, salt++)
      );
    }
    baseColor = options.strokeJitterColor.hex;
  }
  const perDabColorJitter = colorJitterEnabled && !colorJitterPerStroke;

  const hardness = options.hardness ?? 1.0;
  const tipImage = options.tipImage;
  const isColorMixing = Boolean(options.colorMixing) && !isEraser && !isBgEraser;

  if (isColorMixing && !options.reservoir) {
    options.reservoir = new PaintReservoir(baseColor);
  }

  const tipNaturalW = tipImage ? (tipImage.naturalWidth || tipImage.width || 1) : 1;
  const tipNaturalH = tipImage ? (tipImage.naturalHeight || tipImage.height || 1) : 1;
  const baseAngleRad = ((options.angle ?? 0) * Math.PI) / 180;
  const rawDensity = options.brushDensity ?? options.flow ?? (tipImage ? 0.85 : 1.0);
  const spacingRatio = Math.max(0.003, Math.min(2.0, options.spacing ?? (tipImage ? 0.07 : 0.08)));
  const baseFlow = computeGapAdjustedAlpha(rawDensity, spacingRatio, options.adjustDensityByGap);
  const thickness = options.thickness ?? 1.0;
  const isVert = Boolean(options.thicknessVertical);
  const rotationRandomScale = options.rotationRandomScale ?? 0;
  const { readTiltInput, useSyntheticTiltShading } = resolveTiltBehavior(options);
  const aaMode = options.antiAlias ?? 2;
  const grainAmount = options.skipPerDabPaperGrain ? 0 : (options.grain ?? options.textureDensity ?? 0);
  const preservePaperDensity =
    Boolean(options.textureDensitySensor) ||
    (options.paperTextureApplyEachPlot !== undefined && !options.grainPenetrationSensor?.usePressure);
  const isColorTip = Boolean(options.isColorTip || (options.subTips && options.subTips[0]?.isColor));
  const isDualToneTip = !isColorTip && Boolean(options.isDualToneTip || (options.subTips && options.subTips[0]?.isDualToneTip));

  const gpuDabs = batchGpuDabs || null;
  const avgSegWidth = Math.max(0.5, (p0.width + p3.width) * 0.5);
  const hasMultiSubTips = Boolean(tipImage && options.subTipImages && options.subTipImages.length > 1);
  const dabCount = Math.max(1, Math.min(10, Math.round(dynamics?.count ?? 1)));
  const sizeJitter = Math.max(0, Math.min(1, dynamics?.sizeJitter ?? 0));
  const angleJitter = Math.max(0, Math.min(1, dynamics?.angleJitter ?? 0));
  const roundnessJitter = Math.max(0, Math.min(1, dynamics?.roundnessJitter ?? 0));
  const scatter = Math.max(0, Math.min(5, dynamics?.scatter ?? 0));
  const scatterBothAxes = Boolean(dynamics?.scatterBothAxes);
  const flowJitter = Math.max(0, Math.min(1, dynamics?.flowJitter ?? 0));
  const useSpatialTipMixing =
    isColorMixing &&
    !gpuDabs &&
    !isColorTip &&
    !options.spray?.enabled;
  if (useSpatialTipMixing && options.reservoir && !options.reservoir.spatialMixer) {
    options.reservoir.spatialMixer = new SpatialTipMixer(baseColor);
  }
  const pressureAlreadyAppliedToFlow = Boolean(
    options.opacitySensor?.usePressure ||
      options.densitySensor?.usePressure ||
      options.densityOfPaintSensor?.usePressure
  );
  const customPaper =
    useSpatialTipMixing && grainAmount > 0.005 && options.paperTextureImage
      ? getCustomPaperLuminance(options.paperTextureImage)
      : null;
  const surfacePaper =
    useSpatialTipMixing && grainAmount > 0.005 && !customPaper && options.surfaceTextureId
      ? getSurfaceTextureHeightField(options.surfaceTextureId)
      : null;
  const texScale = options.paperTextureScale ?? 1.0;
  const texRot = options.paperTextureRotate ?? 0;
  const texMode = options.paperTextureMode ?? 'multiply';
  const texBright = options.paperTextureBrightness ?? 0;
  const texContrast = options.paperTextureContrast ?? 0;
  const texInv = Boolean(options.paperTextureInverted);

  const staticMaster =
    isColorMixing || gpuDabs || hasMultiSubTips
      ? null
      : resolveCpuMaster(
          tipImage,
          baseColor,
          hardness,
          isEraser,
          isBgEraser,
          isColorTip,
          avgSegWidth,
          aaMode,
          isDualToneTip,
          options.secondaryColor
        );

  const baseRgb = perDabColorJitter || gpuDabs ? parseColorToRgb(baseColor) : null;
  const secRgb = perDabColorJitter ? parseColorToRgb(options.secondaryColor || '#ffffff') : null;
  const baseMinStepPx = tipImage ? 0.15 : 0.12;
  const tryPerPixelCpuGrain = !gpuDabs && !useSpatialTipMixing && grainAmount > 0.005 && typeof document !== 'undefined';
  const segSeed = Math.abs(Math.sin(p0.x * 12.9898 + p0.y * 78.233));
  const segRandOffX = segSeed * 256;
  const segRandOffY = ((segSeed * 397) % 1) * 256;
  const segRandRot = Math.abs(Math.cos(p0.x * 39.346 + p0.y * 11.135)) * Math.PI * 2;

  if (options.angleDynamics === 'initial-direction') {
    if (options.initialAngleRad !== undefined && dabCounter.lockedInitialAngle === undefined) {
      dabCounter.lockedInitialAngle = options.initialAngleRad;
    }
    if (dabCounter.initOriginX === undefined) {
      dabCounter.initOriginX = p0.x;
      dabCounter.initOriginY = p0.y;
    }
  }

  let hasSmoothAngle = dabCounter.lastAngle !== undefined;
  let smoothCos = hasSmoothAngle ? Math.cos(dabCounter.lastAngle!) : Math.cos(baseAngleRad);
  let smoothSin = hasSmoothAngle ? Math.sin(dabCounter.lastAngle!) : Math.sin(baseAngleRad);
  let currentDist = remainderDist > 0 ? remainderDist : 0;
  // Preserve true inter-stamp arc distance across Bezier segment boundaries.
  // On Dab 1 (lastStepDist === undefined), use 0 so SpatialTipMixer uses nominal spacing instead of
  // a tiny post-carryover remainderDist from high-frequency pointer segments.
  let prevStepDist =
    dabCounter.lastStepDist !== undefined && dabCounter.lastStepDist > 0
      ? dabCounter.lastStepDist
      : 0;

  while (currentDist <= totalCurveLength) {
    const pt = sampleFastArcLengthInto(p0, c1, c2, p3, currentDist, totalCurveLength, arcSteps, sharedBezierSample);
    const effPressure = Math.max(0, Math.min(1, pt.pressure));
    const curvedPressure = options.pressureCurve ? evaluateFastSpline(effPressure, options.pressureCurve) : effPressure;
    const minFactor = Math.max(0, Math.min(1.0, options.minSizeFactor ?? 0));

    let curWidth =
      pt.width > 0
        ? pt.width
        : options.usePressure !== false
        ? (options.size ?? 10) * (minFactor + (1.0 - minFactor) * curvedPressure)
        : options.size ?? 10;

    const strokeDist = (options.currentStrokeDist ?? 0) + currentDist;

    const taperFactors = evaluateCspTaperFactors(
      options.taper,
      strokeDist,
      options.totalLength,
      options.exitSpeed
    );
    curWidth *= taperFactors.sizeScale;
    const taperAlphaScale = taperFactors.alphaScale;
    const taperAmountScale = taperFactors.amountScale;
    const taperPaintDensityScale = taperFactors.paintDensityScale;

    const dabSeq = dabCounter.count++;
    const tiltX = readTiltInput ? pt.tiltX : 0;
    const tiltY = readTiltInput ? pt.tiltY : 0;
    const tiltMagnitude = computeCspTiltMagnitude(tiltX, tiltY);
    const tiltSpread = tiltMagnitude * (options.tiltScale ?? 1.0);
    const grainPressure =
      useSyntheticTiltShading && tiltMagnitude > 0.01 ? effPressure * (1.0 - tiltMagnitude * 0.55) : effPressure;
    let effGrainAmount = grainAmount;
    if (grainAmount > 0.005 && options.textureDensitySensor) {
      const tdFactor = evaluateCspSensor(
        options.textureDensitySensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 58),
        pt.twist,
        strokeDist
      );
      effGrainAmount = Math.max(0, Math.min(1, grainAmount * tdFactor));
    }

    if (options.sizeSensor) {
      // Avoid double-applying pressure when pt.width already has pressure baked from calculateStrokeWidth
      const effectiveSizeSensor =
        pt.width > 0 && options.usePressure !== false && options.sizeSensor.usePressure
          ? { ...options.sizeSensor, usePressure: false }
          : options.sizeSensor;
      curWidth *= evaluateCspSensor(
        effectiveSizeSensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 50),
        pt.twist,
        strokeDist
      );
    }
    curWidth = Math.max(0.1, curWidth);

    let effThickness = thickness;
    if (options.thicknessSensor) {
      // CSP Brush Thickness minimum is 10% (0.10); never collapse below 0.10 unless base thickness itself is thinner.
      const minThicknessFloor = Math.min(thickness, 0.1);
      effThickness = Math.max(
        minThicknessFloor,
        thickness *
          evaluateCspSensor(
            options.thicknessSensor,
            effPressure,
            tiltMagnitude,
            pt.speed * 0.05,
            dabHashFloat(pt.x, pt.y, dabSeq, 54),
            pt.twist,
            strokeDist
          )
      );
    }

    let effAmountOfPaint = (options.amountOfPaint ?? 0.65) * taperAmountScale;
    if (options.amountOfPaintSensor) {
      effAmountOfPaint *= evaluateCspSensor(
        options.amountOfPaintSensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 55),
        pt.twist,
        strokeDist
      );
    }
    let effDensityOfPaint = (options.densityOfPaint ?? 0.9) * taperPaintDensityScale;
    let paintDensitySensorFactor = 1.0;
    const hasConcurrentDensityAndPaintDensityPressure = Boolean(
      isColorMixing && options.densitySensor?.usePressure && options.densityOfPaintSensor?.usePressure
    );
    if (options.densityOfPaintSensor) {
      paintDensitySensorFactor = evaluateCspSensor(
        options.densityOfPaintSensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 56),
        pt.twist,
        strokeDist
      );
      if (!hasConcurrentDensityAndPaintDensityPressure) {
        effDensityOfPaint *= paintDensitySensorFactor;
      } else if (paintDensitySensorFactor <= 0.002) {
        effDensityOfPaint = 0;
      }
    }
    let effColorStretch = options.colorStretch ?? 0.75;
    if (options.colorStretchSensor) {
      effColorStretch *= evaluateCspSensor(
        options.colorStretchSensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 57),
        pt.twist,
        strokeDist
      );
    }

    let stampAngle = baseAngleRad;
    const angleMode = options.angleDynamics;
    if (angleMode === 'initial-direction') {
      if (dabCounter.lockedInitialAngle !== undefined) {
        stampAngle = dabCounter.lockedInitialAngle;
      } else {
        const ox = dabCounter.initOriginX ?? p0.x;
        const oy = dabCounter.initOriginY ?? p0.y;
        const cdx = pt.x - ox;
        const cdy = pt.y - oy;
        const chordLen = Math.hypot(cdx, cdy);
        if (chordLen >= 4.0) {
          dabCounter.lockedInitialAngle = Math.atan2(cdy, cdx) + baseAngleRad;
          stampAngle = dabCounter.lockedInitialAngle;
          dabCounter.lastAngle = stampAngle;
        } else if (pt.speed > 0.2) {
          stampAngle = Math.atan2(pt.dy, pt.dx) + baseAngleRad;
        }
      }
    } else if (angleMode === 'direction' || angleMode === 'direction-random') {
      // Deadzone + arc-length-bounded turn rate prevents micro-jitter / pointer-up hooks
      // from spinning flat blades into starbursts while tracking smooth curves faithfully
      const minTangentSpeed = hasSmoothAngle ? 1.2 : 0.2;
      const segLongEnough = !hasSmoothAngle || totalCurveLength >= 1.2;
      if (segLongEnough && pt.speed > minTangentSpeed) {
        const targetAngle = Math.atan2(pt.dy, pt.dx) + baseAngleRad;
        if (!hasSmoothAngle) {
          smoothCos = Math.cos(targetAngle);
          smoothSin = Math.sin(targetAngle);
          hasSmoothAngle = true;
        } else {
          const curA = Math.atan2(smoothSin, smoothCos);
          let delta = targetAngle - curA;
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          const stepRef = prevStepDist > 0 ? prevStepDist : 1.0;
          const halfBlade = Math.max(2.0, curWidth * 0.5);
          // Bound per-step rotation so the outer edge of a wide flat blade never sweeps > 1.8px per stamp
          const maxOuterTipTurn = Math.max(0.025, Math.min(0.45, (1.8 + stepRef * 0.45) / halfBlade));
          const clampedDelta = Math.max(-maxOuterTipTurn, Math.min(maxOuterTipTurn, delta * 0.52));
          const nextA = curA + clampedDelta;
          smoothCos = Math.cos(nextA);
          smoothSin = Math.sin(nextA);
        }
        stampAngle = Math.atan2(smoothSin, smoothCos);
        dabCounter.lastAngle = stampAngle;
      } else if (hasSmoothAngle) {
        stampAngle = Math.atan2(smoothSin, smoothCos);
      }
    }
    if (angleMode === 'random' || angleMode === 'direction-random') {
      const rScale = angleMode === 'random' ? 1.0 : rotationRandomScale || 0.35;
      stampAngle += (dabHashFloat(pt.x, pt.y, dabSeq, 12) - 0.5) * Math.PI * 2 * rScale;
    } else if (rotationRandomScale > 0) {
      stampAngle += (dabHashFloat(pt.x, pt.y, dabSeq, 12) - 0.5) * Math.PI * 2 * rotationRandomScale;
    }

    if (angleMode === 'tilt' && tiltMagnitude > 0.05) {
      stampAngle = Math.atan2(tiltX, -tiltY) + baseAngleRad;
    } else if (useSyntheticTiltShading && tiltMagnitude > 0.05) {
      stampAngle = Math.atan2(tiltY, tiltX) + baseAngleRad;
    }
    if (pt.twist && (angleMode === 'twist' || useSyntheticTiltShading)) {
      stampAngle += (pt.twist * Math.PI) / 180;
    }

    let dabColor = baseColor;
    let dabAlpha = baseFlow * taperAlphaScale;
    let dabRgb = baseRgb;

    let flowSensorFactor = 1.0;
    if (hasConcurrentDensityAndPaintDensityPressure) {
      const dnF = evaluateCspSensor(
        options.densitySensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 52)
      );
      flowSensorFactor = dnF;
      if (options.opacitySensor) {
        flowSensorFactor *= evaluateCspSensor(
          options.opacitySensor,
          effPressure,
          tiltMagnitude,
          pt.speed * 0.05,
          dabHashFloat(pt.x, pt.y, dabSeq, 51)
        );
      }
    } else if (options.opacitySensor && options.densitySensor && (isColorMixing || options.paperTextureApplyEachPlot === false)) {
      const opF = evaluateCspSensor(
        options.opacitySensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 51)
      );
      const dnF = evaluateCspSensor(
        options.densitySensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 52)
      );
      flowSensorFactor = Math.min(opF, dnF);
    } else {
      if (options.opacitySensor) {
        flowSensorFactor *= evaluateCspSensor(
          options.opacitySensor,
          effPressure,
          tiltMagnitude,
          pt.speed * 0.05,
          dabHashFloat(pt.x, pt.y, dabSeq, 51)
        );
      }
      if (options.densitySensor) {
        flowSensorFactor *= evaluateCspSensor(
          options.densitySensor,
          effPressure,
          tiltMagnitude,
          pt.speed * 0.05,
          dabHashFloat(pt.x, pt.y, dabSeq, 52)
        );
      }
    }
    dabAlpha = Math.max(0, Math.min(1, dabAlpha * flowSensorFactor));
    if (useSyntheticTiltShading && tiltMagnitude > 0.03 && (tipImage || grainAmount > 0.005)) {
      dabAlpha *= 1.0 - tiltMagnitude * 0.28;
    }

    const dirX = pt.speed > 0.001 ? pt.dx / pt.speed : 0;
    const dirY = pt.speed > 0.001 ? pt.dy / pt.speed : 0;

    if (isColorMixing && !useSpatialTipMixing && options.reservoir) {
      const prelimStep = Math.max(0.15, curWidth * spacingRatio);
      const mixed = sampleAndMixColor(
        ctx,
        pt.x,
        pt.y,
        curWidth * 0.45,
        effPressure,
        dabAlpha,
        prelimStep,
        options,
        spacingRatio,
        dirX,
        dirY,
        effAmountOfPaint,
        effDensityOfPaint,
        effColorStretch
      );
      dabColor = mixed.colorHex;
      dabAlpha = mixed.alpha;
      if (gpuDabs) {
        dabRgb = { r: mixed.r, g: mixed.g, b: mixed.b };
      }
    }

    const activeTipIdx = tipImage
      ? selectTipIndex(options.subTipImages, options.subTipOrder, dabSeq, stampAngle, pt.x, pt.y)
      : 0;
    const activeTip = tipImage
      ? selectTipImage(options.subTipImages, tipImage, options.subTipOrder, dabSeq, stampAngle, pt.x, pt.y)
      : undefined;
    const dabIsDualTone = !isColorTip && Boolean(options.subTips?.[activeTipIdx]?.isDualToneTip ?? isDualToneTip);
    const baseMaster =
      gpuDabs || useSpatialTipMixing
        ? null
        : staticMaster ??
          resolveCpuMaster(
            activeTip,
            dabColor,
            hardness,
            isEraser,
            isBgEraser,
            isColorTip,
            curWidth,
            aaMode,
            dabIsDualTone,
            options.secondaryColor
          );

    let tx = 1;
    let ty = 0;
    let nx = 0;
    let ny = 1;
    if (pt.speed > 0.001) {
      tx = dirX;
      ty = dirY;
      nx = -ty;
      ny = tx;
    }

    const primRgb = perDabColorJitter && isColorMixing ? parseColorToRgb(dabColor) : dabRgb;
    const baseTipDims = computeTipStampDimensions(curWidth, effThickness, isVert, tipNaturalW, tipNaturalH);
    let stepRefW = baseTipDims.width;
    let stepRefH = baseTipDims.height;

    const effectiveSpacingRatio = options.intervalSensor
      ? Math.max(
          0.02,
          Math.min(
            2.0,
            spacingRatio *
              evaluateCspSensor(
                options.intervalSensor,
                effPressure,
                tiltMagnitude,
                pt.speed * 0.05,
                dabHashFloat(pt.x, pt.y, dabSeq, 53)
              )
          )
        )
      : spacingRatio;

    for (let k = 0; k < dabCount; k++) {
      const seedIdx = dabSeq * 16 + k;
      let curDabW = curWidth;
      if (sizeJitter > 0) curDabW *= Math.max(0.01, 1.0 - dabHashFloat(pt.x, pt.y, seedIdx, 1) * sizeJitter);
      curDabW = Math.max(0.1, curDabW);

      let curDabThickness = effThickness;
      if (roundnessJitter > 0) curDabThickness *= Math.max(0.05, 1.0 - dabHashFloat(pt.x, pt.y, seedIdx, 2) * roundnessJitter);

      let curDabAngle = stampAngle;
      if (angleJitter > 0) curDabAngle += (dabHashFloat(pt.x, pt.y, seedIdx, 3) - 0.5) * Math.PI * 2 * angleJitter;

      let curDabX = pt.x;
      let curDabY = pt.y;
      if (scatter > 0) {
        const perpDist = (dabHashFloat(pt.x, pt.y, seedIdx, 4) * 2 - 1) * curWidth * scatter;
        let sOffX = nx * perpDist;
        let sOffY = ny * perpDist;
        if (scatterBothAxes) {
          const tangDist = (dabHashFloat(pt.x, pt.y, seedIdx, 5) * 2 - 1) * curWidth * scatter;
          sOffX += tx * tangDist;
          sOffY += ty * tangDist;
        }
        curDabX += sOffX;
        curDabY += sOffY;
      }

      let curDabAlpha = dabAlpha;
      if (flowJitter > 0) curDabAlpha *= Math.max(0.005, 1.0 - dabHashFloat(pt.x, pt.y, seedIdx, 6) * flowJitter);

      const curDims = computeTipStampDimensions(curDabW, curDabThickness, isVert, tipNaturalW, tipNaturalH);
      let finalW = curDims.width;
      let finalH = curDims.height;
      if (useSyntheticTiltShading && tiltMagnitude > 0.01) {
        finalW *= 1.0 + tiltSpread * 1.85;
        finalH *= Math.max(0.55, 1.0 / (1.0 + tiltMagnitude * 0.45));
      }
      stepRefW = finalW;
      stepRefH = finalH;

      if (curDabAlpha <= 0.002) continue;

      const flips = resolveTipFlipSigns(options.flipH, options.flipV, seedIdx, curDabX, curDabY);

      if (useSpatialTipMixing && options.reservoir?.spatialMixer) {
        let freshColorOverride: { r: number; g: number; b: number } | undefined;
        if (perDabColorJitter && primRgb && secRgb && dynamics) {
          let salt = 20;
          const cd = applyColorDynamics(
            { r: primRgb.r / 255, g: primRgb.g / 255, b: primRgb.b / 255 },
            { r: secRgb.r / 255, g: secRgb.g / 255, b: secRgb.b / 255 },
            dynamics,
            () => dabHashFloat(pt.x, pt.y, seedIdx, salt++)
          );
          freshColorOverride = { r: cd.r * 255, g: cd.g * 255, b: cd.b * 255 };
        }
        const effectiveStep =
          prevStepDist > 0 ? prevStepDist : Math.max(0.75, Math.min(finalW, finalH) * effectiveSpacingRatio);
        const built = options.reservoir.spatialMixer.stepAndBuildStamp({
          x: curDabX,
          y: curDabY,
          width: finalW,
          height: finalH,
          angleRad: curDabAngle,
          dirX,
          dirY,
          stepDist: effectiveStep,
          spacingRatio: effectiveSpacingRatio,
          adjustDensityByGap: Boolean(options.adjustDensityByGap),
          dabSeq,
          hardness,
          antiAlias: aaMode,
          flipX: flips.signX,
          flipY: flips.signY,
          flow: curDabAlpha,
          pressure: effPressure,
          pressureAlreadyApplied: pressureAlreadyAppliedToFlow,
          amountOfPaint: effAmountOfPaint,
          densityOfPaint: effDensityOfPaint,
          colorStretch: effColorStretch,
          isPureBlender: (options.amountOfPaint ?? 0.65) <= 0.005 || options.mixingMode === 'smear',
          mixingMode: options.mixingMode ?? 'blend',
          perceptualMixing: options.perceptualMixing !== false,
          pigmentMixingStrength: options.pigmentMixingStrength ?? 1.0,
          useBlur: Boolean(options.useBlur),
          blurStrength: options.blurStrength,
          tipImage: activeTip,
          isDualToneTip: dabIsDualTone,
          secondaryColor: options.secondaryColor,
          freshColor: freshColorOverride,
          sampler: options.sampler,
          grainDensity: effGrainAmount,
          paperTextureMode: texMode,
          paperLumData:
            effGrainAmount > 0.005 ? (customPaper ? customPaper.lum : surfacePaper ?? paperGrainTable) : undefined,
          paperLumWidth:
            effGrainAmount > 0.005 ? (customPaper ? customPaper.width : surfacePaper ? SURFACE_TEXTURE_SIZE : GRAIN_SIZE) : undefined,
          paperLumHeight:
            effGrainAmount > 0.005 ? (customPaper ? customPaper.height : surfacePaper ? SURFACE_TEXTURE_SIZE : GRAIN_SIZE) : undefined,
          paperTextureScale: texScale,
          paperTextureRotate: texRot,
          paperTextureBrightness: texBright,
          paperTextureContrast: texContrast,
          paperTextureInverted: texInv,
          paperTexturePreserveDensity: preservePaperDensity,
          paperTextureEmphasizeDensity: Boolean(options.paperTextureEmphasizeDensity),
          grainPressure,
        });
        if (built) {
          options.reservoir.r = built.avgR;
          options.reservoir.g = built.avgG;
          options.reservoir.b = built.avgB;
          options.reservoir.a = built.avgA;
          if (built.pickedUpCanvas) options.reservoir.isLoadedWithCanvasColor = true;
        }
        if (built && built.hasVisiblePixels) {
          drawSingleStamp(
            ctx,
            built.canvas,
            curDabX,
            curDabY,
            built.drawW,
            built.drawH,
            curDabAngle,
            1.0,
            false,
            false,
            options.alphaLocked,
            options.isTransparentInk,
            1,
            1,
            aaMode,
            options.blendTipsMode
          );
        }
        continue;
      }

      let curMaster: CanvasImageSource | null = baseMaster;
      let dabR = primRgb ? primRgb.r / 255 : 0;
      let dabG = primRgb ? primRgb.g / 255 : 0;
      let dabB = primRgb ? primRgb.b / 255 : 0;

      if (perDabColorJitter && primRgb && secRgb && dynamics) {
        let salt = 20;
        const cd = applyColorDynamics(
          { r: primRgb.r / 255, g: primRgb.g / 255, b: primRgb.b / 255 },
          { r: secRgb.r / 255, g: secRgb.g / 255, b: secRgb.b / 255 },
          dynamics,
          () => dabHashFloat(pt.x, pt.y, seedIdx, salt++)
        );
        dabR = cd.r;
        dabG = cd.g;
        dabB = cd.b;
        if (!gpuDabs) {
          curMaster = resolveCpuMaster(
            activeTip,
            cd.hex,
            hardness,
            isEraser,
            isBgEraser,
            isColorTip,
            curDabW,
            aaMode,
            dabIsDualTone,
            options.secondaryColor
          );
        }
      }

      let stampAlpha = curDabAlpha;
      let stampFlipX = flips.signX;
      let stampFlipY = flips.signY;
      if (curMaster && tryPerPixelCpuGrain) {
        const sub = computeSubpixelDabDimensions(finalW, finalH, curDabAlpha, aaMode === 0 ? 1.0 : 0.75);
        const grained = applyCpuPerPixelPaperGrain(
          curMaster,
          curDabX,
          curDabY,
          sub.renderW,
          sub.renderH,
          curDabAngle,
          flips.signX,
          flips.signY,
          sub.effAlpha,
          effGrainAmount,
          grainPressure,
          {
            paperTextureMode: options.paperTextureMode ?? 'subtract',
            paperTextureScale: options.paperTextureScale ?? 1.0,
            paperTextureRotate: options.paperTextureRotate ?? 0,
            paperTextureBrightness: options.paperTextureBrightness ?? 0,
            paperTextureContrast: options.paperTextureContrast ?? 0,
            paperTextureInverted: Boolean(options.paperTextureInverted),
            paperTextureEmphasizeDensity: Boolean(options.paperTextureEmphasizeDensity),
            preservePaperDensity,
            paperTextureImage: options.paperTextureImage,
            surfaceTextureId: options.surfaceTextureId,
            grainMappingMode: options.grainMappingMode,
            strokeDist,
            grainRandomOffsetX: segRandOffX,
            grainRandomOffsetY: segRandOffY,
            grainRandomRot: segRandRot,
          }
        );
        if (grained) {
          curMaster = grained;
          stampAlpha = 1.0;
          stampFlipX = 1;
          stampFlipY = 1;
        } else {
          const gNorm = sampleScalarPaperGrainNorm(curDabX, curDabY, curDabW, options.paperTextureScale ?? 1.0);
          const scalarMode = options.paperTextureMode === 'compare' ? 'subtract' : (options.paperTextureMode ?? 'subtract');
          const modTip = applyCspPaperTextureAlpha(
            1.0,
            gNorm,
            effGrainAmount,
            grainPressure,
            scalarMode,
            options.paperTextureBrightness ?? 0,
            options.paperTextureContrast ?? 0,
            Boolean(options.paperTextureInverted),
            preservePaperDensity,
            Boolean(options.paperTextureEmphasizeDensity)
          );
          stampAlpha = Math.max(0, Math.min(1, curDabAlpha * modTip));
        }
      }

      const dabGrainDensity = options.textureDensitySensor ? effGrainAmount : undefined;
      if (options.spray?.enabled) {
        const pCount = options.spray.density;
        const pSize = Math.max(1, options.spray.size);
        const radius = curDabW / 2;
        for (let sp = 0; sp < pCount; sp++) {
          const u1 = dabHashFloat(curDabX, curDabY, seedIdx * 64 + sp, 31);
          const u2 = dabHashFloat(curDabX, curDabY, seedIdx * 64 + sp, 32);
          const r = radius * Math.sqrt(u1) * (1 - (options.spray.bias || 0) * (1 - u2));
          const th = Math.PI * 2 * dabHashFloat(curDabX, curDabY, seedIdx * 64 + sp, 33);
          const spX = curDabX + r * Math.cos(th);
          const spY = curDabY + r * Math.sin(th);
          const spDims = computeTipStampDimensions(pSize, curDabThickness, isVert, tipNaturalW, tipNaturalH);
          const spW = spDims.width;
          const spH = spDims.height;
          if (gpuDabs) {
            gpuDabs.push({
              x: spX, y: spY, width: spW, height: spH, angle: curDabAngle,
              r: dabR, g: dabG, b: dabB, alpha: curDabAlpha, pressure: grainPressure,
              strokeDist, flipX: flips.signX, flipY: flips.signY, tipIndex: activeTipIdx,
              grainDensity: dabGrainDensity,
            });
          } else if (curMaster) {
            drawSingleStamp(
              ctx, curMaster, spX, spY, spW, spH, curDabAngle, stampAlpha,
              isEraser, isBgEraser, options.alphaLocked, options.isTransparentInk,
              stampFlipX, stampFlipY, aaMode, options.blendTipsMode
            );
          }
        }
      } else if (gpuDabs) {
        gpuDabs.push({
          x: curDabX, y: curDabY, width: finalW, height: finalH, angle: curDabAngle,
          r: dabR, g: dabG, b: dabB, alpha: curDabAlpha, pressure: grainPressure,
          strokeDist, flipX: flips.signX, flipY: flips.signY, tipIndex: activeTipIdx,
          grainDensity: dabGrainDensity,
        });
      } else if (curMaster) {
        drawSingleStamp(
          ctx, curMaster, curDabX, curDabY, finalW, finalH, curDabAngle, stampAlpha,
          isEraser, isBgEraser, options.alphaLocked, options.isTransparentInk,
          stampFlipX, stampFlipY, aaMode, options.blendTipsMode
        );
      }
    }

    const maxAxis = Math.max(stepRefW, stepRefH);
    const minAxis = Math.max(0.5, Math.min(stepRefW, stepRefH));
    // SpatialTipMixer normalizes deposition via Beer-Lambert overlapHits, so scaling the floor
    // smoothly with brush size eliminates 100-300+ redundant CPU dabs per swipe on large oil/blend brushes
    // while keeping 12+ overlapping hits across the brush chord for silky, zero-scallop strokes.
    const effectiveMinStep = useSpatialTipMixing
      ? Math.max(0.85, Math.min(4.2, minAxis * 0.085))
      : baseMinStepPx;
    let stepAdvance = computeEllipticalStepDistance(
      stepRefW,
      stepRefH,
      stampAngle,
      pt.dx,
      pt.dy,
      effectiveSpacingRatio,
      effectiveMinStep
    );
    // Angular-sweep stepping: tighten step on curves so outer tips of wide flat blades never fan into comb teeth.
    // Respect effectiveMinStep for CPU SpatialTipMixer so curves never collapse to 0.2px (10x lag spike).
    if (
      (angleMode === 'direction' || angleMode === 'direction-random') &&
      maxAxis > minAxis * 1.35 &&
      currentDist + stepAdvance <= totalCurveLength
    ) {
      const peek = sampleFastArcLengthInto(
        p0,
        c1,
        c2,
        p3,
        currentDist + stepAdvance,
        totalCurveLength,
        arcSteps,
        peekBezierSample
      );
      if (peek.speed > 0.5) {
        const peekAngle = Math.atan2(peek.dy, peek.dx) + baseAngleRad;
        let dTheta = peekAngle - stampAngle;
        while (dTheta > Math.PI) dTheta -= Math.PI * 2;
        while (dTheta < -Math.PI) dTheta += Math.PI * 2;
        const outerArc = 0.5 * maxAxis * Math.abs(dTheta);
        const maxOuterArc = useSpatialTipMixing
          ? Math.max(1.5, minAxis * 0.22)
          : Math.max(0.75, minAxis * 0.14);
        if (outerArc > maxOuterArc) {
          const curveFloor = useSpatialTipMixing ? effectiveMinStep : 0.2;
          stepAdvance = Math.max(curveFloor, stepAdvance * (maxOuterArc / outerArc));
        }
      }
    }
    prevStepDist = stepAdvance;
    dabCounter.lastStepDist = stepAdvance;
    currentDist += stepAdvance;
  }

  return Math.max(0, currentDist - totalCurveLength);
}

/**
 * Elevates a quadratic Bézier segment to cubic and renders via the unified engine.
 */
export function drawBrushQuadraticBezierSegment(
  ctx: CanvasRenderingContext2D,
  start: Point,
  control: Point,
  end: Point,
  color: string,
  options: BrushRenderOptions = {},
  remainderDist: number = 0,
  dabCounter: { count: number } = { count: 0 },
  batchGpuDabs?: GpuDab[]
): number {
  const c1: Point = {
    x: start.x + (2.0 / 3.0) * (control.x - start.x),
    y: start.y + (2.0 / 3.0) * (control.y - start.y),
    pressure: start.pressure + (2.0 / 3.0) * (control.pressure - start.pressure),
    width: start.width + (2.0 / 3.0) * (control.width - start.width),
    tiltX: start.tiltX !== undefined && control.tiltX !== undefined ? start.tiltX + (2.0 / 3.0) * (control.tiltX - start.tiltX) : start.tiltX,
    tiltY: start.tiltY !== undefined && control.tiltY !== undefined ? start.tiltY + (2.0 / 3.0) * (control.tiltY - start.tiltY) : start.tiltY,
    twist: start.twist !== undefined && control.twist !== undefined ? start.twist + (2.0 / 3.0) * (control.twist - start.twist) : start.twist,
  };
  const c2: Point = {
    x: end.x + (2.0 / 3.0) * (control.x - end.x),
    y: end.y + (2.0 / 3.0) * (control.y - end.y),
    pressure: end.pressure + (2.0 / 3.0) * (control.pressure - end.pressure),
    width: end.width + (2.0 / 3.0) * (control.width - end.width),
    tiltX: end.tiltX !== undefined && control.tiltX !== undefined ? end.tiltX + (2.0 / 3.0) * (control.tiltX - end.tiltX) : end.tiltX,
    tiltY: end.tiltY !== undefined && control.tiltY !== undefined ? end.tiltY + (2.0 / 3.0) * (control.tiltY - end.tiltY) : end.tiltY,
    twist: end.twist !== undefined && control.twist !== undefined ? end.twist + (2.0 / 3.0) * (control.twist - end.twist) : end.twist,
  };
  return drawBrushCubicBezierSegment(ctx, start, c1, c2, end, color, options, remainderDist, dabCounter, batchGpuDabs);
}

/**
 * Builds unified BrushRenderOptions from BrushSettings (with legacy pencil preset resolution).
 */
export function buildBrushRenderOptions(
  rawSettings: BrushSettings,
  overrides?: Partial<BrushRenderOptions>
): BrushRenderOptions {
  const bs = resolveBrushPresetSettings(rawSettings);
  return {
    size: bs.size,
    minSizeFactor: bs.minSizeFactor,
    opacity: bs.opacity,
    flow: bs.flow ?? 1.0,
    brushDensity: bs.brushDensity,
    adjustDensityByGap: bs.adjustDensityByGap,
    blendTipsMode: bs.blendTipsMode,
    brushCombineMode: bs.brushCombineMode,
    spacing: bs.spacing ?? 0.08,
    thickness: bs.thickness,
    thicknessVertical: bs.thicknessVertical,
    thicknessSensor: bs.thicknessSensor,
    flipH: bs.flipH,
    flipV: bs.flipV,
    tipImage: bs.customTipImage,
    isColorTip: bs.isColorTip,
    isDualToneTip: bs.isDualToneTip,
    isRibbon: bs.isRibbon,
    angle: bs.customTipAngle,
    angleDynamics: bs.customTipAngleDynamics,
    rotationRandomScale: bs.customTipRotationRandomScale,
    hardness: bs.hardness ?? 1.0,
    antiAlias: bs.antiAlias,
    pressureCurve: bs.pressureCurve,
    velocityCurve: bs.velocityCurve,
    usePressure: bs.usePressure,
    useVelocity: bs.useVelocity,
    useTilt: Boolean(bs.useTilt),
    tiltScale: bs.tiltScale,
    sizeSensor: bs.sizeSensor,
    opacitySensor: bs.opacitySensor,
    densitySensor: bs.densitySensor,
    intervalSensor: bs.intervalSensor,
    textureDensitySensor: bs.textureDensitySensor,
    bristleSplaySensor: bs.bristleSplaySensor,
    paintLoadSensor: bs.paintLoadSensor,
    grainPenetrationSensor: bs.grainPenetrationSensor,
    angleSensor: bs.angleSensor,
    scatterSensor: bs.scatterSensor,
    subTips: bs.subTips,
    subTipOrder: bs.subTipOrder,
    subTipImages: bs.subTipImages,
    spray: bs.spray,
    taper: bs.taper,
    colorMixing: bs.colorMixing,
    perceptualMixing: bs.perceptualMixing,
    pigmentMixingStrength: bs.naturalPaint?.pigmentMixingStrength ?? 1.0,
    amountOfPaint: bs.amountOfPaint,
    densityOfPaint: bs.densityOfPaint,
    colorStretch: bs.colorStretch,
    amountOfPaintSensor: bs.amountOfPaintSensor,
    densityOfPaintSensor: bs.densityOfPaintSensor,
    colorStretchSensor: bs.colorStretchSensor,
    useBlur: bs.useBlur,
    blurStrength: bs.blurStrength,
    mixingMode: bs.mixingMode,
    wetEdge: bs.wetEdge,
    wetEdgeRadius: bs.wetEdgeRadius,
    wetEdgeAlphaPower: bs.wetEdgeAlphaPower,
    wetEdgeValuePower: bs.wetEdgeValuePower,
    grain: bs.grain ?? bs.textureDensity,
    textureDensity: bs.textureDensity,
    surfaceTextureId: bs.surfaceTextureId,
    grainMappingMode: bs.grainMappingMode,
    paperTextureMode: bs.paperTextureMode,
    paperTextureBrightness: bs.paperTextureBrightness,
    paperTextureContrast: bs.paperTextureContrast,
    paperTextureApplyEachPlot: bs.paperTextureApplyEachPlot,
    paperTextureEmphasizeDensity: bs.paperTextureEmphasizeDensity,
    paperTextureInverted: bs.paperTextureInverted,
    paperTextureImage: bs.paperTextureImage,
    paperTextureScale: bs.paperTextureScale,
    paperTextureRotate: bs.paperTextureRotate,
    dualBrush: bs.dualBrush,
    dualBrushConfig: bs.dualBrushConfig,
    dualTipDataUrl: bs.dualTipDataUrl,
    dualTipImage: bs.dualTipImage,
    dualBrushCompositeMode: bs.dualBrushCompositeMode,
    dualSize: bs.dualSize,
    dualLinkSize: bs.dualLinkSize,
    dualSpacing: bs.dualSpacing,
    dualScale: bs.dualScale,
    dualThickness: bs.dualThickness,
    dualThicknessVertical: bs.dualThicknessVertical,
    dualAngle: bs.dualAngle,
    dualAngleDynamics: bs.dualAngleDynamics,
    dualAngleSensor: bs.dualAngleSensor,
    dualHardness: bs.dualHardness,
    dualDensity: bs.dualDensity,
    dualSubTips: bs.dualSubTips,
    dualSubTipImages: bs.dualSubTipImages,
    dualSubTipOrder: bs.dualSubTipOrder,
    dualFlipH: bs.dualFlipH,
    dualFlipV: bs.dualFlipV,
    dualSpray: bs.dualSpray,
    dualIsRibbon: bs.dualIsRibbon,
    dualScatter: bs.dualScatter,
    dualSurfaceTextureId: bs.dualSurfaceTextureId,
    dualGrainDepth: bs.dualGrainDepth,
    renderMode: bs.renderMode,
    bristle: bs.bristle,
    naturalPaint: bs.naturalPaint,
    impasto: bs.impasto,
    useGpu: bs.useGpu !== false,
    isTransparentInk: Boolean(bs.isTransparentInk),
    dynamics: bs.dynamics,
    secondaryColor: bs.secondaryColor,
    ...overrides,
  };
}

/**
 * Renders an entire completed brush stroke through the single unified pipeline:
 * WebGL instanced batch when available & eligible, single Canvas2D CPU fallback otherwise.
 */
export function renderCompleteStroke(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  brushSettings: BrushSettings,
  tool: ToolType,
  colorMode: CanvasColorMode = 'color',
  isBgEraser: boolean = false,
  underlyingCanvas?: HTMLCanvasElement,
  alphaLocked: boolean = false,
  explicitSampler?: LayerPixelSampler,
  allowGpuForMonochrome: boolean = false,
  exitSpeed?: number
): void {
  if (!points || points.length === 0) return;

  const resolvedSettings = resolveBrushPresetSettings(brushSettings);
  const isMono = colorMode === 'monochrome';
  const postCorrLevel = resolvedSettings.postCorrection ?? 0;
  const postCorrectedPoints =
    postCorrLevel > 0 && points.length >= 3
      ? applyCspPostCorrection(points, postCorrLevel, resolvedSettings.sharpCorners !== false)
      : points;

  const hasTaper = Boolean(resolvedSettings.taper?.useOut || resolvedSettings.taper?.useIn);
  const effectivePoints =
    isMono && !hasTaper
      ? postCorrectedPoints.map((p) => (p.width < 1.25 ? { ...p, width: 1.25 } : p))
      : postCorrectedPoints;

  const isEraser = tool === 'eraser';
  const strokeColor = isBgEraser ? '#ffffff' : enforceColorMode(resolvedSettings.color, colorMode);

  // True two-pass Clip Studio Paint Dual Brush engine:
  // Pass 1 renders the full Primary Stroke; Pass 2 renders the independent Secondary Stroke
  // along the exact same `effectivePoints`; Combine Pass modulates Primary RGBA with Secondary density.
  const dualCfg = resolveDualBrushConfig(resolvedSettings);
  if (dualCfg) {
    const primarySettings: BrushSettings = {
      ...resolvedSettings,
      dualBrush: false,
      dualBrushConfig: undefined,
    };
    const secInfo = buildSecondaryBrushSettings(primarySettings, dualCfg);
    const secondaryPoints = scalePointsForSecondaryBrush(
      effectivePoints,
      secInfo.sizeRatio,
      secInfo.settings.size
    );

    const strokeHardness = isMono ? 1.0 : primarySettings.hardness ?? 1.0;
    const strokeFlow = isMono ? 1.0 : primarySettings.flow ?? 1.0;
    const strokeSpacing = primarySettings.spacing ?? 0.08;
    const effectiveAntiAlias = isMono
      ? allowGpuForMonochrome && (primarySettings.antiAlias ?? 2) !== 0 && primarySettings.useGpu !== false
        ? primarySettings.antiAlias ?? 2
        : 0
      : primarySettings.antiAlias;

    const effectiveUnderlying = underlyingCanvas || ctx.canvas;

    const primaryIsNatural =
      !isEraser && !isBgEraser && !isMono && !primarySettings.isTransparentInk && isNaturalPaintBrush(primarySettings);
    const primaryIsRibbon = isRibbonBrush(primarySettings);
    const secondaryIsRibbon = isRibbonBrush(secInfo.settings);
    const dualHasWetEdge =
      !isMono && !isEraser && !isBgEraser && !resolvedSettings.isTransparentInk && (resolvedSettings.wetEdge ?? 0) > 0.01;
    const dualHasCustomCombine =
      !isEraser && !isBgEraser && !resolvedSettings.isTransparentInk && isCustomBrushCombineMode(resolvedSettings.brushCombineMode);
    const dualStrokeLevelPaper = needsStrokeLevelPaperTexture({
      paperTextureApplyEachPlot: primarySettings.paperTextureApplyEachPlot,
      grain: primarySettings.grain,
      textureDensity: primarySettings.textureDensity,
      colorMixing: primarySettings.colorMixing,
      isEraser: isEraser && !isBgEraser,
      isBgEraser,
    });

    // Helper to compute initial lookahead tangent angle for a given brush pass
    const computePassInitAngle = (pts: Point[], opts: BrushRenderOptions): number | undefined => {
      if (
        pts.length < 2 ||
        (opts.angleDynamics !== 'direction' &&
          opts.angleDynamics !== 'direction-random' &&
          opts.angleDynamics !== 'initial-direction')
      ) {
        return undefined;
      }
      const p0 = pts[0];
      const minChord =
        opts.angleDynamics === 'initial-direction'
          ? Math.max(4.0, Math.min(8.0, (opts.size ?? 10) * 0.25))
          : Math.max(4.0, (opts.size ?? 10) * 0.12);
      const minChordSq = minChord * minChord;
      let fallbackAngle: number | undefined = undefined;
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - p0.x;
        const dy = pts[i].y - p0.y;
        const dSq = dx * dx + dy * dy;
        if (dSq > 0.25 && fallbackAngle === undefined) {
          fallbackAngle = Math.atan2(dy, dx) + ((opts.angle ?? 0) * Math.PI) / 180;
        }
        if (dSq >= minChordSq) {
          return Math.atan2(dy, dx) + ((opts.angle ?? 0) * Math.PI) / 180;
        }
      }
      return fallbackAngle;
    };

    const emitPointsIntoDabs = (
      targetCtx: CanvasRenderingContext2D,
      pts: Point[],
      passColor: string,
      emitOpts: BrushRenderOptions,
      passSpacing: number,
      passInitAngle: number | undefined,
      outDabs: GpuDab[]
    ) => {
      emitOpts.currentStrokeDist = 0;
      drawBrushDot(targetCtx, pts[0], passColor, emitOpts, outDabs);
      if (pts.length === 1) return;

      const dabCounter: { count: number; lastAngle?: number } = {
        count: 0,
        lastAngle: passInitAngle,
      };
      const minInitDist = emitOpts.tipImage ? 0.15 : 0.12;
      let accDist = Math.max(minInitDist, Math.max(0.2, pts[0].width) * passSpacing);

      if (pts.length === 2) {
        const p0 = pts[0];
        const p1 = pts[1];
        const { c1, c2 } = centripetalCatmullRomToBezier(p0, p0, p1, p1);
        drawBrushCubicBezierSegment(targetCtx, p0, c1, c2, p1, passColor, emitOpts, accDist, dabCounter, outDabs);
        return;
      }

      const p0 = pts[0];
      const p1 = pts[1];
      const p2 = pts[2];
      const first = centripetalCatmullRomToBezier(p0, p0, p1, p2);
      accDist = drawBrushCubicBezierSegment(targetCtx, p0, first.c1, first.c2, p1, passColor, emitOpts, accDist, dabCounter, outDabs);
      emitOpts.currentStrokeDist = (emitOpts.currentStrokeDist ?? 0) + Math.hypot(p1.x - p0.x, p1.y - p0.y);

      for (let i = 2; i < pts.length - 1; i++) {
        const seg = centripetalCatmullRomToBezier(pts[i - 2], pts[i - 1], pts[i], pts[i + 1]);
        accDist = drawBrushCubicBezierSegment(targetCtx, pts[i - 1], seg.c1, seg.c2, pts[i], passColor, emitOpts, accDist, dabCounter, outDabs);
        emitOpts.currentStrokeDist =
          (emitOpts.currentStrokeDist ?? 0) + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      }

      const n = pts.length;
      const last = centripetalCatmullRomToBezier(pts[n - 3], pts[n - 2], pts[n - 1], pts[n - 1]);
      drawBrushCubicBezierSegment(targetCtx, pts[n - 2], last.c1, last.c2, pts[n - 1], passColor, emitOpts, accDist, dabCounter, outDabs);
    };

    // Fast GPU two-pass FBO path when both passes are WebGL-eligible (non-mixing, non-ribbon, non-natural)
    if (!primaryIsNatural && !primaryIsRibbon && !secondaryIsRibbon && !dualStrokeLevelPaper && !dualHasWetEdge && !dualHasCustomCombine) {
      let totalLen = 0;
      for (let i = 1; i < effectivePoints.length; i++) {
        totalLen += Math.hypot(
          effectivePoints[i].x - effectivePoints[i - 1].x,
          effectivePoints[i].y - effectivePoints[i - 1].y
        );
      }

      const primaryOpts = buildBrushRenderOptions(primarySettings, {
        hardness: strokeHardness,
        flow: strokeFlow,
        spacing: strokeSpacing,
        antiAlias: effectiveAntiAlias,
        underlyingCanvas: effectiveUnderlying,
        isEraser: isEraser && !isBgEraser,
        isBgEraser,
        alphaLocked,
        isTransparentInk: Boolean(primarySettings.isTransparentInk),
        totalLength: totalLen,
        exitSpeed,
      });
      primaryOpts.initialAngleRad = computePassInitAngle(effectivePoints, primaryOpts);

      const secSpacing = secInfo.settings.spacing ?? 0.1;
      const secondaryOpts = buildBrushRenderOptions(secInfo.settings, {
        hardness: secInfo.settings.hardness ?? 1.0,
        flow: secInfo.settings.flow ?? 1.0,
        spacing: secSpacing,
        antiAlias: effectiveAntiAlias,
        isEraser: false,
        isBgEraser: false,
        alphaLocked: false,
        isTransparentInk: false,
        totalLength: totalLen,
        exitSpeed,
      });
      secondaryOpts.initialAngleRad = computePassInitAngle(secondaryPoints, secondaryOpts);

      if (canUseWebGlForBrush(primaryOpts) && canUseWebGlForBrush(secondaryOpts)) {
        const primaryDabs: GpuDab[] = [];
        const secondaryDabs: GpuDab[] = [];
        emitPointsIntoDabs(
          ctx,
          effectivePoints,
          strokeColor,
          primaryOpts,
          strokeSpacing,
          primaryOpts.initialAngleRad,
          primaryDabs
        );
        emitPointsIntoDabs(
          ctx,
          secondaryPoints,
          '#ffffff',
          secondaryOpts,
          secSpacing,
          secondaryOpts.initialAngleRad,
          secondaryDabs
        );

        const gpu = WebGlBrushEngine.getInstance();
        const docW = effectiveUnderlying?.width || ctx.canvas?.width || 1024;
        const docH = effectiveUnderlying?.height || ctx.canvas?.height || 1024;
        const primGpuSettings = buildGpuBrushSettingsFromOptions(strokeColor, primaryOpts);
        const secGpuSettings = buildGpuBrushSettingsFromOptions('#ffffff', secondaryOpts);
        if (
          gpu.renderDualBrushDabsToContext(
            ctx,
            primaryDabs,
            primGpuSettings,
            secondaryDabs,
            secGpuSettings,
            dualCfg.compositeMode,
            tool,
            docW,
            docH,
            effectiveUnderlying
          )
        ) {
          return;
        }
      }
    }

    // Unified two-pass isolated surface path:
    // Handles CPU fallback, colorMixing (including SpatialTipMixer), Ribbon, NaturalPaint,
    // AA=0 monochrome, per-stroke paper texture, or WebGL unavailable.
    if (typeof document !== 'undefined') {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxW = Math.max(primarySettings.size || 10, secInfo.settings.size || 10);
      for (let i = 0; i < effectivePoints.length; i++) {
        const p = effectivePoints[i];
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
        if (p.width > maxW) maxW = p.width;
        const sw = p.width * secInfo.sizeRatio;
        if (sw > maxW) maxW = sw;
      }
      const maxScatter = Math.max(
        primarySettings.dynamics?.scatter ?? 0,
        dualCfg.scatter ?? 0
      );
      const sprayPad = Math.max(
        primarySettings.spray?.enabled ? (primarySettings.spray.size || 0) : 0,
        secInfo.settings.spray?.enabled ? (secInfo.settings.spray.size || 0) : 0
      );
      const pad = Math.ceil(maxW * (1.5 + maxScatter) + sprayPad + 12);
      const bx = Math.floor(minX - pad);
      const by = Math.floor(minY - pad);
      const bw = Math.max(1, Math.ceil(maxX + pad) - bx);
      const bh = Math.max(1, Math.ceil(maxY + pad) - by);

      if (bw <= 4096 && bh <= 4096) {
        const primarySurface = document.createElement('canvas');
        primarySurface.width = bw;
        primarySurface.height = bh;
        const pCtx = primarySurface.getContext('2d');

        const secondarySurface = document.createElement('canvas');
        secondarySurface.width = bw;
        secondarySurface.height = bh;
        const sCtx = secondarySurface.getContext('2d');

        if (
          pCtx &&
          sCtx &&
          typeof pCtx.getImageData === 'function' &&
          typeof pCtx.putImageData === 'function' &&
          typeof sCtx.getImageData === 'function'
        ) {
          // Pass 1 (Primary): render full primary stroke (including colorMixing / SpatialTipMixer / ribbon / taper)
          const pass1Settings: BrushSettings = {
            ...primarySettings,
            opacity: 1.0,
            postCorrection: 0,
            isTransparentInk: false,
            wetEdge: 0,
            color: isEraser && !isBgEraser ? '#000000' : primarySettings.color,
            ...(dualStrokeLevelPaper
              ? { grain: 0, textureDensity: 0, paperTextureApplyEachPlot: undefined }
              : {}),
          };
          pCtx.save();
          pCtx.translate(-bx, -by);
          renderCompleteStroke(
            pCtx,
            effectivePoints,
            pass1Settings,
            isEraser && !isBgEraser ? 'brush' : tool,
            colorMode,
            isBgEraser,
            effectiveUnderlying,
            false,
            explicitSampler,
            allowGpuForMonochrome,
            exitSpeed
          );
          pCtx.restore();

          // Pass 2 (Secondary): render independent secondary brush along exact same trajectory
          sCtx.save();
          sCtx.translate(-bx, -by);
          renderCompleteStroke(
            sCtx,
            secondaryPoints,
            {
              ...secInfo.settings,
              opacity: 1.0,
              postCorrection: 0,
            },
            'brush',
            'color',
            false,
            undefined,
            false,
            undefined,
            allowGpuForMonochrome,
            exitSpeed
          );
          sCtx.restore();

          // Combine Pass: exact CSP Dual Brush alpha modulation across the tight dirty rect
          const primaryImg = pCtx.getImageData(0, 0, bw, bh);
          const secondaryImg = sCtx.getImageData(0, 0, bw, bh);
          combineDualBrushImageData(
            primaryImg.data,
            secondaryImg.data,
            primaryImg.data,
            dualCfg.compositeMode
          );

          if (dualStrokeLevelPaper) {
            applyStrokePaperTextureToImageData(primaryImg, bx, by, primarySettings, 1.0);
          }

          if (dualHasWetEdge) {
            applyCspWatercolorEdge(
              primaryImg,
              resolvedSettings.wetEdge ?? 0,
              resolvedSettings.wetEdgeRadius ?? 3.0,
              normalizeWetEdgePower01(resolvedSettings.wetEdgeAlphaPower, 0.25),
              normalizeWetEdgePower01(resolvedSettings.wetEdgeValuePower, 0.15)
            );
          }

          pCtx.putImageData(primaryImg, 0, 0);

          const baseCompositeOp: 'source-over' | 'destination-out' | 'source-atop' = isBgEraser
            ? 'source-over'
            : isEraser || resolvedSettings.isTransparentInk || resolvedSettings.brushCombineMode === 'clear'
            ? 'destination-out'
            : alphaLocked
            ? 'source-atop'
            : 'source-over';
          compositeIsolatedStrokeToCtx(
            ctx,
            primarySurface,
            primaryImg,
            bx,
            by,
            Math.max(0, Math.min(1, resolvedSettings.opacity ?? 1.0)),
            baseCompositeOp,
            dualHasCustomCombine ? resolvedSettings.brushCombineMode : undefined
          );
          return;
        }
      }
    }
  }

  // Route Natural Paint / Bristle Ribbon / Impasto brushes through the dedicated Natural Paint core
  if (!isEraser && !isBgEraser && !isMono && !resolvedSettings.isTransparentInk && isNaturalPaintBrush(resolvedSettings)) {
    const effectiveUnderlying = underlyingCanvas || ctx.canvas;
    const natSampler =
      resolvedSettings.colorMixing !== false &&
      (resolvedSettings.colorMixing || resolvedSettings.naturalPaint?.spatialMixing)
        ? explicitSampler || (effectiveUnderlying ? new LayerPixelSampler(effectiveUnderlying) : undefined)
        : undefined;
    const compOp: GlobalCompositeOperation = alphaLocked ? 'source-atop' : 'source-over';
    renderCompleteNaturalPaintStroke(
      ctx,
      effectivePoints,
      resolvedSettings,
      strokeColor,
      natSampler,
      Math.max(0.01, Math.min(1.0, resolvedSettings.opacity ?? 1.0)),
      compOp
    );
    return;
  }

  // Route Clip Studio Paint Ribbon brushes (`BrushRibbon = 1`, non-NaturalPaint, non-Spray)
  if (isRibbonBrush(resolvedSettings)) {
    renderCompleteRibbonStroke(
      ctx,
      effectivePoints,
      resolvedSettings,
      tool,
      colorMode,
      isBgEraser,
      alphaLocked,
      allowGpuForMonochrome,
      exitSpeed
    );
    return;
  }

  const strokeHardness = isMono ? 1.0 : resolvedSettings.hardness ?? 1.0;
  const strokeFlow = isMono ? 1.0 : resolvedSettings.flow ?? 1.0;
  const strokeSpacing = resolvedSettings.spacing ?? 0.08;
  const effectiveAntiAlias = isMono
    ? allowGpuForMonochrome && (resolvedSettings.antiAlias ?? 2) !== 0 && resolvedSettings.useGpu !== false
      ? resolvedSettings.antiAlias ?? 2
      : 0
    : resolvedSettings.antiAlias;

  const effectiveUnderlying = underlyingCanvas || ctx.canvas;
  let effectiveStrokeColor = strokeColor;
  let strokeJitterColor: { r: number; g: number; b: number; hex: string } | undefined = undefined;
  if (
    !isEraser &&
    !isBgEraser &&
    resolvedSettings.dynamics?.colorJitterEnabled &&
    resolvedSettings.dynamics?.colorJitterPerStroke
  ) {
    const prim0 = parseColorToRgb(strokeColor);
    const sec0 = parseColorToRgb(resolvedSettings.secondaryColor || '#ffffff');
    let salt = 200;
    strokeJitterColor = applyColorDynamics(
      { r: prim0.r / 255, g: prim0.g / 255, b: prim0.b / 255 },
      { r: sec0.r / 255, g: sec0.g / 255, b: sec0.b / 255 },
      resolvedSettings.dynamics,
      () => dabHashFloat(effectivePoints[0].x, effectivePoints[0].y, 0, salt++)
    );
    effectiveStrokeColor = strokeJitterColor.hex;
  }

  const options = buildBrushRenderOptions(resolvedSettings, {
    hardness: strokeHardness,
    flow: strokeFlow,
    spacing: strokeSpacing,
    antiAlias: effectiveAntiAlias,
    underlyingCanvas: effectiveUnderlying,
    sampler: resolvedSettings.colorMixing
      ? explicitSampler || (effectiveUnderlying ? new LayerPixelSampler(effectiveUnderlying) : undefined)
      : undefined,
    reservoir: resolvedSettings.colorMixing && !isEraser && !isBgEraser ? new PaintReservoir(effectiveStrokeColor) : undefined,
    isEraser: isEraser && !isBgEraser,
    isBgEraser,
    alphaLocked,
    isTransparentInk: Boolean(resolvedSettings.isTransparentInk),
    strokeJitterColor,
  });

  let totalLen = 0;
  for (let i = 1; i < effectivePoints.length; i++) {
    totalLen += Math.hypot(effectivePoints[i].x - effectivePoints[i - 1].x, effectivePoints[i].y - effectivePoints[i - 1].y);
  }
  options.totalLength = totalLen;
  options.exitSpeed = exitSpeed;

  // Align initial dot with initial stroke tangent using a >=4px lookahead chord to ignore landing jitter
  let initAngleRad: number | undefined = undefined;
  if (
    effectivePoints.length >= 2 &&
    (options.angleDynamics === 'direction' ||
      options.angleDynamics === 'direction-random' ||
      options.angleDynamics === 'initial-direction')
  ) {
    const p0 = effectivePoints[0];
    const minChord =
      options.angleDynamics === 'initial-direction'
        ? Math.max(4.0, Math.min(8.0, (options.size ?? 10) * 0.25))
        : Math.max(4.0, (options.size ?? 10) * 0.12);
    const minChordSq = minChord * minChord;
    let fallbackAngle: number | undefined = undefined;
    for (let i = 1; i < effectivePoints.length; i++) {
      const dx = effectivePoints[i].x - p0.x;
      const dy = effectivePoints[i].y - p0.y;
      const dSq = dx * dx + dy * dy;
      if (dSq > 0.25 && fallbackAngle === undefined) {
        fallbackAngle = Math.atan2(dy, dx) + ((options.angle ?? 0) * Math.PI) / 180;
      }
      if (dSq >= minChordSq) {
        initAngleRad = Math.atan2(dy, dx) + ((options.angle ?? 0) * Math.PI) / 180;
        break;
      }
    }
    if (initAngleRad === undefined) {
      initAngleRad = fallbackAngle;
    }
  }
  options.initialAngleRad = initAngleRad;

  const strokeLevelPaper = needsStrokeLevelPaperTexture(options);
  const hasWetEdge =
    !isMono && !isEraser && !isBgEraser && !resolvedSettings.isTransparentInk && (resolvedSettings.wetEdge ?? 0) > 0.01;
  const needsCompareIsolation =
    options.blendTipsMode === 'compare' && !isEraser && !isBgEraser && !options.isTransparentInk;
  const hasCustomCombine =
    !isEraser && !isBgEraser && !options.isTransparentInk && isCustomBrushCombineMode(resolvedSettings.brushCombineMode);

  const emitStroke = (
    targetCtx: CanvasRenderingContext2D,
    emitOpts: BrushRenderOptions,
    batchGpuDabs: GpuDab[] | undefined
  ) => {
    emitOpts.currentStrokeDist = 0;
    drawBrushDot(targetCtx, effectivePoints[0], effectiveStrokeColor, emitOpts, batchGpuDabs);
    if (effectivePoints.length === 1) return;

    const dabCounter: {
      count: number;
      lastAngle?: number;
      lastStepDist?: number;
      lockedInitialAngle?: number;
      initOriginX?: number;
      initOriginY?: number;
    } = {
      count: 0,
      lastAngle: initAngleRad,
      lockedInitialAngle: emitOpts.angleDynamics === 'initial-direction' ? initAngleRad : undefined,
      initOriginX: effectivePoints[0].x,
      initOriginY: effectivePoints[0].y,
    };
    const minInitDist = emitOpts.tipImage ? 0.15 : 0.12;
    let accDist = Math.max(minInitDist, Math.max(0.2, effectivePoints[0].width) * strokeSpacing);

    if (effectivePoints.length === 2) {
      const p0 = effectivePoints[0];
      const p1 = effectivePoints[1];
      const { c1, c2 } = centripetalCatmullRomToBezier(p0, p0, p1, p1);
      drawBrushCubicBezierSegment(targetCtx, p0, c1, c2, p1, effectiveStrokeColor, emitOpts, accDist, dabCounter, batchGpuDabs);
      return;
    }

    const p0 = effectivePoints[0];
    const p1 = effectivePoints[1];
    const p2 = effectivePoints[2];
    const first = centripetalCatmullRomToBezier(p0, p0, p1, p2);
    accDist = drawBrushCubicBezierSegment(targetCtx, p0, first.c1, first.c2, p1, effectiveStrokeColor, emitOpts, accDist, dabCounter, batchGpuDabs);
    emitOpts.currentStrokeDist = (emitOpts.currentStrokeDist ?? 0) + Math.hypot(p1.x - p0.x, p1.y - p0.y);

    for (let i = 2; i < effectivePoints.length - 1; i++) {
      const seg = centripetalCatmullRomToBezier(
        effectivePoints[i - 2],
        effectivePoints[i - 1],
        effectivePoints[i],
        effectivePoints[i + 1]
      );
      accDist = drawBrushCubicBezierSegment(
        targetCtx,
        effectivePoints[i - 1],
        seg.c1,
        seg.c2,
        effectivePoints[i],
        effectiveStrokeColor,
        emitOpts,
        accDist,
        dabCounter,
        batchGpuDabs
      );
      emitOpts.currentStrokeDist =
        (emitOpts.currentStrokeDist ?? 0) +
        Math.hypot(effectivePoints[i].x - effectivePoints[i - 1].x, effectivePoints[i].y - effectivePoints[i - 1].y);
    }

    const n = effectivePoints.length;
    const last = centripetalCatmullRomToBezier(effectivePoints[n - 3], effectivePoints[n - 2], effectivePoints[n - 1], effectivePoints[n - 1]);
    drawBrushCubicBezierSegment(
      targetCtx,
      effectivePoints[n - 2],
      last.c1,
      last.c2,
      effectivePoints[n - 1],
      effectiveStrokeColor,
      emitOpts,
      accDist,
      dabCounter,
      batchGpuDabs
    );
  };

  const renderIntoContext = (targetCtx: CanvasRenderingContext2D, emitOpts: BrushRenderOptions) => {
    if (canUseWebGlForBrush(emitOpts)) {
      const batchGpuDabs: GpuDab[] = [];
      emitStroke(targetCtx, emitOpts, batchGpuDabs);
      if (flushGpuDabs(targetCtx, batchGpuDabs, effectiveStrokeColor, emitOpts)) {
        return;
      }
    }
    // Single general CPU Canvas2D fallback (WebGL unavailable/lost, AA=0, CPU colorMixing, or multi-subTip)
    emitStroke(targetCtx, emitOpts, undefined);
  };

  // Isolated stroke accumulation surface for:
  // - CSP TextureForPlot=0 (per-stroke paper texture)
  // - CSP Watercolor Edge (works both with and without colorMixing!)
  // - CSP Compare Density (stroke-level non-accumulating alpha before compositing onto existing pixels)
  // - CSP BrushCombineMode (all 26+ layer-level brush blend modes including behind/clear/multiply/add-glow)
  const needsIsolatedSurface = strokeLevelPaper || hasWetEdge || needsCompareIsolation || hasCustomCombine;
  if (needsIsolatedSurface && typeof document !== 'undefined') {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxW = options.size ?? 10;
    for (let i = 0; i < effectivePoints.length; i++) {
      const p = effectivePoints[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
      if (p.width > maxW) maxW = p.width;
    }
    const scatterPad = Math.max(0, options.dynamics?.scatter ?? 0) * maxW;
    const wetPad = hasWetEdge ? Math.ceil((resolvedSettings.wetEdgeRadius ?? 3.0) * 2) + 4 : 0;
    const pad = Math.ceil(maxW * 1.25 + scatterPad + wetPad + 8);
    const bx = Math.floor(minX - pad);
    const by = Math.floor(minY - pad);
    const bw = Math.max(1, Math.ceil(maxX + pad) - bx);
    const bh = Math.max(1, Math.ceil(maxY + pad) - by);
    if (bw <= 4096 && bh <= 4096) {
      const scratch = document.createElement('canvas');
      scratch.width = bw;
      scratch.height = bh;
      const sCtx = scratch.getContext('2d');
      if (sCtx && typeof sCtx.getImageData === 'function' && typeof sCtx.putImageData === 'function') {
        const isolatedOpts: BrushRenderOptions = {
          ...options,
          skipPerDabPaperGrain: strokeLevelPaper ? true : options.skipPerDabPaperGrain,
          wetEdge: 0,
          alphaLocked: false,
          isTransparentInk: false,
          brushCombineMode: undefined,
        };
        sCtx.save();
        sCtx.translate(-bx, -by);
        renderIntoContext(sCtx, isolatedOpts);
        sCtx.restore();

        const imgData = sCtx.getImageData(0, 0, bw, bh);
        if (strokeLevelPaper) {
          applyStrokePaperTextureToImageData(imgData, bx, by, options, 1.0);
        }
        if (hasWetEdge) {
          applyCspWatercolorEdge(
            imgData,
            resolvedSettings.wetEdge ?? 0,
            resolvedSettings.wetEdgeRadius ?? 3.0,
            normalizeWetEdgePower01(resolvedSettings.wetEdgeAlphaPower, 0.25),
            normalizeWetEdgePower01(resolvedSettings.wetEdgeValuePower, 0.15)
          );
        }
        sCtx.putImageData(imgData, 0, 0);

        const baseCompositeOp: 'source-over' | 'destination-out' | 'source-atop' =
          options.isTransparentInk || resolvedSettings.brushCombineMode === 'clear'
            ? 'destination-out'
            : alphaLocked
            ? 'source-atop'
            : 'source-over';
        compositeIsolatedStrokeToCtx(
          ctx,
          scratch,
          imgData,
          bx,
          by,
          Math.max(0, Math.min(1, options.opacity ?? 1.0)),
          baseCompositeOp,
          hasCustomCombine ? resolvedSettings.brushCombineMode : undefined
        );
        return;
      }
    }
  }

  renderIntoContext(ctx, options);
}

function compositeIsolatedStrokeToCtx(
  ctx: CanvasRenderingContext2D,
  strokeCanvas: HTMLCanvasElement,
  strokeImg: { data: Uint8ClampedArray; width: number; height: number },
  bx: number,
  by: number,
  opacity: number,
  compositeOp: 'source-over' | 'destination-out' | 'source-atop',
  brushCombineMode?: CspBrushCombineMode
): void {
  const hasCustom = isCustomBrushCombineMode(brushCombineMode);
  if (
    hasCustom &&
    ctx.canvas &&
    ctx.canvas.width > 0 &&
    ctx.canvas.height > 0 &&
    typeof ctx.getImageData === 'function' &&
    typeof ctx.putImageData === 'function'
  ) {
    const m =
      typeof ctx.getTransform === 'function'
        ? ctx.getTransform()
        : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const isTranslationOnly =
      Math.abs(m.a - 1) < 1e-4 &&
      Math.abs(m.d - 1) < 1e-4 &&
      Math.abs(m.b) < 1e-4 &&
      Math.abs(m.c) < 1e-4;
    if (isTranslationOnly) {
      const dx0 = Math.round(bx + m.e);
      const dy0 = Math.round(by + m.f);
      const rx0 = Math.max(0, dx0);
      const ry0 = Math.max(0, dy0);
      const rx1 = Math.min(ctx.canvas.width, dx0 + strokeImg.width);
      const ry1 = Math.min(ctx.canvas.height, dy0 + strokeImg.height);
      const rw = rx1 - rx0;
      const rh = ry1 - ry0;
      if (rw > 0 && rh > 0) {
        const dstImg = ctx.getImageData(rx0, ry0, rw, rh);
        const dst = dstImg.data;
        const src = strokeImg.data;
        const pxOut: [number, number, number, number] = [0, 0, 0, 0];
        const fullOp = opacity >= 0.999;
        for (let y = 0; y < rh; y++) {
          const sy = ry0 - dy0 + y;
          const sRow = sy * strokeImg.width;
          const dRow = y * rw;
          for (let x = 0; x < rw; x++) {
            const sx = rx0 - dx0 + x;
            const sOff = (sRow + sx) << 2;
            const sa = src[sOff + 3];
            if (sa === 0) continue;
            const effA = fullOp ? sa : Math.round(sa * opacity);
            if (effA <= 0) continue;
            const dOff = (dRow + x) << 2;
            compositeBrushPixelInto(
              dst[dOff],
              dst[dOff + 1],
              dst[dOff + 2],
              dst[dOff + 3],
              src[sOff],
              src[sOff + 1],
              src[sOff + 2],
              effA,
              compositeOp,
              brushCombineMode,
              pxOut
            );
            dst[dOff] = pxOut[0];
            dst[dOff + 1] = pxOut[1];
            dst[dOff + 2] = pxOut[2];
            dst[dOff + 3] = pxOut[3];
          }
        }
        ctx.putImageData(dstImg, rx0, ry0);
        return;
      }
    }
  }

  const prevOp = ctx.globalCompositeOperation;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalCompositeOperation =
    brushCombineMode === 'behind'
      ? 'destination-over'
      : brushCombineMode === 'clear'
      ? 'destination-out'
      : compositeOp;
  ctx.globalAlpha = opacity;
  ctx.drawImage(strokeCanvas, bx, by);
  ctx.globalAlpha = prevAlpha;
  ctx.globalCompositeOperation = prevOp;
}
