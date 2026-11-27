import { describe, it, expect, vi } from 'vitest';
import { InputStabilizer } from '../../engine/InputStabilizer';
import { StrokePipeline, POINTER_TYPE_PEN } from '../../engine/StrokePipeline';
import { TaperEngine } from '../../engine/TaperEngine';
import { calculateStrokeWidth } from '../canvasUtils';
import {
  NativeTabletBridgeState,
  processNativeTabletBatch,
} from '../../hooks/drawing/brushStrokeSession/nativeTabletBridge';
import {
  NativeTabletSample,
  recordNativeTabletBatchForSuppression,
  resetNativeTabletSuppressionState,
  shouldSuppressDomPointerEvent,
} from '../nativeTabletInput';

describe('InputStabilizer CSP-Calibrated Lag Bounds & Smooth Sine Wave Tracking', () => {
  it('bypasses completely at level 0 and scales lag cleanly from level 1 (~3px) to level 50 (<=48px)', () => {
    const stab0 = new InputStabilizer();
    stab0.setStabilizerLevel(0);
    stab0.setZoomScale(1.0);
    for (let i = 0; i <= 30; i++) {
      const s = stab0.process(i * 6, i * 3, 0.6, 1000 + i * 4);
      expect(s.x).toBe(i * 6);
      expect(s.y).toBe(i * 3);
    }

    const measureSteadyLag = (level: number, stepPx: number, dtMs: number) => {
      const stab = new InputStabilizer();
      stab.setStabilizerLevel(level);
      stab.setZoomScale(1.0);
      let maxLag = 0;
      let lastLag = 0;
      for (let i = 0; i <= 80; i++) {
        const rx = i * stepPx;
        const ry = 0;
        const s = stab.process(rx, ry, 0.7, 1000 + i * dtMs);
        lastLag = Math.hypot(rx - s.x, ry - s.y);
        if (i >= 20 && lastLag > maxLag) maxLag = lastLag;
      }
      return { maxLag, lastLag };
    };

    const lag1 = measureSteadyLag(1, 2, 8);
    expect(lag1.lastLag).toBeGreaterThan(1.5);
    expect(lag1.lastLag).toBeLessThan(5.0);

    // G-Pen default (level 20): strictly <= 18 screen px across slow, medium, and fast speeds
    const lag20Slow = measureSteadyLag(20, 2.5, 8); // 0.31 px/ms
    const lag20Med = measureSteadyLag(20, 5.0, 4);  // 1.25 px/ms
    const lag20Fast = measureSteadyLag(20, 10.0, 4); // 2.50 px/ms

    expect(lag20Slow.maxLag).toBeLessThanOrEqual(18.0);
    expect(lag20Slow.lastLag).toBeGreaterThanOrEqual(6.0);
    expect(lag20Med.maxLag).toBeLessThanOrEqual(18.0);
    expect(lag20Fast.maxLag).toBeLessThanOrEqual(18.0);
    // Velocity-adaptive tightening: faster strokes tighten lag compared to slow strokes
    expect(lag20Fast.lastLag).toBeLessThan(lag20Slow.lastLag);

    // Real G-Pen default (level 18): strictly <= 16 screen px
    const lag18 = measureSteadyLag(18, 4.0, 4);
    expect(lag18.maxLag).toBeLessThanOrEqual(16.5);

    // Max stabilization (level 50): bounded <= 48 screen px
    const lag50Slow = measureSteadyLag(50, 3.0, 8);
    expect(lag50Slow.maxLag).toBeLessThanOrEqual(48.5);
    expect(lag50Slow.lastLag).toBeGreaterThan(30.0);
  });

  it('tracks slow and fast sine waves at level 20 with <= 18px lag and ZERO >15px single-step corner teleports', () => {
    const testWave = (level: number, stepX: number, dtMs: number, amp: number, wavelength: number) => {
      const stab = new InputStabilizer();
      stab.setStabilizerLevel(level);
      stab.setZoomScale(1.0);
      stab.setSharpCorners(true);

      let prevX = 0;
      let prevY = 0;
      let maxLag = 0;
      let maxStepJump = 0;
      let cornerCount = 0;
      let droppedBacktrackSteps = 0;

      const totalSteps = 200;
      for (let i = 0; i <= totalSteps; i++) {
        const rx = i * stepX;
        const ry = amp * Math.sin((rx / wavelength) * Math.PI * 2);
        const s = stab.process(rx, ry, 0.65, 1000 + i * dtMs);
        const lag = Math.hypot(rx - s.x, ry - s.y);
        if (lag > maxLag) maxLag = lag;
        if (s.isCorner) cornerCount++;
        if (i > 0) {
          const jump = Math.hypot(s.x - prevX, s.y - prevY);
          if (jump > maxStepJump) maxStepJump = jump;
          if (jump < 1e-4) droppedBacktrackSteps++;
        }
        prevX = s.x;
        prevY = s.y;
      }

      return { maxLag, maxStepJump, cornerCount, droppedBacktrackSteps };
    };

    // Slow smooth sine wave (G-Pen level 20)
    const slowWave = testWave(20, 2.0, 8, 45, 140);
    expect(slowWave.cornerCount).toBe(0);
    expect(slowWave.maxLag).toBeLessThanOrEqual(18.0);
    expect(slowWave.maxStepJump).toBeLessThanOrEqual(15.0);
    expect(slowWave.droppedBacktrackSteps).toBe(0);

    // Fast smooth sine wave (G-Pen level 20)
    const fastWave = testWave(20, 4.5, 4, 55, 160);
    expect(fastWave.cornerCount).toBe(0);
    expect(fastWave.maxLag).toBeLessThanOrEqual(18.0);
    expect(fastWave.maxStepJump).toBeLessThanOrEqual(15.0);
    expect(fastWave.droppedBacktrackSteps).toBe(0);

    // Tight high-curvature wave (Real G-Pen level 18)
    const tightWave = testWave(18, 2.5, 4, 40, 90);
    expect(tightWave.cornerCount).toBe(0);
    expect(tightWave.maxLag).toBeLessThanOrEqual(18.0);
    expect(tightWave.maxStepJump).toBeLessThanOrEqual(15.0);
    expect(tightWave.droppedBacktrackSteps).toBe(0);
  });

  it('closes stroke tails cleanly all the way to the true pen-lift coordinate on finalizeStroke', () => {
    const pipeline = new StrokePipeline();
    pipeline.beginStroke({ stabilizerLevel: 20, zoom: 1.0, sharpCorners: true, brushSize: 8 });

    const endX = 320;
    const endY = 85;
    for (let i = 0; i <= 40; i++) {
      const frac = i / 40;
      const x = frac * endX;
      const y = frac * endY + Math.sin(frac * Math.PI) * 30;
      pipeline.enqueueSample(x, y, 0.65, 0, 0, 0, 1000 + i * 4, POINTER_TYPE_PEN);
    }
    pipeline.drain();

    const catchUp = pipeline.getStabilizer().getCatchUpTarget();
    expect(catchUp.x).toBeCloseTo(endX, 4);
    expect(catchUp.y).toBeCloseTo(endY, 4);

    const tailPts: Array<{ x: number; y: number }> = [];
    pipeline.finalizeStroke(1200, {
      enableFlickTaper: false,
      onPoint: (pt) => tailPts.push({ x: pt.x, y: pt.y }),
    });

    expect(tailPts.length).toBeGreaterThanOrEqual(2);
    const finalPt = tailPts[tailPts.length - 1];
    expect(Math.hypot(finalPt.x - endX, finalPt.y - endY)).toBeLessThan(0.05);
  });

  it('bridges predicted segments toward live raw stylus coordinate when stabilized without mutating dirtyRect', () => {
    const pipeline = new StrokePipeline();
    pipeline.beginStroke({ stabilizerLevel: 20, zoom: 1.0, sharpCorners: true, brushSize: 8 });
    for (let i = 0; i <= 15; i++) {
      pipeline.enqueueSample(i * 6, 100, 0.7, 0, 0, 0, 1000 + i * 4, POINTER_TYPE_PEN);
    }
    pipeline.drain();

    const dirtyBefore = { ...pipeline.dirtyRect };
    const knotsBefore = pipeline.getKnotCount();
    const segEnds: Array<{ x: number; y: number }> = [];
    const drew = pipeline.buildPredictedSegments(
      [{ x: 96, y: 100, pressure: 0.7 }],
      20,
      (seg) => segEnds.push({ x: seg.p3.x, y: seg.p3.y })
    );

    expect(drew).toBe(true);
    // Includes bridge + stabilizer-to-raw catch-up + hardware predicted event
    expect(segEnds.length).toBeGreaterThanOrEqual(3);
    expect(segEnds[segEnds.length - 1].x).toBeCloseTo(96, 1);
    expect(pipeline.dirtyRect).toEqual(dirtyBefore);
    expect(pipeline.getKnotCount()).toBe(knotsBefore);
  });
});

