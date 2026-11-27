/**
 * Physical Kubelka-Munk 4-Pigment + Residual Latent Space Engine for Ink Studio.
 *
 * Models real-world subtractive pigment mixing (Phthalo Blue, Hansa Yellow,
 * Quinacridone Magenta, Titanium White) via a 7-component latent space:
 *   [c0, c1, c2, c3, r_res, g_res, b_res]
 * where (c0..c3) are physical pigment concentrations evaluated through a 20-term
 * cubic Bernstein polynomial fitted to Kubelka-Munk reflectance spectra, and
 * (r_res, g_res, b_res) guarantee exact color identity across the entire sRGB gamut.
 *
 * Properties:
 * - Blue + Yellow -> vibrant natural Green
 * - Dark Navy / Crimson / Emerald diluted on White -> luminous Cerulean / Magenta / Teal
 * - Multi-color blending (blur, tip diffusion, radial sampling) is strictly linear in latent space
 * - Exact self-mix invariance: mix(c, c, t) === c
 * - Strict achromatic neutrality for Black + White / neutral grayscale mixes
 */

import type { CspBrushCombineMode, LayerItem } from '../types/editor';
import type { SparseTileGrid } from './tileEngine';
import { buildPigmentLutRgba, getPigmentConcentrationLut } from './pigmentLutData';

export { buildPigmentLutRgba, getPigmentConcentrationLut };

export const PIGMENT_LATENT_SIZE = 7;

export interface PigmentRgb {
  r: number;
  g: number;
  b: number;
}

const INV_255 = 1 / 255;
const SCALE_63_OVER_255 = 63.0 / 255.0;

// Lazily cached LUT reference + 1-entry exact-match cache for srgbToPigmentLatentOut
let _cachedPigmentLut: Uint8Array | null = null;
let _lastEncR = -9999;
let _lastEncG = -9999;
let _lastEncB = -9999;
const _lastEncLat = new Float32Array(7);

// Reusable scratch latent buffers for zero-allocation hot-loop mixing
const _z1 = new Float32Array(7);
const _z2 = new Float32Array(7);
const _zMix = new Float32Array(7);
const _polyRgb: PigmentRgb = { r: 0, g: 0, b: 0 };
const _whiteMixRgb: PigmentRgb = { r: 0, g: 0, b: 0 };
const _compRgb: PigmentRgb = { r: 0, g: 0, b: 0 };

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

function clamp255(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : v;
}

/**
 * Evaluates the 20-term cubic Kubelka-Munk pigment mixing polynomial for concentrations (c0..c3).
 * Writes normalized sRGB [0..1] into `out`.
 */
