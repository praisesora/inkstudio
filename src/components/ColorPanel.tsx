import React, { useState, useCallback, useRef } from 'react';
import { Disc, SlidersHorizontal, ArrowLeftRight } from 'lucide-react';
import { ColorWheel } from './ColorWheel';
import { ColorSlider } from './ColorSlider';
import {
  SphereColorPicker,
  SphereColorPickerModal,
  SpherePickerSharedState,
  createInitialSphereState,
} from './SphereColorPicker';
import { ToolType, CanvasColorMode } from '../types/editor';
import { isValidHex, enforceColorMode } from '../utils/colorUtils';
import { safeLocalStorageSetItem } from '../utils/safeStorage';

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

type ColorPanelTab = 'wheel' | 'slider' | 'sphere';

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
  const [activeTab, setActiveTab] = useState<ColorPanelTab>(() => {
    try {
      const saved = localStorage.getItem('ink_color_tab');
      if (saved === 'wheel' || saved === 'slider' || saved === 'sphere') return saved;
    } catch {
      // ignore
    }
    return 'wheel';
  });

  const lastNonSphereTabRef = useRef<'wheel' | 'slider'>(
    activeTab === 'slider' ? 'slider' : 'wheel'
  );

  const [activeTarget, setActiveTarget] = useState<'primary' | 'secondary'>('primary');
  const activeColor = activeTarget === 'primary' ? primaryColor : secondaryColor;
  const isMonoCanvas = colorMode === 'grayscale' || colorMode === 'monochrome';

  const [isSphereFloating, setIsSphereFloating] = useState(false);
  const [sphereState, setSphereState] = useState<SpherePickerSharedState>(() =>
    createInitialSphereState(primaryColor, isMonoCanvas)
  );

  const selectTab = useCallback((next: ColorPanelTab) => {
    if (next !== 'sphere') {
      lastNonSphereTabRef.current = next;
    } else {
      // Dock back when explicitly selecting the Sphere tab
      setIsSphereFloating(false);
    }
    setActiveTab(next);
    safeLocalStorageSetItem('ink_color_tab', next, 'color panel preference');
  }, []);

  const handleUnpinSphere = useCallback(() => {
    setIsSphereFloating(true);
    const fallback = lastNonSphereTabRef.current;
    setActiveTab(fallback);
    safeLocalStorageSetItem('ink_color_tab', fallback, 'color panel preference');
  }, []);

  const handlePinSphere = useCallback(() => {
    setIsSphereFloating(false);
    setActiveTab('sphere');
    safeLocalStorageSetItem('ink_color_tab', 'sphere', 'color panel preference');
  }, []);

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

  const handleSphereColorChange = useCallback(
    ({ hex }: { hex: string }, commit?: boolean) => {
      const finalHex =
        colorMode && colorMode !== 'color' ? enforceColorMode(hex, colorMode) : hex;
      if (activeTarget === 'primary') {
        onPrimaryColorChange(finalHex, commit);
      } else {
        onSecondaryColorChange(finalHex, commit);
      }
    },
    [activeTarget, colorMode, onPrimaryColorChange, onSecondaryColorChange]
  );

  return (
    <div className="flex flex-col h-full w-full select-none bg-[#202020] text-[#e5e5e5] overflow-hidden">
      {/* Compact Header Strip: Swatches + Hex + Recent Dots + Swap + Mode Switchers */}
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

        {/* Recent Micro Swatches + Swap + Wheel / Sliders / 3D Sphere Tabs */}
        <div className="flex items-center gap-0.5 shrink-0">
          {containerWidth >= 236 && (
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
            onClick={() => selectTab('wheel')}
            title="Color Wheel"
            aria-pressed={activeTab === 'wheel'}
            className={`w-5 h-5 rounded flex items-center justify-center cursor-pointer transition-colors ${
              activeTab === 'wheel'
                ? 'bg-[#2f2f32] text-white'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
            }`}
          >
            <Disc className="w-3 h-3" />
          </button>

          <button
            type="button"
            onClick={() => selectTab('slider')}
            title="Color Sliders"
            aria-pressed={activeTab === 'slider'}
            className={`w-5 h-5 rounded flex items-center justify-center cursor-pointer transition-colors ${
              activeTab === 'slider'
                ? 'bg-[#2f2f32] text-white'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
            }`}
          >
            <SlidersHorizontal className="w-3 h-3" />
          </button>

          <button
            type="button"
            onClick={() => {
              if (activeTab === 'sphere' && !isSphereFloating) {
                handleUnpinSphere();
              } else if (isSphereFloating) {
                handlePinSphere();
              } else {
                selectTab('sphere');
              }
            }}
            title={
              isSphereFloating
                ? '3D Sphere (Floating — click to dock)'
                : activeTab === 'sphere'
                  ? '3D Sphere (Docked — click to unpin & float)'
                  : '3D Sphere Color Picker'
            }
            aria-label="3D Sphere Color Picker"
            aria-pressed={activeTab === 'sphere' || isSphereFloating}
            className={`w-5 h-5 rounded flex items-center justify-center cursor-pointer transition-colors ${
              activeTab === 'sphere' || isSphereFloating
                ? 'bg-[#2f2f32] ring-1 ring-white/25'
                : 'hover:bg-[#2c2c2c]'
            }`}
          >
            <span
              className="w-3 h-3 rounded-full block"
              style={{
                background:
                  'radial-gradient(circle at 32% 30%, #f5f5f5 0%, #9ca3af 48%, #2e3440 100%)',
              }}
            />
          </button>
        </div>
      </div>

      {/* Docked Content: Wheel, Sliders, or Inline 3D Sphere */}
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
        ) : activeTab === 'slider' ? (
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
        ) : (
          <SphereColorPicker
            variant="docked"
            isPinned={true}
            onTogglePin={handleUnpinSphere}
            initialColor={activeColor}
            monochromeDefault={isMonoCanvas}
            sharedState={sphereState}
            onSharedStateChange={setSphereState}
            onColorChange={handleSphereColorChange}
            onEyedropper={onSelectTool ? () => onSelectTool('pipette') : undefined}
          />
        )}
      </div>

      {/* Unpinned Non-Blocking Draggable Floating 3D Sphere */}
      <SphereColorPickerModal
        isOpen={isSphereFloating}
        onClose={() => setIsSphereFloating(false)}
        onTogglePin={handlePinSphere}
        initialColor={activeColor}
        monochromeDefault={isMonoCanvas}
        sharedState={sphereState}
        onSharedStateChange={setSphereState}
        onColorChange={handleSphereColorChange}
        onEyedropper={onSelectTool ? () => onSelectTool('pipette') : undefined}
      />
    </div>
  );
};
