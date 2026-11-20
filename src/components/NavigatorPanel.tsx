import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize,
  RotateCcw,
  RotateCw,
  FlipHorizontal,
  FlipVertical,
  Compass,
} from 'lucide-react';
import { CanvasDimensions, LayerItem } from '../types/editor';
import { ThemePreset } from '../types/settings';
import { SparseTileGrid } from '../utils/tileEngine';
import { ViewportCompositor } from '../utils/compositor';
import { formatRotationDegrees } from '../utils/canvasUtils';
import {
  CameraTransformState,
  CanvasNavigationHandle,
  MAX_ZOOM,
  MIN_ZOOM,
  formatZoomPercent,
} from '../hooks/useCanvasNavigation';

export const NAVIGATOR_PREVIEW_THROTTLE_MS = 200;
const PREVIEW_PADDING = 8;
const MAX_PREVIEW_LONG_EDGE = 256;
const SLIDER_MAX = 1000;

export interface DocPoint {
  x: number;
  y: number;
}

export interface PreviewBoxMetrics {
  stageW: number;
  stageH: number;
  offsetX: number;
  offsetY: number;
  drawW: number;
  drawH: number;
  scale: number;
}

/** Logarithmic zoom <-> slider [0..1000] mapping for CSP-like smooth zoom control. */
export function zoomToSliderPos(zoom: number): number {
  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number.isFinite(zoom) ? zoom : 1));
  const minLog = Math.log(MIN_ZOOM);
  const maxLog = Math.log(MAX_ZOOM);
  return Math.round(((Math.log(clamped) - minLog) / (maxLog - minLog)) * SLIDER_MAX);
}

export function sliderPosToZoom(pos: number): number {
  const clamped = Math.max(0, Math.min(SLIDER_MAX, Number.isFinite(pos) ? pos : 0));
  const minLog = Math.log(MIN_ZOOM);
  const maxLog = Math.log(MAX_ZOOM);
  return Math.exp(minLog + (clamped / SLIDER_MAX) * (maxLog - minLog));
}

/**
 * Unprojects a viewport-local point `(vx, vy)` into document coordinates,
 * matching `screenToCanvas` with rotation and `flipX`/`flipY`.
 */
export function viewportPointToDoc(
  vx: number,
  vy: number,
  cam: CameraTransformState,
  dimensions: CanvasDimensions
): DocPoint {
  const safeZoom = Math.max(0.0001, cam.zoom);
  const rx = vx - cam.pan.x;
  const ry = vy - cam.pan.y;
  const rad = (cam.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const unrotX = rx * cos + ry * sin;
  const unrotY = -rx * sin + ry * cos;
  const fx = cam.flipX ? -1 : 1;
  const fy = cam.flipY ? -1 : 1;
  return {
    x: dimensions.width / 2 + (fx * unrotX) / safeZoom,
    y: dimensions.height / 2 + (fy * unrotY) / safeZoom,
  };
}

/**
 * Returns the 4 corners [TL, TR, BR, BL] of the visible main viewport in document space.
 */
export function computeViewportQuadInDoc(
  viewportW: number,
  viewportH: number,
  cam: CameraTransformState,
  dimensions: CanvasDimensions
): [DocPoint, DocPoint, DocPoint, DocPoint] {
  return [
    viewportPointToDoc(0, 0, cam, dimensions),
    viewportPointToDoc(viewportW, 0, cam, dimensions),
    viewportPointToDoc(viewportW, viewportH, cam, dimensions),
    viewportPointToDoc(0, viewportH, cam, dimensions),
  ];
}

/**
 * Computes the exact `pan` that places `targetDoc` at the center of `(viewportW, viewportH)`
 * under the current zoom, rotation, flipX, and flipY.
 */
export function computePanForDocCenter(
  targetDoc: DocPoint,
  viewportW: number,
  viewportH: number,
  cam: Pick<CameraTransformState, 'zoom' | 'rotation' | 'flipX' | 'flipY'>,
  dimensions: CanvasDimensions
): { x: number; y: number } {
  const fx = cam.flipX ? -1 : 1;
  const fy = cam.flipY ? -1 : 1;
  const dx = (targetDoc.x - dimensions.width / 2) * fx;
  const dy = (targetDoc.y - dimensions.height / 2) * fy;
  const rad = (cam.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = cam.zoom * (dx * cos - dy * sin);
  const ry = cam.zoom * (dx * sin + dy * cos);
  return {
    x: viewportW / 2 - rx,
    y: viewportH / 2 - ry,
  };
}

/** Point-in-convex-quad test (orientation invariant to handle mirrored flipX/flipY quads). */
export function isPointInConvexQuad(
  pt: DocPoint,
  quad: [DocPoint, DocPoint, DocPoint, DocPoint]
): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const cross = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x);
    if (Math.abs(cross) < 1e-6) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return true;
}

