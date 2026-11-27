import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  applyCspPaperTextureAlpha,
  applyCspWatercolorEdge,
  applyStrokePaperTextureToImageData,
  buildBrushRenderOptions,
  centripetalCatmullRomToBezier,
  drawBrushCubicBezierSegment,
  drawBrushDot,
  getTintedMasterCanvas,
  normalizeWetEdgePower01,
  renderCompleteStroke,
  type BrushRenderOptions,
} from '../../engine/BrushEngine';
import {
  paperTextureModeToIndex,
  type GpuDab,
} from '../../engine/WebGlBrushEngine';
import {
  LayerPixelSampler,
  PaintReservoir,
  SpatialTipMixer,
  parseColorToRgb,
} from '../colorMixingEngine';
import { SparseTileGrid } from '../tileEngine';
import { evaluateCpuBlendModeInto } from '../tileEngine/strokeComposite';
import { commitRasterStrokeToTiles } from '../../hooks/drawing/brushStrokeSession/pointerUpRasterCommit';
import { createInitialStrokeSessionState } from '../../hooks/drawing/brushStrokeSession/types';
import {
  BrushSettings,
  CspBrushCombineMode,
  CspPaperTextureMode,
  DEFAULT_BRUSH_DYNAMICS,
  Point,
} from '../../types/editor';

// ============================================================================
// Pixel-exact software Canvas2D rasterizer for headless parity verification
// ============================================================================

function createSoftwareCanvas(initW: number, initH: number) {
  let width = initW;
  let height = initH;
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
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(width, Math.ceil(x + w));
      const y1 = Math.min(height, Math.ceil(y + h));
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
      const fullSw = src.width;
      const fullSh = src.height;

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

          const sa00 = srcBuf[i00 + 3] / 255;
          const sa10 = srcBuf[i10 + 3] / 255;
          const sa01 = srcBuf[i01 + 3] / 255;
          const sa11 = srcBuf[i11 + 3] / 255;
          const aInterp = sa00 * w00 + sa10 * w10 + sa01 * w01 + sa11 * w11;
          const sa = aInterp * st.alpha;
          if (sa <= 0.001) continue;

          const premulR =
            srcBuf[i00] * sa00 * w00 +
            srcBuf[i10] * sa10 * w10 +
            srcBuf[i01] * sa01 * w01 +
            srcBuf[i11] * sa11 * w11;
          const premulG =
            srcBuf[i00 + 1] * sa00 * w00 +
            srcBuf[i10 + 1] * sa10 * w10 +
            srcBuf[i01 + 1] * sa01 * w01 +
            srcBuf[i11 + 1] * sa11 * w11;
          const premulB =
            srcBuf[i00 + 2] * sa00 * w00 +
            srcBuf[i10 + 2] * sa10 * w10 +
            srcBuf[i01 + 2] * sa01 * w01 +
            srcBuf[i11 + 2] * sa11 * w11;
          const invA = aInterp > 1e-5 ? 1 / aInterp : 0;
          const sr = premulR * invA;
          const sg = premulG * invA;
          const sb = premulB * invA;

          const di = (py * width + px) * 4;
          const da = buf[di + 3] / 255;
          if (st.op === 'destination-out') {
            const outA = da * (1 - sa);
            buf[di + 3] = Math.round(outA * 255);
          } else if (st.op === 'destination-over') {
            const outA = da + sa * (1 - da);
            if (outA > 0) {
              const inv = 1 / outA;
              buf[di] = Math.round((buf[di] * da + sr * sa * (1 - da)) * inv);
              buf[di + 1] = Math.round((buf[di + 1] * da + sg * sa * (1 - da)) * inv);
              buf[di + 2] = Math.round((buf[di + 2] * da + sb * sa * (1 - da)) * inv);
              buf[di + 3] = Math.round(outA * 255);
            }
          } else {
            const outA = sa + da * (1 - sa);
            if (outA > 0) {
              const inv = 1 / outA;
              buf[di] = Math.round((sr * sa + buf[di] * da * (1 - sa)) * inv);
              buf[di + 1] = Math.round((sg * sa + buf[di + 1] * da * (1 - sa)) * inv);
              buf[di + 2] = Math.round((sb * sa + buf[di + 2] * da * (1 - sa)) * inv);
              buf[di + 3] = Math.round(outA * 255);
            }
          }
        }
      }
    },
  };

  const surfaceObj: any = {
    get width() {
      return width;
    },
    set width(v: number) {
      width = Math.max(1, v | 0);
      buf = new Uint8ClampedArray(width * height * 4);
    },
    get height() {
      return height;
    },
    set height(v: number) {
      height = Math.max(1, v | 0);
      buf = new Uint8ClampedArray(width * height * 4);
    },
    get naturalWidth() {
      return width;
    },
    get naturalHeight() {
      return height;
    },
    complete: true,
    get buf() {
      return buf;
    },
    getContext: () => ctx,
  };

  return surfaceObj;
}

/**
 * Exact reference mirror of `WebGlBrushEngine.ts` `FRAGMENT_SHADER_SRC` paper texture math
 * for verifying WebGL vs CPU parity within <= 3/255 across all 9 modes.
 */
