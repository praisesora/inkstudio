import { ToolType } from '../types/editor';
import {
  DEFAULT_MODIFIER_KEY_SETTINGS,
  ModifierAction,
  ModifierKeySettings,
  ModifierKeySlot,
  ShortcutCategory,
  ShortcutOverrides,
} from '../types/settings';

export const SPRING_LOADED_HOLD_MS = 250;

export interface CommandDefinition {
  id: string;
  label: string;
  description: string;
  category: ShortcutCategory;
  defaultShortcut: string;
  /** Optional secondary default shortcut (only active when user has not overridden this command) */
  altDefaultShortcut?: string;
  /** Tool selected by this command (enables spring-loaded hold-to-revert) */
  toolId?: ToolType;
  /** Whether holding the key (> 250ms or used while held) reverts on keyup */
  springLoaded?: boolean;
  /** Runtime handler */
  handler?: () => void;
}

export interface ParsedShortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Canonical display key token (e.g. 'Z', '[', '0', 'Delete', 'Tab', ',') */
  key: string;
  /** Primary KeyboardEvent.code (e.g. 'KeyZ', 'BracketLeft', 'Digit0', 'Delete') */
  code: string;
  /** Optional alternate codes (e.g. 'Numpad0' for 'Digit0', 'NumpadAdd' for 'Equal') */
  altCodes?: readonly string[];
}

export interface KeyboardEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

export const SHORTCUT_CATEGORIES: readonly ShortcutCategory[] = [
  'Tools',
  'Menu',
  'Canvas View',
  'Layer',
  'Edit',
];

