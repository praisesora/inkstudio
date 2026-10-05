import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Plus,
  Trash2,
  Download,
  ChevronLeft,
  ChevronRight,
  Repeat,
  Layers,
  Sparkles,
  X,
  Film,
} from 'lucide-react';
import { AnimationTimeline as TimelineData, LayerItem, AnimationExportFormat } from '../types/editor';
import {
  exportAnimationToGif,
  exportAnimationToApng,
  exportAnimationToVideo,
  exportAnimationToPngZip,
  downloadBlob,
} from '../utils/animationEngine';

export interface AnimationTimelineProps {
  timeline: TimelineData;
  onChangeTimeline: (timeline: TimelineData) => void;
  layers: LayerItem[];
  layerCanvasesMap?: Map<string, HTMLCanvasElement>;
  dimensions: { width: number; height: number };
  onAddCel: (frameIndex: number) => void;
  onDeleteCel: (frameIndex: number) => void;
  onSelectCelLayer?: (layerId: string) => void;
  onClose?: () => void;
}

export const AnimationTimeline: React.FC<AnimationTimelineProps> = ({
  timeline,
  onChangeTimeline,
  layers,
  layerCanvasesMap = new Map(),
  dimensions,
  onAddCel,
  onDeleteCel,
  onSelectCelLayer,
  onClose,
}) => {
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [showOnionSettings, setShowOnionSettings] = useState<boolean>(false);
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [exportFormat, setExportFormat] = useState<AnimationExportFormat>('gif');
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<string>('');

  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const playTimerRef = useRef<number | null>(null);

  // Playback timer loop
  useEffect(() => {
    if (!isPlaying) {
      if (playTimerRef.current !== null) {
        clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
      return;
    }

    const intervalMs = Math.max(10, Math.round(1000 / timeline.fps));
    playTimerRef.current = window.setInterval(() => {
      onChangeTimeline({
        ...timeline,
        currentFrame:
          timeline.currentFrame + 1 >= timeline.totalFrames
            ? timeline.loop
              ? 0
              : timeline.totalFrames - 1
            : timeline.currentFrame + 1,
      });

      if (!timeline.loop && timeline.currentFrame + 1 >= timeline.totalFrames) {
        setIsPlaying(false);
      }
    }, intervalMs);

    return () => {
      if (playTimerRef.current !== null) {
        clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [isPlaying, timeline, onChangeTimeline]);

  // Synchronize active cel layer when frame changes
  useEffect(() => {
    const celId = timeline.cels[timeline.currentFrame];
    if (celId && onSelectCelLayer) {
      onSelectCelLayer(celId);
    }
  }, [timeline.currentFrame, timeline.cels, onSelectCelLayer]);

  // Handle Scrub Click/Drag
  const handleScrub = useCallback(
    (clientX: number) => {
      if (!scrubberRef.current) return;
      const rect = scrubberRef.current.getBoundingClientRect();
      const clickX = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const frameRatio = clickX / rect.width;
      const newFrame = Math.max(0, Math.min(timeline.totalFrames - 1, Math.floor(frameRatio * timeline.totalFrames)));

      onChangeTimeline({
        ...timeline,
        currentFrame: newFrame,
      });
    },
    [timeline, onChangeTimeline]
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    handleScrub(e.clientX);

    const onPointerMove = (ev: PointerEvent) => handleScrub(ev.clientX);
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  // Keyboard navigation shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying((p) => !p);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        onChangeTimeline({
          ...timeline,
          currentFrame: Math.max(0, timeline.currentFrame - 1),
        });
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        onChangeTimeline({
          ...timeline,
          currentFrame: Math.min(timeline.totalFrames - 1, timeline.currentFrame + 1),
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [timeline, onChangeTimeline]);

  // Export Action
  const handleExport = async () => {
    setIsExporting(true);
    setExportProgress('Encoding frames...');

    try {
      const onProgress = (current: number, total: number) => {
        setExportProgress(`Rendering ${current}/${total}...`);
      };

      let blob: Blob;
      let filename = `animation_${Date.now()}`;

      if (exportFormat === 'gif') {
        blob = await exportAnimationToGif(timeline, layers, layerCanvasesMap, dimensions, onProgress);
        filename += '.gif';
      } else if (exportFormat === 'apng') {
        blob = await exportAnimationToApng(timeline, layers, layerCanvasesMap, dimensions, onProgress);
        filename += '.png';
      } else if (exportFormat === 'webm' || exportFormat === 'mp4') {
        blob = await exportAnimationToVideo(timeline, layers, layerCanvasesMap, dimensions, onProgress);
        filename += exportFormat === 'mp4' ? '.mp4' : '.webm';
      } else {
        blob = await exportAnimationToPngZip(timeline, layers, layerCanvasesMap, dimensions, onProgress);
        filename += '.zip';
      }

      downloadBlob(blob, filename);
      setShowExportModal(false);
    } catch (err) {
      console.error('[Animation Export Failed]:', err);
    } finally {
      setIsExporting(false);
      setExportProgress('');
    }
  };

  const currentCelId = timeline.cels[timeline.currentFrame];
  const currentCelLayer = currentCelId ? layers.find((l) => l.id === currentCelId) : null;

  return (
    <div className="absolute inset-x-0 bottom-0 z-40 bg-[#17191e]/95 backdrop-blur-md border-t border-[#2e323b] shadow-2xl flex flex-col select-none text-xs text-gray-300">
      {/* 1. Header & Transport Controls Dock */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#242730] bg-[#1a1d24]">
        {/* Playback Transport */}
        <div className="flex items-center space-x-1.5">
          <button
            type="button"
            onClick={() => onChangeTimeline({ ...timeline, currentFrame: 0 })}
            className="p-1 hover:bg-white/10 rounded text-gray-400 hover:text-white"
            title="First Frame (Home)"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() =>
              onChangeTimeline({
                ...timeline,
                currentFrame: Math.max(0, timeline.currentFrame - 1),
              })
            }
            className="p-1 hover:bg-white/10 rounded text-gray-400 hover:text-white"
            title="Previous Frame (Left Arrow)"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setIsPlaying(!isPlaying)}
            className={`p-1.5 px-3 rounded font-medium flex items-center space-x-1.5 shadow-md transition-colors ${
              isPlaying
                ? 'bg-amber-600 hover:bg-amber-500 text-white'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white'
            }`}
            title="Play / Pause (Space)"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span className="text-[11px] font-semibold">{isPlaying ? 'Pause' : 'Play'}</span>
          </button>
          <button
            type="button"
            onClick={() =>
              onChangeTimeline({
                ...timeline,
                currentFrame: Math.min(timeline.totalFrames - 1, timeline.currentFrame + 1),
              })
            }
            className="p-1 hover:bg-white/10 rounded text-gray-400 hover:text-white"
            title="Next Frame (Right Arrow)"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          {/* Loop Toggle */}
          <button
            type="button"
            onClick={() => onChangeTimeline({ ...timeline, loop: !timeline.loop })}
            className={`p-1 px-2 rounded border border-white/5 flex items-center space-x-1 ${
              timeline.loop ? 'bg-sky-600/30 text-sky-300 ring-1 ring-sky-400' : 'text-gray-400 hover:bg-white/10'
            }`}
            title="Loop Playback"
          >
            <Repeat className="w-3 h-3" />
            <span className="text-[10px]">Loop</span>
          </button>

          {/* Frame Rate FPS Selector */}
          <div className="flex items-center space-x-1 bg-[#22252c] rounded px-2 py-0.5 border border-white/5">
            <span className="text-[10px] text-gray-400 font-mono">FPS:</span>
            <select
              value={timeline.fps}
              onChange={(e) =>
                onChangeTimeline({
                  ...timeline,
                  fps: parseInt(e.target.value, 10),
                })
              }
              className="bg-transparent text-white font-mono text-[11px] outline-none cursor-pointer"
            >
              {[6, 8, 12, 16, 24, 30, 60].map((rate) => (
                <option key={rate} value={rate} className="bg-[#1e2129]">
                  {rate} fps
                </option>
              ))}
            </select>
          </div>

          {/* Frame Ticker Counter */}
          <div className="font-mono text-cyan-400 bg-[#14161b] px-2.5 py-0.5 rounded border border-[#2a2d36] text-[11px] tracking-wider">
            {String(timeline.currentFrame + 1).padStart(3, '0')} / {String(timeline.totalFrames).padStart(3, '0')}
          </div>
        </div>

        {/* Cel & Onion Skin Tools */}
        <div className="flex items-center space-x-2">
          {/* Add Cel Button */}
          <button
            type="button"
            onClick={() => onAddCel(timeline.currentFrame)}
            className="flex items-center space-x-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium shadow-sm"
            title="Add Cel for Current Frame"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="text-[11px]">Add Cel</span>
          </button>

          {/* Delete Cel Button */}
          {currentCelId && (
            <button
              type="button"
              onClick={() => onDeleteCel(timeline.currentFrame)}
              className="p-1 hover:bg-red-500/20 text-gray-400 hover:text-red-400 rounded transition-colors"
              title="Delete Cel from Current Frame"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}

          {/* Onion Skin Quick Settings Popover */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowOnionSettings(!showOnionSettings)}
              className={`flex items-center space-x-1 px-2 py-1 rounded border border-white/5 transition-colors ${
                timeline.onionSkin.enabled
                  ? 'bg-purple-600/30 text-purple-300 ring-1 ring-purple-400'
                  : 'text-gray-400 hover:bg-white/10'
              }`}
              title="Configure Colored Onion Skinning"
            >
              <Layers className="w-3.5 h-3.5" />
              <span className="text-[11px]">Onion Skin</span>
            </button>

            {showOnionSettings && (
              <div className="absolute bottom-full mb-2 right-0 bg-[#1b1e24] border border-purple-500/40 rounded-xl p-3 shadow-2xl z-50 flex flex-col space-y-2.5 w-64">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-purple-300 text-xs flex items-center space-x-1">
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Colored Onion Skin</span>
                  </span>
                  <label className="flex items-center space-x-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={timeline.onionSkin.enabled}
                      onChange={(e) =>
                        onChangeTimeline({
                          ...timeline,
                          onionSkin: {
                            ...timeline.onionSkin,
                            enabled: e.target.checked,
                          },
                        })
                      }
                      className="accent-purple-500"
                    />
                    <span className="text-[10px] text-gray-300">Enabled</span>
                  </label>
                </div>

                {/* Prior Frames Settings (Cyan/Red) */}
                <div className="flex items-center justify-between text-[11px] text-gray-300">
                  <span>Prior Frames ({timeline.onionSkin.prevFrames}):</span>
                  <div className="flex items-center space-x-2">
                    <input
                      type="color"
                      value={timeline.onionSkin.prevTint}
                      onChange={(e) =>
                        onChangeTimeline({
                          ...timeline,
                          onionSkin: {
                            ...timeline.onionSkin,
                            prevTint: e.target.value,
                          },
                        })
                      }
                      className="w-5 h-5 rounded cursor-pointer border-0 bg-transparent"
                    />
                    <input
                      type="range"
                      min="1"
                      max="5"
                      value={timeline.onionSkin.prevFrames}
                      onChange={(e) =>
                        onChangeTimeline({
                          ...timeline,
                          onionSkin: {
                            ...timeline.onionSkin,
                            prevFrames: parseInt(e.target.value, 10),
                          },
                        })
                      }
                      className="w-16 accent-cyan-400 h-1"
                    />
                  </div>
                </div>

                {/* Next Frames Settings (Magenta/Blue) */}
                <div className="flex items-center justify-between text-[11px] text-gray-300">
                  <span>Next Frames ({timeline.onionSkin.nextFrames}):</span>
                  <div className="flex items-center space-x-2">
                    <input
                      type="color"
                      value={timeline.onionSkin.nextTint}
                      onChange={(e) =>
                        onChangeTimeline({
                          ...timeline,
                          onionSkin: {
                            ...timeline.onionSkin,
                            nextTint: e.target.value,
                          },
                        })
                      }
                      className="w-5 h-5 rounded cursor-pointer border-0 bg-transparent"
                    />
                    <input
                      type="range"
                      min="1"
                      max="5"
                      value={timeline.onionSkin.nextFrames}
                      onChange={(e) =>
                        onChangeTimeline({
                          ...timeline,
                          onionSkin: {
                            ...timeline.onionSkin,
                            nextFrames: parseInt(e.target.value, 10),
                          },
                        })
                      }
                      className="w-16 accent-pink-500 h-1"
                    />
                  </div>
                </div>

                {/* Base Opacity */}
                <div className="flex items-center justify-between text-[11px] text-gray-300">
                  <span>Base Opacity:</span>
                  <div className="flex items-center space-x-2">
                    <input
                      type="range"
                      min="0.1"
                      max="0.8"
                      step="0.05"
                      value={timeline.onionSkin.opacity}
                      onChange={(e) =>
                        onChangeTimeline({
                          ...timeline,
                          onionSkin: {
                            ...timeline.onionSkin,
                            opacity: parseFloat(e.target.value),
                          },
                        })
                      }
                      className="w-24 accent-purple-500 h-1"
                    />
                    <span className="font-mono text-[10px] w-6 text-right">
                      {Math.round(timeline.onionSkin.opacity * 100)}%
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Total Frames Adjuster */}
          <div className="flex items-center space-x-1 bg-[#22252c] rounded px-1.5 py-0.5 border border-white/5">
            <span className="text-[10px] text-gray-400">Total:</span>
            <input
              type="number"
              min="2"
              max="240"
              value={timeline.totalFrames}
              onChange={(e) =>
                onChangeTimeline({
                  ...timeline,
                  totalFrames: Math.max(2, Math.min(240, parseInt(e.target.value, 10) || 24)),
                })
              }
              className="w-10 bg-transparent font-mono text-white text-center text-[11px] outline-none"
            />
          </div>

          {/* Export Video Modal Button */}
          <button
            type="button"
            onClick={() => setShowExportModal(true)}
            className="flex items-center space-x-1 px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-medium shadow-sm"
            title="Export Animation"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="text-[11px]">Export</span>
          </button>

          {/* Close Timeline */}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-white hover:bg-white/10 rounded transition-colors"
              title="Close Timeline Dock"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 2. Interactive Scrubber Timeline Track */}
      <div className="px-3 py-2 flex flex-col space-y-1 bg-[#14161b]">
        {/* Frame Ruler Numbers */}
        <div
          ref={scrubberRef}
          onPointerDown={handlePointerDown}
          className="relative h-14 bg-[#1b1e25] rounded border border-[#2d313b] cursor-pointer overflow-hidden flex flex-col justify-between"
        >
          {/* Top Frame Tick Ruler */}
          <div className="relative h-5 border-b border-[#292c36] bg-[#20242d] flex items-center">
            {Array.from({ length: timeline.totalFrames }).map((_, f) => (
              <div
                key={f}
                style={{
                  width: `${100 / timeline.totalFrames}%`,
                }}
                className={`h-full border-r border-[#2d313b] flex items-center justify-center text-[9px] font-mono select-none ${
                  f % 5 === 0 ? 'text-gray-300 font-bold' : 'text-gray-500 text-[8px]'
                }`}
              >
                {f % 2 === 0 || timeline.totalFrames <= 24 ? f + 1 : ''}
              </div>
            ))}
          </div>

          {/* Cel Slots Track */}
          <div className="relative h-9 flex items-center">
            {Array.from({ length: timeline.totalFrames }).map((_, f) => {
              const hasCel = !!timeline.cels[f];
              const isCurrent = timeline.currentFrame === f;

              return (
                <div
                  key={f}
                  style={{
                    width: `${100 / timeline.totalFrames}%`,
                  }}
                  className={`h-full border-r border-[#262933] flex items-center justify-center p-0.5 transition-colors ${
                    isCurrent ? 'bg-sky-500/10' : ''
                  }`}
                >
                  {hasCel ? (
                    <div
                      className={`w-full h-5 rounded-[2px] flex items-center justify-center text-[9px] font-mono font-medium shadow-sm truncate ${
                        isCurrent
                          ? 'bg-sky-500 text-white font-bold ring-1 ring-white'
                          : 'bg-[#3b4252] text-gray-200 hover:bg-[#434c5e]'
                      }`}
                      title={`Frame ${f + 1}: Cel Assigned`}
                    >
                      ●
                    </div>
                  ) : (
                    <div className="w-1 h-1 rounded-full bg-gray-600/40" />
                  )}
                </div>
              );
            })}
          </div>

          {/* Scrub Playhead Red Line */}
          <div
            className="absolute top-0 bottom-0 pointer-events-none z-20 transition-all duration-75 flex flex-col items-center"
            style={{
              left: `${((timeline.currentFrame + 0.5) / timeline.totalFrames) * 100}%`,
              transform: 'translateX(-50%)',
            }}
          >
            <div className="w-3 h-2 bg-red-500 rounded-b shadow-[0_0_8px_rgba(239,68,68,0.8)]" />
            <div className="w-[2px] h-full bg-red-500" />
          </div>
        </div>

        {/* Cel Info Bar */}
        <div className="flex items-center justify-between text-[10px] text-gray-400 px-1">
          <div className="flex items-center space-x-2">
            <span>
              Active Cel:{' '}
              {currentCelLayer ? (
                <span className="text-cyan-400 font-medium font-mono">{currentCelLayer.name}</span>
              ) : (
                <span className="text-gray-500 italic">None (Drawing creates new frame cel)</span>
              )}
            </span>
          </div>
          <div className="flex items-center space-x-3 text-gray-500">
            <span>Click/drag scrubber to navigate</span>
            <span>•</span>
            <span>Space: Play/Pause</span>
            <span>•</span>
            <span>← / →: Prev/Next frame</span>
          </div>
        </div>
      </div>

      {/* 3. Export Modal */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-[#1b1e25] border border-white/10 rounded-xl p-5 shadow-2xl w-84 flex flex-col space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-white flex items-center space-x-1.5">
                <Film className="w-4 h-4 text-emerald-400" />
                <span>Export Animation</span>
              </span>
              <button
                type="button"
                onClick={() => setShowExportModal(false)}
                className="text-gray-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-col space-y-2">
              <label className="text-xs text-gray-300">Format</label>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {(
                  [
                    ['gif', 'Animated GIF'],
                    ['apng', 'Animated PNG (APNG)'],
                    ['webm', 'WebM Video'],
                    ['png-zip', 'Numbered PNGs (.zip)'],
                  ] as Array<[AnimationExportFormat, string]>
                ).map(([fmt, label]) => (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => setExportFormat(fmt)}
                    className={`py-2 px-2.5 rounded text-left border transition-colors ${
                      exportFormat === fmt
                        ? 'bg-emerald-600/30 border-emerald-500 text-white font-medium ring-1 ring-emerald-500'
                        : 'bg-[#252831] border-white/5 text-gray-400 hover:bg-white/5'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="text-[11px] text-gray-400 space-y-1 bg-[#14161b] p-2.5 rounded border border-white/5 font-mono">
              <div>Resolution: {dimensions.width} × {dimensions.height} px</div>
              <div>Frame Rate: {timeline.fps} FPS</div>
              <div>Total Frames: {timeline.totalFrames} frames</div>
            </div>

            <button
              type="button"
              onClick={handleExport}
              disabled={isExporting}
              className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded text-xs transition-colors shadow-lg flex items-center justify-center space-x-1.5 disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              <span>{isExporting ? exportProgress || 'Exporting...' : 'Start Export'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
