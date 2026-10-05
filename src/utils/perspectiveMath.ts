import {
  PerspectiveRuler,
  PerspectiveType,
  VanishingPoint,
  Vector2D,
  ConstraintAxis,
} from '../types/perspective';

export const EPSILON = 1e-6;

/**
 * 2D Vector Operations
 */
export function dot(a: Vector2D, b: Vector2D): number {
  return a.x * b.x + a.y * b.y;
}

export function length(v: Vector2D): number {
  return Math.hypot(v.x, v.y);
}

export function distance(a: Vector2D, b: Vector2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function normalize(v: Vector2D): Vector2D {
  const len = Math.hypot(v.x, v.y);
  if (len < EPSILON) {
    return { x: 0, y: 0 };
  }
  return { x: v.x / len, y: v.y / len };
}

/**
 * Projects point P onto an infinite ray/line defined by an origin and normalized direction.
 * P_snapped = Origin + dot(P - Origin, Ray_dir) * Ray_dir
 */
export function projectPointOntoRay(p: Vector2D, origin: Vector2D, dir: Vector2D): Vector2D {
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  const t = dx * dir.x + dy * dir.y;
  return {
    x: origin.x + t * dir.x,
    y: origin.y + t * dir.y,
  };
}

/**
 * Projects point P onto a line segment between p1 and p2.
 */
export function projectPointOntoLine(p: Vector2D, p1: Vector2D, p2: Vector2D): Vector2D {
  const lineDir = normalize({ x: p2.x - p1.x, y: p2.y - p1.y });
  return projectPointOntoRay(p, p1, lineDir);
}

/**
 * Calculates perpendicular distance from point P to an infinite ray/line.
 */
export function distanceToRay(p: Vector2D, origin: Vector2D, dir: Vector2D): number {
  const proj = projectPointOntoRay(p, origin, dir);
  return Math.hypot(p.x - proj.x, p.y - proj.y);
}

/**
 * Returns the dynamic Horizon Line (Eye Level) for a given perspective setup.
 * For 2-point and 3-point: defined strictly by the line passing through VP1 and VP2.
 * For 1-point: line passing through VP1 at the specified horizon angle.
 */
export function getHorizonLine(ruler: PerspectiveRuler): {
  p1: Vector2D;
  p2: Vector2D;
  dir: Vector2D;
  normal: Vector2D;
  angle: number;
} {
  const vps = ruler.vps;
  if ((ruler.type === '2-point' || ruler.type === '3-point') && vps.length >= 2) {
    const vp1 = vps[0];
    const vp2 = vps[1];
    const dir = normalize({ x: vp2.x - vp1.x, y: vp2.y - vp1.y });
    const normal = { x: -dir.y, y: dir.x };
    const angle = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
    return { p1: vp1, p2: vp2, dir, normal, angle };
  }

  // 1-Point setup
  const vp1 = vps[0] || { x: 0, y: 0 };
  const rad = (ruler.horizonAngle * Math.PI) / 180;
  const dir = { x: Math.cos(rad), y: Math.sin(rad) };
  const normal = { x: -dir.y, y: dir.x };
  return {
    p1: vp1,
    p2: { x: vp1.x + dir.x * 1000, y: vp1.y + dir.y * 1000 },
    dir,
    normal,
    angle: ruler.horizonAngle,
  };
}

/**
 * Returns all potential candidate constraint axes at a given stroke starting point P0.
 */
export function getAvailableConstraintAxes(p0: Vector2D, ruler: PerspectiveRuler): ConstraintAxis[] {
  const axes: ConstraintAxis[] = [];
  const horizon = getHorizonLine(ruler);

  if (ruler.type === '1-point') {
    const vp1 = ruler.vps[0];
    if (vp1) {
      const rayDir = normalize({ x: p0.x - vp1.x, y: p0.y - vp1.y });
      axes.push({
        type: 'vp1',
        label: 'VP1 Convergence Ray',
        origin: { x: vp1.x, y: vp1.y },
        dir: rayDir,
        color: vp1.color,
      });
    }

    // Horizontal axis parallel to horizon
    axes.push({
      type: 'horizontal',
      label: 'Horizontal Axis',
      origin: { x: p0.x, y: p0.y },
      dir: horizon.dir,
      color: '#38bdf8',
    });

    // Vertical axis perpendicular to horizon
    axes.push({
      type: 'vertical',
      label: 'Vertical Axis',
      origin: { x: p0.x, y: p0.y },
      dir: horizon.normal,
      color: '#4ade80',
    });
  } else if (ruler.type === '2-point') {
    const vp1 = ruler.vps[0];
    const vp2 = ruler.vps[1];

    if (vp1) {
      const rayDir1 = normalize({ x: p0.x - vp1.x, y: p0.y - vp1.y });
      axes.push({
        type: 'vp1',
        label: 'VP1 Convergence Ray',
        origin: { x: vp1.x, y: vp1.y },
        dir: rayDir1,
        color: vp1.color,
      });
    }

    if (vp2) {
      const rayDir2 = normalize({ x: p0.x - vp2.x, y: p0.y - vp2.y });
      axes.push({
        type: 'vp2',
        label: 'VP2 Convergence Ray',
        origin: { x: vp2.x, y: vp2.y },
        dir: rayDir2,
        color: vp2.color,
      });
    }

    // Vertical axis perpendicular to horizon
    axes.push({
      type: 'vertical',
      label: 'Vertical Axis',
      origin: { x: p0.x, y: p0.y },
      dir: horizon.normal,
      color: '#4ade80',
    });
  } else if (ruler.type === '3-point') {
    const [vp1, vp2, vp3] = ruler.vps;

    if (vp1) {
      const rayDir1 = normalize({ x: p0.x - vp1.x, y: p0.y - vp1.y });
      axes.push({
        type: 'vp1',
        label: 'VP1 Convergence Ray',
        origin: { x: vp1.x, y: vp1.y },
        dir: rayDir1,
        color: vp1.color,
      });
    }

    if (vp2) {
      const rayDir2 = normalize({ x: p0.x - vp2.x, y: p0.y - vp2.y });
      axes.push({
        type: 'vp2',
        label: 'VP2 Convergence Ray',
        origin: { x: vp2.x, y: vp2.y },
        dir: rayDir2,
        color: vp2.color,
      });
    }

    if (vp3) {
      const rayDir3 = normalize({ x: p0.x - vp3.x, y: p0.y - vp3.y });
      axes.push({
        type: 'vp3',
        label: 'VP3 Convergence Ray',
        origin: { x: vp3.x, y: vp3.y },
        dir: rayDir3,
        color: vp3.color,
      });
    }
  }

  return axes;
}

/**
 * Axis Locking on Stroke Start:
 * Evaluates the initial displacement vector over sampled points,
 * calculating angular alignment with each candidate axis.
 * Selects the axis with smallest angular difference min(|Δθ|), which corresponds
 * to the maximum absolute dot product |dot(V_dir, Axis_dir)|.
 */
export function findBestConstraintAxis(
  p0: Vector2D,
  currentP: Vector2D,
  ruler: PerspectiveRuler
): ConstraintAxis | null {
  const dx = currentP.x - p0.x;
  const dy = currentP.y - p0.y;
  const dist = Math.hypot(dx, dy);

  if (dist < EPSILON) {
    return null;
  }

  const vDir = { x: dx / dist, y: dy / dist };
  const candidates = getAvailableConstraintAxes(p0, ruler);

  let bestAxis: ConstraintAxis | null = null;
  let maxAlignment = -1;

  for (const axis of candidates) {
    // Bi-directional alignment: |cos(Δθ)|
    const alignment = Math.abs(dot(vDir, axis.dir));
    if (alignment > maxAlignment) {
      maxAlignment = alignment;
      bestAxis = axis;
    }
  }

  return bestAxis;
}

/**
 * Clips an infinite line passing through `origin` with direction `dir` to a rectangular bounding box.
 * Returns the two entry/exit intersection points, or null if line does not intersect.
 */
export function clipLineToRect(
  origin: Vector2D,
  dir: Vector2D,
  rect: { x: number; y: number; width: number; height: number }
): [Vector2D, Vector2D] | null {
  let tMin = -1e8;
  let tMax = 1e8;

  const minX = rect.x;
  const maxX = rect.x + rect.width;
  const minY = rect.y;
  const maxY = rect.y + rect.height;

  // X slab
  if (Math.abs(dir.x) < EPSILON) {
    if (origin.x < minX || origin.x > maxX) return null;
  } else {
    let t1 = (minX - origin.x) / dir.x;
    let t2 = (maxX - origin.x) / dir.x;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  // Y slab
  if (Math.abs(dir.y) < EPSILON) {
    if (origin.y < minY || origin.y > maxY) return null;
  } else {
    let t1 = (minY - origin.y) / dir.y;
    let t2 = (maxY - origin.y) / dir.y;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  return [
    { x: origin.x + tMin * dir.x, y: origin.y + tMin * dir.y },
    { x: origin.x + tMax * dir.x, y: origin.y + tMax * dir.y },
  ];
}

/**
 * Preset Perspective Setups
 */
export function createDefaultPerspectiveRuler(
  type: PerspectiveType,
  dimensions: { width: number; height: number }
): PerspectiveRuler {
  const w = dimensions.width || 2400;
  const h = dimensions.height || 3400;

  if (type === '1-point') {
    const vp1: VanishingPoint = {
      id: 'vp1',
      x: Math.round(w * 0.5),
      y: Math.round(h * 0.5),
      label: 'VP1',
      color: '#06b6d4', // Cyan
    };

    return {
      id: `ruler-1p-${Date.now()}`,
      type: '1-point',
      enabled: true,
      locked: false,
      snapEnabled: true,
      vps: [vp1],
      horizonAngle: 0,
      guideRayCount: 8,
      grid: {
        enabled: false,
        density: 16,
        plane: 'ground',
        opacity: 0.25,
      },
    };
  }

  if (type === '2-point') {
    // 2-Point: 2 VPs locked onto the horizon line far outside canvas bounds
    const eyeY = Math.round(h * 0.45);
    const vp1: VanishingPoint = {
      id: 'vp1',
      x: Math.round(-w * 0.8),
      y: eyeY,
      label: 'VP1 (Left)',
      color: '#06b6d4', // Cyan
    };
    const vp2: VanishingPoint = {
      id: 'vp2',
      x: Math.round(w * 1.8),
      y: eyeY,
      label: 'VP2 (Right)',
      color: '#a855f7', // Purple
    };

    return {
      id: `ruler-2p-${Date.now()}`,
      type: '2-point',
      enabled: true,
      locked: false,
      snapEnabled: true,
      vps: [vp1, vp2],
      horizonAngle: 0,
      guideRayCount: 8,
      grid: {
        enabled: false,
        density: 16,
        plane: 'ground',
        opacity: 0.25,
      },
    };
  }

  // 3-Point: 2 VPs on the horizon line + 1 vertical convergence VP (bird's-eye by default)
  const eyeY = Math.round(h * 0.35);
  const vp1: VanishingPoint = {
    id: 'vp1',
    x: Math.round(-w * 0.7),
    y: eyeY,
    label: 'VP1 (Left)',
    color: '#06b6d4', // Cyan
  };
  const vp2: VanishingPoint = {
    id: 'vp2',
    x: Math.round(w * 1.7),
    y: eyeY,
    label: 'VP2 (Right)',
    color: '#a855f7', // Purple
  };
  const vp3: VanishingPoint = {
    id: 'vp3',
    x: Math.round(w * 0.5),
    y: Math.round(h * 2.4), // Below canvas for high-angle bird's eye
    label: 'VP3 (Vertical)',
    color: '#f97316', // Orange
  };

  return {
    id: `ruler-3p-${Date.now()}`,
    type: '3-point',
    enabled: true,
    locked: false,
    snapEnabled: true,
    vps: [vp1, vp2, vp3],
    horizonAngle: 0,
    guideRayCount: 8,
    grid: {
      enabled: false,
      density: 16,
      plane: 'ground',
      opacity: 0.25,
    },
  };
}

/**
 * Quick preset for 3-point worm's-eye (looking up from ground level).
 */
export function applyWormsEyePreset(
  ruler: PerspectiveRuler,
  dimensions: { width: number; height: number }
): PerspectiveRuler {
  const w = dimensions.width;
  const h = dimensions.height;
  const eyeY = Math.round(h * 0.75);

  const newVps: VanishingPoint[] = [
    {
      id: 'vp1',
      x: Math.round(-w * 0.7),
      y: eyeY,
      label: 'VP1 (Left)',
      color: '#06b6d4',
    },
    {
      id: 'vp2',
      x: Math.round(w * 1.7),
      y: eyeY,
      label: 'VP2 (Right)',
      color: '#a855f7',
    },
    {
      id: 'vp3',
      x: Math.round(w * 0.5),
      y: Math.round(-h * 1.4), // Above canvas for worm's-eye convergence
      label: 'VP3 (Vertical)',
      color: '#f97316',
    },
  ];

  return {
    ...ruler,
    type: '3-point',
    vps: newVps,
  };
}

/**
 * Calculates real-time vanishing points from a Three.js PerspectiveCamera
 * in document canvas coordinates and returns an updated PerspectiveRuler.
 */
export function calculatePerspectiveFromCamera(
  camera: {
    matrixWorldInverse: { elements: ArrayLike<number> };
    projectionMatrix: { elements: ArrayLike<number> };
  },
  docWidth: number,
  docHeight: number,
  existingRuler?: PerspectiveRuler | null
): PerspectiveRuler {
  const V = camera.matrixWorldInverse.elements;
  const P = camera.projectionMatrix.elements;

  // Multiply M = P * V (column-major 4x4 matrix multiplication)
  const M = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += P[k * 4 + row] * V[col * 4 + k];
      }
      M[col * 4 + row] = sum;
    }
  }

  // Project a 3D world direction vector (dx, dy, dz, 0) to document screen space
  const projectDirection = (dx: number, dy: number, dz: number) => {
    const cx = M[0] * dx + M[4] * dy + M[8] * dz;
    const cy = M[1] * dx + M[5] * dy + M[9] * dz;
    const cw = M[3] * dx + M[7] * dy + M[11] * dz;

    if (Math.abs(cw) < 1e-4) {
      return null;
    }

    const ndcX = cx / cw;
    const ndcY = cy / cw;

    const docX = (ndcX + 1.0) * 0.5 * docWidth;
    const docY = (1.0 - ndcY) * 0.5 * docHeight;

    const MAX_COORD = 50000;
    return {
      x: Math.max(-MAX_COORD, Math.min(MAX_COORD, Math.round(docX))),
      y: Math.max(-MAX_COORD, Math.min(MAX_COORD, Math.round(docY))),
      cw,
    };
  };

  // VP1: World X direction (1, 0, 0)
  const p1 = projectDirection(1, 0, 0);
  // VP2: World Z direction (0, 0, 1)
  const p2 = projectDirection(0, 0, 1);
  // VP3: World Y direction (0, 1, 0)
  const p3 = projectDirection(0, 1, 0);

  const fallbackW = Math.max(1, docWidth);
  const fallbackH = Math.max(1, docHeight);

  const vp1: VanishingPoint = {
    id: 'vp1',
    x: p1 ? p1.x : -fallbackW * 0.8,
    y: p1 ? p1.y : fallbackH * 0.5,
    label: 'VP1 (X-Axis)',
    color: '#06b6d4',
  };

  const vp2: VanishingPoint = {
    id: 'vp2',
    x: p2 ? p2.x : fallbackW * 1.8,
    y: p2 ? p2.y : fallbackH * 0.5,
    label: 'VP2 (Z-Axis)',
    color: '#a855f7',
  };

  const is3Point = p3 !== null && Math.abs(p3.cw) > 0.02;
  const vps: VanishingPoint[] = [vp1, vp2];

  if (is3Point && p3) {
    const vp3: VanishingPoint = {
      id: 'vp3',
      x: p3.x,
      y: p3.y,
      label: 'VP3 (Y-Axis)',
      color: '#f97316',
    };
    vps.push(vp3);
  }

  const dx = vp2.x - vp1.x;
  const dy = vp2.y - vp1.y;
  const horizonAngle = (Math.atan2(dy, dx) * 180) / Math.PI;

  return {
    id: existingRuler?.id || `ruler-cam-sync-${Date.now()}`,
    type: is3Point ? '3-point' : '2-point',
    enabled: true,
    locked: existingRuler?.locked ?? false,
    snapEnabled: existingRuler?.snapEnabled ?? true,
    vps,
    horizonAngle,
    guideRayCount: existingRuler?.guideRayCount ?? 8,
    grid: existingRuler?.grid ?? {
      enabled: false,
      density: 16,
      plane: 'ground',
      opacity: 0.25,
    },
  };
}
