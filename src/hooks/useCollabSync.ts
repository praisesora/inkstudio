import React, { useRef, useEffect, useCallback } from 'react';
import {
  AnimationTimeline,
  CanvasColorMode,
  CanvasDimensions,
  DocumentTab,
  LayerItem,
  hasTileBackedLayer,
} from '../types/editor';
import {
  CollabPeer,
  LayerActionMessage,
  LayerClearableField,
  LayerMaskDataMessage,
  LayerTreeSyncMessage,
  LayerUpdateMessage,
  MultiplayerMessage,
  StrokeChunkMessage,
  StrokeFinishMessage,
  StrokeStartMessage,
  WireLayerItem,
} from '../types/multiplayer';
import { PerspectiveRuler, StraightRuler } from '../types/perspective';
import { ResizeCanvasOptions } from '../types/settings';
import { useMultiplayer } from './useMultiplayer';
import { getNextCollabLayerName } from './useLayerManager';
import { multiplayerService } from '../services/multiplayerService';
import { get2DContext } from '../utils/canvasUtils';
import {
  deepEqualWireValue,
  diffWireLayerTrees,
  serializeLayerForWire,
} from '../utils/collabSyncUtils';
import {
  canDeleteLayer,
  canEditLayer,
  canMutateCanvas,
  canToggleLayerOwnerLock,
  filterDeletableLayerIds,
  peerIdEquals,
} from '../utils/collabPermissions';
import { RemoteStrokeSession } from '../engine/RemoteStrokeRenderer';
import { renderVectorStroke } from '../utils/vectorEngine';
import { documentStore } from '../utils/documentStore';
import { TileFormat, releaseTemporaryCanvas } from '../utils/tileEngine';
import { documentStoreActions, uiStoreActions, useDocumentStore } from '../stores';
import { PushHistoryStepFn } from './drawing/types';

function normalizeAnimForSync(
  tl: AnimationTimeline | null,
  prevSynced: AnimationTimeline | null
): AnimationTimeline | null {
  if (!tl) return null;
  // Suppress per-tick currentFrame broadcasts during local playback preview
  const effectiveFrame =
    tl.isPlaying && prevSynced ? prevSynced.currentFrame : tl.currentFrame;
  return {
    ...tl,
    currentFrame: effectiveFrame,
    isPlaying: false,
  };
}

export interface UseCollabSyncParams {
  hasOpenDocument: boolean;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  activeLayerId: string;
  selectedLayerIds: string[];
  perspectiveRuler?: PerspectiveRuler | null;
  straightRuler?: StraightRuler | null;
  animationTimeline?: AnimationTimeline | null;
  pushHistoryStepRef: React.MutableRefObject<PushHistoryStepFn | null>;
  selectiveUndoRef: React.MutableRefObject<
    (peerId?: string | number, strokeId?: string) => unknown
  >;
  resetZoomAndCenter: (dims?: CanvasDimensions) => void;
  resetHistory?: (targetDocumentId?: string) => void;
  setLayers: React.Dispatch<React.SetStateAction<LayerItem[]>>;
  setActiveLayerId: (id: string) => void;
  toggleLock: (id: string) => void;
  addLayer: (
    type?: 'raster' | 'folder' | 'vector',
    parentId?: string | null,
    customName?: string,
    customId?: string,
    selectNew?: boolean
  ) => LayerItem;
  addRemoteLayer: (
    layerItem: LayerItem | WireLayerItem,
    insertIndex?: number,
    onCommitted?: (nextLayers: LayerItem[]) => void
  ) => void;
  deleteLayer: (id: string) => void;
  deleteRemoteLayer: (id: string, onCommitted?: (nextLayers: LayerItem[]) => void) => void;
  applyRemoteLayerUpdate: (
    layerId: string,
    patch: Partial<WireLayerItem>,
    clearedFields?: LayerClearableField[],
    onCommitted?: (nextLayers: LayerItem[]) => void
  ) => void;
  applyRemoteLayerTree: (
    wireLayers: WireLayerItem[],
    removedLayerIds?: string[],
    onCommitted?: (nextLayers: LayerItem[]) => void
  ) => void;
  applyRemoteMaskData: (
    msg: LayerMaskDataMessage,
    onCommitted?: (nextLayers: LayerItem[]) => void
  ) => void;
  deleteSelectedLayers: () => void;
  groupSelectedLayers: () => void;
  syncRemoteDocument: (
    layers: Array<LayerItem | WireLayerItem>,
    assignedLayerId?: string,
    targetDocumentId?: string,
    syncDims?: CanvasDimensions,
    onCommitted?: (nextLayers: LayerItem[]) => void
  ) => void;
  resizeCanvas?: (newDims: CanvasDimensions, options: ResizeCanvasOptions) => void;
  renameLayer: (id: string, newName: string) => void;
  toggleVisibility: (id: string) => void;
  setOpacity: (id: string, opacity: number) => void;
  clearActiveLayer: () => void;
  updateLayerThumbnail: (layerId: string, immediate?: boolean) => void;
  showToast: (msg: string) => void;
}

