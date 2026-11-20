/**
 * StrokePipeline.ts
 * High-performance, zero-allocation input ingestion and stroke rendering pipeline.
 * Decouples pointer event handling from React, ingests coalesced events into a flat
 * Float64Array ring buffer, manages 1-Euro + Corner-Snapping stabilization,
 * provisional Hermite + Catmull-Rom stitching, speculative predictive tip overlay,
 * and dirty-rect calculation for pointerup baking.
 */

import { InputStabilizer, StabilizedSample } from './InputStabilizer';
import { SplineGenerator, SplinePoint, CubicBezierSegment } from './SplineGenerator';
import { TaperEngine } from './TaperEngine';
import type { DirtyRect } from '../types/editor';
import type { PressureCurveSettings } from '../types/settings';
import { evaluateGlobalPressureCurve, isLinearPressureCurve } from '../utils/pressureCurve';

export interface ViewportTransform {
  panX: number;
  panY: number;
  zoom: number;
  rotation: number;
  canvasWidth: number;
  canvasHeight: number;
  flipX?: boolean;
  flipY?: boolean;
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

export interface StrokeSamplePoint {
  x: number;
  y: number;
  pressure: number;
  width: number;
  opacity: number;
  tiltX: number;
  tiltY: number;
  twist: number;
  timestamp: number;
  isCorner: boolean;
  vx: number;
  vy: number;
  pointerType: string;
}

export interface DrainOptions {
  /** Maps stabilized raw sample into final pressure & width without heap allocation. */
  resolvePoint?: (
    rawX: number,
    rawY: number,
    rawPressure: number,
    stabilizedPressure: number,
    pointerType: string,
    vx: number,
    vy: number,
    dtMs: number,
    out: StrokeSamplePoint
  ) => void;
  /** Extra canvas-space padding factor for dirty rect expansion (blur/scatter). */
  dirtyPadExtra?: number;
  /** Invoked once per stabilized point (before segment emission). */
  onPoint?: (pt: Readonly<StrokeSamplePoint>) => void;
  /** Invoked for each sealed cubic Bézier segment (Catmull-Rom or sharp corner). */
  onSegment?: (seg: CubicBezierSegment, isCorner: boolean) => void;
}

export interface FinalizeStrokeOptions {
  enableFlickTaper?: boolean;
  dirtyPadExtra?: number;
  onPoint?: (pt: Readonly<StrokeSamplePoint>) => void;
  onSegment?: (seg: CubicBezierSegment, isCorner: boolean) => void;
}

export const POINTER_TYPE_PEN = 0;
export const POINTER_TYPE_MOUSE = 1;
export const POINTER_TYPE_TOUCH = 2;

export function encodePointerType(pointerType: string | undefined): number {
  if (pointerType === 'mouse') return POINTER_TYPE_MOUSE;
  if (pointerType === 'touch') return POINTER_TYPE_TOUCH;
  return POINTER_TYPE_PEN;
}

export function decodePointerType(code: number): string {
  if (code === POINTER_TYPE_MOUSE) return 'mouse';
  if (code === POINTER_TYPE_TOUCH) return 'touch';
  return 'pen';
}

/**
 * Computes the clamped integer pixel DirtyRect for pointerup baking onto the base layer
 * and SparseTileGrid. Returns null if bounds are empty or invalid.
 */
export function computeClampedBakeDirtyRect(
  dirty: DirtyRectBounds | null | undefined,
  canvasWidth: number,
  canvasHeight: number,
  brushSize: number,
  wetEdge: number = 0,
  wetEdgeRadius: number = 3.0
): DirtyRect | null {
  if (
    !dirty ||
    !Number.isFinite(dirty.minX) ||
    !Number.isFinite(dirty.minY) ||
    !Number.isFinite(dirty.maxX) ||
    !Number.isFinite(dirty.maxY) ||
    dirty.maxX < dirty.minX ||
    dirty.maxY < dirty.minY ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return null;
  }

  const wetMargin = wetEdge > 0.01 ? Math.ceil(wetEdgeRadius * 2 + 8) : 0;
  const pad = Math.ceil(Math.max(32, (brushSize || 10) * 1.5)) + wetMargin;

  const sx = Math.max(0, Math.floor(dirty.minX - pad));
  const sy = Math.max(0, Math.floor(dirty.minY - pad));
  const maxX = Math.min(canvasWidth, Math.ceil(dirty.maxX + pad));
  const maxY = Math.min(canvasHeight, Math.ceil(dirty.maxY + pad));
  const dw = maxX - sx;
  const dh = maxY - sy;

  if (dw <= 0 || dh <= 0) {
    return null;
  }

  return { x: sx, y: sy, width: dw, height: dh };
}

export class StrokePipeline {
  private stabilizer = new InputStabilizer();
  private splineGen = new SplineGenerator();
  private taperEngine = new TaperEngine();

