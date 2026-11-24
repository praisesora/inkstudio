import { DirtyRect, Point2D } from '../types/editor';

export interface PixelBuffer {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export interface AffineTransformParams {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // degrees
  flipH: boolean;
  flipV: boolean;
}

const PI = Math.PI;
const LANCZOS_A = 3;
const LANCZOS_LUT_RES = 1024;
const LANCZOS_LUT_SIZE = LANCZOS_A * LANCZOS_LUT_RES + 2;

const LANCZOS3_LUT = (() => {
  const lut = new Float32Array(LANCZOS_LUT_SIZE);
  lut[0] = 1.0;
  for (let i = 1; i < LANCZOS_LUT_SIZE; i++) {
    const x = i / LANCZOS_LUT_RES;
    if (x >= LANCZOS_A) {
      lut[i] = 0.0;
    } else {
      const pix = PI * x;
      lut[i] = (LANCZOS_A * Math.sin(pix) * Math.sin(pix / LANCZOS_A)) / (pix * pix);
    }
  }
  return lut;
})();

/**
 * Evaluates Lanczos-3 kernel weight for `x` (exact zero for |x| >= 3).
 */
export function lanczos3Weight(x: number): number {
  const ax = x < 0 ? -x : x;
  if (ax < 1e-6) return 1.0;
  if (ax >= LANCZOS_A) return 0.0;
  const fIdx = ax * LANCZOS_LUT_RES;
  const idx = fIdx | 0;
  const frac = fIdx - idx;
  return LANCZOS3_LUT[idx] + (LANCZOS3_LUT[idx + 1] - LANCZOS3_LUT[idx]) * frac;
}

/**
 * Normalizes an angle in degrees to [0, 360).
 */
export function normalizeRotationDeg(deg: number): number {
  const m = ((deg % 360) + 360) % 360;
  return Math.abs(m - 360) < 1e-6 ? 0 : m;
}

/**
 * Returns the exact orthogonal rotation step (0, 90, 180, 270) if `deg` is within epsilon, else null.
 */
export function getExactQuarterTurnDeg(deg: number): 0 | 90 | 180 | 270 | null {
  const m = normalizeRotationDeg(deg);
  if (Math.abs(m) < 1e-5 || Math.abs(m - 360) < 1e-5) return 0;
  if (Math.abs(m - 90) < 1e-5) return 90;
  if (Math.abs(m - 180) < 1e-5) return 180;
  if (Math.abs(m - 270) < 1e-5) return 270;
  return null;
}

export interface LosslessAffineSpec {
  quarterTurn: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  destOriginX: number;
  destOriginY: number;
  destWidth: number;
  destHeight: number;
}

/**
 * Detects whether an affine transform is a 1:1 lossless integer pixel permutation
 * (pure move, flip H/V, and/or exact 90/180/270 rotation with unchanged dimensions).
 * For 90/270 rotations of odd x even layers, snaps the rotated origin to an integer
 * pixel grid so brush strokes never suffer a 0.5px subpixel blur.
 */
export function resolveLosslessAffineSpec(
  srcW: number,
  srcH: number,
  params: AffineTransformParams
): LosslessAffineSpec | null {
  if (srcW <= 0 || srcH <= 0) return null;
  if (
    Math.abs(params.width - srcW) > 1e-5 ||
    Math.abs(params.height - srcH) > 1e-5
  ) {
    return null;
  }

  const quarterTurn = getExactQuarterTurnDeg(params.rotation);
  if (quarterTurn === null) return null;

  if (quarterTurn === 0 || quarterTurn === 180) {
    const rx = Math.round(params.x);
    const ry = Math.round(params.y);
    if (Math.abs(params.x - rx) > 1e-5 || Math.abs(params.y - ry) > 1e-5) {
      return null;
    }
    return {
      quarterTurn,
      flipH: params.flipH,
      flipV: params.flipV,
      destOriginX: rx,
      destOriginY: ry,
      destWidth: srcW,
      destHeight: srcH,
    };
  }

  // 90 or 270 degree rotation: snap rotated top-left to integer grid to prevent
  // 0.5px half-pixel blurring when srcW and srcH have opposite parity.
  const midX = params.x + params.width * 0.5;
  const midY = params.y + params.height * 0.5;
  const rawOriginX = midX - srcH * 0.5;
  const rawOriginY = midY - srcW * 0.5;
  const snappedX = Math.round(rawOriginX);
  const snappedY = Math.round(rawOriginY);
  // Allow exact integer or half-integer (from odd/even parity)
  if (Math.abs(rawOriginX - snappedX) > 0.5001 || Math.abs(rawOriginY - snappedY) > 0.5001) {
    return null;
  }

  return {
    quarterTurn,
    flipH: params.flipH,
    flipV: params.flipV,
    destOriginX: snappedX,
    destOriginY: snappedY,
    destWidth: srcH,
    destHeight: srcW,
  };
}

/**
 * Performs a bit-exact lossless straight-alpha copy of a chunk of `source` under `spec`.
 */
export function renderLosslessAffineChunk(
  source: PixelBuffer,
  spec: LosslessAffineSpec,
  chunkX: number,
  chunkY: number,
  chunkW: number,
  chunkH: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(chunkW * chunkH * 4);
  const sw = source.width;
  const sh = source.height;
  const srcData = source.data;
  const { quarterTurn, flipH, flipV, destOriginX, destOriginY, destWidth, destHeight } = spec;

  const x0 = Math.max(0, destOriginX - chunkX);
  const y0 = Math.max(0, destOriginY - chunkY);
  const x1 = Math.min(chunkW, destOriginX + destWidth - chunkX);
  const y1 = Math.min(chunkH, destOriginY + destHeight - chunkY);
  if (x1 <= x0 || y1 <= y0) return out;

  // Ultra-fast row copy for pure integer translation (no flip, no rotation)
  if (quarterTurn === 0 && !flipH && !flipV) {
    const copyBytes = (x1 - x0) * 4;
    for (let cy = y0; cy < y1; cy++) {
      const sy = chunkY + cy - destOriginY;
      const sx = chunkX + x0 - destOriginX;
      const srcOff = (sy * sw + sx) * 4;
      const dstOff = (cy * chunkW + x0) * 4;
      out.set(srcData.subarray(srcOff, srcOff + copyBytes), dstOff);
    }
    return out;
  }

  for (let cy = y0; cy < y1; cy++) {
    const ly = chunkY + cy - destOriginY;
    let dstOff = (cy * chunkW + x0) * 4;
    for (let cx = x0; cx < x1; cx++, dstOff += 4) {
      const lx = chunkX + cx - destOriginX;
      let fx: number;
      let fy: number;
      if (quarterTurn === 0) {
        fx = lx;
        fy = ly;
      } else if (quarterTurn === 90) {
        // Forward: (fx, fy) -> (sh - 1 - fy, fx)  =>  Inverse: fx = ly, fy = sh - 1 - lx
        fx = ly;
        fy = sh - 1 - lx;
      } else if (quarterTurn === 180) {
        fx = sw - 1 - lx;
        fy = sh - 1 - ly;
      } else {
        // 270 CW: Forward: (fx, fy) -> (fy, sw - 1 - fx) => Inverse: fx = sw - 1 - ly, fy = lx
        fx = sw - 1 - ly;
        fy = lx;
      }

      const sx = flipH ? sw - 1 - fx : fx;
      const sy = flipV ? sh - 1 - fy : fy;
      if (sx < 0 || sx >= sw || sy < 0 || sy >= sh) continue;

      const srcOff = (sy * sw + sx) * 4;
      out[dstOff] = srcData[srcOff];
      out[dstOff + 1] = srcData[srcOff + 1];
      out[dstOff + 2] = srcData[srcOff + 2];
      out[dstOff + 3] = srcData[srcOff + 3];
    }
  }

  return out;
}

/**
 * Separable 1D Lanczos-3 resample along X in float premultiplied RGBA.
 * Used both as a pre-downsampler for extreme >3x shrink ratios and for fast axis-aligned scaling.
 */
function resampleHorizontalLanczos3(
  src: PixelBuffer,
  targetW: number,
  flipH: boolean
): PixelBuffer {
  const sw = src.width;
  const sh = src.height;
  const dstW = Math.max(1, targetW);
  const out = new Uint8ClampedArray(dstW * sh * 4);
  const srcData = src.data;

  const scale = sw / dstW;
  const filterScale = scale > 1.0 ? scale : 1.0;
  const invFilterScale = 1.0 / filterScale;
  const support = LANCZOS_A * filterScale;
  const applyAntiRing = filterScale <= 1.25;

  // Precompute horizontal tap weights per destination column
  const maxTaps = Math.ceil(support * 2) + 3;
  const colStarts = new Int32Array(dstW);
  const colCounts = new Int32Array(dstW);
  const colCenterFloor = new Int32Array(dstW);
  const colWeights = new Float32Array(dstW * maxTaps);

  for (let dx = 0; dx < dstW; dx++) {
    const u = flipH ? dstW - 0.5 - dx : dx + 0.5;
    const srcX = u * scale - 0.5;
    colCenterFloor[dx] = Math.floor(srcX);
    const left = Math.ceil(srcX - support);
    const right = Math.floor(srcX + support);
    colStarts[dx] = left;
    const count = Math.max(0, right - left + 1);
    colCounts[dx] = count;

    let sumW = 0;
    const wBase = dx * maxTaps;
    for (let k = 0; k < count; k++) {
      const w = lanczos3Weight((left + k - srcX) * invFilterScale);
      colWeights[wBase + k] = w;
      sumW += w;
    }
    if (Math.abs(sumW) > 1e-6) {
      const invSum = 1.0 / sumW;
      for (let k = 0; k < count; k++) {
        colWeights[wBase + k] *= invSum;
      }
    }
  }

  for (let y = 0; y < sh; y++) {
    const srcRow = y * sw * 4;
    const dstRow = y * dstW * 4;
    for (let dx = 0; dx < dstW; dx++) {
      const left = colStarts[dx];
      const count = colCounts[dx];
      const wBase = dx * maxTaps;

      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let k = 0; k < count; k++) {
        const ix = left + k;
        if (ix < 0 || ix >= sw) continue;
        const off = srcRow + (ix << 2);
        const a = srcData[off + 3];
        if (a === 0) continue;
        const w = colWeights[wBase + k];
        const af = a * (1 / 255);
        const wa = w * af;
        accR += srcData[off] * wa;
        accG += srcData[off + 1] * wa;
        accB += srcData[off + 2] * wa;
        accA += wa;
      }

      if (applyAntiRing) {
        const i0 = colCenterFloor[dx];
        const i1 = i0 + 1;
        let a0 = 0, r0 = 0, g0 = 0, b0 = 0;
        let a1 = 0, r1 = 0, g1 = 0, b1 = 0;
        if (i0 >= 0 && i0 < sw) {
          const o0 = srcRow + (i0 << 2);
          a0 = srcData[o0 + 3] * (1 / 255);
          r0 = srcData[o0] * a0;
          g0 = srcData[o0 + 1] * a0;
          b0 = srcData[o0 + 2] * a0;
        }
        if (i1 >= 0 && i1 < sw) {
          const o1 = srcRow + (i1 << 2);
          a1 = srcData[o1 + 3] * (1 / 255);
          r1 = srcData[o1] * a1;
          g1 = srcData[o1 + 1] * a1;
          b1 = srcData[o1 + 2] * a1;
        }
        const loR = r0 < r1 ? r0 : r1, hiR = r0 > r1 ? r0 : r1;
        const loG = g0 < g1 ? g0 : g1, hiG = g0 > g1 ? g0 : g1;
        const loB = b0 < b1 ? b0 : b1, hiB = b0 > b1 ? b0 : b1;
        const loA = a0 < a1 ? a0 : a1, hiA = a0 > a1 ? a0 : a1;
        if (accR < loR) accR = loR; else if (accR > hiR) accR = hiR;
        if (accG < loG) accG = loG; else if (accG > hiG) accG = hiG;
        if (accB < loB) accB = loB; else if (accB > hiB) accB = hiB;
        if (accA < loA) accA = loA; else if (accA > hiA) accA = hiA;
      }

      if (accA <= 1e-4) continue;
      if (accA > 1.0) accA = 1.0;
      const maxRgb = accA * 255.0;
      if (accR < 0) accR = 0; else if (accR > maxRgb) accR = maxRgb;
      if (accG < 0) accG = 0; else if (accG > maxRgb) accG = maxRgb;
      if (accB < 0) accB = 0; else if (accB > maxRgb) accB = maxRgb;

      const invA = 1.0 / accA;
      const dOff = dstRow + (dx << 2);
      out[dOff] = Math.min(255, Math.max(0, Math.round(accR * invA)));
      out[dOff + 1] = Math.min(255, Math.max(0, Math.round(accG * invA)));
      out[dOff + 2] = Math.min(255, Math.max(0, Math.round(accB * invA)));
      out[dOff + 3] = Math.min(255, Math.max(0, Math.round(accA * 255.0)));
    }
  }

