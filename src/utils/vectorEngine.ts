/**
 * Vector Inking Engine & Vector Eraser
 *
 * Implements Clip Studio Paint-grade vector inking with parametric Catmull-Rom splines,
 * variable-width pressure ribbons, spatial segment indexing, and authentic
 * "Erase Up to Intersection" vector erasing.
 */

import { VectorKnot, VectorStroke } from '../types/editor';

export interface Point2D {
  x: number;
  y: number;
}

export interface SegmentRef {
  strokeId: string;
  segIndex: number;
  p1: VectorKnot;
  p2: VectorKnot;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface IntersectionPoint {
  point: Point2D;
  strokeIdA: string;
  segIndexA: number;
  tA: number; // 0..1 along segment A
  strokeIdB: string;
  segIndexB: number;
  tB: number; // 0..1 along segment B
}

/**
 * Catmull-Rom cubic spline interpolation between p1 and p2 using control points p0 and p3.
 */
export function evaluateCatmullRom(
  p0: VectorKnot,
  p1: VectorKnot,
  p2: VectorKnot,
  p3: VectorKnot,
  t: number
): VectorKnot {
  const t2 = t * t;
  const t3 = t2 * t;

  const f0 = -0.5 * t3 + t2 - 0.5 * t;
  const f1 = 1.5 * t3 - 2.5 * t2 + 1.0;
  const f2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
  const f3 = 0.5 * t3 - 0.5 * t2;

  return {
    x: p0.x * f0 + p1.x * f1 + p2.x * f2 + p3.x * f3,
    y: p0.y * f0 + p1.y * f1 + p2.y * f2 + p3.y * f3,
    pressure: Math.max(0, Math.min(1, p0.pressure * f0 + p1.pressure * f1 + p2.pressure * f2 + p3.pressure * f3)),
    width: Math.max(0.5, p0.width * f0 + p1.width * f1 + p2.width * f2 + p3.width * f3),
    angle: p1.angle,
    timestamp: p1.timestamp + (p2.timestamp - p1.timestamp) * t,
  };
}

/**
 * Discretize a spline stroke into fine polyline segments for accurate rendering and intersection checks.
 */
export function tessellateStroke(stroke: VectorStroke, stepsPerSegment = 6): VectorKnot[] {
  const knots = stroke.knots;
  if (knots.length === 0) return [];
  if (knots.length === 1) return [knots[0]];
  if (knots.length === 2) return [knots[0], knots[1]];

  const result: VectorKnot[] = [];

  for (let i = 0; i < knots.length - 1; i++) {
    const p0 = i > 0 ? knots[i - 1] : knots[0];
    const p1 = knots[i];
    const p2 = knots[i + 1];
    const p3 = i + 2 < knots.length ? knots[i + 2] : p2;

    const steps = stepsPerSegment;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      result.push(evaluateCatmullRom(p0, p1, p2, p3, t));
    }
  }

  result.push(knots[knots.length - 1]);
  return result;
}

/**
 * Compute axis-aligned bounding box of a list of knots.
 */
