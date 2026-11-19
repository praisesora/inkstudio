import React, { useState, useRef, useCallback } from 'react';
import {
  CanvasColorMode,
  CanvasDimensions,
  CanvasSelection,
  LayerItem,
  SpeechBalloon,
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
import { renderMangaTextToCanvas } from '../../utils/mangaTextEngine';
import { createDefaultSpeechBalloon, renderSpeechBalloon } from '../../utils/balloonEngine';
import { useToolStore, toolStoreActions } from '../../stores';
import { PushHistoryStepFn } from './types';

export interface TextPlacementSession {
  x: number;
  y: number;
  settings: TextSettings;
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
  updateLayerThumbnail: (layerId: string, immediate?: boolean) => void;
  pushHistoryStep: PushHistoryStepFn;
}

export interface UseShapeAndFillToolsResult {
  textSession: TextPlacementSession | null;
  setTextSession: React.Dispatch<React.SetStateAction<TextPlacementSession | null>>;
  activeBalloon: SpeechBalloon | null;
  setActiveBalloon: React.Dispatch<React.SetStateAction<SpeechBalloon | null>>;
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
  updateLayerThumbnail,
  pushHistoryStep,
}: UseShapeAndFillToolsParams): UseShapeAndFillToolsResult {
  const [textSession, setTextSession] = useState<TextPlacementSession | null>(null);
  const [activeBalloon, setActiveBalloon] = useState<SpeechBalloon | null>(null);

  const isPipetteSamplingRef = useRef<boolean>(false);
  const lassoFillPointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const frameStartRef = useRef<{ x: number; y: number } | null>(null);

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
    const canvas = getActiveCanvas();
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

    const renderTextOn = (target: HTMLCanvasElement) => {
      const c = get2DContext(target);
      if (!c) return;
      const s = textSession.settings;
      renderMangaTextToCanvas(c, s.text, textSession.x, textSession.y, {
        fontSize: s.fontSize,
        fontFamily: s.fontFamily,
        writingMode: s.writingMode || 'horizontal-tb',
        bold: s.bold,
        italic: s.italic,
        align: s.align,
        color: s.color,
        outline: s.outline,
        outlineColor: s.outlineColor,
        outlineWidth: s.outlineWidth,
        anchorTopLeft: true,
      });
    };

    renderTextOn(canvas);
    if (sourceCanvas) renderTextOn(sourceCanvas);

    const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    updateLayerThumbnail(activeLayerId, true);
    pushHistoryStep('text', 'Manga Text', beforeImageData, afterImageData, activeLayerId);
    documentStore.getActiveTileGrid().notifyChange(true);
    setTextSession(null);
  }, [
    textSession,
    getActiveCanvas,
    activeLayerId,
    layerSourceCanvasesRef,
    updateLayerThumbnail,
    pushHistoryStep,
  ]);

  const handleCancelText = useCallback(() => {
    setTextSession(null);
  }, []);

  const handleConfirmBalloon = useCallback(() => {
    if (!activeBalloon) return;
    const canvas = getActiveCanvas();
    if (!canvas) return;
    const ctx = get2DContext(canvas);
    if (!ctx) return;

    const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

    const drawOn = (target: HTMLCanvasElement) => {
      const c = get2DContext(target);
      if (!c) return;
      renderSpeechBalloon(c, activeBalloon);
    };

    drawOn(canvas);
    if (sourceCanvas) drawOn(sourceCanvas);

    const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    updateLayerThumbnail(activeLayerId, true);
    pushHistoryStep('frame', 'Speech Balloon', beforeImageData, afterImageData, activeLayerId);
    documentStore.getActiveTileGrid().notifyChange(true);
    setActiveBalloon(null);
  }, [
    activeBalloon,
    getActiveCanvas,
    activeLayerId,
    layerSourceCanvasesRef,
    updateLayerThumbnail,
    pushHistoryStep,
  ]);

  const handleDeleteBalloon = useCallback(() => {
    setActiveBalloon(null);
  }, []);

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
        frameStartRef.current = pt;
        return true;
      }

      if (tool === 'text') {
        e.preventDefault();
        setTextSession({
          x: Math.round(pt.x),
          y: Math.round(pt.y),
          settings: { ...textSettings },
        });
        return true;
      }

      if (tool === 'balloon') {
        e.preventDefault();
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
        const minX = Math.floor(Math.min(s.x, pt.x));
        const minY = Math.floor(Math.min(s.y, pt.y));
        const w = Math.ceil(Math.abs(pt.x - s.x));
        const h = Math.ceil(Math.abs(pt.y - s.y));

        if (w >= 4 && h >= 4) {
          const canvas = getActiveCanvas();
          if (!canvas) return true;
          const ctx = get2DContext(canvas);
          if (!ctx) return true;
          const beforeImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);

          const drawFrameOn = (target: HTMLCanvasElement) => {
            const c = get2DContext(target);
            if (!c) return;
            c.save();
            if (frameSettings.fillBackground) {
              c.fillStyle = frameSettings.fillColor || '#ffffff';
              c.fillRect(minX, minY, w, h);
            }
            c.strokeStyle = primaryColor || '#000000';
            c.lineWidth = frameSettings.thickness;
            c.lineJoin = 'miter';
            c.strokeRect(minX, minY, w, h);
            c.restore();
          };

          drawFrameOn(canvas);
          if (sourceCanvas) drawFrameOn(sourceCanvas);

          const afterImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          updateLayerThumbnail(activeLayerId, true);
          pushHistoryStep('frame', 'Frame Border', beforeImageData, afterImageData, activeLayerId);
          documentStore.getActiveTileGrid().notifyChange(true);
        }
        return true;
      }

      return false;
    },
    [
      handleSampleColor,
      activeLayerId,
      activeLayer,
      layerSourceCanvasesRef,
      layerCanvasesRef,
      pushHistoryStep,
      updateLayerThumbnail,
      getActiveCanvas,
      dimensions.dpi,
    ]
  );

  return {
    textSession,
    setTextSession,
    activeBalloon,
    setActiveBalloon,
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