  return { data: out, width: dstW, height: sh };
}

/**
 * Separable 1D Lanczos-3 resample along Y in float premultiplied RGBA.
 */
function resampleVerticalLanczos3(
  src: PixelBuffer,
  targetH: number,
  flipV: boolean
): PixelBuffer {
  const sw = src.width;
  const sh = src.height;
  const dstH = Math.max(1, targetH);
  const out = new Uint8ClampedArray(sw * dstH * 4);
  const srcData = src.data;

  const scale = sh / dstH;
  const filterScale = scale > 1.0 ? scale : 1.0;
  const invFilterScale = 1.0 / filterScale;
  const support = LANCZOS_A * filterScale;
  const applyAntiRing = filterScale <= 1.25;

  const maxTaps = Math.ceil(support * 2) + 3;
  const rowWeights = new Float32Array(maxTaps);

  for (let dy = 0; dy < dstH; dy++) {
    const v = flipV ? dstH - 0.5 - dy : dy + 0.5;
    const srcY = v * scale - 0.5;
    const y0 = Math.floor(srcY);
    const y1 = y0 + 1;
    const top = Math.ceil(srcY - support);
    const bottom = Math.floor(srcY + support);
    const count = Math.max(0, bottom - top + 1);

    let sumW = 0;
    for (let k = 0; k < count; k++) {
      const w = lanczos3Weight((top + k - srcY) * invFilterScale);
      rowWeights[k] = w;
      sumW += w;
    }
    if (Math.abs(sumW) > 1e-6) {
      const invSum = 1.0 / sumW;
      for (let k = 0; k < count; k++) {
        rowWeights[k] *= invSum;
      }
    }

    const dstRow = dy * sw * 4;
    for (let x = 0; x < sw; x++) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let k = 0; k < count; k++) {
        const iy = top + k;
        if (iy < 0 || iy >= sh) continue;
        const off = (iy * sw + x) << 2;
        const a = srcData[off + 3];
        if (a === 0) continue;
        const w = rowWeights[k];
        const af = a * (1 / 255);
        const wa = w * af;
        accR += srcData[off] * wa;
        accG += srcData[off + 1] * wa;
        accB += srcData[off + 2] * wa;
        accA += wa;
      }

      if (applyAntiRing) {
        let a0 = 0, r0 = 0, g0 = 0, b0 = 0;
        let a1 = 0, r1 = 0, g1 = 0, b1 = 0;
        if (y0 >= 0 && y0 < sh) {
          const o0 = (y0 * sw + x) << 2;
          a0 = srcData[o0 + 3] * (1 / 255);
          r0 = srcData[o0] * a0;
          g0 = srcData[o0 + 1] * a0;
          b0 = srcData[o0 + 2] * a0;
        }
        if (y1 >= 0 && y1 < sh) {
          const o1 = (y1 * sw + x) << 2;
          a1 = srcData[o1 + 3] * (1 / 255);
          r1 = srcData[o1] * a1;
          g1 = srcData[o1 + 1] * a1;
          b1 = srcData[o1 + 2] * a1;
        }
        const loR = r0 < r1 ? r0 : r1, hiR = r0 > r1 ? r0 : r1;
        const loG = g0 < g1 ? g0 : g1, hiG = g0 > g1 ? g0 : g1;
        const loB = b0 < b1 ? b0 : b1, hiB = b0 > b1 ? b0 : b1;
        const loA = a0 < a1 ? a0 : a1, hiA = a0 > a1 ? a0 : a1;
        if (accR < loR) accR = loR; else if (accR > hiR) accR = hiR;
        if (accG < loG) accG = loG; else if (accG > hiG) accG = hiG;
        if (accB < loB) accB = loB; else if (accB > hiB) accB = hiB;
        if (accA < loA) accA = loA; else if (accA > hiA) accA = hiA;
      }

      if (accA <= 1e-4) continue;
      if (accA > 1.0) accA = 1.0;
      const maxRgb = accA * 255.0;
      if (accR < 0) accR = 0; else if (accR > maxRgb) accR = maxRgb;
      if (accG < 0) accG = 0; else if (accG > maxRgb) accG = maxRgb;
      if (accB < 0) accB = 0; else if (accB > maxRgb) accB = maxRgb;

      const invA = 1.0 / accA;
      const dOff = dstRow + (x << 2);
      out[dOff] = Math.min(255, Math.max(0, Math.round(accR * invA)));
      out[dOff + 1] = Math.min(255, Math.max(0, Math.round(accG * invA)));
      out[dOff + 2] = Math.min(255, Math.max(0, Math.round(accB * invA)));
      out[dOff + 3] = Math.min(255, Math.max(0, Math.round(accA * 255.0)));
    }
  }

  return { data: out, width: sw, height: dstH };
}

