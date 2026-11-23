/**
 * Real-Time Color Mixing & Subtractive Pigment Engine for Ink Studio.
 * Implements authentic Clip Studio Paint (CSP) & Photoshop Mixer Brush mathematics:
 * - Subtractive Pigment Mixing (OKLab + Kubelka-Munk absorption / scattering)
 *   (Yellow + Blue = vibrant Green, Red + Blue = Violet, Red + Yellow = Orange)
 * - Ultra-Fast Zero-Lag In-Memory Pixel Sampler (LayerPixelSampler)
 *   (Zero GPU readbacks, eliminates synchronous getImageData stalls for 120+ FPS)
 * - Dynamic Paint Reservoir tracking with physical pigment capacity
 * - Amount of Paint (0.0 Pure Smudge / Blender to 1.0 Fresh Pigment)
 * - Density of Paint (translucent glaze to thick impasto deposition)
 * - Color Stretch (exponential half-life decay along stroke path)
 * - Mixing Modes: 'blend' (subtractive harmonious) and 'running_color' (wet smear drag)
 */

export interface RgbColor {
  r: number; // [0, 255]
  g: number;
  b: number;
}

export interface RgbaColor extends RgbColor {
  a: number; // [0, 1]
}

export interface OklabColor {
  L: number; // perceptual lightness [0, 1]
  a: number; // green (-) to red (+)
  b: number; // blue (-) to yellow (+)
}

// Fast color parsing cache
const colorRgbCache = new Map<string, RgbColor>();

/**
 * Parses any CSS color string (#rrggbb, #rgb, rgb(...), rgba(...)) into RGB [0, 255].
 */
export function parseColorToRgb(color: string): RgbColor {
  const cached = colorRgbCache.get(color);
  if (cached) return cached;

  let r = 0;
  let g = 0;
  let b = 0;

  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16) || 0;
      g = parseInt(hex[1] + hex[1], 16) || 0;
      b = parseInt(hex[2] + hex[2], 16) || 0;
    } else if (hex.length >= 6) {
      r = parseInt(hex.slice(0, 2), 16) || 0;
      g = parseInt(hex.slice(2, 4), 16) || 0;
      b = parseInt(hex.slice(4, 6), 16) || 0;
    }
  } else if (color.startsWith('rgb')) {
    const match = color.match(/\(([^)]+)\)/);
    if (match) {
      const parts = match[1].split(',').map((p) => parseFloat(p.trim()));
      r = parts[0] ?? 0;
      g = parts[1] ?? 0;
      b = parts[2] ?? 0;
    }
  }

  const result: RgbColor = { r, g, b };
  if (colorRgbCache.size < 300) {
    colorRgbCache.set(color, result);
  }
  return result;
}

/**
 * Converts RGB components [0, 255] into a hex string (#rrggbb).
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const cr = Math.max(0, Math.min(255, Math.round(r)));
  const cg = Math.max(0, Math.min(255, Math.round(g)));
  const cb = Math.max(0, Math.min(255, Math.round(b)));
  return `#${((1 << 24) + (cr << 16) + (cg << 8) + cb).toString(16).slice(1)}`;
}

// -------------------------------------------------------------
// Color Science: sRGB <-> Linear RGB <-> OKLab (Fast LUT + Float Precision)
// -------------------------------------------------------------

const SRGB_TO_LINEAR_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  SRGB_TO_LINEAR_LUT[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function srgbToLinear(c: number): number {
  if (c <= 0) return 0;
  if (c >= 255) return 1;
  const idx = c | 0;
  const frac = c - idx;
  if (idx >= 255) return 1;
  const v0 = SRGB_TO_LINEAR_LUT[idx];
  return frac > 0 ? v0 + (SRGB_TO_LINEAR_LUT[idx + 1] - v0) * frac : v0;
}

function linearToSrgbFloat(c: number): number {
  const clamped = c <= 0 ? 0 : c >= 1 ? 1 : c;
  const v = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return v <= 0 ? 0 : v >= 1 ? 255 : v * 255;
}

/**
 * Converts Linear RGB to OKLab perceptual color space.
 */
export function linearRgbToOklab(r: number, g: number, b: number): OklabColor {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/**
 * Converts OKLab to Linear RGB.
 */
export function oklabToLinearRgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

import { SparseTileGrid, TILE_SIZE, globalTileGrid } from './tileEngine';
import type { BristleProfilePreset, BristleSettings, NaturalMixingMode, NaturalPaintSettings } from '../types/editor';

// -------------------------------------------------------------
// 7-Band Spectral Kubelka-Munk Pigment Engine (420–660nm, CIE 1931 D65)
// Closed-form physical pigment reflectance decomposition + Kubelka-Munk K/S
// absorption/scattering blending + OKLab perceptual lightness/chroma polish.
// Guarantees:
// - Blue + Yellow -> vibrant emerald/leaf green (no gray mud)
// - Green + Magenta -> warm golden-amber / coral (no dead olive-gray)
// - Red + Blue -> rich royal violet; Red + Yellow -> luminous orange
// - Exact self-mix invariance: mix(c, c, t) === c
// - Exact neutral-gray invariance: Black + White stays pure neutral gray
// -------------------------------------------------------------

const KM_LO = 0.025;
const KM_SPAN = 0.97;
const KM_INV_SPAN = 1.0 / KM_SPAN;
const KM_EXP = 0.72;
const KM_INV_EXP = 1.0 / KM_EXP;

// Normalized CIE 1931 D65 band-to-Linear-sRGB weights (columns sum to 1.0)
const SPEC_W_R = new Float32Array([0.140, 0.030, -0.145, -0.080, 0.365, 0.465, 0.225]);
const SPEC_W_G = new Float32Array([-0.050, 0.045, 0.250, 0.500, 0.300, -0.018, -0.027]);
const SPEC_W_B = new Float32Array([0.340, 0.550, 0.145, -0.028, -0.007, 0.000, 0.000]);
{
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < 7; i++) {
    sr += SPEC_W_R[i];
    sg += SPEC_W_G[i];
    sb += SPEC_W_B[i];
  }
  for (let i = 0; i < 7; i++) {
    SPEC_W_R[i] /= sr;
    SPEC_W_G[i] /= sg;
    SPEC_W_B[i] /= sb;
  }
}

// Calibrated physical artist-pigment reflectance curves across 7 bands (420..660nm)
const BASIS_R = new Float32Array([0.025, 0.018, 0.020, 0.035, 0.360, 0.965, 0.990]);
const BASIS_G = new Float32Array([0.020, 0.040, 0.420, 0.980, 0.900, 0.420, 0.060]);
const BASIS_B = new Float32Array([0.880, 0.990, 0.780, 0.340, 0.025, 0.020, 0.055]);
const BASIS_C = new Float32Array([0.720, 0.980, 0.990, 0.840, 0.140, 0.025, 0.025]);
const BASIS_M = new Float32Array([0.780, 0.500, 0.055, 0.025, 0.640, 0.975, 0.990]);
const BASIS_Y = new Float32Array([0.018, 0.022, 0.280, 0.930, 0.995, 0.990, 0.980]);

// Module-level scratch buffers for zero-allocation hot-loop pigment mixing
const _kmSp1 = new Float32Array(7);
const _kmSp2 = new Float32Array(7);
const _kmSpM = new Float32Array(7);

function linearRgbToReflectance(r: number, g: number, b: number, out: Float32Array): void {
  const rr = KM_LO + r * KM_SPAN;
  const gg = KM_LO + g * KM_SPAN;
  const bb = KM_LO + b * KM_SPAN;

  if (rr <= gg && rr <= bb) {
    const w = rr;
    if (gg <= bb) {
      const c = gg - rr;
      const p = bb - gg;
      for (let i = 0; i < 7; i++) out[i] = w + c * BASIS_C[i] + p * BASIS_B[i];
    } else {
      const c = bb - rr;
      const p = gg - bb;
      for (let i = 0; i < 7; i++) out[i] = w + c * BASIS_C[i] + p * BASIS_G[i];
    }
  } else if (gg <= rr && gg <= bb) {
    const w = gg;
    if (rr <= bb) {
      const c = rr - gg;
      const p = bb - rr;
      for (let i = 0; i < 7; i++) out[i] = w + c * BASIS_M[i] + p * BASIS_B[i];
    } else {
      const c = bb - gg;
      const p = rr - bb;
      for (let i = 0; i < 7; i++) out[i] = w + c * BASIS_M[i] + p * BASIS_R[i];
    }
  } else {
    const w = bb;
    if (rr <= gg) {
      const c = rr - bb;
      const p = gg - rr;
      for (let i = 0; i < 7; i++) out[i] = w + c * BASIS_Y[i] + p * BASIS_G[i];
    } else {
      const c = gg - bb;
      const p = rr - gg;
      for (let i = 0; i < 7; i++) out[i] = w + c * BASIS_Y[i] + p * BASIS_R[i];
    }
  }
}

/**
 * Encodes an sRGB color [0..255] into 7-band compressed Kubelka-Munk K/S + 3 linear residual channels
 * (10 floats written starting at `offset`). Useful for fast separable spectral convolution (Pigment Blur).
 */
export function encodeSrgbToSpectralKS(
  r: number,
  g: number,
  b: number,
  out: Float32Array,
  offset: number
): void {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  linearRgbToReflectance(lr, lg, lb, _kmSp1);

  let br = 0;
  let bg = 0;
  let bb = 0;
  for (let i = 0; i < 7; i++) {
    const sp = _kmSp1[i];
    br += sp * SPEC_W_R[i];
    bg += sp * SPEC_W_G[i];
    bb += sp * SPEC_W_B[i];
    const rc = sp < 0.02 ? 0.02 : sp > 0.998 ? 0.998 : sp;
    const ks = ((1 - rc) * (1 - rc)) / (2 * rc);
    out[offset + i] = Math.pow(ks, KM_EXP);
  }
  out[offset + 7] = lr - (br - KM_LO) * KM_INV_SPAN;
  out[offset + 8] = lg - (bg - KM_LO) * KM_INV_SPAN;
  out[offset + 9] = lb - (bb - KM_LO) * KM_INV_SPAN;
}

/**
 * Decodes 7-band compressed Kubelka-Munk K/S + 3 linear residual channels back to sRGB [0..255].
 */
export function decodeSpectralKSToSrgb(
  buf: Float32Array,
  offset: number,
  out: RgbColor
): RgbColor {
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < 7; i++) {
    const cks = buf[offset + i];
    const ks = cks > 0 ? Math.pow(cks, KM_INV_EXP) : 0;
    const ref = 1 + ks - Math.sqrt(ks * ks + 2 * ks);
    mr += ref * SPEC_W_R[i];
    mg += ref * SPEC_W_G[i];
    mb += ref * SPEC_W_B[i];
  }
  const lr = (mr - KM_LO) * KM_INV_SPAN + buf[offset + 7];
  const lg = (mg - KM_LO) * KM_INV_SPAN + buf[offset + 8];
  const lb = (mb - KM_LO) * KM_INV_SPAN + buf[offset + 9];
  out.r = linearToSrgbFloat(lr);
  out.g = linearToSrgbFloat(lg);
  out.b = linearToSrgbFloat(lb);
  return out;
}

/**
 * Zero-allocation 7-Band Spectral Kubelka-Munk pigment mixer writing directly into `out`.
 * `pigmentStrength` in [0..1]: 0.0 = regular sRGB blend, 1.0 = full physical Kubelka-Munk pigment blend.
 */
