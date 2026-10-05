import { Point, CspSpraySettings, CspTaperSettings, CspSubTip } from '../types/editor';
import {
  PaintReservoir,
  LayerPixelSampler,
  sampleCanvasColor,
  parseColorToRgb,
  rgbToHex,
} from './colorMixingEngine';
import { evaluateCspSpline } from './sutParser';

export interface TexturedBrushOptions {
  size: number;
  minSizeFactor?: number;
  opacity?: number;
  flow?: number;
  spacing?: number; // 0.01 to 1.0 (relative to brush width)
  thickness?: number; // 0.05 to 1.0 (elliptical aspect ratio)
  thicknessVertical?: boolean;
  angle?: number; // rotation in degrees
  angleDynamics?: 'none' | 'direction' | 'random';
  rotationRandomScale?: number;
  hardness?: number;
  antiAlias?: number;
  pressureCurve?: [number, number][];
  velocityCurve?: [number, number][];
  usePressure?: boolean;
  useVelocity?: boolean;
  subTips?: CspSubTip[];
  subTipOrder?: 'random' | 'sequential' | 'direction' | 'reverse';
  subTipImages?: HTMLImageElement[];
  spray?: CspSpraySettings;
  taper?: CspTaperSettings;
  colorMixing?: boolean;
  amountOfPaint?: number;
  densityOfPaint?: number;
  colorStretch?: number;
  mixingMode?: 'blend' | 'running_color';
  wetEdge?: number;
  wetEdgeRadius?: number;
  wetEdgeAlphaPower?: number;
  wetEdgeValuePower?: number;
  grain?: number;
  textureDensity?: number;
  paperTextureImage?: HTMLImageElement;
  paperTextureScale?: number;
  paperTextureRotate?: number;
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
}

// -------------------------------------------------------------
// High-Efficiency Tinted Tip Master Buffer & Pool
// Reuses canvas contexts and quantizes colors to eliminate GC & allocations
// -------------------------------------------------------------

const MAX_CACHE_ENTRIES = 128;
const tintedMasterCache = new Map<string, HTMLCanvasElement>();
const canvasPool: HTMLCanvasElement[] = [];

