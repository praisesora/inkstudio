/**
 * True Cubic Bézier Curve Engine
 *
 * Implements exact Bernstein evaluation, analytical extrema bounding boxes,
 * de Casteljau subdivision (zero-distortion anchor insertion & splitting),
 * closest-point projection, adaptive tessellation, and handle constraint math.
 */

import type { BezierHandleType, Point2D, VectorKnot, VectorStroke } from '../types/editor';

export interface CubicSegment {
  p0: Point2D;
  c1: Point2D;
  c2: Point2D;
  p3: Point2D;
}

export interface EvaluatedBezierPoint {
  x: number;
  y: number;
  dx: number;
  dy: number;
  pressure: number;
  width: number;
}

export interface BezierSplitResult {
  leftC1: Point2D;
  leftC2: Point2D;
  mid: Point2D;
  rightC1: Point2D;
  rightC2: Point2D;
}

export interface BezierClosestHit {
  segmentIndex: number;
  t: number;
  point: Point2D;
  distance: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isFinitePoint(p: Point2D | null | undefined): p is Point2D {
  return Boolean(p && Number.isFinite(p.x) && Number.isFinite(p.y));
}

/**
 * Resolves the 4 cubic Bézier control points between knot `k1` and knot `k2`.
 * Missing handles collapse onto their owning anchor, producing a linear or quadratic-equivalent cubic.
 */
export function getSegmentControlPoints(k1: VectorKnot, k2: VectorKnot): CubicSegment {
  const p0 = { x: k1.x, y: k1.y };
  const p3 = { x: k2.x, y: k2.y };
  const c1 = isFinitePoint(k1.handleOut) ? { x: k1.handleOut.x, y: k1.handleOut.y } : p0;
  const c2 = isFinitePoint(k2.handleIn) ? { x: k2.handleIn.x, y: k2.handleIn.y } : p3;
  return { p0, c1, c2, p3 };
}

/**
 * Evaluates a cubic Bézier curve and its first derivative at parameter t in [0, 1].
 */
export function evaluateCubicBezier(
  p0: Point2D,
  c1: Point2D,
  c2: Point2D,
  p3: Point2D,
  t: number,
  w0 = 2,
  w1 = 2,
  pr0 = 1,
  pr1 = 1
): EvaluatedBezierPoint {
  const u = clamp01(t);
  const inv = 1 - u;
  const inv2 = inv * inv;
  const inv3 = inv2 * inv;
  const u2 = u * u;
  const u3 = u2 * u;

  const x = inv3 * p0.x + 3 * inv2 * u * c1.x + 3 * inv * u2 * c2.x + u3 * p3.x;
  const y = inv3 * p0.y + 3 * inv2 * u * c1.y + 3 * inv * u2 * c2.y + u3 * p3.y;

  const dx =
    3 * inv2 * (c1.x - p0.x) +
    6 * inv * u * (c2.x - c1.x) +
    3 * u2 * (p3.x - c2.x);
  const dy =
    3 * inv2 * (c1.y - p0.y) +
    6 * inv * u * (c2.y - c1.y) +
    3 * u2 * (p3.y - c2.y);

  return {
    x,
    y,
    dx,
    dy,
    width: Math.max(0.5, w0 + (w1 - w0) * u),
    pressure: clamp01(pr0 + (pr1 - pr0) * u),
  };
}

/**
 * Exact de Casteljau subdivision of a cubic Bézier segment at parameter t in [0, 1].
 * Preserves the exact curve geometry across both sub-segments.
 */
export function splitCubicBezier(
  p0: Point2D,
  c1: Point2D,
  c2: Point2D,
  p3: Point2D,
  t: number
): BezierSplitResult {
  const u = clamp01(t);
  const lerp = (a: Point2D, b: Point2D): Point2D => ({
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
  });

  const p01 = lerp(p0, c1);
  const p12 = lerp(c1, c2);
  const p23 = lerp(c2, p3);
  const p012 = lerp(p01, p12);
  const p123 = lerp(p12, p23);
  const mid = lerp(p012, p123);

  return {
    leftC1: p01,
    leftC2: p012,
    mid,
    rightC1: p123,
    rightC2: p23,
  };
}

/**
 * Computes analytical extrema of a 1D cubic Bézier coordinate B(t) over t in [0, 1].
 */
function cubicExtrema1D(v0: number, v1: number, v2: number, v3: number): [number, number] {
  let min = Math.min(v0, v3);
  let max = Math.max(v0, v3);

  // B'(t) = 3 * (a*t^2 + 2*b*t + c)
  const a = -v0 + 3 * v1 - 3 * v2 + v3;
  const b = 2 * (v0 - 2 * v1 + v2);
  const c = v1 - v0;

  const evalAt = (t: number) => {
    if (t <= 0 || t >= 1) return;
    const inv = 1 - t;
    const val =
      inv * inv * inv * v0 +
      3 * inv * inv * t * v1 +
      3 * inv * t * t * v2 +
      t * t * t * v3;
    if (val < min) min = val;
    if (val > max) max = val;
  };

  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) {
      evalAt(-c / b);
    }
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sqrtD = Math.sqrt(disc);
      evalAt((-b + sqrtD) / (2 * a));
      evalAt((-b - sqrtD) / (2 * a));
    }
  }

  return [min, max];
}

