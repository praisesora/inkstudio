/**
 * NaturalPaintRenderer.ts
 * Sparse Dual-Channel (RGBA + Paint Heightmap) Natural Paint & Impasto Relief Engine.
 *
 * Implements:
 * 1. Continuous bristle strand capsule rasterization with cross-section groove profiles.
 * 2. Physical Paint-to-Canvas-Tooth interaction (valley fill at high load/pressure vs.
 *    crisp valley-skipping dry-brush at low load/light pressure/tilt) across all 4
 *    spatial grain mapping modes (`canvas-locked`, `brush-aligned`, `stroke-flow`, `random-per-stroke`).
 * 3. 3D Impasto Micro-Relief shading (3x3 Sobel normal derivation, directional diffuse ridge
 *    lighting, Blinn-Phong gloss specular, valley micro-AO, and watercolor granulation/wet-edge).
 * 4. Identical live draft & pointer-up tile commit parity (zero visual pop on pointer-up).
 */

import type {
  BrushSettings,
  GrainMappingMode,
  ImpastoSettings,
  NaturalPaintSettings,
  Point,
  SurfaceTextureId,
} from '../types/editor';
import {
  DEFAULT_IMPASTO_SETTINGS,
  DEFAULT_NATURAL_PAINT_SETTINGS,
} from '../types/editor';
import {
  getSurfaceTextureHeightField,
  sampleSurfaceTextureGrad,
  SURFACE_TEXELS_PER_PX,
  SURFACE_TEXTURE_SIZE,
} from '../utils/proceduralBrushTips';
import { LayerPixelSampler } from '../utils/colorMixingEngine';
import {
  BRISTLE_SEG_STRIDE,
  BristleRibbonEngine,
  BristleStrandBatch,
  extractBristleStrokeConfig,
} from './BristleRibbonEngine';
import { centripetalCatmullRomToBezier, evaluateFastSpline } from './BrushEngine';

const CHUNK_SIZE = 256;
const CHUNK_SHIFT = 8;
const CHUNK_MASK = CHUNK_SIZE - 1;
const CHUNK_PIXELS = CHUNK_SIZE * CHUNK_SIZE;

// Weak cache extracting luminance height fields from custom uploaded paper textures
const customTextureHeightCache = new WeakMap<
  HTMLImageElement,
  { data: Uint8Array; width: number; height: number }
>();

function getCustomTextureHeightField(
  img?: HTMLImageElement
): { data: Uint8Array; width: number; height: number } | null {
  if (!img || img.complete === false) return null;
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  if (w <= 0 || h <= 0) return null;

  const hit = customTextureHeightCache.get(img);
  if (hit) return hit;

  if (typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h).data;
    const lum = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const a = pixels[p + 3];
      const y = Math.round(pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114);
      lum[i] = a < 250 ? 255 - a : y;
    }
    const entry = { data: lum, width: w, height: h };
    customTextureHeightCache.set(img, entry);
    return entry;
  } catch {
    return null;
  }
}

export interface GrainSampleParams {
  mappingMode: GrainMappingMode;
  surfaceId: SurfaceTextureId;
  customTex: { data: Uint8Array; width: number; height: number } | null;
  dualSurfaceId?: SurfaceTextureId;
  dualGrainDepth: number;
  grainDepth: number;
  scale: number;
  rotateRad: number;
  contrast: number;
  brightness: number;
  inverted: boolean;
  strokeOffsetX: number;
  strokeOffsetY: number;
  strokeCos: number;
  strokeSin: number;
}

/**
 * Samples the surface elevation H_canvas in [0..1] for any spatial mapping mode.
 */
export function evaluateMappedSurfaceHeight(
  params: GrainSampleParams,
  worldX: number,
  worldY: number,
  arcU: number,
  acrossV: number,
  brushHalfWidth: number,
  segCos: number,
  segSin: number
): number {
  let sx = worldX;
  let sy = worldY;

  switch (params.mappingMode) {
    case 'brush-aligned': {
      // Map into brush-local coordinates aligned with the segment tangent/normal
      const lx = worldX * segCos + worldY * segSin;
      const ly = -worldX * segSin + worldY * segCos;
      sx = lx;
      sy = ly;
      break;
    }
    case 'stroke-flow': {
      // Continuous stroke UV: u = arcLength, v = across-width in pixels
      sx = arcU;
      sy = acrossV * Math.max(8, brushHalfWidth);
      break;
    }
    case 'random-per-stroke': {
      const rx = worldX * params.strokeCos - worldY * params.strokeSin + params.strokeOffsetX;
      const ry = worldX * params.strokeSin + worldY * params.strokeCos + params.strokeOffsetY;
      sx = rx;
      sy = ry;
      break;
    }
    case 'canvas-locked':
    default:
      break;
  }

  const invScale = 1.0 / Math.max(0.05, params.scale);
  let tx = sx * invScale;
  let ty = sy * invScale;

  if (Math.abs(params.rotateRad) > 1e-4) {
    const c = Math.cos(params.rotateRad);
    const s = Math.sin(params.rotateRad);
    const rx = tx * c - ty * s;
    const ry = tx * s + ty * c;
    tx = rx;
    ty = ry;
  }

  let g: number;
  if (params.customTex) {
    const { data, width, height } = params.customTex;
    const fx = Math.floor(tx);
    const fy = Math.floor(ty);
    const ix0 = ((fx % width) + width) % width;
    const iy0 = ((fy % height) + height) % height;
    const ix1 = (ix0 + 1) % width;
    const iy1 = (iy0 + 1) % height;
    const u = tx - fx;
    const v = ty - fy;
    const v00 = data[iy0 * width + ix0];
    const v10 = data[iy0 * width + ix1];
    const v01 = data[iy1 * width + ix0];
    const v11 = data[iy1 * width + ix1];
    g = (v00 + (v10 - v00) * u + ((v01 + (v11 - v01) * u) - (v00 + (v10 - v00) * u)) * v) / 255.0;
  } else {
    // High-DPI 2x oversampled texel coordinates with 2-tap rotated-grid anti-aliasing (zero moire!)
    const field = getSurfaceTextureHeightField(params.surfaceId);
    const mask = SURFACE_TEXTURE_SIZE - 1;
    const htx = tx * SURFACE_TEXELS_PER_PX;
    const hty = ty * SURFACE_TEXELS_PER_PX;

    // Sample tap A (-0.32, +0.24) and tap B (+0.32, -0.24) in 1024x1024 high-DPI space
    const ax = htx - 0.32;
    const ay = hty + 0.24;
    const afx = Math.floor(ax);
    const afy = Math.floor(ay);
    const au = ax - afx;
    const av = ay - afy;
    const ax0 = afx & mask;
    const ay0 = afy & mask;
    const ax1 = (afx + 1) & mask;
    const ay1 = (afy + 1) & mask;
    const rA0 = ay0 * SURFACE_TEXTURE_SIZE;
    const rA1 = ay1 * SURFACE_TEXTURE_SIZE;
    const a00 = field[rA0 + ax0];
    const a10 = field[rA0 + ax1];
    const a01 = field[rA1 + ax0];
    const a11 = field[rA1 + ax1];
    const gA = a00 + (a10 - a00) * au + ((a01 + (a11 - a01) * au) - (a00 + (a10 - a00) * au)) * av;

    const bx = htx + 0.32;
    const by = hty - 0.24;
    const bfx = Math.floor(bx);
    const bfy = Math.floor(by);
    const bu = bx - bfx;
    const bv = by - bfy;
    const bx0 = bfx & mask;
    const by0 = bfy & mask;
    const bx1 = (bfx + 1) & mask;
    const by1 = (bfy + 1) & mask;
    const rB0 = by0 * SURFACE_TEXTURE_SIZE;
    const rB1 = by1 * SURFACE_TEXTURE_SIZE;
    const b00 = field[rB0 + bx0];
    const b10 = field[rB0 + bx1];
    const b01 = field[rB1 + bx0];
    const b11 = field[rB1 + bx1];
    const gB = b00 + (b10 - b00) * bu + ((b01 + (b11 - b01) * bu) - (b00 + (b10 - b00) * bu)) * bv;

    g = (gA + gB) * (0.5 / 255.0);
  }

  if (params.dualSurfaceId && params.dualGrainDepth > 0.01) {
    const dualField = getSurfaceTextureHeightField(params.dualSurfaceId);
    const mask = SURFACE_TEXTURE_SIZE - 1;
    const dtx = tx * SURFACE_TEXELS_PER_PX * 1.35;
    const dty = ty * SURFACE_TEXELS_PER_PX * 1.35;
    const dx = Math.floor(dtx) & mask;
    const dy = Math.floor(dty) & mask;
    const dg = dualField[dy * SURFACE_TEXTURE_SIZE + dx] / 255.0;
    g = g * (1.0 - params.dualGrainDepth * 0.5) + dg * (params.dualGrainDepth * 0.5);
  }

  if (params.inverted) g = 1.0 - g;
  if (params.brightness !== 0) g += params.brightness / 100.0;
  if (params.contrast !== 0) {
    const cf = Math.pow(Math.max(0.05, 1.0 + params.contrast / 100.0), 2);
    g = (g - 0.5) * cf + 0.5;
  }
  return g <= 0 ? 0 : g >= 1 ? 1 : g;
}

