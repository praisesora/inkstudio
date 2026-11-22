import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CanvasColorMode,
  CanvasDimensions,
  CanvasSelection,
  LayerItem,
  Point2D,
} from '../../types/editor';
import {
  RetouchStrokeSession,
  applyRetouchStrokeSegment,
  createRetouchStrokeSession,
} from '../../utils/retouchEngine';
import { createSelectionMask } from '../../utils/tonalEngine';
import { documentStore } from '../../utils/documentStore';
import { TileFormat } from '../../utils/tileEngine';
import { multiplayerService } from '../../services/multiplayerService';
import { toolStoreActions, useToolStore } from '../../stores';
import type { PushHistoryStepFn } from './types';

export interface CloneSourceIndicator {
  anchor: Point2D;
  liveSamplePos: Point2D | null;
  isPicking: boolean;
}

export interface UseRetouchToolParams {
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  activeLayer: LayerItem | undefined;
  activeLayerId: string;
  selection: CanvasSelection | null;
  flushPendingHistoryTasks?: () => void;
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean;
  getEffectiveOpacity: (layer: LayerItem) => number;
  getCanvasCoords: (e: React.PointerEvent<HTMLElement> | PointerEvent) => Point2D;
  updateLayerThumbnail: (layerId: string, immediate?: boolean) => void;
  pushHistoryStep: PushHistoryStepFn;
  showToast?: (msg: string) => void;
}

export interface UseRetouchToolResult {
  cloneSourceIndicator: CloneSourceIndicator | null;
  isPickingCloneSource: boolean;
  setIsPickingCloneSource: React.Dispatch<React.SetStateAction<boolean>>;
  handleRetouchPointerDown: (e: React.PointerEvent<HTMLElement>, pt: Point2D) => boolean;
  handleRetouchPointerMove: (e: React.PointerEvent<HTMLElement>) => boolean;
  handleRetouchPointerUp: (e: React.PointerEvent<HTMLElement>) => boolean;
}

const MODE_LABELS: Record<string, string> = {
  smudge: 'Smudge',
  blur: 'Blur',
  dodge: 'Dodge',
  burn: 'Burn',
  'clone-stamp': 'Clone Stamp',
};

