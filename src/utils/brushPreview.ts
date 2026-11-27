import {
  BristleSettings,
  BrushDynamics,
  BrushPresetId,
  BrushRenderMode,
  BrushSettings,
  CspAngleDynamicsMode,
  CspAntiAliasLevel,
  CspBlendTipsMode,
  CspBrushCombineMode,
  CspDualBrushConfig,
  CspPaperTextureMode,
  CspSensorConfig,
  CspSpraySettings,
  CspSubTip,
  CspSubTipOrder,
  CspTaperSettings,
  CspTipFlipMode,
  DualBrushCompositeMode,
  GrainMappingMode,
  ImpastoSettings,
  NaturalMixingMode,
  NaturalPaintSettings,
  Point,
  SurfaceTextureId,
} from '../types/editor';
import { getBuiltinBrushConfig } from './presetBrushes';
import {
  getLegacyPencilPresetDefaults,
  evaluateFastSpline,
  renderCompleteStroke,
} from '../engine/BrushEngine';
import { resolveDualBrushConfig } from '../engine/DualBrushEngine';

export interface BrushPreviewOptions {
  preset?: BrushPresetId;
  size?: number;
  flow?: number;
  brushDensity?: number;
  opacity?: number;
  grain?: number;
  textureDensity?: number;
  paperTexture?: string;
  paperTextureImage?: HTMLImageElement;
  paperTextureMode?: CspPaperTextureMode;
  paperTextureScale?: number;
  paperTextureRotate?: number;
  paperTextureOffsetX?: number;
  paperTextureOffsetY?: number;
  paperTextureContrast?: number;
  paperTextureBrightness?: number;
  paperTextureApplyEachPlot?: boolean;
  paperTextureEmphasizeDensity?: boolean;
  paperTextureInverted?: boolean;
  hardness?: number;
  spacing?: number;
  minSizeFactor?: number;
  usePressure?: boolean;
  useTilt?: boolean;
  tiltScale?: number;
  useVelocity?: boolean;
  color?: string;
  secondaryColor?: string;
  backgroundColor?: string;
  isSelected?: boolean;
  tool?: 'brush' | 'eraser';
  customTipDataUrl?: string;
  customTipImage?: HTMLImageElement;
  customTipAngle?: number;
  customTipAngleDynamics?: CspAngleDynamicsMode;
  customTipRotationRandomScale?: number;
  isColorTip?: boolean;
  isDualToneTip?: boolean;
  isRibbon?: boolean;
  subTips?: CspSubTip[];
  subTipOrder?: CspSubTipOrder;
  subTipImages?: HTMLImageElement[];
  thickness?: number;
  thicknessVertical?: boolean;
  thicknessSensor?: CspSensorConfig;
  flipH?: CspTipFlipMode;
  flipV?: CspTipFlipMode;
  blendTipsMode?: CspBlendTipsMode;
  brushCombineMode?: CspBrushCombineMode;
  adjustDensityByGap?: boolean;
  antiAlias?: number;
  pressureCurve?: [number, number][];
  velocityCurve?: [number, number][];
  sizeSensor?: CspSensorConfig;
  opacitySensor?: CspSensorConfig;
  densitySensor?: CspSensorConfig;
  intervalSensor?: CspSensorConfig;
  textureDensitySensor?: CspSensorConfig;
  angleSensor?: CspSensorConfig;
  scatterSensor?: CspSensorConfig;
  spray?: CspSpraySettings;
  taper?: CspTaperSettings;
  dynamics?: BrushDynamics;
  colorMixing?: boolean;
  perceptualMixing?: boolean;
  amountOfPaint?: number;
  densityOfPaint?: number;
  colorStretch?: number;
  amountOfPaintSensor?: CspSensorConfig;
  densityOfPaintSensor?: CspSensorConfig;
  colorStretchSensor?: CspSensorConfig;
  useBlur?: boolean;
  blurStrength?: number;
  mixingMode?: NaturalMixingMode;
  wetEdge?: number;
  wetEdgeRadius?: number;
  wetEdgeAlphaPower?: number;
  wetEdgeValuePower?: number;
  dualBrush?: boolean;
  dualBrushConfig?: CspDualBrushConfig;
  dualBrushCompositeMode?: DualBrushCompositeMode | string;
  dualTipDataUrl?: string;
  dualTipImage?: HTMLImageElement;
  dualSize?: number;
  dualLinkSize?: boolean;
  dualSpacing?: number;
  dualScatter?: number;
  dualThickness?: number;
  dualThicknessVertical?: boolean;
  dualAngle?: number;
  dualAngleDynamics?: CspAngleDynamicsMode;
  dualAngleSensor?: CspSensorConfig;
  dualHardness?: number;
  dualDensity?: number;
  dualSubTips?: CspSubTip[];
  dualSubTipImages?: HTMLImageElement[];
  dualSubTipOrder?: CspSubTipOrder;
  dualFlipH?: CspTipFlipMode;
  dualFlipV?: CspTipFlipMode;
  dualSpray?: CspSpraySettings;
  dualIsRibbon?: boolean;
  dualScale?: number;
  dualSurfaceTextureId?: SurfaceTextureId;
  dualGrainDepth?: number;
  renderMode?: BrushRenderMode;
  bristle?: BristleSettings;
  naturalPaint?: NaturalPaintSettings;
  impasto?: ImpastoSettings;
  surfaceTextureId?: SurfaceTextureId;
  grainMappingMode?: GrainMappingMode;
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
 * Renders an authentic Clip Studio Paint style S-curve stroke preview
 * directly through the unified `renderCompleteStroke` pipeline.
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
  const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
  const targetHeight = Math.max(1, Math.round(cssHeight * dpr));

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
  const flow = options.flow ?? options.brushDensity ?? builtinCfg?.flow ?? 0.85;
  const opacity = options.opacity ?? builtinCfg?.opacity ?? 1.0;
  const grain = options.grain ?? options.textureDensity ?? builtinCfg?.grain ?? builtinCfg?.textureDensity ?? 0;
  const hardness = options.hardness ?? builtinCfg?.hardness ?? 1.0;
  const minSizeFactor = options.minSizeFactor ?? builtinCfg?.minSizeFactor ?? 0.15;
  const thickness = options.thickness ?? builtinCfg?.thickness ?? 1.0;
  const thicknessVertical = Boolean(options.thicknessVertical ?? builtinCfg?.thicknessVertical);
  const customTipAngle = options.customTipAngle ?? builtinCfg?.customTipAngle ?? 0;
  const angleDynamics = options.customTipAngleDynamics ?? builtinCfg?.customTipAngleDynamics ?? 'none';
  const dynamics = options.dynamics ?? builtinCfg?.dynamics;
  const paperTextureImage = options.paperTextureImage ?? builtinCfg?.paperTextureImage;
  const paperMode = options.paperTextureMode ?? builtinCfg?.paperTextureMode ?? 'subtract';
  const paperScale = options.paperTextureScale ?? builtinCfg?.paperTextureScale ?? 1.0;
  const paperRotate = options.paperTextureRotate ?? builtinCfg?.paperTextureRotate ?? 0;
  const paperContrast = options.paperTextureContrast ?? builtinCfg?.paperTextureContrast ?? 0;
  const paperBrightness = options.paperTextureBrightness ?? builtinCfg?.paperTextureBrightness ?? 0;
  const paperApplyEachPlot = options.paperTextureApplyEachPlot ?? builtinCfg?.paperTextureApplyEachPlot;
  const paperEmphasizeDensity = options.paperTextureEmphasizeDensity ?? builtinCfg?.paperTextureEmphasizeDensity;
  const paperInverted = Boolean(options.paperTextureInverted ?? builtinCfg?.paperTextureInverted);
  const spacing = options.spacing ?? builtinCfg?.spacing ?? 0.05;
  const blendTipsMode = options.blendTipsMode ?? builtinCfg?.blendTipsMode ?? 'darken';
  const brushCombineMode = options.brushCombineMode ?? builtinCfg?.brushCombineMode;
  const adjustByGap = Boolean(options.adjustDensityByGap ?? builtinCfg?.adjustDensityByGap);
  const aaLevel = clamp(
    Math.round(options.antiAlias ?? builtinCfg?.antiAlias ?? 2),
    0,
    3
  ) as CspAntiAliasLevel;
  const isEraser = options.tool === 'eraser' || brushCombineMode === 'clear';
  const strokeColor = options.color || '#ffffff';
  const secondaryColor = options.secondaryColor || '#60a5fa';
  const bgColor = options.backgroundColor || 'transparent';
  const renderMode = options.renderMode ?? builtinCfg?.renderMode;
  const bristleCfg = options.bristle ?? builtinCfg?.bristle;
  const naturalCfg = options.naturalPaint ?? builtinCfg?.naturalPaint;
  const impastoCfg = options.impasto ?? builtinCfg?.impasto;
  const surfaceTextureId = options.surfaceTextureId ?? builtinCfg?.surfaceTextureId;
  const grainMappingMode = options.grainMappingMode ?? builtinCfg?.grainMappingMode;
  const isRibbon = Boolean(options.isRibbon ?? builtinCfg?.isRibbon);
  const isColorTip = Boolean(options.isColorTip ?? builtinCfg?.isColorTip);
  const isDualToneTip = Boolean(options.isDualToneTip ?? builtinCfg?.isDualToneTip);
  const subTips = options.subTips ?? builtinCfg?.subTips;
  const subTipOrder = options.subTipOrder ?? builtinCfg?.subTipOrder;
  const subTipImages = options.subTipImages ?? builtinCfg?.subTipImages;
  const taper = options.taper ?? builtinCfg?.taper;
  const spray = options.spray ?? builtinCfg?.spray;
  const wetEdge = options.wetEdge ?? builtinCfg?.wetEdge ?? 0;
  const wetEdgeRadius = options.wetEdgeRadius ?? builtinCfg?.wetEdgeRadius;
  const wetEdgeAlphaPower = options.wetEdgeAlphaPower ?? builtinCfg?.wetEdgeAlphaPower;
  const wetEdgeValuePower = options.wetEdgeValuePower ?? builtinCfg?.wetEdgeValuePower;
  const colorMixing = Boolean(options.colorMixing ?? builtinCfg?.colorMixing);
  const perceptualMixing = options.perceptualMixing ?? builtinCfg?.perceptualMixing;
  const amountOfPaint = options.amountOfPaint ?? builtinCfg?.amountOfPaint;
  const densityOfPaint = options.densityOfPaint ?? builtinCfg?.densityOfPaint;
  const colorStretch = options.colorStretch ?? builtinCfg?.colorStretch;
  const mixingMode = options.mixingMode ?? builtinCfg?.mixingMode;
  const usePressure = options.usePressure ?? builtinCfg?.usePressure ?? true;
  const useTilt = Boolean(options.useTilt ?? builtinCfg?.useTilt);

