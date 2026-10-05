import { CanvasColorMode } from './editor';

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

export type ModernAccentColor = 'blue' | 'burgundy' | 'green' | 'purple' | 'orange' | 'custom';

export interface ModernAccentConfig {
  id: ModernAccentColor;
  label: string;
  hex: string;
}

export const MODERN_ACCENTS: Record<Exclude<ModernAccentColor, 'custom'>, ModernAccentConfig> = {
  blue: { id: 'blue', label: 'Blue', hex: '#3b82f6' },
  burgundy: { id: 'burgundy', label: 'Burgundy', hex: '#be123c' },
  green: { id: 'green', label: 'Green', hex: '#10b981' },
  purple: { id: 'purple', label: 'Purple', hex: '#8b5cf6' },
  orange: { id: 'orange', label: 'Orange', hex: '#f97316' },
};

export function resolveModernAccentColor(accent: ModernAccentColor, customColor?: string): string {
  if (accent === 'custom') {
    return customColor && /^#[0-9a-fA-F]{6}$/i.test(customColor) ? customColor : '#3b82f6';
  }
  return MODERN_ACCENTS[accent]?.hex || '#3b82f6';
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
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  userName: '',
  hasPromptedName: false,
  themePreset: 'vintage-manga',
  modernAccent: 'blue',
  modernCustomColor: '#3b82f6',
  uiTone: 'slate',
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
};

const SETTINGS_KEY = 'sora_paint_app_settings';

export function loadAppSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const legacyName = localStorage.getItem('sora_paint_nickname') || '';
    if (raw) {
      const parsed = JSON.parse(raw);
      const validTheme: ThemePreset = parsed.themePreset === 'modern' ? 'modern' : 'vintage-manga';
      const validAccent: ModernAccentColor = ['blue', 'burgundy', 'green', 'purple', 'orange', 'custom'].includes(parsed.modernAccent)
        ? parsed.modernAccent
        : 'blue';
      const validCustomColor: string = typeof parsed.modernCustomColor === 'string' && /^#[0-9a-fA-F]{6}$/i.test(parsed.modernCustomColor)
        ? parsed.modernCustomColor
        : '#3b82f6';
      const validTone: 'slate' | 'oled' | 'charcoal' = ['slate', 'oled', 'charcoal'].includes(parsed.uiTone)
        ? parsed.uiTone
        : 'slate';
      return {
        ...DEFAULT_APP_SETTINGS,
        ...parsed,
        userName: parsed.userName !== undefined ? parsed.userName : legacyName,
        hasPromptedName: parsed.hasPromptedName !== undefined ? parsed.hasPromptedName : Boolean(legacyName),
        themePreset: validTheme,
        modernAccent: validAccent,
        modernCustomColor: validCustomColor,
        uiTone: validTone,
      };
    } else if (legacyName) {
      return {
        ...DEFAULT_APP_SETTINGS,
        userName: legacyName,
        hasPromptedName: true,
      };
    }
  } catch (err) {
    console.warn('Failed to load settings from localStorage:', err);
  }
  return { ...DEFAULT_APP_SETTINGS };
}

export function saveAppSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    console.warn('Failed to save settings to localStorage:', err);
  }
}
