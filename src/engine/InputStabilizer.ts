/**
 * InputStabilizer.ts
 * Low-latency 1-Euro Filter + Velocity Tracker + Mass-Spring-Damper.
 * Pre-allocated memory structures, zero GC pauses during active drawing.
 * Upgraded with:
 *  - Critical Angle Detection (Corner Snapping, DeltaTheta > 45 deg)
 *  - Velocity-Adaptive Damping Scaling
 *  - Asymmetric Attack / Decay Pressure Filtering
 */

export interface StabilizerConfig {
  minCutoff: number; // fc_min (Hz): lower = smoother slow movements (default ~1.0)
  beta: number;      // beta: speed coefficient; higher = less lag on flicks (default ~0.02)
  dCutoff: number;   // d_cutoff (Hz): cutoff for derivative filtering (default ~1.0)
  deadzone: number;  // Minimum delta distance (px) to register movement
  springMass: number; // Mass for virtual pull-string / spring-damper (0 = disabled)
  springStiffness: number; // Spring stiffness k
  springDamping: number;   // Damping coefficient c (critically damped: 2 * sqrt(k * m))
  cornerAngleThreshold: number; // Angular deflection threshold in radians (default 45 deg = 0.785398)
  attackCutoff: number; // Pressure attack cutoff Hz (instant contact)
  decayCutoff: number;  // Pressure decay cutoff Hz (smooth release)
}

