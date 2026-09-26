import { LayerItem, DirtyRect } from '../types/editor';
import { parseRgba } from './colorUtils';
import { applyScreentone } from './screentoneEngine';

export type ExpressionColor = 'color' | 'gray' | 'monochrome';

export interface LayerEffectOptions {
  frequency?: number;
  angle?: number;
  dotShape?: 'circle' | 'euclidean';
  dpi?: number;
}

// Reusable scratch canvas to avoid GC churn during multi-stage filtering
let scratchCanvas: HTMLCanvasElement | null = null;

function getScratchCanvas(width: number, height: number): HTMLCanvasElement {
  if (!scratchCanvas) {
    scratchCanvas = document.createElement('canvas');
  }
  if (scratchCanvas.width !== width || scratchCanvas.height !== height) {
    scratchCanvas.width = width;
    scratchCanvas.height = height;
  }
  return scratchCanvas;
}

/**
 * Builds a fast 256-level RGB lookup table for Clip Studio Paint style layer tinting.
 * Black (lum 0) maps to layerColor.
 * White (lum 255) maps to layerSubColor.
 */
function buildTintLut(
  layerColorHex: string,
  layerSubColorHex: string
): { r: Uint8Array; g: Uint8Array; b: Uint8Array } {
  const [lr, lg, lb] = parseRgba(layerColorHex || '#1c73c2');
  const [sr, sg, sb] = parseRgba(layerSubColorHex || '#ffffff');

  const rLut = new Uint8Array(256);
  const gLut = new Uint8Array(256);
  const bLut = new Uint8Array(256);

  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    rLut[i] = Math.round(lr * (1 - t) + sr * t);
    gLut[i] = Math.round(lg * (1 - t) + sg * t);
    bLut[i] = Math.round(lb * (1 - t) + sb * t);
  }

  return { r: rLut, g: gLut, b: bLut };
}

/**
 * Applies grayscale or monochrome expression color in-place to an ImageData buffer.
 */
export function applyExpressionColorToImageData(
  imgData: ImageData,
  mode: ExpressionColor,
  options: {
    threshold?: number;
    expressBlack?: boolean;
    expressWhite?: boolean;
  } = {}
): void {
  if (mode === 'color') return;

  const data = imgData.data;
  const len = data.length;
  const threshold = options.threshold ?? 128;
  const expressBlack = options.expressBlack ?? true;
  const expressWhite = options.expressWhite ?? true;

  if (mode === 'gray') {
    for (let i = 0; i < len; i += 4) {
      if (data[i + 3] === 0) continue;
      // High-precision fixed-point ITU-R BT.601 luminance
      const lum = (19595 * data[i] + 38470 * data[i + 1] + 7471 * data[i + 2] + 32768) >> 16;
      data[i] = lum;
      data[i + 1] = lum;
      data[i + 2] = lum;
    }
  } else if (mode === 'monochrome') {
    for (let i = 0; i < len; i += 4) {
      const a = data[i + 3];
      if (a === 0) continue;

      const lum = (19595 * data[i] + 38470 * data[i + 1] + 7471 * data[i + 2] + 32768) >> 16;
      if (lum < threshold) {
        // Dark tone
        if (expressBlack) {
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          data[i + 3] = a >= 64 ? 255 : 0;
        } else {
          data[i + 3] = 0; // transparent
        }
      } else {
        // Light tone
        if (expressWhite) {
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          data[i + 3] = a >= 64 ? 255 : 0;
        } else {
          data[i + 3] = 0; // transparent (drops white background!)
        }
      }
    }
  }
}

/**
 * Applies Clip Studio Paint style layer tint in-place to an ImageData buffer.
 */
export function applyLayerTintToImageData(
  imgData: ImageData,
  layerColor: string = '#1c73c2',
  layerSubColor: string = '#ffffff'
): void {
  const data = imgData.data;
  const len = data.length;
  const lut = buildTintLut(layerColor, layerSubColor);

  for (let i = 0; i < len; i += 4) {
    if (data[i + 3] === 0) continue;
    const lum = (19595 * data[i] + 38470 * data[i + 1] + 7471 * data[i + 2] + 32768) >> 16;
    data[i] = lut.r[lum];
    data[i + 1] = lut.g[lum];
    data[i + 2] = lut.b[lum];
  }
}

/**
 * Master layer rendering pipeline: reads from sourceCanvas, applies active effects
 * (Expression Color -> Screentone -> Layer Tint), and writes output to targetCanvas.
 */
