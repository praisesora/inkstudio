import {
  CanvasSelection,
  AdjustmentLayerData,
  ToneCurvePoints,
  GradientStop,
  ColorBalanceAdjustmentData,
} from '../types/editor';

export type TonalCorrectionType =
  | 'brightness-contrast'
  | 'binarization'
  | 'hue-saturation'
  | 'posterization'
  | 'level-correction'
  | 'reverse-gradient';

export interface BrightnessContrastParams {
  brightness: number; // -100 to +100
  contrast: number;   // -100 to +100
}

export interface BinarizationParams {
  threshold: number;  // 1 to 255
}

export interface HueSaturationParams {
  hue: number;        // -180 to +180
  saturation: number; // -100 to +100
  luminosity: number; // -100 to +100
}

export interface PosterizationParams {
  levels: number;     // 2 to 32
}

export interface LevelCorrectionParams {
  channel: 'rgb' | 'r' | 'g' | 'b';
  inputMin: number;   // 0 to 253
  gamma: number;      // 0.1 to 9.99
  inputMax: number;   // 2 to 255
  outputMin: number;  // 0 to 255
  outputMax: number;  // 0 to 255
}

export interface ProcessingBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Creates an ultra-fast 1-byte lookup mask for active selection.
 * Returns null if no selection is active (meaning full canvas is processed).
 */
