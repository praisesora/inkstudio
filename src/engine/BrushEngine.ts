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
  ToolType,
  CanvasColorMode,
  CspSensorConfig,
  CspPaperTextureMode,
  CspTipFlipMode,
  CspAngleDynamicsMode,
  CspBlendTipsMode,
  CspSpraySettings,
  CspTaperSettings,
  CspSubTip,
} from '../types/editor';
import { enforceColorMode } from '../utils/colorUtils';
import {
  PaintReservoir,
  LayerPixelSampler,
  sampleCanvasColor,
  parseColorToRgb,
  rgbToHex,
} from '../utils/colorMixingEngine';
import { GpuDab, WebGlBrushEngine } from './WebGlBrushEngine';

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
  spacing?: number;
  thickness?: number;
  thicknessVertical?: boolean;
  flipH?: CspTipFlipMode;
  flipV?: CspTipFlipMode;
  angle?: number; // degrees
  angleDynamics?: CspAngleDynamicsMode;
  rotationRandomScale?: number;
  hardness?: number;
  antiAlias?: number;
  tipImage?: HTMLImageElement;
  isColorTip?: boolean;
  pressureCurve?: [number, number][];
  velocityCurve?: [number, number][];
  usePressure?: boolean;
  useTilt?: boolean;
  tiltScale?: number;
  useVelocity?: boolean;
  sizeSensor?: CspSensorConfig;
  opacitySensor?: CspSensorConfig;
  densitySensor?: CspSensorConfig;
  subTips?: CspSubTip[];
  subTipOrder?: 'random' | 'sequential' | 'direction' | 'reverse';
  subTipImages?: HTMLImageElement[];
  spray?: CspSpraySettings;
  taper?: CspTaperSettings;
  colorMixing?: boolean;
  perceptualMixing?: boolean;
  amountOfPaint?: number;
  densityOfPaint?: number;
  colorStretch?: number;
  mixingMode?: 'blend' | 'running_color' | 'smear';
  wetEdge?: number;
  wetEdgeRadius?: number;
  wetEdgeAlphaPower?: number;
  wetEdgeValuePower?: number;
  grain?: number;
  textureDensity?: number;
  paperTextureMode?: CspPaperTextureMode;
  paperTextureBrightness?: number;
  paperTextureContrast?: number;
  paperTextureInverted?: boolean;
  paperTextureImage?: HTMLImageElement;
  paperTextureScale?: number;
  paperTextureRotate?: number;
  dualBrush?: boolean;
  dualTipImage?: HTMLImageElement;
  dualBrushCompositeMode?: string;
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
  dynamics?: BrushDynamics;
  secondaryColor?: string;
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
    const deltas = new Float64Array(n - 1);
    const m = new Float64Array(n);
    for (let k = 0; k < n - 1; k++) {
      deltas[k] = (dedup[k + 1][1] - dedup[k][1]) / Math.max(1e-5, dedup[k + 1][0] - dedup[k][0]);
    }
    m[0] = deltas[0];
    for (let k = 1; k < n - 1; k++) {
      m[k] = deltas[k - 1] * deltas[k] <= 0 ? 0 : (deltas[k - 1] + deltas[k]) * 0.5;
    }
    m[n - 1] = deltas[n - 2];

    for (let k = 0; k < n - 1; k++) {
      const dk = deltas[k];
      if (Math.abs(dk) < 1e-6) {
        m[k] = 0;
        m[k + 1] = 0;
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
  randomVal: number
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
    factor *= tMin + (1.0 - tMin) * Math.max(0, Math.min(1, tiltMagnitude));
  }
  if (sensor.useVelocity) {
    const vMin = Math.max(0, Math.min(1, sensor.velocityMin ?? 0));
    const vNorm = Math.max(0, Math.min(1, speedPxPerMs / 3.5));
    const vVal = sensor.invertVelocity !== false ? 1.0 - vNorm : vNorm;
    factor *= vMin + (1.0 - vMin) * vVal;
  }
  if (sensor.useRandom) {
    const rMin = Math.max(0, Math.min(1, sensor.randomMin ?? 0));
    factor *= rMin + (1.0 - rMin) * Math.max(0, Math.min(1, randomVal));
  }
  return Math.max(0, Math.min(1, factor));
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
  const ratio = Math.max(0.01, Math.min(2.0, spacingRatio));
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

export function applyCspPaperTextureAlpha(
  tipAlpha: number,
  grainNorm: number,
  textureDensity: number,
  pressure: number,
  mode: CspPaperTextureMode = 'subtract',
  brightness: number = 0,
  contrast: number = 0,
  inverted: boolean = false
): number {
  if (textureDensity <= 0.001 || tipAlpha <= 0.001) return tipAlpha;

  let g = inverted ? 1.0 - grainNorm : grainNorm;
  if (brightness !== 0) g += brightness / 100.0;
  if (contrast !== 0) {
    const cFactor = Math.pow((contrast + 100.0) / 100.0, 2);
    g = (g - 0.5) * cFactor + 0.5;
  }
  g = Math.max(0, Math.min(1, g));

  const p = Math.max(0, Math.min(1, pressure));
  const heavyExcess = Math.max(0, (p - 0.52) / 0.48);
  const penetration = Math.min(0.92, p * 0.28 + heavyExcess * heavyExcess * 0.64);
  const effDensity = textureDensity * (1.0 - penetration * 0.85);

  switch (mode) {
    case 'multiply':
      return Math.max(0, Math.min(1, tipAlpha * (1.0 - effDensity * (1.0 - g))));
    case 'subtract': {
      const sub = (1.0 - g) * effDensity;
      return Math.max(0, Math.min(1, tipAlpha - sub * (1.0 - penetration * 0.5)));
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
      const ov = tipAlpha < 0.5 ? 2.0 * tipAlpha * g : 1.0 - 2.0 * (1.0 - tipAlpha) * (1.0 - g);
      return Math.max(0, Math.min(1, tipAlpha + (ov - tipAlpha) * effDensity));
    }
    case 'outline': {
      const edgeFactor = 4.0 * tipAlpha * (1.0 - tipAlpha);
      return Math.max(0, Math.min(1, tipAlpha * (1.0 - effDensity * (1.0 - g) * (0.35 + 0.65 * edgeFactor))));
    }
    default:
      return tipAlpha;
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
  const r = Math.max(1, Math.min(8, Math.round(radiusPx)));
  const totalPixels = width * height;

  const alphaOrig = new Float32Array(totalPixels);
  const alphaTemp = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    alphaOrig[i] = data[i * 4 + 3] / 255.0;
  }

  const invKernel = 1.0 / (2 * r + 1);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = alphaOrig[row] * (r + 1);
    for (let k = 1; k <= r; k++) sum += alphaOrig[row + Math.min(width - 1, k)];
    for (let x = 0; x < width; x++) {
      alphaTemp[row + x] = sum * invKernel;
      sum += alphaOrig[row + Math.min(width - 1, x + r + 1)] - alphaOrig[row + Math.max(0, x - r)];
    }
  }

  const aBoost = strength * (0.45 + alphaPower * 1.15);
  const vDarken = strength * (0.25 + valuePower * 0.55);

  for (let x = 0; x < width; x++) {
    let sum = alphaTemp[x] * (r + 1);
    for (let k = 1; k <= r; k++) sum += alphaTemp[Math.min(height - 1, k) * width + x];
    for (let y = 0; y < height; y++) {
      const idx = y * width + x;
      const blurredA = sum * invKernel;
      const origA = alphaOrig[idx];

      if (origA > 0.015) {
        const rim = Math.max(0, origA - blurredA) * 2.4;
        if (rim > 0.01) {
          const p = idx * 4;
          const darkScale = Math.max(0.18, 1.0 - rim * vDarken);
          data[p] = Math.round(data[p] * darkScale);
          data[p + 1] = Math.round(data[p + 1] * darkScale);
          data[p + 2] = Math.round(data[p + 2] * darkScale);
          data[p + 3] = Math.round(Math.min(1.0, origA * (1.0 + rim * aBoost)) * 255);
        }
      }

      sum += alphaTemp[Math.min(height - 1, y + r + 1) * width + x] - alphaTemp[Math.max(0, y - r) * width + x];
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
  const effP0 = p1.isCorner ? p1 : p0;
  const effP3 = p2.isCorner ? p2 : p3;

  const d01 = Math.hypot(p1.x - effP0.x, p1.y - effP0.y);
  const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const d23 = Math.hypot(effP3.x - p2.x, effP3.y - p2.y);

  const dt0 = Math.max(1e-4, Math.sqrt(d01));
  const dt1 = Math.max(1e-4, Math.sqrt(d12));
  const dt2 = Math.max(1e-4, Math.sqrt(d23));

  const t1x = (p2.x - p1.x) / dt1 - (p1.x - effP0.x) / dt0 + (p2.x - effP0.x) / (dt0 + dt1);
  const t1y = (p2.y - p1.y) / dt1 - (p1.y - effP0.y) / dt0 + (p2.y - effP0.y) / (dt0 + dt1);
  const t2x = (effP3.x - p2.x) / dt2 - (p2.x - p1.x) / dt1 + (effP3.x - p1.x) / (dt1 + dt2);
  const t2y = (effP3.y - p2.y) / dt2 - (p2.y - p1.y) / dt1 + (effP3.y - p1.y) / (dt1 + dt2);

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
  isColorTip: boolean = false
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
  isColorTip: boolean = false
): HTMLCanvasElement {
  const w = tipImage.naturalWidth || tipImage.width || 64;
  const h = tipImage.naturalHeight || tipImage.height || 64;
  return getTintedMasterCanvas(tipImage, getUniqueSourceKey(tipImage, 'tip'), color, w, h, isColorTip);
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
  _blendTipsMode?: CspBlendTipsMode
): void {
  if (width < 0.08 || height < 0.08 || alpha <= 0.002) return;

  const minRenderDim = antiAlias === 0 ? 1.0 : 0.75;
  const sub = computeSubpixelDabDimensions(width, height, alpha, minRenderDim);
  const renderW = sub.renderW;
  const renderH = sub.renderH;
  const effAlpha = antiAlias === 0 ? (sub.effAlpha >= 0.45 ? 1.0 : 0) : sub.effAlpha;
  if (effAlpha <= 0.002) return;

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

function selectTipImage(
  tipImages: HTMLImageElement[] | undefined,
  fallbackTip: HTMLImageElement,
  order: 'random' | 'sequential' | 'direction' | 'reverse' = 'sequential',
  dabIndex: number = 0,
  tangentAngle: number = 0,
  x: number = 0,
  y: number = 0
): HTMLImageElement {
  if (!tipImages || tipImages.length <= 1) {
    return tipImages && tipImages.length === 1 ? tipImages[0] : fallbackTip;
  }
  const count = tipImages.length;
  if (order === 'random') return tipImages[Math.floor(dabHashFloat(x, y, dabIndex, 97) * count) % count];
  if (order === 'reverse') return tipImages[(count - 1 - (dabIndex % count)) % count];
  if (order === 'direction') {
    const normAngle = ((tangentAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return tipImages[Math.floor((normAngle / (2 * Math.PI)) * count) % count];
  }
  return tipImages[dabIndex % count];
}

let _invertedGrainCanvas: HTMLCanvasElement | null = null;
let _grainScratchCanvas: HTMLCanvasElement | null = null;
let _grainScratchCtx: CanvasRenderingContext2D | null = null;
let _grainPattern: CanvasPattern | null = null;
const _customGrainCanvasCache = new WeakMap<
  HTMLImageElement,
  { canvas: HTMLCanvasElement; pattern: CanvasPattern | null }
>();

function getInvertedGrainPattern(
  scratchCtx: CanvasRenderingContext2D,
  paperTextureImage?: HTMLImageElement
): CanvasPattern | null {
  if (typeof scratchCtx.createPattern !== 'function') return null;

  if (
    paperTextureImage &&
    paperTextureImage.complete !== false &&
    (paperTextureImage.naturalWidth || paperTextureImage.width) > 0
  ) {
    const cached = _customGrainCanvasCache.get(paperTextureImage);
    if (cached) return cached.pattern;
    const w = paperTextureImage.naturalWidth || paperTextureImage.width;
    const h = paperTextureImage.naturalHeight || paperTextureImage.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const gCtx = c.getContext('2d', { willReadFrequently: true });
    if (gCtx && typeof gCtx.getImageData === 'function') {
      gCtx.drawImage(paperTextureImage, 0, 0, w, h);
      const img = gCtx.getImageData(0, 0, w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
        d[i + 3] = 255 - Math.round(lum);
      }
      gCtx.putImageData(img, 0, 0);
      const pat = scratchCtx.createPattern(c, 'repeat');
      _customGrainCanvasCache.set(paperTextureImage, { canvas: c, pattern: pat });
      return pat;
    }
  }

  if (!_invertedGrainCanvas) {
    const c = document.createElement('canvas');
    c.width = GRAIN_SIZE;
    c.height = GRAIN_SIZE;
    const gCtx = c.getContext('2d');
    if (!gCtx) return null;
    const img = gCtx.createImageData(GRAIN_SIZE, GRAIN_SIZE);
    const d = img.data;
    for (let i = 0; i < paperGrainTable.length; i++) {
      const p = i * 4;
      d[p] = 255;
      d[p + 1] = 255;
      d[p + 2] = 255;
      d[p + 3] = 255 - paperGrainTable[i];
    }
    gCtx.putImageData(img, 0, 0);
    _invertedGrainCanvas = c;
    _grainPattern = scratchCtx.createPattern(c, 'repeat');
  }
  return _grainPattern;
}

function applyCpuPerPixelPaperGrain(
  master: CanvasImageSource,
  worldX: number,
  worldY: number,
  renderW: number,
  renderH: number,
  grainAmount: number,
  pressure: number,
  paperScale: number = 1.0,
  paperTextureImage?: HTMLImageElement
): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || grainAmount <= 0.005) return null;
  if (!_grainScratchCanvas) {
    _grainScratchCanvas = document.createElement('canvas');
    _grainScratchCanvas.width = 128;
    _grainScratchCanvas.height = 128;
    _grainScratchCtx = _grainScratchCanvas.getContext('2d');
  }
  const sCtx = _grainScratchCtx;
  if (!sCtx || typeof sCtx.createPattern !== 'function') return null;

  const pat = getInvertedGrainPattern(sCtx, paperTextureImage);
  if (!pat) return null;

  const bufSize = 128;
  const p = Math.max(0, Math.min(1, pressure));
  const heavyExcess = Math.max(0, (p - 0.52) / 0.48);
  const penetration = Math.min(0.92, p * 0.28 + heavyExcess * heavyExcess * 0.64);
  const effDensity = Math.max(0, Math.min(0.98, grainAmount * (1.0 - penetration * 0.85)));
  if (effDensity <= 0.005) return null;

  sCtx.save();
  sCtx.globalCompositeOperation = 'source-over';
  sCtx.globalAlpha = 1.0;
  sCtx.clearRect(0, 0, bufSize, bufSize);
  sCtx.drawImage(master, 0, 0, bufSize, bufSize);

  const scale = Math.max(0.1, paperScale);
  const sx = (bufSize / Math.max(1, renderW)) * scale;
  const sy = (bufSize / Math.max(1, renderH)) * scale;
  const offX = -((worldX - renderW * 0.5) / scale);
  const offY = -((worldY - renderH * 0.5) / scale);

  sCtx.globalCompositeOperation = 'destination-out';
  sCtx.globalAlpha = effDensity;
  sCtx.fillStyle = pat;
  sCtx.scale(sx, sy);
  sCtx.translate(offX, offY);
  sCtx.fillRect(-offX, -offY, bufSize / sx, bufSize / sy);
  sCtx.restore();

  return _grainScratchCanvas;
}

// ============================================================================
// 8. Unified WebGL Dispatch
// ============================================================================

export function canUseWebGlForBrush(options?: BrushRenderOptions): boolean {
  if (!options) return WebGlBrushEngine.getInstance().isAvailable();
  if (options.useGpu === false) return false;
  if (options.colorMixing) return false;
  if ((options.antiAlias ?? 2) === 0) return false;
  if (options.tipImage && options.subTipImages && options.subTipImages.length > 1) return false;
  return WebGlBrushEngine.getInstance().isAvailable();
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
  const settings: BrushSettings & { alphaLocked?: boolean; isBgEraser?: boolean } = {
    size: options.size ?? 10,
    minSizeFactor: options.minSizeFactor ?? 0,
    color,
    opacity: options.opacity ?? 1.0,
    flow: options.flow ?? 1.0,
    spacing: options.spacing ?? 0.08,
    usePressure: options.usePressure !== false,
    smoothing: false,
    stabilization: 0,
    hardness: options.hardness ?? 1.0,
    antiAlias: options.antiAlias ?? 2,
    wetEdge: options.wetEdge ?? 0,
    grain: options.grain ?? options.textureDensity ?? 0,
    textureDensity: options.textureDensity,
    paperTextureMode: options.paperTextureMode,
    paperTextureBrightness: options.paperTextureBrightness,
    paperTextureContrast: options.paperTextureContrast,
    paperTextureInverted: options.paperTextureInverted,
    paperTextureImage: options.paperTextureImage,
    paperTextureScale: options.paperTextureScale,
    paperTextureRotate: options.paperTextureRotate,
    customTipImage: options.tipImage,
    isColorTip: options.isColorTip,
    subTips: options.subTips,
    dualBrush: options.dualBrush,
    dualTipImage: options.dualTipImage,
    dualBrushCompositeMode: options.dualBrushCompositeMode as BrushSettings['dualBrushCompositeMode'],
    colorMixing: false,
    isTransparentInk: Boolean(options.isTransparentInk),
    alphaLocked: Boolean(options.alphaLocked),
    isBgEraser,
  };

  const docW = options.underlyingCanvas?.width || ctx.canvas?.width || 1024;
  const docH = options.underlyingCanvas?.height || ctx.canvas?.height || 1024;
  return gpu.renderDabsToContext(ctx, dabs, settings, tool, docW, docH, options.underlyingCanvas);
}

// ============================================================================
// 9. Unified Dab & Stroke Renderer (Textured, Radial & Pencil Presets)
// ============================================================================

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
  aaMode: number
): HTMLCanvasElement {
  if (activeTip) {
    return getTintedTipMaster(activeTip, color, isColorTip);
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
  options: BrushRenderOptions
): { colorHex: string; alpha: number; r: number; g: number; b: number } {
  const reservoir = options.reservoir!;
  let sampled = { r: 255, g: 255, b: 255, a: 0 };
  if (options.sampler) {
    sampled = options.sampler.sampleColor(x, y, radius);
  } else {
    const sampleCanvas = options.underlyingCanvas || ctx.canvas;
    const sampleCtx = sampleCanvas ? sampleCanvas.getContext('2d') : null;
    if (sampleCtx) {
      sampled = sampleCanvasColor(sampleCtx, x, y, radius);
    }
  }

  const mixed = reservoir.mixWithCanvas(
    sampled,
    options.amountOfPaint ?? 0.65,
    options.densityOfPaint ?? 0.9,
    options.colorStretch ?? 0.75,
    options.mixingMode ?? 'blend',
    pressure,
    flow,
    stepDist,
    options.perceptualMixing !== false
  );

  if (options.sampler && mixed.alpha > 0.002) {
    options.sampler.depositDab(x, y, radius, mixed.r, mixed.g, mixed.b, mixed.alpha);
  }
  return mixed;
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
  const useTilt = Boolean(options.useTilt || options.angleDynamics === 'tilt');
  const grainAmount = options.grain ?? options.textureDensity ?? 0;

  let effectiveColor = isBgEraser ? '#ffffff' : color;
  const rawDensity = options.brushDensity ?? options.flow ?? (options.tipImage ? 0.85 : 1.0);
  let effectiveFlow = computeGapAdjustedAlpha(rawDensity, spacing, options.adjustDensityByGap);

  const rawPressure = point.pressure ?? 1.0;
  const effPressure = options.pressureCurve ? evaluateFastSpline(rawPressure, options.pressureCurve) : rawPressure;
  const minFactor = options.minSizeFactor ?? 0.2;
  let effWidth =
    point.width > 0
      ? Math.max(0.4, point.width)
      : Math.max(0.5, (options.size ?? 10) * (minFactor + (1.0 - minFactor) * effPressure));

  const tiltX = useTilt ? point.tiltX ?? 0 : 0;
  const tiltY = useTilt ? point.tiltY ?? 0 : 0;
  const tiltAngleDeg = Math.min(90, Math.sqrt(tiltX * tiltX + tiltY * tiltY));
  const tiltMagnitude = Math.sin((tiltAngleDeg * Math.PI) / 180);
  const tiltSpread = tiltMagnitude * (options.tiltScale ?? 1.0);
  const grainPressure =
    useTilt && tiltMagnitude > 0.01 ? effPressure * (1.0 - tiltMagnitude * 0.55) : effPressure;

  if (options.sizeSensor) {
    effWidth = Math.max(
      0.15,
      effWidth * evaluateCspSensor(options.sizeSensor, effPressure, tiltMagnitude, 0, dabHashFloat(point.x, point.y, 0, 50))
    );
  }
  if (options.opacitySensor) {
    effectiveFlow *= evaluateCspSensor(options.opacitySensor, effPressure, tiltMagnitude, 0, dabHashFloat(point.x, point.y, 0, 51));
  }
  if (options.densitySensor) {
    effectiveFlow *= evaluateCspSensor(options.densitySensor, effPressure, tiltMagnitude, 0, dabHashFloat(point.x, point.y, 0, 52));
  }
  if (useTilt && tiltMagnitude > 0.03 && (options.tipImage || grainAmount > 0.005)) {
    effectiveFlow *= 1.0 - tiltMagnitude * 0.28;
  }

  const isColorMixing = Boolean(options.colorMixing) && !isEraser && !isBgEraser;
  if (isColorMixing) {
    if (!options.reservoir) options.reservoir = new PaintReservoir(effectiveColor);
    const mixed = sampleAndMixColor(ctx, point.x, point.y, Math.max(1, effWidth * 0.5), effPressure, effectiveFlow, 0, options);
    effectiveColor = mixed.colorHex;
    effectiveFlow = mixed.alpha;
  }
  if (effectiveFlow <= 0.002) return;

  const gpuDabs = batchGpuDabs || null;
  const activeTip = options.tipImage
    ? selectTipImage(options.subTipImages, options.tipImage, options.subTipOrder, 0, 0, point.x, point.y)
    : undefined;
  const isColorTip = Boolean(options.isColorTip || (options.subTips && options.subTips[0]?.isColor));
  const aspect = activeTip
    ? (activeTip.naturalHeight || activeTip.height || 1) / (activeTip.naturalWidth || activeTip.width || 1)
    : 1.0;

  let angleRad = ((options.angle ?? 0) * Math.PI) / 180;
  if (useTilt && tiltMagnitude > 0.05) {
    angleRad = Math.atan2(tiltY, tiltX) + angleRad;
  }
  if (point.twist && (options.angleDynamics === 'twist' || useTilt)) {
    angleRad += (point.twist * Math.PI) / 180;
  }

  const hasPerPixelCpuGrain = !gpuDabs && grainAmount > 0.005 && typeof ctx.createPattern === 'function';
  if (!gpuDabs && grainAmount > 0.005 && !hasPerPixelCpuGrain) {
    const gNorm = sampleScalarPaperGrainNorm(point.x, point.y, effWidth, options.paperTextureScale ?? 1.0);
    const scalarMode = options.paperTextureMode === 'compare' ? 'subtract' : (options.paperTextureMode ?? 'subtract');
    effectiveFlow *= applyCspPaperTextureAlpha(
      1.0,
      gNorm,
      grainAmount,
      grainPressure,
      scalarMode,
      options.paperTextureBrightness ?? 0,
      options.paperTextureContrast ?? 0,
      Boolean(options.paperTextureInverted)
    );
  }
  if (effectiveFlow <= 0.002) return;

  const baseMaster = gpuDabs
    ? null
    : resolveCpuMaster(activeTip, effectiveColor, hardness, isEraser, isBgEraser, isColorTip, effWidth, aaMode);

  const dynamics = options.dynamics;
  const dabCount = Math.max(1, Math.min(10, Math.round(dynamics?.count ?? 1)));
  const sizeJitter = Math.max(0, Math.min(1, dynamics?.sizeJitter ?? 0));
  const angleJitter = Math.max(0, Math.min(1, dynamics?.angleJitter ?? 0));
  const roundnessJitter = Math.max(0, Math.min(1, dynamics?.roundnessJitter ?? 0));
  const scatter = Math.max(0, Math.min(5, dynamics?.scatter ?? 0));
  const flowJitter = Math.max(0, Math.min(1, dynamics?.flowJitter ?? 0));
  const colorJitterEnabled = Boolean(dynamics?.colorJitterEnabled);
  const primRgb = colorJitterEnabled || gpuDabs ? parseColorToRgb(effectiveColor) : null;
  const secRgb = colorJitterEnabled ? parseColorToRgb(options.secondaryColor || '#ffffff') : null;

  for (let k = 0; k < dabCount; k++) {
    let curDabW = effWidth;
    if (sizeJitter > 0) curDabW *= Math.max(0.01, 1.0 - dabHashFloat(point.x, point.y, k, 1) * sizeJitter);
    curDabW = Math.max(0.1, curDabW);

    let curDabThickness = thickness;
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
    if (colorJitterEnabled && primRgb && secRgb && dynamics) {
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
        curMaster = resolveCpuMaster(activeTip, cd.hex, hardness, isEraser, isBgEraser, isColorTip, curDabW, aaMode);
      }
    }

    let finalW = isVert ? curDabW * curDabThickness : curDabW;
    let finalH = isVert ? curDabW * aspect : curDabW * aspect * curDabThickness;
    if (useTilt && tiltMagnitude > 0.01) {
      finalW *= 1.0 + tiltSpread * 1.85;
      finalH *= Math.max(0.55, 1.0 / (1.0 + tiltMagnitude * 0.45));
    }

    const flips = resolveTipFlipSigns(options.flipH, options.flipV, k, curDabX, curDabY);

    if (curMaster && hasPerPixelCpuGrain) {
      const grained = applyCpuPerPixelPaperGrain(
        curMaster,
        curDabX,
        curDabY,
        finalW,
        finalH,
        grainAmount,
        grainPressure,
        options.paperTextureScale ?? 1.0,
        options.paperTextureImage
      );
      if (grained) curMaster = grained;
    }

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
        const spW = isVert ? pSize * curDabThickness : pSize;
        const spH = isVert ? pSize * aspect : pSize * aspect * curDabThickness;
        if (gpuDabs) {
          gpuDabs.push({
            x: spX, y: spY, width: spW, height: spH, angle: curDabAngle,
            r: dabR, g: dabG, b: dabB, alpha: curDabAlpha, pressure: grainPressure,
            strokeDist: 0, flipX: flips.signX, flipY: flips.signY,
          });
        } else if (curMaster) {
          drawSingleStamp(
            ctx, curMaster, spX, spY, spW, spH, curDabAngle, curDabAlpha,
            isEraser, isBgEraser, options.alphaLocked, options.isTransparentInk,
            flips.signX, flips.signY, aaMode, options.blendTipsMode
          );
        }
      }
    } else if (gpuDabs) {
      gpuDabs.push({
        x: curDabX, y: curDabY, width: finalW, height: finalH, angle: curDabAngle,
        r: dabR, g: dabG, b: dabB, alpha: curDabAlpha, pressure: grainPressure,
        strokeDist: 0, flipX: flips.signX, flipY: flips.signY,
      });
    } else if (curMaster) {
      drawSingleStamp(
        ctx, curMaster, curDabX, curDabY, finalW, finalH, curDabAngle, curDabAlpha,
        isEraser, isBgEraser, options.alphaLocked, options.isTransparentInk,
        flips.signX, flips.signY, aaMode, options.blendTipsMode
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
  dabCounter: { count: number } = { count: 0 },
  batchGpuDabs?: GpuDab[]
): number {
  const { totalLength: totalCurveLength, steps: arcSteps } = buildFastArcLengthScratch(p0, c1, c2, p3);
  if (totalCurveLength < 0.08) {
    return Math.max(0, remainderDist - totalCurveLength);
  }

  const isEraser = Boolean(options.isEraser);
  const isBgEraser = Boolean(options.isBgEraser);
  const baseColor = isBgEraser ? '#ffffff' : color;
  const hardness = options.hardness ?? 1.0;
  const tipImage = options.tipImage;
  const isColorMixing = Boolean(options.colorMixing) && !isEraser && !isBgEraser;

  if (isColorMixing && !options.reservoir) {
    options.reservoir = new PaintReservoir(baseColor);
  }

  const aspect = tipImage
    ? (tipImage.naturalHeight || tipImage.height || 1) / (tipImage.naturalWidth || tipImage.width || 1)
    : 1.0;
  const baseAngleRad = ((options.angle ?? 0) * Math.PI) / 180;
  const rawDensity = options.brushDensity ?? options.flow ?? (tipImage ? 0.85 : 1.0);
  const spacingRatio = Math.max(0.015, Math.min(1.0, options.spacing ?? (tipImage ? 0.07 : 0.08)));
  const baseFlow = computeGapAdjustedAlpha(rawDensity, spacingRatio, options.adjustDensityByGap);
  const thickness = options.thickness ?? 1.0;
  const isVert = Boolean(options.thicknessVertical);
  const rotationRandomScale = options.rotationRandomScale ?? 0;
  const useTilt = Boolean(options.useTilt || options.angleDynamics === 'tilt');
  const aaMode = options.antiAlias ?? 2;
  const grainAmount = options.grain ?? options.textureDensity ?? 0;
  const isColorTip = Boolean(options.isColorTip || (options.subTips && options.subTips[0]?.isColor));

  const gpuDabs = batchGpuDabs || null;
  const avgSegWidth = Math.max(0.5, (p0.width + p3.width) * 0.5);
  const hasMultiSubTips = Boolean(tipImage && options.subTipImages && options.subTipImages.length > 1);
  const staticMaster =
    isColorMixing || gpuDabs || hasMultiSubTips
      ? null
      : resolveCpuMaster(tipImage, baseColor, hardness, isEraser, isBgEraser, isColorTip, avgSegWidth, aaMode);

  const dynamics = options.dynamics;
  const dabCount = Math.max(1, Math.min(10, Math.round(dynamics?.count ?? 1)));
  const sizeJitter = Math.max(0, Math.min(1, dynamics?.sizeJitter ?? 0));
  const angleJitter = Math.max(0, Math.min(1, dynamics?.angleJitter ?? 0));
  const roundnessJitter = Math.max(0, Math.min(1, dynamics?.roundnessJitter ?? 0));
  const scatter = Math.max(0, Math.min(5, dynamics?.scatter ?? 0));
  const scatterBothAxes = Boolean(dynamics?.scatterBothAxes);
  const flowJitter = Math.max(0, Math.min(1, dynamics?.flowJitter ?? 0));
  const colorJitterEnabled = Boolean(dynamics?.colorJitterEnabled);
  const baseRgb = colorJitterEnabled || gpuDabs ? parseColorToRgb(baseColor) : null;
  const secRgb = colorJitterEnabled ? parseColorToRgb(options.secondaryColor || '#ffffff') : null;
  const minStepPx = tipImage ? 0.15 : 0.12;
  const hasPerPixelCpuGrain = !gpuDabs && grainAmount > 0.005 && typeof ctx.createPattern === 'function';

  let smoothCos = Math.cos(baseAngleRad);
  let smoothSin = Math.sin(baseAngleRad);
  let currentDist = remainderDist > 0 ? remainderDist : 0;

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

    let taperAlphaScale = 1.0;
    if (options.taper) {
      const inSharp = 0.35 + (1.0 - (options.taper.startingSharpness ?? 0.5)) * 1.1;
      const outSharp = 0.35 + (1.0 - (options.taper.endingSharpness ?? 0.5)) * 1.1;
      const inLen = options.taper.inLength || (options.taper.inRatio ? options.taper.inRatio * 2.5 : 0);
      if (options.taper.useIn && inLen > 0 && strokeDist < inLen) {
        const inFactor = Math.pow(Math.max(0.01, Math.min(1.0, strokeDist / inLen)), inSharp);
        if (options.taper.affectSize !== false) curWidth *= inFactor;
        if (options.taper.affectDensity || options.taper.affectOpacity) taperAlphaScale *= inFactor;
      }
      if (options.totalLength && options.totalLength > 0) {
        const distFromEnd = options.totalLength - strokeDist;
        const outLen = options.taper.outLength || (options.taper.outRatio ? options.taper.outRatio * 3.0 : 0);
        if (options.taper.useOut && outLen > 0 && distFromEnd < outLen) {
          const outFactor = Math.pow(Math.max(0.01, Math.min(1.0, distFromEnd / outLen)), outSharp);
          if (options.taper.affectSize !== false) curWidth *= outFactor;
          if (options.taper.affectDensity || options.taper.affectOpacity) taperAlphaScale *= outFactor;
        }
      }
    }

    const dabSeq = dabCounter.count++;
    const tiltX = useTilt ? pt.tiltX : 0;
    const tiltY = useTilt ? pt.tiltY : 0;
    const tiltAngleDeg = Math.min(90, Math.sqrt(tiltX * tiltX + tiltY * tiltY));
    const tiltMagnitude = Math.sin((tiltAngleDeg * Math.PI) / 180);
    const tiltSpread = tiltMagnitude * (options.tiltScale ?? 1.0);
    const grainPressure =
      useTilt && tiltMagnitude > 0.01 ? effPressure * (1.0 - tiltMagnitude * 0.55) : effPressure;

    if (options.sizeSensor) {
      curWidth *= evaluateCspSensor(
        options.sizeSensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 50)
      );
    }
    curWidth = Math.max(0.1, curWidth);

    let stampAngle = baseAngleRad;
    const angleMode = options.angleDynamics;
    if ((angleMode === 'direction' || angleMode === 'direction-random') && pt.speed > 0.05) {
      const targetAngle = Math.atan2(pt.dy, pt.dx) + baseAngleRad;
      smoothCos = smoothCos * 0.6 + Math.cos(targetAngle) * 0.4;
      smoothSin = smoothSin * 0.6 + Math.sin(targetAngle) * 0.4;
      stampAngle = Math.atan2(smoothSin, smoothCos);
    }
    if (angleMode === 'random' || angleMode === 'direction-random') {
      const rScale = angleMode === 'random' ? 1.0 : rotationRandomScale || 0.35;
      stampAngle += (dabHashFloat(pt.x, pt.y, dabSeq, 12) - 0.5) * Math.PI * 2 * rScale;
    } else if (rotationRandomScale > 0) {
      stampAngle += (dabHashFloat(pt.x, pt.y, dabSeq, 12) - 0.5) * Math.PI * 2 * rotationRandomScale;
    }

    if (useTilt && tiltMagnitude > 0.05) {
      stampAngle = Math.atan2(tiltY, tiltX) + baseAngleRad;
    }
    if (pt.twist && (angleMode === 'twist' || useTilt)) {
      stampAngle += (pt.twist * Math.PI) / 180;
    }

    let dabColor = baseColor;
    let dabAlpha = baseFlow * taperAlphaScale;
    let dabRgb = baseRgb;

    if (options.opacitySensor) {
      dabAlpha *= evaluateCspSensor(
        options.opacitySensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 51)
      );
    }
    if (options.densitySensor) {
      dabAlpha *= evaluateCspSensor(
        options.densitySensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 52)
      );
    }
    if (useTilt && tiltMagnitude > 0.03 && (tipImage || grainAmount > 0.005)) {
      dabAlpha *= 1.0 - tiltMagnitude * 0.28;
    }

    if (isColorMixing && options.reservoir) {
      const prelimStep = Math.max(0.15, curWidth * spacingRatio);
      const mixed = sampleAndMixColor(ctx, pt.x, pt.y, curWidth * 0.45, effPressure, dabAlpha, prelimStep, options);
      dabColor = mixed.colorHex;
      dabAlpha = mixed.alpha;
      if (gpuDabs) {
        dabRgb = { r: mixed.r, g: mixed.g, b: mixed.b };
      }
    }

    if (!gpuDabs && grainAmount > 0.005 && !hasPerPixelCpuGrain) {
      const gNorm = sampleScalarPaperGrainNorm(pt.x, pt.y, curWidth, options.paperTextureScale ?? 1.0);
      const scalarMode = options.paperTextureMode === 'compare' ? 'subtract' : (options.paperTextureMode ?? 'subtract');
      dabAlpha *= applyCspPaperTextureAlpha(
        1.0,
        gNorm,
        grainAmount,
        grainPressure,
        scalarMode,
        options.paperTextureBrightness ?? 0,
        options.paperTextureContrast ?? 0,
        Boolean(options.paperTextureInverted)
      );
    }

    const activeTip = tipImage
      ? selectTipImage(options.subTipImages, tipImage, options.subTipOrder, dabSeq, stampAngle, pt.x, pt.y)
      : undefined;
    const baseMaster = gpuDabs
      ? null
      : staticMaster ?? resolveCpuMaster(activeTip, dabColor, hardness, isEraser, isBgEraser, isColorTip, curWidth, aaMode);

    let tx = 1;
    let ty = 0;
    let nx = 0;
    let ny = 1;
    if (pt.speed > 0.001) {
      tx = pt.dx / pt.speed;
      ty = pt.dy / pt.speed;
      nx = -ty;
      ny = tx;
    }

    const primRgb = colorJitterEnabled && isColorMixing ? parseColorToRgb(dabColor) : dabRgb;
    let stepRefW = isVert ? curWidth * thickness : curWidth;
    let stepRefH = isVert ? curWidth * aspect : curWidth * aspect * thickness;

    for (let k = 0; k < dabCount; k++) {
      const seedIdx = dabSeq * 16 + k;
      let curDabW = curWidth;
      if (sizeJitter > 0) curDabW *= Math.max(0.01, 1.0 - dabHashFloat(pt.x, pt.y, seedIdx, 1) * sizeJitter);
      curDabW = Math.max(0.1, curDabW);

      let curDabThickness = thickness;
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

      let curMaster: CanvasImageSource | null = baseMaster;
      let dabR = primRgb ? primRgb.r / 255 : 0;
      let dabG = primRgb ? primRgb.g / 255 : 0;
      let dabB = primRgb ? primRgb.b / 255 : 0;

      if (colorJitterEnabled && primRgb && secRgb && dynamics) {
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
          curMaster = resolveCpuMaster(activeTip, cd.hex, hardness, isEraser, isBgEraser, isColorTip, curDabW, aaMode);
        }
      }

      let finalW = isVert ? curDabW * curDabThickness : curDabW;
      let finalH = isVert ? curDabW * aspect : curDabW * aspect * curDabThickness;
      if (useTilt && tiltMagnitude > 0.01) {
        finalW *= 1.0 + tiltSpread * 1.85;
        finalH *= Math.max(0.55, 1.0 / (1.0 + tiltMagnitude * 0.45));
      }
      stepRefW = finalW;
      stepRefH = finalH;

      if (curDabAlpha <= 0.002) continue;

      const flips = resolveTipFlipSigns(options.flipH, options.flipV, seedIdx, curDabX, curDabY);

      if (curMaster && hasPerPixelCpuGrain) {
        const grained = applyCpuPerPixelPaperGrain(
          curMaster,
          curDabX,
          curDabY,
          finalW,
          finalH,
          grainAmount,
          grainPressure,
          options.paperTextureScale ?? 1.0,
          options.paperTextureImage
        );
        if (grained) curMaster = grained;
      }

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
          const spW = isVert ? pSize * curDabThickness : pSize;
          const spH = isVert ? pSize * aspect : pSize * aspect * curDabThickness;
          if (gpuDabs) {
            gpuDabs.push({
              x: spX, y: spY, width: spW, height: spH, angle: curDabAngle,
              r: dabR, g: dabG, b: dabB, alpha: curDabAlpha, pressure: grainPressure,
              strokeDist, flipX: flips.signX, flipY: flips.signY,
            });
          } else if (curMaster) {
            drawSingleStamp(
              ctx, curMaster, spX, spY, spW, spH, curDabAngle, curDabAlpha,
              isEraser, isBgEraser, options.alphaLocked, options.isTransparentInk,
              flips.signX, flips.signY, aaMode, options.blendTipsMode
            );
          }
        }
      } else if (gpuDabs) {
        gpuDabs.push({
          x: curDabX, y: curDabY, width: finalW, height: finalH, angle: curDabAngle,
          r: dabR, g: dabG, b: dabB, alpha: curDabAlpha, pressure: grainPressure,
          strokeDist, flipX: flips.signX, flipY: flips.signY,
        });
      } else if (curMaster) {
        drawSingleStamp(
          ctx, curMaster, curDabX, curDabY, finalW, finalH, curDabAngle, curDabAlpha,
          isEraser, isBgEraser, options.alphaLocked, options.isTransparentInk,
          flips.signX, flips.signY, aaMode, options.blendTipsMode
        );
      }
    }

    currentDist += computeEllipticalStepDistance(
      stepRefW,
      stepRefH,
      stampAngle,
      pt.dx,
      pt.dy,
      spacingRatio,
      minStepPx
    );
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
    spacing: bs.spacing ?? 0.08,
    thickness: bs.thickness,
    thicknessVertical: bs.thicknessVertical,
    flipH: bs.flipH,
    flipV: bs.flipV,
    tipImage: bs.customTipImage,
    isColorTip: bs.isColorTip,
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
    subTips: bs.subTips,
    subTipOrder: bs.subTipOrder,
    subTipImages: bs.subTipImages,
    spray: bs.spray,
    taper: bs.taper,
    colorMixing: bs.colorMixing,
    perceptualMixing: bs.perceptualMixing,
    amountOfPaint: bs.amountOfPaint,
    densityOfPaint: bs.densityOfPaint,
    colorStretch: bs.colorStretch,
    mixingMode: bs.mixingMode,
    wetEdge: bs.wetEdge,
    wetEdgeRadius: bs.wetEdgeRadius,
    wetEdgeAlphaPower: bs.wetEdgeAlphaPower,
    wetEdgeValuePower: bs.wetEdgeValuePower,
    grain: bs.grain ?? bs.textureDensity,
    textureDensity: bs.textureDensity,
    paperTextureMode: bs.paperTextureMode,
    paperTextureBrightness: bs.paperTextureBrightness,
    paperTextureContrast: bs.paperTextureContrast,
    paperTextureInverted: bs.paperTextureInverted,
    paperTextureImage: bs.paperTextureImage,
    paperTextureScale: bs.paperTextureScale,
    paperTextureRotate: bs.paperTextureRotate,
    dualBrush: bs.dualBrush,
    dualTipImage: bs.dualTipImage,
    dualBrushCompositeMode: bs.dualBrushCompositeMode,
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
  allowGpuForMonochrome: boolean = false
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
  const strokeHardness = isMono ? 1.0 : resolvedSettings.hardness ?? 1.0;
  const strokeFlow = isMono ? 1.0 : resolvedSettings.flow ?? 1.0;
  const strokeSpacing = resolvedSettings.spacing ?? 0.08;
  const effectiveAntiAlias = isMono
    ? allowGpuForMonochrome && (resolvedSettings.antiAlias ?? 2) !== 0 && resolvedSettings.useGpu !== false
      ? resolvedSettings.antiAlias ?? 2
      : 0
    : resolvedSettings.antiAlias;

  const effectiveUnderlying = underlyingCanvas || ctx.canvas;
  const options = buildBrushRenderOptions(resolvedSettings, {
    hardness: strokeHardness,
    flow: strokeFlow,
    spacing: strokeSpacing,
    antiAlias: effectiveAntiAlias,
    underlyingCanvas: effectiveUnderlying,
    sampler: resolvedSettings.colorMixing
      ? explicitSampler || (effectiveUnderlying ? new LayerPixelSampler(effectiveUnderlying) : undefined)
      : undefined,
    reservoir: resolvedSettings.colorMixing && !isEraser && !isBgEraser ? new PaintReservoir(strokeColor) : undefined,
    isEraser: isEraser && !isBgEraser,
    isBgEraser,
    alphaLocked,
    isTransparentInk: Boolean(resolvedSettings.isTransparentInk),
  });

  let totalLen = 0;
  for (let i = 1; i < effectivePoints.length; i++) {
    totalLen += Math.hypot(effectivePoints[i].x - effectivePoints[i - 1].x, effectivePoints[i].y - effectivePoints[i - 1].y);
  }
  options.totalLength = totalLen;

  const emitStroke = (batchGpuDabs: GpuDab[] | undefined) => {
    options.currentStrokeDist = 0;
    drawBrushDot(ctx, effectivePoints[0], strokeColor, options, batchGpuDabs);
    if (effectivePoints.length === 1) return;

    const dabCounter = { count: 0 };
    const minInitDist = options.tipImage ? 0.15 : 0.12;
    let accDist = Math.max(minInitDist, Math.max(0.2, effectivePoints[0].width) * strokeSpacing);

    if (effectivePoints.length === 2) {
      const p0 = effectivePoints[0];
      const p1 = effectivePoints[1];
      const { c1, c2 } = centripetalCatmullRomToBezier(p0, p0, p1, p1);
      drawBrushCubicBezierSegment(ctx, p0, c1, c2, p1, strokeColor, options, accDist, dabCounter, batchGpuDabs);
      return;
    }

    const p0 = effectivePoints[0];
    const p1 = effectivePoints[1];
    const p2 = effectivePoints[2];
    const first = centripetalCatmullRomToBezier(p0, p0, p1, p2);
    accDist = drawBrushCubicBezierSegment(ctx, p0, first.c1, first.c2, p1, strokeColor, options, accDist, dabCounter, batchGpuDabs);
    options.currentStrokeDist = (options.currentStrokeDist ?? 0) + Math.hypot(p1.x - p0.x, p1.y - p0.y);

    for (let i = 2; i < effectivePoints.length - 1; i++) {
      const seg = centripetalCatmullRomToBezier(
        effectivePoints[i - 2],
        effectivePoints[i - 1],
        effectivePoints[i],
        effectivePoints[i + 1]
      );
      accDist = drawBrushCubicBezierSegment(
        ctx,
        effectivePoints[i - 1],
        seg.c1,
        seg.c2,
        effectivePoints[i],
        strokeColor,
        options,
        accDist,
        dabCounter,
        batchGpuDabs
      );
      options.currentStrokeDist =
        (options.currentStrokeDist ?? 0) +
        Math.hypot(effectivePoints[i].x - effectivePoints[i - 1].x, effectivePoints[i].y - effectivePoints[i - 1].y);
    }

    const n = effectivePoints.length;
    const last = centripetalCatmullRomToBezier(effectivePoints[n - 3], effectivePoints[n - 2], effectivePoints[n - 1], effectivePoints[n - 1]);
    drawBrushCubicBezierSegment(
      ctx,
      effectivePoints[n - 2],
      last.c1,
      last.c2,
      effectivePoints[n - 1],
      strokeColor,
      options,
      accDist,
      dabCounter,
      batchGpuDabs
    );
  };

  if (canUseWebGlForBrush(options)) {
    const batchGpuDabs: GpuDab[] = [];
    emitStroke(batchGpuDabs);
    if (flushGpuDabs(ctx, batchGpuDabs, strokeColor, options)) {
      return;
    }
  }

  // Single general CPU Canvas2D fallback (WebGL unavailable/lost, AA=0, CPU colorMixing, or multi-subTip)
  emitStroke(undefined);
}
