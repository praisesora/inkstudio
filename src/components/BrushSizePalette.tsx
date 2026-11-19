import React, { useState, useRef, useEffect } from 'react';
import {
  Menu,
  Pencil,
  Paintbrush,
  Square,
  Eraser,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { ToolType } from '../types/editor';
import { ThemePreset } from '../types/settings';
import { BRUSH_SIZE_PRESETS } from '../utils/brushPresetManager';

export interface BrushSizePaletteProps {
  currentSize: number;
  onSelectSize: (size: number) => void;
  activeBrushName: string;
  tool: ToolType;
  presetId?: string;
  onResetSizeToDefault?: () => void;
  onResetAllSettings?: () => void;
  className?: string;
  hideHeader?: boolean;
  themePreset?: ThemePreset;
}

export const BrushSizePalette: React.FC<BrushSizePaletteProps> = React.memo(({
  currentSize,
  onSelectSize,
  activeBrushName,
  tool,
  presetId,
  onResetSizeToDefault,
  onResetAllSettings,
  className = '',
  hideHeader = false,
  themePreset = 'modern',
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isVintage = themePreset === 'vintage-manga';

  useEffect(() => {
    if (!showMenu) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, [showMenu]);

  const renderToolIcon = () => {
    if (tool === 'eraser') {
      return <Eraser className="w-3.5 h-3.5 text-rose-400 shrink-0" />;
    }
    if (presetId?.startsWith('pencil')) {
      return <Pencil className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    }
    if (presetId === 'square-digital') {
      return <Square className="w-3.5 h-3.5 text-teal-400 shrink-0" />;
    }
    if (presetId?.startsWith('csp-')) {
      return (
        <Sparkles
          className={`w-3.5 h-3.5 shrink-0 ${
            isVintage ? 'text-[#5ce1e6]' : 'text-[var(--accent)]'
          }`}
        />
      );
    }
    return (
      <Paintbrush
        className={`w-3.5 h-3.5 shrink-0 ${
          isVintage ? 'text-[#5ce1e6]' : 'text-[var(--accent)]'
        }`}
      />
    );
  };

  const renderSizeCircle = (size: number) => {
    const dotClass = isVintage ? 'bg-[#f0f0f4]' : 'bg-[#e5e5e5]';
    const smallMap: Array<[number, number]> = [
      [0.7, 1.5],
      [1, 2],
      [1.5, 2.5],
      [2, 3],
      [2.5, 3.5],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 8],
      [8, 9.5],
      [10, 11.5],
      [12, 13.5],
      [15, 15.5],
      [17, 17.5],
      [20, 19.5],
    ];
    for (const [maxSize, px] of smallMap) {
      if (size <= maxSize) {
        return (
          <div
            className={`rounded-full ${dotClass}`}
            style={{ width: `${px}px`, height: `${px}px` }}
          />
        );
      }
    }
    if (size <= 30) {
      const d = size <= 25 ? 22 : 24;
      const top = size <= 25 ? 3 : 4;
      return (
        <div
          className="h-[16px] overflow-hidden flex items-end justify-center relative"
          style={{ width: `${d}px` }}
        >
          <div
            className={`rounded-full ${dotClass} relative`}
            style={{ width: `${d}px`, height: `${d}px`, top: `${top}px` }}
          />
          <div className="absolute bottom-0 w-full h-[1px] bg-[#666666]/60" />
        </div>
      );
    }

    const domeDiameter = Math.min(30, 22 + Math.min(8, Math.log10(size / 30) * 4));
    return (
      <div className="w-[26px] h-[16px] overflow-hidden flex items-end justify-center relative">
        <div
          className={`rounded-full ${dotClass} relative`}
          style={{
            width: `${domeDiameter}px`,
            height: `${domeDiameter}px`,
            top: `${domeDiameter * 0.22}px`,
          }}
        />
        <div className="absolute bottom-0 w-full h-[1px] bg-[#666666]/70" />
      </div>
    );
  };

  return (
    <div
      data-testid="brush-size-palette"
      data-theme-preset={themePreset}
      className={`flex flex-col h-full min-h-0 select-none ${
        isVintage ? 'bg-[#363638] text-[#e5e5e5]' : 'bg-[#202020] text-[#e5e5e5]'
      } ${className}`}
    >
      {!hideHeader && (
        <div
          className={`h-7 px-2 flex items-center justify-between shrink-0 relative ${
            isVintage
              ? 'bg-gradient-to-b from-[#464649] to-[#363638] border-b border-[#232325] text-[#f0f0f4]'
              : 'bg-[#1a1a1a] border-b border-white/[0.06] text-[#e5e5e5]'
          }`}
        >
          <div className="flex items-center space-x-1.5 min-w-0">
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setShowMenu((prev) => !prev)}
                title="Brush Size Options"
                className={`p-1 rounded transition-colors cursor-pointer ${
                  isVintage
                    ? 'text-[#b0b0b6] hover:text-white hover:bg-[#4e4e52]'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                }`}
              >
                <Menu className="w-3.5 h-3.5" />
              </button>

              {showMenu && (
                <div
                  className={`absolute top-6 left-0 w-44 rounded shadow-xl py-1 z-50 text-[11px] ${
                    isVintage
                      ? 'bg-[#2b2b2e] border border-[#202022] text-[#e0e0e4]'
                      : 'bg-[#1a1a1a] border border-white/[0.1] text-[#cccccc]'
                  }`}
                >
                  {onResetSizeToDefault && (
                    <button
                      type="button"
                      onClick={() => {
                        onResetSizeToDefault();
                        setShowMenu(false);
                      }}
                      className="w-full px-3 py-1.5 text-left hover:bg-[#2c2c2c] hover:text-white flex items-center space-x-2 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3 text-[var(--accent)]" />
                      <span>Reset Size to Default</span>
                    </button>
                  )}
                  {onResetAllSettings && (
                    <button
                      type="button"
                      onClick={() => {
                        onResetAllSettings();
                        setShowMenu(false);
                      }}
                      className="w-full px-3 py-1.5 text-left hover:bg-[#2c2c2c] hover:text-rose-400 flex items-center space-x-2 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3 text-rose-400" />
                      <span>Reset All Brush Settings</span>
                    </button>
                  )}
                  <div className="px-3 py-1 text-[10px] text-[#8a8a8a] border-t border-white/[0.06] mt-1">
                    Current: {currentSize} px
                  </div>
                </div>
              )}
            </div>

            {renderToolIcon()}

            <span
              className="text-[11px] font-medium tracking-tight truncate"
              title={`Brush size [${activeBrushName || 'Brush'}]`}
            >
              {activeBrushName || 'Brush'}
            </span>
          </div>

          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 ${
              isVintage
                ? 'bg-[#2b2b2e] border border-[#202022] text-[#38bdf8]'
                : 'bg-[#161616] text-[var(--accent)]'
            }`}
          >
            {currentSize}px
          </span>
        </div>
      )}

      {/* Responsive CSP-style grid of brush size presets */}
      <div className="p-1 flex-1 min-h-0 overflow-y-auto">
        <div
          className={`grid grid-cols-[repeat(auto-fill,minmax(32px,1fr))] border-t border-l ${
            isVintage
              ? 'border-[#252528] bg-[#2a2a2d]'
              : 'border-[#2a2a2a] bg-[#161616]'
          }`}
        >
          {BRUSH_SIZE_PRESETS.map((preset) => {
            const isSelected = Math.abs(currentSize - preset) < 0.05;

            return (
              <button
                key={preset}
                type="button"
                onClick={() => onSelectSize(preset)}
                title={`${preset} px`}
                aria-pressed={isSelected}
                className={`h-10 flex flex-col items-center justify-between py-1 px-0.5 border-r border-b transition-colors cursor-pointer relative ${
                  isSelected
                    ? isVintage
                      ? 'bg-[#337bb5] border-[#4e95cf] text-white font-semibold z-10'
                      : 'bg-[var(--accent-subtle)] border-[var(--accent-border)] text-[var(--accent)] font-semibold z-10'
                    : isVintage
                    ? 'bg-[#343437] hover:bg-[#444448] border-[#252528] text-[#b8b8be] hover:text-white'
                    : 'bg-[#202020] hover:bg-[#2c2c2c] border-[#2a2a2a] text-[#8a8a8a] hover:text-[#e5e5e5]'
                }`}
              >
                <div className="w-full h-4 flex items-center justify-center overflow-hidden">
                  {renderSizeCircle(preset)}
                </div>

                <span className="text-[9px] font-mono tracking-tight leading-none text-center">
                  {preset}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});

BrushSizePalette.displayName = 'BrushSizePalette';
