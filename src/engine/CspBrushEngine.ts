/**
 * CspBrushEngine.ts
 * Authentic Clip Studio Paint (CSP) Brush Mathematics & Zero-Allocation Dynamics Engine.
 *
 * Implements:
 * 1. O(1) Precompiled Monotone Cubic Hermite (PCHIP) Spline Curve LUTs (256-entry Float32Array, zero GC).
 * 2. Zero-Closure Deterministic Hash PRNG for live/bake-identical scatter, jitter, and multi-tip selection.
 * 3. Multi-Sensor CSP Effector Matrix (Pressure x Tilt x Velocity x Random with independent min-floors & curves).
 * 4. Ellipse-Aware Directional Spacing (eliminates Venetian-blind gaps on flat/calligraphic nibs).
 * 5. CSP "Adjust Brush Density by Gap" (gap-invariant Beer-Lambert optical transmittance).
 * 6. 4-Stage CSP Anti-Aliasing (None/Binary, Weak, Medium, Strong) + 2D Sub-Pixel Hairline Coverage.
 * 7. 5-Mode CSP Paper Texture Physics (Multiply, Subtract/Valley-Fill, Compare, Overlay, Outline).
 * 8. Corner-Preserving CSP Post-Correction (Levels 1-5) & Stroke-Silhouette Watercolor Edge Filter.
 */

import {
  Point,
  CspSensorConfig,
  CspPaperTextureMode,
  CspTipFlipMode,
} from '../types/editor';

const LUT_SIZE = 256;
const LUT_MAX_IDX = LUT_SIZE - 1;
const curveWeakCache = new WeakMap<readonly [number, number][], Float32Array>();
const curveStringCache = new Map<string, Float32Array>();
const MAX_STRING_CURVE_CACHE = 128;

/**
 * Compiles a CSP control-point array [[x0,y0], [x1,y1], ...] into a 256-sample Float32Array LUT
 * using Fritsch-Carlson Monotone Piecewise Cubic Hermite Interpolation (PCHIP).
 */
