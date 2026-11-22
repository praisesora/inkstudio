import React, { useState, useEffect, useMemo } from 'react';
import { version as APP_VERSION } from '../../package.json';
import { safeLocalStorageSetItem } from '../utils/safeStorage';
import {
  X,
  Palette,
  Layers,
  Paintbrush,
  Keyboard,
  SlidersHorizontal,
  Info,
  RotateCcw,
  Check,
  Search,
  AlertTriangle,
  ArrowDownToLine,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { isTauriEnvironment } from '../hooks/useMultiplayer';
import { updaterService } from '../services/updaterService';
import { useUpdaterStore } from '../stores/useUpdaterStore';
import { getChangelogForVersion } from '../utils/changelog';
import { ChangelogBox } from './ChangelogBox';
import {
  AppSettings,
  DEFAULT_APP_SETTINGS,
  DEFAULT_MODIFIER_KEY_SETTINGS,
  ModifierAction,
  ModifierKeySlot,
  MouseWheelAction,
  ModernAccentColor,
  MODERN_ACCENTS,
  NICKNAME_CUSTOMIZED_STORAGE_KEY,
  NICKNAME_STORAGE_KEY,
  ShortcutCategory,
  resolveModernAccentColor,
} from '../types/settings';
import { CanvasColorMode } from '../types/editor';
import { DPI_PRESETS } from './NewCanvasModal';
import { PressureCurveEditor } from './PressureCurveEditor';
import {
  CommandDefinition,
  DEFAULT_COMMANDS,
  SHORTCUT_CATEGORIES,
  findShortcutConflicts,
  formatShortcutFromEvent,
  formatShortcutLabel,
  resolveCommandShortcut,
} from '../utils/shortcutManager';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdateSettings: (newSettings: AppSettings) => void;
  onShowToast: (message: string) => void;
}

type SettingsTab = 'appearance' | 'canvas' | 'brush' | 'shortcuts' | 'modifiers' | 'about';

const MODIFIER_ACTION_OPTIONS: Array<{ value: ModifierAction; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'pan', label: 'Pan / Hand Tool' },
  { value: 'rotate', label: 'Rotate Canvas' },
  { value: 'zoom-drag', label: 'Scrubby Zoom Drag' },
  { value: 'eyedropper', label: 'Eyedropper (Sample Color)' },
  { value: 'brush-size', label: 'Brush Size & Hardness Drag' },
  { value: 'straight-line', label: 'Straight Line / Angle Snap' },
  { value: 'temp-eraser', label: 'Temporary Eraser' },
  { value: 'quick-palette', label: 'Quick Palette Popover' },
  { value: 'swap-colors', label: 'Swap Primary / Secondary Color' },
  { value: 'undo', label: 'Undo' },
];

const MOUSE_WHEEL_OPTIONS: Array<{ value: MouseWheelAction; label: string }> = [
  { value: 'zoom', label: 'Zoom In / Out' },
  { value: 'scroll', label: 'Scroll / Pan Canvas' },
  { value: 'brush-size', label: 'Adjust Brush Size' },
];

