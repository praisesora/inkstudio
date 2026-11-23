/**
 * Professional Gradient Engine — Linear, Radial, and Bicubic Mesh Gradients
 *
 * Tile-native rasterization directly into SparseTileGrid with:
 * - Multi-stop RGBA color interpolation (clamp, repeat, reflect)
 * - 4x4 Bayer ordered dithering to eliminate 8-bit banding
 * - Blend modes (normal, multiply, screen, overlay) + alpha-lock + selection mask clipping
 * - Catmull-Rom / bicubic subdivided Mesh Gradient with Gouraud triangle scanline rasterizer
 */

import type {
  CanvasDimensions,
  CanvasSelection,
  DirtyRect,
  Point2D,
  TileDelta,
} from '../types/editor';
import { createSelectionMask } from './tonalEngine';
import { RgbColor, mixPigmentRgbOut } from './colorMixingEngine';

const _gradMixOut: RgbColor = { r: 0, g: 0, b: 0 };
import {
  BYTES_32BIT,
  SparseTileGrid,
  TILE_SIZE,
  TileFormat,
  TileSnapshotEntry,
  packRGBATo1Bit,
  packRGBATo8Bit,
  unpack1BitToRGBA,
  unpack8BitToRGBA,
} from './tileEngine';

export type GradientType = 'linear' | 'radial' | 'mesh';
export type GradientRepeatMode = 'clamp' | 'repeat' | 'reflect';
export type GradientBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay';

export interface GradientToolStop {
  id: string;
  offset: number; // 0..1
  color: string; // #rrggbb
  opacity: number; // 0..1
}

export interface GradientMeshNode {
  x: number; // canvas coordinates
  y: number; // canvas coordinates
  color: string; // #rrggbb
  opacity: number; // 0..1
}

export interface GradientMeshState {
  cols: number;
  rows: number;
  nodes: GradientMeshNode[]; // row-major length = rows * cols
  selectedNodeIndex: number | null;
}

export interface GradientSettings {
  type: GradientType;
  stops: GradientToolStop[];
  useForegroundBackground: boolean;
  opacity: number; // 0.01..1
  blendMode: GradientBlendMode;
  repeat: GradientRepeatMode;
  dither: boolean;
  pigmentBlending?: boolean;
  reverse: boolean;
  meshCols: number; // 2..6
  meshRows: number; // 2..6
}

export interface GradientDragPreview {
  type: 'linear' | 'radial';
  start: Point2D;
  end: Point2D;
  settings: GradientSettings;
}

export interface GradientPreset {
  id: string;
  name: string;
  useForegroundBackground?: boolean;
  stops: Array<{ offset: number; color: string; opacity: number }>;
}

export const GRADIENT_PRESETS: readonly GradientPreset[] = [
  {
    id: 'fg-bg',
    name: 'FG to BG',
    useForegroundBackground: true,
    stops: [
      { offset: 0, color: '#000000', opacity: 1 },
      { offset: 1, color: '#ffffff', opacity: 1 },
    ],
  },
  {
    id: 'fg-transparent',
    name: 'FG to Clear',
    useForegroundBackground: false,
    stops: [
      { offset: 0, color: '#000000', opacity: 1 },
      { offset: 1, color: '#000000', opacity: 0 },
    ],
  },
  {
    id: 'sunset',
    name: 'Sunset',
    useForegroundBackground: false,
    stops: [
      { offset: 0, color: '#1e1b4b', opacity: 1 },
      { offset: 0.45, color: '#be185d', opacity: 1 },
      { offset: 0.78, color: '#f97316', opacity: 1 },
      { offset: 1, color: '#fde047', opacity: 1 },
    ],
  },
  {
    id: 'sky',
    name: 'Sky',
    useForegroundBackground: false,
    stops: [
      { offset: 0, color: '#0c4a6e', opacity: 1 },
      { offset: 0.55, color: '#38bdf8', opacity: 1 },
      { offset: 1, color: '#f0f9ff', opacity: 1 },
    ],
  },
  {
    id: 'chrome',
    name: 'Chrome',
    useForegroundBackground: false,
    stops: [
      { offset: 0, color: '#111827', opacity: 1 },
      { offset: 0.35, color: '#e5e7eb', opacity: 1 },
      { offset: 0.52, color: '#374151', opacity: 1 },
      { offset: 0.8, color: '#f9fafb', opacity: 1 },
      { offset: 1, color: '#1f2937', opacity: 1 },
    ],
  },
  {
    id: 'spectrum',
    name: 'Spectrum',
    useForegroundBackground: false,
    stops: [
      { offset: 0, color: '#ef4444', opacity: 1 },
      { offset: 0.2, color: '#f59e0b', opacity: 1 },
      { offset: 0.4, color: '#22c55e', opacity: 1 },
      { offset: 0.6, color: '#06b6d4', opacity: 1 },
      { offset: 0.8, color: '#6366f1', opacity: 1 },
      { offset: 1, color: '#ec4899', opacity: 1 },
    ],
  },
];

