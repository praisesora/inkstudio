import { LayerItem, CanvasDimensions, DirtyRect, TileDelta } from '../types/editor';
import { getCanvasCompositeOperation } from './canvasUtils';
import {
  BYTES_32BIT,
  SparseTileGrid,
  TILE_PIXELS,
  TILE_SIZE,
  TileFormat,
  TileSnapshotEntry,
  pixelToTileCoord,
  releaseTemporaryCanvas,
} from './tileEngine';
import { documentStore } from './documentStore';
import { floodFillNative, isNativeRustAvailable } from './nativeBackend';

/**
 * Parses color string (hex #RRGGBB, #RGB, or rgba) to [r, g, b, a (0-255)].
 */
export function parseColorToRgba(colorStr: string): [number, number, number, number] {
  const c = colorStr.trim();
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16) || 0;
      const g = parseInt(hex.slice(2, 4), 16) || 0;
      const b = parseInt(hex.slice(4, 6), 16) || 0;
      return [r, g, b, 255];
    }
    if (hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16) || 0;
      const g = parseInt(hex.slice(2, 4), 16) || 0;
      const b = parseInt(hex.slice(4, 6), 16) || 0;
      const a = parseInt(hex.slice(6, 8), 16) || 0;
      return [r, g, b, a];
    }
  }

  const rgbaMatch = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/i);
  if (rgbaMatch) {
    const r = parseInt(rgbaMatch[1], 10);
    const g = parseInt(rgbaMatch[2], 10);
    const b = parseInt(rgbaMatch[3], 10);
    const a = rgbaMatch[4] !== undefined ? Math.round(parseFloat(rgbaMatch[4]) * 255) : 255;
    return [r, g, b, a];
  }

  return [0, 0, 0, 255];
}

export interface FloodFillOptions {
  /** Bridges gaps in line art up to N pixels wide (0–20) via morphological closing */
  closeGap?: number;
  /** Expands (+1..+20) or shrinks (-20..-1) the filled region in pixels */
  areaScale?: number;
  /** Smooths boundary pixels against anti-aliased line art */
  antiAlias?: boolean;
  /** Optional active selection mask (1/255 = inside selection, 0 = outside) */
  selectionMask?: Uint8Array | null;
  /** When true, only modifies pixels with existing non-zero alpha on the target layer */
  alphaLocked?: boolean;
}

function isLayerEffectivelyVisibleInList(layer: LayerItem, layers: LayerItem[]): boolean {
  if (!layer.visible) return false;
  let parentId = layer.parentId;
  let guard = 0;
  while (parentId && guard < 32) {
    const parent = layers.find((l) => l.id === parentId);
    if (!parent) break;
    if (!parent.visible) return false;
    parentId = parent.parentId;
    guard++;
  }
  return true;
}

function pointInPolygonFlood(
  px: number,
  py: number,
  polygon: Array<{ x: number; y: number }>
): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Creates a flat composite canvas of all visible layers.
 * Reads directly from SparseTileGrid when a layer has no materialized backing canvas.
 */
export function compositeVisibleLayers(
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  dimensions: CanvasDimensions,
  tileGrid?: SparseTileGrid
): HTMLCanvasElement {
  const composite = document.createElement('canvas');
  composite.width = dimensions.width;
  composite.height = dimensions.height;
  const ctx = composite.getContext('2d');
  if (!ctx) return composite;

  const grid = tileGrid ?? documentStore.getActiveTileGrid();

  // Render order is bottom to top (reverse of layers array)
  const renderOrder = layers.slice().reverse();
  for (const layer of renderOrder) {
    if (layer.type === 'folder' || !layer.visible) continue;
    let lCanvas = layerCanvasesMap.get(layer.id) || null;
    let isTemp = false;
    if (!lCanvas && grid && grid.hasLayerTiles(layer.id)) {
      lCanvas = grid.exportLayerToCanvas(layer.id, dimensions.width, dimensions.height);
      isTemp = true;
    }
    if (!lCanvas) continue;

    ctx.save();
    ctx.globalAlpha = layer.opacity ?? 1.0;
    ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
    ctx.drawImage(lCanvas, 0, 0);
    ctx.restore();

    if (isTemp) {
      releaseTemporaryCanvas(lCanvas);
    }
  }

  return composite;
}

/**
 * Creates a composite canvas of only layers marked as Reference (`isReference: true`).
 * Falls back to `compositeVisibleLayers` if no visible reference layer exists.
 */
export function compositeReferenceLayers(
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  dimensions: CanvasDimensions,
  tileGrid?: SparseTileGrid
): HTMLCanvasElement {
  const refLayers = layers.filter((l) => l.visible && l.isReference && l.type !== 'folder');
  if (refLayers.length === 0) {
    return compositeVisibleLayers(layers, layerCanvasesMap, dimensions, tileGrid);
  }

  const composite = document.createElement('canvas');
  composite.width = dimensions.width;
  composite.height = dimensions.height;
  const ctx = composite.getContext('2d');
  if (!ctx) return composite;

  const grid = tileGrid ?? documentStore.getActiveTileGrid();

  const renderOrder = refLayers.slice().reverse();
  for (const layer of renderOrder) {
    let lCanvas = layerCanvasesMap.get(layer.id) || null;
    let isTemp = false;
    if (!lCanvas && grid && grid.hasLayerTiles(layer.id)) {
      lCanvas = grid.exportLayerToCanvas(layer.id, dimensions.width, dimensions.height);
      isTemp = true;
    }
    if (!lCanvas) continue;

    ctx.save();
    ctx.globalAlpha = layer.opacity ?? 1.0;
    ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
    ctx.drawImage(lCanvas, 0, 0);
    ctx.restore();

    if (isTemp) {
      releaseTemporaryCanvas(lCanvas);
    }
  }

  return composite;
}

/**
 * Separable 2D binary dilation (radius r) in O(W * H) time.
 */
function dilateBinaryMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return new Uint8Array(mask);
  const horiz = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);

  // Horizontal pass using distance-to-last-one
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    let lastOne = -100000;
    for (let x = 0; x < width; x++) {
      if (mask[rowOffset + x]) lastOne = x;
      if (x - lastOne <= radius) horiz[rowOffset + x] = 1;
    }
    lastOne = 100000;
    for (let x = width - 1; x >= 0; x--) {
      if (mask[rowOffset + x]) lastOne = x;
      if (lastOne - x <= radius) horiz[rowOffset + x] = 1;
    }
  }

  // Vertical pass
  for (let x = 0; x < width; x++) {
    let lastOne = -100000;
    for (let y = 0; y < height; y++) {
      const idx = y * width + x;
      if (horiz[idx]) lastOne = y;
      if (y - lastOne <= radius) out[idx] = 1;
    }
    lastOne = 100000;
    for (let y = height - 1; y >= 0; y--) {
      const idx = y * width + x;
      if (horiz[idx]) lastOne = y;
      if (lastOne - y <= radius) out[idx] = 1;
    }
  }

  return out;
}

