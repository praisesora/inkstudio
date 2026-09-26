import { CanvasSelection, DirtyRect } from '../types/editor';

/**
 * Checks whether a 2D point lies within an arbitrary polygon using ray-casting.
 */
export function isPointInPolygon(
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
 * Tests if point (x, y) is inside the active selection.
 */
export function isPointInSelection(
  x: number,
  y: number,
  selection: CanvasSelection | null
): boolean {
  if (!selection) return false;

  // If there's floating content, test against floating bounds
  if (selection.floating) {
    const fx = selection.floating.x;
    const fy = selection.floating.y;
    const fw = selection.floating.canvas.width;
    const fh = selection.floating.canvas.height;
    return x >= fx && x <= fx + fw && y >= fy && y <= fy + fh;
  }

  const b = selection.bounds;
  if (x < b.x || x > b.x + b.width || y < b.y || y > b.y + b.height) {
    return false;
  }

  if (selection.type === 'lasso' && selection.polygon) {
    return isPointInPolygon(x, y, selection.polygon);
  }

  return true;
}

/**
 * Computes axis-aligned bounding box from a polygon.
 */
export function computePolygonBounds(
  polygon: Array<{ x: number; y: number }>
): { x: number; y: number; width: number; height: number } {
  if (polygon.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = polygon[0].x;
  let maxX = polygon[0].x;
  let minY = polygon[0].y;
  let maxY = polygon[0].y;

  for (let i = 1; i < polygon.length; i++) {
    const p = polygon[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  return {
    x: Math.floor(minX),
    y: Math.floor(minY),
    width: Math.max(1, Math.ceil(maxX - minX)),
    height: Math.max(1, Math.ceil(maxY - minY)),
  };
}

/**
 * Computes the tight bounding box of all non-transparent pixels on a canvas.
 * Returns null if the canvas is completely transparent/blank.
 */
export function getCanvasContentBounds(
  canvas: HTMLCanvasElement,
  isBackground = false
): { x: number; y: number; width: number; height: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const w = canvas.width;
  const h = canvas.height;
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w * 4;
    for (let x = 0; x < w; x++) {
      const idx = rowOffset + x * 4;
      const alpha = data[idx + 3];
      if (isBackground) {
        if (alpha > 0 && (data[idx] !== 255 || data[idx + 1] !== 255 || data[idx + 2] !== 255)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      } else {
        if (alpha > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }

  if (maxX < 0 || maxY < 0) return null;

  const pad = 4;
  const clampedMinX = Math.max(0, minX - pad);
  const clampedMinY = Math.max(0, minY - pad);
  const clampedMaxX = Math.min(w - 1, maxX + pad);
  const clampedMaxY = Math.min(h - 1, maxY + pad);

  return {
    x: clampedMinX,
    y: clampedMinY,
    width: Math.max(10, clampedMaxX - clampedMinX + 1),
    height: Math.max(10, clampedMaxY - clampedMinY + 1),
  };
}

/**
 * Lifts selected pixels from the target canvas into a floating offscreen canvas,
 * erasing them from the target canvas.
 */
export function liftSelectionToFloating(
  targetCanvas: HTMLCanvasElement,
  selection: CanvasSelection,
  sourceCanvas?: HTMLCanvasElement | null,
  isBackground = false
): {
  floatingCanvas: HTMLCanvasElement;
  beforeImageData: ImageData;
} | null {
  const b = selection.bounds;
  if (!b || b.width <= 0 || b.height <= 0) {
    return null;
  }

  const targetCtx = targetCanvas.getContext('2d');
  if (!targetCtx) {
    return null;
  }

  // 1. Snapshot the entire targetCanvas synchronously for undo/cancel
  const beforeImageData = targetCtx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);

  // 2. Extract selection rectangle pixels directly using synchronous getImageData
  // This guarantees zero GPU command race conditions before clearRect!
  const extractedImageData = targetCtx.getImageData(b.x, b.y, b.width, b.height);

  const floatingCanvas = document.createElement('canvas');
  floatingCanvas.width = b.width;
  floatingCanvas.height = b.height;
  const floatCtx = floatingCanvas.getContext('2d');
  if (!floatCtx) {
    return null;
  }

  // Put extracted pixels into floating canvas
  floatCtx.putImageData(extractedImageData, 0, 0);

  // If lasso selection, mask to polygon using destination-in
  if (selection.type === 'lasso' && selection.polygon && selection.polygon.length >= 3) {
    floatCtx.save();
    floatCtx.globalCompositeOperation = 'destination-in';
    floatCtx.beginPath();
    const poly = selection.polygon;
    floatCtx.moveTo(poly[0].x - b.x, poly[0].y - b.y);
    for (let i = 1; i < poly.length; i++) {
      floatCtx.lineTo(poly[i].x - b.x, poly[i].y - b.y);
    }
    floatCtx.closePath();
    floatCtx.fill();
    floatCtx.restore();
  }

  // 3. Erase the extracted area from the base layer
  targetCtx.save();
  if (isBackground) {
    targetCtx.fillStyle = '#ffffff';
    if (selection.type === 'rect') {
      targetCtx.fillRect(b.x, b.y, b.width, b.height);
    } else if (selection.type === 'lasso' && selection.polygon) {
      targetCtx.beginPath();
      const poly = selection.polygon;
      targetCtx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) {
        targetCtx.lineTo(poly[i].x, poly[i].y);
      }
      targetCtx.closePath();
      targetCtx.fill();
    }
  } else {
    if (selection.type === 'rect') {
      targetCtx.clearRect(b.x, b.y, b.width, b.height);
    } else if (selection.type === 'lasso' && selection.polygon) {
      targetCtx.globalCompositeOperation = 'destination-out';
      targetCtx.fillStyle = 'rgba(0, 0, 0, 1)';
      targetCtx.beginPath();
      const poly = selection.polygon;
      targetCtx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) {
        targetCtx.lineTo(poly[i].x, poly[i].y);
      }
      targetCtx.closePath();
      targetCtx.fill();
    }
  }
  targetCtx.restore();

  if (sourceCanvas) {
    const sCtx = sourceCanvas.getContext('2d');
    if (sCtx) {
      sCtx.save();
      if (isBackground) {
        sCtx.fillStyle = '#ffffff';
        if (selection.type === 'rect') {
          sCtx.fillRect(b.x, b.y, b.width, b.height);
        } else if (selection.type === 'lasso' && selection.polygon) {
          sCtx.beginPath();
          const poly = selection.polygon;
          sCtx.moveTo(poly[0].x, poly[0].y);
          for (let i = 1; i < poly.length; i++) {
            sCtx.lineTo(poly[i].x, poly[i].y);
          }
          sCtx.closePath();
          sCtx.fill();
        }
      } else {
        if (selection.type === 'rect') {
          sCtx.clearRect(b.x, b.y, b.width, b.height);
        } else if (selection.type === 'lasso' && selection.polygon) {
          sCtx.globalCompositeOperation = 'destination-out';
          sCtx.fillStyle = 'rgba(0, 0, 0, 1)';
          sCtx.beginPath();
          const poly = selection.polygon;
          sCtx.moveTo(poly[0].x, poly[0].y);
          for (let i = 1; i < poly.length; i++) {
            sCtx.lineTo(poly[i].x, poly[i].y);
          }
          sCtx.closePath();
          sCtx.fill();
        }
      }
      sCtx.restore();
    }
  }

  return { floatingCanvas, beforeImageData };
}

/**
 * Commits floating selection pixels back onto the target canvas.
 */
export function commitFloatingSelection(
  targetCanvas: HTMLCanvasElement,
  floating: NonNullable<CanvasSelection['floating']>,
  sourceCanvas?: HTMLCanvasElement | null
): DirtyRect {
  const targetCtx = targetCanvas.getContext('2d');
  if (targetCtx) {
    targetCtx.save();
    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.drawImage(floating.canvas, floating.x, floating.y);
    targetCtx.restore();
  }

  if (sourceCanvas) {
    const sCtx = sourceCanvas.getContext('2d');
    if (sCtx) {
      sCtx.save();
      sCtx.globalCompositeOperation = 'source-over';
      sCtx.drawImage(floating.canvas, floating.x, floating.y);
      sCtx.restore();
    }
  }

  return {
    x: Math.min(floating.x, floating.origX),
    y: Math.min(floating.y, floating.origY),
    width: Math.max(floating.canvas.width + Math.abs(floating.x - floating.origX), floating.canvas.width),
    height: Math.max(floating.canvas.height + Math.abs(floating.y - floating.origY), floating.canvas.height),
  };
}
