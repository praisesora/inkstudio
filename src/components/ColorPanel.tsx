import React, { useState, useEffect, useRef } from 'react';
import {
  Menu,
  Disc,
  ArrowLeftRight,
  Columns,
} from 'lucide-react';
import { ColorWheel } from './ColorWheel';
import { ColorSlider } from './ColorSlider';
import { ToolType, CanvasColorMode } from '../types/editor';

export interface ColorPanelProps {
  primaryColor: string;
  secondaryColor: string;
  onPrimaryColorChange: (color: string, commit?: boolean) => void;
  onSecondaryColorChange: (color: string, commit?: boolean) => void;
  onSwapColors: () => void;
  colorMode?: CanvasColorMode;
  currentTool?: ToolType;
  onSelectTool?: (tool: ToolType) => void;
  recentColors?: string[];
  containerWidth?: number;
}

// Clip Studio Paint style 3-slider horizontal icon
export const ColorSliderIcon: React.FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg className={className} viewBox="0 0 16 16" fill="currentColor">
    {/* 3 slider tracks */}
    <path d="M1 3.5h14v1H1zM1 7.5h14v1H1zM1 11.5h14v1H1z" fill="currentColor" opacity="0.5" />
    {/* 3 slider knobs matching CSP reference */}
    <rect x="2.5" y="2" width="3.5" height="4" rx="0.5" fill="currentColor" />
    <rect x="2.5" y="6" width="3.5" height="4" rx="0.5" fill="currentColor" />
    <rect x="2.5" y="10" width="3.5" height="4" rx="0.5" fill="currentColor" />
  </svg>
);