export function createSelectionMask(
  selection: CanvasSelection | null,
  width: number,
  height: number
): Uint8Array | null {
  if (!selection) return null;

  if (selection.mask && selection.maskWidth === width && selection.maskHeight === height) {
    const mask = new Uint8Array(width * height);
    const src = selection.mask;
    for (let i = 0; i < src.length; i++) {
      if (src[i] >= 64) mask[i] = 1;
    }
    return mask;
  }

  const mask = new Uint8Array(width * height);
  const { bounds, type, polygon } = selection;

  if (type === 'rect') {
    const x0 = Math.max(0, Math.floor(bounds.x));
    const y0 = Math.max(0, Math.floor(bounds.y));
    const x1 = Math.min(width, Math.ceil(bounds.x + bounds.width));
    const y1 = Math.min(height, Math.ceil(bounds.y + bounds.height));

    for (let y = y0; y < y1; y++) {
      const rowOffset = y * width;
      mask.fill(1, rowOffset + x0, rowOffset + x1);
    }
    return mask;
  }

  if (type === 'lasso' && polygon && polygon.length >= 3) {
    const offCanvas = document.createElement('canvas');
    offCanvas.width = width;
    offCanvas.height = height;
    const ctx = offCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.beginPath();
    ctx.moveTo(polygon[0].x, polygon[0].y);
    for (let i = 1; i < polygon.length; i++) {
      ctx.lineTo(polygon[i].x, polygon[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    const imgData = ctx.getImageData(0, 0, width, height);
    const d = imgData.data;
    const totalPixels = width * height;
    for (let i = 0; i < totalPixels; i++) {
      if (d[i * 4 + 3] > 64) {
        mask[i] = 1;
      }
    }
    return mask;
  }

  return null;
}

/**
 * Computes coordinate boundaries clamped to image dimensions.
 */
export function getProcessingBounds(
  selection: CanvasSelection | null,
  width: number,
  height: number
): ProcessingBounds {
  if (!selection) {
    return { x0: 0, y0: 0, x1: width, y1: height };
  }

  const { bounds } = selection;
  return {
    x0: Math.max(0, Math.floor(bounds.x)),
    y0: Math.max(0, Math.floor(bounds.y)),
    x1: Math.min(width, Math.ceil(bounds.x + bounds.width)),
    y1: Math.min(height, Math.ceil(bounds.y + bounds.height)),
  };
}

/**
 * Precomputes 256-entry LUT for Brightness/Contrast.
 */
export function buildBrightnessContrastLut(brightness: number, contrast: number): Uint8Array {
  const lut = new Uint8Array(256);
  const factor =
    contrast >= 0
      ? (259 * (contrast * 2.55 + 255)) / (255 * (259 - contrast * 2.55))
      : 1 + contrast / 100;
  const bShift = brightness * 2.55;

  for (let i = 0; i < 256; i++) {
    const val = 128 + factor * (i - 128) + bShift;
    lut[i] = Math.max(0, Math.min(255, Math.round(val)));
  }
  return lut;
}

/**
 * Precomputes 256-entry LUT for Posterization.
 */
export function buildPosterizeLut(levels: number): Uint8Array {
  const lut = new Uint8Array(256);
  const numSteps = Math.max(2, Math.min(32, Math.round(levels))) - 1;
  const stepSize = 255 / numSteps;
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.max(0, Math.min(255, Math.round(Math.round(i / stepSize) * stepSize)));
  }
  return lut;
}

/**
 * Precomputes 256-entry LUT for Level Correction.
 */
export function buildLevelsLut(
  inputMin: number,
  inputMax: number,
  gamma: number,
  outputMin: number,
  outputMax: number
): Uint8Array {
  const lut = new Uint8Array(256);
  const inRange = Math.max(1, inputMax - inputMin);
  const outRange = outputMax - outputMin;
  const safeGamma = Math.max(0.1, Math.min(9.99, gamma));
  const invGamma = 1 / safeGamma;

  for (let i = 0; i < 256; i++) {
    let norm = (i - inputMin) / inRange;
    norm = Math.max(0, Math.min(1, norm));
    norm = Math.pow(norm, invGamma);
    const val = outputMin + norm * outRange;
    lut[i] = Math.max(0, Math.min(255, Math.round(val)));
  }
  return lut;
}

/**
 * Computes 256-bin histogram from image data.
 */
export function computeHistogram(
  imageData: ImageData,
  channel: 'rgb' | 'r' | 'g' | 'b' = 'rgb',
  mask: Uint8Array | null = null
): Uint32Array {
  const counts = new Uint32Array(256);
  const d = imageData.data;
  const totalPixels = imageData.width * imageData.height;

  for (let p = 0; p < totalPixels; p++) {
    if (mask && !mask[p]) continue;
    const i = p * 4;
    if (d[i + 3] === 0) continue; // Skip transparent

    if (channel === 'r') {
      counts[d[i]]++;
    } else if (channel === 'g') {
      counts[d[i + 1]]++;
    } else if (channel === 'b') {
      counts[d[i + 2]]++;
    } else {
      // Perceptual luminance (BT.601)
      const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114 + 500) / 1000 | 0;
      counts[lum]++;
    }
  }
  return counts;
}

/**
 * Applies Brightness/Contrast adjustment.
 */
export function applyBrightnessContrast(
  src: ImageData,
  dst: ImageData,
  brightness: number,
  contrast: number,
  mask: Uint8Array | null,
  bounds: ProcessingBounds
): void {
  const lut = buildBrightnessContrastLut(brightness, contrast);
  const s = src.data;
  const d = dst.data;
  const width = src.width;

  const { x0, y0, x1, y1 } = bounds;
  for (let y = y0; y < y1; y++) {
    const rowOffset = y * width;
    for (let x = x0; x < x1; x++) {
      const pIdx = rowOffset + x;
      if (mask && !mask[pIdx]) continue;
      const i = pIdx * 4;
      if (s[i + 3] === 0) continue;

      d[i] = lut[s[i]];
      d[i + 1] = lut[s[i + 1]];
      d[i + 2] = lut[s[i + 2]];
      d[i + 3] = s[i + 3];
    }
  }
}

/**
 * Applies Binarization (Threshold).
 */
export function applyBinarization(
  src: ImageData,
  dst: ImageData,
  threshold: number,
  mask: Uint8Array | null,
  bounds: ProcessingBounds
): void {
  const s = src.data;
  const d = dst.data;
  const width = src.width;
  const t = Math.max(1, Math.min(255, Math.round(threshold)));

  const { x0, y0, x1, y1 } = bounds;
  for (let y = y0; y < y1; y++) {
    const rowOffset = y * width;
    for (let x = x0; x < x1; x++) {
      const pIdx = rowOffset + x;
      if (mask && !mask[pIdx]) continue;
      const i = pIdx * 4;
      if (s[i + 3] === 0) continue;

      const lum = (s[i] * 299 + s[i + 1] * 587 + s[i + 2] * 114 + 500) / 1000 | 0;
      const val = lum >= t ? 255 : 0;
      d[i] = val;
      d[i + 1] = val;
      d[i + 2] = val;
      d[i + 3] = s[i + 3];
    }
  }
}

// Inline HSL conversion helpers
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const diff = max - min;
    s = l > 0.5 ? diff / (2 - max - min) : diff / (max + min);
    switch (max) {
      case r:
        h = (g - b) / diff + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / diff + 2;
        break;
      case b:
        h = (r - g) / diff + 4;
        break;
    }
    h /= 6;
  }
  return [h * 360, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  h /= 360;
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * Applies Hue / Saturation / Luminosity.
 */
export function applyHueSaturation(
  src: ImageData,
  dst: ImageData,
  hue: number,
  saturation: number,
  luminosity: number,
  mask: Uint8Array | null,
  bounds: ProcessingBounds
): void {
  const s = src.data;
  const d = dst.data;
  const width = src.width;

  const satFactor = saturation / 100;
  const lumFactor = luminosity / 100;

  const { x0, y0, x1, y1 } = bounds;
  for (let y = y0; y < y1; y++) {
    const rowOffset = y * width;
    for (let x = x0; x < x1; x++) {
      const pIdx = rowOffset + x;
      if (mask && !mask[pIdx]) continue;
      const i = pIdx * 4;
      if (s[i + 3] === 0) continue;

      let [h, sat, lum] = rgbToHsl(s[i], s[i + 1], s[i + 2]);

      // Hue rotation
      h = (h + hue + 360) % 360;

      // Saturation scaling
      if (satFactor > 0) {
        sat = sat + (1 - sat) * satFactor;
      } else {
        sat = sat * (1 + satFactor);
      }
      sat = Math.max(0, Math.min(1, sat));

      // Luminosity scaling
      if (lumFactor > 0) {
        lum = lum + (1 - lum) * lumFactor;
      } else {
        lum = lum * (1 + lumFactor);
      }
      lum = Math.max(0, Math.min(1, lum));

      const [nr, ng, nb] = hslToRgb(h, sat, lum);
      d[i] = nr;
      d[i + 1] = ng;
      d[i + 2] = nb;
      d[i + 3] = s[i + 3];
    }
  }
}

/**
 * Applies Posterization.
 */
export function applyPosterization(
  src: ImageData,
  dst: ImageData,
  levels: number,
  mask: Uint8Array | null,
  bounds: ProcessingBounds
): void {
  const lut = buildPosterizeLut(levels);
  const s = src.data;
  const d = dst.data;
  const width = src.width;

  const { x0, y0, x1, y1 } = bounds;
  for (let y = y0; y < y1; y++) {
    const rowOffset = y * width;
    for (let x = x0; x < x1; x++) {
      const pIdx = rowOffset + x;
      if (mask && !mask[pIdx]) continue;
      const i = pIdx * 4;
      if (s[i + 3] === 0) continue;

      d[i] = lut[s[i]];
      d[i + 1] = lut[s[i + 1]];
      d[i + 2] = lut[s[i + 2]];
      d[i + 3] = s[i + 3];
    }
  }
}

/**
 * Applies Reverse Gradient (Color Inversion).
 */
export function applyReverseGradient(
  src: ImageData,
  dst: ImageData,
  mask: Uint8Array | null,
  bounds: ProcessingBounds
): void {
  const s = src.data;
  const d = dst.data;
  const width = src.width;

  const { x0, y0, x1, y1 } = bounds;
  for (let y = y0; y < y1; y++) {
    const rowOffset = y * width;
    for (let x = x0; x < x1; x++) {
      const pIdx = rowOffset + x;
      if (mask && !mask[pIdx]) continue;
      const i = pIdx * 4;
      if (s[i + 3] === 0) continue;

      d[i] = 255 - s[i];
      d[i + 1] = 255 - s[i + 1];
      d[i + 2] = 255 - s[i + 2];
      d[i + 3] = s[i + 3];
    }
  }
}

/**
 * Applies Level Correction.
 */
export function applyLevelCorrection(
  src: ImageData,
  dst: ImageData,
  params: LevelCorrectionParams,
  mask: Uint8Array | null,
  bounds: ProcessingBounds
): void {
  const { channel, inputMin, inputMax, gamma, outputMin, outputMax } = params;
  const lut = buildLevelsLut(inputMin, inputMax, gamma, outputMin, outputMax);
  const s = src.data;
  const d = dst.data;
  const width = src.width;

  const { x0, y0, x1, y1 } = bounds;
  for (let y = y0; y < y1; y++) {
    const rowOffset = y * width;
    for (let x = x0; x < x1; x++) {
      const pIdx = rowOffset + x;
      if (mask && !mask[pIdx]) continue;
      const i = pIdx * 4;
      if (s[i + 3] === 0) continue;

      if (channel === 'rgb') {
        d[i] = lut[s[i]];
        d[i + 1] = lut[s[i + 1]];
        d[i + 2] = lut[s[i + 2]];
      } else if (channel === 'r') {
        d[i] = lut[s[i]];
      } else if (channel === 'g') {
        d[i + 1] = lut[s[i + 1]];
      } else if (channel === 'b') {
        d[i + 2] = lut[s[i + 2]];
      }
      d[i + 3] = s[i + 3];
    }
  }
}

/**
 * Universal dispatcher for all tonal filters.
 */
export function applyTonalFilter(
  src: ImageData,
  dst: ImageData,
  type: TonalCorrectionType,
  params: any,
  mask: Uint8Array | null,
  bounds: ProcessingBounds
): void {
  // Initialize destination with source data first
  dst.data.set(src.data);

  switch (type) {
    case 'brightness-contrast': {
      const p = params as BrightnessContrastParams;
      applyBrightnessContrast(src, dst, p.brightness, p.contrast, mask, bounds);
      break;
    }
    case 'binarization': {
      const p = params as BinarizationParams;
      applyBinarization(src, dst, p.threshold, mask, bounds);
      break;
    }
    case 'hue-saturation': {
      const p = params as HueSaturationParams;
      applyHueSaturation(src, dst, p.hue, p.saturation, p.luminosity, mask, bounds);
      break;
    }
    case 'posterization': {
      const p = params as PosterizationParams;
      applyPosterization(src, dst, p.levels, mask, bounds);
      break;
    }
    case 'level-correction': {
      const p = params as LevelCorrectionParams;
      applyLevelCorrection(src, dst, p, mask, bounds);
      break;
    }
    case 'reverse-gradient': {
      applyReverseGradient(src, dst, mask, bounds);
      break;
    }
  }
}

/**
 * Builds a monotonic cubic spline lookup table (256 entries) using Fritsch-Carlson algorithm.
 * Guarantees zero overshoot and strictly preserves monotonicity of control points.
 */
export function buildMonotonicCubicSplineLut(points: [number, number][]): Uint8Array {
  const lut = new Uint8Array(256);
  if (!points || points.length === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }

  // Sort by X coordinate and remove duplicates
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const unique: [number, number][] = [];
  for (const pt of sorted) {
    if (unique.length > 0 && unique[unique.length - 1][0] === pt[0]) {
      unique[unique.length - 1] = pt; // replace duplicate with later one
    } else {
      unique.push([pt[0], pt[1]]);
    }
  }

  const n = unique.length;
  if (n === 1) {
    const val = Math.max(0, Math.min(255, Math.round(unique[0][1])));
    lut.fill(val);
    return lut;
  }

  // Secants Delta_k
  const deltas = new Float64Array(n - 1);
  for (let k = 0; k < n - 1; k++) {
    const dx = unique[k + 1][0] - unique[k][0];
    const dy = unique[k + 1][1] - unique[k][1];
    deltas[k] = dx === 0 ? 0 : dy / dx;
  }

  // Initial tangents m_k
  const m = new Float64Array(n);
  m[0] = deltas[0];
  m[n - 1] = deltas[n - 2];
  for (let k = 1; k < n - 1; k++) {
    m[k] = (deltas[k - 1] + deltas[k]) / 2;
  }

  // Fritsch-Carlson monotonicity condition
  for (let k = 0; k < n - 1; k++) {
    if (deltas[k] === 0) {
      m[k] = 0;
      m[k + 1] = 0;
    } else {
      const alpha = m[k] / deltas[k];
      const beta = m[k + 1] / deltas[k];
      if (alpha < 0) m[k] = 0;
      if (beta < 0) m[k + 1] = 0;
      const hypSq = alpha * alpha + beta * beta;
      if (hypSq > 9) {
        const tau = 3 / Math.sqrt(hypSq);
        m[k] = tau * alpha * deltas[k];
        m[k + 1] = tau * beta * deltas[k];
      }
    }
  }

  // Sample Hermite cubic spline for x = 0..255
  for (let x = 0; x < 256; x++) {
    if (x <= unique[0][0]) {
      lut[x] = Math.max(0, Math.min(255, Math.round(unique[0][1])));
      continue;
    }
    if (x >= unique[n - 1][0]) {
      lut[x] = Math.max(0, Math.min(255, Math.round(unique[n - 1][1])));
      continue;
    }

    // Locate segment
    let k = 0;
    while (k < n - 1 && x > unique[k + 1][0]) {
      k++;
    }

    const x0 = unique[k][0];
    const x1 = unique[k + 1][0];
    const y0 = unique[k][1];
    const y1 = unique[k + 1][1];
    const h = x1 - x0;
    const t = h === 0 ? 0 : (x - x0) / h;
    const t2 = t * t;
    const t3 = t2 * t;

    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    const y = h00 * y0 + h10 * h * m[k] + h01 * y1 + h11 * h * m[k + 1];
    lut[x] = Math.max(0, Math.min(255, Math.round(y)));
  }

  return lut;
}

/**
 * Combines channel curves (R, G, B) with Master RGB curve into unified 256-entry channel LUTs.
 */
export function buildCurvesCombinedLut(curveData: ToneCurvePoints): {
  rLut: Uint8Array;
  gLut: Uint8Array;
  bLut: Uint8Array;
} {
  const masterLut = buildMonotonicCubicSplineLut(curveData.rgb || [[0, 0], [255, 255]]);
  const rLutRaw = buildMonotonicCubicSplineLut(curveData.r || [[0, 0], [255, 255]]);
  const gLutRaw = buildMonotonicCubicSplineLut(curveData.g || [[0, 0], [255, 255]]);
  const bLutRaw = buildMonotonicCubicSplineLut(curveData.b || [[0, 0], [255, 255]]);

  const rLut = new Uint8Array(256);
  const gLut = new Uint8Array(256);
  const bLut = new Uint8Array(256);

  for (let i = 0; i < 256; i++) {
    rLut[i] = masterLut[rLutRaw[i]];
    gLut[i] = masterLut[gLutRaw[i]];
    bLut[i] = masterLut[bLutRaw[i]];
  }

  return { rLut, gLut, bLut };
}

/**
 * Parses hex color to RGB tuple [0-255].
 */
export function parseHexToRgb(hex: string): [number, number, number] {
  let clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean.split('').map((c) => c + c).join('');
  }
  const val = parseInt(clean, 16);
  if (isNaN(val)) return [0, 0, 0];
  return [(val >> 16) & 255, (val >> 8) & 255, val & 255];
}

