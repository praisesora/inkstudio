/**
 * RibbonBrushEngine.ts
 * Clip Studio Paint Ribbon Brush Engine (`BrushRibbon = 1`).
 *
 * Continuously deforms single or multi-subTip brush textures along a stroke's
 * centripetal Catmull-Rom centerline with:
 * - Dynamic width w(s) (pressure, sizeSensor, taper), alpha a(s), and pressure p(s)
 * - Aspect-preserving arc-length UV integration scaled by local width & thickness
 * - Base angle orientation relative to stroke direction (cardinal & arbitrary angles)
 * - Miter clamping, bevel corner subdivision, and anti-bowtie winding guard
 * - Repeat modes: `repeat`, `reverse` (ping-pong), `once` (stretch 0..1 across stroke)
 * - Multi-subTip selection per tile (`sequential`, `reverse`, `random`, `random-no-repeat`, `once`, `direction`)
 * - Per-tile `flipH` / `flipV`, `isColorTip`, monochrome tint, and `isDualToneTip`
 * - World-space `paperTexture` modulation and 4-stage `antiAlias` (0..3)
 * - Dual backend: WebGL textured triangle mesh shader + exact CPU scanline barycentric fallback
 */

import {
  BrushSettings,
  CanvasColorMode,
  CspPaperTextureMode,
  CspSensorConfig,
  CspSubTip,
  CspSubTipOrder,
  CspTaperSettings,
  CspTipFlipMode,
  Point,
  SurfaceTextureId,
  ToolType,
} from '../types/editor';
import { enforceColorMode } from '../utils/colorUtils';
import { parseColorToRgb } from '../utils/colorMixingEngine';
import {
  getSurfaceTextureHeightField,
  SURFACE_TEXTURE_SIZE,
} from '../utils/proceduralBrushTips';
import { performanceManager } from '../utils/performanceManager';
import {
  applyCspPaperTextureAlpha,
  applyCspPostCorrection,
  buildCubicArcLengthTable,
  centripetalCatmullRomToBezier,
  computeCspTiltMagnitude,
  dabHashFloat,
  evaluateCspSensor,
  evaluateCspTaperFactors,
  evaluateFastSpline,
  getCubicPointAtArcLength,
  getCustomPaperLuminance,
  GRAIN_SIZE,
  paperGrainTable,
  resolveBrushPresetSettings,
  resolveTipFlipSigns,
} from './BrushEngine';
import { isNaturalPaintBrush } from './NaturalPaintRenderer';
import {
  RIBBON_VERTEX_STRIDE,
  TexturedRibbonMeshInput,
  WebGlBrushEngine,
} from './WebGlBrushEngine';
import type { CubicBezierSegment } from './SplineGenerator';

export { RIBBON_VERTEX_STRIDE };

export type RibbonRepeatMode = 'repeat' | 'reverse' | 'once';

export interface RibbonBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RibbonCenterlineSample {
  x: number;
  y: number;
  s: number;
  sNorm: number;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  width: number;
  ribbonWidth: number;
  tilePeriod: number;
  alpha: number;
  pressure: number;
}

export interface RibbonMesh extends TexturedRibbonMeshInput {
  /** Number of triangles (`vertexCount / 3`). */
  triangleCount: number;
  /** Sampled centerline nodes along the stroke. */
  centerline: RibbonCenterlineSample[];
  /** Total stroke arc length in pixels. */
  totalLength: number;
}

export interface RibbonTipSurface {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  isColor?: boolean;
  isDualToneTip?: boolean;
}

export interface RibbonRenderOptions {
  size?: number;
  minSizeFactor?: number;
  opacity?: number;
  flow?: number;
  brushDensity?: number;
  hardness?: number;
  thickness?: number;
  thicknessVertical?: boolean;
  thicknessSensor?: CspSensorConfig;
  angle?: number;
  flipH?: CspTipFlipMode;
  flipV?: CspTipFlipMode;
  antiAlias?: number;
  usePressure?: boolean;
  pressureCurve?: [number, number][];
  useTilt?: boolean;
  tiltScale?: number;
  sizeSensor?: CspSensorConfig;
  opacitySensor?: CspSensorConfig;
  densitySensor?: CspSensorConfig;
  grainPenetrationSensor?: CspSensorConfig;
  taper?: CspTaperSettings;
  tipImage?: HTMLImageElement;
  subTips?: CspSubTip[];
  subTipOrder?: CspSubTipOrder;
  subTipImages?: HTMLImageElement[];
  /** Optional pre-extracted RGBA tip surfaces (useful for CPU rendering and headless tests). */
  tipSurfaces?: RibbonTipSurface[];
  ribbonRepeatMode?: RibbonRepeatMode;
  isColorTip?: boolean;
  isDualToneTip?: boolean;
  primaryColor?: string;
  secondaryColor?: string;
  grain?: number;
  textureDensity?: number;
  surfaceTextureId?: SurfaceTextureId;
  paperTextureImage?: HTMLImageElement;
  paperTextureMode?: CspPaperTextureMode;
  paperTextureScale?: number;
  paperTextureRotate?: number;
  paperTextureBrightness?: number;
  paperTextureContrast?: number;
  paperTextureInverted?: boolean;
  paperTextureApplyEachPlot?: boolean;
  paperTextureEmphasizeDensity?: boolean;
  useGpu?: boolean;
  isEraser?: boolean;
  isBgEraser?: boolean;
  alphaLocked?: boolean;
  isTransparentInk?: boolean;
  totalLength?: number;
  exitSpeed?: number;
  strokeSeed?: number;
}

interface InternalSlice {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  cx: number;
  cy: number;
  s: number;
  sNorm: number;
  alpha: number;
  pressure: number;
  ribbonWidth: number;
  tx: number;
  ty: number;
}

interface TipMetric {
  naturalW: number;
  naturalH: number;
  rawW: number;
  rawH: number;
  maxRaw: number;
  projAlongNorm: number;
  projAcrossNorm: number;
  cosA: number;
  sinA: number;
  hasAngle: boolean;
}

// ============================================================================
// 1. Predicate, Repeat Mode, and Sub-Tip Selection Helpers
// ============================================================================

/**
 * Returns true when a BrushSettings or render options object should route through
 * the Clip Studio Paint Ribbon brush engine (not Natural Paint and not Spray).
 */
export function isRibbonBrush(
  bs: Partial<BrushSettings> | { isRibbon?: boolean; spray?: { enabled?: boolean }; renderMode?: string; naturalPaint?: { enabled?: boolean }; impasto?: { enabled?: boolean } } | undefined
): boolean {
  if (!bs || !bs.isRibbon) return false;
  if (bs.spray?.enabled) return false;
  if (isNaturalPaintBrush(bs as Partial<BrushSettings>)) return false;
  return true;
}

export function resolveRibbonRepeatMode(
  subTipOrder?: CspSubTipOrder,
  explicitMode?: RibbonRepeatMode
): RibbonRepeatMode {
  if (explicitMode === 'repeat' || explicitMode === 'reverse' || explicitMode === 'once') {
    return explicitMode;
  }
  if (subTipOrder === 'once') return 'once';
  if (subTipOrder === 'reverse') return 'reverse';
  return 'repeat';
}

