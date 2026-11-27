import { describe, it, expect, beforeEach } from 'vitest';
import {
  decodeCspBrushSize,
  decodeCspHardness,
  mapCspBrushCombineMode,
  parseCspEffector,
  parseCspInOutTarget,
  parseSutExtractedData,
} from '../sutParser';
import {
  getEffectiveBrushSettings,
  saveBrushSettingsImmediately,
} from '../brushPresetManager';
import { prepareBrushSettingsForCsp } from '../brushStorage';
import { NativeSutExtract } from '../nativeBackend';
import {
  centripetalCatmullRomToBezier,
  buildCubicArcLengthTable,
  getCubicPointAtArcLength,
  drawBrushDot,
  drawBrushCubicBezierSegment,
  evaluateCspSensor,
  evaluateFastSpline,
  renderCompleteStroke,
  computeTipStampDimensions,
  applyCspPaperTextureAlpha,
  applyCspWatercolorEdge,
  evaluateCspTaperFactors,
  computeCspTiltMagnitude,
} from '../../engine/BrushEngine';
import type { GpuDab } from '../../engine/WebGlBrushEngine';
import { InputStabilizer } from '../../engine/InputStabilizer';
import { LayerPixelSampler } from '../colorMixingEngine';
import { BrushSettings, CspPaperTextureMode, LayerItem, Point } from '../../types/editor';
import { SparseTileGrid } from '../tileEngine';
import { downsample2x2ToParentTile } from '../tileEngine/mipmap';
import { createTileBuffer } from '../tileEngine/types';
import { createInitialStrokeSessionState } from '../../hooks/drawing/brushStrokeSession/types';
import { runPointerDown } from '../../hooks/drawing/brushStrokeSession/pointerDownHandler';
import { runPointerMove } from '../../hooks/drawing/brushStrokeSession/pointerMoveHandler';
import { runFlushPendingPoints } from '../../hooks/drawing/brushStrokeSession/flushPendingPoints';
import { runPointerUp } from '../../hooks/drawing/brushStrokeSession/pointerUpHandler';
import {
  abortActiveStrokeSession,
  buildTouchedTileSpansFromSet,
  clearPredictedCanvasSurface,
  computeCanvasPoint,
  createLiveBrushOptions,
  emitConstraintAxisChangeIfNeeded,
  getPredictedCanvasElement,
  getViewportRectCached,
  markTouchedTilesInRect,
  resolveEffectiveOpacitySensorValue,
  resolveLiveAntiAliasValue,
  resolveStrokeColorValue,
} from '../../hooks/drawing/brushStrokeSession/strokeHelpers';
import { emitLiveSegmentToDraft } from '../../hooks/drawing/brushStrokeSession/liveSegmentEmitter';

/**
 * Software Canvas2D rasterizer with accurate affine translate/rotate + bilinear drawImage
 * + Porter-Duff source-over compositing for pixel-exact headless verification.
 */
function createSoftwareCanvas(initW: number, initH: number) {
  let width = initW;
  let height = initH;
  let buf = new Uint8ClampedArray(width * height * 4);
  type State = { tx: number; ty: number; rot: number; sx: number; sy: number; alpha: number; op: string };
  const stack: State[] = [];
  let st: State = { tx: 0, ty: 0, rot: 0, sx: 1, sy: 1, alpha: 1, op: 'source-over' };

  const ctx: any = {
    get canvas() { return surfaceObj; },
    get globalAlpha() { return st.alpha; },
    set globalAlpha(v: number) { st.alpha = v; },
    get globalCompositeOperation() { return st.op; },
    set globalCompositeOperation(v: string) { st.op = v; },
    imageSmoothingEnabled: true,
    save: () => stack.push({ ...st }),
    restore: () => { const p = stack.pop(); if (p) st = p; },
    resetTransform: () => { st.tx = 0; st.ty = 0; st.rot = 0; st.sx = 1; st.sy = 1; },
    setTransform: (a: number, _b: number, _c: number, d: number, e: number, f: number) => {
      st.sx = a;
      st.sy = d;
      st.tx = e;
      st.ty = f;
      st.rot = 0;
    },
    getTransform: () => ({ a: st.sx, b: 0, c: 0, d: st.sy, e: st.tx, f: st.ty }),
    beginPath: () => {},
    rect: () => {},
    clip: () => {},
    translate: (x: number, y: number) => {
      const c = Math.cos(st.rot), s = Math.sin(st.rot);
      st.tx += (x * c - y * s) * st.sx;
      st.ty += (x * s + y * c) * st.sy;
    },
    rotate: (rad: number) => { st.rot += rad; },
    scale: (sx: number, sy: number) => { st.sx *= sx; st.sy *= sy; },
    clearRect: () => buf.fill(0),
    fillRect: () => {},
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: (
      img: { width: number; height: number; data: Uint8ClampedArray },
      dx = 0,
      dy = 0,
      dirtyX = 0,
      dirtyY = 0,
      dirtyW = img.width,
      dirtyH = img.height
    ) => {
      for (let row = 0; row < dirtyH; row++) {
        const ty = dy + dirtyY + row;
        if (ty < 0 || ty >= height) continue;
        for (let col = 0; col < dirtyW; col++) {
          const tx = dx + dirtyX + col;
          if (tx < 0 || tx >= width) continue;
          const si = ((dirtyY + row) * img.width + (dirtyX + col)) * 4;
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
    drawImage: (src: any, dx: number, dy: number, dw?: number, dh?: number) => {
      const srcBuf: Uint8ClampedArray | undefined = src?.buf;
      if (!srcBuf) return;
      const sw = src.width;
      const sh = src.height;
      const w = dw ?? sw;
      const h = dh ?? sh;
      if (w <= 0 || h <= 0) return;

      const c = Math.cos(st.rot);
      const s = Math.sin(st.rot);
      const corners = [
        [dx, dy],
        [dx + w, dy],
        [dx, dy + h],
        [dx + w, dy + h],
      ];
      let minX = width, minY = height, maxX = -1, maxY = -1;
      for (const [lx, ly] of corners) {
        const wx = st.tx + (lx * st.sx * c - ly * st.sy * s);
        const wy = st.ty + (lx * st.sx * s + ly * st.sy * c);
        if (wx < minX) minX = wx;
        if (wy < minY) minY = wy;
        if (wx > maxX) maxX = wx;
        if (wy > maxY) maxY = wy;
      }
      const x0 = Math.max(0, Math.floor(minX));
      const y0 = Math.max(0, Math.floor(minY));
      const x1 = Math.min(width - 1, Math.ceil(maxX));
      const y1 = Math.min(height - 1, Math.ceil(maxY));

      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          const rx = px + 0.5 - st.tx;
          const ry = py + 0.5 - st.ty;
          const lx = (rx * c + ry * s) / st.sx;
          const ly = (-rx * s + ry * c) / st.sy;
          const u = (lx - dx) / w;
          const v = (ly - dy) / h;
          if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;

          const fx = u * sw - 0.5;
          const fy = v * sh - 0.5;
          const ix0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
          const iy0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
          const ix1 = Math.min(sw - 1, ix0 + 1);
          const iy1 = Math.min(sh - 1, iy0 + 1);
          const tx = Math.max(0, Math.min(1, fx - ix0));
          const ty = Math.max(0, Math.min(1, fy - iy0));

          const i00 = (iy0 * sw + ix0) * 4;
          const i10 = (iy0 * sw + ix1) * 4;
          const i01 = (iy1 * sw + ix0) * 4;
          const i11 = (iy1 * sw + ix1) * 4;
          const w00 = (1 - tx) * (1 - ty);
          const w10 = tx * (1 - ty);
          const w01 = (1 - tx) * ty;
          const w11 = tx * ty;

          const a00 = (srcBuf[i00 + 3] / 255) * w00;
          const a10 = (srcBuf[i10 + 3] / 255) * w10;
          const a01 = (srcBuf[i01 + 3] / 255) * w01;
          const a11 = (srcBuf[i11 + 3] / 255) * w11;
          const srcA = (a00 + a10 + a01 + a11) * st.alpha;
          if (srcA <= 0.001) continue;
          const aSum = a00 + a10 + a01 + a11;
          const sr = (srcBuf[i00] * a00 + srcBuf[i10] * a10 + srcBuf[i01] * a01 + srcBuf[i11] * a11) / aSum;
          const sg = (srcBuf[i00 + 1] * a00 + srcBuf[i10 + 1] * a10 + srcBuf[i01 + 1] * a01 + srcBuf[i11 + 1] * a11) / aSum;
          const sb = (srcBuf[i00 + 2] * a00 + srcBuf[i10 + 2] * a10 + srcBuf[i01 + 2] * a01 + srcBuf[i11 + 2] * a11) / aSum;

          const di = (py * width + px) * 4;
          const dstA = buf[di + 3] / 255;
          const outA = srcA + dstA * (1 - srcA);
          if (outA > 0.001) {
            const inv = 1 / outA;
            buf[di] = Math.round((sr * srcA + buf[di] * dstA * (1 - srcA)) * inv);
            buf[di + 1] = Math.round((sg * srcA + buf[di + 1] * dstA * (1 - srcA)) * inv);
            buf[di + 2] = Math.round((sb * srcA + buf[di + 2] * dstA * (1 - srcA)) * inv);
            buf[di + 3] = Math.round(Math.min(255, outA * 255));
          }
        }
      }
    },
  };

  const surfaceObj: any = {
    get width() { return width; },
    set width(v: number) { width = v; buf = new Uint8ClampedArray(width * height * 4); },
    get height() { return height; },
    set height(v: number) { height = v; buf = new Uint8ClampedArray(width * height * 4); },
    get buf() { return buf; },
    getContext: (type: string) => (type === '2d' ? ctx : null),
    ctx,
  };
  return surfaceObj;
}

function makeFakeEffector(flags: number, minVal: number, maxVal: number, pts?: [number, number][]): Uint8Array {
  const curveBytes = pts ? 12 + pts.length * 16 : 0;
  const buf = new Uint8Array(48 + curveBytes);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 48, false);
  v.setUint32(4, 0xf0, false);
  v.setUint32(8, flags, false);
  v.setUint32(12, minVal, false);
  v.setUint32(16, maxVal, false);
  if (pts) {
    v.setUint32(48, 12, false);
    v.setUint32(52, pts.length, false);
    v.setUint32(56, 16, false);
    for (let i = 0; i < pts.length; i++) {
      v.setFloat64(60 + i * 16, pts[i][0], false);
      v.setFloat64(68 + i * 16, pts[i][1], false);
    }
  }
  return buf;
}

function makeFakeInOutTarget(entries: Array<[number, number, number]>): Uint8Array {
  const buf = new Uint8Array(12 + entries.length * 12);
  const v = new DataView(buf.buffer);
  v.setUint32(0, 12, false);
  v.setUint32(4, entries.length, false);
  v.setUint32(8, 12, false);
  for (let i = 0; i < entries.length; i++) {
    v.setUint32(12 + i * 12, entries[i][0], false);
    v.setUint32(16 + i * 12, entries[i][1], false);
    v.setUint32(20 + i * 12, entries[i][2], false);
  }
  return buf;
}