export const DEFAULT_GRADIENT_SETTINGS: GradientSettings = {
  type: 'linear',
  stops: [
    { id: 'stop-0', offset: 0, color: '#000000', opacity: 1 },
    { id: 'stop-1', offset: 1, color: '#ffffff', opacity: 1 },
  ],
  useForegroundBackground: true,
  opacity: 1,
  blendMode: 'normal',
  repeat: 'clamp',
  dither: true,
  pigmentBlending: false,
  reverse: false,
  meshCols: 3,
  meshRows: 3,
};

// Normalized 4x4 Bayer matrix in [-0.5, +0.5] for 8-bit anti-banding dither
const BAYER_4X4 = new Float32Array([
  0 / 16 - 0.5, 8 / 16 - 0.5, 2 / 16 - 0.5, 10 / 16 - 0.5,
  12 / 16 - 0.5, 4 / 16 - 0.5, 14 / 16 - 0.5, 6 / 16 - 0.5,
  3 / 16 - 0.5, 11 / 16 - 0.5, 1 / 16 - 0.5, 9 / 16 - 0.5,
  15 / 16 - 0.5, 7 / 16 - 0.5, 13 / 16 - 0.5, 5 / 16 - 0.5,
]);

export interface ParsedRgbaStop {
  offset: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseHexRgb(hex: string): [number, number, number] {
  if (typeof hex !== 'string') return [0, 0, 0];
  const cleaned = hex.trim().replace(/^#/, '');
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0] + cleaned[0], 16);
    const g = parseInt(cleaned[1] + cleaned[1], 16);
    const b = parseInt(cleaned[2] + cleaned[2], 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return [r, g, b];
    }
  } else if (cleaned.length >= 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      return [r, g, b];
    }
  }
  return [0, 0, 0];
}

export function resolveGradientStops(
  settings: GradientSettings,
  primaryColor: string,
  secondaryColor: string
): ParsedRgbaStop[] {
  const raw = settings.stops.length >= 2 ? settings.stops : DEFAULT_GRADIENT_SETTINGS.stops;
  const sorted = [...raw]
    .map((s) => ({
      offset: Math.max(0, Math.min(1, Number.isFinite(s.offset) ? s.offset : 0)),
      color: s.color,
      opacity: Math.max(0, Math.min(1, Number.isFinite(s.opacity) ? s.opacity : 1)),
    }))
    .sort((a, b) => a.offset - b.offset);

  if (settings.useForegroundBackground && sorted.length >= 2) {
    sorted[0] = { ...sorted[0], color: primaryColor || '#000000' };
    sorted[sorted.length - 1] = {
      ...sorted[sorted.length - 1],
      color: secondaryColor || '#ffffff',
    };
  }

  return sorted.map((s) => {
    const [r, g, b] = parseHexRgb(s.color);
    return { offset: s.offset, r, g, b, a: s.opacity * 255 };
  });
}