export const DEFAULT_COMMANDS: readonly CommandDefinition[] = [
  // --- Tools (spring-loaded where toolId is set) ---
  {
    id: 'tool.brush',
    label: 'Brush Tool',
    description: 'Switch to brush (hold > 250ms for temporary switch)',
    category: 'Tools',
    defaultShortcut: 'B',
    toolId: 'brush',
    springLoaded: true,
  },
  {
    id: 'tool.eraser',
    label: 'Eraser Tool',
    description: 'Switch to eraser (hold > 250ms for temporary switch)',
    category: 'Tools',
    defaultShortcut: 'E',
    toolId: 'eraser',
    springLoaded: true,
  },
  {
    id: 'tool.pipette',
    label: 'Eyedropper Tool',
    description: 'Sample color from canvas (hold > 250ms for temporary switch)',
    category: 'Tools',
    defaultShortcut: 'I',
    toolId: 'pipette',
    springLoaded: true,
  },
  {
    id: 'tool.liquify',
    label: 'Liquify Tool',
    description: 'Warp pixels with liquify brush',
    category: 'Tools',
    defaultShortcut: 'J',
    toolId: 'liquify',
    springLoaded: true,
  },
  {
    id: 'tool.selectRect',
    label: 'Rectangle Selection',
    description: 'Rectangular marquee selection',
    category: 'Tools',
    defaultShortcut: 'M',
    toolId: 'select-rect',
    springLoaded: true,
  },
  {
    id: 'tool.selectLasso',
    label: 'Lasso Selection',
    description: 'Freehand lasso selection',
    category: 'Tools',
    defaultShortcut: 'L',
    toolId: 'select-lasso',
    springLoaded: true,
  },
  {
    id: 'tool.selectWand',
    label: 'Magic Wand',
    description: 'Contiguous color area selection',
    category: 'Tools',
    defaultShortcut: 'W',
    toolId: 'select-wand',
    springLoaded: true,
  },
  {
    id: 'tool.fill',
    label: 'Fill Bucket',
    description: 'Flood fill enclosed regions',
    category: 'Tools',
    defaultShortcut: 'G',
    toolId: 'fill',
    springLoaded: true,
  },
  {
    id: 'tool.gradient',
    label: 'Gradient Tool',
    description: 'Draw linear, radial, and interactive mesh gradients',
    category: 'Tools',
    defaultShortcut: 'Shift+G',
    toolId: 'gradient',
    springLoaded: true,
  },
  {
    id: 'tool.retouch',
    label: 'Retouch Tool',
    description: 'Smudge, Blur, Dodge, Burn, and Clone Stamp brush',
    category: 'Tools',
    defaultShortcut: 'S',
    toolId: 'retouch',
    springLoaded: true,
  },
  {
    id: 'tool.shape',
    label: 'Geometric Shapes',
    description: 'Draw lines, rectangles, ellipses, triangles, polygons, stars, and arrows',
    category: 'Tools',
    defaultShortcut: 'U',
    toolId: 'shape',
    springLoaded: true,
  },
  {
    id: 'tool.pen',
    label: 'Bézier Pen Tool',
    description: 'Plot true cubic Bézier curves with editable anchor handles',
    category: 'Tools',
    defaultShortcut: 'P',
    toolId: 'pen',
    springLoaded: true,
  },
  {
    id: 'tool.text',
    label: 'Text Tool',
    description: 'Place and edit manga typography',
    category: 'Tools',
    defaultShortcut: 'T',
    toolId: 'text',
    springLoaded: true,
  },
  {
    id: 'tool.frame',
    label: 'Manga Frame Tool',
    description: 'Create panel borders',
    category: 'Tools',
    defaultShortcut: 'F',
    toolId: 'frame',
    springLoaded: true,
  },
  {
    id: 'tool.balloon',
    label: 'Speech Balloon',
    description: 'Draw parametric speech balloons',
    category: 'Tools',
    defaultShortcut: 'O',
    toolId: 'balloon',
    springLoaded: true,
  },
  {
    id: 'tool.vectorEdit',
    label: 'Vector Edit Tool',
    description: 'Pinch, simplify, and adjust vector strokes',
    category: 'Tools',
    defaultShortcut: 'Y',
    toolId: 'vector-edit',
    springLoaded: true,
  },
  {
    id: 'tool.3d',
    label: '3D Object & Camera Tool',
    description: 'Manipulate 3D models, lighting, camera, and poses on the canvas',
    category: 'Tools',
    defaultShortcut: 'K',
    toolId: '3d',
    springLoaded: false,
  },
  {
    id: 'tool.brushSizeDown',
    label: 'Decrease Brush Size',
    description: 'Step brush diameter down',
    category: 'Tools',
    defaultShortcut: '[',
  },
  {
    id: 'tool.brushSizeUp',
    label: 'Increase Brush Size',
    description: 'Step brush diameter up',
    category: 'Tools',
    defaultShortcut: ']',
  },
  {
    id: 'color.swap',
    label: 'Swap Colors',
    description: 'Swap primary and secondary colors',
    category: 'Tools',
    defaultShortcut: 'X',
  },
  {
    id: 'color.reset',
    label: 'Default Colors',
    description: 'Reset primary/secondary colors to black & white',
    category: 'Tools',
    defaultShortcut: 'D',
  },
  {
    id: 'color.transparent',
    label: 'Transparent Ink Mode',
    description: 'Toggle drawing with transparent color',
    category: 'Tools',
    defaultShortcut: 'C',
  },

  // --- Menu ---
  {
    id: 'file.new',
    label: 'New Canvas',
    description: 'Create a new document',
    category: 'Menu',
    defaultShortcut: 'Ctrl+N',
  },
  {
    id: 'file.open',
    label: 'Open File',
    description: 'Open image, PSD, or CSP file',
    category: 'Menu',
    defaultShortcut: 'Ctrl+O',
  },
  {
    id: 'file.save',
    label: 'Save',
    description: 'Save active document',
    category: 'Menu',
    defaultShortcut: 'Ctrl+S',
  },
  {
    id: 'file.saveAs',
    label: 'Save As',
    description: 'Save document to a new file',
    category: 'Menu',
    defaultShortcut: 'Ctrl+Shift+S',
  },
  {
    id: 'app.preferences',
    label: 'Preferences',
    description: 'Open application preferences',
    category: 'Menu',
    defaultShortcut: 'Ctrl+,',
  },
  {
    id: 'view.togglePalettes',
    label: 'Toggle Palettes',
    description: 'Show or hide docked UI palettes',
    category: 'Menu',
    defaultShortcut: 'Tab',
  },
  {
    id: 'view.toggleLeftPanel',
    label: 'Toggle Left Panel',
    description: 'Show or hide the left tool panel',
    category: 'Menu',
    defaultShortcut: 'Shift+Tab',
  },
  {
    id: 'view.softProof',
    label: 'Toggle Soft Proof',
    description: 'Preview CMYK/print soft proofing',
    category: 'Menu',
    defaultShortcut: 'Ctrl+Alt+Y',
  },
  {
    id: 'view.gamutWarning',
    label: 'Toggle Gamut Warning',
    description: 'Highlight out-of-gamut colors',
    category: 'Menu',
    defaultShortcut: 'Ctrl+Shift+Y',
  },
  {
    id: 'anim.toggleTimeline',
    label: 'Toggle Animation Timeline',
    description: 'Show or hide frame animation timeline',
    category: 'Menu',
    defaultShortcut: 'Ctrl+Alt+A',
  },
  {
    id: 'anim.addCel',
    label: 'Add Animation Cel',
    description: 'Insert a new animation cel at current frame',
    category: 'Menu',
    defaultShortcut: 'Alt+C',
  },

  // --- Canvas View ---
  {
    id: 'view.zoomIn',
    label: 'Zoom In',
    description: 'Increase canvas magnification',
    category: 'Canvas View',
    defaultShortcut: 'Ctrl+=',
  },
  {
    id: 'view.zoomOut',
    label: 'Zoom Out',
    description: 'Decrease canvas magnification',
    category: 'Canvas View',
    defaultShortcut: 'Ctrl+-',
  },
  {
    id: 'view.resetZoom',
    label: 'Reset Zoom & Fit',
    description: 'Fit and center canvas in viewport',
    category: 'Canvas View',
    defaultShortcut: 'Ctrl+0',
  },
  {
    id: 'view.resetRotation',
    label: 'Reset Rotation',
    description: 'Reset canvas angle to 0 deg',
    category: 'Canvas View',
    defaultShortcut: 'Ctrl+Alt+0',
  },
  {
    id: 'view.flipHorizontal',
    label: 'Flip View Horizontally',
    description: 'Non-destructive horizontal canvas mirror',
    category: 'Canvas View',
    defaultShortcut: 'Shift+H',
  },
  {
    id: 'view.flipVertical',
    label: 'Flip View Vertically',
    description: 'Non-destructive vertical canvas mirror',
    category: 'Canvas View',
    defaultShortcut: 'Shift+V',
  },
  {
    id: 'view.straightRuler',
    label: 'Straight Ruler',
    description: 'Toggle interactive straight ruler overlay',
    category: 'Canvas View',
    defaultShortcut: 'R',
  },
  {
    id: 'view.perspectiveRuler',
    label: 'Toggle Perspective Ruler',
    description: 'Add or toggle 2-point perspective ruler',
    category: 'Canvas View',
    defaultShortcut: 'Ctrl+Shift+R',
  },
  {
    id: 'view.perspectiveSnap',
    label: 'Toggle Perspective Snapping',
    description: 'Enable or disable brush snapping to perspective guides',
    category: 'Canvas View',
    defaultShortcut: 'Ctrl+Shift+P',
  },

  // --- Layer ---
  {
    id: 'layer.newRaster',
    label: 'New Raster Layer',
    description: 'Add transparent raster layer',
    category: 'Layer',
    defaultShortcut: 'Ctrl+Shift+N',
  },
  {
    id: 'layer.duplicate',
    label: 'Duplicate Layer',
    description: 'Clone active layer',
    category: 'Layer',
    defaultShortcut: 'Ctrl+J',
  },
  {
    id: 'layer.group',
    label: 'Group Selected Layers',
    description: 'Place selected layers in a folder',
    category: 'Layer',
    defaultShortcut: 'Ctrl+G',
  },

  // --- Edit ---
  {
    id: 'edit.undo',
    label: 'Undo',
    description: 'Undo last canvas action',
    category: 'Edit',
    defaultShortcut: 'Ctrl+Z',
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    description: 'Redo previously undone action',
    category: 'Edit',
    defaultShortcut: 'Ctrl+Y',
    altDefaultShortcut: 'Ctrl+Shift+Z',
  },
  {
    id: 'edit.cut',
    label: 'Cut',
    description: 'Cut active selection or layer to clipboard',
    category: 'Edit',
    defaultShortcut: 'Ctrl+X',
  },
  {
    id: 'edit.copy',
    label: 'Copy',
    description: 'Copy active selection or layer to clipboard',
    category: 'Edit',
    defaultShortcut: 'Ctrl+C',
  },
  {
    id: 'edit.paste',
    label: 'Paste',
    description: 'Paste clipboard contents into a new layer',
    category: 'Edit',
    defaultShortcut: 'Ctrl+V',
  },
  {
    id: 'edit.moveSelectionToNewLayer',
    label: 'Move Selection to New Layer',
    description: 'Cut selected section and paste into a new layer',
    category: 'Edit',
    defaultShortcut: 'Ctrl+Shift+J',
  },
  {
    id: 'edit.delete',
    label: 'Clear / Delete Layer',
    description: 'Clear active selection or delete selected layer',
    category: 'Edit',
    defaultShortcut: 'Delete',
    altDefaultShortcut: 'Backspace',
  },
  {
    id: 'edit.transform',
    label: 'Free Transform',
    description: 'Scale, rotate, or move layer/selection',
    category: 'Edit',
    defaultShortcut: 'Ctrl+T',
  },
  {
    id: 'edit.selectAll',
    label: 'Select All',
    description: 'Select entire canvas',
    category: 'Edit',
    defaultShortcut: 'Ctrl+A',
  },
  {
    id: 'edit.deselect',
    label: 'Deselect',
    description: 'Clear current selection marquee',
    category: 'Edit',
    defaultShortcut: 'Ctrl+D',
  },
  {
    id: 'edit.invertSelection',
    label: 'Invert Selection',
    description: 'Invert active selection mask',
    category: 'Edit',
    defaultShortcut: 'Ctrl+Shift+I',
  },
  {
    id: 'edit.invertColors',
    label: 'Invert Colors',
    description: 'Invert pixel colors on active raster layer',
    category: 'Edit',
    defaultShortcut: 'Ctrl+I',
  },
  {
    id: 'edit.hueSaturation',
    label: 'Hue / Saturation',
    description: 'Open Hue & Saturation tonal correction',
    category: 'Edit',
    defaultShortcut: 'Ctrl+U',
  },
];

