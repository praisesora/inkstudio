/**
 * proceduralBrushTips.ts
 * Deterministic, zero-allocation procedural 128x128 brush tip masks and 256x256 seamless
 * paper/canvas grain textures modeled after Clip Studio Paint & Photoshop physical media.
 *
 * Tips encode alpha opacity on pure white RGB so GPU/CPU tinting stays color-accurate.
 * Paper textures encode surface elevation in luminance [0..255] with opaque alpha=255.
 */

import type { BristleProfilePreset, SurfaceTextureId } from '../types/editor';

const TIP_SIZE = 128;
const HI_TIP_SIZE = 256;
const PAPER_SIZE = 256;
export const SURFACE_TEXTURE_SIZE = 1024;
/** High-DPI texel density multiplier: 2x oversampled texels per document pixel at scale=1.0 */
export const SURFACE_TEXELS_PER_PX = 2.0;

const generatedCache = new Map<string, string>();

function createPrng(seed: number): () => number {
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

function makePeriodicGrid(res: number, rand: () => number): Float32Array {
  const g = new Float32Array(res * res);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  return g;
}

/**
 * Tileable periodic Worley / cellular dome height field.
 * Models physical 3D cotton paper fiber bumps: rounded peaks with sharp recessed crevices between domes.
 */
function makeCellularDomeField(size: number, cells: number, rand: () => number): Float32Array {
  const ptsX = new Float32Array(cells * cells);
  const ptsY = new Float32Array(cells * cells);
  const ptsH = new Float32Array(cells * cells);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const idx = cy * cells + cx;
      ptsX[idx] = cx + 0.12 + rand() * 0.76;
      ptsY[idx] = cy + 0.12 + rand() * 0.76;
      ptsH[idx] = 0.76 + rand() * 0.24;
    }
  }

  const out = new Float32Array(size * size);
  const scale = cells / size;
  for (let y = 0; y < size; y++) {
    const gy = y * scale;
    const baseCy = Math.floor(gy);
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const gx = x * scale;
      const baseCx = Math.floor(gx);
      let d1 = 99;
      let d2 = 99;
      let bestH = 1.0;

      for (let oy = -1; oy <= 1; oy++) {
        let cy = baseCy + oy;
        let wrapY = 0;
        if (cy < 0) { cy += cells; wrapY = -cells; }
        else if (cy >= cells) { cy -= cells; wrapY = cells; }
        const cRow = cy * cells;

        for (let ox = -1; ox <= 1; ox++) {
          let cx = baseCx + ox;
          let wrapX = 0;
          if (cx < 0) { cx += cells; wrapX = -cells; }
          else if (cx >= cells) { cx -= cells; wrapX = cells; }
          const cIdx = cRow + cx;
          const dx = gx - (ptsX[cIdx] + wrapX);
          const dy = gy - (ptsY[cIdx] + wrapY);
          const d = dx * dx + dy * dy;
          if (d < d1) {
            d2 = d1;
            d1 = d;
            bestH = ptsH[cIdx];
          } else if (d < d2) {
            d2 = d;
          }
        }
      }

      const f1 = Math.sqrt(d1);
      const f2 = Math.sqrt(d2);
      // Combine dome elevation (1 - f1) with crisp crevice depth (f2 - f1)
      const dome = clamp01(1.0 - f1 * 1.12);
      const crevice = clamp01((f2 - f1) * 1.85);
      out[row + x] = clamp01((dome * 0.62 + crevice * 0.38) * bestH);
    }
  }
  return out;
}

function samplePeriodic(grid: Float32Array, res: number, fx: number, fy: number): number {
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
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / Math.max(1e-5, edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Helper: allocates an offscreen rectangular canvas, fills RGBA via callback, and returns a cached PNG data URL.
 */
function buildCachedRectPng(
  key: string,
  width: number,
  height: number,
  fill: (data: Uint8ClampedArray, width: number, height: number) => void
): string {
  const hit = generatedCache.get(key);
  if (hit !== undefined) return hit;

  if (typeof document === 'undefined') return '';
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.createImageData !== 'function') return '';

  const imgData = ctx.createImageData(width, height);
  fill(imgData.data, width, height);
  ctx.putImageData(imgData, 0, 0);

  const url = typeof canvas.toDataURL === 'function' ? canvas.toDataURL('image/png') : '';
  if (url) {
    generatedCache.set(key, url);
  }
  return url;
}

/**
 * Helper: allocates an offscreen square canvas, fills RGBA via callback, and returns a cached PNG data URL.
 */
function buildCachedPng(
  key: string,
  size: number,
  fill: (data: Uint8ClampedArray, size: number) => void
): string {
  return buildCachedRectPng(key, size, size, (data, w) => fill(data, w));
}

function sampleFieldBilinear(field: Float32Array, fSize: number, u: number, v: number): number {
  const mask = fSize - 1;
  const fx = u * fSize;
  const fy = v * fSize;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const ix0 = x0 & mask;
  const iy0 = y0 & mask;
  const ix1 = (ix0 + 1) & mask;
  const iy1 = (iy0 + 1) & mask;
  const r0 = iy0 * fSize;
  const r1 = iy1 * fSize;
  const top = field[r0 + ix0] + (field[r0 + ix1] - field[r0 + ix0]) * tx;
  const bot = field[r1 + ix0] + (field[r1 + ix1] - field[r1 + ix0]) * tx;
  return top + (bot - top) * ty;
}

function writeAlphaPixel(data: Uint8ClampedArray, idx: number, alpha: number): void {
  const a = Math.round(clamp01(alpha) * 255);
  if (a <= 0) return;
  data[idx] = 255;
  data[idx + 1] = 255;
  data[idx + 2] = 255;
  data[idx + 3] = a;
}

// -------------------------------------------------------------
// PEN SECTION TIPS
// -------------------------------------------------------------

/**
 * Real G-Pen (256x256, modeled directly on official CSP Real G-Pen.sut 107x133 MaterialFile):
 * Jagged, porous organic steel-nib ink silhouette with rough ink-bleed perimeter teeth
 * and 4 authentic internal white paper micro-pinholes (top-center, mid-left, mid-right, lower-center).
 */
export function generateRealGPenTip(): string {
  return buildCachedPng('tip:real-g-pen-csp-v2', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0x101a9);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const half = size * 0.5;
    // Matches CSP Real G-Pen's 107x133 (~0.805 aspect) slightly taller organic nib footprint
    const rx = size * 0.375;
    const ry = size * 0.455;

    // 4 internal organic white paper micro-pinholes matching Real G-Pen.sut's decoded nib bitmap
    const pinholes = [
      { cx: -0.055, cy: -0.34, rx: 0.085, ry: 0.125, rot: -0.36 }, // elongated upper-center pore
      { cx: -0.145, cy: -0.085, rx: 0.095, ry: 0.085, rot: 0.25 }, // mid-left rounded pore
      { cx: 0.215, cy: -0.015, rx: 0.105, ry: 0.068, rot: -0.18 }, // mid-right horizontal oval pore
      { cx: 0.045, cy: 0.195, rx: 0.092, ry: 0.098, rot: 0.48 },   // lower-center jagged pore
    ];

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const ny = dy / ry;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const nx = dx / rx;
        const dist = Math.hypot(nx, ny);
        const angle = Math.atan2(ny, nx);

        // Bold asymmetric jagged lobes + ink-bleed notches along silhouette (like real dip-pen nib on rough paper)
        const lobes =
          Math.sin(angle * 3 - 0.6) * 0.085 +
          Math.cos(angle * 5 + 1.1) * 0.078 +
          Math.sin(angle * 8 - 0.4) * 0.068 +
          Math.cos(angle * 13 + 2.3) * 0.048 +
          Math.sin(angle * 21 - 1.5) * 0.028;

        // Characteristic lower-left and upper-left ink-bite indentations seen in CSP Real G-Pen
        const biteLowerLeft =
          Math.exp(-Math.pow((angle - 2.38) * 3.8, 2)) * 0.24 +
          Math.exp(-Math.pow((angle + 1.85) * 4.5, 2)) * 0.14 +
          Math.exp(-Math.pow((angle - 0.72) * 4.2, 2)) * 0.12;

        const edgeWarp =
          (samplePeriodic(nCoarse, 16, x * 0.075, y * 0.075) - 0.5) * 0.26 +
          (samplePeriodic(nMed, 32, x * 0.17, y * 0.17) - 0.5) * 0.15 +
          (samplePeriodic(nFine, 64, x * 0.38, y * 0.38) - 0.5) * 0.07;

        const rNorm = dist / Math.max(0.25, 0.96 + lobes - biteLowerLeft + edgeWarp);
        if (rNorm >= 1.03) continue;

        // Crisp high-contrast ink edge (authentic dip-pen ink, zero soft airbrush blur)
        let alpha = 1.0 - smoothstep(0.92, 1.015, rNorm);

        // Carve the 4 jagged organic white paper pinholes inside the nib silhouette
        for (let p = 0; p < pinholes.length; p++) {
          const ph = pinholes[p];
          const pdx = nx - ph.cx;
          const pdy = ny - ph.cy;
          const c = Math.cos(ph.rot);
          const s = Math.sin(ph.rot);
          const lx = (pdx * c + pdy * s) / ph.rx;
          const ly = (-pdx * s + pdy * c) / ph.ry;
          const pWarp =
            (samplePeriodic(nMed, 32, x * 0.24 + p * 7.1, y * 0.24 + p * 3.7) - 0.5) * 0.34 +
            (samplePeriodic(nFine, 64, x * 0.55 + p * 5.3, y * 0.55) - 0.5) * 0.14;
          const pDist = Math.hypot(lx, ly) / Math.max(0.35, 1.0 + pWarp);
          if (pDist < 1.04) {
            alpha *= smoothstep(0.84, 1.02, pDist);
          }
        }

        if (alpha > 0.005) {
          writeAlphaPixel(data, row + x * 4, alpha);
        }
      }
    }
  });
}

/**
 * Rough Pen Seamless Vertical Ribbon Tip (64x512, modeled on official CSP Rough pen.sut MaterialFile):
 * Vertical ink strand along Y (which RibbonBrushEngine maps strictly along the stroke path at angle=0°)
 * with organic swells, pinches, and serrated dry-ink edges.
 * Top (y=0) and bottom (y=H-1) join at matching centered anchor width for seamless repeat and flipH/flipV alternate tiling.
 */
export function generateRoughPenRibbonTip(variant: number = 0): string {
  const vIdx = Math.max(0, Math.min(3, Math.floor(variant)));
  return buildCachedRectPng(`tip:rough-pen-ribbon-v${vIdx}`, 64, 512, (data, width, height) => {
    const rand = createPrng(0x31a07 + vIdx * 0x9e37);
    const nEdgeL = makePeriodicGrid(64, rand);
    const nEdgeR = makePeriodicGrid(64, rand);
    const nMicro = makePeriodicGrid(64, rand);
    const halfW = width * 0.5;
    const baseHalfThick = width * 0.31; // Visible ink ~62% of tile width -> exact brush size at thickness=1.5

    // Harmonic phases per variant; use cosine / sin(2*pi*k*v) so endpoints v=0 and v=1 match cleanly
    const p1 = (vIdx * 1.37) % (Math.PI * 2);
    const p2 = (vIdx * 2.51 + 0.8) % (Math.PI * 2);
    const p3 = (vIdx * 3.19 + 1.6) % (Math.PI * 2);

    for (let y = 0; y < height; y++) {
      const v = y / height; // [0, 1) periodic along stroke length
      const tau = v * Math.PI * 2;
      // Smooth window that pins the very ends (v=0, v=1) to symmetric centered width so flipH/flipV alternate tiles join seamlessly
      const seamEnvelope = Math.sin(v * Math.PI); // 0 at ends, 1 in middle
      const env = Math.pow(seamEnvelope, 0.32);

      // Organic thick/thin nib-pressure & tooth swells along the vertical strand
      const swell =
        (Math.sin(tau * 1 + p1) * 0.14 +
          Math.sin(tau * 2 + p2) * 0.11 +
          Math.sin(tau * 3 - p3) * 0.08 +
          Math.sin(tau * 5 + p1 * 1.7) * 0.055) *
        env;
      const centerWander =
        (Math.sin(tau * 1 + p2) * 0.085 + Math.sin(tau * 2 - p1) * 0.05) * width * env;

      // High-frequency serrated rough-paper ink teeth along left and right edges (periodic in y)
      const fyCoarse = v * 32;
      const fyFine = v * 64;
      const toothL =
        ((samplePeriodic(nEdgeL, 64, 4.2, fyCoarse) - 0.5) * 0.34 +
          (samplePeriodic(nEdgeL, 64, 19.7, fyFine) - 0.5) * 0.24 +
          (samplePeriodic(nMicro, 64, 33.1, fyFine * 2.0) - 0.5) * 0.14) *
        (0.35 + 0.65 * env);
      const toothR =
        ((samplePeriodic(nEdgeR, 64, 11.5, fyCoarse) - 0.5) * 0.34 +
          (samplePeriodic(nEdgeR, 64, 27.3, fyFine) - 0.5) * 0.24 +
          (samplePeriodic(nMicro, 64, 48.6, fyFine * 2.0) - 0.5) * 0.14) *
        (0.35 + 0.65 * env);

      const leftEdge = halfW + centerWander - baseHalfThick * Math.max(0.42, 1.0 + swell + toothL);
      const rightEdge = halfW + centerWander + baseHalfThick * Math.max(0.42, 1.0 + swell + toothR);
      const row = y * width * 4;

      for (let x = 0; x < width; x++) {
        const px = x + 0.5;
        if (px < leftEdge - 2.0 || px > rightEdge + 2.0) continue;

        const dLeft = px - leftEdge;
        const dRight = rightEdge - px;
        const dEdge = Math.min(dLeft, dRight);
        // Crisp 1.1px rough-ink edge feather (matches CSP Rough pen AntiAlias=1 character)
        let alpha = smoothstep(-0.55, 0.75, dEdge);

        // Occasional tiny dry-ink notch right along the outer 2px rim
        if (alpha > 0.01 && dEdge < 2.2) {
          const rimPore = samplePeriodic(nMicro, 64, x * 0.72, fyFine * 2.0);
          if (rimPore < 0.24 && dEdge < 1.25) {
            alpha *= smoothstep(0.08, 0.24, rimPore);
          }
        }

        if (alpha > 0.005) {
          writeAlphaPixel(data, row + x * 4, alpha);
        }
      }
    }
  });
}

