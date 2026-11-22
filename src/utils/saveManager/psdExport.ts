import type {
  BlendMode as AgPsdBlendMode,
  Layer as AgPsdLayer,
  LayerMaskData as AgPsdMaskData,
} from 'ag-psd';
import {
  BlendMode,
  CanvasDimensions,
  LayerItem,
  isFolderLikeLayer,
  hasTileBackedLayer,
} from '../../types/editor';
import type { LayerTreeNode } from '../compositor';
import { SparseTileGrid, TILE_SIZE } from '../tileEngine';
import { acquireLayerExportCanvas } from './exportGridPrep';

/**
 * Maps Ink Studio BlendMode to ag-psd BlendMode format.
 */
export function toAgPsdBlendMode(mode: BlendMode): AgPsdBlendMode {
  switch (mode) {
    case 'color-dodge':
    case 'color-dodge-glow':
      return 'color dodge';
    case 'color-burn':
      return 'color burn';
    case 'linear-burn':
      return 'linear burn';
    case 'darker-color':
      return 'darker color';
    case 'add-glow':
      return 'linear dodge';
    case 'lighter-color':
      return 'lighter color';
    case 'hard-light':
      return 'hard light';
    case 'soft-light':
      return 'soft light';
    case 'vivid-light':
      return 'vivid light';
    case 'linear-light':
      return 'linear light';
    case 'pin-light':
      return 'pin light';
    case 'hard-mix':
      return 'hard mix';
    case 'pass-through':
      return 'pass through';
    case 'normal':
    case 'multiply':
    case 'screen':
    case 'overlay':
    case 'darken':
    case 'lighten':
    case 'difference':
    case 'exclusion':
    case 'subtract':
    case 'divide':
    case 'hue':
    case 'saturation':
    case 'color':
    case 'luminosity':
      return mode;
    default:
      return 'normal';
  }
}

function extractLayerMaskForPsd(layer: LayerItem): AgPsdMaskData | undefined {
  const maskCanvas = layer.maskCanvas;
  if (!maskCanvas || maskCanvas.width <= 0 || maskCanvas.height <= 0) {
    return undefined;
  }

  const mw = maskCanvas.width;
  const mh = maskCanvas.height;
  const maskMeta: AgPsdMaskData = {
    top: 0,
    left: 0,
    bottom: mh,
    right: mw,
    defaultColor: 255,
    disabled: layer.maskEnabled === false,
    positionRelativeToLayer: layer.maskLinked === false,
  };

  const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (ctx && typeof ctx.getImageData === 'function') {
    const src = ctx.getImageData(0, 0, mw, mh).data;
    const out = new Uint8ClampedArray(mw * mh * 4);
    for (let i = 0; i < src.length; i += 4) {
      const lum = Math.round(((0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) * src[i + 3]) / 255);
      out[i] = lum;
      out[i + 1] = lum;
      out[i + 2] = lum;
      out[i + 3] = 255;
    }
    maskMeta.imageData = { data: out, width: mw, height: mh };
  } else {
    maskMeta.canvas = maskCanvas;
  }

  return maskMeta;
}

function attachRasterPixelsForPsd(
  target: AgPsdLayer,
  layer: LayerItem,
  dimensions: CanvasDimensions,
  layerCanvasesMap: Map<string, HTMLCanvasElement> | undefined,
  tileGrid: SparseTileGrid | undefined,
  tempCanvases: HTMLCanvasElement[]
): void {
  const isVectorText =
    (layer.type === 'text' && Boolean(layer.textData)) ||
    (layer.type === 'balloon' && Boolean(layer.balloonData));

  if (!isVectorText && !layerCanvasesMap?.has(layer.id) && tileGrid && tileGrid.hasLayerTiles(layer.id)) {
    const tiles = tileGrid.getLayerTiles(layer.id, 0);
    if (tiles.length === 0) return;

    let minX = dimensions.width;
    let minY = dimensions.height;
    let maxX = 0;
    let maxY = 0;
    for (const tile of tiles) {
      const tx0 = tile.tileX * TILE_SIZE;
      const ty0 = tile.tileY * TILE_SIZE;
      if (tx0 < minX) minX = tx0;
      if (ty0 < minY) minY = ty0;
      if (tx0 + TILE_SIZE > maxX) maxX = tx0 + TILE_SIZE;
      if (ty0 + TILE_SIZE > maxY) maxY = ty0 + TILE_SIZE;
    }
    const left = Math.max(0, minX);
    const top = Math.max(0, minY);
    const right = Math.min(dimensions.width, maxX);
    const bottom = Math.min(dimensions.height, maxY);
    if (left < right && top < bottom) {
      const imgData = tileGrid.readImageData(layer.id, left, top, right - left, bottom - top);
      target.left = left;
      target.top = top;
      target.right = right;
      target.bottom = bottom;
      target.imageData = imgData;
    }
    return;
  }

  const acq = acquireLayerExportCanvas(layer, dimensions, layerCanvasesMap, tileGrid);
  if (!acq.canvas) return;
  if (acq.isTemporary) tempCanvases.push(acq.canvas);

  const w = acq.canvas.width;
  const h = acq.canvas.height;
  if (w <= 0 || h <= 0) return;

  const ctx = acq.canvas.getContext('2d', { willReadFrequently: true });
  if (ctx && typeof ctx.getImageData === 'function') {
    const imgData = ctx.getImageData(0, 0, w, h);
    target.left = 0;
    target.top = 0;
    target.right = w;
    target.bottom = h;
    target.imageData = { data: imgData.data, width: w, height: h };
  } else {
    target.canvas = acq.canvas;
  }
}

export function buildPsdLayerTree(
  nodes: LayerTreeNode[],
  dimensions: CanvasDimensions,
  layerCanvasesMap: Map<string, HTMLCanvasElement> | undefined,
  tileGrid: SparseTileGrid | undefined,
  tempCanvases: HTMLCanvasElement[]
): AgPsdLayer[] {
  const result: AgPsdLayer[] = [];

  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const layer = node.layer;
    const isFolder = isFolderLikeLayer(layer);
    if (!isFolder && !hasTileBackedLayer(layer)) continue;

    const psdLayer: AgPsdLayer = {
      name: layer.name,
      hidden: !layer.visible,
      opacity: Math.max(0, Math.min(1, layer.opacity ?? 1)),
      blendMode: toAgPsdBlendMode(layer.blendMode),
    };

    if (layer.clipped) {
      psdLayer.clipping = true;
    }

    if (layer.alphaLocked || layer.locked) {
      psdLayer.protected = {
        transparency: Boolean(layer.alphaLocked),
        composite: Boolean(layer.locked),
        position: Boolean(layer.locked),
      };
      if (layer.alphaLocked) {
        psdLayer.transparencyProtected = true;
      }
    }

    const mask = extractLayerMaskForPsd(layer);
    if (mask) {
      psdLayer.mask = mask;
    }

    if (isFolder) {
      psdLayer.opened = !layer.collapsed;
      psdLayer.children = buildPsdLayerTree(
        node.children,
        dimensions,
        layerCanvasesMap,
        tileGrid,
        tempCanvases
      );
    } else {
      attachRasterPixelsForPsd(
        psdLayer,
        layer,
        dimensions,
        layerCanvasesMap,
        tileGrid,
        tempCanvases
      );
    }

    result.push(psdLayer);
  }

  return result;
}
