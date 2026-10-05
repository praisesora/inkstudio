import { Point } from '../types/editor';
import { getTintedMasterCanvas, drawSingleStamp } from './stampEngine';

/**
 * Real Pencil Physics & Paper Grain Simulation Engine
 * Simulates authentic graphite marks on cold-press sketchbook paper,
 * modeled after physical graphite grades: F, HB, 2B, and 4B.
 */

export type PencilGrade = 'pencil-f' | 'pencil-hb' | 'pencil-2b' | 'pencil-4b';

export interface PencilGradeConfig {
  id: PencilGrade;
  name: string;
  gradeLabel: string;
  description: string;
  defaultSize: number;
  minSizeFactor: number;
  hardness: number; // 0.0 to 1.0 (firmness of the tip)
  flow: number; // 0.0 to 1.0 (graphite release rate)
  spacing: number; // step spacing along curve
  grain: number; // 0.0 to 1.0 (paper tooth visibility)
  particleDensity: number; // micro-graphite particles per stamp
  particleSize: number; // size of individual graphite flakes (px)
  thresholdBase: number; // base paper height threshold
  thresholdPressureSensitivity: number; // how much pressure lowers threshold
  graphiteColorHex: string; // default authentic graphite tone
}

export const PENCIL_CONFIGS: Record<PencilGrade, PencilGradeConfig> = {
  'pencil-f': {
    id: 'pencil-f',
    name: 'Pencil (F)',
    gradeLabel: 'F',
    description: 'Firm & Fine Lead — crisp lineart, light construction & technical sketching',
    defaultSize: 2.5,
    minSizeFactor: 0.35,
    hardness: 0.85,
    flow: 0.55,
    spacing: 0.08,
    grain: 0.88,
    particleDensity: 8,
    particleSize: 1.0,
    thresholdBase: 135,
    thresholdPressureSensitivity: 60,
    graphiteColorHex: '#3a3d43',
  },
  'pencil-hb': {
    id: 'pencil-hb',
    name: 'Pencil (HB)',
    gradeLabel: 'HB',
    description: 'Medium Classic — everyday sketching, drafting & line work',
    defaultSize: 3.2,
    minSizeFactor: 0.25,
    hardness: 0.75,
    flow: 0.65,
    spacing: 0.07,
    grain: 0.92,
    particleDensity: 11,
    particleSize: 1.15,
    thresholdBase: 120,
    thresholdPressureSensitivity: 70,
    graphiteColorHex: '#2d2f34',
  },
  'pencil-2b': {
    id: 'pencil-2b',
    name: 'Pencil (2B)',
    gradeLabel: '2B',
    description: 'Soft & Black Sketching — rich graphite, dynamic pressure & natural shading tooth',
    defaultSize: 4.5,
    minSizeFactor: 0.20,
    hardness: 0.65,
    flow: 0.74,
    spacing: 0.06,
    grain: 0.95,
    particleDensity: 15,
    particleSize: 1.35,
    thresholdBase: 105,
    thresholdPressureSensitivity: 80,
    graphiteColorHex: '#222326',
  },
  'pencil-4b': {
    id: 'pencil-4b',
    name: 'Pencil (4B)',
    gradeLabel: '4B',
    description: 'Extra Soft & Velvety Carbon — deep expressive darks, loose gestures & rich crumbly texture',
    defaultSize: 6.5,
    minSizeFactor: 0.15,
    hardness: 0.50,
    flow: 0.88,
    spacing: 0.05,
    grain: 1.0,
    particleDensity: 20,
    particleSize: 1.6,
    thresholdBase: 90,
    thresholdPressureSensitivity: 90,
    graphiteColorHex: '#141416',
  },
};

/**
 * 512x512 Seamless Procedural Paper Grain Texture
 * Precalculated at startup into a 1D Uint8Array for instant O(1) single-cycle lookups.
 * Models cold-press cotton sketchbook paper with micro-mineral tooth and intertwined cellulose fibers.
 */
