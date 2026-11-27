import {
  BristleSettings,
  BrushPresetId,
  BrushRenderMode,
  BrushSettings,
  CspBrush,
  BrushDynamics,
  CspAngleDynamicsMode,
  CspBlendTipsMode,
  CspBrushCombineMode,
  CspDualBrushConfig,
  CspPaperTextureMode,
  CspSensorConfig,
  CspSpraySettings,
  CspSubTipOrder,
  CspTaperSettings,
  CspTipFlipMode,
  GrainMappingMode,
  ImpastoSettings,
  NaturalMixingMode,
  NaturalPaintSettings,
  SurfaceTextureId,
} from '../types/editor';
import { getBuiltinBrushConfig } from './presetBrushes';
import { getPreloadedTipImage, getCachedCustomBrushes } from './brushStorage';
import { safeLocalStorageSetItem } from './safeStorage';

export const BRUSH_SIZE_PRESETS: number[] = [
  0.5, 0.7, 1, 1.5, 2, 2.5, 3,
  4, 5, 6, 7, 8, 10,
  12, 15, 17, 20, 25, 30,
  40, 50, 60, 70, 80, 100,
  120, 150, 170, 200, 250, 300,
  400, 500, 600, 700, 800, 1000,
  1200, 1500, 1700, 2000,
];

/**
 * Steps the given brush size down (-1) or up (+1) through BRUSH_SIZE_PRESETS cleanly.
 */
export function stepBrushSizePreset(currentSize: number, direction: -1 | 1): number {
  const eps = 0.04;
  if (direction > 0) {
    for (let i = 0; i < BRUSH_SIZE_PRESETS.length; i++) {
      if (BRUSH_SIZE_PRESETS[i] > currentSize + eps) {
        return BRUSH_SIZE_PRESETS[i];
      }
    }
    return BRUSH_SIZE_PRESETS[BRUSH_SIZE_PRESETS.length - 1];
  } else {
    for (let i = BRUSH_SIZE_PRESETS.length - 1; i >= 0; i--) {
      if (BRUSH_SIZE_PRESETS[i] < currentSize - eps) {
        return BRUSH_SIZE_PRESETS[i];
      }
    }
    return BRUSH_SIZE_PRESETS[0];
  }
}

export const STORAGE_KEY_SETTINGS = 'ink_studio_brush_settings_by_id';
export const STORAGE_KEY_ACTIVE_PRESET = 'ink_studio_active_brush_preset';
export const STORAGE_KEY_BOTTOM_TAB = 'ink_studio_left_bottom_tab';
const STORAGE_KEY_PRESET_SCHEMA = 'ink_studio_brush_preset_schema_v';
export const BUILTIN_PRESET_SCHEMA_VERSION = 4;
const SKETCH_PRESET_IDS = [
  'mechanical-pencil',
  'pencil-hb-2b',
  'pencil-6b-8b',
  'charcoal-pencil',
  'standard-chalk',
];
const CHALK_REWORK_PRESET_IDS = [
  'oil-painting',
  'thick-oil-painting',
  'chalk-painting',
  'blend-brush',
  'blend-chalk-brush',
];

/**
 * Maps legacy built-in brush preset IDs (removed/upgraded in schema v4)
 * to their direct modern equivalents so saved active presets and Quick Access
 * shortcuts migrate seamlessly.
 */
export const LEGACY_PRESET_ID_MAP: Readonly<Record<string, BrushPresetId>> = {
  'oil-painting': 'oil-flat-alla-prima',
  'thick-oil-painting': 'thick-oil-impasto',
  'chalk-painting': 'concept-matte-chalk',
  'blend-brush': 'blend-velvet-soft',
  'blend-chalk-brush': 'blend-matte-chalk',
  'soft-round': 'soft-glaze-airbrush',
  'noise-shader': 'atmospheric-grain-shader',
};

