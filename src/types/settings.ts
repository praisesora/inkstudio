import { CanvasColorMode } from './editor';
import { safeLocalStorageSetItem } from '../utils/safeStorage';

export type AnchorPosition =
  | 'center'
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right';

export interface ResizeCanvasOptions {
  width: number;
  height: number;
  dpi?: number;
  scaleContent?: boolean;
  anchor?: AnchorPosition;
  backgroundColor?: string;
}

export type ThemePreset = 'vintage-manga' | 'modern';

export type ModernAccentColor = 'neutral' | 'blue' | 'burgundy' | 'green' | 'purple' | 'orange' | 'custom';

export interface ModernAccentConfig {
  id: Exclude<ModernAccentColor, 'custom'>;
  label: string;
  hex: string;
}

export const DEFAULT_ACCENT_HEX = '#e5e5e5';

export const MODERN_ACCENTS: Record<Exclude<ModernAccentColor, 'custom'>, ModernAccentConfig> = {
  neutral: { id: 'neutral', label: 'Neutral', hex: '#e5e5e5' },
  blue: { id: 'blue', label: 'Blue', hex: '#3b82f6' },
  green: { id: 'green', label: 'Green', hex: '#10b981' },
  orange: { id: 'orange', label: 'Orange', hex: '#f97316' },
  purple: { id: 'purple', label: 'Purple', hex: '#8b5cf6' },
  burgundy: { id: 'burgundy', label: 'Burgundy', hex: '#be123c' },
};

export function resolveModernAccentColor(accent: ModernAccentColor, customColor?: string): string {
  if (accent === 'custom') {
    return customColor && /^#[0-9a-fA-F]{6}$/i.test(customColor) ? customColor : DEFAULT_ACCENT_HEX;
  }
  return MODERN_ACCENTS[accent]?.hex || DEFAULT_ACCENT_HEX;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return isNaN(r) || isNaN(g) || isNaN(b) ? null : { r, g, b };
  }
  if (clean.length === 6) {
    const r = parseInt(clean.substring(0, 2), 16);
    const g = parseInt(clean.substring(2, 4), 16);
    const b = parseInt(clean.substring(4, 6), 16);
    return isNaN(r) || isNaN(g) || isNaN(b) ? null : { r, g, b };
  }
  return null;
}

export function getAccentContrastColor(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#161616';
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.55 ? '#161616' : '#e5e5e5';
}

export type ShortcutCategory = 'Tools' | 'Menu' | 'Canvas View' | 'Layer' | 'Edit';

export type ShortcutOverrides = Record<string, string>;

export type ModifierKeySlot =
  | 'space'
  | 'shift'
  | 'ctrl'
  | 'alt'
  | 'ctrlSpace'
  | 'shiftSpace'
  | 'ctrlAlt'
  | 'shiftAlt'
  | 'rightClick'
  | 'middleClick'
  | 'stylusButton1'
  | 'stylusButton2';

export type ModifierAction =
  | 'none'
  | 'pan'
  | 'rotate'
  | 'zoom-drag'
  | 'eyedropper'
  | 'brush-size'
  | 'straight-line'
  | 'temp-eraser'
  | 'undo'
  | 'swap-colors'
  | 'quick-palette';

export type MouseWheelAction = 'zoom' | 'scroll' | 'brush-size';

export interface ModifierKeySettings {
  space: ModifierAction;
  shift: ModifierAction;
  ctrl: ModifierAction;
  alt: ModifierAction;
  ctrlSpace: ModifierAction;
  shiftSpace: ModifierAction;
  ctrlAlt: ModifierAction;
  shiftAlt: ModifierAction;
  rightClick: ModifierAction;
  middleClick: ModifierAction;
  stylusButton1: ModifierAction;
  stylusButton2: ModifierAction;
  mouseWheel: MouseWheelAction;
}

export type PressureCurvePoint = [number, number];

export type PressureCurvePreset = 'linear' | 'soft' | 'hard' | 'custom';

export interface PressureCurveSettings {
  enabled: boolean;
  preset: PressureCurvePreset;
  points: PressureCurvePoint[];
}

export const DEFAULT_MODIFIER_KEY_SETTINGS: ModifierKeySettings = {
  space: 'pan',
  shift: 'straight-line',
  ctrl: 'none',
  alt: 'eyedropper',
  ctrlSpace: 'zoom-drag',
  shiftSpace: 'rotate',
  ctrlAlt: 'brush-size',
  shiftAlt: 'brush-size',
  rightClick: 'eyedropper',
  middleClick: 'pan',
  stylusButton1: 'eyedropper',
  stylusButton2: 'pan',
  mouseWheel: 'zoom',
};

export const PRESSURE_CURVE_PRESETS: Record<
  Exclude<PressureCurvePreset, 'custom'>,
  PressureCurvePoint[]
