import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  StrokePipeline,
  computeClampedBakeDirtyRect,
  encodePointerType,
  POINTER_TYPE_MOUSE,
  POINTER_TYPE_PEN,
  POINTER_TYPE_TOUCH,
  ViewportTransform,
} from '../../engine/StrokePipeline';
import { CubicBezierSegment } from '../../engine/SplineGenerator';
import {
  canUseWebGlForBrush,
  renderCompleteStroke,
  BrushRenderOptions,
} from '../../engine/BrushEngine';
import { WebGlBrushEngine, GpuDab } from '../../engine/WebGlBrushEngine';
import { BrushSettings, Point } from '../../types/editor';

function makeMock2DCtx(w = 1000, h = 1000) {
  const ops: string[] = [];
  const ctx = {
    canvas: { width: w, height: h },
    strokeStyle: '#000000',
    fillStyle: '#000000',
    lineCap: 'round',
    lineJoin: 'round',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    save: vi.fn(),
    restore: vi.fn(),
    resetTransform: vi.fn(),
    clearRect: vi.fn(() => ops.push('clearRect')),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    bezierCurveTo: vi.fn(() => ops.push('bezier')),
    stroke: vi.fn(() => ops.push('stroke')),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(() => ops.push('drawImage')),
    fillRect: vi.fn(),
    createImageData: (cw: number, ch: number) => ({ width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) }),
    getImageData: vi.fn((_x: number, _y: number, cw: number, ch: number) => ({
      width: cw,
      height: ch,
      data: new Uint8ClampedArray(cw * ch * 4),
    })),
    putImageData: vi.fn(),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, raw: ctx, ops };
}

if (typeof (globalThis as any).document === 'undefined') {
  (globalThis as any).document = {
    createElement: () => {
      const m = makeMock2DCtx(128, 128);
      return { width: 128, height: 128, getContext: () => m.ctx };
    },
  };
}

