/**
 * InputStabilizer.ts
 * Low-Latency Velocity-Adaptive Isotropic Stabilizer + Velocity Tracker + Glitch Guard.
 * Pre-allocated memory structures, zero GC pauses during active drawing.
 * Features:
 *  - CSP-calibrated stabilization range (0..50): 0px at level 0, ~3px at level 1,
 *    6-16px at levels 15-20 (G-Pen / Real G-Pen), up to ~48px max at level 50
 *  - Velocity-adaptive lag tightening so fast strokes feel crisp and real-time
 *  - Rotation-invariant Frenet-frame tremor damping (zero diagonal warping/anisotropy)
 *  - Targeted hardware backtrack glitch rejection that preserves tight curves & waves
 *  - Smooth sub-path corner convergence (never hard-teleports s1/s2/s3 across lag)
 *  - Full-tail catch-up target to the true pen-lift raw coordinate
 *  - Asymmetric Attack / Decay Pressure Filtering
 */

export interface StabilizerConfig {
  minCutoff: number; // fc_min (Hz): lower = smoother slow movements (default ~1.5)
  beta: number;      // beta: speed coefficient; higher = less lag on flicks (default ~0.012)
  dCutoff: number;   // d_cutoff (Hz): cutoff for derivative filtering (default ~1.0)
  deadzone: number;  // Minimum delta distance (px) to register movement when settled
  springMass: number; // Mass for virtual pull-string / spring-damper (0 = disabled)
  springStiffness: number; // Spring stiffness k
  springDamping: number;   // Damping coefficient c (critically damped: 2 * sqrt(k * m))
  cornerAngleThreshold: number; // Angular deflection threshold in radians (default 68 deg = 1.1868)
  attackCutoff: number; // Pressure attack cutoff Hz (instant contact)
  decayCutoff: number;  // Pressure decay cutoff Hz (smooth release)
}

export const DEFAULT_STABILIZER_CONFIG: StabilizerConfig = {
  minCutoff: 1.5,
  beta: 0.012,
  dCutoff: 1.0,
  deadzone: 0.1,
  springMass: 0,
  springStiffness: 180,
  springDamping: 26.8,
  cornerAngleThreshold: 1.1868, // 68 degrees: catches deliberate sharp corners without false-snapping smooth waves
  attackCutoff: 45.0, // Fast response on pen attack
  decayCutoff: 4.0,   // Smooth release
};

export class OneEuroAxis {
  private xPrev: number = 0;
  private dxPrev: number = 0;
  private tPrev: number = 0;
  private initialized: boolean = false;

  public reset(): void {
    this.xPrev = 0;
    this.dxPrev = 0;
    this.tPrev = 0;
    this.initialized = false;
  }

  public setDirect(x: number, timestampMs: number): void {
    this.xPrev = x;
    this.dxPrev = 0;
    this.tPrev = timestampMs;
    this.initialized = true;
  }

  public getValue(): number {
    return this.xPrev;
  }

  private alpha(rate: number, cutoff: number): number {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    const te = 1.0 / Math.max(1e-5, rate);
    return 1.0 / (1.0 + tau / te);
  }

  public filter(x: number, timestampMs: number, minCutoff: number, beta: number, dCutoff: number): number {
    if (!this.initialized) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = timestampMs;
      this.initialized = true;
      return x;
    }

    const rawElapsedMs = timestampMs - this.tPrev;
    // Use 4ms (250Hz) sub-step when coalesced events share timestamps WITHOUT drifting tPrev ahead of wall time
    const effectiveMs = rawElapsedMs > 0.5 ? Math.min(50.0, rawElapsedMs) : 4.0;
    const dt = Math.max(0.002, effectiveMs * 0.001);
    if (timestampMs > this.tPrev) {
      this.tPrev = timestampMs;
    }
    const rate = 1.0 / dt;

    // Filter derivative
    const dx = (x - this.xPrev) / dt;
    const aD = this.alpha(rate, dCutoff);
    const edx = aD * dx + (1.0 - aD) * this.dxPrev;
    this.dxPrev = edx;

    // Dynamic cutoff based on speed
    const cutoff = minCutoff + beta * Math.abs(edx);
    const a = this.alpha(rate, cutoff);
    const filteredX = a * x + (1.0 - a) * this.xPrev;
    this.xPrev = filteredX;

    return filteredX;
  }
}

