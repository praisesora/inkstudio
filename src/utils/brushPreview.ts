import { BrushPresetId, CspSpraySettings } from '../types/editor';
import { PENCIL_CONFIGS, PencilGrade, getPaperGrain, parseRgba } from './pencilEngine';
import { getTintedTipMaster } from './stampEngine';
import { getBuiltinBrushConfig } from './presetBrushes';
import { evaluateCspSpline } from './sutParser';

export interface BrushPreviewOptions {
  preset?: BrushPresetId;
  size?: number;
  flow?: number;
  opacity?: number;
  grain?: number;
  hardness?: number;
  minSizeFactor?: number;
  usePressure?: boolean;
  color?: string; // default '#ffffff' for neutral preview
  backgroundColor?: string; // default 'transparent'
  isSelected?: boolean;
  tool?: 'brush' | 'eraser';
  customTipImage?: HTMLImageElement;
  customTipAngle?: number;
  thickness?: number;
  antiAlias?: number;
  pressureCurve?: [number, number][];
  spray?: CspSpraySettings;
  colorMixing?: boolean;
  amountOfPaint?: number;
  densityOfPaint?: number;
  colorStretch?: number;
  wetEdge?: number;
}

// Offscreen canvas cache to guarantee zero-latency 120 FPS rendering
const previewCache = new Map<string, HTMLCanvasElement>();
const MAX_CACHE_ENTRIES = 60;

/**
 * Deterministic pseudo-random generator (mulberry32)
 * Ensures paper grain and flake distribution never flickers across re-renders.
 */
function createPrng(seed: number) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates an integer seed from a string identifier.
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Clamps a number between min and max.
 */
function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Calculates the display width for preview S-curves.
 * Provides natural distinction between fine leads (2px) and thick brushes (30px+)
 * without clipping or overflowing the preview canvas bounds.
 */
export function calculatePreviewWidth(
  baseSize: number,
  canvasHeight: number,
  isLiveSettings: boolean = false
): number {
  if (isLiveSettings) {
    if (baseSize <= 4) return Math.max(1.5, baseSize);
    if (baseSize <= 16) return 4.0 + (baseSize - 4) * 0.5;
    return Math.min(canvasHeight * 0.62, 10 + Math.sqrt(baseSize) * 1.8);
  }

  // In subtool list preview rows:
  if (baseSize <= 3) return Math.max(1.8, baseSize * 0.95);
  if (baseSize <= 8) return 3.2 + (baseSize - 3) * 0.65;
  if (baseSize <= 20) return 6.8 + (baseSize - 8) * 0.45;
  return Math.min(canvasHeight * 0.54, 9.5 + Math.sqrt(baseSize) * 1.5);
}

/**
 * Renders an optimized Clip Studio Paint style S-curve brush preview.
 */
