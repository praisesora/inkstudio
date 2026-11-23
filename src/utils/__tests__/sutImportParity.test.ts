import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseCspEffector,
  parseCspInOutTarget,
  parseSutExtractedData,
} from '../sutParser';
import { NativeSutExtract } from '../nativeBackend';
import {
  centripetalCatmullRomToBezier,
  buildCubicArcLengthTable,
  getCubicPointAtArcLength,
  renderCompleteStroke,
} from '../../engine/BrushEngine';
import { LayerPixelSampler } from '../colorMixingEngine';
import { BrushSettings, Point } from '../../types/editor';

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
    putImageData: (img: { width: number; height: number; data: Uint8ClampedArray }, dx = 0, dy = 0) => {
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
    expect(brush.paperTextureMode).toBe('multiply');
    expect(brush.paperTextureApplyEachPlot).toBe(true);
    expect(brush.textureDensity).toBeCloseTo(0.62, 4);
    expect(brush.spacing).toBeCloseTo(0.003, 5); // 0.3% = 0.003, NOT 30%!
    expect(brush.thickness).toBeCloseTo(0.17, 4);
    expect(brush.angleDynamics).toBe('direction');
    expect(brush.angle).toBe(90); // CSP 12-o'clock forward -> +90 deg
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
});
