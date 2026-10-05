import { CanvasSelection, DirtyRect, WandSettings } from '../types/editor';

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

  // If pixel mask is defined, sample mask directly
  if (selection.mask && selection.maskWidth && selection.maskHeight) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix < 0 || ix >= selection.maskWidth || iy < 0 || iy >= selection.maskHeight) return false;
    return selection.mask[iy * selection.maskWidth + ix] >= 128;
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
 * Computes tight bounding box from an 8-bit mask buffer.
 */
export function maskToBounds(
  mask: Uint8Array,
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[rowOffset + x] >= 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) return null;

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

/**
 * Converts any selection (rect, lasso, or existing mask) into a full Uint8Array 8-bit mask.
 */
export function selectionToMask(
  selection: CanvasSelection,
  width: number,
  height: number
): Uint8Array {
  if (selection.mask && selection.maskWidth === width && selection.maskHeight === height) {
    return new Uint8Array(selection.mask);
  }

  const mask = new Uint8Array(width * height);
  if (selection.type === 'rect') {
    const b = selection.bounds;
    const x0 = Math.max(0, Math.floor(b.x));
    const y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(width, Math.ceil(b.x + b.width));
    const y1 = Math.min(height, Math.ceil(b.y + b.height));
    for (let y = y0; y < y1; y++) {
      const row = y * width;
      for (let x = x0; x < x1; x++) {
        mask[row + x] = 255;
      }
    }
  } else if (selection.type === 'lasso' && selection.polygon && selection.polygon.length >= 3) {
    // Rasterize polygon onto offscreen 2D canvas
    const offCanvas = document.createElement('canvas');
    offCanvas.width = width;
    offCanvas.height = height;
    const offCtx = offCanvas.getContext('2d');
    if (offCtx) {
      offCtx.fillStyle = '#ffffff';
      offCtx.beginPath();
      offCtx.moveTo(selection.polygon[0].x, selection.polygon[0].y);
      for (let i = 1; i < selection.polygon.length; i++) {
        offCtx.lineTo(selection.polygon[i].x, selection.polygon[i].y);
      }
      offCtx.closePath();
      offCtx.fill();
      const imgData = offCtx.getImageData(0, 0, width, height);
      for (let i = 0; i < width * height; i++) {
        mask[i] = imgData.data[i * 4 + 3];
      }
    }
  }

  return mask;
}

/**
 * Felzenszwalb-Huttenlocher 1D squared Euclidean Distance Transform.
 */
function edt1D(
  f: Float64Array,
  n: number,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -1e12;
  z[1] = 1e12;

  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = 1e12;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) {
      k++;
    }
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/**
 * Computes 2D squared Euclidean Distance Transform in O(W * H) linear time.
 */
function computeEuclideanDistanceTransformSquared(
  mask: Uint8Array,
  width: number,
  height: number,
  isFeature: (val: number, x: number, y: number) => boolean
): Float64Array {
  const INF = 1e11;
  const distSq = new Float64Array(width * height);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      distSq[row + x] = isFeature(mask[row + x], x, y) ? 0 : INF;
    }
  }

  const maxDim = Math.max(width, height);
  const f = new Float64Array(maxDim);
  const d = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);

  // Column pass
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      f[y] = distSq[y * width + x];
    }
    edt1D(f, height, d, v, z);
    for (let y = 0; y < height; y++) {
      distSq[y * width + x] = d[y];
    }
  }

  // Row pass
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      f[x] = distSq[rowOffset + x];
    }
    edt1D(f, width, d, v, z);
    for (let x = 0; x < width; x++) {
      distSq[rowOffset + x] = d[x];
    }
  }

  return distSq;
}

/**
 * Binary morphological dilation using separable Euclidean distance transform.
 */
export function expandSelection(
  mask: Uint8Array,
  width: number,
  height: number,
  pixels: number
): Uint8Array {
  if (pixels <= 0) return new Uint8Array(mask);

  // Feature points are pixels inside the selection (mask >= 128)
  const distSq = computeEuclideanDistanceTransformSquared(
    mask,
    width,
    height,
    (val) => val >= 128
  );

  const radiusSq = pixels * pixels;
  const out = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i++) {
    out[i] = distSq[i] <= radiusSq ? 255 : 0;
  }

  return out;
}

/**
 * Binary morphological erosion using separable Euclidean distance transform.
 */