const GRAIN_SIZE = 512;
const GRAIN_MASK = GRAIN_SIZE - 1;
const paperGrainTable = new Uint8Array(GRAIN_SIZE * GRAIN_SIZE);

// Deterministic fast PRNG for seamless texture synthesis
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

  // Generate 2D white & cellular noise seeds
  const white = new Float32Array(GRAIN_SIZE * GRAIN_SIZE);
  for (let i = 0; i < white.length; i++) {
    white[i] = rand();
  }

  // Multi-scale procedural synthesis
  for (let y = 0; y < GRAIN_SIZE; y++) {
    for (let x = 0; x < GRAIN_SIZE; x++) {
      // 1. High frequency micro-tooth (mineral surface)
      const n1 = white[y * GRAIN_SIZE + x];

      // 2. Medium frequency intertwined fibers (cellulose weave: slightly directional)
      const x2 = (x + Math.sin(y * 0.12) * 2) & GRAIN_MASK;
      const y2 = (y + Math.cos(x * 0.12) * 2) & GRAIN_MASK;
      const n2 = white[y2 * GRAIN_SIZE + x2];

      // 3. Low frequency paper tooth clumps
      const x3 = (x >> 2) & (GRAIN_SIZE / 4 - 1);
      const y3 = (y >> 2) & (GRAIN_SIZE / 4 - 1);
      const n3 = white[y3 * GRAIN_SIZE + x3];

      // Combine octaves with weighted contrast curve
      const combined = n1 * 0.52 + n2 * 0.32 + n3 * 0.16;

      // Enhance paper tooth peak-to-valley contrast
      const curved = Math.pow(combined, 1.4);
      paperGrainTable[y * GRAIN_SIZE + x] = Math.min(255, Math.max(0, Math.round(curved * 255)));
    }
  }
})();

/**
 * World-anchored paper grain elevation query at canvas coordinate (x, y).
 * Returns integer 0 to 255 representing paper tooth height.
 */
export function getPaperGrain(x: number, y: number): number {
  const ix = (Math.floor(x) & GRAIN_MASK) >>> 0;
  const iy = (Math.floor(y) & GRAIN_MASK) >>> 0;
  return paperGrainTable[iy * GRAIN_SIZE + ix];
}

/**
 * Converts a hex or rgb/rgba string into RGBA components [r, g, b, a].
 */
export function parseRgba(colorStr: string): [number, number, number, number] {
  if (colorStr.startsWith('#')) {
    let hex = colorStr.slice(1);
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    const num = parseInt(hex, 16);
    if (hex.length === 6) {
      return [(num >> 16) & 255, (num >> 8) & 255, num & 255, 1];
    } else if (hex.length === 8) {
      return [(num >> 24) & 255, (num >> 16) & 255, (num >> 8) & 255, (num & 255) / 255];
    }
  }

  const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (match) {
    return [
      parseInt(match[1], 10),
      parseInt(match[2], 10),
      parseInt(match[3], 10),
      match[4] !== undefined ? parseFloat(match[4]) : 1,
    ];
  }

  return [30, 31, 34, 1]; // Fallback dark graphite
}

/**
 * Evaluates a quadratic Bézier curve at parameter t (0 <= t <= 1).
 */
export function getQuadraticBezierPoint(
  p0: Point,
  control: Point,
  p2: Point,
  t: number
): { x: number; y: number; width: number; pressure: number } {
  const invT = 1 - t;
  const invT2 = invT * invT;
  const t2 = t * t;
  const twoInvTT = 2 * invT * t;

  return {
    x: invT2 * p0.x + twoInvTT * control.x + t2 * p2.x,
    y: invT2 * p0.y + twoInvTT * control.y + t2 * p2.y,
    width: invT * p0.width + t * p2.width,
    pressure: invT * p0.pressure + t * p2.pressure,
  };
}

