import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildRibbonMeshFromPoints,
  isRibbonBrush,
  rasterizeRibbonMeshCpu,
  renderCompleteRibbonStroke,
  resolveRibbonRepeatMode,
  RIBBON_VERTEX_STRIDE,
  RibbonRenderOptions,
  RibbonStrokeSession,
  RibbonTipSurface,
  selectRibbonSubTipIndex,
} from '../../engine/RibbonBrushEngine';
import { centripetalCatmullRomToBezier, renderCompleteStroke } from '../../engine/BrushEngine';
import { WebGlBrushEngine } from '../../engine/WebGlBrushEngine';
import { BrushSettings, Point } from '../../types/editor';

/**
 * Software-compositing mock Canvas2D for deterministic headless raster verification.
 */
function createRasterMockCanvas(width: number, height: number) {
  const pixelBuffer = new Uint8ClampedArray(width * height * 4);
  let curW = width;
  let curH = height;
  let buf = pixelBuffer;

  const resize = (nw: number, nh: number) => {
    curW = Math.max(1, Math.round(nw));
    curH = Math.max(1, Math.round(nh));
    buf = new Uint8ClampedArray(curW * curH * 4);
    mockObj.pixelBuffer = buf;
  };

  let tx = 0;
  let ty = 0;
  const stack: Array<{ tx: number; ty: number; alpha: number; op: string }> = [];

  const ctx: any = {
    canvas: {
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
    },
    globalAlpha: 1.0,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    save() {
      stack.push({ tx, ty, alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation });
    },
    restore() {
      const s = stack.pop();
      if (s) {
        tx = s.tx;
        ty = s.ty;
        ctx.globalAlpha = s.alpha;
        ctx.globalCompositeOperation = s.op;
      }
    },
    translate(dx: number, dy: number) {
      tx += dx;
      ty += dy;
    },
    resetTransform() {
      tx = 0;
      ty = 0;
    },
    clearRect() {
      buf.fill(0);
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
      const copyW = useSub ? sw! : sw ?? srcW;
      const copyH = useSub ? sh! : sh ?? srcH;
      const dstX0 = Math.round((useSub ? dx! : sx) + tx);
      const dstY0 = Math.round((useSub ? dy! : sy) + ty);
      const alphaScale = Math.max(0, Math.min(1, ctx.globalAlpha));

      for (let y = 0; y < copyH; y++) {
        const py = dstY0 + y;
        const syi = srcY0 + y;
        if (py < 0 || py >= curH || syi < 0 || syi >= srcH) continue;
        for (let x = 0; x < copyW; x++) {
          const px = dstX0 + x;
          const sxi = srcX0 + x;
          if (px < 0 || px >= curW || sxi < 0 || sxi >= srcW) continue;
          const si = (syi * srcW + sxi) * 4;
          const srcA = (srcBuf[si + 3] / 255) * alphaScale;
          if (srcA <= 0.001) continue;
          const di = (py * curW + px) * 4;
          const dstA = buf[di + 3] / 255;
          if (ctx.globalCompositeOperation === 'destination-out') {
            buf[di + 3] = Math.round(dstA * (1 - srcA) * 255);
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

  const mockObj = {
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
  return mockObj;
}

function makeSolidColorTip(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a: number = 255
): RibbonTipSurface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = a;
  }
  return { data, width, height, isColor: true };
}

function makeDirectionalGradientColorTip(width: number = 32, height: number = 16): RibbonTipSurface {
  // u = 0 -> pure Red (255, 0, 0), u = 1 -> pure Blue (0, 0, 255)
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = x / Math.max(1, width - 1);
      const p = (y * width + x) * 4;
      data[p] = Math.round(255 * (1 - t));
      data[p + 1] = 0;
      data[p + 2] = Math.round(255 * t);
      data[p + 3] = 255;
    }
  }
  return { data, width, height, isColor: true };
}

function makeChainStripedTip(width: number = 32, height: number = 16): RibbonTipSurface {
  // Continuous chain-stripe along v in [0.25, 0.75] with bright outer rails
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const inBand = v >= 0.2 && v <= 0.8;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      if (inBand) {
        data[p] = 255;
        data[p + 1] = 255;
        data[p + 2] = 255;
        data[p + 3] = 255;
      }
    }
  }
  return { data, width, height, isColor: false };
}

function makeDualToneTip(width: number = 32, height: number = 16): RibbonTipSurface {
  // Top half (v < 0.5): black (lum = 0 -> primaryColor)
  // Bottom half (v >= 0.5): white (lum = 1 -> secondaryColor)
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const lum = y < height / 2 ? 0 : 255;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      data[p] = lum;
      data[p + 1] = lum;
      data[p + 2] = lum;
      data[p + 3] = 255;
    }
  }
  return { data, width, height, isColor: false, isDualToneTip: true };
}

function readPixel(buf: Uint8ClampedArray, width: number, x: number, y: number) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  const p = (iy * width + ix) * 4;
  return { r: buf[p], g: buf[p + 1], b: buf[p + 2], a: buf[p + 3] };
}

function createFakeTipImage(surface: RibbonTipSurface): HTMLImageElement {
  return {
    width: surface.width,
    height: surface.height,
    naturalWidth: surface.width,
    naturalHeight: surface.height,
    complete: true,
    src: `data:image/png;base64,test_${surface.width}x${surface.height}`,
    __rgbaData: surface.data,
  } as unknown as HTMLImageElement;
}

