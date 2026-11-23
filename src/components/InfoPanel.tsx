import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Clock, Crosshair, Layers, Cpu, Monitor, Trash2 } from 'lucide-react';
import { CanvasColorMode, LayerItem } from '../types/editor';
import { ThemePreset, hexToRgb } from '../types/settings';
import { useDocumentStore, useToolStore, uiStoreActions } from '../stores';
import { documentStore } from '../utils/documentStore';
import { performanceManager } from '../utils/performanceManager';
import {
  ArtworkTimeTracker,
  artworkTimeTracker,
  formatWorkTimeClock,
  formatWorkTimeHoursMinutes,
} from '../utils/artworkTimeTracker';

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : Math.round((d / max) * 100);
  const v = Math.round(max * 100);
  return { h, s, v };
}

function formatColorModeLabel(mode: CanvasColorMode): string {
  switch (mode) {
    case 'monochrome':
      return '1-bit Mono';
    case 'grayscale':
      return 'Grayscale';
    case 'color':
    default:
      return 'RGB Color';
  }
}

export interface InfoPanelProps {
  layers?: LayerItem[];
  colorMode?: CanvasColorMode;
  themePreset?: ThemePreset;
  /** Optional custom tracker instance (primarily for unit tests). */
  tracker?: ArtworkTimeTracker;
}

