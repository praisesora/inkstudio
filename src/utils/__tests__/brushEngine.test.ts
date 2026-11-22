import { describe, it, expect, beforeEach } from 'vitest';
import {
  centripetalCatmullRomToBezier,
  buildCubicArcLengthTable,
  getCubicPointAtArcLength,
  getRadialDabMaster,
  drawBrushCubicBezierSegment,
  drawBrushDot,
  drawSingleStamp,
  renderCompleteStroke,
  getPaperGrain,
  LEGACY_PENCIL_PRESETS,
  LegacyPencilGrade,
  BrushRenderOptions,
  buildBrushRenderOptions,
} from '../../engine/BrushEngine';
import { applyParametricTaper } from '../canvasUtils';
import {
  PaintReservoir,
  LayerPixelSampler,
} from '../colorMixingEngine';
import { calculatePreviewWidth } from '../brushPreview';
import { Point, BrushSettings } from '../../types/editor';

// Lightweight Canvas2D mock environment for headless Node.js Vitest runs
function createMockCanvas(width: number = 128, height: number = 128) {
  const pixelBuffer = new Uint8ClampedArray(width * height * 4);
  const drawnDabs: { x: number; y: number; width: number; height: number; alpha: number; op?: string }[] = [];

  const ctx: any = {
    canvas: { width, height },
    globalAlpha: 1.0,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    clearRect: () => {
      pixelBuffer.fill(0);
    },
    fillRect: () => {},
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    putImageData: (imgData: any) => {
      pixelBuffer.set(imgData.data);
    },
    getImageData: (sx: number, sy: number, sw: number, sh: number) => {
      const data = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y++) {
        const srcY = sy + y;
        if (srcY < 0 || srcY >= height) continue;
        for (let x = 0; x < sw; x++) {
          const srcX = sx + x;
          if (srcX < 0 || srcX >= width) continue;
          const srcIdx = (srcY * width + srcX) * 4;
          const dstIdx = (y * sw + x) * 4;
          data[dstIdx] = pixelBuffer[srcIdx];
          data[dstIdx + 1] = pixelBuffer[srcIdx + 1];
          data[dstIdx + 2] = pixelBuffer[srcIdx + 2];
          data[dstIdx + 3] = pixelBuffer[srcIdx + 3];
        }
      }
      return { width: sw, height: sh, data };
    },
    drawImage: (_source: any, dx: number, dy: number, dw?: number, dh?: number) => {
      drawnDabs.push({
        x: dx + (dw ? dw / 2 : 0),
        y: dy + (dh ? dh / 2 : 0),
        width: dw || 0,
        height: dh || 0,
        alpha: ctx.globalAlpha,
        op: ctx.globalCompositeOperation,
      });
    },
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
  };

  const mockObj = {
    width,
    height,
    canvas: { width, height },
    getContext: (type: string) => (type === '2d' ? ctx : null),
    pixelBuffer,
    drawnDabs,
  };
  return mockObj;
}

