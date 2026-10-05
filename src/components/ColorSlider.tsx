import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  Menu,
  Sliders,
  ChevronUp,
  ChevronDown,
  Copy,
  Check,
  ArrowLeftRight,
} from 'lucide-react';
import { ToolType, CanvasColorMode } from '../types/editor';
import {
  hexToRgb,
  rgbToHex,
  hexToHsv,
  hsvToHex,
  hexToCmyk,
  cmykToHex,
  enforceColorMode,
  isValidHex,
} from '../utils/colorUtils';

export interface ColorSliderProps {
  primaryColor: string;
  secondaryColor: string;
  onPrimaryColorChange: (color: string, commit?: boolean) => void;
  onSecondaryColorChange: (color: string, commit?: boolean) => void;
  onSwapColors?: () => void;
  colorMode?: CanvasColorMode;
  currentTool?: ToolType;
  onSelectTool?: (tool: ToolType) => void;
  recentColors?: string[];
  containerWidth?: number;
  containerHeight?: number;
  activeTarget?: 'primary' | 'secondary';
  onActiveTargetChange?: (target: 'primary' | 'secondary') => void;
  hideHeader?: boolean;
}

type SliderMode = 'rgb' | 'hsv' | 'cmyk';

interface ChannelDef {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  percent: number;
  gradient: string;
}