export function contractSelection(
  mask: Uint8Array,
  width: number,
  height: number,
  pixels: number
): Uint8Array {
  if (pixels <= 0) return new Uint8Array(mask);

  // Feature points are pixels outside the selection OR outside canvas boundaries
  const distSq = computeEuclideanDistanceTransformSquared(
    mask,
    width,
    height,
    (val, x, y) => val < 128 || x === 0 || y === 0 || x === width - 1 || y === height - 1
  );

  const radiusSq = pixels * pixels;
  const out = new Uint8Array(width * height);

  for (let i = 0; i < width * height; i++) {
    out[i] = distSq[i] > radiusSq && mask[i] >= 128 ? 255 : 0;
  }

  return out;
}

/**
 * Separable Gaussian blur over the selection mask.
 */
export function featherSelection(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  if (radius <= 0) return new Uint8Array(mask);

  const sigma = Math.max(0.5, radius / 2);
  const kRadius = Math.ceil(sigma * 2.5);
  const kSize = kRadius * 2 + 1;
  const kernel = new Float32Array(kSize);
  let sum = 0;
  for (let i = -kRadius; i <= kRadius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + kRadius] = w;
    sum += w;
  }
  for (let i = 0; i < kSize; i++) {
    kernel[i] /= sum;
  }

  const temp = new Float32Array(width * height);
  const out = new Uint8Array(width * height);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -kRadius; k <= kRadius; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        acc += mask[rowOffset + sx] * kernel[k + kRadius];
      }
      temp[rowOffset + x] = acc;
    }
  }

  // Vertical pass
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let acc = 0;
      for (let k = -kRadius; k <= kRadius; k++) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        acc += temp[sy * width + x] * kernel[k + kRadius];
      }
      out[y * width + x] = Math.round(Math.min(255, Math.max(0, acc)));
    }
  }

  return out;
}

/**
 * Inverts the selection mask buffer.
 */
export function invertSelection(
  mask: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    out[i] = 255 - mask[i];
  }
  return out;
}

/**
 * Magic Wand flood selection on an 8-bit selection mask buffer.
 * Supports tolerance, contiguous scanline fill, anti-alias boundary smoothing.
 */
export function floodSelectWand(
  sourceData: ImageData | Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  settings: WandSettings
): {
  mask: Uint8Array;
  bounds: { x: number; y: number; width: number; height: number };
} {
  const rawData = 'data' in sourceData ? sourceData.data : sourceData;
  const mask = new Uint8Array(width * height);

  if (startX < 0 || startX >= width || startY < 0 || startY >= height) {
    return { mask, bounds: { x: 0, y: 0, width: 0, height: 0 } };
  }

  const seedOffset = (startY * width + startX) * 4;
  const sR = rawData[seedOffset];
  const sG = rawData[seedOffset + 1];
  const sB = rawData[seedOffset + 2];
  const sA = rawData[seedOffset + 3];

  const tolerance = settings.tolerance;

  // Calculates color distance normalized to [0, 255]
  const colorDiff = (x: number, y: number): number => {
    const idx = (y * width + x) * 4;
    const r = rawData[idx];
    const g = rawData[idx + 1];
    const b = rawData[idx + 2];
    const a = rawData[idx + 3];

    if (a === 0 && sA === 0) return 0;

    const dr = r - sR;
    const dg = g - sG;
    const db = b - sB;
    const da = a - sA;

    return Math.sqrt(dr * dr + dg * dg + db * db + da * da) / 2;
  };

  const matches = (x: number, y: number): boolean => {
    return colorDiff(x, y) <= tolerance;
  };

  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  const markPixel = (x: number, y: number) => {
    mask[y * width + x] = 255;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  if (!settings.contiguous) {
    // Non-contiguous: sample everywhere on canvas matching seed color
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (matches(x, y)) {
          markPixel(x, y);
        }
      }
    }
  } else {
    // Contiguous: optimized scanline flood fill
    const stack: number[] = [startX, startY];

    while (stack.length > 0) {
      const cy = stack.pop()!;
      const cx = stack.pop()!;

      if (mask[cy * width + cx] !== 0 || !matches(cx, cy)) {
        continue;
      }

      // Scan left
      let left = cx;
      while (left > 0 && mask[cy * width + (left - 1)] === 0 && matches(left - 1, cy)) {
        left--;
      }

      // Scan right
      let right = cx;
      while (right < width - 1 && mask[cy * width + (right + 1)] === 0 && matches(right + 1, cy)) {
        right++;
      }

      // Fill scanline interval
      for (let x = left; x <= right; x++) {
        markPixel(x, cy);
      }

      // Inspect scanline above and below
      const checkScanline = (ny: number) => {
        if (ny < 0 || ny >= height) return;
        let inRun = false;
        for (let x = left; x <= right; x++) {
          if (mask[ny * width + x] === 0 && matches(x, ny)) {
            if (!inRun) {
              stack.push(x, ny);
              inRun = true;
            }
          } else {
            inRun = false;
          }
        }
      };

      checkScanline(cy - 1);
      checkScanline(cy + 1);
    }
  }

  // Anti-alias edge softening if enabled
  if (settings.antiAlias && maxX >= minX && maxY >= minY) {
    const featherBuffer = featherSelection(mask, width, height, 1);
    for (let y = Math.max(0, minY - 1); y <= Math.min(height - 1, maxY + 1); y++) {
      const row = y * width;
      for (let x = Math.max(0, minX - 1); x <= Math.min(width - 1, maxX + 1); x++) {
        if (mask[row + x] === 0 && featherBuffer[row + x] > 0) {
          const diff = colorDiff(x, y);
          if (diff <= tolerance + 4) {
            mask[row + x] = featherBuffer[row + x];
          }
        }
      }
    }
  }

  const bounds =
    maxX >= minX && maxY >= minY
      ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : { x: 0, y: 0, width: 0, height: 0 };

  return { mask, bounds };
}