function evalPigmentPolynomialInto(
  c0: number,
  c1: number,
  c2: number,
  c3: number,
  out: PigmentRgb
): void {
  const c00 = c0 * c0;
  const c11 = c1 * c1;
  const c22 = c2 * c2;
  const c33 = c3 * c3;
  const c01 = c0 * c1;
  const c02 = c0 * c2;
  const c12 = c1 * c2;

  let r = 0;
  let g = 0;
  let b = 0;

  let w = c0 * c00; r += 0.07717053 * w; g += 0.02826978 * w; b += 0.24832992 * w;
  w = c1 * c11;     r += 0.95912302 * w; g += 0.80256528 * w; b += 0.03561839 * w;
  w = c2 * c22;     r += 0.74683774 * w; g += 0.04868586 * w;
  w = c3 * c33;     r += 0.99518138 * w; g += 0.99978149 * w; b += 0.99704802 * w;
  w = c00 * c1;     r += 0.04819146 * w; g += 0.83363781 * w; b += 0.32515377 * w;
  w = c01 * c1;     r += -0.68146950 * w; g += 1.46107803 * w; b += 1.06980936 * w;
  w = c00 * c2;     r += 0.27058419 * w; g += -0.15324870 * w; b += 1.98735057 * w;
  w = c02 * c2;     r += 0.80478189 * w; g += 0.67093710 * w; b += 0.18424500 * w;
  w = c00 * c3;     r += -0.35031003 * w; g += 1.37855826 * w; b += 3.68865000 * w;
  w = c0 * c33;     r += 1.05128046 * w; g += 1.97815239 * w; b += 2.82989073 * w;
  w = c11 * c2;     r += 3.21607125 * w; g += 0.81270228 * w; b += 1.03384539 * w;
  w = c1 * c22;     r += 2.78893374 * w; g += 0.41565549 * w; b += -0.04487295 * w;
  w = c11 * c3;     r += 3.02162577 * w; g += 2.55374103 * w; b += 0.32766114 * w;
  w = c1 * c33;     r += 2.95124691 * w; g += 2.81201112 * w; b += 1.17578442 * w;
  w = c22 * c3;     r += 2.82677043 * w; g += 0.79933038 * w; b += 1.81715262 * w;
  w = c2 * c33;     r += 2.99691099 * w; g += 1.22593053 * w; b += 1.80653661 * w;
  w = c01 * c2;     r += 1.87394106 * w; g += 2.05027182 * w; b += -0.29835996 * w;
  w = c01 * c3;     r += 2.56609566 * w; g += 7.03428198 * w; b += 0.62575374 * w;
  w = c02 * c3;     r += 4.08329484 * w; g += -1.40408358 * w; b += 2.14995522 * w;
  w = c12 * c3;     r += 6.00078678 * w; g += 2.55552042 * w; b += 1.90739502 * w;

  out.r = r;
  out.g = g;
  out.b = b;
}

/**
 * Encodes an sRGB color [0..255] into 7 Kubelka-Munk pigment latent components
 * written into `out[offset .. offset + 6]`. Zero heap allocations.
 */
export function srgbToPigmentLatentOut(
  r255: number,
  g255: number,
  b255: number,
  out: Float32Array,
  offset: number
): void {
  if (r255 === _lastEncR && g255 === _lastEncG && b255 === _lastEncB) {
    out[offset] = _lastEncLat[0];
    out[offset + 1] = _lastEncLat[1];
    out[offset + 2] = _lastEncLat[2];
    out[offset + 3] = _lastEncLat[3];
    out[offset + 4] = _lastEncLat[4];
    out[offset + 5] = _lastEncLat[5];
    out[offset + 6] = _lastEncLat[6];
    return;
  }

  let lut = _cachedPigmentLut;
  if (!lut) {
    lut = getPigmentConcentrationLut();
    _cachedPigmentLut = lut;
  }

  const cr = r255 <= 0 ? 0 : r255 >= 255 ? 255 : r255;
  const cg = g255 <= 0 ? 0 : g255 >= 255 ? 255 : g255;
  const cb = b255 <= 0 ? 0 : b255 >= 255 ? 255 : b255;
  const r = cr * INV_255;
  const g = cg * INV_255;
  const b = cb * INV_255;

  const x = cr * SCALE_63_OVER_255;
  const y = cg * SCALE_63_OVER_255;
  const z = cb * SCALE_63_OVER_255;

  const ix = x | 0;
  const iy = y | 0;
  const iz = z | 0;

  const tx = x - ix;
  const ty = y - iy;
  const tz = z - iz;

  const itx = 1.0 - tx;
  const ity = 1.0 - ty;
  const itz = 1.0 - tz;

  const xyz = ix + (iy << 6) + (iz << 12);

  const itxIty = itx * ity;
  const txIty = tx * ity;
  const itxTy = itx * ty;
  const txTy = tx * ty;
  const w0 = itxIty * itz;
  const w1 = txIty * itz;
  const w2 = itxTy * itz;
  const w3 = txTy * itz;
  const w4 = itxIty * tz;
  const w5 = txIty * tz;
  const w6 = itxTy * tz;
  const w7 = txTy * tz;

  const c0 =
    (w0 * lut[xyz + 192] +
      w1 * lut[xyz + 193] +
      w2 * lut[xyz + 256] +
      w3 * lut[xyz + 257] +
      w4 * lut[xyz + 4288] +
      w5 * lut[xyz + 4289] +
      w6 * lut[xyz + 4352] +
      w7 * lut[xyz + 4353]) *
    INV_255;

  const c1 =
    (w0 * lut[xyz + 262336] +
      w1 * lut[xyz + 262337] +
      w2 * lut[xyz + 262400] +
      w3 * lut[xyz + 262401] +
      w4 * lut[xyz + 266432] +
      w5 * lut[xyz + 266433] +
      w6 * lut[xyz + 266496] +
      w7 * lut[xyz + 266497]) *
    INV_255;

  const c2 =
    (w0 * lut[xyz + 524480] +
      w1 * lut[xyz + 524481] +
      w2 * lut[xyz + 524544] +
      w3 * lut[xyz + 524545] +
      w4 * lut[xyz + 528576] +
      w5 * lut[xyz + 528577] +
      w6 * lut[xyz + 528640] +
      w7 * lut[xyz + 528641]) *
    INV_255;

  const c3 = 1.0 - (c0 + c1 + c2);

  evalPigmentPolynomialInto(c0, c1, c2, c3, _polyRgb);

  const rr = r - _polyRgb.r;
  const rg = g - _polyRgb.g;
  const rb = b - _polyRgb.b;

  out[offset] = c0;
  out[offset + 1] = c1;
  out[offset + 2] = c2;
  out[offset + 3] = c3;
  out[offset + 4] = rr;
  out[offset + 5] = rg;
  out[offset + 6] = rb;

  _lastEncR = r255;
  _lastEncG = g255;
  _lastEncB = b255;
  _lastEncLat[0] = c0;
  _lastEncLat[1] = c1;
  _lastEncLat[2] = c2;
  _lastEncLat[3] = c3;
  _lastEncLat[4] = rr;
  _lastEncLat[5] = rg;
  _lastEncLat[6] = rb;
}

