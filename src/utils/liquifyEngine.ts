import { CanvasSelection } from '../types/editor';

export type LiquifyMode =
  | 'push'
  | 'expand'
  | 'pinch'
  | 'push-left'
  | 'push-right'
  | 'twirl-cw'
  | 'twirl-ccw'
  | 'reconstruct';

export interface LiquifySettings {
  mode: LiquifyMode;
  size: number; // 5 to 500 px
  strength: number; // 1 to 100
  hardness: number; // 0 to 100
  usePressure: boolean;
}

export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LiquifyStepParams {
  canvas: HTMLCanvasElement;
  sourceCanvas?: HTMLCanvasElement | null;
  cx: number;
  cy: number;
  prevX: number;
  prevY: number;
  settings: LiquifySettings;
  pressure?: number;
  initialImageData?: ImageData | null;
  selectionMask?: Uint8Array | null;
}

/**
 * Computes radial falloff weight for liquify deformation.
 * Zero at boundaries (u >= 1), smooth cubic bell curve shaped by hardness.
 */
function computeFalloffWeight(dist: number, radius: number, hardnessFactor: number): number {
  const u = dist / radius;
  if (u >= 1) return 0;
  const t = 1 - u * u;
  // Blend between cubic smoothstep and linear based on hardness
  return (1 - hardnessFactor) * (t * t) + hardnessFactor * t;
}

/**
 * Executes a single localized, bilinear-interpolated liquify deformation step on the target canvas.
 * Highly optimized: only processes the local region of interest (ROI) bounding box.
 */
