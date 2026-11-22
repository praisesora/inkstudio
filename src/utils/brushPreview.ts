import {
  BrushDynamics,
  BrushPresetId,
  CspAngleDynamicsMode,
  CspAntiAliasLevel,
  CspBlendTipsMode,
  CspPaperTextureMode,
  CspSpraySettings,
  CspTipFlipMode,
} from '../types/editor';
import { getBuiltinBrushConfig } from './presetBrushes';
import {
  getLegacyPencilPresetDefaults,
  getPaperGrain,
  getTintedTipMaster,
  getRadialDabMaster,
  drawSingleStamp,
  evaluateFastSpline,
  dabHashFloat,
  computeGapAdjustedAlpha,
  resolveTipFlipSigns,
  applyCspPaperTextureAlpha,
} from '../engine/BrushEngine';

export interface BrushPreviewOptions {
  preset?: BrushPresetId;
  size?: number;
  flow?: number;
  opacity?: number;
  grain?: number;
  paperTextureMode?: CspPaperTextureMode;
  paperTextureScale?: number;
  paperTextureContrast?: number;
  paperTextureBrightness?: number;
  paperTextureInverted?: boolean;
  hardness?: number;
  spacing?: number;
  minSizeFactor?: number;
  usePressure?: boolean;
  color?: string;
  backgroundColor?: string;
  isSelected?: boolean;
  tool?: 'brush' | 'eraser';
  customTipImage?: HTMLImageElement;
  customTipAngle?: number;
  customTipAngleDynamics?: CspAngleDynamicsMode;
  thickness?: number;
  thicknessVertical?: boolean;
  flipH?: CspTipFlipMode;
  flipV?: CspTipFlipMode;
  blendTipsMode?: CspBlendTipsMode;
  adjustDensityByGap?: boolean;
  antiAlias?: number;
  pressureCurve?: [number, number][];
  spray?: CspSpraySettings;
  dynamics?: BrushDynamics;
  colorMixing?: boolean;
  amountOfPaint?: number;
  densityOfPaint?: number;
  colorStretch?: number;
  wetEdge?: number;
}

