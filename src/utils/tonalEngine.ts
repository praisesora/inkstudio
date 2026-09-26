import { CanvasSelection } from '../types/editor';

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