describe('StrokePipeline: Ring Buffer, Stabilization, Taper, Prediction & Bake DirtyRect', () => {
  let pipeline: StrokePipeline;

  beforeEach(() => {
    pipeline = new StrokePipeline();
  });

  it('ingests and drains samples via Float64Array ring buffer preserving tilt, twist, pressure and pointerType', () => {
    pipeline.beginStroke({ stabilizerLevel: 0, brushSize: 12, color: '#000000' });
    pipeline.enqueueSample(10, 20, 0.4, 15, -10, 45, 100, encodePointerType('pen'));
    pipeline.enqueueSample(30, 40, 0.8, 25, -5, 90, 116, encodePointerType('touch'));
    pipeline.enqueueSample(50, 60, 0.5, 0, 0, 0, 132, encodePointerType('mouse'));

    expect(pipeline.getPendingCount()).toBe(3);

    const drainedPts: Array<{ x: number; y: number; tiltX: number; tiltY: number; twist: number; pointerType: string }> = [];
    const segments: number[] = [];

    const count = pipeline.drain({
      onPoint: (pt) => {
        drainedPts.push({
          x: pt.x,
          y: pt.y,
          tiltX: pt.tiltX,
          tiltY: pt.tiltY,
          twist: pt.twist,
          pointerType: pt.pointerType,
        });
      },
      onSegment: () => {
        segments.push(1);
      },
    });

    expect(count).toBe(3);
    expect(pipeline.getPendingCount()).toBe(0);
    expect(drainedPts).toHaveLength(3);
    expect(drainedPts[0]).toMatchObject({ x: 10, y: 20, tiltX: 15, tiltY: -10, twist: 45, pointerType: 'pen' });
    expect(drainedPts[1]).toMatchObject({ x: 30, y: 40, tiltX: 25, tiltY: -5, twist: 90, pointerType: 'touch' });
    expect(drainedPts[2]).toMatchObject({ x: 50, y: 60, tiltX: 0, tiltY: 0, twist: 0, pointerType: 'mouse' });
    // Third knot seals P1 -> P2 segment
    expect(segments.length).toBe(1);
  });

  it('handles ring buffer wraparound safely when exceeding BUFFER_CAPACITY (2048) without draining', () => {
    pipeline.beginStroke({ stabilizerLevel: 0, brushSize: 10 });
    const total = StrokePipeline.BUFFER_CAPACITY + 120;
    for (let i = 0; i < total; i++) {
      pipeline.enqueueSample(i, i * 0.5, 0.6, 0, 0, 0, i * 4, POINTER_TYPE_PEN);
    }

    // Ring buffer caps unread samples at exact BUFFER_CAPACITY (2048) without overwriting unread tail
    expect(pipeline.getPendingCount()).toBe(StrokePipeline.BUFFER_CAPACITY);

    const xs: number[] = [];
    pipeline.drain({
      onPoint: (pt) => xs.push(pt.x),
    });

    expect(pipeline.getPendingCount()).toBe(0);
    // Latest sample MUST be the final enqueued coordinate, and oldest retained is exact wraparound boundary
    expect(xs[xs.length - 1]).toBe(total - 1);
    expect(xs[0]).toBe(total - StrokePipeline.BUFFER_CAPACITY);
  });

  it('applies 1-Euro stabilization and sharp corner snapping when stabilizerLevel > 0', () => {
    pipeline.beginStroke({ stabilizerLevel: 20, zoom: 1.0, sharpCorners: true, brushSize: 10 });

    let t = 1000;
    for (let i = 0; i <= 5; i++) {
      pipeline.enqueueSample(i * 10, 0, 0.7, 0, 0, 0, t, POINTER_TYPE_PEN);
      t += 16;
    }
    // Sharp 90-degree turn upward
    pipeline.enqueueSample(50, 25, 0.7, 0, 0, 0, t, POINTER_TYPE_PEN);

    const corners: boolean[] = [];
    const cornerSegs: boolean[] = [];
    const emittedSegs: Array<{ p0x: number; p0y: number; p3x: number; p3y: number }> = [];
    const points: Array<{ x: number; y: number }> = [];

    pipeline.drain({
      onPoint: (pt) => {
        points.push({ x: pt.x, y: pt.y });
        corners.push(pt.isCorner);
      },
      onSegment: (seg, isCorner) => {
        cornerSegs.push(isCorner);
        emittedSegs.push({ p0x: seg.p0.x, p0y: seg.p0.y, p3x: seg.p3.x, p3y: seg.p3.y });
      },
    });

    // Intermediate straight points are smoothed (lag slightly behind raw x)
    expect(points[3].x).toBeLessThan(30);
    // Sharp 90-degree corner triggers corner snap & sharp corner segment
    expect(corners[corners.length - 1]).toBe(true);
    expect(points[points.length - 1].x).toBeCloseTo(50, 0);
    expect(points[points.length - 1].y).toBeCloseTo(25, 0);
    expect(cornerSegs).toContain(true);
    // Zero gaps across every sealed segment leading into the corner apex (C0 continuous!)
    expect(emittedSegs.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < emittedSegs.length; i++) {
      expect(emittedSegs[i].p0x).toBeCloseTo(emittedSegs[i - 1].p3x, 4);
      expect(emittedSegs[i].p0y).toBeCloseTo(emittedSegs[i - 1].p3y, 4);
    }
    expect(emittedSegs[emittedSegs.length - 1].p3x).toBeCloseTo(50, 0);
    expect(emittedSegs[emittedSegs.length - 1].p3y).toBeCloseTo(25, 0);
  });

  it('emits ballistic flick taper points on fast pointerup finalizeStroke and none on slow release', () => {
    // 1. Fast flick release
    pipeline.beginStroke({ stabilizerLevel: 0, brushSize: 20 });
    pipeline.enqueueSample(0, 100, 0.8, 0, 0, 0, 1000, POINTER_TYPE_PEN);
    pipeline.enqueueSample(30, 100, 0.8, 0, 0, 0, 1010, POINTER_TYPE_PEN);
    pipeline.enqueueSample(65, 100, 0.8, 0, 0, 0, 1020, POINTER_TYPE_PEN);
    pipeline.drain();

    const flickWidths: number[] = [];
    pipeline.finalizeStroke(1028, {
      enableFlickTaper: true,
      onPoint: (pt) => flickWidths.push(pt.width),
    });

    expect(flickWidths.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < flickWidths.length; i++) {
      expect(flickWidths[i]).toBeLessThan(flickWidths[i - 1]);
    }

    // 2. Slow exit release (below minFlickSpeed)
    pipeline.beginStroke({ stabilizerLevel: 0, brushSize: 20 });
    pipeline.enqueueSample(0, 100, 0.8, 0, 0, 0, 2000, POINTER_TYPE_PEN);
    pipeline.enqueueSample(1, 100, 0.8, 0, 0, 0, 2100, POINTER_TYPE_PEN);
    pipeline.enqueueSample(2, 100, 0.8, 0, 0, 0, 2200, POINTER_TYPE_PEN);
    pipeline.drain();

    const slowFlickWidths: number[] = [];
    const sealedTailSegs: CubicBezierSegment[] = [];
    pipeline.finalizeStroke(2250, {
      enableFlickTaper: true,
      onPoint: (pt) => slowFlickWidths.push(pt.width),
      onSegment: (seg) => sealedTailSegs.push({ p0: { ...seg.p0 }, c1: { ...seg.c1 }, c2: { ...seg.c2 }, p3: { ...seg.p3 } }),
    });

    expect(slowFlickWidths).toHaveLength(0);
    expect(sealedTailSegs).toHaveLength(1);
  });

  it('keeps predicted tail strictly ephemeral (never mutates dirtyRect or leaks into scratch canvas)', () => {
    const scratch = makeMock2DCtx(800, 600);
    const predicted = makeMock2DCtx(800, 600);
    const view: ViewportTransform = {
      panX: 0,
      panY: 0,
      zoom: 1,
      rotation: 0,
      canvasWidth: 800,
      canvasHeight: 600,
    };

    pipeline.bindContexts(scratch.ctx, predicted.ctx);
    pipeline.setStabilizerLevel(0);
    pipeline.setBrushParameters(10, '#000000');

    const makeEvt = (x: number, y: number, ts: number, pred?: Array<{ clientX: number; clientY: number }>) =>
      ({
        pointerId: 1,
        pointerType: 'pen',
        clientX: x,
        clientY: y,
        pressure: 0.7,
        tiltX: 0,
        tiltY: 0,
        twist: 0,
        buttons: 1,
        timeStamp: ts,
        getCoalescedEvents: () => [],
        getPredictedEvents: () =>
          (pred || []).map((p) => ({
            pointerId: 1,
            pointerType: 'pen',
            clientX: p.clientX,
            clientY: p.clientY,
            pressure: 0.6,
            timeStamp: ts + 8,
          })),
      }) as unknown as PointerEvent;

    pipeline.onPointerDown(makeEvt(100, 100, 100), view);
    pipeline.onPointerMove(makeEvt(120, 100, 116, [{ clientX: 600, clientY: 500 }]), view);

    // Predicted overlay drew the speculative stroke, and dirtyRect did NOT expand to (600, 500)
    expect(predicted.raw.bezierCurveTo).toHaveBeenCalled();
    expect(pipeline.dirtyRect.maxX).toBeLessThan(300);
    expect(pipeline.dirtyRect.maxY).toBeLessThan(300);

    // Also verify buildPredictedSegments does not mutate dirtyRect or knotCount
    const dirtyBefore = { ...pipeline.dirtyRect };
    const knotsBefore = pipeline.getKnotCount();
    const predSegs: number[] = [];
    pipeline.buildPredictedSegments([{ x: 135, y: 100, pressure: 0.5 }], 20, () => predSegs.push(1));
    expect(predSegs.length).toBeGreaterThanOrEqual(2);
    expect(pipeline.dirtyRect).toEqual(dirtyBefore);
    expect(pipeline.getKnotCount()).toBe(knotsBefore);

    // On pointerup, predicted overlay is cleared cleanly
    pipeline.onPointerUp(makeEvt(125, 100, 132), view);
    expect(predicted.raw.clearRect).toHaveBeenCalledWith(0, 0, 800, 600);
    expect(scratch.raw.getImageData).not.toHaveBeenCalled();
    expect(predicted.raw.getImageData).not.toHaveBeenCalled();
  });

  it('computes clamped bake DirtyRect on pointerup accurately with brush size and wetEdge margins', () => {
    // Uninitialized dirty rect returns null
    expect(computeClampedBakeDirtyRect({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, 4096, 4096, 10)).toBeNull();
    expect(computeClampedBakeDirtyRect(null, 4096, 4096, 10)).toBeNull();

    // Standard interior dirty rect with brush size 20 -> pad = max(32, 30) = 32
    const interior = computeClampedBakeDirtyRect({ minX: 100.4, minY: 200.7, maxX: 300.2, maxY: 400.1 }, 4096, 4096, 20, 0);
    expect(interior).toEqual({
      x: 68,
      y: 168,
      width: 265,
      height: 265,
    });

    // Edge-clamped dirty rect at document boundary (0, 0) .. (1024, 768)
    const clamped = computeClampedBakeDirtyRect({ minX: 5, minY: 10, maxX: 1020, maxY: 760 }, 1024, 768, 40, 0);
    expect(clamped).toEqual({
      x: 0,
      y: 0,
      width: 1024,
      height: 768,
    });

    // Wet edge adds wetEdgeRadius * 2 + 8 extra margin
    const wet = computeClampedBakeDirtyRect({ minX: 500, minY: 500, maxX: 520, maxY: 520 }, 4096, 4096, 10, 0.5, 5.0);
    // pad = 32 + (5*2 + 8) = 50 -> min=450, max=570 -> width=120
    expect(wet).toEqual({
      x: 450,
      y: 450,
      width: 120,
      height: 120,
    });
  });

  it('encodes pointer types deterministically', () => {
    expect(encodePointerType('pen')).toBe(POINTER_TYPE_PEN);
    expect(encodePointerType('mouse')).toBe(POINTER_TYPE_MOUSE);
    expect(encodePointerType('touch')).toBe(POINTER_TYPE_TOUCH);
  });
});

describe('WebGlBrushEngine Integration & Canvas 2D Fallback in stampEngine', () => {
  const samplePoints: Point[] = [
    { x: 20, y: 20, pressure: 0.6, width: 14, tiltX: 10, tiltY: 5 },
    { x: 50, y: 25, pressure: 0.8, width: 18, tiltX: 12, tiltY: 6 },
    { x: 90, y: 35, pressure: 0.7, width: 16, tiltX: 8, tiltY: 4 },
  ];

  const mockTipImage = {
    naturalWidth: 64,
    naturalHeight: 64,
    width: 64,
    height: 64,
    src: 'data:image/png;base64,stub',
  } as unknown as HTMLImageElement;

  it('routes textured and soft radial brushes through WebGlBrushEngine batch instancing when GPU is available', () => {
    const gpu = WebGlBrushEngine.getInstance();
    const availSpy = vi.spyOn(gpu, 'isAvailable').mockReturnValue(true);
    const renderedBatches: GpuDab[][] = [];
    const renderSpy = vi.spyOn(gpu, 'renderDabsToContext').mockImplementation((_ctx, dabs) => {
      renderedBatches.push([...dabs]);
      return true;
    });

    try {
      // 1. Textured .sut/preset brush
      const texMock = makeMock2DCtx(256, 256);
      const texOpts: BrushRenderOptions = {
        size: 18,
        flow: 0.85,
        spacing: 0.1,
        antiAlias: 2,
        tipImage: mockTipImage,
        useGpu: true,
        useTilt: true,
      };
      expect(canUseWebGlForBrush(texOpts)).toBe(true);
      renderCompleteStroke(
        texMock.ctx,
        samplePoints,
        {
          size: 18,
          minSizeFactor: 0.2,
          color: '#224488',
          opacity: 1,
          flow: 0.85,
          spacing: 0.1,
          usePressure: true,
          smoothing: true,
          stabilization: 0,
          hardness: 1,
          antiAlias: 2,
          customTipImage: mockTipImage,
          useGpu: true,
          useTilt: true,
        },
        'brush'
      );

      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(renderedBatches[0].length).toBeGreaterThan(5);
      // Zero per-dab Canvas 2D drawImage calls on CPU when GPU succeeds!
      expect(texMock.raw.drawImage).not.toHaveBeenCalled();

      // 2. Soft radial brush
      const radMock = makeMock2DCtx(256, 256);
      expect(canUseWebGlForBrush({ useGpu: true, antiAlias: 2 })).toBe(true);
      renderCompleteStroke(
        radMock.ctx,
        samplePoints,
        {
          size: 18,
          minSizeFactor: 0.2,
          color: '#cc2244',
          opacity: 1,
          flow: 0.9,
          spacing: 0.1,
          usePressure: true,
          smoothing: true,
          stabilization: 0,
          hardness: 0.35,
          antiAlias: 2,
          useGpu: true,
        },
        'brush'
      );

      expect(renderSpy).toHaveBeenCalledTimes(2);
      expect(renderedBatches[1].length).toBeGreaterThan(5);
      expect(radMock.raw.drawImage).not.toHaveBeenCalled();
    } finally {
      availSpy.mockRestore();
      renderSpy.mockRestore();
    }
  });

  it('falls back cleanly to Canvas 2D for binary pixel AA=0, colorMixingEngine, multi-subTip, or GPU failure', () => {
    const gpu = WebGlBrushEngine.getInstance();
    const availSpy = vi.spyOn(gpu, 'isAvailable').mockReturnValue(true);
    const renderSpy = vi.spyOn(gpu, 'renderDabsToContext').mockReturnValue(false);

    try {
      // Eligibility gates
      expect(canUseWebGlForBrush({ size: 10, antiAlias: 0, useGpu: true, tipImage: mockTipImage })).toBe(false);
      expect(canUseWebGlForBrush({ size: 10, colorMixing: true, useGpu: true, tipImage: mockTipImage })).toBe(false);
      expect(canUseWebGlForBrush({ size: 10, useGpu: false, tipImage: mockTipImage })).toBe(false);
      expect(canUseWebGlForBrush({ size: 10, tipImage: mockTipImage, subTipImages: [mockTipImage, mockTipImage], useGpu: true })).toBe(false);
      expect(canUseWebGlForBrush({ antiAlias: 0, useGpu: true })).toBe(false);
      expect(canUseWebGlForBrush({ colorMixing: true, useGpu: true })).toBe(false);

      // When renderDabsToContext returns false (e.g. context lost), falls back to Canvas 2D drawImage
      const fallbackMock = makeMock2DCtx(256, 256);
      renderCompleteStroke(
        fallbackMock.ctx,
        samplePoints,
        {
          size: 18,
          minSizeFactor: 0.2,
          color: '#112233',
          opacity: 1,
          flow: 0.9,
          spacing: 0.15,
          usePressure: true,
          smoothing: true,
          stabilization: 0,
          hardness: 0.8,
          antiAlias: 2,
          useGpu: true,
        },
        'brush'
      );
      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(fallbackMock.raw.drawImage).toHaveBeenCalled();
    } finally {
      availSpy.mockRestore();
      renderSpy.mockRestore();
    }
  });

  it('does not elongate tips on zoomed-out 6071x8598 strokes or paused releases, and tightly caps true flicks', () => {
    // 1. Zoomed-out manga canvas (zoom = 0.1): 4 doc px/ms is only 0.4 screen px/ms (< 0.70 threshold)
    const pipeZoomedOut = new StrokePipeline();
    pipeZoomedOut.beginStroke({ stabilizerLevel: 0, zoom: 0.1, brushSize: 12 });
    pipeZoomedOut.seedKnot(1000, 1000, 0.6, 8, 0, 0, 0, 0);
    pipeZoomedOut.enqueueSample(1032, 1000, 0.55, 0, 0, 0, 8, POINTER_TYPE_PEN);
    pipeZoomedOut.enqueueSample(1064, 1000, 0.5, 0, 0, 0, 16, POINTER_TYPE_PEN);
    pipeZoomedOut.drain();

    const flickPointsZoomedOut: Array<{ x: number; y: number; width: number }> = [];
    pipeZoomedOut.finalizeStroke(20, {
      enableFlickTaper: true,
      onPoint: (s) => flickPointsZoomedOut.push({ x: s.x, y: s.y, width: s.width }),
    });
    expect(flickPointsZoomedOut.length).toBe(0);

    // 2. True fast flick at zoom = 0.1 (15 doc px/ms = 1.5 screen px/ms): tightly capped near brush width
    const pipeFastFlick = new StrokePipeline();
    pipeFastFlick.beginStroke({ stabilizerLevel: 0, zoom: 0.1, brushSize: 12 });
    pipeFastFlick.seedKnot(1000, 1000, 0.6, 8, 0, 0, 0, 0);
    pipeFastFlick.enqueueSample(1120, 1000, 0.55, 0, 0, 0, 8, POINTER_TYPE_PEN);
    pipeFastFlick.enqueueSample(1240, 1000, 0.5, 0, 0, 0, 16, POINTER_TYPE_PEN);
    pipeFastFlick.drain();

    const fastFlickPts: Array<{ x: number; y: number; width: number }> = [];
    pipeFastFlick.finalizeStroke(20, {
      enableFlickTaper: true,
      onPoint: (s) => fastFlickPts.push({ x: s.x, y: s.y, width: s.width }),
    });
    expect(fastFlickPts.length).toBeGreaterThanOrEqual(6);
    const tailLen = Math.hypot(
      fastFlickPts[fastFlickPts.length - 1].x - 1240,
      fastFlickPts[fastFlickPts.length - 1].y - 1000
    );
    expect(tailLen).toBeLessThanOrEqual(16);

    // 3. Dwell gate (>32ms pause before pointerup) suppresses flick completely even at 1.0x zoom
    const pipeDwell = new StrokePipeline();
    pipeDwell.beginStroke({ stabilizerLevel: 0, zoom: 1.0, brushSize: 12 });
    pipeDwell.seedKnot(100, 100, 0.6, 8, 0, 0, 0, 0);
    pipeDwell.enqueueSample(140, 100, 0.55, 0, 0, 0, 8, POINTER_TYPE_PEN);
    pipeDwell.enqueueSample(180, 100, 0.5, 0, 0, 0, 16, POINTER_TYPE_PEN);
    pipeDwell.drain();

    const dwellFlickPts: Array<{ x: number; y: number }> = [];
    pipeDwell.finalizeStroke(80, {
      enableFlickTaper: true,
      onPoint: (s) => dwellFlickPts.push({ x: s.x, y: s.y }),
    });
    expect(dwellFlickPts.length).toBe(0);
  });

  it('routes monochrome pointerup bakes via GPU when allowGpuForMonochrome is enabled and preserves tapered tips', () => {
    const gpu = WebGlBrushEngine.getInstance();
    const availSpy = vi.spyOn(gpu, 'isAvailable').mockReturnValue(true);
    const renderedBatches: GpuDab[][] = [];
    const renderSpy = vi.spyOn(gpu, 'renderDabsToContext').mockImplementation((_ctx, dabs) => {
      renderedBatches.push(dabs.map((d) => ({ ...d })));
      return true;
    });

    try {
      const taperedPoints: Point[] = [
        { x: 10, y: 10, pressure: 0.8, width: 10 },
        { x: 30, y: 10, pressure: 0.6, width: 6 },
        { x: 50, y: 10, pressure: 0.1, width: 0.5 },
      ];
      const gPenSettings = {
        size: 12,
        opacity: 1,
        flow: 1,
        hardness: 1,
        spacing: 0.05,
        color: '#000000',
        antiAlias: 2,
        useGpu: true,
        customTipImage: mockTipImage,
        taper: { useIn: true, useOut: true, inLength: 10, outLength: 10 },
      } as unknown as BrushSettings;

      const mockCtx = makeMock2DCtx(256, 256);
      renderCompleteStroke(
        mockCtx.ctx,
        taperedPoints,
        gPenSettings,
        'brush',
        'monochrome',
        false,
        undefined,
        false,
        undefined,
        true
      );

      expect(renderSpy).toHaveBeenCalledTimes(1);
      expect(mockCtx.raw.drawImage).not.toHaveBeenCalled();
      // Tapered tail width (<1.25px) must NOT be inflated back to 1.25px
      const lastDab = renderedBatches[0][renderedBatches[0].length - 1];
      expect(lastDab.width).toBeLessThan(1.25);

      // Dot Pen (antiAlias: 0) still stays on CPU even with allowGpuForMonochrome = true
      const dotPenCtx = makeMock2DCtx(256, 256);
      renderCompleteStroke(
        dotPenCtx.ctx,
        taperedPoints,
        { ...gPenSettings, antiAlias: 0, customTipImage: undefined },
        'brush',
        'monochrome',
        false,
        undefined,
        false,
        undefined,
        true
      );
      expect(renderSpy).toHaveBeenCalledTimes(1);
    } finally {
      availSpy.mockRestore();
      renderSpy.mockRestore();
    }
  });
});