/**
 * Textured Pen: expressive dry-ink nib with pitted organic perimeter and crisp rough edges.
 */
export function generateTexturedPenTip(): string {
  return buildCachedPng('tip:textured-pen', TIP_SIZE, (data, size) => {
    const rand = createPrng(0x202b);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const half = size * 0.5;
    const baseR = half - 6;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const dist = Math.hypot(dx, dy);

        const warp =
          (samplePeriodic(nCoarse, 16, x * 0.14, y * 0.14) - 0.5) * 0.24 +
          (samplePeriodic(nMed, 32, x * 0.32, y * 0.32) - 0.5) * 0.14;
        const rNorm = dist / (baseR * (1.0 + warp));
        if (rNorm >= 1.06) continue;

        const core = 1.0 - smoothstep(0.72, 1.03, rNorm);
        const fineGrain = samplePeriodic(nFine, 64, x * 0.65, y * 0.65);
        // Pitted dry-ink rim while keeping dense center
        const pit = rNorm > 0.58 ? smoothstep(0.24, 0.72, fineGrain + (1.0 - rNorm) * 0.85) : 1.0;
        writeAlphaPixel(data, row + x * 4, core * pit);
      }
    }
  });
}

/**
 * Calligraphy Nib: broad flat italic chisel edge (superellipse with crisp flat sides and subtle nib ink corners).
 */
export function generateCalligraphyTip(): string {
  return buildCachedPng('tip:calligraphy', TIP_SIZE, (data, size) => {
    const half = size * 0.5;
    const rx = half - 4;
    const ry = half - 4;

    for (let y = 0; y < size; y++) {
      const ny = Math.abs(y - half + 0.5) / ry;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const nx = Math.abs(x - half + 0.5) / rx;
        // Superellipse (p = 3.6) gives a crisp chisel-nib flat edge with slightly rounded ink corners
        const d = Math.pow(Math.pow(nx, 3.6) + Math.pow(ny, 3.6), 1 / 3.6);
        if (d >= 1.03) continue;
        const alpha = 1.0 - smoothstep(0.91, 1.02, d);
        writeAlphaPixel(data, row + x * 4, alpha);
      }
    }
  });
}

// -------------------------------------------------------------
// SKETCH SECTION TIPS (DRY-MEDIA GRANULAR GRAPHITE / CHARCOAL / CHALK)
// -------------------------------------------------------------

/**
 * Mechanical Pencil (0.5mm): firm polymer-graphite core — crisp edge with tight micro-graphite tooth, zero airbrush blur.
 */
export function generateMechanicalPencilTip(): string {
  return buildCachedPng('tip:mechanical-pencil', TIP_SIZE, (data, size) => {
    const rand = createPrng(0x303c);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const half = size * 0.5;
    const baseR = half - 5;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const dist = Math.hypot(dx, dy);
        const rimWarp = (samplePeriodic(nMed, 32, x * 0.35, y * 0.35) - 0.5) * 0.08;
        const rNorm = dist / (baseR * (1.0 + rimWarp));
        if (rNorm >= 1.03) continue;

        // Crisp firm rim (not a soft Gaussian falloff)
        const profile = 1.0 - smoothstep(0.82, 1.01, rNorm);
        const micro = samplePeriodic(nFine, 64, x * 0.85, y * 0.85);
        const grit = 0.78 + micro * 0.16 + rand() * 0.06;
        // Subtle crisp graphite flecks near outer edge
        const rimBreak = rNorm > 0.72 ? smoothstep(0.18, 0.65, micro + (1.0 - rNorm) * 1.1) : 1.0;
        writeAlphaPixel(data, row + x * 4, profile * grit * rimBreak);
      }
    }
  });
}

/**
 * HB/2B Pencil: sharpened wood-cased graphite core — faceted dry micro-clusters, crisp toothy rim, zero blurry halo.
 */
export function generateHb2bPencilTip(): string {
  return buildCachedPng('tip:pencil-hb-2b', TIP_SIZE, (data, size) => {
    const rand = createPrng(0x404d);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const domes = makeCellularDomeField(size, 28, rand);
    const half = size * 0.5;
    const baseR = half - 7;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      const dRow = y * size;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const dist = Math.hypot(dx * 0.94, dy * 1.06);
        const angle = Math.atan2(dy, dx);
        // Subtle asymmetric wear facet of a sharpened graphite point
        const facet = Math.sin(angle * 3 + 0.4) * 0.06 + Math.cos(angle * 5 - 1.1) * 0.04;
        const warp = (samplePeriodic(nCoarse, 16, x * 0.18, y * 0.18) - 0.5) * 0.18;
        const rNorm = dist / (baseR * (1.0 + facet + warp));
        if (rNorm >= 1.04) continue;

        const dome = domes[dRow + x];
        const grain =
          dome * 0.48 +
          samplePeriodic(nMed, 32, x * 0.45, y * 0.45) * 0.24 +
          samplePeriodic(nFine, 64, x * 0.9, y * 0.9) * 0.18 +
          rand() * 0.10;

        // Sharp granular threshold: solid graphite clusters in center, dry broken grains at rim
        const env = 1.0 - smoothstep(0.62, 1.02, rNorm);
        const cutLow = 0.14 + rNorm * 0.34;
        const cluster = smoothstep(cutLow, cutLow + 0.24, grain);
        writeAlphaPixel(data, row + x * 4, env * (0.20 + 0.80 * cluster));
      }
    }
  });
}

/**
 * 6B/8B Pencil: worn soft dark graphite lead — broad chiseled oval packed with chunky high-contrast graphite grains.
 */
export function generate6b8bPencilTip(): string {
  return buildCachedPng('tip:pencil-6b-8b', TIP_SIZE, (data, size) => {
    const rand = createPrng(0x505e);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const domes = makeCellularDomeField(size, 22, rand);
    const half = size * 0.5;
    const rx = half - 6;
    const ry = half - 14;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      const dRow = y * size;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const warp =
          (samplePeriodic(nCoarse, 16, x * 0.16, y * 0.16) - 0.5) * 0.24 +
          (samplePeriodic(nMed, 32, x * 0.36, y * 0.36) - 0.5) * 0.14;
        const nx = dx / (rx * (1.0 + warp));
        const ny = dy / (ry * (1.0 + warp));
        const rNorm = Math.hypot(nx, ny);
        if (rNorm >= 1.06) continue;

        const dome = domes[dRow + x];
        const chunk =
          dome * 0.54 +
          samplePeriodic(nMed, 32, x * 0.42, y * 0.42) * 0.28 +
          rand() * 0.18;

        const env = 1.0 - smoothstep(0.68, 1.05, rNorm);
        // Chunky high-contrast graphite clumps — crisp micro-voids inside, serrated tooth along edge
        const cutLow = 0.18 + rNorm * 0.38;
        const cluster = smoothstep(cutLow, cutLow + 0.20, chunk);
        writeAlphaPixel(data, row + x * 4, env * cluster);
      }
    }
  });
}

/**
 * Charcoal Pencil: raw dry fractured compressed carbon core + 60 crisp detached dust crumbs in outer halo.
 */
export function generateCharcoalTip(): string {
  return buildCachedPng('tip:charcoal-pencil', TIP_SIZE, (data, size) => {
    const rand = createPrng(0x606f);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const domes = makeCellularDomeField(size, 24, rand);
    const half = size * 0.5;
    const coreR = half * 0.58; // Compact jagged core leaves clear outer halo for loose crumbs/dust

    // 62 crisp irregular charcoal dust crumbs & flakes around the jagged core perimeter
    const crumbs: Array<{ x: number; y: number; rx: number; ry: number; rot: number; a: number }> = [];
    for (let i = 0; i < 62; i++) {
      const th = rand() * Math.PI * 2;
      const dist = coreR * (0.92 + Math.pow(rand(), 0.75) * 0.72);
      const baseCrumbR = 0.9 + Math.pow(rand(), 1.6) * 3.1;
      crumbs.push({
        x: half + Math.cos(th) * dist,
        y: half + Math.sin(th) * dist,
        rx: baseCrumbR * (0.7 + rand() * 0.7),
        ry: baseCrumbR * (0.7 + rand() * 0.7),
        rot: rand() * Math.PI,
        a: 0.45 + rand() * 0.55,
      });
    }

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      const dRow = y * size;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const dist = Math.hypot(dx * 0.88, dy * 1.12);
        const angle = Math.atan2(dy, dx);

        // Angular broken-stone charcoal silhouette
        const jagged =
          Math.sin(angle * 3 + 0.5) * 0.16 +
          Math.cos(angle * 5 - 1.2) * 0.12 +
          Math.sin(angle * 9 + 0.7) * 0.09 +
          Math.cos(angle * 15 - 0.4) * 0.05;
        const rockWarp =
          (samplePeriodic(nCoarse, 16, x * 0.18, y * 0.18) - 0.5) * 0.36 +
          (samplePeriodic(nMed, 32, x * 0.40, y * 0.40) - 0.5) * 0.22;

        const rNorm = dist / (coreR * (1.0 + jagged + rockWarp));

        let alpha = 0;
        if (rNorm < 1.05) {
          const dome = domes[dRow + x];
          const fracture =
            dome * 0.55 +
            samplePeriodic(nMed, 32, x * 0.45, y * 0.45) * 0.28 +
            rand() * 0.17;
          const env = 1.0 - smoothstep(0.74, 1.03, rNorm);
          // Hard dry fracture cutoff — razor-dry carbon islands and jagged fissures
          const cutLow = 0.24 + rNorm * 0.36;
          alpha = env * smoothstep(cutLow, cutLow + 0.16, fracture);
        }

        // Accumulate crisp detached carbon dust crumbs along stroke edges
        for (let c = 0; c < crumbs.length; c++) {
          const cr = crumbs[c];
          const cdx = x - cr.x;
          const cdy = y - cr.y;
          if (Math.abs(cdx) > 5 || Math.abs(cdy) > 5) continue;
          const cosR = Math.cos(cr.rot);
          const sinR = Math.sin(cr.rot);
          const lx = (cdx * cosR + cdy * sinR) / cr.rx;
          const ly = (-cdx * sinR + cdy * cosR) / cr.ry;
          const cd = Math.hypot(lx, ly);
          if (cd < 1.0) {
            const ca = (1.0 - smoothstep(0.35, 1.0, cd)) * cr.a;
            if (ca > alpha) alpha = ca;
          }
        }

        writeAlphaPixel(data, row + x * 4, alpha);
      }
    }
  });
}

/**
 * Standard Chalk: dry porous rectangular-oval mineral chalk stick with crisp powdery micro-pores.
 */
