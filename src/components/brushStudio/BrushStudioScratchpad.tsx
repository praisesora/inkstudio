import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Eraser, Droplets, Sun, Moon, Square } from 'lucide-react';
import type { BrushSettings, Point } from '../../types/editor';
import {
  buildBrushRenderOptions,
  centripetalCatmullRomToBezier,
  drawBrushCubicBezierSegment,
  drawBrushDot,
} from '../../engine/BrushEngine';
import {
  isNaturalPaintBrush,
  NaturalPaintStrokeSession,
} from '../../engine/NaturalPaintRenderer';
import {
  cleanDirtyBrush,
  LayerPixelSampler,
  PaintReservoir,
} from '../../utils/colorMixingEngine';

type ScratchpadBg = 'white' | 'gray' | 'dark';

const BG_COLORS: Record<ScratchpadBg, string> = {
  white: '#f6f4ef',
  gray: '#525252',
  dark: '#1c1c1e',
};

const QUICK_SWATCHES = [
  { label: 'Cadmium Yellow', hex: '#facc15' },
  { label: 'Ultramarine Violet', hex: '#6d28d9' },
  { label: 'Prussian Blue', hex: '#1d4ed8' },
  { label: 'Vermilion Red', hex: '#dc2626' },
];

export interface BrushStudioScratchpadProps {
  brushSettings: BrushSettings;
}