  const dualCfg = resolveDualBrushConfig({
    size,
    dualBrush: options.dualBrush ?? builtinCfg?.dualBrush,
    dualBrushConfig: options.dualBrushConfig ?? builtinCfg?.dualBrushConfig,
    dualBrushCompositeMode: options.dualBrushCompositeMode ?? builtinCfg?.dualBrushCompositeMode,
    dualSize: options.dualSize ?? builtinCfg?.dualSize,
    dualLinkSize: options.dualLinkSize ?? builtinCfg?.dualLinkSize,
    dualScale: options.dualScale ?? builtinCfg?.dualScale,
    dualSpacing: options.dualSpacing ?? builtinCfg?.dualSpacing,
    dualScatter: options.dualScatter ?? builtinCfg?.dualScatter,
    dualThickness: options.dualThickness ?? builtinCfg?.dualThickness,
    dualThicknessVertical: options.dualThicknessVertical ?? builtinCfg?.dualThicknessVertical,
    dualAngle: options.dualAngle ?? builtinCfg?.dualAngle,
    dualAngleDynamics: options.dualAngleDynamics ?? builtinCfg?.dualAngleDynamics,
    dualAngleSensor: options.dualAngleSensor ?? builtinCfg?.dualAngleSensor,
    dualHardness: options.dualHardness ?? builtinCfg?.dualHardness,
    dualDensity: options.dualDensity ?? builtinCfg?.dualDensity,
    dualSubTips: options.dualSubTips ?? builtinCfg?.dualSubTips,
    dualSubTipImages: options.dualSubTipImages ?? builtinCfg?.dualSubTipImages,
    dualSubTipOrder: options.dualSubTipOrder ?? builtinCfg?.dualSubTipOrder,
    dualFlipH: options.dualFlipH ?? builtinCfg?.dualFlipH,
    dualFlipV: options.dualFlipV ?? builtinCfg?.dualFlipV,
    dualSpray: options.dualSpray ?? builtinCfg?.dualSpray,
    dualIsRibbon: options.dualIsRibbon ?? builtinCfg?.dualIsRibbon,
    dualTipDataUrl: options.dualTipDataUrl ?? builtinCfg?.dualTipDataUrl,
    dualTipImage: options.dualTipImage ?? builtinCfg?.dualTipImage,
  });