/**
 * Separable 2D binary erosion (radius r) in O(W * H) time.
 */
function erodeBinaryMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return new Uint8Array(mask);
  const horiz = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);

  // Horizontal pass: pixel is 1 iff no 0 within radius
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    let lastZero = -100000;
    for (let x = 0; x < width; x++) {
      if (!mask[rowOffset + x]) lastZero = x;
      if (x - lastZero > radius) horiz[rowOffset + x] = 1;
    }
    lastZero = 100000;
    for (let x = width - 1; x >= 0; x--) {
      if (!mask[rowOffset + x]) lastZero = x;
      if (lastZero - x <= radius) horiz[rowOffset + x] = 0;
    }
  }

  // Vertical pass
  for (let x = 0; x < width; x++) {
    let lastZero = -100000;
    for (let y = 0; y < height; y++) {
      const idx = y * width + x;
      if (!horiz[idx]) lastZero = y;
      if (y - lastZero > radius) out[idx] = 1;
    }
    lastZero = 100000;
    for (let y = height - 1; y >= 0; y--) {
      const idx = y * width + x;
      if (!horiz[idx]) lastZero = y;
      if (lastZero - y <= radius) out[idx] = 0;
    }
  }

  return out;
}

/**
 * High performance scanline stack-based flood fill with tolerance,
 * CSP-grade Close Gap morphological bridging, and Area Scaling.
 * Can refer to active layer, reference layers, or composite of all layers.
 */
