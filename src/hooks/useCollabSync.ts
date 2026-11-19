import React, { useRef, useEffect, useCallback } from 'react';
import {
  BrushSettings,
  CanvasColorMode,
  CanvasDimensions,
  DocumentTab,
  LayerItem,
  Point,
  ToolType,
} from '../types/editor';
import {
  CollabPeer,
  MultiplayerMessage,
  StrokeChunkMessage,
  StrokeFinishMessage,
  StrokeStartMessage,
} from '../types/multiplayer';
import { useMultiplayer } from './useMultiplayer';
import { getNextCollabLayerName } from './useLayerManager';
import { multiplayerService } from '../services/multiplayerService';
import { enforceColorMode } from '../utils/colorUtils';
import {
  drawDot,
  drawSmoothBezierSegment,
  get2DContext,
  getMidPoint,
  getReusableBakeCanvas,
  renderCompleteStroke,
} from '../utils/canvasUtils';
import { drawPencilBezierSegment, drawPencilDot, PencilGrade } from '../utils/pencilEngine';
import { renderVectorStroke } from '../utils/vectorEngine';
import { documentStore } from '../utils/documentStore';
import { documentStoreActions } from '../stores';

interface LayerActionMessageBase {
  type: string;
  layerItem?: LayerItem;
  imageDataUrl?: string;
  layerId?: string;
  newName?: string;
  visible?: boolean;
  opacity?: number;
}