/**
 * Ensures downscale ratios along X and Y stay <= 3.0 via exact separable 1D Lanczos-3
 * pre-downsampling, keeping the 2D filter footprint bounded and alias-free for arbitrary shrink ratios.
 */
function prepareSourceForScale(
  source: PixelBuffer,
  targetW: number,
  targetH: number
): PixelBuffer {
  let cur = source;
  const safeW = Math.max(1, targetW);
  const safeH = Math.max(1, targetH);

  if (cur.width / safeW > 3.0) {
    const midW = Math.max(1, Math.ceil(safeW * 2));
    cur = resampleHorizontalLanczos3(cur, midW, false);
  }
  if (cur.height / safeH > 3.0) {
    const midH = Math.max(1, Math.ceil(safeH * 2));
    cur = resampleVerticalLanczos3(cur, midH, false);
  }
  return cur;
}

/**
 * Exact CPU inverse-mapped affine resampler using float-premultiplied Anti-Ringing Lanczos-3
 * (upscaling/rotation) and anisotropic footprint-scaled Lanczos-3 (downscaling).
 */
export function resampleAffineChunkCpu(
  source: PixelBuffer,
  params: AffineTransformParams,
  chunkX: number,
  chunkY: number,
  chunkW: number,
  chunkH: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(chunkW * chunkH * 4);
  const sw = source.width;
  const sh = source.height;
  if (sw <= 0 || sh <= 0 || params.width <= 0 || params.height <= 0) return out;

  const srcData = source.data;
  const midX = params.x + params.width * 0.5;
  const midY = params.y + params.height * 0.5;
  const rad = (params.rotation * PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const flipXSign = params.flipH ? -1 : 1;
  const flipYSign = params.flipV ? -1 : 1;
  const invDstW = 1.0 / params.width;
  const invDstH = 1.0 / params.height;

  // Incremental inverse affine matrix:
  // srcPos(docX, docY) = (srcX0 + dx*a00 + dy*a01, srcY0 + dx*a10 + dy*a11)
  const scaleX = sw * invDstW;
  const scaleY = sh * invDstH;
  const a00 = flipXSign * cos * scaleX;
  const a01 = flipXSign * sin * scaleX;
  const a10 = flipYSign * -sin * scaleY;
  const a11 = flipYSign * cos * scaleY;

  const filterScaleX = scaleX > 1.0 ? scaleX : 1.0;
  const filterScaleY = scaleY > 1.0 ? scaleY : 1.0;
  const invFilterX = 1.0 / filterScaleX;
  const invFilterY = 1.0 / filterScaleY;
  const supportX = LANCZOS_A * filterScaleX;
  const supportY = LANCZOS_A * filterScaleY;
  const applyAntiRing = filterScaleX <= 1.25 && filterScaleY <= 1.25;

  const minSrcX = -supportX;
  const maxSrcX = sw - 1 + supportX;
  const minSrcY = -supportY;
  const maxSrcY = sh - 1 + supportY;

  const maxTapsX = Math.ceil(supportX * 2) + 4;
  const maxTapsY = Math.ceil(supportY * 2) + 4;
  const wxBuf = new Float32Array(maxTapsX);
  const wyBuf = new Float32Array(maxTapsY);

  const rx0 = chunkX + 0.5 - midX;
  const ry0 = chunkY + 0.5 - midY;
  const baseSrcX = (flipXSign * (rx0 * cos + ry0 * sin) * invDstW + 0.5) * sw - 0.5;
  const baseSrcY = (flipYSign * (-rx0 * sin + ry0 * cos) * invDstH + 0.5) * sh - 0.5;

  for (let py = 0; py < chunkH; py++) {
    let sx = baseSrcX + py * a01;
    let sy = baseSrcY + py * a11;
    let dstOff = py * chunkW * 4;

    for (let px = 0; px < chunkW; px++, sx += a00, sy += a10, dstOff += 4) {
      if (sx < minSrcX || sx > maxSrcX || sy < minSrcY || sy > maxSrcY) {
        continue;
      }

      const xStart = Math.ceil(sx - supportX);
      const xEnd = Math.floor(sx + supportX);
      const yStart = Math.ceil(sy - supportY);
      const yEnd = Math.floor(sy + supportY);
      const countX = xEnd - xStart + 1;
      const countY = yEnd - yStart + 1;
      if (countX <= 0 || countY <= 0) continue;

      let sumWx = 0;
      for (let i = 0; i < countX; i++) {
        const w = lanczos3Weight((xStart + i - sx) * invFilterX);
        wxBuf[i] = w;
        sumWx += w;
      }
      if (Math.abs(sumWx) < 1e-6) continue;
      const invSumWx = 1.0 / sumWx;
      for (let i = 0; i < countX; i++) {
        wxBuf[i] *= invSumWx;
      }

      let sumWy = 0;
      for (let j = 0; j < countY; j++) {
        const w = lanczos3Weight((yStart + j - sy) * invFilterY);
        wyBuf[j] = w;
        sumWy += w;
      }
      if (Math.abs(sumWy) < 1e-6) continue;
      const invSumWy = 1.0 / sumWy;
      for (let j = 0; j < countY; j++) {
        wyBuf[j] *= invSumWy;
      }

      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let j = 0; j < countY; j++) {
        const iy = yStart + j;
        if (iy < 0 || iy >= sh) continue;
        const wy = wyBuf[j];
        if (wy === 0) continue;
        const rowBase = iy * sw;

        let rR = 0;
        let rG = 0;
        let rB = 0;
        let rA = 0;

        for (let i = 0; i < countX; i++) {
          const ix = xStart + i;
          if (ix < 0 || ix >= sw) continue;
          const off = (rowBase + ix) << 2;
          const a = srcData[off + 3];
          if (a === 0) continue;
          const wa = wxBuf[i] * (a * (1 / 255));
          rR += srcData[off] * wa;
          rG += srcData[off + 1] * wa;
          rB += srcData[off + 2] * wa;
          rA += wa;
        }

        accR += rR * wy;
        accG += rG * wy;
        accB += rB * wy;
        accA += rA * wy;
      }

      if (applyAntiRing) {
        const bx = Math.floor(sx);
        const by = Math.floor(sy);
        let loR = Infinity, hiR = -Infinity;
        let loG = Infinity, hiG = -Infinity;
        let loB = Infinity, hiB = -Infinity;
        let loA = Infinity, hiA = -Infinity;

        for (let ny = by; ny <= by + 1; ny++) {
          const yValid = ny >= 0 && ny < sh;
          const rowBase = ny * sw;
          for (let nx = bx; nx <= bx + 1; nx++) {
            let nr = 0, ng = 0, nb = 0, na = 0;
            if (yValid && nx >= 0 && nx < sw) {
              const o = (rowBase + nx) << 2;
              na = srcData[o + 3] * (1 / 255);
              nr = srcData[o] * na;
              ng = srcData[o + 1] * na;
              nb = srcData[o + 2] * na;
            }
            if (nr < loR) loR = nr; if (nr > hiR) hiR = nr;
            if (ng < loG) loG = ng; if (ng > hiG) hiG = ng;
            if (nb < loB) loB = nb; if (nb > hiB) hiB = nb;
            if (na < loA) loA = na; if (na > hiA) hiA = na;
          }
        }

        if (accR < loR) accR = loR; else if (accR > hiR) accR = hiR;
        if (accG < loG) accG = loG; else if (accG > hiG) accG = hiG;
        if (accB < loB) accB = loB; else if (accB > hiB) accB = hiB;
        if (accA < loA) accA = loA; else if (accA > hiA) accA = hiA;
      }

      if (accA <= 1e-4) continue;
      if (accA > 1.0) accA = 1.0;
      const maxRgb = accA * 255.0;
      if (accR < 0) accR = 0; else if (accR > maxRgb) accR = maxRgb;
      if (accG < 0) accG = 0; else if (accG > maxRgb) accG = maxRgb;
      if (accB < 0) accB = 0; else if (accB > maxRgb) accB = maxRgb;

      const invA = 1.0 / accA;
      out[dstOff] = Math.min(255, Math.max(0, Math.round(accR * invA)));
      out[dstOff + 1] = Math.min(255, Math.max(0, Math.round(accG * invA)));
      out[dstOff + 2] = Math.min(255, Math.max(0, Math.round(accB * invA)));
      out[dstOff + 3] = Math.min(255, Math.max(0, Math.round(accA * 255.0)));
    }
  }

  return out;
}