export function renderBrushStrokePreview(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  options: BrushPreviewOptions = {},
  isLiveCard: boolean = false
) {
  if (!canvas || cssWidth <= 0 || cssHeight <= 0) return;

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const targetWidth = Math.round(cssWidth * dpr);
  const targetHeight = Math.round(cssHeight * dpr);

  // Synchronize internal canvas buffer size
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const preset = options.preset || 'pencil-2b';
  const isPencil = preset.startsWith('pencil');
  const pencilConfig = isPencil ? PENCIL_CONFIGS[preset as PencilGrade] : null;

  const size = options.size ?? (pencilConfig ? pencilConfig.defaultSize : 14);
  const flow = options.flow ?? (pencilConfig ? pencilConfig.flow : 0.85);
  const opacity = options.opacity ?? 1.0;
  const grain = options.grain ?? (pencilConfig ? pencilConfig.grain : 0);
  const hardness = options.hardness ?? (pencilConfig ? pencilConfig.hardness : 1.0);
  const minSizeFactor = options.minSizeFactor ?? (pencilConfig ? pencilConfig.minSizeFactor : 0.15);
  const isEraser = options.tool === 'eraser';
  const strokeColor = options.color || '#ffffff';
  const bgColor = options.backgroundColor || 'transparent';
  const builtinCfg = !options.customTipImage && options.preset ? getBuiltinBrushConfig(options.preset) : null;
  const tipImage = options.customTipImage || builtinCfg?.customTipImage;

  // Cache key
  const cacheKey = [
    preset,
    size.toFixed(1),
    flow.toFixed(2),
    opacity.toFixed(2),
    grain.toFixed(2),
    hardness.toFixed(2),
    (options.thickness ?? 1.0).toFixed(2),
    options.antiAlias !== undefined ? String(options.antiAlias) : '2',
    options.spray?.enabled ? 'spray' : 'dab',
    options.customTipAngle?.toFixed(1) || '0',
    tipImage ? 'custom-tip' : 'std',
    isEraser ? '1' : '0',
    options.wetEdge?.toFixed(2) || '0',
    options.colorMixing ? '1' : '0',
    strokeColor,
    bgColor,
    cssWidth,
    cssHeight,
    dpr,
    isLiveCard ? 'live' : 'list',
  ].join('|');

  const cached = previewCache.get(cacheKey);
  if (cached) {
    ctx.clearRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(cached, 0, 0);
    return;
  }

  // Create offscreen canvas for rendering
  const offscreen = document.createElement('canvas');
  offscreen.width = targetWidth;
  offscreen.height = targetHeight;
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) return;

  offCtx.save();
  offCtx.scale(dpr, dpr);

  // Background
  if (bgColor !== 'transparent') {
    offCtx.fillStyle = bgColor;
    offCtx.fillRect(0, 0, cssWidth, cssHeight);
  } else {
    offCtx.clearRect(0, 0, cssWidth, cssHeight);
  }

  // S-Curve Geometry (Clip Studio Paint style)
  // Starts on left, curves UP to a peak, crosses center downward, curves DOWN to trough, tapers to right
  const padX = Math.max(12, Math.round(cssWidth * 0.1));
  const strokeLength = cssWidth - 2 * padX;
  const centerY = cssHeight / 2;
  const maxAmp = Math.min(cssHeight * 0.28, isLiveCard ? 14 : 9);
  const amp = Math.max(4, maxAmp);

  const displayWidth = calculatePreviewWidth(size, cssHeight, isLiveCard);
  const [rCol, gCol, bCol] = parseRgba(strokeColor);

  // Sample points along the S-curve
  const numSteps = Math.min(120, Math.max(60, Math.round(cssWidth * 0.65)));
  const pts: { x: number; y: number; width: number; pressure: number; tipAlpha: number }[] = [];

  for (let i = 0; i <= numSteps; i++) {
    const u = i / numSteps;
    const x = padX + u * strokeLength;
    // Classic S-curve: y = centerY - sin(2 * PI * u) * amp
    const y = centerY - Math.sin(2 * Math.PI * u) * amp;

    // Calligraphic pressure envelope: peak pressure in center, tapered at ends
    const sineEnv = Math.sin(Math.PI * u);
    let pressure = Math.pow(Math.max(0, sineEnv), 0.75);
    if (options.pressureCurve) {
      pressure = evaluateCspSpline(pressure, options.pressureCurve);
    }

    // Dynamic tip taper for authentic pen release at the ends
    const tipFactor = Math.min(1.0, Math.sin(Math.PI * u) * 2.8);
    const effMinSize = Math.max(0.08, minSizeFactor * tipFactor);
    const tipAlpha = Math.min(1.0, Math.sin(Math.PI * u) * 4.2);

    // Taper width from effMinSize to full displayWidth
    const w = Math.max(0.8, displayWidth * (effMinSize + (1 - effMinSize) * pressure));

    pts.push({ x, y, width: w, pressure, tipAlpha });
  }

  if (isEraser) {
    // ERASER PREVIEW:
    // Render a subtle tone band or grid, with the eraser cleanly carving through it
    offCtx.save();
    offCtx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    offCtx.fillRect(padX - 4, centerY - amp - 4, strokeLength + 8, (amp + 4) * 2);

    offCtx.globalCompositeOperation = 'destination-out';
    offCtx.lineCap = 'round';
    offCtx.lineJoin = 'round';
    offCtx.strokeStyle = 'rgba(0, 0, 0, 1)';

    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      offCtx.beginPath();
      offCtx.lineWidth = (p1.width + p2.width) / 2;
      offCtx.moveTo(p1.x, p1.y);
      offCtx.lineTo(p2.x, p2.y);
      offCtx.stroke();
    }
    offCtx.restore();
  } else if (isPencil && pencilConfig) {
    // PENCIL PHYSICS PREVIEW:
    // Authentic cold-press paper grain tooth & micro-graphite flake distribution
    const seed = hashString(preset) ^ (Math.round(size * 10) << 8);
    const rand = createPrng(seed);

    const baseThreshold = pencilConfig.thresholdBase;
    const sens = pencilConfig.thresholdPressureSensitivity;
    const pDensity = pencilConfig.particleDensity;
    const pSize = Math.max(1, pencilConfig.particleSize);
    const effectiveFlow = flow * pencilConfig.flow;
    const effectiveGrain = grain;

    offCtx.save();
    offCtx.globalAlpha = clamp(opacity, 0.05, 1.0);

    // 1. Soft underlying graphite lead tone for rich core
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const avgP = (p1.pressure + p2.pressure) / 2;
      const avgW = Math.max(0.8, (p1.width + p2.width) * 0.45);
      const segTipAlpha = (p1.tipAlpha + p2.tipAlpha) / 2;
      const coreAlpha = clamp(
        effectiveFlow * avgP * 0.35 * (1.1 - effectiveGrain * 0.3) * segTipAlpha,
        0.02,
        0.7
      );

      offCtx.beginPath();
      offCtx.lineCap = 'round';
      offCtx.lineJoin = 'round';
      offCtx.lineWidth = avgW;
      offCtx.strokeStyle = `rgba(${rCol}, ${gCol}, ${bCol}, ${coreAlpha.toFixed(3)})`;
      offCtx.moveTo(p1.x, p1.y);
      offCtx.lineTo(p2.x, p2.y);
      offCtx.stroke();
    }

    // 2. Cold-press paper tooth ridges catching micro-graphite flakes
    const stampStep = Math.max(1, Math.round(pts.length / 55));
    for (let i = 0; i < pts.length; i += stampStep) {
      const pt = pts[i];
      const radius = Math.max(0.8, pt.width / 2);
      const pressure = clamp(pt.pressure, 0.05, 1.0);

      const effectiveThreshold = Math.max(
        15,
        baseThreshold - pressure * sens + (1 - effectiveGrain) * 45
      );

      // Flake count scales with pencil grade density and pressure
      const count = Math.max(
        3,
        Math.round(radius * 3.6 * (pDensity / 12) * (0.55 + pressure * 0.65))
      );

      for (let p = 0; p < count; p++) {
        // Gaussian radial dispersion
        const u1 = Math.max(0.0001, rand());
        const u2 = rand();
        const r = radius * Math.sqrt(-2.0 * Math.log(u1)) * 0.46;
        const theta = 2.0 * Math.PI * u2;

        const flakeSize = Math.max(0.9, pSize);
        const px = pt.x + r * Math.cos(theta);
        const py = pt.y + r * Math.sin(theta);

        // World-anchored cold-press paper grain lookup
        // Coords scaled by 1.6 so paper tooth is clearly visible in preview
        const paperHeight = getPaperGrain(px * 1.6, py * 1.6);

        if (paperHeight >= effectiveThreshold) {
          const heightFactor = Math.min(1.0, (paperHeight - effectiveThreshold + 24) / 52);
          const distFactor = Math.max(0.12, 1 - r / (radius * 1.25));
          const flakeJitter = 0.86 + rand() * 0.28;
          const alpha = clamp(
            effectiveFlow * pressure * heightFactor * distFactor * flakeJitter * 0.95 * pt.tipAlpha,
            0.03,
            1.0
          );

          offCtx.fillStyle = `rgba(${rCol}, ${gCol}, ${bCol}, ${alpha.toFixed(3)})`;
          offCtx.fillRect(
            px - flakeSize / 2,
            py - flakeSize / 2,
            flakeSize,
            flakeSize
          );
        }
      }
    }
    offCtx.restore();
  } else if (tipImage) {
    // TEXTURED CUSTOM BRUSH PREVIEW (Clip Studio Paint Tip & Builtin Presets):
    const tip = tipImage;
    const thickness = options.thickness ?? 1.0;
    const aspect =
      ((tip.naturalHeight || tip.height || 1) / (tip.naturalWidth || tip.width || 1)) * thickness;
    const effFlow = clamp(flow, 0.05, 1.0);
    const baseAngleRad = (((options.customTipAngle ?? 0)) * Math.PI) / 180;
    const master = getTintedTipMaster(tip, strokeColor);

    offCtx.save();
    if (options.antiAlias === 0) {
      offCtx.imageSmoothingEnabled = false;
    }
    const stepInterval = Math.max(1, Math.round(pts.length / 45));

    for (let i = 0; i < pts.length; i += stepInterval) {
      const pt = pts[i];
      const stampW = Math.max(1.5, pt.width);
      const stampH = stampW * aspect;
      const alpha = clamp(opacity * effFlow * pt.tipAlpha, 0.03, 1.0);

      offCtx.save();
      offCtx.globalAlpha = alpha;

      if (options.spray?.enabled) {
        const pSize = Math.max(1, options.spray.size || 2);
        const radius = stampW / 2;
        const count = Math.max(1, options.spray.density || 4);
        for (let sp = 0; sp < count; sp++) {
          const r = radius * Math.sqrt(Math.random());
          const th = Math.random() * Math.PI * 2;
          offCtx.drawImage(
            master,
            pt.x + r * Math.cos(th) - pSize / 2,
            pt.y + r * Math.sin(th) - (pSize * aspect) / 2,
            pSize,
            pSize * aspect
          );
        }
      } else {
        offCtx.translate(pt.x, pt.y);
        if (baseAngleRad !== 0) {
          offCtx.rotate(baseAngleRad);
        }
        offCtx.drawImage(master, -stampW / 2, -stampH / 2, stampW, stampH);
      }
      offCtx.restore();
    }
    offCtx.restore();
  } else {
    // ROUND INK BRUSH PREVIEW:
    // Smooth, solid, clean line with tapered ends and hardness falloff
    offCtx.save();
    offCtx.lineCap = 'round';
    offCtx.lineJoin = 'round';

    const effHardness = clamp(hardness, 0.05, 1.0);
    const effFlow = clamp(flow, 0.05, 1.0);
    offCtx.globalAlpha = clamp(opacity * effFlow, 0.05, 1.0);

    if (effHardness < 0.96) {
      // Soft / feathered edge (airbrush-like)
      offCtx.shadowBlur = (1 - effHardness) * Math.max(1, displayWidth * 0.6);
      offCtx.shadowColor = `rgba(${rCol}, ${gCol}, ${bCol}, ${(effFlow * 0.9).toFixed(3)})`;
    }

    offCtx.strokeStyle = strokeColor;

    // CSP Wet Edge (Water Edge) rim effect in preview
    if (options.wetEdge && options.wetEdge > 0.05) {
      offCtx.save();
      offCtx.strokeStyle = `rgba(${Math.round(rCol * 0.6)}, ${Math.round(gCol * 0.6)}, ${Math.round(bCol * 0.6)}, ${(clamp(opacity * effFlow, 0.1, 1.0) * (0.35 + options.wetEdge * 0.55)).toFixed(3)})`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const avgW = (p1.width + p2.width) / 2;
        offCtx.beginPath();
        offCtx.lineWidth = avgW + 1.2;
        offCtx.moveTo(p1.x, p1.y);
        offCtx.lineTo(p2.x, p2.y);
        offCtx.stroke();
      }
      offCtx.restore();
    }

    // Draw tapered segments with calligraphic tip alpha
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const avgW = (p1.width + p2.width) / 2;
      const segTipAlpha = (p1.tipAlpha + p2.tipAlpha) / 2;

      offCtx.save();
      offCtx.globalAlpha = clamp(opacity * effFlow * segTipAlpha, 0.05, 1.0);
      offCtx.beginPath();
      offCtx.lineWidth = avgW;
      offCtx.moveTo(p1.x, p1.y);
      offCtx.lineTo(p2.x, p2.y);
      offCtx.stroke();
      offCtx.restore();
    }
    offCtx.restore();
  }

  offCtx.restore();

  // Draw to target canvas
  ctx.clearRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(offscreen, 0, 0);

  // Cache offscreen canvas
  if (previewCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = previewCache.keys().next().value;
    if (firstKey) previewCache.delete(firstKey);
  }
  previewCache.set(cacheKey, offscreen);
}

/**
 * Clears the brush preview offscreen cache.
 */
export function clearBrushPreviewCache() {
  previewCache.clear();
}