export function generateChalkTip(): string {
  return buildCachedPng('tip:standard-chalk', TIP_SIZE, (data, size) => {
    const rand = createPrng(0x7071);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const domes = makeCellularDomeField(size, 26, rand);
    const half = size * 0.5;
    const rx = half - 8;
    const ry = half - 16;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      const dRow = y * size;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const warp =
          (samplePeriodic(nCoarse, 16, x * 0.16, y * 0.16) - 0.5) * 0.24 +
          (samplePeriodic(nMed, 32, x * 0.34, y * 0.34) - 0.5) * 0.14;
        const nx = Math.abs(dx) / (rx * (1.0 + warp));
        const ny = Math.abs(dy) / (ry * (1.0 + warp));
        // Flat blocky chalk stick cross-section (superellipse p = 3.0)
        const d = Math.pow(Math.pow(nx, 3.0) + Math.pow(ny, 3.0), 1 / 3.0);
        if (d >= 1.06) continue;

        const body = 1.0 - smoothstep(0.72, 1.04, d);
        const powder =
          domes[dRow + x] * 0.52 +
          samplePeriodic(nMed, 32, x * 0.42, y * 0.42) * 0.28 +
          rand() * 0.20;
        const cutLow = 0.20 + d * 0.34;
        const porous = smoothstep(cutLow, cutLow + 0.18, powder);
        writeAlphaPixel(data, row + x * 4, body * porous);
      }
    }
  });
}

// -------------------------------------------------------------
// BRUSH & BLEND SECTION TIPS (256x256 HIGH-RES PAINTERLY MEDIA)
// -------------------------------------------------------------

/**
 * Alla-Prima Oil Flat (256x256):
 * Asymmetric flat/square hog-bristle brush head engineered for effortless lost-and-found edges:
 * - Leading edge (ny < 0): razor-crisp architectural ferrule plane for eyes, jawlines & folds
 * - Trailing edge (ny > 0): softly feathered dry-bristle tufts with fine organic bristle teeth
 */
export function generateOilFlatAllaPrimaTip(): string {
  return buildCachedPng('tip:oil-flat-alla-prima-256', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0x81a1f);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const half = size * 0.5;
    const rx = size * 0.44;
    const ry = size * 0.34;

    // 44 organic hog-bristle fibers running along the flat head width for tactile ridges & trailing notches
    const numFibers = 44;
    const fiberX = new Float32Array(numFibers);
    const fiberW = new Float32Array(numFibers);
    const fiberLen = new Float32Array(numFibers);
    const fiberAmp = new Float32Array(numFibers);
    for (let i = 0; i < numFibers; i++) {
      const u = (i + 0.5) / numFibers;
      fiberX[i] = half - rx + u * (rx * 2) + (rand() - 0.5) * 3.8;
      fiberW[i] = 2.4 + rand() * 3.8;
      // Shorter outer fibers & uneven trailing bristle tips create natural lost edges
      const edgeU = Math.abs(u * 2 - 1);
      fiberLen[i] = (0.72 + rand() * 0.38) * (1.0 - edgeU * edgeU * 0.22);
      fiberAmp[i] = 0.62 + rand() * 0.38;
    }

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const ySigned = dy / ry; // -1 = crisp leading edge, +1 = feathered dry-bristle trailing edge
      const trail = clamp01((ySigned + 0.05) / 1.05); // 0 on leading half, ramps to 1 on trailing half
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const warp =
          (samplePeriodic(nCoarse, 16, x * 0.06, y * 0.06) - 0.5) * (0.045 + trail * 0.14) +
          (samplePeriodic(nMed, 32, x * 0.18, y * 0.18) - 0.5) * (0.025 + trail * 0.08);

        const nx = Math.abs(dx) / (rx * (1.0 + warp));
        const ny = Math.abs(dy) / (ry * (1.0 + warp * 0.8));
        // Architectural flat square bristle head (superellipse p = 4.6)
        const d = Math.pow(Math.pow(nx, 4.6) + Math.pow(ny, 4.6), 1 / 4.6);
        if (d >= 1.08) continue;

        // Crisp leading edge (sharp 0.90..1.00), softly feathered trailing edge (0.58..1.04)
        const edgeStart = 0.91 - trail * 0.33;
        const edgeEnd = 1.005 + trail * 0.05;
        const bodyEnv = 1.0 - smoothstep(edgeStart, edgeEnd, d);

        // Evaluate bristle striations & trailing bristle teeth
        let bristleVal = 0;
        let maxTailReach = 0.72;
        for (let f = 0; f < numFibers; f++) {
          const distX = Math.abs(x - fiberX[f]) / fiberW[f];
          if (distX < 1.0) {
            const v = (1.0 - distX * distX) * fiberAmp[f];
            if (v > bristleVal) {
              bristleVal = v;
              maxTailReach = fiberLen[f];
            }
          }
        }

        const fineStreak = samplePeriodic(nFine, 64, x * 0.42, y * 0.14);
        let alpha: number;
        if (trail < 0.08) {
          // Leading architectural plane: crisp opaque edge with subtle oil-bristle tooth
          const tooth = 0.86 + 0.14 * (bristleVal * 0.65 + fineStreak * 0.35);
          alpha = bodyEnv * tooth;
        } else {
          // Trailing half transitions smoothly into individual separated hog bristles
          const tailCut = 1.0 - smoothstep(maxTailReach * 0.72, maxTailReach * 1.06, ySigned);
          const fiberMask = smoothstep(0.10 + trail * 0.28, 0.58 + trail * 0.24, bristleVal * 0.72 + fineStreak * 0.28);
          const coreBridge = (1.0 - trail) * 0.92;
          alpha = bodyEnv * Math.max(coreBridge, fiberMask * tailCut * (0.78 + 0.22 * fineStreak));
        }

        if (alpha > 0.004) {
          writeAlphaPixel(data, row + x * 4, clamp01(alpha * 1.06));
        }
      }
    }
  });
}

/**
 * Loaded Impasto Oil Filbert (256x256):
 * Chiseled multi-tuft hog-bristle filbert with ~36 bold clumped bristle ridges aligned along X
 * (so directional angle dynamics drag lush parallel impasto oil ridges along curves).
 */
export function generateImpastoFilbertTip(): string {
  return buildCachedPng('tip:thick-oil-impasto-256', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0x9093c);
    const half = size * 0.5;
    const rx = size * 0.44;
    const ry = size * 0.35;

    // 10 organic clump attractors + 38 individual hog bristles grouped into bold painterly tufts
    const numClumps = 10;
    const clumpY = new Float32Array(numClumps);
    for (let c = 0; c < numClumps; c++) {
      clumpY[c] = half - ry * 0.92 + ((c + 0.5) / numClumps) * (ry * 1.84) + (rand() - 0.5) * 6.0;
    }

    const numRidges = 38;
    const ridgeCenters = new Float32Array(numRidges);
    const ridgeWidths = new Float32Array(numRidges);
    const ridgePower = new Float32Array(numRidges);
    const ridgeReach = new Float32Array(numRidges);
    for (let i = 0; i < numRidges; i++) {
      const u = (i + 0.5) / numRidges;
      const rawY = half - ry + u * (ry * 2);
      // Pull slightly toward nearest clump center
      let bestC = rawY;
      let bestD = 9999;
      for (let c = 0; c < numClumps; c++) {
        const d = Math.abs(rawY - clumpY[c]);
        if (d < bestD) {
          bestD = d;
          bestC = clumpY[c];
        }
      }
      ridgeCenters[i] = rawY + (bestC - rawY) * 0.36 + (rand() - 0.5) * 3.2;
      ridgeWidths[i] = 3.2 + rand() * 5.2;
      ridgePower[i] = 0.54 + rand() * 0.46;
      ridgeReach[i] = 0.80 + rand() * 0.24;
    }

    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const nx = Math.abs(dx) / rx;
        const ny = Math.abs(dy) / ry;
        // Rounded filbert profile (superellipse p = 2.8)
        const d = Math.pow(Math.pow(nx, 2.8) + Math.pow(ny, 2.8), 1 / 2.8);
        if (d >= 1.07) continue;

        let ridgeVal = 0;
        let localReach = 0.92;
        for (let r = 0; r < numRidges; r++) {
          const distY = Math.abs(y - ridgeCenters[r]) / ridgeWidths[r];
          if (distY < 1.0) {
            const v = (1.0 - distY * distY) * ridgePower[r];
            if (v > ridgeVal) {
              ridgeVal = v;
              localReach = ridgeReach[r];
            }
          }
        }

        const tipNoise = samplePeriodic(nMed, 32, x * 0.08, y * 0.28);
        const fineGrain = samplePeriodic(nFine, 64, x * 0.18, y * 0.55);
        const edgeMask = 1.0 - smoothstep(localReach * 0.78 - tipNoise * 0.14, localReach * 1.04, d);
        const body = 0.38 + 0.62 * (ridgeVal * 0.82 + fineGrain * 0.18);
        const alpha = clamp01(body * edgeMask * 1.16);
        if (alpha > 0.004) {
          writeAlphaPixel(data, row + x * 4, alpha);
        }
      }
    }
  });
}

/**
 * Dry Bristle Rake (256x256):
 * Organic multi-tuft separated bristle rake with irregular varied-width bristle clusters,
 * delicate stray outer hairs, and genuine airy transparent gaps between tufts (NOT uniform comb teeth).
 * Oriented along X so `customTipAngleDynamics: 'direction'` pulls expressive dry scratches & highlights.
 */
export function generateDryBristleRakePaintTip(): string {
  return buildCachedPng('tip:dry-bristle-rake-paint-256', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0x9a4e7);
    const half = size * 0.5;
    const rx = size * 0.44;
    const ry = size * 0.43;
    const nFine = makePeriodicGrid(64, rand);

    // 18 organic varied bristle tufts (mix of chunky 3-hair clumps + fine isolated stray bristles)
    interface RakeTuft {
      cy: number;
      ry: number;
      rx: number;
      cx: number;
      strength: number;
    }
    const tufts: RakeTuft[] = [];
    // Deliberately irregular spacing & grouping across the vertical brush height
    const anchors = [
      -0.91, -0.82, -0.69, -0.62, -0.49, -0.37, -0.31, -0.19, -0.08,
       0.02,  0.14,  0.21,  0.34,  0.46,  0.54,  0.68,  0.79,  0.90,
    ];
    for (let i = 0; i < anchors.length; i++) {
      const u = anchors[i] + (rand() - 0.5) * 0.035;
      const absU = Math.abs(u);
      const isStrayHair = i === 0 || i === 3 || i === 6 || i === 11 || i === 14 || i === 17;
      const arch = Math.sqrt(Math.max(0.28, 1.0 - absU * absU * 0.52));
      const tRy = isStrayHair ? 2.2 + rand() * 2.2 : 4.2 + rand() * 5.2;
      const tRx = rx * (0.62 + rand() * 0.36) * arch;
      const tCx = half + (rand() - 0.5) * rx * 0.24;
      const tCy = half + u * ry;
      tufts.push({
        cx: tCx,
        cy: tCy,
        rx: tRx,
        ry: tRy,
        strength: isStrayHair ? 0.65 + rand() * 0.30 : 0.80 + rand() * 0.20,
      });
      // Add secondary sub-bristle tucked beside major tufts for authentic clumped hog-hair feel
      if (!isStrayHair && rand() > 0.35) {
        tufts.push({
          cx: tCx + (rand() - 0.5) * 14,
          cy: tCy + (rand() > 0.5 ? 1 : -1) * (tRy * 0.85 + 1.5),
          rx: tRx * (0.68 + rand() * 0.24),
          ry: 1.8 + rand() * 2.2,
          strength: 0.55 + rand() * 0.35,
        });
      }
    }

    for (let y = 0; y < size; y++) {
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        let accum = 0;
        for (let i = 0; i < tufts.length; i++) {
          const t = tufts[i];
          const dy = Math.abs(y - t.cy);
          if (dy > t.ry * 1.15) continue;
          const dx = Math.abs(x - t.cx);
          if (dx > t.rx * 1.1) continue;
          const nx = dx / t.rx;
          const ny = dy / t.ry;
          const d = Math.pow(nx * nx * nx + ny * ny * ny, 1 / 3);
          if (d < 1.0) {
            const v = (1.0 - smoothstep(0.45, 1.0, d)) * t.strength;
            if (v > accum) accum = v;
          }
        }
        if (accum > 0.01) {
          const dryTooth = 0.78 + 0.22 * samplePeriodic(nFine, 64, x * 0.22, y * 0.65);
          writeAlphaPixel(data, row + x * 4, clamp01(accum * dryTooth));
        }
      }
    }
  });
}

/**
 * Concept Matte Chalk / Gouache Tip (256x256):
 * Upgraded high-res hand-chipped flat rectangular chalk/gouache block with a razor-crisp
 * architectural leading chisel edge, dense creamy matte core, and subtle chipped mineral trailing edge.
 */
