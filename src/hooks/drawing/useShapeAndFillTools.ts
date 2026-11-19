import React, { useState, useRef, useCallback } from 'react';
import {
  CanvasColorMode,
  CanvasDimensions,
  CanvasSelection,
  ComicFrame,
  FrameDivideMode,
  LayerItem,
  SpeechBalloon,
  TextLayerData,
  TextSettings,
} from '../../types/editor';
import { documentStore } from '../../utils/documentStore';
import {
  executeFloodFill,
  compositeVisibleLayers,
  compositeReferenceLayers,
  executeLassoFill,
} from '../../utils/floodFill';
import { applyLiquifyStep, createLiquifySelectionMask, DirtyRect } from '../../utils/liquifyEngine';
import { applyLayerEffects } from '../../utils/layerEffectsEngine';
import { createSelectionMask } from '../../utils/tonalEngine';
import { get2DContext, sampleCompositedColor } from '../../utils/canvasUtils';
import { createDefaultSpeechBalloon } from '../../utils/balloonEngine';
import {
  createRectFrame,
  doesCutSegmentCrossFrame,
  MANGA_GUTTER_HORIZONTAL_MM,
  MANGA_GUTTER_VERTICAL_MM,
  mmToPixels,
  Point2D,
} from '../../utils/frameEngine';
import { hitTestEditableVectorLayer } from '../../utils/vectorLayerRenderer';
import { useToolStore, toolStoreActions } from '../../stores';
import { PushHistoryStepFn } from './types';

export interface TextPlacementSession {
  x: number;
  y: number;
  settings: TextSettings;
  editingLayerId?: string | null;
}

export interface FrameDragPreview {
  mode: 'create' | 'divide';
  start: Point2D;
  end: Point2D;
}

export interface UseShapeAndFillToolsParams {
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  activeLayer: LayerItem | undefined;
  activeLayerId: string;
  selection: CanvasSelection | null;
  layerCanvasesRef: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  layerSourceCanvasesRef: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean;
  getEffectiveOpacity: (layer: LayerItem) => number;
  getActiveCanvas: () => HTMLCanvasElement | null;
  getCanvasCoords: (e: React.PointerEvent<HTMLElement> | PointerEvent) => { x: number; y: number };
  setActiveLayerId: (id: string) => void;
  upsertTextLayer: (textData: TextLayerData, editingLayerId?: string | null) => LayerItem;
  upsertBalloonLayer: (balloonData: SpeechBalloon, editingLayerId?: string | null) => LayerItem;
  createFrameFolder: (
    frames: ComicFrame[],
    customName?: string,
    addInitialChildLayer?: boolean
  ) => { folder: LayerItem; childLayer: LayerItem | null };
  divideFrameFolder: (
    folderId: string,
    cutStart: Point2D,
    cutEnd: Point2D,
    dpi?: number,
    mode?: FrameDivideMode
  ) => boolean;
  deleteLayer?: (id: string) => void;
  updateLayerThumbnail: (layerId: string, immediate?: boolean) => void;
  pushHistoryStep: PushHistoryStepFn;
  showToast?: (msg: string) => void;
}

export interface UseShapeAndFillToolsResult {
  textSession: TextPlacementSession | null;
  setTextSession: React.Dispatch<React.SetStateAction<TextPlacementSession | null>>;
  activeBalloon: SpeechBalloon | null;
  setActiveBalloon: React.Dispatch<React.SetStateAction<SpeechBalloon | null>>;
  frameDragPreview: FrameDragPreview | null;
  openLayerForEditing: (layer: LayerItem) => boolean;
  isPipetteSamplingRef: React.MutableRefObject<boolean>;
  handleSampleColor: (pt: { x: number; y: number }) => void;
  handleConfirmText: () => void;
  handleCancelText: () => void;
  handleConfirmBalloon: () => void;
  handleDeleteBalloon: () => void;
  handleShapeFillPointerDown: (
    e: React.PointerEvent<HTMLElement>,
    pt: { x: number; y: number }
  ) => boolean;
  handleShapeFillPointerMove: (e: React.PointerEvent<HTMLElement>) => boolean;
  handleShapeFillPointerUp: (
    e: React.PointerEvent<HTMLElement>,
    pt: { x: number; y: number }
  ) => boolean;
}