  // Pre-allocated flat ring buffer for raw input coordinates to avoid GC
  // Stride 8: [rawX, rawY, pressure, tiltX, tiltY, twist, timestamp, pointerTypeCode]
  public static readonly BUFFER_CAPACITY = 2048;
  private static readonly STRIDE = 8;
  private inputRingBuffer = new Float64Array(StrokePipeline.BUFFER_CAPACITY * StrokePipeline.STRIDE);
  private headIndex: number = 0;
  private tailIndex: number = 0;

  // Pre-allocated knot cache for zero-allocation spline stitching
  private knotP0: SplinePoint = { x: 0, y: 0, pressure: 0, width: 0, tiltX: 0, tiltY: 0, twist: 0 };
  private knotP1: SplinePoint = { x: 0, y: 0, pressure: 0, width: 0, tiltX: 0, tiltY: 0, twist: 0 };
  private knotP2: SplinePoint = { x: 0, y: 0, pressure: 0, width: 0, tiltX: 0, tiltY: 0, twist: 0 };
  private knotP3: SplinePoint = { x: 0, y: 0, pressure: 0, width: 0, tiltX: 0, tiltY: 0, twist: 0 };
  private knotCount: number = 0;

  // Pre-allocated scratch objects for zero-GC hot paths
  private scratchCoord: { x: number; y: number } = { x: 0, y: 0 };
  private scratchSample: StrokeSamplePoint = {
    x: 0,
    y: 0,
    pressure: 0,
    width: 1,
    opacity: 1,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    timestamp: 0,
    isCorner: false,
    vx: 0,
    vy: 0,
    pointerType: 'pen',
  };
  private globalPressureCurve: PressureCurveSettings | null = null;
  private scratchPredPt: SplinePoint = { x: 0, y: 0, pressure: 0, width: 0, tiltX: 0, tiltY: 0, twist: 0 };
  private scratchPrevPredPt: SplinePoint = { x: 0, y: 0, pressure: 0, width: 0, tiltX: 0, tiltY: 0, twist: 0 };

  // Raw velocity tracker when stabilizerLevel === 0 (bypassed XY lag)
  private lastRawX: number = 0;
  private lastRawY: number = 0;
  private lastRawTime: number = 0;
  private lastVx: number = 0;
  private lastVy: number = 0;
  private hasLastRaw: boolean = false;
  private stabilizerLevel: number = 0;
  private zoomScale: number = 1.0;

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

  // Canvases (optional standalone mode)
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private predictedCtx: CanvasRenderingContext2D | null = null;
  private customRenderer: SegmentRenderCallback | null = null;

  public constructor(customRenderer?: SegmentRenderCallback) {
    if (customRenderer) {
      this.customRenderer = customRenderer;
    }
  }

  public setStabilizerLevel(level: number): void {
    this.stabilizerLevel = Math.min(50, Math.max(0, level));
    this.stabilizer.setStabilizerLevel(this.stabilizerLevel);
  }

  public getStabilizerLevel(): number {
    return this.stabilizerLevel;
  }

  public setZoomScale(zoom: number): void {
    if (Number.isFinite(zoom) && zoom > 0) {
      this.zoomScale = zoom;
    }
    this.stabilizer.setZoomScale(zoom);
  }

  public setSharpCorners(enabled: boolean): void {
    this.stabilizer.setSharpCorners(enabled);
  }

  public setBrushParameters(size: number, color: string): void {
    this.baseBrushSize = Math.max(0.5, size);
    this.strokeColor = color;
  }

  public setGlobalPressureCurve(curve: PressureCurveSettings | null): void {
    this.globalPressureCurve = curve;
  }

  public getGlobalPressureCurve(): PressureCurveSettings | null {
    return this.globalPressureCurve;
  }

  public getTaperEngine(): TaperEngine {
    return this.taperEngine;
  }

  public getStabilizer(): InputStabilizer {
    return this.stabilizer;
  }

  public getSplineGenerator(): SplineGenerator {
    return this.splineGen;
  }

  public getPendingCount(): number {
    return this.headIndex - this.tailIndex;
  }

  public getKnotCount(): number {
    return this.knotCount;
  }

  public getLastVelocity(): { vx: number; vy: number; speed: number } {
    if (this.stabilizerLevel > 0) {
      const s: Readonly<StabilizedSample> = this.stabilizer.getLastSample();
      return { vx: s.vx, vy: s.vy, speed: s.speed };
    }
    return {
      vx: this.lastVx,
      vy: this.lastVy,
      speed: Math.hypot(this.lastVx, this.lastVy),
    };
  }