export function selectRibbonSubTipIndex(
  count: number,
  order: CspSubTipOrder = 'sequential',
  tileIndex: number = 0,
  tangentAngle: number = 0,
  seedX: number = 0,
  seedY: number = 0
): number {
  if (count <= 1) return 0;
  const safeTile = Math.max(0, Math.floor(tileIndex));
  if (order === 'random') {
    return Math.floor(dabHashFloat(seedX, seedY, safeTile, 97) * count) % count;
  }
  if (order === 'random-no-repeat') {
    let idx = Math.floor(dabHashFloat(seedX, seedY, 0, 97) * count) % count;
    if (count === 2) {
      return (idx + safeTile) & 1;
    }
    const span = count - 1;
    for (let t = 1; t <= safeTile; t++) {
      const step = 1 + (Math.floor(dabHashFloat(seedX, seedY, t, 97) * span) % span);
      idx = (idx + step) % count;
    }
    return idx;
  }
  if (order === 'once') {
    return Math.min(safeTile, count - 1);
  }
  if (order === 'reverse') {
    return (count - 1 - (safeTile % count) + count) % count;
  }
  if (order === 'direction') {
    const normAngle = ((tangentAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return Math.floor((normAngle / (Math.PI * 2)) * count) % count;
  }
  return safeTile % count;
}

// ============================================================================
// 2. Tip Pixel Extraction & Procedural Fallback Tip Cache
// ============================================================================

const tipSurfaceCache = new WeakMap<object, RibbonTipSurface>();
const proceduralRibbonTipCache = new Map<string, RibbonTipSurface>();

function getProceduralRibbonTip(hardness: number = 1.0): RibbonTipSurface {
  const qH = Math.round(Math.max(0, Math.min(1, hardness)) * 20) / 20;
  const key = `proc_${qH}`;
  const cached = proceduralRibbonTipCache.get(key);
  if (cached) return cached;

  const size = 64;
  const data = new Uint8ClampedArray(size * size * 4);
  const cy = (size - 1) * 0.5;
  const maxDist = size * 0.5;
  const inner = maxDist * Math.min(0.95, qH);

  for (let y = 0; y < size; y++) {
    const dy = Math.abs(y - cy);
    let a = 0;
    if (dy <= inner) {
      a = 1;
    } else if (dy < maxDist) {
      const t = (dy - inner) / Math.max(1e-4, maxDist - inner);
      a = qH <= 0.05 ? 0.5 * (1 + Math.cos(t * Math.PI)) : 1 - (3 * t * t - 2 * t * t * t);
    }
    const aByte = Math.max(0, Math.min(255, Math.round(a * 255)));
    for (let x = 0; x < size; x++) {
      const p = (y * size + x) * 4;
      data[p] = 255;
      data[p + 1] = 255;
      data[p + 2] = 255;
      data[p + 3] = aByte;
    }
  }

  const surf: RibbonTipSurface = { data, width: size, height: size, isColor: false, isDualToneTip: false };
  proceduralRibbonTipCache.set(key, surf);
  return surf;
}

export function extractTipSurface(
  image: HTMLImageElement | HTMLCanvasElement | undefined,
  meta?: { isColor?: boolean; isDualToneTip?: boolean }
): RibbonTipSurface | null {
  if (!image) return null;

  // Support synthetic test image objects carrying direct RGBA buffers
  const anyImg = image as unknown as {
    __rgbaData?: Uint8ClampedArray;
    data?: Uint8ClampedArray;
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number;
    height?: number;
    complete?: boolean;
  };
  const directBuf = anyImg.__rgbaData || (anyImg.data instanceof Uint8ClampedArray ? anyImg.data : undefined);
  if (directBuf) {
    const w = anyImg.naturalWidth || anyImg.width || 0;
    const h = anyImg.naturalHeight || anyImg.height || 0;
    if (w > 0 && h > 0 && directBuf.length >= w * h * 4) {
      return {
        data: directBuf,
        width: w,
        height: h,
        isColor: meta?.isColor,
        isDualToneTip: meta?.isDualToneTip,
      };
    }
  }

  const cached = tipSurfaceCache.get(image);
  if (cached) {
    if (meta?.isColor !== undefined || meta?.isDualToneTip !== undefined) {
      return {
        ...cached,
        isColor: meta.isColor ?? cached.isColor,
        isDualToneTip: meta.isDualToneTip ?? cached.isDualToneTip,
      };
    }
    return cached;
  }

  if (typeof document === 'undefined') return null;
  if ('complete' in image && image.complete === false) return null;
  const w = ('naturalWidth' in image ? image.naturalWidth : 0) || image.width || 0;
  const h = ('naturalHeight' in image ? image.naturalHeight : 0) || image.height || 0;
  if (w <= 0 || h <= 0) return null;

  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx || typeof ctx.getImageData !== 'function') return null;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(image, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const surf: RibbonTipSurface = {
      data: imgData.data,
      width: w,
      height: h,
      isColor: meta?.isColor,
      isDualToneTip: meta?.isDualToneTip,
    };
    tipSurfaceCache.set(image, surf);
    return surf;
  } catch {
    return null;
  }
}

export function resolveRibbonTipSurfaces(options: RibbonRenderOptions): RibbonTipSurface[] {
  if (options.tipSurfaces && options.tipSurfaces.length > 0) {
    return options.tipSurfaces;
  }

  const surfaces: RibbonTipSurface[] = [];
  if (options.subTipImages && options.subTipImages.length > 0) {
    for (let i = 0; i < options.subTipImages.length; i++) {
      const meta = options.subTips?.[i];
      const s = extractTipSurface(options.subTipImages[i], {
        isColor: meta?.isColor ?? options.isColorTip,
        isDualToneTip: meta?.isDualToneTip ?? options.isDualToneTip,
      });
      if (s) surfaces.push(s);
    }
  }

  if (surfaces.length === 0 && options.tipImage) {
    const s = extractTipSurface(options.tipImage, {
      isColor: options.isColorTip ?? options.subTips?.[0]?.isColor,
      isDualToneTip: options.isDualToneTip ?? options.subTips?.[0]?.isDualToneTip,
    });
    if (s) surfaces.push(s);
  }

  if (surfaces.length === 0) {
    surfaces.push(getProceduralRibbonTip(options.hardness ?? 1.0));
  }

  return surfaces;
}

function buildTipMetrics(options: RibbonRenderOptions): TipMetric[] {
  const thickness = Math.max(0.05, Math.min(20.0, options.thickness ?? 1.0));
  const thicknessVertical = Boolean(options.thicknessVertical);
  // Clip Studio Paint Ribbon orientation convention (`BrushRibbon = 1`):
  // At BrushRotation = 0°, the tip image's vertical axis (+Y, top-to-bottom) flows ALONG the
  // stroke and its horizontal axis (+X, left-to-right) spans ACROSS the stroke width.
  // Rotating by +90° (e.g. CSP's built-in Chain.sut with a 300x27 horizontal strip and
  // BrushRotation = 90°) aligns +X along the stroke and +Y across the stroke width.
  const normDeg = ((((options.angle ?? 0) - 90) % 360) + 360) % 360;
  const hasAngle = normDeg > 1e-4 && Math.abs(normDeg - 360) > 1e-4;
  const angleRad = (normDeg * Math.PI) / 180;
  let cosA = hasAngle ? Math.cos(angleRad) : 1.0;
  let sinA = hasAngle ? Math.sin(angleRad) : 0.0;
  if (Math.abs(cosA) < 1e-12) cosA = 0.0;
  if (Math.abs(sinA) < 1e-12) sinA = 0.0;

  const makeMetric = (w: number, h: number): TipMetric => {
    const safeW = w > 0 ? w : 64;
    const safeH = h > 0 ? h : 64;
    const rawW = thicknessVertical ? safeW * thickness : safeW;
    const rawH = thicknessVertical ? safeH : safeH * thickness;
    const maxRaw = Math.max(rawW, rawH, 1e-4);
    // In CSP Ribbon mode, BrushSize defines the across-stroke ribbon width (at thickness = 100%),
    // and the along-stroke tile period scales uniformly to preserve the tip's natural aspect ratio.
    const baseProjAcross = Math.max(1e-4, safeW * Math.abs(sinA) + safeH * Math.abs(cosA));
    const projAlongRaw = rawW * Math.abs(cosA) + rawH * Math.abs(sinA);
    const projAcrossRaw = rawW * Math.abs(sinA) + rawH * Math.abs(cosA);
    const projAlongNorm = projAlongRaw / baseProjAcross;
    const projAcrossNorm = projAcrossRaw / baseProjAcross;
    return {
      naturalW: safeW,
      naturalH: safeH,
      rawW,
      rawH,
      maxRaw,
      projAlongNorm: Math.max(0.05, Math.min(64.0, projAlongNorm)),
      projAcrossNorm: Math.max(0.05, Math.min(20.0, projAcrossNorm)),
      cosA,
      sinA,
      hasAngle,
    };
  };

  if (options.tipSurfaces && options.tipSurfaces.length > 0) {
    return options.tipSurfaces.map((s) => makeMetric(s.width, s.height));
  }
  if (options.subTipImages && options.subTipImages.length > 0) {
    return options.subTipImages.map((img, i) => {
      const w = img.naturalWidth || img.width || options.subTips?.[i]?.width || 64;
      const h = img.naturalHeight || img.height || options.subTips?.[i]?.height || 64;
      return makeMetric(w, h);
    });
  }
  if (options.tipImage) {
    const w = options.tipImage.naturalWidth || options.tipImage.width || options.subTips?.[0]?.width || 64;
    const h = options.tipImage.naturalHeight || options.tipImage.height || options.subTips?.[0]?.height || 64;
    return [makeMetric(w, h)];
  }
  if (options.subTips && options.subTips.length > 0) {
    return options.subTips.map((st) => makeMetric(st.width || 64, st.height || 64));
  }
  return [makeMetric(64, 64)];
}

// ============================================================================
// 3. Centerline Sampling (Centripetal Catmull-Rom + CSP Dynamics & Taper)
// ============================================================================

function evaluateSampleDynamics(
  x: number,
  y: number,
  rawWidth: number,
  rawPressure: number,
  speedPx: number,
  tiltX: number,
  tiltY: number,
  strokeDist: number,
  totalLength: number | undefined,
  sampleIndex: number,
  options: RibbonRenderOptions
): { width: number; thicknessScale: number; alpha: number; pressure: number } {
  const effPressure = Math.max(0, Math.min(1, rawPressure));
  const curvedPressure = options.pressureCurve
    ? evaluateFastSpline(effPressure, options.pressureCurve)
    : effPressure;
  const minFactor = Math.max(0, Math.min(1.0, options.minSizeFactor ?? 0));

  let curWidth =
    rawWidth > 0
      ? rawWidth
      : options.usePressure !== false
      ? (options.size ?? 10) * (minFactor + (1.0 - minFactor) * curvedPressure)
      : options.size ?? 10;

  const taperFactors = evaluateCspTaperFactors(
    options.taper,
    strokeDist,
    totalLength,
    options.exitSpeed
  );
  curWidth *= taperFactors.sizeScale;

  const readTilt = Boolean(
    options.useTilt ||
      options.sizeSensor?.useTilt ||
      options.thicknessSensor?.useTilt ||
      options.opacitySensor?.useTilt ||
      options.densitySensor?.useTilt
  );
  const tX = readTilt ? tiltX : 0;
  const tY = readTilt ? tiltY : 0;
  const tiltMagnitude = computeCspTiltMagnitude(tX, tY);

  if (options.sizeSensor) {
    const effectiveSizeSensor =
      rawWidth > 0 && options.usePressure !== false && options.sizeSensor.usePressure
        ? { ...options.sizeSensor, usePressure: false }
        : options.sizeSensor;
    curWidth *= evaluateCspSensor(
      effectiveSizeSensor,
      effPressure,
      tiltMagnitude,
      speedPx * 0.05,
      dabHashFloat(x, y, sampleIndex, 50),
      0,
      strokeDist
    );
  }
  curWidth = Math.max(0.2, curWidth);

  let thicknessScale = 1.0;
  if (options.thicknessSensor) {
    thicknessScale = Math.max(
      0.1,
      Math.min(
        10.0,
        evaluateCspSensor(
          options.thicknessSensor,
          effPressure,
          tiltMagnitude,
          speedPx * 0.05,
          dabHashFloat(x, y, sampleIndex, 54),
          0,
          strokeDist
        )
      )
    );
  }

  const baseFlow = Math.max(0, Math.min(1, options.brushDensity ?? options.flow ?? 1.0));
  let curAlpha = baseFlow * taperFactors.alphaScale;

  if (options.opacitySensor) {
    curAlpha *= evaluateCspSensor(
      options.opacitySensor,
      effPressure,
      tiltMagnitude,
      speedPx * 0.05,
      dabHashFloat(x, y, sampleIndex, 51),
      0,
      strokeDist
    );
  }
  if (options.densitySensor) {
    curAlpha *= evaluateCspSensor(
      options.densitySensor,
      effPressure,
      tiltMagnitude,
      speedPx * 0.05,
      dabHashFloat(x, y, sampleIndex, 52),
      0,
      strokeDist
    );
  }

  return {
    width: curWidth,
    thicknessScale,
    alpha: Math.max(0, Math.min(1, curAlpha)),
    pressure: effPressure,
  };
}

function sampleCubicSegmentIntoCenterline(
  out: RibbonCenterlineSample[],
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  options: RibbonRenderOptions,
  metrics: TipMetric[],
  state: { s: number; sNorm: number; sampleIdx: number; seedX: number; seedY: number; totalLength?: number }
): void {
  const table = buildCubicArcLengthTable(p0, c1, c2, p3);
  const segLen = table.totalLength;
  if (segLen < 1e-3) return;

  const avgWidth = Math.max(2, (p0.width + p3.width) * 0.5 || (options.size ?? 12));
  const baseStep = Math.max(0.85, Math.min(3.5, avgWidth * 0.16));
  const numSteps = Math.max(2, Math.min(160, Math.ceil(segLen / baseStep)));

  const startI = out.length === 0 ? 0 : 1;
  const subTipOrder = options.subTipOrder ?? 'sequential';
  const metricCount = metrics.length;

  for (let i = startI; i <= numSteps; i++) {
    const distOnSeg = (segLen * i) / numSteps;
    const pt = getCubicPointAtArcLength(p0, c1, c2, p3, distOnSeg, table);

    if (out.length > 0) {
      const prev = out[out.length - 1];
      const stepDx = pt.x - prev.x;
      const stepDy = pt.y - prev.y;
      const ds = Math.hypot(stepDx, stepDy);
      if (ds < 0.12 && i < numSteps) continue;

      let tx = pt.speed > 1e-4 ? pt.dx / pt.speed : ds > 1e-4 ? stepDx / ds : prev.tx;
      let ty = pt.speed > 1e-4 ? pt.dy / pt.speed : ds > 1e-4 ? stepDy / ds : prev.ty;
      const tLen = Math.hypot(tx, ty);
      if (tLen > 1e-5) {
        tx /= tLen;
        ty /= tLen;
      } else {
        tx = prev.tx;
        ty = prev.ty;
      }

      const nextS = state.s + ds;
      const dyn = evaluateSampleDynamics(
        pt.x,
        pt.y,
        pt.width,
        pt.pressure,
        pt.speed,
        pt.tiltX,
        pt.tiltY,
        nextS,
        state.totalLength,
        state.sampleIdx++,
        options
      );

      // Integrate sNorm with active tile's aspect-preserving tilePeriod
      const activeTileIdx = Math.floor(state.sNorm);
      const tipIdx = selectRibbonSubTipIndex(
        metricCount,
        subTipOrder,
        activeTileIdx,
        Math.atan2(ty, tx),
        state.seedX,
        state.seedY
      );
      const metric = metrics[tipIdx] ?? metrics[0];
      const ribbonWidth = Math.max(0.25, dyn.width * metric.projAcrossNorm * dyn.thicknessScale);
      const tilePeriod = Math.max(0.5, dyn.width * metric.projAlongNorm);
      const avgPeriod = Math.max(0.5, 0.5 * (prev.tilePeriod + tilePeriod));
      const nextSNorm = state.sNorm + ds / avgPeriod;

      state.s = nextS;
      state.sNorm = nextSNorm;

      out.push({
        x: pt.x,
        y: pt.y,
        s: nextS,
        sNorm: nextSNorm,
        tx,
        ty,
        nx: -ty,
        ny: tx,
        width: dyn.width,
        ribbonWidth,
        tilePeriod,
        alpha: dyn.alpha,
        pressure: dyn.pressure,
      });
    } else {
      let tx = pt.speed > 1e-4 ? pt.dx / pt.speed : 1;
      let ty = pt.speed > 1e-4 ? pt.dy / pt.speed : 0;
      if (pt.speed <= 1e-4) {
        const chDx = p3.x - p0.x;
        const chDy = p3.y - p0.y;
        const chL = Math.hypot(chDx, chDy);
        if (chL > 1e-4) {
          tx = chDx / chL;
          ty = chDy / chL;
        }
      }
      const dyn = evaluateSampleDynamics(
        pt.x,
        pt.y,
        pt.width,
        pt.pressure,
        pt.speed,
        pt.tiltX,
        pt.tiltY,
        state.s,
        state.totalLength,
        state.sampleIdx++,
        options
      );
      const tipIdx = selectRibbonSubTipIndex(
        metricCount,
        subTipOrder,
        Math.floor(state.sNorm),
        Math.atan2(ty, tx),
        state.seedX,
        state.seedY
      );
      const metric = metrics[tipIdx] ?? metrics[0];
      const ribbonWidth = Math.max(0.25, dyn.width * metric.projAcrossNorm * dyn.thicknessScale);
      const tilePeriod = Math.max(0.5, dyn.width * metric.projAlongNorm);
      out.push({
        x: pt.x,
        y: pt.y,
        s: state.s,
        sNorm: state.sNorm,
        tx,
        ty,
        nx: -ty,
        ny: tx,
        width: dyn.width,
        ribbonWidth,
        tilePeriod,
        alpha: dyn.alpha,
        pressure: dyn.pressure,
      });
    }
  }
}

export function sampleRibbonCenterlineFromPoints(
  points: Point[],
  options: RibbonRenderOptions
): RibbonCenterlineSample[] {
  if (!points || points.length === 0) return [];
  const metrics = buildTipMetrics(options);
  const seedX = points[0].x;
  const seedY = points[0].y;

  // Estimate total length for taper evaluation
  let approxTotalLen = options.totalLength;
  if (approxTotalLen === undefined) {
    let sum = 0;
    for (let i = 1; i < points.length; i++) {
      sum += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    approxTotalLen = sum;
  }

  // Single-point tap or degenerate zero-length stroke: synthesize a 1-tile horizontal ribbon stamp
  if (points.length === 1 || approxTotalLen < 0.25) {
    const p = points[0];
    const dyn = evaluateSampleDynamics(
      p.x,
      p.y,
      p.width,
      p.pressure,
      0,
      p.tiltX ?? 0,
      p.tiltY ?? 0,
      0,
      undefined,
      0,
      options
    );
    const m = metrics[0];
    const ribbonWidth = Math.max(0.5, dyn.width * m.projAcrossNorm * dyn.thicknessScale);
    const tilePeriod = Math.max(0.5, dyn.width * m.projAlongNorm);
    const tapLen = Math.min(tilePeriod, Math.max(ribbonWidth, dyn.width));
    const halfLen = tapLen * 0.5;
    const tapSNorm = tapLen / tilePeriod;
    return [
      {
        x: p.x - halfLen,
        y: p.y,
        s: 0,
        sNorm: 0,
        tx: 1,
        ty: 0,
        nx: 0,
        ny: 1,
        width: dyn.width,
        ribbonWidth,
        tilePeriod,
        alpha: dyn.alpha,
        pressure: dyn.pressure,
      },
      {
        x: p.x + halfLen,
        y: p.y,
        s: tapLen,
        sNorm: tapSNorm,
        tx: 1,
        ty: 0,
        nx: 0,
        ny: 1,
        width: dyn.width,
        ribbonWidth,
        tilePeriod,
        alpha: dyn.alpha,
        pressure: dyn.pressure,
      },
    ];
  }

  const centerline: RibbonCenterlineSample[] = [];
  const state = {
    s: 0,
    sNorm: 0,
    sampleIdx: 0,
    seedX,
    seedY,
    totalLength: approxTotalLen,
  };

  if (points.length === 2) {
    const { c1, c2 } = centripetalCatmullRomToBezier(points[0], points[0], points[1], points[1]);
    sampleCubicSegmentIntoCenterline(centerline, points[0], c1, c2, points[1], options, metrics, state);
  } else {
    const first = centripetalCatmullRomToBezier(points[0], points[0], points[1], points[2]);
    sampleCubicSegmentIntoCenterline(centerline, points[0], first.c1, first.c2, points[1], options, metrics, state);

    for (let i = 2; i < points.length - 1; i++) {
      const seg = centripetalCatmullRomToBezier(
        points[i - 2],
        points[i - 1],
        points[i],
        points[i + 1]
      );
      sampleCubicSegmentIntoCenterline(centerline, points[i - 1], seg.c1, seg.c2, points[i], options, metrics, state);
    }

    const n = points.length;
    const last = centripetalCatmullRomToBezier(points[n - 3], points[n - 2], points[n - 1], points[n - 1]);
    sampleCubicSegmentIntoCenterline(centerline, points[n - 2], last.c1, last.c2, points[n - 1], options, metrics, state);
  }

  return centerline;
}

// ============================================================================
// 4. Deformable Ribbon Mesh Builder (Miter Clamping, Bevel Corners, Anti-Bowtie)
// ============================================================================

function cross2(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function mapTileUvToTexUv(
  u: number,
  v: number,
  metric: TipMetric,
  flipX: number,
  flipY: number
): { uTex: number; vTex: number } {
  let uTex: number;
  let vTex: number;

  if (!metric.hasAngle) {
    uTex = u;
    vTex = v;
  } else {
    const projAlong = metric.rawW * Math.abs(metric.cosA) + metric.rawH * Math.abs(metric.sinA);
    const projAcross = metric.rawW * Math.abs(metric.sinA) + metric.rawH * Math.abs(metric.cosA);
    const pAlong = (u - 0.5) * projAlong;
    const pAcross = (v - 0.5) * projAcross;
    const lx = pAlong * metric.cosA + pAcross * metric.sinA;
    const ly = -pAlong * metric.sinA + pAcross * metric.cosA;
    uTex = lx / metric.rawW + 0.5;
    vTex = ly / metric.rawH + 0.5;
  }

  if (flipX < 0) uTex = 1.0 - uTex;
  if (flipY < 0) vTex = 1.0 - vTex;
  return { uTex, vTex };
}

function buildSlicesFromCenterline(
  centerline: RibbonCenterlineSample[],
  options: RibbonRenderOptions,
  prevEdgeState?: { lx: number; ly: number; rx: number; ry: number; tx: number; ty: number; s: number; sNorm: number; alpha: number; pressure: number; ribbonWidth: number; cx: number; cy: number }
): InternalSlice[] {
  if (centerline.length < 2) return [];

  // Deduplicate ultra-close points so segment tangents are always well-conditioned
  const pts: RibbonCenterlineSample[] = [centerline[0]];
  for (let i = 1; i < centerline.length; i++) {
    const prev = pts[pts.length - 1];
    const cur = centerline[i];
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) >= 0.1 || i === centerline.length - 1) {
      if (Math.hypot(cur.x - prev.x, cur.y - prev.y) >= 1e-4) {
        pts.push(cur);
      }
    }
  }
  if (pts.length < 2) return [];

  const m = pts.length;
  const segTx = new Float64Array(m - 1);
  const segTy = new Float64Array(m - 1);
  const segNx = new Float64Array(m - 1);
  const segNy = new Float64Array(m - 1);

  for (let i = 0; i < m - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const len = Math.hypot(dx, dy) || 1;
    const tx = dx / len;
    const ty = dy / len;
    segTx[i] = tx;
    segTy[i] = ty;
    segNx[i] = -ty;
    segNy[i] = tx;
  }

  const slices: InternalSlice[] = [];
  const BEVEL_ANGLE_THRESHOLD = 0.22; // ~12.6 degrees
  const MAX_MITER_SCALE = 1.45;
  let extraSNorm = 0;

  // Start slice
  if (prevEdgeState) {
    // Seamless stitching from previous live segment with corner bevel if direction turned
    const t0x = prevEdgeState.tx;
    const t0y = prevEdgeState.ty;
    const t1x = segTx[0];
    const t1y = segTy[0];
    const dot = Math.max(-1, Math.min(1, t0x * t1x + t0y * t1y));
    const cr = cross2(t0x, t0y, t1x, t1y);
    const theta = Math.atan2(cr, dot);
    slices.push({
      lx: prevEdgeState.lx,
      ly: prevEdgeState.ly,
      rx: prevEdgeState.rx,
      ry: prevEdgeState.ry,
      cx: prevEdgeState.cx,
      cy: prevEdgeState.cy,
      s: prevEdgeState.s,
      sNorm: prevEdgeState.sNorm,
      alpha: prevEdgeState.alpha,
      pressure: prevEdgeState.pressure,
      ribbonWidth: prevEdgeState.ribbonWidth,
      tx: t0x,
      ty: t0y,
    });
    if (Math.abs(theta) >= BEVEL_ANGLE_THRESHOLD) {
      const h = pts[0].ribbonWidth * 0.5;
      const steps = Math.max(2, Math.min(8, Math.ceil(Math.abs(theta) / BEVEL_ANGLE_THRESHOLD)));
      const n0Angle = Math.atan2(t0x, -t0y); // atan2(ny, nx) where nx=-ty, ny=tx
      const midAngle = n0Angle + theta * 0.5;
      const mx = Math.cos(midAngle);
      const my = Math.sin(midAngle);
      const innerSign = cr >= 0 ? 1 : -1;
      const innerRad = h * Math.max(0, Math.cos(Math.min(Math.PI * 0.5, Math.abs(theta) * 0.5)));
      const innerX = pts[0].x + innerSign * mx * innerRad;
      const innerY = pts[0].y + innerSign * my * innerRad;
      const cornerDu = (0.5 * Math.abs(theta) * h) / Math.max(0.5, pts[0].tilePeriod);
      for (let k = 1; k <= steps; k++) {
        const f = k / steps;
        const a = n0Angle + theta * f;
        const nkx = Math.cos(a);
        const nky = Math.sin(a);
        const outerX = pts[0].x - innerSign * nkx * h;
        const outerY = pts[0].y - innerSign * nky * h;
        const lx = innerSign > 0 ? outerX : innerX;
        const ly = innerSign > 0 ? outerY : innerY;
        const rx = innerSign > 0 ? innerX : outerX;
        const ry = innerSign > 0 ? innerY : outerY;
        slices.push({
          lx,
          ly,
          rx,
          ry,
          cx: pts[0].x,
          cy: pts[0].y,
          s: pts[0].s,
          sNorm: pts[0].sNorm + extraSNorm + cornerDu * f,
          alpha: pts[0].alpha,
          pressure: pts[0].pressure,
          ribbonWidth: pts[0].ribbonWidth,
          tx: nky,
          ty: -nkx,
        });
      }
      extraSNorm += cornerDu;
    }
  } else {
    const p0 = pts[0];
    const h0 = p0.ribbonWidth * 0.5;
    slices.push({
      lx: p0.x - segNx[0] * h0,
      ly: p0.y - segNy[0] * h0,
      rx: p0.x + segNx[0] * h0,
      ry: p0.y + segNy[0] * h0,
      cx: p0.x,
      cy: p0.y,
      s: p0.s,
      sNorm: p0.sNorm,
      alpha: p0.alpha,
      pressure: p0.pressure,
      ribbonWidth: p0.ribbonWidth,
      tx: segTx[0],
      ty: segTy[0],
    });
  }

  // Interior centerline points
  for (let i = 1; i < m - 1; i++) {
    const p = pts[i];
    const h = p.ribbonWidth * 0.5;
    const t0x = segTx[i - 1];
    const t0y = segTy[i - 1];
    const n0x = segNx[i - 1];
    const n0y = segNy[i - 1];
    const t1x = segTx[i];
    const t1y = segTy[i];
    const n1x = segNx[i];
    const n1y = segNy[i];

    const dot = Math.max(-1, Math.min(1, t0x * t1x + t0y * t1y));
    const cr = cross2(t0x, t0y, t1x, t1y);
    const theta = Math.atan2(cr, dot);

    if (Math.abs(theta) < BEVEL_ANGLE_THRESHOLD) {
      let mx = n0x + n1x;
      let my = n0y + n1y;
      const mLen = Math.hypot(mx, my);
      if (mLen > 1e-5) {
        mx /= mLen;
        my /= mLen;
      } else {
        mx = n0x;
        my = n0y;
      }
      const cosHalf = Math.max(0.5, mx * n0x + my * n0y);
      const miterLen = Math.min(h * MAX_MITER_SCALE, h / cosHalf);
      slices.push({
        lx: p.x - mx * miterLen,
        ly: p.y - my * miterLen,
        rx: p.x + mx * miterLen,
        ry: p.y + my * miterLen,
        cx: p.x,
        cy: p.y,
        s: p.s,
        sNorm: p.sNorm + extraSNorm,
        alpha: p.alpha,
        pressure: p.pressure,
        ribbonWidth: p.ribbonWidth,
        tx: (t0x + t1x) * 0.5,
        ty: (t0y + t1y) * 0.5,
      });
    } else {
      // High-curvature corner: bevel / arc subdivision with pinned safe inner pivot
      const steps = Math.max(2, Math.min(10, Math.ceil(Math.abs(theta) / BEVEL_ANGLE_THRESHOLD)));
      const n0Angle = Math.atan2(n0y, n0x);
      const midAngle = n0Angle + theta * 0.5;
      const mx = Math.cos(midAngle);
      const my = Math.sin(midAngle);
      const innerSign = cr >= 0 ? 1 : -1; // +N (R) is inner when cross > 0; -N (L) is inner when cross < 0
      const innerRad = h * Math.max(0, Math.cos(Math.min(Math.PI * 0.5, Math.abs(theta) * 0.5)));
      const innerX = p.x + innerSign * mx * innerRad;
      const innerY = p.y + innerSign * my * innerRad;
      const cornerDu = (0.5 * Math.abs(theta) * h) / Math.max(0.5, p.tilePeriod);

      for (let k = 0; k <= steps; k++) {
        const f = k / steps;
        const a = n0Angle + theta * f;
        const nkx = Math.cos(a);
        const nky = Math.sin(a);
        const outerX = p.x - innerSign * nkx * h;
        const outerY = p.y - innerSign * nky * h;
        const lx = innerSign > 0 ? outerX : innerX;
        const ly = innerSign > 0 ? outerY : innerY;
        const rx = innerSign > 0 ? innerX : outerX;
        const ry = innerSign > 0 ? innerY : outerY;

        slices.push({
          lx,
          ly,
          rx,
          ry,
          cx: p.x,
          cy: p.y,
          s: p.s,
          sNorm: p.sNorm + extraSNorm + cornerDu * f,
          alpha: p.alpha,
          pressure: p.pressure,
          ribbonWidth: p.ribbonWidth,
          tx: nky,
          ty: -nkx,
        });
      }
      extraSNorm += cornerDu;
    }
  }

  // End slice
  const pLast = pts[m - 1];
  const hLast = pLast.ribbonWidth * 0.5;
  slices.push({
    lx: pLast.x - segNx[m - 2] * hLast,
    ly: pLast.y - segNy[m - 2] * hLast,
    rx: pLast.x + segNx[m - 2] * hLast,
    ry: pLast.y + segNy[m - 2] * hLast,
    cx: pLast.x,
    cy: pLast.y,
    s: pLast.s,
    sNorm: pLast.sNorm + extraSNorm,
    alpha: pLast.alpha,
    pressure: pLast.pressure,
    ribbonWidth: pLast.ribbonWidth,
    tx: segTx[m - 2],
    ty: segTy[m - 2],
  });

  // In 'once' mode, normalize sNorm strictly across [0, tileSpan] from start to end of stroke
  const repeatMode = resolveRibbonRepeatMode(options.subTipOrder, options.ribbonRepeatMode);
  if (repeatMode === 'once' && !prevEdgeState && slices.length >= 2) {
    const tipCount = Math.max(
      1,
      options.tipSurfaces?.length ??
        options.subTipImages?.length ??
        options.subTips?.length ??
        1
    );
    const tileSpan = options.subTipOrder === 'once' && tipCount > 1 ? tipCount : 1.0;
    const maxSNorm = Math.max(1e-5, slices[slices.length - 1].sNorm - slices[0].sNorm);
    const baseSNorm = slices[0].sNorm;
    for (let i = 0; i < slices.length; i++) {
      slices[i].sNorm = ((slices[i].sNorm - baseSNorm) / maxSNorm) * tileSpan;
    }
  }

  return slices;
}

export function buildRibbonMeshFromCenterline(
  centerline: RibbonCenterlineSample[],
  options: RibbonRenderOptions,
  prevEdgeState?: { lx: number; ly: number; rx: number; ry: number; tx: number; ty: number; s: number; sNorm: number; alpha: number; pressure: number; ribbonWidth: number; cx: number; cy: number }
): RibbonMesh {
  const emptyBounds: RibbonBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  if (centerline.length < 2) {
    return {
      vertices: new Float32Array(0),
      vertexCount: 0,
      triangleCount: 0,
      bounds: emptyBounds,
      centerline,
      totalLength: 0,
    };
  }

  const metrics = buildTipMetrics(options);
  const metricCount = metrics.length;
  const repeatMode = resolveRibbonRepeatMode(options.subTipOrder, options.ribbonRepeatMode);
  const subTipOrder = options.subTipOrder ?? 'sequential';
  const seedX = centerline[0].x;
  const seedY = centerline[0].y;

  const slices = buildSlicesFromCenterline(centerline, options, prevEdgeState);
  if (slices.length < 2) {
    return {
      vertices: new Float32Array(0),
      vertexCount: 0,
      triangleCount: 0,
      bounds: emptyBounds,
      centerline,
      totalLength: centerline[centerline.length - 1].s,
    };
  }

  // Dynamic float buffer growth
  let capacityVerts = Math.max(64, slices.length * 12);
  let verts = new Float32Array(capacityVerts * RIBBON_VERTEX_STRIDE);
  let vCount = 0;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const ensureCapacity = (extraVerts: number) => {
    if (vCount + extraVerts <= capacityVerts) return;
    capacityVerts = Math.max(vCount + extraVerts, capacityVerts * 2);
    const next = new Float32Array(capacityVerts * RIBBON_VERTEX_STRIDE);
    next.set(verts.subarray(0, vCount * RIBBON_VERTEX_STRIDE));
    verts = next;
  };

  const pushVertex = (
    x: number,
    y: number,
    u: number,
    v: number,
    alpha: number,
    pressure: number,
    tipIndex: number,
    edgeDist: number,
    ribbonWidth: number
  ) => {
    const off = vCount * RIBBON_VERTEX_STRIDE;
    verts[off + 0] = x;
    verts[off + 1] = y;
    verts[off + 2] = u;
    verts[off + 3] = v;
    verts[off + 4] = alpha;
    verts[off + 5] = pressure;
    verts[off + 6] = tipIndex;
    verts[off + 7] = edgeDist;
    verts[off + 8] = ribbonWidth;
    vCount++;

    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  const emitTileSubQuad = (
    l0x: number,
    l0y: number,
    r0x: number,
    r0y: number,
    l1x: number,
    l1y: number,
    r1x: number,
    r1y: number,
    uRaw0: number,
    uRaw1: number,
    a0: number,
    a1: number,
    p0: number,
    p1: number,
    w0: number,
    w1: number,
    tileIdx: number,
    tangentAngle: number,
    cx: number,
    cy: number
  ) => {
    const tipIdx = selectRibbonSubTipIndex(
      metricCount,
      subTipOrder,
      tileIdx,
      tangentAngle,
      seedX,
      seedY
    );
    const metric = metrics[tipIdx] ?? metrics[0];

    let u0 = uRaw0;
    let u1 = uRaw1;
    if (repeatMode === 'reverse' && (tileIdx & 1) === 1) {
      u0 = 1.0 - u0;
      u1 = 1.0 - u1;
    }

    const flips = resolveTipFlipSigns(options.flipH, options.flipV, tileIdx, cx, cy);
    const uvL0 = mapTileUvToTexUv(u0, 0.0, metric, flips.signX, flips.signY);
    const uvR0 = mapTileUvToTexUv(u0, 1.0, metric, flips.signX, flips.signY);
    const uvL1 = mapTileUvToTexUv(u1, 0.0, metric, flips.signX, flips.signY);
    const uvR1 = mapTileUvToTexUv(u1, 1.0, metric, flips.signX, flips.signY);

    // Emit up to 2 triangles with strict non-inverted winding check (cross2 < -1e-5)
    const area1 = cross2(r0x - l0x, r0y - l0y, l1x - l0x, l1y - l0y);
    const area2 = cross2(r1x - r0x, r1y - r0y, l1x - r0x, l1y - r0y);

    ensureCapacity(6);
    if (area1 < -1e-5) {
      pushVertex(l0x, l0y, uvL0.uTex, uvL0.vTex, a0, p0, tipIdx, -1.0, w0);
      pushVertex(r0x, r0y, uvR0.uTex, uvR0.vTex, a0, p0, tipIdx, 1.0, w0);
      pushVertex(l1x, l1y, uvL1.uTex, uvL1.vTex, a1, p1, tipIdx, -1.0, w1);
    }
    if (area2 < -1e-5) {
      pushVertex(r0x, r0y, uvR0.uTex, uvR0.vTex, a0, p0, tipIdx, 1.0, w0);
      pushVertex(r1x, r1y, uvR1.uTex, uvR1.vTex, a1, p1, tipIdx, 1.0, w1);
      pushVertex(l1x, l1y, uvL1.uTex, uvL1.vTex, a1, p1, tipIdx, -1.0, w1);
    }
  };

  for (let i = 0; i < slices.length - 1; i++) {
    const s0 = slices[i];
    const s1 = slices[i + 1];

    // Anti-bowtie inner-edge guard:
    // In our frame (L = C - N*h, R = C + N*h), forward motion has cross2(R0 - L0, P1 - L0) <= 0.
    // If either edge steps backwards across (L0 -> R0) on a tight bend, pin it to the previous edge!
    const qx = s0.rx - s0.lx;
    const qy = s0.ry - s0.ly;
    const lCross = cross2(qx, qy, s1.lx - s0.lx, s1.ly - s0.ly);
    const rCross = cross2(qx, qy, s1.rx - s0.lx, s1.ry - s0.ly);
    if (lCross > 1e-4 && rCross <= 1e-4) {
      s1.lx = s0.lx;
      s1.ly = s0.ly;
    } else if (rCross > 1e-4 && lCross <= 1e-4) {
      s1.rx = s0.rx;
      s1.ry = s0.ry;
    } else if (lCross > 1e-4 && rCross > 1e-4) {
      // Degenerate backward jump; skip without emitting folded geometry
      continue;
    }

    const sn0 = s0.sNorm;
    const sn1 = Math.max(sn0, s1.sNorm);
    const dSn = sn1 - sn0;
    const tangentAngle = Math.atan2(s0.ty + s1.ty, s0.tx + s1.tx);

    if (dSn < 1e-6) {
      const tileIdx = Math.max(0, Math.floor(sn0));
      const uVal = Math.max(0, Math.min(1, sn0 - tileIdx));
      emitTileSubQuad(
        s0.lx, s0.ly, s0.rx, s0.ry,
        s1.lx, s1.ly, s1.rx, s1.ry,
        uVal, uVal,
        s0.alpha, s1.alpha,
        s0.pressure, s1.pressure,
        s0.ribbonWidth, s1.ribbonWidth,
        tileIdx,
        tangentAngle,
        s0.cx, s0.cy
      );
      continue;
    }

    // Split quad cleanly at every integer tile boundary so UV never wraps backwards
    // and sub-tip index / flipH / flipV / reverse seams are razor-sharp with zero bleed!
    let curSn = sn0;
    let curF = 0.0;
    let guard = 0;

    while (curSn < sn1 - 1e-6 && guard++ < 64) {
      const tileIdx = Math.floor(curSn + 1e-7);
      const nextBoundary = tileIdx + 1;
      const segEndSn = Math.min(sn1, nextBoundary);
      const nextF = Math.min(1.0, (segEndSn - sn0) / dSn);

      const lAx = s0.lx + (s1.lx - s0.lx) * curF;
      const lAy = s0.ly + (s1.ly - s0.ly) * curF;
      const rAx = s0.rx + (s1.rx - s0.rx) * curF;
      const rAy = s0.ry + (s1.ry - s0.ry) * curF;

      const lBx = s0.lx + (s1.lx - s0.lx) * nextF;
      const lBy = s0.ly + (s1.ly - s0.ly) * nextF;
      const rBx = s0.rx + (s1.rx - s0.rx) * nextF;
      const rBy = s0.ry + (s1.ry - s0.ry) * nextF;

      const aA = s0.alpha + (s1.alpha - s0.alpha) * curF;
      const aB = s0.alpha + (s1.alpha - s0.alpha) * nextF;
      const pA = s0.pressure + (s1.pressure - s0.pressure) * curF;
      const pB = s0.pressure + (s1.pressure - s0.pressure) * nextF;
      const wA = s0.ribbonWidth + (s1.ribbonWidth - s0.ribbonWidth) * curF;
      const wB = s0.ribbonWidth + (s1.ribbonWidth - s0.ribbonWidth) * nextF;
      const cAx = s0.cx + (s1.cx - s0.cx) * curF;
      const cAy = s0.cy + (s1.cy - s0.cy) * curF;

      const uStart = Math.max(0, Math.min(1, curSn - tileIdx));
      const uEnd = Math.max(0, Math.min(1, segEndSn - tileIdx));

      emitTileSubQuad(
        lAx, lAy, rAx, rAy,
        lBx, lBy, rBx, rBy,
        uStart, uEnd,
        aA, aB,
        pA, pB,
        wA, wB,
        tileIdx,
        tangentAngle,
        cAx, cAy
      );

      curSn = segEndSn;
      curF = nextF;
    }
  }

  return {
    vertices: verts.subarray(0, vCount * RIBBON_VERTEX_STRIDE),
    vertexCount: vCount,
    triangleCount: Math.floor(vCount / 3),
    bounds:
      vCount > 0
        ? { minX, minY, maxX, maxY }
        : emptyBounds,
    centerline,
    totalLength: centerline[centerline.length - 1].s,
  };
}

export function buildRibbonMeshFromPoints(
  points: Point[],
  options: RibbonRenderOptions
): RibbonMesh {
  const centerline = sampleRibbonCenterlineFromPoints(points, options);
  return buildRibbonMeshFromCenterline(centerline, options);
}

// ============================================================================
// 5. CPU Scanline Barycentric Textured Triangle Rasterizer (WebGL-Parity Fallback)
// ============================================================================

function sampleSurfaceNearest(
  surf: RibbonTipSurface,
  u: number,
  v: number,
  out: Float64Array
): void {
  const tw = surf.width;
  const th = surf.height;
  const ix = Math.max(0, Math.min(tw - 1, Math.floor(u * tw)));
  const iy = Math.max(0, Math.min(th - 1, Math.floor(v * th)));
  const idx = (iy * tw + ix) << 2;
  const d = surf.data;
  out[0] = d[idx];
  out[1] = d[idx + 1];
  out[2] = d[idx + 2];
  out[3] = d[idx + 3] / 255;
}

function sampleSurfaceBilinear(
  surf: RibbonTipSurface,
  u: number,
  v: number,
  needRgb: boolean,
  out: Float64Array
): void {
  const tw = surf.width;
  const th = surf.height;
  const fx = u * tw - 0.5;
  const fy = v * th - 0.5;
  const x0 = Math.max(0, Math.min(tw - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(th - 1, Math.floor(fy)));
  const x1 = Math.min(tw - 1, x0 + 1);
  const y1 = Math.min(th - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - Math.floor(fx)));
  const ty = Math.max(0, Math.min(1, fy - Math.floor(fy)));

  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  const d = surf.data;
  const i00 = (y0 * tw + x0) << 2;
  const i10 = (y0 * tw + x1) << 2;
  const i01 = (y1 * tw + x0) << 2;
  const i11 = (y1 * tw + x1) << 2;

  const a00 = d[i00 + 3];
  const a10 = d[i10 + 3];
  const a01 = d[i01 + 3];
  const a11 = d[i11 + 3];

  const aSum = w00 * a00 + w10 * a10 + w01 * a01 + w11 * a11;
  out[3] = aSum / 255;

  if (needRgb) {
    if (aSum > 1e-4) {
      const invASum = 1.0 / aSum;
      out[0] = (w00 * a00 * d[i00] + w10 * a10 * d[i10] + w01 * a01 * d[i01] + w11 * a11 * d[i11]) * invASum;
      out[1] = (w00 * a00 * d[i00 + 1] + w10 * a10 * d[i10 + 1] + w01 * a01 * d[i01 + 1] + w11 * a11 * d[i11 + 1]) * invASum;
      out[2] = (w00 * a00 * d[i00 + 2] + w10 * a10 * d[i10 + 2] + w01 * a01 * d[i01 + 2] + w11 * a11 * d[i11 + 2]) * invASum;
    } else {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
    }
  }
}

function resolvePaperLookup(options: RibbonRenderOptions): {
  data: Uint8Array;
  width: number;
  height: number;
} {
  if (options.paperTextureImage) {
    const custom = getCustomPaperLuminance(options.paperTextureImage);
    if (custom) {
      return { data: custom.lum, width: custom.width, height: custom.height };
    }
  }
  if (options.surfaceTextureId) {
    const field = getSurfaceTextureHeightField(options.surfaceTextureId);
    return { data: field, width: SURFACE_TEXTURE_SIZE, height: SURFACE_TEXTURE_SIZE };
  }
  return { data: paperGrainTable, width: GRAIN_SIZE, height: GRAIN_SIZE };
}

/**
 * Deterministic CPU scanline barycentric textured triangle rasterizer.
 * Produces an RGBA pixel buffer matching the WebGL textured ribbon fragment shader.
 */
export function rasterizeRibbonMeshCpu(
  mesh: RibbonMesh,
  options: RibbonRenderOptions,
  bufWidth: number,
  bufHeight: number,
  originX: number = 0,
  originY: number = 0
): { data: Uint8ClampedArray; width: number; height: number } {
  const width = Math.max(1, Math.round(bufWidth));
  const height = Math.max(1, Math.round(bufHeight));
  const out = new Uint8ClampedArray(width * height * 4);
  if (mesh.vertexCount < 3) return { data: out, width, height };

  const tipSurfaces = resolveRibbonTipSurfaces(options);
  const isBgEraser = Boolean(options.isBgEraser);
  const isEraser = Boolean(options.isEraser) && !isBgEraser;
  const primaryHex = isBgEraser ? '#ffffff' : isEraser ? '#000000' : options.primaryColor ?? '#000000';
  const secondaryHex = options.secondaryColor ?? '#ffffff';
  const primRgb = parseColorToRgb(primaryHex);
  const secRgb = parseColorToRgb(secondaryHex);

  const globalColorTip = Boolean(options.isColorTip);
  const globalDualTone = !globalColorTip && Boolean(options.isDualToneTip);
  const aaMode = Math.max(0, Math.min(3, Math.round(options.antiAlias ?? 2)));
  const edgePx = aaMode === 1 ? 0.65 : aaMode === 3 ? 1.85 : 1.15;

  const grainAmount = Math.max(0, Math.min(1, options.grain ?? options.textureDensity ?? 0));
  const hasGrain = grainAmount > 0.005;
  const paper = hasGrain ? resolvePaperLookup(options) : null;
  const paperW = paper ? paper.width : GRAIN_SIZE;
  const paperH = paper ? paper.height : GRAIN_SIZE;
  const paperPow2 = (paperW & (paperW - 1)) === 0 && (paperH & (paperH - 1)) === 0;
  const paperMaskW = paperW - 1;
  const paperMaskH = paperH - 1;
  const invPaperScale = 1.0 / Math.max(0.05, options.paperTextureScale ?? 1.0);
  const paperRotRad = ((options.paperTextureRotate ?? 0) * Math.PI) / 180;
  const hasPaperRot = Math.abs(paperRotRad) > 1e-4;
  const cosPR = hasPaperRot ? Math.cos(paperRotRad) : 1;
  const sinPR = hasPaperRot ? Math.sin(paperRotRad) : 0;
  const paperMode: CspPaperTextureMode = options.paperTextureMode ?? 'subtract';
  const paperBrightness = options.paperTextureBrightness ?? 0;
  const paperContrast = options.paperTextureContrast ?? 0;
  const paperInverted = Boolean(options.paperTextureInverted);
  const preserveDensity =
    options.paperTextureApplyEachPlot !== undefined && !options.grainPenetrationSensor?.usePressure;
  const emphasizeDensity = Boolean(options.paperTextureEmphasizeDensity);

  const verts = mesh.vertices;
  const triCount = Math.floor(mesh.vertexCount / 3);
  const sampleScratch = new Float64Array(4);

  for (let t = 0; t < triCount; t++) {
    const base = t * 3 * RIBBON_VERTEX_STRIDE;

    let x0 = verts[base + 0];
    let y0 = verts[base + 1];
    let u0 = verts[base + 2];
    let v0t = verts[base + 3];
    let a0 = verts[base + 4];
    let p0 = verts[base + 5];
    const rawTipIdx = verts[base + 6];
    let e0 = verts[base + 7];
    let w0r = verts[base + 8];

    const b1 = base + RIBBON_VERTEX_STRIDE;
    let x1 = verts[b1 + 0];
    let y1 = verts[b1 + 1];
    let u1 = verts[b1 + 2];
    let v1t = verts[b1 + 3];
    let a1 = verts[b1 + 4];
    let p1 = verts[b1 + 5];
    let e1 = verts[b1 + 7];
    let w1r = verts[b1 + 8];

    const b2 = base + RIBBON_VERTEX_STRIDE * 2;
    let x2 = verts[b2 + 0];
    let y2 = verts[b2 + 1];
    let u2 = verts[b2 + 2];
    let v2t = verts[b2 + 3];
    let a2 = verts[b2 + 4];
    let p2 = verts[b2 + 5];
    let e2 = verts[b2 + 7];
    let w2r = verts[b2 + 8];

    let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (Math.abs(area) < 1e-5) continue;

    // Ensure positive area (CW in screen Y-down) for consistent top-left edge fill rule
    if (area < 0) {
      area = -area;
      let tmp = x1; x1 = x2; x2 = tmp;
      tmp = y1; y1 = y2; y2 = tmp;
      tmp = u1; u1 = u2; u2 = tmp;
      tmp = v1t; v1t = v2t; v2t = tmp;
      tmp = a1; a1 = a2; a2 = tmp;
      tmp = p1; p1 = p2; p2 = tmp;
      tmp = e1; e1 = e2; e2 = tmp;
      tmp = w1r; w1r = w2r; w2r = tmp;
    }

    const minPx = Math.max(0, Math.floor(Math.min(x0, x1, x2) - originX));
    const maxPx = Math.min(width - 1, Math.ceil(Math.max(x0, x1, x2) - originX));
    const minPy = Math.max(0, Math.floor(Math.min(y0, y1, y2) - originY));
    const maxPy = Math.min(height - 1, Math.ceil(Math.max(y0, y1, y2) - originY));
    if (minPx > maxPx || minPy > maxPy) continue;

    const tipIdx = Math.max(0, Math.min(tipSurfaces.length - 1, Math.round(rawTipIdx)));
    const surf = tipSurfaces[tipIdx];
    const useColorTip = !isEraser && !isBgEraser && Boolean(surf.isColor ?? globalColorTip);
    const useDualTone = !isEraser && !isBgEraser && !useColorTip && Boolean(surf.isDualToneTip ?? globalDualTone);
    const needRgb = useColorTip || useDualTone;

    // Top-left edge flags for CW screen-space triangle (area > 0)
    const tl0 = y2 < y1 || (y2 === y1 && x2 > x1); // edge v1 -> v2
    const tl1 = y0 < y2 || (y0 === y2 && x0 > x2); // edge v2 -> v0
    const tl2 = y1 < y0 || (y1 === y0 && x1 > x0); // edge v0 -> v1

    const dx0 = x2 - x1;
    const dy0 = y2 - y1;
    const dx1 = x0 - x2;
    const dy1 = y0 - y2;
    const dx2 = x1 - x0;
    const dy2 = y1 - y0;
    const invArea = 1.0 / area;

    for (let py = minPy; py <= maxPy; py++) {
      const wy = originY + py + 0.5;
      const rowOff = py * width;
      const wxStart = originX + minPx + 0.5;

      let w0 = dx0 * (wy - y1) - dy0 * (wxStart - x1);
      let w1 = dx1 * (wy - y2) - dy1 * (wxStart - x2);
      let w2 = dx2 * (wy - y0) - dy2 * (wxStart - x0);

      for (let px = minPx; px <= maxPx; px++) {
        const inside =
          (w0 > 0 || (w0 === 0 && tl0)) &&
          (w1 > 0 || (w1 === 0 && tl1)) &&
          (w2 > 0 || (w2 === 0 && tl2));

        if (inside) {
          const bw0 = w0 * invArea;
          const bw1 = w1 * invArea;
          const bw2 = w2 * invArea;

          const u = bw0 * u0 + bw1 * u1 + bw2 * u2;
          const v = bw0 * v0t + bw1 * v1t + bw2 * v2t;

          if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
            if (aaMode === 0) {
              sampleSurfaceNearest(surf, u, v, sampleScratch);
            } else {
              sampleSurfaceBilinear(surf, u, v, needRgb, sampleScratch);
            }

            let tipAlpha = sampleScratch[3];
            if (aaMode === 0) {
              tipAlpha = tipAlpha >= 0.5 ? 1.0 : 0.0;
            } else if (tipAlpha > 0.002) {
              const edgeDist = bw0 * e0 + bw1 * e1 + bw2 * e2;
              const ribWidth = bw0 * w0r + bw1 * w1r + bw2 * w2r;
              const edgeUv = Math.min(0.45, edgePx / Math.max(1.0, ribWidth));
              const absE = Math.abs(edgeDist);
              const featherStart = 1.0 - edgeUv * 2.0;
              if (edgeUv > 1e-4 && absE > featherStart) {
                const ft = Math.max(0, Math.min(1, (absE - featherStart) / (edgeUv * 2.0)));
                tipAlpha *= 1.0 - ft * ft * (3.0 - 2.0 * ft);
              }
            }

            if (tipAlpha > 0.002) {
              const vAlpha = bw0 * a0 + bw1 * a1 + bw2 * a2;
              let finalAlpha = Math.max(0, Math.min(1, tipAlpha * vAlpha));

              if (hasGrain && paper && finalAlpha > 0.002) {
                const wx = originX + px + 0.5;
                let psx = wx * invPaperScale;
                let psy = wy * invPaperScale;
                if (hasPaperRot) {
                  const rx = psx * cosPR - psy * sinPR;
                  const ry = psx * sinPR + psy * cosPR;
                  psx = rx;
                  psy = ry;
                }
                const pfx = Math.floor(psx);
                const pfy = Math.floor(psy);
                const ptx = psx - pfx;
                const pty = psy - pfy;
                let px0: number, py0: number, px1: number, py1: number;
                if (paperPow2) {
                  px0 = pfx & paperMaskW;
                  py0 = pfy & paperMaskH;
                  px1 = (px0 + 1) & paperMaskW;
                  py1 = (py0 + 1) & paperMaskH;
                } else {
                  px0 = ((pfx % paperW) + paperW) % paperW;
                  py0 = ((pfy % paperH) + paperH) % paperH;
                  px1 = px0 + 1 < paperW ? px0 + 1 : 0;
                  py1 = py0 + 1 < paperH ? py0 + 1 : 0;
                }
                const pr0 = py0 * paperW;
                const pr1 = py1 * paperW;
                const pvTop = paper.data[pr0 + px0] + (paper.data[pr0 + px1] - paper.data[pr0 + px0]) * ptx;
                const pvBot = paper.data[pr1 + px0] + (paper.data[pr1 + px1] - paper.data[pr1 + px0]) * ptx;
                const gNorm = (pvTop + (pvBot - pvTop) * pty) / 255;
                const vPress = bw0 * p0 + bw1 * p1 + bw2 * p2;

                finalAlpha = applyCspPaperTextureAlpha(
                  finalAlpha,
                  gNorm,
                  grainAmount,
                  vPress,
                  paperMode,
                  paperBrightness,
                  paperContrast,
                  paperInverted,
                  preserveDensity,
                  emphasizeDensity
                );
              }

              if (aaMode === 0) {
                finalAlpha = finalAlpha >= 0.5 ? 1.0 : 0.0;
              }

              if (finalAlpha > 0.002) {
                let r: number;
                let g: number;
                let b: number;
                if (useColorTip) {
                  r = sampleScratch[0];
                  g = sampleScratch[1];
                  b = sampleScratch[2];
                } else if (useDualTone) {
                  const lum = (0.299 * sampleScratch[0] + 0.587 * sampleScratch[1] + 0.114 * sampleScratch[2]) / 255;
                  r = primRgb.r + (secRgb.r - primRgb.r) * lum;
                  g = primRgb.g + (secRgb.g - primRgb.g) * lum;
                  b = primRgb.b + (secRgb.b - primRgb.b) * lum;
                } else {
                  r = primRgb.r;
                  g = primRgb.g;
                  b = primRgb.b;
                }

                const pOff = (rowOff + px) << 2;
                const dstA = out[pOff + 3] / 255;
                if (dstA <= 0.001) {
                  out[pOff + 0] = Math.max(0, Math.min(255, Math.round(r)));
                  out[pOff + 1] = Math.max(0, Math.min(255, Math.round(g)));
                  out[pOff + 2] = Math.max(0, Math.min(255, Math.round(b)));
                  out[pOff + 3] = Math.max(0, Math.min(255, Math.round(finalAlpha * 255)));
                } else {
                  const outA = finalAlpha + dstA * (1.0 - finalAlpha);
                  const invOutA = 1.0 / Math.max(1e-5, outA);
                  const dstKeep = dstA * (1.0 - finalAlpha);
                  out[pOff + 0] = Math.max(0, Math.min(255, Math.round((r * finalAlpha + out[pOff + 0] * dstKeep) * invOutA)));
                  out[pOff + 1] = Math.max(0, Math.min(255, Math.round((g * finalAlpha + out[pOff + 1] * dstKeep) * invOutA)));
                  out[pOff + 2] = Math.max(0, Math.min(255, Math.round((b * finalAlpha + out[pOff + 2] * dstKeep) * invOutA)));
                  out[pOff + 3] = Math.max(0, Math.min(255, Math.round(outA * 255)));
                }
              }
            }
          }
        }

        w0 -= dy0;
        w1 -= dy1;
        w2 -= dy2;
      }
    }
  }

  return { data: out, width, height };
}

// ============================================================================
// 6. Unified WebGL + CPU Context Dispatcher
// ============================================================================

let _cpuRibbonScratchCanvas: HTMLCanvasElement | null = null;
const MAX_CPU_RIBBON_CHUNK = 2048;

export function canUseWebGlForRibbon(options?: RibbonRenderOptions): boolean {
  const perf = performanceManager.getConfig();
  if (perf.renderBackend === 'canvas2d' || !perf.gpuBrushAcceleration) {
    return false;
  }
  if (options?.useGpu === false) return false;
  // When caller supplies raw CPU tipSurfaces without HTMLImageElement, rasterize on CPU
  if (options?.tipSurfaces && !options.tipImage && !(options.subTipImages && options.subTipImages.length > 0)) {
    return false;
  }
  return WebGlBrushEngine.getInstance().isTexturedRibbonAvailable();
}

export function renderRibbonMeshToContext(
  ctx: CanvasRenderingContext2D,
  mesh: RibbonMesh,
  options: RibbonRenderOptions,
  tool: ToolType = 'brush'
): boolean {
  if (mesh.vertexCount < 3) return false;

  const isBgEraser = Boolean(options.isBgEraser);
  const isEraser = (tool === 'eraser' || Boolean(options.isEraser) || Boolean(options.isTransparentInk)) && !isBgEraser;
  const primaryColor = isBgEraser ? '#ffffff' : isEraser ? '#000000' : options.primaryColor ?? '#000000';
  const strokeOpacity = Math.max(0, Math.min(1, options.opacity ?? 1.0));

  // 1. Try WebGL textured ribbon pipeline first
  if (canUseWebGlForRibbon(options)) {
    const gpu = WebGlBrushEngine.getInstance();
    const gpuSettings: BrushSettings & { alphaLocked?: boolean; isBgEraser?: boolean } = {
      size: options.size ?? 10,
      minSizeFactor: options.minSizeFactor ?? 0,
      color: primaryColor,
      secondaryColor: options.secondaryColor ?? '#ffffff',
      opacity: strokeOpacity,
      flow: options.flow ?? 1.0,
      spacing: 0.08,
      usePressure: options.usePressure !== false,
      smoothing: false,
      stabilization: 0,
      hardness: options.hardness ?? 1.0,
      antiAlias: options.antiAlias ?? 2,
      grain: options.grain ?? options.textureDensity ?? 0,
      textureDensity: options.textureDensity,
      grainPenetrationSensor: options.grainPenetrationSensor,
      surfaceTextureId: options.surfaceTextureId,
      paperTextureMode: options.paperTextureMode,
      paperTextureBrightness: options.paperTextureBrightness,
      paperTextureContrast: options.paperTextureContrast,
      paperTextureApplyEachPlot: options.paperTextureApplyEachPlot,
      paperTextureEmphasizeDensity: options.paperTextureEmphasizeDensity,
      paperTextureInverted: options.paperTextureInverted,
      paperTextureImage: options.paperTextureImage,
      paperTextureScale: options.paperTextureScale,
      paperTextureRotate: options.paperTextureRotate,
      customTipImage: options.tipImage,
      isColorTip: options.isColorTip,
      isDualToneTip: options.isDualToneTip,
      subTips: options.subTips,
      subTipImages: options.subTipImages,
      isTransparentInk: Boolean(options.isTransparentInk),
      alphaLocked: Boolean(options.alphaLocked),
      isBgEraser,
    };

    if (gpu.renderTexturedRibbonMesh(ctx, mesh, gpuSettings, primaryColor, isEraser ? 'eraser' : tool)) {
      return true;
    }
  }

  // 2. CPU scanline barycentric fallback
  if (typeof document === 'undefined') return false;

  const pad = 2;
  const fullX = Math.floor(mesh.bounds.minX - pad);
  const fullY = Math.floor(mesh.bounds.minY - pad);
  const fullMaxX = Math.ceil(mesh.bounds.maxX + pad);
  const fullMaxY = Math.ceil(mesh.bounds.maxY + pad);
  const totalW = fullMaxX - fullX;
  const totalH = fullMaxY - fullY;
  if (totalW <= 0 || totalH <= 0) return false;

  if (!_cpuRibbonScratchCanvas) {
    _cpuRibbonScratchCanvas = document.createElement('canvas');
  }
  const scratch = _cpuRibbonScratchCanvas;

  const compositeOp: GlobalCompositeOperation = isBgEraser
    ? 'source-over'
    : isEraser
    ? 'destination-out'
    : options.alphaLocked
    ? 'source-atop'
    : 'source-over';

  ctx.save();
  ctx.globalCompositeOperation = compositeOp;
  ctx.globalAlpha = strokeOpacity;
  if ((options.antiAlias ?? 2) === 0) {
    ctx.imageSmoothingEnabled = false;
  }

  for (let cy = fullY; cy < fullMaxY; cy += MAX_CPU_RIBBON_CHUNK) {
    const ch = Math.min(MAX_CPU_RIBBON_CHUNK, fullMaxY - cy);
    for (let cx = fullX; cx < fullMaxX; cx += MAX_CPU_RIBBON_CHUNK) {
      const cw = Math.min(MAX_CPU_RIBBON_CHUNK, fullMaxX - cx);
      const raster = rasterizeRibbonMeshCpu(mesh, options, cw, ch, cx, cy);

      if (scratch.width !== cw || scratch.height !== ch) {
        scratch.width = cw;
        scratch.height = ch;
      }
      const sCtx = scratch.getContext('2d');
      if (!sCtx) continue;
      const imgData =
        typeof sCtx.createImageData === 'function'
          ? sCtx.createImageData(cw, ch)
          : ({ data: new Uint8ClampedArray(cw * ch * 4), width: cw, height: ch } as ImageData);
      imgData.data.set(raster.data);
      sCtx.putImageData(imgData, 0, 0);
      ctx.drawImage(scratch, 0, 0, cw, ch, cx, cy, cw, ch);
    }
  }

  ctx.restore();
  return true;
}

export function buildRibbonRenderOptionsFromBrushSettings(
  rawSettings: BrushSettings,
  colorMode: CanvasColorMode = 'color',
  isBgEraser: boolean = false,
  isEraser: boolean = false,
  alphaLocked: boolean = false,
  allowGpuForMonochrome: boolean = false,
  exitSpeed?: number,
  overrides?: Partial<RibbonRenderOptions>
): RibbonRenderOptions {
  const bs = resolveBrushPresetSettings(rawSettings);
  const isMono = colorMode === 'monochrome';
  const primaryColor = isBgEraser
    ? '#ffffff'
    : isEraser
    ? '#000000'
    : enforceColorMode(bs.color, colorMode);
  const secondaryColor = enforceColorMode(bs.secondaryColor ?? '#ffffff', colorMode);

  const effectiveAntiAlias = isMono
    ? allowGpuForMonochrome && (bs.antiAlias ?? 2) !== 0 && bs.useGpu !== false
      ? bs.antiAlias ?? 2
      : 0
    : bs.antiAlias ?? 2;

  return {
    size: bs.size,
    minSizeFactor: bs.minSizeFactor,
    opacity: bs.opacity ?? 1.0,
    flow: isMono ? 1.0 : bs.flow ?? 1.0,
    brushDensity: isMono ? 1.0 : bs.brushDensity,
    hardness: isMono ? 1.0 : bs.hardness ?? 1.0,
    thickness: bs.thickness ?? 1.0,
    thicknessVertical: Boolean(bs.thicknessVertical),
    thicknessSensor: bs.thicknessSensor,
    angle: bs.customTipAngle ?? 0,
    flipH: bs.flipH,
    flipV: bs.flipV,
    antiAlias: effectiveAntiAlias,
    usePressure: bs.usePressure,
    pressureCurve: bs.pressureCurve,
    useTilt: Boolean(bs.useTilt),
    tiltScale: bs.tiltScale,
    sizeSensor: bs.sizeSensor,
    opacitySensor: bs.opacitySensor,
    densitySensor: bs.densitySensor,
    grainPenetrationSensor: bs.grainPenetrationSensor,
    taper: bs.taper,
    tipImage: bs.customTipImage,
    subTips: bs.subTips,
    subTipOrder: bs.subTipOrder,
    subTipImages: bs.subTipImages,
    isColorTip: Boolean(bs.isColorTip || bs.subTips?.[0]?.isColor),
    isDualToneTip: Boolean(bs.isDualToneTip || bs.subTips?.[0]?.isDualToneTip),
    primaryColor,
    secondaryColor,
    grain: bs.grain ?? bs.textureDensity ?? 0,
    textureDensity: bs.textureDensity,
    surfaceTextureId: bs.surfaceTextureId,
    paperTextureImage: bs.paperTextureImage,
    paperTextureMode: bs.paperTextureMode,
    paperTextureScale: bs.paperTextureScale,
    paperTextureRotate: bs.paperTextureRotate,
    paperTextureBrightness: bs.paperTextureBrightness,
    paperTextureContrast: bs.paperTextureContrast,
    paperTextureInverted: bs.paperTextureInverted,
    paperTextureApplyEachPlot: bs.paperTextureApplyEachPlot,
    paperTextureEmphasizeDensity: bs.paperTextureEmphasizeDensity,
    useGpu: bs.useGpu !== false,
    isEraser: isEraser && !isBgEraser,
    isBgEraser,
    alphaLocked,
    isTransparentInk: Boolean(bs.isTransparentInk),
    exitSpeed,
    ...overrides,
  };
}

/**
 * Renders an entire completed ribbon stroke onto `ctx`.
 */
export function renderCompleteRibbonStroke(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  brushSettings: BrushSettings,
  tool: ToolType = 'brush',
  colorMode: CanvasColorMode = 'color',
  isBgEraser: boolean = false,
  alphaLocked: boolean = false,
  allowGpuForMonochrome: boolean = false,
  exitSpeed?: number,
  overrides?: Partial<RibbonRenderOptions>
): RibbonMesh | null {
  if (!points || points.length === 0) return null;

  const resolvedSettings = resolveBrushPresetSettings(brushSettings);
  const postCorrLevel = resolvedSettings.postCorrection ?? 0;
  const effectivePoints =
    postCorrLevel > 0 && points.length >= 3
      ? applyCspPostCorrection(points, postCorrLevel, resolvedSettings.sharpCorners !== false)
      : points;

  const isEraser = tool === 'eraser';
  const ribbonOpts = buildRibbonRenderOptionsFromBrushSettings(
    resolvedSettings,
    colorMode,
    isBgEraser,
    isEraser,
    alphaLocked,
    allowGpuForMonochrome,
    exitSpeed,
    overrides
  );

  const mesh = buildRibbonMeshFromPoints(effectivePoints, ribbonOpts);
  if (mesh.vertexCount < 3) return mesh;

  renderRibbonMeshToContext(ctx, mesh, ribbonOpts, tool);
  return mesh;
}

// ============================================================================
// 7. Live Incremental Ribbon Stroke Session (Draft Canvas Streaming)
// ============================================================================

export class RibbonStrokeSession {
  private s = 0;
  private sNorm = 0;
  private sampleIdx = 0;
  private hasSeed = false;
  private seedX = 0;
  private seedY = 0;
  private lastEdgeState: {
    lx: number;
    ly: number;
    rx: number;
    ry: number;
    tx: number;
    ty: number;
    s: number;
    sNorm: number;
    alpha: number;
    pressure: number;
    ribbonWidth: number;
    cx: number;
    cy: number;
  } | null = null;

  public reset(): void {
    this.s = 0;
    this.sNorm = 0;
    this.sampleIdx = 0;
    this.hasSeed = false;
    this.seedX = 0;
    this.seedY = 0;
    this.lastEdgeState = null;
  }

  public appendCubicSegment(
    ctx: CanvasRenderingContext2D,
    seg: CubicBezierSegment,
    options: RibbonRenderOptions,
    tool: ToolType = 'brush'
  ): RibbonMesh | null {
    if (!this.hasSeed) {
      this.seedX = seg.p0.x;
      this.seedY = seg.p0.y;
      this.hasSeed = true;
    }

    const metrics = buildTipMetrics(options);
    const centerline: RibbonCenterlineSample[] = [];
    const state = {
      s: this.s,
      sNorm: this.sNorm,
      sampleIdx: this.sampleIdx,
      seedX: this.seedX,
      seedY: this.seedY,
      totalLength: options.totalLength,
    };

    sampleCubicSegmentIntoCenterline(
      centerline,
      seg.p0,
      seg.c1,
      seg.c2,
      seg.p3,
      options,
      metrics,
      state
    );

    if (centerline.length < 2) return null;

    const slices = buildSlicesFromCenterline(centerline, options, this.lastEdgeState ?? undefined);
    const mesh = buildRibbonMeshFromCenterline(centerline, options, this.lastEdgeState ?? undefined);

    this.s = state.s;
    this.sampleIdx = state.sampleIdx;

    if (slices.length >= 2) {
      const endSlice = slices[slices.length - 1];
      this.sNorm = endSlice.sNorm;
      this.lastEdgeState = {
        lx: endSlice.lx,
        ly: endSlice.ly,
        rx: endSlice.rx,
        ry: endSlice.ry,
        tx: endSlice.tx,
        ty: endSlice.ty,
        s: endSlice.s,
        sNorm: endSlice.sNorm,
        alpha: endSlice.alpha,
        pressure: endSlice.pressure,
        ribbonWidth: endSlice.ribbonWidth,
        cx: endSlice.cx,
        cy: endSlice.cy,
      };
    } else {
      this.sNorm = state.sNorm;
    }

    if (mesh.vertexCount >= 3) {
      renderRibbonMeshToContext(ctx, mesh, options, tool);
    }
    return mesh;
  }
}
