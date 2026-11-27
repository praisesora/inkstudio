import { describe, it, expect, beforeEach } from 'vitest';
import type { BrushSettings, CspBrush, Point, SurfaceTextureId } from '../../types/editor';
import {
  DEFAULT_BRISTLE_SETTINGS,
  DEFAULT_IMPASTO_SETTINGS,
  DEFAULT_NATURAL_PAINT_SETTINGS,
} from '../../types/editor';
import {
  getSurfaceTextureDataUrl,
  getSurfaceTextureHeightField,
  sampleSurfaceTextureHeight,
  SURFACE_TEXTURE_CATALOG,
  SURFACE_TEXTURE_SIZE,
} from '../proceduralBrushTips';
import {
  cleanDirtyBrush,
  hasDirtyBrushState,
  LayerPixelSampler,
  SpatialBristleReservoir,
} from '../colorMixingEngine';
import {
  BristleRibbonEngine,
  BRISTLE_SEG_STRIDE,
  extractBristleStrokeConfig,
} from '../../engine/BristleRibbonEngine';
import {
  evaluateMappedSurfaceHeight,
  evaluatePaintCanvasContact,
  NaturalPaintStrokeSession,
  renderCompleteNaturalPaintStroke,
} from '../../engine/NaturalPaintRenderer';
import {
  INKB_VERSION,
  parseInkbFile,
  serializeInkbBrush,
} from '../inkbBrushFormat';
import { BUILTIN_BRUSHES, getBuiltinBrushConfig } from '../presetBrushes';
import { getEffectiveBrushSettings } from '../brushPresetManager';

function createHeadlessCanvas(width: number = 256, height: number = 256) {
  const buf = new Uint8ClampedArray(width * height * 4);
  const ctx: any = {
    canvas: { width, height },
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save: () => {},
    restore: () => {},
    clearRect: (x: number, y: number, w: number, h: number) => {
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(width, Math.ceil(x + w));
      const y1 = Math.min(height, Math.ceil(y + h));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * width + px) * 4;
          buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0;
        }
      }
    },
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: (img: ImageData, dx = 0, dy = 0) => {
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
    getImageData: (sx = 0, sy = 0, sw = width, sh = height) => {
      const out = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y++) {
        const ty = sy + y;
        if (ty < 0 || ty >= height) continue;
        for (let x = 0; x < sw; x++) {
          const tx = sx + x;
          if (tx < 0 || tx >= width) continue;
          const si = (ty * width + tx) * 4;
          const di = (y * sw + x) * 4;
          out[di] = buf[si];
          out[di + 1] = buf[si + 1];
          out[di + 2] = buf[si + 2];
          out[di + 3] = buf[si + 3];
        }
      }
      return { width: sw, height: sh, data: out };
    },
    drawImage: (
      src: any,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number
    ) => {
      const srcBuf: Uint8ClampedArray | undefined = src?.__buf;
      if (!srcBuf) return;
      const srcW = src.width;
      for (let y = 0; y < Math.min(sh, dh); y++) {
        const ty = Math.floor(dy + y);
        const fy = Math.floor(sy + y);
        if (ty < 0 || ty >= height || fy < 0 || fy >= src.height) continue;
        for (let x = 0; x < Math.min(sw, dw); x++) {
          const tx = Math.floor(dx + x);
          const fx = Math.floor(sx + x);
          if (tx < 0 || tx >= width || fx < 0 || fx >= srcW) continue;
          const si = (fy * srcW + fx) * 4;
          const di = (ty * width + tx) * 4;
          const sa = (srcBuf[si + 3] / 255) * ctx.globalAlpha;
          if (sa <= 0) continue;
          const da = buf[di + 3] / 255;
          const outA = sa + da * (1 - sa);
          if (outA > 0) {
            buf[di] = Math.round((srcBuf[si] * sa + buf[di] * da * (1 - sa)) / outA);
            buf[di + 1] = Math.round((srcBuf[si + 1] * sa + buf[di + 1] * da * (1 - sa)) / outA);
            buf[di + 2] = Math.round((srcBuf[si + 2] * sa + buf[di + 2] * da * (1 - sa)) / outA);
            buf[di + 3] = Math.round(Math.min(1, outA) * 255);
          }
        }
      }
    },
  };

  return {
    width,
    height,
    __buf: buf,
    getContext: (type: string) => (type === '2d' ? ctx : null),
    toDataURL: () => `data:image/png;base64,MOCK_${width}x${height}`,
  };
}

