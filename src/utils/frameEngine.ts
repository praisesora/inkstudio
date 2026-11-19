/**
 * Comic Panel / Frame Border Engine (Koma-wari)
 *
 * Clip Studio Paint-grade vector frame border folders:
 * - Exact half-plane polygon bisection with automatic vertical/horizontal manga gutters
 * - Single-folder and split-folder frame division
 * - Ear-clipping triangulation & mitered border geometry for WebGL2 stencil compositing
 * - Canvas 2D multi-frame polygon clipping and border rendering
 */

import { ComicFrame, FrameDivideMode } from '../types/editor';

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
 * Computes signed area of a 2D polygon (positive = CW in screen coords Y-down).
 */
export function signedPolygonArea(polygon: Point2D[]): number {
  if (polygon.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum * 0.5;
}

export function polygonArea(polygon: Point2D[]): number {
  return Math.abs(signedPolygonArea(polygon));
}

function deduplicatePolygon(poly: Point2D[], eps = 1e-4): Point2D[] {
  const out: Point2D[] = [];
  for (const p of poly) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > eps) {
      out.push(p);
    }
  }
  if (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= eps) {
      out.pop();
    }
  }
  return out;
}

/**
 * Creates a rectangular comic frame with explicit bounds and gutter settings.
 */
export function createRectFrame(
  layerId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  options: {
    dpi?: number;
    borderWidth?: number;
    gutterVerticalPx?: number;
    gutterHorizontalPx?: number;
    fillBackground?: boolean;
    fillColor?: string;
    strokeColor?: string;
  } = {}
): ComicFrame {
  const dpi = options.dpi ?? 600;
  const left = Math.min(x, x + width);
  const top = Math.min(y, y + height);
  const right = Math.max(x, x + width);
  const bottom = Math.max(y, y + height);

  return {
    id: `frame-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    layerId,
    polygon: [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ],
    borderWidth: options.borderWidth ?? Math.max(2, Math.round(mmToPixels(0.5, dpi))),
    gutterVertical: options.gutterVerticalPx ?? mmToPixels(MANGA_GUTTER_VERTICAL_MM, dpi),
    gutterHorizontal: options.gutterHorizontalPx ?? mmToPixels(MANGA_GUTTER_HORIZONTAL_MM, dpi),
    clipChildren: true,
    fillBackground: options.fillBackground ?? true,
    fillColor: options.fillColor ?? '#ffffff',
    strokeColor: options.strokeColor ?? '#000000',
  };
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

  return createRectFrame(layerId, left, top, Math.max(20, right - left), Math.max(20, bottom - top), {
    dpi,
  });
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

  // Require tSeg strictly along the edge segment [0, 1]
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
 * Clips a polygon against a half-plane defined by: (p - origin) . normal >= offset.
 * Uses Sutherland-Hodgman clipping for exact non-protruding seam vertices.
 */
export function clipPolygonHalfPlane(
  polygon: Point2D[],
  origin: Point2D,
  normal: Point2D,
  offset: number
): Point2D[] {
  if (polygon.length < 3) return [];
  const out: Point2D[] = [];
  const evalDist = (p: Point2D) =>
    (p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y - offset;

  for (let i = 0; i < polygon.length; i++) {
    const curr = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    const dCurr = evalDist(curr);
    const dNext = evalDist(next);
    const currInside = dCurr >= -1e-6;
    const nextInside = dNext >= -1e-6;

    if (currInside && nextInside) {
      out.push({ x: next.x, y: next.y });
    } else if (currInside && !nextInside) {
      const denom = dCurr - dNext;
      if (Math.abs(denom) > 1e-9) {
        const t = Math.max(0, Math.min(1, dCurr / denom));
        out.push({
          x: curr.x + (next.x - curr.x) * t,
          y: curr.y + (next.y - curr.y) * t,
        });
      }
    } else if (!currInside && nextInside) {
      const denom = dCurr - dNext;
      if (Math.abs(denom) > 1e-9) {
        const t = Math.max(0, Math.min(1, dCurr / denom));
        out.push({
          x: curr.x + (next.x - curr.x) * t,
          y: curr.y + (next.y - curr.y) * t,
        });
      }
      out.push({ x: next.x, y: next.y });
    }
  }

  return deduplicatePolygon(out);
}

/**
 * Checks whether a finite cut segment [cutStart, cutEnd] actually crosses or lies inside a frame.
 */
export function doesCutSegmentCrossFrame(
  frame: ComicFrame,
  cutStart: Point2D,
  cutEnd: Point2D
): boolean {
  const poly = frame.polygon;
  if (poly.length < 3) return false;
  const cutDx = cutEnd.x - cutStart.x;
  const cutDy = cutEnd.y - cutStart.y;
  const cutLenSq = cutDx * cutDx + cutDy * cutDy;
  if (cutLenSq < 1e-6) return false;

  const hits: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const hit = intersectCutLineWithSegment(cutStart, cutEnd, poly[i], poly[(i + 1) % poly.length]);
    if (hit) {
      const tCut = ((hit.point.x - cutStart.x) * cutDx + (hit.point.y - cutStart.y) * cutDy) / cutLenSq;
      if (!hits.some((h) => Math.abs(h - tCut) < 1e-4)) {
        hits.push(tCut);
      }
    }
  }
  if (hits.length < 2) return false;
  hits.sort((a, b) => a - b);
  const minT = hits[0];
  const maxT = hits[hits.length - 1];
  // Segment [0, 1] overlaps interval [minT, maxT] on the cut line
  return maxT >= 0 && minT <= 1;
}

/**
 * Bisect a comic frame polygon along a cut line into two child polygon frames.
 * Uses exact Sutherland-Hodgman half-plane clipping with automatic manga gutter spacing.
 */
export function bisectComicFrame(
  frame: ComicFrame,
  cutStart: Point2D,
  cutEnd: Point2D,
  dpi = 600
): [ComicFrame, ComicFrame] | null {
  const poly = frame.polygon;
  if (poly.length < 3) return null;

  const cutDx = cutEnd.x - cutStart.x;
  const cutDy = cutEnd.y - cutStart.y;
  const cutLen = Math.hypot(cutDx, cutDy);
  if (cutLen < 1e-4) return null;

  // Verify the cut line genuinely intersects the polygon at >= 2 distinct points
  const distinctHits: Point2D[] = [];
  for (let i = 0; i < poly.length; i++) {
    const s1 = poly[i];
    const s2 = poly[(i + 1) % poly.length];
    const hit = intersectCutLineWithSegment(cutStart, cutEnd, s1, s2);
    if (hit) {
      const dup = distinctHits.some(
        (h) => Math.hypot(h.x - hit.point.x, h.y - hit.point.y) < 1e-3
      );
      if (!dup) distinctHits.push(hit.point);
    }
  }
  if (distinctHits.length < 2) return null;

  // Determine Gutter distance: vertical cut separates left/right frames by gutterVertical;
  // horizontal cut separates top/bottom frames by gutterHorizontal.
  const isMoreVertical = Math.abs(cutDy) >= Math.abs(cutDx);
  const rawGutter = isMoreVertical
    ? frame.gutterVertical ?? mmToPixels(MANGA_GUTTER_VERTICAL_MM, dpi)
    : frame.gutterHorizontal ?? mmToPixels(MANGA_GUTTER_HORIZONTAL_MM, dpi);

  const normal: Point2D = {
    x: -cutDy / cutLen,
    y: cutDx / cutLen,
  };

  // Clamp halfGutter so neither side collapses completely
  let minProj = Infinity;
  let maxProj = -Infinity;
  for (const p of poly) {
    const proj = (p.x - cutStart.x) * normal.x + (p.y - cutStart.y) * normal.y;
    if (proj < minProj) minProj = proj;
    if (proj > maxProj) maxProj = proj;
  }
  const availablePos = Math.max(0, maxProj);
  const availableNeg = Math.max(0, -minProj);
  const maxSafeHalfGutter = Math.max(0, Math.min(availablePos, availableNeg) - 2);
  const halfGutter = Math.min(Math.max(0, rawGutter * 0.5), maxSafeHalfGutter);

  const polyPos = clipPolygonHalfPlane(poly, cutStart, normal, halfGutter);
  const polyNeg = clipPolygonHalfPlane(
    poly,
    cutStart,
    { x: -normal.x, y: -normal.y },
    halfGutter
  );

  if (polyPos.length < 3 || polyNeg.length < 3) return null;
  if (polygonArea(polyPos) < 4 || polygonArea(polyNeg) < 4) return null;

  const stamp = Date.now();
  const suffix = Math.random().toString(36).substring(2, 6);

  const child1: ComicFrame = {
    id: `frame-${stamp}-${suffix}-1`,
    layerId: frame.layerId,
    polygon: polyPos,
    borderWidth: frame.borderWidth,
    gutterVertical: frame.gutterVertical,
    gutterHorizontal: frame.gutterHorizontal,
    clipChildren: frame.clipChildren,
    fillBackground: frame.fillBackground,
    fillColor: frame.fillColor,
    strokeColor: frame.strokeColor,
  };

  const child2: ComicFrame = {
    id: `frame-${stamp}-${suffix}-2`,
    layerId: frame.layerId,
    polygon: polyNeg,
    borderWidth: frame.borderWidth,
    gutterVertical: frame.gutterVertical,
    gutterHorizontal: frame.gutterHorizontal,
    clipChildren: frame.clipChildren,
    fillBackground: frame.fillBackground,
    fillColor: frame.fillColor,
    strokeColor: frame.strokeColor,
  };

  return [child1, child2];
}

export interface DivideFrameFolderResult {
  divided: boolean;
  mode: FrameDivideMode;
  /** Resulting frames when mode === 'same-folder' */
  frames: ComicFrame[];
  /** Resulting frame groups (2+ folders) when mode === 'split-folders' */
  folderGroups: ComicFrame[][];
}

/**
 * Splits intersected frame(s) in a frame folder along a user-drawn cut segment.
 * Supports:
 * - 'same-folder': replaces each crossed frame with its 2 bisected polygons inside the same folder.
 * - 'split-folders': partitions the bisected polygons into two independent folder groups.
 */
export function divideFramesInFolder(
  frames: ComicFrame[],
  cutStart: Point2D,
  cutEnd: Point2D,
  dpi = 600,
  mode: FrameDivideMode = 'same-folder'
): DivideFrameFolderResult {
  let divided = false;
  const sameFolderFrames: ComicFrame[] = [];
  const groupA: ComicFrame[] = [];
  const groupB: ComicFrame[] = [];

  for (const frame of frames) {
    if (doesCutSegmentCrossFrame(frame, cutStart, cutEnd)) {
      const split = bisectComicFrame(frame, cutStart, cutEnd, dpi);
      if (split) {
        divided = true;
        sameFolderFrames.push(split[0], split[1]);
        groupA.push(split[0]);
        groupB.push(split[1]);
        continue;
      }
    }
    sameFolderFrames.push(frame);
    // Assign uncrossed frames to side of cut line based on centroid
    const cx = frame.polygon.reduce((acc, p) => acc + p.x, 0) / Math.max(1, frame.polygon.length);
    const cy = frame.polygon.reduce((acc, p) => acc + p.y, 0) / Math.max(1, frame.polygon.length);
    const side =
      (cx - cutStart.x) * -(cutEnd.y - cutStart.y) +
      (cy - cutStart.y) * (cutEnd.x - cutStart.x);
    if (side >= 0) groupA.push(frame);
    else groupB.push(frame);
  }

  return {
    divided,
    mode,
    frames: sameFolderFrames,
    folderGroups: divided
      ? [groupA, groupB].filter((g) => g.length > 0)
      : [frames],
  };
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

    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
  const cross = (o: Point2D, u: Point2D, v: Point2D) =>
    (u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x);
  const d1 = cross(p, a, b);
  const d2 = cross(p, b, c);
  const d3 = cross(p, c, a);
  const hasNeg = d1 < -1e-6 || d2 < -1e-6 || d3 < -1e-6;
  const hasPos = d1 > 1e-6 || d2 > 1e-6 || d3 > 1e-6;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clipping triangulation of a simple 2D polygon into flat [x0, y0, x1, y1, x2, y2, ...] vertex array.
 */
export function triangulatePolygon(polygon: Point2D[]): Float32Array {
  const pts = deduplicatePolygon(polygon);
  if (pts.length < 3) return new Float32Array(0);
  if (pts.length === 3) {
    return new Float32Array([pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].x, pts[2].y]);
  }

  // Normalize winding to positive signed area (CW in Y-down screen coordinates)
  const indices = pts.map((_, i) => i);
  if (signedPolygonArea(pts) < 0) {
    indices.reverse();
  }

  const out: number[] = [];
  let guard = indices.length * indices.length;

  while (indices.length > 3 && guard-- > 0) {
    let earFound = false;
    for (let i = 0; i < indices.length; i++) {
      const iPrev = indices[(i - 1 + indices.length) % indices.length];
      const iCurr = indices[i];
      const iNext = indices[(i + 1) % indices.length];

      const a = pts[iPrev];
      const b = pts[iCurr];
      const c = pts[iNext];

      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross <= 1e-6) continue; // Reflex or collinear

      let containsAny = false;
      for (let j = 0; j < indices.length; j++) {
        const idx = indices[j];
        if (idx === iPrev || idx === iCurr || idx === iNext) continue;
        if (pointInTriangle(pts[idx], a, b, c)) {
          containsAny = true;
          break;
        }
      }

      if (!containsAny) {
        out.push(a.x, a.y, b.x, b.y, c.x, c.y);
        indices.splice(i, 1);
        earFound = true;
        break;
      }
    }
    if (!earFound) break;
  }

  if (indices.length === 3) {
    const a = pts[indices[0]];
    const b = pts[indices[1]];
    const c = pts[indices[2]];
    out.push(a.x, a.y, b.x, b.y, c.x, c.y);
  }

  return new Float32Array(out);
}

/**
 * Builds crisp mitered border stroke triangles in document space for GPU rendering on top of clipped contents.
 */
export function buildFrameBorderTriangles(
  polygon: Point2D[],
  borderWidth: number,
  miterLimit = 4
): Float32Array {
  const pts = deduplicatePolygon(polygon);
  if (pts.length < 3 || borderWidth <= 0) return new Float32Array(0);

  // Ensure consistent CW winding in Y-down space so outward normal is consistent
  const ordered = signedPolygonArea(pts) >= 0 ? pts : pts.slice().reverse();
  const n = ordered.length;
  const halfW = borderWidth * 0.5;

  const edgeNormals: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    const a = ordered[i];
    const b = ordered[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Outward normal for CW polygon in Y-down coordinates: (dy/len, -dx/len)
    edgeNormals.push({ x: dy / len, y: -dx / len });
  }

  const outerPts: Point2D[] = [];
  const innerPts: Point2D[] = [];

  for (let i = 0; i < n; i++) {
    const nPrev = edgeNormals[(i - 1 + n) % n];
    const nCurr = edgeNormals[i];
    let mx = nPrev.x + nCurr.x;
    let my = nPrev.y + nCurr.y;
    const mLen = Math.hypot(mx, my);
    let offsetX: number;
    let offsetY: number;

    if (mLen < 1e-4) {
      offsetX = nCurr.x * halfW;
      offsetY = nCurr.y * halfW;
    } else {
      mx /= mLen;
      my /= mLen;
      const dot = Math.max(1 / miterLimit, mx * nCurr.x + my * nCurr.y);
      const miterDist = halfW / dot;
      offsetX = mx * miterDist;
      offsetY = my * miterDist;
    }

    const p = ordered[i];
    outerPts.push({ x: p.x + offsetX, y: p.y + offsetY });
    innerPts.push({ x: p.x - offsetX, y: p.y - offsetY });
  }

  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const o0 = outerPts[i];
    const o1 = outerPts[next];
    const i0 = innerPts[i];
    const i1 = innerPts[next];
    out.push(o0.x, o0.y, o1.x, o1.y, i1.x, i1.y);
    out.push(o0.x, o0.y, i1.x, i1.y, i0.x, i0.y);
  }

  return new Float32Array(out);
}

/**
 * Apply polygon clipping path for a single frame to a Canvas 2D context.
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
 * Apply union polygon clipping path for all frames inside a frame-folder to a Canvas 2D context.
 */
export function applyMultiFrameClip(ctx: CanvasRenderingContext2D, frames: ComicFrame[]): boolean {
  const valid = frames.filter((f) => f.polygon.length >= 3);
  if (valid.length === 0) return false;

  ctx.beginPath();
  for (const frame of valid) {
    const poly = frame.polygon;
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i].x, poly[i].y);
    }
    ctx.closePath();
  }
  ctx.clip();
  return true;
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

  const shouldFill = fillBackground && frame.fillBackground !== false;
  const resolvedFill = frame.fillColor || fillColor;
  const resolvedStroke = frame.strokeColor || '#000000';

  ctx.save();

  if (shouldFill) {
    ctx.fillStyle = resolvedFill;
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) {
      ctx.lineTo(poly[i].x, poly[i].y);
    }
    ctx.closePath();
    ctx.fill();
  }

  // Draw crisp border stroke
  ctx.strokeStyle = resolvedStroke;
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
