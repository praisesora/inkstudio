import React, { useState } from 'react';
import { Disc, SlidersHorizontal, ArrowLeftRight } from 'lucide-react';
import { ColorWheel } from './ColorWheel';
import { ColorSlider } from './ColorSlider';
import { ToolType, CanvasColorMode } from '../types/editor';
import { isValidHex, enforceColorMode } from '../utils/colorUtils';

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
  containerHeight?: number;
}

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
  containerWidth = 180,
  containerHeight,
}) => {
  const [activeTab, setActiveTab] = useState<'wheel' | 'slider'>(() => {
    try {
      const saved = localStorage.getItem('ink_color_tab');
      if (saved === 'wheel' || saved === 'slider') return saved;
    } catch {
      // ignore
    }
    return 'wheel';
  });

  const [activeTarget, setActiveTarget] = useState<'primary' | 'secondary'>('primary');
  const activeColor = activeTarget === 'primary' ? primaryColor : secondaryColor;

  const toggleTab = () => {
    const next = activeTab === 'wheel' ? 'slider' : 'wheel';
    setActiveTab(next);
    try {
      localStorage.setItem('ink_color_tab', next);
    } catch {
      // ignore
    }
  };

  const handleHexChange = (raw: string) => {
    const clean = raw.trim();
    if (!isValidHex(clean)) return;
    let hex = clean.startsWith('#') ? clean : `#${clean}`;
    if (colorMode && colorMode !== 'color') {
      hex = enforceColorMode(hex, colorMode);
    }
    if (activeTarget === 'primary') {
      onPrimaryColorChange(hex, true);
    } else {
      onSecondaryColorChange(hex, true);
    }
  };

  return (
    <div className="flex flex-col h-full w-full select-none bg-[#202020] text-[#e5e5e5] overflow-hidden">
      {/* Compact Header Strip: Swatches + Hex + Recent Dots + Mode Toggle */}
      <div className="h-6 px-2 pt-1 flex items-center justify-between gap-1 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {/* Primary / Secondary Swatch Pair */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setActiveTarget('primary')}
              title={`Primary: ${primaryColor}`}
              className={`w-3.5 h-3.5 rounded-xs cursor-pointer transition-transform ${
                activeTarget === 'primary'
                  ? 'scale-110 shadow-[0_0_0_1.5px_var(--accent)]'
                  : 'opacity-70 hover:opacity-100 shadow-[0_0_0_1px_rgba(255,255,255,0.2)]'
              }`}
              style={{ backgroundColor: primaryColor }}
            />
            <button
              type="button"
              onClick={() => setActiveTarget('secondary')}
              title={`Secondary: ${secondaryColor}`}
              className={`w-3.5 h-3.5 rounded-xs cursor-pointer transition-transform ${
                activeTarget === 'secondary'
                  ? 'scale-110 shadow-[0_0_0_1.5px_var(--accent)]'
                  : 'opacity-70 hover:opacity-100 shadow-[0_0_0_1px_rgba(255,255,255,0.2)]'
              }`}
              style={{ backgroundColor: secondaryColor }}
            />
          </div>

          {/* Compact Hex Readout / Input */}
          <input
            type="text"
            value={activeColor.toUpperCase()}
            onChange={(e) => handleHexChange(e.target.value)}
            maxLength={7}
            className="w-[58px] bg-[#161616] text-[#e5e5e5] font-mono text-[10px] px-1.5 py-0.5 rounded"
            title="Hex Color"
          />
        </div>

        {/* Recent Micro Swatches (when wide) + Swap + Wheel/Slider Toggle */}
        <div className="flex items-center gap-0.5 shrink-0">
          {containerWidth >= 220 && (
            <div className="flex items-center gap-0.5 mr-0.5">
              {recentColors.slice(0, 3).map((c, idx) => (
                <button
                  key={`${c}-${idx}`}
                  type="button"
                  onClick={() =>
                    activeTarget === 'primary'
                      ? onPrimaryColorChange(c, false)
                      : onSecondaryColorChange(c, false)
                  }
                  title={c}
                  className="w-2.5 h-2.5 rounded-full cursor-pointer hover:scale-120 transition-transform"
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={onSwapColors}
            title="Swap Colors (X)"
            className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
          >
            <ArrowLeftRight className="w-2.5 h-2.5" />
          </button>

          <button
            type="button"
            onClick={toggleTab}
            title={activeTab === 'wheel' ? 'Switch to Sliders' : 'Switch to Color Wheel'}
            className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
          >
            {activeTab === 'wheel' ? (
              <SlidersHorizontal className="w-3 h-3" />
            ) : (
              <Disc className="w-3 h-3" />
            )}
          </button>
        </div>
      </div>

      {/* Wheel or Compact Sliders */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        {activeTab === 'wheel' ? (
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
            containerHeight={containerHeight ? Math.max(72, containerHeight - 24) : undefined}
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
            recentColors={[]}
            containerWidth={containerWidth}
            containerHeight={containerHeight ? Math.max(72, containerHeight - 24) : undefined}
            activeTarget={activeTarget}
            onActiveTargetChange={setActiveTarget}
            hideHeader={true}
          />
        )}
      </div>
    </div>
  );
};