export function computePreviewBoxMetrics(
  stageW: number,
  stageH: number,
  dimensions: CanvasDimensions
): PreviewBoxMetrics {
  const safeW = Math.max(24, stageW);
  const safeH = Math.max(24, stageH);
  const docW = Math.max(1, dimensions.width);
  const docH = Math.max(1, dimensions.height);
  const availW = Math.max(12, safeW - PREVIEW_PADDING * 2);
  const availH = Math.max(12, safeH - PREVIEW_PADDING * 2);
  const scale = Math.min(availW / docW, availH / docH);
  const drawW = Math.max(1, docW * scale);
  const drawH = Math.max(1, docH * scale);
  return {
    stageW: safeW,
    stageH: safeH,
    offsetX: (safeW - drawW) / 2,
    offsetY: (safeH - drawH) / 2,
    drawW,
    drawH,
    scale,
  };
}

export interface NavigatorPanelProps {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  navigation: CanvasNavigationHandle;
  dimensions: CanvasDimensions;
  layers: LayerItem[];
  tileGrid: SparseTileGrid;
  showCheckerboard: boolean;
  zoom: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToScreen: () => void;
  onZoomActualSize: () => void;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onResetRotation: () => void;
  onToggleFlipHorizontal: () => void;
  onToggleFlipVertical: () => void;
  themePreset?: ThemePreset;
  throttleMs?: number;
}

