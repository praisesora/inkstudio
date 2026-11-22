import { CanvasDimensions, LayerItem, isFolderLikeLayer } from '../../types/editor';
import { getCanvasCompositeOperation } from '../canvasUtils';
import {
  buildLayerTree,
  groupTreeNodesForCompositing,
  LayerTreeNode,
} from '../compositor';
import { applyAdjustment } from '../tonalEngine';
import { applyMultiFrameClip, renderFrameBorder } from '../frameEngine';
import { SparseTileGrid, releaseTemporaryCanvas } from '../tileEngine';
import { acquireLayerExportCanvas } from './exportGridPrep';

/**
 * CPU 2D fallback compositor — used strictly when WebGL2 is unavailable.
 */
export function compositeCanvasCpuFallback(
  dimensions: CanvasDimensions,
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement> | undefined,
  getEffectiveOpacity: (layer: LayerItem) => number,
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean,
  fillWhiteBackground: boolean = false,
  tileGrid?: SparseTileGrid
): HTMLCanvasElement {
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = dimensions.width;
  exportCanvas.height = dimensions.height;
  const ctx = exportCanvas.getContext('2d');
  if (!ctx) return exportCanvas;

  if (fillWhiteBackground) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dimensions.width, dimensions.height);
  }

  const getMaskedLayerCanvas = (
    layer: LayerItem,
    srcCanvas: HTMLCanvasElement
  ): { canvas: HTMLCanvasElement; isTemporary: boolean } => {
    if (!layer.maskCanvas || layer.maskEnabled === false) {
      return { canvas: srcCanvas, isTemporary: false };
    }
    const masked = document.createElement('canvas');
    masked.width = dimensions.width;
    masked.height = dimensions.height;
    const mCtx = masked.getContext('2d');
    const maskCtx = layer.maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!mCtx || !maskCtx) {
      releaseTemporaryCanvas(masked);
      return { canvas: srcCanvas, isTemporary: false };
    }
    mCtx.drawImage(srcCanvas, 0, 0);
    const imgData = mCtx.getImageData(0, 0, dimensions.width, dimensions.height);
    const maskData = maskCtx.getImageData(0, 0, dimensions.width, dimensions.height).data;
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const maskLum = ((0.299 * maskData[i] + 0.587 * maskData[i + 1] + 0.114 * maskData[i + 2]) / 255) * (maskData[i + 3] / 255);
      d[i + 3] = Math.round(d[i + 3] * maskLum);
    }
    mCtx.putImageData(imgData, 0, 0);
    return { canvas: masked, isTemporary: true };
  };

  const renderTreeNodes = (
    targetCtx: CanvasRenderingContext2D,
    nodes: LayerTreeNode[],
    opacityMul: number
  ) => {
    const renderOrder = nodes.slice().reverse();
    const groups = groupTreeNodesForCompositing(renderOrder);

    for (const group of groups) {
      const baseNode = group.baseNode;
      const baseLayer = baseNode.layer;
      if (!baseLayer.visible || baseLayer.opacity <= 0.001) continue;

      if (baseLayer.type === 'frame-folder') {
        const folderAlpha = opacityMul * baseLayer.opacity;
        const frames = (baseLayer.comicFrames || []).filter((f) => f.polygon.length >= 3);
        const shouldClip = frames.length > 0 && frames.some((f) => f.clipChildren !== false);
        const folderCanvas = document.createElement('canvas');
        folderCanvas.width = dimensions.width;
        folderCanvas.height = dimensions.height;
        const fCtx = folderCanvas.getContext('2d');
        if (fCtx) {
          fCtx.save();
          if (shouldClip) {
            applyMultiFrameClip(fCtx, frames);
          }
          for (const frame of frames) {
            if (frame.fillBackground !== false) {
              fCtx.fillStyle = frame.fillColor || '#ffffff';
              fCtx.beginPath();
              fCtx.moveTo(frame.polygon[0].x, frame.polygon[0].y);
              for (let i = 1; i < frame.polygon.length; i++) {
                fCtx.lineTo(frame.polygon[i].x, frame.polygon[i].y);
              }
              fCtx.closePath();
              fCtx.fill();
            }
          }
          if (baseNode.children.length > 0) {
            renderTreeNodes(fCtx, baseNode.children, 1.0);
          }
          fCtx.restore();
          for (const frame of frames) {
            renderFrameBorder(fCtx, frame, false);
          }
          targetCtx.save();
          targetCtx.globalAlpha = Math.max(0, Math.min(1, folderAlpha));
          const blend = baseLayer.blendMode === 'pass-through' ? 'normal' : baseLayer.blendMode;
          targetCtx.globalCompositeOperation = getCanvasCompositeOperation(blend);
          targetCtx.drawImage(folderCanvas, 0, 0);
          targetCtx.restore();
        }
        releaseTemporaryCanvas(folderCanvas);
        continue;
      }

      if (baseLayer.type === 'folder') {
        const folderAlpha = opacityMul * baseLayer.opacity;
        if (baseLayer.blendMode === 'pass-through') {
          if (baseNode.children.length > 0) {
            renderTreeNodes(targetCtx, baseNode.children, folderAlpha);
          }
        } else {
          const folderCanvas = document.createElement('canvas');
          folderCanvas.width = dimensions.width;
          folderCanvas.height = dimensions.height;
          const fCtx = folderCanvas.getContext('2d');
          if (fCtx) {
            if (baseNode.children.length > 0) {
              renderTreeNodes(fCtx, baseNode.children, 1.0);
            }
            targetCtx.save();
            targetCtx.globalAlpha = Math.max(0, Math.min(1, folderAlpha));
            targetCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
            targetCtx.drawImage(folderCanvas, 0, 0);
            targetCtx.restore();
          }
          releaseTemporaryCanvas(folderCanvas);
        }
        continue;
      }

      if (!isLayerEffectivelyVisible(baseLayer)) continue;

      if (baseLayer.type === 'adjustment' && baseLayer.adjustmentData) {
        const imgData = targetCtx.getImageData(0, 0, dimensions.width, dimensions.height);
        applyAdjustment(
          imgData,
          baseLayer.adjustmentData,
          baseLayer.maskEnabled !== false ? baseLayer.maskCanvas : undefined,
          baseLayer.opacity * opacityMul
        );
        targetCtx.putImageData(imgData, 0, 0);
        continue;
      }

      const baseAcq = acquireLayerExportCanvas(baseLayer, dimensions, layerCanvasesMap, tileGrid);
      if (!baseAcq.canvas) continue;
      const maskedBase = getMaskedLayerCanvas(baseLayer, baseAcq.canvas);

      const activeClipped = group.clippedNodes
        .map((n) => n.layer)
        .filter((cl) => !isFolderLikeLayer(cl) && cl.type !== 'adjustment' && cl.visible && cl.opacity > 0.001);

      if (activeClipped.length === 0) {
        targetCtx.save();
        targetCtx.globalAlpha = Math.max(0, Math.min(1, baseLayer.opacity * opacityMul));
        targetCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
        targetCtx.drawImage(maskedBase.canvas, 0, 0);
        targetCtx.restore();
      } else {
        const groupCanvas = document.createElement('canvas');
        groupCanvas.width = dimensions.width;
        groupCanvas.height = dimensions.height;
        const gCtx = groupCanvas.getContext('2d');
        if (gCtx) {
          gCtx.save();
          gCtx.globalAlpha = Math.max(0, Math.min(1, baseLayer.opacity * opacityMul));
          gCtx.drawImage(maskedBase.canvas, 0, 0);
          gCtx.restore();

          for (const clipped of activeClipped) {
            const clipAcq = acquireLayerExportCanvas(clipped, dimensions, layerCanvasesMap, tileGrid);
            if (!clipAcq.canvas) continue;
            const maskedClip = getMaskedLayerCanvas(clipped, clipAcq.canvas);

            gCtx.save();
            gCtx.globalAlpha = Math.max(0, Math.min(1, clipped.opacity * opacityMul));
            gCtx.globalCompositeOperation = 'source-atop';
            gCtx.drawImage(maskedClip.canvas, 0, 0);
            gCtx.restore();

            if (maskedClip.isTemporary) releaseTemporaryCanvas(maskedClip.canvas);
            if (clipAcq.isTemporary) releaseTemporaryCanvas(clipAcq.canvas);
          }

          targetCtx.save();
          targetCtx.globalAlpha = 1.0;
          targetCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
          targetCtx.drawImage(groupCanvas, 0, 0);
          targetCtx.restore();
        }
        releaseTemporaryCanvas(groupCanvas);
      }

      if (maskedBase.isTemporary) releaseTemporaryCanvas(maskedBase.canvas);
      if (baseAcq.isTemporary) releaseTemporaryCanvas(baseAcq.canvas);
    }
  };

  const tree = buildLayerTree(layers);
  renderTreeNodes(ctx, tree, 1.0);
  void getEffectiveOpacity;

  return exportCanvas;
}