export function executeFloodFill(
  targetCanvas: HTMLCanvasElement,
  referenceCanvas: HTMLCanvasElement,
  startX: number,
  startY: number,
  fillColorHex: string,
  tolerance: number = 32,
  sourceCanvas?: HTMLCanvasElement | null,
  options?: FloodFillOptions
): { dirtyRect: DirtyRect | null; modified: boolean } {
  const width = targetCanvas.width;
  const height = targetCanvas.height;
  if (width <= 0 || height <= 0) return { dirtyRect: null, modified: false };

  const px = Math.floor(startX);
  const py = Math.floor(startY);
  if (px < 0 || px >= width || py < 0 || py >= height) {
    return { dirtyRect: null, modified: false };
  }

  const refCtx = referenceCanvas.getContext('2d', { willReadFrequently: true });
  const targetCtx = targetCanvas.getContext('2d', { willReadFrequently: true });
  if (!refCtx || !targetCtx) return { dirtyRect: null, modified: false };

  const refImgData = refCtx.getImageData(0, 0, width, height);
  const targetImgData = targetCtx.getImageData(0, 0, width, height);
  const refData = refImgData.data;
  const targetData = targetImgData.data;

  const [fillR, fillG, fillB, fillA] = parseColorToRgba(fillColorHex);

  const seedIdx = (py * width + px) * 4;
  const seedR = refData[seedIdx];
  const seedG = refData[seedIdx + 1];
  const seedB = refData[seedIdx + 2];
  const seedA = refData[seedIdx + 3];

  const closeGap = Math.max(0, Math.min(20, Math.round(options?.closeGap ?? 0)));
  const areaScale = Math.max(-20, Math.min(20, Math.round(options?.areaScale ?? 0)));
  const antiAlias = options?.antiAlias ?? false;

  // If clicking identical color on same canvas with 0 tolerance and no areaScale, exit early
  if (
    referenceCanvas === targetCanvas &&
    areaScale === 0 &&
    Math.abs(seedR - fillR) <= 2 &&
    Math.abs(seedG - fillG) <= 2 &&
    Math.abs(seedB - fillB) <= 2 &&
    Math.abs(seedA - fillA) <= 2
  ) {
    return { dirtyRect: null, modified: false };
  }

  const maxToleranceDistance = (tolerance / 100) * 255;
  const totalPixels = width * height;
  const visited = new Uint8Array(totalPixels);

  // Build barrier map if closeGap > 0
  let barrierMask: Uint8Array | null = null;
  if (closeGap > 0) {
    const rawBarrier = new Uint8Array(totalPixels);
    for (let i = 0; i < totalPixels; i++) {
      const idx = i * 4;
      const diff =
        (Math.abs(refData[idx] - seedR) +
          Math.abs(refData[idx + 1] - seedG) +
          Math.abs(refData[idx + 2] - seedB) +
          Math.abs(refData[idx + 3] - seedA)) /
        4;
      if (diff > maxToleranceDistance) {
        rawBarrier[i] = 1;
      }
    }
    const closingRadius = Math.max(1, Math.ceil(closeGap / 2));
    const dilated = dilateBinaryMask(rawBarrier, width, height, closingRadius);
    const closed = erodeBinaryMask(dilated, width, height, closingRadius);
    for (let i = 0; i < totalPixels; i++) {
      if (rawBarrier[i]) closed[i] = 1;
    }
    // Ensure the seed point itself is not blocked if it wasn't originally a barrier
    closed[py * width + px] = rawBarrier[py * width + px];
    barrierMask = closed;
  }

  const selectionMask = options?.selectionMask;
  if (selectionMask && selectionMask.length === totalPixels && selectionMask[py * width + px] === 0) {
    return { dirtyRect: null, modified: false };
  }

  const matchesSeed = (x: number, y: number): boolean => {
    const pIdx = y * width + x;
    if (selectionMask && selectionMask.length === totalPixels && selectionMask[pIdx] === 0) {
      return false;
    }
    if (barrierMask) {
      return barrierMask[pIdx] === 0;
    }
    const idx = pIdx * 4;
    const r = refData[idx];
    const g = refData[idx + 1];
    const b = refData[idx + 2];
    const a = refData[idx + 3];

    const diff = (Math.abs(r - seedR) + Math.abs(g - seedG) + Math.abs(b - seedB) + Math.abs(a - seedA)) / 4;
    return diff <= maxToleranceDistance;
  };

  // Stack of [x, y] coordinates
  const stackX: number[] = [px];
  const stackY: number[] = [py];

  let minX = px;
  let maxX = px;
  let minY = py;
  let maxY = py;

  while (stackX.length > 0) {
    const curX = stackX.pop()!;
    const curY = stackY.pop()!;

    if (visited[curY * width + curX]) continue;

    // Scan left
    let x1 = curX;
    while (x1 >= 0 && matchesSeed(x1, curY) && !visited[curY * width + x1]) {
      x1--;
    }
    x1++;

    // Scan right
    let x2 = curX;
    while (x2 < width && matchesSeed(x2, curY) && !visited[curY * width + x2]) {
      x2++;
    }
    x2--;

    if (x1 > x2) continue;

    if (x1 < minX) minX = x1;
    if (x2 > maxX) maxX = x2;
    if (curY < minY) minY = curY;
    if (curY > maxY) maxY = curY;

    let spanAbove = false;
    let spanBelow = false;

    for (let x = x1; x <= x2; x++) {
      const pIdx = curY * width + x;
      visited[pIdx] = 1;

      // Check row above
      if (curY > 0) {
        const aboveVisited = visited[(curY - 1) * width + x];
        const aboveMatch = matchesSeed(x, curY - 1);
        if (!spanAbove && aboveMatch && !aboveVisited) {
          stackX.push(x);
          stackY.push(curY - 1);
          spanAbove = true;
        } else if (spanAbove && (!aboveMatch || aboveVisited)) {
          spanAbove = false;
        }
      }

      // Check row below
      if (curY < height - 1) {
        const belowVisited = visited[(curY + 1) * width + x];
        const belowMatch = matchesSeed(x, curY + 1);
        if (!spanBelow && belowMatch && !belowVisited) {
          stackX.push(x);
          stackY.push(curY + 1);
          spanBelow = true;
        } else if (spanBelow && (!belowMatch || belowVisited)) {
          spanBelow = false;
        }
      }
    }
  }

  // Apply Area Scaling (Expand / Shrink) with line-art centerline stop guard
  let finalMask: Uint8Array = visited;
  if (areaScale > 0) {
    // Outward BFS expansion up to areaScale steps, stopping if line-art opacity/darkness peaks and starts dropping (centerline guard)
    const getLineStrength = (pIdx: number): number => {
      const idx = pIdx * 4;
      const a = refData[idx + 3] / 255;
      const luma = (0.299 * refData[idx] + 0.587 * refData[idx + 1] + 0.114 * refData[idx + 2]) / 255;
      return a * (1.0 - luma * 0.85);
    };

    let frontier: number[] = [];
    for (let y = minY; y <= maxY; y++) {
      const rowOffset = y * width;
      for (let x = minX; x <= maxX; x++) {
        const pIdx = rowOffset + x;
        if (!finalMask[pIdx]) continue;
        if (
          (x > 0 && !finalMask[pIdx - 1]) ||
          (x < width - 1 && !finalMask[pIdx + 1]) ||
          (y > 0 && !finalMask[pIdx - width]) ||
          (y < height - 1 && !finalMask[pIdx + width])
        ) {
          frontier.push(pIdx);
        }
      }
    }

    const dirs = [-1, 1, -width, width];
    for (let step = 0; step < areaScale && frontier.length > 0; step++) {
      const nextFrontier: number[] = [];
      for (let i = 0; i < frontier.length; i++) {
        const pIdx = frontier[i];
        const pxCur = pIdx % width;
        const pyCur = (pIdx - pxCur) / width;
        const curStrength = getLineStrength(pIdx);

        for (let d = 0; d < 4; d++) {
          const offset = dirs[d];
          if (offset === -1 && pxCur === 0) continue;
          if (offset === 1 && pxCur === width - 1) continue;
          if (offset === -width && pyCur === 0) continue;
          if (offset === width && pyCur === height - 1) continue;

          const nIdx = pIdx + offset;
          if (finalMask[nIdx]) continue;

          const nStrength = getLineStrength(nIdx);
          // Line-art centerline guard: if current pixel is already inside dense line art (curStrength > 0.55)
          // and neighbor is becoming lighter again (past the line centerline), stop expanding!
          if (curStrength > 0.55 && nStrength < curStrength - 0.05) {
            continue;
          }

          finalMask[nIdx] = 1;
          nextFrontier.push(nIdx);
          const nx = nIdx % width;
          const ny = (nIdx - nx) / width;
          if (nx < minX) minX = nx;
          if (nx > maxX) maxX = nx;
          if (ny < minY) minY = ny;
          if (ny > maxY) maxY = ny;
        }
      }
      frontier = nextFrontier;
    }
  } else if (areaScale < 0) {
    finalMask = erodeBinaryMask(visited, width, height, Math.abs(areaScale));
  }

  if (antiAlias) {
    minX = Math.max(0, minX - 1);
    minY = Math.max(0, minY - 1);
    maxX = Math.min(width - 1, maxX + 1);
    maxY = Math.min(height - 1, maxY + 1);
  }

  // Write filled pixels to targetData
  for (let y = minY; y <= maxY; y++) {
    const rowOffset = y * width;
    for (let x = minX; x <= maxX; x++) {
      const pIdx = rowOffset + x;
      if (selectionMask && selectionMask.length === totalPixels && selectionMask[pIdx] === 0) {
        continue;
      }
      if (finalMask[pIdx]) {
        const tIdx = pIdx * 4;
        targetData[tIdx] = fillR;
        targetData[tIdx + 1] = fillG;
        targetData[tIdx + 2] = fillB;
        targetData[tIdx + 3] = fillA;
      } else if (antiAlias) {
        // Check if adjacent to filled region for 1px anti-aliased fringe smoothing
        let filledNeighbors = 0;
        if (x > 0 && finalMask[pIdx - 1]) filledNeighbors++;
        if (x < width - 1 && finalMask[pIdx + 1]) filledNeighbors++;
        if (y > 0 && finalMask[pIdx - width]) filledNeighbors++;
        if (y < height - 1 && finalMask[pIdx + width]) filledNeighbors++;
        if (filledNeighbors >= 2) {
          const tIdx = pIdx * 4;
          const blendAlpha = (filledNeighbors / 4) * (fillA / 255) * 0.5;
          const dstA = targetData[tIdx + 3] / 255;
          const outA = blendAlpha + dstA * (1 - blendAlpha);
          if (outA > 0) {
            targetData[tIdx] = Math.round((fillR * blendAlpha + targetData[tIdx] * dstA * (1 - blendAlpha)) / outA);
            targetData[tIdx + 1] = Math.round((fillG * blendAlpha + targetData[tIdx + 1] * dstA * (1 - blendAlpha)) / outA);
            targetData[tIdx + 2] = Math.round((fillB * blendAlpha + targetData[tIdx + 2] * dstA * (1 - blendAlpha)) / outA);
            targetData[tIdx + 3] = Math.round(outA * 255);
          }
        }
      }
    }
  }

  targetCtx.putImageData(targetImgData, 0, 0);

  if (sourceCanvas) {
    const srcCtx = sourceCanvas.getContext('2d');
    if (srcCtx) {
      srcCtx.putImageData(targetImgData, 0, 0);
    }
  }

  const dirtyRect: DirtyRect = {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX + 1),
    height: Math.max(1, maxY - minY + 1),
  };

  return { dirtyRect, modified: true };
}