// Bidirectional lookup tables for non-alphanumeric keys & layout-independent codes
interface KeyCodeSpec {
  key: string;
  code: string;
  altCodes?: readonly string[];
  aliases?: readonly string[];
}

const SPECIAL_KEY_SPECS: readonly KeyCodeSpec[] = [
  { key: '[', code: 'BracketLeft', aliases: ['bracketleft'] },
  { key: ']', code: 'BracketRight', aliases: ['bracketright'] },
  { key: ',', code: 'Comma', aliases: ['comma', '<'] },
  { key: '.', code: 'Period', aliases: ['period', '>'] },
  { key: '/', code: 'Slash', aliases: ['slash', '?'] },
  { key: '\\', code: 'Backslash', aliases: ['backslash', '|'] },
  { key: ';', code: 'Semicolon', aliases: ['semicolon', ':'] },
  { key: "'", code: 'Quote', aliases: ['quote', '"'] },
  { key: '`', code: 'Backquote', aliases: ['backquote', '~'] },
  { key: '=', code: 'Equal', altCodes: ['NumpadAdd'], aliases: ['equal', 'plus', '+'] },
  { key: '-', code: 'Minus', altCodes: ['NumpadSubtract'], aliases: ['minus', 'subtract', '_'] },
  { key: 'Tab', code: 'Tab', aliases: ['tab'] },
  { key: 'Space', code: 'Space', aliases: ['space', ' '] },
  { key: 'Enter', code: 'Enter', altCodes: ['NumpadEnter'], aliases: ['enter', 'return'] },
  { key: 'Escape', code: 'Escape', aliases: ['escape', 'esc'] },
  { key: 'Delete', code: 'Delete', aliases: ['delete', 'del'] },
  { key: 'Backspace', code: 'Backspace', aliases: ['backspace'] },
  { key: 'ArrowUp', code: 'ArrowUp', aliases: ['arrowup', 'up'] },
  { key: 'ArrowDown', code: 'ArrowDown', aliases: ['arrowdown', 'down'] },
  { key: 'ArrowLeft', code: 'ArrowLeft', aliases: ['arrowleft', 'left'] },
  { key: 'ArrowRight', code: 'ArrowRight', aliases: ['arrowright', 'right'] },
  { key: 'Home', code: 'Home', aliases: ['home'] },
  { key: 'End', code: 'End', aliases: ['end'] },
  { key: 'PageUp', code: 'PageUp', aliases: ['pageup'] },
  { key: 'PageDown', code: 'PageDown', aliases: ['pagedown'] },
];

