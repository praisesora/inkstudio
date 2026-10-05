import React, { useRef, useCallback, useState, useEffect } from 'react';
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
  onSnapToGround: () => void;
  onResetModelTransform: () => void;
  onExtractLineAndTone?: (settings: LTConversionSettings) => void;
  isExtracting?: boolean;
  modelName?: string;
}

export const Csp3DToolbar: React.FC<Csp3DToolbarProps> = ({
  activeMode,
  onSelectMode,
  onDirectDrag,
  onSnapToGround,
  onResetModelTransform,
  onExtractLineAndTone,
  isExtracting = false,
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
    if (!folderName) {
      setFolderName(defaultFolderName);
    }
  }, [defaultFolderName, folderName]);
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
      target.setPointerCapture(e.pointerId);

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

        if (Math.hypot(ev.clientX - dragRef.current.startX, ev.clientY - dragRef.current.startY) > 3) {
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
      className="flex items-center space-x-0.5 bg-[#1b1e24]/95 border border-[#3b82f6]/40 rounded-lg p-1 shadow-2xl backdrop-blur-md select-none text-sky-400"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 1. Camera Orbit */}
      <button
        type="button"
        onPointerDown={(e) => handlePointerDown('camera-orbit', e)}
        title="Orbit Camera: Click to select, or drag to rotate view around model"
        className={`p-1.5 rounded transition-all flex items-center justify-center ${
          activeMode === 'camera-orbit'
            ? 'bg-blue-600/30 text-sky-300 ring-1 ring-sky-400 shadow-sm'
            : 'text-sky-400/80 hover:text-sky-200 hover:bg-white/10'
        }`}
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.75">
          {/* Camera body */}
          <rect x="7" y="8" width="11" height="9" rx="1.5" stroke="currentColor" />
          <polygon points="18,10.5 22,8.5 22,16.5 18,14.5" fill="currentColor" stroke="none" />
          {/* Curved orbit arrow around camera */}
          <path d="M12 4 C6.5 4, 3 8, 3 13 C3 16.5 5 19.5 8 21" strokeLinecap="round" />
          <polyline points="5 21 8 21 8 18" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* 2. Camera Pan */}
      <button
        type="button"
        onPointerDown={(e) => handlePointerDown('camera-pan', e)}
        title="Pan Camera: Click to select, or drag to move camera in screen plane"
        className={`p-1.5 rounded transition-all flex items-center justify-center ${
          activeMode === 'camera-pan'
            ? 'bg-blue-600/30 text-sky-300 ring-1 ring-sky-400 shadow-sm'
            : 'text-sky-400/80 hover:text-sky-200 hover:bg-white/10'
        }`}
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.75">
          {/* Camera center */}
          <rect x="8.5" y="8.5" width="7" height="6.5" rx="1" stroke="currentColor" />
          {/* 4-way arrows */}
          <path d="M12 2 v4 M12 22 v-4 M2 12 h4 M22 12 h-4" strokeLinecap="round" />
          <polyline points="10 4 12 2 14 4" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="10 20 12 22 14 20" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="4 10 2 12 4 14" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="20 10 22 12 20 14" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* 3. Camera Distance / Zoom */}
      <button
        type="button"
        onPointerDown={(e) => handlePointerDown('camera-zoom', e)}
        title="Camera Zoom: Click to select, or drag up/down to zoom in/out"
        className={`p-1.5 rounded transition-all flex items-center justify-center ${
          activeMode === 'camera-zoom'
            ? 'bg-blue-600/30 text-sky-300 ring-1 ring-sky-400 shadow-sm'
            : 'text-sky-400/80 hover:text-sky-200 hover:bg-white/10'
        }`}
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.75">
          {/* Vertical bidirectional dolly arrows beside camera */}
          <path d="M5 4 v16" strokeLinecap="round" />
          <polyline points="3 6 5 4 7 6" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="3 18 5 20 7 18" strokeLinecap="round" strokeLinejoin="round" />
          {/* Camera */}
          <rect x="10" y="8" width="9" height="8" rx="1.5" stroke="currentColor" />
          <polygon points="19,10 23,8 23,16 19,14" fill="currentColor" stroke="none" />
        </svg>
      </button>

      <div className="w-[1px] h-5 bg-white/15 mx-0.5" />

      {/* 4. Model Translate (Move in 3D View Plane) */}
      <button
        type="button"
        onPointerDown={(e) => handlePointerDown('model-move', e)}
        title="Move Model: Click to select, or drag to move 3D model up/down/left/right"
        className={`p-1.5 rounded transition-all flex items-center justify-center ${
          activeMode === 'model-move'
            ? 'bg-blue-600/30 text-sky-300 ring-1 ring-sky-400 shadow-sm'
            : 'text-sky-400/80 hover:text-sky-200 hover:bg-white/10'
        }`}
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.75">
          {/* Isometric Cube in center */}
          <path d="M12 7.5 L16.5 10 L12 12.5 L7.5 10 Z" stroke="currentColor" strokeLinejoin="round" />
          <path d="M7.5 10 v4.5 L12 17 v-4.5" stroke="currentColor" strokeLinejoin="round" />
          <path d="M16.5 10 v4.5 L12 17" stroke="currentColor" strokeLinejoin="round" />
          {/* 4-way translation arrows */}
          <path d="M12 2.5 v3 M12 21.5 v-3 M2.5 12 h3 M21.5 12 h-3" strokeLinecap="round" />
          <polyline points="10 4 12 2 14 4" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="10 20 12 22 14 20" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="4 10 2 12 4 14" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="20 10 22 12 20 14" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* 5. Model Free Rotate (Pitch & Yaw) */}
      <button
        type="button"
        onPointerDown={(e) => handlePointerDown('model-rotate-free', e)}
        title="Free Rotate Model: Click to select, or drag to freely rotate 3D model in any direction"
        className={`p-1.5 rounded transition-all flex items-center justify-center ${
          activeMode === 'model-rotate-free'
            ? 'bg-blue-600/30 text-sky-300 ring-1 ring-sky-400 shadow-sm'
            : 'text-sky-400/80 hover:text-sky-200 hover:bg-white/10'
        }`}
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.75">
          {/* Central Cube */}
          <path d="M12 8 L15.5 10 L12 12 L8.5 10 Z" stroke="currentColor" strokeLinejoin="round" />
          <path d="M8.5 10 v4 L12 16 v-4" stroke="currentColor" strokeLinejoin="round" />
          <path d="M15.5 10 v4 L12 16" stroke="currentColor" strokeLinejoin="round" />
          {/* Spherical rotation arrows circling the cube */}
          <path d="M12 3 C17 3, 21 7, 21 12 C21 16.5 17.5 20.2 13 20.9" strokeLinecap="round" />
          <polyline points="15 22 12 21 14 18" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M6 5.5 C4 7.2 3 9.5 3 12 C3 14.5 4 17 6 18.5" strokeLinecap="round" strokeDasharray="1 2.5" />
        </svg>
      </button>

      {/* 6. Model Yaw (Horizontal Tilt / Turn) */}
      <button
        type="button"
        onPointerDown={(e) => handlePointerDown('model-rotate-yaw', e)}
        title="Rotate Model Horizontally: Click to select, or drag horizontally to turn model on vertical axis"
        className={`p-1.5 rounded transition-all flex items-center justify-center ${
          activeMode === 'model-rotate-yaw'
            ? 'bg-blue-600/30 text-sky-300 ring-1 ring-sky-400 shadow-sm'
            : 'text-sky-400/80 hover:text-sky-200 hover:bg-white/10'
        }`}
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.75">
          {/* Cube */}
          <path d="M12 8.5 L16 10.5 L12 12.5 L8 10.5 Z" stroke="currentColor" strokeLinejoin="round" />
          <path d="M8 10.5 v4.5 L12 17.5 v-5" stroke="currentColor" strokeLinejoin="round" />
          <path d="M16 10.5 v4.5 L12 17.5" stroke="currentColor" strokeLinejoin="round" />
          {/* Top horizontal curved arrow */}
          <path d="M4 5 C8 3, 16 3, 20 5" strokeLinecap="round" />
          <polyline points="18 3 21 5 19 7.5" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="6 3 3 5 5 7.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* 7. Model Roll / Ground Tilt */}
      <button
        type="button"
        onPointerDown={(e) => handlePointerDown('model-rotate-roll', e)}
        title="Roll Model: Click to select, or drag to roll model along screen/ground axis"
        className={`p-1.5 rounded transition-all flex items-center justify-center ${
          activeMode === 'model-rotate-roll'
            ? 'bg-blue-600/30 text-sky-300 ring-1 ring-sky-400 shadow-sm'
            : 'text-sky-400/80 hover:text-sky-200 hover:bg-white/10'
        }`}
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.75">
          {/* Perspective floor diamond */}
          <polygon points="12,14.5 20,18.5 12,22 4,18.5" stroke="currentColor" strokeWidth="1.2" opacity="0.6" />
          {/* Cube resting on plane */}
          <path d="M12 7 L15.5 9 L12 11 L8.5 9 Z" stroke="currentColor" strokeLinejoin="round" />
          <path d="M8.5 9 v4 L12 15 v-4" stroke="currentColor" strokeLinejoin="round" />
          <path d="M15.5 9 v4 L12 15" stroke="currentColor" strokeLinejoin="round" />
          {/* Circular roll arrow curving over plane */}
          <path d="M5 13 C4 10, 6 6, 12 5 C17 5, 20 8, 20 12" strokeLinecap="round" />
          <polyline points="18 10 20 12 22 10" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* 8. Model Plane Move (Move across ground plane) */}
      <button
        type="button"
        onPointerDown={(e) => handlePointerDown('model-plane-move', e)}
        title="Move on Ground Plane: Click to select, or drag to slide model along floor plane"
        className={`p-1.5 rounded transition-all flex items-center justify-center ${
          activeMode === 'model-plane-move'
            ? 'bg-blue-600/30 text-sky-300 ring-1 ring-sky-400 shadow-sm'
            : 'text-sky-400/80 hover:text-sky-200 hover:bg-white/10'
        }`}
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.75">
          {/* Ground floor grid diamond */}
          <polygon points="12,13 21,17.5 12,22 3,17.5" stroke="currentColor" strokeWidth="1.2" opacity="0.6" />
          {/* Cross planar arrows on the ground */}
          <path d="M7 16 L17 19.5 M17 16 L7 19.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          {/* Cube */}
          <path d="M12 5 L15.5 7 L12 9 L8.5 7 Z" stroke="currentColor" strokeLinejoin="round" />
          <path d="M8.5 7 v3.5 L12 12.5 v-3.5" stroke="currentColor" strokeLinejoin="round" />
          <path d="M15.5 7 v3.5 L12 12.5" stroke="currentColor" strokeLinejoin="round" />
        </svg>
      </button>

      {/* 9. Magnet: Snap to Ground Plane (Clip Studio Paint style) */}
      <button
        type="button"
        onClick={onSnapToGround}
        title="Snap Model to Ground: Instantly drops model flush to floor plane"
        className="p-1.5 rounded transition-all flex items-center justify-center text-cyan-400/90 hover:text-cyan-200 hover:bg-cyan-500/20 active:scale-95"
      >
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.75">
          {/* Magnet U shape */}
          <path
            d="M6 3 v7 C6 14, 9 17, 12 17 C15 17, 18 14, 18 10 v-7"
            stroke="currentColor"
            strokeLinecap="round"
          />
          {/* Pole tips */}
          <line x1="4.5" y1="6" x2="7.5" y2="6" stroke="currentColor" strokeWidth="2" />
          <line x1="16.5" y1="6" x2="19.5" y2="6" stroke="currentColor" strokeWidth="2" />
          {/* Ground surface and bolt */}
          <line x1="3" y1="21" x2="21" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <polyline points="10 14 12 19 14 14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div className="w-[1px] h-5 bg-white/15 mx-0.5" />

      {/* 10. Extract Line & Tone (LT Conversion) */}
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            if (!folderName) {
              setFolderName(defaultFolderName);
            }
            setShowLTDialog((prev) => !prev);
          }}
          disabled={isExtracting}
          title="Extract Line & Tone (LT Conversion of 3D Data)"
          className={`p-1.5 px-2 rounded transition-all flex items-center space-x-1.5 text-xs font-medium ${
            showLTDialog
              ? 'bg-purple-600/40 text-purple-200 ring-1 ring-purple-400 shadow-sm'
              : 'text-purple-300 hover:text-white hover:bg-purple-600/30'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.75">
            {/* Outline box */}
            <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" />
            {/* Diagonal line divider */}
            <line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" strokeWidth="1.5" />
            {/* Screentone dots on lower half */}
            <circle cx="8" cy="16" r="1" fill="currentColor" />
            <circle cx="12" cy="16" r="1" fill="currentColor" />
            <circle cx="16" cy="16" r="1" fill="currentColor" />
            <circle cx="10" cy="19" r="1" fill="currentColor" />
            <circle cx="14" cy="19" r="1" fill="currentColor" />
            {/* Upper contour line */}
            <path d="M7 8 Q12 5 17 8" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
          <span className="text-[11px] font-medium tracking-wide">LT</span>
        </button>

        {/* LT Conversion Configuration Dialog */}
        {showLTDialog && (
          <div
            className="absolute top-full mt-2 left-1/2 -translate-x-1/2 w-72 bg-[#181b22]/98 backdrop-blur-xl border border-purple-500/50 rounded-xl p-3.5 shadow-2xl z-50 text-gray-200 select-none"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-2 border-b border-white/10">
              <div className="flex items-center space-x-1.5">
                <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                <span className="text-xs font-semibold text-purple-200 tracking-wide">
                  LT Conversion (Line & Tone)
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowLTDialog(false)}
                className="text-gray-400 hover:text-white p-0.5 rounded hover:bg-white/10"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Edge Detection Sensitivity: Line Width & Threshold */}
            <div className="mt-3 space-y-2.5">
              <div className="space-y-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-gray-300 font-medium">Line Width</span>
                  <span className="font-mono text-purple-300 font-bold">{lineWidth} px</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="5"
                  step="1"
                  value={lineWidth}
                  onChange={(e) => setLineWidth(parseInt(e.target.value, 10))}
                  className="w-full accent-purple-500 cursor-pointer h-1.5 bg-gray-700 rounded-lg"
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-[11px]">
                  <span className="text-gray-300 font-medium">Line Sensitivity (Threshold)</span>
                  <span className="font-mono text-purple-300 font-bold">
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
                  className="w-full accent-purple-500 cursor-pointer h-1.5 bg-gray-700 rounded-lg"
                />
              </div>
            </div>

            {/* Shading Tone Count: 1 to 4 Layers */}
            <div className="mt-3 space-y-1.5">
              <div className="flex justify-between text-[11px]">
                <span className="text-gray-300 font-medium">Shading Tone Count</span>
                <span className="text-[10px] text-gray-400 font-mono">60 LPI Screentone</span>
              </div>
              <div className="grid grid-cols-4 gap-1">
                {([1, 2, 3, 4] as const).map((count) => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => setToneCount(count)}
                    className={`py-1 rounded text-[11px] font-medium transition-all ${
                      toneCount === count
                        ? 'bg-purple-600 text-white shadow-sm ring-1 ring-purple-300'
                        : 'bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    {count} {count === 1 ? 'Tone' : 'Tones'}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-400 font-mono mt-0.5">
                {toneCount === 1 && 'Deep Shadow (45% density)'}
                {toneCount === 2 && 'Light (20%) + Deep Shadow (45%)'}
                {toneCount === 3 && 'Light (15%) + Mid (30%) + Deep (50%)'}
                {toneCount === 4 && 'Light (10%) + Mid-L (25%) + Mid-D (40%) + Deep (55%)'}
              </p>
            </div>

            {/* Target Output Folder */}
            <div className="mt-3 space-y-1">
              <label className="text-[11px] text-gray-300 font-medium block">
                Target Output Folder
              </label>
              <input
                type="text"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder={defaultFolderName}
                className="w-full px-2.5 py-1 text-xs bg-[#111317] border border-white/15 focus:border-purple-500 rounded text-gray-200 outline-none font-mono"
              />
            </div>

            {/* Action Buttons */}
            <div className="mt-4 flex items-center space-x-2">
              <button
                type="button"
                onClick={() => setShowLTDialog(false)}
                className="flex-1 py-1.5 rounded text-xs text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
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
                className="flex-1 py-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-semibold rounded text-xs transition-all shadow-lg flex items-center justify-center space-x-1 disabled:opacity-50"
              >
                <span>{isExtracting ? 'Extracting...' : 'Extract LT'}</span>
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="w-[1px] h-5 bg-white/15 mx-0.5" />

      {/* Reset Model Orientation */}
      <button
        type="button"
        onClick={onResetModelTransform}
        title="Reset Model: Center model and reset all rotations"
        className="p-1.5 rounded transition-all flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 text-[10px] font-mono px-2"
      >
        Reset
      </button>
    </div>
  );
};
