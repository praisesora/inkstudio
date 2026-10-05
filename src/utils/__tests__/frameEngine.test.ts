import { describe, it, expect } from 'vitest';
import {
  mmToPixels,
  pixelsToMm,
  createDefaultPageFrame,
  bisectComicFrame,
  isPointInsidePolygon,
} from '../frameEngine';

describe('Comic Frame Engine (Koma-wari)', () => {
  it('converts millimeters to pixels accurately at 600 DPI', () => {
    // 1 inch = 25.4mm = 600 pixels
    expect(mmToPixels(25.4, 600)).toBeCloseTo(600);
    // 3mm manga gutter at 600 DPI: (3 * 600) / 25.4 = ~70.866 px
    expect(mmToPixels(3, 600)).toBeCloseTo(70.866, 2);
    // 5mm manga gutter at 600 DPI: (5 * 600) / 25.4 = ~118.11 px
    expect(mmToPixels(5, 600)).toBeCloseTo(118.11, 2);

    expect(pixelsToMm(600, 600)).toBeCloseTo(25.4);
  });

  it('creates default page frame fitting within document bounds', () => {
    const frame = createDefaultPageFrame('layer-frame', 4961, 7016, 600, 20);
    expect(frame.polygon.length).toBe(4);
    expect(frame.polygon[0].x).toBeGreaterThan(0);
    expect(frame.polygon[1].x).toBeLessThan(4961);
    expect(frame.clipChildren).toBe(true);
  });

  it('bisects a rectangular frame horizontally into top and bottom child frames', () => {
    const frame = {
      id: 'frame-test',
      layerId: 'layer-frame',
      polygon: [
        { x: 100, y: 100 },
        { x: 900, y: 100 },
        { x: 900, y: 900 },
        { x: 100, y: 900 },
      ],
      borderWidth: 4,
      gutterVertical: 70,
      gutterHorizontal: 118,
      clipChildren: true,
    };

    // Horizontal slash at y = 500
    const result = bisectComicFrame(frame, { x: 50, y: 500 }, { x: 950, y: 500 }, 600);
    expect(result).not.toBeNull();
    if (!result) return;

    const [child1, child2] = result;
    expect(child1.polygon.length).toBeGreaterThanOrEqual(4);
    expect(child2.polygon.length).toBeGreaterThanOrEqual(4);

    // One child should be above the cut and one below
    const center1Y = child1.polygon.reduce((acc, p) => acc + p.y, 0) / child1.polygon.length;
    const center2Y = child2.polygon.reduce((acc, p) => acc + p.y, 0) / child2.polygon.length;

    expect(Math.abs(center1Y - center2Y)).toBeGreaterThan(100);
  });

  it('correctly determines whether a point is inside a frame polygon', () => {
    const poly = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];

    expect(isPointInsidePolygon({ x: 50, y: 50 }, poly)).toBe(true);
    expect(isPointInsidePolygon({ x: 150, y: 50 }, poly)).toBe(false);
    expect(isPointInsidePolygon({ x: -10, y: 50 }, poly)).toBe(false);
  });
});