export const ColorSlider: React.FC<ColorSliderProps> = ({
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
  containerHeight,
  activeTarget: controlledActiveTarget,
  onActiveTargetChange,
  hideHeader = false,
}) => {
  // Target swatch being edited: 'primary' or 'secondary'
  const [internalActiveTarget, setInternalActiveTarget] = useState<'primary' | 'secondary'>('primary');
  const activeTarget = controlledActiveTarget ?? internalActiveTarget;

  const setActiveTarget = (target: 'primary' | 'secondary') => {
    if (onActiveTargetChange) {
      onActiveTargetChange(target);
    } else {
      setInternalActiveTarget(target);
    }
  };

  // Color slider mode: 'rgb' | 'hsv' | 'cmyk' (RGB selected by default matching CSP screenshot)
  const [mode, setMode] = useState<SliderMode>('rgb');
  const [copiedHex, setCopiedHex] = useState(false);

  // Active hex color string
  const activeColor = activeTarget === 'primary' ? primaryColor : secondaryColor;

  // Track dragging channel
  const [draggingChannel, setDraggingChannel] = useState<string | null>(null);
  const draggingChannelRef = useRef<string | null>(null);
  draggingChannelRef.current = draggingChannel;

  // Active channel values cache to prevent drift while dragging
  const [rgbValues, setRgbValues] = useState(() => hexToRgb(activeColor));
  const [hsvValues, setHsvValues] = useState(() => hexToHsv(activeColor));
  const [cmykValues, setCmykValues] = useState(() => hexToCmyk(activeColor));

  // Container sizing
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [measuredSize, setMeasuredSize] = useState<{ width: number; height: number }>({
    width: containerWidth,
    height: containerHeight || 0,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        setMeasuredSize({
          width: w > 0 ? Math.round(w) : containerWidth,
          height: h > 0 ? Math.round(h) : (containerHeight || 0),
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerWidth, containerHeight]);

  const effectiveHeight = containerHeight || measuredSize.height || 0;
  const trackHeight = effectiveHeight > 340 ? 12 : effectiveHeight > 260 ? 10 : 8;
  const swatchHeight = effectiveHeight > 300 ? 'h-7' : 'h-6';
  const spacingClass = effectiveHeight > 320 ? 'space-y-3' : effectiveHeight > 240 ? 'space-y-2' : 'space-y-1';

  // Sync color representation when external activeColor changes (if not dragging)
  useEffect(() => {
    if (draggingChannelRef.current) return;
    const cleanHex = activeColor.startsWith('#') ? activeColor : `#${activeColor}`;
    const rgb = hexToRgb(cleanHex);
    setRgbValues(rgb);
    setHsvValues(hexToHsv(cleanHex));
    setCmykValues(hexToCmyk(cleanHex));
  }, [activeColor]);

  // Emit color updates to parent
  const commitHexColor = useCallback(
    (newHex: string, commitToRecent = false) => {
      let finalHex = newHex;
      if (colorMode && colorMode !== 'color') {
        finalHex = enforceColorMode(finalHex, colorMode);
      }
      if (activeTarget === 'primary') {
        onPrimaryColorChange(finalHex, commitToRecent);
      } else {
        onSecondaryColorChange(finalHex, commitToRecent);
      }
    },
    [activeTarget, colorMode, onPrimaryColorChange, onSecondaryColorChange]
  );

  // Channel update handler
  const handleChannelChange = (channelId: string, newValue: number, commit = false) => {
    if (mode === 'rgb') {
      const clamped = Math.max(0, Math.min(255, Math.round(newValue)));
      const nextRgb = { ...rgbValues, [channelId]: clamped };
      setRgbValues(nextRgb);
      const nextHex = rgbToHex(nextRgb.r, nextRgb.g, nextRgb.b);
      setHsvValues(hexToHsv(nextHex));
      setCmykValues(hexToCmyk(nextHex));
      commitHexColor(nextHex, commit);
    } else if (mode === 'hsv') {
      let nextHsv = { ...hsvValues };
      if (channelId === 'h') {
        nextHsv.h = Math.max(0, Math.min(359, Math.round(newValue)));
      } else if (channelId === 's') {
        nextHsv.s = Math.max(0, Math.min(100, Math.round(newValue))) / 100;
      } else if (channelId === 'v') {
        nextHsv.v = Math.max(0, Math.min(100, Math.round(newValue))) / 100;
      }
      setHsvValues(nextHsv);
      const nextHex = hsvToHex(nextHsv.h, nextHsv.s, nextHsv.v);
      setRgbValues(hexToRgb(nextHex));
      setCmykValues(hexToCmyk(nextHex));
      commitHexColor(nextHex, commit);
    } else if (mode === 'cmyk') {
      const clamped = Math.max(0, Math.min(100, Math.round(newValue)));
      const nextCmyk = { ...cmykValues, [channelId]: clamped };
      setCmykValues(nextCmyk);
      const nextHex = cmykToHex(nextCmyk.c, nextCmyk.m, nextCmyk.y, nextCmyk.k);
      setRgbValues(hexToRgb(nextHex));
      setHsvValues(hexToHsv(nextHex));
      commitHexColor(nextHex, commit);
    }
  };

  // Build active channel definitions with dynamic Clip Studio Paint gradients
  const channels: ChannelDef[] = useMemo(() => {
    if (mode === 'rgb') {
      const { r, g, b } = rgbValues;
      return [
        {
          id: 'r',
          label: 'R',
          value: r,
          min: 0,
          max: 255,
          percent: (r / 255) * 100,
          gradient: `linear-gradient(to right, rgb(0, ${g}, ${b}), rgb(255, ${g}, ${b}))`,
        },
        {
          id: 'g',
          label: 'G',
          value: g,
          min: 0,
          max: 255,
          percent: (g / 255) * 100,
          gradient: `linear-gradient(to right, rgb(${r}, 0, ${b}), rgb(${r}, 255, ${b}))`,
        },
        {
          id: 'b',
          label: 'B',
          value: b,
          min: 0,
          max: 255,
          percent: (b / 255) * 100,
          gradient: `linear-gradient(to right, rgb(${r}, ${g}, 0), rgb(${r}, ${g}, 255))`,
        },
      ];
    } else if (mode === 'hsv') {
      const { h, s, v } = hsvValues;
      const sVal = Math.round(s * 100);
      const vVal = Math.round(v * 100);
      return [
        {
          id: 'h',
          label: 'H',
          value: Math.round(h),
          min: 0,
          max: 359,
          percent: (h / 359) * 100,
          gradient:
            'linear-gradient(to right, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)',
        },
        {
          id: 's',
          label: 'S',
          value: sVal,
          min: 0,
          max: 100,
          percent: sVal,
          gradient: `linear-gradient(to right, ${hsvToHex(h, 0, v)}, ${hsvToHex(h, 1, v)})`,
        },
        {
          id: 'v',
          label: 'V',
          value: vVal,
          min: 0,
          max: 100,
          percent: vVal,
          gradient: `linear-gradient(to right, #000000, ${hsvToHex(h, s, 1)})`,
        },
      ];
    } else {
      const { c, m, y, k } = cmykValues;
      return [
        {
          id: 'c',
          label: 'C',
          value: c,
          min: 0,
          max: 100,
          percent: c,
          gradient: `linear-gradient(to right, ${cmykToHex(0, m, y, k)}, ${cmykToHex(100, m, y, k)})`,
        },
        {
          id: 'm',
          label: 'M',
          value: m,
          min: 0,
          max: 100,
          percent: m,
          gradient: `linear-gradient(to right, ${cmykToHex(c, 0, y, k)}, ${cmykToHex(c, 100, y, k)})`,
        },
        {
          id: 'y',
          label: 'Y',
          value: y,
          min: 0,
          max: 100,
          percent: y,
          gradient: `linear-gradient(to right, ${cmykToHex(c, m, 0, k)}, ${cmykToHex(c, m, 100, k)})`,
        },
        {
          id: 'k',
          label: 'K',
          value: k,
          min: 0,
          max: 100,
          percent: k,
          gradient: `linear-gradient(to right, ${cmykToHex(c, m, y, 0)}, ${cmykToHex(c, m, y, 100)})`,
        },
      ];
    }
  }, [mode, rgbValues, hsvValues, cmykValues]);

  // Pointer dragging on slider tracks
  const trackRefs = useRef<{ [key: string]: HTMLDivElement | null }>({});

  const handlePointerDown = (channelId: string, min: number, max: number, e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDraggingChannel(channelId);
    e.currentTarget.setPointerCapture(e.pointerId);

    const track = trackRefs.current[channelId];
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const val = min + ratio * (max - min);
    handleChannelChange(channelId, val, false);
  };

  const handlePointerMove = (channelId: string, min: number, max: number, e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingChannel !== channelId) return;
    const track = trackRefs.current[channelId];
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const val = min + ratio * (max - min);
    handleChannelChange(channelId, val, false);
  };

  const handlePointerUp = (channelId: string, e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingChannel === channelId) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setDraggingChannel(null);
      // Final commit on release
      const ch = channels.find((c) => c.id === channelId);
      if (ch) {
        handleChannelChange(channelId, ch.value, true);
      }
    }
  };

  const handleStep = (channelId: string, delta: number) => {
    const ch = channels.find((c) => c.id === channelId);
    if (!ch) return;
    const nextVal = Math.max(ch.min, Math.min(ch.max, ch.value + delta));
    handleChannelChange(channelId, nextVal, true);
  };

  // Direct Hex Input Handler
  const handleHexInput = (valStr: string) => {
    const trimmed = valStr.trim();
    if (isValidHex(trimmed)) {
      const formatted = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
      commitHexColor(formatted, true);
    }
  };

  const copyHexToClipboard = () => {
    navigator.clipboard.writeText(activeColor.toUpperCase());
    setCopiedHex(true);
    setTimeout(() => setCopiedHex(false), 1500);
  };

  // Transparent Color Toggle (CSP checkered button)
  const isTransparentActive = currentTool === 'eraser';
  const handleToggleTransparent = () => {
    if (onSelectTool) {
      if (isTransparentActive) {
        onSelectTool('brush');
      } else {
        onSelectTool('eraser');
      }
    }
  };

  return (
    <div ref={containerRef} className="flex flex-col select-none text-[#cccccc] text-xs h-full justify-between">
      {/* Optional Standalone Header if rendered outside ColorPanel */}
      {!hideHeader && (
        <div className="bg-[#2a2a2a] px-3 py-1.5 border-b border-[#333333] flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2 text-xs font-medium text-[#cccccc]">
            <Menu className="w-3.5 h-3.5 text-[#888888] cursor-pointer hover:text-white transition-colors" />
            <div className="flex items-center space-x-1.5">
              <Sliders className="w-3.5 h-3.5 text-[#5ce1e6]" />
              <span className="font-semibold tracking-wide">Color Slider</span>
            </div>
          </div>

          {onSwapColors && (
            <button
              onClick={onSwapColors}
              title="Swap Primary & Secondary Colors (X)"
              className="flex items-center space-x-1 px-1.5 py-0.5 bg-[#1e1e1e] hover:bg-[#333333] text-[#888888] hover:text-[#cccccc] rounded-[2px] border border-[#3a3a3a] transition-colors cursor-pointer"
            >
              <ArrowLeftRight className="w-3 h-3" />
              <span className="text-[10px] font-mono">X</span>
            </button>
          )}
        </div>
      )}

      {/* Main Slider Area matching Clip Studio Paint Photo 2 */}
      <div className="p-2.5 flex-1 flex flex-col justify-between space-y-2">
        {/* Sliders Container with Left Vertical Mode Selector Strip */}
        <div className="flex items-stretch">
          {/* Vertical Color Model Selector (CMYK, HSV, RGB rotated -90deg matching screenshot) */}
          <div className="flex flex-col w-[22px] shrink-0 border border-[#3e3e42] border-r-0 rounded-l-[3px] bg-[#222224] overflow-hidden">
            {/* RGB Mode */}
            <button
              onClick={() => setMode('rgb')}
              title="RGB Color Model"
              className={`flex-1 py-1 flex items-center justify-center cursor-pointer transition-colors relative ${
                mode === 'rgb'
                  ? 'bg-[#2b2b2e] text-[#f0f0f0] font-bold border-r border-[#2b2b2e]'
                  : 'text-[#777777] hover:text-[#bbbbbb] hover:bg-[#28282b]'
              }`}
            >
              <span className="-rotate-90 whitespace-nowrap text-[9px] font-mono tracking-wider">
                RGB
              </span>
            </button>

            {/* HSV Mode */}
            <button
              onClick={() => setMode('hsv')}
              title="HSV Color Model"
              className={`flex-1 py-1 flex items-center justify-center cursor-pointer transition-colors border-t border-[#343438] relative ${
                mode === 'hsv'
                  ? 'bg-[#2b2b2e] text-[#f0f0f0] font-bold border-r border-[#2b2b2e]'
                  : 'text-[#777777] hover:text-[#bbbbbb] hover:bg-[#28282b]'
              }`}
            >
              <span className="-rotate-90 whitespace-nowrap text-[9px] font-mono tracking-wider">
                HSV
              </span>
            </button>

            {/* CMYK Mode */}
            <button
              onClick={() => setMode('cmyk')}
              title="CMYK Color Model"
              className={`flex-1 py-1 flex items-center justify-center cursor-pointer transition-colors border-t border-[#343438] relative ${
                mode === 'cmyk'
                  ? 'bg-[#2b2b2e] text-[#f0f0f0] font-bold border-r border-[#2b2b2e]'
                  : 'text-[#777777] hover:text-[#bbbbbb] hover:bg-[#28282b]'
              }`}
            >
              <span className="-rotate-90 whitespace-nowrap text-[8.5px] font-mono tracking-wider">
                CMYK
              </span>
            </button>
          </div>

          {/* Main Slider Box */}
          <div className={`flex-1 bg-[#2b2b2e] border border-[#3e3e42] rounded-r-[3px] p-2.5 ${spacingClass}`}>
            {channels.map((channel) => (
              <div key={channel.id} className="flex items-center space-x-2">
                {/* Channel Label (R, G, B, H, S, V, C, M, Y, K) */}
                <span className="w-3 text-xs font-semibold text-[#dddddd] text-center shrink-0">
                  {channel.label}
                </span>

                {/* Track + Caret Section */}
                <div
                  className="flex-1 flex flex-col justify-center cursor-pointer touch-none select-none"
                  onPointerDown={(e) => handlePointerDown(channel.id, channel.min, channel.max, e)}
                  onPointerMove={(e) => handlePointerMove(channel.id, channel.min, channel.max, e)}
                  onPointerUp={(e) => handlePointerUp(channel.id, e)}
                  onPointerCancel={(e) => handlePointerUp(channel.id, e)}
                >
                  {/* Track Bar (dynamic height, rounded-[1px], dynamic gradient) */}
                  <div
                    ref={(el) => {
                      trackRefs.current[channel.id] = el;
                    }}
                    style={{ background: channel.gradient, height: trackHeight }}
                    className="relative w-full rounded-[1px] border border-[#1b1b1b] shadow-inner"
                  />

                  {/* Caret Row (triangle pointing straight UP into the track matching Photo 2) */}
                  <div className="relative h-2 w-full pointer-events-none overflow-visible">
                    <div
                      className="absolute top-0 -translate-x-1/2"
                      style={{ left: `${channel.percent}%` }}
                    >
                      <svg
                        width="9"
                        height="5"
                        viewBox="0 0 9 5"
                        className="fill-[#cccccc] stroke-[#111111] stroke-[0.5] filter drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]"
                      >
                        <polygon points="4.5,0 9,5 0,5" />
                      </svg>
                    </div>
                  </div>
                </div>

                {/* Numeric Readout & Up/Down Steppers */}
                <div className="flex items-center space-x-0.5 shrink-0">
                  <input
                    type="number"
                    min={channel.min}
                    max={channel.max}
                    value={channel.value}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val)) {
                        handleChannelChange(channel.id, val, true);
                      }
                    }}
                    className="w-7 bg-transparent text-right font-mono text-[11px] text-[#dddddd] outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  {/* Clip Studio Paint Up/Down Stepper Chevrons */}
                  <div className="flex flex-col justify-center -space-y-1">
                    <button
                      onClick={() => handleStep(channel.id, 1)}
                      title="Increment (+1)"
                      className="p-0 text-[#777777] hover:text-[#5ce1e6] active:text-white cursor-pointer transition-colors"
                    >
                      <ChevronUp className="w-2.5 h-2.5" />
                    </button>
                    <button
                      onClick={() => handleStep(channel.id, -1)}
                      title="Decrement (-1)"
                      className="p-0 text-[#777777] hover:text-[#5ce1e6] active:text-white cursor-pointer transition-colors"
                    >
                      <ChevronDown className="w-2.5 h-2.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Clip Studio Paint Bottom 3 Rounded Swatches (Matching Photo 2 Reference) */}
        <div className="flex items-center space-x-2 pt-0.5">
          {/* Swatch 1: Primary Color (Black in Photo 2 with Slate Blue Selection Ring) */}
          <button
            onClick={() => {
              setActiveTarget('primary');
              if (currentTool === 'eraser' && onSelectTool) onSelectTool('brush');
            }}
            title={`Primary Color: ${primaryColor} (Click to select & edit)`}
            className={`flex-1 ${swatchHeight} rounded-[3px] cursor-pointer transition-all relative overflow-hidden ${
              activeTarget === 'primary' && !isTransparentActive
                ? 'ring-2 ring-[#7c91c0] ring-offset-1 ring-offset-[#252526] border border-black/80 shadow-sm z-10 scale-[1.02]'
                : 'border border-[#555555] hover:border-[#888888]'
            }`}
            style={{ backgroundColor: primaryColor }}
          />

          {/* Swatch 2: Secondary Color (White in Photo 2) */}
          <button
            onClick={() => {
              setActiveTarget('secondary');
              if (currentTool === 'eraser' && onSelectTool) onSelectTool('brush');
            }}
            title={`Secondary Color: ${secondaryColor} (Click to select & edit)`}
            className={`flex-1 ${swatchHeight} rounded-[3px] cursor-pointer transition-all relative overflow-hidden ${
              activeTarget === 'secondary' && !isTransparentActive
                ? 'ring-2 ring-[#7c91c0] ring-offset-1 ring-offset-[#252526] border border-black/80 shadow-sm z-10 scale-[1.02]'
                : 'border border-[#555555] hover:border-[#888888]'
            }`}
            style={{ backgroundColor: secondaryColor }}
          />

          {/* Swatch 3: Transparent Color (Checkerboard pattern in Photo 2) */}
          <button
            onClick={handleToggleTransparent}
            title="Transparent Color / Eraser Mode (C)"
            className={`flex-1 ${swatchHeight} rounded-[3px] cursor-pointer transition-all relative overflow-hidden ${
              isTransparentActive
                ? 'ring-2 ring-[#7c91c0] ring-offset-1 ring-offset-[#252526] border border-black/80 shadow-sm z-10 scale-[1.02]'
                : 'border border-[#555555] hover:border-[#888888]'
            }`}
            style={{
              backgroundImage: 'repeating-conic-gradient(#888888 0% 25%, #444444 0% 50%)',
              backgroundSize: '8px 8px',
            }}
          />
        </div>

        {/* Hex Input & Copy Shortcut */}
        <div className="pt-1">
          <div className="relative flex items-center">
            <span className="absolute left-2 text-[#777777] font-mono text-[11px]">#</span>
            <input
              type="text"
              value={activeColor.replace('#', '').toUpperCase()}
              onChange={(e) => handleHexInput(e.target.value)}
              className="w-full bg-[#1e1e1e] border border-[#333333] focus:border-[#5ce1e6] rounded-[2px] pl-5 pr-7 py-1 text-[#dddddd] font-mono text-xs outline-none"
              maxLength={6}
              placeholder="000000"
            />
            <button
              onClick={copyHexToClipboard}
              title="Copy Hex Code"
              className="absolute right-1.5 p-1 text-[#777777] hover:text-white rounded transition-colors"
            >
              {copiedHex ? (
                <Check className="w-3 h-3 text-emerald-400" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
            </button>
          </div>
        </div>

        {/* Recent Color History Swatches */}
        {recentColors && recentColors.length > 0 && (
          <div className="pt-1.5 border-t border-[#2e2e30]">
            <div className="flex items-center justify-between text-[10px] text-[#777777] mb-1 font-medium">
              <span>Recent Colors</span>
              <span className="text-[9px] text-[#555555]">{recentColors.length} items</span>
            </div>
            <div className="flex items-center space-x-1 overflow-x-auto py-0.5 scrollbar-thin">
              {recentColors.map((color, idx) => (
                <button
                  key={`${color}-${idx}`}
                  onClick={() => {
                    commitHexColor(color, false);
                  }}
                  title={`Recent: ${color}`}
                  className={`w-5 h-5 rounded-[2px] border shrink-0 cursor-pointer transition-transform hover:scale-110 ${
                    activeColor.toLowerCase() === color.toLowerCase()
                      ? 'border-white ring-1 ring-[#5ce1e6]'
                      : 'border-[#383838] hover:border-[#777777]'
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