describe('Native Tablet Bridge Resilience & Light-Pressure Anti-Collapse', () => {
  const makeSample = (overrides: Partial<NativeTabletSample>): NativeTabletSample => ({
    clientX: 200,
    clientY: 200,
    pressure: 0.5,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    timestamp: 1000,
    buttons: 1,
    phase: 2,
    backend: 2,
    ...overrides,
  });

  it('ignores spurious child-HWND phase=4 (leave) while in-contact and recovers if phase=1 was missed', () => {
    const bridge: NativeTabletBridgeState = {
      nativeStrokeActive: false,
      prevToolBeforeEraserFlip: null,
    };
    const modKeys = { shift: false, alt: false };
    const onPointerDown = vi.fn();
    const onPointerMove = vi.fn();
    const onPointerUp = vi.fn();
    const onHover = vi.fn();

    const cb = {
      getTool: () => 'brush' as const,
      selectTool: vi.fn(),
      isDisabled: () => false,
      isPointOverCanvasViewport: () => true,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onHover,
    };

    // 1. Start stroke (phase 1) -> drag (phase 2) -> spurious phase 4 while buttons & 1 is set -> more drag
    processNativeTabletBatch(
      [
        makeSample({ phase: 1, clientX: 100, clientY: 100, pressure: 0.4, buttons: 1, timestamp: 100 }),
        makeSample({ phase: 2, clientX: 110, clientY: 100, pressure: 0.4, buttons: 1, timestamp: 104 }),
        // Spurious child-HWND WM_POINTERLEAVE with tip still contacting
        makeSample({ phase: 4, clientX: 112, clientY: 100, pressure: 0.35, buttons: 1, timestamp: 106 }),
        makeSample({ phase: 2, clientX: 120, clientY: 100, pressure: 0.45, buttons: 1, timestamp: 108 }),
      ],
      bridge,
      modKeys,
      cb
    );

    expect(bridge.nativeStrokeActive).toBe(true);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onPointerUp).not.toHaveBeenCalled();
    expect(onPointerMove).toHaveBeenCalledTimes(2);

    // 2. Genuine pen up (phase 3) ends stroke cleanly
    processNativeTabletBatch(
      [makeSample({ phase: 3, clientX: 125, clientY: 100, pressure: 0, buttons: 0, timestamp: 112 })],
      bridge,
      modKeys,
      cb
    );
    expect(bridge.nativeStrokeActive).toBe(false);
    expect(onPointerUp).toHaveBeenCalledTimes(1);

    // 3. Recovery when phase=1 was missed and phase=2 arrives in-contact over canvas viewport
    processNativeTabletBatch(
      [
        makeSample({ phase: 2, clientX: 200, clientY: 200, pressure: 0.3, buttons: 1, timestamp: 200 }),
        makeSample({ phase: 2, clientX: 210, clientY: 205, pressure: 0.35, buttons: 1, timestamp: 204 }),
        makeSample({ phase: 2, clientX: 220, clientY: 210, pressure: 0.4, buttons: 1, timestamp: 208 }),
      ],
      bridge,
      modKeys,
      cb
    );

    expect(bridge.nativeStrokeActive).toBe(true);
    expect(onPointerDown).toHaveBeenCalledTimes(2);
    expect(onPointerMove).toHaveBeenCalledTimes(3);

    // 4. True out-of-proximity phase=4 (buttons=0, pressure=0) ends stroke cleanly
    processNativeTabletBatch(
      [makeSample({ phase: 4, clientX: 220, clientY: 210, pressure: 0, buttons: 0, timestamp: 212 })],
      bridge,
      modKeys,
      cb
    );
    expect(bridge.nativeStrokeActive).toBe(false);
    expect(onPointerUp).toHaveBeenCalledTimes(2);
  });

  it('prevents light continuous pen contact (> 0.005) from collapsing to zero pressure or invisible 0.1px width', () => {
    const taper = new TaperEngine();

    // True zero remains zero
    expect(taper.mapPressure(0)).toBe(0);
    // Light continuous pen contact (> 0.005) produces positive pressure instead of 0
    const pLight = taper.mapPressure(0.01);
    expect(pLight).toBeGreaterThan(0.01);

    // G-Pen (size 8, minSizeFactor 0.04) at light continuous contact never collapses to width=0.1
    const wLight = calculateStrokeWidth(8, pLight, 0.04, true, 'pen');
    expect(wLight).toBeGreaterThanOrEqual(0.35);

    // Flick taper / zero pressure still tapers down to 0.1px
    const wZero = calculateStrokeWidth(8, 0.0, 0.0, true, 'pen');
    expect(wZero).toBeCloseTo(0.1, 4);
  });

  it('suppresses WinTab CXO_SYSTEM synthetic mouse events during native pen strokes while preserving real mouse after pen leaves', () => {
    resetNativeTabletSuppressionState(true);

    // 1. Stylus hovering in proximity (phase=0) via WinTab -> suppress both DOM pen & synthetic mouse
    recordNativeTabletBatchForSuppression(
      [makeSample({ phase: 0, clientX: 300, clientY: 220, pressure: 0, buttons: 0, backend: 1 })],
      1000
    );
    expect(shouldSuppressDomPointerEvent('pen', 300, 220, 1005)).toBe(true);
    expect(shouldSuppressDomPointerEvent('mouse', 300, 220, 1005)).toBe(true);

    // 2. Stylus touches down (phase=1) with heavy pressure -> WinTab CXO_SYSTEM fires DOM mouse pointerdown (pressure=0.5)
    // Must be suppressed so it NEVER aborts/hijacks the active native pen stroke!
    recordNativeTabletBatchForSuppression(
      [makeSample({ phase: 1, clientX: 302, clientY: 225, pressure: 0.92, buttons: 1, backend: 1 })],
      1010
    );
    expect(shouldSuppressDomPointerEvent('mouse', 302, 225, 1012)).toBe(true);
    expect(shouldSuppressDomPointerEvent('mouse', 310, 240, 1100)).toBe(true);

    // 3. Stylus lifts (phase=3) and leaves proximity (phase=4)
    recordNativeTabletBatchForSuppression(
      [
        makeSample({ phase: 3, clientX: 305, clientY: 320, pressure: 0, buttons: 0, backend: 1 }),
        makeSample({ phase: 4, clientX: 305, clientY: 320, pressure: 0, buttons: 0, backend: 1 }),
      ],
      1120
    );
    // Immediate stray mouse up at the exact lift position within 250ms is still suppressed
    expect(shouldSuppressDomPointerEvent('mouse', 306, 321, 1130)).toBe(true);
    // Physical mouse used elsewhere (>24px away) or after 250ms works immediately
    expect(shouldSuppressDomPointerEvent('mouse', 600, 400, 1135)).toBe(false);
    expect(shouldSuppressDomPointerEvent('mouse', 306, 321, 1400)).toBe(false);

    resetNativeTabletSuppressionState(false);
  });
});