export const BrushStudioScratchpad: React.FC<BrushStudioScratchpadProps> = ({
  brushSettings,
}) => {
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const draftCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [bgMode, setBgMode] = useState<ScratchpadBg>('white');
  const [testColor, setTestColor] = useState<string>(brushSettings.color || '#1d4ed8');
  const [useActiveColor, setUseActiveColor] = useState<boolean>(true);
  const strokeSeedRef = useRef<number>(2026);

  const activeColor = useActiveColor ? brushSettings.color || '#1d4ed8' : testColor;

  const sessionRef = useRef<{
    drawing: boolean;
    pointerId: number;
    points: Point[];
    natSession: NaturalPaintStrokeSession | null;
    sampler: LayerPixelSampler | null;
    reservoir: PaintReservoir | null;
    remainderDist: number;
    dabCounter: { count: number };
    totalDist: number;
  }>({
    drawing: false,
    pointerId: -1,
    points: [],
    natSession: null,
    sampler: null,
    reservoir: null,
    remainderDist: 0,
    dabCounter: { count: 0 },
    totalDist: 0,
  });

  const clearScratchpad = useCallback(() => {
    const base = baseCanvasRef.current;
    const draft = draftCanvasRef.current;
    if (base) {
      const ctx = base.getContext('2d');
      ctx?.clearRect(0, 0, base.width, base.height);
    }
    if (draft) {
      const ctx = draft.getContext('2d');
      ctx?.clearRect(0, 0, draft.width, draft.height);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (sessionRef.current.natSession) {
        sessionRef.current.natSession.finishAndDispose();
        sessionRef.current.natSession = null;
      }
    };
  }, []);

  const toCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = draftCanvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, rect.width);
    const scaleY = canvas.height / Math.max(1, rect.height);
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const pressure =
      e.pointerType === 'mouse' ? 0.72 : Math.max(0.05, Math.min(1, e.pressure || 0.5));
    const minFactor = brushSettings.minSizeFactor ?? 0.25;
    const baseSize = Math.min(110, Math.max(2, brushSettings.size || 24));
    const width =
      brushSettings.usePressure !== false
        ? baseSize * (minFactor + (1 - minFactor) * pressure)
        : baseSize;
    return {
      x,
      y,
      pressure,
      width,
      tiltX: e.tiltX ?? 0,
      tiltY: e.tiltY ?? 0,
      twist: e.twist ?? 0,
      timestamp: e.timeStamp,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const base = baseCanvasRef.current;
    const draft = draftCanvasRef.current;
    if (!base || !draft) return;
    const dCtx = draft.getContext('2d');
    if (!dCtx) return;

    draft.setPointerCapture(e.pointerId);
    dCtx.clearRect(0, 0, draft.width, draft.height);

    const pt = toCanvasPoint(e);
    const s = sessionRef.current;
    s.drawing = true;
    s.pointerId = e.pointerId;
    s.points = [pt];
    s.remainderDist = 0;
    s.dabCounter.count = 0;
    s.totalDist = 0;

    const naturalMode = isNaturalPaintBrush(brushSettings);
    const needsSampler = Boolean(
      brushSettings.colorMixing !== false &&
        (brushSettings.colorMixing || (naturalMode && brushSettings.naturalPaint?.spatialMixing))
    );
    s.sampler = needsSampler ? new LayerPixelSampler(base) : null;
    s.reservoir = brushSettings.colorMixing ? new PaintReservoir(activeColor) : null;

    if (naturalMode) {
      strokeSeedRef.current = (strokeSeedRef.current + 7919) & 0x7fffffff;
      const previewBs: BrushSettings = {
        ...brushSettings,
        size: Math.min(110, Math.max(2, brushSettings.size || 24)),
      };
      s.natSession = new NaturalPaintStrokeSession(
        previewBs,
        activeColor,
        undefined,
        strokeSeedRef.current
      );
      s.natSession.stampInitialPoint(dCtx, pt, s.sampler || undefined, true);
    } else {
      s.natSession = null;
      const opts = buildBrushRenderOptions(brushSettings, {
        size: Math.min(110, Math.max(2, brushSettings.size || 24)),
        opacity: 1.0,
        underlyingCanvas: base,
        sampler: s.sampler || undefined,
        reservoir: s.reservoir || undefined,
        useGpu: false,
      });
      drawBrushDot(dCtx, pt, activeColor, opts);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = sessionRef.current;
    if (!s.drawing || e.pointerId !== s.pointerId) return;
    const base = baseCanvasRef.current;
    const draft = draftCanvasRef.current;
    if (!base || !draft) return;
    const dCtx = draft.getContext('2d');
    if (!dCtx) return;

    const pt = toCanvasPoint(e);
    const prev = s.points[s.points.length - 1];
    const dist = Math.hypot(pt.x - prev.x, pt.y - prev.y);
    if (dist < 1.2) return;

    s.points.push(pt);
    const len = s.points.length;
    const p0 = s.points[Math.max(0, len - 3)];
    const p1 = s.points[len - 2];
    const p2 = s.points[len - 1];
    const { c1, c2 } = centripetalCatmullRomToBezier(p0, p1, p2, p2);

    if (s.natSession) {
      s.natSession.drawCubicSegment(dCtx, p1, c1, c2, p2, s.sampler || undefined, true);
    } else {
      const opts = buildBrushRenderOptions(brushSettings, {
        size: Math.min(110, Math.max(2, brushSettings.size || 24)),
        opacity: 1.0,
        underlyingCanvas: base,
        sampler: s.sampler || undefined,
        reservoir: s.reservoir || undefined,
        currentStrokeDist: s.totalDist,
        useGpu: false,
      });
      s.remainderDist = drawBrushCubicBezierSegment(
        dCtx,
        p1,
        c1,
        c2,
        p2,
        activeColor,
        opts,
        s.remainderDist,
        s.dabCounter
      );
    }
    s.totalDist += dist;
  };

  const finishStroke = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    const s = sessionRef.current;
    if (!s.drawing) return;
    s.drawing = false;

    const base = baseCanvasRef.current;
    const draft = draftCanvasRef.current;
    if (draft && e) {
      try {
        draft.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }

    if (base && draft) {
      const bCtx = base.getContext('2d');
      const dCtx = draft.getContext('2d');
      if (bCtx && dCtx) {
        if (s.natSession) {
          s.natSession.flushPendingTapIfNeeded(s.sampler || undefined);
          const tapBounds = s.natSession.getDirtyBounds();
          if (tapBounds && s.points.length <= 1) {
            s.natSession.flushDirtyRectToContext(dCtx, tapBounds, true, 1.0, 'source-over');
          }
        }
        bCtx.save();
        bCtx.globalAlpha = Math.max(0.01, Math.min(1, brushSettings.opacity ?? 1.0));
        bCtx.drawImage(draft, 0, 0);
        bCtx.restore();
        dCtx.clearRect(0, 0, draft.width, draft.height);
      }
    }

    if (s.natSession) {
      s.natSession.finishAndDispose();
      s.natSession = null;
    }
    s.sampler = null;
    s.reservoir = null;
    s.points = [];
  };

  return (
    <div className="flex flex-col h-full bg-[#161616] border-r border-white/[0.08]">
      {/* Scratchpad Toolbar */}
      <div className="px-2.5 py-2 border-b border-white/[0.08] flex items-center justify-between gap-2 bg-[#1c1c1c]">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setUseActiveColor(true)}
            title="Use active foreground color"
            className={`w-5 h-5 rounded-full border cursor-pointer transition-transform ${
              useActiveColor ? 'border-white scale-110 ring-1 ring-[var(--accent)]' : 'border-white/30'
            }`}
            style={{ backgroundColor: brushSettings.color || '#1d4ed8' }}
          />
          <div className="w-px h-3.5 bg-white/10 mx-0.5" />
          {QUICK_SWATCHES.map((sw) => {
            const selected = !useActiveColor && testColor === sw.hex;
            return (
              <button
                key={sw.hex}
                type="button"
                onClick={() => {
                  setUseActiveColor(false);
                  setTestColor(sw.hex);
                }}
                title={`Test color: ${sw.label}`}
                className={`w-4 h-4 rounded-full border cursor-pointer transition-transform ${
                  selected ? 'border-white scale-110 ring-1 ring-[var(--accent)]' : 'border-white/20 hover:scale-105'
                }`}
                style={{ backgroundColor: sw.hex }}
              />
            );
          })}
        </div>

        <div className="flex items-center gap-1">
          <div className="flex items-center bg-[#141414] rounded p-0.5 border border-white/[0.06]">
            <button
              type="button"
              onClick={() => setBgMode('white')}
              title="White Canvas"
              className={`p-1 rounded cursor-pointer ${
                bgMode === 'white' ? 'bg-[#2c2c2c] text-white' : 'text-[#8a8a8a] hover:text-white'
              }`}
            >
              <Sun className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => setBgMode('gray')}
              title="Neutral Gray"
              className={`p-1 rounded cursor-pointer ${
                bgMode === 'gray' ? 'bg-[#2c2c2c] text-white' : 'text-[#8a8a8a] hover:text-white'
              }`}
            >
              <Square className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => setBgMode('dark')}
              title="Dark Canvas"
              className={`p-1 rounded cursor-pointer ${
                bgMode === 'dark' ? 'bg-[#2c2c2c] text-white' : 'text-[#8a8a8a] hover:text-white'
              }`}
            >
              <Moon className="w-3 h-3" />
            </button>
          </div>

          {brushSettings.naturalPaint?.autoClean === false && (
            <button
              type="button"
              onClick={() => cleanDirtyBrush(brushSettings.preset)}
              title="Wash dirty pigment off bristles"
              className="px-1.5 py-1 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[10px] text-sky-300 flex items-center gap-1 cursor-pointer"
            >
              <Droplets className="w-3 h-3" />
              <span>Clean</span>
            </button>
          )}

          <button
            type="button"
            onClick={clearScratchpad}
            title="Clear Scratchpad"
            className="px-1.5 py-1 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[10px] text-[#d4d4d4] flex items-center gap-1 cursor-pointer"
          >
            <Eraser className="w-3 h-3" />
            <span>Clear</span>
          </button>
        </div>
      </div>

      {/* Interactive Dual-Canvas Live Painting Surface */}
      <div
        className="relative flex-1 overflow-hidden select-none touch-none"
        style={{ backgroundColor: BG_COLORS[bgMode] }}
      >
        <canvas
          ref={baseCanvasRef}
          width={560}
          height={440}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />
        <canvas
          ref={draftCanvasRef}
          width={560}
          height={440}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          style={{ opacity: Math.max(0.01, Math.min(1, brushSettings.opacity ?? 1.0)) }}
          className="absolute inset-0 w-full h-full cursor-crosshair"
        />
        <div className="absolute bottom-2 left-2.5 right-2.5 flex items-center justify-between pointer-events-none">
          <span className="text-[10px] px-2 py-0.5 rounded bg-black/45 text-white/80 backdrop-blur-sm">
            Live Scratchpad — Draw & overlap colors to test mixing & impasto
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/45 text-white/80">
            {Math.round(brushSettings.size)}px
          </span>
        </div>
      </div>
    </div>
  );
};
