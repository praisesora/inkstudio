import React, { useRef } from 'react';
import {
  BrushSettings,
  CanvasDimensions,
  LiquifySettings,
  RetouchSettings,
  ToolType,
} from '../../types/editor';
import { ModifierAction } from '../../types/settings';
import { CanvasNavigationHandle } from '../../hooks/useCanvasNavigation';
import { screenToCanvas } from '../../utils/canvasUtils';
import { resolvePointerModifierAction } from '../../utils/shortcutManager';
import { isNativePenStreamActive } from '../../utils/nativeTabletInput';
import { artworkTimeTracker } from '../../utils/artworkTimeTracker';
import { toolStoreActions, useToolStore, useUiStore } from '../../stores';
import { extractCoalescedEvents, extractPredictedEvents } from './types';

export interface UseCanvasPointerHandlersParams {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  dimensions: CanvasDimensions;
  brushSettings: BrushSettings;
  liquifySettings?: LiquifySettings;
  retouchSettings?: RetouchSettings;
  tool: ToolType;
  navigation?: CanvasNavigationHandle;
  pan: { x: number; y: number };
  zoom: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  isSpaceDown: boolean;
  quickPalettePos: { x: number; y: number } | null;
  setQuickPalettePos: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
  setIsResizingBrush: React.Dispatch<React.SetStateAction<boolean>>;
  resizeOriginRef: React.MutableRefObject<{ clientX: number; clientY: number }>;
  resizeStartSettingsRef: React.MutableRefObject<{ size: number; hardness: number }>;
  onStartPan: (e: React.PointerEvent) => void;
  onStartRotate: (e: React.PointerEvent) => void;
  onStartZoomDrag?: (e: React.PointerEvent) => void;
  onSampleColor?: (pt: { x: number; y: number }) => void;
  onUndo?: () => void;
  onSwapColors?: () => void;
  onPointerDown: (e: React.PointerEvent<HTMLElement>, coalesced?: PointerEvent[]) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>, coalesced?: PointerEvent[], predicted?: PointerEvent[]) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
}