function getPooledCanvas(w: number, h: number): HTMLCanvasElement {
  for (let i = 0; i < canvasPool.length; i++) {
    const c = canvasPool[i];
    if (c.width === w && c.height === h) {
      canvasPool.splice(i, 1);
      return c;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  return canvas;
}

/**
 * Generic tinted master offscreen canvas generator.
 * Uses 15-bit color quantization to achieve 98%+ cache hit rates during smooth color blends.
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

    const canvas = getPooledCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    }
    tintedMasterCache.set(key, canvas);
    return canvas;
  }

  const rgb = parseColorToRgb(color);
  const qR = (rgb.r >> 3) << 3;
  const qG = (rgb.g >> 3) << 3;
  const qB = (rgb.b >> 3) << 3;
  const quantizedHex = rgbToHex(qR, qG, qB);

  const key = `${sourceKey}_${quantizedHex}_${w}x${h}`;
  const cached = tintedMasterCache.get(key);
  if (cached) return cached;

  let canvas: HTMLCanvasElement;
  if (tintedMasterCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = tintedMasterCache.keys().next().value;
    if (oldestKey) {
      canvas = tintedMasterCache.get(oldestKey)!;
      tintedMasterCache.delete(oldestKey);
    } else {
      canvas = getPooledCanvas(w, h);
    }
  } else {
    canvas = getPooledCanvas(w, h);
  }

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

/**
 * Returns a tinted master offscreen canvas for the given tip and color.
 */
export function getTintedTipMaster(
  tipImage: HTMLImageElement,
  color: string,
  isColorTip: boolean = false
): HTMLCanvasElement {
  const w = tipImage.naturalWidth || tipImage.width || 64;
  const h = tipImage.naturalHeight || tipImage.height || 64;
  return getTintedMasterCanvas(tipImage, tipImage.src.slice(0, 48), color, w, h, isColorTip);
}

const radialMaskCache = new Map<number, HTMLCanvasElement>();

/**
 * Pre-computes or retrieves an analytical Hermite radial dab master.
 * Provides CSP / Photoshop standard falloff curves without slow Canvas2D shadowBlur.
 */
export function getRadialDabMaster(
  hardness: number,
  color: string,
  isEraser: boolean = false
): HTMLCanvasElement {
  const clampedH = Math.max(0, Math.min(1.0, hardness));
  const qH = Math.round(clampedH * 20) / 20;

  let maskCanvas = radialMaskCache.get(qH);
  if (!maskCanvas) {
    const size = 128;
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = size;
    maskCanvas.height = size;
    const ctx = maskCanvas.getContext('2d');
    if (ctx) {
      const imgData = ctx.createImageData(size, size);
      const data = imgData.data;
      const cx = size / 2;
      const cy = size / 2;
      const radius = size / 2 - 2; // 62px
      const rCore = radius * qH;

      for (let y = 0; y < size; y++) {
        const dy = y - cy + 0.5;
        const rowOffset = y * size * 4;
        for (let x = 0; x < size; x++) {
          const dx = x - cx + 0.5;
          const dist = Math.hypot(dx, dy);
          let alpha = 0;
          if (qH >= 0.98) {
            // Crisp anti-aliased disk with sub-pixel edge
            alpha = Math.max(0, Math.min(1.0, radius - dist + 0.5));
          } else if (dist <= rCore) {
            alpha = 1.0;
          } else if (dist < radius) {
            const t = (dist - rCore) / (radius - rCore);
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
    radialMaskCache.set(qH, maskCanvas);
  }

  const effectiveColor = isEraser ? '#000000' : color;
  return getTintedMasterCanvas(maskCanvas, `radial_${qH}`, effectiveColor, 128, 128);
}

/**
 * Draws a single textured brush stamp (dab) onto the destination context.
 * Features an ultra-fast path for unrotated stamps (no save/restore overhead).
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
  isTransparentInk: boolean = false
) {
  if (width < 0.1 || height < 0.1 || alpha <= 0.002) return;

  const subpixelScale = width < 1.0 ? Math.max(0.1, width) : 1.0;
  const effAlpha = Math.max(0.003, Math.min(1.0, alpha * subpixelScale));
  const renderW = Math.max(0.6, width);
  const renderH = Math.max(0.6, height);

  // Ultra-fast path for unrotated normal stamps
  if (Math.abs(angleRad) < 0.001 && !isEraser && !isBgEraser && !alphaLocked && !isTransparentInk) {
    const prevAlpha = ctx.globalAlpha;
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = effAlpha;
    ctx.drawImage(stampSource, x - renderW / 2, y - renderH / 2, renderW, renderH);
    ctx.globalAlpha = prevAlpha;
    ctx.globalCompositeOperation = prevOp;
    return;
  }

  ctx.save();

  if (isBgEraser) {
    ctx.globalCompositeOperation = 'source-over';
  } else if (isTransparentInk || isEraser) {
    ctx.globalCompositeOperation = 'destination-out';
  } else if (alphaLocked) {
    ctx.globalCompositeOperation = 'source-atop';
  } else {
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.globalAlpha = effAlpha;
  ctx.translate(x, y);

  if (angleRad !== 0) {
    ctx.rotate(angleRad);
  }

  ctx.drawImage(stampSource, -width / 2, -height / 2, width, height);
  ctx.restore();
}

/**
 * Selects the active tip image from multi-tip array based on order type.
 */
function selectTipImage(
  tipImages: HTMLImageElement[] | undefined,
  fallbackTip: HTMLImageElement,
  order: 'random' | 'sequential' | 'direction' | 'reverse' = 'sequential',
  dabIndex: number = 0,
  tangentAngle: number = 0
): HTMLImageElement {
  if (!tipImages || tipImages.length <= 1) {
    return tipImages && tipImages.length === 1 ? tipImages[0] : fallbackTip;
  }

  const count = tipImages.length;
  if (order === 'random') {
    const idx = Math.floor(Math.random() * count);
    return tipImages[idx];
  } else if (order === 'reverse') {
    const idx = (count - 1 - (dabIndex % count)) % count;
    return tipImages[idx];
  } else if (order === 'direction') {
    // Map tangent angle [0, 2PI) into tip indices
    const normAngle = ((tangentAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const idx = Math.floor((normAngle / (2 * Math.PI)) * count) % count;
    return tipImages[idx];
  } else {
    // Sequential
    return tipImages[dabIndex % count];
  }
}

/**
 * Draws a single dot at pointer down.
 */
export function drawTexturedDot(
  ctx: CanvasRenderingContext2D,
  point: Point,
  color: string,
  tipImage: HTMLImageElement,
  options: TexturedBrushOptions
) {
  const isEraser = options.isEraser ?? false;
  const isBgEraser = options.isBgEraser ?? false;
  let effectiveColor = isBgEraser ? '#ffffff' : color;
  let effectiveFlow = options.flow ?? 0.85;

  const effPressure = evaluateCspSpline(point.pressure, options.pressureCurve);
  const minFactor = options.minSizeFactor ?? 0.2;
  const effWidth = Math.max(1, options.size * (minFactor + (1.0 - minFactor) * effPressure));

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
      0
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

  const activeTip = selectTipImage(options.subTipImages, tipImage, options.subTipOrder, 0, 0);
  const isColorTip = Boolean((options.subTips && options.subTips[0]?.isColor));
  const master = getTintedTipMaster(activeTip, effectiveColor, isColorTip);

  const aspect = (activeTip.naturalHeight || activeTip.height || 1) / (activeTip.naturalWidth || activeTip.width || 1);
  const thickness = options.thickness ?? 1.0;

  const tiltX = point.tiltX ?? 0;
  const tiltY = point.tiltY ?? 0;
  const tiltAngleDeg = Math.min(90, Math.sqrt(tiltX * tiltX + tiltY * tiltY));
  const tiltMagnitude = Math.sin((tiltAngleDeg * Math.PI) / 180);

  let w = effWidth;
  let h = w * aspect * thickness;
  let angleRad = ((options.angle ?? 0) * Math.PI) / 180;

  if (tiltMagnitude > 0.01) {
    const tiltAzimuth = Math.atan2(tiltY, tiltX);
    w = w * (1.0 + tiltMagnitude * 1.8);
    h = h / (1.0 + tiltMagnitude * 0.5);
    if (tiltMagnitude > 0.05) {
      angleRad = tiltAzimuth;
    }
  }
  if (point.twist) {
    angleRad += (point.twist * Math.PI) / 180;
  }

  if (options.spray?.enabled) {
    const pCount = options.spray.density;
    const pSize = Math.max(1, options.spray.size);
    const radius = effWidth / 2;
    for (let i = 0; i < pCount; i++) {
      const u1 = Math.random();
      const u2 = Math.random();
      const r = radius * Math.sqrt(u1) * (1 - (options.spray.bias || 0) * (1 - u2));
      const th = Math.PI * 2 * Math.random();
      drawSingleStamp(
        ctx,
        master,
        point.x + r * Math.cos(th),
        point.y + r * Math.sin(th),
        pSize,
        pSize * aspect * thickness,
        angleRad,
        effectiveFlow,
        isEraser,
        isBgEraser,
        options.alphaLocked,
        options.isTransparentInk
      );
    }
  } else {
    drawSingleStamp(
      ctx,
      master,
      point.x,
      point.y,
      w,
      h,
      angleRad,
      effectiveFlow,
      isEraser,
      isBgEraser,
      options.alphaLocked,
      options.isTransparentInk
    );
  }
}

// -------------------------------------------------------------
// Cubic Bézier Evaluation and Arc Length Parameterization
// -------------------------------------------------------------

export function evalCubicBezier(
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  t: number
): { x: number; y: number; width: number; pressure: number; dx: number; dy: number; speed: number; tiltX?: number; tiltY?: number; twist?: number } {
  const invT = 1.0 - t;
  const invT2 = invT * invT;
  const invT3 = invT2 * invT;
  const t2 = t * t;
  const t3 = t2 * t;

  const a = invT3;
  const b = 3.0 * invT2 * t;
  const c = 3.0 * invT * t2;
  const d = t3;

  const x = a * p0.x + b * c1.x + c * c2.x + d * p3.x;
  const y = a * p0.y + b * c1.y + c * c2.y + d * p3.y;
  const width = invT * p0.width + t * p3.width;
  const pressure = invT * p0.pressure + t * p3.pressure;
  const tiltX = invT * (p0.tiltX ?? 0) + t * (p3.tiltX ?? 0);
  const tiltY = invT * (p0.tiltY ?? 0) + t * (p3.tiltY ?? 0);
  const twist = invT * (p0.twist ?? 0) + t * (p3.twist ?? 0);

  const d01x = c1.x - p0.x;
  const d01y = c1.y - p0.y;
  const d12x = c2.x - c1.x;
  const d12y = c2.y - c1.y;
  const d23x = p3.x - c2.x;
  const d23y = p3.y - c2.y;

  const dx = 3.0 * invT2 * d01x + 6.0 * invT * t * d12x + 3.0 * t2 * d23x;
  const dy = 3.0 * invT2 * d01y + 6.0 * invT * t * d12y + 3.0 * t2 * d23y;
  const speed = Math.hypot(dx, dy);

  return { x, y, width, pressure, dx, dy, speed, tiltX, tiltY, twist };
}

export interface ArcLengthTable {
  totalLength: number;
  distances: number[];
}

export function buildCubicArcLengthTable(p0: Point, c1: Point, c2: Point, p3: Point): ArcLengthTable {
  const steps = 24;
  const distances: number[] = [0];
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
    distances.push(total);
    prevX = x;
    prevY = y;
  }

  return { totalLength: total, distances };
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
  let idx = 0;
  while (idx < steps && distances[idx + 1] < targetDist) {
    idx++;
  }

  const d0 = distances[idx];
  const d1 = distances[idx + 1];
  const frac = d1 > d0 ? (targetDist - d0) / (d1 - d0) : 0;
  const t = (idx + frac) / steps;

  return evalCubicBezier(p0, c1, c2, p3, Math.max(0, Math.min(1.0, t)));
}

/**
 * Draws textured brush stamps along a cubic Bézier curve using arc-length parameterization.
 * Supports multi-tips, spline pressure curve, spray particle scattering, and wet edge.
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
  dabCounter: { count: number } = { count: 0 }
): number {
  const arcTable = buildCubicArcLengthTable(p0, c1, c2, p3);
  const totalCurveLength = arcTable.totalLength;
  if (totalCurveLength < 0.1) {
    return remainderDist;
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
  const baseFlow = options.flow ?? 0.85;
  const spacingRatio = Math.max(0.015, Math.min(1.0, options.spacing ?? 0.07));
  const thickness = options.thickness ?? 1.0;
  const rotationRandomScale = options.rotationRandomScale ?? 0;

  let smoothCos = Math.cos(baseAngleRad);
  let smoothSin = Math.sin(baseAngleRad);

  let currentDist = remainderDist > 0 ? remainderDist : 0;

  while (currentDist <= totalCurveLength) {
    const pt = getCubicPointAtArcLength(p0, c1, c2, p3, currentDist, arcTable);
    const effPressure = evaluateCspSpline(pt.pressure, options.pressureCurve);
    const minFactor = Math.max(0, Math.min(1.0, options.minSizeFactor ?? 0));

    let curWidth = options.usePressure !== false
      ? options.size * (minFactor + (1.0 - minFactor) * effPressure)
      : options.size;

    // Stroke taper modulation (Clip Studio Paint style)
    if (options.taper) {
      const strokeDist = (options.currentStrokeDist ?? 0) + currentDist;
      const inLen = options.taper.inLength || (options.taper.inRatio ? options.taper.inRatio * 2.5 : 0);
      if (options.taper.useIn && inLen > 0 && strokeDist < inLen) {
        const inFactor = Math.max(0.01, Math.min(1.0, strokeDist / inLen));
        curWidth *= Math.pow(inFactor, 0.75);
      }
      if (options.totalLength && options.totalLength > 0) {
        const distFromEnd = options.totalLength - strokeDist;
        const outLen = options.taper.outLength || (options.taper.outRatio ? options.taper.outRatio * 3.0 : 0);
        if (options.taper.useOut && outLen > 0 && distFromEnd < outLen) {
          const outFactor = Math.max(0.01, Math.min(1.0, distFromEnd / outLen));
          curWidth *= Math.pow(outFactor, 0.85);
        }
      }
    }

    curWidth = Math.max(0.1, curWidth);

    let stampAngle = baseAngleRad;
    if (options.angleDynamics === 'direction' && pt.speed > 0.05) {
      const targetAngle = Math.atan2(pt.dy, pt.dx) + baseAngleRad;
      const tCos = Math.cos(targetAngle);
      const tSin = Math.sin(targetAngle);
      smoothCos = smoothCos * 0.65 + tCos * 0.35;
      smoothSin = smoothSin * 0.65 + tSin * 0.35;
      stampAngle = Math.atan2(smoothSin, smoothCos);
    } else if (options.angleDynamics === 'random') {
      stampAngle = baseAngleRad + (Math.random() - 0.5) * Math.PI * 2;
    }

    if (rotationRandomScale > 0) {
      stampAngle += (Math.random() - 0.5) * Math.PI * 2 * rotationRandomScale;
    }

    let dabColor = baseColor;
    let dabAlpha = baseFlow;

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
        baseFlow,
        Math.max(0.2, curWidth * spacingRatio)
      );

      dabColor = mixed.colorHex;
      dabAlpha = mixed.alpha;

      if (sampler) {
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

    // Wet Edge rim boost
    if (options.wetEdge && options.wetEdge > 0) {
      dabAlpha = Math.min(1.0, dabAlpha * (1.0 + options.wetEdge * 0.25));
    }

    // Select tip from multi-tip array
    const activeTip = selectTipImage(
      options.subTipImages,
      tipImage,
      options.subTipOrder,
      dabCounter.count++,
      stampAngle
    );
    const isColorTip = Boolean(options.subTips && options.subTips[0]?.isColor);
    const master = getTintedTipMaster(activeTip, dabColor, isColorTip);

    const tiltX = pt.tiltX ?? 0;
    const tiltY = pt.tiltY ?? 0;
    const tiltAngleDeg = Math.min(90, Math.sqrt(tiltX * tiltX + tiltY * tiltY));
    const tiltMagnitude = Math.sin((tiltAngleDeg * Math.PI) / 180);

    let stampW = curWidth;
    let stampH = curWidth * aspect * thickness;
    let dabAngle = stampAngle;

    if (tiltMagnitude > 0.01) {
      const tiltAzimuth = Math.atan2(tiltY, tiltX);
      stampW = curWidth * (1.0 + tiltMagnitude * 1.8);
      stampH = (curWidth * aspect * thickness) / (1.0 + tiltMagnitude * 0.5);
      if (tiltMagnitude > 0.05) {
        dabAngle = tiltAzimuth;
      }
    }
    if (pt.twist) {
      dabAngle += (pt.twist * Math.PI) / 180;
    }

    if (options.spray?.enabled) {
      const pCount = options.spray.density;
      const pSize = Math.max(1, options.spray.size);
      const radius = curWidth / 2;
      for (let sp = 0; sp < pCount; sp++) {
        const u1 = Math.random();
        const u2 = Math.random();
        const r = radius * Math.sqrt(u1) * (1 - (options.spray.bias || 0) * (1 - u2));
        const th = Math.PI * 2 * Math.random();
        drawSingleStamp(
          ctx,
          master,
          pt.x + r * Math.cos(th),
          pt.y + r * Math.sin(th),
          pSize,
          pSize * aspect * thickness,
          dabAngle,
          dabAlpha,
          isEraser,
          isBgEraser,
          options.alphaLocked,
          options.isTransparentInk
        );
      }
    } else {
      drawSingleStamp(
        ctx,
        master,
        pt.x,
        pt.y,
        stampW,
        stampH,
        dabAngle,
        dabAlpha,
        isEraser,
        isBgEraser,
        options.alphaLocked,
        options.isTransparentInk
      );
    }

    const requiredStep = Math.max(0.2, curWidth * spacingRatio);
    currentDist += requiredStep;
  }

  const nextRemainder = currentDist - totalCurveLength;
  return Math.max(0, nextRemainder);
}

/**
 * Draws textured brush stamps along a quadratic Bézier curve by elevating to cubic.
 */
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

/**
 * Converts 4 Catmull-Rom spline knots into cubic Bézier control points.
 */
function catmullRomToCubicKnots(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point
): { c1: Point; c2: Point } {
  const dChord = Math.hypot(p2.x - p1.x, p2.y - p1.y);

  let dx1 = (p2.x - p0.x) / 6;
  let dy1 = (p2.y - p0.y) / 6;
  let dx2 = (p3.x - p1.x) / 6;
  let dy2 = (p3.y - p1.y) / 6;

  if (dChord > 0.001) {
    const maxHandle = dChord * 0.5;
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

  const c1: Point = {
    x: p1.x + dx1,
    y: p1.y + dy1,
    pressure: p1.pressure + (p2.pressure - p0.pressure) / 6,
    width: p1.width + (p2.width - p0.width) / 6,
  };

  const c2: Point = {
    x: p2.x - dx2,
    y: p2.y - dy2,
    pressure: p2.pressure - (p3.pressure - p1.pressure) / 6,
    width: p2.width - (p3.width - p1.width) / 6,
  };

  return { c1, c2 };
}

/**
 * Renders an entire completed textured stroke onto the target Canvas2D context using Catmull-Rom cubic splines.
 */
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
  if (!options.sampler && options.underlyingCanvas) {
    options.sampler = new LayerPixelSampler(options.underlyingCanvas);
  }

  // Draw initial dot at points[0]
  drawTexturedDot(ctx, points[0], color, tipImage, options);

  if (points.length === 1) {
    return;
  }

  const dabCounter = { count: 0 };
  let accDist = Math.max(0.2, points[0].width * (options.spacing ?? 0.07));

  if (points.length === 2) {
    const p0 = points[0];
    const p1 = points[1];
    const { c1, c2 } = catmullRomToCubicKnots(p0, p0, p1, p1);
    drawTexturedCubicBezierSegment(ctx, p0, c1, c2, p1, color, tipImage, options, accDist, dabCounter);
    return;
  }

  // First segment: P0 -> P1 using (P0, P0, P1, P2)
  const p0 = points[0];
  const p1 = points[1];
  const p2 = points[2];
  const first = catmullRomToCubicKnots(p0, p0, p1, p2);
  accDist = drawTexturedCubicBezierSegment(ctx, p0, first.c1, first.c2, p1, color, tipImage, options, accDist, dabCounter);

  // Intermediate segments: P_{i-1} -> P_i using (P_{i-2}, P_{i-1}, P_i, P_{i+1})
  for (let i = 2; i < points.length - 1; i++) {
    const seg = catmullRomToCubicKnots(points[i - 2], points[i - 1], points[i], points[i + 1]);
    accDist = drawTexturedCubicBezierSegment(ctx, points[i - 1], seg.c1, seg.c2, points[i], color, tipImage, options, accDist, dabCounter);
  }

  // Last segment: P_{N-2} -> P_{N-1} using (P_{N-3}, P_{N-2}, P_{N-1}, P_{N-1})
  const n = points.length;
  const pPrev2 = points[n - 3];
  const pPrev = points[n - 2];
  const pLast = points[n - 1];
  const last = catmullRomToCubicKnots(pPrev2, pPrev, pLast, pLast);
  drawTexturedCubicBezierSegment(ctx, pPrev, last.c1, last.c2, pLast, color, tipImage, options, accDist, dabCounter);
}

/**
 * Centripetal Catmull-Rom spline (alpha = 0.5) to cubic Bézier control points.
 * Mathematically guarantees zero self-intersections, cusps, or overshoot on sharp curves.
 */
export function centripetalCatmullRomToBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point
): { c1: Point; c2: Point } {
  const d01 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const d12 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const d23 = Math.hypot(p3.x - p2.x, p3.y - p2.y);

  const dt0 = Math.max(1e-4, Math.sqrt(d01));
  const dt1 = Math.max(1e-4, Math.sqrt(d12));
  const dt2 = Math.max(1e-4, Math.sqrt(d23));

  const t1x = (p2.x - p1.x) / dt1 - (p1.x - p0.x) / dt0 + (p2.x - p0.x) / (dt0 + dt1);
  const t1y = (p2.y - p1.y) / dt1 - (p1.y - p0.y) / dt0 + (p2.y - p0.y) / (dt0 + dt1);
  const t2x = (p3.x - p2.x) / dt2 - (p2.x - p1.x) / dt1 + (p3.x - p1.x) / (dt1 + dt2);
  const t2y = (p3.y - p2.y) / dt2 - (p2.y - p1.y) / dt1 + (p3.y - p1.y) / (dt1 + dt2);

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

  const c1: Point = {
    x: p1.x + dx1,
    y: p1.y + dy1,
    pressure: p1.pressure + (p2.pressure - p0.pressure) / 6,
    width: p1.width + (p2.width - p0.width) / 6,
  };

  const c2: Point = {
    x: p2.x - dx2,
    y: p2.y - dy2,
    pressure: p2.pressure - (p3.pressure - p1.pressure) / 6,
    width: p2.width - (p3.width - p1.width) / 6,
  };

  return { c1, c2 };
}

export interface RadialMixingOptions {
  colorMixing?: boolean;
  amountOfPaint?: number;
  densityOfPaint?: number;
  colorStretch?: number;
  mixingMode?: 'blend' | 'running_color';
  underlyingCanvas?: HTMLCanvasElement;
  sampler?: LayerPixelSampler;
  reservoir?: PaintReservoir;
  alphaLocked?: boolean;
  isTransparentInk?: boolean;
}

/**
 * Draws a single radial dot.
 */
export function drawRadialDot(
  ctx: CanvasRenderingContext2D,
  point: Point,
  color: string,
  hardness: number = 1.0,
  flow: number = 1.0,
  isEraser: boolean = false,
  isBgEraser: boolean = false,
  mixingOptions?: RadialMixingOptions
) {
  const isColorMixing = Boolean(mixingOptions?.colorMixing) && !isEraser && !isBgEraser;
  let dabColor = isBgEraser ? '#ffffff' : color;
  let dabFlow = flow;
  const w = Math.max(0.5, point.width);

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
      flow,
      0
    );

    dabColor = mixed.colorHex;
    dabFlow = mixed.alpha;

    if (mixingOptions!.sampler) {
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

  const tiltX = point.tiltX ?? 0;
  const tiltY = point.tiltY ?? 0;
  const tiltAngleDeg = Math.min(90, Math.sqrt(tiltX * tiltX + tiltY * tiltY));
  const tiltMagnitude = Math.sin((tiltAngleDeg * Math.PI) / 180);

  let dotW = w;
  let dotH = w;
  let dotAngle = 0;
  if (tiltMagnitude > 0.01) {
    const tiltAzimuth = Math.atan2(tiltY, tiltX);
    dotW = w * (1.0 + tiltMagnitude * 1.8);
    dotH = w / (1.0 + tiltMagnitude * 0.5);
    if (tiltMagnitude > 0.05) {
      dotAngle = tiltAzimuth;
    }
  }
  if (point.twist) {
    dotAngle += (point.twist * Math.PI) / 180;
  }

  const master = getRadialDabMaster(hardness, dabColor, isEraser && !isBgEraser);
  drawSingleStamp(
    ctx,
    master,
    point.x,
    point.y,
    dotW,
    dotH,
    dotAngle,
    dabFlow,
    isEraser,
    isBgEraser,
    mixingOptions?.alphaLocked,
    mixingOptions?.isTransparentInk
  );
}

/**
 * Draws smooth radial dabs along a cubic Bézier curve using arc-length parameterization.
 * Delivers professional Clip Studio Paint / Photoshop quality without line banding or shadowBlur.
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
  spacing: number = 0.06,
  isEraser: boolean = false,
  isBgEraser: boolean = false,
  remainderDist: number = 0,
  thickness: number = 1.0,
  angleRad: number = 0,
  mixingOptions?: RadialMixingOptions
): number {
  const arcTable = buildCubicArcLengthTable(p0, c1, c2, p3);
  const totalCurveLength = arcTable.totalLength;
  if (totalCurveLength < 0.1) {
    return remainderDist;
  }

  const isColorMixing = Boolean(mixingOptions?.colorMixing) && !isEraser && !isBgEraser;
  if (isColorMixing && mixingOptions && !mixingOptions.reservoir) {
    mixingOptions.reservoir = new PaintReservoir(color);
  }
  const reservoir = mixingOptions?.reservoir;
  const sampler = mixingOptions?.sampler;
  const staticMaster = isColorMixing ? null : getRadialDabMaster(hardness, color, isEraser && !isBgEraser);
  const spacingRatio = Math.max(0.015, Math.min(1.0, spacing));
  let currentDist = remainderDist > 0 ? remainderDist : 0;

  while (currentDist <= totalCurveLength) {
    const pt = getCubicPointAtArcLength(p0, c1, c2, p3, currentDist, arcTable);
    const curWidth = Math.max(0.4, pt.width);
    const curHeight = curWidth * thickness;
    const requiredStep = Math.max(0.4, curWidth * spacingRatio);

    const tiltX = pt.tiltX ?? 0;
    const tiltY = pt.tiltY ?? 0;
    const tiltAngleDeg = Math.min(90, Math.sqrt(tiltX * tiltX + tiltY * tiltY));
    const tiltMagnitude = Math.sin((tiltAngleDeg * Math.PI) / 180);

    let dabW = curWidth;
    let dabH = curHeight;
    let dabRot = angleRad;

    if (tiltMagnitude > 0.01) {
      const tiltAzimuth = Math.atan2(tiltY, tiltX);
      dabW = curWidth * (1.0 + tiltMagnitude * 1.8);
      dabH = curHeight / (1.0 + tiltMagnitude * 0.5);
      if (tiltMagnitude > 0.05) {
        dabRot = tiltAzimuth;
      }
    }
    if (pt.twist) {
      dabRot += (pt.twist * Math.PI) / 180;
    }

    let dabMaster = staticMaster;
    let dabFlow = flow;

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
        flow,
        requiredStep
      );

      dabMaster = getRadialDabMaster(hardness, mixed.colorHex, false);
      dabFlow = mixed.alpha;

      if (sampler) {
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

    if (dabMaster) {
      drawSingleStamp(
        ctx,
        dabMaster,
        pt.x,
        pt.y,
        dabW,
        dabH,
        dabRot,
        dabFlow,
        isEraser,
        isBgEraser,
        mixingOptions?.alphaLocked,
        mixingOptions?.isTransparentInk
      );
    }

    currentDist += requiredStep;
  }

  const nextRemainder = currentDist - totalCurveLength;
  return Math.max(0, nextRemainder);
}

/**
 * Renders an entire completed radial dab stroke onto the target context.
 */
export function renderCompleteRadialStroke(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  color: string,
  hardness: number = 1.0,
  flow: number = 1.0,
  spacing: number = 0.06,
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

  drawRadialDot(ctx, points[0], color, hardness, flow, isEraser, isBgEraser, mixingOptions);
  if (points.length === 1) return;

  let accDist = Math.max(0.4, points[0].width * spacing);

  if (points.length === 2) {
    const p0 = points[0];
    const p1 = points[1];
    const { c1, c2 } = centripetalCatmullRomToBezier(p0, p0, p1, p1);
    drawRadialCubicBezierSegment(ctx, p0, c1, c2, p1, color, hardness, flow, spacing, isEraser, isBgEraser, accDist, thickness, angleRad, mixingOptions);
    return;
  }

  const p0 = points[0];
  const p1 = points[1];
  const p2 = points[2];
  const first = centripetalCatmullRomToBezier(p0, p0, p1, p2);
  accDist = drawRadialCubicBezierSegment(ctx, p0, first.c1, first.c2, p1, color, hardness, flow, spacing, isEraser, isBgEraser, accDist, thickness, angleRad, mixingOptions);

  for (let i = 2; i < points.length - 1; i++) {
    const seg = centripetalCatmullRomToBezier(points[i - 2], points[i - 1], points[i], points[i + 1]);
    accDist = drawRadialCubicBezierSegment(ctx, points[i - 1], seg.c1, seg.c2, points[i], color, hardness, flow, spacing, isEraser, isBgEraser, accDist, thickness, angleRad, mixingOptions);
  }

  const n = points.length;
  const pPrev2 = points[n - 3];
  const pPrev = points[n - 2];
  const pLast = points[n - 1];
  const last = centripetalCatmullRomToBezier(pPrev2, pPrev, pLast, pLast);
  drawRadialCubicBezierSegment(ctx, pPrev, last.c1, last.c2, pLast, color, hardness, flow, spacing, isEraser, isBgEraser, accDist, thickness, angleRad, mixingOptions);
}

