import { describe, it, expect } from 'vitest';
import { getEffectiveBrushSettings } from '../brushPresetManager';
import { drawBrushCubicBezierSegment, buildBrushRenderOptions } from '../../engine/BrushEngine';
import { LayerPixelSampler, PaintReservoir } from '../colorMixingEngine';
import { NaturalPaintStrokeSession } from '../../engine/NaturalPaintRenderer';
import { uploadActiveDraftTexture } from '../compositor/tileDraw';
import { BrushPresetId, BrushSettings, Point } from '../../types/editor';

function makeBenchCanvas(w = 512, h = 512) {
  let width = w;
  let height = h;
  let buf = new Uint8ClampedArray(width * height * 4);
  let resizes = 0;
  let createImgDataCalls = 0;
  let putImgDataCalls = 0;
  const canvas: any = {
    get width() { return width; },
    set width(v: number) { if (v !== width) resizes++; width = v; buf = new Uint8ClampedArray(Math.max(1, width * height * 4)); },
    get height() { return height; },
    set height(v: number) { if (v !== height) resizes++; height = v; buf = new Uint8ClampedArray(Math.max(1, width * height * 4)); },
    get __resizes() { return resizes; },
    get __createImgDataCalls() { return createImgDataCalls; },
    get __putImgDataCalls() { return putImgDataCalls; },
    __buf: buf,
    getContext: () => ctx,
    toDataURL: () => 'data:image/png;base64,MOCK',
  };
  const ctx: any = {
    canvas,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    clearRect: () => {},
    createImageData: (iw: number, ih: number) => {
      createImgDataCalls++;
      return { width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) };
    },
    putImageData: () => { putImgDataCalls++; },
    getImageData: (sx = 0, sy = 0, sw = width, sh = height) => {
      const out = new Uint8ClampedArray(sw * sh * 4);
      for (let row = 0; row < sh; row++) {
        const srcY = sy + row;
        if (srcY < 0 || srcY >= height) continue;
        const srcStart = (srcY * width + Math.max(0, sx)) * 4;
        const dstStart = (row * sw + Math.max(0, -sx)) * 4;
        const copyCols = Math.min(sw - Math.max(0, -sx), width - Math.max(0, sx));
        if (copyCols > 0) {
          out.set(buf.subarray(srcStart, srcStart + copyCols * 4), dstStart);
        }
      }
      return { width: sw, height: sh, data: out };
    },
    drawImage: () => {},
  };
  return canvas;
}

