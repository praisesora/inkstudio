import React, { useState, useRef, useCallback } from 'react';
import { ToolType, BrushSettings, LiquifySettings, RetouchSettings } from '../types/editor';

interface FloatingBrushPillProps {
  tool: ToolType;
  brushSettings: BrushSettings;
  onUpdateBrushSettings: (patch: Partial<BrushSettings>) => void;
  liquifySettings?: LiquifySettings;
  onUpdateLiquifySettings?: (patch: Partial<LiquifySettings>) => void;
  retouchSettings?: RetouchSettings;
  onUpdateRetouchSettings?: (patch: Partial<RetouchSettings>) => void;
  primaryColor?: string;
  onSwapColors?: () => void;
  zoom?: number;
}

const MIN_BRUSH_SIZE = 0.5;
const MAX_BRUSH_SIZE = 250;

function sizeToRatio(size: number, min: number, max: number): number {
  const clamped = Math.max(min, Math.min(max, size));
  return Math.sqrt((clamped - min) / (max - min));
}

function ratioToSize(ratio: number, min: number, max: number): number {
  const r = Math.max(0, Math.min(1, ratio));
  const raw = min + r * r * (max - min);
  if (raw < 10) return Math.round(raw * 2) / 2;
  return Math.round(raw);
}

export const FloatingBrushPill: React.FC<FloatingBrushPillProps> = React.memo(({
  tool,
  brushSettings,
  onUpdateBrushSettings,
  liquifySettings,
  onUpdateLiquifySettings,
  retouchSettings,
  onUpdateRetouchSettings,
  primaryColor = '#000000',
  onSwapColors,
  zoom = 1,
}) => {
  const [activeDrag, setActiveDrag] = useState<'size' | 'opacity' | null>(null);
  const [hoveredTrack, setHoveredTrack] = useState<'size' | 'opacity' | null>(null);
  const sizeTrackRef = useRef<HTMLDivElement>(null);
  const opacityTrackRef = useRef<HTMLDivElement>(null);

  const isLiquify = tool === 'liquify';
  const isRetouch = tool === 'retouch';
  const usesStrength = isLiquify || isRetouch;
  const minSize = isLiquify ? 5 : isRetouch ? 2 : MIN_BRUSH_SIZE;
  const maxSize = isLiquify ? 500 : isRetouch ? 300 : MAX_BRUSH_SIZE;

  const currentSize = isLiquify
    ? (liquifySettings?.size ?? 80)
    : isRetouch
      ? (retouchSettings?.size ?? 40)
      : brushSettings.size;
  const currentOpacity = isLiquify
    ? (liquifySettings?.strength ?? 50) / 100
    : isRetouch
      ? (retouchSettings?.strength ?? 50) / 100
      : (brushSettings.opacity ?? 1);

  const sizeRatio = sizeToRatio(currentSize, minSize, maxSize);
  const opacityRatio = Math.max(0.01, Math.min(1, currentOpacity));

  const updateSizeFromPointer = useCallback(
    (clientY: number) => {
      const el = sizeTrackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ratio = 1 - (clientY - rect.top) / rect.height;
      const nextSize = ratioToSize(ratio, minSize, maxSize);
      if (isLiquify) {
        onUpdateLiquifySettings?.({ size: nextSize });
      } else if (isRetouch) {
        onUpdateRetouchSettings?.({ size: Math.round(nextSize) });
      } else {
        onUpdateBrushSettings({ size: nextSize });
      }
    },
    [isLiquify, isRetouch, maxSize, minSize, onUpdateBrushSettings, onUpdateLiquifySettings, onUpdateRetouchSettings]
  );

  const updateOpacityFromPointer = useCallback(
    (clientY: number) => {
      const el = opacityTrackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0.01, Math.min(1, 1 - (clientY - rect.top) / rect.height));
      if (isLiquify) {
        onUpdateLiquifySettings?.({ strength: Math.round(ratio * 100) });
      } else if (isRetouch) {
        onUpdateRetouchSettings?.({ strength: Math.round(ratio * 100) });
      } else {
        onUpdateBrushSettings({ opacity: Math.round(ratio * 100) / 100 });
      }
    },
    [isLiquify, isRetouch, onUpdateBrushSettings, onUpdateLiquifySettings, onUpdateRetouchSettings]
  );

  const showSizeHud = activeDrag === 'size' || hoveredTrack === 'size';
  const showOpacityHud = activeDrag === 'opacity' || hoveredTrack === 'opacity';
  const previewDiameter = Math.max(4, Math.min(220, currentSize * zoom));

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      className="absolute left-3 top-1/2 -translate-y-1/2 z-35 flex flex-col items-center py-3 px-1.5 w-7 rounded-full bg-[#202020]/95 backdrop-blur-sm shadow-[0_8px_28px_rgba(0,0,0,0.55)] select-none"
    >
      {/* Top Vertical Slider: Brush Size */}
      <div
        ref={sizeTrackRef}
        onPointerEnter={() => setHoveredTrack('size')}
        onPointerLeave={() => setHoveredTrack((prev) => (prev === 'size' ? null : prev))}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          setActiveDrag('size');
          updateSizeFromPointer(e.clientY);
        }}
        onPointerMove={(e) => {
          if (activeDrag === 'size') {
            updateSizeFromPointer(e.clientY);
          }
        }}
        onPointerUp={(e) => {
          if (activeDrag === 'size') {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
            setActiveDrag(null);
          }
        }}
        onPointerCancel={() => setActiveDrag(null)}
        title={`Brush Size: ${currentSize}px`}
        className="relative w-4 h-28 flex items-center justify-center cursor-ns-resize touch-none group"
      >
        <div className="w-1.5 h-full rounded-full bg-[#161616] group-hover:bg-[#2c2c2c] relative overflow-hidden transition-colors">
          <div
            className="absolute bottom-0 left-0 right-0 rounded-full transition-[height] duration-75"
            style={{
              height: `${sizeRatio * 100}%`,
              backgroundColor: 'var(--accent)',
            }}
          />
        </div>
        <div
          className="absolute left-1/2 -translate-x-1/2 w-3 h-3 rounded-full shadow-sm pointer-events-none transition-transform group-hover:scale-110"
          style={{
            bottom: `calc(${sizeRatio * 100}% - 6px)`,
            backgroundColor: 'var(--accent)',
          }}
        />

        {showSizeHud && (
          <div className="pointer-events-none absolute left-8 top-1/2 -translate-y-1/2 flex items-center gap-2.5">
            <div className="px-2 py-1 rounded bg-[#202020] shadow-[0_4px_16px_rgba(0,0,0,0.6)] whitespace-nowrap flex items-center gap-1.5">
              <span className="text-[10px] text-[#8a8a8a]">Size</span>
              <span className="text-[11px] font-mono text-[#e5e5e5] font-medium">
                {currentSize}px
              </span>
            </div>
            {activeDrag === 'size' && (
              <div
                className="rounded-full border border-[#e5e5e5]/80 bg-[#e5e5e5]/10 shrink-0 shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
                style={{
                  width: `${previewDiameter}px`,
                  height: `${previewDiameter}px`,
                }}
              />
            )}
          </div>
        )}
      </div>

      {/* Center Active Color Dot / Quick Swap */}
      <button
        type="button"
        onClick={onSwapColors}
        title="Active Color (Click to swap Primary/Secondary)"
        className="my-2 w-3.5 h-3.5 rounded-full shrink-0 cursor-pointer transition-transform hover:scale-115 shadow-[0_0_0_1px_rgba(255,255,255,0.22)]"
        style={{ backgroundColor: primaryColor }}
      />

      {/* Bottom Vertical Slider: Brush Opacity */}
      <div
        ref={opacityTrackRef}
        onPointerEnter={() => setHoveredTrack('opacity')}
        onPointerLeave={() => setHoveredTrack((prev) => (prev === 'opacity' ? null : prev))}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          setActiveDrag('opacity');
          updateOpacityFromPointer(e.clientY);
        }}
        onPointerMove={(e) => {
          if (activeDrag === 'opacity') {
            updateOpacityFromPointer(e.clientY);
          }
        }}
        onPointerUp={(e) => {
          if (activeDrag === 'opacity') {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
            setActiveDrag(null);
          }
        }}
        onPointerCancel={() => setActiveDrag(null)}
        title={`${usesStrength ? 'Strength' : 'Opacity'}: ${Math.round(opacityRatio * 100)}%`}
        className="relative w-4 h-28 flex items-center justify-center cursor-ns-resize touch-none group"
      >
        <div className="w-1.5 h-full rounded-full bg-[#161616] group-hover:bg-[#2c2c2c] relative overflow-hidden transition-colors">
          <div
            className="absolute bottom-0 left-0 right-0 rounded-full transition-[height] duration-75"
            style={{
              height: `${opacityRatio * 100}%`,
              backgroundColor: 'var(--accent)',
              opacity: 0.75,
            }}
          />
        </div>
        <div
          className="absolute left-1/2 -translate-x-1/2 w-3 h-3 rounded-full shadow-sm pointer-events-none transition-transform group-hover:scale-110"
          style={{
            bottom: `calc(${opacityRatio * 100}% - 6px)`,
            backgroundColor: 'var(--accent)',
          }}
        />

        {showOpacityHud && (
          <div className="pointer-events-none absolute left-8 top-1/2 -translate-y-1/2 px-2 py-1 rounded bg-[#202020] shadow-[0_4px_16px_rgba(0,0,0,0.6)] whitespace-nowrap flex items-center gap-1.5">
            <span className="text-[10px] text-[#8a8a8a]">
              {usesStrength ? 'Strength' : 'Opacity'}
            </span>
            <span className="text-[11px] font-mono text-[#e5e5e5] font-medium">
              {Math.round(opacityRatio * 100)}%
            </span>
          </div>
        )}
      </div>
    </div>
  );
});

FloatingBrushPill.displayName = 'FloatingBrushPill';
