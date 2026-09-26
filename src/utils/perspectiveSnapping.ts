import { Point } from '../types/editor';
import { PerspectiveRuler, ConstraintAxis, Vector2D } from '../types/perspective';
import { findBestConstraintAxis, projectPointOntoRay } from './perspectiveMath';

export interface SnappedPointResult {
  x: number;
  y: number;
  snapped: boolean;
  axis: ConstraintAxis | null;
}

/**
 * Production-Grade Stroke Snapping Engine (Clip Studio Paint Style)
 * Intercepts freehand stylus/mouse pointer coordinates in Document Canvas Space,
 * locks onto the perspective axis with minimum angular difference on stroke start,
 * and projects subsequent points strictly onto the constraint line in real-time.
 */
export class PerspectiveSnapSession {
  private startPoint: Vector2D | null = null;
  private lockedAxis: ConstraintAxis | null = null;
  private isAxisLocked: boolean = false;
  // Threshold in document pixels before locking axis (prevents microscopic stylus jitters from misclassifying)
  private lockDistanceThreshold: number = 4.0;

  /**
   * Called on pointerdown to initialize stroke snapping session.
   */
  public startStroke(
    startPoint: Vector2D,
    ruler: PerspectiveRuler | null,
    isOverrideActive: boolean = false
  ): SnappedPointResult {
    this.startPoint = { x: startPoint.x, y: startPoint.y };
    this.lockedAxis = null;
    this.isAxisLocked = false;

    if (!ruler || !ruler.enabled || !ruler.snapEnabled || isOverrideActive) {
      return {
        x: startPoint.x,
        y: startPoint.y,
        snapped: false,
        axis: null,
      };
    }

    return {
      x: startPoint.x,
      y: startPoint.y,
      snapped: false,
      axis: null,
    };
  }

  /**
   * Called on pointermove (for both native and coalesced pointer events).
   * Projects raw pointer coordinates onto the locked perspective ray.
   */
  public processPoint(
    rawPoint: Vector2D,
    ruler: PerspectiveRuler | null,
    isOverrideActive: boolean = false
  ): SnappedPointResult {
    // If ruler is missing, disabled, snapping is off, or modifier override is pressed
    if (!ruler || !ruler.enabled || !ruler.snapEnabled || isOverrideActive || !this.startPoint) {
      return {
        x: rawPoint.x,
        y: rawPoint.y,
        snapped: false,
        axis: null,
      };
    }

    // Determine axis lock if not already locked
    if (!this.isAxisLocked) {
      const dx = rawPoint.x - this.startPoint.x;
      const dy = rawPoint.y - this.startPoint.y;
      const dist = Math.hypot(dx, dy);

      if (dist >= this.lockDistanceThreshold) {
        const bestAxis = findBestConstraintAxis(this.startPoint, rawPoint, ruler);
        if (bestAxis) {
          this.lockedAxis = bestAxis;
          this.isAxisLocked = true;
        }
      }
    }

    // If an axis is locked, project coordinate strictly onto the constraint ray
    if (this.isAxisLocked && this.lockedAxis) {
      const snapped = projectPointOntoRay(rawPoint, this.lockedAxis.origin, this.lockedAxis.dir);
      return {
        x: snapped.x,
        y: snapped.y,
        snapped: true,
        axis: this.lockedAxis,
      };
    }

    // Still within jitter deadzone before lock
    return {
      x: rawPoint.x,
      y: rawPoint.y,
      snapped: false,
      axis: null,
    };
  }

  /**
   * Called on pointerup / pointercancel to release stroke lock.
   */
  public endStroke(): void {
    this.startPoint = null;
    this.lockedAxis = null;
    this.isAxisLocked = false;
  }

  /**
   * Returns current locked constraint axis (used by overlay to render the active snap ray).
   */
  public getActiveAxis(): ConstraintAxis | null {
    return this.lockedAxis;
  }

  /**
   * Helper function: directly snaps an existing Point object maintaining tablet dynamics unchanged.
   */
  public snapPoint(
    rawPoint: Point,
    ruler: PerspectiveRuler | null,
    isOverrideActive: boolean = false
  ): Point {
    const res = this.processPoint(rawPoint, ruler, isOverrideActive);
    if (!res.snapped) {
      return rawPoint;
    }
    return {
      ...rawPoint,
      x: res.x,
      y: res.y,
    };
  }
}

/**
 * Functional stateless helper for snapping a single coordinate given a known constraint axis.
 */
export function snapCoordinateToAxis(
  raw: Vector2D,
  axis: ConstraintAxis
): Vector2D {
  return projectPointOntoRay(raw, axis.origin, axis.dir);
}
