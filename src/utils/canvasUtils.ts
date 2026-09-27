import { Point, CanvasDimensions, BlendMode, ToolType, BrushSettings, CanvasColorMode, LayerItem } from '../types/editor';
import { enforceColorMode } from './colorUtils';
import { drawPencilCubicBezierSegment, drawPencilDot, PencilGrade } from './pencilEngine';
import { renderCompleteTexturedStroke, TexturedBrushOptions } from './stampEngine';
import { evaluateCspSpline } from './sutParser';

export const CANVAS_2D_CONTEXT_OPTIONS: CanvasRenderingContext2DSettings = {
  alpha: true,
  desynchronized: true,
  willReadFrequently: false,
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
 * Follows Clip Studio Paint's exact dynamics calculation.
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

  // Tablet stylus pressure vs mouse fallback
  let effectivePressure = pressure;
  if (pointerType === 'mouse') {
    effectivePressure = 0.5;
  } else {
    if (Number.isNaN(effectivePressure) || effectivePressure === undefined) {
      effectivePressure = 0;
    }
    effectivePressure = Math.max(0, Math.min(1.0, effectivePressure));
  }

  // Evaluate through authentic CSP cubic Hermite spline curve if available
  let curvePressure = effectivePressure;
  if (pressureCurve && pressureCurve.length > 0) {
    curvePressure = evaluateCspSpline(effectivePressure, pressureCurve);
  } else if (pressureCurveGamma !== 1.0) {
    curvePressure = Math.pow(Math.max(0, effectivePressure), pressureCurveGamma);
  }

  const minRatio = Math.max(0, Math.min(1.0, minSizeFactor ?? 0));
  const dynamicWidth = baseSize * (minRatio + (1.0 - minRatio) * curvePressure) * velocityScale;
  return Math.max(0.1, dynamicWidth);
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

/**
 * Evaluates a quadratic Bézier curve at parameter t (0 <= t <= 1).
 */
export function getQuadraticBezierPoint(
  p0: Point,
  control: Point,
  p2: Point,
  t: number
): { x: number; y: number; width: number } {
  const invT = 1 - t;
  const invT2 = invT * invT;
  const t2 = t * t;
  const twoInvTT = 2 * invT * t;

  return {
    x: invT2 * p0.x + twoInvTT * control.x + t2 * p2.x,
    y: invT2 * p0.y + twoInvTT * control.y + t2 * p2.y,
    width: invT * p0.width + t * p2.width,
  };
}

/**
 * Converts 4 Catmull-Rom spline knots (p0, p1, p2, p3) into cubic Bézier control points (c1, c2)
 * for the segment from p1 to p2.
 * Includes centripetal chord bounding to prevent overshooting or loops on tight turns.
 */
export function catmullRomToBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point
): { c1: Point; c2: Point } {
  const dChord = Math.hypot(p2.x - p1.x, p2.y - p1.y);

  let dx1 = (p2.x - p0.x) / 6;
  let dy1 = (p2.y - p0.y) / 6;
  let dx2 = (p3.x - p1.x) / 6;
  let dy2 = (p3.y - p1.y) / 6;

  // Prevent overshoot on tight turns or uneven knot spacing
  if (dChord > 0.001) {
    const maxHandle = dChord * 0.5;
    const len1 = Math.hypot(dx1, dy1);
    if (len1 > maxHandle) {
      const s = maxHandle / len1;
      dx1 *= s;
      dy1 *= s;
    }
    const len2 = Math.hypot(dx2, dy2);
    if (len2 > maxHandle) {
      const s = maxHandle / len2;
      dx2 *= s;
      dy2 *= s;
    }
  }

  const c1: Point = {
    x: p1.x + dx1,
    y: p1.y + dy1,
    pressure: p1.pressure + (p2.pressure - p0.pressure) / 6,
    width: p1.width + (p2.width - p0.width) / 6,
  };

  const c2: Point = {
    x: p2.x - dx2,
    y: p2.y - dy2,
    pressure: p2.pressure - (p3.pressure - p1.pressure) / 6,
    width: p2.width - (p3.width - p1.width) / 6,
  };

  return { c1, c2 };
}

