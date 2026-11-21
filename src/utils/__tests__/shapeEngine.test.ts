import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SHAPE_SETTINGS,
  ShapeSettings,
  computeShapeGeometry,
  buildPolygonVertices,
  buildStarVertices,
  buildShapeSvgPaths,
  resolveShapeFillColor,
  drawShapeToContext,
} from '../shapeEngine';

describe('shapeEngine', () => {
  it('computes unconstrained and Shift-constrained rectangle / square geometry', () => {
    const base: ShapeSettings = { ...DEFAULT_SHAPE_SETTINGS, shape: 'rectangle' };
    const rect = computeShapeGeometry({ x: 10, y: 20 }, { x: 110, y: 70 }, base, false, false);
    expect(rect.x).toBe(10);
    expect(rect.y).toBe(20);
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(50);

    const square = computeShapeGeometry({ x: 10, y: 20 }, { x: 110, y: 70 }, base, true, false);
    expect(square.width).toBe(100);
    expect(square.height).toBe(100);
  });

  it('supports Alt (from-center) symmetry for closed shapes', () => {
    const base: ShapeSettings = { ...DEFAULT_SHAPE_SETTINGS, shape: 'ellipse' };
    const centered = computeShapeGeometry({ x: 100, y: 100 }, { x: 140, y: 120 }, base, false, true);
    expect(centered.x).toBe(60);
    expect(centered.y).toBe(80);
    expect(centered.width).toBe(80);
    expect(centered.height).toBe(40);
  });

  it('snaps line angles to 15-degree increments when Shift is held', () => {
    const lineSettings: ShapeSettings = { ...DEFAULT_SHAPE_SETTINGS, shape: 'line' };
    // ~42 deg should snap to 45 deg
    const snapped = computeShapeGeometry({ x: 0, y: 0 }, { x: 100, y: 90 }, lineSettings, true, false);
    expect(snapped.angleDeg).toBeCloseTo(45, 3);
    expect(snapped.x2).toBeCloseTo(snapped.y2, 3);
  });

  it('builds valid polygon and star vertices', () => {
    const hex = buildPolygonVertices(0, 0, 100, 100, 6);
    expect(hex).toHaveLength(6);
    expect(hex[0].x).toBeCloseTo(50, 4);
    expect(hex[0].y).toBeCloseTo(0, 4);

    const star = buildStarVertices(0, 0, 100, 100, 5, 0.5);
    expect(star).toHaveLength(10);
  });

  it('generates SVG preview paths for all supported geometric shapes', () => {
    const kinds = [
      'line',
      'arrow',
      'rectangle',
      'rounded-rect',
      'ellipse',
      'triangle',
      'polygon',
      'star',
    ] as const;

    for (const shape of kinds) {
      const res = buildShapeSvgPaths({
        start: { x: 10, y: 10 },
        end: { x: 110, y: 90 },
        shiftKey: false,
        altKey: false,
        settings: { ...DEFAULT_SHAPE_SETTINGS, shape },
      });
      expect(res.mainPath.length).toBeGreaterThan(5);
      if (shape === 'arrow') {
        expect(res.arrowHeadPath).toBeTruthy();
      }
    }
  });

  it('resolves fill color modes accurately', () => {
    expect(
      resolveShapeFillColor({ ...DEFAULT_SHAPE_SETTINGS, fillColorMode: 'primary' }, '#111111', '#eeeeee')
    ).toBe('#111111');
    expect(
      resolveShapeFillColor({ ...DEFAULT_SHAPE_SETTINGS, fillColorMode: 'secondary' }, '#111111', '#eeeeee')
    ).toBe('#eeeeee');
    expect(
      resolveShapeFillColor(
        { ...DEFAULT_SHAPE_SETTINGS, fillColorMode: 'custom', customFillColor: '#ff0055' },
        '#111111',
        '#eeeeee'
      )
    ).toBe('#ff0055');
  });

  it('applies dashed line patterns and fill/stroke modes on CanvasRenderingContext2D', () => {
    const setLineDash = vi.fn();
    const stroke = vi.fn();
    const fill = vi.fn();
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      rect: vi.fn(),
      ellipse: vi.fn(),
      quadraticCurveTo: vi.fn(),
      setLineDash,
      stroke,
      fill,
      globalAlpha: 1,
      lineWidth: 1,
      lineCap: 'round',
      lineJoin: 'miter',
      strokeStyle: '',
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D;

    drawShapeToContext(
      ctx,
      {
        start: { x: 0, y: 0 },
        end: { x: 80, y: 40 },
        shiftKey: false,
        altKey: false,
        settings: {
          ...DEFAULT_SHAPE_SETTINGS,
          shape: 'line',
          dashed: true,
          dashLength: 12,
          dashGap: 6,
        },
      },
      '#000000',
      '#ffffff'
    );

    expect(setLineDash).toHaveBeenCalledWith([12, 6]);
    expect(stroke).toHaveBeenCalledTimes(1);
    expect(fill).not.toHaveBeenCalled();

    setLineDash.mockClear();
    stroke.mockClear();
    fill.mockClear();

    drawShapeToContext(
      ctx,
      {
        start: { x: 0, y: 0 },
        end: { x: 80, y: 80 },
        shiftKey: false,
        altKey: false,
        settings: {
          ...DEFAULT_SHAPE_SETTINGS,
          shape: 'triangle',
          mode: 'both',
          dashed: false,
        },
      },
      '#000000',
      '#ff0000'
    );

    expect(setLineDash).toHaveBeenCalledWith([]);
    expect(fill).toHaveBeenCalledTimes(1);
    expect(stroke).toHaveBeenCalledTimes(1);
  });
});