export const DEFAULT_STABILIZER_CONFIG: StabilizerConfig = {
  minCutoff: 1.5,
  beta: 0.03,
  dCutoff: 1.0,
  deadzone: 0.1,
  springMass: 0,
  springStiffness: 180,
  springDamping: 26.8,
  cornerAngleThreshold: 0.785398, // 45 degrees
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
    // Synthesize monotonic 4ms (250Hz) sub-step when hardware coalesced events share identical timestamps
    const effectiveMs = rawElapsedMs <= 0.5 ? 4.0 : rawElapsedMs;
    const dt = Math.max(0.002, effectiveMs * 0.001);
    this.tPrev = rawElapsedMs <= 0.5 ? this.tPrev + 4.0 : Math.max(this.tPrev, timestampMs);
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

export class InputStabilizer {
  private filterX = new OneEuroAxis();
  private filterY = new OneEuroAxis();
  private filterPressure = new OneEuroAxis();

  // Asymmetric pressure tracker
  private lastRawPressure: number = 0;

  // Mass-Spring-Damper simulation state
  private smX: number = 0;
  private smY: number = 0;
  private smVx: number = 0;
  private smVy: number = 0;

  // Velocity tracker state
  private lastX: number = 0;
  private lastY: number = 0;
  private lastTime: number = 0;
  private instantVx: number = 0;
  private instantVy: number = 0;
  private instantSpeed: number = 0;

  // Direction vector history for Corner Snapping (Critical Angle Detection)
  private prevDirX: number = 0;
  private prevDirY: number = 0;
  private hasPrevDir: boolean = false;
  private rawPrevX: number = 0;
  private rawPrevY: number = 0;
  private lastRawSampleX: number = 0;
  private lastRawSampleY: number = 0;

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
    if (level <= 0) {
      this.config.minCutoff = 100.0; // effectively bypassed
      this.config.beta = 0.5;
      this.config.springMass = 0;
    } else {
      // Pure unconditionally stable 1-Euro adaptive curve (Clip Studio Paint style)
      const t = Math.min(1.0, level / 50.0);
      this.config.minCutoff = Math.max(0.45, 5.0 - t * 4.55); // 5.0 -> 0.45 Hz
      this.config.beta = Math.max(0.005, 0.055 - t * 0.048);  // 0.055 -> 0.007
      this.config.springMass = 0; // Pure 1-Euro without oscillating spring artifacts
    }
  }

  public reset(): void {
    this.filterX.reset();
    this.filterY.reset();
    this.filterPressure.reset();
    this.lastRawPressure = 0;
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
    this.prevDirX = 0;
    this.prevDirY = 0;
    this.hasPrevDir = false;
    this.rawPrevX = 0;
    this.rawPrevY = 0;
    this.lastRawSampleX = 0;
    this.lastRawSampleY = 0;
    this.isStarted = false;
  }

  public getLastSample(): Readonly<StabilizedSample> {
    return this.outputSample;
  }

  public process(
    rawX: number,
    rawY: number,
    rawPressure: number,
    timestampMs: number
  ): StabilizedSample {
    if (!this.isStarted) {
      this.reset();
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
      this.lastRawPressure = rawPressure;
      this.isStarted = true;

      const fX = this.filterX.filter(rawX, timestampMs, this.config.minCutoff, this.config.beta, this.config.dCutoff);
      const fY = this.filterY.filter(rawY, timestampMs, this.config.minCutoff, this.config.beta, this.config.dCutoff);
      const fP = this.filterPressure.filter(rawPressure, timestampMs, this.config.attackCutoff, 0.1, this.config.dCutoff);

      this.outputSample.x = fX;
      this.outputSample.y = fY;
      this.outputSample.pressure = fP;
      this.outputSample.vx = 0;
      this.outputSample.vy = 0;
      this.outputSample.speed = 0;
      this.outputSample.timestamp = timestampMs;
      this.outputSample.isCorner = false;
      return this.outputSample;
    }

    const dtMs = Math.max(1, timestampMs - this.lastTime);
    const dtSec = dtMs * 0.001;

    const stepRawDx = rawX - this.lastRawSampleX;
    const stepRawDy = rawY - this.lastRawSampleY;
    const stepRawDist = Math.hypot(stepRawDx, stepRawDy);
    this.lastRawSampleX = rawX;
    this.lastRawSampleY = rawY;

    // 1. Zoom-Aware Critical Angle Detection (Corner Snapping)
    // Screen-space 6px chord threshold prevents zoomed-out 600 DPI canvases from false-snapping on 1px hand tremor
    const rawDx = rawX - this.rawPrevX;
    const rawDy = rawY - this.rawPrevY;
    const rawDist = Math.hypot(rawDx, rawDy);
    const minCornerChord = 6.0 / Math.max(0.15, Math.min(4.0, this.zoomScale));
    let isCorner = false;

    if (rawDist >= minCornerChord) {
      const curDirX = rawDx / rawDist;
      const curDirY = rawDy / rawDist;

      if (this.hasPrevDir && this.sharpCornersEnabled) {
        // Dot product between consecutive motion vectors
        const dot = Math.max(-1.0, Math.min(1.0, this.prevDirX * curDirX + this.prevDirY * curDirY));
        const angle = Math.acos(dot);

        // If angular deflection exceeds critical angle threshold (default 45 deg)
        if (angle > this.config.cornerAngleThreshold) {
          isCorner = true;
          // Immediately reset filter tension and mass-spring inertia to sharp vertex coordinate
          this.filterX.setDirect(rawX, timestampMs);
          this.filterY.setDirect(rawY, timestampMs);
          this.smX = rawX;
          this.smY = rawY;
          this.smVx = 0;
          this.smVy = 0;
        }
      }

      this.prevDirX = curDirX;
      this.prevDirY = curDirY;
      this.hasPrevDir = true;
      this.rawPrevX = rawX;
      this.rawPrevY = rawY;
    }

    // 2. Velocity-Adaptive Damping Scaling (screen-normalized speed, smooth saturation so fast arcs stay silky)
    const screenSpeed = (stepRawDist * Math.max(0.15, Math.min(4.0, this.zoomScale))) / dtMs; // screen px / ms
    const speedBoost = Math.min(6.0, screenSpeed * 2.2);
    const dynamicMinCutoff = this.config.minCutoff * (1.0 + speedBoost);
    const dynamicBeta = this.config.beta * (1.0 + speedBoost * 0.35);

    // 3. Coordinate Filtering with sub-pixel deadzone suppression
    let fX: number;
    let fY: number;
    if (isCorner) {
      fX = rawX;
      fY = rawY;
    } else if (stepRawDist < this.config.deadzone && this.config.minCutoff < 50.0) {
      fX = this.lastX;
      fY = this.lastY;
    } else {
      fX = this.filterX.filter(rawX, timestampMs, dynamicMinCutoff, dynamicBeta, this.config.dCutoff);
      fY = this.filterY.filter(rawY, timestampMs, dynamicMinCutoff, dynamicBeta, this.config.dCutoff);
    }

    // 4. Asymmetric Pressure Filtering (Fast Attack, Critically Damped Decay)
    const pressureDelta = rawPressure - this.lastRawPressure;
    this.lastRawPressure = rawPressure;
    const pCutoff = pressureDelta > 0 ? this.config.attackCutoff : this.config.decayCutoff;
    const pBeta = pressureDelta > 0 ? 0.2 : 0.01;
    const fP = this.filterPressure.filter(rawPressure, timestampMs, pCutoff, pBeta, this.config.dCutoff);

    // 5. Mass-Spring-Damper Simulation (when enabled for stabilizer > 15)
    if (this.config.springMass > 0 && !isCorner) {
      const k = this.config.springStiffness;
      const c = this.config.springDamping;
      const m = this.config.springMass;

      // Dynamic damping reduction on fast flicks
      const effectiveDamping = Math.max(c * 0.35, c / (1.0 + screenSpeed * 0.5));

      const disX = fX - this.smX;
      const disY = fY - this.smY;

      const ax = (k * disX - effectiveDamping * this.smVx) / m;
      const ay = (k * disY - effectiveDamping * this.smVy) / m;

      // Semi-implicit Euler integration
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

    this.instantVx = dx / dtMs;
    this.instantVy = dy / dtMs;
    this.instantSpeed = dist / dtMs;

    this.lastX = fX;
    this.lastY = fY;
    this.lastTime = timestampMs;

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