function wrapGradientT(t: number, repeat: GradientRepeatMode, reverse: boolean): number {
  let u = Number.isFinite(t) ? t : 0;
  if (repeat === 'repeat') {
    u = u - Math.floor(u);
  } else if (repeat === 'reflect') {
    const period = u - 2 * Math.floor(u * 0.5);
    u = period <= 1 ? period : 2 - period;
  } else {
    u = u < 0 ? 0 : u > 1 ? 1 : u;
  }
  return reverse ? 1 - u : u;
}

/**
 * Evaluates multi-stop RGBA color at scalar position `t`.
 */
export function sampleGradientStops(
  stops: readonly ParsedRgbaStop[],
  t: number,
  repeat: GradientRepeatMode,
  reverse: boolean,
  out: [number, number, number, number],
  pigmentBlending: boolean = false
): void {
  if (stops.length === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    return;
  }
  const u = wrapGradientT(t, repeat, reverse);
  if (u <= stops[0].offset || stops.length === 1) {
    const s = stops[0];
    out[0] = s.r;
    out[1] = s.g;
    out[2] = s.b;
    out[3] = s.a;
    return;
  }
  const last = stops[stops.length - 1];
  if (u >= last.offset) {
    out[0] = last.r;
    out[1] = last.g;
    out[2] = last.b;
    out[3] = last.a;
    return;
  }

  let hi = 1;
  while (hi < stops.length - 1 && stops[hi].offset < u) {
    hi++;
  }
  const s0 = stops[hi - 1];
  const s1 = stops[hi];
  const span = s1.offset - s0.offset;
  const f = span > 1e-6 ? (u - s0.offset) / span : 0;
  if (pigmentBlending) {
    mixPigmentRgbOut(s0.r, s0.g, s0.b, s1.r, s1.g, s1.b, f, 1.0, _gradMixOut);
    out[0] = _gradMixOut.r;
    out[1] = _gradMixOut.g;
    out[2] = _gradMixOut.b;
  } else {
    out[0] = s0.r + (s1.r - s0.r) * f;
    out[1] = s0.g + (s1.g - s0.g) * f;
    out[2] = s0.b + (s1.b - s0.b) * f;
  }
  out[3] = s0.a + (s1.a - s0.a) * f;
}

/**
 * Snaps end point to 15-degree increments relative to start when Shift is held.
 */
export function constrainGradientEndpoint(start: Point2D, end: Point2D): Point2D {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) return end;
  const angle = Math.atan2(dy, dx);
  const snapped = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
  return {
    x: start.x + Math.cos(snapped) * len,
    y: start.y + Math.sin(snapped) * len,
  };
}

/**
 * Generates an initial interactive Mesh Gradient grid over `bounds`.
 */
export function createDefaultGradientMesh(
  bounds: { x: number; y: number; width: number; height: number },
  cols: number,
  rows: number,
  primaryColor: string,
  secondaryColor: string,
  stops?: readonly GradientToolStop[]
): GradientMeshState {
  const cCount = Math.max(2, Math.min(6, Math.round(cols)));
  const rCount = Math.max(2, Math.min(6, Math.round(rows)));
  const w = Math.max(1, bounds.width);
  const h = Math.max(1, bounds.height);

  const cornerColors = [
    primaryColor || '#3b82f6',
    secondaryColor || '#f43f5e',
    stops && stops.length > 2 ? stops[Math.floor(stops.length / 2)].color : '#10b981',
    stops && stops.length > 0 ? stops[stops.length - 1].color : '#f59e0b',
  ];
  const parsedCorners = cornerColors.map((c) => parseHexRgb(c));

  const nodes: GradientMeshNode[] = [];
  for (let r = 0; r < rCount; r++) {
    const v = rCount > 1 ? r / (rCount - 1) : 0;
    for (let c = 0; c < cCount; c++) {
      const u = cCount > 1 ? c / (cCount - 1) : 0;
      const topR = parsedCorners[0][0] * (1 - u) + parsedCorners[1][0] * u;
      const topG = parsedCorners[0][1] * (1 - u) + parsedCorners[1][1] * u;
      const topB = parsedCorners[0][2] * (1 - u) + parsedCorners[1][2] * u;
      const botR = parsedCorners[2][0] * (1 - u) + parsedCorners[3][0] * u;
      const botG = parsedCorners[2][1] * (1 - u) + parsedCorners[3][1] * u;
      const botB = parsedCorners[2][2] * (1 - u) + parsedCorners[3][2] * u;
      const rr = Math.round(topR * (1 - v) + botR * v);
      const gg = Math.round(topG * (1 - v) + botG * v);
      const bb = Math.round(topB * (1 - v) + botB * v);
      const hex =
        '#' +
        rr.toString(16).padStart(2, '0') +
        gg.toString(16).padStart(2, '0') +
        bb.toString(16).padStart(2, '0');
      nodes.push({
        x: bounds.x + u * w,
        y: bounds.y + v * h,
        color: hex,
        opacity: 1,
      });
    }
  }

  return {
    cols: cCount,
    rows: rCount,
    nodes,
    selectedNodeIndex: 0,
  };
}

