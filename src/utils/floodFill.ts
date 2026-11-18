import { LayerItem, CanvasDimensions, DirtyRect } from '../types/editor';
import { getCanvasCompositeOperation } from './canvasUtils';

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
}

/**
 * Creates a flat composite canvas of all visible layers.
 * Used for "Refer to Other Layers" bucket fill.
 */
export function compositeVisibleLayers(
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
  dimensions: CanvasDimensions
): HTMLCanvasElement {
  const composite = document.createElement('canvas');
  composite.width = dimensions.width;
  composite.height = dimensions.height;
  const ctx = composite.getContext('2d');
  if (!ctx) return composite;

  // Render order is bottom to top (reverse of layers array)
  const renderOrder = layers.slice().reverse();
  for (const layer of renderOrder) {
    if (layer.type === 'folder' || !layer.visible) continue;
    const lCanvas = layerCanvasesMap.get(layer.id);
    if (!lCanvas) continue;

    ctx.save();
    ctx.globalAlpha = layer.opacity ?? 1.0;
    ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
    ctx.drawImage(lCanvas, 0, 0);
    ctx.restore();
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
  dimensions: CanvasDimensions
): HTMLCanvasElement {
  const refLayers = layers.filter((l) => l.visible && l.isReference && l.type !== 'folder');
  if (refLayers.length === 0) {
    return compositeVisibleLayers(layers, layerCanvasesMap, dimensions);
  }

  const composite = document.createElement('canvas');
  composite.width = dimensions.width;
  composite.height = dimensions.height;
  const ctx = composite.getContext('2d');
  if (!ctx) return composite;

  const renderOrder = refLayers.slice().reverse();
  for (const layer of renderOrder) {
    const lCanvas = layerCanvasesMap.get(layer.id);
    if (!lCanvas) continue;

    ctx.save();
    ctx.globalAlpha = layer.opacity ?? 1.0;
    ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
    ctx.drawImage(lCanvas, 0, 0);
    ctx.restore();
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
