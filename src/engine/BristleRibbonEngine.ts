/**
 * BristleRibbonEngine.ts
 * Continuous Multi-Strand Bristle & Rake Frame Generator for InkStudio's Natural Paint Engine.
 *
 * Tracks a continuous parallel-transported local brush frame (tangent, normal, curvature,
 * accumulated arcLength, stylus tilt altitude/azimuth, barrel twist) along spline trajectories,
 * advancing up to 64 independent bristle strands without discrete-stamp blurring or
 * tight-turn self-intersection glitches.
 */

import type {
  BristleSettings,
  BrushSettings,
  NaturalMixingMode,
  NaturalPaintSettings,
  Point,
} from '../types/editor';
import {
  DEFAULT_BRISTLE_SETTINGS,
  DEFAULT_NATURAL_PAINT_SETTINGS,
} from '../types/editor';
import {
  BristleStepOutput,
  LayerPixelSampler,
  MAX_BRISTLE_CHANNELS,
  RgbaColor,
  SpatialBristleReservoir,
} from '../utils/colorMixingEngine';

/**
 * Stride (in floats) of one continuous bristle strand segment in BristleStrandBuffer:
 * [0] x0, [1] y0, [2] x1, [3] y1,
 * [4] r0, [5] g0, [6] b0, [7] a0,
 * [8] r1, [9] g1, [10] b1, [11] a1,
 * [12] radius0, [13] radius1,
 * [14] load0, [15] load1,
 * [16] height0, [17] height1,
 * [18] arcU0, [19] arcU1,
 * [20] acrossV, [21] pressure,
 * [22] tiltMag, [23] bristleIdx
 */
export const BRISTLE_SEG_STRIDE = 24;

export interface BristleStrandBatch {
  data: Float32Array;
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BristleStrokeConfig {
  color: string;
  size: number;
  minSizeFactor: number;
  flow: number;
  opacity: number;
  spacing: number;
  angleDeg: number;
  usePressure: boolean;
  useTilt: boolean;
  tiltScale: number;
  mixingMode: NaturalMixingMode;
  amountOfPaint: number;
  densityOfPaint: number;
  colorStretch: number;
  bristle: BristleSettings;
  naturalPaint: NaturalPaintSettings;
  presetKey?: string;
  strokeSeed?: number;
  totalLength?: number;
  taperInLength?: number;
  taperOutLength?: number;
  taperAffectSize?: boolean;
  taperAffectLoad?: boolean;
}

export function extractBristleStrokeConfig(
  bs: BrushSettings,
  strokeColor: string,
  totalLength?: number,
  strokeSeed?: number
): BristleStrokeConfig {
  const bristle: BristleSettings = {
    ...DEFAULT_BRISTLE_SETTINGS,
    ...(bs.bristle || {}),
  };
  const resolvedPaintLoad =
    bs.amountOfPaint !== undefined
      ? Math.max(0, Math.min(1, bs.amountOfPaint))
      : Math.max(0, Math.min(1, bs.naturalPaint?.paintLoad ?? DEFAULT_NATURAL_PAINT_SETTINGS.paintLoad));
  const resolvedSpatialMixing =
    bs.colorMixing === false
      ? false
      : bs.naturalPaint?.spatialMixing ?? DEFAULT_NATURAL_PAINT_SETTINGS.spatialMixing;
  const naturalPaint: NaturalPaintSettings = {
    ...DEFAULT_NATURAL_PAINT_SETTINGS,
    ...(bs.naturalPaint || {}),
    enabled: bs.naturalPaint?.enabled ?? (bs.renderMode === 'bristle-ribbon' || bs.renderMode === 'bristle-hybrid'),
    paintLoad: resolvedPaintLoad,
    spatialMixing: resolvedSpatialMixing,
  };
  return {
    color: strokeColor,
    size: Math.max(1, bs.size || 24),
    minSizeFactor: Math.max(0.02, Math.min(1, bs.minSizeFactor ?? 0.25)),
    flow: Math.max(0.01, Math.min(1, bs.brushDensity ?? bs.flow ?? 0.92)),
    opacity: Math.max(0.01, Math.min(1, bs.opacity ?? 1.0)),
    spacing: Math.max(0.02, Math.min(0.5, bs.spacing ?? 0.06)),
    angleDeg: bs.customTipAngle ?? 0,
    usePressure: bs.usePressure !== false,
    useTilt: Boolean(bs.useTilt),
    tiltScale: bs.tiltScale ?? 1.0,
    mixingMode: bs.mixingMode ?? 'impasto_mix',
    amountOfPaint: resolvedPaintLoad,
    densityOfPaint: bs.densityOfPaint ?? 0.9,
    colorStretch: bs.colorStretch ?? 0.7,
    bristle,
    naturalPaint,
    presetKey: bs.preset,
    strokeSeed: strokeSeed ?? 1337,
    totalLength,
    taperInLength: bs.taper?.useIn ? bs.taper.inLength || 0 : 0,
    taperOutLength: bs.taper?.useOut ? bs.taper.outLength || 0 : 0,
    taperAffectSize: bs.taper?.affectSize !== false,
    taperAffectLoad: bs.taper?.affectLoad ?? true,
  };
}

export class BristleRibbonEngine {
  public readonly reservoir: SpatialBristleReservoir;
  public readonly config: BristleStrokeConfig;
  public arcLength: number = 0;
  public strokeSeed: number = 1337;