/**
 * Precomputes 256-entry RGBA LUT for Gradient Map.
 * Maps normalized luminosity [0, 1] through custom color stops.
 */
export function buildGradientMapLut(
  stops: GradientStop[],
  interpolation: 'linear' | 'smooth' = 'linear'
): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4); // RGBA format
  if (!stops || stops.length === 0) {
    // Default grayscale gradient
    for (let i = 0; i < 256; i++) {
      const offset = i * 4;
      lut[offset] = i;
      lut[offset + 1] = i;
      lut[offset + 2] = i;
      lut[offset + 3] = 255;
    }
    return lut;
  }

  const sorted = [...stops].sort((a, b) => a.position - b.position);
  const parsedStops = sorted.map((s) => ({
    pos: Math.max(0, Math.min(1, s.position)),
    rgb: parseHexToRgb(s.color),
  }));

  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const offset = i * 4;

    if (t <= parsedStops[0].pos) {
      const [r, g, b] = parsedStops[0].rgb;
      lut[offset] = r;
      lut[offset + 1] = g;
      lut[offset + 2] = b;
      lut[offset + 3] = 255;
      continue;
    }

    if (t >= parsedStops[parsedStops.length - 1].pos) {
      const [r, g, b] = parsedStops[parsedStops.length - 1].rgb;
      lut[offset] = r;
      lut[offset + 1] = g;
      lut[offset + 2] = b;
      lut[offset + 3] = 255;
      continue;
    }

    // Locate segment
    let sIdx = 0;
    while (sIdx < parsedStops.length - 1 && t > parsedStops[sIdx + 1].pos) {
      sIdx++;
    }

    const s0 = parsedStops[sIdx];
    const s1 = parsedStops[sIdx + 1];
    const span = s1.pos - s0.pos;
    let factor = span <= 0 ? 0 : (t - s0.pos) / span;

    if (interpolation === 'smooth') {
      factor = factor * factor * (3 - 2 * factor); // smoothstep
    }

    const r = Math.round(s0.rgb[0] + (s1.rgb[0] - s0.rgb[0]) * factor);
    const g = Math.round(s0.rgb[1] + (s1.rgb[1] - s0.rgb[1]) * factor);
    const b = Math.round(s0.rgb[2] + (s1.rgb[2] - s0.rgb[2]) * factor);

    lut[offset] = Math.max(0, Math.min(255, r));
    lut[offset + 1] = Math.max(0, Math.min(255, g));
    lut[offset + 2] = Math.max(0, Math.min(255, b));
    lut[offset + 3] = 255;
  }

  return lut;
}

