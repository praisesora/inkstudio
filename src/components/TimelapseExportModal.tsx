import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  Film,
  Circle,
  Square,
  Download,
  Trash2,
  Play,
  Pause,
  Loader2,
} from 'lucide-react';
import {
  globalTimelapseManager,
  TimelapseAspectRatio,
  TimelapseDurationPreset,
  TimelapseResolution,
} from '../utils/timelapseEngine';
import { downloadFile } from '../utils/saveManager';

interface TimelapseExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  documentId: string | null;
  documentName: string;
  onCaptureNow?: () => void;
  showToast?: (msg: string) => void;
}

export const TimelapseExportModal: React.FC<TimelapseExportModalProps> = ({
  isOpen,
  onClose,
  documentId,
  documentName,
  onCaptureNow,
  showToast,
}) => {
  const [duration, setDuration] = useState<TimelapseDurationPreset>('30s');
  const [aspectRatio, setAspectRatio] = useState<TimelapseAspectRatio>('original');
  const [resolution, setResolution] = useState<TimelapseResolution>('1080p');
  const [backgroundColor, setBackgroundColor] = useState<'#ffffff' | '#141414'>('#ffffff');
  const [preferFfmpeg, setPreferFfmpeg] = useState(false);
  const [ffmpegAvailable, setFfmpegAvailable] = useState(false);

  const [stats, setStats] = useState(() => globalTimelapseManager.getStats(documentId));
  const [previewIdx, setPreviewIdx] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const previewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setStats(globalTimelapseManager.getStats(documentId));
    globalTimelapseManager.checkFfmpegAvailable().then((ok) => {
      setFfmpegAvailable(ok);
      if (ok) setPreferFfmpeg(true);
    });
    const unsub = globalTimelapseManager.subscribe(() => {
      setStats(globalTimelapseManager.getStats(documentId));
    });
    return () => {
      unsub();
      setIsPlayingPreview(false);
    };
  }, [isOpen, documentId]);

  // Load current preview frame blob
  useEffect(() => {
    if (!isOpen || !documentId) return;
    const frames = globalTimelapseManager.getFrames(documentId);
    if (frames.length === 0) {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
      setPreviewUrl(null);
      return;
    }

    const clampedIdx = Math.max(0, Math.min(frames.length - 1, previewIdx));
    let cancelled = false;
    globalTimelapseManager.loadFrameBlob(documentId, frames[clampedIdx]).then((blob) => {
      if (cancelled || !blob) return;
      const nextUrl = URL.createObjectURL(blob);
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = nextUrl;
      setPreviewUrl(nextUrl);
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, documentId, previewIdx, stats.frameCount]);

  // Cleanup preview object URL on unmount
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
      }
    };
  }, []);

  // Playback preview timer
  useEffect(() => {
    if (!isPlayingPreview || stats.frameCount <= 1) return;
    const timer = window.setInterval(() => {
      setPreviewIdx((prev) => (prev + 1) % stats.frameCount);
    }, 100);
    return () => window.clearInterval(timer);
  }, [isPlayingPreview, stats.frameCount]);

  if (!isOpen) return null;

  const handleToggleRecording = () => {
    if (!documentId) return;
    const next = globalTimelapseManager.toggleRecording(documentId);
    if (next) {
      onCaptureNow?.();
      showToast?.('Time-lapse recording enabled');
    } else {
      showToast?.('Time-lapse recording paused');
    }
  };

  const handleClear = async () => {
    if (!documentId) return;
    setIsPlayingPreview(false);
    await globalTimelapseManager.clearSession(documentId);
    setPreviewIdx(0);
    showToast?.('Time-lapse frames cleared');
  };

  const handleExport = async () => {
    if (!documentId) return;
    setIsExporting(true);
    setExportProgress(0);
    setErrorMsg(null);
    setIsPlayingPreview(false);
    try {
      const result = await globalTimelapseManager.exportVideo(
        documentId,
        {
          duration,
          aspectRatio,
          resolution,
          fps: 30,
          backgroundColor,
          preferFfmpeg,
        },
        (p) => setExportProgress(p)
      );
      const safeName =
        (documentName || 'timelapse').replace(/[^a-zA-Z0-9_\- ]/g, '_').trim() || 'timelapse';
      downloadFile(
        result.blob,
        `${safeName}_timelapse_${duration}${result.extension}`,
        result.mimeType
      );
      showToast?.(`Exported ${result.durationSec.toFixed(1)}s time-lapse (${result.extension})`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Time-lapse export failed');
    } finally {
      setIsExporting(false);
    }
  };

  const memMb = (stats.memoryBytes / (1024 * 1024)).toFixed(2);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 select-none">
      <div className="w-[540px] max-w-[95vw] bg-[#202020] border border-white/10 rounded-lg shadow-2xl overflow-hidden text-xs text-[#e5e5e5]">
        {/* Header */}
        <div className="px-4 py-3 bg-[#181818] border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <Film className="w-4 h-4 text-[var(--accent)]" />
            <span>Time-lapse Recording & Export</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="text-[#8a8a8a] hover:text-white cursor-pointer disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Status & Record Toggle */}
          <div className="flex items-center justify-between bg-[#161616] rounded-md px-3 py-2.5 border border-white/[0.06]">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2 font-medium">
                <span
                  className={`w-2 h-2 rounded-full ${
                    stats.enabled ? 'bg-rose-500 animate-pulse' : 'bg-[#555555]'
                  }`}
                />
                <span>{stats.enabled ? 'Recording Keyframes' : 'Recording Paused'}</span>
              </div>
              <div className="text-[10px] text-[#8a8a8a] font-mono">
                {stats.frameCount} keyframes · {memMb} MB RAM
                {stats.diskFrames > 0 ? ` · ${stats.diskFrames} offloaded to scratch disk` : ''}
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={!documentId || isExporting}
                onClick={handleToggleRecording}
                className={`px-2.5 py-1.5 rounded text-[11px] font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-40 ${
                  stats.enabled
                    ? 'bg-rose-600 hover:bg-rose-500 text-white'
                    : 'bg-[#2c2c2c] hover:bg-[#383838] text-[#e5e5e5]'
                }`}
              >
                {stats.enabled ? (
                  <>
                    <Square className="w-3 h-3 fill-current" />
                    <span>Pause</span>
                  </>
                ) : (
                  <>
                    <Circle className="w-3 h-3 text-rose-500 fill-rose-500" />
                    <span>Record</span>
                  </>
                )}
              </button>

              <button
                type="button"
                disabled={!documentId || stats.frameCount === 0 || isExporting}
                onClick={handleClear}
                title="Clear recorded keyframes"
                className="p-1.5 rounded bg-[#2c2c2c] hover:bg-rose-500/20 text-[#8a8a8a] hover:text-rose-400 cursor-pointer disabled:opacity-35"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Preview Player */}
          <div className="bg-[#121212] rounded-md border border-white/[0.06] p-2 space-y-2">
            <div className="h-44 flex items-center justify-center overflow-hidden rounded bg-[#0c0c0c]">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Time-lapse keyframe preview"
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <div className="text-[11px] text-[#777777] text-center px-4">
                  Enable Record and draw strokes to capture time-lapse keyframes automatically.
                </div>
              )}
            </div>

            {stats.frameCount > 0 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsPlayingPreview((p) => !p)}
                  className="p-1 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[#e5e5e5] cursor-pointer"
                >
                  {isPlayingPreview ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, stats.frameCount - 1)}
                  value={Math.min(previewIdx, Math.max(0, stats.frameCount - 1))}
                  onChange={(e) => setPreviewIdx(Number(e.target.value))}
                  className="flex-1"
                />
                <span className="text-[10px] font-mono text-[#8a8a8a] w-14 text-right">
                  {Math.min(previewIdx + 1, stats.frameCount)} / {stats.frameCount}
                </span>
              </div>
            )}
          </div>

          {/* Export Settings Grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[11px] text-[#8a8a8a] block">Length</label>
              <div className="grid grid-cols-4 gap-1 bg-[#161616] p-0.5 rounded">
                {(['15s', '30s', '60s', 'full'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDuration(d)}
                    className={`py-1 rounded text-[10px] uppercase cursor-pointer ${
                      duration === d
                        ? 'bg-[#2c2c2c] text-white font-semibold'
                        : 'text-[#8a8a8a] hover:text-white'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] text-[#8a8a8a] block">Aspect Ratio</label>
              <div className="grid grid-cols-4 gap-1 bg-[#161616] p-0.5 rounded">
                {(['original', '16:9', '9:16', '1:1'] as const).map((ar) => (
                  <button
                    key={ar}
                    type="button"
                    onClick={() => setAspectRatio(ar)}
                    className={`py-1 rounded text-[10px] cursor-pointer ${
                      aspectRatio === ar
                        ? 'bg-[#2c2c2c] text-white font-semibold'
                        : 'text-[#8a8a8a] hover:text-white'
                    }`}
                  >
                    {ar === 'original' ? 'Orig' : ar}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] text-[#8a8a8a] block">Resolution</label>
              <div className="grid grid-cols-2 gap-1 bg-[#161616] p-0.5 rounded">
                {(['720p', '1080p'] as const).map((res) => (
                  <button
                    key={res}
                    type="button"
                    onClick={() => setResolution(res)}
                    className={`py-1 rounded text-[10px] cursor-pointer ${
                      resolution === res
                        ? 'bg-[#2c2c2c] text-white font-semibold'
                        : 'text-[#8a8a8a] hover:text-white'
                    }`}
                  >
                    {res}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[11px] text-[#8a8a8a] block">Letterbox Background</label>
              <div className="grid grid-cols-2 gap-1 bg-[#161616] p-0.5 rounded">
                <button
                  type="button"
                  onClick={() => setBackgroundColor('#ffffff')}
                  className={`py-1 rounded text-[10px] cursor-pointer ${
                    backgroundColor === '#ffffff'
                      ? 'bg-[#2c2c2c] text-white font-semibold'
                      : 'text-[#8a8a8a] hover:text-white'
                  }`}
                >
                  White
                </button>
                <button
                  type="button"
                  onClick={() => setBackgroundColor('#141414')}
                  className={`py-1 rounded text-[10px] cursor-pointer ${
                    backgroundColor === '#141414'
                      ? 'bg-[#2c2c2c] text-white font-semibold'
                      : 'text-[#8a8a8a] hover:text-white'
                  }`}
                >
                  Dark
                </button>
              </div>
            </div>
          </div>

          {ffmpegAvailable && (
            <label className="flex items-center justify-between bg-[#161616] px-3 py-2 rounded text-[11px] cursor-pointer">
              <span>Use native FFmpeg encoder (.mp4)</span>
              <input
                type="checkbox"
                checked={preferFfmpeg}
                onChange={(e) => setPreferFfmpeg(e.target.checked)}
              />
            </label>
          )}

          {isExporting && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-[#8a8a8a]">
                <span>Rendering video frames...</span>
                <span className="font-mono">{Math.round(exportProgress * 100)}%</span>
              </div>
              <div className="w-full h-1.5 bg-[#161616] rounded overflow-hidden">
                <div
                  className="h-full bg-[var(--accent)] transition-all duration-100"
                  style={{ width: `${Math.round(exportProgress * 100)}%` }}
                />
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-2">
              {errorMsg}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 bg-[#181818] border-t border-white/10 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="px-3 py-1.5 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[#cccccc] cursor-pointer disabled:opacity-40"
          >
            Close
          </button>
          <button
            type="button"
            disabled={!documentId || stats.frameCount === 0 || isExporting}
            onClick={handleExport}
            className="px-3.5 py-1.5 rounded bg-[#234b3e] hover:bg-[#2b604f] text-[#55eaab] border border-[#2e6e58] font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-40"
          >
            {isExporting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Exporting...</span>
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                <span>Export Video</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
