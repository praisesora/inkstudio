import React, { useRef, useState, useMemo, useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import { PressureCurvePoint, PressureCurveSettings } from '../types/settings';
import {
  calculatePressureOpacity,
  createPressureCurvePreset,
  evaluateGlobalPressureCurve,
  samplePressureCurve,
  sanitizePressureCurvePoints,
} from '../utils/pressureCurve';

interface PressureCurveEditorProps {
  value: PressureCurveSettings;
  onChange: (next: PressureCurveSettings) => void;
}

const SVG_W = 220;
const SVG_H = 180;
const PAD = 14;
const PLOT_W = SVG_W - PAD * 2;
const PLOT_H = SVG_H - PAD * 2;
const MAX_CONTROL_POINTS = 8;

function toSvgX(nx: number): number {
  return PAD + Math.max(0, Math.min(1, nx)) * PLOT_W;
}

function toSvgY(ny: number): number {
  return PAD + (1 - Math.max(0, Math.min(1, ny))) * PLOT_H;
}

function fromClientToNorm(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number
): PressureCurvePoint {
  const rect = svg.getBoundingClientRect();
  const sx = ((clientX - rect.left) / Math.max(1, rect.width)) * SVG_W;
  const sy = ((clientY - rect.top) / Math.max(1, rect.height)) * SVG_H;
  const nx = Math.max(0, Math.min(1, (sx - PAD) / PLOT_W));
  const ny = Math.max(0, Math.min(1, 1 - (sy - PAD) / PLOT_H));
  return [nx, ny];
}

export const PressureCurveEditor: React.FC<PressureCurveEditorProps> = ({ value, onChange }) => {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const testCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingIdxRef = useRef<number | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [liveSample, setLiveSample] = useState<{ input: number; output: number } | null>(null);

  const testStrokeRef = useRef<{
    active: boolean;
    pointerId: number;
    lastX: number;
    lastY: number;
    lastWidth: number;
    lastAlpha: number;
  }>({
    active: false,
    pointerId: -1,
    lastX: 0,
    lastY: 0,
    lastWidth: 1,
    lastAlpha: 1,
  });

  const points = useMemo(() => sanitizePressureCurvePoints(value.points), [value.points]);

  const sampledCurve = useMemo(() => samplePressureCurve(value, 64), [value]);

  const curvePathD = useMemo(() => {
    if (sampledCurve.length === 0) return '';
    return sampledCurve
      .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${toSvgX(x).toFixed(2)},${toSvgY(y).toFixed(2)}`)
      .join(' ');
  }, [sampledCurve]);

  const areaPathD = useMemo(() => {
    if (!curvePathD) return '';
    const xEnd = toSvgX(1).toFixed(2);
    const xStart = toSvgX(0).toFixed(2);
    const yBase = toSvgY(0).toFixed(2);
    return `${curvePathD} L${xEnd},${yBase} L${xStart},${yBase} Z`;
  }, [curvePathD]);

  const updatePoints = useCallback(
    (nextPts: PressureCurvePoint[]) => {
      onChange({
        enabled: value.enabled,
        preset: 'custom',
        points: sanitizePressureCurvePoints(nextPts),
      });
    },
    [onChange, value.enabled]
  );

  const handleSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !svgRef.current) return;
    const [nx, ny] = fromClientToNorm(svgRef.current, e.clientX, e.clientY);

    // Hit-test existing control points first
    let hitIdx = -1;
    let bestDist = 14;
    const px = toSvgX(nx);
    const py = toSvgY(ny);
    for (let i = 0; i < points.length; i++) {
      const d = Math.hypot(toSvgX(points[i][0]) - px, toSvgY(points[i][1]) - py);
      if (d < bestDist) {
        bestDist = d;
        hitIdx = i;
      }
    }

    if (hitIdx >= 0) {
      draggingIdxRef.current = hitIdx;
      setSelectedIdx(hitIdx);
      svgRef.current.setPointerCapture(e.pointerId);
      return;
    }

    // Insert new interior point if under limit
    if (points.length < MAX_CONTROL_POINTS && nx > 0.03 && nx < 0.97) {
      const next = [...points, [nx, ny] as PressureCurvePoint].sort((a, b) => a[0] - b[0]);
      const insertedIdx = next.findIndex(
        (p) => Math.abs(p[0] - nx) < 1e-4 && Math.abs(p[1] - ny) < 1e-4
      );
      updatePoints(next);
      if (insertedIdx >= 0) {
        draggingIdxRef.current = insertedIdx;
        setSelectedIdx(insertedIdx);
        svgRef.current.setPointerCapture(e.pointerId);
      }
    }
  };

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const idx = draggingIdxRef.current;
    if (idx === null || !svgRef.current) return;
    const [nx, ny] = fromClientToNorm(svgRef.current, e.clientX, e.clientY);
    const next = points.map(([x, y]) => [x, y] as PressureCurvePoint);

    if (idx === 0) {
      next[0] = [0, ny];
    } else if (idx === next.length - 1) {
      next[next.length - 1] = [1, ny];
    } else {
      const minX = next[idx - 1][0] + 0.03;
      const maxX = next[idx + 1][0] - 0.03;
      next[idx] = [Math.max(minX, Math.min(maxX, nx)), ny];
    }
    onChange({
      enabled: value.enabled,
      preset: 'custom',
      points: next,
    });
  };

  const handleSvgPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (draggingIdxRef.current !== null && svgRef.current) {
      try {
        if (svgRef.current.hasPointerCapture(e.pointerId)) {
          svgRef.current.releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore release errors
      }
    }
    draggingIdxRef.current = null;
  };

  const removePointAt = (idx: number) => {
    if (idx <= 0 || idx >= points.length - 1) return;
    const next = points.filter((_, i) => i !== idx);
    setSelectedIdx(null);
    updatePoints(next);
  };

  // --- Live Stylus Testing Strip ---
  const clearTestCanvas = () => {
    const canvas = testCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    setLiveSample(null);
  };

  const getTestRawPressure = (e: React.PointerEvent<HTMLCanvasElement>, normX: number): number => {
    if (e.pointerType === 'pen' || e.pointerType === 'touch') {
      return Math.max(0, Math.min(1, e.pressure || 0));
    }
    // Mouse fallback: smooth horizontal pressure ramp 0.05..1.0 so mouse users can preview curve response
    return Math.max(0.05, Math.min(1, normX));
  };

  const drawTestDotOrSegment = (
    x0: number,
    y0: number,
    w0: number,
    a0: number,
    x1: number,
    y1: number,
    w1: number,
    a1: number
  ) => {
    const canvas = testCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / 1.5));
    ctx.save();
    ctx.fillStyle = '#e5e5e5';
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      const r = Math.max(0.6, ((w0 + (w1 - w0) * t) * 0.5));
      const alpha = Math.max(0.06, Math.min(1, a0 + (a1 - a0) * t));
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  const handleTestPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = testCanvasRef.current;
    if (!canvas || e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, rect.width);
    const scaleY = canvas.height / Math.max(1, rect.height);
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const rawP = getTestRawPressure(e, (e.clientX - rect.left) / Math.max(1, rect.width));
    const mappedP = evaluateGlobalPressureCurve(rawP, value);
    const width = 1.5 + mappedP * 18;
    const alpha = calculatePressureOpacity(1.0, rawP, true, 0.12, value);

    testStrokeRef.current = {
      active: true,
      pointerId: e.pointerId,
      lastX: x,
      lastY: y,
      lastWidth: width,
      lastAlpha: alpha,
    };
    setLiveSample({ input: rawP, output: mappedP });
    drawTestDotOrSegment(x, y, width, alpha, x, y, width, alpha);
  };

  const handleTestPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const st = testStrokeRef.current;
    const canvas = testCanvasRef.current;
    if (!st.active || st.pointerId !== e.pointerId || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, rect.width);
    const scaleY = canvas.height / Math.max(1, rect.height);
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const rawP = getTestRawPressure(e, (e.clientX - rect.left) / Math.max(1, rect.width));
    const mappedP = evaluateGlobalPressureCurve(rawP, value);
    const width = 1.5 + mappedP * 18;
    const alpha = calculatePressureOpacity(1.0, rawP, true, 0.12, value);

    drawTestDotOrSegment(st.lastX, st.lastY, st.lastWidth, st.lastAlpha, x, y, width, alpha);
    st.lastX = x;
    st.lastY = y;
    st.lastWidth = width;
    st.lastAlpha = alpha;
    setLiveSample({ input: rawP, output: mappedP });
  };

  const handleTestPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const st = testStrokeRef.current;
    if (!st.active || st.pointerId !== e.pointerId) return;
    st.active = false;
    st.pointerId = -1;
    try {
      if (testCanvasRef.current?.hasPointerCapture(e.pointerId)) {
        testCanvasRef.current.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore release errors
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-medium text-[#e5e5e5]">Global Pen Pressure Curve</h3>
          <p className="text-[11px] text-[#8a8a8a]">
            Click curve to add point, drag to adjust, double-click interior point to remove
          </p>
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-[#e5e5e5] cursor-pointer">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
          />
          <span>Enabled</span>
        </label>
      </div>

      {/* Preset Row */}
      <div className="flex items-center gap-1.5">
        {(['linear', 'soft', 'hard'] as const).map((preset) => {
          const active = value.preset === preset;
          return (
            <button
              key={preset}
              type="button"
              onClick={() => onChange(createPressureCurvePreset(preset, value.enabled))}
              className={`px-2.5 py-1 rounded text-[11px] capitalize transition-colors cursor-pointer ${
                active
                  ? 'bg-[#2c2c2c] text-[#e5e5e5] ring-1 ring-[var(--accent-border)] font-medium'
                  : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
              }`}
            >
              {preset}
            </button>
          );
        })}
        {liveSample && (
          <span className="ml-auto font-mono text-[10px] text-[#8a8a8a]">
            In {Math.round(liveSample.input * 100)}% {'->'} Out {Math.round(liveSample.output * 100)}%
          </span>
        )}
      </div>

      {/* Curve Graph + Live Stylus Test Strip side-by-side */}
      <div className="grid grid-cols-1 sm:grid-cols-[220px_1fr] gap-3 items-stretch">
        <div className="bg-[#161616] rounded p-1.5 flex flex-col items-center">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${SVG_W} ${SVG_H}`}
            onPointerDown={handleSvgPointerDown}
            onPointerMove={handleSvgPointerMove}
            onPointerUp={handleSvgPointerUp}
            onPointerCancel={handleSvgPointerUp}
            className={`w-full h-[180px] touch-none select-none ${
              value.enabled ? 'cursor-crosshair' : 'opacity-45'
            }`}
          >
            {/* Plot background */}
            <rect
              x={PAD}
              y={PAD}
              width={PLOT_W}
              height={PLOT_H}
              fill="#121212"
              stroke="#2c2c2c"
              strokeWidth="1"
            />

            {/* 25% / 50% / 75% grid lines */}
            {[0.25, 0.5, 0.75].map((t) => (
              <g key={t} stroke="#242424" strokeWidth="1">
                <line x1={toSvgX(t)} y1={PAD} x2={toSvgX(t)} y2={PAD + PLOT_H} />
                <line x1={PAD} y1={toSvgY(t)} x2={PAD + PLOT_W} y2={toSvgY(t)} />
              </g>
            ))}

            {/* Linear reference diagonal */}
            <line
              x1={toSvgX(0)}
              y1={toSvgY(0)}
              x2={toSvgX(1)}
              y2={toSvgY(1)}
              stroke="#3a3a3a"
              strokeWidth="1"
              strokeDasharray="3 3"
            />

            {/* Area fill under curve */}
            {areaPathD && <path d={areaPathD} fill="var(--accent-subtle)" />}

            {/* Monotone spline curve */}
            {curvePathD && (
              <path
                d={curvePathD}
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {/* Live test input/output crosshair */}
            {liveSample && (
              <g pointerEvents="none">
                <line
                  x1={toSvgX(liveSample.input)}
                  y1={PAD}
                  x2={toSvgX(liveSample.input)}
                  y2={PAD + PLOT_H}
                  stroke="rgba(255,255,255,0.22)"
                  strokeWidth="1"
                />
                <circle
                  cx={toSvgX(liveSample.input)}
                  cy={toSvgY(liveSample.output)}
                  r="4"
                  fill="#ffffff"
                  stroke="#161616"
                  strokeWidth="1.5"
                />
              </g>
            )}

            {/* Draggable Control Points */}
            {points.map(([px, py], idx) => {
              const isEndpoint = idx === 0 || idx === points.length - 1;
              const isSelected = selectedIdx === idx;
              return (
                <circle
                  key={`${idx}-${px.toFixed(3)}`}
                  cx={toSvgX(px)}
                  cy={toSvgY(py)}
                  r={isSelected ? 5.5 : 4.5}
                  fill={isEndpoint ? '#e5e5e5' : 'var(--accent)'}
                  stroke="#161616"
                  strokeWidth="1.5"
                  className="cursor-grab"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    removePointAt(idx);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    removePointAt(idx);
                  }}
                />
              );
            })}
          </svg>
          <div className="w-full flex justify-between px-2 pt-0.5 text-[9px] font-mono text-[#8a8a8a]">
            <span>Input 0%</span>
            <span>Output Y / Input X</span>
            <span>100%</span>
          </div>
        </div>

        {/* Live Stylus Test Strip */}
        <div className="bg-[#161616] rounded p-2.5 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[11px] font-medium text-[#e5e5e5]">Live Stylus Test Strip</div>
              <div className="text-[10px] text-[#8a8a8a]">
                Draw with pen (or drag left-to-right with mouse) to test size & opacity
              </div>
            </div>
            <button
              type="button"
              onClick={clearTestCanvas}
              className="flex items-center gap-1 px-2 py-1 rounded bg-[#202020] hover:bg-[#2c2c2c] text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
              title="Clear test strip"
            >
              <Trash2 className="w-3 h-3" />
              <span>Clear</span>
            </button>
          </div>
          <canvas
            ref={testCanvasRef}
            width={360}
            height={132}
            onPointerDown={handleTestPointerDown}
            onPointerMove={handleTestPointerMove}
            onPointerUp={handleTestPointerUp}
            onPointerCancel={handleTestPointerUp}
            className="w-full h-[132px] rounded bg-[#121212] border border-[#2c2c2c] touch-none cursor-crosshair block"
          />
        </div>
      </div>
    </section>
  );
};