const PURE_MODIFIER_KEYS = new Set([
  'control',
  'ctrl',
  'shift',
  'alt',
  'meta',
  'os',
  'command',
  'cmd',
]);

const PURE_MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

function resolveKeyToken(rawToken: string): KeyCodeSpec | null {
  const token = rawToken.trim();
  if (!token) return null;
  const lower = token.toLowerCase();

  // Single ASCII letter A-Z
  if (/^[a-z]$/.test(lower)) {
    const upper = lower.toUpperCase();
    return { key: upper, code: `Key${upper}` };
  }

  // Single digit 0-9
  if (/^[0-9]$/.test(token)) {
    return { key: token, code: `Digit${token}`, altCodes: [`Numpad${token}`] };
  }

  // Function keys F1-F12
  const fMatch = /^f([1-9]|1[0-2])$/i.exec(token);
  if (fMatch) {
    const fn = `F${fMatch[1]}`;
    return { key: fn, code: fn };
  }

  // Direct KeyboardEvent.code like KeyB or Digit0
  if (/^Key[A-Z]$/.test(token)) {
    const ch = token.slice(3);
    return { key: ch, code: token };
  }
  if (/^Digit[0-9]$/.test(token)) {
    const d = token.slice(5);
    return { key: d, code: token, altCodes: [`Numpad${d}`] };
  }

  for (const spec of SPECIAL_KEY_SPECS) {
    if (
      spec.key.toLowerCase() === lower ||
      spec.code.toLowerCase() === lower ||
      spec.aliases?.includes(lower)
    ) {
      return spec;
    }
  }

  return null;
}