export function getCompiledCurveLut(curve?: readonly [number, number][]): Float32Array | null {
  if (!curve || curve.length === 0) return null;

  const weakHit = curveWeakCache.get(curve);
  if (weakHit) return weakHit;

  let key = '';
  for (let i = 0; i < curve.length; i++) {
    key += `${curve[i][0].toFixed(4)},${curve[i][1].toFixed(4)};`;
  }
  const strHit = curveStringCache.get(key);
  if (strHit) {
    curveWeakCache.set(curve, strHit);
    return strHit;
  }

  const lut = new Float32Array(LUT_SIZE);
  const pts = curve.slice().sort((a, b) => a[0] - b[0]);
  const dedup: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] - dedup[dedup.length - 1][0] > 1e-5) {
      dedup.push(pts[i]);
    }
  }

  const n = dedup.length;
  if (n === 1) {
    const val = Math.max(0, Math.min(1, dedup[0][1]));
    lut.fill(val);
  } else if (n === 2) {
    const [x0, y0] = dedup[0];
    const [x1, y1] = dedup[1];
    const span = Math.max(1e-5, x1 - x0);
    for (let s = 0; s < LUT_SIZE; s++) {
      const x = s / LUT_MAX_IDX;
      if (x <= x0) lut[s] = Math.max(0, Math.min(1, y0));
      else if (x >= x1) lut[s] = Math.max(0, Math.min(1, y1));
      else {
        const t = (x - x0) / span;
        lut[s] = Math.max(0, Math.min(1, y0 + t * (y1 - y0)));
      }
    }
  } else {
    const deltas = new Float64Array(n - 1);
    const m = new Float64Array(n);
    for (let k = 0; k < n - 1; k++) {
      deltas[k] = (dedup[k + 1][1] - dedup[k][1]) / Math.max(1e-5, dedup[k + 1][0] - dedup[k][0]);
    }
    m[0] = deltas[0];
    for (let k = 1; k < n - 1; k++) {
      if (deltas[k - 1] * deltas[k] <= 0) {
        m[k] = 0;
      } else {
        m[k] = (deltas[k - 1] + deltas[k]) * 0.5;
      }
    }
    m[n - 1] = deltas[n - 2];

    for (let k = 0; k < n - 1; k++) {
      const dk = deltas[k];
      if (Math.abs(dk) < 1e-6) {
        m[k] = 0;
        m[k + 1] = 0;
      } else {
        const alpha = m[k] / dk;
        const beta = m[k + 1] / dk;
        const sumSq = alpha * alpha + beta * beta;
        if (sumSq > 9) {
          const tau = 3 / Math.sqrt(sumSq);
          m[k] = tau * alpha * dk;
          m[k + 1] = tau * beta * dk;
        }
      }
    }

    let segIdx = 0;
    for (let s = 0; s < LUT_SIZE; s++) {
      const x = s / LUT_MAX_IDX;
      if (x <= dedup[0][0]) {
        lut[s] = Math.max(0, Math.min(1, dedup[0][1]));
        continue;
      }
      if (x >= dedup[n - 1][0]) {
        lut[s] = Math.max(0, Math.min(1, dedup[n - 1][1]));
        continue;
      }
      while (segIdx < n - 2 && x > dedup[segIdx + 1][0]) {
        segIdx++;
      }
      const x0 = dedup[segIdx][0];
      const y0 = dedup[segIdx][1];
      const x1 = dedup[segIdx + 1][0];
      const y1 = dedup[segIdx + 1][1];
      const h = Math.max(1e-5, x1 - x0);
      const t = (x - x0) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const y = h00 * y0 + h10 * h * m[segIdx] + h01 * y1 + h11 * h * m[segIdx + 1];
      lut[s] = Math.max(0, Math.min(1, y));
    }
  }

  if (curveStringCache.size >= MAX_STRING_CURVE_CACHE) {
    const oldest = curveStringCache.keys().next().value;
    if (oldest !== undefined) curveStringCache.delete(oldest);
  }
  curveStringCache.set(key, lut);
  curveWeakCache.set(curve, lut);
  return lut;
}

/**
 * Evaluates a CSP spline curve in O(1) time with zero allocations.
 */
export function evaluateFastSpline(x: number, curve?: readonly [number, number][]): number {
  const clamped = x <= 0 ? 0 : x >= 1 ? 1 : x;
  if (!curve || curve.length === 0) return clamped;
  const lut = getCompiledCurveLut(curve);
  if (!lut) return clamped;

  const pos = clamped * LUT_MAX_IDX;
  const idx = pos | 0;
  if (idx >= LUT_MAX_IDX) return lut[LUT_MAX_IDX];
  const frac = pos - idx;
  return lut[idx] + (lut[idx + 1] - lut[idx]) * frac;
}

/**
 * Zero-closure deterministic 32-bit integer hash returning [0, 1).
 * Guarantees identical dab scatter/jitter/sub-tip order between live preview and stroke commit.
 */
