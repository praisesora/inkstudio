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

  tileMemoryBudgetMb: 1024,
};

const SETTINGS_KEY = 'ink_studio_app_settings';

export function loadAppSettings(): AppSettings {
  try {
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