/**
 * Decodes 7 Kubelka-Munk pigment latent components from `latent[offset .. offset + 6]`
 * back into sRGB [0..255] written directly into `out`. Zero heap allocations.
 */
export function pigmentLatentToSrgbOut(
  latent: Float32Array,
  offset: number,
  out: PigmentRgb
): PigmentRgb {
  evalPigmentPolynomialInto(
    latent[offset],
    latent[offset + 1],
    latent[offset + 2],
    latent[offset + 3],
    _polyRgb
  );
  out.r = clamp01(_polyRgb.r + latent[offset + 4]) * 255.0;
  out.g = clamp01(_polyRgb.g + latent[offset + 5]) * 255.0;
  out.b = clamp01(_polyRgb.b + latent[offset + 6]) * 255.0;
  return out;
}

/**
 * Zero-allocation physical Kubelka-Munk pigment color mixer writing sRGB [0..255] into `out`.
 * `pigmentStrength` in [0..1]: 0.0 = regular linear sRGB blend, 1.0 = full pigment blend.
 */
export function pigmentMixRgbOut(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
  weight2: number,
  pigmentStrength: number,
  out: PigmentRgb
): PigmentRgb {
  const t = weight2 <= 0 ? 0 : weight2 >= 1 ? 1 : weight2;
  if (t <= 0.0001) {
    out.r = clamp255(r1);
    out.g = clamp255(g1);
    out.b = clamp255(b1);
    return out;
  }
  if (t >= 0.9999) {
    out.r = clamp255(r2);
    out.g = clamp255(g2);
    out.b = clamp255(b2);
    return out;
  }

  const strength = pigmentStrength <= 0 ? 0 : pigmentStrength >= 1 ? 1 : pigmentStrength;
  const dr = r2 - r1;
  const dg = g2 - g1;
  const db = b2 - b1;
  const linR = r1 + dr * t;
  const linG = g1 + dg * t;
  const linB = b1 + db * t;

  if (strength <= 0.005 || dr * dr + dg * dg + db * db < 1.0) {
    out.r = clamp255(linR);
    out.g = clamp255(linG);
    out.b = clamp255(linB);
    return out;
  }

  // Smooth achromatic neutrality guard: when both inputs are neutral gray (Black/Gray/White),
  // keep the blend strictly achromatic so grayscale shading never picks up subtle 4-pigment tint.
  const max1 = r1 > g1 ? (r1 > b1 ? r1 : b1) : g1 > b1 ? g1 : b1;
  const min1 = r1 < g1 ? (r1 < b1 ? r1 : b1) : g1 < b1 ? g1 : b1;
  const max2 = r2 > g2 ? (r2 > b2 ? r2 : b2) : g2 > b2 ? g2 : b2;
  const min2 = r2 < g2 ? (r2 < b2 ? r2 : b2) : g2 < b2 ? g2 : b2;
  const maxChroma = Math.max(max1 - min1, max2 - min2);
  if (maxChroma <= 1.0) {
    out.r = clamp255(linR);
    out.g = clamp255(linG);
    out.b = clamp255(linB);
    return out;
  }

  srgbToPigmentLatentOut(r1, g1, b1, _z1, 0);
  srgbToPigmentLatentOut(r2, g2, b2, _z2, 0);

  const invT = 1.0 - t;
  for (let i = 0; i < 7; i++) {
    _zMix[i] = invT * _z1[i] + t * _z2[i];
  }
  pigmentLatentToSrgbOut(_zMix, 0, out);

  // Smoothly blend out residual chromaticity for near-achromatic pairs (chroma in (1..8])
  let effStrength = strength;
  if (maxChroma < 8.0) {
    const chromaRamp = (maxChroma - 1.0) / 7.0;
    effStrength *= chromaRamp * chromaRamp * (3.0 - 2.0 * chromaRamp);
  }

  if (effStrength >= 0.995) {
    return out;
  }

  out.r = clamp255(linR + (out.r - linR) * effStrength);
  out.g = clamp255(linG + (out.g - linG) * effStrength);
  out.b = clamp255(linB + (out.b - linB) * effStrength);
  return out;
}