export function generateConceptMatteChalkTip(): string {
  return buildCachedPng('tip:concept-matte-chalk-256', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0xa4c89);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const domes = makeCellularDomeField(128, 44, rand);
    const half = size * 0.5;
    const rx = size * 0.45;
    const ry = size * 0.38;

    const flecks: Array<{ x: number; y: number; r: number; a: number }> = [];
    for (let i = 0; i < 18; i++) {
      const fx = half + (rand() * 2 - 1) * rx * 0.92;
      const fy = half + ry * (0.91 + rand() * 0.14);
      flecks.push({
        x: fx,
        y: fy,
        r: 1.2 + rand() * 2.0,
        a: 0.20 + rand() * 0.34,
      });
    }

    const invSize = 1 / size;
    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const ySigned = dy / ry;
      const trailFactor = clamp01((ySigned + 0.15) * 0.8);
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const edgeRough = 0.058 + trailFactor * 0.095;
        const warp =
          (samplePeriodic(nCoarse, 16, x * 0.07, y * 0.07) - 0.5) * edgeRough * 1.35 +
          (samplePeriodic(nMed, 32, x * 0.17, y * 0.17) - 0.5) * edgeRough * 0.75;

        const nx = Math.abs(dx) / (rx * (1.0 + warp));
        const ny = Math.abs(dy) / (ry * (1.0 + warp * 0.85));
        const d = Math.pow(Math.pow(nx, 5.0) + Math.pow(ny, 5.0), 1 / 5.0);

        let alpha = 0;
        if (d < 1.04) {
          const edgeStart = 0.89 - trailFactor * 0.15;
          const edgeEnd = 1.01 + trailFactor * 0.025;
          const env = 1.0 - smoothstep(edgeStart, edgeEnd, d);

          const dome = sampleFieldBilinear(domes, 128, x * invSize, y * invSize);
          const dragStreak = samplePeriodic(nMed, 32, x * 0.045, y * 0.28);
          const finePowder = samplePeriodic(nFine, 64, x * 0.38, y * 0.38);
          const mineral = dome * 0.36 + dragStreak * 0.34 + finePowder * 0.22 + rand() * 0.08;

          const rimDryness = smoothstep(0.58, 1.0, d) * 0.30 + trailFactor * 0.11;
          const cutLow = 0.05 + rimDryness;
          const chalkBody = smoothstep(cutLow, cutLow + 0.25, mineral);
          const coreFloor = (1.0 - smoothstep(0.70, 0.97, d)) * (0.92 - trailFactor * 0.20);
          alpha = env * Math.max(coreFloor, chalkBody * (0.88 + 0.12 * dragStreak));
        }

        for (let f = 0; f < flecks.length; f++) {
          const fl = flecks[f];
          const fdx = x - fl.x;
          const fdy = y - fl.y;
          if (Math.abs(fdx) > 5.0 || Math.abs(fdy) > 5.0) continue;
          const fd = Math.hypot(fdx, fdy) / fl.r;
          if (fd < 1.0) {
            const fa = (1.0 - smoothstep(0.25, 1.0, fd)) * fl.a;
            if (fa > alpha) alpha = fa;
          }
        }

        if (alpha > 0.004) {
          writeAlphaPixel(data, row + x * 4, alpha);
        }
      }
    }
  });
}

/**
 * Mineral Grain Dual Brush Tip (256x256):
 * Isotropic porous mineral chalk/gouache modulation mask designed for Dual Brush `multiply`
 * blending — injects velvety matte non-repeating tooth into sculptural concept-art strokes
 * without weakening core opacity.
 */
export function generateMineralGrainDualTip(): string {
  return buildCachedPng('tip:mineral-grain-dual-256', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0xcd773);
    const domes = makeCellularDomeField(128, 38, rand);
    const nFine = makePeriodicGrid(64, rand);
    const half = size * 0.5;
    const rad = size * 0.48;
    const invSize = 1 / size;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const rNorm = Math.hypot(dx, dy) / rad;
        if (rNorm >= 1.0) continue;

        const env = 1.0 - smoothstep(0.76, 1.0, rNorm);
        const dome = sampleFieldBilinear(domes, 128, x * invSize, y * invSize);
        const fine = samplePeriodic(nFine, 64, x * 0.42, y * 0.42);
        const mineral = dome * 0.58 + fine * 0.30 + rand() * 0.12;
        // High baseline density (~0.45..1.0) with crisp micro-pores so multiply stays rich & velvety
        const tooth = 0.38 + 0.62 * smoothstep(0.18, 0.72, mineral);
        writeAlphaPixel(data, row + x * 4, env * tooth);
      }
    }
  });
}

/**
 * Silky Portrait Round (256x256):
 * Subtly organic soft-core oval inspired by CSP Dense/Smooth Watercolor and pro portrait rounds:
 * lush creamy interior with gentle cosine edge (hardness ~0.72) and ultra-delicate rim micro-tooth
 * so skin, rose petals, and luminous rendering never look sterile or plastic.
 */
export function generateSilkyPortraitRoundTip(): string {
  return buildCachedPng('tip:silky-portrait-round-256', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0x51a72);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const half = size * 0.5;
    const rx = size * 0.46;
    const ry = size * 0.43;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const warp = (samplePeriodic(nMed, 32, x * 0.08, y * 0.08) - 0.5) * 0.065;
        const rNorm = Math.hypot(dx / (rx * (1.0 + warp)), dy / (ry * (1.0 + warp)));
        if (rNorm >= 1.0) continue;

        // Lush solid core up to 0.56, then silky smooth cosine roll-off to 1.0
        let alpha = 1.0;
        if (rNorm > 0.56) {
          const t = (rNorm - 0.56) / 0.44;
          alpha = 0.5 * (1.0 + Math.cos(t * Math.PI));
        }
        // Ultra-delicate painterly rim micro-tooth ONLY along the outer falloff (core remains silky smooth)
        if (rNorm > 0.62) {
          const rimFactor = smoothstep(0.62, 0.96, rNorm);
          const fine = samplePeriodic(nFine, 64, x * 0.34, y * 0.34);
          alpha *= 1.0 - rimFactor * 0.16 * (1.0 - fine);
        }
        if (alpha > 0.004) {
          writeAlphaPixel(data, row + x * 4, alpha);
        }
      }
    }
  });
}

/**
 * Canvas Scumble / Old Master Multi-Tip Variants (256x256 x 4):
 * Irregular fractured dry-oil hog-bristle daubs with broken paint islands & porous pockets
 * for Sargent/Old Master broken-color tweed, umber grounds, and canvas patina.
 */
export function generateCanvasScumbleSubTip(variant: number = 0): string {
  const vIdx = ((Math.floor(variant) % 4) + 4) % 4;
  return buildCachedPng(`tip:canvas-scumble-256-v${vIdx}`, HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0x6c0b1 + vIdx * 0x4f1bb);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const domes = makeCellularDomeField(128, 28 + vIdx * 3, rand);
    const half = size * 0.5;
    const rx = size * (0.42 + (vIdx % 2) * 0.03);
    const ry = size * (0.37 + ((vIdx + 1) % 2) * 0.04);
    const invSize = 1 / size;

    // 4-6 organic dry-bristle sub-blobs per variant to break up circular symmetry completely
    const blobs: Array<{ x: number; y: number; rx: number; ry: number; rot: number; w: number }> = [];
    for (let i = 0; i < 6; i++) {
      const th = (i / 6) * Math.PI * 2 + rand() * 0.9;
      const dist = (0.12 + rand() * 0.34) * rx;
      blobs.push({
        x: half + Math.cos(th) * dist,
        y: half + Math.sin(th) * dist * 0.85,
        rx: rx * (0.36 + rand() * 0.32),
        ry: ry * (0.34 + rand() * 0.30),
        rot: rand() * Math.PI,
        w: 0.65 + rand() * 0.35,
      });
    }

    for (let y = 0; y < size; y++) {
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        let shape = 0;
        for (let b = 0; b < blobs.length; b++) {
          const bl = blobs[b];
          const bdx = x - bl.x;
          const bdy = y - bl.y;
          const c = Math.cos(bl.rot);
          const s = Math.sin(bl.rot);
          const lx = (bdx * c + bdy * s) / bl.rx;
          const ly = (-bdx * s + bdy * c) / bl.ry;
          const d = Math.hypot(lx, ly);
          if (d < 1.05) {
            const v = (1.0 - smoothstep(0.42, 1.03, d)) * bl.w;
            if (v > shape) shape = v;
          }
        }
        if (shape <= 0.01) continue;

        const coarse = samplePeriodic(nCoarse, 16, x * 0.065, y * 0.065);
        const med = samplePeriodic(nMed, 32, x * 0.16, y * 0.16);
        const fine = samplePeriodic(nFine, 64, x * 0.36, y * 0.36);
        const dome = sampleFieldBilinear(domes, 128, x * invSize, y * invSize);
        const scumbleField = dome * 0.38 + coarse * 0.24 + med * 0.24 + fine * 0.14;

        // Dry broken-oil paint islands: patchy pockets throughout, feathering into open speckles near edge
        const cutLow = 0.20 + (1.0 - shape) * 0.44;
        const paintIsland = smoothstep(cutLow, cutLow + 0.26, scumbleField);
        const alpha = shape * paintIsland;
        if (alpha > 0.005) {
          writeAlphaPixel(data, row + x * 4, alpha);
        }
      }
    }
  });
}

/**
 * Atmospheric Grain Shader Tip (256x256):
 * Silky cosine-feathered mineral-cloud stipple tip (organic cellular micro-clusters + fine film grain,
 * zero harsh digital white-noise static) for dusty skies, misty backgrounds, and painterly atmosphere.
 */
export function generateAtmosphericGrainTip(): string {
  return buildCachedPng('tip:atmospheric-grain-256', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0xb0b5e);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const domes = makeCellularDomeField(128, 52, rand);
    const half = size * 0.5;
    const radius = half - 4;
    const invSize = 1 / size;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const rNorm = Math.hypot(dx, dy) / radius;
        if (rNorm >= 1.0) continue;

        const env = Math.pow(0.5 * (1.0 + Math.cos(rNorm * Math.PI)), 1.35);
        const dome = sampleFieldBilinear(domes, 128, x * invSize, y * invSize);
        const cloud = samplePeriodic(nMed, 32, x * 0.11, y * 0.11);
        const fine = samplePeriodic(nFine, 64, x * 0.45, y * 0.45);
        // Organic mineral mist: blended cellular domes + soft cloud modulation (no raw pixel static!)
        const organicGrain = dome * 0.48 + fine * 0.34 + cloud * 0.18;
        const stipple = smoothstep(0.46 - env * 0.34, 0.80 - env * 0.22, organicGrain);
        const alpha = env * (0.28 + 0.72 * stipple);
        if (alpha > 0.004) {
          writeAlphaPixel(data, row + x * 4, alpha);
        }
      }
    }
  });
}

/**
 * Detail & Specular Liner Filbert Tip (256x256):
 * Compact springy tapered sable detail filbert — crisp opaque core for gold filigree,
 * eyelashes, tear glints, and luminous water droplets over blended paint.
 */
export function generateDetailFilbertTip(): string {
  return buildCachedPng('tip:fine-detail-filbert-256', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0x7d3a1);
    const nFine = makePeriodicGrid(64, rand);
    const half = size * 0.5;
    const rx = size * 0.45;
    const ry = size * 0.37;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const nx = dx / rx;
        // Slight pointed sable-liner taper toward +X tip
        const taper = 1.0 - Math.max(0, nx) * 0.18;
        const ny = dy / (ry * Math.max(0.45, taper));
        const d = Math.hypot(nx, ny);
        if (d >= 1.02) continue;

        let alpha = 1.0 - smoothstep(0.84, 1.01, d);
        if (d > 0.78) {
          const fine = samplePeriodic(nFine, 64, x * 0.32, y * 0.32);
          alpha *= 0.90 + 0.10 * fine;
        }
        if (alpha > 0.004) {
          writeAlphaPixel(data, row + x * 4, alpha);
        }
      }
    }
  });
}

/**
 * Oil Bristle Smudge Blender Tip (256x256):
 * Directional flat multi-bristle oil smudger (~34 soft-tipped parallel hog bristles aligned along X)
 * that blends & pulls wet oil paint while keeping lively brushwork alive.
 */
export function generateBlendOilBristleTip(): string {
  return buildCachedPng('tip:blend-oil-bristle-256', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0xd10b3);
    const half = size * 0.5;
    const rx = size * 0.45;
    const ry = size * 0.36;
    const nFine = makePeriodicGrid(64, rand);

    const numBristles = 34;
    const bY = new Float32Array(numBristles);
    const bW = new Float32Array(numBristles);
    const bStr = new Float32Array(numBristles);
    const bLen = new Float32Array(numBristles);
    for (let i = 0; i < numBristles; i++) {
      const u = (i + 0.5) / numBristles;
      const signedU = u * 2 - 1;
      bY[i] = half + signedU * ry * 0.94 + (rand() - 0.5) * 3.0;
      bW[i] = 3.2 + rand() * 4.4;
      bStr[i] = 0.58 + rand() * 0.42;
      bLen[i] = (0.76 + rand() * 0.24) * Math.sqrt(Math.max(0.35, 1.0 - signedU * signedU * 0.45));
    }

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const nx = Math.abs(dx) / rx;
        const ny = Math.abs(dy) / ry;
        const d = Math.pow(Math.pow(nx, 2.4) + Math.pow(ny, 2.4), 1 / 2.4);
        if (d >= 1.04) continue;

        let bristle = 0;
        let reach = 0.85;
        for (let i = 0; i < numBristles; i++) {
          const distY = Math.abs(y - bY[i]) / bW[i];
          if (distY < 1.0) {
            const v = (1.0 - distY * distY) * bStr[i];
            if (v > bristle) {
              bristle = v;
              reach = bLen[i];
            }
          }
        }
        // Feathered front/back ends so smudge strokes melt smoothly without hard oval stamp rings
        const envX = 1.0 - smoothstep(reach * 0.34, reach * 1.02, nx);
        const envY = 1.0 - smoothstep(0.68, 1.02, ny);
        const streak = 0.80 + 0.20 * samplePeriodic(nFine, 64, x * 0.14, y * 0.52);
        const alpha = envX * envY * (0.28 + 0.72 * bristle) * streak;
        if (alpha > 0.004) {
          writeAlphaPixel(data, row + x * 4, alpha);
        }
      }
    }
  });
}

