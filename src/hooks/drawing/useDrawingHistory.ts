import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  CanvasDimensions,
  CanvasColorMode,
  DirtyRect,
  HistoryActionType,
  HistoryItem,
  HistoryItemMeta,
  LayerItem,
  LayerTreeDelta,
  TileDelta,
  VectorStroke,
} from '../../types/editor';
import {
  SparseTileGrid,
  globalTileGrid,
  parseTileKey,
  releaseTemporaryCanvas,
} from '../../utils/tileEngine';
import { UndoCacheManager, globalUndoCache } from '../../utils/undoCache';
import { documentStore } from '../../utils/documentStore';
import { performanceManager } from '../../utils/performanceManager';
import { multiplayerService } from '../../services/multiplayerService';
import { recoveryService } from '../../services/recoveryService';
import { renderVectorLayer } from '../../utils/vectorEngine';
import { createCanvasThumbnail, formatTime, get2DContext } from '../../utils/canvasUtils';
import {
  ApplyLayerTreeDeltaFn,
  isBackgroundLayerId,
  LastStrokeEndState,
  PushHistoryStepFn,
} from './types';

type IdleCallbackWindow = Window & {
  requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

export interface UseDrawingHistoryParams {
  activeSessionId?: string | null;
  tileGrid?: SparseTileGrid;
  activeLayerId: string;
  activeLayerLocked: boolean;
  dimensions: CanvasDimensions;
  dimensionsRef: React.MutableRefObject<CanvasDimensions>;
  activeLayerIdRef: React.MutableRefObject<string>;
  colorModeRef: React.MutableRefObject<CanvasColorMode>;
  layersRef: React.MutableRefObject<LayerItem[] | undefined>;
  onUpdateLayerThumbnail: (layerId: string, immediate?: boolean) => void;
  onApplyLayerTreeDeltaRef?: React.MutableRefObject<ApplyLayerTreeDeltaFn | undefined>;
  onUpdateMaskThumbnailRef: React.MutableRefObject<((layerId: string) => void) | undefined>;
  isDrawingRef: React.MutableRefObject<boolean>;
  lastStrokeEndRef: React.MutableRefObject<LastStrokeEndState | null>;
  abortActiveStrokeRef: React.MutableRefObject<() => void>;
}

export interface SelectiveUndoResult {
  strokeId?: string;
  layerId: string;
  tileDeltas?: TileDelta[];
  syncedRemotely?: boolean;
}

export interface UseDrawingHistoryResult {
  activeSessionIdRef: React.MutableRefObject<string | null>;
  activeTileGridRef: React.MutableRefObject<SparseTileGrid>;
  activeUndoCacheRef: React.MutableRefObject<UndoCacheManager>;
  historyList: HistoryItemMeta[];
  historyIndex: number;
  canUndo: boolean;
  canRedo: boolean;
  pushHistoryStep: PushHistoryStepFn;
  flushPendingHistoryTasks: () => void;
  enqueueHistoryTask: (task: () => void) => void;
  jumpToHistoryIndex: (targetIndex: number) => Promise<void>;
  undo: () => void;
  redo: () => void;
  selectiveUndo: (
    peerIdToUndo?: string | number,
    strokeIdToUndo?: string
  ) => Promise<SelectiveUndoResult | null>;
  clearCanvas: () => void;
  resetHistory: (targetDocumentId?: string) => void;
}

export function useDrawingHistory({
  activeSessionId,
  tileGrid,
  activeLayerId,
  activeLayerLocked,
  dimensions,
  dimensionsRef,
  activeLayerIdRef,
  colorModeRef,
  layersRef,
  onUpdateLayerThumbnail,
  onApplyLayerTreeDeltaRef,
  onUpdateMaskThumbnailRef,
  isDrawingRef,
  lastStrokeEndRef,
  abortActiveStrokeRef,
}: UseDrawingHistoryParams): UseDrawingHistoryResult {
  const activeSessionIdRef = useRef<string | null>(activeSessionId ?? null);
  const activeTileGridRef = useRef<SparseTileGrid>(
    tileGrid ??
      (activeSessionId
        ? documentStore.getOrCreateSession(activeSessionId).tileGrid
        : globalTileGrid)
  );
  const activeUndoCacheRef = useRef<UndoCacheManager>(
    activeSessionId
      ? documentStore.getOrCreateSession(activeSessionId).undoCache
      : globalUndoCache
  );

  const initialSession = activeSessionId
    ? documentStore.getOrCreateSession(activeSessionId)
    : null;
  const historyRef = useRef<HistoryItem[]>(initialSession ? initialSession.history : []);
  const historyIndexRef = useRef<number>(initialSession ? initialSession.historyIndex : -1);
  const historyQueueRef = useRef<Promise<void>>(Promise.resolve());

  const [historyList, setHistoryList] = useState<HistoryItemMeta[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  if (tileGrid) {
    activeTileGridRef.current = tileGrid;
  } else if (activeSessionId) {
    const sess = documentStore.getOrCreateSession(activeSessionId);
    activeTileGridRef.current = sess.tileGrid;
    activeUndoCacheRef.current = sess.undoCache;
  }

  const persistSessionHistory = useCallback((docId?: string | null) => {
    const targetDocId = docId !== undefined ? docId : activeSessionIdRef.current;
    if (!targetDocId) return;
    const sess = documentStore.getSession(targetDocId);
    if (sess) {
      sess.history = historyRef.current;
      sess.historyIndex = historyIndexRef.current;
    }
  }, []);

  const syncHistoryState = useCallback(() => {
    const idx = historyIndexRef.current;
    const len = historyRef.current.length;
    setHistoryIndex(idx);
    setCanUndo(idx > 0);
    setCanRedo(idx >= 0 && idx < len - 1);
    setHistoryList(
      historyRef.current.map((item) => ({
        id: item.id,
        type: item.type,
        label: item.label,
        timestamp: item.timestamp,
        timeFormatted: item.timeFormatted,
        thumbnailUrl: item.thumbnailUrl,
        layerId: item.layerId,
      }))
    );
  }, []);

  const ensureInitialHistory = useCallback(() => {
    if (historyRef.current.length === 0) {
      const now = Date.now();
      const targetLayerId = activeLayerIdRef.current;
      const dims = dimensionsRef.current;
      const grid = activeTileGridRef.current;
      const initialThumb = targetLayerId
        ? createCanvasThumbnail(
            { grid, layerId: targetLayerId, dimensions: dims },
            !isBackgroundLayerId(targetLayerId)
          )
        : '';

      const initialItem: HistoryItem = {
        id: `hist-init-${now}`,
        type: 'initial',
        label: 'New Document',
        timestamp: now,
        timeFormatted: formatTime(now),
        thumbnailUrl: initialThumb,
        imageData: undefined,
        beforeImageData: null,
        afterImageData: null,
        layerId: targetLayerId,
      };

      historyRef.current = [initialItem];
      historyIndexRef.current = 0;
      persistSessionHistory();
      syncHistoryState();
    }
  }, [activeLayerIdRef, dimensionsRef, persistSessionHistory, syncHistoryState]);

  const pushHistoryStep = useCallback<PushHistoryStepFn>(
    (
      actionType: HistoryActionType,
      label: string,
      beforeData: ImageData | null,
      afterData: ImageData | null,
      targetLayerId: string,
      dirtyRect?: DirtyRect,
      explicitTileDeltas?: TileDelta[],
      vectorDelta?: { before: VectorStroke[]; after: VectorStroke[] },
      peerId?: string | number,
      strokeId?: string,
      isMaskEdit?: boolean,
      layerTreeDelta?: LayerTreeDelta
    ) => {
      ensureInitialHistory();
      const now = Date.now();
      const dims = dimensionsRef.current;
      const grid = activeTileGridRef.current;
      const docId = activeSessionIdRef.current;
      const undoCache = activeUndoCacheRef.current;

      let tileDeltas = explicitTileDeltas;

      const effectiveDirtyRect =
        dirtyRect ||
        (dims.width > 0 && dims.height > 0
          ? { x: 0, y: 0, width: dims.width, height: dims.height }
          : undefined);

      if (!isMaskEdit && !tileDeltas && effectiveDirtyRect && (beforeData || afterData)) {
        const activeLayer = layersRef.current?.find((l) => l.id === targetLayerId);
        const isMono =
          !isBackgroundLayerId(targetLayerId) &&
          (colorModeRef.current === 'monochrome' ||
            activeLayer?.expressionColor === 'monochrome');
        const targetFormat = isMono ? 'monochrome-1bit' : 'color-32bit';

        if (beforeData) {
          const bx =
            beforeData.width === effectiveDirtyRect.width &&
            beforeData.height === effectiveDirtyRect.height
              ? effectiveDirtyRect.x
              : 0;
          const by =
            beforeData.width === effectiveDirtyRect.width &&
            beforeData.height === effectiveDirtyRect.height
              ? effectiveDirtyRect.y
              : 0;
          grid.writeImageData(targetLayerId, beforeData, bx, by, targetFormat);
        }

        const beforeSnapshot = grid.snapshotTilesInRect(targetLayerId, effectiveDirtyRect);

        if (afterData) {
          const ax =
            afterData.width === effectiveDirtyRect.width &&
            afterData.height === effectiveDirtyRect.height
              ? effectiveDirtyRect.x
              : 0;
          const ay =
            afterData.width === effectiveDirtyRect.width &&
            afterData.height === effectiveDirtyRect.height
              ? effectiveDirtyRect.y
              : 0;
          grid.writeImageData(targetLayerId, afterData, ax, ay, targetFormat);
        } else if (actionType === 'clear') {
          grid.clearLayer(targetLayerId);
        }

        tileDeltas = grid.computeDeltasFromSnapshot(
          beforeSnapshot,
          targetLayerId,
          effectiveDirtyRect
        );
      }

      const hasDeltas = Boolean(tileDeltas && tileDeltas.length > 0);

      // Coalesce rapid continuous property slider edits (e.g. opacity, tone frequency) into one undo step
      if (
        !hasDeltas &&
        layerTreeDelta?.coalesceKey &&
        layerTreeDelta.beforeLayers &&
        layerTreeDelta.afterLayers &&
        historyIndexRef.current >= 0 &&
        historyIndexRef.current === historyRef.current.length - 1
      ) {
        const topItem = historyRef.current[historyIndexRef.current];
        if (
          topItem &&
          topItem.layerTreeDelta?.coalesceKey === layerTreeDelta.coalesceKey &&
          topItem.layerTreeDelta.beforeLayers &&
          now - topItem.timestamp <= 800
        ) {
          topItem.label = label;
          topItem.timestamp = now;
          topItem.timeFormatted = formatTime(now);
          topItem.layerTreeDelta = {
            ...topItem.layerTreeDelta,
            afterLayers: layerTreeDelta.afterLayers,
            afterActiveLayerId: layerTreeDelta.afterActiveLayerId,
          };
          persistSessionHistory(docId);
          syncHistoryState();
          return;
        }
      }

      const item: HistoryItem = {
        id: `hist-${now}-${Math.random().toString(36).substring(2, 7)}`,
        type: actionType,
        label,
        timestamp: now,
        timeFormatted: formatTime(now),
        thumbnailUrl: '',
        layerId: targetLayerId,
        beforeImageData: hasDeltas ? null : beforeData,
        afterImageData: hasDeltas ? null : afterData,
        imageData: hasDeltas ? undefined : afterData || undefined,
        dirtyRect: effectiveDirtyRect,
        tileDeltas: hasDeltas ? tileDeltas : undefined,
        vectorStrokesDelta: vectorDelta,
        layerTreeDelta,
        peerId,
        strokeId,
        isMaskEdit,
      };

      const newHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
      newHistory.push(item);

      const maxHistorySteps = Math.max(
        10,
        Math.min(200, performanceManager.getConfig().maxHistorySteps || 50)
      );
      while (newHistory.length > maxHistorySteps) {
        newHistory.shift();
      }

      historyRef.current = newHistory;
      historyIndexRef.current = newHistory.length - 1;
      persistSessionHistory(docId);

      if (dims.width > 0 && dims.height > 0) {
        const isLarge = dims.width * dims.height > 1024 * 1024;
        if (isLarge && hasDeltas) {
          const existingLayerThumb =
            layersRef.current?.find((l) => l.id === targetLayerId)?.thumbnailUrl || '';
          item.thumbnailUrl = existingLayerThumb;
        } else {
          item.thumbnailUrl = createCanvasThumbnail(
            { grid, layerId: targetLayerId, dimensions: dims },
            !isBackgroundLayerId(targetLayerId)
          );
        }
      }
      syncHistoryState();

      if (tileDeltas && tileDeltas.length > 0) {
        const registerPromise = docId
          ? documentStore.registerUndoStep(docId, item)
          : undoCache.registerStep(
              item,
              historyRef.current,
              performanceManager.getConfig().undoRamSteps
            );
        registerPromise.catch((err) => {
          console.warn('[History] LRU cache registration failed:', err);
        });
      }

      if ((tileDeltas && tileDeltas.length > 0) || vectorDelta) {
        const sessionKey = docId || recoveryService.getCurrentSessionId() || 'default-session';
        recoveryService.logStrokeDelta(sessionKey, tileDeltas, vectorDelta, targetLayerId);
      }

      // Broadcast authoritative LZ4 BINARY_TILEs after any local raster op (fill, transform, liquify, filter, tonal, shape, etc.)
      // Strokes are already broadcast immediately on pointerup and deduped via WeakSet inside sendTileDeltas.
      if (
        !peerId &&
        !isMaskEdit &&
        tileDeltas &&
        tileDeltas.length > 0 &&
        multiplayerService.isConnected()
      ) {
        multiplayerService.sendTileDeltas(tileDeltas, grid);
      }
    },
    [colorModeRef, dimensionsRef, ensureInitialHistory, layersRef, persistSessionHistory, syncHistoryState]
  );

  const pendingHistoryTasksRef = useRef<Array<() => void>>([]);
  const idleCallbackIdRef = useRef<number | ReturnType<typeof setTimeout> | null>(null);

  const flushPendingHistoryTasks = useCallback(() => {
    if (idleCallbackIdRef.current !== null) {
      const win = typeof window !== 'undefined' ? (window as IdleCallbackWindow) : null;
      if (win?.cancelIdleCallback && typeof idleCallbackIdRef.current === 'number') {
        win.cancelIdleCallback(idleCallbackIdRef.current);
      } else {
        clearTimeout(idleCallbackIdRef.current as ReturnType<typeof setTimeout>);
      }
      idleCallbackIdRef.current = null;
    }
    const tasks = pendingHistoryTasksRef.current.splice(0);
    for (const task of tasks) {
      try {
        task();
      } catch (err) {
        console.warn('[History] Error flushing pending history task:', err);
      }
    }
  }, []);

  const enqueueHistoryTask = useCallback(
    (task: () => void) => {
      pendingHistoryTasksRef.current.push(task);
      if (idleCallbackIdRef.current === null) {
        const win = typeof window !== 'undefined' ? (window as IdleCallbackWindow) : null;
        const scheduleRun = () => {
          if (win?.requestIdleCallback) {
            idleCallbackIdRef.current = win.requestIdleCallback(runTasks, { timeout: 1200 });
          } else {
            idleCallbackIdRef.current = setTimeout(runTasks, 32);
          }
        };
        const runTasks = () => {
          idleCallbackIdRef.current = null;
          if (isDrawingRef.current) {
            scheduleRun();
            return;
          }
          const sliceBudgetMs = 6;
          const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
          while (pendingHistoryTasksRef.current.length > 0) {
            if (isDrawingRef.current) {
              break;
            }
            const nextTask = pendingHistoryTasksRef.current.shift();
            if (!nextTask) break;
            try {
              nextTask();
            } catch (err) {
              console.warn('[History] Error running idle history task:', err);
            }
            const elapsed =
              (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
            if (elapsed >= sliceBudgetMs && pendingHistoryTasksRef.current.length > 0) {
              break;
            }
          }
          if (pendingHistoryTasksRef.current.length > 0) {
            scheduleRun();
          }
        };
        scheduleRun();
      }
    },
    [isDrawingRef]
  );

  const jumpToHistoryIndex = useCallback(
    (targetIndex: number): Promise<void> => {
      flushPendingHistoryTasks();
      if (isDrawingRef.current) {
        abortActiveStrokeRef.current();
      }
      const nextOp = historyQueueRef.current.then(async () => {
        if (targetIndex < 0 || targetIndex >= historyRef.current.length) return;
        const currentIndex = historyIndexRef.current;
        if (targetIndex === currentIndex) return;

        const grid = activeTileGridRef.current;
        const undoCache = activeUndoCacheRef.current;
        const dims = dimensionsRef.current;

        if (targetIndex < currentIndex) {
          for (let i = currentIndex; i > targetIndex; i--) {
            const item = historyRef.current[i];
            if (item) {
              const targetLayerId = item.layerId || activeLayerId;
              const targetLayer = layersRef.current?.find((l) => l.id === targetLayerId);
              const deltas = await undoCache.resolveDeltas(item);

              if (item.layerTreeDelta) {
                const applied = onApplyLayerTreeDeltaRef?.current?.(item.layerTreeDelta, 'undo');
                if (applied) {
                  layersRef.current = applied.nextLayers;
                  if (applied.nextActiveLayerId !== null) {
                    activeLayerIdRef.current = applied.nextActiveLayerId;
                  }
                }
                if (deltas && deltas.length > 0) {
                  grid.applyTileDeltas(deltas, 'undo');
                  if (multiplayerService.isConnected()) {
                    multiplayerService.sendTileDeltas(deltas, grid, { force: true });
                  }
                }
                const liveLayerIds = new Set((layersRef.current ?? []).map((l) => l.id));
                const affectedLayerIds = new Set<string>();
                if (deltas) {
                  for (const d of deltas) {
                    affectedLayerIds.add(parseTileKey(d.key).layerId);
                  }
                }
                if (applied) {
                  for (const added of applied.addedLayers) {
                    affectedLayerIds.add(added.id);
                  }
                }
                for (const lid of affectedLayerIds) {
                  if (lid !== targetLayerId && liveLayerIds.has(lid)) {
                    onUpdateLayerThumbnail(lid, true);
                  }
                }
                grid.notifyChange(true);
              } else if (item.isMaskEdit && targetLayer?.maskCanvas) {
                const mCtx = get2DContext(targetLayer.maskCanvas);
                if (mCtx && item.beforeImageData) {
                  const mx =
                    item.dirtyRect && item.beforeImageData.width === item.dirtyRect.width
                      ? item.dirtyRect.x
                      : 0;
                  const my =
                    item.dirtyRect && item.beforeImageData.height === item.dirtyRect.height
                      ? item.dirtyRect.y
                      : 0;
                  mCtx.putImageData(item.beforeImageData, mx, my);
                  targetLayer.maskVersion = (targetLayer.maskVersion || 0) + 1;
                  onUpdateMaskThumbnailRef.current?.(targetLayerId);
                  if (multiplayerService.isConnected()) {
                    multiplayerService.sendLayerMaskData(
                      targetLayerId,
                      targetLayer.maskCanvas,
                      item.dirtyRect
                    );
                  }
                }
              } else if (item.vectorStrokesDelta && targetLayer) {
                targetLayer.vectorStrokes = item.vectorStrokesDelta.before;
                const isMono = targetLayer.expressionColor === 'monochrome';
                grid.clearLayer(targetLayerId);
                if (targetLayer.vectorStrokes.length > 0) {
                  let minX = dims.width;
                  let minY = dims.height;
                  let maxX = 0;
                  let maxY = 0;
                  for (const st of targetLayer.vectorStrokes) {
                    if (st.deleted || !st.bounds) continue;
                    const pad = Math.ceil(Math.max(16, st.baseWidth || 10));
                    if (st.bounds.minX - pad < minX) minX = st.bounds.minX - pad;
                    if (st.bounds.minY - pad < minY) minY = st.bounds.minY - pad;
                    if (st.bounds.maxX + pad > maxX) maxX = st.bounds.maxX + pad;
                    if (st.bounds.maxY + pad > maxY) maxY = st.bounds.maxY + pad;
                  }
                  const vx = Math.max(0, Math.floor(minX));
                  const vy = Math.max(0, Math.floor(minY));
                  const vw = Math.max(0, Math.min(dims.width, Math.ceil(maxX)) - vx);
                  const vh = Math.max(0, Math.min(dims.height, Math.ceil(maxY)) - vy);
                  if (vw > 0 && vh > 0) {
                    const tempVec = document.createElement('canvas');
                    tempVec.width = vw;
                    tempVec.height = vh;
                    const cCtx = get2DContext(tempVec);
                    if (cCtx) {
                      cCtx.save();
                      cCtx.translate(-vx, -vy);
                      renderVectorLayer(cCtx, targetLayer.vectorStrokes);
                      cCtx.restore();
                      const subData = cCtx.getImageData(0, 0, vw, vh);
                      grid.writeImageData(
                        targetLayerId,
                        subData,
                        vx,
                        vy,
                        isMono ? 'monochrome-1bit' : 'color-32bit'
                      );
                    }
                    releaseTemporaryCanvas(tempVec);
                  }
                }
                if (multiplayerService.isConnected()) {
                  multiplayerService.sendLayerUpdate(targetLayerId, {
                    vectorStrokes: targetLayer.vectorStrokes,
                  });
                }
              } else if (deltas && deltas.length > 0) {
                grid.applyTileDeltas(deltas, 'undo');
                if (multiplayerService.isConnected()) {
                  multiplayerService.sendTileDeltas(deltas, grid, { force: true });
                }

                const affectedLayerIds = new Set<string>();
                for (const d of deltas) {
                  affectedLayerIds.add(parseTileKey(d.key).layerId);
                }
                for (const lid of affectedLayerIds) {
                  if (lid !== targetLayerId) {
                    onUpdateLayerThumbnail(lid, true);
                  }
                }
              } else {
                const isMono =
                  !isBackgroundLayerId(targetLayerId) &&
                  (targetLayer?.expressionColor === 'monochrome' ||
                    colorModeRef.current === 'monochrome');
                const targetFormat = isMono ? 'monochrome-1bit' : 'color-32bit';

                if (item.beforeImageData) {
                  const bx =
                    item.dirtyRect &&
                    item.beforeImageData.width === item.dirtyRect.width &&
                    item.beforeImageData.height === item.dirtyRect.height
                      ? item.dirtyRect.x
                      : 0;
                  const by =
                    item.dirtyRect &&
                    item.beforeImageData.width === item.dirtyRect.width &&
                    item.beforeImageData.height === item.dirtyRect.height
                      ? item.dirtyRect.y
                      : 0;
                  grid.writeImageData(targetLayerId, item.beforeImageData, bx, by, targetFormat);
                } else if (item.type === 'initial') {
                  if (isBackgroundLayerId(targetLayerId)) {
                    grid.fillLayerSolidWhite(
                      targetLayerId,
                      dims.width,
                      dims.height,
                      'color-32bit'
                    );
                  } else {
                    grid.clearLayer(targetLayerId);
                  }
                }
              }

              if (
                !item.layerTreeDelta ||
                (layersRef.current ?? []).some((l) => l.id === targetLayerId)
              ) {
                onUpdateLayerThumbnail(targetLayerId, true);
              }
            }
          }
        } else {
          for (let i = currentIndex + 1; i <= targetIndex; i++) {
            const item = historyRef.current[i];
            const dataToApply = item?.afterImageData || item?.imageData;
            if (item) {
              const targetLayerId = item.layerId || activeLayerId;
              const targetLayer = layersRef.current?.find((l) => l.id === targetLayerId);
              const deltas = await undoCache.resolveDeltas(item);

              if (item.layerTreeDelta) {
                const applied = onApplyLayerTreeDeltaRef?.current?.(item.layerTreeDelta, 'redo');
                if (applied) {
                  layersRef.current = applied.nextLayers;
                  if (applied.nextActiveLayerId !== null) {
                    activeLayerIdRef.current = applied.nextActiveLayerId;
                  }
                }
                if (deltas && deltas.length > 0) {
                  grid.applyTileDeltas(deltas, 'redo');
                  if (multiplayerService.isConnected()) {
                    multiplayerService.sendTileDeltas(deltas, grid, { force: true });
                  }
                }
                const liveLayerIds = new Set((layersRef.current ?? []).map((l) => l.id));
                const affectedLayerIds = new Set<string>();
                if (deltas) {
                  for (const d of deltas) {
                    affectedLayerIds.add(parseTileKey(d.key).layerId);
                  }
                }
                if (applied) {
                  for (const added of applied.addedLayers) {
                    affectedLayerIds.add(added.id);
                  }
                }
                for (const lid of affectedLayerIds) {
                  if (lid !== targetLayerId && liveLayerIds.has(lid)) {
                    onUpdateLayerThumbnail(lid, true);
                  }
                }
                grid.notifyChange(true);
              } else if (item.isMaskEdit && targetLayer?.maskCanvas) {
                const mCtx = get2DContext(targetLayer.maskCanvas);
                if (mCtx && dataToApply) {
                  const mx =
                    item.dirtyRect && dataToApply.width === item.dirtyRect.width
                      ? item.dirtyRect.x
                      : 0;
                  const my =
                    item.dirtyRect && dataToApply.height === item.dirtyRect.height
                      ? item.dirtyRect.y
                      : 0;
                  mCtx.putImageData(dataToApply, mx, my);
                  targetLayer.maskVersion = (targetLayer.maskVersion || 0) + 1;
                  onUpdateMaskThumbnailRef.current?.(targetLayerId);
                  if (multiplayerService.isConnected()) {
                    multiplayerService.sendLayerMaskData(
                      targetLayerId,
                      targetLayer.maskCanvas,
                      item.dirtyRect
                    );
                  }
                }
              } else if (item.vectorStrokesDelta && targetLayer) {
                targetLayer.vectorStrokes = item.vectorStrokesDelta.after;
                const isMono = targetLayer.expressionColor === 'monochrome';
                grid.clearLayer(targetLayerId);
                if (targetLayer.vectorStrokes.length > 0) {
                  let minX = dims.width;
                  let minY = dims.height;
                  let maxX = 0;
                  let maxY = 0;
                  for (const st of targetLayer.vectorStrokes) {
                    if (st.deleted || !st.bounds) continue;
                    const pad = Math.ceil(Math.max(16, st.baseWidth || 10));
                    if (st.bounds.minX - pad < minX) minX = st.bounds.minX - pad;
                    if (st.bounds.minY - pad < minY) minY = st.bounds.minY - pad;
                    if (st.bounds.maxX + pad > maxX) maxX = st.bounds.maxX + pad;
                    if (st.bounds.maxY + pad > maxY) maxY = st.bounds.maxY + pad;
                  }
                  const vx = Math.max(0, Math.floor(minX));
                  const vy = Math.max(0, Math.floor(minY));
                  const vw = Math.max(0, Math.min(dims.width, Math.ceil(maxX)) - vx);
                  const vh = Math.max(0, Math.min(dims.height, Math.ceil(maxY)) - vy);
                  if (vw > 0 && vh > 0) {
                    const tempVec = document.createElement('canvas');
                    tempVec.width = vw;
                    tempVec.height = vh;
                    const cCtx = get2DContext(tempVec);
                    if (cCtx) {
                      cCtx.save();
                      cCtx.translate(-vx, -vy);
                      renderVectorLayer(cCtx, targetLayer.vectorStrokes);
                      cCtx.restore();
                      const subData = cCtx.getImageData(0, 0, vw, vh);
                      grid.writeImageData(
                        targetLayerId,
                        subData,
                        vx,
                        vy,
                        isMono ? 'monochrome-1bit' : 'color-32bit'
                      );
                    }
                    releaseTemporaryCanvas(tempVec);
                  }
                }
                if (multiplayerService.isConnected()) {
                  multiplayerService.sendLayerUpdate(targetLayerId, {
                    vectorStrokes: targetLayer.vectorStrokes,
                  });
                }
              } else if (deltas && deltas.length > 0) {
                grid.applyTileDeltas(deltas, 'redo');
                if (multiplayerService.isConnected()) {
                  multiplayerService.sendTileDeltas(deltas, grid, { force: true });
                }

                const affectedLayerIds = new Set<string>();
                for (const d of deltas) {
                  affectedLayerIds.add(parseTileKey(d.key).layerId);
                }
                for (const lid of affectedLayerIds) {
                  if (lid !== targetLayerId) {
                    onUpdateLayerThumbnail(lid, true);
                  }
                }
              } else {
                const isMono =
                  !isBackgroundLayerId(targetLayerId) &&
                  (targetLayer?.expressionColor === 'monochrome' ||
                    colorModeRef.current === 'monochrome');
                const targetFormat = isMono ? 'monochrome-1bit' : 'color-32bit';

                if (dataToApply) {
                  const ax =
                    item.dirtyRect &&
                    dataToApply.width === item.dirtyRect.width &&
                    dataToApply.height === item.dirtyRect.height
                      ? item.dirtyRect.x
                      : 0;
                  const ay =
                    item.dirtyRect &&
                    dataToApply.width === item.dirtyRect.width &&
                    dataToApply.height === item.dirtyRect.height
                      ? item.dirtyRect.y
                      : 0;
                  grid.writeImageData(targetLayerId, dataToApply, ax, ay, targetFormat);
                } else if (item.type === 'initial') {
                  if (isBackgroundLayerId(targetLayerId)) {
                    grid.fillLayerSolidWhite(
                      targetLayerId,
                      dims.width,
                      dims.height,
                      'color-32bit'
                    );
                  } else {
                    grid.clearLayer(targetLayerId);
                  }
                }
              }

              if (
                !item.layerTreeDelta ||
                (layersRef.current ?? []).some((l) => l.id === targetLayerId)
              ) {
                onUpdateLayerThumbnail(targetLayerId, true);
              }
            }
          }
        }

        historyIndexRef.current = targetIndex;
        persistSessionHistory();
        syncHistoryState();
        grid.notifyChange(true);
      });
      historyQueueRef.current = nextOp.catch((err) => {
        console.warn('[History] Error during jumpToHistoryIndex:', err);
      });
      return historyQueueRef.current;
    },
    [
      abortActiveStrokeRef,
      activeLayerId,
      activeLayerIdRef,
      colorModeRef,
      dimensionsRef,
      flushPendingHistoryTasks,
      isDrawingRef,
      layersRef,
      onApplyLayerTreeDeltaRef,
      onUpdateLayerThumbnail,
      onUpdateMaskThumbnailRef,
      persistSessionHistory,
      syncHistoryState,
    ]
  );

  const undo = useCallback(() => {
    flushPendingHistoryTasks();
    if (isDrawingRef.current) {
      abortActiveStrokeRef.current();
    }
    if (historyIndexRef.current <= 0) return;
    jumpToHistoryIndex(historyIndexRef.current - 1);
  }, [abortActiveStrokeRef, flushPendingHistoryTasks, isDrawingRef, jumpToHistoryIndex]);

  const redo = useCallback(() => {
    flushPendingHistoryTasks();
    if (isDrawingRef.current) {
      abortActiveStrokeRef.current();
    }
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    jumpToHistoryIndex(historyIndexRef.current + 1);
  }, [abortActiveStrokeRef, flushPendingHistoryTasks, isDrawingRef, jumpToHistoryIndex]);

  const selectiveUndo = useCallback(
    (
      peerIdToUndo?: string | number,
      strokeIdToUndo?: string
    ): Promise<SelectiveUndoResult | null> => {
      flushPendingHistoryTasks();
      if (isDrawingRef.current) {
        abortActiveStrokeRef.current();
      }

      let result: SelectiveUndoResult | null = null;
      const nextOp = historyQueueRef.current.then(async () => {
        const history = historyRef.current;
        const currIdx = historyIndexRef.current;
        if (currIdx <= 0 || history.length <= 1) return;

        let targetItemIdx = -1;

        // 1. Exact strokeId match when provided (reliable collaborative selective undo)
        if (strokeIdToUndo) {
          for (let i = currIdx; i >= 1; i--) {
            const item = history[i];
            if (item.type !== 'initial' && item.strokeId === strokeIdToUndo) {
              targetItemIdx = i;
              break;
            }
          }
        }

        // 2. Fallback to most recent matching peerId (or local actions where item.peerId is unset)
        if (targetItemIdx === -1) {
          for (let i = currIdx; i >= 1; i--) {
            const item = history[i];
            if (item.type === 'initial') continue;
            if (
              !peerIdToUndo ||
              item.peerId === peerIdToUndo ||
              (peerIdToUndo === 'local' && (!item.peerId || item.peerId === 'local'))
            ) {
              targetItemIdx = i;
              break;
            }
          }
        }

        if (targetItemIdx === -1) return;

        const item = history[targetItemIdx];
        const targetLayerId = item.layerId || activeLayerId;
        const targetLayer = layersRef.current?.find((l) => l.id === targetLayerId);
        const grid = activeTileGridRef.current;
        const undoCache = activeUndoCacheRef.current;
        const dims = dimensionsRef.current;
        let resolvedDeltas: TileDelta[] | null = null;
        let syncedRemotely = false;
        const isLocalUndo = !peerIdToUndo || peerIdToUndo === 'local';

        if (item.layerTreeDelta) {
          resolvedDeltas = await undoCache.resolveDeltas(item);
          if (resolvedDeltas && resolvedDeltas.length > 0) {
            grid.applyTileDeltas(resolvedDeltas, 'undo');
          }
          const applied = onApplyLayerTreeDeltaRef?.current?.(item.layerTreeDelta, 'undo');
          if (applied) {
            layersRef.current = applied.nextLayers;
            if (applied.nextActiveLayerId !== null) {
              activeLayerIdRef.current = applied.nextActiveLayerId;
            }
          }
          if (isLocalUndo && multiplayerService.isConnected()) {
            syncedRemotely = true;
          }
        } else if (item.isMaskEdit && targetLayer?.maskCanvas) {
          const mCtx = get2DContext(targetLayer.maskCanvas);
          if (mCtx && item.beforeImageData) {
            const mx =
              item.dirtyRect && item.beforeImageData.width === item.dirtyRect.width
                ? item.dirtyRect.x
                : 0;
            const my =
              item.dirtyRect && item.beforeImageData.height === item.dirtyRect.height
                ? item.dirtyRect.y
                : 0;
            mCtx.putImageData(item.beforeImageData, mx, my);
            targetLayer.maskVersion = (targetLayer.maskVersion || 0) + 1;
            onUpdateMaskThumbnailRef.current?.(targetLayerId);
            if (isLocalUndo && multiplayerService.isConnected()) {
              multiplayerService.sendLayerMaskData(
                targetLayerId,
                targetLayer.maskCanvas,
                item.dirtyRect
              );
              syncedRemotely = true;
            }
          }
        } else if (item.vectorStrokesDelta && targetLayer) {
          targetLayer.vectorStrokes = item.vectorStrokesDelta.before;
          const isMono = targetLayer.expressionColor === 'monochrome';
          grid.clearLayer(targetLayerId);
          if (targetLayer.vectorStrokes.length > 0) {
            let minX = dims.width;
            let minY = dims.height;
            let maxX = 0;
            let maxY = 0;
            for (const st of targetLayer.vectorStrokes) {
              if (st.deleted || !st.bounds) continue;
              const pad = Math.ceil(Math.max(16, st.baseWidth || 10));
              if (st.bounds.minX - pad < minX) minX = st.bounds.minX - pad;
              if (st.bounds.minY - pad < minY) minY = st.bounds.minY - pad;
              if (st.bounds.maxX + pad > maxX) maxX = st.bounds.maxX + pad;
              if (st.bounds.maxY + pad > maxY) maxY = st.bounds.maxY + pad;
            }
            const vx = Math.max(0, Math.floor(minX));
            const vy = Math.max(0, Math.floor(minY));
            const vw = Math.max(0, Math.min(dims.width, Math.ceil(maxX)) - vx);
            const vh = Math.max(0, Math.min(dims.height, Math.ceil(maxY)) - vy);
            if (vw > 0 && vh > 0) {
              const tempVec = document.createElement('canvas');
              tempVec.width = vw;
              tempVec.height = vh;
              const cCtx = get2DContext(tempVec);
              if (cCtx) {
                cCtx.save();
                cCtx.translate(-vx, -vy);
                renderVectorLayer(cCtx, targetLayer.vectorStrokes);
                cCtx.restore();
                const subData = cCtx.getImageData(0, 0, vw, vh);
                grid.writeImageData(
                  targetLayerId,
                  subData,
                  vx,
                  vy,
                  isMono ? 'monochrome-1bit' : 'color-32bit'
                );
              }
              releaseTemporaryCanvas(tempVec);
            }
          }
          if (isLocalUndo && multiplayerService.isConnected()) {
            multiplayerService.sendLayerUpdate(targetLayerId, {
              vectorStrokes: targetLayer.vectorStrokes,
            });
            syncedRemotely = true;
          }
        } else {
          resolvedDeltas = await undoCache.resolveDeltas(item);
          if (resolvedDeltas && resolvedDeltas.length > 0) {
            grid.applyTileDeltas(resolvedDeltas, 'undo');
          } else if (item.beforeImageData) {
            const isMono =
              !isBackgroundLayerId(targetLayerId) &&
              (targetLayer?.expressionColor === 'monochrome' ||
                colorModeRef.current === 'monochrome');
            const bx =
              item.dirtyRect &&
              item.beforeImageData.width === item.dirtyRect.width &&
              item.beforeImageData.height === item.dirtyRect.height
                ? item.dirtyRect.x
                : 0;
            const by =
              item.dirtyRect &&
              item.beforeImageData.width === item.dirtyRect.width &&
              item.beforeImageData.height === item.dirtyRect.height
                ? item.dirtyRect.y
                : 0;
            grid.writeImageData(
              targetLayerId,
              item.beforeImageData,
              bx,
              by,
              isMono ? 'monochrome-1bit' : 'color-32bit'
            );
          }
        }

        historyRef.current.splice(targetItemIdx, 1);
        historyIndexRef.current = Math.max(
          0,
          Math.min(historyIndexRef.current - 1, historyRef.current.length - 1)
        );
        persistSessionHistory();
        syncHistoryState();

        onUpdateLayerThumbnail(targetLayerId);
        grid.notifyChange(true);

        result = {
          strokeId: item.strokeId,
          layerId: targetLayerId,
          tileDeltas: resolvedDeltas ?? undefined,
          syncedRemotely,
        };
      });

      historyQueueRef.current = nextOp.catch((err) => {
        console.warn('[History] Error during selectiveUndo:', err);
      });
      return historyQueueRef.current.then(() => result);
    },
    [
      abortActiveStrokeRef,
      activeLayerId,
      activeLayerIdRef,
      colorModeRef,
      dimensionsRef,
      flushPendingHistoryTasks,
      isDrawingRef,
      layersRef,
      onApplyLayerTreeDeltaRef,
      onUpdateLayerThumbnail,
      onUpdateMaskThumbnailRef,
      persistSessionHistory,
      syncHistoryState,
    ]
  );

  const clearCanvas = useCallback(() => {
    if (!activeLayerId || activeLayerLocked) return;
    const dims = dimensionsRef.current;
    if (dims.width <= 0 || dims.height <= 0) return;

    const grid = activeTileGridRef.current;
    const activeLayer = layersRef.current?.find((l) => l.id === activeLayerId);
    const isBg = isBackgroundLayerId(activeLayerId);
    const fullRect = { x: 0, y: 0, width: dims.width, height: dims.height };

    const beforeSnapshot = isBg
      ? grid.snapshotTilesInRect(activeLayerId, fullRect)
      : grid.snapshotLayerTiles(activeLayerId);

    let vectorDelta: { before: VectorStroke[]; after: VectorStroke[] } | undefined;
    if (activeLayer?.type === 'vector') {
      const beforeStrokes = [...(activeLayer.vectorStrokes || [])];
      activeLayer.vectorStrokes = [];
      vectorDelta = { before: beforeStrokes, after: [] };
      if (multiplayerService.isConnected()) {
        multiplayerService.sendLayerUpdate(activeLayerId, { vectorStrokes: [] });
      }
    }

    if (isBg) {
      grid.fillLayerSolidWhite(activeLayerId, dims.width, dims.height, 'color-32bit');
    } else {
      grid.clearLayer(activeLayerId);
      grid.markLayerIngested(activeLayerId);
    }

    const tileDeltas = grid.computeDeltasFromSnapshot(
      beforeSnapshot,
      activeLayerId,
      isBg ? fullRect : undefined
    );

    onUpdateLayerThumbnail(activeLayerId);
    pushHistoryStep(
      'clear',
      'Clear Layer',
      null,
      null,
      activeLayerId,
      fullRect,
      tileDeltas,
      vectorDelta
    );
    grid.notifyChange(true);
  }, [
    activeLayerId,
    activeLayerLocked,
    dimensionsRef,
    layersRef,
    onUpdateLayerThumbnail,
    pushHistoryStep,
  ]);

  const resetHistory = useCallback(
    (targetDocumentId?: string) => {
      flushPendingHistoryTasks();
      const docId = targetDocumentId ?? activeSessionIdRef.current;
      const sess = docId ? documentStore.getSession(docId) : null;
      const targetCache = sess ? sess.undoCache : activeUndoCacheRef.current;
      const targetGrid = sess ? sess.tileGrid : activeTileGridRef.current;

      if (sess) {
        sess.history = [];
        sess.historyIndex = -1;
      }

      if (!targetDocumentId || targetDocumentId === activeSessionIdRef.current) {
        historyRef.current = [];
        historyIndexRef.current = -1;
        lastStrokeEndRef.current = null;
        setHistoryList([]);
        setHistoryIndex(-1);
        setCanUndo(false);
        setCanRedo(false);
      }

      targetCache.clearCache().catch(() => {});

      const now = Date.now();
      const dims = dimensionsRef.current;
      const layerId = activeLayerIdRef.current || activeLayerId;
      if (layerId && dims.width > 0 && dims.height > 0) {
        const thumbnail = createCanvasThumbnail(
          { grid: targetGrid, layerId, dimensions: dims },
          !isBackgroundLayerId(layerId)
        );
        const initialItem: HistoryItem = {
          id: `hist-init-${now}`,
          type: 'initial',
          label: 'New Document',
          timestamp: now,
          timeFormatted: formatTime(now),
          thumbnailUrl: thumbnail,
          imageData: undefined,
          beforeImageData: null,
          afterImageData: null,
          layerId,
        };
        if (sess) {
          sess.history = [initialItem];
          sess.historyIndex = 0;
        }
        if (!targetDocumentId || targetDocumentId === activeSessionIdRef.current) {
          historyRef.current = [initialItem];
          historyIndexRef.current = 0;
          syncHistoryState();
        }
      }
    },
    [
      activeLayerId,
      activeLayerIdRef,
      dimensionsRef,
      flushPendingHistoryTasks,
      lastStrokeEndRef,
      syncHistoryState,
    ]
  );

  // Swap per-document history & UndoCacheManager on activeSessionId change
  useEffect(() => {
    const prevDocId = activeSessionIdRef.current;
    const nextDocId = activeSessionId ?? null;
    if (prevDocId === nextDocId) return;

    flushPendingHistoryTasks();
    if (isDrawingRef.current) {
      abortActiveStrokeRef.current();
    }
    if (prevDocId) {
      persistSessionHistory(prevDocId);
    }

    activeSessionIdRef.current = nextDocId;
    lastStrokeEndRef.current = null;

    if (nextDocId) {
      const sess = documentStore.getOrCreateSession(nextDocId);
      activeTileGridRef.current = tileGrid ?? sess.tileGrid;
      activeUndoCacheRef.current = sess.undoCache;
      historyRef.current = sess.history;
      historyIndexRef.current = sess.historyIndex;
    } else {
      activeTileGridRef.current = tileGrid ?? globalTileGrid;
      activeUndoCacheRef.current = globalUndoCache;
      historyRef.current = [];
      historyIndexRef.current = -1;
    }

    syncHistoryState();
  }, [
    abortActiveStrokeRef,
    activeSessionId,
    flushPendingHistoryTasks,
    isDrawingRef,
    lastStrokeEndRef,
    persistSessionHistory,
    syncHistoryState,
    tileGrid,
  ]);

  useEffect(() => {
    if (historyRef.current.length > 0) return;
    if (!activeLayerId || dimensions.width <= 0 || dimensions.height <= 0) return;
    ensureInitialHistory();
  }, [activeLayerId, activeSessionId, dimensions.width, dimensions.height, ensureInitialHistory]);

  return {
    activeSessionIdRef,
    activeTileGridRef,
    activeUndoCacheRef,
    historyList,
    historyIndex,
    canUndo,
    canRedo,
    pushHistoryStep,
    flushPendingHistoryTasks,
    enqueueHistoryTask,
    jumpToHistoryIndex,
    undo,
    redo,
    selectiveUndo,
    clearCanvas,
    resetHistory,
  };
}