export interface UseCollabSyncParams {
  hasOpenDocument: boolean;
  dimensions: CanvasDimensions;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  activeLayerId: string;
  selectedLayerIds: string[];
  layerCanvasesRef: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  selectiveUndoRef: React.MutableRefObject<(peerId?: string | number) => void>;
  setActiveLayerId: (id: string) => void;
  addLayer: (
    type?: 'raster' | 'folder' | 'vector',
    parentId?: string | null,
    customName?: string,
    customId?: string,
    selectNew?: boolean
  ) => LayerItem;
  addRemoteLayer: (layerItem: LayerItem, imageDataUrl?: string) => void;
  deleteLayer: (id: string) => void;
  deleteRemoteLayer: (id: string) => void;
  deleteSelectedLayers: () => void;
  groupSelectedLayers: () => void;
  syncRemoteDocument: (layers: LayerItem[], dataUrls: Record<string, string>) => void;
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
  layerCanvasesRef,
  selectiveUndoRef,
  setActiveLayerId,
  addLayer,
  addRemoteLayer,
  deleteLayer,
  deleteRemoteLayer,
  deleteSelectedLayers,
  groupSelectedLayers,
  syncRemoteDocument,
  renameLayer,
  toggleVisibility,
  setOpacity,
  clearActiveLayer,
  updateLayerThumbnail,
  showToast,
}: UseCollabSyncParams) {
  const remoteDraftCanvasesRef = useRef<Map<string | number, HTMLCanvasElement>>(new Map());
  const remoteStrokeStatesRef = useRef<
    Map<
      string,
      {
        brushSettings: BrushSettings;
        tool: ToolType;
        points: Point[];
        layerId: string;
        peerId: string | number;
      }
    >
  >(new Map());

  const layersRef = useRef(layers);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  const handleRemoteStrokeStart = useCallback(
    (msg: StrokeStartMessage) => {
      remoteStrokeStatesRef.current.set(msg.strokeId, {
        brushSettings: msg.brushSettings,
        tool: msg.tool,
        points: [msg.startPoint],
        layerId: msg.layerId,
        peerId: msg.peerId,
      });

      const draftCanvas = remoteDraftCanvasesRef.current.get(msg.peerId);
      if (!draftCanvas) return;
      const ctx = get2DContext(draftCanvas);
      if (!ctx) return;

      ctx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
      const bs = msg.brushSettings;
      const isEraser = msg.tool === 'eraser';
      const isBgEraser =
        isEraser && (msg.layerId === 'layer-bg' || msg.layerId.startsWith('layer-bg'));
      const isPencil = !isEraser && (bs.preset?.startsWith('pencil') ?? false);
      const strokeColor = isBgEraser ? '#ffffff' : enforceColorMode(bs.color, colorMode);

      if (isPencil) {
        drawPencilDot(
          ctx,
          msg.startPoint,
          strokeColor,
          (bs.preset as PencilGrade) || 'pencil-2b',
          bs.flow ?? 0.74,
          bs.grain ?? 1.0,
          bs.hardness
        );
      } else {
        drawDot(
          ctx,
          msg.startPoint,
          strokeColor,
          isEraser && !isBgEraser,
          colorMode === 'monochrome' ? 1.0 : bs.hardness ?? 1.0,
          bs.flow ?? 1.0
        );
      }
    },
    [colorMode]
  );

  const handleRemoteStrokeChunk = useCallback(
    (msg: StrokeChunkMessage) => {
      const strokeState = remoteStrokeStatesRef.current.get(msg.strokeId);
      if (!strokeState) return;

      const draftCanvas = remoteDraftCanvasesRef.current.get(msg.peerId);
      if (!draftCanvas) return;
      const ctx = get2DContext(draftCanvas);
      if (!ctx) return;

      const bs = strokeState.brushSettings;
      const isEraser = strokeState.tool === 'eraser';
      const isBgEraser =
        isEraser &&
        (strokeState.layerId === 'layer-bg' || strokeState.layerId.startsWith('layer-bg'));
      const isPencil = !isEraser && (bs.preset?.startsWith('pencil') ?? false);
      const strokeColor = isBgEraser ? '#ffffff' : enforceColorMode(bs.color, colorMode);
      const pts = strokeState.points;

      for (let i = 0; i < msg.points.length; i++) {
        const pt = msg.points[i];
        pts.push(pt);

        if (isPencil) {
          if (pts.length >= 3) {
            const p0 = pts[pts.length - 3];
            const p1 = pts[pts.length - 2];
            const p2 = pts[pts.length - 1];
            drawPencilBezierSegment(
              ctx,
              getMidPoint(p0, p1),
              p1,
              getMidPoint(p1, p2),
              strokeColor,
              (bs.preset as PencilGrade) || 'pencil-2b',
              bs.flow ?? 0.74,
              bs.grain ?? 1.0,
              bs.hardness
            );
          } else if (pts.length === 2) {
            drawPencilBezierSegment(
              ctx,
              pts[0],
              pts[0],
              getMidPoint(pts[0], pts[1]),
              strokeColor,
              (bs.preset as PencilGrade) || 'pencil-2b',
              bs.flow ?? 0.74,
              bs.grain ?? 1.0,
              bs.hardness
            );
          }
        } else if (bs.smoothing) {
          if (pts.length >= 3) {
            const p0 = pts[pts.length - 3];
            const p1 = pts[pts.length - 2];
            const p2 = pts[pts.length - 1];
            drawSmoothBezierSegment(
              ctx,
              getMidPoint(p0, p1),
              p1,
              getMidPoint(p1, p2),
              strokeColor,
              isEraser && !isBgEraser,
              colorMode === 'monochrome' ? 1.0 : bs.hardness ?? 1.0,
              bs.flow ?? 1.0,
              bs.spacing ?? 0.1
            );
          } else if (pts.length === 2) {
            drawSmoothBezierSegment(
              ctx,
              pts[0],
              pts[0],
              getMidPoint(pts[0], pts[1]),
              strokeColor,
              isEraser && !isBgEraser,
              colorMode === 'monochrome' ? 1.0 : bs.hardness ?? 1.0,
              bs.flow ?? 1.0,
              bs.spacing ?? 0.1
            );
          }
        } else if (pts.length >= 2) {
          const pPrev = pts[pts.length - 2];
          const pCurr = pts[pts.length - 1];
          ctx.save();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          if ((bs.flow ?? 1.0) < 0.999) {
            ctx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.flow ?? 1.0));
          }
          if (isBgEraser) {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = '#ffffff';
          } else if (isEraser) {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0, 0, 0, 1)';
          } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = strokeColor;
          }
          ctx.lineWidth = (pPrev.width + pCurr.width) / 2;
          ctx.beginPath();
          ctx.moveTo(pPrev.x, pPrev.y);
          ctx.lineTo(pCurr.x, pCurr.y);
          ctx.stroke();
          ctx.restore();
        }
      }
    },
    [colorMode]
  );

  const handleRemoteStrokeFinish = useCallback(
    (msg: StrokeFinishMessage) => {
      const strokeState = remoteStrokeStatesRef.current.get(msg.strokeId);
      if (!strokeState) return;

      if (msg.endPoint) {
        strokeState.points.push(msg.endPoint);
      }

      let targetCanvas = layerCanvasesRef.current.get(msg.layerId);
      let targetLayerId = msg.layerId;

      if (!targetCanvas) {
        const byPeerId = layersRef.current.find(
          (l) => l.type === 'raster' && l.id.includes(String(msg.peerId))
        );
        if (byPeerId) {
          targetCanvas = layerCanvasesRef.current.get(byPeerId.id);
          targetLayerId = byPeerId.id;
        }
      }

      if (!targetCanvas) {
        const fallback =
          layersRef.current.find(
            (l) => l.type === 'raster' && l.id !== 'layer-bg' && !l.id.startsWith('layer-bg')
          ) || layersRef.current.find((l) => l.type === 'raster');
        if (fallback) {
          targetCanvas = layerCanvasesRef.current.get(fallback.id);
          targetLayerId = fallback.id;
        }
      }

      if (targetCanvas && strokeState.points.length > 0) {
        const targetLayer = layersRef.current.find((l) => l.id === targetLayerId);
        const isMono =
          colorMode === 'monochrome' || targetLayer?.expressionColor === 'monochrome';
        const targetFormat = isMono ? 'monochrome-1bit' : 'color-32bit';

        if (msg.vectorStroke && targetLayer?.type === 'vector') {
          targetLayer.vectorStrokes = [...(targetLayer.vectorStrokes || []), msg.vectorStroke];
          const ctx = get2DContext(targetCanvas);
          if (ctx) {
            renderVectorStroke(ctx, msg.vectorStroke);
            const fullData = ctx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
            documentStore
              .getActiveTileGrid()
              .writeImageData(targetLayerId, fullData, 0, 0, targetFormat);
          }
          documentStore.getActiveTileGrid().notifyChange(true);
          updateLayerThumbnail(targetLayerId, true);
        } else {
          const ctx = get2DContext(targetCanvas);
          if (ctx) {
            const isEraser = strokeState.tool === 'eraser';
            const isBgEraser =
              isEraser && (targetLayerId === 'layer-bg' || targetLayerId.startsWith('layer-bg'));
            const bs = strokeState.brushSettings;
            const isTranslucentBrush = !isEraser && (bs.opacity ?? 1.0) < 0.999;
            const isAlphaLocked = Boolean(targetLayer?.alphaLocked);
            const isTransparentInk = Boolean(bs.isTransparentInk);

            if (isTranslucentBrush || isTransparentInk || isAlphaLocked) {
              const bakeCanvas = getReusableBakeCanvas(targetCanvas.width, targetCanvas.height);
              const bCtx = get2DContext(bakeCanvas);
              if (bCtx) {
                bCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
                renderCompleteStroke(
                  bCtx,
                  strokeState.points,
                  { ...bs, opacity: 1.0, isTransparentInk: false },
                  strokeState.tool,
                  colorMode,
                  isBgEraser,
                  targetCanvas,
                  false
                );
                ctx.save();
                ctx.globalAlpha = Math.max(0.01, Math.min(1.0, bs.opacity ?? 1.0));
                if (isTransparentInk) {
                  ctx.globalCompositeOperation = 'destination-out';
                } else if (isAlphaLocked) {
                  ctx.globalCompositeOperation = 'source-atop';
                } else {
                  ctx.globalCompositeOperation = 'source-over';
                }
                ctx.drawImage(bakeCanvas, 0, 0);
                ctx.restore();
              }
            } else {
              renderCompleteStroke(
                ctx,
                strokeState.points,
                bs,
                strokeState.tool,
                colorMode,
                isBgEraser,
                targetCanvas,
                isAlphaLocked
              );
            }

            const pad = Math.ceil(Math.max(32, (bs.size || 10) * 1.5));
            let dirtyX = 0;
            let dirtyY = 0;
            let dirtyW = targetCanvas.width;
            let dirtyH = targetCanvas.height;

            if (msg.dirtyRect) {
              dirtyX = Math.max(0, Math.floor(msg.dirtyRect.x));
              dirtyY = Math.max(0, Math.floor(msg.dirtyRect.y));
              dirtyW = Math.min(targetCanvas.width - dirtyX, Math.ceil(msg.dirtyRect.width));
              dirtyH = Math.min(targetCanvas.height - dirtyY, Math.ceil(msg.dirtyRect.height));
            } else if (strokeState.points.length > 0) {
              let minX = Infinity;
              let minY = Infinity;
              let maxX = -Infinity;
              let maxY = -Infinity;
              for (const pt of strokeState.points) {
                if (pt.x < minX) minX = pt.x;
                if (pt.y < minY) minY = pt.y;
                if (pt.x > maxX) maxX = pt.x;
                if (pt.y > maxY) maxY = pt.y;
              }
              dirtyX = Math.max(0, Math.floor(minX - pad));
              dirtyY = Math.max(0, Math.floor(minY - pad));
              dirtyW = Math.min(targetCanvas.width - dirtyX, Math.ceil(maxX + pad) - dirtyX);
              dirtyH = Math.min(targetCanvas.height - dirtyY, Math.ceil(maxY + pad) - dirtyY);
            }

            if (dirtyW > 0 && dirtyH > 0) {
              const afterData = ctx.getImageData(dirtyX, dirtyY, dirtyW, dirtyH);
              documentStore
                .getActiveTileGrid()
                .writeImageData(targetLayerId, afterData, dirtyX, dirtyY, targetFormat);
            }

            documentStore.getActiveTileGrid().notifyChange(true);
            updateLayerThumbnail(targetLayerId, true);
          }
        }
      }

      const draftCanvas = remoteDraftCanvasesRef.current.get(msg.peerId);
      if (draftCanvas) {
        const ctx = get2DContext(draftCanvas);
        if (ctx) {
          ctx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
        }
      }

      remoteStrokeStatesRef.current.delete(msg.strokeId);
    },
    [colorMode, layerCanvasesRef, updateLayerThumbnail]
  );

  const handleRemoteDocSync = useCallback(
    (
      syncDims: CanvasDimensions,
      syncMode: CanvasColorMode,
      syncLayers: LayerItem[],
      syncDataUrls: Record<string, string>
    ) => {
      documentStoreActions.setDimensions(syncDims);
      documentStoreActions.setColorMode(syncMode);
      syncRemoteDocument(syncLayers, syncDataUrls);
      const newDocId = `doc-collab-${Date.now()}`;
      const newDoc: DocumentTab = {
        id: newDocId,
        name: 'Collab Session',
        dimensions: syncDims,
        colorMode: syncMode,
        layers: syncLayers,
        activeLayerId: syncLayers[0]?.id || 'layer-1',
        perspectiveRuler: null,
      };
      documentStoreActions.setPerspectiveRuler(null);
      documentStoreActions.setDocuments([newDoc]);
      documentStoreActions.setActiveDocumentId(newDocId);
      documentStoreActions.setDocumentName('Collab Session');
    },
    [syncRemoteDocument]
  );

  const handleRemoteAssignedLayer = useCallback(
    (layerId: string) => {
      setActiveLayerId(layerId);
    },
    [setActiveLayerId]
  );

  const handleRemoteJoinRequest = useCallback(
    (peer: CollabPeer) => {
      const layerName = getNextCollabLayerName(peer.name, layersRef.current);
      const layerId = `layer-${peer.id}-1`;
      const newLayer = addLayer('raster', null, layerName, layerId, false);
      multiplayerService.sendLayerAdd(newLayer);
      const updated = layersRef.current.some((l) => l.id === newLayer.id)
        ? layersRef.current
        : [newLayer, ...layersRef.current];
      return {
        assignedLayerId: layerId,
        updatedLayers: updated,
      };
    },
    [addLayer]
  );

  const handleRemoteLayerAction = useCallback(
    (msg: MultiplayerMessage) => {
      const action = msg as unknown as LayerActionMessageBase;
      if (action.type === 'LAYER_ADD') {
        if (action.layerItem) {
          addRemoteLayer(action.layerItem, action.imageDataUrl);
        }
      } else if (action.type === 'LAYER_DELETE') {
        if (action.layerId) {
          deleteRemoteLayer(action.layerId);
        }
      } else if (action.type === 'LAYER_CLEAR' && action.layerId) {
        const layerId = action.layerId;
        const targetCanvas = layerCanvasesRef.current.get(layerId);
        if (targetCanvas) {
          const ctx = get2DContext(targetCanvas);
          if (ctx) {
            const isBg = layerId === 'layer-bg' || layerId.startsWith('layer-bg');
            if (isBg) {
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
              documentStore.getActiveTileGrid().ingestCanvas(layerId, targetCanvas, 'color-32bit');
            } else {
              ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
              documentStore.getActiveTileGrid().clearLayer(layerId);
            }
            documentStore.getActiveTileGrid().notifyChange(true);
            updateLayerThumbnail(layerId, true);
          }
        }
      } else if (action.type === 'LAYER_RENAME') {
        if (action.layerId && action.newName) {
          renameLayer(action.layerId, action.newName);
        }
      } else if (action.type === 'LAYER_VISIBILITY') {
        if (action.layerId && action.visible !== undefined) {
          const l = layersRef.current.find((item) => item.id === action.layerId);
          if (l && l.visible !== action.visible) {
            toggleVisibility(action.layerId);
          }
        }
      } else if (action.type === 'LAYER_OPACITY') {
        if (action.layerId && action.opacity !== undefined) {
          setOpacity(action.layerId, action.opacity);
        }
      }
    },
    [
      addRemoteLayer,
      deleteRemoteLayer,
      layerCanvasesRef,
      updateLayerThumbnail,
      renameLayer,
      toggleVisibility,
      setOpacity,
    ]
  );

  const mp = useMultiplayer({
    dimensions,
    colorMode,
    layers,
    layerCanvasesRef,
    onRemoteStrokeStart: handleRemoteStrokeStart,
    onRemoteStrokeChunk: handleRemoteStrokeChunk,
    onRemoteStrokeFinish: handleRemoteStrokeFinish,
    onRemoteDocSync: handleRemoteDocSync,
    onRemoteJoinRequest: handleRemoteJoinRequest,
    onRemoteAssignedLayer: handleRemoteAssignedLayer,
    onRemoteLayerAction: handleRemoteLayerAction,
    onRemoteSelectiveUndo: (_strokeId, peerId) => {
      selectiveUndoRef.current(peerId);
    },
    showToast,
  });

  const handleStartHosting = useCallback(
    async (roomName: string, port: number, hostNickname?: string, isGlobal?: boolean) => {
      if (!hasOpenDocument) {
        showToast('Please create or open a canvas before hosting a session.');
        return false;
      }
      const finalHostName = (hostNickname || mp.myPeer.name || 'Sora').trim();
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
      return await mp.startHosting(roomName, port, finalHostName, isGlobal);
    },
    [hasOpenDocument, showToast, mp.myPeer.name, activeLayerId, renameLayer, mp.startHosting]
  );

  const handleAddLayer = useCallback(
    (type: 'raster' | 'folder' = 'raster') => {
      if (mp.isConnected && type === 'raster') {
        const name = getNextCollabLayerName(mp.myPeer.name, layersRef.current);
        const newLayer = addLayer('raster', null, name);
        if (newLayer) {
          multiplayerService.sendLayerAdd(newLayer);
        }
      } else {
        addLayer(type);
      }
    },
    [mp.isConnected, mp.myPeer.name, addLayer]
  );

  const handleDeleteLayer = useCallback(
    (id: string) => {
      deleteLayer(id);
      if (mp.isConnected) {
        multiplayerService.sendLayerDelete(id);
      }
    },
    [deleteLayer, mp.isConnected]
  );

  const handleDeleteSelectedLayers = useCallback(() => {
    if (selectedLayerIds && selectedLayerIds.length > 1) {
      deleteSelectedLayers();
      showToast(`Deleted ${selectedLayerIds.length} layers`);
    } else {
      handleDeleteLayer(activeLayerId);
    }
  }, [selectedLayerIds, deleteSelectedLayers, handleDeleteLayer, activeLayerId, showToast]);

  const handleGroupSelectedLayers = useCallback(() => {
    groupSelectedLayers();
    showToast('Grouped layers into folder');
  }, [groupSelectedLayers, showToast]);

  const handleToggleVisibility = useCallback(
    (id: string) => {
      const l = layersRef.current.find((item) => item.id === id);
      toggleVisibility(id);
      if (mp.isConnected && l) {
        multiplayerService.sendLayerVisibility(id, !l.visible);
      }
    },
    [toggleVisibility, mp.isConnected]
  );

  const handleSetOpacity = useCallback(
    (id: string, opacity: number) => {
      setOpacity(id, opacity);
      if (mp.isConnected) {
        multiplayerService.sendLayerOpacity(id, opacity);
      }
    },
    [setOpacity, mp.isConnected]
  );

  const handleRenameLayer = useCallback(
    (id: string, newName: string) => {
      renameLayer(id, newName);
      if (mp.isConnected) {
        multiplayerService.sendLayerRename(id, newName);
      }
    },
    [renameLayer, mp.isConnected]
  );

  const handleClearActiveLayer = useCallback(() => {
    clearActiveLayer();
    if (mp.isConnected) {
      multiplayerService.sendLayerClear(activeLayerId);
    }
  }, [clearActiveLayer, mp.isConnected, activeLayerId]);

  return {
    ...mp,
    remoteDraftCanvasesRef,
    handleStartHosting,
    handleAddLayer,
    handleDeleteLayer,
    handleDeleteSelectedLayers,
    handleGroupSelectedLayers,
    handleToggleVisibility,
    handleSetOpacity,
    handleRenameLayer,
    handleClearActiveLayer,
  };
}
