import { BrushPresetId, BrushSettings, CspBrush } from '../types/editor';
import { getBuiltinBrushConfig } from './presetBrushes';
import { PENCIL_CONFIGS, PencilGrade } from './pencilEngine';
import { getPreloadedTipImage } from './brushStorage';

export const BRUSH_SIZE_PRESETS: number[] = [
  0.7, 1, 1.5, 2, 2.5, 3,
  4, 5, 6, 7, 8, 10,
  12, 15, 17, 20, 25, 30,
  40, 50, 60, 70, 80, 100,
  120, 150, 170, 200, 250, 300,
  400, 500, 600, 700, 800, 1000,
  1200, 1500, 1700, 2000,
];

export const STORAGE_KEY_SETTINGS = 'sora_paint_brush_settings_by_id';
export const STORAGE_KEY_ACTIVE_PRESET = 'sora_paint_active_brush_preset';
export const STORAGE_KEY_BOTTOM_TAB = 'sora_paint_left_bottom_tab';
export const ERASER_PRESET_ID = 'tool-eraser';
export const DEFAULT_BRUSH_PRESET_ID = 'pencil-2b';

export interface BrushPersistentSettings {
  size?: number;
  minSizeFactor?: number;
  opacity?: number;
  flow?: number;
  spacing?: number;
  hardness?: number;
  grain?: number;
  stabilization?: number;
  usePressure?: boolean;
  useVelocity?: boolean;
  smoothing?: boolean;
  thickness?: number;
  thicknessVertical?: boolean;
  antiAlias?: number;
  customTipAngle?: number;
  customTipAngleDynamics?: 'none' | 'direction' | 'random';
  customTipRotationRandomScale?: number;
  colorMixing?: boolean;
  amountOfPaint?: number;
  densityOfPaint?: number;
  colorStretch?: number;
  mixingMode?: 'blend' | 'running_color';
  wetEdge?: number;
  wetEdgeRadius?: number;
  wetEdgeAlphaPower?: number;
  wetEdgeValuePower?: number;
  textureDensity?: number;
  paperTextureScale?: number;
  paperTextureRotate?: number;
}

export const DEFAULT_ERASER_SETTINGS: Partial<BrushSettings> = {
  preset: ERASER_PRESET_ID,
  brushName: 'Eraser',
  size: 30,
  minSizeFactor: 0.5,
  opacity: 1.0,
  flow: 1.0,
  spacing: 0.05,
  hardness: 0.9,
  stabilization: 0,
  usePressure: true,
  smoothing: true,
  useGpu: true,
};

let _memorySettingsCache: Record<string, BrushPersistentSettings> | null = null;

export function loadAllSavedBrushSettings(): Record<string, BrushPersistentSettings> {
  if (_memorySettingsCache) return _memorySettingsCache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
    _memorySettingsCache = raw ? JSON.parse(raw) : {};
  } catch {
    _memorySettingsCache = {};
  }
  return _memorySettingsCache || {};
}

export function getSavedBrushSettings(presetId: string): BrushPersistentSettings | null {
  const all = loadAllSavedBrushSettings();
  return all[presetId] || null;
}

export function saveBrushSettingsImmediately(
  presetId: string,
  settings: Partial<BrushSettings>
): void {
  if (!presetId) return;
  const all = loadAllSavedBrushSettings();
  const existing = all[presetId] || {};

  const persistent: BrushPersistentSettings = {
    ...existing,
  };

  if (settings.size !== undefined) persistent.size = settings.size;
  if (settings.minSizeFactor !== undefined) persistent.minSizeFactor = settings.minSizeFactor;
  if (settings.opacity !== undefined) persistent.opacity = settings.opacity;
  if (settings.flow !== undefined) persistent.flow = settings.flow;
  if (settings.spacing !== undefined) persistent.spacing = settings.spacing;
  if (settings.hardness !== undefined) persistent.hardness = settings.hardness;
  if (settings.grain !== undefined) persistent.grain = settings.grain;
  if (settings.stabilization !== undefined) persistent.stabilization = settings.stabilization;
  if (settings.usePressure !== undefined) persistent.usePressure = settings.usePressure;
  if (settings.useVelocity !== undefined) persistent.useVelocity = settings.useVelocity;
  if (settings.smoothing !== undefined) persistent.smoothing = settings.smoothing;
  if (settings.thickness !== undefined) persistent.thickness = settings.thickness;
  if (settings.thicknessVertical !== undefined) persistent.thicknessVertical = settings.thicknessVertical;
  if (settings.antiAlias !== undefined) persistent.antiAlias = settings.antiAlias;
  if (settings.customTipAngle !== undefined) persistent.customTipAngle = settings.customTipAngle;
  if (settings.customTipAngleDynamics !== undefined) persistent.customTipAngleDynamics = settings.customTipAngleDynamics;
  if (settings.customTipRotationRandomScale !== undefined) persistent.customTipRotationRandomScale = settings.customTipRotationRandomScale;
  if (settings.colorMixing !== undefined) persistent.colorMixing = settings.colorMixing;
  if (settings.amountOfPaint !== undefined) persistent.amountOfPaint = settings.amountOfPaint;
  if (settings.densityOfPaint !== undefined) persistent.densityOfPaint = settings.densityOfPaint;
  if (settings.colorStretch !== undefined) persistent.colorStretch = settings.colorStretch;
  if (settings.mixingMode !== undefined) persistent.mixingMode = settings.mixingMode;
  if (settings.wetEdge !== undefined) persistent.wetEdge = settings.wetEdge;
  if (settings.wetEdgeRadius !== undefined) persistent.wetEdgeRadius = settings.wetEdgeRadius;
  if (settings.wetEdgeAlphaPower !== undefined) persistent.wetEdgeAlphaPower = settings.wetEdgeAlphaPower;
  if (settings.wetEdgeValuePower !== undefined) persistent.wetEdgeValuePower = settings.wetEdgeValuePower;
  if (settings.textureDensity !== undefined) persistent.textureDensity = settings.textureDensity;
  if (settings.paperTextureScale !== undefined) persistent.paperTextureScale = settings.paperTextureScale;
  if (settings.paperTextureRotate !== undefined) persistent.paperTextureRotate = settings.paperTextureRotate;

  all[presetId] = persistent;
  _memorySettingsCache = all;

  try {
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(all));
  } catch (err) {
    console.warn('Failed to persist brush settings to localStorage:', err);
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
    try {
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(all));
    } catch {
      // ignore
    }
  }
  return getEffectiveBrushSettings(presetId, customBrushes);
}

