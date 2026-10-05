import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  loadAppSettings,
  saveAppSettings,
  resolveModernAccentColor,
  hexToRgb,
  MODERN_ACCENTS,
} from '../../types/settings';

describe('settings theme & accent system', () => {
  beforeEach(() => {
    const storage: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => storage[k] || null,
      setItem: (k: string, v: string) => {
        storage[k] = String(v);
      },
      removeItem: (k: string) => {
        delete storage[k];
      },
      clear: () => {
        Object.keys(storage).forEach((k) => delete storage[k]);
      },
    };
  });

  it('loads default settings when storage is empty', () => {
    const settings = loadAppSettings();
    expect(settings.themePreset).toBe('vintage-manga');
    expect(settings.modernAccent).toBe('blue');
    expect(settings.modernCustomColor).toBe('#3b82f6');
  });

  it('correctly loads and persists modern theme with presets', () => {
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      themePreset: 'modern',
      modernAccent: 'burgundy',
    });

    const loaded = loadAppSettings();
    expect(loaded.themePreset).toBe('modern');
    expect(loaded.modernAccent).toBe('burgundy');
  });

  it('correctly resolves preset accent hex codes', () => {
    expect(resolveModernAccentColor('blue')).toBe(MODERN_ACCENTS.blue.hex);
    expect(resolveModernAccentColor('burgundy')).toBe(MODERN_ACCENTS.burgundy.hex);
    expect(resolveModernAccentColor('green')).toBe(MODERN_ACCENTS.green.hex);
    expect(resolveModernAccentColor('purple')).toBe(MODERN_ACCENTS.purple.hex);
    expect(resolveModernAccentColor('orange')).toBe(MODERN_ACCENTS.orange.hex);
  });

  it('handles custom accent color with validation fallback', () => {
    expect(resolveModernAccentColor('custom', '#123456')).toBe('#123456');
    expect(resolveModernAccentColor('custom', 'invalid-hex')).toBe('#3b82f6');
  });

  it('converts hex strings to valid RGB objects', () => {
    expect(hexToRgb('#3b82f6')).toEqual({ r: 59, g: 130, b: 246 });
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('invalid')).toBeNull();
  });

  it('correctly loads and validates uiTone setting with fallbacks', () => {
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      uiTone: 'oled',
    });
    expect(loadAppSettings().uiTone).toBe('oled');

    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      uiTone: 'invalid-tone' as any,
    });
    expect(loadAppSettings().uiTone).toBe('slate');
  });
});