describe('Natural Paint Engine — Bristles, Spatial Mixing, Surface Textures & Impasto', () => {
  beforeEach(() => {
    cleanDirtyBrush();
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return createHeadlessCanvas(256, 256);
        return {};
      },
    };
    (globalThis as any).Image = class MockImage {
      src = '';
      complete = true;
      naturalWidth = 128;
      naturalHeight = 128;
      width = 128;
      height = 128;
      decode() {
        return Promise.resolve();
      }
    };
  });

  it('generates all 7 seamless 512x512 procedural surface heightmaps with rich tonal range and periodic wrap', () => {
    expect(SURFACE_TEXTURE_CATALOG.length).toBe(7);

    for (const meta of SURFACE_TEXTURE_CATALOG) {
      const field = getSurfaceTextureHeightField(meta.id);
      expect(field.length).toBe(SURFACE_TEXTURE_SIZE * SURFACE_TEXTURE_SIZE);

      let minV = 255;
      let maxV = 0;
      for (let i = 0; i < field.length; i += 17) {
        if (field[i] < minV) minV = field[i];
        if (field[i] > maxV) maxV = field[i];
      }
      expect(maxV - minV).toBeGreaterThan(80);

      // Seamless periodicity: sampling at x and x + 512 must match identically
      const h0 = sampleSurfaceTextureHeight(meta.id, 37.25, 114.5, 1.0, 0);
      const hWrap = sampleSurfaceTextureHeight(
        meta.id,
        37.25 + SURFACE_TEXTURE_SIZE,
        114.5 + SURFACE_TEXTURE_SIZE,
        1.0,
        0
      );
      expect(Math.abs(h0 - hWrap)).toBeLessThan(1e-5);

      const url = getSurfaceTextureDataUrl(meta.id);
      expect(url).toMatch(/^data:image\/png;base64,/);
    }
  });

  it('performs spatial per-bristle color pickup so only bristles touching purple pick up purple while neighbors stay yellow', () => {
    // Prepare a canvas where left half (x < 100) is opaque purple and right half (x >= 100) is unpainted
    const canvas = createHeadlessCanvas(200, 200);
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 100; x++) {
        const i = (y * 200 + x) * 4;
        canvas.__buf[i] = 110;
        canvas.__buf[i + 1] = 35;
        canvas.__buf[i + 2] = 215;
        canvas.__buf[i + 3] = 255;
      }
    }
    const sampler = new LayerPixelSampler(canvas as any);

    const yellowBs: BrushSettings = {
      size: 60,
      minSizeFactor: 0.5,
      color: '#facc15',
      opacity: 1,
      flow: 0.95,
      spacing: 0.05,
      usePressure: true,
      smoothing: true,
      stabilization: 0,
      hardness: 0.9,
      renderMode: 'bristle-ribbon',
      colorMixing: true,
      mixingMode: 'running_color',
      bristle: { ...DEFAULT_BRISTLE_SETTINGS, profile: 'flat', count: 16, clumping: 0.0, irregularity: 0.0 },
      naturalPaint: {
        ...DEFAULT_NATURAL_PAINT_SETTINGS,
        enabled: true,
        spatialMixing: true,
        paintLoad: 0.85,
        wetness: 0.85,
        viscosity: 0.2,
        depletionRate: 0.1,
        autoClean: true,
      },
    };

    const cfg = extractBristleStrokeConfig(yellowBs, '#facc15');
    const engine = new BristleRibbonEngine(cfg);

    // Stroke straight down along x=100: left bristles (offset < 0) touch purple; right bristles (offset > 0) stay on empty canvas!
    const p0: Point = { x: 100, y: 20, pressure: 0.85, width: 60 };
    const p1: Point = { x: 100, y: 50, pressure: 0.85, width: 60 };
    const p2: Point = { x: 100, y: 80, pressure: 0.85, width: 60 };
    const p3: Point = { x: 100, y: 120, pressure: 0.85, width: 60 };

    engine.emitInitialStamp(p0, sampler);
    engine.emitCubicSegment(p0, p1, p2, p3, sampler);

    // Compare blue channel on bristles touching purple vs bristles on empty canvas
    // Moving downward (tx=0, ty=1) -> normal is (-1, 0), so offset > 0 points LEFT (into purple x < 100)
    // and offset < 0 points RIGHT (into empty x > 100)
    const rightIdx = 0; // offset = -1 -> x ~ 130 (empty)
    const leftIdx = engine.reservoir.count - 1; // offset = +1 -> x ~ 70 (purple)

    // Right bristle stays vibrant yellow (high R, high G, low B)
    expect(engine.reservoir.r[rightIdx]).toBeGreaterThan(220);
    expect(engine.reservoir.g[rightIdx]).toBeGreaterThan(180);
    expect(engine.reservoir.b[rightIdx]).toBeLessThan(40);

    // Left bristle picked up purple (significantly elevated blue channel & lowered green)
    expect(engine.reservoir.b[leftIdx]).toBeGreaterThan(engine.reservoir.b[rightIdx] + 45);
  });

  it('supports paint load depletion, zero-load pure blender, and dirty-brush persistence across strokes', () => {
    const res = new SpatialBristleReservoir(
      '#1d4ed8',
      { ...DEFAULT_BRISTLE_SETTINGS, profile: 'rake', count: 12, irregularity: 0.4 },
      { ...DEFAULT_NATURAL_PAINT_SETTINGS, enabled: true, paintLoad: 0.8, depletionRate: 0.8, autoClean: false },
      'dirty-test-preset'
    );

    const out = { r: 0, g: 0, b: 0, alpha: 0, load: 0, height: 0 };
    const initialLoad = res.load[0];
    // Step 400px along dry canvas -> paint load must noticeably deplete
    for (let s = 0; s < 40; s++) {
      res.stepBristle(
        0,
        { r: 255, g: 255, b: 255, a: 0 },
        10,
        0.5,
        { enabled: true, spatialMixing: true, paintLoad: 0.8, depletionRate: 0.8, wetness: 0.5, viscosity: 0.5, autoClean: false, chargePerPressure: 0.3, dryBrush: 0.5, pigmentMixingStrength: 0.9 },
        'blend',
        0.5,
        0.8,
        0.9,
        0.9,
        out
      );
    }
    expect(res.load[0]).toBeLessThan(initialLoad * 0.45);

    // Pick up red pigment on bristle 2 and persist dirty brush state
    res.stepBristle(
      2,
      { r: 240, g: 20, b: 20, a: 1.0 },
      6,
      0.8,
      { enabled: true, spatialMixing: true, paintLoad: 0.8, depletionRate: 0.1, wetness: 0.9, viscosity: 0.2, autoClean: false, chargePerPressure: 0.3, dryBrush: 0.2, pigmentMixingStrength: 0.9 },
      'running_color',
      0.8,
      0.5,
      0.9,
      0.9,
      out
    );
    res.persistDirtyStateIfNeeded();
    expect(hasDirtyBrushState('dirty-test-preset')).toBe(true);

    // Next stroke with same preset retains dirty red tint on bristle 2
    const nextStrokeRes = new SpatialBristleReservoir(
      '#1d4ed8',
      { ...DEFAULT_BRISTLE_SETTINGS, profile: 'rake', count: 12, irregularity: 0.4 },
      { ...DEFAULT_NATURAL_PAINT_SETTINGS, enabled: true, paintLoad: 0.8, depletionRate: 0.8, autoClean: false },
      'dirty-test-preset'
    );
    expect(nextStrokeRes.r[2]).toBeGreaterThan(nextStrokeRes.r[5] + 20);

    // Cleaning removes dirty state
    cleanDirtyBrush('dirty-test-preset');
    expect(hasDirtyBrushState('dirty-test-preset')).toBe(false);

    // Zero-load blender on empty canvas emits 0 alpha
    const blender = new SpatialBristleReservoir(
      '#ff0000',
      DEFAULT_BRISTLE_SETTINGS,
      { ...DEFAULT_NATURAL_PAINT_SETTINGS, enabled: true, paintLoad: 0.0, spatialMixing: true }
    );
    blender.stepBristle(
      0,
      { r: 0, g: 0, b: 0, a: 0 },
      5,
      0.7,
      { ...DEFAULT_NATURAL_PAINT_SETTINGS, enabled: true, paintLoad: 0.0, spatialMixing: true },
      'smear',
      0.8,
      0,
      0.9,
      0.9,
      out
    );
    expect(out.alpha).toBe(0);
  });

  it('curves bristle strands smoothly around tight 180-degree turns with finite coordinates and zero NaN artifacts', () => {
    const bs = getEffectiveBrushSettings('impasto-bristle-oil') as BrushSettings;
    const cfg = extractBristleStrokeConfig({ ...bs, color: '#2563eb' }, '#2563eb');
    const engine = new BristleRibbonEngine(cfg);

    const p0: Point = { x: 40, y: 120, pressure: 0.8, width: 44 };
    const c1: Point = { x: 140, y: 120, pressure: 0.8, width: 44 };
    const c2: Point = { x: 140, y: 100, pressure: 0.8, width: 44 };
    const p3: Point = { x: 40, y: 100, pressure: 0.8, width: 44 };

    const init = engine.emitInitialStamp(p0);
    expect(init.count).toBeGreaterThan(0);

    const batch = engine.emitCubicSegment(p0, c1, c2, p3);
    expect(batch.count).toBeGreaterThan(cfg.bristle.count);
    for (let s = 0; s < batch.count; s++) {
      const base = s * BRISTLE_SEG_STRIDE;
      for (let k = 0; k < BRISTLE_SEG_STRIDE; k++) {
        expect(Number.isFinite(batch.data[base + k])).toBe(true);
      }
    }
  });

  it('evaluates all 4 grainMappingMode spatial modes and physical paint-to-canvas-tooth valley fill vs dry-brush skip', () => {
    const baseParams = {
      surfaceId: 'linen-canvas' as SurfaceTextureId,
      customTex: null,
      dualGrainDepth: 0,
      grainDepth: 0.7,
      scale: 1.0,
      rotateRad: 0,
      contrast: 0,
      brightness: 0,
      inverted: false,
      strokeOffsetX: 117,
      strokeOffsetY: 203,
      strokeCos: Math.cos(1.1),
      strokeSin: Math.sin(1.1),
    };

    const hCanvasLocked = evaluateMappedSurfaceHeight(
      { ...baseParams, mappingMode: 'canvas-locked' },
      42, 68, 120, 0.3, 24, 0.6, 0.8
    );
    const hBrushAligned = evaluateMappedSurfaceHeight(
      { ...baseParams, mappingMode: 'brush-aligned' },
      42, 68, 120, 0.3, 24, 0.6, 0.8
    );
    const hStrokeFlow = evaluateMappedSurfaceHeight(
      { ...baseParams, mappingMode: 'stroke-flow' },
      42, 68, 120, 0.3, 24, 0.6, 0.8
    );
    const hRandom = evaluateMappedSurfaceHeight(
      { ...baseParams, mappingMode: 'random-per-stroke' },
      42, 68, 120, 0.3, 24, 0.6, 0.8
    );

    for (const h of [hCanvasLocked, hBrushAligned, hStrokeFlow, hRandom]) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(1);
    }
    // Distinct mapping modes sample distinct spatial coordinates
    expect(new Set([hCanvasLocked.toFixed(4), hBrushAligned.toFixed(4), hStrokeFlow.toFixed(4), hRandom.toFixed(4)]).size).toBeGreaterThan(2);

    // Physical valley-fill vs valley-skip:
    // Recessed valley (H_canvas = 0.15) with low load + light pressure + dryBrush skips valleys
    const dryValley = evaluatePaintCanvasContact(0.15, 0.18, 0.2, 0.0, 0.65, 0.72);
    // Raised crown (H_canvas = 0.90) with same dry settings deposits crisply
    const dryCrown = evaluatePaintCanvasContact(0.90, 0.18, 0.2, 0.0, 0.65, 0.72);
    // Heavy loaded paint + strong pressure fills the recessed valley much more strongly
    const heavyValley = evaluatePaintCanvasContact(0.15, 0.96, 0.96, 0.0, 0.65, 0.72);

    expect(dryCrown).toBeGreaterThan(dryValley + 0.35);
    expect(heavyValley).toBeGreaterThan(dryValley + 0.35);
  });

  it('produces directional 3D impasto relief shading with higher luminance variance than flat matte paint', () => {
    const pts: Point[] = [
      { x: 30, y: 100, pressure: 0.9, width: 42 },
      { x: 80, y: 95, pressure: 0.95, width: 44 },
      { x: 130, y: 105, pressure: 0.9, width: 42 },
      { x: 180, y: 100, pressure: 0.85, width: 40 },
    ];

    const baseBs: BrushSettings = {
      size: 42,
      minSizeFactor: 0.4,
      color: '#3b82f6',
      opacity: 1,
      flow: 0.95,
      spacing: 0.05,
      usePressure: true,
      smoothing: true,
      stabilization: 0,
      hardness: 0.9,
      renderMode: 'bristle-ribbon',
      bristle: { ...DEFAULT_BRISTLE_SETTINGS, count: 24, clumping: 0.35 },
      naturalPaint: { ...DEFAULT_NATURAL_PAINT_SETTINGS, enabled: true, spatialMixing: false, paintLoad: 0.95, dryBrush: 0.1 },
      surfaceTextureId: 'linen-canvas',
      grain: 0.2,
      useGpu: false,
    };

    const flatCanvas = createHeadlessCanvas(220, 200);
    renderCompleteNaturalPaintStroke(
      flatCanvas.getContext('2d')!,
      pts,
      { ...baseBs, impasto: { ...DEFAULT_IMPASTO_SETTINGS, enabled: false, depth: 0, gloss: 0 } },
      '#3b82f6'
    );

    const impastoCanvas = createHeadlessCanvas(220, 200);
    renderCompleteNaturalPaintStroke(
      impastoCanvas.getContext('2d')!,
      pts,
      { ...baseBs, impasto: { ...DEFAULT_IMPASTO_SETTINGS, enabled: true, depth: 0.9, bristleRelief: 0.9, gloss: 0.75, reliefContrast: 0.85 } },
      '#3b82f6'
    );

    // Measure luminance spread across opaque stroke pixels: impasto relief produces crisp lit ridges & shaded valleys
    const measureLumaRange = (buf: Uint8ClampedArray) => {
      let minL = 255;
      let maxL = 0;
      let count = 0;
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i + 3] > 200) {
          const l = 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
          if (l < minL) minL = l;
          if (l > maxL) maxL = l;
          count++;
        }
      }
      return { range: maxL - minL, count };
    };

    const flatStats = measureLumaRange(flatCanvas.__buf);
    const impStats = measureLumaRange(impastoCanvas.__buf);

    expect(flatStats.count).toBeGreaterThan(200);
    expect(impStats.count).toBeGreaterThan(200);
    expect(impStats.range).toBeGreaterThan(flatStats.range + 25);

    // Also verify live NaturalPaintStrokeSession anchors cleanly without detached stubs
    // and commits single-tap dabs via flushPendingTapIfNeeded()
    const liveSession = new NaturalPaintStrokeSession(
      { ...baseBs, impasto: { ...DEFAULT_IMPASTO_SETTINGS, enabled: true, depth: 0.8 } },
      '#3b82f6',
      undefined,
      1337
    );
    const liveCanvas = createHeadlessCanvas(220, 200);
    liveSession.stampInitialPoint(liveCanvas.getContext('2d')!, pts[0], undefined, true);
    expect(liveSession.getDirtyBounds()).toBeNull();
    liveSession.flushPendingTapIfNeeded();
    expect(liveSession.getDirtyBounds()).not.toBeNull();
    liveSession.finishAndDispose();
  });

  it('round-trips Natural Paint brushes cleanly through .inkb v2 while remaining 100% compatible with legacy .inkb v1', () => {
    expect(INKB_VERSION).toBe(2);

    const v2Brush: CspBrush = {
      id: 'natural-custom-1',
      name: 'Studio Impasto Oil',
      category: 'natural-paint',
      badge: 'INKB',
      desc: 'Heavy oil with directional relief',
      size: 48,
      minSizeFactor: 0.35,
      opacity: 1,
      flow: 0.94,
      spacing: 0.05,
      hardness: 0.88,
      thickness: 0.9,
      angle: 12,
      usePressure: true,
      smoothing: true,
      stabilization: 10,
      colorMixing: true,
      mixingMode: 'impasto_mix',
      surfaceTextureId: 'linen-canvas',
      grainMappingMode: 'stroke-flow',
      dualBrush: true,
      dualScale: 1.4,
      dualAngle: 35,
      dualScatter: 0.25,
      dualSurfaceTextureId: 'coarse-burlap',
      dualGrainDepth: 0.4,
      renderMode: 'bristle-ribbon',
      bristle: {
        profile: 'filbert',
        count: 36,
        clumping: 0.42,
        stiffness: 0.7,
        length: 1.1,
        splay: 0.38,
        irregularity: 0.35,
        edgeRidge: 0.45,
      },
      naturalPaint: {
        enabled: true,
        spatialMixing: true,
        pigmentMixingStrength: 0.92,
        paintLoad: 0.88,
        depletionRate: 0.28,
        wetness: 0.65,
        viscosity: 0.58,
        autoClean: false,
        chargePerPressure: 0.5,
        dryBrush: 0.42,
        granulation: 0.15,
      },
      impasto: {
        enabled: true,
        depth: 0.82,
        bristleRelief: 0.85,
        gloss: 0.64,
        reliefContrast: 0.72,
        lightAzimuth: 280,
        lightElevation: 40,
      },
      bristleSplaySensor: { usePressure: true, pressureMin: 0.2, useTilt: true },
      importedAt: Date.now(),
    };

    const bytes = serializeInkbBrush(v2Brush);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const parsed = parseInkbFile(ab, 'Studio Impasto Oil.inkb');

    expect(parsed.category).toBe('natural-paint');
    expect(parsed.renderMode).toBe('bristle-ribbon');
    expect(parsed.mixingMode).toBe('impasto_mix');
    expect(parsed.surfaceTextureId).toBe('linen-canvas');
    expect(parsed.grainMappingMode).toBe('stroke-flow');
    expect(parsed.dualScale).toBe(1.4);
    expect(parsed.dualAngle).toBe(35);
    expect(parsed.dualSurfaceTextureId).toBe('coarse-burlap');
    expect(parsed.bristle?.count).toBe(36);
    expect(parsed.bristle?.edgeRidge).toBe(0.45);
    expect(parsed.naturalPaint?.spatialMixing).toBe(true);
    expect(parsed.naturalPaint?.autoClean).toBe(false);
    expect(parsed.impasto?.enabled).toBe(true);
    expect(parsed.impasto?.lightAzimuth).toBe(280);
    expect(parsed.bristleSplaySensor?.useTilt).toBe(true);

    // Verify legacy .inkb v1 file still parses seamlessly
    const legacyV1Json = JSON.stringify({
      format: 'inkb',
      version: 1,
      exportedAt: Date.now(),
      brush: { name: 'Legacy G-Pen', size: 10, opacity: 1, flow: 1, spacing: 0.05, hardness: 1, thickness: 1, angle: 0, usePressure: true, smoothing: true, stabilization: 15, minSizeFactor: 0.05 },
    });
    const v1Buf = new TextEncoder().encode(legacyV1Json).buffer as ArrayBuffer;
    const parsedV1 = parseInkbFile(v1Buf, 'Legacy G-Pen.inkb');
    expect(parsedV1.name).toBe('Legacy G-Pen');
    expect(parsedV1.size).toBe(10);
  });

  it('provides all 9 calibrated Natural Paint presets with valid surface textures, bristle profiles, and settings', () => {
    const naturalDefs = BUILTIN_BRUSHES.filter((b) => b.category === 'natural-paint');
    expect(naturalDefs.length).toBe(9);

    for (const def of naturalDefs) {
      const cfg = getBuiltinBrushConfig(def.id);
      expect(cfg).not.toBeNull();
      expect(cfg?.naturalPaint?.enabled).toBe(true);
      expect(cfg?.bristle?.count).toBeGreaterThanOrEqual(16);
      expect(cfg?.surfaceTextureId).toBeTruthy();
      expect(cfg?.renderMode === 'bristle-ribbon' || cfg?.renderMode === 'bristle-hybrid').toBe(true);
    }

    // Verify key distinctive calibrations
    const blender = getBuiltinBrushConfig('oil-bristle-blender')!;
    expect(blender.naturalPaint?.paintLoad).toBe(0);

    const gouache = getBuiltinBrushConfig('velvet-gouache')!;
    expect(gouache.impasto?.gloss).toBeLessThan(0.1);

    const watercolor = getBuiltinBrushConfig('granulating-watercolor')!;
    expect(watercolor.wetEdge).toBeGreaterThan(0.4);
    expect(watercolor.naturalPaint?.granulation).toBeGreaterThan(0.5);

    const knife = getBuiltinBrushConfig('palette-knife-impasto')!;
    expect(knife.bristle?.profile).toBe('knife');
    expect(knife.bristle?.edgeRidge).toBeGreaterThan(0.75);

    // Every Natural Paint preset keeps amountOfPaint and naturalPaint.paintLoad synchronized
    for (const def of naturalDefs) {
      const cfg = getBuiltinBrushConfig(def.id)!;
      expect(cfg.amountOfPaint).toBe(cfg.naturalPaint?.paintLoad);
    }
  });

  it('layers fresh pigment cleanly at max amountOfPaint=1.0 over existing paint and blends smoothly at intermediate loads', () => {
    // Solid opaque dark blue canvas
    const blueCanvas = createHeadlessCanvas(200, 200);
    for (let i = 0; i < blueCanvas.__buf.length; i += 4) {
      blueCanvas.__buf[i] = 16;
      blueCanvas.__buf[i + 1] = 32;
      blueCanvas.__buf[i + 2] = 180;
      blueCanvas.__buf[i + 3] = 255;
    }

    const basePreset = getEffectiveBrushSettings('wet-mixing-filbert') as BrushSettings;
    const strokePts: Point[] = [
      { x: 20, y: 100, pressure: 0.9, width: 48 },
      { x: 70, y: 100, pressure: 0.9, width: 48 },
      { x: 120, y: 100, pressure: 0.9, width: 48 },
      { x: 170, y: 100, pressure: 0.9, width: 48 },
    ];

    // 1. Even if naturalPaint.paintLoad is still 0.76 and wetness=0.82, setting amountOfPaint=1.0
    //    must cleanly layer pure bright yellow over dark blue without collapsing into blue!
    const maxPaintBs: BrushSettings = {
      ...basePreset,
      color: '#facc15',
      amountOfPaint: 1.0,
    };
    const cfgMax = extractBristleStrokeConfig(maxPaintBs, '#facc15');
    expect(cfgMax.naturalPaint.paintLoad).toBe(1.0);
    const engineMax = new BristleRibbonEngine(cfgMax);
    const samplerMax = new LayerPixelSampler(blueCanvas as any);
    engineMax.emitInitialStamp(strokePts[0], samplerMax);
    engineMax.emitCubicSegment(strokePts[0], strokePts[1], strokePts[2], strokePts[3], samplerMax);

    const midBristle = Math.floor(engineMax.reservoir.count / 2);
    expect(engineMax.reservoir.r[midBristle]).toBeGreaterThan(240);
    expect(engineMax.reservoir.g[midBristle]).toBeGreaterThan(195);
    expect(engineMax.reservoir.b[midBristle]).toBeLessThan(30);

    // 2. At intermediate amountOfPaint=0.72, yellow over blue mixes harmoniously into vibrant green
    //    instead of getting swallowed into 95% dark blue!
    const midPaintBs: BrushSettings = {
      ...basePreset,
      color: '#facc15',
      amountOfPaint: 0.72,
      naturalPaint: { ...basePreset.naturalPaint!, paintLoad: 0.72, wetness: 0.65 },
    };
    const cfgMid = extractBristleStrokeConfig(midPaintBs, '#facc15');
    const engineMid = new BristleRibbonEngine(cfgMid);
    const samplerMid = new LayerPixelSampler(blueCanvas as any);
    engineMid.emitInitialStamp(strokePts[0], samplerMid);
    engineMid.emitCubicSegment(strokePts[0], strokePts[1], strokePts[2], strokePts[3], samplerMid);

    // Green dominates both red and blue (subtractive Yellow+Blue = Green, not swallowed into pure blue)
    expect(engineMid.reservoir.g[midBristle]).toBeGreaterThan(100);
    expect(engineMid.reservoir.g[midBristle]).toBeGreaterThan(engineMid.reservoir.r[midBristle] + 35);
    expect(engineMid.reservoir.g[midBristle]).toBeGreaterThan(engineMid.reservoir.b[midBristle] + 10);
    expect(engineMid.reservoir.b[midBristle]).toBeLessThan(150);
  });
});
