/**
 * TaperEngine.ts
 * Japanese G-Pen S-curve pressure response (0-15% hairlines, 15-70% stable, 70-100% expansion),
 * arc-length pressure smoothing, and exponential ballistic flick release (Iri-Nuki).
 */

export interface PressureConfig {
  deadzone: number;    // Activation deadzone [0.0, 0.15] (default 0.02)
  gamma: number;       // S-curve curvature steepness [1.0, 3.5] (default 1.85)
  midpoint: number;    // Inflection midpoint [0.1, 0.9] (default 0.45)
  minPressure: number; // Lowest mapped non-zero pressure (hairline limit, default 0.005)
}

export interface FlickConfig {
  minFlickSpeed: number; // Velocity threshold to trigger flick (px / ms, default ~0.70)
  flickPoints: number;   // Number of extrapolated knots (6 - 12, default 8)
  decayRate: number;     // Exponential radius attenuation constant lambda (default 0.40)
  dragCoefficient: number; // Inertial velocity decay (default 0.22)
  stepDtMs: number;      // Extrapolation time step in ms (default 8.0)
}

export const DEFAULT_PRESSURE_CONFIG: PressureConfig = {
  deadzone: 0.005,
  gamma: 1.85,
  midpoint: 0.45,
  minPressure: 0.012,
};

export const DEFAULT_FLICK_CONFIG: FlickConfig = {
  minFlickSpeed: 0.70,
  flickPoints: 8,
  decayRate: 0.42,
  dragCoefficient: 0.22,
  stepDtMs: 8.0,
};

export interface ExtrapolatedPoint {
  x: number;
  y: number;
  pressure: number;
  width: number;
  alpha: number;
  timestamp: number;
}

export class TaperEngine {
  private pConfig: PressureConfig = { ...DEFAULT_PRESSURE_CONFIG };
  private fConfig: FlickConfig = { ...DEFAULT_FLICK_CONFIG };

  // Arc-length pressure smoothing ring buffer
  private pressureHistory: Float32Array = new Float32Array(8);
  private pressureHistoryCount: number = 0;

  // Pre-allocated array of extrapolated flick points to avoid GC allocation
  private flickPointPool: ExtrapolatedPoint[] = Array.from({ length: 16 }, () => ({
    x: 0,
    y: 0,
    pressure: 0,
    width: 0,
    alpha: 1.0,
    timestamp: 0,
  }));

  public configure(pressure?: Partial<PressureConfig>, flick?: Partial<FlickConfig>): void {
    if (pressure) Object.assign(this.pConfig, pressure);
    if (flick) Object.assign(this.fConfig, flick);
  }

  public reset(): void {
    this.pressureHistoryCount = 0;
  }

  /**
   * Applies Japanese G-Pen 3-stage cubic S-curve transfer function:
   *  - 0% - 15%: Hairline zone for delicate detailing and hatching
   *  - 15% - 70%: Stable, highly controllable line weight zone
   *  - 70% - 100%: Saturated, authoritative line expansion zone
   */
  public mapPressure(rawPressure: number): number {
    if (rawPressure <= this.pConfig.deadzone) {
      return 0.0;
    }

    // Remap [deadzone, 1.0] -> [0.0, 1.0]
    const pNorm = (rawPressure - this.pConfig.deadzone) / (1.0 - this.pConfig.deadzone);
    const u = Math.max(0, Math.min(1, pNorm));
    const pMin = this.pConfig.minPressure;

    // C1-continuous piecewise cubic Hermite transfer curve with matched derivatives at knots
    const evalHermite = (t: number, h: number, y0: number, y1: number, m0: number, m1: number): number => {
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
      const h10 = t3 - 2.0 * t2 + t;
      const h01 = -2.0 * t3 + 3.0 * t2;
      const h11 = t3 - t2;
      return h00 * y0 + h10 * (h * m0) + h01 * y1 + h11 * (h * m1);
    };

    const y1 = 0.145;
    const y2 = 0.685;
    const m0 = 0.15;
    const m1 = 0.98;
    const m2 = 1.05;
    const m3 = 0.55;

    if (u <= 0.15) {
      // Zone 1: Hairline zone [0.0, 0.15] -> [pMin, 0.145]
      return evalHermite(u / 0.15, 0.15, pMin, y1, m0, m1);
    } else if (u <= 0.70) {
      // Zone 2: Stable controllable body [0.15, 0.70] -> [0.145, 0.685]
      return evalHermite((u - 0.15) / 0.55, 0.55, y1, y2, m1, m2);
    } else {
      // Zone 3: Saturated expansion [0.70, 1.00] -> [0.685, 1.00]
      return evalHermite(Math.min(1.0, (u - 0.70) / 0.30), 0.30, y2, 1.0, m2, m3);
    }
  }