export interface StabilizedSample {
  x: number;
  y: number;
  pressure: number;
  vx: number; // px / ms
  vy: number; // px / ms
  speed: number; // px / ms
  timestamp: number;
  isCorner: boolean;
}

export interface CornerConvergencePlan {
  startX: number;
  startY: number;
  apexX: number;
  apexY: number;
  targetX: number;
  targetY: number;
  totalDist: number;
}

export class InputStabilizer {
  private filterPressure = new OneEuroAxis();

  // 3-stage isotropic cascaded exponential smoother state (zero overshoot, zero diagonal anisotropy)
  private s1x: number = 0;
  private s1y: number = 0;
  private s2x: number = 0;
  private s2y: number = 0;
  private s3x: number = 0;
  private s3y: number = 0;

  // Mass-Spring-Damper simulation state
  private smX: number = 0;
  private smY: number = 0;
  private smVx: number = 0;
  private smVy: number = 0;

  // Velocity & monotonic timing tracker state
  private lastX: number = 0;
  private lastY: number = 0;
  private lastTime: number = 0;
  private instantVx: number = 0;
  private instantVy: number = 0;
  private instantSpeed: number = 0;
  private smoothedScreenSpeed: number = 0; // screen px / ms

  // Direction vector history for Corner Detection, Frenet tremor damping & glitch rejection
  private prevDirX: number = 0;
  private prevDirY: number = 0;
  private hasPrevDir: boolean = false;
  private lastStepDirX: number = 0;
  private lastStepDirY: number = 0;
  private hasLastStepDir: boolean = false;
  private rawPrevX: number = 0;
  private rawPrevY: number = 0;
  private lastRawSampleX: number = 0;
  private lastRawSampleY: number = 0;
  private consecutiveReversals: number = 0;

  // High-frequency lateral twitch energy (decays rapidly; stays ~0 on smooth sine waves)
  private lateralSpikeEnergy: number = 0;
  // Short convergence boost after a true deliberate sharp corner (smooth pull instead of teleport)
  private cornerConvergeBoost: number = 0;

  // Pre-allocated pending corner sub-path plan (consumed by StrokePipeline for smooth convergence)
  private hasPendingCornerPlan: boolean = false;
  private pendingCornerPlan: CornerConvergencePlan = {
    startX: 0,
    startY: 0,
    apexX: 0,
    apexY: 0,
    targetX: 0,
    targetY: 0,
    totalDist: 0,
  };

  // Stabilizer level and screen-space total smoothing length (px)
  private stabilizerLevel: number = -1; // -1 = use config fallback
  private baseLengthPx: number = 0;

  // Single pre-allocated sample object for output to eliminate GC allocation
  private outputSample: StabilizedSample = {
    x: 0,
    y: 0,
    pressure: 0,
    vx: 0,
    vy: 0,
    speed: 0,
    timestamp: 0,
    isCorner: false,
  };

  private isStarted: boolean = false;
  private zoomScale: number = 1.0;
  private sharpCornersEnabled: boolean = true;
  private config: StabilizerConfig = { ...DEFAULT_STABILIZER_CONFIG };

  public configure(config: Partial<StabilizerConfig>): void {
    Object.assign(this.config, config);
  }

  public setZoomScale(zoom: number): void {
    if (Number.isFinite(zoom) && zoom > 0) {
      this.zoomScale = zoom;
    }
  }

  public setSharpCorners(enabled: boolean): void {
    this.sharpCornersEnabled = enabled;
  }

  public setStabilizerLevel(level: number): void {
    // level: 0 to 50 (CSP slider equivalent)
    const clamped = Math.max(0, Math.min(50, level));
    this.stabilizerLevel = clamped;
    if (clamped <= 0) {
      this.config.minCutoff = 100.0; // completely bypassed (0px lag)
      this.config.beta = 0.5;
      this.config.springMass = 0;
      this.baseLengthPx = 0;
    } else {
      const t = clamped / 50.0;
      // CSP-calibrated screen-space smoothing length (px):
      // level 1  -> ~4.0px continuous (~2-3px discrete)
      // level 10 -> ~9.0px
      // level 15 -> ~12.4px
      // level 18 -> ~14.7px (Real G-Pen default; tightens to ~9-11px when fast)
      // level 20 -> ~16.3px (G-Pen default; tightens to ~10-12px when fast)
      // level 50 -> 48.0px max (tightens to ~30-34px when fast)
      this.baseLengthPx = 3.5 + 23.5 * t + 21.0 * t * t;
      this.config.minCutoff = Math.max(0.8, 5.0 - t * 4.2);
      this.config.beta = Math.max(0.005, 0.025 - t * 0.018);
      this.config.springMass = 0;
    }
  }

