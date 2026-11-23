import React, { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
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
  dpi = 600,
}) => {
  const [frequency, setFrequency] = useState(initialFrequency);
  const [density, setDensity] = useState(initialDensity);
  const [angle, setAngle] = useState(initialAngle);
  const [dotShape, setDotShape] = useState<HalftoneDotShape>(initialDotShape);

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // Synchronize state when modal opens
  useEffect(() => {
    if (isOpen) {
      setFrequency(initialFrequency);
      setDensity(initialDensity);
      setAngle(initialAngle);
      setDotShape(initialDotShape);
    }
  }, [isOpen, initialFrequency, initialDensity, initialAngle, initialDotShape]);

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

    sCtx.fillStyle = '#000000';
    sCtx.fillRect(0, 0, w, h);

    applyScreentoneCPU(src, canvas, {
      frequency,
      angle,
      dotShape,
      dpi,
      densityType: 'specified',
      specifiedDensity: density / 100,
      antiAliasing: false,
    });
  }, [isOpen, frequency, density, angle, dotShape, dpi]);

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
          densityType: 'specified',
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, onConfirm, frequency, density, angle, dotShape]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-xs select-none"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="bg-[#202020] border border-white/[0.1] rounded-lg shadow-2xl w-96 flex flex-col overflow-hidden text-[#e5e5e5]">
        {/* Header */}
        <div className="px-4 py-2.5 bg-[#1a1a1a] border-b border-white/[0.06] flex items-center justify-between">
          <h2 className="text-xs font-medium text-[#e5e5e5]">Simple Tone Settings</h2>
          <button
            onClick={onClose}
            className="text-[#8a8a8a] hover:text-[#e5e5e5] p-1 rounded hover:bg-[#2c2c2c] transition-colors cursor-pointer"
            title="Cancel (Esc)"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 text-xs">
          {/* Top Row: Settings + Swatch Preview */}
          <div className="flex gap-4">
            {/* Swatch Preview */}
            <div className="flex flex-col items-center">
              <span className="text-[10px] text-[#8a8a8a] mb-1">Preview</span>
              <div className="w-[120px] h-[120px] rounded border border-white/[0.08] bg-white overflow-hidden flex items-center justify-center">
                <canvas ref={previewCanvasRef} className="w-full h-full" style={{ imageRendering: 'pixelated' }} />
              </div>
              <span className="text-[9px] text-[#8a8a8a] font-mono mt-1">
                {frequency}L · {density}%
              </span>
            </div>

            {/* Quick Parameters */}
            <div className="flex-1 space-y-3">
              {/* Dot Shape */}
              <div>
                <label className="text-[10px] text-[#8a8a8a] block mb-1">Dot Shape</label>
                <select
                  value={dotShape}
                  onChange={(e) => setDotShape(e.target.value as HalftoneDotShape)}
                  className="w-full bg-[#161616] border border-white/[0.08] text-[#e5e5e5] text-xs rounded px-2 py-1 cursor-pointer"
                >
                  <option value="circle">Circle (Standard)</option>
                  <option value="euclidean">Euclidean (Halftone)</option>
                  <option value="line">Line (Hatching)</option>
                  <option value="diamond">Diamond</option>
                </select>
              </div>

              {/* Angle */}
              <div>
                <div className="flex items-center justify-between text-[10px] mb-1">
                  <span className="text-[#8a8a8a]">Angle</span>
                  <span className="font-mono text-[#e5e5e5]">{angle}°</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="90"
                  step="1"
                  value={angle}
                  onChange={(e) => setAngle(parseInt(e.target.value, 10))}
                  className="w-full"
                />
                <div className="flex items-center justify-between text-[9px] text-[#8a8a8a] font-mono mt-0.5">
                  {ANGLE_PRESETS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setAngle(p)}
                      className={`hover:text-[#e5e5e5] transition-colors cursor-pointer ${
                        angle === p ? 'text-[var(--accent)] font-semibold' : ''
                      }`}
                    >
                      {p}°
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Density Slider & Presets */}
          <div className="p-2.5 bg-[#161616] rounded border border-white/[0.06]">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-[#cccccc]">Density</span>
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
                  className="w-12 bg-[#202020] border border-white/[0.08] text-[#e5e5e5] font-mono text-xs rounded px-1.5 py-0.5 text-right"
                />
                <span className="text-xs text-[#8a8a8a] font-mono">%</span>
              </div>
            </div>
            <input
              type="range"
              min="1"
              max="100"
              step="1"
              value={density}
              onChange={(e) => setDensity(parseInt(e.target.value, 10))}
              className="w-full mb-1.5"
            />
            <div className="flex items-center justify-between text-[9px] text-[#8a8a8a] font-mono">
              {DENSITY_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setDensity(p)}
                  className={`hover:text-[#e5e5e5] px-1 py-0.5 rounded transition-colors cursor-pointer ${
                    density === p ? 'bg-[var(--accent-subtle)] text-[var(--accent)] font-semibold' : ''
                  }`}
                >
                  {p}%
                </button>
              ))}
            </div>
          </div>

          {/* Frequency (Lines / LPI) */}
          <div className="p-2.5 bg-[#161616] rounded border border-white/[0.06]">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-[#cccccc]">Screen Frequency (LPI)</span>
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
                  className="w-12 bg-[#202020] border border-white/[0.08] text-[#e5e5e5] font-mono text-xs rounded px-1.5 py-0.5 text-right"
                />
                <span className="text-xs text-[#8a8a8a] font-mono">L</span>
              </div>
            </div>
            <input
              type="range"
              min="20"
              max="85"
              step="1"
              value={frequency}
              onChange={(e) => setFrequency(parseFloat(e.target.value))}
              className="w-full mb-1.5"
            />
            <div className="flex items-center justify-between text-[9px] text-[#8a8a8a] font-mono">
              {FREQUENCY_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setFrequency(p)}
                  className={`hover:text-[#e5e5e5] px-1 py-0.5 rounded transition-colors cursor-pointer ${
                    frequency === p ? 'bg-[var(--accent-subtle)] text-[var(--accent)] font-semibold' : ''
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-[#1a1a1a] border-t border-white/[0.06] flex items-center justify-end space-x-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[#e5e5e5] transition-colors cursor-pointer text-xs"
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
                densityType: 'specified',
              })
            }
            className="px-4 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 font-medium transition-opacity cursor-pointer text-xs"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
};