export function mixPigmentRgbOut(
  r1In: number,
  g1In: number,
  b1In: number,
  r2In: number,
  g2In: number,
  b2In: number,
  weight2: number,
  pigmentStrength: number,
  out: RgbColor
): RgbColor {
  const t = weight2 <= 0 ? 0 : weight2 >= 1 ? 1 : weight2;
  if (t <= 0.0001) {
    out.r = r1In;
    out.g = g1In;
    out.b = b1In;
    return out;
  }
  if (t >= 0.9999) {
    out.r = r2In;
    out.g = g2In;
    out.b = b2In;
    return out;
  }

  const strength = pigmentStrength <= 0 ? 0 : pigmentStrength >= 1 ? 1 : pigmentStrength;
  if (strength <= 0.005) {
    out.r = r1In + (r2In - r1In) * t;
    out.g = g1In + (g2In - g1In) * t;
    out.b = b1In + (b2In - b1In) * t;
    return out;
  }

  const invT = 1 - t;
  const r1 = srgbToLinear(r1In);
  const g1 = srgbToLinear(g1In);
  const b1 = srgbToLinear(b1In);

  const r2 = srgbToLinear(r2In);
  const g2 = srgbToLinear(g2In);
  const b2 = srgbToLinear(b2In);

  // 1. Decompose into 7-band physical reflectance spectra + exact linear RGB residuals
  linearRgbToReflectance(r1, g1, b1, _kmSp1);
  linearRgbToReflectance(r2, g2, b2, _kmSp2);

  let b1r = 0;
  let b1g = 0;
  let b1b = 0;
  let b2r = 0;
  let b2g = 0;
  let b2b = 0;
  for (let i = 0; i < 7; i++) {
    const s1 = _kmSp1[i];
    const s2 = _kmSp2[i];
    const wr = SPEC_W_R[i];
    const wg = SPEC_W_G[i];
    const wb = SPEC_W_B[i];
    b1r += s1 * wr;
    b1g += s1 * wg;
    b1b += s1 * wb;
    b2r += s2 * wr;
    b2g += s2 * wg;
    b2b += s2 * wb;
  }
  const res1r = r1 - (b1r - KM_LO) * KM_INV_SPAN;
  const res1g = g1 - (b1g - KM_LO) * KM_INV_SPAN;
  const res1b = b1 - (b1b - KM_LO) * KM_INV_SPAN;
  const res2r = r2 - (b2r - KM_LO) * KM_INV_SPAN;
  const res2g = g2 - (b2g - KM_LO) * KM_INV_SPAN;
  const res2b = b2 - (b2b - KM_LO) * KM_INV_SPAN;

  // 2. Perceptual luminance concentration (physical tinting strength balance)
  const Y1 = 0.2126 * r1 + 0.7152 * g1 + 0.0722 * b1;
  const Y2 = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
  const conc1 = Math.pow(0.06 + Y1, 0.36);
  const conc2 = Math.pow(0.06 + Y2, 0.36);
  const w1Raw = invT * conc1;
  const w1 = w1Raw / (w1Raw + t * conc2);
  const w2 = 1 - w1;

  // 3. Mix in Kubelka-Munk K/S absorption-scattering space and reconstruct Linear RGB
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < 7; i++) {
    const a = _kmSp1[i] < 0.02 ? 0.02 : _kmSp1[i] > 0.998 ? 0.998 : _kmSp1[i];
    const b = _kmSp2[i] < 0.02 ? 0.02 : _kmSp2[i] > 0.998 ? 0.998 : _kmSp2[i];
    const ks1 = Math.pow(((1 - a) * (1 - a)) / (2 * a), KM_EXP);
    const ks2 = Math.pow(((1 - b) * (1 - b)) / (2 * b), KM_EXP);
    const ks = Math.pow(ks1 * w1 + ks2 * w2, KM_INV_EXP);
    const ref = 1 + ks - Math.sqrt(ks * ks + 2 * ks);
    _kmSpM[i] = ref;
    mr += ref * SPEC_W_R[i];
    mg += ref * SPEC_W_G[i];
    mb += ref * SPEC_W_B[i];
  }

  const mixR = Math.max(0, (mr - KM_LO) * KM_INV_SPAN + res1r * invT + res2r * t);
  const mixG = Math.max(0, (mg - KM_LO) * KM_INV_SPAN + res1g * invT + res2g * t);
  const mixB = Math.max(0, (mb - KM_LO) * KM_INV_SPAN + res1b * invT + res2b * t);

  // 4. OKLab perceptual lightness & chroma polish with hue-safe gamut clamping
  const lab1 = linearRgbToOklab(r1, g1, b1);
  const lab2 = linearRgbToOklab(r2, g2, b2);
  const labM = linearRgbToOklab(mixR, mixG, mixB);

  const targetL = lab1.L * invT + lab2.L * t;
  const tunedL = Math.max(0, Math.min(1, labM.L * 0.40 + targetL * 0.60));

  const c1Chroma = Math.hypot(lab1.a, lab1.b);
  const c2Chroma = Math.hypot(lab2.a, lab2.b);
  const mChroma = Math.hypot(labM.a, labM.b);
  const linChroma = c1Chroma * invT + c2Chroma * t;
  let chromaBoost = 1.0;
  if (mChroma > 0.008 && linChroma > mChroma) {
    const targetC = mChroma + (linChroma - mChroma) * 0.50;
    chromaBoost = Math.min(1.65, targetC / mChroma);
  }
  const aM = labM.a * chromaBoost;
  const bM = labM.b * chromaBoost;

  let finalLinear = oklabToLinearRgb(tunedL, aM, bM);
  const minCh = Math.min(finalLinear.r, finalLinear.g, finalLinear.b);
  const maxCh = Math.max(finalLinear.r, finalLinear.g, finalLinear.b);
  if (minCh < 0 || maxCh > 1) {
    const lGray = oklabToLinearRgb(tunedL, 0, 0).r;
    let scale = 1.0;
    if (minCh < 0 && lGray > minCh) {
      scale = Math.min(scale, lGray / (lGray - minCh));
    }
    if (maxCh > 1 && maxCh > lGray) {
      scale = Math.min(scale, (1 - lGray) / (maxCh - lGray));
    }
    scale = Math.max(0, Math.min(1, scale));
    finalLinear = oklabToLinearRgb(tunedL, aM * scale, bM * scale);
  }

  const subR = linearToSrgbFloat(finalLinear.r);
  const subG = linearToSrgbFloat(finalLinear.g);
  const subB = linearToSrgbFloat(finalLinear.b);

  if (strength >= 0.995) {
    out.r = subR;
    out.g = subG;
    out.b = subB;
    return out;
  }

  const linR = r1In + (r2In - r1In) * t;
  const linG = g1In + (g2In - g1In) * t;
  const linB = b1In + (b2In - b1In) * t;
  out.r = linR + (subR - linR) * strength;
  out.g = linG + (subG - linG) * strength;
  out.b = linB + (subB - linB) * strength;
  return out;
}

/**
 * Subtractive Pigment Mixing (Physical Paint Simulation — 7-Band Spectral Kubelka-Munk + OKLab).
 * Simulates real-world physical absorption and spectral overlap where Blue + Yellow = vibrant Green,
 * Green + Magenta = warm golden-amber/coral, Red + Blue = Violet, Red + Yellow = Orange.
 */
export function mixSubtractivePigments(
  c1: RgbColor,
  c2: RgbColor,
  weight2: number // 0.0 = 100% c1, 1.0 = 100% c2
): RgbColor {
  const out: RgbColor = { r: c1.r, g: c1.g, b: c1.b };
  return mixPigmentRgbOut(c1.r, c1.g, c1.b, c2.r, c2.g, c2.b, weight2, 1.0, out);
}

/**
 * Blends two colors with configurable subtractive pigment mixing strength [0..1].
 * 0.0 = standard linear RGB interpolation; 1.0 = full 7-band Kubelka-Munk + OKLab pigment mixing.
 */
export function mixPigmentsWithStrength(
  c1: RgbColor,
  c2: RgbColor,
  weight2: number,
  pigmentStrength: number = 1.0
): RgbColor {
  const out: RgbColor = { r: c1.r, g: c1.g, b: c1.b };
  return mixPigmentRgbOut(c1.r, c1.g, c1.b, c2.r, c2.g, c2.b, weight2, pigmentStrength, out);
}

// -------------------------------------------------------------
// Ultra-Fast Zero-Lag Tile-Aware In-Memory Pixel Sampler
// Eliminates full-canvas GPU readback stalls (getImageData) during live drawing!
// -------------------------------------------------------------

export class LayerPixelSampler {
  public width: number;
  public height: number;
  public data: Uint8ClampedArray;
  public u32: Uint32Array;
  private sourceCtx: CanvasRenderingContext2D | null = null;
  private tileGrid: SparseTileGrid | null = null;
  private layerId: string | null = null;
  private useLazyTiles: boolean = false;
  private lazyTiles: Map<number, Uint8ClampedArray> = new Map();
  private origTilesMap: Map<number, ImageData> | null = null;
  private tilesX: number = 1;

  constructor(
    sourceCanvas: HTMLCanvasElement | { width: number; height: number } | null,
    layerId?: string,
    tileGrid: SparseTileGrid = globalTileGrid,
    origTilesMap?: Map<number, ImageData>
  ) {
    this.width = sourceCanvas?.width ?? 0;
    this.height = sourceCanvas?.height ?? 0;
    this.tilesX = Math.max(1, Math.ceil(this.width / TILE_SIZE));
    this.origTilesMap = origTilesMap ?? null;
    this.sourceCtx =
      sourceCanvas && 'getContext' in sourceCanvas && typeof sourceCanvas.getContext === 'function'
        ? sourceCanvas.getContext('2d', { willReadFrequently: true })
        : null;

    // If a SparseTileGrid has tiles for this layer, or if no source canvas is provided (tile-native layer),
    // or if the canvas is large (> 512x512), or if an origTilesMap is provided for clean live sampling,
    // use zero-stall on-demand 256x256 tile caching instead of a synchronous full-document getImageData!
    const hasGridTiles = Boolean(layerId && tileGrid && (tileGrid.hasLayerTiles(layerId) || tileGrid.isLayerIngested(layerId)));
    const isLargeCanvas = this.width * this.height > 512 * 512;

    if (hasGridTiles || !this.sourceCtx || isLargeCanvas || Boolean(origTilesMap)) {
      this.useLazyTiles = true;
      this.layerId = layerId ?? null;
      this.tileGrid = layerId && tileGrid ? tileGrid : null;
      // Allocate a minimal 1-pixel placeholder for legacy property access
      this.data = new Uint8ClampedArray(4);
      this.u32 = new Uint32Array(this.data.buffer);
    } else if (this.sourceCtx && this.width > 0 && this.height > 0) {
      try {
        const imgData = this.sourceCtx.getImageData(0, 0, this.width, this.height);
        this.data = imgData.data;
        this.u32 = new Uint32Array(this.data.buffer);
      } catch {
        this.data = new Uint8ClampedArray(Math.max(4, this.width * this.height * 4));
        this.u32 = new Uint32Array(this.data.buffer);
      }
    } else {
      this.data = new Uint8ClampedArray(Math.max(4, this.width * this.height * 4));
      this.u32 = new Uint32Array(this.data.buffer);
    }
  }

  /**
   * Fetches or initializes a 256x256 RGBA tile in CPU memory on demand (zero full-canvas stall).
   */
  private getOrLoadTile(tx: number, ty: number): Uint8ClampedArray {
    const key = ty * this.tilesX + tx;
    let buf = this.lazyTiles.get(key);
    if (buf) return buf;

    if (this.origTilesMap) {
      const origImg = this.origTilesMap.get(ty * 65536 + tx);
      if (origImg) {
        buf = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
        if (origImg.width === TILE_SIZE && origImg.height === TILE_SIZE) {
          buf.set(origImg.data);
        } else {
          for (let row = 0; row < origImg.height; row++) {
            const srcOff = row * origImg.width * 4;
            const dstOff = row * TILE_SIZE * 4;
            buf.set(origImg.data.subarray(srcOff, srcOff + origImg.width * 4), dstOff);
          }
        }
        this.lazyTiles.set(key, buf);
        return buf;
      }
    }

    if (this.tileGrid && this.layerId) {
      const tile = this.tileGrid.getTile(this.layerId, tx, ty);
      if (tile) {
        const rgba = this.tileGrid.getTileAsRGBA(tile);
        buf = new Uint8ClampedArray(rgba.length);
        buf.set(rgba);
        this.lazyTiles.set(key, buf);
        return buf;
      }
      if (this.tileGrid.isLayerIngested(this.layerId)) {
        buf = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
        this.lazyTiles.set(key, buf);
        return buf;
      }
    }

    buf = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
    if (this.sourceCtx) {
      const sx = tx * TILE_SIZE;
      const sy = ty * TILE_SIZE;
      const sw = Math.min(TILE_SIZE, this.width - sx);
      const sh = Math.min(TILE_SIZE, this.height - sy);
      if (sw > 0 && sh > 0) {
        try {
          const img = this.sourceCtx.getImageData(sx, sy, sw, sh);
          if (sw === TILE_SIZE && sh === TILE_SIZE) {
            buf.set(img.data);
          } else {
            for (let row = 0; row < sh; row++) {
              const srcOff = row * sw * 4;
              const dstOff = row * TILE_SIZE * 4;
              buf.set(img.data.subarray(srcOff, srcOff + sw * 4), dstOff);
            }
          }
        } catch {
          // Ignore security/context errors
        }
      }
    }
    this.lazyTiles.set(key, buf);
    return buf;
  }

