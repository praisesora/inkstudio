import { LayerItem, CanvasDimensions, DirtyRect } from '../types/editor';

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
    ctx.globalCompositeOperation = (layer.blendMode as GlobalCompositeOperation) || 'source-over';
    ctx.drawImage(lCanvas, 0, 0);
    ctx.restore();
  }

  return composite;
}

/**
 * High performance scanline stack-based flood fill with tolerance.
 * Can refer to active layer or composite of all layers.
 */
export function executeFloodFill(
  targetCanvas: HTMLCanvasElement,
  referenceCanvas: HTMLCanvasElement,
  startX: number,
  startY: number,
  fillColorHex: string,
  tolerance: number = 32,
  sourceCanvas?: HTMLCanvasElement | null
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

  // If clicking identical color on same canvas with 0 tolerance, exit early
  if (
    referenceCanvas === targetCanvas &&
    Math.abs(seedR - fillR) <= 2 &&
    Math.abs(seedG - fillG) <= 2 &&
    Math.abs(seedB - fillB) <= 2 &&
    Math.abs(seedA - fillA) <= 2
  ) {
    return { dirtyRect: null, modified: false };
  }

  const maxToleranceDistance = (tolerance / 100) * 255;
  const visited = new Uint8Array(width * height);

  const matchesSeed = (x: number, y: number): boolean => {
    const idx = (y * width + x) * 4;
    const r = refData[idx];
    const g = refData[idx + 1];
    const b = refData[idx + 2];
    const a = refData[idx + 3];

    // RGBA distance metric
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

      const tIdx = pIdx * 4;
      targetData[tIdx] = fillR;
      targetData[tIdx + 1] = fillG;
      targetData[tIdx + 2] = fillB;
      targetData[tIdx + 3] = fillA;

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