/**
 * Optical pigment-over-white encoding for translucent strokes painted onto an empty
 * transparent layer sitting over a white canvas ground.
 *
 * Solves for the minimal valid RGBA pixel (outR, outG, outB, outA) such that standard
 * `source-over` compositing over white (255, 255, 255) reproduces the exact Kubelka-Munk
 * pigment dilution `pigmentMix(White, src, sA, strength)`:
 *   outRGB * outA + 255 * (1 - outA) === pigmentMix(White, src, sA, strength)
 *
 * This guarantees that dark pigments (Phthalo Blue, Quinacridone Magenta, Phthalo Green,
 * Ultramarine, Cobalt Violet) fading onto white on a transparent layer exhibit luminous
 * physical pigment chroma instead of muddy RGB gray.
 */
export function encodePigmentOverWhiteOut(
  sr: number,
  sg: number,
  sb: number,
  sA: number,
  pigmentStrength: number,
  out: [number, number, number, number]
): void {
  if (sA <= 0.0001) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    return;
  }
  if (sA >= 0.999) {
    out[0] = clamp255(Math.round(sr));
    out[1] = clamp255(Math.round(sg));
    out[2] = clamp255(Math.round(sb));
    out[3] = 255;
    return;
  }
  if (pigmentStrength <= 0.005) {
    out[0] = clamp255(Math.round(sr));
    out[1] = clamp255(Math.round(sg));
    out[2] = clamp255(Math.round(sb));
    out[3] = clamp255(Math.round(sA * 255));
    return;
  }

  pigmentMixRgbOut(255, 255, 255, sr, sg, sb, sA, pigmentStrength, _whiteMixRgb);
  const pr = _whiteMixRgb.r;
  const pg = _whiteMixRgb.g;
  const pb = _whiteMixRgb.b;

  const minC = pr < pg ? (pr < pb ? pr : pb) : pg < pb ? pg : pb;
  const minValidA = 1.0 - minC * INV_255;
  const outA = sA > minValidA ? sA : minValidA;

  if (outA <= 0.0001) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    return;
  }

  const bg = 255.0 * (1.0 - outA);
  const invOutA = 1.0 / outA;
  out[0] = clamp255(Math.round((pr - bg) * invOutA));
  out[1] = clamp255(Math.round((pg - bg) * invOutA));
  out[2] = clamp255(Math.round((pb - bg) * invOutA));
  out[3] = clamp255(Math.round(outA * 255.0));
}