export function dabHashFloat(x: number, y: number, dabIndex: number, salt: number): number {
  const ix = (x * 100) | 0;
  const iy = (y * 100) | 0;
  let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(dabIndex + 1, 83492791) ^ Math.imul(salt + 1, 0x9e3779b9)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Evaluates a CSP multi-sensor dynamic multiplier in [0, 1].
 * Follows Clip Studio Paint's exact multiplicative sensor law:
 *   factor = pFactor * tFactor * vFactor * rFactor
 */
export function evaluateCspSensor(
  sensor: CspSensorConfig | undefined,
  pressure: number,
  tiltMagnitude: number, // [0, 1] where 0 = upright, 1 = flat horizontal
  speedPxPerMs: number,  // stylus speed in px/ms
  randomVal: number      // deterministic [0, 1)
): number {
  if (!sensor) return 1.0;

  let factor = 1.0;

  if (sensor.usePressure) {
    const pMin = Math.max(0, Math.min(1, sensor.pressureMin ?? 0));
    const curvedP = sensor.pressureCurve
      ? evaluateFastSpline(pressure, sensor.pressureCurve)
      : Math.max(0, Math.min(1, pressure));
    factor *= pMin + (1.0 - pMin) * curvedP;
  }

  if (sensor.useTilt) {
    const tMin = Math.max(0, Math.min(1, sensor.tiltMin ?? 0));
    const clampedTilt = Math.max(0, Math.min(1, tiltMagnitude));
    factor *= tMin + (1.0 - tMin) * clampedTilt;
  }

  if (sensor.useVelocity) {
    const vMin = Math.max(0, Math.min(1, sensor.velocityMin ?? 0));
    // Normalize speed: 3.5 px/ms (~3500 px/s) maps to full velocity 1.0
    const vNorm = Math.max(0, Math.min(1, speedPxPerMs / 3.5));
    const vVal = sensor.invertVelocity !== false ? 1.0 - vNorm : vNorm;
    factor *= vMin + (1.0 - vMin) * vVal;
  }

  if (sensor.useRandom) {
    const rMin = Math.max(0, Math.min(1, sensor.randomMin ?? 0));
    factor *= rMin + (1.0 - rMin) * Math.max(0, Math.min(1, randomVal));
  }

  return Math.max(0, Math.min(1, factor));
}

/**
 * Computes ellipse-aware step distance along the local stroke tangent.
 * Prevents discrete "Venetian blind" stamp gaps when drawing perpendicular to a flat/calligraphic brush's thin axis.
 */
export function computeEllipticalStepDistance(
  width: number,
  height: number,
  dabAngleRad: number,
  tangentDx: number,
  tangentDy: number,
  spacingRatio: number,
  minStepPx: number = 0.12
): number {
  const ratio = Math.max(0.01, Math.min(2.0, spacingRatio));
  const w = Math.max(0.1, width);
  const h = Math.max(0.1, height);

  // Fast isotropic path for round tips
  if (Math.abs(w - h) < 1e-2) {
    return Math.max(minStepPx, w * ratio);
  }

  const tLen = Math.hypot(tangentDx, tangentDy);
  if (tLen < 1e-4) {
    return Math.max(minStepPx, Math.min(w, h) * ratio);
  }

  // Project tangent unit vector into the rotated ellipse's local frame
  const ux = tangentDx / tLen;
  const uy = tangentDy / tLen;
  const cosA = Math.cos(dabAngleRad);
  const sinA = Math.sin(dabAngleRad);
  const localX = ux * cosA + uy * sinA;
  const localY = -ux * sinA + uy * cosA;

  // Support diameter of ellipse (w, h) along direction (localX, localY)
  const denom = Math.hypot(localX / w, localY / h);
  const effectiveDiameter = denom > 1e-5 ? 1.0 / denom : Math.min(w, h);
  return Math.max(minStepPx, effectiveDiameter * ratio);
}

/**
 * CSP "Adjust brush density by gap":
 * Compensates dab alpha using Beer-Lambert transmittance law so changing spacing
 * preserves perceived stroke optical density and prevents 8-bit Mach-band rings.
 */
export function computeGapAdjustedAlpha(
  baseAlpha: number,
  spacingRatio: number,
  adjustByGap: boolean = false,
  referenceSpacing: number = 0.08
): number {
  const a = Math.max(0, Math.min(1, baseAlpha));
  if (!adjustByGap || a >= 0.998 || a <= 0.001) return a;
  const ratio = Math.max(0.12, Math.min(4.0, spacingRatio / Math.max(0.01, referenceSpacing)));
  return Math.max(0.002, Math.min(1.0, 1.0 - Math.pow(1.0 - a, ratio)));
}

/**
 * Computes exact 2D sub-pixel area conservation for ultra-fine manga hairlines (< 1.0px).
 * Prevents sub-pixel widths/heights from bloating to 1.25px or flickering.
 */
export function computeSubpixelDabDimensions(
  width: number,
  height: number,
  alpha: number,
  minRenderDim: number = 0.75
): { renderW: number; renderH: number; effAlpha: number } {
  const renderW = Math.max(minRenderDim, width);
  const renderH = Math.max(minRenderDim, height);
  if (width >= minRenderDim && height >= minRenderDim) {
    return { renderW, renderH, effAlpha: alpha };
  }
  const scaleW = width < minRenderDim ? Math.max(0.04, width / renderW) : 1.0;
  const scaleH = height < minRenderDim ? Math.max(0.04, height / renderH) : 1.0;
  return {
    renderW,
    renderH,
    effAlpha: Math.max(0.003, Math.min(1.0, alpha * scaleW * scaleH)),
  };
}

/**
 * Maps CSP 4-level Anti-Aliasing setting (0: None, 1: Weak, 2: Medium, 3: Strong)
 * into feather width in pixels.
 */
export function getCspAntiAliasFeather(antiAlias: number = 2): number {
  switch (antiAlias) {
    case 0:
      return 0.0; // Binary 1-bit crisp threshold
    case 1:
      return 0.65; // Weak (sharp manga pen)
    case 3:
      return 1.95; // Strong (silky illustration pen)
    case 2:
    default:
      return 1.15; // Medium (standard CSP G-Pen)
  }
}

/**
 * Resolves horizontal/vertical flip signs (+1 or -1) for a dab according to CSP Tip Flip mode.
 */
export function resolveTipFlipSigns(
  flipH: CspTipFlipMode | undefined,
  flipV: CspTipFlipMode | undefined,
  dabSeq: number,
  x: number,
  y: number
): { signX: number; signY: number } {
  let signX = 1;
  let signY = 1;
  if (flipH === 'alternate') {
    signX = (dabSeq & 1) === 0 ? 1 : -1;
  } else if (flipH === 'random') {
    signX = dabHashFloat(x, y, dabSeq, 71) < 0.5 ? 1 : -1;
  }
  if (flipV === 'alternate') {
    signY = (dabSeq & 1) === 0 ? 1 : -1;
  } else if (flipV === 'random') {
    signY = dabHashFloat(x, y, dabSeq, 73) < 0.5 ? 1 : -1;
  }
  return { signX, signY };
}

/**
 * Evaluates CSP 5-mode Paper Texture modulation on dab alpha:
 * - multiply: tipAlpha * grain
 * - subtract: max(0, tipAlpha - (1 - grain) * density) [CSP classic valley-fill with pressure!]
 * - compare: tipAlpha >= (1 - grain) ? tipAlpha : 0
 * - overlay: contrast-preserving texture tooth
 * - outline: accentuates texture contours along dab edges
 */
export function applyCspPaperTextureAlpha(
  tipAlpha: number,
  grainNorm: number, // [0, 1] raw paper height
  textureDensity: number, // [0, 1]
  pressure: number, // [0, 1]
  mode: CspPaperTextureMode = 'subtract',
  brightness: number = 0, // [-100, 100]
  contrast: number = 0,   // [-100, 100]
  inverted: boolean = false
): number {
  if (textureDensity <= 0.001 || tipAlpha <= 0.001) return tipAlpha;

  let g = inverted ? 1.0 - grainNorm : grainNorm;
  if (brightness !== 0) {
    g += brightness / 100.0;
  }
  if (contrast !== 0) {
    const cFactor = Math.pow((contrast + 100.0) / 100.0, 2);
    g = (g - 0.5) * cFactor + 0.5;
  }
  g = Math.max(0, Math.min(1, g));

  //Stylus pressure pushes pigment deeper into paper valleys
  const penetration = Math.max(0, Math.min(0.85, pressure * 0.65));
  const effDensity = textureDensity * (1.0 - penetration * 0.6);

  switch (mode) {
    case 'multiply': {
      const m = 1.0 - effDensity * (1.0 - g);
      return Math.max(0, Math.min(1, tipAlpha * m));
    }
    case 'subtract': {
      const sub = (1.0 - g) * effDensity;
      return Math.max(0, Math.min(1, tipAlpha - sub * (1.0 - penetration * 0.5)));
    }
    case 'compare': {
      const thresh = (1.0 - g) * effDensity;
      return tipAlpha > thresh ? Math.min(1, (tipAlpha - thresh) / Math.max(0.08, 1.0 - thresh)) : 0;
    }
    case 'overlay': {
      const ov = tipAlpha < 0.5
        ? 2.0 * tipAlpha * g
        : 1.0 - 2.0 * (1.0 - tipAlpha) * (1.0 - g);
      return Math.max(0, Math.min(1, tipAlpha + (ov - tipAlpha) * effDensity));
    }
    case 'outline': {
      const edgeFactor = 4.0 * tipAlpha * (1.0 - tipAlpha);
      return Math.max(0, Math.min(1, tipAlpha * (1.0 - effDensity * (1.0 - g) * (0.35 + 0.65 * edgeFactor))));
    }
    default:
      return tipAlpha;
  }
}

/**
 * Applies Clip Studio Paint Post-Correction (levels 1..5) to a finished stroke's knot array,
 * smoothing micro-wobble while strictly preserving endpoints and sharp corner vertices (isCorner).
 */
export function applyCspPostCorrection(
  points: Point[],
  level: number = 0,
  preserveSharpCorners: boolean = true
): Point[] {
  const passes = Math.max(0, Math.min(5, Math.round(level)));
  if (passes <= 0 || points.length < 4) return points;

  let current = points.map((p) => ({ ...p }));
  const next = points.map((p) => ({ ...p }));

  for (let pass = 0; pass < passes; pass++) {
    const n = current.length;
    next[0] = { ...current[0] };
    next[n - 1] = { ...current[n - 1] };

    for (let i = 1; i < n - 1; i++) {
      const cur = current[i];
      if (preserveSharpCorners && cur.isCorner) {
        next[i] = { ...cur };
        continue;
      }
      const prev = current[i - 1];
      const nxt = current[i + 1];

      // Check local angle so deliberate acute corners (< 115 deg) aren't rounded off
      if (preserveSharpCorners) {
        const ax = cur.x - prev.x;
        const ay = cur.y - prev.y;
        const bx = nxt.x - cur.x;
        const by = nxt.y - cur.y;
        const la = Math.hypot(ax, ay);
        const lb = Math.hypot(bx, by);
        if (la > 1.5 && lb > 1.5) {
          const cos = (ax * bx + ay * by) / (la * lb);
          if (cos < 0.35) {
            next[i] = { ...cur };
            continue;
          }
        }
      }

      // [0.25, 0.50, 0.25] zero-phase Gaussian smoothing kernel
      next[i] = {
        ...cur,
        x: prev.x * 0.25 + cur.x * 0.5 + nxt.x * 0.25,
        y: prev.y * 0.25 + cur.y * 0.5 + nxt.y * 0.25,
        width: prev.width * 0.2 + cur.width * 0.6 + nxt.width * 0.2,
        pressure: prev.pressure * 0.2 + cur.pressure * 0.6 + nxt.pressure * 0.2,
      };
    }

    for (let i = 0; i < n; i++) {
      current[i] = next[i];
    }
  }

  return current;
}

/**
 * Applies authentic Clip Studio Paint Stroke-Perimeter Watercolor Edge ("Water Edge")
 * onto an isolated stroke ImageData buffer before compositing onto the canvas layer.
 * Produces capillary pigment accumulation & darkening ONLY at the outer silhouette of the entire stroke
 * (eliminating internal fish-scale dab rings!).
 */
export function applyCspWatercolorEdge(
  strokeImageData: { data: Uint8ClampedArray; width: number; height: number },
  wetEdge: number,
  radiusPx: number = 2.5,
  alphaPower: number = 0.65,
  valuePower: number = 0.55
): void {
  if (wetEdge <= 0.01) return;
  const { data, width, height } = strokeImageData;
  if (width < 3 || height < 3) return;

  const strength = Math.max(0, Math.min(1, wetEdge));
  const r = Math.max(1, Math.min(8, Math.round(radiusPx)));
  const totalPixels = width * height;

  // Separable box-blur of stroke alpha channel to detect silhouette boundary gradient
  const alphaOrig = new Float32Array(totalPixels);
  const alphaTemp = new Float32Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    alphaOrig[i] = data[i * 4 + 3] / 255.0;
  }

  // Horizontal pass
  const invKernel = 1.0 / (2 * r + 1);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = alphaOrig[row] * (r + 1);
    for (let k = 1; k <= r; k++) {
      sum += alphaOrig[row + Math.min(width - 1, k)];
    }
    for (let x = 0; x < width; x++) {
      alphaTemp[row + x] = sum * invKernel;
      const leftIdx = Math.max(0, x - r);
      const rightIdx = Math.min(width - 1, x + r + 1);
      sum += alphaOrig[row + rightIdx] - alphaOrig[row + leftIdx];
    }
  }

  // Vertical pass + capillary rim modulation
  const aBoost = strength * (0.45 + alphaPower * 1.15);
  const vDarken = strength * (0.25 + valuePower * 0.55);

  for (let x = 0; x < width; x++) {
    let sum = alphaTemp[x] * (r + 1);
    for (let k = 1; k <= r; k++) {
      sum += alphaTemp[Math.min(height - 1, k) * width + x];
    }
    for (let y = 0; y < height; y++) {
      const idx = y * width + x;
      const blurredA = sum * invKernel;
      const origA = alphaOrig[idx];

      if (origA > 0.015) {
        // Rim is high where pixel is inside the stroke (origA > 0) but near transparent exterior (origA > blurredA)
        const rim = Math.max(0, origA - blurredA) * 2.4;
        if (rim > 0.01) {
          const p = idx * 4;
          const darkScale = Math.max(0.18, 1.0 - rim * vDarken);
          data[p] = Math.round(data[p] * darkScale);
          data[p + 1] = Math.round(data[p + 1] * darkScale);
          data[p + 2] = Math.round(data[p + 2] * darkScale);
          const nextA = Math.min(1.0, origA * (1.0 + rim * aBoost));
          data[p + 3] = Math.round(nextA * 255);
        }
      }

      const topIdx = Math.max(0, y - r);
      const botIdx = Math.min(height - 1, y + r + 1);
      sum += alphaTemp[botIdx * width + x] - alphaTemp[topIdx * width + x];
    }
  }
}

/**
 * Built-in CSP Pressure Curve Presets for quick 1-click studio switching.
 */
export const CSP_PRESSURE_CURVE_PRESETS: Record<string, { label: string; points: [number, number][] }> = {
  linear: {
    label: 'Linear',
    points: [
      [0, 0],
      [1, 1],
    ],
  },
  'g-pen': {
    label: 'G-Pen S-Curve',
    points: [
      [0, 0],
      [0.2, 0.08],
      [0.55, 0.52],
      [0.82, 0.88],
      [1, 1],
    ],
  },
  soft: {
    label: 'Soft Touch',
    points: [
      [0, 0],
      [0.25, 0.48],
      [0.65, 0.84],
      [1, 1],
    ],
  },
  firm: {
    label: 'Firm Nib',
    points: [
      [0, 0],
      [0.35, 0.12],
      [0.7, 0.48],
      [1, 1],
    ],
  },
  chisel: {
    label: 'Steep Threshold',
    points: [
      [0, 0],
      [0.15, 0.03],
      [0.45, 0.72],
      [1, 1],
    ],
  },
};
