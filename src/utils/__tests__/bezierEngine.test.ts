import { describe, it, expect } from 'vitest';
import {
  buildBezierSvgPath,
  computeBezierPathBounds,
  computeBezierSegmentBounds,
  evaluateCubicBezier,
  findClosestPointOnBezierPath,
  insertBezierAnchorAt,
  moveBezierAnchor,
  moveBezierHandle,
  splitCubicBezier,
  toggleBezierAnchorSmooth,
} from '../bezierEngine';
import { computeStrokeBounds, pinchVectorStroke, tessellateStroke } from '../vectorEngine';
import type { VectorKnot, VectorStroke } from '../../types/editor';

describe('True Cubic Bézier Pen Engine & VectorStroke Integration', () => {
  it('evaluates exact cubic Bézier points and derivatives', () => {
    const p0 = { x: 0, y: 0 };
    const c1 = { x: 0, y: 100 };
    const c2 = { x: 100, y: 100 };
    const p3 = { x: 100, y: 0 };

    const start = evaluateCubicBezier(p0, c1, c2, p3, 0);
    expect(start.x).toBeCloseTo(0);
    expect(start.y).toBeCloseTo(0);
    expect(start.dy).toBeCloseTo(300);

    // Exact midpoint for symmetric arch: y = 3/4 * 100 = 75
    const mid = evaluateCubicBezier(p0, c1, c2, p3, 0.5);
    expect(mid.x).toBeCloseTo(50);
    expect(mid.y).toBeCloseTo(75);
    expect(mid.dy).toBeCloseTo(0);
  });

  it('computes exact analytical bounding box extrema (not oversized control-handle box or undersized anchor box)', () => {
    const p0 = { x: 0, y: 0 };
    const c1 = { x: 0, y: 100 };
    const c2 = { x: 100, y: 100 };
    const p3 = { x: 100, y: 0 };

    const bounds = computeBezierSegmentBounds(p0, c1, c2, p3, 0);
    expect(bounds.minX).toBeCloseTo(0);
    expect(bounds.maxX).toBeCloseTo(100);
    expect(bounds.minY).toBeCloseTo(0);
    // Exact peak is 75, NOT 0 (anchors) and NOT 100 (control handles)
    expect(bounds.maxY).toBeCloseTo(75);
  });

  it('performs exact de Casteljau subdivision preserving curve geometry across split', () => {
    const p0 = { x: 10, y: 20 };
    const c1 = { x: 30, y: 150 };
    const c2 = { x: 160, y: -40 };
    const p3 = { x: 200, y: 90 };

    const tSplit = 0.35;
    const split = splitCubicBezier(p0, c1, c2, p3, tSplit);

    // Every sample along left half u in [0,1] must match original at u * tSplit
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const orig = evaluateCubicBezier(p0, c1, c2, p3, u * tSplit);
      const sub = evaluateCubicBezier(p0, split.leftC1, split.leftC2, split.mid, u);
      expect(sub.x).toBeCloseTo(orig.x, 5);
      expect(sub.y).toBeCloseTo(orig.y, 5);
    }

    // Every sample along right half u in [0,1] must match original at tSplit + u * (1 - tSplit)
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const orig = evaluateCubicBezier(p0, c1, c2, p3, tSplit + u * (1 - tSplit));
      const sub = evaluateCubicBezier(split.mid, split.rightC1, split.rightC2, p3, u);
      expect(sub.x).toBeCloseTo(orig.x, 5);
      expect(sub.y).toBeCloseTo(orig.y, 5);
    }
  });

  it('inserts an anchor onto a Bézier path without shifting the curve and locates closest curve points', () => {
    const knots: VectorKnot[] = [
      {
        x: 0,
        y: 0,
        pressure: 1,
        width: 4,
        timestamp: 0,
        handleIn: null,
        handleOut: { x: 0, y: 100 },
        handleType: 'corner',
      },
      {
        x: 100,
        y: 0,
        pressure: 1,
        width: 4,
        timestamp: 1,
        handleIn: { x: 100, y: 100 },
        handleOut: null,
        handleType: 'corner',
      },
    ];

    const hit = findClosestPointOnBezierPath(knots, { x: 50, y: 78 }, false);
    expect(hit).not.toBeNull();
    expect(hit!.segmentIndex).toBe(0);
    expect(hit!.t).toBeCloseTo(0.5, 2);
    expect(hit!.distance).toBeCloseTo(3, 1);

    const { knots: nextKnots, insertedIndex } = insertBezierAnchorAt(knots, 0, 0.5, false);
    expect(insertedIndex).toBe(1);
    expect(nextKnots).toHaveLength(3);
    expect(nextKnots[1].x).toBeCloseTo(50);
    expect(nextKnots[1].y).toBeCloseTo(75);
    expect(nextKnots[1].handleIn).not.toBeNull();
    expect(nextKnots[1].handleOut).not.toBeNull();
  });

  it('supports symmetric, smooth, and broken-corner handle dragging and anchor translation', () => {
    const knot: VectorKnot = {
      x: 50,
      y: 50,
      pressure: 1,
      width: 4,
      timestamp: 0,
      handleIn: { x: 30, y: 50 },
      handleOut: { x: 70, y: 50 },
      handleType: 'symmetric',
    };

    // Symmetric handle mirrors opposite side
    const sym = moveBezierHandle(knot, 'out', { x: 80, y: 70 }, false);
    expect(sym.handleIn?.x).toBeCloseTo(20);
    expect(sym.handleIn?.y).toBeCloseTo(30);

    // Alt break-symmetry leaves opposite handle untouched and converts to corner
    const broken = moveBezierHandle(knot, 'out', { x: 90, y: 90 }, true);
    expect(broken.handleType).toBe('corner');
    expect(broken.handleIn?.x).toBe(30);
    expect(broken.handleIn?.y).toBe(50);

    // Translating anchor shifts both handles by identical delta
    const moved = moveBezierAnchor(knot, { x: 60, y: 65 });
    expect(moved.handleIn).toEqual({ x: 40, y: 65 });
    expect(moved.handleOut).toEqual({ x: 80, y: 65 });

    // Toggling smooth/corner removes handles, toggling again restores auto-tangents
    const toggledCorner = toggleBezierAnchorSmooth([knot], 0, false);
    expect(toggledCorner[0].handleIn).toBeNull();
    expect(toggledCorner[0].handleOut).toBeNull();
  });

  it('integrates true Bézier strokes with VectorStroke bounds, tessellation, SVG path, and pinchVectorStroke', () => {
    const knots: VectorKnot[] = [
      {
        x: 0,
        y: 0,
        pressure: 1,
        width: 4,
        timestamp: 0,
        handleIn: null,
        handleOut: { x: 0, y: 100 },
        handleType: 'corner',
      },
      {
        x: 100,
        y: 0,
        pressure: 1,
        width: 4,
        timestamp: 1,
        handleIn: { x: 100, y: 100 },
        handleOut: null,
        handleType: 'corner',
      },
    ];

    const bounds = computeStrokeBounds(knots, false, 'bezier');
    expect(bounds.maxY).toBeCloseTo(77, 1); // 75 + halfWidth(2)

    const stroke: VectorStroke = {
      id: 'bezier-1',
      layerId: 'vec-1',
      tool: 'pen',
      curveType: 'bezier',
      closed: false,
      knots,
      color: '#000000',
      baseWidth: 4,
      opacity: 1,
      bounds,
    };

    const tess = tessellateStroke(stroke, 8);
    expect(tess.length).toBeGreaterThan(8);
    const maxY = Math.max(...tess.map((p) => p.y));
    expect(maxY).toBeGreaterThan(72);

    const svgD = buildBezierSvgPath(knots, false);
    expect(svgD).toBe('M 0 0 C 0 100, 100 100, 100 0');

    // Pinching knot translates its handleOut along with it
    const pinched = pinchVectorStroke(stroke, { x: 0, y: 0 }, 20, { x: 10, y: 5 });
    expect(pinched.knots[0].x).toBeCloseTo(10);
    expect(pinched.knots[0].handleOut?.x).toBeCloseTo(10);
    expect(pinched.knots[0].handleOut?.y).toBeCloseTo(105);
    expect(computeBezierPathBounds(pinched.knots, false).maxY).toBeGreaterThan(75);
  });
});