const V4_UPGRADED_PRESET_IDS = [
  // Upgraded CSP Pen presets
  'g-pen',
  'real-g-pen',
  'textured-pen',
  'rough-pen',
  // Legacy Brush/Blend IDs replaced in v4
  'oil-painting',
  'thick-oil-painting',
  'chalk-painting',
  'blend-brush',
  'blend-chalk-brush',
  'soft-round',
  'noise-shader',
  // New v4 Brush & Blend IDs (clear any stale cached entries on v3 -> v4 upgrade)
  'oil-flat-alla-prima',
  'thick-oil-impasto',
  'dry-bristle-rake-paint',
  'concept-matte-chalk',
  'silky-portrait-round',
  'canvas-scumble-oil',
  'soft-glaze-airbrush',
  'atmospheric-grain-shader',
  'fine-detail-filbert',
  'blend-velvet-soft',
  'blend-oil-bristle',
  'blend-matte-chalk',
  'blend-rake-hair',
  'blend-canvas-scumble',
  'blend-fingertip',
];

export function migrateLegacyPresetId(presetId: string): string {
  return LEGACY_PRESET_ID_MAP[presetId] ?? presetId;
}

export const ERASER_PRESET_ID = 'tool-eraser';
export const DEFAULT_BRUSH_PRESET_ID = 'g-pen';

export interface BrushPersistentSettings {
  size?: number;
  brushSizeUnit?: number;
  brushSizeSpecifiedByScreen?: boolean;
  minSizeFactor?: number;
  opacity?: number;
  flow?: number;
  brushDensity?: number;
  adjustDensityByGap?: boolean;
  blendTipsMode?: CspBlendTipsMode;
  brushCombineMode?: CspBrushCombineMode;
  spacing?: number;
  hardness?: number;
  grain?: number;
  stabilization?: number;
  postCorrection?: number;
  sharpCorners?: boolean;
  usePressure?: boolean;
  useVelocity?: boolean;
  useTilt?: boolean;
  tiltScale?: number;
  smoothing?: boolean;
  thickness?: number;
  thicknessVertical?: boolean;
  thicknessSensor?: CspSensorConfig;
  antiAlias?: number;
  flipH?: CspTipFlipMode;
  flipV?: CspTipFlipMode;
  subTipOrder?: CspSubTipOrder;
  isRibbon?: boolean;
  isDualToneTip?: boolean;
  customTipAngle?: number;
  customTipAngleDynamics?: CspAngleDynamicsMode;
  customTipRotationRandomScale?: number;
  colorMixing?: boolean;
  perceptualMixing?: boolean;
  amountOfPaint?: number;
  densityOfPaint?: number;
  colorStretch?: number;
  amountOfPaintSensor?: CspSensorConfig;
  densityOfPaintSensor?: CspSensorConfig;
  colorStretchSensor?: CspSensorConfig;
  mixGroundColor?: boolean;
  useBlur?: boolean;
  blurStrength?: number;
  mixingMode?: NaturalMixingMode;
  wetEdge?: number;
  wetEdgeRadius?: number;
  wetEdgeAlphaPower?: number;
  wetEdgeValuePower?: number;
  textureDensity?: number;
  surfaceTextureId?: SurfaceTextureId;
  grainMappingMode?: GrainMappingMode;
  paperTextureScale?: number;
  paperTextureRotate?: number;
  paperTextureOffsetX?: number;
  paperTextureOffsetY?: number;
  paperTextureMode?: CspPaperTextureMode;
  paperTextureBrightness?: number;
  paperTextureContrast?: number;
  paperTextureApplyEachPlot?: boolean;
  paperTextureEmphasizeDensity?: boolean;
  paperTextureInverted?: boolean;
  pressureCurve?: [number, number][];
  velocityCurve?: [number, number][];
  sizeSensor?: CspSensorConfig;
  opacitySensor?: CspSensorConfig;
  densitySensor?: CspSensorConfig;
  intervalSensor?: CspSensorConfig;
  textureDensitySensor?: CspSensorConfig;
  bristleSplaySensor?: CspSensorConfig;
  paintLoadSensor?: CspSensorConfig;
  grainPenetrationSensor?: CspSensorConfig;
  angleSensor?: CspSensorConfig;
  scatterSensor?: CspSensorConfig;
  spray?: CspSpraySettings;
  taper?: CspTaperSettings;
  dynamics?: BrushDynamics;
  dualBrush?: boolean;
  dualBrushConfig?: CspDualBrushConfig;
  dualBrushCompositeMode?: string;
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
}

