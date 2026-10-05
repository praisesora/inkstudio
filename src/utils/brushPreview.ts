import { BrushPresetId, CspSpraySettings } from '../types/editor';
import { PENCIL_CONFIGS, PencilGrade, getPaperGrain, getGraphiteTipMaster } from './pencilEngine';
import { getTintedTipMaster, getRadialDabMaster, drawSingleStamp } from './stampEngine';
import { getBuiltinBrushConfig } from './presetBrushes';
import { evaluateCspSpline } from './sutParser';

export interface BrushPreviewOptions {
  preset?: BrushPresetId;
  size?: number;
  flow?: number;
  opacity?: number;
  grain?: number;
  hardness?: number;
  spacing?: number;
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
  const builtinCfg = !options.customTipImage && options.preset ? getBuiltinBrushConfig(options.preset) : null;
  const isPencil = preset.startsWith('pencil');
  const pencilConfig = isPencil ? PENCIL_CONFIGS[preset as PencilGrade] : null;

  const size = options.size ?? pencilConfig?.defaultSize ?? builtinCfg?.size ?? 14;
  const flow = options.flow ?? pencilConfig?.flow ?? builtinCfg?.flow ?? 0.85;
  const opacity = options.opacity ?? builtinCfg?.opacity ?? 1.0;
  const grain = options.grain ?? pencilConfig?.grain ?? builtinCfg?.grain ?? 0;
  const hardness = options.hardness ?? pencilConfig?.hardness ?? builtinCfg?.hardness ?? 1.0;
  const minSizeFactor = options.minSizeFactor ?? pencilConfig?.minSizeFactor ?? builtinCfg?.minSizeFactor ?? 0.15;
  const thickness = options.thickness ?? builtinCfg?.thickness ?? 1.0;
  const customTipAngle = options.customTipAngle ?? builtinCfg?.customTipAngle ?? 0;
  const spacing = options.spacing ?? builtinCfg?.spacing ?? (isPencil ? 0.07 : 0.045);
  const isEraser = options.tool === 'eraser';
  const strokeColor = options.color || '#ffffff';
  const bgColor = options.backgroundColor || 'transparent';
  const tipImage = options.customTipImage || builtinCfg?.customTipImage;

  // Cache key
  const cacheKey = [
    preset,
    size.toFixed(1),
    flow.toFixed(2),
    opacity.toFixed(2),
    grain.toFixed(2),
    hardness.toFixed(2),
    thickness.toFixed(2),
    customTipAngle.toFixed(1),
    spacing.toFixed(3),
    options.antiAlias !== undefined ? String(options.antiAlias) : '2',
    options.spray?.enabled ? 'spray' : 'dab',
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
    const effMinSize = Math.max(0.02, minSizeFactor * tipFactor);
    const tipAlpha = Math.min(1.0, Math.sin(Math.PI * u) * 4.2);

    // Taper width from effMinSize to full displayWidth
    const w = Math.max(0.8, displayWidth * (effMinSize + (1 - effMinSize) * pressure));

    pts.push({ x, y, width: w, pressure, tipAlpha });
  }