const MODIFIER_SLOTS: Array<{
  slot: ModifierKeySlot;
  label: string;
  desc: string;
}> = [
  { slot: 'space', label: 'Space + Drag', desc: 'Hold Space while dragging on canvas' },
  { slot: 'shift', label: 'Shift', desc: 'Hold Shift while clicking or dragging' },
  { slot: 'ctrl', label: 'Ctrl', desc: 'Hold Ctrl / Cmd while clicking or dragging' },
  { slot: 'alt', label: 'Alt', desc: 'Hold Alt while clicking or hovering' },
  { slot: 'ctrlSpace', label: 'Ctrl + Space + Drag', desc: 'Hold Ctrl + Space and drag' },
  { slot: 'shiftSpace', label: 'Shift + Space + Drag', desc: 'Hold Shift + Space and drag' },
  {
    slot: 'ctrlAlt',
    label: 'Ctrl + Alt + Drag',
    desc: 'Interactive brush size (horizontal) & hardness (vertical)',
  },
  {
    slot: 'shiftAlt',
    label: 'Shift + Alt + Drag',
    desc: 'Alternate brush size / modifier drag combo',
  },
  { slot: 'rightClick', label: 'Right Click', desc: 'Secondary mouse button on canvas' },
  { slot: 'middleClick', label: 'Middle Click', desc: 'Middle mouse button / wheel press' },
  {
    slot: 'stylusButton1',
    label: 'Stylus Barrel Button 1',
    desc: 'Lower stylus side button (or mouse side btn 1)',
  },
  {
    slot: 'stylusButton2',
    label: 'Stylus Barrel Button 2',
    desc: 'Upper stylus side button (or mouse side btn 2)',
  },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onUpdateSettings,
  onShowToast,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');
  const [localSettings, setLocalSettings] = useState<AppSettings>(settings);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<'All' | ShortcutCategory>('All');
  const [recordingCommandId, setRecordingCommandId] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<{
    commandId: string;
    shortcut: string;
    conflicts: CommandDefinition[];
  } | null>(null);

  const isDesktopTauri = isTauriEnvironment();
  const updaterStatus = useUpdaterStore((s) => s.status);
  const runtimeAppVersion = useUpdaterStore((s) => s.currentVersion);
  const availableUpdateVersion = useUpdaterStore((s) => s.availableVersion);
  const updateProgressPercent = useUpdaterStore((s) => s.progressPercent);
  const updateErrorMessage = useUpdaterStore((s) => s.errorMessage);

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (isOpen && isDesktopTauri) {
      void updaterService.resolveCurrentVersion();
    }
  }, [isOpen, isDesktopTauri]);

  useEffect(() => {
    if (!isOpen) {
      setRecordingCommandId(null);
      setPendingConflict(null);
    }
  }, [isOpen]);

  // Global capture listener while recording a shortcut keybinding
  useEffect(() => {
    if (!isOpen || !recordingCommandId) return;

    const handleRecordKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        setRecordingCommandId(null);
        setPendingConflict(null);
        return;
      }

      const captured = formatShortcutFromEvent(e);
      if (!captured) return;

      const conflicts = findShortcutConflicts(
        recordingCommandId,
        captured,
        localSettings.shortcuts
      );
      if (conflicts.length > 0) {
        setPendingConflict({
          commandId: recordingCommandId,
          shortcut: captured,
          conflicts,
        });
        setRecordingCommandId(null);
        return;
      }

      const nextShortcuts = {
        ...localSettings.shortcuts,
        [recordingCommandId]: captured,
      };
      const updated: AppSettings = { ...localSettings, shortcuts: nextShortcuts };
      setLocalSettings(updated);
      onUpdateSettings(updated);
      setRecordingCommandId(null);
      setPendingConflict(null);
    };

    window.addEventListener('keydown', handleRecordKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleRecordKeyDown, true);
    };
  }, [isOpen, recordingCommandId, localSettings, onUpdateSettings]);

  const filteredCommands = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return DEFAULT_COMMANDS.filter((cmd) => {
      if (selectedCategory !== 'All' && cmd.category !== selectedCategory) return false;
      if (!q) return true;
      const bound = formatShortcutLabel(resolveCommandShortcut(cmd, localSettings.shortcuts));
      return (
        cmd.label.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q) ||
        cmd.category.toLowerCase().includes(q) ||
        bound.toLowerCase().includes(q)
      );
    });
  }, [searchQuery, selectedCategory, localSettings.shortcuts]);

  if (!isOpen) return null;

  const handleChange = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const updated = { ...localSettings, [key]: value };
    setLocalSettings(updated);
    onUpdateSettings(updated);
  };

  const handleResetDefaults = () => {
    setRecordingCommandId(null);
    setPendingConflict(null);
    const fresh: AppSettings = {
      ...DEFAULT_APP_SETTINGS,
      shortcuts: {},
      modifierKeys: { ...DEFAULT_MODIFIER_KEY_SETTINGS },
      pressureCurve: {
        ...DEFAULT_APP_SETTINGS.pressureCurve,
        points: DEFAULT_APP_SETTINGS.pressureCurve.points.map(([x, y]) => [x, y]),
      },
    };
    setLocalSettings(fresh);
    onUpdateSettings(fresh);
    onShowToast('Preferences reset to defaults');
  };

  const handleConfirmConflictReplace = () => {
    if (!pendingConflict) return;
    const nextShortcuts = { ...localSettings.shortcuts };
    for (const c of pendingConflict.conflicts) {
      nextShortcuts[c.id] = '';
    }
    nextShortcuts[pendingConflict.commandId] = pendingConflict.shortcut;
    const updated: AppSettings = { ...localSettings, shortcuts: nextShortcuts };
    setLocalSettings(updated);
    onUpdateSettings(updated);
    setPendingConflict(null);
    onShowToast(`Assigned ${formatShortcutLabel(pendingConflict.shortcut)}`);
  };

  const handleResetSingleShortcut = (commandId: string) => {
    const nextShortcuts = { ...localSettings.shortcuts };
    delete nextShortcuts[commandId];
    handleChange('shortcuts', nextShortcuts);
  };

  const handleClearSingleShortcut = (commandId: string) => {
    handleChange('shortcuts', { ...localSettings.shortcuts, [commandId]: '' });
  };

  const handleResetAllShortcuts = () => {
    setRecordingCommandId(null);
    setPendingConflict(null);
    handleChange('shortcuts', {});
    onShowToast('Shortcuts reset to defaults');
  };

  const handleModifierSlotChange = (slot: ModifierKeySlot, action: ModifierAction) => {
    handleChange('modifierKeys', {
      ...localSettings.modifierKeys,
      [slot]: action,
    });
  };

  const handleMouseWheelChange = (action: MouseWheelAction) => {
    handleChange('modifierKeys', {
      ...localSettings.modifierKeys,
      mouseWheel: action,
    });
  };

  const handleResetModifiers = () => {
    handleChange('modifierKeys', { ...DEFAULT_MODIFIER_KEY_SETTINGS });
    onShowToast('Modifier keys reset to defaults');
  };

  const resolvedAccent = resolveModernAccentColor(
    localSettings.modernAccent,
    localSettings.modernCustomColor
  );

  const tabs: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: 'appearance', label: 'Appearance', icon: <Palette className="w-3.5 h-3.5" /> },
    { id: 'canvas', label: 'Canvas', icon: <Layers className="w-3.5 h-3.5" /> },
    { id: 'brush', label: 'Brush & Stylus', icon: <Paintbrush className="w-3.5 h-3.5" /> },
    { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard className="w-3.5 h-3.5" /> },
    {
      id: 'modifiers',
      label: 'Modifier Keys',
      icon: <SlidersHorizontal className="w-3.5 h-3.5" />,
    },
    { id: 'about', label: 'About', icon: <Info className="w-3.5 h-3.5" /> },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 select-none"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !recordingCommandId) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#202020] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.8)] w-full max-w-3xl flex flex-col overflow-hidden text-xs text-[#e5e5e5] h-[600px]"
      >
        {/* Header */}
        <div className="h-10 px-4 flex items-center justify-between bg-[#161616] shrink-0">
          <span className="text-xs font-medium text-[#e5e5e5]">Preferences</span>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
            title="Close (Esc)"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden gap-px bg-[#161616]">
          {/* Left Navigation */}
          <div className="w-44 bg-[#202020] p-2 flex flex-col justify-between shrink-0">
            <div className="space-y-0.5">
              {tabs.map((t) => {
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(t.id);
                      setRecordingCommandId(null);
                      setPendingConflict(null);
                    }}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded text-left transition-colors cursor-pointer ${
                      active
                        ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                        : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/50'
                    }`}
                  >
                    <span className={active ? 'text-[var(--accent)]' : ''}>{t.icon}</span>
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={handleResetDefaults}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset All Defaults</span>
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 p-5 overflow-y-auto bg-[#202020] space-y-5">
            {activeTab === 'appearance' && (
              <>
                <section className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-medium text-[#e5e5e5]">Accent Color</h3>
                      <p className="text-[11px] text-[#8a8a8a]">
                        Updates the <code className="font-mono text-[#e5e5e5]">--accent</code> CSS variable across controls and sliders
                      </p>
                    </div>
                    <span
                      className="w-4 h-4 rounded-full shrink-0 shadow-[0_0_0_1px_rgba(255,255,255,0.2)]"
                      style={{ backgroundColor: resolvedAccent }}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-1.5">
                    {(Object.keys(MODERN_ACCENTS) as Array<Exclude<ModernAccentColor, 'custom'>>).map(
                      (accKey) => {
                        const acc = MODERN_ACCENTS[accKey];
                        const isSelected = localSettings.modernAccent === accKey;
                        return (
                          <button
                            key={accKey}
                            type="button"
                            onClick={() => handleChange('modernAccent', accKey)}
                            className={`flex items-center gap-2 px-2.5 py-2 rounded text-xs transition-colors cursor-pointer ${
                              isSelected
                                ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                                : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                            }`}
                          >
                            <span
                              className="w-3 h-3 rounded-full shrink-0"
                              style={{ backgroundColor: acc.hex }}
                            />
                            <span className="truncate">{acc.label}</span>
                            {isSelected && <Check className="w-3 h-3 ml-auto text-[var(--accent)]" />}
                          </button>
                        );
                      }
                    )}

                    <button
                      type="button"
                      onClick={() => handleChange('modernAccent', 'custom')}
                      className={`flex items-center gap-2 px-2.5 py-2 rounded text-xs transition-colors cursor-pointer ${
                        localSettings.modernAccent === 'custom'
                          ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                          : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                      }`}
                    >
                      <span
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{ backgroundColor: localSettings.modernCustomColor || '#e5e5e5' }}
                      />
                      <span className="truncate">Custom</span>
                      {localSettings.modernAccent === 'custom' && (
                        <Check className="w-3 h-3 ml-auto text-[var(--accent)]" />
                      )}
                    </button>
                  </div>

                  <div className="flex items-center gap-2.5 p-2.5 rounded bg-[#161616]">
                    <input
                      type="color"
                      value={resolvedAccent}
                      onChange={(e) => {
                        const hex = e.target.value;
                        const updated: AppSettings = {
                          ...localSettings,
                          themePreset: 'modern',
                          modernAccent: 'custom',
                          modernCustomColor: hex,
                        };
                        setLocalSettings(updated);
                        onUpdateSettings(updated);
                      }}
                      className="w-7 h-7 rounded cursor-pointer bg-transparent border-0 p-0 shrink-0"
                      title="Pick Custom Accent Color"
                    />
                    <div className="flex-1">
                      <span className="text-[10px] text-[#8a8a8a] block mb-0.5">Custom Hex</span>
                      <input
                        type="text"
                        value={
                          localSettings.modernAccent === 'custom'
                            ? localSettings.modernCustomColor
                            : resolvedAccent
                        }
                        onChange={(e) => {
                          const val = e.target.value;
                          const updated: AppSettings = {
                            ...localSettings,
                            themePreset: 'modern',
                            modernAccent: 'custom',
                            modernCustomColor: val,
                          };
                          setLocalSettings(updated);
                          if (/^#[0-9a-fA-F]{6}$/i.test(val)) {
                            onUpdateSettings(updated);
                          }
                        }}
                        placeholder="#e5e5e5"
                        maxLength={7}
                        className="w-full bg-[#202020] px-2 py-1 rounded font-mono text-xs text-[#e5e5e5]"
                      />
                    </div>
                  </div>
                </section>

                <section className="space-y-2">
                  <h3 className="text-xs font-medium text-[#e5e5e5]">Artist Name</h3>
                  <input
                    type="text"
                    value={localSettings.userName || ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      handleChange('userName', val);
                      safeLocalStorageSetItem(NICKNAME_STORAGE_KEY, val, 'artist name');
                      safeLocalStorageSetItem(NICKNAME_CUSTOMIZED_STORAGE_KEY, val.trim() ? '1' : '0', 'artist name flag');
                    }}
                    placeholder="Artist"
                    className="w-full bg-[#161616] px-3 py-1.5 rounded text-xs text-[#e5e5e5] placeholder-[#8a8a8a]/50"
                  />
                </section>

                <section className="space-y-2">
                  <h3 className="text-xs font-medium text-[#e5e5e5]">Viewport Overlays</h3>
                  <div className="space-y-1 bg-[#161616] rounded p-2.5">
                    <label className="flex items-center justify-between py-1 cursor-pointer">
                      <span className="text-xs text-[#e5e5e5]">Transparency Checkerboard</span>
                      <input
                        type="checkbox"
                        checked={localSettings.showCheckerboard}
                        onChange={(e) => handleChange('showCheckerboard', e.target.checked)}
                      />
                    </label>
                    <label className="flex items-center justify-between py-1 cursor-pointer">
                      <span className="text-xs text-[#e5e5e5]">Cursor Coordinates</span>
                      <input
                        type="checkbox"
                        checked={localSettings.showCursorCoordinates}
                        onChange={(e) => handleChange('showCursorCoordinates', e.target.checked)}
                      />
                    </label>
                    <label className="flex items-center justify-between py-1 cursor-pointer">
                      <span className="text-xs text-[#e5e5e5]">Stylus Pressure Readout</span>
                      <input
                        type="checkbox"
                        checked={localSettings.showPressureInStatusBar}
                        onChange={(e) => handleChange('showPressureInStatusBar', e.target.checked)}
                      />
                    </label>
                  </div>
                </section>
              </>
            )}

            {activeTab === 'canvas' && (
              <>
                <section className="space-y-2">
                  <h3 className="text-xs font-medium text-[#e5e5e5]">Default Dimensions</h3>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-[11px] text-[#8a8a8a]">Width (px)</label>
                      <input
                        type="number"
                        min="64"
                        max="16384"
                        value={localSettings.defaultWidth}
                        onChange={(e) => handleChange('defaultWidth', Number(e.target.value))}
                        className="w-full bg-[#161616] px-2.5 py-1.5 rounded font-mono text-xs text-[#e5e5e5]"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-[#8a8a8a]">Height (px)</label>
                      <input
                        type="number"
                        min="64"
                        max="16384"
                        value={localSettings.defaultHeight}
                        onChange={(e) => handleChange('defaultHeight', Number(e.target.value))}
                        className="w-full bg-[#161616] px-2.5 py-1.5 rounded font-mono text-xs text-[#e5e5e5]"
                      />
                    </div>
                  </div>
                </section>

                <section className="space-y-2">
                  <h3 className="text-xs font-medium text-[#e5e5e5]">Resolution (DPI)</h3>
                  <div className="grid grid-cols-6 gap-1.5">
                    {DPI_PRESETS.map((p) => {
                      const selected = localSettings.defaultDpi === p.dpi;
                      return (
                        <button
                          key={p.dpi}
                          type="button"
                          onClick={() => handleChange('defaultDpi', p.dpi)}
                          className={`py-1.5 rounded font-mono text-xs cursor-pointer transition-colors ${
                            selected
                              ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                              : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5]'
                          }`}
                        >
                          {p.dpi}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="space-y-2">
                  <h3 className="text-xs font-medium text-[#e5e5e5]">Color Mode</h3>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(['color', 'grayscale', 'monochrome'] as CanvasColorMode[]).map((mode) => {
                      const selected = localSettings.defaultColorMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => handleChange('defaultColorMode', mode)}
                          className={`p-2 rounded text-left capitalize cursor-pointer transition-colors ${
                            selected
                              ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                              : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5]'
                          }`}
                        >
                          {mode}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-medium text-[#e5e5e5]">Tile RAM Budget</h3>
                    <span className="font-mono text-xs text-[#e5e5e5]">
                      {localSettings.tileMemoryBudgetMb || 1024} MB
                    </span>
                  </div>
                  <input
                    type="range"
                    min="512"
                    max="4096"
                    step="128"
                    value={localSettings.tileMemoryBudgetMb || 1024}
                    onChange={(e) => handleChange('tileMemoryBudgetMb', Number(e.target.value))}
                    className="w-full"
                  />
                </section>
              </>
            )}

            {activeTab === 'brush' && (
              <>
                <PressureCurveEditor
                  value={localSettings.pressureCurve}
                  onChange={(nextCurve) => handleChange('pressureCurve', nextCurve)}
                />

                <section className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-medium text-[#e5e5e5]">Default Stabilization</h3>
                    <span className="font-mono text-xs text-[#e5e5e5]">
                      {localSettings.defaultStabilization}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="50"
                    value={localSettings.defaultStabilization}
                    onChange={(e) => handleChange('defaultStabilization', Number(e.target.value))}
                    className="w-full"
                  />
                </section>

                <section className="space-y-1 bg-[#161616] rounded p-2.5">
                  <label className="flex items-center justify-between py-1 cursor-pointer">
                    <span className="text-xs text-[#e5e5e5]">Stylus Pressure Sensitivity</span>
                    <input
                      type="checkbox"
                      checked={localSettings.usePressureByDefault}
                      onChange={(e) => handleChange('usePressureByDefault', e.target.checked)}
                    />
                  </label>
                  <label className="flex items-center justify-between py-1 cursor-pointer">
                    <span className="text-xs text-[#e5e5e5]">Bezier Curve Smoothing</span>
                    <input
                      type="checkbox"
                      checked={localSettings.smoothingEnabled}
                      onChange={(e) => handleChange('smoothingEnabled', e.target.checked)}
                    />
                  </label>
                </section>

                <section className="space-y-2">
                  <h3 className="text-xs font-medium text-[#e5e5e5]">Undo History Limit</h3>
                  <div className="grid grid-cols-4 gap-1.5">
                    {[25, 50, 75, 100].map((steps) => {
                      const selected = localSettings.maxHistorySteps === steps;
                      return (
                        <button
                          key={steps}
                          type="button"
                          onClick={() => handleChange('maxHistorySteps', steps)}
                          className={`py-1.5 rounded font-mono text-xs cursor-pointer transition-colors ${
                            selected
                              ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                              : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5]'
                          }`}
                        >
                          {steps}
                        </button>
                      );
                    })}
                  </div>
                </section>
              </>
            )}

            {activeTab === 'shortcuts' && (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="w-3.5 h-3.5 text-[#8a8a8a] absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Search commands or keys..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full bg-[#161616] rounded pl-8 pr-3 py-1.5 text-xs text-[#e5e5e5] placeholder-[#8a8a8a]"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleResetAllShortcuts}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer shrink-0"
                    title="Reset all keybindings to defaults"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Reset</span>
                  </button>
                </div>

                {/* Category Filter Pills */}
                <div className="flex flex-wrap gap-1">
                  {(['All', ...SHORTCUT_CATEGORIES] as const).map((cat) => {
                    const active = selectedCategory === cat;
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setSelectedCategory(cat)}
                        className={`px-2.5 py-1 rounded text-[11px] transition-colors cursor-pointer ${
                          active
                            ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium ring-1 ring-[var(--accent-border)]'
                            : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5]'
                        }`}
                      >
                        {cat}
                      </button>
                    );
                  })}
                </div>

                {/* Conflict Resolution Banner */}
                {pendingConflict && (
                  <div className="p-2.5 rounded bg-amber-500/10 border border-amber-500/40 flex items-center justify-between gap-2 text-[11px]">
                    <div className="flex items-center gap-2 text-amber-200">
                      <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
                      <span>
                        <strong className="font-mono">
                          {formatShortcutLabel(pendingConflict.shortcut)}
                        </strong>{' '}
                        conflicts with{' '}
                        <strong>
                          {pendingConflict.conflicts.map((c) => c.label).join(', ')}
                        </strong>
                        . Reassign anyway?
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={handleConfirmConflictReplace}
                        className="px-2 py-1 rounded bg-amber-500 text-black font-medium cursor-pointer"
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingConflict(null)}
                        className="px-2 py-1 rounded bg-[#161616] text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                <div className="space-y-0.5">
                  {filteredCommands.map((cmd) => {
                    const activeKey = resolveCommandShortcut(cmd, localSettings.shortcuts);
                    const isRecording = recordingCommandId === cmd.id;
                    const isOverridden = Object.prototype.hasOwnProperty.call(
                      localSettings.shortcuts,
                      cmd.id
                    );
                    return (
                      <div
                        key={cmd.id}
                        className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded hover:bg-[#2c2c2c]/50"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-[#e5e5e5] truncate">{cmd.label}</span>
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#161616] text-[#8a8a8a]">
                              {cmd.category}
                            </span>
                            {cmd.springLoaded && (
                              <span
                                className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent-subtle)] text-[var(--accent)]"
                                title="Hold key > 250ms to temporarily activate and revert on release"
                              >
                                Hold
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-[#8a8a8a] truncate">
                            {cmd.description}
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setPendingConflict(null);
                              setRecordingCommandId(isRecording ? null : cmd.id);
                            }}
                            className={`px-2 py-1 rounded font-mono text-[10px] min-w-[84px] text-center transition-colors cursor-pointer ${
                              isRecording
                                ? 'bg-[var(--accent)] text-[var(--accent-contrast)] font-semibold'
                                : activeKey
                                ? 'bg-[#161616] text-[#e5e5e5] hover:bg-[#2c2c2c]'
                                : 'bg-[#161616] text-[#8a8a8a] italic hover:bg-[#2c2c2c]'
                            }`}
                            title="Click and press a key combination to rebind"
                          >
                            {isRecording ? 'Press keys...' : formatShortcutLabel(activeKey)}
                          </button>
                          {activeKey && (
                            <button
                              type="button"
                              onClick={() => handleClearSingleShortcut(cmd.id)}
                              className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#161616] cursor-pointer"
                              title="Unbind shortcut"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                          {isOverridden && (
                            <button
                              type="button"
                              onClick={() => handleResetSingleShortcut(cmd.id)}
                              className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#161616] cursor-pointer"
                              title={`Reset to default (${formatShortcutLabel(cmd.defaultShortcut)})`}
                            >
                              <RotateCcw className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTab === 'modifiers' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-medium text-[#e5e5e5]">Modifier Key Settings</h3>
                    <p className="text-[11px] text-[#8a8a8a]">
                      Configure hold-to-act keys, mouse buttons, stylus barrel buttons, and scroll wheel
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleResetModifiers}
                    className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Reset</span>
                  </button>
                </div>

                {/* Mouse Wheel */}
                <div className="flex items-center justify-between gap-3 px-3 py-2 rounded bg-[#161616]">
                  <div>
                    <div className="text-xs text-[#e5e5e5] font-medium">Mouse Wheel</div>
                    <div className="text-[10px] text-[#8a8a8a]">
                      Action when scrolling wheel over the canvas viewport
                    </div>
                  </div>
                  <select
                    value={localSettings.modifierKeys.mouseWheel}
                    onChange={(e) => handleMouseWheelChange(e.target.value as MouseWheelAction)}
                    className="bg-[#202020] text-[#e5e5e5] text-xs px-2.5 py-1.5 rounded border border-white/10 cursor-pointer"
                  >
                    {MOUSE_WHEEL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Keyboard, Mouse & Stylus Modifier Slots */}
                <div className="space-y-1">
                  {MODIFIER_SLOTS.map(({ slot, label, desc }) => (
                    <div
                      key={slot}
                      className="flex items-center justify-between gap-3 px-3 py-2 rounded bg-[#161616]"
                    >
                      <div className="min-w-0">
                        <div className="text-xs text-[#e5e5e5] font-mono">{label}</div>
                        <div className="text-[10px] text-[#8a8a8a] truncate">{desc}</div>
                      </div>
                      <select
                        value={localSettings.modifierKeys[slot]}
                        onChange={(e) =>
                          handleModifierSlotChange(slot, e.target.value as ModifierAction)
                        }
                        className="bg-[#202020] text-[#e5e5e5] text-xs px-2.5 py-1.5 rounded border border-white/10 cursor-pointer shrink-0"
                      >
                        {MODIFIER_ACTION_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'about' && (
              <div className="space-y-4">
                <div className="p-4 rounded bg-[#161616] flex items-center gap-3.5">
                  <img
                    src="/app-icon.png"
                    alt="Ink Studio"
                    className="w-10 h-10 object-contain shrink-0"
                  />
                  <div>
                    <h2 className="text-sm font-semibold text-[#e5e5e5]">Ink Studio</h2>
                    <p className="text-[11px] font-mono text-[#8a8a8a]">
                      v{runtimeAppVersion || APP_VERSION} · Collaborative Drawing Studio · by Sora
                    </p>
                  </div>
                </div>
                <p className="text-xs text-[#8a8a8a] leading-relaxed">
                  Collaborative Drawing Studio supporting layered PSD/CSP workflows, GPU tile compositing, stylus pressure dynamics, vector inking, and real-time multiplayer drawing.
                </p>

                {(() => {
                  const activeVer = runtimeAppVersion || APP_VERSION;
                  const changelogEntry =
                    getChangelogForVersion(activeVer) ?? getChangelogForVersion();
                  if (!changelogEntry) return null;
                  return (
                    <section className="space-y-2 pt-2 border-t border-[#2c2c2c]">
                      <div className="flex items-center justify-between">
                        <h3 className="text-xs font-medium text-[#e5e5e5]">
                          What&apos;s New in v{changelogEntry.version}
                        </h3>
                      </div>
                      <ChangelogBox entry={changelogEntry} maxHeightClass="max-h-48" />
                    </section>
                  );
                })()}

                {isDesktopTauri && (
                  <section className="space-y-2.5 pt-2 border-t border-[#2c2c2c]">
                    <div>
                      <h3 className="text-xs font-medium text-[#e5e5e5]">Updates</h3>
                      <p className="text-[11px] text-[#8a8a8a]">
                        Keep Ink Studio up to date with the latest desktop releases
                      </p>
                    </div>

                    <div className="bg-[#161616] rounded p-3 space-y-3">
                      <label className="flex items-center justify-between py-0.5 cursor-pointer">
                        <span className="text-xs text-[#e5e5e5]">
                          Automatically check for updates on startup
                        </span>
                        <input
                          type="checkbox"
                          checked={localSettings.autoCheckUpdates}
                          onChange={(e) => handleChange('autoCheckUpdates', e.target.checked)}
                        />
                      </label>

                      <div className="pt-2.5 border-t border-[#2c2c2c] flex items-center justify-between gap-3">
                        <div className="min-w-0 text-[11px]">
                          {updaterStatus === 'checking' && (
                            <span className="text-[#8a8a8a]">Checking for updates...</span>
                          )}
                          {updaterStatus === 'up-to-date' && (
                            <span className="text-emerald-400">Up to date</span>
                          )}
                          {updaterStatus === 'available' && availableUpdateVersion && (
                            <span className="text-[var(--accent)] font-medium">
                              Update v{availableUpdateVersion} available
                            </span>
                          )}
                          {updaterStatus === 'downloading' && (
                            <span className="text-[var(--accent)] font-mono">
                              Downloading update... {updateProgressPercent}%
                            </span>
                          )}
                          {updaterStatus === 'ready' && (
                            <span className="text-emerald-400">
                              Update ready — restarting...
                            </span>
                          )}
                          {updaterStatus === 'error' && (
                            <span className="text-red-400 break-words">
                              {updateErrorMessage || 'Failed to check for updates'}
                            </span>
                          )}
                          {updaterStatus === 'idle' && (
                            <span className="text-[#8a8a8a]">
                              Current version: <span className="font-mono">v{runtimeAppVersion || APP_VERSION}</span>
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {(updaterStatus === 'available' || updaterStatus === 'downloading') && (
                            <button
                              type="button"
                              onClick={() => {
                                onClose();
                                updaterService.openUpdateModal();
                              }}
                              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 text-[11px] font-medium transition-opacity cursor-pointer"
                            >
                              <ArrowDownToLine className="w-3 h-3" />
                              <span>
                                {updaterStatus === 'downloading' ? 'View Progress' : 'View Update'}
                              </span>
                            </button>
                          )}

                          <button
                            type="button"
                            disabled={
                              updaterStatus === 'checking' ||
                              updaterStatus === 'downloading' ||
                              updaterStatus === 'ready'
                            }
                            onClick={() => void updaterService.checkForUpdates({ silent: false })}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[#2c2c2c] hover:bg-[#383838] disabled:opacity-50 disabled:cursor-not-allowed text-[#e5e5e5] text-[11px] font-medium transition-colors cursor-pointer"
                          >
                            {updaterStatus === 'checking' ? (
                              <Loader2 className="w-3 h-3 animate-spin text-[var(--accent)]" />
                            ) : (
                              <RefreshCw className="w-3 h-3" />
                            )}
                            <span>Check for Updates</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