export function computeStrokeBounds(knots: VectorKnot[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  if (knots.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const k of knots) {
    const r = (k.width || 2) * 0.5;
    if (k.x - r < minX) minX = k.x - r;
    if (k.y - r < minY) minY = k.y - r;
    if (k.x + r > maxX) maxX = k.x + r;
    if (k.y + r > maxY) maxY = k.y + r;
  }

  return { minX, minY, maxX, maxY };
}

/**
 * Segment intersection test between A(p1, p2) and B(p3, p4).
 * Returns intersection parameter tA, tB in [0, 1] if intersecting, or null.
 */
export function findSegmentIntersection(
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  p4: Point2D
): { point: Point2D; tA: number; tB: number } | null {
  const dX_A = p2.x - p1.x;
  const dY_A = p2.y - p1.y;
  const dX_B = p4.x - p3.x;
  const dY_B = p4.y - p3.y;

  const denom = dX_A * dY_B - dY_A * dX_B;
  if (Math.abs(denom) < 1e-9) {
    return null; // Parallel or collinear
  }

  const dX_C = p1.x - p3.x;
  const dY_C = p1.y - p3.y;

  const tA = (dX_B * dY_C - dY_B * dX_C) / denom;
  const tB = (dX_A * dY_C - dY_A * dX_C) / denom;

  if (tA >= 0 && tA <= 1 && tB >= 0 && tB <= 1) {
    return {
      point: {
        x: p1.x + tA * dX_A,
        y: p1.y + tA * dY_A,
      },
      tA,
      tB,
    };
  }

  return null;
}

/**
 * Spatial Grid index for high-speed collision and intersection queries on vector strokes.
 */
export class VectorSpatialGrid {
  private cellSize = 128;
  private cells: Map<string, SegmentRef[]> = new Map();

  constructor(cellSize = 128) {
    this.cellSize = cellSize;
  }

  private cellKey(cx: number, cy: number): string {
    return `${cx}:${cy}`;
  }

  public clear(): void {
    this.cells.clear();
  }

  public insertStroke(stroke: VectorStroke): void {
    if (stroke.deleted || stroke.knots.length < 2) return;

    for (let i = 0; i < stroke.knots.length - 1; i++) {
      const p1 = stroke.knots[i];
      const p2 = stroke.knots[i + 1];
      const r = Math.max(p1.width, p2.width) * 0.5;

      const minX = Math.min(p1.x, p2.x) - r;
      const minY = Math.min(p1.y, p2.y) - r;
      const maxX = Math.max(p1.x, p2.x) + r;
      const maxY = Math.max(p1.y, p2.y) + r;

      const segRef: SegmentRef = {
        strokeId: stroke.id,
        segIndex: i,
        p1,
        p2,
        bounds: { minX, minY, maxX, maxY },
      };

      const minCX = Math.floor(minX / this.cellSize);
      const minCY = Math.floor(minY / this.cellSize);
      const maxCX = Math.floor(maxX / this.cellSize);
      const maxCY = Math.floor(maxY / this.cellSize);

      for (let cy = minCY; cy <= maxCY; cy++) {
        for (let cx = minCX; cx <= maxCX; cx++) {
          const key = this.cellKey(cx, cy);
          let list = this.cells.get(key);
          if (!list) {
            list = [];
            this.cells.set(key, list);
          }
          list.push(segRef);
        }
      }
    }
  }

  public queryBox(minX: number, minY: number, maxX: number, maxY: number): SegmentRef[] {
    const minCX = Math.floor(minX / this.cellSize);
    const minCY = Math.floor(minY / this.cellSize);
    const maxCX = Math.floor(maxX / this.cellSize);
    const maxCY = Math.floor(maxY / this.cellSize);

    const seen = new Set<string>();
    const results: SegmentRef[] = [];

    for (let cy = minCY; cy <= maxCY; cy++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const list = this.cells.get(this.cellKey(cx, cy));
        if (list) {
          for (const item of list) {
            const id = `${item.strokeId}:${item.segIndex}`;
            if (!seen.has(id)) {
              seen.add(id);
              // Quick AABB overlap check
              if (
                item.bounds.maxX >= minX &&
                item.bounds.minX <= maxX &&
                item.bounds.maxY >= minY &&
                item.bounds.minY <= maxY
              ) {
                results.push(item);
              }
            }
          }
        }
      }
    }

    return results;
  }
}

/**
 * Finds all intersections of a given stroke with all other strokes in the layer.
 */
export function findStrokeIntersections(
  targetStroke: VectorStroke,
  allStrokes: VectorStroke[]
): IntersectionPoint[] {
  const intersections: IntersectionPoint[] = [];
  const tKnots = targetStroke.knots;
  if (tKnots.length < 2) return intersections;

  const otherStrokes = allStrokes.filter((s) => s.id !== targetStroke.id && !s.deleted);
  if (otherStrokes.length === 0) return intersections;

  const grid = new VectorSpatialGrid(128);
  for (const s of otherStrokes) {
    grid.insertStroke(s);
  }

  for (let i = 0; i < tKnots.length - 1; i++) {
    const p1 = tKnots[i];
    const p2 = tKnots[i + 1];

    const minX = Math.min(p1.x, p2.x);
    const minY = Math.min(p1.y, p2.y);
    const maxX = Math.max(p1.x, p2.x);
    const maxY = Math.max(p1.y, p2.y);

    const candidates = grid.queryBox(minX, minY, maxX, maxY);

    for (const cand of candidates) {
      const hit = findSegmentIntersection(p1, p2, cand.p1, cand.p2);
      if (hit) {
        intersections.push({
          point: hit.point,
          strokeIdA: targetStroke.id,
          segIndexA: i,
          tA: hit.tA,
          strokeIdB: cand.strokeId,
          segIndexB: cand.segIndex,
          tB: hit.tB,
        });
      }
    }
  }

  return intersections;
}

