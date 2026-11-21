import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  CanvasColorMode,
  CanvasDimensions,
  CanvasSelection,
  ComicFrame,
  FrameDivideMode,
  LayerItem,
  ShapeDragPreview,
  SpeechBalloon,
  TextLayerData,
  TextSettings,
  TileDelta,
} from '../../types/editor';
import { documentStore } from '../../utils/documentStore';
import { TileFormat } from '../../utils/tileEngine';
import {
  executeFloodFill,
  compositeVisibleLayers,
  compositeReferenceLayers,
  executeLassoFill,
} from '../../utils/floodFill';
import {
  applyLiquifyStep,
  createLiquifySelectionMask,
  resolveLiquifyTargetLayers,
  DirtyRect,
} from '../../utils/liquifyEngine';
import { rasterizeShapeToCanvas, resolveShapeFillColor } from '../../utils/shapeEngine';
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
  selectedLayerIds?: string[];
  selection: CanvasSelection | null;
  layerCanvasesRef: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  layerSourceCanvasesRef: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  materializeLayerCanvas?: (layerId: string) => HTMLCanvasElement | null;
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
  shapeDragPreview: ShapeDragPreview | null;
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

interface LiquifyLayerSession {
  layer: LayerItem;
  layerId: string;
  isTone: boolean;
  sourceCanvas?: HTMLCanvasElement;
  displayCanvas: HTMLCanvasElement;
  workCanvas: HTMLCanvasElement;
  initialImageData: ImageData | null;
  beforeTileSnapshot: Map<string, { format: TileFormat; data: Uint8Array | null }>;
  dirtyRect: DirtyRect | null;
}