  public bindContexts(
    scratch: CanvasRenderingContext2D | null,
    predicted: CanvasRenderingContext2D | null
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

  public expandDirtyRect(x: number, y: number, radius: number): void {
    const pad = Math.ceil(Math.max(0, radius) + 4);
    const x0 = Math.max(0, Math.floor(x - pad));
    const y0 = Math.max(0, Math.floor(y - pad));
    const x1 = Math.ceil(x + pad);
    const y1 = Math.ceil(y + pad);
    if (x0 < this.dirtyRect.minX) this.dirtyRect.minX = x0;
    if (y0 < this.dirtyRect.minY) this.dirtyRect.minY = y0;
    if (x1 > this.dirtyRect.maxX) this.dirtyRect.maxX = x1;
    if (y1 > this.dirtyRect.maxY) this.dirtyRect.maxY = y1;
  }

  public expandDirtyRectBounds(minX: number, minY: number, maxX: number, maxY: number): void {
    const x0 = Math.max(0, Math.floor(minX));
    const y0 = Math.max(0, Math.floor(minY));
    const x1 = Math.ceil(maxX);
    const y1 = Math.ceil(maxY);
    if (x0 < this.dirtyRect.minX) this.dirtyRect.minX = x0;
    if (y0 < this.dirtyRect.minY) this.dirtyRect.minY = y0;
    if (x1 > this.dirtyRect.maxX) this.dirtyRect.maxX = x1;
    if (y1 > this.dirtyRect.maxY) this.dirtyRect.maxY = y1;
  }

  /**
   * Resets all pipeline state for a new stroke (used by both standalone and hook-driven modes).
   */
  public beginStroke(config?: {
    stabilizerLevel?: number;
    zoom?: number;
    sharpCorners?: boolean;
    brushSize?: number;
    color?: string;
    pointerId?: number;
    globalPressureCurve?: PressureCurveSettings | null;
  }): void {
    this.stabilizer.reset();
    this.splineGen.reset();
    this.taperEngine.reset();
    this.resetDirtyRect();

    if (config?.stabilizerLevel !== undefined) {
      this.setStabilizerLevel(config.stabilizerLevel);
    }
    if (config?.zoom !== undefined) {
      this.setZoomScale(config.zoom);
    } else {
      this.zoomScale = 1.0;
    }
    if (config?.sharpCorners !== undefined) {
      this.stabilizer.setSharpCorners(config.sharpCorners);
    }
    if (config?.brushSize !== undefined || config?.color !== undefined) {
      this.setBrushParameters(config.brushSize ?? this.baseBrushSize, config.color ?? this.strokeColor);
    }
    if (config?.globalPressureCurve !== undefined) {
      this.globalPressureCurve = config.globalPressureCurve;
    }

    this.headIndex = 0;
    this.tailIndex = 0;
    this.knotCount = 0;
    this.hasLastRaw = false;
    this.lastVx = 0;
    this.lastVy = 0;
    this.isDrawing = true;
    this.activePointerId = config?.pointerId ?? -1;
  }

  /**
   * Aborts active stroke and clears transient buffers.
   */
  public abortStroke(): void {
    this.headIndex = 0;
    this.tailIndex = 0;
    this.knotCount = 0;
    this.hasLastRaw = false;
    this.lastVx = 0;
    this.lastVy = 0;
    this.isDrawing = false;
    this.activePointerId = -1;
    this.resetDirtyRect();
  }

  /**
   * Seeds an initial or pre-computed knot directly into the spline window (e.g. pointerdown or Shift+Click line).
   */
  public seedKnot(
    x: number,
    y: number,
    pressure: number,
    width: number,
    tiltX: number = 0,
    tiltY: number = 0,
    twist: number = 0,
    timestamp: number = 0,
    padExtra: number = 0
  ): void {
    if (this.knotCount === 0) {
      this.copyIntoKnot(this.knotP0, x, y, pressure, width, tiltX, tiltY, twist, timestamp);
      this.copyIntoKnot(this.knotP1, x, y, pressure, width, tiltX, tiltY, twist, timestamp);
      this.knotCount = 1;
    } else if (this.knotCount === 1) {
      this.copyIntoKnot(this.knotP2, x, y, pressure, width, tiltX, tiltY, twist, timestamp);
      this.knotCount = 2;
    } else {
      this.copyKnot(this.knotP0, this.knotP1);
      this.copyKnot(this.knotP1, this.knotP2);
      this.copyIntoKnot(this.knotP2, x, y, pressure, width, tiltX, tiltY, twist, timestamp);
      this.knotCount++;
    }

    if (this.stabilizerLevel > 0) {
      this.stabilizer.process(x, y, pressure, timestamp);
    }
    this.lastRawX = x;
    this.lastRawY = y;
    this.lastRawTime = timestamp;
    this.hasLastRaw = true;
    this.expandDirtyRect(x, y, width + padExtra);
  }

  /**
   * Zero-allocation write of a single raw pointer sample into the Float64Array ring buffer.
   * If the buffer is full (2048 unread samples), advances tailIndex to drop the oldest unread sample safely.
   */
  public enqueueSample(
    x: number,
    y: number,
    pressure: number,
    tiltX: number = 0,
    tiltY: number = 0,
    twist: number = 0,
    timestamp: number = 0,
    pointerTypeCode: number = POINTER_TYPE_PEN
  ): void {
    if (this.headIndex - this.tailIndex >= StrokePipeline.BUFFER_CAPACITY) {
      this.tailIndex = this.headIndex - StrokePipeline.BUFFER_CAPACITY + 1;
    }
    const offset = (this.headIndex % StrokePipeline.BUFFER_CAPACITY) * StrokePipeline.STRIDE;
    this.inputRingBuffer[offset] = x;
    this.inputRingBuffer[offset + 1] = y;
    this.inputRingBuffer[offset + 2] = pressure;
    this.inputRingBuffer[offset + 3] = tiltX;
    this.inputRingBuffer[offset + 4] = tiltY;
    this.inputRingBuffer[offset + 5] = twist;
    this.inputRingBuffer[offset + 6] = timestamp;
    this.inputRingBuffer[offset + 7] = pointerTypeCode;
    this.headIndex++;
  }

  /**
   * Drains all buffered samples from the Float64Array ring buffer, running InputStabilizer,
   * TaperEngine, and SplineGenerator with zero per-sample object allocation.
   * Returns the number of drained samples.
   */
  public drain(options?: DrainOptions): number {
    let drained = 0;
    const padExtra = options?.dirtyPadExtra ?? 0;

    while (this.tailIndex < this.headIndex) {
      const offset = (this.tailIndex % StrokePipeline.BUFFER_CAPACITY) * StrokePipeline.STRIDE;
      const rawX = this.inputRingBuffer[offset];
      const rawY = this.inputRingBuffer[offset + 1];
      const rawP = this.inputRingBuffer[offset + 2];
      const tiltX = this.inputRingBuffer[offset + 3];
      const tiltY = this.inputRingBuffer[offset + 4];
      const twist = this.inputRingBuffer[offset + 5];
      const timeMs = this.inputRingBuffer[offset + 6];
      const pTypeCode = this.inputRingBuffer[offset + 7];
      this.tailIndex++;
      drained++;

      const dtMs = this.hasLastRaw ? Math.max(1, timeMs - this.lastRawTime) : 1;
      const pointerType = decodePointerType(pTypeCode);

      let outX: number;
      let outY: number;
      let stabPressure: number;
      let vx: number;
      let vy: number;
      let isCorner: boolean;

      if (this.stabilizerLevel > 0) {
        const stabilized = this.stabilizer.process(rawX, rawY, rawP, timeMs);
        outX = stabilized.x;
        outY = stabilized.y;
        stabPressure = stabilized.pressure;
        vx = stabilized.vx;
        vy = stabilized.vy;
        isCorner = stabilized.isCorner;
      } else {
        outX = rawX;
        outY = rawY;
        stabPressure = rawP;
        if (this.hasLastRaw) {
          vx = (rawX - this.lastRawX) / dtMs;
          vy = (rawY - this.lastRawY) / dtMs;
        } else {
          vx = 0;
          vy = 0;
        }
        isCorner = false;
      }

      this.lastRawX = outX;
      this.lastRawY = outY;
      this.lastRawTime = timeMs;
      this.lastVx = vx;
      this.lastVy = vy;
      this.hasLastRaw = true;

      const sample = this.scratchSample;
      sample.x = outX;
      sample.y = outY;
      sample.tiltX = tiltX;
      sample.tiltY = tiltY;
      sample.twist = twist;
      sample.timestamp = timeMs;
      sample.isCorner = isCorner;
      sample.vx = vx;
      sample.vy = vy;
      sample.pointerType = pointerType;

      const calibratedStabPressure = evaluateGlobalPressureCurve(
        stabPressure,
        this.globalPressureCurve
      );

      if (options?.resolvePoint) {
        sample.opacity = calibratedStabPressure;
        options.resolvePoint(
          rawX,
          rawY,
          rawP,
          calibratedStabPressure,
          pointerType,
          vx,
          vy,
          dtMs,
          sample
        );
      } else {
        const hasNonLinearGlobalCurve = Boolean(
          this.globalPressureCurve &&
            this.globalPressureCurve.enabled &&
            !isLinearPressureCurve(this.globalPressureCurve.points)
        );
        const mappedPressure = hasNonLinearGlobalCurve
          ? calibratedStabPressure
          : this.taperEngine.mapPressure(calibratedStabPressure);
        const smoothPressure = this.taperEngine.smoothPressure(mappedPressure);
        sample.pressure = smoothPressure;
        sample.width = Math.max(0.5, this.baseBrushSize * smoothPressure);
        sample.opacity = Math.max(0, Math.min(1, smoothPressure));
      }

      this.expandDirtyRect(sample.x, sample.y, sample.width + padExtra);
      options?.onPoint?.(sample);

      this.advanceSplineKnot(
        sample.x,
        sample.y,
        sample.pressure,
        sample.width,
        sample.tiltX,
        sample.tiltY,
        sample.twist,
        sample.timestamp,
        sample.vx,
        sample.vy,
        sample.isCorner,
        padExtra,
        options?.onSegment
      );
    }

    return drained;
  }

  /**
   * Builds strictly ephemeral provisional + forward-predicted Bézier segments without mutating
   * committed knots, stabilizer filter state, or dirtyRect.
   */
  public buildPredictedSegments(
    predictedDocCoords: ReadonlyArray<{ x: number; y: number; pressure?: number }> | null,
    maxPredDist: number,
    onSegment: (seg: CubicBezierSegment) => void
  ): boolean {
    if (this.knotCount < 2) return false;

    const vel = this.getLastVelocity();

    // 1. Provisional unsealed bridge: knotP1 -> knotP2 matching Catmull-Rom geometry
    const bridgeSeg = this.splineGen.generateCatmullRomSegment(
      this.knotP0,
      this.knotP1,
      this.knotP2,
      this.knotP2
    );
    onSegment(bridgeSeg);

    // 2. Speculative lookahead strictly from hardware getPredictedEvents()
    if (predictedDocCoords && predictedDocCoords.length > 0) {
      this.copyKnot(this.scratchPrevPredPt, this.knotP2);
      for (let i = 0; i < predictedDocCoords.length; i++) {
        const raw = predictedDocCoords[i];
        const dx = raw.x - this.scratchPrevPredPt.x;
        const dy = raw.y - this.scratchPrevPredPt.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.5 || dist > maxPredDist * 2.5) break;
        const clampedScale = dist > maxPredDist ? maxPredDist / dist : 1.0;

        this.scratchPredPt.x = this.scratchPrevPredPt.x + dx * clampedScale;
        this.scratchPredPt.y = this.scratchPrevPredPt.y + dy * clampedScale;
        this.scratchPredPt.pressure = this.scratchPrevPredPt.pressure * 0.9;
        this.scratchPredPt.width = Math.max(0.5, this.scratchPrevPredPt.width * 0.9);
        this.scratchPredPt.tiltX = this.knotP2.tiltX;
        this.scratchPredPt.tiltY = this.knotP2.tiltY;
        this.scratchPredPt.twist = this.knotP2.twist;

        const predSeg = this.splineGen.generateProvisionalSegment(
          this.scratchPrevPredPt,
          this.scratchPredPt,
          vel.vx,
          vel.vy
        );
        onSegment(predSeg);
        this.copyKnot(this.scratchPrevPredPt, this.scratchPredPt);
      }
    }

    return true;
  }

