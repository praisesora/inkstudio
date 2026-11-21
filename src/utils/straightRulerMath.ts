import { Point } from '../types/editor';
import { StraightRuler, Vector2D } from '../types/perspective';

export interface StraightRulerSnapResult {
  x: number;
  y: number;
  snapped: boolean;
}

/**
 * Normalizes an angle in degrees into (-180, 180].
 */
export function normalizeRulerAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let a = ((deg + 180) % 360 + 360) % 360 - 180;
  if (a <= -180) a += 360;
  if (Math.abs(a) < 1e-6) return 0;
  return Math.round(a * 10) / 10;
}

/**
 * Snaps an angle in degrees to the nearest increment (default 15°).
 */
export function snapAngleToStep(deg: number, stepDeg: number = 15): number {
  if (!Number.isFinite(deg) || stepDeg <= 0) return 0;
  return normalizeRulerAngle(Math.round(deg / stepDeg) * stepDeg);
}

/**
 * Creates a default horizontal straight ruler centered at `(centerX, centerY)`.
 */
export function createDefaultStraightRuler(centerX: number, centerY: number): StraightRuler {
  return {
    enabled: true,
    x: Number.isFinite(centerX) ? centerX : 500,
    y: Number.isFinite(centerY) ? centerY : 500,
    angle: 0,
    locked: false,
    snapEnabled: true,
  };
}

/**
 * Returns the unit direction vector along the straight ruler in Document Canvas Space.
 */
export function getStraightRulerDirection(angleDeg: number): Vector2D {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

/**
 * Projects a document-space point onto an infinite line defined by `(origin, unitDir)`.
 */
export function projectPointOntoLine(
  pt: Vector2D,
  origin: Vector2D,
  unitDir: Vector2D
): Vector2D {
  const vx = pt.x - origin.x;
  const vy = pt.y - origin.y;
  const t = vx * unitDir.x + vy * unitDir.y;
  return {
    x: origin.x + unitDir.x * t,
    y: origin.y + unitDir.y * t,
  };
}

/**
 * Real-time Straight Ruler stroke snapping session.
 * - If pointerdown lands within the ruler guide band (`edgeSnapPx / zoom` doc px),
 *   the stroke snaps directly onto the ruler centerline.
 * - Otherwise, the stroke snaps parallel to the ruler angle through the pointerdown point.
 * - Holding Alt (`isOverrideActive`) bypasses snapping cleanly.
 */
export class StraightRulerSnapSession {
  private activeOrigin: Vector2D | null = null;
  private activeDir: Vector2D | null = null;
  private readonly edgeSnapScreenPx = 26;

  public startStroke(
    startPoint: Vector2D,
    ruler: StraightRuler | null,
    zoom: number = 1.0,
    isOverrideActive: boolean = false
  ): StraightRulerSnapResult {
    this.activeOrigin = null;
    this.activeDir = null;

    if (!ruler || !ruler.enabled || !ruler.snapEnabled || isOverrideActive) {
      return { x: startPoint.x, y: startPoint.y, snapped: false };
    }

    const dir = getStraightRulerDirection(ruler.angle);
    const nx = -dir.y;
    const ny = dir.x;
    const dx = startPoint.x - ruler.x;
    const dy = startPoint.y - ruler.y;
    const perpDist = Math.abs(dx * nx + dy * ny);
    const snapRadiusDoc = this.edgeSnapScreenPx / Math.max(0.05, zoom);

    this.activeDir = dir;
    if (perpDist <= snapRadiusDoc) {
      // Snap directly onto the ruler's guide line
      this.activeOrigin = { x: ruler.x, y: ruler.y };
      const projected = projectPointOntoLine(startPoint, this.activeOrigin, dir);
      return { x: projected.x, y: projected.y, snapped: true };
    }

    // Snap parallel to the ruler passing through pointerdown
    this.activeOrigin = { x: startPoint.x, y: startPoint.y };
    return { x: startPoint.x, y: startPoint.y, snapped: true };
  }

  public processPoint(
    rawPoint: Vector2D,
    ruler: StraightRuler | null,
    isOverrideActive: boolean = false
  ): StraightRulerSnapResult {
    if (
      !this.activeOrigin ||
      !this.activeDir ||
      !ruler ||
      !ruler.enabled ||
      !ruler.snapEnabled ||
      isOverrideActive
    ) {
      return { x: rawPoint.x, y: rawPoint.y, snapped: false };
    }

    const projected = projectPointOntoLine(rawPoint, this.activeOrigin, this.activeDir);
    return { x: projected.x, y: projected.y, snapped: true };
  }

  public startStrokePoint(
    rawPoint: Point,
    ruler: StraightRuler | null,
    zoom: number = 1.0,
    isOverrideActive: boolean = false
  ): Point {
    const res = this.startStroke(rawPoint, ruler, zoom, isOverrideActive);
    if (!res.snapped) return rawPoint;
    return { ...rawPoint, x: res.x, y: res.y };
  }

  public isActive(): boolean {
    return this.activeOrigin !== null && this.activeDir !== null;
  }

  public endStroke(): void {
    this.activeOrigin = null;
    this.activeDir = null;
  }
}