  private initialized: boolean = false;
  private hasDirection: boolean = false;
  private tx: number = 1;
  private ty: number = 0;
  private nx: number = 0;
  private ny: number = 1;
  private prevCenterX: number = 0;
  private prevCenterY: number = 0;
  private prevAngle: number = 0;

  // Previous slice per-bristle state (SoA, zero GC)
  private readonly prevX = new Float32Array(MAX_BRISTLE_CHANNELS);
  private readonly prevY = new Float32Array(MAX_BRISTLE_CHANNELS);
  private readonly prevR = new Float32Array(MAX_BRISTLE_CHANNELS);
  private readonly prevG = new Float32Array(MAX_BRISTLE_CHANNELS);
  private readonly prevB = new Float32Array(MAX_BRISTLE_CHANNELS);
  private readonly prevA = new Float32Array(MAX_BRISTLE_CHANNELS);
  private readonly prevRadius = new Float32Array(MAX_BRISTLE_CHANNELS);
  private readonly prevLoad = new Float32Array(MAX_BRISTLE_CHANNELS);
  private readonly prevHeight = new Float32Array(MAX_BRISTLE_CHANNELS);
  private readonly prevArcU = new Float32Array(MAX_BRISTLE_CHANNELS);
  private readonly bristleLagX = new Float32Array(MAX_BRISTLE_CHANNELS);
  private readonly bristleLagY = new Float32Array(MAX_BRISTLE_CHANNELS);

  // 7-band flat-ribbon cohesive under-bed state (zero circular endcap halo + spatial color fidelity!)
  private static readonly BED_BANDS = 7;
  private readonly prevBedX = new Float32Array(7);
  private readonly prevBedY = new Float32Array(7);
  private readonly prevBedR = new Float32Array(7);
  private readonly prevBedG = new Float32Array(7);
  private readonly prevBedB = new Float32Array(7);
  private readonly prevBedA = new Float32Array(7);
  private readonly prevBedLoad = new Float32Array(7);
  private readonly prevBedRad = new Float32Array(7);
  private bedInitialized: boolean = false;

  // Reusable segment output buffer
  private segBuffer: Float32Array = new Float32Array(2048 * BRISTLE_SEG_STRIDE);
  private readonly scratchSample: RgbaColor = { r: 255, g: 255, b: 255, a: 0 };
  private readonly scratchStep: BristleStepOutput = {
    r: 0,
    g: 0,
    b: 0,
    alpha: 0,
    load: 0,
    height: 0,
  };

  constructor(config: BristleStrokeConfig, existingReservoir?: SpatialBristleReservoir) {
    this.config = config;
    this.strokeSeed = config.strokeSeed ?? 1337;
    this.reservoir =
      existingReservoir ??
      new SpatialBristleReservoir(
        config.color,
        config.bristle,
        config.naturalPaint,
        config.presetKey
      );
    if (existingReservoir) {
      this.reservoir.reset(
        config.color,
        config.bristle,
        config.naturalPaint,
        config.presetKey,
        this.strokeSeed
      );
    }
  }

  public getCurrentFrame(): { tx: number; ty: number; nx: number; ny: number; arcLength: number } {
    return {
      tx: this.tx,
      ty: this.ty,
      nx: this.nx,
      ny: this.ny,
      arcLength: this.arcLength,
    };
  }

  private ensureSegCapacity(count: number): void {
    const needed = count * BRISTLE_SEG_STRIDE;
    if (this.segBuffer.length < needed) {
      const next = new Float32Array(Math.max(needed, this.segBuffer.length * 2));
      next.set(this.segBuffer);
      this.segBuffer = next;
    }
  }

  /**
   * Computes taper multipliers for width and load at the current arc length.
   */
  private evaluateTaper(arcU: number): { widthScale: number; loadScale: number } {
    let widthScale = 1.0;
    let loadScale = 1.0;
    const inLen = this.config.taperInLength ?? 0;
    if (inLen > 0 && arcU < inLen) {
      const f = Math.max(0.08, Math.min(1.0, arcU / inLen));
      if (this.config.taperAffectSize !== false) widthScale *= f;
      if (this.config.taperAffectLoad !== false) loadScale *= 0.35 + 0.65 * f;
    }
    const total = this.config.totalLength ?? 0;
    const outLen = this.config.taperOutLength ?? 0;
    if (total > 0 && outLen > 0) {
      const distFromEnd = total - arcU;
      if (distFromEnd < outLen) {
        const f = Math.max(0.06, Math.min(1.0, distFromEnd / outLen));
        if (this.config.taperAffectSize !== false) widthScale *= f;
        if (this.config.taperAffectLoad !== false) loadScale *= f;
      }
    }
    return { widthScale, loadScale };
  }