  /**
   * Finalizes the stroke on pointerup: seals the unsealed tail segment (knotP1 -> knotP2)
   * and optionally computes ballistic exit flick taper via TaperEngine.
   */
  public finalizeStroke(endTimestampMs: number, options?: FinalizeStrokeOptions): DirtyRectBounds {
    const padExtra = options?.dirtyPadExtra ?? 0;

    if (this.knotCount >= 2) {
      let flickCount = 0;
      let flickPoints: ReturnType<TaperEngine['computeFlickTaper']>['points'] = [];
      let velX = 0;
      let velY = 0;

      if (options?.enableFlickTaper) {
        const dwellMs = this.hasLastRaw ? Math.max(0, endTimestampMs - this.lastRawTime) : 0;
        const vel = this.getLastVelocity();
        velX = vel.vx;
        velY = vel.vy;
        if (dwellMs <= 32) {
          const flick = this.taperEngine.computeFlickTaper(
            this.knotP2.x,
            this.knotP2.y,
            this.knotP2.width,
            this.knotP2.pressure,
            vel.vx,
            vel.vy,
            endTimestampMs,
            0,
            this.zoomScale
          );
          flickCount = flick.count;
          flickPoints = flick.points;
        }
      }

      if (flickCount > 0) {
        for (let i = 0; i < flickCount; i++) {
          const fp = flickPoints[i];
          const sample = this.scratchSample;
          sample.x = fp.x;
          sample.y = fp.y;
          sample.pressure = fp.pressure;
          sample.width = fp.width;
          sample.opacity = fp.alpha;
          sample.tiltX = this.knotP2.tiltX ?? 0;
          sample.tiltY = this.knotP2.tiltY ?? 0;
          sample.twist = this.knotP2.twist ?? 0;
          sample.timestamp = fp.timestamp;
          sample.isCorner = false;
          sample.vx = velX;
          sample.vy = velY;
          sample.pointerType = 'pen';

          this.expandDirtyRect(fp.x, fp.y, fp.width + padExtra);
          options?.onPoint?.(sample);
          this.advanceSplineKnot(
            fp.x,
            fp.y,
            fp.pressure,
            fp.width,
            sample.tiltX,
            sample.tiltY,
            sample.twist,
            fp.timestamp,
            velX,
            velY,
            false,
            padExtra,
            options?.onSegment
          );
        }
        // Seal final flick segment
        const flickTailSeg = this.splineGen.generateCatmullRomSegment(
          this.knotP0,
          this.knotP1,
          this.knotP2,
          this.knotP2
        );
        this.expandSegmentDirtyRect(flickTailSeg, padExtra);
        if (options?.onSegment) {
          options.onSegment(flickTailSeg, false);
        } else if (this.scratchCtx) {
          this.renderSegment(this.scratchCtx, flickTailSeg, false);
        }
      } else {
        // Seal the final unsealed interior segment knotP1 -> knotP2
        const finalSeg = this.splineGen.generateCatmullRomSegment(
          this.knotP0,
          this.knotP1,
          this.knotP2,
          this.knotP2
        );
        this.expandSegmentDirtyRect(finalSeg, padExtra);
        if (options?.onSegment) {
          options.onSegment(finalSeg, false);
        } else if (this.scratchCtx) {
          this.renderSegment(this.scratchCtx, finalSeg, false);
        }
      }
    }

    this.isDrawing = false;
    this.activePointerId = -1;
    return this.dirtyRect;
  }