/**
 * Physical "Paint <-> Canvas Tooth" contact evaluation.
 * - High paintLoad + strong pressure -> fills canvas valleys opaquely.
 * - Low paintLoad / light pressure / high tilt / dryBrush -> skips valleys and deposits
 *   pigment only on raised weave crowns!
 */
export function evaluatePaintCanvasContact(
  canvasHeight: number,
  paintLoad: number,
  pressure: number,
  tiltMag: number,
  grainDepth: number,
  dryBrush: number,
  penetrationCurve?: [number, number][]
): number {
  if (grainDepth <= 0.005 && dryBrush <= 0.005) return 1.0;

  const curvedP = penetrationCurve
    ? evaluateFastSpline(pressure, penetrationCurve)
    : Math.max(0, Math.min(1, pressure));
  const load = Math.max(0, Math.min(1, paintLoad));

  // Heavy paint load & firm pressure push pigment deep into canvas valleys;
  // exhausted bristles, light pressure, or tilted strokes skim across peaks.
  const tiltReduction = 1.0 - Math.max(0, Math.min(1, tiltMag)) * 0.45;
  const penetration = Math.max(
    0,
    Math.min(1, (curvedP * 0.50 + load * 0.50) * (0.38 + 0.62 * load) * tiltReduction)
  );

  // Soft, woven dry-brush transition across fine canvas threads (no harsh blocky checkerboard)
  const effectiveDry = Math.max(dryBrush, grainDepth * 0.68);
  const cutoff = effectiveDry * (1.0 - penetration * 0.84) * 0.76;
  const softness = 0.14 + (1.0 - effectiveDry) * 0.22;
  const t = Math.max(0, Math.min(1, (canvasHeight - cutoff) / Math.max(0.06, softness)));
  const smooth = t * t * (3.0 - 2.0 * t);

  // At high load & firm pressure, pigment cleanly fills canvas valleys for solid layering;
  // on dry edges/light strokes, weave peaks still catch crisp dry-brush texture
  const maskStrength = Math.max(
    0,
    Math.min(1, grainDepth * (1.0 - penetration * 0.92) + dryBrush * (1.0 - load * 0.94))
  );
  return 1.0 - maskStrength + maskStrength * smooth;
}

interface PaintChunk {
  cx: number;
  cy: number;
  // Straight RGBA stored in Float32 for banding-free accumulation
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
  height: Float32Array;
  tooth: Float32Array;
  lastArcU: Float32Array;
  lastBristle: Int16Array;
}

const chunkPool: PaintChunk[] = [];
const MAX_CHUNK_POOL = 24;

function acquireChunk(cx: number, cy: number): PaintChunk {
  const recycled = chunkPool.pop();
  if (recycled) {
    recycled.cx = cx;
    recycled.cy = cy;
    recycled.r.fill(0);
    recycled.g.fill(0);
    recycled.b.fill(0);
    recycled.a.fill(0);
    recycled.height.fill(0);
    recycled.tooth.fill(0.5);
    recycled.lastArcU.fill(-9999);
    recycled.lastBristle.fill(-1);
    return recycled;
  }
  const tooth = new Float32Array(CHUNK_PIXELS);
  tooth.fill(0.5);
  const lastArcU = new Float32Array(CHUNK_PIXELS);
  lastArcU.fill(-9999);
  const lastBristle = new Int16Array(CHUNK_PIXELS);
  lastBristle.fill(-1);
  return {
    cx,
    cy,
    r: new Float32Array(CHUNK_PIXELS),
    g: new Float32Array(CHUNK_PIXELS),
    b: new Float32Array(CHUNK_PIXELS),
    a: new Float32Array(CHUNK_PIXELS),
    height: new Float32Array(CHUNK_PIXELS),
    tooth,
    lastArcU,
    lastBristle,
  };
}

function releaseChunk(chunk: PaintChunk): void {
  if (chunkPool.length < MAX_CHUNK_POOL) {
    chunkPool.push(chunk);
  }
}

/**
 * Checks whether a BrushSettings configuration should use the Natural Paint / Bristle Ribbon core.
 */
export function isNaturalPaintBrush(bs: Partial<BrushSettings> | undefined): boolean {
  if (!bs) return false;
  return Boolean(
    bs.renderMode === 'bristle-ribbon' ||
      bs.renderMode === 'bristle-hybrid' ||
      bs.naturalPaint?.enabled ||
      bs.impasto?.enabled
  );
}

/**
 * Computes directional 3D light unit vector from azimuth & elevation degrees.
 */
export function computeImpastoLightVector(
  azimuthDeg: number,
  elevationDeg: number
): { lx: number; ly: number; lz: number } {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (Math.max(5, Math.min(85, elevationDeg)) * Math.PI) / 180;
  const cosEl = Math.cos(el);
  const lx = Math.cos(az) * cosEl;
  const ly = Math.sin(az) * cosEl;
  const lz = Math.sin(el);
  const len = Math.hypot(lx, ly, lz) || 1;
  return { lx: lx / len, ly: ly / len, lz: lz / len };
}

