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
// Color Science: Linear RGB <-> OKLab (Fast LUT + Float Precision)
// -------------------------------------------------------------

const CBRT_LUT_SIZE = 2048;
const CBRT_LUT_MAX = 1.05;
const CBRT_LUT_SCALE = CBRT_LUT_SIZE / CBRT_LUT_MAX;
const CBRT_LUT = new Float32Array(CBRT_LUT_SIZE + 1);
for (let i = 0; i <= CBRT_LUT_SIZE; i++) {
  CBRT_LUT[i] = Math.cbrt((i / CBRT_LUT_SIZE) * CBRT_LUT_MAX);
}

function fastCbrtPos(x: number): number {
  if (x <= 0) return 0;
  if (x >= CBRT_LUT_MAX) return Math.cbrt(x);
  const pos = x * CBRT_LUT_SCALE;
  const idx = pos | 0;
  const v0 = CBRT_LUT[idx];
  return v0 + (CBRT_LUT[idx + 1] - v0) * (pos - idx);
}

/**
 * Converts Linear RGB to OKLab perceptual color space.
 */
export function linearRgbToOklab(r: number, g: number, b: number): OklabColor {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = fastCbrtPos(l);
  const m_ = fastCbrtPos(m);
  const s_ = fastCbrtPos(s);

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
import {
  PIGMENT_LATENT_SIZE,
  pigmentLatentToSrgbOut,
  pigmentMixRgbOut,
  srgbToPigmentLatentOut,
} from './pigmentEngine';

// -------------------------------------------------------------
// Physical Kubelka-Munk 4-Pigment + Residual Latent Space Engine
// Uses a calibrated 64x64x64 3D pigment concentration LUT + 20-term cubic
// Bernstein polynomial (7-float latent space: 4 physical pigment concentrations
// + 3 linear sRGB residuals).
// Guarantees:
// - Blue + Yellow -> vibrant natural Green (no muddy gray)
// - Dark Navy / Crimson / Emerald + White -> luminous Cerulean / Magenta / Teal
// - Red + Blue -> rich Violet; Red + Yellow -> luminous Orange
// - Exact self-mix invariance: mix(c, c, t) === c
// - Exact neutral-gray invariance: Black + White stays strictly neutral gray
// -------------------------------------------------------------

const EXP_NEG_LUT_SIZE = 512;
const EXP_NEG_LUT_MAX = 8.0;
const EXP_NEG_LUT_SCALE = EXP_NEG_LUT_SIZE / EXP_NEG_LUT_MAX;
const ONE_MINUS_EXP_NEG_LUT = new Float32Array(EXP_NEG_LUT_SIZE + 1);
for (let i = 0; i <= EXP_NEG_LUT_SIZE; i++) {
  ONE_MINUS_EXP_NEG_LUT[i] = 1.0 - Math.exp(-(i / EXP_NEG_LUT_SIZE) * EXP_NEG_LUT_MAX);
}

function fastOneMinusExpNeg(x: number): number {
  if (x <= 0) return 0;
  if (x >= EXP_NEG_LUT_MAX) return 1.0;
  const pos = x * EXP_NEG_LUT_SCALE;
  const idx = pos | 0;
  const v0 = ONE_MINUS_EXP_NEG_LUT[idx];
  return v0 + (ONE_MINUS_EXP_NEG_LUT[idx + 1] - v0) * (pos - idx);
}

/**
 * Encodes an sRGB color [0..255] into 7 Kubelka-Munk pigment latent components
 * written starting at `offset`. Useful for separable pigment convolution (Pigment Blur).
 */
export function encodeSrgbToPigmentLatent(
  r: number,
  g: number,
  b: number,
  out: Float32Array,
  offset: number
): void {
  srgbToPigmentLatentOut(r, g, b, out, offset);
}

/**
 * Decodes 7 Kubelka-Munk pigment latent components back to sRGB [0..255].
 */
export function decodePigmentLatentToSrgb(
  buf: Float32Array,
  offset: number,
  out: RgbColor
): RgbColor {
  return pigmentLatentToSrgbOut(buf, offset, out);
}

/**
 * Backward-compatible alias for encoding sRGB into 7-channel pigment latent space.
 */
export const encodeSrgbToSpectralKS = encodeSrgbToPigmentLatent;

/**
 * Backward-compatible alias for decoding 7-channel pigment latent space to sRGB.
 */
export const decodeSpectralKSToSrgb = decodePigmentLatentToSrgb;

/**
 * Zero-allocation physical Kubelka-Munk pigment mixer writing directly into `out`.
 * `pigmentStrength` in [0..1]: 0.0 = regular sRGB blend, 1.0 = full physical pigment blend.
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
  return pigmentMixRgbOut(r1In, g1In, b1In, r2In, g2In, b2In, weight2, pigmentStrength, out);
}

// Reusable scratch buffers for zero-allocation pigment sampling & deposit in LayerPixelSampler
const _samplerLatTmp = new Float32Array(PIGMENT_LATENT_SIZE);
const _samplerLatAcc = new Float32Array(PIGMENT_LATENT_SIZE);
const _samplerRgbScratch: RgbColor = { r: 0, g: 0, b: 0 };
const _sample5TapR = new Uint8Array(5);
const _sample5TapG = new Uint8Array(5);
const _sample5TapB = new Uint8Array(5);
const _sample5TapW = new Float32Array(5);

/**
 * Subtractive Pigment Mixing (Physical Kubelka-Munk 4-Pigment Latent Engine).
 * Simulates real-world paint absorption and scattering where Blue + Yellow = vibrant Green,
 * Dark Navy / Crimson / Emerald + White = luminous Cerulean / Magenta / Teal,
 * Red + Blue = Violet, Red + Yellow = Orange.
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
 * Blends two colors with configurable physical pigment mixing strength [0..1].
 * 0.0 = standard linear RGB interpolation; 1.0 = full Kubelka-Munk pigment mixing.
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
  private lastTileKey: number = -1;
  private lastTileBuf: Uint8ClampedArray | null = null;
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
    if (key === this.lastTileKey && this.lastTileBuf) return this.lastTileBuf;
    let buf = this.lazyTiles.get(key);
    if (buf) {
      this.lastTileKey = key;
      this.lastTileBuf = buf;
      return buf;
    }

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
   * When `usePigment` is true, averages multi-color neighborhoods in 7-channel Kubelka-Munk
   * pigment latent space so crossing Blue|Yellow yields vibrant Green instead of RGB gray.
   */
  public sampleColor(
    cx: number,
    cy: number,
    radius: number,
    usePigment: boolean = false
  ): RgbaColor {
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
      if (usePigment) _samplerLatAcc.fill(0);

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
              if (usePigment) {
                srgbToPigmentLatentOut(tile[idx], tile[idx + 1], tile[idx + 2], _samplerLatTmp, 0);
                for (let c = 0; c < 7; c++) _samplerLatAcc[c] += _samplerLatTmp[c] * radialWeight;
              } else {
                sumR += tile[idx] * radialWeight;
                sumG += tile[idx + 1] * radialWeight;
                sumB += tile[idx + 2] * radialWeight;
              }
              weightSum += radialWeight;
            }
          }
        }
      }

      if (weightSum > 0.001 && radialAreaSum > 0) {
        if (usePigment) {
          const invW = 1 / weightSum;
          for (let c = 0; c < 7; c++) _samplerLatAcc[c] *= invW;
          pigmentLatentToSrgbOut(_samplerLatAcc, 0, _samplerRgbScratch);
          return {
            r: _samplerRgbScratch.r,
            g: _samplerRgbScratch.g,
            b: _samplerRgbScratch.b,
            a: Math.min(1.0, weightSum / radialAreaSum),
          };
        }
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
    if (usePigment) _samplerLatAcc.fill(0);

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
            const radialWeight = geomWeight * (alpha / 255);
            if (usePigment) {
              srgbToPigmentLatentOut(this.data[idx], this.data[idx + 1], this.data[idx + 2], _samplerLatTmp, 0);
              for (let c = 0; c < 7; c++) _samplerLatAcc[c] += _samplerLatTmp[c] * radialWeight;
            } else {
              sumR += this.data[idx] * radialWeight;
              sumG += this.data[idx + 1] * radialWeight;
              sumB += this.data[idx + 2] * radialWeight;
            }
            weightSum += radialWeight;
          }
        }
      }
    }

    if (weightSum > 0.001 && radialAreaSum > 0) {
      if (usePigment) {
        const invW = 1 / weightSum;
        for (let c = 0; c < 7; c++) _samplerLatAcc[c] *= invW;
        pigmentLatentToSrgbOut(_samplerLatAcc, 0, _samplerRgbScratch);
        return {
          r: _samplerRgbScratch.r,
          g: _samplerRgbScratch.g,
          b: _samplerRgbScratch.b,
          a: Math.min(1.0, weightSum / radialAreaSum),
        };
      }
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
    a: number,
    pigmentStrength: number = 0
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
    const step = rad > 14 ? 2 : 1;
    const usePigment = pigmentStrength > 0.005;

    const blendPixel = (px: number, py: number, effAlpha: number) => {
      if (this.useLazyTiles) {
        const tile = this.getOrLoadTile(px >> 8, py >> 8);
        const idx = (((py & 255) << 8) + (px & 255)) << 2;
        const dstA = tile[idx + 3] / 255;
        const outA = effAlpha + dstA * (1 - effAlpha);
        if (outA > 0.001) {
          if (usePigment && dstA > 0.002) {
            pigmentMixRgbOut(tile[idx], tile[idx + 1], tile[idx + 2], r, g, b, effAlpha / outA, pigmentStrength, _samplerRgbScratch);
            tile[idx] = Math.round(_samplerRgbScratch.r);
            tile[idx + 1] = Math.round(_samplerRgbScratch.g);
            tile[idx + 2] = Math.round(_samplerRgbScratch.b);
          } else {
            const inv = 1 / outA;
            tile[idx] = Math.round((r * effAlpha + tile[idx] * dstA * (1 - effAlpha)) * inv);
            tile[idx + 1] = Math.round((g * effAlpha + tile[idx + 1] * dstA * (1 - effAlpha)) * inv);
            tile[idx + 2] = Math.round((b * effAlpha + tile[idx + 2] * dstA * (1 - effAlpha)) * inv);
          }
          tile[idx + 3] = Math.round(Math.min(255, outA * 255));
        }
      } else {
        const idx = (py * w + px) << 2;
        const dstA = this.data[idx + 3] / 255;
        const outA = effAlpha + dstA * (1 - effAlpha);
        if (outA > 0.001) {
          if (usePigment && dstA > 0.002) {
            pigmentMixRgbOut(this.data[idx], this.data[idx + 1], this.data[idx + 2], r, g, b, effAlpha / outA, pigmentStrength, _samplerRgbScratch);
            this.data[idx] = Math.round(_samplerRgbScratch.r);
            this.data[idx + 1] = Math.round(_samplerRgbScratch.g);
            this.data[idx + 2] = Math.round(_samplerRgbScratch.b);
          } else {
            const inv = 1 / outA;
            this.data[idx] = Math.round((r * effAlpha + this.data[idx] * dstA * (1 - effAlpha)) * inv);
            this.data[idx + 1] = Math.round((g * effAlpha + this.data[idx + 1] * dstA * (1 - effAlpha)) * inv);
            this.data[idx + 2] = Math.round((b * effAlpha + this.data[idx + 2] * dstA * (1 - effAlpha)) * inv);
          }
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
  public samplePointFast(
    cx: number,
    cy: number,
    radius: number,
    out: RgbaColor,
    usePigment: boolean = false
  ): RgbaColor {
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
    if (rOff === 0) {
      let alpha = 0;
      let tr = 0;
      let tg = 0;
      let tb = 0;
      if (this.useLazyTiles) {
        const tile = this.getOrLoadTile(ix >> 8, iy >> 8);
        const idx = (((iy & 255) << 8) + (ix & 255)) << 2;
        tr = tile[idx];
        tg = tile[idx + 1];
        tb = tile[idx + 2];
        alpha = tile[idx + 3];
      } else {
        const idx = (iy * w + ix) << 2;
        tr = this.data[idx];
        tg = this.data[idx + 1];
        tb = this.data[idx + 2];
        alpha = this.data[idx + 3];
      }
      if (alpha > 4) {
        out.r = tr;
        out.g = tg;
        out.b = tb;
        out.a = alpha * (1 / 255);
      } else {
        out.r = 255;
        out.g = 255;
        out.b = 255;
        out.a = 0;
      }
      return out;
    }

    // Collect 5-tap cross into local scalars so we only pay 7-channel pigment encoding when taps truly differ in color
    const tapR = _sample5TapR;
    const tapG = _sample5TapG;
    const tapB = _sample5TapB;
    const tapW = _sample5TapW;
    let tapCount = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let weightSum = 0;
    let totalSamples = 0;
    let refR = -1;
    let refG = 0;
    let refB = 0;
    let differs = false;

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
        const aw = geomW * (alpha * (1 / 255));
        sumR += tr * aw;
        sumG += tg * aw;
        sumB += tb * aw;
        weightSum += aw;
        if (usePigment) {
          tapR[tapCount] = tr;
          tapG[tapCount] = tg;
          tapB[tapCount] = tb;
          tapW[tapCount] = aw;
          if (refR < 0) {
            refR = tr;
            refG = tg;
            refB = tb;
          } else if (!differs) {
            const l1 = Math.abs(tr - refR) + Math.abs(tg - refG) + Math.abs(tb - refB);
            if (l1 > 12) differs = true;
          }
          tapCount++;
        }
      }
    };

    readTap(ix, iy, 2.0);
    readTap(ix - rOff, iy, 1.0);
    readTap(ix + rOff, iy, 1.0);
    readTap(ix, iy - rOff, 1.0);
    readTap(ix, iy + rOff, 1.0);

    if (weightSum > 0.001 && totalSamples > 0) {
      const invW = 1 / weightSum;
      if (usePigment && differs && tapCount > 1) {
        _samplerLatAcc.fill(0);
        for (let k = 0; k < tapCount; k++) {
          const tw = tapW[k];
          srgbToPigmentLatentOut(tapR[k], tapG[k], tapB[k], _samplerLatTmp, 0);
          _samplerLatAcc[0] += _samplerLatTmp[0] * tw;
          _samplerLatAcc[1] += _samplerLatTmp[1] * tw;
          _samplerLatAcc[2] += _samplerLatTmp[2] * tw;
          _samplerLatAcc[3] += _samplerLatTmp[3] * tw;
          _samplerLatAcc[4] += _samplerLatTmp[4] * tw;
          _samplerLatAcc[5] += _samplerLatTmp[5] * tw;
          _samplerLatAcc[6] += _samplerLatTmp[6] * tw;
        }
        _samplerLatAcc[0] *= invW;
        _samplerLatAcc[1] *= invW;
        _samplerLatAcc[2] *= invW;
        _samplerLatAcc[3] *= invW;
        _samplerLatAcc[4] *= invW;
        _samplerLatAcc[5] *= invW;
        _samplerLatAcc[6] *= invW;
        pigmentLatentToSrgbOut(_samplerLatAcc, 0, out);
      } else {
        out.r = sumR * invW;
        out.g = sumG * invW;
        out.b = sumB * invW;
      }
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
  public sampleBilinearFast(
    cx: number,
    cy: number,
    out: RgbaColor,
    usePigment: boolean = false
  ): RgbaColor {
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

    // Fast path: all 4 bilinear corners inside the same 256x256 tile (99%+ of samples -> 1 cached tile hit)
    if (this.useLazyTiles && (x0 >> 8) === (x1 >> 8) && (y0 >> 8) === (y1 >> 8)) {
      const tile = this.getOrLoadTile(x0 >> 8, y0 >> 8);
      const r0 = (y0 & 255) << 8;
      const r1 = (y1 & 255) << 8;
      const c0 = x0 & 255;
      const c1 = x1 & 255;
      const i00 = (r0 + c0) << 2;
      const i10 = (r0 + c1) << 2;
      const i01 = (r1 + c0) << 2;
      const i11 = (r1 + c1) << 2;
      const a00 = tile[i00 + 3];
      const a10 = tile[i10 + 3];
      const a01 = tile[i01 + 3];
      const a11 = tile[i11 + 3];
      if ((a00 | a10 | a01 | a11) === 0) {
        out.r = 255;
        out.g = 255;
        out.b = 255;
        out.a = 0;
        return out;
      }
      const aw00 = w00 * (a00 * (1 / 255));
      const aw10 = w10 * (a10 * (1 / 255));
      const aw01 = w01 * (a01 * (1 / 255));
      const aw11 = w11 * (a11 * (1 / 255));
      const sumA = aw00 + aw10 + aw01 + aw11;
      if (sumA > 0.002) {
        const inv = 1 / sumA;
        if (usePigment) {
          // Only pay 4-corner latent interpolation when neighboring corners differ meaningfully (> 12 L1);
          // on smooth gradients (<= 4 per channel) linear bilinear matches Kubelka-Munk to < 0.02/255.
          const r00 = tile[i00], g00 = tile[i00 + 1], b00 = tile[i00 + 2];
          const r10 = tile[i10], g10 = tile[i10 + 1], b10 = tile[i10 + 2];
          const r01 = tile[i01], g01 = tile[i01 + 1], b01 = tile[i01 + 2];
          const r11 = tile[i11], g11 = tile[i11 + 1], b11 = tile[i11 + 2];
          const differs =
            (aw10 > 0 && Math.abs(r10 - r00) + Math.abs(g10 - g00) + Math.abs(b10 - b00) > 12) ||
            (aw01 > 0 && Math.abs(r01 - r00) + Math.abs(g01 - g00) + Math.abs(b01 - b00) > 12) ||
            (aw11 > 0 && Math.abs(r11 - r00) + Math.abs(g11 - g00) + Math.abs(b11 - b00) > 12);
          if (differs) {
            _samplerLatAcc.fill(0);
            if (aw00 > 0) {
              srgbToPigmentLatentOut(r00, g00, b00, _samplerLatTmp, 0);
              for (let c = 0; c < 7; c++) _samplerLatAcc[c] += _samplerLatTmp[c] * aw00;
            }
            if (aw10 > 0) {
              srgbToPigmentLatentOut(r10, g10, b10, _samplerLatTmp, 0);
              for (let c = 0; c < 7; c++) _samplerLatAcc[c] += _samplerLatTmp[c] * aw10;
            }
            if (aw01 > 0) {
              srgbToPigmentLatentOut(r01, g01, b01, _samplerLatTmp, 0);
              for (let c = 0; c < 7; c++) _samplerLatAcc[c] += _samplerLatTmp[c] * aw01;
            }
            if (aw11 > 0) {
              srgbToPigmentLatentOut(r11, g11, b11, _samplerLatTmp, 0);
              for (let c = 0; c < 7; c++) _samplerLatAcc[c] += _samplerLatTmp[c] * aw11;
            }
            for (let c = 0; c < 7; c++) _samplerLatAcc[c] *= inv;
            pigmentLatentToSrgbOut(_samplerLatAcc, 0, out);
            out.a = sumA > 1 ? 1 : sumA;
            return out;
          }
        }
        out.r = (tile[i00] * aw00 + tile[i10] * aw10 + tile[i01] * aw01 + tile[i11] * aw11) * inv;
        out.g = (tile[i00 + 1] * aw00 + tile[i10 + 1] * aw10 + tile[i01 + 1] * aw01 + tile[i11 + 1] * aw11) * inv;
        out.b = (tile[i00 + 2] * aw00 + tile[i10 + 2] * aw10 + tile[i01 + 2] * aw01 + tile[i11 + 2] * aw11) * inv;
        out.a = sumA > 1 ? 1 : sumA;
      } else {
        out.r = 255;
        out.g = 255;
        out.b = 255;
        out.a = 0;
      }
      return out;
    }

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumA = 0;
    if (usePigment) _samplerLatAcc.fill(0);

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
        if (usePigment) {
          srgbToPigmentLatentOut(tr, tg, tb, _samplerLatTmp, 0);
          for (let c = 0; c < 7; c++) _samplerLatAcc[c] += _samplerLatTmp[c] * aw;
        } else {
          sumR += tr * aw;
          sumG += tg * aw;
          sumB += tb * aw;
        }
        sumA += aw;
      }
    };

    accum(x0, y0, w00);
    if (x1 !== x0) accum(x1, y0, w10);
    if (y1 !== y0) accum(x0, y1, w01);
    if (x1 !== x0 && y1 !== y0) accum(x1, y1, w11);

    if (sumA > 0.002) {
      const inv = 1 / sumA;
      if (usePigment) {
        for (let c = 0; c < 7; c++) _samplerLatAcc[c] *= inv;
        pigmentLatentToSrgbOut(_samplerLatAcc, 0, out);
      } else {
        out.r = sumR * inv;
        out.g = sumG * inv;
        out.b = sumB * inv;
      }
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
   * Zero-allocation O(1) bilinear sample directly into 7-channel Kubelka-Munk latent space
   * for SpatialTipMixer: eliminates redundant encode/decode roundtrips per texel!
   * Writes linear RGB into `out` (and 7 latent floats into `outLat[outLatOff..+6]` when `out.a > 0.002`).
   */
  public sampleBilinearLatentFast(
    cx: number,
    cy: number,
    out: RgbaColor,
    outLat: Float32Array,
    outLatOff: number
  ): RgbaColor {
    const w = this.width;
    const h = this.height;
    if (w <= 0 || h <= 0 || cx < -0.5 || cy < -0.5 || cx >= w - 0.5 || cy >= h - 0.5) {
      out.r = 255;
      out.g = 255;
      out.b = 255;
      out.a = 0;
      return out;
    }

    const x0 = cx <= 0 ? 0 : cx >= w - 1 ? w - 1 : cx | 0;
    const y0 = cy <= 0 ? 0 : cy >= h - 1 ? h - 1 : cy | 0;
    const x1 = x0 + 1 < w ? x0 + 1 : w - 1;
    const y1 = y0 + 1 < h ? y0 + 1 : h - 1;
    const fx = cx <= x0 ? 0 : cx >= x0 + 1 ? 1 : cx - x0;
    const fy = cy <= y0 ? 0 : cy >= y0 + 1 ? 1 : cy - y0;

    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;

    let r00 = 0, g00 = 0, b00 = 0, a00 = 0;
    let r10 = 0, g10 = 0, b10 = 0, a10 = 0;
    let r01 = 0, g01 = 0, b01 = 0, a01 = 0;
    let r11 = 0, g11 = 0, b11 = 0, a11 = 0;

    if (this.useLazyTiles) {
      const tx0 = x0 >> 8;
      const ty0 = y0 >> 8;
      if (tx0 === (x1 >> 8) && ty0 === (y1 >> 8)) {
        const tile = this.getOrLoadTile(tx0, ty0);
        const row0 = (y0 & 255) << 8;
        const row1 = (y1 & 255) << 8;
        const c0 = x0 & 255;
        const c1 = x1 & 255;
        const i00 = (row0 + c0) << 2;
        const i10 = (row0 + c1) << 2;
        const i01 = (row1 + c0) << 2;
        const i11 = (row1 + c1) << 2;
        a00 = tile[i00 + 3];
        a10 = tile[i10 + 3];
        a01 = tile[i01 + 3];
        a11 = tile[i11 + 3];
        if ((a00 | a10 | a01 | a11) === 0) {
          out.r = 255; out.g = 255; out.b = 255; out.a = 0;
          return out;
        }
        r00 = tile[i00]; g00 = tile[i00 + 1]; b00 = tile[i00 + 2];
        r10 = tile[i10]; g10 = tile[i10 + 1]; b10 = tile[i10 + 2];
        r01 = tile[i01]; g01 = tile[i01 + 1]; b01 = tile[i01 + 2];
        r11 = tile[i11]; g11 = tile[i11 + 1]; b11 = tile[i11 + 2];
      } else {
        const t00 = this.getOrLoadTile(tx0, ty0);
        const i00 = (((y0 & 255) << 8) + (x0 & 255)) << 2;
        r00 = t00[i00]; g00 = t00[i00 + 1]; b00 = t00[i00 + 2]; a00 = t00[i00 + 3];
        const t10 = this.getOrLoadTile(x1 >> 8, ty0);
        const i10 = (((y0 & 255) << 8) + (x1 & 255)) << 2;
        r10 = t10[i10]; g10 = t10[i10 + 1]; b10 = t10[i10 + 2]; a10 = t10[i10 + 3];
        const t01 = this.getOrLoadTile(tx0, y1 >> 8);
        const i01 = (((y1 & 255) << 8) + (x0 & 255)) << 2;
        r01 = t01[i01]; g01 = t01[i01 + 1]; b01 = t01[i01 + 2]; a01 = t01[i01 + 3];
        const t11 = this.getOrLoadTile(x1 >> 8, y1 >> 8);
        const i11 = (((y1 & 255) << 8) + (x1 & 255)) << 2;
        r11 = t11[i11]; g11 = t11[i11 + 1]; b11 = t11[i11 + 2]; a11 = t11[i11 + 3];
        if ((a00 | a10 | a01 | a11) === 0) {
          out.r = 255; out.g = 255; out.b = 255; out.a = 0;
          return out;
        }
      }
    } else {
      const data = this.data;
      const r0 = y0 * w;
      const r1 = y1 * w;
      const i00 = (r0 + x0) << 2;
      const i10 = (r0 + x1) << 2;
      const i01 = (r1 + x0) << 2;
      const i11 = (r1 + x1) << 2;
      a00 = data[i00 + 3];
      a10 = data[i10 + 3];
      a01 = data[i01 + 3];
      a11 = data[i11 + 3];
      if ((a00 | a10 | a01 | a11) === 0) {
        out.r = 255; out.g = 255; out.b = 255; out.a = 0;
        return out;
      }
      r00 = data[i00]; g00 = data[i00 + 1]; b00 = data[i00 + 2];
      r10 = data[i10]; g10 = data[i10 + 1]; b10 = data[i10 + 2];
      r01 = data[i01]; g01 = data[i01 + 1]; b01 = data[i01 + 2];
      r11 = data[i11]; g11 = data[i11 + 1]; b11 = data[i11 + 2];
    }

    const inv255 = 1 / 255;
    const aw00 = w00 * (a00 * inv255);
    const aw10 = w10 * (a10 * inv255);
    const aw01 = w01 * (a01 * inv255);
    const aw11 = w11 * (a11 * inv255);
    const sumA = aw00 + aw10 + aw01 + aw11;
    if (sumA <= 0.002) {
      out.r = 255; out.g = 255; out.b = 255; out.a = 0;
      return out;
    }

    const inv = 1 / sumA;
    const linR = (r00 * aw00 + r10 * aw10 + r01 * aw01 + r11 * aw11) * inv;
    const linG = (g00 * aw00 + g10 * aw10 + g01 * aw01 + g11 * aw11) * inv;
    const linB = (b00 * aw00 + b10 * aw10 + b01 * aw01 + b11 * aw11) * inv;
    out.r = linR;
    out.g = linG;
    out.b = linB;
    out.a = sumA > 1 ? 1 : sumA;

    const differs =
      (aw10 > 0 && Math.abs(r10 - r00) + Math.abs(g10 - g00) + Math.abs(b10 - b00) > 12) ||
      (aw01 > 0 && Math.abs(r01 - r00) + Math.abs(g01 - g00) + Math.abs(b01 - b00) > 12) ||
      (aw11 > 0 && Math.abs(r11 - r00) + Math.abs(g11 - g00) + Math.abs(b11 - b00) > 12);

    if (!differs) {
      srgbToPigmentLatentOut(linR, linG, linB, outLat, outLatOff);
      return out;
    }

    let l0 = 0, l1 = 0, l2 = 0, l3 = 0, l4 = 0, l5 = 0, l6 = 0;
    if (aw00 > 0) {
      srgbToPigmentLatentOut(r00, g00, b00, _samplerLatTmp, 0);
      l0 += _samplerLatTmp[0] * aw00; l1 += _samplerLatTmp[1] * aw00; l2 += _samplerLatTmp[2] * aw00;
      l3 += _samplerLatTmp[3] * aw00; l4 += _samplerLatTmp[4] * aw00; l5 += _samplerLatTmp[5] * aw00; l6 += _samplerLatTmp[6] * aw00;
    }
    if (aw10 > 0) {
      srgbToPigmentLatentOut(r10, g10, b10, _samplerLatTmp, 0);
      l0 += _samplerLatTmp[0] * aw10; l1 += _samplerLatTmp[1] * aw10; l2 += _samplerLatTmp[2] * aw10;
      l3 += _samplerLatTmp[3] * aw10; l4 += _samplerLatTmp[4] * aw10; l5 += _samplerLatTmp[5] * aw10; l6 += _samplerLatTmp[6] * aw10;
    }
    if (aw01 > 0) {
      srgbToPigmentLatentOut(r01, g01, b01, _samplerLatTmp, 0);
      l0 += _samplerLatTmp[0] * aw01; l1 += _samplerLatTmp[1] * aw01; l2 += _samplerLatTmp[2] * aw01;
      l3 += _samplerLatTmp[3] * aw01; l4 += _samplerLatTmp[4] * aw01; l5 += _samplerLatTmp[5] * aw01; l6 += _samplerLatTmp[6] * aw01;
    }
    if (aw11 > 0) {
      srgbToPigmentLatentOut(r11, g11, b11, _samplerLatTmp, 0);
      l0 += _samplerLatTmp[0] * aw11; l1 += _samplerLatTmp[1] * aw11; l2 += _samplerLatTmp[2] * aw11;
      l3 += _samplerLatTmp[3] * aw11; l4 += _samplerLatTmp[4] * aw11; l5 += _samplerLatTmp[5] * aw11; l6 += _samplerLatTmp[6] * aw11;
    }
    outLat[outLatOff] = l0 * inv;
    outLat[outLatOff + 1] = l1 * inv;
    outLat[outLatOff + 2] = l2 * inv;
    outLat[outLatOff + 3] = l3 * inv;
    outLat[outLatOff + 4] = l4 * inv;
    outLat[outLatOff + 5] = l5 * inv;
    outLat[outLatOff + 6] = l6 * inv;
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
    a: number,
    pigmentStrength: number = 0
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
    const invRadSqP1 = 0.65 / (radSq + 1);
    const usePigment = pigmentStrength > 0.005;
    for (let y = y0; y <= y1; y++) {
      const dy = y - iy;
      const dySq = dy * dy;
      const ty = y >> 8;
      const lyOff = (y & 255) << 8;
      const rowOff = y * w;
      let cachedTx = -1;
      let cachedTile: Uint8ClampedArray | null = null;
      for (let x = x0; x <= x1; x++) {
        const dx = x - ix;
        const dSq = dx * dx + dySq;
        if (dSq > radSq) continue;
        const effA = Math.min(1.0, a * (rad === 0 ? 1.0 : 1.0 - dSq * invRadSqP1));
        if (this.useLazyTiles) {
          const tx = x >> 8;
          if (tx !== cachedTx) {
            cachedTile = this.getOrLoadTile(tx, ty);
            cachedTx = tx;
          }
          const tile = cachedTile!;
          const idx = (lyOff + (x & 255)) << 2;
          const dstA = tile[idx + 3] * (1 / 255);
          const outA = effA + dstA * (1 - effA);
          if (outA > 0.001) {
            const dr = tile[idx];
            const dg = tile[idx + 1];
            const db = tile[idx + 2];
            const diffSq = (r - dr) * (r - dr) + (g - dg) * (g - dg) + (b - db) * (b - db);
            if (usePigment && dstA > 0.002 && diffSq > 64) {
              pigmentMixRgbOut(dr, dg, db, r, g, b, effA / outA, pigmentStrength, _samplerRgbScratch);
              tile[idx] = (_samplerRgbScratch.r + 0.5) | 0;
              tile[idx + 1] = (_samplerRgbScratch.g + 0.5) | 0;
              tile[idx + 2] = (_samplerRgbScratch.b + 0.5) | 0;
            } else {
              const inv = 1 / outA;
              const dstW = dstA * (1 - effA);
              tile[idx] = ((r * effA + dr * dstW) * inv + 0.5) | 0;
              tile[idx + 1] = ((g * effA + dg * dstW) * inv + 0.5) | 0;
              tile[idx + 2] = ((b * effA + db * dstW) * inv + 0.5) | 0;
            }
            tile[idx + 3] = outA >= 1 ? 255 : (outA * 255 + 0.5) | 0;
          }
        } else {
          const idx = (rowOff + x) << 2;
          const dstA = this.data[idx + 3] * (1 / 255);
          const outA = effA + dstA * (1 - effA);
          if (outA > 0.001) {
            const dr = this.data[idx];
            const dg = this.data[idx + 1];
            const db = this.data[idx + 2];
            const diffSq = (r - dr) * (r - dr) + (g - dg) * (g - dg) + (b - db) * (b - db);
            if (usePigment && dstA > 0.002 && diffSq > 64) {
              pigmentMixRgbOut(dr, dg, db, r, g, b, effA / outA, pigmentStrength, _samplerRgbScratch);
              this.data[idx] = (_samplerRgbScratch.r + 0.5) | 0;
              this.data[idx + 1] = (_samplerRgbScratch.g + 0.5) | 0;
              this.data[idx + 2] = (_samplerRgbScratch.b + 0.5) | 0;
            } else {
              const inv = 1 / outA;
              const dstW = dstA * (1 - effA);
              this.data[idx] = ((r * effA + dr * dstW) * inv + 0.5) | 0;
              this.data[idx + 1] = ((g * effA + dg * dstW) * inv + 0.5) | 0;
              this.data[idx + 2] = ((b * effA + db * dstW) * inv + 0.5) | 0;
            }
            this.data[idx + 3] = outA >= 1 ? 255 : (outA * 255 + 0.5) | 0;
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
    const effectiveSmudgeDensity = isPureSmudge
      ? Math.max(densityOfPaint, clampedStretch)
      : densityOfPaint;
    const dabAlpha = isPureSmudge
      ? flow * pressureMod * effectiveSmudgeDensity * this.a
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
  private readonly scratchEqOut: RgbColor = { r: 0, g: 0, b: 0 };
  private readonly scratchMixOut: RgbColor = { r: 0, g: 0, b: 0 };

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
          const mixed = mixPigmentRgbOut(
            this.scratchC1.r, this.scratchC1.g, this.scratchC1.b,
            this.scratchC2.r, this.scratchC2.g, this.scratchC2.b,
            pickup, pigmentStrength, this.scratchMixOut
          );
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
        const eqColor = mixPigmentRgbOut(
          this.scratchC2.r, this.scratchC2.g, this.scratchC2.b,
          this.originalR, this.originalG, this.originalB,
          eqFreshRatio, pigmentStrength, this.scratchEqOut
        );

        // Pickup responds smoothly on contact; colorStretch governs long ribbon carry
        const charDist = (9 + clampedStretch * 24) * (0.7 + viscosity * 0.55);
        const stepRate =
          stepDist > 0
            ? 1.0 - Math.exp(-(stepDist * Math.max(0.45, wTotal)) / charDist)
            : Math.min(0.35, (1.0 - eqFreshRatio) * 0.5 * canvasAlpha);

        const mixed = mixPigmentRgbOut(
          this.scratchC1.r, this.scratchC1.g, this.scratchC1.b,
          eqColor.r, eqColor.g, eqColor.b,
          stepRate, pigmentStrength, this.scratchMixOut
        );
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
        const recovered = mixPigmentRgbOut(
          this.r[i], this.g[i], this.b[i],
          this.originalR, this.originalG, this.originalB,
          recover, pigmentStrength, this.scratchMixOut
        );
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
  isPureBlender?: boolean;
  mixingMode: NaturalMixingMode;
  perceptualMixing: boolean;
  pigmentMixingStrength?: number;
  useBlur?: boolean;
  blurStrength?: number;
  tipImage?: HTMLImageElement;
  isDualToneTip?: boolean;
  secondaryColor?: string;
  freshColor?: RgbColor;
  sampler?: LayerPixelSampler;
  grainDensity?: number;
  paperTextureMode?: import('../types/editor').CspPaperTextureMode;
  paperLumData?: Uint8Array;
  paperLumWidth?: number;
  paperLumHeight?: number;
  paperTextureScale?: number;
  paperTextureRotate?: number;
  paperTextureBrightness?: number;
  paperTextureContrast?: number;
  paperTextureInverted?: boolean;
  paperTexturePreserveDensity?: boolean;
  paperTextureEmphasizeDensity?: boolean;
  grainPressure?: number;
  grainModulate?: (wx: number, wy: number, tipAlpha: number) => number;
}

interface CachedTipMask {
  width: number;
  height: number;
  alpha: Uint8Array;
  lum: Uint8Array;
  /** (width+1)*(height+1) 2D summed-area table of alpha for O(1) anti-aliased box-filtered downsampling. */
  alphaSat: Uint32Array;
  /** Mean normalized alpha inside the inner 70% of the tip's non-empty bounding box (1.0 = solid, ~0.22 = porous chalk). */
  coreFill: number;
}

const tipAlphaMaskCache = new WeakMap<HTMLImageElement, CachedTipMask>();

function getCachedTipAlphaMask(img: HTMLImageElement): CachedTipMask | null {
  const cached = tipAlphaMaskCache.get(img);
  if (cached) return cached;
  if (typeof document === 'undefined') return null;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (w <= 0 || h <= 0) return null;
  // Preserve full 256x256 procedural tip detail (chipped chalk edges, bristle tufts & mineral micro-pores)
  const maxDim = 256;
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
  const lum = new Uint8Array(dw * dh);
  const satW = dw + 1;
  const alphaSat = new Uint32Array(satW * (dh + 1));
  let minX = dw;
  let maxX = -1;
  let minY = dh;
  let maxY = -1;
  for (let y = 0; y < dh; y++) {
    const row = y * dw;
    const satRow = (y + 1) * satW;
    const satPrev = y * satW;
    let rowSum = 0;
    for (let x = 0; x < dw; x++) {
      const i = row + x;
      const o = i << 2;
      const a = raw[o + 3];
      alpha[i] = a;
      lum[i] = Math.round(0.299 * raw[o] + 0.587 * raw[o + 1] + 0.114 * raw[o + 2]);
      rowSum += a;
      alphaSat[satRow + x + 1] = alphaSat[satPrev + x + 1] + rowSum;
      if (a > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  let coreFill = 1.0;
  if (maxX >= minX && maxY >= minY) {
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const cx0 = minX + Math.floor(bw * 0.15);
    const cx1 = maxX - Math.floor(bw * 0.15);
    const cy0 = minY + Math.floor(bh * 0.15);
    const cy1 = maxY - Math.floor(bh * 0.15);
    let sumA = 0;
    let count = 0;
    for (let y = cy0; y <= cy1; y++) {
      const row = y * dw;
      for (let x = cx0; x <= cx1; x++) {
        sumA += alpha[row + x];
        count++;
      }
    }
    if (count > 0) {
      coreFill = sumA / (count * 255);
    }
  }
  const mask: CachedTipMask = { width: dw, height: dh, alpha, lum, alphaSat, coreFill };
  tipAlphaMaskCache.set(img, mask);
  return mask;
}

const MAX_SPATIAL_COLOR_DIM = 24;
const MAX_SPATIAL_BLUR_DIM = 14;
const MAX_SPATIAL_OUT_DIM = 96;
const MAX_SPATIAL_SOFT_OUT_DIM = 52;
const MAX_SPATIAL_SURFACE_POOL = 48;

interface SpatialSurfaceEntry {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  imgData: ImageData;
}

export class SpatialTipMixer {
  public readonly origR: number;
  public readonly origG: number;
  public readonly origB: number;

  private gridW: number = 0;
  private gridH: number = 0;
  private initialized: boolean = false;
  private latInitialized: boolean = false;
  private uniR: number;
  private uniG: number;
  private uniB: number;
  private uniCarry: number = 0;
  private readonly uniLat = new Float32Array(PIGMENT_LATENT_SIZE);
  private readonly freshLat = new Float32Array(PIGMENT_LATENT_SIZE);
  private cachedFreshR: number = -9999;
  private cachedFreshG: number = -9999;
  private cachedFreshB: number = -9999;
  private readonly bufR = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly bufG = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly bufB = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly linR = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly linG = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly linB = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly bufA = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly bufCarry = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly tmpR = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly tmpG = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly tmpB = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM);
  private readonly latBuf = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM * PIGMENT_LATENT_SIZE);
  private readonly latTmp = new Float32Array(MAX_SPATIAL_COLOR_DIM * MAX_SPATIAL_COLOR_DIM * PIGMENT_LATENT_SIZE);
  private readonly canvasLatSum = new Float32Array(PIGMENT_LATENT_SIZE);
  private readonly latSampleTmp = new Float32Array(PIGMENT_LATENT_SIZE);
  private readonly latEqTmp = new Float32Array(PIGMENT_LATENT_SIZE);

  private readonly surfacePool = new Map<number, SpatialSurfaceEntry>();
  private scratchCanvas: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private scratchImgData: ImageData | null = null;

  private readonly sampleScratch: RgbaColor = { r: 0, g: 0, b: 0, a: 0 };
  private readonly c1Scratch: RgbColor = { r: 0, g: 0, b: 0 };

  constructor(initialColor: string) {
    const rgb = parseColorToRgb(initialColor);
    this.origR = rgb.r;
    this.origG = rgb.g;
    this.origB = rgb.b;
    this.uniR = rgb.r;
    this.uniG = rgb.g;
    this.uniB = rgb.b;
  }

  private ensureGrid(width: number, height: number, useBlur: boolean): void {
    if (this.initialized && this.gridW > 0 && this.gridH > 0) {
      return;
    }
    const dimCap = useBlur ? MAX_SPATIAL_BLUR_DIM : MAX_SPATIAL_COLOR_DIM;
    const maxDim = Math.max(width, height, 1);
    const scale = Math.min(1, dimCap / maxDim);
    this.gridW = Math.max(8, Math.min(dimCap, Math.ceil(width * scale)));
    this.gridH = Math.max(8, Math.min(dimCap, Math.ceil(height * scale)));
  }

  private ensureScratchSurface(outW: number, outH: number): boolean {
    if (typeof document === 'undefined') return false;
    const pool = this.surfacePool;
    const key = (outW << 12) | outH;
    let entry = pool.get(key);
    if (!entry) {
      if (pool.size >= MAX_SPATIAL_SURFACE_POOL) {
        const oldest = pool.keys().next().value;
        if (oldest !== undefined) pool.delete(oldest);
      }
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx || typeof ctx.createImageData !== 'function') return false;
      const imgData = ctx.createImageData(outW, outH);
      entry = { canvas, ctx, imgData };
      pool.set(key, entry);
    }
    this.scratchCanvas = entry.canvas;
    this.scratchCtx = entry.ctx;
    this.scratchImgData = entry.imgData;
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

    const blurAmt = p.useBlur ? Math.max(0, Math.min(1, p.blurStrength ?? 0.35)) : 0;
    this.ensureGrid(p.width, p.height, blurAmt > 0.005);
    const gw = this.gridW;
    const gh = this.gridH;

    // 1:1 output stamp dimensions (capped adaptively) with 1px transparent padding on each edge
    // so Canvas2D bilinear filtering never blurs or clips sharp rotated chisel corners.
    // Soft/blurred stamps have no sub-pixel silhouette detail and upscale identically on GPU.
    const isSoftSmoothStamp = !p.tipImage && (blurAmt > 0.05 || p.hardness < 0.85) && (p.grainDensity ?? 0) <= 0.005;
    const outDimCap = isSoftSmoothStamp ? MAX_SPATIAL_SOFT_OUT_DIM : MAX_SPATIAL_OUT_DIM;
    const maxAxis = Math.max(p.width, p.height);
    const outScale = maxAxis > outDimCap - 2 ? (outDimCap - 2) / maxAxis : 1.0;
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
    const isPureSmudge =
      p.isPureBlender !== undefined
        ? p.isPureBlender || p.mixingMode === 'smear'
        : clampedAmount <= 0.005 || p.mixingMode === 'smear';
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
    // For pure blenders (Amount=0), high Color Stretch drags picked-up color far across
    // contrasting regions and off onto blank canvas (matching CSP Fur Blend / Finger Tip).
    const carryScale = Math.max(0.75, brushSpan / 36);
    const pickupLen = isPureSmudge
      ? Math.max(8.0, diamAlongStroke * (0.45 + 2.8 * clampedStretch * clampedStretch))
      : Math.max(1.8, diamAlongStroke * (0.26 + 0.44 * clampedStretch));
    const pickupRate = step > 0 ? 1.0 - Math.exp(-step / pickupLen) : 0.9;

    const stretchDist = isPureSmudge
      ? Math.max(40.0, (60 + clampedStretch * clampedStretch * 480) * carryScale)
      : Math.max(16.0, (24 + clampedStretch * clampedStretch * 340) * carryScale);
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

    const sampler = p.sampler;
    const usePigment = effPigmentStrength > 0.005;
    const partialPigment = usePigment && effPigmentStrength < 0.995;
    const firstTouch = !this.initialized;
    let pickedUpCanvas = false;
    let sumBufR = 0;
    let sumBufG = 0;
    let sumBufB = 0;
    let sumBufA = 0;
    let canvasSumR = 0;
    let canvasSumG = 0;
    let canvasSumB = 0;
    let canvasAlphaSum = 0;
    const totalTexels = gw * gh;
    if (usePigment) this.canvasLatSum.fill(0);

    // CSP Blend (BrushWaterColor=0) mixes canvas color isotropically across compact/round tips
    // (like Oil Pastel sticks), while wide flat bristle blades (aspect >= 2.5) and Running Color
    // preserve spatial per-bristle side-by-side color separation.
    const tipAspect = brushSpan / Math.max(0.5, thinSpan);
    const blendUniformity =
      !isRunning && !isPureSmudge && !isFullFresh
        ? Math.max(0, Math.min(1, 1.85 - tipAspect))
        : 0;

    const freshR = p.freshColor ? p.freshColor.r : this.origR;
    const freshG = p.freshColor ? p.freshColor.g : this.origG;
    const freshB = p.freshColor ? p.freshColor.b : this.origB;

    const freshLat = this.freshLat;
    if (usePigment) {
      if (freshR !== this.cachedFreshR || freshG !== this.cachedFreshG || freshB !== this.cachedFreshB) {
        srgbToPigmentLatentOut(freshR, freshG, freshB, freshLat, 0);
        this.cachedFreshR = freshR;
        this.cachedFreshG = freshG;
        this.cachedFreshB = freshB;
      }
      // If stroke switched into pigment mode after already initializing in linear mode, sync latBuf once
      if (!firstTouch && !this.latInitialized) {
        for (let i = 0; i < totalTexels; i++) {
          srgbToPigmentLatentOut(this.bufR[i], this.bufG[i], this.bufB[i], this.latBuf, i * 7);
          if (partialPigment) {
            this.linR[i] = this.bufR[i];
            this.linG[i] = this.bufG[i];
            this.linB[i] = this.bufB[i];
          }
        }
        srgbToPigmentLatentOut(this.uniR, this.uniG, this.uniB, this.uniLat, 0);
        this.latInitialized = true;
      }
    }

    // 1. Sample underlying canvas & update 2D oriented paint buffer
    // When usePigment is active, ALL mixing & diffusion run directly in 7-channel Kubelka-Munk latent
    // space (7 linear float ops/texel) with ONE single decode at the end of Step 2 — 15-25x faster!
    const stretchPickupBoost = 1.0 + clampedStretch * (isRunning ? 1.45 : 1.15);
    const wFreshBase = clampedAmount * (isRunning ? 0.72 : 0.88);
    const wFreshFirst = clampedAmount * (isRunning ? 0.75 : 0.9);
    const latBuf = this.latBuf;
    const latSamp = this.latSampleTmp;
    const latEq = this.latEqTmp;
    const dLxStep = (2.0 * invGw) * halfW;
    const dWxStep = dLxStep * cosA;
    const dWyStep = dLxStep * sinA;
    const lx0Start = (0.5 * invGw - 0.5) * 2.0 * halfW;

    if (isFullFresh) {
      for (let i = 0; i < totalTexels; i++) {
        this.bufR[i] = freshR;
        this.bufG[i] = freshG;
        this.bufB[i] = freshB;
        this.bufA[i] = 1.0;
        this.bufCarry[i] = 0.0;
        if (usePigment) {
          const lo = i * 7;
          latBuf[lo] = freshLat[0];
          latBuf[lo + 1] = freshLat[1];
          latBuf[lo + 2] = freshLat[2];
          latBuf[lo + 3] = freshLat[3];
          latBuf[lo + 4] = freshLat[4];
          latBuf[lo + 5] = freshLat[5];
          latBuf[lo + 6] = freshLat[6];
        }
      }
      sumBufR = freshR * totalTexels;
      sumBufG = freshG * totalTexels;
      sumBufB = freshB * totalTexels;
      sumBufA = totalTexels;
      if (usePigment) this.latInitialized = true;
    } else if (usePigment) {
      for (let gy = 0; gy < gh; gy++) {
        const ny = ((gy + 0.5) * invGh - 0.5) * 2.0;
        const ly = ny * halfH;
        const rowOff = gy * gw;
        let wx = p.x + lx0Start * cosA - ly * sinA;
        let wy = p.y + lx0Start * sinA + ly * cosA;
        for (let gx = 0; gx < gw; gx++) {
          const idx = rowOff + gx;
          const lo = idx * 7;
          const sampled = sampler
            ? sampler.sampleBilinearLatentFast(wx, wy, this.sampleScratch, latSamp, 0)
            : ((this.sampleScratch.a = 0), this.sampleScratch);
          wx += dWxStep;
          wy += dWyStep;
          const ca = sampled.a;

          if (ca > 0.015) {
            pickedUpCanvas = true;
            if (blendUniformity > 0.001) {
              canvasSumR += sampled.r * ca;
              canvasSumG += sampled.g * ca;
              canvasSumB += sampled.b * ca;
              this.canvasLatSum[0] += latSamp[0] * ca;
              this.canvasLatSum[1] += latSamp[1] * ca;
              this.canvasLatSum[2] += latSamp[2] * ca;
              this.canvasLatSum[3] += latSamp[3] * ca;
              this.canvasLatSum[4] += latSamp[4] * ca;
              this.canvasLatSum[5] += latSamp[5] * ca;
              this.canvasLatSum[6] += latSamp[6] * ca;
              canvasAlphaSum += ca;
            }
          }

          if (firstTouch) {
            if (isPureSmudge) {
              if (ca > 0.002) {
                latBuf[lo] = latSamp[0]; latBuf[lo + 1] = latSamp[1]; latBuf[lo + 2] = latSamp[2];
                latBuf[lo + 3] = latSamp[3]; latBuf[lo + 4] = latSamp[4]; latBuf[lo + 5] = latSamp[5];
                latBuf[lo + 6] = latSamp[6];
                if (partialPigment) {
                  this.linR[idx] = sampled.r; this.linG[idx] = sampled.g; this.linB[idx] = sampled.b;
                }
              } else {
                latBuf[lo] = 0; latBuf[lo + 1] = 0; latBuf[lo + 2] = 0; latBuf[lo + 3] = 1;
                latBuf[lo + 4] = 0; latBuf[lo + 5] = 0; latBuf[lo + 6] = 0;
                if (partialPigment) {
                  this.linR[idx] = 255; this.linG[idx] = 255; this.linB[idx] = 255;
                }
              }
              this.bufA[idx] = ca;
              this.bufCarry[idx] = ca;
            } else if (ca > 0.015) {
              const wCanvas = (1.0 - clampedAmount) * stretchPickupBoost * ca;
              const eqFresh = wFreshFirst / Math.max(1e-4, wFreshFirst + wCanvas);
              const invEq = 1.0 - eqFresh;
              latBuf[lo] = latSamp[0] * invEq + freshLat[0] * eqFresh;
              latBuf[lo + 1] = latSamp[1] * invEq + freshLat[1] * eqFresh;
              latBuf[lo + 2] = latSamp[2] * invEq + freshLat[2] * eqFresh;
              latBuf[lo + 3] = latSamp[3] * invEq + freshLat[3] * eqFresh;
              latBuf[lo + 4] = latSamp[4] * invEq + freshLat[4] * eqFresh;
              latBuf[lo + 5] = latSamp[5] * invEq + freshLat[5] * eqFresh;
              latBuf[lo + 6] = latSamp[6] * invEq + freshLat[6] * eqFresh;
              if (partialPigment) {
                this.linR[idx] = sampled.r * invEq + freshR * eqFresh;
                this.linG[idx] = sampled.g * invEq + freshG * eqFresh;
                this.linB[idx] = sampled.b * invEq + freshB * eqFresh;
              }
              this.bufA[idx] = 1.0;
              this.bufCarry[idx] = Math.min(1.0, ca * (1.0 - eqFresh * 0.65));
            } else {
              latBuf[lo] = freshLat[0]; latBuf[lo + 1] = freshLat[1]; latBuf[lo + 2] = freshLat[2];
              latBuf[lo + 3] = freshLat[3]; latBuf[lo + 4] = freshLat[4]; latBuf[lo + 5] = freshLat[5];
              latBuf[lo + 6] = freshLat[6];
              if (partialPigment) {
                this.linR[idx] = freshR; this.linG[idx] = freshG; this.linB[idx] = freshB;
              }
              this.bufA[idx] = 1.0;
              this.bufCarry[idx] = 0.0;
            }
          } else if (ca > 0.015) {
            if (isPureSmudge) {
              const rate = Math.min(1.0, pickupRate * (0.55 + 0.45 * ca));
              const curA = this.bufA[idx];
              if (curA <= 0.02) {
                latBuf[lo] = latSamp[0]; latBuf[lo + 1] = latSamp[1]; latBuf[lo + 2] = latSamp[2];
                latBuf[lo + 3] = latSamp[3]; latBuf[lo + 4] = latSamp[4]; latBuf[lo + 5] = latSamp[5];
                latBuf[lo + 6] = latSamp[6];
                if (partialPigment) {
                  this.linR[idx] = sampled.r; this.linG[idx] = sampled.g; this.linB[idx] = sampled.b;
                }
                this.bufA[idx] = ca;
                this.bufCarry[idx] = ca;
              } else {
                latBuf[lo] += (latSamp[0] - latBuf[lo]) * rate;
                latBuf[lo + 1] += (latSamp[1] - latBuf[lo + 1]) * rate;
                latBuf[lo + 2] += (latSamp[2] - latBuf[lo + 2]) * rate;
                latBuf[lo + 3] += (latSamp[3] - latBuf[lo + 3]) * rate;
                latBuf[lo + 4] += (latSamp[4] - latBuf[lo + 4]) * rate;
                latBuf[lo + 5] += (latSamp[5] - latBuf[lo + 5]) * rate;
                latBuf[lo + 6] += (latSamp[6] - latBuf[lo + 6]) * rate;
                if (partialPigment) {
                  this.linR[idx] += (sampled.r - this.linR[idx]) * rate;
                  this.linG[idx] += (sampled.g - this.linG[idx]) * rate;
                  this.linB[idx] += (sampled.b - this.linB[idx]) * rate;
                }
                const aStep = rate > 0.35 ? rate : 0.35;
                this.bufA[idx] = Math.min(1.0, curA + (ca - curA) * aStep);
                this.bufCarry[idx] = Math.min(1.0, this.bufCarry[idx] + (ca - this.bufCarry[idx]) * aStep);
              }
            } else {
              const wCanvas = (1.0 - clampedAmount) * stretchPickupBoost * ca;
              const eqFresh = wFreshBase / Math.max(1e-4, wFreshBase + wCanvas);
              const invEq = 1.0 - eqFresh;
              latBuf[lo] += (latSamp[0] * invEq + freshLat[0] * eqFresh - latBuf[lo]) * pickupRate;
              latBuf[lo + 1] += (latSamp[1] * invEq + freshLat[1] * eqFresh - latBuf[lo + 1]) * pickupRate;
              latBuf[lo + 2] += (latSamp[2] * invEq + freshLat[2] * eqFresh - latBuf[lo + 2]) * pickupRate;
              latBuf[lo + 3] += (latSamp[3] * invEq + freshLat[3] * eqFresh - latBuf[lo + 3]) * pickupRate;
              latBuf[lo + 4] += (latSamp[4] * invEq + freshLat[4] * eqFresh - latBuf[lo + 4]) * pickupRate;
              latBuf[lo + 5] += (latSamp[5] * invEq + freshLat[5] * eqFresh - latBuf[lo + 5]) * pickupRate;
              latBuf[lo + 6] += (latSamp[6] * invEq + freshLat[6] * eqFresh - latBuf[lo + 6]) * pickupRate;
              if (partialPigment) {
                this.linR[idx] += (sampled.r * invEq + freshR * eqFresh - this.linR[idx]) * pickupRate;
                this.linG[idx] += (sampled.g * invEq + freshG * eqFresh - this.linG[idx]) * pickupRate;
                this.linB[idx] += (sampled.b * invEq + freshB * eqFresh - this.linB[idx]) * pickupRate;
              }
              this.bufA[idx] = Math.min(1.0, this.bufA[idx] + (1.0 - this.bufA[idx]) * pickupRate);
              const targetCarry = Math.min(1.0, ca * (1.0 - eqFresh * 0.55));
              this.bufCarry[idx] += (targetCarry - this.bufCarry[idx]) * pickupRate;
            }
          } else if (step > 0) {
            if (isPureSmudge) {
              this.bufA[idx] = Math.max(0, this.bufA[idx] * (1.0 - smudgeDecay));
              this.bufCarry[idx] = Math.max(0, this.bufCarry[idx] * (1.0 - carryDecay));
            } else {
              latBuf[lo] += (freshLat[0] - latBuf[lo]) * recoverRate;
              latBuf[lo + 1] += (freshLat[1] - latBuf[lo + 1]) * recoverRate;
              latBuf[lo + 2] += (freshLat[2] - latBuf[lo + 2]) * recoverRate;
              latBuf[lo + 3] += (freshLat[3] - latBuf[lo + 3]) * recoverRate;
              latBuf[lo + 4] += (freshLat[4] - latBuf[lo + 4]) * recoverRate;
              latBuf[lo + 5] += (freshLat[5] - latBuf[lo + 5]) * recoverRate;
              latBuf[lo + 6] += (freshLat[6] - latBuf[lo + 6]) * recoverRate;
              if (partialPigment) {
                this.linR[idx] += (freshR - this.linR[idx]) * recoverRate;
                this.linG[idx] += (freshG - this.linG[idx]) * recoverRate;
                this.linB[idx] += (freshB - this.linB[idx]) * recoverRate;
              }
              this.bufA[idx] = Math.min(1.0, this.bufA[idx] + (1.0 - this.bufA[idx]) * recoverRate);
              this.bufCarry[idx] = Math.max(0, this.bufCarry[idx] * (1.0 - carryDecay));
            }
          }
          sumBufA += this.bufA[idx];
        }
      }
      this.latInitialized = true;
    } else {
      // Fast pure linear RGB path (Regular / perceptualMixing=false)
      for (let gy = 0; gy < gh; gy++) {
        const ny = ((gy + 0.5) * invGh - 0.5) * 2.0;
        const ly = ny * halfH;
        const rowOff = gy * gw;
        let wx = p.x + lx0Start * cosA - ly * sinA;
        let wy = p.y + lx0Start * sinA + ly * cosA;
        for (let gx = 0; gx < gw; gx++) {
          const idx = rowOff + gx;
          const sampled = sampler
            ? sampler.sampleBilinearFast(wx, wy, this.sampleScratch, false)
            : ((this.sampleScratch.a = 0), this.sampleScratch);
          wx += dWxStep;
          wy += dWyStep;
          const ca = sampled.a;
          if (ca > 0.015) {
            pickedUpCanvas = true;
            if (blendUniformity > 0.001) {
              canvasSumR += sampled.r * ca;
              canvasSumG += sampled.g * ca;
              canvasSumB += sampled.b * ca;
              canvasAlphaSum += ca;
            }
          }

          if (firstTouch) {
            if (isPureSmudge) {
              this.bufR[idx] = sampled.r;
              this.bufG[idx] = sampled.g;
              this.bufB[idx] = sampled.b;
              this.bufA[idx] = ca;
              this.bufCarry[idx] = ca;
            } else if (ca > 0.015) {
              const wCanvas = (1.0 - clampedAmount) * stretchPickupBoost * ca;
              const eqFresh = wFreshFirst / Math.max(1e-4, wFreshFirst + wCanvas);
              const invEq = 1.0 - eqFresh;
              this.bufR[idx] = sampled.r * invEq + freshR * eqFresh;
              this.bufG[idx] = sampled.g * invEq + freshG * eqFresh;
              this.bufB[idx] = sampled.b * invEq + freshB * eqFresh;
              this.bufA[idx] = 1.0;
              this.bufCarry[idx] = Math.min(1.0, ca * (1.0 - eqFresh * 0.65));
            } else {
              this.bufR[idx] = freshR;
              this.bufG[idx] = freshG;
              this.bufB[idx] = freshB;
              this.bufA[idx] = 1.0;
              this.bufCarry[idx] = 0.0;
            }
          } else if (ca > 0.015) {
            if (isPureSmudge) {
              const rate = Math.min(1.0, pickupRate * (0.55 + 0.45 * ca));
              const curA = this.bufA[idx];
              if (curA <= 0.02) {
                this.bufR[idx] = sampled.r;
                this.bufG[idx] = sampled.g;
                this.bufB[idx] = sampled.b;
                this.bufA[idx] = ca;
                this.bufCarry[idx] = ca;
              } else {
                this.bufR[idx] += (sampled.r - this.bufR[idx]) * rate;
                this.bufG[idx] += (sampled.g - this.bufG[idx]) * rate;
                this.bufB[idx] += (sampled.b - this.bufB[idx]) * rate;
                const aStep = rate > 0.35 ? rate : 0.35;
                this.bufA[idx] = Math.min(1.0, curA + (ca - curA) * aStep);
                this.bufCarry[idx] = Math.min(1.0, this.bufCarry[idx] + (ca - this.bufCarry[idx]) * aStep);
              }
            } else {
              const wCanvas = (1.0 - clampedAmount) * stretchPickupBoost * ca;
              const eqFresh = wFreshBase / Math.max(1e-4, wFreshBase + wCanvas);
              const invEq = 1.0 - eqFresh;
              const eqR = sampled.r * invEq + freshR * eqFresh;
              const eqG = sampled.g * invEq + freshG * eqFresh;
              const eqB = sampled.b * invEq + freshB * eqFresh;
              this.bufR[idx] += (eqR - this.bufR[idx]) * pickupRate;
              this.bufG[idx] += (eqG - this.bufG[idx]) * pickupRate;
              this.bufB[idx] += (eqB - this.bufB[idx]) * pickupRate;
              this.bufA[idx] = Math.min(1.0, this.bufA[idx] + (1.0 - this.bufA[idx]) * pickupRate);
              const targetCarry = Math.min(1.0, ca * (1.0 - eqFresh * 0.55));
              this.bufCarry[idx] += (targetCarry - this.bufCarry[idx]) * pickupRate;
            }
          } else if (step > 0) {
            if (isPureSmudge) {
              this.bufA[idx] = Math.max(0, this.bufA[idx] * (1.0 - smudgeDecay));
              this.bufCarry[idx] = Math.max(0, this.bufCarry[idx] * (1.0 - carryDecay));
            } else {
              this.bufR[idx] += (freshR - this.bufR[idx]) * recoverRate;
              this.bufG[idx] += (freshG - this.bufG[idx]) * recoverRate;
              this.bufB[idx] += (freshB - this.bufB[idx]) * recoverRate;
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
      this.latInitialized = false;
    }

    this.initialized = true;

    // Early exit for pure blenders on completely empty canvas (zero visible pixels!)
    if (isPureSmudge && sumBufA <= 0.002) {
      return null;
    }

    // 1b. CSP Blend (BrushWaterColor=0) footprint-averaged isotropic tip mixing for compact/round tips
    if (blendUniformity > 0.001) {
      const avgCanvasCa = canvasAlphaSum / Math.max(1, totalTexels);
      const hasCanvasAvg = avgCanvasCa > 0.015 && canvasAlphaSum > 1e-4;
      const invCa = hasCanvasAvg ? 1 / canvasAlphaSum : 0;
      const u = blendUniformity;
      const invU = 1.0 - u;

      if (usePigment) {
        const uniLat = this.uniLat;
        if (hasCanvasAvg) {
          for (let c = 0; c < 7; c++) latSamp[c] = this.canvasLatSum[c] * invCa;
        }
        const avgLinR = hasCanvasAvg ? canvasSumR * invCa : 0;
        const avgLinG = hasCanvasAvg ? canvasSumG * invCa : 0;
        const avgLinB = hasCanvasAvg ? canvasSumB * invCa : 0;

        if (firstTouch) {
          if (hasCanvasAvg) {
            const wCanvasUni = (1.0 - clampedAmount) * stretchPickupBoost * avgCanvasCa;
            const uniFresh = wFreshFirst / Math.max(1e-4, wFreshFirst + wCanvasUni);
            const invUF = 1.0 - uniFresh;
            for (let c = 0; c < 7; c++) uniLat[c] = latSamp[c] * invUF + freshLat[c] * uniFresh;
            this.uniR = avgLinR * invUF + freshR * uniFresh;
            this.uniG = avgLinG * invUF + freshG * uniFresh;
            this.uniB = avgLinB * invUF + freshB * uniFresh;
            this.uniCarry = Math.min(1.0, avgCanvasCa * (1.0 - uniFresh * 0.65));
          } else {
            for (let c = 0; c < 7; c++) uniLat[c] = freshLat[c];
            this.uniR = freshR;
            this.uniG = freshG;
            this.uniB = freshB;
            this.uniCarry = 0.0;
          }
        } else if (hasCanvasAvg) {
          const wCanvasUni = (1.0 - clampedAmount) * stretchPickupBoost * avgCanvasCa;
          const uniFresh = wFreshBase / Math.max(1e-4, wFreshBase + wCanvasUni);
          const invUF = 1.0 - uniFresh;
          for (let c = 0; c < 7; c++) {
            latEq[c] = latSamp[c] * invUF + freshLat[c] * uniFresh;
            uniLat[c] += (latEq[c] - uniLat[c]) * pickupRate;
          }
          if (partialPigment) {
            this.uniR += (avgLinR * invUF + freshR * uniFresh - this.uniR) * pickupRate;
            this.uniG += (avgLinG * invUF + freshG * uniFresh - this.uniG) * pickupRate;
            this.uniB += (avgLinB * invUF + freshB * uniFresh - this.uniB) * pickupRate;
          }
          const targetCarry = Math.min(1.0, avgCanvasCa * (1.0 - uniFresh * 0.55));
          this.uniCarry += (targetCarry - this.uniCarry) * pickupRate;
        } else if (step > 0) {
          for (let c = 0; c < 7; c++) uniLat[c] += (freshLat[c] - uniLat[c]) * recoverRate;
          if (partialPigment) {
            this.uniR += (freshR - this.uniR) * recoverRate;
            this.uniG += (freshG - this.uniG) * recoverRate;
            this.uniB += (freshB - this.uniB) * recoverRate;
          }
          this.uniCarry = Math.max(0, this.uniCarry * (1.0 - carryDecay));
        }

        const u0 = uniLat[0], u1 = uniLat[1], u2 = uniLat[2], u3 = uniLat[3], u4 = uniLat[4], u5 = uniLat[5], u6 = uniLat[6];
        for (let i = 0; i < totalTexels; i++) {
          const lo = i * 7;
          latBuf[lo] = latBuf[lo] * invU + u0 * u;
          latBuf[lo + 1] = latBuf[lo + 1] * invU + u1 * u;
          latBuf[lo + 2] = latBuf[lo + 2] * invU + u2 * u;
          latBuf[lo + 3] = latBuf[lo + 3] * invU + u3 * u;
          latBuf[lo + 4] = latBuf[lo + 4] * invU + u4 * u;
          latBuf[lo + 5] = latBuf[lo + 5] * invU + u5 * u;
          latBuf[lo + 6] = latBuf[lo + 6] * invU + u6 * u;
          if (partialPigment) {
            this.linR[i] = this.linR[i] * invU + this.uniR * u;
            this.linG[i] = this.linG[i] * invU + this.uniG * u;
            this.linB[i] = this.linB[i] * invU + this.uniB * u;
          }
          this.bufCarry[i] = this.bufCarry[i] * invU + this.uniCarry * u;
        }
      } else {
        const avgCr = hasCanvasAvg ? canvasSumR * invCa : 0;
        const avgCg = hasCanvasAvg ? canvasSumG * invCa : 0;
        const avgCb = hasCanvasAvg ? canvasSumB * invCa : 0;
        if (firstTouch) {
          if (hasCanvasAvg) {
            const wCanvasUni = (1.0 - clampedAmount) * stretchPickupBoost * avgCanvasCa;
            const uniFresh = wFreshFirst / Math.max(1e-4, wFreshFirst + wCanvasUni);
            const invUF = 1.0 - uniFresh;
            this.uniR = avgCr * invUF + freshR * uniFresh;
            this.uniG = avgCg * invUF + freshG * uniFresh;
            this.uniB = avgCb * invUF + freshB * uniFresh;
            this.uniCarry = Math.min(1.0, avgCanvasCa * (1.0 - uniFresh * 0.65));
          } else {
            this.uniR = freshR;
            this.uniG = freshG;
            this.uniB = freshB;
            this.uniCarry = 0.0;
          }
        } else if (hasCanvasAvg) {
          const wCanvasUni = (1.0 - clampedAmount) * stretchPickupBoost * avgCanvasCa;
          const uniFresh = wFreshBase / Math.max(1e-4, wFreshBase + wCanvasUni);
          const invUF = 1.0 - uniFresh;
          this.uniR += (avgCr * invUF + freshR * uniFresh - this.uniR) * pickupRate;
          this.uniG += (avgCg * invUF + freshG * uniFresh - this.uniG) * pickupRate;
          this.uniB += (avgCb * invUF + freshB * uniFresh - this.uniB) * pickupRate;
          const targetCarry = Math.min(1.0, avgCanvasCa * (1.0 - uniFresh * 0.55));
          this.uniCarry += (targetCarry - this.uniCarry) * pickupRate;
        } else if (step > 0) {
          this.uniR += (freshR - this.uniR) * recoverRate;
          this.uniG += (freshG - this.uniG) * recoverRate;
          this.uniB += (freshB - this.uniB) * recoverRate;
          this.uniCarry = Math.max(0, this.uniCarry * (1.0 - carryDecay));
        }

        sumBufR = 0;
        sumBufG = 0;
        sumBufB = 0;
        for (let i = 0; i < totalTexels; i++) {
          const r = this.bufR[i] * invU + this.uniR * u;
          const g = this.bufG[i] * invU + this.uniG * u;
          const b = this.bufB[i] * invU + this.uniB * u;
          this.bufR[i] = r;
          this.bufG[i] = g;
          this.bufB[i] = b;
          this.bufCarry[i] = this.bufCarry[i] * invU + this.uniCarry * u;
          sumBufR += r;
          sumBufG += g;
          sumBufB += b;
        }
      }
    }

    // 2. Lateral / isotropic pigment diffusion & CSP useBlur optical smoothing:
    // - When pigment mode is active, `this.latBuf` is ALREADY in 7-channel Kubelka-Munk latent space
    //   so convolution runs directly with ZERO per-dab re-encoding!
    if (!isFullFresh && blendUniformity < 0.999 && gw >= 4 && gh >= 4) {
      if (blurAmt > 0.005) {
        const passes = blurAmt >= 0.45 ? 2 : 1;
        const k = Math.min(0.34, 0.08 + blurAmt * 0.30);
        const cW = 1.0 - 2.0 * k;
        if (usePigment) {
          const latTmp = this.latTmp;
          for (let pass = 0; pass < passes; pass++) {
            for (let gy = 0; gy < gh; gy++) {
              const row = gy * gw;
              for (let gx = 0; gx < gw; gx++) {
                const i = row + gx;
                const lo = i * 7;
                const aC = this.bufA[i];
                if (aC <= 0.001) {
                  latTmp[lo] = latBuf[lo]; latTmp[lo + 1] = latBuf[lo + 1]; latTmp[lo + 2] = latBuf[lo + 2];
                  latTmp[lo + 3] = latBuf[lo + 3]; latTmp[lo + 4] = latBuf[lo + 4]; latTmp[lo + 5] = latBuf[lo + 5];
                  latTmp[lo + 6] = latBuf[lo + 6];
                  continue;
                }
                const iL = row + (gx > 0 ? gx - 1 : 0);
                const iR = row + (gx < gw - 1 ? gx + 1 : gw - 1);
                const wL = k * this.bufA[iL];
                const wC = cW * aC;
                const wR = k * this.bufA[iR];
                const wSum = wL + wC + wR;
                if (wSum > 1e-4) {
                  const invW = 1.0 / wSum;
                  const loL = iL * 7;
                  const loR = iR * 7;
                  latTmp[lo] = (latBuf[loL] * wL + latBuf[lo] * wC + latBuf[loR] * wR) * invW;
                  latTmp[lo + 1] = (latBuf[loL + 1] * wL + latBuf[lo + 1] * wC + latBuf[loR + 1] * wR) * invW;
                  latTmp[lo + 2] = (latBuf[loL + 2] * wL + latBuf[lo + 2] * wC + latBuf[loR + 2] * wR) * invW;
                  latTmp[lo + 3] = (latBuf[loL + 3] * wL + latBuf[lo + 3] * wC + latBuf[loR + 3] * wR) * invW;
                  latTmp[lo + 4] = (latBuf[loL + 4] * wL + latBuf[lo + 4] * wC + latBuf[loR + 4] * wR) * invW;
                  latTmp[lo + 5] = (latBuf[loL + 5] * wL + latBuf[lo + 5] * wC + latBuf[loR + 5] * wR) * invW;
                  latTmp[lo + 6] = (latBuf[loL + 6] * wL + latBuf[lo + 6] * wC + latBuf[loR + 6] * wR) * invW;
                } else {
                  latTmp[lo] = latBuf[lo]; latTmp[lo + 1] = latBuf[lo + 1]; latTmp[lo + 2] = latBuf[lo + 2];
                  latTmp[lo + 3] = latBuf[lo + 3]; latTmp[lo + 4] = latBuf[lo + 4]; latTmp[lo + 5] = latBuf[lo + 5];
                  latTmp[lo + 6] = latBuf[lo + 6];
                }
              }
            }
            for (let gy = 0; gy < gh; gy++) {
              const row = gy * gw;
              const rowUp = (gy > 0 ? gy - 1 : 0) * gw;
              const rowDn = (gy < gh - 1 ? gy + 1 : gh - 1) * gw;
              for (let gx = 0; gx < gw; gx++) {
                const i = row + gx;
                const lo = i * 7;
                const aC = this.bufA[i];
                if (aC <= 0.001) {
                  latBuf[lo] = latTmp[lo]; latBuf[lo + 1] = latTmp[lo + 1]; latBuf[lo + 2] = latTmp[lo + 2];
                  latBuf[lo + 3] = latTmp[lo + 3]; latBuf[lo + 4] = latTmp[lo + 4]; latBuf[lo + 5] = latTmp[lo + 5];
                  latBuf[lo + 6] = latTmp[lo + 6];
                  continue;
                }
                const iU = rowUp + gx;
                const iD = rowDn + gx;
                const wU = k * this.bufA[iU];
                const wC = cW * aC;
                const wD = k * this.bufA[iD];
                const wSum = wU + wC + wD;
                if (wSum > 1e-4) {
                  const invW = 1.0 / wSum;
                  const loU = iU * 7;
                  const loD = iD * 7;
                  latBuf[lo] = (latTmp[loU] * wU + latTmp[lo] * wC + latTmp[loD] * wD) * invW;
                  latBuf[lo + 1] = (latTmp[loU + 1] * wU + latTmp[lo + 1] * wC + latTmp[loD + 1] * wD) * invW;
                  latBuf[lo + 2] = (latTmp[loU + 2] * wU + latTmp[lo + 2] * wC + latTmp[loD + 2] * wD) * invW;
                  latBuf[lo + 3] = (latTmp[loU + 3] * wU + latTmp[lo + 3] * wC + latTmp[loD + 3] * wD) * invW;
                  latBuf[lo + 4] = (latTmp[loU + 4] * wU + latTmp[lo + 4] * wC + latTmp[loD + 4] * wD) * invW;
                  latBuf[lo + 5] = (latTmp[loU + 5] * wU + latTmp[lo + 5] * wC + latTmp[loD + 5] * wD) * invW;
                  latBuf[lo + 6] = (latTmp[loU + 6] * wU + latTmp[lo + 6] * wC + latTmp[loD + 6] * wD) * invW;
                } else {
                  latBuf[lo] = latTmp[lo]; latBuf[lo + 1] = latTmp[lo + 1]; latBuf[lo + 2] = latTmp[lo + 2];
                  latBuf[lo + 3] = latTmp[lo + 3]; latBuf[lo + 4] = latTmp[lo + 4]; latBuf[lo + 5] = latTmp[lo + 5];
                  latBuf[lo + 6] = latTmp[lo + 6];
                }
              }
            }
          }
        } else {
          for (let pass = 0; pass < passes; pass++) {
            for (let gy = 0; gy < gh; gy++) {
              const row = gy * gw;
              for (let gx = 0; gx < gw; gx++) {
                const i = row + gx;
                const aC = this.bufA[i];
                if (aC <= 0.001) {
                  this.tmpR[i] = this.bufR[i];
                  this.tmpG[i] = this.bufG[i];
                  this.tmpB[i] = this.bufB[i];
                  continue;
                }
                const iL = row + (gx > 0 ? gx - 1 : 0);
                const iR = row + (gx < gw - 1 ? gx + 1 : gw - 1);
                const wL = k * this.bufA[iL];
                const wC = cW * aC;
                const wR = k * this.bufA[iR];
                const wSum = wL + wC + wR;
                if (wSum > 1e-4) {
                  const invW = 1.0 / wSum;
                  this.tmpR[i] = (this.bufR[iL] * wL + this.bufR[i] * wC + this.bufR[iR] * wR) * invW;
                  this.tmpG[i] = (this.bufG[iL] * wL + this.bufG[i] * wC + this.bufG[iR] * wR) * invW;
                  this.tmpB[i] = (this.bufB[iL] * wL + this.bufB[i] * wC + this.bufB[iR] * wR) * invW;
                } else {
                  this.tmpR[i] = this.bufR[i];
                  this.tmpG[i] = this.bufG[i];
                  this.tmpB[i] = this.bufB[i];
                }
              }
            }
            for (let gy = 0; gy < gh; gy++) {
              const row = gy * gw;
              const rowUp = (gy > 0 ? gy - 1 : 0) * gw;
              const rowDn = (gy < gh - 1 ? gy + 1 : gh - 1) * gw;
              for (let gx = 0; gx < gw; gx++) {
                const i = row + gx;
                const aC = this.bufA[i];
                if (aC <= 0.001) {
                  this.bufR[i] = this.tmpR[i];
                  this.bufG[i] = this.tmpG[i];
                  this.bufB[i] = this.tmpB[i];
                  continue;
                }
                const iU = rowUp + gx;
                const iD = rowDn + gx;
                const wU = k * this.bufA[iU];
                const wC = cW * aC;
                const wD = k * this.bufA[iD];
                const wSum = wU + wC + wD;
                if (wSum > 1e-4) {
                  const invW = 1.0 / wSum;
                  this.bufR[i] = (this.tmpR[iU] * wU + this.tmpR[i] * wC + this.tmpR[iD] * wD) * invW;
                  this.bufG[i] = (this.tmpG[iU] * wU + this.tmpG[i] * wC + this.tmpG[iD] * wD) * invW;
                  this.bufB[i] = (this.tmpB[iU] * wU + this.tmpB[i] * wC + this.tmpB[iD] * wD) * invW;
                } else {
                  this.bufR[i] = this.tmpR[i];
                  this.bufG[i] = this.tmpG[i];
                  this.bufB[i] = this.tmpB[i];
                }
              }
            }
          }
        }
      } else if (step > 0) {
        if (isPureSmudge) {
          const diffBase = p.tipImage ? 0.014 : 0.075;
          const diff2d = diffBase * Math.min(1, step / Math.max(1, thinSpan * 0.25));
          if (diff2d > 0.003) {
            const centerW = 1.0 - 4.0 * diff2d;
            if (usePigment) {
              const latTmp = this.latTmp;
              for (let gy = 0; gy < gh; gy++) {
                const row = gy * gw;
                const rowUp = (gy > 0 ? gy - 1 : 0) * gw;
                const rowDn = (gy < gh - 1 ? gy + 1 : gh - 1) * gw;
                for (let gx = 0; gx < gw; gx++) {
                  const i = row + gx;
                  const lo = i * 7;
                  const loL = (row + (gx > 0 ? gx - 1 : 0)) * 7;
                  const loR = (row + (gx < gw - 1 ? gx + 1 : gw - 1)) * 7;
                  const loU = (rowUp + gx) * 7;
                  const loD = (rowDn + gx) * 7;
                  latTmp[lo] = latBuf[lo] * centerW + (latBuf[loL] + latBuf[loR] + latBuf[loU] + latBuf[loD]) * diff2d;
                  latTmp[lo + 1] = latBuf[lo + 1] * centerW + (latBuf[loL + 1] + latBuf[loR + 1] + latBuf[loU + 1] + latBuf[loD + 1]) * diff2d;
                  latTmp[lo + 2] = latBuf[lo + 2] * centerW + (latBuf[loL + 2] + latBuf[loR + 2] + latBuf[loU + 2] + latBuf[loD + 2]) * diff2d;
                  latTmp[lo + 3] = latBuf[lo + 3] * centerW + (latBuf[loL + 3] + latBuf[loR + 3] + latBuf[loU + 3] + latBuf[loD + 3]) * diff2d;
                  latTmp[lo + 4] = latBuf[lo + 4] * centerW + (latBuf[loL + 4] + latBuf[loR + 4] + latBuf[loU + 4] + latBuf[loD + 4]) * diff2d;
                  latTmp[lo + 5] = latBuf[lo + 5] * centerW + (latBuf[loL + 5] + latBuf[loR + 5] + latBuf[loU + 5] + latBuf[loD + 5]) * diff2d;
                  latTmp[lo + 6] = latBuf[lo + 6] * centerW + (latBuf[loL + 6] + latBuf[loR + 6] + latBuf[loU + 6] + latBuf[loD + 6]) * diff2d;
                }
              }
              latBuf.set(latTmp.subarray(0, totalTexels * 7));
            } else {
              for (let gy = 0; gy < gh; gy++) {
                const row = gy * gw;
                const rowUp = (gy > 0 ? gy - 1 : 0) * gw;
                const rowDn = (gy < gh - 1 ? gy + 1 : gh - 1) * gw;
                for (let gx = 0; gx < gw; gx++) {
                  const i = row + gx;
                  const iL = row + (gx > 0 ? gx - 1 : 0);
                  const iR = row + (gx < gw - 1 ? gx + 1 : gw - 1);
                  const iU = rowUp + gx;
                  const iD = rowDn + gx;
                  this.tmpR[i] = this.bufR[i] * centerW + (this.bufR[iL] + this.bufR[iR] + this.bufR[iU] + this.bufR[iD]) * diff2d;
                  this.tmpG[i] = this.bufG[i] * centerW + (this.bufG[iL] + this.bufG[iR] + this.bufG[iU] + this.bufG[iD]) * diff2d;
                  this.tmpB[i] = this.bufB[i] * centerW + (this.bufB[iL] + this.bufB[iR] + this.bufB[iU] + this.bufB[iD]) * diff2d;
                }
              }
              for (let i = 0; i < totalTexels; i++) {
                this.bufR[i] = this.tmpR[i];
                this.bufG[i] = this.tmpG[i];
                this.bufB[i] = this.tmpB[i];
              }
            }
          }
        } else {
          const diff = (isRunning ? 0.095 : 0.045) * Math.min(1, step / Math.max(1, thinSpan * 0.28));
          if (diff > 0.003) {
            const centerW = 1.0 - 2.0 * diff;
            const wideAlongX = p.width >= p.height;
            if (usePigment) {
              const latTmp = this.latTmp;
              if (wideAlongX) {
                for (let gy = 0; gy < gh; gy++) {
                  const row = gy * gw;
                  const firstOff = row * 7;
                  const lastOff = (row + gw - 1) * 7;
                  for (let c = 0; c < 7; c++) {
                    latTmp[firstOff + c] = latBuf[firstOff + c];
                    latTmp[lastOff + c] = latBuf[lastOff + c];
                  }
                  for (let gx = 1; gx < gw - 1; gx++) {
                    const lo = (row + gx) * 7;
                    latTmp[lo] = latBuf[lo - 7] * diff + latBuf[lo] * centerW + latBuf[lo + 7] * diff;
                    latTmp[lo + 1] = latBuf[lo - 6] * diff + latBuf[lo + 1] * centerW + latBuf[lo + 8] * diff;
                    latTmp[lo + 2] = latBuf[lo - 5] * diff + latBuf[lo + 2] * centerW + latBuf[lo + 9] * diff;
                    latTmp[lo + 3] = latBuf[lo - 4] * diff + latBuf[lo + 3] * centerW + latBuf[lo + 10] * diff;
                    latTmp[lo + 4] = latBuf[lo - 3] * diff + latBuf[lo + 4] * centerW + latBuf[lo + 11] * diff;
                    latTmp[lo + 5] = latBuf[lo - 2] * diff + latBuf[lo + 5] * centerW + latBuf[lo + 12] * diff;
                    latTmp[lo + 6] = latBuf[lo - 1] * diff + latBuf[lo + 6] * centerW + latBuf[lo + 13] * diff;
                  }
                }
              } else {
                const stride = gw * 7;
                for (let gx = 0; gx < gw; gx++) {
                  const topOff = gx * 7;
                  const botOff = ((gh - 1) * gw + gx) * 7;
                  for (let c = 0; c < 7; c++) {
                    latTmp[topOff + c] = latBuf[topOff + c];
                    latTmp[botOff + c] = latBuf[botOff + c];
                  }
                }
                for (let gy = 1; gy < gh - 1; gy++) {
                  const row = gy * gw;
                  for (let gx = 0; gx < gw; gx++) {
                    const lo = (row + gx) * 7;
                    latTmp[lo] = latBuf[lo - stride] * diff + latBuf[lo] * centerW + latBuf[lo + stride] * diff;
                    latTmp[lo + 1] = latBuf[lo - stride + 1] * diff + latBuf[lo + 1] * centerW + latBuf[lo + stride + 1] * diff;
                    latTmp[lo + 2] = latBuf[lo - stride + 2] * diff + latBuf[lo + 2] * centerW + latBuf[lo + stride + 2] * diff;
                    latTmp[lo + 3] = latBuf[lo - stride + 3] * diff + latBuf[lo + 3] * centerW + latBuf[lo + stride + 3] * diff;
                    latTmp[lo + 4] = latBuf[lo - stride + 4] * diff + latBuf[lo + 4] * centerW + latBuf[lo + stride + 4] * diff;
                    latTmp[lo + 5] = latBuf[lo - stride + 5] * diff + latBuf[lo + 5] * centerW + latBuf[lo + stride + 5] * diff;
                    latTmp[lo + 6] = latBuf[lo - stride + 6] * diff + latBuf[lo + 6] * centerW + latBuf[lo + stride + 6] * diff;
                  }
                }
              }
              latBuf.set(latTmp.subarray(0, totalTexels * 7));
            } else {
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
              for (let i = 0; i < totalTexels; i++) {
                this.bufR[i] = this.tmpR[i];
                this.bufG[i] = this.tmpG[i];
                this.bufB[i] = this.tmpB[i];
              }
            }
          }
        }
      }
    }

    // 2b. Single decode pass from 7-channel Kubelka-Munk latent buffer -> bufR/G/B (ONCE per dab!)
    if (usePigment && !isFullFresh) {
      sumBufR = 0;
      sumBufG = 0;
      sumBufB = 0;
      if (partialPigment) {
        for (let i = 0; i < totalTexels; i++) {
          if (this.bufA[i] <= 0.002) {
            this.bufR[i] = this.linR[i];
            this.bufG[i] = this.linG[i];
            this.bufB[i] = this.linB[i];
            continue;
          }
          pigmentLatentToSrgbOut(latBuf, i * 7, this.c1Scratch);
          const r = this.linR[i] + (this.c1Scratch.r - this.linR[i]) * effPigmentStrength;
          const g = this.linG[i] + (this.c1Scratch.g - this.linG[i]) * effPigmentStrength;
          const b = this.linB[i] + (this.c1Scratch.b - this.linB[i]) * effPigmentStrength;
          this.bufR[i] = r;
          this.bufG[i] = g;
          this.bufB[i] = b;
          sumBufR += r;
          sumBufG += g;
          sumBufB += b;
        }
      } else {
        for (let i = 0; i < totalTexels; i++) {
          if (this.bufA[i] <= 0.002) continue;
          pigmentLatentToSrgbOut(latBuf, i * 7, this.c1Scratch);
          const r = this.c1Scratch.r;
          const g = this.c1Scratch.g;
          const b = this.c1Scratch.b;
          this.bufR[i] = r;
          this.bufG[i] = g;
          this.bufB[i] = b;
          sumBufR += r;
          sumBufG += g;
          sumBufB += b;
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
    const tipMask = p.tipImage ? getCachedTipAlphaMask(p.tipImage) : null;
    const effectiveChord = Math.max(1.0, diamAlongStroke * 0.85);
    const nominalStep =
      step > 0
        ? Math.max(0.2, step)
        : Math.max(0.55, Math.min(effectiveChord, diamAlongStroke * spacingRatio));
    const overlapHits = Math.max(1.0, effectiveChord / nominalStep);
    // Physically account for porous sponge/chalk tips (e.g. ~22% core fill): each canvas pixel
    // is hit only `overlapHits * tipFillFactor` times, whereas solid/soft round tips have coreFill >= 0.85
    // (tipFillFactor = 1.0, completely unchanged).
    const tipFillFactor =
      tipMask && !p.adjustDensityByGap
        ? Math.max(0.18, Math.min(1.0, tipMask.coreFill / 0.785))
        : 1.0;
    const effectiveOverlapHits = Math.max(1.0, overlapHits * tipFillFactor);
    const invOverlapHits = 1.0 / effectiveOverlapHits;
    // When CSP BrushAdjustFlowByInterval is OFF, each overlapping stamp deposits freshDensity
    // without normalizing down by overlap count (use true CSP spacing overlap, not perf-clamped step).
    const spacingOverlap = 0.85 / Math.max(0.003, spacingRatio);
    const gapBoost = !p.adjustDensityByGap
      ? Math.min(14.5, Math.max(1.0, spacingOverlap))
      : 1.0;
    const baseOpticalDepth =
      freshDensity >= 0.995
        ? 12.0
        : gapBoost * freshDensity;
    // For pure CSP blenders (Amount=0, Density=0, ColorStretch>0), Color Stretch drives
    // the visible blend/smear deposition strength directly instead of collapsing to 0.
    const smudgeBlendStrength = Math.max(clampedDensity, clampedStretch);
    const smudgeOpticalDepth = isPureSmudge
      ? (1.6 + smudgeBlendStrength * 4.4) * Math.max(0.08, flowFactor)
      : 0;
    const carriedOpticalScale = flowFactor * clampedStretch * 0.65;
    const dabSalt = Math.imul((p.dabSeq ?? 0) + 1, 83492791);

    // 4. Composite crisp silhouette SDF/tip + bilinear pigment grid + hoisted per-plot paper grain
    const out = this.scratchImgData.data;
    const hNorm = Math.max(0.02, Math.min(1.0, p.hardness));
    const aaFeatherPx = p.antiAlias === 0 ? 0 : p.antiAlias === 1 ? 0.65 : p.antiAlias === 3 ? 1.65 : 1.0;
    const grainDensity = p.grainDensity ?? 0;
    const hasDirectPaper = Boolean(p.paperLumData && p.paperLumWidth && p.paperLumHeight && grainDensity > 0.005);
    const hasGrain = hasDirectPaper || Boolean(p.grainModulate && grainDensity > 0.005);
    const flipX = p.flipX < 0 ? -1 : 1;
    const flipY = p.flipY < 0 ? -1 : 1;
    const invInnerW = 1 / innerW;
    const invInnerH = 1 / innerH;
    const gwM1 = gw - 1;
    const ghM1 = gh - 1;

    // Hoist all invariant paper grain math & affine stepping OUTSIDE the inner pixel loop!
    const paperData = p.paperLumData;
    const paperW = p.paperLumWidth ?? 0;
    const paperH = p.paperLumHeight ?? 0;
    const paperPow2 = (paperW & (paperW - 1)) === 0 && (paperH & (paperH - 1)) === 0;
    const paperMaskW = paperW - 1;
    const paperMaskH = paperH - 1;
    const paperInvScale = 1.0 / Math.max(0.05, p.paperTextureScale ?? 1.0);
    const paperRotRad = ((p.paperTextureRotate ?? 0) * Math.PI) / 180;
    const paperHasRot = Math.abs(paperRotRad) > 1e-4;
    const paperCosR = paperHasRot ? Math.cos(paperRotRad) : 1;
    const paperSinR = paperHasRot ? Math.sin(paperRotRad) : 0;
    const paperInv = Boolean(p.paperTextureInverted);
    const paperEmphasize = Boolean(p.paperTextureEmphasizeDensity);
    const paperPreserve = Boolean(p.paperTexturePreserveDensity);
    const paperBright = (p.paperTextureBrightness ?? 0) / 100.0;
    const paperContrast = p.paperTextureContrast ?? 0;
    const paperCFactor =
      paperContrast !== 0 ? Math.pow(Math.max(0.05, (paperContrast + 100.0) / 100.0), 2) : 1.0;
    const paperMode = p.paperTextureMode ?? 'multiply';
    const paperModeCode =
      paperMode === 'multiply' ? 1
      : paperMode === 'compare' ? 2
      : paperMode === 'subtract' ? 3
      : paperMode === 'normal' ? 4
      : paperMode === 'overlay' ? 5
      : paperMode === 'color-burn' ? 6
      : paperMode === 'linear-burn' ? 7
      : paperMode === 'height' ? 8
      : paperMode === 'outline' ? 9
      : 1;
    const isDryPaperMode = paperModeCode === 2 || paperModeCode === 3;
    const gP = Math.max(0, Math.min(1, p.grainPressure ?? effPressure));
    const gHeavy = Math.max(0, (gP - 0.52) / 0.48);
    const gPen = Math.min(0.92, gP * 0.28 + gHeavy * gHeavy * 0.64);
    const gEffDensity = paperPreserve ? grainDensity : grainDensity * (1.0 - gPen * 0.85);
    const gCompareLow = gEffDensity * 0.68 - 0.05;
    const gCompareInvSpan = 1.0 / 0.21;
    const gSubScale = paperPreserve ? gEffDensity : gEffDensity * (1.0 - gPen * 0.5);
    const grainPackFloor = paperPreserve
      ? 0.0
      : isDryPaperMode
      ? Math.min(0.75, 0.06 + Math.max(0, (effPressure - 0.45) * 1.25))
      : 0.62;
    const grainPackSpan = 1.0 - grainPackFloor;
    const dLxDx = 2.0 * invInnerW * halfW;
    const dWxDx = dLxDx * cosA;
    const dWyDx = dLxDx * sinA;
    const lxStart = (0.5 * invInnerW - 0.5) * 2.0 * halfW;

    const tipW = tipMask ? tipMask.width : 0;
    const tipH = tipMask ? tipMask.height : 0;
    const tipAlphaBuf = tipMask ? tipMask.alpha : null;
    const tipAlphaSat = tipMask ? tipMask.alphaSat : null;
    const tipSatW = tipW + 1;
    // Use O(1) area-averaged box filtering when downsampling high-frequency tips (e.g. porous chalk/charcoal)
    // so sub-texel pores never alias into skipped-row longitudinal comb stripes.
    const useBoxDownsampleTip = Boolean(
      tipAlphaSat && (tipW > innerW * 1.25 || tipH > innerH * 1.25)
    );
    const tipLumBuf = p.isDualToneTip && tipMask ? tipMask.lum : null;
    const dualSecRgb = tipLumBuf ? parseColorToRgb(p.secondaryColor || '#ffffff') : null;
    const tipWM1 = tipW - 1;
    const tipHM1 = tipH - 1;
    const inv255 = 1 / 255;

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
      let curWx = p.x + lxStart * cosA - ly * sinA;
      let curWy = p.y + lxStart * sinA + ly * cosA;

      const fy = Math.max(0, Math.min(ghM1, vNorm * gh - 0.5));
      const gy0 = fy | 0;
      const gy1 = gy0 < ghM1 ? gy0 + 1 : ghM1;
      const ty = fy - gy0;
      const invTy = 1 - ty;
      const gRow0 = gy0 * gw;
      const gRow1 = gy1 * gw;

      // Hoist tipMask vertical bilinear rows or SAT box-filter rows per scanline
      let mRow0 = 0;
      let mRow1 = 0;
      let mfy = 0;
      let invMfy = 1;
      let satY0Off = 0;
      let satY1Off = 0;
      let satBoxH = 1;
      if (tipAlphaBuf) {
        const sv = flipY < 0 ? 1.0 - vNorm : vNorm;
        if (useBoxDownsampleTip) {
          const vLo = flipY < 0 ? Math.max(0, 1.0 - oy * invInnerH) : Math.max(0, (oy - 1) * invInnerH);
          const vHi = flipY < 0 ? Math.min(1, 1.0 - (oy - 1) * invInnerH) : Math.min(1, oy * invInnerH);
          const sy0 = Math.max(0, Math.min(tipHM1, Math.floor(vLo * tipH)));
          const sy1 = Math.max(sy0 + 1, Math.min(tipH, Math.ceil(vHi * tipH)));
          satY0Off = sy0 * tipSatW;
          satY1Off = sy1 * tipSatW;
          satBoxH = sy1 - sy0;
        }
        const tmy = Math.max(0, Math.min(tipHM1, sv * tipH - 0.5));
        const my0 = tmy | 0;
        const my1 = my0 < tipHM1 ? my0 + 1 : tipHM1;
        mfy = tmy - my0;
        invMfy = 1 - mfy;
        mRow0 = my0 * tipW;
        mRow1 = my1 * tipW;
      }

      // Clear left/right 1px transparent border
      const leftOff = rowOff << 2;
      out[leftOff] = 0;
      out[leftOff + 1] = 0;
      out[leftOff + 2] = 0;
      out[leftOff + 3] = 0;
      const rightOff = (rowOff + outW - 1) << 2;
      out[rightOff] = 0;
      out[rightOff + 1] = 0;
      out[rightOff + 2] = 0;
      out[rightOff + 3] = 0;

      for (let ox = 1; ox < outW - 1; ox++) {
        const pOff = (rowOff + ox) << 2;
        const uNorm = (ox - 0.5) * invInnerW; // [0, 1] across exact tip width
        const wx = curWx;
        const wy = curWy;
        curWx += dWxDx;
        curWy += dWyDx;

        let tipAlpha = 0;
        let tipLum = 0;
        if (tipAlphaBuf) {
          const su = flipX < 0 ? 1.0 - uNorm : uNorm;
          if (useBoxDownsampleTip && tipAlphaSat) {
            const uLo = flipX < 0 ? Math.max(0, 1.0 - ox * invInnerW) : Math.max(0, (ox - 1) * invInnerW);
            const uHi = flipX < 0 ? Math.min(1, 1.0 - (ox - 1) * invInnerW) : Math.min(1, ox * invInnerW);
            const sx0 = Math.max(0, Math.min(tipWM1, Math.floor(uLo * tipW)));
            const sx1 = Math.max(sx0 + 1, Math.min(tipW, Math.ceil(uHi * tipW)));
            const areaSum =
              tipAlphaSat[satY1Off + sx1] -
              tipAlphaSat[satY0Off + sx1] -
              tipAlphaSat[satY1Off + sx0] +
              tipAlphaSat[satY0Off + sx0];
            tipAlpha = (areaSum / ((sx1 - sx0) * satBoxH)) * inv255;
            if (tipLumBuf) {
              const tmx = Math.max(0, Math.min(tipWM1, su * tipW - 0.5));
              const mx0 = tmx | 0;
              const mx1 = mx0 < tipWM1 ? mx0 + 1 : tipWM1;
              const mfx = tmx - mx0;
              const lTop = tipLumBuf[mRow0 + mx0] + (tipLumBuf[mRow0 + mx1] - tipLumBuf[mRow0 + mx0]) * mfx;
              const lBot = tipLumBuf[mRow1 + mx0] + (tipLumBuf[mRow1 + mx1] - tipLumBuf[mRow1 + mx0]) * mfx;
              tipLum = (lTop * invMfy + lBot * mfy) * inv255;
            }
          } else {
            const tmx = Math.max(0, Math.min(tipWM1, su * tipW - 0.5));
            const mx0 = tmx | 0;
            const mx1 = mx0 < tipWM1 ? mx0 + 1 : tipWM1;
            const mfx = tmx - mx0;
            const mTop = tipAlphaBuf[mRow0 + mx0] + (tipAlphaBuf[mRow0 + mx1] - tipAlphaBuf[mRow0 + mx0]) * mfx;
            const mBot = tipAlphaBuf[mRow1 + mx0] + (tipAlphaBuf[mRow1 + mx1] - tipAlphaBuf[mRow1 + mx0]) * mfx;
            tipAlpha = (mTop * invMfy + mBot * mfy) * inv255;
            if (tipLumBuf) {
              const lTop = tipLumBuf[mRow0 + mx0] + (tipLumBuf[mRow0 + mx1] - tipLumBuf[mRow0 + mx0]) * mfx;
              const lBot = tipLumBuf[mRow1 + mx0] + (tipLumBuf[mRow1 + mx1] - tipLumBuf[mRow1 + mx0]) * mfx;
              tipLum = (lTop * invMfy + lBot * mfy) * inv255;
            }
          }
        } else {
          const nx = (uNorm - 0.5) * 2.0;
          const distSq = nx * nx + ny * ny;
          if (distSq < 1.0) {
            const dist = Math.sqrt(distSq);
            if (p.antiAlias === 0) {
              tipAlpha = 1.0;
            } else if (hNorm >= 0.98) {
              const gxH = nx / Math.max(0.5, halfW);
              const gyH = ny / Math.max(0.5, halfH);
              const gradLen = Math.sqrt(gxH * gxH + gyH * gyH);
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
          out[pOff + 3] = 0;
          continue;
        }

        let grainFactor = 1.0;
        if (hasGrain) {
          let rawGrain = 1.0;
          if (hasDirectPaper && paperData) {
            let rotX = wx;
            let rotY = wy;
            if (paperHasRot) {
              rotX = wx * paperCosR - wy * paperSinR;
              rotY = wx * paperSinR + wy * paperCosR;
            }
            const psx = rotX * paperInvScale - 0.5;
            const psy = rotY * paperInvScale - 0.5;
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
            let g = (pvTop + (pvBot - pvTop) * pty) * inv255;
            if (paperInv) g = 1.0 - g;
            if (paperEmphasize) g = Math.max(0, Math.min(1, (g - 0.5) * 2.2 + 0.35));
            if (paperBright !== 0) g += paperBright;
            if (paperContrast !== 0) g = (g - 0.5) * paperCFactor + 0.5;
            g = g <= 0 ? 0 : g >= 1 ? 1 : g;

            // Exact 9-mode CSP TextureCompositeMode math matching applyCspPaperTextureAlpha & WebGL
            let modTip = tipAlpha;
            if (paperModeCode === 1) {
              modTip = Math.max(0, Math.min(1, tipAlpha * (1.0 - gEffDensity * (1.0 - g))));
            } else if (paperModeCode === 2) {
              const contactHeight = g * (0.22 + 0.78 * tipAlpha);
              const ct = (contactHeight - gCompareLow) * gCompareInvSpan;
              const ctc = ct <= 0 ? 0 : ct >= 1 ? 1 : ct;
              modTip = Math.max(0, Math.min(1, tipAlpha * ctc * ctc * (3.0 - 2.0 * ctc)));
            } else if (paperModeCode === 3) {
              modTip = Math.max(0, Math.min(1, tipAlpha - (1.0 - g) * gSubScale));
            } else if (paperModeCode === 4) {
              const sil = tipAlpha * 4.0 >= 1.0 ? 1.0 : tipAlpha * 4.0;
              modTip = Math.max(0, Math.min(1, tipAlpha * (1.0 - gEffDensity) + g * sil * gEffDensity));
            } else if (paperModeCode === 5) {
              const dMod = tipAlpha * (1.0 - gEffDensity * 0.32 * (1.0 - g));
              const ov = dMod < 0.5 ? 2.0 * dMod * g : 1.0 - 2.0 * (1.0 - dMod) * (1.0 - g);
              modTip = Math.max(0, Math.min(1, tipAlpha + (ov - tipAlpha) * gEffDensity));
            } else if (paperModeCode === 6) {
              const burned = g <= 0.001 ? 0 : Math.max(0, 1.0 - (1.0 - tipAlpha) / g);
              modTip = Math.max(0, Math.min(1, tipAlpha + (burned - tipAlpha) * gEffDensity));
            } else if (paperModeCode === 7) {
              const burned = Math.max(0, tipAlpha + g - 1.0);
              modTip = Math.max(0, Math.min(1, tipAlpha + (burned - tipAlpha) * gEffDensity));
            } else if (paperModeCode === 8) {
              const sil = tipAlpha * 4.0 >= 1.0 ? 1.0 : tipAlpha * 4.0;
              const relief = Math.max(0, Math.min(1, (tipAlpha + g - 0.5) * 1.6)) * sil;
              modTip = Math.max(0, Math.min(1, tipAlpha * (1.0 - gEffDensity) + relief * gEffDensity));
            } else if (paperModeCode === 9) {
              const edgeFactor = 4.0 * tipAlpha * (1.0 - tipAlpha);
              modTip = Math.max(
                0,
                Math.min(1, tipAlpha * (1.0 - gEffDensity * (1.0 - g) * (0.35 + 0.65 * edgeFactor)))
              );
            }
            rawGrain = tipAlpha > 0.001 ? Math.max(0, Math.min(1, modTip / tipAlpha)) : 0;
          } else if (p.grainModulate) {
            rawGrain = p.grainModulate(wx, wy, 1.0);
          }
          grainFactor = grainPackFloor + grainPackSpan * rawGrain;
          if (grainFactor <= 0.002) {
            out[pOff + 3] = 0;
            continue;
          }
        }

        // Bilinear sample from color pickup buffer
        const fx = Math.max(0, Math.min(gwM1, uNorm * gw - 0.5));
        const gx0 = fx | 0;
        const gx1 = gx0 < gwM1 ? gx0 + 1 : gwM1;
        const tx = fx - gx0;
        const invTx = 1 - tx;
        const i00 = gRow0 + gx0;
        const i10 = gRow0 + gx1;
        const i01 = gRow1 + gx0;
        const i11 = gRow1 + gx1;
        const w00 = invTx * invTy;
        const w10 = tx * invTy;
        const w01 = invTx * ty;
        const w11 = tx * ty;

        const bA = this.bufA[i00] * w00 + this.bufA[i10] * w10 + this.bufA[i01] * w01 + this.bufA[i11] * w11;
        if (bA <= 0.002) {
          out[pOff + 3] = 0;
          continue;
        }
        let effBaseTau: number;
        if (isPureSmudge) {
          effBaseTau = smudgeOpticalDepth;
        } else if (carriedOpticalScale > 0.002) {
          const bCarry =
            this.bufCarry[i00] * w00 +
            this.bufCarry[i10] * w10 +
            this.bufCarry[i01] * w01 +
            this.bufCarry[i11] * w11;
          const carriedDensity = bCarry * carriedOpticalScale;
          effBaseTau =
            carriedDensity > freshDensity && carriedDensity > 0.002
              ? Math.max(baseOpticalDepth, gapBoost * carriedDensity)
              : baseOpticalDepth;
        } else {
          effBaseTau = baseOpticalDepth;
        }
        const localTau = effBaseTau * grainFactor * bA;
        const perStampBody = localTau > 0.0005 ? fastOneMinusExpNeg(localTau * invOverlapHits) : 0;
        const finalAlpha = tipAlpha * perStampBody;

        if (finalAlpha <= 0.001) {
          out[pOff + 3] = 0;
          continue;
        }

        let bR = this.bufR[i00] * w00 + this.bufR[i10] * w10 + this.bufR[i01] * w01 + this.bufR[i11] * w11;
        let bG = this.bufG[i00] * w00 + this.bufG[i10] * w10 + this.bufG[i01] * w01 + this.bufG[i11] * w11;
        let bB = this.bufB[i00] * w00 + this.bufB[i10] * w10 + this.bufB[i01] * w01 + this.bufB[i11] * w11;

        if (dualSecRgb) {
          bR += (dualSecRgb.r - bR) * tipLum;
          bG += (dualSecRgb.g - bG) * tipLum;
          bB += (dualSecRgb.b - bB) * tipLum;
        }

        // Deterministic sub-LSB alpha dither prevents 8-bit quantization banding across 15+ low-alpha Fade stamps
        let h = (Math.imul(ox, 73856093) ^ Math.imul(oy, 19349663) ^ dabSalt) | 0;
        h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
        const dither = ((h ^ (h >>> 13)) >>> 0) * (1 / 4294967296) - 0.5;
        const qAlpha = Math.max(0, Math.min(255, (finalAlpha * 255 + 0.5 + dither * 0.95) | 0));
        if (qAlpha === 0) {
          out[pOff + 3] = 0;
          continue;
        }

        out[pOff] = bR <= 0 ? 0 : bR >= 255 ? 255 : (bR + 0.5) | 0;
        out[pOff + 1] = bG <= 0 ? 0 : bG >= 255 ? 255 : (bG + 0.5) | 0;
        out[pOff + 2] = bB <= 0 ? 0 : bB >= 255 ? 255 : (bB + 0.5) | 0;
        out[pOff + 3] = qAlpha;
        hasVisiblePixels = true;
      }
    }

    if (!hasVisiblePixels) return null;

    this.scratchCtx.putImageData(this.scratchImgData, 0, 0);

    // 5. Trailing self-pickup deposit into LayerPixelSampler strictly behind the trailing edge
    const depositTau = isPureSmudge ? smudgeOpticalDepth : baseOpticalDepth;
    const depositBodyAlpha = depositTau > 0.0005 ? fastOneMinusExpNeg(depositTau * invOverlapHits) : 0;
    if (sampler && step > 0 && depositBodyAlpha > 0.005 && (p.dirX !== 0 || p.dirY !== 0)) {
      const trailDist = thinSpan * 0.6 + 1.25;
      const depAlphaBoost = Math.min(0.85, Math.max(depositBodyAlpha * 2.1, Math.min(0.45, depositBodyAlpha * 1.4)));
      if (p.width >= p.height) {
        const targetSamples = Math.max(4, Math.min(gw, 7));
        const sampleStride = Math.max(1, Math.floor(gw / targetSamples));
        const midRow = (gh >> 1) * gw;
        const depRad = 1;
        for (let gx = 0; gx < gw; gx += sampleStride) {
          const idx = midRow + gx;
          const a = this.bufA[idx] * depAlphaBoost;
          if (a <= 0.01) continue;
          const nx = ((gx + 0.5) * invGw - 0.5) * 2.0;
          const lx = nx * halfW;
          const depX = p.x + lx * cosA - p.dirX * trailDist;
          const depY = p.y + lx * sinA - p.dirY * trailDist;
          sampler.depositPointFast(depX, depY, depRad, this.bufR[idx], this.bufG[idx], this.bufB[idx], a, effPigmentStrength);
        }
      } else {
        const targetSamples = Math.max(4, Math.min(gh, 7));
        const sampleStride = Math.max(1, Math.floor(gh / targetSamples));
        const midCol = gw >> 1;
        const depRad = 1;
        for (let gy = 0; gy < gh; gy += sampleStride) {
          const idx = gy * gw + midCol;
          const a = this.bufA[idx] * depAlphaBoost;
          if (a <= 0.01) continue;
          const ny = ((gy + 0.5) * invGh - 0.5) * 2.0;
          const ly = ny * halfH;
          const depX = p.x - ly * sinA - p.dirX * trailDist;
          const depY = p.y + ly * cosA - p.dirY * trailDist;
          sampler.depositPointFast(depX, depY, depRad, this.bufR[idx], this.bufG[idx], this.bufB[idx], a, effPigmentStrength);
        }
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