  /**
   * Samples average color and opacity in microseconds with ZERO full-canvas GPU pipeline flushes!
   */
  public sampleColor(cx: number, cy: number, radius: number): RgbaColor {
    const r = Math.max(1, Math.min(64, Math.round(radius)));
    const ix = Math.round(cx);
    const iy = Math.round(cy);
    const w = this.width;
    const h = this.height;

    if (ix < -r || ix >= w + r || iy < -r || iy >= h + r) {
      return { r: 255, g: 255, b: 255, a: 0 };
    }

    if (this.useLazyTiles) {
      if (r <= 2) {
        const clampedX = Math.max(0, Math.min(w - 1, ix));
        const clampedY = Math.max(0, Math.min(h - 1, iy));
        const tile = this.getOrLoadTile(clampedX >> 8, clampedY >> 8);
        const idx = (((clampedY & 255) << 8) + (clampedX & 255)) << 2;
        const alpha = tile[idx + 3];
        return {
          r: tile[idx],
          g: tile[idx + 1],
          b: tile[idx + 2],
          a: alpha / 255,
        };
      }

      const x0 = Math.max(0, ix - r);
      const x1 = Math.min(w - 1, ix + r);
      const y0 = Math.max(0, iy - r);
      const y1 = Math.min(h - 1, iy + r);

      const step = Math.max(1, Math.floor(r / 3.5));
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let weightSum = 0;
      let radialAreaSum = 0;
      const rSq = r * r;

      for (let y = y0; y <= y1; y += step) {
        const dy = y - iy;
        const dySq = dy * dy;
        const ty = y >> 8;
        const lyOffset = (y & 255) << 8;
        for (let x = x0; x <= x1; x += step) {
          const dx = x - ix;
          const distSq = dx * dx + dySq;
          if (distSq <= rSq) {
            const geomWeight = 1 - distSq / rSq;
            radialAreaSum += geomWeight;
            const tile = this.getOrLoadTile(x >> 8, ty);
            const idx = (lyOffset + (x & 255)) << 2;
            const alpha = tile[idx + 3];
            if (alpha > 4) {
              const radialWeight = geomWeight * (alpha / 255);
              sumR += tile[idx] * radialWeight;
              sumG += tile[idx + 1] * radialWeight;
              sumB += tile[idx + 2] * radialWeight;
              weightSum += radialWeight;
            }
          }
        }
      }

      if (weightSum > 0.001 && radialAreaSum > 0) {
        return {
          r: sumR / weightSum,
          g: sumG / weightSum,
          b: sumB / weightSum,
          a: Math.min(1.0, weightSum / radialAreaSum),
        };
      }
      return { r: 255, g: 255, b: 255, a: 0 };
    }

    // Direct center sample for fine tips (<= 2.5px)
    if (r <= 2) {
      const clampedX = Math.max(0, Math.min(w - 1, ix));
      const clampedY = Math.max(0, Math.min(h - 1, iy));
      const idx = (clampedY * w + clampedX) * 4;
      const alpha = this.data[idx + 3];
      return {
        r: this.data[idx],
        g: this.data[idx + 1],
        b: this.data[idx + 2],
        a: alpha / 255,
      };
    }

    const x0 = Math.max(0, ix - r);
    const x1 = Math.min(w - 1, ix + r);
    const y0 = Math.max(0, iy - r);
    const y1 = Math.min(h - 1, iy + r);

    const step = Math.max(1, Math.floor(r / 3.5));
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let weightSum = 0;
    let radialAreaSum = 0;
    const rSq = r * r;

    for (let y = y0; y <= y1; y += step) {
      const dy = y - iy;
      const dySq = dy * dy;
      const rowOffset = y * w;
      for (let x = x0; x <= x1; x += step) {
        const dx = x - ix;
        const distSq = dx * dx + dySq;
        if (distSq <= rSq) {
          const geomWeight = 1 - distSq / rSq;
          radialAreaSum += geomWeight;
          const idx = (rowOffset + x) * 4;
          const alpha = this.data[idx + 3];
          if (alpha > 4) {
            // Inverse-distance radial weight
            const radialWeight = geomWeight * (alpha / 255);
            sumR += this.data[idx] * radialWeight;
            sumG += this.data[idx + 1] * radialWeight;
            sumB += this.data[idx + 2] * radialWeight;
            weightSum += radialWeight;
          }
        }
      }
    }

    if (weightSum > 0.001 && radialAreaSum > 0) {
      return {
        r: sumR / weightSum,
        g: sumG / weightSum,
        b: sumB / weightSum,
        a: Math.min(1.0, weightSum / radialAreaSum),
      };
    }

    return { r: 255, g: 255, b: 255, a: 0 };
  }

  /**
   * Updates in-memory pixel buffer with newly laid paint so subsequent stamps
   * along the active stroke immediately pick up freshly mixed color without sparse grid gaps.
   */
  public depositDab(
    cx: number,
    cy: number,
    radius: number,
    r: number,
    g: number,
    b: number,
    a: number
  ): void {
    if (a <= 0.002 || this.width <= 0 || this.height <= 0) return;
    const rad = Math.max(1, Math.min(64, Math.round(radius)));
    const ix = Math.round(cx);
    const iy = Math.round(cy);
    const w = this.width;
    const h = this.height;

    const x0 = Math.max(0, ix - rad);
    const x1 = Math.min(w - 1, ix + rad);
    const y0 = Math.max(0, iy - rad);
    const y1 = Math.min(h - 1, iy + rad);
    if (x0 > x1 || y0 > y1) return;

    const radSq = rad * rad;
    const invRadSq = 1 / radSq;
    // Contiguous pixel fill for <= 14px, dense 2x2 block fill for larger brushes (zero Swiss-cheese gaps!)
    const step = rad > 14 ? 2 : 1;

    const blendPixel = (px: number, py: number, effAlpha: number) => {
      if (this.useLazyTiles) {
        const tile = this.getOrLoadTile(px >> 8, py >> 8);
        const idx = (((py & 255) << 8) + (px & 255)) << 2;
        const dstA = tile[idx + 3] / 255;
        const outA = effAlpha + dstA * (1 - effAlpha);
        if (outA > 0.001) {
          const inv = 1 / outA;
          tile[idx] = Math.round((r * effAlpha + tile[idx] * dstA * (1 - effAlpha)) * inv);
          tile[idx + 1] = Math.round((g * effAlpha + tile[idx + 1] * dstA * (1 - effAlpha)) * inv);
          tile[idx + 2] = Math.round((b * effAlpha + tile[idx + 2] * dstA * (1 - effAlpha)) * inv);
          tile[idx + 3] = Math.round(Math.min(255, outA * 255));
        }
      } else {
        const idx = (py * w + px) << 2;
        const dstA = this.data[idx + 3] / 255;
        const outA = effAlpha + dstA * (1 - effAlpha);
        if (outA > 0.001) {
          const inv = 1 / outA;
          this.data[idx] = Math.round((r * effAlpha + this.data[idx] * dstA * (1 - effAlpha)) * inv);
          this.data[idx + 1] = Math.round((g * effAlpha + this.data[idx + 1] * dstA * (1 - effAlpha)) * inv);
          this.data[idx + 2] = Math.round((b * effAlpha + this.data[idx + 2] * dstA * (1 - effAlpha)) * inv);
          this.data[idx + 3] = Math.round(Math.min(255, outA * 255));
        }
      }
    };

    for (let y = y0; y <= y1; y += step) {
      const dy = y - iy;
      const dySq = dy * dy;
      for (let x = x0; x <= x1; x += step) {
        const dx = x - ix;
        const dSq = dx * dx + dySq;
        if (dSq > radSq) continue;
        const falloff = 1 - dSq * invRadSq;
        const effAlpha = Math.min(1.0, a * falloff);
        if (effAlpha <= 0.002) continue;

        blendPixel(x, y, effAlpha);
        if (step === 2) {
          if (x + 1 <= x1) blendPixel(x + 1, y, effAlpha);
          if (y + 1 <= y1) {
            blendPixel(x, y + 1, effAlpha);
            if (x + 1 <= x1) blendPixel(x + 1, y + 1, effAlpha);
          }
        }
      }
    }
  }

  /**
   * Zero-allocation O(1) per-bristle color sample (5-tap cross when radius >= 2, 1-tap otherwise).
   * Writes directly into `out` to eliminate GC churn across 32-64 bristles per step.
   */
  public samplePointFast(cx: number, cy: number, radius: number, out: RgbaColor): RgbaColor {
    const w = this.width;
    const h = this.height;
    const ix = Math.round(cx);
    const iy = Math.round(cy);

    if (w <= 0 || h <= 0 || ix < 0 || ix >= w || iy < 0 || iy >= h) {
      out.r = 255;
      out.g = 255;
      out.b = 255;
      out.a = 0;
      return out;
    }

    const rOff = radius >= 2.2 ? Math.min(6, Math.round(radius * 0.6)) : 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let weightSum = 0;
    let totalSamples = 0;

    const readTap = (px: number, py: number, geomW: number) => {
      if (px < 0 || px >= w || py < 0 || py >= h) return;
      totalSamples += geomW;
      let alpha = 0;
      let tr = 0;
      let tg = 0;
      let tb = 0;
      if (this.useLazyTiles) {
        const tile = this.getOrLoadTile(px >> 8, py >> 8);
        const idx = (((py & 255) << 8) + (px & 255)) << 2;
        tr = tile[idx];
        tg = tile[idx + 1];
        tb = tile[idx + 2];
        alpha = tile[idx + 3];
      } else {
        const idx = (py * w + px) << 2;
        tr = this.data[idx];
        tg = this.data[idx + 1];
        tb = this.data[idx + 2];
        alpha = this.data[idx + 3];
      }
      if (alpha > 4) {
        const aw = geomW * (alpha / 255);
        sumR += tr * aw;
        sumG += tg * aw;
        sumB += tb * aw;
        weightSum += aw;
      }
    };

    readTap(ix, iy, 2.0);
    if (rOff > 0) {
      readTap(ix - rOff, iy, 1.0);
      readTap(ix + rOff, iy, 1.0);
      readTap(ix, iy - rOff, 1.0);
      readTap(ix, iy + rOff, 1.0);
    }

    if (weightSum > 0.001 && totalSamples > 0) {
      out.r = sumR / weightSum;
      out.g = sumG / weightSum;
      out.b = sumB / weightSum;
      out.a = Math.min(1.0, weightSum / totalSamples);
    } else {
      out.r = 255;
      out.g = 255;
      out.b = 255;
      out.a = 0;
    }
    return out;
  }

  /**
   * Zero-allocation O(1) bilinear single-pixel sample for 2D SpatialTipMixer.
   */
  public sampleBilinearFast(cx: number, cy: number, out: RgbaColor): RgbaColor {
    const w = this.width;
    const h = this.height;
    if (w <= 0 || h <= 0 || cx < -0.5 || cy < -0.5 || cx >= w - 0.5 || cy >= h - 0.5) {
      out.r = 255;
      out.g = 255;
      out.b = 255;
      out.a = 0;
      return out;
    }

    const x0 = Math.max(0, Math.min(w - 1, Math.floor(cx)));
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(cy)));
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const fx = Math.max(0, Math.min(1, cx - x0));
    const fy = Math.max(0, Math.min(1, cy - y0));

    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumA = 0;

    const accum = (px: number, py: number, wt: number) => {
      if (wt <= 1e-4) return;
      let tr: number, tg: number, tb: number, ta: number;
      if (this.useLazyTiles) {
        const tile = this.getOrLoadTile(px >> 8, py >> 8);
        const idx = (((py & 255) << 8) + (px & 255)) << 2;
        tr = tile[idx];
        tg = tile[idx + 1];
        tb = tile[idx + 2];
        ta = tile[idx + 3] / 255;
      } else {
        const idx = (py * w + px) << 2;
        tr = this.data[idx];
        tg = this.data[idx + 1];
        tb = this.data[idx + 2];
        ta = this.data[idx + 3] / 255;
      }
      if (ta > 0.002) {
        const aw = wt * ta;
        sumR += tr * aw;
        sumG += tg * aw;
        sumB += tb * aw;
        sumA += aw;
      }
    };

    accum(x0, y0, w00);
    if (x1 !== x0) accum(x1, y0, w10);
    if (y1 !== y0) accum(x0, y1, w01);
    if (x1 !== x0 && y1 !== y0) accum(x1, y1, w11);

    if (sumA > 0.002) {
      const inv = 1 / sumA;
      out.r = sumR * inv;
      out.g = sumG * inv;
      out.b = sumB * inv;
      out.a = Math.min(1, sumA);
    } else {
      out.r = 255;
      out.g = 255;
      out.b = 255;
      out.a = 0;
    }
    return out;
  }

  /**
   * Lightweight per-bristle pixel deposit so overlapping turns immediately pick up
   * freshly mixed multi-colored streaks laid down earlier in the same stroke.
   */
  public depositPointFast(
    cx: number,
    cy: number,
    radius: number,
    r: number,
    g: number,
    b: number,
    a: number
  ): void {
    if (a <= 0.005 || this.width <= 0 || this.height <= 0) return;
    const w = this.width;
    const h = this.height;
    const ix = Math.round(cx);
    const iy = Math.round(cy);
    const rad = Math.max(0, Math.min(12, Math.round(radius)));
    const x0 = Math.max(0, ix - rad);
    const x1 = Math.min(w - 1, ix + rad);
    const y0 = Math.max(0, iy - rad);
    const y1 = Math.min(h - 1, iy + rad);
    if (x0 > x1 || y0 > y1) return;

    const radSq = Math.max(1, rad * rad);
    for (let y = y0; y <= y1; y++) {
      const dy = y - iy;
      const dySq = dy * dy;
      const ty = y >> 8;
      const lyOff = (y & 255) << 8;
      const rowOff = y * w;
      for (let x = x0; x <= x1; x++) {
        const dx = x - ix;
        const dSq = dx * dx + dySq;
        if (dSq > radSq) continue;
        const effA = Math.min(1.0, a * (rad === 0 ? 1.0 : 1.0 - (dSq / (radSq + 1)) * 0.65));
        if (this.useLazyTiles) {
          const tile = this.getOrLoadTile(x >> 8, ty);
          const idx = (lyOff + (x & 255)) << 2;
          const dstA = tile[idx + 3] / 255;
          const outA = effA + dstA * (1 - effA);
          if (outA > 0.001) {
            const inv = 1 / outA;
            tile[idx] = Math.round((r * effA + tile[idx] * dstA * (1 - effA)) * inv);
            tile[idx + 1] = Math.round((g * effA + tile[idx + 1] * dstA * (1 - effA)) * inv);
            tile[idx + 2] = Math.round((b * effA + tile[idx + 2] * dstA * (1 - effA)) * inv);
            tile[idx + 3] = Math.round(Math.min(255, outA * 255));
          }
        } else {
          const idx = (rowOff + x) << 2;
          const dstA = this.data[idx + 3] / 255;
          const outA = effA + dstA * (1 - effA);
          if (outA > 0.001) {
            const inv = 1 / outA;
            this.data[idx] = Math.round((r * effA + this.data[idx] * dstA * (1 - effA)) * inv);
            this.data[idx + 1] = Math.round((g * effA + this.data[idx + 1] * dstA * (1 - effA)) * inv);
            this.data[idx + 2] = Math.round((b * effA + this.data[idx + 2] * dstA * (1 - effA)) * inv);
            this.data[idx + 3] = Math.round(Math.min(255, outA * 255));
          }
        }
      }
    }
  }
}

