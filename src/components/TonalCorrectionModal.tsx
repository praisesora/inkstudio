import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X } from 'lucide-react';
import {
  TonalCorrectionType,
  BrightnessContrastParams,
  BinarizationParams,
  HueSaturationParams,
  PosterizationParams,
  LevelCorrectionParams,
  computeHistogram,
} from '../utils/tonalEngine';

interface TonalCorrectionModalProps {
  isOpen: boolean;
  type: TonalCorrectionType;
  beforeImageData: ImageData | null;
  selectionMask: Uint8Array | null;
  onClose: () => void;
  onApply: (type: TonalCorrectionType, params: any) => void;
  onPreviewChange: (type: TonalCorrectionType, params: any, enabled: boolean) => void;
}

const DEFAULT_BRIGHTNESS_CONTRAST: BrightnessContrastParams = {
  brightness: 0,
  contrast: 0,
};

const DEFAULT_BINARIZATION: BinarizationParams = {
  threshold: 128,
};

const DEFAULT_HUE_SATURATION: HueSaturationParams = {
  hue: 0,
  saturation: 0,
  luminosity: 0,
};

const DEFAULT_POSTERIZATION: PosterizationParams = {
  levels: 4,
};

const DEFAULT_LEVEL_CORRECTION: LevelCorrectionParams = {
  channel: 'rgb',
  inputMin: 0,
  gamma: 1.0,
  inputMax: 255,
  outputMin: 0,
  outputMax: 255,
};

