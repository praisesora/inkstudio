import { describe, it, expect } from 'vitest';
import {
  evaluateCatmullRom,
  findSegmentIntersection,
  VectorSpatialGrid,
  applyVectorEraser,
  splitStrokeAtIntersection,
  simplifyPathPoints,
  adjustVectorStrokeWidth,
  reshapeVectorLine,
} from '../vectorEngine';
import { VectorKnot, VectorStroke } from '../../types/editor';

describe('Vector Inking Engine & Vector Eraser', () => {
  it('smoothly interpolates Catmull-Rom splines with variable pressure', () => {
    const k0: VectorKnot = { x: 0, y: 0, pressure: 0.2, width: 2, timestamp: 0 };
    const k1: VectorKnot = { x: 10, y: 0, pressure: 0.5, width: 5, timestamp: 10 };
    const k2: VectorKnot = { x: 20, y: 10, pressure: 0.8, width: 8, timestamp: 20 };
    const k3: VectorKnot = { x: 30, y: 10, pressure: 1.0, width: 10, timestamp: 30 };

    const mid = evaluateCatmullRom(k0, k1, k2, k3, 0.5);
    expect(mid.x).toBeGreaterThan(10);
    expect(mid.x).toBeLessThan(20);
    expect(mid.width).toBeGreaterThan(5);
    expect(mid.width).toBeLessThan(8);
  });

  it('accurately detects segment intersections', () => {
    // Horizontal line: (0, 5) to (10, 5)
    // Vertical line: (5, 0) to (5, 10)
    const hit = findSegmentIntersection(
      { x: 0, y: 5 },
      { x: 10, y: 5 },
      { x: 5, y: 0 },
      { x: 5, y: 10 }
    );

    expect(hit).not.toBeNull();
    expect(hit?.point.x).toBeCloseTo(5);
    expect(hit?.point.y).toBeCloseTo(5);
    expect(hit?.tA).toBeCloseTo(0.5);
    expect(hit?.tB).toBeCloseTo(0.5);
  });

  it('spatial grid indexes and retrieves intersecting stroke segments', () => {
    const grid = new VectorSpatialGrid(128);

    const stroke1: VectorStroke = {
      id: 'stroke-1',
      layerId: 'vector-1',
      tool: 'brush',
      knots: [
        { x: 0, y: 50, pressure: 0.5, width: 4, timestamp: 0 },
        { x: 200, y: 50, pressure: 0.5, width: 4, timestamp: 10 },
      ],
      color: '#000000',
      baseWidth: 4,
      opacity: 1,
      bounds: { minX: 0, minY: 48, maxX: 200, maxY: 52 },
    };

    grid.insertStroke(stroke1);

    // Query box overlapping the segment
    const hits = grid.queryBox(40, 40, 60, 60);
    expect(hits.length).toBe(1);
    expect(hits[0].strokeId).toBe('stroke-1');

    // Query box away from the segment
    const misses = grid.queryBox(300, 300, 400, 400);
    expect(misses.length).toBe(0);
  });

  it('performs authentic "Erase Up to Intersection" (koma-wari style)', () => {
    // Cross strokes:
    // Stroke A: horizontal line from (0, 50) to (100, 50)
    // Stroke B: vertical line from (50, 0) to (50, 100)
    // They intersect at (50, 50).
    const strokeA: VectorStroke = {
      id: 'stroke-A',
      layerId: 'v1',
      tool: 'brush',
      knots: [
        { x: 0, y: 50, pressure: 0.5, width: 4, timestamp: 0 },
        { x: 25, y: 50, pressure: 0.5, width: 4, timestamp: 5 },
        { x: 50, y: 50, pressure: 0.5, width: 4, timestamp: 10 },
        { x: 75, y: 50, pressure: 0.5, width: 4, timestamp: 15 },
        { x: 100, y: 50, pressure: 0.5, width: 4, timestamp: 20 },
      ],
      color: '#000000',
      baseWidth: 4,
      opacity: 1,
      bounds: { minX: 0, minY: 48, maxX: 100, maxY: 52 },
    };

    const strokeB: VectorStroke = {
      id: 'stroke-B',
      layerId: 'v1',
      tool: 'brush',
      knots: [
        { x: 50, y: 0, pressure: 0.5, width: 4, timestamp: 0 },
        { x: 50, y: 25, pressure: 0.5, width: 4, timestamp: 5 },
        { x: 50, y: 50, pressure: 0.5, width: 4, timestamp: 10 },
        { x: 50, y: 75, pressure: 0.5, width: 4, timestamp: 15 },
        { x: 50, y: 100, pressure: 0.5, width: 4, timestamp: 20 },
      ],
      color: '#000000',
      baseWidth: 4,
      opacity: 1,
      bounds: { minX: 48, minY: 0, maxX: 52, maxY: 100 },
    };

    const strokes = [strokeA, strokeB];

    // Erase right branch of Stroke A (touching x=80, y=50)
    const eraserKnots = [{ x: 80, y: 50 }];
    const res = applyVectorEraser(eraserKnots, 5, strokes, 'intersection');

    expect(res.deletedIds).toContain('stroke-A');
    expect(res.deletedIds).not.toContain('stroke-B');

    // The left portion (0 to 50) before the intersection should remain!
    expect(res.createdStrokes.length).toBeGreaterThanOrEqual(1);
    const retained = res.createdStrokes[0];
    expect(retained.knots[0].x).toBe(0);
    expect(retained.knots[retained.knots.length - 1].x).toBeLessThanOrEqual(60);
  });

  it('splitStrokeAtIntersection prunes branch up to crossing intersection point', () => {
    const strokeA: VectorStroke = {
      id: 'stroke-A',
      layerId: 'v1',
      tool: 'brush',
      knots: [
        { x: 0, y: 50, pressure: 0.5, width: 4, timestamp: 0 },
        { x: 50, y: 50, pressure: 0.5, width: 4, timestamp: 10 },
        { x: 100, y: 50, pressure: 0.5, width: 4, timestamp: 20 },
      ],
      color: '#000000',
      baseWidth: 4,
      opacity: 1,
      bounds: { minX: 0, minY: 48, maxX: 100, maxY: 52 },
    };

    const strokeB: VectorStroke = {
      id: 'stroke-B',
      layerId: 'v1',
      tool: 'brush',
      knots: [
        { x: 50, y: 0, pressure: 0.5, width: 4, timestamp: 0 },
        { x: 50, y: 100, pressure: 0.5, width: 4, timestamp: 20 },
      ],
      color: '#000000',
      baseWidth: 4,
      opacity: 1,
      bounds: { minX: 48, minY: 0, maxX: 52, maxY: 100 },
    };

    // Hit parameter t = 1.5 (on the right side of the intersection at t = 1.0)
    const result = splitStrokeAtIntersection(strokeA, 1.5, [strokeA, strokeB]);
    expect(result.remainingStrokes.length).toBe(1);
    // Preserved segment should be from start to intersection at ~50
    expect(result.remainingStrokes[0].knots[0].x).toBe(0);
    expect(result.remainingStrokes[0].knots[result.remainingStrokes[0].knots.length - 1].x).toBeCloseTo(50, 0);
  });

  it('simplifyPathPoints reduces redundant collinear knots using Ramer-Douglas-Peucker', () => {
    const knots: VectorKnot[] = [
      { x: 0, y: 0, pressure: 0.5, width: 2, timestamp: 0 },
      { x: 10, y: 0.1, pressure: 0.5, width: 2, timestamp: 10 },
      { x: 20, y: -0.1, pressure: 0.5, width: 2, timestamp: 20 },
      { x: 30, y: 0.05, pressure: 0.5, width: 2, timestamp: 30 },
      { x: 40, y: 0, pressure: 0.5, width: 2, timestamp: 40 },
      { x: 50, y: 25, pressure: 0.8, width: 4, timestamp: 50 },
      { x: 60, y: 50, pressure: 0.5, width: 2, timestamp: 60 },
    ];

    const simplified = simplifyPathPoints(knots, 1.0);
    expect(simplified.length).toBeLessThan(knots.length);
    expect(simplified[0].x).toBe(0);
    expect(simplified[simplified.length - 1].x).toBe(60);
  });

  it('adjustVectorStrokeWidth scales knot widths and updates bounding box', () => {
    const stroke: VectorStroke = {
      id: 'stroke-scale',
      layerId: 'v1',
      tool: 'brush',
      knots: [
        { x: 10, y: 10, pressure: 0.5, width: 4, timestamp: 0 },
        { x: 50, y: 50, pressure: 0.5, width: 4, timestamp: 10 },
      ],
      color: '#000000',
      baseWidth: 4,
      opacity: 1,
      bounds: { minX: 8, minY: 8, maxX: 52, maxY: 52 },
    };

    const thickened = adjustVectorStrokeWidth(stroke, 2);
    expect(thickened.baseWidth).toBe(6);
    expect(thickened.knots[0].width).toBe(6);
    expect(thickened.bounds.minX).toBeLessThan(stroke.bounds.minX);
  });

  it('reshapeVectorLine applies pinch/pull transformations to knots near cursor', () => {
    const stroke: VectorStroke = {
      id: 'stroke-reshape',
      layerId: 'v1',
      tool: 'brush',
      knots: [
        { x: 0, y: 50, pressure: 0.5, width: 4, timestamp: 0 },
        { x: 50, y: 50, pressure: 0.5, width: 4, timestamp: 10 },
        { x: 100, y: 50, pressure: 0.5, width: 4, timestamp: 20 },
      ],
      color: '#000000',
      baseWidth: 4,
      opacity: 1,
      bounds: { minX: 0, minY: 48, maxX: 100, maxY: 52 },
    };

    const reshaped = reshapeVectorLine(stroke, {
      cursorPos: { x: 50, y: 50 },
      delta: { x: 0, y: 30 },
      radius: 40,
    });

    // Middle knot near (50, 50) should be pulled downward towards y = 80
    expect(reshaped.knots[1].y).toBeGreaterThan(50);
    // Endpoints outside radius should remain unchanged
    expect(reshaped.knots[0].x).toBe(0);
    expect(reshaped.knots[0].y).toBe(50);
    expect(reshaped.knots[2].x).toBe(100);
    expect(reshaped.knots[2].y).toBe(50);
  });
});
