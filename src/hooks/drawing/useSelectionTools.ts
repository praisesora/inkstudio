import React, { useState, useRef, useCallback } from 'react';
import {
  BlendMode,
  CanvasColorMode,
  CanvasDimensions,
  CanvasSelection,
  DirtyRect,
  LayerItem,
  LayerTreeDelta,
  TileDelta,
  TransformSession,
} from '../../types/editor';
import { documentStore } from '../../utils/documentStore';
import {
  SparseTileGrid,
  TileFormat,
  TileSnapshotEntry,
  releaseTemporaryCanvas,
} from '../../utils/tileEngine';
import {
  isPointInSelection,
  computePolygonBounds,
  floodSelectWandOnTileGrid,
  clearSelectionInTileGrid,
  clearOutsideSelectionInTileGrid,
  extractSelectionTileSnapshot,
  fillSelectionInTileGrid,
  liftSelectionFromTileGrid,
  commitFloatingSelectionToTileGrid,
  expandSelection,
  contractSelection,
  featherSelection,
  invertSelection,
  selectionToMask,
  maskToBounds,
  maskToSvgPath,
  SelectionTileSnapshot,
} from '../../utils/selectionUtils';
import {
  renderPerspectiveQuad,
  renderMeshWarp,
  createDefaultPerspectiveQuad,
  createDefaultMeshPoints,
  computeMeshSubdivisions,
  getMeshSurfaceBounds,
  resolveTransformTargetLayers,
  getTransformPreviewLayerState,
  extractCanvasPixelBuffer,
  processAffineTransformChunks,
  processPerspectiveTransformChunks,
  processMeshWarpTransformChunks,
  type PixelBuffer,
} from '../../utils/transformEngine';
import { get2DContext, getCanvasCompositeOperation } from '../../utils/canvasUtils';
import { useToolStore, toolStoreActions } from '../../stores';
import { PushHistoryStepFn } from './types';

function computeTransformDestRect(
  session: TransformSession,
  docW: number,
  docH: number
): DirtyRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const includePt = (px: number, py: number) => {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  };

  if (session.mode === 'perspective' && session.perspectiveQuad) {
    for (const p of session.perspectiveQuad) includePt(p.x, p.y);
  } else if (session.mode === 'mesh' && session.meshPoints) {
    const sb = getMeshSurfaceBounds(session.meshPoints, 6);
    includePt(sb.minX, sb.minY);
    includePt(sb.maxX, sb.maxY);
  } else {
    const cx = session.x + session.width / 2;
    const cy = session.y + session.height / 2;
    const rad = (session.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const hw = session.width / 2;
    const hh = session.height / 2;
    const corners: [number, number][] = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
    for (const [lx, ly] of corners) {
      includePt(cx + lx * cos - ly * sin, cy + lx * sin + ly * cos);
    }
  }

  const x0 = Math.max(0, Math.floor(minX - 2));
  const y0 = Math.max(0, Math.floor(minY - 2));
  const x1 = Math.min(docW, Math.ceil(maxX + 2));
  const y1 = Math.min(docH, Math.ceil(maxY + 2));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function compositeTransformedIntoTileGrid(
  grid: SparseTileGrid,
  layerId: string,
  sourceCanvas: HTMLCanvasElement,
  sourcePixels: PixelBuffer | undefined,
  session: TransformSession,
  dimensions: CanvasDimensions,
  targetFormat: TileFormat,
  beforeSnapshot: Map<string, TileSnapshotEntry>,
  monochromeOpts?: {
    threshold: number;
    expressBlack: boolean;
    expressWhite: boolean;
  }
): DirtyRect | null {
  const destRect = computeTransformDestRect(session, dimensions.width, dimensions.height);
  if (!destRect) return null;

  const CHUNK = 1024;
  const commitChunk = (
    chunkData: Uint8ClampedArray,
    cx: number,
    cy: number,
    cw: number,
    ch: number
  ) => {
    grid.compositeStrokeToTiles({
      layerId,
      strokeData: { data: chunkData, width: cw, height: ch },
      destX: cx,
      destY: cy,
      format: targetFormat,
      compositeOp: 'source-over',
      opacity: 1.0,
      monochrome: monochromeOpts,
      snapshotOut: beforeSnapshot,
      suppressNotify: true,
    });
  };

  const resolvedPixels = sourcePixels ?? extractCanvasPixelBuffer(sourceCanvas);

  if (resolvedPixels) {
    if (session.mode === 'perspective' && session.perspectiveQuad) {
      if (
        processPerspectiveTransformChunks(
          resolvedPixels,
          session.perspectiveQuad,
          destRect,
          CHUNK,
          32,
          commitChunk
        )
      ) {
        return destRect;
      }
    } else if (session.mode === 'mesh' && session.meshPoints) {
      const subPerCell = computeMeshSubdivisions(
        resolvedPixels.width,
        resolvedPixels.height,
        session.meshPoints,
        true
      );
      if (
        processMeshWarpTransformChunks(
          resolvedPixels,
          session.meshPoints,
          destRect,
          CHUNK,
          subPerCell,
          commitChunk
        )
      ) {
        return destRect;
      }
    } else {
      processAffineTransformChunks(
        resolvedPixels,
        {
          x: session.x,
          y: session.y,
          width: session.width,
          height: session.height,
          rotation: session.rotation,
          flipH: session.flipH,
          flipV: session.flipV,
        },
        destRect,
        CHUNK,
        commitChunk
      );
      return destRect;
    }
  }

  // Fallback path (e.g. Mesh Warp when WebGL2 is unavailable)
  const chunkCanvas = document.createElement('canvas');
  chunkCanvas.width = Math.min(CHUNK, destRect.width);
  chunkCanvas.height = Math.min(CHUNK, destRect.height);
  const cCtx = get2DContext(chunkCanvas);
  if (!cCtx) {
    releaseTemporaryCanvas(chunkCanvas);
    return null;
  }

  try {
    const x1 = destRect.x + destRect.width;
    const y1 = destRect.y + destRect.height;

    for (let cy = destRect.y; cy < y1; cy += CHUNK) {
      const ch = Math.min(CHUNK, y1 - cy);
      for (let cx = destRect.x; cx < x1; cx += CHUNK) {
        const cw = Math.min(CHUNK, x1 - cx);
        if (chunkCanvas.width !== cw) chunkCanvas.width = cw;
        if (chunkCanvas.height !== ch) chunkCanvas.height = ch;

        cCtx.setTransform(1, 0, 0, 1, 0, 0);
        cCtx.clearRect(0, 0, cw, ch);
        cCtx.save();
        cCtx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in cCtx) {
          cCtx.imageSmoothingQuality = 'high';
        }
        cCtx.translate(-cx, -cy);

        if (session.mode === 'perspective' && session.perspectiveQuad) {
          renderPerspectiveQuad(cCtx, sourceCanvas, session.perspectiveQuad, 32);
        } else if (session.mode === 'mesh' && session.meshPoints) {
          const subPerCell = computeMeshSubdivisions(
            sourceCanvas.width,
            sourceCanvas.height,
            session.meshPoints,
            true
          );
          renderMeshWarp(cCtx, sourceCanvas, session.meshPoints, subPerCell);
        } else {
          const midX = session.x + session.width / 2;
          const midY = session.y + session.height / 2;
          cCtx.translate(midX, midY);
          cCtx.rotate((session.rotation * Math.PI) / 180);
          cCtx.scale(session.flipH ? -1 : 1, session.flipV ? -1 : 1);
          cCtx.drawImage(
            sourceCanvas,
            -session.width / 2,
            -session.height / 2,
            session.width,
            session.height
          );
        }
        cCtx.restore();

        const img = cCtx.getImageData(0, 0, cw, ch);
        commitChunk(img.data, cx, cy, cw, ch);
      }
    }
  } finally {
    releaseTemporaryCanvas(chunkCanvas);
  }

  return destRect;
}

