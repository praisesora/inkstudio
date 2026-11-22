import { describe, it, expect, beforeEach } from 'vitest';
import {
  BUILTIN_BRUSHES,
  BUILTIN_BRUSH_SECTIONS,
  getBuiltinBrushConfig,
} from '../presetBrushes';
import { getEffectiveBrushSettings } from '../brushPresetManager';
import {
  applyCspPaperTextureAlpha,
  drawBrushCubicBezierSegment,
  BrushRenderOptions,
} from '../../engine/BrushEngine';
import { PaintReservoir } from '../colorMixingEngine';
import { Point } from '../../types/editor';

function createMockCanvas(width: number = 128, height: number = 128) {
  const pixelBuffer = new Uint8ClampedArray(width * height * 4);
  const drawnDabs: {
    x: number;
    y: number;
    width: number;
    height: number;
    alpha: number;
  }[] = [];

  const ctx: any = {
    canvas: { width, height },
    globalAlpha: 1.0,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    clearRect: () => pixelBuffer.fill(0),
    fillRect: () => {},
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: (imgData: any) => {
      if (imgData.data.length === pixelBuffer.length) {
        pixelBuffer.set(imgData.data);
      }
    },
    getImageData: () => ({ width, height, data: pixelBuffer }),
    drawImage: (_src: any, dx: number, dy: number, dw?: number, dh?: number) => {
      drawnDabs.push({
        x: dx + (dw ? dw / 2 : 0),
        y: dy + (dh ? dh / 2 : 0),
        width: dw || 0,
        height: dh || 0,
        alpha: ctx.globalAlpha,
      });
    },
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
  };

  return {
    width,
    height,
    getContext: (type: string) => (type === '2d' ? ctx : null),
    toDataURL: () => `data:image/png;base64,MOCK_${width}x${height}_${pixelBuffer.reduce((a, b) => (a + b) & 0xffff, 0)}`,
    pixelBuffer,
    drawnDabs,
  };
}