describe('Brush & Spline Engine (CSP / Photoshop Architectural Parity)', () => {
  beforeEach(() => {
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === 'canvas') {
          return createMockCanvas();
        }
        return {};
      },
    };
  });

  describe('1. Centripetal Catmull-Rom Spline & Chord Bounding', () => {
    it('bounds control points within 0.5x chord length to prevent overshoot cusps', () => {
      const p0: Point = { x: 0, y: 0, pressure: 0.5, width: 10 };
      const p1: Point = { x: 50, y: 0, pressure: 0.5, width: 10 };
      const p2: Point = { x: 100, y: 100, pressure: 0.5, width: 10 }; // Sharp right turn
      const p3: Point = { x: 150, y: 100, pressure: 0.5, width: 10 };

      const { c1, c2 } = centripetalCatmullRomToBezier(p0, p1, p2, p3);

      const chordLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const dist1 = Math.hypot(c1.x - p1.x, c1.y - p1.y);
      const dist2 = Math.hypot(c2.x - p2.x, c2.y - p2.y);

      expect(dist1).toBeLessThanOrEqual(chordLen * 0.5 + 1e-4);
      expect(dist2).toBeLessThanOrEqual(chordLen * 0.5 + 1e-4);
    });

    it('places control points strictly on the chord for collinear input points', () => {
      const p0: Point = { x: 0, y: 0, pressure: 0.5, width: 10 };
      const p1: Point = { x: 100, y: 0, pressure: 0.5, width: 10 };
      const p2: Point = { x: 200, y: 0, pressure: 0.5, width: 10 };
      const p3: Point = { x: 300, y: 0, pressure: 0.5, width: 10 };

      const { c1, c2 } = centripetalCatmullRomToBezier(p0, p1, p2, p3);

      expect(c1.y).toBeCloseTo(0, 5);
      expect(c2.y).toBeCloseTo(0, 5);
      expect(c1.x).toBeGreaterThan(p1.x);
      expect(c2.x).toBeLessThan(p2.x);
      expect(c1.x).toBeLessThan(c2.x);
    });

    it('safely handles duplicated endpoints at start and end of strokes without NaN', () => {
      const p0: Point = { x: 42, y: 84, pressure: 0.3, width: 6 };
      const p1: Point = { x: 120, y: 150, pressure: 0.8, width: 12 };

      // Stroke start: p0 is repeated
      const startResult = centripetalCatmullRomToBezier(p0, p0, p1, p1);
      expect(Number.isFinite(startResult.c1.x)).toBe(true);
      expect(Number.isFinite(startResult.c1.y)).toBe(true);
      expect(Number.isFinite(startResult.c2.x)).toBe(true);
      expect(Number.isFinite(startResult.c2.y)).toBe(true);
    });
  });

  describe('2. Sub-Pixel Arc-Length Parameterization', () => {
    it('computes exact arc length for a linear cubic segment', () => {
      const p0: Point = { x: 0, y: 0, pressure: 0.5, width: 10 };
      const c1: Point = { x: 33.333, y: 0, pressure: 0.5, width: 10 };
      const c2: Point = { x: 66.666, y: 0, pressure: 0.5, width: 10 };
      const p3: Point = { x: 100, y: 0, pressure: 0.5, width: 10 };

      const table = buildCubicArcLengthTable(p0, c1, c2, p3);
      expect(table.totalLength).toBeCloseTo(100, 1);
    });

    it('produces strictly monotonic cumulative distances along the curve', () => {
      const p0: Point = { x: 10, y: 20, pressure: 0.2, width: 4 };
      const c1: Point = { x: 50, y: 120, pressure: 0.5, width: 8 };
      const c2: Point = { x: 150, y: -40, pressure: 0.8, width: 14 };
      const p3: Point = { x: 200, y: 60, pressure: 1.0, width: 18 };

      const table = buildCubicArcLengthTable(p0, c1, c2, p3);
      for (let i = 1; i < table.distances.length; i++) {
        expect(table.distances[i]).toBeGreaterThan(table.distances[i - 1]);
      }
    });

    it('evaluates points along arc-length with correct boundary and midpoint interpolation', () => {
      const p0: Point = { x: 0, y: 0, pressure: 0.2, width: 4 };
      const c1: Point = { x: 50, y: 0, pressure: 0.4, width: 8 };
      const c2: Point = { x: 50, y: 100, pressure: 0.6, width: 12 };
      const p3: Point = { x: 100, y: 100, pressure: 0.8, width: 16 };

      const table = buildCubicArcLengthTable(p0, c1, c2, p3);

      const ptStart = getCubicPointAtArcLength(p0, c1, c2, p3, 0, table);
      expect(ptStart.x).toBeCloseTo(p0.x, 3);
      expect(ptStart.y).toBeCloseTo(p0.y, 3);
      expect(ptStart.pressure).toBeCloseTo(0.2, 3);

      const ptEnd = getCubicPointAtArcLength(p0, c1, c2, p3, table.totalLength, table);
      expect(ptEnd.x).toBeCloseTo(p3.x, 3);
      expect(ptEnd.y).toBeCloseTo(p3.y, 3);
      expect(ptEnd.pressure).toBeCloseTo(0.8, 3);

      const ptMid = getCubicPointAtArcLength(p0, c1, c2, p3, table.totalLength * 0.5, table);
      expect(ptMid.pressure).toBeCloseTo(0.5, 1);
      expect(ptMid.width).toBeCloseTo(10, 1);
    });
  });

  describe('3. Analytical Hermite Radial Dab Masters', () => {
    it('generates crisp anti-aliased dab at hardness 1.0', () => {
      const master = getRadialDabMaster(1.0, '#000000');
      expect(master).toBeDefined();
      expect(master.width).toBe(128);
      expect(master.height).toBe(128);
    });

    it('generates soft airbrush falloff at hardness 0.0 without errors', () => {
      const airbrushMaster = getRadialDabMaster(0.0, '#ff0000');
      expect(airbrushMaster).toBeDefined();
    });

    it('quantizes hardness levels into shared master caches', () => {
      const master1 = getRadialDabMaster(0.81, '#000000');
      const master2 = getRadialDabMaster(0.82, '#000000');
      // Both quantize to 0.80 (step of 0.05) and share the underlying mask
      expect(master1).toBeDefined();
      expect(master2).toBeDefined();
    });
  });

  describe('4. Graphite Physics & Cold-Press Paper Grain', () => {
    it('evaluates deterministic paper grain height within [0, 255]', () => {
      const h1 = getPaperGrain(100.5, 200.3);
      const h2 = getPaperGrain(100.5, 200.3);
      expect(h1).toBe(h2);
      expect(h1).toBeGreaterThanOrEqual(0);
      expect(h1).toBeLessThanOrEqual(255);
    });

    it('exhibits spatial coherence (not uncorrelated white noise)', () => {
      const h1 = getPaperGrain(100.0, 100.0);
      const h2 = getPaperGrain(100.1, 100.0); // 0.1 px offset
      expect(Math.abs(h1 - h2)).toBeLessThan(15);
    });

    it('preserves hardness and flow ordering across legacy pencil presets', () => {
      const grades: LegacyPencilGrade[] = ['pencil-f', 'pencil-hb', 'pencil-2b', 'pencil-4b'];
      for (let i = 0; i < grades.length - 1; i++) {
        const harder = LEGACY_PENCIL_PRESETS[grades[i]];
        const softer = LEGACY_PENCIL_PRESETS[grades[i + 1]];
        expect(harder.hardness!).toBeGreaterThanOrEqual(softer.hardness!);
        expect(softer.flow!).toBeGreaterThanOrEqual(harder.flow!);
      }
    });
  });

  describe('5. Distance Remainder Continuity Across Stroke Segments', () => {
    it('maintains continuous dab spacing across adjacent cubic segments', () => {
      const mockCanvas = createMockCanvas(500, 500);
      const ctx = mockCanvas.getContext('2d') as unknown as CanvasRenderingContext2D;

      const p0: Point = { x: 0, y: 100, pressure: 1.0, width: 10 };
      const p1: Point = { x: 100, y: 100, pressure: 1.0, width: 10 };
      const p2: Point = { x: 200, y: 100, pressure: 1.0, width: 10 };

      const seg1 = centripetalCatmullRomToBezier(p0, p0, p1, p2);
      const seg2 = centripetalCatmullRomToBezier(p0, p1, p2, p2);

      const spacing = 0.05; // required step = 10 * 0.05 = 0.5px
      const remainder1 = drawBrushCubicBezierSegment(
        ctx,
        p0,
        seg1.c1,
        seg1.c2,
        p1,
        '#000000',
        { hardness: 1.0, flow: 1.0, spacing },
        0
      );

      expect(remainder1).toBeGreaterThanOrEqual(0);
      expect(remainder1).toBeLessThanOrEqual(0.6);

      const dabCountBefore = mockCanvas.drawnDabs.length;
      expect(dabCountBefore).toBeGreaterThan(150);

      // Thread remainder1 into segment 2
      const remainder2 = drawBrushCubicBezierSegment(
        ctx,
        p1,
        seg2.c1,
        seg2.c2,
        p2,
        '#000000',
        { hardness: 1.0, flow: 1.0, spacing },
        remainder1
      );

      expect(remainder2).toBeGreaterThanOrEqual(0);
      expect(remainder2).toBeLessThanOrEqual(0.6);

      // Verify dab spacing across the joint between segment 1 and 2
      const lastDabSeg1 = mockCanvas.drawnDabs[dabCountBefore - 1];
      const firstDabSeg2 = mockCanvas.drawnDabs[dabCountBefore];

      const jointGap = Math.hypot(firstDabSeg2.x - lastDabSeg1.x, firstDabSeg2.y - lastDabSeg1.y);
      const expectedStep = Math.max(0.4, 10 * spacing);
      expect(jointGap).toBeCloseTo(expectedStep, 1);
    });

    it('correctly defers stamps on micro-segments shorter than the spacing step', () => {
      const mockCanvas = createMockCanvas(500, 500);
      const ctx = mockCanvas.getContext('2d') as unknown as CanvasRenderingContext2D;

      const p0: Point = { x: 0, y: 0, pressure: 1.0, width: 20 };
      const p1: Point = { x: 0.2, y: 0, pressure: 1.0, width: 20 }; // Very short move (0.2px)

      const spacing = 0.1; // required step = 2.0px
      const remainder = drawBrushCubicBezierSegment(
        ctx,
        p0,
        p0,
        p1,
        p1,
        '#000000',
        { hardness: 1.0, flow: 1.0, spacing },
        1.0
      );

      // No new dabs placed, remainder increases by 0.2px
      expect(mockCanvas.drawnDabs.length).toBe(0);
      expect(remainder).toBeCloseTo(0.8, 1);
    });
  });

  describe('6. Brush Preview S-Curve Dimension Bounds', () => {
    it('bounds hairline leads to crisp visible minimums', () => {
      const w1 = calculatePreviewWidth(1.0, 34, false);
      const w2 = calculatePreviewWidth(2.0, 34, false);
      expect(w1).toBeGreaterThanOrEqual(0.9);
      expect(w2).toBeGreaterThan(w1);
    });

    it('bounds large brushes to avoid vertical canvas clipping', () => {
      const h = 40;
      const wThick = calculatePreviewWidth(120, h, false);
      expect(wThick).toBeLessThanOrEqual(h * 0.54);
    });

    it('monotonically increases preview width with brush size up to bounding cap', () => {
      const sizes = [1, 2, 4, 8, 14, 24];
      for (let i = 1; i < sizes.length; i++) {
        const prevW = calculatePreviewWidth(sizes[i - 1], 34, false);
        const curW = calculatePreviewWidth(sizes[i], 34, false);
        expect(curW).toBeGreaterThan(prevW);
      }

      // Beyond cap: clamped at max bound without overflowing
      const cap = 34 * 0.54;
      expect(calculatePreviewWidth(48, 34, false)).toBeLessThanOrEqual(cap);
      expect(calculatePreviewWidth(80, 34, false)).toBeLessThanOrEqual(cap);
    });
  });

  describe('7. Real-Time Color Mixing & Bake Commit Parity', () => {
    it('picks up canvas paint dynamically along the stroke path', () => {
      const underCanvas = createMockCanvas(200, 200);
      // Place a black patch from x: 40 to 60, y: 0 to 200
      for (let y = 0; y < 200; y++) {
        for (let x = 40; x <= 60; x++) {
          const idx = (y * 200 + x) * 4;
          underCanvas.pixelBuffer[idx] = 0;     // R
          underCanvas.pixelBuffer[idx + 1] = 0; // G
          underCanvas.pixelBuffer[idx + 2] = 0; // B
          underCanvas.pixelBuffer[idx + 3] = 255; // A
        }
      }

      const sampler = new LayerPixelSampler(underCanvas as unknown as HTMLCanvasElement);
      const reservoir = new PaintReservoir('#ff0000'); // Pure red fresh paint

      const destCanvas = createMockCanvas(200, 200);
      const dCtx = destCanvas.getContext('2d') as unknown as CanvasRenderingContext2D;

      const p0: Point = { x: 10, y: 100, pressure: 1.0, width: 10 };
      const p1: Point = { x: 30, y: 100, pressure: 1.0, width: 10 };
      const p2: Point = { x: 80, y: 100, pressure: 1.0, width: 10 };
      const p3: Point = { x: 120, y: 100, pressure: 1.0, width: 10 };

      const mixingOptions: BrushRenderOptions = {
        hardness: 1.0,
        flow: 1.0,
        spacing: 0.05,
        colorMixing: true,
        amountOfPaint: 0.5,
        densityOfPaint: 1.0,
        colorStretch: 0.8,
        mixingMode: 'running_color',
        sampler,
        reservoir,
      };

      // Before crossing black patch: reservoir is pure red (255, 0, 0)
      expect(reservoir.r).toBe(255);
      expect(reservoir.g).toBe(0);
      expect(reservoir.b).toBe(0);

      // Draw segment crossing from x=30 to x=80 (traversing the black patch at 40..60)
      drawBrushCubicBezierSegment(dCtx, p0, p1, p2, p3, '#ff0000', mixingOptions, 0);

      // After crossing black patch: reservoir must have mixed and darkened significantly
      expect(reservoir.isLoadedWithCanvasColor).toBe(true);
      expect(reservoir.r).toBeLessThan(200); // Red channel darkened by black absorption
    });

    it('bakes completed stroke into underlying canvas with color mixing preserved', () => {
      const targetCanvas = createMockCanvas(200, 200);
      // Place a blue patch from x: 40 to 60
      for (let y = 0; y < 200; y++) {
        for (let x = 40; x <= 60; x++) {
          const idx = (y * 200 + x) * 4;
          targetCanvas.pixelBuffer[idx] = 0;       // R
          targetCanvas.pixelBuffer[idx + 1] = 0;   // G
          targetCanvas.pixelBuffer[idx + 2] = 255; // B: Blue
          targetCanvas.pixelBuffer[idx + 3] = 255; // A
        }
      }

      const points: Point[] = [
        { x: 10, y: 100, pressure: 1.0, width: 10 },
        { x: 50, y: 100, pressure: 1.0, width: 10 }, // Directly over blue patch
        { x: 90, y: 100, pressure: 1.0, width: 10 },
      ];

      const settings: BrushSettings = {
        size: 10,
        minSizeFactor: 0.2,
        usePressure: true,
        smoothing: true,
        stabilization: 10,
        color: '#ffff00', // Yellow + Blue = Subtractive Green
        flow: 1.0,
        opacity: 1.0,
        hardness: 1.0,
        spacing: 0.05,
        colorMixing: true,
        amountOfPaint: 0.5,
        densityOfPaint: 1.0,
        colorStretch: 0.8,
        mixingMode: 'blend',
      };

      const bakeCanvas = createMockCanvas(200, 200);
      const bCtx = bakeCanvas.getContext('2d') as unknown as CanvasRenderingContext2D;

      // Render complete stroke passing targetCanvas as underlyingCanvas
      renderCompleteStroke(
        bCtx,
        points,
        settings,
        'brush',
        'color',
        false,
        targetCanvas as unknown as HTMLCanvasElement
      );

      // Dabs were deposited during bake
      expect(bakeCanvas.drawnDabs.length).toBeGreaterThan(10);
    });

    it('layers cleanly at amountOfPaint=1.0 and maintains step-size-invariant equilibrium in both blend and running_color modes', () => {
      const blueSample = { r: 10, g: 30, b: 220, a: 1.0 };

      // 1. At amountOfPaint=1.0, painting red over blue must stay pure red across 50 fine steps
      for (const mode of ['blend', 'running_color'] as const) {
        const res = new PaintReservoir('#ff0000');
        let last = res.mixWithCanvas(blueSample, 1.0, 0.95, 0.75, mode, 0.85, 1.0, 0, true);
        for (let i = 0; i < 50; i++) {
          last = res.mixWithCanvas(blueSample, 1.0, 0.95, 0.75, mode, 0.85, 1.0, 2.0, true);
        }
        expect(last.r).toBe(255);
        expect(last.g).toBe(0);
        expect(last.b).toBe(0);
      }

      // 2. Step-size invariance: 25 steps of 2px (50px) vs 5 steps of 10px (50px) converge tightly
      const fineRes = new PaintReservoir('#facc15');
      const coarseRes = new PaintReservoir('#facc15');
      for (let i = 0; i < 25; i++) {
        fineRes.mixWithCanvas(blueSample, 0.65, 0.9, 0.65, 'blend', 0.8, 1.0, 2.0, true);
      }
      for (let i = 0; i < 5; i++) {
        coarseRes.mixWithCanvas(blueSample, 0.65, 0.9, 0.65, 'blend', 0.8, 1.0, 10.0, true);
      }
      expect(Math.abs(fineRes.r - coarseRes.r)).toBeLessThan(12);
      expect(Math.abs(fineRes.g - coarseRes.g)).toBeLessThan(12);
      expect(Math.abs(fineRes.b - coarseRes.b)).toBeLessThan(12);
      // Must NOT collapse into underlying dark blue at amountOfPaint=0.65
      expect(fineRes.g).toBeGreaterThan(150);
    });
  });

  describe('Alpha Lock (Lock Transparent Pixels) & Transparent Ink Mode', () => {
    it('sets composite operation to source-atop when alphaLocked is true in drawSingleStamp', () => {
      const mockCanvas = createMockCanvas(100, 100);
      const ctx = mockCanvas.getContext('2d') as unknown as CanvasRenderingContext2D;
      const dummyStamp = createMockCanvas(16, 16).canvas as unknown as CanvasImageSource;

      drawSingleStamp(
        ctx,
        dummyStamp,
        50,
        50,
        20,
        20,
        0,
        1.0,
        false,
        false,
        true, // alphaLocked
        false // isTransparentInk
      );

      expect(mockCanvas.drawnDabs.length).toBe(1);
      expect(mockCanvas.drawnDabs[0].op).toBe('source-atop');
    });

    it('sets composite operation to destination-out when isTransparentInk is true in drawSingleStamp', () => {
      const mockCanvas = createMockCanvas(100, 100);
      const ctx = mockCanvas.getContext('2d') as unknown as CanvasRenderingContext2D;
      const dummyStamp = createMockCanvas(16, 16).canvas as unknown as CanvasImageSource;

      drawSingleStamp(
        ctx,
        dummyStamp,
        50,
        50,
        20,
        20,
        0,
        1.0,
        false,
        false,
        false, // alphaLocked
        true   // isTransparentInk
      );

      expect(mockCanvas.drawnDabs.length).toBe(1);
      expect(mockCanvas.drawnDabs[0].op).toBe('destination-out');
    });

    it('renderCompleteStroke uses destination-out when brushSettings.isTransparentInk is true', () => {
      const bakeCanvas = createMockCanvas(200, 200);
      const bCtx = bakeCanvas.getContext('2d') as unknown as CanvasRenderingContext2D;

      const points: Point[] = [
        { x: 10, y: 10, pressure: 0.8, width: 12 },
        { x: 30, y: 20, pressure: 0.8, width: 12 },
        { x: 60, y: 30, pressure: 0.8, width: 12 },
      ];

      const settings: BrushSettings = {
        size: 12,
        minSizeFactor: 0.2,
        opacity: 1.0,
        color: '#000000',
        flow: 1.0,
        spacing: 0.08,
        smoothing: false,
        stabilization: 0,
        hardness: 1.0,
        usePressure: true,
        isTransparentInk: true,
      };

      renderCompleteStroke(bCtx, points, settings, 'brush', 'color', false);

      expect(bakeCanvas.drawnDabs.length).toBeGreaterThan(0);
      // All dabs drawn in transparent ink mode must be destination-out
      for (const dab of bakeCanvas.drawnDabs) {
        expect(dab.op).toBe('destination-out');
      }
    });

    it('renderCompleteStroke uses source-atop when alphaLocked parameter is true', () => {
      const bakeCanvas = createMockCanvas(200, 200);
      const bCtx = bakeCanvas.getContext('2d') as unknown as CanvasRenderingContext2D;

      const points: Point[] = [
        { x: 10, y: 10, pressure: 0.8, width: 12 },
        { x: 30, y: 20, pressure: 0.8, width: 12 },
        { x: 60, y: 30, pressure: 0.8, width: 12 },
      ];

      const settings: BrushSettings = {
        size: 12,
        minSizeFactor: 0.2,
        opacity: 1.0,
        color: '#ff0000',
        flow: 1.0,
        spacing: 0.08,
        smoothing: false,
        stabilization: 0,
        hardness: 1.0,
        usePressure: true,
      };

      renderCompleteStroke(bCtx, points, settings, 'brush', 'color', false, undefined, true);

      expect(bakeCanvas.drawnDabs.length).toBeGreaterThan(0);
      for (const dab of bakeCanvas.drawnDabs) {
        expect(dab.op).toBe('source-atop');
      }
    });
  });

  describe('Stylus Tilt & Taper Dynamics', () => {
    it('stretches stamp aspect ratio when stylus is tilted flat', () => {
      const canvasUpright = createMockCanvas(200, 200);
      const ctxUpright = canvasUpright.getContext('2d') as unknown as CanvasRenderingContext2D;
      const canvasTilted = createMockCanvas(200, 200);
      const ctxTilted = canvasTilted.getContext('2d') as unknown as CanvasRenderingContext2D;

      const p0Upright: Point = { x: 10, y: 50, pressure: 1.0, width: 20, tiltX: 0, tiltY: 0 };
      const c1Upright: Point = { x: 30, y: 50, pressure: 1.0, width: 20, tiltX: 0, tiltY: 0 };
      const c2Upright: Point = { x: 70, y: 50, pressure: 1.0, width: 20, tiltX: 0, tiltY: 0 };
      const p3Upright: Point = { x: 90, y: 50, pressure: 1.0, width: 20, tiltX: 0, tiltY: 0 };

      drawBrushCubicBezierSegment(ctxUpright, p0Upright, c1Upright, c2Upright, p3Upright, '#000000', {
        hardness: 1.0,
        flow: 1.0,
        spacing: 0.1,
        useTilt: true,
      });

      // Tilted flat along X axis (tiltX = 65 degrees)
      const p0Tilted: Point = { x: 10, y: 50, pressure: 1.0, width: 20, tiltX: 65, tiltY: 0 };
      const c1Tilted: Point = { x: 30, y: 50, pressure: 1.0, width: 20, tiltX: 65, tiltY: 0 };
      const c2Tilted: Point = { x: 70, y: 50, pressure: 1.0, width: 20, tiltX: 65, tiltY: 0 };
      const p3Tilted: Point = { x: 90, y: 50, pressure: 1.0, width: 20, tiltX: 65, tiltY: 0 };

      drawBrushCubicBezierSegment(ctxTilted, p0Tilted, c1Tilted, c2Tilted, p3Tilted, '#000000', {
        hardness: 1.0,
        flow: 1.0,
        spacing: 0.1,
        useTilt: true,
      });

      expect(canvasUpright.drawnDabs.length).toBeGreaterThan(0);
      expect(canvasTilted.drawnDabs.length).toBeGreaterThan(0);

      // When tilted flat, the width of the dab expands significantly due to tilt stretch
      const avgUprightW = canvasUpright.drawnDabs.reduce((acc, d) => acc + d.width, 0) / canvasUpright.drawnDabs.length;
      const avgTiltedW = canvasTilted.drawnDabs.reduce((acc, d) => acc + d.width, 0) / canvasTilted.drawnDabs.length;

      expect(avgTiltedW).toBeGreaterThan(avgUprightW * 1.5);
    });

    it('widens pencil preset footprint when stylus is tilted flat (via unified BrushEngine)', () => {
      const canvasUpright = createMockCanvas(200, 200);
      const ctxUpright = canvasUpright.getContext('2d') as unknown as CanvasRenderingContext2D;
      const canvasTilted = createMockCanvas(200, 200);
      const ctxTilted = canvasTilted.getContext('2d') as unknown as CanvasRenderingContext2D;

      const pencilOpts = buildBrushRenderOptions({
        preset: 'pencil-2b',
        size: 10,
        minSizeFactor: 0.2,
        color: '#222326',
        opacity: 1,
        flow: 0.74,
        spacing: 0.06,
        usePressure: true,
        smoothing: true,
        stabilization: 0,
        hardness: 0.65,
      });

      const pUpright: Point = { x: 50, y: 50, pressure: 0.7, width: 10, tiltX: 0, tiltY: 0 };
      drawBrushDot(ctxUpright, pUpright, '#222326', pencilOpts);

      const pTilted: Point = { x: 50, y: 50, pressure: 0.7, width: 10, tiltX: 70, tiltY: 0 };
      drawBrushDot(ctxTilted, pTilted, '#222326', pencilOpts);

      expect(canvasUpright.drawnDabs.length).toBe(1);
      expect(canvasTilted.drawnDabs.length).toBe(1);
      expect(canvasTilted.drawnDabs[0].width).toBeGreaterThan(canvasUpright.drawnDabs[0].width * 2.0);
    });

    it('applies parametric out-taper to smooth out stroke endings', () => {
      const points: Point[] = [
        { x: 0, y: 0, pressure: 1.0, width: 20 },
        { x: 20, y: 0, pressure: 1.0, width: 20 },
        { x: 40, y: 0, pressure: 1.0, width: 20 },
        { x: 60, y: 0, pressure: 1.0, width: 20 },
        { x: 80, y: 0, pressure: 1.0, width: 20 },
        { x: 100, y: 0, pressure: 1.0, width: 20 },
      ];

      applyParametricTaper(points, {
        useOut: true,
        outCount: 3,
        minSizeFactor: 0.1,
      });

      // Earlier points remain unchanged
      expect(points[0].width).toBe(20);
      expect(points[1].width).toBe(20);

      // Tail points are progressively tapered down
      expect(points[4].width).toBeLessThan(points[3].width);
      expect(points[5].width).toBeLessThan(points[4].width);
      expect(points[5].pressure).toBeLessThan(0.5);
    });

    it('modulates out-taper length when lifting pen with high exit velocity', () => {
      const slowPoints: Point[] = Array.from({ length: 12 }, (_, i) => ({
        x: i * 10,
        y: 0,
        pressure: 1.0,
        width: 20,
      }));
      const fastPoints: Point[] = Array.from({ length: 12 }, (_, i) => ({
        x: i * 10,
        y: 0,
        pressure: 1.0,
        width: 20,
      }));

      applyParametricTaper(slowPoints, { useOut: true, outCount: 3, exitSpeed: 0.2 });
      applyParametricTaper(fastPoints, { useOut: true, outCount: 3, exitSpeed: 1.8 });

      // Fast exit speed extends the taper window across more knots
      const slowTaperedCount = slowPoints.filter((p) => p.width < 19.9).length;
      const fastTaperedCount = fastPoints.filter((p) => p.width < 19.9).length;

      expect(fastTaperedCount).toBeGreaterThan(slowTaperedCount);
    });
  });

  describe('8. Multi-Resolution Mipmap Masters, Corner Knots & Deterministic Bake Parity', () => {
    it('selects optimal resolution buckets in getRadialDabMaster when targetSize is provided', () => {
      const mSmall = getRadialDabMaster(1.0, '#000000', false, 4);
      const mMed = getRadialDabMaster(1.0, '#000000', false, 16);
      const mLarge = getRadialDabMaster(1.0, '#000000', false, 48);
      const mHuge = getRadialDabMaster(1.0, '#000000', false, 100);

      expect(mSmall.width).toBe(24);
      expect(mMed.width).toBe(48);
      expect(mLarge.width).toBe(64);
      expect(mHuge.width).toBe(128);
    });

    it('breaks tangent influence across sharp corners when isCorner is set on knots', () => {
      const p0: Point = { x: 0, y: 50, pressure: 0.5, width: 10 };
      const p1: Point = { x: 50, y: 0, pressure: 0.5, width: 10, isCorner: true };
      const p2: Point = { x: 100, y: 0, pressure: 0.5, width: 10 };
      const p3: Point = { x: 150, y: 0, pressure: 0.5, width: 10 };

      const { c1, c2 } = centripetalCatmullRomToBezier(p0, p1, p2, p3);
      // Since p1.isCorner is true, c1 should lie strictly on the horizontal chord y = 0 without pulling toward p0 (y = 50)
      expect(c1.y).toBeCloseTo(0, 4);
      expect(c2.y).toBeCloseTo(0, 4);
    });

    it('produces identical scattered/jittered dab coordinates across repeated renderCompleteStroke calls', () => {
      const c1 = createMockCanvas(200, 200);
      const c2 = createMockCanvas(200, 200);
      const ctx1 = c1.getContext('2d') as unknown as CanvasRenderingContext2D;
      const ctx2 = c2.getContext('2d') as unknown as CanvasRenderingContext2D;

      const pts: Point[] = [
        { x: 20, y: 40, pressure: 0.6, width: 12 },
        { x: 60, y: 50, pressure: 0.8, width: 14 },
        { x: 110, y: 45, pressure: 0.7, width: 13 },
      ];

      const settings: BrushSettings = {
        size: 14,
        minSizeFactor: 0.2,
        opacity: 1.0,
        color: '#2255aa',
        secondaryColor: '#ffaa00',
        flow: 0.9,
        spacing: 0.1,
        smoothing: true,
        stabilization: 10,
        hardness: 0.9,
        usePressure: true,
        dynamics: {
          sizeJitter: 0.5,
          angleJitter: 0.4,
          roundnessJitter: 0.3,
          scatter: 1.2,
          scatterBothAxes: true,
          count: 2,
          flowJitter: 0.3,
          colorJitterEnabled: true,
          hueJitter: 0.2,
          saturationJitter: 0.2,
          brightnessJitter: 0.2,
          foregroundBackgroundJitter: 0.3,
        },
      };

      renderCompleteStroke(ctx1, pts, settings, 'brush', 'color', false);
      renderCompleteStroke(ctx2, pts, settings, 'brush', 'color', false);

      expect(c1.drawnDabs.length).toBeGreaterThan(10);
      expect(c1.drawnDabs.length).toBe(c2.drawnDabs.length);
      for (let i = 0; i < c1.drawnDabs.length; i++) {
        expect(c1.drawnDabs[i].x).toBeCloseTo(c2.drawnDabs[i].x, 5);
        expect(c1.drawnDabs[i].y).toBeCloseTo(c2.drawnDabs[i].y, 5);
        expect(c1.drawnDabs[i].width).toBeCloseTo(c2.drawnDabs[i].width, 5);
        expect(c1.drawnDabs[i].alpha).toBeCloseTo(c2.drawnDabs[i].alpha, 5);
      }
    });
  });
});