  const curveSig = options.pressureCurve
    ? options.pressureCurve.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(';')
    : 'lin';
  const taperSig = taper
    ? `${taper.useIn ? 1 : 0}:${taper.inLength}:${taper.useOut ? 1 : 0}:${taper.outLength}:${taper.affectSize ? 1 : 0}:${taper.affectOpacity ? 1 : 0}`
    : 'nt';
  const dynSig = dynamics
    ? `${dynamics.sizeJitter.toFixed(2)}:${dynamics.angleJitter.toFixed(2)}:${dynamics.scatter.toFixed(2)}:${dynamics.count}:${dynamics.colorJitterEnabled ? 1 : 0}:${dynamics.colorJitterPerStroke ? 1 : 0}:${dynamics.hueJitter.toFixed(2)}:${dynamics.saturationJitter.toFixed(2)}:${dynamics.brightnessJitter.toFixed(2)}:${dynamics.foregroundBackgroundJitter.toFixed(2)}`
    : 'nd';
  const dualSig = dualCfg
    ? `d:${dualCfg.compositeMode}:${dualCfg.size ?? ''}:${dualCfg.sizeRatio ?? ''}:${dualCfg.spacing ?? ''}:${dualCfg.isRibbon ? 1 : 0}:${getTipCacheIdentity(dualCfg.tipImage)}`
    : 'ndual';

