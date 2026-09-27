import { CanvasColorMode } from '../types/editor';

/**
 * Parses any CSS color string (hex, rgb, rgba) into [r, g, b, a] in 0-255 range.
 */
export function parseRgba(color: string): [number, number, number, number] {
  if (color === 'transparent') {
    return [0, 0, 0, 0];
  }

  // Hex format (#RGB, #RGBA, #RRGGBB, #RRGGBBAA)
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    }
    const r = parseInt(hex.slice(0, 2), 16) || 0;
    const g = parseInt(hex.slice(2, 4), 16) || 0;
    const b = parseInt(hex.slice(4, 6), 16) || 0;
    const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }

  // rgb/rgba format
  const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    const a = rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1;
    return [r, g, b, a];
  }

  return [0, 0, 0, 1];
}

/**
 * Calculates standard perceived luminance (0 - 255) using ITU-R BT.601 coefficients.
 */
export function getLuminance(r: number, g: number, b: number): number {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

/**
 * Converts a color string to conform with the given CanvasColorMode.
 */
export function enforceColorMode(color: string, mode: CanvasColorMode): string {
  if (mode === 'color' || color === 'transparent') {
    return color;
  }

  const [r, g, b, a] = parseRgba(color);
  const lum = getLuminance(r, g, b);

  if (mode === 'grayscale') {
    const hex = lum.toString(16).padStart(2, '0');
    return a < 1 ? `rgba(${lum}, ${lum}, ${lum}, ${a})` : `#${hex}${hex}${hex}`;
  }

  if (mode === 'monochrome') {
    // 1-bit Manga thresholding: luminance >= 128 -> white, < 128 -> black
    const bwVal = lum >= 128 ? 255 : 0;
    const hex = bwVal === 255 ? 'ffffff' : '000000';
    return `#${hex}`;
  }

  return color;
}

/**
 * Processes an ImageData buffer in-place to convert it to grayscale or monochrome.
 */
export function applyColorModeToImageData(imageData: ImageData, mode: CanvasColorMode) {
  if (mode === 'color') return;

  const data = imageData.data;
  const len = data.length;

  if (mode === 'grayscale') {
    for (let i = 0; i < len; i += 4) {
      const alpha = data[i + 3];
      if (alpha === 0) continue;
      const lum = (19595 * data[i] + 38470 * data[i + 1] + 7471 * data[i + 2] + 32768) >> 16;
      data[i] = lum;
      data[i + 1] = lum;
      data[i + 2] = lum;
    }
  } else if (mode === 'monochrome') {
    // Manga 1-bit crisp binary thresholding (Uint32Array fast-path)
    const u32 = new Uint32Array(imageData.data.buffer);
    const u32Len = u32.length;
    for (let i = 0; i < u32Len; i++) {
      const pix = u32[i];
      const alpha = (pix >>> 24) & 0xFF;
      if (alpha < 128) {
        u32[i] = 0;
        continue;
      }
      const r = pix & 0xFF;
      const g = (pix >>> 8) & 0xFF;
      const b = (pix >>> 16) & 0xFF;
      const lum = (19595 * r + 38470 * g + 7471 * b + 32768) >> 16;
      u32[i] = lum >= 128 ? 0xFFFFFFFF : 0xFF000000;
    }
  }
}

/**
 * Ultra-fast 32-bit in-place binary thresholding on a canvas context rect.
 * Converts anti-aliased stroke edges to 1-bit crisp binary output in real time (<0.05ms).
 */
export function binarizeCanvasRect(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  threshold: number = 128,
  expressBlack: boolean = true,
  expressWhite: boolean = true
) {
  const sx = Math.max(0, Math.floor(rect.x));
  const sy = Math.max(0, Math.floor(rect.y));
  const sw = Math.min(ctx.canvas.width - sx, Math.ceil(rect.width));
  const sh = Math.min(ctx.canvas.height - sy, Math.ceil(rect.height));

  if (sw <= 0 || sh <= 0) return;

  const imgData = ctx.getImageData(sx, sy, sw, sh);
  const u32 = new Uint32Array(imgData.data.buffer);
  const len = u32.length;
  const thresh = Math.max(1, Math.min(255, threshold));

  for (let i = 0; i < len; i++) {
    const pix = u32[i];
    const alpha = (pix >>> 24) & 0xFF;
    if (alpha < 128) {
      u32[i] = 0; // transparent
      continue;
    }
    const r = pix & 0xFF;
    const g = (pix >>> 8) & 0xFF;
    const b = (pix >>> 16) & 0xFF;
    const lum = (19595 * r + 38470 * g + 7471 * b + 32768) >> 16;
    if (lum < thresh) {
      u32[i] = expressBlack ? 0xFF000000 : 0;
    } else {
      u32[i] = expressWhite ? 0xFFFFFFFF : 0;
    }
  }

  ctx.putImageData(imgData, sx, sy);
}

/**
 * Processes an HTMLCanvasElement in-place to conform with the given color mode.
 * Supports an optional dirtyRect to avoid full-canvas buffer readbacks on high-res canvases.
 */
export function applyColorModeToCanvas(
  canvas: HTMLCanvasElement,
  mode: CanvasColorMode,
  dirtyRect?: { x: number; y: number; width: number; height: number }
) {
  if (mode === 'color') return;
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width === 0 || canvas.height === 0) return;

  const sx = dirtyRect ? Math.max(0, Math.floor(dirtyRect.x)) : 0;
  const sy = dirtyRect ? Math.max(0, Math.floor(dirtyRect.y)) : 0;
  const sw = dirtyRect ? Math.min(canvas.width - sx, Math.ceil(dirtyRect.width)) : canvas.width;
  const sh = dirtyRect ? Math.min(canvas.height - sy, Math.ceil(dirtyRect.height)) : canvas.height;

  if (sw <= 0 || sh <= 0) return;

  const imgData = ctx.getImageData(sx, sy, sw, sh);
  applyColorModeToImageData(imgData, mode);
  ctx.putImageData(imgData, sx, sy);
}