export interface UseSelectionToolsParams {
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  activeLayer: LayerItem | undefined;
  activeLayerId: string;
  selectedLayerIds: string[];
  tileGrid?: SparseTileGrid;
  flushPendingHistoryTasks?: () => void;
  updateLayerThumbnail: (layerId: string, immediate?: boolean) => void;
  pushHistoryStep: PushHistoryStepFn;
  showToast: (msg: string) => void;
  copySelectionToClipboard?: (
    selection: CanvasSelection,
    targetId?: string
  ) => { copied: boolean; empty?: boolean; layerName?: string; snapshot?: SelectionTileSnapshot };
  createLayerFromTileSnapshot?: (
    tileSnapshot: {
      format: TileFormat;
      tiles: Array<{ tileX: number; tileY: number; format: TileFormat; data: Uint8Array }>;
    },
    layerName: string,
    blendMode?: BlendMode,
    opacity?: number,
    layerOverrides?: Partial<LayerItem>
  ) => { id: string; name: string; tileDeltas: TileDelta[]; layerTreeDelta?: LayerTreeDelta };
}

export interface UseSelectionToolsResult {
  selection: CanvasSelection | null;
  setSelection: React.Dispatch<React.SetStateAction<CanvasSelection | null>>;
  transformSession: TransformSession | null;
  setTransformSession: React.Dispatch<React.SetStateAction<TransformSession | null>>;
  isSelectionPenDrawingRef: React.MutableRefObject<boolean>;
  handleCommitFloatingSelection: () => void;
  handleDeselect: () => void;
  handleClearSelection: () => void;
  handleDeleteOutsideSelection: () => void;
  handleCopySelection: () => void;
  handleCutSelection: () => void;
  handleMoveSelectionToNewLayer: () => void;
  handleCopySelectionToNewLayer: () => void;
  handleFillSelectionColor: () => void;
  handleExpandSelection: (pixels?: number) => void;
  handleContractSelection: (pixels?: number) => void;
  handleFeatherSelection: (radius?: number) => void;
  handleInvertSelection: () => void;
  handleSelectAll: () => void;
  handleStartTransform: () => void;
  handleApplyTransform: () => void;
  handleCancelTransform: () => void;
  handleSelectionPointerDown: (
    e: React.PointerEvent<HTMLElement>,
    pt: { x: number; y: number }
  ) => boolean;
  handleSelectionPointerMove: (pt: { x: number; y: number }) => boolean;
  handleSelectionPointerUp: (pt: { x: number; y: number }, e?: React.PointerEvent<HTMLElement>) => boolean;
}

