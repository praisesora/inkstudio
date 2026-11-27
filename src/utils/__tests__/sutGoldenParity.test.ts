import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildRibbonMeshFromPoints,
  rasterizeRibbonMeshCpu,
} from '../../engine/RibbonBrushEngine';
import {
  buildBrushRenderOptions,
  centripetalCatmullRomToBezier,
  drawBrushCubicBezierSegment,
  drawBrushDot,
  renderCompleteStroke,
} from '../../engine/BrushEngine';
import { LayerPixelSampler, parseColorToRgb } from '../colorMixingEngine';
import { renderBrushStrokePreview, clearBrushPreviewCache } from '../brushPreview';
import {
  BRUSH_INDEX_LS_KEY,
  prepareBrushSettingsForCsp,
  resetBrushStorageCache,
  saveCustomBrush,
} from '../brushStorage';
import {
  getEffectiveBrushSettings,
  saveBrushSettingsImmediately,
} from '../brushPresetManager';
import {
  buildExportableBrush,
  parseInkbFile,
  serializeInkbBrush,
} from '../inkbBrushFormat';
import { parseSutExtractedData } from '../sutParser';
import type { NativeSutExtract } from '../nativeBackend';
import {
  BrushSettings,
  CspBrush,
  CspPaperTextureMode,
  CspSubTipOrder,
  DEFAULT_BRUSH_DYNAMICS,
  Point,
} from '../../types/editor';

// ============================================================================
// Pixel-exact software Canvas2D rasterizer for deterministic golden parity tests
// ============================================================================

function createSoftwareCanvas(initW: number, initH: number) {
  let width = Math.max(1, Math.round(initW));
  let height = Math.max(1, Math.round(initH));
  let buf = new Uint8ClampedArray(width * height * 4);

  type State = {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
    alpha: number;
    op: string;
    fillStyle: string;
  };
  const stack: State[] = [];
  let st: State = {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    e: 0,
    f: 0,
    alpha: 1,
    op: 'source-over',
    fillStyle: '#000000',
  };

  const compositePixel = (di: number, sr: number, sg: number, sb: number, srcA: number) => {
    const sa = Math.max(0, Math.min(1, srcA));
    if (sa <= 1e-4) return;
    const dr = buf[di];
    const dg = buf[di + 1];
    const db = buf[di + 2];
    const da = buf[di + 3] / 255;

    if (st.op === 'destination-out') {
      const outA = da * (1 - sa);
      buf[di + 3] = Math.round(Math.max(0, Math.min(255, outA * 255)));
      if (buf[di + 3] === 0) {
        buf[di] = 0;
        buf[di + 1] = 0;
        buf[di + 2] = 0;
      }
      return;
    }

    if (st.op === 'destination-over') {
      const outA = da + sa * (1 - da);
      if (outA <= 1e-4) return;
      const inv = 1 / outA;
      buf[di] = Math.round((dr * da + sr * sa * (1 - da)) * inv);
      buf[di + 1] = Math.round((dg * da + sg * sa * (1 - da)) * inv);
      buf[di + 2] = Math.round((db * da + sb * sa * (1 - da)) * inv);
      buf[di + 3] = Math.round(Math.min(255, outA * 255));
      return;
    }

    if (st.op === 'source-atop') {
      if (da <= 1e-4) return;
      buf[di] = Math.round(sr * sa + dr * (1 - sa));
      buf[di + 1] = Math.round(sg * sa + dg * (1 - sa));
      buf[di + 2] = Math.round(sb * sa + db * (1 - sa));
      return;
    }

    // Standard source-over (and fallback)
    const outA = sa + da * (1 - sa);
    if (outA <= 1e-4) return;
    const inv = 1 / outA;
    buf[di] = Math.round((sr * sa + dr * da * (1 - sa)) * inv);
    buf[di + 1] = Math.round((sg * sa + dg * da * (1 - sa)) * inv);
    buf[di + 2] = Math.round((sb * sa + db * da * (1 - sa)) * inv);
    buf[di + 3] = Math.round(Math.min(255, outA * 255));
  };

  const ctx: any = {
    get canvas() {
      return surfaceObj;
    },
    get globalAlpha() {
      return st.alpha;
    },
    set globalAlpha(v: number) {
      st.alpha = v;
    },
    get globalCompositeOperation() {
      return st.op;
    },
    set globalCompositeOperation(v: string) {
      st.op = v;
    },
    get fillStyle() {
      return st.fillStyle;
    },
    set fillStyle(v: string) {
      st.fillStyle = v;
    },
    imageSmoothingEnabled: true,
    save: () => stack.push({ ...st }),
    restore: () => {
      const p = stack.pop();
      if (p) st = p;
    },
    getTransform: () => ({ a: st.a, b: st.b, c: st.c, d: st.d, e: st.e, f: st.f }),
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      st.a = a;
      st.b = b;
      st.c = c;
      st.d = d;
      st.e = e;
      st.f = f;
    },
    resetTransform: () => {
      st.a = 1;
      st.b = 0;
      st.c = 0;
      st.d = 1;
      st.e = 0;
      st.f = 0;
    },
    translate: (x: number, y: number) => {
      st.e += st.a * x + st.c * y;
      st.f += st.b * x + st.d * y;
    },
    rotate: (rad: number) => {
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const na = st.a * cos + st.c * sin;
      const nb = st.b * cos + st.d * sin;
      const nc = -st.a * sin + st.c * cos;
      const nd = -st.b * sin + st.d * cos;
      st.a = na;
      st.b = nb;
      st.c = nc;
      st.d = nd;
    },
    scale: (sx: number, sy: number) => {
      st.a *= sx;
      st.b *= sx;
      st.c *= sy;
      st.d *= sy;
    },
    beginPath: () => {},
    rect: () => {},
    clip: () => {},
    clearRect: (x = 0, y = 0, w = width, h = height) => {
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(width, Math.ceil(x + w));
      const y1 = Math.min(height, Math.ceil(y + h));
      for (let py = y0; py < y1; py++) {
        buf.fill(0, (py * width + x0) * 4, (py * width + x1) * 4);
      }
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      const rgb = parseColorToRgb(st.fillStyle);
      const x0 = Math.max(0, Math.floor(x + st.e));
      const y0 = Math.max(0, Math.floor(y + st.f));
      const x1 = Math.min(width, Math.ceil(x + w + st.e));
      const y1 = Math.min(height, Math.ceil(y + h + st.f));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * width + px) * 4;
          if (st.op === 'source-in') {
            if (buf[i + 3] > 0) {
              buf[i] = rgb.r;
              buf[i + 1] = rgb.g;
              buf[i + 2] = rgb.b;
            }
          } else {
            buf[i] = rgb.r;
            buf[i + 1] = rgb.g;
            buf[i + 2] = rgb.b;
            buf[i + 3] = Math.round(st.alpha * 255);
          }
        }
      }
    },
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: (
      img: { width: number; height: number; data: Uint8ClampedArray },
      dx = 0,
      dy = 0
    ) => {
      for (let y = 0; y < img.height; y++) {
        const ty = dy + y;
        if (ty < 0 || ty >= height) continue;
        for (let x = 0; x < img.width; x++) {
          const tx = dx + x;
          if (tx < 0 || tx >= width) continue;
          const si = (y * img.width + x) * 4;
          const di = (ty * width + tx) * 4;
          buf[di] = img.data[si];
          buf[di + 1] = img.data[si + 1];
          buf[di + 2] = img.data[si + 2];
          buf[di + 3] = img.data[si + 3];
        }
      }
    },
    getImageData: (sx: number, sy: number, sw: number, sh: number) => {
      const data = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y++) {
        const py = sy + y;
        if (py < 0 || py >= height) continue;
        for (let x = 0; x < sw; x++) {
          const px = sx + x;
          if (px < 0 || px >= width) continue;
          const si = (py * width + px) * 4;
          const di = (y * sw + x) * 4;
          data[di] = buf[si];
          data[di + 1] = buf[si + 1];
          data[di + 2] = buf[si + 2];
          data[di + 3] = buf[si + 3];
        }
      }
      return { width: sw, height: sh, data };
    },
    drawImage: (
      src: any,
      a1: number,
      a2: number,
      a3?: number,
      a4?: number,
      a5?: number,
      a6?: number,
      a7?: number,
      a8?: number
    ) => {
      const srcBuf: Uint8ClampedArray | undefined = src?.buf;
      if (!srcBuf) return;
      const fullSw = src.width || src.naturalWidth || 0;
      const fullSh = src.height || src.naturalHeight || 0;
      if (fullSw <= 0 || fullSh <= 0) return;

      let sx = 0,
        sy = 0,
        sw = fullSw,
        sh = fullSh,
        dx = a1,
        dy = a2,
        dw = a3 ?? fullSw,
        dh = a4 ?? fullSh;
      if (a8 !== undefined && a7 !== undefined && a6 !== undefined && a5 !== undefined) {
        sx = a1;
        sy = a2;
        sw = a3!;
        sh = a4!;
        dx = a5;
        dy = a6;
        dw = a7;
        dh = a8;
      }
      if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;

      const det = st.a * st.d - st.b * st.c;
      if (Math.abs(det) < 1e-8) return;
      const invDet = 1 / det;

      const corners = [
        [dx, dy],
        [dx + dw, dy],
        [dx, dy + dh],
        [dx + dw, dy + dh],
      ];
      let minX = width,
        minY = height,
        maxX = -1,
        maxY = -1;
      for (const [lx, ly] of corners) {
        const wx = st.a * lx + st.c * ly + st.e;
        const wy = st.b * lx + st.d * ly + st.f;
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wx > maxX) maxX = wx;
        if (wy > maxY) maxY = wy;
      }
      const ix0 = Math.max(0, Math.floor(minX));
      const iy0 = Math.max(0, Math.floor(minY));
      const ix1 = Math.min(width - 1, Math.ceil(maxX));
      const iy1 = Math.min(height - 1, Math.ceil(maxY));

      for (let py = iy0; py <= iy1; py++) {
        for (let px = ix0; px <= ix1; px++) {
          const rx = px + 0.5 - st.e;
          const ry = py + 0.5 - st.f;
          const lx = (st.d * rx - st.c * ry) * invDet;
          const ly = (-st.b * rx + st.a * ry) * invDet;
          const u = (lx - dx) / dw;
          const v = (ly - dy) / dh;
          if (u < 0 || u > 1 || v < 0 || v > 1) continue;

          const fx = sx + u * sw - 0.5;
          const fy = sy + v * sh - 0.5;

          if (!ctx.imageSmoothingEnabled) {
            const nx = Math.max(0, Math.min(fullSw - 1, Math.floor(sx + u * sw)));
            const ny = Math.max(0, Math.min(fullSh - 1, Math.floor(sy + v * sh)));
            const ni = (ny * fullSw + nx) * 4;
            const srcA = (srcBuf[ni + 3] / 255) * st.alpha;
            if (srcA <= 1e-4) continue;
            compositePixel((py * width + px) * 4, srcBuf[ni], srcBuf[ni + 1], srcBuf[ni + 2], srcA);
            continue;
          }

          const x0 = Math.max(0, Math.min(fullSw - 1, Math.floor(fx)));
          const y0 = Math.max(0, Math.min(fullSh - 1, Math.floor(fy)));
          const x1 = Math.min(fullSw - 1, x0 + 1);
          const y1 = Math.min(fullSh - 1, y0 + 1);
          const tx = Math.max(0, Math.min(1, fx - x0));
          const ty = Math.max(0, Math.min(1, fy - y0));

          const i00 = (y0 * fullSw + x0) * 4;
          const i10 = (y0 * fullSw + x1) * 4;
          const i01 = (y1 * fullSw + x0) * 4;
          const i11 = (y1 * fullSw + x1) * 4;
          const w00 = (1 - tx) * (1 - ty);
          const w10 = tx * (1 - ty);
          const w01 = (1 - tx) * ty;
          const w11 = tx * ty;

          const a00 = (srcBuf[i00 + 3] / 255) * w00;
          const a10 = (srcBuf[i10 + 3] / 255) * w10;
          const a01 = (srcBuf[i01 + 3] / 255) * w01;
          const a11 = (srcBuf[i11 + 3] / 255) * w11;
          const aSum = a00 + a10 + a01 + a11;
          const srcA = aSum * st.alpha;
          if (srcA <= 1e-4) continue;

          const sr =
            (srcBuf[i00] * a00 + srcBuf[i10] * a10 + srcBuf[i01] * a01 + srcBuf[i11] * a11) / aSum;
          const sg =
            (srcBuf[i00 + 1] * a00 +
              srcBuf[i10 + 1] * a10 +
              srcBuf[i01 + 1] * a01 +
              srcBuf[i11 + 1] * a11) /
            aSum;
          const sb =
            (srcBuf[i00 + 2] * a00 +
              srcBuf[i10 + 2] * a10 +
              srcBuf[i01 + 2] * a01 +
              srcBuf[i11 + 2] * a11) /
            aSum;

          compositePixel((py * width + px) * 4, sr, sg, sb, srcA);
        }
      }
    },
  };

  const surfaceObj: any = {
    get width() {
      return width;
    },
    set width(v: number) {
      width = Math.max(1, Math.round(v));
      buf = new Uint8ClampedArray(width * height * 4);
    },
    get height() {
      return height;
    },
    set height(v: number) {
      height = Math.max(1, Math.round(v));
      buf = new Uint8ClampedArray(width * height * 4);
    },
    get naturalWidth() {
      return width;
    },
    get naturalHeight() {
      return height;
    },
    complete: true,
    src: `memory://canvas-${width}x${height}`,
    get buf() {
      return buf;
    },
    getContext: (type: string) => (type === '2d' ? ctx : null),
    ctx,
  };
  return surfaceObj;
}

