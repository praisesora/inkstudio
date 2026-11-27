/**
 * DualBrushEngine.ts
 * Clip Studio Paint Dual Brush configuration resolver, secondary pass builder,
 * and exact CPU/GPU-matched Dual Brush combine mathematics.
 *
 * Implements CSP's true two-pass Dual Brush model:
 *   Pass 1 (Primary): Full primary stroke (including colorMixing / SpatialTipMixer, subTips, spray, ribbon, taper)
 *   Pass 2 (Secondary): Independent secondary brush along the same trajectory with its own size, spacing,
 *                       thickness, angle/angleDynamics, flips, hardness, density, spray, subTips, or ribbon
 *   Combine Pass: Modulates primary RGBA with secondary density a2 using DualBrushCompositeMode.
 */

import {
  BrushSettings,
  CspDualBrushConfig,
  DEFAULT_BRUSH_DYNAMICS,
  DualBrushCompositeMode,
  Point,
} from '../types/editor';
import type { CubicBezierSegment } from './SplineGenerator';

export const DUAL_BRUSH_COMPOSITE_MODES: readonly DualBrushCompositeMode[] = [
  'multiply',
  'darken',
  'subtract',
  'compare-density',
  'linear-burn',
  'color-burn',
  'height',
  'overlay',
  'screen',
  'lighten',
  'hard-mix',
  'normal',
] as const;

const DUAL_MODE_SET = new Set<string>(DUAL_BRUSH_COMPOSITE_MODES);

export function normalizeDualBrushCompositeMode(mode?: string): DualBrushCompositeMode {
  if (!mode || typeof mode !== 'string') return 'multiply';
  const cleaned = mode.trim().toLowerCase();
  if (DUAL_MODE_SET.has(cleaned)) {
    return cleaned as DualBrushCompositeMode;
  }
  if (cleaned === 'compare' || cleaned === 'compare_density') return 'compare-density';
  if (cleaned === 'linear_burn' || cleaned === 'linearburn') return 'linear-burn';
  if (cleaned === 'color_burn' || cleaned === 'colorburn') return 'color-burn';
  if (cleaned === 'hard_mix' || cleaned === 'hardmix') return 'hard-mix';
  if (cleaned === 'darker-color') return 'darken';
  if (cleaned === 'lighter-color') return 'lighten';
  if (cleaned === 'add' || cleaned === 'add-glow' || cleaned === 'color-dodge' || cleaned === 'color-dodge-glow') {
    return 'screen';
  }
  return 'multiply';
}

/**
 * Maps DualBrushCompositeMode to integer enum matching WebGlBrushEngine's
 * DUAL_COMBINE_FRAGMENT_SHADER_SRC `u_combineMode` uniform.
 */
export function dualBrushCompositeModeToIndex(mode: DualBrushCompositeMode): number {
  switch (mode) {
    case 'multiply':
      return 0;
    case 'darken':
      return 1;
    case 'subtract':
      return 2;
    case 'compare-density':
      return 3;
    case 'linear-burn':
      return 4;
    case 'color-burn':
      return 5;
    case 'height':
      return 6;
    case 'overlay':
      return 7;
    case 'screen':
      return 8;
    case 'lighten':
      return 9;
    case 'hard-mix':
      return 10;
    case 'normal':
      return 11;
    default:
      return 0;
  }
}

/**
 * Scalar CSP Dual Brush density combination matching the WebGL combine shader bit-for-bit.
 * `a1` is primary stroke straight alpha in [0, 1]; `a2` is secondary stroke density in [0, 1].
 */
