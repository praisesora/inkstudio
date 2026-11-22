import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CanvasColorMode,
  CanvasDimensions,
  CanvasSelection,
  LayerItem,
  PenPathSession,
  Point2D,
  VectorKnot,
  VectorStroke,
} from '../../types/editor';
import {
  computeBezierPathBounds,
  findClosestPointOnBezierPath,
  insertBezierAnchorAt,
  moveBezierAnchor,
  moveBezierHandle,
  toggleBezierAnchorSmooth,
} from '../../utils/bezierEngine';
import { renderVectorLayer, renderVectorStroke } from '../../utils/vectorEngine';
import { createSelectionMask } from '../../utils/tonalEngine';
import { documentStore } from '../../utils/documentStore';
import { TileFormat, TileSnapshotEntry, releaseTemporaryCanvas } from '../../utils/tileEngine';
import { get2DContext } from '../../utils/canvasUtils';
import { multiplayerService } from '../../services/multiplayerService';
import { interactiveToolBridge, toolStoreActions, useToolStore } from '../../stores';
import type { PushHistoryStepFn } from './types';

export interface UsePenToolParams {
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  activeLayer: LayerItem | undefined;
  activeLayerId: string;
  selection: CanvasSelection | null;
  zoomRef: React.MutableRefObject<number>;
  flushPendingHistoryTasks?: () => void;
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean;
  getCanvasCoords: (e: React.PointerEvent<HTMLElement> | PointerEvent) => Point2D;
  updateLayerThumbnail: (layerId: string, immediate?: boolean) => void;
  pushHistoryStep: PushHistoryStepFn;
  showToast?: (msg: string) => void;
}

export interface UsePenToolResult {
  penSession: PenPathSession | null;
  setPenSession: React.Dispatch<React.SetStateAction<PenPathSession | null>>;
  handleCommitPenPath: () => void;
  handleCancelPenPath: () => void;
  handleClosePenPath: () => void;
  handleDeleteSelectedAnchor: () => void;
  handleToggleSelectedAnchorSmooth: () => void;
  handlePenPointerDown: (e: React.PointerEvent<HTMLElement>, pt: Point2D) => boolean;
  handlePenPointerMove: (e: React.PointerEvent<HTMLElement>) => boolean;
  handlePenPointerUp: (e: React.PointerEvent<HTMLElement>) => boolean;
}

type PenDragState =
  | { kind: 'placing-handle'; anchorIndex: number; origin: Point2D }
  | { kind: 'move-anchor'; anchorIndex: number }
  | { kind: 'move-handle'; anchorIndex: number; which: 'in' | 'out' }
  | null;

function resolvePenFillColor(
  fillEnabled: boolean,
  fillColorMode: 'primary' | 'secondary' | 'custom',
  customFillColor: string,
  primaryColor: string,
  secondaryColor: string
): string | null {
  if (!fillEnabled) return null;
  if (fillColorMode === 'primary') return primaryColor || '#000000';
  if (fillColorMode === 'secondary') return secondaryColor || '#ffffff';
  return customFillColor || '#ffffff';
}