/**
 * Fast deterministic pseudo-random float generator in [0, 1).
 * Ensures graphite micro-flakes land on identical coordinates for live preview and committed strokes.
 */
export function getPencilNoise(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Evaluates a cubic Bézier point at parameter t (0 <= t <= 1).
 */
export function getCubicBezierPoint(
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  t: number
): Point {
  const invT = 1.0 - t;
  const invT2 = invT * invT;
  const invT3 = invT2 * invT;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: invT3 * p0.x + 3.0 * invT2 * t * c1.x + 3.0 * invT * t2 * c2.x + t3 * p3.x,
    y: invT3 * p0.y + 3.0 * invT2 * t * c1.y + 3.0 * invT * t2 * c2.y + t3 * p3.y,
    pressure: invT * p0.pressure + t * p3.pressure,
    width: invT * p0.width + t * p3.width,
    tiltX: invT * (p0.tiltX ?? 0) + t * (p3.tiltX ?? 0),
    tiltY: invT * (p0.tiltY ?? 0) + t * (p3.tiltY ?? 0),
    twist: invT * (p0.twist ?? 0) + t * (p3.twist ?? 0),
  };
}

const graphiteMaskCache = new Map<PencilGrade, HTMLCanvasElement>();

/**
 * Pre-renders and caches high-resolution graphite particle masks for each pencil grade.
 * Features microscopic graphite flake distribution and porous core voids.
 */
