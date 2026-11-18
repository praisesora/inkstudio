/**
 * Comic Panel / Frame Border Tool (Koma-wari)
 *
 * Implements Clip Studio Paint-grade vector frame borders, polygon bisection (koma-cutting),
 * standard manga gutters (3mm vertical, 5mm horizontal at 600 DPI), and polygon clipping masks.
 */

import { ComicFrame } from '../types/editor';

export interface Point2D {
  x: number;
  y: number;
}

/**
 * Standard Manga Gutter Presets (in millimeters)
 */
export const MANGA_GUTTER_VERTICAL_MM = 3.0; // 3mm vertical gutter (tate-koma)
export const MANGA_GUTTER_HORIZONTAL_MM = 5.0; // 5mm horizontal gutter (yoko-koma)

/**
 * Convert millimeters to document pixels at a specified DPI.
 */
export function mmToPixels(mm: number, dpi = 600): number {
  return (mm * dpi) / 25.4;
}

/**
 * Convert pixels to millimeters at a specified DPI.
 */
export function pixelsToMm(pixels: number, dpi = 600): number {
  return (pixels * 25.4) / dpi;
}

/**
 * Creates a default outer manga comic frame fitting within document margins.
 */
export function createDefaultPageFrame(
  layerId: string,
  docWidth: number,
  docHeight: number,
  dpi = 600,
  marginMm = 20
): ComicFrame {
  const marginPx = mmToPixels(marginMm, dpi);
  const left = Math.max(10, marginPx);
  const top = Math.max(10, marginPx);
  const right = Math.min(docWidth - 10, docWidth - marginPx);
  const bottom = Math.min(docHeight - 10, docHeight - marginPx);

  return {
    id: `frame-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    layerId,
    polygon: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ],
    borderWidth: Math.max(2, Math.round(mmToPixels(0.5, dpi))), // ~0.5mm line
    gutterVertical: mmToPixels(MANGA_GUTTER_VERTICAL_MM, dpi),
    gutterHorizontal: mmToPixels(MANGA_GUTTER_HORIZONTAL_MM, dpi),
    clipChildren: true,
  };
}

/**
 * Line-segment intersection test between an infinite cut line (p1 -> p2) and a segment (s1 -> s2).
 */
export function intersectCutLineWithSegment(
  p1: Point2D,
  p2: Point2D,
  s1: Point2D,
  s2: Point2D
): { point: Point2D; edgeIndexParam: number } | null {
  const cutDx = p2.x - p1.x;
  const cutDy = p2.y - p1.y;
  const segDx = s2.x - s1.x;
  const segDy = s2.y - s1.y;

  const denom = cutDx * segDy - cutDy * segDx;
  if (Math.abs(denom) < 1e-9) return null; // Collinear or parallel

  const dX = s1.x - p1.x;
  const dY = s1.y - p1.y;

  const tSeg = (dX * cutDy - dY * cutDx) / denom;

  // We require tSeg to be strictly along the edge segment [0, 1]
  if (tSeg >= 0 && tSeg <= 1) {
    return {
      point: {
        x: s1.x + tSeg * segDx,
        y: s1.y + tSeg * segDy,
      },
      edgeIndexParam: tSeg,
    };
  }

  return null;
}

/**
 * Bisect a comic frame polygon along a user-drawn slash line into two child polygon frames.
 * Automatically separates child frames by the manga gutter width (vertical vs horizontal).
 */
export function bisectComicFrame(
  frame: ComicFrame,
  cutStart: Point2D,
  cutEnd: Point2D,
  dpi = 600
): [ComicFrame, ComicFrame] | null {
  const poly = frame.polygon;
  if (poly.length < 3) return null;

  // 1. Find intersections of cut line with all edges of the polygon
  const hits: Array<{ edgeIndex: number; tSeg: number; point: Point2D }> = [];

  for (let i = 0; i < poly.length; i++) {
    const s1 = poly[i];
    const s2 = poly[(i + 1) % poly.length];
    const hit = intersectCutLineWithSegment(cutStart, cutEnd, s1, s2);
    if (hit) {
      hits.push({
        edgeIndex: i,
        tSeg: hit.edgeIndexParam,
        point: hit.point,
      });
    }
  }

  // Must intersect polygon boundary at exactly 2 points for a clean bisection
  if (hits.length < 2) return null;

  // Sort hits along the cut line direction
  const cutVec = { x: cutEnd.x - cutStart.x, y: cutEnd.y - cutStart.y };
  hits.sort((a, b) => {
    const dotA = (a.point.x - cutStart.x) * cutVec.x + (a.point.y - cutStart.y) * cutVec.y;
    const dotB = (b.point.x - cutStart.x) * cutVec.x + (b.point.y - cutStart.y) * cutVec.y;
    return dotA - dotB;
  });

  const hitA = hits[0];
  const hitB = hits[hits.length - 1];

  // 2. Determine Gutter distance and normal offset direction
  const isMoreVertical = Math.abs(cutVec.y) >= Math.abs(cutVec.x);
  const gutterDistance = isMoreVertical
    ? frame.gutterVertical || mmToPixels(MANGA_GUTTER_VERTICAL_MM, dpi)
    : frame.gutterHorizontal || mmToPixels(MANGA_GUTTER_HORIZONTAL_MM, dpi);

  const halfGutter = gutterDistance * 0.5;

  // Cut normal unit vector (perpendicular to cut line)
  const cutLen = Math.hypot(cutVec.x, cutVec.y) || 1;
  const normal = {
    x: -cutVec.y / cutLen,
    y: cutVec.x / cutLen,
  };

  // 3. Assemble child polygon 1 and child polygon 2
  // Child 1: from hitA along poly edges to hitB, then back to hitA
  const poly1: Point2D[] = [];
  const poly2: Point2D[] = [];

  const eA = hitA.edgeIndex;
  const eB = hitB.edgeIndex;

  // Polygon 1
  poly1.push({ ...hitA.point });
  let curr = (eA + 1) % poly.length;
  while (curr !== (eB + 1) % poly.length) {
    poly1.push({ ...poly[curr] });
    curr = (curr + 1) % poly.length;
  }
  poly1.push({ ...hitB.point });

  // Polygon 2
  poly2.push({ ...hitB.point });
  curr = (eB + 1) % poly.length;
  while (curr !== (eA + 1) % poly.length) {
    poly2.push({ ...poly[curr] });
    curr = (curr + 1) % poly.length;
  }
  poly2.push({ ...hitA.point });

  // 4. Inset both polygons by halfGutter away from the cut line
  let c1x = 0;
  let c1y = 0;
  for (const p of poly1) {
    c1x += p.x;
    c1y += p.y;
  }
  c1x /= Math.max(1, poly1.length);
  c1y /= Math.max(1, poly1.length);
  const midCutX = (hitA.point.x + hitB.point.x) * 0.5;
  const midCutY = (hitA.point.y + hitB.point.y) * 0.5;
  const dotSide = (c1x - midCutX) * normal.x + (c1y - midCutY) * normal.y;
  const sign = dotSide >= 0 ? 1 : -1;
  const nX = normal.x * sign;
  const nY = normal.y * sign;

  const insetPoly1 = poly1.map((p) => {
    const isSeam =
      Math.hypot(p.x - hitA.point.x, p.y - hitA.point.y) < 1e-3 ||
      Math.hypot(p.x - hitB.point.x, p.y - hitB.point.y) < 1e-3;
    if (isSeam) {
      return { x: p.x + nX * halfGutter, y: p.y + nY * halfGutter };
    }
    return p;
  });

  const insetPoly2 = poly2.map((p) => {
    const isSeam =
      Math.hypot(p.x - hitA.point.x, p.y - hitA.point.y) < 1e-3 ||
      Math.hypot(p.x - hitB.point.x, p.y - hitB.point.y) < 1e-3;
    if (isSeam) {
      return { x: p.x - nX * halfGutter, y: p.y - nY * halfGutter };
    }
    return p;
  });

  const child1: ComicFrame = {
    id: `frame-${Date.now()}-1`,
    layerId: frame.layerId,
    polygon: insetPoly1,
    borderWidth: frame.borderWidth,
    gutterVertical: frame.gutterVertical,
    gutterHorizontal: frame.gutterHorizontal,
    clipChildren: frame.clipChildren,
  };

  const child2: ComicFrame = {
    id: `frame-${Date.now()}-2`,
    layerId: frame.layerId,
    polygon: insetPoly2,
    borderWidth: frame.borderWidth,
    gutterVertical: frame.gutterVertical,
    gutterHorizontal: frame.gutterHorizontal,
    clipChildren: frame.clipChildren,
  };

  return [child1, child2];
}

/**
 * Checks if a point is inside a polygon using ray casting.
 */
export function isPointInsidePolygon(point: Point2D, polygon: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Apply polygon clipping path to a Canvas 2D context.
 */
export function applyFrameClip(ctx: CanvasRenderingContext2D, frame: ComicFrame): void {
  const poly = frame.polygon;
  if (poly.length < 3) return;

  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) {
    ctx.lineTo(poly[i].x, poly[i].y);
  }
  ctx.closePath();
  ctx.clip();
}

/**
 * Render black manga frame borders and optional paper white background.
 */
export function renderFrameBorder(
  ctx: CanvasRenderingContext2D,
  frame: ComicFrame,
  fillBackground = true,
  fillColor = '#ffffff'
): void {
  const poly = frame.polygon;
  if (poly.length < 3) return;

  ctx.save();

  if (fillBackground) {
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i].x, poly[i].y);
    }
    ctx.closePath();
    ctx.fill();
  }

  // Draw crisp border stroke
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = frame.borderWidth || 3;
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 4;
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) {
    ctx.lineTo(poly[i].x, poly[i].y);
  }
  ctx.closePath();
  ctx.stroke();

  ctx.restore();
}
