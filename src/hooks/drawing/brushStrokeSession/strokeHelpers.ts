import React from 'react';
import {
  BrushSettings,
  Point,
  CanvasDimensions,
  CanvasColorMode,
  LayerItem,
} from '../../../types/editor';
import { TILE_SIZE } from '../../../utils/tileEngine';
import { calculateStrokeWidth, screenToCanvas, get2DContext } from '../../../utils/canvasUtils';
import { enforceColorMode } from '../../../utils/colorUtils';
import { BrushRenderOptions, buildBrushRenderOptions } from '../../../engine/BrushEngine';
import { ConstraintAxis } from '../../../types/perspective';
import { useUiStore } from '../../../stores';
import { recoveryService } from '../../../services/recoveryService';
import { evaluateGlobalPressureCurve } from '../../../utils/pressureCurve';
import { DraftCanvasElement } from '../types';
import { StrokeSessionState, TouchedTileSpan, UseBrushStrokeSessionParams } from './types';

export function getPredictedCanvasElement(
  predictedCanvasRef?: React.RefObject<HTMLCanvasElement | null>
): HTMLCanvasElement | null {
  if (predictedCanvasRef?.current) return predictedCanvasRef.current;
  if (typeof document !== 'undefined') {
    return document.getElementById('ink-predicted-canvas') as HTMLCanvasElement | null;
  }
  return null;
}

export function clearPredictedCanvasSurface(
  state: StrokeSessionState,
  getPredictedCanvas: () => HTMLCanvasElement | null
): void {
  state.latestPredicted = null;
  if (!state.isPredictedCanvasDirty) return;
  const pCanvas = getPredictedCanvas();
  if (pCanvas) {
    const pCtx = get2DContext(pCanvas);
    if (pCtx) {
      pCtx.resetTransform();
      pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);
    }
  }
  state.isPredictedCanvasDirty = false;
}

export function emitConstraintAxisChangeIfNeeded(
  state: StrokeSessionState,
  onActiveConstraintAxisChangeRef: React.MutableRefObject<
    ((axis: ConstraintAxis | null) => void) | undefined
  >,
  newAxis: ConstraintAxis | null
): void {
  const prev = state.lastEmittedAxis;
  if (prev === newAxis) return;
  if (
    prev &&
    newAxis &&
    prev.type === newAxis.type &&
    prev.origin.x === newAxis.origin.x &&
    prev.origin.y === newAxis.origin.y &&
    prev.dir.x === newAxis.dir.x &&
    prev.dir.y === newAxis.dir.y
  ) {
    return;
  }
  state.lastEmittedAxis = newAxis;
  onActiveConstraintAxisChangeRef.current?.(newAxis);
}

export function markTouchedTilesInRect(
  dims: CanvasDimensions,
  touchedTiles: Set<number>,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): void {
  const cx0 = Math.max(0, Math.floor(minX));
  const cy0 = Math.max(0, Math.floor(minY));
  const cx1 = Math.min(dims.width, Math.ceil(maxX));
  const cy1 = Math.min(dims.height, Math.ceil(maxY));
  if (cx1 <= cx0 || cy1 <= cy0) return;
  const tx0 = Math.floor(cx0 / TILE_SIZE);
  const ty0 = Math.floor(cy0 / TILE_SIZE);
  const tx1 = Math.floor((cx1 - 1) / TILE_SIZE);
  const ty1 = Math.floor((cy1 - 1) / TILE_SIZE);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      touchedTiles.add(ty * 65536 + tx);
    }
  }
}

export function getViewportRectCached(
  state: StrokeSessionState,
  viewportRef: React.RefObject<HTMLDivElement | null>
): DOMRect | null {
  if (!state.cachedViewportRect && viewportRef.current) {
    state.cachedViewportRect = viewportRef.current.getBoundingClientRect();
  }
  return state.cachedViewportRect;
}

export function dispatchPointerStatThrottled(
  state: StrokeSessionState,
  x: number | null,
  y: number | null,
  pressure: number
): void {
  state.pendingStat = {
    x: x !== null ? Math.round(x) : null,
    y: y !== null ? Math.round(y) : null,
    pressure,
  };
  if (state.statRaf === null) {
    state.statRaf = requestAnimationFrame(() => {
      state.statRaf = null;
      if (state.pendingStat) {
        window.dispatchEvent(
          new CustomEvent('canvas-pointer-stat', {
            detail: {
              ...state.pendingStat,
              isHovering: state.pendingStat.x !== null,
            },
          })
        );
      }
    });
  }
}

