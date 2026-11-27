import React from 'react';
import { screenToCanvasInto } from '../../../utils/canvasUtils';
import { encodePointerType } from '../../../engine/StrokePipeline';
import { useUiStore } from '../../../stores';
import { ExtendedPointerEvent } from '../types';
import {
  StrokeSessionHelpers,
  StrokeSessionState,
  UseBrushStrokeSessionParams,
} from './types';

export function runPointerMove(
  state: StrokeSessionState,
  params: UseBrushStrokeSessionParams,
  helpers: StrokeSessionHelpers,
  e: React.PointerEvent<HTMLElement>,
  coalescedEvents?: PointerEvent[],
  predictedEvents?: PointerEvent[]
): void {
  const extEvent = e as ExtendedPointerEvent;
  if (!params.isDrawingRef.current || e.pointerId !== state.activePointerId) {
    const point = helpers.getCanvasPoint(e);
    helpers.dispatchPointerStat(point.x, point.y, point.pressure);
    params.onCollabCursorMoveRef.current?.(point.x, point.y, false, helpers.getTool());
    return;
  }

  e.preventDefault();

  const vRect = helpers.getViewportRect();
  if (!vRect) return;
  const dims = params.dimensionsRef.current;

  const candidateCoalesced: PointerEvent[] | readonly PointerEvent[] | null =
    coalescedEvents ??
    extEvent.coalescedEvents ??
    (typeof e.nativeEvent?.getCoalescedEvents === 'function'
      ? e.nativeEvent.getCoalescedEvents()
      : null);
  let rawCoalesced: PointerEvent[] | readonly PointerEvent[] | null = null;
  if (candidateCoalesced && candidateCoalesced.length > 0) {
    const lastC = candidateCoalesced[candidateCoalesced.length - 1];
    const nativeEvt = e.nativeEvent;
    if (
      lastC &&
      nativeEvt &&
      Number.isFinite(lastC.clientX) &&
      Number.isFinite(lastC.clientY) &&
      Math.hypot(lastC.clientX - nativeEvt.clientX, lastC.clientY - nativeEvt.clientY) <= 1.5
    ) {
      rawCoalesced = candidateCoalesced;
    }
  }
  const count = rawCoalesced && rawCoalesced.length > 0 ? rawCoalesced.length : 1;

  const pipeline = state.strokePipeline;
  const scratch = state.scratchDocCoord;
  const lastProc = state.lastProcessedPoint;
  const minStepDoc = Math.min(0.25, 0.25 / Math.max(0.05, params.zoomRef.current));
  const isAltOverride = e.altKey;
  const isShiftKey = e.shiftKey;
  const ruler = params.rulerRef.current ?? null;
  const activeStraightRuler = params.straightRulerRef?.current ?? null;
  const curPan = params.panRef.current;
  const curZoom = params.zoomRef.current;
  const curRot = params.rotationRef.current;
  const curFlipX = params.flipXRef.current;
  const curFlipY = params.flipYRef.current;

  let lastQueuedX = 0;
  let lastQueuedY = 0;
  let lastQueuedPressure = state.lastQueuedPressure;
  let hasQueued = false;

  // Ensure monotonic, evenly spaced timestamps across same-timestamp coalesced hardware bursts
  // (common in WebView2 / Chromium getCoalescedEvents and Windows Ink / WinTab bursts).
  const batchEndTs =
    (rawCoalesced && rawCoalesced.length > 0
      ? rawCoalesced[rawCoalesced.length - 1].timeStamp
      : e.nativeEvent.timeStamp) || performance.now();
  const prevTs = state.lastPointTime || 0;
  let allSameTs = count > 1;
  if (allSameTs && rawCoalesced) {
    const firstTs = rawCoalesced[0].timeStamp;
    for (let k = 1; k < count; k++) {
      if (Math.abs(rawCoalesced[k].timeStamp - firstTs) > 0.25) {
        allSameTs = false;
        break;
      }
    }
  }
  const syntheticSpanMs =
    allSameTs && count > 1
      ? prevTs > 0 && batchEndTs > prevTs + 0.5
        ? Math.min(40, batchEndTs - prevTs)
        : count * 4.0
      : 0;
  const syntheticStartTs = batchEndTs - syntheticSpanMs;

  for (let i = 0; i < count; i++) {
    const cEvent = rawCoalesced && rawCoalesced.length > 0 ? rawCoalesced[i] : e.nativeEvent;
    const sampleTs =
      allSameTs && count > 1
        ? syntheticStartTs + (syntheticSpanMs * (i + 1)) / count
        : cEvent.timeStamp;
    screenToCanvasInto(
      cEvent.clientX,
      cEvent.clientY,
      vRect,
      curPan,
      curZoom,
      curRot,
      dims,
      scratch,
      curFlipX,
      curFlipY
    );

    let cx = scratch.x;
    let cy = scratch.y;
    const straightRes = state.straightSnapSession.processPoint(
      scratch,
      activeStraightRuler,
      isAltOverride
    );
    if (straightRes.snapped) {
      cx = straightRes.x;
      cy = straightRes.y;
    } else {
      const snapRes = state.snapSession.processPoint(scratch, ruler, isAltOverride);
      cx = snapRes.x;
      cy = snapRes.y;
      if (snapRes.axis) {
        helpers.emitConstraintAxisChange(snapRes.axis);
      } else if (
        !state.isShiftLineStroke &&
        isShiftKey &&
        useUiStore.getState().appSettings.modifierKeys.shift === 'straight-line' &&
        !ruler?.enabled &&
        !(activeStraightRuler?.enabled && activeStraightRuler?.snapEnabled) &&
        state.allStrokePoints.length > 0
      ) {
        const originPt = state.allStrokePoints[0];
        const dx = cx - originPt.x;
        const dy = cy - originPt.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.5) {
          const snapAngle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
          cx = originPt.x + Math.cos(snapAngle) * dist;
          cy = originPt.y + Math.sin(snapAngle) * dist;
        }
      }
    }

    let cPressure = 0;
    if (cEvent.pointerType === 'mouse') {
      cPressure = cEvent.buttons & 1 ? 0.5 : 0;
    } else {
      cPressure =
        cEvent.pressure !== undefined ? Math.max(0, Math.min(1.0, cEvent.pressure)) : 0;
    }

    if (
      state.hasLastProcessedPoint &&
      Math.hypot(cx - lastProc.x, cy - lastProc.y) < minStepDoc &&
      Math.abs(cPressure - lastQueuedPressure) <= 0.04
    ) {
      continue;
    }

    lastProc.x = cx;
    lastProc.y = cy;
    state.hasLastProcessedPoint = true;

    pipeline.enqueueSample(
      cx,
      cy,
      cPressure,
      cEvent.tiltX ?? 0,
      cEvent.tiltY ?? 0,
      cEvent.twist ?? 0,
      sampleTs,
      encodePointerType(cEvent.pointerType)
    );
    lastQueuedX = cx;
    lastQueuedY = cy;
    lastQueuedPressure = cPressure;
    hasQueued = true;
  }

  state.lastQueuedPressure = lastQueuedPressure;

  const rawPredicted =
    predictedEvents ??
    extEvent.predictedEvents ??
    (typeof e.nativeEvent?.getPredictedEvents === 'function'
      ? e.nativeEvent.getPredictedEvents()
      : null);

  if (rawPredicted && rawPredicted.length > 0) {
    state.latestPredicted = { predEvents: rawPredicted, vRect };
  } else {
    state.latestPredicted = null;
  }

  if (hasQueued) {
    helpers.dispatchPointerStat(lastQueuedX, lastQueuedY, lastQueuedPressure);
    params.onCollabCursorMoveRef.current?.(lastQueuedX, lastQueuedY, true, helpers.getTool());
  }

  if (
    (pipeline.getPendingCount() > 0 || state.latestPredicted !== null) &&
    state.drawRafId === null
  ) {
    state.drawRafId = requestAnimationFrame(helpers.flushPendingPoints);
  }
}

export function runPointerEnter(
  state: StrokeSessionState,
  viewportRef: UseBrushStrokeSessionParams['viewportRef'],
  dispatchPointerStat: StrokeSessionHelpers['dispatchPointerStat']
): void {
  if (viewportRef.current) {
    state.cachedViewportRect = viewportRef.current.getBoundingClientRect();
  }
  dispatchPointerStat(null, null, 0);
}

export function runPointerLeave(
  isDrawingRef: UseBrushStrokeSessionParams['isDrawingRef'],
  dispatchPointerStat: StrokeSessionHelpers['dispatchPointerStat']
): void {
  if (!isDrawingRef.current) {
    dispatchPointerStat(null, null, 0);
  }
}
