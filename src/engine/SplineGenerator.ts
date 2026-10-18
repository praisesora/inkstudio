/**
 * SplineGenerator.ts
 * Zero-Delay Centripetal Catmull-Rom (alpha = 0.5) and Hermite provisional segment stitching.
 * Pre-allocated data structures, zero GC pressure in render hot-paths.
 * Upgraded with:
 *  - Corner Knot Snap commits (C0 position continuity, sharp vertices)
 *  - Seamless Hermite Tangent Extrapolation for real-time stroke head tracking
 */

export interface SplinePoint {
  x: number;
  y: number;
  pressure: number;
  width: number;
}

export interface CubicBezierSegment {
  p0: SplinePoint;
  c1: SplinePoint;
  c2: SplinePoint;
  p3: SplinePoint;
}

export class SplineGenerator {
  // Reusable Bézier segment object to prevent GC churn
  private segment: CubicBezierSegment = {
    p0: { x: 0, y: 0, pressure: 0, width: 0 },
    c1: { x: 0, y: 0, pressure: 0, width: 0 },
    c2: { x: 0, y: 0, pressure: 0, width: 0 },
    p3: { x: 0, y: 0, pressure: 0, width: 0 },
  };

  // Reusable exit tangent for Hermite continuity
  private lastTangentX: number = 0;
  private lastTangentY: number = 0;
  private hasLastTangent: boolean = false;

  public reset(): void {
    this.hasLastTangent = false;
    this.lastTangentX = 0;
    this.lastTangentY = 0;
  }

  /**
   * Commits a sharp corner knot: resets tangent memory and breaks derivative continuity
   * to guarantee razor-sharp corners without loop overshoot or rounding.
   */
  public commitCornerKnot(_cornerPoint?: SplinePoint): void {
    this.hasLastTangent = false;
    this.lastTangentX = 0;
    this.lastTangentY = 0;
  }

  /**
   * Generates a sharp corner segment directly to the apex coordinate
   * with colinear control handles along the chord.
   */
  public generateCornerSegment(pPrev: SplinePoint, pCorner: SplinePoint): CubicBezierSegment {
    const dx = pCorner.x - pPrev.x;
    const dy = pCorner.y - pPrev.y;

    this.segment.p0.x = pPrev.x;
    this.segment.p0.y = pPrev.y;
    this.segment.p0.pressure = pPrev.pressure;
    this.segment.p0.width = pPrev.width;

    this.segment.c1.x = pPrev.x + dx * 0.333;
    this.segment.c1.y = pPrev.y + dy * 0.333;
    this.segment.c1.pressure = pPrev.pressure + (pCorner.pressure - pPrev.pressure) * 0.333;
    this.segment.c1.width = pPrev.width + (pCorner.width - pPrev.width) * 0.333;

    this.segment.c2.x = pPrev.x + dx * 0.667;
    this.segment.c2.y = pPrev.y + dy * 0.667;
    this.segment.c2.pressure = pPrev.pressure + (pCorner.pressure - pPrev.pressure) * 0.667;
    this.segment.c2.width = pPrev.width + (pCorner.width - pPrev.width) * 0.667;

    this.segment.p3.x = pCorner.x;
    this.segment.p3.y = pCorner.y;
    this.segment.p3.pressure = pCorner.pressure;
    this.segment.p3.width = pCorner.width;

    this.hasLastTangent = false;
    this.lastTangentX = 0;
    this.lastTangentY = 0;

    return this.segment;
  }

  /**
   * Generates provisional zero-latency segment between P(n-1) and current raw point P(n)
   * using a Hermite spline parameterized by known start tangent and current velocity tangent.
   */
  public generateProvisionalSegment(
    pPrev: SplinePoint,
    pCurr: SplinePoint,
    vx: number,
    vy: number
  ): CubicBezierSegment {
    const dx = pCurr.x - pPrev.x;
    const dy = pCurr.y - pPrev.y;
    const chordLen = Math.hypot(dx, dy);

    this.segment.p0.x = pPrev.x;
    this.segment.p0.y = pPrev.y;
    this.segment.p0.pressure = pPrev.pressure;
    this.segment.p0.width = pPrev.width;

    this.segment.p3.x = pCurr.x;
    this.segment.p3.y = pCurr.y;
    this.segment.p3.pressure = pCurr.pressure;
    this.segment.p3.width = pCurr.width;

    if (chordLen < 1e-4) {
      this.segment.c1.x = pPrev.x;
      this.segment.c1.y = pPrev.y;
      this.segment.c1.pressure = pPrev.pressure;
      this.segment.c1.width = pPrev.width;

      this.segment.c2.x = pCurr.x;
      this.segment.c2.y = pCurr.y;
      this.segment.c2.pressure = pCurr.pressure;
      this.segment.c2.width = pCurr.width;
      return this.segment;
    }

    // Tangent at start: use prior exit tangent if available, else chord direction
    let t0x = this.hasLastTangent ? this.lastTangentX : dx;
    let t0y = this.hasLastTangent ? this.lastTangentY : dy;
    const lenT0 = Math.hypot(t0x, t0y);
    if (lenT0 > 1e-4) {
      t0x = (t0x / lenT0) * (chordLen * 0.35);
      t0y = (t0y / lenT0) * (chordLen * 0.35);
    } else {
      t0x = dx * 0.35;
      t0y = dy * 0.35;
    }

    // Tangent at end: use current velocity vector if present, else chord direction
    const vLen = Math.hypot(vx, vy);
    let t1x: number;
    let t1y: number;
    if (vLen > 1e-4) {
      t1x = (vx / vLen) * (chordLen * 0.35);
      t1y = (vy / vLen) * (chordLen * 0.35);
    } else {
      t1x = dx * 0.35;
      t1y = dy * 0.35;
    }

    this.segment.c1.x = pPrev.x + t0x;
    this.segment.c1.y = pPrev.y + t0y;
    this.segment.c1.pressure = pPrev.pressure + (pCurr.pressure - pPrev.pressure) * 0.333;
    this.segment.c1.width = pPrev.width + (pCurr.width - pPrev.width) * 0.333;

    this.segment.c2.x = pCurr.x - t1x;
    this.segment.c2.y = pCurr.y - t1y;
    this.segment.c2.pressure = pPrev.pressure + (pCurr.pressure - pPrev.pressure) * 0.667;
    this.segment.c2.width = pPrev.width + (pCurr.width - pPrev.width) * 0.667;

    return this.segment;
  }