/**
 * Fallback color sampling if a canvas context is used without an in-memory sampler.
 */
export function sampleCanvasColor(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number
): RgbaColor {
  const canvasW = ctx.canvas.width;
  const canvasH = ctx.canvas.height;
  const r = Math.max(1, Math.min(48, Math.round(radius)));
  const sx = Math.max(0, Math.floor(cx - r));
  const sy = Math.max(0, Math.floor(cy - r));
  const sw = Math.min(canvasW - sx, r * 2);
  const sh = Math.min(canvasH - sy, r * 2);

  if (sw <= 0 || sh <= 0) {
    return { r: 255, g: 255, b: 255, a: 0 };
  }

  try {
    const imgData = ctx.getImageData(sx, sy, sw, sh);
    const data = imgData.data;
    const len = data.length;

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let weightSum = 0;
    const step = Math.max(1, Math.floor(sw / 6)) * 4;

    for (let i = 0; i < len; i += step) {
      const alpha = data[i + 3];
      if (alpha > 5) {
        const w = alpha / 255;
        sumR += data[i] * w;
        sumG += data[i + 1] * w;
        sumB += data[i + 2] * w;
        weightSum += w;
      }
    }

    if (weightSum > 0.05) {
      return {
        r: sumR / weightSum,
        g: sumG / weightSum,
        b: sumB / weightSum,
        a: Math.min(1.0, weightSum / (len / step)),
      };
    }
  } catch {
    // Restricted context fallback
  }

  return { r: 255, g: 255, b: 255, a: 0 };
}

/**
 * Live Paint Reservoir representing the dynamic wet paint mixture in the brush tip.
 * Accurately models Clip Studio Paint & Photoshop Mixer Brush mechanics:
 * - Subtractive Pigment Blend
 * - Real-Time Color Pickup & Drag
 * - Amount of Paint (0.0 pure smudge to 1.0 fresh ink)
 * - Density of Paint (translucent glaze to thick impasto)
 * - Color Stretch decay along stroke length
 */
export class PaintReservoir {
  public r: number;
  public g: number;
  public b: number;
  public a: number;
  public originalR: number;
  public originalG: number;
  public originalB: number;
  public isLoadedWithCanvasColor: boolean = false;
  public cumulativeDistance: number = 0;
  public smoothedAngle: number = 0;
  public spatialMixer?: SpatialTipMixer;

  constructor(initialColor: string) {
    const rgb = parseColorToRgb(initialColor);
    this.r = rgb.r;
    this.g = rgb.g;
    this.b = rgb.b;
    this.a = 1.0;
    this.originalR = rgb.r;
    this.originalG = rgb.g;
    this.originalB = rgb.b;
  }

  /**
   * Mixes canvas paint into the brush reservoir and calculates output dab parameters
   * using step-size-invariant continuous equilibrium blending:
   * - amountOfPaint = 0.0 (or 'smear'): pure smudge / blender (zero fresh pigment injection)
   * - amountOfPaint = 1.0: pure fresh paint layering (zero canvas contamination)
   * - 0 < amountOfPaint < 1: exact distance-normalized equilibrium between canvas & fresh color
   */
  public mixWithCanvas(
    sampledColor: RgbaColor,
    amountOfPaint: number, // 0.0 (pure smudge) to 1.0 (fresh pigment only)
    densityOfPaint: number, // 0.0 to 1.0 (paint deposition opacity)
    colorStretch: number, // 0.0 to 1.0 (drag length)
    mixingMode: NaturalMixingMode = 'blend',
    pressure: number = 0.5,
    flow: number = 0.85,
    stepDist: number = 0,
    perceptualMixing: boolean = true,
    pressureAlreadyAppliedToFlow: boolean = false,
    pigmentStrength: number = 1.0
  ): { r: number; g: number; b: number; alpha: number; colorHex: string } {
    this.cumulativeDistance += stepDist;

    const clampedAmount = Math.max(0, Math.min(1, amountOfPaint));
    const clampedStretch = Math.max(0, Math.min(1, colorStretch));
    const isPureSmudge = clampedAmount <= 0.005 || mixingMode === 'smear';
    const isFullFresh = !isPureSmudge && clampedAmount >= 0.995;
    const canvasAlpha = sampledColor.a;
    const effPigmentStrength = perceptualMixing ? Math.max(0, Math.min(1, pigmentStrength)) : 0;

    const mixFn = (c1: RgbColor, c2: RgbColor, w2: number): RgbColor => {
      if (effPigmentStrength > 0.005) {
        return mixPigmentsWithStrength(c1, c2, w2, effPigmentStrength);
      }
      const w = Math.max(0, Math.min(1, w2));
      return {
        r: c1.r + (c2.r - c1.r) * w,
        g: c1.g + (c2.g - c1.g) * w,
        b: c1.b + (c2.b - c1.b) * w,
      };
    };

    const origColor: RgbColor = {
      r: this.originalR,
      g: this.originalG,
      b: this.originalB,
    };

    if (isFullFresh) {
      // 100% Amount of Paint: clean opaque fresh layering without underlying color bleed
      this.r = this.originalR;
      this.g = this.originalG;
      this.b = this.originalB;
      this.a = 1.0;
    } else if (canvasAlpha > 0.015) {
      // Contact with existing paint on canvas
      const pressureInfluence = pressure * 0.5 + 0.5;
      const targetColor: RgbColor = {
        r: sampledColor.r,
        g: sampledColor.g,
        b: sampledColor.b,
      };
      const currentColor: RgbColor = {
        r: this.r,
        g: this.g,
        b: this.b,
      };

      if (isPureSmudge) {
        // Pure Smudge / Smear: drags underlying pigment with zero fresh foreground injection
        if (!this.isLoadedWithCanvasColor) {
          this.r = targetColor.r;
          this.g = targetColor.g;
          this.b = targetColor.b;
          this.a = canvasAlpha;
          this.isLoadedWithCanvasColor = true;
          this.cumulativeDistance = 0;
        } else {
          const smudgeDist = 6 + clampedStretch * 46;
          const stepRate =
            stepDist > 0
              ? 1.0 - Math.exp(-(stepDist * canvasAlpha * pressureInfluence) / smudgeDist)
              : Math.min(0.85, canvasAlpha * (0.45 + (1.0 - clampedStretch) * 0.45) * pressureInfluence);
          const mixed = mixFn(currentColor, targetColor, stepRate);
          this.r = mixed.r;
          this.g = mixed.g;
          this.b = mixed.b;
          this.a = Math.min(1.0, this.a * 0.72 + canvasAlpha * 0.28);
          this.cumulativeDistance = 0;
        }
      } else {
        // Exact continuous-distance equilibrium ODE:
        // dC/ds = kPickup * (C_canvas - C) + kFeed * (C_fg - C)
        // Guarantees step-size invariance and prevents underlying paint from swallowing fresh paint!
        const isRunning = mixingMode === 'running_color';
        const modePickupMult = isRunning ? 1.45 : 1.0;
        const wCanvas = (1.0 - clampedAmount) * modePickupMult * canvasAlpha * (0.65 + 0.35 * pressureInfluence);
        const wFresh = clampedAmount * (isRunning ? 0.85 : 1.0);
        const wTotal = wCanvas + wFresh;
        const eqFreshRatio = wTotal > 1e-4 ? wFresh / wTotal : 1.0;

        const equilibrium = mixFn(targetColor, origColor, eqFreshRatio);
        // Pickup responds crisply on contact; colorStretch governs how far picked-up color drags
        const pickupDist = isRunning
          ? 7 + clampedStretch * 18
          : 9 + clampedStretch * 24;
        const stepRate =
          stepDist > 0
            ? 1.0 - Math.exp(-(stepDist * Math.max(0.55, wTotal)) / pickupDist)
            : Math.min(0.52, (1.0 - eqFreshRatio) * 0.7 * canvasAlpha * pressureInfluence);

        const mixed = mixFn(currentColor, equilibrium, stepRate);
        this.r = mixed.r;
        this.g = mixed.g;
        this.b = mixed.b;
        this.a = Math.min(1.0, this.a + 0.3);
        this.isLoadedWithCanvasColor = true;
        this.cumulativeDistance = 0;
      }
    } else {
      // Moving into unpainted / dry area: apply Color Stretch decay
      if (isPureSmudge && !this.isLoadedWithCanvasColor) {
        this.a = 0;
        return { r: 0, g: 0, b: 0, alpha: 0, colorHex: '#000000' };
      }
      if (this.isLoadedWithCanvasColor && stepDist > 0) {
        const stretchDistanceLimit = Math.max(24, clampedStretch * 720);
        const decayRate = 1.0 - Math.exp(-stepDist / stretchDistanceLimit);

        if (isPureSmudge) {
          this.a = Math.max(0, this.a * (1.0 - decayRate * 1.55));
        } else {
          const currColor: RgbColor = {
            r: this.r,
            g: this.g,
            b: this.b,
          };
          const recoverDist = Math.max(24, (0.2 + clampedStretch * 0.8) * (280 / Math.max(0.15, clampedAmount)));
          const recoverRate = 1.0 - Math.exp(-stepDist / recoverDist);
          const recovered = mixFn(currColor, origColor, recoverRate);
          this.r = recovered.r;
          this.g = recovered.g;
          this.b = recovered.b;
        }
      }
    }

    // Output dab opacity based on Density of Paint, Flow, and Pressure (avoid double-applying pressure)
    const effPressure = Math.min(1.0, Math.max(0.05, pressure));
    const pressureMod = pressureAlreadyAppliedToFlow ? 1.0 : effPressure * 0.65 + 0.35;
    const dabAlpha = isPureSmudge
      ? flow * pressureMod * densityOfPaint * this.a
      : flow * pressureMod * densityOfPaint;

    const finalR = Math.round(Math.max(0, Math.min(255, this.r)));
    const finalG = Math.round(Math.max(0, Math.min(255, this.g)));
    const finalB = Math.round(Math.max(0, Math.min(255, this.b)));

    return {
      r: finalR,
      g: finalG,
      b: finalB,
      alpha: isPureSmudge
        ? Math.max(0, Math.min(1.0, dabAlpha))
        : Math.max(0.005, Math.min(1.0, dabAlpha)),
      colorHex: rgbToHex(finalR, finalG, finalB),
    };
  }
}

// -------------------------------------------------------------
// Spatial Per-Bristle Paint Pickup Reservoir (Natural Paint Engine)
// Structure-of-Arrays (SoA) typed buffers for 4..64 independent bristle channels.
// Eliminates single-average-color muddiness so each side of a brush drags its own
// picked-up pigment streaks independently around curves!
// -------------------------------------------------------------

export const MAX_BRISTLE_CHANNELS = 64;

export interface BristleStepOutput {
  r: number;
  g: number;
  b: number;
  alpha: number;
  load: number;
  height: number;
}

interface DirtyBristleSnapshot {
  count: number;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
  load: Float32Array;
  hasCanvas: Uint8Array;
}