  public reset(): void {
    this.filterPressure.reset();
    this.s1x = 0;
    this.s1y = 0;
    this.s2x = 0;
    this.s2y = 0;
    this.s3x = 0;
    this.s3y = 0;
    this.smX = 0;
    this.smY = 0;
    this.smVx = 0;
    this.smVy = 0;
    this.lastX = 0;
    this.lastY = 0;
    this.lastTime = 0;
    this.instantVx = 0;
    this.instantVy = 0;
    this.instantSpeed = 0;
    this.smoothedScreenSpeed = 0;
    this.prevDirX = 0;
    this.prevDirY = 0;
    this.hasPrevDir = false;
    this.lastStepDirX = 0;
    this.lastStepDirY = 0;
    this.hasLastStepDir = false;
    this.rawPrevX = 0;
    this.rawPrevY = 0;
    this.lastRawSampleX = 0;
    this.lastRawSampleY = 0;
    this.consecutiveReversals = 0;
    this.lateralSpikeEnergy = 0;
    this.cornerConvergeBoost = 0;
    this.hasPendingCornerPlan = false;
    this.isStarted = false;
  }

  public getLastSample(): Readonly<StabilizedSample> {
    return this.outputSample;
  }

  public resetPressureState(pressure: number, timestampMs: number): void {
    const clamped = Math.max(0, Math.min(1, pressure));
    this.filterPressure.setDirect(clamped, timestampMs);
  }

  /**
   * Returns the latest accepted raw pointer coordinate (in document space).
   */
  public getRawPosition(): { x: number; y: number } {
    return { x: this.lastRawSampleX, y: this.lastRawSampleY };
  }

  /**
   * Returns the true pen-lift target coordinate (rawX, rawY) plus the 1st-stage guide point (s1)
   * so StrokePipeline.finalizeStroke can smoothly close residual stabilizer lag all the way to
   * the true stylus liftoff coordinate without cutting strokes short.
   */
  public getCatchUpTarget(): { x: number; y: number; lagDist: number; midX: number; midY: number } {
    const lagDist = Math.hypot(this.lastRawSampleX - this.s3x, this.lastRawSampleY - this.s3y);
    return {
      x: this.lastRawSampleX,
      y: this.lastRawSampleY,
      lagDist,
      midX: this.s1x,
      midY: this.s1y,
    };
  }

  /**
   * Consumes any pending corner convergence sub-path produced by the latest process() call.
   * Allows StrokePipeline to emit short smooth sub-steps into a genuine sharp corner vertex
   * instead of jumping across lag in a single straight segment.
   */
  public consumeCornerPlan(): Readonly<CornerConvergencePlan> | null {
    if (!this.hasPendingCornerPlan) return null;
    this.hasPendingCornerPlan = false;
    return this.pendingCornerPlan;
  }

  /**
   * Synchronizes internal filter state after StrokePipeline finishes walking a smooth corner sub-path.
   */
  public settleAfterCornerSubPath(x: number, y: number): void {
    this.s1x = x;
    this.s1y = y;
    this.s2x = x;
    this.s2y = y;
    this.s3x = x;
    this.s3y = y;
    this.lastX = x;
    this.lastY = y;
    this.smX = x;
    this.smY = y;
    this.smVx = 0;
    this.smVy = 0;
    this.cornerConvergeBoost = 0;
  }

  private resolveEffectiveLengthPx(): number {
    if (this.stabilizerLevel === 0) return 0;
    if (this.stabilizerLevel > 0) return this.baseLengthPx;
    if (this.config.minCutoff >= 50.0) return 0;
    return Math.max(3.0, Math.min(48.0, 20.0 / Math.max(0.4, this.config.minCutoff)));
  }

