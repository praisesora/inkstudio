import { Point, CanvasDimensions, BlendMode, LayerItem } from '../types/editor';
import { evaluateFastSpline } from '../engine/BrushEngine';

export const CANVAS_2D_CONTEXT_OPTIONS: CanvasRenderingContext2DSettings = {
  alpha: true,
  desynchronized: false,
  willReadFrequently: true,
};

/**
 * Standard 2D context retrieval with high-performance desynchronized hardware acceleration hints.
 */
export function get2DContext(
  canvas: HTMLCanvasElement,
  options: CanvasRenderingContext2DSettings = CANVAS_2D_CONTEXT_OPTIONS
): CanvasRenderingContext2D | null {
  return canvas.getContext('2d', options);
}

/**
 * Calculates stroke width based on base brush size, pressure, pressure curve, and minimum size ratio.
 * Follows Clip Studio Paint's exact dynamics calculation using O(1) LUT splines.
 */
export function calculateStrokeWidth(
  baseSize: number,
  pressure: number,
  minSizeFactor: number,
  usePressure: boolean,
  pointerType: string,
  pressureCurveGamma: number = 1.0,
  velocityScale: number = 1.0,
  pressureCurve?: [number, number][]
): number {
  if (!usePressure) {
    return Math.max(0.2, baseSize * velocityScale);
  }

  let effectivePressure = pressure;
  if (pointerType === 'mouse') {
    effectivePressure = 0.5;
  } else {
    if (Number.isNaN(effectivePressure) || effectivePressure === undefined) {
      effectivePressure = 0;
    }
    effectivePressure = Math.max(0, Math.min(1.0, effectivePressure));
  }

  let curvePressure = effectivePressure;
  if (pressureCurve && pressureCurve.length > 0) {
    curvePressure = evaluateFastSpline(effectivePressure, pressureCurve);
  } else if (pressureCurveGamma !== 1.0) {
    curvePressure = Math.pow(Math.max(0, effectivePressure), pressureCurveGamma);
  }

  const minRatio = Math.max(0, Math.min(1.0, minSizeFactor ?? 0));
  const dynamicWidth = baseSize * (minRatio + (1.0 - minRatio) * curvePressure) * velocityScale;
  // Keep light continuous pen contact (> 0.005) above sub-pixel invisible collapse (width = 0.1),
  // while still allowing flick taper tails (pressure <= 0.005) to razor-taper down to 0.1px.
  const contactFloor =
    effectivePressure > 0.005 ? Math.min(baseSize, Math.max(0.35, baseSize * minRatio)) : 0.1;
  return Math.max(contactFloor, dynamicWidth);
}

/**
 * Computes midpoint between two points.
 */
export function getMidPoint(p1: Point, p2: Point): Point {
  return {
    x: (p1.x + p2.x) / 2,
    y: (p1.y + p2.y) / 2,
    pressure: (p1.pressure + p2.pressure) / 2,
    width: (p1.width + p2.width) / 2,
  };
}

let _sharedThumbCanvas: HTMLCanvasElement | null = null;