// ============================================================================
// Deterministic Synthetic Stylus Trajectory Generator
// Smooth pressure ramp (0 -> 1 -> 0), tilt sweep, curved S-stroke + sharp corner
// ============================================================================

interface TrajectoryOptions {
  startX?: number;
  startY?: number;
  width?: number;
  baseBrushSize?: number;
  minSizeFactor?: number;
  stepsS?: number;
  stepsCornerLeg?: number;
  includeSharpCorner?: boolean;
  tiltSweep?: boolean;
  constantPressure?: number;
}

function generateSyntheticStylusTrajectory(opts: TrajectoryOptions = {}): {
  points: Point[];
  cornerIndex: number;
  cornerPoint: { x: number; y: number };
} {
  const startX = opts.startX ?? 28;
  const startY = opts.startY ?? 96;
  const spanX = opts.width ?? 176;
  const baseSize = opts.baseBrushSize ?? 16;
  const minFactor = opts.minSizeFactor ?? 0.12;
  const stepsS = opts.stepsS ?? 32;
  const stepsCornerLeg = opts.stepsCornerLeg ?? 12;
  const includeCorner = opts.includeSharpCorner ?? true;
  const tiltSweep = opts.tiltSweep ?? true;

  const totalSteps = includeCorner ? stepsS + stepsCornerLeg : stepsS;
  const points: Point[] = [];

  for (let i = 0; i <= stepsS; i++) {
    const u = i / stepsS;
    const tGlobal = i / totalSteps;
    const x = startX + u * spanX;
    const y = startY - Math.sin(u * Math.PI * 2) * 34;

    // Smooth pressure ramp 0 -> 1 -> 0
    const rawP =
      opts.constantPressure !== undefined
        ? opts.constantPressure
        : Math.max(0.02, Math.sin(tGlobal * Math.PI));
    const width = Math.max(1.0, baseSize * (minFactor + (1 - minFactor) * rawP));

    // Tilt sweep from upright (5 deg) to heavily tilted (68 deg)
    const tiltX = tiltSweep ? Math.round(5 + 63 * tGlobal) : 0;
    const tiltY = tiltSweep ? Math.round(18 * Math.sin(tGlobal * Math.PI)) : 0;

    points.push({
      x,
      y,
      pressure: rawP,
      width,
      tiltX,
      tiltY,
      twist: Math.round(u * 90),
      timestamp: i * 10,
      isCorner: includeCorner && i === stepsS,
    });
  }

  const cornerIndex = points.length - 1;
  const cornerPt = { x: points[cornerIndex].x, y: points[cornerIndex].y };

  if (includeCorner) {
    // Sharp ~125-degree reversal down-left to stress corner snapping & miter guards
    const endX = cornerPt.x - 42;
    const endY = cornerPt.y + 46;
    for (let j = 1; j <= stepsCornerLeg; j++) {
      const v = j / stepsCornerLeg;
      const tGlobal = (stepsS + j) / totalSteps;
      const x = cornerPt.x + (endX - cornerPt.x) * v;
      const y = cornerPt.y + (endY - cornerPt.y) * v;
      const rawP =
        opts.constantPressure !== undefined
          ? opts.constantPressure
          : Math.max(0.02, Math.sin(tGlobal * Math.PI));
      const width = Math.max(1.0, baseSize * (minFactor + (1 - minFactor) * rawP));
      const tiltX = tiltSweep ? Math.round(5 + 63 * tGlobal) : 0;
      const tiltY = tiltSweep ? Math.round(18 * Math.sin(tGlobal * Math.PI)) : 0;

      points.push({
        x,
        y,
        pressure: rawP,
        width,
        tiltX,
        tiltY,
        twist: Math.round(90 + v * 45),
        timestamp: (stepsS + j) * 10,
        isCorner: false,
      });
    }
  }

  return { points, cornerIndex, cornerPoint: cornerPt };
}

function generateHorizontalStroke(
  x0: number,
  x1: number,
  y: number,
  baseSize: number,
  steps: number = 32,
  pressureFn?: (u: number) => number,
  tiltFn?: (u: number) => { tiltX: number; tiltY: number }
): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const p = pressureFn ? pressureFn(u) : 0.85;
    const tilt = tiltFn ? tiltFn(u) : { tiltX: 0, tiltY: 0 };
    pts.push({
      x: x0 + (x1 - x0) * u,
      y,
      pressure: p,
      width: Math.max(1, baseSize * p),
      tiltX: tilt.tiltX,
      tiltY: tilt.tiltY,
      timestamp: i * 10,
    });
  }
  return pts;
}

// ============================================================================
// Procedural Tip & Texture Helpers for Headless Raster Verification
// ============================================================================

function makeFlatBristleTip(size: number = 32, tufts: number = 6) {
  const c = createSoftwareCanvas(size, size);
  c.src = `memory://bristle-${size}-${tufts}`;
  const data = c.buf;
  for (let y = 0; y < size; y++) {
    const ny = (y / (size - 1)) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1;
      // Flat elliptical envelope with discrete bristle ridges
      const env = 1 - (nx * nx * 1.15 + ny * ny * 3.2);
      if (env <= 0) continue;
      const ridge = 0.5 + 0.5 * Math.cos(nx * Math.PI * tufts);
      const a = Math.max(0, Math.min(1, env * (0.35 + 0.65 * ridge)));
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  return c as unknown as HTMLImageElement;
}

function makeColorRibbonTip(size: number = 32) {
  const c = createSoftwareCanvas(size, size);
  c.src = `memory://color-ribbon-${size}`;
  const data = c.buf;
  for (let y = 0; y < size; y++) {
    const edgeFade = Math.min(1, Math.min(y + 1, size - y) / 3);
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const frac = x / size;
      // Asymmetric directional RGB pattern so Repeat vs Reverse differ clearly
      if (frac < 0.35) {
        data[i] = 240;
        data[i + 1] = 35;
        data[i + 2] = 35;
      } else if (frac < 0.7) {
        data[i] = 35;
        data[i + 1] = 225;
        data[i + 2] = 55;
      } else {
        data[i] = 35;
        data[i + 1] = 70;
        data[i + 2] = 245;
      }
      data[i + 3] = Math.round(255 * edgeFade);
    }
  }
  return c as unknown as HTMLImageElement;
}

function makeDualToneGrayTip(size: number = 32) {
  const c = createSoftwareCanvas(size, size);
  c.src = `memory://dual-tone-gray-${size}`;
  const data = c.buf;
  const half = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - half, y - half) / half;
      if (dist > 1.0) continue;
      const i = (y * size + x) * 4;
      // Dark center (gray=0 -> Main Color), bright outer ring (gray=255 -> Sub Color)
      const gray = dist < 0.52 ? 0 : 255;
      data[i] = gray;
      data[i + 1] = gray;
      data[i + 2] = gray;
      data[i + 3] = 255;
    }
  }
  return c as unknown as HTMLImageElement;
}

