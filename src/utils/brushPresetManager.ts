import {
  BrushPresetId,
  BrushSettings,
  CspBrush,
  BrushDynamics,
  CspAngleDynamicsMode,
  CspBlendTipsMode,
  CspPaperTextureMode,
  CspSensorConfig,
  CspSpraySettings,
  CspTaperSettings,
  CspTipFlipMode,
} from '../types/editor';
import { getBuiltinBrushConfig } from './presetBrushes';
import { getPreloadedTipImage, getCachedCustomBrushes } from './brushStorage';

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

export const STORAGE_KEY_SETTINGS = 'sora_paint_brush_settings_by_id';
export const STORAGE_KEY_ACTIVE_PRESET = 'sora_paint_active_brush_preset';
export const STORAGE_KEY_BOTTOM_TAB = 'sora_paint_left_bottom_tab';
const STORAGE_KEY_PRESET_SCHEMA = 'sora_paint_brush_preset_schema_v';
const BUILTIN_PRESET_SCHEMA_VERSION = 2;
const SKETCH_PRESET_IDS = [
  'mechanical-pencil',
  'pencil-hb-2b',
  'pencil-6b-8b',
  'charcoal-pencil',
  'standard-chalk',
];
export const ERASER_PRESET_ID = 'tool-eraser';
export const DEFAULT_BRUSH_PRESET_ID = 'g-pen';

export interface BrushPersistentSettings {
  size?: number;
  minSizeFactor?: number;
  opacity?: number;
  flow?: number;
  brushDensity?: number;
  adjustDensityByGap?: boolean;
  blendTipsMode?: CspBlendTipsMode;
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
  antiAlias?: number;
  flipH?: CspTipFlipMode;
  flipV?: CspTipFlipMode;
  isRibbon?: boolean;
  customTipAngle?: number;
  customTipAngleDynamics?: CspAngleDynamicsMode;
  customTipRotationRandomScale?: number;
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
  textureDensity?: number;
  paperTextureScale?: number;
  paperTextureRotate?: number;
  paperTextureMode?: CspPaperTextureMode;
  paperTextureBrightness?: number;
  paperTextureContrast?: number;
  paperTextureInverted?: boolean;
  pressureCurve?: [number, number][];
  velocityCurve?: [number, number][];
  sizeSensor?: CspSensorConfig;
  opacitySensor?: CspSensorConfig;
  densitySensor?: CspSensorConfig;
  spray?: CspSpraySettings;
  taper?: CspTaperSettings;
  dynamics?: BrushDynamics;
}

export const NEUTRAL_BRUSH_DEFAULTS: Partial<BrushSettings> = {
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
  flipH: 'none',
  flipV: 'none',
  antiAlias: 2,
  grain: 0,
  textureDensity: 0,
  sizeSensor: undefined,
  opacitySensor: undefined,
  densitySensor: undefined,
  customTipDataUrl: undefined,
  customTipImage: undefined,
  customTipAngle: 0,
  customTipAngleDynamics: 'none',
  customTipRotationRandomScale: 0,
  isColorTip: false,
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
  mixingMode: 'blend',
  wetEdge: 0,
  wetEdgeRadius: undefined,
  wetEdgeAlphaPower: undefined,
  wetEdgeValuePower: undefined,
  paperTexture: undefined,
  paperTextureImage: undefined,
  paperTextureMode: 'subtract',
  paperTextureBrightness: 0,
  paperTextureContrast: 0,
  paperTextureApplyEachPlot: false,
  paperTextureInverted: false,
  paperTextureScale: 1.0,
  paperTextureRotate: 0,
  dualBrush: false,
  dualBrushCompositeMode: 'multiply',
  dualSize: undefined,
  dualSpacing: undefined,
  dualTipDataUrl: undefined,
  dualTipImage: undefined,
  dynamics: undefined,
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

export function loadAllSavedBrushSettings(): Record<string, BrushPersistentSettings> {
  if (_memorySettingsCache) return _memorySettingsCache;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY_SETTINGS) : null;
    const parsed: Record<string, BrushPersistentSettings> = raw ? JSON.parse(raw) : {};
    if (typeof localStorage !== 'undefined') {
      const storedVer = Number(localStorage.getItem(STORAGE_KEY_PRESET_SCHEMA) || '0');
      if (storedVer < BUILTIN_PRESET_SCHEMA_VERSION) {
        let mutated = false;
        for (const id of SKETCH_PRESET_IDS) {
          if (parsed[id]) {
            delete parsed[id];
            mutated = true;
          }
        }
        if (mutated) {
          localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(parsed));
        }
        localStorage.setItem(STORAGE_KEY_PRESET_SCHEMA, String(BUILTIN_PRESET_SCHEMA_VERSION));
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
  'minSizeFactor',
  'opacity',
  'flow',
  'brushDensity',
  'adjustDensityByGap',
  'blendTipsMode',
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
  'antiAlias',
  'flipH',
  'flipV',
  'isRibbon',
  'customTipAngle',
  'customTipAngleDynamics',
  'customTipRotationRandomScale',
  'colorMixing',
  'perceptualMixing',
  'amountOfPaint',
  'densityOfPaint',
  'colorStretch',
  'mixingMode',
  'wetEdge',
  'wetEdgeRadius',
  'wetEdgeAlphaPower',
  'wetEdgeValuePower',
  'textureDensity',
  'paperTextureScale',
  'paperTextureRotate',
  'paperTextureMode',
  'paperTextureBrightness',
  'paperTextureContrast',
  'paperTextureInverted',
  'pressureCurve',
  'velocityCurve',
  'sizeSensor',
  'opacitySensor',
  'densitySensor',
  'spray',
  'taper',
  'dynamics',
];

function mergeIntoMemoryCache(presetId: string, settings: Partial<BrushSettings>): Record<string, BrushPersistentSettings> {
  const all = loadAllSavedBrushSettings();
  const persistent: BrushPersistentSettings = { ...(all[presetId] || {}) };

  for (let i = 0; i < PERSISTENT_KEYS.length; i++) {
    const key = PERSISTENT_KEYS[i];
    const val = settings[key];
    if (val !== undefined) {
      (persistent as Record<string, unknown>)[key] = val;
    }
  }

  all[presetId] = persistent;
  _memorySettingsCache = all;
  return all;
}

function flushMemoryCacheToStorage(): void {
  if (!_memorySettingsCache) return;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(_memorySettingsCache));
    }
  } catch (err) {
    console.warn('Failed to persist brush settings to localStorage:', err);
  }
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
    if (saved.startsWith('csp-') || getBuiltinBrushConfig(saved)) return saved;
    return DEFAULT_BRUSH_PRESET_ID;
  } catch {
    return DEFAULT_BRUSH_PRESET_ID;
  }
}