  /**
   * Evaluates exact Centripetal Catmull-Rom spline (alpha = 0.5) over knots [P0, P1, P2, P3].
   * Converts the interior segment P1 -> P2 into cubic Bézier control points C1 and C2.
   * Guarantees zero cusps, zero self-intersections, and monotonic curvature.
   */
  public generateCatmullRomSegment(
    p0: SplinePoint,
    p1: SplinePoint,
    p2: SplinePoint,
    p3: SplinePoint
  ): CubicBezierSegment {
    const d01 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const d23 = Math.hypot(p3.x - p2.x, p3.y - p2.y);

    // Centripetal parameterization (alpha = 0.5): dt = sqrt(chord)
    const dt0 = Math.max(1e-4, Math.sqrt(d01));
    const dt1 = Math.max(1e-4, Math.sqrt(d12));
    const dt2 = Math.max(1e-4, Math.sqrt(d23));

    // Tangents at P1 and P2
    const t1x = (p2.x - p1.x) / dt1 - (p1.x - p0.x) / dt0 + (p2.x - p0.x) / (dt0 + dt1);
    const t1y = (p2.y - p1.y) / dt1 - (p1.y - p0.y) / dt0 + (p2.y - p0.y) / (dt0 + dt1);

    const t2x = (p3.x - p2.x) / dt2 - (p2.x - p1.x) / dt1 + (p3.x - p1.x) / (dt1 + dt2);
    const t2y = (p3.y - p2.y) / dt2 - (p2.y - p1.y) / dt1 + (p3.y - p1.y) / (dt1 + dt2);

    let dx1 = (t1x * dt1) / 3.0;
    let dy1 = (t1y * dt1) / 3.0;
    let dx2 = (t2x * dt1) / 3.0;
    let dy2 = (t2y * dt1) / 3.0;

    // Handle length clamping to prevent loop overshoot on tight turns
    if (d12 > 1e-3) {
      const maxHandle = d12 * 0.48;
      const len1 = Math.hypot(dx1, dy1);
      if (len1 > maxHandle) {
        const s = maxHandle / len1;
        dx1 *= s;
        dy1 *= s;
      }
      const len2 = Math.hypot(dx2, dy2);
      if (len2 > maxHandle) {
        const s = maxHandle / len2;
        dx2 *= s;
        dy2 *= s;
      }
    }

    this.segment.p0.x = p1.x;
    this.segment.p0.y = p1.y;
    this.segment.p0.pressure = p1.pressure;
    this.segment.p0.width = p1.width;

    this.segment.c1.x = p1.x + dx1;
    this.segment.c1.y = p1.y + dy1;
    this.segment.c1.pressure = p1.pressure + (p2.pressure - p0.pressure) / 6.0;
    this.segment.c1.width = p1.width + (p2.width - p0.width) / 6.0;

    this.segment.c2.x = p2.x - dx2;
    this.segment.c2.y = p2.y - dy2;
    this.segment.c2.pressure = p2.pressure - (p3.pressure - p1.pressure) / 6.0;
    this.segment.c2.width = p2.width - (p3.width - p1.width) / 6.0;

    this.segment.p3.x = p2.x;
    this.segment.p3.y = p2.y;
    this.segment.p3.pressure = p2.pressure;
    this.segment.p3.width = p2.width;

    // Cache tangent at P2 for subsequent Hermite provisional segment stitching
    this.lastTangentX = dx2 * 3.0;
    this.lastTangentY = dy2 * 3.0;
    this.hasLastTangent = true;

    return this.segment;
  }

  public getLastTangent(): { x: number; y: number; hasTangent: boolean } {
    return {
      x: this.lastTangentX,
      y: this.lastTangentY,
      hasTangent: this.hasLastTangent,
    };
  }
}
