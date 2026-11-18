import React, { useState, useEffect } from 'react';
import {
  X,
  Palette,
  Layers,
  Paintbrush,
  Keyboard,
  Info,
  RotateCcw,
  Check,
  Search,
} from 'lucide-react';
import {
  AppSettings,
  DEFAULT_APP_SETTINGS,
  ModernAccentColor,
  MODERN_ACCENTS,
  resolveModernAccentColor,
} from '../types/settings';
import { CanvasColorMode } from '../types/editor';
import { DPI_PRESETS } from './NewCanvasModal';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdateSettings: (newSettings: AppSettings) => void;
  onShowToast: (message: string) => void;
}

type SettingsTab = 'appearance' | 'canvas' | 'brush' | 'shortcuts' | 'about';

interface ShortcutRow {
  category: string;
  action: string;
  shortcut: string;
  desc: string;
}

const SHORTCUTS_DATA: ShortcutRow[] = [
  { category: 'File', action: 'New Canvas', shortcut: 'Ctrl + N', desc: 'Create a new canvas' },
  { category: 'File', action: 'Open File', shortcut: 'Ctrl + O', desc: 'Open images, PSD, or CSP files' },
  { category: 'File', action: 'Save', shortcut: 'Ctrl + S', desc: 'Save current document' },
  { category: 'File', action: 'Save As', shortcut: 'Ctrl + Shift + S', desc: 'Save as a new file' },
  { category: 'Edit', action: 'Undo', shortcut: 'Ctrl + Z', desc: 'Undo last action' },
  { category: 'Edit', action: 'Redo', shortcut: 'Ctrl + Y', desc: 'Redo undone action' },
  { category: 'Edit', action: 'Copy Layer', shortcut: 'Ctrl + C', desc: 'Copy selected layer' },
  { category: 'Edit', action: 'Paste Layer', shortcut: 'Ctrl + V', desc: 'Paste copied layer' },
  { category: 'Edit', action: 'Delete Layer', shortcut: 'Del', desc: 'Delete selected layer' },
  { category: 'Edit', action: 'Preferences', shortcut: 'Ctrl + ,', desc: 'Open preferences' },
  { category: 'Tools', action: 'Brush Tool', shortcut: 'B', desc: 'Switch to brush' },
  { category: 'Tools', action: 'Eraser Tool', shortcut: 'E', desc: 'Switch to eraser' },
  { category: 'Tools', action: 'Swap Colors', shortcut: 'X', desc: 'Swap primary and secondary colors' },
  { category: 'Tools', action: 'Brush Size & Hardness', shortcut: 'Ctrl + Alt + Drag', desc: 'Horizontal: size, Vertical: hardness' },
  { category: 'Navigation', action: 'Pan Canvas', shortcut: 'Space + Drag', desc: 'Pan viewport' },
  { category: 'Navigation', action: 'Rotate Canvas', shortcut: 'Shift + Space + Drag', desc: 'Rotate viewport' },
  { category: 'Navigation', action: 'Zoom In / Out', shortcut: 'Ctrl + +/-', desc: 'Adjust magnification' },
  { category: 'Navigation', action: 'Reset Zoom', shortcut: 'Ctrl + 0', desc: 'Fit & center canvas' },
  { category: 'Navigation', action: 'Reset Rotation', shortcut: 'Ctrl + Alt + 0', desc: 'Reset angle to 0°' },
  { category: 'Layers', action: 'New Raster Layer', shortcut: 'Ctrl + Shift + N', desc: 'Add transparent layer' },
  { category: 'Layers', action: 'Duplicate Layer', shortcut: 'Ctrl + J', desc: 'Clone current layer' },
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

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  if (!isOpen) return null;

  const handleChange = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const updated = { ...localSettings, [key]: value };
    setLocalSettings(updated);
    onUpdateSettings(updated);
  };

  const handleResetDefaults = () => {
    setLocalSettings(DEFAULT_APP_SETTINGS);
    onUpdateSettings(DEFAULT_APP_SETTINGS);
    onShowToast('Preferences reset to defaults');
  };

  const filteredShortcuts = SHORTCUTS_DATA.filter(
    (s) =>
      s.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.shortcut.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.desc.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const resolvedAccent = resolveModernAccentColor(
    localSettings.modernAccent,
    localSettings.modernCustomColor
  );

  const tabs: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: 'appearance', label: 'Appearance', icon: <Palette className="w-3.5 h-3.5" /> },
    { id: 'canvas', label: 'Canvas', icon: <Layers className="w-3.5 h-3.5" /> },
    { id: 'brush', label: 'Brush & Stylus', icon: <Paintbrush className="w-3.5 h-3.5" /> },
    { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard className="w-3.5 h-3.5" /> },
    { id: 'about', label: 'About', icon: <Info className="w-3.5 h-3.5" /> },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 select-none"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#202020] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.8)] w-full max-w-2xl flex flex-col overflow-hidden text-xs text-[#e5e5e5] h-[520px]"
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
          <div className="w-40 bg-[#202020] p-2 flex flex-col justify-between shrink-0">
            <div className="space-y-0.5">
              {tabs.map((t) => {
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setActiveTab(t.id)}
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
              <span>Reset Defaults</span>
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 p-5 overflow-y-auto bg-[#202020] space-y-5">
            {activeTab === 'appearance' && (
              <>
                {/* Accent Color Customization */}
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

                  {/* Custom Hex & Native Picker */}
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

                {/* User Profile */}
                <section className="space-y-2">
                  <h3 className="text-xs font-medium text-[#e5e5e5]">Artist Name</h3>
                  <input
                    type="text"
                    value={localSettings.userName || ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      handleChange('userName', val);
                      try {
                        localStorage.setItem('sora_paint_nickname', val);
                      } catch {
                        // ignore
                      }
                    }}
                    placeholder="Artist"
                    className="w-full bg-[#161616] px-3 py-1.5 rounded text-xs text-[#e5e5e5] placeholder-[#8a8a8a]/50"
                  />
                </section>

                {/* Overlays */}
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
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-[#8a8a8a] absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Filter shortcuts..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-[#161616] rounded pl-8 pr-3 py-1.5 text-xs text-[#e5e5e5] placeholder-[#8a8a8a]"
                  />
                </div>
                <div className="space-y-0.5">
                  {filteredShortcuts.map((row, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between px-2.5 py-1.5 rounded hover:bg-[#2c2c2c]/50"
                    >
                      <div>
                        <div className="text-xs text-[#e5e5e5]">{row.action}</div>
                        <div className="text-[10px] text-[#8a8a8a]">{row.desc}</div>
                      </div>
                      <kbd className="px-2 py-0.5 rounded bg-[#161616] font-mono text-[10px] text-[#e5e5e5]">
                        {row.shortcut}
                      </kbd>
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
                    <p className="text-[11px] font-mono text-[#8a8a8a]">v0.1.0</p>
                  </div>
                </div>
                <p className="text-xs text-[#8a8a8a] leading-relaxed">
                  Digital drawing and manga studio supporting layered PSD/CSP workflows, GPU tile compositing, stylus pressure dynamics, and 1-bit monochrome inking.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
