import React, { useState, useRef, useCallback } from 'react';
import {
  CanvasColorMode,
  CanvasDimensions,
  CanvasSelection,
  LayerItem,
  TransformSession,
} from '../../types/editor';
import { documentStore } from '../../utils/documentStore';
import { SparseTileGrid } from '../../utils/tileEngine';
import { compositeVisibleLayers } from '../../utils/floodFill';
import {
  isPointInSelection,
  liftSelectionToFloating,
  commitFloatingSelection,
  computePolygonBounds,
  getCanvasContentBounds,
  floodSelectWand,
  expandSelection,
  contractSelection,
  featherSelection,
  invertSelection,
  selectionToMask,
  maskToBounds,
  maskToSvgPath,
} from '../../utils/selectionUtils';
import {
  renderPerspectiveQuad,
  renderMeshWarp,
  createDefaultPerspectiveQuad,
  createDefaultMeshPoints,
} from '../../utils/transformEngine';
import { applyScreentone } from '../../utils/screentoneEngine';
import { applyLayerEffects } from '../../utils/layerEffectsEngine';
import { get2DContext } from '../../utils/canvasUtils';
import { useToolStore, toolStoreActions } from '../../stores';
import { PushHistoryStepFn } from './types';

export interface UseSelectionToolsParams {
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  activeLayer: LayerItem | undefined;
  activeLayerId: string;
  selectedLayerIds: string[];
  layerCanvasesRef: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  layerSourceCanvasesRef: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  getActiveCanvas: () => HTMLCanvasElement | null;
  materializeLayerCanvas?: (layerId: string) => HTMLCanvasElement | null;
  tileGrid?: SparseTileGrid;
  flushPendingHistoryTasks?: () => void;
  updateLayerThumbnail: (layerId: string, immediate?: boolean) => void;
  pushHistoryStep: PushHistoryStepFn;
  showToast: (msg: string) => void;
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
  handleSelectionPointerUp: (pt: { x: number; y: number }) => boolean;
}

