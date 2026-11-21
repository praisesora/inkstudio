import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_ACCENT_HEX,
  loadAppSettings,
  saveAppSettings,
  resolveModernAccentColor,
  getAccentContrastColor,
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

  it('loads minimalist default settings with neutral #e5e5e5 accent when storage is empty', () => {
    const settings = loadAppSettings();
    expect(settings.themePreset).toBe('modern');
    expect(settings.modernAccent).toBe('neutral');
    expect(settings.modernCustomColor).toBe('#e5e5e5');
    expect(resolveModernAccentColor(settings.modernAccent)).toBe(DEFAULT_ACCENT_HEX);
  });

  it('correctly loads and persists modern theme with presets and coerces legacy vintage-manga', () => {
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      themePreset: 'modern',
      modernAccent: 'burgundy',
    });

    const loaded = loadAppSettings();
    expect(loaded.themePreset).toBe('modern');
    expect(loaded.modernAccent).toBe('burgundy');

    localStorage.setItem(
      'ink_studio_app_settings',
      JSON.stringify({ themePreset: 'vintage-manga', modernAccent: 'blue' })
    );
    expect(loadAppSettings().themePreset).toBe('modern');
  });

  it('correctly resolves preset accent hex codes', () => {
    expect(resolveModernAccentColor('neutral')).toBe(MODERN_ACCENTS.neutral.hex);
    expect(resolveModernAccentColor('blue')).toBe(MODERN_ACCENTS.blue.hex);
    expect(resolveModernAccentColor('burgundy')).toBe(MODERN_ACCENTS.burgundy.hex);
    expect(resolveModernAccentColor('green')).toBe(MODERN_ACCENTS.green.hex);
    expect(resolveModernAccentColor('purple')).toBe(MODERN_ACCENTS.purple.hex);
    expect(resolveModernAccentColor('orange')).toBe(MODERN_ACCENTS.orange.hex);
  });

  it('handles custom accent color with validation fallback to #e5e5e5', () => {
    expect(resolveModernAccentColor('custom', '#123456')).toBe('#123456');
    expect(resolveModernAccentColor('custom', 'invalid-hex')).toBe('#e5e5e5');
  });

  it('computes high-contrast foreground text color for light and dark accents', () => {
    expect(getAccentContrastColor('#e5e5e5')).toBe('#161616');
    expect(getAccentContrastColor('#3b82f6')).toBe('#e5e5e5');
  });

  it('converts hex strings to valid RGB objects', () => {
    expect(hexToRgb('#e5e5e5')).toEqual({ r: 229, g: 229, b: 229 });
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
    expect(loadAppSettings().uiTone).toBe('charcoal');
  });

  it('defaults and sanitizes autoCheckUpdates and skippedUpdateVersion safely for legacy storage', () => {
    const defaults = loadAppSettings();
    expect(defaults.autoCheckUpdates).toBe(true);
    expect(defaults.skippedUpdateVersion).toBe('');

    // Legacy user settings missing updater fields
    localStorage.setItem(
      'ink_studio_app_settings',
      JSON.stringify({
        themePreset: 'modern',
        modernAccent: 'blue',
      })
    );
    const migrated = loadAppSettings();
    expect(migrated.autoCheckUpdates).toBe(true);
    expect(migrated.skippedUpdateVersion).toBe('');

    // Corrupted updater field types fall back safely
    localStorage.setItem(
      'ink_studio_app_settings',
      JSON.stringify({
        autoCheckUpdates: 'yes',
        skippedUpdateVersion: 12345,
      })
    );
    const sanitized = loadAppSettings();
    expect(sanitized.autoCheckUpdates).toBe(true);
    expect(sanitized.skippedUpdateVersion).toBe('');

    // Valid persisted values round-trip cleanly
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      autoCheckUpdates: false,
      skippedUpdateVersion: ' 1.2.3 ',
    });
    const roundTripped = loadAppSettings();
    expect(roundTripped.autoCheckUpdates).toBe(false);
    expect(roundTripped.skippedUpdateVersion).toBe('1.2.3');
  });
});