function mergeDirtyRects(a: DirtyRect | null, b: DirtyRect | null): DirtyRect | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return a;
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function useShapeAndFillTools({
  dimensions,
  colorMode,
  layers,
  activeLayer,
  activeLayerId,
  selectedLayerIds = [],
  selection,
  layerCanvasesRef,
  layerSourceCanvasesRef,
  materializeLayerCanvas,
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
  const [shapeDragPreview, setShapeDragPreview] = useState<ShapeDragPreview | null>(null);

  const isPipetteSamplingRef = useRef<boolean>(false);
  const lassoFillPointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const frameStartRef = useRef<{ x: number; y: number } | null>(null);
  const shapeDragRef = useRef<{
    start: { x: number; y: number };
    end: { x: number; y: number };
    shiftKey: boolean;
    altKey: boolean;
    spaceHeld: boolean;
  } | null>(null);

  useEffect(() => {
    if (!shapeDragPreview) return;
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (!shapeDragRef.current) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        shapeDragRef.current = null;
        setShapeDragPreview(null);
        return;
      }
      if (ev.key === ' ' || ev.code === 'Space') {
        shapeDragRef.current.spaceHeld = true;
      }
      if (ev.key === 'Shift' || ev.key === 'Alt') {
        shapeDragRef.current.shiftKey = ev.shiftKey;
        shapeDragRef.current.altKey = ev.altKey;
        setShapeDragPreview({
          start: { ...shapeDragRef.current.start },
          end: { ...shapeDragRef.current.end },
          shiftKey: ev.shiftKey,
          altKey: ev.altKey,
          settings: useToolStore.getState().shapeSettings,
        });
      }
    };
    const handleKeyUp = (ev: KeyboardEvent) => {
      if (!shapeDragRef.current) return;
      if (ev.key === ' ' || ev.code === 'Space') {
        shapeDragRef.current.spaceHeld = false;
      }
      if (ev.key === 'Shift' || ev.key === 'Alt') {
        shapeDragRef.current.shiftKey = ev.shiftKey;
        shapeDragRef.current.altKey = ev.altKey;
        setShapeDragPreview({
          start: { ...shapeDragRef.current.start },
          end: { ...shapeDragRef.current.end },
          shiftKey: ev.shiftKey,
          altKey: ev.altKey,
          settings: useToolStore.getState().shapeSettings,
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [shapeDragPreview]);

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
  const liquifySessionsRef = useRef<LiquifyLayerSession[]>([]);
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

  const syncLiquifySessionDirty = useCallback(
    (session: LiquifyLayerSession, dirty: DirtyRect) => {
      if (dirty.width <= 0 || dirty.height <= 0) return;
      session.dirtyRect = mergeDirtyRects(session.dirtyRect, dirty);
      const grid = documentStore.getActiveTileGrid();
      const isMono =
        colorMode === 'monochrome' || session.layer.expressionColor === 'monochrome';
      const targetFormat: TileFormat = isMono ? 'monochrome-1bit' : 'color-32bit';

      if (session.isTone && session.sourceCanvas) {
        applyLayerEffects(
          session.sourceCanvas,
          session.displayCanvas,
          session.layer,
          dimensions.dpi ?? 600,
          dirty
        );
        const sCtx = get2DContext(session.sourceCanvas);
        if (sCtx) {
          const subData = sCtx.getImageData(dirty.x, dirty.y, dirty.width, dirty.height);
          grid.writeImageData(session.layerId, subData, dirty.x, dirty.y, targetFormat);
        }
      } else {
        const dCtx = get2DContext(session.workCanvas);
        if (dCtx) {
          const subData = dCtx.getImageData(dirty.x, dirty.y, dirty.width, dirty.height);
          grid.writeImageData(session.layerId, subData, dirty.x, dirty.y, targetFormat);
        }
      }
    },
    [colorMode, dimensions.dpi]
  );

  const startLiquifyLoop = useCallback(() => {
    if (liquifyRafIdRef.current) cancelAnimationFrame(liquifyRafIdRef.current);

    const tick = () => {
      if (
        !isLiquifyingRef.current ||
        !liquifyLastPointerPosRef.current ||
        liquifySessionsRef.current.length === 0
      ) {
        liquifyRafIdRef.current = null;
        return;
      }
      const { pt, pressure } = liquifyLastPointerPosRef.current;
      const liquifySettings = useToolStore.getState().liquifySettings;
      let anyDirty = false;

      for (const session of liquifySessionsRef.current) {
        const dirty = applyLiquifyStep({
          canvas: session.workCanvas,
          sourceCanvas: session.isTone ? session.sourceCanvas : undefined,
          cx: pt.x,
          cy: pt.y,
          prevX: pt.x,
          prevY: pt.y,
          settings: liquifySettings,
          pressure,
          initialImageData: session.initialImageData,
          selectionMask: liquifySelectionMaskRef.current,
        });
        if (dirty) {
          syncLiquifySessionDirty(session, dirty);
          anyDirty = true;
        }
      }

      if (anyDirty) {
        documentStore.getActiveTileGrid().notifyChange(true);
      }

      liquifyRafIdRef.current = requestAnimationFrame(tick);
    };

    liquifyRafIdRef.current = requestAnimationFrame(tick);
  }, [syncLiquifySessionDirty]);

  const handleShapeFillPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, pt: { x: number; y: number }): boolean => {
      const {
        tool,
        primaryColor,
        fillSettings,
        textSettings,
        balloonSettings,
        liquifySettings,
        shapeSettings,
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

      if (tool === 'shape') {
        e.preventDefault();
        if (
          !activeLayer ||
          activeLayer.type !== 'raster' ||
          activeLayer.locked ||
          !isLayerEffectivelyVisible(activeLayer)
        ) {
          showToast?.('Select an unlocked, visible raster layer to draw shapes');
          return true;
        }
        try {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          // Ignore pointer capture errors
        }
        shapeDragRef.current = {
          start: pt,
          end: pt,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          spaceHeld: false,
        };
        setShapeDragPreview({
          start: pt,
          end: pt,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          settings: shapeSettings,
        });
        return true;
      }

      if (tool === 'liquify') {
        e.preventDefault();
        const isMulti = Boolean(liquifySettings.multiLayer);
        const targetLayers = resolveLiquifyTargetLayers(
          layers,
          activeLayer,
          selectedLayerIds,
          isLayerEffectivelyVisible,
          isMulti
        );
        if (targetLayers.length === 0) {
          return true;
        }

        const grid = documentStore.getActiveTileGrid();
        const needInitialImage = liquifySettings.mode === 'reconstruct';
        const sessions: LiquifyLayerSession[] = [];

        for (const layer of targetLayers) {
          const targetId = layer.id;
          const displayCanvas =
            layerCanvasesRef.current.get(targetId) ?? materializeLayerCanvas?.(targetId) ?? null;
          if (!displayCanvas) continue;

          const sourceCanvas = layerSourceCanvasesRef.current?.get(targetId);
          const isTone = Boolean(layer.toneEnabled && sourceCanvas);
          const workCanvas = isTone && sourceCanvas ? sourceCanvas : displayCanvas;

          // Skip strictly blank layers in multi-layer mode to avoid wasted work
          if (
            isMulti &&
            targetLayers.length > 1 &&
            (workCanvas as unknown as { __isBlank?: boolean }).__isBlank &&
            !grid.hasLayerTiles(targetId)
          ) {
            continue;
          }

          const ctx = get2DContext(workCanvas);
          if (!ctx) continue;

          const isMono = colorMode === 'monochrome' || layer.expressionColor === 'monochrome';
          const targetFormat: TileFormat = isMono ? 'monochrome-1bit' : 'color-32bit';
          if (
            !grid.hasLayerTiles(targetId) &&
            !(workCanvas as unknown as { __isBlank?: boolean }).__isBlank
          ) {
            grid.ingestCanvas(targetId, workCanvas, targetFormat);
          }

          const beforeTileSnapshot = grid.snapshotTilesInRect(targetId, {
            x: 0,
            y: 0,
            width: workCanvas.width,
            height: workCanvas.height,
          });
          const initialImageData = needInitialImage
            ? ctx.getImageData(0, 0, workCanvas.width, workCanvas.height)
            : null;

          sessions.push({
            layer,
            layerId: targetId,
            isTone,
            sourceCanvas,
            displayCanvas,
            workCanvas,
            initialImageData,
            beforeTileSnapshot,
            dirtyRect: null,
          });
        }

        if (sessions.length === 0) return true;

        isLiquifyingRef.current = true;
        prevLiquifyPointRef.current = pt;
        liquifySessionsRef.current = sessions;
        liquifySelectionMaskRef.current = createLiquifySelectionMask(
          selection,
          sessions[0].workCanvas.width,
          sessions[0].workCanvas.height
        );
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
          let anyDirty = false;
          for (const session of sessions) {
            const dirty = applyLiquifyStep({
              canvas: session.workCanvas,
              sourceCanvas: session.isTone ? session.sourceCanvas : undefined,
              cx: pt.x,
              cy: pt.y,
              prevX: pt.x,
              prevY: pt.y,
              settings: liquifySettings,
              pressure: e.pressure || 1.0,
              initialImageData: session.initialImageData,
              selectionMask: liquifySelectionMaskRef.current,
            });
            if (dirty) {
              syncLiquifySessionDirty(session, dirty);
              anyDirty = true;
            }
          }
          if (anyDirty) {
            grid.notifyChange(true);
          }
          startLiquifyLoop();
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
      selectedLayerIds,
      isLayerEffectivelyVisible,
      layerSourceCanvasesRef,
      layerCanvasesRef,
      materializeLayerCanvas,
      selection,
      dimensions,
      colorMode,
      startLiquifyLoop,
      syncLiquifySessionDirty,
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
      const { tool, fillSettings, liquifySettings, shapeSettings } = useToolStore.getState();

      if (tool === 'pipette') {
        if (isPipetteSamplingRef.current) {
          const pt = getCanvasCoords(e);
          handleSampleColor(pt);
        }
        return true;
      }

      if (tool === 'shape') {
        if (!shapeDragRef.current) return true;
        const pt = getCanvasCoords(e);
        if (shapeDragRef.current.spaceHeld) {
          const dx = pt.x - shapeDragRef.current.end.x;
          const dy = pt.y - shapeDragRef.current.end.y;
          shapeDragRef.current.start = {
            x: shapeDragRef.current.start.x + dx,
            y: shapeDragRef.current.start.y + dy,
          };
        }
        shapeDragRef.current.end = pt;
        shapeDragRef.current.shiftKey = e.shiftKey;
        shapeDragRef.current.altKey = e.altKey;
        setShapeDragPreview({
          start: { ...shapeDragRef.current.start },
          end: { ...pt },
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          settings: shapeSettings,
        });
        return true;
      }

      if (tool === 'liquify') {
        if (!isLiquifyingRef.current || liquifySessionsRef.current.length === 0) return true;
        const pt = getCanvasCoords(e);
        const pressure = e.pressure || 1.0;
        liquifyLastPointerPosRef.current = { pt, pressure };

        const prev = prevLiquifyPointRef.current || pt;
        const dist = Math.hypot(pt.x - prev.x, pt.y - prev.y);
        const stepDist = Math.max(2, (liquifySettings.size / 2) * 0.25);
        const numSteps = Math.max(1, Math.ceil(dist / stepDist));
        let anyDirty = false;

        for (const session of liquifySessionsRef.current) {
          let layerDirty: DirtyRect | null = null;
          for (let i = 1; i <= numSteps; i++) {
            const t = i / numSteps;
            const cx = prev.x + (pt.x - prev.x) * t;
            const cy = prev.y + (pt.y - prev.y) * t;
            const px = prev.x + (pt.x - prev.x) * ((i - 1) / numSteps);
            const py = prev.y + (pt.y - prev.y) * ((i - 1) / numSteps);

            const dirty = applyLiquifyStep({
              canvas: session.workCanvas,
              sourceCanvas: session.isTone ? session.sourceCanvas : undefined,
              cx,
              cy,
              prevX: px,
              prevY: py,
              settings: liquifySettings,
              pressure,
              initialImageData: session.initialImageData,
              selectionMask: liquifySelectionMaskRef.current,
            });

            if (dirty) {
              layerDirty = mergeDirtyRects(layerDirty, dirty);
            }
          }

          if (layerDirty) {
            syncLiquifySessionDirty(session, layerDirty);
            anyDirty = true;
          }
        }

        prevLiquifyPointRef.current = pt;

        if (anyDirty) {
          documentStore.getActiveTileGrid().notifyChange(true);
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
    [getCanvasCoords, handleSampleColor, syncLiquifySessionDirty]
  );

  const handleShapeFillPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>, pt: { x: number; y: number }): boolean => {
      const {
        tool,
        primaryColor,
        secondaryColor,
        fillSettings,
        frameSettings,
        liquifySettings,
        shapeSettings,
      } = useToolStore.getState();

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

      if (tool === 'shape') {
        try {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          // Ignore release errors
        }
        const drag = shapeDragRef.current;
        shapeDragRef.current = null;
        setShapeDragPreview(null);
        if (!drag) return true;

        const canvas = getActiveCanvas();
        if (
          !canvas ||
          !activeLayer ||
          activeLayer.type !== 'raster' ||
          activeLayer.locked ||
          !isLayerEffectivelyVisible(activeLayer)
        ) {
          return true;
        }

        const sourceCanvas = layerSourceCanvasesRef.current?.get(activeLayerId);
        const isTone = Boolean(activeLayer.toneEnabled && sourceCanvas);
        const workCanvas = isTone && sourceCanvas ? sourceCanvas : canvas;
        const ctx = get2DContext(workCanvas);
        if (!ctx) return true;

        const isMono =
          colorMode === 'monochrome' || activeLayer.expressionColor === 'monochrome';
        const targetFormat: TileFormat = isMono ? 'monochrome-1bit' : 'color-32bit';
        const grid = documentStore.getActiveTileGrid();
        if (
          !grid.hasLayerTiles(activeLayerId) &&
          !(workCanvas as unknown as { __isBlank?: boolean }).__isBlank
        ) {
          grid.ingestCanvas(activeLayerId, workCanvas, targetFormat);
        }
        const beforeSnapshot = grid.snapshotTilesInRect(activeLayerId, {
          x: 0,
          y: 0,
          width: workCanvas.width,
          height: workCanvas.height,
        });

        const fillColor = resolveShapeFillColor(shapeSettings, primaryColor, secondaryColor);
        const finalPreview: ShapeDragPreview = {
          start: drag.start,
          end: pt,
          shiftKey: e.shiftKey || drag.shiftKey,
          altKey: e.altKey || drag.altKey,
          settings: shapeSettings,
        };

        const dirty = rasterizeShapeToCanvas(
          canvas,
          finalPreview,
          primaryColor,
          fillColor,
          selection,
          colorMode,
          isMono,
          isTone ? sourceCanvas : null
        );

        if (dirty && dirty.width > 0 && dirty.height > 0) {
          (canvas as unknown as { __isBlank?: boolean }).__isBlank = false;
          if (sourceCanvas) {
            (sourceCanvas as unknown as { __isBlank?: boolean }).__isBlank = false;
          }
          if (isTone && sourceCanvas) {
            applyLayerEffects(
              sourceCanvas,
              canvas,
              activeLayer,
              dimensions.dpi ?? 600,
              dirty
            );
          }
          const subData = ctx.getImageData(dirty.x, dirty.y, dirty.width, dirty.height);
          grid.writeImageData(activeLayerId, subData, dirty.x, dirty.y, targetFormat);
          const deltas = grid.computeDeltasFromSnapshot(beforeSnapshot, activeLayerId, dirty);
          const shapeName =
            shapeSettings.shape.charAt(0).toUpperCase() + shapeSettings.shape.slice(1);
          pushHistoryStep(
            'shape',
            `Shape: ${shapeName}`,
            null,
            null,
            activeLayerId,
            dirty,
            deltas.length > 0 ? deltas : undefined
          );
          grid.notifyChange(true);
          updateLayerThumbnail(activeLayerId, true);
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
          const sessions = liquifySessionsRef.current;
          const grid = documentStore.getActiveTileGrid();
          const allDeltas: TileDelta[] = [];
          let combinedDirty: DirtyRect | null = null;
          let modifiedCount = 0;
          let primaryTargetId = activeLayerId;

          for (const session of sessions) {
            if (!session.dirtyRect) continue;
            modifiedCount++;
            primaryTargetId = session.layerId;
            combinedDirty = mergeDirtyRects(combinedDirty, session.dirtyRect);
            const deltas = grid.computeDeltasFromSnapshot(
              session.beforeTileSnapshot,
              session.layerId,
              session.dirtyRect
            );
            for (const d of deltas) {
              allDeltas.push(d);
            }
            updateLayerThumbnail(session.layerId, true);
          }

          if (allDeltas.length > 0) {
            const modeLabel =
              liquifySettings.mode.charAt(0).toUpperCase() + liquifySettings.mode.slice(1);
            const stepLabel =
              modifiedCount > 1
                ? `Liquify (${modifiedCount} layers): ${modeLabel}`
                : `Liquify: ${modeLabel}`;
            pushHistoryStep(
              'liquify',
              stepLabel,
              null,
              null,
              primaryTargetId,
              combinedDirty ?? undefined,
              allDeltas
            );
            grid.notifyChange(true);
          }

          liquifySessionsRef.current = [];
          liquifySelectionMaskRef.current = null;
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
      selection,
      colorMode,
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
    shapeDragPreview,
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
