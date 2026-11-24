import React, { useEffect, useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { FilterType } from '../types/editor';
import { AnyFilterParams } from '../hooks/useTonalAndFilterActions';

export interface FilterModalProps {
  isOpen: boolean;
  type: FilterType;
  onClose: () => void;
  onApply: (type: FilterType, params: AnyFilterParams) => void;
}

const FILTER_TITLES: Record<FilterType, string> = {
  'gaussian-blur': 'Gaussian Blur',
  'motion-blur': 'Motion Blur',
  'unsharp-mask': 'Unsharp Mask',
  'film-grain': 'Film Grain',
};

export const FilterModal: React.FC<FilterModalProps> = ({
  isOpen,
  type,
  onClose,
  onApply,
}) => {
  const [gaussianRadius, setGaussianRadius] = useState(5);
  const [motionDistance, setMotionDistance] = useState(15);
  const [motionAngle, setMotionAngle] = useState(0);
  const [unsharpRadius, setUnsharpRadius] = useState(2);
  const [unsharpAmount, setUnsharpAmount] = useState(1.5);
  const [unsharpThreshold, setUnsharpThreshold] = useState(0);
  const [grainIntensity, setGrainIntensity] = useState(25);
  const [grainSize, setGrainSize] = useState(1);
  const [grainMono, setGrainMono] = useState(true);

  const resetCurrent = () => {
    if (type === 'gaussian-blur') {
      setGaussianRadius(5);
    } else if (type === 'motion-blur') {
      setMotionDistance(15);
      setMotionAngle(0);
    } else if (type === 'unsharp-mask') {
      setUnsharpRadius(2);
      setUnsharpAmount(1.5);
      setUnsharpThreshold(0);
    } else if (type === 'film-grain') {
      setGrainIntensity(25);
      setGrainSize(1);
      setGrainMono(true);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    resetCurrent();
  }, [isOpen, type]);

  const buildParams = (): AnyFilterParams => {
    switch (type) {
      case 'gaussian-blur':
        return { radius: Math.max(1, Math.min(100, gaussianRadius || 1)) };
      case 'motion-blur':
        return {
          distance: Math.max(1, Math.min(100, motionDistance || 1)),
          angle: Math.max(0, Math.min(360, motionAngle || 0)),
        };
      case 'unsharp-mask':
        return {
          radius: Math.max(0.5, Math.min(20, unsharpRadius || 0.5)),
          amount: Math.max(0.1, Math.min(5, unsharpAmount || 0.1)),
          threshold: Math.max(0, Math.min(255, unsharpThreshold || 0)),
        };
      case 'film-grain':
        return {
          intensity: Math.max(1, Math.min(100, grainIntensity || 1)),
          size: Math.max(1, Math.min(4, grainSize || 1)),
          monochromatic: grainMono,
        };
    }
  };

  const handleConfirm = () => {
    onApply(type, buildParams());
    onClose();
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        e.stopPropagation();
        onApply(type, buildParams());
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [
    isOpen,
    type,
    gaussianRadius,
    motionDistance,
    motionAngle,
    unsharpRadius,
    unsharpAmount,
    unsharpThreshold,
    grainIntensity,
    grainSize,
    grainMono,
    onApply,
    onClose,
  ]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="filter-modal-title"
      data-testid="filter-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 select-none"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[360px] max-w-[95vw] bg-[#202020] border border-[#2c2c2c] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.85)] flex flex-col overflow-hidden text-xs text-[#e5e5e5]"
      >
        {/* Title Bar */}
        <div className="h-9 px-3.5 bg-[#161616] border-b border-[#2c2c2c] flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <SlidersHorizontal className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
            <span id="filter-modal-title" className="text-xs font-medium text-[#e5e5e5] truncate">
              {FILTER_TITLES[type]}
            </span>
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
        <div className="p-4 space-y-4">
          {type === 'gaussian-blur' && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="filter-gaussian-radius" className="text-[11px] text-[#8a8a8a]">
                  Radius (px)
                </label>
                <input
                  id="filter-gaussian-radius"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={gaussianRadius}
                  onChange={(e) =>
                    setGaussianRadius(Math.max(1, Math.min(100, Number(e.target.value) || 1)))
                  }
                  className="w-16 bg-[#161616] border border-[#2c2c2c] rounded px-2 py-0.5 text-right font-mono text-xs text-[#e5e5e5]"
                />
              </div>
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                value={gaussianRadius}
                onChange={(e) => setGaussianRadius(Number(e.target.value))}
                className="w-full"
              />
            </div>
          )}

          {type === 'motion-blur' && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="filter-motion-distance" className="text-[11px] text-[#8a8a8a]">
                    Distance (px)
                  </label>
                  <input
                    id="filter-motion-distance"
                    type="number"
                    min={1}
                    max={100}
                    value={motionDistance}
                    onChange={(e) =>
                      setMotionDistance(Math.max(1, Math.min(100, Number(e.target.value) || 1)))
                    }
                    className="w-16 bg-[#161616] border border-[#2c2c2c] rounded px-2 py-0.5 text-right font-mono text-xs text-[#e5e5e5]"
                  />
                </div>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={motionDistance}
                  onChange={(e) => setMotionDistance(Number(e.target.value))}
                  className="w-full"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="filter-motion-angle" className="text-[11px] text-[#8a8a8a]">
                    Angle (°)
                  </label>
                  <input
                    id="filter-motion-angle"
                    type="number"
                    min={0}
                    max={360}
                    value={motionAngle}
                    onChange={(e) =>
                      setMotionAngle(Math.max(0, Math.min(360, Number(e.target.value) || 0)))
                    }
                    className="w-16 bg-[#161616] border border-[#2c2c2c] rounded px-2 py-0.5 text-right font-mono text-xs text-[#e5e5e5]"
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={360}
                  value={motionAngle}
                  onChange={(e) => setMotionAngle(Number(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          )}

          {type === 'unsharp-mask' && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="filter-unsharp-radius" className="text-[11px] text-[#8a8a8a]">
                    Radius (px)
                  </label>
                  <input
                    id="filter-unsharp-radius"
                    type="number"
                    min={0.5}
                    max={20}
                    step={0.5}
                    value={unsharpRadius}
                    onChange={(e) =>
                      setUnsharpRadius(Math.max(0.5, Math.min(20, Number(e.target.value) || 0.5)))
                    }
                    className="w-16 bg-[#161616] border border-[#2c2c2c] rounded px-2 py-0.5 text-right font-mono text-xs text-[#e5e5e5]"
                  />
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={20}
                  step={0.5}
                  value={unsharpRadius}
                  onChange={(e) => setUnsharpRadius(Number(e.target.value))}
                  className="w-full"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="filter-unsharp-amount" className="text-[11px] text-[#8a8a8a]">
                    Amount
                  </label>
                  <input
                    id="filter-unsharp-amount"
                    type="number"
                    min={0.1}
                    max={5}
                    step={0.1}
                    value={unsharpAmount}
                    onChange={(e) =>
                      setUnsharpAmount(Math.max(0.1, Math.min(5, Number(e.target.value) || 0.1)))
                    }
                    className="w-16 bg-[#161616] border border-[#2c2c2c] rounded px-2 py-0.5 text-right font-mono text-xs text-[#e5e5e5]"
                  />
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={5}
                  step={0.1}
                  value={unsharpAmount}
                  onChange={(e) => setUnsharpAmount(Number(e.target.value))}
                  className="w-full"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="filter-unsharp-threshold" className="text-[11px] text-[#8a8a8a]">
                    Threshold
                  </label>
                  <input
                    id="filter-unsharp-threshold"
                    type="number"
                    min={0}
                    max={255}
                    step={1}
                    value={unsharpThreshold}
                    onChange={(e) =>
                      setUnsharpThreshold(Math.max(0, Math.min(255, Number(e.target.value) || 0)))
                    }
                    className="w-16 bg-[#161616] border border-[#2c2c2c] rounded px-2 py-0.5 text-right font-mono text-xs text-[#e5e5e5]"
                  />
                </div>
                <input
                  type="range"
                  min={0}
                  max={255}
                  step={1}
                  value={unsharpThreshold}
                  onChange={(e) => setUnsharpThreshold(Number(e.target.value))}
                  className="w-full"
                />
              </div>
            </div>
          )}

          {type === 'film-grain' && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="filter-grain-intensity" className="text-[11px] text-[#8a8a8a]">
                    Intensity (%)
                  </label>
                  <input
                    id="filter-grain-intensity"
                    type="number"
                    min={1}
                    max={100}
                    value={grainIntensity}
                    onChange={(e) =>
                      setGrainIntensity(Math.max(1, Math.min(100, Number(e.target.value) || 1)))
                    }
                    className="w-16 bg-[#161616] border border-[#2c2c2c] rounded px-2 py-0.5 text-right font-mono text-xs text-[#e5e5e5]"
                  />
                </div>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={grainIntensity}
                  onChange={(e) => setGrainIntensity(Number(e.target.value))}
                  className="w-full"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="filter-grain-size" className="text-[11px] text-[#8a8a8a]">
                    Grain Size (px)
                  </label>
                  <input
                    id="filter-grain-size"
                    type="number"
                    min={1}
                    max={4}
                    step={0.5}
                    value={grainSize}
                    onChange={(e) =>
                      setGrainSize(Math.max(1, Math.min(4, Number(e.target.value) || 1)))
                    }
                    className="w-16 bg-[#161616] border border-[#2c2c2c] rounded px-2 py-0.5 text-right font-mono text-xs text-[#e5e5e5]"
                  />
                </div>
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={0.5}
                  value={grainSize}
                  onChange={(e) => setGrainSize(Number(e.target.value))}
                  className="w-full"
                />
              </div>

              <label className="flex items-center justify-between bg-[#161616] border border-[#2c2c2c] rounded px-3 py-2 cursor-pointer">
                <span className="text-[11px] text-[#e5e5e5]">Monochromatic Grain</span>
                <input
                  type="checkbox"
                  checked={grainMono}
                  onChange={(e) => setGrainMono(e.target.checked)}
                  className="cursor-pointer"
                />
              </label>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-[#161616] border-t border-[#2c2c2c] flex items-center justify-between">
          <button
            type="button"
            onClick={resetCurrent}
            className="text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] transition-colors cursor-pointer"
          >
            Reset
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded bg-[#2a2a2a] hover:bg-[#363636] text-xs font-medium text-[#e5e5e5] transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              autoFocus
              onClick={handleConfirm}
              className="px-4 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 text-xs font-medium transition-opacity cursor-pointer"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
