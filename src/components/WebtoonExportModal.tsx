import React, { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { uiStoreActions } from '../stores';
import {
  exportWebtoonChapterZip,
  exportWebtoonChapterZipFromRenderer,
  downloadWebtoonZip,
  WebtoonRegionRenderer,
} from '../utils/webtoonExporter';

interface WebtoonExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  getActiveCanvas: () => HTMLCanvasElement | null;
  createRegionRenderer?: () => { renderRegion: WebtoonRegionRenderer; dispose: () => void };
  canvasWidth: number;
  canvasHeight: number;
  documentTitle?: string;
}

export const WebtoonExportModal: React.FC<WebtoonExportModalProps> = ({
  isOpen,
  onClose,
  getActiveCanvas,
  createRegionRenderer,
  canvasWidth,
  canvasHeight,
  documentTitle = 'webtoon_chapter',
}) => {
  const [sliceHeight, setSliceHeight] = useState(1280);
  const [format, setFormat] = useState<'jpg' | 'png'>('jpg');
  const [quality, setQuality] = useState(92);
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; percent: number } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExporting) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, isExporting, onClose]);

  if (!isOpen) return null;

  const totalSlices = Math.max(1, Math.ceil(canvasHeight / sliceHeight));

  const handleStartExport = async () => {
    try {
      setIsExporting(true);
      setProgress({ current: 0, total: totalSlices, percent: 0 });

      let zipBytes: Uint8Array;
      if (createRegionRenderer) {
        const renderer = createRegionRenderer();
        try {
          zipBytes = await exportWebtoonChapterZipFromRenderer(
            canvasWidth,
            canvasHeight,
            renderer.renderRegion,
            {
              sliceWidth: canvasWidth,
              sliceHeight,
              format,
              quality: quality / 100,
              filePrefix: `${documentTitle.replace(/\s+/g, '_')}_slice_`,
              onProgress: (p) => setProgress(p),
            }
          );
        } finally {
          renderer.dispose();
        }
      } else {
        const canvas = getActiveCanvas();
        if (!canvas) {
          setIsExporting(false);
          setProgress(null);
          return;
        }
        zipBytes = await exportWebtoonChapterZip(canvas, {
          sliceWidth: canvasWidth,
          sliceHeight,
          format,
          quality: quality / 100,
          filePrefix: `${documentTitle.replace(/\s+/g, '_')}_slice_`,
          onProgress: (p) => setProgress(p),
        });
      }

      const zipName = `${documentTitle.replace(/\s+/g, '_')}_slices.zip`;
      downloadWebtoonZip(zipBytes, zipName);
      setIsExporting(false);
      setProgress(null);
      onClose();
    } catch (err) {
      console.error('Webtoon export error:', err);
      setIsExporting(false);
      setProgress(null);
      void uiStoreActions.alertDialog({
        title: 'Webtoon Export Failed',
        message: 'Failed to export webtoon slices.',
        detail: err instanceof Error ? err.message : undefined,
      });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="webtoon-export-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 select-none"
      onClick={() => {
        if (!isExporting) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[460px] max-w-[95vw] bg-[#202020] border border-[#2c2c2c] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.85)] overflow-hidden flex flex-col text-[#e5e5e5] font-sans"
      >
        {/* Header */}
        <div className="h-9 px-3.5 bg-[#161616] border-b border-[#2c2c2c] flex items-center justify-between">
          <h2 id="webtoon-export-modal-title" className="text-xs font-medium text-[#e5e5e5]">
            Webtoon Chapter Slicer
          </h2>
          {!isExporting && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Cancel (Esc)"
              className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 text-xs">
          <div className="bg-[#161616] p-3 rounded-md border border-[#2c2c2c] space-y-1">
            <div className="flex justify-between">
              <span className="text-[#8a8a8a]">Canvas Dimensions</span>
              <span className="font-mono text-[#e5e5e5]">{canvasWidth} × {canvasHeight} px</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#8a8a8a]">Total Slices</span>
              <span className="font-mono text-[var(--accent)] font-medium">{totalSlices} tiles</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#8a8a8a]">Tile Dimensions</span>
              <span className="font-mono text-[#e5e5e5]">{canvasWidth} × {sliceHeight} px</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between">
              <label className="text-[11px] text-[#8a8a8a]">Slice Tile Height</label>
              <span className="font-mono text-[#e5e5e5]">{sliceHeight}px</span>
            </div>
            <div className="flex gap-1.5">
              {[800, 1024, 1280, 1920].map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setSliceHeight(h)}
                  className={`flex-1 py-1 rounded text-xs border cursor-pointer transition-colors ${
                    sliceHeight === h
                      ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border-[var(--accent-border)] font-medium'
                      : 'bg-[#161616] border-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                  }`}
                >
                  {h}px
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] text-[#8a8a8a]">Output Format</label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setFormat('jpg')}
                className={`py-1.5 rounded text-xs border cursor-pointer transition-colors ${
                  format === 'jpg'
                    ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border-[var(--accent-border)] font-medium'
                    : 'bg-[#161616] border-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                }`}
              >
                JPEG (Standard)
              </button>
              <button
                type="button"
                onClick={() => setFormat('png')}
                className={`py-1.5 rounded text-xs border cursor-pointer transition-colors ${
                  format === 'png'
                    ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border-[var(--accent-border)] font-medium'
                    : 'bg-[#161616] border-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                }`}
              >
                PNG (Lossless)
              </button>
            </div>
          </div>

          {format === 'jpg' && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#8a8a8a]">JPEG Quality</span>
                <span className="font-mono text-[#e5e5e5]">{quality}%</span>
              </div>
              <input
                type="range"
                min={50}
                max={100}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                className="w-full"
              />
            </div>
          )}

          {isExporting && progress && (
            <div className="space-y-2 pt-2 border-t border-[#2c2c2c]">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#e5e5e5] flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
                  <span>Slicing tile {progress.current} of {progress.total}...</span>
                </span>
                <span className="font-mono text-[#e5e5e5]">{progress.percent}%</span>
              </div>
              <div className="w-full bg-[#161616] h-1.5 rounded-full overflow-hidden border border-[#2c2c2c]">
                <div
                  className="bg-[var(--accent)] h-full transition-all duration-150"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-[#161616] border-t border-[#2c2c2c] flex items-center justify-end gap-2">
          {!isExporting && (
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 bg-[#2a2a2a] hover:bg-[#363636] text-[#e5e5e5] rounded text-xs font-medium transition-colors cursor-pointer"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={handleStartExport}
            disabled={isExporting}
            className="px-3.5 py-1.5 rounded text-xs font-medium bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isExporting ? 'Packaging ZIP...' : `Export ${totalSlices} Tiles (.ZIP)`}
          </button>
        </div>
      </div>
    </div>
  );
};