/**
 * Fills a freehand lasso polygon directly with solid color.
 */
export function executeLassoFill(
  targetCanvas: HTMLCanvasElement,
  polygon: Array<{ x: number; y: number }>,
  fillColorHex: string,
  sourceCanvas?: HTMLCanvasElement | null
): { dirtyRect: DirtyRect | null; modified: boolean } {
  if (polygon.length < 3) return { dirtyRect: null, modified: false };

  const ctx = targetCanvas.getContext('2d');
  if (!ctx) return { dirtyRect: null, modified: false };

  let minX = polygon[0].x;
  let maxX = polygon[0].x;
  let minY = polygon[0].y;
  let maxY = polygon[0].y;

  for (const pt of polygon) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  ctx.save();
  ctx.fillStyle = fillColorHex;
  ctx.beginPath();
  ctx.moveTo(polygon[0].x, polygon[0].y);
  for (let i = 1; i < polygon.length; i++) {
    ctx.lineTo(polygon[i].x, polygon[i].y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  if (sourceCanvas) {
    const sCtx = sourceCanvas.getContext('2d');
    if (sCtx) {
      sCtx.save();
      sCtx.fillStyle = fillColorHex;
      sCtx.beginPath();
      sCtx.moveTo(polygon[0].x, polygon[0].y);
      for (let i = 1; i < polygon.length; i++) {
        sCtx.lineTo(polygon[i].x, polygon[i].y);
      }
      sCtx.closePath();
      sCtx.fill();
      sCtx.restore();
    }
  }

  const dirtyRect: DirtyRect = {
    x: Math.max(0, Math.floor(minX)),
    y: Math.max(0, Math.floor(minY)),
    width: Math.max(1, Math.ceil(maxX - minX)),
    height: Math.max(1, Math.ceil(maxY - minY)),
  };

  return { dirtyRect, modified: true };
}

/**
 * Lazily composites a single 256x256 reference tile across a list of layers in SparseTileGrid.
 * Returns null when all contributing layers are empty at (tx, ty).
 */
export function buildCompositedReferenceTile(
  grid: SparseTileGrid,
  refLayers: LayerItem[],
  tx: number,
  ty: number
): Uint8ClampedArray | null {
  let out: Uint8ClampedArray | null = null;
  for (let i = refLayers.length - 1; i >= 0; i--) {
    const layer = refLayers[i];
    if (layer.type === 'folder' || layer.type === 'frame-folder' || !layer.visible) continue;
    const tile = grid.getTile(layer.id, tx, ty, 0);
    if (!tile || !tile.data) continue;
    const src = grid.getTileAsRGBA(tile);
    const layerAlpha = layer.opacity ?? 1.0;
    if (layerAlpha <= 0.001) continue;

    if (!out) {
      out = new Uint8ClampedArray(BYTES_32BIT);
      if (layerAlpha >= 0.999) {
        out.set(src);
      } else {
        for (let p = 0; p < BYTES_32BIT; p += 4) {
          out[p] = src[p];
          out[p + 1] = src[p + 1];
          out[p + 2] = src[p + 2];
          out[p + 3] = Math.round(src[p + 3] * layerAlpha);
        }
      }
    } else {
      for (let p = 0; p < BYTES_32BIT; p += 4) {
        const sa = src[p + 3];
        if (sa === 0) continue;
        const sA = (sa / 255) * layerAlpha;
        const dA = out[p + 3] / 255;
        const outA = sA + dA * (1 - sA);
        if (outA > 0) {
          const invOut = 1 / outA;
          const invSA = 1 - sA;
          out[p] = Math.round((src[p] * sA + out[p] * dA * invSA) * invOut);
          out[p + 1] = Math.round((src[p + 1] * sA + out[p + 1] * dA * invSA) * invOut);
          out[p + 2] = Math.round((src[p + 2] * sA + out[p + 2] * dA * invSA) * invOut);
          out[p + 3] = Math.round(outA * 255);
        }
      }
    }
  }
  return out;
}

const FLOOD_TILE_STRIDE = 65536;
const FLOOD_TILE_BIAS = 32768;
function packFloodTileKey(tx: number, ty: number): number {
  return (ty + FLOOD_TILE_BIAS) * FLOOD_TILE_STRIDE + (tx + FLOOD_TILE_BIAS);
}

/**
 * Tile-native scanline flood fill operating directly on SparseTileGrid.
 * Peak memory is proportional to visited tiles only (zero full-canvas materialization).
 */
export function executeFloodFillOnTileGrid(params: {
  grid: SparseTileGrid;
  targetLayerId: string;
  layers: LayerItem[];
  dimensions: CanvasDimensions;
  startX: number;
  startY: number;
  fillColorHex: string;
  tolerance: number;
  referMode: 'active' | 'refer-all' | 'refer-reference';
  targetFormat?: TileFormat;
  options?: FloodFillOptions;
}): { dirtyRect: DirtyRect | null; modified: boolean; tileDeltas: TileDelta[] } {
  const {
    grid,
    targetLayerId,
    layers,
    dimensions,
    startX,
    startY,
    fillColorHex,
    tolerance,
    referMode,
    options,
  } = params;
  const width = dimensions.width;
  const height = dimensions.height;
  if (width <= 0 || height <= 0) return { dirtyRect: null, modified: false, tileDeltas: [] };

  const px = Math.floor(startX);
  const py = Math.floor(startY);
  if (px < 0 || px >= width || py < 0 || py >= height) {
    return { dirtyRect: null, modified: false, tileDeltas: [] };
  }

  const selectionMask = options?.selectionMask ?? null;
  const totalPixels = width * height;
  if (selectionMask && selectionMask.length === totalPixels && selectionMask[py * width + px] === 0) {
    return { dirtyRect: null, modified: false, tileDeltas: [] };
  }

  // Determine reference layers for lazy tile compositing (respecting ancestor folder visibility)
  let refLayers: LayerItem[] | null = null;
  if (referMode === 'refer-reference') {
    const refs = layers.filter(
      (l) =>
        isLayerEffectivelyVisibleInList(l, layers) &&
        l.isReference &&
        l.type !== 'folder' &&
        l.type !== 'frame-folder'
    );
    refLayers =
      refs.length > 0
        ? refs
        : layers.filter(
            (l) =>
              isLayerEffectivelyVisibleInList(l, layers) &&
              l.type !== 'folder' &&
              l.type !== 'frame-folder'
          );
  } else if (referMode === 'refer-all') {
    refLayers = layers.filter(
      (l) =>
        isLayerEffectivelyVisibleInList(l, layers) &&
        l.type !== 'folder' &&
        l.type !== 'frame-folder'
    );
  }

  const refTileCache = new Map<number, Uint8ClampedArray | null>();
  const getRefTile = (tx: number, ty: number): Uint8ClampedArray | null => {
    const key = packFloodTileKey(tx, ty);
    let cached = refTileCache.get(key);
    if (cached !== undefined) return cached;
    if (refLayers) {
      cached = buildCompositedReferenceTile(grid, refLayers, tx, ty);
    } else {
      const tile = grid.getTile(targetLayerId, tx, ty, 0);
      cached = tile && tile.data ? new Uint8ClampedArray(grid.getTileAsRGBA(tile)) : null;
    }
    refTileCache.set(key, cached);
    return cached;
  };

  const getRefPixel = (x: number, y: number, out: [number, number, number, number]): void => {
    const tile = getRefTile(x >> 8, y >> 8);
    if (!tile) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
      return;
    }
    const off = (((y & 255) << 8) | (x & 255)) << 2;
    out[0] = tile[off];
    out[1] = tile[off + 1];
    out[2] = tile[off + 2];
    out[3] = tile[off + 3];
  };

  const [fillR, fillG, fillB, fillA] = parseColorToRgba(fillColorHex);
  const seedPx: [number, number, number, number] = [0, 0, 0, 0];
  getRefPixel(px, py, seedPx);
  const [seedR, seedG, seedB, seedA] = seedPx;

  const closeGap = Math.max(0, Math.min(20, Math.round(options?.closeGap ?? 0)));
  const areaScale = Math.max(-20, Math.min(20, Math.round(options?.areaScale ?? 0)));
  const antiAlias = options?.antiAlias ?? false;

  if (
    referMode === 'active' &&
    areaScale === 0 &&
    Math.abs(seedR - fillR) <= 2 &&
    Math.abs(seedG - fillG) <= 2 &&
    Math.abs(seedB - fillB) <= 2 &&
    Math.abs(seedA - fillA) <= 2
  ) {
    return { dirtyRect: null, modified: false, tileDeltas: [] };
  }

  const maxToleranceDistance = (tolerance / 100) * 255;

  // Lazy per-tile barrier cache when closeGap > 0 (padded morphological closing across tile boundaries)
  const barrierTileCache = closeGap > 0 ? new Map<number, Uint8Array>() : null;
  const closingRadius = closeGap > 0 ? Math.max(1, Math.ceil(closeGap / 2)) : 0;

  const getBarrierTile = (tx: number, ty: number): Uint8Array => {
    const key = packFloodTileKey(tx, ty);
    let cached = barrierTileCache!.get(key);
    if (cached) return cached;

    const r = closingRadius;
    const padSize = TILE_SIZE + r * 2;
    const raw = new Uint8Array(padSize * padSize);
    const originX = tx * TILE_SIZE - r;
    const originY = ty * TILE_SIZE - r;
    const tmp: [number, number, number, number] = [0, 0, 0, 0];

    for (let ly = 0; ly < padSize; ly++) {
      const gy = originY + ly;
      const row = ly * padSize;
      for (let lx = 0; lx < padSize; lx++) {
        const gx = originX + lx;
        if (gx < 0 || gx >= width || gy < 0 || gy >= height) {
          raw[row + lx] = 1;
          continue;
        }
        getRefPixel(gx, gy, tmp);
        const diff =
          (Math.abs(tmp[0] - seedR) +
            Math.abs(tmp[1] - seedG) +
            Math.abs(tmp[2] - seedB) +
            Math.abs(tmp[3] - seedA)) /
          4;
        if (diff > maxToleranceDistance) raw[row + lx] = 1;
      }
    }

    const dilated = dilateBinaryMask(raw, padSize, padSize, r);
    const closed = erodeBinaryMask(dilated, padSize, padSize, r);
    cached = new Uint8Array(TILE_PIXELS);
    for (let ly = 0; ly < TILE_SIZE; ly++) {
      const srcRow = (ly + r) * padSize + r;
      const dstRow = ly * TILE_SIZE;
      for (let lx = 0; lx < TILE_SIZE; lx++) {
        cached[dstRow + lx] = raw[srcRow + lx] || closed[srcRow + lx] ? 1 : 0;
      }
    }
    // Never block the seed pixel if it wasn't originally a barrier
    if ((px >> 8) === tx && (py >> 8) === ty) {
      const slx = px & 255;
      const sly = py & 255;
      cached[sly * TILE_SIZE + slx] = raw[(sly + r) * padSize + (slx + r)];
    }
    barrierTileCache!.set(key, cached);
    return cached;
  };

  // Sparse visited bitmask per 256x256 tile
  const visitedTiles = new Map<number, Uint8Array>();
  const isVisited = (x: number, y: number): boolean => {
    const arr = visitedTiles.get(packFloodTileKey(x >> 8, y >> 8));
    if (!arr) return false;
    return arr[((y & 255) << 8) | (x & 255)] !== 0;
  };
  const setVisited = (x: number, y: number): void => {
    const key = packFloodTileKey(x >> 8, y >> 8);
    let arr = visitedTiles.get(key);
    if (!arr) {
      arr = new Uint8Array(TILE_PIXELS);
      visitedTiles.set(key, arr);
    }
    arr[((y & 255) << 8) | (x & 255)] = 1;
  };

  const sampleTmp: [number, number, number, number] = [0, 0, 0, 0];
  const matchesSeed = (x: number, y: number): boolean => {
    if (selectionMask && selectionMask.length === totalPixels && selectionMask[y * width + x] === 0) {
      return false;
    }
    if (barrierTileCache) {
      const bt = getBarrierTile(x >> 8, y >> 8);
      return bt[((y & 255) << 8) | (x & 255)] === 0;
    }
    getRefPixel(x, y, sampleTmp);
    const diff =
      (Math.abs(sampleTmp[0] - seedR) +
        Math.abs(sampleTmp[1] - seedG) +
        Math.abs(sampleTmp[2] - seedB) +
        Math.abs(sampleTmp[3] - seedA)) /
      4;
    return diff <= maxToleranceDistance;
  };

  const stackX: number[] = [px];
  const stackY: number[] = [py];

  let minX = px;
  let maxX = px;
  let minY = py;
  let maxY = py;

  while (stackX.length > 0) {
    const curX = stackX.pop()!;
    const curY = stackY.pop()!;
    if (isVisited(curX, curY)) continue;

    let x1 = curX;
    while (x1 >= 0 && matchesSeed(x1, curY) && !isVisited(x1, curY)) {
      x1--;
    }
    x1++;

    let x2 = curX;
    while (x2 < width && matchesSeed(x2, curY) && !isVisited(x2, curY)) {
      x2++;
    }
    x2--;

    if (x1 > x2) continue;

    if (x1 < minX) minX = x1;
    if (x2 > maxX) maxX = x2;
    if (curY < minY) minY = curY;
    if (curY > maxY) maxY = curY;

    let spanAbove = false;
    let spanBelow = false;

    for (let x = x1; x <= x2; x++) {
      setVisited(x, curY);

      if (curY > 0) {
        const aboveVisited = isVisited(x, curY - 1);
        const aboveMatch = matchesSeed(x, curY - 1);
        if (!spanAbove && aboveMatch && !aboveVisited) {
          stackX.push(x);
          stackY.push(curY - 1);
          spanAbove = true;
        } else if (spanAbove && (!aboveMatch || aboveVisited)) {
          spanAbove = false;
        }
      }

      if (curY < height - 1) {
        const belowVisited = isVisited(x, curY + 1);
        const belowMatch = matchesSeed(x, curY + 1);
        if (!spanBelow && belowMatch && !belowVisited) {
          stackX.push(x);
          stackY.push(curY + 1);
          spanBelow = true;
        } else if (spanBelow && (!belowMatch || belowVisited)) {
          spanBelow = false;
        }
      }
    }
  }

  // Optional Area Scaling operated strictly on the tight filled bounding box (not full 600 DPI doc)
  if (areaScale > 0) {
    const getLineStrength = (x: number, y: number): number => {
      getRefPixel(x, y, sampleTmp);
      const a = sampleTmp[3] / 255;
      const luma = (0.299 * sampleTmp[0] + 0.587 * sampleTmp[1] + 0.114 * sampleTmp[2]) / 255;
      return a * (1.0 - luma * 0.85);
    };

    let frontier: number[] = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!isVisited(x, y)) continue;
        if (
          (x > 0 && !isVisited(x - 1, y)) ||
          (x < width - 1 && !isVisited(x + 1, y)) ||
          (y > 0 && !isVisited(x, y - 1)) ||
          (y < height - 1 && !isVisited(x, y + 1))
        ) {
          frontier.push(x, y);
        }
      }
    }

    const dxDirs = [-1, 1, 0, 0];
    const dyDirs = [0, 0, -1, 1];
    for (let step = 0; step < areaScale && frontier.length > 0; step++) {
      const nextFrontier: number[] = [];
      for (let i = 0; i < frontier.length; i += 2) {
        const cx = frontier[i];
        const cy = frontier[i + 1];
        const curStrength = getLineStrength(cx, cy);
        for (let d = 0; d < 4; d++) {
          const nx = cx + dxDirs[d];
          const ny = cy + dyDirs[d];
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          if (isVisited(nx, ny)) continue;
          const nStrength = getLineStrength(nx, ny);
          if (curStrength > 0.55 && nStrength < curStrength - 0.05) continue;
          setVisited(nx, ny);
          nextFrontier.push(nx, ny);
          if (nx < minX) minX = nx;
          if (nx > maxX) maxX = nx;
          if (ny < minY) minY = ny;
          if (ny > maxY) maxY = ny;
        }
      }
      frontier = nextFrontier;
    }
  } else if (areaScale < 0) {
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const localMask = new Uint8Array(bw * bh);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (isVisited(x, y)) localMask[(y - minY) * bw + (x - minX)] = 1;
      }
    }
    const eroded = erodeBinaryMask(localMask, bw, bh, Math.abs(areaScale));
    visitedTiles.clear();
    for (let ly = 0; ly < bh; ly++) {
      for (let lx = 0; lx < bw; lx++) {
        if (eroded[ly * bw + lx]) setVisited(minX + lx, minY + ly);
      }
    }
  }

  if (antiAlias) {
    minX = Math.max(0, minX - 1);
    minY = Math.max(0, minY - 1);
    maxX = Math.min(width - 1, maxX + 1);
    maxY = Math.min(height - 1, maxY + 1);
  }

  const targetFormat = params.targetFormat ?? grid.getLayerFormat(targetLayerId);
  const beforeSnapshot = new Map<string, TileSnapshotEntry>();

  const minTx = pixelToTileCoord(minX, 0);
  const minTy = pixelToTileCoord(minY, 0);
  const maxTx = pixelToTileCoord(maxX, 0);
  const maxTy = pixelToTileCoord(maxY, 0);

  const alphaLocked = Boolean(options?.alphaLocked);
  const workBuf = new Uint8ClampedArray(BYTES_32BIT);

  for (let ty = minTy; ty <= maxTy; ty++) {
    const tileDocY = ty * TILE_SIZE;
    const startLY = Math.max(0, minY - tileDocY);
    const endLY = Math.min(TILE_SIZE, maxY - tileDocY + 1);
    for (let tx = minTx; tx <= maxTx; tx++) {
      const tileDocX = tx * TILE_SIZE;
      const startLX = Math.max(0, minX - tileDocX);
      const endLX = Math.min(TILE_SIZE, maxX - tileDocX + 1);

      const tileVisited = visitedTiles.get(packFloodTileKey(tx, ty));
      if (!tileVisited && !antiAlias) continue;

      const existingTile = grid.getTile(targetLayerId, tx, ty, 0);
      if (alphaLocked && (!existingTile || !existingTile.data)) {
        continue;
      }
      if (existingTile && existingTile.data) {
        workBuf.set(grid.getTileAsRGBA(existingTile));
      } else {
        workBuf.fill(0);
      }

      let tileChanged = false;
      for (let ly = startLY; ly < endLY; ly++) {
        const gy = tileDocY + ly;
        const rowOff = ly * TILE_SIZE;
        const selRow = gy * width;
        for (let lx = startLX; lx < endLX; lx++) {
          const gx = tileDocX + lx;
          if (selectionMask && selectionMask.length === totalPixels && selectionMask[selRow + gx] === 0) {
            continue;
          }
          const filled = tileVisited ? tileVisited[rowOff + lx] !== 0 : false;
          if (filled) {
            const off = (rowOff + lx) << 2;
            if (alphaLocked) {
              const dstAlpha = workBuf[off + 3];
              if (dstAlpha === 0) continue;
              const srcA = fillA / 255;
              const invSrcA = 1 - srcA;
              workBuf[off] = Math.round(fillR * srcA + workBuf[off] * invSrcA);
              workBuf[off + 1] = Math.round(fillG * srcA + workBuf[off + 1] * invSrcA);
              workBuf[off + 2] = Math.round(fillB * srcA + workBuf[off + 2] * invSrcA);
              tileChanged = true;
            } else {
              workBuf[off] = fillR;
              workBuf[off + 1] = fillG;
              workBuf[off + 2] = fillB;
              workBuf[off + 3] = fillA;
              tileChanged = true;
            }
          } else if (antiAlias) {
            let filledNeighbors = 0;
            if (gx > 0 && isVisited(gx - 1, gy)) filledNeighbors++;
            if (gx < width - 1 && isVisited(gx + 1, gy)) filledNeighbors++;
            if (gy > 0 && isVisited(gx, gy - 1)) filledNeighbors++;
            if (gy < height - 1 && isVisited(gx, gy + 1)) filledNeighbors++;
            if (filledNeighbors >= 2) {
              const off = (rowOff + lx) << 2;
              if (alphaLocked && workBuf[off + 3] === 0) continue;
              const blendAlpha = (filledNeighbors / 4) * (fillA / 255) * 0.5;
              const dstA = workBuf[off + 3] / 255;
              const outA = alphaLocked ? dstA : blendAlpha + dstA * (1 - blendAlpha);
              if (outA > 0) {
                if (alphaLocked) {
                  const inv = 1 - blendAlpha;
                  workBuf[off] = Math.round(fillR * blendAlpha + workBuf[off] * inv);
                  workBuf[off + 1] = Math.round(fillG * blendAlpha + workBuf[off + 1] * inv);
                  workBuf[off + 2] = Math.round(fillB * blendAlpha + workBuf[off + 2] * inv);
                } else {
                  workBuf[off] = Math.round((fillR * blendAlpha + workBuf[off] * dstA * (1 - blendAlpha)) / outA);
                  workBuf[off + 1] = Math.round((fillG * blendAlpha + workBuf[off + 1] * dstA * (1 - blendAlpha)) / outA);
                  workBuf[off + 2] = Math.round((fillB * blendAlpha + workBuf[off + 2] * dstA * (1 - blendAlpha)) / outA);
                  workBuf[off + 3] = Math.round(outA * 255);
                }
                tileChanged = true;
              }
            }
          }
        }
      }

      if (tileChanged) {
        grid.snapshotSingleTileInto(targetLayerId, tx, ty, beforeSnapshot);
        grid.writeImageData(
          targetLayerId,
          { data: workBuf, width: TILE_SIZE, height: TILE_SIZE },
          tileDocX,
          tileDocY,
          targetFormat,
          true
        );
      }
    }
  }

  const dirtyRect: DirtyRect = {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX + 1),
    height: Math.max(1, maxY - minY + 1),
  };
  const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, targetLayerId, dirtyRect);
  grid.notifyChange(true);
  return { dirtyRect, modified: tileDeltas.length > 0, tileDeltas };
}

