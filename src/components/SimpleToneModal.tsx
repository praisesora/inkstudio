import React, { useState, useEffect, useRef } from 'react';
import { X, Check, Sparkles } from 'lucide-react';
import { HalftoneDotShape, applyScreentoneCPU } from '../utils/screentoneEngine';

export interface SimpleToneSettings {
  density: number; // 1 to 100
  densityType: 'specified' | 'image';
  frequency: number; // 20 to 85
  angle: number; // 0 to 90
  dotShape: HalftoneDotShape;
}

interface SimpleToneModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (settings: SimpleToneSettings) => void;
  initialFrequency?: number;
  initialDensity?: number;
  initialAngle?: number;
  initialDotShape?: HalftoneDotShape;
  initialDensityType?: 'specified' | 'image';
  dpi?: number;
}

const FREQUENCY_PRESETS = [28, 42.5, 50, 60, 70, 85];
const DENSITY_PRESETS = [5, 10, 20, 30, 40, 50, 60, 70, 80];
const ANGLE_PRESETS = [0, 30, 45, 60, 90];

export const SimpleToneModal: React.FC<SimpleToneModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  initialFrequency = 60,
  initialDensity = 40,
  initialAngle = 45,
  initialDotShape = 'circle',
  initialDensityType = 'specified',
  dpi = 600,
}) => {
  const [frequency, setFrequency] = useState(initialFrequency);
  const [density, setDensity] = useState(initialDensity);
  const [angle, setAngle] = useState(initialAngle);
  const [dotShape, setDotShape] = useState<HalftoneDotShape>(initialDotShape);
  const [densityType, setDensityType] = useState<'specified' | 'image'>(initialDensityType);

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // Synchronize state when modal opens
  useEffect(() => {
    if (isOpen) {
      setFrequency(initialFrequency);
      setDensity(initialDensity);
      setAngle(initialAngle);
      setDotShape(initialDotShape);
      setDensityType(initialDensityType);
    }
  }, [isOpen, initialFrequency, initialDensity, initialAngle, initialDotShape, initialDensityType]);

  // Live Swatch Preview renderer
  useEffect(() => {
    if (!isOpen) return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    const w = 120;
    const h = 120;
    canvas.width = w;
    canvas.height = h;

    // Create an offscreen source canvas filled with solid black (mask)
    const src = document.createElement('canvas');
    src.width = w;
    src.height = h;
    const sCtx = src.getContext('2d');
    if (!sCtx) return;

    if (densityType === 'specified') {
      sCtx.fillStyle = '#000000';
      sCtx.fillRect(0, 0, w, h);
    } else {
      const g = Math.round(255 * (1 - density / 100));
      sCtx.fillStyle = `rgb(${g},${g},${g})`;
      sCtx.fillRect(0, 0, w, h);
    }

    applyScreentoneCPU(src, canvas, {
      frequency,
      angle,
      dotShape,
      dpi,
      densityType,
      specifiedDensity: density / 100,
      antiAliasing: true,
    });
  }, [isOpen, frequency, density, angle, dotShape, densityType, dpi]);

  // Keyboard navigation (Enter = Confirm, Escape = Close)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm({
          frequency,
          density,
          angle,
          dotShape,
          densityType,
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, onConfirm, frequency, density, angle, dotShape, densityType]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-xs select-none"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="bg-[#1e1f22] border border-[#383a40] rounded-lg shadow-2xl w-96 flex flex-col overflow-hidden text-[#cccccc] animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-4 py-3 bg-[#2b2d31] border-b border-[#383a40] flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <h2 className="text-xs font-semibold text-white tracking-wide uppercase">
              Simple Tone Settings
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-[#999999] hover:text-white p-1 rounded hover:bg-[#35373c] transition-colors"
            title="Cancel (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 text-xs">
          {/* Top Row: Settings + Swatch Preview */}
          <div className="flex gap-4">
            {/* Swatch Preview */}
            <div className="flex flex-col items-center">
              <span className="text-[10px] text-[#999999] mb-1 font-medium">Preview</span>
              <div className="w-[120px] h-[120px] rounded border border-[#383a40] bg-white overflow-hidden shadow-inner flex items-center justify-center">
                <canvas ref={previewCanvasRef} className="w-full h-full" />
              </div>
              <span className="text-[9px] text-[#777777] font-mono mt-1">
                {frequency}L • {densityType === 'specified' ? `${density}%` : 'Lum'}
              </span>
            </div>

            {/* Quick Parameters */}
            <div className="flex-1 space-y-3">
              {/* Dot Shape */}
              <div>
                <label className="text-[10px] text-[#999999] font-medium block mb-1">
                  Dot Shape:
                </label>
                <select
                  value={dotShape}
                  onChange={(e) => setDotShape(e.target.value as HalftoneDotShape)}
                  className="w-full bg-[#252526] border border-[#3a3a3a] text-[#cccccc] text-xs rounded px-2 py-1 outline-none cursor-pointer hover:border-[#555555] focus:border-amber-400"
                >
                  <option value="circle">Circle (Standard CSP)</option>
                  <option value="euclidean">Euclidean (Classic Halftone)</option>
                  <option value="line">Line (Hatching)</option>
                </select>
              </div>

              {/* Density Mode */}
              <div>
                <label className="text-[10px] text-[#999999] font-medium block mb-1">
                  Density Mode:
                </label>
                <select
                  value={densityType}
                  onChange={(e) => setDensityType(e.target.value as 'specified' | 'image')}
                  className="w-full bg-[#252526] border border-[#3a3a3a] text-[#cccccc] text-xs rounded px-2 py-1 outline-none cursor-pointer hover:border-[#555555] focus:border-amber-400"
                >
                  <option value="specified">Use specified density</option>
                  <option value="image">Use image brightness</option>
                </select>
              </div>

              {/* Angle */}
              <div>
                <div className="flex items-center justify-between text-[10px] mb-1">
                  <span className="text-[#999999] font-medium">Angle:</span>
                  <span className="font-mono text-amber-300 font-bold">{angle}°</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="90"
                  step="1"
                  value={angle}
                  onChange={(e) => setAngle(parseInt(e.target.value, 10))}
                  className="w-full cursor-pointer h-1.5 accent-amber-400"
                />
                <div className="flex items-center justify-between text-[8px] text-[#666666] font-mono mt-0.5">
                  {ANGLE_PRESETS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setAngle(p)}
                      className={`hover:text-amber-300 transition-colors ${
                        angle === p ? 'text-amber-400 font-bold' : ''
                      }`}
                    >
                      {p}°
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Density Slider & Presets (when specified) */}
          {densityType === 'specified' && (
            <div className="p-2.5 bg-[#252526] rounded border border-[#383a40]">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-[#cccccc] font-medium">Density:</span>
                <div className="flex items-center space-x-1">
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={density}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!isNaN(v)) setDensity(Math.max(1, Math.min(100, v)));
                    }}
                    className="w-12 bg-[#1e1f22] border border-[#383a40] text-amber-300 font-mono text-xs rounded px-1.5 py-0.5 text-right outline-none focus:border-amber-400"
                  />
                  <span className="text-xs text-[#888888] font-mono">%</span>
                </div>
              </div>
              <input
                type="range"
                min="1"
                max="100"
                step="1"
                value={density}
                onChange={(e) => setDensity(parseInt(e.target.value, 10))}
                className="w-full cursor-pointer h-1.5 accent-amber-400 mb-1.5"
              />
              <div className="flex items-center justify-between text-[9px] text-[#888888] font-mono">
                {DENSITY_PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setDensity(p)}
                    className={`hover:text-amber-300 px-1 py-0.5 rounded transition-colors ${
                      density === p ? 'bg-amber-500/20 text-amber-400 font-bold' : ''
                    }`}
                  >
                    {p}%
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Frequency (Lines / LPI) */}
          <div className="p-2.5 bg-[#252526] rounded border border-[#383a40]">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-[#cccccc] font-medium">Number of screen lines (LPI):</span>
              <div className="flex items-center space-x-1">
                <input
                  type="number"
                  min="20"
                  max="85"
                  step="0.5"
                  value={frequency}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) setFrequency(Math.max(20, Math.min(85, v)));
                  }}
                  className="w-12 bg-[#1e1f22] border border-[#383a40] text-amber-300 font-mono text-xs rounded px-1.5 py-0.5 text-right outline-none focus:border-amber-400"
                />
                <span className="text-xs text-[#888888] font-mono">L</span>
              </div>
            </div>
            <input
              type="range"
              min="20"
              max="85"
              step="1"
              value={frequency}
              onChange={(e) => setFrequency(parseFloat(e.target.value))}
              className="w-full cursor-pointer h-1.5 accent-amber-400 mb-1.5"
            />
            <div className="flex items-center justify-between text-[9px] text-[#888888] font-mono">
              {FREQUENCY_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setFrequency(p)}
                  className={`hover:text-amber-300 px-1 py-0.5 rounded transition-colors ${
                    frequency === p ? 'bg-amber-500/20 text-amber-400 font-bold' : ''
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 bg-[#2b2d31] border-t border-[#383a40] flex items-center justify-end space-x-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded bg-[#35373c] hover:bg-[#3f4147] text-[#cccccc] hover:text-white transition-colors cursor-pointer text-xs font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              onConfirm({
                frequency,
                density,
                angle,
                dotShape,
                densityType,
              })
            }
            className="px-4 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-black font-semibold transition-colors cursor-pointer text-xs flex items-center space-x-1 shadow-md"
          >
            <Check className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>OK</span>
          </button>
        </div>
      </div>
    </div>
  );
};
