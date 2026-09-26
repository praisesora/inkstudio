import React, { useState, useId, useMemo, useEffect } from 'react';
import {
  X,
  Lock,
  Unlock,
  ArrowLeftRight,
  Printer,
  Maximize2,
  Check,
  ArrowUpLeft,
  ArrowUp,
  ArrowUpRight,
  ArrowLeft,
  Circle,
  ArrowRight,
  ArrowDownLeft,
  ArrowDown,
  ArrowDownRight,
} from 'lucide-react';
import { CanvasDimensions } from '../types/editor';
import { AnchorPosition, ResizeCanvasOptions } from '../types/settings';
import { DPI_PRESETS } from './NewCanvasModal';

function gcd(a: number, b: number): number {
  a = Math.round(Math.abs(a));
  b = Math.round(Math.abs(b));
  return b ? gcd(b, a % b) : a;
}

const RATIO_PRESETS = [
  { label: '16:9', x: 16, y: 9 },
  { label: '1:1', x: 1, y: 1 },
  { label: '4:3', x: 4, y: 3 },
  { label: '3:2', x: 3, y: 2 },
  { label: '9:16', x: 9, y: 16 },
  { label: '2:3', x: 2, y: 3 },
  { label: '21:9', x: 21, y: 9 },
];

const ANCHOR_GRID: { id: AnchorPosition; label: string; icon: React.ReactNode }[] = [
  { id: 'top-left', label: 'Top Left', icon: <ArrowUpLeft className="w-3.5 h-3.5" /> },
  { id: 'top', label: 'Top Center', icon: <ArrowUp className="w-3.5 h-3.5" /> },
  { id: 'top-right', label: 'Top Right', icon: <ArrowUpRight className="w-3.5 h-3.5" /> },
  { id: 'left', label: 'Middle Left', icon: <ArrowLeft className="w-3.5 h-3.5" /> },
  { id: 'center', label: 'Center', icon: <Circle className="w-2.5 h-2.5 fill-current" /> },
  { id: 'right', label: 'Middle Right', icon: <ArrowRight className="w-3.5 h-3.5" /> },
  { id: 'bottom-left', label: 'Bottom Left', icon: <ArrowDownLeft className="w-3.5 h-3.5" /> },
  { id: 'bottom', label: 'Bottom Center', icon: <ArrowDown className="w-3.5 h-3.5" /> },
  { id: 'bottom-right', label: 'Bottom Right', icon: <ArrowDownRight className="w-3.5 h-3.5" /> },
];

interface ResizeCanvasModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentDimensions: CanvasDimensions;
  onResize: (options: ResizeCanvasOptions) => void;
}