export const TonalCorrectionModal: React.FC<TonalCorrectionModalProps> = ({
  isOpen,
  type,
  beforeImageData,
  selectionMask,
  onClose,
  onApply,
  onPreviewChange,
}) => {
  const [preview, setPreview] = useState(true);

  // Filter-specific parameter states
  const [bc, setBc] = useState<BrightnessContrastParams>(DEFAULT_BRIGHTNESS_CONTRAST);
  const [bin, setBin] = useState<BinarizationParams>(DEFAULT_BINARIZATION);
  const [hs, setHs] = useState<HueSaturationParams>(DEFAULT_HUE_SATURATION);
  const [post, setPost] = useState<PosterizationParams>(DEFAULT_POSTERIZATION);
  const [levels, setLevels] = useState<LevelCorrectionParams>(DEFAULT_LEVEL_CORRECTION);

  // Dragging modal window support
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ startX: number; startY: number; initX: number; initY: number }>({
    startX: 0,
    startY: 0,
    initX: 0,
    initY: 0,
  });

  const histogramCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Compute histograms for level correction
  const histogramMap = useMemo(() => {
    if (!beforeImageData || type !== 'level-correction') return null;
    return {
      rgb: computeHistogram(beforeImageData, 'rgb', selectionMask),
      r: computeHistogram(beforeImageData, 'r', selectionMask),
      g: computeHistogram(beforeImageData, 'g', selectionMask),
      b: computeHistogram(beforeImageData, 'b', selectionMask),
    };
  }, [beforeImageData, type, selectionMask]);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setPreview(true);
      setBc(DEFAULT_BRIGHTNESS_CONTRAST);
      setBin(DEFAULT_BINARIZATION);
      setHs(DEFAULT_HUE_SATURATION);
      setPost(DEFAULT_POSTERIZATION);
      setLevels(DEFAULT_LEVEL_CORRECTION);
      // Center position
      setPos({ x: 0, y: 0 });
    }
  }, [isOpen, type]);

  // Current params object
  const currentParams = useMemo(() => {
    switch (type) {
      case 'brightness-contrast':
        return bc;
      case 'binarization':
        return bin;
      case 'hue-saturation':
        return hs;
      case 'posterization':
        return post;
      case 'level-correction':
        return levels;
      default:
        return {};
    }
  }, [type, bc, bin, hs, post, levels]);

  // Trigger preview update
  useEffect(() => {
    if (!isOpen) return;
    onPreviewChange(type, currentParams, preview);
  }, [isOpen, type, currentParams, preview, onPreviewChange]);

  // Draw histogram for Level Correction
  useEffect(() => {
    if (type !== 'level-correction' || !histogramCanvasRef.current || !histogramMap) return;
    const canvas = histogramCanvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const counts = histogramMap[levels.channel] || histogramMap.rgb;
    let maxCount = 1;
    // Discard peak outliers (e.g. large empty white/black areas) for better visual distribution
    for (let i = 1; i < 255; i++) {
      if (counts[i] > maxCount) maxCount = counts[i];
    }
    // Also check 0 and 255 with soft clamp
    maxCount = Math.max(maxCount, Math.min(counts[0], counts[255]));

    // Background gradient / subtle guide grid
    ctx.fillStyle = '#18181a';
    ctx.fillRect(0, 0, w, h);

    // Guide lines
    ctx.strokeStyle = '#2b2b2e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w * 0.25, 0);
    ctx.lineTo(w * 0.25, h);
    ctx.moveTo(w * 0.5, 0);
    ctx.lineTo(w * 0.5, h);
    ctx.moveTo(w * 0.75, 0);
    ctx.lineTo(w * 0.75, h);
    ctx.stroke();

    // Bars
    let barColor = '#5ce1e6';
    if (levels.channel === 'r') barColor = '#ff6b6b';
    if (levels.channel === 'g') barColor = '#51cf66';
    if (levels.channel === 'b') barColor = '#339af0';

    ctx.fillStyle = barColor;
    const barWidth = w / 256;
    for (let i = 0; i < 256; i++) {
      const val = counts[i];
      const barHeight = Math.min(h, (val / maxCount) * h);
      ctx.fillRect(i * barWidth, h - barHeight, Math.max(1, barWidth), barHeight);
    }
  }, [type, levels.channel, histogramMap]);

  // Window drag handlers
  const handleDragPointerDown = (e: React.PointerEvent) => {
    isDraggingRef.current = true;
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initX: pos.x,
      initY: pos.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleDragPointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.startX;
    const dy = e.clientY - dragStartRef.current.startY;
    setPos({
      x: dragStartRef.current.initX + dx,
      y: dragStartRef.current.initY + dy,
    });
  };

  const handleDragPointerUp = (e: React.PointerEvent) => {
    isDraggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  };

  const handleReset = () => {
    switch (type) {
      case 'brightness-contrast':
        setBc(DEFAULT_BRIGHTNESS_CONTRAST);
        break;
      case 'binarization':
        setBin(DEFAULT_BINARIZATION);
        break;
      case 'hue-saturation':
        setHs(DEFAULT_HUE_SATURATION);
        break;
      case 'posterization':
        setPost(DEFAULT_POSTERIZATION);
        break;
      case 'level-correction':
        setLevels(DEFAULT_LEVEL_CORRECTION);
        break;
    }
  };

  const handleAutoLevels = () => {
    if (!histogramMap) return;
    const counts = histogramMap[levels.channel] || histogramMap.rgb;
    let total = 0;
    for (let i = 0; i < 256; i++) total += counts[i];
    if (total === 0) return;

    const shadowThreshold = total * 0.006;
    const highlightThreshold = total * 0.006;

    let shadowAcc = 0;
    let autoMin = 0;
    for (let i = 0; i < 256; i++) {
      shadowAcc += counts[i];
      if (shadowAcc >= shadowThreshold) {
        autoMin = i;
        break;
      }
    }

    let highlightAcc = 0;
    let autoMax = 255;
    for (let i = 255; i >= 0; i--) {
      highlightAcc += counts[i];
      if (highlightAcc >= highlightThreshold) {
        autoMax = i;
        break;
      }
    }

    if (autoMax <= autoMin) {
      autoMax = Math.min(255, autoMin + 10);
    }

    setLevels((prev) => ({
      ...prev,
      inputMin: autoMin,
      inputMax: autoMax,
      gamma: 1.0,
    }));
  };

  // Keyboard shortcut listeners (Enter to commit, Escape to cancel)
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        onApply(type, currentParams);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, type, currentParams, onClose, onApply]);

  if (!isOpen) return null;

  const getTitle = () => {
    switch (type) {
      case 'brightness-contrast':
        return 'Brightness / Contrast';
      case 'binarization':
        return 'Binarization (Threshold)';
      case 'hue-saturation':
        return 'Hue / Saturation / Luminosity';
      case 'posterization':
        return 'Posterization';
      case 'level-correction':
        return 'Level Correction';
      default:
        return 'Tonal Correction';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
      {/* Semi-transparent backdrop that lets canvas stay visible */}
      <div className="fixed inset-0 bg-black/40 pointer-events-auto" onClick={onClose} />

      {/* Floating Dialog */}
      <div
        className="relative pointer-events-auto w-[360px] bg-[#202020] border border-white/[0.1] rounded-lg shadow-2xl flex flex-col text-xs text-[#e5e5e5] select-none"
        style={{
          transform: `translate(${pos.x}px, ${pos.y}px)`,
        }}
      >
        {/* Draggable Title Header */}
        <div
          onPointerDown={handleDragPointerDown}
          onPointerMove={handleDragPointerMove}
          onPointerUp={handleDragPointerUp}
          className="h-9 px-3.5 bg-[#1a1a1a] border-b border-white/[0.06] flex items-center justify-between cursor-move rounded-t-lg"
        >
          <span className="font-medium text-[#e5e5e5]">{getTitle()}</span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Dialog Content */}
        <div className="p-4 space-y-4 max-h-[80vh] overflow-y-auto">
          {/* BRIGHTNESS / CONTRAST */}
          {type === 'brightness-contrast' && (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[#a0a0a0]">Brightness:</span>
                  <input
                    type="number"
                    min={-100}
                    max={100}
                    value={bc.brightness}
                    onChange={(e) =>
                      setBc((prev) => ({
                        ...prev,
                        brightness: Math.max(-100, Math.min(100, Number(e.target.value) || 0)),
                      }))
                    }
                    className="w-14 bg-[#1e1e1e] border border-[#3e3e3e] rounded px-1.5 py-0.5 text-right font-mono text-xs text-white focus:outline-none focus:border-[#007acc]"
                  />
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  value={bc.brightness}
                  onChange={(e) =>
                    setBc((prev) => ({ ...prev, brightness: Number(e.target.value) }))
                  }
                  className="w-full h-1.5 bg-[#1e1e1e] rounded-lg appearance-none cursor-pointer accent-[#5ce1e6]"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[#a0a0a0]">Contrast:</span>
                  <input
                    type="number"
                    min={-100}
                    max={100}
                    value={bc.contrast}
                    onChange={(e) =>
                      setBc((prev) => ({
                        ...prev,
                        contrast: Math.max(-100, Math.min(100, Number(e.target.value) || 0)),
                      }))
                    }
                    className="w-14 bg-[#1e1e1e] border border-[#3e3e3e] rounded px-1.5 py-0.5 text-right font-mono text-xs text-white focus:outline-none focus:border-[#007acc]"
                  />
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  value={bc.contrast}
                  onChange={(e) =>
                    setBc((prev) => ({ ...prev, contrast: Number(e.target.value) }))
                  }
                  className="w-full h-1.5 bg-[#1e1e1e] rounded-lg appearance-none cursor-pointer accent-[#5ce1e6]"
                />
              </div>
            </div>
          )}

          {/* BINARIZATION */}
          {type === 'binarization' && (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[#a0a0a0]">Threshold:</span>
                  <input
                    type="number"
                    min={1}
                    max={255}
                    value={bin.threshold}
                    onChange={(e) =>
                      setBin({
                        threshold: Math.max(1, Math.min(255, Number(e.target.value) || 1)),
                      })
                    }
                    className="w-14 bg-[#1e1e1e] border border-[#3e3e3e] rounded px-1.5 py-0.5 text-right font-mono text-xs text-white focus:outline-none focus:border-[#007acc]"
                  />
                </div>
                <input
                  type="range"
                  min={1}
                  max={255}
                  value={bin.threshold}
                  onChange={(e) => setBin({ threshold: Number(e.target.value) })}
                  className="w-full h-1.5 bg-[#1e1e1e] rounded-lg appearance-none cursor-pointer accent-[#5ce1e6]"
                />
                <div className="flex justify-between text-[10px] text-[#777777] mt-1">
                  <span>Black (1)</span>
                  <span>Mid (128)</span>
                  <span>White (255)</span>
                </div>
              </div>
            </div>
          )}

          {/* HUE / SATURATION / LUMINOSITY */}
          {type === 'hue-saturation' && (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[#a0a0a0]">Hue:</span>
                  <input
                    type="number"
                    min={-180}
                    max={180}
                    value={hs.hue}
                    onChange={(e) =>
                      setHs((prev) => ({
                        ...prev,
                        hue: Math.max(-180, Math.min(180, Number(e.target.value) || 0)),
                      }))
                    }
                    className="w-14 bg-[#1e1e1e] border border-[#3e3e3e] rounded px-1.5 py-0.5 text-right font-mono text-xs text-white focus:outline-none focus:border-[#007acc]"
                  />
                </div>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  value={hs.hue}
                  onChange={(e) =>
                    setHs((prev) => ({ ...prev, hue: Number(e.target.value) }))
                  }
                  className="w-full h-1.5 bg-[#1e1e1e] rounded-lg appearance-none cursor-pointer accent-[#5ce1e6]"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[#a0a0a0]">Saturation:</span>
                  <input
                    type="number"
                    min={-100}
                    max={100}
                    value={hs.saturation}
                    onChange={(e) =>
                      setHs((prev) => ({
                        ...prev,
                        saturation: Math.max(-100, Math.min(100, Number(e.target.value) || 0)),
                      }))
                    }
                    className="w-14 bg-[#1e1e1e] border border-[#3e3e3e] rounded px-1.5 py-0.5 text-right font-mono text-xs text-white focus:outline-none focus:border-[#007acc]"
                  />
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  value={hs.saturation}
                  onChange={(e) =>
                    setHs((prev) => ({ ...prev, saturation: Number(e.target.value) }))
                  }
                  className="w-full h-1.5 bg-[#1e1e1e] rounded-lg appearance-none cursor-pointer accent-[#5ce1e6]"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[#a0a0a0]">Luminosity:</span>
                  <input
                    type="number"
                    min={-100}
                    max={100}
                    value={hs.luminosity}
                    onChange={(e) =>
                      setHs((prev) => ({
                        ...prev,
                        luminosity: Math.max(-100, Math.min(100, Number(e.target.value) || 0)),
                      }))
                    }
                    className="w-14 bg-[#1e1e1e] border border-[#3e3e3e] rounded px-1.5 py-0.5 text-right font-mono text-xs text-white focus:outline-none focus:border-[#007acc]"
                  />
                </div>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  value={hs.luminosity}
                  onChange={(e) =>
                    setHs((prev) => ({ ...prev, luminosity: Number(e.target.value) }))
                  }
                  className="w-full h-1.5 bg-[#1e1e1e] rounded-lg appearance-none cursor-pointer accent-[#5ce1e6]"
                />
              </div>
            </div>
          )}

          {/* POSTERIZATION */}
          {type === 'posterization' && (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[#a0a0a0]">Gradation Levels:</span>
                  <input
                    type="number"
                    min={2}
                    max={32}
                    value={post.levels}
                    onChange={(e) =>
                      setPost({
                        levels: Math.max(2, Math.min(32, Number(e.target.value) || 2)),
                      })
                    }
                    className="w-14 bg-[#1e1e1e] border border-[#3e3e3e] rounded px-1.5 py-0.5 text-right font-mono text-xs text-white focus:outline-none focus:border-[#007acc]"
                  />
                </div>
                <input
                  type="range"
                  min={2}
                  max={32}
                  value={post.levels}
                  onChange={(e) => setPost({ levels: Number(e.target.value) })}
                  className="w-full h-1.5 bg-[#1e1e1e] rounded-lg appearance-none cursor-pointer accent-[#5ce1e6]"
                />
                <div className="flex justify-between text-[10px] text-[#777777] mt-1">
                  <span>2 (High Contrast)</span>
                  <span>16</span>
                  <span>32 (Smooth)</span>
                </div>
              </div>
            </div>
          )}

          {/* LEVEL CORRECTION */}
          {type === 'level-correction' && (
            <div className="space-y-3.5">
              {/* Channel Selector */}
              <div className="flex items-center justify-between">
                <span className="text-[#a0a0a0]">Channel:</span>
                <div className="flex space-x-1">
                  {(['rgb', 'r', 'g', 'b'] as const).map((ch) => (
                    <button
                      key={ch}
                      type="button"
                      onClick={() => setLevels((prev) => ({ ...prev, channel: ch }))}
                      className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                        levels.channel === ch
                          ? 'bg-[#007acc] text-white shadow-sm'
                          : 'bg-[#1e1e1e] border border-[#3e3e3e] text-[#888888] hover:text-[#cccccc]'
                      }`}
                    >
                      {ch.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              {/* Histogram Display Canvas */}
              <div className="border border-[#3e3e3e] rounded overflow-hidden">
                <canvas
                  ref={histogramCanvasRef}
                  width={256}
                  height={80}
                  className="w-full h-20 block"
                />
              </div>

              {/* Input Levels */}
              <div>
                <div className="flex items-center justify-between text-[11px] text-[#a0a0a0] mb-1">
                  <span>Input Levels (Shadow / Gamma / Highlight):</span>
                  <button
                    type="button"
                    onClick={handleAutoLevels}
                    className="text-[var(--accent)] hover:underline cursor-pointer"
                  >
                    Auto
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="text-[10px] text-[#777777] block mb-0.5">Shadow</label>
                    <input
                      type="number"
                      min={0}
                      max={Math.max(0, levels.inputMax - 2)}
                      value={levels.inputMin}
                      onChange={(e) =>
                        setLevels((prev) => ({
                          ...prev,
                          inputMin: Math.max(
                            0,
                            Math.min(prev.inputMax - 2, Number(e.target.value) || 0)
                          ),
                        }))
                      }
                      className="w-full bg-[#1e1e1e] border border-[#3e3e3e] rounded px-1.5 py-0.5 text-center font-mono text-xs text-white focus:outline-none focus:border-[#007acc]"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-[#777777] block mb-0.5">Gamma</label>
                    <input
                      type="number"
                      step={0.05}
                      min={0.1}
                      max={9.99}
                      value={levels.gamma}
                      onChange={(e) =>
                        setLevels((prev) => ({
                          ...prev,
                          gamma: Math.max(0.1, Math.min(9.99, Number(e.target.value) || 1.0)),
                        }))
                      }
                      className="w-full bg-[#1e1e1e] border border-[#3e3e3e] rounded px-1.5 py-0.5 text-center font-mono text-xs text-white focus:outline-none focus:border-[#007acc]"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-[#777777] block mb-0.5">Highlight</label>
                    <input
                      type="number"
                      min={Math.min(255, levels.inputMin + 2)}
                      max={255}
                      value={levels.inputMax}
                      onChange={(e) =>
                        setLevels((prev) => ({
                          ...prev,
                          inputMax: Math.max(
                            prev.inputMin + 2,
                            Math.min(255, Number(e.target.value) || 255)
                          ),
                        }))
                      }
                      className="w-full bg-[#1e1e1e] border border-[#3e3e3e] rounded px-1.5 py-0.5 text-center font-mono text-xs text-white focus:outline-none focus:border-[#007acc]"
                    />
                  </div>
                </div>

                {/* Range Slider for Shadows & Highlights */}
                <div className="mt-2 space-y-1.5">
                  <div className="flex items-center space-x-2">
                    <span className="text-[10px] text-[#777777] w-12">Shadow:</span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, levels.inputMax - 2)}
                      value={levels.inputMin}
                      onChange={(e) =>
                        setLevels((prev) => ({ ...prev, inputMin: Number(e.target.value) }))
                      }
                      className="flex-1 h-1.5 bg-[#1e1e1e] rounded appearance-none cursor-pointer accent-[#5ce1e6]"
                    />
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-[10px] text-[#777777] w-12">Highlight:</span>
                    <input
                      type="range"
                      min={Math.min(255, levels.inputMin + 2)}
                      max={255}
                      value={levels.inputMax}
                      onChange={(e) =>
                        setLevels((prev) => ({ ...prev, inputMax: Number(e.target.value) }))
                      }
                      className="flex-1 h-1.5 bg-[#1e1e1e] rounded appearance-none cursor-pointer accent-[#5ce1e6]"
                    />
                  </div>
                </div>
              </div>

              {/* Output Levels */}
              <div className="pt-2 border-t border-[#333333]">
                <div className="flex items-center justify-between text-[11px] text-[#a0a0a0] mb-1">
                  <span>Output Levels:</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-[#777777] block mb-0.5">Min (Black)</label>
                    <input
                      type="number"
                      min={0}
                      max={levels.outputMax}
                      value={levels.outputMin}
                      onChange={(e) =>
                        setLevels((prev) => ({
                          ...prev,
                          outputMin: Math.max(0, Math.min(prev.outputMax, Number(e.target.value) || 0)),
                        }))
                      }
                      className="w-full bg-[#1e1e1e] border border-[#3e3e3e] rounded px-1.5 py-0.5 text-center font-mono text-xs text-white focus:outline-none focus:border-[#007acc]"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-[#777777] block mb-0.5">Max (White)</label>
                    <input
                      type="number"
                      min={levels.outputMin}
                      max={255}
                      value={levels.outputMax}
                      onChange={(e) =>
                        setLevels((prev) => ({
                          ...prev,
                          outputMax: Math.max(prev.outputMin, Math.min(255, Number(e.target.value) || 255)),
                        }))
                      }
                      className="w-full bg-[#1e1e1e] border border-[#3e3e3e] rounded px-1.5 py-0.5 text-center font-mono text-xs text-white focus:outline-none focus:border-[#007acc]"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div className="px-3.5 py-2.5 bg-[#1a1a1a] border-t border-white/[0.06] flex items-center justify-between rounded-b-lg">
          <div className="flex items-center space-x-3">
            <label className="flex items-center space-x-1.5 cursor-pointer text-[#cccccc] hover:text-[#e5e5e5]">
              <input
                type="checkbox"
                checked={preview}
                onChange={(e) => setPreview(e.target.checked)}
              />
              <span className="text-[11px]">Preview</span>
            </label>
            <button
              type="button"
              onClick={handleReset}
              className="text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] transition-colors cursor-pointer"
              title="Reset parameters"
            >
              Reset
            </button>
          </div>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 bg-[#2c2c2c] hover:bg-[#383838] text-[#e5e5e5] rounded text-xs transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onApply(type, currentParams)}
              className="px-3.5 py-1 bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 rounded text-xs font-medium transition-opacity cursor-pointer"
            >
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
