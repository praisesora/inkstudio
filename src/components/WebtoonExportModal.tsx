import React, { useState } from 'react';
import { X, Archive, Download, Loader2 } from 'lucide-react';
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
      alert('Failed to export webtoon slices.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs select-none">
      <div className="w-[460px] bg-[#222327] border border-[#3b3d45] rounded-lg shadow-2xl overflow-hidden flex flex-col text-[#cccccc] font-sans">
        {/* Header */}
        <div className="px-4 py-3 bg-[#1a1b1e] border-b border-[#2e3036] flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Archive className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-white">Webtoon Chapter Slicer Exporter</h2>
          </div>
          {!isExporting && (
            <button
              onClick={onClose}
              className="p-1 rounded text-[#888888] hover:text-white hover:bg-[#2b2d31] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Content */}
        <div className="p-4 space-y-4 text-xs">
          <div className="bg-[#18191c] p-3 rounded border border-[#2e3036] space-y-1">
            <div className="flex justify-between">
              <span className="text-[#888888]">Canvas Dimensions:</span>
              <span className="font-mono text-white">{canvasWidth} × {canvasHeight} px</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#888888]">Total Slices:</span>
              <span className="font-mono text-emerald-400 font-semibold">{totalSlices} sequential tiles</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#888888]">Tile Dimensions:</span>
              <span className="font-mono text-white">{canvasWidth} × {sliceHeight} px</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between">
              <label className="text-[11px] text-[#aaaaaa] font-medium">Slice Tile Height:</label>
              <span className="font-mono text-cyan-400">{sliceHeight}px</span>
            </div>
            <div className="flex space-x-2">
              {[800, 1024, 1280, 1920].map((h) => (
                <button
                  key={h}
                  onClick={() => setSliceHeight(h)}
                  className={`flex-1 py-1 rounded text-xs border cursor-pointer font-medium transition-colors ${
                    sliceHeight === h
                      ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                      : 'bg-[#18191c] border-[#33353b] text-[#888888] hover:text-white'
                  }`}
                >
                  {h}px
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] text-[#aaaaaa] font-medium">Output Format:</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setFormat('jpg')}
                className={`py-1.5 rounded text-xs border cursor-pointer font-medium transition-colors ${
                  format === 'jpg'
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-[#18191c] border-[#33353b] text-[#888888] hover:text-white'
                }`}
              >
                JPEG (Standard Webtoon)
              </button>
              <button
                onClick={() => setFormat('png')}
                className={`py-1.5 rounded text-xs border cursor-pointer font-medium transition-colors ${
                  format === 'png'
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-[#18191c] border-[#33353b] text-[#888888] hover:text-white'
                }`}
              >
                PNG (Lossless)
              </button>
            </div>
          </div>

          {format === 'jpg' && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#aaaaaa]">JPEG Compression Quality:</span>
                <span className="font-mono text-cyan-400">{quality}%</span>
              </div>
              <input
                type="range"
                min={50}
                max={100}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                className="w-full accent-cyan-400"
              />
            </div>
          )}

          {isExporting && progress && (
            <div className="space-y-2 pt-2 border-t border-[#2e3036]">
              <div className="flex justify-between text-[11px]">
                <span className="text-white flex items-center space-x-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                  <span>Slicing tile {progress.current} of {progress.total}...</span>
                </span>
                <span className="font-mono text-emerald-400">{progress.percent}%</span>
              </div>
              <div className="w-full bg-[#18191c] h-2 rounded-full overflow-hidden border border-[#33353b]">
                <div
                  className="bg-emerald-500 h-full transition-all duration-150"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 bg-[#1a1b1e] border-t border-[#2e3036] flex items-center justify-end space-x-2">
          {!isExporting && (
            <button
              onClick={onClose}
              className="px-3 py-1.5 bg-[#2b2d31] hover:bg-[#383a40] text-[#cccccc] rounded text-xs transition-colors cursor-pointer"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleStartExport}
            disabled={isExporting}
            className={`px-3.5 py-1.5 rounded text-xs font-semibold flex items-center space-x-1.5 transition-colors cursor-pointer ${
              isExporting
                ? 'bg-[#1e382d] text-[#777777] cursor-not-allowed'
                : 'bg-[#1b4e3b] hover:bg-[#23634b] text-[#55eaab] border border-[#2a7a5c]'
            }`}
          >
            <Download className="w-3.5 h-3.5" />
            <span>{isExporting ? 'Packaging ZIP...' : `Export ${totalSlices} Tiles (.ZIP)`}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