export function saveActivePresetId(presetId: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY_ACTIVE_PRESET, presetId);
    }
  } catch {
    // ignore
  }
}

export function getEffectiveBrushSettings(
  presetId: string,
  customBrushes?: CspBrush[]
): Partial<BrushSettings> {
  const saved = getSavedBrushSettings(presetId);

  // 1. Eraser
  if (presetId === ERASER_PRESET_ID || presetId === 'eraser') {
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
      const dualTipImg = cspMatch.secondaryTipDataUrl
        ? getPreloadedTipImage(cspMatch.secondaryTipDataUrl) || undefined
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

      return {
        ...NEUTRAL_BRUSH_DEFAULTS,
        preset: cspMatch.id,
        brushName: cspMatch.name,
        size: cspMatch.size,
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
        antiAlias: cspMatch.antiAlias,
        stabilization: cspMatch.stabilization,
        postCorrection: cspMatch.postCorrection,
        sharpCorners: cspMatch.sharpCorners ?? true,
        customTipDataUrl: cspMatch.tipDataUrl,
        customTipImage: tipImg,
        isColorTip: cspMatch.isColorTip,
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
        smoothing: cspMatch.smoothing ?? true,
        spray: cspMatch.spray,
        taper: cspMatch.taper,
        isRibbon: cspMatch.isRibbon,
        colorMixing: cspMatch.colorMixing,
        perceptualMixing: true,
        amountOfPaint: cspMatch.amountOfPaint ?? 0.7,
        densityOfPaint: cspMatch.densityOfPaint ?? 0.8,
        colorStretch: cspMatch.colorStretch ?? 0.6,
        mixingMode: cspMatch.mixingMode ?? 'blend',
        wetEdge: cspMatch.wetEdge ?? 0,
        wetEdgeRadius: cspMatch.wetEdgeRadius,
        wetEdgeAlphaPower: cspMatch.wetEdgeAlphaPower,
        wetEdgeValuePower: cspMatch.wetEdgeValuePower,
        grain: cspMatch.textureDensity ?? 0,
        textureDensity: cspMatch.textureDensity,
        paperTexture: cspMatch.paperTexture,
        paperTextureImage,
        paperTextureScale: cspMatch.paperTextureScale,
        paperTextureRotate: cspMatch.paperTextureRotate,
        paperTextureMode: cspMatch.paperTextureMode,
        paperTextureBrightness: cspMatch.paperTextureBrightness,
        paperTextureContrast: cspMatch.paperTextureContrast,
        paperTextureApplyEachPlot: cspMatch.paperTextureApplyEachPlot,
        paperTextureInverted: cspMatch.paperTextureInverted,
        dualBrush: cspMatch.dualBrush,
        dualTipImage: dualTipImg,
        dualBrushCompositeMode: (cspMatch.dualBrushCompositeMode as BrushSettings['dualBrushCompositeMode']) || 'multiply',
        dualSize: cspMatch.dualSize,
        dualSpacing: cspMatch.dualSpacing,
        useGpu: true,
        ...saved,
      };
    }
  }

  // 3. Builtin brush
  const builtinCfg = getBuiltinBrushConfig(presetId as BrushPresetId);
  if (builtinCfg) {
    return {
      ...NEUTRAL_BRUSH_DEFAULTS,
      preset: presetId,
      ...builtinCfg,
      ...saved,
    };
  }

  // 4. Default fallback (g-pen)
  const defaultCfg = getBuiltinBrushConfig(DEFAULT_BRUSH_PRESET_ID);
  const defaultSaved = getSavedBrushSettings(DEFAULT_BRUSH_PRESET_ID);
  return {
    ...NEUTRAL_BRUSH_DEFAULTS,
    preset: DEFAULT_BRUSH_PRESET_ID,
    brushName: 'G-Pen',
    size: 8,
    minSizeFactor: 0.04,
    flow: 1.0,
    opacity: 1.0,
    hardness: 1.0,
    spacing: 0.04,
    stabilization: 20,
    usePressure: true,
    smoothing: true,
    useGpu: true,
    ...defaultCfg,
    ...defaultSaved,
  };
}
