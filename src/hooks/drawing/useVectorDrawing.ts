import React, { useRef, useCallback } from 'react';
import {
  BrushSettings,
  CanvasColorMode,
  CanvasDimensions,
  LayerItem,
  Point,
  VectorKnot,
  VectorStroke,
} from '../../types/editor';
import { SparseTileGrid, releaseTemporaryCanvas } from '../../utils/tileEngine';
import { documentStore } from '../../utils/documentStore';
import { multiplayerService } from '../../services/multiplayerService';
import {
  applyVectorEraser,
  computeStrokeBounds,
  modifyStrokeWidth,
  pinchVectorStroke,
  renderVectorLayer,
  renderVectorStroke,
  simplifyPathPoints,
  simplifyVectorStroke,
} from '../../utils/vectorEngine';
import { get2DContext } from '../../utils/canvasUtils';
import { useToolStore } from '../../stores';
import { PushHistoryStepFn } from './types';

export interface CommitVectorStrokeArgs {
  activeLayer: LayerItem;
  currentLayerId: string;
  allPoints: Point[];
  bs: BrushSettings;
  isEraser: boolean;
  isPencil: boolean;
  isMonochrome: boolean;
  strokeColor: string;
  dims: CanvasDimensions;
  grid: SparseTileGrid;
  mergedDirty: { minX: number; minY: number; maxX: number; maxY: number } | null;
  strokeId: string | null;
  pushHistoryStep: PushHistoryStepFn;
}