describe('CSP .sut Import & Oil Paint Parity', () => {
  beforeEach(() => {
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return createSoftwareCanvas(64, 64);
        return {};
      },
    };
  });

  it('parses 48-byte CSP effector headers and curves accurately', () => {
    const blob = makeFakeEffector(0x10, 55, 100, [
      [0, 0],
      [0.5, 0.7],
      [1, 1],
    ]);
    const eff = parseCspEffector(blob);
    expect(eff).not.toBeNull();
    expect(eff!.usePressure).toBe(true);
    expect(eff!.minValue).toBeCloseTo(0.55, 4);
    expect(eff!.pressureCurve).toEqual([
      [0, 0],
      [0.5, 0.7],
      [1, 1],
    ]);
  });

  it('parses BrushInOutTarget table (size min 53%, amount of paint 0%, density of paint 0%)', () => {
    const blob = makeFakeInOutTarget([
      [0x3fd, 1, 53],
      [0x43a, 1, 0],
      [0x43c, 1, 0],
    ]);
    const target = parseCspInOutTarget(blob);
    expect(target).not.toBeNull();
    expect(target!.affectSize).toBe(true);
    expect(target!.minSizeRatio).toBeCloseTo(0.53, 4);
    expect(target!.affectAmountOfPaint).toBe(true);
    expect(target!.minAmountRatio).toBe(0);
    expect(target!.affectDensityOfPaint).toBe(true);
    expect(target!.minPaintDensityRatio).toBe(0);
    expect(target!.affectDensity).toBe(false);
    expect(target!.affectOpacity).toBe(false);
  });

  it('maps Oil Paint Brush.sut fields cleanly without hijacking paper texture or forcing random spin', async () => {
    // Minimal 1x1 PNG
    const tinyPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xde, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const catPath = '.:09:66:0b8aa316f6-5440-3783-ad01-182ac015dd';
    const texBlob = new TextEncoder().encode(catPath);

    const extracted: NativeSutExtract = {
      nodeName: 'Oil Paint Brush',
      variantId: 828,
      variantValues: new Map<string, unknown>([
        ['brushsize', 32.8],
        ['brushsizeeffector', makeFakeEffector(0x10, 55, 100, [[0, 0], [1, 1]])],
        ['brushflow', 100],
        ['brushfloweffector', makeFakeEffector(0x10, 0, 100, [[0, 0], [1, 1]])],
        ['opacity', 100],
        ['brushhardness', 100],
        ['brushinterval', 0.3],
        ['brushautointervaltype', 0],
        ['brushthickness', 17],
        ['brushverticalthicknes', 0],
        ['brushrotation', 0],
        ['brushrotationeffector', 67], // direction of line (0x43 -> low nibble 3)
        ['brushrotationrandomscale', 100], // default 100 when random is OFF
        ['brushusepatternimage', 0], // Circle tip!
        ['textureimage', texBlob],
        ['texturecompositemode', 0],
        ['texturedensity', 62],
        ['textureforplot', 1],
        ['brushusewatercolor', 1],
        ['brushwatercolor', 0],
        ['brushmixcolor', 62],
        ['brushmixalpha', 74],
        ['brushmixcolorextension', 82],
        ['brushcolormixingmode', 0],
        ['brushusewateredge', 0],
        ['brushwateredgealphapower', 20],
        ['brushusein', 1],
        ['brushinlength', 20],
        ['brushinratio', 30],
        ['brushuseout', 1],
        ['brushoutlength', 381],
        ['brushoutratio', 30],
        ['brushinouttype', 2],
        ['brushinouttarget', makeFakeInOutTarget([[0x3fd, 1, 53], [0x43a, 1, 0], [0x43c, 1, 0]])],
      ]),
      materials: [
        {
          pwId: '1',
          originalPath: `${catPath}:data:material.layer`,
          catalogPath: catPath,
          fileData: tinyPng,
        },
      ],
    };

    const brush = await parseSutExtractedData(extracted, 'Oil Paint Brush.sut');
    expect(brush.name).toBe('Oil Paint Brush');
    expect(brush.tipDataUrl).toBeUndefined(); // Circle tip, NOT paper texture!
    expect(brush.paperTexture).toBeDefined();
    expect(brush.paperTextureMode).toBe('normal');
    expect(brush.paperTextureApplyEachPlot).toBe(true);
    expect(brush.textureDensity).toBeCloseTo(0.62, 4);
    expect(brush.spacing).toBeCloseTo(0.003, 5); // 0.3% = 0.003, NOT 30%!
    expect(brush.thickness).toBeCloseTo(0.17, 4);
    expect(brush.thicknessVertical).toBe(true); // CSP Horizontal (BrushVerticalThicknes=0) scales local X
    expect(brush.angleDynamics).toBe('direction');
    expect(brush.angle).toBe(0); // CSP Direction of line aligns local +X directly with atan2(dy, dx)
    expect(brush.rotationRandomScale).toBe(0); // Random is OFF!
    expect(brush.wetEdge).toBe(0); // BrushUseWaterEdge=0!
    expect(brush.colorMixing).toBe(true);
    expect(brush.mixingMode).toBe('blend');
    expect(brush.perceptualMixing).toBe(false);
    expect(brush.amountOfPaint).toBeCloseTo(0.62, 4);
    expect(brush.densityOfPaint).toBeCloseTo(0.74, 4);
    expect(brush.colorStretch).toBeCloseTo(0.82, 4);
    expect(brush.taper?.useOut).toBe(true);
    expect(brush.taper?.outLength).toBe(381);
    expect(brush.taper?.inOutType).toBe(2);
    expect(brush.taper?.affectAmountOfPaint).toBe(true);
    expect(brush.taper?.affectDensityOfPaint).toBe(true);
    expect(brush.taper?.affectOpacity).toBe(false);
    expect(brush.taper?.minSizeRatio).toBeCloseTo(0.53, 4);
  });

  it('SpatialTipMixer mixes side-by-side strokes independently (left stays pure red, right drags black)', () => {
    const surface = createSoftwareCanvas(160, 160);
    // Paint a solid black vertical half on the right side (x >= 80)
    for (let y = 0; y < 160; y++) {
      for (let x = 80; x < 160; x++) {
        const i = (y * 160 + x) * 4;
        surface.buf[i] = 10;
        surface.buf[i + 1] = 10;
        surface.buf[i + 2] = 10;
        surface.buf[i + 3] = 255;
      }
    }

    const sampler = new LayerPixelSampler(surface as unknown as HTMLCanvasElement);
    const settings: BrushSettings = {
      size: 40,
      minSizeFactor: 0.55,
      color: '#d82218',
      opacity: 1.0,
      flow: 1.0,
      spacing: 0.003,
      hardness: 1.0,
      thickness: 0.17,
      thicknessVertical: false,
      customTipAngle: 90,
      customTipAngleDynamics: 'direction',
      customTipRotationRandomScale: 0,
      antiAlias: 2,
      usePressure: true,
      smoothing: true,
      stabilization: 0,
      colorMixing: true,
      perceptualMixing: true,
      amountOfPaint: 0.62,
      densityOfPaint: 0.74,
      colorStretch: 0.82,
      mixingMode: 'blend',
      useGpu: false,
    };

    // Draw a vertical red flat stroke centered right on the x=80 boundary (x=60..100)
    const pts: Point[] = [];
    for (let i = 0; i <= 12; i++) {
      pts.push({ x: 80, y: 20 + i * 10, pressure: 1.0, width: 40 });
    }

    renderCompleteStroke(
      surface.ctx,
      pts,
      settings,
      'brush',
      'color',
      false,
      surface as unknown as HTMLCanvasElement,
      false,
      sampler
    );

    // Sample at y=80: left side of brush (x=68, over blank canvas) must be bright red
    const leftIdx = (80 * 160 + 68) * 4;
    // Right side of brush (x=92, over black paint) must be darkened by picked-up black
    const rightIdx = (80 * 160 + 92) * 4;

    expect(surface.buf[leftIdx + 3]).toBeGreaterThan(220); // Solid opaque body
    expect(surface.buf[leftIdx]).toBeGreaterThan(190); // Pure bright red on left edge
    expect(surface.buf[rightIdx]).toBeLessThan(surface.buf[leftIdx] - 35); // Noticeably darkened on right edge!
    expect(surface.buf[rightIdx]).toBeGreaterThan(40); // Blended red+black, not untouched pure black!
  });

  it('maintains crisp opaque edges on large 130px CSP Fade flat strokes and ignores pointer-up reverse micro-hooks', () => {
    const surface = createSoftwareCanvas(240, 240);
    const sampler = new LayerPixelSampler(surface as unknown as HTMLCanvasElement);
    const settings: BrushSettings = {
      size: 130,
      minSizeFactor: 0.55,
      color: '#101010',
      opacity: 1.0,
      flow: 1.0,
      spacing: 0.003,
      adjustDensityByGap: false,
      hardness: 1.0,
      thickness: 0.17,
      thicknessVertical: false,
      customTipAngle: 90,
      customTipAngleDynamics: 'direction',
      customTipRotationRandomScale: 0,
      antiAlias: 2,
      usePressure: true,
      smoothing: true,
      stabilization: 0,
      colorMixing: true,
      perceptualMixing: true,
      amountOfPaint: 0.62,
      densityOfPaint: 0.74,
      colorStretch: 0.82,
      mixingMode: 'blend',
      taper: {
        useIn: true,
        inLength: 20,
        inRatio: 0.3,
        useOut: true,
        outLength: 381,
        outRatio: 0.3,
        inOutType: 2, // CSP Specify length (ending taper)
        inOutBySpeed: true,
        affectSize: true,
        minSizeRatio: 0.53,
        affectDensity: false,
        minDensityRatio: 0,
        affectOpacity: false,
        affectAmountOfPaint: true,
        minAmountRatio: 0,
        affectDensityOfPaint: true,
        minPaintDensityRatio: 0,
      },
      useGpu: false,
    };

    const pts: Point[] = [];
    for (let i = 0; i <= 14; i++) {
      pts.push({ x: 120, y: 30 + i * 10, pressure: 0.75, width: 115 });
    }
    // Reverse micro-hook at pointer-up should NOT spin the flat blade
    pts.push({ x: 120.4, y: 169.3, pressure: 0.75, width: 115 });

    renderCompleteStroke(
      surface.ctx,
      pts,
      settings,
      'brush',
      'color',
      false,
      surface as unknown as HTMLCanvasElement,
      false,
      sampler
    );

    // Crisp start cap at y=38 (no dark lip, high coverage) and smooth monotonic Fade over 381px
    const startCenter = (42 * 240 + 120) * 4;
    expect(surface.buf[startCenter + 3]).toBeGreaterThan(210);

    // Razor-sharp side edge at y=80: inside (x=72) is solid, outside (x=55) is completely clean transparent
    const insideEdge = (80 * 240 + 72) * 4;
    const outsideEdge = (80 * 240 + 55) * 4;
    expect(surface.buf[insideEdge + 3]).toBeGreaterThan(200);
    expect(surface.buf[outsideEdge + 3]).toBe(0);
  });

  it('produces monotonic tangent angles on circular arcs (no Catmull-Rom sawtooth wiggle) and smooth 381px Fade', () => {
    const arcPts: Point[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * 1.2;
      arcPts.push({ x: 100 + Math.cos(a) * 80, y: 100 + Math.sin(a) * 80, pressure: 0.8, width: 40 });
    }
    const { c1, c2 } = centripetalCatmullRomToBezier(arcPts[4], arcPts[5], arcPts[6], arcPts[7]);
    const tab = buildCubicArcLengthTable(arcPts[5], c1, c2, arcPts[6]);
    const s0 = getCubicPointAtArcLength(arcPts[5], c1, c2, arcPts[6], 0, tab);
    const sMid = getCubicPointAtArcLength(arcPts[5], c1, c2, arcPts[6], tab.totalLength * 0.5, tab);
    const s1 = getCubicPointAtArcLength(arcPts[5], c1, c2, arcPts[6], tab.totalLength, tab);
    const a0 = Math.atan2(s0.dy, s0.dx);
    const aMid = Math.atan2(sMid.dy, sMid.dx);
    const a1 = Math.atan2(s1.dy, s1.dx);
    expect(aMid).toBeGreaterThan(a0);
    expect(a1).toBeGreaterThan(aMid);

    // Verify 381px Specify-length ending taper stays solid over long continuous strokes (>500px)
    // and smoothly fades out over the final ending tail (never killing strokes mid-way at 381px)
    const surf = createSoftwareCanvas(120, 760);
    const sampler = new LayerPixelSampler(surf as unknown as HTMLCanvasElement);
    const pts: Point[] = [];
    for (let i = 0; i <= 70; i++) {
      pts.push({ x: 60, y: 20 + i * 10, pressure: 0.55, width: 60 });
    }
    renderCompleteStroke(
      surf.ctx,
      pts,
      {
        size: 60,
        minSizeFactor: 0.55,
        color: '#101010',
        opacity: 1.0,
        flow: 1.0,
        adjustDensityByGap: false,
        spacing: 0.003,
        hardness: 1.0,
        thickness: 0.17,
        thicknessVertical: false,
        customTipAngle: 90,
        customTipAngleDynamics: 'direction',
        antiAlias: 2,
        usePressure: true,
        smoothing: true,
        stabilization: 0,
        densitySensor: { usePressure: true, pressureMin: 0 },
        colorMixing: true,
        perceptualMixing: false,
        amountOfPaint: 0.62,
        densityOfPaint: 0.74,
        colorStretch: 0.82,
        mixingMode: 'blend',
        taper: {
          useIn: true,
          inLength: 20,
          inRatio: 0.3,
          useOut: true,
          outLength: 381,
          outRatio: 0.3,
          inOutType: 2,
          inOutBySpeed: true,
          affectSize: true,
          minSizeRatio: 0.53,
          affectDensity: false,
          minDensityRatio: 0,
          affectOpacity: false,
          affectAmountOfPaint: true,
          minAmountRatio: 0,
          affectDensityOfPaint: true,
          minPaintDensityRatio: 0,
        },
        useGpu: false,
      },
      'brush',
      'color',
      false,
      surf as unknown as HTMLCanvasElement,
      false,
      sampler,
      false,
      1.1
    );

    // At y=400 (380px into a 700px stroke — past 381px!), stroke MUST still be rich solid oil (not dead!)
    const aPast381 = surf.buf[(400 * 120 + 60) * 4 + 3];
    // Near the ending tail (y=620 and y=695), stroke smoothly tapers toward transparent
    const aMidTail = surf.buf[(620 * 120 + 60) * 4 + 3];
    const aEndTail = surf.buf[(705 * 120 + 60) * 4 + 3];
    expect(aPast381).toBeGreaterThan(220);
    expect(aMidTail).toBeLessThan(aPast381 - 15);
    expect(aEndTail).toBeLessThan(aMidTail - 40);
  });

  it('parses ◇スケッチ.sut (AutoIntervalType=1 Narrow, Overlay texture, TextureForPlot=0) and renders rich per-stroke texture on solid square tips', async () => {
    const tinyPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xde, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const texCat = '.:Install:Paint001:4abe2a6fb7-9a42-c98b-2492-2b41211e8c';
    const extracted: NativeSutExtract = {
      nodeName: '◇スケッチ',
      variantId: 913,
      variantValues: new Map<string, unknown>([
        ['brushsize', 30],
        ['opacity', 90],
        ['brushflow', 100],
        ['brushadjustflowbyinterval', 1],
        ['brushautointervaltype', 1], // Narrow!
        ['brushinterval', 1.0],
        ['brushthickness', 51],
        ['brushverticalthicknes', 0],
        ['brushrotation', 0],
        ['brushrotationeffector', 67],
        ['brushusepatternimage', 0],
        ['textureimage', new TextEncoder().encode(texCat)],
        ['texturecompositemode', 4], // Overlay
        ['texturedensity', 89],
        ['texturescale2', 70],
        ['textureforplot', 0], // Per-stroke!
        ['brushusewatercolor', 0],
        ['brushopacityeffector', makeFakeEffector(0x10, 0, 100, [[0, 0], [0.59, 0.655], [1, 1]])],
        ['brushfloweffector', makeFakeEffector(0x10, 0, 100, [[0, 0], [0.54, 0.79], [1, 1]])],
      ]),
      materials: [
        {
          pwId: '1',
          originalPath: `${texCat}:data:material.layer`,
          catalogPath: texCat,
          fileData: tinyPng,
        },
      ],
    };

    const brush = await parseSutExtractedData(extracted, '◇スケッチ.sut');
    expect(brush.spacing).toBeCloseTo(0.04, 4); // Narrow (NOT 0.25!)
    expect(brush.paperTextureMode).toBe('overlay');
    expect(brush.paperTextureApplyEachPlot).toBe(false);
    expect(brush.textureDensity).toBeCloseTo(0.89, 4);
    expect(brush.paperTextureScale).toBeCloseTo(0.7, 4);
    expect(brush.thickness).toBeCloseTo(0.51, 4);
    expect(brush.thicknessVertical).toBe(true);

    // Overlay texture mode MUST modulate even solid 1.0 alpha tips (previously overlay(1, g) === 1!)
    const valleyA = applyCspPaperTextureAlpha(1.0, 0.05, 0.89, 1.0, 'overlay', 0, 0, false, true);
    const peakA = applyCspPaperTextureAlpha(1.0, 0.95, 0.89, 1.0, 'overlay', 0, 0, false, true);
    expect(peakA - valleyA).toBeGreaterThan(0.45);

    // Render a real per-stroke textured stroke (TextureForPlot=0) with a solid square tip & checkerboard paper texture
    const paperImg = createSoftwareCanvas(16, 16);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const i = (y * 16 + x) * 4;
        // CSP paper texture format: RGB=0, alpha encodes darkness (0=peak, 255=valley)
        const isValley = ((x >> 1) + (y >> 1)) % 2 === 0;
        paperImg.buf[i] = 0;
        paperImg.buf[i + 1] = 0;
        paperImg.buf[i + 2] = 0;
        paperImg.buf[i + 3] = isValley ? 245 : 10;
      }
    }
    const solidSquareTip = createSoftwareCanvas(16, 16);
    for (let i = 0; i < solidSquareTip.buf.length; i += 4) {
      solidSquareTip.buf[i] = 255;
      solidSquareTip.buf[i + 1] = 255;
      solidSquareTip.buf[i + 2] = 255;
      solidSquareTip.buf[i + 3] = 255;
    }

    const surf = createSoftwareCanvas(140, 80);
    const pts: Point[] = [];
    for (let i = 0; i <= 10; i++) {
      pts.push({ x: 20 + i * 10, y: 40, pressure: 0.6, width: 30 });
    }
    renderCompleteStroke(
      surf.ctx,
      pts,
      {
        size: 30,
        minSizeFactor: 0,
        color: '#e89040',
        opacity: 0.9,
        flow: 1.0,
        spacing: 0.04,
        adjustDensityByGap: true,
        hardness: 1.0,
        thickness: 0.51,
        thicknessVertical: true,
        customTipImage: solidSquareTip as unknown as HTMLImageElement,
        customTipAngle: 0,
        customTipAngleDynamics: 'direction',
        antiAlias: 1,
        usePressure: false,
        smoothing: true,
        stabilization: 0,
        grain: 0.89,
        textureDensity: 0.89,
        paperTextureImage: paperImg as unknown as HTMLImageElement,
        paperTextureMode: 'overlay',
        paperTextureScale: 1.0,
        paperTextureApplyEachPlot: false,
        useGpu: false,
      },
      'brush',
      'color'
    );

    // Sample alphas inside the stroke body: per-stroke texture MUST produce clear valley vs peak contrast
    let minBodyA = 255;
    let maxBodyA = 0;
    for (let y = 32; y <= 48; y++) {
      for (let x = 35; x <= 105; x++) {
        const a = surf.buf[(y * 140 + x) * 4 + 3];
        if (a < minBodyA) minBodyA = a;
        if (a > maxBodyA) maxBodyA = a;
      }
    }
    expect(maxBodyA).toBeGreaterThan(200);
    expect(maxBodyA - minBodyA).toBeGreaterThan(95);
  });

  it('parses fur blend.sut (Amount=0, Density=0, Stretch=100%, Thickness=135%, IntervalEffector) and visibly blends contrasting colors', async () => {
    const extracted: NativeSutExtract = {
      nodeName: 'fur blend',
      variantId: 856,
      variantValues: new Map<string, unknown>([
        ['brushsize', 36.2],
        ['opacity', 100],
        ['brushflow', 100],
        ['brushinterval', 30.9],
        ['brushautointervaltype', 0],
        ['brushintervaleffector', makeFakeEffector(0x10, 0, 100, [[0, 0.62], [1, 0]])],
        ['brushthickness', 135],
        ['brushverticalthicknes', 0],
        ['brushrotation', 0],
        ['brushrotationeffector', 67],
        ['brushusepatternimage', 0],
        ['brushusewatercolor', 1],
        ['brushwatercolor', 0],
        ['brushmixcolor', 0],
        ['brushmixalpha', 0],
        ['brushmixcolorextension', 100],
        ['brushopacityeffector', makeFakeEffector(0x10, 0, 100, [[0, 0], [1, 1]])],
        ['brushfloweffector', makeFakeEffector(0x10, 0, 100, [[0, 0.368], [0.3, 0.75], [1, 1]])],
      ]),
      materials: [],
    };

    const brush = await parseSutExtractedData(extracted, 'fur blend.sut');
    expect(brush.colorMixing).toBe(true);
    expect(brush.amountOfPaint).toBe(0);
    expect(brush.densityOfPaint).toBe(0);
    expect(brush.colorStretch).toBeCloseTo(1.0, 4);
    expect(brush.thickness).toBeCloseTo(1.35, 4);
    expect(brush.thicknessVertical).toBe(true);
    expect(brush.angle).toBe(0);
    expect(brush.intervalSensor?.usePressure).toBe(true);

    // Tall 56x300 tip with thickness=1.35 & thicknessVertical=true MUST fit inside BrushSize=36.2 (NOT 194px!)
    const dims = computeTipStampDimensions(36.2, 1.35, true, 56, 300);
    expect(dims.height).toBeCloseTo(36.2, 2);
    expect(dims.width).toBeCloseTo(36.2 * ((56 * 1.35) / 300), 2);

    // Multi-bristle tall rake tip (12x60 with 3 separated bristles)
    const rakeTip = createSoftwareCanvas(12, 60);
    for (let y = 0; y < 60; y++) {
      const inBristle = (y >= 4 && y <= 14) || (y >= 24 && y <= 34) || (y >= 44 && y <= 54);
      if (!inBristle) continue;
      for (let x = 1; x < 11; x++) {
        const i = (y * 12 + x) * 4;
        rakeTip.buf[i] = 255;
        rakeTip.buf[i + 1] = 255;
        rakeTip.buf[i + 2] = 255;
        rakeTip.buf[i + 3] = 255;
      }
    }

    // Paint left half BLACK (x < 90) and right half ORANGE (90 <= x < 180), blank canvas (x >= 180)
    const surf = createSoftwareCanvas(240, 100);
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 180; x++) {
        const i = (y * 240 + x) * 4;
        if (x < 90) {
          surf.buf[i] = 15;
          surf.buf[i + 1] = 15;
          surf.buf[i + 2] = 15;
          surf.buf[i + 3] = 255;
        } else {
          surf.buf[i] = 240;
          surf.buf[i + 1] = 150;
          surf.buf[i + 2] = 70;
          surf.buf[i + 3] = 255;
        }
      }
    }

    const sampler = new LayerPixelSampler(surf as unknown as HTMLCanvasElement);
    const pts: Point[] = [];
    for (let i = 0; i <= 18; i++) {
      pts.push({ x: 30 + i * 10, y: 50, pressure: 0.65, width: 42 });
    }
    renderCompleteStroke(
      surf.ctx,
      pts,
      {
        size: 42,
        minSizeFactor: 0,
        color: '#0000ff', // Foreground color MUST NOT leak when Amount=0!
        opacity: 1.0,
        flow: 1.0,
        spacing: 0.309,
        intervalSensor: { usePressure: true, pressureMin: 0, pressureCurve: [[0, 0.62], [1, 0]] },
        opacitySensor: { usePressure: true, pressureMin: 0, pressureCurve: [[0, 0], [1, 1]] },
        densitySensor: { usePressure: true, pressureMin: 0, pressureCurve: [[0, 0.368], [0.3, 0.75], [1, 1]] },
        hardness: 1.0,
        thickness: 1.35,
        thicknessVertical: true,
        customTipImage: rakeTip as unknown as HTMLImageElement,
        customTipAngle: 0,
        customTipAngleDynamics: 'direction',
        antiAlias: 1,
        usePressure: true,
        smoothing: true,
        stabilization: 0,
        colorMixing: true,
        perceptualMixing: false,
        amountOfPaint: 0,
        densityOfPaint: 0,
        colorStretch: 1.0,
        mixingMode: 'blend',
        useGpu: false,
      },
      'brush',
      'color',
      false,
      surf as unknown as HTMLCanvasElement,
      false,
      sampler
    );

    // 1. Inside orange region (x=115, y=50 center bristle), black MUST be visibly dragged into orange!
    const blendIdx = (50 * 240 + 115) * 4;
    expect(surf.buf[blendIdx]).toBeLessThan(185); // Visibly darkened from 240 orange (NOT imperceptible!)
    expect(surf.buf[blendIdx + 2]).toBeLessThan(120); // Zero blue foreground contamination!

    // 2. Out onto blank canvas (x=196, y=50), orange/blended paint MUST be visibly stretched onto blank area!
    const stretchIdx = (50 * 240 + 196) * 4;
    expect(surf.buf[stretchIdx + 3]).toBeGreaterThan(75);
  });

  it('prefers Rust-decoded full-resolution data/*.layer PNG over thumbnail.png and propagates isDualToneTip & dualVariantValues', async () => {
    const makeHeaderPng = (w: number, h: number) => {
      const buf = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
        0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      const dv = new DataView(buf.buffer);
      dv.setUint32(16, w, false);
      dv.setUint32(20, h, false);
      return buf;
    };

    const thumb64 = makeHeaderPng(64, 64);
    const full512Tip1 = makeHeaderPng(512, 512);
    const full512Tip2 = makeHeaderPng(512, 512);
    const full256Dual = makeHeaderPng(256, 256);

    const tip1Cat = '.:01:02:1111111111-2222-3333-4444-5555555555';
    const tip2Cat = '.:01:02:aaaaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee';
    const dualCat = '.:01:02:9999999999-8888-7777-6666-5555555555';

    const extracted: NativeSutExtract = {
      nodeName: 'DualTone Ribbon',
      nodeUuid: 'aabbccdd-1122-3344-5566-77889900abcd',
      variantId: 42,
      nodeInitVariantId: 43,
      variantValues: new Map<string, unknown>([
        ['brushsize', 28],
        ['brushusepatternimage', 1],
        ['brushpatternimagearray', new TextEncoder().encode(`${tip1Cat} ${tip2Cat}`)],
        ['usedualbrush', 1],
        ['dualbrushcompositemode', 2],
      ]),
      dualVariantValues: new Map<string, unknown>([
        ['brushsize', 14],
        ['brushinterval', 12],
        ['brushrotation', 45],
        ['brushpatternimagearray', new TextEncoder().encode(dualCat)],
      ]),
      materials: [
        {
          pwId: '1',
          originalPath: 'tip1.layer',
          catalogPath: tip1Cat,
          fileData: thumb64, // lower-res fallback blob
          decodedPng: full512Tip1, // full-res Rust decoded data/*.layer
          width: 512,
          height: 512,
          expressionColor: 'gray',
          isPaperTexture: false,
          hasSubColor: true,
          decodedFromLayer: true,
        },
        {
          pwId: '2',
          originalPath: 'tip2.layer',
          catalogPath: tip2Cat,
          fileData: thumb64,
          decodedPng: full512Tip2,
          width: 512,
          height: 512,
          expressionColor: 'color',
          isPaperTexture: false,
          hasSubColor: false,
          decodedFromLayer: true,
        },
        {
          pwId: '3',
          originalPath: 'dual.layer',
          catalogPath: dualCat,
          fileData: thumb64,
          decodedPng: full256Dual,
          width: 256,
          height: 256,
          expressionColor: 'monochrome',
          isPaperTexture: false,
          hasSubColor: false,
          decodedFromLayer: true,
        },
      ],
    };

    const brush = await parseSutExtractedData(extracted, 'DualTone Ribbon.sut');
    expect(brush.name).toBe('DualTone Ribbon');
    expect(brush.tipWidth).toBe(512);
    expect(brush.tipHeight).toBe(512);
    expect(brush.isColorTip).toBe(false);
    expect(brush.isDualToneTip).toBe(true);
    expect(brush.subTips).toHaveLength(2);
    expect(brush.subTips![0].width).toBe(512);
    expect(brush.subTips![0].isDualToneTip).toBe(true);
    expect(brush.subTips![0].isColor).toBe(false);
    expect(brush.subTips![1].width).toBe(512);
    expect(brush.subTips![1].isColor).toBe(true);
    expect(brush.subTips![1].isDualToneTip).toBe(false);
    expect(brush.dualBrush).toBe(true);
    expect(brush.dualBrushCompositeMode).toBe('darken');
    expect(brush.dualSize).toBe(14);
    expect(brush.dualSpacing).toBeCloseTo(0.12, 4);
    expect(brush.dualAngle).toBe(45);
    expect(brush.secondaryTipWidth).toBe(256);
    expect(brush.secondaryTipHeight).toBe(256);
  });

  it('decodes large BrushSize values accurately using BrushSizeUnit / BrushSizeSpecifiedByScreen without dividing >250px by 10', async () => {
    expect(decodeCspBrushSize(300, 0, 0)).toBe(300);
    expect(decodeCspBrushSize(1200, 0, 0)).toBe(1200);
    expect(decodeCspBrushSize(2000, 0, 0)).toBe(2000);
    expect(decodeCspBrushSize(3500, 0, 0)).toBe(350); // legacy tenth-px overflow (>2000)
    expect(decodeCspBrushSize(3000, 10, 0)).toBe(300); // explicit tenth-px unit

    const airbrush = await parseSutExtractedData(
      {
        nodeName: '300px Soft Airbrush',
        variantId: 1,
        variantValues: new Map<string, unknown>([
          ['brushsize', 300],
          ['brushsizeunit', 0],
          ['brushsizespecifiedbyscreen', 1],
        ]),
        materials: [],
      },
      'Airbrush.sut'
    );
    expect(airbrush.size).toBe(300);
    expect(airbrush.brushSizeUnit).toBe(0);
    expect(airbrush.brushSizeSpecifiedByScreen).toBe(true);
  });

  it('strictly separates BrushCombineMode (layer blend) from BlendBrushTips (within-stroke dab combine)', async () => {
    expect(mapCspBrushCombineMode(0)).toBe('normal');
    expect(mapCspBrushCombineMode(2)).toBe('multiply');
    expect(mapCspBrushCombineMode(10)).toBe('color-dodge-glow');
    expect(mapCspBrushCombineMode(11)).toBe('add');
    expect(mapCspBrushCombineMode(12)).toBe('add-glow');
    expect(mapCspBrushCombineMode(20)).toBe('hard-mix');
    expect(mapCspBrushCombineMode(26)).toBe('luminosity');
    expect(mapCspBrushCombineMode(27)).toBe('behind');
    expect(mapCspBrushCombineMode(28)).toBe('clear');
    expect(mapCspBrushCombineMode(29)).toBe('compare-density');
    expect(mapCspBrushCombineMode(36)).toBe('divide');

    const brush = await parseSutExtractedData(
      {
        nodeName: 'Multiply Behind Brush',
        variantId: 2,
        variantValues: new Map<string, unknown>([
          ['brushsize', 40],
          ['brushcombinemode', 2], // Multiply against layer
          ['blendbrushtips', 0], // Normal within-stroke dab accumulation
        ]),
        materials: [],
      },
      'Multiply.sut'
    );
    expect(brush.brushCombineMode).toBe('multiply');
    expect(brush.blendTipsMode).toBe('normal');

    const behindCompare = await parseSutExtractedData(
      {
        nodeName: 'Behind Compare Brush',
        variantId: 3,
        variantValues: new Map<string, unknown>([
          ['brushsize', 40],
          ['brushcombinemode', 27], // Behind
          ['blendbrushtips', 1], // Compare density within stroke
        ]),
        materials: [],
      },
      'Behind.sut'
    );
    expect(behindCompare.brushCombineMode).toBe('behind');
    expect(behindCompare.blendTipsMode).toBe('compare');
  });

  it('decodes per-source minimums, real CSP curve-length slots, and source bitmasks in parseCspEffector (44 & 48 byte headers)', () => {
    const makeRealCspEffector = (opts: {
      headerLen?: 44 | 48;
      supportedMask?: number;
      flags: number;
      pressureMin?: number;
      tiltMin?: number;
      velocityMin?: number;
      randomMin?: number;
      maxScale?: number;
      pressureCurve?: [number, number][];
      tiltCurve?: [number, number][];
      velocityCurve?: [number, number][];
    }) => {
      const headerLen = opts.headerLen ?? 48;
      const pBytes = opts.pressureCurve ? 12 + opts.pressureCurve.length * 16 : 0;
      const tBytes = opts.tiltCurve ? 12 + opts.tiltCurve.length * 16 : 0;
      const vBytes = opts.velocityCurve ? 12 + opts.velocityCurve.length * 16 : 0;
      const buf = new Uint8Array(headerLen + pBytes + tBytes + vBytes);
      const v = new DataView(buf.buffer);
      v.setUint32(0, headerLen, false);
      v.setUint32(4, opts.supportedMask ?? 0x1f0, false);
      v.setUint32(8, opts.flags, false);
      v.setInt32(12, opts.pressureMin ?? 0, false);
      v.setInt32(16, opts.tiltMin ?? 0, false);
      v.setInt32(20, opts.velocityMin ?? 0, false);
      v.setInt32(24, opts.randomMin ?? 0, false);
      v.setUint32(28, 0, false);
      if (headerLen >= 48) {
        v.setUint32(32, pBytes, false);
        v.setUint32(36, tBytes, false);
        v.setUint32(40, opts.maxScale ?? 100, false);
        v.setUint32(44, vBytes, false);
      }
      let off = headerLen;
      for (const pts of [opts.pressureCurve, opts.tiltCurve, opts.velocityCurve]) {
        if (!pts) continue;
        v.setUint32(off, 12, false);
        v.setUint32(off + 4, pts.length, false);
        v.setUint32(off + 8, 16, false);
        off += 12;
        for (const [x, y] of pts) {
          v.setFloat64(off, x, false);
          v.setFloat64(off + 8, y, false);
          off += 16;
        }
      }
      return buf;
    };

    const pCurve: [number, number][] = [[0, 0.1], [1, 1]];
    const tCurve: [number, number][] = [[0, 0.2], [0.5, 0.8], [1, 1]];
    const vCurve: [number, number][] = [[0, 1], [1, 0.3]];

    const fullBlob = makeRealCspEffector({
      headerLen: 48,
      flags: 0x10 | 0x20 | 0x40 | 0x80,
      pressureMin: 25,
      tiltMin: 40,
      velocityMin: 60,
      randomMin: 15,
      maxScale: 500, // 0x1f4 must NEVER trigger false invertTilt / invertVelocity!
      pressureCurve: pCurve,
      tiltCurve: tCurve,
      velocityCurve: vCurve,
    });

    const eff = parseCspEffector(fullBlob);
    expect(eff).not.toBeNull();
    expect(eff!.usePressure).toBe(true);
    expect(eff!.useTilt).toBe(true);
    expect(eff!.useVelocity).toBe(true);
    expect(eff!.useRandom).toBe(true);
    expect(eff!.pressureMin).toBeCloseTo(0.25, 4);
    expect(eff!.tiltMin).toBeCloseTo(0.4, 4);
    expect(eff!.velocityMin).toBeCloseTo(0.6, 4);
    expect(eff!.randomMin).toBeCloseTo(0.15, 4);
    expect(eff!.invertTilt).toBe(false);
    expect(eff!.invertVelocity).toBe(false);
    expect(eff!.pressureCurve).toEqual(pCurve);
    expect(eff!.tiltCurve).toEqual(tCurve);
    expect(eff!.velocityCurve).toEqual(vCurve);

    // Real CSP Tilt-only effector that still retains a disabled Pressure curve before the Tilt curve
    const tiltOnlyWithSavedP = makeRealCspEffector({
      headerLen: 48,
      flags: 0x20,
      pressureMin: 50,
      tiltMin: 35,
      maxScale: 150,
      pressureCurve: pCurve,
      tiltCurve: tCurve,
    });
    const effTilt = parseCspEffector(tiltOnlyWithSavedP);
    expect(effTilt).not.toBeNull();
    expect(effTilt!.usePressure).toBe(false);
    expect(effTilt!.useTilt).toBe(true);
    expect(effTilt!.tiltMin).toBeCloseTo(0.35, 4);
    expect(effTilt!.pressureCurve).toBeUndefined();
    expect(effTilt!.tiltCurve).toEqual(tCurve);

    // 44-byte compact header with Tilt + Velocity + explicit invertVelocity flag bit
    const compact44 = makeRealCspEffector({
      headerLen: 44,
      flags: 0x20 | 0x40 | 0x8000,
      tiltMin: 30,
      velocityMin: 50,
      tiltCurve: tCurve,
      velocityCurve: vCurve,
    });
    const eff44 = parseCspEffector(compact44);
    expect(eff44).not.toBeNull();
    expect(eff44!.usePressure).toBe(false);
    expect(eff44!.useTilt).toBe(true);
    expect(eff44!.useVelocity).toBe(true);
    expect(eff44!.tiltMin).toBeCloseTo(0.3, 4);
    expect(eff44!.velocityMin).toBeCloseTo(0.5, 4);
    expect(eff44!.invertTilt).toBe(false);
    expect(eff44!.invertVelocity).toBe(true);
    expect(eff44!.pressureCurve).toBeUndefined();
    expect(eff44!.tiltCurve).toEqual(tCurve);
    expect(eff44!.velocityCurve).toEqual(vCurve);
  });

  it('maps sub-tip order, thickness dynamics, and complete angle dynamics (integer bitmask + BLOB effector)', async () => {
    const orderCases: Array<[number, string]> = [
      [0, 'sequential'],
      [1, 'reverse'],
      [2, 'once'],
      [3, 'random'],
      [4, 'random-no-repeat'],
      [5, 'direction'],
    ];
    for (const [code, expected] of orderCases) {
      const b = await parseSutExtractedData({
        nodeName: `Order ${code}`,
        variantId: 10 + code,
        variantValues: new Map<string, unknown>([['brushpatternordertype', code]]),
        materials: [],
      });
      expect(b.subTipOrder).toBe(expected);
    }

    const angleBlob = makeFakeEffector(0x40 | 0x80, 20, 100, [[0, 0], [1, 1]]);
    const thickBlob = makeFakeEffector(0x10, 35, 100, [[0, 0.35], [1, 1]]);
    const blobBrush = await parseSutExtractedData({
      nodeName: 'Blob Angle & Thickness',
      variantId: 20,
      variantValues: new Map<string, unknown>([
        ['brushthicknesseffector', thickBlob],
        ['brushrotationeffector', angleBlob],
        ['brushrotationrandomscale', 65],
      ]),
      materials: [],
    });
    expect(blobBrush.thicknessSensor?.usePressure).toBe(true);
    expect(blobBrush.thicknessSensor?.pressureMin).toBeCloseTo(0.35, 4);
    expect(blobBrush.angleDynamics).toBe('direction-random');
    expect(blobBrush.angleSensor?.useVelocity).toBe(true);
    expect(blobBrush.angleSensor?.useRandom).toBe(true);
    expect(blobBrush.rotationRandomScale).toBeCloseTo(0.65, 4);

    // Real CSP integer BrushRotationEffector bitmask codes (low nibble 0x03)
    const rotCases: Array<[number, string]> = [
      [3, 'none'],               // 0x03 = Fixed angle
      [19, 'tilt'],              // 0x13 = Direction of pen (Tilt)
      [35, 'twist'],             // 0x23 = Rotation of pen axis
      [67, 'direction'],         // 0x43 = Direction of line
      [131, 'random'],           // 0x83 = Random
      [195, 'direction-random'], // 0xc3 = Direction + Random
      [259, 'initial-direction'],// 0x103 = Initial direction
      [6, 'initial-direction'],  // Legacy direct enum code
    ];
    for (const [code, expected] of rotCases) {
      const rb = await parseSutExtractedData({
        nodeName: `Rot ${code}`,
        variantId: 21 + code,
        variantValues: new Map<string, unknown>([['brushrotationeffector', code]]),
        materials: [],
      });
      expect(rb.angleDynamics).toBe(expected);
    }
  });

  it('maps Color Jitter, Color Mixing effectors, Ground Mixing, Blur, all 9 TextureCompositeMode values, and Extended Spray', async () => {
    const effP = makeFakeEffector(0x10, 15, 100, [[0, 0], [1, 1]]);
    const effV = makeFakeEffector(0x40, 25, 100, [[0, 0], [1, 1]]);
    const tinyPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xde, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const texCat = '.:09:11:1111111111-aaaa-bbbb-cccc-2222222222';

    const brush = await parseSutExtractedData({
      nodeName: 'Painterly Jitter Spray',
      variantId: 30,
      variantValues: new Map<string, unknown>([
        ['brushsize', 64],
        // Color Jitter
        ['brushchangebrushcolor', 1],
        ['brushchangecolorperstroke', 1],
        ['brushsubcolormix', 45],
        ['brushsubcolormixeffector', effP],
        ['brushrandomhue', 18],
        ['brushrandomhueeffector', effP],
        ['brushrandomsaturation', 30],
        ['brushrandomsaturationeffector', effV],
        ['brushrandomluminance', 22],
        ['brushrandomluminanceeffector', effP],
        // Color Mixing Effectors + Ground Mixing + Blur
        ['brushusewatercolor', 1],
        ['brushwatercolor', 3],
        ['brushmixcoloreffector', effP],
        ['brushmixalphaeffector', effP],
        ['brushmixcolorextensioneffector', effV],
        ['brushmixgroundcolor', 1],
        ['brushuseblur', 1],
        ['brushblur', 70],
        // Paper Texture Position + Offset + Mode
        ['textureimage', new TextEncoder().encode(texCat)],
        ['texturedensity', 80],
        ['texturecompositemode', 7], // height
        ['textureposition', 2], // stroke-flow
        ['textureoffsetx', 12],
        ['textureoffsety', -8],
        // Extended Spray
        ['brushusespray', 1],
        ['brushspraysize', 120],
        ['brushspraydensity', 18],
        ['brushsprayparticlesize', 14],
        ['brushspraylinksize', 1],
        ['brushspraysizeeffector', effP],
        ['brushspraydensityeffector', effV],
        ['brushspraydirection', 135],
        ['brushspraydirectioneffector', 67], // 0x43 = direction of line
        ['brushspraydeviation', -35],
      ]),
      materials: [
        { pwId: '1', originalPath: 'tex.layer', catalogPath: texCat, fileData: tinyPng },
      ],
    });

    // Color Jitter
    expect(brush.dynamics?.colorJitterEnabled).toBe(true);
    expect(brush.dynamics?.colorJitterPerStroke).toBe(true);
    expect(brush.dynamics?.foregroundBackgroundJitter).toBeCloseTo(0.45, 4);
    expect(brush.dynamics?.hueJitter).toBeCloseTo(0.18, 4);
    expect(brush.dynamics?.saturationJitter).toBeCloseTo(0.3, 4);
    expect(brush.dynamics?.brightnessJitter).toBeCloseTo(0.22, 4);
    expect(brush.dynamics?.subColorMixSensor?.usePressure).toBe(true);
    expect(brush.dynamics?.hueJitterSensor?.usePressure).toBe(true);
    expect(brush.dynamics?.saturationJitterSensor?.useVelocity).toBe(true);
    expect(brush.dynamics?.luminanceJitterSensor?.usePressure).toBe(true);

    // Color Mixing Effectors + Ground Mixing + Blur
    expect(brush.amountOfPaintSensor?.usePressure).toBe(true);
    expect(brush.densityOfPaintSensor?.usePressure).toBe(true);
    expect(brush.colorStretchSensor?.useVelocity).toBe(true);
    expect(brush.mixGroundColor).toBe(true);
    expect(brush.useBlur).toBe(true);
    expect(brush.blurStrength).toBeCloseTo(0.7, 4);
    expect(brush.mixingMode).toBe('smear');

    // Texture mode + position + offsets
    expect(brush.paperTextureMode).toBe('height');
    expect(brush.grainMappingMode).toBe('stroke-flow');
    expect(brush.paperTextureOffsetX).toBe(12);
    expect(brush.paperTextureOffsetY).toBe(-8);

    // Verify all 9 TextureCompositeMode enum values & alpha evaluation
    const allTexModes: Array<[number, CspPaperTextureMode]> = [
      [0, 'normal'],
      [1, 'multiply'],
      [2, 'subtract'],
      [3, 'compare'],
      [4, 'overlay'],
      [5, 'color-burn'],
      [6, 'linear-burn'],
      [7, 'height'],
      [8, 'outline'],
    ];
    for (const [idx, expectedMode] of allTexModes) {
      const tb = await parseSutExtractedData({
        nodeName: `Tex ${idx}`,
        variantId: 40 + idx,
        variantValues: new Map<string, unknown>([['texturecompositemode', idx]]),
        materials: [],
      });
      expect(tb.paperTextureMode).toBe(expectedMode);
      const a = applyCspPaperTextureAlpha(0.8, 0.4, 0.75, 0.5, expectedMode);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }

    // Extended Spray
    expect(brush.spray?.enabled).toBe(true);
    expect(brush.spray?.size).toBe(120);
    expect(brush.spray?.density).toBe(18);
    expect(brush.spray?.particleSize).toBe(14);
    expect(brush.spray?.linkSize).toBe(true);
    expect(brush.spray?.sizeSensor?.usePressure).toBe(true);
    expect(brush.spray?.densitySensor?.useVelocity).toBe(true);
    expect(brush.spray?.direction).toBe(135);
    expect(brush.spray?.directionDynamics).toBe('direction');
    expect(brush.spray?.deviation).toBeCloseTo(-0.35, 4);
    expect(brush.spray?.bias).toBeCloseTo(-0.35, 4);
  });

  it('parses full Dual Brush configuration merged from primary DualBrush* columns and dualVariantValues', async () => {
    const tinyPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02,
      0x08, 0x02, 0x00, 0x00, 0x00, 0xfd, 0xd4, 0x9a,
      0x73, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const dualTipA = '.:01:02:1111111111-1111-1111-1111-1111111111';
    const dualTipB = '.:01:02:2222222222-2222-2222-2222-2222222222';

    const brush = await parseSutExtractedData({
      nodeName: 'Full Dual Brush',
      variantId: 50,
      variantValues: new Map<string, unknown>([
        ['brushsize', 80],
        ['usedualbrush', 1],
        ['dualbrushcompositemode', 11], // overlay
        ['dualbrushlinksize', 1],
        ['dualbrushhardness', 3], // discrete 3 -> 0.6
        ['dualbrushdensity', 65],
        ['dualbrushpatternordertype', 4], // random-no-repeat
        ['dualbrushfliph', 3], // random
        ['dualbrushflipv', 1], // alternate
        ['dualbrushribbon', 1],
        ['dualbrushusespray', 1],
        ['dualbrushspraysize', 45],
        ['dualbrushspraydensity', 12],
        ['dualbrushsprayparticlesize', 8],
      ]),
      dualVariantValues: new Map<string, unknown>([
        ['brushsize', 320], // >250px must remain 320px!
        ['brushautointervaltype', 3], // Wide -> 0.22
        ['brushthickness', 60],
        ['brushverticalthicknes', 1], // Vertical -> thicknessVertical=false
        ['brushrotation', 25],
        ['brushrotationeffector', 5], // twist
        ['brushpatternimagearray', new TextEncoder().encode(`${dualTipA} ${dualTipB}`)],
      ]),
      materials: [
        { pwId: '1', originalPath: 'a.layer', catalogPath: dualTipA, fileData: tinyPng },
        { pwId: '2', originalPath: 'b.layer', catalogPath: dualTipB, fileData: tinyPng },
      ],
    });

    expect(brush.dualBrush).toBe(true);
    expect(brush.dualBrushCompositeMode).toBe('overlay');
    expect(brush.dualSize).toBe(320);
    expect(brush.dualLinkSize).toBe(true);
    expect(brush.dualSpacing).toBeCloseTo(0.22, 4);
    expect(brush.dualThickness).toBeCloseTo(0.6, 4);
    expect(brush.dualThicknessVertical).toBe(false);
    expect(brush.dualAngle).toBe(25);
    expect(brush.dualAngleDynamics).toBe('twist');
    expect(brush.dualHardness).toBeCloseTo(0.6, 4);
    expect(brush.dualDensity).toBeCloseTo(0.65, 4);
    expect(brush.dualSubTipOrder).toBe('random-no-repeat');
    expect(brush.dualFlipH).toBe('random');
    expect(brush.dualFlipV).toBe('alternate');
    expect(brush.dualIsRibbon).toBe(true);
    expect(brush.dualSpray?.enabled).toBe(true);
    expect(brush.dualSpray?.size).toBe(45);
    expect(brush.dualSpray?.density).toBe(12);
    expect(brush.dualSpray?.particleSize).toBe(8);
    expect(brush.dualSubTips).toHaveLength(2);
    expect(brush.secondaryTipDataUrl).toBeDefined();
  });

  it('distinguishes discrete 1..5 hardness vs 0..100% and normalizes wetEdgeAlphaPower/wetEdgeValuePower to 0..1 across parser and renderer', async () => {
    expect(decodeCspHardness(1)).toBeCloseTo(0.2, 4);
    expect(decodeCspHardness(3)).toBeCloseTo(0.6, 4);
    expect(decodeCspHardness(5)).toBeCloseTo(1.0, 4);
    expect(decodeCspHardness(50)).toBeCloseTo(0.5, 4);
    expect(decodeCspHardness(100)).toBeCloseTo(1.0, 4);
    expect(decodeCspHardness(0.75)).toBeCloseTo(0.75, 4);

    const brush = await parseSutExtractedData({
      nodeName: 'Watercolor Rim Brush',
      variantId: 60,
      variantValues: new Map<string, unknown>([
        ['brushhardness', 4], // discrete 4 -> 0.8
        ['brushusewateredge', 1],
        ['brushwateredgeradius', 4.5],
        ['brushwateredgealphapower', 40],
        ['brushwateredgevaluepower', 25],
      ]),
      materials: [],
    });

    expect(brush.hardness).toBeCloseTo(0.8, 4);
    expect(brush.wetEdgeRadius).toBeCloseTo(4.5, 4);
    expect(brush.wetEdgeAlphaPower).toBeCloseTo(0.4, 4);
    expect(brush.wetEdgeValuePower).toBeCloseTo(0.25, 4);
    expect(brush.wetEdge).toBeCloseTo(0.4, 4);

    // Defensive normalization in applyCspWatercolorEdge: legacy 0..100 values produce identical pixels to 0..1
    const makeImg = () => {
      const w = 16, h = 16;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 3; y < 13; y++) {
        for (let x = 3; x < 13; x++) {
          const i = (y * w + x) * 4;
          data[i] = 180;
          data[i + 1] = 120;
          data[i + 2] = 90;
          data[i + 3] = 170;
        }
      }
      return { data, width: w, height: h };
    };
    const imgNorm = makeImg();
    const imgLegacy = makeImg();
    applyCspWatercolorEdge(imgNorm, 0.8, 2, 0.4, 0.25);
    applyCspWatercolorEdge(imgLegacy, 0.8, 2, 40, 25);
    expect(Array.from(imgLegacy.data)).toEqual(Array.from(imgNorm.data));
  });

  it('records clear importWarnings for missing external CatalogPath materials without crashing or hijacking paper texture as tip', async () => {
    const tinyPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xde, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const embeddedPaperCat = '.:Install:Paper:embedded-paper-001';
    const missingTipCat = '.:Install:BrushTip:external-missing-nib';
    const missingTexCat = '.:Install:PaperTexture:external-missing-grain';

    const brushWithEmbeddedPaper = await parseSutExtractedData({
      nodeName: 'External Tip With Embedded Paper',
      variantId: 70,
      variantValues: new Map<string, unknown>([
        ['brushusepatternimage', 1],
        ['brushpatternimagearray', new TextEncoder().encode(missingTipCat)],
        ['textureimage', new TextEncoder().encode(embeddedPaperCat)],
        ['texturedensity', 55],
      ]),
      materials: [
        {
          pwId: '1',
          originalPath: 'paper.layer',
          catalogPath: embeddedPaperCat,
          fileData: tinyPng,
          isPaperTexture: true,
        },
      ],
    });
    expect(brushWithEmbeddedPaper.tipDataUrl).toBeUndefined(); // Clean procedural fallback, NEVER paper texture!
    expect(brushWithEmbeddedPaper.paperTexture).toBeDefined();
    expect(brushWithEmbeddedPaper.importWarnings).toBeDefined();
    expect(brushWithEmbeddedPaper.importWarnings!.some((w) => w.includes(missingTipCat))).toBe(true);

    const brushMissingTex = await parseSutExtractedData({
      nodeName: 'External Texture Missing',
      variantId: 71,
      variantValues: new Map<string, unknown>([
        ['brushusepatternimage', 0],
        ['textureimage', new TextEncoder().encode(missingTexCat)],
        ['texturedensity', 70],
      ]),
      materials: [],
    });
    expect(brushMissingTex.paperTexture).toBeUndefined();
    expect(brushMissingTex.textureDensity).toBe(0);
    expect(brushMissingTex.importWarnings).toBeDefined();
    expect(brushMissingTex.importWarnings!.some((w) => w.includes(missingTexCat))).toBe(true);
  });

  it('persists all newly mapped CSP brush fields across preset switches and brushStorage hydration', async () => {
    const effP = makeFakeEffector(0x10, 20, 100, [[0, 0], [1, 1]]);
    const imported = await parseSutExtractedData({
      nodeName: 'Full Parity Persistence Brush',
      variantId: 80,
      variantValues: new Map<string, unknown>([
        ['brushsize', 310],
        ['brushsizeunit', 0],
        ['brushsizespecifiedbyscreen', 1],
        ['brushcombinemode', 29], // compare-density
        ['blendbrushtips', 0], // normal
        ['brushpatternordertype', 4], // random-no-repeat
        ['brushthicknesseffector', effP],
        ['brushmixcoloreffector', effP],
        ['brushmixalphaeffector', effP],
        ['brushmixcolorextensioneffector', effP],
        ['brushmixgroundcolor', 1],
        ['brushuseblur', 1],
        ['brushblur', 45],
        ['texturecompositemode', 5], // color-burn
        ['textureposition', 3], // random-per-stroke
        ['textureoffsetx', 24],
        ['textureoffsety', -16],
        ['brushchangebrushcolor', 1],
        ['brushchangecolorperstroke', 1],
        ['brushrandomhue', 30],
        ['usedualbrush', 1],
        ['dualbrushcompositemode', 11],
        ['dualbrushsize', 180],
        ['dualbrushlinksize', 1],
        ['dualbrushhardness', 4],
        ['dualbrushdensity', 75],
        ['dualbrushpatternordertype', 2], // once
        ['dualbrushfliph', 3],
        ['dualbrushflipv', 1],
        ['dualbrushribbon', 1],
      ]),
      materials: [],
    });

    const hydrated = await prepareBrushSettingsForCsp(imported);
    expect(hydrated.size).toBe(310);
    expect(hydrated.brushSizeSpecifiedByScreen).toBe(true);
    expect(hydrated.brushCombineMode).toBe('compare-density');
    expect(hydrated.blendTipsMode).toBe('normal');
    expect(hydrated.subTipOrder).toBe('random-no-repeat');
    expect(hydrated.thicknessSensor?.usePressure).toBe(true);
    expect(hydrated.amountOfPaintSensor?.usePressure).toBe(true);
    expect(hydrated.densityOfPaintSensor?.usePressure).toBe(true);
    expect(hydrated.colorStretchSensor?.usePressure).toBe(true);
    expect(hydrated.mixGroundColor).toBe(true);
    expect(hydrated.useBlur).toBe(true);
    expect(hydrated.blurStrength).toBeCloseTo(0.45, 4);
    expect(hydrated.paperTextureMode).toBe('color-burn');
    expect(hydrated.grainMappingMode).toBe('random-per-stroke');
    expect(hydrated.paperTextureOffsetX).toBe(24);
    expect(hydrated.paperTextureOffsetY).toBe(-16);
    expect(hydrated.dynamics?.colorJitterPerStroke).toBe(true);
    expect(hydrated.dualSize).toBe(180);
    expect(hydrated.dualLinkSize).toBe(true);
    expect(hydrated.dualHardness).toBeCloseTo(0.8, 4);
    expect(hydrated.dualDensity).toBeCloseTo(0.75, 4);
    expect(hydrated.dualSubTipOrder).toBe('once');
    expect(hydrated.dualFlipH).toBe('random');
    expect(hydrated.dualFlipV).toBe('alternate');
    expect(hydrated.dualIsRibbon).toBe(true);

    // Save overridden values through brushPresetManager and read back via getEffectiveBrushSettings
    saveBrushSettingsImmediately(imported.id, {
      ...hydrated,
      brushCombineMode: 'behind',
      subTipOrder: 'once',
      mixGroundColor: false,
      paperTextureOffsetX: 99,
      dualLinkSize: false,
    });
    const reloaded = getEffectiveBrushSettings(imported.id, [imported]);
    expect(reloaded.brushCombineMode).toBe('behind');
    expect(reloaded.subTipOrder).toBe('once');
    expect(reloaded.mixGroundColor).toBe(false);
    expect(reloaded.paperTextureOffsetX).toBe(99);
    expect(reloaded.dualLinkSize).toBe(false);
    expect(reloaded.thicknessSensor?.usePressure).toBe(true);
    expect(reloaded.amountOfPaintSensor?.usePressure).toBe(true);
    expect(reloaded.dualIsRibbon).toBe(true);
  });

  it('parses ザッサラ絵筆油彩風.sut (0x90=Pressure+Random opacity, RotEff=3 fixed 218° angle, ThicknessEffector) with CSP width/opacity/angle parity on CPU & GPU', async () => {
    const buildCspEffector = (opts: {
      supportedMask: number;
      flags: number;
      pMin?: number;
      tMin?: number;
      vMin?: number;
      rMin?: number;
      maxScale?: number;
      pCurve?: [number, number][];
      tCurve?: [number, number][];
      vCurve?: [number, number][];
    }) => {
      const pBytes = opts.pCurve ? 12 + opts.pCurve.length * 16 : 0;
      const tBytes = opts.tCurve ? 12 + opts.tCurve.length * 16 : 0;
      const vBytes = opts.vCurve ? 12 + opts.vCurve.length * 16 : 0;
      const buf = new Uint8Array(48 + pBytes + tBytes + vBytes);
      const v = new DataView(buf.buffer);
      v.setUint32(0, 48, false);
      v.setUint32(4, opts.supportedMask, false);
      v.setUint32(8, opts.flags, false);
      v.setInt32(12, opts.pMin ?? 0, false);
      v.setInt32(16, opts.tMin ?? 0, false);
      v.setInt32(20, opts.vMin ?? 0, false);
      v.setInt32(24, opts.rMin ?? 0, false);
      v.setUint32(28, 0, false);
      v.setUint32(32, pBytes, false);
      v.setUint32(36, tBytes, false);
      v.setUint32(40, opts.maxScale ?? 100, false);
      v.setUint32(44, vBytes, false);
      let off = 48;
      for (const pts of [opts.pCurve, opts.tCurve, opts.vCurve]) {
        if (!pts) continue;
        v.setUint32(off, 12, false);
        v.setUint32(off + 4, pts.length, false);
        v.setUint32(off + 8, 16, false);
        off += 12;
        for (const [x, y] of pts) {
          v.setFloat64(off, x, false);
          v.setFloat64(off + 8, y, false);
          off += 16;
        }
      }
      return buf;
    };

    // Exact Variant 800 blobs from ザッサラ絵筆油彩風.sut
    const sizeEff = buildCspEffector({
      supportedMask: 0x1f0,
      flags: 0x10,
      pMin: 0,
      vMin: 60,
      rMin: 67,
      pCurve: [[0, 0], [1, 1]],
    });
    const opacityEff = buildCspEffector({
      supportedMask: 0x0f0,
      flags: 0x90, // 0x10 (Pressure) | 0x80 (Random) — NOT Velocity!
      pMin: 0,
      rMin: 90,
      pCurve: [[0, 0], [0.5182, 0.6909], [1, 1]],
    });
    const flowEff = buildCspEffector({
      supportedMask: 0x1f0,
      flags: 0x10, // Pressure only, with a saved inactive Tilt curve
      pMin: 20,
      tMin: 100,
      vMin: 90,
      maxScale: 500,
      pCurve: [[0, 0], [1, 1]],
      tCurve: [[0, 1], [0.5, 1], [0.8, 0], [1, 0]],
    });
    const thicknessEff = buildCspEffector({
      supportedMask: 0x1f0,
      flags: 0x10,
      pMin: 0,
      pCurve: [[0, 0], [0.9909, 0], [1, 1]],
    });
    const mixAlphaEff = buildCspEffector({
      supportedMask: 0x1f0,
      flags: 0x10,
      pMin: 0,
      pCurve: [[0, 0], [1, 1]],
    });

    const brush = await parseSutExtractedData({
      nodeName: 'ザッサラ絵筆油彩風',
      variantId: 800,
      variantValues: new Map<string, unknown>([
        ['brushsize', 66.7],
        ['brushsizeeffector', sizeEff],
        ['opacity', 100],
        ['brushopacityeffector', opacityEff],
        ['brushflow', 100],
        ['brushfloweffector', flowEff],
        ['brushadjustflowbyinterval', 0],
        ['brushinterval', 1.8],
        ['brushautointervaltype', 0],
        ['brushhardness', 95],
        ['brushthickness', 100],
        ['brushverticalthicknes', 1],
        ['brushthicknesseffector', thicknessEff],
        ['brushrotation', 218.0],
        ['brushrotationeffector', 3], // 0x03 = Fixed angle (None), NOT direction!
        ['brushrotationrandomscale', 100],
        ['brushusepatternimage', 0],
        ['brushusewatercolor', 1],
        ['brushwatercolor', 0],
        ['brushmixcolor', 55],
        ['brushmixalpha', 100],
        ['brushmixalphaeffector', mixAlphaEff],
        ['brushmixcolorextension', 35],
        ['brushusewateredge', 1],
        ['brushwateredgeradius', 1.8],
        ['brushwateredgealphapower', 8],
        ['brushwateredgevaluepower', 25],
      ]),
      materials: [],
    });

    // 1. Verify exact CSP sensor & rotation decoding
    expect(brush.opacitySensor?.usePressure).toBe(true);
    expect(brush.opacitySensor?.useRandom).toBe(true);
    expect(brush.opacitySensor?.randomMin).toBeCloseTo(0.9, 4);
    expect(brush.opacitySensor?.useVelocity).toBe(false);
    expect(brush.opacitySensor?.pressureCurve).toEqual([[0, 0], [0.5182, 0.6909], [1, 1]]);
    expect(brush.densitySensor?.usePressure).toBe(true);
    expect(brush.densitySensor?.pressureMin).toBeCloseTo(0.2, 4);
    expect(brush.densitySensor?.useTilt).toBe(false);
    expect(brush.densitySensor?.tiltCurve).toBeUndefined();
    expect(brush.angle).toBe(218);
    expect(brush.angleDynamics).toBe('none');
    expect(brush.rotationRandomScale).toBe(0);
    expect(brush.thickness).toBeCloseTo(1.0, 4);
    expect(brush.thicknessVertical).toBe(false);
    expect(brush.thicknessSensor?.usePressure).toBe(true);

    // 2. Render light vs heavy vertical strokes (matching CSP Photo 1 Strokes 1 & 2) with vertical bristle tip
    const bristleTip = createSoftwareCanvas(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 2; x < 62; x++) {
        // Dense vertical bristles across the tip width
        const ridge = 0.55 + 0.45 * Math.cos((x / 64) * Math.PI * 14);
        const i = (y * 64 + x) * 4;
        bristleTip.buf[i] = 255;
        bristleTip.buf[i + 1] = 255;
        bristleTip.buf[i + 2] = 255;
        bristleTip.buf[i + 3] = Math.round(ridge * 255);
      }
    }

    const baseSettings: BrushSettings = {
      size: brush.size,
      minSizeFactor: brush.minSizeFactor,
      color: '#ff2400',
      opacity: brush.opacity,
      flow: brush.flow,
      adjustDensityByGap: brush.adjustDensityByGap,
      spacing: brush.spacing,
      hardness: brush.hardness,
      thickness: brush.thickness,
      thicknessVertical: brush.thicknessVertical,
      thicknessSensor: brush.thicknessSensor,
      customTipImage: bristleTip as unknown as HTMLImageElement,
      customTipAngle: brush.angle,
      customTipAngleDynamics: brush.angleDynamics,
      customTipRotationRandomScale: brush.rotationRandomScale,
      antiAlias: 1,
      usePressure: brush.usePressure,
      pressureCurve: brush.pressureCurve,
      sizeSensor: brush.sizeSensor,
      opacitySensor: brush.opacitySensor,
      densitySensor: brush.densitySensor,
      densityOfPaintSensor: brush.densityOfPaintSensor,
      smoothing: true,
      stabilization: 0,
      colorMixing: true,
      perceptualMixing: false,
      amountOfPaint: brush.amountOfPaint,
      densityOfPaint: brush.densityOfPaint,
      colorStretch: brush.colorStretch,
      mixingMode: brush.mixingMode,
      useGpu: false,
    };

    const surf = createSoftwareCanvas(240, 220);
    const sampler = new LayerPixelSampler(surf as unknown as HTMLCanvasElement);
    // Stroke 1: Light pressure vertical stroke (x=60)
    const lightPts: Point[] = [];
    for (let i = 0; i <= 14; i++) {
      lightPts.push({ x: 60, y: 30 + i * 10, pressure: 0.25, width: 66.7 * 0.25 });
    }
    renderCompleteStroke(surf.ctx, lightPts, baseSettings, 'brush', 'color', false, surf as unknown as HTMLCanvasElement, false, sampler);

    // Stroke 2: Heavy pressure vertical stroke (x=160), ending with a longer catch-up segment (must NOT create a dark end-dot!)
    const heavyPts: Point[] = [];
    for (let i = 0; i <= 12; i++) {
      heavyPts.push({ x: 160, y: 30 + i * 10, pressure: 0.85, width: 66.7 * 0.85 });
    }
    heavyPts.push({ x: 160, y: 175, pressure: 0.85, width: 66.7 * 0.85 }); // Longer final segment simulating stabilizer catch-up
    renderCompleteStroke(surf.ctx, heavyPts, baseSettings, 'brush', 'color', false, surf as unknown as HTMLCanvasElement, false, sampler);

    const measureRowWidth = (y: number, xStart: number, xEnd: number, thresh = 30) => {
      let minX = xEnd;
      let maxX = xStart;
      let maxA = 0;
      for (let x = xStart; x <= xEnd; x++) {
        const a = surf.buf[(y * 240 + x) * 4 + 3];
        if (a > maxA) maxA = a;
        if (a >= thresh) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
      return { width: maxX >= minX ? maxX - minX + 1 : 0, maxA };
    };

    const lightMid = measureRowWidth(100, 20, 100);
    const heavyMid = measureRowWidth(100, 110, 210);
    const heavyEnd = measureRowWidth(160, 110, 210);

    // Heavy vertical stroke must be wide (~42-50px) and bold/opaque (>220), far wider & denser than light stroke!
    expect(heavyMid.width).toBeGreaterThan(38);
    expect(heavyMid.width).toBeGreaterThan(lightMid.width * 2.2);
    expect(heavyMid.maxA).toBeGreaterThan(220);
    expect(lightMid.maxA).toBeGreaterThan(40);
    expect(lightMid.maxA).toBeLessThan(heavyMid.maxA - 30);
    // Mid-stroke must already be fully dense (no washed-out body + dark end-dot!)
    expect(Math.abs(heavyMid.maxA - heavyEnd.maxA)).toBeLessThan(25);

    // 3. Fixed 218° angle chisel anisotropy: `/` stroke (perpendicular to 218°) is wider than `\` stroke (parallel to 218°)
    const diagSurf = createSoftwareCanvas(220, 140);
    const diagSampler = new LayerPixelSampler(diagSurf as unknown as HTMLCanvasElement);
    const slashPts: Point[] = []; // top-right to bottom-left `/` (~125°)
    const backslashPts: Point[] = []; // top-left to bottom-right `\` (~38°)
    for (let i = 0; i <= 10; i++) {
      const u = i / 10;
      slashPts.push({ x: 85 - u * 45, y: 25 + u * 85, pressure: 0.8, width: 66.7 * 0.8 });
      backslashPts.push({ x: 130 + u * 65, y: 35 + u * 50, pressure: 0.8, width: 66.7 * 0.8 });
    }
    renderCompleteStroke(diagSurf.ctx, slashPts, baseSettings, 'brush', 'color', false, diagSurf as unknown as HTMLCanvasElement, false, diagSampler);
    renderCompleteStroke(diagSurf.ctx, backslashPts, baseSettings, 'brush', 'color', false, diagSurf as unknown as HTMLCanvasElement, false, diagSampler);

    let slashLit = 0;
    let backslashLit = 0;
    for (let y = 0; y < 140; y++) {
      for (let x = 0; x < 110; x++) {
        if (diagSurf.buf[(y * 220 + x) * 4 + 3] > 60) slashLit++;
      }
      for (let x = 110; x < 220; x++) {
        if (diagSurf.buf[(y * 220 + x) * 4 + 3] > 60) backslashLit++;
      }
    }
    expect(slashLit).toBeGreaterThan(backslashLit * 1.5);

    // 4. GPU dab emission parity: thicknessSensor floor (0.10), fixed 218° angle, and velocity-free opacity match CPU path
    const gpuDabs: GpuDab[] = [];
    const p0: Point = { x: 20, y: 20, pressure: 0.8, width: 66.7 * 0.8 };
    const p3: Point = { x: 20, y: 120, pressure: 0.8, width: 66.7 * 0.8 };
    const c1: Point = { x: 20, y: 53, pressure: 0.8, width: 66.7 * 0.8 };
    const c2: Point = { x: 20, y: 86, pressure: 0.8, width: 66.7 * 0.8 };
    drawBrushCubicBezierSegment(
      surf.ctx,
      p0,
      c1,
      c2,
      p3,
      '#ff2400',
      {
        size: brush.size,
        minSizeFactor: brush.minSizeFactor,
        opacity: 1.0,
        flow: 1.0,
        spacing: 0.1,
        thickness: brush.thickness,
        thicknessVertical: brush.thicknessVertical,
        thicknessSensor: brush.thicknessSensor,
        angle: brush.angle,
        angleDynamics: brush.angleDynamics,
        opacitySensor: brush.opacitySensor,
        densitySensor: brush.densitySensor,
        colorMixing: false,
      },
      0,
      { count: 0 },
      gpuDabs
    );
    expect(gpuDabs.length).toBeGreaterThan(5);
    const sampleDab = gpuDabs[Math.floor(gpuDabs.length / 2)];
    // Fixed 218° angle in radians
    expect(sampleDab.angle).toBeCloseTo((218 * Math.PI) / 180, 4);
    // CSP 10% thickness floor on height (not 5%!)
    expect(sampleDab.height / sampleDab.width).toBeCloseTo(0.1, 2);
    // Opacity driven by Pressure + Random(0.9..1.0), NOT crushed by fake velocity!
    expect(sampleDab.alpha).toBeGreaterThan(0.65);
  });

  it('calibrates Oil Pastel (오일 파스텔.sut): steep BrushSizeEffector never causes detached start dots on CPU or GPU, and asymmetric flow/density curves ramp smoothly', async () => {
    const tinyPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xde, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const tipCat = '.:07:55:10fc7c53ef-f34e-a4a3-6239-75669202b9';
    const texCat = '.:10:41:0871fa2caf-d14c-e5b9-c3a7-d1a5d077a2';

    const sizeCurve: [number, number][] = [[0, 0], [0.0043, 1.0], [1.0, 1.0]];
    const flowCurve: [number, number][] = [[0, 0], [0.0043, 0], [0.6379, 0.1928], [1.0, 1.0]];
    const mixColorCurve: [number, number][] = [[0, 0], [1.0, 1.0]];
    const mixAlphaCurve: [number, number][] = [[0, 0], [0.8491, 0.1285], [1.0, 1.0]];

    const extracted: NativeSutExtract = {
      nodeName: '오일 파스텔',
      variantId: 840,
      variantValues: new Map<string, unknown>([
        ['brushsize', 149.8],
        ['brushsizeunit', 0],
        ['brushsizeeffector', makeFakeEffector(0x10, 0, 100, sizeCurve)],
        ['opacity', 100],
        ['brushflow', 100],
        ['brushfloweffector', makeFakeEffector(0x10, 0, 100, flowCurve)],
        ['brushadjustflowbyinterval', 0],
        ['brushautointervaltype', 0],
        ['brushinterval', 7.0],
        ['brushhardness', 100],
        ['brushthickness', 100],
        ['brushverticalthicknes', 0],
        ['brushrotation', 0],
        ['brushrotationeffector', 3],
        ['antialias', 1],
        ['brushusepatternimage', 1],
        ['brushpatternimagearray', new TextEncoder().encode(tipCat)],
        ['textureimage', new TextEncoder().encode(texCat)],
        ['texturedensity', 52],
        ['texturecompositemode', 2], // Subtract
        ['textureforplot', 1],
        ['texturescale2', 100.0],
        ['brushusewatercolor', 1],
        ['brushusewatercolor2', 1],
        ['brushwatercolor', 0], // Blend
        ['brushcolormixingmode', 0], // Standard RGB
        ['brushmixcolor', 30],
        ['brushmixcoloreffector', makeFakeEffector(0x10, 0, 100, mixColorCurve)],
        ['brushmixalpha', 100],
        ['brushmixalphaeffector', makeFakeEffector(0x10, 0, 100, mixAlphaCurve)],
        ['brushmixcolorextension', 10],
        ['brushusein', 1],
        ['brushuseout', 1],
        ['brushinouttype', 0], // Taper OFF
      ]),
      materials: [
        { pwId: '1', originalPath: `${texCat}:data:material_0.layer`, catalogPath: texCat, fileData: tinyPng, isPaperTexture: true },
        { pwId: '2', originalPath: `${tipCat}:data:material_0.layer`, catalogPath: tipCat, fileData: tinyPng, isPaperTexture: false },
      ],
    };

    const brush = await parseSutExtractedData(extracted, '오일 파스텔.sut');
    expect(brush.size).toBeCloseTo(149.8, 2);
    expect(brush.spacing).toBeCloseTo(0.07, 4);
    expect(brush.adjustDensityByGap).toBe(false);
    expect(brush.colorMixing).toBe(true);
    expect(brush.perceptualMixing).toBe(false);
    expect(brush.amountOfPaint).toBeCloseTo(0.3, 4);
    expect(brush.densityOfPaint).toBeCloseTo(1.0, 4);
    expect(brush.colorStretch).toBeCloseTo(0.1, 4);
    expect(brush.paperTextureMode).toBe('subtract');
    expect(brush.paperTextureApplyEachPlot).toBe(true);
    expect(brush.taper).toBeUndefined();
    expect(brush.pressureCurve).toEqual(sizeCurve);
    expect(brush.densitySensor?.pressureCurve).toEqual(flowCurve);
    expect(brush.densityOfPaintSensor?.pressureCurve).toEqual(mixAlphaCurve);

    // 1. Weighted harmonic mean PCHIP preserves smooth light-pressure ramps on asymmetric steep-tail curves
    // (previously arithmetic mean + clamping crushed y(0.25) to ~0.006 on BrushMixAlphaEffector!)
    const mixAlphaAt25 = evaluateFastSpline(0.25, mixAlphaCurve);
    const flowAt30 = evaluateFastSpline(0.3, flowCurve);
    expect(mixAlphaAt25).toBeGreaterThan(0.02);
    expect(mixAlphaAt25).toBeLessThan(0.12);
    expect(flowAt30).toBeGreaterThan(0.035);
    expect(flowAt30).toBeLessThan(0.15);
    // Strict monotonicity across full [0, 1] range
    let prevY = 0;
    for (let i = 0; i <= 100; i++) {
      const y = evaluateFastSpline(i / 100, mixAlphaCurve);
      expect(y).toBeGreaterThanOrEqual(prevY - 1e-6);
      prevY = y;
    }

    // 2. Regression check for detached start dot (CPU SpatialTipMixer + GPU drawBrushDot parity):
    // Even though BrushSizeEffector(0.05) === 1.0, drawBrushDot MUST pass raw pressure (0.05) — NOT 1.0 —
    // to densitySensor / densityOfPaintSensor / amountOfPaintSensor!
    const surf = createSoftwareCanvas(160, 220);
    const sampler = new LayerPixelSampler(surf as unknown as HTMLCanvasElement);
    const pastelSettings: BrushSettings = {
      size: 36,
      minSizeFactor: 0,
      color: '#ff1800',
      opacity: 1.0,
      flow: 1.0,
      spacing: 0.07,
      adjustDensityByGap: false,
      hardness: 1.0,
      thickness: 1.0,
      thicknessVertical: true,
      customTipAngle: 0,
      customTipAngleDynamics: 'none',
      antiAlias: 1,
      usePressure: true,
      smoothing: true,
      stabilization: 0,
      pressureCurve: sizeCurve,
      densitySensor: brush.densitySensor,
      amountOfPaintSensor: brush.amountOfPaintSensor,
      densityOfPaintSensor: brush.densityOfPaintSensor,
      colorMixing: true,
      perceptualMixing: false,
      amountOfPaint: 0.3,
      densityOfPaint: 1.0,
      colorStretch: 0.1,
      mixingMode: 'blend',
      useGpu: false,
    };

    // Pressure-ramping stroke starting at very light touchdown (p=0.05) -> ramping up to max (p=0.98)
    const rampPts: Point[] = [];
    for (let i = 0; i <= 16; i++) {
      const u = i / 16;
      const p = 0.05 + 0.93 * u;
      rampPts.push({ x: 80, y: 24 + i * 11, pressure: p, width: 36 });
    }
    renderCompleteStroke(
      surf.ctx,
      rampPts,
      pastelSettings,
      'brush',
      'color',
      false,
      surf as unknown as HTMLCanvasElement,
      false,
      sampler
    );

    const startDotA = surf.buf[(24 * 160 + 80) * 4 + 3];
    const earlyA = surf.buf[(57 * 160 + 80) * 4 + 3];
    const midA = surf.buf[(123 * 160 + 80) * 4 + 3];
    const maxA = surf.buf[(189 * 160 + 80) * 4 + 3];

    // Standalone single touchdown dot at p=0.05 must be virtually invisible (<= 6/255)
    const dotSurf = createSoftwareCanvas(96, 96);
    renderCompleteStroke(
      dotSurf.ctx,
      [{ x: 48, y: 48, pressure: 0.05, width: 36 }],
      pastelSettings,
      'brush',
      'color',
      false,
      dotSurf as unknown as HTMLCanvasElement,
      false,
      new LayerPixelSampler(dotSurf as unknown as HTMLCanvasElement)
    );
    expect(dotSurf.buf[(48 * 96 + 48) * 4 + 3]).toBeLessThanOrEqual(6);

    // Zero detached dot at stroke start: touchdown alpha at p=0.05 stays a smooth fade-in (never a blotch!)
    expect(startDotA).toBeLessThanOrEqual(60);
    expect(startDotA).toBeLessThan(earlyA);
    // Smooth monotonic buildup into full opaque max pressure
    expect(midA).toBeGreaterThan(startDotA + 40);
    expect(maxA).toBeGreaterThan(220);

    // 2b. Constant-pressure strokes verify CSP-calibrated pressure response (BrushFlowEffector drives
    // per-plot density without BrushMixAlphaEffector's low curve bottlenecking light/medium pressure!)
    const measureConstantPressureAlpha = (pVal: number, extra?: Partial<BrushSettings>): number => {
      const c = createSoftwareCanvas(120, 160);
      const s = new LayerPixelSampler(c as unknown as HTMLCanvasElement);
      const linePts: Point[] = [];
      for (let i = 0; i <= 14; i++) {
        linePts.push({ x: 60, y: 20 + i * 8, pressure: pVal, width: 36 });
      }
      renderCompleteStroke(
        c.ctx,
        linePts,
        { ...pastelSettings, ...extra },
        'brush',
        'color',
        false,
        c as unknown as HTMLCanvasElement,
        false,
        s
      );
      return c.buf[(80 * 120 + 60) * 4 + 3];
    };
    const lightStrokeA = measureConstantPressureAlpha(0.35);
    const medStrokeA = measureConstantPressureAlpha(0.65);
    const heavyStrokeA = measureConstantPressureAlpha(0.95);
    // Light pressure (p=0.35) must be clearly visible pastel (~25-70% alpha), NOT invisible dead zone
    expect(lightStrokeA).toBeGreaterThan(60);
    expect(lightStrokeA).toBeLessThan(190);
    // Medium pressure (p=0.65) builds rich oil-pastel coverage (~60-95%), matching CSP Stroke 1 & Stroke 4 mid
    expect(medStrokeA).toBeGreaterThan(Math.max(150, lightStrokeA + 30));
    expect(medStrokeA).toBeLessThan(248);
    // Max pressure (p=0.95) reaches solid opaque pastel
    expect(heavyStrokeA).toBeGreaterThan(240);

    // With per-plot Subtract paper texture (TextureDensity=52%), light & medium strokes remain
    // rich and match CSP (never collapsing to <15% faint washes when BrushMixAlphaEffector is active!)
    const texturedLightA = measureConstantPressureAlpha(0.35, {
      grain: 0.52,
      textureDensity: 0.52,
      paperTextureMode: 'subtract',
      paperTextureApplyEachPlot: true,
    });
    const texturedMedA = measureConstantPressureAlpha(0.65, {
      grain: 0.52,
      textureDensity: 0.52,
      paperTextureMode: 'subtract',
      paperTextureApplyEachPlot: true,
    });
    expect(texturedLightA).toBeGreaterThan(45);
    expect(texturedMedA).toBeGreaterThan(120);

    // 2d. Deferred-initial-dot live incremental segment emission must match renderCompleteStroke on pointerup
    // (no first-dab stepDist=0.12 vs 0.07 pop between live draft and committed stroke!)
    const liveSurf = createSoftwareCanvas(120, 160);
    const bakeSurf = createSoftwareCanvas(120, 160);
    const parityPts: Point[] = [];
    for (let i = 0; i <= 14; i++) {
      parityPts.push({ x: 60, y: 20 + i * 8, pressure: 0.55, width: 36 });
    }
    const liveOpts = {
      ...pastelSettings,
      sampler: new LayerPixelSampler(liveSurf as unknown as HTMLCanvasElement),
      reservoir: undefined as any,
    };
    let rem = 0;
    const liveCounter: { count: number; lastStepDist?: number } = { count: 0 };
    for (let i = 1; i < parityPts.length; i++) {
      const pA = parityPts[i - 1];
      const pB = parityPts[i];
      const pPrev = parityPts[Math.max(0, i - 2)];
      const pNext = parityPts[Math.min(parityPts.length - 1, i + 1)];
      const { c1, c2 } = centripetalCatmullRomToBezier(pPrev, pA, pB, pNext);
      rem = drawBrushCubicBezierSegment(liveSurf.ctx, pA, c1, c2, pB, pastelSettings.color, liveOpts, rem, liveCounter);
    }
    renderCompleteStroke(
      bakeSurf.ctx,
      parityPts,
      pastelSettings,
      'brush',
      'color',
      false,
      bakeSurf as unknown as HTMLCanvasElement,
      false,
      new LayerPixelSampler(bakeSurf as unknown as HTMLCanvasElement)
    );
    const liveBodyA = liveSurf.buf[(80 * 120 + 60) * 4 + 3];
    const bakeBodyA = bakeSurf.buf[(80 * 120 + 60) * 4 + 3];
    expect(Math.abs(liveBodyA - bakeBodyA)).toBeLessThanOrEqual(8);

    // 2c. CSP Blend (BrushWaterColor=0) uniform tip color mixing on Point 1:
    // Drawing green (#66ff00) partially overlapping red (#fe2501) shifts the ENTIRE green stroke
    // toward warm olive (matching CSP Blend), rather than leaving the outer left half pure neon green!
    const blendSurf = createSoftwareCanvas(160, 160);
    const redPts: Point[] = [];
    for (let i = 0; i <= 12; i++) {
      redPts.push({ x: 96, y: 20 + i * 10, pressure: 0.85, width: 36 });
    }
    renderCompleteStroke(
      blendSurf.ctx,
      redPts,
      { ...pastelSettings, color: '#fe2501' },
      'brush',
      'color',
      false,
      blendSurf as unknown as HTMLCanvasElement,
      false,
      new LayerPixelSampler(blendSurf as unknown as HTMLCanvasElement)
    );
    const greenPts: Point[] = [];
    for (let i = 0; i <= 12; i++) {
      // Center at x=72 so right ~30% of the 36px green stroke overlaps the red stroke at x=78..114
      greenPts.push({ x: 72, y: 20 + i * 10, pressure: 0.8, width: 36 });
    }
    renderCompleteStroke(
      blendSurf.ctx,
      greenPts,
      { ...pastelSettings, color: '#66ff00' },
      'brush',
      'color',
      false,
      blendSurf as unknown as HTMLCanvasElement,
      false,
      new LayerPixelSampler(blendSurf as unknown as HTMLCanvasElement)
    );
    // Outer left side of green stroke (x=64, y=80 — over blank canvas, NOT over red!)
    // must still have visibly picked up red into olive (R significantly above pure green's 102, G < 235)
    const leftGreenIdx = (80 * 160 + 64) * 4;
    expect(blendSurf.buf[leftGreenIdx + 3]).toBeGreaterThan(100);
    expect(blendSurf.buf[leftGreenIdx]).toBeGreaterThan(135);
    expect(blendSurf.buf[leftGreenIdx + 1]).toBeLessThan(225);

    // 3. GPU path parity: drawBrushDot with batchGpuDabs must ALSO use uncurved raw pressure for densitySensor
    const gpuDotDabs: GpuDab[] = [];
    drawBrushDot(
      surf.ctx,
      { x: 80, y: 24, pressure: 0.05, width: 36 },
      '#ff1800',
      {
        size: 36,
        minSizeFactor: 0,
        opacity: 1.0,
        flow: 1.0,
        spacing: 0.07,
        usePressure: true,
        pressureCurve: sizeCurve,
        densitySensor: brush.densitySensor,
        colorMixing: false,
      },
      gpuDotDabs
    );
    // At raw pressure 0.05, flowCurve(0.05) <= 0.002 -> dot must NOT emit a high-alpha GPU dab!
    expect(gpuDotDabs.length === 0 || gpuDotDabs[0].alpha < 0.02).toBe(true);
  });

  it('InputStabilizer stays in fast attackCutoff on constant high pressure after light touchdown (no 4Hz decay lockout)', () => {
    const stab = new InputStabilizer();
    stab.setStabilizerLevel(6);
    stab.setZoomScale(1.0);
    stab.process(100, 100, 0.006, 0);

    const pressures: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const s = stab.process(100, 100 + i * 10, 0.95, i * 4);
      pressures.push(s.pressure);
    }

    // Must converge quickly to constant 0.95 within 5 samples (20ms) instead of stalling at ~0.55..0.77 in 4Hz decay
    expect(pressures[4]).toBeGreaterThanOrEqual(0.9);
    expect(pressures[9]).toBeGreaterThanOrEqual(0.94);

    // Smooth decay on release still works cleanly
    const drop1 = stab.process(100, 210, 0.1, 44).pressure;
    expect(drop1).toBeLessThan(0.95);
    expect(drop1).toBeGreaterThan(0.5);
  });

  it('reconciles 0.006 WM_POINTERDOWN placeholder for firm and light Oil Pastel strokes with zero live-vs-pointerup pop', () => {
    const origDoc = (globalThis as any).document;
    const origImgData = (globalThis as any).ImageData;
    const origRaf = (globalThis as any).requestAnimationFrame;
    const origCancelRaf = (globalThis as any).cancelAnimationFrame;

    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => {};
    (globalThis as any).ImageData = class {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(d: Uint8ClampedArray, w: number, h: number) {
        this.data = d;
        this.width = w;
        this.height = h;
      }
    };
    (globalThis as any).document = {
      createElement: () => createSoftwareCanvas(1, 1),
    };

    try {
      const dims = { width: 512, height: 512 };
      const grid = new SparseTileGrid();
      const draftCanvas: any = createSoftwareCanvas(512, 512);
      const state = createInitialStrokeSessionState();
      const layer: LayerItem = {
        id: 'layer-1',
        name: 'Layer 1',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        type: 'raster',
      } as any;

      const oilPastelBs: BrushSettings = {
        size: 64,
        minSizeFactor: 0,
        color: '#ff0000',
        opacity: 1.0,
        flow: 1.0,
        spacing: 0.07,
        adjustDensityByGap: false,
        usePressure: true,
        smoothing: true,
        stabilization: 6,
        postCorrection: 0,
        sharpCorners: false,
        hardness: 1.0,
        antiAlias: 1,
        thickness: 1.0,
        thicknessVertical: true,
        pressureCurve: [
          [0, 0],
          [0.00431, 1],
          [1, 1],
        ],
        sizeSensor: {
          usePressure: true,
          pressureMin: 0,
          pressureCurve: [
            [0, 0],
            [0.00431, 1],
            [1, 1],
          ],
        },
        densitySensor: {
          usePressure: true,
          pressureMin: 0,
          pressureCurve: [
            [0, 0],
            [0.00431, 0],
            [0.6379, 0.1928],
            [1, 1],
          ],
        },
        amountOfPaint: 0.3,
        amountOfPaintSensor: {
          usePressure: true,
          pressureMin: 0,
          pressureCurve: [
            [0, 0],
            [1, 1],
          ],
        },
        densityOfPaint: 1.0,
        densityOfPaintSensor: {
          usePressure: true,
          pressureMin: 0,
          pressureCurve: [
            [0, 0],
            [0.8491, 0.1285],
            [1, 1],
          ],
        },
        colorStretch: 0.1,
        colorMixing: true,
        mixingMode: 'blend',
        perceptualMixing: false,
        grain: 0.52,
        textureDensity: 0.52,
        paperTextureMode: 'subtract',
        paperTextureApplyEachPlot: true,
        paperTextureScale: 1.0,
        // Also verify CSP BrushInOutType=0 ("Off") never triggers taper on pointerup
        taper: {
          useIn: true,
          useOut: true,
          inOutType: 0,
          inLength: 20,
          inRatio: 0.3,
          outLength: 20,
          outRatio: 0.3,
        } as any,
        useGpu: false,
      };

      const zoom = 0.4; // Forces draftScale < 1.0 so pointerup runs renderCompleteStroke
      const params: any = {
        disabled: false,
        viewportRef: {
          current: {
            getBoundingClientRect: () => ({
              left: 0,
              top: 0,
              width: 512,
              height: 512,
              right: 512,
              bottom: 512,
            }),
          },
        },
        interactionRef: { current: null },
        isDrawingRef: { current: false },
        panRef: { current: { x: 256, y: 256 } },
        zoomRef: { current: zoom },
        rotationRef: { current: 0 },
        flipXRef: { current: false },
        flipYRef: { current: false },
        dimensionsRef: { current: dims },
        layersRef: { current: [layer] },
        activeLayerIdRef: { current: 'layer-1' },
        activeLayerLockedRef: { current: false },
        activeLayerVisibleRef: { current: true },
        colorModeRef: { current: 'color' },
        isMaskModeRef: { current: false },
        getActiveMaskCanvas: () => null,
        effectiveDraftCanvasRef: { current: draftCanvas },
        activeTileGridRef: { current: grid },
        selectionRef: { current: null },
        rulerRef: { current: null },
        straightRulerRef: { current: null },
        lastStrokeEndRef: { current: null },
        onActiveConstraintAxisChangeRef: { current: undefined },
        onCollabStrokeStartRef: { current: undefined },
        onCollabStrokeChunkRef: { current: undefined },
        onCollabStrokeFinishRef: { current: undefined },
        onCollabCursorMoveRef: { current: undefined },
        onUpdateMaskThumbnailRef: { current: undefined },
        enqueueHistoryTask: () => {},
        pushHistoryStep: () => {},
        flushPendingHistoryTasks: () => {},
        onUpdateLayerThumbnail: () => {},
      };

      const helpers: any = {
        getTool: () => 'brush',
        getBrushSettings: () => oilPastelBs,
        getPredictedCanvas: () => getPredictedCanvasElement(undefined),
        clearPredictedCanvas: () => clearPredictedCanvasSurface(state, () => null),
        emitConstraintAxisChange: (a: any) =>
          emitConstraintAxisChangeIfNeeded(state, params.onActiveConstraintAxisChangeRef, a),
        markTouchedTiles: (x0: number, y0: number, x1: number, y1: number) =>
          markTouchedTilesInRect(dims, state.touchedTiles, x0, y0, x1, y1),
        getViewportRect: () => getViewportRectCached(state, params.viewportRef),
        dispatchPointerStat: () => {},
        abortActiveStroke: () =>
          abortActiveStrokeSession(
            params,
            state,
            helpers.clearPredictedCanvas,
            helpers.emitConstraintAxisChange
          ),
        getCanvasPoint: (e: any) =>
          computeCanvasPoint(e, params, helpers.getViewportRect, helpers.getBrushSettings),
        resolveEffectiveOpacitySensor: resolveEffectiveOpacitySensorValue,
        resolveLiveAntiAlias: resolveLiveAntiAliasValue,
        buildTouchedTileSpans: (sx: number, sy: number, dw: number, dh: number) =>
          buildTouchedTileSpansFromSet(state.touchedTiles, sx, sy, dw, dh),
        buildLiveBrushOptions: (...a: any[]) => (createLiveBrushOptions as any)(state, ...a),
        resolveStrokeColor: (...a: any[]) => (resolveStrokeColorValue as any)(false, ...a),
        emitLiveSegment: (...a: any[]) => (emitLiveSegmentToDraft as any)(state, params, helpers, ...a),
        renderPredictedStroke: () => {},
        flushPendingPoints: (skip?: any) => runFlushPendingPoints(state, params, helpers, skip),
      };

      const mkEvt = (dx: number, dy: number, p: number, ts: number) => {
        const e: any = {
          pointerId: -1001,
          pointerType: 'pen',
          button: 0,
          buttons: 1,
          clientX: 256 + (dx - 256) * zoom,
          clientY: 256 + (dy - 256) * zoom,
          pressure: p,
          tiltX: 0,
          tiltY: 0,
          twist: 0,
          timeStamp: ts,
          shiftKey: false,
          altKey: false,
          preventDefault() {},
        };
        e.nativeEvent = e;
        return e;
      };

      // 1. Firm max-pressure stroke (0.006 placeholder down -> 0.95 constant move)
      runPointerDown(state, params, helpers, mkEvt(140, 100, 0.006, 100));
      for (let i = 1; i <= 15; i++) {
        runPointerMove(state, params, helpers, mkEvt(140, 100 + i * 20, 0.95, 100 + i * 4));
        if (i % 3 === 0 || i === 15) runFlushPendingPoints(state, params, helpers, false);
      }
      const ds = draftCanvas.__draftScale ?? 1;
      const dr = draftCanvas.__draftDocRect ?? { x: 0, y: 0 };
      const livePxX = Math.round((140 - dr.x) * ds);
      const livePxY = Math.round((250 - dr.y) * ds);
      const liveFirmA = draftCanvas.buf[(livePxY * draftCanvas.width + livePxX) * 4 + 3];
      runPointerUp(state, params, helpers, mkEvt(140, 400, 0, 170));

      const pxOut: [number, number, number, number] = [0, 0, 0, 0];
      grid.getPixelRGBA('layer-1', 140, 250, pxOut);
      const tileFirmA = pxOut[3];
      expect(liveFirmA).toBeGreaterThanOrEqual(235);
      expect(tileFirmA).toBeGreaterThanOrEqual(235);
      expect(Math.abs(liveFirmA - tileFirmA)).toBeLessThanOrEqual(12);

      // 2. Light-pressure stroke (0.006 placeholder down -> 0.25 constant move)
      runPointerDown(state, params, helpers, mkEvt(320, 100, 0.006, 200));
      for (let i = 1; i <= 15; i++) {
        runPointerMove(state, params, helpers, mkEvt(320, 100 + i * 20, 0.25, 200 + i * 4));
        if (i % 3 === 0 || i === 15) runFlushPendingPoints(state, params, helpers, false);
      }
      const lightLivePxX = Math.round((320 - dr.x) * ds);
      const lightLivePxY = Math.round((250 - dr.y) * ds);
      const liveLightA = draftCanvas.buf[(lightLivePxY * draftCanvas.width + lightLivePxX) * 4 + 3];
      runPointerUp(state, params, helpers, mkEvt(320, 400, 0, 270));

      grid.getPixelRGBA('layer-1', 320, 250, pxOut);
      const tileLightA = pxOut[3];
      expect(tileLightA).toBeGreaterThan(25);
      expect(tileLightA).toBeLessThan(150);
      expect(tileFirmA - tileLightA).toBeGreaterThan(100);
      expect(Math.abs(liveLightA - tileLightA)).toBeLessThanOrEqual(12);
    } finally {
      (globalThis as any).document = origDoc;
      (globalThis as any).ImageData = origImgData;
      (globalThis as any).requestAnimationFrame = origRaf;
      (globalThis as any).cancelAnimationFrame = origCancelRaf;
    }
  });

  it('preserves light-pressure Oil Pastel strokes on pen-lift over OPAQUE backgrounds (no 8-bit regionCanvas wipeout), guards inOutType=0 taper, and rounds LOD mipmap alpha unbiasedly', () => {
    const origDoc = (globalThis as any).document;
    const origImgData = (globalThis as any).ImageData;
    const origRaf = (globalThis as any).requestAnimationFrame;
    const origCancelRaf = (globalThis as any).cancelAnimationFrame;

    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => {};
    (globalThis as any).ImageData = class {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(d: Uint8ClampedArray, w: number, h: number) {
        this.data = d;
        this.width = w;
        this.height = h;
      }
    };
    (globalThis as any).document = {
      createElement: () => createSoftwareCanvas(1, 1),
    };

    try {
      // 1. CSP BrushInOutType=0 ("Off") must ALWAYS return identity taper factors even when useIn/useOut=true
      const offTaper = {
        useIn: true,
        useOut: true,
        inOutType: 0,
        inLength: 40,
        inRatio: 0.4,
        outLength: 40,
        outRatio: 0.4,
        affectSize: true,
        affectDensity: true,
        affectOpacity: true,
        affectAmountOfPaint: true,
        affectDensityOfPaint: true,
      } as any;
      for (const dist of [0, 10, 100, 195, 200]) {
        expect(evaluateCspTaperFactors(offTaper, dist, 200, 1.0)).toEqual({
          sizeScale: 1.0,
          alphaScale: 1.0,
          amountScale: 1.0,
          paintDensityScale: 1.0,
        });
      }

      // 2. Light-pressure Oil Pastel stroke drawn on an OPAQUE WHITE layer (e.g. Background layer)
      // at zoom=0.4 (forcing pointerUpRasterCommit re-bake):
      // Previously, compositing low-alpha (1..5/255) color-mixing dabs directly onto an opaque
      // regionCanvas snapped every dab back to RGB=(255,255,255) on pen lift!
      const dims = { width: 512, height: 512 };
      const grid = new SparseTileGrid();
      const whiteData = new Uint8ClampedArray(512 * 512 * 4);
      whiteData.fill(255);
      grid.writeImageData('layer-bg', { data: whiteData, width: 512, height: 512 } as any, 0, 0, 'color-32bit', true);

      const draftCanvas: any = createSoftwareCanvas(512, 512);
      const state = createInitialStrokeSessionState();
      const bgLayer: LayerItem = {
        id: 'layer-bg',
        name: 'Paper',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        type: 'raster',
      } as any;

      const oilPastelBs: BrushSettings = {
        size: 64,
        minSizeFactor: 0,
        color: '#fe2501',
        opacity: 1.0,
        flow: 1.0,
        spacing: 0.07,
        adjustDensityByGap: false,
        usePressure: true,
        smoothing: true,
        stabilization: 6,
        postCorrection: 0,
        sharpCorners: false,
        hardness: 1.0,
        antiAlias: 1,
        thickness: 1.0,
        thicknessVertical: true,
        pressureCurve: [
          [0, 0],
          [0.00431, 1],
          [1, 1],
        ],
        sizeSensor: {
          usePressure: true,
          pressureMin: 0,
          pressureCurve: [
            [0, 0],
            [0.00431, 1],
            [1, 1],
          ],
        },
        densitySensor: {
          usePressure: true,
          pressureMin: 0,
          pressureCurve: [
            [0, 0],
            [0.00431, 0],
            [0.63793, 0.19277],
            [1, 1],
          ],
        },
        amountOfPaint: 0.3,
        amountOfPaintSensor: {
          usePressure: true,
          pressureMin: 0,
          pressureCurve: [
            [0, 0],
            [1, 1],
          ],
        },
        densityOfPaint: 1.0,
        densityOfPaintSensor: {
          usePressure: true,
          pressureMin: 0,
          pressureCurve: [
            [0, 0],
            [0.84914, 0.12851],
            [1, 1],
          ],
        },
        colorStretch: 0.1,
        colorMixing: true,
        mixingMode: 'blend',
        perceptualMixing: false,
        grain: 0.52,
        textureDensity: 0.52,
        paperTextureMode: 'subtract',
        paperTextureApplyEachPlot: true,
        paperTextureScale: 1.0,
        taper: offTaper,
        useGpu: false,
      };

      const zoom = 0.4;
      const params: any = {
        disabled: false,
        viewportRef: {
          current: {
            getBoundingClientRect: () => ({
              left: 0,
              top: 0,
              width: 512,
              height: 512,
              right: 512,
              bottom: 512,
            }),
          },
        },
        interactionRef: { current: null },
        isDrawingRef: { current: false },
        panRef: { current: { x: 256, y: 256 } },
        zoomRef: { current: zoom },
        rotationRef: { current: 0 },
        flipXRef: { current: false },
        flipYRef: { current: false },
        dimensionsRef: { current: dims },
        layersRef: { current: [bgLayer] },
        activeLayerIdRef: { current: 'layer-bg' },
        activeLayerLockedRef: { current: false },
        activeLayerVisibleRef: { current: true },
        colorModeRef: { current: 'color' },
        isMaskModeRef: { current: false },
        getActiveMaskCanvas: () => null,
        effectiveDraftCanvasRef: { current: draftCanvas },
        activeTileGridRef: { current: grid },
        selectionRef: { current: null },
        rulerRef: { current: null },
        straightRulerRef: { current: null },
        lastStrokeEndRef: { current: null },
        onActiveConstraintAxisChangeRef: { current: undefined },
        onCollabStrokeStartRef: { current: undefined },
        onCollabStrokeChunkRef: { current: undefined },
        onCollabStrokeFinishRef: { current: undefined },
        onCollabCursorMoveRef: { current: undefined },
        onUpdateMaskThumbnailRef: { current: undefined },
        enqueueHistoryTask: () => {},
        pushHistoryStep: () => {},
        flushPendingHistoryTasks: () => {},
        onUpdateLayerThumbnail: () => {},
      };

      const helpers: any = {
        getTool: () => 'brush',
        getBrushSettings: () => oilPastelBs,
        getPredictedCanvas: () => getPredictedCanvasElement(undefined),
        clearPredictedCanvas: () => clearPredictedCanvasSurface(state, () => null),
        emitConstraintAxisChange: (a: any) =>
          emitConstraintAxisChangeIfNeeded(state, params.onActiveConstraintAxisChangeRef, a),
        markTouchedTiles: (x0: number, y0: number, x1: number, y1: number) =>
          markTouchedTilesInRect(dims, state.touchedTiles, x0, y0, x1, y1),
        getViewportRect: () => getViewportRectCached(state, params.viewportRef),
        dispatchPointerStat: () => {},
        abortActiveStroke: () =>
          abortActiveStrokeSession(
            params,
            state,
            helpers.clearPredictedCanvas,
            helpers.emitConstraintAxisChange
          ),
        getCanvasPoint: (e: any) =>
          computeCanvasPoint(e, params, helpers.getViewportRect, helpers.getBrushSettings),
        resolveEffectiveOpacitySensor: resolveEffectiveOpacitySensorValue,
        resolveLiveAntiAlias: resolveLiveAntiAliasValue,
        buildTouchedTileSpans: (sx: number, sy: number, dw: number, dh: number) =>
          buildTouchedTileSpansFromSet(state.touchedTiles, sx, sy, dw, dh),
        buildLiveBrushOptions: (...a: any[]) => (createLiveBrushOptions as any)(state, ...a),
        resolveStrokeColor: (...a: any[]) => (resolveStrokeColorValue as any)(false, ...a),
        emitLiveSegment: (...a: any[]) => (emitLiveSegmentToDraft as any)(state, params, helpers, ...a),
        renderPredictedStroke: () => {},
        flushPendingPoints: (skip?: any) => runFlushPendingPoints(state, params, helpers, skip),
      };

      const mkEvt = (dx: number, dy: number, p: number, ts: number) => {
        const e: any = {
          pointerId: -2002,
          pointerType: 'pen',
          button: 0,
          buttons: 1,
          clientX: 256 + (dx - 256) * zoom,
          clientY: 256 + (dy - 256) * zoom,
          pressure: p,
          tiltX: 0,
          tiltY: 0,
          twist: 0,
          timeStamp: ts,
          shiftKey: false,
          altKey: false,
          preventDefault() {},
        };
        e.nativeEvent = e;
        return e;
      };

      runPointerDown(state, params, helpers, mkEvt(256, 100, 0.25, 100));
      for (let i = 1; i <= 15; i++) {
        runPointerMove(state, params, helpers, mkEvt(256, 100 + i * 20, 0.25, 100 + i * 4));
        if (i % 3 === 0 || i === 15) runFlushPendingPoints(state, params, helpers, false);
      }

      const ds = draftCanvas.__draftScale ?? 1;
      const dr = draftCanvas.__draftDocRect ?? { x: 0, y: 0 };
      const livePxX = Math.round((256 - dr.x) * ds);
      const livePxY = Math.round((250 - dr.y) * ds);
      const liveOff = (livePxY * draftCanvas.width + livePxX) * 4;
      const liveA = draftCanvas.buf[liveOff + 3] / 255;
      const liveCompositeG = Math.round(draftCanvas.buf[liveOff + 1] * liveA + 255 * (1 - liveA));
      const liveColorShift = 255 - liveCompositeG;

      // Lift pen -> triggers isolated color-mixing raster commit
      runPointerUp(state, params, helpers, mkEvt(256, 400, 0, 170));

      const pxOut: [number, number, number, number] = [0, 0, 0, 0];
      grid.getPixelRGBA('layer-bg', 256, 250, pxOut);
      const tileColorShift = 255 - pxOut[1];

      // Must remain clearly visible on white (not vanished to 255,255,255!) and match live preview
      expect(liveColorShift).toBeGreaterThanOrEqual(4);
      expect(tileColorShift).toBeGreaterThanOrEqual(4);
      expect(Math.abs(liveColorShift - tileColorShift)).toBeLessThanOrEqual(4);

      // 3. LOD mipmap unbiased alpha rounding: sparse faint alpha (sumA=2 across 2x2) rounds to 1 instead of 0
      const child = createTileBuffer('layer-lod', 0, 0, 'color-32bit', 0);
      child.data![0] = 255;
      child.data![1] = 30;
      child.data![2] = 0;
      child.data![3] = 2; // top-left pixel of 2x2 block has alpha=2, other 3 are 0 -> sumA=2
      const parent = createTileBuffer('layer-lod', 0, 0, 'color-32bit', 1);
      expect(downsample2x2ToParentTile([child, null, null, null], parent)).toBe(true);
      expect(parent.data![3]).toBe(1);
    } finally {
      (globalThis as any).document = origDoc;
      (globalThis as any).ImageData = origImgData;
      (globalThis as any).requestAnimationFrame = origRaf;
      (globalThis as any).cancelAnimationFrame = origCancelRaf;
    }
  });

  it('parses Cross-hatching (for tone scraping).sut with empty CatalogPath via OriginalPath and renders 1:1 cross-hatch without synthetic ellipse distortion on GPU & CPU', async () => {
    const buildEffector = (
      flags: number,
      tMin: number,
      tiltMaxPct: number,
      tiltCurve?: [number, number][]
    ) => {
      const tBytes = tiltCurve ? 12 + tiltCurve.length * 16 : 0;
      const buf = new Uint8Array(48 + tBytes);
      const v = new DataView(buf.buffer);
      v.setUint32(0, 48, false);
      v.setUint32(4, 0xf0, false);
      v.setUint32(8, flags, false);
      v.setInt32(12, 0, false);
      v.setInt32(16, tMin, false);
      v.setInt32(20, 0, false);
      v.setInt32(24, 0, false);
      v.setUint32(28, 0, false);
      v.setUint32(32, 0, false);
      v.setUint32(36, tBytes, false);
      v.setUint32(40, tiltMaxPct, false);
      v.setUint32(44, 0, false);
      if (tiltCurve) {
        v.setUint32(48, 12, false);
        v.setUint32(52, tiltCurve.length, false);
        v.setUint32(56, 16, false);
        for (let i = 0; i < tiltCurve.length; i++) {
          v.setFloat64(60 + i * 16, tiltCurve[i][0], false);
          v.setFloat64(68 + i * 16, tiltCurve[i][1], false);
        }
      }
      return buf;
    };

    // Encode UTF-16LE BrushPatternImageArray matching real CSP Paint003 .sut format
    const origPath = '.:Paint003:7951fc496f-c44a-3ea9-ee5f-d870cf0454:data:material.layer';
    const utf16Bytes = new Uint8Array(16 + origPath.length * 2);
    for (let i = 0; i < origPath.length; i++) {
      const code = origPath.charCodeAt(i);
      utf16Bytes[16 + i * 2] = code & 0xff;
      utf16Bytes[16 + i * 2 + 1] = (code >> 8) & 0xff;
    }

    const tinyPng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x01, 0x2c, 0x00, 0x00, 0x01, 0x2b, // 300x299
      0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    const sizeTiltCurve: [number, number][] = [
      [0.0, 1.0],
      [0.2, 1.0],
      [0.4, 0.5273],
      [0.4273, 0.0091],
      [0.6091, 0.0],
      [1.0, 0.0],
    ];
    const intervalTiltCurve: [number, number][] = [
      [0.0, 1.0],
      [0.2364, 1.0],
      [0.4, 0.0],
      [0.5727, 0.0],
      [1.0, 0.0],
    ];

    const extracted: NativeSutExtract = {
      nodeName: 'Cross-hatching (for tone scraping)',
      variantId: 343,
      variantValues: new Map<string, unknown>([
        ['antialias', 0],
        ['brushsize', 200.0],
        ['brushsizeunit', 0],
        ['brushsizeeffector', buildEffector(0x20, 100, 175, sizeTiltCurve)],
        ['brushinterval', 31.0],
        ['brushautointervaltype', 0],
        ['brushintervaleffector', buildEffector(0x20, 100, 150, intervalTiltCurve)],
        ['brushflow', 100],
        ['opacity', 100],
        ['brushhardness', 100],
        ['brushthickness', 100],
        ['brushverticalthicknes', 0],
        ['brushrotation', 0.0],
        ['brushrotationeffector', 3], // 0x03 = None
        ['brushrotationrandomscale', 100],
        ['brushusepatternimage', 1],
        ['brushpatternimagearray', utf16Bytes],
        ['brushinouttype', 0],
        ['brushusein', 1],
        ['brushuseout', 1],
      ]),
      materials: [
        {
          pwId: '1',
          originalPath: origPath,
          catalogPath: '', // Real CSP Paint003 MaterialFile leaves CatalogPath empty!
          fileData: new Uint8Array(0),
          decodedPng: tinyPng,
          width: 300,
          height: 299,
          expressionColor: 'gray',
          isPaperTexture: false,
          hasSubColor: false,
          decodedFromLayer: false,
        },
      ],
    };

    const brush = await parseSutExtractedData(extracted, 'Cross-hatching (for tone scraping).sut');

    // 1. Material must resolve via OriginalPath with ZERO missing-material warnings
    expect(brush.importWarnings).toBeUndefined();
    expect(brush.tipDataUrl).toBeDefined();
    expect(brush.tipWidth).toBe(300);
    expect(brush.tipHeight).toBe(299);
    expect(brush.antiAlias).toBe(0);
    expect(brush.spacing).toBeCloseTo(0.31, 4);
    expect(brush.thickness).toBeCloseTo(1.0, 4);
    expect(brush.angle).toBe(0);
    expect(brush.angleDynamics).toBe('none');
    expect(brush.usePressure).toBe(false);
    expect(brush.useTilt).toBe(true);
    expect(brush.taper).toBeUndefined();

    // 2. Tilt expansion ceilings (175% size, 150% interval) must decode & evaluate faithfully
    expect(brush.sizeSensor?.useTilt).toBe(true);
    expect(brush.sizeSensor?.tiltMin).toBeCloseTo(1.0, 4);
    expect(brush.sizeSensor?.tiltMax).toBeCloseTo(1.75, 4);
    expect(brush.intervalSensor?.useTilt).toBe(true);
    expect(brush.intervalSensor?.tiltMin).toBeCloseTo(1.0, 4);
    expect(brush.intervalSensor?.tiltMax).toBeCloseTo(1.5, 4);

    // Upright pen (tiltMagnitude=0 -> altitude=1.0 -> curve y=0.0) stays at 1.0x
    expect(evaluateCspSensor(brush.sizeSensor, 0.5, 0.0, 0, 0.5)).toBeCloseTo(1.0, 4);
    expect(evaluateCspSensor(brush.intervalSensor, 0.5, 0.0, 0, 0.5)).toBeCloseTo(1.0, 4);
    // Flat-tilted pen (tiltMagnitude=0.95 -> altitude=0.05 -> curve y=1.0) expands to 1.75x / 1.5x
    expect(evaluateCspSensor(brush.sizeSensor, 0.5, 0.95, 0, 0.5)).toBeCloseTo(1.75, 3);
    expect(evaluateCspSensor(brush.intervalSensor, 0.5, 0.95, 0, 0.5)).toBeCloseTo(1.5, 3);

    // 3. Build a cross-hatching tip canvas (criss-cross lines, NOT a solid ellipse)
    const hatchTip = createSoftwareCanvas(64, 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const onVertical = x >= 22 && x <= 42 && (x % 4 === 0);
        const onHorizontal = y >= 22 && y <= 42 && (y % 4 === 0);
        if (onVertical || onHorizontal) {
          const i = (y * 64 + x) * 4;
          hatchTip.buf[i] = 255;
          hatchTip.buf[i + 1] = 255;
          hatchTip.buf[i + 2] = 255;
          hatchTip.buf[i + 3] = 255;
        }
      }
    }

    const commonOpts = {
      size: 60,
      minSizeFactor: 1.0,
      flow: 1.0,
      spacing: brush.spacing,
      hardness: 1.0,
      thickness: brush.thickness,
      thicknessVertical: brush.thicknessVertical,
      angle: brush.angle,
      angleDynamics: brush.angleDynamics,
      antiAlias: 0,
      usePressure: false,
      useTilt: brush.useTilt,
      sizeSensor: brush.sizeSensor,
      intervalSensor: brush.intervalSensor,
      tipImage: hatchTip as unknown as HTMLImageElement,
      useGpu: false,
    };

    // 4. GPU dab batch parity under typical 35° stylus tilt:
    // MUST stay 1:1 square (no 3:1 horizontal ellipse squishing!), angle=0, alpha=1.0
    const gpuDotNormalTilt: GpuDab[] = [];
    const surfDummy = createSoftwareCanvas(200, 200);
    drawBrushDot(
      surfDummy.ctx,
      { x: 100, y: 100, pressure: 0.7, width: 60, tiltX: 30, tiltY: 18 },
      '#000000',
      commonOpts,
      gpuDotNormalTilt
    );
    expect(gpuDotNormalTilt.length).toBe(1);
    expect(gpuDotNormalTilt[0].width).toBeCloseTo(gpuDotNormalTilt[0].height, 2);
    expect(gpuDotNormalTilt[0].width).toBeGreaterThanOrEqual(59.5);
    expect(gpuDotNormalTilt[0].width).toBeLessThan(70);
    expect(Math.abs(gpuDotNormalTilt[0].angle)).toBeLessThan(1e-4);
    expect(gpuDotNormalTilt[0].alpha).toBeCloseTo(1.0, 4);

    // Heavy 75° tilt expands size toward 1.75x uniformly while STILL preserving 1:1 aspect ratio & angle=0
    const gpuDotHeavyTilt: GpuDab[] = [];
    drawBrushDot(
      surfDummy.ctx,
      { x: 100, y: 100, pressure: 0.7, width: 60, tiltX: 75, tiltY: 0 },
      '#000000',
      commonOpts,
      gpuDotHeavyTilt
    );
    expect(gpuDotHeavyTilt.length).toBe(1);
    expect(gpuDotHeavyTilt[0].width).toBeCloseTo(gpuDotHeavyTilt[0].height, 2);
    expect(gpuDotHeavyTilt[0].width).toBeCloseTo(60 * 1.75, 0);
    expect(Math.abs(gpuDotHeavyTilt[0].angle)).toBeLessThan(1e-4);

    // 5. GPU vs CPU vertical stroke parity under 35° stylus tilt
    const strokePts: Point[] = [
      { x: 100, y: 30, pressure: 0.8, width: 60, tiltX: 30, tiltY: 18 },
      { x: 100, y: 70, pressure: 0.8, width: 60, tiltX: 30, tiltY: 18 },
      { x: 100, y: 110, pressure: 0.8, width: 60, tiltX: 30, tiltY: 18 },
      { x: 100, y: 150, pressure: 0.8, width: 60, tiltX: 30, tiltY: 18 },
    ];
    const gpuStrokeDabs: GpuDab[] = [];
    drawBrushCubicBezierSegment(
      surfDummy.ctx,
      strokePts[0],
      strokePts[1],
      strokePts[2],
      strokePts[3],
      '#000000',
      commonOpts,
      0,
      { count: 0 },
      gpuStrokeDabs
    );
    expect(gpuStrokeDabs.length).toBeGreaterThanOrEqual(4);
    for (const d of gpuStrokeDabs) {
      expect(d.width).toBeCloseTo(d.height, 2);
      expect(Math.abs(d.angle)).toBeLessThan(1e-4);
      expect(d.alpha).toBeCloseTo(1.0, 4);
    }

    // CPU single dot must render a square hatched bounding box (aspect ratio ~1:1, NOT ~3:1 ellipse)
    const cpuDotSurf = createSoftwareCanvas(160, 160);
    drawBrushDot(
      cpuDotSurf.ctx,
      { x: 80, y: 80, pressure: 0.8, width: 60, tiltX: 30, tiltY: 18 },
      '#000000',
      commonOpts
    );
    let minX = 160, maxX = -1, minY = 160, maxY = -1, lit = 0;
    for (let y = 0; y < 160; y++) {
      for (let x = 0; x < 160; x++) {
        if (cpuDotSurf.buf[(y * 160 + x) * 4 + 3] > 20) {
          lit++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    expect(bboxW).toBeGreaterThan(40);
    expect(bboxH).toBeGreaterThan(40);
    expect(Math.abs(bboxW - bboxH)).toBeLessThanOrEqual(4);
    // Hatched pattern has transparent gaps inside its bounding box (unlike a solid filled ellipse!)
    expect(lit).toBeLessThan(bboxW * bboxH * 0.7);
  });

  it('calibrates Chalk.sut: TextureDensityEffector (CPU+GPU), linear spherical tilt altitude, pen-direction azimuth, C2F paper thumbnail scale, porous tip box-filtering, and 1:1 live-vs-commit parity', async () => {
    const buildEffectorBlob = (cfg: {
      flags: number;
      pressureMin?: number;
      tiltMin?: number;
      tiltMax?: number;
      velocityMin?: number;
      randomMin?: number;
      pressureCurve?: [number, number][];
      tiltCurve?: [number, number][];
      velocityCurve?: [number, number][];
    }): Uint8Array => {
      const encodeCurve = (pts?: [number, number][]): Uint8Array => {
        if (!pts || pts.length === 0) return new Uint8Array(0);
        const out = new Uint8Array(12 + pts.length * 16);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, 12, false);
        dv.setUint32(4, pts.length, false);
        dv.setUint32(8, 16, false);
        let off = 12;
        for (const [x, y] of pts) {
          dv.setFloat64(off, x, false);
          dv.setFloat64(off + 8, y, false);
          off += 16;
        }
        return out;
      };
      const pBytes = encodeCurve(cfg.pressureCurve);
      const tBytes = encodeCurve(cfg.tiltCurve);
      const vBytes = encodeCurve(cfg.velocityCurve);
      const total = 48 + pBytes.length + tBytes.length + vBytes.length;
      const buf = new Uint8Array(total);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, 48, false);
      dv.setUint32(4, 0xf0, false);
      dv.setUint32(8, cfg.flags, false);
      dv.setInt32(12, cfg.pressureMin ?? 0, false);
      dv.setInt32(16, cfg.tiltMin ?? 0, false);
      dv.setInt32(20, cfg.velocityMin ?? 0, false);
      dv.setInt32(24, cfg.randomMin ?? 0, false);
      dv.setUint32(32, pBytes.length, false);
      dv.setUint32(36, tBytes.length, false);
      dv.setUint32(40, cfg.tiltMax ?? 100, false);
      dv.setUint32(44, vBytes.length, false);
      let cursor = 48;
      buf.set(pBytes, cursor);
      cursor += pBytes.length;
      buf.set(tBytes, cursor);
      cursor += tBytes.length;
      buf.set(vBytes, cursor);
      return buf;
    };

    const buildTarArchive = (files: Array<{ name: string; data: Uint8Array }>): Uint8Array => {
      const blocks: Uint8Array[] = [];
      for (const f of files) {
        const header = new Uint8Array(512);
        const nameBytes = new TextEncoder().encode(f.name);
        header.set(nameBytes.subarray(0, 100), 0);
        const sizeOct = f.data.length.toString(8).padStart(11, '0') + '\0';
        header.set(new TextEncoder().encode(sizeOct), 124);
        blocks.push(header);
        const paddedLen = Math.ceil(f.data.length / 512) * 512;
        const body = new Uint8Array(paddedLen);
        body.set(f.data, 0);
        blocks.push(body);
      }
      blocks.push(new Uint8Array(1024));
      const total = blocks.reduce((acc, b) => acc + b.length, 0);
      const out = new Uint8Array(total);
      let pos = 0;
      for (const b of blocks) {
        out.set(b, pos);
        pos += b.length;
      }
      return out;
    };

    // 1. Build exact Chalk.sut VariantID=731 effectors & C2F paper-texture thumbnail TAR
    const sizeEff = buildEffectorBlob({
      flags: 0x30,
      pressureMin: 50,
      tiltMin: 100,
      tiltMax: 350,
      pressureCurve: [
        [0, 0],
        [0.1364, 0.6909],
        [0.75, 1],
        [1, 1],
      ],
      tiltCurve: [
        [0, 1],
        [0.2325, 0.864],
        [0.2895, 0.4561],
        [0.5175, 0.0833],
        [0.7632, 0],
        [1, 0],
      ],
    });
    const flowEff = buildEffectorBlob({
      flags: 0x30,
      pressureMin: 50,
      tiltMin: 0,
      tiltMax: 300,
      pressureCurve: [
        [0, 0],
        [0.6, 0],
        [0.693, 1],
        [0.8772, 1],
        [1, 1],
      ],
      tiltCurve: [
        [0, 0],
        [0.2061, 0.1623],
        [0.6273, 0.5636],
        [0.7585, 0.7727],
        [0.7675, 0.9868],
        [0.7719, 1],
        [1, 1],
      ],
    });
    const thickEff = buildEffectorBlob({
      flags: 0x10,
      pressureMin: 70,
      pressureCurve: [
        [0, 0],
        [1, 1],
      ],
    });
    const texDensityEff = buildEffectorBlob({
      flags: 0xb0,
      pressureMin: 30,
      tiltMin: 100,
      tiltMax: 350,
      randomMin: 40,
      pressureCurve: [
        [0, 1],
        [1, 0],
      ],
      tiltCurve: [
        [0, 1],
        [1, 0],
      ],
    });

    // Synthetic 300x300 thumbnail PNG header + large encrypted C2F data/material_0.layer (~14x thumb bytes)
    const makePngStub = (w: number, h: number, payloadBytes: number): Uint8Array => {
      const buf = new Uint8Array(Math.max(45, payloadBytes));
      buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      const dv = new DataView(buf.buffer);
      dv.setUint32(8, 13, false);
      buf.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
      dv.setUint32(16, w, false);
      dv.setUint32(20, h, false);
      buf[24] = 8;
      buf[25] = 6;
      // Place IEND at the very end
      const iend = buf.length - 12;
      dv.setUint32(iend, 0, false);
      buf.set([0x49, 0x45, 0x4e, 0x44], iend + 4);
      return buf;
    };

    const paperThumb = makePngStub(300, 300, 4096);
    const fakeC2fLayer = new Uint8Array(4096 * 14);
    fakeC2fLayer.set([0x89, 0x43, 0x32, 0x46, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const paperXml = new TextEncoder().encode(
      '<infolist><info><datalist key="systemtag"><data>PaperTexture</data></datalist></info></infolist>'
    );
    const paperTar = buildTarArchive([
      { name: 'thumbnail/thumbnail.png', data: paperThumb },
      { name: 'data/material_0.layer', data: fakeC2fLayer },
      { name: 'icedata/layerData.xml', data: paperXml },
    ]);

    const tipThumb = makePngStub(126, 125, 1024);
    const tipXml = new TextEncoder().encode(
      '<infolist><info><datalist key="systemtag"><data>BrushPattern</data></datalist></info></infolist>'
    );
    const tipTar = buildTarArchive([
      { name: 'thumbnail/thumbnail.png', data: tipThumb },
      { name: 'icedata/layerData.xml', data: tipXml },
    ]);

    const texRefBlob = new TextEncoder().encode('.:Paint003:ad7fdd790c-fe42-c8ba-764e-c82c927efc:data');
    const patRefBlob = new TextEncoder().encode('.:Paint003:e445940a71-e74e-8b94-f05d-5fb23e6f53:data');

    const variantValues = new Map<string, unknown>([
      ['brushsize', 52.1],
      ['brushsizeunit', 0],
      ['brushthickness', 50],
      ['brushverticalthicknes', 0],
      ['brushhardness', 81],
      ['antialias', 1],
      ['brushinterval', 10.0],
      ['brushautointervaltype', 1],
      ['brushflow', 100],
      ['brushadjustflowbyinterval', 0],
      ['opacity', 100],
      ['brushpatternreversehorizontal', 2],
      ['brushpatternreversevertical', 0],
      ['brushrotation', 0],
      ['brushrotationeffector', 19],
      ['brushusepatternimage', 1],
      ['brushpatternimagearray', patRefBlob],
      ['brushsizeeffector', sizeEff],
      ['brushfloweffector', flowEff],
      ['brushthicknesseffector', thickEff],
      ['texturedensityeffector', texDensityEff],
      ['brushusewatercolor', 1],
      ['brushusewatercolor2', 1],
      ['brushwatercolor', 0],
      ['brushcolormixingmode', 1],
      ['brushmixcolor', 70],
      ['brushmixalpha', 100],
      ['brushmixcolorextension', 10],
      ['textureimage', texRefBlob],
      ['texturecompositemode', 2],
      ['texturedensity', 80],
      ['textureforplot', 1],
      ['texturescale2', 20.0],
      ['texturerotate', 90.0],
    ]);

    const extract: NativeSutExtract = {
      nodeName: 'Chalk',
      variantId: 731,
      variantValues,
      materials: [
        {
          pwId: '1',
          originalPath: '.:Paint003:ad7fdd790c-fe42-c8ba-764e-c82c927efc:data:material_0.layer',
          catalogPath: '',
          fileData: paperTar,
          decodedFromLayer: false,
          isPaperTexture: true,
        },
        {
          pwId: '2',
          originalPath: '.:Paint003:e445940a71-e74e-8b94-f05d-5fb23e6f53:data:material_0.layer',
          catalogPath: '',
          fileData: tipTar,
          decodedFromLayer: false,
          isPaperTexture: false,
        },
      ],
    };

    const brush = await parseSutExtractedData(extract, 'Chalk.sut');
    expect(brush.size).toBeCloseTo(52.1, 2);
    expect(brush.spacing).toBeCloseTo(0.04, 4);
    expect(brush.thickness).toBeCloseTo(0.5, 4);
    expect(brush.thicknessVertical).toBe(true);
    expect(brush.flipH).toBe('alternate');
    expect(brush.angleDynamics).toBe('tilt');
    expect(brush.colorMixing).toBe(true);
    expect(brush.perceptualMixing).toBe(true);
    expect(brush.amountOfPaint).toBeCloseTo(0.7, 4);
    expect(brush.densityOfPaint).toBeCloseTo(1.0, 4);
    expect(brush.colorStretch).toBeCloseTo(0.1, 4);
    expect(brush.paperTextureMode).toBe('subtract');
    expect(brush.textureDensity).toBeCloseTo(0.8, 4);
    expect(brush.paperTextureApplyEachPlot).toBe(true);

    // Effector tilt ceilings & TextureDensityEffector inverted pressure curve must survive parsing
    expect(brush.sizeSensor?.tiltMax).toBeCloseTo(3.5, 3);
    expect(brush.densitySensor?.tiltMax).toBeCloseTo(3.0, 3);
    expect(brush.textureDensitySensor?.usePressure).toBe(true);
    expect(brush.textureDensitySensor?.useTilt).toBe(true);
    expect(brush.textureDensitySensor?.useRandom).toBe(true);
    expect(brush.textureDensitySensor?.tiltMax).toBeCloseTo(3.5, 3);

    // C2F paper texture thumbnail fallback compensates TextureScale2=20% by sqrt(layerBytes/thumbBytes) (~3.74x -> ~0.75)
    expect(brush.paperTextureScale).toBeGreaterThan(0.6);
    expect(brush.paperTextureScale).toBeLessThan(0.95);

    // 2. Linear spherical tilt altitude: normal 35° pen tilt must NOT blow up width or collapse flow
    expect(computeCspTiltMagnitude(0, 0)).toBe(0);
    expect(computeCspTiltMagnitude(45, 0)).toBeCloseTo(0.5, 4);
    expect(computeCspTiltMagnitude(30, 18)).toBeCloseTo(33.53 / 90, 2);

    // 3. GPU dab parity: TextureDensityEffector lowers per-dab grainDensity at heavy pressure,
    //    pen-direction tilt azimuth uses atan2(tiltX, -tiltY), and tiltScale=1.0 never inflates CSP tilt brushes
    const dummySurf = createSoftwareCanvas(200, 200);
    const gpuCommonOpts = {
      size: brush.size,
      minSizeFactor: brush.minSizeFactor,
      flow: brush.flow,
      spacing: brush.spacing,
      hardness: brush.hardness,
      thickness: brush.thickness,
      thicknessVertical: brush.thicknessVertical,
      thicknessSensor: brush.thicknessSensor,
      angle: 0,
      angleDynamics: brush.angleDynamics,
      usePressure: true,
      useTilt: true,
      tiltScale: 1.0, // simulate NEUTRAL_BRUSH_DEFAULTS leakage; must NOT trigger synthetic side-shading!
      sizeSensor: brush.sizeSensor,
      densitySensor: brush.densitySensor,
      textureDensitySensor: brush.textureDensitySensor,
      grain: brush.textureDensity,
      textureDensity: brush.textureDensity,
      paperTextureMode: brush.paperTextureMode,
      paperTextureApplyEachPlot: brush.paperTextureApplyEachPlot,
      colorMixing: false,
      useGpu: true,
    };

    const lightGpuDabs: GpuDab[] = [];
    drawBrushDot(
      dummySurf.ctx,
      { x: 100, y: 100, pressure: 0.15, width: 45, tiltX: 28, tiltY: 12 },
      '#e82c20',
      gpuCommonOpts,
      lightGpuDabs
    );
    const heavyGpuDabs: GpuDab[] = [];
    drawBrushDot(
      dummySurf.ctx,
      { x: 100, y: 100, pressure: 0.95, width: 52.1, tiltX: 28, tiltY: 12 },
      '#e82c20',
      gpuCommonOpts,
      heavyGpuDabs
    );
    expect(lightGpuDabs.length).toBe(1);
    expect(heavyGpuDabs.length).toBe(1);
    // CSP pen-direction azimuth: atan2(28, -12) ≈ +1.976 rad (NOT atan2(12, 28) ≈ +0.405 rad)
    expect(heavyGpuDabs[0].angle).toBeCloseTo(Math.atan2(28, -12), 3);
    // Width at 30° normal tilt stays near nominal 52px (no 2x+ sin-curve or synthetic tiltScale blowup!)
    expect(heavyGpuDabs[0].height).toBeGreaterThan(48);
    expect(heavyGpuDabs[0].height).toBeLessThan(65);
    expect(heavyGpuDabs[0].width).toBeCloseTo(heavyGpuDabs[0].height * 0.5 * (0.7 + 0.3 * 0.95), 2);
    // Full flow preserved at normal 30° tilt thanks to BrushFlowEffector tiltMax=3.0 + linear altitude
    expect(heavyGpuDabs[0].alpha).toBeGreaterThan(0.95);
    // Inverted TextureDensityEffector: light pressure keeps high grainDensity, heavy pressure drops grainDensity sharply
    expect(lightGpuDabs[0].grainDensity).toBeDefined();
    expect(heavyGpuDabs[0].grainDensity).toBeDefined();
    expect(lightGpuDabs[0].grainDensity!).toBeGreaterThan(heavyGpuDabs[0].grainDensity! * 1.8);

    // 4. CPU SpatialTipMixer porous tip + subtract paper grain + live-vs-commit 1:1 draft parity
    // Build a deterministic 22%-porous 126x125 sponge tip & 128x128 black-on-transparent paper grain
    const porousTip = createSoftwareCanvas(126, 125);
    for (let y = 0; y < 125; y++) {
      for (let x = 0; x < 126; x++) {
        const nx = (x - 63) / 62;
        const ny = (y - 62.5) / 62;
        if (nx * nx + ny * ny > 1.08) continue;
        const h = ((Math.imul(x + 7, 73856093) ^ Math.imul(y + 13, 19349663)) >>> 0) % 100;
        if (h < 23) {
          const o = (y * 126 + x) << 2;
          porousTip.buf[o] = 255;
          porousTip.buf[o + 1] = 255;
          porousTip.buf[o + 2] = 255;
          porousTip.buf[o + 3] = 255;
        }
      }
    }
    const paperTex = createSoftwareCanvas(128, 128);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        // Multi-scale paper tooth with dark valleys (alpha ~0.85) and bright peaks (alpha ~0.35)
        const v =
          0.5 +
          0.28 * Math.sin(x * 0.45 + Math.cos(y * 0.35)) +
          0.22 * Math.cos(y * 0.52 - x * 0.25);
        const a = Math.max(0, Math.min(255, Math.round((1 - Math.max(0, Math.min(1, v))) * 220)));
        const o = (y * 128 + x) << 2;
        paperTex.buf[o] = 0;
        paperTex.buf[o + 1] = 0;
        paperTex.buf[o + 2] = 0;
        paperTex.buf[o + 3] = a;
      }
    }

    const origDoc = (globalThis as any).document;
    const origRaf = (globalThis as any).requestAnimationFrame;
    const origCancelRaf = (globalThis as any).cancelAnimationFrame;
    (globalThis as any).requestAnimationFrame = () => 1;
    (globalThis as any).cancelAnimationFrame = () => {};
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return createSoftwareCanvas(1, 1);
        }
        return {};
      },
    };
    try {
      const chalkSettings: BrushSettings = {
        size: brush.size,
        minSizeFactor: brush.minSizeFactor,
        color: '#e82c20',
        opacity: 1.0,
        flow: brush.flow,
        spacing: brush.spacing,
        hardness: brush.hardness,
        thickness: brush.thickness,
        thicknessVertical: brush.thicknessVertical,
        thicknessSensor: brush.thicknessSensor,
        flipH: brush.flipH,
        flipV: brush.flipV,
        customTipAngle: 0,
        customTipAngleDynamics: brush.angleDynamics,
        customTipImage: porousTip as unknown as HTMLImageElement,
        antiAlias: 1,
        usePressure: true,
        useTilt: true,
        tiltScale: 1.0,
        smoothing: true,
        stabilization: 0,
        pressureCurve: brush.pressureCurve,
        sizeSensor: brush.sizeSensor,
        densitySensor: brush.densitySensor,
        textureDensitySensor: brush.textureDensitySensor,
        colorMixing: true,
        perceptualMixing: true,
        amountOfPaint: brush.amountOfPaint,
        densityOfPaint: brush.densityOfPaint,
        colorStretch: brush.colorStretch,
        mixingMode: 'blend',
        grain: brush.textureDensity,
        textureDensity: brush.textureDensity,
        paperTextureImage: paperTex as unknown as HTMLImageElement,
        paperTextureScale: brush.paperTextureScale,
        paperTextureRotate: brush.paperTextureRotate,
        paperTextureMode: 'subtract',
        paperTextureApplyEachPlot: true,
        useGpu: false,
      };

      const renderStrokeStats = (pressure: number) => {
        const s = createSoftwareCanvas(220, 260);
        const pts: Point[] = Array.from({ length: 16 }, (_, i) => ({
          x: 110,
          y: 40 + i * 12,
          pressure,
          width: brush.size * (0.5 + 0.5 * pressure),
          tiltX: 28,
          tiltY: 12,
          twist: 0,
          timestamp: i * 10,
        }));
        renderCompleteStroke(s.ctx, pts, chalkSettings, 'brush');
        let sumA = 0, maxA = 0, litCnt = 0;
        for (let y = 80; y <= 180; y++) {
          for (let x = 70; x <= 150; x++) {
            const a = s.buf[(y * 220 + x) * 4 + 3];
            if (a > 10) {
              sumA += a;
              if (a > maxA) maxA = a;
              litCnt++;
            }
          }
        }
        return { meanA: litCnt > 0 ? sumA / litCnt : 0, maxA, litCnt };
      };

      const lightStats = renderStrokeStats(0.2);
      const heavyStats = renderStrokeStats(0.95);
      // Heavy pressure produces rich solid opaque red chalk core; light pressure stays airy & grainy
      expect(heavyStats.maxA).toBeGreaterThan(220);
      expect(heavyStats.meanA).toBeGreaterThan(145);
      expect(lightStats.meanA).toBeGreaterThan(15);
      expect(heavyStats.meanA).toBeGreaterThan(lightStats.meanA * 1.45);

      // Live drawing on a zoomed-out 1600x1200 canvas (zoom=0.4) must keep 1:1 draftScale for
      // colorMixing/customTipImage brushes so live canvas == committed tiles with ZERO pointer-up pop!
      const dims = { width: 1600, height: 1200 };
      const grid = new SparseTileGrid();
      const layerId = 'chalk-live-layer';
      const layers: LayerItem[] = [
        {
          id: layerId,
          name: 'Layer 1',
          type: 'raster',
          parentId: null,
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          alphaLocked: false,
        },
      ];
      const draftCanvas = createSoftwareCanvas(1600, 1200) as any;
      const state = createInitialStrokeSessionState();
      const params: any = {
        disabled: false,
        activeSessionId: 'chalk-live-test',
        viewportRef: { current: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480, right: 640, bottom: 480 }) } },
        interactionRef: { current: null },
        isDrawingRef: { current: false },
        panRef: { current: { x: 0, y: 0 } },
        zoomRef: { current: 0.4 },
        rotationRef: { current: 0 },
        flipXRef: { current: false },
        flipYRef: { current: false },
        toolOverrideRef: { current: 'brush' },
        brushSettingsOverrideRef: { current: chalkSettings },
        dimensionsRef: { current: dims },
        colorModeRef: { current: 'color' },
        activeLayerIdRef: { current: layerId },
        activeLayerLockedRef: { current: false },
        activeLayerVisibleRef: { current: true },
        layersRef: { current: layers },
        isMaskModeRef: { current: false },
        selectionRef: { current: null },
        effectiveDraftCanvasRef: { current: draftCanvas },
        predictedCanvasRef: { current: null },
        activeTileGridRef: { current: grid },
        lastStrokeEndRef: { current: null },
        rulerRef: { current: null },
        straightRulerRef: { current: null },
        getActiveMaskCanvas: () => null,
        flushPendingHistoryTasks: () => {},
        enqueueHistoryTask: () => {},
        pushHistoryStep: () => {},
        onUpdateLayerThumbnail: () => {},
        onUpdateMaskThumbnailRef: { current: null },
        onCollabStrokeStartRef: { current: null },
        onCollabStrokeChunkRef: { current: null },
        onCollabStrokeFinishRef: { current: null },
        onCollabCursorMoveRef: { current: null },
        onActiveConstraintAxisChangeRef: { current: undefined },
      };

      const helpers: any = {
        getTool: () => 'brush',
        getBrushSettings: () => chalkSettings,
        getPredictedCanvas: () => getPredictedCanvasElement(params.predictedCanvasRef),
        clearPredictedCanvas: () => clearPredictedCanvasSurface(state, () => null),
        emitConstraintAxisChange: (ax: any) => emitConstraintAxisChangeIfNeeded(state, params.onActiveConstraintAxisChangeRef, ax),
        markTouchedTiles: (x0: number, y0: number, x1: number, y1: number) => markTouchedTilesInRect(dims, state.touchedTiles, x0, y0, x1, y1),
        getViewportRect: () => getViewportRectCached(state, params.viewportRef),
        dispatchPointerStat: () => {},
        abortActiveStroke: () => abortActiveStrokeSession(params, state, () => {}, () => {}),
        getCanvasPoint: (ev: any) => computeCanvasPoint(ev, params, helpers.getViewportRect, helpers.getBrushSettings),
        resolveEffectiveOpacitySensor: resolveEffectiveOpacitySensorValue,
        resolveLiveAntiAlias: resolveLiveAntiAliasValue,
        buildTouchedTileSpans: (sx: number, sy: number, dw: number, dh: number) => buildTouchedTileSpansFromSet(state.touchedTiles, sx, sy, dw, dh),
        buildLiveBrushOptions: (...args: any[]) => (createLiveBrushOptions as any)(state, ...args),
        resolveStrokeColor: (bs: BrushSettings, isE: boolean, isBg: boolean, isM: boolean, m: any) => resolveStrokeColorValue(false, bs, isE, isBg, isM, m),
        emitLiveSegment: (...args: any[]) => (emitLiveSegmentToDraft as any)(state, params, helpers, ...args),
        renderPredictedStroke: () => {},
        flushPendingPoints: (skip?: boolean) => runFlushPendingPoints(state, params, helpers, skip),
      };

      const mkEv = (clientX: number, clientY: number, pressure: number, ts: number) => {
        const ev: any = {
          pointerId: 1,
          pointerType: 'pen',
          button: 0,
          buttons: 1,
          clientX,
          clientY,
          pressure,
          tiltX: 28,
          tiltY: 12,
          twist: 0,
          timeStamp: ts,
          shiftKey: false,
          altKey: false,
          preventDefault() {},
        };
        ev.nativeEvent = ev;
        return ev;
      };

      runPointerDown(state, params, helpers, mkEv(200, 140, 0.75, 0));
      // Must stay 1:1 native scale at zoom=0.4 so porous tip is never bilinearly diluted
      expect(draftCanvas.__draftScale).toBeCloseTo(1.0, 5);

      for (let i = 1; i <= 10; i++) {
        const ev = mkEv(200, 140 + i * 10, 0.85, i * 16);
        runPointerMove(state, params, helpers, ev, [ev]);
      }
      runFlushPendingPoints(state, params, helpers, true);

      // Snapshot live draft alpha BEFORE pointerUp
      let liveAlphaSum = 0;
      for (let i = 3; i < draftCanvas.buf.length; i += 4) liveAlphaSum += draftCanvas.buf[i];
      expect(liveAlphaSum).toBeGreaterThan(50000);

      runPointerUp(state, params, helpers, mkEv(200, 240, 0, 180));

      // Compare committed tile alpha against live draft alpha: direct 1:1 commit means zero pop!
      const committedImg = grid.readImageData(layerId, 0, 0, 1600, 1200);
      let committedAlphaSum = 0;
      for (let i = 3; i < committedImg.data.length; i += 4) committedAlphaSum += committedImg.data[i];
      const ratio = committedAlphaSum / Math.max(1, liveAlphaSum);
      expect(ratio).toBeGreaterThan(0.95);
      expect(ratio).toBeLessThan(1.25);
    } finally {
      (globalThis as any).document = origDoc;
      (globalThis as any).requestAnimationFrame = origRaf;
      (globalThis as any).cancelAnimationFrame = origCancelRaf;
    }
  });
});