/**
 * Tile-native freehand lasso fill: rasterizes the polygon in bounded 512x512 chunks
 * directly into SparseTileGrid tiles (zero full-canvas allocation).
 */
export function executeLassoFillOnTileGrid(params: {
  grid: SparseTileGrid;
  targetLayerId: string;
  dimensions: CanvasDimensions;
  polygon: Array<{ x: number; y: number }>;
  fillColorHex: string;
  targetFormat?: TileFormat;
  alphaLocked?: boolean;
  selectionMask?: Uint8Array | null;
}): { dirtyRect: DirtyRect | null; modified: boolean; tileDeltas: TileDelta[] } {
  const {
    grid,
    targetLayerId,
    dimensions,
    polygon,
    fillColorHex,
    alphaLocked = false,
    selectionMask = null,
  } = params;
  if (polygon.length < 3) {
    return { dirtyRect: null, modified: false, tileDeltas: [] };
  }

  let minX = polygon[0].x;
  let maxX = polygon[0].x;
  let minY = polygon[0].y;
  let maxY = polygon[0].y;
  for (const pt of polygon) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  const rx = Math.max(0, Math.floor(minX));
  const ry = Math.max(0, Math.floor(minY));
  const rx1 = Math.min(dimensions.width, Math.ceil(maxX));
  const ry1 = Math.min(dimensions.height, Math.ceil(maxY));
  const rw = rx1 - rx;
  const rh = ry1 - ry;
  if (rw <= 0 || rh <= 0) return { dirtyRect: null, modified: false, tileDeltas: [] };

  const targetFormat = params.targetFormat ?? grid.getLayerFormat(targetLayerId);
  const beforeSnapshot = new Map<string, TileSnapshotEntry>();
  const CHUNK = 512;
  const chunkCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const cCtx = chunkCanvas ? chunkCanvas.getContext('2d', { willReadFrequently: true }) : null;
  const [fillR, fillG, fillB, fillA] = parseColorToRgba(fillColorHex);
  const isEraseFill = fillA === 0;
  const hasSelectionMask = Boolean(
    selectionMask && selectionMask.length === dimensions.width * dimensions.height
  );

  try {
    for (let cy = ry; cy < ry1; cy += CHUNK) {
      const ch = Math.min(CHUNK, ry1 - cy);
      for (let cx = rx; cx < rx1; cx += CHUNK) {
        const cw = Math.min(CHUNK, rx1 - cx);
        let chunkData: Uint8ClampedArray;

        if (chunkCanvas && cCtx) {
          if (chunkCanvas.width !== cw) chunkCanvas.width = cw;
          if (chunkCanvas.height !== ch) chunkCanvas.height = ch;

          cCtx.clearRect(0, 0, cw, ch);
          cCtx.save();
          cCtx.translate(-cx, -cy);
          cCtx.fillStyle = isEraseFill ? '#000000' : fillColorHex;
          cCtx.beginPath();
          cCtx.moveTo(polygon[0].x, polygon[0].y);
          for (let i = 1; i < polygon.length; i++) {
            cCtx.lineTo(polygon[i].x, polygon[i].y);
          }
          cCtx.closePath();
          cCtx.fill();
          cCtx.restore();
          chunkData = cCtx.getImageData(0, 0, cw, ch).data;
        } else {
          chunkData = new Uint8ClampedArray(cw * ch * 4);
          for (let ly = 0; ly < ch; ly++) {
            const gy = cy + ly + 0.5;
            const row = ly * cw * 4;
            for (let lx = 0; lx < cw; lx++) {
              if (pointInPolygonFlood(cx + lx + 0.5, gy, polygon)) {
                const off = row + lx * 4;
                chunkData[off] = fillR;
                chunkData[off + 1] = fillG;
                chunkData[off + 2] = fillB;
                chunkData[off + 3] = isEraseFill ? 255 : fillA;
              }
            }
          }
        }

        if (hasSelectionMask && selectionMask) {
          for (let ly = 0; ly < ch; ly++) {
            const selRow = (cy + ly) * dimensions.width + cx;
            const dRow = ly * cw * 4;
            for (let lx = 0; lx < cw; lx++) {
              if (selectionMask[selRow + lx] === 0) {
                chunkData[dRow + lx * 4 + 3] = 0;
              }
            }
          }
        }

        grid.compositeStrokeToTiles({
          layerId: targetLayerId,
          strokeData: { data: chunkData, width: cw, height: ch },
          destX: cx,
          destY: cy,
          format: targetFormat,
          compositeOp: isEraseFill
            ? 'destination-out'
            : alphaLocked
              ? 'source-atop'
              : 'source-over',
          opacity: 1.0,
          snapshotOut: beforeSnapshot,
          suppressNotify: true,
        });
      }
    }
  } finally {
    if (chunkCanvas) releaseTemporaryCanvas(chunkCanvas);
  }

  const dirtyRect: DirtyRect = { x: rx, y: ry, width: rw, height: rh };
  const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, targetLayerId, dirtyRect);
  grid.notifyChange(true);
  return { dirtyRect, modified: tileDeltas.length > 0, tileDeltas };
}

