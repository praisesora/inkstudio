import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import {
  renderSaturatedLines,
  renderStreamLines,
  SaturatedLinesOptions,
  StreamLinesOptions,
} from '../utils/mangaEffectsEngine';

interface MangaEffectsModalProps {
  isOpen: boolean;
  onClose: () => void;
  canvasWidth: number;
  canvasHeight: number;
  onApply: (type: 'saturated' | 'stream', options: SaturatedLinesOptions | StreamLinesOptions) => void;
}

export const MangaEffectsModal: React.FC<MangaEffectsModalProps> = ({
  isOpen,
  onClose,
  canvasWidth,
  canvasHeight,
  onApply,
}) => {
  const [activeTab, setActiveTab] = useState<'saturated' | 'stream'>('saturated');

  // Saturated Lines State
  const [satOptions, setSatOptions] = useState<SaturatedLinesOptions>({
    centerX: Math.round(canvasWidth * 0.5),
    centerY: Math.round(canvasHeight * 0.5),
    innerRadius: Math.round(Math.min(canvasWidth, canvasHeight) * 0.2),
    density: 120,
    spacingJitter: 0.5,
    lengthJitter: 0.35,
    lineWidth: 4,
    taper: 'in',
    color: '#000000',
  });

  // Stream Lines State
  const [streamOptions, setStreamOptions] = useState<StreamLinesOptions>({
    angle: 0,
    density: 80,
    lineLength: Math.round(Math.min(canvasWidth, canvasHeight) * 0.5),
    lengthNoise: 0.4,
    thickness: 3,
    thicknessNoise: 0.5,
    gapNoise: 0.3,
    color: '#000000',
  });

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // Re-draw preview canvas whenever parameters change
  const updatePreview = useCallback(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Scaling ratio to fit canvas inside preview box
    const scale = canvas.width / canvasWidth;

    ctx.save();
    ctx.scale(scale, scale);

    if (activeTab === 'saturated') {
      renderSaturatedLines(ctx, canvasWidth, canvasHeight, satOptions);

      // Draw faint indicator circle for center cutout
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.5 / scale;
      ctx.setLineDash([4 / scale, 4 / scale]);
      ctx.beginPath();
      ctx.arc(satOptions.centerX, satOptions.centerY, satOptions.innerRadius, 0, Math.PI * 2);
      ctx.stroke();

      // Crosshair at center
      ctx.beginPath();
      ctx.arc(satOptions.centerX, satOptions.centerY, 3 / scale, 0, Math.PI * 2);
      ctx.fillStyle = '#38bdf8';
      ctx.fill();
    } else {
      renderStreamLines(ctx, canvasWidth, canvasHeight, streamOptions);
    }

    ctx.restore();
  }, [activeTab, canvasWidth, canvasHeight, satOptions, streamOptions]);

  useEffect(() => {
    if (isOpen) {
      updatePreview();
    }
  }, [isOpen, updatePreview]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Handle clicking on preview canvas to set focal point for saturated lines
  const handlePreviewClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTab !== 'saturated') return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const scale = canvasWidth / canvas.width;

    setSatOptions((prev) => ({
      ...prev,
      centerX: Math.round(clickX * scale),
      centerY: Math.round(clickY * scale),
    }));
  };

  const handleApplyClick = () => {
    if (activeTab === 'saturated') {
      onApply('saturated', satOptions);
    } else {
      onApply('stream', streamOptions);
    }
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="manga-effects-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 select-none"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[680px] max-w-[95vw] bg-[#202020] border border-[#2c2c2c] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.85)] overflow-hidden flex flex-col text-[#e5e5e5] font-sans"
      >
        {/* Header */}
        <div className="h-9 px-3.5 bg-[#161616] border-b border-[#2c2c2c] flex items-center justify-between">
          <h2 id="manga-effects-modal-title" className="text-xs font-medium text-[#e5e5e5]">
            Manga Effect Lines
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Cancel (Esc)"
            className="w-6 h-6 flex items-center justify-center rounded text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-[#2c2c2c] bg-[#161616] px-4">
          <button
            onClick={() => setActiveTab('saturated')}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'saturated'
                ? 'border-[var(--accent)] text-[#e5e5e5]'
                : 'border-transparent text-[#8a8a8a] hover:text-[#e5e5e5]'
            }`}
          >
            Saturated Lines (Focus / Burst)
          </button>
          <button
            onClick={() => setActiveTab('stream')}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'stream'
                ? 'border-[var(--accent)] text-[#e5e5e5]'
                : 'border-transparent text-[#8a8a8a] hover:text-[#e5e5e5]'
            }`}
          >
            Stream Lines (Parallel Speed)
          </button>
        </div>

        {/* Body: Left Preview, Right Controls */}
        <div className="p-4 flex space-x-4 max-h-[480px]">
          {/* Interactive Preview Canvas */}
          <div className="flex flex-col items-center">
            <div className="relative border border-white/[0.08] rounded overflow-hidden bg-white">
              <canvas
                ref={previewCanvasRef}
                width={300}
                height={Math.round((300 * canvasHeight) / canvasWidth)}
                onClick={handlePreviewClick}
                className="cursor-crosshair block"
                title={activeTab === 'saturated' ? 'Click on preview to move focus center' : undefined}
              />
            </div>
            {activeTab === 'saturated' && (
              <span className="text-[10px] text-[#8a8a8a] mt-1.5">
                Click preview to reposition focus point
              </span>
            )}
          </div>

          {/* Right Parameters Panel */}
          <div className="flex-1 space-y-3 overflow-y-auto pr-1 text-xs">
            {activeTab === 'saturated' ? (
              <>
                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#8a8a8a]">Center Cutout Radius</span>
                    <span className="font-mono text-[#e5e5e5]">{satOptions.innerRadius}px</span>
                  </div>
                  <input
                    type="range"
                    min={10}
                    max={Math.round(Math.min(canvasWidth, canvasHeight) * 0.45)}
                    value={satOptions.innerRadius}
                    onChange={(e) =>
                      setSatOptions((p) => ({ ...p, innerRadius: Number(e.target.value) }))
                    }
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#8a8a8a]">Line Density</span>
                    <span className="font-mono text-[#e5e5e5]">{satOptions.density} lines</span>
                  </div>
                  <input
                    type="range"
                    min={20}
                    max={400}
                    value={satOptions.density}
                    onChange={(e) =>
                      setSatOptions((p) => ({ ...p, density: Number(e.target.value) }))
                    }
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#8a8a8a]">Stroke Width</span>
                    <span className="font-mono text-[#e5e5e5]">{satOptions.lineWidth}px</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={12}
                    value={satOptions.lineWidth}
                    onChange={(e) =>
                      setSatOptions((p) => ({ ...p, lineWidth: Number(e.target.value) }))
                    }
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#8a8a8a]">Spacing & Depth Jitter</span>
                    <span className="font-mono text-[#e5e5e5]">{Math.round(satOptions.spacingJitter * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(satOptions.spacingJitter * 100)}
                    onChange={(e) =>
                      setSatOptions((p) => ({
                        ...p,
                        spacingJitter: Number(e.target.value) / 100,
                        lengthJitter: Number(e.target.value) / 100,
                      }))
                    }
                    className="w-full"
                  />
                </div>

                <div className="flex items-center space-x-2 pt-1">
                  <span className="text-[11px] text-[#8a8a8a]">Taper Direction</span>
                  <button
                    onClick={() => setSatOptions((p) => ({ ...p, taper: 'in' }))}
                    className={`px-2 py-0.5 rounded text-[11px] border transition-colors cursor-pointer ${
                      satOptions.taper === 'in'
                        ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border-[var(--accent-border)]'
                        : 'bg-[#161616] border-white/[0.06] text-[#8a8a8a] hover:text-[#e5e5e5]'
                    }`}
                  >
                    Point to Center
                  </button>
                  <button
                    onClick={() => setSatOptions((p) => ({ ...p, taper: 'none' }))}
                    className={`px-2 py-0.5 rounded text-[11px] border transition-colors cursor-pointer ${
                      satOptions.taper === 'none'
                        ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border-[var(--accent-border)]'
                        : 'bg-[#161616] border-white/[0.06] text-[#8a8a8a] hover:text-[#e5e5e5]'
                    }`}
                  >
                    Uniform
                  </button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#8a8a8a]">Angle</span>
                    <span className="font-mono text-[#e5e5e5]">{streamOptions.angle}°</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <input
                      type="range"
                      min={0}
                      max={360}
                      value={streamOptions.angle}
                      onChange={(e) =>
                        setStreamOptions((p) => ({ ...p, angle: Number(e.target.value) }))
                      }
                      className="flex-1"
                    />
                    <div className="flex space-x-1">
                      {[0, 90, 45].map((deg) => (
                        <button
                          key={deg}
                          onClick={() => setStreamOptions((p) => ({ ...p, angle: deg }))}
                          className="px-1.5 py-0.5 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-white/[0.06] text-[10px] text-[#e5e5e5] cursor-pointer"
                        >
                          {deg}°
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#8a8a8a]">Density</span>
                    <span className="font-mono text-[#e5e5e5]">{streamOptions.density} lines</span>
                  </div>
                  <input
                    type="range"
                    min={15}
                    max={300}
                    value={streamOptions.density}
                    onChange={(e) =>
                      setStreamOptions((p) => ({ ...p, density: Number(e.target.value) }))
                    }
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#8a8a8a]">Streak Length</span>
                    <span className="font-mono text-[#e5e5e5]">{streamOptions.lineLength}px</span>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={1200}
                    value={streamOptions.lineLength}
                    onChange={(e) =>
                      setStreamOptions((p) => ({ ...p, lineLength: Number(e.target.value) }))
                    }
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#8a8a8a]">Thickness</span>
                    <span className="font-mono text-[#e5e5e5]">{streamOptions.thickness}px</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={streamOptions.thickness}
                    onChange={(e) =>
                      setStreamOptions((p) => ({ ...p, thickness: Number(e.target.value) }))
                    }
                    className="w-full"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#8a8a8a]">Thickness & Length Noise</span>
                    <span className="font-mono text-[#e5e5e5]">
                      {Math.round(streamOptions.thicknessNoise * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(streamOptions.thicknessNoise * 100)}
                    onChange={(e) =>
                      setStreamOptions((p) => ({
                        ...p,
                        thicknessNoise: Number(e.target.value) / 100,
                        lengthNoise: Number(e.target.value) / 100,
                      }))
                    }
                    className="w-full"
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-[#161616] border-t border-[#2c2c2c] flex items-center justify-between">
          <button
            onClick={() => {
              if (activeTab === 'saturated') {
                setSatOptions({
                  centerX: Math.round(canvasWidth * 0.5),
                  centerY: Math.round(canvasHeight * 0.5),
                  innerRadius: Math.round(Math.min(canvasWidth, canvasHeight) * 0.2),
                  density: 120,
                  spacingJitter: 0.5,
                  lengthJitter: 0.35,
                  lineWidth: 4,
                  taper: 'in',
                  color: '#000000',
                });
              } else {
                setStreamOptions({
                  angle: 0,
                  density: 80,
                  lineLength: Math.round(Math.min(canvasWidth, canvasHeight) * 0.5),
                  lengthNoise: 0.4,
                  thickness: 3,
                  thicknessNoise: 0.5,
                  gapNoise: 0.3,
                  color: '#000000',
                });
              }
            }}
            className="text-xs text-[#8a8a8a] hover:text-[#e5e5e5] transition-colors cursor-pointer"
          >
            Reset Defaults
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 bg-[#2a2a2a] hover:bg-[#363636] text-[#e5e5e5] font-medium rounded text-xs transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApplyClick}
              className="px-4 py-1.5 bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 rounded text-xs font-medium transition-opacity cursor-pointer"
            >
              Apply Effect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
