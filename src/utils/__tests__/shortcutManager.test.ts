import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_COMMANDS,
  SPRING_LOADED_HOLD_MS,
  ShortcutManager,
  SpringLoadedToolController,
  findShortcutConflicts,
  formatShortcutFromEvent,
  formatShortcutLabel,
  matchesKeyboardEvent,
  normalizeShortcut,
  parseShortcut,
  resolveHeldKeyModifierAction,
  resolvePointerModifierAction,
} from '../shortcutManager';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_MODIFIER_KEY_SETTINGS,
  loadAppSettings,
  saveAppSettings,
} from '../../types/settings';

describe('Shortcut Parsing, Normalization & Matching', () => {
  it('parses and normalizes standard, modifier, and punctuation shortcuts', () => {
    expect(normalizeShortcut('ctrl + z')).toBe('Ctrl+Z');
    expect(normalizeShortcut('CMD+SHIFT+s')).toBe('Ctrl+Shift+S');
    expect(normalizeShortcut('alt + c')).toBe('Alt+C');
    expect(normalizeShortcut('ctrl + ,')).toBe('Ctrl+,');
    expect(normalizeShortcut('[')).toBe('[');
    expect(normalizeShortcut(']')).toBe(']');
    expect(normalizeShortcut('ctrl + +')).toBe('Ctrl+=');
    expect(normalizeShortcut('del')).toBe('Delete');
    expect(normalizeShortcut('Control')).toBe('');

    expect(formatShortcutLabel('Ctrl+Shift+S')).toBe('Ctrl + Shift + S');
    expect(formatShortcutLabel('')).toBe('Unassigned');

    const parsed = parseShortcut('Ctrl+Alt+0');
    expect(parsed).toMatchObject({
      ctrl: true,
      shift: false,
      alt: true,
      key: '0',
      code: 'Digit0',
    });
  });

  it('matches KeyboardEvents layout-independently via e.code and numpad aliases', () => {
    // Cyrillic layout pressing physical Z key with Ctrl
    expect(
      matchesKeyboardEvent({ key: 'я', code: 'KeyZ', ctrlKey: true }, 'Ctrl+Z')
    ).toBe(true);

    // Rejects extra modifiers
    expect(
      matchesKeyboardEvent({ key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true }, 'Ctrl+Z')
    ).toBe(false);

    // Numpad aliases for zoom & reset
    expect(
      matchesKeyboardEvent({ key: '0', code: 'Numpad0', ctrlKey: true }, 'Ctrl+0')
    ).toBe(true);
    expect(
      matchesKeyboardEvent({ key: '+', code: 'NumpadAdd', ctrlKey: true }, 'Ctrl+=')
    ).toBe(true);
    expect(
      matchesKeyboardEvent({ key: '-', code: 'NumpadSubtract', ctrlKey: true }, 'Ctrl+-')
    ).toBe(true);

    // Brackets & comma
    expect(matchesKeyboardEvent({ key: '[', code: 'BracketLeft' }, '[')).toBe(true);
    expect(
      matchesKeyboardEvent({ key: ',', code: 'Comma', ctrlKey: true }, 'Ctrl+,')
    ).toBe(true);
  });

  it('captures live KeyboardEvents for recording UI and ignores bare modifiers', () => {
    expect(formatShortcutFromEvent({ key: 'Control', code: 'ControlLeft', ctrlKey: true })).toBeNull();
    expect(formatShortcutFromEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })).toBeNull();
    expect(formatShortcutFromEvent({ key: 'Alt', code: 'AltLeft', altKey: true })).toBeNull();

    expect(
      formatShortcutFromEvent({ key: 'q', code: 'KeyQ', ctrlKey: true, shiftKey: true })
    ).toBe('Ctrl+Shift+Q');
    expect(formatShortcutFromEvent({ key: 'e', code: 'KeyE' })).toBe('E');
  });
});