/**
 * Applies Color Balance adjustment to a single RGB pixel.
 * Shadows, midtones, and highlights shifts for Cyan-Red, Magenta-Green, Yellow-Blue.
 */
export function evaluateColorBalancePixel(
  r: number,
  g: number,
  b: number,
  params: ColorBalanceAdjustmentData
): [number, number, number] {
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

  // Weight curves: shadows peak at 0, midtones peak at 0.5, highlights peak at 1
  const wShad = Math.pow(Math.max(0, 1.0 - lum * 2.0), 2);
  const wHigh = Math.pow(Math.max(0, lum * 2.0 - 1.0), 2);
  const wMid = Math.max(0, 1.0 - wShad - wHigh);

  const deltaR = (params.shadows[0] * wShad + params.midtones[0] * wMid + params.highlights[0] * wHigh) * 1.28;
  const deltaG = (params.shadows[1] * wShad + params.midtones[1] * wMid + params.highlights[1] * wHigh) * 1.28;
  const deltaB = (params.shadows[2] * wShad + params.midtones[2] * wMid + params.highlights[2] * wHigh) * 1.28;

  let newR = Math.max(0, Math.min(255, r + deltaR));
  let newG = Math.max(0, Math.min(255, g + deltaG));
  let newB = Math.max(0, Math.min(255, b + deltaB));

  if (params.preserveLuminosity) {
    const origLum = lum * 255;
    const newLum = 0.299 * newR + 0.587 * newG + 0.114 * newB;
    if (newLum > 0.001) {
      const scale = origLum / newLum;
      newR = Math.max(0, Math.min(255, newR * scale));
      newG = Math.max(0, Math.min(255, newG * scale));
      newB = Math.max(0, Math.min(255, newB * scale));
    }
  }

  return [Math.round(newR), Math.round(newG), Math.round(newB)];
}