const AFFINE_VERTEX_SHADER_ES3 = `#version 300 es
  in vec2 a_ndc;
  uniform vec2 u_chunkOrigin;
  uniform vec2 u_chunkSize;
  out vec2 v_docPos;
  void main() {
    // Map a_ndc in [0, 1]^2 so row 0 of readPixels corresponds directly to chunk top (chunkOrigin.y)
    vec2 uv = a_ndc;
    v_docPos = u_chunkOrigin + uv * u_chunkSize;
    gl_Position = vec4(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const AFFINE_FRAGMENT_SHADER_ES3 = `#version 300 es
  precision highp float;
  uniform sampler2D u_tex;
  uniform ivec2 u_srcSize;
  uniform vec2 u_mid;
  uniform vec2 u_dstSize;
  uniform vec2 u_rotCosSin;
  uniform vec2 u_flipSign;
  uniform vec2 u_filterScale;
  in vec2 v_docPos;
  out vec4 outColor;

  const float PI = 3.14159265358979323846;

  float lanczos3(float x) {
    float ax = abs(x);
    if (ax < 1e-5) return 1.0;
    if (ax >= 3.0) return 0.0;
    float pix = PI * ax;
    return (3.0 * sin(pix) * sin(pix * (1.0 / 3.0))) / (pix * pix);
  }

  vec4 fetchPremul(int ix, int iy) {
    if (ix < 0 || ix >= u_srcSize.x || iy < 0 || iy >= u_srcSize.y) {
      return vec4(0.0);
    }
    vec4 s = texelFetch(u_tex, ivec2(ix, iy), 0);
    return vec4(s.rgb * s.a, s.a);
  }

  void main() {
    vec2 r = v_docPos - u_mid;
    float cosA = u_rotCosSin.x;
    float sinA = u_rotCosSin.y;
    vec2 f = vec2(r.x * cosA + r.y * sinA, -r.x * sinA + r.y * cosA);
    vec2 l = f * u_flipSign;
    vec2 srcSizeF = vec2(u_srcSize);
    vec2 srcPos = (l / u_dstSize + 0.5) * srcSizeF - 0.5;

    vec2 support = 3.0 * u_filterScale;
    if (
      srcPos.x < -support.x || srcPos.x > (srcSizeF.x - 1.0) + support.x ||
      srcPos.y < -support.y || srcPos.y > (srcSizeF.y - 1.0) + support.y
    ) {
      outColor = vec4(0.0);
      return;
    }

    vec2 invFilter = 1.0 / u_filterScale;
    int xStart = int(ceil(srcPos.x - support.x));
    int xEnd = int(floor(srcPos.x + support.x));
    int yStart = int(ceil(srcPos.y - support.y));
    int yEnd = int(floor(srcPos.y + support.y));

    float wx[20];
    int countX = min(20, max(0, xEnd - xStart + 1));
    float sumWx = 0.0;
    for (int i = 0; i < 20; i++) {
      if (i >= countX) break;
      float w = lanczos3((float(xStart + i) - srcPos.x) * invFilter.x);
      wx[i] = w;
      sumWx += w;
    }
    if (abs(sumWx) < 1e-6) {
      outColor = vec4(0.0);
      return;
    }
    float invSumWx = 1.0 / sumWx;
    for (int i = 0; i < 20; i++) {
      if (i >= countX) break;
      wx[i] *= invSumWx;
    }

    vec4 acc = vec4(0.0);
    float sumWy = 0.0;
    int countY = min(20, max(0, yEnd - yStart + 1));
    for (int j = 0; j < 20; j++) {
      if (j >= countY) break;
      int iy = yStart + j;
      float wy = lanczos3((float(iy) - srcPos.y) * invFilter.y);
      sumWy += wy;
      if (iy < 0 || iy >= u_srcSize.y || abs(wy) < 1e-7) continue;

      vec4 rowAcc = vec4(0.0);
      for (int i = 0; i < 20; i++) {
        if (i >= countX) break;
        int ix = xStart + i;
        if (ix < 0 || ix >= u_srcSize.x) continue;
        rowAcc += fetchPremul(ix, iy) * wx[i];
      }
      acc += rowAcc * wy;
    }

    if (abs(sumWy) < 1e-6) {
      outColor = vec4(0.0);
      return;
    }
    acc /= sumWy;

    // Anti-ringing clamp for upscaling and rotation: eliminates Lanczos halos while preserving full edge sharpness
    if (u_filterScale.x <= 1.25 && u_filterScale.y <= 1.25) {
      int bx = int(floor(srcPos.x));
      int by = int(floor(srcPos.y));
      vec4 n00 = fetchPremul(bx,     by);
      vec4 n10 = fetchPremul(bx + 1, by);
      vec4 n01 = fetchPremul(bx,     by + 1);
      vec4 n11 = fetchPremul(bx + 1, by + 1);
      vec4 lo = min(min(n00, n10), min(n01, n11));
      vec4 hi = max(max(n00, n10), max(n01, n11));
      acc = clamp(acc, lo, hi);
    }

    float a = clamp(acc.a, 0.0, 1.0);
    if (a <= 1e-4) {
      outColor = vec4(0.0);
      return;
    }
    vec3 premulRgb = clamp(acc.rgb, vec3(0.0), vec3(a));
    vec3 straightRgb = clamp(premulRgb / a, 0.0, 1.0);
    outColor = vec4(straightRgb, a);
  }