function simulateWebGlFragmentPaperAlpha(
  tipAlpha: number,
  vAlpha: number,
  gRaw: number,
  paperGrain: number,
  pressure: number,
  mode: CspPaperTextureMode,
  brightness: number,
  contrast: number,
  invert: boolean,
  preserveDensity: boolean,
  emphasizeDensity: boolean
): number {
  let g = gRaw;
  if (invert) g = 1.0 - g;
  if (emphasizeDensity) g = Math.max(0, Math.min(1, (g - 0.5) * 2.2 + 0.35));
  const brightNorm = brightness / 100.0;
  const contrastNorm = contrast / 100.0;
  if (Math.abs(brightNorm) > 0.001) g += brightNorm;
  if (Math.abs(contrastNorm) > 0.001) {
    const cf = Math.pow(Math.max(0.05, 1.0 + contrastNorm), 2.0);
    g = (g - 0.5) * cf + 0.5;
  }
  g = Math.max(0, Math.min(1, g));

  let modTip = Math.max(0, Math.min(1, tipAlpha));
  const p = Math.max(0, Math.min(1, pressure));
  const heavyExcess = Math.max(0, (p - 0.52) / 0.48);
  const penetration = Math.min(0.92, p * 0.28 + heavyExcess * heavyExcess * 0.64);
  const effDensity = preserveDensity ? paperGrain : paperGrain * (1.0 - penetration * 0.85);
  const modeIdx = paperTextureModeToIndex(mode);

  const smoothstep = (e0: number, e1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3.0 - 2.0 * t);
  };

  if (modeIdx === 1) {
    modTip *= 1.0 - effDensity * (1.0 - g);
  } else if (modeIdx === 2) {
    const contactHeight = g * (0.22 + 0.78 * modTip);
    const cutoff = effDensity * 0.68;
    modTip *= smoothstep(cutoff - 0.05, cutoff + 0.16, contactHeight);
  } else if (modeIdx === 3) {
    const dMod = modTip * (1.0 - effDensity * 0.32 * (1.0 - g));
    const ov = dMod < 0.5 ? 2.0 * dMod * g : 1.0 - 2.0 * (1.0 - dMod) * (1.0 - g);
    modTip = Math.max(0, Math.min(1, modTip + (ov - modTip) * effDensity));
  } else if (modeIdx === 4) {
    const edgeFactor = 4.0 * modTip * (1.0 - modTip);
    modTip *= 1.0 - effDensity * (1.0 - g) * (0.35 + 0.65 * edgeFactor);
  } else if (modeIdx === 5) {
    const sil = Math.min(1.0, modTip * 4.0);
    modTip = Math.max(0, Math.min(1, modTip * (1.0 - effDensity) + g * sil * effDensity));
  } else if (modeIdx === 6) {
    const burned = g <= 0.001 ? 0.0 : Math.max(0.0, 1.0 - (1.0 - modTip) / g);
    modTip = Math.max(0, Math.min(1, modTip + (burned - modTip) * effDensity));
  } else if (modeIdx === 7) {
    const burned = Math.max(0.0, modTip + g - 1.0);
    modTip = Math.max(0, Math.min(1, modTip + (burned - modTip) * effDensity));
  } else if (modeIdx === 8) {
    const sil = Math.min(1.0, modTip * 4.0);
    const relief = Math.max(0, Math.min(1, (modTip + g - 0.5) * 1.6)) * sil;
    modTip = Math.max(0, Math.min(1, modTip * (1.0 - effDensity) + relief * effDensity));
  } else {
    const sub = (1.0 - g) * effDensity * (preserveDensity ? 1.0 : 1.0 - penetration * 0.5);
    modTip = Math.max(0.0, modTip - sub);
  }

  if (modTip <= 0.002) return 0;
  return Math.max(0, Math.min(1, modTip * vAlpha));
}