/**
 * Universal evaluator for non-destructive adjustment layers directly on ImageData.
 * Used for 2D compositor fallback, caching, or layer flattening.
 */
export function applyAdjustment(
  imageData: ImageData,
  adjustment: AdjustmentLayerData,
  maskCanvas?: HTMLCanvasElement | null,
  opacity: number = 1.0
): void {
  const d = imageData.data;
  const w = imageData.width;
  const h = imageData.height;
  const totalPixels = w * h;

  // Extract mask luminosity data if maskCanvas is provided
  let maskData: Uint8ClampedArray | null = null;
  if (maskCanvas) {
    const mCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    if (mCtx) {
      maskData = mCtx.getImageData(0, 0, w, h).data;
    }
  }

  if (adjustment.type === 'curves') {
    const { rLut, gLut, bLut } = buildCurvesCombinedLut(adjustment.curves);
    for (let p = 0; p < totalPixels; p++) {
      const i = p * 4;
      if (d[i + 3] === 0) continue;

      let maskFactor = opacity;
      if (maskData) {
        const maskLum = (0.299 * maskData[i] + 0.587 * maskData[i + 1] + 0.114 * maskData[i + 2]) / 255 * (maskData[i + 3] / 255);
        maskFactor *= maskLum;
      }
      if (maskFactor <= 0.001) continue;

      const targetR = rLut[d[i]];
      const targetG = gLut[d[i + 1]];
      const targetB = bLut[d[i + 2]];

      if (maskFactor >= 0.999) {
        d[i] = targetR;
        d[i + 1] = targetG;
        d[i + 2] = targetB;
      } else {
        d[i] = Math.round(d[i] + (targetR - d[i]) * maskFactor);
        d[i + 1] = Math.round(d[i + 1] + (targetG - d[i + 1]) * maskFactor);
        d[i + 2] = Math.round(d[i + 2] + (targetB - d[i + 2]) * maskFactor);
      }
    }
    return;
  }

  if (adjustment.type === 'gradient-map') {
    const lut = buildGradientMapLut(adjustment.stops, adjustment.interpolation || 'linear');
    for (let p = 0; p < totalPixels; p++) {
      const i = p * 4;
      if (d[i + 3] === 0) continue;

      let maskFactor = opacity;
      if (maskData) {
        const maskLum = (0.299 * maskData[i] + 0.587 * maskData[i + 1] + 0.114 * maskData[i + 2]) / 255 * (maskData[i + 3] / 255);
        maskFactor *= maskLum;
      }
      if (maskFactor <= 0.001) continue;

      const lum = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      const lutOffset = Math.max(0, Math.min(255, lum)) * 4;
      const targetR = lut[lutOffset];
      const targetG = lut[lutOffset + 1];
      const targetB = lut[lutOffset + 2];

      if (maskFactor >= 0.999) {
        d[i] = targetR;
        d[i + 1] = targetG;
        d[i + 2] = targetB;
      } else {
        d[i] = Math.round(d[i] + (targetR - d[i]) * maskFactor);
        d[i + 1] = Math.round(d[i + 1] + (targetG - d[i + 1]) * maskFactor);
        d[i + 2] = Math.round(d[i + 2] + (targetB - d[i + 2]) * maskFactor);
      }
    }
    return;
  }

  if (adjustment.type === 'levels') {
    const lut = buildLevelsLut(
      adjustment.blackPoint,
      adjustment.whitePoint,
      adjustment.gamma,
      adjustment.outputMin ?? 0,
      adjustment.outputMax ?? 255
    );
    const channel = adjustment.channel || 'rgb';
    for (let p = 0; p < totalPixels; p++) {
      const i = p * 4;
      if (d[i + 3] === 0) continue;

      let maskFactor = opacity;
      if (maskData) {
        const maskLum = (0.299 * maskData[i] + 0.587 * maskData[i + 1] + 0.114 * maskData[i + 2]) / 255 * (maskData[i + 3] / 255);
        maskFactor *= maskLum;
      }
      if (maskFactor <= 0.001) continue;

      if (channel === 'rgb') {
        const tR = lut[d[i]];
        const tG = lut[d[i + 1]];
        const tB = lut[d[i + 2]];
        d[i] = Math.round(d[i] + (tR - d[i]) * maskFactor);
        d[i + 1] = Math.round(d[i + 1] + (tG - d[i + 1]) * maskFactor);
        d[i + 2] = Math.round(d[i + 2] + (tB - d[i + 2]) * maskFactor);
      } else if (channel === 'r') {
        d[i] = Math.round(d[i] + (lut[d[i]] - d[i]) * maskFactor);
      } else if (channel === 'g') {
        d[i + 1] = Math.round(d[i + 1] + (lut[d[i + 1]] - d[i + 1]) * maskFactor);
      } else if (channel === 'b') {
        d[i + 2] = Math.round(d[i + 2] + (lut[d[i + 2]] - d[i + 2]) * maskFactor);
      }
    }
    return;
  }

  if (adjustment.type === 'color-balance') {
    for (let p = 0; p < totalPixels; p++) {
      const i = p * 4;
      if (d[i + 3] === 0) continue;

      let maskFactor = opacity;
      if (maskData) {
        const maskLum = (0.299 * maskData[i] + 0.587 * maskData[i + 1] + 0.114 * maskData[i + 2]) / 255 * (maskData[i + 3] / 255);
        maskFactor *= maskLum;
      }
      if (maskFactor <= 0.001) continue;

      const [tR, tG, tB] = evaluateColorBalancePixel(d[i], d[i + 1], d[i + 2], adjustment);
      d[i] = Math.round(d[i] + (tR - d[i]) * maskFactor);
      d[i + 1] = Math.round(d[i + 1] + (tG - d[i + 1]) * maskFactor);
      d[i + 2] = Math.round(d[i + 2] + (tB - d[i + 2]) * maskFactor);
    }
    return;
  }
}