`;

class WebGlAffineTransformRenderer {
  private static instance: WebGlAffineTransformRenderer | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private srcTexture: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private fboTexture: WebGLTexture | null = null;
  private fboW = 0;
  private fboH = 0;
  private ndcLoc = -1;
  private chunkOriginLoc: WebGLUniformLocation | null = null;
  private chunkSizeLoc: WebGLUniformLocation | null = null;
  private texLoc: WebGLUniformLocation | null = null;
  private srcSizeLoc: WebGLUniformLocation | null = null;
  private midLoc: WebGLUniformLocation | null = null;
  private dstSizeLoc: WebGLUniformLocation | null = null;
  private rotCosSinLoc: WebGLUniformLocation | null = null;
  private flipSignLoc: WebGLUniformLocation | null = null;
  private filterScaleLoc: WebGLUniformLocation | null = null;
  private maxDim = 0;
  private ready = false;

  static getInstance(): WebGlAffineTransformRenderer {
    if (!WebGlAffineTransformRenderer.instance) {
      WebGlAffineTransformRenderer.instance = new WebGlAffineTransformRenderer();
    }
    return WebGlAffineTransformRenderer.instance;
  }

  private constructor() {
    this.init();
  }

  private init(): void {
    this.ready = false;
    if (typeof document === 'undefined') return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
      }) as WebGL2RenderingContext | null;
      if (!gl) return;

      const vs = gl.createShader(gl.VERTEX_SHADER);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      if (!vs || !fs) return;
      gl.shaderSource(vs, AFFINE_VERTEX_SHADER_ES3);
      gl.compileShader(vs);
      gl.shaderSource(fs, AFFINE_FRAGMENT_SHADER_ES3);
      gl.compileShader(fs);
      if (
        !gl.getShaderParameter(vs, gl.COMPILE_STATUS) ||
        !gl.getShaderParameter(fs, gl.COMPILE_STATUS)
      ) {
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return;
      }

      const program = gl.createProgram();
      if (!program) {
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return;
      }
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program);
        return;
      }

      const quadBuffer = gl.createBuffer();
      const srcTexture = gl.createTexture();
      const fbo = gl.createFramebuffer();
      const fboTexture = gl.createTexture();
      const ndcLoc = gl.getAttribLocation(program, 'a_ndc');
      if (!quadBuffer || !srcTexture || !fbo || !fboTexture || ndcLoc < 0) {
        if (quadBuffer) gl.deleteBuffer(quadBuffer);
        if (srcTexture) gl.deleteTexture(srcTexture);
        if (fbo) gl.deleteFramebuffer(fbo);
        if (fboTexture) gl.deleteTexture(fboTexture);
        gl.deleteProgram(program);
        return;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]),
        gl.STATIC_DRAW
      );

      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const maxVp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | number[] | null;
      const maxVpDim = maxVp ? Math.min(maxVp[0], maxVp[1]) : maxTex;

      this.gl = gl;
      this.program = program;
      this.quadBuffer = quadBuffer;
      this.srcTexture = srcTexture;
      this.fbo = fbo;
      this.fboTexture = fboTexture;
      this.ndcLoc = ndcLoc;
      this.chunkOriginLoc = gl.getUniformLocation(program, 'u_chunkOrigin');
      this.chunkSizeLoc = gl.getUniformLocation(program, 'u_chunkSize');
      this.texLoc = gl.getUniformLocation(program, 'u_tex');
      this.srcSizeLoc = gl.getUniformLocation(program, 'u_srcSize');
      this.midLoc = gl.getUniformLocation(program, 'u_mid');
      this.dstSizeLoc = gl.getUniformLocation(program, 'u_dstSize');
      this.rotCosSinLoc = gl.getUniformLocation(program, 'u_rotCosSin');
      this.flipSignLoc = gl.getUniformLocation(program, 'u_flipSign');
      this.filterScaleLoc = gl.getUniformLocation(program, 'u_filterScale');
      this.maxDim = Math.min(maxTex || 4096, maxVpDim || 4096);
      this.ready = true;
    } catch {
      this.ready = false;
    }
  }

  private ensureFbo(gl: WebGL2RenderingContext, w: number, h: number): boolean {
    if (!this.fbo || !this.fboTexture) return false;
    if (this.fboW === w && this.fboH === h) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      return true;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.fboTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTexture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.fboW = 0;
      this.fboH = 0;
      return false;
    }
    this.fboW = w;
    this.fboH = h;
    return true;
  }

  renderChunks(
    source: PixelBuffer,
    params: AffineTransformParams,
    destRect: DirtyRect,
    chunkSize: number,
    onChunk: (chunkData: Uint8ClampedArray, cx: number, cy: number, cw: number, ch: number) => void
  ): boolean {
    if (!this.ready || !this.gl || !this.program || !this.quadBuffer || !this.srcTexture) {
      return false;
    }
    const gl = this.gl;
    if (gl.isContextLost()) {
      this.ready = false;
      return false;
    }
    const sw = source.width;
    const sh = source.height;
    if (sw <= 0 || sh <= 0 || sw > this.maxDim || sh > this.maxDim) return false;
    if (chunkSize > this.maxDim) return false;

    const srcBytes =
      source.data instanceof Uint8Array
        ? source.data
        : new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength);

    // Upload source straight-alpha pixels ONCE for all chunks
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, srcBytes);

    gl.useProgram(this.program);
    gl.uniform1i(this.texLoc, 0);
    gl.uniform2i(this.srcSizeLoc, sw, sh);
    gl.uniform2f(this.midLoc, params.x + params.width * 0.5, params.y + params.height * 0.5);
    gl.uniform2f(this.dstSizeLoc, params.width, params.height);
    const rad = (params.rotation * PI) / 180;
    gl.uniform2f(this.rotCosSinLoc, Math.cos(rad), Math.sin(rad));
    gl.uniform2f(this.flipSignLoc, params.flipH ? -1 : 1, params.flipV ? -1 : 1);
    const filterScaleX = Math.max(1.0, sw / Math.max(1, params.width));
    const filterScaleY = Math.max(1.0, sh / Math.max(1, params.height));
    gl.uniform2f(this.filterScaleLoc, filterScaleX, filterScaleY);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.ndcLoc);
    gl.vertexAttribPointer(this.ndcLoc, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    const x1 = destRect.x + destRect.width;
    const y1 = destRect.y + destRect.height;

    try {
      for (let cy = destRect.y; cy < y1; cy += chunkSize) {
        const ch = Math.min(chunkSize, y1 - cy);
        for (let cx = destRect.x; cx < x1; cx += chunkSize) {
          const cw = Math.min(chunkSize, x1 - cx);
          if (!this.ensureFbo(gl, cw, ch)) {
            return false;
          }
          gl.viewport(0, 0, cw, ch);
          gl.uniform2f(this.chunkOriginLoc, cx, cy);
          gl.uniform2f(this.chunkSizeLoc, cw, ch);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.srcTexture);
          gl.drawArrays(gl.TRIANGLES, 0, 6);

          const rawBytes = new Uint8Array(cw * ch * 4);
          gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, rawBytes);
          const clamped = new Uint8ClampedArray(
            rawBytes.buffer,
            rawBytes.byteOffset,
            rawBytes.byteLength
          );
          onChunk(clamped, cx, cy, cw, ch);
        }
      }
      return true;
    } catch {
      return false;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }
}

/**
 * Extracts straight-alpha pixel data from an HTMLCanvasElement.
 */
export function extractCanvasPixelBuffer(canvas: HTMLCanvasElement): PixelBuffer | null {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, width: img.width, height: img.height };
}

/**
 * High-precision chunked affine transform pipeline:
 * 1. Exact lossless straight-alpha copy for 1:1 translate / flip / 90/180/270 rotation
 *    (eliminates Canvas 2D premultiplication loss and odd-dimension 0.5px rotation blur).
 * 2. Separable Lanczos-3 pre-downsampling for >3x shrink ratios (prevents aliasing/thinning).
 * 3. WebGL2 float-premultiplied Anti-Ringing Lanczos-3 (with exact CPU fallback) writing
 *    straight-alpha RGBA chunks directly with zero Canvas 2D round-trip.
 */
export function processAffineTransformChunks(
  source: PixelBuffer,
  params: AffineTransformParams,
  destRect: DirtyRect,
  chunkSize: number,
  onChunk: (chunkData: Uint8ClampedArray, cx: number, cy: number, cw: number, ch: number) => void
): void {
  const x1 = destRect.x + destRect.width;
  const y1 = destRect.y + destRect.height;

  // 1. Exact lossless integer path (1:1 translate, flip, 90/180/270)
  const losslessSpec = resolveLosslessAffineSpec(source.width, source.height, params);
  if (losslessSpec) {
    for (let cy = destRect.y; cy < y1; cy += chunkSize) {
      const ch = Math.min(chunkSize, y1 - cy);
      for (let cx = destRect.x; cx < x1; cx += chunkSize) {
        const cw = Math.min(chunkSize, x1 - cx);
        const chunkData = renderLosslessAffineChunk(source, losslessSpec, cx, cy, cw, ch);
        onChunk(chunkData, cx, cy, cw, ch);
      }
    }
    return;
  }

  // 2. Pre-downsample extreme >3x shrink ratios along X/Y independently via exact 1D Lanczos-3
  const preparedSource = prepareSourceForScale(source, params.width, params.height);

  // 3. GPU WebGL2 float-premultiplied Anti-Ringing Lanczos-3 (uploads texture once)
  if (
    WebGlAffineTransformRenderer.getInstance().renderChunks(
      preparedSource,
      params,
      destRect,
      chunkSize,
      onChunk
    )
  ) {
    return;
  }

  // 4. Fast separable 2-pass CPU Lanczos-3 when unrotated (0 or 180 deg) with integer destination placement
  const qTurn = getExactQuarterTurnDeg(params.rotation);
  if (
    (qTurn === 0 || qTurn === 180) &&
    Math.abs(params.x - Math.round(params.x)) < 1e-5 &&
    Math.abs(params.y - Math.round(params.y)) < 1e-5 &&
    Math.abs(params.width - Math.round(params.width)) < 1e-5 &&
    Math.abs(params.height - Math.round(params.height)) < 1e-5
  ) {
    const targetW = Math.max(1, Math.round(params.width));
    const targetH = Math.max(1, Math.round(params.height));
    const effFlipH = qTurn === 180 ? !params.flipH : params.flipH;
    const effFlipV = qTurn === 180 ? !params.flipV : params.flipV;
    const hPass =
      preparedSource.width === targetW && !effFlipH
        ? preparedSource
        : resampleHorizontalLanczos3(preparedSource, targetW, effFlipH);
    const fullRes =
      hPass.height === targetH && !effFlipV
        ? hPass
        : resampleVerticalLanczos3(hPass, targetH, effFlipV);

    const originX = Math.round(params.x);
    const originY = Math.round(params.y);
    const copySpec: LosslessAffineSpec = {
      quarterTurn: 0,
      flipH: false,
      flipV: false,
      destOriginX: originX,
      destOriginY: originY,
      destWidth: targetW,
      destHeight: targetH,
    };
    for (let cy = destRect.y; cy < y1; cy += chunkSize) {
      const ch = Math.min(chunkSize, y1 - cy);
      for (let cx = destRect.x; cx < x1; cx += chunkSize) {
        const cw = Math.min(chunkSize, x1 - cx);
        const chunkData = renderLosslessAffineChunk(fullRes, copySpec, cx, cy, cw, ch);
        onChunk(chunkData, cx, cy, cw, ch);
      }
    }
    return;
  }

  // 5. General rotated CPU inverse-mapped Anti-Ringing Lanczos-3 fallback
  for (let cy = destRect.y; cy < y1; cy += chunkSize) {
    const ch = Math.min(chunkSize, y1 - cy);
    for (let cx = destRect.x; cx < x1; cx += chunkSize) {
      const cw = Math.min(chunkSize, x1 - cx);
      const chunkData = resampleAffineChunkCpu(preparedSource, params, cx, cy, cw, ch);
      onChunk(chunkData, cx, cy, cw, ch);
    }
  }
}

/**
 * Helper to check if a perspective quad or mesh grid matches an exact integer translation
 * of its source dimensions (for lossless identity/move detection).
 */
export function isExactQuadTranslation(
  quad: [Point2D, Point2D, Point2D, Point2D],
  sw: number,
  sh: number
): { x: number; y: number } | null {
  const x = Math.round(quad[0].x);
  const y = Math.round(quad[0].y);
  if (
    Math.abs(quad[0].x - x) < 1e-5 &&
    Math.abs(quad[0].y - y) < 1e-5 &&
    Math.abs(quad[1].x - (x + sw)) < 1e-5 &&
    Math.abs(quad[1].y - y) < 1e-5 &&
    Math.abs(quad[2].x - (x + sw)) < 1e-5 &&
    Math.abs(quad[2].y - (y + sh)) < 1e-5 &&
    Math.abs(quad[3].x - x) < 1e-5 &&
    Math.abs(quad[3].y - (y + sh)) < 1e-5
  ) {
    return { x, y };
  }
  return null;
}