export function useRetouchTool({
  dimensions,
  colorMode,
  layers,
  activeLayer,
  activeLayerId,
  selection,
  flushPendingHistoryTasks,
  isLayerEffectivelyVisible,
  getEffectiveOpacity,
  getCanvasCoords,
  updateLayerThumbnail,
  pushHistoryStep,
  showToast,
}: UseRetouchToolParams): UseRetouchToolResult {
  const cloneAnchor = useToolStore((s) => s.cloneSourceAnchor);
  const isPickingCloneSource = useToolStore((s) => s.isPickingCloneSource);
  const [liveSamplePos, setLiveSamplePos] = useState<Point2D | null>(null);

  const setCloneAnchor = useCallback((anchor: Point2D | null) => {
    toolStoreActions.setCloneSourceAnchor(anchor);
  }, []);
  const setIsPickingCloneSource: React.Dispatch<React.SetStateAction<boolean>> = useCallback(
    (next) => {
      const val =
        typeof next === 'function' ? next(useToolStore.getState().isPickingCloneSource) : next;
      toolStoreActions.setIsPickingCloneSource(val);
    },
    []
  );

  const isActiveRef = useRef<boolean>(false);
  const sessionRef = useRef<RetouchStrokeSession | null>(null);
  const alignedOffsetRef = useRef<Point2D | null>(null);
  const cloneAnchorRef = useRef<Point2D | null>(null);
  cloneAnchorRef.current = cloneAnchor;
  const isPickingRef = useRef<boolean>(false);
  isPickingRef.current = isPickingCloneSource;

  useEffect(() => {
    let prevTool = useToolStore.getState().tool;
    return useToolStore.subscribe(() => {
      const curTool = useToolStore.getState().tool;
      if (prevTool === 'retouch' && curTool !== 'retouch') {
        setIsPickingCloneSource(false);
        setLiveSamplePos(null);
      }
      prevTool = curTool;
    });
  }, []);

  const handleRetouchPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, pt: Point2D): boolean => {
      const { tool, retouchSettings, primaryColor } = useToolStore.getState();
      if (tool !== 'retouch') return false;
      e.preventDefault();

      // Alt+Click or armed Pick button sets Clone Stamp source point
      if (retouchSettings.mode === 'clone-stamp' && (e.altKey || isPickingRef.current)) {
        setCloneAnchor({ x: pt.x, y: pt.y });
        setLiveSamplePos(null);
        alignedOffsetRef.current = null;
        setIsPickingCloneSource(false);
        showToast?.(`Clone source set (${Math.round(pt.x)}, ${Math.round(pt.y)})`);
        return true;
      }

      if (
        !activeLayer ||
        activeLayer.type !== 'raster' ||
        activeLayer.locked ||
        !isLayerEffectivelyVisible(activeLayer)
      ) {
        showToast?.('Select an unlocked, visible raster layer to use Retouch tools');
        return true;
      }

      let cloneOffset: Point2D | null = null;
      if (retouchSettings.mode === 'clone-stamp') {
        const anchor = cloneAnchorRef.current;
        if (!anchor) {
          showToast?.('Alt+Click on canvas (or click Pick Source) to set Clone Stamp origin');
          return true;
        }
        if (retouchSettings.cloneAligned && alignedOffsetRef.current) {
          cloneOffset = { ...alignedOffsetRef.current };
        } else {
          cloneOffset = { x: anchor.x - pt.x, y: anchor.y - pt.y };
          if (retouchSettings.cloneAligned) {
            alignedOffsetRef.current = { ...cloneOffset };
          }
        }
        setLiveSamplePos({ x: pt.x + cloneOffset.x, y: pt.y + cloneOffset.y });
      }

      flushPendingHistoryTasks?.();
      const grid = documentStore.getActiveTileGrid();
      const isBg = activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg');
      const isMono =
        !isBg && (colorMode === 'monochrome' || activeLayer.expressionColor === 'monochrome');
      const targetFormat: TileFormat = isMono ? 'monochrome-1bit' : 'color-32bit';
      const selMask = selection
        ? createSelectionMask(selection, dimensions.width, dimensions.height)
        : null;

      const session = createRetouchStrokeSession({
        mode: retouchSettings.mode,
        layerId: activeLayerId,
        targetFormat,
        alphaLock: Boolean(activeLayer.alphaLocked),
        dimensions,
        selectionMask: selMask,
        cloneOffset,
        visibleLayers: layers,
        isLayerVisible: isLayerEffectivelyVisible,
        getEffectiveOpacity,
      });

      sessionRef.current = session;
      isActiveRef.current = true;

      try {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // Ignore capture errors
      }

      const dirty = applyRetouchStrokeSegment({
        grid,
        session,
        pt,
        pressure: e.pressure || 1.0,
        settings: retouchSettings,
        primaryColor,
      });
      if (dirty) {
        grid.notifyChange(true);
      }
      return true;
    },
    [
      activeLayer,
      activeLayerId,
      colorMode,
      dimensions,
      flushPendingHistoryTasks,
      getEffectiveOpacity,
      isLayerEffectivelyVisible,
      layers,
      selection,
      showToast,
    ]
  );

  const handleRetouchPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>): boolean => {
      const { tool, retouchSettings, primaryColor } = useToolStore.getState();
      if (tool !== 'retouch') return false;
      if (!isActiveRef.current || !sessionRef.current) return true;

      const pt = getCanvasCoords(e);
      const session = sessionRef.current;
      const grid = documentStore.getActiveTileGrid();

      if (session.mode === 'clone-stamp' && session.cloneOffset) {
        setLiveSamplePos({
          x: pt.x + session.cloneOffset.x,
          y: pt.y + session.cloneOffset.y,
        });
      }

      const dirty = applyRetouchStrokeSegment({
        grid,
        session,
        pt,
        pressure: e.pressure || 1.0,
        settings: retouchSettings,
        primaryColor,
      });
      if (dirty) {
        grid.notifyChange(true);
      }
      return true;
    },
    [getCanvasCoords]
  );

  const handleRetouchPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>): boolean => {
      const { tool } = useToolStore.getState();
      if (tool !== 'retouch' && !isActiveRef.current) return false;
      if (!isActiveRef.current || !sessionRef.current) return tool === 'retouch';

      try {
        if ((e.target as HTMLElement).hasPointerCapture?.(e.pointerId)) {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        }
      } catch {
        // Ignore capture release errors
      }

      isActiveRef.current = false;
      const session = sessionRef.current;
      sessionRef.current = null;
      setLiveSamplePos(null);

      if (session.dirtyRect && session.beforeSnapshot.size > 0) {
        const grid = documentStore.getActiveTileGrid();
        const tileDeltas = grid.computeDeltasFromSnapshot(
          session.beforeSnapshot,
          session.layerId,
          session.dirtyRect
        );
        if (tileDeltas.length > 0) {
          pushHistoryStep(
            'retouch',
            MODE_LABELS[session.mode] || 'Retouch',
            null,
            null,
            session.layerId,
            session.dirtyRect,
            tileDeltas
          );
          if (multiplayerService.isConnected()) {
            multiplayerService.sendTileDeltas(tileDeltas, grid);
          }
          updateLayerThumbnail(session.layerId, true);
        }
      }

      session.cloneSourceTileCache.clear();
      return true;
    },
    [pushHistoryStep, updateLayerThumbnail]
  );

  const cloneSourceIndicator: CloneSourceIndicator | null = cloneAnchor
    ? {
        anchor: cloneAnchor,
        liveSamplePos,
        isPicking: isPickingCloneSource,
      }
    : isPickingCloneSource
      ? {
          anchor: { x: -9999, y: -9999 },
          liveSamplePos: null,
          isPicking: true,
        }
      : null;

  return {
    cloneSourceIndicator,
    isPickingCloneSource,
    setIsPickingCloneSource,
    handleRetouchPointerDown,
    handleRetouchPointerMove,
    handleRetouchPointerUp,
  };
}