describe('Pre-Installed Standard Brushes & Realistic Physics', () => {
  beforeEach(() => {
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return createMockCanvas();
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

  it('registers all 26 brushes cleanly across Pen (5), Sketch (5), Brush (7), and Natural Paint (9) sections', () => {
    expect(BUILTIN_BRUSH_SECTIONS.map((s) => s.id)).toEqual([
      'pen',
      'sketch',
      'brush',
      'natural-paint',
    ]);

    const penIds = BUILTIN_BRUSHES.filter((b) => b.category === 'pen').map((b) => b.id);
    const sketchIds = BUILTIN_BRUSHES.filter((b) => b.category === 'sketch').map((b) => b.id);
    const brushIds = BUILTIN_BRUSHES.filter((b) => b.category === 'brush').map((b) => b.id);
    const naturalIds = BUILTIN_BRUSHES.filter((b) => b.category === 'natural-paint').map((b) => b.id);

    expect(penIds).toEqual(['g-pen', 'real-g-pen', 'textured-pen', 'dot-pen', 'calligraphy']);
    expect(sketchIds).toEqual([
      'mechanical-pencil',
      'pencil-hb-2b',
      'pencil-6b-8b',
      'charcoal-pencil',
      'standard-chalk',
    ]);
    expect(brushIds).toEqual([
      'oil-painting',
      'thick-oil-painting',
      'chalk-painting',
      'blend-brush',
      'blend-chalk-brush',
      'soft-round',
      'noise-shader',
    ]);
    expect(naturalIds).toEqual([
      'impasto-bristle-oil',
      'wet-mixing-filbert',
      'dry-bristle-rake',
      'heavy-body-acrylic',
      'palette-knife-impasto',
      'velvet-gouache',
      'granulating-watercolor',
      'oil-bristle-blender',
      'pastel-stick-canvas',
    ]);
  });

  it('generates deterministic non-empty procedural tip and paper PNG data URLs for every configured brush', () => {
    for (const def of BUILTIN_BRUSHES) {
      const cfg = getBuiltinBrushConfig(def.id);
      expect(cfg).not.toBeNull();
      expect(cfg?.preset).toBe(def.id);
      if (def.tipGenerator) {
        expect(cfg?.customTipDataUrl).toMatch(/^data:image\/png;base64,/);
        expect(cfg?.customTipImage).toBeDefined();
      }
      if (def.paperTextureGenerator) {
        expect(cfg?.paperTexture).toMatch(/^data:image\/png;base64,/);
        expect(cfg?.paperTextureImage).toBeDefined();
      }
    }
  });

  it('enforces authentic Sketch pencil physics contracts across grades', () => {
    const mech = getBuiltinBrushConfig('mechanical-pencil')!;
    const hb2b = getBuiltinBrushConfig('pencil-hb-2b')!;
    const b68 = getBuiltinBrushConfig('pencil-6b-8b')!;
    const charcoal = getBuiltinBrushConfig('charcoal-pencil')!;

    // Mechanical pencil: firm, thin, tilt-independent, minimal grain, crisp edge
    expect(mech.useTilt).toBe(false);
    expect(mech.size).toBeLessThanOrEqual(3);
    expect(mech.grain).toBeLessThan(0.4);
    expect(mech.hardness).toBeGreaterThanOrEqual(0.9);
    expect(mech.paperTextureMode).toBe('compare');

    // HB/2B: moderate grain, pressure opacity/flow modulation, gentle tilt
    expect(hb2b.useTilt).toBe(true);
    expect(hb2b.tiltScale!).toBeGreaterThan(0.5);
    expect(hb2b.tiltScale!).toBeLessThan(1.2);
    expect(hb2b.grain!).toBeGreaterThan(mech.grain!);
    expect(hb2b.grain!).toBeLessThan(b68.grain!);
    expect(hb2b.opacitySensor?.usePressure).toBe(true);
    expect(hb2b.paperTextureMode).toBe('compare');

    // 6B/8B: rich dark, strong grain that clogs under heavy pressure, wide tilt hatching edge
    expect(b68.useTilt).toBe(true);
    expect(b68.tiltScale!).toBeGreaterThanOrEqual(1.8);
    expect(b68.grain!).toBeGreaterThanOrEqual(0.8);
    expect(b68.paperTextureMode).toBe('compare');

    // Charcoal: dry jagged aggressive texture, edge crumbs (halo + scatter), max tilt response
    expect(charcoal.useTilt).toBe(true);
    expect(charcoal.tiltScale!).toBeGreaterThanOrEqual(2.0);
    expect(charcoal.grain!).toBeGreaterThanOrEqual(0.88);
    expect(charcoal.dynamics?.scatter).toBeGreaterThan(0);
    expect(charcoal.paperTextureMode).toBe('compare');
  });

  it('cuts recessed paper valleys to exact zero at light/medium pressure and clogs only under heavy pressure (compare mode)', () => {
    const valleyHeight = 0.22; // Deep paper valley
    const ridgeHeight = 0.82;  // High cotton paper peak

    // At light & medium pressure, recessed valleys MUST cut to 0.0 so multi-dab overlap never fills them in
    const valleyLight = applyCspPaperTextureAlpha(0.9, valleyHeight, 0.86, 0.25, 'compare');
    const valleyMed = applyCspPaperTextureAlpha(0.9, valleyHeight, 0.86, 0.50, 'compare');
    const ridgeMed = applyCspPaperTextureAlpha(0.9, ridgeHeight, 0.86, 0.50, 'compare');
    expect(valleyLight).toBe(0);
    expect(valleyMed).toBe(0);
    expect(ridgeMed).toBeGreaterThan(0.8);

    // Under heavy pressure (6B/8B clogging), soft lead compresses into mid-valleys
    const midValleyMed = applyCspPaperTextureAlpha(0.9, 0.42, 0.86, 0.45, 'compare');
    const midValleyHeavy = applyCspPaperTextureAlpha(0.9, 0.42, 0.86, 0.96, 'compare');
    expect(midValleyMed).toBe(0);
    expect(midValleyHeavy).toBeGreaterThan(0.75);
  });

  it('widens & softens tilted 6B/8B strokes while keeping Mechanical Pencil completely tilt-independent', () => {
    const mockTip: any = { naturalWidth: 128, naturalHeight: 128, width: 128, height: 128, complete: true, src: 't' };
    const uprightPts: [Point, Point, Point, Point] = [
      { x: 10, y: 50, pressure: 0.7, width: 8, tiltX: 0, tiltY: 0 },
      { x: 30, y: 50, pressure: 0.7, width: 8, tiltX: 0, tiltY: 0 },
      { x: 60, y: 50, pressure: 0.7, width: 8, tiltX: 0, tiltY: 0 },
      { x: 90, y: 50, pressure: 0.7, width: 8, tiltX: 0, tiltY: 0 },
    ];
    const tiltedPts: [Point, Point, Point, Point] = uprightPts.map((p) => ({
      ...p,
      tiltX: 65,
      tiltY: 0,
    })) as [Point, Point, Point, Point];

    // 1. 6B/8B widens dramatically and softens when tilted
    const b68 = getBuiltinBrushConfig('pencil-6b-8b')!;
    const cUp = createMockCanvas(200, 200);
    const cTilt = createMockCanvas(200, 200);
    const b68Opts: BrushRenderOptions = {
      size: b68.size!,
      flow: b68.flow,
      spacing: 0.2,
      useTilt: b68.useTilt,
      tiltScale: b68.tiltScale,
      thickness: b68.thickness,
      tipImage: mockTip,
      useGpu: false,
    };
    drawBrushCubicBezierSegment(cUp.getContext('2d'), ...uprightPts, '#111111', b68Opts);
    drawBrushCubicBezierSegment(cTilt.getContext('2d'), ...tiltedPts, '#111111', b68Opts);

    const avgUpW = cUp.drawnDabs.reduce((s, d) => s + d.width, 0) / cUp.drawnDabs.length;
    const avgTiltW = cTilt.drawnDabs.reduce((s, d) => s + d.width, 0) / cTilt.drawnDabs.length;
    const avgUpA = cUp.drawnDabs.reduce((s, d) => s + d.alpha, 0) / cUp.drawnDabs.length;
    const avgTiltA = cTilt.drawnDabs.reduce((s, d) => s + d.alpha, 0) / cTilt.drawnDabs.length;
    expect(avgTiltW).toBeGreaterThan(avgUpW * 2.5);
    expect(avgTiltA).toBeLessThan(avgUpA);

    // 2. Mechanical Pencil ignores tilt completely
    const mech = getBuiltinBrushConfig('mechanical-pencil')!;
    const mUp = createMockCanvas(200, 200);
    const mTilt = createMockCanvas(200, 200);
    const mechOpts: BrushRenderOptions = {
      size: mech.size!,
      flow: mech.flow,
      spacing: 0.2,
      useTilt: mech.useTilt,
      tiltScale: mech.tiltScale,
      tipImage: mockTip,
      useGpu: false,
    };
    drawBrushCubicBezierSegment(mUp.getContext('2d'), ...uprightPts, '#111111', mechOpts);
    drawBrushCubicBezierSegment(mTilt.getContext('2d'), ...tiltedPts, '#111111', mechOpts);

    const mUpW = mUp.drawnDabs.reduce((s, d) => s + d.width, 0) / mUp.drawnDabs.length;
    const mTiltW = mTilt.drawnDabs.reduce((s, d) => s + d.width, 0) / mTilt.drawnDabs.length;
    expect(mTiltW).toBeCloseTo(mUpW, 4);
  });

  it('prevents pure Blend / Blend Chalk brushes from emitting foreground color onto blank canvas or contaminating first contact', () => {
    const blend = getBuiltinBrushConfig('blend-brush')!;
    const blendChalk = getBuiltinBrushConfig('blend-chalk-brush')!;
    expect(blend.colorMixing).toBe(true);
    expect(blend.amountOfPaint).toBe(0);
    expect(blend.mixingMode).toBe('smear');
    expect(blendChalk.amountOfPaint).toBe(0);
    expect(blendChalk.mixingMode).toBe('smear');
    expect(blendChalk.grain).toBeGreaterThan(0.4);

    // Touching blank canvas with red foreground selected must output alpha === 0
    const resBlank = new PaintReservoir('#ff0000');
    const blankOut = resBlank.mixWithCanvas(
      { r: 255, g: 255, b: 255, a: 0 },
      0,
      0.75,
      0.74,
      'smear',
      0.8,
      0.7,
      0,
      true
    );
    expect(blankOut.alpha).toBe(0);

    // First contact with pure blue paint on canvas must pick up pure blue, NOT mix in red foreground!
    const resPaint = new PaintReservoir('#ff0000');
    const firstContact = resPaint.mixWithCanvas(
      { r: 0, g: 40, b: 220, a: 1.0 },
      0,
      0.75,
      0.74,
      'smear',
      0.8,
      0.7,
      0,
      true
    );
    expect(firstContact.r).toBe(0);
    expect(firstContact.g).toBe(40);
    expect(firstContact.b).toBe(220);
    expect(firstContact.alpha).toBeGreaterThan(0.1);
  });

  it('resets dynamics, sensors, paper grain, tilt, and colorMixing cleanly when switching presets (zero state leakage)', () => {
    const charcoal = getEffectiveBrushSettings('charcoal-pencil');
    expect(charcoal.dynamics?.scatter).toBeGreaterThan(0);
    expect(charcoal.useTilt).toBe(true);
    expect(charcoal.grain).toBeGreaterThan(0.8);

    const gPen = getEffectiveBrushSettings('g-pen');
    expect(gPen.dynamics).toBeUndefined();
    expect(gPen.useTilt).toBe(false);
    expect(gPen.grain).toBe(0);
    expect(gPen.colorMixing).toBe(false);
    expect(gPen.opacitySensor).toBeUndefined();
    expect(gPen.densitySensor).toBeUndefined();
    expect(gPen.customTipImage).toBeUndefined();
    expect(gPen.paperTextureImage).toBeUndefined();
  });
});