export function useCollabSync({
  hasOpenDocument,
  dimensions,
  colorMode,
  layers,
  activeLayerId,
  selectedLayerIds,
  perspectiveRuler = null,
  straightRuler = null,
  animationTimeline = null,
  pushHistoryStepRef,
  selectiveUndoRef,
  resetZoomAndCenter,
  resetHistory,
  setLayers,
  setActiveLayerId,
  toggleLock,
  addLayer,
  addRemoteLayer,
  deleteLayer,
  deleteRemoteLayer,
  applyRemoteLayerUpdate,
  applyRemoteLayerTree,
  applyRemoteMaskData,
  deleteSelectedLayers,
  groupSelectedLayers,
  syncRemoteDocument,
  resizeCanvas,
  renameLayer,
  toggleVisibility,
  setOpacity,
  clearActiveLayer,
  updateLayerThumbnail,
  showToast,
}: UseCollabSyncParams) {
  const remoteDraftCanvasesRef = useRef<Map<string | number, HTMLCanvasElement>>(new Map());
  const pendingAssignedLayerIdRef = useRef<string | undefined>(undefined);
  const remoteStrokeSessionsRef = useRef<Map<string, RemoteStrokeSession>>(new Map());

  const dimensionsRef = useRef(dimensions);
  dimensionsRef.current = dimensions;

  const layersRef = useRef(layers);
  layersRef.current = layers;

  // Canonical last-synced snapshots to compute minimal diffs and prevent echo loops
  const lastSyncedWireLayersRef = useRef<WireLayerItem[]>([]);
  const wasConnectedRef = useRef(false);
  const lastSyncedPerspectiveRef = useRef<PerspectiveRuler | null>(perspectiveRuler);
  const lastSyncedStraightRef = useRef<StraightRuler | null>(straightRuler);
  const lastSyncedAnimationRef = useRef<AnimationTimeline | null>(
    normalizeAnimForSync(animationTimeline, null)
  );

  const markRemoteLayersSynced = useCallback((committedLayers: LayerItem[]) => {
    lastSyncedWireLayersRef.current = committedLayers.map(serializeLayerForWire);
  }, []);

  // Dispose any active remote preview sessions on unmount
  useEffect(() => {
    return () => {
      for (const session of remoteStrokeSessionsRef.current.values()) {
        session.dispose(remoteDraftCanvasesRef.current.get(session.peerId));
      }
      remoteStrokeSessionsRef.current.clear();
    };
  }, []);

  const disposePeerSessions = useCallback((peerId: string | number) => {
    const peerKey = String(peerId);
    for (const [strokeId, session] of remoteStrokeSessionsRef.current.entries()) {
      if (String(session.peerId) === peerKey) {
        session.dispose(remoteDraftCanvasesRef.current.get(session.peerId));
        remoteStrokeSessionsRef.current.delete(strokeId);
      }
    }
  }, []);

  const handleRemoteStrokeStart = useCallback(
    (msg: StrokeStartMessage) => {
      // Clean up any stale unfinished live preview from the same peer
      disposePeerSessions(msg.peerId);

      const targetLayer = layersRef.current.find((l) => l.id === msg.layerId);
      const session = new RemoteStrokeSession({
        strokeId: msg.strokeId,
        peerId: msg.peerId,
        layerId: msg.layerId,
        tool: msg.tool,
        brushSettings: msg.brushSettings,
        brushAssetRefs: msg.brushAssetRefs,
        startPoint: msg.startPoint,
        colorMode,
        targetLayer,
        onRequestAsset: (hash) => {
          multiplayerService.sendBrushAssetRequest(hash, msg.peerId);
        },
      });

      remoteStrokeSessionsRef.current.set(msg.strokeId, session);
      const draftCanvas = remoteDraftCanvasesRef.current.get(msg.peerId);
      session.start(draftCanvas, () => remoteDraftCanvasesRef.current.get(msg.peerId));
    },
    [colorMode, disposePeerSessions]
  );

  const handleRemoteStrokeChunk = useCallback((msg: StrokeChunkMessage) => {
    const session = remoteStrokeSessionsRef.current.get(msg.strokeId);
    if (!session) return;

    const draftCanvas = remoteDraftCanvasesRef.current.get(msg.peerId);
    session.appendChunk(msg.points, draftCanvas);
  }, []);

  const handleRemoteStrokeFinish = useCallback(
    (msg: StrokeFinishMessage) => {
      const session = remoteStrokeSessionsRef.current.get(msg.strokeId);
      const draftCanvas = remoteDraftCanvasesRef.current.get(msg.peerId);

      // Vector strokes still commit vector geometry; raster strokes commit strictly via LZ4 BINARY_TILE
      if (msg.vectorStroke) {
        let targetLayer = layersRef.current.find((l) => l.id === msg.layerId);
        if (!targetLayer) {
          targetLayer = layersRef.current.find(
            (l) => l.type === 'vector' && l.id.includes(String(msg.peerId))
          );
        }
        const dims = dimensionsRef.current;
        if (targetLayer && targetLayer.type === 'vector' && dims.width > 0 && dims.height > 0) {
          const targetLayerId = targetLayer.id;
          const activeGrid = documentStore.getActiveTileGrid();
          const isMono =
            !targetLayerId.startsWith('layer-bg') &&
            (colorMode === 'monochrome' || targetLayer.expressionColor === 'monochrome');
          const targetFormat: TileFormat = isMono ? 'monochrome-1bit' : 'color-32bit';

          const beforeStrokes = [...(targetLayer.vectorStrokes || [])];
          const afterStrokes = [...beforeStrokes, msg.vectorStroke];
          targetLayer.vectorStrokes = afterStrokes;
          // Keep wire snapshot aligned with in-place vector stroke append
          lastSyncedWireLayersRef.current = lastSyncedWireLayersRef.current.map((wl) =>
            wl.id === targetLayerId ? { ...wl, vectorStrokes: afterStrokes } : wl
          );

          const b = msg.vectorStroke.bounds;
          const vPad = Math.ceil(Math.max(16, msg.vectorStroke.baseWidth || 10));
          const vx = b ? Math.max(0, Math.floor(b.minX - vPad)) : 0;
          const vy = b ? Math.max(0, Math.floor(b.minY - vPad)) : 0;
          const vw = b
            ? Math.max(0, Math.min(dims.width, Math.ceil(b.maxX + vPad)) - vx)
            : dims.width;
          const vh = b
            ? Math.max(0, Math.min(dims.height, Math.ceil(b.maxY + vPad)) - vy)
            : dims.height;

          if (vw > 0 && vh > 0) {
            const tempVec = activeGrid.createRegionCanvas(targetLayerId, {
              x: vx,
              y: vy,
              width: vw,
              height: vh,
            });
            const vCtx = tempVec ? get2DContext(tempVec) : null;
            if (tempVec && vCtx) {
              vCtx.save();
              vCtx.translate(-vx, -vy);
              renderVectorStroke(vCtx, msg.vectorStroke);
              vCtx.restore();
              const subData = vCtx.getImageData(0, 0, vw, vh);
              activeGrid.writeImageData(targetLayerId, subData, vx, vy, targetFormat);
            }
            if (tempVec) releaseTemporaryCanvas(tempVec);
          }

          pushHistoryStepRef.current?.(
            'brush',
            'Remote Vector Stroke',
            null,
            null,
            targetLayerId,
            vw > 0 && vh > 0 ? { x: vx, y: vy, width: vw, height: vh } : undefined,
            undefined,
            { before: beforeStrokes, after: afterStrokes },
            msg.peerId,
            msg.strokeId
          );
          activeGrid.notifyChange(true);
          updateLayerThumbnail(targetLayerId, true);
        }
      }

      if (session) {
        session.dispose(draftCanvas);
        remoteStrokeSessionsRef.current.delete(msg.strokeId);
      } else if (draftCanvas) {
        const ctx = get2DContext(draftCanvas);
        if (ctx) {
          ctx.resetTransform();
          ctx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
        }
        draftCanvas.style.opacity = '';
      }
    },
    [colorMode, pushHistoryStepRef, updateLayerThumbnail]
  );

  const handleRemoteDocSync = useCallback(
    (
      syncDims: CanvasDimensions,
      syncMode: CanvasColorMode,
      syncLayers: WireLayerItem[],
      assignedLayerId?: string,
      roomName?: string,
      syncPerspectiveRuler: PerspectiveRuler | null = null,
      syncStraightRuler: StraightRuler | null = null,
      syncAnimationTimeline: AnimationTimeline | null = null,
      isReconnect: boolean = false
    ) => {
      const existingActiveDocId = useDocumentStore.getState().activeDocumentId;
      const newDocId =
        isReconnect && existingActiveDocId && existingActiveDocId.startsWith('doc-collab-')
          ? existingActiveDocId
          : `doc-collab-${Date.now()}`;
      const effectiveAssignedId = assignedLayerId || pendingAssignedLayerIdRef.current;
      pendingAssignedLayerIdRef.current = undefined;

      const resolvedActiveLayerId =
        isReconnect && activeLayerId && syncLayers.some((l) => l.id === activeLayerId)
          ? activeLayerId
          : effectiveAssignedId && syncLayers.some((l) => l.id === effectiveAssignedId)
            ? effectiveAssignedId
            : syncLayers.find(
                (l) => l.type === 'raster' && l.id !== 'layer-bg' && !l.id.startsWith('layer-bg')
              )?.id ||
              syncLayers[0]?.id ||
              'layer-1';

      const tabName = (roomName || '').trim() || 'Collab Session';

      // Bind documentStore session BEFORE LZ4 BINARY_TILE / BINARY_MASK packets arrive
      syncRemoteDocument(
        syncLayers,
        resolvedActiveLayerId,
        newDocId,
        syncDims,
        markRemoteLayersSynced
      );

      // Prime document-state refs before updating store so subscribers do not echo back
      const normalizedAnim = normalizeAnimForSync(syncAnimationTimeline, null);
      lastSyncedPerspectiveRef.current = syncPerspectiveRuler;
      lastSyncedStraightRef.current = syncStraightRuler;
      lastSyncedAnimationRef.current = normalizedAnim;

      documentStoreActions.setDimensions(syncDims);
      documentStoreActions.setColorMode(syncMode);
      const newDoc: DocumentTab = {
        id: newDocId,
        name: tabName,
        dimensions: syncDims,
        colorMode: syncMode,
        layers: layersRef.current,
        activeLayerId: resolvedActiveLayerId,
        perspectiveRuler: syncPerspectiveRuler,
        straightRuler: syncStraightRuler,
        animation: normalizedAnim,
      };
      documentStoreActions.setDocuments([newDoc]);
      documentStoreActions.setActiveDocumentId(newDocId);
      documentStoreActions.setDocumentName(tabName);
      documentStoreActions.setPerspectiveRuler(syncPerspectiveRuler);
      documentStoreActions.setStraightRuler(syncStraightRuler);
      documentStoreActions.setAnimationTimeline(normalizedAnim);
      uiStoreActions.setAppView('workspace');

      if (!isReconnect) {
        requestAnimationFrame(() => {
          resetZoomAndCenter(syncDims);
        });
      }
    },
    [activeLayerId, markRemoteLayersSynced, resetZoomAndCenter, syncRemoteDocument]
  );

  const handleRemoteAssignedLayer = useCallback(
    (layerId: string) => {
      pendingAssignedLayerIdRef.current = layerId;
      setActiveLayerId(layerId);
    },
    [setActiveLayerId]
  );

  const handleRemoteJoinRequest = useCallback(
    (peer: CollabPeer) => {
      const layerName = getNextCollabLayerName(peer.name, layersRef.current);
      const layerId = `layer-${peer.id}-1`;
      const newLayer = addLayer('raster', null, layerName, layerId, false);
      const ownedLayer: LayerItem = {
        ...newLayer,
        ownerPeerId: peer.id,
        ownerPeerName: peer.name,
      };
      setLayers((prev) => {
        const next = prev.map((l) =>
          l.id === ownedLayer.id
            ? { ...l, ownerPeerId: peer.id, ownerPeerName: peer.name }
            : l
        );
        layersRef.current = next;
        return next;
      });
      const updated = layersRef.current.some((l) => l.id === ownedLayer.id)
        ? layersRef.current.map((l) =>
            l.id === ownedLayer.id ? { ...l, ownerPeerId: peer.id, ownerPeerName: peer.name } : l
          )
        : [ownedLayer, ...layersRef.current];
      const insertIndex = updated.findIndex((l) => l.id === ownedLayer.id);
      lastSyncedWireLayersRef.current = updated.map(serializeLayerForWire);
      multiplayerService.sendLayerAdd(ownedLayer, insertIndex >= 0 ? insertIndex : 0);
      return {
        assignedLayerId: layerId,
        updatedLayers: updated,
      };
    },
    [addLayer, setLayers]
  );

  const handleRemoteLayerAction = useCallback(
    (msg: MultiplayerMessage) => {
      if (msg.type === 'LAYER_TREE_SYNC') {
        const treeMsg = msg as LayerTreeSyncMessage;
        applyRemoteLayerTree(treeMsg.layers, treeMsg.removedLayerIds, markRemoteLayersSynced);
        return;
      }

      if (msg.type === 'LAYER_UPDATE') {
        const updMsg = msg as LayerUpdateMessage;
        applyRemoteLayerUpdate(
          updMsg.layerId,
          updMsg.patch,
          updMsg.clearedFields,
          markRemoteLayersSynced
        );
        return;
      }

      const action = msg as LayerActionMessage;
      if (action.type === 'LAYER_ADD') {
        if (action.layerItem) {
          addRemoteLayer(action.layerItem, action.insertIndex, markRemoteLayersSynced);
        }
      } else if (action.type === 'LAYER_DELETE') {
        if (action.layerId) {
          deleteRemoteLayer(action.layerId, markRemoteLayersSynced);
        }
      } else if (action.type === 'LAYER_CLEAR' && action.layerId) {
        const layerId = action.layerId;
        const activeGrid = documentStore.getActiveTileGrid();
        const dims = dimensionsRef.current;
        const target = layersRef.current.find((l) => l.id === layerId);
        if (target?.type === 'vector') {
          target.vectorStrokes = [];
          lastSyncedWireLayersRef.current = lastSyncedWireLayersRef.current.map((wl) =>
            wl.id === layerId ? { ...wl, vectorStrokes: [] } : wl
          );
        }
        const isBg = layerId === 'layer-bg' || layerId.startsWith('layer-bg');
        if (isBg) {
          activeGrid.fillLayerSolidWhite(layerId, dims.width, dims.height, 'color-32bit');
        } else {
          activeGrid.clearLayer(layerId);
          activeGrid.markLayerIngested(layerId);
        }
        activeGrid.notifyChange(true);
        updateLayerThumbnail(layerId, true);
      } else if (action.type === 'LAYER_RENAME') {
        if (action.layerId && action.newName) {
          applyRemoteLayerUpdate(
            action.layerId,
            { name: action.newName },
            undefined,
            markRemoteLayersSynced
          );
        }
      } else if (action.type === 'LAYER_VISIBILITY') {
        if (action.layerId && action.visible !== undefined) {
          applyRemoteLayerUpdate(
            action.layerId,
            { visible: action.visible },
            undefined,
            markRemoteLayersSynced
          );
        }
      } else if (action.type === 'LAYER_OPACITY') {
        if (action.layerId && action.opacity !== undefined) {
          applyRemoteLayerUpdate(
            action.layerId,
            { opacity: action.opacity },
            undefined,
            markRemoteLayersSynced
          );
        }
      }
    },
    [
      addRemoteLayer,
      deleteRemoteLayer,
      applyRemoteLayerUpdate,
      applyRemoteLayerTree,
      markRemoteLayersSynced,
      updateLayerThumbnail,
    ]
  );

  const handleRemoteMaskData = useCallback(
    (msg: LayerMaskDataMessage) => {
      applyRemoteMaskData(msg, markRemoteLayersSynced);
    },
    [applyRemoteMaskData, markRemoteLayersSynced]
  );

  const handleRemotePerspectiveRuler = useCallback((ruler: PerspectiveRuler | null) => {
    lastSyncedPerspectiveRef.current = ruler;
    documentStoreActions.setPerspectiveRuler(ruler);
  }, []);

  const handleRemoteStraightRuler = useCallback((ruler: StraightRuler | null) => {
    lastSyncedStraightRef.current = ruler;
    documentStoreActions.setStraightRuler(ruler);
  }, []);

  const handleRemoteAnimationSync = useCallback((timeline: AnimationTimeline | null) => {
    const normalized = normalizeAnimForSync(timeline, null);
    lastSyncedAnimationRef.current = normalized;
    documentStoreActions.setAnimationTimeline(normalized);
    const activeDocId = useDocumentStore.getState().activeDocumentId;
    if (activeDocId) {
      documentStoreActions.setDocuments((docs) =>
        docs.map((d) => (d.id === activeDocId ? { ...d, animation: normalized } : d))
      );
    }
  }, []);

  const handleRemoteCanvasResize = useCallback(
    (newDims: CanvasDimensions, options: ResizeCanvasOptions) => {
      resizeCanvas?.(newDims, options);
      documentStoreActions.setDimensions(newDims);
      resetZoomAndCenter(newDims);
      resetHistory?.();
      lastSyncedWireLayersRef.current = layersRef.current.map(serializeLayerForWire);
      showToast(`Canvas resized remotely to ${newDims.width} × ${newDims.height} px`);
    },
    [resizeCanvas, resetZoomAndCenter, resetHistory, showToast]
  );

  const handleRemoteTileApplied = useCallback(
    (layerId: string) => {
      updateLayerThumbnail(layerId, false);
    },
    [updateLayerThumbnail]
  );

  const mp = useMultiplayer({
    dimensions,
    colorMode,
    layers,
    perspectiveRuler,
    straightRuler,
    animationTimeline,
    onRemoteStrokeStart: handleRemoteStrokeStart,
    onRemoteStrokeChunk: handleRemoteStrokeChunk,
    onRemoteStrokeFinish: handleRemoteStrokeFinish,
    onRemoteDocSync: handleRemoteDocSync,
    onRemoteJoinRequest: handleRemoteJoinRequest,
    onRemoteAssignedLayer: handleRemoteAssignedLayer,
    onRemoteLayerAction: handleRemoteLayerAction,
    onRemoteMaskData: handleRemoteMaskData,
    onRemotePerspectiveRuler: handleRemotePerspectiveRuler,
    onRemoteStraightRuler: handleRemoteStraightRuler,
    onRemoteAnimationSync: handleRemoteAnimationSync,
    onRemoteCanvasResize: handleRemoteCanvasResize,
    onRemoteSelectiveUndo: (strokeId, peerId) => {
      selectiveUndoRef.current(peerId, strokeId);
    },
    onRemoteTileApplied: handleRemoteTileApplied,
    onRemotePeerLeft: disposePeerSessions,
    showToast,
  });

  // Reactive full layer-tree & property diff broadcaster (catches every UI/menu/shortcut/auto-action mutation)
  useEffect(() => {
    if (!mp.isConnected) {
      wasConnectedRef.current = false;
      lastSyncedWireLayersRef.current = layers.map(serializeLayerForWire);
      return;
    }

    const nextWire = layers.map(serializeLayerForWire);
    if (!wasConnectedRef.current) {
      wasConnectedRef.current = true;
      lastSyncedWireLayersRef.current = nextWire;
      return;
    }

    if (!canMutateCanvas(mp.myRole)) {
      lastSyncedWireLayersRef.current = nextWire;
      return;
    }

    const diff = diffWireLayerTrees(lastSyncedWireLayersRef.current, nextWire);
    lastSyncedWireLayersRef.current = nextWire;
    if (diff.kind === 'none') return;

    const activeGrid = documentStore.getActiveTileGrid();

    if (diff.kind === 'single-update') {
      const patchKeys = Object.keys(diff.patch);
      if (diff.clearedFields.length === 0 && patchKeys.length === 1) {
        const onlyKey = patchKeys[0];
        if (onlyKey === 'name' && typeof diff.patch.name === 'string') {
          multiplayerService.sendLayerRename(diff.layerId, diff.patch.name);
        } else if (onlyKey === 'visible' && typeof diff.patch.visible === 'boolean') {
          multiplayerService.sendLayerVisibility(diff.layerId, diff.patch.visible);
        } else if (onlyKey === 'opacity' && typeof diff.patch.opacity === 'number') {
          multiplayerService.sendLayerOpacity(diff.layerId, diff.patch.opacity);
        } else {
          multiplayerService.sendLayerUpdate(diff.layerId, diff.patch);
        }
      } else {
        multiplayerService.sendLayerUpdate(diff.layerId, diff.patch, diff.clearedFields);
      }

      if (diff.maskCreated) {
        const target = layers.find((l) => l.id === diff.layerId);
        if (target?.maskCanvas) {
          multiplayerService.sendLayerMaskData(target.id, target.maskCanvas);
        }
      }
      if (diff.rasterized) {
        multiplayerService.streamLayerTiles(diff.layerId, activeGrid, { force: true });
      }
      return;
    }

    // Structural mutation: reorder, group, multi-delete, duplicate, merge, split frame folder, paste/import, batch toggle
    const dirtyTileLayerIds: string[] = [];
    for (const addedId of diff.addedLayerIds) {
      const addedLayer = layers.find((l) => l.id === addedId);
      if (
        addedLayer &&
        hasTileBackedLayer(addedLayer) &&
        addedLayer.type !== 'text' &&
        addedLayer.type !== 'balloon' &&
        activeGrid.hasLayerTiles(addedId)
      ) {
        dirtyTileLayerIds.push(addedId);
      }
    }

    multiplayerService.sendLayerTreeSync(nextWire, {
      dirtyTileLayerIds,
      removedLayerIds: diff.removedLayerIds,
    });

    for (const tileLayerId of dirtyTileLayerIds) {
      multiplayerService.streamLayerTiles(tileLayerId, activeGrid);
    }

    for (const maskLayerId of diff.maskCreatedIds) {
      const maskLayer = layers.find((l) => l.id === maskLayerId);
      if (maskLayer?.maskCanvas) {
        multiplayerService.sendLayerMaskData(maskLayer.id, maskLayer.maskCanvas);
      }
    }
  }, [layers, mp.isConnected, mp.myRole]);

  // Reactive document-level state broadcaster: Perspective Ruler, Straight Ruler, Animation Timeline
  useEffect(() => {
    const state = useDocumentStore.getState();
    lastSyncedPerspectiveRef.current = state.perspectiveRuler;
    lastSyncedStraightRef.current = state.straightRuler;
    lastSyncedAnimationRef.current = normalizeAnimForSync(state.animationTimeline, null);

    if (!mp.isConnected || !canMutateCanvas(mp.myRole)) return;

    return useDocumentStore.subscribe(() => {
      if (!multiplayerService.isConnected()) return;
      const nextState = useDocumentStore.getState();

      if (!deepEqualWireValue(nextState.perspectiveRuler, lastSyncedPerspectiveRef.current)) {
        lastSyncedPerspectiveRef.current = nextState.perspectiveRuler;
        multiplayerService.sendPerspectiveRulerSync(nextState.perspectiveRuler);
      }

      if (!deepEqualWireValue(nextState.straightRuler, lastSyncedStraightRef.current)) {
        lastSyncedStraightRef.current = nextState.straightRuler;
        multiplayerService.sendStraightRulerSync(nextState.straightRuler);
      }

      const normalizedAnim = normalizeAnimForSync(
        nextState.animationTimeline,
        lastSyncedAnimationRef.current
      );
      if (!deepEqualWireValue(normalizedAnim, lastSyncedAnimationRef.current)) {
        lastSyncedAnimationRef.current = normalizedAnim;
        multiplayerService.sendAnimationSync(normalizedAnim);
      }
    });
  }, [mp.isConnected, mp.myRole]);

  const isSessionActive = mp.isConnected || mp.isReconnecting;

  const canEditLayerById = useCallback(
    (layerId: string) => {
      if (!isSessionActive) return { allowed: true };
      const target = layersRef.current.find((l) => l.id === layerId);
      return canEditLayer(target, mp.myPeer.id, mp.myRole);
    },
    [isSessionActive, mp.myPeer.id, mp.myRole]
  );

  const canDeleteLayerById = useCallback(
    (layerId: string) => {
      if (!isSessionActive) return { allowed: true };
      return canDeleteLayer(layerId, layersRef.current, mp.myPeer.id, mp.myRole);
    },
    [isSessionActive, mp.myPeer.id, mp.myRole]
  );

  const canToggleOwnerLockById = useCallback(
    (layerId: string) => {
      if (!isSessionActive) return { allowed: true };
      const target = layersRef.current.find((l) => l.id === layerId);
      return canToggleLayerOwnerLock(target, mp.myPeer.id, mp.myRole);
    },
    [isSessionActive, mp.myPeer.id, mp.myRole]
  );

  const activeLayerObj = layers.find((l) => l.id === activeLayerId);
  const canEditActiveLayer = !isSessionActive
    ? true
    : canEditLayer(activeLayerObj, mp.myPeer.id, mp.myRole).allowed;

  const handleStartHosting = useCallback(
    async (
      roomName: string,
      port: number,
      hostNickname?: string,
      isGlobal?: boolean,
      onStatus?: (status: string) => void
    ) => {
      if (!hasOpenDocument) {
        showToast('Please create or open a canvas before hosting a session.');
        return false;
      }
      const finalHostName = (hostNickname || mp.myPeer.name || 'Artist').trim();
      const hostPeerId = mp.myPeer.id;

      // Stamp ownership on host's existing non-background layers to protect them from accidental guest deletion
      setLayers((prev) => {
        const next = prev.map((l) => {
          if (l.id === 'layer-bg' || l.id.startsWith('layer-bg')) return l;
          if (l.ownerPeerId !== undefined) return l;
          return { ...l, ownerPeerId: hostPeerId, ownerPeerName: finalHostName };
        });
        layersRef.current = next;
        return next;
      });

      const defaultLayer =
        layersRef.current.find((l) => l.id === activeLayerId) ||
        layersRef.current.find(
          (l) => l.type === 'raster' && l.id !== 'layer-bg' && !l.id.startsWith('layer-bg')
        );
      if (
        defaultLayer &&
        (defaultLayer.name === 'Layer 1' ||
          !defaultLayer.name.toLowerCase().startsWith(finalHostName.toLowerCase()))
      ) {
        const hostLayerName = getNextCollabLayerName(
          finalHostName,
          layersRef.current.filter((l) => l.id !== defaultLayer.id)
        );
        renameLayer(defaultLayer.id, hostLayerName);
      }
      return await mp.startHosting(roomName, port, finalHostName, isGlobal, onStatus);
    },
    [
      hasOpenDocument,
      showToast,
      mp.myPeer.id,
      mp.myPeer.name,
      activeLayerId,
      renameLayer,
      setLayers,
      mp.startHosting,
    ]
  );

  const handleAddLayer = useCallback(
    (type: 'raster' | 'folder' | 'vector' = 'raster') => {
      if (isSessionActive && !canMutateCanvas(mp.myRole)) {
        showToast('Viewers have read-only access');
        return;
      }
      const created =
        isSessionActive && type === 'raster'
          ? addLayer('raster', null, getNextCollabLayerName(mp.myPeer.name, layersRef.current))
          : addLayer(type);
      if (isSessionActive && created) {
        const ownerId = mp.myPeer.id;
        const ownerName = mp.myPeer.name;
        setLayers((prev) => {
          const next = prev.map((l) =>
            l.id === created.id ? { ...l, ownerPeerId: ownerId, ownerPeerName: ownerName } : l
          );
          layersRef.current = next;
          return next;
        });
      }
    },
    [isSessionActive, mp.myRole, mp.myPeer.id, mp.myPeer.name, addLayer, setLayers, showToast]
  );

  const handleDeleteLayer = useCallback(
    (id: string) => {
      if (isSessionActive) {
        const perm = canDeleteLayer(id, layersRef.current, mp.myPeer.id, mp.myRole);
        if (!perm.allowed) {
          showToast(perm.reason || 'You do not have permission to delete this layer');
          return;
        }
      }
      deleteLayer(id);
    },
    [isSessionActive, mp.myPeer.id, mp.myRole, deleteLayer, showToast]
  );

  const handleDeleteSelectedLayers = useCallback(() => {
    if (selectedLayerIds && selectedLayerIds.length > 1) {
      if (isSessionActive) {
        const { allowedIds, blockedReasons } = filterDeletableLayerIds(
          selectedLayerIds,
          layersRef.current,
          mp.myPeer.id,
          mp.myRole
        );
        if (allowedIds.length === 0) {
          showToast(blockedReasons[0] || 'Selected layers cannot be deleted');
          return;
        }
        if (blockedReasons.length > 0) {
          for (const allowedId of allowedIds) {
            deleteLayer(allowedId);
          }
          showToast(
            `Deleted ${allowedIds.length} layer(s); protected ${blockedReasons.length} other user layer(s)`
          );
          return;
        }
      }
      deleteSelectedLayers();
      showToast(`Deleted ${selectedLayerIds.length} layers`);
    } else {
      handleDeleteLayer(activeLayerId);
    }
  }, [
    selectedLayerIds,
    isSessionActive,
    mp.myPeer.id,
    mp.myRole,
    deleteLayer,
    deleteSelectedLayers,
    handleDeleteLayer,
    activeLayerId,
    showToast,
  ]);

  const handleGroupSelectedLayers = useCallback(() => {
    if (isSessionActive && !canMutateCanvas(mp.myRole)) {
      showToast('Viewers have read-only access');
      return;
    }
    groupSelectedLayers();
    showToast('Grouped layers into folder');
  }, [isSessionActive, mp.myRole, groupSelectedLayers, showToast]);

  const handleToggleVisibility = useCallback(
    (id: string) => {
      if (isSessionActive) {
        const perm = canEditLayerById(id);
        if (!perm.allowed) {
          showToast(perm.reason || 'Cannot modify this layer');
          return;
        }
      }
      toggleVisibility(id);
    },
    [isSessionActive, canEditLayerById, toggleVisibility, showToast]
  );

  const handleSetOpacity = useCallback(
    (id: string, opacity: number) => {
      if (isSessionActive) {
        const perm = canEditLayerById(id);
        if (!perm.allowed) {
          showToast(perm.reason || 'Cannot modify this layer');
          return;
        }
      }
      setOpacity(id, opacity);
    },
    [isSessionActive, canEditLayerById, setOpacity, showToast]
  );

  const handleRenameLayer = useCallback(
    (id: string, newName: string) => {
      if (isSessionActive) {
        const perm = canEditLayerById(id);
        if (!perm.allowed) {
          showToast(perm.reason || 'Cannot rename this layer');
          return;
        }
      }
      renameLayer(id, newName);
    },
    [isSessionActive, canEditLayerById, renameLayer, showToast]
  );

  const handleToggleLock = useCallback(
    (id: string) => {
      if (isSessionActive) {
        const perm = canEditLayerById(id);
        if (!perm.allowed) {
          showToast(perm.reason || 'Cannot modify lock on this layer');
          return;
        }
      }
      toggleLock(id);
    },
    [isSessionActive, canEditLayerById, toggleLock, showToast]
  );

  const handleToggleOwnerLock = useCallback(
    (id: string) => {
      const target = layersRef.current.find((l) => l.id === id);
      if (!target) return;
      if (isSessionActive) {
        const perm = canToggleLayerOwnerLock(target, mp.myPeer.id, mp.myRole);
        if (!perm.allowed) {
          showToast(perm.reason || 'Cannot toggle owner lock on this layer');
          return;
        }
      }

      const isCurrentlyReserved =
        target.reservedByPeerId !== undefined && target.reservedByPeerId !== '';
      if (isCurrentlyReserved) {
        setLayers((prev) =>
          prev.map((l) => {
            if (l.id !== id) return l;
            const { reservedByPeerId: _id, reservedByPeerName: _name, ...rest } = l;
            return rest;
          })
        );
        showToast(`Unlocked "${target.name}" for collaboration`);
      } else {
        const lockPeerId =
          mp.myRole === 'host' && target.ownerPeerId && !peerIdEquals(target.ownerPeerId, mp.myPeer.id)
            ? target.ownerPeerId
            : mp.myPeer.id;
        const lockPeerName =
          mp.myRole === 'host' && target.ownerPeerId && !peerIdEquals(target.ownerPeerId, mp.myPeer.id)
            ? target.ownerPeerName || 'Owner'
            : mp.myPeer.name;
        setLayers((prev) =>
          prev.map((l) =>
            l.id === id
              ? {
                  ...l,
                  ownerPeerId: l.ownerPeerId ?? lockPeerId,
                  ownerPeerName: l.ownerPeerName ?? lockPeerName,
                  reservedByPeerId: lockPeerId,
                  reservedByPeerName: lockPeerName,
                }
              : l
          )
        );
        showToast(`Locked "${target.name}" to ${lockPeerName}`);
      }
    },
    [isSessionActive, mp.myPeer.id, mp.myPeer.name, mp.myRole, setLayers, showToast]
  );

  const handleClearActiveLayer = useCallback(() => {
    if (isSessionActive) {
      const perm = canEditLayerById(activeLayerId);
      if (!perm.allowed) {
        showToast(perm.reason || 'Cannot clear this layer');
        return;
      }
    }
    const active = layersRef.current.find((l) => l.id === activeLayerId);
    if (active?.type === 'vector') {
      active.vectorStrokes = [];
    }
    clearActiveLayer();
    if (mp.isConnected) {
      multiplayerService.sendLayerClear(activeLayerId);
      if (activeLayerId === 'layer-bg' || activeLayerId.startsWith('layer-bg')) {
        multiplayerService.streamLayerTiles(activeLayerId, documentStore.getActiveTileGrid(), {
          force: true,
        });
      }
    }
  }, [isSessionActive, canEditLayerById, clearActiveLayer, mp.isConnected, activeLayerId, showToast]);

  return {
    ...mp,
    remoteDraftCanvasesRef,
    canEditActiveLayer,
    canEditLayerById,
    canDeleteLayerById,
    canToggleOwnerLockById,
    handleStartHosting,
    handleAddLayer,
    handleDeleteLayer,
    handleDeleteSelectedLayers,
    handleGroupSelectedLayers,
    handleToggleVisibility,
    handleSetOpacity,
    handleRenameLayer,
    handleToggleLock,
    handleToggleOwnerLock,
    handleClearActiveLayer,
  };
}
