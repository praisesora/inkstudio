import React, { useEffect, useRef } from 'react';
import { ToolType, BrushSettings, CanvasColorMode, SoftProofSettings, CmykStandard } from '../types/editor';
import { ThemePreset } from '../types/settings';
import { formatZoomPercent } from '../hooks/useCanvasNavigation';
import { formatRotationDegrees } from '../utils/canvasUtils';

const CMYK_STANDARD_LABELS: Record<CmykStandard, string> = {
  'japan-color-2001': 'Japan Color 2001',
  'us-web-coated-swop': 'US Web Coated',
  'iso-coated-v2': 'ISO Coated v2',
};

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
  softProofSettings?: SoftProofSettings;
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
  themePreset: _themePreset = 'modern',
  softProofSettings,
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
    <footer
      data-testid="status-bar"
      data-theme-preset="modern"
      className="h-7 bg-[#1a1a1a] border-t border-white/[0.06] px-3 text-white/70 flex items-center justify-between text-xs select-none z-20 shrink-0"
    >
        {/* Tool & Smoothing Status */}
        <div className="flex items-center space-x-2">
          <div className="bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 rounded-md flex items-center space-x-2">
            <span className="text-white capitalize font-medium text-[11px]">{tool}</span>
            <span className="text-white/20">|</span>
            {hasOpenDocument ? (
              <>
                <span
                  className={`font-mono text-[10px] font-medium ${
                    colorMode === 'monochrome'
                      ? 'text-amber-400'
                      : colorMode === 'grayscale'
                      ? 'text-slate-300'
                      : 'text-[var(--modern-accent)]'
                  }`}
                  title={`Active Document Color Mode: ${colorMode}`}
                >
                  {colorMode === 'monochrome' ? '1-bit Manga' : colorMode === 'grayscale' ? 'Grayscale' : 'Color RGB'}
                </span>
                {softProofSettings?.enabled && (
                  <>
                    <span className="text-white/20">|</span>
                    <span
                      className="text-cyan-400 font-mono text-[10px] font-medium"
                      title={`CMYK Soft Proofing: ${softProofSettings.standard}${softProofSettings.gamutWarning ? ' (Gamut Warning ON)' : ''}`}
                    >
                      [CMYK Proof: {CMYK_STANDARD_LABELS[softProofSettings.standard] || 'US Web Coated'}]
                    </span>
                  </>
                )}
              </>
            ) : (
              <span className="text-white/30 italic text-[10px]">No active document</span>
            )}
            <span className="text-white/20">|</span>
            <span className="text-[10px] font-mono text-white/60">
              {brushSettings.smoothing ? 'Bézier' : 'Direct'}
            </span>
            <span className="text-white/20">|</span>
            <span className="text-[var(--modern-accent)] font-mono text-[10px]">
              Stab: {brushSettings.stabilization ?? 0}
            </span>
          </div>
        </div>

        {/* Real-time Pointer Stats */}
        <div className="flex items-center space-x-2 font-mono text-xs">
          {/* Coordinates */}
          {showCursorCoordinates && (
            <div className="bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 rounded-md flex items-center space-x-1.5">
              <span className="text-white/40 text-[10px]">Pos:</span>
              <span ref={posTextRef} className="text-white/90 text-[11px]">
                — , —
              </span>
            </div>
          )}

          {/* Stylus Pressure Bar */}
          {showPressureInStatusBar && (
            <div className="bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 rounded-md flex items-center space-x-2">
              <span className="text-white/40 text-[10px]">Pressure:</span>
              <div className="w-14 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  ref={pressureBarRef}
                  className="h-full bg-[var(--modern-accent)] transition-all duration-75"
                  style={{ width: `0%` }}
                />
              </div>
              <span ref={pressureTextRef} className="w-7 text-right text-white/80 text-[10px]">0%</span>
            </div>
          )}

          {/* Rotation */}
          <div
            onClick={hasOpenDocument ? onResetRotation : undefined}
            onDoubleClick={hasOpenDocument ? onResetRotation : undefined}
            className={`bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 rounded-md flex items-center space-x-1.5 ${
              hasOpenDocument ? 'cursor-pointer hover:bg-white/[0.08] text-white/90 hover:text-white' : 'opacity-40 pointer-events-none'
            }`}
            title="Canvas Rotation (Click or Double-click to Reset 0°)"
          >
            <span className="text-white/40 text-[10px]">Angle:</span>
            <span className="text-white/90 font-medium text-[11px]">{hasOpenDocument ? formatRotationDegrees(rotation) : '0°'}</span>
          </div>

          {/* Zoom */}
          <div
            className={`bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 rounded-md flex items-center space-x-1.5 ${hasOpenDocument ? '' : 'opacity-40'}`}
            title="Canvas Zoom Level"
          >
            <span className="text-white/40 text-[10px]">Zoom:</span>
            <span className="text-white/90 font-medium text-[11px]">{hasOpenDocument ? formatZoomPercent(zoom) : '—'}</span>
          </div>
        </div>
      </footer>
  );
});

StatusBar.displayName = 'StatusBar';
