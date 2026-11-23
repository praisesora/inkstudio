import React, { useEffect, useRef, useState } from 'react';
import { BrushSettings, LiquifySettings, RetouchSettings, ToolType } from '../../types/editor';
import { ModifierAction } from '../../types/settings';
import { getBrushTipOutline, resolveBrushTipImage, TipOutline } from '../../utils/brushOutline';
import { preloadTipImage } from '../../utils/brushStorage';
import { subscribeNativeTablet } from '../../utils/nativeTabletInput';
import { CursorConfig, formatCursorRingTransform } from './types';

export interface UseCanvasEffectsParams {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  brushSettings: BrushSettings;
  onUpdateBrushSettings: (newSettings: Partial<BrushSettings>) => void;
  liquifySettings?: LiquifySettings;
  onUpdateLiquifySettings?: (newSettings: Partial<LiquifySettings>) => void;
  retouchSettings?: RetouchSettings;
  onUpdateRetouchSettings?: (newSettings: Partial<RetouchSettings>) => void;
  tool: ToolType;
  liveZoom: number;
  liveRotation: number;
  liveFlipX: boolean;
  liveFlipY: boolean;
  isSpaceDown: boolean;
  isPanning: boolean;
  isRotating: boolean;
  isZoomDragging: boolean;
  isRotateModifier: boolean;
  hasOpenDocument: boolean;
  showCursorCoordinates: boolean;
  showPressureInStatusBar: boolean;
  heldModifierAction: ModifierAction;
  isResizingBrush: boolean;
  setIsResizingBrush: React.Dispatch<React.SetStateAction<boolean>>;
  quickPalettePos: { x: number; y: number } | null;
  setQuickPalettePos: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  resizeOriginRef: React.MutableRefObject<{ clientX: number; clientY: number }>;
  resizeStartSettingsRef: React.MutableRefObject<{ size: number; hardness: number }>;
}