export function commitVectorStrokeOrErase({
  activeLayer,
  currentLayerId,
  allPoints,
  bs,
  isEraser,
  isPencil,
  isMonochrome,
  strokeColor,
  dims,
  grid,
  mergedDirty,
  strokeId,
  pushHistoryStep,
}: CommitVectorStrokeArgs): VectorStroke | undefined {
  const knots: VectorKnot[] = allPoints.map((pt, idx) => ({
    x: pt.x,
    y: pt.y,
    pressure: pt.pressure,
    width: pt.width || Math.max(0.5, (bs.size || 10) * pt.pressure),
    timestamp: Date.now() + idx,
  }));
  const prevStrokes = [...(activeLayer.vectorStrokes || [])];

  if (isEraser) {
    const eraserRadius = Math.max(1, (bs.size || 10) * 0.5);
    const eraserPath = allPoints.map((p) => ({ x: p.x, y: p.y }));
    const eraserResult = applyVectorEraser(
      eraserPath,
      eraserRadius,
      prevStrokes,
      'intersection'
    );
    const updatedStrokes = eraserResult.updatedStrokes;
    activeLayer.vectorStrokes = updatedStrokes;

    let minX = mergedDirty ? mergedDirty.minX : 0;
    let minY = mergedDirty ? mergedDirty.minY : 0;
    let maxX = mergedDirty ? mergedDirty.maxX : dims.width;
    let maxY = mergedDirty ? mergedDirty.maxY : dims.height;
    for (const st of prevStrokes) {
      if (st.bounds) {
        minX = Math.min(minX, st.bounds.minX);
        minY = Math.min(minY, st.bounds.minY);
        maxX = Math.max(maxX, st.bounds.maxX);
        maxY = Math.max(maxY, st.bounds.maxY);
      }
    }
    const vPad = Math.ceil(Math.max(16, bs.size || 10));
    const vx = Math.max(0, Math.floor(minX - vPad));
    const vy = Math.max(0, Math.floor(minY - vPad));
    const vw = Math.max(0, Math.min(dims.width, Math.ceil(maxX + vPad)) - vx);
    const vh = Math.max(0, Math.min(dims.height, Math.ceil(maxY + vPad)) - vy);

    if (vw > 0 && vh > 0) {
      const tempVec = document.createElement('canvas');
      tempVec.width = vw;
      tempVec.height = vh;
      const vCtx = get2DContext(tempVec);
      if (vCtx) {
        vCtx.save();
        vCtx.translate(-vx, -vy);
        renderVectorLayer(vCtx, updatedStrokes);
        vCtx.restore();
        const subData = vCtx.getImageData(0, 0, vw, vh);
        grid.writeImageData(
          currentLayerId,
          subData,
          vx,
          vy,
          isMonochrome ? 'monochrome-1bit' : 'color-32bit'
        );
      }
      releaseTemporaryCanvas(tempVec);
    }

    pushHistoryStep(
      'eraser',
      'Vector Eraser',
      null,
      null,
      currentLayerId,
      vw > 0 && vh > 0
        ? { x: vx, y: vy, width: vw, height: vh }
        : { x: 0, y: 0, width: dims.width, height: dims.height },
      undefined,
      { before: prevStrokes, after: updatedStrokes },
      undefined,
      strokeId || undefined
    );
    if (multiplayerService.isConnected()) {
      multiplayerService.sendLayerUpdate(currentLayerId, { vectorStrokes: updatedStrokes });
    }
    return undefined;
  }

  const simplifiedKnots = simplifyPathPoints(knots, 0.5);
  const strokeKnots = simplifiedKnots.length >= 2 ? simplifiedKnots : knots;
  const bounds = computeStrokeBounds(strokeKnots);
  const newStroke: VectorStroke = {
    id: strokeId || `vec-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    layerId: currentLayerId,
    tool: isPencil ? 'pencil' : 'brush',
    knots: strokeKnots,
    color: strokeColor,
    baseWidth: bs.size || 10,
    opacity: bs.opacity ?? 1.0,
    bounds,
  };

  const updatedStrokes = [...prevStrokes, newStroke];
  activeLayer.vectorStrokes = updatedStrokes;

  const vPad = Math.ceil(Math.max(16, bs.size || 10));
  const vx = Math.max(0, Math.floor(bounds.minX - vPad));
  const vy = Math.max(0, Math.floor(bounds.minY - vPad));
  const vw = Math.max(0, Math.min(dims.width, Math.ceil(bounds.maxX + vPad)) - vx);
  const vh = Math.max(0, Math.min(dims.height, Math.ceil(bounds.maxY + vPad)) - vy);

  if (vw > 0 && vh > 0) {
    const tempVec = grid.createRegionCanvas(currentLayerId, {
      x: vx,
      y: vy,
      width: vw,
      height: vh,
    });
    const vCtx = tempVec ? get2DContext(tempVec) : null;
    if (tempVec && vCtx) {
      vCtx.save();
      vCtx.translate(-vx, -vy);
      renderVectorStroke(vCtx, newStroke);
      vCtx.restore();
      const subData = vCtx.getImageData(0, 0, vw, vh);
      grid.writeImageData(
        currentLayerId,
        subData,
        vx,
        vy,
        isMonochrome ? 'monochrome-1bit' : 'color-32bit'
      );
    }
    releaseTemporaryCanvas(tempVec);
  }

  pushHistoryStep(
    isPencil ? 'pencil' : 'brush',
    bs.brushName || (isPencil ? 'Vector Pencil' : 'Vector Pen'),
    null,
    null,
    currentLayerId,
    vw > 0 && vh > 0
      ? { x: vx, y: vy, width: vw, height: vh }
      : { x: 0, y: 0, width: dims.width, height: dims.height },
    undefined,
    { before: prevStrokes, after: updatedStrokes },
    undefined,
    strokeId || undefined
  );

  return newStroke;
}

export interface UseVectorDrawingParams {
  activeLayer: LayerItem | undefined;
  activeLayerId: string;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  getCanvasCoords: (e: React.PointerEvent<HTMLElement> | PointerEvent) => { x: number; y: number };
  updateLayerThumbnail: (layerId: string, immediate?: boolean) => void;
  pushHistoryStep: PushHistoryStepFn;
  showToast: (msg: string) => void;
}

export interface UseVectorDrawingResult {
  commitVectorStrokeOrErase: typeof commitVectorStrokeOrErase;
  handleVectorEditPointerDown: (e: React.PointerEvent<HTMLElement>, pt: { x: number; y: number }) => boolean;
  handleVectorEditPointerMove: (e: React.PointerEvent<HTMLElement>) => boolean;
  handleVectorEditPointerUp: () => boolean;
}

export function useVectorDrawing({
  activeLayer,
  activeLayerId,
  dimensions,
  colorMode,
  getCanvasCoords,
  updateLayerThumbnail,
  pushHistoryStep,
  showToast,
}: UseVectorDrawingParams): UseVectorDrawingResult {
  const isVectorEditingRef = useRef<boolean>(false);
  const lastVectorEditPtRef = useRef<{ x: number; y: number } | null>(null);
  const vectorEditBeforeStrokesRef = useRef<VectorStroke[] | null>(null);

  const handleVectorEditPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, pt: { x: number; y: number }): boolean => {
      e.preventDefault();
      if (!activeLayer || activeLayer.type !== 'vector' || !activeLayer.vectorStrokes) {
        showToast('Select a Vector Layer to use Correct Line tools');
        return true;
      }
      isVectorEditingRef.current = true;
      lastVectorEditPtRef.current = pt;
      vectorEditBeforeStrokesRef.current = JSON.parse(
        JSON.stringify(activeLayer.vectorStrokes)
      ) as VectorStroke[];
      return true;
    },
    [activeLayer, showToast]
  );

  const handleVectorEditPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>): boolean => {
      if (!isVectorEditingRef.current || !activeLayer?.vectorStrokes) return true;
      const pt = getCanvasCoords(e);
      const lastPt = lastVectorEditPtRef.current || pt;
      const delta = { x: pt.x - lastPt.x, y: pt.y - lastPt.y };
      lastVectorEditPtRef.current = pt;

      const vectorEditSettings = useToolStore.getState().vectorEditSettings;
      const radius = vectorEditSettings.radius || 35;
      let updated = false;
      let dirtyMinX = Infinity;
      let dirtyMinY = Infinity;
      let dirtyMaxX = -Infinity;
      let dirtyMaxY = -Infinity;

      const expandDirty = (st: VectorStroke) => {
        if (!st.bounds) return;
        const pad = Math.ceil(Math.max(16, (st.baseWidth || 10) * 1.5));
        if (st.bounds.minX - pad < dirtyMinX) dirtyMinX = st.bounds.minX - pad;
        if (st.bounds.minY - pad < dirtyMinY) dirtyMinY = st.bounds.minY - pad;
        if (st.bounds.maxX + pad > dirtyMaxX) dirtyMaxX = st.bounds.maxX + pad;
        if (st.bounds.maxY + pad > dirtyMaxY) dirtyMaxY = st.bounds.maxY + pad;
      };

      const newStrokes = activeLayer.vectorStrokes.map((stroke) => {
        if (stroke.deleted) return stroke;
        if (
          pt.x < stroke.bounds.minX - radius ||
          pt.x > stroke.bounds.maxX + radius ||
          pt.y < stroke.bounds.minY - radius ||
          pt.y > stroke.bounds.maxY + radius
        ) {
          return stroke;
        }

        let nextStroke = stroke;
        if (vectorEditSettings.mode === 'pinch') {
          if (Math.hypot(delta.x, delta.y) > 0.05) {
            updated = true;
            nextStroke = pinchVectorStroke(stroke, pt, radius, delta);
          }
        } else if (vectorEditSettings.mode === 'width') {
          updated = true;
          nextStroke = modifyStrokeWidth(stroke, pt, radius, vectorEditSettings.widthFactor);
        } else if (vectorEditSettings.mode === 'simplify') {
          updated = true;
          nextStroke = simplifyVectorStroke(stroke, vectorEditSettings.simplifyTolerance);
        }
        if (nextStroke !== stroke) {
          expandDirty(stroke);
          expandDirty(nextStroke);
        }
        return nextStroke;
      });

      if (updated) {
        activeLayer.vectorStrokes = newStrokes;
        const grid = documentStore.getActiveTileGrid();
        const isMono =
          colorMode === 'monochrome' || activeLayer.expressionColor === 'monochrome';
        const targetFormat = isMono ? 'monochrome-1bit' : 'color-32bit';

        const vx = Math.max(0, Math.floor(dirtyMinX));
        const vy = Math.max(0, Math.floor(dirtyMinY));
        const vx1 = Math.min(dimensions.width, Math.ceil(dirtyMaxX));
        const vy1 = Math.min(dimensions.height, Math.ceil(dirtyMaxY));
        const vw = vx1 - vx;
        const vh = vy1 - vy;

        if (vw > 0 && vh > 0) {
          const temp = document.createElement('canvas');
          temp.width = vw;
          temp.height = vh;
          const ctx = get2DContext(temp);
          if (ctx) {
            ctx.save();
            ctx.translate(-vx, -vy);
            renderVectorLayer(ctx, newStrokes);
            ctx.restore();
            const subData = ctx.getImageData(0, 0, vw, vh);
            grid.writeImageData(activeLayerId, subData, vx, vy, targetFormat);
          }
          releaseTemporaryCanvas(temp);
          grid.notifyChange(true);
          updateLayerThumbnail(activeLayerId, true);
        }
      }
      return true;
    },
    [
      activeLayer,
      activeLayerId,
      colorMode,
      dimensions.height,
      dimensions.width,
      getCanvasCoords,
      updateLayerThumbnail,
    ]
  );

  const handleVectorEditPointerUp = useCallback((): boolean => {
    if (!isVectorEditingRef.current) return false;
    isVectorEditingRef.current = false;
    const vectorEditSettings = useToolStore.getState().vectorEditSettings;
    if (activeLayer?.vectorStrokes && vectorEditBeforeStrokesRef.current) {
      const updatedStrokes = [...activeLayer.vectorStrokes];
      pushHistoryStep(
        'brush',
        `Correct Line (${vectorEditSettings.mode})`,
        null,
        null,
        activeLayerId,
        undefined,
        undefined,
        {
          before: vectorEditBeforeStrokesRef.current,
          after: updatedStrokes,
        }
      );
      if (multiplayerService.isConnected()) {
        multiplayerService.sendLayerUpdate(activeLayerId, { vectorStrokes: updatedStrokes });
      }
      documentStore.getActiveTileGrid().notifyChange(true);
    }
    vectorEditBeforeStrokesRef.current = null;
    return true;
  }, [activeLayer, activeLayerId, pushHistoryStep]);

  return {
    commitVectorStrokeOrErase,
    handleVectorEditPointerDown,
    handleVectorEditPointerMove,
    handleVectorEditPointerUp,
  };
}
