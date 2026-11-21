import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { Lock, Unlock, Magnet, Crosshair, X, Move, RotateCw } from 'lucide-react';
import { StraightRuler } from '../types/perspective';
import { CanvasDimensions } from '../types/editor';
import { CanvasNavigationHandle } from '../hooks/useCanvasNavigation';
import { canvasToScreen, screenToCanvas } from '../utils/canvasUtils';
import {
  getStraightRulerDirection,
  normalizeRulerAngle,
  snapAngleToStep,
} from '../utils/straightRulerMath';

interface StraightRulerOverlayProps {
  ruler: StraightRuler;
  onUpdateRuler: (updated: StraightRuler) => void;
  onCloseRuler: () => void;
  dimensions: CanvasDimensions;
  pan: { x: number; y: number };
  zoom: number;
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
  navigation?: CanvasNavigationHandle;
  viewportRef: React.RefObject<HTMLDivElement | null>;
}

const ROTATE_HANDLE_SCREEN_DIST = 136;
const RULER_BAR_HALF_THICKNESS = 14;

export const StraightRulerOverlay: React.FC<StraightRulerOverlayProps> = ({
  ruler,
  onUpdateRuler,
  onCloseRuler,
  dimensions,
  pan,
  zoom,
  rotation,
  flipX = false,
  flipY = false,
  navigation,
  viewportRef,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const moveHandleRef = useRef<HTMLDivElement | null>(null);
  const rotLeftHandleRef = useRef<HTMLDivElement | null>(null);
  const rotRightHandleRef = useRef<HTMLDivElement | null>(null);

  const [dragMode, setDragMode] = useState<'move' | 'rotate-left' | 'rotate-right' | null>(null);
  const dragMetaRef = useRef<{
    pointerId: number | null;
    capturedEl: HTMLElement | null;
    startDocX: number;
    startDocY: number;
    initialRulerX: number;
    initialRulerY: number;
    initialAngle: number;
    startPointerAngle: number;
  }>({
    pointerId: null,
    capturedEl: null,
    startDocX: 0,
    startDocY: 0,
    initialRulerX: 0,
    initialRulerY: 0,
    initialAngle: 0,
    startPointerAngle: 0,
  });

  const propsRef = useRef({
    ruler,
    dimensions,
    pan,
    zoom,
    rotation,
    flipX,
    flipY,
    navigation,
    onUpdateRuler,
  });
  propsRef.current = {
    ruler,
    dimensions,
    pan,
    zoom,
    rotation,
    flipX,
    flipY,
    navigation,
    onUpdateRuler,
  };

  const getLiveCamera = useCallback(() => {
    const p = propsRef.current;
    return p.navigation
      ? p.navigation.getCameraState()
      : {
          pan: p.pan,
          zoom: p.zoom,
          rotation: p.rotation,
          flipX: p.flipX,
          flipY: p.flipY,
        };
  }, []);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;

    const vRect = viewport.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.max(1, Math.round(vRect.width * dpr));
    const targetH = Math.max(1, Math.round(vRect.height * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, vRect.width, vRect.height);

    const { ruler: curRuler, dimensions: dims } = propsRef.current;
    if (!curRuler.enabled) {
      ctx.restore();
      return;
    }

    const cam = getLiveCamera();
    const dir = getStraightRulerDirection(curRuler.angle);
    const p0 = canvasToScreen(
      curRuler.x,
      curRuler.y,
      cam.pan,
      cam.zoom,
      cam.rotation,
      dims,
      cam.flipX,
      cam.flipY
    );
    const p1 = canvasToScreen(
      curRuler.x + dir.x * 100,
      curRuler.y + dir.y * 100,
      cam.pan,
      cam.zoom,
      cam.rotation,
      dims,
      cam.flipX,
      cam.flipY
    );

    const sdx = p1.x - p0.x;
    const sdy = p1.y - p0.y;
    const sLen = Math.hypot(sdx, sdy) || 1;
    const ux = sdx / sLen;
    const uy = sdy / sLen;
    const screenAngle = Math.atan2(uy, ux);

    // Position DOM handles synchronously for zero-React-rerender 60-240Hz camera tracking
    const posEl = (el: HTMLDivElement | null, x: number, y: number) => {
      if (!el) return;
      el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    };
    posEl(moveHandleRef.current, p0.x, p0.y);
    posEl(
      rotLeftHandleRef.current,
      p0.x - ux * ROTATE_HANDLE_SCREEN_DIST,
      p0.y - uy * ROTATE_HANDLE_SCREEN_DIST
    );
    posEl(
      rotRightHandleRef.current,
      p0.x + ux * ROTATE_HANDLE_SCREEN_DIST,
      p0.y + uy * ROTATE_HANDLE_SCREEN_DIST
    );

    const span = Math.hypot(vRect.width, vRect.height) + 200;
    const accentHex = curRuler.locked
      ? '#f59e0b'
      : curRuler.snapEnabled
      ? '#38bdf8'
      : '#a3a3a3';

    ctx.save();
    ctx.translate(p0.x, p0.y);
    ctx.rotate(screenAngle);

    // Translucent straightedge body
    ctx.fillStyle = curRuler.locked
      ? 'rgba(245, 158, 11, 0.08)'
      : 'rgba(56, 189, 248, 0.08)';
    ctx.fillRect(-span, -RULER_BAR_HALF_THICKNESS, span * 2, RULER_BAR_HALF_THICKNESS * 2);

    // Top & bottom subtle borders
    ctx.strokeStyle = curRuler.locked
      ? 'rgba(245, 158, 11, 0.32)'
      : 'rgba(56, 189, 248, 0.34)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-span, -RULER_BAR_HALF_THICKNESS);
    ctx.lineTo(span, -RULER_BAR_HALF_THICKNESS);
    ctx.moveTo(-span, RULER_BAR_HALF_THICKNESS);
    ctx.lineTo(span, RULER_BAR_HALF_THICKNESS);
    ctx.stroke();

    // Adaptive document-pixel tick marks along top & bottom edges
    const rawStep = 10 / Math.max(0.05, cam.zoom);
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, rawStep))));
    const normStep = rawStep / mag;
    const docStep =
      normStep <= 1 ? mag : normStep <= 2 ? 2 * mag : normStep <= 5 ? 5 * mag : 10 * mag;
    const screenStep = docStep * cam.zoom;

    if (screenStep >= 4) {
      const maxTicks = Math.min(260, Math.ceil(span / screenStep));
      ctx.strokeStyle = curRuler.locked
        ? 'rgba(245, 158, 11, 0.45)'
        : 'rgba(56, 189, 248, 0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = -maxTicks; i <= maxTicks; i++) {
        const tx = i * screenStep;
        const isMajor = i % 5 === 0;
        const tickLen = isMajor ? 7 : 3.5;
        ctx.moveTo(tx, -RULER_BAR_HALF_THICKNESS);
        ctx.lineTo(tx, -RULER_BAR_HALF_THICKNESS + tickLen);
        ctx.moveTo(tx, RULER_BAR_HALF_THICKNESS);
        ctx.lineTo(tx, RULER_BAR_HALF_THICKNESS - tickLen);
      }
      ctx.stroke();
    }

    // Crisp centerline snap axis
    ctx.strokeStyle = accentHex;
    ctx.lineWidth = curRuler.snapEnabled ? 1.5 : 1;
    if (!curRuler.snapEnabled) {
      ctx.setLineDash([6, 4]);
    }
    ctx.beginPath();
    ctx.moveTo(-span, 0);
    ctx.lineTo(span, 0);
    ctx.stroke();
    ctx.setLineDash([]);

    // Small pivot crosshair when locked (non-interactive visual anchor)
    if (curRuler.locked) {
      ctx.strokeStyle = accentHex;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
    ctx.restore();
  }, [getLiveCamera, viewportRef]);

  useLayoutEffect(() => {
    render();
  }, [render, ruler, dimensions, pan, zoom, rotation, flipX, flipY]);

  useEffect(() => {
    if (!navigation) return;
    return navigation.subscribeCamera(() => {
      render();
    });
  }, [navigation, render]);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const handleResize = () => render();
    window.addEventListener('resize', handleResize);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleResize) : null;
    ro?.observe(vp);
    return () => {
      window.removeEventListener('resize', handleResize);
      ro?.disconnect();
    };
  }, [render, viewportRef]);

  const startHandleDrag = (
    mode: 'move' | 'rotate-left' | 'rotate-right',
    e: React.PointerEvent<HTMLDivElement>
  ) => {
    if (ruler.locked || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const vp = viewportRef.current;
    if (!vp) return;
    const targetEl = e.currentTarget;
    try {
      targetEl.setPointerCapture(e.pointerId);
    } catch {}
    const vRect = vp.getBoundingClientRect();
    const cam = getLiveCamera();
    const docPt = screenToCanvas(
      e.clientX,
      e.clientY,
      vRect,
      cam.pan,
      cam.zoom,
      cam.rotation,
      dimensions,
      cam.flipX,
      cam.flipY
    );
    const startPointerAngle =
      (Math.atan2(docPt.y - ruler.y, docPt.x - ruler.x) * 180) / Math.PI;
    dragMetaRef.current = {
      pointerId: e.pointerId,
      capturedEl: targetEl,
      startDocX: docPt.x,
      startDocY: docPt.y,
      initialRulerX: ruler.x,
      initialRulerY: ruler.y,
      initialAngle: ruler.angle,
      startPointerAngle,
    };
    setDragMode(mode);
  };

  useEffect(() => {
    if (!dragMode) return;
    const handleMove = (e: PointerEvent) => {
      const m = dragMetaRef.current;
      if (m.pointerId !== null && e.pointerId !== m.pointerId) return;
      const vp = viewportRef.current;
      if (!vp) return;
      const p = propsRef.current;
      if (p.ruler.locked) return;
      const vRect = vp.getBoundingClientRect();
      const cam = getLiveCamera();
      const docPt = screenToCanvas(
        e.clientX,
        e.clientY,
        vRect,
        cam.pan,
        cam.zoom,
        cam.rotation,
        p.dimensions,
        cam.flipX,
        cam.flipY
      );

      if (dragMode === 'move') {
        p.onUpdateRuler({
          ...p.ruler,
          x: m.initialRulerX + (docPt.x - m.startDocX),
          y: m.initialRulerY + (docPt.y - m.startDocY),
        });
      } else {
        const dx = docPt.x - p.ruler.x;
        const dy = docPt.y - p.ruler.y;
        if (Math.hypot(dx, dy) < 1e-3) return;
        const curPointerAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
        const delta = curPointerAngle - m.startPointerAngle;
        const rawNext = m.initialAngle + delta;
        const nextAngle = e.shiftKey
          ? snapAngleToStep(rawNext, 15)
          : normalizeRulerAngle(rawNext);
        p.onUpdateRuler({
          ...p.ruler,
          angle: nextAngle,
        });
      }
    };

    const releaseCapture = () => {
      const m = dragMetaRef.current;
      if (m.capturedEl && m.pointerId !== null) {
        try {
          if (m.capturedEl.hasPointerCapture(m.pointerId)) {
            m.capturedEl.releasePointerCapture(m.pointerId);
          }
        } catch {}
      }
      m.capturedEl = null;
      m.pointerId = null;
    };

    const handleUp = (e: PointerEvent) => {
      if (dragMetaRef.current.pointerId !== null && e.pointerId !== dragMetaRef.current.pointerId) {
        return;
      }
      releaseCapture();
      setDragMode(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      releaseCapture();
    };
  }, [dragMode, getLiveCamera, viewportRef]);

  const handleRecenter = () => {
    const vp = viewportRef.current;
    if (!vp) {
      onUpdateRuler({
        ...ruler,
        x: dimensions.width * 0.5,
        y: dimensions.height * 0.5,
      });
      return;
    }
    const vRect = vp.getBoundingClientRect();
    const cam = getLiveCamera();
    const center = screenToCanvas(
      vRect.left + vRect.width * 0.5,
      vRect.top + vRect.height * 0.5,
      vRect,
      cam.pan,
      cam.zoom,
      cam.rotation,
      dimensions,
      cam.flipX,
      cam.flipY
    );
    onUpdateRuler({
      ...ruler,
      x: center.x,
      y: center.y,
    });
  };

  if (!ruler.enabled) return null;

  return (
    <div
      data-testid="straight-ruler-overlay"
      className="absolute inset-0 pointer-events-none z-30 overflow-hidden select-none"
    >
      {/* 60-240Hz Vector Ruler Canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full pointer-events-none"
      />

      {/* Interactive Move & Rotate Handles (disabled & hidden when locked) */}
      {!ruler.locked && (
        <>
          <div
            ref={moveHandleRef}
            data-testid="straight-ruler-move-handle"
            onPointerDown={(e) => startHandleDrag('move', e)}
            title="Drag to move ruler"
            className="absolute top-0 left-0 pointer-events-auto cursor-move group"
          >
            <div className="w-7 h-7 rounded-full bg-[#1a1a1a]/90 border-2 border-sky-400 text-sky-300 shadow-lg flex items-center justify-center transition-transform duration-100 group-hover:scale-110 group-active:scale-95">
              <Move className="w-3.5 h-3.5" />
            </div>
          </div>

          <div
            ref={rotLeftHandleRef}
            data-testid="straight-ruler-rotate-left"
            onPointerDown={(e) => startHandleDrag('rotate-left', e)}
            title="Drag to rotate ruler (hold Shift for 15° snap)"
            className="absolute top-0 left-0 pointer-events-auto cursor-grab active:cursor-grabbing group"
          >
            <div className="w-6 h-6 rounded-full bg-[#1a1a1a]/90 border-2 border-sky-400 text-sky-300 shadow-lg flex items-center justify-center transition-transform duration-100 group-hover:scale-110 group-active:scale-95">
              <RotateCw className="w-3 h-3" />
            </div>
          </div>

          <div
            ref={rotRightHandleRef}
            data-testid="straight-ruler-rotate-right"
            onPointerDown={(e) => startHandleDrag('rotate-right', e)}
            title="Drag to rotate ruler (hold Shift for 15° snap)"
            className="absolute top-0 left-0 pointer-events-auto cursor-grab active:cursor-grabbing group"
          >
            <div className="w-6 h-6 rounded-full bg-[#1a1a1a]/90 border-2 border-sky-400 text-sky-300 shadow-lg flex items-center justify-center transition-transform duration-100 group-hover:scale-110 group-active:scale-95">
              <RotateCw className="w-3 h-3" />
            </div>
          </div>
        </>
      )}

      {/* Compact Top-Center Ruler Control Pill */}
      <div
        data-testid="straight-ruler-controls"
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => {
          if (ruler.locked) return;
          e.preventDefault();
          const step = e.shiftKey ? 15 : 1;
          const dir = e.deltaY < 0 ? 1 : -1;
          onUpdateRuler({
            ...ruler,
            angle: normalizeRulerAngle(ruler.angle + dir * step),
          });
        }}
        className="absolute top-3 left-1/2 -translate-x-1/2 pointer-events-auto flex items-center gap-1 px-2 py-1 rounded-md bg-[#202020]/95 border border-white/[0.12] shadow-xl text-[11px] text-[#e5e5e5] backdrop-blur-sm"
      >
        <span
          className="font-mono text-[11px] text-sky-300 min-w-[46px] text-center"
          title="Scroll to adjust angle (Shift+Scroll for 15°)"
          data-testid="straight-ruler-angle-readout"
        >
          {ruler.angle.toFixed(1)}°
        </span>

        {!ruler.locked && (
          <div className="flex items-center gap-0.5 border-l border-white/[0.08] pl-1">
            {[0, 45, 90].map((deg) => (
              <button
                key={deg}
                type="button"
                onClick={() => onUpdateRuler({ ...ruler, angle: deg })}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer transition-colors ${
                  Math.abs(ruler.angle - deg) < 0.05
                    ? 'bg-[#2c2c2c] text-sky-300'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                }`}
                title={`Set ruler angle to ${deg}°`}
              >
                {deg}°
              </button>
            ))}
          </div>
        )}

        <div className="h-3.5 w-px bg-white/[0.1] mx-0.5" />

        <button
          type="button"
          data-testid="straight-ruler-lock-btn"
          onClick={() => onUpdateRuler({ ...ruler, locked: !ruler.locked })}
          title={ruler.locked ? 'Unlock Ruler Position & Angle' : 'Lock Ruler in Place'}
          aria-pressed={ruler.locked}
          className={`px-1.5 py-0.5 rounded flex items-center gap-1 cursor-pointer transition-colors ${
            ruler.locked
              ? 'bg-amber-500/20 text-amber-300 border border-amber-400/30'
              : 'text-[#cccccc] hover:text-white hover:bg-[#2c2c2c]'
          }`}
        >
          {ruler.locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
          <span>{ruler.locked ? 'Locked' : 'Lock'}</span>
        </button>

        <button
          type="button"
          data-testid="straight-ruler-snap-btn"
          onClick={() => onUpdateRuler({ ...ruler, snapEnabled: !ruler.snapEnabled })}
          title={ruler.snapEnabled ? 'Disable Snapping (or hold Alt while drawing)' : 'Enable Snapping'}
          aria-pressed={ruler.snapEnabled}
          className={`w-6 h-5 rounded flex items-center justify-center cursor-pointer transition-colors ${
            ruler.snapEnabled
              ? 'bg-sky-500/20 text-sky-300'
              : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
          }`}
        >
          <Magnet className="w-3 h-3" />
        </button>

        {!ruler.locked && (
          <button
            type="button"
            data-testid="straight-ruler-center-btn"
            onClick={handleRecenter}
            title="Center Ruler in Viewport"
            className="w-6 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer transition-colors"
          >
            <Crosshair className="w-3 h-3" />
          </button>
        )}

        <button
          type="button"
          data-testid="straight-ruler-close-btn"
          onClick={onCloseRuler}
          title="Hide Ruler (R)"
          className="w-6 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-rose-400 hover:bg-[#2c2c2c] cursor-pointer transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
};