/**
 * Distance between point (px, py) and segment (x1, y1)-(x2, y2).
 */
export function pointToSegmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): { distance: number; t: number; projX: number; projY: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  if (lenSq < 1e-9) {
    const d = Math.hypot(px - x1, py - y1);
    return { distance: d, t: 0, projX: x1, projY: y1 };
  }

  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  const distance = Math.hypot(px - projX, py - projY);

  return { distance, t, projX, projY };
}

export type VectorEraserMode = 'intersection' | 'touch' | 'portion';

/**
 * Splits a target stroke at its intersections with other strokes,
 * removing the sub-segment that contains the hit point / continuous parameter.
 * Returns the surviving strokes (e.g. before the left intersection and/or after the right intersection).
 */
export function splitStrokeAtIntersection(
  targetStroke: VectorStroke,
  hitContinuousParam: number,
  allStrokes: VectorStroke[]
): { remainingStrokes: VectorStroke[]; deletedStrokeId: string } {
  const allIntersections = findStrokeIntersections(targetStroke, allStrokes);

  // Map intersections to continuous curve parameter: idx + t
  const junctionParams: number[] = [0]; // Start of stroke
  for (const inter of allIntersections) {
    junctionParams.push(inter.segIndexA + inter.tA);
  }
  junctionParams.push(targetStroke.knots.length - 1); // End of stroke

  // Sort unique junction parameters
  junctionParams.sort((a, b) => a - b);
  const uniqueJunctions = junctionParams.filter(
    (val, idx, arr) => idx === 0 || val - arr[idx - 1] > 0.05
  );

  // Find which segment interval contains the hit point
  let leftJunction = 0;
  let rightJunction = targetStroke.knots.length - 1;

  for (let j = 0; j < uniqueJunctions.length - 1; j++) {
    if (hitContinuousParam >= uniqueJunctions[j] && hitContinuousParam <= uniqueJunctions[j + 1]) {
      leftJunction = uniqueJunctions[j];
      rightJunction = uniqueJunctions[j + 1];
      break;
    }
  }

  const remainingStrokes: VectorStroke[] = [];

  // Keep part before leftJunction if significant
  if (leftJunction > 0.5) {
    const leftEndIdx = Math.floor(leftJunction);
    const subKnots = targetStroke.knots.slice(0, leftEndIdx + 1);
    if (subKnots.length >= 2) {
      remainingStrokes.push({
        id: `vstroke-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        layerId: targetStroke.layerId,
        tool: targetStroke.tool,
        knots: subKnots,
        color: targetStroke.color,
        baseWidth: targetStroke.baseWidth,
        opacity: targetStroke.opacity,
        bounds: computeStrokeBounds(subKnots),
      });
    }
  }

  // Keep part after rightJunction if significant
  if (rightJunction < targetStroke.knots.length - 1.5) {
    const rightStartIdx = Math.ceil(rightJunction);
    const subKnots = targetStroke.knots.slice(rightStartIdx);
    if (subKnots.length >= 2) {
      remainingStrokes.push({
        id: `vstroke-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        layerId: targetStroke.layerId,
        tool: targetStroke.tool,
        knots: subKnots,
        color: targetStroke.color,
        baseWidth: targetStroke.baseWidth,
        opacity: targetStroke.opacity,
        bounds: computeStrokeBounds(subKnots),
      });
    }
  }

  return { remainingStrokes, deletedStrokeId: targetStroke.id };
}

/**
 * Execute vector erasing operation across strokes in a layer.
 *
 * In "intersection" mode (Clip Studio Paint style):
 * When eraser hits a stroke, it locates the two nearest bounding intersections
 * (or curve endpoints) and deletes exactly that branch/junction segment!
 */
