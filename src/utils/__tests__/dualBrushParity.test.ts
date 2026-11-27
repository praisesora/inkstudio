import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderCompleteStroke,
  resolveDualBrushConfig,
  buildSecondaryBrushSettings,
  combineDualBrushAlpha,
  combineDualBrushImageData,
  dualBrushCompositeModeToIndex,
  computeSecondaryBrushSize,
  scalePointsForSecondaryBrush,
} from '../../engine/BrushEngine';
import { DUAL_BRUSH_COMPOSITE_MODES } from '../../engine/DualBrushEngine';
import { WebGlBrushEngine, GpuDab } from '../../engine/WebGlBrushEngine';
import { LayerPixelSampler } from '../colorMixingEngine';
import { parseSutExtractedData } from '../sutParser';
import {
  createInitialStrokeSessionState,
} from '../../hooks/drawing/brushStrokeSession/types';
import {
  prepareDualDraftCanvases,
  syncDualBrushRegionToDraft,
} from '../../hooks/drawing/brushStrokeSession/strokeHelpers';
import { DraftCanvasElement } from '../../hooks/drawing/types';
import { BrushSettings, DualBrushCompositeMode, Point } from '../../types/editor';

/**
 * Software-compositing mock Canvas2D with accurate scaling, translation, source-in tinting,
 * and source-over / destination-out compositing for headless Vitest raster parity tests.
 */
