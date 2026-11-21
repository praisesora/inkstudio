import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Trash2,
  ChevronLeft,
  ChevronRight,
  X,
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

  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const playTimerRef = useRef<number | null>(null);
  const timelineRef = useRef<TimelineData>(timeline);
  timelineRef.current = timeline;
  const onChangeTimelineRef = useRef(onChangeTimeline);
  onChangeTimelineRef.current = onChangeTimeline;

  // Playback timer loop
  useEffect(() => {
    if (!isPlaying) {
      if (playTimerRef.current !== null) {
        clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
      return;
    }

    const intervalMs = Math.max(10, Math.round(1000 / Math.max(1, timeline.fps)));
    playTimerRef.current = window.setInterval(() => {
      const curr = timelineRef.current;
      const nextFrame =
        curr.currentFrame + 1 >= curr.totalFrames
          ? curr.loop
            ? 0
            : curr.totalFrames - 1
          : curr.currentFrame + 1;

      onChangeTimelineRef.current({
        ...curr,
        currentFrame: nextFrame,
      });

      if (!curr.loop && curr.currentFrame + 1 >= curr.totalFrames) {
        setIsPlaying(false);
      }
    }, intervalMs);

    return () => {
      if (playTimerRef.current !== null) {
        clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [isPlaying, timeline.fps]);

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

  // Keyboard navigation shortcuts (Alt+Space anywhere, or Space when timeline has focus, avoiding canvas Space-pan collision)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable ||
        document.querySelector('[role="dialog"]')
      ) {
        return;
      }

      if (e.code === 'Space') {
        if (e.repeat || e.ctrlKey || e.metaKey) return;
        const isTimelineFocused = Boolean(
          timelineRootRef.current && document.activeElement && timelineRootRef.current.contains(document.activeElement)
        );
        if (e.altKey || isTimelineFocused) {
          e.preventDefault();
          setIsPlaying((p) => !p);
        }
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

      if (e.code === 'ArrowLeft') {
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
    <div
      ref={timelineRootRef}
      tabIndex={-1}
      className="absolute inset-x-0 bottom-0 z-40 bg-[#202020]/95 backdrop-blur-md border-t border-white/[0.08] shadow-2xl flex flex-col select-none text-xs text-[#e5e5e5] outline-none"
    >
      {/* 1. Header & Transport Controls Dock */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/[0.06] bg-[#1a1a1a]">
        {/* Playback Transport */}
        <div className="flex items-center space-x-1.5">
          <button
            type="button"
            onClick={() => onChangeTimeline({ ...timeline, currentFrame: 0 })}
            className="p-1 hover:bg-[#2c2c2c] rounded text-[#8a8a8a] hover:text-[#e5e5e5] transition-colors cursor-pointer"
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
            className="p-1 hover:bg-[#2c2c2c] rounded text-[#8a8a8a] hover:text-[#e5e5e5] transition-colors cursor-pointer"
            title="Previous Frame (Left Arrow)"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setIsPlaying(!isPlaying)}
            className={`py-1 px-2.5 rounded font-medium flex items-center space-x-1.5 transition-colors cursor-pointer ${
              isPlaying
                ? 'bg-[#2c2c2c] text-[var(--accent)] ring-1 ring-[var(--accent-border)]'
                : 'bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90'
            }`}
            title="Play / Pause (Alt+Space)"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span className="text-[11px] font-medium">{isPlaying ? 'Pause' : 'Play'}</span>
          </button>
          <button
            type="button"
            onClick={() =>
              onChangeTimeline({
                ...timeline,
                currentFrame: Math.min(timeline.totalFrames - 1, timeline.currentFrame + 1),
              })
            }
            className="p-1 hover:bg-[#2c2c2c] rounded text-[#8a8a8a] hover:text-[#e5e5e5] transition-colors cursor-pointer"
            title="Next Frame (Right Arrow)"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          {/* Loop Toggle */}
          <button
            type="button"
            onClick={() => onChangeTimeline({ ...timeline, loop: !timeline.loop })}
            className={`px-2 py-1 rounded text-[11px] transition-colors cursor-pointer ${
              timeline.loop
                ? 'bg-[var(--accent-subtle)] text-[var(--accent)] ring-1 ring-[var(--accent-border)]'
                : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
            }`}
            title="Loop Playback"
          >
            Loop
          </button>

          {/* Frame Rate FPS Selector */}
          <div className="flex items-center space-x-1 bg-[#161616] rounded px-2 py-0.5 border border-white/[0.06]">
            <span className="text-[10px] text-[#8a8a8a] font-mono">FPS</span>
            <select
              value={timeline.fps}
              onChange={(e) =>
                onChangeTimeline({
                  ...timeline,
                  fps: parseInt(e.target.value, 10),
                })
              }
              className="bg-transparent text-[#e5e5e5] font-mono text-[11px] outline-none cursor-pointer"
            >
              {[6, 8, 12, 16, 24, 30, 60].map((rate) => (
                <option key={rate} value={rate} className="bg-[#202020] text-[#e5e5e5]">
                  {rate} fps
                </option>
              ))}
            </select>
          </div>

          {/* Frame Ticker Counter */}
          <div className="font-mono text-[#e5e5e5] bg-[#161616] px-2.5 py-0.5 rounded border border-white/[0.06] text-[11px] tracking-wider">
            {String(timeline.currentFrame + 1).padStart(3, '0')} / {String(timeline.totalFrames).padStart(3, '0')}
          </div>
        </div>

        {/* Cel & Onion Skin Tools */}
        <div className="flex items-center space-x-1.5">
          {/* Add Cel Button */}
          <button
            type="button"
            onClick={() => onAddCel(timeline.currentFrame)}
            className="px-2.5 py-1 bg-[#2c2c2c] hover:bg-[#383838] text-[#e5e5e5] rounded text-[11px] font-medium transition-colors cursor-pointer"
            title="Add Cel for Current Frame"
          >
            + Add Cel
          </button>

          {/* Delete Cel Button */}
          {currentCelId && (
            <button
              type="button"
              onClick={() => onDeleteCel(timeline.currentFrame)}
              className="p-1 hover:bg-[#2c2c2c] text-[#8a8a8a] hover:text-rose-400 rounded transition-colors cursor-pointer"
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
              className={`px-2.5 py-1 rounded text-[11px] transition-colors cursor-pointer ${
                timeline.onionSkin.enabled
                  ? 'bg-[var(--accent-subtle)] text-[var(--accent)] ring-1 ring-[var(--accent-border)]'
                  : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
              }`}
              title="Configure Colored Onion Skinning"
            >
              Onion Skin
            </button>

            {showOnionSettings && (
              <div className="absolute bottom-full mb-2 right-0 bg-[#202020] border border-white/[0.1] rounded-lg p-3 shadow-2xl z-50 flex flex-col space-y-2.5 w-64">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-[#e5e5e5] text-xs">Onion Skin</span>
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
                    />
                    <span className="text-[10px] text-[#8a8a8a]">Enabled</span>
                  </label>
                </div>

                {/* Prior Frames Settings */}
                <div className="flex items-center justify-between text-[11px] text-[#cccccc]">
                  <span>Prior Frames ({timeline.onionSkin.prevFrames})</span>
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
                      className="w-16"
                    />
                  </div>
                </div>

                {/* Next Frames Settings */}
                <div className="flex items-center justify-between text-[11px] text-[#cccccc]">
                  <span>Next Frames ({timeline.onionSkin.nextFrames})</span>
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
                      className="w-16"
                    />
                  </div>
                </div>

                {/* Base Opacity */}
                <div className="flex items-center justify-between text-[11px] text-[#cccccc]">
                  <span>Opacity</span>
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
                      className="w-24"
                    />
                    <span className="font-mono text-[10px] w-7 text-right text-[#8a8a8a]">
                      {Math.round(timeline.onionSkin.opacity * 100)}%
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Total Frames Adjuster */}
          <div className="flex items-center space-x-1 bg-[#161616] rounded px-1.5 py-0.5 border border-white/[0.06]">
            <span className="text-[10px] text-[#8a8a8a]">Total</span>
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
              className="w-10 bg-transparent font-mono text-[#e5e5e5] text-center text-[11px] outline-none"
            />
          </div>

          {/* Export Video Modal Button */}
          <button
            type="button"
            onClick={() => setShowExportModal(true)}
            className="px-2.5 py-1 bg-[#2c2c2c] hover:bg-[#383838] text-[#e5e5e5] rounded text-[11px] font-medium transition-colors cursor-pointer"
            title="Export Animation"
          >
            Export
          </button>

          {/* Close Timeline */}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
              title="Close Timeline Dock"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 2. Interactive Scrubber Timeline Track */}
      <div className="px-3 py-2 flex flex-col space-y-1 bg-[#161616]">
        {/* Frame Ruler Numbers */}
        <div
          ref={scrubberRef}
          onPointerDown={handlePointerDown}
          className="relative h-14 bg-[#1a1a1a] rounded border border-white/[0.08] cursor-pointer overflow-hidden flex flex-col justify-between"
        >
          {/* Top Frame Tick Ruler */}
          <div className="relative h-5 border-b border-white/[0.06] bg-[#202020] flex items-center">
            {Array.from({ length: timeline.totalFrames }).map((_, f) => (
              <div
                key={f}
                style={{
                  width: `${100 / timeline.totalFrames}%`,
                }}
                className={`h-full border-r border-white/[0.05] flex items-center justify-center text-[9px] font-mono select-none ${
                  f % 5 === 0 ? 'text-[#cccccc] font-semibold' : 'text-[#666666] text-[8px]'
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
                  className={`h-full border-r border-white/[0.04] flex items-center justify-center p-0.5 transition-colors ${
                    isCurrent ? 'bg-[var(--accent-subtle)]' : ''
                  }`}
                >
                  {hasCel ? (
                    <div
                      className={`w-full h-5 rounded-[2px] flex items-center justify-center text-[9px] font-mono font-medium truncate ${
                        isCurrent
                          ? 'bg-[var(--accent)] text-[var(--accent-contrast)] font-semibold'
                          : 'bg-[#2c2c2c] text-[#cccccc] hover:bg-[#383838]'
                      }`}
                      title={`Frame ${f + 1}: Cel Assigned`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-current" />
                    </div>
                  ) : (
                    <div className="w-1 h-1 rounded-full bg-white/15" />
                  )}
                </div>
              );
            })}
          </div>

          {/* Scrub Playhead Line */}
          <div
            className="absolute top-0 bottom-0 pointer-events-none z-20 transition-all duration-75 flex flex-col items-center"
            style={{
              left: `${((timeline.currentFrame + 0.5) / timeline.totalFrames) * 100}%`,
              transform: 'translateX(-50%)',
            }}
          >
            <div className="w-2.5 h-1.5 bg-red-500 rounded-b" />
            <div className="w-[1.5px] h-full bg-red-500" />
          </div>
        </div>

        {/* Cel Info Bar */}
        <div className="flex items-center justify-between text-[10px] text-[#8a8a8a] px-1">
          <div className="flex items-center space-x-2">
            <span>
              Active Cel:{' '}
              {currentCelLayer ? (
                <span className="text-[var(--accent)] font-medium font-mono">{currentCelLayer.name}</span>
              ) : (
                <span className="text-[#666666] italic">None (Drawing creates new frame cel)</span>
              )}
            </span>
          </div>
          <div className="flex items-center space-x-3 text-[#666666]">
            <span>Drag scrubber to navigate</span>
            <span>·</span>
            <span>Alt+Space: Play/Pause</span>
            <span>·</span>
            <span>← / →: Step frame</span>
          </div>
        </div>
      </div>

      {/* 3. Export Modal */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 bg-black/65 backdrop-blur-xs flex items-center justify-center">
          <div className="bg-[#202020] border border-white/[0.1] rounded-lg p-4 shadow-2xl w-80 flex flex-col space-y-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[#e5e5e5]">Export Animation</span>
              <button
                type="button"
                onClick={() => setShowExportModal(false)}
                className="p-1 text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex flex-col space-y-1.5">
              <label className="text-[11px] text-[#8a8a8a]">Format</label>
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                {(
                  [
                    ['gif', 'Animated GIF'],
                    ['apng', 'Animated PNG'],
                    ['webm', 'WebM Video'],
                    ['png-zip', 'PNG Sequence (.zip)'],
                  ] as Array<[AnimationExportFormat, string]>
                ).map(([fmt, label]) => (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => setExportFormat(fmt)}
                    className={`py-1.5 px-2.5 rounded text-left border transition-colors cursor-pointer ${
                      exportFormat === fmt
                        ? 'bg-[var(--accent-subtle)] border-[var(--accent-border)] text-[var(--accent)] font-medium'
                        : 'bg-[#161616] border-white/[0.06] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="text-[11px] text-[#8a8a8a] space-y-1 bg-[#161616] p-2.5 rounded border border-white/[0.06] font-mono">
              <div>Resolution: {dimensions.width} × {dimensions.height} px</div>
              <div>Frame Rate: {timeline.fps} FPS</div>
              <div>Total Frames: {timeline.totalFrames}</div>
            </div>

            <button
              type="button"
              onClick={handleExport}
              disabled={isExporting}
              className="w-full py-1.5 bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 font-medium rounded text-xs transition-opacity disabled:opacity-50 cursor-pointer"
            >
              {isExporting ? exportProgress || 'Exporting...' : 'Start Export'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