describe('Command Registry, Remapping, Conflict Detection & Persistence', () => {
  beforeEach(() => {
    const storage: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => storage[k] ?? null,
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

  it('covers all 5 required categories and dispatches remapped commands immediately', () => {
    const categories = new Set(DEFAULT_COMMANDS.map((c) => c.category));
    expect(categories.has('Tools')).toBe(true);
    expect(categories.has('Menu')).toBe(true);
    expect(categories.has('Canvas View')).toBe(true);
    expect(categories.has('Layer')).toBe(true);
    expect(categories.has('Edit')).toBe(true);

    const mgr = new ShortcutManager(DEFAULT_COMMANDS);
    let undoCount = 0;
    mgr.registerHandler('edit.undo', () => {
      undoCount++;
    });

    // Default Ctrl+Z works
    const defMatch = mgr.matchEvent({ key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(defMatch?.id).toBe('edit.undo');
    expect(mgr.executeCommand(defMatch!.id)).toBe(true);
    expect(undoCount).toBe(1);

    // Remap immediately to Alt+Z without reload
    mgr.setOverrides({ 'edit.undo': 'Alt+Z' });
    expect(mgr.matchEvent({ key: 'z', code: 'KeyZ', ctrlKey: true })).toBeNull();
    const remappedMatch = mgr.matchEvent({ key: 'z', code: 'KeyZ', altKey: true });
    expect(remappedMatch?.id).toBe('edit.undo');
    expect(mgr.executeCommand(remappedMatch!.id)).toBe(true);
    expect(undoCount).toBe(2);
  });

  it('detects conflicts accurately against defaults and user overrides', () => {
    const conflicts = findShortcutConflicts('tool.brush', 'E', {});
    expect(conflicts.map((c) => c.id)).toEqual(['tool.eraser']);

    // Rebinding eraser away clears conflict on E
    const afterRebind = findShortcutConflicts('tool.brush', 'E', { 'tool.eraser': 'Q' });
    expect(afterRebind).toHaveLength(0);

    // Conflict against overridden key Q is detected
    const conflictOnQ = findShortcutConflicts('tool.brush', 'Q', { 'tool.eraser': 'Q' });
    expect(conflictOnQ.map((c) => c.id)).toEqual(['tool.eraser']);
  });

  it('persists remapped shortcuts and modifier keys in AppSettings', () => {
    saveAppSettings({
      ...DEFAULT_APP_SETTINGS,
      shortcuts: { 'tool.eraser': 'Q', 'edit.undo': 'Alt+Z' },
      modifierKeys: {
        ...DEFAULT_MODIFIER_KEY_SETTINGS,
        rightClick: 'quick-palette',
        mouseWheel: 'brush-size',
        stylusButton1: 'temp-eraser',
      },
    });

    const loaded = loadAppSettings();
    expect(loaded.shortcuts).toEqual({ 'tool.eraser': 'Q', 'edit.undo': 'Alt+Z' });
    expect(loaded.modifierKeys.rightClick).toBe('quick-palette');
    expect(loaded.modifierKeys.mouseWheel).toBe('brush-size');
    expect(loaded.modifierKeys.stylusButton1).toBe('temp-eraser');
  });
});

describe('Spring-Loaded Tool Switching (> 250ms hold-and-revert)', () => {
  it('switches permanently on quick tap (< 250ms) when unused', () => {
    let clock = 1000;
    const ctrl = new SpringLoadedToolController(SPRING_LOADED_HOLD_MS, () => clock);

    const activated = ctrl.handleToolKeyDown('KeyE', 'eraser', 'brush');
    expect(activated).toBe('eraser');

    clock += 120; // quick tap < 250ms
    const restored = ctrl.handleKeyUp('KeyE', 'eraser');
    expect(restored).toBeNull();
  });

  it('reverts to previous tool on keyup when held longer than 250ms', () => {
    let clock = 1000;
    const ctrl = new SpringLoadedToolController(SPRING_LOADED_HOLD_MS, () => clock);

    expect(ctrl.handleToolKeyDown('KeyE', 'eraser', 'brush')).toBe('eraser');

    clock += 260; // > 250ms hold
    const restored = ctrl.handleKeyUp('KeyE', 'eraser');
    expect(restored).toBe('brush');
  });

  it('reverts to previous tool on keyup when pointer was used while held even if < 250ms', () => {
    let clock = 1000;
    const ctrl = new SpringLoadedToolController(SPRING_LOADED_HOLD_MS, () => clock);

    expect(ctrl.handleToolKeyDown('KeyI', 'pipette', 'brush')).toBe('pipette');
    ctrl.markUsedWhileHeld();

    clock += 100;
    expect(ctrl.handleKeyUp('KeyI', 'pipette')).toBe('brush');
  });

  it('does not revert if current tool changed to something else before release', () => {
    let clock = 1000;
    const ctrl = new SpringLoadedToolController(SPRING_LOADED_HOLD_MS, () => clock);

    expect(ctrl.handleToolKeyDown('KeyE', 'eraser', 'brush')).toBe('eraser');
    clock += 400;
    expect(ctrl.handleKeyUp('KeyE', 'fill')).toBeNull();
  });

  it('supports remapped tool keys seamlessly via physical key code', () => {
    let clock = 5000;
    const ctrl = new SpringLoadedToolController(SPRING_LOADED_HOLD_MS, () => clock);

    expect(ctrl.handleToolKeyDown('KeyQ', 'eraser', 'brush')).toBe('eraser');
    clock += 300;
    expect(ctrl.handleKeyUp('KeyQ', 'eraser')).toBe('brush');
  });
});

describe('Modifier Key Resolution', () => {
  it('resolves default CSP modifier mappings including Ctrl+Alt and Shift+Alt brush resize', () => {
    const base = {
      button: 0,
      pointerType: 'mouse',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      isSpaceDown: false,
    };

    expect(
      resolvePointerModifierAction({ ...base, ctrlKey: true, altKey: true })
    ).toEqual({ slot: 'ctrlAlt', action: 'brush-size' });

    expect(
      resolvePointerModifierAction({ ...base, shiftKey: true, altKey: true })
    ).toEqual({ slot: 'shiftAlt', action: 'brush-size' });

    expect(
      resolvePointerModifierAction({ ...base, ctrlKey: true, isSpaceDown: true })
    ).toEqual({ slot: 'ctrlSpace', action: 'zoom-drag' });

    expect(
      resolvePointerModifierAction({ ...base, shiftKey: true, isSpaceDown: true })
    ).toEqual({ slot: 'shiftSpace', action: 'rotate' });

    expect(resolvePointerModifierAction({ ...base, isSpaceDown: true })).toEqual({
      slot: 'space',
      action: 'pan',
    });

    expect(resolvePointerModifierAction({ ...base, button: 2 })).toEqual({
      slot: 'rightClick',
      action: 'eyedropper',
    });

    expect(resolvePointerModifierAction({ ...base, button: 1 })).toEqual({
      slot: 'middleClick',
      action: 'pan',
    });

    expect(resolvePointerModifierAction({ ...base, pointerType: 'pen', button: 2 })).toEqual({
      slot: 'stylusButton1',
      action: 'eyedropper',
    });

    expect(resolvePointerModifierAction({ ...base, pointerType: 'pen', button: 5 })).toEqual({
      slot: 'stylusButton2',
      action: 'pan',
    });
  });

  it('respects remapped modifier actions for pointer and held-key states', () => {
    const custom = {
      ...DEFAULT_MODIFIER_KEY_SETTINGS,
      rightClick: 'quick-palette' as const,
      space: 'rotate' as const,
      stylusButton1: 'brush-size' as const,
    };

    expect(
      resolvePointerModifierAction(
        {
          button: 2,
          pointerType: 'mouse',
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          altKey: false,
          isSpaceDown: false,
        },
        custom
      )
    ).toEqual({ slot: 'rightClick', action: 'quick-palette' });

    expect(
      resolvePointerModifierAction(
        {
          button: 2,
          pointerType: 'pen',
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          altKey: false,
          isSpaceDown: false,
        },
        custom
      )
    ).toEqual({ slot: 'stylusButton1', action: 'brush-size' });

    expect(
      resolveHeldKeyModifierAction({ ctrl: false, shift: false, alt: false, space: true }, custom)
    ).toBe('rotate');
  });
});
