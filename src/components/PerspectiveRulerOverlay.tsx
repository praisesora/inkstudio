import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  PerspectiveRuler,
  PerspectiveType,
  VanishingPoint,
  Vector2D,
  ConstraintAxis,
} from '../types/perspective';
import {
  getHorizonLine,
  clipLineToRect,
  createDefaultPerspectiveRuler,
  applyWormsEyePreset,
} from '../utils/perspectiveMath';
import { canvasToScreen, screenToCanvas } from '../utils/canvasUtils';
import { CanvasDimensions } from '../types/editor';
import { CanvasNavigationHandle } from '../hooks/useCanvasNavigation';
import {
  Eye,
  EyeOff,
  ChevronDown,
  X,
} from 'lucide-react';

interface PerspectiveRulerOverlayProps {
  ruler: PerspectiveRuler;
  onUpdateRuler: (updated: PerspectiveRuler) => void;
  onRemoveRuler?: () => void;
  dimensions: CanvasDimensions;
  pan: { x: number; y: number };
  zoom: number;
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
  navigation?: CanvasNavigationHandle;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  activeLockedAxis?: ConstraintAxis | null;
  isDrawing?: boolean;
}

/**
 * Clips a forward ray starting at `origin` in direction `dir` (t >= 0 only).
 * Prevents lines from shooting backwards behind vanishing points into the void.
 */
function clipRayForward(
  origin: Vector2D,
  dir: Vector2D,
  rect: { x: number; y: number; width: number; height: number }
): [Vector2D, Vector2D] | null {
  const lineClip = clipLineToRect(origin, dir, rect);
  if (!lineClip) return null;

  const t1 = (lineClip[0].x - origin.x) * dir.x + (lineClip[0].y - origin.y) * dir.y;
  const t2 = (lineClip[1].x - origin.x) * dir.x + (lineClip[1].y - origin.y) * dir.y;

  const minT = Math.min(t1, t2);
  const maxT = Math.max(t1, t2);

  if (maxT < 0) return null;

  const startT = Math.max(0, minT);
  return [
    { x: origin.x + startT * dir.x, y: origin.y + startT * dir.y },
    { x: origin.x + maxT * dir.x, y: origin.y + maxT * dir.y },
  ];
}