describe('CSP Rendering Math Parity (GPU / CPU / SpatialTipMixer / Tile Commit)', () => {
  const origDocument = (globalThis as any).document;

  beforeEach(() => {
    (globalThis as any).document = {
      createElement: () => createSoftwareCanvas(64, 64),
    };
  });

  afterEach(() => {
    (globalThis as any).document = origDocument;
  });

  // ==========================================================================
  // 1. All 9 CSP TextureCompositeMode modes: WebGL vs CPU vs SpatialTipMixer
  // ==========================================================================

  it('matches WebGL vs CPU paper texture alpha within <= 3/255 across all 9 CSP TextureCompositeMode modes', () => {
    const allModes: CspPaperTextureMode[] = [
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

    // Verify every mode has a unique WebGL uniform index (0..8)
    const indices = new Set(allModes.map((m) => paperTextureModeToIndex(m)));
    expect(indices.size).toBe(9);

    // Deterministic gradient paper texture (32x32)
    const paperImg = createSoftwareCanvas(32, 32);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x) * 4;
        const lum = Math.round(((x * 7 + y * 5) % 32) * (255 / 31));
        paperImg.buf[i] = lum;
        paperImg.buf[i + 1] = lum;
        paperImg.buf[i + 2] = lum;
        paperImg.buf[i + 3] = 255;
      }
    }

    // Solid 16x16 square brush tip at alpha = 0.72 so non-linear modes & normal vs multiply are exercised
    const solidTip = createSoftwareCanvas(16, 16);
    for (let i = 0; i < solidTip.buf.length; i += 4) {
      solidTip.buf[i] = 255;
      solidTip.buf[i + 1] = 255;
      solidTip.buf[i + 2] = 255;
      solidTip.buf[i + 3] = 255;
    }

    for (const mode of allModes) {
      // 1A. Analytical parity across alpha/grain/pressure/brightness/contrast/invert/emphasize sweeps
      for (const tipA of [0.2, 0.55, 0.85, 1.0]) {
        for (const g of [0.1, 0.45, 0.85]) {
          const modTip = applyCspPaperTextureAlpha(tipA, g, 0.75, 0.4, mode, 10, 15, false, true, true);
          const cpuA = modTip <= 0.002 ? 0 : modTip * 0.8;
          const gpuA = simulateWebGlFragmentPaperAlpha(tipA, 0.8, g, 0.75, 0.4, mode, 10, 15, false, true, true);
          expect(Math.abs(cpuA - gpuA) * 255).toBeLessThanOrEqual(1);
        }
      }

      // 1B. Per-dab CPU pixel rasterization (`applyCpuPerPixelPaperGrain`) vs WebGL fragment shader
      const cpuSurf = createSoftwareCanvas(48, 48);
      const cpuCtx = cpuSurf.getContext('2d');
      drawBrushDot(
        cpuCtx,
        { x: 24, y: 24, pressure: 0.45, width: 16 },
        '#cc4422',
        {
          size: 16,
          flow: 0.75,
          hardness: 1.0,
          tipImage: solidTip,
          grain: 0.72,
          textureDensity: 0.72,
          paperTextureMode: mode,
          paperTextureImage: paperImg,
          paperTextureScale: 1.0,
          paperTextureRotate: 0,
          paperTextureBrightness: 5,
          paperTextureContrast: 10,
          paperTextureInverted: false,
          paperTextureEmphasizeDensity: true,
          paperTextureApplyEachPlot: true,
          useGpu: false,
        }
      );

      let maxDiffBytes = 0;
      for (let py = 17; py <= 30; py++) {
        for (let px = 17; px <= 30; px++) {
          const cpuAlphaByte = cpuSurf.buf[(py * 48 + px) * 4 + 3];
          const paperLum = paperImg.buf[((py & 31) * 32 + (px & 31)) * 4] / 255;
          const gpuAlpha = simulateWebGlFragmentPaperAlpha(
            1.0,
            0.75,
            paperLum,
            0.72,
            0.45,
            mode,
            5,
            10,
            false,
            true,
            true
          );
          const gpuAlphaByte = Math.round(gpuAlpha * 255);
          const diff = Math.abs(cpuAlphaByte - gpuAlphaByte);
          if (diff > maxDiffBytes) maxDiffBytes = diff;
        }
      }
      expect(maxDiffBytes).toBeLessThanOrEqual(3);
    }

    // 1B-2. Light-pressure low-flow Subtract paper texture MUST modulate tipAlpha BEFORE v_alpha/dabAlpha
    // so light-pressure textured strokes (e.g. Oil Pastel at p=0.25 -> flow=0.06, grain=0.52, lum=60/255)
    // stay visible instead of collapsing to 0 when (1 - g) * grain > flow!
    const darkPaper = createSoftwareCanvas(16, 16);
    for (let i = 0; i < darkPaper.buf.length; i += 4) {
      darkPaper.buf[i] = 60;
      darkPaper.buf[i + 1] = 60;
      darkPaper.buf[i + 2] = 60;
      darkPaper.buf[i + 3] = 255;
    }
    const lowFlowSurf = createSoftwareCanvas(32, 32);
    drawBrushDot(
      lowFlowSurf.getContext('2d'),
      { x: 16, y: 16, pressure: 0.25, width: 14 },
      '#ff2000',
      {
        size: 14,
        flow: 0.08,
        hardness: 1.0,
        tipImage: solidTip,
        grain: 0.52,
        textureDensity: 0.52,
        paperTextureMode: 'subtract',
        paperTextureImage: darkPaper,
        paperTextureScale: 1.0,
        paperTextureApplyEachPlot: true,
        useGpu: false,
      }
    );
    const lowFlowCpuA = lowFlowSurf.buf[(16 * 32 + 16) * 4 + 3];
    const lowFlowGpuA = Math.round(
      simulateWebGlFragmentPaperAlpha(1.0, 0.08, 60 / 255, 0.52, 0.25, 'subtract', 0, 0, false, true, false) * 255
    );
    expect(lowFlowCpuA).toBeGreaterThanOrEqual(10);
    expect(Math.abs(lowFlowCpuA - lowFlowGpuA)).toBeLessThanOrEqual(2);

    // 1C. Verify `applyCpuPerPixelPaperGrain` responds to rotation, invert, brightness, contrast, emphasizeDensity
    const renderDotWith = (overrides: Partial<BrushRenderOptions>) => {
      const s = createSoftwareCanvas(48, 48);
      drawBrushDot(
        s.getContext('2d'),
        { x: 24, y: 24, pressure: 0.5, width: 20 },
        '#3366aa',
        {
          size: 20,
          flow: 0.85,
          tipImage: solidTip,
          grain: 0.8,
          paperTextureMode: 'multiply',
          paperTextureImage: paperImg,
          paperTextureApplyEachPlot: true,
          useGpu: false,
          ...overrides,
        }
      );
      return Array.from(s.buf);
    };
    const baseBytes = renderDotWith({});
    expect(renderDotWith({ paperTextureRotate: 45 })).not.toEqual(baseBytes);
    expect(renderDotWith({ paperTextureInverted: true })).not.toEqual(baseBytes);
    expect(renderDotWith({ paperTextureBrightness: 35 })).not.toEqual(baseBytes);
    expect(renderDotWith({ paperTextureContrast: 45 })).not.toEqual(baseBytes);
    expect(renderDotWith({ paperTextureEmphasizeDensity: true })).not.toEqual(baseBytes);

    // 1C-2. Verify per-stroke `applyStrokePaperTextureToImageData` matches WebGL within <= 3/255 across all 9 modes
    for (const mode of allModes) {
      const strokeBuf = new Uint8ClampedArray(16 * 16 * 4);
      for (let i = 0; i < 16 * 16; i++) {
        strokeBuf[i * 4] = 180;
        strokeBuf[i * 4 + 1] = 80;
        strokeBuf[i * 4 + 2] = 60;
        strokeBuf[i * 4 + 3] = 204; // 0.8
      }
      applyStrokePaperTextureToImageData(
        { data: strokeBuf, width: 16, height: 16 },
        4,
        6,
        {
          grain: 0.7,
          paperTextureMode: mode,
          paperTextureImage: paperImg,
          paperTextureScale: 1.0,
          paperTextureRotate: 0,
        },
        1.0
      );
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const gotA = strokeBuf[(y * 16 + x) * 4 + 3];
          const pLum = paperImg.buf[(((y + 6) & 31) * 32 + ((x + 4) & 31)) * 4] / 255;
          const expA = Math.round(
            simulateWebGlFragmentPaperAlpha(204 / 255, 1.0, pLum, 0.7, 0.5, mode, 0, 0, false, true, false) * 255
          );
          expect(Math.abs(gotA - expA)).toBeLessThanOrEqual(3);
        }
      }
    }

    // 1D. Verify SpatialTipMixer executes all 9 modes cleanly with distinct modulation
    const paperLum = new Uint8Array(32 * 32);
    for (let i = 0; i < 32 * 32; i++) paperLum[i] = paperImg.buf[i * 4];

    const modeSums = new Map<CspPaperTextureMode, number>();
    for (const mode of allModes) {
      const mixer = new SpatialTipMixer('#3355cc');
      const built = mixer.stepAndBuildStamp({
        x: 24,
        y: 24,
        width: 16,
        height: 16,
        angleRad: 0,
        dirX: 1,
        dirY: 0,
        stepDist: 4,
        hardness: 1.0,
        antiAlias: 2,
        flipX: 1,
        flipY: 1,
        flow: 0.75,
        pressure: 0.5,
        pressureAlreadyApplied: true,
        amountOfPaint: 1.0,
        densityOfPaint: 0.75,
        colorStretch: 0.5,
        mixingMode: 'blend',
        perceptualMixing: true,
        tipImage: solidTip,
        grainDensity: 0.78,
        paperTextureMode: mode,
        paperLumData: paperLum,
        paperLumWidth: 32,
        paperLumHeight: 32,
        paperTextureScale: 1.0,
        paperTextureRotate: 0,
        paperTexturePreserveDensity: true,
      });
      expect(built).not.toBeNull();
      expect(built!.hasVisiblePixels).toBe(true);
      const data = (built!.canvas as any).buf as Uint8ClampedArray;
      let alphaSum = 0;
      for (let i = 3; i < data.length; i += 4) alphaSum += data[i];
      expect(alphaSum).toBeGreaterThan(0);
      modeSums.set(mode, alphaSum);
    }
    // Compare/color-burn/linear-burn/overlay/subtract/multiply should not collapse to identical values
    expect(modeSums.get('compare')).not.toBe(modeSums.get('multiply'));
    expect(modeSums.get('color-burn')).not.toBe(modeSums.get('multiply'));
    expect(modeSums.get('outline')).not.toBe(modeSums.get('subtract'));
  });

  // ==========================================================================
  // 2. Watercolor Edge scale fix & enabled with colorMixing
  // ==========================================================================

  it('normalizes Watercolor Edge 0..100 vs 0..1 cleanly, prevents black-fringe halos, and applies with colorMixing', () => {
    expect(normalizeWetEdgePower01(0.25)).toBeCloseTo(0.25, 5);
    expect(normalizeWetEdgePower01(25)).toBeCloseTo(0.25, 5);
    expect(normalizeWetEdgePower01(15)).toBeCloseTo(0.15, 5);
    expect(normalizeWetEdgePower01(100)).toBeCloseTo(1.0, 5);
    expect(normalizeWetEdgePower01(0)).toBe(0);

    // Direct applyCspWatercolorEdge: (25, 15) must equal (0.25, 0.15) and never blow out to black
    const makeWash = () => {
      const w = 28,
        h = 28;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 6; y < 22; y++) {
        for (let x = 6; x < 22; x++) {
          const i = (y * w + x) * 4;
          data[i] = 220;
          data[i + 1] = 110;
          data[i + 2] = 80;
          data[i + 3] = 150;
        }
      }
      return { data, width: w, height: h };
    };
    const img01 = makeWash();
    const img100 = makeWash();
    applyCspWatercolorEdge(img01, 0.75, 3, 0.25, 0.15);
    applyCspWatercolorEdge(img100, 0.75, 3, 25, 15);
    expect(Array.from(img100.data)).toEqual(Array.from(img01.data));

    // Rim darkens smoothly (not blown out to near-zero black) and concentrates alpha
    const rimOff = (6 * 28 + 14) * 4;
    const centerOff = (14 * 28 + 14) * 4;
    const transparentOff = (1 * 28 + 1) * 4;
    expect(img01.data[rimOff]).toBeLessThan(220);
    expect(img01.data[rimOff]).toBeGreaterThan(100);
    expect(img01.data[rimOff + 3]).toBeGreaterThan(150);
    expect(img01.data[centerOff]).toBe(220);
    expect(img01.data[centerOff + 3]).toBe(150);
    // Transparent pixels outside stroke have zero black-fringe halo
    expect(img01.data[transparentOff]).toBe(0);
    expect(img01.data[transparentOff + 1]).toBe(0);
    expect(img01.data[transparentOff + 2]).toBe(0);
    expect(img01.data[transparentOff + 3]).toBe(0);

    // renderCompleteStroke MUST apply watercolor edge even when colorMixing === true
    const pts: Point[] = [
      { x: 24, y: 32, pressure: 0.65, width: 22 },
      { x: 56, y: 32, pressure: 0.65, width: 22 },
      { x: 88, y: 32, pressure: 0.65, width: 22 },
    ];
    const baseMixBs: BrushSettings = {
      size: 22,
      minSizeFactor: 0.2,
      color: '#d87050',
      opacity: 1.0,
      flow: 0.65,
      spacing: 0.1,
      usePressure: true,
      smoothing: false,
      stabilization: 0,
      hardness: 0.85,
      colorMixing: true,
      amountOfPaint: 0.85,
      densityOfPaint: 0.55,
      colorStretch: 0.4,
      useGpu: false,
    };

    const surfNoWet = createSoftwareCanvas(120, 64);
    renderCompleteStroke(surfNoWet.getContext('2d'), pts, { ...baseMixBs, wetEdge: 0 }, 'brush', 'color');

    const surfWithWet = createSoftwareCanvas(120, 64);
    renderCompleteStroke(
      surfWithWet.getContext('2d'),
      pts,
      { ...baseMixBs, wetEdge: 0.85, wetEdgeRadius: 3, wetEdgeAlphaPower: 35, wetEdgeValuePower: 30 },
      'brush',
      'color'
    );

    // Find rim pixels where watercolor edge darkened and concentrated alpha relative to no-wetEdge
    let darkenedRimPixels = 0;
    let boostedAlphaRimPixels = 0;
    for (let i = 0; i < surfNoWet.buf.length; i += 4) {
      if (surfNoWet.buf[i + 3] > 30) {
        if (surfWithWet.buf[i] < surfNoWet.buf[i] - 5) darkenedRimPixels++;
        if (surfWithWet.buf[i + 3] > surfNoWet.buf[i + 3] + 5) boostedAlphaRimPixels++;
      }
    }
    expect(darkenedRimPixels).toBeGreaterThan(20);
    expect(boostedAlphaRimPixels).toBeGreaterThan(20);

    // pointerUpRasterCommit with colorMixing === true + wetEdge + legacy 0..100 powers
    const gridNoWet = new SparseTileGrid();
    const gridWithWet = new SparseTileGrid();
    const runCommit = (grid: SparseTileGrid, wetEdge: number) => {
      const state = createInitialStrokeSessionState();
      commitRasterStrokeToTiles({
        state,
        helpers: {
          markTouchedTiles: () => {},
          resolveLiveAntiAlias: () => 2,
          buildLiveBrushOptions: () => ({}),
          emitLiveSegment: () => {},
          buildTouchedTileSpans: (x, y, w, h) => [{ x, y, width: w, height: h }],
          resolveEffectiveOpacitySensor: () => undefined,
        },
        grid,
        draftCanvas: null,
        dirtyRect: { x: 0, y: 0, width: 120, height: 64 },
        dims: { width: 120, height: 64 },
        bs: {
          ...baseMixBs,
          wetEdge,
          wetEdgeRadius: 3,
          wetEdgeAlphaPower: 35,
          wetEdgeValuePower: 30,
        },
        currentTool: 'brush',
        currentLayerId: 'layer-wc',
        activeLayer: undefined,
        activeSelection: null,
        effectiveMode: 'color',
        targetFormat: 'color-32bit',
        isEraser: false,
        isBgEraser: false,
        isMonochrome: false,
        hasWetEdge: wetEdge > 0.01,
        shouldTaper: false,
        strokeColor: '#d87050',
        allPoints: pts,
        tailSegments: [],
        toolForHistory: 'brush',
        label: 'Watercolor',
        strokeIdForHistory: undefined,
        enqueueHistoryTask: () => {},
        pushHistoryStep: () => {},
      });
    };

    runCommit(gridNoWet, 0);
    runCommit(gridWithWet, 0.85);
    const readNoWet = gridNoWet.readImageData('layer-wc', 0, 0, 120, 64).data;
    const readWithWet = gridWithWet.readImageData('layer-wc', 0, 0, 120, 64).data;
    let commitDarkened = 0;
    for (let i = 0; i < readNoWet.length; i += 4) {
      if (readNoWet[i + 3] > 30 && readWithWet[i] < readNoWet[i] - 5) {
        commitDarkened++;
      }
    }
    expect(commitDarkened).toBeGreaterThan(20);
  });

  // ==========================================================================
  // 3A. Compare density (blendTipsMode === 'compare') non-accumulation
  // ==========================================================================

  it('prevents translucent alpha accumulation over 10 overlapping dabs when blendTipsMode === "compare"', () => {
    const compareSurf = createSoftwareCanvas(64, 64);
    const compareCtx = compareSurf.getContext('2d');
    const normalSurf = createSoftwareCanvas(64, 64);
    const normalCtx = normalSurf.getContext('2d');

    const dotPt: Point = { x: 32, y: 32, pressure: 1.0, width: 24 };
    const sharedOpts: BrushRenderOptions = {
      size: 24,
      flow: 0.4,
      hardness: 1.0,
      useGpu: false,
    };

    // Stamp 10 completely overlapping 40%-alpha dabs at (32, 32)
    for (let i = 0; i < 10; i++) {
      drawBrushDot(compareCtx, dotPt, '#2060e0', { ...sharedOpts, blendTipsMode: 'compare' });
      drawBrushDot(normalCtx, dotPt, '#2060e0', { ...sharedOpts, blendTipsMode: 'normal' });
    }

    const centerIdx = (32 * 64 + 32) * 4;
    const compareAlpha = compareSurf.buf[centerIdx + 3];
    const normalAlpha = normalSurf.buf[centerIdx + 3];

    // Normal builds up: 1 - (1 - 0.4)^10 = 0.994 (~253/255)
    expect(normalAlpha).toBeGreaterThanOrEqual(248);
    // Compare density MUST NOT accumulate above single-dab 0.4 (~102/255)
    expect(compareAlpha).toBeGreaterThanOrEqual(98);
    expect(compareAlpha).toBeLessThanOrEqual(106);

    // Also verify renderCompleteStroke with blendTipsMode === 'compare' over an existing background
    const strokeSurf = createSoftwareCanvas(96, 64);
    const sCtx = strokeSurf.getContext('2d');
    // Fill opaque green background first
    sCtx.fillStyle = '#00cc00';
    sCtx.fillRect(0, 0, 96, 64);

    renderCompleteStroke(
      sCtx,
      [
        { x: 20, y: 32, pressure: 1.0, width: 20 },
        { x: 40, y: 32, pressure: 1.0, width: 20 },
        { x: 60, y: 32, pressure: 1.0, width: 20 },
        { x: 40, y: 32, pressure: 1.0, width: 20 }, // fold back over itself!
      ],
      {
        size: 20,
        minSizeFactor: 1.0,
        color: '#ff0000',
        opacity: 1.0,
        flow: 0.4,
        spacing: 0.08,
        usePressure: false,
        smoothing: false,
        stabilization: 0,
        hardness: 1.0,
        blendTipsMode: 'compare',
        useGpu: false,
      },
      'brush',
      'color'
    );

    // At (40, 32): 40% red over 100% green -> R ~ 0.4 * 255 = 102, G ~ 0.6 * 204 = 122 (NOT 255 red!)
    const midIdx = (32 * 96 + 40) * 4;
    expect(strokeSurf.buf[midIdx]).toBeGreaterThanOrEqual(90);
    expect(strokeSurf.buf[midIdx]).toBeLessThanOrEqual(115);
    expect(strokeSurf.buf[midIdx + 1]).toBeGreaterThanOrEqual(110);
  });

  // ==========================================================================
  // 3B. BrushCombineMode (multiply, behind, add-glow, clear + all 26+ modes)
  // ==========================================================================

  it('blends strokes onto existing tiles with exact CSP BrushCombineMode semantics (multiply, behind, add-glow, clear, etc.)', () => {
    const layerId = 'combine-layer';

    const makeSolid = (w: number, h: number, r: number, g: number, b: number, a: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        data[i * 4] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = a;
      }
      return { data, width: w, height: h };
    };

    // 1. Multiply: (128, 255, 200) * (200, 100, 50) / 255 = (100, 100, 39)
    const gridMul = new SparseTileGrid();
    gridMul.writeImageData(layerId, makeSolid(16, 16, 128, 255, 200, 255), 0, 0, 'color-32bit');
    gridMul.compositeStrokeToTiles({
      layerId,
      strokeData: makeSolid(16, 16, 200, 100, 50, 255),
      destX: 0,
      destY: 0,
      format: 'color-32bit',
      compositeOp: 'source-over',
      brushCombineMode: 'multiply',
      opacity: 1.0,
    });
    const mulPx = gridMul.readImageData(layerId, 8, 8, 1, 1).data;
    expect(Math.abs(mulPx[0] - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(mulPx[1] - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(mulPx[2] - 39)).toBeLessThanOrEqual(1);
    expect(mulPx[3]).toBe(255);

    // 2. Behind (destination-over): opaque front stays untouched, transparent fills behind
    const gridBehind = new SparseTileGrid();
    // Left half opaque blue (0..7), right half transparent (8..15)
    gridBehind.writeImageData(layerId, makeSolid(8, 16, 20, 40, 220, 255), 0, 0, 'color-32bit');
    gridBehind.compositeStrokeToTiles({
      layerId,
      strokeData: makeSolid(16, 16, 240, 30, 30, 255),
      destX: 0,
      destY: 0,
      format: 'color-32bit',
      compositeOp: 'source-over',
      brushCombineMode: 'behind',
      opacity: 1.0,
    });
    const behindFrontPx = gridBehind.readImageData(layerId, 4, 8, 1, 1).data;
    const behindEmptyPx = gridBehind.readImageData(layerId, 12, 8, 1, 1).data;
    expect(behindFrontPx[0]).toBe(20);
    expect(behindFrontPx[2]).toBe(220);
    expect(behindEmptyPx[0]).toBe(240);
    expect(behindEmptyPx[2]).toBe(30);
    expect(behindEmptyPx[3]).toBe(255);

    // 3. Add (Glow): (120, 180, 90) + (100, 120, 200) -> (220, 255, 255)
    const gridGlow = new SparseTileGrid();
    gridGlow.writeImageData(layerId, makeSolid(16, 16, 120, 180, 90, 255), 0, 0, 'color-32bit');
    gridGlow.compositeStrokeToTiles({
      layerId,
      strokeData: makeSolid(16, 16, 100, 120, 200, 255),
      destX: 0,
      destY: 0,
      format: 'color-32bit',
      compositeOp: 'source-over',
      brushCombineMode: 'add-glow',
      opacity: 1.0,
    });
    const glowPx = gridGlow.readImageData(layerId, 8, 8, 1, 1).data;
    expect(glowPx[0]).toBe(220);
    expect(glowPx[1]).toBe(255);
    expect(glowPx[2]).toBe(255);

    // 4. Clear (destination-out): erases existing opaque pixels
    const gridClear = new SparseTileGrid();
    gridClear.writeImageData(layerId, makeSolid(16, 16, 200, 100, 50, 255), 0, 0, 'color-32bit');
    gridClear.compositeStrokeToTiles({
      layerId,
      strokeData: makeSolid(16, 16, 255, 0, 0, 255),
      destX: 0,
      destY: 0,
      format: 'color-32bit',
      compositeOp: 'source-over',
      brushCombineMode: 'clear',
      opacity: 1.0,
    });
    const clearPx = gridClear.readImageData(layerId, 8, 8, 1, 1).data;
    expect(clearPx[3]).toBe(0);

    // 5. All 26+ CSP blend modes produce valid finite [0..1] RGB
    const allCombineModes: CspBrushCombineMode[] = [
      'normal',
      'multiply',
      'screen',
      'overlay',
      'darken',
      'lighten',
      'color-dodge',
      'color-burn',
      'hard-light',
      'soft-light',
      'difference',
      'exclusion',
      'linear-burn',
      'add',
      'add-glow',
      'color-dodge-glow',
      'divide',
      'vivid-light',
      'linear-light',
      'pin-light',
      'hard-mix',
      'subtract',
      'darker-color',
      'lighter-color',
      'hue',
      'saturation',
      'color',
      'luminosity',
    ];
    const out: [number, number, number] = [0, 0, 0];
    for (const mode of allCombineModes) {
      evaluateCpuBlendModeInto(0.6, 0.35, 0.8, 0.4, 0.7, 0.25, mode, out);
      expect(Number.isFinite(out[0]) && out[0] >= 0 && out[0] <= 1).toBe(true);
      expect(Number.isFinite(out[1]) && out[1] >= 0 && out[1] <= 1).toBe(true);
      expect(Number.isFinite(out[2]) && out[2] >= 0 && out[2] <= 1).toBe(true);
    }

    // 6. Wire brushCombineMode through commitRasterStrokeToTiles
    const commitGrid = new SparseTileGrid();
    commitGrid.writeImageData(layerId, makeSolid(64, 64, 160, 200, 120, 255), 0, 0, 'color-32bit');
    commitRasterStrokeToTiles({
      state: createInitialStrokeSessionState(),
      helpers: {
        markTouchedTiles: () => {},
        resolveLiveAntiAlias: () => 2,
        buildLiveBrushOptions: () => ({}),
        emitLiveSegment: () => {},
        buildTouchedTileSpans: (x, y, w, h) => [{ x, y, width: w, height: h }],
        resolveEffectiveOpacitySensor: () => undefined,
      },
      grid: commitGrid,
      draftCanvas: null,
      dirtyRect: { x: 0, y: 0, width: 64, height: 64 },
      dims: { width: 64, height: 64 },
      bs: {
        size: 24,
        minSizeFactor: 1.0,
        color: '#808080',
        opacity: 1.0,
        flow: 1.0,
        spacing: 0.1,
        usePressure: false,
        smoothing: false,
        stabilization: 0,
        hardness: 1.0,
        brushCombineMode: 'multiply',
        useGpu: false,
      },
      currentTool: 'brush',
      currentLayerId: layerId,
      activeLayer: undefined,
      activeSelection: null,
      effectiveMode: 'color',
      targetFormat: 'color-32bit',
      isEraser: false,
      isBgEraser: false,
      isMonochrome: false,
      hasWetEdge: false,
      shouldTaper: false,
      strokeColor: '#808080',
      allPoints: [{ x: 32, y: 32, pressure: 1.0, width: 24 }],
      tailSegments: [],
      toolForHistory: 'brush',
      label: 'Multiply Brush',
      strokeIdForHistory: undefined,
      enqueueHistoryTask: () => {},
      pushHistoryStep: () => {},
    });
    const committedMulPx = commitGrid.readImageData(layerId, 32, 32, 1, 1).data;
    // Multiply by #808080 (~0.502): (160, 200, 120) -> ~(80, 100, 60)
    expect(Math.abs(committedMulPx[0] - 80)).toBeLessThanOrEqual(2);
    expect(Math.abs(committedMulPx[1] - 100)).toBeLessThanOrEqual(2);
    expect(Math.abs(committedMulPx[2] - 60)).toBeLessThanOrEqual(2);
  });

  // ==========================================================================
  // 4. Dual-tone tips (Main + Sub Color) across CPU, WebGL math, SpatialTipMixer
  // ==========================================================================

  it('renders dual-tone grayscale tips (isDualToneTip) identically across CPU, WebGL math, and SpatialTipMixer within <= 3/255', () => {
    // 4x1 tip: black (lum 0), dark gray (lum ~0.25), light gray (lum ~0.75), white (lum 1) with distinct alphas
    const tip = createSoftwareCanvas(4, 1);
    const samples = [
      [0, 0, 0, 255],
      [64, 64, 64, 210],
      [192, 192, 192, 175],
      [255, 255, 255, 140],
    ];
    for (let x = 0; x < 4; x++) {
      tip.buf[x * 4] = samples[x][0];
      tip.buf[x * 4 + 1] = samples[x][1];
      tip.buf[x * 4 + 2] = samples[x][2];
      tip.buf[x * 4 + 3] = samples[x][3];
    }

    const primary = '#e02040'; // (224, 32, 64)
    const secondaryA = '#20a0f0'; // (32, 160, 240)
    const secondaryB = '#40e040'; // (64, 224, 64)

    const masterA = getTintedMasterCanvas(tip, 'dualtone_test_tip', primary, 4, 1, false, true, secondaryA);
    const masterB = getTintedMasterCanvas(tip, 'dualtone_test_tip', primary, 4, 1, false, true, secondaryB);

    // Cache key MUST include secondaryColor (different sub-colors return distinct canvases)
    expect(masterA).not.toBe(masterB);

    const bufA = (masterA as any).buf as Uint8ClampedArray;
    const pRgb = parseColorToRgb(primary);
    const sRgb = parseColorToRgb(secondaryA);

    for (let x = 0; x < 4; x++) {
      const lum = (0.299 * samples[x][0] + 0.587 * samples[x][1] + 0.114 * samples[x][2]) / 255;
      // WebGL fragment shader exact formula: mix(v_color.rgb, u_secondaryColor, lum)
      const glR = Math.round((pRgb.r / 255 + ((sRgb.r - pRgb.r) / 255) * lum) * 255);
      const glG = Math.round((pRgb.g / 255 + ((sRgb.g - pRgb.g) / 255) * lum) * 255);
      const glB = Math.round((pRgb.b / 255 + ((sRgb.b - pRgb.b) / 255) * lum) * 255);

      expect(Math.abs(bufA[x * 4] - glR)).toBeLessThanOrEqual(1);
      expect(Math.abs(bufA[x * 4 + 1] - glG)).toBeLessThanOrEqual(1);
      expect(Math.abs(bufA[x * 4 + 2] - glB)).toBeLessThanOrEqual(1);
      // Preserves exact tip alpha
      expect(bufA[x * 4 + 3]).toBe(samples[x][3]);
    }

    // SpatialTipMixer dual-tone mapping: left half black (primary), right half white (secondary)
    const dualTipSquare = createSoftwareCanvas(16, 16);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = (y * 16 + x) * 4;
        const v = x < 8 ? 0 : 255;
        dualTipSquare.buf[i] = v;
        dualTipSquare.buf[i + 1] = v;
        dualTipSquare.buf[i + 2] = v;
        dualTipSquare.buf[i + 3] = 255;
      }
    }
    const mixer = new SpatialTipMixer(primary);
    const built = mixer.stepAndBuildStamp({
      x: 16,
      y: 16,
      width: 16,
      height: 16,
      angleRad: 0,
      dirX: 1,
      dirY: 0,
      stepDist: 0,
      hardness: 1.0,
      antiAlias: 2,
      flipX: 1,
      flipY: 1,
      flow: 1.0,
      pressure: 1.0,
      pressureAlreadyApplied: true,
      amountOfPaint: 1.0,
      densityOfPaint: 1.0,
      colorStretch: 0.5,
      mixingMode: 'blend',
      perceptualMixing: false,
      tipImage: dualTipSquare,
      isDualToneTip: true,
      secondaryColor: secondaryA,
    });
    expect(built).not.toBeNull();
    const mBuf = (built!.canvas as any).buf as Uint8ClampedArray;
    const w = built!.srcW;
    // Inner left pixel (x=3, y=9) -> primaryColor; inner right pixel (x=14, y=9) -> secondaryA
    const leftOff = (9 * w + 3) * 4;
    const rightOff = (9 * w + 14) * 4;
    expect(Math.abs(mBuf[leftOff] - pRgb.r)).toBeLessThanOrEqual(3);
    expect(Math.abs(mBuf[leftOff + 1] - pRgb.g)).toBeLessThanOrEqual(3);
    expect(Math.abs(mBuf[leftOff + 2] - pRgb.b)).toBeLessThanOrEqual(3);
    expect(Math.abs(mBuf[rightOff] - sRgb.r)).toBeLessThanOrEqual(3);
    expect(Math.abs(mBuf[rightOff + 1] - sRgb.g)).toBeLessThanOrEqual(3);
    expect(Math.abs(mBuf[rightOff + 2] - sRgb.b)).toBeLessThanOrEqual(3);
  });

  // ==========================================================================
  // 5. Dynamic effectors (thicknessSensor, amountOfPaintSensor, initial-direction, colorJitter)
  // ==========================================================================

  it('wires thicknessSensor, amountOfPaintSensor, angleDynamics="initial-direction", and colorJitter with SpatialTipMixer', () => {
    // 5A. thicknessSensor modulates dab height on GPU batch
    const gpuDabs: GpuDab[] = [];
    const dummyCtx = createSoftwareCanvas(128, 128).getContext('2d');
    const pLow: Point = { x: 10, y: 20, pressure: 0.1, width: 20 };
    const pHigh: Point = { x: 90, y: 20, pressure: 1.0, width: 20 };
    const { c1, c2 } = centripetalCatmullRomToBezier(pLow, pLow, pHigh, pHigh);
    drawBrushCubicBezierSegment(
      dummyCtx,
      pLow,
      c1,
      c2,
      pHigh,
      '#000000',
      {
        size: 20,
        spacing: 0.25,
        thickness: 1.0,
        thicknessSensor: { usePressure: true, pressureMin: 0.2 },
      },
      0,
      { count: 0 },
      gpuDabs
    );
    expect(gpuDabs.length).toBeGreaterThan(5);
    // Low-pressure start dab should be much flatter (smaller height) than high-pressure end dab
    expect(gpuDabs[0].height).toBeLessThan(gpuDabs[gpuDabs.length - 1].height * 0.5);

    // 5B. amountOfPaintSensor: light pressure blends underlying canvas paint; heavy pressure covers with fresh foreground!
    const bgCanvas = createSoftwareCanvas(120, 64);
    const bgCtx = bgCanvas.getContext('2d');
    bgCtx.fillStyle = '#0020ff'; // Pure blue underlying layer
    bgCtx.fillRect(0, 0, 120, 64);
    const sampler = new LayerPixelSampler(bgCanvas);

    const runMixingStroke = (pressure: number) => {
      const outSurf = createSoftwareCanvas(120, 64);
      const pts: Point[] = [
        { x: 20, y: 32, pressure, width: 16 },
        { x: 50, y: 32, pressure, width: 16 },
        { x: 80, y: 32, pressure, width: 16 },
      ];
      const opts = buildBrushRenderOptions(
        {
          size: 16,
          minSizeFactor: 1.0,
          color: '#ff2000', // Fresh red foreground
          opacity: 1.0,
          flow: 1.0,
          spacing: 0.12,
          usePressure: false,
          smoothing: false,
          stabilization: 0,
          hardness: 1.0,
          colorMixing: true,
          perceptualMixing: false,
          amountOfPaint: 0.9,
          densityOfPaint: 0.9,
          colorStretch: 0.5,
          amountOfPaintSensor: { usePressure: true, pressureMin: 0.02 },
          useGpu: false,
        },
        {
          sampler: new LayerPixelSampler(bgCanvas),
          reservoir: new PaintReservoir('#ff2000'),
        }
      );
      drawBrushDot(outSurf.getContext('2d'), pts[0], '#ff2000', opts);
      const seg = centripetalCatmullRomToBezier(pts[0], pts[0], pts[1], pts[2]);
      drawBrushCubicBezierSegment(outSurf.getContext('2d'), pts[0], seg.c1, seg.c2, pts[1], '#ff2000', opts, 0, { count: 0 });
      return outSurf.buf[(32 * 120 + 48) * 4]; // Red channel
    };

    const lightPressureRed = runMixingStroke(0.05); // Blends blue canvas -> low Red!
    const heavyPressureRed = runMixingStroke(1.0); // Covers with fresh red -> high Red!
    expect(heavyPressureRed).toBeGreaterThan(lightPressureRed + 80);

    // 5C. angleDynamics === 'initial-direction': locks angle to initial 4-8px chord even through a 90° bend
    const lockedDabs: GpuDab[] = [];
    const bendPts: Point[] = [
      { x: 10, y: 10, pressure: 1, width: 12 },
      { x: 30, y: 10, pressure: 1, width: 12 }, // moving right (angle 0)
      { x: 30, y: 60, pressure: 1, width: 12 }, // turning 90° down (angle +PI/2)
    ];
    const segA = centripetalCatmullRomToBezier(bendPts[0], bendPts[0], bendPts[1], bendPts[2]);
    const segB = centripetalCatmullRomToBezier(bendPts[0], bendPts[1], bendPts[2], bendPts[2]);
    const lockCounter: any = { count: 0 };
    const lockOpts: BrushRenderOptions = {
      size: 12,
      spacing: 0.25,
      thickness: 0.35,
      angleDynamics: 'initial-direction',
    };
    const rem = drawBrushCubicBezierSegment(dummyCtx, bendPts[0], segA.c1, segA.c2, bendPts[1], '#000', lockOpts, 0, lockCounter, lockedDabs);
    drawBrushCubicBezierSegment(dummyCtx, bendPts[1], segB.c1, segB.c2, bendPts[2], '#000', lockOpts, rem, lockCounter, lockedDabs);
    expect(lockedDabs.length).toBeGreaterThan(8);
    expect(lockCounter.lockedInitialAngle).toBeDefined();
    // Final vertical segment dabs MUST stay locked near 0 rad (horizontal), NOT turn to PI/2 (~1.57 rad)!
    const lastAngle = lockedDabs[lockedDabs.length - 1].angle;
    expect(Math.abs(lastAngle)).toBeLessThan(0.25);

    // 5D. colorJitter (perDab AND colorJitterPerStroke) works seamlessly WITH SpatialTipMixer
    const perDabReservoir = new PaintReservoir('#cc3333');
    const perDabSurf = createSoftwareCanvas(120, 48);
    const perDabOpts: BrushRenderOptions = {
      size: 14,
      flow: 1.0,
      spacing: 0.4,
      hardness: 1.0,
      colorMixing: true,
      amountOfPaint: 1.0,
      densityOfPaint: 1.0,
      colorStretch: 0.2,
      secondaryColor: '#20c0f0',
      dynamics: {
        ...DEFAULT_BRUSH_DYNAMICS,
        colorJitterEnabled: true,
        colorJitterPerStroke: false,
        hueJitter: 0.8,
        foregroundBackgroundJitter: 0.5,
      },
      reservoir: perDabReservoir,
      sampler,
      useGpu: false,
    };
    const jP0: Point = { x: 15, y: 24, pressure: 1, width: 14 };
    const jP1: Point = { x: 105, y: 24, pressure: 1, width: 14 };
    const jSeg = centripetalCatmullRomToBezier(jP0, jP0, jP1, jP1);
    drawBrushCubicBezierSegment(perDabSurf.getContext('2d'), jP0, jSeg.c1, jSeg.c2, jP1, '#cc3333', perDabOpts, 0, { count: 0 });
    // MUST stay inside SpatialTipMixer (never fall back out of SpatialTipMixer!)
    expect(perDabReservoir.spatialMixer).toBeDefined();
    // Different x positions along the stroke should exhibit distinct jittered colors
    const sample1 = [perDabSurf.buf[(24 * 120 + 20) * 4], perDabSurf.buf[(24 * 120 + 20) * 4 + 1], perDabSurf.buf[(24 * 120 + 20) * 4 + 2]];
    const sample2 = [perDabSurf.buf[(24 * 120 + 85) * 4], perDabSurf.buf[(24 * 120 + 85) * 4 + 1], perDabSurf.buf[(24 * 120 + 85) * 4 + 2]];
    expect(sample1).not.toEqual(sample2);

    // colorJitterPerStroke: constant jittered color across entire stroke, still using SpatialTipMixer
    const perStrokeReservoir = new PaintReservoir('#cc3333');
    const perStrokeSurf = createSoftwareCanvas(120, 48);
    const perStrokeOpts: BrushRenderOptions = {
      ...perDabOpts,
      dynamics: {
        ...DEFAULT_BRUSH_DYNAMICS,
        colorJitterEnabled: true,
        colorJitterPerStroke: true,
        hueJitter: 0.8,
        foregroundBackgroundJitter: 0.5,
      },
      reservoir: perStrokeReservoir,
    };
    drawBrushCubicBezierSegment(perStrokeSurf.getContext('2d'), jP0, jSeg.c1, jSeg.c2, jP1, '#cc3333', perStrokeOpts, 0, { count: 0 });
    expect(perStrokeReservoir.spatialMixer).toBeDefined();
    const ps1 = [perStrokeSurf.buf[(24 * 120 + 20) * 4], perStrokeSurf.buf[(24 * 120 + 20) * 4 + 1], perStrokeSurf.buf[(24 * 120 + 20) * 4 + 2]];
    const ps2 = [perStrokeSurf.buf[(24 * 120 + 85) * 4], perStrokeSurf.buf[(24 * 120 + 85) * 4 + 1], perStrokeSurf.buf[(24 * 120 + 85) * 4 + 2]];
    expect(ps1).toEqual(ps2);
  });
});