  /**
   * Pointer Down (standalone canvas mode): resets filters and anchors stroke start without DOM overhead.
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
    this.beginStroke({ pointerId: e.pointerId });

    // Ingest coalesced start points
    this.ingestPointerEvent(e, view);
    this.flush();
  }

  /**
   * Pointer Move (standalone canvas mode): extracts coalesced event stack into ring buffer.
   */
  public onPointerMove(e: PointerEvent, view: ViewportTransform): void {
    if (!this.isDrawing || e.pointerId !== this.activePointerId) return;

    this.ingestPointerEvent(e, view);
    this.flush();

    // Speculative forward prediction on transient overlay
    this.renderPrediction(e, view);
  }

  /**
   * Pointer Up (standalone canvas mode): attenuates flick taper and returns dirty rect for layer bake.
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

    // Seal final segment and evaluate exit flick taper
    this.finalizeStroke(e.timeStamp, { enableFlickTaper: true });

    // Clear prediction overlay canvas
    if (this.predictedCtx) {
      this.predictedCtx.resetTransform();
      this.predictedCtx.clearRect(0, 0, view.canvasWidth, view.canvasHeight);
    }

    return this.dirtyRect;
  }

  /**
   * Ingests native coalesced events into flat typed array ring buffer (zero per-event allocation).
   */
  private ingestPointerEvent(e: PointerEvent, view: ViewportTransform): void {
    let coalesced: PointerEvent[] | readonly PointerEvent[] | null = null;
    if (typeof e.getCoalescedEvents === 'function') {
      const list = e.getCoalescedEvents();
      if (list && list.length > 0) coalesced = list;
    }

    const len = coalesced ? coalesced.length : 1;
    for (let i = 0; i < len; i++) {
      const ev = coalesced ? coalesced[i] : e;
      this.screenToCanvasInto(ev.clientX, ev.clientY, view, this.scratchCoord);

      let pressure = ev.pressure;
      if (ev.pointerType === 'mouse') {
        pressure = (ev.buttons & 1) ? 0.5 : 0.0;
      }

      this.enqueueSample(
        this.scratchCoord.x,
        this.scratchCoord.y,
        pressure,
        ev.tiltX || 0,
        ev.tiltY || 0,
        ev.twist || 0,
        ev.timeStamp,
        encodePointerType(ev.pointerType)
      );
    }
  }