const dirtyBrushRegistry = new Map<string, DirtyBristleSnapshot>();

/**
 * Cleans a persistent dirty brush reservoir (or all brushes when key is omitted).
 */
export function cleanDirtyBrush(presetKey?: string): void {
  if (presetKey) {
    dirtyBrushRegistry.delete(presetKey);
  } else {
    dirtyBrushRegistry.clear();
  }
}

/**
 * Returns true if a brush currently carries dirty pigment from a previous stroke.
 */
export function hasDirtyBrushState(presetKey: string): boolean {
  return dirtyBrushRegistry.has(presetKey);
}

function deterministicBristleRand(seed: number): () => number {
  let a = (seed ^ 0x9e3779b9) | 0;
  let b = (seed * 1664525 + 1013904223) | 0;
  let c = (seed ^ 0xb7e15162) | 0;
  let d = (seed ^ 0x8aed2a6b) | 0;
  return () => {
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

export class SpatialBristleReservoir {
  public count: number = 28;
  public readonly offsets = new Float32Array(MAX_BRISTLE_CHANNELS); // [-1..+1] across brush normal
  public readonly radii = new Float32Array(MAX_BRISTLE_CHANNELS); // relative strand radius
  public readonly lengthFactors = new Float32Array(MAX_BRISTLE_CHANNELS); // [0.35..1.0] outer strands dry earlier
  public readonly grooveWeights = new Float32Array(MAX_BRISTLE_CHANNELS); // bristle relief height profile
  public readonly startDelay = new Float32Array(MAX_BRISTLE_CHANNELS); // [0..1] staggered bristle touchdown
  public readonly wanderPhase = new Float32Array(MAX_BRISTLE_CHANNELS); // organic strand meander phase
  public readonly wanderFreq = new Float32Array(MAX_BRISTLE_CHANNELS); // organic strand meander spatial freq
  public readonly r = new Float32Array(MAX_BRISTLE_CHANNELS);
  public readonly g = new Float32Array(MAX_BRISTLE_CHANNELS);
  public readonly b = new Float32Array(MAX_BRISTLE_CHANNELS);
  public readonly a = new Float32Array(MAX_BRISTLE_CHANNELS);
  public readonly load = new Float32Array(MAX_BRISTLE_CHANNELS);
  public readonly hasCanvas = new Uint8Array(MAX_BRISTLE_CHANNELS);

  public originalR: number = 0;
  public originalG: number = 0;
  public originalB: number = 0;
  public initialPaintLoad: number = 0.85;
  private presetKey: string | null = null;
  private autoClean: boolean = true;

  private readonly scratchC1: RgbColor = { r: 0, g: 0, b: 0 };
  private readonly scratchC2: RgbColor = { r: 0, g: 0, b: 0 };
  private readonly scratchOrig: RgbColor = { r: 0, g: 0, b: 0 };

  constructor(
    baseColorHex: string = '#000000',
    bristle?: Partial<BristleSettings>,
    natural?: Partial<NaturalPaintSettings>,
    presetKey?: string
  ) {
    this.reset(baseColorHex, bristle, natural, presetKey);
  }

  public reset(
    baseColorHex: string,
    bristle?: Partial<BristleSettings>,
    natural?: Partial<NaturalPaintSettings>,
    presetKey?: string,
    seed: number = 1337
  ): void {
    const rgb = parseColorToRgb(baseColorHex);
    this.originalR = rgb.r;
    this.originalG = rgb.g;
    this.originalB = rgb.b;
    this.presetKey = presetKey ?? null;
    this.autoClean = natural?.autoClean !== false;

    const profile: BristleProfilePreset = bristle?.profile ?? 'filbert';
    const rawCount = Math.round(bristle?.count ?? 28);
    this.count = Math.max(4, Math.min(MAX_BRISTLE_CHANNELS, rawCount));

    const clumping = Math.max(0, Math.min(1, bristle?.clumping ?? 0.35));
    const irregularity = Math.max(0, Math.min(1, bristle?.irregularity ?? 0.35));
    const edgeRidge = Math.max(0, Math.min(1, bristle?.edgeRidge ?? 0.2));
    const initLoad = Math.max(0, Math.min(1, natural?.paintLoad ?? 0.85));
    this.initialPaintLoad = initLoad;

    const rand = deterministicBristleRand(
      seed + this.count * 73 + Math.round(clumping * 1000) * 19 + Math.round(irregularity * 1000) * 31
    );

    // Generate organic macro clump centers so bristles form bold primary oil ribs + fine secondary striations!
    const clumpCount =
      profile === 'rake'
        ? Math.max(4, Math.round(this.count * (0.48 - clumping * 0.24)))
        : Math.max(4, Math.round(6 + (1.0 - clumping) * 7));
    const clumpCenters = new Float32Array(clumpCount);
    const clumpHeights = new Float32Array(clumpCount);
    for (let c = 0; c < clumpCount; c++) {
      const u = clumpCount > 1 ? (c / (clumpCount - 1)) * 2 - 1 : 0;
      clumpCenters[c] = u + (rand() - 0.5) * 0.16 * Math.max(0.25, irregularity);
      // Alternating bold high paint ribs & deeper carved canyons between clumps (Reference Photo 1!)
      clumpHeights[c] = 0.62 + rand() * 0.68;
    }

    const n = this.count;
    for (let i = 0; i < n; i++) {
      const u = n > 1 ? (i / (n - 1)) * 2 - 1 : 0; // [-1, +1]
      const absU = Math.abs(u);

      // Pull toward nearest clump center
      let nearest = u;
      let nearestIdx = 0;
      let bestD = 99;
      for (let c = 0; c < clumpCount; c++) {
        const d = Math.abs(u - clumpCenters[c]);
        if (d < bestD) {
          bestD = d;
          nearest = clumpCenters[c];
          nearestIdx = c;
        }
      }
      const clumpPull = profile === 'rake' ? clumping * 0.54 : profile === 'knife' ? 0 : clumping * 0.72;
      let offset = u + (nearest - u) * clumpPull;
      offset += (rand() - 0.5) * (2.0 / Math.max(4, n)) * (profile === 'rake' ? 0.52 : 0.92) * irregularity;
      this.offsets[i] = Math.max(-1.0, Math.min(1.0, offset));

      // Profile-dependent strand length & density envelope
      let profileEnvelope = 1.0;
      if (profile === 'round') {
        profileEnvelope = Math.sqrt(Math.max(0.18, 1.0 - absU * absU * 0.88));
      } else if (profile === 'filbert') {
        profileEnvelope = Math.pow(Math.max(0.25, 1.0 - Math.pow(absU, 2.6) * 0.72), 0.7);
      } else if (profile === 'fan') {
        profileEnvelope = 0.62 + 0.38 * (1.0 - absU * 0.55);
      } else if (profile === 'rake') {
        profileEnvelope = 0.78 + 0.22 * (1.0 - absU * 0.3);
      } else if (profile === 'knife') {
        profileEnvelope = 1.0;
      } else {
        // flat / custom
        profileEnvelope = 1.0 - Math.pow(absU, 5) * 0.25;
      }

      // Shorter/outer bristles exhaust paint earlier -> organic dry-brush fringes!
      const lenVar = 1.0 - rand() * irregularity * 0.52;
      this.lengthFactors[i] = Math.max(0.32, Math.min(1.0, profileEnvelope * lenVar));

      // Staggered longitudinal entry & organic hair meander (eliminates flat ruler-cut stroke starts!)
      const edgeStagger = profile === 'knife' ? 0.04 : Math.pow(absU, 1.55) * 0.65;
      this.startDelay[i] = Math.max(0, Math.min(1, edgeStagger + rand() * (0.28 + irregularity * 0.48)));
      this.wanderPhase[i] = rand() * Math.PI * 2;
      this.wanderFreq[i] = 0.012 + rand() * 0.022;

      // Relative strand radius (varied organic tufts: bold macro paint ribs + delicate fine hairs!)
      const baseShare = 2.0 / Math.max(4, n);
      const sepFactor =
        profile === 'rake'
          ? 0.54
          : profile === 'fan'
          ? 0.56
          : profile === 'knife'
          ? 1.25
          : 0.84 + clumping * 0.22;
      const sizeMix = 0.52 + Math.pow(rand(), 0.8) * 1.05 * Math.max(0.35, irregularity);
      this.radii[i] = Math.max(0.014, baseShare * sepFactor * sizeMix);

      // Multi-scale sculptural relief: clump macro height + inner strand crown + edge paint ridge!
      const edgeBoost = absU > 0.70 ? Math.pow((absU - 0.70) / 0.30, 1.25) * edgeRidge * 1.35 : 0;
      const clumpCrest = clumpHeights[nearestIdx] * (1.0 - Math.min(0.65, bestD * 2.4));
      const tuftContrast = 0.32 + clumpCrest * 0.55 + Math.pow(rand(), 0.75) * 0.42;
      const strandPeak =
        profile === 'knife'
          ? 0.58 + edgeBoost * 1.35
          : (0.38 + 0.62 * profileEnvelope) * tuftContrast + edgeBoost;
      this.grooveWeights[i] = Math.max(0.20, Math.min(1.85, strandPeak));

      this.r[i] = rgb.r;
      this.g[i] = rgb.g;
      this.b[i] = rgb.b;
      this.a[i] = initLoad > 0.005 ? 1.0 : 0.0;
      this.load[i] = initLoad * (0.82 + 0.18 * this.lengthFactors[i]);
      this.hasCanvas[i] = 0;
    }

    // Restore persistent dirty-brush pigment if autoClean is disabled
    if (!this.autoClean && this.presetKey) {
      const snap = dirtyBrushRegistry.get(this.presetKey);
      if (snap && snap.count === this.count) {
        const reloadMix = initLoad > 0.005 ? 0.25 : 0.0; // Dipping a dirty brush partially refreshes load
        for (let i = 0; i < n; i++) {
          this.r[i] = snap.r[i] * (1 - reloadMix) + rgb.r * reloadMix;
          this.g[i] = snap.g[i] * (1 - reloadMix) + rgb.g * reloadMix;
          this.b[i] = snap.b[i] * (1 - reloadMix) + rgb.b * reloadMix;
          this.a[i] = Math.max(snap.a[i], initLoad > 0.005 ? 0.85 : 0);
          this.load[i] = Math.min(1.0, Math.max(snap.load[i], initLoad * 0.75));
          this.hasCanvas[i] = snap.hasCanvas[i];
        }
      }
    }
  }

  /**
   * Persists current dirty bristle channels when `autoClean === false`.
   */
  public persistDirtyStateIfNeeded(): void {
    if (this.autoClean || !this.presetKey) return;
    dirtyBrushRegistry.set(this.presetKey, {
      count: this.count,
      r: new Float32Array(this.r),
      g: new Float32Array(this.g),
      b: new Float32Array(this.b),
      a: new Float32Array(this.a),
      load: new Float32Array(this.load),
      hasCanvas: new Uint8Array(this.hasCanvas),
    });
  }

  /**
   * Advances a single bristle channel `i` by `stepDist` pixels, performing local spatial
   * canvas pickup, Kubelka-Munk pigment mixing, viscosity damping, and paint load depletion
   * via step-size-invariant equilibrium blending.
   */
  public stepBristle(
    i: number,
    canvasSample: RgbaColor,
    stepDist: number,
    pressure: number,
    natural: Partial<NaturalPaintSettings>,
    mixingMode: NaturalMixingMode,
    colorStretch: number,
    amountOfPaint: number,
    densityOfPaint: number,
    flow: number,
    out: BristleStepOutput
  ): BristleStepOutput {
    const resolvedAmount = Number.isFinite(amountOfPaint)
      ? amountOfPaint
      : natural.paintLoad ?? 0.85;
    const effectiveAmount = Math.max(0, Math.min(1, resolvedAmount));
    const isPureBlender =
      effectiveAmount <= 0.005 ||
      (natural.paintLoad !== undefined && natural.paintLoad <= 0.005 && effectiveAmount <= 0.005) ||
      mixingMode === 'smear';
    const isFullFresh = !isPureBlender && effectiveAmount >= 0.995;
    const wetness = Math.max(0, Math.min(1, natural.wetness ?? (1.0 - effectiveAmount * 0.5)));
    const viscosity = Math.max(0, Math.min(1, natural.viscosity ?? 0.5));
    const depletionRate = Math.max(0, Math.min(1, natural.depletionRate ?? 0.25));
    const chargePerPressure = Math.max(0, Math.min(1, natural.chargePerPressure ?? 0.45));
    const pigmentStrength = Math.max(0, Math.min(1, natural.pigmentMixingStrength ?? 0.85));
    const spatialMixing = natural.spatialMixing !== false;
    const clampedStretch = Math.max(0, Math.min(1, colorStretch));
    const effPressure = Math.max(0.05, Math.min(1.0, pressure));

    // 1. Deplete paint load along arc length (shorter outer bristles exhaust earlier -> dry-brush tail)
    let curLoad = this.load[i];
    if (!isPureBlender && depletionRate > 0.001 && stepDist > 0) {
      const lengthInv = 1.0 / Math.max(0.32, this.lengthFactors[i]);
      // Distance scale: depletionRate=1.0 exhausts around ~160px; depletionRate=0.25 around ~900px
      const exhaustDist = 110 + (1.0 - depletionRate) * 1150;
      // Full paint load depletes slightly slower so layering strokes stay rich across the canvas
      const loadEndurance = 1.0 - effectiveAmount * 0.25;
      const drop =
        (stepDist / exhaustDist) *
        depletionRate *
        lengthInv *
        loadEndurance *
        (1.15 - chargePerPressure * effPressure * 0.45);
      curLoad = Math.max(0.0, curLoad - drop);
      this.load[i] = curLoad;
    }

    // Effective squeezed load under stylus pressure
    const squeezedLoad = isPureBlender
      ? this.a[i]
      : Math.max(0, Math.min(1, curLoad * (1.0 - chargePerPressure * 0.32 + chargePerPressure * 0.62 * effPressure)));

    // 2. Spatial per-bristle pickup from underlying canvas
    const canvasAlpha = spatialMixing ? canvasSample.a : 0;
    const viscosityResist = 1.0 - viscosity * 0.5;

    if (isFullFresh) {
      // 100% Amount of Paint / Paint Load: clean opaque layering with zero canvas color contamination
      this.r[i] = this.originalR;
      this.g[i] = this.originalG;
      this.b[i] = this.originalB;
      this.a[i] = 1.0;
    } else if (canvasAlpha > 0.015 && (wetness > 0.005 || isPureBlender)) {
      this.scratchC1.r = this.r[i];
      this.scratchC1.g = this.g[i];
      this.scratchC1.b = this.b[i];
      this.scratchC2.r = canvasSample.r;
      this.scratchC2.g = canvasSample.g;
      this.scratchC2.b = canvasSample.b;

      if (isPureBlender) {
        if (!this.hasCanvas[i]) {
          this.r[i] = canvasSample.r;
          this.g[i] = canvasSample.g;
          this.b[i] = canvasSample.b;
          this.a[i] = canvasAlpha;
          this.hasCanvas[i] = 1;
        } else {
          const smudgeDist = (7 + clampedStretch * 46) * (0.7 + viscosity * 0.55);
          const pickup =
            stepDist > 0
              ? 1.0 - Math.exp(-(stepDist * canvasAlpha * viscosityResist * (0.55 + 0.45 * effPressure)) / smudgeDist)
              : Math.min(0.75, canvasAlpha * viscosityResist * 0.45);
          const mixed = mixPigmentsWithStrength(this.scratchC1, this.scratchC2, pickup, pigmentStrength);
          this.r[i] = mixed.r;
          this.g[i] = mixed.g;
          this.b[i] = mixed.b;
          this.a[i] = Math.min(1.0, this.a[i] * 0.72 + canvasAlpha * 0.28);
        }
      } else {
        // Loaded brush crossing existing paint:
        // Exact continuous-distance equilibrium between local canvas sample & original brush pigment.
        // Amount of Paint strictly controls how strongly fresh pigment layers over underlying paint!
        const amountAllowance = Math.max(0, 1.0 - Math.pow(effectiveAmount, 1.9));
        const loadRatio = this.initialPaintLoad > 0.05 ? Math.min(1.0, curLoad / this.initialPaintLoad) : 0;
        const depletionPickupBoost = (1.0 - loadRatio) * 0.4 * (1.0 - effectiveAmount * 0.5);
        const modePickupMult =
          mixingMode === 'running_color' ? 1.35 : mixingMode === 'impasto_mix' ? 1.05 : 0.9;

        const wCanvas =
          2.2 *
          wetness *
          canvasAlpha *
          viscosityResist *
          modePickupMult *
          (amountAllowance + depletionPickupBoost) *
          (0.55 + 0.45 * effPressure);
        const wFresh =
          effectiveAmount *
          (0.45 + 0.55 * curLoad) *
          (mixingMode === 'running_color' ? 0.65 : 1.0);
        const wTotal = wCanvas + wFresh;
        const eqFreshRatio = wTotal > 1e-4 ? wFresh / wTotal : 1.0;

        // Compute equilibrium target color: mix(canvas, original, eqFreshRatio)
        this.scratchOrig.r = this.originalR;
        this.scratchOrig.g = this.originalG;
        this.scratchOrig.b = this.originalB;
        const eqColor = mixPigmentsWithStrength(
          this.scratchC2,
          this.scratchOrig,
          eqFreshRatio,
          pigmentStrength
        );

        // Pickup responds smoothly on contact; colorStretch governs long ribbon carry
        const charDist = (9 + clampedStretch * 24) * (0.7 + viscosity * 0.55);
        const stepRate =
          stepDist > 0
            ? 1.0 - Math.exp(-(stepDist * Math.max(0.45, wTotal)) / charDist)
            : Math.min(0.35, (1.0 - eqFreshRatio) * 0.5 * canvasAlpha);

        const mixed = mixPigmentsWithStrength(this.scratchC1, eqColor, stepRate, pigmentStrength);
        this.r[i] = mixed.r;
        this.g[i] = mixed.g;
        this.b[i] = mixed.b;
        this.a[i] = Math.min(1.0, Math.max(this.a[i], 0.5 + curLoad * 0.5));
        this.hasCanvas[i] = 1;
      }
    } else if (stepDist > 0) {
      // Moving over dry / unpainted canvas
      if (isPureBlender) {
        if (!this.hasCanvas[i]) {
          out.r = 0;
          out.g = 0;
          out.b = 0;
          out.alpha = 0;
          out.load = 0;
          out.height = 0;
          return out;
        }
        const dragDist = Math.max(28, clampedStretch * 720);
        const decay = 1.0 - Math.exp(-stepDist / dragDist);
        this.a[i] = Math.max(0, this.a[i] * (1.0 - decay * 1.45));
      } else if (this.hasCanvas[i] && curLoad > 0.02) {
        // Smoothly recover toward brush's loaded color as picked-up streaks trail off
        const recoverDist = Math.max(24, (0.2 + clampedStretch * 0.8) * (220 / Math.max(0.18, effectiveAmount)));
        const recover = 1.0 - Math.exp(-stepDist / recoverDist);
        this.scratchC1.r = this.r[i];
        this.scratchC1.g = this.g[i];
        this.scratchC1.b = this.b[i];
        this.scratchC2.r = this.originalR;
        this.scratchC2.g = this.originalG;
        this.scratchC2.b = this.originalB;
        const recovered = mixPigmentsWithStrength(this.scratchC1, this.scratchC2, recover, pigmentStrength);
        this.r[i] = recovered.r;
        this.g[i] = recovered.g;
        this.b[i] = recovered.b;
      }
    }

    // 3. Output pigment, alpha & physical impasto groove height
    const loadCoverage = isPureBlender
      ? this.a[i]
      : Math.min(1.0, Math.pow(Math.max(0, squeezedLoad), 0.58) * 1.12);
    // Smooth pressure curve: light strokes softly glaze/blend; firm strokes layer opaquely
    const pressureAlpha = 0.22 + 0.78 * Math.pow(effPressure, 0.85);
    const outAlpha = Math.max(
      0,
      Math.min(1, flow * densityOfPaint * loadCoverage * pressureAlpha)
    );

    out.r = Math.max(0, Math.min(255, this.r[i]));
    out.g = Math.max(0, Math.min(255, this.g[i]));
    out.b = Math.max(0, Math.min(255, this.b[i]));
    out.alpha = outAlpha;
    out.load = squeezedLoad;
    out.height = this.grooveWeights[i] * (0.28 + 0.72 * squeezedLoad) * (0.45 + 0.55 * effPressure);
    return out;
  }
}

// -------------------------------------------------------------
// 2D Spatial Per-Pixel Tip Mixer (Clip Studio Paint Blend / Running Color / Smear)
// Maintains an oriented 2D RGBA pickup buffer across the brush tip footprint so
// one edge of a flat brush picks up & drags underlying paint independently while
// the rest of the brush lays down clean foreground color — matching CSP exactly.
// -------------------------------------------------------------

export interface SpatialTipStampParams {
  x: number;
  y: number;
  width: number;
  height: number;
  angleRad: number;
  dirX: number;
  dirY: number;
  stepDist: number;
  spacingRatio?: number;
  adjustDensityByGap?: boolean;
  dabSeq?: number;
  hardness: number;
  antiAlias: number;
  flipX: number;
  flipY: number;
  flow: number;
  pressure: number;
  pressureAlreadyApplied: boolean;
  amountOfPaint: number;
  densityOfPaint: number;
  colorStretch: number;
  mixingMode: NaturalMixingMode;
  perceptualMixing: boolean;
  pigmentMixingStrength?: number;
  tipImage?: HTMLImageElement;
  sampler?: LayerPixelSampler;
  grainDensity?: number;
  grainModulate?: (wx: number, wy: number, tipAlpha: number) => number;
}

interface CachedTipMask {
  width: number;
  height: number;
  alpha: Uint8Array;
}

const tipAlphaMaskCache = new WeakMap<HTMLImageElement, CachedTipMask>();

function getCachedTipAlphaMask(img: HTMLImageElement): CachedTipMask | null {
  const cached = tipAlphaMaskCache.get(img);
  if (cached) return cached;
  if (typeof document === 'undefined') return null;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (w <= 0 || h <= 0) return null;
  const maxDim = 64;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const dw = Math.max(4, Math.round(w * scale));
  const dh = Math.max(4, Math.round(h * scale));
  const c = document.createElement('canvas');
  c.width = dw;
  c.height = dh;
  const ctx = c.getContext('2d');
  if (!ctx || typeof ctx.getImageData !== 'function') return null;
  ctx.clearRect(0, 0, dw, dh);
  ctx.drawImage(img, 0, 0, dw, dh);
  const raw = ctx.getImageData(0, 0, dw, dh).data;
  const alpha = new Uint8Array(dw * dh);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = raw[i * 4 + 3];
  }
  const mask: CachedTipMask = { width: dw, height: dh, alpha };
  tipAlphaMaskCache.set(img, mask);
  return mask;
}

const MAX_SPATIAL_COLOR_DIM = 64;
const MAX_SPATIAL_OUT_DIM = 256;

export class SpatialTipMixer {
  public readonly origR: number;
  public readonly origG: number;
  public readonly origB: number;

  private gridW: number = 0;
  private gridH: number = 0;
  private initialized: boolean = false;
  private readonly bufR = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly bufG = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly bufB = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly bufA = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly bufCarry = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly tmpR = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly tmpG = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly tmpB = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);

  private scratchCanvas: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private scratchImgData: ImageData | null = null;
  private scratchW: number = 0;
  private scratchH: number = 0;

  private readonly sampleScratch: RgbaColor = { r: 0, g: 0, b: 0, a: 0 };
  private readonly c1Scratch: RgbColor = { r: 0, g: 0, b: 0 };

  constructor(initialColor: string) {
    const rgb = parseColorToRgb(initialColor);
    this.origR = rgb.r;
    this.origG = rgb.g;
    this.origB = rgb.b;
  }

  private ensureGrid(width: number, height: number): void {
    if (this.initialized && this.gridW > 0 && this.gridH > 0) {
      return;
    }
    const maxDim = Math.max(width, height, 1);
    const scale = Math.min(1, MAX_SPATIAL_COLOR_DIM / maxDim);
    this.gridW = Math.max(8, Math.min(MAX_SPATIAL_COLOR_DIM, Math.ceil(width * scale)));
    this.gridH = Math.max(8, Math.min(MAX_SPATIAL_COLOR_DIM, Math.ceil(height * scale)));
  }

  private ensureScratchSurface(outW: number, outH: number): boolean {
    if (typeof document === 'undefined') return false;
    if (!this.scratchCanvas) {
      this.scratchCanvas = document.createElement('canvas');
      this.scratchCanvas.width = outW;
      this.scratchCanvas.height = outH;
      this.scratchCtx = this.scratchCanvas.getContext('2d');
      this.scratchW = outW;
      this.scratchH = outH;
    } else if (this.scratchW !== outW || this.scratchH !== outH) {
      this.scratchCanvas.width = outW;
      this.scratchCanvas.height = outH;
      this.scratchW = outW;
      this.scratchH = outH;
      this.scratchImgData = null;
    }
    if (!this.scratchCtx || typeof this.scratchCtx.createImageData !== 'function') return false;
    if (!this.scratchImgData) {
      this.scratchImgData = this.scratchCtx.createImageData(outW, outH);
    }
    return true;
  }

  /**
   * Samples underlying canvas across the oriented 2D brush tip footprint, updates per-texel
   * pickup buffer with CSP Blend / Running Color / Smear physics, and composites a crisp 1:1
   * anti-aliased tip stamp (decoupled from the color-pickup grid so large brushes stay razor-sharp).
   */
  public stepAndBuildStamp(p: SpatialTipStampParams): {
    canvas: HTMLCanvasElement;
    srcW: number;
    srcH: number;
    drawW: number;
    drawH: number;
    hasVisiblePixels: boolean;
    avgR: number;
    avgG: number;
    avgB: number;
    avgA: number;
    pickedUpCanvas: boolean;
  } | null {
    if (p.width < 0.25 || p.height < 0.25 || p.flow <= 0.002) return null;

    this.ensureGrid(p.width, p.height);
    const gw = this.gridW;
    const gh = this.gridH;

    // 1:1 output stamp dimensions (capped at 256px) with 1px transparent padding on each edge
    // so Canvas2D bilinear filtering never blurs or clips sharp rotated chisel corners.
    const maxAxis = Math.max(p.width, p.height);
    const outScale = maxAxis > MAX_SPATIAL_OUT_DIM - 2 ? (MAX_SPATIAL_OUT_DIM - 2) / maxAxis : 1.0;
    const innerW = Math.max(4, Math.ceil(p.width * outScale));
    const innerH = Math.max(4, Math.ceil(p.height * outScale));
    const outW = innerW + 2;
    const outH = innerH + 2;

    if (!this.ensureScratchSurface(outW, outH) || !this.scratchCtx || !this.scratchCanvas || !this.scratchImgData) {
      return null;
    }

    const clampedAmount = Math.max(0, Math.min(1, p.amountOfPaint));
    const clampedDensity = Math.max(0, Math.min(1, p.densityOfPaint));
    const clampedStretch = Math.max(0, Math.min(1, p.colorStretch));
    const isPureSmudge = clampedAmount <= 0.005 || p.mixingMode === 'smear';
    const isFullFresh = !isPureSmudge && clampedAmount >= 0.995;
    const isRunning = p.mixingMode === 'running_color';

    const cosA = Math.cos(p.angleRad);
    const sinA = Math.sin(p.angleRad);
    const halfW = p.width * 0.5;
    const halfH = p.height * 0.5;
    const invGw = 1 / gw;
    const invGh = 1 / gh;

    const brushSpan = Math.max(6, Math.max(p.width, p.height));
    const thinSpan = Math.max(1.5, Math.min(p.width, p.height));
    const step = Math.max(0, p.stepDist);

    // Effective ellipse diameter along the motion direction (for footprint-normalized alpha & pickup)
    let diamAlongStroke = thinSpan;
    if (p.dirX !== 0 || p.dirY !== 0) {
      const localDirX = p.dirX * cosA + p.dirY * sinA;
      const localDirY = -p.dirX * sinA + p.dirY * cosA;
      const dDenom = Math.hypot(localDirX / Math.max(0.5, p.width), localDirY / Math.max(0.5, p.height));
      if (dDenom > 1e-5) {
        diamAlongStroke = 1.0 / dDenom;
      }
    }

    // Fast canvas pickup on contact (~0.25..0.75x tip thickness along stroke);
    // Color Stretch governs long carry persistence (even on small 15-35px brushes!).
    const carryScale = Math.max(0.75, brushSpan / 36);
    const pickupLen = Math.max(1.8, diamAlongStroke * (0.26 + 0.44 * clampedStretch));
    const pickupRate = step > 0 ? 1.0 - Math.exp(-step / pickupLen) : 0.9;

    const stretchDist = Math.max(16.0, (24 + clampedStretch * clampedStretch * 340) * carryScale);
    const carryDecay = step > 0 ? 1.0 - Math.exp(-step / stretchDist) : 0.0;
    const recoverLen = Math.max(
      18.0,
      stretchDist / Math.max(0.18, clampedAmount)
    );
    const recoverRate = step > 0 ? 1.0 - Math.exp(-step / recoverLen) : 0.0;

    const smudgeDecay = carryDecay;

    const effPigmentStrength = p.perceptualMixing
      ? Math.max(0, Math.min(1, p.pigmentMixingStrength ?? 1.0))
      : 0;

    const mixColorInto = (
      r1: number,
      g1: number,
      b1: number,
      r2: number,
      g2: number,
      b2: number,
      w2: number
    ): RgbColor => {
      const w = w2 <= 0 ? 0 : w2 >= 1 ? 1 : w2;
      if (w <= 0.0005) {
        this.c1Scratch.r = r1;
        this.c1Scratch.g = g1;
        this.c1Scratch.b = b1;
        return this.c1Scratch;
      }
      if (w >= 0.9995) {
        this.c1Scratch.r = r2;
        this.c1Scratch.g = g2;
        this.c1Scratch.b = b2;
        return this.c1Scratch;
      }
      if (effPigmentStrength > 0.005) {
        return mixPigmentRgbOut(r1, g1, b1, r2, g2, b2, w, effPigmentStrength, this.c1Scratch);
      }
      this.c1Scratch.r = r1 + (r2 - r1) * w;
      this.c1Scratch.g = g1 + (g2 - g1) * w;
      this.c1Scratch.b = b1 + (b2 - b1) * w;
      return this.c1Scratch;
    };

    const sampler = p.sampler;
    const firstTouch = !this.initialized;
    let pickedUpCanvas = false;
    let sumBufR = 0;
    let sumBufG = 0;
    let sumBufB = 0;
    let sumBufA = 0;
    const totalTexels = gw * gh;

    // 1. Sample underlying canvas & update 2D oriented paint buffer
    for (let gy = 0; gy < gh; gy++) {
      const ny = ((gy + 0.5) * invGh - 0.5) * 2.0; // [-1, 1]
      const ly = ny * halfH;
      const rowOff = gy * gw;
      for (let gx = 0; gx < gw; gx++) {
        const nx = ((gx + 0.5) * invGw - 0.5) * 2.0; // [-1, 1]
        const lx = nx * halfW;
        const idx = rowOff + gx;

        if (isFullFresh) {
          this.bufR[idx] = this.origR;
          this.bufG[idx] = this.origG;
          this.bufB[idx] = this.origB;
          this.bufA[idx] = 1.0;
          this.bufCarry[idx] = 0.0;
          sumBufR += this.origR;
          sumBufG += this.origG;
          sumBufB += this.origB;
          sumBufA += 1.0;
          continue;
        }

        const wx = p.x + lx * cosA - ly * sinA;
        const wy = p.y + lx * sinA + ly * cosA;
        const sampled = sampler
          ? sampler.sampleBilinearFast(wx, wy, this.sampleScratch)
          : ((this.sampleScratch.a = 0), this.sampleScratch);
        const ca = sampled.a;
        if (ca > 0.015) pickedUpCanvas = true;

        // CSP Blend wet pickup: when crossing existing paint, load canvas pigment strongly into the
        // carried tip buffer (proportional to (1 - amount) boosted by colorStretch) so overlapping
        // colors smear visibly into blank canvas instead of snapping back to pure foreground.
        const stretchPickupBoost = 1.0 + clampedStretch * (isRunning ? 1.45 : 1.15);

        if (firstTouch) {
          if (isPureSmudge) {
            this.bufR[idx] = sampled.r;
            this.bufG[idx] = sampled.g;
            this.bufB[idx] = sampled.b;
            this.bufA[idx] = ca;
            this.bufCarry[idx] = ca;
          } else if (ca > 0.015) {
            const wCanvas = (1.0 - clampedAmount) * stretchPickupBoost * ca;
            const wFresh = clampedAmount * (isRunning ? 0.75 : 0.9);
            const eqFresh = wFresh / Math.max(1e-4, wFresh + wCanvas);
            const m = mixColorInto(sampled.r, sampled.g, sampled.b, this.origR, this.origG, this.origB, eqFresh);
            this.bufR[idx] = m.r;
            this.bufG[idx] = m.g;
            this.bufB[idx] = m.b;
            this.bufA[idx] = 1.0;
            this.bufCarry[idx] = Math.min(1.0, ca * (1.0 - eqFresh * 0.65));
          } else {
            this.bufR[idx] = this.origR;
            this.bufG[idx] = this.origG;
            this.bufB[idx] = this.origB;
            this.bufA[idx] = 1.0;
            this.bufCarry[idx] = 0.0;
          }
        } else if (ca > 0.015) {
          if (isPureSmudge) {
            const rate = Math.min(1.0, pickupRate * (0.45 + 0.55 * ca));
            const curA = this.bufA[idx];
            if (curA <= 0.01) {
              this.bufR[idx] = sampled.r;
              this.bufG[idx] = sampled.g;
              this.bufB[idx] = sampled.b;
              this.bufA[idx] = ca * rate;
            } else {
              const m = mixColorInto(this.bufR[idx], this.bufG[idx], this.bufB[idx], sampled.r, sampled.g, sampled.b, rate);
              this.bufR[idx] = m.r;
              this.bufG[idx] = m.g;
              this.bufB[idx] = m.b;
              this.bufA[idx] = curA + (ca - curA) * rate;
            }
            this.bufCarry[idx] = Math.min(1.0, this.bufCarry[idx] + (ca - this.bufCarry[idx]) * rate);
          } else {
            const wCanvas = (1.0 - clampedAmount) * stretchPickupBoost * ca;
            const wFresh = clampedAmount * (isRunning ? 0.72 : 0.88);
            const eqFresh = wFresh / Math.max(1e-4, wFresh + wCanvas);
            const eq = mixColorInto(sampled.r, sampled.g, sampled.b, this.origR, this.origG, this.origB, eqFresh);
            const eqR = eq.r;
            const eqG = eq.g;
            const eqB = eq.b;
            const m = mixColorInto(this.bufR[idx], this.bufG[idx], this.bufB[idx], eqR, eqG, eqB, pickupRate);
            this.bufR[idx] = m.r;
            this.bufG[idx] = m.g;
            this.bufB[idx] = m.b;
            this.bufA[idx] = Math.min(1.0, this.bufA[idx] + (1.0 - this.bufA[idx]) * pickupRate);
            const targetCarry = Math.min(1.0, ca * (1.0 - eqFresh * 0.55));
            this.bufCarry[idx] = this.bufCarry[idx] + (targetCarry - this.bufCarry[idx]) * pickupRate;
          }
        } else if (step > 0) {
          if (isPureSmudge) {
            this.bufA[idx] = Math.max(0, this.bufA[idx] * (1.0 - smudgeDecay));
            this.bufCarry[idx] = Math.max(0, this.bufCarry[idx] * (1.0 - carryDecay));
          } else {
            const m = mixColorInto(
              this.bufR[idx],
              this.bufG[idx],
              this.bufB[idx],
              this.origR,
              this.origG,
              this.origB,
              recoverRate
            );
            this.bufR[idx] = m.r;
            this.bufG[idx] = m.g;
            this.bufB[idx] = m.b;
            this.bufA[idx] = Math.min(1.0, this.bufA[idx] + (1.0 - this.bufA[idx]) * recoverRate);
            this.bufCarry[idx] = Math.max(0, this.bufCarry[idx] * (1.0 - carryDecay));
          }
        }
        sumBufR += this.bufR[idx];
        sumBufG += this.bufG[idx];
        sumBufB += this.bufB[idx];
        sumBufA += this.bufA[idx];
      }
    }

    this.initialized = true;

    // 2. Gentle lateral diffusion (softens red-to-black cross-brush seam like real oil paint)
    if (!isFullFresh && step > 0 && gw >= 4 && gh >= 4) {
      const diff = (isRunning ? 0.095 : 0.045) * Math.min(1, step / Math.max(1, thinSpan * 0.28));
      if (diff > 0.003) {
        const centerW = 1.0 - 2.0 * diff;
        const wideAlongX = p.width >= p.height;
        if (wideAlongX) {
          for (let gy = 0; gy < gh; gy++) {
            const row = gy * gw;
            this.tmpR[row] = this.bufR[row];
            this.tmpG[row] = this.bufG[row];
            this.tmpB[row] = this.bufB[row];
            this.tmpR[row + gw - 1] = this.bufR[row + gw - 1];
            this.tmpG[row + gw - 1] = this.bufG[row + gw - 1];
            this.tmpB[row + gw - 1] = this.bufB[row + gw - 1];
            for (let gx = 1; gx < gw - 1; gx++) {
              const i = row + gx;
              this.tmpR[i] = this.bufR[i - 1] * diff + this.bufR[i] * centerW + this.bufR[i + 1] * diff;
              this.tmpG[i] = this.bufG[i - 1] * diff + this.bufG[i] * centerW + this.bufG[i + 1] * diff;
              this.tmpB[i] = this.bufB[i - 1] * diff + this.bufB[i] * centerW + this.bufB[i + 1] * diff;
            }
          }
        } else {
          for (let gx = 0; gx < gw; gx++) {
            this.tmpR[gx] = this.bufR[gx];
            this.tmpG[gx] = this.bufG[gx];
            this.tmpB[gx] = this.bufB[gx];
            const last = (gh - 1) * gw + gx;
            this.tmpR[last] = this.bufR[last];
            this.tmpG[last] = this.bufG[last];
            this.tmpB[last] = this.bufB[last];
          }
          for (let gy = 1; gy < gh - 1; gy++) {
            const row = gy * gw;
            for (let gx = 0; gx < gw; gx++) {
              const i = row + gx;
              this.tmpR[i] = this.bufR[i - gw] * diff + this.bufR[i] * centerW + this.bufR[i + gw] * diff;
              this.tmpG[i] = this.bufG[i - gw] * diff + this.bufG[i] * centerW + this.bufG[i + gw] * diff;
              this.tmpB[i] = this.bufB[i - gw] * diff + this.bufB[i] * centerW + this.bufB[i + gw] * diff;
            }
          }
        }
        const total = gw * gh;
        for (let i = 0; i < total; i++) {
          this.bufR[i] = this.tmpR[i];
          this.bufG[i] = this.tmpG[i];
          this.bufB[i] = this.tmpB[i];
        }
      }
    }

    // 3. Footprint-chord-normalized Beer-Lambert optical-depth model (exact CSP Blend + TextureForPlot):
    // Dense fixed-interval CSP brushes (BrushAdjustFlowByInterval=0, spacing=0.3%) fill into rich
    // velvety oil paint even at normal tablet pressure (p=0.45..0.85), while still glazing smoothly
    // at light pressure and tapering cleanly to 0 at ending tails. When Density of Paint tapers to 0
    // at the end of a stroke, carried pigment (bufCarry * colorStretch) keeps stretching smoothly!
    const effPressure = Math.max(0.02, Math.min(1.0, p.pressure));
    const pressureMod = p.pressureAlreadyApplied ? 1.0 : 0.35 + 0.65 * effPressure;
    const flowFactor = Math.max(0, Math.min(1.0, p.flow * pressureMod));
    const freshDensity = Math.max(0, Math.min(1.0, flowFactor * clampedDensity));
    const spacingRatio = Math.max(0.003, Math.min(2.0, p.spacingRatio ?? 0.06));
    const gapBoost = !p.adjustDensityByGap
      ? 1.0 + 13.5 * Math.pow(Math.max(0, 1.0 - spacingRatio / 0.15), 2)
      : 1.0;
    const baseOpticalDepth =
      freshDensity >= 0.995
        ? 12.0
        : gapBoost * Math.pow(freshDensity, 1.18);
    const carriedOpticalScale = flowFactor * clampedStretch * 0.65;
    const effectiveChord = Math.max(1.0, diamAlongStroke * 0.85);
    const nominalStep = step > 0 ? Math.max(0.2, step) : Math.max(0.55, Math.min(1.05, thinSpan * 0.1));
    const overlapHits = Math.max(1.0, effectiveChord / nominalStep);
    const invOverlapHits = 1.0 / overlapHits;
    const dabSalt = Math.imul((p.dabSeq ?? 0) + 1, 83492791);

    // 4. Composite crisp 1:1 silhouette SDF + bilinear pigment grid + per-plot paper grain
    const out = this.scratchImgData.data;
    const tipMask = p.tipImage ? getCachedTipAlphaMask(p.tipImage) : null;
    const hNorm = Math.max(0.02, Math.min(1.0, p.hardness));
    const aaFeatherPx = p.antiAlias === 0 ? 0 : p.antiAlias === 1 ? 0.65 : p.antiAlias === 3 ? 1.65 : 1.0;
    const hasGrain = Boolean(p.grainModulate && (p.grainDensity ?? 0) > 0.005);
    const flipX = p.flipX < 0 ? -1 : 1;
    const flipY = p.flipY < 0 ? -1 : 1;
    const invInnerW = 1 / innerW;
    const invInnerH = 1 / innerH;
    const gwM1 = gw - 1;
    const ghM1 = gh - 1;

    let hasVisiblePixels = false;

    for (let oy = 0; oy < outH; oy++) {
      const rowOff = oy * outW;
      // 1px transparent border ring
      if (oy === 0 || oy === outH - 1) {
        const start = rowOff << 2;
        out.fill(0, start, start + (outW << 2));
        continue;
      }
      const vNorm = (oy - 0.5) * invInnerH; // [0, 1] across exact tip height
      const ny = (vNorm - 0.5) * 2.0; // [-1, 1]
      const ly = ny * halfH;

      const fy = Math.max(0, Math.min(ghM1, vNorm * gh - 0.5));
      const gy0 = Math.floor(fy);
      const gy1 = gy0 < ghM1 ? gy0 + 1 : ghM1;
      const ty = fy - gy0;
      const gRow0 = gy0 * gw;
      const gRow1 = gy1 * gw;

      for (let ox = 0; ox < outW; ox++) {
        const pOff = (rowOff + ox) << 2;
        if (ox === 0 || ox === outW - 1) {
          out[pOff] = 0;
          out[pOff + 1] = 0;
          out[pOff + 2] = 0;
          out[pOff + 3] = 0;
          continue;
        }

        const uNorm = (ox - 0.5) * invInnerW; // [0, 1] across exact tip width
        const nx = (uNorm - 0.5) * 2.0; // [-1, 1]

        let tipAlpha = 0;
        if (tipMask) {
          const su = flipX < 0 ? 1.0 - uNorm : uNorm;
          const sv = flipY < 0 ? 1.0 - vNorm : vNorm;
          const tx = Math.max(0, Math.min(tipMask.width - 1, Math.floor(su * tipMask.width)));
          const tyM = Math.max(0, Math.min(tipMask.height - 1, Math.floor(sv * tipMask.height)));
          tipAlpha = tipMask.alpha[tyM * tipMask.width + tx] / 255;
        } else {
          const dist = Math.hypot(nx, ny);
          if (dist < 1.0) {
            if (p.antiAlias === 0) {
              tipAlpha = 1.0;
            } else if (hNorm >= 0.98) {
              const gradLen = Math.hypot(nx / Math.max(0.5, halfW), ny / Math.max(0.5, halfH));
              const edgePx = gradLen > 1e-5 ? (1.0 - dist) / gradLen : halfH;
              const u = Math.max(0, Math.min(1, edgePx / Math.max(0.35, aaFeatherPx)));
              tipAlpha = u * u * (3.0 - 2.0 * u);
            } else if (dist <= hNorm) {
              tipAlpha = 1.0;
            } else {
              const t = (dist - hNorm) / Math.max(1e-4, 1.0 - hNorm);
              tipAlpha = hNorm <= 0.05 ? 0.5 * (1.0 + Math.cos(t * Math.PI)) : 1.0 - (3.0 * t * t - 2.0 * t * t * t);
            }
          }
        }

        if (tipAlpha <= 0.002) {
          out[pOff] = 0;
          out[pOff + 1] = 0;
          out[pOff + 2] = 0;
          out[pOff + 3] = 0;
          continue;
        }

        let grainFactor = 1.0;
        if (hasGrain && p.grainModulate) {
          const lx = nx * halfW;
          const wx = p.x + lx * cosA - ly * sinA;
          const wy = p.y + lx * sinA + ly * cosA;
          const rawGrain = p.grainModulate(wx, wy, 1.0);
          // Wet oil paint fills paper valleys rather than punching static world-locked holes;
          // blend grain depth softly so tooth shows delicately in fades while body stays creamy.
          grainFactor = 0.62 + 0.38 * rawGrain;
          if (grainFactor <= 0.002) {
            out[pOff] = 0;
            out[pOff + 1] = 0;
            out[pOff + 2] = 0;
            out[pOff + 3] = 0;
            continue;
          }
        }

        // Bilinear sample from color pickup buffer
        const fx = Math.max(0, Math.min(gwM1, uNorm * gw - 0.5));
        const gx0 = Math.floor(fx);
        const gx1 = gx0 < gwM1 ? gx0 + 1 : gwM1;
        const tx = fx - gx0;
        const i00 = gRow0 + gx0;
        const i10 = gRow0 + gx1;
        const i01 = gRow1 + gx0;
        const i11 = gRow1 + gx1;
        const w00 = (1 - tx) * (1 - ty);
        const w10 = tx * (1 - ty);
        const w01 = (1 - tx) * ty;
        const w11 = tx * ty;

        const bA = this.bufA[i00] * w00 + this.bufA[i10] * w10 + this.bufA[i01] * w01 + this.bufA[i11] * w11;
        const bCarry =
          this.bufCarry[i00] * w00 +
          this.bufCarry[i10] * w10 +
          this.bufCarry[i01] * w01 +
          this.bufCarry[i11] * w11;
        const carriedDensity = bCarry * carriedOpticalScale;
        const carriedTau = carriedDensity > 0.002 ? gapBoost * Math.pow(carriedDensity, 1.18) : 0;
        const localTau = Math.max(baseOpticalDepth, carriedTau) * grainFactor * bA;
        const perStampBody = localTau > 0.0005 ? 1.0 - Math.exp(-localTau * invOverlapHits) : 0;
        const finalAlpha = Math.max(0, Math.min(1, tipAlpha * perStampBody));

        if (finalAlpha <= 0.001) {
          out[pOff] = 0;
          out[pOff + 1] = 0;
          out[pOff + 2] = 0;
          out[pOff + 3] = 0;
          continue;
        }

        const bR = this.bufR[i00] * w00 + this.bufR[i10] * w10 + this.bufR[i01] * w01 + this.bufR[i11] * w11;
        const bG = this.bufG[i00] * w00 + this.bufG[i10] * w10 + this.bufG[i01] * w01 + this.bufG[i11] * w11;
        const bB = this.bufB[i00] * w00 + this.bufB[i10] * w10 + this.bufB[i01] * w01 + this.bufB[i11] * w11;

        // Deterministic sub-LSB alpha dither prevents 8-bit quantization banding across 15+ low-alpha Fade stamps
        let h = (Math.imul(ox, 73856093) ^ Math.imul(oy, 19349663) ^ dabSalt) | 0;
        h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
        const dither = ((h ^ (h >>> 13)) >>> 0) / 4294967296 - 0.5;
        const qAlpha = Math.max(0, Math.min(255, Math.floor(finalAlpha * 255 + 0.5 + dither * 0.95)));
        if (qAlpha === 0) {
          out[pOff] = 0;
          out[pOff + 1] = 0;
          out[pOff + 2] = 0;
          out[pOff + 3] = 0;
          continue;
        }

        out[pOff] = Math.max(0, Math.min(255, Math.round(bR)));
        out[pOff + 1] = Math.max(0, Math.min(255, Math.round(bG)));
        out[pOff + 2] = Math.max(0, Math.min(255, Math.round(bB)));
        out[pOff + 3] = qAlpha;
        hasVisiblePixels = true;
      }
    }

    if (!hasVisiblePixels) return null;

    this.scratchCtx.putImageData(this.scratchImgData, 0, 0);

    // 5. Trailing self-pickup deposit into LayerPixelSampler strictly behind the trailing edge
    // Dense across the full brush width so continuous back-and-forth scrubbing blends freshly laid strokes cleanly!
    const depositBodyAlpha = baseOpticalDepth > 0.0005 ? 1.0 - Math.exp(-baseOpticalDepth * invOverlapHits) : 0;
    if (sampler && step > 0 && (p.dirX !== 0 || p.dirY !== 0)) {
      const trailDist = thinSpan * 0.6 + 1.25;
      const targetSamples = Math.max(6, Math.min(gw, 18));
      const sampleStride = Math.max(1, Math.floor(gw / targetSamples));
      const midRow = (gh >> 1) * gw;
      const depRad = Math.max(1, Math.min(6, Math.ceil((brushSpan / targetSamples) * 0.75)));
      const depAlphaBoost = Math.min(0.85, Math.max(depositBodyAlpha * 2.1, Math.min(0.45, depositBodyAlpha * 1.4)));
      for (let gx = 0; gx < gw; gx += sampleStride) {
        const idx = midRow + gx;
        const a = this.bufA[idx] * depAlphaBoost;
        if (a <= 0.01) continue;
        const nx = ((gx + 0.5) * invGw - 0.5) * 2.0;
        const lx = nx * halfW;
        const depX = p.x + lx * cosA - p.dirX * trailDist;
        const depY = p.y + lx * sinA - p.dirY * trailDist;
        sampler.depositPointFast(depX, depY, depRad, this.bufR[idx], this.bufG[idx], this.bufB[idx], a);
      }
    }

    const invTotal = totalTexels > 0 ? 1 / totalTexels : 1;
    return {
      canvas: this.scratchCanvas,
      srcW: outW,
      srcH: outH,
      drawW: p.width * (outW / innerW),
      drawH: p.height * (outH / innerH),
      hasVisiblePixels,
      avgR: sumBufR * invTotal,
      avgG: sumBufG * invTotal,
      avgB: sumBufB * invTotal,
      avgA: sumBufA * invTotal,
      pickedUpCanvas,
    };
  }
}