describe('Brush Responsiveness & Blend Performance', () => {
  it('benchmarks curved 320px multi-color swipes for Loaded Impasto Oil, Dry Bristle Rake, Blend, and Natural Paint brushes', () => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    };
    const createdCanvases: any[] = [];
    (globalThis as any).document = {
      createElement: () => {
        const c = makeBenchCanvas(256, 256);
        createdCanvases.push(c);
        return c;
      },
    };
    (globalThis as any).Image = class {
      src = ''; complete = true; naturalWidth = 256; naturalHeight = 256; width = 256; height = 256;
      decode() { return Promise.resolve(); }
    };

    // Painted canvas with smooth multi-color gradient (worst-case pigment mixing!)
    const srcCanvas = makeBenchCanvas(512, 512);
    const sbuf = srcCanvas.__buf;
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const i = (y * 512 + x) << 2;
        sbuf[i] = ((x * 255) / 512) | 0;
        sbuf[i + 1] = ((y * 255) / 512) | 0;
        sbuf[i + 2] = 255 - (((x * 255) / 512) | 0);
        sbuf[i + 3] = 255;
      }
    }

    const segs: Array<[Point, Point, Point, Point]> = [];
    for (let k = 0; k < 8; k++) {
      const t0 = k / 8;
      const t1 = (k + 1) / 8;
      const x0 = 60 + t0 * 320;
      const y0 = 256 + Math.sin(t0 * Math.PI * 2) * 90;
      const x3 = 60 + t1 * 320;
      const y3 = 256 + Math.sin(t1 * Math.PI * 2) * 90;
      const p0Val = 0.45 + 0.45 * Math.sin(t0 * Math.PI);
      const p3Val = 0.45 + 0.45 * Math.sin(t1 * Math.PI);
      segs.push([
        { x: x0, y: y0, pressure: p0Val, width: 0 },
        { x: x0 + (x3 - x0) * 0.33, y: y0 + (y3 - y0) * 0.6, pressure: (p0Val + p3Val) * 0.5, width: 0 },
        { x: x0 + (x3 - x0) * 0.66, y: y0 + (y3 - y0) * 0.4, pressure: (p0Val + p3Val) * 0.5, width: 0 },
        { x: x3, y: y3, pressure: p3Val, width: 0 },
      ]);
    }

    const spatialPresets: BrushPresetId[] = [
      'thick-oil-impasto',
      'dry-bristle-rake-paint',
      'blend-velvet-soft',
      'blend-oil-bristle',
      'blend-matte-chalk',
      'blend-rake-hair',
      'blend-canvas-scumble',
      'blend-fingertip',
    ];

    const draft = makeBenchCanvas(512, 512);
    const draftCtx = draft.getContext('2d');

    for (const id of spatialPresets) {
      const bs = getEffectiveBrushSettings(id) as BrushSettings;
      const size = Math.max(bs.size, 64);
      const bsRun: BrushSettings = { ...bs, size, color: '#facc15', useGpu: false };
      const sampler = new LayerPixelSampler(srcCanvas);
      const reservoir = new PaintReservoir('#facc15');
      const opts = buildBrushRenderOptions(bsRun, { sampler, reservoir, useGpu: false });
      const counter = { count: 0 };
      let rem = 0;
      const canvasCountBefore = createdCanvases.length;

      const t0 = performance.now();
      for (const [p0, c1, c2, p3] of segs) {
        rem = drawBrushCubicBezierSegment(
          draftCtx,
          { ...p0, width: size * (0.4 + 0.6 * p0.pressure) },
          { ...c1, width: size * (0.4 + 0.6 * c1.pressure) },
          { ...c2, width: size * (0.4 + 0.6 * c2.pressure) },
          { ...p3, width: size * (0.4 + 0.6 * p3.pressure) },
          '#facc15',
          opts,
          rem,
          counter
        );
      }
      const ms = performance.now() - t0;
      const newCanvases = createdCanvases.slice(canvasCountBefore);
      // After initial creation (width+height set once), pooled surfaces must NEVER resize again!
      const extraResizes = newCanvases.reduce((s, c) => s + Math.max(0, c.__resizes - 2), 0);
      const totalCreateImg = newCanvases.reduce((s, c) => s + c.__createImgDataCalls, 0);
      console.log(
        `[BENCH] ${id.padEnd(24)} dabs=${String(counter.count).padStart(4)} extraResizes=${String(extraResizes).padStart(3)} createImg=${String(totalCreateImg).padStart(4)} time=${ms.toFixed(1)}ms`
      );
      expect(counter.count).toBeGreaterThan(10);
      // Exact-size surface pool never resizes an existing canvas across pressure changes
      expect(extraResizes).toBe(0);
    }

    const naturalPresets: BrushPresetId[] = ['impasto-bristle-oil', 'dry-bristle-rake', 'oil-bristle-blender'];
    for (const id of naturalPresets) {
      const bs = getEffectiveBrushSettings(id) as BrushSettings;
      const size = Math.max(bs.size, 64);
      const bsRun: BrushSettings = { ...bs, size, color: '#facc15' };
      const sampler = new LayerPixelSampler(srcCanvas);
      const session = new NaturalPaintStrokeSession(bsRun, '#facc15', undefined, 1337);
      const t0 = performance.now();
      session.stampInitialPoint(draftCtx, { ...segs[0][0], width: size * 0.6 }, sampler, true);
      // Simulate real animation-frame batching (2 coalesced Bezier segments per frame -> 1 flush/frame)
      for (let i = 0; i < segs.length; i++) {
        const [p0, c1, c2, p3] = segs[i];
        session.appendCubicSegment(
          { ...p0, width: size * (0.4 + 0.6 * p0.pressure) },
          { ...c1, width: size * (0.4 + 0.6 * c1.pressure) },
          { ...c2, width: size * (0.4 + 0.6 * c2.pressure) },
          { ...p3, width: size * (0.4 + 0.6 * p3.pressure) },
          sampler
        );
        if ((i & 1) === 1 || i === segs.length - 1) {
          session.flushPendingDirtyToContext(draftCtx, true);
        }
      }
      const ms = performance.now() - t0;
      expect(session.getDirtyBounds()).not.toBeNull();
      session.finishAndDispose();
      console.log(`[BENCH-NAT] ${id.padEnd(20)} time=${ms.toFixed(1)}ms`);
    }
  });

  it('uploads only the dirty sub-rect of large draft canvases and skips mipmaps at 50%-99% zoom', () => {
    (globalThis as any).document = {
      createElement: () => makeBenchCanvas(16, 16),
    };
    const subCalls: any[] = [];
    let mipmapCalls = 0;
    const mockGl: any = {
      TEXTURE0: 0x84c0,
      TEXTURE_2D: 0x0de1,
      TEXTURE_WRAP_S: 0x2802,
      TEXTURE_WRAP_T: 0x2803,
      TEXTURE_MIN_FILTER: 0x2801,
      TEXTURE_MAG_FILTER: 0x2800,
      CLAMP_TO_EDGE: 0x812f,
      LINEAR: 0x2601,
      NEAREST: 0x2600,
      LINEAR_MIPMAP_LINEAR: 0x2703,
      UNPACK_ALIGNMENT: 0x0cf5,
      UNPACK_FLIP_Y_WEBGL: 0x9240,
      UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      createTexture: () => ({ id: 'tex' }),
      activeTexture: () => {},
      bindTexture: () => {},
      texParameteri: () => {},
      pixelStorei: () => {},
      texImage2D: () => {},
      texSubImage2D: (...args: any[]) => subCalls.push(args),
      generateMipmap: () => { mipmapCalls++; },
    };
    const state: any = {
      draftTexture: null,
      draftTexWidth: 0,
      draftTexHeight: 0,
      lastDraftVersion: -1,
      draftHasMipmap: false,
      draftUploadCanvas: null,
      currentZoom: 0.75,
      filteringQuality: 'auto',
    };
    const draft: any = makeBenchCanvas(2048, 2048);
    draft.__draftHasContent = true;

    // Frame 1: initial full allocation
    uploadActiveDraftTexture(state, mockGl, draft, 1, 'document');
    expect(mipmapCalls).toBe(0);

    // Frame 2: small 120x90 stroke dirty sub-rect -> must upload only (100, 200, 120x90)
    draft.__draftFrameDirtyRect = { x: 100, y: 200, width: 120, height: 90 };
    uploadActiveDraftTexture(state, mockGl, draft, 2, 'document');
    expect(subCalls.length).toBe(1);
    expect(subCalls[0][2]).toBe(100);
    expect(subCalls[0][3]).toBe(200);
    expect(subCalls[0][6].width).toBe(120);
    expect(subCalls[0][6].height).toBe(90);
    expect(draft.__draftFrameDirtyRect).toBeNull();
    expect(mipmapCalls).toBe(0);
  });
});