  /**
   * Screen space to canvas space coordinate transformation matrix (zero allocation).
   */
  private screenToCanvasInto(
    screenX: number,
    screenY: number,
    view: ViewportTransform,
    out: { x: number; y: number }
  ): void {
    const cx = view.canvasWidth / 2;
    const cy = view.canvasHeight / 2;

    const rad = (-view.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const relX = (screenX - view.panX - cx) / view.zoom;
    const relY = (screenY - view.panY - cy) / view.zoom;

    const fx = view.flipX ? -1 : 1;
    const fy = view.flipY ? -1 : 1;

    out.x = (relX * cos - relY * sin) * fx + cx;
    out.y = (relX * sin + relY * cos) * fy + cy;
  }

  /**
   * Standalone flush: drains ring buffer, runs stabilizer & splines onto bound scratchCtx.
   */
  private flush(): void {
    if (!this.scratchCtx) return;
    const scratch = this.scratchCtx;
    this.drain({
      onSegment: (seg) => {
        this.renderSegment(scratch, seg, false);
      },
    });
  }

  private copyIntoKnot(
    dst: SplinePoint,
    x: number,
    y: number,
    pressure: number,
    width: number,
    tiltX: number,
    tiltY: number,
    twist: number,
    timestamp: number
  ): void {
    dst.x = x;
    dst.y = y;
    dst.pressure = pressure;
    dst.width = width;
    dst.tiltX = tiltX;
    dst.tiltY = tiltY;
    dst.twist = twist;
    dst.timestamp = timestamp;
  }

  private copyKnot(dst: SplinePoint, src: SplinePoint): void {
    dst.x = src.x;
    dst.y = src.y;
    dst.pressure = src.pressure;
    dst.width = src.width;
    dst.tiltX = src.tiltX;
    dst.tiltY = src.tiltY;
    dst.twist = src.twist;
    dst.timestamp = src.timestamp;
  }

  private expandSegmentDirtyRect(seg: CubicBezierSegment, padExtra: number = 0): void {
    this.expandDirtyRect(seg.p0.x, seg.p0.y, seg.p0.width + padExtra);
    this.expandDirtyRect(seg.c1.x, seg.c1.y, seg.c1.width + padExtra);
    this.expandDirtyRect(seg.c2.x, seg.c2.y, seg.c2.width + padExtra);
    this.expandDirtyRect(seg.p3.x, seg.p3.y, seg.p3.width + padExtra);
  }

  /**
   * Zero-Delay Spline Pipeline with Adaptive Corner Snapping:
   * When corner is detected (DeltaTheta > 45 deg), immediately commits sharp knot.
   */
  private advanceSplineKnot(
    x: number,
    y: number,
    pressure: number,
    width: number,
    tiltX: number,
    tiltY: number,
    twist: number,
    timestamp: number,
    vx: number,
    vy: number,
    isCorner: boolean,
    padExtra: number,
    onSegment?: (seg: CubicBezierSegment, isCorner: boolean) => void
  ): void {
    if (isCorner && this.knotCount >= 1) {
      this.copyIntoKnot(this.knotP3, x, y, pressure, width, tiltX, tiltY, twist, timestamp);

      if (this.knotCount >= 2) {
        // First seal the pending interior segment P1 -> P2 before snapping into the sharp corner P2 -> P3
        // (Matches renderCompleteStroke's centripetalCatmullRomToBezier so zero corner gaps occur!)
        const preCornerSeg = this.splineGen.generateCatmullRomSegment(
          this.knotP0,
          this.knotP1,
          this.knotP2,
          this.knotP3
        );
        this.expandSegmentDirtyRect(preCornerSeg, padExtra);
        if (onSegment) {
          onSegment(preCornerSeg, false);
        } else if (this.scratchCtx) {
          this.renderSegment(this.scratchCtx, preCornerSeg, false);
        }

        // Now seal P2 -> corner apex P3 with sharp corner endpoint
        const toApexSeg = this.splineGen.generateCatmullRomSegment(
          this.knotP1,
          this.knotP2,
          this.knotP3,
          this.knotP3
        );
        this.expandSegmentDirtyRect(toApexSeg, padExtra);
        if (onSegment) {
          onSegment(toApexSeg, true);
        } else if (this.scratchCtx) {
          this.renderSegment(this.scratchCtx, toApexSeg, false);
        }
      } else {
        const cornerSeg = this.splineGen.generateCornerSegment(this.knotP1, this.knotP3);
        this.expandSegmentDirtyRect(cornerSeg, padExtra);
        if (onSegment) {
          onSegment(cornerSeg, true);
        } else if (this.scratchCtx) {
          this.renderSegment(this.scratchCtx, cornerSeg, false);
        }
      }

      this.splineGen.commitCornerKnot(this.knotP3);
      this.copyKnot(this.knotP0, this.knotP3);
      this.copyKnot(this.knotP1, this.knotP3);
      this.knotCount = 1;
      return;
    }

    if (this.knotCount === 0) {
      this.copyIntoKnot(this.knotP0, x, y, pressure, width, tiltX, tiltY, twist, timestamp);
      this.copyIntoKnot(this.knotP1, x, y, pressure, width, tiltX, tiltY, twist, timestamp);
      this.knotCount = 1;
      return;
    }

    if (this.knotCount === 1) {
      this.copyIntoKnot(this.knotP2, x, y, pressure, width, tiltX, tiltY, twist, timestamp);
      if (!onSegment && this.predictedCtx) {
        const seg = this.splineGen.generateProvisionalSegment(this.knotP1, this.knotP2, vx, vy);
        this.renderSegment(this.predictedCtx, seg, true);
      }
      this.knotCount = 2;
      return;
    }

    // Third+ knot: [P0, P1, P2, P3] -> seal P1 -> P2
    this.copyIntoKnot(this.knotP3, x, y, pressure, width, tiltX, tiltY, twist, timestamp);

    const sealedSeg = this.splineGen.generateCatmullRomSegment(
      this.knotP0,
      this.knotP1,
      this.knotP2,
      this.knotP3
    );
    this.expandSegmentDirtyRect(sealedSeg, padExtra);
    if (onSegment) {
      onSegment(sealedSeg, false);
    } else if (this.scratchCtx) {
      this.renderSegment(this.scratchCtx, sealedSeg, false);
    }

    if (!onSegment && this.predictedCtx) {
      const nextProvSeg = this.splineGen.generateProvisionalSegment(this.knotP2, this.knotP3, vx, vy);
      this.renderSegment(this.predictedCtx, nextProvSeg, true);
    }

    // Shift window (zero allocation)
    this.copyKnot(this.knotP0, this.knotP1);
    this.copyKnot(this.knotP1, this.knotP2);
    this.copyKnot(this.knotP2, this.knotP3);
    this.knotCount++;
  }

  /**
   * Speculative Forward Stroke Prediction (standalone mode):
   * Uses seamless Hermite extrapolation matching exact brush thickness, geometry, and renderer.
   */
  private renderPrediction(e: PointerEvent, view: ViewportTransform): void {
    if (!this.predictedCtx || this.knotCount < 2) return;

    this.predictedCtx.resetTransform();
    this.predictedCtx.clearRect(0, 0, view.canvasWidth, view.canvasHeight);

    let predEvents: PointerEvent[] | readonly PointerEvent[] | null = null;
    if (typeof e.getPredictedEvents === 'function') {
      const pred = e.getPredictedEvents();
      if (pred && pred.length > 0) predEvents = pred;
    }

    if (predEvents && predEvents.length > 0) {
      this.copyKnot(this.scratchPrevPredPt, this.knotP2);
      for (let i = 0; i < predEvents.length; i++) {
        const ev = predEvents[i];
        this.screenToCanvasInto(ev.clientX, ev.clientY, view, this.scratchCoord);
        const pVal = this.taperEngine.mapPressure(ev.pressure || 0.5);
        const w = Math.max(0.5, this.baseBrushSize * pVal);
        this.scratchPredPt.x = this.scratchCoord.x;
        this.scratchPredPt.y = this.scratchCoord.y;
        this.scratchPredPt.pressure = pVal;
        this.scratchPredPt.width = w;

        const seg = this.splineGen.generateProvisionalSegment(this.scratchPrevPredPt, this.scratchPredPt, 0, 0);
        this.renderSegment(this.predictedCtx, seg, true);
        this.copyKnot(this.scratchPrevPredPt, this.scratchPredPt);
      }
    } else {
      const vel = this.getLastVelocity();
      if (vel.speed > 0.05) {
        const dt = 12.0; // ms forward
        this.scratchPredPt.x = this.knotP2.x + vel.vx * dt;
        this.scratchPredPt.y = this.knotP2.y + vel.vy * dt;
        this.scratchPredPt.pressure = this.knotP2.pressure;
        this.scratchPredPt.width = this.knotP2.width;
        const seg = this.splineGen.generateProvisionalSegment(this.knotP2, this.scratchPredPt, vel.vx, vel.vy);
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

    if (ctx === this.scratchCtx) {
      this.expandSegmentDirtyRect(seg);
    }
  }
}
