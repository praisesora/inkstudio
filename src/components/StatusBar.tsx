import React, { useEffect, useRef } from 'react';
import { ToolType, BrushSettings, CanvasColorMode } from '../types/editor';
import { ThemePreset } from '../types/settings';
import { formatZoomPercent } from '../hooks/useCanvasNavigation';
import { formatRotationDegrees } from '../utils/canvasUtils';

interface StatusBarProps {
  cursorPos?: { x: number; y: number } | null;
  currentPressure?: number;
  tool: ToolType;
  brushSettings: BrushSettings;
  zoom: number;
  rotation: number;
  onResetRotation: () => void;
  colorMode?: CanvasColorMode;
  showCursorCoordinates?: boolean;
  showPressureInStatusBar?: boolean;
  hasOpenDocument?: boolean;
  themePreset?: ThemePreset;
}

export const StatusBar: React.FC<StatusBarProps> = React.memo(({
  tool,
  brushSettings,
  zoom,
  rotation,
  onResetRotation,
  colorMode = 'color',
  showCursorCoordinates = true,
  showPressureInStatusBar = true,
  hasOpenDocument = true,
  themePreset: _themePreset = 'vintage-manga',
}) => {
  const posTextRef = useRef<HTMLSpanElement>(null);
  const pressureBarRef = useRef<HTMLDivElement>(null);
  const pressureTextRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let animId: number;
    let latestDetail: { x: number | null; y: number | null; pressure: number } | null = null;

    const handlePointerStat = (e: Event) => {
      latestDetail = (e as CustomEvent).detail;
      cancelAnimationFrame(animId);
      animId = requestAnimationFrame(() => {
        if (!latestDetail) return;
        if (posTextRef.current) {
          if (latestDetail.x !== null && latestDetail.y !== null && latestDetail.x !== undefined && latestDetail.y !== undefined) {
            posTextRef.current.textContent = `${latestDetail.x}, ${latestDetail.y}px`;
          } else {
            posTextRef.current.textContent = '— , —';
          }
        }
        if (pressureBarRef.current && pressureTextRef.current) {
          const percent = Math.round((latestDetail.pressure || 0) * 100);
          pressureBarRef.current.style.width = `${percent}%`;
          pressureTextRef.current.textContent = `${percent}%`;
        }
      });
    };

    window.addEventListener('canvas-pointer-stat', handlePointerStat);
    return () => {
      window.removeEventListener('canvas-pointer-stat', handlePointerStat);
      cancelAnimationFrame(animId);
    };
  }, []);

  return (
    <footer className="h-7 bg-gradient-to-b from-[#464649] to-[#363638] border-t border-[#232325] px-2.5 text-[#b0b0b6] flex items-center justify-between text-xs select-none z-20 shrink-0 transition-colors">
      {/* Tool & Smoothing Status */}
      <div className="flex items-center space-x-2">
        <div className="bg-[#2b2b2e] border border-[#202022] shadow-[inset_1px_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.08)] px-2 py-0.5 rounded-[2px] flex items-center space-x-2">
          <span className="text-[#f0f0f4] capitalize font-medium">{tool}</span>
          <span className="text-[#4a4a4e]">|</span>
          {hasOpenDocument ? (
            <span
              className={`font-mono text-[10px] font-medium ${
                colorMode === 'monochrome'
                  ? 'text-amber-400'
                  : colorMode === 'grayscale'
                  ? 'text-slate-300'
                  : 'text-emerald-400'
              }`}
              title={`Active Document Color Mode: ${colorMode}`}
            >
              {colorMode === 'monochrome' ? 'Manga (1-bit)' : colorMode === 'grayscale' ? 'Grayscale' : 'Color (RGB)'}
            </span>
          ) : (
            <span className="text-[#77777d] italic text-[10px]">No active document</span>
          )}
          <span className="text-[#4a4a4e]">|</span>
          <span className="text-[11px] text-[#cccccc]">
            {brushSettings.smoothing ? 'Bézier: ON' : 'Direct'}
          </span>
          <span className="text-[#4a4a4e]">|</span>
          <span className="text-emerald-400 font-mono text-[11px]">
            Stab: {brushSettings.stabilization ?? 0}
          </span>
        </div>

        {/* Vintage Manga Studio Application & System Monitor */}
        <div className="hidden md:flex items-center space-x-2 bg-[#2b2b2e] border border-[#202022] shadow-[inset_1px_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.08)] px-2 py-0.5 rounded-[2px] font-mono text-[10px] text-[#9999a0]">
          <span>Information:</span>
          <span className="text-[#7dd3fc]">System: 62%</span>
          <span className="text-emerald-400">Application: 100%</span>
        </div>
      </div>

      {/* Real-time Pointer Stats */}
      <div className="flex items-center space-x-2 font-mono text-xs">
        {/* Coordinates */}
        {showCursorCoordinates && (
          <div className="bg-[#2b2b2e] border border-[#202022] shadow-[inset_1px_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.08)] px-2 py-0.5 rounded-[2px] flex items-center space-x-1.5">
            <span className="text-[#77777d]">Pos:</span>
            <span ref={posTextRef} className="text-[#cccccc] text-[11px]">
              — , —
            </span>
          </div>
        )}

        {/* Stylus Pressure Bar */}
        {showPressureInStatusBar && (
          <div className="bg-[#2b2b2e] border border-[#202022] shadow-[inset_1px_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.08)] px-2 py-0.5 rounded-[2px] flex items-center space-x-2">
            <span className="text-[#77777d]">Pressure:</span>
            <div className="w-16 h-2.5 bg-[#1b1b1d] rounded-xs overflow-hidden border border-[#262629] shadow-inner">
              <div
                ref={pressureBarRef}
                className="h-full bg-gradient-to-r from-emerald-500 to-cyan-400 transition-all duration-75"
                style={{ width: `0%` }}
              />
            </div>
            <span ref={pressureTextRef} className="w-8 text-right text-[#cccccc] text-[10px]">0%</span>
          </div>
        )}

        {/* Rotation */}
        <div
          onClick={hasOpenDocument ? onResetRotation : undefined}
          onDoubleClick={hasOpenDocument ? onResetRotation : undefined}
          className={`bg-[#2b2b2e] border border-[#202022] shadow-[inset_1px_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.08)] px-2 py-0.5 rounded-[2px] flex items-center space-x-1.5 ${
            hasOpenDocument ? 'cursor-pointer hover:text-white' : 'opacity-40 pointer-events-none'
          }`}
          title="Canvas Rotation (Click or Double-click to Reset 0°)"
        >
          <span className="text-[#77777d]">Angle:</span>
          <span className="text-[#cccccc] font-medium text-[11px]">{hasOpenDocument ? formatRotationDegrees(rotation) : '0°'}</span>
        </div>

        {/* Zoom */}
        <div
          className={`bg-[#2b2b2e] border border-[#202022] shadow-[inset_1px_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.08)] px-2 py-0.5 rounded-[2px] flex items-center space-x-1.5 ${hasOpenDocument ? '' : 'opacity-40'}`}
          title="Canvas Zoom Level"
        >
          <span className="text-[#77777d]">Zoom:</span>
          <span className="text-[#cccccc] font-medium text-[11px]">{hasOpenDocument ? formatZoomPercent(zoom) : '—'}</span>
        </div>
      </div>
    </footer>
  );
});

StatusBar.displayName = 'StatusBar';
