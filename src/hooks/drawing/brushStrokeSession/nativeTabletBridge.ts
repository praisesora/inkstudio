import React from 'react';
import { ToolType } from '../../../types/editor';
import { NativeTabletSample } from '../../../utils/nativeTabletInput';

export const NATIVE_PEN_POINTER_ID = -1001;

export interface NativeTabletBridgeState {
  nativeStrokeActive: boolean;
  prevToolBeforeEraserFlip: ToolType | null;
}

export interface NativeTabletBridgeCallbacks {
  getTool: () => ToolType;
  selectTool: (tool: ToolType) => void;
  isDisabled: () => boolean;
  isStrokeActive?: () => boolean;
  isPointOverCanvasViewport: (x: number, y: number) => boolean;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (
    e: React.PointerEvent<HTMLElement>,
    coalesced: PointerEvent[]
  ) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onHover: (e: React.PointerEvent<HTMLElement>) => void;
}

export function createSyntheticNativePenEvent(
  s: NativeTabletSample,
  modKeys: { shift: boolean; alt: boolean }
): React.PointerEvent<HTMLElement> {
  const evt: Record<string, unknown> = {
    pointerId: NATIVE_PEN_POINTER_ID,
    pointerType: 'pen',
    button: 0,
    buttons: s.buttons & 1 ? 1 : 0,
    clientX: s.clientX,
    clientY: s.clientY,
    pressure: s.pressure,
    tiltX: s.tiltX,
    tiltY: s.tiltY,
    twist: s.twist,
    timeStamp: s.timestamp,
    shiftKey: modKeys.shift,
    altKey: modKeys.alt,
    ctrlKey: false,
    metaKey: false,
    preventDefault() {},
    stopPropagation() {},
  };
  evt.nativeEvent = evt;
  return evt as unknown as React.PointerEvent<HTMLElement>;
}

/**
 * Processes a batch of native WinTab / Windows Ink samples into pointer lifecycle callbacks.
 * Resilient against:
 *  - Spurious child-HWND phase=4 (leave) events while tip contact (buttons & 1) or pressure is still active
 *  - Missed phase=1 (down) events: cleanly recovers and starts a stroke when phase=2 arrives in-contact over canvas
 */
export function processNativeTabletBatch(
  batch: ReadonlyArray<NativeTabletSample>,
  bridge: NativeTabletBridgeState,
  modKeys: { shift: boolean; alt: boolean },
  cb: NativeTabletBridgeCallbacks
): void {
  const curTool = cb.getTool();
  const isBrushOrEraser = curTool === 'brush' || curTool === 'eraser';

  const startStrokeFromSample = (s: NativeTabletSample): boolean => {
    if (
      cb.isDisabled() ||
      !isBrushOrEraser ||
      !cb.isPointOverCanvasViewport(s.clientX, s.clientY)
    ) {
      return false;
    }
    const isTailEraser = (s.buttons & 8) !== 0;
    if (isTailEraser && curTool !== 'eraser') {
      bridge.prevToolBeforeEraserFlip = curTool;
      cb.selectTool('eraser');
    }
    bridge.nativeStrokeActive = true;
    cb.onPointerDown(createSyntheticNativePenEvent(s, modKeys));
    return true;
  };

  const endActiveStroke = (s: NativeTabletSample): void => {
    bridge.nativeStrokeActive = false;
    cb.onPointerUp(createSyntheticNativePenEvent(s, modKeys));
    if (bridge.prevToolBeforeEraserFlip !== null) {
      const prev = bridge.prevToolBeforeEraserFlip;
      bridge.prevToolBeforeEraserFlip = null;
      cb.selectTool(prev);
    }
  };

  let i = 0;
  while (i < batch.length) {
    const s = batch[i];

    if (s.phase === 1) {
      // Pen down: if the drawing session was externally aborted (e.g. Ctrl+Z during WinTab
      // pen-up hysteresis), resync bridge.nativeStrokeActive so the next pen-down starts cleanly.
      if (bridge.nativeStrokeActive && cb.isStrokeActive && !cb.isStrokeActive()) {
        bridge.nativeStrokeActive = false;
        if (bridge.prevToolBeforeEraserFlip !== null) {
          const prev = bridge.prevToolBeforeEraserFlip;
          bridge.prevToolBeforeEraserFlip = null;
          cb.selectTool(prev);
        }
      }
      if (!bridge.nativeStrokeActive) {
        startStrokeFromSample(s);
      } else {
        // Already active (e.g. duplicate down): treat as drag point so we don't abort mid-stroke
        const evt = createSyntheticNativePenEvent(s, modKeys);
        cb.onPointerMove(evt, [evt as unknown as PointerEvent]);
      }
      i++;
    } else if (s.phase === 2) {
      // If a phase=1 was missed or dropped, cleanly recover on in-contact drag over the canvas viewport
      if (!bridge.nativeStrokeActive && (s.buttons & 1) !== 0) {
        if (startStrokeFromSample(s)) {
          i++;
        }
      }

      // Batch all contiguous drag samples in this hardware burst
      const coalesced: PointerEvent[] = [];
      while (i < batch.length && batch[i].phase === 2) {
        coalesced.push(createSyntheticNativePenEvent(batch[i], modKeys) as unknown as PointerEvent);
        i++;
      }
      if (bridge.nativeStrokeActive && coalesced.length > 0) {
        const last = coalesced[coalesced.length - 1] as unknown as React.PointerEvent<HTMLElement>;
        cb.onPointerMove(last, coalesced);
      }
    } else if (s.phase === 3) {
      // Genuine pen up
      if (bridge.nativeStrokeActive) {
        endActiveStroke(s);
      }
      i++;
    } else if (s.phase === 4) {
      // Leave: ONLY end stroke if the pen truly lost contact (not a child-HWND hover bounce!)
      const stillInContact = (s.buttons & 1) !== 0 || s.pressure > 0.001;
      if (bridge.nativeStrokeActive && !stillInContact) {
        endActiveStroke(s);
      }
      i++;
    } else {
      // Hover (phase 0)
      if (!bridge.nativeStrokeActive && cb.isPointOverCanvasViewport(s.clientX, s.clientY)) {
        cb.onHover(createSyntheticNativePenEvent(s, modKeys));
      }
      i++;
    }
  }
}
