import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { CanvasDimensions } from '../types/editor';
import { toolStoreActions, useToolStore, useUiStore } from '../stores';
import { stepBrushSizePreset } from '../utils/brushPresetManager';
import { resolveHeldKeyModifierAction } from '../utils/shortcutManager';

export const MIN_ZOOM = 0.01; // 1%
export const MAX_ZOOM = 32.0; // 3200%

/** Debounce window (ms) before committing high-frequency camera updates to React UI state. */
export const NAV_STATE_COMMIT_DEBOUNCE_MS = 140;

/** Custom DOM event name dispatched on window whenever live camera transform changes. */
export const CAMERA_CHANGE_EVENT = 'ink-camera-change';

export interface CameraTransformState {
  pan: { x: number; y: number };
  zoom: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
}

export type CameraSubscriber = (camera: CameraTransformState) => void;

export interface CanvasNavigationHandle {
  zoomRef: React.MutableRefObject<number>;
  panRef: React.MutableRefObject<{ x: number; y: number }>;
  rotationRef: React.MutableRefObject<number>;
  flipXRef: React.MutableRefObject<boolean>;
  flipYRef: React.MutableRefObject<boolean>;
  getCameraState: () => CameraTransformState;
  subscribeCamera: (listener: CameraSubscriber) => () => void;
  setPanLive?: (pan: { x: number; y: number }, commit?: boolean) => void;
  setZoomLive?: (targetZoom: number, commit?: boolean) => void;
  rotateBy?: (deltaDeg: number) => void;
  commitCameraState?: () => void;
}

export const ZOOM_PRESETS = [
  0.01,
  0.02,
  0.03,
  0.05,
  0.0625,
  0.0833,
  0.1,
  0.125,
  0.1667,
  0.25,
  0.3333,
  0.5,
  0.6667,
  0.75,
  1.0,
  1.25,
  1.5,
  2.0,
  3.0,
  4.0,
  6.0,
  8.0,
  12.0,
  16.0,
  24.0,
  32.0,
];

export const ROTATE_CURSOR_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M16 5 A11 11 0 0 1 27 16 A11 11 0 0 1 24.5 22.5" stroke="%23ffffff" stroke-width="3.5" stroke-linecap="round"/><path d="M16 5 A11 11 0 0 1 27 16 A11 11 0 0 1 24.5 22.5" stroke="%231a1a1a" stroke-width="2" stroke-linecap="round"/><polygon points="25.5,18 28.5,24 22,24" fill="%231a1a1a" stroke="%23ffffff" stroke-width="1.5"/><path d="M16 27 A11 11 0 0 1 5 16 A11 11 0 0 1 7.5 9.5" stroke="%23ffffff" stroke-width="3.5" stroke-linecap="round"/><path d="M16 27 A11 11 0 0 1 5 16 A11 11 0 0 1 7.5 9.5" stroke="%231a1a1a" stroke-width="2" stroke-linecap="round"/><polygon points="6.5,14 3.5,8 10,8" fill="%231a1a1a" stroke="%23ffffff" stroke-width="1.5"/><circle cx="16" cy="16" r="2" fill="%231a1a1a" stroke="%23ffffff" stroke-width="1.5"/></svg>`;
export const ROTATE_CURSOR_CSS = `url('${ROTATE_CURSOR_SVG}') 16 16, crosshair`;

export const ROTATION_CENTER_DAMP_RADIUS = 64;

/**
 * Computes a continuous, branch-cut-free signed angular delta (degrees) between two
 * pointer positions around a pivot, with smooth radial damping near the pivot center
 * to eliminate atan2 singularity jumps.
 */
export function computeSmoothRotationDelta(
  prevX: number,
  prevY: number,
  curX: number,
  curY: number,
  centerX: number,
  centerY: number
): number {
  const v1x = prevX - centerX;
  const v1y = prevY - centerY;
  const v2x = curX - centerX;
  const v2y = curY - centerY;

  const r1 = Math.hypot(v1x, v1y);
  const r2 = Math.hypot(v2x, v2y);
  if (r1 < 1e-4 || r2 < 1e-4) return 0;

  const cross = v1x * v2y - v1y * v2x;
  const dot = v1x * v2x + v1y * v2y;
  const rawDeg = Math.atan2(cross, dot) * (180 / Math.PI);

  const minR = Math.min(r1, r2);
  if (minR >= ROTATION_CENTER_DAMP_RADIUS) {
    return rawDeg;
  }
  const t = Math.max(0, Math.min(1, minR / ROTATION_CENTER_DAMP_RADIUS));
  const smoothGain = t * t * (3 - 2 * t);
  return rawDeg * smoothGain;
}