export interface HSV {
  h: number; // 0 - 360
  s: number; // 0 - 1
  v: number; // 0 - 1
}

export interface RGB {
  r: number; // 0 - 255
  g: number; // 0 - 255
  b: number; // 0 - 255
}

/**
 * Parses a hex string (#RGB, #RRGGBB) to RGB values (0-255).
 */
export function hexToRgb(hex: string): RGB {
  let clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const num = parseInt(clean.slice(0, 6), 16);
  if (isNaN(num)) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

/**
 * Converts RGB (0-255) to uppercase 6-digit hex string (#RRGGBB).
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (val: number) => Math.max(0, Math.min(255, Math.round(val)));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Converts RGB (0-255) to HSV (h: 0-360, s: 0-1, v: 0-1).
 */
export function rgbToHsv(r: number, g: number, b: number): HSV {
  const rNorm = Math.max(0, Math.min(255, r)) / 255;
  const gNorm = Math.max(0, Math.min(255, g)) / 255;
  const bNorm = Math.max(0, Math.min(255, b)) / 255;

  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rNorm) {
      h = ((gNorm - bNorm) / delta + (gNorm < bNorm ? 6 : 0)) * 60;
    } else if (max === gNorm) {
      h = ((bNorm - rNorm) / delta + 2) * 60;
    } else {
      h = ((rNorm - gNorm) / delta + 4) * 60;
    }
  }

  const s = max === 0 ? 0 : delta / max;
  const v = max;

  return {
    h: Math.round(h) % 360,
    s,
    v,
  };
}

/**
 * Converts HSV (h: 0-360, s: 0-1, v: 0-1) to RGB (0-255).
 */
