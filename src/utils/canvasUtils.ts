import { Point, CanvasDimensions, BlendMode, ToolType, BrushSettings, CanvasColorMode, LayerItem } from '../types/editor';
import { enforceColorMode } from './colorUtils';
import { drawPencilCubicBezierSegment, drawPencilDot, PencilGrade } from './pencilEngine';
import {
  renderCompleteTexturedStroke,
  TexturedBrushOptions,
  drawRadialCubicBezierSegment,
  drawRadialDot,
  centripetalCatmullRomToBezier,
  renderCompleteRadialStroke,
  RadialMixingOptions,
} from './stampEngine';
import { LayerPixelSampler, PaintReservoir } from './colorMixingEngine';
import {
  evaluateFastSpline,
  applyCspPostCorrection,
} from '../engine/CspBrushEngine';

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
 * Converts 4 Catmull-Rom spline knots (p0, p1, p2, p3) into cubic Bézier control points (c1, c2).
 */
export function catmullRomToBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point
): { c1: Point; c2: Point } {
  return centripetalCatmullRomToBezier(p0, p1, p2, p3);
}

/**
 * Draws a smooth tapered segment along a cubic Bézier curve using analytical radial dabbing.
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
  spacing: number = 0.06,
  remainderDist: number = 0,
  thickness: number = 1.0,
  angleRad: number = 0,
  mixingOptions?: RadialMixingOptions
): number {
  return drawRadialCubicBezierSegment(
    ctx,
    p0,
    c1,
    c2,
    p3,
    color,
    hardness,
    flow,
    spacing,
    isEraser,
    false,
    remainderDist,
    thickness,
    angleRad,
    mixingOptions
  );
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
  spacing: number = 0.06,
  remainderDist: number = 0
): number {
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
  return drawSmoothCubicBezierSegment(ctx, start, c1, c2, end, color, isEraser, hardness, flow, spacing, remainderDist);
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
  flow: number = 1.0,
  mixingOptions?: RadialMixingOptions,
  thickness: number = 1.0,
  angleRad: number = 0
) {
  drawRadialDot(ctx, point, color, hardness, flow, isEraser, false, mixingOptions, thickness, angleRad);
}

let _sharedThumbCanvas: HTMLCanvasElement | null = null;

export const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: 'pass-through', label: 'Pass Through' },
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'linear-burn', label: 'Linear Burn' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'darken', label: 'Darken' },
  { value: 'screen', label: 'Screen' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'color-dodge-glow', label: 'Glow Dodge' },
  { value: 'add-glow', label: 'Add (Glow)' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'difference', label: 'Difference' },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'divide', label: 'Divide' },
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
      return 'darken';
    case 'lighten':
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
      return 'hard-light';
    case 'soft-light':
      return 'soft-light';
    case 'difference':
    case 'divide':
      return 'difference';
    case 'exclusion':
      return 'exclusion';
    default:
      return 'source-over';
  }
}

/**
 * Generates an efficient mini thumbnail (60px wide) for layer and history preview.
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

  const rx = vx - pan.x;
  const ry = vy - pan.y;

  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const unrotX = rx * cos + ry * sin;
  const unrotY = -rx * sin + ry * cos;

  const x = dimensions.width / 2 + unrotX / zoom;
  const y = dimensions.height / 2 + unrotY / zoom;

  return { x, y };
}

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

export function renderCompleteStroke(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  brushSettings: BrushSettings,
  tool: ToolType,
  colorMode: CanvasColorMode = 'color',
  isBgEraser: boolean = false,
  underlyingCanvas?: HTMLCanvasElement,
  alphaLocked: boolean = false
) {
  if (!points || points.length === 0) return;

  const isMono = colorMode === 'monochrome';
  const postCorrLevel = brushSettings.postCorrection ?? 0;
  const postCorrectedPoints =
    postCorrLevel > 0 && points.length >= 3
      ? applyCspPostCorrection(points, postCorrLevel, brushSettings.sharpCorners !== false)
      : points;

  const effectivePoints = isMono
    ? postCorrectedPoints.map((p) => (p.width < 1.25 ? { ...p, width: 1.25 } : p))
    : postCorrectedPoints;

  const isEraser = tool === 'eraser';
  const isPencil = !isEraser && !brushSettings.customTipImage && (brushSettings.preset?.startsWith('pencil') ?? false);
  const strokeColor = isBgEraser ? '#ffffff' : enforceColorMode(brushSettings.color, colorMode);
  const strokeHardness = isMono ? 1.0 : (brushSettings.hardness ?? 1.0);
  const strokeFlow = isMono ? 1.0 : (brushSettings.flow ?? 1.0);
  const strokeSpacing = brushSettings.spacing ?? 0.08;
  const isTransparentInk = Boolean(brushSettings.isTransparentInk);
  const useTilt = Boolean(brushSettings.useTilt);

  // Textured Custom Tip (Clip Studio Paint SUT Brush & Procedural Tip Presets)
  if (brushSettings.customTipImage) {
    const tipOptions: TexturedBrushOptions = {
      size: brushSettings.size,
      minSizeFactor: brushSettings.minSizeFactor,
      opacity: brushSettings.opacity,
      flow: strokeFlow,
      adjustDensityByGap: brushSettings.adjustDensityByGap,
      blendTipsMode: brushSettings.blendTipsMode,
      spacing: strokeSpacing,
      thickness: brushSettings.thickness,
      thicknessVertical: brushSettings.thicknessVertical,
      flipH: brushSettings.flipH,
      flipV: brushSettings.flipV,
      isColorTip: brushSettings.isColorTip,
      angle: brushSettings.customTipAngle,
      angleDynamics: brushSettings.customTipAngleDynamics,
      rotationRandomScale: brushSettings.customTipRotationRandomScale,
      hardness: strokeHardness,
      antiAlias: isMono ? 0 : brushSettings.antiAlias,
      pressureCurve: brushSettings.pressureCurve,
      velocityCurve: brushSettings.velocityCurve,
      usePressure: brushSettings.usePressure,
      useVelocity: brushSettings.useVelocity,
      useTilt,
      sizeSensor: brushSettings.sizeSensor,
      opacitySensor: brushSettings.opacitySensor,
      densitySensor: brushSettings.densitySensor,
      subTips: brushSettings.subTips,
      subTipOrder: brushSettings.subTipOrder,
      subTipImages: brushSettings.subTipImages,
      spray: brushSettings.spray,
      taper: brushSettings.taper,
      colorMixing: brushSettings.colorMixing,
      perceptualMixing: brushSettings.perceptualMixing,
      amountOfPaint: brushSettings.amountOfPaint,
      densityOfPaint: brushSettings.densityOfPaint,
      colorStretch: brushSettings.colorStretch,
      mixingMode: brushSettings.mixingMode,
      wetEdge: brushSettings.wetEdge,
      wetEdgeRadius: brushSettings.wetEdgeRadius,
      wetEdgeAlphaPower: brushSettings.wetEdgeAlphaPower,
      wetEdgeValuePower: brushSettings.wetEdgeValuePower,
      grain: brushSettings.grain ?? brushSettings.textureDensity,
      paperTextureMode: brushSettings.paperTextureMode,
      paperTextureBrightness: brushSettings.paperTextureBrightness,
      paperTextureContrast: brushSettings.paperTextureContrast,
      paperTextureInverted: brushSettings.paperTextureInverted,
      paperTextureImage: brushSettings.paperTextureImage,
      paperTextureScale: brushSettings.paperTextureScale,
      paperTextureRotate: brushSettings.paperTextureRotate,
      dualBrush: brushSettings.dualBrush,
      dualTipImage: brushSettings.dualTipImage,
      dualBrushCompositeMode: brushSettings.dualBrushCompositeMode,
      useGpu: Boolean(brushSettings.useGpu),
      underlyingCanvas: underlyingCanvas || ctx.canvas,
      sampler: underlyingCanvas ? new LayerPixelSampler(underlyingCanvas) : undefined,
      reservoir: brushSettings.colorMixing && !isEraser ? new PaintReservoir(strokeColor) : undefined,
      isEraser: isEraser && !isBgEraser,
      isBgEraser,
      alphaLocked,
      isTransparentInk,
      dynamics: brushSettings.dynamics,
      secondaryColor: brushSettings.secondaryColor,
    };
    renderCompleteTexturedStroke(ctx, effectivePoints, strokeColor, brushSettings.customTipImage, tipOptions);
    return;
  }

  const radialMixing: RadialMixingOptions = {
    colorMixing: brushSettings.colorMixing,
    perceptualMixing: brushSettings.perceptualMixing,
    amountOfPaint: brushSettings.amountOfPaint,
    densityOfPaint: brushSettings.densityOfPaint,
    colorStretch: brushSettings.colorStretch,
    mixingMode: brushSettings.mixingMode,
    underlyingCanvas: underlyingCanvas || ctx.canvas,
    sampler: brushSettings.colorMixing && underlyingCanvas ? new LayerPixelSampler(underlyingCanvas) : undefined,
    reservoir: brushSettings.colorMixing && !isEraser ? new PaintReservoir(strokeColor) : undefined,
    alphaLocked,
    isTransparentInk,
    dynamics: brushSettings.dynamics,
    secondaryColor: brushSettings.secondaryColor,
    useGpu: Boolean(brushSettings.useGpu),
    dualBrush: brushSettings.dualBrush,
    dualTipImage: brushSettings.dualTipImage,
    dualBrushCompositeMode: brushSettings.dualBrushCompositeMode,
    useTilt,
    thicknessVertical: brushSettings.thicknessVertical,
    flipH: brushSettings.flipH,
    flipV: brushSettings.flipV,
    antiAlias: isMono ? 0 : brushSettings.antiAlias,
    angleDynamics: brushSettings.customTipAngleDynamics,
    rotationRandomScale: brushSettings.customTipRotationRandomScale,
    adjustDensityByGap: brushSettings.adjustDensityByGap,
    blendTipsMode: brushSettings.blendTipsMode,
    grain: brushSettings.grain ?? brushSettings.textureDensity,
    paperTextureMode: brushSettings.paperTextureMode,
    paperTextureBrightness: brushSettings.paperTextureBrightness,
    paperTextureContrast: brushSettings.paperTextureContrast,
    paperTextureInverted: brushSettings.paperTextureInverted,
    paperTextureImage: brushSettings.paperTextureImage,
    paperTextureScale: brushSettings.paperTextureScale,
    paperTextureRotate: brushSettings.paperTextureRotate,
    sizeSensor: brushSettings.sizeSensor,
    opacitySensor: brushSettings.opacitySensor,
    densitySensor: brushSettings.densitySensor,
    taper: brushSettings.taper,
  };

  if (isPencil) {
    const grade = (brushSettings.preset as PencilGrade) || 'pencil-2b';
    const pencilTilt = brushSettings.useTilt ?? true;
    drawPencilDot(
      ctx,
      effectivePoints[0],
      strokeColor,
      grade,
      isMono ? 1.0 : (brushSettings.flow ?? 0.74),
      brushSettings.grain ?? 1.0,
      strokeHardness,
      alphaLocked,
      isTransparentInk
    );

    if (effectivePoints.length === 1) return;

    const pFlow = isMono ? 1.0 : (brushSettings.flow ?? 0.74);
    const pGrain = brushSettings.grain ?? 1.0;
    let accDist = Math.max(0.25, effectivePoints[0].width * (brushSettings.spacing ?? 0.07));

    if (effectivePoints.length === 2) {
      const p0 = effectivePoints[0];
      const p1 = effectivePoints[1];
      const { c1, c2 } = catmullRomToBezier(p0, p0, p1, p1);
      drawPencilCubicBezierSegment(ctx, p0, c1, c2, p1, strokeColor, grade, pFlow, pGrain, strokeHardness, accDist, alphaLocked, isTransparentInk, pencilTilt);
      return;
    }

    const p0 = effectivePoints[0];
    const p1 = effectivePoints[1];
    const p2 = effectivePoints[2];
    const first = catmullRomToBezier(p0, p0, p1, p2);
    accDist = drawPencilCubicBezierSegment(ctx, p0, first.c1, first.c2, p1, strokeColor, grade, pFlow, pGrain, strokeHardness, accDist, alphaLocked, isTransparentInk, pencilTilt);

    for (let i = 2; i < effectivePoints.length - 1; i++) {
      const seg = catmullRomToBezier(effectivePoints[i - 2], effectivePoints[i - 1], effectivePoints[i], effectivePoints[i + 1]);
      accDist = drawPencilCubicBezierSegment(ctx, effectivePoints[i - 1], seg.c1, seg.c2, effectivePoints[i], strokeColor, grade, pFlow, pGrain, strokeHardness, accDist, alphaLocked, isTransparentInk, pencilTilt);
    }

    const n = effectivePoints.length;
    const pPrev2 = effectivePoints[n - 3];
    const pPrev = effectivePoints[n - 2];
    const pLast = effectivePoints[n - 1];
    const last = catmullRomToBezier(pPrev2, pPrev, pLast, pLast);
    drawPencilCubicBezierSegment(ctx, pPrev, last.c1, last.c2, pLast, strokeColor, grade, pFlow, pGrain, strokeHardness, accDist, alphaLocked, isTransparentInk, pencilTilt);
    return;
  }

  const baseAngleRad = ((brushSettings.customTipAngle ?? 0) * Math.PI) / 180;
  const baseThickness = brushSettings.thickness ?? 1.0;

  if (effectivePoints.length === 1) {
    drawDot(
      ctx,
      effectivePoints[0],
      strokeColor,
      isEraser && !isBgEraser,
      strokeHardness,
      strokeFlow,
      radialMixing,
      baseThickness,
      baseAngleRad
    );
    return;
  }

  renderCompleteRadialStroke(
    ctx,
    effectivePoints,
    strokeColor,
    strokeHardness,
    strokeFlow,
    strokeSpacing,
    isEraser && !isBgEraser,
    isBgEraser,
    baseThickness,
    baseAngleRad,
    radialMixing
  );
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

  const renderOrder = layers.slice().reverse();
  for (const layer of renderOrder) {
    if (layer.type === 'folder' || !isLayerVisible(layer)) continue;
    const lCanvas = layerCanvasesMap.get(layer.id);
    if (!lCanvas) continue;

    sampleCtx.save();
    sampleCtx.globalAlpha = getLayerOpacity(layer);
    sampleCtx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
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

  const a = data[3] / 255;
  const r = Math.round(data[0] * a + 255 * (1 - a));
  const g = Math.round(data[1] * a + 255 * (1 - a));
  const b = Math.round(data[2] * a + 255 * (1 - a));

  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