export function useCanvasPointerHandlers({
  viewportRef,
  dimensions,
  brushSettings,
  liquifySettings,
  retouchSettings,
  tool,
  navigation,
  pan,
  zoom,
  rotation,
  flipX,
  flipY,
  isSpaceDown,
  quickPalettePos,
  setQuickPalettePos,
  setIsResizingBrush,
  resizeOriginRef,
  resizeStartSettingsRef,
  onStartPan,
  onStartRotate,
  onStartZoomDrag,
  onSampleColor,
  onUndo,
  onSwapColors,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: UseCanvasPointerHandlersParams) {
  const tempEraserPrevToolRef = useRef<ToolType | null>(null);

  const releaseExternalFocus = () => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return;
    if (viewportRef.current?.contains(active)) return;
    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') {
      active.blur();
    }
  };

  // Start brush resizing drag
  const startBrushResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizingBrush(true);
    resizeOriginRef.current = { clientX: e.clientX, clientY: e.clientY };
    resizeStartSettingsRef.current = {
      size:
        tool === 'liquify' && liquifySettings
          ? liquifySettings.size
          : tool === 'retouch' && retouchSettings
            ? retouchSettings.size
            : brushSettings.size,
      hardness:
        tool === 'retouch' && retouchSettings
          ? retouchSettings.hardness / 100
          : (brushSettings.hardness ?? 1.0),
    };
  };

  // Start continuous eyedropper sampling for modifier buttons (e.g. Right Click / Barrel Button)
  const startModifierEyedropper = (e: React.PointerEvent) => {
    if (!onSampleColor || !viewportRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    const sampleAtClient = (clientX: number, clientY: number) => {
      const vp = viewportRef.current;
      if (!vp) return;
      const rect = vp.getBoundingClientRect();
      const cam = navigation
        ? navigation.getCameraState()
        : { pan, zoom, rotation, flipX, flipY };
      const pt = screenToCanvas(
        clientX,
        clientY,
        rect,
        cam.pan,
        cam.zoom,
        cam.rotation,
        dimensions,
        cam.flipX,
        cam.flipY
      );
      onSampleColor(pt);
    };

    sampleAtClient(e.clientX, e.clientY);

    const handleMove = (ev: PointerEvent) => {
      sampleAtClient(ev.clientX, ev.clientY);
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
    window.addEventListener('pointermove', handleMove, { passive: true });
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  };

  // Open floating Quick Palette near cursor when mapped to 'quick-palette'
  const openQuickPaletteAt = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const x = Math.max(12, Math.min(rect.width - 210, e.clientX - rect.left));
    const y = Math.max(12, Math.min(rect.height - 150, e.clientY - rect.top));
    setQuickPalettePos({ x, y });
  };

  // Dispatch a resolved ModifierAction; returns true if the event was consumed
  const dispatchModifierAction = (
    action: ModifierAction,
    e: React.PointerEvent<HTMLElement>,
    allowDrawingPassThrough: boolean
  ): boolean => {
    switch (action) {
      case 'pan':
        e.stopPropagation();
        onStartPan(e);
        return true;
      case 'rotate':
        e.stopPropagation();
        onStartRotate(e);
        return true;
      case 'zoom-drag':
        if (onStartZoomDrag) {
          e.stopPropagation();
          onStartZoomDrag(e);
          return true;
        }
        return false;
      case 'brush-size':
        startBrushResize(e);
        return true;
      case 'eyedropper':
        if (
          allowDrawingPassThrough &&
          e.button === 0 &&
          e.altKey &&
          ((tool === 'retouch' && retouchSettings?.mode === 'clone-stamp') || tool === 'pen')
        ) {
          return false;
        }
        if (e.button !== 0 || !allowDrawingPassThrough) {
          startModifierEyedropper(e);
          return true;
        }
        // When button 0 + Alt is held, GlobalShortcutListener already switched tool to pipette,
        // or if not, sample directly via startModifierEyedropper
        if (tool !== 'pipette') {
          startModifierEyedropper(e);
          return true;
        }
        return false;
      case 'temp-eraser': {
        if (!allowDrawingPassThrough) return false;
        const cur = useToolStore.getState().tool;
        if (cur !== 'eraser') {
          tempEraserPrevToolRef.current = cur;
          toolStoreActions.selectTool('eraser');
        }
        return false; // let stroke begin on eraser
      }
      case 'undo':
        e.preventDefault();
        e.stopPropagation();
        onUndo?.();
        return true;
      case 'swap-colors':
        e.preventDefault();
        e.stopPropagation();
        onSwapColors?.();
        return true;
      case 'quick-palette':
        openQuickPaletteAt(e);
        return true;
      case 'straight-line':
      case 'none':
      default:
        return false;
    }
  };

  // Viewport background pointer down (clicking gray area to pan, rotate, zoom, resize, or quick palette)
  const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    releaseExternalFocus();
    if (quickPalettePos) setQuickPalettePos(null);

    const modSettings = useUiStore.getState().appSettings.modifierKeys;
    const resolved = resolvePointerModifierAction(
      {
        button: e.button,
        pointerType: e.pointerType,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        isSpaceDown,
      },
      modSettings
    );
    if (resolved && dispatchModifierAction(resolved.action, e, false)) {
      return;
    }
  };

  // Canvas pointer down: resolve Modifier Key Settings first, otherwise dispatch drawing/tool stroke
  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    releaseExternalFocus();
    if (quickPalettePos) setQuickPalettePos(null);

    const modSettings = useUiStore.getState().appSettings.modifierKeys;
    const resolved = resolvePointerModifierAction(
      {
        button: e.button,
        pointerType: e.pointerType,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        isSpaceDown,
      },
      modSettings
    );

    if (resolved) {
      if (dispatchModifierAction(resolved.action, e, true)) {
        return;
      }
    }

    if (e.button === 0) {
      e.preventDefault();
    } else {
      return;
    }

    // Native WinTab / Windows Ink channel owns pen brush/eraser strokes; skip duplicate DOM PointerEvent.
    if (
      e.pointerType === 'pen' &&
      isNativePenStreamActive() &&
      (tool === 'brush' || tool === 'eraser')
    ) {
      return;
    }

    const coalesced = extractCoalescedEvents(e);
    (e as any).coalescedEvents = coalesced;
    if (e.nativeEvent) {
      (e.nativeEvent as any).coalescedEvents = coalesced;
    }
    artworkTimeTracker.recordArtworkAction();
    onPointerDown(e, coalesced);
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (
      e.pointerType === 'pen' &&
      isNativePenStreamActive() &&
      (tool === 'brush' || tool === 'eraser')
    ) {
      return;
    }
    const coalesced = extractCoalescedEvents(e);
    const predicted = extractPredictedEvents(e);
    (e as any).coalescedEvents = coalesced;
    (e as any).predictedEvents = predicted;
    if (e.nativeEvent) {
      (e.nativeEvent as any).coalescedEvents = coalesced;
      (e.nativeEvent as any).predictedEvents = predicted;
    }
    onPointerMove(e, coalesced, predicted);
  };

  const handleCanvasPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (
      !(
        e.pointerType === 'pen' &&
        isNativePenStreamActive() &&
        (tool === 'brush' || tool === 'eraser')
      )
    ) {
      onPointerUp(e);
    }
    if (tempEraserPrevToolRef.current !== null) {
      const prev = tempEraserPrevToolRef.current;
      tempEraserPrevToolRef.current = null;
      toolStoreActions.selectTool(prev);
    }
  };

  const handleCanvasPointerCancel = (e: React.PointerEvent<HTMLElement>) => {
    handleCanvasPointerUp(e);
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    const modSettings = useUiStore.getState().appSettings.modifierKeys;
    if (modSettings.rightClick !== 'none' || modSettings.stylusButton1 !== 'none') {
      e.preventDefault();
    }
  };

  return {
    releaseExternalFocus,
    startBrushResize,
    startModifierEyedropper,
    openQuickPaletteAt,
    dispatchModifierAction,
    handleViewportPointerDown,
    handleCanvasPointerDown,
    handleCanvasPointerMove,
    handleCanvasPointerUp,
    handleCanvasPointerCancel,
    handleContextMenu,
  };
}