/**
 * Async tile-native flood fill: dispatches Close Gap + Area Scale + scanline fill
 * to the parallel Rust Rayon backend when running in Tauri, returning only the
 * modified dirtyRect pixels over raw binary IPC.
 */
export async function executeFloodFillOnTileGridAsync(params: {
  grid: SparseTileGrid;
  targetLayerId: string;
  layers: LayerItem[];
  dimensions: CanvasDimensions;
  startX: number;
  startY: number;
  fillColorHex: string;
  tolerance: number;
  referMode: 'active' | 'refer-all' | 'refer-reference';
  targetFormat?: TileFormat;
  options?: FloodFillOptions;
}): Promise<{ dirtyRect: DirtyRect | null; modified: boolean; tileDeltas: TileDelta[] }> {
  if (!isNativeRustAvailable() || params.options?.alphaLocked) {
    return executeFloodFillOnTileGrid(params);
  }

  const {
    grid,
    targetLayerId,
    layers,
    dimensions,
    startX,
    startY,
    fillColorHex,
    tolerance,
    referMode,
    options,
  } = params;

  const width = dimensions.width;
  const height = dimensions.height;
  if (width <= 0 || height <= 0) return { dirtyRect: null, modified: false, tileDeltas: [] };
  // Guard against extreme canvases exceeding native 256MB raster IPC cap (~8192x8192 RGBA)
  if (width * height * 4 > 128 * 1024 * 1024) {
    return executeFloodFillOnTileGrid(params);
  }

  const px = Math.floor(startX);
  const py = Math.floor(startY);
  if (px < 0 || px >= width || py < 0 || py >= height) {
    return { dirtyRect: null, modified: false, tileDeltas: [] };
  }

  const targetRgba = grid.readImageData(targetLayerId, 0, 0, width, height).data;
  let refRgba: Uint8ClampedArray = targetRgba;

  if (referMode !== 'active') {
    const refLayers =
      referMode === 'refer-reference'
        ? (() => {
            const r = layers.filter(
              (l) =>
                isLayerEffectivelyVisibleInList(l, layers) &&
                l.isReference &&
                l.type !== 'folder' &&
                l.type !== 'frame-folder'
            );
            return r.length > 0
              ? r
              : layers.filter(
                  (l) =>
                    isLayerEffectivelyVisibleInList(l, layers) &&
                    l.type !== 'folder' &&
                    l.type !== 'frame-folder'
                );
          })()
        : layers.filter(
            (l) =>
              isLayerEffectivelyVisibleInList(l, layers) &&
              l.type !== 'folder' &&
              l.type !== 'frame-folder'
          );

    const comp = new Uint8ClampedArray(width * height * 4);
    const tilesX = Math.ceil(width / TILE_SIZE);
    const tilesY = Math.ceil(height / TILE_SIZE);
    for (let ty = 0; ty < tilesY; ty++) {
      const tileDocY = ty * TILE_SIZE;
      const copyH = Math.min(TILE_SIZE, height - tileDocY);
      for (let tx = 0; tx < tilesX; tx++) {
        const cTile = buildCompositedReferenceTile(grid, refLayers, tx, ty);
        if (!cTile) continue;
        const tileDocX = tx * TILE_SIZE;
        const copyW = Math.min(TILE_SIZE, width - tileDocX);
        const rowBytes = copyW * 4;
        for (let row = 0; row < copyH; row++) {
          const sOff = row * TILE_SIZE * 4;
          const dOff = ((tileDocY + row) * width + tileDocX) * 4;
          comp.set(cTile.subarray(sOff, sOff + rowBytes), dOff);
        }
      }
    }
    refRgba = comp;
  }

  let res: Awaited<ReturnType<typeof floodFillNative>>;
  try {
    res = await floodFillNative({
      refRgba,
      targetRgba: referMode === 'active' ? null : targetRgba,
      selectionMask: options?.selectionMask ?? null,
      width,
      height,
      startX: px,
      startY: py,
      fillRgba: parseColorToRgba(fillColorHex),
      tolerance,
      closeGap: Math.max(0, Math.min(20, Math.round(options?.closeGap ?? 0))),
      areaScale: Math.max(-20, Math.min(20, Math.round(options?.areaScale ?? 0))),
      antiAlias: options?.antiAlias ?? false,
    });
  } catch (err) {
    console.warn('Native flood fill failed, falling back to JS tile flood fill:', err);
    return executeFloodFillOnTileGrid(params);
  }

  if (!res.modified || !res.dirtyRect || !res.dirtyRgba) {
    return { dirtyRect: null, modified: false, tileDeltas: [] };
  }

  const targetFormat = params.targetFormat ?? grid.getLayerFormat(targetLayerId);
  const beforeSnapshot = grid.snapshotTilesInRect(targetLayerId, res.dirtyRect);
  grid.writeImageData(
    targetLayerId,
    { data: res.dirtyRgba, width: res.dirtyRect.width, height: res.dirtyRect.height },
    res.dirtyRect.x,
    res.dirtyRect.y,
    targetFormat,
    true
  );
  const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, targetLayerId, res.dirtyRect);
  grid.notifyChange(true);
  return { dirtyRect: res.dirtyRect, modified: tileDeltas.length > 0, tileDeltas };
}
