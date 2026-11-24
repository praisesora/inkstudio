import React, { useState, useId, useMemo, useEffect, useCallback } from 'react';
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

  const handleApplyResize = useCallback(() => {
    onResize({
      width,
      height,
      dpi: Math.max(1, Math.round(dpi)),
      scaleContent,
      anchor,
    });
    onClose();
  }, [onResize, width, height, dpi, scaleContent, anchor, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        handleApplyResize();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose, handleApplyResize]);

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

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="resize-canvas-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 select-none"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#202020] border border-[#2c2c2c] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.85)] w-full max-w-[600px] flex flex-col overflow-hidden text-xs text-[#e5e5e5]"
      >
        {/* Header */}
        <div className="h-10 px-4 bg-[#161616] border-b border-[#2c2c2c] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Maximize2 className="w-3.5 h-3.5 text-[var(--accent)]" />
            <h2 id="resize-canvas-modal-title" className="text-xs font-medium text-[#e5e5e5] tracking-wide">
              Resize Canvas
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Cancel (Esc)"
            className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3.5 max-h-[82vh] overflow-y-auto">
          {/* Current Canvas Status Bar */}
          <div className="bg-[#161616] border border-[#2c2c2c] rounded-md px-3.5 py-2 flex items-center justify-between">
            <span className="text-[#8a8a8a] text-[11px]">Current Dimensions</span>
            <div className="flex items-center gap-2 font-mono text-xs">
              <span className="text-[#e5e5e5] font-medium">
                {currentDimensions.width} × {currentDimensions.height} px
              </span>
              <span className="text-[#4a4a4a]">|</span>
              <span className="text-[var(--accent)]">{currentDimensions.dpi || 300} DPI</span>
            </div>
          </div>

          {/* New Dimensions & Keep Aspect Ratio */}
          <div className="bg-[#161616] border border-[#2c2c2c] rounded-md p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-[#8a8a8a] uppercase tracking-wider">
                New Dimensions
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setLockRatio(!lockRatio)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] transition-colors border cursor-pointer ${
                    lockRatio
                      ? 'bg-[var(--accent-subtle)] border-[var(--accent-border)] text-[var(--accent)] font-medium'
                      : 'bg-[#202020] border-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                  }`}
                  title={lockRatio ? 'Keep aspect ratio: editing width updates height' : 'Aspect ratio unlocked'}
                >
                  {lockRatio ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3 text-[#6e6e6e]" />}
                  <span>{lockRatio ? 'Keep Aspect Ratio' : 'Ratio Free'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleSwapDimensions}
                  className="p-1 rounded bg-[#202020] hover:bg-[#2c2c2c] border border-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] transition-colors cursor-pointer"
                  title="Swap Width and Height (Landscape ⇄ Portrait)"
                >
                  <ArrowLeftRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label htmlFor={widthInputId} className="text-[11px] text-[#8a8a8a]">
                    Width (px)
                  </label>
                  <span className="text-[10px] font-mono text-[#6e6e6e]">{percentW}%</span>
                </div>
                <input
                  id={widthInputId}
                  type="number"
                  min="64"
                  max="16384"
                  value={width}
                  onChange={(e) => handleWidthChange(Number(e.target.value))}
                  className="w-full bg-[#202020] border border-[#2c2c2c] rounded px-3 py-1.5 font-mono text-xs text-[#e5e5e5] focus:border-[var(--accent-border)]"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label htmlFor={heightInputId} className="text-[11px] text-[#8a8a8a]">
                    Height (px)
                  </label>
                  <span className="text-[10px] font-mono text-[#6e6e6e]">{percentH}%</span>
                </div>
                <input
                  id={heightInputId}
                  type="number"
                  min="64"
                  max="16384"
                  value={height}
                  onChange={(e) => handleHeightChange(Number(e.target.value))}
                  className="w-full bg-[#202020] border border-[#2c2c2c] rounded px-3 py-1.5 font-mono text-xs text-[#e5e5e5] focus:border-[var(--accent-border)]"
                />
              </div>
            </div>

            {/* Quick Ratio Presets */}
            <div className="flex items-center gap-2 pt-0.5">
              <span className="text-[11px] text-[#8a8a8a] whitespace-nowrap">Ratio Presets:</span>
              <div className="flex flex-wrap gap-1.5">
                {RATIO_PRESETS.map((r) => {
                  const isActive = Math.abs(width / height - r.x / r.y) < 0.01;
                  return (
                    <button
                      key={r.label}
                      type="button"
                      onClick={() => handleApplyRatioPreset(r.x, r.y)}
                      className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors border cursor-pointer ${
                        isActive
                          ? 'bg-[var(--accent)] border-transparent text-[var(--accent-contrast)] font-medium'
                          : 'bg-[#202020] border-[#2c2c2c] text-[#8a8a8a] hover:bg-[#2c2c2c] hover:text-[#e5e5e5]'
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
          <div className="bg-[#161616] border border-[#2c2c2c] rounded-md p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Printer className="w-3.5 h-3.5 text-[#8a8a8a]" />
                <span className="text-[10px] font-medium text-[#8a8a8a] uppercase tracking-wider">
                  Resolution (DPI / PPI)
                </span>
              </div>
              <span className="font-mono text-[11px] text-[var(--accent)]">
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
                    className={`flex flex-col items-center justify-center py-1.5 px-1 rounded border transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[var(--accent)] border-transparent text-[var(--accent-contrast)] font-medium'
                        : 'bg-[#202020] border-[#2c2c2c] text-[#b5b5b5] hover:bg-[#2c2c2c] hover:text-[#e5e5e5]'
                    }`}
                  >
                    <span className="font-mono text-xs font-semibold">{p.dpi}</span>
                    <span className="text-[9px] opacity-75">{p.desc}</span>
                  </button>
                );
              })}
            </div>

            <div className="pt-2 border-t border-[#262626] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label htmlFor={dpiInputId} className="text-[11px] text-[#8a8a8a]">
                  Manual DPI:
                </label>
                <input
                  id={dpiInputId}
                  type="number"
                  min="1"
                  max="4800"
                  value={dpi}
                  onChange={(e) => setDpi(Math.max(1, Math.min(4800, Number(e.target.value) || 1)))}
                  className="w-20 bg-[#202020] border border-[#2c2c2c] rounded px-2.5 py-1 text-center font-mono text-xs text-[#e5e5e5] focus:border-[var(--accent-border)]"
                />
              </div>
              <span className="text-[11px] text-[#8a8a8a] font-mono">Total Pixels: {megapixels} MP</span>
            </div>
          </div>

          {/* Mode & Anchor Grid */}
          <div className="bg-[#161616] border border-[#2c2c2c] rounded-md p-3.5 space-y-3">
            <span className="text-[10px] font-medium text-[#8a8a8a] uppercase tracking-wider block">
              Resize Behavior &amp; Anchor
            </span>

            {/* Mode Toggle */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setScaleContent(false)}
                className={`p-2.5 rounded-md border text-left transition-colors cursor-pointer ${
                  !scaleContent
                    ? 'bg-[var(--accent-subtle)] border-[var(--accent-border)] text-[#e5e5e5]'
                    : 'bg-[#202020] border-[#2c2c2c] text-[#8a8a8a] hover:bg-[#262626] hover:text-[#e5e5e5]'
                }`}
              >
                <div className="font-medium text-xs text-[#e5e5e5] mb-0.5">Canvas Bounds (Anchor)</div>
                <p className="text-[10px] text-[#8a8a8a] leading-snug">
                  Expands or crops canvas area around artwork without distorting pixels.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setScaleContent(true)}
                className={`p-2.5 rounded-md border text-left transition-colors cursor-pointer ${
                  scaleContent
                    ? 'bg-[var(--accent-subtle)] border-[var(--accent-border)] text-[#e5e5e5]'
                    : 'bg-[#202020] border-[#2c2c2c] text-[#8a8a8a] hover:bg-[#262626] hover:text-[#e5e5e5]'
                }`}
              >
                <div className="font-medium text-xs text-[#e5e5e5] mb-0.5">Scale Content (Resample)</div>
                <p className="text-[10px] text-[#8a8a8a] leading-snug">
                  Stretches and scales all layer artwork to match the new dimensions.
                </p>
              </button>
            </div>

            {/* 3x3 Anchor Grid when Canvas Bounds is active */}
            {!scaleContent && (
              <div className="pt-2.5 border-t border-[#262626] flex items-center justify-between">
                <div>
                  <span className="text-xs text-[#e5e5e5] font-medium block">Anchor Position</span>
                  <span className="text-[11px] text-[#8a8a8a]">Choose where existing artwork remains</span>
                </div>

                <div className="grid grid-cols-3 gap-1 bg-[#202020] p-1.5 rounded-md border border-[#2c2c2c]">
                  {ANCHOR_GRID.map((item) => {
                    const isSelected = anchor === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setAnchor(item.id)}
                        className={`w-7 h-7 rounded flex items-center justify-center transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                            : 'bg-[#161616] text-[#8a8a8a] hover:bg-[#2c2c2c] hover:text-[#e5e5e5]'
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
        <div className="px-4 py-2.5 bg-[#161616] border-t border-[#2c2c2c] flex items-center justify-between shrink-0">
          <span className="text-[11px] text-[#8a8a8a] hidden sm:block">
            Ratio: <span className="font-mono text-[#e5e5e5]">{simplifiedRatio}</span>
          </span>

          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded bg-[#2a2a2a] hover:bg-[#363636] text-xs font-medium text-[#e5e5e5] transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApplyResize}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 text-xs font-medium transition-opacity cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Resize Canvas</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
