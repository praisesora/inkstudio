import React, { useState, useRef, useEffect } from 'react';
import {
  Menu,
  Pencil,
  Paintbrush,
  Palette,
  Square,
  Eraser,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { ToolType } from '../types/editor';
import { BRUSH_SIZE_PRESETS } from '../utils/brushPresetManager';

interface BrushSizePaletteProps {
  currentSize: number;
  onSelectSize: (size: number) => void;
  activeBrushName: string;
  tool: ToolType;
  presetId?: string;
  onResetSizeToDefault?: () => void;
  onResetAllSettings?: () => void;
  className?: string;
  hideHeader?: boolean;
}

export const BrushSizePalette: React.FC<BrushSizePaletteProps> = ({
  currentSize,
  onSelectSize,
  activeBrushName,
  tool,
  presetId,
  onResetSizeToDefault,
  onResetAllSettings,
  className = '',
  hideHeader = false,
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Determine tool icon matching the active tool/preset
  const renderToolIcon = () => {
    if (tool === 'eraser') {
      return <Eraser className="w-3.5 h-3.5 text-rose-400 shrink-0" />;
    }
    if (presetId?.startsWith('pencil')) {
      return <Pencil className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
    }
    if (presetId === 'oil-thick' || presetId === 'oil-glaze' || presetId === 'blend-smudge') {
      return <Palette className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    }
    if (presetId === 'square-digital') {
      return <Square className="w-3.5 h-3.5 text-teal-400 shrink-0" />;
    }
    if (presetId?.startsWith('csp-')) {
      return <Sparkles className="w-3.5 h-3.5 text-[#5ce1e6] shrink-0" />;
    }
    return <Paintbrush className="w-3.5 h-3.5 text-[#5ce1e6] shrink-0" />;
  };

  // Renders the Clip Studio Paint style circle preview inside each cell
  const renderSizeCircle = (size: number) => {
    if (size <= 0.7) {
      return <div className="w-[1.5px] h-[1.5px] rounded-full bg-white" />;
    }
    if (size <= 1) {
      return <div className="w-[2px] h-[2px] rounded-full bg-white" />;
    }
    if (size <= 1.5) {
      return <div className="w-[2.5px] h-[2.5px] rounded-full bg-white" />;
    }
    if (size <= 2) {
      return <div className="w-[3px] h-[3px] rounded-full bg-white" />;
    }
    if (size <= 2.5) {
      return <div className="w-[3.5px] h-[3.5px] rounded-full bg-white" />;
    }
    if (size <= 3) {
      return <div className="w-[4px] h-[4px] rounded-full bg-white" />;
    }
    if (size <= 4) {
      return <div className="w-[5px] h-[5px] rounded-full bg-white" />;
    }
    if (size <= 5) {
      return <div className="w-[6px] h-[6px] rounded-full bg-white" />;
    }
    if (size <= 6) {
      return <div className="w-[7px] h-[7px] rounded-full bg-white" />;
    }
    if (size <= 7) {
      return <div className="w-[8px] h-[8px] rounded-full bg-white" />;
    }
    if (size <= 8) {
      return <div className="w-[9.5px] h-[9.5px] rounded-full bg-white" />;
    }
    if (size <= 10) {
      return <div className="w-[11.5px] h-[11.5px] rounded-full bg-white" />;
    }
    if (size <= 12) {
      return <div className="w-[13.5px] h-[13.5px] rounded-full bg-white" />;
    }
    if (size <= 15) {
      return <div className="w-[15.5px] h-[15.5px] rounded-full bg-white" />;
    }
    if (size <= 17) {
      return <div className="w-[17.5px] h-[17.5px] rounded-full bg-white" />;
    }
    if (size <= 20) {
      return <div className="w-[19.5px] h-[19.5px] rounded-full bg-white" />;
    }
    if (size <= 25) {
      return (
        <div className="w-[22px] h-[16px] overflow-hidden flex items-end justify-center relative">
          <div className="w-[22px] h-[22px] rounded-full bg-white relative top-[3px]" />
          <div className="absolute bottom-0 w-full h-[1px] bg-[#666666]/60" />
        </div>
      );
    }
    if (size <= 30) {
      return (
        <div className="w-[24px] h-[16px] overflow-hidden flex items-end justify-center relative">
          <div className="w-[24px] h-[24px] rounded-full bg-white relative top-[4px]" />
          <div className="absolute bottom-0 w-full h-[1px] bg-[#666666]/60" />
        </div>
      );
    }

    // Sizes >= 40: large dome filled white with flat bottom edge (CSP signature style)
    const domeDiameter = Math.min(32, 24 + Math.min(8, Math.log10(size / 30) * 4));
    return (
      <div className="w-[28px] h-[16px] overflow-hidden flex items-end justify-center relative">
        <div
          className="rounded-full bg-white relative"
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
    <div className={`flex flex-col select-none bg-[#1e2023] ${className}`}>
      {/* Header Bar matching Clip Studio Paint screenshot */}
      {!hideHeader && (
        <div className="h-8 px-2.5 flex items-center justify-between border-b border-[#2b2d31] bg-[#1a1b1e] shrink-0 text-white relative">
          <div className="flex items-center space-x-2 min-w-0">
            {/* Menu icon (≡) */}
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setShowMenu((prev) => !prev)}
                title="Brush Size Options"
                className="p-1 text-[#8c9099] hover:text-white hover:bg-[#282a2e] rounded transition-colors cursor-pointer"
              >
                <Menu className="w-3.5 h-3.5" />
              </button>

              {showMenu && (
                <div className="absolute top-7 left-0 w-48 bg-[#18191b] border border-[#33363e] rounded shadow-xl py-1 z-50 text-[11px] text-[#cccccc]">
                  {onResetSizeToDefault && (
                    <button
                      type="button"
                      onClick={() => {
                        onResetSizeToDefault();
                        setShowMenu(false);
                      }}
                      className="w-full px-3 py-1.5 text-left hover:bg-[#26282e] hover:text-white flex items-center space-x-2 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3 text-[#5ce1e6]" />
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
                      className="w-full px-3 py-1.5 text-left hover:bg-[#26282e] hover:text-rose-400 flex items-center space-x-2 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3 text-rose-400" />
                      <span>Reset All Brush Settings</span>
                    </button>
                  )}
                  <div className="px-3 py-1 text-[10px] text-[#717682] border-t border-[#26282e] mt-1">
                    Current: {currentSize} px
                  </div>
                </div>
              )}
            </div>

            {/* Tool Icon */}
            {renderToolIcon()}

            {/* Brush Size Label */}
            <span
              className="text-xs font-semibold tracking-tight text-[#e0e3ea] truncate"
              title={`Brush size [${activeBrushName || 'Brush'}]`}
            >
              Brush size [{activeBrushName || 'Brush'}]
            </span>
          </div>

          {/* Current Size Badge */}
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#141517] border border-[#2b2d31] text-[#5ce1e6] shrink-0">
            {currentSize} px
          </span>
        </div>
      )}

      {/* 6-Column Grid of 40 Presets matching screenshot */}
      <div className="p-1 overflow-y-auto">
        <div className="grid grid-cols-6 border-t border-l border-[#2d3036] bg-[#141518]">
          {BRUSH_SIZE_PRESETS.map((preset) => {
            const isSelected = Math.abs(currentSize - preset) < 0.05;

            return (
              <button
                key={preset}
                type="button"
                onClick={() => onSelectSize(preset)}
                title={`${preset} px`}
                className={`h-11 flex flex-col items-center justify-between py-1 px-0.5 border-r border-b transition-colors cursor-pointer relative group ${
                  isSelected
                    ? 'bg-[#37485e] border-[#4e6a88] text-white shadow-inner font-semibold z-10'
                    : 'bg-[#1b1c1f]/80 hover:bg-[#282b31] border-[#292b30] text-[#a8acb6] hover:text-white'
                }`}
              >
                {/* Visual circle preview */}
                <div className="w-full h-5 flex items-center justify-center overflow-hidden">
                  {renderSizeCircle(preset)}
                </div>

                {/* Preset size numeric label */}
                <span className="text-[10px] font-mono tracking-tight leading-none text-center">
                  {preset}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