export const ColorPanel: React.FC<ColorPanelProps> = ({
  primaryColor,
  secondaryColor,
  onPrimaryColorChange,
  onSecondaryColorChange,
  onSwapColors,
  colorMode = 'color',
  currentTool = 'brush',
  onSelectTool,
  recentColors = [],
  containerWidth = 320,
}) => {
  // Active palette tab: 'wheel' | 'slider'
  const [activeTab, setActiveTab] = useState<'wheel' | 'slider'>(() => {
    try {
      const saved = localStorage.getItem('forsora_color_tab');
      if (saved === 'wheel' || saved === 'slider') return saved;
    } catch {
      // ignore
    }
    // Default to 'slider' so the newly requested Color Slider is immediately front and center!
    return 'slider';
  });

  // Display mode: 'tabbed' (default matching Photo 2) or 'split' (shows both stacked)
  const [viewMode, setViewMode] = useState<'tabbed' | 'split'>('tabbed');

  // Shared activeTarget ('primary' | 'secondary') so switching tabs preserves target
  const [activeTarget, setActiveTarget] = useState<'primary' | 'secondary'>('primary');

  // Hamburger popup menu state
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close menu on click outside
  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  const selectTab = (tab: 'wheel' | 'slider') => {
    setActiveTab(tab);
    try {
      localStorage.setItem('forsora_color_tab', tab);
    } catch {
      // ignore
    }
  };

  // Determine if tab labels should be compact icon-only when narrow
  const isNarrow = containerWidth < 275;

  return (
    <div className="flex flex-col select-none text-[#cccccc] text-xs">
      {/* Clip Studio Paint Palette Tab Header Bar */}
      <div className="bg-[#242426] px-2 py-0 border-b border-[#333333] flex items-center justify-between h-[30px] relative">
        {/* Left: Menu & Palette Tabs */}
        <div className="flex items-center space-x-1.5 h-full">
          {/* Hamburger Menu Button */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              title="Color Palette Options"
              className="p-1 text-[#888888] hover:text-white rounded-[2px] transition-colors cursor-pointer"
            >
              <Menu className="w-3.5 h-3.5" />
            </button>

            {/* Popup Context Menu */}
            {menuOpen && (
              <div className="absolute left-0 top-7 z-50 w-48 bg-[#202022] border border-[#3e3e42] rounded-[3px] shadow-2xl py-1 text-xs text-[#cccccc]">
                <button
                  onClick={() => {
                    setViewMode('tabbed');
                    selectTab('wheel');
                    setMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#333338] flex items-center space-x-2 cursor-pointer"
                >
                  <Disc className="w-3.5 h-3.5 text-[#5ce1e6]" />
                  <span>Color Wheel</span>
                  {viewMode === 'tabbed' && activeTab === 'wheel' && (
                    <span className="ml-auto text-[#5ce1e6] text-[10px]">✓</span>
                  )}
                </button>
                <button
                  onClick={() => {
                    setViewMode('tabbed');
                    selectTab('slider');
                    setMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#333338] flex items-center space-x-2 cursor-pointer"
                >
                  <ColorSliderIcon className="w-3.5 h-3.5 text-[#5ce1e6]" />
                  <span>Color Slider</span>
                  {viewMode === 'tabbed' && activeTab === 'slider' && (
                    <span className="ml-auto text-[#5ce1e6] text-[10px]">✓</span>
                  )}
                </button>

                <div className="border-t border-[#343438] my-1" />

                <button
                  onClick={() => {
                    setViewMode((v) => (v === 'split' ? 'tabbed' : 'split'));
                    setMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#333338] flex items-center space-x-2 cursor-pointer"
                >
                  <Columns className="w-3.5 h-3.5 text-[#888888]" />
                  <span>
                    {viewMode === 'split' ? 'Switch to Tabbed View' : 'Show Both (Split View)'}
                  </span>
                </button>

                <div className="border-t border-[#343438] my-1" />

                <button
                  onClick={() => {
                    onSwapColors();
                    setMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:bg-[#333338] flex items-center justify-between cursor-pointer"
                >
                  <span>Swap Colors</span>
                  <span className="font-mono text-[10px] text-[#777777]">X</span>
                </button>
              </div>
            )}
          </div>

          {/* Palette Tabs: Tab 1 (Color Wheel) & Tab 2 (Color Slider) */}
          <div className="flex items-center h-full space-x-0.5">
            {/* Tab 1: Color Wheel */}
            <button
              onClick={() => {
                if (viewMode === 'split') setViewMode('tabbed');
                selectTab('wheel');
              }}
              title="Color Wheel"
              className={`h-full px-2 flex items-center space-x-1.5 border-t-2 transition-all cursor-pointer rounded-t-[2px] ${
                viewMode === 'tabbed' && activeTab === 'wheel'
                  ? 'bg-[#252526] border-t-[#5ce1e6] border-x border-[#333333] text-white font-medium shadow-sm -mb-[1px] z-10'
                  : 'bg-transparent border-t-transparent text-[#888888] hover:text-[#cccccc] hover:bg-[#2b2b2e]'
              }`}
            >
              <Disc
                className={`w-3.5 h-3.5 ${
                  viewMode === 'tabbed' && activeTab === 'wheel'
                    ? 'text-[#5ce1e6]'
                    : 'text-[#888888]'
                }`}
              />
              {/* Show text if not narrow or if this is the active tab */}
              {(!isNarrow || (viewMode === 'tabbed' && activeTab === 'wheel')) && (
                <span className="tracking-wide">Color Wheel</span>
              )}
            </button>

            {/* Tab 2: Color Slider (Matching Reference Photo 2) */}
            <button
              onClick={() => {
                if (viewMode === 'split') setViewMode('tabbed');
                selectTab('slider');
              }}
              title="Color Slider"
              className={`h-full px-2 flex items-center space-x-1.5 border-t-2 transition-all cursor-pointer rounded-t-[2px] ${
                viewMode === 'tabbed' && activeTab === 'slider'
                  ? 'bg-[#252526] border-t-[#5ce1e6] border-x border-[#333333] text-white font-medium shadow-sm -mb-[1px] z-10'
                  : 'bg-transparent border-t-transparent text-[#888888] hover:text-[#cccccc] hover:bg-[#2b2b2e]'
              }`}
            >
              <ColorSliderIcon
                className={`w-3.5 h-3.5 ${
                  viewMode === 'tabbed' && activeTab === 'slider'
                    ? 'text-[#5ce1e6]'
                    : 'text-[#888888]'
                }`}
              />
              {/* Show text if not narrow or if this is the active tab */}
              {(!isNarrow || (viewMode === 'tabbed' && activeTab === 'slider')) && (
                <span className="tracking-wide">Color Slider</span>
              )}
            </button>
          </div>
        </div>

        {/* Right: Swap Colors Shortcut Button (X) */}
        <div className="flex items-center space-x-1">
          <button
            onClick={onSwapColors}
            title="Swap Primary & Secondary Colors (X)"
            className="flex items-center space-x-1 px-1.5 py-0.5 bg-[#1e1e1e] hover:bg-[#333333] text-[#888888] hover:text-[#cccccc] rounded-[2px] border border-[#3a3a3a] transition-colors cursor-pointer"
          >
            <ArrowLeftRight className="w-3 h-3" />
            <span className="text-[10px] font-mono">X</span>
          </button>
        </div>
      </div>

      {/* Palette Content Area */}
      {viewMode === 'tabbed' ? (
        activeTab === 'wheel' ? (
          <ColorWheel
            primaryColor={primaryColor}
            secondaryColor={secondaryColor}
            onPrimaryColorChange={onPrimaryColorChange}
            onSecondaryColorChange={onSecondaryColorChange}
            onSwapColors={onSwapColors}
            colorMode={colorMode}
            currentTool={currentTool}
            onSelectTool={onSelectTool}
            recentColors={recentColors}
            containerWidth={containerWidth}
            activeTarget={activeTarget}
            onActiveTargetChange={setActiveTarget}
            hideHeader={true}
          />
        ) : (
          <ColorSlider
            primaryColor={primaryColor}
            secondaryColor={secondaryColor}
            onPrimaryColorChange={onPrimaryColorChange}
            onSecondaryColorChange={onSecondaryColorChange}
            onSwapColors={onSwapColors}
            colorMode={colorMode}
            currentTool={currentTool}
            onSelectTool={onSelectTool}
            recentColors={recentColors}
            containerWidth={containerWidth}
            activeTarget={activeTarget}
            onActiveTargetChange={setActiveTarget}
            hideHeader={true}
          />
        )
      ) : (
        /* Split View Mode: Both Color Wheel & Color Slider Stacked */
        <div className="divide-y divide-[#333333]">
          <div className="pb-1">
            <div className="px-3 py-1 bg-[#1e1e20] text-[10px] font-semibold text-[#888888] uppercase tracking-wider flex items-center space-x-1">
              <Disc className="w-3 h-3 text-[#5ce1e6]" />
              <span>Color Wheel</span>
            </div>
            <ColorWheel
              primaryColor={primaryColor}
              secondaryColor={secondaryColor}
              onPrimaryColorChange={onPrimaryColorChange}
              onSecondaryColorChange={onSecondaryColorChange}
              onSwapColors={onSwapColors}
              colorMode={colorMode}
              currentTool={currentTool}
              onSelectTool={onSelectTool}
              recentColors={[]}
              containerWidth={containerWidth}
              activeTarget={activeTarget}
              onActiveTargetChange={setActiveTarget}
              hideHeader={true}
            />
          </div>

          <div className="pt-1">
            <div className="px-3 py-1 bg-[#1e1e20] text-[10px] font-semibold text-[#888888] uppercase tracking-wider flex items-center space-x-1">
              <ColorSliderIcon className="w-3 h-3 text-[#5ce1e6]" />
              <span>Color Slider</span>
            </div>
            <ColorSlider
              primaryColor={primaryColor}
              secondaryColor={secondaryColor}
              onPrimaryColorChange={onPrimaryColorChange}
              onSecondaryColorChange={onSecondaryColorChange}
              onSwapColors={onSwapColors}
              colorMode={colorMode}
              currentTool={currentTool}
              onSelectTool={onSelectTool}
              recentColors={recentColors}
              containerWidth={containerWidth}
              activeTarget={activeTarget}
              onActiveTargetChange={setActiveTarget}
              hideHeader={true}
            />
          </div>
        </div>
      )}
    </div>
  );
};
