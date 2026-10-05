import { BrushSettings } from '../types/editor';
import { getBuiltinBrushConfig } from './presetBrushes';
import { getPreloadedTipImage } from './brushStorage';

export interface TipOutline {
  path: string;
  viewBox: string;
  width: number;
  height: number;
}

// Memory cache to guarantee zero-latency synchronous access
const outlineCache = new Map<string, TipOutline>();
const MAX_CACHE_ENTRIES = 120;

/**
 * Resolves the active HTMLImageElement for a brush if one exists.
 */
export function resolveBrushTipImage(settings: Partial<BrushSettings>): HTMLImageElement | undefined {
  if (settings.customTipImage) return settings.customTipImage;
  if (settings.preset) {
    const builtin = getBuiltinBrushConfig(settings.preset);
    if (builtin?.customTipImage) return builtin.customTipImage;
  }
  if (settings.customTipDataUrl) {
    const preloaded = getPreloadedTipImage(settings.customTipDataUrl);
    if (preloaded) return preloaded;
  }
  return undefined;
}

/**
 * Extracts and caches the vector SVG silhouette contour of a brush tip texture.
 * Uses adaptive thresholding and Marching Squares with RDP polygon reduction.
 */
export function getBrushTipOutline(image: HTMLImageElement): TipOutline | null {
  if (!image || !image.complete) return null;

  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  if (w <= 0 || h <= 0) return null;

  const cacheKey = image.src || `${w}x${h}`;
  if (outlineCache.has(cacheKey)) {
    return outlineCache.get(cacheKey)!;
  }

  // Downsample to max 160px grid to guarantee sub-millisecond execution while preserving fine bristle details
  const maxDim = Math.max(w, h);
  const scale = maxDim > 160 ? 160 / maxDim : 1;
  const gridW = Math.max(8, Math.round(w * scale));
  const gridH = Math.max(8, Math.round(h * scale));

  const canvas = document.createElement('canvas');
  canvas.width = gridW;
  canvas.height = gridH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(image, 0, 0, gridW, gridH);
  const imgData = ctx.getImageData(0, 0, gridW, gridH);
  const data = imgData.data;

  // Check transparency vs opaque black-on-white
  let hasAlpha = false;
  let maxAlpha = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 240) hasAlpha = true;
    if (a > maxAlpha) maxAlpha = a;
  }

  const alphaGrid = new Uint8Array(gridW * gridH);
  if (!hasAlpha) {
    let maxLumAlpha = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const a = Math.max(0, Math.min(255, Math.round(255 - lum)));
      alphaGrid[p] = a;
      if (a > maxLumAlpha) maxLumAlpha = a;
    }
    maxAlpha = maxLumAlpha;
  } else {
    for (let i = 3, p = 0; i < data.length; i += 4, p++) {
      alphaGrid[p] = data[i];
    }
  }

  if (maxAlpha < 10) return null;

  // Adaptive thresholding: captures faint bristle marks while ignoring low noise
  const threshold = Math.max(16, Math.round(maxAlpha * 0.15));

  const padW = gridW + 2;
  const padH = gridH + 2;
  const grid = new Uint8Array(padW * padH);

  let opaqueCount = 0;
  for (let y = 0; y < gridH; y++) {
    const rowOffset = (y + 1) * padW + 1;
    const imgOffset = y * gridW;
    for (let x = 0; x < gridW; x++) {
      if (alphaGrid[imgOffset + x] >= threshold) {
        grid[rowOffset + x] = 1;
        opaqueCount++;
      }
    }
  }

  if (opaqueCount === 0) return null;

  // Marching Squares contour segment generation
  const segments: [[number, number], [number, number]][] = [];

  for (let cy = 0; cy < padH - 1; cy++) {
    const row0 = cy * padW;
    const row1 = (cy + 1) * padW;
    for (let cx = 0; cx < padW - 1; cx++) {
      const tl = grid[row0 + cx];
      const tr = grid[row0 + cx + 1];
      const br = grid[row1 + cx + 1];
      const bl = grid[row1 + cx];

      const mask = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (mask === 0 || mask === 15) continue;

      const p0: [number, number] = [2 * cx + 1, 2 * cy];
      const p1: [number, number] = [2 * cx + 2, 2 * cy + 1];
      const p2: [number, number] = [2 * cx + 1, 2 * cy + 2];
      const p3: [number, number] = [2 * cx, 2 * cy + 1];

      switch (mask) {
        case 1: segments.push([p3, p2]); break;
        case 2: segments.push([p2, p1]); break;
        case 3: segments.push([p3, p1]); break;
        case 4: segments.push([p1, p0]); break;
        case 5: segments.push([p3, p0], [p2, p1]); break;
        case 6: segments.push([p2, p0]); break;
        case 7: segments.push([p3, p0]); break;
        case 8: segments.push([p0, p3]); break;
        case 9: segments.push([p0, p2]); break;
        case 10: segments.push([p0, p1], [p2, p3]); break;
        case 11: segments.push([p0, p1]); break;
        case 12: segments.push([p1, p3]); break;
        case 13: segments.push([p1, p2]); break;
        case 14: segments.push([p2, p3]); break;
      }
    }
  }

  // Build vertex adjacency map
  const adj = new Map<number, { pt: [number, number]; neighbors: number[] }>();
  function addEdge(a: [number, number], b: [number, number]) {
    const ka = (a[0] << 16) | a[1];
    const kb = (b[0] << 16) | b[1];
    let na = adj.get(ka);
    if (!na) { na = { pt: a, neighbors: [] }; adj.set(ka, na); }
    let nb = adj.get(kb);
    if (!nb) { nb = { pt: b, neighbors: [] }; adj.set(kb, nb); }
    na.neighbors.push(kb);
    nb.neighbors.push(ka);
  }

  for (let i = 0; i < segments.length; i++) {
    addEdge(segments[i][0], segments[i][1]);
  }

  const visitedEdges = new Set<string>();
  function edgeKey(u: number, v: number): string {
    return u < v ? `${u}_${v}` : `${v}_${u}`;
  }

  const loops: { x: number; y: number }[][] = [];

  for (const [startK, node] of adj.entries()) {
    for (let ni = 0; ni < node.neighbors.length; ni++) {
      const nextK = node.neighbors[ni];
      const eK = edgeKey(startK, nextK);
      if (visitedEdges.has(eK)) continue;

      const loop: [number, number][] = [node.pt];
      visitedEdges.add(eK);
      let prevK = startK;
      let currK = nextK;

      while (currK !== startK) {
        const currNode = adj.get(currK);
        if (!currNode) break;
        loop.push(currNode.pt);
        let foundNext: number | null = null;
        for (let j = 0; j < currNode.neighbors.length; j++) {
          const nK = currNode.neighbors[j];
          if (nK === prevK) continue;
          const neK = edgeKey(currK, nK);
          if (!visitedEdges.has(neK)) {
            foundNext = nK;
            visitedEdges.add(neK);
            break;
          }
        }
        if (foundNext === null) break;
        prevK = currK;
        currK = foundNext;
      }

      if (loop.length >= 4) {
        // Map back to unpadded image grid coordinates
        const floatLoop = loop.map(p => ({
          x: p[0] * 0.5 - 1,
          y: p[1] * 0.5 - 1,
        }));

        // Shoelace polygon area: filter out negligible micro-noise (< 3px² area)
        let area = 0;
        for (let i = 0; i < floatLoop.length; i++) {
          const next = (i + 1) % floatLoop.length;
          area += floatLoop[i].x * floatLoop[next].y - floatLoop[next].x * floatLoop[i].y;
        }
        if (Math.abs(area) * 0.5 >= 3) {
          loops.push(floatLoop);
        }
      }
    }
  }

  if (loops.length === 0) return null;

  // Simplify and generate SVG path
  const pathParts: string[] = [];
  for (let l = 0; l < loops.length; l++) {
    const simplified = simplifyLoop(loops[l], 0.65);
    if (simplified.length < 3) continue;

    let part = `M ${simplified[0].x.toFixed(1)} ${simplified[0].y.toFixed(1)}`;
    for (let p = 1; p < simplified.length; p++) {
      part += ` L ${simplified[p].x.toFixed(1)} ${simplified[p].y.toFixed(1)}`;
    }
    part += ' Z';
    pathParts.push(part);
  }

  if (pathParts.length === 0) return null;

  const result: TipOutline = {
    path: pathParts.join(' '),
    viewBox: `0 0 ${gridW} ${gridH}`,
    width: gridW,
    height: gridH,
  };

  if (outlineCache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = outlineCache.keys().next().value;
    if (firstKey) outlineCache.delete(firstKey);
  }
  outlineCache.set(cacheKey, result);

  return result;
}

function simplifyLoop(points: { x: number; y: number }[], epsilon: number): { x: number; y: number }[] {
  if (points.length <= 3) return points;
  return rdp(points, 0, points.length - 1, epsilon);
}

function rdp(
  points: { x: number; y: number }[],
  start: number,
  end: number,
  epsilon: number
): { x: number; y: number }[] {
  if (end <= start + 1) return [points[start], points[end]];

  let maxDist = 0;
  let index = start;
  const p1 = points[start];
  const p2 = points[end];
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lenSq = dx * dx + dy * dy;

  for (let i = start + 1; i < end; i++) {
    const p = points[i];
    let dist: number;
    if (lenSq === 0) {
      dist = Math.hypot(p.x - p1.x, p.y - p1.y);
    } else {
      const t = Math.max(0, Math.min(1, ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / lenSq));
      dist = Math.hypot(p.x - (p1.x + t * dx), p.y - (p1.y + t * dy));
    }
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }

  if (maxDist > epsilon) {
    const left = rdp(points, start, index, epsilon);
    const right = rdp(points, index, end, epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[start], points[end]];
}

export function clearTipOutlineCache() {
  outlineCache.clear();
}
