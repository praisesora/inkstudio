import React, { useEffect, useRef } from 'react';
import type {
  CanvasDimensions,
  GradientDragPreview,
  GradientMeshState,
} from '../types/editor';
import { rasterizeMeshGradientToRgba } from '../utils/gradientEngine';

export interface GradientOverlayProps {
  dimensions: CanvasDimensions;
  zoom: number;
  flipX: boolean;
  flipY: boolean;
  dragPreview: GradientDragPreview | null;
  mesh: GradientMeshState | null;
  opacity: number;
  onApplyMesh?: () => void;
  onCancelMesh?: () => void;
}

const MAX_PREVIEW_DIM = 384;

export const GradientOverlay: React.FC<GradientOverlayProps> = React.memo(
  ({
    dimensions,
    zoom,
    flipX,
    flipY,
    dragPreview,
    mesh,
    opacity,
    onApplyMesh,
    onCancelMesh,
  }) => {
    const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const invZoom = 1 / Math.max(0.05, zoom);

    useEffect(() => {
      const canvas = previewCanvasRef.current;
      if (!canvas || !mesh) return;
      const scale = Math.min(
        1,
        MAX_PREVIEW_DIM / Math.max(1, dimensions.width, dimensions.height)
      );
      const pw = Math.max(1, Math.round(dimensions.width * scale));
      const ph = Math.max(1, Math.round(dimensions.height * scale));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const rgba = rasterizeMeshGradientToRgba(mesh, 0, 0, pw, ph, scale, scale, false, 6);
      const img = new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer), pw, ph);
      ctx.clearRect(0, 0, pw, ph);
      ctx.putImageData(img, 0, 0);
    }, [dimensions.height, dimensions.width, mesh]);

    if (!dragPreview && !mesh) return null;

    return (
      <>
        {dragPreview && (() => {
          const { start, end, type } = dragPreview;
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const dist = Math.hypot(dx, dy);
          const angleDeg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
          return (
            <>
              <svg
                className="absolute inset-0 w-full h-full pointer-events-none z-35 overflow-visible"
                viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
              >
                {type === 'radial' && dist > 1 && (
                  <circle
                    cx={start.x}
                    cy={start.y}
                    r={dist}
                    fill="none"
                    stroke="#ffffff"
                    strokeOpacity={0.75}
                    strokeWidth={1.5 * invZoom}
                    strokeDasharray={`${6 * invZoom} ${4 * invZoom}`}
                  />
                )}
                <line
                  x1={start.x}
                  y1={start.y}
                  x2={end.x}
                  y2={end.y}
                  stroke="#000000"
                  strokeOpacity={0.7}
                  strokeWidth={3 * invZoom}
                />
                <line
                  x1={start.x}
                  y1={start.y}
                  x2={end.x}
                  y2={end.y}
                  stroke="#ffffff"
                  strokeWidth={1.5 * invZoom}
                />
                <circle
                  cx={start.x}
                  cy={start.y}
                  r={5 * invZoom}
                  fill="#ffffff"
                  stroke="#000000"
                  strokeWidth={1.5 * invZoom}
                />
                <circle
                  cx={end.x}
                  cy={end.y}
                  r={5 * invZoom}
                  fill="var(--accent, #38bdf8)"
                  stroke="#000000"
                  strokeWidth={1.5 * invZoom}
                />
              </svg>
              <div
                className="absolute pointer-events-none z-35 px-1.5 py-0.5 rounded bg-[#161616]/90 border border-white/15 text-[#e5e5e5] font-mono text-[10px] whitespace-nowrap"
                style={{
                  left: `${end.x}px`,
                  top: `${end.y}px`,
                  transform: `translate(${10 * invZoom}px, ${10 * invZoom}px) scale(${
                    (flipX ? -1 : 1) * invZoom
                  }, ${(flipY ? -1 : 1) * invZoom})`,
                  transformOrigin: 'top left',
                }}
              >
                {Math.round(dist)}px · {Math.round(angleDeg)}°
              </div>
            </>
          );
        })()}

        {mesh && (
          <>
            <canvas
              ref={previewCanvasRef}
              className="absolute inset-0 w-full h-full pointer-events-none z-30"
              style={{ opacity: Math.max(0.05, Math.min(1, opacity)) }}
            />
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none z-35 overflow-visible"
              viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
            >
              {/* Horizontal mesh wires */}
              {Array.from({ length: mesh.rows }).map((_, r) =>
                Array.from({ length: mesh.cols - 1 }).map((__, c) => {
                  const a = mesh.nodes[r * mesh.cols + c];
                  const b = mesh.nodes[r * mesh.cols + c + 1];
                  if (!a || !b) return null;
                  return (
                    <line
                      key={`mh-${r}-${c}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke="#ffffff"
                      strokeOpacity={0.75}
                      strokeWidth={1.25 * invZoom}
                      strokeDasharray={`${4 * invZoom} ${3 * invZoom}`}
                    />
                  );
                })
              )}
              {/* Vertical mesh wires */}
              {Array.from({ length: mesh.rows - 1 }).map((_, r) =>
                Array.from({ length: mesh.cols }).map((__, c) => {
                  const a = mesh.nodes[r * mesh.cols + c];
                  const b = mesh.nodes[(r + 1) * mesh.cols + c];
                  if (!a || !b) return null;
                  return (
                    <line
                      key={`mv-${r}-${c}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke="#ffffff"
                      strokeOpacity={0.75}
                      strokeWidth={1.25 * invZoom}
                      strokeDasharray={`${4 * invZoom} ${3 * invZoom}`}
                    />
                  );
                })
              )}
              {/* Draggable control nodes */}
              {mesh.nodes.map((node, idx) => {
                const isSelected = mesh.selectedNodeIndex === idx;
                return (
                  <g key={`mn-${idx}`}>
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={(isSelected ? 8 : 6) * invZoom}
                      fill={node.color}
                      stroke={isSelected ? '#38bdf8' : '#ffffff'}
                      strokeWidth={(isSelected ? 2.5 : 1.75) * invZoom}
                    />
                  </g>
                );
              })}
            </svg>

            {/* Floating Mesh Commit / Cancel Action Bar */}
            {mesh.nodes.length > 0 && (
              <div
                onPointerDown={(e) => e.stopPropagation()}
                className="absolute z-40 flex items-center gap-1 px-1.5 py-1 rounded bg-[#181818]/95 border border-white/15 shadow-lg"
                style={{
                  left: `${mesh.nodes[0].x}px`,
                  top: `${Math.max(8, mesh.nodes[0].y - 36 * invZoom)}px`,
                  transform: `scale(${(flipX ? -1 : 1) * invZoom}, ${(flipY ? -1 : 1) * invZoom})`,
                  transformOrigin: 'top left',
                }}
              >
                <span className="text-[10px] text-[#8a8a8a] px-1">
                  Mesh ({mesh.cols}×{mesh.rows})
                </span>
                <button
                  type="button"
                  onClick={onApplyMesh}
                  className="px-2 py-0.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] text-[10px] font-medium cursor-pointer"
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={onCancelMesh}
                  className="px-2 py-0.5 rounded bg-[#2c2c2c] text-[#e5e5e5] text-[10px] hover:bg-[#3a3a3a] cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
          </>
        )}
      </>
    );
  }
);

GradientOverlay.displayName = 'GradientOverlay';
