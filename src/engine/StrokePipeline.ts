/**
 * StrokePipeline.ts
 * High-performance, zero-allocation input ingestion and stroke rendering pipeline.
 * Decouples pointer event handling from React, ingests coalesced events,
 * manages 1-Euro + Corner-Snapping stabilization, provisional Hermite + Catmull-Rom stitching,
 * speculative predictive tip overlay, and dirty-rect baking.
 */

import { InputStabilizer } from './InputStabilizer';
import { SplineGenerator, SplinePoint, CubicBezierSegment } from './SplineGenerator';
import { TaperEngine } from './TaperEngine';

export interface ViewportTransform {
  panX: number;
  panY: number;
  zoom: number;
  rotation: number;
  canvasWidth: number;
  canvasHeight: number;
}

export interface DirtyRectBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type SegmentRenderCallback = (
  ctx: CanvasRenderingContext2D,
  segment: CubicBezierSegment,
  color: string,
  baseWidth: number,
  isProvisional: boolean
) => void;

export class StrokePipeline {
  private stabilizer = new InputStabilizer();
  private splineGen = new SplineGenerator();
  private taperEngine = new TaperEngine();

  // Pre-allocated flat ring buffer for raw input coordinates to avoid GC
  // Stride 6: [rawX, rawY, pressure, tiltX, tiltY, timestamp]
  private static readonly BUFFER_CAPACITY = 2048;
  private static readonly STRIDE = 6;
  private inputRingBuffer = new Float64Array(StrokePipeline.BUFFER_CAPACITY * StrokePipeline.STRIDE);
  private headIndex: number = 0;
  private tailIndex: number = 0;

  // Knot cache for spline stitching
  private knotP0: SplinePoint = { x: 0, y: 0, pressure: 0, width: 0 };
  private knotP1: SplinePoint = { x: 0, y: 0, pressure: 0, width: 0 };
  private knotP2: SplinePoint = { x: 0, y: 0, pressure: 0, width: 0 };
  private knotP3: SplinePoint = { x: 0, y: 0, pressure: 0, width: 0 };
  private knotCount: number = 0;