function resolveEventKeySpec(e: KeyboardEventLike): KeyCodeSpec | null {
  const code = e.code || '';
  if (PURE_MODIFIER_CODES.has(code) || PURE_MODIFIER_KEYS.has((e.key || '').toLowerCase())) {
    return null;
  }

  // Prefer layout-independent physical e.code first
  if (/^Key[A-Z]$/.test(code)) {
    const ch = code.slice(3);
    return { key: ch, code };
  }
  if (/^Digit[0-9]$/.test(code)) {
    const d = code.slice(5);
    return { key: d, code, altCodes: [`Numpad${d}`] };
  }
  if (/^Numpad[0-9]$/.test(code)) {
    const d = code.slice(6);
    return { key: d, code: `Digit${d}`, altCodes: [code] };
  }
  if (/^F([1-9]|1[0-2])$/.test(code)) {
    return { key: code, code };
  }

  for (const spec of SPECIAL_KEY_SPECS) {
    if (spec.code === code || spec.altCodes?.includes(code)) {
      return spec;
    }
  }

  // Fallback to e.key when e.code is absent (e.g. synthetic events)
  if (e.key) {
    return resolveKeyToken(e.key);
  }
  return null;
}

/**
 * Parses a shortcut string such as 'Ctrl+Shift+S', 'Ctrl + ,', '[', or 'Alt+C'.
 * Returns null if invalid or empty.
 */
export function parseShortcut(raw: string): ParsedShortcut | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Handle literal '+' key carefully (e.g. 'Ctrl++' or '+')
  let ctrl = false;
  let shift = false;
  let alt = false;
  let mainToken = '';

  if (trimmed === '+') {
    mainToken = '+';
  } else {
    const parts: string[] = [];
    let buf = '';
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === '+') {
        const cleaned = buf.trim();
        if (cleaned) {
          parts.push(cleaned);
          buf = '';
        } else {
          // Trailing or doubled '+' represents the plus key itself
          buf += '+';
        }
      } else {
        buf += ch;
      }
    }
    if (buf.trim()) parts.push(buf.trim());

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const lower = p.toLowerCase();
      if (i < parts.length - 1) {
        if (lower === 'ctrl' || lower === 'control' || lower === 'cmd' || lower === 'meta') {
          ctrl = true;
          continue;
        }
        if (lower === 'shift') {
          shift = true;
          continue;
        }
        if (lower === 'alt' || lower === 'option') {
          alt = true;
          continue;
        }
      }
      mainToken = p;
    }
  }

  if (!mainToken || PURE_MODIFIER_KEYS.has(mainToken.toLowerCase())) {
    return null;
  }

  const spec = resolveKeyToken(mainToken);
  if (!spec) return null;

  return {
    ctrl,
    shift,
    alt,
    key: spec.key,
    code: spec.code,
    altCodes: spec.altCodes,
  };
}

/**
 * Serializes a ParsedShortcut into canonical storage format: 'Ctrl+Shift+Alt+Key'.
 */
export function serializeShortcut(parsed: ParsedShortcut): string {
  const parts: string[] = [];
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.shift) parts.push('Shift');
  if (parsed.alt) parts.push('Alt');
  parts.push(parsed.key);
  return parts.join('+');
}

/**
 * Normalizes any shortcut string into canonical form, or returns '' if invalid/empty.
 */
export function normalizeShortcut(raw: string): string {
  const parsed = parseShortcut(raw);
  return parsed ? serializeShortcut(parsed) : '';
}

/**
 * Formats a canonical shortcut for clean UI display (e.g. 'Ctrl + Shift + S').
 */
export function formatShortcutLabel(raw: string): string {
  const parsed = parseShortcut(raw);
  if (!parsed) return 'Unassigned';
  const parts: string[] = [];
  if (parsed.ctrl) parts.push('Ctrl');
  if (parsed.shift) parts.push('Shift');
  if (parsed.alt) parts.push('Alt');
  parts.push(parsed.key);
  return parts.join(' + ');
}