/**
 * Computes exact tight axis-aligned bounding box of a single cubic Bézier segment.
 */
export function computeBezierSegmentBounds(
  p0: Point2D,
  c1: Point2D,
  c2: Point2D,
  p3: Point2D,
  halfWidth = 0
): { minX: number; minY: number; maxX: number; maxY: number } {
  const [minX, maxX] = cubicExtrema1D(p0.x, c1.x, c2.x, p3.x);
  const [minY, maxY] = cubicExtrema1D(p0.y, c1.y, c2.y, p3.y);
  const pad = Math.max(0, halfWidth);
  return {
    minX: minX - pad,
    minY: minY - pad,
    maxX: maxX + pad,
    maxY: maxY + pad,
  };
}

/**
 * Computes tight bounding box for a full cubic Bézier path (open or closed).
 */
export function computeBezierPathBounds(
  knots: VectorKnot[],
  closed = false
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (knots.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  if (knots.length === 1) {
    const k = knots[0];
    const r = (k.width || 2) * 0.5;
    return { minX: k.x - r, minY: k.y - r, maxX: k.x + r, maxY: k.y + r };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const segCount = closed ? knots.length : knots.length - 1;
  for (let i = 0; i < segCount; i++) {
    const k1 = knots[i];
    const k2 = knots[(i + 1) % knots.length];
    const seg = getSegmentControlPoints(k1, k2);
    const halfW = Math.max(k1.width || 2, k2.width || 2) * 0.5;
    const b = computeBezierSegmentBounds(seg.p0, seg.c1, seg.c2, seg.p3, halfW);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }

  return { minX, minY, maxX, maxY };
}

/**
 * Tessellates a single cubic Bézier segment based on control polygon length and curvature.
 */
export function tessellateCubicBezierSegment(
  k1: VectorKnot,
  k2: VectorKnot,
  minSteps = 6,
  maxSteps = 48
): VectorKnot[] {
  const { p0, c1, c2, p3 } = getSegmentControlPoints(k1, k2);
  const polyLen =
    Math.hypot(c1.x - p0.x, c1.y - p0.y) +
    Math.hypot(c2.x - c1.x, c2.y - c1.y) +
    Math.hypot(p3.x - c2.x, p3.y - c2.y);

  const isStraight =
    Math.hypot(c1.x - p0.x, c1.y - p0.y) < 1e-4 &&
    Math.hypot(c2.x - p3.x, c2.y - p3.y) < 1e-4;

  const steps = isStraight
    ? Math.max(1, Math.min(8, Math.ceil(polyLen / 40)))
    : Math.max(minSteps, Math.min(maxSteps, Math.ceil(polyLen / 4)));

  const out: VectorKnot[] = [];
  for (let s = 0; s < steps; s++) {
    const t = s / steps;
    const pt = evaluateCubicBezier(p0, c1, c2, p3, t, k1.width, k2.width, k1.pressure, k2.pressure);
    out.push({
      x: pt.x,
      y: pt.y,
      pressure: pt.pressure,
      width: pt.width,
      angle: Math.atan2(pt.dy, pt.dx),
      timestamp: k1.timestamp + (k2.timestamp - k1.timestamp) * t,
    });
  }
  return out;
}

/**
 * Tessellates an entire cubic Bézier VectorStroke into dense points for variable-width rendering or intersection testing.
 */
export function tessellateBezierStroke(stroke: VectorStroke, minSteps = 6): VectorKnot[] {
  const knots = stroke.knots;
  if (knots.length === 0) return [];
  if (knots.length === 1) return [knots[0]];

  const closed = Boolean(stroke.closed && knots.length >= 2);
  const segCount = closed ? knots.length : knots.length - 1;
  const result: VectorKnot[] = [];

  for (let i = 0; i < segCount; i++) {
    const k1 = knots[i];
    const k2 = knots[(i + 1) % knots.length];
    const segPts = tessellateCubicBezierSegment(k1, k2, minSteps);
    for (let j = 0; j < segPts.length; j++) {
      result.push(segPts[j]);
    }
  }

  result.push(closed ? knots[0] : knots[knots.length - 1]);
  return result;
}

/**
 * Inserts a new anchor onto a cubic Bézier path at `(segmentIndex, t)` using exact de Casteljau subdivision.
 * Updates adjacent handles so the curve shape does not move.
 */
export function insertBezierAnchorAt(
  knots: VectorKnot[],
  segmentIndex: number,
  t: number,
  closed = false
): { knots: VectorKnot[]; insertedIndex: number } {
  const n = knots.length;
  const maxSeg = closed ? n - 1 : n - 2;
  if (n < 2 || segmentIndex < 0 || segmentIndex > maxSeg) {
    return { knots: [...knots], insertedIndex: -1 };
  }

  const nextIdx = (segmentIndex + 1) % n;
  const k1 = knots[segmentIndex];
  const k2 = knots[nextIdx];
  const seg = getSegmentControlPoints(k1, k2);
  const u = clamp01(t);
  const split = splitCubicBezier(seg.p0, seg.c1, seg.c2, seg.p3, u);

  const updatedK1: VectorKnot = {
    ...k1,
    handleOut: { ...split.leftC1 },
  };
  const updatedK2: VectorKnot = {
    ...k2,
    handleIn: { ...split.rightC2 },
  };
  const newKnot: VectorKnot = {
    x: split.mid.x,
    y: split.mid.y,
    pressure: k1.pressure + (k2.pressure - k1.pressure) * u,
    width: Math.max(0.5, k1.width + (k2.width - k1.width) * u),
    timestamp: Date.now(),
    handleIn: { ...split.leftC2 },
    handleOut: { ...split.rightC1 },
    handleType: 'smooth',
  };

  const nextKnots: VectorKnot[] = knots.map((k) => ({
    ...k,
    handleIn: k.handleIn ? { ...k.handleIn } : null,
    handleOut: k.handleOut ? { ...k.handleOut } : null,
  }));
  nextKnots[segmentIndex] = updatedK1;
  nextKnots[nextIdx] = updatedK2;

  const insertPos = segmentIndex + 1;
  nextKnots.splice(insertPos, 0, newKnot);
  return { knots: nextKnots, insertedIndex: insertPos };
}

/**
 * Finds the closest point on a cubic Bézier path to `target` using coarse sampling + golden-section refinement.
 */
export function findClosestPointOnBezierPath(
  knots: VectorKnot[],
  target: Point2D,
  closed = false,
  samplesPerSegment = 24
): BezierClosestHit | null {
  const n = knots.length;
  if (n < 2) return null;

  const segCount = closed ? n : n - 1;
  let best: BezierClosestHit | null = null;
  let bestDistSq = Infinity;

  for (let i = 0; i < segCount; i++) {
    const k1 = knots[i];
    const k2 = knots[(i + 1) % n];
    const seg = getSegmentControlPoints(k1, k2);

    // Coarse search
    let localBestT = 0;
    let localBestDistSq = Infinity;
    for (let s = 0; s <= samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const pt = evaluateCubicBezier(seg.p0, seg.c1, seg.c2, seg.p3, t);
      const dx = pt.x - target.x;
      const dy = pt.y - target.y;
      const dSq = dx * dx + dy * dy;
      if (dSq < localBestDistSq) {
        localBestDistSq = dSq;
        localBestT = t;
      }
    }

    // Refine with 8 iterations of local ternary/golden narrowing
    let lo = Math.max(0, localBestT - 1 / samplesPerSegment);
    let hi = Math.min(1, localBestT + 1 / samplesPerSegment);
    for (let iter = 0; iter < 8; iter++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      const p1 = evaluateCubicBezier(seg.p0, seg.c1, seg.c2, seg.p3, m1);
      const p2 = evaluateCubicBezier(seg.p0, seg.c1, seg.c2, seg.p3, m2);
      const d1 = (p1.x - target.x) ** 2 + (p1.y - target.y) ** 2;
      const d2 = (p2.x - target.x) ** 2 + (p2.y - target.y) ** 2;
      if (d1 < d2) {
        hi = m2;
      } else {
        lo = m1;
      }
    }

    const tRefined = (lo + hi) * 0.5;
    const refined = evaluateCubicBezier(seg.p0, seg.c1, seg.c2, seg.p3, tRefined);
    const rDistSq = (refined.x - target.x) ** 2 + (refined.y - target.y) ** 2;
    if (rDistSq < bestDistSq) {
      bestDistSq = rDistSq;
      best = {
        segmentIndex: i,
        t: tRefined,
        point: { x: refined.x, y: refined.y },
        distance: Math.sqrt(rDistSq),
      };
    }
  }

  return best;
}

/**
 * Translates an anchor point and both of its attached Bézier handles by `(dx, dy)`.
 */
export function moveBezierAnchor(knot: VectorKnot, nextPos: Point2D): VectorKnot {
  const dx = nextPos.x - knot.x;
  const dy = nextPos.y - knot.y;
  return {
    ...knot,
    x: nextPos.x,
    y: nextPos.y,
    handleIn: isFinitePoint(knot.handleIn)
      ? { x: knot.handleIn.x + dx, y: knot.handleIn.y + dy }
      : null,
    handleOut: isFinitePoint(knot.handleOut)
      ? { x: knot.handleOut.x + dx, y: knot.handleOut.y + dy }
      : null,
  };
}

/**
 * Updates one control handle (`in` or `out`) of a knot, enforcing `symmetric`, `smooth`, or `corner` continuity.
 */
export function moveBezierHandle(
  knot: VectorKnot,
  which: 'in' | 'out',
  nextHandlePos: Point2D,
  breakSymmetry = false
): VectorKnot {
  const vx = nextHandlePos.x - knot.x;
  const vy = nextHandlePos.y - knot.y;
  const len = Math.hypot(vx, vy);

  let mode: BezierHandleType = breakSymmetry ? 'corner' : (knot.handleType ?? 'symmetric');
  if (breakSymmetry) {
    mode = 'corner';
  }

  const otherKey = which === 'in' ? 'handleOut' : 'handleIn';
  const existingOther = knot[otherKey];
  let nextOther = isFinitePoint(existingOther) ? { ...existingOther } : null;

  if (mode === 'symmetric') {
    nextOther = { x: knot.x - vx, y: knot.y - vy };
  } else if (mode === 'smooth' && nextOther && len > 1e-4) {
    const otherLen = Math.hypot(nextOther.x - knot.x, nextOther.y - knot.y);
    if (otherLen > 1e-4) {
      nextOther = {
        x: knot.x - (vx / len) * otherLen,
        y: knot.y - (vy / len) * otherLen,
      };
    }
  }

  return {
    ...knot,
    handleType: mode,
    handleIn: which === 'in' ? { x: nextHandlePos.x, y: nextHandlePos.y } : nextOther,
    handleOut: which === 'out' ? { x: nextHandlePos.x, y: nextHandlePos.y } : nextOther,
  };
}

/**
 * Converts an anchor between sharp corner (null handles) and smooth auto-tangent curve point.
 */
export function toggleBezierAnchorSmooth(
  knots: VectorKnot[],
  index: number,
  closed = false
): VectorKnot[] {
  const n = knots.length;
  if (index < 0 || index >= n) return knots;

  const target = knots[index];
  const hasHandles = isFinitePoint(target.handleIn) || isFinitePoint(target.handleOut);

  return knots.map((k, idx) => {
    if (idx !== index) return k;
    if (hasHandles) {
      return {
        ...k,
        handleIn: null,
        handleOut: null,
        handleType: 'corner',
      };
    }
    const prevIdx = idx > 0 ? idx - 1 : closed ? n - 1 : idx;
    const nextIdx = idx < n - 1 ? idx + 1 : closed ? 0 : idx;
    const prev = knots[prevIdx];
    const next = knots[nextIdx];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const dist = Math.hypot(tx, ty);
    if (dist < 1e-3) {
      return {
        ...k,
        handleIn: { x: k.x - 24, y: k.y },
        handleOut: { x: k.x + 24, y: k.y },
        handleType: 'symmetric',
      };
    }
    const ux = tx / dist;
    const uy = ty / dist;
    const inLen = Math.hypot(k.x - prev.x, k.y - prev.y) * 0.3;
    const outLen = Math.hypot(next.x - k.x, next.y - k.y) * 0.3;
    return {
      ...k,
      handleIn: inLen > 0.5 ? { x: k.x - ux * inLen, y: k.y - uy * inLen } : null,
      handleOut: outLen > 0.5 ? { x: k.x + ux * outLen, y: k.y + uy * outLen } : null,
      handleType: 'smooth',
    };
  });
}

/**
 * Builds an exact SVG path `d` attribute string (`M ... C ... Z`) for a cubic Bézier knot list.
 */
export function buildBezierSvgPath(knots: VectorKnot[], closed = false): string {
  if (knots.length === 0) return '';
  const fmt = (v: number) => Math.round(v * 100) / 100;
  let d = `M ${fmt(knots[0].x)} ${fmt(knots[0].y)}`;
  if (knots.length === 1) return d;

  const segCount = closed ? knots.length : knots.length - 1;
  for (let i = 0; i < segCount; i++) {
    const k1 = knots[i];
    const k2 = knots[(i + 1) % knots.length];
    const { c1, c2, p3 } = getSegmentControlPoints(k1, k2);
    d += ` C ${fmt(c1.x)} ${fmt(c1.y)}, ${fmt(c2.x)} ${fmt(c2.y)}, ${fmt(p3.x)} ${fmt(p3.y)}`;
  }
  if (closed) {
    d += ' Z';
  }
  return d;
}

/**
 * Traces a cubic Bézier path directly onto a Canvas 2D context using native `bezierCurveTo`.
 */
export function traceBezierPathOnContext(
  ctx: CanvasRenderingContext2D,
  knots: VectorKnot[],
  closed = false
): void {
  if (knots.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(knots[0].x, knots[0].y);
  if (knots.length === 1) return;

  const segCount = closed ? knots.length : knots.length - 1;
  for (let i = 0; i < segCount; i++) {
    const k1 = knots[i];
    const k2 = knots[(i + 1) % knots.length];
    const { c1, c2, p3 } = getSegmentControlPoints(k1, k2);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p3.x, p3.y);
  }
  if (closed) {
    ctx.closePath();
  }
}

/**
 * Checks whether all knots of a stroke share effectively uniform width (allowing native `bezierCurveTo` stroking).
 */
export function isUniformWidthBezier(knots: VectorKnot[]): boolean {
  if (knots.length <= 1) return true;
  const w0 = knots[0].width;
  for (let i = 1; i < knots.length; i++) {
    if (Math.abs(knots[i].width - w0) > 0.05) return false;
  }
  return true;
}