describe('Clip Studio Paint Ribbon Brush Engine (BrushRibbon = 1)', () => {
  beforeEach(() => {
    (globalThis as any).document = {
      createElement(tag: string) {
        if (tag === 'canvas') {
          return createRasterMockCanvas(64, 64);
        }
        return {};
      },
    };
  });

  describe('1. Predicate & Routing Rules', () => {
    it('routes isRibbon=true brushes unless NaturalPaint or Spray is active', () => {
      expect(isRibbonBrush({ isRibbon: true })).toBe(true);
      expect(isRibbonBrush({ isRibbon: false })).toBe(false);
      expect(isRibbonBrush({})).toBe(false);
      expect(isRibbonBrush({ isRibbon: true, spray: { enabled: true, size: 4, density: 4, bias: 0 } })).toBe(false);
      expect(isRibbonBrush({ isRibbon: true, renderMode: 'bristle-ribbon' })).toBe(false);
      expect(isRibbonBrush({ isRibbon: true, naturalPaint: { enabled: true } as any })).toBe(false);
      expect(isRibbonBrush({ isRibbon: true, impasto: { enabled: true } as any })).toBe(false);
    });

    it('resolves repeat modes cleanly from subTipOrder and explicit overrides', () => {
      expect(resolveRibbonRepeatMode(undefined)).toBe('repeat');
      expect(resolveRibbonRepeatMode('sequential')).toBe('repeat');
      expect(resolveRibbonRepeatMode('reverse')).toBe('reverse');
      expect(resolveRibbonRepeatMode('once')).toBe('once');
      expect(resolveRibbonRepeatMode('sequential', 'reverse')).toBe('reverse');
      expect(resolveRibbonRepeatMode('sequential', 'once')).toBe('once');
    });
  });

  describe('2. S-Curve Continuity & Anti-Bowtie Corner Geometry', () => {
    it('bends a striped chain tip continuously along an S-curve with zero stepping gaps and zero bowties', () => {
      const sCurvePoints: Point[] = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const x = 20 + t * 220;
        const y = 90 + Math.sin(t * Math.PI * 2) * 45;
        sCurvePoints.push({ x, y, pressure: 0.8, width: 24 });
      }

      const tip = makeChainStripedTip(32, 16);
      const opts: RibbonRenderOptions = {
        size: 24,
        angle: 90,
        primaryColor: '#1144cc',
        tipSurfaces: [tip],
        antiAlias: 2,
      };

      const mesh = buildRibbonMeshFromPoints(sCurvePoints, opts);
      expect(mesh.triangleCount).toBeGreaterThan(40);

      // Every single triangle must have consistent non-inverted winding (signedArea < 0 => zero bowties)
      for (let t = 0; t < mesh.triangleCount; t++) {
        const b = t * 3 * RIBBON_VERTEX_STRIDE;
        const x0 = mesh.vertices[b];
        const y0 = mesh.vertices[b + 1];
        const x1 = mesh.vertices[b + RIBBON_VERTEX_STRIDE];
        const y1 = mesh.vertices[b + RIBBON_VERTEX_STRIDE + 1];
        const x2 = mesh.vertices[b + RIBBON_VERTEX_STRIDE * 2];
        const y2 = mesh.vertices[b + RIBBON_VERTEX_STRIDE * 2 + 1];
        const signedArea = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
        expect(signedArea).toBeLessThan(0);
      }

      const raster = rasterizeRibbonMeshCpu(mesh, opts, 260, 180, 0, 0);

      // Verify every centerline sample along the entire S-curve is continuously painted (zero discrete gaps)
      let coveredSamples = 0;
      for (let i = 1; i < mesh.centerline.length - 1; i++) {
        const c = mesh.centerline[i];
        const px = readPixel(raster.data, raster.width, c.x, c.y);
        if (px.a > 180) coveredSamples++;
      }
      expect(coveredSamples).toBe(mesh.centerline.length - 2);
    });

    it('prevents bowtie fold-overs on sharp 90-degree, 150-degree, and 180-degree hairpin bends', () => {
      const sharpPoints: Point[] = [
        { x: 20, y: 80, pressure: 1.0, width: 32 },
        { x: 100, y: 80, pressure: 1.0, width: 32, isCorner: true },
        { x: 100, y: 160, pressure: 1.0, width: 32, isCorner: true }, // 90 deg
        { x: 50, y: 95, pressure: 1.0, width: 32, isCorner: true },   // ~140 deg
        { x: 52, y: 170, pressure: 1.0, width: 32 },                  // hairpin turn
      ];

      const mesh = buildRibbonMeshFromPoints(sharpPoints, {
        size: 32,
        tipSurfaces: [makeSolidColorTip(32, 32, 200, 50, 50)],
      });

      expect(mesh.triangleCount).toBeGreaterThan(20);
      for (let t = 0; t < mesh.triangleCount; t++) {
        const b = t * 3 * RIBBON_VERTEX_STRIDE;
        const x0 = mesh.vertices[b];
        const y0 = mesh.vertices[b + 1];
        const x1 = mesh.vertices[b + RIBBON_VERTEX_STRIDE];
        const y1 = mesh.vertices[b + RIBBON_VERTEX_STRIDE + 1];
        const x2 = mesh.vertices[b + RIBBON_VERTEX_STRIDE * 2];
        const y2 = mesh.vertices[b + RIBBON_VERTEX_STRIDE * 2 + 1];
        const signedArea = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
        expect(signedArea).toBeLessThan(0);
        expect(Number.isFinite(x0) && Number.isFinite(y0)).toBe(true);
      }

      // Miter clamping prevents runaway spikes far outside the stroke hull
      expect(mesh.bounds.maxX).toBeLessThan(140);
      expect(mesh.bounds.minX).toBeGreaterThan(0);
    });
  });

  describe('3. Aspect-Preserving UV Scaling, Thickness, and Base Angle', () => {
    it('scales tile period proportionally with local width under varying pen pressure', () => {
      const narrowPts: Point[] = [
        { x: 10, y: 40, pressure: 0.5, width: 20 },
        { x: 110, y: 40, pressure: 0.5, width: 20 },
      ];
      const widePts: Point[] = [
        { x: 10, y: 40, pressure: 1.0, width: 40 },
        { x: 110, y: 40, pressure: 1.0, width: 40 },
      ];

      const tip = makeSolidColorTip(32, 32, 255, 0, 0);
      const narrowMesh = buildRibbonMeshFromPoints(narrowPts, { size: 40, tipSurfaces: [tip] });
      const wideMesh = buildRibbonMeshFromPoints(widePts, { size: 40, tipSurfaces: [tip] });

      const narrowTiles = narrowMesh.centerline[narrowMesh.centerline.length - 1].sNorm;
      const wideTiles = wideMesh.centerline[wideMesh.centerline.length - 1].sNorm;

      // 100px at width 20 => 5.0 tiles; 100px at width 40 => 2.5 tiles
      expect(narrowTiles).toBeCloseTo(5.0, 1);
      expect(wideTiles).toBeCloseTo(2.5, 1);
      expect(narrowTiles / wideTiles).toBeCloseTo(2.0, 1);
    });

    it('respects CSP ribbon orientation (0 deg vertical, 90 deg horizontal), width scaling, and thickness', () => {
      const pts: Point[] = [
        { x: 20, y: 50, pressure: 1, width: 40 },
        { x: 140, y: 50, pressure: 1, width: 40 },
      ];
      const gradTip = makeDirectionalGradientColorTip(32, 32);

      // CSP Ribbon convention: at angle = 90°, tip +X (Red->Blue) flows ALONG the stroke
      const opts90: RibbonRenderOptions = {
        size: 40,
        angle: 90,
        tipSurfaces: [gradTip],
        ribbonRepeatMode: 'once',
        isColorTip: true,
        antiAlias: 1,
      };
      const r90 = rasterizeRibbonMeshCpu(buildRibbonMeshFromPoints(pts, opts90), opts90, 160, 100, 0, 0);
      const startPx90 = readPixel(r90.data, r90.width, 30, 50);
      const endPx90 = readPixel(r90.data, r90.width, 130, 50);
      expect(startPx90.r).toBeGreaterThan(200);
      expect(endPx90.b).toBeGreaterThan(200);

      // At angle = 0°, tip +Y flows ALONG the stroke and tip +X (Red->Blue) runs ACROSS the stroke
      const opts0: RibbonRenderOptions = { ...opts90, angle: 0 };
      const r0 = rasterizeRibbonMeshCpu(buildRibbonMeshFromPoints(pts, opts0), opts0, 160, 100, 0, 0);
      const topPx0 = readPixel(r0.data, r0.width, 80, 36);
      const botPx0 = readPixel(r0.data, r0.width, 80, 64);
      expect(topPx0.b).toBeGreaterThan(topPx0.r);
      expect(botPx0.r).toBeGreaterThan(botPx0.b);

      // At angle = 0°, tip X is across-stroke and tip Y is along-stroke:
      // thicknessVertical=true (CSP BrushVerticalThicknes=0) scales X (across-stroke width);
      // thicknessVertical=false (CSP BrushVerticalThicknes=1) scales Y (along-stroke period).
      const thinAlongMesh = buildRibbonMeshFromPoints(pts, {
        size: 40,
        angle: 0,
        thickness: 0.5,
        thicknessVertical: false,
        tipSurfaces: [gradTip],
      });
      const thinAcrossMesh = buildRibbonMeshFromPoints(pts, {
        size: 40,
        angle: 0,
        thickness: 0.5,
        thicknessVertical: true,
        tipSurfaces: [gradTip],
      });
      expect(thinAcrossMesh.centerline[0].ribbonWidth).toBeCloseTo(20, 1);
      expect(thinAcrossMesh.centerline[0].tilePeriod).toBeCloseTo(40, 1);
      expect(thinAlongMesh.centerline[0].ribbonWidth).toBeCloseTo(40, 1);
      expect(thinAlongMesh.centerline[0].tilePeriod).toBeCloseTo(20, 1);

      // Elongated ribbon tips (e.g. CSP Chain.sut 300x27 at angle=90° and vertical 27x300 at angle=0°)
      // must keep ribbonWidth == BrushSize and preserve the natural aspect ratio along the stroke!
      const horizChainMesh = buildRibbonMeshFromPoints(pts, {
        size: 40,
        angle: 90,
        tipSurfaces: [makeSolidColorTip(300, 27, 255, 0, 0)],
      });
      expect(horizChainMesh.centerline[0].ribbonWidth).toBeCloseTo(40, 1);
      expect(horizChainMesh.centerline[0].tilePeriod).toBeCloseTo((40 * 300) / 27, 1);

      const vertChainMesh = buildRibbonMeshFromPoints(pts, {
        size: 40,
        angle: 0,
        tipSurfaces: [makeSolidColorTip(27, 300, 255, 0, 0)],
      });
      expect(vertChainMesh.centerline[0].ribbonWidth).toBeCloseTo(40, 1);
      expect(vertChainMesh.centerline[0].tilePeriod).toBeCloseTo((40 * 300) / 27, 1);
    });
  });

  describe('4. Repeat Modes (repeat, reverse, once) & Multi-SubTip Arrays', () => {
    it('renders repeat, reverse (ping-pong mirror), and once (full-stroke stretch) accurately', () => {
      // 120px stroke with 40px square tip => 3 tiles in repeat/reverse, 1 stretched tile in once
      const pts: Point[] = [
        { x: 10, y: 40, pressure: 1, width: 40 },
        { x: 130, y: 40, pressure: 1, width: 40 },
      ];
      const gradTip = makeDirectionalGradientColorTip(32, 32);

      // REPEAT: tile 0 [10..50] R->B, tile 1 [50..90] R->B, tile 2 [90..130] R->B
      const optsRep: RibbonRenderOptions = {
        size: 40,
        angle: 90,
        tipSurfaces: [gradTip],
        ribbonRepeatMode: 'repeat',
        isColorTip: true,
        antiAlias: 1,
      };
      const rRep = rasterizeRibbonMeshCpu(buildRibbonMeshFromPoints(pts, optsRep), optsRep, 150, 80, 0, 0);
      expect(readPixel(rRep.data, 150, 14, 40).r).toBeGreaterThan(200); // start of tile 0 = Red
      expect(readPixel(rRep.data, 150, 54, 40).r).toBeGreaterThan(200); // start of tile 1 = Red
      expect(readPixel(rRep.data, 150, 86, 40).b).toBeGreaterThan(200); // end of tile 1 = Blue

      // REVERSE: tile 0 [10..50] R->B, tile 1 [50..90] B->R (mirrored!), tile 2 [90..130] R->B
      const optsRev: RibbonRenderOptions = { ...optsRep, ribbonRepeatMode: 'reverse' };
      const rRev = rasterizeRibbonMeshCpu(buildRibbonMeshFromPoints(pts, optsRev), optsRev, 150, 80, 0, 0);
      expect(readPixel(rRev.data, 150, 14, 40).r).toBeGreaterThan(200); // start of tile 0 = Red
      expect(readPixel(rRev.data, 150, 46, 40).b).toBeGreaterThan(200); // end of tile 0 = Blue
      expect(readPixel(rRev.data, 150, 54, 40).b).toBeGreaterThan(200); // start of tile 1 = Blue (seamless!)
      expect(readPixel(rRev.data, 150, 86, 40).r).toBeGreaterThan(200); // end of tile 1 = Red

      // ONCE: u stretches 0..1 across entire [10..130], so midpoint x=70 is ~50% purple (R~127, B~127)
      const optsOnce: RibbonRenderOptions = { ...optsRep, ribbonRepeatMode: 'once' };
      const rOnce = rasterizeRibbonMeshCpu(buildRibbonMeshFromPoints(pts, optsOnce), optsOnce, 150, 80, 0, 0);
      const midPx = readPixel(rOnce.data, 150, 70, 40);
      expect(midPx.r).toBeGreaterThan(100);
      expect(midPx.r).toBeLessThan(155);
      expect(midPx.b).toBeGreaterThan(100);
      expect(midPx.b).toBeLessThan(155);
    });

    it('cycles multi-subTip arrays sequentially, reversed, and deterministically random', () => {
      const tipR = makeSolidColorTip(32, 32, 240, 20, 20);
      const tipG = makeSolidColorTip(32, 32, 20, 240, 20);
      const tipB = makeSolidColorTip(32, 32, 20, 20, 240);
      const pts: Point[] = [
        { x: 10, y: 40, pressure: 1, width: 30 },
        { x: 190, y: 40, pressure: 1, width: 30 }, // 180px => 6 tiles of 30px
      ];

      // Sequential: [R, G, B, R, G, B]
      const seqOpts: RibbonRenderOptions = {
        size: 30,
        tipSurfaces: [tipR, tipG, tipB],
        subTipOrder: 'sequential',
        isColorTip: true,
        antiAlias: 1,
      };
      const rSeq = rasterizeRibbonMeshCpu(buildRibbonMeshFromPoints(pts, seqOpts), seqOpts, 210, 80, 0, 0);
      expect(readPixel(rSeq.data, 210, 25, 40).r).toBeGreaterThan(200);  // tile 0 = R
      expect(readPixel(rSeq.data, 210, 55, 40).g).toBeGreaterThan(200);  // tile 1 = G
      expect(readPixel(rSeq.data, 210, 85, 40).b).toBeGreaterThan(200);  // tile 2 = B
      expect(readPixel(rSeq.data, 210, 115, 40).r).toBeGreaterThan(200); // tile 3 = R

      // Reversed: [B, G, R, B, G, R]
      const revOpts: RibbonRenderOptions = { ...seqOpts, subTipOrder: 'reverse' };
      const rRev = rasterizeRibbonMeshCpu(buildRibbonMeshFromPoints(pts, revOpts), revOpts, 210, 80, 0, 0);
      expect(readPixel(rRev.data, 210, 25, 40).b).toBeGreaterThan(200); // tile 0 = B
      expect(readPixel(rRev.data, 210, 55, 40).g).toBeGreaterThan(200); // tile 1 = G
      expect(readPixel(rRev.data, 210, 85, 40).r).toBeGreaterThan(200); // tile 2 = R

      // Deterministic random & random-no-repeat
      const seqA = Array.from({ length: 12 }, (_, k) =>
        selectRibbonSubTipIndex(3, 'random', k, 0, 10, 40)
      );
      const seqB = Array.from({ length: 12 }, (_, k) =>
        selectRibbonSubTipIndex(3, 'random', k, 0, 10, 40)
      );
      expect(seqA).toEqual(seqB);

      const noRep = Array.from({ length: 12 }, (_, k) =>
        selectRibbonSubTipIndex(3, 'random-no-repeat', k, 0, 10, 40)
      );
      for (let i = 1; i < noRep.length; i++) {
        expect(noRep[i]).not.toBe(noRep[i - 1]);
      }
    });
  });

  describe('5. Dual-Tone Tips, FlipH/FlipV, Taper, Anti-Aliasing & Paper Texture', () => {
    it('renders isDualToneTip blending primaryColor (black) and secondaryColor (white)', () => {
      const pts: Point[] = [
        { x: 10, y: 40, pressure: 1, width: 32 },
        { x: 110, y: 40, pressure: 1, width: 32 },
      ];
      const dualTip = makeDualToneTip(32, 32);
      const opts: RibbonRenderOptions = {
        size: 32,
        angle: 90,
        tipSurfaces: [dualTip],
        isDualToneTip: true,
        primaryColor: '#e02020',
        secondaryColor: '#20d040',
        antiAlias: 1,
      };

      const raster = rasterizeRibbonMeshCpu(buildRibbonMeshFromPoints(pts, opts), opts, 130, 80, 0, 0);
      const topHalf = readPixel(raster.data, 130, 60, 32); // v < 0.5 -> black -> primaryColor (#e02020)
      const botHalf = readPixel(raster.data, 130, 60, 48); // v > 0.5 -> white -> secondaryColor (#20d040)

      expect(topHalf.r).toBeGreaterThan(200);
      expect(topHalf.g).toBeLessThan(60);
      expect(botHalf.g).toBeGreaterThan(180);
      expect(botHalf.r).toBeLessThan(60);
    });

    it('supports per-tile flipH and flipV alternation', () => {
      const pts: Point[] = [
        { x: 10, y: 40, pressure: 1, width: 40 },
        { x: 90, y: 40, pressure: 1, width: 40 }, // 2 tiles: [10..50] and [50..90]
      ];
      const gradTip = makeDirectionalGradientColorTip(32, 32);
      const optsFlipH: RibbonRenderOptions = {
        size: 40,
        angle: 90,
        tipSurfaces: [gradTip],
        isColorTip: true,
        flipH: 'alternate',
        antiAlias: 1,
      };
      const rH = rasterizeRibbonMeshCpu(buildRibbonMeshFromPoints(pts, optsFlipH), optsFlipH, 110, 80, 0, 0);
      // Tile 0 not flipped: start is Red; Tile 1 flipped horizontally: start is Blue!
      expect(readPixel(rH.data, 110, 14, 40).r).toBeGreaterThan(200);
      expect(readPixel(rH.data, 110, 54, 40).b).toBeGreaterThan(200);

      const dualTip = makeDualToneTip(32, 32);
      const optsFlipV: RibbonRenderOptions = {
        size: 40,
        angle: 90,
        tipSurfaces: [dualTip],
        isDualToneTip: true,
        primaryColor: '#ff0000',
        secondaryColor: '#0000ff',
        flipV: 'alternate',
        antiAlias: 1,
      };
      const rV = rasterizeRibbonMeshCpu(buildRibbonMeshFromPoints(pts, optsFlipV), optsFlipV, 110, 80, 0, 0);
      // Tile 0 top is Red, Tile 1 is flipped vertically so top is Blue!
      expect(readPixel(rV.data, 110, 30, 30).r).toBeGreaterThan(200);
      expect(readPixel(rV.data, 110, 70, 30).b).toBeGreaterThan(200);
    });

    it('applies CSP taper (in & out) to ribbon width and alpha', () => {
      const pts: Point[] = [
        { x: 10, y: 40, pressure: 1, width: 30 },
        { x: 110, y: 40, pressure: 1, width: 30 },
        { x: 210, y: 40, pressure: 1, width: 30 },
      ];
      const mesh = buildRibbonMeshFromPoints(pts, {
        size: 30,
        tipSurfaces: [makeSolidColorTip(32, 32, 0, 0, 0)],
        taper: {
          useIn: true,
          inLength: 50,
          inRatio: 0.25,
          useOut: true,
          outLength: 50,
          outRatio: 0.25,
          inOutType: 2,
          affectSize: true,
          affectOpacity: true,
          minSizeRatio: 0.1,
          minDensityRatio: 0.1,
        },
      });

      const first = mesh.centerline[0];
      const mid = mesh.centerline[Math.floor(mesh.centerline.length / 2)];
      const last = mesh.centerline[mesh.centerline.length - 1];

      expect(first.ribbonWidth).toBeLessThan(mid.ribbonWidth * 0.5);
      expect(last.ribbonWidth).toBeLessThan(mid.ribbonWidth * 0.5);
      expect(first.alpha).toBeLessThan(mid.alpha * 0.6);
      expect(last.alpha).toBeLessThan(mid.alpha * 0.6);
    });

    it('enforces binary alpha at antiAlias=0 and modulates alpha with world-space paperTexture', () => {
      const pts: Point[] = [
        { x: 10, y: 40, pressure: 0.35, width: 26 },
        { x: 130, y: 55, pressure: 0.35, width: 26 }, // slight slope to test AA edges
      ];
      const solidTip = makeSolidColorTip(32, 32, 20, 20, 20);

      // AA = 0 -> strictly binary alpha (0 or 255)
      const optsAA0: RibbonRenderOptions = { size: 26, tipSurfaces: [solidTip], antiAlias: 0 };
      const rAA0 = rasterizeRibbonMeshCpu(buildRibbonMeshFromPoints(pts, optsAA0), optsAA0, 150, 90, 0, 0);
      let intermediateAA0 = 0;
      for (let i = 3; i < rAA0.data.length; i += 4) {
        if (rAA0.data[i] > 0 && rAA0.data[i] < 255) intermediateAA0++;
      }
      expect(intermediateAA0).toBe(0);

      // AA = 2 -> smooth edge pixels have intermediate alpha
      const optsAA2: RibbonRenderOptions = { size: 26, tipSurfaces: [solidTip], antiAlias: 2 };
      const rAA2 = rasterizeRibbonMeshCpu(buildRibbonMeshFromPoints(pts, optsAA2), optsAA2, 150, 90, 0, 0);
      let intermediateAA2 = 0;
      for (let i = 3; i < rAA2.data.length; i += 4) {
        if (rAA2.data[i] > 0 && rAA2.data[i] < 255) intermediateAA2++;
      }
      expect(intermediateAA2).toBeGreaterThan(20);

      // Paper texture modulation reduces alpha in paper valleys and introduces spatial grain variance
      const optsPaper: RibbonRenderOptions = {
        size: 26,
        tipSurfaces: [solidTip],
        grain: 0.85,
        paperTextureMode: 'subtract',
        paperTextureApplyEachPlot: true,
        antiAlias: 2,
      };
      const rPaper = rasterizeRibbonMeshCpu(buildRibbonMeshFromPoints(pts, optsPaper), optsPaper, 150, 90, 0, 0);
      let sumPlain = 0;
      let sumPaper = 0;
      let diffPixels = 0;
      for (let i = 3; i < rAA2.data.length; i += 4) {
        sumPlain += rAA2.data[i];
        sumPaper += rPaper.data[i];
        if (rAA2.data[i] > 200 && Math.abs(rAA2.data[i] - rPaper.data[i]) > 15) {
          diffPixels++;
        }
      }
      expect(sumPaper).toBeLessThan(sumPlain * 0.92);
      expect(diffPixels).toBeGreaterThan(100);
    });
  });

  describe('6. End-to-End Integration (renderCompleteStroke & Live RibbonStrokeSession)', () => {
    it('routes renderCompleteStroke with isRibbon=true into RibbonBrushEngine CPU fallback', () => {
      const target = createRasterMockCanvas(180, 100);
      const ctx = target.getContext('2d') as unknown as CanvasRenderingContext2D;
      const dualTipImg = createFakeTipImage(makeDualToneTip(32, 32));

      const bs: BrushSettings = {
        size: 28,
        minSizeFactor: 0.2,
        color: '#d81b60',
        secondaryColor: '#00acc1',
        opacity: 1.0,
        flow: 1.0,
        spacing: 0.1,
        usePressure: true,
        smoothing: false,
        stabilization: 0,
        hardness: 1.0,
        isRibbon: true,
        isDualToneTip: true,
        customTipImage: dualTipImg,
        useGpu: false,
      };

      const pts: Point[] = [
        { x: 20, y: 50, pressure: 1, width: 28 },
        { x: 80, y: 35, pressure: 1, width: 28 },
        { x: 150, y: 60, pressure: 1, width: 28 },
      ];

      renderCompleteStroke(ctx, pts, bs, 'brush', 'color');

      // Check that pixels along the curved stroke were actually painted with both dual-tone colors
      let primaryHits = 0;
      let secondaryHits = 0;
      for (let i = 0; i < target.pixelBuffer.length; i += 4) {
        if (target.pixelBuffer[i + 3] < 200) continue;
        const r = target.pixelBuffer[i];
        const g = target.pixelBuffer[i + 1];
        const b = target.pixelBuffer[i + 2];
        if (r > 180 && g < 60) primaryHits++;
        if (g > 140 && b > 150 && r < 60) secondaryHits++;
      }
      expect(primaryHits).toBeGreaterThan(200);
      expect(secondaryHits).toBeGreaterThan(200);
    });

    it('stitches consecutive live CubicBezierSegments seamlessly via RibbonStrokeSession', () => {
      const target = createRasterMockCanvas(200, 100);
      const ctx = target.getContext('2d') as unknown as CanvasRenderingContext2D;
      const tip = makeChainStripedTip(32, 16);
      const opts: RibbonRenderOptions = {
        size: 24,
        angle: 90,
        primaryColor: '#228833',
        tipSurfaces: [tip],
        useGpu: false,
      };

      const p0: Point = { x: 15, y: 50, pressure: 1, width: 24 };
      const p1: Point = { x: 75, y: 30, pressure: 1, width: 24 };
      const p2: Point = { x: 135, y: 70, pressure: 1, width: 24 };
      const p3: Point = { x: 185, y: 45, pressure: 1, width: 24 };

      const s1 = centripetalCatmullRomToBezier(p0, p0, p1, p2);
      const s2 = centripetalCatmullRomToBezier(p0, p1, p2, p3);
      const s3 = centripetalCatmullRomToBezier(p1, p2, p3, p3);

      const session = new RibbonStrokeSession();
      const m1 = session.appendCubicSegment(ctx, { p0, c1: s1.c1, c2: s1.c2, p3: p1 }, opts);
      const m2 = session.appendCubicSegment(ctx, { p0: p1, c1: s2.c1, c2: s2.c2, p3: p2 }, opts);
      const m3 = session.appendCubicSegment(ctx, { p0: p2, c1: s3.c1, c2: s3.c2, p3 }, opts);

      expect(m1 && m1.triangleCount).toBeGreaterThan(4);
      expect(m2 && m2.triangleCount).toBeGreaterThan(4);
      expect(m3 && m3.triangleCount).toBeGreaterThan(4);

      // Verify both join knots (p1 and p2) are solidly painted with zero seam crack
      expect(readPixel(target.pixelBuffer, 200, p1.x, p1.y).a).toBeGreaterThan(200);
      expect(readPixel(target.pixelBuffer, 200, p2.x, p2.y).a).toBeGreaterThan(200);

      // Verify single-tap renderCompleteRibbonStroke renders cleanly
      const tapCanvas = createRasterMockCanvas(80, 80);
      const tapCtx = tapCanvas.getContext('2d') as unknown as CanvasRenderingContext2D;
      const tapMesh = renderCompleteRibbonStroke(
        tapCtx,
        [{ x: 40, y: 40, pressure: 1, width: 24 }],
        {
          size: 24,
          minSizeFactor: 0.2,
          color: '#000000',
          opacity: 1,
          flow: 1,
          spacing: 0.1,
          usePressure: true,
          smoothing: false,
          stabilization: 0,
          hardness: 1,
          customTipAngle: 90,
          isRibbon: true,
          useGpu: false,
        },
        'brush',
        'color',
        false,
        false,
        false,
        undefined,
        { tipSurfaces: [tip] }
      );
      expect(tapMesh && tapMesh.triangleCount).toBeGreaterThanOrEqual(2);
      expect(readPixel(tapCanvas.pixelBuffer, 80, 40, 40).a).toBeGreaterThan(200);
    });

    it('compiles and dispatches the WebGL textured ribbon shader with all attributes and uniforms', () => {
      const compiledSources: string[] = [];
      const setUniforms = new Map<string, any>();
      const boundAttribs = new Set<string>();
      const drawCalls: Array<{ mode: number; first: number; count: number }> = [];
      let nextLocId = 1;
      const attribLocMap = new Map<string, number>();

      const mockGl: any = {
        VERTEX_SHADER: 35633,
        FRAGMENT_SHADER: 35632,
        COMPILE_STATUS: 35713,
        LINK_STATUS: 35714,
        ARRAY_BUFFER: 34962,
        STATIC_DRAW: 35044,
        DYNAMIC_DRAW: 35048,
        TEXTURE_2D: 3553,
        TEXTURE0: 33984,
        TEXTURE3: 33987,
        RGBA: 6408,
        LUMINANCE: 6409,
        UNSIGNED_BYTE: 5121,
        UNPACK_ALIGNMENT: 3317,
        UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37441,
        TEXTURE_WRAP_S: 10242,
        TEXTURE_WRAP_T: 10243,
        TEXTURE_MIN_FILTER: 10241,
        TEXTURE_MAG_FILTER: 10240,
        REPEAT: 10497,
        CLAMP_TO_EDGE: 33071,
        LINEAR: 9729,
        NEAREST: 9728,
        LINEAR_MIPMAP_LINEAR: 9987,
        BLEND: 3042,
        ONE: 1,
        ONE_MINUS_SRC_ALPHA: 771,
        FUNC_ADD: 32774,
        COLOR_BUFFER_BIT: 16384,
        SCISSOR_TEST: 3089,
        FLOAT: 5126,
        TRIANGLES: 4,
        VERSION: 7938,
        getExtension: () => null,
        getParameter: () => 'WebGL 1.0 Mock',
        isContextLost: () => false,
        createShader: (type: number) => ({ type }),
        shaderSource: (_shader: any, src: string) => {
          compiledSources.push(src);
        },
        compileShader: () => {},
        getShaderParameter: () => true,
        deleteShader: () => {},
        createProgram: () => ({ id: nextLocId++ }),
        attachShader: () => {},
        linkProgram: () => {},
        getProgramParameter: () => true,
        getAttribLocation: (_prog: any, name: string) => {
          if (!attribLocMap.has(name)) attribLocMap.set(name, attribLocMap.size);
          return attribLocMap.get(name)!;
        },
        getUniformLocation: (_prog: any, name: string) => ({ name }),
        createBuffer: () => ({ id: nextLocId++ }),
        bindBuffer: () => {},
        bufferData: () => {},
        createTexture: () => ({ id: nextLocId++ }),
        deleteTexture: () => {},
        activeTexture: () => {},
        bindTexture: () => {},
        pixelStorei: () => {},
        texImage2D: () => {},
        texParameteri: () => {},
        generateMipmap: () => {},
        enable: () => {},
        disable: () => {},
        blendFunc: () => {},
        blendEquation: () => {},
        viewport: () => {},
        scissor: () => {},
        clearColor: () => {},
        clear: () => {},
        useProgram: () => {},
        uniform1i: (loc: any, v: number) => {
          if (loc?.name) setUniforms.set(loc.name, v);
        },
        uniform1f: (loc: any, v: number) => {
          if (loc?.name) setUniforms.set(loc.name, v);
        },
        uniform2f: (loc: any, a: number, b: number) => {
          if (loc?.name) setUniforms.set(loc.name, [a, b]);
        },
        uniform3f: (loc: any, a: number, b: number, c: number) => {
          if (loc?.name) setUniforms.set(loc.name, [a, b, c]);
        },
        enableVertexAttribArray: (loc: number) => {
          for (const [k, v] of attribLocMap.entries()) {
            if (v === loc) boundAttribs.add(k);
          }
        },
        disableVertexAttribArray: () => {},
        vertexAttribPointer: () => {},
        drawArrays: (mode: number, first: number, count: number) => {
          drawCalls.push({ mode, first, count });
        },
      };

      const prevDoc = (globalThis as any).document;
      (globalThis as any).document = {
        createElement(tag: string) {
          if (tag === 'canvas') {
            const c = createRasterMockCanvas(256, 256);
            const origGetContext = c.getContext.bind(c);
            c.getContext = (type: string) => (type === 'webgl' || type === 'webgl2' ? mockGl : origGetContext(type));
            return c;
          }
          return {};
        },
      };

      // Reset singleton so WebGlBrushEngine initializes against mockGl
      const prevInst = (WebGlBrushEngine as any).instance;
      (WebGlBrushEngine as any).instance = null;

      try {
        const gpu = WebGlBrushEngine.getInstance();
        expect(gpu.isTexturedRibbonAvailable()).toBe(true);

        const joinedShaders = compiledSources.join('\n');
        expect(joinedShaders).toContain('attribute vec2 a_pos');
        expect(joinedShaders).toContain('attribute vec2 a_uv');
        expect(joinedShaders).toContain('attribute float a_alpha');
        expect(joinedShaders).toContain('attribute float a_pressure');
        expect(joinedShaders).toContain('attribute float a_tipIndex');
        expect(joinedShaders).toContain('uniform bool u_isColorTip');
        expect(joinedShaders).toContain('uniform bool u_isDualToneTip');
        expect(joinedShaders).toContain('uniform vec3 u_primaryColor');
        expect(joinedShaders).toContain('uniform vec3 u_secondaryColor');

        const pts: Point[] = [
          { x: 10, y: 40, pressure: 0.7, width: 24 },
          { x: 90, y: 60, pressure: 0.9, width: 24 },
          { x: 170, y: 30, pressure: 0.8, width: 24 },
        ];
        const tipImg = createFakeTipImage(makeDualToneTip(32, 32));
        const mesh = buildRibbonMeshFromPoints(pts, {
          size: 24,
          tipImage: tipImg,
          isDualToneTip: true,
        });

        const target = createRasterMockCanvas(200, 120);
        const targetCtx = target.getContext('2d') as unknown as CanvasRenderingContext2D;
        const ok = gpu.renderTexturedRibbonMesh(
          targetCtx,
          mesh,
          {
            size: 24,
            minSizeFactor: 0.2,
            color: '#ff0000',
            secondaryColor: '#00ff00',
            opacity: 1,
            flow: 1,
            spacing: 0.1,
            usePressure: true,
            smoothing: false,
            stabilization: 0,
            hardness: 1,
            isRibbon: true,
            isDualToneTip: true,
            customTipImage: tipImg,
            grain: 0.6,
            paperTextureMode: 'subtract',
            antiAlias: 2,
          },
          '#ff0000',
          'brush'
        );

        expect(ok).toBe(true);
        expect(drawCalls.length).toBeGreaterThanOrEqual(1);
        expect(drawCalls[0].mode).toBe(mockGl.TRIANGLES);
        expect(drawCalls[0].count).toBe(mesh.vertexCount);
        expect(boundAttribs.has('a_pos')).toBe(true);
        expect(boundAttribs.has('a_uv')).toBe(true);
        expect(boundAttribs.has('a_alpha')).toBe(true);
        expect(boundAttribs.has('a_pressure')).toBe(true);
        expect(boundAttribs.has('a_tipIndex')).toBe(true);
        expect(setUniforms.get('u_isDualToneTip')).toBe(1);
        expect(setUniforms.get('u_isColorTip')).toBe(0);
        expect(setUniforms.get('u_primaryColor')).toEqual([1, 0, 0]);
        expect(setUniforms.get('u_secondaryColor')).toEqual([0, 1, 0]);
        expect(setUniforms.get('u_paperGrain')).toBeCloseTo(0.6, 4);
      } finally {
        (WebGlBrushEngine as any).instance = prevInst;
        (globalThis as any).document = prevDoc;
      }
    });
  });
});