function blendChannel(src: number, dst: number, mode: GradientBlendMode): number {
  const s = src / 255;
  const d = dst / 255;
  let out: number;
  switch (mode) {
    case 'multiply':
      out = s * d;
      break;
    case 'screen':
      out = 1 - (1 - s) * (1 - d);
      break;
    case 'overlay':
      out = d < 0.5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d);
      break;
    case 'normal':
    default:
      out = s;
      break;
  }
  return out * 255;
}

function compositePixelInPlace(
  buf: Uint8ClampedArray,
  idx: number,
  sr: number,
  sg: number,
  sb: number,
  saNorm: number,
  blendMode: GradientBlendMode,
  alphaLock: boolean,
  ditherVal: number
): void {
  if (saNorm <= 0) return;
  const dr = buf[idx];
  const dg = buf[idx + 1];
  const db = buf[idx + 2];
  const da = buf[idx + 3] / 255;

  if (alphaLock && da <= 0) return;

  const br = blendMode === 'normal' || da <= 0 ? sr : blendChannel(sr, dr, blendMode);
  const bg = blendMode === 'normal' || da <= 0 ? sg : blendChannel(sg, dg, blendMode);
  const bb = blendMode === 'normal' || da <= 0 ? sb : blendChannel(sb, db, blendMode);

  if (alphaLock) {
    const r = dr * (1 - saNorm) + br * saNorm + ditherVal;
    const g = dg * (1 - saNorm) + bg * saNorm + ditherVal;
    const b = db * (1 - saNorm) + bb * saNorm + ditherVal;
    buf[idx] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
    buf[idx + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
    buf[idx + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
    return;
  }

  const outA = saNorm + da * (1 - saNorm);
  if (outA <= 1e-6) return;

  const invOutA = 1 / outA;
  // Blend source color against backdrop where backdrop exists, otherwise use raw source color
  const mixR = (da > 0 ? br * da + sr * (1 - da) : sr) * saNorm + dr * da * (1 - saNorm);
  const mixG = (da > 0 ? bg * da + sg * (1 - da) : sg) * saNorm + dg * da * (1 - saNorm);
  const mixB = (da > 0 ? bb * da + sb * (1 - da) : sb) * saNorm + db * da * (1 - saNorm);

  const r = mixR * invOutA + ditherVal;
  const g = mixG * invOutA + ditherVal;
  const b = mixB * invOutA + ditherVal;
  const a = outA * 255;

  buf[idx] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
  buf[idx + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
  buf[idx + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
  buf[idx + 3] = a < 0 ? 0 : a > 255 ? 255 : Math.round(a);
}

function catmullRomScalar(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

interface MeshVertex {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

function sampleMeshBicubic(
  nodes: readonly MeshVertex[],
  cols: number,
  rows: number,
  cellC: number,
  cellR: number,
  u: number,
  v: number
): MeshVertex {
  const clampC = (c: number) => (c < 0 ? 0 : c >= cols ? cols - 1 : c);
  const clampR = (r: number) => (r < 0 ? 0 : r >= rows ? rows - 1 : r);

  const rx = [0, 0, 0, 0];
  const ry = [0, 0, 0, 0];
  const rr = [0, 0, 0, 0];
  const rg = [0, 0, 0, 0];
  const rb = [0, 0, 0, 0];
  const ra = [0, 0, 0, 0];

  for (let j = -1; j <= 2; j++) {
    const rIdx = clampR(cellR + j);
    const n0 = nodes[rIdx * cols + clampC(cellC - 1)];
    const n1 = nodes[rIdx * cols + clampC(cellC)];
    const n2 = nodes[rIdx * cols + clampC(cellC + 1)];
    const n3 = nodes[rIdx * cols + clampC(cellC + 2)];
    const k = j + 1;
    rx[k] = catmullRomScalar(n0.x, n1.x, n2.x, n3.x, u);
    ry[k] = catmullRomScalar(n0.y, n1.y, n2.y, n3.y, u);
    rr[k] = catmullRomScalar(n0.r, n1.r, n2.r, n3.r, u);
    rg[k] = catmullRomScalar(n0.g, n1.g, n2.g, n3.g, u);
    rb[k] = catmullRomScalar(n0.b, n1.b, n2.b, n3.b, u);
    ra[k] = catmullRomScalar(n0.a, n1.a, n2.a, n3.a, u);
  }

  const clamp255 = (val: number) => (val < 0 ? 0 : val > 255 ? 255 : val);
  return {
    x: catmullRomScalar(rx[0], rx[1], rx[2], rx[3], v),
    y: catmullRomScalar(ry[0], ry[1], ry[2], ry[3], v),
    r: clamp255(catmullRomScalar(rr[0], rr[1], rr[2], rr[3], v)),
    g: clamp255(catmullRomScalar(rg[0], rg[1], rg[2], rg[3], v)),
    b: clamp255(catmullRomScalar(rb[0], rb[1], rb[2], rb[3], v)),
    a: clamp255(catmullRomScalar(ra[0], ra[1], ra[2], ra[3], v)),
  };
}

function rasterizeTriangleIntoBuffer(
  outRgba: Uint8ClampedArray,
  bufWidth: number,
  bufHeight: number,
  originX: number,
  originY: number,
  v0: MeshVertex,
  v1: MeshVertex,
  v2: MeshVertex,
  dither: boolean
): void {
  const minX = Math.max(0, Math.floor(Math.min(v0.x, v1.x, v2.x) - originX));
  const maxX = Math.min(bufWidth - 1, Math.ceil(Math.max(v0.x, v1.x, v2.x) - originX));
  const minY = Math.max(0, Math.floor(Math.min(v0.y, v1.y, v2.y) - originY));
  const maxY = Math.min(bufHeight - 1, Math.ceil(Math.max(v0.y, v1.y, v2.y) - originY));
  if (minX > maxX || minY > maxY) return;

  const x0 = v0.x - originX;
  const y0 = v0.y - originY;
  const x1 = v1.x - originX;
  const y1 = v1.y - originY;
  const x2 = v2.x - originX;
  const y2 = v2.y - originY;

  const denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
  if (Math.abs(denom) < 1e-6) return;
  const invDenom = 1 / denom;

  for (let py = minY; py <= maxY; py++) {
    const cy = py + 0.5;
    const rowOffset = py * bufWidth;
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5;
      const w0 = ((y1 - y2) * (cx - x2) + (x2 - x1) * (cy - y2)) * invDenom;
      if (w0 < -1e-4) continue;
      const w1 = ((y2 - y0) * (cx - x2) + (x0 - x2) * (cy - y2)) * invDenom;
      if (w1 < -1e-4) continue;
      const w2 = 1 - w0 - w1;
      if (w2 < -1e-4) continue;

      const d = dither ? BAYER_4X4[((py & 3) << 2) | (px & 3)] : 0;
      const idx = (rowOffset + px) * 4;
      const r = v0.r * w0 + v1.r * w1 + v2.r * w2 + d;
      const g = v0.g * w0 + v1.g * w1 + v2.g * w2 + d;
      const b = v0.b * w0 + v1.b * w1 + v2.b * w2 + d;
      const a = v0.a * w0 + v1.a * w1 + v2.a * w2;

      outRgba[idx] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
      outRgba[idx + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
      outRgba[idx + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
      outRgba[idx + 3] = a < 0 ? 0 : a > 255 ? 255 : Math.round(a);
    }
  }
}

/**
 * Renders a Mesh Gradient directly into an RGBA buffer covering `[originX, originY, width, height]`.
 * Used both for fast interactive preview canvases and for committing to SparseTileGrid tiles.
 */
export function rasterizeMeshGradientToRgba(
  mesh: GradientMeshState,
  originX: number,
  originY: number,
  width: number,
  height: number,
  scaleX = 1,
  scaleY = 1,
  dither = true,
  subdivisionsPerCell = 8
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  if (mesh.cols < 2 || mesh.rows < 2 || mesh.nodes.length < mesh.cols * mesh.rows) {
    return out;
  }

  const verts: MeshVertex[] = mesh.nodes.map((n) => {
    const [r, g, b] = parseHexRgb(n.color);
    return {
      x: n.x * scaleX,
      y: n.y * scaleY,
      r,
      g,
      b,
      a: Math.max(0, Math.min(1, n.opacity)) * 255,
    };
  });

  const sub = Math.max(2, Math.min(16, Math.round(subdivisionsPerCell)));
  const scaledOriginX = originX * scaleX;
  const scaledOriginY = originY * scaleY;

  for (let r = 0; r < mesh.rows - 1; r++) {
    for (let c = 0; c < mesh.cols - 1; c++) {
      // Sample (sub+1) x (sub+1) bicubic patch vertices
      const patch: MeshVertex[] = new Array((sub + 1) * (sub + 1));
      for (let iy = 0; iy <= sub; iy++) {
        const v = iy / sub;
        for (let ix = 0; ix <= sub; ix++) {
          const u = ix / sub;
          patch[iy * (sub + 1) + ix] = sampleMeshBicubic(
            verts,
            mesh.cols,
            mesh.rows,
            c,
            r,
            u,
            v
          );
        }
      }
      for (let iy = 0; iy < sub; iy++) {
        for (let ix = 0; ix < sub; ix++) {
          const a = patch[iy * (sub + 1) + ix];
          const b = patch[iy * (sub + 1) + ix + 1];
          const d = patch[(iy + 1) * (sub + 1) + ix];
          const e = patch[(iy + 1) * (sub + 1) + ix + 1];
          rasterizeTriangleIntoBuffer(out, width, height, scaledOriginX, scaledOriginY, a, b, e, dither);
          rasterizeTriangleIntoBuffer(out, width, height, scaledOriginX, scaledOriginY, a, e, d, dither);
        }
      }
    }
  }

  return out;
}

export interface RenderGradientParams {
  grid: SparseTileGrid;
  layerId: string;
  dimensions: CanvasDimensions;
  targetFormat: TileFormat;
  settings: GradientSettings;
  primaryColor: string;
  secondaryColor: string;
  start?: Point2D;
  end?: Point2D;
  mesh?: GradientMeshState | null;
  selection?: CanvasSelection | null;
  alphaLock?: boolean;
}

export interface RenderGradientResult {
  modified: boolean;
  dirtyRect: DirtyRect | null;
  tileDeltas: TileDelta[];
}

/**
 * Tile-native gradient rasterizer for Linear, Radial, and Mesh gradients.
 * Writes directly into SparseTileGrid respecting selection masks, alpha-lock, blend modes, and dithering.
 */
export function renderGradientToTileGrid(params: RenderGradientParams): RenderGradientResult {
  const {
    grid,
    layerId,
    dimensions,
    targetFormat,
    settings,
    primaryColor,
    secondaryColor,
    start,
    end,
    mesh,
    selection = null,
    alphaLock = false,
  } = params;

  const docW = dimensions.width;
  const docH = dimensions.height;
  if (docW <= 0 || docH <= 0) {
    return { modified: false, dirtyRect: null, tileDeltas: [] };
  }

  const opacity = Math.max(0, Math.min(1, settings.opacity ?? 1));
  if (opacity <= 0) {
    return { modified: false, dirtyRect: null, tileDeltas: [] };
  }

  const selMask = selection ? createSelectionMask(selection, docW, docH) : null;

  // Determine active bounding rectangle
  let bx0 = 0;
  let by0 = 0;
  let bx1 = docW;
  let by1 = docH;

  if (selection) {
    bx0 = Math.max(0, Math.floor(selection.bounds.x));
    by0 = Math.max(0, Math.floor(selection.bounds.y));
    bx1 = Math.min(docW, Math.ceil(selection.bounds.x + selection.bounds.width));
    by1 = Math.min(docH, Math.ceil(selection.bounds.y + selection.bounds.height));
  }

  if (settings.type === 'mesh') {
    if (!mesh || mesh.cols < 2 || mesh.rows < 2 || mesh.nodes.length < mesh.cols * mesh.rows) {
      return { modified: false, dirtyRect: null, tileDeltas: [] };
    }
    let mMinX = Infinity;
    let mMinY = Infinity;
    let mMaxX = -Infinity;
    let mMaxY = -Infinity;
    for (const n of mesh.nodes) {
      if (n.x < mMinX) mMinX = n.x;
      if (n.y < mMinY) mMinY = n.y;
      if (n.x > mMaxX) mMaxX = n.x;
      if (n.y > mMaxY) mMaxY = n.y;
    }
    // Pad slightly for Catmull-Rom overshoot
    const pad = Math.ceil(Math.max(mMaxX - mMinX, mMaxY - mMinY) * 0.15) + 4;
    bx0 = Math.max(bx0, Math.floor(mMinX - pad));
    by0 = Math.max(by0, Math.floor(mMinY - pad));
    bx1 = Math.min(bx1, Math.ceil(mMaxX + pad));
    by1 = Math.min(by1, Math.ceil(mMaxY + pad));
  } else {
    if (!start || !end) {
      return { modified: false, dirtyRect: null, tileDeltas: [] };
    }
  }

  if (bx0 >= bx1 || by0 >= by1) {
    return { modified: false, dirtyRect: null, tileDeltas: [] };
  }

  const dirtyRect: DirtyRect = {
    x: bx0,
    y: by0,
    width: bx1 - bx0,
    height: by1 - by0,
  };

  const minTx = Math.floor(bx0 / TILE_SIZE);
  const maxTx = Math.floor((bx1 - 1) / TILE_SIZE);
  const minTy = Math.floor(by0 / TILE_SIZE);
  const maxTy = Math.floor((by1 - 1) / TILE_SIZE);

  const beforeSnapshot = new Map<string, TileSnapshotEntry>();
  const stops = resolveGradientStops(settings, primaryColor, secondaryColor);
  const sampleOut: [number, number, number, number] = [0, 0, 0, 0];

  const dx = start && end ? end.x - start.x : 1;
  const dy = start && end ? end.y - start.y : 0;
  const lenSq = dx * dx + dy * dy;
  const invLenSq = lenSq > 1e-6 ? 1 / lenSq : 0;
  const invRad = lenSq > 1e-6 ? 1 / Math.sqrt(lenSq) : 0;

  const tileRgba = new Uint8ClampedArray(BYTES_32BIT);
  let anyModified = false;

  for (let ty = minTy; ty <= maxTy; ty++) {
    const tileOriginY = ty * TILE_SIZE;
    const localY0 = Math.max(0, by0 - tileOriginY);
    const localY1 = Math.min(TILE_SIZE, by1 - tileOriginY);

    for (let tx = minTx; tx <= maxTx; tx++) {
      const tileOriginX = tx * TILE_SIZE;
      const localX0 = Math.max(0, bx0 - tileOriginX);
      const localX1 = Math.min(TILE_SIZE, bx1 - tileOriginX);

      const existingTile = grid.getTile(layerId, tx, ty, 0);
      if (alphaLock && !existingTile) {
        continue;
      }

      // Snapshot before mutation
      grid.snapshotSingleTileInto(layerId, tx, ty, beforeSnapshot);

      if (existingTile && existingTile.data) {
        if (existingTile.format === 'color-32bit') {
          tileRgba.set(existingTile.data);
        } else if (existingTile.format === 'monochrome-1bit') {
          unpack1BitToRGBA(existingTile.data, tileRgba);
        } else {
          unpack8BitToRGBA(existingTile.data, tileRgba);
        }
      } else {
        tileRgba.fill(0);
      }

      let meshTileBuf: Uint8ClampedArray | null = null;
      if (settings.type === 'mesh' && mesh) {
        meshTileBuf = rasterizeMeshGradientToRgba(
          mesh,
          tileOriginX,
          tileOriginY,
          TILE_SIZE,
          TILE_SIZE,
          1,
          1,
          settings.dither,
          8
        );
      }

      let tileTouched = false;
      for (let ly = localY0; ly < localY1; ly++) {
        const gy = tileOriginY + ly;
        const rowSelBase = gy * docW;
        const tileRowBase = ly * TILE_SIZE;

        for (let lx = localX0; lx < localX1; lx++) {
          const gx = tileOriginX + lx;
          let maskWeight = 1;
          if (selMask) {
            const m = selMask[rowSelBase + gx];
            if (m === 0) continue;
            maskWeight = m / 255;
          }

          const idx = (tileRowBase + lx) * 4;
          const ditherVal = settings.dither ? BAYER_4X4[((ly & 3) << 2) | (lx & 3)] : 0;

          if (settings.type === 'mesh' && meshTileBuf) {
            const ma = meshTileBuf[idx + 3];
            if (ma === 0) continue;
            const effAlpha = (ma / 255) * opacity * maskWeight;
            compositePixelInPlace(
              tileRgba,
              idx,
              meshTileBuf[idx],
              meshTileBuf[idx + 1],
              meshTileBuf[idx + 2],
              effAlpha,
              settings.blendMode,
              alphaLock,
              0 // already dithered during mesh scanline
            );
            tileTouched = true;
          } else if (start && end) {
            let t = 0;
            if (settings.type === 'linear') {
              t = invLenSq > 0 ? ((gx - start.x) * dx + (gy - start.y) * dy) * invLenSq : 0;
            } else {
              t = invRad > 0 ? Math.hypot(gx - start.x, gy - start.y) * invRad : 0;
            }
            sampleGradientStops(
              stops,
              t,
              settings.repeat,
              settings.reverse,
              sampleOut,
              Boolean(settings.pigmentBlending)
            );
            const effAlpha = (sampleOut[3] / 255) * opacity * maskWeight;
            if (effAlpha <= 0) continue;
            compositePixelInPlace(
              tileRgba,
              idx,
              sampleOut[0],
              sampleOut[1],
              sampleOut[2],
              effAlpha,
              settings.blendMode,
              alphaLock,
              ditherVal
            );
            tileTouched = true;
          }
        }
      }

      if (!tileTouched) continue;

      const tile = grid.getOrCreateTile(layerId, tx, ty, targetFormat, 0);
      if (tile.format === 'color-32bit') {
        if (!tile.data) tile.data = new Uint8Array(BYTES_32BIT);
        tile.data.set(tileRgba);
      } else if (tile.format === 'monochrome-1bit') {
        if (!tile.data) tile.data = new Uint8Array((TILE_SIZE * TILE_SIZE) / 8);
        packRGBATo1Bit(tileRgba, tile.data);
      } else {
        if (!tile.data) tile.data = new Uint8Array(TILE_SIZE * TILE_SIZE);
        packRGBATo8Bit(tileRgba, tile.data);
      }
      tile.dirty = true;
      tile.version++;
      grid.markLodAncestorsDirty(layerId, tx, ty);
      anyModified = true;
    }
  }

  if (!anyModified) {
    return { modified: false, dirtyRect: null, tileDeltas: [] };
  }

  grid.bumpLayerVersion(layerId);
  grid.notifyChange(true);
  const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, layerId, dirtyRect);
  return { modified: true, dirtyRect, tileDeltas };
}