export function formatZoomPercent(zoom: number): string {
  const safeZoom = Number.isFinite(zoom) ? zoom : 1.0;
  const percent = safeZoom * 100;
  if (percent >= 100) {
    return `${Math.round(percent)}%`;
  }
  const rounded = Math.round(percent * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

export const VIEWPORT_FIT_PADDING = 48;

/**
 * Calculates adaptive zoom based on layer/canvas dimensions and viewport size.
 */
export function calculateAdaptiveZoom(
  dimensions: CanvasDimensions | undefined,
  viewport: HTMLDivElement | null
): number {
  if (
    !dimensions ||
    typeof dimensions.width !== 'number' ||
    typeof dimensions.height !== 'number' ||
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    dimensions.height <= 0 ||
    dimensions.width <= 0
  ) {
    return 1.0;
  }

  let vw = viewport?.clientWidth ?? 0;
  let vh = viewport?.clientHeight ?? 0;

  if (vw <= 0 || vh <= 0) {
    if (typeof window !== 'undefined') {
      vw = Math.max(300, window.innerWidth - 300);
      vh = Math.max(300, window.innerHeight - 80);
    } else {
      return 1.0;
    }
  }

  const availH = Math.max(20, vh - VIEWPORT_FIT_PADDING);
  const availW = Math.max(20, vw - VIEWPORT_FIT_PADDING);

  const scaleY = availH / dimensions.height;
  const scaleX = availW / dimensions.width;
  const fitZoom = Math.min(scaleY, scaleX);

  const targetZoom = fitZoom < 1.0 ? fitZoom : 1.0;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetZoom));
}

interface UseCanvasNavigationProps {
  dimensions?: CanvasDimensions;
  isWebtoonMode?: boolean;
  activeDocumentId?: string | null;
}

