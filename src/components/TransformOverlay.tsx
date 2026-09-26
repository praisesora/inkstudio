import React, { useRef, useLayoutEffect, useEffect } from 'react';
import { TransformSession } from '../types/editor';
import {
  Check,
  X,
  FlipHorizontal,
  FlipVertical,
  RotateCcw,
} from 'lucide-react';

interface TransformOverlayProps {
  session: TransformSession;
  zoom: number;
  rotation: number; // canvas viewport rotation
  onUpdateSession: (updater: (prev: TransformSession) => TransformSession) => void;
  onApply: () => void;
  onCancel: () => void;
}

export const TransformOverlay: React.FC<TransformOverlayProps> = ({
  session,
  zoom,
  rotation: canvasRotation,
  onUpdateSession,
  onApply,
  onCancel,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  // Synchronously draw the sourceCanvas into the preview canvas before paint
  useLayoutEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !session.sourceCanvas) return;
    canvas.width = session.sourceCanvas.width;
    canvas.height = session.sourceCanvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    try {
      const sCtx = session.sourceCanvas.getContext('2d');
      if (sCtx) {
        const imgData = sCtx.getImageData(0, 0, session.sourceCanvas.width, session.sourceCanvas.height);
        ctx.putImageData(imgData, 0, 0);
      } else {
        ctx.drawImage(session.sourceCanvas, 0, 0);
      }
    } catch {
      ctx.drawImage(session.sourceCanvas, 0, 0);
    }
  }, [session.sourceCanvas]);

  const activeDragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      if (activeDragCleanupRef.current) {
        activeDragCleanupRef.current();
      }
    };
  }, []);

  const startDrag = (
    mode: 'move' | 'rotate' | 'scale',
    e: React.PointerEvent,
    handle?: string
  ) => {
    e.stopPropagation();
    e.preventDefault();

    if (activeDragCleanupRef.current) {
      activeDragCleanupRef.current();
    }

    const startX = e.clientX;
    const startY = e.clientY;
    const initX = session.x;
    const initY = session.y;
    const initW = session.width;
    const initH = session.height;
    const initRot = session.rotation;

    const handlePointerMove = (ev: PointerEvent) => {
      const dxScreen = ev.clientX - startX;
      const dyScreen = ev.clientY - startY;

      // Un-rotate by viewport canvas rotation and scale by zoom
      const canvasRotRad = (-canvasRotation * Math.PI) / 180;
      const cCos = Math.cos(canvasRotRad);
      const cSin = Math.sin(canvasRotRad);
      const dxCanvas = (dxScreen * cCos - dyScreen * cSin) / zoom;
      const dyCanvas = (dxScreen * cSin + dyScreen * cCos) / zoom;

      if (mode === 'move') {
        let finalDx = dxCanvas;
        let finalDy = dyCanvas;
        if (ev.shiftKey) {
          // Axis-lock to horizontal or vertical
          if (Math.abs(finalDx) > Math.abs(finalDy)) {
            finalDy = 0;
          } else {
            finalDx = 0;
          }
        }
        onUpdateSession((prev) => ({
          ...prev,
          x: Math.round(initX + finalDx),
          y: Math.round(initY + finalDy),
        }));
      } else if (mode === 'rotate') {
        const centerX = initX + initW / 2;
        const centerY = initY + initH / 2;
        const cursorCanvasX = centerX + dxCanvas;
        const cursorCanvasY = centerY + dyCanvas;
        const angleRad = Math.atan2(cursorCanvasY - centerY, cursorCanvasX - centerX);
        let angleDeg = (angleRad * 180) / Math.PI + 90; // stem is on top (-90 deg from center)
        if (ev.shiftKey) {
          angleDeg = Math.round(angleDeg / 15) * 15;
        }
        onUpdateSession((prev) => ({
          ...prev,
          rotation: Math.round(((angleDeg % 360) + 360) % 360),
        }));
      } else if (mode === 'scale' && handle) {
        // Convert canvas delta into object's local rotated coordinate frame
        const objRotRad = (-initRot * Math.PI) / 180;
        const oCos = Math.cos(objRotRad);
        const oSin = Math.sin(objRotRad);
        const dxLocal = dxCanvas * oCos - dyCanvas * oSin;
        const dyLocal = dxCanvas * oSin + dyCanvas * oCos;

        const isLeft = handle.includes('w');
        const isRight = handle.includes('e');
        const isTop = handle.includes('n');
        const isBottom = handle.includes('s');

        let newW = initW;
        let newH = initH;
        let du = 0;
        let dv = 0;

        if (isRight) {
          newW = Math.max(10, initW + dxLocal);
          du = (newW - initW) / 2;
        } else if (isLeft) {
          newW = Math.max(10, initW - dxLocal);
          du = -(newW - initW) / 2;
        }

        if (isBottom) {
          newH = Math.max(10, initH + dyLocal);
          dv = (newH - initH) / 2;
        } else if (isTop) {
          newH = Math.max(10, initH - dyLocal);
          dv = -(newH - initH) / 2;
        }

        if (ev.shiftKey && (isLeft || isRight) && (isTop || isBottom)) {
          const scaleW = newW / initW;
          const scaleH = newH / initH;
          const scale = Math.max(scaleW, scaleH);
          newW = Math.max(10, Math.round(initW * scale));
          newH = Math.max(10, Math.round(initH * scale));
          du = isRight ? (newW - initW) / 2 : -(newW - initW) / 2;
          dv = isBottom ? (newH - initH) / 2 : -(newH - initH) / 2;
        }

        const objRotAngle = (initRot * Math.PI) / 180;
        const dCenterX = du * Math.cos(objRotAngle) - dv * Math.sin(objRotAngle);
        const dCenterY = du * Math.sin(objRotAngle) + dv * Math.cos(objRotAngle);

        const initCenterX = initX + initW / 2;
        const initCenterY = initY + initH / 2;
        const newCenterX = initCenterX + dCenterX;
        const newCenterY = initCenterY + dCenterY;

        onUpdateSession((prev) => ({
          ...prev,
          x: Math.round(newCenterX - newW / 2),
          y: Math.round(newCenterY - newH / 2),
          width: Math.round(newW),
          height: Math.round(newH),
        }));
      }
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      activeDragCleanupRef.current = null;
    };

    activeDragCleanupRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      activeDragCleanupRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handleFlipH = () => {
    onUpdateSession((prev) => ({ ...prev, flipH: !prev.flipH }));
  };

  const handleFlipV = () => {
    onUpdateSession((prev) => ({ ...prev, flipV: !prev.flipV }));
  };

  const handleReset = () => {
    onUpdateSession((prev) => ({
      ...prev,
      x: prev.bounds.x,
      y: prev.bounds.y,
      width: prev.bounds.width,
      height: prev.bounds.height,
      rotation: 0,
      flipH: false,
      flipV: false,
    }));
  };

  const handleSize = 8;

  return (
    <div
      ref={containerRef}
      className="absolute select-none z-30"
      style={{
        left: `${session.x}px`,
        top: `${session.y}px`,
        width: `${session.width}px`,
        height: `${session.height}px`,
        transform: `rotate(${session.rotation}deg)`,
        transformOrigin: '50% 50%',
      }}
    >
      {/* Transformed Content Preview */}
      <canvas
        ref={previewCanvasRef}
        className="w-full h-full pointer-events-none block"
        style={{
          transform: `scale(${session.flipH ? -1 : 1}, ${session.flipV ? -1 : 1})`,
          imageRendering: 'pixelated',
        }}
      />

      {/* Transform Bounding Box Outline (Drag Body to Move) */}
      <div
        onPointerDown={(e) => startDrag('move', e)}
        className="absolute inset-0 border-2 border-cyan-400 bg-cyan-400/5 cursor-move"
        title="Drag to Move (Shift to drag axis-locked)"
      />

      {/* Rotation Stem & Handle */}
      <div
        className="absolute left-1/2 -top-6 -translate-x-1/2 flex flex-col items-center pointer-events-auto"
        onPointerDown={(e) => startDrag('rotate', e)}
        title="Drag to Rotate (Shift snaps to 15°)"
      >
        <div className="w-3.5 h-3.5 rounded-full bg-cyan-400 border border-white shadow-md cursor-grab active:cursor-grabbing hover:scale-125 transition-transform" />
        <div className="w-0.5 h-2.5 bg-cyan-400" />
      </div>

      {/* Center Pivot Point */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full border border-cyan-400 bg-white pointer-events-none shadow-xs" />

      {/* 8 Resize Scale Handles */}
      {/* Top-Left */}
      <div
        onPointerDown={(e) => startDrag('scale', e, 'nw')}
        className="absolute -top-1.5 -left-1.5 bg-white border border-cyan-500 shadow-sm cursor-nwse-resize hover:scale-125 pointer-events-auto"
        style={{ width: `${handleSize}px`, height: `${handleSize}px` }}
      />
      {/* Top-Middle */}
      <div
        onPointerDown={(e) => startDrag('scale', e, 'n')}
        className="absolute -top-1.5 left-1/2 -translate-x-1/2 bg-white border border-cyan-500 shadow-sm cursor-ns-resize hover:scale-125 pointer-events-auto"
        style={{ width: `${handleSize}px`, height: `${handleSize}px` }}
      />
      {/* Top-Right */}
      <div
        onPointerDown={(e) => startDrag('scale', e, 'ne')}
        className="absolute -top-1.5 -right-1.5 bg-white border border-cyan-500 shadow-sm cursor-nesw-resize hover:scale-125 pointer-events-auto"
        style={{ width: `${handleSize}px`, height: `${handleSize}px` }}
      />
      {/* Right-Middle */}
      <div
        onPointerDown={(e) => startDrag('scale', e, 'e')}
        className="absolute top-1/2 -right-1.5 -translate-y-1/2 bg-white border border-cyan-500 shadow-sm cursor-ew-resize hover:scale-125 pointer-events-auto"
        style={{ width: `${handleSize}px`, height: `${handleSize}px` }}
      />
      {/* Bottom-Right */}
      <div
        onPointerDown={(e) => startDrag('scale', e, 'se')}
        className="absolute -bottom-1.5 -right-1.5 bg-white border border-cyan-500 shadow-sm cursor-nwse-resize hover:scale-125 pointer-events-auto"
        style={{ width: `${handleSize}px`, height: `${handleSize}px` }}
      />
      {/* Bottom-Middle */}
      <div
        onPointerDown={(e) => startDrag('scale', e, 's')}
        className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 bg-white border border-cyan-500 shadow-sm cursor-ns-resize hover:scale-125 pointer-events-auto"
        style={{ width: `${handleSize}px`, height: `${handleSize}px` }}
      />
      {/* Bottom-Left */}
      <div
        onPointerDown={(e) => startDrag('scale', e, 'sw')}
        className="absolute -bottom-1.5 -left-1.5 bg-white border border-cyan-500 shadow-sm cursor-nesw-resize hover:scale-125 pointer-events-auto"
        style={{ width: `${handleSize}px`, height: `${handleSize}px` }}
      />
      {/* Left-Middle */}
      <div
        onPointerDown={(e) => startDrag('scale', e, 'w')}
        className="absolute top-1/2 -left-1.5 -translate-y-1/2 bg-white border border-cyan-500 shadow-sm cursor-ew-resize hover:scale-125 pointer-events-auto"
        style={{ width: `${handleSize}px`, height: `${handleSize}px` }}
      />

      {/* Floating Action Bar (Directly below transform box) */}
      <div
        className="absolute left-1/2 -bottom-12 -translate-x-1/2 bg-[#1b1c1e] border border-[#33353b] rounded shadow-xl px-2 py-1 flex items-center space-x-1.5 z-40 whitespace-nowrap"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Confirm (Enter) */}
        <button
          onClick={onApply}
          title="Apply Transform (Enter)"
          className="px-2 py-1 bg-[#234b3e] hover:bg-[#2b604f] text-[#55eaab] border border-[#2e6e58] rounded text-xs font-semibold flex items-center space-x-1 cursor-pointer transition-colors"
        >
          <Check className="w-3.5 h-3.5" />
          <span>Apply</span>
        </button>

        {/* Cancel (Esc) */}
        <button
          onClick={onCancel}
          title="Cancel Transform (Esc)"
          className="px-2 py-1 bg-[#3a2024] hover:bg-[#4d282e] text-[#f87171] border border-[#6b2c34] rounded text-xs font-semibold flex items-center space-x-1 cursor-pointer transition-colors"
        >
          <X className="w-3.5 h-3.5" />
          <span>Cancel</span>
        </button>

        <div className="w-px h-4 bg-[#33353b]" />

        {/* Flip Horizontal */}
        <button
          onClick={handleFlipH}
          title="Flip Horizontal"
          className={`p-1 text-[#8c9099] hover:text-white hover:bg-[#2b2d31] rounded transition-colors cursor-pointer ${
            session.flipH ? 'bg-cyan-500/20 text-cyan-300' : ''
          }`}
        >
          <FlipHorizontal className="w-3.5 h-3.5" />
        </button>

        {/* Flip Vertical */}
        <button
          onClick={handleFlipV}
          title="Flip Vertical"
          className={`p-1 text-[#8c9099] hover:text-white hover:bg-[#2b2d31] rounded transition-colors cursor-pointer ${
            session.flipV ? 'bg-cyan-500/20 text-cyan-300' : ''
          }`}
        >
          <FlipVertical className="w-3.5 h-3.5" />
        </button>

        {/* Reset */}
        <button
          onClick={handleReset}
          title="Reset Transform"
          className="p-1 text-[#8c9099] hover:text-white hover:bg-[#2b2d31] rounded transition-colors cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