export function useSelectionTools({
  dimensions,
  colorMode,
  layers,
  activeLayer,
  activeLayerId,
  selectedLayerIds,
  tileGrid,
  flushPendingHistoryTasks,
  updateLayerThumbnail,
  pushHistoryStep,
  showToast,
  copySelectionToClipboard,
  createLayerFromTileSnapshot,
}: UseSelectionToolsParams): UseSelectionToolsResult {
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [transformSession, setTransformSession] = useState<TransformSession | null>(null);

  const getGrid = useCallback(
    () => tileGrid ?? documentStore.getActiveTileGrid(),
    [tileGrid]
  );

  const resolveLayerFormat = useCallback(
    (layerId: string): TileFormat => {
      const isBg = layerId === 'layer-bg' || layerId.startsWith('layer-bg');
      if (isBg) return 'color-32bit';
      const lyr = layers.find((l) => l.id === layerId);
      if (colorMode === 'monochrome' || lyr?.expressionColor === 'monochrome') {
        return 'monochrome-1bit';
      }
      return 'color-32bit';
    },
    [colorMode, layers]
  );

  const selectionMaskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isSelectionPenDrawingRef = useRef<boolean>(false);
  const selectionPenDrawingRef = useRef<{
    isDrawing: boolean;
    lastPt: { x: number; y: number };
    maskCanvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    lastPreviewTs: number;
  } | null>(null);

  const selectionDragRef = useRef<{
    isDragging: boolean;
    startX: number;
    startY: number;
    origFloatingX: number;
    origFloatingY: number;
    origBoundsX: number;
    origBoundsY: number;
  } | null>(null);

  const selectRectStartRef = useRef<{ x: number; y: number } | null>(null);
  const lassoPointsRef = useRef<Array<{ x: number; y: number }>>([]);

  const handleCommitFloatingSelection = useCallback(() => {
    if (!selection?.floating) return;
    const targetLayerId = selection.floating.layerId || activeLayerId;
    const grid = getGrid();
    const targetFormat = resolveLayerFormat(targetLayerId);

    const { dirtyRect, tileDeltas } = commitFloatingSelectionToTileGrid({
      grid,
      layerId: targetLayerId,
      dimensions,
      floating: selection.floating,
      targetFormat,
    });

    releaseTemporaryCanvas(selection.floating.canvas);

    if (tileDeltas.length > 0) {
      pushHistoryStep(
        'selection-move',
        'Move Selection',
        null,
        null,
        targetLayerId,
        dirtyRect,
        tileDeltas
      );
    }

    updateLayerThumbnail(targetLayerId, true);
    setSelection((prev) => (prev ? { ...prev, floating: null } : null));
  }, [
    selection,
    activeLayerId,
    dimensions,
    getGrid,
    resolveLayerFormat,
    pushHistoryStep,
    updateLayerThumbnail,
  ]);

  const handleDeselect = useCallback(() => {
    if (selection?.floating) {
      handleCommitFloatingSelection();
    }
    setSelection(null);
  }, [selection, handleCommitFloatingSelection]);

  const handleClearSelection = useCallback(() => {
    if (!selection) return;
    if (!activeLayer || activeLayer.type !== 'raster' || activeLayer.locked) {
      showToast('Select an unlocked raster layer');
      return;
    }
    flushPendingHistoryTasks?.();
    const grid = getGrid();

    if (selection.floating) {
      const targetLayerId = selection.floating.layerId || activeLayerId;
      if (selection.floating.beforeTileSnapshot) {
        const tileDeltas = grid.computeDeltasFromSnapshot(
          selection.floating.beforeTileSnapshot,
          targetLayerId
        );
        if (tileDeltas.length > 0) {
          pushHistoryStep(
            'clear',
            'Delete Selection',
            null,
            null,
            targetLayerId,
            selection.bounds,
            tileDeltas
          );
        }
      }
      releaseTemporaryCanvas(selection.floating.canvas);
      grid.notifyChange(true);
      updateLayerThumbnail(targetLayerId, true);
      setSelection(null);
      return;
    }

    const isBg = activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg');
    const targetFormat = resolveLayerFormat(activeLayerId);
    const { dirtyRect, tileDeltas } = clearSelectionInTileGrid({
      grid,
      layerId: activeLayerId,
      dimensions,
      selection,
      isBackground: isBg,
      targetFormat,
    });

    if (tileDeltas.length > 0) {
      pushHistoryStep(
        'clear',
        'Delete Selection',
        null,
        null,
        activeLayerId,
        dirtyRect ?? undefined,
        tileDeltas
      );
    }
    updateLayerThumbnail(activeLayerId, true);
  }, [
    selection,
    activeLayer,
    showToast,
    flushPendingHistoryTasks,
    getGrid,
    activeLayerId,
    dimensions,
    resolveLayerFormat,
    updateLayerThumbnail,
    pushHistoryStep,
  ]);

  const handleDeleteOutsideSelection = useCallback(() => {
    if (!selection) return;
    if (!activeLayer || activeLayer.type !== 'raster' || activeLayer.locked) {
      showToast('Select an unlocked raster layer');
      return;
    }
    flushPendingHistoryTasks?.();
    const grid = getGrid();
    const targetLayerId = selection.floating?.layerId || activeLayerId;
    const isBg = targetLayerId === 'layer-bg' || targetLayerId.startsWith('layer-bg');
    const targetFormat = resolveLayerFormat(targetLayerId);

    const { dirtyRect, tileDeltas } = clearOutsideSelectionInTileGrid({
      grid,
      layerId: targetLayerId,
      dimensions,
      selection,
      isBackground: isBg,
      targetFormat,
    });

    if (selection.floating) {
      releaseTemporaryCanvas(selection.floating.canvas);
      setSelection((prev) => (prev ? { ...prev, floating: null } : null));
    }

    if (tileDeltas.length > 0) {
      pushHistoryStep(
        'clear',
        'Delete Outside Selection',
        null,
        null,
        targetLayerId,
        dirtyRect ?? undefined,
        tileDeltas
      );
      showToast('Deleted outside selection');
    } else {
      showToast('Nothing outside selection to delete');
    }
    updateLayerThumbnail(targetLayerId, true);
  }, [
    selection,
    activeLayer,
    showToast,
    flushPendingHistoryTasks,
    getGrid,
    activeLayerId,
    resolveLayerFormat,
    dimensions,
    pushHistoryStep,
    updateLayerThumbnail,
  ]);

  const handleCopySelection = useCallback(() => {
    if (!selection) return;
    if (!activeLayer || activeLayer.type !== 'raster') {
      showToast('Select a raster layer to copy selection');
      return;
    }
    if (!copySelectionToClipboard) return;
    const targetLayerId = selection.floating?.layerId || activeLayerId;
    const res = copySelectionToClipboard(selection, targetLayerId);
    if (res.copied) {
      showToast(`Copied selection from "${res.layerName || activeLayer.name}"`);
    } else if (res.empty) {
      showToast('Selected area is empty');
    }
  }, [selection, activeLayer, activeLayerId, copySelectionToClipboard, showToast]);

  const handleCutSelection = useCallback(() => {
    if (!selection) return;
    if (!activeLayer || activeLayer.type !== 'raster' || activeLayer.locked) {
      showToast('Select an unlocked raster layer to cut');
      return;
    }
    if (!copySelectionToClipboard) return;

    flushPendingHistoryTasks?.();
    const targetLayerId = selection.floating?.layerId || activeLayerId;
    const copyRes = copySelectionToClipboard(selection, targetLayerId);
    if (!copyRes.copied) {
      showToast(copyRes.empty ? 'Selected area is empty' : 'Failed to cut selection');
      return;
    }

    const grid = getGrid();
    if (selection.floating) {
      if (selection.floating.beforeTileSnapshot) {
        const tileDeltas = grid.computeDeltasFromSnapshot(
          selection.floating.beforeTileSnapshot,
          targetLayerId
        );
        if (tileDeltas.length > 0) {
          pushHistoryStep(
            'clear',
            'Cut Selection',
            null,
            null,
            targetLayerId,
            selection.bounds,
            tileDeltas
          );
        }
      }
      releaseTemporaryCanvas(selection.floating.canvas);
      grid.notifyChange(true);
      updateLayerThumbnail(targetLayerId, true);
      setSelection(null);
      showToast(`Cut selection from "${activeLayer.name}"`);
      return;
    }

    const isBg = targetLayerId === 'layer-bg' || targetLayerId.startsWith('layer-bg');
    const targetFormat = resolveLayerFormat(targetLayerId);
    const { dirtyRect, tileDeltas } = clearSelectionInTileGrid({
      grid,
      layerId: targetLayerId,
      dimensions,
      selection,
      isBackground: isBg,
      targetFormat,
    });

    if (tileDeltas.length > 0) {
      pushHistoryStep(
        'clear',
        'Cut Selection',
        null,
        null,
        targetLayerId,
        dirtyRect ?? undefined,
        tileDeltas
      );
    }
    updateLayerThumbnail(targetLayerId, true);
    setSelection(null);
    showToast(`Cut selection from "${activeLayer.name}"`);
  }, [
    selection,
    activeLayer,
    activeLayerId,
    copySelectionToClipboard,
    flushPendingHistoryTasks,
    getGrid,
    resolveLayerFormat,
    dimensions,
    pushHistoryStep,
    updateLayerThumbnail,
    showToast,
  ]);

  const handleMoveSelectionToNewLayer = useCallback(() => {
    if (!selection) return;
    if (!activeLayer || activeLayer.type !== 'raster' || activeLayer.locked) {
      showToast('Select an unlocked raster layer');
      return;
    }
    if (!createLayerFromTileSnapshot) return;

    flushPendingHistoryTasks?.();
    const grid = getGrid();
    const targetLayerId = selection.floating?.layerId || activeLayerId;
    const targetFormat = resolveLayerFormat(targetLayerId);
    const snapshot = extractSelectionTileSnapshot({
      grid,
      layerId: targetLayerId,
      dimensions,
      selection,
      targetFormat,
    });

    if (!snapshot || snapshot.tiles.length === 0) {
      showToast('Selected area is empty');
      return;
    }

    let srcDeltas: TileDelta[] = [];
    let dirtyRect: DirtyRect | undefined = snapshot.bounds;

    if (selection.floating) {
      if (selection.floating.beforeTileSnapshot) {
        srcDeltas = grid.computeDeltasFromSnapshot(
          selection.floating.beforeTileSnapshot,
          targetLayerId
        );
      }
      releaseTemporaryCanvas(selection.floating.canvas);
    } else {
      const isBg = targetLayerId === 'layer-bg' || targetLayerId.startsWith('layer-bg');
      const cleared = clearSelectionInTileGrid({
        grid,
        layerId: targetLayerId,
        dimensions,
        selection,
        isBackground: isBg,
        targetFormat,
      });
      srcDeltas = cleared.tileDeltas;
      if (cleared.dirtyRect) dirtyRect = cleared.dirtyRect;
    }

    const overrides = activeLayer.expressionColor
      ? { expressionColor: activeLayer.expressionColor }
      : undefined;
    const created = createLayerFromTileSnapshot(
      snapshot,
      `${activeLayer.name} (Cut)`,
      activeLayer.blendMode,
      activeLayer.opacity,
      overrides
    );

    const combinedDeltas = [...srcDeltas, ...created.tileDeltas];
    if (combinedDeltas.length > 0 || created.layerTreeDelta) {
      pushHistoryStep(
        'selection-move',
        'Move Selection to New Layer',
        null,
        null,
        created.id,
        dirtyRect,
        combinedDeltas,
        undefined,
        undefined,
        undefined,
        false,
        created.layerTreeDelta
      );
    }

    updateLayerThumbnail(targetLayerId, true);
    setSelection(null);
    showToast(`Moved selection to "${created.name}"`);
  }, [
    selection,
    activeLayer,
    activeLayerId,
    createLayerFromTileSnapshot,
    flushPendingHistoryTasks,
    getGrid,
    resolveLayerFormat,
    dimensions,
    pushHistoryStep,
    updateLayerThumbnail,
    showToast,
  ]);

  const handleCopySelectionToNewLayer = useCallback(() => {
    if (!selection) return;
    if (!activeLayer || activeLayer.type !== 'raster') {
      showToast('Select a raster layer');
      return;
    }
    if (!createLayerFromTileSnapshot) return;

    flushPendingHistoryTasks?.();
    const grid = getGrid();
    const targetLayerId = selection.floating?.layerId || activeLayerId;
    const targetFormat = resolveLayerFormat(targetLayerId);
    const snapshot = extractSelectionTileSnapshot({
      grid,
      layerId: targetLayerId,
      dimensions,
      selection,
      targetFormat,
    });

    if (!snapshot || snapshot.tiles.length === 0) {
      showToast('Selected area is empty');
      return;
    }

    const overrides = activeLayer.expressionColor
      ? { expressionColor: activeLayer.expressionColor }
      : undefined;
    const created = createLayerFromTileSnapshot(
      snapshot,
      `${activeLayer.name} (Copy)`,
      activeLayer.blendMode,
      activeLayer.opacity,
      overrides
    );

    if (created.tileDeltas.length > 0 || created.layerTreeDelta) {
      pushHistoryStep(
        'selection-move',
        'Copy Selection to New Layer',
        null,
        null,
        created.id,
        snapshot.bounds,
        created.tileDeltas,
        undefined,
        undefined,
        undefined,
        false,
        created.layerTreeDelta
      );
    }

    if (selection.floating) {
      handleCommitFloatingSelection();
    }
    setSelection(null);
    showToast(`Copied selection to "${created.name}"`);
  }, [
    selection,
    activeLayer,
    activeLayerId,
    createLayerFromTileSnapshot,
    flushPendingHistoryTasks,
    getGrid,
    resolveLayerFormat,
    dimensions,
    pushHistoryStep,
    handleCommitFloatingSelection,
    showToast,
  ]);

  const handleFillSelectionColor = useCallback(() => {
    if (!selection) return;
    if (selection.floating) {
      handleCommitFloatingSelection();
    }
    if (!activeLayer || !activeLayerId) {
      showToast('Select a raster layer to fill');
      return;
    }
    if (activeLayer.type === 'frame-folder') {
      showToast('Select a child layer inside the Frame Border Folder to fill');
      return;
    }
    if (activeLayer.type !== 'raster') {
      showToast('Select a raster layer to fill');
      return;
    }
    if (activeLayer.locked) {
      showToast('Active layer is locked');
      return;
    }
    // Check effective visibility (including ancestor folders)
    let effectivelyVisible = activeLayer.visible;
    let pId = activeLayer.parentId;
    let guard = 0;
    while (effectivelyVisible && pId && guard < 32) {
      const parent = layers.find((l) => l.id === pId);
      if (!parent) break;
      if (!parent.visible) effectivelyVisible = false;
      pId = parent.parentId;
      guard++;
    }
    if (!effectivelyVisible) {
      showToast('Active layer is hidden');
      return;
    }

    const { primaryColor, isTransparentColor } = useToolStore.getState();
    if (isTransparentColor) {
      handleClearSelection();
      return;
    }

    flushPendingHistoryTasks?.();
    const grid = getGrid();
    if (activeLayer.alphaLocked && !grid.hasLayerTiles(activeLayerId)) {
      showToast('Alpha Lock is enabled on an empty layer');
      return;
    }

    const targetFormat = resolveLayerFormat(activeLayerId);

    const { dirtyRect, tileDeltas } = fillSelectionInTileGrid({
      grid,
      layerId: activeLayerId,
      dimensions,
      selection,
      colorCss: primaryColor,
      targetFormat,
      alphaLocked: Boolean(activeLayer.alphaLocked),
    });

    if (tileDeltas.length > 0) {
      pushHistoryStep(
        'fill',
        'Fill Selection',
        null,
        null,
        activeLayerId,
        dirtyRect ?? undefined,
        tileDeltas
      );
    }
    updateLayerThumbnail(activeLayerId, true);
  }, [
    selection,
    handleCommitFloatingSelection,
    handleClearSelection,
    flushPendingHistoryTasks,
    getGrid,
    layers,
    activeLayerId,
    activeLayer,
    dimensions,
    resolveLayerFormat,
    updateLayerThumbnail,
    pushHistoryStep,
    showToast,
  ]);

  const handleExpandSelection = useCallback(
    (pixels = 5) => {
      if (!selection) return;
      const w = dimensions.width;
      const h = dimensions.height;
      const currentMask = selectionToMask(selection, w, h);
      const expanded = expandSelection(currentMask, w, h, pixels);
      const b = maskToBounds(expanded, w, h);
      if (!b) {
        setSelection(null);
        return;
      }
      const svg = maskToSvgPath(expanded, w, h);
      setSelection({
        type: 'mask',
        bounds: b,
        mask: expanded,
        maskWidth: w,
        maskHeight: h,
        svgPath: svg,
      });
      showToast(`Expanded Selection (+${pixels}px)`);
    },
    [selection, dimensions, showToast]
  );

  const handleContractSelection = useCallback(
    (pixels = 5) => {
      if (!selection) return;
      const w = dimensions.width;
      const h = dimensions.height;
      const currentMask = selectionToMask(selection, w, h);
      const contracted = contractSelection(currentMask, w, h, pixels);
      const b = maskToBounds(contracted, w, h);
      if (!b) {
        setSelection(null);
        showToast('Selection contracted to empty');
        return;
      }
      const svg = maskToSvgPath(contracted, w, h);
      setSelection({
        type: 'mask',
        bounds: b,
        mask: contracted,
        maskWidth: w,
        maskHeight: h,
        svgPath: svg,
      });
      showToast(`Contracted Selection (-${pixels}px)`);
    },
    [selection, dimensions, showToast]
  );

  const handleFeatherSelection = useCallback(
    (radius = 5) => {
      if (!selection) return;
      const w = dimensions.width;
      const h = dimensions.height;
      const currentMask = selectionToMask(selection, w, h);
      const feathered = featherSelection(currentMask, w, h, radius);
      const b = maskToBounds(feathered, w, h);
      if (!b) {
        setSelection(null);
        return;
      }
      const svg = maskToSvgPath(feathered, w, h);
      setSelection({
        type: 'mask',
        bounds: b,
        mask: feathered,
        maskWidth: w,
        maskHeight: h,
        svgPath: svg,
      });
      showToast(`Feathered Selection (${radius}px)`);
    },
    [selection, dimensions, showToast]
  );

  const handleInvertSelection = useCallback(() => {
    const w = dimensions.width;
    const h = dimensions.height;
    const currentMask = selection ? selectionToMask(selection, w, h) : new Uint8Array(w * h);
    const inverted = invertSelection(currentMask, w, h);
    const b = maskToBounds(inverted, w, h);
    if (!b) {
      setSelection(null);
      showToast('Inverted Selection (Empty)');
      return;
    }
    const svg = maskToSvgPath(inverted, w, h);
    setSelection({
      type: 'mask',
      bounds: b,
      mask: inverted,
      maskWidth: w,
      maskHeight: h,
      svgPath: svg,
    });
    showToast('Inverted Selection');
  }, [selection, dimensions, showToast]);

  const handleSelectAll = useCallback(() => {
    const w = dimensions.width;
    const h = dimensions.height;
    const mask = new Uint8Array(w * h);
    mask.fill(255);
    const svg = `M 0 0 H ${w} V ${h} H 0 Z`;
    setSelection({
      type: 'rect',
      bounds: { x: 0, y: 0, width: w, height: h },
      mask,
      maskWidth: w,
      maskHeight: h,
      svgPath: svg,
    });
    showToast('Selected All (Ctrl+A)');
  }, [dimensions, showToast]);

  const handleStartTransform = useCallback(() => {
    if (transformSession?.active) return;

    flushPendingHistoryTasks?.();
    const grid = getGrid();

    // If there is already a floating selection canvas lifted from a specific layer, transform it directly
    if (selection?.floating?.canvas) {
      const targetLayerId = selection.floating.layerId || activeLayerId;
      const floatingTarget = layers.find((l) => l.id === targetLayerId);
      if (floatingTarget && (floatingTarget.locked || floatingTarget.type !== 'raster')) {
        showToast('Select an unlocked raster layer or folder to transform');
        return;
      }

      const floatCanvas = selection.floating.canvas;
      const floatX = selection.floating.x;
      const floatY = selection.floating.y;
      const beforeTileSnapshot = selection.floating.beforeTileSnapshot;

      const quad = createDefaultPerspectiveQuad(
        floatX,
        floatY,
        floatCanvas.width,
        floatCanvas.height,
        0
      );
      setTransformSession({
        active: true,
        layerId: targetLayerId,
        sourceCanvas: floatCanvas,
        beforeTileSnapshot: beforeTileSnapshot ?? new Map(),
        bounds: { x: floatX, y: floatY, width: floatCanvas.width, height: floatCanvas.height },
        x: floatX,
        y: floatY,
        width: floatCanvas.width,
        height: floatCanvas.height,
        rotation: 0,
        flipH: false,
        flipV: false,
        isSelection: true,
        mode: 'affine',
        perspectiveQuad: quad,
        meshCols: 4,
        meshRows: 4,
        meshPoints: createDefaultMeshPoints(quad, 4, 4),
      });
      setSelection(null);
      toolStoreActions.setToolRaw('transform');
      return;
    }

    const resolved = resolveTransformTargetLayers(layers, activeLayer, selectedLayerIds);
    if (resolved.targetLayers.length === 0) {
      if (resolved.blockedReason === 'locked') {
        showToast(
          resolved.includesFolder
            ? 'Unlock the selected folder to transform'
            : 'Select an unlocked raster layer or folder to transform'
        );
      } else if (resolved.blockedReason === 'empty-folder') {
        showToast('Selected folder has no unlocked raster layers to transform');
      } else {
        showToast('Select an unlocked raster layer or folder to transform');
      }
      return;
    }

    const { targetLayers, includesFolder } = resolved;
    const layerMap = new Map(layers.map((l) => [l.id, l]));
    const selectedRootIds = new Set(
      selectedLayerIds && selectedLayerIds.length > 0
        ? selectedLayerIds
        : activeLayer
          ? [activeLayer.id]
          : []
    );

    if (selection) {
      if (targetLayers.length > 1) {
        const layerBeforeSnapshots = new Map<string, Map<string, TileSnapshotEntry>>();
        const layerSourceCanvases = new Map<string, HTMLCanvasElement>();
        const orderedLayers = targetLayers.slice().reverse();

        let liftBounds: DirtyRect | null = null;
        let compositeCanvas: HTMLCanvasElement | null = null;
        let compCtx: CanvasRenderingContext2D | null = null;

        for (const lyr of orderedLayers) {
          if (!grid.hasLayerTiles(lyr.id)) continue;
          const isLayerBg = lyr.id === 'layer-bg' || lyr.id.startsWith('layer-bg');
          const targetFormat = resolveLayerFormat(lyr.id);
          const lifted = liftSelectionFromTileGrid({
            grid,
            layerId: lyr.id,
            dimensions,
            selection,
            isBackground: isLayerBg,
            targetFormat,
          });
          if (!lifted) continue;

          if (!liftBounds) {
            liftBounds = lifted.bounds;
            compositeCanvas = document.createElement('canvas');
            compositeCanvas.width = lifted.floatingCanvas.width;
            compositeCanvas.height = lifted.floatingCanvas.height;
            compCtx = get2DContext(compositeCanvas);
          }

          layerSourceCanvases.set(lyr.id, lifted.floatingCanvas);
          layerBeforeSnapshots.set(lyr.id, lifted.beforeTileSnapshot);

          const previewState = getTransformPreviewLayerState(lyr, layerMap, selectedRootIds);
          if (compCtx && previewState.visible && previewState.opacity > 0.001) {
            compCtx.save();
            compCtx.globalAlpha = previewState.opacity;
            compCtx.globalCompositeOperation = getCanvasCompositeOperation(lyr.blendMode);
            compCtx.drawImage(lifted.floatingCanvas, 0, 0);
            compCtx.restore();
          }

          updateLayerThumbnail(lyr.id, true);
        }

        const liftedLayerIds = targetLayers
          .filter((l) => layerSourceCanvases.has(l.id))
          .map((l) => l.id);
        if (!liftBounds || !compositeCanvas || liftedLayerIds.length === 0) {
          if (compositeCanvas) releaseTemporaryCanvas(compositeCanvas);
          showToast(includesFolder ? 'Selected folder is empty' : 'Selected layers are empty');
          return;
        }

        grid.notifyChange(true);
        const primaryLayerId = liftedLayerIds[0];
        const quad = createDefaultPerspectiveQuad(
          liftBounds.x,
          liftBounds.y,
          compositeCanvas.width,
          compositeCanvas.height,
          0
        );
        setTransformSession({
          active: true,
          layerId: primaryLayerId,
          layerIds: liftedLayerIds,
          layerSourceCanvases,
          layerBeforeSnapshots,
          sourceCanvas: compositeCanvas,
          beforeTileSnapshot: layerBeforeSnapshots.get(primaryLayerId),
          bounds: {
            x: liftBounds.x,
            y: liftBounds.y,
            width: compositeCanvas.width,
            height: compositeCanvas.height,
          },
          x: liftBounds.x,
          y: liftBounds.y,
          width: compositeCanvas.width,
          height: compositeCanvas.height,
          rotation: 0,
          flipH: false,
          flipV: false,
          isSelection: true,
          mode: 'affine',
          perspectiveQuad: quad,
          meshCols: 4,
          meshRows: 4,
          meshPoints: createDefaultMeshPoints(quad, 4, 4),
        });
        setSelection(null);
        toolStoreActions.setToolRaw('transform');
        return;
      }

      const targetLayerId = targetLayers[0].id;
      const isBg = targetLayerId === 'layer-bg' || targetLayerId.startsWith('layer-bg');
      const targetFormat = resolveLayerFormat(targetLayerId);
      const lifted = liftSelectionFromTileGrid({
        grid,
        layerId: targetLayerId,
        dimensions,
        selection,
        isBackground: isBg,
        targetFormat,
      });
      if (!lifted) return;

      const floatCanvas = lifted.floatingCanvas;
      const floatX = lifted.bounds.x;
      const floatY = lifted.bounds.y;
      const beforeTileSnapshot = lifted.beforeTileSnapshot;
      updateLayerThumbnail(targetLayerId, true);

      const quad = createDefaultPerspectiveQuad(
        floatX,
        floatY,
        floatCanvas.width,
        floatCanvas.height,
        0
      );
      setTransformSession({
        active: true,
        layerId: targetLayerId,
        sourceCanvas: floatCanvas,
        beforeTileSnapshot,
        bounds: { x: floatX, y: floatY, width: floatCanvas.width, height: floatCanvas.height },
        x: floatX,
        y: floatY,
        width: floatCanvas.width,
        height: floatCanvas.height,
        rotation: 0,
        flipH: false,
        flipV: false,
        isSelection: true,
        mode: 'affine',
        perspectiveQuad: quad,
        meshCols: 4,
        meshRows: 4,
        meshPoints: createDefaultMeshPoints(quad, 4, 4),
      });
      setSelection(null);
    } else if (targetLayers.length > 1) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const lyr of targetLayers) {
        const isLayerBg = lyr.id === 'layer-bg' || lyr.id.startsWith('layer-bg');
        const cb = grid.getLayerContentBounds(lyr.id, dimensions, isLayerBg);
        if (cb) {
          minX = Math.min(minX, cb.x);
          minY = Math.min(minY, cb.y);
          maxX = Math.max(maxX, cb.x + cb.width);
          maxY = Math.max(maxY, cb.y + cb.height);
        }
      }

      if (!isFinite(minX) || !isFinite(minY) || maxX <= minX || maxY <= minY) {
        showToast(includesFolder ? 'Selected folder is empty' : 'Selected layers are empty');
        return;
      }

      const b: DirtyRect = {
        x: Math.max(0, minX),
        y: Math.max(0, minY),
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
      };

      const layerBeforeSnapshots = new Map<string, Map<string, TileSnapshotEntry>>();
      const layerSourceCanvases = new Map<string, HTMLCanvasElement>();
      const layerSourcePixels = new Map<string, { data: Uint8ClampedArray; width: number; height: number }>();

      const compositeCanvas = document.createElement('canvas');
      compositeCanvas.width = b.width;
      compositeCanvas.height = b.height;
      const compCtx = get2DContext(compositeCanvas);

      const orderedLayers = targetLayers.slice().reverse();
      for (const lyr of orderedLayers) {
        if (!grid.hasLayerTiles(lyr.id)) continue;
        const sCanvas = grid.createRegionCanvas(lyr.id, b);
        if (!sCanvas) continue;
        const sPixels = grid.readImageData(lyr.id, b.x, b.y, b.width, b.height);
        layerSourceCanvases.set(lyr.id, sCanvas);
        layerSourcePixels.set(lyr.id, sPixels);

        const previewState = getTransformPreviewLayerState(lyr, layerMap, selectedRootIds);
        if (compCtx && previewState.visible && previewState.opacity > 0.001) {
          compCtx.save();
          compCtx.globalAlpha = previewState.opacity;
          compCtx.globalCompositeOperation = getCanvasCompositeOperation(lyr.blendMode);
          compCtx.drawImage(sCanvas, 0, 0);
          compCtx.restore();
        }

        const isLayerBg = lyr.id === 'layer-bg' || lyr.id.startsWith('layer-bg');
        const beforeSnap = new Map<string, TileSnapshotEntry>();
        grid.clearRectInLayer(lyr.id, b, isLayerBg, beforeSnap, true);
        layerBeforeSnapshots.set(lyr.id, beforeSnap);
        updateLayerThumbnail(lyr.id, true);
      }
      grid.notifyChange(true);

      const liftedLayerIds = targetLayers
        .filter((l) => layerSourceCanvases.has(l.id))
        .map((l) => l.id);
      if (liftedLayerIds.length === 0) {
        releaseTemporaryCanvas(compositeCanvas);
        showToast(includesFolder ? 'Selected folder is empty' : 'Selected layers are empty');
        return;
      }

      const primaryLayerId = liftedLayerIds[0];
      const quad = createDefaultPerspectiveQuad(b.x, b.y, b.width, b.height, 0);
      setTransformSession({
        active: true,
        layerId: primaryLayerId,
        layerIds: liftedLayerIds,
        layerSourceCanvases,
        layerSourcePixels,
        layerBeforeSnapshots,
        sourceCanvas: compositeCanvas,
        beforeTileSnapshot: layerBeforeSnapshots.get(primaryLayerId),
        bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        rotation: 0,
        flipH: false,
        flipV: false,
        isSelection: false,
        mode: 'affine',
        perspectiveQuad: quad,
        meshCols: 4,
        meshRows: 4,
        meshPoints: createDefaultMeshPoints(quad, 4, 4),
      });
    } else {
      const targetLayerId = targetLayers[0].id;
      const isBg = targetLayerId === 'layer-bg' || targetLayerId.startsWith('layer-bg');
      const contentBounds = grid.getLayerContentBounds(targetLayerId, dimensions, isBg);
      let b = contentBounds;
      if (!b) {
        if (isBg) {
          b = { x: 0, y: 0, width: dimensions.width, height: dimensions.height };
        } else {
          showToast(includesFolder ? 'Selected folder is empty' : 'Active layer is empty');
          return;
        }
      }

      const sourceCanvas = grid.createRegionCanvas(targetLayerId, b);
      if (!sourceCanvas) return;
      const sourcePixels = grid.readImageData(targetLayerId, b.x, b.y, b.width, b.height);

      const beforeTileSnapshot = new Map<string, TileSnapshotEntry>();
      grid.clearRectInLayer(targetLayerId, b, isBg, beforeTileSnapshot, false);
      updateLayerThumbnail(targetLayerId, true);

      const quad = createDefaultPerspectiveQuad(b.x, b.y, b.width, b.height, 0);
      setTransformSession({
        active: true,
        layerId: targetLayerId,
        sourceCanvas,
        sourcePixels,
        beforeTileSnapshot,
        bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        rotation: 0,
        flipH: false,
        flipV: false,
        isSelection: false,
        mode: 'affine',
        perspectiveQuad: quad,
        meshCols: 4,
        meshRows: 4,
        meshPoints: createDefaultMeshPoints(quad, 4, 4),
      });
    }
    toolStoreActions.setToolRaw('transform');
  }, [
    transformSession,
    flushPendingHistoryTasks,
    getGrid,
    resolveLayerFormat,
    dimensions,
    selection,
    activeLayerId,
    activeLayer,
    selectedLayerIds,
    layers,
    updateLayerThumbnail,
    showToast,
  ]);

  const handleApplyTransform = useCallback(() => {
    if (!transformSession) return;
    const grid = getGrid();
    const resolveMonoOpts = (layerId: string, fmt: TileFormat) => {
      if (fmt !== 'monochrome-1bit') return undefined;
      const lyr = layers.find((l) => l.id === layerId);
      return {
        threshold: lyr?.monoThreshold ?? 128,
        expressBlack: lyr?.monoExpressBlack ?? true,
        expressWhite: lyr?.monoExpressWhite ?? true,
      };
    };

    if (
      transformSession.layerIds &&
      transformSession.layerIds.length > 0 &&
      transformSession.layerSourceCanvases
    ) {
      const allTileDeltas: TileDelta[] = [];
      let combinedDestRect: DirtyRect | null = null;

      for (const lId of transformSession.layerIds) {
        const sCanvas = transformSession.layerSourceCanvases.get(lId);
        if (!sCanvas) continue;
        const sPixels = transformSession.layerSourcePixels?.get(lId);
        const targetFormat = resolveLayerFormat(lId);
        const beforeSnap = new Map<string, TileSnapshotEntry>(
          transformSession.layerBeforeSnapshots?.get(lId) ?? []
        );

        const destRect = compositeTransformedIntoTileGrid(
          grid,
          lId,
          sCanvas,
          sPixels,
          transformSession,
          dimensions,
          targetFormat,
          beforeSnap,
          resolveMonoOpts(lId, targetFormat)
        );

        if (destRect) {
          if (!combinedDestRect) {
            combinedDestRect = { ...destRect };
          } else {
            const minX = Math.min(combinedDestRect.x, destRect.x);
            const minY = Math.min(combinedDestRect.y, destRect.y);
            const maxX = Math.max(
              combinedDestRect.x + combinedDestRect.width,
              destRect.x + destRect.width
            );
            const maxY = Math.max(
              combinedDestRect.y + combinedDestRect.height,
              destRect.y + destRect.height
            );
            combinedDestRect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
          }
        }

        const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnap, lId);
        for (const d of tileDeltas) {
          allTileDeltas.push(d);
        }
        releaseTemporaryCanvas(sCanvas);
        updateLayerThumbnail(lId, true);
      }

      if (allTileDeltas.length > 0) {
        pushHistoryStep(
          'transform',
          `Free Transform (${transformSession.layerIds.length} layers)`,
          null,
          null,
          transformSession.layerIds[0],
          combinedDestRect ?? undefined,
          allTileDeltas
        );
      }

      releaseTemporaryCanvas(transformSession.sourceCanvas);
      grid.notifyChange(true);
      setTransformSession(null);
      toolStoreActions.selectTool('brush');
      return;
    }

    const targetLayerId = transformSession.layerId;
    const targetFormat = resolveLayerFormat(targetLayerId);
    const beforeSnap = new Map<string, TileSnapshotEntry>(
      transformSession.beforeTileSnapshot ?? []
    );

    const destRect = compositeTransformedIntoTileGrid(
      grid,
      targetLayerId,
      transformSession.sourceCanvas,
      transformSession.sourcePixels,
      transformSession,
      dimensions,
      targetFormat,
      beforeSnap,
      resolveMonoOpts(targetLayerId, targetFormat)
    );

    const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnap, targetLayerId);
    if (tileDeltas.length > 0) {
      pushHistoryStep(
        'transform',
        'Free Transform',
        null,
        null,
        targetLayerId,
        destRect ?? undefined,
        tileDeltas
      );
    }

    releaseTemporaryCanvas(transformSession.sourceCanvas);
    grid.notifyChange(true);
    updateLayerThumbnail(targetLayerId, true);
    setTransformSession(null);
    toolStoreActions.selectTool('brush');
  }, [
    transformSession,
    getGrid,
    layers,
    resolveLayerFormat,
    dimensions,
    pushHistoryStep,
    updateLayerThumbnail,
  ]);

  const handleCancelTransform = useCallback(() => {
    if (!transformSession) return;
    const grid = getGrid();

    if (transformSession.layerBeforeSnapshots && transformSession.layerBeforeSnapshots.size > 0) {
      for (const [lId, beforeSnap] of transformSession.layerBeforeSnapshots.entries()) {
        grid.restoreLayerSnapshot(lId, beforeSnap, true);
        updateLayerThumbnail(lId, true);
      }
      if (transformSession.layerSourceCanvases) {
        for (const sCanvas of transformSession.layerSourceCanvases.values()) {
          releaseTemporaryCanvas(sCanvas);
        }
      }
      releaseTemporaryCanvas(transformSession.sourceCanvas);
      grid.notifyChange(true);
      setTransformSession(null);
      toolStoreActions.selectTool('brush');
      return;
    }

    if (transformSession.beforeTileSnapshot) {
      grid.restoreLayerSnapshot(transformSession.layerId, transformSession.beforeTileSnapshot, false);
      updateLayerThumbnail(transformSession.layerId, true);
    }
    releaseTemporaryCanvas(transformSession.sourceCanvas);
    setTransformSession(null);
    toolStoreActions.selectTool('brush');
  }, [transformSession, getGrid, updateLayerThumbnail]);

  const handleSelectionPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, pt: { x: number; y: number }): boolean => {
      const { tool, wandSettings, brushSettings } = useToolStore.getState();

      if (tool === 'select-wand') {
        e.preventDefault();
        if (selection?.floating) {
          handleCommitFloatingSelection();
        }

        const px = Math.floor(pt.x);
        const py = Math.floor(pt.y);
        if (px < 0 || px >= dimensions.width || py < 0 || py >= dimensions.height) return true;

        flushPendingHistoryTasks?.();
        const w = dimensions.width;
        const h = dimensions.height;
        const { mask, bounds } = floodSelectWandOnTileGrid({
          grid: getGrid(),
          layers,
          activeLayerId,
          dimensions,
          startX: px,
          startY: py,
          settings: wandSettings,
        });

        if (!bounds || bounds.width === 0 || bounds.height === 0) {
          setSelection(null);
          return true;
        }

        const svgPath = maskToSvgPath(mask, w, h);
        setSelection({
          type: 'wand',
          bounds,
          mask,
          maskWidth: w,
          maskHeight: h,
          svgPath,
        });
        return true;
      }

      if (tool === 'select-pen' || tool === 'select-eraser') {
        e.preventDefault();
        if (selection?.floating) {
          handleCommitFloatingSelection();
        }

        const w = dimensions.width;
        const h = dimensions.height;
        let maskCanvas = selectionMaskCanvasRef.current;
        if (!maskCanvas || maskCanvas.width !== w || maskCanvas.height !== h) {
          maskCanvas = document.createElement('canvas');
          maskCanvas.width = w;
          maskCanvas.height = h;
          selectionMaskCanvasRef.current = maskCanvas;
        }

        const mCtx = get2DContext(maskCanvas);
        if (!mCtx) return true;

        mCtx.clearRect(0, 0, w, h);
        if (selection) {
          const currentMask = selectionToMask(selection, w, h);
          const imgData = mCtx.createImageData(w, h);
          for (let i = 0; i < currentMask.length; i++) {
            const val = currentMask[i];
            const idx = i * 4;
            imgData.data[idx] = val;
            imgData.data[idx + 1] = val;
            imgData.data[idx + 2] = val;
            imgData.data[idx + 3] = val > 0 ? 255 : 0;
          }
          mCtx.putImageData(imgData, 0, 0);
        }

        const brushSize = brushSettings.size;
        mCtx.save();
        mCtx.lineCap = 'round';
        mCtx.lineJoin = 'round';
        mCtx.lineWidth = brushSize;
        if (tool === 'select-pen') {
          mCtx.globalCompositeOperation = 'source-over';
          mCtx.fillStyle = '#ffffff';
          mCtx.strokeStyle = '#ffffff';
        } else {
          mCtx.globalCompositeOperation = 'destination-out';
          mCtx.fillStyle = '#000000';
          mCtx.strokeStyle = '#000000';
        }

        mCtx.beginPath();
        mCtx.arc(pt.x, pt.y, brushSize / 2, 0, Math.PI * 2);
        mCtx.fill();
        mCtx.restore();

        try {
          (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
        } catch {
          // Ignore capture errors in synthetic events
        }

        isSelectionPenDrawingRef.current = true;
        selectionPenDrawingRef.current = {
          isDrawing: true,
          lastPt: pt,
          maskCanvas,
          ctx: mCtx,
          lastPreviewTs: Date.now(),
        };

        const mImgData = mCtx.getImageData(0, 0, w, h);
        const newMask = new Uint8Array(w * h);
        for (let i = 0; i < newMask.length; i++) {
          newMask[i] = mImgData.data[i * 4 + 3] > 0 ? 255 : 0;
        }
        const b = maskToBounds(newMask, w, h);
        if (b) {
          const svg = maskToSvgPath(newMask, w, h);
          setSelection({
            type: 'mask',
            bounds: b,
            mask: newMask,
            maskWidth: w,
            maskHeight: h,
            svgPath: svg,
          });
        } else {
          setSelection(null);
        }
        return true;
      }

      if (tool === 'select-rect' || tool === 'select-lasso') {
        e.preventDefault();
        if (selection && isPointInSelection(pt.x, pt.y, selection)) {
          if (!selection.floating) {
            flushPendingHistoryTasks?.();
            const grid = getGrid();
            const isBg = activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg');
            const targetFormat = resolveLayerFormat(activeLayerId);
            const lifted = liftSelectionFromTileGrid({
              grid,
              layerId: activeLayerId,
              dimensions,
              selection,
              isBackground: isBg,
              targetFormat,
            });
            if (lifted) {
              updateLayerThumbnail(activeLayerId, true);
              const floatingObj = {
                canvas: lifted.floatingCanvas,
                x: lifted.bounds.x,
                y: lifted.bounds.y,
                origX: lifted.bounds.x,
                origY: lifted.bounds.y,
                layerId: activeLayerId,
                beforeTileSnapshot: lifted.beforeTileSnapshot,
              };
              setSelection({
                ...selection,
                bounds: lifted.bounds,
                floating: floatingObj,
              });
              selectionDragRef.current = {
                isDragging: true,
                startX: pt.x,
                startY: pt.y,
                origFloatingX: lifted.bounds.x,
                origFloatingY: lifted.bounds.y,
                origBoundsX: lifted.bounds.x,
                origBoundsY: lifted.bounds.y,
              };
            }
          } else {
            selectionDragRef.current = {
              isDragging: true,
              startX: pt.x,
              startY: pt.y,
              origFloatingX: selection.floating.x,
              origFloatingY: selection.floating.y,
              origBoundsX: selection.bounds.x,
              origBoundsY: selection.bounds.y,
            };
          }
          return true;
        }

        if (selection?.floating) {
          handleCommitFloatingSelection();
        }

        if (tool === 'select-rect') {
          try {
            (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
          } catch {
            // Ignore capture errors in synthetic events
          }
          selectRectStartRef.current = pt;
          setSelection({
            type: 'rect',
            bounds: { x: pt.x, y: pt.y, width: 0, height: 0 },
          });
        } else {
          try {
            (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId);
          } catch {
            // Ignore capture errors in synthetic events
          }
          lassoPointsRef.current = [pt];
          setSelection({
            type: 'lasso',
            bounds: { x: pt.x, y: pt.y, width: 0, height: 0 },
            polygon: [pt],
          });
        }
        return true;
      }

      return false;
    },
    [
      selection,
      handleCommitFloatingSelection,
      flushPendingHistoryTasks,
      getGrid,
      resolveLayerFormat,
      dimensions,
      layers,
      activeLayerId,
      updateLayerThumbnail,
    ]
  );

  const handleSelectionPointerMove = useCallback((pt: { x: number; y: number }): boolean => {
    const { tool, brushSettings } = useToolStore.getState();

    if ((tool === 'select-pen' || tool === 'select-eraser') && selectionPenDrawingRef.current?.isDrawing) {
      const { ctx: mCtx, lastPt } = selectionPenDrawingRef.current;
      const brushSize = brushSettings.size;
      mCtx.save();
      mCtx.lineCap = 'round';
      mCtx.lineJoin = 'round';
      mCtx.lineWidth = brushSize;
      if (tool === 'select-pen') {
        mCtx.globalCompositeOperation = 'source-over';
        mCtx.strokeStyle = '#ffffff';
      } else {
        mCtx.globalCompositeOperation = 'destination-out';
        mCtx.strokeStyle = '#000000';
      }

      mCtx.beginPath();
      mCtx.moveTo(lastPt.x, lastPt.y);
      mCtx.lineTo(pt.x, pt.y);
      mCtx.stroke();
      mCtx.restore();

      selectionPenDrawingRef.current.lastPt = pt;

      // Throttle live marching-ants preview while painting with Selection Pen / Eraser
      const nowTs = Date.now();
      if (nowTs - selectionPenDrawingRef.current.lastPreviewTs >= 60) {
        selectionPenDrawingRef.current.lastPreviewTs = nowTs;
        const w = dimensions.width;
        const h = dimensions.height;
        if (w * h <= 4096 * 4096) {
          const mImgData = mCtx.getImageData(0, 0, w, h);
          const newMask = new Uint8Array(w * h);
          for (let i = 0; i < newMask.length; i++) {
            newMask[i] = mImgData.data[i * 4 + 3] > 0 ? 255 : 0;
          }
          const b = maskToBounds(newMask, w, h);
          if (b) {
            const svg = maskToSvgPath(newMask, w, h);
            setSelection({
              type: 'mask',
              bounds: b,
              mask: newMask,
              maskWidth: w,
              maskHeight: h,
              svgPath: svg,
            });
          } else {
            setSelection(null);
          }
        }
      }
      return true;
    }

    if (selectionDragRef.current?.isDragging) {
      if (tool !== 'select-rect' && tool !== 'select-lasso') {
        selectionDragRef.current = null;
        return false;
      }
      const drag = selectionDragRef.current;
      const dx = pt.x - drag.startX;
      const dy = pt.y - drag.startY;
      setSelection((prev) => {
        if (!prev || !prev.floating) return prev;
        const newX = Math.round(drag.origFloatingX + dx);
        const newY = Math.round(drag.origFloatingY + dy);
        const boundsX = Math.round(drag.origBoundsX + dx);
        const boundsY = Math.round(drag.origBoundsY + dy);
        let updatedPoly = prev.polygon;
        if (prev.type === 'lasso' && prev.polygon) {
          const shiftX = boundsX - prev.bounds.x;
          const shiftY = boundsY - prev.bounds.y;
          updatedPoly = prev.polygon.map((p) => ({ x: p.x + shiftX, y: p.y + shiftY }));
        }
        return {
          ...prev,
          bounds: { ...prev.bounds, x: boundsX, y: boundsY },
          polygon: updatedPoly,
          floating: {
            ...prev.floating,
            x: newX,
            y: newY,
          },
        };
      });
      return true;
    }

    if (selectRectStartRef.current) {
      if (tool !== 'select-rect') {
        selectRectStartRef.current = null;
        return false;
      }
      const s = selectRectStartRef.current;
      const x0 = Math.max(0, Math.min(dimensions.width, Math.floor(Math.min(s.x, pt.x))));
      const y0 = Math.max(0, Math.min(dimensions.height, Math.floor(Math.min(s.y, pt.y))));
      const x1 = Math.max(0, Math.min(dimensions.width, Math.ceil(Math.max(s.x, pt.x))));
      const y1 = Math.max(0, Math.min(dimensions.height, Math.ceil(Math.max(s.y, pt.y))));
      setSelection({
        type: 'rect',
        bounds: { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) },
      });
      return true;
    }

    if (lassoPointsRef.current.length > 0) {
      if (tool !== 'select-lasso') {
        lassoPointsRef.current = [];
        return false;
      }
      const pts = lassoPointsRef.current;
      const last = pts[pts.length - 1];
      if (Math.hypot(pt.x - last.x, pt.y - last.y) >= 2) {
        pts.push(pt);
        const b = computePolygonBounds(pts);
        setSelection({
          type: 'lasso',
          bounds: b,
          polygon: [...pts],
        });
      }
      return true;
    }

    return false;
  }, [dimensions.height, dimensions.width]);

  const handleSelectionPointerUp = useCallback(
    (pt: { x: number; y: number }, e?: React.PointerEvent<HTMLElement>): boolean => {
      const { tool } = useToolStore.getState();
      const releaseCapture = () => {
        if (!e) return;
        try {
          (e.currentTarget as HTMLElement)?.releasePointerCapture?.(e.pointerId);
        } catch {
          // Ignore release errors
        }
      };

      if (
        (tool === 'select-pen' || tool === 'select-eraser') &&
        selectionPenDrawingRef.current?.isDrawing
      ) {
        releaseCapture();
        const { ctx: mCtx } = selectionPenDrawingRef.current;
        selectionPenDrawingRef.current = null;
        isSelectionPenDrawingRef.current = false;
        const w = dimensions.width;
        const h = dimensions.height;
        const mImgData = mCtx.getImageData(0, 0, w, h);
        const newMask = new Uint8Array(w * h);
        for (let i = 0; i < newMask.length; i++) {
          newMask[i] = mImgData.data[i * 4 + 3] > 0 ? 255 : 0;
        }
        const b = maskToBounds(newMask, w, h);
        if (b) {
          const svg = maskToSvgPath(newMask, w, h);
          setSelection({
            type: 'mask',
            bounds: b,
            mask: newMask,
            maskWidth: w,
            maskHeight: h,
            svgPath: svg,
          });
        } else {
          setSelection(null);
        }
        return true;
      }

      if (selectionDragRef.current?.isDragging) {
        selectionDragRef.current = null;
        return true;
      }

      if (selectRectStartRef.current) {
        releaseCapture();
        const s = selectRectStartRef.current;
        selectRectStartRef.current = null;
        const x0 = Math.max(0, Math.min(dimensions.width, Math.floor(Math.min(s.x, pt.x))));
        const y0 = Math.max(0, Math.min(dimensions.height, Math.floor(Math.min(s.y, pt.y))));
        const x1 = Math.max(0, Math.min(dimensions.width, Math.ceil(Math.max(s.x, pt.x))));
        const y1 = Math.max(0, Math.min(dimensions.height, Math.ceil(Math.max(s.y, pt.y))));
        const w = x1 - x0;
        const h = y1 - y0;
        if (w < 4 || h < 4) {
          setSelection(null);
        } else {
          setSelection({
            type: 'rect',
            bounds: { x: x0, y: y0, width: w, height: h },
          });
        }
        return true;
      }

      if (lassoPointsRef.current.length > 0) {
        releaseCapture();
        if (lassoPointsRef.current.length < 3) {
          setSelection(null);
        } else {
          const b = computePolygonBounds(lassoPointsRef.current);
          setSelection({
            type: 'lasso',
            bounds: b,
            polygon: [...lassoPointsRef.current],
          });
        }
        lassoPointsRef.current = [];
        return true;
      }

      return false;
    },
    [dimensions.height, dimensions.width]
  );

  return {
    selection,
    setSelection,
    transformSession,
    setTransformSession,
    isSelectionPenDrawingRef,
    handleCommitFloatingSelection,
    handleDeselect,
    handleClearSelection,
    handleDeleteOutsideSelection,
    handleCopySelection,
    handleCutSelection,
    handleMoveSelectionToNewLayer,
    handleCopySelectionToNewLayer,
    handleFillSelectionColor,
    handleExpandSelection,
    handleContractSelection,
    handleFeatherSelection,
    handleInvertSelection,
    handleSelectAll,
    handleStartTransform,
    handleApplyTransform,
    handleCancelTransform,
    handleSelectionPointerDown,
    handleSelectionPointerMove,
    handleSelectionPointerUp,
  };
}
