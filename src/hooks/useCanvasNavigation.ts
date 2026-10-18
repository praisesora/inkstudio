import { useState, useRef, useEffect, useCallback } from 'react';
import { CanvasDimensions } from '../types/editor';

export const MIN_ZOOM = 0.01; // 1% (supports large manga/print canvas vertical adaptation)
export const MAX_ZOOM = 32.0; // 3200%

// Discrete zoom steps used in professional software (Photoshop / Clip Studio Paint)
export const ZOOM_PRESETS = [
  0.01,   // 1%
  0.02,   // 2%
  0.03,   // 3%
  0.05,   // 5%
  0.0625, // 6.25%
  0.0833, // 8.33%
  0.1,    // 10%
  0.125,  // 12.5%
  0.1667, // 16.7%
  0.25,   // 25%
  0.3333, // 33.3%
  0.5,    // 50%
  0.6667, // 66.7%
  0.75,   // 75%
  1.0,    // 100%
  1.25,   // 125%
  1.5,    // 150%
  2.0,    // 200%
  3.0,    // 300%
  4.0,    // 400%
  6.0,    // 600%
  8.0,    // 800%
  12.0,   // 1200%
  16.0,   // 1600%
  24.0,   // 2400%
  32.0,   // 3200%
];

// Dual-tone circular rotation arrows SVG cursor (Clip Studio Paint style)
export const ROTATE_CURSOR_SVG = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M16 5 A11 11 0 0 1 27 16 A11 11 0 0 1 24.5 22.5" stroke="%23ffffff" stroke-width="3.5" stroke-linecap="round"/><path d="M16 5 A11 11 0 0 1 27 16 A11 11 0 0 1 24.5 22.5" stroke="%231a1a1a" stroke-width="2" stroke-linecap="round"/><polygon points="25.5,18 28.5,24 22,24" fill="%231a1a1a" stroke="%23ffffff" stroke-width="1.5"/><path d="M16 27 A11 11 0 0 1 5 16 A11 11 0 0 1 7.5 9.5" stroke="%23ffffff" stroke-width="3.5" stroke-linecap="round"/><path d="M16 27 A11 11 0 0 1 5 16 A11 11 0 0 1 7.5 9.5" stroke="%231a1a1a" stroke-width="2" stroke-linecap="round"/><polygon points="6.5,14 3.5,8 10,8" fill="%231a1a1a" stroke="%23ffffff" stroke-width="1.5"/><circle cx="16" cy="16" r="2" fill="%231a1a1a" stroke="%23ffffff" stroke-width="1.5"/></svg>`;
export const ROTATE_CURSOR_CSS = `url('${ROTATE_CURSOR_SVG}') 16 16, crosshair`;