/**
 * Matte Chalk Blender Tip (256x256):
 * Upgraded high-res wide feathered matte chalk-pad smudger with fine directional drag filaments
 * and velvety mineral pores so hard concept-art planes melt cleanly while retaining dry tooth.
 */
export function generateBlendMatteChalkTip(): string {
  return buildCachedPng('tip:blend-matte-chalk-256', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0xb7d98);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const domes = makeCellularDomeField(128, 44, rand);
    const half = size * 0.5;
    const rx = size * 0.46;
    const ry = size * 0.40;
    const invSize = 1 / size;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const warp =
          (samplePeriodic(nCoarse, 16, x * 0.07, y * 0.07) - 0.5) * 0.16 +
          (samplePeriodic(nMed, 32, x * 0.15, y * 0.15) - 0.5) * 0.07;
        const nx = Math.abs(dx) / (rx * (1.0 + warp));
        const ny = Math.abs(dy) / (ry * (1.0 + warp));
        const d = Math.pow(Math.pow(nx, 2.6) + Math.pow(ny, 2.6), 1 / 2.6);
        if (d >= 1.04) continue;

        const env = Math.pow(1.0 - smoothstep(0.24, 1.02, d), 1.12);
        const filaments = samplePeriodic(nMed, 32, x * 0.05, y * 0.34);
        const dome = sampleFieldBilinear(domes, 128, x * invSize, y * invSize);
        const fine = samplePeriodic(nFine, 64, x * 0.40, y * 0.40);
        const powdery = dome * 0.32 + filaments * 0.42 + fine * 0.18 + rand() * 0.08;

        const outerFade = smoothstep(0.38, 1.0, d);
        const grainMod =
          0.74 * (1.0 - outerFade * 0.52) +
          smoothstep(0.14 + outerFade * 0.20, 0.68 + outerFade * 0.18, powdery) * (0.26 + outerFade * 0.52);
        const alpha = env * grainMod;
        if (alpha > 0.004) {
          writeAlphaPixel(data, row + x * 4, alpha);
        }
      }
    }
  });
}

/**
 * Rake Hair & Fur Smear Blender Tip (256x256):
 * Fine separated multi-strand rake blender (CSP Fur/Hair Blend equivalent):
 * ~24 razor-fine organic hair/fur filaments with varied thicknesses and crisp airy gaps
 * aligned along X for wispy hair, horse mane/tail, feathers, and expressive edge breakup.
 */
export function generateBlendRakeHairTip(): string {
  return buildCachedPng('tip:blend-rake-hair-256', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0xe37c4);
    const half = size * 0.5;
    const rx = size * 0.46;
    const ry = size * 0.44;

    interface Strand {
      cx: number;
      cy: number;
      rx: number;
      ry: number;
      strength: number;
    }
    const strands: Strand[] = [];
    const count = 24;
    for (let i = 0; i < count; i++) {
      const u = (i / (count - 1)) * 2 - 1;
      // Organic clumped hair/fur spacing with fine air channels between filaments
      const jitterU = u + (rand() - 0.5) * 0.055;
      const arch = Math.sqrt(Math.max(0.24, 1.0 - jitterU * jitterU * 0.62));
      const isFine = (i % 3) === 0;
      strands.push({
        cx: half + (rand() - 0.5) * rx * 0.28,
        cy: half + jitterU * ry * 0.94,
        rx: rx * (0.58 + rand() * 0.38) * arch,
        ry: isFine ? 1.5 + rand() * 1.4 : 2.5 + rand() * 2.4,
        strength: isFine ? 0.65 + rand() * 0.30 : 0.80 + rand() * 0.20,
      });
    }

    for (let y = 0; y < size; y++) {
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        let accum = 0;
        for (let i = 0; i < strands.length; i++) {
          const st = strands[i];
          const dy = Math.abs(y - st.cy);
          if (dy > st.ry * 1.1) continue;
          const dx = Math.abs(x - st.cx);
          if (dx > st.rx * 1.05) continue;
          const nx = dx / st.rx;
          const ny = dy / st.ry;
          // Crisp across-strand edge (ny) with soft tapered front/back filament tips (nx)
          const crossEnv = 1.0 - smoothstep(0.35, 1.0, ny);
          const alongEnv = 1.0 - smoothstep(0.22, 1.0, nx);
          const v = crossEnv * alongEnv * st.strength;
          if (v > accum) accum = v;
        }
        if (accum > 0.006) {
          writeAlphaPixel(data, row + x * 4, accum);
        }
      }
    }
  });
}

/**
 * Canvas Scumble Melter Blender Tip (256x256):
 * Porous irregular dry-bristle blender with feathered edges and open dry-paint pockets
 * that dissolves hard edges into authentic Belgian linen canvas grain instead of digital blur.
 */
export function generateBlendCanvasScumbleTip(): string {
  return buildCachedPng('tip:blend-canvas-scumble-256', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0xf2a18);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const domes = makeCellularDomeField(128, 34, rand);
    const half = size * 0.5;
    const rx = size * 0.45;
    const ry = size * 0.42;
    const invSize = 1 / size;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const warp =
          (samplePeriodic(nCoarse, 16, x * 0.06, y * 0.06) - 0.5) * 0.28 +
          (samplePeriodic(nMed, 32, x * 0.14, y * 0.14) - 0.5) * 0.14;
        const rNorm = Math.hypot(dx / (rx * (1.0 + warp)), dy / (ry * (1.0 + warp)));
        if (rNorm >= 1.04) continue;

        const env = Math.pow(1.0 - smoothstep(0.22, 1.02, rNorm), 1.18);
        const dome = sampleFieldBilinear(domes, 128, x * invSize, y * invSize);
        const fine = samplePeriodic(nFine, 64, x * 0.36, y * 0.36);
        const porosity = dome * 0.52 + fine * 0.34 + rand() * 0.14;
        const pocket = smoothstep(0.16 + rNorm * 0.28, 0.56 + rNorm * 0.24, porosity);
        const alpha = env * (0.35 * (1.0 - rNorm) + 0.65 * pocket);
        if (alpha > 0.004) {
          writeAlphaPixel(data, row + x * 4, alpha);
        }
      }
    }
  });
}

/**
 * Wet Finger Tip Smudger (256x256):
 * Firm tapered rounded smudge pad with dense central pull and smooth outer rim falloff
 * for physically dragging wet paint in long expressive trails, smoke, and flowing hair.
 */
export function generateBlendFingertipTip(): string {
  return buildCachedPng('tip:blend-fingertip-256', HI_TIP_SIZE, (data, size) => {
    const rand = createPrng(0xf91c2);
    const nFine = makePeriodicGrid(64, rand);
    const half = size * 0.5;
    const rx = size * 0.45;
    const ry = size * 0.40;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const nx = dx / rx;
        // Subtle directional fingertip pad taper toward leading +X side
        const padTaper = 1.0 - Math.max(0, nx) * 0.14;
        const ny = dy / (ry * padTaper);
        const d = Math.hypot(nx, ny);
        if (d >= 1.0) continue;

        // Firm core up to 0.54 (matches hardness ~0.56) tapering smoothly to 0 at rim
        let alpha = 1.0;
        if (d > 0.54) {
          const t = (d - 0.54) / 0.46;
          alpha = 1.0 - (3 * t * t - 2 * t * t * t);
        }
        // Subtle organic fingertip drag texture near rim (prevents sterile mechanical circle smear)
        if (d > 0.48) {
          const micro = samplePeriodic(nFine, 64, x * 0.16, y * 0.36);
          alpha *= 0.92 + 0.08 * micro;
        }
        if (alpha > 0.004) {
          writeAlphaPixel(data, row + x * 4, alpha);
        }
      }
    }
  });
}

/**
 * Oil Painting Brush (legacy helper kept for backward compatibility).
 */
export function generateOilBristleTip(): string {
  return buildCachedPng('tip:oil-painting', TIP_SIZE, (data, size) => {
    const rand = createPrng(0x8082);
    const half = size * 0.5;
    const rx = half - 12;
    const ry = half - 16;

    interface Bristle {
      x: number;
      y: number;
      rx: number;
      ry: number;
      strength: number;
    }
    const bristles: Bristle[] = [];
    // Soft core fill bristles + outer perimeter strands
    for (let i = 0; i < 54; i++) {
      const th = rand() * Math.PI * 2;
      const rad = Math.sqrt(rand()) * 0.92;
      const bx = half + Math.cos(th) * rx * rad;
      const by = half + Math.sin(th) * ry * rad;
      const edgeFactor = 1.0 - rad * 0.35;
      bristles.push({
        x: bx,
        y: by,
        rx: (6.5 + rand() * 7.5) * edgeFactor,
        ry: (5.0 + rand() * 6.0) * edgeFactor,
        strength: 0.48 + rand() * 0.52,
      });
    }

    const nFine = makePeriodicGrid(64, rand);
    for (let y = 0; y < size; y++) {
      const dy = (y - half + 0.5) / (half - 6);
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = (x - half + 0.5) / (half - 6);
        const envDist = Math.hypot(dx, dy);
        if (envDist >= 1.04) continue;

        let acc = 0;
        for (let b = 0; b < bristles.length; b++) {
          const br = bristles[b];
          const bdx = (x - br.x) / br.rx;
          const bdy = (y - br.y) / br.ry;
          const d2 = bdx * bdx + bdy * bdy;
          if (d2 < 1.0) {
            const fall = 1.0 - d2;
            acc += fall * fall * br.strength;
          }
        }
        // Soft creamy oil core with distinct bristle streaks near trailing/outer edges
        const softBase = Math.pow(clamp01(1.0 - envDist), 1.3) * 0.42;
        const streak = 0.85 + samplePeriodic(nFine, 64, x * 0.25, y * 0.65) * 0.22;
        const alpha = clamp01((Math.min(1.0, acc * 0.82) + softBase) * streak) * (1.0 - smoothstep(0.82, 1.02, envDist));
        writeAlphaPixel(data, row + x * 4, alpha);
      }
    }
  });
}

/**
 * Thick Oil Painting Brush: flat filbert impasto hog-bristle head with bold chiseled bristle ridges.
 */
export function generateThickOilTip(): string {
  return buildCachedPng('tip:thick-oil', TIP_SIZE, (data, size) => {
    const rand = createPrng(0x9093);
    const half = size * 0.5;
    const rx = half - 8;
    const ry = half - 18;

    // Generate coarse parallel bristle ridges running across the flat ferrule
    const numRidges = 26;
    const ridgeCenters = new Float32Array(numRidges);
    const ridgeWidths = new Float32Array(numRidges);
    const ridgePower = new Float32Array(numRidges);
    for (let i = 0; i < numRidges; i++) {
      const u = (i + 0.5) / numRidges;
      ridgeCenters[i] = half - ry + u * (ry * 2) + (rand() - 0.5) * 2.2;
      ridgeWidths[i] = 2.0 + rand() * 3.0;
      ridgePower[i] = 0.52 + rand() * 0.48;
    }

    const nMed = makePeriodicGrid(32, rand);
    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const nx = Math.abs(dx) / rx;
        const ny = Math.abs(dy) / ry;
        const d = Math.pow(Math.pow(nx, 3.2) + Math.pow(ny, 3.2), 1 / 3.2);
        if (d >= 1.06) continue;

        let ridgeVal = 0;
        for (let r = 0; r < numRidges; r++) {
          const distY = Math.abs(y - ridgeCenters[r]) / ridgeWidths[r];
          if (distY < 1.0) {
            const v = (1.0 - distY * distY) * ridgePower[r];
            if (v > ridgeVal) ridgeVal = v;
          }
        }

        const bristleEndNoise = samplePeriodic(nMed, 32, x * 0.16, y * 0.55);
        // Slightly ragged bristle tips along leading/trailing edge (high nx)
        const edgeMask = 1.0 - smoothstep(0.76 - bristleEndNoise * 0.18, 1.04, d);
        const body = 0.42 + 0.58 * ridgeVal;
        writeAlphaPixel(data, row + x * 4, clamp01(body * edgeMask * 1.15));
      }
    }
  });
}

