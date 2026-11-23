import { CanvasDimensions, LayerItem, isFolderLikeLayer, resolveToneDensityType } from '../../types/editor';
import { getCanvasCompositeOperation } from '../canvasUtils';
import { applyMultiFrameClip, renderFrameBorder } from '../frameEngine';
import { SparseTileGrid, TILE_SIZE, globalTileGrid } from '../tileEngine';
import { applyAdjustment } from '../tonalEngine';
import { buildLayerTree, groupTreeNodesForCompositing } from './layerTree';
import { LayerTreeNode } from './types';

let previewTileCanvas: HTMLCanvasElement | null = null;
let previewTileImgData: ImageData | null = null;
let previewScratchCanvas: HTMLCanvasElement | null = null;

/**
 * Lightweight low-LOD composite preview renderer for Navigator & thumbnails.
 * Reads directly from SparseTileGrid mipmap LOD tiles (no WebGL context creation, no GPU readPixels stall).
 */
export function renderLowResPreview(
  targetCanvas: HTMLCanvasElement,
  layers: LayerItem[],
  dimensions: CanvasDimensions,
  grid: SparseTileGrid = globalTileGrid,
  options: { showCheckerboard?: boolean } = {}
): void {
  if (typeof document === 'undefined') return;
  const ctx = targetCanvas.getContext('2d');
  if (!ctx) return;

  const outW = Math.max(1, Math.floor(targetCanvas.width));
  const outH = Math.max(1, Math.floor(targetCanvas.height));
  const docW = Math.max(1, dimensions.width);
  const docH = Math.max(1, dimensions.height);

  // Choose lowest sufficient LOD based on downscale ratio (avoids reading full-res tiles on 4K+ canvases)
  const ratio = Math.max(docW / outW, docH / outH);
  const targetLod = ratio >= 7 ? 3 : ratio >= 3.5 ? 2 : ratio >= 1.8 ? 1 : 0;
  const lodDocSize = TILE_SIZE << targetLod;
  const scaleX = outW / docW;
  const scaleY = outH / docH;

  // 1. Background
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  if (options.showCheckerboard) {
    const cell = 6;
    ctx.fillStyle = '#202020';
    ctx.fillRect(0, 0, outW, outH);
    ctx.fillStyle = '#2a2a2a';
    for (let y = 0; y < outH; y += cell) {
      const offset = ((y / cell) & 1) * cell;
      for (let x = offset; x < outW; x += cell * 2) {
        ctx.fillRect(x, y, cell, cell);
      }
    }
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
  }

  if (!previewTileCanvas) {
    previewTileCanvas = document.createElement('canvas');
    previewTileCanvas.width = TILE_SIZE;
    previewTileCanvas.height = TILE_SIZE;
  }
  const tileCanvas = previewTileCanvas;
  const tileCtx = tileCanvas.getContext('2d', { willReadFrequently: true });
  if (!tileCtx) {
    ctx.restore();
    return;
  }

  const drawSingleLayer = (
    dstCtx: CanvasRenderingContext2D,
    layer: LayerItem,
    opacityMul: number,
    compositeOverride?: GlobalCompositeOperation
  ) => {
    const toneDensityMul =
      layer.toneEnabled && resolveToneDensityType(layer) === 'specified'
        ? Math.max(0, Math.min(1, (layer.toneDensity ?? 40) / 100))
        : 1.0;
    const alpha = Math.max(0, Math.min(1, layer.opacity * opacityMul * toneDensityMul));
    if (alpha <= 0.001) return;

    const tiles = grid.getOrBuildLodTiles(layer.id, targetLod);
    if (tiles.length === 0) return;

    dstCtx.save();
    dstCtx.globalAlpha = alpha;
    dstCtx.globalCompositeOperation = compositeOverride ?? getCanvasCompositeOperation(layer.blendMode);
    dstCtx.imageSmoothingEnabled = true;

    if (!previewTileImgData) {
      previewTileImgData = tileCtx.createImageData(TILE_SIZE, TILE_SIZE);
    }
    const reusedImgData = previewTileImgData;

    for (const tile of tiles) {
      const rgba = grid.getTileAsRGBA(tile);
      reusedImgData.data.set(rgba);
      tileCtx.putImageData(reusedImgData, 0, 0);

      const dx = tile.tileX * lodDocSize * scaleX;
      const dy = tile.tileY * lodDocSize * scaleY;
      const dw = lodDocSize * scaleX;
      const dh = lodDocSize * scaleY;
      dstCtx.drawImage(tileCanvas, dx, dy, dw, dh);
    }

    dstCtx.restore();
  };

  const renderNodes = (
    dstCtx: CanvasRenderingContext2D,
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
        const folderOpacity = opacityMul * baseLayer.opacity;
        const frames = (baseLayer.comicFrames || []).filter((f) => f.polygon.length >= 3);
        const shouldClip = frames.length > 0 && frames.some((f) => f.clipChildren !== false);
        const tmp = document.createElement('canvas');
        tmp.width = outW;
        tmp.height = outH;
        const tmpCtx = tmp.getContext('2d');
        if (tmpCtx) {
          const scaledFrames = frames.map((f) => ({
            ...f,
            borderWidth: Math.max(1, (f.borderWidth || 3) * Math.min(scaleX, scaleY)),
            polygon: f.polygon.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })),
          }));
          tmpCtx.save();
          if (shouldClip) {
            applyMultiFrameClip(tmpCtx, scaledFrames);
          }
          for (const sf of scaledFrames) {
            if (sf.fillBackground !== false) {
              tmpCtx.fillStyle = sf.fillColor || '#ffffff';
              tmpCtx.beginPath();
              tmpCtx.moveTo(sf.polygon[0].x, sf.polygon[0].y);
              for (let i = 1; i < sf.polygon.length; i++) {
                tmpCtx.lineTo(sf.polygon[i].x, sf.polygon[i].y);
              }
              tmpCtx.closePath();
              tmpCtx.fill();
            }
          }
          if (baseNode.children.length > 0) {
            renderNodes(tmpCtx, baseNode.children, 1.0);
          }
          tmpCtx.restore();
          for (const sf of scaledFrames) {
            renderFrameBorder(tmpCtx, sf, false);
          }
          dstCtx.save();
          dstCtx.globalAlpha = Math.max(0, Math.min(1, folderOpacity));
          const blend = baseLayer.blendMode === 'pass-through' ? 'normal' : baseLayer.blendMode;
          dstCtx.globalCompositeOperation = getCanvasCompositeOperation(blend);
          dstCtx.drawImage(tmp, 0, 0);
          dstCtx.restore();
        }
        continue;
      }

      if (baseLayer.type === 'folder') {
        const folderOpacity = opacityMul * baseLayer.opacity;
        if (baseLayer.blendMode === 'pass-through') {
          if (baseNode.children.length > 0) {
            renderNodes(dstCtx, baseNode.children, folderOpacity);
          }
        } else {
          const tmp = document.createElement('canvas');
          tmp.width = outW;
          tmp.height = outH;
          const tmpCtx = tmp.getContext('2d');
          if (tmpCtx) {
            if (baseNode.children.length > 0) {
              renderNodes(tmpCtx, baseNode.children, 1.0);
            }
            dstCtx.save();
            dstCtx.globalAlpha = Math.max(0, Math.min(1, folderOpacity));
            dstCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
            dstCtx.drawImage(tmp, 0, 0);
            dstCtx.restore();
          }
        }
        continue;
      }

      if (baseLayer.type === 'adjustment' && baseLayer.adjustmentData) {
        try {
          const imgData = dstCtx.getImageData(0, 0, outW, outH);
          applyAdjustment(imgData, baseLayer.adjustmentData, undefined, baseLayer.opacity * opacityMul);
          dstCtx.putImageData(imgData, 0, 0);
        } catch {
          // Ignore in headless/mock contexts without getImageData
        }
        continue;
      }

      const activeClipped = group.clippedNodes.filter(
        (cn) => cn.layer.visible && cn.layer.opacity > 0.001 && !isFolderLikeLayer(cn.layer)
      );

      if (activeClipped.length === 0) {
        drawSingleLayer(dstCtx, baseLayer, opacityMul);
      } else {
        if (!previewScratchCanvas) {
          previewScratchCanvas = document.createElement('canvas');
        }
        const grpCanvas = previewScratchCanvas;
        if (grpCanvas.width !== outW) grpCanvas.width = outW;
        if (grpCanvas.height !== outH) grpCanvas.height = outH;
        const grpCtx = grpCanvas.getContext('2d');
        if (!grpCtx) {
          drawSingleLayer(dstCtx, baseLayer, opacityMul);
          continue;
        }
        grpCtx.clearRect(0, 0, outW, outH);
        drawSingleLayer(grpCtx, baseLayer, 1.0, 'source-over');
        for (const cn of activeClipped) {
          drawSingleLayer(grpCtx, cn.layer, 1.0, 'source-atop');
        }
        dstCtx.save();
        dstCtx.globalAlpha = Math.max(0, Math.min(1, opacityMul));
        dstCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
        dstCtx.drawImage(grpCanvas, 0, 0);
        dstCtx.restore();
      }
    }
  };

  const tree = buildLayerTree(layers);
  renderNodes(ctx, tree, 1.0);
  ctx.restore();
}
