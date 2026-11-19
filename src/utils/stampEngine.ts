import {
  Point,
  BrushSettings,
  ToolType,
  CspSpraySettings,
  CspTaperSettings,
  CspSubTip,
  BrushDynamics,
  CspAngleDynamicsMode,
  CspTipFlipMode,
  CspPaperTextureMode,
  CspBlendTipsMode,
  CspSensorConfig,
} from '../types/editor';
import {
  PaintReservoir,
  LayerPixelSampler,
  sampleCanvasColor,
  parseColorToRgb,
  rgbToHex,
} from './colorMixingEngine';
import { getPaperGrain, paperGrainTable, GRAIN_SIZE } from './pencilEngine';
import { GpuDab, WebGlBrushEngine } from './webglBrushEngine';
import {
  evaluateFastSpline,
  dabHashFloat,
  evaluateCspSensor,
  computeEllipticalStepDistance,
  computeGapAdjustedAlpha,
  computeSubpixelDabDimensions,
  resolveTipFlipSigns,
  applyCspPaperTextureAlpha,
} from '../engine/CspBrushEngine';

export interface TexturedBrushOptions {
  size: number;
  minSizeFactor?: number;
  opacity?: number;
  flow?: number;
  brushDensity?: number;
  adjustDensityByGap?: boolean;
  blendTipsMode?: CspBlendTipsMode;
  spacing?: number; // 0.01 to 1.0 (relative to brush width)
  thickness?: number; // 0.05 to 1.0 (elliptical aspect ratio)
  thicknessVertical?: boolean;
  flipH?: CspTipFlipMode;
  flipV?: CspTipFlipMode;
  angle?: number; // rotation in degrees
  angleDynamics?: CspAngleDynamicsMode;
  rotationRandomScale?: number;
  hardness?: number;
  antiAlias?: number;
  isColorTip?: boolean;
  pressureCurve?: [number, number][];
  velocityCurve?: [number, number][];
  usePressure?: boolean;
  useTilt?: boolean;
  tiltScale?: number;
  useVelocity?: boolean;
  sizeSensor?: CspSensorConfig;
  opacitySensor?: CspSensorConfig;
  densitySensor?: CspSensorConfig;
  subTips?: CspSubTip[];
  subTipOrder?: 'random' | 'sequential' | 'direction' | 'reverse';
  subTipImages?: HTMLImageElement[];
  spray?: CspSpraySettings;
  taper?: CspTaperSettings;
  colorMixing?: boolean;
  perceptualMixing?: boolean;
  amountOfPaint?: number;
  densityOfPaint?: number;
  colorStretch?: number;
  mixingMode?: 'blend' | 'running_color' | 'smear';
  wetEdge?: number;
  wetEdgeRadius?: number;
  wetEdgeAlphaPower?: number;
  wetEdgeValuePower?: number;
  grain?: number;
  textureDensity?: number;
  paperTextureMode?: CspPaperTextureMode;
  paperTextureBrightness?: number;
  paperTextureContrast?: number;
  paperTextureInverted?: boolean;
  paperTextureImage?: HTMLImageElement;
  paperTextureScale?: number;
  paperTextureRotate?: number;
  dualBrush?: boolean;
  dualTipImage?: HTMLImageElement;
  dualBrushCompositeMode?: string;
  useGpu?: boolean;
  underlyingCanvas?: HTMLCanvasElement;
  sampler?: LayerPixelSampler;
  reservoir?: PaintReservoir;
  isEraser?: boolean;
  isBgEraser?: boolean;
  alphaLocked?: boolean;
  isTransparentInk?: boolean;
  strokeIndex?: number;
  totalLength?: number;
  currentStrokeDist?: number;
  dynamics?: BrushDynamics;
  secondaryColor?: string;
}

// -------------------------------------------------------------
// Color Dynamics & HSV Jitter Utilities
// -------------------------------------------------------------

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (max !== min) {
    if (max === r) {
      h = (g - b) / d + (g < b ? 6 : 0);
    } else if (max === g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return [h, s, v];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hp >= 0 && hp < 1) {
    r1 = c; g1 = x; b1 = 0;
  } else if (hp >= 1 && hp < 2) {
    r1 = x; g1 = c; b1 = 0;
  } else if (hp >= 2 && hp < 3) {
    r1 = 0; g1 = c; b1 = x;
  } else if (hp >= 3 && hp < 4) {
    r1 = 0; g1 = x; b1 = c;
  } else if (hp >= 4 && hp < 5) {
    r1 = x; g1 = 0; b1 = c;
  } else if (hp >= 5 && hp < 6) {
    r1 = c; g1 = 0; b1 = x;
  }

  const m = v - c;
  return [
    Math.max(0, Math.min(1, r1 + m)),
    Math.max(0, Math.min(1, g1 + m)),
    Math.max(0, Math.min(1, b1 + m)),
  ];
}

export function applyColorDynamics(
  primaryRgb: { r: number; g: number; b: number },
  secondaryRgb: { r: number; g: number; b: number },
  dynamics?: BrushDynamics,
  rng: () => number = Math.random
): { r: number; g: number; b: number; hex: string } {
  if (!dynamics || !dynamics.colorJitterEnabled) {
    const ir = Math.round(primaryRgb.r * 255);
    const ig = Math.round(primaryRgb.g * 255);
    const ib = Math.round(primaryRgb.b * 255);
    return {
      r: primaryRgb.r,
      g: primaryRgb.g,
      b: primaryRgb.b,
      hex: rgbToHex(ir, ig, ib),
    };
  }

  let r = primaryRgb.r;
  let g = primaryRgb.g;
  let b = primaryRgb.b;

  if (dynamics.foregroundBackgroundJitter > 0) {
    const mix = rng() * dynamics.foregroundBackgroundJitter;
    r = r + (secondaryRgb.r - r) * mix;
    g = g + (secondaryRgb.g - g) * mix;
    b = b + (secondaryRgb.b - b) * mix;
  }

  if (dynamics.hueJitter > 0 || dynamics.saturationJitter > 0 || dynamics.brightnessJitter > 0) {
    let [h, s, v] = rgbToHsv(r, g, b);

    if (dynamics.hueJitter > 0) {
      h = (h + (rng() - 0.5) * dynamics.hueJitter * 360 + 360) % 360;
    }
    if (dynamics.saturationJitter > 0) {
      s = Math.max(0, Math.min(1, s * (1.0 + (rng() * 2 - 1) * dynamics.saturationJitter)));
    }
    if (dynamics.brightnessJitter > 0) {
      v = Math.max(0, Math.min(1, v * (1.0 + (rng() * 2 - 1) * dynamics.brightnessJitter)));
    }

    [r, g, b] = hsvToRgb(h, s, v);
  }

  r = Math.max(0, Math.min(1, r));
  g = Math.max(0, Math.min(1, g));
  b = Math.max(0, Math.min(1, b));

  const ir = Math.round(r * 255);
  const ig = Math.round(g * 255);
  const ib = Math.round(b * 255);

  return {
    r,
    g,
    b,
    hex: rgbToHex(ir, ig, ib),
  };
}

// -------------------------------------------------------------
// Hardware-Accelerated World-Locked Paper Grain Masking (CPU/Color-Mixing Parity)
// -------------------------------------------------------------

let _invertedGrainCanvas: HTMLCanvasElement | null = null;
let _grainScratchCanvas: HTMLCanvasElement | null = null;
let _grainScratchCtx: CanvasRenderingContext2D | null = null;
let _grainPattern: CanvasPattern | null = null;
let _customGrainCanvasCache = new WeakMap<HTMLImageElement, { canvas: HTMLCanvasElement; pattern: CanvasPattern | null }>();

function getInvertedGrainPattern(
  scratchCtx: CanvasRenderingContext2D,
  paperTextureImage?: HTMLImageElement
): CanvasPattern | null {
  if (typeof scratchCtx.createPattern !== 'function') return null;

  if (
    paperTextureImage &&
    paperTextureImage.complete !== false &&
    (paperTextureImage.naturalWidth || paperTextureImage.width) > 0
  ) {
    const cached = _customGrainCanvasCache.get(paperTextureImage);
    if (cached) return cached.pattern;
    const w = paperTextureImage.naturalWidth || paperTextureImage.width;
    const h = paperTextureImage.naturalHeight || paperTextureImage.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const gCtx = c.getContext('2d', { willReadFrequently: true });
    if (gCtx && typeof gCtx.getImageData === 'function') {
      gCtx.drawImage(paperTextureImage, 0, 0, w, h);
      const img = gCtx.getImageData(0, 0, w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const inv = 255 - Math.round(lum);
        d[i] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
        d[i + 3] = inv;
      }
      gCtx.putImageData(img, 0, 0);
      const pat = scratchCtx.createPattern(c, 'repeat');
      _customGrainCanvasCache.set(paperTextureImage, { canvas: c, pattern: pat });
      return pat;
    }
  }

  if (!_invertedGrainCanvas) {
    const c = document.createElement('canvas');
    c.width = GRAIN_SIZE;
    c.height = GRAIN_SIZE;
    const gCtx = c.getContext('2d');
    if (!gCtx) return null;
    const img = gCtx.createImageData(GRAIN_SIZE, GRAIN_SIZE);
    const d = img.data;
    for (let i = 0; i < paperGrainTable.length; i++) {
      const p = i * 4;
      d[p] = 255;
      d[p + 1] = 255;
      d[p + 2] = 255;
      // Alpha = (1 - paperHeight) so destination-out removes pigment in paper valleys
      d[p + 3] = 255 - paperGrainTable[i];
    }
    gCtx.putImageData(img, 0, 0);
    _invertedGrainCanvas = c;
    _grainPattern = scratchCtx.createPattern(c, 'repeat');
  }

  return _grainPattern;
}

/**
 * Applies world-anchored per-pixel paper/canvas grain onto a CPU dab stamp using hardware 2D compositing.
 * Returns a pooled canvas containing the grain-masked dab, or null if unsupported (falls back to scalar grain).
 */
function applyCpuPerPixelPaperGrain(
  master: CanvasImageSource,
  worldX: number,
  worldY: number,
  renderW: number,
  renderH: number,
  grainAmount: number,
  pressure: number,
  paperScale: number = 1.0,
  paperTextureImage?: HTMLImageElement
): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || grainAmount <= 0.005) return null;
  if (!_grainScratchCanvas) {
    _grainScratchCanvas = document.createElement('canvas');
    _grainScratchCanvas.width = 128;
    _grainScratchCanvas.height = 128;
    _grainScratchCtx = _grainScratchCanvas.getContext('2d');
  }
  const sCtx = _grainScratchCtx;
  if (!sCtx || typeof sCtx.createPattern !== 'function') return null;

  const pat = getInvertedGrainPattern(sCtx, paperTextureImage);
  if (!pat) return null;

  const bufSize = 128;
  const p = Math.max(0, Math.min(1, pressure));
  const heavyExcess = Math.max(0, (p - 0.52) / 0.48);
  const penetration = Math.min(0.92, p * 0.28 + heavyExcess * heavyExcess * 0.64);
  const effDensity = Math.max(0, Math.min(0.98, grainAmount * (1.0 - penetration * 0.85)));
  if (effDensity <= 0.005) return null;

  sCtx.save();
  sCtx.globalCompositeOperation = 'source-over';
  sCtx.globalAlpha = 1.0;
  sCtx.clearRect(0, 0, bufSize, bufSize);
  sCtx.drawImage(master, 0, 0, bufSize, bufSize);

  // Align world-space paper pattern onto the dab's local [0..bufSize] frame
  const scale = Math.max(0.1, paperScale);
  const sx = (bufSize / Math.max(1, renderW)) * scale;
  const sy = (bufSize / Math.max(1, renderH)) * scale;
  const offX = -((worldX - renderW * 0.5) / scale);
  const offY = -((worldY - renderH * 0.5) / scale);

  sCtx.globalCompositeOperation = 'destination-out';
  sCtx.globalAlpha = effDensity;
  sCtx.fillStyle = pat;
  sCtx.scale(sx, sy);
  sCtx.translate(offX, offY);
  sCtx.fillRect(-offX, -offY, bufSize / sx, bufSize / sy);
  sCtx.restore();

  return _grainScratchCanvas;
}

// -------------------------------------------------------------
// High-Efficiency Tinted Tip Master Buffer & Bounded LRU Pools
// -------------------------------------------------------------

const MAX_CACHE_ENTRIES = 160;
const MAX_RADIAL_MASKS = 96;
const tintedMasterCache = new Map<string, HTMLCanvasElement>();
const radialMaskCache = new Map<string, HTMLCanvasElement>();
const canvasPool: HTMLCanvasElement[] = [];
const sourceIdMap = new WeakMap<object, number>();
let nextSourceId = 1;