export function getActivePresetId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY_ACTIVE_PRESET) || DEFAULT_BRUSH_PRESET_ID;
  } catch {
    return DEFAULT_BRUSH_PRESET_ID;
  }
}

export function saveActivePresetId(presetId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY_ACTIVE_PRESET, presetId);
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

  // 2. Custom CSP brush
  if (customBrushes && customBrushes.length > 0) {
    const cspMatch = customBrushes.find((b) => b.id === presetId);
    if (cspMatch) {
      const tipImg = cspMatch.tipDataUrl ? getPreloadedTipImage(cspMatch.tipDataUrl) || undefined : undefined;
      return {
        preset: cspMatch.id,
        brushName: cspMatch.name,
        size: cspMatch.size,
        minSizeFactor: cspMatch.minSizeFactor,
        flow: cspMatch.flow,
        opacity: cspMatch.opacity,
        spacing: cspMatch.spacing,
        hardness: cspMatch.hardness,
        thickness: cspMatch.thickness,
        thicknessVertical: cspMatch.thicknessVertical,
        antiAlias: cspMatch.antiAlias,
        stabilization: cspMatch.stabilization,
        customTipDataUrl: cspMatch.tipDataUrl,
        customTipImage: tipImg,
        customTipAngle: cspMatch.angle,
        customTipAngleDynamics: cspMatch.angleDynamics,
        customTipRotationRandomScale: cspMatch.rotationRandomScale,
        subTips: cspMatch.subTips,
        subTipOrder: cspMatch.subTipOrder,
        pressureCurve: cspMatch.pressureCurve,
        velocityCurve: cspMatch.velocityCurve,
        usePressure: cspMatch.usePressure,
        useVelocity: cspMatch.useVelocity,
        smoothing: cspMatch.smoothing,
        spray: cspMatch.spray,
        taper: cspMatch.taper,
        isRibbon: cspMatch.isRibbon,
        colorMixing: cspMatch.colorMixing,
        amountOfPaint: cspMatch.amountOfPaint ?? 0.7,
        densityOfPaint: cspMatch.densityOfPaint ?? 0.8,
        colorStretch: cspMatch.colorStretch ?? 0.6,
        mixingMode: cspMatch.mixingMode ?? 'blend',
        wetEdge: cspMatch.wetEdge ?? 0,
        wetEdgeRadius: cspMatch.wetEdgeRadius,
        wetEdgeAlphaPower: cspMatch.wetEdgeAlphaPower,
        wetEdgeValuePower: cspMatch.wetEdgeValuePower,
        grain: cspMatch.textureDensity ?? 0,
        paperTexture: cspMatch.paperTexture,
        paperTextureScale: cspMatch.paperTextureScale,
        paperTextureRotate: cspMatch.paperTextureRotate,
        useGpu: true,
        ...saved,
      };
    }
  }

  // 3. Builtin brush
  const builtinCfg = getBuiltinBrushConfig(presetId as BrushPresetId);
  if (builtinCfg) {
    return {
      preset: presetId,
      customTipDataUrl: undefined,
      customTipImage: undefined,
      customTipAngle: 0,
      customTipAngleDynamics: 'none',
      colorMixing: false,
      wetEdge: 0,
      grain: 0,
      ...builtinCfg,
      ...saved,
    };
  }

  // 4. Pencil configs fallback
  const pencilConfig = PENCIL_CONFIGS[presetId as PencilGrade];
  if (pencilConfig) {
    return {
      preset: presetId,
      brushName: pencilConfig.name,
      customTipDataUrl: undefined,
      customTipImage: undefined,
      customTipAngle: 0,
      size: pencilConfig.defaultSize,
      flow: pencilConfig.flow,
      hardness: pencilConfig.hardness,
      minSizeFactor: pencilConfig.minSizeFactor,
      grain: pencilConfig.grain,
      spacing: pencilConfig.spacing,
      usePressure: true,
      smoothing: true,
      stabilization: 15,
      useGpu: true,
      ...saved,
    };
  }

  // 5. Default fallback (pencil-2b)
  return {
    preset: 'pencil-2b',
    brushName: 'Pencil (2B)',
    size: 3.5,
    minSizeFactor: 0.25,
    flow: 0.74,
    hardness: 0.8,
    grain: 0.95,
    spacing: 0.08,
    usePressure: true,
    smoothing: true,
    stabilization: 15,
    useGpu: true,
    ...saved,
  };
}