  /**
   * Initializes the bristle frame at pointer-down.
   * When `initialDir` is provided (completed stroke bake), aligns bristles directly along
   * the true stroke tangent so there is zero detached stub. For live pointer-down before
   * movement, anchors the frame and emits a soft cohesive touch only when `emitDot` is true.
   */
  public emitInitialStamp(
    pt: Point,
    sampler?: LayerPixelSampler,
    initialDir?: { dx: number; dy: number },
    emitDot: boolean = true
  ): BristleStrandBatch {
    let baseAngleRad = (this.config.angleDeg * Math.PI) / 180;
    if (initialDir && Math.hypot(initialDir.dx, initialDir.dy) > 1e-3) {
      baseAngleRad = Math.atan2(initialDir.dy, initialDir.dx);
      this.hasDirection = true;
    } else {
      this.hasDirection = false;
    }
    this.tx = Math.cos(baseAngleRad);
    this.ty = Math.sin(baseAngleRad);
    this.nx = -this.ty;
    this.ny = this.tx;
    this.prevAngle = baseAngleRad;
    this.prevCenterX = pt.x;
    this.prevCenterY = pt.y;
    this.arcLength = 0;

    const pressure = Math.max(0.05, Math.min(1.0, pt.pressure || 0.5));
    const tiltX = this.config.useTilt ? pt.tiltX ?? 0 : 0;
    const tiltY = this.config.useTilt ? pt.tiltY ?? 0 : 0;
    const tiltDeg = Math.min(90, Math.hypot(tiltX, tiltY));
    const tiltMag = Math.sin((tiltDeg * Math.PI) / 180);
    const splay = this.computeSplay(pressure, tiltMag);
    const width = Math.max(1.5, pt.width > 0 ? pt.width : this.config.size);
    const halfW = width * 0.5 * splay;

    const n = this.reservoir.count;
    this.ensureSegCapacity(n + 1);
    const out = this.segBuffer;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let segCount = 0;

    const twistRad = ((pt.twist ?? 0) * Math.PI) / 180;
    const cosTw = Math.cos(twistRad);
    const sinTw = Math.sin(twistRad);
    const rNx = this.nx * cosTw - this.ny * sinTw;
    const rNy = this.nx * sinTw + this.ny * cosTw;
    const isKnife = this.config.bristle.profile === 'knife';

    for (let i = 0; i < n; i++) {
      const off = this.reservoir.offsets[i];
      const absOff = Math.abs(off);
      const stagger = this.reservoir.startDelay[i];
      const longOff = (stagger - 0.35) * width * (isKnife ? 0.04 : 0.25);
      const bx = pt.x + rNx * (off * halfW) + this.tx * longOff;
      const by = pt.y + rNy * (off * halfW) + this.ty * longOff;
      const strandRad = Math.max(0.85, this.reservoir.radii[i] * halfW * 1.45);

      if (sampler && this.config.naturalPaint.spatialMixing) {
        sampler.samplePointFast(bx, by, strandRad, this.scratchSample);
      } else {
        this.scratchSample.a = 0;
      }

      const stepOut = this.reservoir.stepBristle(
        i,
        this.scratchSample,
        0,
        pressure,
        this.config.naturalPaint,
        this.config.mixingMode,
        this.config.colorStretch,
        this.config.amountOfPaint,
        this.config.densityOfPaint,
        this.config.flow,
        this.scratchStep
      );

      const entryFade = isKnife ? 1.0 : Math.max(0.15, 1.0 - stagger * 0.65);
      const flankFade = isKnife ? 1.0 : 1.0 - Math.pow(Math.max(0, absOff - 0.55) / 0.45, 1.5) * 0.55;
      const initAlpha = stepOut.alpha * entryFade * flankFade;
      const initLoad = stepOut.load * entryFade * flankFade;

      this.prevX[i] = bx;
      this.prevY[i] = by;
      this.bristleLagX[i] = bx;
      this.bristleLagY[i] = by;
      this.prevR[i] = stepOut.r;
      this.prevG[i] = stepOut.g;
      this.prevB[i] = stepOut.b;
      // For continuous strokes (!emitDot), start bristles cleanly at 0 so they fade IN at their
      // staggered startGate instead of painting a detached ghost dot at arcLength = 0!
      const startAtZero = !emitDot && !isKnife;
      this.prevA[i] = startAtZero ? 0 : initAlpha;
      this.prevRadius[i] = strandRad * (0.7 + 0.3 * entryFade);
      this.prevLoad[i] = startAtZero ? 0 : initLoad;
      this.prevHeight[i] = startAtZero ? 0 : stepOut.height * entryFade;
      this.prevArcU[i] = 0;

      // Only emit a single-tap dot if explicitly requested (avoids detached start stub before drag!)
      if (emitDot && initAlpha > 0.01 && !initialDir) {
        const dabHalfLen = Math.max(0.5, strandRad * 0.55);
        const sx0 = bx - this.tx * dabHalfLen;
        const sy0 = by - this.ty * dabHalfLen;
        const sx1 = bx + this.tx * dabHalfLen;
        const sy1 = by + this.ty * dabHalfLen;
        const base = segCount * BRISTLE_SEG_STRIDE;
        out[base + 0] = sx0;
        out[base + 1] = sy0;
        out[base + 2] = sx1;
        out[base + 3] = sy1;
        out[base + 4] = stepOut.r;
        out[base + 5] = stepOut.g;
        out[base + 6] = stepOut.b;
        out[base + 7] = initAlpha * 0.7;
        out[base + 8] = stepOut.r;
        out[base + 9] = stepOut.g;
        out[base + 10] = stepOut.b;
        out[base + 11] = initAlpha * 0.7;
        out[base + 12] = this.prevRadius[i] * 0.85;
        out[base + 13] = this.prevRadius[i] * 0.85;
        out[base + 14] = initLoad;
        out[base + 15] = initLoad;
        out[base + 16] = stepOut.height * entryFade * 0.65;
        out[base + 17] = stepOut.height * entryFade * 0.65;
        out[base + 18] = 0;
        out[base + 19] = dabHalfLen * 2;
        out[base + 20] = off;
        out[base + 21] = pressure;
        out[base + 22] = tiltMag;
        out[base + 23] = i;
        segCount++;

        const pad = strandRad + 2;
        if (Math.min(sx0, sx1) - pad < minX) minX = Math.min(sx0, sx1) - pad;
        if (Math.min(sy0, sy1) - pad < minY) minY = Math.min(sy0, sy1) - pad;
        if (Math.max(sx0, sx1) + pad > maxX) maxX = Math.max(sx0, sx1) + pad;
        if (Math.max(sy0, sy1) + pad > maxY) maxY = Math.max(sy0, sy1) + pad;
      }
    }

    this.initialized = true;
    this.bedInitialized = false;

    return {
      data: out,
      count: segCount,
      minX,
      minY,
      maxX,
      maxY,
    };
  }