/**
 * Stroke-scoped Natural Paint accumulator & relief shader.
 * Shared identically by live stroke streaming (draftCanvas), pointer-up tile commit,
 * Brush Studio scratchpad, and brush preview thumbnails.
 */
export class NaturalPaintStrokeSession {
  public readonly engine: BristleRibbonEngine;
  public readonly settings: BrushSettings;
  public readonly strokeColor: string;
  public readonly grainParams: GrainSampleParams;
  public readonly impasto: ImpastoSettings;
  public readonly natural: NaturalPaintSettings;
  public readonly wetEdge: number;
  public readonly granulation: number;

  private readonly chunks = new Map<number, PaintChunk>();
  private readonly chunkStrideX = 65536;
  private scratchCanvas: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private pendingTapPoint: Point | null = null;
  private hasEmittedSegment: boolean = false;
  // Reusable Float32 scratch grids for smooth Sobel impasto relief & 3D cast-shadow ray-marching (zero GC!)
  private hGridRaw: Float32Array = new Float32Array(0);
  private hGridTmp: Float32Array = new Float32Array(0);
  private hGridSmooth: Float32Array = new Float32Array(0);
  private toothGrid: Float32Array = new Float32Array(0);

  public minX: number = Infinity;
  public minY: number = Infinity;
  public maxX: number = -Infinity;
  public maxY: number = -Infinity;

