import { describe, it, expect, beforeEach } from 'vitest';
import { InputStabilizer } from '../../engine/InputStabilizer';
import { TaperEngine } from '../../engine/TaperEngine';
import { SplineGenerator, SplinePoint } from '../../engine/SplineGenerator';
import { WebGlBrushEngine } from '../../engine/WebGlBrushEngine';

describe('Clip Studio Paint Drawing Engine Refactor Tests', () => {
  describe('Phase 3: Adaptive Corner-Snapping Stabilizer (InputStabilizer)', () => {
    let stabilizer: InputStabilizer;

    beforeEach(() => {
      stabilizer = new InputStabilizer();
      stabilizer.setStabilizerLevel(15);
    });

    it('detects critical angle deflection (> 45 deg) and commits sharp corner vertex', () => {
      let t = 1000;
      // Stroke moving along positive X axis: (0,0) -> (10,0) -> (20,0) -> (30,0)
      stabilizer.process(0, 0, 0.5, t);
      t += 16;
      stabilizer.process(10, 0, 0.5, t);
      t += 16;
      stabilizer.process(20, 0, 0.5, t);
      t += 16;
      stabilizer.process(30, 0, 0.5, t);

      // Sudden 90 degree turn upward to positive Y: (30, 20)
      t += 16;
      const cornerSample = stabilizer.process(30, 20, 0.5, t);

      expect(cornerSample.isCorner).toBe(true);
      // Coordinates should snap sharply to raw corner coordinate rather than lagging behind
      expect(cornerSample.x).toBeCloseTo(30, 0);
      expect(cornerSample.y).toBeCloseTo(20, 0);
    });

    it('maintains continuous smoothing for gentle curves (< 45 deg deflection)', () => {
      let t = 1000;
      stabilizer.process(0, 0, 0.5, t);
      t += 16;
      stabilizer.process(10, 0, 0.5, t);
      t += 16;
      stabilizer.process(20, 1, 0.5, t);
      t += 16;
      // Shallow curve turn
      const smoothSample = stabilizer.process(30, 3, 0.5, t);

      expect(smoothSample.isCorner).toBe(false);
    });

    it('adapts damping based on stroke velocity (high damping on slow strokes, low on fast)', () => {
      const slowStab = new InputStabilizer();
      slowStab.setStabilizerLevel(10);
      const fastStab = new InputStabilizer();
      fastStab.setStabilizerLevel(10);

      // Slow stroke: small movement (5px) over large dt (50ms) -> 0.1 px/ms
      slowStab.process(0, 0, 0.5, 0);
      const slowSample = slowStab.process(5, 0, 0.5, 50);

      // Fast stroke: large movement (50px) over small dt (10ms) -> 5 px/ms
      fastStab.process(0, 0, 0.5, 0);
      const fastSample = fastStab.process(50, 0, 0.5, 10);

      // Fast stroke should track with lower relative lag due to velocity boost on cutoff
      const slowLagRatio = Math.abs(5 - slowSample.x) / 5;
      const fastLagRatio = Math.abs(50 - fastSample.x) / 50;
      expect(fastLagRatio).toBeLessThan(slowLagRatio);
    });

    it('implements asymmetric pressure filtering (fast pen-down attack, critically damped decay)', () => {
      const pStab = new InputStabilizer();
      pStab.setStabilizerLevel(15);

      // Pen down attack: jump from 0.0 to 1.0 pressure in 16ms
      pStab.process(0, 0, 0.0, 0);
      const attackSample = pStab.process(1, 0, 1.0, 16);

      // Pressure attack should respond aggressively (>= 80% on first 16ms tick)
      expect(attackSample.pressure).toBeGreaterThanOrEqual(0.8);

      // Steady state
      pStab.process(2, 0, 1.0, 32);

      // Pen release decay: drop from 1.0 to 0.1 pressure
      const decaySample = pStab.process(3, 0, 0.1, 48);
      // Decay should be smooth and damped (not jumping immediately to 0.1)
      expect(decaySample.pressure).toBeGreaterThan(0.2);
    });

    it('remains stable when coalesced events share identical timestamps', () => {
      const stab = new InputStabilizer();
      stab.setStabilizerLevel(20);

      stab.process(0, 0, 0.5, 100);
      const s1X = stab.process(4, 0, 0.5, 116).x;
      // Coalesced event with identical timestamp (116ms)
      const s2X = stab.process(8, 0, 0.5, 116).x;

      expect(Number.isFinite(s2X)).toBe(true);
      expect(s2X).toBeGreaterThan(s1X);
      // Should still be smoothed rather than snapping raw due to derivative explosion
      expect(s2X).toBeLessThan(8);
    });
  });

  describe('Phase 4: Japanese Inking Dynamics (TaperEngine)', () => {
    let taperEngine: TaperEngine;

    beforeEach(() => {
      taperEngine = new TaperEngine();
    });

    it('maps pressure through 3-stage cubic S-curve (G-Pen response)', () => {
      // Stage 1: Delicate hairline zone (0 - 15%)
      const pLow = taperEngine.mapPressure(0.10);
      expect(pLow).toBeLessThan(0.10); // Ease-in hairline compression

      // Stage 2: Stable controllable line weight (15% - 70%)
      const pMid = taperEngine.mapPressure(0.40);
      expect(pMid).toBeGreaterThan(0.15);
      expect(pMid).toBeLessThan(0.70);

      // Stage 3: Saturated expansion (70% - 100%)
      const pHigh = taperEngine.mapPressure(0.85);
      expect(pHigh).toBeGreaterThan(0.80);

      // Monotonicity check across full range
      let prev = -1;
      for (let p = 0; p <= 1.0; p += 0.05) {
        const mapped = taperEngine.mapPressure(p);
        expect(mapped).toBeGreaterThanOrEqual(prev);
        prev = mapped;
      }
      expect(taperEngine.mapPressure(0)).toBe(0);
      expect(taperEngine.mapPressure(1)).toBe(1);
    });

    it('computes exponential ballistic flick taper on high-velocity pen lift', () => {
      const startX = 100;
      const startY = 100;
      const startWidth = 10;
      const startPressure = 0.8;
      const exitVx = 2.5; // Fast flick in X
      const exitVy = 0.5;
      const timestamp = 5000;

      const flick = taperEngine.computeFlickTaper(
        startX,
        startY,
        startWidth,
        startPressure,
        exitVx,
        exitVy,
        timestamp
      );

      expect(flick.count).toBe(8);

      // Verify exponential width and pressure decay across active points
      let prevWidth = startWidth;
      let prevPressure = startPressure;
      for (let i = 0; i < flick.count; i++) {
        const pt = flick.points[i];
        expect(pt.width).toBeLessThan(prevWidth);
        expect(pt.pressure).toBeLessThanOrEqual(prevPressure);
        prevWidth = pt.width;
        prevPressure = pt.pressure;
      }

      // Final point should taper down toward hairlines
      const lastPoint = flick.points[flick.count - 1];
      expect(lastPoint.width).toBeLessThan(startWidth * 0.4);
      expect(lastPoint.pressure).toBeLessThan(0.1);
      expect(lastPoint.alpha).toBeLessThan(0.2);
    });
  });

  describe('Phase 2 & 3: Spline Generation with Corner Commits (SplineGenerator)', () => {
    it('generates sharp linear corner segments to apex coordinates', () => {
      const spline = new SplineGenerator();
      const pPrev: SplinePoint = { x: 10, y: 0, width: 4, pressure: 0.5 };
      const pCorner: SplinePoint = { x: 20, y: 0, width: 4, pressure: 0.5 };

      spline.commitCornerKnot(pCorner);
      const segment = spline.generateCornerSegment(pPrev, pCorner);

      expect(segment.p0.x).toBe(pPrev.x);
      expect(segment.p0.y).toBe(pPrev.y);
      expect(segment.p3.x).toBe(pCorner.x);
      expect(segment.p3.y).toBe(pCorner.y);

      // Control points should align along straight chord to apex
      expect(segment.c1.x).toBeCloseTo(pPrev.x + (pCorner.x - pPrev.x) * 0.333, 1);
      expect(segment.c2.x).toBeCloseTo(pPrev.x + (pCorner.x - pPrev.x) * 0.667, 1);
    });
  });

  describe('Phase 5: WebGlBrushEngine Track A Ribbon Inking and Track B Instanced Stamps', () => {
    it('initializes WebGlBrushEngine singleton without throwing', () => {
      const gpu = WebGlBrushEngine.getInstance();
      expect(gpu).toBeDefined();
    });

    it('falls back gracefully to Canvas 2D when WebGL context is unavailable', () => {
      const gpu = WebGlBrushEngine.getInstance();
      const mockCanvas: any = {
        width: 400,
        height: 400,
      };
      const mockCtx: any = {
        canvas: mockCanvas,
        save: () => {},
        restore: () => {},
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        stroke: () => {},
        fill: () => {},
        drawImage: () => {},
        globalAlpha: 1.0,
        globalCompositeOperation: 'source-over',
      };

      const p0 = { x: 10, y: 10, width: 5, pressure: 0.5 };
      const c1 = { x: 20, y: 15, width: 5, pressure: 0.5 };
      const c2 = { x: 30, y: 25, width: 5, pressure: 0.5 };
      const p3 = { x: 40, y: 40, width: 5, pressure: 0.5 };

      // Should return false or safely handle ribbon segment without crashing
      const rendered = gpu.renderRibbonSegment(mockCtx, p0, c1, c2, p3, '#000000', 1.0, 400, 400);
      expect(typeof rendered).toBe('boolean');
    });
  });
});