export function combineDualBrushAlpha(
  a1: number,
  a2: number,
  mode: DualBrushCompositeMode
): number {
  if (a1 <= 1e-4) return 0;
  const p1 = a1 >= 1 ? 1 : a1;
  const p2 = a2 <= 0 ? 0 : a2 >= 1 ? 1 : a2;

  switch (mode) {
    case 'multiply':
      return p1 * p2;
    case 'darken':
      return p1 < p2 ? p1 : p2;
    case 'subtract': {
      const v = p1 - p2;
      return v > 0 ? v : 0;
    }
    case 'compare-density': {
      const sil = p1 * 4.0 < 1.0 ? p1 * 4.0 : 1.0;
      const eff2 = p2 * sil;
      return p1 > eff2 ? p1 : eff2;
    }
    case 'linear-burn': {
      const v = p1 + p2 - 1.0;
      return v > 0 ? v : 0;
    }
    case 'color-burn': {
      if (p2 <= 1e-4) return 0;
      const v = 1.0 - (1.0 - p1) / p2;
      return v > 0 ? v : 0;
    }
    case 'height': {
      const h = p1 + p2 - 1.0;
      if (h <= 0) return 0;
      if (h >= 0.25) return 1.0;
      const t = h * 4.0;
      return t * t * (3.0 - 2.0 * t);
    }
    case 'overlay':
      return p1 < 0.5 ? 2.0 * p1 * p2 : 1.0 - 2.0 * (1.0 - p1) * (1.0 - p2);
    case 'screen': {
      const sil = p1 * 4.0 < 1.0 ? p1 * 4.0 : 1.0;
      const eff2 = p2 * sil;
      return p1 + eff2 - p1 * eff2;
    }
    case 'lighten': {
      const sil = p1 * 4.0 < 1.0 ? p1 * 4.0 : 1.0;
      const eff2 = p2 * sil;
      return p1 > eff2 ? p1 : eff2;
    }
    case 'hard-mix':
      return p1 + p2 >= 1.0 ? 1.0 : 0.0;
    case 'normal': {
      const sil = p1 * 4.0 < 1.0 ? p1 * 4.0 : 1.0;
      const eff2 = p2 * sil;
      return p1 + eff2 * (1.0 - p1);
    }
    default:
      return p1 * p2;
  }
}

/**
 * Allocation-free tight CPU pixel combine loop.
 * Works both in-place (`outData === primaryData`) and into a separate output buffer.
 * `primaryData` contains straight RGBA from Pass 1; `secondaryData` contains Pass 2 density in alpha.
 */
export function combineDualBrushImageData(
  primaryData: Uint8ClampedArray,
  secondaryData: Uint8ClampedArray,
  outData: Uint8ClampedArray,
  mode: DualBrushCompositeMode
): void {
  const len = Math.min(primaryData.length, secondaryData.length, outData.length);
  const inv255 = 1 / 255;

  for (let i = 0; i < len; i += 4) {
    const a1Byte = primaryData[i + 3];
    if (a1Byte === 0) {
      outData[i] = 0;
      outData[i + 1] = 0;
      outData[i + 2] = 0;
      outData[i + 3] = 0;
      continue;
    }

    const a1 = a1Byte * inv255;
    const a2 = secondaryData[i + 3] * inv255;
    const outA = combineDualBrushAlpha(a1, a2, mode);
    const outAByte = outA <= 0 ? 0 : outA >= 1 ? 255 : (outA * 255 + 0.5) | 0;

    if (outAByte === 0) {
      outData[i] = 0;
      outData[i + 1] = 0;
      outData[i + 2] = 0;
      outData[i + 3] = 0;
    } else {
      outData[i] = primaryData[i];
      outData[i + 1] = primaryData[i + 1];
      outData[i + 2] = primaryData[i + 2];
      outData[i + 3] = outAByte;
    }
  }
}

export interface DualBrushSourceFields {
  size?: number;
  dualBrush?: boolean;
  dualBrushConfig?: CspDualBrushConfig;
  dualBrushCompositeMode?: DualBrushCompositeMode | string;
  dualSize?: number;
  dualLinkSize?: boolean;
  dualScale?: number;
  dualSpacing?: number;
  dualScatter?: number;
  dualThickness?: number;
  dualThicknessVertical?: boolean;
  dualAngle?: number;
  dualAngleDynamics?: CspDualBrushConfig['angleDynamics'];
  dualAngleSensor?: CspDualBrushConfig['angleSensor'];
  dualHardness?: number;
  dualDensity?: number;
  dualSubTips?: CspDualBrushConfig['subTips'];
  dualSubTipImages?: HTMLImageElement[];
  dualSubTipOrder?: CspDualBrushConfig['subTipOrder'];
  dualFlipH?: CspDualBrushConfig['flipH'];
  dualFlipV?: CspDualBrushConfig['flipV'];
  dualSpray?: CspDualBrushConfig['spray'];
  dualIsRibbon?: boolean;
  dualTipDataUrl?: string;
  dualTipImage?: HTMLImageElement;
}

