import { CanvasDimensions, CanvasSelection, DirtyRect, LayerItem, TileDelta, WandSettings } from '../types/editor';
import {
  BYTES_1BIT,
  BYTES_8BIT,
  BYTES_32BIT,
  SparseTileGrid,
  TILE_SIZE,
  TileFormat,
  TileSnapshotEntry,
  getTileKey,
  packRGBATo1Bit,
  packRGBATo8Bit,
  pixelToTileCoord,
  releaseTemporaryCanvas,
} from './tileEngine';
import { buildCompositedReferenceTile, parseColorToRgba } from './floodFill';

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
  if (selection.mask && selection.maskWidth && selection.maskHeight) {
    if (selection.maskWidth === width && selection.maskHeight === height) {
      return new Uint8Array(selection.mask);
    }
    const resized = new Uint8Array(width * height);
    const mw = selection.maskWidth;
    const mh = selection.maskHeight;
    const copyW = Math.min(mw, width);
    const copyH = Math.min(mh, height);
    for (let y = 0; y < copyH; y++) {
      const sRow = y * mw;
      const dRow = y * width;
      for (let x = 0; x < copyW; x++) {
        resized[dRow + x] = selection.mask[sRow + x];
      }
    }
    return resized;
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
    const b = selection.bounds;
    const x0 = Math.max(0, Math.floor(b.x));
    const y0 = Math.max(0, Math.floor(b.y));
    const x1 = Math.min(width, Math.ceil(b.x + b.width));
    const y1 = Math.min(height, Math.ceil(b.y + b.height));
    if (x1 > x0 && y1 > y0) {
      const offCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
      const offCtx = offCanvas ? offCanvas.getContext('2d', { willReadFrequently: true }) : null;
      if (offCanvas && offCtx) {
        const CHUNK = 1024;
        try {
          for (let cy = y0; cy < y1; cy += CHUNK) {
            const ch = Math.min(CHUNK, y1 - cy);
            for (let cx = x0; cx < x1; cx += CHUNK) {
              const cw = Math.min(CHUNK, x1 - cx);
              if (offCanvas.width !== cw) offCanvas.width = cw;
              if (offCanvas.height !== ch) offCanvas.height = ch;
              offCtx.clearRect(0, 0, cw, ch);
              offCtx.save();
              offCtx.translate(-cx, -cy);
              offCtx.fillStyle = '#ffffff';
              offCtx.beginPath();
              offCtx.moveTo(selection.polygon[0].x, selection.polygon[0].y);
              for (let i = 1; i < selection.polygon.length; i++) {
                offCtx.lineTo(selection.polygon[i].x, selection.polygon[i].y);
              }
              offCtx.closePath();
              offCtx.fill();
              offCtx.restore();
              const imgData = offCtx.getImageData(0, 0, cw, ch);
              for (let ly = 0; ly < ch; ly++) {
                const dRow = (cy + ly) * width + cx;
                const sRow = ly * cw * 4;
                for (let lx = 0; lx < cw; lx++) {
                  mask[dRow + lx] = imgData.data[sRow + lx * 4 + 3];
                }
              }
            }
          }
        } finally {
          releaseTemporaryCanvas(offCanvas);
        }
      } else {
        const poly = selection.polygon;
        for (let y = y0; y < y1; y++) {
          const row = y * width;
          const py = y + 0.5;
          for (let x = x0; x < x1; x++) {
            if (isPointInPolygon(x + 0.5, py, poly)) {
              mask[row + x] = 255;
            }
          }
        }
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
  bounds: { x: number; y: number; width: number; height: number };
} | null {
  const rawBounds = selection.bounds;
  if (!rawBounds || rawBounds.width <= 0 || rawBounds.height <= 0) {
    return null;
  }

  const cw = targetCanvas.width;
  const ch = targetCanvas.height;
  if (cw <= 0 || ch <= 0) {
    return null;
  }

  // Clamp bounds to canvas integer pixel rect to prevent out-of-bounds mask wrap & offset drift
  const bx = Math.max(0, Math.floor(rawBounds.x));
  const by = Math.max(0, Math.floor(rawBounds.y));
  const bx1 = Math.min(cw, Math.ceil(rawBounds.x + rawBounds.width));
  const by1 = Math.min(ch, Math.ceil(rawBounds.y + rawBounds.height));
  const bw = bx1 - bx;
  const bh = by1 - by;
  if (bw <= 0 || bh <= 0) {
    return null;
  }
  const b = { x: bx, y: by, width: bw, height: bh };

  const targetCtx = targetCanvas.getContext('2d');
  if (!targetCtx) {
    return null;
  }

  // 1. Snapshot entire targetCanvas synchronously for undo/cancel
  const beforeImageData = targetCtx.getImageData(0, 0, cw, ch);

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

  // Build sub-mask once if selection has an alpha mask (reused for both extraction & erase)
  let maskSub: HTMLCanvasElement | null = null;
  if (selection.mask && selection.maskWidth && selection.maskHeight) {
    maskSub = document.createElement('canvas');
    maskSub.width = b.width;
    maskSub.height = b.height;
    const mCtx = maskSub.getContext('2d');
    if (mCtx) {
      const mImg = mCtx.createImageData(b.width, b.height);
      const mw = selection.maskWidth;
      const mh = selection.maskHeight;
      const fillRgb = isBackground ? 255 : 0;
      for (let y = 0; y < b.height; y++) {
        const sy = b.y + y;
        const dstRow = y * b.width * 4;
        if (sy < 0 || sy >= mh) continue;
        const srcRow = sy * mw;
        for (let x = 0; x < b.width; x++) {
          const sx = b.x + x;
          const val = sx >= 0 && sx < mw ? (selection.mask[srcRow + sx] ?? 0) : 0;
          const off = dstRow + x * 4;
          mImg.data[off] = fillRgb;
          mImg.data[off + 1] = fillRgb;
          mImg.data[off + 2] = fillRgb;
          mImg.data[off + 3] = val;
        }
      }
      mCtx.putImageData(mImg, 0, 0);
      floatCtx.save();
      floatCtx.globalCompositeOperation = 'destination-in';
      floatCtx.drawImage(maskSub, 0, 0);
      floatCtx.restore();
    } else {
      maskSub = null;
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

  // 4. Erase selected area from base layer using identity transform to match getImageData coords
  const eraseFromContext = (ctx: CanvasRenderingContext2D) => {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (maskSub) {
      ctx.globalCompositeOperation = isBackground ? 'source-over' : 'destination-out';
      ctx.drawImage(maskSub, b.x, b.y);
    } else if (isBackground) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#ffffff';
      if (selection.type === 'lasso' && selection.polygon && selection.polygon.length >= 3) {
        ctx.beginPath();
        const poly = selection.polygon;
        ctx.moveTo(poly[0].x, poly[0].y);
        for (let i = 1; i < poly.length; i++) {
          ctx.lineTo(poly[i].x, poly[i].y);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(b.x, b.y, b.width, b.height);
      }
    } else if (selection.type === 'lasso' && selection.polygon && selection.polygon.length >= 3) {
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
    } else {
      ctx.clearRect(b.x, b.y, b.width, b.height);
    }
    ctx.restore();
  };

  eraseFromContext(targetCtx);

  if (sourceCanvas) {
    const sCtx = sourceCanvas.getContext('2d');
    if (sCtx) eraseFromContext(sCtx);
  }

  return { floatingCanvas, beforeImageData, bounds: b };
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

/**
 * Tile-native Magic Wand selection directly from SparseTileGrid (zero full-canvas materialization).
 */
export function floodSelectWandOnTileGrid(params: {
  grid: SparseTileGrid;
  layers: LayerItem[];
  activeLayerId: string;
  dimensions: CanvasDimensions;
  startX: number;
  startY: number;
  settings: WandSettings;
}): {
  mask: Uint8Array;
  bounds: { x: number; y: number; width: number; height: number };
} {
  const { grid, layers, activeLayerId, dimensions, startX, startY, settings } = params;
  const width = dimensions.width;
  const height = dimensions.height;
  const mask = new Uint8Array(width * height);
  if (startX < 0 || startX >= width || startY < 0 || startY >= height) {
    return { mask, bounds: { x: 0, y: 0, width: 0, height: 0 } };
  }

  let refLayers: LayerItem[] | null = null;
  let singleLayerId = activeLayerId;
  if (settings.referMode === 'all') {
    refLayers = layers.filter((l) => l.visible && l.type !== 'folder' && l.type !== 'frame-folder');
  } else if (settings.referMode === 'reference') {
    const refLayer = layers.find((l) => l.isReference && l.visible);
    singleLayerId = refLayer ? refLayer.id : activeLayerId;
  }

  const refTileCache = new Map<number, Uint8ClampedArray | null>();
  const getRefTile = (tx: number, ty: number): Uint8ClampedArray | null => {
    const key = (ty + 32768) * 65536 + (tx + 32768);
    let cached = refTileCache.get(key);
    if (cached !== undefined) return cached;
    if (refLayers) {
      cached = buildCompositedReferenceTile(grid, refLayers, tx, ty);
    } else {
      const tile = grid.getTile(singleLayerId, tx, ty, 0);
      cached = tile && tile.data ? new Uint8ClampedArray(grid.getTileAsRGBA(tile)) : null;
    }
    refTileCache.set(key, cached);
    return cached;
  };

  const sampleRgba = (x: number, y: number, out: [number, number, number, number]) => {
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

  const seed: [number, number, number, number] = [0, 0, 0, 0];
  sampleRgba(startX, startY, seed);
  const [sR, sG, sB, sA] = seed;
  const tolerance = settings.tolerance;
  const tmp: [number, number, number, number] = [0, 0, 0, 0];

  const colorDiff = (x: number, y: number): number => {
    sampleRgba(x, y, tmp);
    if (tmp[3] === 0 && sA === 0) return 0;
    const dr = tmp[0] - sR;
    const dg = tmp[1] - sG;
    const db = tmp[2] - sB;
    const da = tmp[3] - sA;
    return Math.sqrt(dr * dr + dg * dg + db * db + da * da) / 2;
  };

  const matches = (x: number, y: number): boolean => colorDiff(x, y) <= tolerance;

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
    const maxTx = pixelToTileCoord(width - 1, 0);
    const maxTy = pixelToTileCoord(height - 1, 0);
    for (let ty = 0; ty <= maxTy; ty++) {
      const y0 = ty * TILE_SIZE;
      const y1 = Math.min(height, y0 + TILE_SIZE);
      for (let tx = 0; tx <= maxTx; tx++) {
        const x0 = tx * TILE_SIZE;
        const x1 = Math.min(width, x0 + TILE_SIZE);
        const tile = getRefTile(tx, ty);
        if (!tile) {
          if (sA === 0 || Math.sqrt(sR * sR + sG * sG + sB * sB + sA * sA) / 2 <= tolerance) {
            for (let y = y0; y < y1; y++) {
              mask.fill(255, y * width + x0, y * width + x1);
            }
            if (x0 < minX) minX = x0;
            if (x1 - 1 > maxX) maxX = x1 - 1;
            if (y0 < minY) minY = y0;
            if (y1 - 1 > maxY) maxY = y1 - 1;
          }
          continue;
        }
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            if (matches(x, y)) markPixel(x, y);
          }
        }
      }
    }
  } else {
    const stack: number[] = [startX, startY];
    while (stack.length > 0) {
      const cy = stack.pop()!;
      const cx = stack.pop()!;
      if (mask[cy * width + cx] !== 0 || !matches(cx, cy)) continue;

      let left = cx;
      while (left > 0 && mask[cy * width + (left - 1)] === 0 && matches(left - 1, cy)) left--;
      let right = cx;
      while (right < width - 1 && mask[cy * width + (right + 1)] === 0 && matches(right + 1, cy)) right++;

      for (let x = left; x <= right; x++) markPixel(x, cy);

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

  if (settings.antiAlias && maxX >= minX && maxY >= minY) {
    const featherBuffer = featherSelection(mask, width, height, 1);
    for (let y = Math.max(0, minY - 1); y <= Math.min(height - 1, maxY + 1); y++) {
      const row = y * width;
      for (let x = Math.max(0, minX - 1); x <= Math.min(width - 1, maxX + 1); x++) {
        if (mask[row + x] === 0 && featherBuffer[row + x] > 0) {
          if (colorDiff(x, y) <= tolerance + 4) {
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
 * Tile-native clear selection: erases (or fills white on bg) strictly within selection bounds.
 */
export function clearSelectionInTileGrid(params: {
  grid: SparseTileGrid;
  layerId: string;
  dimensions: CanvasDimensions;
  selection: CanvasSelection;
  isBackground: boolean;
  targetFormat: TileFormat;
  snapshotOut?: Map<string, TileSnapshotEntry>;
}): { dirtyRect: DirtyRect | null; tileDeltas: TileDelta[] } {
  const { grid, layerId, dimensions, selection, isBackground, targetFormat } = params;
  const raw = selection.bounds;
  if (!raw || raw.width <= 0 || raw.height <= 0) return { dirtyRect: null, tileDeltas: [] };

  const bx = Math.max(0, Math.floor(raw.x));
  const by = Math.max(0, Math.floor(raw.y));
  const bx1 = Math.min(dimensions.width, Math.ceil(raw.x + raw.width));
  const by1 = Math.min(dimensions.height, Math.ceil(raw.y + raw.height));
  const bw = bx1 - bx;
  const bh = by1 - by;
  if (bw <= 0 || bh <= 0) return { dirtyRect: null, tileDeltas: [] };

  const dirtyRect: DirtyRect = { x: bx, y: by, width: bw, height: bh };
  const beforeSnapshot = params.snapshotOut ?? new Map<string, TileSnapshotEntry>();

  // Fast rect path with zero mask/polygon overhead
  const hasMask = Boolean(selection.mask && selection.maskWidth && selection.maskHeight);
  const hasLasso =
    selection.type === 'lasso' && Boolean(selection.polygon && selection.polygon.length >= 3);
  if (!hasMask && !hasLasso) {
    grid.clearRectInLayer(layerId, dirtyRect, isBackground, beforeSnapshot, true);
    const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, layerId, dirtyRect);
    grid.notifyChange(true);
    return { dirtyRect, tileDeltas };
  }

  // Mask or lasso path: chunked 512x512 compositing directly onto tiles
  const CHUNK = 512;
  const maskCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const mCtx = maskCanvas ? maskCanvas.getContext('2d', { willReadFrequently: true }) : null;

  try {
    for (let cy = by; cy < by1; cy += CHUNK) {
      const ch = Math.min(CHUNK, by1 - cy);
      for (let cx = bx; cx < bx1; cx += CHUNK) {
        const cw = Math.min(CHUNK, bx1 - cx);
        let chunkAlpha: Uint8ClampedArray;

        if (selection.mask && selection.maskWidth && selection.maskHeight) {
          chunkAlpha = new Uint8ClampedArray(cw * ch * 4);
          const mw = selection.maskWidth;
          const mh = selection.maskHeight;
          const rgb = isBackground ? 255 : 0;
          for (let ly = 0; ly < ch; ly++) {
            const gy = cy + ly;
            if (gy < 0 || gy >= mh) continue;
            const mRow = gy * mw;
            const dRow = ly * cw * 4;
            for (let lx = 0; lx < cw; lx++) {
              const gx = cx + lx;
              const a = gx >= 0 && gx < mw ? selection.mask[mRow + gx] : 0;
              if (a > 0) {
                const off = dRow + lx * 4;
                chunkAlpha[off] = rgb;
                chunkAlpha[off + 1] = rgb;
                chunkAlpha[off + 2] = rgb;
                chunkAlpha[off + 3] = a;
              }
            }
          }
        } else if (selection.type === 'lasso' && selection.polygon && selection.polygon.length >= 3) {
          if (maskCanvas && mCtx) {
            if (maskCanvas.width !== cw) maskCanvas.width = cw;
            if (maskCanvas.height !== ch) maskCanvas.height = ch;
            mCtx.clearRect(0, 0, cw, ch);
            mCtx.save();
            mCtx.translate(-cx, -cy);
            mCtx.fillStyle = isBackground ? '#ffffff' : '#000000';
            mCtx.beginPath();
            mCtx.moveTo(selection.polygon[0].x, selection.polygon[0].y);
            for (let i = 1; i < selection.polygon.length; i++) {
              mCtx.lineTo(selection.polygon[i].x, selection.polygon[i].y);
            }
            mCtx.closePath();
            mCtx.fill();
            mCtx.restore();
            chunkAlpha = mCtx.getImageData(0, 0, cw, ch).data;
          } else {
            chunkAlpha = new Uint8ClampedArray(cw * ch * 4);
            const rgb = isBackground ? 255 : 0;
            const poly = selection.polygon;
            for (let ly = 0; ly < ch; ly++) {
              const gy = cy + ly + 0.5;
              const dRow = ly * cw * 4;
              for (let lx = 0; lx < cw; lx++) {
                if (isPointInPolygon(cx + lx + 0.5, gy, poly)) {
                  const off = dRow + lx * 4;
                  chunkAlpha[off] = rgb;
                  chunkAlpha[off + 1] = rgb;
                  chunkAlpha[off + 2] = rgb;
                  chunkAlpha[off + 3] = 255;
                }
              }
            }
          }
        } else {
          continue;
        }

        grid.compositeStrokeToTiles({
          layerId,
          strokeData: { data: chunkAlpha, width: cw, height: ch },
          destX: cx,
          destY: cy,
          format: targetFormat,
          compositeOp: isBackground ? 'source-over' : 'destination-out',
          opacity: 1.0,
          snapshotOut: beforeSnapshot,
          suppressNotify: true,
        });
      }
    }
  } finally {
    if (maskCanvas) releaseTemporaryCanvas(maskCanvas);
  }

  if (!isBackground) {
    grid.pruneEmptyTiles(layerId);
  }
  const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, layerId, dirtyRect);
  grid.notifyChange(true);
  return { dirtyRect, tileDeltas };
}

/**
 * Tile-native fill selection with solid color (zero full-canvas allocation).
 */
export function fillSelectionInTileGrid(params: {
  grid: SparseTileGrid;
  layerId: string;
  dimensions: CanvasDimensions;
  selection: CanvasSelection;
  colorCss: string;
  targetFormat: TileFormat;
  alphaLocked?: boolean;
}): { dirtyRect: DirtyRect | null; tileDeltas: TileDelta[] } {
  const { grid, layerId, dimensions, selection, colorCss, targetFormat, alphaLocked = false } = params;
  const raw = selection.bounds;
  if (!raw || raw.width <= 0 || raw.height <= 0) return { dirtyRect: null, tileDeltas: [] };

  const bx = Math.max(0, Math.floor(raw.x));
  const by = Math.max(0, Math.floor(raw.y));
  const bx1 = Math.min(dimensions.width, Math.ceil(raw.x + raw.width));
  const by1 = Math.min(dimensions.height, Math.ceil(raw.y + raw.height));
  const bw = bx1 - bx;
  const bh = by1 - by;
  if (bw <= 0 || bh <= 0) return { dirtyRect: null, tileDeltas: [] };

  const dirtyRect: DirtyRect = { x: bx, y: by, width: bw, height: bh };
  const [r, g, b, a] = parseColorToRgba(colorCss);
  const beforeSnapshot = new Map<string, TileSnapshotEntry>();
  const CHUNK = 512;
  const polyCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const pCtx = polyCanvas ? polyCanvas.getContext('2d', { willReadFrequently: true }) : null;

  try {
    for (let cy = by; cy < by1; cy += CHUNK) {
      const ch = Math.min(CHUNK, by1 - cy);
      for (let cx = bx; cx < bx1; cx += CHUNK) {
        const cw = Math.min(CHUNK, bx1 - cx);
        let chunkData: Uint8ClampedArray;

        if (selection.mask && selection.maskWidth && selection.maskHeight) {
          chunkData = new Uint8ClampedArray(cw * ch * 4);
          const mw = selection.maskWidth;
          const mh = selection.maskHeight;
          for (let ly = 0; ly < ch; ly++) {
            const gy = cy + ly;
            if (gy < 0 || gy >= mh) continue;
            const mRow = gy * mw;
            const dRow = ly * cw * 4;
            for (let lx = 0; lx < cw; lx++) {
              const gx = cx + lx;
              const ma = gx >= 0 && gx < mw ? selection.mask[mRow + gx] : 0;
              if (ma > 0) {
                const off = dRow + lx * 4;
                chunkData[off] = r;
                chunkData[off + 1] = g;
                chunkData[off + 2] = b;
                chunkData[off + 3] = Math.round((a * ma) / 255);
              }
            }
          }
        } else if (selection.type === 'lasso' && selection.polygon && selection.polygon.length >= 3) {
          if (polyCanvas && pCtx) {
            if (polyCanvas.width !== cw) polyCanvas.width = cw;
            if (polyCanvas.height !== ch) polyCanvas.height = ch;
            pCtx.clearRect(0, 0, cw, ch);
            pCtx.save();
            pCtx.translate(-cx, -cy);
            pCtx.fillStyle = colorCss;
            pCtx.beginPath();
            pCtx.moveTo(selection.polygon[0].x, selection.polygon[0].y);
            for (let i = 1; i < selection.polygon.length; i++) {
              pCtx.lineTo(selection.polygon[i].x, selection.polygon[i].y);
            }
            pCtx.closePath();
            pCtx.fill();
            pCtx.restore();
            chunkData = pCtx.getImageData(0, 0, cw, ch).data;
          } else {
            chunkData = new Uint8ClampedArray(cw * ch * 4);
            const poly = selection.polygon;
            for (let ly = 0; ly < ch; ly++) {
              const gy = cy + ly + 0.5;
              const dRow = ly * cw * 4;
              for (let lx = 0; lx < cw; lx++) {
                if (isPointInPolygon(cx + lx + 0.5, gy, poly)) {
                  const off = dRow + lx * 4;
                  chunkData[off] = r;
                  chunkData[off + 1] = g;
                  chunkData[off + 2] = b;
                  chunkData[off + 3] = a;
                }
              }
            }
          }
        } else {
          // Solid rect fill
          chunkData = new Uint8ClampedArray(cw * ch * 4);
          for (let off = 0; off < chunkData.length; off += 4) {
            chunkData[off] = r;
            chunkData[off + 1] = g;
            chunkData[off + 2] = b;
            chunkData[off + 3] = a;
          }
        }

        grid.compositeStrokeToTiles({
          layerId,
          strokeData: { data: chunkData, width: cw, height: ch },
          destX: cx,
          destY: cy,
          format: targetFormat,
          compositeOp: alphaLocked ? 'source-atop' : 'source-over',
          opacity: 1.0,
          snapshotOut: beforeSnapshot,
          suppressNotify: true,
        });
      }
    }
  } finally {
    if (polyCanvas) releaseTemporaryCanvas(polyCanvas);
  }

  const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, layerId, dirtyRect);
  grid.notifyChange(true);
  return { dirtyRect, tileDeltas };
}

/**
 * Tile-native selection lift: extracts ONLY `selection.bounds` from SparseTileGrid into a
 * tight floatingCanvas, snapshots only the affected tiles, and clears the selected pixels in tiles.
 */
export function liftSelectionFromTileGrid(params: {
  grid: SparseTileGrid;
  layerId: string;
  dimensions: CanvasDimensions;
  selection: CanvasSelection;
  isBackground: boolean;
  targetFormat: TileFormat;
}): {
  floatingCanvas: HTMLCanvasElement;
  beforeTileSnapshot: Map<string, TileSnapshotEntry>;
  bounds: DirtyRect;
} | null {
  const { grid, layerId, dimensions, selection, isBackground, targetFormat } = params;
  const raw = selection.bounds;
  if (!raw || raw.width <= 0 || raw.height <= 0 || typeof document === 'undefined') return null;

  const bx = Math.max(0, Math.floor(raw.x));
  const by = Math.max(0, Math.floor(raw.y));
  const bx1 = Math.min(dimensions.width, Math.ceil(raw.x + raw.width));
  const by1 = Math.min(dimensions.height, Math.ceil(raw.y + raw.height));
  const bw = bx1 - bx;
  const bh = by1 - by;
  if (bw <= 0 || bh <= 0) return null;

  const b: DirtyRect = { x: bx, y: by, width: bw, height: bh };

  const floatingCanvas = grid.createRegionCanvas(layerId, b);
  if (!floatingCanvas) return null;
  const floatCtx = floatingCanvas.getContext('2d', { willReadFrequently: true });
  if (!floatCtx) {
    releaseTemporaryCanvas(floatingCanvas);
    return null;
  }

  // Apply selection mask / lasso clip to extracted floatingCanvas
  if (selection.mask && selection.maskWidth && selection.maskHeight) {
    const img = floatCtx.getImageData(0, 0, bw, bh);
    const d = img.data;
    const mw = selection.maskWidth;
    const mh = selection.maskHeight;
    for (let y = 0; y < bh; y++) {
      const sy = by + y;
      const mRow = sy * mw;
      const dRow = y * bw * 4;
      for (let x = 0; x < bw; x++) {
        const sx = bx + x;
        const ma = sy >= 0 && sy < mh && sx >= 0 && sx < mw ? selection.mask[mRow + sx] : 0;
        const off = dRow + x * 4;
        if (ma === 0) {
          d[off + 3] = 0;
        } else if (ma < 255) {
          d[off + 3] = Math.round((d[off + 3] * ma) / 255);
        }
      }
    }
    floatCtx.putImageData(img, 0, 0);
  } else if (selection.type === 'lasso' && selection.polygon && selection.polygon.length >= 3) {
    floatCtx.save();
    floatCtx.globalCompositeOperation = 'destination-in';
    floatCtx.beginPath();
    const poly = selection.polygon;
    floatCtx.moveTo(poly[0].x - bx, poly[0].y - by);
    for (let i = 1; i < poly.length; i++) {
      floatCtx.lineTo(poly[i].x - bx, poly[i].y - by);
    }
    floatCtx.closePath();
    floatCtx.fill();
    floatCtx.restore();
  }

  const beforeTileSnapshot = grid.snapshotTilesInRect(layerId, b);
  clearSelectionInTileGrid({
    grid,
    layerId,
    dimensions,
    selection,
    isBackground,
    targetFormat,
    snapshotOut: beforeTileSnapshot,
  });

  return { floatingCanvas, beforeTileSnapshot, bounds: b };
}

/**
 * Tile-native commit of a floating selection canvas back onto SparseTileGrid.
 */
export function commitFloatingSelectionToTileGrid(params: {
  grid: SparseTileGrid;
  layerId: string;
  dimensions: CanvasDimensions;
  floating: NonNullable<CanvasSelection['floating']>;
  targetFormat: TileFormat;
}): { dirtyRect: DirtyRect; tileDeltas: TileDelta[] } {
  const { grid, layerId, dimensions, floating, targetFormat } = params;
  const fCtx = floating.canvas.getContext('2d', { willReadFrequently: true });
  const beforeSnapshot = new Map<string, TileSnapshotEntry>(floating.beforeTileSnapshot ?? []);

  const dx = Math.round(floating.x);
  const dy = Math.round(floating.y);
  const fw = floating.canvas.width;
  const fh = floating.canvas.height;

  const clipX0 = Math.max(0, dx);
  const clipY0 = Math.max(0, dy);
  const clipX1 = Math.min(dimensions.width, dx + fw);
  const clipY1 = Math.min(dimensions.height, dy + fh);

  if (fCtx && clipX1 > clipX0 && clipY1 > clipY0) {
    const srcX = clipX0 - dx;
    const srcY = clipY0 - dy;
    const copyW = clipX1 - clipX0;
    const copyH = clipY1 - clipY0;
    const imgData = fCtx.getImageData(srcX, srcY, copyW, copyH);
    grid.compositeStrokeToTiles({
      layerId,
      strokeData: imgData,
      destX: clipX0,
      destY: clipY0,
      format: targetFormat,
      compositeOp: 'source-over',
      opacity: 1.0,
      snapshotOut: beforeSnapshot,
      suppressNotify: true,
    });
  }

  const minX = Math.max(0, Math.min(dx, Math.round(floating.origX)));
  const minY = Math.max(0, Math.min(dy, Math.round(floating.origY)));
  const maxX = Math.min(dimensions.width, Math.max(dx + fw, Math.round(floating.origX) + fw));
  const maxY = Math.min(dimensions.height, Math.max(dy + fh, Math.round(floating.origY) + fh));
  const dirtyRect: DirtyRect = {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };

  const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, layerId, dirtyRect);
  grid.notifyChange(true);
  return { dirtyRect, tileDeltas };
}

export interface SelectionTileSnapshot {
  format: TileFormat;
  tiles: Array<{ tileX: number; tileY: number; format: TileFormat; data: Uint8Array }>;
  bounds: DirtyRect;
}

function encodeRgbaToTileData(rgba: Uint8ClampedArray, format: TileFormat): Uint8Array {
  if (format === 'monochrome-1bit') {
    const out = new Uint8Array(BYTES_1BIT);
    packRGBATo1Bit(rgba, out);
    return out;
  }
  if (format === 'grayscale-8bit') {
    const out = new Uint8Array(BYTES_8BIT);
    packRGBATo8Bit(rgba, out);
    return out;
  }
  const out = new Uint8Array(BYTES_32BIT);
  out.set(rgba);
  return out;
}

function buildTileLassoAlpha(
  polygon: Array<{ x: number; y: number }>,
  tileDocX: number,
  tileDocY: number,
  outAlpha: Uint8Array,
  scratchCanvas: HTMLCanvasElement | null,
  scratchCtx: CanvasRenderingContext2D | null
): void {
  outAlpha.fill(0);
  if (scratchCanvas && scratchCtx) {
    scratchCtx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
    scratchCtx.save();
    scratchCtx.translate(-tileDocX, -tileDocY);
    scratchCtx.fillStyle = '#ffffff';
    scratchCtx.beginPath();
    scratchCtx.moveTo(polygon[0].x, polygon[0].y);
    for (let i = 1; i < polygon.length; i++) {
      scratchCtx.lineTo(polygon[i].x, polygon[i].y);
    }
    scratchCtx.closePath();
    scratchCtx.fill();
    scratchCtx.restore();
    const img = scratchCtx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
      outAlpha[i] = img[i * 4 + 3];
    }
    return;
  }

  for (let ly = 0; ly < TILE_SIZE; ly++) {
    const gy = tileDocY + ly + 0.5;
    const row = ly * TILE_SIZE;
    for (let lx = 0; lx < TILE_SIZE; lx++) {
      if (isPointInPolygon(tileDocX + lx + 0.5, gy, polygon)) {
        outAlpha[row + lx] = 255;
      }
    }
  }
}

/**
 * Tile-native extraction of selected pixels into a sparse tile snapshot at original document coordinates.
 * Zero full-document HTMLCanvasElement allocation. Returns null if the selected region is empty.
 */
export function extractSelectionTileSnapshot(params: {
  grid: SparseTileGrid;
  layerId: string;
  dimensions: CanvasDimensions;
  selection: CanvasSelection;
  targetFormat?: TileFormat;
}): SelectionTileSnapshot | null {
  const { grid, layerId, dimensions, selection } = params;
  const format = params.targetFormat ?? grid.getLayerFormat(layerId);

  if (selection.floating) {
    const { canvas, x, y } = selection.floating;
    const fCtx = canvas.getContext('2d', { willReadFrequently: true });
    if (!fCtx) return null;

    const dx = Math.round(x);
    const dy = Math.round(y);
    const clipX0 = Math.max(0, dx);
    const clipY0 = Math.max(0, dy);
    const clipX1 = Math.min(dimensions.width, dx + canvas.width);
    const clipY1 = Math.min(dimensions.height, dy + canvas.height);
    if (clipX1 <= clipX0 || clipY1 <= clipY0) return null;

    const minTx = pixelToTileCoord(clipX0, 0);
    const minTy = pixelToTileCoord(clipY0, 0);
    const maxTx = pixelToTileCoord(clipX1 - 1, 0);
    const maxTy = pixelToTileCoord(clipY1 - 1, 0);

    const tiles: SelectionTileSnapshot['tiles'] = [];
    const tileRgba = new Uint8ClampedArray(BYTES_32BIT);

    for (let ty = minTy; ty <= maxTy; ty++) {
      const tileDocY = ty * TILE_SIZE;
      const y0 = Math.max(clipY0, tileDocY);
      const y1 = Math.min(clipY1, tileDocY + TILE_SIZE);
      for (let tx = minTx; tx <= maxTx; tx++) {
        const tileDocX = tx * TILE_SIZE;
        const x0 = Math.max(clipX0, tileDocX);
        const x1 = Math.min(clipX1, tileDocX + TILE_SIZE);
        const cw = x1 - x0;
        const ch = y1 - y0;
        if (cw <= 0 || ch <= 0) continue;

        const img = fCtx.getImageData(x0 - dx, y0 - dy, cw, ch).data;
        tileRgba.fill(0);
        let hasOpaque = false;
        const dstStartX = x0 - tileDocX;
        const dstStartY = y0 - tileDocY;

        for (let row = 0; row < ch; row++) {
          const srcRow = row * cw * 4;
          const dstRow = ((dstStartY + row) * TILE_SIZE + dstStartX) * 4;
          for (let col = 0; col < cw; col++) {
            const sOff = srcRow + col * 4;
            const a = img[sOff + 3];
            if (a > 0) {
              hasOpaque = true;
              const dOff = dstRow + col * 4;
              tileRgba[dOff] = img[sOff];
              tileRgba[dOff + 1] = img[sOff + 1];
              tileRgba[dOff + 2] = img[sOff + 2];
              tileRgba[dOff + 3] = a;
            }
          }
        }

        if (hasOpaque) {
          tiles.push({
            tileX: tx,
            tileY: ty,
            format,
            data: encodeRgbaToTileData(tileRgba, format),
          });
        }
      }
    }

    if (tiles.length === 0) return null;
    return {
      format,
      tiles,
      bounds: { x: clipX0, y: clipY0, width: clipX1 - clipX0, height: clipY1 - clipY0 },
    };
  }

  const raw = selection.bounds;
  if (!raw || raw.width <= 0 || raw.height <= 0) return null;

  const bx = Math.max(0, Math.floor(raw.x));
  const by = Math.max(0, Math.floor(raw.y));
  const bx1 = Math.min(dimensions.width, Math.ceil(raw.x + raw.width));
  const by1 = Math.min(dimensions.height, Math.ceil(raw.y + raw.height));
  if (bx1 <= bx || by1 <= by) return null;

  const intersecting = grid.getTilesInBounds(layerId, bx, by, bx1 - 1, by1 - 1, 0);
  if (intersecting.length === 0) return null;

  const hasMask = Boolean(selection.mask && selection.maskWidth && selection.maskHeight);
  const hasLasso =
    !hasMask && selection.type === 'lasso' && Boolean(selection.polygon && selection.polygon.length >= 3);

  let scratchCanvas: HTMLCanvasElement | null = null;
  let scratchCtx: CanvasRenderingContext2D | null = null;
  const lassoAlpha = hasLasso ? new Uint8Array(TILE_SIZE * TILE_SIZE) : null;
  if (hasLasso && typeof document !== 'undefined') {
    scratchCanvas = document.createElement('canvas');
    scratchCanvas.width = TILE_SIZE;
    scratchCanvas.height = TILE_SIZE;
    scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
  }

  const tiles: SelectionTileSnapshot['tiles'] = [];
  const outRgba = new Uint8ClampedArray(BYTES_32BIT);

  try {
    for (const tile of intersecting) {
      if (!tile.data) continue;
      const tileDocX = tile.tileX * TILE_SIZE;
      const tileDocY = tile.tileY * TILE_SIZE;
      const x0 = Math.max(bx, tileDocX);
      const y0 = Math.max(by, tileDocY);
      const x1 = Math.min(bx1, tileDocX + TILE_SIZE);
      const y1 = Math.min(by1, tileDocY + TILE_SIZE);
      if (x1 <= x0 || y1 <= y0) continue;

      const srcRgba = grid.getTileAsRGBA(tile);
      outRgba.fill(0);
      let hasOpaque = false;

      if (hasLasso && lassoAlpha && selection.polygon) {
        buildTileLassoAlpha(selection.polygon, tileDocX, tileDocY, lassoAlpha, scratchCanvas, scratchCtx);
      }

      const lx0 = x0 - tileDocX;
      const ly0 = y0 - tileDocY;
      const lx1 = x1 - tileDocX;
      const ly1 = y1 - tileDocY;

      if (hasMask && selection.mask && selection.maskWidth && selection.maskHeight) {
        const mw = selection.maskWidth;
        const mh = selection.maskHeight;
        for (let ly = ly0; ly < ly1; ly++) {
          const gy = tileDocY + ly;
          if (gy < 0 || gy >= mh) continue;
          const mRow = gy * mw;
          const tRow = ly * TILE_SIZE;
          for (let lx = lx0; lx < lx1; lx++) {
            const gx = tileDocX + lx;
            const ma = gx >= 0 && gx < mw ? selection.mask[mRow + gx] : 0;
            if (ma === 0) continue;
            const off = (tRow + lx) * 4;
            const sa = srcRgba[off + 3];
            if (sa === 0) continue;
            const ea = ma === 255 ? sa : Math.round((sa * ma) / 255);
            if (ea === 0) continue;
            hasOpaque = true;
            outRgba[off] = srcRgba[off];
            outRgba[off + 1] = srcRgba[off + 1];
            outRgba[off + 2] = srcRgba[off + 2];
            outRgba[off + 3] = ea;
          }
        }
      } else if (hasLasso && lassoAlpha) {
        for (let ly = ly0; ly < ly1; ly++) {
          const tRow = ly * TILE_SIZE;
          for (let lx = lx0; lx < lx1; lx++) {
            const ma = lassoAlpha[tRow + lx];
            if (ma === 0) continue;
            const off = (tRow + lx) * 4;
            const sa = srcRgba[off + 3];
            if (sa === 0) continue;
            const ea = ma === 255 ? sa : Math.round((sa * ma) / 255);
            if (ea === 0) continue;
            hasOpaque = true;
            outRgba[off] = srcRgba[off];
            outRgba[off + 1] = srcRgba[off + 1];
            outRgba[off + 2] = srcRgba[off + 2];
            outRgba[off + 3] = ea;
          }
        }
      } else {
        for (let ly = ly0; ly < ly1; ly++) {
          const tRow = ly * TILE_SIZE;
          for (let lx = lx0; lx < lx1; lx++) {
            const off = (tRow + lx) * 4;
            const sa = srcRgba[off + 3];
            if (sa === 0) continue;
            hasOpaque = true;
            outRgba[off] = srcRgba[off];
            outRgba[off + 1] = srcRgba[off + 1];
            outRgba[off + 2] = srcRgba[off + 2];
            outRgba[off + 3] = sa;
          }
        }
      }

      if (hasOpaque) {
        tiles.push({
          tileX: tile.tileX,
          tileY: tile.tileY,
          format,
          data: encodeRgbaToTileData(outRgba, format),
        });
      }
    }
  } finally {
    if (scratchCanvas) releaseTemporaryCanvas(scratchCanvas);
  }

  if (tiles.length === 0) return null;
  return {
    format,
    tiles,
    bounds: { x: bx, y: by, width: bx1 - bx, height: by1 - by },
  };
}

/**
 * Tile-native Delete Outside Selection: erases (or fills white on background) every pixel
 * on `layerId` outside `selection`, leaving only the selected pixels intact.
 */
export function clearOutsideSelectionInTileGrid(params: {
  grid: SparseTileGrid;
  layerId: string;
  dimensions: CanvasDimensions;
  selection: CanvasSelection;
  isBackground: boolean;
  targetFormat: TileFormat;
  snapshotOut?: Map<string, TileSnapshotEntry>;
}): { dirtyRect: DirtyRect | null; tileDeltas: TileDelta[] } {
  const { grid, layerId, dimensions, selection, isBackground, targetFormat } = params;
  const fullRect: DirtyRect = { x: 0, y: 0, width: dimensions.width, height: dimensions.height };

  if (selection.floating) {
    const beforeSnapshot = params.snapshotOut ?? new Map<string, TileSnapshotEntry>();
    if (selection.floating.beforeTileSnapshot) {
      for (const [k, v] of selection.floating.beforeTileSnapshot.entries()) {
        if (!beforeSnapshot.has(k)) {
          beforeSnapshot.set(k, v);
        }
      }
    }

    const existingTiles = grid.getLayerTiles(layerId, 0);
    for (const tile of existingTiles) {
      const key = getTileKey(layerId, tile.tileX, tile.tileY, 0);
      if (!beforeSnapshot.has(key)) {
        beforeSnapshot.set(key, {
          format: tile.format,
          data: tile.data ? new Uint8Array(tile.data) : null,
        });
      }
    }

    grid.clearLayer(layerId);
    if (isBackground) {
      grid.fillLayerSolidWhite(layerId, dimensions.width, dimensions.height, targetFormat);
    }

    const { canvas, x, y } = selection.floating;
    const fCtx = canvas.getContext('2d', { willReadFrequently: true });
    const dx = Math.round(x);
    const dy = Math.round(y);
    const clipX0 = Math.max(0, dx);
    const clipY0 = Math.max(0, dy);
    const clipX1 = Math.min(dimensions.width, dx + canvas.width);
    const clipY1 = Math.min(dimensions.height, dy + canvas.height);

    if (fCtx && clipX1 > clipX0 && clipY1 > clipY0) {
      const imgData = fCtx.getImageData(clipX0 - dx, clipY0 - dy, clipX1 - clipX0, clipY1 - clipY0);
      grid.compositeStrokeToTiles({
        layerId,
        strokeData: imgData,
        destX: clipX0,
        destY: clipY0,
        format: targetFormat,
        compositeOp: 'source-over',
        opacity: 1.0,
        snapshotOut: beforeSnapshot,
        suppressNotify: true,
      });
    }

    if (!isBackground) {
      grid.pruneEmptyTiles(layerId);
    }
    const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, layerId);
    grid.notifyChange(true);
    return { dirtyRect: fullRect, tileDeltas };
  }

  const raw = selection.bounds;
  if (!raw || raw.width <= 0 || raw.height <= 0) return { dirtyRect: null, tileDeltas: [] };

  const bx = Math.max(0, Math.floor(raw.x));
  const by = Math.max(0, Math.floor(raw.y));
  const bx1 = Math.min(dimensions.width, Math.ceil(raw.x + raw.width));
  const by1 = Math.min(dimensions.height, Math.ceil(raw.y + raw.height));
  if (bx1 <= bx || by1 <= by) return { dirtyRect: null, tileDeltas: [] };

  const existingTiles = grid.getLayerTiles(layerId, 0);
  if (existingTiles.length === 0) return { dirtyRect: null, tileDeltas: [] };

  const beforeSnapshot = params.snapshotOut ?? new Map<string, TileSnapshotEntry>();
  const hasMask = Boolean(selection.mask && selection.maskWidth && selection.maskHeight);
  const hasLasso =
    !hasMask && selection.type === 'lasso' && Boolean(selection.polygon && selection.polygon.length >= 3);

  let scratchCanvas: HTMLCanvasElement | null = null;
  let scratchCtx: CanvasRenderingContext2D | null = null;
  const lassoAlpha = hasLasso ? new Uint8Array(TILE_SIZE * TILE_SIZE) : null;
  if (hasLasso && typeof document !== 'undefined') {
    scratchCanvas = document.createElement('canvas');
    scratchCanvas.width = TILE_SIZE;
    scratchCanvas.height = TILE_SIZE;
    scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
  }

  const outRgba = new Uint8ClampedArray(BYTES_32BIT);
  let dirtyMinX = dimensions.width;
  let dirtyMinY = dimensions.height;
  let dirtyMaxX = -1;
  let dirtyMaxY = -1;

  const markDirtyTile = (tx: number, ty: number) => {
    const tx0 = Math.max(0, tx * TILE_SIZE);
    const ty0 = Math.max(0, ty * TILE_SIZE);
    const tx1 = Math.min(dimensions.width, (tx + 1) * TILE_SIZE);
    const ty1 = Math.min(dimensions.height, (ty + 1) * TILE_SIZE);
    if (tx0 < dirtyMinX) dirtyMinX = tx0;
    if (ty0 < dirtyMinY) dirtyMinY = ty0;
    if (tx1 > dirtyMaxX) dirtyMaxX = tx1;
    if (ty1 > dirtyMaxY) dirtyMaxY = ty1;
  };

  try {
    const tileList = existingTiles.slice();
    for (const tile of tileList) {
      const tx = tile.tileX;
      const ty = tile.tileY;
      const tileDocX = tx * TILE_SIZE;
      const tileDocY = ty * TILE_SIZE;
      const key = getTileKey(layerId, tx, ty, 0);

      const intersectsBounds =
        tileDocX < bx1 && tileDocX + TILE_SIZE > bx && tileDocY < by1 && tileDocY + TILE_SIZE > by;

      if (!intersectsBounds) {
        if (!beforeSnapshot.has(key)) {
          beforeSnapshot.set(key, {
            format: tile.format,
            data: tile.data ? new Uint8Array(tile.data) : null,
          });
        }
        if (isBackground) {
          outRgba.fill(0);
          const maxLy = Math.min(TILE_SIZE, dimensions.height - tileDocY);
          const maxLx = Math.min(TILE_SIZE, dimensions.width - tileDocX);
          for (let ly = 0; ly < maxLy; ly++) {
            const row = ly * TILE_SIZE * 4;
            for (let lx = 0; lx < maxLx; lx++) {
              const off = row + lx * 4;
              outRgba[off] = 255;
              outRgba[off + 1] = 255;
              outRgba[off + 2] = 255;
              outRgba[off + 3] = 255;
            }
          }
          grid.writeImageData(
            layerId,
            { data: outRgba, width: TILE_SIZE, height: TILE_SIZE },
            tileDocX,
            tileDocY,
            targetFormat,
            true
          );
        } else {
          grid.deleteTile(layerId, tx, ty, 0);
        }
        markDirtyTile(tx, ty);
        continue;
      }

      if (
        !hasMask &&
        !hasLasso &&
        tileDocX >= bx &&
        tileDocX + TILE_SIZE <= bx1 &&
        tileDocY >= by &&
        tileDocY + TILE_SIZE <= by1
      ) {
        continue;
      }

      if (!beforeSnapshot.has(key)) {
        beforeSnapshot.set(key, {
          format: tile.format,
          data: tile.data ? new Uint8Array(tile.data) : null,
        });
      }

      const srcRgba = grid.getTileAsRGBA(tile);
      outRgba.fill(0);

      if (hasLasso && lassoAlpha && selection.polygon) {
        buildTileLassoAlpha(selection.polygon, tileDocX, tileDocY, lassoAlpha, scratchCanvas, scratchCtx);
      }

      let hasAnyPixel = false;
      const mw = selection.maskWidth ?? 0;
      const mh = selection.maskHeight ?? 0;

      for (let ly = 0; ly < TILE_SIZE; ly++) {
        const gy = tileDocY + ly;
        const inDocY = gy >= 0 && gy < dimensions.height;
        const tRow = ly * TILE_SIZE;
        for (let lx = 0; lx < TILE_SIZE; lx++) {
          const gx = tileDocX + lx;
          const off = (tRow + lx) * 4;
          const inDoc = inDocY && gx >= 0 && gx < dimensions.width;
          if (!inDoc) continue;

          let keepAlpha = 0;
          if (gx >= bx && gx < bx1 && gy >= by && gy < by1) {
            if (hasMask && selection.mask) {
              keepAlpha = gy < mh && gx < mw ? selection.mask[gy * mw + gx] : 0;
            } else if (hasLasso && lassoAlpha) {
              keepAlpha = lassoAlpha[tRow + lx];
            } else {
              keepAlpha = 255;
            }
          }

          if (isBackground) {
            hasAnyPixel = true;
            if (keepAlpha === 255) {
              outRgba[off] = srcRgba[off];
              outRgba[off + 1] = srcRgba[off + 1];
              outRgba[off + 2] = srcRgba[off + 2];
              outRgba[off + 3] = srcRgba[off + 3];
            } else if (keepAlpha === 0) {
              outRgba[off] = 255;
              outRgba[off + 1] = 255;
              outRgba[off + 2] = 255;
              outRgba[off + 3] = 255;
            } else {
              const k = keepAlpha / 255;
              const inv = 1 - k;
              outRgba[off] = Math.round(srcRgba[off] * k + 255 * inv);
              outRgba[off + 1] = Math.round(srcRgba[off + 1] * k + 255 * inv);
              outRgba[off + 2] = Math.round(srcRgba[off + 2] * k + 255 * inv);
              outRgba[off + 3] = 255;
            }
          } else {
            if (keepAlpha === 0) continue;
            const sa = srcRgba[off + 3];
            if (sa === 0) continue;
            const ea = keepAlpha === 255 ? sa : Math.round((sa * keepAlpha) / 255);
            if (ea === 0) continue;
            hasAnyPixel = true;
            outRgba[off] = srcRgba[off];
            outRgba[off + 1] = srcRgba[off + 1];
            outRgba[off + 2] = srcRgba[off + 2];
            outRgba[off + 3] = ea;
          }
        }
      }

      if (hasAnyPixel) {
        grid.writeImageData(
          layerId,
          { data: outRgba, width: TILE_SIZE, height: TILE_SIZE },
          tileDocX,
          tileDocY,
          targetFormat,
          true
        );
      } else {
        grid.deleteTile(layerId, tx, ty, 0);
      }
      markDirtyTile(tx, ty);
    }
  } finally {
    if (scratchCanvas) releaseTemporaryCanvas(scratchCanvas);
  }

  if (!isBackground) {
    grid.pruneEmptyTiles(layerId);
  }

  const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, layerId);
  grid.notifyChange(true);

  const dirtyRect =
    dirtyMaxX > dirtyMinX && dirtyMaxY > dirtyMinY
      ? { x: dirtyMinX, y: dirtyMinY, width: dirtyMaxX - dirtyMinX, height: dirtyMaxY - dirtyMinY }
      : null;

  return { dirtyRect, tileDeltas };
}