export function applyVectorEraser(
  eraserKnots: Point2D[],
  eraserRadius: number,
  strokes: VectorStroke[],
  mode: VectorEraserMode = 'intersection'
): { updatedStrokes: VectorStroke[]; deletedIds: string[]; createdStrokes: VectorStroke[] } {
  if (eraserKnots.length === 0 || strokes.length === 0) {
    return { updatedStrokes: strokes, deletedIds: [], createdStrokes: [] };
  }

  const resultStrokes: VectorStroke[] = [];
  const deletedIds: string[] = [];
  const createdStrokes: VectorStroke[] = [];

  for (const stroke of strokes) {
    if (stroke.deleted || stroke.knots.length < 2) {
      if (!stroke.deleted) resultStrokes.push(stroke);
      continue;
    }

    // Check if eraser trajectory hits this stroke
    let hitSegIndex = -1;
    let hitParam = 0;

    for (let i = 0; i < stroke.knots.length - 1; i++) {
      const p1 = stroke.knots[i];
      const p2 = stroke.knots[i + 1];

      for (const ePt of eraserKnots) {
        const { distance, t } = pointToSegmentDistance(ePt.x, ePt.y, p1.x, p1.y, p2.x, p2.y);
        const strokeRadius = (p1.width * (1 - t) + p2.width * t) * 0.5;
        if (distance <= eraserRadius + strokeRadius) {
          hitSegIndex = i;
          hitParam = t;
          break;
        }
      }
      if (hitSegIndex >= 0) break;
    }

    if (hitSegIndex === -1) {
      // Not touched
      resultStrokes.push(stroke);
      continue;
    }

    // Touched!
    if (mode === 'touch') {
      deletedIds.push(stroke.id);
      continue;
    }

    if (mode === 'intersection') {
      const { remainingStrokes, deletedStrokeId } = splitStrokeAtIntersection(
        stroke,
        hitSegIndex + hitParam,
        strokes
      );
      deletedIds.push(deletedStrokeId);
      for (const rem of remainingStrokes) {
        createdStrokes.push(rem);
        resultStrokes.push(rem);
      }
    } else {
      // Portion mode: delete touched slice
      deletedIds.push(stroke.id);
      // Cut stroke at hitSegIndex
      if (hitSegIndex >= 2) {
        const leftKnots = stroke.knots.slice(0, hitSegIndex);
        const newStroke: VectorStroke = {
          id: `vstroke-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          layerId: stroke.layerId,
          tool: stroke.tool,
          knots: leftKnots,
          color: stroke.color,
          baseWidth: stroke.baseWidth,
          opacity: stroke.opacity,
          bounds: computeStrokeBounds(leftKnots),
        };
        createdStrokes.push(newStroke);
        resultStrokes.push(newStroke);
      }
      if (hitSegIndex + 2 < stroke.knots.length) {
        const rightKnots = stroke.knots.slice(hitSegIndex + 2);
        const newStroke: VectorStroke = {
          id: `vstroke-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          layerId: stroke.layerId,
          tool: stroke.tool,
          knots: rightKnots,
          color: stroke.color,
          baseWidth: stroke.baseWidth,
          opacity: stroke.opacity,
          bounds: computeStrokeBounds(rightKnots),
        };
        createdStrokes.push(newStroke);
        resultStrokes.push(newStroke);
      }
    }
  }

  return { updatedStrokes: resultStrokes, deletedIds, createdStrokes };
}

/**
 * Render a single vector stroke to a Canvas 2D context using Catmull-Rom tessellation
 * with pressure-sensitive stroke width and smooth round caps.
 */