  /**
   * Smooths pressure along arc length independently of coordinate filtering
   * to eliminate bumpy / sausage-like stroke artifacts.
   */
  public smoothPressure(currentMappedPressure: number): number {
    const len = this.pressureHistory.length;
    const idx = this.pressureHistoryCount % len;
    this.pressureHistory[idx] = currentMappedPressure;
    this.pressureHistoryCount++;

    const sampleCount = Math.min(this.pressureHistoryCount, len);
    const startIdx = this.pressureHistoryCount - sampleCount;
    let sum = 0;
    let weightSum = 0;

    for (let i = 0; i < sampleCount; i++) {
      const ringIdx = (startIdx + i) % len;
      const w = 1.0 + i * 0.4;
      sum += this.pressureHistory[ringIdx] * w;
      weightSum += w;
    }

    return sum / weightSum;
  }

  /**
   * Procedurally extrapolates decaying points upon stylus liftoff (pointerup)
   * if exit velocity exceeds the flick threshold.
   * Synthesizes exponential decaying tail: w(k) = w0 * e^(-lambda * k), alpha(k) -> 0
   * Prevents blunt chopped stubs and produces organic, razor-sharp hairlines (Iri-Nuki).
   */
  public computeFlickTaper(
    lastX: number,
    lastY: number,
    lastWidth: number,
    lastPressure: number,
    exitVx: number, // doc px / ms
    exitVy: number, // doc px / ms
    lastTimestampMs: number,
    angularVelRadPerMs: number = 0,
    zoomScale: number = 1.0,
    maxTailLengthDoc?: number
  ): { points: ExtrapolatedPoint[]; count: number } {
    const exitSpeed = Math.hypot(exitVx, exitVy); // doc px / ms
    const safeZoom = Number.isFinite(zoomScale) && zoomScale > 0 ? zoomScale : 1.0;
    // Normalize velocity to screen space so zoomed-out high-DPI canvases (e.g. 6071x8598 at 0.1x)
    // do not false-trigger flick extrapolation on normal hand speed.
    const screenSpeed = exitSpeed * safeZoom;

    if (screenSpeed < this.fConfig.minFlickSpeed || lastWidth <= 0.4) {
      return { points: this.flickPointPool, count: 0 };
    }

    let curAngle = Math.atan2(exitVy, exitVx);
    const clampedOmega = Math.max(-0.012, Math.min(0.012, angularVelRadPerMs));

    const count = Math.min(this.fConfig.flickPoints, this.flickPointPool.length);
    const dt = this.fConfig.stepDtMs;
    const lambda = this.fConfig.decayRate;
    const dragFactor = Math.exp(-this.fConfig.dragCoefficient * (dt * 0.05));

    // Compute natural extrapolated length and clamp tightly so tips never shoot past liftoff
    let rawTotalDist = 0;
    let simSpeed = exitSpeed;
    for (let i = 0; i < count; i++) {
      simSpeed *= dragFactor;
      rawTotalDist += simSpeed * dt;
    }
    const defaultMaxTail = Math.min(
      Math.max(lastWidth * 1.25, 3.0),
      14.0 / Math.max(0.05, safeZoom)
    );
    const maxTail = maxTailLengthDoc !== undefined ? Math.max(0, maxTailLengthDoc) : defaultMaxTail;
    const distScale = rawTotalDist > maxTail && rawTotalDist > 1e-6 ? maxTail / rawTotalDist : 1.0;

    let curX = lastX;
    let curY = lastY;
    let curSpeed = exitSpeed * distScale;
    let curTime = lastTimestampMs;

    for (let i = 0; i < count; i++) {
      // Inertial damping on velocity & gentle curvature continuation (prevents linear kinks on curved flicks)
      curSpeed *= dragFactor;
      curAngle += clampedOmega * dt * Math.exp(-0.22 * i);
      const stepDist = curSpeed * dt;

      curX += Math.cos(curAngle) * stepDist;
      curY += Math.sin(curAngle) * stepDist;
      curTime += dt;

      // Exponential attenuation of radius: w(k) = w0 * exp(-lambda * (k + 1))
      const k = i + 1;
      const decayFactor = Math.exp(-lambda * k);
      const curWidth = Math.max(0.1, lastWidth * decayFactor);
      const curPressure = Math.max(0.001, lastPressure * decayFactor);
      // Alpha decays smoothly to 0 at the tail tip
      const curAlpha = Math.max(0.0, 1.0 - (k / (count + 1)));

      const pt = this.flickPointPool[i];
      pt.x = curX;
      pt.y = curY;
      pt.width = curWidth;
      pt.pressure = curPressure;
      pt.alpha = curAlpha;
      pt.timestamp = curTime;
    }

    return { points: this.flickPointPool, count };
  }
}