export function formatZoomPercent(zoom: number): string {
  const percent = zoom * 100;
  if (percent >= 100) {
    return `${Math.round(percent)}%`;
  }
  const rounded = Math.round(percent * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

export const VIEWPORT_FIT_PADDING = 48; // 24px margin on each side for clean artboard visibility

/**
 * Calculates adaptive zoom based on layer/canvas dimensions and viewport size.
 * 100% (1.0) is the default zoom level when canvas fits.
 * If canvas exceeds viewport (e.g. manga canvas), adapts vertically to fit cleanly.
 * 100% is the default zoom level rather than the maximum zoom level (MAX_ZOOM = 32.0).
 */
export function calculateAdaptiveZoom(
  dimensions: CanvasDimensions | undefined,
  viewport: HTMLDivElement | null
): number {
  if (!dimensions || dimensions.height <= 0 || dimensions.width <= 0) {
    return 1.0;
  }

  let vw = viewport?.clientWidth ?? 0;
  let vh = viewport?.clientHeight ?? 0;

  // Fallback to window dimensions if viewport is not yet attached to DOM or measured
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
  // Pan represents the canvas center in viewport coordinates
  const [pan, setPanState] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [rotation, setRotationState] = useState<number>(0.0);

  const dimensionsRef = useRef<CanvasDimensions | undefined>(dimensions);
  dimensionsRef.current = dimensions;

  const [isSpaceDown, setIsSpaceDown] = useState<boolean>(false);
  const [isShiftDown, setIsShiftDown] = useState<boolean>(false);
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [isRotating, setIsRotating] = useState<boolean>(false);

  // Synchronous refs to prevent stale closure drift during high-frequency pointer movement
  const zoomRef = useRef<number>(1.0);
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const rotationRef = useRef<number>(0.0);

  const isSpaceDownRef = useRef<boolean>(false);
  const isShiftDownRef = useRef<boolean>(false);
  const isPanningRef = useRef<boolean>(false);
  const isRotatingRef = useRef<boolean>(false);

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
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
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

  // Center canvas in viewport given target zoom
  const centerCanvas = useCallback((targetZoom: number = zoomRef.current) => {
    const viewport = viewportRef.current;
    let vw = viewport?.clientWidth ?? 0;
    let vh = viewport?.clientHeight ?? 0;

    // Fallback to window bounds if viewport not yet mounted
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

    const clampedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetZoom));
    panRef.current = newCenter;
    setPanState(newCenter);
    zoomRef.current = clampedZoom;
    setZoomState(clampedZoom);
  }, []);

  // Reset zoom based on layer/canvas dimensions (adapts vertically for oversized formats like manga,
  // defaults to 100% when fitting, centered, rotation to 0°)
  const resetZoomAndCenter = useCallback(
    (customDims?: CanvasDimensions) => {
      const activeDims = customDims || dimensionsRef.current;
      const targetZoom = calculateAdaptiveZoom(activeDims, viewportRef.current);
      rotationRef.current = 0.0;
      setRotationState(0.0);
      hasInitializedCenterRef.current = true;
      centerCanvas(targetZoom);
    },
    [centerCanvas]
  );

  // Reset only rotation to 0° around the viewport center (Ctrl + Alt + 0)
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

    // Rotate the canvas center back by -currentRotation around viewport center
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

  // Zoom centered on the viewport center (for shortcuts Ctrl + Plus / Ctrl + Minus and toolbar buttons)
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

      // Adjust pan offset relative to viewport center
      const ratio = clampedZoom / currentZoom;
      const newPanX = centerX - (centerX - panRef.current.x) * ratio;
      const newPanY = centerY - (centerY - panRef.current.y) * ratio;

      zoomRef.current = clampedZoom;
      panRef.current = { x: newPanX, y: newPanY };

      setZoomState(clampedZoom);
      setPanState({ x: newPanX, y: newPanY });
    },
    []
  );

  // Incremental Zoom In to the next standard preset
  const zoomIn = useCallback(() => {
    const current = zoomRef.current;
    let target = ZOOM_PRESETS.find((p) => p > current * 1.01);
    if (!target) target = MAX_ZOOM;
    zoomToViewportCenter(target);
  }, [zoomToViewportCenter]);

  // Incremental Zoom Out to the previous standard preset
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

  // Start panning drag from a pointer event
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

  // Start rotation drag from a pointer event
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

  // Reset centering flag when active document changes
  useEffect(() => {
    hasInitializedCenterRef.current = false;
  }, [activeDocumentId]);

  // Center on mount, document change, and handle window / viewport resize gracefully
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
          // Adjust canvas center by half the size difference to keep canvas centered
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

  // Mouse wheel zoom centered on cursor position (accounts for rotation angle)
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
        delta *= 28; // Lines to pixels
      } else if (e.deltaMode === 2) {
        delta *= 500; // Pages to pixels
      }

      // In Webtoon mode, standard wheel scrolls canvas vertically
      if (isWebtoonMode && !e.ctrlKey && !e.metaKey) {
        const nextPanY = panRef.current.y - delta;
        panRef.current = { x: panRef.current.x, y: nextPanY };
        setPanState({ x: panRef.current.x, y: nextPanY });
        return;
      }

      // Smooth exponential zoom factor
      const zoomFactor = Math.exp(-delta * 0.0018);
      const currentZoom = zoomRef.current;
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom * zoomFactor));

      if (Math.abs(nextZoom - currentZoom) > 0.00001) {
        const ratio = nextZoom / currentZoom;
        const nextPanX = mouseX - (mouseX - panRef.current.x) * ratio;
        const nextPanY = mouseY - (mouseY - panRef.current.y) * ratio;

        zoomRef.current = nextZoom;
        panRef.current = { x: nextPanX, y: nextPanY };

        setZoomState(nextZoom);
        setPanState({ x: nextPanX, y: nextPanY });
      }
    };

    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      viewport.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // Global Keyboard Shortcuts (Space, Shift, Ctrl+0, Ctrl+Alt+0, Ctrl++, Ctrl+-)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore keyboard shortcuts if user is typing in a text field
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      // Shift key detection
      if (e.key === 'Shift') {
        if (!isShiftDownRef.current) {
          isShiftDownRef.current = true;
          setIsShiftDown(true);
        }
      }

      // Space key for Pan Hand Tool or Rotate with Shift+Space
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        if (!isSpaceDownRef.current) {
          isSpaceDownRef.current = true;
          setIsSpaceDown(true);
        }
        return;
      }

      // Ctrl / Cmd shortcuts
      if (e.ctrlKey || e.metaKey) {
        // Ctrl + Alt + 0: Reset rotation only to 0°
        if (e.altKey && (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) {
          e.preventDefault();
          resetRotation();
          return;
        }

        // Ctrl + 0: Reset zoom to 100%, rotation to 0°, and re-center
        if (!e.altKey && (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) {
          e.preventDefault();
          resetZoomAndCenter();
          return;
        }

        // Ctrl + Plus / Ctrl + = : Incremental zoom in
        if (
          e.key === '+' ||
          e.key === '=' ||
          e.code === 'Equal' ||
          e.code === 'NumpadAdd'
        ) {
          e.preventDefault();
          zoomIn();
          return;
        }

        // Ctrl + Minus / Ctrl + _ : Incremental zoom out
        if (
          e.key === '-' ||
          e.key === '_' ||
          e.code === 'Minus' ||
          e.code === 'NumpadSubtract'
        ) {
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

  // Window pointermove and pointerup listeners while panning is active
  useEffect(() => {
    if (!isPanning) return;

    const handleWindowPointerMove = (e: PointerEvent) => {
      if (!isPanningRef.current) return;
      const dx = e.clientX - panStartRef.current.clientX;
      const dy = e.clientY - panStartRef.current.clientY;

      const newPan = {
        x: isWebtoonMode ? panStartRef.current.panX : panStartRef.current.panX + dx,
        y: panStartRef.current.panY + dy,
      };

      panRef.current = newPan;
      setPanState(newPan);
    };

    const handleWindowPointerUp = () => {
      isPanningRef.current = false;
      setIsPanning(false);
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
  }, [isPanning]);

  // Window pointermove and pointerup listeners while rotating is active
  useEffect(() => {
    if (!isRotating) return;

    const handleWindowPointerMove = (e: PointerEvent) => {
      if (!isRotatingRef.current) return;
      const viewport = viewportRef.current;
      if (!viewport) return;

      const rect = viewport.getBoundingClientRect();
      const vc = rotateStartRef.current.center;
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      const curAngle = Math.atan2(py - vc.y, px - vc.x) * (180 / Math.PI);
      let diff = curAngle - rotateStartRef.current.lastPointerAngle;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;

      rotateStartRef.current.lastPointerAngle = curAngle;
      rotateStartRef.current.totalAngleDelta += diff;

      let newRotation =
        rotateStartRef.current.startCanvasRotation + rotateStartRef.current.totalAngleDelta;

      // Snapping to 15-degree increments when Alt or Ctrl is held:
      if (e.altKey || e.ctrlKey) {
        newRotation = Math.round(newRotation / 15) * 15;
      } else {
        // Magnetic snap near cardinal angles (0°, 90°, 180°, -90°, etc.) within ±2.5°
        const nearestCardinal = Math.round(newRotation / 90) * 90;
        if (Math.abs(newRotation - nearestCardinal) <= 2.5) {
          newRotation = nearestCardinal;
        }
      }

      rotationRef.current = newRotation;
      setRotationState(newRotation);

      // Rotate canvas center around the viewport center so the focal point stays in place
      const dRad = ((newRotation - rotateStartRef.current.startCanvasRotation) * Math.PI) / 180;
      const rx = rotateStartRef.current.startPan.x - vc.x;
      const ry = rotateStartRef.current.startPan.y - vc.y;
      const newPanX = vc.x + rx * Math.cos(dRad) - ry * Math.sin(dRad);
      const newPanY = vc.y + rx * Math.sin(dRad) + ry * Math.cos(dRad);

      panRef.current = { x: newPanX, y: newPanY };
      setPanState({ x: newPanX, y: newPanY });
    };

    const handleWindowPointerUp = () => {
      isRotatingRef.current = false;
      setIsRotating(false);
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
  }, [isRotating]);

  // Prevent browser auto-scroll on middle click
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