/**
 * Returns true if the given brush combine mode is compatible with physical pigment compositing.
 */
export function isPigmentCompatibleCombineMode(mode?: CspBrushCombineMode): boolean {
  return (
    !mode ||
    mode === 'normal' ||
    mode === 'pass-through' ||
    mode === 'compare-density' ||
    mode === 'behind'
  );
}

/**
 * Composites a single brush/stroke RGBA pixel (0..255) over a destination pixel (0..255)
 * using physical Kubelka-Munk pigment mixing.
 * Matches `PIGMENT_DRAFT_FRAGMENT_SHADER` in WebGL2 1-to-1 for zero-pop live/commit parity.
 */
export function compositePigmentOverPixelInto(
  dr: number,
  dg: number,
  db: number,
  da: number,
  sr: number,
  sg: number,
  sb: number,
  effA: number,
  pigmentStrength: number,
  pigmentWhiteGround: boolean,
  compositeOp: 'source-over' | 'destination-out' | 'source-atop',
  combineMode: CspBrushCombineMode | undefined,
  out: [number, number, number, number]
): void {
  const mode: CspBrushCombineMode = combineMode ?? 'normal';
  const sA = effA * INV_255;

  if (compositeOp === 'source-atop') {
    if (da === 0) {
      out[0] = dr;
      out[1] = dg;
      out[2] = db;
      out[3] = 0;
      return;
    }
    if (mode === 'behind') {
      if (da >= 255) {
        out[0] = dr;
        out[1] = dg;
        out[2] = db;
        out[3] = da;
        return;
      }
      const dA = da * INV_255;
      const rem = (1.0 - dA) * sA;
      const denom = dA + rem;
      if (denom > 1e-5) {
        pigmentMixRgbOut(dr, dg, db, sr, sg, sb, rem / denom, pigmentStrength, _compRgb);
        out[0] = clamp255(Math.round(_compRgb.r));
        out[1] = clamp255(Math.round(_compRgb.g));
        out[2] = clamp255(Math.round(_compRgb.b));
      } else {
        out[0] = dr;
        out[1] = dg;
        out[2] = db;
      }
      out[3] = da;
      return;
    }
    if (effA >= 255) {
      out[0] = sr;
      out[1] = sg;
      out[2] = sb;
      out[3] = da;
      return;
    }
    pigmentMixRgbOut(dr, dg, db, sr, sg, sb, sA, pigmentStrength, _compRgb);
    out[0] = clamp255(Math.round(_compRgb.r));
    out[1] = clamp255(Math.round(_compRgb.g));
    out[2] = clamp255(Math.round(_compRgb.b));
    out[3] = da;
    return;
  }

  if (mode === 'behind') {
    if (da >= 255) {
      out[0] = dr;
      out[1] = dg;
      out[2] = db;
      out[3] = da;
      return;
    }
    if (da === 0) {
      if (pigmentWhiteGround && effA < 255) {
        encodePigmentOverWhiteOut(sr, sg, sb, sA, pigmentStrength, out);
      } else {
        out[0] = sr;
        out[1] = sg;
        out[2] = sb;
        out[3] = effA;
      }
      return;
    }
    const dA = da * INV_255;
    const rem = sA * (1.0 - dA);
    const compA = dA + rem;
    if (compA > 1e-5) {
      pigmentMixRgbOut(dr, dg, db, sr, sg, sb, rem / compA, pigmentStrength, _compRgb);
      out[0] = clamp255(Math.round(_compRgb.r));
      out[1] = clamp255(Math.round(_compRgb.g));
      out[2] = clamp255(Math.round(_compRgb.b));
      out[3] = clamp255(Math.round(compA * 255));
    } else {
      out[0] = dr;
      out[1] = dg;
      out[2] = db;
      out[3] = da;
    }
    return;
  }

  if (da === 0) {
    if (pigmentWhiteGround && effA < 255) {
      encodePigmentOverWhiteOut(sr, sg, sb, sA, pigmentStrength, out);
    } else {
      out[0] = sr;
      out[1] = sg;
      out[2] = sb;
      out[3] = effA;
    }
    return;
  }

  if (mode === 'compare-density') {
    const dA = da * INV_255;
    const dstW = dA * (1.0 - sA);
    const denom = sA + dstW;
    if (denom <= 1e-5) {
      out[0] = dr;
      out[1] = dg;
      out[2] = db;
      out[3] = da;
      return;
    }
    pigmentMixRgbOut(dr, dg, db, sr, sg, sb, sA / denom, pigmentStrength, _compRgb);
    out[0] = clamp255(Math.round(_compRgb.r));
    out[1] = clamp255(Math.round(_compRgb.g));
    out[2] = clamp255(Math.round(_compRgb.b));
    out[3] = effA > da ? effA : da;
    return;
  }

  // Standard source-over in Kubelka-Munk pigment space
  if (effA >= 255) {
    out[0] = sr;
    out[1] = sg;
    out[2] = sb;
    out[3] = 255;
    return;
  }

  const dA = da * INV_255;
  const compA = sA + dA * (1.0 - sA);
  if (compA <= 1e-5) {
    out[0] = dr;
    out[1] = dg;
    out[2] = db;
    out[3] = da;
    return;
  }

  // Optical white-paper ground compositing for translucent pixels over a visible white canvas:
  // Mixes the visible on-paper color with `src` in Kubelka-Munk pigment space and encodes
  // back into the minimal valid (outRgb, outA >= compA) pixel that composites identically over white.
  if (pigmentWhiteGround && da < 255) {
    const invDA = 1.0 - dA;
    const visDr = dr * dA + 255.0 * invDA;
    const visDg = dg * dA + 255.0 * invDA;
    const visDb = db * dA + 255.0 * invDA;
    pigmentMixRgbOut(visDr, visDg, visDb, sr, sg, sb, sA, pigmentStrength, _compRgb);
    const pr = _compRgb.r;
    const pg = _compRgb.g;
    const pb = _compRgb.b;
    const minC = pr < pg ? (pr < pb ? pr : pb) : pg < pb ? pg : pb;
    const minValidA = 1.0 - minC * INV_255;
    const outA = compA > minValidA ? compA : minValidA;
    if (outA <= 1e-5) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
      return;
    }
    const bg = 255.0 * (1.0 - outA);
    const invOutA = 1.0 / outA;
    out[0] = clamp255(Math.round((pr - bg) * invOutA));
    out[1] = clamp255(Math.round((pg - bg) * invOutA));
    out[2] = clamp255(Math.round((pb - bg) * invOutA));
    out[3] = clamp255(Math.round(outA * 255.0));
    return;
  }

  const t = sA / compA;
  pigmentMixRgbOut(dr, dg, db, sr, sg, sb, t, pigmentStrength, _compRgb);
  out[0] = clamp255(Math.round(_compRgb.r));
  out[1] = clamp255(Math.round(_compRgb.g));
  out[2] = clamp255(Math.round(_compRgb.b));
  out[3] = clamp255(Math.round(compA * 255));
}