export const NEUTRAL_BRUSH_DEFAULTS: Partial<BrushSettings> = {
  brushSizeUnit: undefined,
  brushSizeSpecifiedByScreen: undefined,
  brushDensity: undefined,
  adjustDensityByGap: false,
  blendTipsMode: 'darken',
  brushCombineMode: undefined,
  useTilt: false,
  tiltScale: 1.0,
  useVelocity: false,
  velocityDynamics: false,
  postCorrection: 0,
  sharpCorners: true,
  thickness: 1.0,
  thicknessVertical: false,
  thicknessSensor: undefined,
  flipH: 'none',
  flipV: 'none',
  antiAlias: 2,
  grain: 0,
  textureDensity: 0,
  sizeSensor: undefined,
  opacitySensor: undefined,
  densitySensor: undefined,
  intervalSensor: undefined,
  textureDensitySensor: undefined,
  bristleSplaySensor: undefined,
  paintLoadSensor: undefined,
  grainPenetrationSensor: undefined,
  angleSensor: undefined,
  scatterSensor: undefined,
  customTipDataUrl: undefined,
  customTipImage: undefined,
  customTipAngle: 0,
  customTipAngleDynamics: 'none',
  customTipRotationRandomScale: 0,
  isColorTip: false,
  isDualToneTip: false,
  subTips: undefined,
  subTipOrder: undefined,
  subTipImages: undefined,
  pressureCurve: undefined,
  velocityCurve: undefined,
  pressureCurveGamma: 1.0,
  spray: undefined,
  taper: undefined,
  isRibbon: false,
  colorMixing: false,
  perceptualMixing: true,
  amountOfPaint: 0.7,
  densityOfPaint: 0.8,
  colorStretch: 0.6,
  amountOfPaintSensor: undefined,
  densityOfPaintSensor: undefined,
  colorStretchSensor: undefined,
  mixGroundColor: false,
  useBlur: false,
  blurStrength: undefined,
  mixingMode: 'blend',
  wetEdge: 0,
  wetEdgeRadius: undefined,
  wetEdgeAlphaPower: undefined,
  wetEdgeValuePower: undefined,
  paperTexture: undefined,
  paperTextureImage: undefined,
  surfaceTextureId: undefined,
  grainMappingMode: 'canvas-locked',
  paperTextureMode: 'subtract',
  paperTextureBrightness: 0,
  paperTextureContrast: 0,
  paperTextureApplyEachPlot: undefined,
  paperTextureEmphasizeDensity: false,
  paperTextureInverted: false,
  paperTextureScale: 1.0,
  paperTextureRotate: 0,
  paperTextureOffsetX: 0,
  paperTextureOffsetY: 0,
  dualBrush: false,
  dualBrushConfig: undefined,
  dualBrushCompositeMode: 'multiply',
  dualSize: undefined,
  dualLinkSize: undefined,
  dualSpacing: undefined,
  dualScatter: 0,
  dualThickness: undefined,
  dualThicknessVertical: undefined,
  dualAngle: 0,
  dualAngleDynamics: undefined,
  dualAngleSensor: undefined,
  dualHardness: undefined,
  dualDensity: undefined,
  dualSubTips: undefined,
  dualSubTipImages: undefined,
  dualSubTipOrder: undefined,
  dualFlipH: undefined,
  dualFlipV: undefined,
  dualSpray: undefined,
  dualIsRibbon: undefined,
  dualScale: 1.0,
  dualSurfaceTextureId: undefined,
  dualGrainDepth: 0,
  dualTipDataUrl: undefined,
  dualTipImage: undefined,
  dynamics: undefined,
  renderMode: 'stamp',
  bristle: undefined,
  naturalPaint: undefined,
  impasto: undefined,
  importWarnings: undefined,
  useGpu: true,
};

export const DEFAULT_ERASER_SETTINGS: Partial<BrushSettings> = {
  ...NEUTRAL_BRUSH_DEFAULTS,
  preset: ERASER_PRESET_ID,
  brushName: 'Eraser',
  size: 30,
  minSizeFactor: 0.5,
  opacity: 1.0,
  flow: 1.0,
  spacing: 0.05,
  hardness: 0.9,
  antiAlias: 2,
  stabilization: 4,
  sharpCorners: true,
  usePressure: true,
  useTilt: false,
  smoothing: true,
  useGpu: true,
};