/**
 * Draws a smooth tapered segment along a cubic Bézier curve.
 * Gives 120+ FPS instantaneous rendering like Clip Studio Paint.
 */
export function drawSmoothCubicBezierSegment(
  ctx: CanvasRenderingContext2D,
  p0: Point,
  c1: Point,
  c2: Point,
  p3: Point,
  color: string,
  isEraser: boolean = false,
  hardness: number = 1.0,
  flow: number = 1.0,
  _spacing: number = 0.1
) {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const dist = Math.hypot(dx, dy);

  if (dist < 0.15) return;

  const avgWidth = (p0.width + p3.width) / 2;
  const widthDiff = Math.abs(p3.width - p0.width);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (flow < 0.999) {
    ctx.globalAlpha = Math.max(0.01, Math.min(1.0, flow));
  }

  if (isEraser) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0, 0, 0, 1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
  }

  const effectiveHardness = Math.min(Math.max(hardness, 0.05), 1.0);
  if (effectiveHardness < 0.98) {
    ctx.shadowBlur = (1 - effectiveHardness) * Math.max(1, avgWidth * 0.45);
    ctx.shadowColor = isEraser ? 'rgba(0, 0, 0, 1)' : color;
  }

  // Fast-path: native cubic Bézier when width change is small
  if (widthDiff <= 1.5 || dist <= 12) {
    ctx.beginPath();
    ctx.lineWidth = avgWidth;
    ctx.moveTo(p0.x, p0.y);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p3.x, p3.y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Tapered stroke when width changes significantly: adaptive cubic steps
  const steps = dist > 32 ? 4 : 2;
  let prevPt = { x: p0.x, y: p0.y, width: p0.width };

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const invT = 1.0 - t;
    const invT2 = invT * invT;
    const invT3 = invT2 * invT;
    const t2 = t * t;
    const t3 = t2 * t;

    const currX = invT3 * p0.x + 3.0 * invT2 * t * c1.x + 3.0 * invT * t2 * c2.x + t3 * p3.x;
    const currY = invT3 * p0.y + 3.0 * invT2 * t * c1.y + 3.0 * invT * t2 * c2.y + t3 * p3.y;
    const currWidth = invT * p0.width + t * p3.width;

    ctx.beginPath();
    ctx.lineWidth = (prevPt.width + currWidth) / 2;
    ctx.moveTo(prevPt.x, prevPt.y);
    ctx.lineTo(currX, currY);
    ctx.stroke();

    prevPt = { x: currX, y: currY, width: currWidth };
  }

  ctx.restore();
}

/**
 * Draws a smooth tapered segment along a quadratic Bézier curve by elevating to cubic.
 */
export function drawSmoothBezierSegment(
  ctx: CanvasRenderingContext2D,
  start: Point,
  control: Point,
  end: Point,
  color: string,
  isEraser: boolean = false,
  hardness: number = 1.0,
  flow: number = 1.0,
  spacing: number = 0.1
) {
  const c1: Point = {
    x: start.x + (2.0 / 3.0) * (control.x - start.x),
    y: start.y + (2.0 / 3.0) * (control.y - start.y),
    pressure: start.pressure + (2.0 / 3.0) * (control.pressure - start.pressure),
    width: start.width + (2.0 / 3.0) * (control.width - start.width),
  };
  const c2: Point = {
    x: end.x + (2.0 / 3.0) * (control.x - end.x),
    y: end.y + (2.0 / 3.0) * (control.y - end.y),
    pressure: end.pressure + (2.0 / 3.0) * (control.pressure - end.pressure),
    width: end.width + (2.0 / 3.0) * (control.width - end.width),
  };
  drawSmoothCubicBezierSegment(ctx, start, c1, c2, end, color, isEraser, hardness, flow, spacing);
}

/**
 * Draws a single dot (e.g. on pointer down without movement).
 */