/**
 * Traces the boundary contour of an 8-bit selection mask into an optimized SVG path.
 * Collapses collinear segments for peak rendering performance.
 */
export function maskToSvgPath(
  mask: Uint8Array,
  width: number,
  height: number,
  threshold = 128
): string {
  if (width <= 0 || height <= 0) return '';

  // Edge encoding: horizontal edges (HE) and vertical edges (VE)
  // Vertex coordinates (x, y) range from [0, width] x [0, height].
  // Directed edges ensuring the inside of the selection is always on the right:
  // - Top of cell (x, y): from (x+1, y) to (x, y)
  // - Bottom of cell (x, y): from (x, y+1) to (x+1, y+1)
  // - Left of cell (x, y): from (x, y) to (x, y+1)
  // - Right of cell (x, y): from (x+1, y+1) to (x+1, y)

  const isInside = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return mask[y * width + x] >= threshold;
  };

  const vertexKey = (x: number, y: number): number => y * (width + 1) + x;
  const keyToVertex = (k: number): { x: number; y: number } => ({
    x: k % (width + 1),
    y: Math.floor(k / (width + 1)),
  });

  // Outgoing edge list: Map from start vertex key to array of end vertex keys
  const adj = new Map<number, number[]>();

  const addEdge = (x1: number, y1: number, x2: number, y2: number) => {
    const k1 = vertexKey(x1, y1);
    const k2 = vertexKey(x2, y2);
    const list = adj.get(k1);
    if (!list) {
      adj.set(k1, [k2]);
    } else {
      list.push(k2);
    }
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inCurrent = isInside(x, y);

      // Top edge
      if (inCurrent !== isInside(x, y - 1)) {
        if (inCurrent) {
          addEdge(x + 1, y, x, y);
        } else {
          addEdge(x, y, x + 1, y);
        }
      }

      // Left edge
      if (inCurrent !== isInside(x - 1, y)) {
        if (inCurrent) {
          addEdge(x, y, x, y + 1);
        } else {
          addEdge(x, y + 1, x, y);
        }
      }

      // Bottom edge (only needed at border y === height - 1)
      if (y === height - 1 && inCurrent) {
        addEdge(x, y + 1, x + 1, y + 1);
      }

      // Right edge (only needed at border x === width - 1)
      if (x === width - 1 && inCurrent) {
        addEdge(x + 1, y + 1, x + 1, y);
      }
    }
  }

  if (adj.size === 0) return '';

  let pathD = '';

  // Trace closed loops
  for (const [startK] of adj) {
    while (true) {
      const outEdges = adj.get(startK);
      if (!outEdges || outEdges.length === 0) break;

      const nextK = outEdges.pop()!;
      if (outEdges.length === 0) adj.delete(startK);

      const loop: Array<{ x: number; y: number }> = [
        keyToVertex(startK),
        keyToVertex(nextK),
      ];

      let currK = nextK;
      while (currK !== startK) {
        const nextList = adj.get(currK);
        if (!nextList || nextList.length === 0) break;
        const nk = nextList.pop()!;
        if (nextList.length === 0) adj.delete(currK);
        loop.push(keyToVertex(nk));
        currK = nk;
      }

      if (loop.length < 3) continue;

      // Collinear segment reduction
      const simplified: Array<{ x: number; y: number }> = [loop[0]];
      for (let i = 1; i < loop.length; i++) {
        const prev = simplified[simplified.length - 1];
        const curr = loop[i];
        const next = loop[(i + 1) % loop.length];

        const dx1 = curr.x - prev.x;
        const dy1 = curr.y - prev.y;
        const dx2 = next.x - curr.x;
        const dy2 = next.y - curr.y;

        // Check if current point is strictly collinear between prev and next
        if (dx1 * dy2 === dy1 * dx2 && Math.sign(dx1) === Math.sign(dx2) && Math.sign(dy1) === Math.sign(dy2)) {
          continue;
        }
        simplified.push(curr);
      }

      if (simplified.length < 3) continue;

      let subPath = `M ${simplified[0].x} ${simplified[0].y} `;
      for (let i = 1; i < simplified.length; i++) {
        subPath += `L ${simplified[i].x} ${simplified[i].y} `;
      }
      subPath += 'Z ';
      pathD += subPath;
    }
  }

  return pathD.trim();
}