export function useSelectionTools({
  dimensions,
  colorMode,
  layers,
  activeLayer,
  activeLayerId,
  selectedLayerIds,
  layerCanvasesRef,
  layerSourceCanvasesRef,
  getActiveCanvas,
  materializeLayerCanvas,
  tileGrid,
  flushPendingHistoryTasks,
  updateLayerThumbnail,
  pushHistoryStep,
  showToast,
}: UseSelectionToolsParams): UseSelectionToolsResult {
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [transformSession, setTransformSession] = useState<TransformSession | null>(null);

  const getGrid = useCallback(
    () => tileGrid ?? documentStore.getActiveTileGrid(),
    [tileGrid]
  );

  const markCanvasPopulated = useCallback((c: HTMLCanvasElement | null | undefined) => {
    if (!c) return;
    (c as unknown as { __isBlank?: boolean }).__isBlank = false;
    (c as unknown as { __isSolidWhite?: boolean }).__isSolidWhite = false;
  }, []);

  /**
   * Flushes any deferred brush/history tasks and synchronizes a layer's cached 2D canvas
   * from the authoritative SparseTileGrid so selection & transform never read stale tiles.
   */
  const getSyncedLayerCanvas = useCallback(
    (layerId: string): HTMLCanvasElement | null => {
      flushPendingHistoryTasks?.();
      const canvas =
        layerCanvasesRef.current.get(layerId) ??
        materializeLayerCanvas?.(layerId) ??
        (layerId === activeLayerId ? getActiveCanvas() : null);
      if (!canvas) return null;

      const grid = getGrid();
      const lyr = layers.find((l) => l.id === layerId);
      const src = layerSourceCanvasesRef.current?.get(layerId);
      const hasTiles = grid.hasLayerTiles(layerId);

      if (lyr?.toneEnabled && src) {
        grid.renderLayerToCanvas(layerId, src);
        if (hasTiles) markCanvasPopulated(src);
        markCanvasPopulated(canvas);
      } else {
        grid.renderLayerToCanvas(layerId, canvas);
        if (hasTiles) markCanvasPopulated(canvas);
        if (src) {
          grid.renderLayerToCanvas(layerId, src);
          if (hasTiles) markCanvasPopulated(src);
        }
      }
      return canvas;
    },
    [
      flushPendingHistoryTasks,
      layerCanvasesRef,
      materializeLayerCanvas,
      activeLayerId,
      getActiveCanvas,
      getGrid,
      layers,
      layerSourceCanvasesRef,
      markCanvasPopulated,
    ]
  );

  const selectionMaskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isSelectionPenDrawingRef = useRef<boolean>(false);
  const selectionPenDrawingRef = useRef<{
    isDrawing: boolean;
    lastPt: { x: number; y: number };
    maskCanvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
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
    const canvas =
      layerCanvasesRef.current.get(targetLayerId) ||
      materializeLayerCanvas?.(targetLayerId) ||
      getActiveCanvas();
    if (!canvas) return;

    const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
    commitFloatingSelection(canvas, selection.floating, sourceCanvas);
    markCanvasPopulated(canvas);
    markCanvasPopulated(sourceCanvas);

    const grid = getGrid();
    const ctx = get2DContext(canvas);
    if (ctx) {
      const afterData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (selection.floating.beforeImageData) {
        pushHistoryStep(
          'selection-move',
          'Move Selection',
          selection.floating.beforeImageData,
          afterData,
          targetLayerId
        );
      } else {
        const lyr = layers.find((l) => l.id === targetLayerId);
        const isMono = colorMode === 'monochrome' || lyr?.expressionColor === 'monochrome';
        grid.writeImageData(
          targetLayerId,
          afterData,
          0,
          0,
          isMono ? 'monochrome-1bit' : 'color-32bit'
        );
      }
      grid.notifyChange(true);
    }

    updateLayerThumbnail(targetLayerId, true);
    setSelection((prev) => (prev ? { ...prev, floating: null } : null));
  }, [
    selection,
    activeLayerId,
    layers,
    colorMode,
    layerCanvasesRef,
    materializeLayerCanvas,
    getActiveCanvas,
    layerSourceCanvasesRef,
    markCanvasPopulated,
    getGrid,
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
    const grid = getGrid();
    if (selection.floating) {
      const targetLayerId = selection.floating.layerId || activeLayerId;
      const canvas =
        layerCanvasesRef.current.get(targetLayerId) ||
        materializeLayerCanvas?.(targetLayerId) ||
        getActiveCanvas();
      if (canvas && selection.floating.beforeImageData) {
        const ctx = get2DContext(canvas);
        if (ctx) {
          const afterData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          pushHistoryStep(
            'clear',
            'Clear Selection',
            selection.floating.beforeImageData,
            afterData,
            targetLayerId
          );
          grid.notifyChange(true);
        }
      }
      setSelection(null);
      return;
    }

    const canvas = getSyncedLayerCanvas(activeLayerId);
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);
    const isBg = activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg');

    const clearOn = (target: HTMLCanvasElement) => {
      const c = get2DContext(target);
      if (!c) return;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      if (selection.mask && selection.maskWidth && selection.maskHeight) {
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = selection.maskWidth;
        maskCanvas.height = selection.maskHeight;
        const mCtx = maskCanvas.getContext('2d');
        if (mCtx) {
          const mImg = mCtx.createImageData(selection.maskWidth, selection.maskHeight);
          const count = Math.min(selection.mask.length, selection.maskWidth * selection.maskHeight);
          for (let i = 0; i < count; i++) {
            if (isBg) {
              mImg.data[i * 4] = 255;
              mImg.data[i * 4 + 1] = 255;
              mImg.data[i * 4 + 2] = 255;
            }
            mImg.data[i * 4 + 3] = selection.mask[i];
          }
          mCtx.putImageData(mImg, 0, 0);
          c.globalCompositeOperation = isBg ? 'source-over' : 'destination-out';
          c.drawImage(maskCanvas, 0, 0);
        }
      } else if (selection.type === 'rect') {
        if (isBg) {
          c.fillStyle = '#ffffff';
          c.fillRect(
            selection.bounds.x,
            selection.bounds.y,
            selection.bounds.width,
            selection.bounds.height
          );
        } else {
          c.clearRect(
            selection.bounds.x,
            selection.bounds.y,
            selection.bounds.width,
            selection.bounds.height
          );
        }
      } else if (selection.type === 'lasso' && selection.polygon && selection.polygon.length >= 3) {
        c.beginPath();
        c.moveTo(selection.polygon[0].x, selection.polygon[0].y);
        for (let i = 1; i < selection.polygon.length; i++) {
          c.lineTo(selection.polygon[i].x, selection.polygon[i].y);
        }
        c.closePath();
        if (isBg) {
          c.fillStyle = '#ffffff';
          c.fill();
        } else {
          c.globalCompositeOperation = 'destination-out';
          c.fillStyle = 'rgba(0, 0, 0, 1)';
          c.fill();
        }
      }
      c.restore();
    };

    clearOn(canvas);
    if (sourceCanvas) clearOn(sourceCanvas);
    markCanvasPopulated(canvas);
    markCanvasPopulated(sourceCanvas);

    const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    updateLayerThumbnail(activeLayerId, true);
    pushHistoryStep('clear', 'Clear Selection', beforeImageData, afterImageData, activeLayerId);
    grid.notifyChange(true);
  }, [
    selection,
    getGrid,
    getSyncedLayerCanvas,
    getActiveCanvas,
    materializeLayerCanvas,
    activeLayerId,
    layerCanvasesRef,
    layerSourceCanvasesRef,
    markCanvasPopulated,
    updateLayerThumbnail,
    pushHistoryStep,
  ]);

  const handleFillSelectionColor = useCallback(() => {
    if (!selection) return;
    const canvas = getSyncedLayerCanvas(activeLayerId);
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const primaryColor = useToolStore.getState().primaryColor;
    const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

    const fillOn = (target: HTMLCanvasElement) => {
      const c = get2DContext(target);
      if (!c) return;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      if (selection.mask && selection.maskWidth && selection.maskHeight) {
        const maskCanvas = document.createElement('canvas');
        maskCanvas.width = selection.maskWidth;
        maskCanvas.height = selection.maskHeight;
        const mCtx = maskCanvas.getContext('2d');
        if (mCtx) {
          mCtx.fillStyle = primaryColor;
          mCtx.fillRect(0, 0, selection.maskWidth, selection.maskHeight);
          const mImg = mCtx.getImageData(0, 0, selection.maskWidth, selection.maskHeight);
          const count = Math.min(selection.mask.length, selection.maskWidth * selection.maskHeight);
          for (let i = 0; i < count; i++) {
            mImg.data[i * 4 + 3] = Math.round((mImg.data[i * 4 + 3] * selection.mask[i]) / 255);
          }
          mCtx.putImageData(mImg, 0, 0);
          c.drawImage(maskCanvas, 0, 0);
        }
      } else {
        c.fillStyle = primaryColor;
        if (selection.type === 'rect') {
          c.fillRect(
            selection.bounds.x,
            selection.bounds.y,
            selection.bounds.width,
            selection.bounds.height
          );
        } else if (
          selection.type === 'lasso' &&
          selection.polygon &&
          selection.polygon.length >= 3
        ) {
          c.beginPath();
          c.moveTo(selection.polygon[0].x, selection.polygon[0].y);
          for (let i = 1; i < selection.polygon.length; i++) {
            c.lineTo(selection.polygon[i].x, selection.polygon[i].y);
          }
          c.closePath();
          c.fill();
        }
      }
      c.restore();
    };

    fillOn(canvas);
    markCanvasPopulated(canvas);
    if (sourceCanvas) {
      fillOn(sourceCanvas);
      markCanvasPopulated(sourceCanvas);
      if (activeLayer?.toneEnabled) {
        applyLayerEffects(
          sourceCanvas,
          canvas,
          activeLayer,
          dimensions.dpi ?? 600,
          selection.bounds
        );
      }
    }

    const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    updateLayerThumbnail(activeLayerId, true);
    pushHistoryStep('fill', 'Fill Selection', beforeImageData, afterImageData, activeLayerId);
    getGrid().notifyChange(true);
  }, [
    selection,
    getSyncedLayerCanvas,
    activeLayerId,
    activeLayer,
    layerSourceCanvasesRef,
    markCanvasPopulated,
    getGrid,
    dimensions.dpi,
    updateLayerThumbnail,
    pushHistoryStep,
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
    if (activeLayer?.locked || (activeLayer && activeLayer.type !== 'raster')) {
      showToast('Select an unlocked raster layer to transform');
      return;
    }

    const grid = getGrid();

    if (selection) {
      let floatCanvas = selection.floating?.canvas;
      const targetLayerId = selection.floating?.layerId || activeLayerId;
      const isBg = targetLayerId === 'layer-bg' || targetLayerId.startsWith('layer-bg');
      const canvas = floatCanvas
        ? layerCanvasesRef.current.get(targetLayerId) ||
          materializeLayerCanvas?.(targetLayerId) ||
          getActiveCanvas()
        : getSyncedLayerCanvas(targetLayerId);
      if (!canvas) return;
      const ctx = get2DContext(canvas);
      if (!ctx) return;

      let floatX = selection.floating?.x ?? selection.bounds.x;
      let floatY = selection.floating?.y ?? selection.bounds.y;
      let beforeData = selection.floating?.beforeImageData;

      if (!floatCanvas) {
        const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
        const lifted = liftSelectionToFloating(canvas, selection, sourceCanvas, isBg);
        if (!lifted) return;
        floatCanvas = lifted.floatingCanvas;
        floatX = lifted.bounds.x;
        floatY = lifted.bounds.y;
        beforeData = lifted.beforeImageData;
        markCanvasPopulated(canvas);
        markCanvasPopulated(sourceCanvas);
        const targetLayer = layers.find((l) => l.id === targetLayerId);
        const isMono = colorMode === 'monochrome' || targetLayer?.expressionColor === 'monochrome';
        grid.ingestCanvas(targetLayerId, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
        grid.notifyChange(true);
        updateLayerThumbnail(targetLayerId, true);
      }

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
        beforeImageData: beforeData || ctx.getImageData(0, 0, canvas.width, canvas.height),
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
    } else {
      const isMultiLayer = selectedLayerIds && selectedLayerIds.length > 1;
      const multiTargetLayers = isMultiLayer
        ? layers.filter((l) => selectedLayerIds.includes(l.id) && l.type === 'raster' && !l.locked)
        : [];

      if (isMultiLayer && multiTargetLayers.length > 1) {
        const layerBeforeImages = new Map<string, ImageData>();
        const layerSourceCanvases = new Map<string, HTMLCanvasElement>();

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const lyr of multiTargetLayers) {
          const c = getSyncedLayerCanvas(lyr.id);
          if (!c) continue;
          const cCtx = get2DContext(c);
          if (!cCtx) continue;
          const bData = cCtx.getImageData(0, 0, c.width, c.height);
          layerBeforeImages.set(lyr.id, bData);

          const cb = getCanvasContentBounds(
            c,
            lyr.id === 'layer-bg' || lyr.id.startsWith('layer-bg')
          );
          if (cb) {
            minX = Math.min(minX, cb.x);
            minY = Math.min(minY, cb.y);
            maxX = Math.max(maxX, cb.x + cb.width);
            maxY = Math.max(maxY, cb.y + cb.height);
          }
        }

        if (!isFinite(minX) || !isFinite(minY) || maxX <= minX || maxY <= minY) {
          showToast('Selected layers are empty');
          return;
        }

        const b = {
          x: Math.max(0, minX),
          y: Math.max(0, minY),
          width: Math.max(1, maxX - minX),
          height: Math.max(1, maxY - minY),
        };

        const compositeCanvas = document.createElement('canvas');
        compositeCanvas.width = b.width;
        compositeCanvas.height = b.height;
        const compCtx = get2DContext(compositeCanvas);

        const orderedLayers = multiTargetLayers.slice().reverse();
        for (const lyr of orderedLayers) {
          const c = layerCanvasesRef.current.get(lyr.id);
          if (!c) continue;
          const cCtx = get2DContext(c);
          if (!cCtx) continue;

          const sCanvas = document.createElement('canvas');
          sCanvas.width = b.width;
          sCanvas.height = b.height;
          const sCtx = get2DContext(sCanvas);
          if (sCtx) {
            sCtx.drawImage(c, -b.x, -b.y);
            layerSourceCanvases.set(lyr.id, sCanvas);
          }

          if (compCtx) {
            compCtx.save();
            compCtx.globalAlpha = lyr.opacity;
            compCtx.drawImage(sCanvas, 0, 0);
            compCtx.restore();
          }

          const isLayerBg = lyr.id === 'layer-bg' || lyr.id.startsWith('layer-bg');
          cCtx.save();
          cCtx.setTransform(1, 0, 0, 1, 0, 0);
          if (isLayerBg) {
            cCtx.fillStyle = '#ffffff';
            cCtx.fillRect(b.x, b.y, b.width, b.height);
          } else {
            cCtx.clearRect(b.x, b.y, b.width, b.height);
          }
          cCtx.restore();
          markCanvasPopulated(c);

          const existingSrc = layerSourceCanvasesRef.current?.get(lyr.id);
          if (existingSrc) {
            const escCtx = get2DContext(existingSrc);
            if (escCtx) {
              escCtx.save();
              escCtx.setTransform(1, 0, 0, 1, 0, 0);
              if (isLayerBg) {
                escCtx.fillStyle = '#ffffff';
                escCtx.fillRect(b.x, b.y, b.width, b.height);
              } else {
                escCtx.clearRect(b.x, b.y, b.width, b.height);
              }
              escCtx.restore();
            }
            markCanvasPopulated(existingSrc);
          }
          const isMono = colorMode === 'monochrome' || lyr.expressionColor === 'monochrome';
          grid.ingestCanvas(lyr.id, c, isMono ? 'monochrome-1bit' : 'color-32bit');
          updateLayerThumbnail(lyr.id, true);
        }
        grid.notifyChange(true);

        const quad = createDefaultPerspectiveQuad(b.x, b.y, b.width, b.height, 0);
        setTransformSession({
          active: true,
          layerId: activeLayerId,
          layerIds: multiTargetLayers.map((l) => l.id),
          layerSourceCanvases,
          layerBeforeImages,
          sourceCanvas: compositeCanvas,
          beforeImageData:
            layerBeforeImages.get(activeLayerId) || Array.from(layerBeforeImages.values())[0],
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
        toolStoreActions.setToolRaw('transform');
        return;
      }

      const isBg = activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg');
      const canvas = getSyncedLayerCanvas(activeLayerId);
      if (!canvas) return;
      const ctx = get2DContext(canvas);
      if (!ctx) return;

      const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const contentBounds = getCanvasContentBounds(canvas, isBg);
      let b = contentBounds;
      if (!b) {
        if (isBg) {
          b = { x: 0, y: 0, width: canvas.width, height: canvas.height };
        } else {
          showToast('Active layer is empty');
          return;
        }
      }

      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = b.width;
      sourceCanvas.height = b.height;
      const sCtx = get2DContext(sourceCanvas);
      if (sCtx) {
        const sliceData = ctx.getImageData(b.x, b.y, b.width, b.height);
        sCtx.putImageData(sliceData, 0, 0);
      }

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (isBg) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(b.x, b.y, b.width, b.height);
      } else {
        ctx.clearRect(b.x, b.y, b.width, b.height);
      }
      ctx.restore();
      markCanvasPopulated(canvas);

      const existingSourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);
      if (existingSourceCanvas) {
        const escCtx = get2DContext(existingSourceCanvas);
        if (escCtx) {
          escCtx.save();
          escCtx.setTransform(1, 0, 0, 1, 0, 0);
          if (isBg) {
            escCtx.fillStyle = '#ffffff';
            escCtx.fillRect(b.x, b.y, b.width, b.height);
          } else {
            escCtx.clearRect(b.x, b.y, b.width, b.height);
          }
          escCtx.restore();
        }
        markCanvasPopulated(existingSourceCanvas);
      }

      const isMono = colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome';
      grid.ingestCanvas(activeLayerId, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
      grid.notifyChange(true);
      updateLayerThumbnail(activeLayerId, true);

      const quad = createDefaultPerspectiveQuad(b.x, b.y, b.width, b.height, 0);
      setTransformSession({
        active: true,
        layerId: activeLayerId,
        sourceCanvas,
        beforeImageData,
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
    getGrid,
    getSyncedLayerCanvas,
    materializeLayerCanvas,
    getActiveCanvas,
    markCanvasPopulated,
    selection,
    activeLayerId,
    activeLayer,
    colorMode,
    selectedLayerIds,
    layers,
    layerCanvasesRef,
    layerSourceCanvasesRef,
    updateLayerThumbnail,
    showToast,
  ]);

  const handleApplyTransform = useCallback(() => {
    if (!transformSession) return;
    const grid = getGrid();

    if (
      transformSession.layerIds &&
      transformSession.layerIds.length > 1 &&
      transformSession.layerSourceCanvases
    ) {
      for (const lId of transformSession.layerIds) {
        const c = layerCanvasesRef.current.get(lId) || materializeLayerCanvas?.(lId);
        const sCanvas = transformSession.layerSourceCanvases.get(lId);
        if (!c || !sCanvas) continue;
        const cCtx = get2DContext(c);
        if (!cCtx) continue;

        const drawLayerTransformed = (targetCtx: CanvasRenderingContext2D) => {
          targetCtx.save();
          targetCtx.setTransform(1, 0, 0, 1, 0, 0);
          if (transformSession.mode === 'perspective' && transformSession.perspectiveQuad) {
            renderPerspectiveQuad(targetCtx, sCanvas, transformSession.perspectiveQuad, 24);
          } else if (transformSession.mode === 'mesh' && transformSession.meshPoints) {
            renderMeshWarp(targetCtx, sCanvas, transformSession.meshPoints, 6);
          } else {
            const cx = transformSession.x + transformSession.width / 2;
            const cy = transformSession.y + transformSession.height / 2;
            targetCtx.translate(cx, cy);
            targetCtx.rotate((transformSession.rotation * Math.PI) / 180);
            targetCtx.scale(transformSession.flipH ? -1 : 1, transformSession.flipV ? -1 : 1);
            targetCtx.drawImage(
              sCanvas,
              -transformSession.width / 2,
              -transformSession.height / 2,
              transformSession.width,
              transformSession.height
            );
          }
          targetCtx.restore();
        };

        drawLayerTransformed(cCtx);
        markCanvasPopulated(c);

        const existingSrc = layerSourceCanvasesRef.current?.get(lId);
        if (existingSrc) {
          const sCtx = get2DContext(existingSrc);
          if (sCtx) drawLayerTransformed(sCtx);
          markCanvasPopulated(existingSrc);
        }

        const lyr = layers.find((l) => l.id === lId);
        if (lyr?.toneEnabled && existingSrc) {
          applyScreentone(existingSrc, c, {
            frequency: lyr.toneFrequency ?? 60,
            angle: lyr.toneAngle ?? 45,
            dotShape: lyr.toneDotShape ?? 'circle',
            dpi: dimensions.dpi ?? 600,
          });
        }

        const beforeDataForLayer = transformSession.layerBeforeImages?.get(lId);
        const afterDataForLayer = cCtx.getImageData(0, 0, c.width, c.height);
        const isMono = colorMode === 'monochrome' || lyr?.expressionColor === 'monochrome';
        grid.ingestCanvas(lId, c, isMono ? 'monochrome-1bit' : 'color-32bit');
        if (beforeDataForLayer) {
          pushHistoryStep(
            'transform',
            'Batch Free Transform',
            beforeDataForLayer,
            afterDataForLayer,
            lId
          );
        }
        updateLayerThumbnail(lId, true);
      }

      grid.notifyChange(true);
      setTransformSession(null);
      toolStoreActions.setToolRaw('brush');
      return;
    }

    const canvas =
      layerCanvasesRef.current.get(transformSession.layerId) ||
      materializeLayerCanvas?.(transformSession.layerId) ||
      getActiveCanvas();
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const sourceCanvas = layerSourceCanvasesRef.current?.get(transformSession.layerId);

    const drawTransformed = (targetCtx: CanvasRenderingContext2D) => {
      targetCtx.save();
      targetCtx.setTransform(1, 0, 0, 1, 0, 0);
      if (transformSession.mode === 'perspective' && transformSession.perspectiveQuad) {
        renderPerspectiveQuad(
          targetCtx,
          transformSession.sourceCanvas,
          transformSession.perspectiveQuad,
          24
        );
      } else if (transformSession.mode === 'mesh' && transformSession.meshPoints) {
        renderMeshWarp(targetCtx, transformSession.sourceCanvas, transformSession.meshPoints, 6);
      } else {
        const cx = transformSession.x + transformSession.width / 2;
        const cy = transformSession.y + transformSession.height / 2;
        targetCtx.translate(cx, cy);
        targetCtx.rotate((transformSession.rotation * Math.PI) / 180);
        targetCtx.scale(transformSession.flipH ? -1 : 1, transformSession.flipV ? -1 : 1);
        targetCtx.drawImage(
          transformSession.sourceCanvas,
          -transformSession.width / 2,
          -transformSession.height / 2,
          transformSession.width,
          transformSession.height
        );
      }
      targetCtx.restore();
    };

    drawTransformed(ctx);
    markCanvasPopulated(canvas);
    if (sourceCanvas) {
      const sCtx = get2DContext(sourceCanvas);
      if (sCtx) drawTransformed(sCtx);
      markCanvasPopulated(sourceCanvas);
    }

    const layer = layers.find((l) => l.id === transformSession.layerId);
    if (layer?.toneEnabled && sourceCanvas) {
      applyScreentone(sourceCanvas, canvas, {
        frequency: layer.toneFrequency ?? 60,
        angle: layer.toneAngle ?? 45,
        dotShape: layer.toneDotShape ?? 'circle',
        dpi: dimensions.dpi ?? 600,
      });
    }

    const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    if (transformSession.beforeImageData) {
      pushHistoryStep(
        'transform',
        'Free Transform',
        transformSession.beforeImageData,
        afterImageData,
        transformSession.layerId
      );
    } else {
      const isMono = colorMode === 'monochrome' || layer?.expressionColor === 'monochrome';
      grid.ingestCanvas(transformSession.layerId, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
    }
    grid.notifyChange(true);

    updateLayerThumbnail(transformSession.layerId, true);
    setTransformSession(null);
    toolStoreActions.setToolRaw('brush');
  }, [
    transformSession,
    getGrid,
    colorMode,
    layerCanvasesRef,
    materializeLayerCanvas,
    getActiveCanvas,
    markCanvasPopulated,
    layers,
    layerSourceCanvasesRef,
    dimensions.dpi,
    pushHistoryStep,
    updateLayerThumbnail,
  ]);

  const handleCancelTransform = useCallback(() => {
    if (!transformSession) return;
    const grid = getGrid();

    if (transformSession.layerBeforeImages && transformSession.layerBeforeImages.size > 0) {
      for (const [lId, beforeData] of transformSession.layerBeforeImages.entries()) {
        const c = layerCanvasesRef.current.get(lId) || materializeLayerCanvas?.(lId);
        if (c && beforeData) {
          const ctx = get2DContext(c);
          ctx?.putImageData(beforeData, 0, 0);
          markCanvasPopulated(c);

          const lyr = layers.find((l) => l.id === lId);
          const sourceCanvas = layerSourceCanvasesRef.current?.get(lId);
          if (sourceCanvas) {
            const sCtx = get2DContext(sourceCanvas);
            sCtx?.putImageData(beforeData, 0, 0);
            markCanvasPopulated(sourceCanvas);

            if (lyr?.toneEnabled) {
              applyScreentone(sourceCanvas, c, {
                frequency: lyr.toneFrequency ?? 60,
                angle: lyr.toneAngle ?? 45,
                dotShape: lyr.toneDotShape ?? 'circle',
                dpi: dimensions.dpi ?? 600,
              });
            }
          }
          const isMono = colorMode === 'monochrome' || lyr?.expressionColor === 'monochrome';
          grid.ingestCanvas(lId, c, isMono ? 'monochrome-1bit' : 'color-32bit');
          updateLayerThumbnail(lId, true);
        }
      }
      grid.notifyChange(true);
      setTransformSession(null);
      toolStoreActions.setToolRaw('brush');
      return;
    }

    const canvas =
      layerCanvasesRef.current.get(transformSession.layerId) ||
      materializeLayerCanvas?.(transformSession.layerId) ||
      getActiveCanvas();
    if (canvas && transformSession.beforeImageData) {
      const ctx = get2DContext(canvas);
      ctx?.putImageData(transformSession.beforeImageData, 0, 0);
      markCanvasPopulated(canvas);

      const layer = layers.find((l) => l.id === transformSession.layerId);
      const sourceCanvas = layerSourceCanvasesRef.current?.get(transformSession.layerId);
      if (sourceCanvas) {
        const sCtx = get2DContext(sourceCanvas);
        sCtx?.putImageData(transformSession.beforeImageData, 0, 0);
        markCanvasPopulated(sourceCanvas);

        if (layer?.toneEnabled) {
          applyScreentone(sourceCanvas, canvas, {
            frequency: layer.toneFrequency ?? 60,
            angle: layer.toneAngle ?? 45,
            dotShape: layer.toneDotShape ?? 'circle',
            dpi: dimensions.dpi ?? 600,
          });
        }
      }
      const isMono = colorMode === 'monochrome' || layer?.expressionColor === 'monochrome';
      grid.ingestCanvas(
        transformSession.layerId,
        canvas,
        isMono ? 'monochrome-1bit' : 'color-32bit'
      );
      grid.notifyChange(true);
      updateLayerThumbnail(transformSession.layerId, true);
    }
    setTransformSession(null);
    toolStoreActions.setToolRaw('brush');
  }, [
    transformSession,
    getGrid,
    colorMode,
    layerCanvasesRef,
    materializeLayerCanvas,
    getActiveCanvas,
    markCanvasPopulated,
    layers,
    layerSourceCanvasesRef,
    dimensions.dpi,
    updateLayerThumbnail,
  ]);

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

        let sampleCanvas: HTMLCanvasElement | null = null;
        if (wandSettings.referMode === 'all') {
          flushPendingHistoryTasks?.();
          sampleCanvas = compositeVisibleLayers(layers, layerCanvasesRef.current, dimensions, getGrid());
        } else if (wandSettings.referMode === 'reference') {
          const refLayer = layers.find((l) => l.isReference && l.visible);
          if (refLayer) {
            sampleCanvas = getSyncedLayerCanvas(refLayer.id);
          } else {
            sampleCanvas = getSyncedLayerCanvas(activeLayerId);
          }
        } else {
          sampleCanvas = getSyncedLayerCanvas(activeLayerId);
        }

        if (!sampleCanvas) return true;
        const sCtx = get2DContext(sampleCanvas);
        if (!sCtx) return true;

        const w = dimensions.width;
        const h = dimensions.height;
        const sampleImageData = sCtx.getImageData(0, 0, w, h);
        const { mask, bounds } = floodSelectWand(sampleImageData, w, h, px, py, wandSettings);

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

        isSelectionPenDrawingRef.current = true;
        selectionPenDrawingRef.current = {
          isDrawing: true,
          lastPt: pt,
          maskCanvas,
          ctx: mCtx,
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
            const canvas = getSyncedLayerCanvas(activeLayerId);
            if (!canvas) return true;
            const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);
            const isBg = activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg');
            const lifted = liftSelectionToFloating(canvas, selection, sourceCanvas, isBg);
            if (lifted) {
              markCanvasPopulated(canvas);
              markCanvasPopulated(sourceCanvas);
              const grid = getGrid();
              const isMono =
                colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome';
              grid.ingestCanvas(activeLayerId, canvas, isMono ? 'monochrome-1bit' : 'color-32bit');
              grid.notifyChange(true);
              updateLayerThumbnail(activeLayerId, true);
              const floatingObj = {
                canvas: lifted.floatingCanvas,
                x: lifted.bounds.x,
                y: lifted.bounds.y,
                origX: lifted.bounds.x,
                origY: lifted.bounds.y,
                layerId: activeLayerId,
                beforeImageData: lifted.beforeImageData,
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
          selectRectStartRef.current = pt;
          setSelection({
            type: 'rect',
            bounds: { x: pt.x, y: pt.y, width: 0, height: 0 },
          });
        } else {
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
      getSyncedLayerCanvas,
      markCanvasPopulated,
      dimensions,
      layers,
      layerCanvasesRef,
      activeLayerId,
      layerSourceCanvasesRef,
      colorMode,
      activeLayer,
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
      return true;
    }

    if (selectionDragRef.current?.isDragging) {
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
    (pt: { x: number; y: number }): boolean => {
      const { tool } = useToolStore.getState();

      if (
        (tool === 'select-pen' || tool === 'select-eraser') &&
        selectionPenDrawingRef.current?.isDrawing
      ) {
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