export const ResizeCanvasModal: React.FC<ResizeCanvasModalProps> = ({
  isOpen,
  onClose,
  currentDimensions,
  onResize,
}) => {
  const widthInputId = useId();
  const heightInputId = useId();
  const dpiInputId = useId();

  const [width, setWidth] = useState<number>(currentDimensions.width);
  const [height, setHeight] = useState<number>(currentDimensions.height);
  const [dpi, setDpi] = useState<number>(currentDimensions.dpi || 300);
  const [lockRatio, setLockRatio] = useState<boolean>(true);
  const [scaleContent, setScaleContent] = useState<boolean>(false);
  const [anchor, setAnchor] = useState<AnchorPosition>('center');

  // Keep track of locked aspect ratio values
  const [ratioX, setRatioX] = useState<number>(currentDimensions.width);
  const [ratioY, setRatioY] = useState<number>(currentDimensions.height);

  // Synchronize when opening
  useEffect(() => {
    if (isOpen) {
      setWidth(currentDimensions.width);
      setHeight(currentDimensions.height);
      setDpi(currentDimensions.dpi || 300);
      setRatioX(currentDimensions.width);
      setRatioY(currentDimensions.height);
    }
  }, [isOpen, currentDimensions]);

  // Simplified aspect ratio string
  const simplifiedRatio = useMemo(() => {
    if (width <= 0 || height <= 0) return '1:1';
    const divisor = gcd(width, height);
    const simpleX = width / divisor;
    const simpleY = height / divisor;
    if (simpleX < 50 && simpleY < 50) {
      return `${simpleX}:${simpleY}`;
    }
    const dec = (width / height).toFixed(2);
    return `${dec}:1`;
  }, [width, height]);

  // Dimension scaling percentages relative to current canvas
  const percentW = useMemo(() => {
    return Math.round((width / (currentDimensions.width || 1)) * 100);
  }, [width, currentDimensions.width]);

  const percentH = useMemo(() => {
    return Math.round((height / (currentDimensions.height || 1)) * 100);
  }, [height, currentDimensions.height]);

  // Megapixels
  const megapixels = useMemo(() => {
    return ((width * height) / 1000000).toFixed(2);
  }, [width, height]);

  // Physical print sizes
  const printDimensionsCm = useMemo(() => {
    const safeDpi = Math.max(1, dpi);
    return {
      w: ((width / safeDpi) * 2.54).toFixed(1),
      h: ((height / safeDpi) * 2.54).toFixed(1),
    };
  }, [width, height, dpi]);

  const handleWidthChange = (val: number) => {
    const newW = Math.max(1, Math.min(16384, Math.round(val)));
    setWidth(newW);
    if (lockRatio && ratioX > 0 && ratioY > 0) {
      const newH = Math.max(1, Math.round((newW * ratioY) / ratioX));
      setHeight(newH);
    }
  };

  const handleHeightChange = (val: number) => {
    const newH = Math.max(1, Math.min(16384, Math.round(val)));
    setHeight(newH);
    if (lockRatio && ratioX > 0 && ratioY > 0) {
      const newW = Math.max(1, Math.round((newH * ratioX) / ratioY));
      setWidth(newW);
    }
  };

  const handleSwapDimensions = () => {
    const prevW = width;
    const prevH = height;
    setWidth(prevH);
    setHeight(prevW);
    setRatioX(ratioY);
    setRatioY(ratioX);
  };

  const handleApplyRatioPreset = (x: number, y: number) => {
    setRatioX(x);
    setRatioY(y);
    const newH = Math.max(1, Math.round((width * y) / x));
    setHeight(newH);
  };

  const handleApplyResize = () => {
    onResize({
      width,
      height,
      dpi: Math.max(1, Math.round(dpi)),
      scaleContent,
      anchor,
    });
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-4 select-none animate-in fade-in duration-150"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleApplyResize();
      }}
    >
      <div className="bg-[#222224] border border-[#3e3e42] rounded-lg shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden text-xs text-[#cccccc]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-[#2a2a2d] border-b border-[#38383a]">
          <div className="flex items-center space-x-2.5">
            <div className="w-5 h-5 rounded-[3px] bg-[#007acc]/20 border border-[#007acc]/40 flex items-center justify-center text-[#38bdf8]">
              <Maximize2 className="w-3.5 h-3.5" />
            </div>
            <h2 className="text-sm font-semibold text-white tracking-wide">Resize Canvas</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#38383a] text-[#888888] hover:text-white transition-colors"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 max-h-[82vh] overflow-y-auto">
          {/* Current Canvas Status Bar */}
          <div className="bg-[#18181a] border border-[#333336] rounded-md px-3.5 py-2.5 flex items-center justify-between">
            <span className="text-[#888888] text-[11px]">Current Dimensions:</span>
            <div className="flex items-center space-x-2 font-mono text-xs">
              <span className="text-white font-semibold">
                {currentDimensions.width} × {currentDimensions.height} px
              </span>
              <span className="text-[#666666]">|</span>
              <span className="text-[#38bdf8]">{currentDimensions.dpi || 300} DPI</span>
            </div>
          </div>

          {/* New Dimensions & Keep Aspect Ratio */}
          <div className="bg-[#1a1a1c] border border-[#333336] rounded-md p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-[#aaaaaa] uppercase tracking-wider">
                New Dimensions
              </span>
              <div className="flex items-center space-x-1.5">
                <button
                  type="button"
                  onClick={() => setLockRatio(!lockRatio)}
                  className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs transition-colors border ${
                    lockRatio
                      ? 'bg-[#007acc]/20 border-[#007acc]/50 text-[#38bdf8] font-medium'
                      : 'bg-[#2a2a2d] border-[#38383a] text-[#888888] hover:text-[#cccccc]'
                  }`}
                  title={lockRatio ? 'Keep aspect ratio: editing width updates height' : 'Aspect ratio unlocked'}
                >
                  {lockRatio ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5 text-[#666666]" />}
                  <span>{lockRatio ? 'Keep Aspect Ratio' : 'Ratio Free'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleSwapDimensions}
                  className="p-1 rounded bg-[#2a2a2d] hover:bg-[#38383a] border border-[#38383a] text-[#aaaaaa] hover:text-white transition-colors"
                  title="Swap Width and Height (Landscape ⇄ Portrait)"
                >
                  <ArrowLeftRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3.5">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label htmlFor={widthInputId} className="text-[11px] text-[#888888]">
                    Width (px)
                  </label>
                  <span className="text-[10px] font-mono text-[#666666]">{percentW}%</span>
                </div>
                <input
                  id={widthInputId}
                  type="number"
                  min="64"
                  max="16384"
                  value={width}
                  onChange={(e) => handleWidthChange(Number(e.target.value))}
                  className="w-full bg-[#222225] border border-[#3e3e42] rounded px-3 py-1.5 font-mono text-sm text-white focus:outline-hidden focus:border-[#007acc]"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label htmlFor={heightInputId} className="text-[11px] text-[#888888]">
                    Height (px)
                  </label>
                  <span className="text-[10px] font-mono text-[#666666]">{percentH}%</span>
                </div>
                <input
                  id={heightInputId}
                  type="number"
                  min="64"
                  max="16384"
                  value={height}
                  onChange={(e) => handleHeightChange(Number(e.target.value))}
                  className="w-full bg-[#222225] border border-[#3e3e42] rounded px-3 py-1.5 font-mono text-sm text-white focus:outline-hidden focus:border-[#007acc]"
                />
              </div>
            </div>

            {/* Quick Ratio Presets */}
            <div className="flex items-center space-x-2 pt-1">
              <span className="text-[11px] text-[#888888] whitespace-nowrap">Ratio Presets:</span>
              <div className="flex flex-wrap gap-1.5">
                {RATIO_PRESETS.map((r) => {
                  const isActive = Math.abs(width / height - r.x / r.y) < 0.01;
                  return (
                    <button
                      key={r.label}
                      type="button"
                      onClick={() => handleApplyRatioPreset(r.x, r.y)}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors border ${
                        isActive
                          ? 'bg-[#007acc] border-[#007acc] text-white font-medium'
                          : 'bg-[#252528] border-[#38383c] text-[#aaaaaa] hover:bg-[#303034] hover:text-white'
                      }`}
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Resolution (DPI) */}
          <div className="bg-[#1a1a1c] border border-[#333336] rounded-md p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-1.5">
                <Printer className="w-3.5 h-3.5 text-[#38bdf8]" />
                <span className="text-[11px] font-semibold text-[#aaaaaa] uppercase tracking-wider">
                  Resolution (DPI / PPI)
                </span>
              </div>
              <span className="font-mono text-[11px] text-[#38bdf8]">
                Print: {printDimensionsCm.w} × {printDimensionsCm.h} cm
              </span>
            </div>

            <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
              {DPI_PRESETS.map((p) => {
                const isSelected = dpi === p.dpi;
                return (
                  <button
                    key={p.dpi}
                    type="button"
                    onClick={() => setDpi(p.dpi)}
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

            <div className="pt-2 border-t border-[#2e2e32] flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <label htmlFor={dpiInputId} className="text-[11px] text-[#888888]">
                  Manual DPI:
                </label>
                <input
                  id={dpiInputId}
                  type="number"
                  min="1"
                  max="4800"
                  value={dpi}
                  onChange={(e) => setDpi(Math.max(1, Math.min(4800, Number(e.target.value) || 1)))}
                  className="w-20 bg-[#222225] border border-[#3e3e42] rounded px-2.5 py-1 text-center font-mono text-xs text-white focus:outline-hidden focus:border-[#007acc]"
                />
              </div>
              <span className="text-[11px] text-[#888888] font-mono">Total Pixels: {megapixels} MP</span>
            </div>
          </div>

          {/* Mode & Anchor Grid */}
          <div className="bg-[#1a1a1c] border border-[#333336] rounded-md p-3.5 space-y-3">
            <span className="text-[11px] font-semibold text-[#aaaaaa] uppercase tracking-wider block">
              Resize Behavior & Anchor
            </span>

            {/* Mode Toggle */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setScaleContent(false)}
                className={`p-2.5 rounded-md border text-left transition-all ${
                  !scaleContent
                    ? 'bg-[#007acc]/15 border-[#007acc] text-white ring-1 ring-[#007acc]'
                    : 'bg-[#222225] border-[#38383c] text-[#aaaaaa] hover:border-[#4a4a4e]'
                }`}
              >
                <div className="font-semibold text-xs text-white mb-0.5">Canvas Bounds (Anchor)</div>
                <p className="text-[10px] text-[#888888] leading-tight">
                  Expands or crops canvas area around artwork without distorting pixels.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setScaleContent(true)}
                className={`p-2.5 rounded-md border text-left transition-all ${
                  scaleContent
                    ? 'bg-[#007acc]/15 border-[#007acc] text-white ring-1 ring-[#007acc]'
                    : 'bg-[#222225] border-[#38383c] text-[#aaaaaa] hover:border-[#4a4a4e]'
                }`}
              >
                <div className="font-semibold text-xs text-white mb-0.5">Scale Content (Resample)</div>
                <p className="text-[10px] text-[#888888] leading-tight">
                  Stretches and scales all layer artwork to match the new dimensions.
                </p>
              </button>
            </div>

            {/* 3x3 Anchor Grid when Canvas Bounds is active */}
            {!scaleContent && (
              <div className="pt-2 border-t border-[#2e2e32] flex items-center justify-between">
                <div>
                  <span className="text-xs text-white font-medium block">Anchor Position</span>
                  <span className="text-[11px] text-[#888888]">Choose where existing artwork remains</span>
                </div>

                <div className="grid grid-cols-3 gap-1 bg-[#151517] p-1.5 rounded-md border border-[#333336]">
                  {ANCHOR_GRID.map((item) => {
                    const isSelected = anchor === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setAnchor(item.id)}
                        className={`w-7 h-7 rounded flex items-center justify-center transition-colors ${
                          isSelected
                            ? 'bg-[#007acc] text-white shadow-xs'
                            : 'bg-[#252528] text-[#888888] hover:bg-[#323236] hover:text-white'
                        }`}
                        title={item.label}
                      >
                        {item.icon}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 bg-[#2a2a2d] border-t border-[#38383a]">
          <span className="text-[11px] text-[#777777] hidden sm:block">
            Ratio: <span className="font-mono text-[#aaaaaa]">{simplifiedRatio}</span>
          </span>

          <div className="flex items-center space-x-2.5 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded bg-[#333336] hover:bg-[#3d3d42] text-[#cccccc] hover:text-white border border-[#444448] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApplyResize}
              className="flex items-center space-x-1.5 px-5 py-1.5 rounded bg-[#007acc] hover:bg-[#008be5] active:bg-[#006bb3] text-white font-medium shadow-sm transition-colors"
            >
              <Check className="w-4 h-4" />
              <span>Resize Canvas</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