/**
 * Detects whether the active layer sits over a visible light/white paper background
 * (e.g., default white `layer-bg`), used to enable optical pigment-over-white dilution
 * on transparent pixels.
 */
export function detectWhitePaperGround(
  layers: LayerItem[] | undefined,
  activeLayerId: string | null | undefined,
  grid?: SparseTileGrid | null
): boolean {
  if (!layers || layers.length === 0) return true;
  const isBgId = (id: string) => id === 'layer-bg' || id.startsWith('layer-bg');
  if (activeLayerId && isBgId(activeLayerId)) {
    return true;
  }
  const bgLayer = layers.find((l) => isBgId(l.id));
  if (!bgLayer) return false;
  if (!bgLayer.visible || bgLayer.opacity < 0.5) return false;

  if (grid) {
    try {
      const tile = grid.getTile(bgLayer.id, 0, 0, 0);
      if (tile) {
        if (tile.solidColorU32 !== undefined) {
          const u = tile.solidColorU32;
          const r = u & 0xff;
          const g = (u >>> 8) & 0xff;
          const b = (u >>> 16) & 0xff;
          const a = (u >>> 24) & 0xff;
          if (a < 180) return false;
          return 0.299 * r + 0.587 * g + 0.114 * b >= 205;
        }
        const px = grid.getPixelRGBA(bgLayer.id, 0, 0);
        if (px[3] >= 180) {
          return 0.299 * px[0] + 0.587 * px[1] + 0.114 * px[2] >= 205;
        }
      }
    } catch {
      // Fallback to light ground assumption when bg layer is visible
    }
  }
  return true;
}