  // Dirty rect tracking (integer bounds in canvas space)
  public dirtyRect: DirtyRectBounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };

  private isDrawing: boolean = false;
  private activePointerId: number = -1;
  private baseBrushSize: number = 10;
  private strokeColor: string = '#000000';

  // Canvases
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private predictedCtx: CanvasRenderingContext2D | null = null;
  private customRenderer: SegmentRenderCallback | null = null;

  public constructor(customRenderer?: SegmentRenderCallback) {
    if (customRenderer) {
      this.customRenderer = customRenderer;
    }
  }

  public setStabilizerLevel(level: number): void {
    this.stabilizer.setStabilizerLevel(level);
  }

  public setBrushParameters(size: number, color: string): void {
    this.baseBrushSize = Math.max(0.5, size);
    this.strokeColor = color;
  }

  public bindContexts(
    scratch: CanvasRenderingContext2D,
    predicted: CanvasRenderingContext2D
  ): void {
    this.scratchCtx = scratch;
    this.predictedCtx = predicted;
  }

  public resetDirtyRect(): void {
    this.dirtyRect.minX = Infinity;
    this.dirtyRect.minY = Infinity;
    this.dirtyRect.maxX = -Infinity;
    this.dirtyRect.maxY = -Infinity;
  }

  private expandDirtyRect(x: number, y: number, radius: number): void {
    const pad = Math.ceil(radius + 4);
    if (x - pad < this.dirtyRect.minX) this.dirtyRect.minX = Math.max(0, Math.floor(x - pad));
    if (y - pad < this.dirtyRect.minY) this.dirtyRect.minY = Math.max(0, Math.floor(y - pad));
    if (x + pad > this.dirtyRect.maxX) this.dirtyRect.maxX = Math.ceil(x + pad);
    if (y + pad > this.dirtyRect.maxY) this.dirtyRect.maxY = Math.ceil(y + pad);
  }

  /**
   * Pointer Down: resets filters and anchors stroke start without DOM overhead.
   */
  public onPointerDown(
    e: PointerEvent,
    view: ViewportTransform,
    targetElement?: HTMLElement
  ): void {
    if (targetElement) {
      try {
        targetElement.setPointerCapture(e.pointerId);
      } catch {}
    }
    this.isDrawing = true;
    this.activePointerId = e.pointerId;

    this.stabilizer.reset();
    this.splineGen.reset();
    this.taperEngine.reset();
    this.resetDirtyRect();
    this.headIndex = 0;
    this.tailIndex = 0;
    this.knotCount = 0;

    // Ingest coalesced start points
    this.ingestPointerEvent(e, view);
    this.flush();
  }

  /**
   * Pointer Move: Extracts full hardware coalesced event stack (133 - 240+ Hz).
   * Zero React state updates or DOM allocations.
   */
  public onPointerMove(e: PointerEvent, view: ViewportTransform): void {
    if (!this.isDrawing || e.pointerId !== this.activePointerId) return;

    this.ingestPointerEvent(e, view);
    this.flush();

    // Speculative forward prediction on transient overlay
    this.renderPrediction(e, view);
  }

  /**
   * Pointer Up: Attenuates flick taper and prepares dirty rect for layer bake.
   */
  public onPointerUp(
    e: PointerEvent,
    view: ViewportTransform,
    targetElement?: HTMLElement
  ): DirtyRectBounds {
    if (!this.isDrawing || e.pointerId !== this.activePointerId) {
      return this.dirtyRect;
    }

    if (targetElement) {
      try {
        if (targetElement.hasPointerCapture(e.pointerId)) {
          targetElement.releasePointerCapture(e.pointerId);
        }
      } catch {}
    }

    // Flush any remaining hardware points
    this.ingestPointerEvent(e, view);
    this.flush();

    // Evaluate exit flick taper
    if (this.knotCount >= 2 && this.scratchCtx) {
      const exitSample = this.stabilizer.process(this.knotP2.x, this.knotP2.y, this.knotP2.pressure, e.timeStamp);
      const flick = this.taperEngine.computeFlickTaper(
        this.knotP2.x,
        this.knotP2.y,
        this.knotP2.width,
        this.knotP2.pressure,
        exitSample.vx,
        exitSample.vy,
        e.timeStamp
      );

      if (flick.count > 0) {
        for (let i = 0; i < flick.count; i++) {
          const pt = flick.points[i];
          this.processStabilizedPoint(pt.x, pt.y, pt.pressure, pt.width, exitSample.vx, exitSample.vy, false);
        }
      }
    }

    // Clear prediction overlay canvas
    if (this.predictedCtx) {
      this.predictedCtx.resetTransform();
      this.predictedCtx.clearRect(0, 0, view.canvasWidth, view.canvasHeight);
    }

    this.isDrawing = false;
    this.activePointerId = -1;
    return this.dirtyRect;
  }

  /**
   * Ingests native coalesced events into flat typed array ring buffer.
   */
  private ingestPointerEvent(e: PointerEvent, view: ViewportTransform): void {
    let events: PointerEvent[] | readonly PointerEvent[];
    if (typeof e.getCoalescedEvents === 'function') {
      const coalesced = e.getCoalescedEvents();
      events = coalesced && coalesced.length > 0 ? coalesced : [e];
    } else {
      events = [e];
    }

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const coords = this.screenToCanvas(ev.clientX, ev.clientY, view);

      let pressure = ev.pressure;
      if (ev.pointerType === 'mouse') {
        pressure = (ev.buttons & 1) ? 0.5 : 0.0;
      }

      const offset = (this.headIndex % StrokePipeline.BUFFER_CAPACITY) * StrokePipeline.STRIDE;
      this.inputRingBuffer[offset] = coords.x;
      this.inputRingBuffer[offset + 1] = coords.y;
      this.inputRingBuffer[offset + 2] = pressure;
      this.inputRingBuffer[offset + 3] = ev.tiltX || 0;
      this.inputRingBuffer[offset + 4] = ev.tiltY || 0;
      this.inputRingBuffer[offset + 5] = ev.timeStamp;

      this.headIndex++;
    }
  }

  /**
   * Screen space to canvas space coordinate transformation matrix.
   */
  private screenToCanvas(
    screenX: number,
    screenY: number,
    view: ViewportTransform
  ): { x: number; y: number } {
    const cx = view.canvasWidth / 2;
    const cy = view.canvasHeight / 2;

    const rad = (-view.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const relX = (screenX - view.panX - cx) / view.zoom;
    const relY = (screenY - view.panY - cy) / view.zoom;

    return {
      x: relX * cos - relY * sin + cx,
      y: relX * sin + relY * cos + cy,
    };
  }

  /**
   * Flushes ring buffer, runs corner-snapping stabilizer, and draws splines.
   */
  private flush(): void {
    if (!this.scratchCtx) return;

    while (this.tailIndex < this.headIndex) {
      const offset = (this.tailIndex % StrokePipeline.BUFFER_CAPACITY) * StrokePipeline.STRIDE;
      const rawX = this.inputRingBuffer[offset];
      const rawY = this.inputRingBuffer[offset + 1];
      const rawP = this.inputRingBuffer[offset + 2];
      const timeMs = this.inputRingBuffer[offset + 5];
      this.tailIndex++;

      // Adaptive stabilizer + S-Curve pressure response
      const stabilized = this.stabilizer.process(rawX, rawY, rawP, timeMs);
      const mappedPressure = this.taperEngine.mapPressure(stabilized.pressure);
      const smoothPressure = this.taperEngine.smoothPressure(mappedPressure);

      // Compute continuous stroke width
      const width = Math.max(0.5, this.baseBrushSize * smoothPressure);

      this.processStabilizedPoint(
        stabilized.x,
        stabilized.y,
        smoothPressure,
        width,
        stabilized.vx,
        stabilized.vy,
        stabilized.isCorner
      );
    }
  }

  /**
   * Zero-Delay Spline Pipeline with Adaptive Corner Snapping:
   * When corner is detected (DeltaTheta > 45 deg), immediately commits sharp knot.
   */
  private processStabilizedPoint(
    x: number,
    y: number,
    pressure: number,
    width: number,
    vx: number,
    vy: number,
    isCorner: boolean
  ): void {
    if (!this.scratchCtx) return;

    if (isCorner && this.knotCount >= 1) {
      const cornerPt: SplinePoint = { x, y, pressure, width };
      const cornerSeg = this.splineGen.generateCornerSegment(this.knotP1, cornerPt);
      this.renderSegment(this.scratchCtx, cornerSeg, false);
      this.splineGen.commitCornerKnot(cornerPt);

      this.knotP0.x = x;
      this.knotP0.y = y;
      this.knotP0.pressure = pressure;
      this.knotP0.width = width;

      this.knotP1.x = x;
      this.knotP1.y = y;
      this.knotP1.pressure = pressure;
      this.knotP1.width = width;

      this.knotCount = 1;
      this.expandDirtyRect(x, y, width);
      return;
    }

    if (this.knotCount === 0) {
      this.knotP0.x = x;
      this.knotP0.y = y;
      this.knotP0.pressure = pressure;
      this.knotP0.width = width;

      this.knotP1.x = x;
      this.knotP1.y = y;
      this.knotP1.pressure = pressure;
      this.knotP1.width = width;

      this.knotCount = 1;
      this.expandDirtyRect(x, y, width);
      return;
    }

    if (this.knotCount === 1) {
      this.knotP2.x = x;
      this.knotP2.y = y;
      this.knotP2.pressure = pressure;
      this.knotP2.width = width;

      const seg = this.splineGen.generateProvisionalSegment(this.knotP1, this.knotP2, vx, vy);
      this.renderSegment(this.scratchCtx, seg, true);
      this.knotCount = 2;
      return;
    }

    // Third+ knot: [P0, P1, P2, P3]
    this.knotP3.x = x;
    this.knotP3.y = y;
    this.knotP3.pressure = pressure;
    this.knotP3.width = width;

    const sealedSeg = this.splineGen.generateCatmullRomSegment(
      this.knotP0,
      this.knotP1,
      this.knotP2,
      this.knotP3
    );
    this.renderSegment(this.scratchCtx, sealedSeg, false);

    const nextProvSeg = this.splineGen.generateProvisionalSegment(this.knotP2, this.knotP3, vx, vy);
    this.renderSegment(this.scratchCtx, nextProvSeg, true);

    // Shift window
    this.knotP0.x = this.knotP1.x;
    this.knotP0.y = this.knotP1.y;
    this.knotP0.pressure = this.knotP1.pressure;
    this.knotP0.width = this.knotP1.width;

    this.knotP1.x = this.knotP2.x;
    this.knotP1.y = this.knotP2.y;
    this.knotP1.pressure = this.knotP2.pressure;
    this.knotP1.width = this.knotP2.width;

    this.knotP2.x = this.knotP3.x;
    this.knotP2.y = this.knotP3.y;
    this.knotP2.pressure = this.knotP3.pressure;
    this.knotP2.width = this.knotP3.width;

    this.knotCount++;
  }

  /**
   * Speculative Forward Stroke Prediction:
   * Uses seamless Hermite extrapolation matching exact brush thickness, geometry, and renderer.
   * Completely eliminates wireframe lineTo artifacts.
   */
  private renderPrediction(e: PointerEvent, view: ViewportTransform): void {
    if (!this.predictedCtx || this.knotCount < 2) return;

    this.predictedCtx.resetTransform();
    this.predictedCtx.clearRect(0, 0, view.canvasWidth, view.canvasHeight);

    let predEvents: PointerEvent[] | readonly PointerEvent[] = [];
    if (typeof e.getPredictedEvents === 'function') {
      const pred = e.getPredictedEvents();
      if (pred && pred.length > 0) predEvents = pred;
    }

    if (predEvents.length > 0) {
      let prevPt = this.knotP2;
      for (let i = 0; i < predEvents.length; i++) {
        const ev = predEvents[i];
        const pt = this.screenToCanvas(ev.clientX, ev.clientY, view);
        const pVal = this.taperEngine.mapPressure(ev.pressure || 0.5);
        const w = Math.max(0.5, this.baseBrushSize * pVal);
        const curPt: SplinePoint = { x: pt.x, y: pt.y, pressure: pVal, width: w };

        const seg = this.splineGen.generateProvisionalSegment(prevPt, curPt, 0, 0);
        this.renderSegment(this.predictedCtx, seg, true);
        prevPt = curPt;
      }
    } else {
      // Hermite extrapolation forward along velocity vector
      const sample = this.stabilizer.process(this.knotP2.x, this.knotP2.y, this.knotP2.pressure, e.timeStamp);
      if (sample.speed > 0.05) {
        const dt = 12.0; // ms forward
        const predPt: SplinePoint = {
          x: this.knotP2.x + sample.vx * dt,
          y: this.knotP2.y + sample.vy * dt,
          pressure: this.knotP2.pressure,
          width: this.knotP2.width,
        };
        const seg = this.splineGen.generateProvisionalSegment(this.knotP2, predPt, sample.vx, sample.vy);
        this.renderSegment(this.predictedCtx, seg, true);
      }
    }
  }

  /**
   * Renders cubic Bézier segment with matching geometry.
   */
  private renderSegment(
    ctx: CanvasRenderingContext2D,
    seg: CubicBezierSegment,
    isProvisional: boolean
  ): void {
    if (this.customRenderer) {
      this.customRenderer(ctx, seg, this.strokeColor, this.baseBrushSize, isProvisional);
    } else {
      ctx.strokeStyle = this.strokeColor;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(0.5, (seg.p0.width + seg.p3.width) * 0.5);

      ctx.beginPath();
      ctx.moveTo(seg.p0.x, seg.p0.y);
      ctx.bezierCurveTo(seg.c1.x, seg.c1.y, seg.c2.x, seg.c2.y, seg.p3.x, seg.p3.y);
      ctx.stroke();
    }

    this.expandDirtyRect(seg.p0.x, seg.p0.y, seg.p0.width);
    this.expandDirtyRect(seg.c1.x, seg.c1.y, seg.c1.width);
    this.expandDirtyRect(seg.c2.x, seg.c2.y, seg.c2.width);
    this.expandDirtyRect(seg.p3.x, seg.p3.y, seg.p3.width);
  }
}