/**
 * Painterly Chalk Painting Brush (Concept-Art Square/Chisel Chalk):
 * Asymmetric hand-chipped flat rectangular chalk block with a crisp architectural leading edge,
 * creamy dense core, fine mineral tooth along edges, and subtle longitudinal dry-drag striations.
 */
export function generatePainterlyChalkTip(): string {
  return buildCachedPng('tip:painterly-chalk-v2', TIP_SIZE, (data, size) => {
    const rand = createPrng(0xa4c81);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const domes = makeCellularDomeField(size, 40, rand);
    const half = size * 0.5;
    const rx = half - 5;
    const ry = half - 14;

    // Sparse delicate mineral dust crumbs hugging the trailing chipped rim
    const flecks: Array<{ x: number; y: number; r: number; a: number }> = [];
    for (let i = 0; i < 14; i++) {
      const fx = half + (rand() * 2 - 1) * rx * 0.92;
      const fy = half + ry * (0.90 + rand() * 0.16);
      flecks.push({
        x: fx,
        y: fy,
        r: 0.7 + rand() * 1.15,
        a: 0.20 + rand() * 0.34,
      });
    }

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const ySigned = dy / ry; // -1 = crisp leading chisel edge, +1 = drier trailing chalk face
      const row = y * size * 4;
      const dRow = y * size;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;

        // Subtle organic chipped-chalk edge distortion (crisper leading plane, more expressive trailing edge)
        const trailFactor = clamp01((ySigned + 0.15) * 0.8);
        const edgeRough = 0.065 + trailFactor * 0.10;
        const warp =
          (samplePeriodic(nCoarse, 16, x * 0.14, y * 0.14) - 0.5) * edgeRough * 1.35 +
          (samplePeriodic(nMed, 32, x * 0.34, y * 0.34) - 0.5) * edgeRough * 0.75;

        const nx = Math.abs(dx) / (rx * (1.0 + warp));
        const ny = Math.abs(dy) / (ry * (1.0 + warp * 0.85));
        // Sculptural flat rectangular concept-art chalk block (superellipse p = 4.8)
        const d = Math.pow(Math.pow(nx, 4.8) + Math.pow(ny, 4.8), 1 / 4.8);

        let alpha = 0;
        if (d < 1.04) {
          // Asymmetric edge sharpness: clean bold architectural leading edge, softer toothy trailing edge
          const edgeStart = 0.88 - trailFactor * 0.16;
          const edgeEnd = 1.01 + trailFactor * 0.025;
          const env = 1.0 - smoothstep(edgeStart, edgeEnd, d);

          // Fine mineral chalk grain + subtle longitudinal dry-drag striations along X
          const dome = domes[dRow + x];
          const dragStreak = samplePeriodic(nMed, 32, x * 0.09, y * 0.56);
          const finePowder = samplePeriodic(nFine, 64, x * 0.78, y * 0.78);
          const mineral = dome * 0.36 + dragStreak * 0.36 + finePowder * 0.20 + rand() * 0.08;

          // Rich creamy core for solid opaque planes; crisp dry mineral breakup along rim & trailing edge
          const rimDryness = smoothstep(0.56, 1.0, d) * 0.32 + trailFactor * 0.12;
          const cutLow = 0.05 + rimDryness;
          const chalkBody = smoothstep(cutLow, cutLow + 0.26, mineral);
          const coreFloor = (1.0 - smoothstep(0.68, 0.97, d)) * (0.90 - trailFactor * 0.22);
          alpha = env * Math.max(coreFloor, chalkBody * (0.88 + 0.12 * dragStreak));
        }

        for (let f = 0; f < flecks.length; f++) {
          const fl = flecks[f];
          const fdx = x - fl.x;
          const fdy = y - fl.y;
          if (Math.abs(fdx) > 3.0 || Math.abs(fdy) > 3.0) continue;
          const fd = Math.hypot(fdx, fdy) / fl.r;
          if (fd < 1.0) {
            const fa = (1.0 - smoothstep(0.25, 1.0, fd)) * fl.a;
            if (fa > alpha) alpha = fa;
          }
        }

        writeAlphaPixel(data, row + x * 4, alpha);
      }
    }
  });
}

/**
 * Blend Chalk Brush Tip (Painterly Dry-Chalk Smudger):
 * Wide feathered organic chalk-pad head with fine parallel drag filaments and velvety matte pores
 * so blended edges melt smoothly while retaining traditional painterly chalk texture.
 */
export function generateBlendChalkTip(): string {
  return buildCachedPng('tip:blend-chalk-v2', TIP_SIZE, (data, size) => {
    const rand = createPrng(0xb7d92);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const domes = makeCellularDomeField(size, 44, rand);
    const half = size * 0.5;
    const rx = half - 5;
    const ry = half - 12;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      const dRow = y * size;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const warp =
          (samplePeriodic(nCoarse, 16, x * 0.14, y * 0.14) - 0.5) * 0.18 +
          (samplePeriodic(nMed, 32, x * 0.30, y * 0.30) - 0.5) * 0.08;
        const nx = Math.abs(dx) / (rx * (1.0 + warp));
        const ny = Math.abs(dy) / (ry * (1.0 + warp));
        const d = Math.pow(Math.pow(nx, 2.6) + Math.pow(ny, 2.6), 1 / 2.6);
        if (d >= 1.04) continue;

        // Smooth velvety feathered radial envelope (melts edges cleanly without hard stamp outlines)
        const env = Math.pow(1.0 - smoothstep(0.26, 1.02, d), 1.12);

        // Directional soft chalk-drag filaments + fine velvety mineral pores
        const filaments = samplePeriodic(nMed, 32, x * 0.10, y * 0.64);
        const dome = domes[dRow + x];
        const fine = samplePeriodic(nFine, 64, x * 0.80, y * 0.80);
        const powdery = dome * 0.32 + filaments * 0.42 + fine * 0.18 + rand() * 0.08;

        const outerFade = smoothstep(0.40, 1.0, d);
        const grainMod =
          0.72 * (1.0 - outerFade * 0.52) +
          smoothstep(0.14 + outerFade * 0.20, 0.68 + outerFade * 0.18, powdery) * (0.28 + outerFade * 0.52);
        writeAlphaPixel(data, row + x * 4, env * grainMod);
      }
    }
  });
}

/**
 * Textured Grain / Noise Shader: silky Gaussian envelope modulated by organic crisp stipple noise.
 */
export function generateNoiseShaderTip(): string {
  return buildCachedPng('tip:noise-shader', TIP_SIZE, (data, size) => {
    const rand = createPrng(0xb0b5);
    const nFine = makePeriodicGrid(64, rand);
    const half = size * 0.5;
    const radius = half - 3;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        const rNorm = Math.hypot(dx, dy) / radius;
        if (rNorm >= 1.0) continue;

        // Smooth Gaussian-like radial envelope (zero hard ring)
        const env = 0.5 * (1.0 + Math.cos(rNorm * Math.PI));
        const softEnv = Math.pow(env, 1.25);

        // Crisp stochastic film/stipple micro-dots
        const f1 = samplePeriodic(nFine, 64, x * 0.85, y * 0.85);
        const speck = rand();
        const grainVal = f1 * 0.45 + speck * 0.55;
        // Higher envelope density permits more stipple grains to fire
        const stipple = smoothstep(0.55 - softEnv * 0.48, 0.88 - softEnv * 0.25, grainVal);
        const alpha = softEnv * (0.18 + 0.82 * stipple);
        writeAlphaPixel(data, row + x * 4, alpha);
      }
    }
  });
}

// -------------------------------------------------------------
// SEAMLESS PROCEDURAL PAPER / CANVAS TEXTURES (256x256)
// -------------------------------------------------------------

/**
 * Fine Bristol / Drafting Paper (256x256):
 * Tight, crisp micro-tooth (2px-3px domes) ideal for Mechanical Pencil linework.
 */
export function generateFinePaperTexture(): string {
  return buildCachedPng('paper:fine-bristol', PAPER_SIZE, (data, size) => {
    const rand = createPrng(0xc1d2);
    const fineDomes = makeCellularDomeField(size, 96, rand);
    const gFibers = makePeriodicGrid(128, rand);

    for (let y = 0; y < size; y++) {
      const row = y * size * 4;
      const dRow = y * size;
      for (let x = 0; x < size; x++) {
        const dome = fineDomes[dRow + x];
        const fiber = samplePeriodic(gFibers, 128, x * 0.5, y * 0.5);
        const raw = dome * 0.58 + fiber * 0.26 + rand() * 0.16;
        const crisp = clamp01((raw - 0.12) / 0.76);
        const v = Math.round(crisp * 255);
        const idx = row + x * 4;
        data[idx] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
      }
    }
  });
}

/**
 * Cold-Press Cotton Sketchbook Paper (256x256):
 * Dual-scale cellular fiber domes (3.5px primary tooth + 2px micro-tooth) with crisp valley crevices.
 * Eliminates blurry cloud artifacts on HB/2B and 6B/8B pencils.
 */
export function generateSketchPaperTexture(): string {
  return buildCachedPng('paper:cold-press-sketch', PAPER_SIZE, (data, size) => {
    const rand = createPrng(0xc2e3);
    const primaryDomes = makeCellularDomeField(size, 64, rand); // ~4px pressed cotton bumps
    const microDomes = makeCellularDomeField(size, 112, rand);  // ~2.3px fine tooth
    const gUndul = makePeriodicGrid(32, rand);

    for (let y = 0; y < size; y++) {
      const row = y * size * 4;
      const dRow = y * size;
      for (let x = 0; x < size; x++) {
        const d1 = primaryDomes[dRow + x];
        const d2 = microDomes[dRow + x];
        const undul = samplePeriodic(gUndul, 32, x * 0.125, y * 0.125);
        const raw = d1 * 0.54 + d2 * 0.28 + undul * 0.10 + rand() * 0.08;
        // High-contrast peak-to-valley distribution so compare cutoff reveals crisp pores
        const crisp = clamp01((raw - 0.14) / 0.72);
        const v = Math.round(Math.pow(crisp, 1.08) * 255);
        const idx = row + x * 4;
        data[idx] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
      }
    }
  });
}

/**
 * Coarse Laid Charcoal / Pastel Paper (Canson/Ingres inspired, 256x256):
 * Coarse 5px cellular domes + crisp periodic horizontal laid ribs & vertical chain lines.
 */
export function generateCharcoalPaperTexture(): string {
  return buildCachedPng('paper:charcoal-laid', PAPER_SIZE, (data, size) => {
    const rand = createPrng(0xc0c6);
    const coarseDomes = makeCellularDomeField(size, 48, rand); // ~5.3px rugged charcoal tooth
    const fineDomes = makeCellularDomeField(size, 96, rand);

    for (let y = 0; y < size; y++) {
      const row = y * size * 4;
      const dRow = y * size;
      // Crisp Ingres laid-paper horizontal rib (period = 6.4px -> 40 cycles per 256px)
      const laidRib = Math.sin((y / size) * Math.PI * 2 * 40) * 0.13;
      for (let x = 0; x < size; x++) {
        // Subtle vertical laid chain line (8 cycles per 256px)
        const chainLine = Math.sin((x / size) * Math.PI * 2 * 8) * 0.05;
        const d1 = coarseDomes[dRow + x];
        const d2 = fineDomes[dRow + x];
        const raw = d1 * 0.56 + d2 * 0.26 + rand() * 0.12 + laidRib + chainLine;
        const highContrast = clamp01((raw - 0.15) / 0.70);
        const v = Math.round(Math.pow(highContrast, 1.15) * 255);
        const idx = row + x * 4;
        data[idx] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
      }
    }
  });
}

/**
 * Painterly Matte Chalk / Gesso Board Texture (256x256):
 * Fine isotropic mineral tooth (dual-scale cellular domes + gentle gesso board undulation)
 * with zero mechanical horizontal stripes — crafted for concept-art chalk painting & blending.
 */
export function generatePainterlyChalkGrainTexture(): string {
  return buildCachedPng('paper:painterly-chalk-gesso', PAPER_SIZE, (data, size) => {
    const rand = createPrng(0xc8e4);
    const fineDomes = makeCellularDomeField(size, 92, rand);   // ~2.8px velvety matte illustration board tooth
    const microDomes = makeCellularDomeField(size, 152, rand); // ~1.7px ultra-fine mineral chalk pores
    const gBoard = makePeriodicGrid(32, rand);
    const gGrit = makePeriodicGrid(128, rand);

    for (let y = 0; y < size; y++) {
      const row = y * size * 4;
      const dRow = y * size;
      for (let x = 0; x < size; x++) {
        const d1 = fineDomes[dRow + x];
        const d2 = microDomes[dRow + x];
        const board = samplePeriodic(gBoard, 32, x * 0.125, y * 0.125);
        const grit = samplePeriodic(gGrit, 128, x * 0.5, y * 0.5);
        const raw = d1 * 0.38 + d2 * 0.26 + grit * 0.18 + board * 0.12 + rand() * 0.06;
        // Creamy mid-high matte tooth distribution (delicate velvety grain, never chunky polka dots)
        const crisp = clamp01((raw - 0.10) / 0.78);
        const v = Math.round((0.18 + 0.82 * Math.pow(crisp, 0.96)) * 255);
        const idx = row + x * 4;
        data[idx] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
      }
    }
  });
}