export function drawDot(
  ctx: CanvasRenderingContext2D,
  point: Point,
  color: string,
  isEraser: boolean = false,
  hardness: number = 1.0,
  flow: number = 1.0
) {
  ctx.save();
  if (flow < 0.999) {
    ctx.globalAlpha = Math.max(0.01, Math.min(1.0, flow));
  }
  if (isEraser) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = color;
  }

  const effectiveHardness = Math.min(Math.max(hardness, 0.05), 1.0);
  if (effectiveHardness < 0.98) {
    ctx.shadowBlur = (1 - effectiveHardness) * Math.max(1, point.width * 0.45);
    ctx.shadowColor = isEraser ? 'rgba(0, 0, 0, 1)' : color;
  }

  ctx.beginPath();
  ctx.arc(point.x, point.y, Math.max(0.5, point.width / 2), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

let _sharedThumbCanvas: HTMLCanvasElement | null = null;

export const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
];

export function getCanvasCompositeOperation(blendMode: BlendMode): GlobalCompositeOperation {
  switch (blendMode) {
    case 'normal':
      return 'source-over';
    case 'multiply':
      return 'multiply';
    case 'screen':
      return 'screen';
    case 'overlay':
      return 'overlay';
    case 'darken':
      return 'darken';
    case 'lighten':
      return 'lighten';
    case 'color-dodge':
      return 'color-dodge';
    case 'color-burn':
      return 'color-burn';
    case 'hard-light':
      return 'hard-light';
    case 'soft-light':
      return 'soft-light';
    case 'difference':
      return 'difference';
    case 'exclusion':
      return 'exclusion';
    default:
      return 'source-over';
  }
}

/**
 * Generates an efficient mini thumbnail (48px wide) for layer and history preview.
 */
