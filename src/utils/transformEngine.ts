import { Point2D } from '../types/editor';

/**
 * Computes the 3x3 projective transformation (homography) parameters
 * mapping unit square [0,1]^2 to quadrilateral (p0, p1, p2, p3).
 * Uses Heckbert's closed-form algorithm.
 */
export function solveUnitSquareToQuad(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D
): { a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number } {
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const sx = p0.x - p1.x + p2.x - p3.x;

  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sy = p0.y - p1.y + p2.y - p3.y;

  if (Math.abs(sx) < 1e-7 && Math.abs(sy) < 1e-7) {
    // Affine mapping
    return {
      a: p1.x - p0.x,
      b: p3.x - p0.x,
      c: p0.x,
      d: p1.y - p0.y,
      e: p3.y - p0.y,
      f: p0.y,
      g: 0,
      h: 0,
    };
  }

  const det = dx1 * dy2 - dy1 * dx2;
  const g = Math.abs(det) > 1e-7 ? (sx * dy2 - sy * dx2) / det : 0;
  const h = Math.abs(det) > 1e-7 ? (dx1 * sy - dy1 * sx) / det : 0;

  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
}

/**
 * Maps normalized coordinates (u, v) in [0, 1]^2 to target coordinates (x, y)
 * using solved homography.
 */
export function evaluateHomography(
  h: { a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number },
  u: number,
  v: number
): Point2D {
  const denom = h.g * u + h.h * v + 1;
  const safeDenom = Math.abs(denom) < 1e-5 ? (denom < 0 ? -1e-5 : 1e-5) : denom;
  return {
    x: (h.a * u + h.b * v + h.c) / safeDenom,
    y: (h.d * u + h.e * v + h.f) / safeDenom,
  };
}

/**
 * 1D Catmull-Rom spline evaluation passing through p1 and p2.
 */
function catmullRom1D(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/**
 * Evaluates 2D Catmull-Rom surface point at normalized parameter (u, v) in [0, 1]^2.
 */
export function evaluateMeshSurface(
  meshPoints: Point2D[][],
  u: number,
  v: number
): Point2D {
  const rows = meshPoints.length;
  const cols = meshPoints[0]?.length || 0;
  if (rows < 2 || cols < 2) return { x: 0, y: 0 };

  const clampedU = Math.max(0, Math.min(1, u));
  const clampedV = Math.max(0, Math.min(1, v));

  const scaledU = clampedU * (cols - 1);
  const colIdx = Math.min(Math.floor(scaledU), cols - 2);
  const t = scaledU - colIdx;

  const scaledV = clampedV * (rows - 1);
  const rowIdx = Math.min(Math.floor(scaledV), rows - 2);
  const s = scaledV - rowIdx;

  // Helper to safely get point with border clamping
  const getP = (r: number, c: number): Point2D => {
    const cr = Math.max(0, Math.min(rows - 1, r));
    const cc = Math.max(0, Math.min(cols - 1, c));
    return meshPoints[cr][cc];
  };

  // Interpolate 4 row spans across u
  const rowPoints: Point2D[] = [];
  for (let r = rowIdx - 1; r <= rowIdx + 2; r++) {
    const p0 = getP(r, colIdx - 1);
    const p1 = getP(r, colIdx);
    const p2 = getP(r, colIdx + 1);
    const p3 = getP(r, colIdx + 2);

    rowPoints.push({
      x: catmullRom1D(p0.x, p1.x, p2.x, p3.x, t),
      y: catmullRom1D(p0.y, p1.y, p2.y, p3.y, t),
    });
  }

  // Interpolate across v
  return {
    x: catmullRom1D(rowPoints[0].x, rowPoints[1].x, rowPoints[2].x, rowPoints[3].x, s),
    y: catmullRom1D(rowPoints[0].y, rowPoints[1].y, rowPoints[2].y, rowPoints[3].y, s),
  };
}

/**
 * Renders an affine-mapped triangle from sourceCanvas onto destination context.
 */
export function drawAffineTriangle(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  sx0: number, sy0: number,
  sx1: number, sy1: number,
  sx2: number, sy2: number,
  dx0: number, dy0: number,
  dx1: number, dy1: number,
  dx2: number, dy2: number
): void {
  const du1 = sx1 - sx0;
  const du2 = sx2 - sx0;
  const dv1 = sy1 - sy0;
  const dv2 = sy2 - sy0;
  const det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-6) return;

  const dx1_0 = dx1 - dx0;
  const dx2_0 = dx2 - dx0;
  const dy1_0 = dy1 - dy0;
  const dy2_0 = dy2 - dy0;

  const a = (dx1_0 * dv2 - dx2_0 * dv1) / det;
  const c = (du1 * dx2_0 - du2 * dx1_0) / det;
  const e = dx0 - a * sx0 - c * sy0;

  const b = (dy1_0 * dv2 - dy2_0 * dv1) / det;
  const d = (du1 * dy2_0 - du2 * dy1_0) / det;
  const f = dy0 - b * sx0 - d * sy0;

  ctx.save();
  ctx.beginPath();
  // Expand triangle slightly towards centroid to avoid subpixel seam artifacts
  const cx = (dx0 + dx1 + dx2) / 3;
  const cy = (dy0 + dy1 + dy2) / 3;
  const expand = 0.5;

  const ex0 = dx0 + Math.sign(dx0 - cx) * expand;
  const ey0 = dy0 + Math.sign(dy0 - cy) * expand;
  const ex1 = dx1 + Math.sign(dx1 - cx) * expand;
  const ey1 = dy1 + Math.sign(dy1 - cy) * expand;
  const ex2 = dx2 + Math.sign(dx2 - cx) * expand;
  const ey2 = dy2 + Math.sign(dy2 - cy) * expand;

  ctx.moveTo(ex0, ey0);
  ctx.lineTo(ex1, ey1);
  ctx.lineTo(ex2, ey2);
  ctx.closePath();
  ctx.clip();

  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.restore();
}