export function useCanvasNavigation({
  dimensions,
  isWebtoonMode = false,
  activeDocumentId = null,
}: UseCanvasNavigationProps = {}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const [zoom, setZoomState] = useState<number>(1.0);
  const [pan, setPanState] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [rotation, setRotationState] = useState<number>(0.0);
  const [flipX, setFlipXState] = useState<boolean>(false);
  const [flipY, setFlipYState] = useState<boolean>(false);

  const dimensionsRef = useRef<CanvasDimensions | undefined>(dimensions);
  dimensionsRef.current = dimensions;

  const isWebtoonModeRef = useRef<boolean>(isWebtoonMode);
  isWebtoonModeRef.current = isWebtoonMode;

  const [isSpaceDown, setIsSpaceDown] = useState<boolean>(false);
  const [isShiftDown, setIsShiftDown] = useState<boolean>(false);
  const [isCtrlDown, setIsCtrlDown] = useState<boolean>(false);
  const [isAltDown, setIsAltDown] = useState<boolean>(false);
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [isRotating, setIsRotating] = useState<boolean>(false);
  const [isZoomDragging, setIsZoomDragging] = useState<boolean>(false);

  // Synchronous refs for sub-frame precision (authoritative source of truth during active interaction)
  const zoomRef = useRef<number>(1.0);
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const rotationRef = useRef<number>(0.0);
  const flipXRef = useRef<boolean>(false);
  const flipYRef = useRef<boolean>(false);

  const isSpaceDownRef = useRef<boolean>(false);
  const isShiftDownRef = useRef<boolean>(false);
  const isCtrlDownRef = useRef<boolean>(false);
  const isAltDownRef = useRef<boolean>(false);
  const isPanningRef = useRef<boolean>(false);
  const isRotatingRef = useRef<boolean>(false);
  const isZoomDraggingRef = useRef<boolean>(false);

  const cameraSubscribersRef = useRef<Set<CameraSubscriber>>(new Set());
  const cameraBroadcastRafRef = useRef<number | null>(null);
  const navCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const getCameraState = useCallback((): CameraTransformState => {
    return {
      pan: { x: panRef.current.x, y: panRef.current.y },
      zoom: zoomRef.current,
      rotation: rotationRef.current,
      flipX: flipXRef.current,
      flipY: flipYRef.current,
    };
  }, []);

  const subscribeCamera = useCallback((listener: CameraSubscriber) => {
    cameraSubscribersRef.current.add(listener);
    return () => {
      cameraSubscribersRef.current.delete(listener);
    };
  }, []);

  const emitCameraToSubscribers = useCallback(() => {
    const camera = getCameraState();
    cameraSubscribersRef.current.forEach((listener) => {
      listener(camera);
    });
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent<CameraTransformState>(CAMERA_CHANGE_EVENT, { detail: camera }));
    }
  }, [getCameraState]);

  // Direct rAF-coalesced camera broadcast to CanvasArea DOM & ViewportCompositor (ZERO React setState calls)
  const scheduleCameraBroadcast = useCallback(() => {
    if (cameraBroadcastRafRef.current !== null) return;
    cameraBroadcastRafRef.current = requestAnimationFrame(() => {
      cameraBroadcastRafRef.current = null;
      emitCameraToSubscribers();
    });
  }, [emitCameraToSubscribers]);

  const broadcastCameraImmediate = useCallback(() => {
    if (cameraBroadcastRafRef.current !== null) {
      cancelAnimationFrame(cameraBroadcastRafRef.current);
      cameraBroadcastRafRef.current = null;
    }
    emitCameraToSubscribers();
  }, [emitCameraToSubscribers]);

  const commitNavStateImmediate = useCallback(() => {
    if (navCommitTimerRef.current !== null) {
      clearTimeout(navCommitTimerRef.current);
      navCommitTimerRef.current = null;
    }
    setZoomState(zoomRef.current);
    setPanState({ x: panRef.current.x, y: panRef.current.y });
    setRotationState(rotationRef.current);
    setFlipXState(flipXRef.current);
    setFlipYState(flipYRef.current);
  }, []);

  // Debounced commit to React state (~140ms after wheel/inertia ends; never per-rAF during motion)
  const scheduleNavStateCommit = useCallback(() => {
    if (navCommitTimerRef.current !== null) {
      clearTimeout(navCommitTimerRef.current);
    }
    navCommitTimerRef.current = setTimeout(() => {
      navCommitTimerRef.current = null;
      if (isPanningRef.current || isRotatingRef.current || isZoomDraggingRef.current) return;
      commitNavStateImmediate();
    }, NAV_STATE_COMMIT_DEBOUNCE_MS);
  }, [commitNavStateImmediate]);

  useEffect(() => {
    return () => {
      if (cameraBroadcastRafRef.current !== null) {
        cancelAnimationFrame(cameraBroadcastRafRef.current);
        cameraBroadcastRafRef.current = null;
      }
      if (navCommitTimerRef.current !== null) {
        clearTimeout(navCommitTimerRef.current);
        navCommitTimerRef.current = null;
      }
    };
  }, []);

  const panStartRef = useRef<{ clientX: number; clientY: number; panX: number; panY: number }>({
    clientX: 0,
    clientY: 0,
    panX: 0,
    panY: 0,
  });

  const rotateStartRef = useRef<{
    lastX: number;
    lastY: number;
    startCanvasRotation: number;
    totalAngleDelta: number;
    targetRotation: number;
    startPan: { x: number; y: number };
    center: { x: number; y: number };
  }>({
    lastX: 0,
    lastY: 0,
    startCanvasRotation: 0,
    totalAngleDelta: 0,
    targetRotation: 0,
    startPan: { x: 0, y: 0 },
    center: { x: 0, y: 0 },
  });

  const zoomDragStartRef = useRef<{
    clientX: number;
    clientY: number;
    anchorX: number;
    anchorY: number;
    startZoom: number;
    startPan: { x: number; y: number };
  }>({
    clientX: 0,
    clientY: 0,
    anchorX: 0,
    anchorY: 0,
    startZoom: 1,
    startPan: { x: 0, y: 0 },
  });

  const hasInitializedCenterRef = useRef<boolean>(false);

  const setZoom = useCallback(
    (newZoomOrFn: number | ((prev: number) => number)) => {
      const next = typeof newZoomOrFn === 'function' ? newZoomOrFn(zoomRef.current) : newZoomOrFn;
      const safe = Number.isFinite(next) ? next : 1.0;
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, safe));
      zoomRef.current = clamped;
      setZoomState(clamped);
      broadcastCameraImmediate();
    },
    [broadcastCameraImmediate]
  );

  const setPan = useCallback(
    (newPanOrFn: { x: number; y: number } | ((prev: { x: number; y: number }) => { x: number; y: number })) => {
      const next = typeof newPanOrFn === 'function' ? newPanOrFn(panRef.current) : newPanOrFn;
      panRef.current = { x: next.x, y: next.y };
      setPanState(panRef.current);
      broadcastCameraImmediate();
    },
    [broadcastCameraImmediate]
  );

  /** Zero-React-rerender live pan update for smooth 60-240Hz Navigator drag. */
  const setPanLive = useCallback(
    (nextPan: { x: number; y: number }, commit = false) => {
      if (!Number.isFinite(nextPan.x) || !Number.isFinite(nextPan.y)) return;
      panRef.current = { x: nextPan.x, y: nextPan.y };
      if (commit) {
        broadcastCameraImmediate();
        commitNavStateImmediate();
      } else {
        scheduleCameraBroadcast();
      }
    },
    [broadcastCameraImmediate, commitNavStateImmediate, scheduleCameraBroadcast]
  );

  const setRotation = useCallback(
    (newRotationOrFn: number | ((prev: number) => number)) => {
      const next = typeof newRotationOrFn === 'function' ? newRotationOrFn(rotationRef.current) : newRotationOrFn;
      rotationRef.current = next;
      setRotationState(next);
      broadcastCameraImmediate();
    },
    [broadcastCameraImmediate]
  );

  /** Rotates canvas around the viewport center by `deltaDeg` degrees. */
  const rotateBy = useCallback(
    (deltaDeg: number) => {
      if (!Number.isFinite(deltaDeg) || Math.abs(deltaDeg) < 0.0001) return;
      const viewport = viewportRef.current;
      const nextRotation = rotationRef.current + deltaDeg;
      if (!viewport || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) {
        rotationRef.current = nextRotation;
        setRotationState(nextRotation);
        broadcastCameraImmediate();
        return;
      }
      const vc = {
        x: viewport.clientWidth / 2,
        y: viewport.clientHeight / 2,
      };
      const dRad = (deltaDeg * Math.PI) / 180;
      const rx = panRef.current.x - vc.x;
      const ry = panRef.current.y - vc.y;
      const newPanX = vc.x + rx * Math.cos(dRad) - ry * Math.sin(dRad);
      const newPanY = vc.y + rx * Math.sin(dRad) + ry * Math.cos(dRad);
      rotationRef.current = nextRotation;
      panRef.current = { x: newPanX, y: newPanY };
      setRotationState(nextRotation);
      setPanState({ x: newPanX, y: newPanY });
      broadcastCameraImmediate();
    },
    [broadcastCameraImmediate]
  );

  const centerCanvas = useCallback(
    (targetZoom: number = zoomRef.current) => {
      const viewport = viewportRef.current;
      let vw = viewport?.clientWidth ?? 0;
      let vh = viewport?.clientHeight ?? 0;

      if (vw <= 0 || vh <= 0) {
        if (typeof window !== 'undefined') {
          vw = Math.max(300, window.innerWidth - 300);
          vh = Math.max(300, window.innerHeight - 80);
        } else {
          return;
        }
      }

      const newCenter = {
        x: Math.round(vw / 2),
        y: Math.round(vh / 2),
      };

      const safeZoom = Number.isFinite(targetZoom) ? targetZoom : 1.0;
      const clampedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, safeZoom));
      panRef.current = newCenter;
      zoomRef.current = clampedZoom;
      setPanState(newCenter);
      setZoomState(clampedZoom);
      broadcastCameraImmediate();
    },
    [broadcastCameraImmediate]
  );

  /**
   * Reset zoom based on layer/canvas dimensions.
   * Validates customDims so passing a React MouseEvent directly from onClick never produces NaN.
   */
  const resetZoomAndCenter = useCallback(
    (customDims?: CanvasDimensions) => {
      const isValidCustom =
        customDims &&
        typeof (customDims as CanvasDimensions).width === 'number' &&
        typeof (customDims as CanvasDimensions).height === 'number' &&
        Number.isFinite((customDims as CanvasDimensions).width) &&
        Number.isFinite((customDims as CanvasDimensions).height);
      const activeDims = isValidCustom ? customDims : dimensionsRef.current;
      const targetZoom = calculateAdaptiveZoom(activeDims, viewportRef.current);
      rotationRef.current = 0.0;
      setRotationState(0.0);
      hasInitializedCenterRef.current = true;
      centerCanvas(targetZoom);
    },
    [centerCanvas]
  );

  const resetRotation = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      rotationRef.current = 0.0;
      setRotationState(0.0);
      broadcastCameraImmediate();
      return;
    }

    const vc = {
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2,
    };

    const currentRotation = rotationRef.current;
    if (Math.abs(currentRotation) < 0.0001) return;

    const dRad = (-currentRotation * Math.PI) / 180;
    const rx = panRef.current.x - vc.x;
    const ry = panRef.current.y - vc.y;
    const newPanX = vc.x + rx * Math.cos(dRad) - ry * Math.sin(dRad);
    const newPanY = vc.y + rx * Math.sin(dRad) + ry * Math.cos(dRad);

    rotationRef.current = 0.0;
    panRef.current = { x: newPanX, y: newPanY };
    setRotationState(0.0);
    setPanState({ x: newPanX, y: newPanY });
    broadcastCameraImmediate();
  }, [broadcastCameraImmediate]);

  /**
   * Non-destructive horizontal view reflection across the viewport vertical midline (CSP-style).
   * Does not modify any layer pixel buffers.
   */
  const toggleFlipHorizontal = useCallback(() => {
    const viewport = viewportRef.current;
    const vw = viewport?.clientWidth ?? 0;
    if (vw > 0) {
      panRef.current = {
        x: vw - panRef.current.x,
        y: panRef.current.y,
      };
    }
    if (Math.abs(rotationRef.current) > 0.0001) {
      rotationRef.current = -rotationRef.current;
    } else {
      rotationRef.current = 0;
    }
    flipXRef.current = !flipXRef.current;
    broadcastCameraImmediate();
    commitNavStateImmediate();
  }, [broadcastCameraImmediate, commitNavStateImmediate]);

  /**
   * Non-destructive vertical view reflection across the viewport horizontal midline (CSP-style).
   * Does not modify any layer pixel buffers.
   */
  const toggleFlipVertical = useCallback(() => {
    const viewport = viewportRef.current;
    const vh = viewport?.clientHeight ?? 0;
    if (vh > 0) {
      panRef.current = {
        x: panRef.current.x,
        y: vh - panRef.current.y,
      };
    }
    if (Math.abs(rotationRef.current) > 0.0001) {
      rotationRef.current = -rotationRef.current;
    } else {
      rotationRef.current = 0;
    }
    flipYRef.current = !flipYRef.current;
    broadcastCameraImmediate();
    commitNavStateImmediate();
  }, [broadcastCameraImmediate, commitNavStateImmediate]);

  /**
   * Clears both horizontal and vertical non-destructive view reflections.
   */
  const resetViewFlip = useCallback(() => {
    const wasFlipX = flipXRef.current;
    const wasFlipY = flipYRef.current;
    if (!wasFlipX && !wasFlipY) return;

    const viewport = viewportRef.current;
    const vw = viewport?.clientWidth ?? 0;
    const vh = viewport?.clientHeight ?? 0;

    let nextPanX = panRef.current.x;
    let nextPanY = panRef.current.y;
    let nextRot = rotationRef.current;

    if (wasFlipX) {
      if (vw > 0) nextPanX = vw - nextPanX;
      nextRot = -nextRot;
    }
    if (wasFlipY) {
      if (vh > 0) nextPanY = vh - nextPanY;
      nextRot = -nextRot;
    }

    panRef.current = { x: nextPanX, y: nextPanY };
    rotationRef.current = Math.abs(nextRot) > 0.0001 ? nextRot : 0;
    flipXRef.current = false;
    flipYRef.current = false;
    broadcastCameraImmediate();
    commitNavStateImmediate();
  }, [broadcastCameraImmediate, commitNavStateImmediate]);

  const zoomToViewportCenter = useCallback(
    (targetZoom: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;

      const currentZoom = zoomRef.current;
      const clampedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetZoom));
      if (Math.abs(clampedZoom - currentZoom) < 0.0001) return;

      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      const centerX = vw / 2;
      const centerY = vh / 2;

      const ratio = clampedZoom / currentZoom;
      const newPanX = centerX - (centerX - panRef.current.x) * ratio;
      const newPanY = centerY - (centerY - panRef.current.y) * ratio;

      zoomRef.current = clampedZoom;
      panRef.current = { x: newPanX, y: newPanY };

      setZoomState(clampedZoom);
      setPanState({ x: newPanX, y: newPanY });
      broadcastCameraImmediate();
    },
    [broadcastCameraImmediate]
  );

  /** Zero-React-rerender live zoom around viewport center (for Navigator slider scrubbing). */
  const setZoomLive = useCallback(
    (targetZoom: number, commit = false) => {
      if (!Number.isFinite(targetZoom)) return;
      const currentZoom = zoomRef.current;
      const clampedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetZoom));
      const viewport = viewportRef.current;
      if (viewport && viewport.clientWidth > 0 && viewport.clientHeight > 0 && Math.abs(clampedZoom - currentZoom) >= 0.00001) {
        const centerX = viewport.clientWidth / 2;
        const centerY = viewport.clientHeight / 2;
        const ratio = clampedZoom / currentZoom;
        panRef.current = {
          x: centerX - (centerX - panRef.current.x) * ratio,
          y: centerY - (centerY - panRef.current.y) * ratio,
        };
      }
      zoomRef.current = clampedZoom;
      if (commit) {
        broadcastCameraImmediate();
        commitNavStateImmediate();
      } else {
        scheduleCameraBroadcast();
      }
    },
    [broadcastCameraImmediate, commitNavStateImmediate, scheduleCameraBroadcast]
  );

  const zoomIn = useCallback(() => {
    const current = zoomRef.current;
    let target = ZOOM_PRESETS.find((p) => p > current * 1.01);
    if (!target) target = MAX_ZOOM;
    zoomToViewportCenter(target);
  }, [zoomToViewportCenter]);

  const zoomOut = useCallback(() => {
    const current = zoomRef.current;
    let target: number | undefined;
    for (let i = ZOOM_PRESETS.length - 1; i >= 0; i--) {
      if (ZOOM_PRESETS[i] < current * 0.99) {
        target = ZOOM_PRESETS[i];
        break;
      }
    }
    if (!target) target = MIN_ZOOM;
    zoomToViewportCenter(target);
  }, [zoomToViewportCenter]);

  const startPan = useCallback((e: React.PointerEvent | PointerEvent) => {
    e.preventDefault();
    isPanningRef.current = true;
    setIsPanning(true);

    panStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
    };
  }, []);

  const startRotate = useCallback((e: React.PointerEvent | PointerEvent) => {
    e.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;

    const rect = viewport.getBoundingClientRect();
    const vc = {
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2,
    };

    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    rotateStartRef.current = {
      lastX: px,
      lastY: py,
      startCanvasRotation: rotationRef.current,
      totalAngleDelta: 0,
      targetRotation: rotationRef.current,
      startPan: { ...panRef.current },
      center: vc,
    };

    isRotatingRef.current = true;
    setIsRotating(true);
  }, []);

  const startZoomDrag = useCallback((e: React.PointerEvent | PointerEvent) => {
    e.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    zoomDragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      anchorX: e.clientX - rect.left,
      anchorY: e.clientY - rect.top,
      startZoom: zoomRef.current,
      startPan: { ...panRef.current },
    };
    isZoomDraggingRef.current = true;
    setIsZoomDragging(true);
  }, []);

  useEffect(() => {
    hasInitializedCenterRef.current = false;
  }, [activeDocumentId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let prevWidth = viewport.clientWidth;
    let prevHeight = viewport.clientHeight;

    if (!hasInitializedCenterRef.current && prevWidth > 0 && prevHeight > 0) {
      const initialZoom = calculateAdaptiveZoom(dimensionsRef.current, viewport);
      centerCanvas(initialZoom);
      hasInitializedCenterRef.current = true;
    }

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width <= 0 || height <= 0) continue;

        if (!hasInitializedCenterRef.current) {
          const initialZoom = calculateAdaptiveZoom(dimensionsRef.current, viewport);
          centerCanvas(initialZoom);
          hasInitializedCenterRef.current = true;
        } else {
          const dx = (width - prevWidth) / 2;
          const dy = (height - prevHeight) / 2;
          if (dx !== 0 || dy !== 0) {
            panRef.current = { x: panRef.current.x + dx, y: panRef.current.y + dy };
            scheduleCameraBroadcast();
            scheduleNavStateCommit();
          }
        }

        prevWidth = width;
        prevHeight = height;
      }
    });

    ro.observe(viewport);
    return () => ro.disconnect();
  }, [centerCanvas, scheduleCameraBroadcast, scheduleNavStateCommit, activeDocumentId]);

  // Mouse wheel zoom centered on cursor position (live camera via rAF broadcast; React state debounced after wheel/inertia)
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      const viewportRect = viewport.getBoundingClientRect();
      const mouseX = e.clientX - viewportRect.left;
      const mouseY = e.clientY - viewportRect.top;

      let delta = e.deltaY;
      if (e.deltaMode === 1) {
        delta *= 28;
      } else if (e.deltaMode === 2) {
        delta *= 500;
      }

      const wheelAction = useUiStore.getState().appSettings.modifierKeys.mouseWheel;

      if (wheelAction === 'brush-size' && !e.ctrlKey && !e.metaKey) {
        const dir: -1 | 1 = delta < 0 ? 1 : -1;
        const toolState = useToolStore.getState();
        if (toolState.tool === 'liquify') {
          const nextSize = Math.max(
            4,
            Math.min(500, Math.round(stepBrushSizePreset(toolState.liquifySettings.size, dir)))
          );
          toolStoreActions.updateLiquifySettings({ size: nextSize });
        } else {
          const nextSize = stepBrushSizePreset(toolState.brushSettings.size, dir);
          toolStoreActions.updateBrushSettings({ size: nextSize });
        }
        return;
      }

      if ((wheelAction === 'scroll' || isWebtoonModeRef.current) && !e.ctrlKey && !e.metaKey) {
        let deltaX = e.deltaX;
        if (e.deltaMode === 1) deltaX *= 28;
        else if (e.deltaMode === 2) deltaX *= 500;
        const scrollX = e.shiftKey ? delta : deltaX;
        const scrollY = e.shiftKey ? 0 : delta;
        panRef.current = {
          x: isWebtoonModeRef.current ? panRef.current.x : panRef.current.x - scrollX,
          y: panRef.current.y - scrollY,
        };
        scheduleCameraBroadcast();
        scheduleNavStateCommit();
        return;
      }

      const zoomFactor = Math.exp(-delta * 0.0018);
      const currentZoom = zoomRef.current;
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom * zoomFactor));

      if (Math.abs(nextZoom - currentZoom) > 0.00001) {
        const ratio = nextZoom / currentZoom;
        const nextPanX = mouseX - (mouseX - panRef.current.x) * ratio;
        const nextPanY = mouseY - (mouseY - panRef.current.y) * ratio;

        zoomRef.current = nextZoom;
        panRef.current = { x: nextPanX, y: nextPanY };
        scheduleCameraBroadcast();
        scheduleNavStateCommit();
      }
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      viewport.removeEventListener('wheel', handleWheel);
    };
  }, [activeDocumentId, scheduleCameraBroadcast, scheduleNavStateCommit]);

  // Modifier state tracking (Space, Shift, Ctrl, Alt) for navigation & modifier-key drag modes
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const targetEl = e.target as HTMLElement | null;
      if (
        targetEl &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(targetEl.tagName) || targetEl.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"]') || useUiStore.getState().isSettingsModalOpen) {
        return;
      }

      if (e.key === 'Shift' && !isShiftDownRef.current) {
        isShiftDownRef.current = true;
        setIsShiftDown(true);
      }
      if ((e.key === 'Control' || e.key === 'Meta') && !isCtrlDownRef.current) {
        isCtrlDownRef.current = true;
        setIsCtrlDown(true);
      }
      if (e.key === 'Alt' && !isAltDownRef.current) {
        isAltDownRef.current = true;
        setIsAltDown(true);
      }

      // Space key for Pan / Rotate / Scrubby Zoom (skip Alt+Space so Animation playback can use it)
      if ((e.code === 'Space' || e.key === ' ') && !e.altKey) {
        e.preventDefault();
        if (!isSpaceDownRef.current) {
          isSpaceDownRef.current = true;
          setIsSpaceDown(true);
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        isShiftDownRef.current = false;
        setIsShiftDown(false);
      }
      if (e.key === 'Control' || e.key === 'Meta') {
        isCtrlDownRef.current = false;
        setIsCtrlDown(false);
      }
      if (e.key === 'Alt') {
        isAltDownRef.current = false;
        setIsAltDown(false);
      }
      if (e.code === 'Space' || e.key === ' ') {
        isSpaceDownRef.current = false;
        setIsSpaceDown(false);
      }
    };

    const handleBlur = () => {
      const wasInteracting =
        isPanningRef.current || isRotatingRef.current || isZoomDraggingRef.current;
      isSpaceDownRef.current = false;
      setIsSpaceDown(false);
      isShiftDownRef.current = false;
      setIsShiftDown(false);
      isCtrlDownRef.current = false;
      setIsCtrlDown(false);
      isAltDownRef.current = false;
      setIsAltDown(false);
      isPanningRef.current = false;
      setIsPanning(false);
      isRotatingRef.current = false;
      setIsRotating(false);
      isZoomDraggingRef.current = false;
      setIsZoomDragging(false);
      if (wasInteracting) {
        broadcastCameraImmediate();
        commitNavStateImmediate();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [broadcastCameraImmediate, commitNavStateImmediate]);

  // Panning pointermove: broadcasts directly to DOM/WebGL via rAF; commits React state only on pointerup
  useEffect(() => {
    if (!isPanning) return;

    const handleWindowPointerMove = (e: PointerEvent) => {
      if (!isPanningRef.current) return;
      const dx = e.clientX - panStartRef.current.clientX;
      const dy = e.clientY - panStartRef.current.clientY;

      panRef.current = {
        x: isWebtoonModeRef.current ? panStartRef.current.panX : panStartRef.current.panX + dx,
        y: panStartRef.current.panY + dy,
      };
      scheduleCameraBroadcast();
    };

    const handleWindowPointerUp = () => {
      isPanningRef.current = false;
      broadcastCameraImmediate();
      setIsPanning(false);
      commitNavStateImmediate();
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [isPanning, scheduleCameraBroadcast, broadcastCameraImmediate, commitNavStateImmediate]);

  // Rotating pointermove: damped radial delta + frame-rate-independent rAF smoothing across all angles
  useEffect(() => {
    if (!isRotating) return;

    let cachedRect: DOMRect | null = viewportRef.current
      ? viewportRef.current.getBoundingClientRect()
      : null;
    let smoothRafId: number | null = null;
    let lastFrameTs = performance.now();

    const applyRotationToCamera = (angleDeg: number) => {
      const { center: vc, startCanvasRotation, startPan } = rotateStartRef.current;
      rotationRef.current = angleDeg;
      const dRad = ((angleDeg - startCanvasRotation) * Math.PI) / 180;
      const cos = Math.cos(dRad);
      const sin = Math.sin(dRad);
      const rx = startPan.x - vc.x;
      const ry = startPan.y - vc.y;
      panRef.current = {
        x: vc.x + rx * cos - ry * sin,
        y: vc.y + rx * sin + ry * cos,
      };
    };

    const stepSmoothRotation = (now: number) => {
      smoothRafId = null;
      if (!isRotatingRef.current) return;

      const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameTs) / 1000));
      lastFrameTs = now;

      const target = rotateStartRef.current.targetRotation;
      const current = rotationRef.current;
      const diff = target - current;

      if (Math.abs(diff) < 0.01) {
        if (current !== target) {
          applyRotationToCamera(target);
          emitCameraToSubscribers();
        }
        return;
      }

      const alpha = 1 - Math.exp(-dt * 28);
      applyRotationToCamera(current + diff * alpha);
      emitCameraToSubscribers();
      smoothRafId = requestAnimationFrame(stepSmoothRotation);
    };

    const ensureSmoothLoop = () => {
      if (smoothRafId === null) {
        lastFrameTs = performance.now();
        smoothRafId = requestAnimationFrame(stepSmoothRotation);
      }
    };

    const handleWindowPointerMove = (e: PointerEvent) => {
      if (!isRotatingRef.current) return;
      const viewport = viewportRef.current;
      if (!viewport) return;

      if (!cachedRect) cachedRect = viewport.getBoundingClientRect();
      const vc = rotateStartRef.current.center;
      const px = e.clientX - cachedRect.left;
      const py = e.clientY - cachedRect.top;

      const diff = computeSmoothRotationDelta(
        rotateStartRef.current.lastX,
        rotateStartRef.current.lastY,
        px,
        py,
        vc.x,
        vc.y
      );

      rotateStartRef.current.lastX = px;
      rotateStartRef.current.lastY = py;
      rotateStartRef.current.totalAngleDelta += diff;

      let nextTarget =
        rotateStartRef.current.startCanvasRotation + rotateStartRef.current.totalAngleDelta;

      if (e.altKey || e.ctrlKey) {
        nextTarget = Math.round(nextTarget / 15) * 15;
      }

      rotateStartRef.current.targetRotation = nextTarget;
      ensureSmoothLoop();
    };

    const handleWindowPointerUp = () => {
      if (smoothRafId !== null) {
        cancelAnimationFrame(smoothRafId);
        smoothRafId = null;
      }
      isRotatingRef.current = false;
      applyRotationToCamera(rotateStartRef.current.targetRotation);
      broadcastCameraImmediate();
      setIsRotating(false);
      commitNavStateImmediate();
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = ROTATE_CURSOR_CSS;
    document.body.style.userSelect = 'none';

    return () => {
      if (smoothRafId !== null) {
        cancelAnimationFrame(smoothRafId);
      }
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [isRotating, emitCameraToSubscribers, broadcastCameraImmediate, commitNavStateImmediate]);

  // Scrubby Zoom pointermove (default Ctrl+Space+Drag): zero-rerender via rAF camera broadcast
  useEffect(() => {
    if (!isZoomDragging) return;

    const handleWindowPointerMove = (e: PointerEvent) => {
      if (!isZoomDraggingRef.current) return;
      const dx = e.clientX - zoomDragStartRef.current.clientX;
      const { anchorX, anchorY, startZoom, startPan } = zoomDragStartRef.current;
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, startZoom * Math.exp(dx * 0.007)));
      const ratio = nextZoom / startZoom;
      zoomRef.current = nextZoom;
      panRef.current = {
        x: anchorX - (anchorX - startPan.x) * ratio,
        y: anchorY - (anchorY - startPan.y) * ratio,
      };
      scheduleCameraBroadcast();
    };

    const handleWindowPointerUp = () => {
      isZoomDraggingRef.current = false;
      broadcastCameraImmediate();
      setIsZoomDragging(false);
      commitNavStateImmediate();
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'zoom-in';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [isZoomDragging, scheduleCameraBroadcast, broadcastCameraImmediate, commitNavStateImmediate]);

  useEffect(() => {
    const handleAuxClick = (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
      }
    };
    window.addEventListener('auxclick', handleAuxClick);
    return () => window.removeEventListener('auxclick', handleAuxClick);
  }, []);

  const navigation = useMemo<CanvasNavigationHandle>(
    () => ({
      zoomRef,
      panRef,
      rotationRef,
      flipXRef,
      flipYRef,
      getCameraState,
      subscribeCamera,
      setPanLive,
      setZoomLive,
      rotateBy,
      commitCameraState: commitNavStateImmediate,
    }),
    [getCameraState, subscribeCamera, setPanLive, setZoomLive, rotateBy, commitNavStateImmediate]
  );

  const activeHeldModifierAction = resolveHeldKeyModifierAction(
    { ctrl: isCtrlDown, shift: isShiftDown, alt: isAltDown, space: isSpaceDown },
    useUiStore.getState().appSettings.modifierKeys
  );
  const isRotateModifier = activeHeldModifierAction === 'rotate';

  return {
    viewportRef,
    navigation,
    zoom,
    pan,
    rotation,
    flipX,
    flipY,
    zoomRef,
    panRef,
    rotationRef,
    flipXRef,
    flipYRef,
    getCameraState,
    subscribeCamera,
    isSpaceDown,
    isShiftDown,
    isCtrlDown,
    isAltDown,
    isRotateModifier,
    isPanning,
    isRotating,
    isZoomDragging,
    startPan,
    startRotate,
    startZoomDrag,
    zoomIn,
    zoomOut,
    zoomToViewportCenter,
    resetZoomAndCenter,
    resetRotation,
    rotateBy,
    toggleFlipHorizontal,
    toggleFlipVertical,
    resetViewFlip,
    setZoom,
    setPan,
    setPanLive,
    setZoomLive,
    commitCameraState: commitNavStateImmediate,
    setRotation,
    centerCanvas,
  };
}
