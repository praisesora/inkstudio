import React, { useState } from 'react';
import {
  X,
  Palette,
  Layers,
  Paintbrush,
  Keyboard,
  Sparkles,
  RotateCcw,
  Check,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react';
import { AppSettings, DEFAULT_APP_SETTINGS } from '../types/settings';
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
  // File
  { category: 'File', action: 'New Canvas', shortcut: 'Ctrl + N', desc: 'Create a new canvas with custom dimensions' },
  { category: 'File', action: 'Open File', shortcut: 'Ctrl + O', desc: 'Open images, PSD, or CSP files' },
  { category: 'File', action: 'Save', shortcut: 'Ctrl + S', desc: 'Save current document or export changes' },
  { category: 'File', action: 'Save As', shortcut: 'Ctrl + Shift + S', desc: 'Save as a new layered file or image format' },
  // Edit
  { category: 'Edit', action: 'Undo', shortcut: 'Ctrl + Z', desc: 'Undo last drawing or layer action' },
  { category: 'Edit', action: 'Redo', shortcut: 'Ctrl + Y', desc: 'Redo previously undone action' },
  { category: 'Edit', action: 'Copy Layer', shortcut: 'Ctrl + C', desc: 'Copy selected layer to clipboard' },
  { category: 'Edit', action: 'Paste Layer', shortcut: 'Ctrl + V', desc: 'Paste copied layer or clipboard image' },
  { category: 'Edit', action: 'Delete Layer', shortcut: 'Del', desc: 'Delete currently selected layer' },
  { category: 'Edit', action: 'Settings', shortcut: 'Ctrl + ,', desc: 'Open application preferences' },
  // Tools
  { category: 'Tools', action: 'Brush Tool', shortcut: 'B', desc: 'Switch to drawing brush' },
  { category: 'Tools', action: 'Eraser Tool', shortcut: 'E', desc: 'Switch to transparent eraser' },
  { category: 'Tools', action: 'Swap Colors', shortcut: 'X', desc: 'Swap primary and secondary colors' },
  { category: 'Tools', action: 'Adjust Brush Size & Hardness', shortcut: 'Ctrl + Alt + Drag', desc: 'Horizontal: size, Vertical: hardness' },
  // Navigation
  { category: 'Navigation', action: 'Pan Canvas', shortcut: 'Space + Drag', desc: 'Move viewport across canvas' },
  { category: 'Navigation', action: 'Rotate Canvas', shortcut: 'Shift + Space + Drag', desc: 'Freely rotate canvas at any angle' },
  { category: 'Navigation', action: 'Zoom In', shortcut: 'Ctrl + +', desc: 'Increase canvas magnification' },
  { category: 'Navigation', action: 'Zoom Out', shortcut: 'Ctrl + -', desc: 'Decrease canvas magnification' },
  { category: 'Navigation', action: 'Reset Zoom & Center', shortcut: 'Ctrl + 0', desc: 'Fit canvas into viewport center' },
  { category: 'Navigation', action: 'Reset Rotation', shortcut: 'Ctrl + Alt + 0', desc: 'Snap canvas back to 0° upright' },
  // Layers
  { category: 'Layers', action: 'New Raster Layer', shortcut: 'Ctrl + Shift + N', desc: 'Add a new blank transparent layer' },
  { category: 'Layers', action: 'Duplicate Layer', shortcut: 'Ctrl + J', desc: 'Clone current layer with all pixel contents' },
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

  if (!isOpen) return null;

  const handleChange = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const updated = { ...localSettings, [key]: value };
    setLocalSettings(updated);
    onUpdateSettings(updated);
  };

  const handleResetDefaults = () => {
    setLocalSettings(DEFAULT_APP_SETTINGS);
    onUpdateSettings(DEFAULT_APP_SETTINGS);
    onShowToast('Settings reset to default values');
  };

  const filteredShortcuts = SHORTCUTS_DATA.filter(
    (s) =>
      s.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.shortcut.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.desc.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 select-none animate-in fade-in duration-150"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="bg-[#222224] border border-[#3e3e42] rounded-lg shadow-2xl w-full max-w-3xl flex flex-col overflow-hidden text-xs text-[#cccccc] h-[580px]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-[#2a2a2d] border-b border-[#38383a] shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="w-5 h-5 rounded-[3px] bg-[#007acc]/20 border border-[#007acc]/40 flex items-center justify-center text-[#38bdf8]">
              <SettingsIcon className="w-3.5 h-3.5" />
            </div>
            <h2 className="text-sm font-semibold text-white tracking-wide">Application Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#38383a] text-[#888888] hover:text-white transition-colors"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body: Left Tabs + Right Content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left Tabs Bar */}
          <div className="w-48 bg-[#1a1a1c] border-r border-[#333336] p-2 space-y-1 shrink-0 flex flex-col justify-between">
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setActiveTab('appearance')}
                className={`w-full flex items-center space-x-2.5 px-3 py-2 rounded text-left transition-colors ${
                  activeTab === 'appearance'
                    ? 'bg-[#007acc] text-white font-medium shadow-xs'
                    : 'text-[#aaaaaa] hover:bg-[#252528] hover:text-white'
                }`}
              >
                <Palette className="w-4 h-4 shrink-0" />
                <span>Appearance</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('canvas')}
                className={`w-full flex items-center space-x-2.5 px-3 py-2 rounded text-left transition-colors ${
                  activeTab === 'canvas'
                    ? 'bg-[#007acc] text-white font-medium shadow-xs'
                    : 'text-[#aaaaaa] hover:bg-[#252528] hover:text-white'
                }`}
              >
                <Layers className="w-4 h-4 shrink-0" />
                <span>Canvas Defaults</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('brush')}
                className={`w-full flex items-center space-x-2.5 px-3 py-2 rounded text-left transition-colors ${
                  activeTab === 'brush'
                    ? 'bg-[#007acc] text-white font-medium shadow-xs'
                    : 'text-[#aaaaaa] hover:bg-[#252528] hover:text-white'
                }`}
              >
                <Paintbrush className="w-4 h-4 shrink-0" />
                <span>Brush & Stylus</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('shortcuts')}
                className={`w-full flex items-center space-x-2.5 px-3 py-2 rounded text-left transition-colors ${
                  activeTab === 'shortcuts'
                    ? 'bg-[#007acc] text-white font-medium shadow-xs'
                    : 'text-[#aaaaaa] hover:bg-[#252528] hover:text-white'
                }`}
              >
                <Keyboard className="w-4 h-4 shrink-0" />
                <span>Shortcuts</span>
              </button>

              <button
                type="button"
                onClick={() => setActiveTab('about')}
                className={`w-full flex items-center space-x-2.5 px-3 py-2 rounded text-left transition-colors ${
                  activeTab === 'about'
                    ? 'bg-[#007acc] text-white font-medium shadow-xs'
                    : 'text-[#aaaaaa] hover:bg-[#252528] hover:text-white'
                }`}
              >
                <Sparkles className="w-4 h-4 shrink-0 text-amber-400" />
                <span>About</span>
              </button>
            </div>

            <div className="pt-2 border-t border-[#2e2e32]">
              <button
                type="button"
                onClick={handleResetDefaults}
                className="w-full flex items-center justify-center space-x-1.5 px-2 py-1.5 rounded text-[11px] text-[#888888] hover:text-rose-300 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition-colors"
                title="Reset all settings to default"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Defaults</span>
              </button>
            </div>
          </div>

          {/* Right Content Area */}
          <div className="flex-1 p-5 overflow-y-auto bg-[#222224]">
            {/* 1. Appearance */}
            {activeTab === 'appearance' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold text-white">Appearance & Interface</h3>
                  <p className="text-[11px] text-[#888888]">Choose interface styling and workspace overlays</p>
                </div>

                {/* Interface Theme Switcher */}
                <div className="bg-[#1a1a1c] border border-[#333336] rounded-md p-3.5 space-y-2.5">
                  <span className="text-[11px] font-semibold text-[#aaaaaa] uppercase tracking-wider block">
                    Theme Preset
                  </span>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => handleChange('themePreset', 'vintage-manga')}
                      className="flex items-center justify-center space-x-2 py-2.5 px-3 rounded text-xs font-medium border transition-colors cursor-pointer bg-[#293d45] border-[#5ce1e6] text-[#5ce1e6] shadow-xs"
                    >
                      <Check className="w-3.5 h-3.5 shrink-0" />
                      <span>Old Studio</span>
                    </button>
                  </div>
                </div>

                {/* Toggles */}
                <div className="bg-[#1a1a1c] border border-[#333336] rounded-md p-3.5 space-y-3">
                  <span className="text-[11px] font-semibold text-[#aaaaaa] uppercase tracking-wider block">
                    Workspace Overlays
                  </span>

                  <label className="flex items-center justify-between cursor-pointer py-1">
                    <div>
                      <span className="text-xs text-white block">Canvas Transparency Checkerboard</span>
                      <span className="text-[10px] text-[#888888]">Display pattern behind transparent layers</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={localSettings.showCheckerboard}
                      onChange={(e) => handleChange('showCheckerboard', e.target.checked)}
                      className="w-4 h-4 accent-[#007acc] cursor-pointer"
                    />
                  </label>

                  <label className="flex items-center justify-between cursor-pointer py-1 border-t border-[#2e2e32]">
                    <div>
                      <span className="text-xs text-white block">Status Bar Cursor Coordinates (X, Y)</span>
                      <span className="text-[10px] text-[#888888]">Live cursor pixel position in bottom bar</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={localSettings.showCursorCoordinates}
                      onChange={(e) => handleChange('showCursorCoordinates', e.target.checked)}
                      className="w-4 h-4 accent-[#007acc] cursor-pointer"
                    />
                  </label>

                  <label className="flex items-center justify-between cursor-pointer py-1 border-t border-[#2e2e32]">
                    <div>
                      <span className="text-xs text-white block">Status Bar Stylus Pressure Gauge</span>
                      <span className="text-[10px] text-[#888888]">Display real-time stylus pressure %</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={localSettings.showPressureInStatusBar}
                      onChange={(e) => handleChange('showPressureInStatusBar', e.target.checked)}
                      className="w-4 h-4 accent-[#007acc] cursor-pointer"
                    />
                  </label>
                </div>
              </div>
            )}

            {/* 2. Canvas Defaults */}
            {activeTab === 'canvas' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold text-white">Default Canvas Settings</h3>
                  <p className="text-[11px] text-[#888888]">Default dimensions, resolution, and color mode for new files</p>
                </div>

                {/* Default Dimensions */}
                <div className="bg-[#1a1a1c] border border-[#333336] rounded-md p-3.5 space-y-3">
                  <span className="text-[11px] font-semibold text-[#aaaaaa] uppercase tracking-wider block">
                    Default Dimensions
                  </span>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[11px] text-[#888888]">Default Width (px)</label>
                      <input
                        type="number"
                        min="64"
                        max="16384"
                        value={localSettings.defaultWidth}
                        onChange={(e) => handleChange('defaultWidth', Number(e.target.value))}
                        className="w-full bg-[#222225] border border-[#3e3e42] rounded px-3 py-1.5 font-mono text-sm text-white focus:outline-hidden focus:border-[#007acc]"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-[#888888]">Default Height (px)</label>
                      <input
                        type="number"
                        min="64"
                        max="16384"
                        value={localSettings.defaultHeight}
                        onChange={(e) => handleChange('defaultHeight', Number(e.target.value))}
                        className="w-full bg-[#222225] border border-[#3e3e42] rounded px-3 py-1.5 font-mono text-sm text-white focus:outline-hidden focus:border-[#007acc]"
                      />
                    </div>
                  </div>

                  <label className="flex items-center space-x-2 pt-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={localSettings.defaultLockRatio}
                      onChange={(e) => handleChange('defaultLockRatio', e.target.checked)}
                      className="w-4 h-4 accent-[#007acc] cursor-pointer"
                    />
                    <span className="text-xs text-[#cccccc]">Keep aspect ratio locked by default</span>
                  </label>
                </div>

                {/* Default DPI */}
                <div className="bg-[#1a1a1c] border border-[#333336] rounded-md p-3.5 space-y-2.5">
                  <span className="text-[11px] font-semibold text-[#aaaaaa] uppercase tracking-wider block">
                    Default Resolution (DPI)
                  </span>
                  <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
                    {DPI_PRESETS.map((p) => {
                      const isSelected = localSettings.defaultDpi === p.dpi;
                      return (
                        <button
                          key={p.dpi}
                          type="button"
                          onClick={() => handleChange('defaultDpi', p.dpi)}
                          className={`flex flex-col items-center justify-center py-1 px-1 rounded border transition-colors ${
                            isSelected
                              ? 'bg-[#007acc] border-[#007acc] text-white font-medium'
                              : 'bg-[#252528] border-[#38383c] text-[#bbbbbb] hover:bg-[#303034] hover:text-white'
                          }`}
                        >
                          <span className="font-mono text-xs font-semibold">{p.dpi}</span>
                          <span className="text-[9px] opacity-75">{p.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Default Color Mode */}
                <div className="bg-[#1a1a1c] border border-[#333336] rounded-md p-3.5 space-y-2.5">
                  <span className="text-[11px] font-semibold text-[#aaaaaa] uppercase tracking-wider block">
                    Default Color Mode
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {(['color', 'grayscale', 'monochrome'] as CanvasColorMode[]).map((mode) => {
                      const isSelected = localSettings.defaultColorMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => handleChange('defaultColorMode', mode)}
                          className={`p-2.5 rounded border text-left transition-all ${
                            isSelected
                              ? 'border-[#007acc] bg-[#007acc]/15 text-white ring-1 ring-[#007acc]'
                              : 'border-[#38383c] bg-[#222225] text-[#aaaaaa] hover:border-[#4a4a4e]'
                          }`}
                        >
                          <div className="font-semibold text-xs text-white capitalize mb-0.5">
                            {mode === 'monochrome' ? 'Monochrome (Manga)' : mode}
                          </div>
                          <div className="text-[10px] text-[#888888]">
                            {mode === 'color'
                              ? 'Full RGB palette'
                              : mode === 'grayscale'
                              ? '256 gray shades'
                              : '1-bit black & white'}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* 3. Brush & Stylus */}
            {activeTab === 'brush' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-sm font-semibold text-white">Brush & Stylus Inking</h3>
                  <p className="text-[11px] text-[#888888]">Configure stroke stabilization, pressure response, and history buffer</p>
                </div>

                {/* Stabilization Slider */}
                <div className="bg-[#1a1a1c] border border-[#333336] rounded-md p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-[#aaaaaa] uppercase tracking-wider">
                      Stroke Stabilization Level (Clip Studio Style)
                    </span>
                    <span className="font-mono text-xs text-[#38bdf8] font-semibold">
                      {localSettings.defaultStabilization}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="50"
                    value={localSettings.defaultStabilization}
                    onChange={(e) => handleChange('defaultStabilization', Number(e.target.value))}
                    className="w-full accent-[#007acc] cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-[#666666]">
                    <span>0 (Raw / No Smoothing)</span>
                    <span>15 (Standard Inking)</span>
                    <span>50 (Maximum Glide)</span>
                  </div>
                </div>

                {/* Toggles */}
                <div className="bg-[#1a1a1c] border border-[#333336] rounded-md p-3.5 space-y-3">
                  <label className="flex items-center justify-between cursor-pointer py-1">
                    <div>
                      <span className="text-xs text-white block">Stylus Pressure Sensitivity</span>
                      <span className="text-[10px] text-[#888888]">Taper stroke width by tablet stylus pressure</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={localSettings.usePressureByDefault}
                      onChange={(e) => handleChange('usePressureByDefault', e.target.checked)}
                      className="w-4 h-4 accent-[#007acc] cursor-pointer"
                    />
                  </label>

                  <label className="flex items-center justify-between cursor-pointer py-1 border-t border-[#2e2e32]">
                    <div>
                      <span className="text-xs text-white block">Bézier Quadratic Curve Smoothing</span>
                      <span className="text-[10px] text-[#888888]">Render smooth interpolated inking curves</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={localSettings.smoothingEnabled}
                      onChange={(e) => handleChange('smoothingEnabled', e.target.checked)}
                      className="w-4 h-4 accent-[#007acc] cursor-pointer"
                    />
                  </label>
                </div>

                {/* Max History Steps */}
                <div className="bg-[#1a1a1c] border border-[#333336] rounded-md p-3.5 space-y-2.5">
                  <span className="text-[11px] font-semibold text-[#aaaaaa] uppercase tracking-wider block">
                    Max Undo History States
                  </span>
                  <div className="grid grid-cols-4 gap-2">
                    {[25, 50, 75, 100].map((steps) => {
                      const isSelected = localSettings.maxHistorySteps === steps;
                      return (
                        <button
                          key={steps}
                          type="button"
                          onClick={() => handleChange('maxHistorySteps', steps)}
                          className={`py-1.5 px-3 rounded border text-center font-mono text-xs transition-colors ${
                            isSelected
                              ? 'bg-[#007acc] border-[#007acc] text-white font-medium shadow-xs'
                              : 'bg-[#252528] border-[#38383c] text-[#bbbbbb] hover:bg-[#303034] hover:text-white'
                          }`}
                        >
                          {steps} steps
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* 4. Shortcuts */}
            {activeTab === 'shortcuts' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-white">Keyboard Shortcuts</h3>
                    <p className="text-[11px] text-[#888888]">Quick reference for all application hotkeys</p>
                  </div>

                  {/* Search */}
                  <div className="relative w-48">
                    <Search className="w-3.5 h-3.5 text-[#666666] absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Search..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full bg-[#18181a] border border-[#3c3c40] rounded pl-8 pr-2.5 py-1 text-xs text-white focus:outline-hidden focus:border-[#007acc]"
                    />
                  </div>
                </div>

                <div className="bg-[#1a1a1c] border border-[#333336] rounded-md overflow-hidden">
                  <div className="max-h-[360px] overflow-y-auto divide-y divide-[#2a2a2e]">
                    {filteredShortcuts.map((row, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between px-3.5 py-2 hover:bg-[#222225] transition-colors"
                      >
                        <div className="flex flex-col pr-3">
                          <span className="text-xs text-white font-medium">{row.action}</span>
                          <span className="text-[10px] text-[#888888]">{row.desc}</span>
                        </div>
                        <kbd className="px-2 py-0.5 rounded bg-[#252528] border border-[#3e3e42] font-mono text-[11px] text-[#38bdf8] whitespace-nowrap shadow-xs">
                          {row.shortcut}
                        </kbd>
                      </div>
                    ))}
                    {filteredShortcuts.length === 0 && (
                      <div className="p-6 text-center text-[#777777] italic text-xs">
                        No shortcuts matching "{searchQuery}"
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 5. About */}
            {activeTab === 'about' && (
              <div className="space-y-4">
                <div className="bg-[#1a1a1c] border border-[#333336] rounded-md p-5 flex flex-col items-center text-center space-y-3">
                  <div className="w-16 h-16 flex items-center justify-center">
                    <img
                      src="/app-icon.png"
                      alt="Ink Studio"
                      className="w-16 h-16 object-contain drop-shadow-md select-none"
                    />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-white tracking-wide">Ink Studio</h2>
                    <span className="text-[11px] font-mono text-[#38bdf8]">Version 0.1.0 • Built with Tauri & React</span>
                  </div>
                  <p className="text-xs text-[#aaaaaa] max-w-md leading-relaxed">
                    A professional-grade desktop graphics editor & manga inking studio featuring a full layered workflow,
                    Photoshop PSD & Clip Studio Paint CSP compatibility, smooth tablet stylus pressure, and infinite zoom/rotation.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="bg-[#1a1a1c] border border-[#333336] rounded p-3 space-y-1">
                    <span className="text-[11px] font-semibold text-[#888888] uppercase tracking-wider block">
                      Supported Import Formats
                    </span>
                    <p className="text-[#cccccc] font-mono text-[11px]">
                      .psd, .psb, .clip, .csp, .sora, .ink, .png, .jpg, .jpeg, .webp, .bmp, .gif, .svg
                    </p>
                  </div>
                  <div className="bg-[#1a1a1c] border border-[#333336] rounded p-3 space-y-1">
                    <span className="text-[11px] font-semibold text-[#888888] uppercase tracking-wider block">
                      Supported Export Formats
                    </span>
                    <p className="text-[#cccccc] font-mono text-[11px]">
                      PSD (Layered), Ink Studio Project (.sora / .ink), PNG, JPG, WebP
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 bg-[#2a2a2d] border-t border-[#38383a] shrink-0">
          <span className="text-[11px] text-[#777777]">Changes save automatically</span>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center space-x-1.5 px-5 py-1.5 rounded bg-[#007acc] hover:bg-[#008be5] active:bg-[#006bb3] text-white font-medium shadow-sm transition-colors ml-auto"
          >
            <Check className="w-4 h-4" />
            <span>Close</span>
          </button>
        </div>
      </div>
    </div>
  );
};
