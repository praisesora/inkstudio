/**
 * Manga Effect Lines Generator Engine
 *
 * Implements Clip Studio Paint EX-grade parametric manga action effects:
 * - Saturated Lines (Focus / Burst / Shonen Impact lines): Radiating toward a center target
 *   with configurable center cutout radius, density, spacing jitter, and needle taper.
 * - Stream Lines (Directional Speed / Motion lines): Directional parallel speed lines
 *   with angle, length, density, thickness noise, and tapered tails.
 */

export interface SaturatedLinesOptions {
  centerX: number;
  centerY: number;
  innerRadius: number; // Cutout radius around center target (e.g. face / action point)
  outerRadius?: number; // Outer boundary radius
  density: number; // Number of radiating lines (30 - 600)
  spacingJitter: number; // Angular jitter (0.0 to 1.0)
  lengthJitter: number; // Variation in starting & ending depth (0.0 to 1.0)
  lineWidth: number; // Outer stroke thickness (1 to 15)
  taper?: 'in' | 'out' | 'none'; // 'in' = thick at border, sharp needle tip towards center
  color: string;
}

export interface StreamLinesOptions {
  angle: number; // In degrees (0° to 360°)
  density: number; // Number of parallel speed streaks (10 to 400)
  lineLength: number; // Mean streak length (50 to 1500)
  lengthNoise: number; // Length jitter ratio (0.0 to 1.0)
  thickness: number; // Mean stroke thickness (1 to 12)
  thicknessNoise: number; // Thickness variation (0.0 to 1.0)
  gapNoise: number; // Spacing jitter along perpendicular axis (0.0 to 1.0)
  color: string;
}

// Pseudo-random number generator for reproducible procedural effects
function pseudoRandom(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Renders Saturated / Focus / Burst lines radiating towards a center focal point.
 */
export function renderSaturatedLines(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  options: SaturatedLinesOptions
): void {
  const {
    centerX,
    centerY,
    innerRadius,
    density = 120,
    spacingJitter = 0.5,
    lengthJitter = 0.3,
    lineWidth = 4,
    taper = 'in',
    color = '#000000',
  } = options;

  const maxCanvasRadius = Math.hypot(
    Math.max(centerX, canvasWidth - centerX),
    Math.max(centerY, canvasHeight - centerY)
  ) * 1.2;

  const outerRadius = options.outerRadius || maxCanvasRadius;
  const count = Math.max(8, Math.min(1000, density));
  const rng = pseudoRandom(1337 + count);

  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;

  const baseAngleStep = (Math.PI * 2) / count;

  for (let i = 0; i < count; i++) {
    // Angular spacing with jitter
    const jitter = (rng() - 0.5) * spacingJitter * baseAngleStep * 1.5;
    const angle = i * baseAngleStep + jitter;

    // Radius start and end with jitter
    const inJitter = (rng() - 0.5) * lengthJitter * innerRadius * 0.5;
    const rStart = Math.max(2, innerRadius + inJitter);

    const outJitter = (rng() - 0.5) * lengthJitter * 60;
    const rEnd = outerRadius + outJitter;

    if (rStart >= rEnd) continue;

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    // Perpendicular unit vector
    const perpX = -sinA;
    const perpY = cosA;

    // Line taper calculation
    const wOuter = (lineWidth * (0.6 + rng() * 0.8));
    const wInner = taper === 'in' ? 0.2 : (taper === 'none' ? wOuter : 0.2);
    const effectiveWOuter = taper === 'out' ? 0.2 : wOuter;

    // Coordinates of outer corners and inner corners (drawn as tapered polygon)
    const xOuter1 = centerX + cosA * rEnd - perpX * (effectiveWOuter * 0.5);
    const yOuter1 = centerY + sinA * rEnd - perpY * (effectiveWOuter * 0.5);
    const xOuter2 = centerX + cosA * rEnd + perpX * (effectiveWOuter * 0.5);
    const yOuter2 = centerY + sinA * rEnd + perpY * (effectiveWOuter * 0.5);

    const xInner1 = centerX + cosA * rStart + perpX * (wInner * 0.5);
    const yInner1 = centerY + sinA * rStart + perpY * (wInner * 0.5);
    const xInner2 = centerX + cosA * rStart - perpX * (wInner * 0.5);
    const yInner2 = centerY + sinA * rStart - perpY * (wInner * 0.5);

    ctx.beginPath();
    ctx.moveTo(xOuter1, yOuter1);
    ctx.lineTo(xOuter2, yOuter2);
    ctx.lineTo(xInner1, yInner1);
    ctx.lineTo(xInner2, yInner2);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Renders directional Stream / Speed / Motion lines.
 */
export function renderStreamLines(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  options: StreamLinesOptions
): void {
  const {
    angle = 0,
    density = 80,
    lineLength = 400,
    lengthNoise = 0.4,
    thickness = 3,
    thicknessNoise = 0.5,
    gapNoise = 0.4,
    color = '#000000',
  } = options;

  const rad = (angle * Math.PI) / 180;
  const dirX = Math.cos(rad);
  const dirY = Math.sin(rad);
  const perpX = -dirY;
  const perpY = dirX;

  // Diagonal span to cover entire rotated canvas
  const diag = Math.hypot(canvasWidth, canvasHeight);
  const count = Math.max(5, Math.min(800, density));
  const rng = pseudoRandom(42 + count + Math.round(angle));

  ctx.save();
  ctx.fillStyle = color;

  const centerX = canvasWidth * 0.5;
  const centerY = canvasHeight * 0.5;

  const bandStep = (diag * 1.4) / count;

  for (let i = 0; i < count; i++) {
    const bandOffset = (i - count * 0.5) * bandStep + (rng() - 0.5) * gapNoise * bandStep;
    // Longitudinal shift along speed line direction
    const longShift = (rng() - 0.5) * diag * 0.9;

    const streakLen = Math.max(20, lineLength * (1 + (rng() - 0.5) * lengthNoise * 1.5));
    const streakThick = Math.max(0.6, thickness * (1 + (rng() - 0.5) * thicknessNoise * 1.2));

    // Base origin point on the perpendicular swath
    const px = centerX + perpX * bandOffset + dirX * longShift;
    const py = centerY + perpY * bandOffset + dirY * longShift;

    // Start, mid, and end points of speed needle
    const startX = px - dirX * (streakLen * 0.5);
    const startY = py - dirY * (streakLen * 0.5);
    const endX = px + dirX * (streakLen * 0.5);
    const endY = py + dirY * (streakLen * 0.5);

    // Tapered diamond / speed blade
    const midX = px;
    const midY = py;
    const halfW = streakThick * 0.5;

    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(midX + perpX * halfW, midY + perpY * halfW);
    ctx.lineTo(endX, endY);
    ctx.lineTo(midX - perpX * halfW, midY - perpY * halfW);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}