  public process(
    rawX: number,
    rawY: number,
    rawPressure: number,
    timestampMs: number
  ): StabilizedSample {
    this.hasPendingCornerPlan = false;

    if (!this.isStarted) {
      this.reset();
      this.s1x = rawX;
      this.s1y = rawY;
      this.s2x = rawX;
      this.s2y = rawY;
      this.s3x = rawX;
      this.s3y = rawY;
      this.lastX = rawX;
      this.lastY = rawY;
      this.lastTime = timestampMs;
      this.rawPrevX = rawX;
      this.rawPrevY = rawY;
      this.lastRawSampleX = rawX;
      this.lastRawSampleY = rawY;
      this.smX = rawX;
      this.smY = rawY;
      this.smVx = 0;
      this.smVy = 0;
      this.isStarted = true;

      const fP = this.filterPressure.filter(
        rawPressure,
        timestampMs,
        this.config.attackCutoff,
        0.1,
        this.config.dCutoff
      );

      this.outputSample.x = rawX;
      this.outputSample.y = rawY;
      this.outputSample.pressure = fP;
      this.outputSample.vx = 0;
      this.outputSample.vy = 0;
      this.outputSample.speed = 0;
      this.outputSample.timestamp = timestampMs;
      this.outputSample.isCorner = false;
      return this.outputSample;
    }

    // 1. Monotonic continuous-time delta without drifting ahead of wall-clock timestamps
    const rawElapsedMs = timestampMs - this.lastTime;
    const stepDtMs = rawElapsedMs > 0.5 ? Math.min(50.0, rawElapsedMs) : 4.0;
    const dtSec = stepDtMs * 0.001;
    if (timestampMs > this.lastTime) {
      this.lastTime = timestampMs;
    }

    const clampedZoom = Math.max(0.15, Math.min(4.0, this.zoomScale));
    const stepRawDx = rawX - this.lastRawSampleX;
    const stepRawDy = rawY - this.lastRawSampleY;
    const stepRawDist = Math.hypot(stepRawDx, stepRawDy);
    const stepScreenDist = stepRawDist * clampedZoom;

    // 2. Targeted single-packet hardware backtrack spike guard:
    // Compares against the immediate previous step direction (NOT a 30px-stale chord) and
    // requires a large sudden reversal (>123 deg, >= 8 screen px) at high speed (>0.9 px/ms).
    // Legitimate tight curves and sine waves have smooth per-step turning (<45 deg) and are NEVER dropped.
    const baseLengthPx = this.resolveEffectiveLengthPx();
    if (
      baseLengthPx > 0 &&
      this.hasLastStepDir &&
      this.smoothedScreenSpeed > 0.9 &&
      stepScreenDist >= 8.0
    ) {
      const stepDot =
        (stepRawDx / stepRawDist) * this.lastStepDirX +
        (stepRawDy / stepRawDist) * this.lastStepDirY;
      if (stepDot < -0.55) {
        if (this.consecutiveReversals === 0) {
          this.consecutiveReversals = 1;
          const pressureDelta = rawPressure - this.filterPressure.getValue();
          const pCutoff = pressureDelta > 1e-4 ? this.config.attackCutoff : this.config.decayCutoff;
          const pBeta = pressureDelta > 1e-4 ? 0.2 : 0.01;
          const fP = this.filterPressure.filter(
            rawPressure,
            timestampMs,
            pCutoff,
            pBeta,
            this.config.dCutoff
          );
          this.outputSample.x = this.lastX;
          this.outputSample.y = this.lastY;
          this.outputSample.pressure = Math.max(0, Math.min(1, fP));
          this.outputSample.vx = this.instantVx;
          this.outputSample.vy = this.instantVy;
          this.outputSample.speed = this.instantSpeed;
          this.outputSample.timestamp = timestampMs;
          this.outputSample.isCorner = false;
          return this.outputSample;
        }
        this.consecutiveReversals++;
      } else {
        this.consecutiveReversals = 0;
      }
    } else if (stepScreenDist >= 1.0) {
      this.consecutiveReversals = 0;
    }

    const prevRawSampleX = this.lastRawSampleX;
    const prevRawSampleY = this.lastRawSampleY;
    this.lastRawSampleX = rawX;
    this.lastRawSampleY = rawY;

    // Smooth raw screen speed with 24ms time constant so packet-cadence jitter never spikes cutoff
    const instScreenSpeed = stepScreenDist / stepDtMs;
    const speedEmaAlpha = 1.0 - Math.exp(-stepDtMs / 24.0);
    this.smoothedScreenSpeed += speedEmaAlpha * (instScreenSpeed - this.smoothedScreenSpeed);

    // Measure instantaneous step direction & angular deflection vs immediately preceding step
    let stepDirX = this.lastStepDirX;
    let stepDirY = this.lastStepDirY;
    let instantStepAngle = 0;
    if (stepScreenDist >= 0.75) {
      stepDirX = stepRawDx / stepRawDist;
      stepDirY = stepRawDy / stepRawDist;
      if (this.hasLastStepDir) {
        const sDot = Math.max(
          -1.0,
          Math.min(1.0, this.lastStepDirX * stepDirX + this.lastStepDirY * stepDirY)
        );
        instantStepAngle = Math.acos(sDot);
      }
    }

    // Detect sudden high-speed lateral twitch impulses BEFORE updating prevDir
    // so a 1-2 sample twitch on a fast swoosh cannot corrupt the established stroke direction.
    const spikeDecay = Math.exp(-stepDtMs / 20.0);
    this.lateralSpikeEnergy *= spikeDecay;
    if (baseLengthPx > 0 && this.hasPrevDir && this.smoothedScreenSpeed > 1.35 && stepScreenDist >= 2.0) {
      const perpStepScreen = Math.abs(
        (-this.prevDirY * stepRawDx + this.prevDirX * stepRawDy) * clampedZoom
      );
      const perpErrScreen = Math.abs(
        (-this.prevDirY * (rawX - this.s3x) + this.prevDirX * (rawY - this.s3y)) * clampedZoom
      );
      // A smooth sine wave at 250Hz has small per-step lateral deviation (< 3px);
      // a fast muscle/hardware twitch jumps sharply sideways (> 5.5px) at high speed (> 1.35 px/ms).
      if (perpStepScreen > 5.5 && instantStepAngle > 0.55) {
        const impulse = Math.min(1.0, (perpStepScreen - 4.0) / 6.0);
        if (impulse > this.lateralSpikeEnergy) {
          this.lateralSpikeEnergy = impulse;
        }
      } else if (this.lateralSpikeEnergy > 0.2 && perpErrScreen > 6.5) {
        // Hold spike energy during a 2-sample twitch plateau while raw stays far off the established ray
        this.lateralSpikeEnergy = Math.max(this.lateralSpikeEnergy, 0.85);
      }
    }

    // 3. Deliberate Sharp Corner Detection (anti-sine-wave gated, NEVER hard-teleports s1/s2/s3):
    // Requires BOTH a sharp chord deflection (> cornerAngleThreshold) AND a sharp localized
    // per-step vertex turn (instantStepAngle > 55 deg) at deliberate speed (<= 1.35 px/ms)
    // so smooth sine waves and fast curves NEVER false-snap.
    const rawDx = rawX - this.rawPrevX;
    const rawDy = rawY - this.rawPrevY;
    const rawDist = Math.hypot(rawDx, rawDy);
    const minCornerChordScreen =
      8.0 + Math.min(20.0, Math.max(0, this.smoothedScreenSpeed - 0.8) * 10.0);
    const minCornerChord = minCornerChordScreen / clampedZoom;
    let isCorner = false;

    if (rawDist >= minCornerChord && this.lateralSpikeEnergy <= 0.25) {
      const curDirX = rawDx / rawDist;
      const curDirY = rawDy / rawDist;

      if (this.hasPrevDir && this.sharpCornersEnabled && baseLengthPx > 0) {
        const dot = Math.max(-1.0, Math.min(1.0, this.prevDirX * curDirX + this.prevDirY * curDirY));
        const chordAngle = Math.acos(dot);

        const isDeliberateSharpVertex =
          chordAngle > this.config.cornerAngleThreshold &&
          this.smoothedScreenSpeed <= 1.35 &&
          (instantStepAngle > 0.96 || (this.smoothedScreenSpeed <= 0.45 && chordAngle > 1.48 && instantStepAngle > 0.55));

        if (isDeliberateSharpVertex) {
          isCorner = true;
          this.cornerConvergeBoost = 1.0;
          const totalDist =
            Math.hypot(prevRawSampleX - this.s3x, prevRawSampleY - this.s3y) +
            Math.hypot(rawX - prevRawSampleX, rawY - prevRawSampleY);
          this.pendingCornerPlan.startX = this.s3x;
          this.pendingCornerPlan.startY = this.s3y;
          this.pendingCornerPlan.apexX = prevRawSampleX;
          this.pendingCornerPlan.apexY = prevRawSampleY;
          this.pendingCornerPlan.targetX = rawX;
          this.pendingCornerPlan.targetY = rawY;
          this.pendingCornerPlan.totalDist = totalDist;
          this.hasPendingCornerPlan = true;
        }
      }

      this.prevDirX = curDirX;
      this.prevDirY = curDirY;
      this.hasPrevDir = true;
      this.rawPrevX = rawX;
      this.rawPrevY = rawY;
    }

    if (stepScreenDist >= 0.75) {
      this.lastStepDirX = stepDirX;
      this.lastStepDirY = stepDirY;
      this.hasLastStepDir = true;
    }

    // 4. Low-Latency Velocity-Adaptive Isotropic 3-Stage Filtering
    let fX: number;
    let fY: number;
    const residualDist = Math.hypot(rawX - this.s3x, rawY - this.s3y);

    if (baseLengthPx <= 0) {
      fX = rawX;
      fY = rawY;
      this.s1x = rawX;
      this.s1y = rawY;
      this.s2x = rawX;
      this.s2y = rawY;
      this.s3x = rawX;
      this.s3y = rawY;
    } else if (!isCorner && stepRawDist < this.config.deadzone && residualDist < this.config.deadzone) {
      fX = this.lastX;
      fY = this.lastY;
    } else if (isCorner) {
      // Smoothly pull toward the corner apex and outgoing leg with a bounded per-step distance
      // (NEVER hard-teleport s1/s2/s3 across arbitrary lag in a single jump!)
      const maxCornerPullDoc = 12.0 / clampedZoom;
      const toApexX = prevRawSampleX - this.s3x;
      const toApexY = prevRawSampleY - this.s3y;
      const toApexDist = Math.hypot(toApexX, toApexY);

      if (toApexDist >= maxCornerPullDoc) {
        const frac = maxCornerPullDoc / toApexDist;
        this.s3x += toApexX * frac;
        this.s3y += toApexY * frac;
      } else {
        // Reach the apex, then spend remaining bounded pull budget along the outgoing leg
        this.s3x = prevRawSampleX;
        this.s3y = prevRawSampleY;
        const remaining = maxCornerPullDoc - toApexDist;
        const outDx = rawX - prevRawSampleX;
        const outDy = rawY - prevRawSampleY;
        const outDist = Math.hypot(outDx, outDy);
        if (outDist > 1e-4 && remaining > 0) {
          const outFrac = Math.min(1.0, remaining / outDist);
          this.s3x += outDx * outFrac;
          this.s3y += outDy * outFrac;
        }
      }

      // Gently align upstream stages between s3 and raw without teleporting past the corner
      this.s2x = this.s3x + (rawX - this.s3x) * 0.35;
      this.s2y = this.s3y + (rawY - this.s3y) * 0.35;
      this.s1x = this.s3x + (rawX - this.s3x) * 0.65;
      this.s1y = this.s3y + (rawY - this.s3y) * 0.65;
      this.smX = this.s3x;
      this.smY = this.s3y;
      this.smVx = 0;
      this.smVy = 0;
      fX = this.s3x;
      fY = this.s3y;
    } else {
      // Gently tighten lag on faster strokes for responsive CSP-like real-time feel
      const speedFactor = Math.max(
        0.58,
        1.0 / (1.0 + Math.max(0, this.smoothedScreenSpeed - 0.5) * 0.22)
      );
      // Smooth convergence boost right after a deliberate corner decays back to normal
      const cornerFactor = 1.0 - 0.55 * this.cornerConvergeBoost;
      this.cornerConvergeBoost *= Math.exp(-stepDtMs / 22.0);
      if (this.cornerConvergeBoost < 0.02) this.cornerConvergeBoost = 0;

      const effectiveLengthPx = baseLengthPx * speedFactor * cornerFactor;

      // Prevent sudden perpendicular twitch spikes from inflating spatial alpha along the stroke
      let effectiveStepPx = stepScreenDist;
      if (this.hasPrevDir && stepScreenDist > 0.01) {
        const dsForward = Math.max(
          0,
          (stepRawDx * this.prevDirX + stepRawDy * this.prevDirY) * clampedZoom
        );
        effectiveStepPx = Math.min(
          stepScreenDist,
          Math.max(dsForward, 0.35 * stepScreenDist)
        );
      }

      const stageLengthPx = Math.max(0.4, effectiveLengthPx / 3.0);
      const alphaAlong = 1.0 - Math.exp(-effectiveStepPx / stageLengthPx);

      if (this.lateralSpikeEnergy > 0.05 && this.hasPrevDir) {
        // Rotation-invariant Frenet-frame lateral spike damping:
        // Keeps tangent lag crisp while strongly attenuating sudden 1-2 packet sideways twitches.
        const tx = this.prevDirX;
        const ty = this.prevDirY;
        const nx = -ty;
        const ny = tx;
        const perpStageLen = stageLengthPx * (1.0 + 5.8 * this.lateralSpikeEnergy);
        const alphaPerp = 1.0 - Math.exp(-effectiveStepPx / perpStageLen);

        const advanceStage = (
          sx: number,
          sy: number,
          targetX: number,
          targetY: number
        ): [number, number] => {
          const ex = targetX - sx;
          const ey = targetY - sy;
          const eAlong = ex * tx + ey * ty;
          const ePerp = ex * nx + ey * ny;
          const dAlong = alphaAlong * eAlong;
          const dPerp = alphaPerp * ePerp;
          return [sx + dAlong * tx + dPerp * nx, sy + dAlong * ty + dPerp * ny];
        };

        [this.s1x, this.s1y] = advanceStage(this.s1x, this.s1y, rawX, rawY);
        [this.s2x, this.s2y] = advanceStage(this.s2x, this.s2y, this.s1x, this.s1y);
        [this.s3x, this.s3y] = advanceStage(this.s3x, this.s3y, this.s2x, this.s2y);
      } else {
        // Pure isotropic 3-stage exponential cascade (identical scalar alpha for X and Y)
        this.s1x += alphaAlong * (rawX - this.s1x);
        this.s1y += alphaAlong * (rawY - this.s1y);
        this.s2x += alphaAlong * (this.s1x - this.s2x);
        this.s2y += alphaAlong * (this.s1y - this.s2y);
        this.s3x += alphaAlong * (this.s2x - this.s3x);
        this.s3y += alphaAlong * (this.s2y - this.s3y);
      }

      fX = this.s3x;
      fY = this.s3y;
    }

    // 5. Asymmetric Pressure Filtering (Fast Attack, Critically Damped Decay)
    // Compare target rawPressure against the current filtered pressure (not lastRawPressure)
    // so constant or plateaued high pressure stays in fast attackCutoff until it converges!
    const pressureDelta = rawPressure - this.filterPressure.getValue();
    const pCutoff = pressureDelta > 1e-4 ? this.config.attackCutoff : this.config.decayCutoff;
    const pBeta = pressureDelta > 1e-4 ? 0.2 : 0.01;
    const fP = this.filterPressure.filter(rawPressure, timestampMs, pCutoff, pBeta, this.config.dCutoff);

    // 6. Optional Mass-Spring-Damper Simulation (only when explicitly configured via configure())
    if (this.config.springMass > 0 && !isCorner) {
      const k = this.config.springStiffness;
      const c = this.config.springDamping;
      const m = this.config.springMass;

      const effectiveDamping = Math.max(c * 0.35, c / (1.0 + this.smoothedScreenSpeed * 0.5));

      const disX = fX - this.smX;
      const disY = fY - this.smY;

      const ax = (k * disX - effectiveDamping * this.smVx) / m;
      const ay = (k * disY - effectiveDamping * this.smVy) / m;

      this.smVx += ax * dtSec;
      this.smVy += ay * dtSec;
      this.smX += this.smVx * dtSec;
      this.smY += this.smVy * dtSec;

      fX = this.smX;
      fY = this.smY;
    }

    // Velocity computation in px / ms
    const dx = fX - this.lastX;
    const dy = fY - this.lastY;
    const dist = Math.hypot(dx, dy);

    this.instantVx = dx / stepDtMs;
    this.instantVy = dy / stepDtMs;
    this.instantSpeed = dist / stepDtMs;

    this.lastX = fX;
    this.lastY = fY;

    this.outputSample.x = fX;
    this.outputSample.y = fY;
    this.outputSample.pressure = Math.max(0, Math.min(1, fP));
    this.outputSample.vx = this.instantVx;
    this.outputSample.vy = this.instantVy;
    this.outputSample.speed = this.instantSpeed;
    this.outputSample.timestamp = timestampMs;
    this.outputSample.isCorner = isCorner;

    return this.outputSample;
  }
}