  const cacheKey = [
    preset,
    size.toFixed(1),
    flow.toFixed(2),
    opacity.toFixed(2),
    grain.toFixed(2),
    paperMode,
    paperScale.toFixed(2),
    paperRotate.toFixed(1),
    paperContrast.toFixed(1),
    paperBrightness.toFixed(1),
    paperApplyEachPlot ? 'p1' : 'p0',
    paperInverted ? 'inv1' : 'inv0',
    getTipCacheIdentity(paperTextureImage),
    hardness.toFixed(2),
    minSizeFactor.toFixed(2),
    thickness.toFixed(2),
    thicknessVertical ? 'tv' : 'th',
    customTipAngle.toFixed(1),
    angleDynamics,
    spacing.toFixed(3),
    String(aaLevel),
    blendTipsMode,
    brushCombineMode || 'normal',
    adjustByGap ? 'gap1' : 'gap0',
    options.flipH || 'n',
    options.flipV || 'n',
    isRibbon ? 'rib1' : 'rib0',
    isColorTip ? 'ct1' : 'ct0',
    isDualToneTip ? 'dt1' : 'dt0',
    subTipOrder || 'seq',
    String(subTipImages?.length ?? subTips?.length ?? 0),
    spray?.enabled ? `sp:${spray.size}:${spray.density}:${spray.particleSize ?? ''}` : 'dab',
    taperSig,
    dynSig,
    dualSig,
    getTipCacheIdentity(tipImage),
    curveSig,
    usePressure ? 'up1' : 'up0',
    useTilt ? 'ut1' : 'ut0',
    isEraser ? '1' : '0',
    wetEdge.toFixed(2),
    String(wetEdgeRadius ?? ''),
    String(wetEdgeAlphaPower ?? ''),
    String(wetEdgeValuePower ?? ''),
    colorMixing ? `cm:${amountOfPaint ?? ''}:${densityOfPaint ?? ''}:${colorStretch ?? ''}` : 'cm0',
    renderMode || 'stamp',
    bristleCfg ? `${bristleCfg.profile}:${bristleCfg.count}:${bristleCfg.clumping.toFixed(2)}` : 'nb',
    impastoCfg?.enabled ? `imp:${impastoCfg.depth.toFixed(2)}:${impastoCfg.gloss.toFixed(2)}` : 'ni',
    naturalCfg?.enabled ? `np:${naturalCfg.paintLoad.toFixed(2)}:${naturalCfg.dryBrush.toFixed(2)}:${naturalCfg.depletionRate.toFixed(2)}` : 'nn',
    surfaceTextureId || 'std',
    strokeColor,
    secondaryColor,
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

  if (bgColor !== 'transparent') {
    offCtx.fillStyle = bgColor;
    offCtx.fillRect(0, 0, targetWidth, targetHeight);
  } else {
    offCtx.clearRect(0, 0, targetWidth, targetHeight);
  }

  // Render in native DPR pixel space (identity transform) so isolated surface passes
  // (wetEdge, stroke-level paper texture, dualBrush, brushCombineMode) stay crisp and pixel-exact.
  const padX = Math.max(12, Math.round(cssWidth * 0.1)) * dpr;
  const strokeLength = Math.max(8, targetWidth - 2 * padX);
  const centerY = targetHeight / 2;
  const maxAmp = Math.min(cssHeight * 0.28, isLiveCard ? 14 : 9) * dpr;
  const amp = Math.max(4 * dpr, maxAmp);
  const displayWidth = calculatePreviewWidth(size, cssHeight, isLiveCard) * dpr;
  const previewScale = displayWidth / Math.max(1, size);

  if (isEraser) {
    offCtx.save();
    offCtx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    offCtx.fillRect(padX - 4 * dpr, centerY - amp - 4 * dpr, strokeLength + 8 * dpr, (amp + 4 * dpr) * 2);
    offCtx.restore();
  }

  const numSteps = Math.min(64, Math.max(28, Math.round(cssWidth * 0.35)));
  const previewPts: Point[] = [];
  for (let i = 0; i <= numSteps; i++) {
    const u = i / numSteps;
    const x = padX + u * strokeLength;
    const y = centerY - Math.sin(2 * Math.PI * u) * amp;

    const sineEnv = Math.sin(Math.PI * u);
    const rawPressure = usePressure ? Math.pow(Math.max(0, sineEnv), 0.75) : 1.0;
    const sizePressure =
      usePressure && options.pressureCurve
        ? evaluateFastSpline(rawPressure, options.pressureCurve)
        : rawPressure;

    const effMinSize = usePressure ? Math.max(0.02, minSizeFactor) : 1.0;
    const w = Math.max(0.75 * dpr, displayWidth * (effMinSize + (1 - effMinSize) * sizePressure));
    const tiltX = useTilt ? Math.round(15 + 35 * u) : 0;
    const tiltY = useTilt ? Math.round(10 * Math.sin(Math.PI * u)) : 0;

    previewPts.push({
      x,
      y,
      width: w,
      pressure: rawPressure,
      tiltX,
      tiltY,
      timestamp: i * 8,
    });
  }

  // Scale taper lengths to fit the preview curve cleanly when taper is enabled
  const scaledTaper: CspTaperSettings | undefined = taper
    ? {
        ...taper,
        inLength: taper.inLength
          ? Math.max(4 * dpr, Math.min(strokeLength * 0.38, taper.inLength * Math.min(1, previewScale * 1.4)))
          : 0,
        outLength: taper.outLength
          ? Math.max(4 * dpr, Math.min(strokeLength * 0.38, taper.outLength * Math.min(1, previewScale * 1.4)))
          : 0,
      }
    : undefined;

  // Scale spray particle size gently to fit thumbnail dimensions
  const scaledSpray: CspSpraySettings | undefined = spray?.enabled
    ? {
        ...spray,
        size: Math.max(1.2 * dpr, Math.min(displayWidth * 0.65, (spray.size || 2) * Math.min(1, previewScale * 1.25))),
        particleSize: spray.particleSize
          ? Math.max(1.0 * dpr, Math.min(displayWidth * 0.5, spray.particleSize * Math.min(1, previewScale * 1.25)))
          : undefined,
      }
    : spray;

  // Scale Dual Brush config proportionally to preview brush width
  const scaledDualConfig: CspDualBrushConfig | undefined = dualCfg
    ? {
        ...dualCfg,
        size:
          dualCfg.size !== undefined
            ? Math.max(1.0 * dpr, dualCfg.size * previewScale)
            : undefined,
        sizeRatio:
          dualCfg.sizeRatio ??
          (dualCfg.size !== undefined && size > 0 ? dualCfg.size / size : undefined),
      }
    : undefined;

  // Natural paint preview adjustment: ensure zero-load blenders remain visible on clean swatch
  const previewNatural: NaturalPaintSettings | undefined = naturalCfg?.enabled
    ? {
        ...naturalCfg,
        spatialMixing: false,
        paintLoad: naturalCfg.paintLoad <= 0.05 ? 0.55 : naturalCfg.paintLoad,
      }
    : naturalCfg;

  // Pure CSP blender adjustment: ensure Amount=0 or mixingMode='smear' still shows a clear stroke on clean swatch
  const isPureCspBlender =
    colorMixing && ((amountOfPaint ?? 0.7) <= 0.05 || mixingMode === 'smear');
  const previewAmountOfPaint = isPureCspBlender ? 0.55 : amountOfPaint;
  const previewDensityOfPaint = isPureCspBlender ? Math.max(0.6, densityOfPaint ?? 0.6) : densityOfPaint;
  const previewMixingMode = isPureCspBlender ? 'blend' : mixingMode;

  const previewWetRadius =
    wetEdge > 0.01
      ? Math.max(1.2 * dpr, Math.min(4.5 * dpr, (wetEdgeRadius ?? 3.0) * Math.max(0.45, Math.min(1.0, previewScale)) * dpr))
      : wetEdgeRadius;

  // Avoid invisible preview if brushCombineMode is 'behind' over an opaque background fill
  const previewCombineMode =
    brushCombineMode === 'behind' && bgColor !== 'transparent'
      ? undefined
      : brushCombineMode === 'clear'
        ? undefined
        : brushCombineMode;

  const previewSettings: BrushSettings = {
    size: displayWidth,
    minSizeFactor,
    color: strokeColor,
    secondaryColor,
    opacity,
    flow,
    brushDensity: options.brushDensity ?? flow,
    adjustDensityByGap: adjustByGap,
    blendTipsMode,
    brushCombineMode: previewCombineMode,
    spacing: clamp(spacing, 0.02, 0.65),
    hardness,
    thickness,
    thicknessVertical,
    thicknessSensor: options.thicknessSensor ?? builtinCfg?.thicknessSensor,
    flipH: options.flipH ?? builtinCfg?.flipH,
    flipV: options.flipV ?? builtinCfg?.flipV,
    antiAlias: aaLevel,
    usePressure,
    useTilt,
    tiltScale: options.tiltScale ?? builtinCfg?.tiltScale,
    useVelocity: options.useVelocity ?? builtinCfg?.useVelocity,
    smoothing: true,
    stabilization: 0,
    postCorrection: 0,
    sharpCorners: true,
    pressureCurve: options.pressureCurve ?? builtinCfg?.pressureCurve,
    velocityCurve: options.velocityCurve ?? builtinCfg?.velocityCurve,
    sizeSensor: options.sizeSensor ?? builtinCfg?.sizeSensor,
    opacitySensor: options.opacitySensor ?? builtinCfg?.opacitySensor,
    densitySensor: options.densitySensor ?? builtinCfg?.densitySensor,
    intervalSensor: options.intervalSensor ?? builtinCfg?.intervalSensor,
    textureDensitySensor: options.textureDensitySensor ?? builtinCfg?.textureDensitySensor,
    angleSensor: options.angleSensor ?? builtinCfg?.angleSensor,
    scatterSensor: options.scatterSensor ?? builtinCfg?.scatterSensor,
    customTipDataUrl: options.customTipDataUrl,
    customTipImage: tipImage,
    customTipAngle,
    customTipAngleDynamics: angleDynamics,
    customTipRotationRandomScale:
      options.customTipRotationRandomScale ?? builtinCfg?.customTipRotationRandomScale,
    isColorTip,
    isDualToneTip,
    isRibbon,
    subTips,
    subTipOrder,
    subTipImages,
    spray: scaledSpray,
    taper: scaledTaper,
    dynamics,
    colorMixing,
    perceptualMixing: perceptualMixing ?? true,
    amountOfPaint: previewAmountOfPaint,
    densityOfPaint: previewDensityOfPaint,
    colorStretch,
    amountOfPaintSensor: options.amountOfPaintSensor ?? builtinCfg?.amountOfPaintSensor,
    densityOfPaintSensor: options.densityOfPaintSensor ?? builtinCfg?.densityOfPaintSensor,
    colorStretchSensor: options.colorStretchSensor ?? builtinCfg?.colorStretchSensor,
    useBlur: options.useBlur ?? builtinCfg?.useBlur,
    blurStrength: options.blurStrength ?? builtinCfg?.blurStrength,
    mixingMode: previewMixingMode,
    wetEdge,
    wetEdgeRadius: previewWetRadius,
    wetEdgeAlphaPower,
    wetEdgeValuePower,
    grain,
    textureDensity: grain,
    paperTexture: options.paperTexture ?? builtinCfg?.paperTexture,
    paperTextureImage,
    surfaceTextureId,
    grainMappingMode,
    paperTextureMode: paperMode,
    paperTextureScale: Math.max(0.25, paperScale * 0.75),
    paperTextureRotate: paperRotate,
    paperTextureOffsetX: options.paperTextureOffsetX ?? builtinCfg?.paperTextureOffsetX,
    paperTextureOffsetY: options.paperTextureOffsetY ?? builtinCfg?.paperTextureOffsetY,
    paperTextureBrightness: paperBrightness,
    paperTextureContrast: paperContrast,
    paperTextureApplyEachPlot: paperApplyEachPlot,
    paperTextureEmphasizeDensity: paperEmphasizeDensity,
    paperTextureInverted: paperInverted,
    dualBrush: Boolean(scaledDualConfig?.enabled),
    dualBrushConfig: scaledDualConfig,
    dualBrushCompositeMode: scaledDualConfig?.compositeMode,
    dualTipDataUrl: scaledDualConfig?.tipDataUrl,
    dualTipImage: scaledDualConfig?.tipImage,
    dualSize: scaledDualConfig?.size,
    dualLinkSize: scaledDualConfig?.linkSizeWithMain,
    dualSpacing: scaledDualConfig?.spacing,
    dualScatter: scaledDualConfig?.scatter,
    dualThickness: scaledDualConfig?.thickness,
    dualThicknessVertical: scaledDualConfig?.thicknessVertical,
    dualAngle: scaledDualConfig?.angle,
    dualAngleDynamics: scaledDualConfig?.angleDynamics,
    dualAngleSensor: scaledDualConfig?.angleSensor,
    dualHardness: scaledDualConfig?.hardness,
    dualDensity: scaledDualConfig?.density,
    dualSubTips: scaledDualConfig?.subTips,
    dualSubTipImages: scaledDualConfig?.subTipImages,
    dualSubTipOrder: scaledDualConfig?.subTipOrder,
    dualFlipH: scaledDualConfig?.flipH,
    dualFlipV: scaledDualConfig?.flipV,
    dualSpray: scaledDualConfig?.spray,
    dualIsRibbon: scaledDualConfig?.isRibbon,
    dualScale: options.dualScale ?? builtinCfg?.dualScale,
    dualSurfaceTextureId: options.dualSurfaceTextureId ?? builtinCfg?.dualSurfaceTextureId,
    dualGrainDepth: options.dualGrainDepth ?? builtinCfg?.dualGrainDepth,
    renderMode,
    bristle: bristleCfg
      ? { ...bristleCfg, count: Math.min(24, Math.max(8, bristleCfg.count)) }
      : undefined,
    naturalPaint: previewNatural,
    impasto: impastoCfg,
    useGpu: false, // Deterministic fast CPU rendering for thumbnails & preview cards
  };

  renderCompleteStroke(
    offCtx,
    previewPts,
    previewSettings,
    isEraser ? 'eraser' : 'brush',
    'color',
    false,
    offscreen
  );

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