function getUniqueSourceKey(source: CanvasImageSource, fallbackPrefix: string): string {
  if (typeof source === 'object' && source !== null) {
    let id = sourceIdMap.get(source);
    if (!id) {
      id = nextSourceId++;
      sourceIdMap.set(source, id);
    }
    return `${fallbackPrefix}_${id}`;
  }
  return fallbackPrefix;
}

function getPooledCanvas(w: number, h: number): HTMLCanvasElement {
  const targetW = Math.max(1, w);
  const targetH = Math.max(1, h);
  for (let i = 0; i < canvasPool.length; i++) {
    const c = canvasPool[i];
    if (c.width === targetW && c.height === targetH) {
      canvasPool.splice(i, 1);
      return c;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  return canvas;
}

function evictOrAllocateMasterCanvas(w: number, h: number): HTMLCanvasElement {
  const targetW = Math.max(1, w);
  const targetH = Math.max(1, h);
  if (tintedMasterCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = tintedMasterCache.keys().next().value;
    if (oldestKey) {
      const canvas = tintedMasterCache.get(oldestKey)!;
      tintedMasterCache.delete(oldestKey);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      return canvas;
    }
  }
  return getPooledCanvas(targetW, targetH);
}

/**
 * Generic tinted master offscreen canvas generator.
 * Uses fine 21-bit color quantization (step of 2/255) to eliminate 15-bit Mach banding while retaining high cache hits.
 */
export function getTintedMasterCanvas(
  source: CanvasImageSource,
  sourceKey: string,
  color: string,
  w: number,
  h: number,
  isColorTip: boolean = false
): HTMLCanvasElement {
  if (isColorTip) {
    const key = `color_${sourceKey}_${w}x${h}`;
    const cached = tintedMasterCache.get(key);
    if (cached) return cached;

    const canvas = evictOrAllocateMasterCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    }
    tintedMasterCache.set(key, canvas);
    return canvas;
  }

  const rgb = parseColorToRgb(color);
  const qR = rgb.r & ~1;
  const qG = rgb.g & ~1;
  const qB = rgb.b & ~1;
  const quantizedHex = rgbToHex(qR, qG, qB);

  const key = `${sourceKey}_${quantizedHex}_${w}x${h}`;
  const cached = tintedMasterCache.get(key);
  if (cached) return cached;

  const canvas = evictOrAllocateMasterCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = quantizedHex;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  tintedMasterCache.set(key, canvas);
  return canvas;
}

export function getTintedTipMaster(
  tipImage: HTMLImageElement,
  color: string,
  isColorTip: boolean = false
): HTMLCanvasElement {
  const w = tipImage.naturalWidth || tipImage.width || 64;
  const h = tipImage.naturalHeight || tipImage.height || 64;
  const uniqueKey = getUniqueSourceKey(tipImage, 'tip');
  return getTintedMasterCanvas(tipImage, uniqueKey, color, w, h, isColorTip);
}

/**
 * Pre-computes or retrieves an analytical Hermite radial dab master with CSP 4-level Anti-Aliasing.
 */
export function getRadialDabMaster(
  hardness: number,
  color: string,
  isEraser: boolean = false,
  targetSize?: number,
  antiAlias: number = 2
): HTMLCanvasElement {
  const clampedH = Math.max(0, Math.min(1.0, hardness));
  const qH = Math.round(clampedH * 20) / 20;
  const aaLevel = Math.max(0, Math.min(3, Math.round(antiAlias)));

  let size = 128;
  let qDiameter = 124;
  if (targetSize !== undefined && targetSize > 0) {
    if (targetSize <= 8) {
      size = 24;
      qDiameter = Math.max(1, Math.round(targetSize));
    } else if (targetSize <= 24) {
      size = 48;
      qDiameter = Math.max(4, Math.round(targetSize / 2) * 2);
    } else if (targetSize <= 64) {
      size = 64;
      qDiameter = Math.max(16, Math.round(targetSize / 4) * 4);
    } else {
      size = 128;
      qDiameter = 124;
    }
  }

  const aaKeySuffix = aaLevel === 2 ? '' : `_aa${aaLevel}`;
  const maskKey = targetSize === undefined ? `${qH}_128${aaKeySuffix}` : `${qH}_${size}_${qDiameter}${aaKeySuffix}`;
  let maskCanvas = radialMaskCache.get(maskKey);
  if (!maskCanvas) {
    if (radialMaskCache.size >= MAX_RADIAL_MASKS) {
      const oldest = radialMaskCache.keys().next().value;
      if (oldest !== undefined) radialMaskCache.delete(oldest);
    }

    maskCanvas = document.createElement('canvas');
    maskCanvas.width = size;
    maskCanvas.height = size;
    const ctx = maskCanvas.getContext('2d');
    if (ctx) {
      const imgData = ctx.createImageData(size, size);
      const data = imgData.data;
      const cx = size / 2;
      const cy = size / 2;
      const radius = size / 2 - 1;

      const aaScale = aaLevel === 0 ? 0 : aaLevel === 1 ? 0.6 : aaLevel === 3 ? 1.65 : 1.0;
      const baseAaTexels = qH >= 0.98
        ? 1.15
        : targetSize === undefined
        ? 1.0
        : Math.max(0.85, Math.min(2.4, (radius / Math.max(1.5, qDiameter * 0.5)) * 0.85));
      const aaTexels = baseAaTexels * aaScale;
      const rCore = Math.min(radius - Math.max(0, aaTexels), radius * qH);

      for (let y = 0; y < size; y++) {
        const dy = y - cy + 0.5;
        const rowOffset = y * size * 4;
        for (let x = 0; x < size; x++) {
          const dx = x - cx + 0.5;
          const dist = Math.hypot(dx, dy);
          let alpha = 0;

          if (aaLevel === 0) {
            alpha = dist <= radius ? 1.0 : 0.0;
          } else if (qH >= 0.98) {
            const u = Math.max(0, Math.min(1.0, (radius - dist) / Math.max(0.25, aaTexels) + 0.5));
            alpha = u * u * (3.0 - 2.0 * u);
          } else if (dist <= rCore) {
            alpha = 1.0;
          } else if (dist < radius) {
            const t = (dist - rCore) / Math.max(1e-4, radius - rCore);
            if (qH <= 0.05) {
              alpha = 0.5 * (1.0 + Math.cos(t * Math.PI));
            } else {
              alpha = 1.0 - (3.0 * t * t - 2.0 * t * t * t);
            }
          }

          if (alpha > 0.002) {
            const idx = rowOffset + x * 4;
            data[idx] = 255;
            data[idx + 1] = 255;
            data[idx + 2] = 255;
            data[idx + 3] = Math.round(alpha * 255);
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }
    radialMaskCache.set(maskKey, maskCanvas);
  }

  const effectiveColor = isEraser ? '#000000' : color;
  return getTintedMasterCanvas(maskCanvas, `radial_${maskKey}`, effectiveColor, size, size);
}

/**
 * Draws a single textured or analytical brush stamp (dab) onto the destination context.
 * Supports sub-pixel 2D area conservation, horizontal/vertical flips, and binary AA.
 */
export function drawSingleStamp(
  ctx: CanvasRenderingContext2D,
  stampSource: CanvasImageSource,
  x: number,
  y: number,
  width: number,
  height: number,
  angleRad: number,
  alpha: number,
  isEraser: boolean = false,
  isBgEraser: boolean = false,
  alphaLocked: boolean = false,
  isTransparentInk: boolean = false,
  flipX: number = 1,
  flipY: number = 1,
  antiAlias: number = 2,
  _blendTipsMode?: CspBlendTipsMode
) {
  if (width < 0.08 || height < 0.08 || alpha <= 0.002) return;

  const minRenderDim = antiAlias === 0 ? 1.0 : 0.75;
  const sub = computeSubpixelDabDimensions(width, height, alpha, minRenderDim);
  const renderW = sub.renderW;
  const renderH = sub.renderH;
  const effAlpha = antiAlias === 0 ? (sub.effAlpha >= 0.45 ? 1.0 : 0) : sub.effAlpha;
  if (effAlpha <= 0.002) return;

  const targetOp: GlobalCompositeOperation = isBgEraser
    ? 'source-over'
    : (isTransparentInk || isEraser)
    ? 'destination-out'
    : alphaLocked
    ? 'source-atop'
    : 'source-over';

  const prevSmooth = ctx.imageSmoothingEnabled;
  if (antiAlias === 0 && prevSmooth !== false) {
    ctx.imageSmoothingEnabled = false;
  }

  // Ultra-fast path for unrotated, unflipped stamps
  if (Math.abs(angleRad) < 0.001 && flipX >= 0 && flipY >= 0) {
    const prevAlpha = ctx.globalAlpha;
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = targetOp;
    ctx.globalAlpha = effAlpha;
    const drawX = antiAlias === 0 ? Math.round(x - renderW / 2) : x - renderW / 2;
    const drawY = antiAlias === 0 ? Math.round(y - renderH / 2) : y - renderH / 2;
    ctx.drawImage(stampSource, drawX, drawY, renderW, renderH);
    ctx.globalAlpha = prevAlpha;
    ctx.globalCompositeOperation = prevOp;
    if (antiAlias === 0 && prevSmooth !== false) {
      ctx.imageSmoothingEnabled = prevSmooth;
    }
    return;
  }

  ctx.save();
  ctx.globalCompositeOperation = targetOp;
  ctx.globalAlpha = effAlpha;
  ctx.translate(x, y);
  if (Math.abs(angleRad) >= 0.001) {
    ctx.rotate(angleRad);
  }
  if ((flipX < 0 || flipY < 0) && typeof ctx.scale === 'function') {
    ctx.scale(flipX < 0 ? -1 : 1, flipY < 0 ? -1 : 1);
  }
  ctx.drawImage(stampSource, -renderW / 2, -renderH / 2, renderW, renderH);
  ctx.restore();
  if (antiAlias === 0 && prevSmooth !== false) {
    ctx.imageSmoothingEnabled = prevSmooth;
  }
}

/**
 * Deterministic multi-tip stamp selector.
 * Uses dabHashFloat for 'random' order so live stroke preview and commit bake select identical tips!
 */
function selectTipImage(
  tipImages: HTMLImageElement[] | undefined,
  fallbackTip: HTMLImageElement,
  order: 'random' | 'sequential' | 'direction' | 'reverse' = 'sequential',
  dabIndex: number = 0,
  tangentAngle: number = 0,
  x: number = 0,
  y: number = 0
): HTMLImageElement {
  if (!tipImages || tipImages.length <= 1) {
    return tipImages && tipImages.length === 1 ? tipImages[0] : fallbackTip;
  }

  const count = tipImages.length;
  if (order === 'random') {
    const idx = Math.floor(dabHashFloat(x, y, dabIndex, 97) * count) % count;
    return tipImages[idx];
  } else if (order === 'reverse') {
    const idx = (count - 1 - (dabIndex % count)) % count;
    return tipImages[idx];
  } else if (order === 'direction') {
    const normAngle = ((tangentAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const idx = Math.floor((normAngle / (2 * Math.PI)) * count) % count;
    return tipImages[idx];
  } else {
    return tipImages[dabIndex % count];
  }
}

/**
 * Determines whether a textured brush configuration can execute on WebGlBrushEngine
 * (instanced GPU FBO stamps). Falls back cleanly to Canvas 2D for binary pixel AA=0,
 * stateful CPU colorMixingEngine, multi-subTip textures, or unavailable WebGL context.
 */
export function canUseWebGlForTexturedBrush(options: TexturedBrushOptions): boolean {
  if (options.useGpu === false) return false;
  if (options.colorMixing) return false;
  if ((options.antiAlias ?? 2) === 0) return false;
  if (options.subTipImages && options.subTipImages.length > 1) return false;
  return WebGlBrushEngine.getInstance().isAvailable();
}

/**
 * Determines whether a radial/soft brush configuration can execute on WebGlBrushEngine.
 */
export function canUseWebGlForRadialBrush(options?: RadialMixingOptions): boolean {
  if (options?.useGpu === false) return false;
  if (options?.colorMixing) return false;
  if ((options?.antiAlias ?? 2) === 0) return false;
  return WebGlBrushEngine.getInstance().isAvailable();
}

/**
 * Flushes a collected GpuDab[] batch for a textured brush to targetCtx via WebGlBrushEngine.
 */
export function flushTexturedGpuDabs(
  ctx: CanvasRenderingContext2D,
  dabs: GpuDab[],
  tipImage: HTMLImageElement,
  color: string,
  options: TexturedBrushOptions
): boolean {
  if (dabs.length === 0) return true;
  const gpu = WebGlBrushEngine.getInstance();
  if (!gpu.isAvailable()) return false;

  const isEraser = Boolean(options.isEraser);
  const isBgEraser = Boolean(options.isBgEraser);
  const tool: ToolType = isEraser || isBgEraser ? 'eraser' : 'brush';
  const settings: BrushSettings & { alphaLocked?: boolean; isBgEraser?: boolean } = {
    size: options.size,
    minSizeFactor: options.minSizeFactor ?? 0,
    color,
    opacity: options.opacity ?? 1.0,
    flow: options.flow ?? 0.85,
    spacing: options.spacing ?? 0.08,
    usePressure: options.usePressure !== false,
    smoothing: false,
    stabilization: 0,
    hardness: options.hardness ?? 1.0,
    antiAlias: options.antiAlias ?? 2,
    wetEdge: options.wetEdge ?? 0,
    grain: options.grain ?? options.textureDensity ?? 0,
    textureDensity: options.textureDensity,
    paperTextureMode: options.paperTextureMode,
    paperTextureBrightness: options.paperTextureBrightness,
    paperTextureContrast: options.paperTextureContrast,
    paperTextureInverted: options.paperTextureInverted,
    paperTextureImage: options.paperTextureImage,
    paperTextureScale: options.paperTextureScale,
    paperTextureRotate: options.paperTextureRotate,
    customTipImage: tipImage,
    isColorTip: options.isColorTip,
    subTips: options.subTips,
    dualBrush: options.dualBrush,
    dualTipImage: options.dualTipImage,
    dualBrushCompositeMode: options.dualBrushCompositeMode as BrushSettings['dualBrushCompositeMode'],
    colorMixing: false,
    isTransparentInk: Boolean(options.isTransparentInk),
    alphaLocked: Boolean(options.alphaLocked),
    isBgEraser,
  };

  const docW = options.underlyingCanvas?.width || ctx.canvas?.width || 1024;
  const docH = options.underlyingCanvas?.height || ctx.canvas?.height || 1024;
  return gpu.renderDabsToContext(ctx, dabs, settings, tool, docW, docH, options.underlyingCanvas);
}

/**
 * Flushes a collected GpuDab[] batch for a radial/soft brush to targetCtx via WebGlBrushEngine.
 */
export function flushRadialGpuDabs(
  ctx: CanvasRenderingContext2D,
  dabs: GpuDab[],
  color: string,
  hardness: number,
  isEraser: boolean,
  isBgEraser: boolean,
  mixingOptions?: RadialMixingOptions
): boolean {
  if (dabs.length === 0) return true;
  const gpu = WebGlBrushEngine.getInstance();
  if (!gpu.isAvailable()) return false;

  const tool: ToolType = isEraser || isBgEraser ? 'eraser' : 'brush';
  const settings: BrushSettings & { alphaLocked?: boolean; isBgEraser?: boolean } = {
    size: 10,
    minSizeFactor: 0,
    color,
    opacity: 1.0,
    flow: 1.0,
    spacing: 0.08,
    usePressure: true,
    smoothing: false,
    stabilization: 0,
    hardness,
    antiAlias: mixingOptions?.antiAlias ?? 2,
    wetEdge: 0,
    grain: mixingOptions?.grain ?? 0,
    paperTextureMode: mixingOptions?.paperTextureMode,
    paperTextureBrightness: mixingOptions?.paperTextureBrightness,
    paperTextureContrast: mixingOptions?.paperTextureContrast,
    paperTextureInverted: mixingOptions?.paperTextureInverted,
    paperTextureImage: mixingOptions?.paperTextureImage,
    paperTextureScale: mixingOptions?.paperTextureScale,
    paperTextureRotate: mixingOptions?.paperTextureRotate,
    dualBrush: mixingOptions?.dualBrush,
    dualTipImage: mixingOptions?.dualTipImage,
    dualBrushCompositeMode: mixingOptions?.dualBrushCompositeMode as BrushSettings['dualBrushCompositeMode'],
    colorMixing: false,
    isTransparentInk: Boolean(mixingOptions?.isTransparentInk),
    alphaLocked: Boolean(mixingOptions?.alphaLocked),
    isBgEraser,
  };

  const docW = mixingOptions?.underlyingCanvas?.width || ctx.canvas?.width || 1024;
  const docH = mixingOptions?.underlyingCanvas?.height || ctx.canvas?.height || 1024;
  return gpu.renderDabsToContext(ctx, dabs, settings, tool, docW, docH, mixingOptions?.underlyingCanvas);
}

/**
 * Draws a single textured dot at pointer down.
 */
export function drawTexturedDot(
  ctx: CanvasRenderingContext2D,
  point: Point,
  color: string,
  tipImage: HTMLImageElement,
  options: TexturedBrushOptions,
  batchGpuDabs?: GpuDab[]
) {
  const isEraser = options.isEraser ?? false;
  const isBgEraser = options.isBgEraser ?? false;
  let effectiveColor = isBgEraser ? '#ffffff' : color;
  const baseDensity = options.brushDensity ?? options.flow ?? 0.85;
  let effectiveFlow = computeGapAdjustedAlpha(baseDensity, options.spacing ?? 0.08, options.adjustDensityByGap);

  const effPressure = evaluateFastSpline(point.pressure, options.pressureCurve);
  const minFactor = options.minSizeFactor ?? 0.2;
  const effWidth = point.width > 0
    ? Math.max(0.4, point.width)
    : Math.max(0.5, options.size * (minFactor + (1.0 - minFactor) * effPressure));

  const isColorMixing = Boolean(options.colorMixing) && !isEraser;

  if (isColorMixing) {
    if (!options.reservoir) {
      options.reservoir = new PaintReservoir(color);
    }

    let sampled = { r: 255, g: 255, b: 255, a: 0 };
    if (options.sampler) {
      sampled = options.sampler.sampleColor(point.x, point.y, Math.max(2, effWidth / 2));
    } else {
      const sampleCanvas = options.underlyingCanvas || ctx.canvas;
      const sampleCtx = sampleCanvas ? sampleCanvas.getContext('2d') : null;
      if (sampleCtx) {
        sampled = sampleCanvasColor(sampleCtx, point.x, point.y, Math.max(2, effWidth / 2));
      }
    }

    const mixed = options.reservoir.mixWithCanvas(
      sampled,
      options.amountOfPaint ?? 0.65,
      options.densityOfPaint ?? 0.9,
      options.colorStretch ?? 0.75,
      options.mixingMode ?? 'blend',
      effPressure,
      effectiveFlow,
      0,
      options.perceptualMixing !== false
    );

    effectiveColor = mixed.colorHex;
    effectiveFlow = mixed.alpha;

    if (options.sampler) {
      options.sampler.depositDab(
        point.x,
        point.y,
        effWidth * 0.5,
        mixed.r,
        mixed.g,
        mixed.b,
        mixed.alpha
      );
    }
  }

  const gpuDabs: GpuDab[] | null = batchGpuDabs || null;
  const activeTip = selectTipImage(options.subTipImages, tipImage, options.subTipOrder, 0, 0, point.x, point.y);
  const isColorTip = Boolean(options.isColorTip || (options.subTips && options.subTips[0]?.isColor));
  const master = gpuDabs ? null : getTintedTipMaster(activeTip, effectiveColor, isColorTip);

  const aspect = (activeTip.naturalHeight || activeTip.height || 1) / (activeTip.naturalWidth || activeTip.width || 1);
  const thickness = options.thickness ?? 1.0;
  const isVert = Boolean(options.thicknessVertical);
  const useTilt = Boolean(options.useTilt || options.angleDynamics === 'tilt');

  const tiltX = useTilt ? (point.tiltX ?? 0) : 0;
  const tiltY = useTilt ? (point.tiltY ?? 0) : 0;
  const tiltAngleDeg = Math.min(90, Math.sqrt(tiltX * tiltX + tiltY * tiltY));
  const tiltMagnitude = Math.sin((tiltAngleDeg * Math.PI) / 180);
  const tiltSpread = tiltMagnitude * (options.tiltScale ?? 1.0);
  const grainPressure = useTilt && tiltMagnitude > 0.01
    ? effPressure * (1.0 - tiltMagnitude * 0.55)
    : effPressure;

  let angleRad = ((options.angle ?? 0) * Math.PI) / 180;
  if (useTilt && tiltMagnitude > 0.05) {
    angleRad = Math.atan2(tiltY, tiltX) + angleRad;
  }
  if (point.twist && (options.angleDynamics === 'twist' || useTilt)) {
    angleRad += (point.twist * Math.PI) / 180;
  }

  const sensorOpacity = evaluateCspSensor(
    options.opacitySensor,
    effPressure,
    tiltMagnitude,
    0,
    dabHashFloat(point.x, point.y, 0, 41)
  );
  const sensorDensity = evaluateCspSensor(
    options.densitySensor,
    effPressure,
    tiltMagnitude,
    0,
    dabHashFloat(point.x, point.y, 0, 42)
  );
  effectiveFlow *= sensorOpacity * sensorDensity;
  if (useTilt && tiltMagnitude > 0.03) {
    // Contact pressure spreads over larger tilted area -> softer graphite/chalk deposition
    effectiveFlow *= 1.0 - tiltMagnitude * 0.28;
  }

  // CPU Paper Texture modulation when not rendering on GPU (GPU shader samples paper grain per pixel)
  const grainAmount = options.grain ?? options.textureDensity ?? 0;
  const hasPerPixelCpuGrain = !gpuDabs && grainAmount > 0.005 && typeof ctx.createPattern === 'function';
  if (!gpuDabs && grainAmount > 0.005 && !hasPerPixelCpuGrain) {
    const scale = Math.max(0.1, options.paperTextureScale ?? 1.0);
    const gNorm = getPaperGrain(point.x / scale, point.y / scale) / 255.0;
    effectiveFlow = applyCspPaperTextureAlpha(
      effectiveFlow,
      gNorm,
      grainAmount,
      grainPressure,
      options.paperTextureMode ?? 'subtract',
      options.paperTextureBrightness ?? 0,
      options.paperTextureContrast ?? 0,
      Boolean(options.paperTextureInverted)
    );
  }
  if (effectiveFlow <= 0.002) return;

  const dynamics = options.dynamics;
  const dabCount = Math.max(1, Math.min(10, Math.round(dynamics?.count ?? 1)));
  const sizeJitter = Math.max(0, Math.min(1, dynamics?.sizeJitter ?? 0));
  const angleJitter = Math.max(0, Math.min(1, dynamics?.angleJitter ?? 0));
  const roundnessJitter = Math.max(0, Math.min(1, dynamics?.roundnessJitter ?? 0));
  const scatter = Math.max(0, Math.min(5, dynamics?.scatter ?? 0));
  const flowJitter = Math.max(0, Math.min(1, dynamics?.flowJitter ?? 0));
  const colorJitterEnabled = Boolean(dynamics?.colorJitterEnabled);
  const primRgb = (colorJitterEnabled || gpuDabs) ? parseColorToRgb(effectiveColor) : null;
  const secRgb = colorJitterEnabled ? parseColorToRgb(options.secondaryColor || '#ffffff') : null;
  const aaMode = options.antiAlias ?? 2;

  for (let k = 0; k < dabCount; k++) {
    let curDabW = effWidth;
    if (sizeJitter > 0) {
      curDabW *= Math.max(0.01, 1.0 - dabHashFloat(point.x, point.y, k, 1) * sizeJitter);
    }
    curDabW = Math.max(0.1, curDabW);

    let curDabThickness = thickness;
    if (roundnessJitter > 0) {
      curDabThickness *= Math.max(0.05, 1.0 - dabHashFloat(point.x, point.y, k, 2) * roundnessJitter);
    }

    let curDabAngle = angleRad;
    if (angleJitter > 0) {
      curDabAngle += (dabHashFloat(point.x, point.y, k, 3) - 0.5) * Math.PI * 2 * angleJitter;
    }

    let curDabX = point.x;
    let curDabY = point.y;
    if (scatter > 0) {
      const th = dabHashFloat(point.x, point.y, k, 4) * Math.PI * 2;
      const sDist = dabHashFloat(point.x, point.y, k, 5) * effWidth * scatter;
      curDabX += Math.cos(th) * sDist;
      curDabY += Math.sin(th) * sDist;
    }

    let curDabAlpha = effectiveFlow;
    if (flowJitter > 0) {
      curDabAlpha *= Math.max(0.005, 1.0 - dabHashFloat(point.x, point.y, k, 6) * flowJitter);
    }

    let curMaster = master;
    let dabR = primRgb ? primRgb.r / 255 : 0;
    let dabG = primRgb ? primRgb.g / 255 : 0;
    let dabB = primRgb ? primRgb.b / 255 : 0;
    if (colorJitterEnabled && primRgb && secRgb && dynamics) {
      let salt = 20;
      const cd = applyColorDynamics(
        { r: primRgb.r / 255, g: primRgb.g / 255, b: primRgb.b / 255 },
        { r: secRgb.r / 255, g: secRgb.g / 255, b: secRgb.b / 255 },
        dynamics,
        () => dabHashFloat(point.x, point.y, k, salt++)
      );
      dabR = cd.r;
      dabG = cd.g;
      dabB = cd.b;
      if (!gpuDabs) {
        curMaster = getTintedTipMaster(activeTip, cd.hex, isColorTip);
      }
    }

    let dotRenderW = isVert ? curDabW * curDabThickness : curDabW;
    let dotRenderH = isVert ? curDabW * aspect : curDabW * aspect * curDabThickness;
    if (useTilt && tiltMagnitude > 0.01) {
      dotRenderW *= 1.0 + tiltSpread * 1.85;
      dotRenderH *= Math.max(0.55, 1.0 - tiltMagnitude * 0.25);
    }
    const flips = resolveTipFlipSigns(options.flipH, options.flipV, k, curDabX, curDabY);

    if (curMaster && hasPerPixelCpuGrain) {
      const grained = applyCpuPerPixelPaperGrain(
        curMaster,
        curDabX,
        curDabY,
        dotRenderW,
        dotRenderH,
        grainAmount,
        grainPressure,
        options.paperTextureScale ?? 1.0,
        options.paperTextureImage
      );
      if (grained) curMaster = grained;
    }

    if (options.spray?.enabled) {
      const pCount = options.spray.density;
      const pSize = Math.max(1, options.spray.size);
      const radius = curDabW / 2;
      for (let i = 0; i < pCount; i++) {
        const u1 = dabHashFloat(curDabX, curDabY, k * 64 + i, 31);
        const u2 = dabHashFloat(curDabX, curDabY, k * 64 + i, 32);
        const r = radius * Math.sqrt(u1) * (1 - (options.spray.bias || 0) * (1 - u2));
        const th = Math.PI * 2 * dabHashFloat(curDabX, curDabY, k * 64 + i, 33);
        const spX = curDabX + r * Math.cos(th);
        const spY = curDabY + r * Math.sin(th);
        const spW = isVert ? pSize * curDabThickness : pSize;
        const spH = isVert ? pSize * aspect : pSize * aspect * curDabThickness;
        if (gpuDabs) {
          gpuDabs.push({
            x: spX,
            y: spY,
            width: spW,
            height: spH,
            angle: curDabAngle,
            r: dabR,
            g: dabG,
            b: dabB,
            alpha: curDabAlpha,
            pressure: grainPressure,
            strokeDist: 0,
            flipX: flips.signX,
            flipY: flips.signY,
          });
        } else if (curMaster) {
          drawSingleStamp(
            ctx,
            curMaster,
            spX,
            spY,
            spW,
            spH,
            curDabAngle,
            curDabAlpha,
            isEraser,
            isBgEraser,
            options.alphaLocked,
            options.isTransparentInk,
            flips.signX,
            flips.signY,
            aaMode,
            options.blendTipsMode
          );
        }
      }
    } else if (gpuDabs) {
      gpuDabs.push({
        x: curDabX,
        y: curDabY,
        width: dotRenderW,
        height: dotRenderH,
        angle: curDabAngle,
        r: dabR,
        g: dabG,
        b: dabB,
        alpha: curDabAlpha,
        pressure: grainPressure,
        strokeDist: 0,
        flipX: flips.signX,
        flipY: flips.signY,
      });
    } else if (curMaster) {
      drawSingleStamp(
        ctx,
        curMaster,
        curDabX,
        curDabY,
        dotRenderW,
        dotRenderH,
        curDabAngle,
        curDabAlpha,
        isEraser,
        isBgEraser,
        options.alphaLocked,
        options.isTransparentInk,
        flips.signX,
        flips.signY,
        aaMode,
        options.blendTipsMode
      );
    }
  }
}

// -------------------------------------------------------------
// Cubic Bézier Evaluation & Zero-Allocation Arc-Length Scratch
// -------------------------------------------------------------

export interface EvaluatedBezierSample {
  x: number;
  y: number;
  width: number;
  pressure: number;
  dx: number;
  dy: number;
  speed: number;
  tiltX: number;
  tiltY: number;
  twist: number;
}

const _sharedSample: EvaluatedBezierSample = {
  x: 0,
  y: 0,
  width: 0,
  pressure: 0,
  dx: 0,
  dy: 0,
  speed: 0,
  tiltX: 0,
  tiltY: 0,
  twist: 0,
};

function evalCubicBezierInto(
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  t: number,
  out: EvaluatedBezierSample
): EvaluatedBezierSample {
  const invT = 1.0 - t;
  const invT2 = invT * invT;
  const invT3 = invT2 * invT;
  const t2 = t * t;
  const t3 = t2 * t;

  const b = 3.0 * invT2 * t;
  const c = 3.0 * invT * t2;

  out.x = invT3 * p0.x + b * c1.x + c * c2.x + t3 * p3.x;
  out.y = invT3 * p0.y + b * c1.y + c * c2.y + t3 * p3.y;
  out.width = invT3 * p0.width + b * c1.width + c * c2.width + t3 * p3.width;
  out.pressure = invT3 * p0.pressure + b * c1.pressure + c * c2.pressure + t3 * p3.pressure;
  out.tiltX = invT * (p0.tiltX ?? 0) + t * (p3.tiltX ?? 0);
  out.tiltY = invT * (p0.tiltY ?? 0) + t * (p3.tiltY ?? 0);
  out.twist = invT * (p0.twist ?? 0) + t * (p3.twist ?? 0);

  const dx = 3.0 * invT2 * (c1.x - p0.x) + 6.0 * invT * t * (c2.x - c1.x) + 3.0 * t2 * (p3.x - c2.x);
  const dy = 3.0 * invT2 * (c1.y - p0.y) + 6.0 * invT * t * (c2.y - c1.y) + 3.0 * t2 * (p3.y - c2.y);
  out.dx = dx;
  out.dy = dy;
  out.speed = Math.hypot(dx, dy);
  return out;
}

export function evalCubicBezier(
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  t: number
): { x: number; y: number; width: number; pressure: number; dx: number; dy: number; speed: number; tiltX?: number; tiltY?: number; twist?: number } {
  const out: EvaluatedBezierSample = {
    x: 0, y: 0, width: 0, pressure: 0, dx: 0, dy: 0, speed: 0, tiltX: 0, tiltY: 0, twist: 0,
  };
  return evalCubicBezierInto(p0, c1, c2, p3, t, out);
}

export interface ArcLengthTable {
  totalLength: number;
  distances: number[];
}

// Fast reusable internal Float64Array arc-length scratch to avoid per-segment heap allocations
const _fastArcDistances = new Float64Array(65);

function buildFastArcLengthScratch(p0: Point, c1: Point, c2: Point, p3: Point): { totalLength: number; steps: number } {
  const polyLen =
    Math.hypot(c1.x - p0.x, c1.y - p0.y) +
    Math.hypot(c2.x - c1.x, c2.y - c1.y) +
    Math.hypot(p3.x - c2.x, p3.y - c2.y);
  const steps = Math.max(24, Math.min(64, Math.ceil(polyLen * 0.5)));
  _fastArcDistances[0] = 0;
  let total = 0;
  let prevX = p0.x;
  let prevY = p0.y;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const invT = 1.0 - t;
    const invT2 = invT * invT;
    const invT3 = invT2 * invT;
    const t2 = t * t;
    const t3 = t2 * t;

    const x = invT3 * p0.x + 3.0 * invT2 * t * c1.x + 3.0 * invT * t2 * c2.x + t3 * p3.x;
    const y = invT3 * p0.y + 3.0 * invT2 * t * c1.y + 3.0 * invT * t2 * c2.y + t3 * p3.y;

    total += Math.hypot(x - prevX, y - prevY);
    _fastArcDistances[i] = total;
    prevX = x;
    prevY = y;
  }

  return { totalLength: total, steps };
}

function sampleFastArcLengthInto(
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  targetDist: number,
  totalLength: number,
  steps: number,
  out: EvaluatedBezierSample
): EvaluatedBezierSample {
  if (totalLength <= 0.0001 || targetDist <= 0) {
    return evalCubicBezierInto(p0, c1, c2, p3, 0, out);
  }
  if (targetDist >= totalLength) {
    return evalCubicBezierInto(p0, c1, c2, p3, 1.0, out);
  }

  let low = 0;
  let high = steps - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (_fastArcDistances[mid] <= targetDist) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const d0 = _fastArcDistances[low];
  const d1 = _fastArcDistances[low + 1];
  const frac = d1 > d0 ? (targetDist - d0) / (d1 - d0) : 0;
  const t = (low + frac) / steps;
  return evalCubicBezierInto(p0, c1, c2, p3, Math.max(0, Math.min(1.0, t)), out);
}

export function buildCubicArcLengthTable(p0: Point, c1: Point, c2: Point, p3: Point): ArcLengthTable {
  const { totalLength, steps } = buildFastArcLengthScratch(p0, c1, c2, p3);
  const distances: number[] = new Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    distances[i] = _fastArcDistances[i];
  }
  return { totalLength, distances };
}

export function getCubicPointAtArcLength(
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  targetDist: number,
  table: ArcLengthTable
): { x: number; y: number; width: number; pressure: number; dx: number; dy: number; speed: number; tiltX?: number; tiltY?: number; twist?: number } {
  const { totalLength, distances } = table;
  if (totalLength <= 0.0001 || targetDist <= 0) {
    return evalCubicBezier(p0, c1, c2, p3, 0);
  }
  if (targetDist >= totalLength) {
    return evalCubicBezier(p0, c1, c2, p3, 1.0);
  }

  const steps = distances.length - 1;
  let low = 0;
  let high = steps - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (distances[mid] <= targetDist) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const idx = low;
  const d0 = distances[idx];
  const d1 = distances[idx + 1];
  const frac = d1 > d0 ? (targetDist - d0) / (d1 - d0) : 0;
  const t = (idx + frac) / steps;

  return evalCubicBezier(p0, c1, c2, p3, Math.max(0, Math.min(1.0, t)));
}

/**
 * Draws textured CSP brush stamps along a cubic Bézier curve using zero-allocation arc-length parameterization.
 */
export function drawTexturedCubicBezierSegment(
  ctx: CanvasRenderingContext2D,
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  color: string,
  tipImage: HTMLImageElement,
  options: TexturedBrushOptions,
  remainderDist: number = 0,
  dabCounter: { count: number } = { count: 0 },
  batchGpuDabs?: GpuDab[]
): number {
  const { totalLength: totalCurveLength, steps: arcSteps } = buildFastArcLengthScratch(p0, c1, c2, p3);
  if (totalCurveLength < 0.08) {
    return Math.max(0, remainderDist - totalCurveLength);
  }

  const isEraser = options.isEraser ?? false;
  const isBgEraser = options.isBgEraser ?? false;
  const baseColor = isBgEraser ? '#ffffff' : color;

  const isColorMixing = Boolean(options.colorMixing) && !isEraser;
  const sampler = options.sampler;

  if (isColorMixing && !options.reservoir) {
    options.reservoir = new PaintReservoir(color);
  }

  const reservoir = options.reservoir;
  const aspect = (tipImage.naturalHeight || tipImage.height || 1) / (tipImage.naturalWidth || tipImage.width || 1);
  const baseAngleRad = ((options.angle ?? 0) * Math.PI) / 180;
  const rawDensity = options.brushDensity ?? options.flow ?? 0.85;
  const spacingRatio = Math.max(0.015, Math.min(1.0, options.spacing ?? 0.07));
  const baseFlow = computeGapAdjustedAlpha(rawDensity, spacingRatio, options.adjustDensityByGap);
  const thickness = options.thickness ?? 1.0;
  const isVert = Boolean(options.thicknessVertical);
  const rotationRandomScale = options.rotationRandomScale ?? 0;
  const useTilt = Boolean(options.useTilt || options.angleDynamics === 'tilt');
  const aaMode = options.antiAlias ?? 2;
  const grainAmount = options.grain ?? options.textureDensity ?? 0;

  const gpuDabs: GpuDab[] | null = batchGpuDabs || null;

  let smoothCos = Math.cos(baseAngleRad);
  let smoothSin = Math.sin(baseAngleRad);

  let currentDist = remainderDist > 0 ? remainderDist : 0;

  while (currentDist <= totalCurveLength) {
    const pt = sampleFastArcLengthInto(p0, c1, c2, p3, currentDist, totalCurveLength, arcSteps, _sharedSample);
    const effPressure = Math.max(0, Math.min(1, pt.pressure));
    const curvedPressure = options.pressureCurve ? evaluateFastSpline(effPressure, options.pressureCurve) : effPressure;
    const minFactor = Math.max(0, Math.min(1.0, options.minSizeFactor ?? 0));

    let curWidth = pt.width > 0
      ? pt.width
      : (options.usePressure !== false
          ? options.size * (minFactor + (1.0 - minFactor) * curvedPressure)
          : options.size);

    const strokeDist = (options.currentStrokeDist ?? 0) + currentDist;

    // CSP Starting & Ending taper modulation (supports sharpness curves + Size/Density/Opacity targets)
    let taperAlphaScale = 1.0;
    if (options.taper) {
      const inSharp = 0.35 + (1.0 - (options.taper.startingSharpness ?? 0.5)) * 1.1;
      const outSharp = 0.35 + (1.0 - (options.taper.endingSharpness ?? 0.5)) * 1.1;
      const inLen = options.taper.inLength || (options.taper.inRatio ? options.taper.inRatio * 2.5 : 0);
      if (options.taper.useIn && inLen > 0 && strokeDist < inLen) {
        const inFactor = Math.pow(Math.max(0.01, Math.min(1.0, strokeDist / inLen)), inSharp);
        if (options.taper.affectSize !== false) curWidth *= inFactor;
        if (options.taper.affectDensity || options.taper.affectOpacity) taperAlphaScale *= inFactor;
      }
      if (options.totalLength && options.totalLength > 0) {
        const distFromEnd = options.totalLength - strokeDist;
        const outLen = options.taper.outLength || (options.taper.outRatio ? options.taper.outRatio * 3.0 : 0);
        if (options.taper.useOut && outLen > 0 && distFromEnd < outLen) {
          const outFactor = Math.pow(Math.max(0.01, Math.min(1.0, distFromEnd / outLen)), outSharp);
          if (options.taper.affectSize !== false) curWidth *= outFactor;
          if (options.taper.affectDensity || options.taper.affectOpacity) taperAlphaScale *= outFactor;
        }
      }
    }

    const dabSeq = dabCounter.count++;

    const tiltX = useTilt ? pt.tiltX : 0;
    const tiltY = useTilt ? pt.tiltY : 0;
    const tiltAngleDeg = Math.min(90, Math.sqrt(tiltX * tiltX + tiltY * tiltY));
    const tiltMagnitude = Math.sin((tiltAngleDeg * Math.PI) / 180);
    const tiltSpread = tiltMagnitude * (options.tiltScale ?? 1.0);
    const grainPressure = useTilt && tiltMagnitude > 0.01
      ? effPressure * (1.0 - tiltMagnitude * 0.55)
      : effPressure;

    // Multi-sensor CSP size modulation
    if (options.sizeSensor) {
      curWidth *= evaluateCspSensor(
        options.sizeSensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 50)
      );
    }
    curWidth = Math.max(0.1, curWidth);

    let stampAngle = baseAngleRad;
    if ((options.angleDynamics === 'direction' || options.angleDynamics === 'direction-random') && pt.speed > 0.05) {
      const targetAngle = Math.atan2(pt.dy, pt.dx) + baseAngleRad;
      const tCos = Math.cos(targetAngle);
      const tSin = Math.sin(targetAngle);
      smoothCos = smoothCos * 0.6 + tCos * 0.4;
      smoothSin = smoothSin * 0.6 + tSin * 0.4;
      stampAngle = Math.atan2(smoothSin, smoothCos);
    }
    if (options.angleDynamics === 'random' || options.angleDynamics === 'direction-random') {
      const rScale = options.angleDynamics === 'random' ? 1.0 : (rotationRandomScale || 0.35);
      stampAngle += (dabHashFloat(pt.x, pt.y, dabSeq, 12) - 0.5) * Math.PI * 2 * rScale;
    } else if (rotationRandomScale > 0) {
      stampAngle += (dabHashFloat(pt.x, pt.y, dabSeq, 12) - 0.5) * Math.PI * 2 * rotationRandomScale;
    }

    if (useTilt && tiltMagnitude > 0.05) {
      stampAngle = Math.atan2(tiltY, tiltX) + baseAngleRad;
    }
    if (pt.twist && (options.angleDynamics === 'twist' || useTilt)) {
      stampAngle += (pt.twist * Math.PI) / 180;
    }

    let dabColor = baseColor;
    let dabAlpha = baseFlow * taperAlphaScale;

    if (options.opacitySensor) {
      dabAlpha *= evaluateCspSensor(
        options.opacitySensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 51)
      );
    }
    if (options.densitySensor) {
      dabAlpha *= evaluateCspSensor(
        options.densitySensor,
        effPressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabSeq, 52)
      );
    }
    if (useTilt && tiltMagnitude > 0.03) {
      // Spread graphite/chalk deposition over wider tilted contact patch
      dabAlpha *= 1.0 - tiltMagnitude * 0.28;
    }

    if (isColorMixing && reservoir) {
      let sampled = { r: 255, g: 255, b: 255, a: 0 };
      if (sampler) {
        sampled = sampler.sampleColor(pt.x, pt.y, curWidth * 0.45);
      } else {
        const sampleCanvas = options.underlyingCanvas || ctx.canvas;
        const sampleCtx = sampleCanvas ? sampleCanvas.getContext('2d') : null;
        if (sampleCtx) {
          sampled = sampleCanvasColor(sampleCtx, pt.x, pt.y, curWidth * 0.45);
        }
      }

      const mixed = reservoir.mixWithCanvas(
        sampled,
        options.amountOfPaint ?? 0.65,
        options.densityOfPaint ?? 0.9,
        options.colorStretch ?? 0.75,
        options.mixingMode ?? 'blend',
        effPressure,
        dabAlpha,
        Math.max(0.2, curWidth * spacingRatio),
        options.perceptualMixing !== false
      );

      dabColor = mixed.colorHex;
      dabAlpha = mixed.alpha;

      if (sampler && mixed.alpha > 0.002) {
        sampler.depositDab(
          pt.x,
          pt.y,
          curWidth * 0.45,
          mixed.r,
          mixed.g,
          mixed.b,
          mixed.alpha
        );
      }
    }

    // CPU paper grain parity (when rendering live on Canvas2D without GPU batch)
    const hasPerPixelCpuGrain = !gpuDabs && grainAmount > 0.005 && typeof ctx.createPattern === 'function';
    if (!gpuDabs && grainAmount > 0.005 && !hasPerPixelCpuGrain) {
      const scale = Math.max(0.1, options.paperTextureScale ?? 1.0);
      const gNorm = getPaperGrain(pt.x / scale, pt.y / scale) / 255.0;
      dabAlpha = applyCspPaperTextureAlpha(
        dabAlpha,
        gNorm,
        grainAmount,
        grainPressure,
        options.paperTextureMode ?? 'subtract',
        options.paperTextureBrightness ?? 0,
        options.paperTextureContrast ?? 0,
        Boolean(options.paperTextureInverted)
      );
    }

    const activeTip = selectTipImage(
      options.subTipImages,
      tipImage,
      options.subTipOrder,
      dabSeq,
      stampAngle,
      pt.x,
      pt.y
    );
    const isColorTip = Boolean(options.isColorTip || (options.subTips && options.subTips[0]?.isColor));
    const master = gpuDabs ? null : getTintedTipMaster(activeTip, dabColor, isColorTip);

    let tx = 1;
    let ty = 0;
    let nx = 0;
    let ny = 1;
    if (pt.speed > 0.001) {
      tx = pt.dx / pt.speed;
      ty = pt.dy / pt.speed;
      nx = -ty;
      ny = tx;
    }

    const dynamics = options.dynamics;
    const dabCount = Math.max(1, Math.min(10, Math.round(dynamics?.count ?? 1)));
    const sizeJitter = Math.max(0, Math.min(1, dynamics?.sizeJitter ?? 0));
    const angleJitter = Math.max(0, Math.min(1, dynamics?.angleJitter ?? 0));
    const roundnessJitter = Math.max(0, Math.min(1, dynamics?.roundnessJitter ?? 0));
    const scatter = Math.max(0, Math.min(5, dynamics?.scatter ?? 0));
    const scatterBothAxes = Boolean(dynamics?.scatterBothAxes);
    const flowJitter = Math.max(0, Math.min(1, dynamics?.flowJitter ?? 0));
    const colorJitterEnabled = Boolean(dynamics?.colorJitterEnabled);
    const primRgb = (colorJitterEnabled || gpuDabs) ? parseColorToRgb(dabColor) : null;
    const secRgb = colorJitterEnabled ? parseColorToRgb(options.secondaryColor || '#ffffff') : null;

    let stepRefW = isVert ? curWidth * thickness : curWidth;
    let stepRefH = isVert ? curWidth * aspect : curWidth * aspect * thickness;

    for (let k = 0; k < dabCount; k++) {
      const seedIdx = dabSeq * 16 + k;
      let curDabW = curWidth;
      if (sizeJitter > 0) {
        curDabW *= Math.max(0.01, 1.0 - dabHashFloat(pt.x, pt.y, seedIdx, 1) * sizeJitter);
      }
      curDabW = Math.max(0.1, curDabW);

      let curDabThickness = thickness;
      if (roundnessJitter > 0) {
        curDabThickness *= Math.max(0.05, 1.0 - dabHashFloat(pt.x, pt.y, seedIdx, 2) * roundnessJitter);
      }

      let curDabAngle = stampAngle;
      if (angleJitter > 0) {
        curDabAngle += (dabHashFloat(pt.x, pt.y, seedIdx, 3) - 0.5) * Math.PI * 2 * angleJitter;
      }

      let curDabX = pt.x;
      let curDabY = pt.y;
      if (scatter > 0) {
        const perpDist = (dabHashFloat(pt.x, pt.y, seedIdx, 4) * 2 - 1) * curWidth * scatter;
        let sOffX = nx * perpDist;
        let sOffY = ny * perpDist;
        if (scatterBothAxes) {
          const tangDist = (dabHashFloat(pt.x, pt.y, seedIdx, 5) * 2 - 1) * curWidth * scatter;
          sOffX += tx * tangDist;
          sOffY += ty * tangDist;
        }
        curDabX += sOffX;
        curDabY += sOffY;
      }

      let curDabAlpha = dabAlpha;
      if (flowJitter > 0) {
        curDabAlpha *= Math.max(0.005, 1.0 - dabHashFloat(pt.x, pt.y, seedIdx, 6) * flowJitter);
      }

      let curMaster = master;
      let dabR = primRgb ? primRgb.r / 255 : 0;
      let dabG = primRgb ? primRgb.g / 255 : 0;
      let dabB = primRgb ? primRgb.b / 255 : 0;

      if (colorJitterEnabled && primRgb && secRgb && dynamics) {
        let salt = 20;
        const cd = applyColorDynamics(
          { r: primRgb.r / 255, g: primRgb.g / 255, b: primRgb.b / 255 },
          { r: secRgb.r / 255, g: secRgb.g / 255, b: secRgb.b / 255 },
          dynamics,
          () => dabHashFloat(pt.x, pt.y, seedIdx, salt++)
        );
        dabR = cd.r;
        dabG = cd.g;
        dabB = cd.b;
        if (!gpuDabs) {
          curMaster = getTintedTipMaster(activeTip, cd.hex, isColorTip);
        }
      }

      let finalW = isVert ? curDabW * curDabThickness : curDabW;
      let finalH = isVert ? curDabW * aspect : curDabW * aspect * curDabThickness;
      if (useTilt && tiltMagnitude > 0.01) {
        finalW *= 1.0 + tiltSpread * 1.85;
        finalH *= Math.max(0.55, 1.0 - tiltMagnitude * 0.25);
      }
      stepRefW = finalW;
      stepRefH = finalH;

      if (curDabAlpha <= 0.002) continue;

      const flips = resolveTipFlipSigns(options.flipH, options.flipV, seedIdx, curDabX, curDabY);

      if (curMaster && hasPerPixelCpuGrain) {
        const grained = applyCpuPerPixelPaperGrain(
          curMaster,
          curDabX,
          curDabY,
          finalW,
          finalH,
          grainAmount,
          grainPressure,
          options.paperTextureScale ?? 1.0,
          options.paperTextureImage
        );
        if (grained) curMaster = grained;
      }

      if (options.spray?.enabled) {
        const pCount = options.spray.density;
        const pSize = Math.max(1, options.spray.size);
        const radius = curDabW / 2;
        for (let sp = 0; sp < pCount; sp++) {
          const u1 = dabHashFloat(curDabX, curDabY, seedIdx * 64 + sp, 31);
          const u2 = dabHashFloat(curDabX, curDabY, seedIdx * 64 + sp, 32);
          const r = radius * Math.sqrt(u1) * (1 - (options.spray.bias || 0) * (1 - u2));
          const th = Math.PI * 2 * dabHashFloat(curDabX, curDabY, seedIdx * 64 + sp, 33);
          const spX = curDabX + r * Math.cos(th);
          const spY = curDabY + r * Math.sin(th);
          const spW = isVert ? pSize * curDabThickness : pSize;
          const spH = isVert ? pSize * aspect : pSize * aspect * curDabThickness;
          if (gpuDabs) {
            gpuDabs.push({
              x: spX,
              y: spY,
              width: spW,
              height: spH,
              angle: curDabAngle,
              r: dabR,
              g: dabG,
              b: dabB,
              alpha: curDabAlpha,
              pressure: grainPressure,
              strokeDist,
              flipX: flips.signX,
              flipY: flips.signY,
            });
          } else if (curMaster) {
            drawSingleStamp(
              ctx,
              curMaster,
              spX,
              spY,
              spW,
              spH,
              curDabAngle,
              curDabAlpha,
              isEraser,
              isBgEraser,
              options.alphaLocked,
              options.isTransparentInk,
              flips.signX,
              flips.signY,
              aaMode,
              options.blendTipsMode
            );
          }
        }
      } else if (gpuDabs) {
        gpuDabs.push({
          x: curDabX,
          y: curDabY,
          width: finalW,
          height: finalH,
          angle: curDabAngle,
          r: dabR,
          g: dabG,
          b: dabB,
          alpha: curDabAlpha,
          pressure: grainPressure,
          strokeDist,
          flipX: flips.signX,
          flipY: flips.signY,
        });
      } else if (curMaster) {
        drawSingleStamp(
          ctx,
          curMaster,
          curDabX,
          curDabY,
          finalW,
          finalH,
          curDabAngle,
          curDabAlpha,
          isEraser,
          isBgEraser,
          options.alphaLocked,
          options.isTransparentInk,
          flips.signX,
          flips.signY,
          aaMode,
          options.blendTipsMode
        );
      }
    }

    const requiredStep = computeEllipticalStepDistance(
      stepRefW,
      stepRefH,
      stampAngle,
      pt.dx,
      pt.dy,
      spacingRatio,
      0.15
    );
    currentDist += requiredStep;
  }

  return Math.max(0, currentDist - totalCurveLength);
}

export function drawTexturedBezierSegment(
  ctx: CanvasRenderingContext2D,
  start: Point,
  control: Point,
  end: Point,
  color: string,
  tipImage: HTMLImageElement,
  options: TexturedBrushOptions,
  remainderDist: number = 0,
  dabCounter: { count: number } = { count: 0 }
): number {
  const c1: Point = {
    x: start.x + (2.0 / 3.0) * (control.x - start.x),
    y: start.y + (2.0 / 3.0) * (control.y - start.y),
    pressure: start.pressure + (2.0 / 3.0) * (control.pressure - start.pressure),
    width: start.width + (2.0 / 3.0) * (control.width - start.width),
  };
  const c2: Point = {
    x: end.x + (2.0 / 3.0) * (control.x - end.x),
    y: end.y + (2.0 / 3.0) * (control.y - end.y),
    pressure: end.pressure + (2.0 / 3.0) * (control.pressure - end.pressure),
    width: end.width + (2.0 / 3.0) * (control.width - end.width),
  };
  return drawTexturedCubicBezierSegment(
    ctx,
    start,
    c1,
    c2,
    end,
    color,
    tipImage,
    options,
    remainderDist,
    dabCounter
  );
}

export function renderCompleteTexturedStroke(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  tipImage: HTMLImageElement,
  options: TexturedBrushOptions
) {
  if (!points || points.length === 0) return;

  if (options.colorMixing && !options.reservoir) {
    options.reservoir = new PaintReservoir(color);
  }
  if (!options.underlyingCanvas) {
    options.underlyingCanvas = ctx.canvas;
  }
  if (options.colorMixing && !options.sampler && options.underlyingCanvas) {
    options.sampler = new LayerPixelSampler(options.underlyingCanvas);
  }

  let totalLen = 0;
  for (let i = 1; i < points.length; i++) {
    totalLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  options.totalLength = totalLen;
  options.currentStrokeDist = 0;

  const emitStroke = (batchGpuDabs: GpuDab[] | undefined) => {
    options.currentStrokeDist = 0;
    drawTexturedDot(ctx, points[0], color, tipImage, options, batchGpuDabs);
    if (points.length === 1) return;

    const dabCounter = { count: 0 };
    let accDist = Math.max(0.15, points[0].width * (options.spacing ?? 0.07));

    if (points.length === 2) {
      const p0 = points[0];
      const p1 = points[1];
      const { c1, c2 } = centripetalCatmullRomToBezier(p0, p0, p1, p1);
      drawTexturedCubicBezierSegment(ctx, p0, c1, c2, p1, color, tipImage, options, accDist, dabCounter, batchGpuDabs);
    } else {
      const p0 = points[0];
      const p1 = points[1];
      const p2 = points[2];
      const first = centripetalCatmullRomToBezier(p0, p0, p1, p2);
      accDist = drawTexturedCubicBezierSegment(ctx, p0, first.c1, first.c2, p1, color, tipImage, options, accDist, dabCounter, batchGpuDabs);
      options.currentStrokeDist = (options.currentStrokeDist ?? 0) + Math.hypot(p1.x - p0.x, p1.y - p0.y);

      for (let i = 2; i < points.length - 1; i++) {
        const seg = centripetalCatmullRomToBezier(points[i - 2], points[i - 1], points[i], points[i + 1]);
        accDist = drawTexturedCubicBezierSegment(ctx, points[i - 1], seg.c1, seg.c2, points[i], color, tipImage, options, accDist, dabCounter, batchGpuDabs);
        options.currentStrokeDist = (options.currentStrokeDist ?? 0) + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      }

      const n = points.length;
      const pPrev2 = points[n - 3];
      const pPrev = points[n - 2];
      const pLast = points[n - 1];
      const last = centripetalCatmullRomToBezier(pPrev2, pPrev, pLast, pLast);
      drawTexturedCubicBezierSegment(ctx, pPrev, last.c1, last.c2, pLast, color, tipImage, options, accDist, dabCounter, batchGpuDabs);
    }
  };

  if (canUseWebGlForTexturedBrush(options)) {
    const batchGpuDabs: GpuDab[] = [];
    emitStroke(batchGpuDabs);
    if (flushTexturedGpuDabs(ctx, batchGpuDabs, tipImage, color, options)) {
      return;
    }
  }

  // Clean Canvas 2D fallback (binary AA=0, colorMixingEngine, multi-subTip, or unavailable WebGL)
  emitStroke(undefined);
}

/**
 * Centripetal Catmull-Rom spline (alpha = 0.5) to cubic Bézier control points.
 */
export function centripetalCatmullRomToBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point
): { c1: Point; c2: Point } {
  const effP0 = p1.isCorner ? p1 : p0;
  const effP3 = p2.isCorner ? p2 : p3;

  const d01 = Math.hypot(p1.x - effP0.x, p1.y - effP0.y);
  const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const d23 = Math.hypot(effP3.x - p2.x, effP3.y - p2.y);

  const dt0 = Math.max(1e-4, Math.sqrt(d01));
  const dt1 = Math.max(1e-4, Math.sqrt(d12));
  const dt2 = Math.max(1e-4, Math.sqrt(d23));

  const t1x = (p2.x - p1.x) / dt1 - (p1.x - effP0.x) / dt0 + (p2.x - effP0.x) / (dt0 + dt1);
  const t1y = (p2.y - p1.y) / dt1 - (p1.y - effP0.y) / dt0 + (p2.y - effP0.y) / (dt0 + dt1);
  const t2x = (effP3.x - p2.x) / dt2 - (p2.x - p1.x) / dt1 + (effP3.x - p1.x) / (dt1 + dt2);
  const t2y = (effP3.y - p2.y) / dt2 - (p2.y - p1.y) / dt1 + (effP3.y - p1.y) / (dt1 + dt2);

  let dx1 = (t1x * dt1) / 3;
  let dy1 = (t1y * dt1) / 3;
  let dx2 = (t2x * dt1) / 3;
  let dy2 = (t2y * dt1) / 3;

  if (d12 > 0.001) {
    const maxHandle = d12 * 0.48;
    const len1 = Math.hypot(dx1, dy1);
    if (len1 > maxHandle) {
      const s = maxHandle / len1;
      dx1 *= s;
      dy1 *= s;
    }
    const len2 = Math.hypot(dx2, dy2);
    if (len2 > maxHandle) {
      const s = maxHandle / len2;
      dx2 *= s;
      dy2 *= s;
    }
  }

  const minP = Math.min(p1.pressure, p2.pressure);
  const maxP = Math.max(p1.pressure, p2.pressure);
  const minW = Math.min(p1.width, p2.width);
  const maxW = Math.max(p1.width, p2.width);

  const c1: Point = {
    x: p1.x + dx1,
    y: p1.y + dy1,
    pressure: Math.max(minP, Math.min(maxP, p1.pressure + (p2.pressure - effP0.pressure) / 6)),
    width: Math.max(minW, Math.min(maxW, p1.width + (p2.width - effP0.width) / 6)),
  };

  const c2: Point = {
    x: p2.x - dx2,
    y: p2.y - dy2,
    pressure: Math.max(minP, Math.min(maxP, p2.pressure - (effP3.pressure - p1.pressure) / 6)),
    width: Math.max(minW, Math.min(maxW, p2.width - (effP3.width - p1.width) / 6)),
  };

  return { c1, c2 };
}

export interface RadialMixingOptions {
  colorMixing?: boolean;
  perceptualMixing?: boolean;
  amountOfPaint?: number;
  densityOfPaint?: number;
  colorStretch?: number;
  mixingMode?: 'blend' | 'running_color' | 'smear';
  underlyingCanvas?: HTMLCanvasElement;
  sampler?: LayerPixelSampler;
  reservoir?: PaintReservoir;
  alphaLocked?: boolean;
  isTransparentInk?: boolean;
  dynamics?: BrushDynamics;
  secondaryColor?: string;
  useGpu?: boolean;
  dualBrush?: boolean;
  dualTipImage?: HTMLImageElement;
  dualBrushCompositeMode?: string;
  // Extended CSP Options for analytical round/elliptical brushes
  useTilt?: boolean;
  tiltScale?: number;
  thicknessVertical?: boolean;
  flipH?: CspTipFlipMode;
  flipV?: CspTipFlipMode;
  antiAlias?: number;
  angleDynamics?: CspAngleDynamicsMode;
  rotationRandomScale?: number;
  adjustDensityByGap?: boolean;
  blendTipsMode?: CspBlendTipsMode;
  grain?: number;
  paperTextureMode?: CspPaperTextureMode;
  paperTextureBrightness?: number;
  paperTextureContrast?: number;
  paperTextureInverted?: boolean;
  paperTextureImage?: HTMLImageElement;
  paperTextureScale?: number;
  paperTextureRotate?: number;
  sizeSensor?: CspSensorConfig;
  opacitySensor?: CspSensorConfig;
  densitySensor?: CspSensorConfig;
  taper?: CspTaperSettings;
  totalLength?: number;
  currentStrokeDist?: number;
}

/**
 * Draws a single radial/elliptical dot.
 */
export function drawRadialDot(
  ctx: CanvasRenderingContext2D,
  point: Point,
  color: string,
  hardness: number = 1.0,
  flow: number = 1.0,
  isEraser: boolean = false,
  isBgEraser: boolean = false,
  mixingOptions?: RadialMixingOptions,
  thickness: number = 1.0,
  angleRad: number = 0,
  batchGpuDabs?: GpuDab[]
) {
  const isColorMixing = Boolean(mixingOptions?.colorMixing) && !isEraser && !isBgEraser;
  let dabColor = isBgEraser ? '#ffffff' : color;
  let dabFlow = computeGapAdjustedAlpha(flow, 0.08, mixingOptions?.adjustDensityByGap);
  let w = Math.max(0.4, point.width);
  const aaMode = mixingOptions?.antiAlias ?? 2;
  const isVert = Boolean(mixingOptions?.thicknessVertical);
  // Default useTilt to true ONLY when mixingOptions is undefined (legacy unit test compatibility) or explicitly true
  const useTilt = mixingOptions === undefined ? true : Boolean(mixingOptions.useTilt);
  const tiltX = useTilt ? (point.tiltX ?? 0) : 0;
  const tiltY = useTilt ? (point.tiltY ?? 0) : 0;
  const tiltAngleDeg = Math.min(90, Math.sqrt(tiltX * tiltX + tiltY * tiltY));
  const tiltMagnitude = Math.sin((tiltAngleDeg * Math.PI) / 180);
  const tiltSpread = tiltMagnitude * (mixingOptions?.tiltScale ?? 1.0);

  if (mixingOptions?.sizeSensor) {
    w = Math.max(
      0.15,
      w *
        evaluateCspSensor(
          mixingOptions.sizeSensor,
          point.pressure ?? 1.0,
          tiltMagnitude,
          0,
          dabHashFloat(point.x, point.y, 0, 50)
        )
    );
  }
  if (mixingOptions?.opacitySensor) {
    dabFlow *= evaluateCspSensor(
      mixingOptions.opacitySensor,
      point.pressure ?? 1.0,
      tiltMagnitude,
      0,
      dabHashFloat(point.x, point.y, 0, 51)
    );
  }
  if (mixingOptions?.densitySensor) {
    dabFlow *= evaluateCspSensor(
      mixingOptions.densitySensor,
      point.pressure ?? 1.0,
      tiltMagnitude,
      0,
      dabHashFloat(point.x, point.y, 0, 52)
    );
  }

  if (isColorMixing) {
    if (!mixingOptions!.reservoir) {
      mixingOptions!.reservoir = new PaintReservoir(dabColor);
    }
    const reservoir = mixingOptions!.reservoir;
    let sampled = { r: 255, g: 255, b: 255, a: 0 };
    if (mixingOptions!.sampler) {
      sampled = mixingOptions!.sampler.sampleColor(point.x, point.y, Math.max(1, w / 2));
    } else {
      const sampleCanvas = mixingOptions!.underlyingCanvas || ctx.canvas;
      const sampleCtx = sampleCanvas ? sampleCanvas.getContext('2d') : null;
      if (sampleCtx) {
        sampled = sampleCanvasColor(sampleCtx, point.x, point.y, Math.max(1, w / 2));
      }
    }

    const mixed = reservoir.mixWithCanvas(
      sampled,
      mixingOptions!.amountOfPaint ?? 0.65,
      mixingOptions!.densityOfPaint ?? 0.9,
      mixingOptions!.colorStretch ?? 0.75,
      mixingOptions!.mixingMode ?? 'blend',
      point.pressure ?? 1.0,
      dabFlow,
      0,
      mixingOptions!.perceptualMixing !== false
    );

    dabColor = mixed.colorHex;
    dabFlow = mixed.alpha;

    if (mixingOptions!.sampler && mixed.alpha > 0.002) {
      mixingOptions!.sampler.depositDab(
        point.x,
        point.y,
        w * 0.5,
        mixed.r,
        mixed.g,
        mixed.b,
        mixed.alpha
      );
    }
  }
  if (dabFlow <= 0.002) return;

  let dotW = w;
  let dotAngle = angleRad;
  if (useTilt && tiltMagnitude > 0.01) {
    const tiltAzimuth = Math.atan2(tiltY, tiltX);
    dotW = w * (1.0 + tiltSpread * 1.8);
    if (tiltMagnitude > 0.05) {
      dotAngle = tiltAzimuth;
    }
  }
  if (point.twist && (useTilt || mixingOptions?.angleDynamics === 'twist')) {
    dotAngle += (point.twist * Math.PI) / 180;
  }

  const gpuDabs: GpuDab[] | null = batchGpuDabs || null;
  const grainAmount = mixingOptions?.grain ?? 0;
  if (!gpuDabs && grainAmount > 0.005) {
    const scale = Math.max(0.1, mixingOptions?.paperTextureScale ?? 1.0);
    const gNorm = getPaperGrain(point.x / scale, point.y / scale) / 255.0;
    dabFlow = applyCspPaperTextureAlpha(
      dabFlow,
      gNorm,
      grainAmount,
      point.pressure ?? 0.5,
      mixingOptions?.paperTextureMode ?? 'subtract',
      mixingOptions?.paperTextureBrightness ?? 0,
      mixingOptions?.paperTextureContrast ?? 0,
      Boolean(mixingOptions?.paperTextureInverted)
    );
  }

  const master = gpuDabs ? null : getRadialDabMaster(hardness, dabColor, isEraser && !isBgEraser, dotW, aaMode);

  const dynamics = mixingOptions?.dynamics;
  const dabCount = Math.max(1, Math.min(10, Math.round(dynamics?.count ?? 1)));
  const sizeJitter = Math.max(0, Math.min(1, dynamics?.sizeJitter ?? 0));
  const angleJitter = Math.max(0, Math.min(1, dynamics?.angleJitter ?? 0));
  const roundnessJitter = Math.max(0, Math.min(1, dynamics?.roundnessJitter ?? 0));
  const scatter = Math.max(0, Math.min(5, dynamics?.scatter ?? 0));
  const flowJitter = Math.max(0, Math.min(1, dynamics?.flowJitter ?? 0));
  const colorJitterEnabled = Boolean(dynamics?.colorJitterEnabled);
  const primRgb = (colorJitterEnabled || gpuDabs) ? parseColorToRgb(dabColor) : null;
  const secRgb = colorJitterEnabled ? parseColorToRgb(mixingOptions?.secondaryColor || '#ffffff') : null;

  for (let k = 0; k < dabCount; k++) {
    let curDabW = dotW;
    if (sizeJitter > 0) {
      curDabW *= Math.max(0.01, 1.0 - dabHashFloat(point.x, point.y, k, 1) * sizeJitter);
    }
    curDabW = Math.max(0.1, curDabW);

    let curDabThickness = thickness;
    if (roundnessJitter > 0) {
      curDabThickness *= Math.max(0.05, 1.0 - dabHashFloat(point.x, point.y, k, 2) * roundnessJitter);
    }

    let curDabRot = dotAngle;
    if (angleJitter > 0) {
      curDabRot += (dabHashFloat(point.x, point.y, k, 3) - 0.5) * Math.PI * 2 * angleJitter;
    }

    let curDabX = point.x;
    let curDabY = point.y;
    if (scatter > 0) {
      const th = dabHashFloat(point.x, point.y, k, 4) * Math.PI * 2;
      const sDist = dabHashFloat(point.x, point.y, k, 5) * w * scatter;
      curDabX += Math.cos(th) * sDist;
      curDabY += Math.sin(th) * sDist;
    }

    let curDabFlow = dabFlow;
    if (flowJitter > 0) {
      curDabFlow *= Math.max(0.005, 1.0 - dabHashFloat(point.x, point.y, k, 6) * flowJitter);
    }

    let curMaster = master;
    let rNorm = primRgb ? primRgb.r / 255 : 0;
    let gNorm = primRgb ? primRgb.g / 255 : 0;
    let bNorm = primRgb ? primRgb.b / 255 : 0;
    if (colorJitterEnabled && primRgb && secRgb && dynamics) {
      let salt = 20;
      const cd = applyColorDynamics(
        { r: primRgb.r / 255, g: primRgb.g / 255, b: primRgb.b / 255 },
        { r: secRgb.r / 255, g: secRgb.g / 255, b: secRgb.b / 255 },
        dynamics,
        () => dabHashFloat(point.x, point.y, k, salt++)
      );
      rNorm = cd.r;
      gNorm = cd.g;
      bNorm = cd.b;
      if (!gpuDabs) {
        curMaster = getRadialDabMaster(hardness, cd.hex, isEraser && !isBgEraser, curDabW, aaMode);
      }
    }

    let finalW = isVert ? curDabW * curDabThickness : curDabW;
    let finalH = isVert ? curDabW : curDabW * curDabThickness;
    if (useTilt && tiltMagnitude > 0.01) {
      finalW = w * (1.0 + tiltSpread * 1.8);
      finalH = (w * curDabThickness) / (1.0 + tiltMagnitude * 0.5);
    }

    if (gpuDabs) {
      gpuDabs.push({
        x: curDabX,
        y: curDabY,
        width: finalW,
        height: finalH,
        angle: curDabRot,
        r: rNorm,
        g: gNorm,
        b: bNorm,
        alpha: curDabFlow,
        pressure: point.pressure ?? 1.0,
        strokeDist: 0,
        flipX: 1,
        flipY: 1,
      });
    } else if (curMaster) {
      drawSingleStamp(
        ctx,
        curMaster,
        curDabX,
        curDabY,
        finalW,
        finalH,
        curDabRot,
        curDabFlow,
        isEraser,
        isBgEraser,
        mixingOptions?.alphaLocked,
        mixingOptions?.isTransparentInk,
        1,
        1,
        aaMode,
        mixingOptions?.blendTipsMode
      );
    }
  }
}

/**
 * Draws smooth analytical radial/elliptical dabs along a cubic Bézier curve using zero-allocation arc-length parameterization.
 */
export function drawRadialCubicBezierSegment(
  ctx: CanvasRenderingContext2D,
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  color: string,
  hardness: number = 1.0,
  flow: number = 1.0,
  spacing: number = 0.08,
  isEraser: boolean = false,
  isBgEraser: boolean = false,
  remainderDist: number = 0,
  thickness: number = 1.0,
  angleRad: number = 0,
  mixingOptions?: RadialMixingOptions,
  batchGpuDabs?: GpuDab[]
): number {
  const { totalLength: totalCurveLength, steps: arcSteps } = buildFastArcLengthScratch(p0, c1, c2, p3);
  if (totalCurveLength < 0.08) {
    return Math.max(0, remainderDist - totalCurveLength);
  }

  const isColorMixing = Boolean(mixingOptions?.colorMixing) && !isEraser && !isBgEraser;
  const dynamics = mixingOptions?.dynamics;
  const gpuDabs: GpuDab[] | null = batchGpuDabs || null;
  const aaMode = mixingOptions?.antiAlias ?? 2;
  const isVert = Boolean(mixingOptions?.thicknessVertical);
  const useTilt = mixingOptions === undefined ? true : Boolean(mixingOptions.useTilt);
  const grainAmount = mixingOptions?.grain ?? 0;

  if (isColorMixing && mixingOptions && !mixingOptions.reservoir) {
    mixingOptions.reservoir = new PaintReservoir(color);
  }
  const reservoir = mixingOptions?.reservoir;
  const sampler = mixingOptions?.sampler;
  const avgSegWidth = Math.max(0.5, (p0.width + p3.width) * 0.5);
  const staticMaster = (isColorMixing || gpuDabs) ? null : getRadialDabMaster(hardness, color, isEraser && !isBgEraser, avgSegWidth, aaMode);
  const spacingRatio = Math.max(0.015, Math.min(1.0, spacing));
  const gapAdjustedFlow = computeGapAdjustedAlpha(flow, spacingRatio, mixingOptions?.adjustDensityByGap);
  let currentDist = remainderDist > 0 ? remainderDist : 0;

  const dabCount = Math.max(1, Math.min(10, Math.round(dynamics?.count ?? 1)));
  const sizeJitter = Math.max(0, Math.min(1, dynamics?.sizeJitter ?? 0));
  const angleJitter = Math.max(0, Math.min(1, dynamics?.angleJitter ?? 0));
  const roundnessJitter = Math.max(0, Math.min(1, dynamics?.roundnessJitter ?? 0));
  const scatter = Math.max(0, Math.min(5, dynamics?.scatter ?? 0));
  const scatterBothAxes = Boolean(dynamics?.scatterBothAxes);
  const flowJitter = Math.max(0, Math.min(1, dynamics?.flowJitter ?? 0));
  const colorJitterEnabled = Boolean(dynamics?.colorJitterEnabled);
  const baseRgb = (colorJitterEnabled || gpuDabs) ? parseColorToRgb(isBgEraser ? '#ffffff' : color) : null;
  const secRgb = colorJitterEnabled ? parseColorToRgb(mixingOptions?.secondaryColor || '#ffffff') : null;

  let smoothCos = Math.cos(angleRad);
  let smoothSin = Math.sin(angleRad);
  let dabStepIdx = 0;

  while (currentDist <= totalCurveLength) {
    const pt = sampleFastArcLengthInto(p0, c1, c2, p3, currentDist, totalCurveLength, arcSteps, _sharedSample);
    let curWidth = Math.max(0.2, pt.width);
    dabStepIdx++;

    const tiltX = useTilt ? pt.tiltX : 0;
    const tiltY = useTilt ? pt.tiltY : 0;
    const tiltAngleDeg = Math.min(90, Math.sqrt(tiltX * tiltX + tiltY * tiltY));
    const tiltMagnitude = Math.sin((tiltAngleDeg * Math.PI) / 180);
    const tiltSpread = tiltMagnitude * (mixingOptions?.tiltScale ?? 1.0);

    if (mixingOptions?.sizeSensor) {
      curWidth *= evaluateCspSensor(
        mixingOptions.sizeSensor,
        pt.pressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabStepIdx, 50)
      );
      curWidth = Math.max(0.15, curWidth);
    }

    let dabRot = angleRad;
    const angleMode = mixingOptions?.angleDynamics;
    if ((angleMode === 'direction' || angleMode === 'direction-random') && pt.speed > 0.05) {
      const targetA = Math.atan2(pt.dy, pt.dx) + angleRad;
      smoothCos = smoothCos * 0.6 + Math.cos(targetA) * 0.4;
      smoothSin = smoothSin * 0.6 + Math.sin(targetA) * 0.4;
      dabRot = Math.atan2(smoothSin, smoothCos);
    }
    if (angleMode === 'random' || angleMode === 'direction-random') {
      const rScale = angleMode === 'random' ? 1.0 : (mixingOptions?.rotationRandomScale || 0.35);
      dabRot += (dabHashFloat(pt.x, pt.y, dabStepIdx, 12) - 0.5) * Math.PI * 2 * rScale;
    }

    if (useTilt && tiltMagnitude > 0.05) {
      dabRot = Math.atan2(tiltY, tiltX);
    }
    if (pt.twist && (useTilt || angleMode === 'twist')) {
      dabRot += (pt.twist * Math.PI) / 180;
    }

    let dabMaster = staticMaster;
    let dabFlow = gapAdjustedFlow;
    let dabRgb = baseRgb;

    if (mixingOptions?.opacitySensor) {
      dabFlow *= evaluateCspSensor(
        mixingOptions.opacitySensor,
        pt.pressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabStepIdx, 51)
      );
    }
    if (mixingOptions?.densitySensor) {
      dabFlow *= evaluateCspSensor(
        mixingOptions.densitySensor,
        pt.pressure,
        tiltMagnitude,
        pt.speed * 0.05,
        dabHashFloat(pt.x, pt.y, dabStepIdx, 52)
      );
    }

    // Preliminary step estimate for color mixing distance integration
    const prelimStep = Math.max(0.15, curWidth * spacingRatio);

    if (isColorMixing && reservoir) {
      let sampled = { r: 255, g: 255, b: 255, a: 0 };
      if (sampler) {
        sampled = sampler.sampleColor(pt.x, pt.y, curWidth * 0.45);
      } else {
        const sampleCanvas = mixingOptions?.underlyingCanvas || ctx.canvas;
        const sampleCtx = sampleCanvas ? sampleCanvas.getContext('2d') : null;
        if (sampleCtx) {
          sampled = sampleCanvasColor(sampleCtx, pt.x, pt.y, curWidth * 0.45);
        }
      }

      const mixed = reservoir.mixWithCanvas(
        sampled,
        mixingOptions?.amountOfPaint ?? 0.65,
        mixingOptions?.densityOfPaint ?? 0.9,
        mixingOptions?.colorStretch ?? 0.75,
        mixingOptions?.mixingMode ?? 'blend',
        pt.pressure ?? 1.0,
        dabFlow,
        prelimStep,
        mixingOptions?.perceptualMixing !== false
      );

      if (!gpuDabs) {
        dabMaster = getRadialDabMaster(hardness, mixed.colorHex, false, curWidth, aaMode);
      } else {
        dabRgb = { r: mixed.r, g: mixed.g, b: mixed.b };
      }
      dabFlow = mixed.alpha;

      if (sampler && mixed.alpha > 0.002) {
        sampler.depositDab(
          pt.x,
          pt.y,
          curWidth * 0.45,
          mixed.r,
          mixed.g,
          mixed.b,
          mixed.alpha
        );
      }
    }

    if (!gpuDabs && grainAmount > 0.005) {
      const scale = Math.max(0.1, mixingOptions?.paperTextureScale ?? 1.0);
      const gNorm = getPaperGrain(pt.x / scale, pt.y / scale) / 255.0;
      dabFlow = applyCspPaperTextureAlpha(
        dabFlow,
        gNorm,
        grainAmount,
        pt.pressure ?? 0.5,
        mixingOptions?.paperTextureMode ?? 'subtract',
        mixingOptions?.paperTextureBrightness ?? 0,
        mixingOptions?.paperTextureContrast ?? 0,
        Boolean(mixingOptions?.paperTextureInverted)
      );
    }

    let tx = 1;
    let ty = 0;
    let nx = 0;
    let ny = 1;
    if (pt.speed > 0.001) {
      tx = pt.dx / pt.speed;
      ty = pt.dy / pt.speed;
      nx = -ty;
      ny = tx;
    }

    let stepRefW = isVert ? curWidth * thickness : curWidth;
    let stepRefH = isVert ? curWidth : curWidth * thickness;

    for (let k = 0; k < dabCount; k++) {
      const seedIdx = dabStepIdx * 16 + k;
      let curDabW = curWidth;
      if (sizeJitter > 0) {
        curDabW *= Math.max(0.01, 1.0 - dabHashFloat(pt.x, pt.y, seedIdx, 1) * sizeJitter);
      }
      curDabW = Math.max(0.1, curDabW);

      let curDabThickness = thickness;
      if (roundnessJitter > 0) {
        curDabThickness *= Math.max(0.05, 1.0 - dabHashFloat(pt.x, pt.y, seedIdx, 2) * roundnessJitter);
      }

      let curDabRot = dabRot;
      if (angleJitter > 0) {
        curDabRot += (dabHashFloat(pt.x, pt.y, seedIdx, 3) - 0.5) * Math.PI * 2 * angleJitter;
      }

      let curDabX = pt.x;
      let curDabY = pt.y;
      if (scatter > 0) {
        const perpDist = (dabHashFloat(pt.x, pt.y, seedIdx, 4) * 2 - 1) * curWidth * scatter;
        let sOffX = nx * perpDist;
        let sOffY = ny * perpDist;
        if (scatterBothAxes) {
          const tangDist = (dabHashFloat(pt.x, pt.y, seedIdx, 5) * 2 - 1) * curWidth * scatter;
          sOffX += tx * tangDist;
          sOffY += ty * tangDist;
        }
        curDabX += sOffX;
        curDabY += sOffY;
      }

      let curDabFlow = dabFlow;
      if (flowJitter > 0) {
        curDabFlow *= Math.max(0.005, 1.0 - dabHashFloat(pt.x, pt.y, seedIdx, 6) * flowJitter);
      }

      let curMaster = dabMaster;
      let rNorm = dabRgb ? dabRgb.r / 255 : 0;
      let gNorm = dabRgb ? dabRgb.g / 255 : 0;
      let bNorm = dabRgb ? dabRgb.b / 255 : 0;

      if (colorJitterEnabled && dabRgb && secRgb && dynamics) {
        let salt = 20;
        const cd = applyColorDynamics(
          { r: dabRgb.r / 255, g: dabRgb.g / 255, b: dabRgb.b / 255 },
          { r: secRgb.r / 255, g: secRgb.g / 255, b: secRgb.b / 255 },
          dynamics,
          () => dabHashFloat(pt.x, pt.y, seedIdx, salt++)
        );
        rNorm = cd.r;
        gNorm = cd.g;
        bNorm = cd.b;
        if (!gpuDabs) {
          curMaster = getRadialDabMaster(hardness, cd.hex, isEraser && !isBgEraser, curDabW, aaMode);
        }
      }

      let finalW = isVert ? curDabW * curDabThickness : curDabW;
      let finalH = isVert ? curDabW : curDabW * curDabThickness;
      if (useTilt && tiltMagnitude > 0.01) {
        finalW = curDabW * (1.0 + tiltSpread * 1.8);
        finalH = (curDabW * curDabThickness) / (1.0 + tiltMagnitude * 0.5);
      }
      stepRefW = finalW;
      stepRefH = finalH;

      if (curDabFlow <= 0.002) continue;

      const flips = resolveTipFlipSigns(mixingOptions?.flipH, mixingOptions?.flipV, seedIdx, curDabX, curDabY);

      if (gpuDabs) {
        gpuDabs.push({
          x: curDabX,
          y: curDabY,
          width: finalW,
          height: finalH,
          angle: curDabRot,
          r: rNorm,
          g: gNorm,
          b: bNorm,
          alpha: curDabFlow,
          pressure: pt.pressure ?? 1.0,
          strokeDist: currentDist,
          flipX: flips.signX,
          flipY: flips.signY,
        });
      } else if (curMaster) {
        drawSingleStamp(
          ctx,
          curMaster,
          curDabX,
          curDabY,
          finalW,
          finalH,
          curDabRot,
          curDabFlow,
          isEraser,
          isBgEraser,
          mixingOptions?.alphaLocked,
          mixingOptions?.isTransparentInk,
          flips.signX,
          flips.signY,
          aaMode,
          mixingOptions?.blendTipsMode
        );
      }
    }

    // Sub-pixel hairline-safe & ellipse-aware directional step (zero 0.4px beading floor!)
    const requiredStep = computeEllipticalStepDistance(
      stepRefW,
      stepRefH,
      dabRot,
      pt.dx,
      pt.dy,
      spacingRatio,
      0.12
    );
    currentDist += requiredStep;
  }

  return Math.max(0, currentDist - totalCurveLength);
}