  private computeSplay(pressure: number, tiltMag: number): number {
    const splayStrength = Math.max(0, Math.min(1, this.config.bristle.splay));
    const stiffness = Math.max(0, Math.min(1, this.config.bristle.stiffness));
    const flex = 1.0 - stiffness * 0.45;
    const pSplay = 1.0 + (pressure - 0.5) * splayStrength * 0.65 * flex;
    const tiltSplay = this.config.useTilt ? tiltMag * (this.config.tiltScale || 1.0) * (0.45 + splayStrength * 0.8) : 0;
    return Math.max(0.45, Math.min(2.6, pSplay + tiltSplay));
  }

  /**
   * Advances all bristle strands continuously along a cubic Bézier curve segment,
   * using parallel-transported frames and signed-curvature fold clamping.
   */
  public emitCubicSegment(
    p0: Point,
    c1: Point,
    c2: Point,
    p3: Point,
    sampler?: LayerPixelSampler
  ): BristleStrandBatch {
    // Estimate curve arc length
    const polyLen =
      Math.hypot(c1.x - p0.x, c1.y - p0.y) +
      Math.hypot(c2.x - c1.x, c2.y - c1.y) +
      Math.hypot(p3.x - c2.x, p3.y - c2.y);

    if (polyLen < 0.08) {
      return { data: this.segBuffer, count: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    }

    if (!this.initialized) {
      this.emitInitialStamp(p0, sampler);
    }

    const avgW = Math.max(2, (p0.width + p3.width) * 0.5 || this.config.size);
    // Fine high-DPI continuous ribbon stepping: razor-smooth curves even on large 80-120px brushes
    const targetStep = Math.max(1.0, Math.min(3.2, avgW * Math.max(0.035, this.config.spacing * 0.55)));
    const slices = Math.max(1, Math.min(64, Math.ceil(polyLen / targetStep)));

    const n = this.reservoir.count;
    const stiffness = Math.max(0.05, Math.min(1.0, this.config.bristle.stiffness));
    // Higher stiffness follows brush frame crisply; lower stiffness trails gently like long soft hair
    const followRate = 0.42 + stiffness * 0.58;
    const baseAngleRad = (this.config.angleDeg * Math.PI) / 180;

    let segCount = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let s = 1; s <= slices; s++) {
      const t = s / slices;
      const it = 1 - t;
      const it2 = it * it;
      const it3 = it2 * it;
      const t2 = t * t;
      const t3 = t2 * t;
      const b1 = 3 * it2 * t;
      const b2 = 3 * it * t2;

      const cx = it3 * p0.x + b1 * c1.x + b2 * c2.x + t3 * p3.x;
      const cy = it3 * p0.y + b1 * c1.y + b2 * c2.y + t3 * p3.y;
      const dx = cx - this.prevCenterX;
      const dy = cy - this.prevCenterY;
      const stepDist = Math.hypot(dx, dy);
      if (stepDist < 0.12) continue;

      this.arcLength += stepDist;
      const pressure = Math.max(
        0.05,
        Math.min(1.0, it3 * p0.pressure + b1 * c1.pressure + b2 * c2.pressure + t3 * p3.pressure)
      );
      const rawW = it3 * p0.width + b1 * c1.width + b2 * c2.width + t3 * p3.width;
      const { widthScale, loadScale } = this.evaluateTaper(this.arcLength);
      const width = Math.max(1.2, (rawW > 0 ? rawW : this.config.size) * widthScale);

      const tiltX = this.config.useTilt ? it * (p0.tiltX ?? 0) + t * (p3.tiltX ?? 0) : 0;
      const tiltY = this.config.useTilt ? it * (p0.tiltY ?? 0) + t * (p3.tiltY ?? 0) : 0;
      const tiltDeg = Math.min(90, Math.hypot(tiltX, tiltY));
      const tiltMag = Math.sin((tiltDeg * Math.PI) / 180);
      const twistDeg = it * (p0.twist ?? 0) + t * (p3.twist ?? 0);

      // Physical hand-held brush head orientation:
      // Smoothly follows gentle curves without whipping into radial pinwheel fans on sharp zig-zag reversals!
      const instTx = dx / stepDist;
      const instTy = dy / stepDist;
      const instAngle = Math.atan2(instTy, instTx);
      const isKnife = this.config.bristle.profile === 'knife';
      const entryZone = isKnife ? width * 0.2 : Math.max(18, width * 0.95);

      let signedTurn = 0;
      if (!this.hasDirection) {
        this.tx = instTx;
        this.ty = instTy;
        this.prevAngle = instAngle;
        this.hasDirection = true;

        // Re-align initial bristle anchors to the established stroke direction with organic longitudinal stagger
        const initNx = -this.ty;
        const initNy = this.tx;
        const initHalfW = Math.max(1, p0.width || this.config.size) * 0.5;
        for (let i = 0; i < n; i++) {
          const off = this.reservoir.offsets[i];
          const longStagger = isKnife ? 0 : (this.reservoir.startDelay[i] - 0.35) * width * 0.38;
          this.prevX[i] = this.prevCenterX + initNx * (off * initHalfW) + this.tx * longStagger;
          this.prevY[i] = this.prevCenterY + initNy * (off * initHalfW) + this.ty * longStagger;
          this.bristleLagX[i] = this.prevX[i];
          this.bristleLagY[i] = this.prevY[i];
        }
      } else {
        // Compute smallest angular difference to either forward or reversed stroke axis.
        // When an artist pulls back in a zig-zag (Photo 2!), the hand doesn't spin the brush 180° —
        // it glides smoothly across the reversed axis, completely eliminating radial pinwheel corners!
        let dTheta = instAngle - this.prevAngle;
        while (dTheta > Math.PI) dTheta -= Math.PI * 2;
        while (dTheta < -Math.PI) dTheta += Math.PI * 2;

        if (Math.abs(dTheta) > Math.PI * 0.58) {
          // Sharp reversal: align gently to the opposite parallel axis (keeps normal continuous, zero pinwheel!)
          const flippedTarget = dTheta > 0 ? dTheta - Math.PI : dTheta + Math.PI;
          const maxStepTurn = Math.min(0.28, (stepDist / Math.max(12, width * 0.75)) * 0.55);
          signedTurn = Math.max(-maxStepTurn, Math.min(maxStepTurn, flippedTarget * 0.35));
        } else {
          // Normal curve: physical arc-length damped angular tracking
          const maxStepTurn = Math.min(0.35, (stepDist / Math.max(8, width * 0.45)) * (0.45 + stiffness * 0.45));
          signedTurn = Math.max(-maxStepTurn, Math.min(maxStepTurn, dTheta * (0.45 + stiffness * 0.4)));
        }

        const nextAngle = this.prevAngle + signedTurn;
        this.prevAngle = nextAngle;
        this.tx = Math.cos(nextAngle);
        this.ty = Math.sin(nextAngle);
      }

      // Base perpendicular normal (rotated by optional brush angle / barrel twist / tilt azimuth)
      let frameRot = baseAngleRad + (twistDeg * Math.PI) / 180;
      if (this.config.useTilt && tiltMag > 0.12) {
        const tiltAz = Math.atan2(tiltY, tiltX);
        let relTilt = tiltAz - this.prevAngle;
        while (relTilt > Math.PI) relTilt -= Math.PI * 2;
        while (relTilt < -Math.PI) relTilt += Math.PI * 2;
        frameRot += relTilt * tiltMag * 0.45;
      }

      const cosR = Math.cos(frameRot);
      const sinR = Math.sin(frameRot);
      const baseNx = -this.ty;
      const baseNy = this.tx;
      this.nx = baseNx * cosR - baseNy * sinR;
      this.ny = baseNx * sinR + baseNy * cosR;

      const splay = this.computeSplay(pressure, tiltMag);
      const halfW = width * 0.5 * splay;

      // Signed curvature kappa = dTheta / ds -> clamp inner-turn normal offset to prevent fold-over
      const kappa = signedTurn / Math.max(0.5, stepDist);
      const absKappa = Math.abs(kappa);
      const maxInnerRadius = absKappa > 1e-4 ? Math.max(3.0, 0.85 / absKappa) : Infinity;
      const irreg = this.config.bristle.irregularity;

      const BED_BANDS = BristleRibbonEngine.BED_BANDS;
      this.ensureSegCapacity(segCount + n + BED_BANDS);
      const out = this.segBuffer;
      const profile = this.config.bristle.profile;
      const isRake = profile === 'rake';
      const isFan = profile === 'fan';
      // Wider overlapping tuft base for lush cohesive oil/filbert/acrylic bodies;
      // crisp expressive strands for rake/fan with richer clumped center for Prussian blue overlaps (Photo 2!)
      const tuftWidthBoost = isRake ? 1.38 : isFan ? 1.24 : isKnife ? 1.85 : 1.82;
      const hasUnderBed = !isRake && !isFan && stepDist > 0.05;
      const bedSlotStart = hasUnderBed ? segCount : -1;
      if (hasUnderBed) segCount += BED_BANDS;

      // Accumulate local spatial color & load per under-bed band so yellow+purple NEVER muddy together!
      const bandR = [0, 0, 0, 0, 0, 0, 0];
      const bandG = [0, 0, 0, 0, 0, 0, 0];
      const bandB = [0, 0, 0, 0, 0, 0, 0];
      const bandLoad = [0, 0, 0, 0, 0, 0, 0];
      const bandAlpha = [0, 0, 0, 0, 0, 0, 0];
      const bandCount = [0, 0, 0, 0, 0, 0, 0];

      for (let i = 0; i < n; i++) {
        const rawOff = this.reservoir.offsets[i];
        const absOff = Math.abs(rawOff);

        // Organic bristle hair meander along arc length (like hand-painted oil strands in Photo 1!)
        const meander = isKnife
          ? 0
          : Math.sin(this.arcLength * this.reservoir.wanderFreq[i] + this.reservoir.wanderPhase[i]) *
            (0.032 + irreg * 0.068);
        let localSpan = Math.max(-1.05, Math.min(1.05, rawOff + meander)) * halfW;

        // If bristle lies on the inside of a tight curve, clamp its radial span smoothly
        if (kappa * localSpan > 0 && Math.abs(localSpan) > maxInnerRadius) {
          const excess = Math.abs(localSpan) - maxInnerRadius;
          const compressed = maxInnerRadius + excess * 0.12;
          localSpan = Math.sign(localSpan) * Math.min(Math.abs(localSpan), compressed);
        }

        // Longitudinal brush tuft stagger so start/end & edge hairs sit naturally forward/back
        const longOffset = isKnife ? 0 : (this.reservoir.startDelay[i] - 0.45) * width * (isRake ? 0.36 : 0.24);
        const targetX = cx + this.nx * localSpan + this.tx * longOffset;
        const targetY = cy + this.ny * localSpan + this.ty * longOffset;

        // Bristle flexibility lag: outer/longer hairs follow with subtle organic sweep
        const bx = this.bristleLagX[i] + (targetX - this.bristleLagX[i]) * followRate;
        const by = this.bristleLagY[i] + (targetY - this.bristleLagY[i]) * followRate;
        this.bristleLagX[i] = bx;
        this.bristleLagY[i] = by;

        const strandDist = Math.hypot(bx - this.prevX[i], by - this.prevY[i]);
        // Natural bristle width undulation along stroke length
        const widthBreath = isKnife
          ? 1.0
          : 0.88 + 0.18 * Math.sin(this.arcLength * 0.035 + this.reservoir.wanderPhase[i] * 1.7);
        // For rake, inner bristles form richer bold clumped tracks while outer hairs stay fine & separated (Photo 2!)
        const rakeCenterBoost = isRake ? (absOff < 0.58 ? 1.24 : 0.86) : 1.0;
        const strandRad = Math.max(
          0.75,
          this.reservoir.radii[i] * halfW * tuftWidthBoost * rakeCenterBoost * widthBreath
        );

        if (sampler && this.config.naturalPaint.spatialMixing) {
          sampler.samplePointFast(bx, by, strandRad, this.scratchSample);
        } else {
          this.scratchSample.a = 0;
        }

        const stepOut = this.reservoir.stepBristle(
          i,
          this.scratchSample,
          strandDist,
          pressure,
          this.config.naturalPaint,
          this.config.mixingMode,
          this.config.colorStretch,
          this.config.amountOfPaint,
          this.config.densityOfPaint,
          this.config.flow,
          this.scratchStep
        );

        // Staggered organic entry feathering: each bristle enters at its own arcLength
        const startGate = this.reservoir.startDelay[i] * entryZone * (isRake ? 0.65 : 0.52);
        let entryRamp = 1.0;
        if (!isKnife && this.arcLength < startGate + entryZone * 0.48) {
          const tEntry = (this.arcLength - startGate) / Math.max(4, entryZone * 0.48);
          entryRamp = tEntry <= 0 ? 0 : tEntry >= 1 ? 1 : tEntry * tEntry * (3 - 2 * tEntry);
        }

        // Physical pressure-driven bristle lift-off: softer threshold so light strokes smoothly
        // glaze/blend across underlying paint while dry-brush presets still lift outer hairs
        const liftThresh =
          (1.0 - this.reservoir.lengthFactors[i]) * (0.28 + this.config.naturalPaint.dryBrush * 0.34);
        const contactLift = isKnife
          ? 1.0
          : Math.max(0.0, Math.min(1.0, (pressure - liftThresh) / 0.36));
        const smoothLift = contactLift * contactLift * (3.0 - 2.0 * contactLift);

        // Outer-flank dry-brush feathering: outer edges naturally reveal woven linen tooth (Photo 1 & 2!)
        const flankDrop = isKnife
          ? 1.0
          : 1.0 - Math.pow(Math.max(0, absOff - 0.62) / 0.38, 1.5) * (isRake ? 0.5 : 0.68);

        // Subtle along-stroke ridge modulation so 3D paint crests breathe organically
        const ridgeBreath = isKnife
          ? 1.0
          : 0.84 + 0.22 * Math.sin(this.arcLength * 0.042 + this.reservoir.wanderPhase[i]);

        const contactEnv = entryRamp * smoothLift;
        const effAlpha = stepOut.alpha * loadScale * contactEnv * (0.50 + 0.50 * flankDrop);
        const effLoad = stepOut.load * loadScale * contactEnv * flankDrop;
        const effRad = strandRad * (0.58 + 0.42 * contactEnv);
        const effHeight = stepOut.height * contactEnv * ridgeBreath;

        if (hasUnderBed && absOff < 0.84) {
          const normBand = ((rawOff / 0.84) * 0.5 + 0.5) * (BED_BANDS - 1);
          const bi = Math.max(0, Math.min(BED_BANDS - 1, Math.round(normBand)));
          bandR[bi] += stepOut.r;
          bandG[bi] += stepOut.g;
          bandB[bi] += stepOut.b;
          bandLoad[bi] += effLoad;
          bandAlpha[bi] += effAlpha;
          bandCount[bi]++;
        }

        if ((effAlpha > 0.003 || this.prevA[i] > 0.003) && strandDist > 0.05) {
          const base = segCount * BRISTLE_SEG_STRIDE;
          out[base + 0] = this.prevX[i];
          out[base + 1] = this.prevY[i];
          out[base + 2] = bx;
          out[base + 3] = by;
          out[base + 4] = this.prevR[i];
          out[base + 5] = this.prevG[i];
          out[base + 6] = this.prevB[i];
          out[base + 7] = this.prevA[i];
          out[base + 8] = stepOut.r;
          out[base + 9] = stepOut.g;
          out[base + 10] = stepOut.b;
          out[base + 11] = effAlpha;
          out[base + 12] = this.prevRadius[i];
          out[base + 13] = effRad;
          out[base + 14] = this.prevLoad[i];
          out[base + 15] = effLoad;
          out[base + 16] = this.prevHeight[i];
          out[base + 17] = effHeight;
          out[base + 18] = this.prevArcU[i];
          out[base + 19] = this.arcLength;
          out[base + 20] = rawOff;
          out[base + 21] = pressure;
          out[base + 22] = tiltMag;
          out[base + 23] = i;
          segCount++;

          const pad = Math.max(this.prevRadius[i], effRad) + 2;
          const xMin = Math.min(this.prevX[i], bx) - pad;
          const yMin = Math.min(this.prevY[i], by) - pad;
          const xMax = Math.max(this.prevX[i], bx) + pad;
          const yMax = Math.max(this.prevY[i], by) + pad;
          if (xMin < minX) minX = xMin;
          if (yMin < minY) minY = yMin;
          if (xMax > maxX) maxX = xMax;
          if (yMax > maxY) maxY = yMax;

          // Deposit behind the bristle's 5-tap sample cross so forward motion reads true underlying
          // canvas pigment without self-dilution, while loops/reversals pick up earlier passes
          if (sampler && this.config.naturalPaint.spatialMixing && effAlpha > 0.02 && strandDist > 0.45) {
            const depRad = Math.max(1, effRad * 0.35);
            const trailOff = Math.min(6, effRad * 0.65) + depRad + 0.5;
            const sTx = (bx - this.prevX[i]) / strandDist;
            const sTy = (by - this.prevY[i]) / strandDist;
            sampler.depositPointFast(
              this.prevX[i] - sTx * trailOff,
              this.prevY[i] - sTy * trailOff,
              depRad,
              stepOut.r,
              stepOut.g,
              stepOut.b,
              effAlpha * 0.35
            );
          }
        }

        this.prevX[i] = bx;
        this.prevY[i] = by;
        this.prevR[i] = stepOut.r;
        this.prevG[i] = stepOut.g;
        this.prevB[i] = stepOut.b;
        this.prevA[i] = effAlpha;
        this.prevRadius[i] = effRad;
        this.prevLoad[i] = effLoad;
        this.prevHeight[i] = effHeight;
        this.prevArcU[i] = this.arcLength;
      }

      // Fill reserved 7-band flat-ribbon under-bed slots (rasterize BEFORE the slice's bristles!)
      // Eliminates circular endcap halos & muddying while creating a solid spatial oil body!
      if (bedSlotStart >= 0) {
        const bedSpanMax = isKnife ? 0.88 : 0.72;
        const bandRad = Math.max(1.2, halfW * (isKnife ? 0.22 : 0.19));
        for (let b = 0; b < BED_BANDS; b++) {
          const uBand = (b / (BED_BANDS - 1)) * 2 - 1; // [-1..+1]
          const rawBandOff = uBand * bedSpanMax;
          let localBandSpan = rawBandOff * halfW;
          if (kappa * localBandSpan > 0 && Math.abs(localBandSpan) > maxInnerRadius) {
            const excess = Math.abs(localBandSpan) - maxInnerRadius;
            localBandSpan = Math.sign(localBandSpan) * Math.min(Math.abs(localBandSpan), maxInnerRadius + excess * 0.12);
          }
          const bx = cx + this.nx * localBandSpan;
          const by = cy + this.ny * localBandSpan;

          // Fallback to neighbor band if a band has zero bristles due to strong clumping
          let cnt = bandCount[b];
          let br = bandR[b];
          let bg = bandG[b];
          let bb = bandB[b];
          let bl = bandLoad[b];
          let ba = bandAlpha[b];
          if (cnt === 0) {
            for (let off = 1; off < BED_BANDS; off++) {
              if (b - off >= 0 && bandCount[b - off] > 0) {
                cnt = bandCount[b - off];
                br = bandR[b - off];
                bg = bandG[b - off];
                bb = bandB[b - off];
                bl = bandLoad[b - off];
                ba = bandAlpha[b - off];
                break;
              }
              if (b + off < BED_BANDS && bandCount[b + off] > 0) {
                cnt = bandCount[b + off];
                br = bandR[b + off];
                bg = bandG[b + off];
                bb = bandB[b + off];
                bl = bandLoad[b + off];
                ba = bandAlpha[b + off];
                break;
              }
            }
          }

          const invC = cnt > 0 ? 1 / cnt : 0;
          const rCur = br * invC;
          const gCur = bg * invC;
          const bCur = bb * invC;
          const lCur = bl * invC;
          const bandEntryDelay = Math.abs(uBand) * 0.28;
          const bedEntry = isKnife
            ? 1.0
            : Math.min(1.0, Math.max(0.0, (this.arcLength - entryZone * (0.25 + bandEntryDelay)) / Math.max(8, entryZone * 0.55)));
          // Under-bed lifts off smoothly as stylus pressure drops so light strokes blend softly
          // while medium/firm strokes layer opaquely without harsh gaps
          const bedPressureLift = isKnife
            ? 1.0
            : Math.max(0.0, Math.min(1.0, (pressure - (0.18 + Math.abs(uBand) * 0.14)) / 0.3));
          const aCur = Math.min(0.98, ba * invC * (isKnife ? 0.98 : 0.94) * bedEntry * bedPressureLift);
          const base = (bedSlotStart + b) * BRISTLE_SEG_STRIDE;

          if (!this.bedInitialized) {
            this.prevBedX[b] = this.prevCenterX + this.nx * localBandSpan;
            this.prevBedY[b] = this.prevCenterY + this.ny * localBandSpan;
            this.prevBedR[b] = rCur;
            this.prevBedG[b] = gCur;
            this.prevBedB[b] = bCur;
            this.prevBedA[b] = isKnife ? aCur : 0;
            this.prevBedLoad[b] = isKnife ? lCur : 0;
            this.prevBedRad[b] = bandRad;
          }

          if (cnt > 0 && (aCur > 0.02 || this.prevBedA[b] > 0.02) && lCur > 0.04) {
            out[base + 0] = this.prevBedX[b];
            out[base + 1] = this.prevBedY[b];
            out[base + 2] = bx;
            out[base + 3] = by;
            out[base + 4] = this.prevBedR[b];
            out[base + 5] = this.prevBedG[b];
            out[base + 6] = this.prevBedB[b];
            out[base + 7] = this.prevBedA[b];
            out[base + 8] = rCur;
            out[base + 9] = gCur;
            out[base + 10] = bCur;
            out[base + 11] = aCur;
            out[base + 12] = this.prevBedRad[b];
            out[base + 13] = bandRad;
            out[base + 14] = this.prevBedLoad[b];
            out[base + 15] = lCur;
            out[base + 16] = this.prevBedLoad[b] * 0.36;
            out[base + 17] = lCur * 0.36;
            out[base + 18] = Math.max(0, this.arcLength - stepDist);
            out[base + 19] = this.arcLength;
            out[base + 20] = rawBandOff;
            out[base + 21] = pressure;
            out[base + 22] = tiltMag;
            out[base + 23] = -1; // Cohesive flat-ribbon under-bed marker

            const pad = bandRad + 2;
            if (Math.min(this.prevBedX[b], bx) - pad < minX) minX = Math.min(this.prevBedX[b], bx) - pad;
            if (Math.min(this.prevBedY[b], by) - pad < minY) minY = Math.min(this.prevBedY[b], by) - pad;
            if (Math.max(this.prevBedX[b], bx) + pad > maxX) maxX = Math.max(this.prevBedX[b], bx) + pad;
            if (Math.max(this.prevBedY[b], by) + pad > maxY) maxY = Math.max(this.prevBedY[b], by) + pad;
          } else {
            out[base + 7] = 0;
            out[base + 11] = 0;
            out[base + 23] = -1;
          }

          this.prevBedX[b] = bx;
          this.prevBedY[b] = by;
          this.prevBedR[b] = rCur;
          this.prevBedG[b] = gCur;
          this.prevBedB[b] = bCur;
          this.prevBedA[b] = aCur;
          this.prevBedLoad[b] = lCur;
          this.prevBedRad[b] = bandRad;
        }
        this.bedInitialized = true;
      }

      this.prevCenterX = cx;
      this.prevCenterY = cy;
    }

    return {
      data: this.segBuffer,
      count: segCount,
      minX,
      minY,
      maxX,
      maxY,
    };
  }

  public finishStroke(): void {
    this.reservoir.persistDirtyStateIfNeeded();
  }
}