export function usePenTool({
  dimensions,
  colorMode,
  activeLayer,
  activeLayerId,
  selection,
  zoomRef,
  flushPendingHistoryTasks,
  isLayerEffectivelyVisible,
  getCanvasCoords,
  updateLayerThumbnail,
  pushHistoryStep,
  showToast,
}: UsePenToolParams): UsePenToolResult {
  const [penSession, setPenSession] = useState<PenPathSession | null>(null);
  const penSessionRef = useRef<PenPathSession | null>(null);
  penSessionRef.current = penSession;

  const dragRef = useRef<PenDragState>(null);
  const lastClickRef = useRef<{ time: number; x: number; y: number }>({ time: 0, x: 0, y: 0 });

  const handleCancelPenPath = useCallback(() => {
    dragRef.current = null;
    setPenSession(null);
  }, []);

  const handleClosePenPath = useCallback(() => {
    setPenSession((prev) => {
      if (!prev || prev.knots.length < 2) return prev;
      return { ...prev, closed: !prev.closed };
    });
  }, []);

  const handleDeleteSelectedAnchor = useCallback(() => {
    setPenSession((prev) => {
      if (!prev || prev.knots.length === 0) return null;
      const targetIdx =
        prev.selectedAnchorIndex !== null &&
        prev.selectedAnchorIndex >= 0 &&
        prev.selectedAnchorIndex < prev.knots.length
          ? prev.selectedAnchorIndex
          : prev.knots.length - 1;
      const nextKnots = prev.knots.filter((_, i) => i !== targetIdx);
      if (nextKnots.length === 0) return null;
      return {
        ...prev,
        knots: nextKnots,
        closed: nextKnots.length < 2 ? false : prev.closed,
        selectedAnchorIndex: Math.min(targetIdx, nextKnots.length - 1),
      };
    });
  }, []);

  const handleToggleSelectedAnchorSmooth = useCallback(() => {
    setPenSession((prev) => {
      if (!prev || prev.selectedAnchorIndex === null) return prev;
      return {
        ...prev,
        knots: toggleBezierAnchorSmooth(prev.knots, prev.selectedAnchorIndex, prev.closed),
      };
    });
  }, []);

  const handleCommitPenPath = useCallback(() => {
    const session = penSessionRef.current;
    if (!session || session.knots.length < 2) {
      setPenSession(null);
      return;
    }

    if (
      !activeLayer ||
      (activeLayer.type !== 'raster' && activeLayer.type !== 'vector') ||
      activeLayer.locked ||
      !isLayerEffectivelyVisible(activeLayer)
    ) {
      showToast?.('Select an unlocked, visible Raster or Vector layer to commit Bézier path');
      return;
    }

    const { penSettings, primaryColor, secondaryColor } = useToolStore.getState();
    const strokeColor = penSettings.strokeEnabled ? primaryColor || '#000000' : 'none';
    const fillColor = resolvePenFillColor(
      penSettings.fillEnabled && session.closed,
      penSettings.fillColorMode,
      penSettings.customFillColor,
      primaryColor,
      secondaryColor
    );

    if (strokeColor === 'none' && !fillColor) {
      showToast?.('Enable Stroke or Fill (closed path) before committing');
      return;
    }

    const strokeWidth = Math.max(0.5, penSettings.strokeWidth || 4);
    const syncedKnots: VectorKnot[] = session.knots.map((k) => ({
      ...k,
      width: strokeWidth,
      handleIn: k.handleIn ? { ...k.handleIn } : null,
      handleOut: k.handleOut ? { ...k.handleOut } : null,
    }));
    const bounds = computeBezierPathBounds(syncedKnots, session.closed);

    const strokeId =
      session.editingStrokeId ||
      `bezier-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const bezierStroke: VectorStroke = {
      id: strokeId,
      layerId: activeLayerId,
      tool: 'pen',
      curveType: 'bezier',
      closed: session.closed,
      fillColor,
      knots: syncedKnots,
      color: strokeColor,
      baseWidth: penSettings.strokeEnabled ? strokeWidth : 0,
      opacity: Math.max(0.05, Math.min(1, penSettings.opacity ?? 1)),
      bounds,
    };

    flushPendingHistoryTasks?.();
    const grid = documentStore.getActiveTileGrid();
    const isBg = activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg');
    const isMono =
      !isBg && (colorMode === 'monochrome' || activeLayer.expressionColor === 'monochrome');
    const targetFormat: TileFormat = isMono ? 'monochrome-1bit' : 'color-32bit';

    if (activeLayer.type === 'vector') {
      const prevStrokes = [...(activeLayer.vectorStrokes || [])];
      const existingIdx = session.editingStrokeId
        ? prevStrokes.findIndex((s) => s.id === session.editingStrokeId)
        : -1;
      const updatedStrokes =
        existingIdx >= 0
          ? prevStrokes.map((s, idx) => (idx === existingIdx ? bezierStroke : s))
          : [...prevStrokes, bezierStroke];

      activeLayer.vectorStrokes = updatedStrokes;

      // Re-render affected bounding region from authoritative vector strokes
      let minX = bounds.minX;
      let minY = bounds.minY;
      let maxX = bounds.maxX;
      let maxY = bounds.maxY;
      if (existingIdx >= 0 && prevStrokes[existingIdx]?.bounds) {
        const pb = prevStrokes[existingIdx].bounds;
        minX = Math.min(minX, pb.minX);
        minY = Math.min(minY, pb.minY);
        maxX = Math.max(maxX, pb.maxX);
        maxY = Math.max(maxY, pb.maxY);
      }
      const pad = Math.ceil(Math.max(16, strokeWidth * 2));
      const vx = Math.max(0, Math.floor(minX - pad));
      const vy = Math.max(0, Math.floor(minY - pad));
      const vw = Math.max(0, Math.min(dimensions.width, Math.ceil(maxX + pad)) - vx);
      const vh = Math.max(0, Math.min(dimensions.height, Math.ceil(maxY + pad)) - vy);

      if (vw > 0 && vh > 0) {
        const temp = document.createElement('canvas');
        temp.width = vw;
        temp.height = vh;
        const ctx = get2DContext(temp);
        if (ctx) {
          ctx.save();
          ctx.translate(-vx, -vy);
          renderVectorLayer(ctx, updatedStrokes);
          ctx.restore();
          const subData = ctx.getImageData(0, 0, vw, vh);
          grid.writeImageData(activeLayerId, subData, vx, vy, targetFormat);
        }
        releaseTemporaryCanvas(temp);
      }

      pushHistoryStep(
        'pen',
        existingIdx >= 0 ? 'Edit Bézier Path' : 'Bézier Pen Path',
        null,
        null,
        activeLayerId,
        vw > 0 && vh > 0 ? { x: vx, y: vy, width: vw, height: vh } : undefined,
        undefined,
        { before: prevStrokes, after: updatedStrokes },
        undefined,
        strokeId
      );
      if (multiplayerService.isConnected()) {
        multiplayerService.sendLayerUpdate(activeLayerId, { vectorStrokes: updatedStrokes });
      }
      updateLayerThumbnail(activeLayerId, true);
      setPenSession(null);
      return;
    }

    // Raster layer commit: render crisp native cubic Bézier path directly into SparseTileGrid ROI
    const pad = Math.ceil(Math.max(16, strokeWidth * 2));
    const vx = Math.max(0, Math.floor(bounds.minX - pad));
    const vy = Math.max(0, Math.floor(bounds.minY - pad));
    const vw = Math.max(0, Math.min(dimensions.width, Math.ceil(bounds.maxX + pad)) - vx);
    const vh = Math.max(0, Math.min(dimensions.height, Math.ceil(bounds.maxY + pad)) - vy);

    if (vw > 0 && vh > 0) {
      const dirtyRect = { x: vx, y: vy, width: vw, height: vh };
      const beforeSnapshot: Map<string, TileSnapshotEntry> = grid.snapshotTilesInRect(
        activeLayerId,
        dirtyRect
      );

      const overlay = document.createElement('canvas');
      overlay.width = vw;
      overlay.height = vh;
      const oCtx = get2DContext(overlay);
      if (oCtx) {
        oCtx.save();
        oCtx.translate(-vx, -vy);
        renderVectorStroke(oCtx, bezierStroke);
        oCtx.restore();

        const pathImg = oCtx.getImageData(0, 0, vw, vh);
        const selMask = selection
          ? createSelectionMask(selection, dimensions.width, dimensions.height)
          : null;
        if (selMask) {
          const pData = pathImg.data;
          for (let ly = 0; ly < vh; ly++) {
            const row = (vy + ly) * dimensions.width + vx;
            for (let lx = 0; lx < vw; lx++) {
              const m = selMask[row + lx];
              if (m < 255) {
                const idx = (ly * vw + lx) * 4 + 3;
                pData[idx] = Math.round((pData[idx] * m) / 255);
              }
            }
          }
        }

        // Composite onto existing region pixels respecting alphaLock
        const existing = grid.readImageData(activeLayerId, vx, vy, vw, vh);
        const dst = existing.data;
        const src = pathImg.data;
        const alphaLock = Boolean(activeLayer.alphaLocked);
        for (let i = 0; i < src.length; i += 4) {
          const sa = src[i + 3] / 255;
          if (sa <= 0) continue;
          const da = dst[i + 3] / 255;
          if (alphaLock && da <= 0) continue;
          if (alphaLock) {
            const inv = 1 - sa;
            dst[i] = Math.round(dst[i] * inv + src[i] * sa);
            dst[i + 1] = Math.round(dst[i + 1] * inv + src[i + 1] * sa);
            dst[i + 2] = Math.round(dst[i + 2] * inv + src[i + 2] * sa);
          } else {
            const outA = sa + da * (1 - sa);
            if (outA > 1e-6) {
              const invOut = 1 / outA;
              dst[i] = Math.round((src[i] * sa + dst[i] * da * (1 - sa)) * invOut);
              dst[i + 1] = Math.round((src[i + 1] * sa + dst[i + 1] * da * (1 - sa)) * invOut);
              dst[i + 2] = Math.round((src[i + 2] * sa + dst[i + 2] * da * (1 - sa)) * invOut);
              dst[i + 3] = Math.round(outA * 255);
            }
          }
        }

        grid.writeImageData(activeLayerId, existing, vx, vy, targetFormat);
        const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, activeLayerId, dirtyRect);
        if (tileDeltas.length > 0) {
          pushHistoryStep(
            'pen',
            'Bézier Pen Path',
            null,
            null,
            activeLayerId,
            dirtyRect,
            tileDeltas
          );
          if (multiplayerService.isConnected()) {
            multiplayerService.sendTileDeltas(tileDeltas, grid);
          }
          updateLayerThumbnail(activeLayerId, true);
        }
      }
      releaseTemporaryCanvas(overlay);
    }

    setPenSession(null);
  }, [
    activeLayer,
    activeLayerId,
    colorMode,
    dimensions.height,
    dimensions.width,
    flushPendingHistoryTasks,
    isLayerEffectivelyVisible,
    pushHistoryStep,
    selection,
    showToast,
    updateLayerThumbnail,
  ]);

  // Sync lightweight pen session metadata & action callbacks for ToolPropertyInspector
  useEffect(() => {
    toolStoreActions.setActivePenSessionMeta(
      penSession?.knots.length ?? 0,
      Boolean(penSession?.closed),
      penSession?.selectedAnchorIndex ?? null
    );
  }, [penSession?.knots.length, penSession?.closed, penSession?.selectedAnchorIndex]);

  useEffect(() => {
    interactiveToolBridge.commitPenPath = handleCommitPenPath;
    interactiveToolBridge.cancelPenPath = handleCancelPenPath;
    interactiveToolBridge.toggleClosePenPath = handleClosePenPath;
    interactiveToolBridge.deleteSelectedPenAnchor = handleDeleteSelectedAnchor;
    interactiveToolBridge.toggleSelectedPenAnchorSmooth = handleToggleSelectedAnchorSmooth;
    return () => {
      interactiveToolBridge.commitPenPath = undefined;
      interactiveToolBridge.cancelPenPath = undefined;
      interactiveToolBridge.toggleClosePenPath = undefined;
      interactiveToolBridge.deleteSelectedPenAnchor = undefined;
      interactiveToolBridge.toggleSelectedPenAnchorSmooth = undefined;
    };
  }, [
    handleCancelPenPath,
    handleClosePenPath,
    handleCommitPenPath,
    handleDeleteSelectedAnchor,
    handleToggleSelectedAnchorSmooth,
  ]);

  // Clear uncommitted path when switching away from pen tool
  useEffect(() => {
    let prevTool = useToolStore.getState().tool;
    return useToolStore.subscribe(() => {
      const curTool = useToolStore.getState().tool;
      if (prevTool === 'pen' && curTool !== 'pen') {
        handleCancelPenPath();
      }
      prevTool = curTool;
    });
  }, [handleCancelPenPath]);

  // Keyboard bindings for active pen path (Enter = commit, Esc = cancel, Backspace/Delete = remove anchor)
  useEffect(() => {
    if (!penSession) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      ) {
        return;
      }
      if (ev.key === 'Enter') {
        ev.preventDefault();
        handleCommitPenPath();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        handleCancelPenPath();
      } else if (ev.key === 'Backspace' || ev.key === 'Delete') {
        ev.preventDefault();
        ev.stopPropagation();
        handleDeleteSelectedAnchor();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [penSession, handleCancelPenPath, handleCommitPenPath, handleDeleteSelectedAnchor]);

  const handlePenPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, pt: Point2D): boolean => {
      const { tool, penSettings } = useToolStore.getState();
      if (tool !== 'pen') return false;
      e.preventDefault();

      if (
        !activeLayer ||
        (activeLayer.type !== 'raster' && activeLayer.type !== 'vector') ||
        activeLayer.locked ||
        !isLayerEffectivelyVisible(activeLayer)
      ) {
        showToast?.('Select an unlocked, visible Raster or Vector layer to use the Pen Tool');
        return true;
      }

      try {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture errors
      }

      const invZoom = 1 / Math.max(0.1, zoomRef.current || 1);
      const hitRadius = 11 * invZoom;
      const session = penSessionRef.current;
      const isEditInteraction = penSettings.mode === 'edit' || e.ctrlKey || e.metaKey;

      // 1. Check handle & anchor hits in edit mode (or Ctrl+click override)
      if (session && isEditInteraction) {
        // Test handles first so overlapping handles take priority when selected
        for (let i = 0; i < session.knots.length; i++) {
          const k = session.knots[i];
          if (k.handleIn && Math.hypot(k.handleIn.x - pt.x, k.handleIn.y - pt.y) <= hitRadius) {
            dragRef.current = { kind: 'move-handle', anchorIndex: i, which: 'in' };
            setPenSession((prev) => (prev ? { ...prev, selectedAnchorIndex: i } : prev));
            return true;
          }
          if (k.handleOut && Math.hypot(k.handleOut.x - pt.x, k.handleOut.y - pt.y) <= hitRadius) {
            dragRef.current = { kind: 'move-handle', anchorIndex: i, which: 'out' };
            setPenSession((prev) => (prev ? { ...prev, selectedAnchorIndex: i } : prev));
            return true;
          }
        }

        // Test anchors
        for (let i = 0; i < session.knots.length; i++) {
          const k = session.knots[i];
          if (Math.hypot(k.x - pt.x, k.y - pt.y) <= hitRadius) {
            if (e.altKey) {
              setPenSession((prev) =>
                prev
                  ? {
                      ...prev,
                      knots: toggleBezierAnchorSmooth(prev.knots, i, prev.closed),
                      selectedAnchorIndex: i,
                    }
                  : prev
              );
              return true;
            }
            dragRef.current = { kind: 'move-anchor', anchorIndex: i };
            setPenSession((prev) => (prev ? { ...prev, selectedAnchorIndex: i } : prev));
            return true;
          }
        }

        // Test curve segment hit -> exact de Casteljau anchor insertion
        if (session.knots.length >= 2) {
          const closest = findClosestPointOnBezierPath(session.knots, pt, session.closed);
          if (closest && closest.distance <= hitRadius) {
            const { knots: nextKnots, insertedIndex } = insertBezierAnchorAt(
              session.knots,
              closest.segmentIndex,
              closest.t,
              session.closed
            );
            if (insertedIndex >= 0) {
              setPenSession((prev) =>
                prev
                  ? {
                      ...prev,
                      knots: nextKnots,
                      selectedAnchorIndex: insertedIndex,
                    }
                  : prev
              );
              dragRef.current = { kind: 'move-anchor', anchorIndex: insertedIndex };
              return true;
            }
          }
        }
        return true;
      }

      // 2. If no active session & in Edit mode on a vector layer, try loading an existing Bézier stroke
      if (!session && penSettings.mode === 'edit' && activeLayer.type === 'vector' && activeLayer.vectorStrokes) {
        let bestStroke: VectorStroke | null = null;
        let bestDist = hitRadius * 1.4;
        for (const st of activeLayer.vectorStrokes) {
          if (st.deleted || st.knots.length < 2) continue;
          const hit = findClosestPointOnBezierPath(st.knots, pt, Boolean(st.closed));
          if (hit && hit.distance < bestDist) {
            bestDist = hit.distance;
            bestStroke = st;
          }
        }
        if (bestStroke) {
          setPenSession({
            editingStrokeId: bestStroke.id,
            knots: bestStroke.knots.map((k) => ({
              ...k,
              handleIn: k.handleIn ? { ...k.handleIn } : null,
              handleOut: k.handleOut ? { ...k.handleOut } : null,
            })),
            closed: Boolean(bestStroke.closed),
            selectedAnchorIndex: 0,
            hoverPoint: pt,
          });
          showToast?.('Loaded vector path for Bézier editing');
          return true;
        }
        showToast?.('Click a vector path to edit, or switch to Draw mode to plot a new Bézier path');
        return true;
      }

      // 3. Draw mode: double-click finishes open path cleanly
      const now = Date.now();
      const isDoubleClick =
        session &&
        session.knots.length >= 2 &&
        now - lastClickRef.current.time < 300 &&
        Math.hypot(pt.x - lastClickRef.current.x, pt.y - lastClickRef.current.y) <= hitRadius * 1.5;
      lastClickRef.current = { time: now, x: pt.x, y: pt.y };

      if (isDoubleClick) {
        handleCommitPenPath();
        return true;
      }

      // Closing path by clicking on first anchor
      if (session && !session.closed && session.knots.length >= 2) {
        const first = session.knots[0];
        if (Math.hypot(first.x - pt.x, first.y - pt.y) <= hitRadius) {
          setPenSession((prev) =>
            prev ? { ...prev, closed: true, selectedAnchorIndex: 0 } : prev
          );
          dragRef.current = { kind: 'placing-handle', anchorIndex: 0, origin: { x: first.x, y: first.y } };
          return true;
        }
      }

      // Append a new anchor knot
      const newKnot: VectorKnot = {
        x: pt.x,
        y: pt.y,
        pressure: 1,
        width: Math.max(0.5, penSettings.strokeWidth || 4),
        timestamp: now,
        handleIn: null,
        handleOut: null,
        handleType: 'corner',
      };

      const nextIndex = session ? session.knots.length : 0;
      setPenSession((prev) =>
        prev
          ? {
              ...prev,
              knots: [...prev.knots, newKnot],
              selectedAnchorIndex: nextIndex,
              hoverPoint: pt,
            }
          : {
              editingStrokeId: null,
              knots: [newKnot],
              closed: false,
              selectedAnchorIndex: 0,
              hoverPoint: pt,
            }
      );
      dragRef.current = { kind: 'placing-handle', anchorIndex: nextIndex, origin: { x: pt.x, y: pt.y } };
      return true;
    },
    [activeLayer, handleCommitPenPath, isLayerEffectivelyVisible, showToast, zoomRef]
  );

  const handlePenPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>): boolean => {
      const { tool } = useToolStore.getState();
      if (tool !== 'pen') return false;

      const pt = getCanvasCoords(e);
      const drag = dragRef.current;

      if (!drag) {
        if (penSessionRef.current) {
          setPenSession((prev) => (prev ? { ...prev, hoverPoint: pt } : prev));
        }
        return true;
      }

      if (drag.kind === 'placing-handle') {
        const dist = Math.hypot(pt.x - drag.origin.x, pt.y - drag.origin.y);
        if (dist > 2) {
          const breakSym = e.altKey;
          setPenSession((prev) => {
            if (!prev || drag.anchorIndex >= prev.knots.length) return prev;
            const nextKnots = prev.knots.map((k, idx) => {
              if (idx !== drag.anchorIndex) return k;
              const dx = pt.x - k.x;
              const dy = pt.y - k.y;
              return {
                ...k,
                handleType: breakSym ? ('corner' as const) : ('symmetric' as const),
                handleOut: { x: pt.x, y: pt.y },
                handleIn: breakSym ? k.handleIn ?? null : { x: k.x - dx, y: k.y - dy },
              };
            });
            return { ...prev, knots: nextKnots, hoverPoint: pt };
          });
        }
        return true;
      }

      if (drag.kind === 'move-anchor') {
        setPenSession((prev) => {
          if (!prev || drag.anchorIndex >= prev.knots.length) return prev;
          const nextKnots = prev.knots.map((k, idx) =>
            idx === drag.anchorIndex ? moveBezierAnchor(k, pt) : k
          );
          return { ...prev, knots: nextKnots, hoverPoint: pt };
        });
        return true;
      }

      if (drag.kind === 'move-handle') {
        const breakSym = e.altKey;
        setPenSession((prev) => {
          if (!prev || drag.anchorIndex >= prev.knots.length) return prev;
          const nextKnots = prev.knots.map((k, idx) =>
            idx === drag.anchorIndex ? moveBezierHandle(k, drag.which, pt, breakSym) : k
          );
          return { ...prev, knots: nextKnots, hoverPoint: pt };
        });
        return true;
      }

      return true;
    },
    [getCanvasCoords]
  );

  const handlePenPointerUp = useCallback((e: React.PointerEvent<HTMLElement>): boolean => {
    const { tool } = useToolStore.getState();
    if (tool !== 'pen' && !dragRef.current) return false;

    try {
      if ((e.target as HTMLElement).hasPointerCapture?.(e.pointerId)) {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore capture errors
    }

    dragRef.current = null;
    return true;
  }, []);

  return {
    penSession,
    setPenSession,
    handleCommitPenPath,
    handleCancelPenPath,
    handleClosePenPath,
    handleDeleteSelectedAnchor,
    handleToggleSelectedAnchorSmooth,
    handlePenPointerDown,
    handlePenPointerMove,
    handlePenPointerUp,
  };
}