export function renderVectorStroke(
  ctx: CanvasRenderingContext2D,
  stroke: VectorStroke
): void {
  if (stroke.deleted || stroke.knots.length < 2) return;

  const tessellated = tessellateStroke(stroke);
  if (tessellated.length < 2) return;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.globalAlpha = stroke.opacity ?? 1.0;

  for (let i = 0; i < tessellated.length - 1; i++) {
    const k1 = tessellated[i];
    const k2 = tessellated[i + 1];
    const w = (k1.width + k2.width) * 0.5;

    ctx.lineWidth = Math.max(0.5, w);
    ctx.beginPath();
    ctx.moveTo(k1.x, k1.y);
    ctx.lineTo(k2.x, k2.y);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Render all vector strokes belonging to a layer.
 */
export function renderVectorLayer(
  ctx: CanvasRenderingContext2D,
  strokes: VectorStroke[],
  viewportBounds?: { minX: number; minY: number; maxX: number; maxY: number }
): void {
  for (const stroke of strokes) {
    if (stroke.deleted) continue;
    // Frustum culling for vector strokes
    if (viewportBounds) {
      if (
        stroke.bounds.maxX < viewportBounds.minX ||
        stroke.bounds.minX > viewportBounds.maxX ||
        stroke.bounds.maxY < viewportBounds.minY ||
        stroke.bounds.minY > viewportBounds.maxY
      ) {
        continue;
      }
    }
    renderVectorStroke(ctx, stroke);
  }
}

/**
 * Simplify a list of vector knots using the Ramer-Douglas-Peucker algorithm.
 * Removes redundant points along straight or smooth curves while preserving pressure and corner details.
 */
export function simplifyPathPoints(knots: VectorKnot[], tolerance = 1.0): VectorKnot[] {
  if (knots.length <= 2) return [...knots];

  const sqTolerance = tolerance * tolerance;

  function simplifySection(startIdx: number, endIdx: number): VectorKnot[] {
    let maxSqDist = 0;
    let index = startIdx;

    const p1 = knots[startIdx];
    const p2 = knots[endIdx];

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const lenSq = dx * dx + dy * dy;

    for (let i = startIdx + 1; i < endIdx; i++) {
      const p = knots[i];
      let sqDist: number;

      if (lenSq < 1e-9) {
        const dX = p.x - p1.x;
        const dY = p.y - p1.y;
        sqDist = dX * dX + dY * dY;
      } else {
        const t = Math.max(0, Math.min(1, ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / lenSq));
        const projX = p1.x + t * dx;
        const projY = p1.y + t * dy;
        const dX = p.x - projX;
        const dY = p.y - projY;
        sqDist = dX * dX + dY * dY;
      }

      if (sqDist > maxSqDist) {
        maxSqDist = sqDist;
        index = i;
      }
    }

    if (maxSqDist > sqTolerance) {
      const left = simplifySection(startIdx, index);
      const right = simplifySection(index, endIdx);
      return left.slice(0, left.length - 1).concat(right);
    } else {
      return [knots[startIdx], knots[endIdx]];
    }
  }

  return simplifySection(0, knots.length - 1);
}

/**
 * Adjust line thickness of a vector stroke (thicken or narrow).
 */
export function adjustVectorStrokeWidth(stroke: VectorStroke, deltaWidth: number): VectorStroke {
  const updatedKnots = stroke.knots.map((k) => ({
    ...k,
    width: Math.max(0.5, k.width + deltaWidth),
  }));

  const newBaseWidth = Math.max(0.5, stroke.baseWidth + deltaWidth);

  return {
    ...stroke,
    baseWidth: newBaseWidth,
    knots: updatedKnots,
    bounds: computeStrokeBounds(updatedKnots),
  };
}

/**
 * Reshape vector line by simplifying path points, adjusting thickness, or applying pinch/pull deformation.
 */
export function reshapeVectorLine(
  stroke: VectorStroke,
  options: {
    simplifyTolerance?: number;
    deltaWidth?: number;
    cursorPos?: Point2D;
    delta?: Point2D;
    radius?: number;
  }
): VectorStroke {
  let knots = stroke.knots;
  if (options.simplifyTolerance && options.simplifyTolerance > 0) {
    knots = simplifyPathPoints(knots, options.simplifyTolerance);
  }

  let baseWidth = stroke.baseWidth;
  if (options.deltaWidth !== undefined && options.deltaWidth !== 0) {
    const deltaW = options.deltaWidth;
    knots = knots.map((k) => ({
      ...k,
      width: Math.max(0.5, k.width + deltaW),
    }));
    baseWidth = Math.max(0.5, baseWidth + deltaW);
  }

  if (options.cursorPos && options.delta && options.radius && options.radius > 0) {
    const { cursorPos, delta, radius } = options;
    knots = knots.map((k) => {
      const dist = Math.hypot(k.x - cursorPos.x, k.y - cursorPos.y);
      if (dist >= radius) return k;
      const factor = Math.cos((dist / radius) * (Math.PI / 2)); // Smooth cosine falloff
      return {
        ...k,
        x: k.x + delta.x * factor,
        y: k.y + delta.y * factor,
      };
    });
  }

  return {
    ...stroke,
    baseWidth,
    knots,
    bounds: computeStrokeBounds(knots),
  };
}