/**
 * Renders an entire completed radial/elliptical dab stroke onto the target context.
 */
export function renderCompleteRadialStroke(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  hardness: number = 1.0,
  flow: number = 1.0,
  spacing: number = 0.08,
  isEraser: boolean = false,
  isBgEraser: boolean = false,
  thickness: number = 1.0,
  angleRad: number = 0,
  mixingOptions?: RadialMixingOptions
) {
  if (!points || points.length === 0) return;

  if (mixingOptions?.colorMixing && !isEraser && !isBgEraser) {
    if (!mixingOptions.reservoir) {
      mixingOptions.reservoir = new PaintReservoir(color);
    }
    if (!mixingOptions.sampler && mixingOptions.underlyingCanvas) {
      mixingOptions.sampler = new LayerPixelSampler(mixingOptions.underlyingCanvas);
    }
  }

  const emitStroke = (batchGpuDabs: GpuDab[] | undefined) => {
    drawRadialDot(ctx, points[0], color, hardness, flow, isEraser, isBgEraser, mixingOptions, thickness, angleRad, batchGpuDabs);
    if (points.length === 1) return;

    const firstWidth = Math.max(0.2, points[0].width);
    let accDist = Math.max(0.12, firstWidth * spacing);

    if (points.length === 2) {
      const p0 = points[0];
      const p1 = points[1];
      const { c1, c2 } = centripetalCatmullRomToBezier(p0, p0, p1, p1);
      drawRadialCubicBezierSegment(ctx, p0, c1, c2, p1, color, hardness, flow, spacing, isEraser, isBgEraser, accDist, thickness, angleRad, mixingOptions, batchGpuDabs);
    } else {
      const p0 = points[0];
      const p1 = points[1];
      const p2 = points[2];
      const first = centripetalCatmullRomToBezier(p0, p0, p1, p2);
      accDist = drawRadialCubicBezierSegment(ctx, p0, first.c1, first.c2, p1, color, hardness, flow, spacing, isEraser, isBgEraser, accDist, thickness, angleRad, mixingOptions, batchGpuDabs);

      for (let i = 2; i < points.length - 1; i++) {
        const seg = centripetalCatmullRomToBezier(points[i - 2], points[i - 1], points[i], points[i + 1]);
        accDist = drawRadialCubicBezierSegment(ctx, points[i - 1], seg.c1, seg.c2, points[i], color, hardness, flow, spacing, isEraser, isBgEraser, accDist, thickness, angleRad, mixingOptions, batchGpuDabs);
      }

      const n = points.length;
      const pPrev2 = points[n - 3];
      const pPrev = points[n - 2];
      const pLast = points[n - 1];
      const last = centripetalCatmullRomToBezier(pPrev2, pPrev, pLast, pLast);
      drawRadialCubicBezierSegment(ctx, pPrev, last.c1, last.c2, pLast, color, hardness, flow, spacing, isEraser, isBgEraser, accDist, thickness, angleRad, mixingOptions, batchGpuDabs);
    }
  };

  if (canUseWebGlForRadialBrush(mixingOptions)) {
    const batchGpuDabs: GpuDab[] = [];
    emitStroke(batchGpuDabs);
    if (flushRadialGpuDabs(ctx, batchGpuDabs, color, hardness, isEraser, isBgEraser, mixingOptions)) {
      return;
    }
  }

  // Clean Canvas 2D fallback
  emitStroke(undefined);
}
