import React, { useEffect } from 'react';
import { Paintbrush, Eraser, ArrowLeftRight, Pipette } from 'lucide-react';
import { ToolType } from '../types/editor';
import { LiquifyIcon } from './LiquifyIcon';

interface LeftSidebarProps {
  currentTool: ToolType;
  onSelectTool: (tool: ToolType) => void;
  primaryColor: string;
  secondaryColor: string;
  onSwapColors: () => void;
  isTransparentColor?: boolean;
  onToggleTransparentColor?: () => void;
}

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  currentTool,
  onSelectTool,
  primaryColor,
  secondaryColor,
  onSwapColors,
  isTransparentColor = false,
  onToggleTransparentColor,
}) => {
  // Keyboard shortcuts: B for Brush, E for Eraser, I for Pipette, J for Liquify, X for swap colors
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'b') {
        onSelectTool('brush');
      } else if (key === 'e') {
        onSelectTool('eraser');
      } else if (key === 'i') {
        onSelectTool('pipette');
      } else if (key === 'j') {
        onSelectTool('liquify');
      } else if (key === 'x') {
        onSwapColors();
      } else if (key === 'c') {
        onToggleTransparentColor?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSelectTool, onSwapColors, onToggleTransparentColor]);

  return (
    <aside className="w-14 bg-[#202020] border-r border-[#2c2c2c] flex flex-col items-center py-3 select-none z-10 shrink-0">
      <div className="flex flex-col items-center space-y-2">
        {/* Brush Button */}
        <button
          type="button"
          onClick={() => onSelectTool('brush')}
          title="Brush Tool (B)"
          className={`w-10 h-10 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
            currentTool === 'brush'
              ? 'bg-[#2c2c2c] border border-[#3a3a3a] text-[#e5e5e5]'
              : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 border border-transparent'
          }`}
        >
          <Paintbrush className="w-5 h-5" />
          {/* Tooltip */}
          <div className="absolute left-12 bg-[#161616] text-[#e5e5e5] text-xs px-2 py-1 rounded border border-[#2c2c2c] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50">
            Brush (B)
          </div>
        </button>

        {/* Eraser Button */}
        <button
          type="button"
          onClick={() => onSelectTool('eraser')}
          title="Eraser Tool (E)"
          className={`w-10 h-10 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
            currentTool === 'eraser'
              ? 'bg-[#2c2c2c] border border-[#3a3a3a] text-[#e5e5e5]'
              : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 border border-transparent'
          }`}
        >
          <Eraser className="w-5 h-5" />
          <div className="absolute left-12 bg-[#161616] text-[#e5e5e5] text-xs px-2 py-1 rounded border border-[#2c2c2c] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50">
            Eraser (E)
          </div>
        </button>

        {/* Pipette Button */}
        <button
          type="button"
          onClick={() => onSelectTool('pipette')}
          title="Pipette Tool (I / Hold Alt)"
          className={`w-10 h-10 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
            currentTool === 'pipette'
              ? 'bg-[#2c2c2c] border border-[#3a3a3a] text-[#e5e5e5]'
              : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 border border-transparent'
          }`}
        >
          <Pipette className="w-5 h-5" />
          <div className="absolute left-12 bg-[#161616] text-[#e5e5e5] text-xs px-2 py-1 rounded border border-[#2c2c2c] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50">
            Pipette (I / Hold Alt)
          </div>
        </button>

        {/* Liquify Button */}
        <button
          type="button"
          onClick={() => onSelectTool('liquify')}
          title="Liquify Tool (J)"
          className={`w-10 h-10 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
            currentTool === 'liquify'
              ? 'bg-[#2c2c2c] border border-[#3a3a3a] text-[#e5e5e5]'
              : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 border border-transparent'
          }`}
        >
          <LiquifyIcon className="w-5 h-5" />
          <div className="absolute left-12 bg-[#161616] text-[#e5e5e5] text-xs px-2 py-1 rounded border border-[#2c2c2c] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50">
            Liquify (J)
          </div>
        </button>
      </div>

      <div className="my-3 w-8 h-px bg-[#2c2c2c]" />

      {/* Primary & Secondary Color Indicator Swatches */}
      <div className="mt-auto flex flex-col items-center space-y-2 pb-1">
        <div className="relative w-9 h-9">
          {/* Secondary Color Swatch (bottom-right) */}
          <div
            onClick={onSwapColors}
            title={`Secondary Color: ${secondaryColor} (Click or press X to swap)`}
            className="absolute bottom-0 right-0 w-6 h-6 rounded border border-[#3a3a3a] cursor-pointer hover:border-[#8a8a8a] shadow-sm z-0"
            style={{ backgroundColor: secondaryColor }}
          />

          {/* Primary Color Swatch (top-left) */}
          <div
            onClick={() => {
              if (isTransparentColor) {
                onToggleTransparentColor?.();
              } else {
                onSwapColors();
              }
            }}
            title={`Primary Active Color: ${primaryColor} (Click to select/swap)`}
            className={`absolute top-0 left-0 w-6 h-6 rounded cursor-pointer transition-all z-10 ${
              !isTransparentColor
                ? 'border border-[var(--accent)] ring-1 ring-[var(--accent-border)]'
                : 'border border-[#3a3a3a] hover:border-[#8a8a8a] opacity-80'
            }`}
            style={{ backgroundColor: primaryColor }}
          />
        </div>

        {/* Transparent Color Swatch */}
        <div
          onClick={onToggleTransparentColor}
          title="Transparent Ink / Color (C) - Brush as textured eraser"
          className={`w-7 h-3.5 rounded border cursor-pointer relative overflow-hidden transition-all ${
            isTransparentColor
              ? 'border-[var(--accent)] ring-1 ring-[var(--accent-border)]'
              : 'border-[#3a3a3a] hover:border-[#8a8a8a] opacity-80 hover:opacity-100'
          }`}
          style={{
            backgroundImage:
              'linear-gradient(45deg, #777 25%, transparent 25%), linear-gradient(-45deg, #777 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #777 75%), linear-gradient(-45deg, transparent 75%, #777 75%)',
            backgroundSize: '4px 4px',
            backgroundPosition: '0 0, 0 2px, 2px -2px, -2px 0px',
            backgroundColor: '#bbb',
          }}
        />

        {/* Swap button */}
        <button
          type="button"
          onClick={onSwapColors}
          title="Swap Colors (X)"
          className="p-1 text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
        >
          <ArrowLeftRight className="w-3.5 h-3.5" />
        </button>

        <span className="text-[9px] text-[#6e6e6e] font-mono">
          X / C
        </span>
      </div>
    </aside>
  );
};