/**
 * Computes tight bounding box of all non-transparent pixels on a canvas.
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

  // 1. Snapshot entire targetCanvas synchronously for undo/cancel
  const beforeImageData = targetCtx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);

  // 2. Extract selection rectangle pixels directly
  const extractedImageData = targetCtx.getImageData(b.x, b.y, b.width, b.height);

  const floatingCanvas = document.createElement('canvas');
  floatingCanvas.width = b.width;
  floatingCanvas.height = b.height;
  const floatCtx = floatingCanvas.getContext('2d');
  if (!floatCtx) {
    return null;
  }

  floatCtx.putImageData(extractedImageData, 0, 0);

  // 3. Mask floating canvas
  if (selection.mask && selection.maskWidth && selection.maskHeight) {
    const maskSub = document.createElement('canvas');
    maskSub.width = b.width;
    maskSub.height = b.height;
    const mCtx = maskSub.getContext('2d');
    if (mCtx) {
      const mImg = mCtx.createImageData(b.width, b.height);
      const mw = selection.maskWidth;
      for (let y = 0; y < b.height; y++) {
        const srcRow = (b.y + y) * mw;
        const dstRow = y * b.width * 4;
        for (let x = 0; x < b.width; x++) {
          const val = selection.mask[srcRow + (b.x + x)] ?? 0;
          mImg.data[dstRow + x * 4] = 255;
          mImg.data[dstRow + x * 4 + 1] = 255;
          mImg.data[dstRow + x * 4 + 2] = 255;
          mImg.data[dstRow + x * 4 + 3] = val;
        }
      }
      mCtx.putImageData(mImg, 0, 0);
      floatCtx.save();
      floatCtx.globalCompositeOperation = 'destination-in';
      floatCtx.drawImage(maskSub, 0, 0);
      floatCtx.restore();
    }
  } else if (selection.type === 'lasso' && selection.polygon && selection.polygon.length >= 3) {
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

  // 4. Erase selected area from base layer
  const eraseFromContext = (ctx: CanvasRenderingContext2D) => {
    ctx.save();
    if (selection.mask && selection.maskWidth && selection.maskHeight) {
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = targetCanvas.width;
      maskCanvas.height = targetCanvas.height;
      const mCtx = maskCanvas.getContext('2d');
      if (mCtx) {
        const mImg = mCtx.createImageData(targetCanvas.width, targetCanvas.height);
        for (let i = 0; i < selection.mask.length; i++) {
          mImg.data[i * 4] = 0;
          mImg.data[i * 4 + 1] = 0;
          mImg.data[i * 4 + 2] = 0;
          mImg.data[i * 4 + 3] = selection.mask[i];
        }
        mCtx.putImageData(mImg, 0, 0);
        if (isBackground) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(b.x, b.y, b.width, b.height);
        } else {
          ctx.globalCompositeOperation = 'destination-out';
          ctx.drawImage(maskCanvas, 0, 0);
        }
      }
    } else if (isBackground) {
      ctx.fillStyle = '#ffffff';
      if (selection.type === 'rect') {
        ctx.fillRect(b.x, b.y, b.width, b.height);
      } else if (selection.type === 'lasso' && selection.polygon) {
        ctx.beginPath();
        const poly = selection.polygon;
        ctx.moveTo(poly[0].x, poly[0].y);
        for (let i = 1; i < poly.length; i++) {
          ctx.lineTo(poly[i].x, poly[i].y);
        }
        ctx.closePath();
        ctx.fill();
      }
    } else {
      if (selection.type === 'rect') {
        ctx.clearRect(b.x, b.y, b.width, b.height);
      } else if (selection.type === 'lasso' && selection.polygon) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(0, 0, 0, 1)';
        ctx.beginPath();
        const poly = selection.polygon;
        ctx.moveTo(poly[0].x, poly[0].y);
        for (let i = 1; i < poly.length; i++) {
          ctx.lineTo(poly[i].x, poly[i].y);
        }
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  };

  eraseFromContext(targetCtx);

  if (sourceCanvas) {
    const sCtx = sourceCanvas.getContext('2d');
    if (sCtx) eraseFromContext(sCtx);
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