/**
 * Resolves a unified `CspDualBrushConfig` from either `dualBrushConfig` or legacy flat fields.
 * Returns `null` when Dual Brush is inactive.
 */
export function resolveDualBrushConfig(
  src?: DualBrushSourceFields | null
): CspDualBrushConfig | null {
  if (!src) return null;
  const cfg = src.dualBrushConfig;
  const enabled = cfg ? cfg.enabled : Boolean(src.dualBrush);
  if (!enabled) return null;

  const compositeMode = normalizeDualBrushCompositeMode(
    cfg?.compositeMode ?? src.dualBrushCompositeMode
  );
  const linkSizeWithMain = cfg?.linkSizeWithMain ?? src.dualLinkSize;
  const size = cfg?.size ?? src.dualSize;
  const sizeRatio =
    cfg?.sizeRatio ??
    (src.dualScale !== undefined && src.dualScale > 0
      ? src.dualScale
      : undefined);

  return {
    enabled: true,
    compositeMode,
    linkSizeWithMain,
    size,
    sizeRatio,
    spacing: cfg?.spacing ?? src.dualSpacing,
    scatter: cfg?.scatter ?? src.dualScatter,
    thickness: cfg?.thickness ?? src.dualThickness,
    thicknessVertical: cfg?.thicknessVertical ?? src.dualThicknessVertical,
    hardness: cfg?.hardness ?? src.dualHardness,
    density: cfg?.density ?? src.dualDensity,
    angle: cfg?.angle ?? src.dualAngle,
    angleDynamics: cfg?.angleDynamics ?? src.dualAngleDynamics,
    angleSensor: cfg?.angleSensor ?? src.dualAngleSensor,
    flipH: cfg?.flipH ?? src.dualFlipH,
    flipV: cfg?.flipV ?? src.dualFlipV,
    spray: cfg?.spray ?? src.dualSpray,
    tipDataUrl: cfg?.tipDataUrl ?? src.dualTipDataUrl,
    tipImage: cfg?.tipImage ?? src.dualTipImage,
    subTips: cfg?.subTips ?? src.dualSubTips,
    subTipImages: cfg?.subTipImages ?? src.dualSubTipImages,
    subTipOrder: cfg?.subTipOrder ?? src.dualSubTipOrder,
    isRibbon: cfg?.isRibbon ?? src.dualIsRibbon,
  };
}

/**
 * Computes the effective secondary brush diameter in document pixels.
 */
export function computeSecondaryBrushSize(
  primarySize: number,
  cfg: CspDualBrushConfig,
  flatScale?: number
): number {
  const safeMain = Math.max(0.5, primarySize || 10);
  const scale = flatScale !== undefined && flatScale > 0 ? flatScale : 1.0;

  if (cfg.linkSizeWithMain) {
    if (cfg.sizeRatio !== undefined && cfg.sizeRatio > 0) {
      // When sizeRatio came from flatScale fallback, avoid applying flatScale twice
      const extraScale = cfg.size !== undefined ? scale : 1.0;
      return Math.max(0.5, safeMain * cfg.sizeRatio * extraScale);
    }
    return Math.max(0.5, safeMain * scale);
  }

  if (cfg.size !== undefined && cfg.size > 0) {
    return Math.max(0.5, cfg.size * scale);
  }

  if (cfg.sizeRatio !== undefined && cfg.sizeRatio > 0) {
    return Math.max(0.5, safeMain * cfg.sizeRatio);
  }

  return Math.max(0.5, safeMain * scale);
}

/**
 * Constructs a standalone secondary `BrushSettings` for Pass 2 from primary settings + `CspDualBrushConfig`.
 */