function createRasterMockCanvas(width: number = 256, height: number = 128) {
  let curW = width;
  let curH = height;
  let buf = new Uint8ClampedArray(curW * curH * 4);

  const resize = (nw: number, nh: number) => {
    curW = Math.max(1, Math.round(nw));
    curH = Math.max(1, Math.round(nh));
    buf = new Uint8ClampedArray(curW * curH * 4);
    mockObj.pixelBuffer = buf;
  };

  let tx = 0;
  let ty = 0;
  let sxScale = 1;
  let syScale = 1;
  let rotRad = 0;
  const stack: Array<{
    tx: number;
    ty: number;
    sx: number;
    sy: number;
    rot: number;
    alpha: number;
    op: string;
    fill: string;
  }> = [];

  const parseHex = (color: string): [number, number, number] => {
    if (color.startsWith('#')) {
      let hex = color.slice(1);
      if (hex.length === 3) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      }
      const n = parseInt(hex, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return [0, 0, 0];
  };

  const ctx: any = {
    canvas: null as any,
    globalAlpha: 1.0,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000000',
    imageSmoothingEnabled: true,
    save() {
      stack.push({
        tx,
        ty,
        sx: sxScale,
        sy: syScale,
        rot: rotRad,
        alpha: ctx.globalAlpha,
        op: ctx.globalCompositeOperation,
        fill: ctx.fillStyle,
      });
    },
    restore() {
      const s = stack.pop();
      if (s) {
        tx = s.tx;
        ty = s.ty;
        sxScale = s.sx;
        syScale = s.sy;
        rotRad = s.rot;
        ctx.globalAlpha = s.alpha;
        ctx.globalCompositeOperation = s.op;
        ctx.fillStyle = s.fill;
      }
    },
    translate(dx: number, dy: number) {
      tx += dx * sxScale;
      ty += dy * syScale;
    },
    scale(x: number, y: number) {
      sxScale *= x;
      syScale *= y;
    },
    rotate(rad: number) {
      rotRad += rad;
    },
    setTransform(a: number, _b: number, _c: number, d: number, e: number, f: number) {
      sxScale = a;
      syScale = d;
      tx = e;
      ty = f;
      rotRad = 0;
    },
    resetTransform() {
      tx = 0;
      ty = 0;
      sxScale = 1;
      syScale = 1;
      rotRad = 0;
    },
    beginPath() {},
    rect() {},
    clip() {},
    clearRect(x = 0, y = 0, w = curW, h = curH) {
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(curW, Math.ceil(x + w));
      const y1 = Math.min(curH, Math.ceil(y + h));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * curW + px) * 4;
          buf[i] = 0;
          buf[i + 1] = 0;
          buf[i + 2] = 0;
          buf[i + 3] = 0;
        }
      }
    },
    fillRect(x: number, y: number, w: number, h: number) {
      const [fr, fg, fb] = parseHex(String(ctx.fillStyle));
      const x0 = Math.max(0, Math.floor(x + tx));
      const y0 = Math.max(0, Math.floor(y + ty));
      const x1 = Math.min(curW, Math.ceil(x + w + tx));
      const y1 = Math.min(curH, Math.ceil(y + h + ty));
      const aScale = Math.max(0, Math.min(1, ctx.globalAlpha));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * curW + px) * 4;
          if (ctx.globalCompositeOperation === 'source-in') {
            if (buf[i + 3] > 0) {
              buf[i] = fr;
              buf[i + 1] = fg;
              buf[i + 2] = fb;
              buf[i + 3] = Math.round(buf[i + 3] * aScale);
            }
          } else {
            buf[i] = fr;
            buf[i + 1] = fg;
            buf[i + 2] = fb;
            buf[i + 3] = Math.round(255 * aScale);
          }
        }
      }
    },
    createImageData(w: number, h: number) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(imgData: { width: number; height: number; data: Uint8ClampedArray }, dx = 0, dy = 0) {
      for (let y = 0; y < imgData.height; y++) {
        const destY = dy + y;
        if (destY < 0 || destY >= curH) continue;
        for (let x = 0; x < imgData.width; x++) {
          const destX = dx + x;
          if (destX < 0 || destX >= curW) continue;
          const si = (y * imgData.width + x) * 4;
          const di = (destY * curW + destX) * 4;
          buf[di] = imgData.data[si];
          buf[di + 1] = imgData.data[si + 1];
          buf[di + 2] = imgData.data[si + 2];
          buf[di + 3] = imgData.data[si + 3];
        }
      }
    },
    getImageData(sx: number, sy: number, sw: number, sh: number) {
      const data = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y++) {
        const srcY = sy + y;
        if (srcY < 0 || srcY >= curH) continue;
        for (let x = 0; x < sw; x++) {
          const srcX = sx + x;
          if (srcX < 0 || srcX >= curW) continue;
          const si = (srcY * curW + srcX) * 4;
          const di = (y * sw + x) * 4;
          data[di] = buf[si];
          data[di + 1] = buf[si + 1];
          data[di + 2] = buf[si + 2];
          data[di + 3] = buf[si + 3];
        }
      }
      return { width: sw, height: sh, data };
    },
    drawImage(
      source: any,
      sx: number,
      sy: number,
      sw?: number,
      sh?: number,
      dx?: number,
      dy?: number,
      dw?: number,
      dh?: number
    ) {
      const srcBuf: Uint8ClampedArray | undefined = source?.pixelBuffer || source?.__rgbaData;
      const srcW: number = source?.width || source?.naturalWidth || 0;
      const srcH: number = source?.height || source?.naturalHeight || 0;
      if (!srcBuf || srcW <= 0 || srcH <= 0) return;

      const useSub = dx !== undefined && dy !== undefined && dw !== undefined && dh !== undefined;
      const srcX0 = useSub ? sx : 0;
      const srcY0 = useSub ? sy : 0;
      const srcCopyW = useSub ? sw! : srcW;
      const srcCopyH = useSub ? sh! : srcH;
      const rawDstX = useSub ? dx! : sx;
      const rawDstY = useSub ? dy! : sy;
      const rawDstW = useSub ? dw! : sw ?? srcW;
      const rawDstH = useSub ? dh! : sh ?? srcH;

      const dstX0 = rawDstX * sxScale + tx;
      const dstY0 = rawDstY * syScale + ty;
      const dstW = rawDstW * Math.abs(sxScale);
      const dstH = rawDstH * Math.abs(syScale);
      if (dstW <= 0 || dstH <= 0) return;

      const alphaScale = Math.max(0, Math.min(1, ctx.globalAlpha));
      const xStart = Math.max(0, Math.floor(dstX0));
      const yStart = Math.max(0, Math.floor(dstY0));
      const xEnd = Math.min(curW, Math.ceil(dstX0 + dstW));
      const yEnd = Math.min(curH, Math.ceil(dstY0 + dstH));

      for (let py = yStart; py < yEnd; py++) {
        const v = (py + 0.5 - dstY0) / dstH;
        if (v < 0 || v >= 1) continue;
        const syi = Math.min(srcH - 1, Math.max(0, Math.floor(srcY0 + v * srcCopyH)));
        for (let px = xStart; px < xEnd; px++) {
          const u = (px + 0.5 - dstX0) / dstW;
          if (u < 0 || u >= 1) continue;
          const sxi = Math.min(srcW - 1, Math.max(0, Math.floor(srcX0 + u * srcCopyW)));
          const si = (syi * srcW + sxi) * 4;
          const srcA = (srcBuf[si + 3] / 255) * alphaScale;
          if (srcA <= 0.001) continue;
          const di = (py * curW + px) * 4;
          const dstA = buf[di + 3] / 255;

          if (ctx.globalCompositeOperation === 'destination-out') {
            buf[di + 3] = Math.round(dstA * (1 - srcA) * 255);
          } else if (ctx.globalCompositeOperation === 'source-atop') {
            if (dstA <= 0.001) continue;
            buf[di] = Math.round(srcBuf[si] * srcA + buf[di] * (1 - srcA));
            buf[di + 1] = Math.round(srcBuf[si + 1] * srcA + buf[di + 1] * (1 - srcA));
            buf[di + 2] = Math.round(srcBuf[si + 2] * srcA + buf[di + 2] * (1 - srcA));
          } else {
            const outA = srcA + dstA * (1 - srcA);
            const inv = outA > 1e-5 ? 1 / outA : 0;
            buf[di] = Math.round((srcBuf[si] * srcA + buf[di] * dstA * (1 - srcA)) * inv);
            buf[di + 1] = Math.round((srcBuf[si + 1] * srcA + buf[di + 1] * dstA * (1 - srcA)) * inv);
            buf[di + 2] = Math.round((srcBuf[si + 2] * srcA + buf[di + 2] * dstA * (1 - srcA)) * inv);
            buf[di + 3] = Math.round(outA * 255);
          }
        }
      }
    },
  };

  const mockObj: any = {
    get width() {
      return curW;
    },
    set width(v: number) {
      if (v !== curW) resize(v, curH);
    },
    get height() {
      return curH;
    },
    set height(v: number) {
      if (v !== curH) resize(curW, v);
    },
    pixelBuffer: buf,
    getContext(type: string) {
      return type === '2d' ? ctx : null;
    },
  };
  ctx.canvas = mockObj;
  return mockObj;
}

