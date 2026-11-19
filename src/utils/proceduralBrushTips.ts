/**
 * proceduralBrushTips.ts
 * Deterministic, zero-allocation procedural 128x128 brush tip masks and 256x256 seamless
 * paper/canvas grain textures modeled after Clip Studio Paint & Photoshop physical media.
 *
 * Tips encode alpha opacity on pure white RGB so GPU/CPU tinting stays color-accurate.
 * Paper textures encode surface elevation in luminance [0..255] with opaque alpha=255.
 */

const TIP_SIZE = 128;
const PAPER_SIZE = 256;

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
 * Helper: allocates an offscreen canvas, fills RGBA via callback, and returns a cached PNG data URL.
 */
function buildCachedPng(
  key: string,
  size: number,
  fill: (data: Uint8ClampedArray, size: number) => void
): string {
  const hit = generatedCache.get(key);
  if (hit !== undefined) return hit;

  if (typeof document === 'undefined') return '';
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.createImageData !== 'function') return '';

  const imgData = ctx.createImageData(size, size);
  fill(imgData.data, size);
  ctx.putImageData(imgData, 0, 0);

  const url = typeof canvas.toDataURL === 'function' ? canvas.toDataURL('image/png') : '';
  if (url) {
    generatedCache.set(key, url);
  }
  return url;
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
 * Real G-Pen: dense manga steel-nib core with subtle organic edge feathering & ink-on-Bristol micro-roughness.
 */
export function generateRealGPenTip(): string {
  return buildCachedPng('tip:real-g-pen', TIP_SIZE, (data, size) => {
    const rand = createPrng(0x101a);
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
        const angle = Math.atan2(dy, dx);

        // Subtle organic nib wobble + Bristol fiber bleed along rim
        const angularWobble =
          Math.sin(angle * 5 + 0.7) * 0.022 +
          Math.cos(angle * 11 - 1.3) * 0.016 +
          Math.sin(angle * 19 + 2.1) * 0.011;
        const edgeNoise =
          (samplePeriodic(nMed, 32, x * 0.25, y * 0.25) - 0.5) * 0.09 +
          (samplePeriodic(nFine, 64, x * 0.5, y * 0.5) - 0.5) * 0.05;

        const rNorm = dist / (baseR * (1.0 + angularWobble + edgeNoise));
        if (rNorm >= 1.04) continue;

        let alpha = 1.0 - smoothstep(0.84, 1.02, rNorm);
        // Micro-tooth only at the outermost ink rim
        if (rNorm > 0.76) {
          const rimTooth = samplePeriodic(nFine, 64, x * 0.75, y * 0.75);
          alpha *= 0.82 + rimTooth * 0.26;
        }
        writeAlphaPixel(data, row + x * 4, alpha);
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
// BRUSH SECTION TIPS (COLORING & PAINTING)
// -------------------------------------------------------------

/**
 * Oil Painting Brush: oval natural hog-bristle bundle (~52 soft individual bristles with organic gaps).
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
 * Chalk Painting Brush: wide sculpted painterly chalk/oil-pastel head with broken textured streaks.
 */
export function generateChalkPaintTip(): string {
  return buildCachedPng('tip:chalk-painting', TIP_SIZE, (data, size) => {
    const rand = createPrng(0xa0a4);
    const nCoarse = makePeriodicGrid(16, rand);
    const nMed = makePeriodicGrid(32, rand);
    const nFine = makePeriodicGrid(64, rand);
    const half = size * 0.5;
    const rx = half - 8;
    const ry = half - 14;

    for (let y = 0; y < size; y++) {
      const dy = y - half + 0.5;
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        const dx = x - half + 0.5;
        // Directional streak noise along X for painterly drag
        const streak = samplePeriodic(nMed, 32, x * 0.14, y * 0.44);
        const warp = (samplePeriodic(nCoarse, 16, x * 0.15, y * 0.15) - 0.5) * 0.22;
        const nx = Math.abs(dx) / (rx * (1.0 + warp));
        const ny = Math.abs(dy) / (ry * (1.0 + warp));
        const d = Math.pow(Math.pow(nx, 2.4) + Math.pow(ny, 2.4), 1 / 2.4);
        if (d >= 1.06) continue;

        const env = 1.0 - smoothstep(0.68, 1.05, d);
        const tooth = samplePeriodic(nFine, 64, x * 0.65, y * 0.65);
        const dry = smoothstep(0.16, 0.78, streak * 0.52 + tooth * 0.34 + rand() * 0.14 + (1.0 - d) * 0.35);
        writeAlphaPixel(data, row + x * 4, env * (0.38 + 0.62 * dry));
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