const previewCache = new Map<string, HTMLCanvasElement>();
const MAX_CACHE_ENTRIES = 80;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function getTipCacheIdentity(tip?: HTMLImageElement): string {
  if (!tip) return 'std';
  const src = tip.src || '';
  const tail = src.length > 40 ? src.slice(-40) : src;
  return `${tip.naturalWidth || tip.width || 0}x${tip.naturalHeight || tip.height || 0}:${src.length}:${tail}`;
}

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

  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const preset = options.preset || (options.customTipImage ? 'custom' : 'g-pen');
  const builtinCfg =
    !options.customTipImage && options.preset
      ? getBuiltinBrushConfig(options.preset) || getLegacyPencilPresetDefaults(options.preset)
      : null;
  const tipImage = options.customTipImage || builtinCfg?.customTipImage;

  const size = options.size ?? builtinCfg?.size ?? 14;
  const flow = options.flow ?? builtinCfg?.flow ?? 0.85;
  const opacity = options.opacity ?? builtinCfg?.opacity ?? 1.0;
  const grain = options.grain ?? builtinCfg?.grain ?? 0;
  const hardness = options.hardness ?? builtinCfg?.hardness ?? 1.0;
  const minSizeFactor = options.minSizeFactor ?? builtinCfg?.minSizeFactor ?? 0.15;
  const thickness = options.thickness ?? builtinCfg?.thickness ?? 1.0;
  const thicknessVertical = Boolean(options.thicknessVertical ?? builtinCfg?.thicknessVertical);
  const customTipAngle = options.customTipAngle ?? builtinCfg?.customTipAngle ?? 0;
  const angleDynamics = options.customTipAngleDynamics ?? builtinCfg?.customTipAngleDynamics ?? 'none';
  const dynamics = options.dynamics ?? builtinCfg?.dynamics;
  const paperMode = options.paperTextureMode ?? builtinCfg?.paperTextureMode ?? 'subtract';
  const paperScale = options.paperTextureScale ?? builtinCfg?.paperTextureScale ?? 1.0;
  const paperContrast = options.paperTextureContrast ?? builtinCfg?.paperTextureContrast ?? 0;
  const paperBrightness = options.paperTextureBrightness ?? builtinCfg?.paperTextureBrightness ?? 0;
  const paperInverted = Boolean(options.paperTextureInverted ?? builtinCfg?.paperTextureInverted);
  const spacing = options.spacing ?? builtinCfg?.spacing ?? 0.045;
  const blendTipsMode = options.blendTipsMode ?? builtinCfg?.blendTipsMode ?? 'darken';
  const adjustByGap = Boolean(options.adjustDensityByGap ?? builtinCfg?.adjustDensityByGap);
  const aaLevel = clamp(
    Math.round(options.antiAlias ?? builtinCfg?.antiAlias ?? 2),
    0,
    3
  ) as CspAntiAliasLevel;
  const isEraser = options.tool === 'eraser';
  const strokeColor = options.color || '#ffffff';
  const bgColor = options.backgroundColor || 'transparent';

  const curveSig = options.pressureCurve
    ? options.pressureCurve.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(';')
    : 'lin';

  const cacheKey = [
    preset,
    size.toFixed(1),
    flow.toFixed(2),
    opacity.toFixed(2),
    grain.toFixed(2),
    hardness.toFixed(2),
    minSizeFactor.toFixed(2),
    thickness.toFixed(2),
    thicknessVertical ? 'tv' : 'th',
    customTipAngle.toFixed(1),
    spacing.toFixed(3),
    String(aaLevel),
    blendTipsMode,
    adjustByGap ? 'gap1' : 'gap0',
    options.flipH || 'n',
    options.flipV || 'n',
    options.spray?.enabled ? `sp:${options.spray.size}:${options.spray.density}` : 'dab',
    getTipCacheIdentity(tipImage),
    curveSig,
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

  const offscreen = document.createElement('canvas');
  offscreen.width = targetWidth;
  offscreen.height = targetHeight;
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) return;

  offCtx.save();
  offCtx.scale(dpr, dpr);

  if (bgColor !== 'transparent') {
    offCtx.fillStyle = bgColor;
    offCtx.fillRect(0, 0, cssWidth, cssHeight);
  } else {
    offCtx.clearRect(0, 0, cssWidth, cssHeight);
  }

  const padX = Math.max(12, Math.round(cssWidth * 0.1));
  const strokeLength = cssWidth - 2 * padX;
  const centerY = cssHeight / 2;
  const maxAmp = Math.min(cssHeight * 0.28, isLiveCard ? 14 : 9);
  const amp = Math.max(4, maxAmp);
  const displayWidth = calculatePreviewWidth(size, cssHeight, isLiveCard);

  const numSteps = Math.min(120, Math.max(60, Math.round(cssWidth * 0.65)));
  const pts: { x: number; y: number; width: number; pressure: number; tipAlpha: number }[] = [];

  for (let i = 0; i <= numSteps; i++) {
    const u = i / numSteps;
    const x = padX + u * strokeLength;
    const y = centerY - Math.sin(2 * Math.PI * u) * amp;

    const sineEnv = Math.sin(Math.PI * u);
    let pressure = Math.pow(Math.max(0, sineEnv), 0.75);
    if (options.pressureCurve) {
      pressure = evaluateFastSpline(pressure, options.pressureCurve);
    }

    const tipFactor = Math.min(1.0, sineEnv * 2.8);
    const effMinSize = Math.max(0.02, minSizeFactor * tipFactor);
    const tipAlpha = Math.min(1.0, sineEnv * 4.2);
    const w = Math.max(0.7, displayWidth * (effMinSize + (1 - effMinSize) * pressure));

    pts.push({ x, y, width: w, pressure, tipAlpha });
  }

  if (isEraser) {
    offCtx.save();
    offCtx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    offCtx.fillRect(padX - 4, centerY - amp - 4, strokeLength + 8, (amp + 4) * 2);

    const eraserMaster = getRadialDabMaster(hardness, '#000000', true, displayWidth, aaLevel);
    const baseAngleRad = (customTipAngle * Math.PI) / 180;
    const effSpacing = clamp(spacing, 0.02, 0.25);

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

        const requiredStep = Math.max(0.4, curW * effSpacing);
        distanceAcc += segDist / stepCount;
        if (distanceAcc >= requiredStep) {
          distanceAcc = 0;
          const stampW = thicknessVertical ? Math.max(1.0, curW * thickness) : Math.max(1.0, curW);
          const stampH = thicknessVertical ? Math.max(1.0, curW) : Math.max(1.0, curW * thickness);
          const alpha = clamp(opacity * flow * curTipAlpha, 0.05, 1.0);
          drawSingleStamp(
            offCtx,
            eraserMaster,
            curX,
            curY,
            stampW,
            stampH,
            baseAngleRad,
            alpha,
            true,
            false,
            false,
            false,
            1,
            1,
            aaLevel
          );
        }
      }
    }
    offCtx.restore();
  } else if (tipImage && tipImage.complete !== false && (tipImage.naturalWidth || tipImage.width) > 0) {
    const tip = tipImage;
    const rawAspect = (tip.naturalHeight || tip.height || 1) / (tip.naturalWidth || tip.width || 1);
    const baseAngleRad = (customTipAngle * Math.PI) / 180;
    const master = getTintedTipMaster(tip, strokeColor);
    const effSpacing = clamp(spacing, 0.02, 0.25);
    const baseFlow = computeGapAdjustedAlpha(flow, effSpacing, adjustByGap);
    const scatterAmt = clamp(dynamics?.scatter ?? 0, 0, 1.5);
    const sizeJit = clamp(dynamics?.sizeJitter ?? 0, 0, 1);
    const flowJit = clamp(dynamics?.flowJitter ?? 0, 0, 1);
    const angleJit = clamp(dynamics?.angleJitter ?? 0, 0, 1);
    const dabCount = Math.max(1, Math.min(3, Math.round(dynamics?.count ?? 1)));

    offCtx.save();
    let distanceAcc = 0;
    let dabIdx = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const segDx = p2.x - p1.x;
      const segDy = p2.y - p1.y;
      const segDist = Math.hypot(segDx, segDy);
      const tangentAngle = Math.atan2(segDy, segDx);
      const nx = segDist > 1e-4 ? -segDy / segDist : 0;
      const ny = segDist > 1e-4 ? segDx / segDist : 1;
      const stepCount = Math.max(1, Math.ceil(segDist / 0.6));
      for (let s = 0; s < stepCount; s++) {
        const t = s / stepCount;
        const curX = p1.x + t * segDx;
        const curY = p1.y + t * segDy;
        const curW = p1.width + t * (p2.width - p1.width);
        const curP = p1.pressure + t * (p2.pressure - p1.pressure);
        const curTipAlpha = p1.tipAlpha + t * (p2.tipAlpha - p1.tipAlpha);

        const requiredStep = Math.max(0.5, curW * effSpacing);
        distanceAcc += segDist / stepCount;
        if (distanceAcc >= requiredStep) {
          distanceAcc = 0;
          dabIdx++;

          for (let k = 0; k < dabCount; k++) {
            const seq = dabIdx * 8 + k;
            let baseW = Math.max(1.2, curW);
            if (sizeJit > 0) {
              baseW *= Math.max(0.2, 1.0 - dabHashFloat(curX, curY, seq, 1) * sizeJit);
            }
            const stampW = thicknessVertical ? baseW * thickness : baseW;
            const stampH = thicknessVertical ? baseW * rawAspect : baseW * rawAspect * thickness;

            let alpha = clamp(opacity * baseFlow * curTipAlpha, 0.03, 1.0);
            if (flowJit > 0) {
              alpha *= Math.max(0.1, 1.0 - dabHashFloat(curX, curY, seq, 6) * flowJit);
            }
            if (grain > 0.01) {
              const gNorm = getPaperGrain((curX * 1.4) / Math.max(0.2, paperScale), (curY * 1.4) / Math.max(0.2, paperScale)) / 255.0;
              alpha = applyCspPaperTextureAlpha(
                alpha,
                gNorm,
                grain,
                curP,
                paperMode,
                paperBrightness,
                paperContrast,
                paperInverted
              );
            }
            if (alpha <= 0.005) continue;

            let dabAngle = baseAngleRad;
            if (angleDynamics === 'direction' || angleDynamics === 'direction-random') {
              dabAngle += tangentAngle;
            }
            if (angleDynamics === 'random' || angleDynamics === 'direction-random' || angleJit > 0) {
              const jScale = angleDynamics === 'random' ? 1.0 : Math.max(angleJit, 0.3);
              dabAngle += (dabHashFloat(curX, curY, seq, 3) - 0.5) * Math.PI * 2 * jScale;
            }

            let drawX = curX;
            let drawY = curY;
            if (scatterAmt > 0) {
              const off = (dabHashFloat(curX, curY, seq, 4) * 2 - 1) * baseW * scatterAmt;
              drawX += nx * off;
              drawY += ny * off;
            }

            const flips = resolveTipFlipSigns(options.flipH, options.flipV, seq, drawX, drawY);

            if (options.spray?.enabled) {
              const pSize = Math.max(1, options.spray.size || 2);
              const radius = baseW * 0.5;
              const count = Math.max(1, options.spray.density || 4);
              for (let sp = 0; sp < count; sp++) {
                const r = radius * Math.sqrt(dabHashFloat(drawX, drawY, seq * 32 + sp, 91));
                const th = dabHashFloat(drawX, drawY, seq * 32 + sp, 92) * Math.PI * 2;
                drawSingleStamp(
                  offCtx,
                  master,
                  drawX + r * Math.cos(th),
                  drawY + r * Math.sin(th),
                  pSize,
                  pSize * rawAspect,
                  dabAngle,
                  alpha,
                  false,
                  false,
                  false,
                  false,
                  flips.signX,
                  flips.signY,
                  aaLevel,
                  blendTipsMode
                );
              }
            } else {
              drawSingleStamp(
                offCtx,
                master,
                drawX,
                drawY,
                stampW,
                stampH,
                dabAngle,
                alpha,
                false,
                false,
                false,
                false,
                flips.signX,
                flips.signY,
                aaLevel,
                blendTipsMode
              );
            }
          }
        }
      }
    }
    offCtx.restore();
  } else {
    offCtx.save();
    const effHardness = clamp(hardness, 0.0, 1.0);
    const effSpacing = clamp(spacing, 0.02, 0.25);
    const effFlow = computeGapAdjustedAlpha(clamp(flow, 0.01, 1.0), effSpacing, adjustByGap);
    const master = getRadialDabMaster(effHardness, strokeColor, false, displayWidth, aaLevel);
    const baseAngleRad = (customTipAngle * Math.PI) / 180;

    if (options.wetEdge && options.wetEdge > 0.05) {
      const rimMaster = getRadialDabMaster(Math.min(1.0, effHardness + 0.12), strokeColor, false, displayWidth, aaLevel);
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
          const curW = (p1.width + t * (p2.width - p1.width)) * (1.0 + options.wetEdge * 0.2);
          const curTipAlpha = p1.tipAlpha + t * (p2.tipAlpha - p1.tipAlpha);

          const requiredStep = Math.max(0.6, curW * effSpacing * 1.4);
          wetAcc += segDist / stepCount;
          if (wetAcc >= requiredStep) {
            wetAcc = 0;
            const baseW = Math.max(1.1, curW);
            const stampW = thicknessVertical ? baseW * thickness : baseW;
            const stampH = thicknessVertical ? baseW : baseW * thickness;
            const rimAlpha = clamp(
              opacity * effFlow * curTipAlpha * (0.2 + options.wetEdge * 0.4),
              0.02,
              1.0
            );
            drawSingleStamp(
              offCtx,
              rimMaster,
              curX,
              curY,
              stampW,
              stampH,
              baseAngleRad,
              rimAlpha,
              false,
              false,
              false,
              false,
              1,
              1,
              aaLevel,
              blendTipsMode
            );
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

        const requiredStep = Math.max(0.45, curW * effSpacing);
        distanceAcc += segDist / stepCount;
        if (distanceAcc >= requiredStep) {
          distanceAcc = 0;
          const baseW = Math.max(0.7, curW);
          const stampW = thicknessVertical ? baseW * thickness : baseW;
          const stampH = thicknessVertical ? baseW : baseW * thickness;
          let alpha = clamp(opacity * effFlow * curTipAlpha, 0.02, 1.0);
          if (grain > 0.01) {
            const curP = p1.pressure + t * (p2.pressure - p1.pressure);
            const gNorm = getPaperGrain((curX * 1.4) / Math.max(0.2, paperScale), (curY * 1.4) / Math.max(0.2, paperScale)) / 255.0;
            alpha = applyCspPaperTextureAlpha(
              alpha,
              gNorm,
              grain,
              curP,
              paperMode,
              paperBrightness,
              paperContrast,
              paperInverted
            );
          }
          if (alpha <= 0.005) continue;
          drawSingleStamp(
            offCtx,
            master,
            curX,
            curY,
            stampW,
            stampH,
            baseAngleRad,
            alpha,
            false,
            false,
            false,
            false,
            1,
            1,
            aaLevel,
            blendTipsMode
          );
        }
      }
    }
    offCtx.restore();
  }

  offCtx.restore();

  ctx.clearRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(offscreen, 0, 0);

  if (previewCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = previewCache.keys().next().value;
    if (firstKey) previewCache.delete(firstKey);
  }
  previewCache.set(cacheKey, offscreen);
}

export function clearBrushPreviewCache() {
  previewCache.clear();
}
