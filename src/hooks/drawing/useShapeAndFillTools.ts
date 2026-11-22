import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  CanvasColorMode,
  CanvasDimensions,
  CanvasSelection,
  ComicFrame,
  FrameDivideMode,
  LayerItem,
  LayerTreeDelta,
  ShapeDragPreview,
  SpeechBalloon,
  TextLayerData,
  TextSettings,
  TileDelta,
} from '../../types/editor';
import { documentStore } from '../../utils/documentStore';
import { SparseTileGrid, TileFormat, TileSnapshotEntry } from '../../utils/tileEngine';
import {
  executeFloodFillOnTileGridAsync,
  executeLassoFillOnTileGrid,
} from '../../utils/floodFill';
import {
  LiquifySubStep,
  LiquifyWarpField,
  createLiquifySelectionMask,
  resampleLayerFromWarpField,
  resolveLiquifyTargetLayers,
  DirtyRect,
} from '../../utils/liquifyEngine';
import { rasterizeShapeToTileGrid, resolveShapeFillColor } from '../../utils/shapeEngine';
import { createSelectionMask } from '../../utils/tonalEngine';
import { sampleCompositedColor } from '../../utils/canvasUtils';
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
  flushPendingHistoryTasks?: () => void;
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean;
  getEffectiveOpacity: (layer: LayerItem) => number;
  getCanvasCoords: (e: React.PointerEvent<HTMLElement> | PointerEvent) => { x: number; y: number };
  setActiveLayerId: (id: string) => void;
  upsertTextLayer: (textData: TextLayerData, editingLayerId?: string | null) => LayerItem;
  upsertBalloonLayer: (balloonData: SpeechBalloon, editingLayerId?: string | null) => LayerItem;
  createFrameFolder: (
    frames: ComicFrame[],
    customName?: string,
    addInitialChildLayer?: boolean
  ) => { folder: LayerItem; childLayer: LayerItem | null; layerTreeDelta: LayerTreeDelta };
  divideFrameFolder: (
    folderId: string,
    cutStart: Point2D,
    cutEnd: Point2D,
    dpi?: number,
    mode?: FrameDivideMode
  ) => { divided: boolean; layerTreeDelta?: LayerTreeDelta; tileDeltas?: TileDelta[] };
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
  targetFormat: TileFormat;
  beforeTileSnapshot: Map<string, TileSnapshotEntry>;
  origRgbaCache: Map<number, Uint8ClampedArray | null>;
  dirtyRect: DirtyRect | null;
}

interface PersistentLiquifyWarpSession {
  grid: SparseTileGrid;
  width: number;
  height: number;
  warpField: LiquifyWarpField;
  layers: Map<string, { origRgbaCache: Map<number, Uint8ClampedArray | null>; lastVersion: number }>;
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
  flushPendingHistoryTasks,
  isLayerEffectivelyVisible,
  getEffectiveOpacity,
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
  const liquifyPersistentRef = useRef<PersistentLiquifyWarpSession | null>(null);
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

  useEffect(() => {
    const clearPersistent = () => {
      if (liquifyPersistentRef.current) {
        liquifyPersistentRef.current.warpField.clear();
        liquifyPersistentRef.current.layers.clear();
        liquifyPersistentRef.current = null;
      }
    };
    let prevTool = useToolStore.getState().tool;
    const unsub = useToolStore.subscribe(() => {
      const curTool = useToolStore.getState().tool;
      if (prevTool === 'liquify' && curTool !== 'liquify') {
        clearPersistent();
      }
      prevTool = curTool;
    });
    return () => {
      unsub();
      clearPersistent();
    };
  }, []);