/**
 * Primed Linen Oil Canvas Texture:
 * Seamless interlocking horizontal/vertical woven canvas threads with subtle organic yarn variation.
 */
export function generateCanvasWeaveTexture(): string {
  return buildCachedPng('paper:linen-canvas', PAPER_SIZE, (data, size) => {
    const rand = createPrng(0xd0d7);
    const gYarn = makePeriodicGrid(64, rand);

    for (let y = 0; y < size; y++) {
      const row = y * size * 4;
      const wy = Math.sin((y / size) * Math.PI * 2 * 32); // 8px thread pitch
      for (let x = 0; x < size; x++) {
        const wx = Math.sin((x / size) * Math.PI * 2 * 32);
        // Alternating over/under plain linen weave
        const phase = Math.sin(((x + y) / size) * Math.PI * 2 * 16) * 0.22;
        const weave = (wx * 0.5 + 0.5) * 0.42 + (wy * 0.5 + 0.5) * 0.42 + phase;
        const organic = samplePeriodic(gYarn, 64, x * 0.25, y * 0.25) * 0.26 + rand() * 0.08;
        const val = clamp01(weave * 0.72 + organic * 0.45);
        const v = Math.round(val * 255);
        const idx = row + x * 4;
        data[idx] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
      }
    }
  });
}

/**
 * Fine Stochastic Film / Stipple Noise Texture:
 * Seamless high-frequency noise field for Noise Shader & textured gradients.
 */
export function generateNoiseGrainTexture(): string {
  return buildCachedPng('paper:stipple-noise', PAPER_SIZE, (data, size) => {
    const rand = createPrng(0xe0e8);
    const gMed = makePeriodicGrid(128, rand);

    for (let y = 0; y < size; y++) {
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const m = samplePeriodic(gMed, 128, x * 0.5, y * 0.5);
        const hi = rand();
        const combined = m * 0.35 + hi * 0.65;
        const crisp = clamp01((combined - 0.14) / 0.72);
        const v = Math.round(crisp * 255);
        const idx = row + x * 4;
        data[idx] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
      }
    }
  });
}

// -------------------------------------------------------------
// HIGH-DPI (1024x1024, 2x OVERSAMPLED) SEAMLESS SURFACE LIBRARY
// Used by Natural Paint Engine (Canvas Tooth, Dry-Brush & Impasto)
// -------------------------------------------------------------

export interface SurfaceTextureMeta {
  id: SurfaceTextureId;
  label: string;
  desc: string;
}

export const SURFACE_TEXTURE_CATALOG: SurfaceTextureMeta[] = [
  { id: 'linen-canvas', label: 'Linen Canvas', desc: 'High-DPI woven primed Belgian linen with spun fibers & slubs' },
  { id: 'coarse-burlap', label: 'Coarse Burlap', desc: 'Heavy twisted-yarn rustic canvas weave with deep valleys' },
  { id: 'fine-cotton', label: 'Fine Cotton', desc: 'Smooth tight-weave primed cotton duck with gesso micro-tooth' },
  { id: 'cold-press-watercolor', label: 'Cold-Press Paper', desc: 'Domed cotton fibers with granulating micro-valleys' },
  { id: 'rough-pastel', label: 'Rough Pastel', desc: 'Toothy laid charcoal and pastel paper with crisp ridges' },
  { id: 'gesso-board', label: 'Gesso Board', desc: 'Cross-brushed primed wood panel with fine bristle striations' },
  { id: 'stipple-grain', label: 'Stipple Grain', desc: 'Organic high-DPI mineral & fine film grain' },
];

const surfaceHeightCache = new Map<SurfaceTextureId, Uint8Array>();

function buildSurfaceHeightField(id: SurfaceTextureId): Uint8Array {
  const size = SURFACE_TEXTURE_SIZE;
  const out = new Uint8Array(size * size);
  const invSize = 1 / size;

  if (id === 'linen-canvas') {
    const rand = createPrng(0x7a11f01);
    // 80 Belgian linen threads across 1024 high-DPI texels (12.8 texels/thread -> ~5.5px at scale=0.85)
    // Purely continuous, band-limited cylindrical yarn geometry (ZERO per-texel white noise -> silky 3D normals!)
    const threads = 80;
    const warpSlub = new Float32Array(threads);
    const weftSlub = new Float32Array(threads);
    const warpJitter = new Float32Array(threads);
    const weftJitter = new Float32Array(threads);
    const warpHeight = new Float32Array(threads);
    const weftHeight = new Float32Array(threads);
    for (let i = 0; i < threads; i++) {
      warpSlub[i] = 0.82 + rand() * 0.30;
      weftSlub[i] = 0.82 + rand() * 0.30;
      warpJitter[i] = (rand() - 0.5) * 0.18;
      weftJitter[i] = (rand() - 0.5) * 0.18;
      warpHeight[i] = 0.90 + rand() * 0.15;
      weftHeight[i] = 0.88 + rand() * 0.15;
    }
    const gFiber = makePeriodicGrid(128, rand);
    const gUndul = makePeriodicGrid(32, rand);
    const gDrift = makePeriodicGrid(16, rand);

    for (let y = 0; y < size; y++) {
      const row = y * size;
      const ny = y * invSize;
      for (let x = 0; x < size; x++) {
        const nx = x * invSize;
        // Gentle hand-loomed warp/weft drift so the weave feels genuinely woven, never mechanical
        const driftX = (samplePeriodic(gDrift, 16, nx * 16, ny * 16) - 0.5) * 0.24;
        const driftY = (samplePeriodic(gDrift, 16, nx * 16 + 7.3, ny * 16 + 4.9) - 0.5) * 0.24;

        const tx = ((nx * threads + driftX) % threads + threads) % threads;
        const ty = ((ny * threads + driftY) % threads + threads) % threads;
        const colCell = Math.floor(tx);
        const rowCell = Math.floor(ty);
        const fracX = tx - colCell;
        const fracY = ty - rowCell;

        const parity = ((rowCell + colCell) & 1) === 0;
        const dx = (fracX - 0.5 + warpJitter[colCell] * 0.15) * 2.0;
        const dy = (fracY - 0.5 + weftJitter[rowCell] * 0.15) * 2.0;

        // Smooth cylindrical yarn cross-section with crisp dark woven interstices
        const warpWidth = warpSlub[colCell];
        const weftWidth = weftSlub[rowCell];
        const warpCyl = Math.cos(Math.min(1, Math.abs(dx) / Math.max(0.60, warpWidth)) * Math.PI * 0.5);
        const weftCyl = Math.cos(Math.min(1, Math.abs(dy) / Math.max(0.60, weftWidth)) * Math.PI * 0.5);

        // Smooth band-limited spun-yarn twist along each thread (crisp at 1024x1024, zero static noise)
        const warpTwist = 0.93 + 0.07 * Math.sin((fracX * 2.2 + ny * threads * 2.5) * Math.PI);
        const weftTwist = 0.93 + 0.07 * Math.sin((fracY * 2.2 - nx * threads * 2.5) * Math.PI);

        // Over/under yarn arch profile
        const warpArch = warpCyl * (0.64 + 0.36 * Math.cos(dy * Math.PI * 0.5)) * warpTwist * warpHeight[colCell];
        const weftArch = weftCyl * (0.64 + 0.36 * Math.cos(dx * Math.PI * 0.5)) * weftTwist * weftHeight[rowCell];

        const over = parity ? warpArch : weftArch;
        const under = parity ? weftArch * 0.44 : warpArch * 0.44;
        const baseWeave = Math.max(over, under);

        const fiber = samplePeriodic(gFiber, 128, nx * 128, ny * 128);
        const undul = samplePeriodic(gUndul, 32, nx * 32, ny * 32);
        const h = clamp01(baseWeave * 0.82 + fiber * 0.11 + undul * 0.07);
        out[row + x] = Math.round(Math.pow(h, 0.95) * 255);
      }
    }
    return out;
  }

  if (id === 'coarse-burlap') {
    const rand = createPrng(0x7a22b02);
    // 64 heavy twisted jute/burlap threads across 1024 high-DPI texels (16 texels/thread!)
    const threads = 64;
    const warpThick = new Float32Array(threads);
    const weftThick = new Float32Array(threads);
    for (let i = 0; i < threads; i++) {
      warpThick[i] = 0.72 + rand() * 0.42;
      weftThick[i] = 0.72 + rand() * 0.42;
    }
    const gRough = makePeriodicGrid(256, rand);
    const gDrift = makePeriodicGrid(32, rand);

    for (let y = 0; y < size; y++) {
      const row = y * size;
      const ny = y * invSize;
      for (let x = 0; x < size; x++) {
        const nx = x * invSize;
        const driftX = (samplePeriodic(gDrift, 32, nx * 32, ny * 32) - 0.5) * 0.25;
        const driftY = (samplePeriodic(gDrift, 32, nx * 32 + 13, ny * 32 + 5) - 0.5) * 0.25;
        const tx = ((nx * threads + driftX) % threads + threads) % threads;
        const ty = ((ny * threads + driftY) % threads + threads) % threads;
        const cCell = Math.floor(tx);
        const rCell = Math.floor(ty);
        const fx = (tx - cCell - 0.5) * 2.0;
        const fy = (ty - rCell - 0.5) * 2.0;
        const parity = ((rCell + cCell) & 1) === 0;
        const twistW = 0.84 + 0.16 * Math.sin((ny * threads * 4.0 + fx * 2.2) * Math.PI);
        const twistH = 0.84 + 0.16 * Math.sin((nx * threads * 4.0 - fy * 2.2) * Math.PI);
        const warpC = Math.cos(Math.min(1, Math.abs(fx) / Math.max(0.55, warpThick[cCell])) * Math.PI * 0.5) * twistW;
        const weftC = Math.cos(Math.min(1, Math.abs(fy) / Math.max(0.55, weftThick[rCell])) * Math.PI * 0.5) * twistH;
        const weave = parity ? Math.max(warpC, weftC * 0.40) : Math.max(weftC, warpC * 0.40);
        const rough = samplePeriodic(gRough, 256, nx * 256, ny * 256);
        const h = clamp01(weave * 0.82 + rough * 0.18 - 0.04);
        out[row + x] = Math.round(Math.pow(h, 1.04) * 255);
      }
    }
    return out;
  }

  if (id === 'fine-cotton') {
    const rand = createPrng(0x7a33c03);
    const threads = 160; // Ultra-tight primed cotton duck across 1024 high-DPI texels
    const gGesso = makePeriodicGrid(128, rand);
    const gMicro = makePeriodicGrid(256, rand);
    for (let y = 0; y < size; y++) {
      const row = y * size;
      const ny = y * invSize;
      const wy = Math.sin(ny * Math.PI * 2 * threads);
      for (let x = 0; x < size; x++) {
        const nx = x * invSize;
        const wx = Math.sin(nx * Math.PI * 2 * threads);
        const checker = Math.sin((nx + ny) * Math.PI * 2 * (threads * 0.5)) * 0.16;
        const weave = (wx * 0.5 + 0.5) * 0.36 + (wy * 0.5 + 0.5) * 0.36 + 0.14 + checker;
        const gesso = samplePeriodic(gGesso, 128, nx * 128, ny * 128);
        const micro = samplePeriodic(gMicro, 256, nx * 256, ny * 256);
        const h = clamp01(weave * 0.58 + gesso * 0.24 + micro * 0.14 + rand() * 0.04);
        out[row + x] = Math.round(h * 255);
      }
    }
    return out;
  }

  if (id === 'cold-press-watercolor') {
    const rand = createPrng(0x7a44d04);
    const coarseDomes = makeCellularDomeField(256, 48, rand);
    const fineDomes = makeCellularDomeField(256, 96, rand);
    const gFiber = makePeriodicGrid(256, rand);
    const gUndul = makePeriodicGrid(64, rand);
    for (let y = 0; y < size; y++) {
      const row = y * size;
      const ny = y * invSize;
      const sy = ny * 256;
      const y0 = Math.floor(sy) & 255;
      const y1 = (y0 + 1) & 255;
      const ty = sy - Math.floor(sy);
      for (let x = 0; x < size; x++) {
        const nx = x * invSize;
        const sx = nx * 256;
        const x0 = Math.floor(sx) & 255;
        const x1 = (x0 + 1) & 255;
        const tx = sx - Math.floor(sx);
        const cTop = coarseDomes[y0 * 256 + x0] * (1 - tx) + coarseDomes[y0 * 256 + x1] * tx;
        const cBot = coarseDomes[y1 * 256 + x0] * (1 - tx) + coarseDomes[y1 * 256 + x1] * tx;
        const d1 = cTop * (1 - ty) + cBot * ty;
        const fTop = fineDomes[y0 * 256 + x0] * (1 - tx) + fineDomes[y0 * 256 + x1] * tx;
        const fBot = fineDomes[y1 * 256 + x0] * (1 - tx) + fineDomes[y1 * 256 + x1] * tx;
        const d2 = fTop * (1 - ty) + fBot * ty;
        const fiber = samplePeriodic(gFiber, 256, nx * 256, ny * 256);
        const undul = samplePeriodic(gUndul, 64, nx * 64, ny * 64);
        const raw = d1 * 0.48 + d2 * 0.26 + fiber * 0.14 + undul * 0.08 + rand() * 0.04;
        const h = clamp01((raw - 0.12) / 0.74);
        out[row + x] = Math.round(Math.pow(h, 1.06) * 255);
      }
    }
    return out;
  }

  if (id === 'rough-pastel') {
    const rand = createPrng(0x7a55e05);
    const domes = makeCellularDomeField(256, 60, rand);
    const gGrit = makePeriodicGrid(256, rand);
    for (let y = 0; y < size; y++) {
      const row = y * size;
      const ny = y * invSize;
      const rib = Math.sin(ny * Math.PI * 2 * 96) * 0.15;
      const sy = ny * 256;
      const y0 = Math.floor(sy) & 255;
      const y1 = (y0 + 1) & 255;
      const ty = sy - Math.floor(sy);
      for (let x = 0; x < size; x++) {
        const nx = x * invSize;
        const chain = Math.sin(nx * Math.PI * 2 * 16) * 0.06;
        const sx = nx * 256;
        const x0 = Math.floor(sx) & 255;
        const x1 = (x0 + 1) & 255;
        const tx = sx - Math.floor(sx);
        const top = domes[y0 * 256 + x0] * (1 - tx) + domes[y0 * 256 + x1] * tx;
        const bot = domes[y1 * 256 + x0] * (1 - tx) + domes[y1 * 256 + x1] * tx;
        const d = top * (1 - ty) + bot * ty;
        const grit = samplePeriodic(gGrit, 256, nx * 256, ny * 256);
        const raw = d * 0.48 + grit * 0.30 + rand() * 0.14 + rib + chain;
        const h = clamp01((raw - 0.14) / 0.72);
        out[row + x] = Math.round(Math.pow(h, 1.15) * 255);
      }
    }
    return out;
  }

  if (id === 'gesso-board') {
    const rand = createPrng(0x7a66f06);
    const gBrushH = makePeriodicGrid(128, rand);
    const gBrushV = makePeriodicGrid(128, rand);
    const gMicro = makePeriodicGrid(256, rand);
    for (let y = 0; y < size; y++) {
      const row = y * size;
      const ny = y * invSize;
      for (let x = 0; x < size; x++) {
        const nx = x * invSize;
        const hStreak = samplePeriodic(gBrushH, 128, nx * 28, ny * 220);
        const vStreak = samplePeriodic(gBrushV, 128, nx * 220, ny * 28);
        const micro = samplePeriodic(gMicro, 256, nx * 256, ny * 256);
        const raw = hStreak * 0.38 + vStreak * 0.30 + micro * 0.24 + rand() * 0.08;
        const h = clamp01((raw - 0.12) / 0.76);
        out[row + x] = Math.round(h * 255);
      }
    }
    return out;
  }

  // 'stipple-grain'
  const rand = createPrng(0x7a77007);
  const gMed = makePeriodicGrid(128, rand);
  const gFine = makePeriodicGrid(256, rand);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    const ny = y * invSize;
    for (let x = 0; x < size; x++) {
      const nx = x * invSize;
      const m = samplePeriodic(gMed, 128, nx * 128, ny * 128);
      const f = samplePeriodic(gFine, 256, nx * 256, ny * 256);
      const raw = m * 0.28 + f * 0.36 + rand() * 0.36;
      const h = clamp01((raw - 0.14) / 0.72);
      out[row + x] = Math.round(h * 255);
    }
  }
  return out;
}