let _memorySettingsCache: Record<string, BrushPersistentSettings> | null = null;
let _saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Clears the in-memory settings cache so subsequent reads re-load from localStorage.
 * Primarily used by schema-migration tests.
 */
export function resetBrushSettingsCache(): void {
  if (_saveDebounceTimer) {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = null;
  }
  _memorySettingsCache = null;
}

export function loadAllSavedBrushSettings(): Record<string, BrushPersistentSettings> {
  if (_memorySettingsCache) return _memorySettingsCache;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY_SETTINGS) : null;
    const parsed: Record<string, BrushPersistentSettings> = raw ? JSON.parse(raw) : {};
    if (typeof localStorage !== 'undefined') {
      const storedVer = Number(localStorage.getItem(STORAGE_KEY_PRESET_SCHEMA) || '0');
      if (storedVer < BUILTIN_PRESET_SCHEMA_VERSION) {
        let mutated = false;
        if (storedVer < 2) {
          for (const id of SKETCH_PRESET_IDS) {
            if (parsed[id]) {
              delete parsed[id];
              mutated = true;
            }
          }
        }
        if (storedVer < 3) {
          for (const id of CHALK_REWORK_PRESET_IDS) {
            if (parsed[id]) {
              delete parsed[id];
              mutated = true;
            }
          }
        }
        if (storedVer < 4) {
          for (const id of V4_UPGRADED_PRESET_IDS) {
            if (parsed[id]) {
              delete parsed[id];
              mutated = true;
            }
          }
        }
        if (mutated) {
          safeLocalStorageSetItem(STORAGE_KEY_SETTINGS, JSON.stringify(parsed), 'brush settings');
        }
        safeLocalStorageSetItem(STORAGE_KEY_PRESET_SCHEMA, String(BUILTIN_PRESET_SCHEMA_VERSION), 'brush settings');
      }
    }
    _memorySettingsCache = parsed;
  } catch {
    _memorySettingsCache = {};
  }
  return _memorySettingsCache || {};
}

export function getSavedBrushSettings(presetId: string): BrushPersistentSettings | null {
  const all = loadAllSavedBrushSettings();
  return all[presetId] || null;
}

const PERSISTENT_KEYS: (keyof BrushPersistentSettings)[] = [
  'size',
  'brushSizeUnit',
  'brushSizeSpecifiedByScreen',
  'minSizeFactor',
  'opacity',
  'flow',
  'brushDensity',
  'adjustDensityByGap',
  'blendTipsMode',
  'brushCombineMode',
  'spacing',
  'hardness',
  'grain',
  'stabilization',
  'postCorrection',
  'sharpCorners',
  'usePressure',
  'useVelocity',
  'useTilt',
  'tiltScale',
  'smoothing',
  'thickness',
  'thicknessVertical',
  'thicknessSensor',
  'antiAlias',
  'flipH',
  'flipV',
  'subTipOrder',
  'isRibbon',
  'isDualToneTip',
  'customTipAngle',
  'customTipAngleDynamics',
  'customTipRotationRandomScale',
  'colorMixing',
  'perceptualMixing',
  'amountOfPaint',
  'densityOfPaint',
  'colorStretch',
  'amountOfPaintSensor',
  'densityOfPaintSensor',
  'colorStretchSensor',
  'mixGroundColor',
  'useBlur',
  'blurStrength',
  'mixingMode',
  'wetEdge',
  'wetEdgeRadius',
  'wetEdgeAlphaPower',
  'wetEdgeValuePower',
  'textureDensity',
  'surfaceTextureId',
  'grainMappingMode',
  'paperTextureScale',
  'paperTextureRotate',
  'paperTextureOffsetX',
  'paperTextureOffsetY',
  'paperTextureMode',
  'paperTextureBrightness',
  'paperTextureContrast',
  'paperTextureApplyEachPlot',
  'paperTextureEmphasizeDensity',
  'paperTextureInverted',
  'pressureCurve',
  'velocityCurve',
  'sizeSensor',
  'opacitySensor',
  'densitySensor',
  'intervalSensor',
  'textureDensitySensor',
  'bristleSplaySensor',
  'paintLoadSensor',
  'grainPenetrationSensor',
  'angleSensor',
  'scatterSensor',
  'spray',
  'taper',
  'dynamics',
  'dualBrush',
  'dualBrushConfig',
  'dualBrushCompositeMode',
  'dualSize',
  'dualLinkSize',
  'dualSpacing',
  'dualScatter',
  'dualThickness',
  'dualThicknessVertical',
  'dualAngle',
  'dualAngleDynamics',
  'dualAngleSensor',
  'dualHardness',
  'dualDensity',
  'dualSubTipOrder',
  'dualFlipH',
  'dualFlipV',
  'dualSpray',
  'dualIsRibbon',
  'dualScale',
  'dualSurfaceTextureId',
  'dualGrainDepth',
  'renderMode',
  'bristle',
  'naturalPaint',
  'impasto',
];