export function applyLiquifyStep(params: LiquifyStepParams): DirtyRect | null {
  const {
    canvas,
    sourceCanvas,
    cx,
    cy,
    prevX,
    prevY,
    settings,
    pressure = 1.0,
    initialImageData,
    selectionMask,
  } = params;

  const width = canvas.width;
  const height = canvas.height;
  const radius = Math.max(2, Math.round(settings.size / 2));
  const radiusSq = radius * radius;

  // Maximum displacement padding to ensure subpixel backward sampling stays within ROI
  const pad = Math.min(32, Math.max(4, Math.ceil(radius * 0.2)));
  const minX = Math.max(0, Math.floor(cx - radius - pad));
  const minY = Math.max(0, Math.floor(cy - radius - pad));
  const maxX = Math.min(width, Math.ceil(cx + radius + pad));
  const maxY = Math.min(height, Math.ceil(cy + radius + pad));

  const roiW = maxX - minX;
  const roiH = maxY - minY;
  if (roiW <= 0 || roiH <= 0) return null;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const srcImageData = ctx.getImageData(minX, minY, roiW, roiH);
  const src = srcImageData.data;

  // Clone source buffer for destination write
  const dstImageData = ctx.createImageData(roiW, roiH);
  const dst = dstImageData.data;
  dst.set(src);

  const hardnessFactor = Math.max(0, Math.min(1, settings.hardness / 100));
  const effectivePressure = settings.usePressure ? Math.max(0.1, pressure) : 1.0;
  const strengthFactor = (settings.strength / 100) * effectivePressure;

  const vx = cx - prevX;
  const vy = cy - prevY;
  const vLen = Math.hypot(vx, vy);

  // Direction unit vector for push modes
  let ux = 0;
  let uy = 0;
  if (vLen > 0.0001) {
    ux = vx / vLen;
    uy = vy / vLen;
  }

  const mode = settings.mode;
  const isPushMode = mode === 'push' || mode === 'push-left' || mode === 'push-right';
  if (isPushMode && vLen < 0.0001) {
    return null;
  }

  // Pre-calculate twirl angles if in twirl mode
  const twirlBaseAngle = (mode === 'twirl-cw' ? 1 : -1) * (strengthFactor * 0.45);

  const initData = initialImageData?.data;
  const initW = initialImageData?.width ?? width;

  for (let ry = 0; ry < roiH; ry++) {
    const py = minY + ry;
    const dy = py - cy;
    const rowOffset = ry * roiW * 4;

    for (let rx = 0; rx < roiW; rx++) {
      const px = minX + rx;
      const dx = px - cx;
      const distSq = dx * dx + dy * dy;

      if (distSq >= radiusSq) {
        continue;
      }

      // Check selection mask
      if (selectionMask && selectionMask[py * width + px] === 0) {
        continue;
      }

      const dist = Math.sqrt(distSq);
      const weight = computeFalloffWeight(dist, radius, hardnessFactor);
      if (weight <= 0) continue;

      const dstIdx = rowOffset + rx * 4;

      if (mode === 'reconstruct') {
        if (!initData) continue;
        const alpha = Math.min(1, strengthFactor * weight * 0.35);
        const initIdx = (py * initW + px) * 4;
        dst[dstIdx] = Math.round(dst[dstIdx] * (1 - alpha) + initData[initIdx] * alpha);
        dst[dstIdx + 1] = Math.round(dst[dstIdx + 1] * (1 - alpha) + initData[initIdx + 1] * alpha);
        dst[dstIdx + 2] = Math.round(dst[dstIdx + 2] * (1 - alpha) + initData[initIdx + 2] * alpha);
        dst[dstIdx + 3] = Math.round(dst[dstIdx + 3] * (1 - alpha) + initData[initIdx + 3] * alpha);
        continue;
      }

      let srcCanvasX = px;
      let srcCanvasY = py;

      if (mode === 'push') {
        // Displace along stroke vector
        const pushAmount = vLen * strengthFactor * weight;
        srcCanvasX = px - ux * pushAmount;
        srcCanvasY = py - uy * pushAmount;
      } else if (mode === 'push-left') {
        // Displace perpendicular left (-uy, ux)
        const pushAmount = Math.max(1.5, vLen) * strengthFactor * weight;
        srcCanvasX = px + uy * pushAmount;
        srcCanvasY = py - ux * pushAmount;
      } else if (mode === 'push-right') {
        // Displace perpendicular right (uy, -ux)
        const pushAmount = Math.max(1.5, vLen) * strengthFactor * weight;
        srcCanvasX = px - uy * pushAmount;
        srcCanvasY = py + ux * pushAmount;
      } else if (mode === 'expand') {
        // Push outward (backward mapping pulls from closer to center)
        const factor = strengthFactor * weight * 0.3;
        srcCanvasX = cx + dx * (1 - factor);
        srcCanvasY = cy + dy * (1 - factor);
      } else if (mode === 'pinch') {
        // Pull inward (backward mapping pulls from further from center)
        const factor = strengthFactor * weight * 0.3;
        srcCanvasX = cx + dx * (1 + factor);
        srcCanvasY = cy + dy * (1 + factor);
      } else if (mode === 'twirl-cw' || mode === 'twirl-ccw') {
        const theta = twirlBaseAngle * weight;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        // Inverse rotation
        srcCanvasX = cx + dx * cosT + dy * sinT;
        srcCanvasY = cy - dx * sinT + dy * cosT;
      }

      // Convert from global canvas coords to ROI local coords for sampling
      const localSx = Math.max(0, Math.min(roiW - 1.0001, srcCanvasX - minX));
      const localSy = Math.max(0, Math.min(roiH - 1.0001, srcCanvasY - minY));

      const x0 = Math.floor(localSx);
      const y0 = Math.floor(localSy);
      const x1 = Math.min(roiW - 1, x0 + 1);
      const y1 = Math.min(roiH - 1, y0 + 1);

      const fx = localSx - x0;
      const fy = localSy - y0;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * roiW + x0) * 4;
      const i10 = (y0 * roiW + x1) * 4;
      const i01 = (y1 * roiW + x0) * 4;
      const i11 = (y1 * roiW + x1) * 4;

      dst[dstIdx] = Math.round(w00 * src[i00] + w10 * src[i10] + w01 * src[i01] + w11 * src[i11]);
      dst[dstIdx + 1] = Math.round(w00 * src[i00 + 1] + w10 * src[i10 + 1] + w01 * src[i01 + 1] + w11 * src[i11 + 1]);
      dst[dstIdx + 2] = Math.round(w00 * src[i00 + 2] + w10 * src[i10 + 2] + w01 * src[i01 + 2] + w11 * src[i11 + 2]);
      dst[dstIdx + 3] = Math.round(w00 * src[i00 + 3] + w10 * src[i10 + 3] + w01 * src[i01 + 3] + w11 * src[i11 + 3]);
    }
  }

  ctx.putImageData(dstImageData, minX, minY);

  // Synchronize secondary / source canvas if present
  if (sourceCanvas && sourceCanvas !== canvas) {
    const sCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    sCtx?.putImageData(dstImageData, minX, minY);
  }

  return { x: minX, y: minY, width: roiW, height: roiH };
}

/**
 * Creates a binary selection mask for active selection.
 */
export function createLiquifySelectionMask(
  selection: CanvasSelection | null,
  width: number,
  height: number
): Uint8Array | null {
  if (!selection) return null;

  const mask = new Uint8Array(width * height);
  const { bounds, type, polygon } = selection;

  if (type === 'rect') {
    const x0 = Math.max(0, Math.floor(bounds.x));
    const y0 = Math.max(0, Math.floor(bounds.y));
    const x1 = Math.min(width, Math.ceil(bounds.x + bounds.width));
    const y1 = Math.min(height, Math.ceil(bounds.y + bounds.height));

    for (let y = y0; y < y1; y++) {
      const rowOffset = y * width;
      mask.fill(1, rowOffset + x0, rowOffset + x1);
    }
    return mask;
  }

  if (type === 'lasso' && polygon && polygon.length >= 3) {
    const offCanvas = document.createElement('canvas');
    offCanvas.width = width;
    offCanvas.height = height;
    const ctx = offCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.beginPath();
    ctx.moveTo(polygon[0].x, polygon[0].y);
    for (let i = 1; i < polygon.length; i++) {
      ctx.lineTo(polygon[i].x, polygon[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    const imgData = ctx.getImageData(0, 0, width, height);
    const d = imgData.data;
    const totalPixels = width * height;
    for (let i = 0; i < totalPixels; i++) {
      if (d[i * 4 + 3] > 64) {
        mask[i] = 1;
      }
    }
    return mask;
  }

  return null;
}
