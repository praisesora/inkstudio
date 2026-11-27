import { describe, it, expect, beforeEach } from 'vitest';
import {
  BUILTIN_BRUSHES,
  BUILTIN_BRUSH_SECTIONS,
  getBuiltinBrushConfig,
  prewarmBuiltinBrushAssets,
} from '../presetBrushes';
import {
  BUILTIN_PRESET_SCHEMA_VERSION,
  LEGACY_PRESET_ID_MAP,
  STORAGE_KEY_ACTIVE_PRESET,
  STORAGE_KEY_SETTINGS,
  getActivePresetId,
  getEffectiveBrushSettings,
  loadAllSavedBrushSettings,
  migrateLegacyPresetId,
  resetBrushSettingsCache,
  saveBrushSettingsImmediately,
} from '../brushPresetManager';
import {
  applyCspPaperTextureAlpha,
  drawBrushCubicBezierSegment,
  BrushRenderOptions,
} from '../../engine/BrushEngine';
import {
  buildRibbonMeshFromPoints,
  buildRibbonRenderOptionsFromBrushSettings,
  isRibbonBrush,
} from '../../engine/RibbonBrushEngine';
import { resolveDualBrushConfig } from '../../engine/DualBrushEngine';
import {
  LayerPixelSampler,
  PaintReservoir,
  SpatialTipMixer,
} from '../colorMixingEngine';
import { compositeBrushPixelInto } from '../tileEngine/strokeComposite';
import { BrushSettings, Point } from '../../types/editor';

function createMockCanvas(initWidth: number = 128, initHeight: number = 128) {
  let width = initWidth;
  let height = initHeight;
  let pixelBuffer = new Uint8ClampedArray(width * height * 4);
  const drawnDabs: {
    x: number;
    y: number;
    width: number;
    height: number;
    alpha: number;
  }[] = [];

  const ensureSize = () => {
    const needed = Math.max(1, width) * Math.max(1, height) * 4;
    if (pixelBuffer.length !== needed) {
      pixelBuffer = new Uint8ClampedArray(needed);
    }
  };

  const canvasObj: any = {
    get width() {
      return width;
    },
    set width(v: number) {
      width = v;
      ensureSize();
    },
    get height() {
      return height;
    },
    set height(v: number) {
      height = v;
      ensureSize();
    },
    get pixelBuffer() {
      return pixelBuffer;
    },
    drawnDabs,
    lastImageData: null as { width: number; height: number; data: Uint8ClampedArray } | null,
  };

  const ctx: any = {
    canvas: canvasObj,
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
      canvasObj.lastImageData = {
        width: imgData.width,
        height: imgData.height,
        data: new Uint8ClampedArray(imgData.data),
      };
      if (imgData.data.length === pixelBuffer.length) {
        pixelBuffer.set(imgData.data);
      } else {
        pixelBuffer = new Uint8ClampedArray(imgData.data);
      }
    },
    getImageData: (sx: number = 0, sy: number = 0, sw: number = width, sh: number = height) => {
      const out = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y++) {
        const srcY = sy + y;
        if (srcY < 0 || srcY >= height) continue;
        for (let x = 0; x < sw; x++) {
          const srcX = sx + x;
          if (srcX < 0 || srcX >= width) continue;
          const sIdx = (srcY * width + srcX) << 2;
          const dIdx = (y * sw + x) << 2;
          out[dIdx] = pixelBuffer[sIdx];
          out[dIdx + 1] = pixelBuffer[sIdx + 1];
          out[dIdx + 2] = pixelBuffer[sIdx + 2];
          out[dIdx + 3] = pixelBuffer[sIdx + 3];
        }
      }
      return { width: sw, height: sh, data: out };
    },
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

  canvasObj.getContext = (type: string) => (type === '2d' ? ctx : null);
  canvasObj.toDataURL = () =>
    `data:image/png;base64,MOCK_${width}x${height}_${pixelBuffer.reduce((a, b) => (a + b) & 0xffff, 0)}`;

  return canvasObj;
}

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  };
}

