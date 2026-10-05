import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Sparkles, Check, RefreshCw } from 'lucide-react';
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs select-none">
      <div className="w-[680px] bg-[#222327] border border-[#3b3d45] rounded-lg shadow-2xl overflow-hidden flex flex-col text-[#cccccc] font-sans">
        {/* Header */}
        <div className="px-4 py-3 bg-[#1a1b1e] border-b border-[#2e3036] flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-white">Manga Effect Lines Generator</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-[#888888] hover:text-white hover:bg-[#2b2d31] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-[#2e3036] bg-[#1d1e21] px-4 pt-2">
          <button
            onClick={() => setActiveTab('saturated')}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'saturated'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-[#888888] hover:text-[#cccccc]'
            }`}
          >
            Saturated Lines (Focus / Burst)
          </button>
          <button
            onClick={() => setActiveTab('stream')}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === 'stream'
                ? 'border-cyan-400 text-cyan-300'
                : 'border-transparent text-[#888888] hover:text-[#cccccc]'
            }`}
          >
            Stream Lines (Parallel Speed)
          </button>
        </div>

        {/* Body: Left Preview, Right Controls */}
        <div className="p-4 flex space-x-4 max-h-[480px]">
          {/* Interactive Preview Canvas */}
          <div className="flex flex-col items-center">
            <div className="relative border border-[#3b3d45] rounded overflow-hidden bg-white shadow-inner">
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
              <span className="text-[10px] text-[#777777] mt-1.5">
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
                    <span className="text-[#aaaaaa]">Center Cutout Radius:</span>
                    <span className="font-mono text-cyan-400">{satOptions.innerRadius}px</span>
                  </div>
                  <input
                    type="range"
                    min={10}
                    max={Math.round(Math.min(canvasWidth, canvasHeight) * 0.45)}
                    value={satOptions.innerRadius}
                    onChange={(e) =>
                      setSatOptions((p) => ({ ...p, innerRadius: Number(e.target.value) }))
                    }
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#aaaaaa]">Line Density:</span>
                    <span className="font-mono text-cyan-400">{satOptions.density} lines</span>
                  </div>
                  <input
                    type="range"
                    min={20}
                    max={400}
                    value={satOptions.density}
                    onChange={(e) =>
                      setSatOptions((p) => ({ ...p, density: Number(e.target.value) }))
                    }
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#aaaaaa]">Stroke Width:</span>
                    <span className="font-mono text-cyan-400">{satOptions.lineWidth}px</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={12}
                    value={satOptions.lineWidth}
                    onChange={(e) =>
                      setSatOptions((p) => ({ ...p, lineWidth: Number(e.target.value) }))
                    }
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#aaaaaa]">Spacing & Depth Jitter:</span>
                    <span className="font-mono text-cyan-400">{Math.round(satOptions.spacingJitter * 100)}%</span>
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
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div className="flex items-center space-x-2 pt-1">
                  <span className="text-[11px] text-[#aaaaaa]">Taper Direction:</span>
                  <button
                    onClick={() => setSatOptions((p) => ({ ...p, taper: 'in' }))}
                    className={`px-2 py-0.5 rounded text-[11px] border ${
                      satOptions.taper === 'in'
                        ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                        : 'border-[#3b3d45] text-[#888888]'
                    }`}
                  >
                    Point to Center
                  </button>
                  <button
                    onClick={() => setSatOptions((p) => ({ ...p, taper: 'none' }))}
                    className={`px-2 py-0.5 rounded text-[11px] border ${
                      satOptions.taper === 'none'
                        ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                        : 'border-[#3b3d45] text-[#888888]'
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
                    <span className="text-[#aaaaaa]">Angle:</span>
                    <span className="font-mono text-cyan-400">{streamOptions.angle}°</span>
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
                      className="flex-1 accent-cyan-400"
                    />
                    <div className="flex space-x-1">
                      <button
                        onClick={() => setStreamOptions((p) => ({ ...p, angle: 0 }))}
                        className="px-1.5 py-0.5 rounded bg-[#18191c] border border-[#3b3d45] text-[10px]"
                      >
                        0°
                      </button>
                      <button
                        onClick={() => setStreamOptions((p) => ({ ...p, angle: 90 }))}
                        className="px-1.5 py-0.5 rounded bg-[#18191c] border border-[#3b3d45] text-[10px]"
                      >
                        90°
                      </button>
                      <button
                        onClick={() => setStreamOptions((p) => ({ ...p, angle: 45 }))}
                        className="px-1.5 py-0.5 rounded bg-[#18191c] border border-[#3b3d45] text-[10px]"
                      >
                        45°
                      </button>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#aaaaaa]">Density:</span>
                    <span className="font-mono text-cyan-400">{streamOptions.density} lines</span>
                  </div>
                  <input
                    type="range"
                    min={15}
                    max={300}
                    value={streamOptions.density}
                    onChange={(e) =>
                      setStreamOptions((p) => ({ ...p, density: Number(e.target.value) }))
                    }
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#aaaaaa]">Streak Length:</span>
                    <span className="font-mono text-cyan-400">{streamOptions.lineLength}px</span>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={1200}
                    value={streamOptions.lineLength}
                    onChange={(e) =>
                      setStreamOptions((p) => ({ ...p, lineLength: Number(e.target.value) }))
                    }
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#aaaaaa]">Thickness:</span>
                    <span className="font-mono text-cyan-400">{streamOptions.thickness}px</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={streamOptions.thickness}
                    onChange={(e) =>
                      setStreamOptions((p) => ({ ...p, thickness: Number(e.target.value) }))
                    }
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-[11px] mb-1">
                    <span className="text-[#aaaaaa]">Thickness & Length Noise:</span>
                    <span className="font-mono text-cyan-400">
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
                    className="w-full accent-cyan-400"
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 bg-[#1a1b1e] border-t border-[#2e3036] flex items-center justify-between">
          <button
            onClick={() => {
              // Quick reset to defaults
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
            className="flex items-center space-x-1 text-xs text-[#888888] hover:text-[#cccccc] transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Reset Defaults</span>
          </button>

          <div className="flex items-center space-x-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-[#2b2d31] hover:bg-[#383a40] text-[#cccccc] rounded text-xs transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleApplyClick}
              className="px-3.5 py-1.5 bg-[#234b3e] hover:bg-[#2b604f] text-[#55eaab] border border-[#2e6e58] rounded text-xs font-semibold flex items-center space-x-1.5 transition-colors cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Apply Effect to Layer</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