export function hsvToRgb(h: number, s: number, v: number): RGB {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  v = Math.max(0, Math.min(1, v));

  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let rPrime = 0;
  let gPrime = 0;
  let bPrime = 0;

  if (h >= 0 && h < 60) {
    rPrime = c;
    gPrime = x;
    bPrime = 0;
  } else if (h >= 60 && h < 120) {
    rPrime = x;
    gPrime = c;
    bPrime = 0;
  } else if (h >= 120 && h < 180) {
    rPrime = 0;
    gPrime = c;
    bPrime = x;
  } else if (h >= 180 && h < 240) {
    rPrime = 0;
    gPrime = x;
    bPrime = c;
  } else if (h >= 240 && h < 300) {
    rPrime = x;
    gPrime = 0;
    bPrime = c;
  } else {
    rPrime = c;
    gPrime = 0;
    bPrime = x;
  }

  return {
    r: Math.round((rPrime + m) * 255),
    g: Math.round((gPrime + m) * 255),
    b: Math.round((bPrime + m) * 255),
  };
}

/**
 * Converts Hex string to HSV (h: 0-360, s: 0-1, v: 0-1).
 */
export function hexToHsv(hex: string): HSV {
  const rgb = hexToRgb(hex);
  return rgbToHsv(rgb.r, rgb.g, rgb.b);
}

/**
 * Converts HSV to Hex string (#RRGGBB).
 */
export function hsvToHex(h: number, s: number, v: number): string {
  const rgb = hsvToRgb(h, s, v);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/**
 * Validates whether a string is a valid 3- or 6-digit hex color.
 */
export function isValidHex(hex: string): boolean {
  return /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(hex.trim());
}

export interface CMYK {
  c: number; // 0 - 100
  m: number; // 0 - 100
  y: number; // 0 - 100
  k: number; // 0 - 100
}

/**
 * Converts RGB (0-255) to CMYK (0-100%).
 */
export function rgbToCmyk(r: number, g: number, b: number): CMYK {
  const rNorm = Math.max(0, Math.min(255, r)) / 255;
  const gNorm = Math.max(0, Math.min(255, g)) / 255;
  const bNorm = Math.max(0, Math.min(255, b)) / 255;
  const kNorm = 1 - Math.max(rNorm, gNorm, bNorm);
  if (kNorm >= 1) {
    return { c: 0, m: 0, y: 0, k: 100 };
  }
  const cNorm = (1 - rNorm - kNorm) / (1 - kNorm);
  const mNorm = (1 - gNorm - kNorm) / (1 - kNorm);
  const yNorm = (1 - bNorm - kNorm) / (1 - kNorm);
  return {
    c: Math.round(cNorm * 100),
    m: Math.round(mNorm * 100),
    y: Math.round(yNorm * 100),
    k: Math.round(kNorm * 100),
  };
}

/**
 * Converts CMYK (0-100%) to RGB (0-255).
 */
export function cmykToRgb(c: number, m: number, y: number, k: number): RGB {
  const cNorm = Math.max(0, Math.min(100, c)) / 100;
  const mNorm = Math.max(0, Math.min(100, m)) / 100;
  const yNorm = Math.max(0, Math.min(100, y)) / 100;
  const kNorm = Math.max(0, Math.min(100, k)) / 100;
  const r = 255 * (1 - cNorm) * (1 - kNorm);
  const g = 255 * (1 - mNorm) * (1 - kNorm);
  const b = 255 * (1 - yNorm) * (1 - kNorm);
  return {
    r: Math.max(0, Math.min(255, Math.round(r))),
    g: Math.max(0, Math.min(255, Math.round(g))),
    b: Math.max(0, Math.min(255, Math.round(b))),
  };
}

/**
 * Converts Hex string to CMYK (0-100%).
 */
export function hexToCmyk(hex: string): CMYK {
  const rgb = hexToRgb(hex);
  return rgbToCmyk(rgb.r, rgb.g, rgb.b);
}

/**
 * Converts CMYK (0-100%) to Hex string.
 */
export function cmykToHex(c: number, m: number, y: number, k: number): string {
  const rgb = cmykToRgb(c, m, y, k);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}


