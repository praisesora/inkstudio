import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CanvasColorMode,
  CanvasDimensions,
  CanvasSelection,
  GradientDragPreview,
  GradientMeshState,
  LayerItem,
  Point2D,
} from '../../types/editor';
import {
  constrainGradientEndpoint,
  createDefaultGradientMesh,
  renderGradientToTileGrid,
} from '../../utils/gradientEngine';
import { documentStore } from '../../utils/documentStore';
import { TileFormat } from '../../utils/tileEngine';
import { multiplayerService } from '../../services/multiplayerService';
import { interactiveToolBridge, toolStoreActions, useToolStore } from '../../stores';
import type { PushHistoryStepFn } from './types';

export interface UseGradientToolParams {
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

export interface UseGradientToolResult {
  gradientDragPreview: GradientDragPreview | null;
  gradientMesh: GradientMeshState | null;
  setGradientMesh: React.Dispatch<React.SetStateAction<GradientMeshState | null>>;
  handleInitGradientMesh: () => void;
  handleApplyGradientMesh: () => void;
  handleCancelGradientMesh: () => void;
  handleUpdateMeshNode: (index: number, patch: { color?: string; opacity?: number }) => void;
  handleGradientPointerDown: (e: React.PointerEvent<HTMLElement>, pt: Point2D) => boolean;
  handleGradientPointerMove: (e: React.PointerEvent<HTMLElement>) => boolean;
  handleGradientPointerUp: (e: React.PointerEvent<HTMLElement>, pt: Point2D) => boolean;
}

export function useGradientTool({
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
}: UseGradientToolParams): UseGradientToolResult {
  const [gradientDragPreview, setGradientDragPreview] = useState<GradientDragPreview | null>(null);
  const gradientMesh = useToolStore((s) => s.activeGradientMesh);
  const setGradientMesh: React.Dispatch<React.SetStateAction<GradientMeshState | null>> =
    useCallback((updater) => {
      toolStoreActions.setActiveGradientMesh(updater);
    }, []);

  const dragRef = useRef<{ start: Point2D; end: Point2D; type: 'linear' | 'radial' } | null>(null);
  const draggingMeshNodeRef = useRef<number | null>(null);
  const meshRectDragRef = useRef<{ start: Point2D; end: Point2D } | null>(null);
  const gradientMeshRef = useRef<GradientMeshState | null>(null);
  gradientMeshRef.current = gradientMesh;

  const canPaintActiveLayer = useCallback((): boolean => {
    if (
      !activeLayer ||
      activeLayer.type !== 'raster' ||
      activeLayer.locked ||
      !isLayerEffectivelyVisible(activeLayer)
    ) {
      showToast?.('Select an unlocked, visible raster layer to apply gradients');
      return false;
    }
    return true;
  }, [activeLayer, isLayerEffectivelyVisible, showToast]);

  const resolveLayerFormat = useCallback((): TileFormat => {
    const isBg = activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg');
    const isMono =
      !isBg && (colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome');
    return isMono ? 'monochrome-1bit' : 'color-32bit';
  }, [activeLayer?.expressionColor, activeLayerId, colorMode]);

  const handleInitGradientMesh = useCallback(() => {
    const { gradientSettings, primaryColor, secondaryColor } = useToolStore.getState();
    const bounds = selection
      ? selection.bounds
      : {
          x: dimensions.width * 0.1,
          y: dimensions.height * 0.1,
          width: dimensions.width * 0.8,
          height: dimensions.height * 0.8,
        };
    setGradientMesh(
      createDefaultGradientMesh(
        bounds,
        gradientSettings.meshCols,
        gradientSettings.meshRows,
        primaryColor,
        secondaryColor,
        gradientSettings.stops
      )
    );
  }, [dimensions.height, dimensions.width, selection]);

  const handleApplyGradientMesh = useCallback(() => {
    const mesh = gradientMeshRef.current;
    if (!mesh) return;
    if (!canPaintActiveLayer()) return;

    flushPendingHistoryTasks?.();
    const { gradientSettings, primaryColor, secondaryColor } = useToolStore.getState();
    const grid = documentStore.getActiveTileGrid();
    const res = renderGradientToTileGrid({
      grid,
      layerId: activeLayerId,
      dimensions,
      targetFormat: resolveLayerFormat(),
      settings: { ...gradientSettings, type: 'mesh' },
      primaryColor,
      secondaryColor,
      mesh,
      selection,
      alphaLock: Boolean(activeLayer?.alphaLocked),
    });

    if (res.modified && res.tileDeltas.length > 0) {
      pushHistoryStep(
        'gradient',
        'Mesh Gradient',
        null,
        null,
        activeLayerId,
        res.dirtyRect ?? undefined,
        res.tileDeltas
      );
      if (multiplayerService.isConnected()) {
        multiplayerService.sendTileDeltas(res.tileDeltas, grid);
      }
      updateLayerThumbnail(activeLayerId, true);
    }
    setGradientMesh(null);
  }, [
    activeLayer?.alphaLocked,
    activeLayerId,
    canPaintActiveLayer,
    dimensions,
    flushPendingHistoryTasks,
    pushHistoryStep,
    resolveLayerFormat,
    selection,
    updateLayerThumbnail,
  ]);

  const handleCancelGradientMesh = useCallback(() => {
    dragRef.current = null;
    draggingMeshNodeRef.current = null;
    meshRectDragRef.current = null;
    setGradientDragPreview(null);
    setGradientMesh(null);
  }, []);

  const handleUpdateMeshNode = useCallback(
    (index: number, patch: { color?: string; opacity?: number }) => {
      setGradientMesh((prev) => {
        if (!prev || index < 0 || index >= prev.nodes.length) return prev;
        const nextNodes = prev.nodes.map((n, i) => (i === index ? { ...n, ...patch } : n));
        return { ...prev, nodes: nextNodes };
      });
    },
    []
  );

  // Clear preview / mesh when switching away from gradient tool or changing away from mesh type
  useEffect(() => {
    let prevTool = useToolStore.getState().tool;
    let prevType = useToolStore.getState().gradientSettings.type;
    return useToolStore.subscribe(() => {
      const s = useToolStore.getState();
      if (prevTool === 'gradient' && s.tool !== 'gradient') {
        handleCancelGradientMesh();
      } else if (prevType === 'mesh' && s.gradientSettings.type !== 'mesh') {
        setGradientMesh(null);
      }
      prevTool = s.tool;
      prevType = s.gradientSettings.type;
    });
  }, [handleCancelGradientMesh]);

  // Register bridge callbacks so ToolPropertyInspector can invoke mesh actions without prop drilling
  useEffect(() => {
    interactiveToolBridge.initGradientMesh = handleInitGradientMesh;
    interactiveToolBridge.applyGradientMesh = handleApplyGradientMesh;
    interactiveToolBridge.cancelGradientMesh = handleCancelGradientMesh;
    return () => {
      interactiveToolBridge.initGradientMesh = undefined;
      interactiveToolBridge.applyGradientMesh = undefined;
      interactiveToolBridge.cancelGradientMesh = undefined;
    };
  }, [handleApplyGradientMesh, handleCancelGradientMesh, handleInitGradientMesh]);

  // Enter commits mesh, Escape cancels drag or mesh
  useEffect(() => {
    if (!gradientMesh && !gradientDragPreview) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        handleCancelGradientMesh();
      } else if (ev.key === 'Enter' && gradientMeshRef.current) {
        ev.preventDefault();
        handleApplyGradientMesh();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [gradientDragPreview, gradientMesh, handleApplyGradientMesh, handleCancelGradientMesh]);

  const handleGradientPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, pt: Point2D): boolean => {
      const { tool, gradientSettings, primaryColor, secondaryColor } = useToolStore.getState();
      if (tool !== 'gradient') return false;
      e.preventDefault();

      if (!canPaintActiveLayer()) return true;

      try {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture errors
      }

      if (gradientSettings.type === 'mesh') {
        const mesh = gradientMeshRef.current;
        if (mesh) {
          const hitRadius = 14 / Math.max(0.1, zoomRef.current || 1);
          let hitIdx = -1;
          let bestDist = hitRadius;
          for (let i = 0; i < mesh.nodes.length; i++) {
            const d = Math.hypot(mesh.nodes[i].x - pt.x, mesh.nodes[i].y - pt.y);
            if (d <= bestDist) {
              bestDist = d;
              hitIdx = i;
            }
          }
          if (hitIdx >= 0) {
            draggingMeshNodeRef.current = hitIdx;
            setGradientMesh((prev) => (prev ? { ...prev, selectedNodeIndex: hitIdx } : prev));
            return true;
          }
        }
        // Start dragging a new mesh bounding box (or click to initialize default bounds)
        meshRectDragRef.current = { start: pt, end: pt };
        const initial = createDefaultGradientMesh(
          { x: pt.x, y: pt.y, width: 1, height: 1 },
          gradientSettings.meshCols,
          gradientSettings.meshRows,
          primaryColor,
          secondaryColor,
          gradientSettings.stops
        );
        setGradientMesh(initial);
        return true;
      }

      const mode = gradientSettings.type === 'radial' ? 'radial' : 'linear';
      dragRef.current = { start: pt, end: pt, type: mode };
      setGradientDragPreview({
        type: mode,
        start: pt,
        end: pt,
        settings: gradientSettings,
      });
      return true;
    },
    [canPaintActiveLayer, zoomRef]
  );

  const handleGradientPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>): boolean => {
      const { tool, gradientSettings, primaryColor, secondaryColor } = useToolStore.getState();
      if (tool !== 'gradient') return false;

      if (draggingMeshNodeRef.current !== null && gradientMeshRef.current) {
        const pt = getCanvasCoords(e);
        const nodeIdx = draggingMeshNodeRef.current;
        setGradientMesh((prev) => {
          if (!prev || nodeIdx < 0 || nodeIdx >= prev.nodes.length) return prev;
          const nextNodes = prev.nodes.map((n, i) =>
            i === nodeIdx ? { ...n, x: pt.x, y: pt.y } : n
          );
          return { ...prev, nodes: nextNodes };
        });
        return true;
      }

      if (meshRectDragRef.current) {
        const pt = getCanvasCoords(e);
        meshRectDragRef.current.end = pt;
        const s = meshRectDragRef.current.start;
        const x = Math.min(s.x, pt.x);
        const y = Math.min(s.y, pt.y);
        const w = Math.max(4, Math.abs(pt.x - s.x));
        const h = Math.max(4, Math.abs(pt.y - s.y));
        setGradientMesh(
          createDefaultGradientMesh(
            { x, y, width: w, height: h },
            gradientSettings.meshCols,
            gradientSettings.meshRows,
            primaryColor,
            secondaryColor,
            gradientSettings.stops
          )
        );
        return true;
      }

      if (dragRef.current) {
        const rawPt = getCanvasCoords(e);
        const pt = e.shiftKey ? constrainGradientEndpoint(dragRef.current.start, rawPt) : rawPt;
        dragRef.current.end = pt;
        setGradientDragPreview({
          type: dragRef.current.type,
          start: dragRef.current.start,
          end: pt,
          settings: gradientSettings,
        });
        return true;
      }

      return false;
    },
    [getCanvasCoords]
  );

  const handleGradientPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>, pt: Point2D): boolean => {
      const { tool, gradientSettings, primaryColor, secondaryColor } = useToolStore.getState();
      if (tool !== 'gradient') return false;

      try {
        if ((e.target as HTMLElement).hasPointerCapture?.(e.pointerId)) {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore capture release errors
      }

      if (draggingMeshNodeRef.current !== null) {
        draggingMeshNodeRef.current = null;
        return true;
      }

      if (meshRectDragRef.current) {
        const start = meshRectDragRef.current.start;
        meshRectDragRef.current = null;
        if (Math.hypot(pt.x - start.x, pt.y - start.y) < 12) {
          handleInitGradientMesh();
        }
        return true;
      }

      if (dragRef.current) {
        const start = dragRef.current.start;
        const end = e.shiftKey ? constrainGradientEndpoint(start, pt) : pt;
        const dragType = dragRef.current.type;
        dragRef.current = null;
        setGradientDragPreview(null);

        if (Math.hypot(end.x - start.x, end.y - start.y) < 2) {
          return true;
        }
        if (!canPaintActiveLayer()) return true;

        flushPendingHistoryTasks?.();
        const grid = documentStore.getActiveTileGrid();
        const res = renderGradientToTileGrid({
          grid,
          layerId: activeLayerId,
          dimensions,
          targetFormat: resolveLayerFormat(),
          settings: { ...gradientSettings, type: dragType },
          primaryColor,
          secondaryColor,
          start,
          end,
          selection,
          alphaLock: Boolean(activeLayer?.alphaLocked),
        });

        if (res.modified && res.tileDeltas.length > 0) {
          pushHistoryStep(
            'gradient',
            dragType === 'radial' ? 'Radial Gradient' : 'Linear Gradient',
            null,
            null,
            activeLayerId,
            res.dirtyRect ?? undefined,
            res.tileDeltas
          );
          if (multiplayerService.isConnected()) {
            multiplayerService.sendTileDeltas(res.tileDeltas, grid);
          }
          updateLayerThumbnail(activeLayerId, true);
        }
        return true;
      }

      return false;
    },
    [
      activeLayer?.alphaLocked,
      activeLayerId,
      canPaintActiveLayer,
      dimensions,
      flushPendingHistoryTasks,
      handleInitGradientMesh,
      pushHistoryStep,
      resolveLayerFormat,
      selection,
      updateLayerThumbnail,
    ]
  );

  return {
    gradientDragPreview,
    gradientMesh,
    setGradientMesh,
    handleInitGradientMesh,
    handleApplyGradientMesh,
    handleCancelGradientMesh,
    handleUpdateMeshNode,
    handleGradientPointerDown,
    handleGradientPointerMove,
    handleGradientPointerUp,
  };
}
