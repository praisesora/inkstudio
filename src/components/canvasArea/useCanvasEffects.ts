import React, { useEffect, useRef, useState } from 'react';
import { BrushSettings, LiquifySettings, ToolType } from '../../types/editor';
import { ModifierAction } from '../../types/settings';
import { getBrushTipOutline, resolveBrushTipImage, TipOutline } from '../../utils/brushOutline';
import { preloadTipImage } from '../../utils/brushStorage';
import { resolveHeldKeyModifierAction } from '../../utils/shortcutManager';
import { useUiStore } from '../../stores';
import { CursorConfig, formatCursorRingTransform } from './types';

export interface UseCanvasEffectsParams {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  brushSettings: BrushSettings;
  onUpdateBrushSettings: (newSettings: Partial<BrushSettings>) => void;
  liquifySettings?: LiquifySettings;
  onUpdateLiquifySettings?: (newSettings: Partial<LiquifySettings>) => void;
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
  setHeldModifierAction: React.Dispatch<React.SetStateAction<ModifierAction>>;
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
  setHeldModifierAction,
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

  const activeToolSize = tool === 'liquify' && liquifySettings ? liquifySettings.size : brushSettings.size;
  const cursorBaseWidth = Math.max(4, activeToolSize * liveZoom);
  const thicknessRatio = tool === 'brush' ? (brushSettings.thickness ?? 1.0) : 1.0;
  const thicknessVertical = Boolean(brushSettings.thicknessVertical && tool === 'brush');
  const tipAngleDeg = tool === 'brush' ? (brushSettings.customTipAngle ?? 0) : 0;

  const cursorWidth = thicknessVertical
    ? Math.max(2, cursorBaseWidth * thicknessRatio)
    : cursorBaseWidth;
  const cursorHeight = thicknessVertical
    ? Math.max(2, cursorBaseWidth * tipAspect)
    : Math.max(2, cursorBaseWidth * tipAspect * thicknessRatio);

  // Brush tip rotation: tip angle relative to canvas + viewport canvas rotation
  const totalAngleDeg = tipAngleDeg + liveRotation;
  const cursorConfigRef = useRef<CursorConfig>({
    activeToolSize,
    tipAspect,
    thicknessRatio,
    thicknessVertical,
    tipAngleDeg,
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
        cfg.tipAngleDeg
      );
    }
  }, [tipAngleDeg, liveRotation, liveFlipX, liveFlipY]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let cachedRect: DOMRect | null = viewport.getBoundingClientRect();
    const updateRect = () => {
      if (viewport) cachedRect = viewport.getBoundingClientRect();
    };

    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateRect) : null;
    ro?.observe(viewport);

    const updateCursorRingPos = (e: PointerEvent, forceRefreshRect: boolean = false) => {
      const ring = cursorRingRef.current;
      if (!ring) return;

      if (
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
        (tool !== 'brush' && tool !== 'eraser' && tool !== 'liquify' && tool !== 'select-pen' && tool !== 'select-eraser')
      ) {
        ring.style.display = 'none';
        return;
      }

      if (forceRefreshRect || !cachedRect) updateRect();
      if (!cachedRect) return;

      const x = e.clientX - cachedRect.left;
      const y = e.clientY - cachedRect.top;

      if (x < 0 || x > cachedRect.width || y < 0 || y > cachedRect.height) {
        ring.style.display = 'none';
        return;
      }

      lastPointerPosRef.current = { x, y };
      const cfg = cursorConfigRef.current;
      ring.style.transform = formatCursorRingTransform(
        x,
        y,
        cfg.rotation,
        cfg.flipX,
        cfg.flipY,
        cfg.tipAngleDeg
      );
      if (ring.style.display !== 'block') {
        ring.style.display = 'block';
      }
    };

    const handleWindowPointerMove = (e: PointerEvent) => {
      updateCursorRingPos(e, false);
    };

    const handleViewportPointerEnterOrDown = (e: PointerEvent) => {
      updateCursorRingPos(e, true);
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

    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
      ro?.disconnect();
      viewport.removeEventListener('pointermove', handleWindowPointerMove);
      viewport.removeEventListener('pointerdown', handleViewportPointerEnterOrDown);
      viewport.removeEventListener('pointerenter', handleViewportPointerEnterOrDown);
      viewport.removeEventListener('pointerleave', handlePointerLeave);
    };
  }, [isSpaceDown, isPanning, isRotating, isZoomDragging, isRotateModifier, isResizingBrush, heldModifierAction, viewportRef, tool, hasOpenDocument]);

  // Track held modifier key combinations globally according to Modifier Key Settings
  useEffect(() => {
    const syncHeldAction = (e: KeyboardEvent, spaceOverride?: boolean) => {
      const action = resolveHeldKeyModifierAction(
        {
          ctrl: e.ctrlKey || e.metaKey,
          shift: e.shiftKey,
          alt: e.altKey,
          space: spaceOverride !== undefined ? spaceOverride : isSpaceDown,
        },
        useUiStore.getState().appSettings.modifierKeys
      );
      setHeldModifierAction(action);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && quickPalettePos) {
        setQuickPalettePos(null);
      }
      syncHeldAction(e, e.code === 'Space' ? true : undefined);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      syncHeldAction(e, e.code === 'Space' ? false : undefined);
    };

    const handleBlur = () => {
      setHeldModifierAction('none');
      setIsResizingBrush(false);
      setQuickPalettePos(null);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [isSpaceDown, quickPalettePos]);

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
      } else {
        onUpdateBrushSettings({ size: pendingSize, hardness: pendingHardness });
      }
    };

    const handleWindowPointerMove = (e: PointerEvent) => {
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

    const handleWindowPointerUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        commitResize();
      }
      setIsResizingBrush(false);
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [isResizingBrush, onUpdateBrushSettings, onUpdateLiquifySettings, tool]);

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