function sanitizeDualBrushConfigForPresetStorage(
  cfg: CspDualBrushConfig
): CspDualBrushConfig {
  const {
    tipImage: _tipImg,
    subTipImages: _subImgs,
    tipDataUrl: _tipUrl,
    subTips: _subTips,
    ...lightweight
  } = cfg;
  return lightweight;
}

function mergeIntoMemoryCache(presetId: string, settings: Partial<BrushSettings>): Record<string, BrushPersistentSettings> {
  const all = loadAllSavedBrushSettings();
  const persistent: BrushPersistentSettings = { ...(all[presetId] || {}) };

  for (let i = 0; i < PERSISTENT_KEYS.length; i++) {
    const key = PERSISTENT_KEYS[i];
    const val = settings[key];
    if (val !== undefined) {
      if (key === 'dualBrushConfig' && val && typeof val === 'object') {
        persistent.dualBrushConfig = sanitizeDualBrushConfigForPresetStorage(
          val as CspDualBrushConfig
        );
      } else {
        (persistent as Record<string, unknown>)[key] = val;
      }
    }
  }

  all[presetId] = persistent;
  _memorySettingsCache = all;
  return all;
}

function flushMemoryCacheToStorage(): void {
  if (!_memorySettingsCache) return;
  safeLocalStorageSetItem(STORAGE_KEY_SETTINGS, JSON.stringify(_memorySettingsCache), 'brush settings');
}

export function saveBrushSettingsImmediately(
  presetId: string,
  settings: Partial<BrushSettings>
): void {
  if (!presetId) return;
  if (_saveDebounceTimer) {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = null;
  }
  mergeIntoMemoryCache(presetId, settings);
  flushMemoryCacheToStorage();
}

/**
 * Updates in-memory brush settings synchronously for zero-lag reads while debouncing
 * localStorage JSON serialization by 250ms during continuous slider drags.
 */
export function saveBrushSettingsDebounced(
  presetId: string,
  settings: Partial<BrushSettings>,
  delayMs: number = 250
): void {
  if (!presetId) return;
  mergeIntoMemoryCache(presetId, settings);
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(() => {
    _saveDebounceTimer = null;
    flushMemoryCacheToStorage();
  }, delayMs);
}

export function flushPendingBrushSettingsSave(): void {
  if (_saveDebounceTimer) {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = null;
    flushMemoryCacheToStorage();
  }
}

export function resetBrushSettingsToDefault(
  presetId: string,
  customBrushes?: CspBrush[]
): Partial<BrushSettings> {
  const all = loadAllSavedBrushSettings();
  if (all[presetId]) {
    delete all[presetId];
    _memorySettingsCache = all;
    flushMemoryCacheToStorage();
  }
  return getEffectiveBrushSettings(presetId, customBrushes);
}

export function getActivePresetId(): string {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_BRUSH_PRESET_ID;
    const saved = localStorage.getItem(STORAGE_KEY_ACTIVE_PRESET);
    if (!saved) return DEFAULT_BRUSH_PRESET_ID;
    const migrated = migrateLegacyPresetId(saved);
    if (migrated !== saved && getBuiltinBrushConfig(migrated)) {
      safeLocalStorageSetItem(STORAGE_KEY_ACTIVE_PRESET, migrated, 'active brush preset');
      return migrated;
    }
    if (saved.startsWith('csp-') || saved.startsWith('inkb-') || getBuiltinBrushConfig(saved)) return saved;
    return DEFAULT_BRUSH_PRESET_ID;
  } catch {
    return DEFAULT_BRUSH_PRESET_ID;
  }
}