export const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: 'pass-through', label: 'Pass Through' },
  { value: 'normal', label: 'Normal' },
  { value: 'darken', label: 'Darken' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'linear-burn', label: 'Linear Burn' },
  { value: 'darker-color', label: 'Darker Color' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'screen', label: 'Screen' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-dodge-glow', label: 'Glow Dodge' },
  { value: 'add-glow', label: 'Add (Glow)' },
  { value: 'lighter-color', label: 'Lighter Color' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'vivid-light', label: 'Vivid Light' },
  { value: 'linear-light', label: 'Linear Light' },
  { value: 'pin-light', label: 'Pin Light' },
  { value: 'hard-mix', label: 'Hard Mix' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'subtract', label: 'Subtract' },
  { value: 'divide', label: 'Divide' },
  { value: 'hue', label: 'Hue' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

export function getCanvasCompositeOperation(blendMode: BlendMode): GlobalCompositeOperation {
  switch (blendMode) {
    case 'pass-through':
    case 'normal':
      return 'source-over';
    case 'multiply':
      return 'multiply';
    case 'screen':
      return 'screen';
    case 'overlay':
      return 'overlay';
    case 'darken':
    case 'darker-color':
      return 'darken';
    case 'lighten':
    case 'lighter-color':
      return 'lighten';
    case 'color-dodge':
    case 'color-dodge-glow':
      return 'color-dodge';
    case 'color-burn':
    case 'linear-burn':
      return 'color-burn';
    case 'add-glow':
      return 'lighter';
    case 'hard-light':
    case 'vivid-light':
    case 'linear-light':
    case 'pin-light':
    case 'hard-mix':
      return 'hard-light';
    case 'soft-light':
      return 'soft-light';
    case 'difference':
    case 'subtract':
    case 'divide':
      return 'difference';
    case 'exclusion':
      return 'exclusion';
    case 'hue':
      return 'hue';
    case 'saturation':
      return 'saturation';
    case 'color':
      return 'color';
    case 'luminosity':
      return 'luminosity';
    default:
      return 'source-over';
  }
}

import type { SparseTileGrid } from './tileEngine';

export interface TileThumbnailSource {
  grid: SparseTileGrid;
  layerId: string;
  dimensions: { width: number; height: number };
}

/**
 * Generates an efficient mini thumbnail (60px wide) for layer and history preview.
 * Supports direct LOD 3 sampling from SparseTileGrid without reading full-size canvases.
 */
export function createCanvasThumbnail(
  source: HTMLCanvasElement | TileThumbnailSource,
  preserveAlpha: boolean = false
): string {
  try {
    if (source && 'grid' in source && 'layerId' in source) {
      const targetW = 60;
      const docW = Math.max(1, source.dimensions.width);
      const docH = Math.max(1, source.dimensions.height);
      const targetH = Math.max(38, Math.round((docH / docW) * targetW));
      return source.grid.generateThumbnail(source.layerId, targetW, targetH, source.dimensions, preserveAlpha);
    }

    const canvas = source;
    if (!_sharedThumbCanvas) {
      _sharedThumbCanvas = document.createElement('canvas');
    }
    const targetW = 60;
    const targetH = Math.max(38, Math.round((canvas.height / Math.max(1, canvas.width)) * targetW));
    _sharedThumbCanvas.width = targetW;
    _sharedThumbCanvas.height = targetH;
    const tCtx = _sharedThumbCanvas.getContext('2d');
    if (!tCtx) return '';

    if (preserveAlpha) {
      tCtx.clearRect(0, 0, targetW, targetH);
      tCtx.drawImage(canvas, 0, 0, targetW, targetH);
      return _sharedThumbCanvas.toDataURL('image/png');
    } else {
      tCtx.fillStyle = '#ffffff';
      tCtx.fillRect(0, 0, targetW, targetH);
      tCtx.drawImage(canvas, 0, 0, targetW, targetH);
      return _sharedThumbCanvas.toDataURL('image/jpeg', 0.65);
    }
  } catch (err) {
    console.warn('createCanvasThumbnail error:', err);
    return '';
  }
}

export function formatTime(timestamp: number | Date = Date.now()): string {
  const d = typeof timestamp === 'number' ? new Date(timestamp) : timestamp;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function screenToCanvasInto(
  clientX: number,
  clientY: number,
  viewportRect: DOMRect,
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  dimensions: CanvasDimensions,
  out: { x: number; y: number },
  flipX: boolean = false,
  flipY: boolean = false
): void {
  const vx = clientX - viewportRect.left;
  const vy = clientY - viewportRect.top;

  const rx = vx - pan.x;
  const ry = vy - pan.y;

  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const unrotX = rx * cos + ry * sin;
  const unrotY = -rx * sin + ry * cos;

  const fx = flipX ? -1 : 1;
  const fy = flipY ? -1 : 1;

  out.x = dimensions.width / 2 + (fx * unrotX) / zoom;
  out.y = dimensions.height / 2 + (fy * unrotY) / zoom;
}

export function screenToCanvas(
  clientX: number,
  clientY: number,
  viewportRect: DOMRect,
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  dimensions: CanvasDimensions,
  flipX: boolean = false,
  flipY: boolean = false
): { x: number; y: number } {
  const out = { x: 0, y: 0 };
  screenToCanvasInto(clientX, clientY, viewportRect, pan, zoom, rotation, dimensions, out, flipX, flipY);
  return out;
}

export const clientToDocument = screenToCanvas;

export function canvasToScreen(
  canvasX: number,
  canvasY: number,
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  dimensions: CanvasDimensions,
  flipX: boolean = false,
  flipY: boolean = false
): { x: number; y: number } {
  const fx = flipX ? -1 : 1;
  const fy = flipY ? -1 : 1;

  const dx = (canvasX - dimensions.width / 2) * fx;
  const dy = (canvasY - dimensions.height / 2) * fy;

  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const rx = zoom * (dx * cos - dy * sin);
  const ry = zoom * (dx * sin + dy * cos);

  return {
    x: pan.x + rx,
    y: pan.y + ry,
  };
}

export function formatRotationDegrees(degrees: number): string {
  let normalized = degrees % 360;
  if (normalized > 180) normalized -= 360;
  if (normalized <= -180) normalized += 360;

  const rounded = Math.round(normalized * 10) / 10;
  const finalVal = Math.abs(rounded) < 0.05 ? 0 : rounded;
  return `${finalVal % 1 === 0 ? finalVal.toFixed(0) : finalVal.toFixed(1)}°`;
}

export interface CanvasTransformMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export function getCanvasToViewportMatrix(
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  dimensions: CanvasDimensions,
  scaleX: number = 1,
  scaleY: number = scaleX,
  flipX: boolean = false,
  flipY: boolean = false
): CanvasTransformMatrix {
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const cx = dimensions.width / 2;
  const cy = dimensions.height / 2;
  const sx = (flipX ? -1 : 1) * zoom;
  const sy = (flipY ? -1 : 1) * zoom;

  const a = scaleX * sx * cos;
  const b = scaleY * sx * sin;
  const c = -scaleX * sy * sin;
  const d = scaleY * sy * cos;
  const e = scaleX * (pan.x - sx * cx * cos + sy * cy * sin);
  const f = scaleY * (pan.y - sx * cx * sin - sy * cy * cos);

  return { a, b, c, d, e, f };
}

export function getVisibleCanvasBounds(
  viewportRect: DOMRect,
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  dimensions: CanvasDimensions,
  margin: number = 64,
  flipX: boolean = false,
  flipY: boolean = false
): { minX: number; minY: number; maxX: number; maxY: number } {
  const c1 = screenToCanvas(viewportRect.left, viewportRect.top, viewportRect, pan, zoom, rotation, dimensions, flipX, flipY);
  const c2 = screenToCanvas(viewportRect.right, viewportRect.top, viewportRect, pan, zoom, rotation, dimensions, flipX, flipY);
  const c3 = screenToCanvas(viewportRect.right, viewportRect.bottom, viewportRect, pan, zoom, rotation, dimensions, flipX, flipY);
  const c4 = screenToCanvas(viewportRect.left, viewportRect.bottom, viewportRect, pan, zoom, rotation, dimensions, flipX, flipY);

  const rawMinX = Math.min(c1.x, c2.x, c3.x, c4.x) - margin;
  const rawMinY = Math.min(c1.y, c2.y, c3.y, c4.y) - margin;
  const rawMaxX = Math.max(c1.x, c2.x, c3.x, c4.x) + margin;
  const rawMaxY = Math.max(c1.y, c2.y, c3.y, c4.y) + margin;

  return {
    minX: Math.max(0, Math.floor(rawMinX)),
    minY: Math.max(0, Math.floor(rawMinY)),
    maxX: Math.min(dimensions.width, Math.ceil(rawMaxX)),
    maxY: Math.min(dimensions.height, Math.ceil(rawMaxY)),
  };
}

let _reusableBakeCanvas: HTMLCanvasElement | null = null;

export function getReusableBakeCanvas(minWidth: number, minHeight: number): HTMLCanvasElement {
  if (!_reusableBakeCanvas) {
    _reusableBakeCanvas = document.createElement('canvas');
  }
  const targetW = Math.max(256, Math.ceil(minWidth));
  const targetH = Math.max(256, Math.ceil(minHeight));
  const MAX_PERSISTENT_BAKE_PIXELS = 2048 * 2048;
  const currentPixels = _reusableBakeCanvas.width * _reusableBakeCanvas.height;
  if (
    currentPixels > MAX_PERSISTENT_BAKE_PIXELS &&
    targetW * targetH <= MAX_PERSISTENT_BAKE_PIXELS
  ) {
    _reusableBakeCanvas.width = targetW;
    _reusableBakeCanvas.height = targetH;
  } else if (_reusableBakeCanvas.width < targetW || _reusableBakeCanvas.height < targetH) {
    _reusableBakeCanvas.width = Math.max(_reusableBakeCanvas.width, targetW);
    _reusableBakeCanvas.height = Math.max(_reusableBakeCanvas.height, targetH);
  }
  return _reusableBakeCanvas;
}

export function applyParametricTaper(
  points: Point[],
  options?: {
    useIn?: boolean;
    useOut?: boolean;
    inCount?: number;
    outCount?: number;
    minSizeFactor?: number;
    exitSpeed?: number;
  }
): Point[] {
  if (points.length < 2) return points;

  const minRatio = Math.max(0.01, Math.min(1.0, options?.minSizeFactor ?? 0.05));
  const n = points.length;

  if (options?.useIn) {
    const inCount = Math.min(Math.floor(n / 2), options.inCount ?? Math.min(8, n));
    for (let i = 0; i < inCount; i++) {
      const u = (i + 1) / (inCount + 1);
      const taper = Math.sin((u * Math.PI) / 2);
      const factor = minRatio + (1.0 - minRatio) * taper;
      points[i].width *= factor;
      points[i].pressure *= factor;
    }
  }

  const useOut = options?.useOut ?? true;
  if (useOut) {
    let outCount = options?.outCount ?? 6;
    if (options?.exitSpeed && options.exitSpeed > 0.8) {
      outCount = Math.min(Math.floor(n / 2), Math.round(outCount * Math.min(2.5, options.exitSpeed)));
    }
    outCount = Math.min(Math.floor(n / 2), Math.max(2, outCount));
    const startIdx = n - outCount;
    for (let i = startIdx; i < n; i++) {
      const step = n - 1 - i;
      const u = (step + 1) / (outCount + 1);
      const taper = Math.sin((u * Math.PI) / 2);
      const factor = minRatio + (1.0 - minRatio) * taper;
      points[i].width *= factor;
      points[i].pressure *= factor;
    }
  }

  return points;
}

let sampleCanvas: HTMLCanvasElement | null = null;
let sampleCtx: CanvasRenderingContext2D | null = null;

/**
 * Samples the composited RGBA pixel color across all visible layers at (x, y).
 * Reads directly from SparseTileGrid in O(visible layers) with zero full-canvas allocation.
 */
export function sampleCompositedColor(
  layers: LayerItem[],
  source: SparseTileGrid | Map<string, HTMLCanvasElement>,
  x: number,
  y: number,
  isLayerVisible: (layer: LayerItem) => boolean,
  getLayerOpacity: (layer: LayerItem) => number,
  canvasWidth: number,
  canvasHeight: number,
  floatingSelection?: { canvas: HTMLCanvasElement; x: number; y: number } | null
): string | null {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || px >= canvasWidth || py < 0 || py >= canvasHeight) {
    return null;
  }

  const isTileGrid = 'getPixelRGBA' in source;

  if (!sampleCanvas && typeof document !== 'undefined') {
    sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 1;
    sampleCanvas.height = 1;
    sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  }

  const renderOrder = layers.slice().reverse();

  if (isTileGrid && !sampleCtx) {
    // Pure math headless fallback
    let accR = 0, accG = 0, accB = 0, accA = 0;
    const pixel: [number, number, number, number] = [0, 0, 0, 0];
    for (const layer of renderOrder) {
      if (layer.type === 'folder' || layer.type === 'frame-folder' || !isLayerVisible(layer)) continue;
      source.getPixelRGBA(layer.id, px, py, pixel);
      if (pixel[3] === 0) continue;
      const sA = (pixel[3] / 255) * getLayerOpacity(layer);
      const outA = sA + accA * (1 - sA);
      if (outA > 0) {
        accR = (pixel[0] * sA + accR * accA * (1 - sA)) / outA;
        accG = (pixel[1] * sA + accG * accA * (1 - sA)) / outA;
        accB = (pixel[2] * sA + accB * accA * (1 - sA)) / outA;
        accA = outA;
      }
    }
    if (accA <= 0) return '#ffffff';
    const r = Math.round(accR * accA + 255 * (1 - accA));
    const g = Math.round(accG * accA + 255 * (1 - accA));
    const b = Math.round(accB * accA + 255 * (1 - accA));
    const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  if (!sampleCtx) return null;
  sampleCtx.clearRect(0, 0, 1, 1);

  const pixel: [number, number, number, number] = [0, 0, 0, 0];
  for (const layer of renderOrder) {
    if (layer.type === 'folder' || layer.type === 'frame-folder' || !isLayerVisible(layer)) continue;
    if (isTileGrid) {
      source.getPixelRGBA(layer.id, px, py, pixel);
      if (pixel[3] === 0) continue;
      sampleCtx.save();
      sampleCtx.globalAlpha = getLayerOpacity(layer);
      sampleCtx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
      sampleCtx.fillStyle = `rgba(${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3] / 255})`;
      sampleCtx.fillRect(0, 0, 1, 1);
      sampleCtx.restore();
    } else {
      const lCanvas = source.get(layer.id);
      if (!lCanvas) continue;
      sampleCtx.save();
      sampleCtx.globalAlpha = getLayerOpacity(layer);
      sampleCtx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
      sampleCtx.drawImage(lCanvas, px, py, 1, 1, 0, 0, 1, 1);
      sampleCtx.restore();
    }
  }

  if (floatingSelection?.canvas) {
    const fx = px - floatingSelection.x;
    const fy = py - floatingSelection.y;
    if (fx >= 0 && fx < floatingSelection.canvas.width && fy >= 0 && fy < floatingSelection.canvas.height) {
      sampleCtx.drawImage(floatingSelection.canvas, fx, fy, 1, 1, 0, 0, 1, 1);
    }
  }

  const data = sampleCtx.getImageData(0, 0, 1, 1).data;
  if (data[3] === 0) {
    return '#ffffff';
  }

  const a = data[3] / 255;
  const r = Math.round(data[0] * a + 255 * (1 - a));
  const g = Math.round(data[1] * a + 255 * (1 - a));
  const b = Math.round(data[2] * a + 255 * (1 - a));

  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