export const InfoPanel: React.FC<InfoPanelProps> = React.memo(
  ({ layers = [], colorMode: colorModeProp, themePreset = 'modern', tracker = artworkTimeTracker }) => {
    const activeDocumentId = useDocumentStore((s) => s.activeDocumentId);
    const dimensions = useDocumentStore((s) => s.dimensions);
    const storeColorMode = useDocumentStore((s) => s.colorMode);
    const primaryColor = useToolStore((s) => s.primaryColor);
    const colorMode = colorModeProp ?? storeColorMode;

    const getSnapshot = useCallback(
      () => tracker.getSnapshot(activeDocumentId),
      [tracker, activeDocumentId]
    );

    const timeSnap = useSyncExternalStore(tracker.subscribe, getSnapshot, getSnapshot);

    // Zero-rerender live cursor X / Y / Pressure readout via canvas-pointer-stat
    const posXRef = useRef<HTMLSpanElement | null>(null);
    const posYRef = useRef<HTMLSpanElement | null>(null);
    const pressureRef = useRef<HTMLSpanElement | null>(null);

    useEffect(() => {
      if (typeof window === 'undefined') return;
      let rafId = 0;
      let latest: { x: number | null; y: number | null; pressure: number } | null = null;

      const handlePointerStat = (e: Event) => {
        latest = (e as CustomEvent).detail;
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          if (!latest) return;
          const hasCoords =
            latest.x !== null &&
            latest.y !== null &&
            latest.x !== undefined &&
            latest.y !== undefined;
          if (posXRef.current) {
            posXRef.current.textContent = hasCoords ? String(latest.x) : '—';
          }
          if (posYRef.current) {
            posYRef.current.textContent = hasCoords ? String(latest.y) : '—';
          }
          if (pressureRef.current) {
            const pct = Math.round((latest.pressure || 0) * 100);
            pressureRef.current.textContent = `${pct}%`;
          }
        });
      };

      window.addEventListener('canvas-pointer-stat', handlePointerStat);
      return () => {
        window.removeEventListener('canvas-pointer-stat', handlePointerStat);
        cancelAnimationFrame(rafId);
      };
    }, []);

    // Lightweight periodic memory & renderer poll (every 2s while Info tab is visible)
    const [memoryStats, setMemoryStats] = useState<{
      usedMb: number;
      budgetMb: number;
      backend: 'webgl2' | 'canvas2d';
      vramMb: number;
    }>(() => {
      const cfg = performanceManager.getConfig();
      return {
        usedMb: Math.round((documentStore.getTotalActiveTileBytes() / (1024 * 1024)) * 10) / 10,
        budgetMb: Math.max(1, Math.round(documentStore.getTileBudgetBytes() / (1024 * 1024))),
        backend: cfg.renderBackend === 'canvas2d' ? 'canvas2d' : 'webgl2',
        vramMb: 0,
      };
    });

    useEffect(() => {
      let active = true;
      const updateMem = async () => {
        const t = await performanceManager.getMemoryTelemetry();
        if (!active) return;
        const usedMb =
          Math.round((documentStore.getTotalActiveTileBytes() / (1024 * 1024)) * 10) / 10;
        const budgetMb = Math.max(
          1,
          Math.round(documentStore.getTileBudgetBytes() / (1024 * 1024))
        );
        const backend = t.compositor.backend;
        const vramMb = t.compositor.estimatedVramMb;
        setMemoryStats((prev) =>
          prev.usedMb === usedMb &&
          prev.budgetMb === budgetMb &&
          prev.backend === backend &&
          prev.vramMb === vramMb
            ? prev
            : { usedMb, budgetMb, backend, vramMb }
        );
      };
      void updateMem();
      const id = setInterval(() => void updateMem(), 2000);
      return () => {
        active = false;
        clearInterval(id);
      };
    }, []);

    const colorBreakdown = useMemo(() => {
      const rgb = hexToRgb(primaryColor) || { r: 0, g: 0, b: 0 };
      const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      return { rgb, hsv, hex: primaryColor.toUpperCase() };
    }, [primaryColor]);

    const visibleLayerCount = useMemo(
      () => layers.filter((l) => l.visible).length,
      [layers]
    );

    const memPercent = Math.min(100, Math.round((memoryStats.usedMb / memoryStats.budgetMb) * 100));

    return (
      <div
        data-testid="info-panel"
        data-theme-preset={themePreset}
        className="flex flex-col h-full min-h-0 overflow-y-auto no-scrollbar select-none bg-[#202020] text-[#e5e5e5] p-2 gap-2 text-[11px]"
      >
        {/* Clean Automatic Artwork Time Counter (Text-Only, No Manual Controls) */}
        <section
          data-testid="info-work-time-section"
          data-status={timeSnap.status}
          className="rounded-md bg-[#181818] border border-white/[0.06] px-2 py-1.5 flex flex-col gap-1"
          title="Automatically tracks active time spent drawing and editing this artwork"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[10px] text-[#8a8a8a]">
              <Clock className="w-3 h-3 text-[#7a7a7a]" />
              <span>Work Time</span>
            </span>
            <span
              data-testid="info-work-time-hm"
              className="font-mono tabular-nums text-[10px] text-[#8a8a8a]"
            >
              {formatWorkTimeHoursMinutes(timeSnap.accumulatedMs)}
            </span>
          </div>

          <div className="flex items-baseline justify-between gap-2">
            <span
              data-testid="info-work-time-clock"
              className="font-mono tabular-nums text-[15px] leading-tight font-medium text-[#f0f0f0] tracking-tight"
            >
              {formatWorkTimeClock(timeSnap.accumulatedMs)}
            </span>
            <span
              data-testid="info-session-time"
              className="font-mono tabular-nums text-[10px] text-[#7a7a7a]"
              title="Time spent in the current session"
            >
              Session {formatWorkTimeClock(timeSnap.sessionMs)}
            </span>
          </div>
        </section>

        {/* CSP-Style Cursor Coordinates & Active Color */}
        <section className="rounded-md bg-[#181818] border border-white/[0.06] p-2 flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[10px] text-[#8a8a8a]">
            <div className="flex items-center gap-1 uppercase tracking-wider font-medium">
              <Crosshair className="w-3 h-3 text-[#7a7a7a]" />
              <span>Cursor</span>
            </div>
            <span className="font-mono tabular-nums text-[#9a9a9a]">
              P: <span ref={pressureRef} className="text-[#d4d4d4]">0%</span>
            </span>
          </div>

          <div className="grid grid-cols-2 gap-1.5 font-mono tabular-nums text-[10px]">
            <div className="flex items-center justify-between px-1.5 py-0.5 rounded bg-[#222222] border border-white/[0.04]">
              <span className="text-[#7a7a7a]">X</span>
              <span ref={posXRef} data-testid="info-cursor-x" className="text-[#e5e5e5]">
                —
              </span>
            </div>
            <div className="flex items-center justify-between px-1.5 py-0.5 rounded bg-[#222222] border border-white/[0.04]">
              <span className="text-[#7a7a7a]">Y</span>
              <span ref={posYRef} data-testid="info-cursor-y" className="text-[#e5e5e5]">
                —
              </span>
            </div>
          </div>

          {/* Active Color RGB / HSV */}
          <div className="flex items-center gap-2 pt-1 border-t border-white/[0.05]">
            <div
              className="w-6 h-6 rounded border border-white/[0.15] shrink-0 shadow-inner"
              style={{ backgroundColor: colorBreakdown.hex }}
              title={`Active Color: ${colorBreakdown.hex}`}
            />
            <div className="flex-1 min-w-0 grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono tabular-nums text-[10px]">
              <div className="flex justify-between">
                <span className="text-[#7a7a7a]">R</span>
                <span className="text-[#d4d4d4]">{colorBreakdown.rgb.r}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#7a7a7a]">H</span>
                <span className="text-[#d4d4d4]">{colorBreakdown.hsv.h}°</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#7a7a7a]">G</span>
                <span className="text-[#d4d4d4]">{colorBreakdown.rgb.g}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#7a7a7a]">S</span>
                <span className="text-[#d4d4d4]">{colorBreakdown.hsv.s}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#7a7a7a]">B</span>
                <span className="text-[#d4d4d4]">{colorBreakdown.rgb.b}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#7a7a7a]">V</span>
                <span className="text-[#d4d4d4]">{colorBreakdown.hsv.v}%</span>
              </div>
            </div>
          </div>
        </section>

        {/* Canvas & Memory Info (CSP Info Palette Style) */}
        <section className="rounded-md bg-[#181818] border border-white/[0.06] p-2 flex flex-col gap-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-[#8a8a8a]">Canvas</span>
            <span className="font-mono tabular-nums text-[#d4d4d4]">
              {dimensions.width} × {dimensions.height} px
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-[#8a8a8a]">Resolution</span>
            <span className="font-mono tabular-nums text-[#d4d4d4]">
              {dimensions.dpi ?? 300} dpi · {formatColorModeLabel(colorMode)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-[#8a8a8a] flex items-center gap-1">
              <Layers className="w-2.5 h-2.5 text-[#7a7a7a]" />
              <span>Layers</span>
            </span>
            <span className="font-mono tabular-nums text-[#d4d4d4]">
              {visibleLayerCount} / {layers.length}
            </span>
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-[#8a8a8a] flex items-center gap-1">
              <Monitor className="w-2.5 h-2.5 text-[#7a7a7a]" />
              <span>Engine</span>
            </span>
            <span className="font-mono tabular-nums text-[#d4d4d4]">
              {memoryStats.backend === 'webgl2'
                ? `WebGL2${memoryStats.vramMb > 0 ? ` · ${memoryStats.vramMb} MB` : ''}`
                : 'Canvas 2D (CPU)'}
            </span>
          </div>
          <div className="flex flex-col gap-1 pt-1 mt-0.5 border-t border-white/[0.05]">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-[#8a8a8a] flex items-center gap-1">
                <Cpu className="w-2.5 h-2.5 text-[#7a7a7a]" />
                <span>Tile RAM</span>
              </span>
              <div className="flex items-center gap-1.5">
                <span className="font-mono tabular-nums text-[#d4d4d4]">
                  {memoryStats.usedMb} / {memoryStats.budgetMb} MB
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    const res = await performanceManager.purgeMemory('all');
                    uiStoreActions.showToast(
                      res.freedTileMb > 0 || res.offloadedUndoSteps > 0
                        ? `Freed ${res.freedTileMb} MB tiles, ${res.offloadedUndoSteps} undo steps`
                        : 'Memory & GPU caches flushed'
                    );
                  }}
                  className="p-0.5 rounded text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-white/10 transition-colors cursor-pointer"
                  title="Purge Tile, Undo & GPU Caches"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
            <div className="w-full h-1 rounded-full bg-white/[0.08] overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${memPercent}%`,
                  backgroundColor: memPercent > 85 ? '#f43f5e' : 'var(--accent)',
                }}
              />
            </div>
          </div>
        </section>
      </div>
    );
  }
);

InfoPanel.displayName = 'InfoPanel';
