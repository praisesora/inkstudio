import React, { useEffect, useRef, useState, useCallback } from 'react';
import { X, Loader2, Layers, Eye } from 'lucide-react';
import { LTConversionSettings } from '../types/editor';

export interface LTPreviewBuffers {
  lineCanvas: HTMLCanvasElement;
  toneCanvases: HTMLCanvasElement[];
}

export interface LTExtractionModalProps {
  isOpen: boolean;
  modelName: string;
  dimensions: { width: number; height: number };
  isExtracting: boolean;
  onRenderPreview: (settings: LTConversionSettings) => Promise<LTPreviewBuffers | null>;
  onExtract: (settings: LTConversionSettings) => void;
  onClose: () => void;
}

type PreviewLayerMode = 'combined' | 'line' | 'tone';
type PreviewBgMode = 'white' | 'checker';

export const LTExtractionModal: React.FC<LTExtractionModalProps> = ({
  isOpen,
  modelName,
  dimensions,
  isExtracting,
  onRenderPreview,
  onExtract,
  onClose,
}) => {
  const cleanModelName = (modelName || '3D Model').replace(/\.[^/.]+$/, '').trim();
  const defaultFolderName = `3D Extraction [${cleanModelName}]`;

  const [lineWidth, setLineWidth] = useState(1);
  const [lineThreshold, setLineThreshold] = useState(0.28);
  const [antiAliasing, setAntiAliasing] = useState(false);
  const [includeTones, setIncludeTones] = useState(true);
  const [toneCount, setToneCount] = useState<number>(2);
  const [toneFrequency, setToneFrequency] = useState<number>(60);
  const [folderName, setFolderName] = useState(defaultFolderName);

  const [previewLayerMode, setPreviewLayerMode] = useState<PreviewLayerMode>('combined');
  const [previewBgMode, setPreviewBgMode] = useState<PreviewBgMode>('white');
  const [isUpdatingPreview, setIsUpdatingPreview] = useState(false);

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const buffersRef = useRef<LTPreviewBuffers | null>(null);
  const renderReqIdRef = useRef<number>(0);

  useEffect(() => {
    if (isOpen) {
      setFolderName(defaultFolderName);
    }
  }, [isOpen, defaultFolderName]);

  // Escape key closes modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExtracting) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [isOpen, isExtracting, onClose]);

  const buildSettings = useCallback((): LTConversionSettings => {
    const effectiveToneCount = includeTones ? toneCount : 0;
    return {
      lineWidth,
      lineThreshold,
      toneCount: effectiveToneCount,
      toneFrequencies: Array.from({ length: effectiveToneCount }, () => toneFrequency),
      antiAliasing,
      folderName: folderName.trim() || defaultFolderName,
    };
  }, [
    includeTones,
    toneCount,
    lineWidth,
    lineThreshold,
    toneFrequency,
    antiAliasing,
    folderName,
    defaultFolderName,
  ]);

  // Composite cached line + tone preview buffers onto visible canvas
  const compositePreviewCanvas = useCallback(
    (buffers: LTPreviewBuffers | null, layerMode: PreviewLayerMode, bgMode: PreviewBgMode) => {
      const canvas = previewCanvasRef.current;
      if (!canvas || !buffers) return;
      const w = buffers.lineCanvas.width;
      const h = buffers.lineCanvas.height;
      if (w <= 0 || h <= 0) return;

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, w, h);

      if (bgMode === 'white') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
      }

      // Draw screentone bands (light -> deep) with multiply blend
      if (layerMode === 'combined' || layerMode === 'tone') {
        ctx.save();
        ctx.globalCompositeOperation = bgMode === 'white' ? 'multiply' : 'source-over';
        for (const toneCanvas of buffers.toneCanvases) {
          ctx.drawImage(toneCanvas, 0, 0, w, h);
        }
        ctx.restore();
      }

      // Draw 3D outline on top
      if (layerMode === 'combined' || layerMode === 'line') {
        ctx.drawImage(buffers.lineCanvas, 0, 0, w, h);
      }
    },
    []
  );

  // Instant re-composite when user switches preview layer/background toggles
  useEffect(() => {
    if (!isOpen) return;
    compositePreviewCanvas(buffersRef.current, previewLayerMode, previewBgMode);
  }, [isOpen, previewLayerMode, previewBgMode, compositePreviewCanvas]);

  // Debounced live WebGL Line & Tone preview generation when settings change
  useEffect(() => {
    if (!isOpen) return;
    const reqId = ++renderReqIdRef.current;
    setIsUpdatingPreview(true);

    const timer = setTimeout(async () => {
      try {
        const settings = buildSettings();
        const buffers = await onRenderPreview(settings);
        if (renderReqIdRef.current !== reqId) return;
        buffersRef.current = buffers;
        compositePreviewCanvas(buffers, previewLayerMode, previewBgMode);
      } catch (err) {
        console.warn('[LT Preview] Failed to render preview:', err);
      } finally {
        if (renderReqIdRef.current === reqId) {
          setIsUpdatingPreview(false);
        }
      }
    }, 110);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isOpen,
    lineWidth,
    lineThreshold,
    antiAliasing,
    includeTones,
    toneCount,
    toneFrequency,
    onRenderPreview,
  ]);

  if (!isOpen) return null;

  const docAspect = `${Math.max(1, dimensions.width)} × ${Math.max(1, dimensions.height)} px`;

  return (
    <div
      data-testid="lt-extraction-modal"
      className="fixed inset-0 z-[70] bg-black/65 backdrop-blur-xs flex items-center justify-center p-4 select-none"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget && !isExtracting) {
          onClose();
        }
      }}
    >
      <div
        className="w-full max-w-3xl bg-[#202020] border border-white/[0.12] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh] text-[#e5e5e5]"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-4 py-2.5 bg-[#1a1a1a] border-b border-white/[0.08] flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Layers className="w-4 h-4 text-[var(--accent)] shrink-0" />
            <span className="text-xs font-semibold tracking-wide truncate">
              Line & Tone Extraction (LT Conversion)
            </span>
            <span className="text-[10px] font-mono text-[#8a8a8a] hidden sm:inline">
              · {cleanModelName}
            </span>
          </div>
          <button
            type="button"
            disabled={isExtracting}
            onClick={onClose}
            className="p-1 rounded text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] disabled:opacity-40 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Main Content: Live Preview (Left) + Controls (Right) */}
        <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
          {/* Left Pane: Live Extraction Preview */}
          <div className="flex-1 bg-[#141414] flex flex-col min-h-[280px] border-b md:border-b-0 md:border-r border-white/[0.08]">
            {/* Preview Toolbar */}
            <div className="px-3 py-1.5 bg-[#181818] border-b border-white/[0.06] flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-1 bg-[#121212] p-0.5 rounded border border-white/[0.06]">
                {(
                  [
                    ['combined', 'Line + Tone'],
                    ['line', 'Outline'],
                    ['tone', 'Tones'],
                  ] as Array<[PreviewLayerMode, string]>
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setPreviewLayerMode(mode)}
                    className={`px-2 py-0.5 rounded text-[10px] transition-colors cursor-pointer ${
                      previewLayerMode === mode
                        ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                        : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setPreviewBgMode((prev) => (prev === 'white' ? 'checker' : 'white'))
                  }
                  title="Toggle Paper / Transparent Preview Background"
                  className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#222] hover:bg-[#2c2c2c] border border-white/[0.06] text-[10px] text-[#cccccc] cursor-pointer"
                >
                  <Eye className="w-3 h-3 text-[var(--accent)]" />
                  <span>{previewBgMode === 'white' ? 'Paper' : 'Alpha'}</span>
                </button>
                <span className="text-[10px] font-mono text-[#6e6e6e] hidden sm:inline">
                  {docAspect}
                </span>
              </div>
            </div>

            {/* Preview Viewport */}
            <div className="relative flex-1 flex items-center justify-center p-4 overflow-hidden">
              <div
                className="relative max-w-full max-h-full flex items-center justify-center rounded shadow-2xl border border-white/[0.1] overflow-hidden"
                style={
                  previewBgMode === 'checker'
                    ? {
                        backgroundImage:
                          'repeating-conic-gradient(#333 0% 25%, #444 0% 50%)',
                        backgroundSize: '14px 14px',
                      }
                    : { backgroundColor: '#ffffff' }
                }
              >
                <canvas
                  ref={previewCanvasRef}
                  className="block max-w-full max-h-[52vh] w-auto h-auto object-contain"
                />
              </div>

              {isUpdatingPreview && (
                <div className="absolute bottom-3 right-3 px-2.5 py-1 rounded-full bg-[#202020]/90 border border-white/[0.1] flex items-center gap-1.5 text-[10px] text-[#cccccc] shadow-lg">
                  <Loader2 className="w-3 h-3 animate-spin text-[var(--accent)]" />
                  <span>Updating preview...</span>
                </div>
              )}
            </div>
          </div>

          {/* Right Pane: LT Parameters */}
          <div className="w-full md:w-72 p-4 space-y-4 overflow-y-auto shrink-0 bg-[#202020]">
            {/* Line Extraction Section */}
            <div className="space-y-2.5">
              <div className="text-[10px] uppercase tracking-wider text-[#8a8a8a] font-medium">
                Line Extraction
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-[#a3a3a3]">Line Width</span>
                  <span className="font-mono text-[#e5e5e5]">{lineWidth} px</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={lineWidth}
                  onChange={(e) => setLineWidth(parseInt(e.target.value, 10))}
                  className="w-full"
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-[#a3a3a3]">Edge Sensitivity</span>
                  <span className="font-mono text-[#e5e5e5]">
                    {Math.round((1 - lineThreshold) * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0.05"
                  max="0.8"
                  step="0.01"
                  value={lineThreshold}
                  onChange={(e) => setLineThreshold(parseFloat(e.target.value))}
                  className="w-full"
                />
              </div>

              <label className="flex items-center justify-between text-[11px] text-[#cccccc] pt-0.5 cursor-pointer">
                <span>Anti-Aliasing</span>
                <input
                  type="checkbox"
                  checked={antiAliasing}
                  onChange={(e) => setAntiAliasing(e.target.checked)}
                />
              </label>
            </div>

            {/* Screentone Section */}
            <div className="space-y-2.5 pt-3 border-t border-white/[0.08]">
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-[10px] uppercase tracking-wider text-[#8a8a8a] font-medium">
                  Screentones
                </span>
                <input
                  type="checkbox"
                  checked={includeTones}
                  onChange={(e) => setIncludeTones(e.target.checked)}
                />
              </label>

              {includeTones && (
                <>
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-[#a3a3a3]">Shadow Bands</span>
                      <span className="text-[10px] text-[#8a8a8a] font-mono">
                        {toneFrequency} LPI
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-1">
                      {([1, 2, 3, 4] as const).map((count) => (
                        <button
                          key={count}
                          type="button"
                          onClick={() => setToneCount(count)}
                          className={`py-1 rounded text-[11px] transition-colors cursor-pointer ${
                            toneCount === count
                              ? 'bg-[var(--accent)] text-[var(--accent-contrast)] font-medium'
                              : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                          }`}
                        >
                          {count}
                        </button>
                      ))}
                    </div>
                    <p className="text-[10px] text-[#8a8a8a] font-mono">
                      {toneCount === 1 && 'Deep Shadow (45%)'}
                      {toneCount === 2 && 'Light (20%) + Deep (45%)'}
                      {toneCount === 3 && 'Light (15%) + Mid (30%) + Deep (50%)'}
                      {toneCount === 4 && '4-step gradation (10% - 55%)'}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-[#a3a3a3]">Frequency</span>
                      <span className="font-mono text-[#e5e5e5]">{toneFrequency} LPI</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      {([40, 60, 85] as const).map((lpi) => (
                        <button
                          key={lpi}
                          type="button"
                          onClick={() => setToneFrequency(lpi)}
                          className={`py-1 rounded text-[10px] font-mono transition-colors cursor-pointer ${
                            toneFrequency === lpi
                              ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium border border-white/[0.12]'
                              : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                          }`}
                        >
                          {lpi} LPI
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Output Folder Section */}
            <div className="space-y-1.5 pt-3 border-t border-white/[0.08]">
              <label className="text-[11px] text-[#a3a3a3] block">Output Folder</label>
              <input
                type="text"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder={defaultFolderName}
                className="w-full px-2.5 py-1.5 text-xs bg-[#161616] border border-white/[0.08] rounded text-[#e5e5e5] font-mono outline-none focus:border-[var(--accent)]"
              />
            </div>

            {/* Action Buttons */}
            <div className="pt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={isExtracting}
                onClick={onClose}
                className="flex-1 py-2 rounded text-xs text-[#a3a3a3] hover:text-[#e5e5e5] bg-[#161616] hover:bg-[#2c2c2c] border border-white/[0.06] transition-colors cursor-pointer disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isExtracting}
                onClick={() => onExtract(buildSettings())}
                className="flex-1 py-2 bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 font-medium rounded text-xs transition-opacity disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5"
              >
                {isExtracting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{isExtracting ? 'Extracting...' : 'Extract'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