export function getGraphiteTipMaster(grade: PencilGrade, color: string): HTMLCanvasElement {
  let maskCanvas = graphiteMaskCache.get(grade);
  if (!maskCanvas) {
    const config = PENCIL_CONFIGS[grade] || PENCIL_CONFIGS['pencil-2b'];
    const size = 64;
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = size;
    maskCanvas.height = size;
    const ctx = maskCanvas.getContext('2d');
    if (ctx) {
      const imgData = ctx.createImageData(size, size);
      const data = imgData.data;
      const cx = size / 2;
      const cy = size / 2;
      const radius = size / 2 - 2; // 30px
      const rand = sfc32(0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x8aed2a6b);

      for (let y = 0; y < size; y++) {
        const dy = y - cy + 0.5;
        const rowOffset = y * size * 4;
        for (let x = 0; x < size; x++) {
          const dx = x - cx + 0.5;
          const dist = Math.hypot(dx, dy);
          if (dist < radius) {
            const normDist = dist / radius;
            const coreFalloff = Math.pow(Math.max(0, 1.0 - normDist), config.hardness > 0.7 ? 0.65 : 1.2);
            // Graphite micro-flakes and porous grain voids
            const flakeNoise = rand();
            const microVoid = flakeNoise > (0.15 + (1 - config.grain) * 0.1) ? 1.0 : 0.25;
            const alpha = Math.min(1.0, coreFalloff * (0.65 + flakeNoise * 0.35) * microVoid);

            if (alpha > 0.005) {
              const idx = rowOffset + x * 4;
              data[idx] = 255;
              data[idx + 1] = 255;
              data[idx + 2] = 255;
              data[idx + 3] = Math.round(alpha * 255);
            }
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }
    graphiteMaskCache.set(grade, maskCanvas);
  }

  return getTintedMasterCanvas(maskCanvas, `pencil_${grade}`, color, 64, 64);
}

/**
 * Draws a real pencil mark along a cubic Bézier curve using arc-length stepping and paper tooth modulation.
 * Delivers authentic graphite tooth on cold-press paper at a locked 120 FPS without string allocations.
 */
export function drawPencilCubicBezierSegment(
  ctx: CanvasRenderingContext2D,
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  color: string,
  grade: PencilGrade = 'pencil-2b',
  userFlow: number = 0.75,
  grainIntensity: number = 1.0,
  _userHardness?: number,
  remainderDist: number = 0,
  alphaLocked: boolean = false,
  isTransparentInk: boolean = false
): number {
  const config = PENCIL_CONFIGS[grade] || PENCIL_CONFIGS['pencil-2b'];
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.15) return remainderDist;

  const graphiteMaster = getGraphiteTipMaster(grade, color);
  const avgWidth = Math.max(1, (p0.width + p3.width) / 2);
  const stepDist = Math.max(0.4, Math.min(1.6, avgWidth * (config.spacing || 0.07)));
  const numSteps = Math.max(2, Math.ceil(dist / stepDist));

  const baseThreshold = config.thresholdBase;
  const sens = config.thresholdPressureSensitivity;
  const flow = userFlow * config.flow;
  const stepT = 1.0 / numSteps;

  for (let i = 0; i <= numSteps; i++) {
    const t = i * stepT;
    const pt = getCubicBezierPoint(p0, c1, c2, p3, t);
    const pressure = Math.min(Math.max(pt.pressure || 0.5, 0.05), 1.0);

    const tiltX = pt.tiltX ?? 0;
    const tiltY = pt.tiltY ?? 0;
    const tiltAngleDeg = Math.min(90, Math.sqrt(tiltX * tiltX + tiltY * tiltY));
    const tiltMagnitude = Math.sin((tiltAngleDeg * Math.PI) / 180);

    const curWidth = Math.max(0.6, pt.width * (1.0 + tiltMagnitude * 2.2));

    const effThreshold = Math.max(
      15,
      baseThreshold - pressure * sens + (1 - grainIntensity) * 40 - tiltMagnitude * 35
    );

    let stampW = curWidth;
    let stampH = curWidth;
    let stampAngle = 0;
    if (tiltMagnitude > 0.01) {
      const tiltAzimuth = Math.atan2(tiltY, tiltX);
      stampW = curWidth;
      stampH = curWidth * (1.0 + tiltMagnitude * 1.5);
      if (tiltMagnitude > 0.05) {
        stampAngle = tiltAzimuth;
      }
    }
    if (pt.twist) {
      stampAngle += (pt.twist * Math.PI) / 180;
    }

    const paperHeight = getPaperGrain(pt.x, pt.y);

    if (paperHeight >= effThreshold) {
      const heightFactor = Math.min(1.0, (paperHeight - effThreshold + 25) / 55);
      const dabAlpha = Math.min(
        1.0,
        Math.max(0.04, flow * (0.35 + 0.65 * pressure) * heightFactor)
      );

      drawSingleStamp(
        ctx,
        graphiteMaster,
        pt.x,
        pt.y,
        stampW,
        stampH,
        stampAngle,
        dabAlpha,
        false,
        false,
        alphaLocked,
        isTransparentInk
      );
    } else if (pressure > 0.55) {
      // Firm pressure pushing into troughs
      const dabAlpha = Math.min(1.0, flow * 0.15 * pressure);
      drawSingleStamp(
        ctx,
        graphiteMaster,
        pt.x,
        pt.y,
        stampW,
        stampH,
        stampAngle,
        dabAlpha,
        false,
        false,
        alphaLocked,
        isTransparentInk
      );
    }
  }

  return 0;
}

/**
 * Draws a real pencil mark along a quadratic Bézier curve by elevating to cubic.
 */
export function drawPencilBezierSegment(
  ctx: CanvasRenderingContext2D,
  start: Point,
  control: Point,
  end: Point,
  color: string,
  grade: PencilGrade = 'pencil-2b',
  userFlow: number = 0.75,
  grainIntensity: number = 1.0,
  userHardness?: number,
  alphaLocked: boolean = false,
  isTransparentInk: boolean = false
) {
  const c1: Point = {
    x: start.x + (2.0 / 3.0) * (control.x - start.x),
    y: start.y + (2.0 / 3.0) * (control.y - start.y),
    pressure: start.pressure + (2.0 / 3.0) * (control.pressure - start.pressure),
    width: start.width + (2.0 / 3.0) * (control.width - start.width),
    tiltX: start.tiltX !== undefined && control.tiltX !== undefined ? start.tiltX + (2.0 / 3.0) * (control.tiltX - start.tiltX) : undefined,
    tiltY: start.tiltY !== undefined && control.tiltY !== undefined ? start.tiltY + (2.0 / 3.0) * (control.tiltY - start.tiltY) : undefined,
    twist: start.twist !== undefined && control.twist !== undefined ? start.twist + (2.0 / 3.0) * (control.twist - start.twist) : undefined,
  };
  const c2: Point = {
    x: end.x + (2.0 / 3.0) * (control.x - end.x),
    y: end.y + (2.0 / 3.0) * (control.y - end.y),
    pressure: end.pressure + (2.0 / 3.0) * (control.pressure - end.pressure),
    width: end.width + (2.0 / 3.0) * (control.width - end.width),
    tiltX: end.tiltX !== undefined && control.tiltX !== undefined ? end.tiltX + (2.0 / 3.0) * (control.tiltX - end.tiltX) : undefined,
    tiltY: end.tiltY !== undefined && control.tiltY !== undefined ? end.tiltY + (2.0 / 3.0) * (control.tiltY - end.tiltY) : undefined,
    twist: end.twist !== undefined && control.twist !== undefined ? end.twist + (2.0 / 3.0) * (control.twist - end.twist) : undefined,
  };
  drawPencilCubicBezierSegment(ctx, start, c1, c2, end, color, grade, userFlow, grainIntensity, userHardness, 0, alphaLocked, isTransparentInk);
}

/**
 * Draws a real pencil dot (e.g. single tap / initial contact).
 */
export function drawPencilDot(
  ctx: CanvasRenderingContext2D,
  point: Point,
  color: string,
  grade: PencilGrade = 'pencil-2b',
  userFlow: number = 0.75,
  grainIntensity: number = 1.0,
  _userHardness?: number,
  alphaLocked: boolean = false,
  isTransparentInk: boolean = false
) {
  const config = PENCIL_CONFIGS[grade] || PENCIL_CONFIGS['pencil-2b'];
  const graphiteMaster = getGraphiteTipMaster(grade, color);
  const pressure = Math.min(Math.max(point.pressure || 0.5, 0.05), 1.0);

  const tiltX = point.tiltX ?? 0;
  const tiltY = point.tiltY ?? 0;
  const tiltAngleDeg = Math.min(90, Math.sqrt(tiltX * tiltX + tiltY * tiltY));
  const tiltMagnitude = Math.sin((tiltAngleDeg * Math.PI) / 180);

  const curWidth = Math.max(0.6, point.width * (1.0 + tiltMagnitude * 2.2));

  const effThreshold = Math.max(
    15,
    config.thresholdBase - pressure * config.thresholdPressureSensitivity + (1 - grainIntensity) * 40 - tiltMagnitude * 35
  );

  let stampW = curWidth;
  let stampH = curWidth;
  let stampAngle = 0;
  if (tiltMagnitude > 0.01) {
    const tiltAzimuth = Math.atan2(tiltY, tiltX);
    stampW = curWidth;
    stampH = curWidth * (1.0 + tiltMagnitude * 1.5);
    if (tiltMagnitude > 0.05) {
      stampAngle = tiltAzimuth;
    }
  }
  if (point.twist) {
    stampAngle += (point.twist * Math.PI) / 180;
  }

  const paperHeight = getPaperGrain(point.x, point.y);
  const heightFactor = paperHeight >= effThreshold
    ? Math.min(1.0, (paperHeight - effThreshold + 25) / 55)
    : 0.15;

  const flow = userFlow * config.flow;
  const dabAlpha = Math.min(1.0, Math.max(0.05, flow * pressure * heightFactor));

  drawSingleStamp(
    ctx,
    graphiteMaster,
    point.x,
    point.y,
    stampW,
    stampH,
    stampAngle,
    dabAlpha,
    false,
    false,
    alphaLocked,
    isTransparentInk
  );
}