// ============================================================================
// WebGL1 / WebGL2 GPU LUT Texture Cache & GLSL Shader Modules
// ============================================================================

const glLutTextureCache = new WeakMap<
  WebGLRenderingContext | WebGL2RenderingContext,
  WebGLTexture
>();

/**
 * Returns (or lazily uploads) the 512x512 RGBA8 Kubelka-Munk pigment LUT texture
 * bound to a specific WebGL1 or WebGL2 context. Restores caller GL texture/unpack state.
 */
export function getPigmentLutTexture(
  gl: WebGLRenderingContext | WebGL2RenderingContext
): WebGLTexture | null {
  const existing = glLutTextureCache.get(gl);
  if (existing) return existing;

  const tex = gl.createTexture();
  if (!tex) return null;

  const pixels = buildPigmentLutRgba();
  const prevBinding = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const prevFlipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
  const prevPremul = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
  const prevAlign = gl.getParameter(gl.UNPACK_ALIGNMENT);

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 512, 512, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, prevFlipY ? 1 : 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevPremul ? 1 : 0);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlign || 4);
  gl.bindTexture(gl.TEXTURE_2D, prevBinding);

  glLutTextureCache.set(gl, tex);
  return tex;
}

/**
 * Deletes and removes any cached pigment LUT texture for the given WebGL context.
 */
export function invalidatePigmentLutTexture(
  gl: WebGLRenderingContext | WebGL2RenderingContext | null | undefined,
  deleteOnGl: boolean = false
): void {
  if (!gl) return;
  const tex = glLutTextureCache.get(gl);
  if (tex) {
    if (deleteOnGl) {
      try {
        gl.deleteTexture(tex);
      } catch {
        // Ignore lost-context deletion errors
      }
    }
    glLutTextureCache.delete(gl);
  }
}