function makeCheckerGrainTexture(size: number = 32) {
  const c = createSoftwareCanvas(size, size);
  c.src = `memory://checker-grain-${size}`;
  const data = c.buf;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const v = ((Math.floor(x / 3) + Math.floor(y / 3)) & 1) === 0 ? 235 : 30;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return c as unknown as HTMLImageElement;
}

function makeDualPatternTip(size: number = 24) {
  const c = createSoftwareCanvas(size, size);
  c.src = `memory://dual-pattern-${size}`;
  const data = c.buf;
  const half = (size - 1) * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - half, y - half) / half;
      if (d > 1) continue;
      // Ring + core pattern so multiply/subtract/height show rich texture modulation
      const a = d < 0.45 ? 1.0 : d < 0.72 ? 0.25 : 0.85;
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  return c as unknown as HTMLImageElement;
}

// ============================================================================
// Quantitative Raster Metric Helpers
// ============================================================================

interface RasterMetrics {
  litPixels: number;
  opaquePixels: number;
  semiTransparentPixels: number;
  alphaSum: number;
  meanLitAlpha: number;
  alphaVariance: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  hasInvalidValues: boolean;
}

function analyzeRaster(buf: Uint8ClampedArray, width: number, height: number): RasterMetrics {
  let litPixels = 0;
  let opaquePixels = 0;
  let semiTransparentPixels = 0;
  let alphaSum = 0;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  let hasInvalidValues = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = buf[i];
      const g = buf[i + 1];
      const b = buf[i + 2];
      const a = buf[i + 3];
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a)) {
        hasInvalidValues = true;
      }
      if (a > 0) {
        litPixels++;
        alphaSum += a;
        if (a === 255) opaquePixels++;
        else semiTransparentPixels++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const meanLitAlpha = litPixels > 0 ? alphaSum / litPixels : 0;
  let sqDiff = 0;
  if (litPixels > 0) {
    for (let i = 3; i < buf.length; i += 4) {
      if (buf[i] > 0) {
        const d = buf[i] - meanLitAlpha;
        sqDiff += d * d;
      }
    }
  }

  return {
    litPixels,
    opaquePixels,
    semiTransparentPixels,
    alphaSum,
    meanLitAlpha,
    alphaVariance: litPixels > 0 ? sqDiff / litPixels : 0,
    minX,
    maxX,
    minY,
    maxY,
    hasInvalidValues,
  };
}

function measureVerticalExtentAtX(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
  xCenter: number,
  halfWindow: number = 2,
  alphaThreshold: number = 20
): number {
  let minY = height;
  let maxY = -1;
  const x0 = Math.max(0, Math.round(xCenter - halfWindow));
  const x1 = Math.min(width - 1, Math.round(xCenter + halfWindow));
  for (let y = 0; y < height; y++) {
    for (let x = x0; x <= x1; x++) {
      if (buf[(y * width + x) * 4 + 3] >= alphaThreshold) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxY >= minY ? maxY - minY + 1 : 0;
}

function countUnbrokenCenterlineCoverage(
  buf: Uint8ClampedArray,
  width: number,
  height: number,
  points: Point[],
  radius: number = 2
): { covered: number; total: number } {
  let covered = 0;
  for (const pt of points) {
    const cx = Math.round(pt.x);
    const cy = Math.round(pt.y);
    let maxA = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const px = cx + dx;
        const py = cy + dy;
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const a = buf[(py * width + px) * 4 + 3];
          if (a > maxA) maxA = a;
        }
      }
    }
    if (maxA > 10) covered++;
  }
  return { covered, total: points.length };
}

function baseBrushSettings(overrides: Partial<BrushSettings> = {}): BrushSettings {
  return {
    size: 16,
    minSizeFactor: 0.12,
    color: '#181818',
    secondaryColor: '#2563eb',
    opacity: 1.0,
    flow: 1.0,
    spacing: 0.06,
    hardness: 1.0,
    thickness: 1.0,
    antiAlias: 2,
    usePressure: true,
    useTilt: false,
    smoothing: true,
    stabilization: 0,
    sharpCorners: true,
    useGpu: false,
    ...overrides,
  };
}

// ============================================================================
// Golden Parity Test Suite
// ============================================================================