export function abortActiveStrokeSession(
  params: Pick<
    UseBrushStrokeSessionParams,
    'isDrawingRef' | 'effectiveDraftCanvasRef' | 'activeTileGridRef' | 'interactionRef'
  >,
  state: StrokeSessionState,
  clearPredictedCanvas: () => void,
  emitConstraintAxisChange: (axis: ConstraintAxis | null) => void
): void {
  if (!params.isDrawingRef.current) return;
  if (state.drawRafId !== null) {
    cancelAnimationFrame(state.drawRafId);
    state.drawRafId = null;
  }
  const draftCanvas = params.effectiveDraftCanvasRef?.current as
    | DraftCanvasElement
    | null
    | undefined;
  let clearedActiveDraft = false;
  if (draftCanvas) {
    const dCtx = get2DContext(draftCanvas);
    if (dCtx) {
      try {
        dCtx.restore();
      } catch {
        // Ignore restore underflow
      }
      dCtx.resetTransform();
      dCtx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
    }
    if (draftCanvas.__draftHasContent) {
      clearedActiveDraft = true;
    }
    draftCanvas.__draftHasContent = false;
    draftCanvas.__draftCompositeOp = 'source-over';
    draftCanvas.__draftMonochrome = false;
    draftCanvas.__draftVersion = (draftCanvas.__draftVersion || 0) + 1;
  }
  clearPredictedCanvas();
  if (clearedActiveDraft) {
    params.activeTileGridRef.current.notifyChange(true);
  }
  state.strokePipeline.abortStroke();
  state.frameGpuDabs.length = 0;
  if (state.activePointerId !== null && params.interactionRef.current) {
    try {
      params.interactionRef.current.releasePointerCapture(state.activePointerId);
    } catch {
      // Ignore release errors when capture already ended
    }
  }
  params.isDrawingRef.current = false;
  recoveryService.setDrawingActive(false);
  state.activePointerId = null;
  state.allStrokePoints = [];
  state.stabilizedPoint = null;
  state.hasLastProcessedPoint = false;
  state.dirtyRect = null;
  state.touchedTiles.clear();
  state.liveNeedsNotify = false;
  state.isShiftLineStroke = false;
  state.layerPixelSampler = null;
  state.activeReservoir = null;
  state.snapSession.endStroke();
  state.straightSnapSession.endStroke();
  emitConstraintAxisChange(null);
}

export function computeCanvasPoint(
  e: React.PointerEvent<HTMLElement> | PointerEvent,
  params: Pick<
    UseBrushStrokeSessionParams,
    'dimensionsRef' | 'panRef' | 'zoomRef' | 'rotationRef' | 'flipXRef' | 'flipYRef'
  >,
  getViewportRect: () => DOMRect | null,
  getBrushSettings: () => BrushSettings
): Point {
  const vRect = getViewportRect();
  const dims = params.dimensionsRef.current;
  const bs = getBrushSettings();
  if (!vRect) {
    return { x: 0, y: 0, pressure: 0.5, width: bs.size, timestamp: e.timeStamp };
  }

  const { x, y } = screenToCanvas(
    e.clientX,
    e.clientY,
    vRect,
    params.panRef.current,
    params.zoomRef.current,
    params.rotationRef.current,
    dims,
    params.flipXRef.current,
    params.flipYRef.current
  );

  let pressure = 0;
  if (e.pointerType === 'mouse') {
    pressure = e.buttons & 1 ? 0.5 : 0;
  } else {
    const rawP = e.pressure !== undefined ? Math.max(0, Math.min(1.0, e.pressure)) : 0;
    pressure = evaluateGlobalPressureCurve(rawP, useUiStore.getState().appSettings.pressureCurve);
  }

  const width = calculateStrokeWidth(
    bs.size,
    pressure,
    bs.minSizeFactor,
    bs.usePressure,
    e.pointerType,
    bs.pressureCurveGamma ?? 1.0,
    1.0,
    bs.pressureCurve
  );

  return {
    x,
    y,
    pressure,
    width,
    tiltX: e.tiltX ?? 0,
    tiltY: e.tiltY ?? 0,
    twist: e.twist ?? 0,
    timestamp: e.timeStamp,
  };
}

export function resolveEffectiveOpacitySensorValue(
  bs: BrushSettings,
  isMonochrome: boolean,
  isEraser: boolean
): BrushSettings['opacitySensor'] {
  if (bs.opacitySensor) return bs.opacitySensor;
  if (bs.usePressure && !isMonochrome && !isEraser && (bs.flow ?? 1.0) < 0.99) {
    return { usePressure: true, pressureMin: 0.2 };
  }
  return undefined;
}

