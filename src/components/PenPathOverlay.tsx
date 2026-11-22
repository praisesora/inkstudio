import React from 'react';
import type {
  CanvasDimensions,
  PenPathSession,
  PenToolSettings,
} from '../types/editor';
import { buildBezierSvgPath } from '../utils/bezierEngine';

export interface PenPathOverlayProps {
  dimensions: CanvasDimensions;
  zoom: number;
  flipX: boolean;
  flipY: boolean;
  session: PenPathSession;
  settings: PenToolSettings;
  primaryColor: string;
  secondaryColor: string;
  onCommit?: () => void;
  onCancel?: () => void;
  onToggleClose?: () => void;
}

export const PenPathOverlay: React.FC<PenPathOverlayProps> = React.memo(
  ({
    dimensions,
    zoom,
    flipX,
    flipY,
    session,
    settings,
    primaryColor,
    secondaryColor,
    onCommit,
    onCancel,
    onToggleClose,
  }) => {
    const { knots, closed, selectedAnchorIndex, hoverPoint } = session;
    if (knots.length === 0) return null;

    const invZoom = 1 / Math.max(0.05, zoom);
    const mainD = buildBezierSvgPath(knots, closed);
    const fillColor =
      settings.fillEnabled && closed
        ? settings.fillColorMode === 'primary'
          ? primaryColor
          : settings.fillColorMode === 'secondary'
            ? secondaryColor
            : settings.customFillColor
        : 'none';

    // Live rubber-band cubic Bézier preview from last anchor to cursor in draw mode
    let rubberD = '';
    if (
      settings.mode === 'draw' &&
      settings.rubberBandPreview &&
      !closed &&
      hoverPoint &&
      knots.length >= 1
    ) {
      const last = knots[knots.length - 1];
      const c1 = last.handleOut || last;
      rubberD = `M ${last.x} ${last.y} C ${c1.x} ${c1.y}, ${hoverPoint.x} ${hoverPoint.y}, ${hoverPoint.x} ${hoverPoint.y}`;
    }

    const first = knots[0];
    const barX = first.x;
    const barY = Math.max(8, first.y - 38 * invZoom);

    return (
      <>
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none z-35 overflow-visible"
          viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
        >
          {/* Rendered stroke/fill preview */}
          {knots.length >= 2 && (
            <path
              d={mainD}
              fill={fillColor}
              stroke={settings.strokeEnabled ? primaryColor || '#000000' : 'none'}
              strokeWidth={Math.max(0.5, settings.strokeWidth)}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={Math.max(0.05, Math.min(1, settings.opacity))}
            />
          )}

          {/* Crisp vector wireframe centerline */}
          {knots.length >= 2 && (
            <path
              d={mainD}
              fill="none"
              stroke="#38bdf8"
              strokeWidth={1.35 * invZoom}
            />
          )}

          {/* Live rubber-band preview curve */}
          {rubberD && (
            <path
              d={rubberD}
              fill="none"
              stroke="#38bdf8"
              strokeOpacity={0.7}
              strokeWidth={1.25 * invZoom}
              strokeDasharray={`${5 * invZoom} ${4 * invZoom}`}
            />
          )}

          {/* Tangent handle bars and handle tip circles */}
          {knots.map((k, idx) => (
            <g key={`bh-${idx}`}>
              {k.handleIn && (
                <>
                  <line
                    x1={k.x}
                    y1={k.y}
                    x2={k.handleIn.x}
                    y2={k.handleIn.y}
                    stroke="#f59e0b"
                    strokeWidth={1.2 * invZoom}
                  />
                  <circle
                    cx={k.handleIn.x}
                    cy={k.handleIn.y}
                    r={4 * invZoom}
                    fill="#fbbf24"
                    stroke="#000000"
                    strokeWidth={1 * invZoom}
                  />
                </>
              )}
              {k.handleOut && (
                <>
                  <line
                    x1={k.x}
                    y1={k.y}
                    x2={k.handleOut.x}
                    y2={k.handleOut.y}
                    stroke="#f59e0b"
                    strokeWidth={1.2 * invZoom}
                  />
                  <circle
                    cx={k.handleOut.x}
                    cy={k.handleOut.y}
                    r={4 * invZoom}
                    fill="#fbbf24"
                    stroke="#000000"
                    strokeWidth={1 * invZoom}
                  />
                </>
              )}
            </g>
          ))}

          {/* Anchor point markers */}
          {knots.map((k, idx) => {
            const isSelected = selectedAnchorIndex === idx;
            const isFirst = idx === 0 && !closed && knots.length >= 2;
            const sz = (isSelected ? 8 : 6.5) * invZoom;
            return (
              <rect
                key={`ba-${idx}`}
                x={k.x - sz * 0.5}
                y={k.y - sz * 0.5}
                width={sz}
                height={sz}
                fill={isSelected ? '#38bdf8' : isFirst ? '#22c55e' : '#ffffff'}
                stroke="#000000"
                strokeWidth={1.25 * invZoom}
              />
            );
          })}
        </svg>

        {/* Floating Bézier Path Action Bar */}
        <div
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute z-40 flex items-center gap-1 px-1.5 py-1 rounded bg-[#181818]/95 border border-white/15 shadow-lg"
          style={{
            left: `${barX}px`,
            top: `${barY}px`,
            transform: `scale(${(flipX ? -1 : 1) * invZoom}, ${(flipY ? -1 : 1) * invZoom})`,
            transformOrigin: 'top left',
          }}
        >
          <span className="text-[10px] text-[#8a8a8a] px-1 font-mono">
            {knots.length}pt{closed ? ' · Closed' : ''}
          </span>
          {knots.length >= 2 && (
            <button
              type="button"
              onClick={onToggleClose}
              className="px-1.5 py-0.5 rounded bg-[#2c2c2c] text-[#e5e5e5] text-[10px] hover:bg-[#3a3a3a] cursor-pointer"
            >
              {closed ? 'Open' : 'Close'}
            </button>
          )}
          {knots.length >= 2 && (
            <button
              type="button"
              onClick={onCommit}
              className="px-2 py-0.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] text-[10px] font-medium cursor-pointer"
            >
              Commit
            </button>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="px-1.5 py-0.5 rounded bg-[#2c2c2c] text-[#e5e5e5] text-[10px] hover:bg-[#3a3a3a] cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </>
    );
  }
);

PenPathOverlay.displayName = 'PenPathOverlay';
