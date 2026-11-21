import React, { useRef, useCallback, useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { LTConversionSettings } from '../types/editor';

export type Csp3DToolMode =
  | 'camera-orbit'
  | 'camera-pan'
  | 'camera-zoom'
  | 'model-move'
  | 'model-rotate-free'
  | 'model-rotate-yaw'
  | 'model-rotate-roll'
  | 'model-plane-move';

interface Csp3DToolbarProps {
  activeMode: Csp3DToolMode;
  onSelectMode: (mode: Csp3DToolMode) => void;
  onDirectDrag: (mode: Csp3DToolMode, deltaX: number, deltaY: number, e: PointerEvent) => void;
  onExtractLineAndTone?: (settings: LTConversionSettings) => void;
  isExtracting?: boolean;
  hasModel?: boolean;
  modelName?: string;
}

const CAMERA_MODES: Array<{ mode: Csp3DToolMode; label: string; title: string }> = [
  { mode: 'camera-orbit', label: 'Orbit', title: 'Orbit camera around model (click or drag)' },
  { mode: 'camera-pan', label: 'Pan', title: 'Pan camera in screen plane (click or drag)' },
  { mode: 'camera-zoom', label: 'Zoom', title: 'Zoom camera distance (click or drag)' },
];

const MODEL_MODES: Array<{ mode: Csp3DToolMode; label: string; title: string }> = [
  { mode: 'model-move', label: 'Move', title: 'Move model in view plane (click or drag)' },
  { mode: 'model-rotate-free', label: 'Rotate', title: 'Rotate model freely (click or drag)' },
  { mode: 'model-plane-move', label: 'Floor', title: 'Slide model along floor plane (click or drag)' },
];

export const Csp3DToolbar: React.FC<Csp3DToolbarProps> = ({
  activeMode,
  onSelectMode,
  onDirectDrag,
  onExtractLineAndTone,
  isExtracting = false,
  hasModel = false,
  modelName = 'Model',
}) => {
  const [showLTDialog, setShowLTDialog] = useState(false);
  const [lineWidth, setLineWidth] = useState(1);
  const [lineThreshold, setLineThreshold] = useState(0.28);
  const [toneCount, setToneCount] = useState<number>(2);
  const [folderName, setFolderName] = useState('');

  const cleanModelName = (modelName || 'Model').replace(/\.[^/.]+$/, '').trim();
  const defaultFolderName = `3D Extraction [${cleanModelName}]`;

  useEffect(() => {
    setFolderName(defaultFolderName);
  }, [defaultFolderName]);

  const dragRef = useRef<{
    mode: Csp3DToolMode;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    hasDragged: boolean;
  } | null>(null);

  const handlePointerDown = useCallback(
    (mode: Csp3DToolMode, e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();

      const target = e.currentTarget;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      dragRef.current = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        hasDragged: false,
      };

      const handlePointerMove = (ev: PointerEvent) => {
        if (!dragRef.current) return;
        const dx = ev.clientX - dragRef.current.lastX;
        const dy = ev.clientY - dragRef.current.lastY;

        if (
          Math.hypot(ev.clientX - dragRef.current.startX, ev.clientY - dragRef.current.startY) > 3
        ) {
          dragRef.current.hasDragged = true;
        }

        dragRef.current.lastX = ev.clientX;
        dragRef.current.lastY = ev.clientY;

        if (dx !== 0 || dy !== 0) {
          onDirectDrag(mode, dx, dy, ev);
        }
      };

      const handlePointerUp = (ev: PointerEvent) => {
        try {
          target.releasePointerCapture(ev.pointerId);
        } catch {
          // ignore
        }
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);

        if (dragRef.current && !dragRef.current.hasDragged) {
          onSelectMode(mode);
        }
        dragRef.current = null;
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', handlePointerUp);
    },
    [onDirectDrag, onSelectMode]
  );

  return (
    <div
      className="flex items-center gap-1.5 select-none"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Camera Mode Group */}
      <div className="flex items-center bg-[#161616] rounded p-0.5 border border-white/[0.06]">
        <span className="px-1.5 text-[10px] text-[#666666] font-medium">Cam</span>
        {CAMERA_MODES.map((item) => (
          <button
            key={item.mode}
            type="button"
            onPointerDown={(e) => handlePointerDown(item.mode, e)}
            title={item.title}
            className={`px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer ${
              activeMode === item.mode
                ? 'bg-[var(--accent)] text-[var(--accent-contrast)] font-medium'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Model Mode Group */}
      <div className="flex items-center bg-[#161616] rounded p-0.5 border border-white/[0.06]">
        <span className="px-1.5 text-[10px] text-[#666666] font-medium">Obj</span>
        {MODEL_MODES.map((item) => (
          <button
            key={item.mode}
            type="button"
            onPointerDown={(e) => handlePointerDown(item.mode, e)}
            title={item.title}
            className={`px-2 py-0.5 rounded text-[11px] transition-colors cursor-pointer ${
              activeMode === item.mode
                ? 'bg-[var(--accent)] text-[var(--accent-contrast)] font-medium'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Unified Line & Tone (LT Conversion) Popover */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setShowLTDialog((prev) => !prev)}
          disabled={isExtracting || !hasModel}
          title="Extract Lineart and Screentones from 3D Model"
          className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
            showLTDialog
              ? 'bg-[var(--accent-subtle)] text-[var(--accent)] ring-1 ring-[var(--accent-border)]'
              : 'bg-[#2c2c2c] text-[#e5e5e5] hover:bg-[#383838]'
          }`}
        >
          Line & Tone
        </button>

        {showLTDialog && (
          <div
            className="absolute top-full mt-2 right-0 w-72 bg-[#202020] border border-white/[0.1] rounded-lg p-3.5 shadow-2xl z-50 text-[#e5e5e5] select-none"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
              <span className="text-xs font-medium text-[#e5e5e5]">Line & Tone Extraction</span>
              <button
                type="button"
                onClick={() => setShowLTDialog(false)}
                className="text-[#8a8a8a] hover:text-[#e5e5e5] p-0.5 rounded hover:bg-[#2c2c2c] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="mt-3 space-y-2.5">
              <div className="space-y-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-[#8a8a8a]">Line Width</span>
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
                  <span className="text-[#8a8a8a]">Edge Sensitivity</span>
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
            </div>

            <div className="mt-3 space-y-1.5">
              <div className="flex justify-between text-[11px]">
                <span className="text-[#8a8a8a]">Screentone Bands</span>
                <span className="text-[10px] text-[#666666] font-mono">60 LPI</span>
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

            <div className="mt-3 space-y-1">
              <label className="text-[11px] text-[#8a8a8a] block">Output Folder</label>
              <input
                type="text"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder={defaultFolderName}
                className="w-full px-2 py-1 text-xs bg-[#161616] border border-white/[0.08] rounded text-[#e5e5e5] font-mono"
              />
            </div>

            <div className="mt-3.5 flex items-center space-x-2">
              <button
                type="button"
                onClick={() => setShowLTDialog(false)}
                className="flex-1 py-1.5 rounded text-xs text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isExtracting}
                onClick={() => {
                  onExtractLineAndTone?.({
                    lineWidth,
                    lineThreshold,
                    toneCount,
                    folderName: folderName.trim() || defaultFolderName,
                  });
                  setShowLTDialog(false);
                }}
                className="flex-1 py-1.5 bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 font-medium rounded text-xs transition-opacity disabled:opacity-50 cursor-pointer"
              >
                {isExtracting ? 'Extracting...' : 'Extract'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
