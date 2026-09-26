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

export type ThemePreset = 'vintage-manga';

export interface AppSettings {
  // Appearance & Theme
  themePreset: ThemePreset;
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
  themePreset: 'vintage-manga',
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
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_APP_SETTINGS,
        ...parsed,
        themePreset: 'vintage-manga',
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