export function useCanvasEffects({
  viewportRef,
  brushSettings,
  onUpdateBrushSettings,
  liquifySettings,
  onUpdateLiquifySettings,
  retouchSettings,
  onUpdateRetouchSettings,
  tool,
  liveZoom,
  liveRotation,
  liveFlipX,
  liveFlipY,
  isSpaceDown,
  isPanning,
  isRotating,
  isZoomDragging,
  isRotateModifier,
  hasOpenDocument,
  showCursorCoordinates,
  showPressureInStatusBar,
  heldModifierAction,
  isResizingBrush,
  setIsResizingBrush,
  quickPalettePos,
  setQuickPalettePos,
  resizeOriginRef,
  resizeStartSettingsRef,
}: UseCanvasEffectsParams) {
  // Resolve tip image and extract vector outline silhouette
  const activeTipImage = resolveBrushTipImage(brushSettings);
  const [tipOutline, setTipOutline] = useState<TipOutline | null>(() => {
    return activeTipImage ? getBrushTipOutline(activeTipImage) : null;
  });

  useEffect(() => {
    let isCancelled = false;

    if (activeTipImage) {
      if (activeTipImage.complete && activeTipImage.naturalWidth > 0) {
        setTipOutline(getBrushTipOutline(activeTipImage));
      } else {
        const handleLoad = () => {
          if (!isCancelled) {
            setTipOutline(getBrushTipOutline(activeTipImage));
          }
        };
        activeTipImage.addEventListener('load', handleLoad, { once: true });
      }
      return () => {
        isCancelled = true;
      };
    }

    if (brushSettings.customTipDataUrl) {
      preloadTipImage(brushSettings.customTipDataUrl)
        .then((img) => {
          if (!isCancelled) {
            setTipOutline(getBrushTipOutline(img));
          }
        })
        .catch(() => {
          if (!isCancelled) {
            setTipOutline(null);
          }
        });
      return () => {
        isCancelled = true;
      };
    }

    setTipOutline(null);
  }, [activeTipImage, brushSettings.customTipDataUrl, brushSettings.preset]);

  const isCustomTip = Boolean(tipOutline && (tool === 'brush' || tool === 'eraser'));
  const isSquare = brushSettings.preset === 'square-digital' && !tipOutline;
  const tipAspect = isCustomTip && tipOutline ? tipOutline.height / tipOutline.width : 1.0;

  const activeToolSize =
    tool === 'liquify' && liquifySettings
      ? liquifySettings.size
      : tool === 'retouch' && retouchSettings
        ? retouchSettings.size
        : brushSettings.size;
  const cursorBaseWidth = Math.max(4, activeToolSize * liveZoom);
  const thicknessRatio = tool === 'brush' ? (brushSettings.thickness ?? 1.0) : 1.0;
  const thicknessVertical = Boolean(brushSettings.thicknessVertical && tool === 'brush');
  const tipAngleDeg = tool === 'brush' ? (brushSettings.customTipAngle ?? 0) : 0;
  const followDirection =
    tool === 'brush' &&
    (brushSettings.customTipAngleDynamics === 'direction' ||
      brushSettings.customTipAngleDynamics === 'direction-random');

  const cursorWidth = thicknessVertical
    ? Math.max(2, cursorBaseWidth * thicknessRatio)
    : cursorBaseWidth;
  const cursorHeight = thicknessVertical
    ? Math.max(2, cursorBaseWidth * tipAspect)
    : Math.max(2, cursorBaseWidth * tipAspect * thicknessRatio);

  // Brush tip rotation: tip angle relative to canvas + viewport canvas rotation
  const totalAngleDeg = tipAngleDeg + liveRotation;
  const dynamicDirDegRef = useRef<number>(0);
  const lastDirAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const cursorConfigRef = useRef<CursorConfig>({
    activeToolSize,
    tipAspect,
    thicknessRatio,
    thicknessVertical,
    tipAngleDeg,
    followDirection,
    dynamicDirDeg: 0,
    rotation: liveRotation,
    flipX: liveFlipX,
    flipY: liveFlipY,
  });
  cursorConfigRef.current = {
    activeToolSize,
    tipAspect,
    thicknessRatio,
    thicknessVertical,
    tipAngleDeg,
    followDirection,
    dynamicDirDeg: dynamicDirDegRef.current,
    rotation: liveRotation,
    flipX: liveFlipX,
    flipY: liveFlipY,
  };
  const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null);

  // Zero-latency direct DOM cursor preview element & pointer stat readout
  const cursorRingRef = useRef<HTMLDivElement | null>(null);
  const pointerStatRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showCursorCoordinates && !showPressureInStatusBar) return;
    let rafId = 0;
    const handlePointerStat = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const el = pointerStatRef.current;
        if (!el || !detail) return;
        const parts: string[] = [];
        if (showCursorCoordinates && detail.x !== null && detail.x !== undefined) {
          parts.push(`${detail.x}, ${detail.y}`);
        }
        if (showPressureInStatusBar && detail.pressure > 0) {
          parts.push(`${Math.round(detail.pressure * 100)}%`);
        }
        el.textContent = parts.join('  ·  ');
      });
    };
    window.addEventListener('canvas-pointer-stat', handlePointerStat);
    return () => {
      window.removeEventListener('canvas-pointer-stat', handlePointerStat);
      cancelAnimationFrame(rafId);
    };
  }, [showCursorCoordinates, showPressureInStatusBar]);

  // Update cursor rotation/flip in-place when viewport rotates/flips or brush tip angle changes while hovering
  useEffect(() => {
    const ring = cursorRingRef.current;
    const pos = lastPointerPosRef.current;
    if (ring && pos && ring.style.display !== 'none') {
      const cfg = cursorConfigRef.current;
      ring.style.transform = formatCursorRingTransform(
        pos.x,
        pos.y,
        cfg.rotation,
        cfg.flipX,
        cfg.flipY,
        cfg.tipAngleDeg + (cfg.followDirection ? cfg.dynamicDirDeg ?? 0 : 0)
      );
    }
  }, [tipAngleDeg, liveRotation, liveFlipX, liveFlipY]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const shouldHideCursorRing =
      isSpaceDown ||
      isPanning ||
      isRotating ||
      isZoomDragging ||
      isRotateModifier ||
      isResizingBrush ||
      heldModifierAction === 'brush-size' ||
      heldModifierAction === 'pan' ||
      heldModifierAction === 'rotate' ||
      heldModifierAction === 'zoom-drag' ||
      (tool !== 'brush' &&
        tool !== 'eraser' &&
        tool !== 'liquify' &&
        tool !== 'retouch' &&
        tool !== 'select-pen' &&
        tool !== 'select-eraser');

    let cachedRect: DOMRect | null = viewport.getBoundingClientRect();
    const updateRect = () => {
      if (viewport) cachedRect = viewport.getBoundingClientRect();
    };

    const showRingAtLocalPos = (x: number, y: number) => {
      const ring = cursorRingRef.current;
      if (!ring) return;
      const cfg = cursorConfigRef.current;
      let effectiveTipAngle = cfg.tipAngleDeg;
      if (cfg.followDirection) {
        const anchor = lastDirAnchorRef.current;
        if (anchor) {
          const sdx = x - anchor.x;
          const sdy = y - anchor.y;
          if (sdx * sdx + sdy * sdy >= 16) {
            const rad = (-cfg.rotation * Math.PI) / 180;
            const c = Math.cos(rad);
            const s = Math.sin(rad);
            const cdx = (sdx * c - sdy * s) * (cfg.flipX ? -1 : 1);
            const cdy = (sdx * s + sdy * c) * (cfg.flipY ? -1 : 1);
            const targetDeg = (Math.atan2(cdy, cdx) * 180) / Math.PI;
            let delta = targetDeg - dynamicDirDegRef.current;
            while (delta > 180) delta -= 360;
            while (delta < -180) delta += 360;
            dynamicDirDegRef.current += delta * 0.45;
            cfg.dynamicDirDeg = dynamicDirDegRef.current;
            lastDirAnchorRef.current = { x, y };
          }
        } else {
          lastDirAnchorRef.current = { x, y };
        }
        effectiveTipAngle = cfg.tipAngleDeg + dynamicDirDegRef.current;
      }
      ring.style.transform = formatCursorRingTransform(
        x,
        y,
        cfg.rotation,
        cfg.flipX,
        cfg.flipY,
        effectiveTipAngle
      );
      if (ring.style.display !== 'block') {
        ring.style.display = 'block';
      }
    };

    // Immediately sync brush cursor ring visibility when Space/panning/tool state changes
    if (cursorRingRef.current) {
      if (shouldHideCursorRing) {
        cursorRingRef.current.style.display = 'none';
      } else if (lastPointerPosRef.current) {
        showRingAtLocalPos(lastPointerPosRef.current.x, lastPointerPosRef.current.y);
      }
    }

    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateRect) : null;
    ro?.observe(viewport);

    const updateCursorRingCoords = (clientX: number, clientY: number, forceRefreshRect: boolean = false) => {
      const ring = cursorRingRef.current;
      if (!ring) return;

      if (forceRefreshRect || !cachedRect) updateRect();
      if (!cachedRect) return;

      const x = clientX - cachedRect.left;
      const y = clientY - cachedRect.top;

      if (x < 0 || x > cachedRect.width || y < 0 || y > cachedRect.height) {
        lastPointerPosRef.current = null;
        ring.style.display = 'none';
        return;
      }

      lastPointerPosRef.current = { x, y };

      if (shouldHideCursorRing) {
        ring.style.display = 'none';
        return;
      }

      showRingAtLocalPos(x, y);
    };

    const handleWindowPointerMove = (e: PointerEvent) => {
      updateCursorRingCoords(e.clientX, e.clientY, false);
    };

    const handleViewportPointerEnterOrDown = (e: PointerEvent) => {
      updateCursorRingCoords(e.clientX, e.clientY, true);
    };

    const handlePointerLeave = () => {
      lastPointerPosRef.current = null;
      if (cursorRingRef.current) {
        cursorRingRef.current.style.display = 'none';
      }
    };

    viewport.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    viewport.addEventListener('pointerdown', handleViewportPointerEnterOrDown, { passive: true });
    viewport.addEventListener('pointerenter', handleViewportPointerEnterOrDown, { passive: true });
    viewport.addEventListener('pointerleave', handlePointerLeave, { passive: true });

    // Keep brush ring in sync with native WinTab / Windows Ink packets (XP-Pen / Wacom)
    const unsubscribeNativeTablet = subscribeNativeTablet((batch) => {
      if (batch.length === 0) return;
      const last = batch[batch.length - 1];
      if (last.phase === 4) {
        handlePointerLeave();
        return;
      }
      updateCursorRingCoords(last.clientX, last.clientY, false);
    });

    return () => {
      unsubscribeNativeTablet();
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
      ro?.disconnect();
      viewport.removeEventListener('pointermove', handleWindowPointerMove);
      viewport.removeEventListener('pointerdown', handleViewportPointerEnterOrDown);
      viewport.removeEventListener('pointerenter', handleViewportPointerEnterOrDown);
      viewport.removeEventListener('pointerleave', handlePointerLeave);
    };
  }, [isSpaceDown, isPanning, isRotating, isZoomDragging, isRotateModifier, isResizingBrush, heldModifierAction, viewportRef, tool, hasOpenDocument]);

  // Dismiss quick palette on Escape and reset transient UI state on window blur / tab hide
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && quickPalettePos) {
        setQuickPalettePos(null);
      }
    };

    const handleBlur = () => {
      setIsResizingBrush(false);
      setQuickPalettePos(null);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        handleBlur();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [quickPalettePos, setIsResizingBrush, setQuickPalettePos]);

  // Handle active brush resizing window drag listeners
  useEffect(() => {
    if (!isResizingBrush) return;

    let rafId: number | null = null;
    let pendingSize = resizeStartSettingsRef.current.size;
    let pendingHardness = resizeStartSettingsRef.current.hardness;

    const commitResize = () => {
      rafId = null;
      if (tool === 'liquify' && onUpdateLiquifySettings) {
        onUpdateLiquifySettings({ size: Math.round(pendingSize) });
      } else if (tool === 'retouch' && onUpdateRetouchSettings) {
        onUpdateRetouchSettings({
          size: Math.max(2, Math.min(300, Math.round(pendingSize))),
          hardness: Math.round(pendingHardness * 100),
        });
      } else {
        onUpdateBrushSettings({ size: pendingSize, hardness: pendingHardness });
      }
    };

    const finishResize = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        commitResize();
      }
      setIsResizingBrush(false);
    };

    const handleWindowPointerMove = (e: PointerEvent) => {
      if (typeof e.buttons === 'number' && e.buttons === 0) {
        finishResize();
        return;
      }
      const dx = e.clientX - resizeOriginRef.current.clientX;
      const dy = resizeOriginRef.current.clientY - e.clientY;

      // Exponential + linear hybrid sensitivity for 0.5px..1000px precision (CSP-style)
      const baseSize = Math.max(0.5, resizeStartSettingsRef.current.size);
      const rawSize = baseSize * Math.exp(dx * 0.006) + dx * 0.15;
      const clampedSize = Math.max(0.5, Math.min(1000, rawSize));
      pendingSize = clampedSize < 10 ? Math.round(clampedSize * 10) / 10 : Math.round(clampedSize);

      pendingHardness = Math.max(
        0.05,
        Math.min(
          1.0,
          Math.round((resizeStartSettingsRef.current.hardness + dy * 0.004) * 100) / 100
        )
      );

      if (rafId === null) {
        rafId = requestAnimationFrame(commitResize);
      }
    };

    const handleWindowMouseUp = (e: MouseEvent) => {
      if (typeof e.buttons !== 'number' || e.buttons === 0) {
        finishResize();
      }
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    window.addEventListener('pointerup', finishResize, true);
    window.addEventListener('pointercancel', finishResize, true);
    window.addEventListener('mouseup', handleWindowMouseUp, true);

    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', finishResize, true);
      window.removeEventListener('pointercancel', finishResize, true);
      window.removeEventListener('mouseup', handleWindowMouseUp, true);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingBrush, onUpdateBrushSettings, onUpdateLiquifySettings, onUpdateRetouchSettings, tool, setIsResizingBrush]);

  return {
    tipOutline,
    isCustomTip,
    isSquare,
    cursorWidth,
    cursorHeight,
    totalAngleDeg,
    cursorConfigRef,
    lastPointerPosRef,
    cursorRingRef,
    pointerStatRef,
  };
}