export const NavigatorPanel: React.FC<NavigatorPanelProps> = React.memo(
  ({
    viewportRef,
    navigation,
    dimensions,
    layers,
    tileGrid,
    showCheckerboard,
    zoom,
    rotation,
    flipX,
    flipY,
    onZoomIn,
    onZoomOut,
    onFitToScreen,
    onZoomActualSize,
    onRotateLeft,
    onRotateRight,
    onResetRotation,
    onToggleFlipHorizontal,
    onToggleFlipVertical,
    themePreset = 'modern',
    throttleMs = NAVIGATOR_PREVIEW_THROTTLE_MS,
  }) => {
    const isVintage = themePreset === 'vintage-manga';

    const stageRef = useRef<HTMLDivElement | null>(null);
    const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const zoomSliderRef = useRef<HTMLInputElement | null>(null);
    const zoomLabelRef = useRef<HTMLSpanElement | null>(null);
    const angleLabelRef = useRef<HTMLSpanElement | null>(null);

    const [stageSize, setStageSize] = useState<{ width: number; height: number }>({
      width: 200,
      height: 120,
    });
    const [isDraggingFrame, setIsDraggingFrame] = useState(false);

    const metricsRef = useRef<PreviewBoxMetrics>(
      computePreviewBoxMetrics(200, 120, dimensions)
    );
    metricsRef.current = computePreviewBoxMetrics(stageSize.width, stageSize.height, dimensions);

    const latestSceneRef = useRef({
      layers,
      dimensions,
      tileGrid,
      showCheckerboard,
    });
    latestSceneRef.current = { layers, dimensions, tileGrid, showCheckerboard };

    const dragStateRef = useRef<{
      active: boolean;
      pointerId: number | null;
      grabOffsetDoc: DocPoint;
    }>({
      active: false,
      pointerId: null,
      grabOffsetDoc: { x: 0, y: 0 },
    });

    const getMainViewportSize = useCallback((): { vw: number; vh: number } => {
      const vp = viewportRef.current;
      const vw = vp && vp.clientWidth > 0 ? vp.clientWidth : 800;
      const vh = vp && vp.clientHeight > 0 ? vp.clientHeight : 600;
      return { vw, vh };
    }, [viewportRef]);

    // Draw ONLY the red viewport frame overlay (60-240Hz via navigation.subscribeCamera, zero React re-renders)
    const drawViewportOverlay = useCallback(
      (cam?: CameraTransformState) => {
        const overlay = overlayCanvasRef.current;
        if (!overlay) return;
        const ctx = overlay.getContext('2d');
        if (!ctx) return;

        const m = metricsRef.current;
        const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
        const targetW = Math.max(1, Math.round(m.stageW * dpr));
        const targetH = Math.max(1, Math.round(m.stageH * dpr));
        if (overlay.width !== targetW || overlay.height !== targetH) {
          overlay.width = targetW;
          overlay.height = targetH;
        }

        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, m.stageW, m.stageH);

        // Subtle document outline border
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
        ctx.lineWidth = 1;
        ctx.strokeRect(
          Math.floor(m.offsetX) + 0.5,
          Math.floor(m.offsetY) + 0.5,
          Math.max(1, Math.round(m.drawW)),
          Math.max(1, Math.round(m.drawH))
        );

        const activeCam = cam ?? navigation.getCameraState();
        const { vw, vh } = getMainViewportSize();
        const quad = computeViewportQuadInDoc(vw, vh, activeCam, latestSceneRef.current.dimensions);

        const pts = quad.map((p) => ({
          x: m.offsetX + p.x * m.scale,
          y: m.offsetY + p.y * m.scale,
        }));

        // Red viewport frame polygon
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.lineTo(pts[2].x, pts[2].y);
        ctx.lineTo(pts[3].x, pts[3].y);
        ctx.closePath();

        ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
        ctx.fill();
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Top-edge orientation indicator tick (makes rotation & flipY immediately readable)
        const topMidX = (pts[0].x + pts[1].x) * 0.5;
        const topMidY = (pts[0].y + pts[1].y) * 0.5;
        const cx = (pts[0].x + pts[2].x) * 0.5;
        const cy = (pts[0].y + pts[2].y) * 0.5;
        const vx = topMidX - cx;
        const vy = topMidY - cy;
        const len = Math.hypot(vx, vy);
        if (len > 4) {
          const ux = vx / len;
          const uy = vy / len;
          ctx.beginPath();
          ctx.moveTo(topMidX, topMidY);
          ctx.lineTo(topMidX + ux * 4, topMidY + uy * 4);
          ctx.strokeStyle = '#f87171';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        ctx.restore();

        // Live DOM sync for zoom slider/readout and angle without React re-render
        if (zoomSliderRef.current) {
          zoomSliderRef.current.value = String(zoomToSliderPos(activeCam.zoom));
        }
        if (zoomLabelRef.current) {
          zoomLabelRef.current.textContent = formatZoomPercent(activeCam.zoom);
        }
        if (angleLabelRef.current) {
          angleLabelRef.current.textContent = formatRotationDegrees(activeCam.rotation);
        }
      },
      [getMainViewportSize, navigation]
    );

    // Throttled low-LOD preview composite (<= 1 render per ~200ms during rapid brush strokes)
    const lastPreviewTsRef = useRef<number>(0);
    const lastContentVersionRef = useRef<number>(-1);
    const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const renderPreviewNow = useCallback(() => {
      const canvas = previewCanvasRef.current;
      if (!canvas) return;
      const { layers: curLayers, dimensions: curDims, tileGrid: curGrid, showCheckerboard: curCheck } =
        latestSceneRef.current;
      const docW = Math.max(1, curDims.width);
      const docH = Math.max(1, curDims.height);
      const scale = Math.min(1, MAX_PREVIEW_LONG_EDGE / Math.max(docW, docH));
      const targetW = Math.max(1, Math.round(docW * scale));
      const targetH = Math.max(1, Math.round(docH * scale));
      if (canvas.width !== targetW) canvas.width = targetW;
      if (canvas.height !== targetH) canvas.height = targetH;

      ViewportCompositor.renderLowResPreview(canvas, curLayers, curDims, curGrid, {
        showCheckerboard: curCheck,
      });
      if (typeof curGrid.getContentVersion === 'function') {
        lastContentVersionRef.current = curGrid.getContentVersion();
      }
      lastPreviewTsRef.current = Date.now();
    }, []);

    const scheduleThrottledPreview = useCallback(() => {
      const now = Date.now();
      const elapsed = now - lastPreviewTsRef.current;
      if (elapsed >= throttleMs) {
        if (previewTimerRef.current !== null) {
          clearTimeout(previewTimerRef.current);
          previewTimerRef.current = null;
        }
        renderPreviewNow();
        return;
      }
      if (previewTimerRef.current !== null) return;
      const remaining = Math.max(16, throttleMs - elapsed);
      previewTimerRef.current = setTimeout(() => {
        previewTimerRef.current = null;
        renderPreviewNow();
      }, remaining);
    }, [renderPreviewNow, throttleMs]);

    // Track Navigator preview stage size via ResizeObserver
    useEffect(() => {
      const el = stageRef.current;
      if (!el) return;
      const syncSize = () => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          setStageSize((prev) =>
            Math.abs(prev.width - rect.width) < 1 && Math.abs(prev.height - rect.height) < 1
              ? prev
              : { width: Math.round(rect.width), height: Math.round(rect.height) }
          );
        }
      };
      syncSize();
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncSize) : null;
      ro?.observe(el);
      return () => ro?.disconnect();
    }, []);

    // Trigger throttled composite on layer/dimension/background changes
    useEffect(() => {
      scheduleThrottledPreview();
    }, [layers, dimensions, showCheckerboard, tileGrid, scheduleThrottledPreview]);

    // Subscribe to SparseTileGrid changes with 200ms throttle, ignoring draft-only redraw notifications
    useEffect(() => {
      lastContentVersionRef.current = -1;
      const unsub = tileGrid.subscribe(() => {
        if (
          typeof tileGrid.getContentVersion === 'function' &&
          tileGrid.getContentVersion() === lastContentVersionRef.current
        ) {
          return;
        }
        scheduleThrottledPreview();
      });
      return () => {
        unsub();
        if (previewTimerRef.current !== null) {
          clearTimeout(previewTimerRef.current);
          previewTimerRef.current = null;
        }
      };
    }, [tileGrid, scheduleThrottledPreview]);

    // Direct rAF camera subscription for zero-rerender red viewport frame updates
    useEffect(() => {
      drawViewportOverlay(navigation.getCameraState());
      const unsub = navigation.subscribeCamera((cam) => {
        drawViewportOverlay(cam);
      });
      return unsub;
    }, [navigation, drawViewportOverlay, stageSize, dimensions]);

    // Re-sync overlay when main canvas viewport resizes
    useEffect(() => {
      const vp = viewportRef.current;
      if (!vp || typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(() => drawViewportOverlay(navigation.getCameraState()));
      ro.observe(vp);
      return () => ro.disconnect();
    }, [viewportRef, navigation, drawViewportOverlay]);

    const pointerEventToDoc = useCallback((clientX: number, clientY: number): DocPoint | null => {
      const stage = stageRef.current;
      if (!stage) return null;
      const rect = stage.getBoundingClientRect();
      const m = metricsRef.current;
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      return {
        x: (localX - m.offsetX) / Math.max(1e-5, m.scale),
        y: (localY - m.offsetY) / Math.max(1e-5, m.scale),
      };
    }, []);

    const applyPanForTargetDoc = useCallback(
      (targetDoc: DocPoint, commit: boolean) => {
        const cam = navigation.getCameraState();
        const { vw, vh } = getMainViewportSize();
        const nextPan = computePanForDocCenter(
          targetDoc,
          vw,
          vh,
          cam,
          latestSceneRef.current.dimensions
        );
        if (navigation.setPanLive) {
          navigation.setPanLive(nextPan, commit);
        } else {
          navigation.panRef.current = nextPan;
        }
      },
      [getMainViewportSize, navigation]
    );

    const handleStagePointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const ptDoc = pointerEventToDoc(e.clientX, e.clientY);
        if (!ptDoc) return;

        const cam = navigation.getCameraState();
        const { vw, vh } = getMainViewportSize();
        const dims = latestSceneRef.current.dimensions;
        const quad = computeViewportQuadInDoc(vw, vh, cam, dims);

        let grabOffsetDoc: DocPoint = { x: 0, y: 0 };
        if (isPointInConvexQuad(ptDoc, quad)) {
          const centerDoc = viewportPointToDoc(vw / 2, vh / 2, cam, dims);
          grabOffsetDoc = {
            x: centerDoc.x - ptDoc.x,
            y: centerDoc.y - ptDoc.y,
          };
        } else {
          applyPanForTargetDoc(ptDoc, false);
        }

        dragStateRef.current = {
          active: true,
          pointerId: e.pointerId,
          grabOffsetDoc,
        };
        setIsDraggingFrame(true);
        try {
          e.currentTarget.setPointerCapture?.(e.pointerId);
        } catch {
          // Ignore in synthetic pointer events
        }
      },
      [applyPanForTargetDoc, getMainViewportSize, navigation, pointerEventToDoc]
    );

    const handleStagePointerMove = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragStateRef.current.active) return;
        const ptDoc = pointerEventToDoc(e.clientX, e.clientY);
        if (!ptDoc) return;
        const targetDoc = {
          x: ptDoc.x + dragStateRef.current.grabOffsetDoc.x,
          y: ptDoc.y + dragStateRef.current.grabOffsetDoc.y,
        };
        applyPanForTargetDoc(targetDoc, false);
      },
      [applyPanForTargetDoc, pointerEventToDoc]
    );

    const finishStageDrag = useCallback(
      (e?: React.PointerEvent<HTMLDivElement>) => {
        if (!dragStateRef.current.active) return;
        const pid = dragStateRef.current.pointerId;
        dragStateRef.current.active = false;
        dragStateRef.current.pointerId = null;
        setIsDraggingFrame(false);
        if (e && pid !== null) {
          try {
            e.currentTarget.releasePointerCapture?.(pid);
          } catch {
            // Ignore in synthetic pointer events
          }
        }
        navigation.commitCameraState?.();
      },
      [navigation]
    );

    const handleZoomSliderInput = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const pos = Number(e.target.value);
        const nextZoom = sliderPosToZoom(pos);
        if (navigation.setZoomLive) {
          navigation.setZoomLive(nextZoom, false);
        }
      },
      [navigation]
    );

    const handleZoomSliderCommit = useCallback(() => {
      navigation.commitCameraState?.();
    }, [navigation]);

    const m = metricsRef.current;

    const btnBase = isVintage
      ? 'h-5 px-1 rounded text-[10px] flex items-center justify-center text-[#d0d0d5] hover:text-white hover:bg-[#4e4e52] transition-colors cursor-pointer'
      : 'h-5 px-1 rounded text-[10px] flex items-center justify-center text-[#a3a3a3] hover:text-[#f5f5f5] hover:bg-[#2c2c2c] transition-colors cursor-pointer';

    const btnActive = isVintage
      ? 'bg-[#337bb5] text-white'
      : 'bg-[var(--accent-subtle)] text-[var(--accent)] ring-1 ring-inset ring-[var(--accent-border)]';

    return (
      <div
        data-testid="navigator-panel"
        data-theme-preset={themePreset}
        className={`flex flex-col h-full min-h-0 select-none ${
          isVintage ? 'bg-[#363638] text-[#e5e5e5]' : 'bg-[#202020] text-[#e5e5e5]'
        }`}
      >
        {/* Interactive Canvas Preview Stage */}
        <div
          ref={stageRef}
          data-testid="navigator-preview-stage"
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={finishStageDrag}
          onPointerCancel={finishStageDrag}
          className={`relative flex-1 min-h-[76px] overflow-hidden ${
            isDraggingFrame ? 'cursor-grabbing' : 'cursor-grab'
          } ${isVintage ? 'bg-[#252527]' : 'bg-[#141414]'}`}
          title="Click or drag red viewport frame to pan canvas"
        >
          <canvas
            ref={previewCanvasRef}
            data-testid="navigator-preview-canvas"
            style={{
              position: 'absolute',
              left: `${m.offsetX}px`,
              top: `${m.offsetY}px`,
              width: `${m.drawW}px`,
              height: `${m.drawH}px`,
              imageRendering: m.scale > 1.5 ? 'pixelated' : 'auto',
            }}
            className="pointer-events-none shadow-sm"
          />
          <canvas
            ref={overlayCanvasRef}
            data-testid="navigator-overlay-canvas"
            className="absolute inset-0 w-full h-full pointer-events-none"
          />
        </div>

        {/* Compact Control Bar */}
        <div
          className={`shrink-0 px-1.5 py-1 flex flex-col gap-1 border-t ${
            isVintage
              ? 'bg-[#313134] border-[#232325]'
              : 'bg-[#1b1b1b] border-white/[0.06]'
          }`}
        >
          {/* Row 1: Zoom Controls */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="nav-zoom-out"
              onClick={onZoomOut}
              title="Zoom Out"
              className={`${btnBase} w-5 shrink-0`}
            >
              <ZoomOut className="w-3 h-3" />
            </button>
            <input
              ref={zoomSliderRef}
              type="range"
              data-testid="nav-zoom-slider"
              min={0}
              max={SLIDER_MAX}
              defaultValue={zoomToSliderPos(zoom)}
              onChange={handleZoomSliderInput}
              onPointerUp={handleZoomSliderCommit}
              onKeyUp={handleZoomSliderCommit}
              aria-label="Zoom"
              className="flex-1 min-w-0 h-1 accent-[var(--accent)] cursor-pointer"
            />
            <button
              type="button"
              data-testid="nav-zoom-in"
              onClick={onZoomIn}
              title="Zoom In"
              className={`${btnBase} w-5 shrink-0`}
            >
              <ZoomIn className="w-3 h-3" />
            </button>
            <span
              ref={zoomLabelRef}
              data-testid="nav-zoom-readout"
              className="text-[10px] font-mono tabular-nums text-[#b5b5b5] w-10 text-right shrink-0"
            >
              {formatZoomPercent(zoom)}
            </span>
          </div>

          {/* Row 2: Fit / 100% / Rotate / Reset Angle / Flip H & V */}
          <div className="flex items-center justify-between gap-0.5 flex-wrap">
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                data-testid="nav-fit-screen"
                onClick={onFitToScreen}
                title="Fit to Screen (Ctrl+0)"
                className={btnBase}
              >
                <Maximize className="w-3 h-3" />
              </button>
              <button
                type="button"
                data-testid="nav-zoom-100"
                onClick={onZoomActualSize}
                title="Actual Pixels (100%)"
                className={`${btnBase} px-1 font-mono`}
              >
                100%
              </button>
            </div>

            <div className="flex items-center gap-0.5">
              <button
                type="button"
                data-testid="nav-rotate-left"
                onClick={onRotateLeft}
                title="Rotate Left (-15°)"
                className={`${btnBase} w-5`}
              >
                <RotateCcw className="w-3 h-3" />
              </button>
              <button
                type="button"
                data-testid="nav-reset-rotation"
                onClick={onResetRotation}
                title="Reset Canvas Angle (0°)"
                className={`${btnBase} gap-0.5 px-1 font-mono tabular-nums`}
              >
                <Compass className="w-2.5 h-2.5 opacity-70" />
                <span ref={angleLabelRef} data-testid="nav-angle-readout">
                  {formatRotationDegrees(rotation)}
                </span>
              </button>
              <button
                type="button"
                data-testid="nav-rotate-right"
                onClick={onRotateRight}
                title="Rotate Right (+15°)"
                className={`${btnBase} w-5`}
              >
                <RotateCw className="w-3 h-3" />
              </button>
            </div>

            <div className="flex items-center gap-0.5">
              <button
                type="button"
                data-testid="nav-flip-h"
                onClick={onToggleFlipHorizontal}
                aria-pressed={flipX}
                title="Flip Horizontal View (Shift+H)"
                className={`${btnBase} w-5 ${flipX ? btnActive : ''}`}
              >
                <FlipHorizontal className="w-3 h-3" />
              </button>
              <button
                type="button"
                data-testid="nav-flip-v"
                onClick={onToggleFlipVertical}
                aria-pressed={flipY}
                title="Flip Vertical View (Shift+V)"
                className={`${btnBase} w-5 ${flipY ? btnActive : ''}`}
              >
                <FlipVertical className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

NavigatorPanel.displayName = 'NavigatorPanel';