export function saveActivePresetId(presetId: string): void {
  if (!presetId || presetId === ERASER_PRESET_ID || presetId === 'eraser') return;
  safeLocalStorageSetItem(STORAGE_KEY_ACTIVE_PRESET, presetId, 'active brush preset');
}

export function getEffectiveBrushSettings(
  presetId: string,
  customBrushes?: CspBrush[]
): Partial<BrushSettings> {
  const resolvedPresetId = migrateLegacyPresetId(presetId);
  const saved = getSavedBrushSettings(resolvedPresetId);

  // 1. Eraser
  if (resolvedPresetId === ERASER_PRESET_ID || resolvedPresetId === 'eraser') {
    return {
      ...DEFAULT_ERASER_SETTINGS,
      preset: ERASER_PRESET_ID,
      ...saved,
    };
  }

  // 2. Custom CSP brush (consults explicit array or global in-memory custom brush registry)
  const effectiveCustomList =
    customBrushes && customBrushes.length > 0 ? customBrushes : getCachedCustomBrushes();

  if (effectiveCustomList.length > 0) {
    const cspMatch = effectiveCustomList.find((b) => b.id === presetId);
    if (cspMatch) {
      const tipImg = cspMatch.tipDataUrl
        ? getPreloadedTipImage(cspMatch.tipDataUrl) || undefined
        : undefined;
      const dualTipUrl = cspMatch.secondaryTipDataUrl || cspMatch.dualBrushConfig?.tipDataUrl;
      const dualTipImg = dualTipUrl
        ? getPreloadedTipImage(dualTipUrl) || undefined
        : undefined;
      const paperTextureImage = cspMatch.paperTexture
        ? getPreloadedTipImage(cspMatch.paperTexture) || undefined
        : undefined;
      let subTipImages: HTMLImageElement[] | undefined = undefined;
      if (cspMatch.subTips && cspMatch.subTips.length > 0) {
        const imgs: HTMLImageElement[] = [];
        for (const st of cspMatch.subTips) {
          const im = getPreloadedTipImage(st.dataUrl);
          if (im) imgs.push(im);
        }
        if (imgs.length > 0) subTipImages = imgs;
      }
      const resolvedDualSubTips = cspMatch.dualSubTips || cspMatch.dualBrushConfig?.subTips;
      let dualSubTipImages: HTMLImageElement[] | undefined = undefined;
      if (resolvedDualSubTips && resolvedDualSubTips.length > 0) {
        const imgs: HTMLImageElement[] = [];
        for (const dst of resolvedDualSubTips) {
          const im = getPreloadedTipImage(dst.dataUrl);
          if (im) imgs.push(im);
        }
        if (imgs.length > 0) dualSubTipImages = imgs;
      }

      const baseDualBrushConfig = cspMatch.dualBrushConfig
        ? {
            ...cspMatch.dualBrushConfig,
            tipImage: dualTipImg ?? cspMatch.dualBrushConfig.tipImage,
            subTipImages: dualSubTipImages ?? cspMatch.dualBrushConfig.subTipImages,
          }
        : undefined;
      const mergedDualBrushConfig = saved?.dualBrushConfig
        ? {
            ...baseDualBrushConfig,
            ...saved.dualBrushConfig,
            tipDataUrl: saved.dualBrushConfig.tipDataUrl ?? baseDualBrushConfig?.tipDataUrl,
            tipImage: baseDualBrushConfig?.tipImage,
            subTips: saved.dualBrushConfig.subTips ?? baseDualBrushConfig?.subTips,
            subTipImages: baseDualBrushConfig?.subTipImages,
          }
        : baseDualBrushConfig;

      return {
        ...NEUTRAL_BRUSH_DEFAULTS,
        preset: cspMatch.id,
        brushName: cspMatch.name,
        size: cspMatch.size,
        brushSizeUnit: cspMatch.brushSizeUnit,
        brushSizeSpecifiedByScreen: cspMatch.brushSizeSpecifiedByScreen,
        minSizeFactor: cspMatch.minSizeFactor,
        flow: cspMatch.flow,
        brushDensity: cspMatch.brushDensity,
        adjustDensityByGap: cspMatch.adjustDensityByGap,
        blendTipsMode: cspMatch.blendTipsMode,
        brushCombineMode: cspMatch.brushCombineMode,
        opacity: cspMatch.opacity,
        spacing: cspMatch.spacing,
        hardness: cspMatch.hardness,
        thickness: cspMatch.thickness,
        thicknessVertical: cspMatch.thicknessVertical,
        thicknessSensor: cspMatch.thicknessSensor,
        antiAlias: cspMatch.antiAlias,
        stabilization: cspMatch.stabilization,
        postCorrection: cspMatch.postCorrection,
        sharpCorners: cspMatch.sharpCorners ?? true,
        customTipDataUrl: cspMatch.tipDataUrl,
        customTipImage: tipImg,
        isColorTip: cspMatch.isColorTip,
        isDualToneTip: cspMatch.isDualToneTip,
        flipH: cspMatch.flipH,
        flipV: cspMatch.flipV,
        customTipAngle: cspMatch.angle,
        customTipAngleDynamics: cspMatch.angleDynamics,
        customTipRotationRandomScale: cspMatch.rotationRandomScale,
        subTips: cspMatch.subTips,
        subTipOrder: cspMatch.subTipOrder,
        subTipImages,
        pressureCurve: cspMatch.pressureCurve,
        velocityCurve: cspMatch.velocityCurve,
        usePressure: cspMatch.usePressure,
        useVelocity: cspMatch.useVelocity,
        useTilt: cspMatch.useTilt ?? false,
        tiltScale: cspMatch.tiltScale,
        sizeSensor: cspMatch.sizeSensor,
        opacitySensor: cspMatch.opacitySensor,
        densitySensor: cspMatch.densitySensor,
        intervalSensor: cspMatch.intervalSensor,
        textureDensitySensor: cspMatch.textureDensitySensor,
        bristleSplaySensor: cspMatch.bristleSplaySensor,
        paintLoadSensor: cspMatch.paintLoadSensor,
        grainPenetrationSensor: cspMatch.grainPenetrationSensor,
        angleSensor: cspMatch.angleSensor,
        scatterSensor: cspMatch.scatterSensor,
        smoothing: cspMatch.smoothing ?? true,
        spray: cspMatch.spray,
        taper: cspMatch.taper,
        isRibbon: cspMatch.isRibbon,
        colorMixing: cspMatch.colorMixing,
        perceptualMixing: cspMatch.perceptualMixing ?? true,
        amountOfPaint: cspMatch.amountOfPaint ?? 0.7,
        densityOfPaint: cspMatch.densityOfPaint ?? 0.8,
        colorStretch: cspMatch.colorStretch ?? 0.6,
        amountOfPaintSensor: cspMatch.amountOfPaintSensor,
        densityOfPaintSensor: cspMatch.densityOfPaintSensor,
        colorStretchSensor: cspMatch.colorStretchSensor,
        mixGroundColor: cspMatch.mixGroundColor,
        useBlur: cspMatch.useBlur,
        blurStrength: cspMatch.blurStrength,
        mixingMode: cspMatch.mixingMode ?? 'blend',
        wetEdge: cspMatch.wetEdge ?? 0,
        wetEdgeRadius: cspMatch.wetEdgeRadius,
        wetEdgeAlphaPower: cspMatch.wetEdgeAlphaPower,
        wetEdgeValuePower: cspMatch.wetEdgeValuePower,
        grain: cspMatch.textureDensity ?? 0,
        textureDensity: cspMatch.textureDensity,
        paperTexture: cspMatch.paperTexture,
        paperTextureImage,
        surfaceTextureId: cspMatch.surfaceTextureId,
        grainMappingMode: cspMatch.grainMappingMode,
        paperTextureScale: cspMatch.paperTextureScale,
        paperTextureRotate: cspMatch.paperTextureRotate,
        paperTextureOffsetX: cspMatch.paperTextureOffsetX,
        paperTextureOffsetY: cspMatch.paperTextureOffsetY,
        paperTextureMode: cspMatch.paperTextureMode,
        paperTextureBrightness: cspMatch.paperTextureBrightness,
        paperTextureContrast: cspMatch.paperTextureContrast,
        paperTextureApplyEachPlot: cspMatch.paperTextureApplyEachPlot,
        paperTextureEmphasizeDensity: cspMatch.paperTextureEmphasizeDensity,
        paperTextureInverted: cspMatch.paperTextureInverted,
        dualBrush: cspMatch.dualBrush,
        dualBrushConfig: baseDualBrushConfig,
        dualTipDataUrl: dualTipUrl,
        dualTipImage: dualTipImg,
        dualBrushCompositeMode: (cspMatch.dualBrushCompositeMode as BrushSettings['dualBrushCompositeMode']) || 'multiply',
        dualSize: cspMatch.dualSize,
        dualLinkSize: cspMatch.dualLinkSize,
        dualSpacing: cspMatch.dualSpacing,
        dualScatter: cspMatch.dualScatter,
        dualThickness: cspMatch.dualThickness,
        dualThicknessVertical: cspMatch.dualThicknessVertical,
        dualAngle: cspMatch.dualAngle,
        dualAngleDynamics: cspMatch.dualAngleDynamics,
        dualAngleSensor: cspMatch.dualAngleSensor,
        dualHardness: cspMatch.dualHardness,
        dualDensity: cspMatch.dualDensity,
        dualSubTips: resolvedDualSubTips,
        dualSubTipImages,
        dualSubTipOrder: cspMatch.dualSubTipOrder,
        dualFlipH: cspMatch.dualFlipH,
        dualFlipV: cspMatch.dualFlipV,
        dualSpray: cspMatch.dualSpray,
        dualIsRibbon: cspMatch.dualIsRibbon,
        dualScale: cspMatch.dualScale,
        dualSurfaceTextureId: cspMatch.dualSurfaceTextureId,
        dualGrainDepth: cspMatch.dualGrainDepth,
        dynamics: cspMatch.dynamics,
        renderMode: cspMatch.renderMode,
        bristle: cspMatch.bristle,
        naturalPaint: cspMatch.naturalPaint,
        impasto: cspMatch.impasto,
        importWarnings: cspMatch.importWarnings,
        useGpu: true,
        ...saved,
        ...(mergedDualBrushConfig ? { dualBrushConfig: mergedDualBrushConfig } : {}),
      };
    }
  }

  // 3. Builtin brush
  const builtinCfg = getBuiltinBrushConfig(resolvedPresetId as BrushPresetId);
  if (builtinCfg) {
    const mergedDualBrushConfig = saved?.dualBrushConfig
      ? {
          ...builtinCfg.dualBrushConfig,
          ...saved.dualBrushConfig,
          tipDataUrl: saved.dualBrushConfig.tipDataUrl ?? builtinCfg.dualBrushConfig?.tipDataUrl,
          tipImage: builtinCfg.dualBrushConfig?.tipImage,
          subTips: saved.dualBrushConfig.subTips ?? builtinCfg.dualBrushConfig?.subTips,
          subTipImages: builtinCfg.dualBrushConfig?.subTipImages,
        }
      : builtinCfg.dualBrushConfig;
    return {
      ...NEUTRAL_BRUSH_DEFAULTS,
      preset: resolvedPresetId,
      ...builtinCfg,
      ...saved,
      ...(mergedDualBrushConfig ? { dualBrushConfig: mergedDualBrushConfig } : {}),
    };
  }

  // 4. Default fallback (g-pen)
  const defaultCfg = getBuiltinBrushConfig(DEFAULT_BRUSH_PRESET_ID);
  const defaultSaved = getSavedBrushSettings(DEFAULT_BRUSH_PRESET_ID);
  return {
    ...NEUTRAL_BRUSH_DEFAULTS,
    preset: DEFAULT_BRUSH_PRESET_ID,
    brushName: 'G-Pen',
    size: 12,
    minSizeFactor: 0.03,
    flow: 1.0,
    opacity: 1.0,
    hardness: 1.0,
    spacing: 0.05,
    stabilization: 10,
    usePressure: true,
    smoothing: true,
    useGpu: true,
    ...defaultCfg,
    ...defaultSaved,
  };
}