export function applyLayerEffects(
  sourceCanvas: HTMLCanvasElement,
  targetCanvas: HTMLCanvasElement,
  layer: LayerItem,
  dpi: number = 600,
  dirtyRect?: DirtyRect
): void {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  if (width === 0 || height === 0) return;

  const sx = dirtyRect ? Math.max(0, Math.floor(dirtyRect.x)) : 0;
  const sy = dirtyRect ? Math.max(0, Math.floor(dirtyRect.y)) : 0;
  const sw = dirtyRect ? Math.min(width - sx, Math.ceil(dirtyRect.width)) : width;
  const sh = dirtyRect ? Math.min(height - sy, Math.ceil(dirtyRect.height)) : height;

  if (sw <= 0 || sh <= 0) return;

  const targetCtx = targetCanvas.getContext('2d');
  const sourceCtx = sourceCanvas.getContext('2d');
  if (!targetCtx || !sourceCtx) return;

  const hasTone = Boolean(layer.toneEnabled);
  const hasTint = Boolean(layer.layerColorEnabled);
  const exprMode = layer.expressionColor || 'color';
  const hasExpr = exprMode !== 'color';

  // If no effects are active, do a direct high-speed blit
  if (!hasTone && !hasTint && !hasExpr) {
    targetCtx.clearRect(sx, sy, sw, sh);
    targetCtx.drawImage(sourceCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
    return;
  }

  // 1. If tone is active, evaluate Screentone
  if (hasTone) {
    let toneInputCanvas = sourceCanvas;

    // If expression color is also specified, apply it to scratch first before screentone
    if (hasExpr) {
      const scratch = getScratchCanvas(width, height);
      const sCtx = scratch.getContext('2d');
      if (sCtx) {
        sCtx.clearRect(sx, sy, sw, sh);
        sCtx.drawImage(sourceCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
        const imgData = sCtx.getImageData(sx, sy, sw, sh);
        applyExpressionColorToImageData(imgData, exprMode, {
          threshold: layer.monoThreshold ?? 128,
          expressBlack: layer.monoExpressBlack ?? true,
          expressWhite: layer.monoExpressWhite ?? true,
        });
        sCtx.putImageData(imgData, sx, sy);
        toneInputCanvas = scratch;
      }
    }

    applyScreentone(
      toneInputCanvas,
      targetCanvas,
      {
        frequency: layer.toneFrequency ?? 60,
        angle: layer.toneAngle ?? 45,
        dotShape: layer.toneDotShape ?? 'circle',
        dpi,
        densityType: layer.toneDensityType ?? 'specified',
        specifiedDensity: Math.max(0, Math.min(1, (layer.toneDensity ?? 40) / 100)),
        renderBackend: 'auto',
      },
      dirtyRect
    );

    // If Layer Color is also enabled with screentone, tint the resulting tone
    if (hasTint) {
      const targetData = targetCtx.getImageData(sx, sy, sw, sh);
      applyLayerTintToImageData(targetData, layer.layerColor, layer.layerSubColor);
      targetCtx.putImageData(targetData, sx, sy);
    }

    return;
  }

  // 2. Direct Expression Color and/or Tint pipeline
  const imgData = sourceCtx.getImageData(sx, sy, sw, sh);

  if (hasExpr) {
    applyExpressionColorToImageData(imgData, exprMode, {
      threshold: layer.monoThreshold ?? 128,
      expressBlack: layer.monoExpressBlack ?? true,
      expressWhite: layer.monoExpressWhite ?? true,
    });
  }

  if (hasTint) {
    applyLayerTintToImageData(imgData, layer.layerColor, layer.layerSubColor);
  }

  targetCtx.putImageData(imgData, sx, sy);
}

/**
 * Permanently converts an HTMLCanvasElement in-place to the target expression color.
 */
export function convertCanvasExpressionColor(
  canvas: HTMLCanvasElement,
  targetMode: ExpressionColor,
  options: {
    threshold?: number;
    expressBlack?: boolean;
    expressWhite?: boolean;
  } = {}
): ImageData | null {
  const ctx = canvas.getContext('2d');
  if (!ctx || canvas.width === 0 || canvas.height === 0) return null;

  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  applyExpressionColorToImageData(imgData, targetMode, options);
  ctx.putImageData(imgData, 0, 0);
  return imgData;
}