> = {
  linear: [
    [0, 0],
    [1, 1],
  ],
  soft: [
    [0, 0],
    [0.25, 0.48],
    [0.6, 0.84],
    [1, 1],
  ],
  hard: [
    [0, 0],
    [0.4, 0.16],
    [0.75, 0.52],
    [1, 1],
  ],
};

export const DEFAULT_PRESSURE_CURVE_SETTINGS: PressureCurveSettings = {
  enabled: true,
  preset: 'linear',
  points: [
    [0, 0],
    [1, 1],
  ],
};

export interface AppSettings {
  // User Profile
  userName: string;
  hasPromptedName: boolean;

  // Appearance & Theme
  themePreset: ThemePreset;
  modernAccent: ModernAccentColor;
  modernCustomColor: string;
  uiTone?: 'slate' | 'oled' | 'charcoal';
  showCheckerboard: boolean;
  showCursorCoordinates: boolean;
  showPressureInStatusBar: boolean;

  // Canvas Defaults
  defaultWidth: number;
  defaultHeight: number;
  defaultDpi: number;
  defaultColorMode: CanvasColorMode;
  defaultBgColor: string;
  defaultLockRatio: boolean;

  // Brush & Tools
  defaultBrushSize: number;
  defaultStabilization: number;
  usePressureByDefault: boolean;
  smoothingEnabled: boolean;
  maxHistorySteps: number;

  // Shortcuts, Modifier Keys & Pen Pressure Calibration
  shortcuts: ShortcutOverrides;
  modifierKeys: ModifierKeySettings;
  pressureCurve: PressureCurveSettings;

  // Performance & Scratch Disk
  tileMemoryBudgetMb: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  userName: '',
  hasPromptedName: true,
  themePreset: 'modern',
  modernAccent: 'neutral',
  modernCustomColor: DEFAULT_ACCENT_HEX,
  uiTone: 'charcoal',
  showCheckerboard: true,
  showCursorCoordinates: true,
  showPressureInStatusBar: true,

  defaultWidth: 1920,
  defaultHeight: 1080,
  defaultDpi: 300,
  defaultColorMode: 'color',
  defaultBgColor: '#ffffff',
  defaultLockRatio: true,

  defaultBrushSize: 14,
  defaultStabilization: 0,
  usePressureByDefault: true,
  smoothingEnabled: true,
  maxHistorySteps: 50,

  shortcuts: {},
  modifierKeys: { ...DEFAULT_MODIFIER_KEY_SETTINGS },
  pressureCurve: {
    ...DEFAULT_PRESSURE_CURVE_SETTINGS,
    points: DEFAULT_PRESSURE_CURVE_SETTINGS.points.map(([x, y]) => [x, y] as PressureCurvePoint),
  },

  tileMemoryBudgetMb: 1024,
};

const VALID_MODIFIER_ACTIONS = new Set<ModifierAction>([
  'none',
  'pan',
  'rotate',
  'zoom-drag',
  'eyedropper',
  'brush-size',
  'straight-line',
  'temp-eraser',
  'undo',
  'swap-colors',
  'quick-palette',
]);

const VALID_MOUSE_WHEEL_ACTIONS = new Set<MouseWheelAction>(['zoom', 'scroll', 'brush-size']);

function sanitizeModifierKeys(raw: unknown): ModifierKeySettings {
  const result: ModifierKeySettings = { ...DEFAULT_MODIFIER_KEY_SETTINGS };
  if (!raw || typeof raw !== 'object') return result;
  const obj = raw as Record<string, unknown>;
  const slots: ModifierKeySlot[] = [
    'space',
    'shift',
    'ctrl',
    'alt',
    'ctrlSpace',
    'shiftSpace',
    'ctrlAlt',
    'shiftAlt',
    'rightClick',
    'middleClick',
    'stylusButton1',
    'stylusButton2',
  ];
  for (const slot of slots) {
    if (typeof obj[slot] === 'string' && VALID_MODIFIER_ACTIONS.has(obj[slot] as ModifierAction)) {
      result[slot] = obj[slot] as ModifierAction;
    }
  }
  if (
    typeof obj.mouseWheel === 'string' &&
    VALID_MOUSE_WHEEL_ACTIONS.has(obj.mouseWheel as MouseWheelAction)
  ) {
    result.mouseWheel = obj.mouseWheel as MouseWheelAction;
  }
  return result;
}

function sanitizeShortcuts(raw: unknown): ShortcutOverrides {
  const result: ShortcutOverrides = {};
  if (!raw || typeof raw !== 'object') return result;
  const obj = raw as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    if (typeof key === 'string' && typeof val === 'string') {
      result[key] = val;
    }
  }
  return result;
}