/**
 * Renders sourceCanvas deformed into a Perspective Quad using homography triangle slicing.
 */
export function renderPerspectiveQuad(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  quad: [Point2D, Point2D, Point2D, Point2D],
  subdivisions = 16
): void {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  if (sw <= 0 || sh <= 0) return;

  const homography = solveUnitSquareToQuad(quad[0], quad[1], quad[2], quad[3]);

  // Precompute grid vertices
  const grid: Point2D[][] = [];
  for (let j = 0; j <= subdivisions; j++) {
    const row: Point2D[] = [];
    const v = j / subdivisions;
    for (let i = 0; i <= subdivisions; i++) {
      const u = i / subdivisions;
      row.push(evaluateHomography(homography, u, v));
    }
    grid.push(row);
  }

  // Draw two triangles for each quad cell
  for (let j = 0; j < subdivisions; j++) {
    const v0 = (j / subdivisions) * sh;
    const v1 = ((j + 1) / subdivisions) * sh;
    for (let i = 0; i < subdivisions; i++) {
      const u0 = (i / subdivisions) * sw;
      const u1 = ((i + 1) / subdivisions) * sw;

      const p00 = grid[j][i];
      const p10 = grid[j][i + 1];
      const p11 = grid[j + 1][i + 1];
      const p01 = grid[j + 1][i];

      // Triangle 1: (0,0) - (1,0) - (0,1)
      drawAffineTriangle(
        ctx, sourceCanvas,
        u0, v0, u1, v0, u0, v1,
        p00.x, p00.y, p10.x, p10.y, p01.x, p01.y
      );

      // Triangle 2: (1,0) - (1,1) - (0,1)
      drawAffineTriangle(
        ctx, sourceCanvas,
        u1, v0, u1, v1, u0, v1,
        p10.x, p10.y, p11.x, p11.y, p01.x, p01.y
      );
    }
  }
}

/**
 * Renders sourceCanvas deformed via 2D Catmull-Rom Bicubic Mesh Lattice.
 */