/**
 * Returns the cached 1024x1024 seamless high-DPI surface elevation table [0..255] for a built-in texture ID.
 */
export function getSurfaceTextureHeightField(id: SurfaceTextureId): Uint8Array {
  const hit = surfaceHeightCache.get(id);
  if (hit) return hit;
  const field = buildSurfaceHeightField(id);
  surfaceHeightCache.set(id, field);
  return field;
}

/**
 * Fast bilinear periodic lookup of the high-DPI 1024x1024 surface heightmap in [0..1]
 * using 2x oversampled texel coordinates for razor-sharp grain at 100%-400% zoom.
 */
export function sampleSurfaceTextureHeight(
  id: SurfaceTextureId,
  x: number,
  y: number,
  scale: number = 1.0,
  rotateRad: number = 0
): number {
  const table = getSurfaceTextureHeightField(id);
  const size = SURFACE_TEXTURE_SIZE;
  const mask = size - 1;
  const invScale = SURFACE_TEXELS_PER_PX / Math.max(0.05, scale);
  let px = x * invScale;
  let py = y * invScale;
  if (Math.abs(rotateRad) > 1e-4) {
    const c = Math.cos(rotateRad);
    const s = Math.sin(rotateRad);
    const rx = px * c - py * s;
    const ry = px * s + py * c;
    px = rx;
    py = ry;
  }
  const fx = Math.floor(px);
  const fy = Math.floor(py);
  const tx = px - fx;
  const ty = py - fy;
  const x0 = fx & mask;
  const y0 = fy & mask;
  const x1 = (fx + 1) & mask;
  const y1 = (fy + 1) & mask;
  const v00 = table[y0 * size + x0];
  const v10 = table[y0 * size + x1];
  const v01 = table[y1 * size + x0];
  const v11 = table[y1 * size + x1];
  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return (top + (bot - top) * ty) / 255.0;
}

/**
 * Samples true 2x-DPI analytical surface gradients (dh/dx, dh/dy) directly from the 1024x1024
 * continuous heightfield at sub-texel central differences — eliminates 1px aliasing on linen weave!
 */
export function sampleSurfaceTextureGrad(
  id: SurfaceTextureId,
  x: number,
  y: number,
  scale: number,
  rotateRad: number,
  out: { gx: number; gy: number }
): void {
  const table = getSurfaceTextureHeightField(id);
  const size = SURFACE_TEXTURE_SIZE;
  const mask = size - 1;
  const invScale = SURFACE_TEXELS_PER_PX / Math.max(0.05, scale);
  let px = x * invScale;
  let py = y * invScale;
  let cosR = 1;
  let sinR = 0;
  if (Math.abs(rotateRad) > 1e-4) {
    cosR = Math.cos(rotateRad);
    sinR = Math.sin(rotateRad);
    const rx = px * cosR - py * sinR;
    const ry = px * sinR + py * cosR;
    px = rx;
    py = ry;
  }

  const sampleBilin = (sx: number, sy: number): number => {
    const fx = Math.floor(sx);
    const fy = Math.floor(sy);
    const tx = sx - fx;
    const ty = sy - fy;
    const x0 = fx & mask;
    const y0 = fy & mask;
    const x1 = (fx + 1) & mask;
    const y1 = (fy + 1) & mask;
    const r0 = y0 * size;
    const r1 = y1 * size;
    const v00 = table[r0 + x0];
    const v10 = table[r0 + x1];
    const v01 = table[r1 + x0];
    const v11 = table[r1 + x1];
    return v00 + (v10 - v00) * tx + ((v01 + (v11 - v01) * tx) - (v00 + (v10 - v00) * tx)) * ty;
  };

  // Central difference across +/-0.65 high-DPI texels (band-limited, zero stair-step!)
  const eps = 0.65;
  const dU = (sampleBilin(px + eps, py) - sampleBilin(px - eps, py)) / (255.0 * 2.0 * eps);
  const dV = (sampleBilin(px, py + eps) - sampleBilin(px, py - eps)) / (255.0 * 2.0 * eps);
  out.gx = dU * cosR + dV * sinR;
  out.gy = -dU * sinR + dV * cosR;
}

/**
 * Generates and caches a crisp 512x512 seamless PNG data URL (2x box-filtered from 1024x1024)
 * for UI swatches and legacy paper-texture GPU binding.
 */
export function getSurfaceTextureDataUrl(id: SurfaceTextureId): string {
  const outSize = 512;
  return buildCachedPng(`surface512:${id}`, outSize, (data, size) => {
    const field = getSurfaceTextureHeightField(id);
    const srcSize = SURFACE_TEXTURE_SIZE;
    const step = Math.max(1, srcSize / size);
    for (let y = 0; y < size; y++) {
      const sy = y * step;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const sx = x * step;
        const v =
          step === 2
            ? Math.round(
                (field[sy * srcSize + sx] +
                  field[sy * srcSize + sx + 1] +
                  field[(sy + 1) * srcSize + sx] +
                  field[(sy + 1) * srcSize + sx + 1]) *
                  0.25
              )
            : field[sy * srcSize + sx];
        const idx = row + x * 4;
        data[idx] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
      }
    }
  });
}

// -------------------------------------------------------------
// NATURAL PAINT PHYSICAL BRUSH TIP GENERATORS (128x128)
// -------------------------------------------------------------

export function generateNaturalTipByProfile(profile: BristleProfilePreset): string {
  const key = `natural-tip:${profile}`;
  return buildCachedPng(key, TIP_SIZE, (data, size) => {
    const rand = createPrng(
      profile === 'flat'
        ? 0x9011
        : profile === 'filbert'
        ? 0x9022
        : profile === 'fan'
        ? 0x9033
        : profile === 'rake'
        ? 0x9044
        : profile === 'knife'
        ? 0x9055
        : 0x9066
    );
    const half = size * 0.5;
    const rx = half - 6;
    const ry = profile === 'knife' ? half * 0.24 : profile === 'flat' || profile === 'rake' ? half * 0.42 : profile === 'filbert' ? half * 0.55 : half - 8;

    const strandCount =
      profile === 'rake' ? 18 : profile === 'fan' ? 28 : profile === 'knife' ? 1 : 38;

    if (profile === 'knife') {
      // Sharp palette knife blade: crisp chisel edge with subtle paint buildup along outer ridge
      for (let y = 0; y < size; y++) {
        const ny = (y - half + 0.5) / ry;
        const row = y * size * 4;
        for (let x = 0; x < size; x++) {
          const nx = (x - half + 0.5) / rx;
          if (Math.abs(nx) > 1.02 || Math.abs(ny) > 1.05) continue;
          const bladeMask =
            (1.0 - smoothstep(0.86, 1.0, Math.abs(nx))) *
            (1.0 - smoothstep(0.65, 1.0, Math.abs(ny)));
          const micro = 0.88 + rand() * 0.12;
          writeAlphaPixel(data, row + x * 4, bladeMask * micro);
        }
      }
      return;
    }

    // Build bristle tuft clusters across the brush cross-section
    const tufts: Array<{ cx: number; cy: number; r: number; strength: number }> = [];
    for (let i = 0; i < strandCount; i++) {
      const u = strandCount > 1 ? (i / (strandCount - 1)) * 2 - 1 : 0;
      const arch = profile === 'filbert' ? Math.sqrt(Math.max(0.15, 1.0 - u * u * 0.85)) : profile === 'fan' ? 1.0 - Math.abs(u) * 0.35 : 1.0;
      const cx = half + u * rx * (profile === 'rake' ? 0.94 : 0.86) + (rand() - 0.5) * (profile === 'rake' ? 1.2 : 3.5);
      const cy = half + (rand() - 0.5) * ry * (profile === 'rake' ? 0.55 : 0.95) * arch;
      const r =
        profile === 'rake'
          ? 2.2 + rand() * 1.4
          : profile === 'fan'
          ? 2.6 + rand() * 2.2
          : (4.2 + rand() * 3.8) * (0.65 + 0.35 * arch);
      tufts.push({ cx, cy, r, strength: 0.72 + rand() * 0.28 });
    }

    for (let y = 0; y < size; y++) {
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        let accum = 0;
        for (let i = 0; i < tufts.length; i++) {
          const t = tufts[i];
          const dx = x - t.cx;
          const dy = (y - t.cy) * (profile === 'flat' || profile === 'rake' ? 1.4 : 1.0);
          const d = Math.hypot(dx, dy) / t.r;
          if (d < 1.0) {
            const v = (1.0 - smoothstep(0.35, 1.0, d)) * t.strength;
            if (v > accum) accum = v;
          }
        }
        if (accum > 0.02) {
          writeAlphaPixel(data, row + x * 4, accum);
        }
      }
    }
  });
}