  constructor(
    settings: BrushSettings,
    strokeColor: string,
    totalLength?: number,
    strokeSeed: number = 1337
  ) {
    this.settings = settings;
    this.strokeColor = strokeColor;
    const cfg = extractBristleStrokeConfig(settings, strokeColor, totalLength, strokeSeed);
    this.engine = new BristleRibbonEngine(cfg);
    this.impasto = {
      ...DEFAULT_IMPASTO_SETTINGS,
      ...(settings.impasto || {}),
    };
    this.natural = {
      ...DEFAULT_NATURAL_PAINT_SETTINGS,
      ...(settings.naturalPaint || {}),
    };
    this.wetEdge = Math.max(0, Math.min(1, settings.wetEdge ?? 0));
    this.granulation = Math.max(0, Math.min(1, settings.naturalPaint?.granulation ?? 0));

    // Deterministic per-stroke offset/rotation for 'random-per-stroke' grain mapping
    const s1 = ((strokeSeed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const s2 = ((strokeSeed * 22695477 + 1) >>> 0) / 4294967296;
    const s3 = ((strokeSeed * 1103515245 + 12345) >>> 0) / 4294967296;
    const randRot = s3 * Math.PI * 2;

    this.grainParams = {
      mappingMode: settings.grainMappingMode ?? 'canvas-locked',
      surfaceId: settings.surfaceTextureId ?? 'linen-canvas',
      customTex: getCustomTextureHeightField(settings.paperTextureImage),
      dualSurfaceId: settings.dualSurfaceTextureId,
      dualGrainDepth: Math.max(0, Math.min(1, settings.dualGrainDepth ?? 0)),
      grainDepth: Math.max(0, Math.min(1, settings.grain ?? settings.textureDensity ?? 0)),
      scale: Math.max(0.1, settings.paperTextureScale ?? 1.0),
      rotateRad: ((settings.paperTextureRotate ?? 0) * Math.PI) / 180,
      contrast: settings.paperTextureContrast ?? 0,
      brightness: settings.paperTextureBrightness ?? 0,
      inverted: Boolean(settings.paperTextureInverted),
      strokeOffsetX: s1 * SURFACE_TEXTURE_SIZE,
      strokeOffsetY: s2 * SURFACE_TEXTURE_SIZE,
      strokeCos: Math.cos(randRot),
      strokeSin: Math.sin(randRot),
    };
  }

  private getOrCreateChunk(cx: number, cy: number): PaintChunk {
    const key = cy * this.chunkStrideX + cx;
    let ch = this.chunks.get(key);
    if (!ch) {
      ch = acquireChunk(cx, cy);
      this.chunks.set(key, ch);
    }
    return ch;
  }

  private getChunk(cx: number, cy: number): PaintChunk | undefined {
    return this.chunks.get(cy * this.chunkStrideX + cx);
  }

  private sampleAccumHeight(x: number, y: number): { hPaint: number; tooth: number; alpha: number } {
    const cx = x >> CHUNK_SHIFT;
    const cy = y >> CHUNK_SHIFT;
    const ch = this.getChunk(cx, cy);
    if (!ch) return { hPaint: 0, tooth: 0.5, alpha: 0 };
    const idx = ((y & CHUNK_MASK) << CHUNK_SHIFT) + (x & CHUNK_MASK);
    return { hPaint: ch.height[idx], tooth: ch.tooth[idx], alpha: ch.a[idx] };
  }

  /**
   * Rasterizes a batch of continuous bristle strand capsules into the sparse RGBA + Height chunks.
   */
  public rasterizeBatch(batch: BristleStrandBatch): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (batch.count <= 0) return null;
    const data = batch.data;
    const grainDepth = this.grainParams.grainDepth;
    const dryBrush = this.natural.dryBrush;
    const penCurve = this.natural.penetrationCurve;
    const bristleRelief = this.impasto.enabled ? this.impasto.bristleRelief : 0.4;
    const halfBrushW = Math.max(2, (this.settings.size || 24) * 0.5);

    let dMinX = Infinity;
    let dMinY = Infinity;
    let dMaxX = -Infinity;
    let dMaxY = -Infinity;

    for (let s = 0; s < batch.count; s++) {
      const base = s * BRISTLE_SEG_STRIDE;
      const a0 = data[base + 7];
      const a1 = data[base + 11];
      if (a0 <= 0.002 && a1 <= 0.002) continue;

      const x0 = data[base + 0];
      const y0 = data[base + 1];
      const x1 = data[base + 2];
      const y1 = data[base + 3];
      const r0 = data[base + 4];
      const g0 = data[base + 5];
      const b0 = data[base + 6];
      const r1 = data[base + 8];
      const g1 = data[base + 9];
      const b1 = data[base + 10];
      const rad0 = data[base + 12];
      const rad1 = data[base + 13];
      const load0 = data[base + 14];
      const load1 = data[base + 15];
      const h0 = data[base + 16];
      const h1 = data[base + 17];
      const arcU0 = data[base + 18];
      const arcU1 = data[base + 19];
      const acrossV = data[base + 20];
      const pressure = data[base + 21];
      const tiltMag = data[base + 22];
      const bristleIdx = data[base + 23] | 0;
      const isUnderBed = bristleIdx < 0;

      const maxRad = Math.max(rad0, rad1, 0.75);
      const pad = Math.ceil(maxRad + 1.5);
      const bx0 = Math.floor(Math.min(x0, x1) - pad);
      const by0 = Math.floor(Math.min(y0, y1) - pad);
      const bx1 = Math.ceil(Math.max(x0, x1) + pad);
      const by1 = Math.ceil(Math.max(y0, y1) + pad);

      if (bx0 < dMinX) dMinX = bx0;
      if (by0 < dMinY) dMinY = by0;
      if (bx1 > dMaxX) dMaxX = bx1;
      if (by1 > dMaxY) dMaxY = by1;

      const sdx = x1 - x0;
      const sdy = y1 - y0;
      const lenSq = sdx * sdx + sdy * sdy;
      const segLen = Math.sqrt(lenSq);
      const invLenSq = lenSq > 1e-6 ? 1.0 / lenSq : 0;
      const segCos = segLen > 1e-4 ? sdx / segLen : 1;
      const segSin = segLen > 1e-4 ? sdy / segLen : 0;
      const selfPassWindow = Math.max(14, halfBrushW * 0.9);

      for (let py = by0; py <= by1; py++) {
        const cy = py >> CHUNK_SHIFT;
        const lyOff = (py & CHUNK_MASK) << CHUNK_SHIFT;
        const dy0 = py + 0.5 - y0;

        for (let px = bx0; px <= bx1; px++) {
          const dx0 = px + 0.5 - x0;
          let t = lenSq > 1e-6 ? (dx0 * sdx + dy0 * sdy) * invLenSq : 0;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;

          const cxPt = x0 + sdx * t;
          const cyPt = y0 + sdy * t;
          const dist = Math.hypot(px + 0.5 - cxPt, py + 0.5 - cyPt);
          const rad = rad0 + (rad1 - rad0) * t;
          if (dist >= rad + 0.85) continue;

          const normD = dist / Math.max(0.5, rad);
          const load = load0 + (load1 - load0) * t;
          const arcU = arcU0 + (arcU1 - arcU0) * t;

          let baseAlpha: number;
          let grooveCrown: number;
          let troughCarve = 0;
          let effLoadForTooth = load;

          if (isUnderBed) {
            // Cohesive creamy paint cushion: opaque inside core (normD < 0.68), feathered softly across linen flanks
            const flankT = Math.max(0, Math.min(1, (normD - 0.62) / 0.38));
            const coreEnv = 1.0 - flankT * flankT * (3.0 - 2.0 * flankT);
            baseAlpha = (a0 + (a1 - a0) * t) * coreEnv;
            grooveCrown = 0.55 + 0.45 * coreEnv;
            effLoadForTooth = load * (0.28 + 0.72 * coreEnv);
          } else {
            // Sculpted rounded cylindrical bristle ridge + recessed outer furrow carving!
            // Low-relief brushes get slightly wider creamy edge feathering for seamless blending
            const edgeSoft = Math.max(1.25, Math.min(2.5, 1.4 + (1.0 - bristleRelief) * 1.0));
            const aaEdge = 1.0 - Math.max(0, Math.min(1, (dist - (rad - edgeSoft * 0.5)) / edgeSoft));
            grooveCrown = Math.pow(Math.max(0, 1.0 - normD * normD), 0.72);
            // Outer shoulder of a bristle (0.62 < normD < 0.98) gently carves a 3D furrow into the wet paint bed
            if (normD > 0.6 && normD < 0.98) {
              const tt = (normD - 0.6) / 0.38;
              troughCarve = Math.sin(tt * Math.PI) * bristleRelief * 0.42;
            }
            baseAlpha = (a0 + (a1 - a0) * t) * aaEdge;
          }
          if (baseAlpha <= 0.002) continue;

          // Sample spatial canvas tooth height H_canvas(x, y)
          const hCanvas = evaluateMappedSurfaceHeight(
            this.grainParams,
            px + 0.5,
            py + 0.5,
            arcU,
            acrossV,
            halfBrushW,
            segCos,
            segSin
          );

          const toothContact = evaluatePaintCanvasContact(
            hCanvas,
            effLoadForTooth,
            pressure,
            tiltMag,
            grainDepth,
            dryBrush,
            penCurve
          );

          const srcA = baseAlpha * toothContact;
          if (srcA <= 0.002) continue;

          const ch = this.getOrCreateChunk(px >> CHUNK_SHIFT, cy);
          const idx = lyOff + (px & CHUNK_MASK);

          const sr = r0 + (r1 - r0) * t;
          const sg = g0 + (g1 - g0) * t;
          const sb = b0 + (b1 - b0) * t;

          const prevArc = ch.lastArcU[idx];
          const prevBr = ch.lastBristle[idx];
          const isSamePass = prevArc > -9000 && Math.abs(arcU - prevArc) < selfPassWindow;
          const isSameBristle = isSamePass && prevBr === bristleIdx;

          // Continuous strand height: under-bed lays flat cushion; bristles pile thick sculpted crests on top!
          const rawH = h0 + (h1 - h0) * t;
          const strandH = isUnderBed
            ? rawH * grooveCrown * (0.45 + 0.55 * toothContact)
            : rawH * (0.12 + 1.05 * grooveCrown * (0.42 + 0.58 * bristleRelief)) * (0.35 + 0.65 * toothContact);

          const dstA = ch.a[idx];
          if (isUnderBed) {
            if (isSamePass) {
              // Under-bed never overwrites individual bristle colors or tall sculpted ridges on the same pass!
              if (srcA > dstA) {
                const fillW = (srcA - dstA) / Math.max(0.001, srcA);
                if (prevBr < 0) {
                  ch.r[idx] = sr;
                  ch.g[idx] = sg;
                  ch.b[idx] = sb;
                } else {
                  ch.r[idx] = ch.r[idx] * (1 - fillW) + sr * fillW;
                  ch.g[idx] = ch.g[idx] * (1 - fillW) + sg * fillW;
                  ch.b[idx] = ch.b[idx] * (1 - fillW) + sb * fillW;
                }
                ch.a[idx] = srcA;
              }
              if (strandH > ch.height[idx]) {
                ch.height[idx] = strandH;
              }
            } else {
              // Fresh pass under-bed lays down a fresh wet paint cushion over any older stroke
              const depositA = Math.min(1.0, srcA * 0.94);
              const outA = depositA + dstA * (1.0 - depositA);
              if (outA > 0.0005) {
                const invOut = 1.0 / outA;
                ch.r[idx] = (sr * depositA + ch.r[idx] * dstA * (1.0 - depositA)) * invOut;
                ch.g[idx] = (sg * depositA + ch.g[idx] * dstA * (1.0 - depositA)) * invOut;
                ch.b[idx] = (sb * depositA + ch.b[idx] * dstA * (1.0 - depositA)) * invOut;
                ch.a[idx] = outA;
              }
              ch.height[idx] = ch.height[idx] * (1.0 - depositA * 0.72) + strandH * (0.28 + depositA * 0.72);
              ch.lastBristle[idx] = -1;
            }
          } else if (isSameBristle) {
            // Same bristle continuing across consecutive slice joint -> strictly max envelope (zero dots!)
            if (srcA > dstA) {
              ch.r[idx] = sr;
              ch.g[idx] = sg;
              ch.b[idx] = sb;
              ch.a[idx] = srcA;
            }
            if (strandH > ch.height[idx]) {
              ch.height[idx] = strandH;
            }
          } else if (isSamePass) {
            // Individual bristle writing over the under-bed (prevBr === -1) or neighboring tuft in same sweep!
            const overBed = prevBr < 0;
            const targetA = Math.min(1.0, Math.max(dstA, srcA) + Math.min(dstA, srcA) * (overBed ? 0.35 : 0.25));
            if (targetA > 0.0005) {
              // Bristle's spatially-picked-up color dominates cleanly over the generic under-bed average!
              const blendW = overBed
                ? Math.min(0.92, srcA * 1.15)
                : srcA / Math.max(0.001, srcA + dstA);
              ch.r[idx] = ch.r[idx] * (1 - blendW) + sr * blendW;
              ch.g[idx] = ch.g[idx] * (1 - blendW) + sg * blendW;
              ch.b[idx] = ch.b[idx] * (1 - blendW) + sb * blendW;
              ch.a[idx] = targetA;
            }
            if (overBed) {
              // Pile sculpted crest up above the cushion, OR carve a recessed furrow along the bristle's shoulder!
              const sculptedH =
                troughCarve > 0.01
                  ? Math.max(ch.height[idx] * (1.0 - troughCarve), strandH)
                  : Math.max(ch.height[idx], ch.height[idx] * 0.42 + strandH);
              ch.height[idx] = sculptedH;
              if (grooveCrown > 0.25) ch.lastBristle[idx] = bristleIdx;
            } else {
              if (troughCarve > 0.01 && strandH < ch.height[idx]) {
                ch.height[idx] *= 1.0 - troughCarve * 0.35;
              } else if (strandH > ch.height[idx]) {
                ch.height[idx] = strandH;
                ch.lastBristle[idx] = bristleIdx;
              }
            }
          } else {
            // Fresh brush pass crossing over an earlier stroke pass -> carve fresh 3D ridges on top!
            const depositA = Math.min(1.0, srcA * 0.94);
            const outA = depositA + dstA * (1.0 - depositA);
            if (outA > 0.0005) {
              const invOut = 1.0 / outA;
              ch.r[idx] = (sr * depositA + ch.r[idx] * dstA * (1.0 - depositA)) * invOut;
              ch.g[idx] = (sg * depositA + ch.g[idx] * dstA * (1.0 - depositA)) * invOut;
              ch.b[idx] = (sb * depositA + ch.b[idx] * dstA * (1.0 - depositA)) * invOut;
              ch.a[idx] = outA;
            }
            ch.height[idx] = ch.height[idx] * (1.0 - depositA * 0.78) + strandH * (0.22 + depositA * 0.85);
            ch.lastBristle[idx] = bristleIdx;
          }

          ch.lastArcU[idx] = arcU;
          ch.tooth[idx] = hCanvas;
        }
      }
    }

    if (dMinX < this.minX) this.minX = dMinX;
    if (dMinY < this.minY) this.minY = dMinY;
    if (dMaxX > this.maxX) this.maxX = dMaxX;
    if (dMaxY > this.maxY) this.maxY = dMaxY;

    return { minX: dMinX, minY: dMinY, maxX: dMaxX, maxY: dMaxY };
  }

  /**
   * Shades a rectangular region of the stroke buffer into RGBA `ImageData` applying:
   * - Pre-smoothed Float32 height grid (silky, sculptural oil ridges with zero pixel grit!)
   * - 3D Impasto Relief Lighting (3x3 Sobel normals, directional diffuse, rich chromatic shadows,
   *   2-lobe oil gloss specular, warm studio key lift for dark pigments, and bristle-valley micro-AO)
   * - Canvas weave buried under thick oil and revealed crisply on thin outer fringes / dry-brush
   * - Watercolor paper-valley granulation & wet-edge rim darkening
   */
  public shadeRectToBuffer(
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    outRgba: Uint8ClampedArray
  ): void {
    const impastoOn = this.impasto.enabled && this.impasto.depth > 0.01;
    const impDepth = this.impasto.depth;
    const impGloss = this.impasto.gloss;
    const impContrast = this.impasto.reliefContrast;
    const grainDepth = this.grainParams.grainDepth;
    const granStrength = this.granulation;
    const wetEdgeStrength = this.wetEdge;

    const { lx, ly, lz } = computeImpastoLightVector(
      this.impasto.lightAzimuth,
      this.impasto.lightElevation
    );
    // Blinn-Phong half-vector for view V = (0, 0, 1)
    const hx = lx;
    const hy = ly;
    const hz = lz + 1.0;
    const hLen = Math.hypot(hx, hy, hz) || 1;
    const nhx = hx / hLen;
    const nhy = hy / hLen;
    const nhz = hz / hLen;

    const reliefScale = 4.6 + impDepth * 9.2;
    const toothReliefScale = (2.2 + grainDepth * 5.2) * (0.55 + impContrast * 0.65);
    const satinExp = 10 + impGloss * 11;
    const glossExp = 30 + impGloss * 46;
    const satinAmp = (0.12 + impGloss * 0.24) * (0.45 + impDepth * 0.6);
    const glossAmp = impGloss * (0.24 + impDepth * 0.44);
    const diffAmp = 0.36 + impContrast * 0.52;

    // Horizontal directional light unit vector & calibrated raking ray slope for real 3D heightfield cast shadows!
    const horizLen = Math.hypot(lx, ly) || 1;
    const dlx = lx / horizLen;
    const dly = ly / horizLen;
    // Lower raking ray slope lets 3D impasto ridges physically cast crisp 2-9px shadows into grooves & onto canvas!
    const raySlope = (lz / horizLen) * 0.088;

    // Pre-build dual-frequency Float32 grids (gw x gh with 10px border for 8-tap directional cast shadow reach!)
    const border = impastoOn ? 10 : 2;
    const gw = rw + border * 2;
    const gh = rh + border * 2;
    let smoothPaintH: Float32Array | null = null;
    let rawToothGrid: Float32Array | null = null;
    if (impastoOn) {
      const needed = gw * gh;
      if (this.hGridRaw.length < needed) {
        this.hGridRaw = new Float32Array(needed);
        this.hGridTmp = new Float32Array(needed);
        this.hGridSmooth = new Float32Array(needed);
        this.toothGrid = new Float32Array(needed);
      }
      const rawH = this.hGridRaw;
      const tmpH = this.hGridTmp;
      smoothPaintH = this.hGridSmooth;
      rawToothGrid = this.toothGrid;

      // Stage 1: Single-lookup dual-channel extraction:
      // - rawH: pure sculptural paint thickness (zero weave blur contamination!)
      // - rawToothGrid: unblurred high-DPI surface weave fallback
      for (let gy = 0; gy < gh; gy++) {
        const wy = ry + gy - border;
        const cy = wy >> CHUNK_SHIFT;
        const lyOff = (wy & CHUNK_MASK) << CHUNK_SHIFT;
        const rowOff = gy * gw;
        for (let gx = 0; gx < gw; gx++) {
          const wx = rx + gx - border;
          const ch = this.getChunk(wx >> CHUNK_SHIFT, cy);
          if (!ch) {
            rawH[rowOff + gx] = 0;
            rawToothGrid[rowOff + gx] = 0.5;
            continue;
          }
          const idx = lyOff + (wx & CHUNK_MASK);
          const a = ch.a[idx];
          rawToothGrid[rowOff + gx] = ch.tooth[idx];
          if (a <= 0.002) {
            rawH[rowOff + gx] = 0;
            continue;
          }
          // Pure volumetric paint height (thick oil ridges rise high, edges taper naturally to canvas)
          rawH[rowOff + gx] = ch.height[idx] * impDepth * 1.75 * Math.min(1.0, a * 1.45);
        }
      }

      // Stage 2: 1 gentle separable pass [0.22, 0.56, 0.22] on PURE paint volume ONLY!
      for (let gy = 0; gy < gh; gy++) {
        const row = gy * gw;
        tmpH[row] = rawH[row];
        tmpH[row + gw - 1] = rawH[row + gw - 1];
        for (let gx = 1; gx < gw - 1; gx++) {
          tmpH[row + gx] =
            rawH[row + gx - 1] * 0.22 + rawH[row + gx] * 0.56 + rawH[row + gx + 1] * 0.22;
        }
      }
      for (let gx = 0; gx < gw; gx++) {
        smoothPaintH[gx] = tmpH[gx];
        smoothPaintH[(gh - 1) * gw + gx] = tmpH[(gh - 1) * gw + gx];
      }
      for (let gy = 1; gy < gh - 1; gy++) {
        const rowU = (gy - 1) * gw;
        const rowC = gy * gw;
        const rowD = (gy + 1) * gw;
        for (let gx = 0; gx < gw; gx++) {
          smoothPaintH[rowC + gx] =
            tmpH[rowU + gx] * 0.22 + tmpH[rowC + gx] * 0.56 + tmpH[rowD + gx] * 0.22;
        }
      }
    }

    // Fast bilinear height sampler inside smoothPaintH for smooth diagonal directional cast-shadow rays
    const sampleSmoothBilinear = (fx: number, fy: number): number => {
      if (!smoothPaintH) return 0;
      const ix = fx | 0;
      const iy = fy | 0;
      if (ix < 0 || iy < 0 || ix >= gw - 1 || iy >= gh - 1) return 0;
      const tx = fx - ix;
      const ty = fy - iy;
      const r0 = iy * gw + ix;
      const r1 = r0 + gw;
      const v00 = smoothPaintH[r0];
      const v10 = smoothPaintH[r0 + 1];
      const v01 = smoothPaintH[r1];
      const v11 = smoothPaintH[r1 + 1];
      const top = v00 + (v10 - v00) * tx;
      const bot = v01 + (v11 - v01) * tx;
      return top + (bot - top) * ty;
    };

    const marchCastShadow = (gxIdx: number, gyIdx: number, h0: number): number => {
      let maxOcc = 0;
      // 8 physical horizon-shadow taps marching toward the directional light source (1.0px .. 8.0px)
      for (let step = 1; step <= 8; step++) {
        const dist = step * 1.0;
        const hS = sampleSmoothBilinear(gxIdx + dlx * dist, gyIdx + dly * dist);
        const occ = hS - (h0 + raySlope * dist);
        if (occ > 0) {
          // Crisp hugging contact shadow near the paint rim, softening naturally into a delicate penumbra
          const distFade = Math.max(0, 1.0 - dist * 0.115);
          const soft = occ * distFade * distFade * 1.25;
          if (soft > maxOcc) maxOcc = soft;
        }
      }
      return Math.min(1.0, maxOcc * (1.55 + impContrast * 1.45));
    };

    // Use true 2x-DPI analytical surface gradients for built-in canvas-locked / random-per-stroke textures
    const canUseAnalyticalToothGrad =
      !this.grainParams.customTex &&
      (this.grainParams.mappingMode === 'canvas-locked' ||
        this.grainParams.mappingMode === 'random-per-stroke');
    const gradScratch = { gx: 0, gy: 0 };

    for (let y = 0; y < rh; y++) {
      const wy = ry + y;
      const cy = wy >> CHUNK_SHIFT;
      const lyOff = (wy & CHUNK_MASK) << CHUNK_SHIFT;
      const rowOut = y * rw * 4;
      const gyIdx = y + border;
      const gRowU = (gyIdx - 1) * gw;
      const gRowC = gyIdx * gw;
      const gRowD = (gyIdx + 1) * gw;

      for (let x = 0; x < rw; x++) {
        const wx = rx + x;
        const ch = this.getChunk(wx >> CHUNK_SHIFT, cy);
        const outIdx = rowOut + x * 4;
        const gxIdx = x + border;

        const idx = ch ? lyOff + (wx & CHUNK_MASK) : -1;
        let alpha = ch ? ch.a[idx] : 0;

        // Bare canvas / lower-layer pixel: check if a genuinely thick impasto ridge casts a subtle shadow
        if (alpha <= 0.003) {
          if (impastoOn && impDepth > 0.25 && smoothPaintH) {
            const castS = marchCastShadow(gxIdx, gyIdx, 0);
            if (castS > 0.08) {
              const shadowAlpha = Math.min(0.18, Math.pow(castS, 1.35) * (0.08 + impDepth * 0.14));
              outRgba[outIdx] = 26;
              outRgba[outIdx + 1] = 22;
              outRgba[outIdx + 2] = 34;
              outRgba[outIdx + 3] = Math.round(shadowAlpha * 255);
              continue;
            }
          }
          outRgba[outIdx] = 0;
          outRgba[outIdx + 1] = 0;
          outRgba[outIdx + 2] = 0;
          outRgba[outIdx + 3] = 0;
          continue;
        }

        let r = ch!.r[idx];
        let g = ch!.g[idx];
        let b = ch!.b[idx];
        const tooth = ch!.tooth[idx];
        const hp = ch!.height[idx];

        // Watercolor granulation: pigment particles settle into recessed paper valleys
        if (granStrength > 0.01) {
          const valley = 1.0 - tooth;
          const granDark = 1.0 - valley * granStrength * 0.34;
          r *= granDark;
          g *= granDark;
          b *= granDark;
          alpha = Math.min(1.0, alpha * (0.82 + valley * granStrength * 0.42));
        }

        // Watercolor wet-edge rim pooling at paint-alpha transition boundaries
        if (wetEdgeStrength > 0.01) {
          const aL = this.sampleAccumHeight(wx - 2, wy).alpha;
          const aR = this.sampleAccumHeight(wx + 2, wy).alpha;
          const aU = this.sampleAccumHeight(wx, wy - 2).alpha;
          const aD = this.sampleAccumHeight(wx, wy + 2).alpha;
          const avgNeighbor = (aL + aR + aU + aD) * 0.25;
          const rim = Math.max(0, alpha - avgNeighbor) * 2.5;
          if (rim > 0.02) {
            const rimDark = Math.max(0.45, 1.0 - rim * wetEdgeStrength * 0.42);
            r *= rimDark;
            g *= rimDark;
            b *= rimDark;
            alpha = Math.min(1.0, alpha * (1.0 + rim * wetEdgeStrength * 0.55));
          }
        }

        // 3D Sculptural Impasto Relief + 2x-DPI Analytical Canvas Weave Normals + Real 8-Tap Directional Cast Shadows!
        if (impastoOn && smoothPaintH && rawToothGrid) {
          const hTL = smoothPaintH[gRowU + gxIdx - 1];
          const hT  = smoothPaintH[gRowU + gxIdx];
          const hTR = smoothPaintH[gRowU + gxIdx + 1];
          const hL  = smoothPaintH[gRowC + gxIdx - 1];
          const hC  = smoothPaintH[gRowC + gxIdx];
          const hR  = smoothPaintH[gRowC + gxIdx + 1];
          const hBL = smoothPaintH[gRowD + gxIdx - 1];
          const hB  = smoothPaintH[gRowD + gxIdx];
          const hBR = smoothPaintH[gRowD + gxIdx + 1];

          // Macro sculptural oil paint gradients
          const gxPaint = (hTR + 2 * hR + hBR) - (hTL + 2 * hL + hBL);
          const gyPaint = (hBL + 2 * hB + hBR) - (hTL + 2 * hT + hTR);

          // True 2x-DPI analytical surface weave micro-normals (silky & crisp even at 300% zoom!)
          const paintCover = Math.min(1.0, hp * 1.22);
          const weaveWeight = (Math.pow(1.0 - paintCover, 1.45) * 0.85 + 0.14) * grainDepth;
          let gxTooth = 0;
          let gyTooth = 0;
          if (weaveWeight > 0.01) {
            if (canUseAnalyticalToothGrad) {
              let sx = wx + 0.5;
              let sy = wy + 0.5;
              if (this.grainParams.mappingMode === 'random-per-stroke') {
                const rxp = sx * this.grainParams.strokeCos - sy * this.grainParams.strokeSin + this.grainParams.strokeOffsetX;
                const ryp = sx * this.grainParams.strokeSin + sy * this.grainParams.strokeCos + this.grainParams.strokeOffsetY;
                sx = rxp;
                sy = ryp;
              }
              sampleSurfaceTextureGrad(
                this.grainParams.surfaceId,
                sx,
                sy,
                this.grainParams.scale,
                this.grainParams.rotateRad,
                gradScratch
              );
              const invSign = this.grainParams.inverted ? -1 : 1;
              gxTooth = gradScratch.gx * weaveWeight * invSign * 2.2;
              gyTooth = gradScratch.gy * weaveWeight * invSign * 2.2;
            } else {
              const rawH = this.hGridRaw;
              const tC = rawToothGrid[gRowC + gxIdx];
              const tL = rawH[gRowC + gxIdx - 1] > 0.0001 ? rawToothGrid[gRowC + gxIdx - 1] : tC;
              const tR = rawH[gRowC + gxIdx + 1] > 0.0001 ? rawToothGrid[gRowC + gxIdx + 1] : tC;
              const tU = rawH[gRowU + gxIdx] > 0.0001 ? rawToothGrid[gRowU + gxIdx] : tC;
              const tD = rawH[gRowD + gxIdx] > 0.0001 ? rawToothGrid[gRowD + gxIdx] : tC;
              gxTooth = (tR - tL) * weaveWeight;
              gyTooth = (tD - tU) * weaveWeight;
            }
          }

          const nx = -(gxPaint * reliefScale + gxTooth * toothReliefScale);
          const ny = -(gyPaint * reliefScale + gyTooth * toothReliefScale);
          const nz = 1.0;
          const nLen = Math.hypot(nx, ny, nz) || 1;
          const nnx = nx / nLen;
          const nny = ny / nLen;
          const nnz = nz / nLen;

          const gradMag = Math.hypot(gxPaint, gyPaint) + Math.hypot(gxTooth, gyTooth) * 0.45;
          const slopeMask = Math.min(1.0, gradMag * 2.8);

          // Centered directional diffuse: flat paint (0,0,1) produces delta=0 (preserves true pigment hue!)
          const nDotL = nnx * lx + nny * ly + nnz * lz;
          const rawDiff = nDotL - lz;
          const diffuseDelta = rawDiff * diffAmp;

          // Real directional 3D cast self-shadow from neighboring taller bristle ridges!
          const castShadow = marchCastShadow(gxIdx, gyIdx, hC);
          const castDarken = castShadow * (0.30 + impContrast * 0.26);

          // Deep bristle-valley micro-AO + crisp micro-interstice weave AO
          const avgH = (hT + hB + hL + hR + (hTL + hTR + hBL + hBR) * 0.5) / 6.0;
          const concavity = Math.max(0, avgH - hC);
          const weaveCreviceAO = (1.0 - tooth) * weaveWeight * 0.14;
          const baseLum = (r * 0.299 + g * 0.587 + b * 0.114) / 255.0;
          // Physical oil subsurface scattering: light translucent pigments hold rich luminous shadows!
          const sssFloor = 0.44 + baseLum * 0.18;
          const ao = Math.min(0.28, concavity * (1.0 + impContrast * 1.5)) + weaveCreviceAO;

          const shadeMult = Math.max(sssFloor, Math.min(1.28, 1.0 + diffuseDelta - ao - castDarken));

          // Chromatic richness in shadows: real oil crevices & cast shadows deepen in chroma instead of muddying!
          const shadowAmt = Math.max(0, 1.0 - shadeMult);
          if (shadowAmt > 0.02) {
            const lum = r * 0.299 + g * 0.587 + b * 0.114;
            const satBoost = 1.0 + shadowAmt * 0.50;
            r = Math.max(0, Math.min(255, lum + (r - lum) * satBoost));
            g = Math.max(0, Math.min(255, lum + (g - lum) * satBoost));
            b = Math.max(0, Math.min(255, lum + (b - lum) * satBoost));
          }

          // Physically suppress specular reflections inside real directional cast shadows!
          const specVis = Math.max(0.06, 1.0 - castShadow * 0.88);
          const oilThicknessMask = Math.min(1.0, 0.24 + hp * 1.15) * specVis;

          // Adaptive sheen: dark/black oil gets crisp sculptural studio sheen; bright oil gets soft creamy luster!
          const darkSheenBoost = 1.55 - baseLum * 0.94;
          const litSlope = Math.max(0, rawDiff) * slopeMask * oilThicknessMask;
          const keyLift = litSlope * (0.20 + impGloss * 0.30) * (0.45 + impContrast * 0.55) * 110 * darkSheenBoost;

          // Two-lobe oil sheen (broad satin wrap + crisp glossy crest catchlights)
          const nDotH = Math.max(0, nnx * nhx + nny * nhy + nnz * nhz);
          const satinSpec = Math.pow(nDotH, satinExp) * satinAmp * slopeMask * oilThicknessMask * 124 * darkSheenBoost;
          const crispSpec = Math.pow(nDotH, glossExp) * glossAmp * slopeMask * oilThicknessMask * 195 * darkSheenBoost;
          const totalSpec = keyLift + satinSpec + crispSpec;

          // Warm studio light tint on highlights (#fffbf2) + rich sculpted shadows
          r = Math.max(0, Math.min(255, r * shadeMult + totalSpec * 1.0));
          g = Math.max(0, Math.min(255, g * shadeMult + totalSpec * 0.985));
          b = Math.max(0, Math.min(255, b * shadeMult + totalSpec * 0.955));

          // Subtle under-edge cast shadow only on thick impasto ridges (never darkens thin blended edges)
          if (alpha < 0.98 && impDepth > 0.25 && castShadow > 0.08) {
            const underShadowA = Math.min(0.18, Math.pow(castShadow, 1.35) * (0.08 + impDepth * 0.14));
            const outA = alpha + underShadowA * (1.0 - alpha);
            if (outA > 0.001) {
              const invOut = 1.0 / outA;
              const bgW = underShadowA * (1.0 - alpha);
              r = (r * alpha + 26 * bgW) * invOut;
              g = (g * alpha + 22 * bgW) * invOut;
              b = (b * alpha + 34 * bgW) * invOut;
              alpha = outA;
            }
          }
        }

        outRgba[outIdx] = Math.round(r);
        outRgba[outIdx + 1] = Math.round(g);
        outRgba[outIdx + 2] = Math.round(b);
        outRgba[outIdx + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
      }
    }
  }

  /**
   * Blits a shaded dirty region onto a target Canvas2D context using full Float32 height
   * precision so live draft rendering and pointer-up tile commits are 100% pixel-identical
   * with zero 8-bit height banding and zero clip seams.
   */
  public flushDirtyRectToContext(
    ctx: CanvasRenderingContext2D,
    dirty: { minX: number; minY: number; maxX: number; maxY: number },
    replaceRegion: boolean = false,
    opacity: number = 1.0,
    compositeOp: GlobalCompositeOperation = 'source-over'
  ): void {
    // Expand by 11px when impasto cast shadows are active so 9.6px directional drop shadows never clip!
    const impastoOn = this.impasto.enabled && this.impasto.depth > 0.01;
    const pad = impastoOn ? 11 : this.wetEdge > 0.01 ? 4 : 3;
    const rx = Math.floor(dirty.minX) - pad;
    const ry = Math.floor(dirty.minY) - pad;
    const rw = Math.ceil(dirty.maxX) + pad - rx;
    const rh = Math.ceil(dirty.maxY) + pad - ry;
    if (rw <= 0 || rh <= 0) return;

    if (typeof document === 'undefined') return;
    if (!this.scratchCanvas) {
      this.scratchCanvas = document.createElement('canvas');
      this.scratchCtx = this.scratchCanvas.getContext('2d');
    }
    if (!this.scratchCanvas || !this.scratchCtx) return;

    if (this.scratchCanvas.width < rw || this.scratchCanvas.height < rh) {
      this.scratchCanvas.width = Math.max(this.scratchCanvas.width, rw);
      this.scratchCanvas.height = Math.max(this.scratchCanvas.height, rh);
    }

    const imgData = this.scratchCtx.createImageData(rw, rh);
    this.shadeRectToBuffer(rx, ry, rw, rh, imgData.data);
    this.scratchCtx.putImageData(imgData, 0, 0);

    ctx.save();
    if (replaceRegion) {
      ctx.clearRect(rx, ry, rw, rh);
    }
    ctx.globalCompositeOperation = compositeOp;
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
    ctx.drawImage(this.scratchCanvas, 0, 0, rw, rh, rx, ry, rw, rh);
    ctx.restore();
  }

  public stampInitialPoint(
    ctx: CanvasRenderingContext2D,
    pt: Point,
    sampler?: LayerPixelSampler,
    replaceRegion: boolean = true
  ): void {
    // Anchor the bristle frame without emitting an arbitrarily-oriented start bar (zero detached stub!)
    this.pendingTapPoint = pt;
    this.hasEmittedSegment = false;
    const batch = this.engine.emitInitialStamp(pt, sampler, undefined, false);
    const dirty = this.rasterizeBatch(batch);
    if (dirty) {
      this.flushDirtyRectToContext(ctx, dirty, replaceRegion, 1.0, 'source-over');
    }
  }

  public flushPendingTapIfNeeded(sampler?: LayerPixelSampler): void {
    if (!this.hasEmittedSegment && this.pendingTapPoint) {
      const tapBatch = this.engine.emitInitialStamp(this.pendingTapPoint, sampler, undefined, true);
      this.rasterizeBatch(tapBatch);
      this.pendingTapPoint = null;
    }
  }

  public drawCubicSegment(
    ctx: CanvasRenderingContext2D,
    p0: Point,
    c1: Point,
    c2: Point,
    p3: Point,
    sampler?: LayerPixelSampler,
    replaceRegion: boolean = true
  ): void {
    this.hasEmittedSegment = true;
    this.pendingTapPoint = null;
    const batch = this.engine.emitCubicSegment(p0, c1, c2, p3, sampler);
    const dirty = this.rasterizeBatch(batch);
    if (dirty) {
      this.flushDirtyRectToContext(ctx, dirty, replaceRegion, 1.0, 'source-over');
    }
  }

  public getDirtyBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (!Number.isFinite(this.minX) || !Number.isFinite(this.maxX)) return null;
    return { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY };
  }

  public finishAndDispose(): void {
    this.engine.finishStroke();
    for (const ch of this.chunks.values()) {
      releaseChunk(ch);
    }
    this.chunks.clear();
  }
}

/**
 * Renders an entire completed Natural Paint stroke deterministically onto `ctx`
 * (used by pointer-up bake, Brush Studio scratchpad, brush previews, and headless tests).
 */
export function renderCompleteNaturalPaintStroke(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  settings: BrushSettings,
  strokeColor: string,
  sampler?: LayerPixelSampler,
  opacity: number = 1.0,
  compositeOp: GlobalCompositeOperation = 'source-over',
  strokeSeed: number = 1337
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!points || points.length === 0) return null;

