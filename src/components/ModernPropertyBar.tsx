import React from 'react';
import {
  Paintbrush,
  Sliders,
  ChevronDown,
  Settings,
  BookOpen,
  Blend,
} from 'lucide-react';
import { ToolType, BrushSettings } from '../types/editor';

interface ModernPropertyBarProps {
  tool: ToolType;
  brushSettings: BrushSettings;
  onUpdateBrushSettings: (newSettings: Partial<BrushSettings>) => void;
  onToggleBrushEditor: () => void;
  onOpenPresets?: () => void;
  isBrushEditorOpen?: boolean;
}

const BLEND_MODES = [
  { value: 'source-over', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-burn', label: 'Color Burn' },
];

export const ModernPropertyBar: React.FC<ModernPropertyBarProps> = ({
  tool: _tool,
  brushSettings,
  onUpdateBrushSettings,
  onToggleBrushEditor,
  onOpenPresets,
  isBrushEditorOpen = false,
}) => {
  const currentSize = Math.round(brushSettings.size);
  const currentOpacity = Math.round((brushSettings.opacity ?? 1) * 100);
  const currentFlow = Math.round((brushSettings.flow ?? 1) * 100);
  const brushDisplayName = brushSettings.brushName || (brushSettings.preset as string) || 'Brush';

  return (
    <div className="h-9 px-3 flex items-center justify-between text-xs select-none z-20 shrink-0 bg-[#1e1f24] border-b border-white/[0.08] text-white/90">
      {/* Left controls */}
      <div className="flex items-center space-x-2">
        {/* Presets Button */}
        <button
          onClick={onOpenPresets || onToggleBrushEditor}
          title="Browse Brush Presets"
          className="flex items-center space-x-1 px-2.5 py-1 rounded-md bg-white/[0.05] hover:bg-white/[0.09] border border-white/[0.08] text-white/80 hover:text-white transition-colors cursor-pointer text-xs"
        >
          <BookOpen className="w-3.5 h-3.5 text-white/60" />
          <span>Presets</span>
        </button>

        {/* Active Brush Preset Pill */}
        <button
          onClick={onToggleBrushEditor}
          title="Current Brush Preset (Click to Toggle Editor)"
          className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-md border text-xs transition-colors cursor-pointer ${
            isBrushEditorOpen
              ? 'bg-white/[0.12] border-white/20 text-white'
              : 'bg-white/[0.05] hover:bg-white/[0.09] border-white/[0.08] text-white/90'
          }`}
        >
          <Paintbrush className="w-3.5 h-3.5 text-white/70" />
          <span className="font-medium max-w-[140px] truncate">{brushDisplayName}</span>
          <ChevronDown className="w-3 h-3 text-white/40" />
        </button>

        {/* Brush Editor Button */}
        <button
          onClick={onToggleBrushEditor}
          title="Toggle Detailed Brush Settings & Dynamics"
          className={`flex items-center space-x-1 px-2.5 py-1 rounded-md border text-xs transition-colors cursor-pointer ${
            isBrushEditorOpen
              ? 'bg-[var(--modern-accent-subtle)] text-[var(--modern-accent)] border-[var(--modern-accent-border)]'
              : 'bg-white/[0.05] hover:bg-white/[0.09] border-white/[0.08] text-white/80 hover:text-white'
          }`}
        >
          <Sliders className="w-3.5 h-3.5" />
          <span>Brush Editor</span>
        </button>

        <span className="text-white/15">|</span>

        {/* Mode Dropdown */}
        <div className="flex items-center space-x-1.5 bg-white/[0.04] border border-white/[0.08] rounded-md px-2 py-0.5">
          <Blend className="w-3.5 h-3.5 text-white/50" />
          <span className="text-[11px] text-white/50">Mode:</span>
          <select
            defaultValue="source-over"
            className="bg-transparent text-white/90 text-xs font-medium outline-none cursor-pointer pr-1"
            title="Brush Blending Mode"
          >
            {BLEND_MODES.map((bm) => (
              <option key={bm.value} value={bm.value} className="bg-[#1e1f24] text-white">
                {bm.label}
              </option>
            ))}
          </select>
        </div>

        {/* Size Input */}
        <div className="flex items-center space-x-1 bg-white/[0.04] border border-white/[0.08] rounded-md px-2 py-0.5">
          <span className="text-[11px] text-white/50">Size:</span>
          <input
            type="number"
            min={1}
            max={500}
            value={currentSize}
            onChange={(e) => onUpdateBrushSettings({ size: Math.max(1, Math.min(500, Number(e.target.value))) })}
            className="w-11 bg-transparent text-white text-xs font-mono outline-none text-right"
          />
          <span className="text-[11px] text-white/40 font-mono">px</span>
        </div>

        {/* Opacity Input */}
        <div className="flex items-center space-x-1 bg-white/[0.04] border border-white/[0.08] rounded-md px-2 py-0.5">
          <span className="text-[11px] text-white/50">Opacity:</span>
          <input
            type="number"
            min={1}
            max={100}
            value={currentOpacity}
            onChange={(e) =>
              onUpdateBrushSettings({
                opacity: Math.max(0.01, Math.min(1, Number(e.target.value) / 100)),
              })
            }
            className="w-9 bg-transparent text-white text-xs font-mono outline-none text-right"
          />
          <span className="text-[11px] text-white/40 font-mono">%</span>
        </div>

        {/* Flow Input */}
        <div className="flex items-center space-x-1 bg-white/[0.04] border border-white/[0.08] rounded-md px-2 py-0.5">
          <span className="text-[11px] text-white/50">Flow:</span>
          <input
            type="number"
            min={1}
            max={100}
            value={currentFlow}
            onChange={(e) =>
              onUpdateBrushSettings({
                flow: Math.max(0.01, Math.min(1, Number(e.target.value) / 100)),
              })
            }
            className="w-9 bg-transparent text-white text-xs font-mono outline-none text-right"
          />
          <span className="text-[11px] text-white/40 font-mono">%</span>
        </div>
      </div>

      {/* Right controls: Tool settings cog */}
      <div className="flex items-center space-x-1.5">
        <button
          onClick={onToggleBrushEditor}
          title="Tool Options & Presets"
          className="p-1 rounded-md text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors cursor-pointer"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
