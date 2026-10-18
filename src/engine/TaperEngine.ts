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
  deadzone: 0.02,
  gamma: 1.85,
  midpoint: 0.45,
  minPressure: 0.005,
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

    // Piecewise cubic Hermite transfer curve with matched slopes
    if (u <= 0.15) {
      // Zone 1: Hairline zone [0.0, 0.15] -> [pMin, 0.18]
      // Quadratic-cubic ease-in
      const t = u / 0.15;
      const curve = t * t * (1.5 - 0.5 * t);
      return pMin + (0.18 - pMin) * curve;
    } else if (u <= 0.70) {
      // Zone 2: Stable controllable body [0.15, 0.70] -> [0.18, 0.72]
      const t = (u - 0.15) / 0.55;
      // Gentle linear-smooth slope
      return 0.18 + (0.72 - 0.18) * t;
    } else {
      // Zone 3: Saturated expansion [0.70, 1.00] -> [0.72, 1.00]
      const t = Math.max(0, Math.min(1.0, (u - 0.70) / 0.30));
      // Cubic ease-out acceleration to maximum saturated weight
      const easeOut = 1.0 - Math.pow(Math.max(0, 1.0 - t), 2.5);
      return 0.72 + (1.00 - 0.72) * easeOut;
    }
  }

  /**
   * Smooths pressure along arc length independently of coordinate filtering
   * to eliminate bumpy / sausage-like stroke artifacts.
   */
  public smoothPressure(currentMappedPressure: number): number {
    const idx = this.pressureHistoryCount % this.pressureHistory.length;
    this.pressureHistory[idx] = currentMappedPressure;
    this.pressureHistoryCount++;

    const sampleCount = Math.min(this.pressureHistoryCount, this.pressureHistory.length);
    let sum = 0;
    let weightSum = 0;

    for (let i = 0; i < sampleCount; i++) {
      const w = 1.0 + i * 0.4;
      sum += this.pressureHistory[i] * w;
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
    exitVx: number, // px / ms
    exitVy: number, // px / ms
    lastTimestampMs: number
  ): { points: ExtrapolatedPoint[]; count: number } {
    const exitSpeed = Math.hypot(exitVx, exitVy); // px / ms

    if (exitSpeed < this.fConfig.minFlickSpeed || lastWidth <= 0.4) {
      return { points: this.flickPointPool, count: 0 };
    }

    const dirX = exitVx / exitSpeed;
    const dirY = exitVy / exitSpeed;

    const count = Math.min(this.fConfig.flickPoints, this.flickPointPool.length);
    let curX = lastX;
    let curY = lastY;
    let curSpeed = exitSpeed;
    let curTime = lastTimestampMs;

    const dt = this.fConfig.stepDtMs;
    const lambda = this.fConfig.decayRate;

    for (let i = 0; i < count; i++) {
      // Inertial damping on velocity: v(t) = v0 * exp(-drag * t)
      const dragFactor = Math.exp(-this.fConfig.dragCoefficient * (dt * 0.05));
      curSpeed *= dragFactor;
      const stepDist = curSpeed * dt;

      curX += dirX * stepDist;
      curY += dirY * stepDist;
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