  if (isEraser) {
    // ERASER PREVIEW:
    // Render a subtle tone band, with the eraser cleanly carving through it
    offCtx.save();
    offCtx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    offCtx.fillRect(padX - 4, centerY - amp - 4, strokeLength + 8, (amp + 4) * 2);

    const eraserMaster = getRadialDabMaster(hardness, '#000000', true);
    const baseAngleRad = (customTipAngle * Math.PI) / 180;
    const effSpacing = Math.max(0.02, Math.min(0.2, spacing));

    let distanceAcc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const segDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const stepCount = Math.max(1, Math.ceil(segDist / 0.5));
      for (let s = 0; s < stepCount; s++) {
        const t = s / stepCount;
        const curX = p1.x + t * (p2.x - p1.x);
        const curY = p1.y + t * (p2.y - p1.y);
        const curW = p1.width + t * (p2.width - p1.width);
        const curTipAlpha = p1.tipAlpha + t * (p2.tipAlpha - p1.tipAlpha);

        const requiredStep = Math.max(0.5, curW * effSpacing);
        distanceAcc += segDist / stepCount;
        if (distanceAcc >= requiredStep) {
          distanceAcc = 0;
          const stampW = Math.max(1.0, curW);
          const stampH = stampW * thickness;
          const alpha = clamp(opacity * flow * curTipAlpha, 0.05, 1.0);
          drawSingleStamp(offCtx, eraserMaster, curX, curY, stampW, stampH, baseAngleRad, alpha, true, false);
        }
      }
    }
    offCtx.restore();
  } else if (isPencil && pencilConfig) {
    // PENCIL PHYSICS PREVIEW:
    // Authentic cold-press paper grain tooth & micro-graphite flake distribution
    offCtx.save();
    offCtx.globalAlpha = clamp(opacity, 0.05, 1.0);

    const graphiteMaster = getGraphiteTipMaster(preset as PencilGrade, strokeColor);
    const baseThreshold = pencilConfig.thresholdBase;
    const sens = pencilConfig.thresholdPressureSensitivity;
    const effFlow = flow * pencilConfig.flow;
    const effSpacing = Math.max(0.02, Math.min(0.12, spacing));

    let distanceAcc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const segDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const stepCount = Math.max(1, Math.ceil(segDist / 0.6));
      for (let s = 0; s < stepCount; s++) {
        const t = s / stepCount;
        const curX = p1.x + t * (p2.x - p1.x);
        const curY = p1.y + t * (p2.y - p1.y);
        const curW = p1.width + t * (p2.width - p1.width);
        const curP = p1.pressure + t * (p2.pressure - p1.pressure);
        const curTipAlpha = p1.tipAlpha + t * (p2.tipAlpha - p1.tipAlpha);

        const requiredStep = Math.max(0.4, curW * effSpacing);
        distanceAcc += segDist / stepCount;
        if (distanceAcc >= requiredStep) {
          distanceAcc = 0;
          const paperHeight = getPaperGrain(curX * 1.6, curY * 1.6);
          const effThreshold = Math.max(
            15,
            baseThreshold - curP * sens + (1 - grain) * 40
          );

          if (paperHeight >= effThreshold) {
            const heightFactor = Math.min(1.0, (paperHeight - effThreshold + 25) / 55);
            const dabAlpha = clamp(
              effFlow * (0.35 + 0.65 * curP) * heightFactor * curTipAlpha,
              0.04,
              1.0
            );
            drawSingleStamp(offCtx, graphiteMaster, curX, curY, curW, curW, 0, dabAlpha);
          } else if (curP > 0.55) {
            const dabAlpha = clamp(effFlow * 0.16 * curP * curTipAlpha, 0.02, 1.0);
            drawSingleStamp(offCtx, graphiteMaster, curX, curY, curW, curW, 0, dabAlpha);
          }
        }
      }
    }
    offCtx.restore();
  } else if (tipImage) {
    // TEXTURED CUSTOM BRUSH PREVIEW (Clip Studio Paint Tip & Builtin Presets):
    const tip = tipImage;
    const aspect =
      ((tip.naturalHeight || tip.height || 1) / (tip.naturalWidth || tip.width || 1)) * thickness;
    const baseAngleRad = (((options.customTipAngle ?? 0)) * Math.PI) / 180;
    const master = getTintedTipMaster(tip, strokeColor);
    const effSpacing = Math.max(0.02, Math.min(0.2, spacing));

    offCtx.save();
    if (options.antiAlias === 0) {
      offCtx.imageSmoothingEnabled = false;
    }

    let distanceAcc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const segDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const stepCount = Math.max(1, Math.ceil(segDist / 0.6));
      for (let s = 0; s < stepCount; s++) {
        const t = s / stepCount;
        const curX = p1.x + t * (p2.x - p1.x);
        const curY = p1.y + t * (p2.y - p1.y);
        const curW = p1.width + t * (p2.width - p1.width);
        const curTipAlpha = p1.tipAlpha + t * (p2.tipAlpha - p1.tipAlpha);

        const requiredStep = Math.max(0.6, curW * effSpacing);
        distanceAcc += segDist / stepCount;
        if (distanceAcc >= requiredStep) {
          distanceAcc = 0;
          const stampW = Math.max(1.5, curW);
          const stampH = stampW * aspect;
          const alpha = clamp(opacity * flow * curTipAlpha, 0.03, 1.0);

          if (options.spray?.enabled) {
            const pSize = Math.max(1, options.spray.size || 2);
            const radius = stampW / 2;
            const count = Math.max(1, options.spray.density || 4);
            for (let sp = 0; sp < count; sp++) {
              const r = radius * Math.sqrt(Math.random());
              const th = Math.random() * Math.PI * 2;
              offCtx.drawImage(
                master,
                curX + r * Math.cos(th) - pSize / 2,
                curY + r * Math.sin(th) - (pSize * aspect) / 2,
                pSize,
                pSize * aspect
              );
            }
          } else {
            drawSingleStamp(offCtx, master, curX, curY, stampW, stampH, baseAngleRad, alpha);
          }
        }
      }
    }
    offCtx.restore();
  } else {
    // ROUND INK & ANALYTICAL DAB BRUSH PREVIEW (Airbrush, G-Pen, Maru Pen, Turnip Pen, Flat Marker, Round):
    offCtx.save();
    const effHardness = clamp(hardness, 0.0, 1.0);
    const effFlow = clamp(flow, 0.01, 1.0);
    const master = getRadialDabMaster(effHardness, strokeColor);
    const baseAngleRad = (customTipAngle * Math.PI) / 180;
    const effSpacing = Math.max(0.02, Math.min(0.2, spacing));

    // Optional CSP Wet Edge rim
    if (options.wetEdge && options.wetEdge > 0.05) {
      const rimMaster = getRadialDabMaster(Math.min(1.0, effHardness + 0.1), strokeColor);
      let wetAcc = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const segDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const stepCount = Math.max(1, Math.ceil(segDist / 0.6));
        for (let s = 0; s < stepCount; s++) {
          const t = s / stepCount;
          const curX = p1.x + t * (p2.x - p1.x);
          const curY = p1.y + t * (p2.y - p1.y);
          const curW = (p1.width + t * (p2.width - p1.width)) * (1.0 + options.wetEdge * 0.22);
          const curTipAlpha = p1.tipAlpha + t * (p2.tipAlpha - p1.tipAlpha);

          const requiredStep = Math.max(0.6, curW * effSpacing * 1.5);
          wetAcc += segDist / stepCount;
          if (wetAcc >= requiredStep) {
            wetAcc = 0;
            const stampW = Math.max(1.2, curW);
            const stampH = stampW * thickness;
            const rimAlpha = clamp(opacity * effFlow * curTipAlpha * (0.2 + options.wetEdge * 0.4), 0.02, 1.0);
            drawSingleStamp(offCtx, rimMaster, curX, curY, stampW, stampH, baseAngleRad, rimAlpha);
          }
        }
      }
    }

    let distanceAcc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const segDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const stepCount = Math.max(1, Math.ceil(segDist / 0.6));
      for (let s = 0; s < stepCount; s++) {
        const t = s / stepCount;
        const curX = p1.x + t * (p2.x - p1.x);
        const curY = p1.y + t * (p2.y - p1.y);
        const curW = p1.width + t * (p2.width - p1.width);
        const curTipAlpha = p1.tipAlpha + t * (p2.tipAlpha - p1.tipAlpha);

        const requiredStep = Math.max(0.5, curW * effSpacing);
        distanceAcc += segDist / stepCount;
        if (distanceAcc >= requiredStep) {
          distanceAcc = 0;
          const stampW = Math.max(0.8, curW);
          const stampH = stampW * thickness;
          const alpha = clamp(opacity * effFlow * curTipAlpha, 0.02, 1.0);
          drawSingleStamp(offCtx, master, curX, curY, stampW, stampH, baseAngleRad, alpha);
        }
      }
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
