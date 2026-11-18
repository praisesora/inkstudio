import { useState, useRef, useEffect, useCallback } from 'react';
import { CanvasDimensions } from '../types/editor';

export const MIN_ZOOM = 0.01; // 1%
export const MAX_ZOOM = 32.0; // 3200%

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

  const dimensionsRef = useRef<CanvasDimensions | undefined>(dimensions);
  dimensionsRef.current = dimensions;

  const isWebtoonModeRef = useRef<boolean>(isWebtoonMode);
  isWebtoonModeRef.current = isWebtoonMode;

  const [isSpaceDown, setIsSpaceDown] = useState<boolean>(false);
  const [isShiftDown, setIsShiftDown] = useState<boolean>(false);
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [isRotating, setIsRotating] = useState<boolean>(false);

  // Synchronous refs for sub-frame precision
  const zoomRef = useRef<number>(1.0);
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const rotationRef = useRef<number>(0.0);

  const isSpaceDownRef = useRef<boolean>(false);
  const isShiftDownRef = useRef<boolean>(false);
  const isPanningRef = useRef<boolean>(false);
  const isRotatingRef = useRef<boolean>(false);

  // Coalesce high-frequency (240Hz) wheel/pan/rotate updates into 1 React render per animation frame
  const navCommitRafRef = useRef<number | null>(null);
  const scheduleNavStateCommit = useCallback(() => {
    if (navCommitRafRef.current !== null) return;
    navCommitRafRef.current = requestAnimationFrame(() => {
      navCommitRafRef.current = null;
      setZoomState(zoomRef.current);
      setPanState({ x: panRef.current.x, y: panRef.current.y });
      setRotationState(rotationRef.current);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (navCommitRafRef.current !== null) {
        cancelAnimationFrame(navCommitRafRef.current);
        navCommitRafRef.current = null;
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
    initialPointerAngle: number;
    lastPointerAngle: number;
    startCanvasRotation: number;
    totalAngleDelta: number;
    startPan: { x: number; y: number };
    center: { x: number; y: number };
  }>({
    initialPointerAngle: 0,
    lastPointerAngle: 0,
    startCanvasRotation: 0,
    totalAngleDelta: 0,
    startPan: { x: 0, y: 0 },
    center: { x: 0, y: 0 },
  });

  const hasInitializedCenterRef = useRef<boolean>(false);

  const setZoom = useCallback((newZoomOrFn: number | ((prev: number) => number)) => {
    setZoomState((prev) => {
      const next = typeof newZoomOrFn === 'function' ? newZoomOrFn(prev) : newZoomOrFn;
      const safe = Number.isFinite(next) ? next : 1.0;
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, safe));
      zoomRef.current = clamped;
      return clamped;
    });
  }, []);

  const setPan = useCallback(
    (newPanOrFn: { x: number; y: number } | ((prev: { x: number; y: number }) => { x: number; y: number })) => {
      setPanState((prev) => {
        const next = typeof newPanOrFn === 'function' ? newPanOrFn(prev) : newPanOrFn;
        panRef.current = next;
        return next;
      });
    },
    []
  );

  const setRotation = useCallback((newRotationOrFn: number | ((prev: number) => number)) => {
    setRotationState((prev) => {
      const next = typeof newRotationOrFn === 'function' ? newRotationOrFn(prev) : newRotationOrFn;
      rotationRef.current = next;
      return next;
    });
  }, []);

  const centerCanvas = useCallback((targetZoom: number = zoomRef.current) => {
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
    setPanState(newCenter);
    zoomRef.current = clampedZoom;
    setZoomState(clampedZoom);
  }, []);

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
    setRotationState(0.0);
    panRef.current = { x: newPanX, y: newPanY };
    setPanState({ x: newPanX, y: newPanY });
  }, []);

  const zoomToViewportCenter = useCallback((targetZoom: number) => {
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
  }, []);

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
    const initialAngle = Math.atan2(py - vc.y, px - vc.x) * (180 / Math.PI);

    rotateStartRef.current = {
      initialPointerAngle: initialAngle,
      lastPointerAngle: initialAngle,
      startCanvasRotation: rotationRef.current,
      totalAngleDelta: 0,
      startPan: { ...panRef.current },
      center: vc,
    };

    isRotatingRef.current = true;
    setIsRotating(true);
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
            setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
          }
        }

        prevWidth = width;
        prevHeight = height;
      }
    });

    ro.observe(viewport);
    return () => ro.disconnect();
  }, [centerCanvas, setPan, activeDocumentId]);

  // Mouse wheel zoom centered on cursor position (coalesced to 1 React render per rAF)
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

      if (isWebtoonModeRef.current && !e.ctrlKey && !e.metaKey) {
        panRef.current = { x: panRef.current.x, y: panRef.current.y - delta };
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
        scheduleNavStateCommit();
      }
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      viewport.removeEventListener('wheel', handleWheel);
    };
  }, [activeDocumentId, scheduleNavStateCommit]);

  // Global Keyboard Shortcuts (Space, Shift, Ctrl+0, Ctrl+Alt+0, Ctrl++, Ctrl+-)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const targetEl = e.target as HTMLElement | null;
      if (
        targetEl &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(targetEl.tagName) || targetEl.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"]')) {
        return;
      }

      if (e.key === 'Shift') {
        if (!isShiftDownRef.current) {
          isShiftDownRef.current = true;
          setIsShiftDown(true);
        }
      }

      // Space key for Pan Hand Tool or Rotate with Shift+Space (skip Alt+Space so Animation playback can use it)
      if ((e.code === 'Space' || e.key === ' ') && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (!isSpaceDownRef.current) {
          isSpaceDownRef.current = true;
          setIsSpaceDown(true);
        }
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.altKey && (e.code === 'Digit0' || e.code === 'Numpad0' || e.key === '0')) {
          e.preventDefault();
          resetRotation();
          return;
        }

        if (!e.altKey && (e.code === 'Digit0' || e.code === 'Numpad0' || e.key === '0')) {
          e.preventDefault();
          resetZoomAndCenter();
          return;
        }

        if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.key === '+' || e.key === '=') {
          e.preventDefault();
          zoomIn();
          return;
        }

        if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.key === '-' || e.key === '_') {
          e.preventDefault();
          zoomOut();
          return;
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        isShiftDownRef.current = false;
        setIsShiftDown(false);
      }
      if (e.code === 'Space' || e.key === ' ') {
        isSpaceDownRef.current = false;
        setIsSpaceDown(false);
      }
    };

    const handleBlur = () => {
      isSpaceDownRef.current = false;
      setIsSpaceDown(false);
      isShiftDownRef.current = false;
      setIsShiftDown(false);
      isPanningRef.current = false;
      setIsPanning(false);
      isRotatingRef.current = false;
      setIsRotating(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [resetRotation, resetZoomAndCenter, zoomIn, zoomOut]);

  // Panning pointermove coalesced to rAF
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
      scheduleNavStateCommit();
    };

    const handleWindowPointerUp = () => {
      isPanningRef.current = false;
      setIsPanning(false);
      setPanState({ x: panRef.current.x, y: panRef.current.y });
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
  }, [isPanning, scheduleNavStateCommit]);

  // Rotating pointermove coalesced to rAF
  useEffect(() => {
    if (!isRotating) return;

    let cachedRect: DOMRect | null = viewportRef.current
      ? viewportRef.current.getBoundingClientRect()
      : null;

    const handleWindowPointerMove = (e: PointerEvent) => {
      if (!isRotatingRef.current) return;
      const viewport = viewportRef.current;
      if (!viewport) return;

      if (!cachedRect) cachedRect = viewport.getBoundingClientRect();
      const vc = rotateStartRef.current.center;
      const px = e.clientX - cachedRect.left;
      const py = e.clientY - cachedRect.top;

      const curAngle = Math.atan2(py - vc.y, px - vc.x) * (180 / Math.PI);
      let diff = curAngle - rotateStartRef.current.lastPointerAngle;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;

      rotateStartRef.current.lastPointerAngle = curAngle;
      rotateStartRef.current.totalAngleDelta += diff;

      let newRotation =
        rotateStartRef.current.startCanvasRotation + rotateStartRef.current.totalAngleDelta;

      if (e.altKey || e.ctrlKey) {
        newRotation = Math.round(newRotation / 15) * 15;
      } else {
        const nearestCardinal = Math.round(newRotation / 90) * 90;
        if (Math.abs(newRotation - nearestCardinal) <= 2.5) {
          newRotation = nearestCardinal;
        }
      }

      rotationRef.current = newRotation;

      const dRad = ((newRotation - rotateStartRef.current.startCanvasRotation) * Math.PI) / 180;
      const rx = rotateStartRef.current.startPan.x - vc.x;
      const ry = rotateStartRef.current.startPan.y - vc.y;
      panRef.current = {
        x: vc.x + rx * Math.cos(dRad) - ry * Math.sin(dRad),
        y: vc.y + rx * Math.sin(dRad) + ry * Math.cos(dRad),
      };
      scheduleNavStateCommit();
    };

    const handleWindowPointerUp = () => {
      isRotatingRef.current = false;
      setIsRotating(false);
      setRotationState(rotationRef.current);
      setPanState({ x: panRef.current.x, y: panRef.current.y });
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'crosshair';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [isRotating, scheduleNavStateCommit]);

  useEffect(() => {
    const handleAuxClick = (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
      }
    };
    window.addEventListener('auxclick', handleAuxClick);
    return () => window.removeEventListener('auxclick', handleAuxClick);
  }, []);

  const isRotateModifier = isSpaceDown && isShiftDown;

  return {
    viewportRef,
    zoom,
    pan,
    rotation,
    isSpaceDown,
    isShiftDown,
    isRotateModifier,
    isPanning,
    isRotating,
    startPan,
    startRotate,
    zoomIn,
    zoomOut,
    resetZoomAndCenter,
    resetRotation,
    setZoom,
    setPan,
    setRotation,
    centerCanvas,
  };
}
