import React, { useRef, useLayoutEffect, useEffect, useMemo } from 'react';
import { TransformSession, Point2D, TransformMode } from '../types/editor';
import {
  Check,
  X,
  FlipHorizontal,
  FlipVertical,
  RotateCcw,
  BoxSelect,
  Grid3X3,
  Square,
} from 'lucide-react';
import {
  renderPerspectiveQuad,
  renderMeshWarp,
  createDefaultPerspectiveQuad,
  createDefaultMeshPoints,
  getPointsBounds,
  evaluateMeshSurface,
} from '../utils/transformEngine';

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
  const activeDragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      if (activeDragCleanupRef.current) {
        activeDragCleanupRef.current();
      }
    };
  }, []);

  const mode: TransformMode = session.mode || 'affine';

  // Ensure perspectiveQuad exists
  const quad: [Point2D, Point2D, Point2D, Point2D] = useMemo(() => {
    if (session.perspectiveQuad) return session.perspectiveQuad;
    return createDefaultPerspectiveQuad(
      session.x,
      session.y,
      session.width,
      session.height,
      session.rotation
    );
  }, [session.perspectiveQuad, session.x, session.y, session.width, session.height, session.rotation]);

  // Ensure meshPoints exists
  const meshPoints: Point2D[][] = useMemo(() => {
    if (session.meshPoints) return session.meshPoints;
    const cols = session.meshCols || 4;
    const rows = session.meshRows || 4;
    return createDefaultMeshPoints(quad, cols, rows);
  }, [session.meshPoints, quad, session.meshCols, session.meshRows]);

  // Compute bounding box for perspective or mesh mode
  const nonAffineBounds = useMemo(() => {
    if (mode === 'perspective') {
      return getPointsBounds(quad);
    }
    if (mode === 'mesh') {
      const flat: Point2D[] = [];
      for (const row of meshPoints) {
        for (const pt of row) flat.push(pt);
      }
      return getPointsBounds(flat);
    }
    if (session.rotation) {
      const cx = session.x + session.width / 2;
      const cy = session.y + session.height / 2;
      const hw = session.width / 2;
      const hh = session.height / 2;
      const rad = (session.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const corners: Point2D[] = [
        { x: -hw, y: -hh },
        { x: hw, y: -hh },
        { x: hw, y: hh },
        { x: -hw, y: hh },
      ].map((p) => ({
        x: cx + p.x * cos - p.y * sin,
        y: cy + p.x * sin + p.y * cos,
      }));
      return getPointsBounds(corners);
    }
    return {
      minX: session.x,
      minY: session.y,
      maxX: session.x + session.width,
      maxY: session.y + session.height,
      width: session.width,
      height: session.height,
    };
  }, [mode, quad, meshPoints, session.x, session.y, session.width, session.height, session.rotation]);

  // Synchronously draw preview in layout effect
  useLayoutEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !session.sourceCanvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (mode === 'affine') {
      canvas.width = session.sourceCanvas.width;
      canvas.height = session.sourceCanvas.height;
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
    } else if (mode === 'perspective') {
      const bw = Math.max(10, nonAffineBounds.width);
      const bh = Math.max(10, nonAffineBounds.height);
      canvas.width = bw;
      canvas.height = bh;
      ctx.clearRect(0, 0, bw, bh);

      // Shift quad into local canvas coordinates
      const localQuad: [Point2D, Point2D, Point2D, Point2D] = [
        { x: quad[0].x - nonAffineBounds.minX, y: quad[0].y - nonAffineBounds.minY },
        { x: quad[1].x - nonAffineBounds.minX, y: quad[1].y - nonAffineBounds.minY },
        { x: quad[2].x - nonAffineBounds.minX, y: quad[2].y - nonAffineBounds.minY },
        { x: quad[3].x - nonAffineBounds.minX, y: quad[3].y - nonAffineBounds.minY },
      ];

      renderPerspectiveQuad(ctx, session.sourceCanvas, localQuad, 16);
    } else if (mode === 'mesh') {
      const bw = Math.max(10, nonAffineBounds.width);
      const bh = Math.max(10, nonAffineBounds.height);
      canvas.width = bw;
      canvas.height = bh;
      ctx.clearRect(0, 0, bw, bh);

      // Shift mesh into local canvas coordinates
      const localMesh: Point2D[][] = meshPoints.map((row) =>
        row.map((pt) => ({
          x: pt.x - nonAffineBounds.minX,
          y: pt.y - nonAffineBounds.minY,
        }))
      );

      renderMeshWarp(ctx, session.sourceCanvas, localMesh, 4);
    }
  }, [mode, session.sourceCanvas, nonAffineBounds, quad, meshPoints]);

  // Mode switching handler
  const handleSwitchMode = (newMode: TransformMode) => {
    if (newMode === mode) return;

    onUpdateSession((prev) => {
      const q = prev.perspectiveQuad || createDefaultPerspectiveQuad(prev.x, prev.y, prev.width, prev.height, prev.rotation);
      const cols = prev.meshCols || 4;
      const rows = prev.meshRows || 4;
      const m = prev.meshPoints || createDefaultMeshPoints(q, cols, rows);

      return {
        ...prev,
        mode: newMode,
        perspectiveQuad: q,
        meshCols: cols,
        meshRows: rows,
        meshPoints: m,
      };
    });
  };

  // Mesh resolution change handler
  const handleChangeMeshGrid = (size: number) => {
    onUpdateSession((prev) => {
      const existingMesh = prev.meshPoints || meshPoints;
      const newMesh: Point2D[][] = [];

      for (let r = 0; r < size; r++) {
        const v = size > 1 ? r / (size - 1) : 0;
        const row: Point2D[] = [];
        for (let c = 0; c < size; c++) {
          const u = size > 1 ? c / (size - 1) : 0;
          // Resample position from existing surface
          const evaluated = evaluateMeshSurface(existingMesh, u, v);
          row.push({ x: Math.round(evaluated.x), y: Math.round(evaluated.y) });
        }
        newMesh.push(row);
      }

      return {
        ...prev,
        meshCols: size,
        meshRows: size,
        meshPoints: newMesh,
      };
    });
  };

  // Convert screen delta to un-rotated canvas coordinates
  const screenDeltaToCanvas = (dxScreen: number, dyScreen: number): { dx: number; dy: number } => {
    const canvasRotRad = (-canvasRotation * Math.PI) / 180;
    const cCos = Math.cos(canvasRotRad);
    const cSin = Math.sin(canvasRotRad);
    return {
      dx: (dxScreen * cCos - dyScreen * cSin) / zoom,
      dy: (dxScreen * cSin + dyScreen * cCos) / zoom,
    };
  };

  // Start dragging a perspective corner pin
  const startDragPerspectiveCorner = (index: number, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (activeDragCleanupRef.current) activeDragCleanupRef.current();

    const startX = e.clientX;
    const startY = e.clientY;
    const initialPoint = { ...quad[index] };

    const handlePointerMove = (ev: PointerEvent) => {
      const { dx, dy } = screenDeltaToCanvas(ev.clientX - startX, ev.clientY - startY);
      onUpdateSession((prev) => {
        const currentQuad = prev.perspectiveQuad ? [...prev.perspectiveQuad] : [...quad];
        currentQuad[index] = {
          x: Math.round(initialPoint.x + dx),
          y: Math.round(initialPoint.y + dy),
        };
        return {
          ...prev,
          perspectiveQuad: currentQuad as [Point2D, Point2D, Point2D, Point2D],
        };
      });
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      activeDragCleanupRef.current = null;
    };

    activeDragCleanupRef.current = handlePointerUp;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  // Start dragging a mesh control point
  const startDragMeshPoint = (row: number, col: number, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (activeDragCleanupRef.current) activeDragCleanupRef.current();

    const startX = e.clientX;
    const startY = e.clientY;
    const initialPoint = { ...meshPoints[row][col] };

    const handlePointerMove = (ev: PointerEvent) => {
      const { dx, dy } = screenDeltaToCanvas(ev.clientX - startX, ev.clientY - startY);
      onUpdateSession((prev) => {
        const currentMesh = (prev.meshPoints || meshPoints).map((r) => [...r]);
        currentMesh[row][col] = {
          x: Math.round(initialPoint.x + dx),
          y: Math.round(initialPoint.y + dy),
        };
        return {
          ...prev,
          meshPoints: currentMesh,
        };
      });
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      activeDragCleanupRef.current = null;
    };

    activeDragCleanupRef.current = handlePointerUp;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  // Start dragging affine handles (Move, Rotate, Scale)
  const startDragAffine = (
    dragMode: 'move' | 'rotate' | 'scale',
    e: React.PointerEvent,
    handle?: string
  ) => {
    e.stopPropagation();
    e.preventDefault();

    if (activeDragCleanupRef.current) activeDragCleanupRef.current();

    const startX = e.clientX;
    const startY = e.clientY;
    const initX = session.x;
    const initY = session.y;
    const initW = session.width;
    const initH = session.height;
    const initRot = session.rotation;

    const handlePointerMove = (ev: PointerEvent) => {
      const { dx, dy } = screenDeltaToCanvas(ev.clientX - startX, ev.clientY - startY);

      if (dragMode === 'move') {
        let finalDx = dx;
        let finalDy = dy;
        if (ev.shiftKey) {
          if (Math.abs(finalDx) > Math.abs(finalDy)) finalDy = 0;
          else finalDx = 0;
        }
        onUpdateSession((prev) => ({
          ...prev,
          x: Math.round(initX + finalDx),
          y: Math.round(initY + finalDy),
        }));
      } else if (dragMode === 'rotate') {
        const centerX = initX + initW / 2;
        const centerY = initY + initH / 2;
        const cursorCanvasX = centerX + dx;
        const cursorCanvasY = centerY + dy;
        const angleRad = Math.atan2(cursorCanvasY - centerY, cursorCanvasX - centerX);
        let angleDeg = (angleRad * 180) / Math.PI + 90;
        if (ev.shiftKey) {
          angleDeg = Math.round(angleDeg / 15) * 15;
        }
        onUpdateSession((prev) => ({
          ...prev,
          rotation: Math.round(((angleDeg % 360) + 360) % 360),
        }));
      } else if (dragMode === 'scale' && handle) {
        const objRotRad = (-initRot * Math.PI) / 180;
        const oCos = Math.cos(objRotRad);
        const oSin = Math.sin(objRotRad);
        const dxLocal = dx * oCos - dy * oSin;
        const dyLocal = dx * oSin + dy * oCos;

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
          const scale = Math.max(newW / initW, newH / initH);
          newW = Math.max(10, Math.round(initW * scale));
          newH = Math.max(10, Math.round(initH * scale));
          du = isRight ? (newW - initW) / 2 : -(newW - initW) / 2;
          dv = isBottom ? (newH - initH) / 2 : -(newH - initH) / 2;
        }

        const objRotAngle = (initRot * Math.PI) / 180;
        const dCenterX = du * Math.cos(objRotAngle) - dv * Math.sin(objRotAngle);
        const dCenterY = du * Math.sin(objRotAngle) + dv * Math.cos(objRotAngle);

        onUpdateSession((prev) => ({
          ...prev,
          x: Math.round(initX + initW / 2 + dCenterX - newW / 2),
          y: Math.round(initY + initH / 2 + dCenterY - newH / 2),
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

    activeDragCleanupRef.current = handlePointerUp;
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
    onUpdateSession((prev) => {
      const defQuad = createDefaultPerspectiveQuad(prev.bounds.x, prev.bounds.y, prev.bounds.width, prev.bounds.height, 0);
      return {
        ...prev,
        x: prev.bounds.x,
        y: prev.bounds.y,
        width: prev.bounds.width,
        height: prev.bounds.height,
        rotation: 0,
        flipH: false,
        flipV: false,
        perspectiveQuad: defQuad,
        meshPoints: createDefaultMeshPoints(defQuad, prev.meshCols || 4, prev.meshRows || 4),
      };
    });
  };

  const invZoom = zoom > 0 ? 1 / zoom : 1;
  const handleSize = 8;
  const pinSize = 10;

  return (
    <>
      {/* 1. Affine Mode Container */}
      {mode === 'affine' && (
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
          {/* Preview Canvas */}
          <canvas
            ref={previewCanvasRef}
            className="w-full h-full pointer-events-none block"
            style={{
              transform: `scale(${session.flipH ? -1 : 1}, ${session.flipV ? -1 : 1})`,
              imageRendering: 'pixelated',
            }}
          />

          {/* Bounding Box Outline (Drag Body to Move) */}
          <div
            onPointerDown={(e) => startDragAffine('move', e)}
            className="absolute inset-0 border-2 border-cyan-400 bg-cyan-400/5 cursor-move"
            title="Drag to Move"
          />

          {/* Rotation Stem & Handle */}
          <div
            className="absolute left-1/2 top-0 flex flex-col items-center pointer-events-auto"
            style={{
              transform: `translateX(-50%) translateY(calc(-100% - ${4 * invZoom}px)) scale(${invZoom})`,
              transformOrigin: 'bottom center',
            }}
            onPointerDown={(e) => startDragAffine('rotate', e)}
            title="Drag to Rotate"
          >
            <div className="w-3.5 h-3.5 rounded-full bg-cyan-400 border border-white shadow-md cursor-grab active:cursor-grabbing hover:scale-125 transition-transform" />
            <div className="w-0.5 h-2.5 bg-cyan-400" />
          </div>

          {/* Center Pivot Point */}
          <div
            className="absolute left-1/2 top-1/2 w-2 h-2 rounded-full border border-cyan-400 bg-white pointer-events-none shadow-xs"
            style={{
              transform: `translate(-50%, -50%) scale(${invZoom})`,
              transformOrigin: 'center',
            }}
          />

          {/* 8 Resize Scale Handles */}
          {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((h) => {
            const left = h.includes('w') ? '0%' : h.includes('e') ? '100%' : '50%';
            const top = h.includes('n') ? '0%' : h.includes('s') ? '100%' : '50%';
            const cursor =
              h === 'nw' || h === 'se'
                ? 'nwse-resize'
                : h === 'ne' || h === 'sw'
                ? 'nesw-resize'
                : h === 'n' || h === 's'
                ? 'ns-resize'
                : 'ew-resize';

            return (
              <div
                key={h}
                onPointerDown={(e) => startDragAffine('scale', e, h)}
                className={`absolute bg-white border border-cyan-500 shadow-sm cursor-${cursor} hover:scale-125 pointer-events-auto`}
                style={{
                  left,
                  top,
                  width: `${handleSize}px`,
                  height: `${handleSize}px`,
                  transform: `translate(-50%, -50%) scale(${invZoom})`,
                  transformOrigin: 'center',
                }}
              />
            );
          })}
        </div>
      )}

      {/* 2. Perspective or Mesh Warp Preview Canvas & Handles Container */}
      {(mode === 'perspective' || mode === 'mesh') && (
        <>
          {/* Deformed Preview Canvas */}
          <div
            className="absolute pointer-events-none z-30"
            style={{
              left: `${nonAffineBounds.minX}px`,
              top: `${nonAffineBounds.minY}px`,
              width: `${nonAffineBounds.width}px`,
              height: `${nonAffineBounds.height}px`,
            }}
          >
            <canvas ref={previewCanvasRef} className="w-full h-full block" />
          </div>

          {/* SVG Overlay for Quad or Mesh Lattice Lines */}
          <svg
            className="absolute inset-0 pointer-events-none z-31 overflow-visible"
            style={{ width: '100%', height: '100%' }}
          >
            {mode === 'perspective' && (
              <>
                {/* Perspective Quad Polygon Outline */}
                <polygon
                  points={`${quad[0].x},${quad[0].y} ${quad[1].x},${quad[1].y} ${quad[2].x},${quad[2].y} ${quad[3].x},${quad[3].y}`}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth={1.5 * invZoom}
                  strokeDasharray={`${4 * invZoom} ${4 * invZoom}`}
                />
              </>
            )}

            {mode === 'mesh' && (
              <>
                {/* Horizontal Mesh Lattice Lines */}
                {meshPoints.map((row, r) => (
                  <polyline
                    key={`h-${r}`}
                    points={row.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="none"
                    stroke="#22d3ee"
                    strokeWidth={1.2 * invZoom}
                    strokeDasharray={`${3 * invZoom} ${3 * invZoom}`}
                  />
                ))}

                {/* Vertical Mesh Lattice Lines */}
                {meshPoints[0]?.map((_, c) => (
                  <polyline
                    key={`v-${c}`}
                    points={meshPoints.map((row) => `${row[c].x},${row[c].y}`).join(' ')}
                    fill="none"
                    stroke="#22d3ee"
                    strokeWidth={1.2 * invZoom}
                    strokeDasharray={`${3 * invZoom} ${3 * invZoom}`}
                  />
                ))}
              </>
            )}
          </svg>

          {/* Perspective Corner Pin Control Handles */}
          {mode === 'perspective' &&
            quad.map((pt, idx) => (
              <div
                key={idx}
                onPointerDown={(e) => startDragPerspectiveCorner(idx, e)}
                className="absolute z-33 bg-white border-2 border-cyan-500 rounded-full shadow-md cursor-grab active:cursor-grabbing hover:scale-125 transition-transform pointer-events-auto"
                style={{
                  left: `${pt.x}px`,
                  top: `${pt.y}px`,
                  width: `${pinSize}px`,
                  height: `${pinSize}px`,
                  transform: `translate(-50%, -50%) scale(${invZoom})`,
                  transformOrigin: 'center',
                }}
                title={`Corner Pin ${idx + 1}`}
              />
            ))}

          {/* Mesh Warp Control Handles */}
          {mode === 'mesh' &&
            meshPoints.map((row, r) =>
              row.map((pt, c) => (
                <div
                  key={`${r}-${c}`}
                  onPointerDown={(e) => startDragMeshPoint(r, c, e)}
                  className={`absolute z-33 rounded-full border shadow-sm cursor-grab active:cursor-grabbing hover:scale-125 pointer-events-auto ${
                    r === 0 || r === meshPoints.length - 1 || c === 0 || c === row.length - 1
                      ? 'bg-cyan-400 border-white'
                      : 'bg-white border-cyan-500'
                  }`}
                  style={{
                    left: `${pt.x}px`,
                    top: `${pt.y}px`,
                    width: `${handleSize}px`,
                    height: `${handleSize}px`,
                    transform: `translate(-50%, -50%) scale(${invZoom})`,
                    transformOrigin: 'center',
                  }}
                  title={`Mesh Handle [${r}, ${c}]`}
                />
              ))
            )}
        </>
      )}

      {/* 3. Floating Transform Toolbar (Pinned below transform boundary) */}
      <div
        className="absolute z-40 bg-[#18191b] border border-[#33353b] rounded shadow-2xl px-2 py-1 flex items-center space-x-1.5 whitespace-nowrap select-none text-xs"
        style={{
          left: `${nonAffineBounds.minX + nonAffineBounds.width / 2}px`,
          top: `${nonAffineBounds.maxY}px`,
          transform: `translateX(-50%) translateY(${16 * invZoom}px) scale(${invZoom})`,
          transformOrigin: 'top center',
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* Mode Switchers */}
        <div className="flex items-center space-x-0.5 bg-[#202226] p-0.5 rounded border border-[#2b2d31]">
          <button
            onClick={() => handleSwitchMode('affine')}
            title="Free Transform (Affine Scale & Rotate)"
            className={`px-1.5 py-1 rounded text-[11px] font-medium flex items-center space-x-1 cursor-pointer transition-colors ${
              mode === 'affine'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b]'
                : 'text-[#888888] hover:text-white'
            }`}
          >
            <BoxSelect className="w-3.5 h-3.5" />
            <span>Free</span>
          </button>

          <button
            onClick={() => handleSwitchMode('perspective')}
            title="Perspective Quad (4-Point Homography)"
            className={`px-1.5 py-1 rounded text-[11px] font-medium flex items-center space-x-1 cursor-pointer transition-colors ${
              mode === 'perspective'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b]'
                : 'text-[#888888] hover:text-white'
            }`}
          >
            <Square className="w-3.5 h-3.5" />
            <span>Perspective</span>
          </button>

          <button
            onClick={() => handleSwitchMode('mesh')}
            title="Mesh Warp (Catmull-Rom Bezier Lattice)"
            className={`px-1.5 py-1 rounded text-[11px] font-medium flex items-center space-x-1 cursor-pointer transition-colors ${
              mode === 'mesh'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b]'
                : 'text-[#888888] hover:text-white'
            }`}
          >
            <Grid3X3 className="w-3.5 h-3.5" />
            <span>Mesh Warp</span>
          </button>
        </div>

        {/* Mesh Grid Density Selector (when in mesh mode) */}
        {mode === 'mesh' && (
          <>
            <div className="w-px h-4 bg-[#33353b]" />
            <div className="flex items-center space-x-1 text-[11px] text-[#aaaaaa]">
              <span>Grid:</span>
              {[3, 4, 5, 6, 8].map((size) => (
                <button
                  key={size}
                  onClick={() => handleChangeMeshGrid(size)}
                  className={`px-1 py-0.5 rounded cursor-pointer transition-colors ${
                    (session.meshCols || 4) === size
                      ? 'bg-cyan-500/30 text-cyan-300 font-bold'
                      : 'hover:text-white hover:bg-[#25272a]'
                  }`}
                >
                  {size}x{size}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="w-px h-4 bg-[#33353b]" />

        {/* Apply */}
        <button
          onClick={onApply}
          title="Apply Transform (Enter)"
          className="px-2 py-1 bg-[#234b3e] hover:bg-[#2b604f] text-[#55eaab] border border-[#2e6e58] rounded text-xs font-semibold flex items-center space-x-1 cursor-pointer transition-colors"
        >
          <Check className="w-3.5 h-3.5" />
          <span>Apply</span>
        </button>

        {/* Cancel */}
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
    </>
  );
};