export function resolveLiveAntiAliasValue(
  bs: BrushSettings,
  isMonochrome: boolean,
  scale: number
): number | undefined {
  const downscaled = scale < 0.999;
  if (isMonochrome) {
    const allowGpuMono = (bs.antiAlias ?? 2) !== 0 && bs.useGpu !== false;
    if (allowGpuMono || downscaled) {
      return (bs.antiAlias ?? 2) !== 0 ? bs.antiAlias ?? 2 : 2;
    }
    return 0;
  }
  if (bs.antiAlias === 0 && downscaled) {
    return 2;
  }
  return bs.antiAlias;
}

export function buildTouchedTileSpansFromSet(
  touchedTiles: Set<number>,
  sx: number,
  sy: number,
  dw: number,
  dh: number
): TouchedTileSpan[] {
  if (dw * dh <= TILE_SIZE * TILE_SIZE || touchedTiles.size === 0) {
    return [{ x: sx, y: sy, width: dw, height: dh }];
  }
  const rows = new Map<number, number[]>();
  for (const key of touchedTiles) {
    const ty = Math.floor(key / 65536);
    const tx = key % 65536;
    let list = rows.get(ty);
    if (!list) {
      list = [];
      rows.set(ty, list);
    }
    list.push(tx);
  }
  const spans: TouchedTileSpan[] = [];
  for (const [ty, txList] of rows) {
    txList.sort((a, b) => a - b);
    let spanStart = txList[0];
    let spanEnd = txList[0];
    const pushClampedSpan = (s0: number, s1: number) => {
      const rx = Math.max(sx, s0 * TILE_SIZE);
      const ry = Math.max(sy, ty * TILE_SIZE);
      const rxEnd = Math.min(sx + dw, (s1 + 1) * TILE_SIZE);
      const ryEnd = Math.min(sy + dh, (ty + 1) * TILE_SIZE);
      const rw = rxEnd - rx;
      const rh = ryEnd - ry;
      if (rw > 0 && rh > 0) spans.push({ x: rx, y: ry, width: rw, height: rh });
    };
    for (let i = 1; i < txList.length; i++) {
      if (txList[i] <= spanEnd + 1) {
        spanEnd = txList[i];
      } else {
        pushClampedSpan(spanStart, spanEnd);
        spanStart = txList[i];
        spanEnd = txList[i];
      }
    }
    pushClampedSpan(spanStart, spanEnd);
  }
  return spans.length > 0 ? spans : [{ x: sx, y: sy, width: dw, height: dh }];
}

export function createLiveBrushOptions(
  state: StrokeSessionState,
  bs: BrushSettings,
  strokeFlow: number,
  strokeSpacing: number,
  strokeHardness: number,
  isMonochrome: boolean,
  canvas: HTMLCanvasElement | null,
  activeLayer: LayerItem | undefined,
  isEraser: boolean,
  isBgEraser: boolean,
  isolatedPass: boolean = false,
  effectiveAntiAlias?: number
): BrushRenderOptions {
  return buildBrushRenderOptions(bs, {
    opacity: isolatedPass ? 1.0 : bs.opacity,
    flow: strokeFlow,
    spacing: strokeSpacing,
    hardness: strokeHardness,
    antiAlias:
      effectiveAntiAlias !== undefined ? effectiveAntiAlias : isMonochrome ? 0 : bs.antiAlias,
    opacitySensor: resolveEffectiveOpacitySensorValue(bs, isMonochrome, isEraser),
    wetEdge: 0,
    underlyingCanvas: canvas || undefined,
    sampler: state.layerPixelSampler || undefined,
    reservoir: state.activeReservoir || undefined,
    isEraser: isolatedPass ? false : isEraser && !isBgEraser,
    isBgEraser: isolatedPass ? false : isBgEraser,
    alphaLocked: isolatedPass ? false : Boolean(activeLayer?.alphaLocked),
    isTransparentInk: isolatedPass ? false : Boolean(bs.isTransparentInk),
    currentStrokeDist: state.strokeTotalDistance,
  });
}

export function resolveStrokeColorValue(
  isMaskMode: boolean,
  bs: BrushSettings,
  isEraser: boolean,
  isBgEraser: boolean,
  isMonochrome: boolean,
  mode: CanvasColorMode
): string {
  if (isMaskMode) {
    if (isEraser) return '#000000';
    let clean = bs.color.replace('#', '');
    if (clean.length === 3) {
      clean = clean
        .split('')
        .map((c) => c + c)
        .join('');
    }
    const r = parseInt(clean.slice(0, 2), 16) || 0;
    const g = parseInt(clean.slice(2, 4), 16) || 0;
    const b = parseInt(clean.slice(4, 6), 16) || 0;
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const hexVal = gray.toString(16).padStart(2, '0');
    return `#${hexVal}${hexVal}${hexVal}`;
  }
  return isBgEraser
    ? '#ffffff'
    : enforceColorMode(bs.color, isMonochrome ? 'monochrome' : mode);
}