  let totalLen = 0;
  for (let i = 1; i < points.length; i++) {
    totalLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }

  const session = new NaturalPaintStrokeSession(settings, strokeColor, totalLen, strokeSeed);

  let initialDir: { dx: number; dy: number } | undefined;
  if (points.length >= 2) {
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[0].x;
      const dy = points[i].y - points[0].y;
      if (Math.hypot(dx, dy) > 0.5) {
        initialDir = { dx, dy };
        break;
      }
    }
  }

  // Emit tap dot only for single-point taps; multi-point strokes start cleanly along initialDir!
  const initBatch = session.engine.emitInitialStamp(points[0], sampler, initialDir, !initialDir);
  session.rasterizeBatch(initBatch);

  if (points.length === 2) {
    const p0 = points[0];
    const p1 = points[1];
    const { c1, c2 } = centripetalCatmullRomToBezier(p0, p0, p1, p1);
    const b = session.engine.emitCubicSegment(p0, c1, c2, p1, sampler);
    session.rasterizeBatch(b);
  } else if (points.length >= 3) {
    const first = centripetalCatmullRomToBezier(points[0], points[0], points[1], points[2]);
    session.rasterizeBatch(session.engine.emitCubicSegment(points[0], first.c1, first.c2, points[1], sampler));

    for (let i = 2; i < points.length - 1; i++) {
      const seg = centripetalCatmullRomToBezier(points[i - 2], points[i - 1], points[i], points[i + 1]);
      session.rasterizeBatch(session.engine.emitCubicSegment(points[i - 1], seg.c1, seg.c2, points[i], sampler));
    }

    const n = points.length;
    const last = centripetalCatmullRomToBezier(points[n - 3], points[n - 2], points[n - 1], points[n - 1]);
    session.rasterizeBatch(session.engine.emitCubicSegment(points[n - 2], last.c1, last.c2, points[n - 1], sampler));
  }

  const bounds = session.getDirtyBounds();
  if (bounds) {
    session.flushDirtyRectToContext(ctx, bounds, false, opacity, compositeOp);
  }
  session.finishAndDispose();
  return bounds;
}
