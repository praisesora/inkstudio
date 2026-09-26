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
}

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  currentTool,
  onSelectTool,
  primaryColor,
  secondaryColor,
  onSwapColors,
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
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSelectTool, onSwapColors]);

  return (
    <aside className="w-14 bg-[#252526] border-r border-[#333333] flex flex-col items-center py-3 select-none z-10 shrink-0">
      <div className="flex flex-col items-center space-y-2">
        {/* Brush Button */}
        <button
          onClick={() => onSelectTool('brush')}
          title="Brush Tool (B)"
          className={`w-10 h-10 rounded-[2px] flex items-center justify-center transition-colors relative group ${
            currentTool === 'brush'
              ? 'bg-[#383838] border border-[#4a4a4a] text-white shadow-sm'
              : 'text-[#999999] hover:text-[#cccccc] hover:bg-[#2d2d2d] border border-transparent'
          }`}
        >
          <Paintbrush className="w-5 h-5" />
          {/* Tooltip */}
          <div className="absolute left-12 bg-[#252526] text-[#cccccc] text-xs px-2 py-1 rounded-[2px] border border-[#3a3a3a] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50">
            Brush (B)
          </div>
        </button>

        {/* Eraser Button */}
        <button
          onClick={() => onSelectTool('eraser')}
          title="Eraser Tool (E)"
          className={`w-10 h-10 rounded-[2px] flex items-center justify-center transition-colors relative group ${
            currentTool === 'eraser'
              ? 'bg-[#383838] border border-[#4a4a4a] text-white shadow-sm'
              : 'text-[#999999] hover:text-[#cccccc] hover:bg-[#2d2d2d] border border-transparent'
          }`}
        >
          <Eraser className="w-5 h-5" />
          <div className="absolute left-12 bg-[#252526] text-[#cccccc] text-xs px-2 py-1 rounded-[2px] border border-[#3a3a3a] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50">
            Eraser (E)
          </div>
        </button>

        {/* Pipette Button */}
        <button
          onClick={() => onSelectTool('pipette')}
          title="Pipette Tool (I / Hold Alt)"
          className={`w-10 h-10 rounded-[2px] flex items-center justify-center transition-colors relative group ${
            currentTool === 'pipette'
              ? 'bg-[#383838] border border-[#4a4a4a] text-white shadow-sm'
              : 'text-[#999999] hover:text-[#cccccc] hover:bg-[#2d2d2d] border border-transparent'
          }`}
        >
          <Pipette className="w-5 h-5" />
          <div className="absolute left-12 bg-[#252526] text-[#cccccc] text-xs px-2 py-1 rounded-[2px] border border-[#3a3a3a] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50">
            Pipette (I / Hold Alt)
          </div>
        </button>

        {/* Liquify Button */}
        <button
          onClick={() => onSelectTool('liquify')}
          title="Liquify Tool (J)"
          className={`w-10 h-10 rounded-[2px] flex items-center justify-center transition-colors relative group ${
            currentTool === 'liquify'
              ? 'bg-[#383838] border border-[#4a4a4a] text-white shadow-sm'
              : 'text-[#999999] hover:text-[#cccccc] hover:bg-[#2d2d2d] border border-transparent'
          }`}
        >
          <LiquifyIcon className="w-5 h-5" />
          <div className="absolute left-12 bg-[#252526] text-[#cccccc] text-xs px-2 py-1 rounded-[2px] border border-[#3a3a3a] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50">
            Liquify (J)
          </div>
        </button>
      </div>

      <div className="my-3 w-8 h-px bg-[#333333]" />

      {/* Primary & Secondary Color Indicator Swatches (Clip Studio Paint style) */}
      <div className="mt-auto flex flex-col items-center space-y-2 pb-1">
        <div className="relative w-9 h-9">
          {/* Secondary Color Swatch (bottom-right) */}
          <div
            onClick={onSwapColors}
            title={`Secondary Color: ${secondaryColor} (Click or press X to swap)`}
            className="absolute bottom-0 right-0 w-6 h-6 rounded-[2px] border border-[#555555] cursor-pointer hover:border-white shadow-sm z-0"
            style={{ backgroundColor: secondaryColor }}
          />

          {/* Primary Color Swatch (top-left) */}
          <div
            onClick={onSwapColors}
            title={`Primary Active Color: ${primaryColor}`}
            className="absolute top-0 left-0 w-6 h-6 rounded-[2px] border border-white cursor-pointer shadow-md z-10"
            style={{ backgroundColor: primaryColor }}
          />
        </div>

        {/* Swap button */}
        <button
          onClick={onSwapColors}
          title="Swap Colors (X)"
          className="p-1 text-[#888888] hover:text-[#cccccc] hover:bg-[#333333] rounded-[2px] transition-colors"
        >
          <ArrowLeftRight className="w-3.5 h-3.5" />
        </button>

        <span className="text-[10px] text-[#777777] font-mono">
          X
        </span>
      </div>
    </aside>
  );
};