  const handleSampleColor = useCallback(
    (pt: { x: number; y: number }) => {
      const sampled = sampleCompositedColor(
        layers,
        documentStore.getActiveTileGrid(),
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

  const startLiquifyLoop = useCallback(() => {
    if (liquifyRafIdRef.current) cancelAnimationFrame(liquifyRafIdRef.current);

    const tick = () => {
      const persistent = liquifyPersistentRef.current;
      if (
        !isLiquifyingRef.current ||
        !liquifyLastPointerPosRef.current ||
        !persistent ||
        liquifySessionsRef.current.length === 0
      ) {
        liquifyRafIdRef.current = null;
        return;
      }
      const { pt, pressure } = liquifyLastPointerPosRef.current;
      const liquifySettings = useToolStore.getState().liquifySettings;
      const grid = documentStore.getActiveTileGrid();

      const stepDirty = persistent.warpField.applySubSteps(
        [{ cx: pt.x, cy: pt.y, prevX: pt.x, prevY: pt.y, pressure }],
        dimensions,
        liquifySettings,
        liquifySelectionMaskRef.current
      );

      if (stepDirty) {
        let anyDirty = false;
        for (const session of liquifySessionsRef.current) {
          const dirty = resampleLayerFromWarpField({
            grid,
            layerId: session.layerId,
            dimensions,
            targetFormat: session.targetFormat,
            warpField: persistent.warpField,
            dirtyRect: stepDirty,
            beforeTileSnapshot: session.beforeTileSnapshot,
            origRgbaCache: session.origRgbaCache,
          });
          if (dirty) {
            session.dirtyRect = mergeDirtyRects(session.dirtyRect, dirty);
            anyDirty = true;
          }
        }
        if (anyDirty) {
          grid.notifyChange(true);
        }
      }

      liquifyRafIdRef.current = requestAnimationFrame(tick);
    };

    liquifyRafIdRef.current = requestAnimationFrame(tick);
  }, [dimensions]);

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
        flushPendingHistoryTasks?.();
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
        const eligibleLayers = targetLayers.filter((l) => grid.hasLayerTiles(l.id));
        if (eligibleLayers.length === 0) return true;

        // Reuse persistent warp field across consecutive Liquify strokes while layers remain
        // untouched by external edits/undo/redo, guaranteeing single-pass bicubic quality
        // and ghost-free cross-stroke Reconstruct.
        let persistent = liquifyPersistentRef.current;
        const canReuse =
          persistent !== null &&
          persistent.grid === grid &&
          persistent.width === dimensions.width &&
          persistent.height === dimensions.height &&
          persistent.layers.size === eligibleLayers.length &&
          eligibleLayers.every((l) => {
            const entry = persistent!.layers.get(l.id);
            return entry !== undefined && grid.getLayerVersion(l.id) === entry.lastVersion;
          });

        if (!canReuse) {
          if (persistent) {
            persistent.warpField.clear();
            persistent.layers.clear();
          }
          const layerEntries = new Map<
            string,
            { origRgbaCache: Map<number, Uint8ClampedArray | null>; lastVersion: number }
          >();
          for (const layer of eligibleLayers) {
            layerEntries.set(layer.id, {
              origRgbaCache: new Map<number, Uint8ClampedArray | null>(),
              lastVersion: grid.getLayerVersion(layer.id),
            });
          }
          persistent = {
            grid,
            width: dimensions.width,
            height: dimensions.height,
            warpField: new LiquifyWarpField(),
            layers: layerEntries,
          };
          liquifyPersistentRef.current = persistent;
        }

        const sessions: LiquifyLayerSession[] = [];
        for (const layer of eligibleLayers) {
          const targetId = layer.id;
          const isBg = targetId === 'layer-bg' || targetId.startsWith('layer-bg');
          const isMono = !isBg && (colorMode === 'monochrome' || layer.expressionColor === 'monochrome');
          const targetFormat: TileFormat = isMono ? 'monochrome-1bit' : 'color-32bit';
          const persistentEntry = persistent!.layers.get(targetId)!;

          sessions.push({
            layer,
            layerId: targetId,
            targetFormat,
            beforeTileSnapshot: new Map<string, TileSnapshotEntry>(),
            origRgbaCache: persistentEntry.origRgbaCache,
            dirtyRect: null,
          });
        }

        if (sessions.length === 0) return true;

        isLiquifyingRef.current = true;
        prevLiquifyPointRef.current = pt;
        liquifySessionsRef.current = sessions;
        liquifySelectionMaskRef.current = createLiquifySelectionMask(
          selection,
          dimensions.width,
          dimensions.height
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
          const stepDirty = persistent!.warpField.applySubSteps(
            [{ cx: pt.x, cy: pt.y, prevX: pt.x, prevY: pt.y, pressure: e.pressure || 1.0 }],
            dimensions,
            liquifySettings,
            liquifySelectionMaskRef.current
          );
          if (stepDirty) {
            let anyDirty = false;
            for (const session of sessions) {
              const dirty = resampleLayerFromWarpField({
                grid,
                layerId: session.layerId,
                dimensions,
                targetFormat: session.targetFormat,
                warpField: persistent!.warpField,
                dirtyRect: stepDirty,
                beforeTileSnapshot: session.beforeTileSnapshot,
                origRgbaCache: session.origRgbaCache,
              });
              if (dirty) {
                session.dirtyRect = mergeDirtyRects(session.dirtyRect, dirty);
                anyDirty = true;
              }
            }
            if (anyDirty) {
              grid.notifyChange(true);
            }
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

        flushPendingHistoryTasks?.();
        if (
          !activeLayerId ||
          activeLayer?.locked ||
          (activeLayer && !isLayerEffectivelyVisible(activeLayer))
        ) {
          return true;
        }

        const grid = documentStore.getActiveTileGrid();
        const isBg = activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg');
        const isMono =
          !isBg && (colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome');
        const targetFormat: TileFormat = isMono ? 'monochrome-1bit' : 'color-32bit';
        const referMode =
          fillSettings.method === 'refer-all'
            ? 'refer-all'
            : fillSettings.method === 'refer-reference'
              ? 'refer-reference'
              : 'active';

        const selMask = selection
          ? createSelectionMask(selection, dimensions.width, dimensions.height)
          : null;

        const targetLayerId = activeLayerId;
        void executeFloodFillOnTileGridAsync({
          grid,
          targetLayerId,
          layers,
          dimensions,
          startX: px,
          startY: py,
          fillColorHex: primaryColor,
          tolerance: fillSettings.tolerance,
          referMode,
          targetFormat,
          options: {
            closeGap: fillSettings.closeGap ?? 0,
            areaScale: fillSettings.areaScale ?? 0,
            antiAlias: fillSettings.antiAlias ?? true,
            selectionMask: selMask,
          },
        }).then((fillRes) => {
          if (fillRes.modified && fillRes.tileDeltas.length > 0) {
            pushHistoryStep(
              'fill',
              'Bucket Fill',
              null,
              null,
              targetLayerId,
              fillRes.dirtyRect ?? undefined,
              fillRes.tileDeltas
            );
            updateLayerThumbnail(targetLayerId, true);
          }
        });
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
      flushPendingHistoryTasks,
      selection,
      dimensions,
      colorMode,
      startLiquifyLoop,
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
        const persistent = liquifyPersistentRef.current;
        if (!isLiquifyingRef.current || !persistent || liquifySessionsRef.current.length === 0) {
          return true;
        }
        const pt = getCanvasCoords(e);
        const pressure = e.pressure || 1.0;
        liquifyLastPointerPosRef.current = { pt, pressure };

        const prev = prevLiquifyPointRef.current || pt;
        const dist = Math.hypot(pt.x - prev.x, pt.y - prev.y);
        const stepDist = Math.max(2, (liquifySettings.size / 2) * 0.25);
        const numSteps = Math.max(1, Math.ceil(dist / stepDist));
        const grid = documentStore.getActiveTileGrid();

        // Accumulate all sub-steps in float32 warp space, then resample pixels ONCE
        const subSteps: LiquifySubStep[] = new Array(numSteps);
        for (let i = 1; i <= numSteps; i++) {
          const t = i / numSteps;
          const tPrev = (i - 1) / numSteps;
          subSteps[i - 1] = {
            cx: prev.x + (pt.x - prev.x) * t,
            cy: prev.y + (pt.y - prev.y) * t,
            prevX: prev.x + (pt.x - prev.x) * tPrev,
            prevY: prev.y + (pt.y - prev.y) * tPrev,
            pressure,
          };
        }

        const batchDirty = persistent.warpField.applySubSteps(
          subSteps,
          dimensions,
          liquifySettings,
          liquifySelectionMaskRef.current
        );

        prevLiquifyPointRef.current = pt;

        if (batchDirty) {
          let anyDirty = false;
          for (const session of liquifySessionsRef.current) {
            const dirty = resampleLayerFromWarpField({
              grid,
              layerId: session.layerId,
              dimensions,
              targetFormat: session.targetFormat,
              warpField: persistent.warpField,
              dirtyRect: batchDirty,
              beforeTileSnapshot: session.beforeTileSnapshot,
              origRgbaCache: session.origRgbaCache,
            });
            if (dirty) {
              session.dirtyRect = mergeDirtyRects(session.dirtyRect, dirty);
              anyDirty = true;
            }
          }
          if (anyDirty) {
            grid.notifyChange(true);
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
    [dimensions, getCanvasCoords, handleSampleColor]
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

        if (
          !activeLayer ||
          activeLayer.type !== 'raster' ||
          activeLayer.locked ||
          !isLayerEffectivelyVisible(activeLayer)
        ) {
          return true;
        }

        flushPendingHistoryTasks?.();
        const isMono =
          colorMode === 'monochrome' || activeLayer.expressionColor === 'monochrome';
        const grid = documentStore.getActiveTileGrid();
        const fillColor = resolveShapeFillColor(shapeSettings, primaryColor, secondaryColor);
        const finalPreview: ShapeDragPreview = {
          start: drag.start,
          end: pt,
          shiftKey: e.shiftKey || drag.shiftKey,
          altKey: e.altKey || drag.altKey,
          settings: shapeSettings,
        };

        const { dirtyRect, tileDeltas } = rasterizeShapeToTileGrid(
          grid,
          activeLayerId,
          dimensions,
          finalPreview,
          primaryColor,
          fillColor,
          selection,
          colorMode,
          isMono,
          Boolean(activeLayer.alphaLocked)
        );

        if (dirtyRect && tileDeltas.length > 0) {
          const shapeName =
            shapeSettings.shape.charAt(0).toUpperCase() + shapeSettings.shape.slice(1);
          pushHistoryStep(
            'shape',
            `Shape: ${shapeName}`,
            null,
            null,
            activeLayerId,
            dirtyRect,
            tileDeltas
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

          const persistent = liquifyPersistentRef.current;
          for (const session of sessions) {
            if (persistent) {
              const entry = persistent.layers.get(session.layerId);
              if (entry) entry.lastVersion = grid.getLayerVersion(session.layerId);
            }
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
        flushPendingHistoryTasks?.();
        if (!activeLayerId || activeLayer?.locked) return true;

        const grid = documentStore.getActiveTileGrid();
        const isBg = activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg');
        const isMono =
          !isBg && (colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome');
        const targetFormat: TileFormat = isMono ? 'monochrome-1bit' : 'color-32bit';

        const res = executeLassoFillOnTileGrid({
          grid,
          targetLayerId: activeLayerId,
          dimensions,
          polygon: pts,
          fillColorHex: primaryColor,
          targetFormat,
          alphaLocked: Boolean(activeLayer?.alphaLocked),
        });

        if (res.modified && res.tileDeltas.length > 0) {
          pushHistoryStep(
            'fill',
            'Lasso Fill',
            null,
            null,
            activeLayerId,
            res.dirtyRect ?? undefined,
            res.tileDeltas
          );
          updateLayerThumbnail(activeLayerId, true);
        }
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
          flushPendingHistoryTasks?.();
          const res = divideFrameFolder(targetFolder.id, s, pt, dpi, divideMode);
          if (res.divided) {
            pushHistoryStep(
              'frame',
              divideMode === 'split-folders' ? 'Divide Frame Folder' : 'Divide Frame Border',
              null,
              null,
              targetFolder.id,
              undefined,
              res.tileDeltas,
              undefined,
              undefined,
              undefined,
              undefined,
              res.layerTreeDelta
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
          flushPendingHistoryTasks?.();
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
          const { folder, layerTreeDelta } = createFrameFolder([rectFrame], undefined, true);
          pushHistoryStep(
            'frame',
            'Create Frame Folder',
            null,
            null,
            folder.id,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            layerTreeDelta
          );
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
      pushHistoryStep,
      updateLayerThumbnail,
      flushPendingHistoryTasks,
      dimensions,
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