describe('Pre-Installed Standard Brushes, CSP Pen Port & Pro Painting/Blending Physics', () => {
  beforeEach(() => {
    (globalThis as any).localStorage = createMemoryStorage();
    resetBrushSettingsCache();

    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') return createMockCanvas();
        return {};
      },
    };
    (globalThis as any).Image = class MockImage {
      src = '';
      complete = true;
      naturalWidth = 256;
      naturalHeight = 256;
      width = 256;
      height = 256;
      decode() {
        return Promise.resolve();
      }
    };
  });

  it('registers all 35 built-in brushes cleanly across Pen (6), Sketch (5), Brush (9), Blend (6), and Natural Paint (9)', () => {
    expect(BUILTIN_BRUSH_SECTIONS.map((s) => s.id)).toEqual([
      'pen',
      'sketch',
      'brush',
      'blend',
      'natural-paint',
    ]);

    const penIds = BUILTIN_BRUSHES.filter((b) => b.category === 'pen').map((b) => b.id);
    const sketchIds = BUILTIN_BRUSHES.filter((b) => b.category === 'sketch').map((b) => b.id);
    const brushIds = BUILTIN_BRUSHES.filter((b) => b.category === 'brush').map((b) => b.id);
    const blendIds = BUILTIN_BRUSHES.filter((b) => b.category === 'blend').map((b) => b.id);
    const naturalIds = BUILTIN_BRUSHES.filter((b) => b.category === 'natural-paint').map((b) => b.id);

    expect(penIds).toEqual([
      'g-pen',
      'real-g-pen',
      'textured-pen',
      'rough-pen',
      'dot-pen',
      'calligraphy',
    ]);
    expect(sketchIds).toEqual([
      'mechanical-pencil',
      'pencil-hb-2b',
      'pencil-6b-8b',
      'charcoal-pencil',
      'standard-chalk',
    ]);
    expect(brushIds).toEqual([
      'oil-flat-alla-prima',
      'thick-oil-impasto',
      'dry-bristle-rake-paint',
      'concept-matte-chalk',
      'silky-portrait-round',
      'canvas-scumble-oil',
      'soft-glaze-airbrush',
      'atmospheric-grain-shader',
      'fine-detail-filbert',
    ]);
    expect(blendIds).toEqual([
      'blend-velvet-soft',
      'blend-oil-bristle',
      'blend-matte-chalk',
      'blend-rake-hair',
      'blend-canvas-scumble',
      'blend-fingertip',
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
    expect(BUILTIN_BRUSHES).toHaveLength(35);
  });

  it('generates deterministic non-empty PNG assets for tips, sub-tips, dual tips, and paper textures across all 35 presets', () => {
    prewarmBuiltinBrushAssets();
    for (const def of BUILTIN_BRUSHES) {
      const cfg = getBuiltinBrushConfig(def.id);
      expect(cfg).not.toBeNull();
      expect(cfg?.preset).toBe(def.id);
      if (def.tipGenerator) {
        expect(cfg?.customTipDataUrl).toMatch(/^data:image\/png;base64,/);
        expect(cfg?.customTipImage).toBeDefined();
      }
      if (def.subTipGenerators && def.subTipGenerators.length > 0) {
        expect(cfg?.subTips).toHaveLength(def.subTipGenerators.length);
        expect(cfg?.subTipImages).toHaveLength(def.subTipGenerators.length);
        for (const st of cfg!.subTips!) {
          expect(st.dataUrl).toMatch(/^data:image\/png;base64,/);
        }
      }
      if (def.dualTipGenerator) {
        expect(cfg?.dualTipDataUrl).toMatch(/^data:image\/png;base64,/);
        expect(cfg?.dualTipImage).toBeDefined();
        expect(cfg?.dualBrushConfig?.tipDataUrl).toMatch(/^data:image\/png;base64,/);
        expect(cfg?.dualBrushConfig?.tipImage).toBeDefined();
      }
      if (def.paperTextureGenerator) {
        expect(cfg?.paperTexture).toMatch(/^data:image\/png;base64,/);
        expect(cfg?.paperTextureImage).toBeDefined();
      }
    }
  });

  it('enforces official CSP Pen contracts for G-Pen, Real G-Pen, Textured Pen, and Rough Pen (Ribbon)', () => {
    // 1. G-Pen: analytical circular tip, linear pressure + exact CSP tilt swell (1.0..1.5)
    const gPen = getBuiltinBrushConfig('g-pen')!;
    expect(gPen.customTipDataUrl).toBeUndefined();
    expect(gPen.size).toBe(12);
    expect(gPen.hardness).toBe(1.0);
    expect(gPen.antiAlias).toBe(2);
    expect(gPen.sharpCorners).toBe(true);
    expect(gPen.sizeSensor?.usePressure).toBe(true);
    expect(gPen.sizeSensor?.useTilt).toBe(true);
    expect(gPen.sizeSensor?.tiltMin).toBe(1.0);
    expect(gPen.sizeSensor?.tiltMax).toBe(1.5);
    expect(gPen.sizeSensor?.tiltCurve).toEqual([
      [0.0, 1.0],
      [0.2455, 0.9273],
      [0.3909, 0.4],
      [0.6545, 0.0],
      [1.0, 0.0],
    ]);

    // 2. Real G-Pen: custom jagged porous tip, concave J-curve + tilt + pressure nib spread, no artificial grain
    const realG = getBuiltinBrushConfig('real-g-pen')!;
    expect(realG.customTipDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(realG.size).toBe(10);
    expect(realG.thickness).toBe(0.85);
    expect(realG.thicknessVertical).toBe(false);
    expect(realG.grain ?? 0).toBe(0);
    expect(realG.customTipAngleDynamics).toBe('random');
    expect(realG.sizeSensor?.pressureCurve).toEqual([
      [0.0, 0.0],
      [0.7455, 0.2545],
      [1.0, 1.0],
    ]);
    expect(realG.sizeSensor?.tiltMin).toBe(1.0);
    expect(realG.sizeSensor?.tiltMax).toBe(1.5);
    expect(realG.thicknessSensor?.usePressure).toBe(true);
    expect(realG.thicknessSensor?.pressureMin).toBe(0.5);

    // 3. Textured Pen: analytical ellipse, NO raster tip, compare-density combine mode, antiAlias=1
    const texPen = getBuiltinBrushConfig('textured-pen')!;
    expect(texPen.customTipDataUrl).toBeUndefined();
    expect(texPen.size).toBe(12);
    expect(texPen.thickness).toBe(0.6);
    expect(texPen.thicknessVertical).toBe(true);
    expect(texPen.hardness).toBe(0.6);
    expect(texPen.spacing).toBe(0.1);
    expect(texPen.antiAlias).toBe(1);
    expect(texPen.brushCombineMode).toBe('compare-density');
    expect(texPen.customTipAngleDynamics).toBe('random');
    expect(texPen.useTilt).toBe(false);

    // Verify compare-density compositing prevents semi-transparent alpha stacking on transparent layers
    // while still drawing solid/anti-aliased dark ink cleanly over opaque filled layers (da === 255).
    const pxOut: [number, number, number, number] = [0, 0, 0, 0];
    // Same-color semi-transparent overlap: alpha stays max(140, 140) = 140
    compositeBrushPixelInto(10, 10, 10, 140, 10, 10, 10, 140, 'source-over', 'compare-density', pxOut);
    expect(pxOut[3]).toBe(140);
    // Solid black ink over opaque cream paper (da = 255): must draw solid black, never invisible!
    compositeBrushPixelInto(248, 245, 238, 255, 12, 12, 16, 255, 'source-over', 'compare-density', pxOut);
    expect(pxOut[0]).toBe(12);
    expect(pxOut[1]).toBe(12);
    expect(pxOut[2]).toBe(16);
    expect(pxOut[3]).toBe(255);
    // Semi-transparent feathered ink edge (effA = 128) over opaque cream paper: blends cleanly
    compositeBrushPixelInto(248, 245, 238, 255, 0, 0, 0, 128, 'source-over', 'compare-density', pxOut);
    expect(pxOut[0]).toBeLessThan(140);
    expect(pxOut[3]).toBe(255);

    // 4. Rough Pen: Ribbon brush, adapted comfortable pixel size (not raw 1.2mm), 4-source sizeSensor & 2-source thicknessSensor
    const roughPen = getBuiltinBrushConfig('rough-pen')!;
    expect(roughPen.isRibbon).toBe(true);
    expect(roughPen.size!).toBeGreaterThanOrEqual(10);
    expect(roughPen.antiAlias).toBe(1);
    expect(roughPen.thickness).toBe(1.5);
    expect(roughPen.thicknessVertical).toBe(true);
    expect(roughPen.subTips?.length).toBe(3);
    expect(roughPen.subTips?.[0].width).toBe(64);
    expect(roughPen.subTips?.[0].height).toBe(512);
    expect(roughPen.subTipOrder).toBe('random');
    expect(roughPen.flipH).toBe('alternate');
    expect(roughPen.flipV).toBe('alternate');
    expect(roughPen.sizeSensor?.usePressure).toBe(true);
    expect(roughPen.sizeSensor?.useTilt).toBe(true);
    expect(roughPen.sizeSensor?.tiltMax).toBe(2.0);
    expect(roughPen.sizeSensor?.useVelocity).toBe(true);
    expect(roughPen.sizeSensor?.velocityMin).toBe(0.5);
    expect(roughPen.sizeSensor?.useRandom).toBe(true);
    expect(roughPen.sizeSensor?.randomMin).toBe(0.8);
    expect(roughPen.thicknessSensor?.useVelocity).toBe(true);
    expect(roughPen.thicknessSensor?.useRandom).toBe(true);
  });

  it('orients Rough Pen ribbon UVs strictly along the stroke path (vertical strip Y maps along stroke, X across width)', () => {
    const roughEffective = getEffectiveBrushSettings('rough-pen') as BrushSettings;
    // Override mock image dimensions to match real 64x512 vertical ribbon tip
    const verticalTipImg: any = {
      src: roughEffective.customTipDataUrl,
      complete: true,
      naturalWidth: 64,
      naturalHeight: 512,
      width: 64,
      height: 512,
    };
    const ribbonBs: BrushSettings = {
      ...roughEffective,
      color: '#111111',
      customTipImage: verticalTipImg,
      subTipImages: [verticalTipImg],
    };
    expect(isRibbonBrush(ribbonBs)).toBe(true);

    const ribbonOpts = buildRibbonRenderOptionsFromBrushSettings(
      ribbonBs,
      'color',
      false,
      false,
      false,
      false,
      undefined,
      { useGpu: false }
    );
    const pts: Point[] = [
      { x: 20, y: 100, pressure: 0.85, width: 11, timestamp: 0 },
      { x: 100, y: 100, pressure: 0.85, width: 11, timestamp: 50 },
      { x: 200, y: 100, pressure: 0.85, width: 11, timestamp: 100 },
    ];
    const mesh = buildRibbonMeshFromPoints(pts, ribbonOpts);
    expect(mesh.triangleCount).toBeGreaterThan(8);

    // Vertex stride = 9: [x, y, u, v, alpha, pressure, tipIndex, edgeDist, ribbonWidth]
    // First triangle vertices are (L0, R0, L1):
    // L0 -> R0 must span texture X (uTex) across width, while L0 -> L1 must advance texture Y (vTex) along stroke.
    const stride = 9;
    const verts = mesh.vertices;
    const uL0 = verts[0 * stride + 2];
    const vL0 = verts[0 * stride + 3];
    const uR0 = verts[1 * stride + 2];
    const vR0 = verts[1 * stride + 3];
    const uL1 = verts[2 * stride + 2];
    const vL1 = verts[2 * stride + 3];

    const dUAcross = Math.abs(uR0 - uL0);
    const dVAcross = Math.abs(vR0 - vL0);
    const dUAlong = Math.abs(uL1 - uL0);
    const dVAlong = Math.abs(vL1 - vL0);

    expect(dUAcross).toBeGreaterThan(0.9);
    expect(dVAcross).toBeLessThan(0.05);
    expect(dVAlong).toBeGreaterThan(0.01);
    expect(dUAlong).toBeLessThan(0.05);
  });

  it('enforces authentic Sketch pencil physics contracts across grades (untouched)', () => {
    const mech = getBuiltinBrushConfig('mechanical-pencil')!;
    const hb2b = getBuiltinBrushConfig('pencil-hb-2b')!;
    const b68 = getBuiltinBrushConfig('pencil-6b-8b')!;
    const charcoal = getBuiltinBrushConfig('charcoal-pencil')!;

    expect(mech.useTilt).toBe(false);
    expect(mech.size).toBeLessThanOrEqual(3);
    expect(mech.grain).toBeLessThan(0.4);
    expect(mech.hardness).toBeGreaterThanOrEqual(0.9);
    expect(mech.paperTextureMode).toBe('compare');

    expect(hb2b.useTilt).toBe(true);
    expect(hb2b.tiltScale!).toBeGreaterThan(0.5);
    expect(hb2b.tiltScale!).toBeLessThan(1.2);
    expect(hb2b.grain!).toBeGreaterThan(mech.grain!);
    expect(hb2b.grain!).toBeLessThan(b68.grain!);
    expect(hb2b.opacitySensor?.usePressure).toBe(true);
    expect(hb2b.paperTextureMode).toBe('compare');

    expect(b68.useTilt).toBe(true);
    expect(b68.tiltScale!).toBeGreaterThanOrEqual(1.8);
    expect(b68.grain!).toBeGreaterThanOrEqual(0.8);
    expect(b68.paperTextureMode).toBe('compare');

    expect(charcoal.useTilt).toBe(true);
    expect(charcoal.tiltScale!).toBeGreaterThanOrEqual(2.0);
    expect(charcoal.grain!).toBeGreaterThanOrEqual(0.88);
    expect(charcoal.dynamics?.scatter).toBeGreaterThan(0);
    expect(charcoal.paperTextureMode).toBe('compare');
  });

  it('cuts recessed paper valleys to exact zero at light/medium pressure and clogs only under heavy pressure (compare mode)', () => {
    const valleyHeight = 0.22;
    const ridgeHeight = 0.82;

    const valleyLight = applyCspPaperTextureAlpha(0.9, valleyHeight, 0.86, 0.25, 'compare');
    const valleyMed = applyCspPaperTextureAlpha(0.9, valleyHeight, 0.86, 0.5, 'compare');
    const ridgeMed = applyCspPaperTextureAlpha(0.9, ridgeHeight, 0.86, 0.5, 'compare');
    expect(valleyLight).toBe(0);
    expect(valleyMed).toBe(0);
    expect(ridgeMed).toBeGreaterThan(0.8);

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

    const avgUpW = cUp.drawnDabs.reduce((s: number, d: any) => s + d.width, 0) / cUp.drawnDabs.length;
    const avgTiltW = cTilt.drawnDabs.reduce((s: number, d: any) => s + d.width, 0) / cTilt.drawnDabs.length;
    const avgUpA = cUp.drawnDabs.reduce((s: number, d: any) => s + d.alpha, 0) / cUp.drawnDabs.length;
    const avgTiltA = cTilt.drawnDabs.reduce((s: number, d: any) => s + d.alpha, 0) / cTilt.drawnDabs.length;
    expect(avgTiltW).toBeGreaterThan(avgUpW * 2.5);
    expect(avgTiltA).toBeLessThan(avgUpA);

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

    const mUpW = mUp.drawnDabs.reduce((s: number, d: any) => s + d.width, 0) / mUp.drawnDabs.length;
    const mTiltW = mTilt.drawnDabs.reduce((s: number, d: any) => s + d.width, 0) / mTilt.drawnDabs.length;
    expect(mTiltW).toBeCloseTo(mUpW, 4);
  });

  it('configures the upgraded 9-brush painterly Brush suite with high-res tips, Dual Brush tooth, multi-tip scumble, and perceptual pigment mixing', () => {
    const oilFlat = getBuiltinBrushConfig('oil-flat-alla-prima')!;
    expect(oilFlat.colorMixing).toBe(true);
    expect(oilFlat.perceptualMixing).toBe(true);
    expect(oilFlat.customTipAngle).toBe(-22);
    expect(oilFlat.customTipAngleDynamics).toBe('none');
    expect(oilFlat.thickness).toBe(0.72);

    const thickImpasto = getBuiltinBrushConfig('thick-oil-impasto')!;
    expect(thickImpasto.mixingMode).toBe('running_color');
    expect(thickImpasto.amountOfPaint!).toBeGreaterThanOrEqual(0.8);

    const rakePaint = getBuiltinBrushConfig('dry-bristle-rake-paint')!;
    expect(rakePaint.mixingMode).toBe('running_color');
    expect(rakePaint.customTipAngleDynamics).toBe('direction');
    expect(rakePaint.surfaceTextureId).toBe('linen-canvas');

    const matteChalk = getBuiltinBrushConfig('concept-matte-chalk')!;
    expect(matteChalk.dualBrush).toBe(true);
    expect(matteChalk.dualBrushConfig?.enabled).toBe(true);
    expect(matteChalk.dualBrushConfig?.tipImage).toBeDefined();
    expect(resolveDualBrushConfig(matteChalk as BrushSettings)).not.toBeNull();
    expect(matteChalk.customTipAngleDynamics).toBe('none');
    expect(matteChalk.paperTextureMode).toBe('compare');
    expect(matteChalk.amountOfPaint!).toBeGreaterThanOrEqual(0.8);

    const scumble = getBuiltinBrushConfig('canvas-scumble-oil')!;
    expect(scumble.subTips?.length).toBe(4);
    expect(scumble.surfaceTextureId).toBe('linen-canvas');
    expect(scumble.dynamics?.colorJitterEnabled).toBe(true);
    expect(scumble.dynamics?.temperatureJitter!).toBeGreaterThan(0);

    const airbrush = getBuiltinBrushConfig('soft-glaze-airbrush')!;
    expect(airbrush.customTipDataUrl).toBeUndefined();
    expect(airbrush.hardness).toBe(0.0);
    expect(airbrush.flow!).toBeLessThanOrEqual(0.3);
    expect(airbrush.adjustDensityByGap).toBe(true);
    expect(airbrush.opacitySensor?.usePressure).toBe(true);

    const fineDetail = getBuiltinBrushConfig('fine-detail-filbert')!;
    expect(fineDetail.size!).toBeLessThanOrEqual(12);
    expect(fineDetail.amountOfPaint!).toBeGreaterThanOrEqual(0.9);
  });

  it('enforces pure-smear invariants across all 6 Blend brushes (zero blank deposition, zero first-contact foreground contamination)', () => {
    const blendDefs = BUILTIN_BRUSHES.filter((b) => b.category === 'blend');
    expect(blendDefs).toHaveLength(6);

    const blankCanvas = createMockCanvas(64, 64);
    const blankSampler = new LayerPixelSampler(blankCanvas);

    for (const def of blendDefs) {
      const cfg = getBuiltinBrushConfig(def.id)!;
      expect(cfg.colorMixing).toBe(true);
      expect(cfg.perceptualMixing).toBe(true);
      expect(cfg.amountOfPaint).toBe(0);
      expect(cfg.mixingMode).toBe('smear');

      // 1. PaintReservoir on blank canvas emits alpha === 0
      const resBlank = new PaintReservoir('#ff0000');
      const blankOut = resBlank.mixWithCanvas(
        { r: 255, g: 255, b: 255, a: 0 },
        cfg.amountOfPaint!,
        cfg.densityOfPaint ?? 0.85,
        cfg.colorStretch ?? 0.78,
        'smear',
        0.8,
        0.8,
        0,
        true
      );
      expect(blankOut.alpha).toBe(0);

      // 2. SpatialTipMixer on blank canvas with bright red foreground emits zero visible pixels
      const spatialBlank = new SpatialTipMixer('#ff0000');
      const stampBlank = spatialBlank.stepAndBuildStamp({
        sampler: blankSampler,
        x: 32,
        y: 32,
        width: 24,
        height: 24,
        angleRad: 0,
        dirX: 1,
        dirY: 0,
        stepDist: 2,
        hardness: cfg.hardness ?? 0.5,
        antiAlias: 2,
        flipX: 1,
        flipY: 1,
        flow: cfg.flow ?? 0.6,
        pressure: 0.7,
        pressureAlreadyApplied: false,
        amountOfPaint: cfg.amountOfPaint!,
        densityOfPaint: cfg.densityOfPaint ?? 0.85,
        colorStretch: cfg.colorStretch ?? 0.78,
        mixingMode: 'smear',
        isPureBlender: true,
        perceptualMixing: true,
        useBlur: Boolean(cfg.useBlur),
        blurStrength: cfg.blurStrength,
      });
      expect(!stampBlank || !stampBlank.hasVisiblePixels).toBe(true);

      // 3. First contact with pure blue canvas paint must never mix in red foreground
      const resBlue = new PaintReservoir('#ff0000');
      const firstContact = resBlue.mixWithCanvas(
        { r: 0, g: 40, b: 220, a: 1.0 },
        cfg.amountOfPaint!,
        cfg.densityOfPaint ?? 0.85,
        cfg.colorStretch ?? 0.78,
        'smear',
        0.8,
        0.8,
        0,
        true
      );
      expect(firstContact.r).toBe(0);
      expect(firstContact.g).toBe(40);
      expect(firstContact.b).toBe(220);
      expect(firstContact.alpha).toBeGreaterThan(0.1);
    }

    // Specific Blend brush character contracts
    expect(getBuiltinBrushConfig('blend-velvet-soft')!.useBlur).toBe(true);
    expect(getBuiltinBrushConfig('blend-velvet-soft')!.blurStrength!).toBeGreaterThanOrEqual(0.3);
    expect(getBuiltinBrushConfig('blend-oil-bristle')!.useBlur).toBe(false);
    expect(getBuiltinBrushConfig('blend-rake-hair')!.useBlur).toBe(false);
    expect(getBuiltinBrushConfig('blend-fingertip')!.useBlur).toBe(false);
    expect(getBuiltinBrushConfig('blend-matte-chalk')!.paperTextureMode).toBe('compare');
    expect(getBuiltinBrushConfig('blend-canvas-scumble')!.surfaceTextureId).toBe('linen-canvas');
  });

  it('produces measurably smoother transitions across a hard color seam in SpatialTipMixer when useBlur is enabled', () => {
    // Build a 64x64 canvas with a razor-sharp vertical seam at x = 32: left = pure red, right = pure blue
    const seamCanvas = createMockCanvas(64, 64);
    const buf = seamCanvas.pixelBuffer as Uint8ClampedArray;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const idx = (y * 64 + x) << 2;
        if (x < 32) {
          buf[idx] = 230;
          buf[idx + 1] = 25;
          buf[idx + 2] = 25;
          buf[idx + 3] = 255;
        } else {
          buf[idx] = 25;
          buf[idx + 1] = 45;
          buf[idx + 2] = 230;
          buf[idx + 3] = 255;
        }
      }
    }

    const samplerSharp = new LayerPixelSampler(seamCanvas);
    const samplerBlur = new LayerPixelSampler(seamCanvas);

    const sharpMixer = new SpatialTipMixer('#00ff00');
    const blurMixer = new SpatialTipMixer('#00ff00');

    const baseParams = {
      x: 32,
      y: 32,
      width: 32,
      height: 32,
      angleRad: 0,
      dirX: 1,
      dirY: 0,
      stepDist: 2,
      hardness: 0.9,
      antiAlias: 2,
      flipX: 1,
      flipY: 1,
      flow: 0.85,
      pressure: 0.8,
      pressureAlreadyApplied: false,
      amountOfPaint: 0,
      densityOfPaint: 0.9,
      colorStretch: 0.85,
      mixingMode: 'smear' as const,
      isPureBlender: true,
      perceptualMixing: true,
    };

    const sharpStamp = sharpMixer.stepAndBuildStamp({
      ...baseParams,
      sampler: samplerSharp,
      useBlur: false,
    })!;
    const blurStamp = blurMixer.stepAndBuildStamp({
      ...baseParams,
      sampler: samplerBlur,
      useBlur: true,
      blurStrength: 0.6,
    })!;

    expect(sharpStamp.hasVisiblePixels).toBe(true);
    expect(blurStamp.hasVisiblePixels).toBe(true);

    const sharpData = (sharpStamp.canvas as any).lastImageData as {
      width: number;
      height: number;
      data: Uint8ClampedArray;
    };
    const blurData = (blurStamp.canvas as any).lastImageData as {
      width: number;
      height: number;
      data: Uint8ClampedArray;
    };

    // Measure maximum horizontal step delta across the middle row (y = height / 2)
    // and count intermediate mixed pixels (both R > 60 and B > 60)
    const measureRow = (img: { width: number; height: number; data: Uint8ClampedArray }) => {
      const midY = Math.floor(img.height / 2);
      let maxDelta = 0;
      let mixedPxCount = 0;
      let sampleCount = 0;
      for (let x = 4; x < img.width - 5; x++) {
        const i0 = (midY * img.width + x) << 2;
        const i1 = (midY * img.width + x + 1) << 2;
        if (img.data[i0 + 3] < 20 || img.data[i1 + 3] < 20) continue;
        sampleCount++;
        const dr = Math.abs(img.data[i1] - img.data[i0]);
        const db = Math.abs(img.data[i1 + 2] - img.data[i0 + 2]);
        maxDelta = Math.max(maxDelta, dr + db);
        if (img.data[i0] > 60 && img.data[i0 + 2] > 60) {
          mixedPxCount++;
        }
      }
      return { maxDelta, mixedPxCount, sampleCount };
    };

    const sharpMetrics = measureRow(sharpData);
    const blurMetrics = measureRow(blurData);

    // Ensure real visible pixels were sampled, and optical blur measurably softens the seam gradient
    expect(sharpMetrics.sampleCount).toBeGreaterThan(10);
    expect(blurMetrics.sampleCount).toBeGreaterThan(10);
    expect(sharpMetrics.maxDelta).toBeGreaterThan(120);
    expect(blurMetrics.maxDelta).toBeLessThan(sharpMetrics.maxDelta * 0.72);
    expect(blurMetrics.mixedPxCount).toBeGreaterThan(sharpMetrics.mixedPxCount);
  });

  it('migrates schema v3 -> v4 cleanly, maps all legacy preset IDs, preserves Sketch/Natural Paint overrides, and retains built-in dual tips on reload', () => {
    expect(BUILTIN_PRESET_SCHEMA_VERSION).toBe(4);

    // Seed v3 localStorage with stale Pen/Brush/Blend overrides AND preserved Sketch/Natural Paint overrides
    localStorage.setItem('ink_studio_brush_preset_schema_v', '3');
    localStorage.setItem(
      STORAGE_KEY_SETTINGS,
      JSON.stringify({
        'g-pen': { size: 99 },
        'oil-painting': { size: 77 },
        'blend-brush': { size: 66 },
        'pencil-hb-2b': { size: 7.5 },
        'impasto-bristle-oil': { size: 62 },
      })
    );
    localStorage.setItem(STORAGE_KEY_ACTIVE_PRESET, 'chalk-painting');
    resetBrushSettingsCache();

    const loaded = loadAllSavedBrushSettings();
    expect(localStorage.getItem('ink_studio_brush_preset_schema_v')).toBe('4');
    // Stale v3 upgraded/replaced IDs cleared
    expect(loaded['g-pen']).toBeUndefined();
    expect(loaded['oil-painting']).toBeUndefined();
    expect(loaded['blend-brush']).toBeUndefined();
    // Sketch & Natural Paint overrides strictly preserved
    expect(loaded['pencil-hb-2b']?.size).toBe(7.5);
    expect(loaded['impasto-bristle-oil']?.size).toBe(62);

    // Active preset migrated cleanly from legacy ID
    const active = getActivePresetId();
    expect(active).toBe('concept-matte-chalk');
    expect(localStorage.getItem(STORAGE_KEY_ACTIVE_PRESET)).toBe('concept-matte-chalk');

    // Every legacy mapping resolves to a valid built-in brush
    for (const [oldId, newId] of Object.entries(LEGACY_PRESET_ID_MAP)) {
      expect(migrateLegacyPresetId(oldId)).toBe(newId);
      expect(getBuiltinBrushConfig(newId)).not.toBeNull();
      expect(getEffectiveBrushSettings(oldId).preset).toBe(newId);
    }

    // Saving a user tweak to Concept Matte Chalk (Dual Brush) must NOT wipe procedural dual tipImage on reload
    const chalk = getEffectiveBrushSettings('concept-matte-chalk');
    saveBrushSettingsImmediately('concept-matte-chalk', {
      ...chalk,
      size: 55,
      dualBrushConfig: {
        ...chalk.dualBrushConfig!,
        size: 36,
      },
    });
    resetBrushSettingsCache();
    const reloadedChalk = getEffectiveBrushSettings('concept-matte-chalk');
    expect(reloadedChalk.size).toBe(55);
    expect(reloadedChalk.dualBrushConfig?.size).toBe(36);
    expect(reloadedChalk.dualBrushConfig?.tipDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(reloadedChalk.dualBrushConfig?.tipImage).toBeDefined();
  });

  it('resets ribbon, dual brush, compare-density, blur, sub-tips, dynamics, grain, and colorMixing cleanly when switching presets (zero state leakage)', () => {
    const rough = getEffectiveBrushSettings('rough-pen');
    expect(rough.isRibbon).toBe(true);
    expect(rough.subTips?.length).toBeGreaterThan(0);
    expect(rough.thicknessSensor?.useVelocity).toBe(true);

    const chalk = getEffectiveBrushSettings('concept-matte-chalk');
    expect(chalk.dualBrush).toBe(true);
    expect(chalk.dualBrushConfig?.enabled).toBe(true);

    const tex = getEffectiveBrushSettings('textured-pen');
    expect(tex.brushCombineMode).toBe('compare-density');

    const velvetBlend = getEffectiveBrushSettings('blend-velvet-soft');
    expect(velvetBlend.useBlur).toBe(true);
    expect(velvetBlend.blurStrength).toBeGreaterThan(0);
    expect(velvetBlend.mixingMode).toBe('smear');

    const scumble = getEffectiveBrushSettings('canvas-scumble-oil');
    expect(scumble.dynamics?.colorJitterEnabled).toBe(true);

    const charcoal = getEffectiveBrushSettings('charcoal-pencil');
    expect(charcoal.dynamics?.scatter).toBeGreaterThan(0);
    expect(charcoal.grain).toBeGreaterThan(0.8);

    // Switching to G-Pen resets every specialized feature cleanly (while keeping G-Pen's CSP tilt curve)
    const gPen = getEffectiveBrushSettings('g-pen');
    expect(gPen.isRibbon).toBe(false);
    expect(gPen.dualBrush).toBe(false);
    expect(gPen.dualBrushConfig).toBeUndefined();
    expect(gPen.brushCombineMode).toBeUndefined();
    expect(gPen.useBlur).toBe(false);
    expect(gPen.blurStrength).toBeUndefined();
    expect(gPen.thicknessSensor).toBeUndefined();
    expect(gPen.subTips).toBeUndefined();
    expect(gPen.subTipImages).toBeUndefined();
    expect(gPen.dynamics).toBeUndefined();
    expect(gPen.grain).toBe(0);
    expect(gPen.colorMixing).toBe(false);
    expect(gPen.opacitySensor).toBeUndefined();
    expect(gPen.densitySensor).toBeUndefined();
    expect(gPen.customTipImage).toBeUndefined();
    expect(gPen.paperTextureImage).toBeUndefined();
    expect(gPen.useTilt).toBe(true);

    // Switching to Dot Pen also clears tilt completely
    const dotPen = getEffectiveBrushSettings('dot-pen');
    expect(dotPen.useTilt).toBe(false);
    expect(dotPen.sizeSensor).toBeUndefined();
    expect(dotPen.isRibbon).toBe(false);
    expect(dotPen.dualBrush).toBe(false);
    expect(dotPen.useBlur).toBe(false);
  });
});