function makeBaseBrushSettings(overrides: Partial<BrushSettings> = {}): BrushSettings {
  return {
    size: 20,
    minSizeFactor: 1.0,
    color: '#ff2222',
    opacity: 1.0,
    flow: 1.0,
    spacing: 0.05,
    hardness: 1.0,
    usePressure: false,
    smoothing: false,
    stabilization: 0,
    useGpu: false,
    ...overrides,
  };
}

function makeHorizontalStrokePoints(
  x0: number,
  x1: number,
  y: number,
  width: number,
  count: number = 12
): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    pts.push({
      x: x0 + (x1 - x0) * t,
      y,
      pressure: 1.0,
      width,
    });
  }
  return pts;
}

describe('CSP True Two-Pass Dual Brush Engine Parity', () => {
  beforeEach(() => {
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return createRasterMockCanvas(128, 128);
        }
        return {};
      },
    };
  });

  describe('1. CspDualBrushConfig Resolution, Link Size & SUT Parser Population', () => {
    it('populates dualBrushConfig from SUT Dual* columns and dualVariantValues while keeping flat fields', async () => {
      const brush = await parseSutExtractedData({
        nodeName: 'CSP Dual Textured Charcoal',
        variantId: 42,
        variantValues: new Map<string, unknown>([
          ['brushsize', 50],
          ['usedualbrush', 1],
          ['dualbrushcompositemode', 28], // height
          ['dualbrushlinksize', 1],
          ['dualbrushhardness', 3], // 0.6
          ['dualbrushdensity', 70], // 0.7
          ['dualbrushfliph', 3], // random
          ['dualbrushflipv', 1], // alternate
          ['dualbrushpatternordertype', 4], // random-no-repeat
          ['dualbrushribbon', 1],
        ]),
        dualVariantValues: new Map<string, unknown>([
          ['brushsize', 25],
          ['brushinterval', 40], // 0.40
          ['brushthickness', 60], // 0.6
          ['brushverticalthicknes', 0], // horizontal -> thicknessVertical = true
          ['brushrotation', 45],
          ['brushrotationeffector', 67], // 0x43 = direction of line
        ]),
        materials: [],
      });

      expect(brush.dualBrush).toBe(true);
      expect(brush.dualBrushConfig).toBeDefined();
      expect(brush.dualBrushConfig!.enabled).toBe(true);
      expect(brush.dualBrushConfig!.compositeMode).toBe('height');
      expect(brush.dualBrushConfig!.linkSizeWithMain).toBe(true);
      expect(brush.dualBrushConfig!.size).toBe(25);
      expect(brush.dualBrushConfig!.sizeRatio).toBeCloseTo(0.5, 4);
      expect(brush.dualBrushConfig!.spacing).toBeCloseTo(0.4, 4);
      expect(brush.dualBrushConfig!.thickness).toBeCloseTo(0.6, 4);
      expect(brush.dualBrushConfig!.thicknessVertical).toBe(true);
      expect(brush.dualBrushConfig!.hardness).toBeCloseTo(0.6, 4);
      expect(brush.dualBrushConfig!.density).toBeCloseTo(0.7, 4);
      expect(brush.dualBrushConfig!.angle).toBe(45);
      expect(brush.dualBrushConfig!.angleDynamics).toBe('direction');
      expect(brush.dualBrushConfig!.flipH).toBe('random');
      expect(brush.dualBrushConfig!.flipV).toBe('alternate');
      expect(brush.dualBrushConfig!.subTipOrder).toBe('random-no-repeat');
      expect(brush.dualBrushConfig!.isRibbon).toBe(true);
    });

    it('resolves legacy flat dual* fields cleanly and respects linkSizeWithMain', () => {
      const legacyBs = makeBaseBrushSettings({
        size: 40,
        dualBrush: true,
        dualBrushCompositeMode: 'subtract',
        dualSize: 16,
        dualSpacing: 0.75,
        dualAngle: 30,
        dualScatter: 0.4,
      });

      const cfg = resolveDualBrushConfig(legacyBs);
      expect(cfg).not.toBeNull();
      expect(cfg!.compositeMode).toBe('subtract');
      expect(cfg!.size).toBe(16);
      expect(cfg!.spacing).toBe(0.75);
      expect(cfg!.angle).toBe(30);
      expect(cfg!.scatter).toBe(0.4);

      const unlinkedSize = computeSecondaryBrushSize(80, {
        enabled: true,
        compositeMode: 'multiply',
        linkSizeWithMain: false,
        size: 16,
        sizeRatio: 0.4,
      });
      expect(unlinkedSize).toBeCloseTo(16, 4);

      const linkedSize = computeSecondaryBrushSize(80, {
        enabled: true,
        compositeMode: 'multiply',
        linkSizeWithMain: true,
        size: 16,
        sizeRatio: 0.4,
      });
      expect(linkedSize).toBeCloseTo(32, 4);

      const scaled = scalePointsForSecondaryBrush(
        [{ x: 10, y: 10, pressure: 1, width: 40 }],
        0.4,
        16
      );
      expect(scaled[0].width).toBeCloseTo(16, 4);
    });
  });

  describe('2. Exact CSP Dual Brush Combine Modes (Math & Raster)', () => {
    it('assigns unique GPU shader indices 0..11 to all 12 CSP Dual Brush composite modes', () => {
      const indices = DUAL_BRUSH_COMPOSITE_MODES.map((m) => dualBrushCompositeModeToIndex(m));
      expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });

    it('evaluates exact combine semantics for every DualBrushCompositeMode', () => {
      // Zero primary silhouette always produces 0 across every mode
      for (const mode of DUAL_BRUSH_COMPOSITE_MODES) {
        expect(combineDualBrushAlpha(0, 1.0, mode)).toBe(0);
      }

      // Exact algebraic checks at (a1=0.8, a2=0.5)
      expect(combineDualBrushAlpha(0.8, 0.5, 'multiply')).toBeCloseTo(0.4, 5);
      expect(combineDualBrushAlpha(0.8, 0.5, 'darken')).toBeCloseTo(0.5, 5);
      expect(combineDualBrushAlpha(0.8, 0.5, 'subtract')).toBeCloseTo(0.3, 5);
      expect(combineDualBrushAlpha(0.8, 0.5, 'compare-density')).toBeCloseTo(0.8, 5);
      expect(combineDualBrushAlpha(0.5, 0.8, 'compare-density')).toBeCloseTo(0.8, 5);
      expect(combineDualBrushAlpha(0.8, 0.5, 'linear-burn')).toBeCloseTo(0.3, 5);
      expect(combineDualBrushAlpha(0.8, 0.5, 'color-burn')).toBeCloseTo(0.6, 5);
      expect(combineDualBrushAlpha(0.8, 0.0, 'color-burn')).toBe(0);
      expect(combineDualBrushAlpha(0.8, 0.5, 'overlay')).toBeCloseTo(0.8, 5);
      expect(combineDualBrushAlpha(0.4, 0.5, 'overlay')).toBeCloseTo(0.4, 5);
      expect(combineDualBrushAlpha(0.4, 0.2, 'overlay')).toBeCloseTo(0.16, 5);
      expect(combineDualBrushAlpha(0.8, 0.5, 'screen')).toBeCloseTo(0.9, 5);
      expect(combineDualBrushAlpha(0.5, 0.8, 'lighten')).toBeCloseTo(0.8, 5);
      expect(combineDualBrushAlpha(0.6, 0.5, 'hard-mix')).toBe(1.0);
      expect(combineDualBrushAlpha(0.4, 0.5, 'hard-mix')).toBe(0.0);
      expect(combineDualBrushAlpha(0.8, 0.5, 'normal')).toBeCloseTo(0.9, 5);

      // Height mode: smooth carving threshold around a1 + a2 = 1.0
      expect(combineDualBrushAlpha(0.4, 0.5, 'height')).toBe(0);
      expect(combineDualBrushAlpha(1.0, 0.0, 'height')).toBe(0);
      const heightMid = combineDualBrushAlpha(0.6, 0.5, 'height');
      expect(heightMid).toBeGreaterThan(0.1);
      expect(heightMid).toBeLessThan(0.9);
      expect(combineDualBrushAlpha(0.8, 0.6, 'height')).toBe(1.0);
    });

    it('renders distinct raster pixel outputs for multiply, subtract, darken, height, linear-burn, color-burn, and overlay', () => {
      const renderModeWithPartialDensity = (mode: DualBrushCompositeMode) => {
        const w = 64;
        const h = 64;
        const pData = new Uint8ClampedArray(w * h * 4);
        const sData = new Uint8ClampedArray(w * h * 4);
        const out = new Uint8ClampedArray(w * h * 4);

        // Primary horizontal ramp: a1 = 0.65 across interior
        // Secondary vertical ramp: a2 = 0.45 in top half, 0.90 in bottom half
        for (let y = 10; y < 54; y++) {
          for (let x = 10; x < 54; x++) {
            const i = (y * w + x) * 4;
            pData[i] = 220;
            pData[i + 1] = 40;
            pData[i + 2] = 60;
            pData[i + 3] = Math.round(0.65 * 255);

            sData[i] = 255;
            sData[i + 1] = 255;
            sData[i + 2] = 255;
            sData[i + 3] = Math.round((y < 32 ? 0.45 : 0.9) * 255);
          }
        }
        combineDualBrushImageData(pData, sData, out, mode);
        const topAlpha = out[(20 * w + 32) * 4 + 3] / 255;
        const botAlpha = out[(42 * w + 32) * 4 + 3] / 255;
        const outsideAlpha = out[(2 * w + 2) * 4 + 3] / 255;
        return { topAlpha, botAlpha, outsideAlpha };
      };

      const mult = renderModeWithPartialDensity('multiply');
      const sub = renderModeWithPartialDensity('subtract');
      const dark = renderModeWithPartialDensity('darken');
      const height = renderModeWithPartialDensity('height');
      const linBurn = renderModeWithPartialDensity('linear-burn');
      const colBurn = renderModeWithPartialDensity('color-burn');
      const ov = renderModeWithPartialDensity('overlay');

      // No mode ever leaks outside primary silhouette
      for (const r of [mult, sub, dark, height, linBurn, colBurn, ov]) {
        expect(r.outsideAlpha).toBe(0);
      }

      // Multiply: 0.65*0.45 ≈ 0.2925, 0.65*0.90 ≈ 0.585
      expect(mult.topAlpha).toBeCloseTo(0.65 * 0.45, 1);
      expect(mult.botAlpha).toBeCloseTo(0.65 * 0.9, 1);

      // Subtract: max(0, 0.65-0.45) = 0.20, max(0, 0.65-0.90) = 0 (stronger secondary carves deeper!)
      expect(sub.topAlpha).toBeCloseTo(0.2, 1);
      expect(sub.botAlpha).toBeCloseTo(0.0, 2);

      // Darken: min(0.65, 0.45) = 0.45, min(0.65, 0.90) = 0.65
      expect(dark.topAlpha).toBeCloseTo(0.45, 1);
      expect(dark.botAlpha).toBeCloseTo(0.65, 1);

      // Linear burn: max(0, 0.65+0.45-1) = 0.10, max(0, 0.65+0.90-1) = 0.55
      expect(linBurn.topAlpha).toBeCloseTo(0.1, 1);
      expect(linBurn.botAlpha).toBeCloseTo(0.55, 1);

      // Color burn: 1-(0.35/0.45) ≈ 0.222, 1-(0.35/0.90) ≈ 0.611
      expect(colBurn.topAlpha).toBeCloseTo(1 - 0.35 / 0.45, 1);
      expect(colBurn.botAlpha).toBeCloseTo(1 - 0.35 / 0.9, 1);

      // Height: steeper/crisper than linear-burn (0.65+0.45-1=0.10 -> smoothstep ≈ 0.352; 0.65+0.90-1=0.55 -> 1.0)
      expect(height.topAlpha).toBeGreaterThan(linBurn.topAlpha + 0.1);
      expect(height.botAlpha).toBeCloseTo(1.0, 2);

      // Overlay: 1 - 2*(0.35)*(0.55) = 0.615, 1 - 2*(0.35)*(0.10) = 0.93
      expect(ov.topAlpha).toBeCloseTo(1 - 2 * 0.35 * 0.55, 1);
      expect(ov.botAlpha).toBeCloseTo(1 - 2 * 0.35 * 0.1, 1);
    });
  });

  describe('3. Independent Secondary Spacing & Size Cadence', () => {
    it('stamps an independent secondary bead cadence inside a continuous primary stroke (multiply & subtract)', () => {
      const pts = makeHorizontalStrokePoints(20, 220, 48, 22, 16);

      // Primary stroke alone: solid continuous bar along y=48
      const primaryOnlyCanvas = createRasterMockCanvas(256, 96);
      renderCompleteStroke(
        primaryOnlyCanvas.getContext('2d'),
        pts,
        makeBaseBrushSettings({ size: 22, spacing: 0.08, hardness: 1.0, flow: 1.0 }),
        'brush'
      );
      let solidCount = 0;
      for (let x = 25; x <= 215; x++) {
        if (primaryOnlyCanvas.pixelBuffer[(48 * 256 + x) * 4 + 3] > 200) solidCount++;
      }
      expect(solidCount).toBeGreaterThan(185); // Nearly 100% solid bar

      // Dual Brush (multiply) with independent secondary size=10, spacing=2.0 (~20px between 10px beads -> ~10px gaps!)
      const dualMultCanvas = createRasterMockCanvas(256, 96);
      renderCompleteStroke(
        dualMultCanvas.getContext('2d'),
        pts,
        makeBaseBrushSettings({
          size: 22,
          spacing: 0.08,
          hardness: 1.0,
          flow: 1.0,
          dualBrush: true,
          dualBrushConfig: {
            enabled: true,
            compositeMode: 'multiply',
            size: 10,
            spacing: 2.0,
            hardness: 1.0,
            density: 1.0,
          },
        }),
        'brush'
      );

      // Count transitions between inked (alpha > 150) and carved gap (alpha < 20) along centerline y=48
      let inkedPx = 0;
      let gapPx = 0;
      let transitions = 0;
      let prevInked = false;
      for (let x = 25; x <= 215; x++) {
        const a = dualMultCanvas.pixelBuffer[(48 * 256 + x) * 4 + 3];
        const isInked = a > 150;
        if (isInked) inkedPx++;
        else if (a < 20) gapPx++;
        if (x > 25 && isInked !== prevInked) transitions++;
        prevInked = isInked;
      }

      // Independent secondary cadence must produce multiple alternating inked beads and empty gaps!
      expect(inkedPx).toBeGreaterThan(35);
      expect(gapPx).toBeGreaterThan(35);
      expect(transitions).toBeGreaterThanOrEqual(8);

      // Verify secondary size=10 is narrower than primary size=22:
      // At y=48+9=57 (inside primary radius 11, outside secondary radius 5), multiply must be 0!
      let outerPrimaryAlpha = 0;
      let outerDualAlpha = 0;
      for (let x = 30; x <= 210; x += 2) {
        outerPrimaryAlpha += primaryOnlyCanvas.pixelBuffer[(57 * 256 + x) * 4 + 3];
        outerDualAlpha += dualMultCanvas.pixelBuffer[(57 * 256 + x) * 4 + 3];
      }
      expect(outerPrimaryAlpha).toBeGreaterThan(10000);
      expect(outerDualAlpha).toBe(0);

      // Dual Brush (subtract) with the exact same secondary cadence carves alternating holes along centerline
      const dualSubCanvas = createRasterMockCanvas(256, 96);
      renderCompleteStroke(
        dualSubCanvas.getContext('2d'),
        pts,
        makeBaseBrushSettings({
          size: 22,
          spacing: 0.08,
          hardness: 1.0,
          flow: 1.0,
          dualBrush: true,
          dualBrushConfig: {
            enabled: true,
            compositeMode: 'subtract',
            size: 10,
            spacing: 2.0,
            hardness: 1.0,
            density: 1.0,
          },
        }),
        'brush'
      );

      let subInked = 0;
      let subCarved = 0;
      for (let x = 25; x <= 215; x++) {
        const a = dualSubCanvas.pixelBuffer[(48 * 256 + x) * 4 + 3];
        if (a > 150) subInked++;
        else if (a < 20) subCarved++;
      }
      expect(subInked).toBeGreaterThan(35);
      expect(subCarved).toBeGreaterThan(35);
    });
  });

  describe('4. Dual Brush + colorMixing (SpatialTipMixer Parity)', () => {
    it('executes both pigment mixing and two-pass Dual Brush modulation without silently dropping dualBrush', () => {
      const w = 220;
      const h = 96;
      const bgCanvas = createRasterMockCanvas(w, h);
      const bgCtx = bgCanvas.getContext('2d');
      bgCtx.fillStyle = '#0000ff';
      bgCtx.fillRect(0, 0, w, h);

      // Stroke red (#ff0000) across blue background with colorMixing=true AND dualBrush=true (multiply, spaced beads)
      const strokeCanvas = createRasterMockCanvas(w, h);
      const pts = makeHorizontalStrokePoints(20, 200, 48, 20, 14);
      const sampler = new LayerPixelSampler(bgCanvas);

      renderCompleteStroke(
        strokeCanvas.getContext('2d'),
        pts,
        makeBaseBrushSettings({
          size: 20,
          color: '#ff0000',
          spacing: 0.1,
          hardness: 1.0,
          flow: 1.0,
          colorMixing: true,
          amountOfPaint: 0.55,
          densityOfPaint: 0.9,
          colorStretch: 0.7,
          dualBrush: true,
          dualBrushConfig: {
            enabled: true,
            compositeMode: 'multiply',
            size: 10,
            spacing: 2.0,
            hardness: 1.0,
            density: 1.0,
          },
        }),
        'brush',
        'color',
        false,
        bgCanvas,
        false,
        sampler
      );

      let mixedInkedCount = 0;
      let carvedGapCount = 0;
      let pickedUpBlueSum = 0;
      for (let x = 25; x <= 195; x++) {
        const i = (48 * w + x) * 4;
        const r = strokeCanvas.pixelBuffer[i];
        const b = strokeCanvas.pixelBuffer[i + 2];
        const a = strokeCanvas.pixelBuffer[i + 3];
        if (a > 100) {
          mixedInkedCount++;
          // Mixed red + blue canvas pigment must contain both red and blue channels!
          if (r > 30 && b > 20) {
            pickedUpBlueSum += b;
          }
        } else if (a < 15) {
          carvedGapCount++;
        }
      }

      // Dual Brush did NOT get dropped: alternating inked beads AND carved gaps exist
      expect(mixedInkedCount).toBeGreaterThan(25);
      expect(carvedGapCount).toBeGreaterThan(25);
      // Color mixing actually mixed underlying blue canvas into the red brush pigment
      expect(pickedUpBlueSum).toBeGreaterThan(500);
    });
  });

  describe('5. WebGL Two-Pass Dispatch & Live Paired-Buffer Zero-Pop Parity', () => {
    it('dispatches independent primaryDabs and secondaryDabs to WebGlBrushEngine.renderDualBrushDabsToContext', () => {
      const gpu = WebGlBrushEngine.getInstance();
      const availSpy = vi.spyOn(gpu, 'isAvailable').mockReturnValue(true);
      let capturedPrimary: GpuDab[] = [];
      let capturedSecondary: GpuDab[] = [];
      let capturedMode: DualBrushCompositeMode | null = null;

      const dualSpy = vi
        .spyOn(gpu, 'renderDualBrushDabsToContext')
        .mockImplementation(
          (_ctx, primaryDabs, _pSettings, secondaryDabs, _sSettings, mode) => {
            capturedPrimary = primaryDabs.slice();
            capturedSecondary = secondaryDabs.slice();
            capturedMode = mode;
            return true;
          }
        );

      try {
        const targetCanvas = createRasterMockCanvas(256, 96);
        const pts = makeHorizontalStrokePoints(20, 220, 48, 24, 12);
        renderCompleteStroke(
          targetCanvas.getContext('2d'),
          pts,
          makeBaseBrushSettings({
            size: 24,
            spacing: 0.1,
            useGpu: true,
            dualBrush: true,
            dualBrushConfig: {
              enabled: true,
              compositeMode: 'height',
              size: 12,
              spacing: 1.5,
              hardness: 0.8,
              density: 0.9,
            },
          }),
          'brush'
        );

        expect(dualSpy).toHaveBeenCalledTimes(1);
        expect(capturedMode).toBe('height');
        // Primary spacing 0.1 on 24px over 200px (~83 dabs) vs secondary spacing 1.5 on 12px (~12 dabs)
        expect(capturedPrimary.length).toBeGreaterThan(50);
        expect(capturedSecondary.length).toBeGreaterThan(5);
        expect(capturedSecondary.length).toBeLessThan(capturedPrimary.length * 0.3);
        expect(capturedPrimary[0].width).toBeCloseTo(24, 1);
        expect(capturedSecondary[0].width).toBeCloseTo(12, 1);
      } finally {
        availSpy.mockRestore();
        dualSpy.mockRestore();
      }
    });

    it('matches live paired draft buffers (syncDualBrushRegionToDraft) pixel-for-pixel with renderCompleteStroke', () => {
      const w = 160;
      const h = 80;
      const bs = makeBaseBrushSettings({
        size: 18,
        spacing: 0.1,
        hardness: 0.9,
        flow: 0.9,
        dualBrush: true,
        dualBrushConfig: {
          enabled: true,
          compositeMode: 'linear-burn',
          size: 12,
          spacing: 1.4,
          hardness: 0.8,
          density: 0.85,
        },
      });
      const pts = makeHorizontalStrokePoints(20, 140, 40, 18, 10);

      // Reference: full two-pass renderCompleteStroke
      const refCanvas = createRasterMockCanvas(w, h);
      renderCompleteStroke(refCanvas.getContext('2d'), pts, bs, 'brush');

      // Live paired buffers: Pass 1 -> dualPrimaryCanvas, Pass 2 -> dualSecondaryCanvas, sync -> draftCanvas
      const draftCanvas = createRasterMockCanvas(w, h) as DraftCanvasElement;
      draftCanvas.__draftScale = 1.0;
      draftCanvas.__draftDocRect = { x: 0, y: 0, width: w, height: h };
      const draftCtx = draftCanvas.getContext('2d')!;
      const state = createInitialStrokeSessionState();
      state.isDualBrushStroke = true;

      const pair = prepareDualDraftCanvases(state, draftCanvas, { width: w, height: h }, null);
      expect(pair).not.toBeNull();

      const dualCfg = resolveDualBrushConfig(bs)!;
      const secInfo = buildSecondaryBrushSettings(bs, dualCfg);
      const secPts = scalePointsForSecondaryBrush(pts, secInfo.sizeRatio, secInfo.settings.size);

      renderCompleteStroke(
        pair!.primaryCtx,
        pts,
        { ...bs, dualBrush: false, dualBrushConfig: undefined },
        'brush'
      );
      renderCompleteStroke(pair!.secondaryCtx, secPts, secInfo.settings, 'brush');

      syncDualBrushRegionToDraft(state, draftCanvas, draftCtx, bs, 0, 0, w, h);

      // Zero visual pop: combined live draft matches renderCompleteStroke pixel-for-pixel!
      let maxDiff = 0;
      let nonZeroCount = 0;
      for (let i = 0; i < refCanvas.pixelBuffer.length; i += 4) {
        if (refCanvas.pixelBuffer[i + 3] > 0) nonZeroCount++;
        for (let c = 0; c < 4; c++) {
          const diff = Math.abs(refCanvas.pixelBuffer[i + c] - (draftCanvas as any).pixelBuffer[i + c]);
          if (diff > maxDiff) maxDiff = diff;
        }
      }
      expect(nonZeroCount).toBeGreaterThan(100);
      expect(maxDiff).toBeLessThanOrEqual(1);
    });
  });
});