export function renderMeshWarp(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  meshPoints: Point2D[][],
  subPerCell = 4
): void {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  if (sw <= 0 || sh <= 0) return;

  const rows = meshPoints.length;
  const cols = meshPoints[0]?.length || 0;
  if (rows < 2 || cols < 2) return;

  const totalCols = (cols - 1) * subPerCell;
  const totalRows = (rows - 1) * subPerCell;

  // Precompute evaluated surface vertices
  const grid: Point2D[][] = [];
  for (let j = 0; j <= totalRows; j++) {
    const row: Point2D[] = [];
    const v = j / totalRows;
    for (let i = 0; i <= totalCols; i++) {
      const u = i / totalCols;
      row.push(evaluateMeshSurface(meshPoints, u, v));
    }
    grid.push(row);
  }

  // Draw triangles for each sub-cell
  for (let j = 0; j < totalRows; j++) {
    const v0 = (j / totalRows) * sh;
    const v1 = ((j + 1) / totalRows) * sh;
    for (let i = 0; i < totalCols; i++) {
      const u0 = (i / totalCols) * sw;
      const u1 = ((i + 1) / totalCols) * sw;

      const p00 = grid[j][i];
      const p10 = grid[j][i + 1];
      const p11 = grid[j + 1][i + 1];
      const p01 = grid[j + 1][i];

      // Triangle 1: (0,0) - (1,0) - (0,1)
      drawAffineTriangle(
        ctx, sourceCanvas,
        u0, v0, u1, v0, u0, v1,
        p00.x, p00.y, p10.x, p10.y, p01.x, p01.y
      );

      // Triangle 2: (1,0) - (1,1) - (0,1)
      drawAffineTriangle(
        ctx, sourceCanvas,
        u1, v0, u1, v1, u0, v1,
        p10.x, p10.y, p11.x, p11.y, p01.x, p01.y
      );
    }
  }
}

/**
 * Creates default 4 perspective corner pins from bounds.
 * Order: [TL, TR, BR, BL]
 */
export function createDefaultPerspectiveQuad(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation = 0
): [Point2D, Point2D, Point2D, Point2D] {
  if (rotation === 0) {
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
  }

  const cx = x + width / 2;
  const cy = y + height / 2;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const rotate = (px: number, py: number): Point2D => {
    const rx = px - cx;
    const ry = py - cy;
    return {
      x: Math.round(cx + rx * cos - ry * sin),
      y: Math.round(cy + rx * sin + ry * cos),
    };
  };

  return [
    rotate(x, y),
    rotate(x + width, y),
    rotate(x + width, y + height),
    rotate(x, y + height),
  ];
}

/**
 * Creates a default grid of (rows x cols) control points interpolated from 4 corners.
 */
export function createDefaultMeshPoints(
  quad: [Point2D, Point2D, Point2D, Point2D],
  cols = 4,
  rows = 4
): Point2D[][] {
  const [q0, q1, q2, q3] = quad;
  const points: Point2D[][] = [];

  for (let r = 0; r < rows; r++) {
    const v = rows > 1 ? r / (rows - 1) : 0;
    const row: Point2D[] = [];
    for (let c = 0; c < cols; c++) {
      const u = cols > 1 ? c / (cols - 1) : 0;
      // Bilinear interpolation across corners
      const x = (1 - u) * (1 - v) * q0.x + u * (1 - v) * q1.x + u * v * q2.x + (1 - u) * v * q3.x;
      const y = (1 - u) * (1 - v) * q0.y + u * (1 - v) * q1.y + u * v * q2.y + (1 - u) * v * q3.y;
      row.push({ x: Math.round(x), y: Math.round(y) });
    }
    points.push(row);
  }

  return points;
}

/**
 * Calculates tight bounding box of a perspective quad or mesh point set.
 */
export function getPointsBounds(points: Point2D[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  return {
    minX: Math.floor(minX),
    minY: Math.floor(minY),
    maxX: Math.ceil(maxX),
    maxY: Math.ceil(maxY),
    width: Math.max(1, Math.ceil(maxX - minX)),
    height: Math.max(1, Math.ceil(maxY - minY)),
  };
}