/**
 * Captures a canonical shortcut string from a live KeyboardEvent (for click-to-record UI).
 * Returns null for pure modifier presses.
 */
export function formatShortcutFromEvent(e: KeyboardEventLike): string | null {
  const spec = resolveEventKeySpec(e);
  if (!spec) return null;
  return serializeShortcut({
    ctrl: Boolean(e.ctrlKey || e.metaKey),
    shift: Boolean(e.shiftKey),
    alt: Boolean(e.altKey),
    key: spec.key,
    code: spec.code,
    altCodes: spec.altCodes,
  });
}

/**
 * Matches a live KeyboardEvent against a shortcut string (layout-independent via e.code).
 */
export function matchesKeyboardEvent(e: KeyboardEventLike, shortcutStr: string): boolean {
  const parsed = parseShortcut(shortcutStr);
  if (!parsed) return false;

  const eventCtrl = Boolean(e.ctrlKey || e.metaKey);
  const eventShift = Boolean(e.shiftKey);
  const eventAlt = Boolean(e.altKey);

  if (parsed.ctrl !== eventCtrl || parsed.shift !== eventShift || parsed.alt !== eventAlt) {
    return false;
  }

  // For single ASCII letters (e.g. QWERTY, QWERTZ, AZERTY, Dvorak), respect the layout's
  // actual letter so Ctrl+Z on QWERTZ/AZERTY triggers Undo instead of Redo/nothing.
  // For non-Latin layouts (e.g. Cyrillic 'я' on KeyZ), fall through to layout-independent e.code.
  if (e.key && /^[a-zA-Z]$/.test(e.key) && /^Key[A-Z]$/.test(parsed.code)) {
    return e.key.toUpperCase() === parsed.key;
  }

  if (e.code) {
    if (e.code === parsed.code) return true;
    if (parsed.altCodes && parsed.altCodes.includes(e.code)) return true;
    return false;
  }

  const evSpec = resolveEventKeySpec(e);
  return evSpec !== null && evSpec.code === parsed.code;
}

/**
 * Returns the active canonical shortcut string for a command ('' if explicitly cleared).
 */
export function resolveCommandShortcut(
  cmd: CommandDefinition,
  overrides?: ShortcutOverrides
): string {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, cmd.id)) {
    const raw = overrides[cmd.id];
    return raw === '' ? '' : normalizeShortcut(raw);
  }
  return normalizeShortcut(cmd.defaultShortcut);
}

/**
 * Detects other commands currently bound to the same candidate shortcut.
 */
export function findShortcutConflicts(
  commandId: string,
  candidateShortcut: string,
  overrides?: ShortcutOverrides,
  commands: readonly CommandDefinition[] = DEFAULT_COMMANDS
): CommandDefinition[] {
  const canonical = normalizeShortcut(candidateShortcut);
  if (!canonical) return [];

  const conflicts: CommandDefinition[] = [];
  for (const cmd of commands) {
    if (cmd.id === commandId) continue;
    const active = resolveCommandShortcut(cmd, overrides);
    if (active && active === canonical) {
      conflicts.push(cmd);
    }
  }
  return conflicts;
}

export interface ActiveToolHold {
  code: string;
  prevTool: ToolType;
  targetTool: ToolType;
  downAt: number;
  usedWhileHeld: boolean;
}

/**
 * Spring-loaded tool switch controller (CSP-style):
 * - Quick tap (< thresholdMs, unused): permanently switches to targetTool.
 * - Hold (>= thresholdMs) OR pointer used while held: reverts to prevTool on keyup.
 */
export class SpringLoadedToolController {
  private activeHold: ActiveToolHold | null = null;
  private thresholdMs: number;
  private nowFn: () => number;

  constructor(
    thresholdMs: number = SPRING_LOADED_HOLD_MS,
    nowFn: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  ) {
    this.thresholdMs = thresholdMs;
    this.nowFn = nowFn;
  }

  public getActiveHold(): Readonly<ActiveToolHold> | null {
    return this.activeHold;
  }

  /**
   * Call on spring-loaded tool keydown. Returns the tool to activate (or null if already active).
   */
  public handleToolKeyDown(
    code: string,
    targetTool: ToolType,
    currentTool: ToolType
  ): ToolType | null {
    if (currentTool === targetTool) return null;
    this.activeHold = {
      code,
      prevTool: currentTool,
      targetTool,
      downAt: this.nowFn(),
      usedWhileHeld: false,
    };
    return targetTool;
  }