function sanitizePressureCurve(raw: unknown): PressureCurveSettings {
  if (!raw || typeof raw !== 'object') {
    return {
      ...DEFAULT_PRESSURE_CURVE_SETTINGS,
      points: DEFAULT_PRESSURE_CURVE_SETTINGS.points.map(([x, y]) => [x, y] as PressureCurvePoint),
    };
  }
  const obj = raw as Record<string, unknown>;
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : true;
  const preset: PressureCurvePreset =
    obj.preset === 'linear' ||
    obj.preset === 'soft' ||
    obj.preset === 'hard' ||
    obj.preset === 'custom'
      ? obj.preset
      : 'custom';
  const rawPts = Array.isArray(obj.points) ? obj.points : DEFAULT_PRESSURE_CURVE_SETTINGS.points;
  const validPts: PressureCurvePoint[] = [];
  for (const p of rawPts) {
    if (
      Array.isArray(p) &&
      p.length >= 2 &&
      typeof p[0] === 'number' &&
      typeof p[1] === 'number' &&
      Number.isFinite(p[0]) &&
      Number.isFinite(p[1])
    ) {
      validPts.push([
        Math.max(0, Math.min(1, p[0])),
        Math.max(0, Math.min(1, p[1])),
      ]);
    }
  }
  validPts.sort((a, b) => a[0] - b[0]);
  if (validPts.length < 2) {
    return {
      enabled,
      preset: 'linear',
      points: [
        [0, 0],
        [1, 1],
      ],
    };
  }
  return { enabled, preset, points: validPts };
}

const SETTINGS_KEY = 'ink_studio_app_settings';

export function loadAppSettings(): AppSettings {
  try {
    if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') {
      return {
        ...DEFAULT_APP_SETTINGS,
        shortcuts: {},
        modifierKeys: { ...DEFAULT_MODIFIER_KEY_SETTINGS },
        pressureCurve: {
          ...DEFAULT_PRESSURE_CURVE_SETTINGS,
          points: DEFAULT_PRESSURE_CURVE_SETTINGS.points.map(([x, y]) => [x, y] as PressureCurvePoint),
        },
      };
    }
    const raw = localStorage.getItem(SETTINGS_KEY);
    const legacyName = localStorage.getItem('sora_paint_nickname') || '';
    if (raw) {
      const parsed = JSON.parse(raw);
      const validTheme: ThemePreset = parsed.themePreset === 'vintage-manga' ? 'vintage-manga' : 'modern';
      const validAccent: ModernAccentColor = [
        'neutral',
        'blue',
        'burgundy',
        'green',
        'purple',
        'orange',
        'custom',
      ].includes(parsed.modernAccent)
        ? parsed.modernAccent
        : 'neutral';
      const validCustomColor: string =
        typeof parsed.modernCustomColor === 'string' && /^#[0-9a-fA-F]{6}$/i.test(parsed.modernCustomColor)
          ? parsed.modernCustomColor
          : DEFAULT_ACCENT_HEX;
      const validTone: 'slate' | 'oled' | 'charcoal' = ['slate', 'oled', 'charcoal'].includes(parsed.uiTone)
        ? parsed.uiTone
        : 'charcoal';
      const validBudget: number =
        typeof parsed.tileMemoryBudgetMb === 'number' && parsed.tileMemoryBudgetMb >= 256 && parsed.tileMemoryBudgetMb <= 8192
          ? parsed.tileMemoryBudgetMb
          : 1024;
      return {
        ...DEFAULT_APP_SETTINGS,
        ...parsed,
        userName: parsed.userName !== undefined ? parsed.userName : legacyName,
        hasPromptedName: parsed.hasPromptedName !== undefined ? parsed.hasPromptedName : true,
        themePreset: validTheme,
        modernAccent: validAccent,
        modernCustomColor: validCustomColor,
        uiTone: validTone,
        tileMemoryBudgetMb: validBudget,
        shortcuts: sanitizeShortcuts(parsed.shortcuts),
        modifierKeys: sanitizeModifierKeys(parsed.modifierKeys),
        pressureCurve: sanitizePressureCurve(parsed.pressureCurve),
      };
    } else if (legacyName) {
      return {
        ...DEFAULT_APP_SETTINGS,
        userName: legacyName,
        hasPromptedName: true,
        shortcuts: {},
        modifierKeys: { ...DEFAULT_MODIFIER_KEY_SETTINGS },
        pressureCurve: {
          ...DEFAULT_PRESSURE_CURVE_SETTINGS,
          points: DEFAULT_PRESSURE_CURVE_SETTINGS.points.map(([x, y]) => [x, y] as PressureCurvePoint),
        },
      };
    }
  } catch (err) {
    console.warn('Failed to load settings from localStorage:', err);
  }
  return {
    ...DEFAULT_APP_SETTINGS,
    shortcuts: {},
    modifierKeys: { ...DEFAULT_MODIFIER_KEY_SETTINGS },
    pressureCurve: {
      ...DEFAULT_PRESSURE_CURVE_SETTINGS,
      points: DEFAULT_PRESSURE_CURVE_SETTINGS.points.map(([x, y]) => [x, y] as PressureCurvePoint),
    },
  };
}

export function saveAppSettings(settings: AppSettings): void {
  safeLocalStorageSetItem(SETTINGS_KEY, JSON.stringify(settings), 'app settings');
}