describe('CSP .sut Golden Parity Suite (9 Canonical Archetypes + Preview + Persistence)', () => {
  const prevDoc = (globalThis as any).document;
  const prevWindow = (globalThis as any).window;
  const prevLocalStorage = (globalThis as any).localStorage;
  let lsStore: Map<string, string>;

  beforeEach(() => {
    clearBrushPreviewCache();
    resetBrushStorageCache();
    lsStore = new Map<string, string>();
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return createSoftwareCanvas(64, 64);
        return {};
      },
    };
    (globalThis as any).window = {
      devicePixelRatio: 1,
      dispatchEvent: () => true,
    };
    (globalThis as any).localStorage = {
      getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
      setItem: (k: string, v: string) => {
        lsStore.set(k, String(v));
      },
      removeItem: (k: string) => {
        lsStore.delete(k);
      },
      clear: () => lsStore.clear(),
    };
  });

  afterEach(() => {
    (globalThis as any).document = prevDoc;
    (globalThis as any).window = prevWindow;
    (globalThis as any).localStorage = prevLocalStorage;
  });

  // --------------------------------------------------------------------------
  // Archetype 1: Hard Inker / G-Pen
  // --------------------------------------------------------------------------
  it('Archetype 1: Hard Inker / G-Pen preserves S-curve pressure, sharp corners, and crisp AA', () => {
    const W = 256;
    const H = 192;
    const traj = generateSyntheticStylusTrajectory({
      baseBrushSize: 16,
      minSizeFactor: 0.08,
      includeSharpCorner: true,
      tiltSweep: false,
    });

    const sCurve: [number, number][] = [
      [0, 0],
      [0.25, 0.08],
      [0.5, 0.48],
      [0.75, 0.9],
      [1, 1],
    ];

    const cBinary = createSoftwareCanvas(W, H);
    renderCompleteStroke(
      cBinary.ctx,
      traj.points,
      baseBrushSettings({
        size: 16,
        minSizeFactor: 0.08,
        hardness: 1.0,
        spacing: 0.04,
        antiAlias: 0,
        sharpCorners: true,
        pressureCurve: sCurve,
      }),
      'brush',
      'color'
    );

    const cSmooth = createSoftwareCanvas(W, H);
    renderCompleteStroke(
      cSmooth.ctx,
      traj.points,
      baseBrushSettings({
        size: 16,
        minSizeFactor: 0.08,
        hardness: 1.0,
        spacing: 0.04,
        antiAlias: 2,
        sharpCorners: true,
        pressureCurve: sCurve,
      }),
      'brush',
      'color'
    );

    const mBin = analyzeRaster(cBinary.buf, W, H);
    const mSmooth = analyzeRaster(cSmooth.buf, W, H);

    expect(mBin.hasInvalidValues).toBe(false);
    expect(mSmooth.hasInvalidValues).toBe(false);
    expect(mBin.litPixels).toBeGreaterThan(800);
    expect(mSmooth.litPixels).toBeGreaterThan(800);

    // Binary AA=0 invariant: strictly crisp 0/255 alpha histogram
    expect(mBin.semiTransparentPixels).toBe(0);
    expect(mBin.opaquePixels).toBe(mBin.litPixels);

    // Smooth AA=2 invariant: crisp opaque interior + narrow anti-aliased edge band
    expect(mSmooth.opaquePixels).toBeGreaterThan(mSmooth.litPixels * 0.55);
    expect(mSmooth.semiTransparentPixels).toBeGreaterThan(20);
    expect(mSmooth.semiTransparentPixels / mSmooth.litPixels).toBeLessThan(0.45);

    // Sharp corner apex inked solidly with zero dropouts
    const cov = countUnbrokenCenterlineCoverage(cSmooth.buf, W, H, traj.points, 2);
    expect(cov.covered).toBe(cov.total);
    const cx = Math.round(traj.cornerPoint.x);
    const cy = Math.round(traj.cornerPoint.y);
    expect(cSmooth.buf[(cy * W + cx) * 4 + 3]).toBeGreaterThan(200);

    // Pressure ramp width invariant: peak mid-stroke clearly thicker than start tip
    const startExtent = measureVerticalExtentAtX(cSmooth.buf, W, H, traj.points[1].x, 1);
    const peakExtent = measureVerticalExtentAtX(cSmooth.buf, W, H, traj.points[22].x, 2);
    expect(peakExtent).toBeGreaterThan(startExtent);
  });

  // --------------------------------------------------------------------------
  // Archetype 2: Textured Pencil
  // --------------------------------------------------------------------------
  it('Archetype 2: Textured Pencil applies tilt spread, opacity/density sensors, and height vs compare grain', () => {
    const W = 256;
    const H = 128;
    const grainTex = makeCheckerGrainTexture(32);

    const pts = generateHorizontalStroke(
      24,
      232,
      64,
      14,
      36,
      (u) => 0.35 + 0.6 * Math.sin(u * Math.PI),
      (u) => ({ tiltX: Math.round(5 + 65 * u), tiltY: 0 })
    );

    const makePencil = (mode: CspPaperTextureMode): BrushSettings =>
      baseBrushSettings({
        size: 14,
        minSizeFactor: 0.2,
        hardness: 0.78,
        flow: 0.75,
        spacing: 0.08,
        usePressure: true,
        useTilt: true,
        tiltScale: 1.6,
        sizeSensor: { usePressure: true, pressureMin: 0.25, useTilt: true, tiltMin: 0.4 },
        opacitySensor: { usePressure: true, pressureMin: 0.25 },
        densitySensor: { usePressure: true, pressureMin: 0.3 },
        grain: 0.85,
        textureDensity: 0.85,
        paperTextureImage: grainTex,
        paperTextureMode: mode,
        paperTextureScale: 1.0,
        paperTextureApplyEachPlot: false,
      });

    const cHeight = createSoftwareCanvas(W, H);
    renderCompleteStroke(cHeight.ctx, pts, makePencil('height'), 'brush', 'color');

    const cCompare = createSoftwareCanvas(W, H);
    renderCompleteStroke(cCompare.ctx, pts, makePencil('compare'), 'brush', 'color');

    const mHeight = analyzeRaster(cHeight.buf, W, H);
    const mCompare = analyzeRaster(cCompare.buf, W, H);

    expect(mHeight.hasInvalidValues).toBe(false);
    expect(mCompare.hasInvalidValues).toBe(false);
    expect(mHeight.litPixels).toBeGreaterThan(400);
    expect(mCompare.litPixels).toBeGreaterThan(400);

    // Grain texture contrast invariant: measurable variance in alpha across the textured stroke
    expect(mHeight.alphaVariance).toBeGreaterThan(150);
    expect(mCompare.alphaVariance).toBeGreaterThan(80);

    // Distinct alpha histogram between 'height' and 'compare'
    let pixelDiffCount = 0;
    for (let i = 3; i < cHeight.buf.length; i += 4) {
      if (Math.abs(cHeight.buf[i] - cCompare.buf[i]) > 8) pixelDiffCount++;
    }
    expect(pixelDiffCount).toBeGreaterThan(80);

    // Tilt spread invariant: later high-tilt region should be wider than early low-tilt region at comparable pressure
    const cTilt = createSoftwareCanvas(W, H);
    const constPressTiltPts = generateHorizontalStroke(
      24,
      232,
      64,
      14,
      36,
      () => 0.75,
      (u) => ({ tiltX: Math.round(5 + 70 * u), tiltY: 0 })
    );
    renderCompleteStroke(
      cTilt.ctx,
      constPressTiltPts,
      baseBrushSettings({
        size: 14,
        hardness: 0.85,
        flow: 0.9,
        spacing: 0.06,
        useTilt: true,
        tiltScale: 1.8,
        sizeSensor: { useTilt: true, tiltMin: 0.35 },
      }),
      'brush',
      'color'
    );
    const lowTiltW = measureVerticalExtentAtX(cTilt.buf, W, H, 45, 3);
    const highTiltW = measureVerticalExtentAtX(cTilt.buf, W, H, 210, 3);
    expect(highTiltW).toBeGreaterThan(lowTiltW);
  });

  // --------------------------------------------------------------------------
  // Archetype 3: Flat Oil Paint
  // --------------------------------------------------------------------------
  it('Archetype 3: Flat Oil Paint produces spatial color mixing gradient, per-plot grain, and taper', () => {
    const W = 256;
    const H = 128;
    const flatTip = makeFlatBristleTip(32, 5);
    const grainTex = makeCheckerGrainTexture(32);

    const prepareSplitCanvas = () => {
      const c = createSoftwareCanvas(W, H);
      c.ctx.fillStyle = '#dc2626';
      c.ctx.fillRect(0, 0, W / 2, H);
      c.ctx.fillStyle = '#2563eb';
      c.ctx.fillRect(W / 2, 0, W / 2, H);
      return c;
    };

    const pts = generateHorizontalStroke(24, 232, 64, 24, 40, (u) =>
      Math.max(0.15, Math.sin(u * Math.PI))
    );

    const oilSettings = baseBrushSettings({
      size: 24,
      color: '#facc15',
      flow: 0.9,
      spacing: 0.08,
      customTipImage: flatTip,
      customTipAngleDynamics: 'direction',
      colorMixing: true,
      perceptualMixing: true,
      amountOfPaint: 0.55,
      densityOfPaint: 0.85,
      colorStretch: 0.8,
      amountOfPaintSensor: { usePressure: true, pressureMin: 0.15 },
      grain: 0.65,
      textureDensity: 0.65,
      paperTextureImage: grainTex,
      paperTextureMode: 'multiply',
      paperTextureApplyEachPlot: true, // TextureForPlot=1
      taper: {
        useIn: true,
        inLength: 44,
        inRatio: 0.9,
        useOut: true,
        outLength: 44,
        outRatio: 0.9,
        affectSize: true,
        affectAmountOfPaint: true,
        minSizeRatio: 0.1,
        minAmountRatio: 0.1,
      },
    });

    const cOil = prepareSplitCanvas();
    const sampler = new LayerPixelSampler(cOil);
    renderCompleteStroke(cOil.ctx, pts, oilSettings, 'brush', 'color', false, cOil, false, sampler);

    const mOil = analyzeRaster(cOil.buf, W, H);
    expect(mOil.hasInvalidValues).toBe(false);

    // Color mixing gradient invariant: crossing from red half into blue half with yellow paint
    // produces warm orange-ish pixels on the red side and greenish/blended pixels past x=128
    const sampleBandAvg = (x0: number, x1: number, y0: number, y1: number) => {
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = (y * W + x) * 4;
          r += cOil.buf[i];
          g += cOil.buf[i + 1];
          b += cOil.buf[i + 2];
          n++;
        }
      }
      return { r: r / n, g: g / n, b: b / n };
    };
    const leftSide = sampleBandAvg(72, 104, 62, 66);
    const untouchedLeft = sampleBandAvg(72, 104, 8, 12);
    const rightSide = sampleBandAvg(140, 172, 62, 66);
    const untouchedRight = sampleBandAvg(140, 172, 8, 12);

    // Stroke visibly altered both halves and carried mixed pigment across the boundary
    expect(leftSide.g).toBeGreaterThan(untouchedLeft.g + 25); // Yellow mixed with red increases G
    expect(
      Math.abs(rightSide.g - untouchedRight.g) +
        Math.abs(rightSide.r - untouchedRight.r) +
        Math.abs(rightSide.b - untouchedRight.b)
    ).toBeGreaterThan(25);
    expect(leftSide.r).toBeGreaterThan(rightSide.r); // Gradient preserves underlying red->blue shift

    // TextureForPlot=1 creates measurable spatial texture variance along the stroke
    const cNoGrainOil = prepareSplitCanvas();
    renderCompleteStroke(
      cNoGrainOil.ctx,
      pts,
      { ...oilSettings, grain: 0, textureDensity: 0, paperTextureImage: undefined },
      'brush',
      'color',
      false,
      cNoGrainOil,
      false,
      new LayerPixelSampler(cNoGrainOil)
    );
    let grainDiffSum = 0;
    for (let x = 60; x <= 190; x++) {
      const i = (64 * W + x) * 4;
      grainDiffSum +=
        Math.abs(cOil.buf[i] - cNoGrainOil.buf[i]) +
        Math.abs(cOil.buf[i + 1] - cNoGrainOil.buf[i + 1]) +
        Math.abs(cOil.buf[i + 2] - cNoGrainOil.buf[i + 2]);
    }
    expect(grainDiffSum).toBeGreaterThan(200);

    // Compare against untapered stroke on blank canvas to confirm taper narrows endpoints
    const cTapered = createSoftwareCanvas(W, H);
    renderCompleteStroke(
      cTapered.ctx,
      generateHorizontalStroke(24, 232, 64, 24, 40, () => 0.9),
      { ...oilSettings, colorMixing: false, grain: 0, textureDensity: 0 },
      'brush',
      'color'
    );
    const cUntapered = createSoftwareCanvas(W, H);
    renderCompleteStroke(
      cUntapered.ctx,
      generateHorizontalStroke(24, 232, 64, 24, 40, () => 0.9),
      { ...oilSettings, colorMixing: false, grain: 0, textureDensity: 0, taper: undefined },
      'brush',
      'color'
    );
    const taperedEndW = measureVerticalExtentAtX(cTapered.buf, W, H, 28, 2);
    const untaperedEndW = measureVerticalExtentAtX(cUntapered.buf, W, H, 28, 2);
    expect(taperedEndW).toBeLessThan(untaperedEndW);
  });

  // --------------------------------------------------------------------------
  // Archetype 4: Pure Blender / Fur Blend
  // --------------------------------------------------------------------------
  it('Archetype 4: Pure Blender (Amount=0, Density=0, Stretch=100%) blends canvas colors without injecting foreground pigment', () => {
    const W = 256;
    const H = 128;
    const bristleTip = makeFlatBristleTip(32, 7);

    const cBase = createSoftwareCanvas(W, H);
    cBase.ctx.fillStyle = '#e11d48'; // Crimson left
    cBase.ctx.fillRect(0, 0, 120, H);
    cBase.ctx.fillStyle = '#1d4ed8'; // Royal blue right
    cBase.ctx.fillRect(120, 0, W - 120, H);

    const pts = generateHorizontalStroke(48, 210, 64, 24, 36, () => 0.9);
    const blenderSettings = baseBrushSettings({
      size: 24,
      color: '#00ff00', // Bright green foreground MUST NOT be injected!
      flow: 0.9,
      spacing: 0.08,
      customTipImage: bristleTip,
      customTipAngleDynamics: 'direction',
      colorMixing: true,
      perceptualMixing: true,
      amountOfPaint: 0,
      densityOfPaint: 0,
      colorStretch: 1.0,
      mixingMode: 'blend',
    });

    const sampler = new LayerPixelSampler(cBase);
    renderCompleteStroke(cBase.ctx, pts, blenderSettings, 'brush', 'color', false, cBase, false, sampler);

    const mBlend = analyzeRaster(cBase.buf, W, H);
    expect(mBlend.hasInvalidValues).toBe(false);

    // Downstream of x=120 along y=64, crimson pigment was stretched into blue without green injection
    let stretchedRedIntoBluePixels = 0;
    let maxGreenSpill = 0;
    for (let x = 124; x <= 170; x++) {
      const i = (64 * W + x) * 4;
      const r = cBase.buf[i];
      const g = cBase.buf[i + 1];
      const b = cBase.buf[i + 2];
      if (r > 55 && b > 90) stretchedRedIntoBluePixels++;
      if (g > maxGreenSpill) maxGreenSpill = g;
    }
    expect(stretchedRedIntoBluePixels).toBeGreaterThan(10);
    // Bright green (#00ff00) foreground must never contaminate pure blender
    expect(maxGreenSpill).toBeLessThan(120);

    // On a blank transparent canvas, pure blender (Amount=0, Density=0) does not drop opaque green blobs
    const cEmpty = createSoftwareCanvas(W, H);
    renderCompleteStroke(
      cEmpty.ctx,
      pts,
      blenderSettings,
      'brush',
      'color',
      false,
      cEmpty,
      false,
      new LayerPixelSampler(cEmpty)
    );
    const mEmpty = analyzeRaster(cEmpty.buf, W, H);
    expect(mEmpty.opaquePixels).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Archetype 5: Watercolor
  // --------------------------------------------------------------------------
  it('Archetype 5: Watercolor creates wet-edge rim, perceptual blue+yellow green shift, and bounded compare tip blend', () => {
    const W = 256;
    const H = 128;
    const pts = generateHorizontalStroke(32, 224, 64, 28, 32, () => 0.9);

    const commonWc: Partial<BrushSettings> = {
      size: 28,
      color: '#2563eb',
      flow: 0.45,
      opacity: 1.0,
      spacing: 0.06,
      hardness: 0.7,
      blendTipsMode: 'compare',
    };

    const cNoWet = createSoftwareCanvas(W, H);
    renderCompleteStroke(
      cNoWet.ctx,
      pts,
      baseBrushSettings({ ...commonWc, wetEdge: 0 }),
      'brush',
      'color'
    );

    const cWet = createSoftwareCanvas(W, H);
    renderCompleteStroke(
      cWet.ctx,
      pts,
      baseBrushSettings({
        ...commonWc,
        wetEdge: 0.9,
        wetEdgeRadius: 4,
        wetEdgeAlphaPower: 0.7,
        wetEdgeValuePower: 0.5,
      }),
      'brush',
      'color'
    );

    const mNoWet = analyzeRaster(cNoWet.buf, W, H);
    const mWet = analyzeRaster(cWet.buf, W, H);
    expect(mNoWet.hasInvalidValues).toBe(false);
    expect(mWet.hasInvalidValues).toBe(false);
    expect(mWet.litPixels).toBeGreaterThan(1000);

    // Compare tip blend invariant: interior alpha stays bounded below 255 even with tight 6% overlap
    const centerIdx = (64 * W + 128) * 4;
    expect(cNoWet.buf[centerIdx + 3]).toBeGreaterThan(70);
    expect(cNoWet.buf[centerIdx + 3]).toBeLessThan(200);

    // Wet Edge rim invariant: border band has darker value & elevated alpha rim compared to non-wet
    let rimDarkerCount = 0;
    let rimAlphaBoostCount = 0;
    for (let y = 44; y <= 84; y++) {
      const i = (y * W + 128) * 4;
      const wetA = cWet.buf[i + 3];
      const baseA = cNoWet.buf[i + 3];
      if (wetA > baseA + 6) rimAlphaBoostCount++;
      if (wetA > 40 && baseA > 40) {
        const wetLum = 0.299 * cWet.buf[i] + 0.587 * cWet.buf[i + 1] + 0.114 * cWet.buf[i + 2];
        const baseLum = 0.299 * cNoWet.buf[i] + 0.587 * cNoWet.buf[i + 1] + 0.114 * cNoWet.buf[i + 2];
        if (wetLum < baseLum - 3) rimDarkerCount++;
      }
    }
    expect(rimAlphaBoostCount + rimDarkerCount).toBeGreaterThan(2);

    // Perceptual mixing invariant: blue paint over yellow canvas yields greener mix than linear RGB
    const paintBlueOverYellow = (perceptual: boolean) => {
      const c = createSoftwareCanvas(W, H);
      c.ctx.fillStyle = '#fde047';
      c.ctx.fillRect(0, 0, W, H);
      renderCompleteStroke(
        c.ctx,
        pts,
        baseBrushSettings({
          size: 24,
          color: '#1d4ed8',
          flow: 0.7,
          spacing: 0.08,
          colorMixing: true,
          perceptualMixing: perceptual,
          amountOfPaint: 0.5,
          densityOfPaint: 0.65,
          colorStretch: 0.5,
        }),
        'brush',
        'color',
        false,
        c,
        false,
        new LayerPixelSampler(c)
      );
      let greenness = 0;
      let n = 0;
      for (let x = 70; x <= 180; x += 2) {
        const i = (64 * W + x) * 4;
        greenness += c.buf[i + 1] - (c.buf[i] + c.buf[i + 2]) * 0.5;
        n++;
      }
      return greenness / n;
    };

    const perceptualGreen = paintBlueOverYellow(true);
    const linearGreen = paintBlueOverYellow(false);
    expect(perceptualGreen).toBeGreaterThan(linearGreen + 5);
  });

  // --------------------------------------------------------------------------
  // Archetype 6: Decorative Ribbon
  // --------------------------------------------------------------------------
  it('Archetype 6: Decorative Ribbon deforms color tip continuously across S-stroke + corner in repeat and reverse modes', () => {
    const W = 256;
    const H = 192;
    const ribbonTip = makeColorRibbonTip(32);
    const traj = generateSyntheticStylusTrajectory({
      baseBrushSize: 18,
      minSizeFactor: 0.45,
      includeSharpCorner: true,
      tiltSweep: false,
    });

    const cRepeat = createSoftwareCanvas(W, H);
    renderCompleteStroke(
      cRepeat.ctx,
      traj.points,
      baseBrushSettings({
        size: 18,
        minSizeFactor: 0.45,
        isRibbon: true,
        isColorTip: true,
        customTipAngle: 90,
        customTipImage: ribbonTip,
        subTipOrder: 'sequential',
      }),
      'brush',
      'color'
    );

    const cReverse = createSoftwareCanvas(W, H);
    renderCompleteStroke(
      cReverse.ctx,
      traj.points,
      baseBrushSettings({
        size: 18,
        minSizeFactor: 0.45,
        isRibbon: true,
        isColorTip: true,
        customTipAngle: 90,
        customTipImage: ribbonTip,
        subTipOrder: 'reverse',
      }),
      'brush',
      'color'
    );

    const mRep = analyzeRaster(cRepeat.buf, W, H);
    const mRev = analyzeRaster(cReverse.buf, W, H);
    expect(mRep.hasInvalidValues).toBe(false);
    expect(mRev.hasInvalidValues).toBe(false);
    expect(mRep.litPixels).toBeGreaterThan(1000);

    // Zero dropouts along the S-stroke + sharp corner
    const cov = countUnbrokenCenterlineCoverage(cRepeat.buf, W, H, traj.points, 3);
    expect(cov.covered).toBeGreaterThanOrEqual(cov.total - 1);

    // Full color preservation from color tip (red, green, and blue pixels all present)
    let redPx = 0;
    let greenPx = 0;
    let bluePx = 0;
    let diffRepeatVsReverse = 0;
    for (let i = 0; i < cRepeat.buf.length; i += 4) {
      if (cRepeat.buf[i + 3] > 120) {
        const r = cRepeat.buf[i];
        const g = cRepeat.buf[i + 1];
        const b = cRepeat.buf[i + 2];
        if (r > g + 60 && r > b + 60) redPx++;
        if (g > r + 60 && g > b + 60) greenPx++;
        if (b > r + 60 && b > g + 60) bluePx++;
      }
      if (
        cRepeat.buf[i + 3] > 100 &&
        cReverse.buf[i + 3] > 100 &&
        (Math.abs(cRepeat.buf[i] - cReverse.buf[i]) > 40 ||
          Math.abs(cRepeat.buf[i + 2] - cReverse.buf[i + 2]) > 40)
      ) {
        diffRepeatVsReverse++;
      }
    }
    expect(redPx).toBeGreaterThan(100);
    expect(greenPx).toBeGreaterThan(100);
    expect(bluePx).toBeGreaterThan(100);
    expect(diffRepeatVsReverse).toBeGreaterThan(100);
  });

  // --------------------------------------------------------------------------
  // Archetype 7: Dual Brush (multiply, subtract, height)
  // --------------------------------------------------------------------------
  it('Archetype 7: Dual Brush applies independent secondary spacing/size across multiply, subtract, and height modes', () => {
    const W = 256;
    const H = 128;
    const secTip = makeDualPatternTip(24);
    const pts = generateHorizontalStroke(28, 228, 64, 26, 36, () => 0.9);

    const cPrimaryOnly = createSoftwareCanvas(W, H);
    renderCompleteStroke(
      cPrimaryOnly.ctx,
      pts,
      baseBrushSettings({
        size: 26,
        flow: 0.85,
        spacing: 0.06,
        hardness: 0.85,
        dualBrush: false,
      }),
      'brush',
      'color'
    );

    const renderDual = (mode: 'multiply' | 'subtract' | 'height') => {
      const c = createSoftwareCanvas(W, H);
      renderCompleteStroke(
        c.ctx,
        pts,
        baseBrushSettings({
          size: 26,
          flow: 0.85,
          spacing: 0.06,
          hardness: 0.85,
          dualBrush: true,
          dualBrushConfig: {
            enabled: true,
            compositeMode: mode,
            linkSizeWithMain: false,
            size: 18,
            spacing: 0.42, // Independent wide secondary spacing creates visible rhythmic modulation
            hardness: 0.9,
            density: 0.85,
            tipImage: secTip,
          },
        }),
        'brush',
        'color'
      );
      return c;
    };

    const cMul = renderDual('multiply');
    const cSub = renderDual('subtract');
    const cHeight = renderDual('height');

    const mPrim = analyzeRaster(cPrimaryOnly.buf, W, H);
    const mMul = analyzeRaster(cMul.buf, W, H);
    const mSub = analyzeRaster(cSub.buf, W, H);
    const mHeight = analyzeRaster(cHeight.buf, W, H);

    expect(mMul.hasInvalidValues).toBe(false);
    expect(mSub.hasInvalidValues).toBe(false);
    expect(mHeight.hasInvalidValues).toBe(false);

    // Multiply and Subtract strictly reduce total alpha mass compared to unmodulated primary
    expect(mMul.alphaSum).toBeGreaterThan(0);
    expect(mMul.alphaSum).toBeLessThan(mPrim.alphaSum * 0.92);
    expect(mSub.alphaSum).toBeGreaterThan(0);
    expect(mSub.alphaSum).toBeLessThan(mPrim.alphaSum * 0.92);
    expect(mHeight.alphaSum).toBeGreaterThan(0);

    // All three dual combine modes produce mutually distinct alpha distributions
    const l1DiffAlpha = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let sum = 0;
      for (let i = 3; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]);
      return sum;
    };
    expect(l1DiffAlpha(cMul.buf, cSub.buf)).toBeGreaterThan(5000);
    expect(l1DiffAlpha(cMul.buf, cHeight.buf)).toBeGreaterThan(5000);
    expect(l1DiffAlpha(cSub.buf, cHeight.buf)).toBeGreaterThan(5000);
  });

  // --------------------------------------------------------------------------
  // Archetype 8: Spray + Color Jitter (per-dab & per-stroke)
  // --------------------------------------------------------------------------
  it('Archetype 8: Spray scatters particles and Color Jitter differentiates per-dab vs per-stroke variance', () => {
    const W = 256;
    const H = 160;
    const pts = generateHorizontalStroke(32, 224, 80, 34, 24, () => 0.9);

    const makeSpraySettings = (perStroke: boolean): BrushSettings =>
      baseBrushSettings({
        size: 34,
        color: '#e11d48',
        secondaryColor: '#0284c7',
        flow: 0.95,
        spacing: 0.25,
        hardness: 0.9,
        spray: {
          enabled: true,
          size: 30,
          particleSize: 6,
          density: 8,
          bias: 0,
        },
        dynamics: {
          ...DEFAULT_BRUSH_DYNAMICS,
          colorJitterEnabled: true,
          colorJitterPerStroke: perStroke,
          hueJitter: 0.9,
          saturationJitter: 0.5,
          brightnessJitter: 0.4,
          foregroundBackgroundJitter: 0.35,
        },
      });

    const cPerDab = createSoftwareCanvas(W, H);
    renderCompleteStroke(cPerDab.ctx, pts, makeSpraySettings(false), 'brush', 'color');

    const cPerStroke = createSoftwareCanvas(W, H);
    renderCompleteStroke(cPerStroke.ctx, pts, makeSpraySettings(true), 'brush', 'color');

    const mDab = analyzeRaster(cPerDab.buf, W, H);
    const mStroke = analyzeRaster(cPerStroke.buf, W, H);

    expect(mDab.hasInvalidValues).toBe(false);
    expect(mStroke.hasInvalidValues).toBe(false);
    expect(mDab.litPixels).toBeGreaterThan(250);
    expect(mStroke.litPixels).toBeGreaterThan(250);

    // Spray bounding box spreads well beyond a thin centerline
    expect(mDab.maxY - mDab.minY).toBeGreaterThan(20);

    // Count distinct quantized RGB buckets among strongly opaque pixels
    const countDistinctColors = (buf: Uint8ClampedArray) => {
      const buckets = new Set<string>();
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i + 3] >= 180) {
          buckets.add(`${buf[i] >> 4},${buf[i + 1] >> 4},${buf[i + 2] >> 4}`);
        }
      }
      return buckets.size;
    };

    const perDabColorCount = countDistinctColors(cPerDab.buf);
    const perStrokeColorCount = countDistinctColors(cPerStroke.buf);

    // Per-dab jitter creates many distinct colors within a single stroke;
    // per-stroke jitter locks all dabs in the stroke to one uniform shifted color!
    expect(perDabColorCount).toBeGreaterThanOrEqual(6);
    expect(perStrokeColorCount).toBeLessThanOrEqual(2);
  });

  // --------------------------------------------------------------------------
  // Archetype 9: Dual-Tone Grayscale Tip (Main + Sub Color) + BrushCombineMode
  // --------------------------------------------------------------------------
  it('Archetype 9: Dual-Tone Grayscale Tip blends Main+Sub colors and honors multiply, add-glow, and behind combine modes', () => {
    const W = 220;
    const H = 128;
    const dualToneTip = makeDualToneGrayTip(32);
    const pts = generateHorizontalStroke(30, 190, 64, 28, 28, () => 0.9);

    // 1. Clean canvas: verify Main (#e02020) and Sub (#2040f0) colors both appear
    const cClean = createSoftwareCanvas(W, H);
    renderCompleteStroke(
      cClean.ctx,
      pts,
      baseBrushSettings({
        size: 28,
        color: '#e02020',
        secondaryColor: '#2040f0',
        customTipImage: dualToneTip,
        isDualToneTip: true,
        spacing: 0.22,
        flow: 1.0,
      }),
      'brush',
      'color'
    );
    let mainRedPx = 0;
    let subBluePx = 0;
    for (let i = 0; i < cClean.buf.length; i += 4) {
      if (cClean.buf[i + 3] > 180) {
        if (cClean.buf[i] > 170 && cClean.buf[i + 2] < 80) mainRedPx++;
        if (cClean.buf[i + 2] > 170 && cClean.buf[i] < 80) subBluePx++;
      }
    }
    expect(mainRedPx).toBeGreaterThan(80);
    expect(subBluePx).toBeGreaterThan(80);

    // 2. BrushCombineMode: multiply (darkens), add-glow (brightens), behind (preserves opaque, paints transparent)
    const makeMidtoneLeftCanvas = () => {
      const c = createSoftwareCanvas(W, H);
      c.ctx.fillStyle = '#808080';
      c.ctx.fillRect(0, 0, 110, H);
      return c;
    };

    const runCombine = (mode: 'multiply' | 'add-glow' | 'behind') => {
      const c = makeMidtoneLeftCanvas();
      renderCompleteStroke(
        c.ctx,
        pts,
        baseBrushSettings({
          size: 26,
          color: '#c06040',
          secondaryColor: '#4080e0',
          customTipImage: dualToneTip,
          isDualToneTip: true,
          spacing: 0.14,
          flow: 0.9,
          brushCombineMode: mode,
        }),
        'brush',
        'color'
      );
      return c;
    };

    const cMul = runCombine('multiply');
    const cAddGlow = runCombine('add-glow');
    const cBehind = runCombine('behind');

    const midLeftIdx = (64 * W + 70) * 4; // Over opaque #808080 region
    const transRightIdx = (64 * W + 150) * 4; // Over transparent region

    // Multiply darkens mid-tone gray (#80=128)
    const mulLum = (cMul.buf[midLeftIdx] + cMul.buf[midLeftIdx + 1] + cMul.buf[midLeftIdx + 2]) / 3;
    expect(mulLum).toBeLessThan(115);

    // Add-Glow brightens mid-tone gray strictly above 128
    const addLum =
      (cAddGlow.buf[midLeftIdx] + cAddGlow.buf[midLeftIdx + 1] + cAddGlow.buf[midLeftIdx + 2]) / 3;
    expect(addLum).toBeGreaterThan(150);

    // Behind preserves opaque left pixel (#808080) untouched while painting into transparent right half
    expect(cBehind.buf[midLeftIdx]).toBe(128);
    expect(cBehind.buf[midLeftIdx + 1]).toBe(128);
    expect(cBehind.buf[midLeftIdx + 2]).toBe(128);
    expect(cBehind.buf[transRightIdx + 3]).toBeGreaterThan(180);
  });

  // --------------------------------------------------------------------------
  // Live-vs-Commit Equivalence
  // --------------------------------------------------------------------------
  it('Live incremental segment emission matches committed renderCompleteStroke pixel-for-pixel', () => {
    const W = 256;
    const H = 192;
    const traj = generateSyntheticStylusTrajectory({
      baseBrushSize: 14,
      minSizeFactor: 0.15,
      includeSharpCorner: true,
      tiltSweep: false,
    });

    const settings = baseBrushSettings({
      size: 14,
      minSizeFactor: 0.15,
      color: '#1e293b',
      flow: 0.85,
      spacing: 0.08,
      hardness: 0.85,
      antiAlias: 2,
      useGpu: false,
    });

    // Committed path
    const cCommit = createSoftwareCanvas(W, H);
    renderCompleteStroke(cCommit.ctx, traj.points, settings, 'brush', 'color');

    // Live incremental segment path (mirrors liveSegmentEmitter.ts + pointerDownInitialStamp.ts)
    const cLive = createSoftwareCanvas(W, H);
    const liveOpts = buildBrushRenderOptions(settings, {
      hardness: settings.hardness,
      flow: settings.flow,
      spacing: settings.spacing,
      antiAlias: settings.antiAlias,
      isEraser: false,
      isBgEraser: false,
      alphaLocked: false,
      isTransparentInk: false,
    });
    const pts = traj.points;
    liveOpts.currentStrokeDist = 0;
    drawBrushDot(cLive.ctx, pts[0], settings.color, liveOpts, undefined);
    const dabCounter = { count: 0 };
    let accDist = Math.max(0.12, Math.max(0.2, pts[0].width) * settings.spacing);

    const first = centripetalCatmullRomToBezier(pts[0], pts[0], pts[1], pts[2]);
    accDist = drawBrushCubicBezierSegment(
      cLive.ctx,
      pts[0],
      first.c1,
      first.c2,
      pts[1],
      settings.color,
      liveOpts,
      accDist,
      dabCounter,
      undefined
    );
    liveOpts.currentStrokeDist += Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);

    for (let i = 2; i < pts.length - 1; i++) {
      const seg = centripetalCatmullRomToBezier(pts[i - 2], pts[i - 1], pts[i], pts[i + 1]);
      accDist = drawBrushCubicBezierSegment(
        cLive.ctx,
        pts[i - 1],
        seg.c1,
        seg.c2,
        pts[i],
        settings.color,
        liveOpts,
        accDist,
        dabCounter,
        undefined
      );
      liveOpts.currentStrokeDist += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }

    const n = pts.length;
    const last = centripetalCatmullRomToBezier(pts[n - 3], pts[n - 2], pts[n - 1], pts[n - 1]);
    drawBrushCubicBezierSegment(
      cLive.ctx,
      pts[n - 2],
      last.c1,
      last.c2,
      pts[n - 1],
      settings.color,
      liveOpts,
      accDist,
      dabCounter,
      undefined
    );

    let maxDiff = 0;
    let totalDiff = 0;
    let litCount = 0;
    for (let i = 0; i < cCommit.buf.length; i += 4) {
      if (cCommit.buf[i + 3] > 0 || cLive.buf[i + 3] > 0) {
        litCount++;
        for (let c = 0; c < 4; c++) {
          const d = Math.abs(cCommit.buf[i + c] - cLive.buf[i + c]);
          if (d > maxDiff) maxDiff = d;
          totalDiff += d;
        }
      }
    }
    expect(litCount).toBeGreaterThan(500);
    expect(maxDiff).toBeLessThanOrEqual(1);
    expect(totalDiff / (litCount * 4)).toBeLessThan(0.05);
  });

  // --------------------------------------------------------------------------
  // Unified BrushPreview Pipeline Verification
  // --------------------------------------------------------------------------
  it('renderBrushStrokePreview renders authentic non-empty previews for ribbon, dualBrush, wetEdge, all 9 paperTextureModes, dualTone, colorJitter, and taper', () => {
    const ribbonTip = makeColorRibbonTip(24);
    const dualToneTip = makeDualToneGrayTip(24);
    const dualPatternTip = makeDualPatternTip(20);
    const grainTex = makeCheckerGrainTexture(24);

    const previewCases: Array<{ name: string; opts: Parameters<typeof renderBrushStrokePreview>[3] }> = [
      {
        name: 'isRibbon',
        opts: { isRibbon: true, isColorTip: true, customTipImage: ribbonTip, size: 16 },
      },
      {
        name: 'dualBrush',
        opts: {
          size: 18,
          dualBrush: true,
          dualBrushConfig: {
            enabled: true,
            compositeMode: 'multiply',
            size: 12,
            spacing: 0.3,
            tipImage: dualPatternTip,
          },
        },
      },
      {
        name: 'wetEdge',
        opts: { size: 18, flow: 0.55, wetEdge: 0.85, wetEdgeRadius: 3, blendTipsMode: 'compare' },
      },
      {
        name: 'isDualToneTip',
        opts: {
          size: 18,
          customTipImage: dualToneTip,
          isDualToneTip: true,
          color: '#ef4444',
          secondaryColor: '#3b82f6',
        },
      },
      {
        name: 'colorJitter',
        opts: {
          size: 16,
          color: '#ef4444',
          secondaryColor: '#22c55e',
          dynamics: {
            ...DEFAULT_BRUSH_DYNAMICS,
            colorJitterEnabled: true,
            colorJitterPerStroke: false,
            hueJitter: 0.85,
            saturationJitter: 0.5,
          },
        },
      },
      {
        name: 'taper',
        opts: {
          size: 18,
          taper: { useIn: true, inLength: 24, inRatio: 0.9, useOut: true, outLength: 24, outRatio: 0.9, affectSize: true },
        },
      },
    ];

    const allPaperModes: CspPaperTextureMode[] = [
      'normal',
      'multiply',
      'subtract',
      'compare',
      'overlay',
      'color-burn',
      'linear-burn',
      'height',
      'outline',
    ];
    for (const mode of allPaperModes) {
      previewCases.push({
        name: `paperTextureMode:${mode}`,
        opts: {
          size: 18,
          grain: 0.8,
          paperTextureImage: grainTex,
          paperTextureMode: mode,
        },
      });
    }

    for (const tc of previewCases) {
      const canvas = createSoftwareCanvas(140, 34);
      renderBrushStrokePreview(canvas, 140, 34, { ...tc.opts, color: tc.opts?.color ?? '#ffffff' }, true);
      const m = analyzeRaster(canvas.buf, 140, 34);
      expect(m.hasInvalidValues, `${tc.name} produced NaN/invalid pixel`).toBe(false);
      expect(m.litPixels, `${tc.name} produced blank preview`).toBeGreaterThan(60);
    }
  });

  // --------------------------------------------------------------------------
  // Lossless Persistence & Round-Trip Serialization Verification
  // --------------------------------------------------------------------------
  it('preserves every new CSP field losslessly across brushStorage, brushPresetManager, inkbBrushFormat, and non-brush .sut importWarnings', async () => {
    const samplePng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

    const allSubTipOrders: CspSubTipOrder[] = [
      'sequential',
      'reverse',
      'random',
      'random-no-repeat',
      'once',
      'direction',
    ];
    const allPaperModes: CspPaperTextureMode[] = [
      'normal',
      'multiply',
      'subtract',
      'compare',
      'overlay',
      'color-burn',
      'linear-burn',
      'height',
      'outline',
    ];

    const fullBrush: CspBrush = {
      id: 'csp-golden-roundtrip-1',
      name: 'Golden Master Brush',
      badge: 'CSP',
      tipDataUrl: samplePng,
      tipWidth: 1,
      tipHeight: 1,
      isDualToneTip: true,
      secondaryTipDataUrl: samplePng,
      subTips: [{ dataUrl: samplePng, width: 1, height: 1, isColor: false, isDualToneTip: true }],
      subTipOrder: 'random-no-repeat',
      size: 28,
      minSizeFactor: 0.15,
      opacity: 0.92,
      flow: 0.78,
      spacing: 0.09,
      hardness: 0.85,
      thickness: 0.65,
      thicknessVertical: true,
      thicknessSensor: { usePressure: true, pressureMin: 0.25, useTilt: true, tiltMin: 0.4 },
      angle: 35,
      angleDynamics: 'direction',
      brushCombineMode: 'add-glow',
      blendTipsMode: 'compare',
      usePressure: true,
      useTilt: true,
      smoothing: true,
      stabilization: 12,
      colorMixing: true,
      perceptualMixing: true,
      amountOfPaint: 0.5,
      densityOfPaint: 0.6,
      colorStretch: 0.85,
      amountOfPaintSensor: { usePressure: true, pressureMin: 0.1 },
      densityOfPaintSensor: { useVelocity: true, velocityMin: 0.2, invertVelocity: true },
      colorStretchSensor: { useTilt: true, tiltMin: 0.3 },
      paperTexture: samplePng,
      textureDensity: 0.72,
      paperTextureMode: 'linear-burn',
      paperTextureApplyEachPlot: true,
      dualBrush: true,
      dualBrushCompositeMode: 'height',
      dualBrushConfig: {
        enabled: true,
        compositeMode: 'height',
        linkSizeWithMain: false,
        size: 18,
        sizeRatio: 0.64,
        spacing: 0.25,
        scatter: 0.4,
        thickness: 0.7,
        thicknessVertical: true,
        hardness: 0.8,
        density: 0.9,
        angle: 45,
        angleDynamics: 'random',
        flipH: 'alternate',
        flipV: 'random',
        tipDataUrl: samplePng,
        subTips: [{ dataUrl: samplePng, width: 1, height: 1, isDualToneTip: true }],
        subTipOrder: 'direction',
        isRibbon: false,
      },
      dynamics: {
        ...DEFAULT_BRUSH_DYNAMICS,
        colorJitterEnabled: true,
        colorJitterPerStroke: true,
        hueJitter: 0.4,
        saturationJitter: 0.3,
        brightnessJitter: 0.2,
      },
      importWarnings: [
        'Missing external paper texture material (.:Install:01:02): not embedded in MaterialFile.',
      ],
      importedAt: Date.now(),
    };

    // 1. brushStorage.ts: save -> verify lightweight localStorage index strips heavy data URLs
    //    even inside dualBrushConfig, while keeping all settings & importWarnings intact
    await saveCustomBrush(fullBrush);
    const lsRaw = lsStore.get(BRUSH_INDEX_LS_KEY);
    expect(lsRaw).toBeTruthy();
    expect(lsRaw!).not.toContain('data:image/png;base64');
    const lsParsed = JSON.parse(lsRaw!) as CspBrush[];
    expect(lsParsed[0].isDualToneTip).toBe(true);
    expect(lsParsed[0].dualBrushConfig?.compositeMode).toBe('height');
    expect(lsParsed[0].dualBrushConfig?.spacing).toBe(0.25);
    expect(lsParsed[0].dualBrushConfig?.tipDataUrl).toBeUndefined();
    expect(lsParsed[0].importWarnings).toEqual(fullBrush.importWarnings);

    const prepared = await prepareBrushSettingsForCsp(fullBrush);
    expect(prepared.isDualToneTip).toBe(true);
    expect(prepared.thicknessSensor).toEqual(fullBrush.thicknessSensor);
    expect(prepared.amountOfPaintSensor).toEqual(fullBrush.amountOfPaintSensor);
    expect(prepared.densityOfPaintSensor).toEqual(fullBrush.densityOfPaintSensor);
    expect(prepared.colorStretchSensor).toEqual(fullBrush.colorStretchSensor);
    expect(prepared.dualBrushConfig?.compositeMode).toBe('height');
    expect(prepared.brushCombineMode).toBe('add-glow');
    expect(prepared.paperTextureMode).toBe('linear-burn');
    expect(prepared.dynamics?.colorJitterPerStroke).toBe(true);
    expect(prepared.importWarnings).toEqual(fullBrush.importWarnings);

    // 2. brushPresetManager.ts: saveBrushSettingsImmediately + getEffectiveBrushSettings
    saveBrushSettingsImmediately(fullBrush.id, {
      isDualToneTip: true,
      thicknessSensor: fullBrush.thicknessSensor,
      amountOfPaintSensor: fullBrush.amountOfPaintSensor,
      densityOfPaintSensor: fullBrush.densityOfPaintSensor,
      colorStretchSensor: fullBrush.colorStretchSensor,
      subTipOrder: 'once',
      paperTextureMode: 'color-burn',
      brushCombineMode: 'behind',
      dynamics: fullBrush.dynamics,
      dualBrushConfig: {
        ...fullBrush.dualBrushConfig!,
        spacing: 0.33,
      },
    });
    const effective = getEffectiveBrushSettings(fullBrush.id, [fullBrush]);
    expect(effective.isDualToneTip).toBe(true);
    expect(effective.thicknessSensor).toEqual(fullBrush.thicknessSensor);
    expect(effective.amountOfPaintSensor).toEqual(fullBrush.amountOfPaintSensor);
    expect(effective.densityOfPaintSensor).toEqual(fullBrush.densityOfPaintSensor);
    expect(effective.colorStretchSensor).toEqual(fullBrush.colorStretchSensor);
    expect(effective.subTipOrder).toBe('once');
    expect(effective.paperTextureMode).toBe('color-burn');
    expect(effective.brushCombineMode).toBe('behind');
    expect(effective.dynamics?.colorJitterPerStroke).toBe(true);
    expect(effective.dualBrushConfig?.spacing).toBe(0.33);
    // Preserved tipDataUrl from CspBrush even though localStorage stripped it
    expect(effective.dualBrushConfig?.tipDataUrl).toBe(samplePng);
    expect(effective.importWarnings).toEqual(fullBrush.importWarnings);

    // 3. inkbBrushFormat.ts: buildExportableBrush -> serializeInkbBrush -> parseInkbFile
    const exportable = buildExportableBrush(fullBrush.id, [fullBrush]);
    const bytes = serializeInkbBrush(exportable);
    const roundTripped = parseInkbFile(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      'Golden.inkb'
    );
    expect(roundTripped.isDualToneTip).toBe(true);
    expect(roundTripped.subTips?.[0]?.isDualToneTip).toBe(true);
    expect(roundTripped.thicknessSensor).toEqual(fullBrush.thicknessSensor);
    expect(roundTripped.amountOfPaintSensor).toEqual(fullBrush.amountOfPaintSensor);
    expect(roundTripped.densityOfPaintSensor).toEqual(fullBrush.densityOfPaintSensor);
    expect(roundTripped.colorStretchSensor).toEqual(fullBrush.colorStretchSensor);
    expect(roundTripped.dualBrushConfig?.compositeMode).toBe('height');
    expect(roundTripped.dualBrushConfig?.spacing).toBe(0.33);
    expect(roundTripped.dualBrushConfig?.tipDataUrl).toBe(samplePng);
    expect(roundTripped.dualBrushConfig?.subTipOrder).toBe('direction');
    expect(roundTripped.dynamics?.colorJitterPerStroke).toBe(true);
    expect(roundTripped.brushCombineMode).toBe('behind');
    expect(roundTripped.paperTextureMode).toBe('color-burn');
    expect(roundTripped.importWarnings).toEqual(fullBrush.importWarnings);

    // Exhaustive enum round-trip check for all 6 subTipOrders and all 9 paperTextureModes
    for (const order of allSubTipOrders) {
      const bBytes = serializeInkbBrush({ ...fullBrush, subTipOrder: order });
      const parsed = parseInkbFile(
        bBytes.buffer.slice(bBytes.byteOffset, bBytes.byteOffset + bBytes.byteLength) as ArrayBuffer
      );
      expect(parsed.subTipOrder).toBe(order);
    }
    for (const mode of allPaperModes) {
      const bBytes = serializeInkbBrush({ ...fullBrush, paperTextureMode: mode });
      const parsed = parseInkbFile(
        bBytes.buffer.slice(bBytes.byteOffset, bBytes.byteOffset + bBytes.byteLength) as ArrayBuffer
      );
      expect(parsed.paperTextureMode).toBe(mode);
    }

    // 4. Unsupported non-brush .sut sub-tool (Liquify) surfaces clean importWarnings
    const liquifyExtract: NativeSutExtract = {
      nodeName: 'CSP Liquify Push',
      variantId: 1,
      variantValues: new Map<string, unknown>([
        ['liquifymode', 0],
        ['liquifystrength', 50],
        ['liquifysize', 80],
      ]),
      materials: [],
    };
    const parsedLiquify = await parseSutExtractedData(liquifyExtract, 'liquify.sut');
    expect(parsedLiquify.importWarnings?.length).toBeGreaterThan(0);
    expect(parsedLiquify.importWarnings![0]).toMatch(/Liquify/i);
  });

  // --------------------------------------------------------------------------
  // Regression: CSP Built-in Chain.sut (BrushRibbon=1, BrushRotation=90°, 300x27 dual-tone strip)
  // --------------------------------------------------------------------------
  it('Chain.sut regression: horizontal 300x27 ribbon tip at BrushRotation=90° flows along horizontal & vertical strokes at full BrushSize width with dual-tone coloring', async () => {
    const chainCat = '.:Install:Paint110:45db3581c6-9246-6887-2a7a-c9454ab8be';
    const pngSig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // 1. Verify exact Chain.sut Variant column parsing
    const chainExtract: NativeSutExtract = {
      nodeName: 'Chain',
      nodeUuid: '2fde90e0-fb6a-4092-9e8c-6f7d23d80e7f',
      variantId: 685,
      variantValues: new Map<string, unknown>([
        ['brushsize', 219.0],
        ['brushsizeunit', 0],
        ['brushribbon', 1],
        ['brushrotation', 90.0],
        ['brushrotationeffector', 3],
        ['brushthickness', 100],
        ['brushverticalthicknes', 0],
        ['brushpatternordertype', 0],
        ['brushusepatternimage', 1],
        ['brushpatternimagearray', new TextEncoder().encode(chainCat)],
        ['brushflow', 100],
        ['opacity', 100],
        ['brushhardness', 100],
        ['antialias', 2],
        ['usedualbrush', 0],
      ]),
      materials: [
        {
          pwId: '1',
          originalPath: '.:Paint110:45db3581c6-9246-6887-2a7a-c9454ab8be:data:material_0.layer',
          catalogPath: chainCat,
          fileData: pngSig,
          decodedPng: pngSig,
          width: 300,
          height: 27,
          expressionColor: 'gray',
          isPaperTexture: false,
          hasSubColor: true,
          decodedFromLayer: false,
        },
      ],
    };

    const parsed = await parseSutExtractedData(chainExtract, 'Chain.sut');
    expect(parsed.isRibbon).toBe(true);
    expect(parsed.angle).toBe(90);
    expect(parsed.angleDynamics).toBe('none');
    expect(parsed.size).toBe(219);
    expect(parsed.thickness).toBe(1);
    expect(parsed.thicknessVertical).toBe(true);
    expect(parsed.isDualToneTip).toBe(true);
    expect(parsed.isColorTip).toBe(false);
    expect(parsed.dualBrush).toBe(false);

    // 2. Build a synthetic 300x27 horizontal dual-tone chain strip:
    //    8 discrete links along X (each with black outline lum=0 and white interior lum=255),
    //    transparent gaps between link holes and above/below the links.
    const tipW = 300;
    const tipH = 27;
    const tipData = new Uint8ClampedArray(tipW * tipH * 4);
    for (let y = 0; y < tipH; y++) {
      for (let x = 0; x < tipW; x++) {
        // Horizontal link centered vertically y in [5..21], repeating every 37.5px with a 5px gap
        const inLinkX = (x % 37) >= 2 && (x % 37) <= 32;
        const inLinkY = y >= 5 && y <= 21;
        if (!inLinkX || !inLinkY) continue;
        const isBorder = (x % 37) <= 4 || (x % 37) >= 30 || y <= 7 || y >= 19;
        const idx = (y * tipW + x) * 4;
        const lum = isBorder ? 0 : 255;
        tipData[idx] = lum;
        tipData[idx + 1] = lum;
        tipData[idx + 2] = lum;
        tipData[idx + 3] = 255;
      }
    }
    const chainSurface = {
      data: tipData,
      width: tipW,
      height: tipH,
      isColor: false,
      isDualToneTip: true,
    };

    // 3. Verify geometry: ribbonWidth == BrushSize (54px) and tilePeriod == 54 * (300/27) == 600px
    const brushSize = 54;
    const horizPts: Point[] = [
      { x: 20, y: 80, pressure: 1, width: brushSize },
      { x: 260, y: 80, pressure: 1, width: brushSize },
    ];
    const ribbonOpts = {
      size: brushSize,
      angle: parsed.angle,
      thickness: parsed.thickness,
      thicknessVertical: parsed.thicknessVertical,
      tipSurfaces: [chainSurface],
      isDualToneTip: true,
      primaryColor: '#ff3000',
      secondaryColor: '#3f2e1f',
      antiAlias: 1,
    };

    const horizMesh = buildRibbonMeshFromPoints(horizPts, ribbonOpts);
    expect(horizMesh.centerline[0].ribbonWidth).toBeCloseTo(brushSize, 1);
    expect(horizMesh.centerline[0].tilePeriod).toBeCloseTo((brushSize * tipW) / tipH, 1);
    // Stroke is 240px long out of 600px tile period -> sNorm reaches ~0.4 (NOT 240/4.86 = 49 sideways strips!)
    const endSNorm = horizMesh.centerline[horizMesh.centerline.length - 1].sNorm;
    expect(endSNorm).toBeGreaterThan(0.35);
    expect(endSNorm).toBeLessThan(0.45);

    // 4. Rasterize horizontal stroke and verify dual-tone colors + link orientation along X
    const horizRaster = rasterizeRibbonMeshCpu(horizMesh, ribbonOpts, 280, 160, 0, 0);
    let outlineRedHits = 0;
    let fillBrownHits = 0;
    let paintedRows = 0;
    for (let y = 0; y < 160; y++) {
      let rowLit = false;
      for (let x = 30; x < 250; x++) {
        const p = (y * 280 + x) * 4;
        if (horizRaster.data[p + 3] < 200) continue;
        rowLit = true;
        const r = horizRaster.data[p];
        const g = horizRaster.data[p + 1];
        const b = horizRaster.data[p + 2];
        if (r > 210 && g < 80 && b < 40) outlineRedHits++;
        if (r > 40 && r < 95 && g > 25 && g < 70 && b > 15 && b < 55) fillBrownHits++;
      }
      if (rowLit) paintedRows++;
    }
    expect(outlineRedHits).toBeGreaterThan(400);
    expect(fillBrownHits).toBeGreaterThan(600);
    // Chain links occupy rows 5..21 of 27 -> ~17/27 * 54px = ~34px tall (NOT 54*27/300 = 4.8px!)
    expect(paintedRows).toBeGreaterThan(26);
    expect(paintedRows).toBeLessThan(44);

    // 5. Verify vertical stroke rotates chain links smoothly to flow along Y
    const vertPts: Point[] = [
      { x: 80, y: 20, pressure: 1, width: brushSize },
      { x: 80, y: 260, pressure: 1, width: brushSize },
    ];
    const vertMesh = buildRibbonMeshFromPoints(vertPts, ribbonOpts);
    expect(vertMesh.centerline[0].ribbonWidth).toBeCloseTo(brushSize, 1);
    expect(vertMesh.centerline[0].tilePeriod).toBeCloseTo((brushSize * tipW) / tipH, 1);
    const vertRaster = rasterizeRibbonMeshCpu(vertMesh, ribbonOpts, 160, 280, 0, 0);
    let paintedCols = 0;
    for (let x = 0; x < 160; x++) {
      let colLit = false;
      for (let y = 30; y < 250; y++) {
        if (vertRaster.data[(y * 160 + x) * 4 + 3] >= 200) {
          colLit = true;
          break;
        }
      }
      if (colLit) paintedCols++;
    }
    expect(paintedCols).toBeGreaterThan(26);
    expect(paintedCols).toBeLessThan(44);
  });
});