  /**
   * Call when the user starts a pointer interaction while a tool key is held down.
   */
  public markUsedWhileHeld(): void {
    if (this.activeHold) {
      this.activeHold.usedWhileHeld = true;
    }
  }

  /**
   * Call on keyup. Returns the previous tool to restore if spring-loaded revert should trigger, else null.
   */
  public handleKeyUp(code: string, currentTool: ToolType): ToolType | null {
    const hold = this.activeHold;
    if (!hold || hold.code !== code) return null;
    this.activeHold = null;

    const heldMs = this.nowFn() - hold.downAt;
    if ((heldMs >= this.thresholdMs || hold.usedWhileHeld) && currentTool === hold.targetTool) {
      return hold.prevTool;
    }
    return null;
  }

  /**
   * Clears active hold on window blur. Returns prevTool if currently in a spring-loaded hold > threshold.
   */
  public cancel(currentTool?: ToolType): ToolType | null {
    const hold = this.activeHold;
    this.activeHold = null;
    if (!hold || !currentTool) return null;
    const heldMs = this.nowFn() - hold.downAt;
    if ((heldMs >= this.thresholdMs || hold.usedWhileHeld) && currentTool === hold.targetTool) {
      return hold.prevTool;
    }
    return null;
  }
}

/**
 * Centralized Command & Shortcut Manager.
 */
export class ShortcutManager {
  private commands: CommandDefinition[];
  private commandMap: Map<string, CommandDefinition>;
  private overrides: ShortcutOverrides = {};
  private handlers: Map<string, () => void> = new Map();

  constructor(initialCommands: readonly CommandDefinition[] = DEFAULT_COMMANDS) {
    this.commands = initialCommands.map((c) => ({ ...c }));
    this.commandMap = new Map(this.commands.map((c) => [c.id, c]));
  }

  public getCommands(): readonly CommandDefinition[] {
    return this.commands;
  }

  public getCommand(id: string): CommandDefinition | undefined {
    return this.commandMap.get(id);
  }

  public setOverrides(overrides: ShortcutOverrides | undefined): void {
    this.overrides = overrides ? { ...overrides } : {};
  }

  public getOverrides(): ShortcutOverrides {
    return { ...this.overrides };
  }

  public getShortcut(commandId: string): string {
    const cmd = this.commandMap.get(commandId);
    if (!cmd) return '';
    return resolveCommandShortcut(cmd, this.overrides);
  }

  public registerHandler(commandId: string, handler: () => void): void {
    this.handlers.set(commandId, handler);
    const cmd = this.commandMap.get(commandId);
    if (cmd) cmd.handler = handler;
  }

  public registerHandlers(handlerMap: Record<string, () => void>): void {
    for (const [id, fn] of Object.entries(handlerMap)) {
      this.registerHandler(id, fn);
    }
  }

  public clearHandlers(): void {
    this.handlers.clear();
    for (const cmd of this.commands) {
      cmd.handler = undefined;
    }
  }

  public findConflicts(commandId: string, candidateShortcut: string): CommandDefinition[] {
    return findShortcutConflicts(commandId, candidateShortcut, this.overrides, this.commands);
  }

  /**
   * Finds the first matching command for a KeyboardEvent.
   * Respects overrides immediately; falls back to altDefaultShortcut only if not overridden.
   */
  public matchEvent(
    e: KeyboardEventLike,
    overridesOverride?: ShortcutOverrides
  ): CommandDefinition | null {
    const activeOverrides = overridesOverride ?? this.overrides;

    for (const cmd of this.commands) {
      const bound = resolveCommandShortcut(cmd, activeOverrides);
      if (bound && matchesKeyboardEvent(e, bound)) {
        return cmd;
      }
      const isOverridden = Object.prototype.hasOwnProperty.call(activeOverrides, cmd.id);
      if (!isOverridden && cmd.altDefaultShortcut && matchesKeyboardEvent(e, cmd.altDefaultShortcut)) {
        return cmd;
      }
    }
    return null;
  }

  public executeCommand(commandId: string): boolean {
    const fn = this.handlers.get(commandId) ?? this.commandMap.get(commandId)?.handler;
    if (!fn) return false;
    fn();
    return true;
  }
}

export const shortcutManager = new ShortcutManager(DEFAULT_COMMANDS);

// ---------------------------------------------------------------------------
// Modifier Key Settings Helpers (shared by CanvasArea, GlobalShortcutListener, Navigation)
// ---------------------------------------------------------------------------

export interface PointerModifierContext {
  button: number;
  pointerType: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isSpaceDown: boolean;
}