export function createCanvasThumbnail(canvas: HTMLCanvasElement, preserveAlpha: boolean = false): string {
  try {
    if (!_sharedThumbCanvas) {
      _sharedThumbCanvas = document.createElement('canvas');
    }
    const targetW = 60;
    const targetH = Math.max(38, Math.round((canvas.height / canvas.width) * targetW));
    _sharedThumbCanvas.width = targetW;
    _sharedThumbCanvas.height = targetH;
    const tCtx = _sharedThumbCanvas.getContext('2d');
    if (!tCtx) return '';

    if (preserveAlpha) {
      tCtx.clearRect(0, 0, targetW, targetH);
      tCtx.drawImage(canvas, 0, 0, targetW, targetH);
      return _sharedThumbCanvas.toDataURL('image/png');
    } else {
      // Draw background white in thumbnail in case of opaque export
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

/**
 * Formats timestamp as HH:mm:ss for history entries.
 */
export function formatTime(timestamp: number | Date = Date.now()): string {
  const d = typeof timestamp === 'number' ? new Date(timestamp) : timestamp;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Maps a screen/viewport coordinate to canvas pixel coordinate accounting for pan, zoom, and rotation.
 * This 2D inverse affine matrix mapping guarantees 100% precision under any rotation angle.
 */
export function screenToCanvas(
  clientX: number,
  clientY: number,
  viewportRect: DOMRect,
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  dimensions: CanvasDimensions
): { x: number; y: number } {
  const vx = clientX - viewportRect.left;
  const vy = clientY - viewportRect.top;

  // Vector from canvas center in viewport to mouse
  const rx = vx - pan.x;
  const ry = vy - pan.y;

  // Unrotate by -rotation
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const unrotX = rx * cos + ry * sin;
  const unrotY = -rx * sin + ry * cos;

  // Unscale and shift by canvas center
  const x = dimensions.width / 2 + unrotX / zoom;
  const y = dimensions.height / 2 + unrotY / zoom;

  return { x, y };
}

/**
 * Maps a canvas pixel coordinate to screen/viewport coordinate accounting for pan, zoom, and rotation.
 */
export function canvasToScreen(
  canvasX: number,
  canvasY: number,
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  dimensions: CanvasDimensions
): { x: number; y: number } {
  const dx = canvasX - dimensions.width / 2;
  const dy = canvasY - dimensions.height / 2;

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

/**
 * Formats rotation angle in degrees for clean display.
 */
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

/**
 * Calculates the exact 2D affine transform matrix that maps document canvas coordinates
 * to the viewport draft overlay canvas pixels, accounting for pan, zoom, rotation, and DPR.
 */
export function getCanvasToViewportMatrix(
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  dimensions: CanvasDimensions,
  scaleX: number = 1,
  scaleY: number = scaleX
): CanvasTransformMatrix {
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const cx = dimensions.width / 2;
  const cy = dimensions.height / 2;

  const a = scaleX * zoom * cos;
  const b = scaleY * zoom * sin;
  const c = -scaleX * zoom * sin;
  const d = scaleY * zoom * cos;
  const e = scaleX * (pan.x - zoom * (cx * cos - cy * sin));
  const f = scaleY * (pan.y - zoom * (cx * sin + cy * cos));

  return { a, b, c, d, e, f };
}

/**
 * Calculates the visible bounding box of the canvas in canvas pixel coordinates
 * corresponding to the current viewport rect, pan, zoom, and rotation.
 */
export function getVisibleCanvasBounds(
  viewportRect: DOMRect,
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  dimensions: CanvasDimensions,
  margin: number = 64
): { minX: number; minY: number; maxX: number; maxY: number } {
  const c1 = screenToCanvas(viewportRect.left, viewportRect.top, viewportRect, pan, zoom, rotation, dimensions);
  const c2 = screenToCanvas(viewportRect.right, viewportRect.top, viewportRect, pan, zoom, rotation, dimensions);
  const c3 = screenToCanvas(viewportRect.right, viewportRect.bottom, viewportRect, pan, zoom, rotation, dimensions);
  const c4 = screenToCanvas(viewportRect.left, viewportRect.bottom, viewportRect, pan, zoom, rotation, dimensions);

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

/**
 * Retrieves a reusable offscreen canvas buffer for compositing dirty rectangles,
 * avoiding per-stroke memory allocation and garbage collection.
 */
export function getReusableBakeCanvas(minWidth: number, minHeight: number): HTMLCanvasElement {
  if (!_reusableBakeCanvas) {
    _reusableBakeCanvas = document.createElement('canvas');
  }
  const targetW = Math.max(256, Math.ceil(minWidth));
  const targetH = Math.max(256, Math.ceil(minHeight));
  if (_reusableBakeCanvas.width < targetW || _reusableBakeCanvas.height < targetH) {
    _reusableBakeCanvas.width = Math.max(_reusableBakeCanvas.width, targetW);
    _reusableBakeCanvas.height = Math.max(_reusableBakeCanvas.height, targetH);
  }
  return _reusableBakeCanvas;
}

/**
 * Renders an entire completed stroke path onto the target Canvas2D context.
 * Used for baking finished strokes into the high-resolution base canvas at native DPI.
 */
export function renderCompleteStroke(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  brushSettings: BrushSettings,
  tool: ToolType,
  colorMode: CanvasColorMode = 'color',
  isBgEraser: boolean = false
) {
  if (!points || points.length === 0) return;

  const isEraser = tool === 'eraser';
  const isPencil = !isEraser && (brushSettings.preset?.startsWith('pencil') ?? false);
  const strokeColor = isBgEraser ? '#ffffff' : enforceColorMode(brushSettings.color, colorMode);
  const strokeHardness = colorMode === 'monochrome' ? 1.0 : (brushSettings.hardness ?? 1.0);
  const strokeFlow = brushSettings.flow ?? 1.0;
  const strokeSpacing = brushSettings.spacing ?? 0.08;

  // Textured Custom Tip (Clip Studio Paint SUT Brush)
  if (brushSettings.customTipImage) {
    const tipOptions: TexturedBrushOptions = {
      size: brushSettings.size,
      minSizeFactor: brushSettings.minSizeFactor,
      opacity: brushSettings.opacity,
      flow: strokeFlow,
      spacing: strokeSpacing,
      thickness: brushSettings.thickness,
      thicknessVertical: brushSettings.thicknessVertical,
      angle: brushSettings.customTipAngle,
      angleDynamics: brushSettings.customTipAngleDynamics,
      rotationRandomScale: brushSettings.customTipRotationRandomScale,
      hardness: strokeHardness,
      antiAlias: brushSettings.antiAlias,
      pressureCurve: brushSettings.pressureCurve,
      velocityCurve: brushSettings.velocityCurve,
      useVelocity: brushSettings.useVelocity,
      subTips: brushSettings.subTips,
      subTipOrder: brushSettings.subTipOrder,
      subTipImages: brushSettings.subTipImages,
      spray: brushSettings.spray,
      taper: brushSettings.taper,
      colorMixing: brushSettings.colorMixing,
      amountOfPaint: brushSettings.amountOfPaint,
      densityOfPaint: brushSettings.densityOfPaint,
      colorStretch: brushSettings.colorStretch,
      mixingMode: brushSettings.mixingMode,
      wetEdge: brushSettings.wetEdge,
      wetEdgeRadius: brushSettings.wetEdgeRadius,
      wetEdgeAlphaPower: brushSettings.wetEdgeAlphaPower,
      wetEdgeValuePower: brushSettings.wetEdgeValuePower,
      grain: brushSettings.grain ?? brushSettings.textureDensity,
      paperTextureImage: brushSettings.paperTextureImage,
      paperTextureScale: brushSettings.paperTextureScale,
      paperTextureRotate: brushSettings.paperTextureRotate,
      useGpu: false,
      underlyingCanvas: ctx.canvas,
      isEraser: isEraser && !isBgEraser,
      isBgEraser,
    };
    renderCompleteTexturedStroke(ctx, points, strokeColor, brushSettings.customTipImage, tipOptions);
    return;
  }

  // Draw initial dot at points[0] to match the live preview start dot identically
  if (isPencil) {
    const grade = (brushSettings.preset as PencilGrade) || 'pencil-2b';
    drawPencilDot(
      ctx,
      points[0],
      strokeColor,
      grade,
      brushSettings.flow ?? 0.74,
      brushSettings.grain ?? 1.0,
      brushSettings.hardness
    );
  } else {
    drawDot(
      ctx,
      points[0],
      strokeColor,
      isEraser && !isBgEraser,
      strokeHardness,
      strokeFlow
    );
  }

  if (points.length === 1) {
    return;
  }

  if (isPencil) {
    const grade = (brushSettings.preset as PencilGrade) || 'pencil-2b';
    const pFlow = brushSettings.flow ?? 0.74;
    const pGrain = brushSettings.grain ?? 1.0;

    if (points.length === 2) {
      const p0 = points[0];
      const p1 = points[1];
      const { c1, c2 } = catmullRomToBezier(p0, p0, p1, p1);
      drawPencilCubicBezierSegment(ctx, p0, c1, c2, p1, strokeColor, grade, pFlow, pGrain, brushSettings.hardness);
      return;
    }

    const p0 = points[0];
    const p1 = points[1];
    const p2 = points[2];
    const first = catmullRomToBezier(p0, p0, p1, p2);
    drawPencilCubicBezierSegment(ctx, p0, first.c1, first.c2, p1, strokeColor, grade, pFlow, pGrain, brushSettings.hardness);

    for (let i = 2; i < points.length - 1; i++) {
      const seg = catmullRomToBezier(points[i - 2], points[i - 1], points[i], points[i + 1]);
      drawPencilCubicBezierSegment(ctx, points[i - 1], seg.c1, seg.c2, points[i], strokeColor, grade, pFlow, pGrain, brushSettings.hardness);
    }

    const n = points.length;
    const pPrev2 = points[n - 3];
    const pPrev = points[n - 2];
    const pLast = points[n - 1];
    const last = catmullRomToBezier(pPrev2, pPrev, pLast, pLast);
    drawPencilCubicBezierSegment(ctx, pPrev, last.c1, last.c2, pLast, strokeColor, grade, pFlow, pGrain, brushSettings.hardness);
  } else if (brushSettings.smoothing) {
    if (points.length === 2) {
      const p0 = points[0];
      const p1 = points[1];
      const { c1, c2 } = catmullRomToBezier(p0, p0, p1, p1);
      drawSmoothCubicBezierSegment(ctx, p0, c1, c2, p1, strokeColor, isEraser && !isBgEraser, strokeHardness, strokeFlow, strokeSpacing);
      return;
    }

    const p0 = points[0];
    const p1 = points[1];
    const p2 = points[2];
    const first = catmullRomToBezier(p0, p0, p1, p2);
    drawSmoothCubicBezierSegment(ctx, p0, first.c1, first.c2, p1, strokeColor, isEraser && !isBgEraser, strokeHardness, strokeFlow, strokeSpacing);

    for (let i = 2; i < points.length - 1; i++) {
      const seg = catmullRomToBezier(points[i - 2], points[i - 1], points[i], points[i + 1]);
      drawSmoothCubicBezierSegment(ctx, points[i - 1], seg.c1, seg.c2, points[i], strokeColor, isEraser && !isBgEraser, strokeHardness, strokeFlow, strokeSpacing);
    }

    const n = points.length;
    const pPrev2 = points[n - 3];
    const pPrev = points[n - 2];
    const pLast = points[n - 1];
    const last = catmullRomToBezier(pPrev2, pPrev, pLast, pLast);
    drawSmoothCubicBezierSegment(ctx, pPrev, last.c1, last.c2, pLast, strokeColor, isEraser && !isBgEraser, strokeHardness, strokeFlow, strokeSpacing);
  } else {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (strokeFlow < 0.999) {
      ctx.globalAlpha = Math.max(0.01, Math.min(1.0, strokeFlow));
    }
    if (isBgEraser) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = '#ffffff';
    } else if (isEraser) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0, 0, 0, 1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = strokeColor;
    }

    for (let i = 1; i < points.length; i++) {
      const pPrev = points[i - 1];
      const pCurr = points[i];
      ctx.lineWidth = (pPrev.width + pCurr.width) / 2;
      ctx.beginPath();
      ctx.moveTo(pPrev.x, pPrev.y);
      ctx.lineTo(pCurr.x, pCurr.y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

let sampleCanvas: HTMLCanvasElement | null = null;
let sampleCtx: CanvasRenderingContext2D | null = null;

/**
 * Samples the composited RGBA pixel color across all visible layers at (x, y).
 * Uses a cached 1x1 canvas for minimal overhead and zero latency.
 */
export function sampleCompositedColor(
  layers: LayerItem[],
  layerCanvasesMap: Map<string, HTMLCanvasElement>,
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

  if (!sampleCanvas) {
    sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 1;
    sampleCanvas.height = 1;
    sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!sampleCtx) return null;

  sampleCtx.clearRect(0, 0, 1, 1);

  // Render bottom to top (reverse of layers list)
  const renderOrder = layers.slice().reverse();
  for (const layer of renderOrder) {
    if (layer.type === 'folder' || !isLayerVisible(layer)) continue;
    const lCanvas = layerCanvasesMap.get(layer.id);
    if (!lCanvas) continue;

    sampleCtx.save();
    sampleCtx.globalAlpha = getLayerOpacity(layer);
    sampleCtx.globalCompositeOperation = (layer.blendMode || 'source-over') as GlobalCompositeOperation;
    sampleCtx.drawImage(lCanvas, px, py, 1, 1, 0, 0, 1, 1);
    sampleCtx.restore();
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

  // Alpha blend over solid white background
  const a = data[3] / 255;
  const r = Math.round(data[0] * a + 255 * (1 - a));
  const g = Math.round(data[1] * a + 255 * (1 - a));
  const b = Math.round(data[2] * a + 255 * (1 - a));

  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

