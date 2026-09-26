export type PerspectiveType = '1-point' | '2-point' | '3-point';

export interface Vector2D {
  x: number;
  y: number;
}

export interface VanishingPoint {
  id: 'vp1' | 'vp2' | 'vp3';
  x: number; // In Document Canvas Space (can be far outside canvas boundaries)
  y: number;
  label: string;
  color: string;
}

export interface PerspectiveGridSettings {
  enabled: boolean;
  density: number; // Number of grid divisions (e.g. 10 to 30)
  plane: 'ground' | 'wall-left' | 'wall-right' | 'all';
  opacity: number; // 0.0 to 1.0
}

export interface PerspectiveRuler {
  id: string;
  type: PerspectiveType;
  enabled: boolean;          // Ruler visibility and snapping active
  locked: boolean;           // Frozen handles (unclickable during drawing to avoid misclicks)
  snapEnabled: boolean;      // Real-time stroke snapping active
  vps: VanishingPoint[];     // 1, 2, or 3 vanishing points in Document Canvas Space
  horizonAngle: number;      // Degrees, eye-level angle for 1-point perspective
  guideRayCount: number;     // Number of guide rays converging to each VP
  grid: PerspectiveGridSettings;
}

export type ConstraintAxisType =
  | 'vp1'
  | 'vp2'
  | 'vp3'
  | 'horizontal'
  | 'vertical';

export interface ConstraintAxis {
  type: ConstraintAxisType;
  label: string;
  origin: Vector2D; // Pivot point on the constraint line (Document Space)
  dir: Vector2D;    // Normalized direction vector (Document Space)
  color?: string;
}