export function useShapeAndFillTools({
  dimensions,
  colorMode,
  layers,
  activeLayer,
  activeLayerId,
  selection,
  layerCanvasesRef,
  layerSourceCanvasesRef,
  isLayerEffectivelyVisible,
  getEffectiveOpacity,
  getActiveCanvas,
  getCanvasCoords,
  setActiveLayerId,
  upsertTextLayer,
  upsertBalloonLayer,
  createFrameFolder,
  divideFrameFolder,
  deleteLayer,
  updateLayerThumbnail,
  pushHistoryStep,
  showToast,
}: UseShapeAndFillToolsParams): UseShapeAndFillToolsResult {
  const [textSession, setTextSession] = useState<TextPlacementSession | null>(null);
  const [activeBalloon, setActiveBalloon] = useState<SpeechBalloon | null>(null);
  const [editingBalloonLayerId, setEditingBalloonLayerId] = useState<string | null>(null);
  const [frameDragPreview, setFrameDragPreview] = useState<FrameDragPreview | null>(null);

  const isPipetteSamplingRef = useRef<boolean>(false);
  const lassoFillPointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const frameStartRef = useRef<{ x: number; y: number } | null>(null);

  const openLayerForEditing = useCallback(
    (layer: LayerItem): boolean => {
      if (layer.locked) {
        showToast?.('Layer is locked');
        return false;
      }
      if (layer.type === 'text' && layer.textData) {
        setActiveLayerId(layer.id);
        setActiveBalloon(null);
        setEditingBalloonLayerId(null);
        const td = layer.textData;
        setTextSession({
          x: td.x,
          y: td.y,
          editingLayerId: layer.id,
          settings: {
            text: td.text,
            fontFamily: td.fontFamily,
            fontSize: td.fontSize,
            lineSpacing: td.lineSpacing ?? 1.25,
            bold: td.bold,
            italic: td.italic,
            align: td.align,
            outline: td.outline,
            outlineColor: td.outlineColor,
            outlineWidth: td.outlineWidth,
            color: td.color,
            writingMode: td.writingMode || 'horizontal-tb',
          },
        });
        return true;
      }
      if (layer.type === 'balloon' && layer.balloonData) {
        setActiveLayerId(layer.id);
        setTextSession(null);
        setEditingBalloonLayerId(layer.id);
        setActiveBalloon(JSON.parse(JSON.stringify(layer.balloonData)));
        return true;
      }
      return false;
    },
    [setActiveLayerId, showToast]
  );

  const isLiquifyingRef = useRef<boolean>(false);
  const prevLiquifyPointRef = useRef<{ x: number; y: number } | null>(null);
  const liquifyBeforeImageDataRef = useRef<ImageData | null>(null);
  const liquifyInitialImageDataRef = useRef<ImageData | null>(null);
  const liquifyDirtyRectRef = useRef<DirtyRect | null>(null);
  const liquifyRafIdRef = useRef<number | null>(null);
  const liquifyLastPointerPosRef = useRef<{
    pt: { x: number; y: number };
    pressure: number;
  } | null>(null);
  const liquifySelectionMaskRef = useRef<Uint8Array | null>(null);

  const handleSampleColor = useCallback(
    (pt: { x: number; y: number }) => {
      const sampled = sampleCompositedColor(
        layers,
        layerCanvasesRef.current,
        pt.x,
        pt.y,
        isLayerEffectivelyVisible,
        getEffectiveOpacity,
        dimensions.width,
        dimensions.height,
        selection?.floating
      );
      if (sampled) {
        toolStoreActions.setPrimaryColor(sampled, true, colorMode);
      }
    },
    [
      layers,
      layerCanvasesRef,
      isLayerEffectivelyVisible,
      getEffectiveOpacity,
      dimensions.width,
      dimensions.height,
      selection?.floating,
      colorMode,
    ]
  );

  const handleConfirmText = useCallback(() => {
    if (!textSession || !textSession.settings.text.trim()) {
      setTextSession(null);
      return;
    }
    const textData: TextLayerData = {
      ...textSession.settings,
      lineSpacing: textSession.settings.lineSpacing ?? 1.25,
      x: textSession.x,
      y: textSession.y,
    };
    const savedLayer = upsertTextLayer(textData, textSession.editingLayerId);
    pushHistoryStep(
      'text',
      textSession.editingLayerId ? 'Edit Text Layer' : 'Create Text Layer',
      null,
      null,
      savedLayer.id
    );
    setTextSession(null);
  }, [textSession, upsertTextLayer, pushHistoryStep]);

  const handleCancelText = useCallback(() => {
    setTextSession(null);
  }, []);

  const handleConfirmBalloon = useCallback(() => {
    if (!activeBalloon) return;
    const savedLayer = upsertBalloonLayer(activeBalloon, editingBalloonLayerId);
    pushHistoryStep(
      'balloon',
      editingBalloonLayerId ? 'Edit Speech Balloon' : 'Create Speech Balloon',
      null,
      null,
      savedLayer.id
    );
    setActiveBalloon(null);
    setEditingBalloonLayerId(null);
  }, [activeBalloon, editingBalloonLayerId, upsertBalloonLayer, pushHistoryStep]);

  const handleDeleteBalloon = useCallback(() => {
    if (editingBalloonLayerId && deleteLayer) {
      deleteLayer(editingBalloonLayerId);
    }
    setActiveBalloon(null);
    setEditingBalloonLayerId(null);
  }, [editingBalloonLayerId, deleteLayer]);

  const startLiquifyLoop = useCallback(
    (canvas: HTMLCanvasElement, sourceCanvas: HTMLCanvasElement | undefined, isTone: boolean) => {
      if (liquifyRafIdRef.current) cancelAnimationFrame(liquifyRafIdRef.current);

      const tick = () => {
        if (!isLiquifyingRef.current || !liquifyLastPointerPosRef.current) {
          liquifyRafIdRef.current = null;
          return;
        }
        const { pt, pressure } = liquifyLastPointerPosRef.current;
        const liquifySettings = useToolStore.getState().liquifySettings;
        const dirty = applyLiquifyStep({
          canvas,
          sourceCanvas: isTone ? sourceCanvas : undefined,
          cx: pt.x,
          cy: pt.y,
          prevX: pt.x,
          prevY: pt.y,
          settings: liquifySettings,
          pressure,
          initialImageData: liquifyInitialImageDataRef.current,
          selectionMask: liquifySelectionMaskRef.current,
        });

        if (dirty) {
          if (activeLayer?.toneEnabled && sourceCanvas) {
            const displayCanvas = layerCanvasesRef.current.get(activeLayerId);
            if (displayCanvas) {
              applyLayerEffects(
                sourceCanvas,
                displayCanvas,
                activeLayer,
                dimensions.dpi ?? 600,
                dirty
              );
            }
          } else {
            const dCtx = get2DContext(canvas);
            if (dCtx && dirty.width > 0 && dirty.height > 0) {
              const subData = dCtx.getImageData(dirty.x, dirty.y, dirty.width, dirty.height);
              const isMono =
                colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome';
              documentStore
                .getActiveTileGrid()
                .writeImageData(
                  activeLayerId,
                  subData,
                  dirty.x,
                  dirty.y,
                  isMono ? 'monochrome-1bit' : 'color-32bit'
                );
            }
          }
          documentStore.getActiveTileGrid().notifyChange(true);
        }

        liquifyRafIdRef.current = requestAnimationFrame(tick);
      };

      liquifyRafIdRef.current = requestAnimationFrame(tick);
    },
    [activeLayer, activeLayerId, colorMode, dimensions.dpi, layerCanvasesRef]
  );

  const handleShapeFillPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, pt: { x: number; y: number }): boolean => {
      const {
        tool,
        primaryColor,
        fillSettings,
        textSettings,
        balloonSettings,
        liquifySettings,
      } = useToolStore.getState();

      if (tool === 'pipette') {
        e.preventDefault();
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          // Ignore pointer capture errors
        }
        isPipetteSamplingRef.current = true;
        handleSampleColor(pt);
        return true;
      }

      if (tool === 'liquify') {
        e.preventDefault();
        if (
          !activeLayer ||
          activeLayer.locked ||
          (activeLayer && !isLayerEffectivelyVisible(activeLayer))
        ) {
          return true;
        }
        const targetLayerId = activeLayerId;
        const isTone = Boolean(
          activeLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId)
        );
        const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
        const displayCanvas = layerCanvasesRef.current.get(targetLayerId);
        const canvas = isTone && sourceCanvas ? sourceCanvas : displayCanvas;
        if (!canvas) return true;

        const ctx = get2DContext(canvas);
        if (!ctx) return true;

        isLiquifyingRef.current = true;
        prevLiquifyPointRef.current = pt;
        liquifyBeforeImageDataRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
        liquifyInitialImageDataRef.current = liquifyBeforeImageDataRef.current;
        liquifySelectionMaskRef.current = createLiquifySelectionMask(
          selection,
          canvas.width,
          canvas.height
        );
        liquifyDirtyRectRef.current = null;
        liquifyLastPointerPosRef.current = { pt, pressure: e.pressure || 1.0 };

        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          // Ignore pointer capture errors
        }

        const mode = liquifySettings.mode;
        if (
          mode === 'expand' ||
          mode === 'pinch' ||
          mode === 'twirl-cw' ||
          mode === 'twirl-ccw' ||
          mode === 'reconstruct'
        ) {
          const dirty = applyLiquifyStep({
            canvas,
            sourceCanvas: isTone ? sourceCanvas : undefined,
            cx: pt.x,
            cy: pt.y,
            prevX: pt.x,
            prevY: pt.y,
            settings: liquifySettings,
            pressure: e.pressure || 1.0,
            initialImageData: liquifyInitialImageDataRef.current,
            selectionMask: liquifySelectionMaskRef.current,
          });
          if (dirty) {
            liquifyDirtyRectRef.current = dirty;
            if (activeLayer?.toneEnabled && sourceCanvas && displayCanvas) {
              applyLayerEffects(
                sourceCanvas,
                displayCanvas,
                activeLayer,
                dimensions.dpi ?? 600,
                dirty
              );
            } else if (dirty.width > 0 && dirty.height > 0) {
              const subData = ctx.getImageData(dirty.x, dirty.y, dirty.width, dirty.height);
              const isMono =
                colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome';
              documentStore
                .getActiveTileGrid()
                .writeImageData(
                  targetLayerId,
                  subData,
                  dirty.x,
                  dirty.y,
                  isMono ? 'monochrome-1bit' : 'color-32bit'
                );
            }
            documentStore.getActiveTileGrid().notifyChange(true);
          }
          startLiquifyLoop(canvas, sourceCanvas, isTone);
        }
        return true;
      }

      if (tool === 'fill') {
        e.preventDefault();
        if (fillSettings.method === 'lasso') {
          lassoFillPointsRef.current = [pt];
          return true;
        }

        const px = Math.floor(pt.x);
        const py = Math.floor(pt.y);
        if (px < 0 || px >= dimensions.width || py < 0 || py >= dimensions.height) return true;

        const canvas = getActiveCanvas();
        if (
          !canvas ||
          activeLayer?.locked ||
          (activeLayer && !isLayerEffectivelyVisible(activeLayer))
        ) {
          return true;
        }

        const ctx = get2DContext(canvas);
        if (!ctx) return true;
        const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

        let refCanvas: HTMLCanvasElement;
        if (fillSettings.method === 'refer-all') {
          refCanvas = compositeVisibleLayers(layers, layerCanvasesRef.current, dimensions);
        } else if (fillSettings.method === 'refer-reference') {
          refCanvas = compositeReferenceLayers(layers, layerCanvasesRef.current, dimensions);
        } else {
          refCanvas = canvas;
        }

        const selMask = selection
          ? createSelectionMask(selection, canvas.width, canvas.height)
          : null;
        const fillRes = executeFloodFill(
          canvas,
          refCanvas,
          px,
          py,
          primaryColor,
          fillSettings.tolerance,
          sourceCanvas,
          {
            closeGap: fillSettings.closeGap ?? 0,
            areaScale: fillSettings.areaScale ?? 0,
            antiAlias: fillSettings.antiAlias ?? true,
            selectionMask: selMask,
          }
        );
        if (activeLayer?.toneEnabled && sourceCanvas) {
          applyLayerEffects(
            sourceCanvas,
            canvas,
            activeLayer,
            dimensions.dpi ?? 600,
            fillRes.dirtyRect ?? undefined
          );
        }

        const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        updateLayerThumbnail(activeLayerId, true);
        pushHistoryStep('fill', 'Bucket Fill', beforeImageData, afterImageData, activeLayerId);
        documentStore.getActiveTileGrid().notifyChange(true);
        return true;
      }

      if (tool === 'frame') {
        e.preventDefault();
        const mode = useToolStore.getState().frameSettings.mode ?? 'create';
        frameStartRef.current = pt;
        setFrameDragPreview({ mode, start: pt, end: pt });
        return true;
      }

      if (tool === 'object') {
        e.preventDefault();
        const hit = hitTestEditableVectorLayer(layers, pt, isLayerEffectivelyVisible);
        if (hit) {
          openLayerForEditing(hit);
        } else {
          showToast?.('Click a Text or Speech Balloon layer to edit');
        }
        return true;
      }

      if (tool === 'text') {
        e.preventDefault();
        const hitText = hitTestEditableVectorLayer(layers, pt, isLayerEffectivelyVisible, 'text');
        if (hitText && openLayerForEditing(hitText)) {
          return true;
        }
        setActiveBalloon(null);
        setEditingBalloonLayerId(null);
        setTextSession({
          x: Math.round(pt.x),
          y: Math.round(pt.y),
          editingLayerId: null,
          settings: { ...textSettings, color: primaryColor || textSettings.color },
        });
        return true;
      }

      if (tool === 'balloon') {
        e.preventDefault();
        const hitBalloon = hitTestEditableVectorLayer(
          layers,
          pt,
          isLayerEffectivelyVisible,
          'balloon'
        );
        if (hitBalloon && openLayerForEditing(hitBalloon)) {
          return true;
        }
        setTextSession(null);
        const newBalloon = createDefaultSpeechBalloon(
          Math.round(pt.x - 100),
          Math.round(pt.y - 70),
          200,
          140,
          balloonSettings.shape
        );
        newBalloon.strokeWidth = balloonSettings.strokeWidth;
        newBalloon.strokeColor = primaryColor || '#000000';
        newBalloon.fillColor = balloonSettings.fillColor || '#ffffff';
        newBalloon.vertical = balloonSettings.vertical;
        setEditingBalloonLayerId(null);
        setActiveBalloon(newBalloon);
        return true;
      }

      return false;
    },
    [
      handleSampleColor,
      activeLayer,
      activeLayerId,
      isLayerEffectivelyVisible,
      layerSourceCanvasesRef,
      layerCanvasesRef,
      selection,
      dimensions,
      colorMode,
      startLiquifyLoop,
      getActiveCanvas,
      layers,
      updateLayerThumbnail,
      pushHistoryStep,
      openLayerForEditing,
      showToast,
    ]
  );

  const handleShapeFillPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>): boolean => {
      const { tool, fillSettings, liquifySettings } = useToolStore.getState();

      if (tool === 'pipette') {
        if (isPipetteSamplingRef.current) {
          const pt = getCanvasCoords(e);
          handleSampleColor(pt);
        }
        return true;
      }

      if (tool === 'liquify') {
        if (!isLiquifyingRef.current) return true;
        const pt = getCanvasCoords(e);
        const pressure = e.pressure || 1.0;
        liquifyLastPointerPosRef.current = { pt, pressure };

        const targetLayerId = activeLayerId;
        const isTone = Boolean(
          activeLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId)
        );
        const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
        const displayCanvas = layerCanvasesRef.current.get(targetLayerId);
        const canvas = isTone && sourceCanvas ? sourceCanvas : displayCanvas;
        if (!canvas) return true;

        const prev = prevLiquifyPointRef.current || pt;
        const dist = Math.hypot(pt.x - prev.x, pt.y - prev.y);
        const stepDist = Math.max(2, (liquifySettings.size / 2) * 0.25);
        const numSteps = Math.max(1, Math.ceil(dist / stepDist));

        let overallDirty: DirtyRect | null = null;
        for (let i = 1; i <= numSteps; i++) {
          const t = i / numSteps;
          const cx = prev.x + (pt.x - prev.x) * t;
          const cy = prev.y + (pt.y - prev.y) * t;
          const px = prev.x + (pt.x - prev.x) * ((i - 1) / numSteps);
          const py = prev.y + (pt.y - prev.y) * ((i - 1) / numSteps);

          const dirty = applyLiquifyStep({
            canvas,
            sourceCanvas: isTone ? sourceCanvas : undefined,
            cx,
            cy,
            prevX: px,
            prevY: py,
            settings: liquifySettings,
            pressure,
            initialImageData: liquifyInitialImageDataRef.current,
            selectionMask: liquifySelectionMaskRef.current,
          });

          if (dirty) {
            if (!overallDirty) {
              overallDirty = { ...dirty };
            } else {
              const minX = Math.min(overallDirty.x, dirty.x);
              const minY = Math.min(overallDirty.y, dirty.y);
              const maxX = Math.max(overallDirty.x + overallDirty.width, dirty.x + dirty.width);
              const maxY = Math.max(overallDirty.y + overallDirty.height, dirty.y + dirty.height);
              overallDirty = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
            }
          }
        }

        prevLiquifyPointRef.current = pt;

        if (overallDirty) {
          if (activeLayer?.toneEnabled && sourceCanvas && displayCanvas) {
            applyLayerEffects(
              sourceCanvas,
              displayCanvas,
              activeLayer,
              dimensions.dpi ?? 600,
              overallDirty
            );
          } else if (overallDirty.width > 0 && overallDirty.height > 0) {
            const cCtx = get2DContext(canvas);
            if (cCtx) {
              const subData = cCtx.getImageData(
                overallDirty.x,
                overallDirty.y,
                overallDirty.width,
                overallDirty.height
              );
              const isMono =
                colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome';
              documentStore
                .getActiveTileGrid()
                .writeImageData(
                  targetLayerId,
                  subData,
                  overallDirty.x,
                  overallDirty.y,
                  isMono ? 'monochrome-1bit' : 'color-32bit'
                );
            }
          }
          documentStore.getActiveTileGrid().notifyChange(true);
          if (!liquifyDirtyRectRef.current) {
            liquifyDirtyRectRef.current = overallDirty;
          } else {
            const cur = liquifyDirtyRectRef.current;
            const minX = Math.min(cur.x, overallDirty.x);
            const minY = Math.min(cur.y, overallDirty.y);
            const maxX = Math.max(cur.x + cur.width, overallDirty.x + overallDirty.width);
            const maxY = Math.max(cur.y + cur.height, overallDirty.y + overallDirty.height);
            liquifyDirtyRectRef.current = {
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY,
            };
          }
        }
        return true;
      }

      if (tool === 'frame' && frameStartRef.current) {
        const mode = useToolStore.getState().frameSettings.mode ?? 'create';
        setFrameDragPreview({ mode, start: frameStartRef.current, end: getCanvasCoords(e) });
        return true;
      }

      if (
        tool === 'fill' &&
        fillSettings.method === 'lasso' &&
        lassoFillPointsRef.current.length > 0
      ) {
        lassoFillPointsRef.current.push(getCanvasCoords(e));
        return true;
      }

      return false;
    },
    [
      getCanvasCoords,
      handleSampleColor,
      activeLayerId,
      activeLayer,
      layerSourceCanvasesRef,
      layerCanvasesRef,
      dimensions.dpi,
      colorMode,
    ]
  );

  const handleShapeFillPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>, pt: { x: number; y: number }): boolean => {
      const { tool, primaryColor, fillSettings, frameSettings, liquifySettings } =
        useToolStore.getState();

      if (tool === 'pipette') {
        try {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          // Ignore release errors
        }
        if (isPipetteSamplingRef.current) {
          isPipetteSamplingRef.current = false;
          handleSampleColor(pt);
        }
        return true;
      }

      if (tool === 'liquify') {
        try {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          // Ignore release errors
        }

        if (liquifyRafIdRef.current) {
          cancelAnimationFrame(liquifyRafIdRef.current);
          liquifyRafIdRef.current = null;
        }

        if (isLiquifyingRef.current) {
          isLiquifyingRef.current = false;
          const targetLayerId = activeLayerId;
          const isTone = Boolean(
            activeLayer?.toneEnabled && layerSourceCanvasesRef.current?.get(targetLayerId)
          );
          const sourceCanvas = layerSourceCanvasesRef.current?.get(targetLayerId);
          const displayCanvas = layerCanvasesRef.current.get(targetLayerId);
          const canvas = isTone && sourceCanvas ? sourceCanvas : displayCanvas;

          if (canvas && liquifyBeforeImageDataRef.current) {
            const ctx = get2DContext(canvas);
            const afterImageData = ctx?.getImageData(0, 0, canvas.width, canvas.height);
            if (afterImageData) {
              const modeLabel =
                liquifySettings.mode.charAt(0).toUpperCase() + liquifySettings.mode.slice(1);
              pushHistoryStep(
                'liquify',
                `Liquify: ${modeLabel}`,
                liquifyBeforeImageDataRef.current,
                afterImageData,
                targetLayerId
              );
              documentStore.getActiveTileGrid().notifyChange(true);
              updateLayerThumbnail(targetLayerId, true);
            }
          }

          liquifyBeforeImageDataRef.current = null;
          liquifyInitialImageDataRef.current = null;
          liquifySelectionMaskRef.current = null;
          liquifyDirtyRectRef.current = null;
          prevLiquifyPointRef.current = null;
          liquifyLastPointerPosRef.current = null;
        }
        return true;
      }

      if (
        tool === 'fill' &&
        fillSettings.method === 'lasso' &&
        lassoFillPointsRef.current.length >= 3
      ) {
        const pts = [...lassoFillPointsRef.current];
        lassoFillPointsRef.current = [];
        const canvas = getActiveCanvas();
        if (!canvas) return true;
        const ctx = get2DContext(canvas);
        if (!ctx) return true;
        const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

        executeLassoFill(canvas, pts, primaryColor, sourceCanvas);
        if (activeLayer?.toneEnabled && sourceCanvas) {
          applyLayerEffects(sourceCanvas, canvas, activeLayer, dimensions.dpi ?? 600);
        }

        const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        updateLayerThumbnail(activeLayerId, true);
        pushHistoryStep('fill', 'Lasso Fill', beforeImageData, afterImageData, activeLayerId);
        documentStore.getActiveTileGrid().notifyChange(true);
        return true;
      }

      if (tool === 'frame' && frameStartRef.current) {
        const s = frameStartRef.current;
        frameStartRef.current = null;
        setFrameDragPreview(null);
        const mode = frameSettings.mode ?? 'create';
        const dpi = dimensions.dpi ?? 600;

        if (mode === 'divide') {
          if (Math.hypot(pt.x - s.x, pt.y - s.y) < 8) return true;

          // Resolve target frame-folder: active frame-folder, active layer's parent frame-folder,
          // or topmost visible frame-folder crossed by the cut line
          let targetFolder: LayerItem | undefined;
          if (activeLayer?.type === 'frame-folder') {
            targetFolder = activeLayer;
          } else if (activeLayer?.parentId) {
            const parent = layers.find((l) => l.id === activeLayer.parentId);
            if (parent?.type === 'frame-folder') targetFolder = parent;
          }
          if (!targetFolder) {
            targetFolder = layers.find(
              (l) =>
                l.type === 'frame-folder' &&
                isLayerEffectivelyVisible(l) &&
                (l.comicFrames || []).some((f) => doesCutSegmentCrossFrame(f, s, pt))
            );
          }

          if (!targetFolder) {
            showToast?.('No Frame Border Folder intersected by cut line');
            return true;
          }

          const divideMode = frameSettings.divideMode ?? 'same-folder';
          const ok = divideFrameFolder(targetFolder.id, s, pt, dpi, divideMode);
          if (ok) {
            pushHistoryStep(
              'frame',
              divideMode === 'split-folders' ? 'Divide Frame Folder' : 'Divide Frame Border',
              null,
              null,
              targetFolder.id
            );
            showToast?.(
              divideMode === 'split-folders'
                ? 'Frame split into 2 Frame Folders'
                : 'Frame divided with manga gutter'
            );
          } else {
            showToast?.('Cut line must cross completely through a frame border');
          }
          return true;
        }

        // Create Frame Border Folder mode
        const minX = Math.floor(Math.min(s.x, pt.x));
        const minY = Math.floor(Math.min(s.y, pt.y));
        const w = Math.ceil(Math.abs(pt.x - s.x));
        const h = Math.ceil(Math.abs(pt.y - s.y));

        if (w >= 8 && h >= 8) {
          const rectFrame = createRectFrame('', minX, minY, w, h, {
            dpi,
            borderWidth: frameSettings.thickness || 4,
            gutterVerticalPx: mmToPixels(
              frameSettings.gutterVerticalMm ?? MANGA_GUTTER_VERTICAL_MM,
              dpi
            ),
            gutterHorizontalPx: mmToPixels(
              frameSettings.gutterHorizontalMm ?? MANGA_GUTTER_HORIZONTAL_MM,
              dpi
            ),
            fillBackground: frameSettings.fillBackground,
            fillColor: frameSettings.fillColor || '#ffffff',
            strokeColor: frameSettings.strokeColor || primaryColor || '#000000',
          });
          const { folder } = createFrameFolder([rectFrame], undefined, true);
          pushHistoryStep('frame', 'Create Frame Folder', null, null, folder.id);
          showToast?.('Created Frame Border Folder (child layers auto-clip)');
        }
        return true;
      }

      return false;
    },
    [
      handleSampleColor,
      activeLayerId,
      activeLayer,
      layers,
      isLayerEffectivelyVisible,
      layerSourceCanvasesRef,
      layerCanvasesRef,
      pushHistoryStep,
      updateLayerThumbnail,
      getActiveCanvas,
      dimensions.dpi,
      createFrameFolder,
      divideFrameFolder,
      showToast,
    ]
  );

  return {
    textSession,
    setTextSession,
    activeBalloon,
    setActiveBalloon,
    frameDragPreview,
    openLayerForEditing,
    isPipetteSamplingRef,
    handleSampleColor,
    handleConfirmText,
    handleCancelText,
    handleConfirmBalloon,
    handleDeleteBalloon,
    handleShapeFillPointerDown,
    handleShapeFillPointerMove,
    handleShapeFillPointerUp,
  };
}