export const PerspectiveRulerOverlay: React.FC<PerspectiveRulerOverlayProps> = ({
  ruler,
  onUpdateRuler,
  onRemoveRuler,
  dimensions,
  pan,
  zoom,
  rotation,
  flipX = false,
  flipY = false,
  navigation,
  viewportRef,
  activeLockedAxis = null,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isPresetsOpen, setIsPresetsOpen] = useState<boolean>(false);
  const [activeDragTarget, setActiveDragTarget] = useState<string | null>(null);

  const dragStartRef = useRef<{
    clientX: number;
    clientY: number;
    initialVps: VanishingPoint[];
    initialHorizonAngle: number;
  }>({
    clientX: 0,
    clientY: 0,
    initialVps: [],
    initialHorizonAngle: 0,
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
    activeLockedAxis,
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
    activeLockedAxis,
  };

  /**
   * 60 FPS Vector Overlay Renderer:
   * Clean, minimal, Clip Studio Paint style perspective framing (5-7 lines max).
   */
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

    const {
      ruler: curRuler,
      dimensions: dims,
      pan: propPan,
      zoom: propZoom,
      rotation: propRot,
      flipX: propFlipX,
      flipY: propFlipY,
      navigation: curNav,
      activeLockedAxis: curAxis,
    } = propsRef.current;

    const liveCam = curNav
      ? curNav.getCameraState()
      : { pan: propPan, zoom: propZoom, rotation: propRot, flipX: propFlipX, flipY: propFlipY };
    const curPan = liveCam.pan;
    const curZoom = liveCam.zoom;
    const curRot = liveCam.rotation;
    const curFlipX = liveCam.flipX;
    const curFlipY = liveCam.flipY;

    if (!curRuler.enabled) {
      ctx.restore();
      return;
    }

    const screenRect = { x: 0, y: 0, width: vRect.width, height: vRect.height };

    // Canvas Corners in Screen Space
    const c0 = canvasToScreen(0, 0, curPan, curZoom, curRot, dims, curFlipX, curFlipY);
    const c1 = canvasToScreen(dims.width, 0, curPan, curZoom, curRot, dims, curFlipX, curFlipY);
    const c2 = canvasToScreen(dims.width, dims.height, curPan, curZoom, curRot, dims, curFlipX, curFlipY);
    const c3 = canvasToScreen(0, dims.height, curPan, curZoom, curRot, dims, curFlipX, curFlipY);

    // 1. Draw Subtle Canvas Paper Boundary Guide
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y);
    ctx.lineTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.lineTo(c3.x, c3.y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // 2. Horizon Line across the scene
    renderHorizonLine(ctx, curRuler, dims, curPan, curZoom, curRot, screenRect, curFlipX, curFlipY);

    // 3. Clean Sparse Guide Rays (Strictly 2 per VP for 2P/3P, 4 for 1P)
    renderCleanGuideRays(ctx, curRuler, dims, curPan, curZoom, curRot, screenRect, [c0, c1, c2, c3], curFlipX, curFlipY);

    // 4. Single Upright Vertical Center Guide (for 1P and 2P)
    renderVerticalGuide(ctx, curRuler, dims, curPan, curZoom, curRot, screenRect, [c0, c1, c2, c3], curFlipX, curFlipY);

    // 5. Active Snapped Constraint Axis (High-contrast laser when inking)
    if (curAxis) {
      renderActiveLockedAxis(ctx, curAxis, dims, curPan, curZoom, curRot, screenRect, curFlipX, curFlipY);
    }

    // 6. Vanishing Point pivot rings
    renderVanishingPointVisuals(ctx, curRuler, dims, curPan, curZoom, curRot, screenRect, curFlipX, curFlipY);

    ctx.restore();
  }, [viewportRef]);

  useEffect(() => {
    let animId: number;
    const loop = () => {
      render();
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
  }, [render]);

  /**
   * Interactive Drag Handlers (Eye Level & VPs)
   */
  const startHorizonDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}

    setActiveDragTarget('horizon');
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      initialVps: JSON.parse(JSON.stringify(ruler.vps)),
      initialHorizonAngle: ruler.horizonAngle,
    };
  };

  const startVpDrag = (e: React.PointerEvent, vpId: string) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}

    setActiveDragTarget(`vp-${vpId}`);
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      initialVps: JSON.parse(JSON.stringify(ruler.vps)),
      initialHorizonAngle: ruler.horizonAngle,
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!activeDragTarget || ruler.locked) return;

    const viewport = viewportRef.current;
    if (!viewport) return;
    const vRect = viewport.getBoundingClientRect();

    const liveCam = navigation
      ? navigation.getCameraState()
      : { pan, zoom, rotation, flipX, flipY };

    if (activeDragTarget === 'horizon') {
      const pStart = screenToCanvas(
        dragStartRef.current.clientX,
        dragStartRef.current.clientY,
        vRect,
        liveCam.pan,
        liveCam.zoom,
        liveCam.rotation,
        dimensions,
        liveCam.flipX,
        liveCam.flipY
      );
      const pCurr = screenToCanvas(
        e.clientX,
        e.clientY,
        vRect,
        liveCam.pan,
        liveCam.zoom,
        liveCam.rotation,
        dimensions,
        liveCam.flipX,
        liveCam.flipY
      );
      const deltaY = pCurr.y - pStart.y;

      const updatedVps = dragStartRef.current.initialVps.map((vp) => {
        if (vp.id === 'vp1' || vp.id === 'vp2') {
          return {
            ...vp,
            y: Math.round(vp.y + deltaY),
          };
        }
        return vp;
      });

      onUpdateRuler({
        ...ruler,
        vps: updatedVps,
      });
      return;
    }

    if (activeDragTarget.startsWith('vp-')) {
      const targetId = activeDragTarget.replace('vp-', '');
      const newCanvasCoord = screenToCanvas(
        e.clientX,
        e.clientY,
        vRect,
        liveCam.pan,
        liveCam.zoom,
        liveCam.rotation,
        dimensions,
        liveCam.flipX,
        liveCam.flipY
      );

      const updatedVps = ruler.vps.map((vp) => {
        if (vp.id === targetId) {
          return {
            ...vp,
            x: Math.round(newCanvasCoord.x),
            y: Math.round(newCanvasCoord.y),
          };
        }
        return vp;
      });

      onUpdateRuler({
        ...ruler,
        vps: updatedVps,
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (activeDragTarget) {
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      setActiveDragTarget(null);
    }
  };

  const handleSwitchType = (type: PerspectiveType) => {
    const updated = createDefaultPerspectiveRuler(type, dimensions);
    updated.snapEnabled = ruler.snapEnabled;
    updated.locked = ruler.locked;
    onUpdateRuler(updated);
  };

  const handleApplyPreset = (presetName: '1p-center' | '2p-wide' | '3p-birds' | '3p-worms') => {
    setIsPresetsOpen(false);
    if (presetName === '1p-center') {
      handleSwitchType('1-point');
    } else if (presetName === '2p-wide') {
      handleSwitchType('2-point');
    } else if (presetName === '3p-birds') {
      handleSwitchType('3-point');
    } else if (presetName === '3p-worms') {
      const updated = applyWormsEyePreset(ruler, dimensions);
      onUpdateRuler(updated);
    }
  };

  // Center coordinate of horizon line on canvas
  const renderCam = navigation ? navigation.getCameraState() : { pan, zoom, rotation, flipX, flipY };
  const horizon = getHorizonLine(ruler);
  const horizonCenterScreen = canvasToScreen(
    dimensions.width / 2,
    (horizon.p1.y + horizon.p2.y) / 2,
    renderCam.pan,
    renderCam.zoom,
    renderCam.rotation,
    dimensions,
    renderCam.flipX,
    renderCam.flipY
  );

  return (
    <div
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className="absolute inset-0 pointer-events-none z-24 overflow-hidden select-none"
    >
      {/* 2D Canvas Layer: Non-blocking pointer-events: none */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ width: '100%', height: '100%' }}
      />

      {/* Clean Interactive Draggable Handles (pointer-events: auto when !ruler.locked) */}
      {ruler.enabled && !ruler.locked && (
        <>
          {/* Horizon Line / Eye Level Pill Handle in Canvas Center */}
          <div
            onPointerDown={startHorizonDrag}
            title="Drag vertically to adjust Eye Level height"
            className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 cursor-ns-resize z-30 group"
            style={{
              left: `${horizonCenterScreen.x}px`,
              top: `${horizonCenterScreen.y}px`,
            }}
          >
            <div className="flex items-center space-x-1.5 px-3 py-1 bg-white/95 text-black border border-black/80 rounded-full shadow-[0_2px_10px_rgba(0,0,0,0.35)] transition-transform hover:scale-105 active:scale-95">
              <div className="w-1.5 h-1.5 rounded-full bg-black" />
              <span className="text-[10px] font-mono font-bold tracking-tight whitespace-nowrap">
                Eye Level {Math.round(horizon.angle)}°
              </span>
            </div>
          </div>

          {/* Draggable VP Handles (on-screen & off-screen edge tags) */}
          {ruler.vps.map((vp) => {
            const sPos = canvasToScreen(
              vp.x,
              vp.y,
              renderCam.pan,
              renderCam.zoom,
              renderCam.rotation,
              dimensions,
              renderCam.flipX,
              renderCam.flipY
            );
            const viewport = viewportRef.current;
            const vRect = viewport ? viewport.getBoundingClientRect() : { width: 1920, height: 1080 };
            const isInside =
              sPos.x >= 28 &&
              sPos.x <= vRect.width - 28 &&
              sPos.y >= 28 &&
              sPos.y <= vRect.height - 28;

            if (isInside) {
              return (
                <div
                  key={`handle-vp-${vp.id}`}
                  onPointerDown={(e) => startVpDrag(e, vp.id)}
                  title={`Drag ${vp.label} Vanishing Point`}
                  className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing z-30"
                  style={{ left: `${sPos.x}px`, top: `${sPos.y}px` }}
                >
                  <div className="w-6 h-6 rounded-full border border-black bg-white shadow-md flex items-center justify-center transition-transform hover:scale-110 active:scale-95">
                    <div className="w-2 h-2 rounded-full bg-black" />
                  </div>
                  <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 px-1.5 py-0.5 bg-black/80 text-white rounded text-[9px] font-mono whitespace-nowrap pointer-events-none">
                    {vp.label}
                  </div>
                </div>
              );
            } else {
              const center = { x: vRect.width / 2, y: vRect.height / 2 };
              const dir = { x: sPos.x - center.x, y: sPos.y - center.y };
              const dist = Math.hypot(dir.x, dir.y);
              if (dist <= 1e-4) return null;

              const uDir = { x: dir.x / dist, y: dir.y / dist };
              const insetRect = { x: 36, y: 36, width: vRect.width - 72, height: vRect.height - 72 };
              const clipped = clipLineToRect(center, uDir, insetRect);
              if (!clipped) return null;

              const edgePos = clipped[1];

              return (
                <div
                  key={`edge-vp-${vp.id}`}
                  onPointerDown={(e) => startVpDrag(e, vp.id)}
                  title={`Drag to reposition ${vp.label} (${Math.round(dist)}px off-screen)`}
                  className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing z-30"
                  style={{ left: `${edgePos.x}px`, top: `${edgePos.y}px` }}
                >
                  <div className="flex items-center space-x-1 px-2 py-0.5 bg-white text-black border border-black/80 rounded shadow-lg text-[10px] font-mono font-semibold hover:bg-neutral-100 transition-transform hover:scale-105 active:scale-95">
                    <span>{vp.label}</span>
                    <span className="text-[9px] text-neutral-500 font-normal">
                      {Math.round(dist)}px
                    </span>
                  </div>
                </div>
              );
            }
          })}
        </>
      )}

      {/* Floating Perspective Ruler Toolbar */}
      <div
        className="pointer-events-auto absolute top-3 right-4 z-40 bg-[#202020]/95 backdrop-blur-md border border-white/[0.1] rounded-md shadow-2xl p-1 flex items-center space-x-1 text-[11px] text-[#e5e5e5] select-none font-sans"
      >
        {/* Toggle Ruler Visibility */}
        <button
          onClick={() => onUpdateRuler({ ...ruler, enabled: !ruler.enabled })}
          title={ruler.enabled ? 'Hide Perspective Ruler' : 'Show Perspective Ruler'}
          className={`p-1 rounded transition-colors cursor-pointer ${
            ruler.enabled
              ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
              : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
          }`}
        >
          {ruler.enabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
        </button>

        {/* Snap to Perspective Toggle */}
        <button
          onClick={() => onUpdateRuler({ ...ruler, snapEnabled: !ruler.snapEnabled })}
          title={`Perspective Snapping: ${ruler.snapEnabled ? 'ENABLED' : 'DISABLED'} (Hold Alt to freehand)`}
          className={`px-2 py-1 rounded font-medium transition-colors cursor-pointer ${
            ruler.snapEnabled
              ? 'bg-[var(--accent-subtle)] text-[var(--accent)] ring-1 ring-[var(--accent-border)]'
              : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
          }`}
        >
          Snap {ruler.snapEnabled ? 'ON' : 'OFF'}
        </button>

        <div className="w-px h-4 bg-white/[0.08]" />

        {/* 1P / 2P / 3P Mode Selector */}
        <div className="flex bg-[#161616] p-0.5 rounded border border-white/[0.06]">
          {(['1-point', '2-point', '3-point'] as PerspectiveType[]).map((mode) => {
            const label = mode === '1-point' ? '1P' : mode === '2-point' ? '2P' : '3P';
            const isActive = ruler.type === mode;
            return (
              <button
                key={mode}
                onClick={() => handleSwitchType(mode)}
                title={`${label} Perspective`}
                className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-[var(--accent)] text-[var(--accent-contrast)]'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Ray Count Stepper */}
        <div
          className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-[#161616] border border-white/[0.06] text-[#e5e5e5] text-[11px]"
          title="Number of Guide Rays per Vanishing Point"
        >
          <span className="text-[10px] text-[#8a8a8a] select-none">Lines</span>
          <button
            onClick={() =>
              onUpdateRuler({
                ...ruler,
                guideRayCount: Math.max(2, (ruler.guideRayCount || 6) - 1),
              })
            }
            disabled={(ruler.guideRayCount || 6) <= 2}
            className="w-4 h-4 flex items-center justify-center rounded bg-[#202020] hover:bg-[#2c2c2c] disabled:opacity-30 disabled:pointer-events-none text-[#e5e5e5] font-mono text-xs cursor-pointer"
            title="Decrease Guide Rays"
          >
            -
          </button>
          <span className="w-4 text-center font-mono text-[#e5e5e5] text-[11px]">
            {ruler.guideRayCount || 6}
          </span>
          <button
            onClick={() =>
              onUpdateRuler({
                ...ruler,
                guideRayCount: Math.min(16, (ruler.guideRayCount || 6) + 1),
              })
            }
            disabled={(ruler.guideRayCount || 6) >= 16}
            className="w-4 h-4 flex items-center justify-center rounded bg-[#202020] hover:bg-[#2c2c2c] disabled:opacity-30 disabled:pointer-events-none text-[#e5e5e5] font-mono text-xs cursor-pointer"
            title="Increase Guide Rays"
          >
            +
          </button>
        </div>

        {/* Lock / Freeze Handles Toggle */}
        <button
          onClick={() => onUpdateRuler({ ...ruler, locked: !ruler.locked })}
          title={
            ruler.locked
              ? 'Ruler Locked (Handles frozen to prevent misclicks while inking)'
              : 'Ruler Unlocked (Drag handles or eye level to adjust perspective)'
          }
          className={`px-2 py-1 rounded font-medium transition-colors cursor-pointer ${
            ruler.locked
              ? 'bg-[var(--accent-subtle)] text-[var(--accent)] ring-1 ring-[var(--accent-border)]'
              : 'bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
          }`}
        >
          {ruler.locked ? 'Locked' : 'Edit'}
        </button>

        {/* Presets Dropdown */}
        <div className="relative">
          <button
            onClick={() => setIsPresetsOpen((prev) => !prev)}
            title="Preset Perspective Angles"
            className="flex items-center space-x-1 px-2 py-1 rounded bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            <span>Presets</span>
            <ChevronDown className="w-3 h-3" />
          </button>

          {isPresetsOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-48 bg-[#202020] border border-white/[0.1] rounded-md shadow-2xl py-1 z-50 text-[11px]">
              <button
                onClick={() => handleApplyPreset('1p-center')}
                className="w-full text-left px-3 py-1.5 hover:bg-[#2c2c2c] text-[#e5e5e5] flex items-center justify-between cursor-pointer"
              >
                <span>1-Point Center</span>
                <span className="text-[10px] text-[#8a8a8a]">1 VP</span>
              </button>
              <button
                onClick={() => handleApplyPreset('2p-wide')}
                className="w-full text-left px-3 py-1.5 hover:bg-[#2c2c2c] text-[#e5e5e5] flex items-center justify-between cursor-pointer"
              >
                <span>2-Point Street (Wide)</span>
                <span className="text-[10px] text-[#8a8a8a]">2 VPs</span>
              </button>
              <button
                onClick={() => handleApplyPreset('3p-birds')}
                className="w-full text-left px-3 py-1.5 hover:bg-[#2c2c2c] text-[#e5e5e5] flex items-center justify-between cursor-pointer"
              >
                <span>3-Point Bird's-Eye</span>
                <span className="text-[10px] text-[#8a8a8a]">High Angle</span>
              </button>
              <button
                onClick={() => handleApplyPreset('3p-worms')}
                className="w-full text-left px-3 py-1.5 hover:bg-[#2c2c2c] text-[#e5e5e5] flex items-center justify-between cursor-pointer"
              >
                <span>3-Point Worm's-Eye</span>
                <span className="text-[10px] text-[#8a8a8a]">Low Angle</span>
              </button>
            </div>
          )}
        </div>

        {/* Remove / Close Ruler from Canvas */}
        {onRemoveRuler && (
          <button
            onClick={onRemoveRuler}
            title="Remove Perspective Ruler from Canvas"
            className="p-1 rounded text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * 1. Renders Horizon Line (Eye Level): Exactly 1 clean, thin line
 */
function renderHorizonLine(
  ctx: CanvasRenderingContext2D,
  ruler: PerspectiveRuler,
  dims: CanvasDimensions,
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  screenRect: { x: number; y: number; width: number; height: number },
  flipX: boolean = false,
  flipY: boolean = false
) {
  const horizon = getHorizonLine(ruler);
  const hp1 = canvasToScreen(horizon.p1.x, horizon.p1.y, pan, zoom, rotation, dims, flipX, flipY);
  const hp2 = canvasToScreen(horizon.p2.x, horizon.p2.y, pan, zoom, rotation, dims, flipX, flipY);

  const screenDir = { x: hp2.x - hp1.x, y: hp2.y - hp1.y };
  const sLen = Math.hypot(screenDir.x, screenDir.y);
  if (sLen < 1e-4) return;

  const uScreenDir = { x: screenDir.x / sLen, y: screenDir.y / sLen };
  const clipped = clipLineToRect(hp1, uScreenDir, screenRect);
  if (!clipped) return;

  ctx.save();
  // Faint white contrast underlay
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 2.0;
  ctx.beginPath();
  ctx.moveTo(clipped[0].x, clipped[0].y);
  ctx.lineTo(clipped[1].x, clipped[1].y);
  ctx.stroke();

  // Thin crisp semi-transparent black horizon line
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.moveTo(clipped[0].x, clipped[0].y);
  ctx.lineTo(clipped[1].x, clipped[1].y);
  ctx.stroke();

  ctx.restore();
}

/**
 * Computes forward ray directions for a vanishing point fanning across the canvas aperture.
 */
function computeVpRayDirections(
  vp: VanishingPoint,
  dims: CanvasDimensions,
  count: number,
  horizonAngle: number
): Vector2D[] {
  const n = Math.max(2, Math.min(24, Math.round(count)));
  const directions: Vector2D[] = [];

  const isInside =
    vp.x >= 0 && vp.x <= dims.width && vp.y >= 0 && vp.y <= dims.height;

  if (isInside) {
    const baseAngle = ((horizonAngle || 0) * Math.PI) / 180;
    const step = (Math.PI * 2) / n;
    for (let i = 0; i < n; i++) {
      const angle = baseAngle + i * step;
      directions.push({ x: Math.cos(angle), y: Math.sin(angle) });
    }
    return directions;
  }

  const cx = dims.width * 0.5;
  const cy = dims.height * 0.5;
  const refAngle = Math.atan2(cy - vp.y, cx - vp.x);

  const corners: Vector2D[] = [
    { x: 0, y: 0 },
    { x: dims.width, y: 0 },
    { x: dims.width, y: dims.height },
    { x: 0, y: dims.height },
  ];

  let minDiff = Infinity;
  let maxDiff = -Infinity;

  for (const c of corners) {
    const angle = Math.atan2(c.y - vp.y, c.x - vp.x);
    let diff = angle - refAngle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff <= -Math.PI) diff += 2 * Math.PI;
    if (diff < minDiff) minDiff = diff;
    if (diff > maxDiff) maxDiff = diff;
  }

  const span = maxDiff - minDiff;
  if (span < 1e-4) {
    directions.push({ x: Math.cos(refAngle), y: Math.sin(refAngle) });
    return directions;
  }

  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const angle = refAngle + minDiff + t * span;
    directions.push({ x: Math.cos(angle), y: Math.sin(angle) });
  }

  return directions;
}

/**
 * 2. Renders Clean Guide Rays:
 * Dynamically distributes `ruler.guideRayCount` rays evenly across the canvas for each VP.
 * Drawn inside the canvas bounds with thin semi-transparent black lines.
 */
function renderCleanGuideRays(
  ctx: CanvasRenderingContext2D,
  ruler: PerspectiveRuler,
  dims: CanvasDimensions,
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  screenRect: { x: number; y: number; width: number; height: number },
  canvasCorners: Vector2D[],
  flipX: boolean = false,
  flipY: boolean = false
) {
  ctx.save();

  // Draw inside canvas boundary with crisp thin black lines
  ctx.beginPath();
  ctx.moveTo(canvasCorners[0].x, canvasCorners[0].y);
  ctx.lineTo(canvasCorners[1].x, canvasCorners[1].y);
  ctx.lineTo(canvasCorners[2].x, canvasCorners[2].y);
  ctx.lineTo(canvasCorners[3].x, canvasCorners[3].y);
  ctx.closePath();
  ctx.clip();

  const rayCount = ruler.guideRayCount || 6;

  for (const vp of ruler.vps) {
    const rayDirs = computeVpRayDirections(vp, dims, rayCount, ruler.horizonAngle);
    const sVp = canvasToScreen(vp.x, vp.y, pan, zoom, rotation, dims, flipX, flipY);

    for (const dir of rayDirs) {
      const pFar = { x: vp.x + dir.x * 10000, y: vp.y + dir.y * 10000 };
      const sFar = canvasToScreen(pFar.x, pFar.y, pan, zoom, rotation, dims, flipX, flipY);
      const sDir = { x: sFar.x - sVp.x, y: sFar.y - sVp.y };
      const sLen = Math.hypot(sDir.x, sDir.y);
      if (sLen < 1e-4) continue;
      const uDir = { x: sDir.x / sLen, y: sDir.y / sLen };
      const clipped = clipRayForward(sVp, uDir, screenRect);
      if (clipped) {
        drawCleanLine(ctx, clipped[0], clipped[1], 'rgba(0, 0, 0, 0.35)', 1.0);
      }
    }
  }

  ctx.restore();
}

/**
 * 3. Renders Exactly 1 Upright Vertical Guideline across the canvas center
 */
function renderVerticalGuide(
  ctx: CanvasRenderingContext2D,
  ruler: PerspectiveRuler,
  dims: CanvasDimensions,
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  screenRect: { x: number; y: number; width: number; height: number },
  canvasCorners: Vector2D[],
  flipX: boolean = false,
  flipY: boolean = false
) {
  if (ruler.type !== '1-point' && ruler.type !== '2-point') return;

  const horizon = getHorizonLine(ruler);
  const originDoc = { x: dims.width * 0.5, y: dims.height * 0.5 };
  const sOrigin = canvasToScreen(originDoc.x, originDoc.y, pan, zoom, rotation, dims, flipX, flipY);

  const pNextDoc = {
    x: originDoc.x + horizon.normal.x * 1000,
    y: originDoc.y + horizon.normal.y * 1000,
  };
  const sNext = canvasToScreen(pNextDoc.x, pNextDoc.y, pan, zoom, rotation, dims, flipX, flipY);

  const sDir = { x: sNext.x - sOrigin.x, y: sNext.y - sOrigin.y };
  const sLen = Math.hypot(sDir.x, sDir.y);
  if (sLen < 1e-4) return;

  const uDir = { x: sDir.x / sLen, y: sDir.y / sLen };
  const clipped = clipLineToRect(sOrigin, uDir, screenRect);
  if (!clipped) return;

  // Clip strictly within the canvas paper bounds
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(canvasCorners[0].x, canvasCorners[0].y);
  ctx.lineTo(canvasCorners[1].x, canvasCorners[1].y);
  ctx.lineTo(canvasCorners[2].x, canvasCorners[2].y);
  ctx.lineTo(canvasCorners[3].x, canvasCorners[3].y);
  ctx.closePath();
  ctx.clip();

  drawCleanLine(ctx, clipped[0], clipped[1], 'rgba(0, 0, 0, 0.32)');
  ctx.restore();
}

/**
 * Helper: Draws a thin 1px line with a faint contrast underlay
 */
function drawCleanLine(
  ctx: CanvasRenderingContext2D,
  p1: Vector2D,
  p2: Vector2D,
  color: string,
  width: number = 1.0
) {
  ctx.save();
  // Faint white contrast underlay
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.lineWidth = width + 0.8;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();

  // Thin crisp core
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  ctx.restore();
}

/**
 * 4. Renders Active Snapped Constraint Axis (Laser highlight while drawing)
 */
function renderActiveLockedAxis(
  ctx: CanvasRenderingContext2D,
  axis: ConstraintAxis,
  dims: CanvasDimensions,
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  screenRect: { x: number; y: number; width: number; height: number },
  flipX: boolean = false,
  flipY: boolean = false
) {
  const sOrigin = canvasToScreen(axis.origin.x, axis.origin.y, pan, zoom, rotation, dims, flipX, flipY);
  const pNext = { x: axis.origin.x + axis.dir.x * 1000, y: axis.origin.y + axis.dir.y * 1000 };
  const sNext = canvasToScreen(pNext.x, pNext.y, pan, zoom, rotation, dims, flipX, flipY);

  const sDir = { x: sNext.x - sOrigin.x, y: sNext.y - sOrigin.y };
  const sLen = Math.hypot(sDir.x, sDir.y);
  if (sLen < 1e-4) return;

  const uDir = { x: sDir.x / sLen, y: sDir.y / sLen };
  const clipped = clipLineToRect(sOrigin, uDir, screenRect);
  if (!clipped) return;

  const [p1, p2] = clipped;

  ctx.save();
  // Soft outer emerald glow
  ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();

  // Crisp snapped line
  ctx.strokeStyle = '#059669';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();

  ctx.restore();
}

/**
 * 5. Renders Vanishing Point Target Pivots (on screen only)
 */
function renderVanishingPointVisuals(
  ctx: CanvasRenderingContext2D,
  ruler: PerspectiveRuler,
  dims: CanvasDimensions,
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  screenRect: { x: number; y: number; width: number; height: number },
  flipX: boolean = false,
  flipY: boolean = false
) {
  for (const vp of ruler.vps) {
    const sPos = canvasToScreen(vp.x, vp.y, pan, zoom, rotation, dims, flipX, flipY);
    const isInside =
      sPos.x >= 0 &&
      sPos.x <= screenRect.width &&
      sPos.y >= 0 &&
      sPos.y <= screenRect.height;

    if (isInside) {
      ctx.save();
      // Target crosshairs in thin black
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(sPos.x - 12, sPos.y);
      ctx.lineTo(sPos.x + 12, sPos.y);
      ctx.moveTo(sPos.x, sPos.y - 12);
      ctx.lineTo(sPos.x, sPos.y + 12);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(sPos.x - 12, sPos.y);
      ctx.lineTo(sPos.x + 12, sPos.y);
      ctx.moveTo(sPos.x, sPos.y - 12);
      ctx.lineTo(sPos.x, sPos.y + 12);
      ctx.stroke();

      // Outer pivot circle
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(sPos.x, sPos.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.restore();
    }
  }
}