export interface ResolvedPointerModifier {
  slot: ModifierKeySlot;
  action: ModifierAction;
}

/**
 * Resolves the highest-specificity modifier action for a pointerdown event on the canvas.
 */
export function resolvePointerModifierAction(
  ctx: PointerModifierContext,
  settings: ModifierKeySettings = DEFAULT_MODIFIER_KEY_SETTINGS
): ResolvedPointerModifier | null {
  const isPen = ctx.pointerType === 'pen';
  const ctrl = ctx.ctrlKey || ctx.metaKey;

  // 1. Non-primary buttons (Stylus barrel buttons, Right click, Middle click)
  if (isPen) {
    if (ctx.button === 2 || ctx.button === 3) {
      const action = settings.stylusButton1;
      return action !== 'none' ? { slot: 'stylusButton1', action } : null;
    }
    if (ctx.button === 5 || ctx.button === 4) {
      const action = settings.stylusButton2;
      return action !== 'none' ? { slot: 'stylusButton2', action } : null;
    }
  } else {
    if (ctx.button === 2) {
      const action = settings.rightClick;
      return action !== 'none' ? { slot: 'rightClick', action } : null;
    }
    if (ctx.button === 1) {
      const action = settings.middleClick;
      return action !== 'none' ? { slot: 'middleClick', action } : null;
    }
    if (ctx.button === 3) {
      const action = settings.stylusButton1;
      return action !== 'none' ? { slot: 'stylusButton1', action } : null;
    }
    if (ctx.button === 4) {
      const action = settings.stylusButton2;
      return action !== 'none' ? { slot: 'stylusButton2', action } : null;
    }
  }

  // 2. Primary button (button 0) combined with held keyboard modifiers (2-key combos first)
  if (ctx.button === 0) {
    if (ctrl && ctx.altKey && !ctx.isSpaceDown) {
      return settings.ctrlAlt !== 'none' ? { slot: 'ctrlAlt', action: settings.ctrlAlt } : null;
    }
    if (ctx.shiftKey && ctx.altKey && !ctrl && !ctx.isSpaceDown) {
      return settings.shiftAlt !== 'none' ? { slot: 'shiftAlt', action: settings.shiftAlt } : null;
    }
    if (ctrl && ctx.isSpaceDown && !ctx.altKey) {
      return settings.ctrlSpace !== 'none'
        ? { slot: 'ctrlSpace', action: settings.ctrlSpace }
        : null;
    }
    if (ctx.shiftKey && ctx.isSpaceDown && !ctrl && !ctx.altKey) {
      return settings.shiftSpace !== 'none'
        ? { slot: 'shiftSpace', action: settings.shiftSpace }
        : null;
    }
    if (ctx.isSpaceDown && !ctrl && !ctx.altKey && !ctx.shiftKey) {
      return settings.space !== 'none' ? { slot: 'space', action: settings.space } : null;
    }
    if (ctx.altKey && !ctrl && !ctx.shiftKey && !ctx.isSpaceDown) {
      return settings.alt !== 'none' ? { slot: 'alt', action: settings.alt } : null;
    }
    if (ctrl && !ctx.altKey && !ctx.shiftKey && !ctx.isSpaceDown) {
      return settings.ctrl !== 'none' ? { slot: 'ctrl', action: settings.ctrl } : null;
    }
    if (ctx.shiftKey && !ctrl && !ctx.altKey && !ctx.isSpaceDown) {
      return settings.shift !== 'none' ? { slot: 'shift', action: settings.shift } : null;
    }
  }

  return null;
}

/**
 * Resolves the active cursor/hover action for currently held keyboard modifiers (without clicking).
 */
export function resolveHeldKeyModifierAction(
  state: { ctrl: boolean; shift: boolean; alt: boolean; space: boolean },
  settings: ModifierKeySettings = DEFAULT_MODIFIER_KEY_SETTINGS
): ModifierAction {
  if (state.ctrl && state.alt && !state.space) return settings.ctrlAlt;
  if (state.shift && state.alt && !state.ctrl && !state.space) return settings.shiftAlt;
  if (state.ctrl && state.space && !state.alt) return settings.ctrlSpace;
  if (state.shift && state.space && !state.ctrl && !state.alt) return settings.shiftSpace;
  if (state.space && !state.ctrl && !state.alt && !state.shift) return settings.space;
  if (state.alt && !state.ctrl && !state.shift && !state.space) return settings.alt;
  if (state.ctrl && !state.alt && !state.shift && !state.space) return settings.ctrl;
  if (state.shift && !state.ctrl && !state.alt && !state.space) return settings.shift;
  return 'none';
}