export function buildSecondaryBrushSettings(
  primaryBs: BrushSettings,
  cfg: CspDualBrushConfig
): { settings: BrushSettings; sizeRatio: number } {
  const mainSize = Math.max(0.5, primaryBs.size || 10);
  const secSize = computeSecondaryBrushSize(mainSize, cfg, primaryBs.dualScale);
  const sizeRatio = secSize / mainSize;

  const secondaryTipImage =
    cfg.tipImage ?? (cfg.subTipImages && cfg.subTipImages.length > 0 ? cfg.subTipImages[0] : undefined);
  const secondaryTipDataUrl =
    cfg.tipDataUrl ?? (cfg.subTips && cfg.subTips.length > 0 ? cfg.subTips[0].dataUrl : undefined);
  const scatter = cfg.scatter ?? 0;

  const settings: BrushSettings = {
    size: secSize,
    minSizeFactor: primaryBs.minSizeFactor,
    color: '#ffffff',
    secondaryColor: '#ffffff',
    opacity: 1.0,
    flow: cfg.density ?? 1.0,
    brushDensity: cfg.density ?? 1.0,
    adjustDensityByGap: false,
    blendTipsMode: 'normal',
    spacing: Math.max(0.003, Math.min(2.0, cfg.spacing ?? primaryBs.spacing ?? 0.1)),
    usePressure: primaryBs.usePressure,
    useTilt: false,
    useVelocity: primaryBs.useVelocity,
    smoothing: primaryBs.smoothing,
    stabilization: 0,
    postCorrection: 0,
    sharpCorners: primaryBs.sharpCorners,
    hardness: cfg.hardness ?? primaryBs.hardness ?? 1.0,
    thickness: cfg.thickness ?? 1.0,
    thicknessVertical: cfg.thicknessVertical ?? false,
    flipH: cfg.flipH ?? 'none',
    flipV: cfg.flipV ?? 'none',
    antiAlias: primaryBs.antiAlias,
    pressureCurve: primaryBs.pressureCurve,
    velocityCurve: primaryBs.velocityCurve,
    angleSensor: cfg.angleSensor,
    customTipDataUrl: secondaryTipDataUrl,
    customTipImage: secondaryTipImage,
    customTipAngle: cfg.angle ?? 0,
    customTipAngleDynamics: cfg.angleDynamics ?? 'none',
    isColorTip: false,
    isDualToneTip: false,
    subTips: cfg.subTips,
    subTipOrder: cfg.subTipOrder ?? 'sequential',
    subTipImages: cfg.subTipImages,
    spray: cfg.spray?.enabled ? cfg.spray : undefined,
    taper: undefined,
    isRibbon: Boolean(cfg.isRibbon),
    colorMixing: false,
    wetEdge: 0,
    grain: 0,
    textureDensity: 0,
    dualBrush: false,
    dualBrushConfig: undefined,
    useGpu: primaryBs.useGpu,
    isTransparentInk: false,
    dynamics:
      scatter > 0.001
        ? {
            ...DEFAULT_BRUSH_DYNAMICS,
            scatter,
            scatterBothAxes: true,
          }
        : undefined,
    renderMode: 'stamp',
  };

  return { settings, sizeRatio };
}

/**
 * Rescales stroke points' baked widths from primary brush size to secondary brush size.
 */
export function scalePointsForSecondaryBrush(
  points: Point[],
  sizeRatio: number,
  secSize: number
): Point[] {
  if (Math.abs(sizeRatio - 1.0) < 1e-4) {
    return points;
  }
  const out = new Array<Point>(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    out[i] = {
      ...p,
      width: p.width > 0 ? Math.max(0.2, p.width * sizeRatio) : secSize,
    };
  }
  return out;
}

export function scalePointForSecondaryBrush(
  point: Point,
  sizeRatio: number,
  secSize: number
): Point {
  if (Math.abs(sizeRatio - 1.0) < 1e-4) {
    return point;
  }
  return {
    ...point,
    width: point.width > 0 ? Math.max(0.2, point.width * sizeRatio) : secSize,
  };
}

export function scaleSegmentForSecondaryBrush(
  seg: CubicBezierSegment,
  sizeRatio: number,
  secSize: number
): CubicBezierSegment {
  if (Math.abs(sizeRatio - 1.0) < 1e-4) {
    return seg;
  }
  return {
    p0: scalePointForSecondaryBrush(seg.p0, sizeRatio, secSize),
    c1: scalePointForSecondaryBrush(seg.c1, sizeRatio, secSize),
    c2: scalePointForSecondaryBrush(seg.c2, sizeRatio, secSize),
    p3: scalePointForSecondaryBrush(seg.p3, sizeRatio, secSize),
  };
}