function buildPigmentGlslBody(useLod: boolean): string {
  const sampleLut = (uvExpr: string) =>
    useLod
      ? `textureLod(u_pigmentLut, ${uvExpr}, 0.0)`
      : `texture2D(u_pigmentLut, ${uvExpr})`;
  return `
vec3 pigmentEvalPoly(vec3 c) {
  float c0 = c.x;
  float c1 = c.y;
  float c2 = c.z;
  float c3 = 1.0 - (c0 + c1 + c2);

  float c00 = c0 * c0;
  float c11 = c1 * c1;
  float c22 = c2 * c2;
  float c33 = c3 * c3;
  float c01 = c0 * c1;
  float c02 = c0 * c2;
  float c12 = c1 * c2;

  return (c0 * c00) * vec3(+0.07717053, +0.02826978, +0.24832992) +
         (c1 * c11) * vec3(+0.95912302, +0.80256528, +0.03561839) +
         (c2 * c22) * vec3(+0.74683774, +0.04868586, +0.00000000) +
         (c3 * c33) * vec3(+0.99518138, +0.99978149, +0.99704802) +
         (c00 * c1) * vec3(+0.04819146, +0.83363781, +0.32515377) +
         (c01 * c1) * vec3(-0.68146950, +1.46107803, +1.06980936) +
         (c00 * c2) * vec3(+0.27058419, -0.15324870, +1.98735057) +
         (c02 * c2) * vec3(+0.80478189, +0.67093710, +0.18424500) +
         (c00 * c3) * vec3(-0.35031003, +1.37855826, +3.68865000) +
         (c0 * c33) * vec3(+1.05128046, +1.97815239, +2.82989073) +
         (c11 * c2) * vec3(+3.21607125, +0.81270228, +1.03384539) +
         (c1 * c22) * vec3(+2.78893374, +0.41565549, -0.04487295) +
         (c11 * c3) * vec3(+3.02162577, +2.55374103, +0.32766114) +
         (c1 * c33) * vec3(+2.95124691, +2.81201112, +1.17578442) +
         (c22 * c3) * vec3(+2.82677043, +0.79933038, +1.81715262) +
         (c2 * c33) * vec3(+2.99691099, +1.22593053, +1.80653661) +
         (c01 * c2) * vec3(+1.87394106, +2.05027182, -0.29835996) +
         (c01 * c3) * vec3(+2.56609566, +7.03428198, +0.62575374) +
         (c02 * c3) * vec3(+4.08329484, -1.40408358, +2.14995522) +
         (c12 * c3) * vec3(+6.00078678, +2.55552042, +1.90739502);
}

mat3 pigmentRgbToLatent(vec3 rgbIn) {
  vec3 rgb = clamp(rgbIn, 0.0, 1.0);
  float x = rgb.r * 63.0;
  float y = rgb.g * 63.0;
  float z = rgb.b * 63.0;

  float iz = floor(z);
  float iz1 = min(iz + 1.0, 63.0);

  float x0 = mod(iz, 8.0) * 64.0;
  float y0 = floor(iz / 8.0) * 64.0;
  float x1 = mod(iz1, 8.0) * 64.0;
  float y1 = floor(iz1 / 8.0) * 64.0;

  vec2 uv0 = vec2(x0 + x + 0.5, y0 + y + 0.5) / 512.0;
  vec2 uv1 = vec2(x1 + x + 0.5, y1 + y + 0.5) / 512.0;

  if (${sampleLut('vec2(0.5, 0.5) / 512.0')}.b < 0.1) {
    uv0.y = 1.0 - uv0.y;
    uv1.y = 1.0 - uv1.y;
  }

  vec3 c = mix(${sampleLut('uv0')}.rgb, ${sampleLut('uv1')}.rgb, z - iz);
  return mat3(c, rgb - pigmentEvalPoly(c), vec3(0.0));
}

vec3 pigmentLatentToRgb(mat3 latent) {
  return clamp(pigmentEvalPoly(latent[0]) + latent[1], 0.0, 1.0);
}

vec3 mixPigmentsGpu(vec3 c1, vec3 c2, float t, float strength) {
  float ct = clamp(t, 0.0, 1.0);
  vec3 lin = mix(c1, c2, ct);
  float s = clamp(strength, 0.0, 1.0);
  if (s <= 0.005 || ct <= 0.0001 || ct >= 0.9999) {
    return lin;
  }
  float ch1 = max(max(c1.r, c1.g), c1.b) - min(min(c1.r, c1.g), c1.b);
  float ch2 = max(max(c2.r, c2.g), c2.b) - min(min(c2.r, c2.g), c2.b);
  float maxCh = max(ch1, ch2);
  if (maxCh <= 0.004) {
    return lin;
  }
  mat3 z1 = pigmentRgbToLatent(c1);
  mat3 z2 = pigmentRgbToLatent(c2);
  vec3 pig = pigmentLatentToRgb((1.0 - ct) * z1 + ct * z2);
  float effS = s * smoothstep(0.004, 0.032, maxCh);
  return mix(lin, pig, effS);
}
`;
}

export const PIGMENT_GLSL_WEBGL1 = buildPigmentGlslBody(false);
export const PIGMENT_GLSL_WEBGL2 = buildPigmentGlslBody(true);
