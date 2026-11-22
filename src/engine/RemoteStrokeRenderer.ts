/**
 * Deterministic remote stroke live-preview renderer.
 * Routes remote STROKE_START / STROKE_CHUNK packets through the exact same
 * StrokePipeline (Catmull-Rom + corner-snapping) and WebGL instanced brush engine
 * used locally, with hash-synchronized brush tip and texture assets.
 *
 * Strictly for ephemeral live preview; authoritative raster state arrives via BINARY_TILE.
 */

import type {
  BrushSettings,
  CanvasColorMode,
  LayerItem,
  Point,
  ToolType,
} from '../types/editor';
import type { BrushAssetRefs } from '../types/multiplayer';
import { get2DContext } from '../utils/canvasUtils';
import { enforceColorMode } from '../utils/colorUtils';
import {
  hydrateBrushSettingsFromHashes,
  onBrushAssetReady,
} from '../utils/brushAssetSync';
import { StrokePipeline } from './StrokePipeline';
import {
  BrushRenderOptions,
  buildBrushRenderOptions,
  canUseWebGlForBrush,
  drawBrushCubicBezierSegment,
  drawBrushDot,
  flushGpuDabs,
} from './BrushEngine';
import type { GpuDab } from './WebGlBrushEngine';
import type { CubicBezierSegment } from './SplineGenerator';

export interface RemoteStrokeSessionOptions {
  strokeId: string;
  peerId: string | number;
  layerId: string;
  tool: ToolType;
  brushSettings: BrushSettings;
  brushAssetRefs?: BrushAssetRefs;
  startPoint: Point;
  colorMode: CanvasColorMode;
  targetLayer?: LayerItem;
  onRequestAsset?: (hash: string) => void;
}

const MAX_PREVIEW_POINTS_BUFFER = 4096;

export class RemoteStrokeSession {
  public readonly strokeId: string;
  public readonly peerId: string | number;
  public readonly layerId: string;
  public readonly tool: ToolType;

  private readonly pipeline = new StrokePipeline();
  private readonly rawBrushSettings: BrushSettings;
  private readonly brushAssetRefs?: BrushAssetRefs;
  private readonly colorMode: CanvasColorMode;
  private readonly isMonochrome: boolean;
  private readonly isEraser: boolean;
  private readonly isBgEraser: boolean;

  private brushSettings: BrushSettings;
  private points: Point[];
  private stampRemainderDist = 0;
  private strokeTotalDistance = 0;
  private dabCounter = { count: 0 };
  private gpuBatch: GpuDab[] = [];
  private assetUnsubscribers: Array<() => void> = [];
  private disposed = false;

  constructor(opts: RemoteStrokeSessionOptions) {
    this.strokeId = opts.strokeId;
    this.peerId = opts.peerId;
    this.layerId = opts.layerId;
    this.tool = opts.tool;
    this.rawBrushSettings = opts.brushSettings;
    this.brushAssetRefs = opts.brushAssetRefs;
    this.colorMode = opts.colorMode;
    this.isEraser = opts.tool === 'eraser';
    this.isBgEraser =
      this.isEraser &&
      (opts.layerId === 'layer-bg' || opts.layerId.startsWith('layer-bg'));
    this.isMonochrome =
      !opts.layerId.startsWith('layer-bg') &&
      (opts.colorMode === 'monochrome' ||
        opts.targetLayer?.expressionColor === 'monochrome');

    const { hydrated, missingHashes } = hydrateBrushSettingsFromHashes(
      opts.brushSettings,
      opts.brushAssetRefs
    );
    this.brushSettings = hydrated;
    this.points = [opts.startPoint];

    if (opts.onRequestAsset) {
      for (const hash of missingHashes) {
        opts.onRequestAsset(hash);
      }
    }
  }

  public getBrushSettings(): BrushSettings {
    return this.brushSettings;
  }

  public getPoints(): readonly Point[] {
    return this.points;
  }

  private resolvePreviewColor(): string {
    if (this.isBgEraser) return '#ffffff';
    if (this.isEraser || this.brushSettings.isTransparentInk) return '#ffffff';
    return enforceColorMode(
      this.brushSettings.color,
      this.isMonochrome ? 'monochrome' : this.colorMode
    );
  }

  private resolvePreviewOpacity(): number {
    const baseOpacity = Math.max(0, Math.min(1, this.brushSettings.opacity ?? 1.0));
    if ((this.isEraser && !this.isBgEraser) || this.brushSettings.isTransparentInk) {
      return Math.min(0.45, baseOpacity * 0.45);
    }
    return baseOpacity;
  }

  private buildPreviewRenderOptions(): BrushRenderOptions {
    const bs = this.brushSettings;
    const strokeHardness = this.isMonochrome ? 1.0 : bs.hardness ?? 1.0;
    const strokeFlow = this.isMonochrome ? 1.0 : bs.flow ?? 1.0;
    const strokeSpacing = bs.spacing ?? 0.08;
    const effectiveAA = this.isMonochrome
      ? (bs.antiAlias ?? 2) !== 0 && bs.useGpu !== false
        ? bs.antiAlias ?? 2
        : 0
      : bs.antiAlias;

    const effectiveOpacitySensor =
      bs.opacitySensor ??
      (bs.usePressure && !this.isMonochrome && !this.isEraser && strokeFlow < 0.99
        ? { usePressure: true, pressureMin: 0.2 }
        : undefined);

    return buildBrushRenderOptions(bs, {
      opacity: 1.0, // Isolated pass; stroke opacity applied to peer draft canvas element
      flow: strokeFlow,
      spacing: strokeSpacing,
      hardness: strokeHardness,
      antiAlias: effectiveAA,
      opacitySensor: effectiveOpacitySensor,
      wetEdge: 0,
      colorMixing: false,
      isEraser: false,
      isBgEraser: false,
      alphaLocked: false,
      isTransparentInk: false,
      useGpu: bs.useGpu !== false,
      currentStrokeDist: this.strokeTotalDistance,
    });
  }

  private bindAssetWatchers(getDraftCanvas: () => HTMLCanvasElement | undefined): void {
    this.clearAssetWatchers();
    if (!this.brushAssetRefs) return;

    const { missingHashes, pendingHashes } = hydrateBrushSettingsFromHashes(
      this.rawBrushSettings,
      this.brushAssetRefs
    );
    const watched = new Set<string>([...missingHashes, ...pendingHashes]);
    for (const hash of watched) {
      const unsub = onBrushAssetReady(hash, () => {
        if (this.disposed) return;
        const { hydrated } = hydrateBrushSettingsFromHashes(
          this.rawBrushSettings,
          this.brushAssetRefs
        );
        this.brushSettings = hydrated;
        const canvas = getDraftCanvas();
        if (canvas) {
          this.replayPreview(canvas);
        }
      });
      this.assetUnsubscribers.push(unsub);
    }
  }

  private clearAssetWatchers(): void {
    for (const unsub of this.assetUnsubscribers) {
      unsub();
    }
    this.assetUnsubscribers.length = 0;
  }

  private resetPipelineState(startPoint: Point, strokeColor: string): void {
    const bs = this.brushSettings;
    this.pipeline.beginStroke({
      stabilizerLevel: 0, // Incoming points are already stabilized by sender StrokePipeline
      sharpCorners: bs.sharpCorners !== false,
      brushSize: bs.size,
      color: strokeColor,
    });

    const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
    const padExtra = Math.ceil((bs.size || 10) * (1.8 + scatterFactor * 2) + 24);
    this.pipeline.seedKnot(
      startPoint.x,
      startPoint.y,
      startPoint.pressure,
      startPoint.width,
      startPoint.tiltX ?? 0,
      startPoint.tiltY ?? 0,
      startPoint.twist ?? 0,
      startPoint.timestamp ?? 0,
      padExtra
    );

    this.dabCounter.count = 0;
    this.strokeTotalDistance = 0;
    this.stampRemainderDist = bs.customTipImage
      ? Math.max(0.15, startPoint.width * (bs.spacing ?? 0.07))
      : Math.max(0.12, startPoint.width * (bs.spacing ?? 0.08));
  }

  public start(
    draftCanvas: HTMLCanvasElement | undefined,
    getDraftCanvas?: () => HTMLCanvasElement | undefined
  ): void {
    if (this.disposed) return;
    if (getDraftCanvas) {
      this.bindAssetWatchers(getDraftCanvas);
    }

    const startPoint = this.points[0];
    const strokeColor = this.resolvePreviewColor();
    this.resetPipelineState(startPoint, strokeColor);

    if (!draftCanvas) return;
    const ctx = get2DContext(draftCanvas);
    if (!ctx) return;

    ctx.resetTransform();
    ctx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
    draftCanvas.style.opacity = String(this.resolvePreviewOpacity());

    const opts = this.buildPreviewRenderOptions();
    const useGpu = canUseWebGlForBrush(opts);
    this.gpuBatch.length = 0;

    drawBrushDot(ctx, startPoint, strokeColor, opts, useGpu ? this.gpuBatch : undefined);

    if (useGpu && this.gpuBatch.length > 0) {
      if (!flushGpuDabs(ctx, this.gpuBatch, strokeColor, opts)) {
        drawBrushDot(ctx, startPoint, strokeColor, opts);
      }
      this.gpuBatch.length = 0;
    }
  }

  public appendChunk(
    incomingPoints: Point[],
    draftCanvas: HTMLCanvasElement | undefined
  ): void {
    if (this.disposed || incomingPoints.length === 0) return;

    const ctx = draftCanvas ? get2DContext(draftCanvas) : null;
    const strokeColor = this.resolvePreviewColor();
    const opts = this.buildPreviewRenderOptions();
    const useGpu = canUseWebGlForBrush(opts);
    const bs = this.brushSettings;
    const scatterFactor = Math.max(0, bs.dynamics?.scatter ?? 0);
    const padExtra = Math.ceil((bs.size || 10) * (1.8 + scatterFactor * 2) + 24);

    this.gpuBatch.length = 0;
    const emittedSegments: CubicBezierSegment[] = [];
    const preRemainder = this.stampRemainderDist;
    const preDabCount = this.dabCounter.count;

    for (let i = 0; i < incomingPoints.length; i++) {
      const pt = incomingPoints[i];
      if (this.points.length > 0) {
        const prev = this.points[this.points.length - 1];
        this.strokeTotalDistance += Math.hypot(pt.x - prev.x, pt.y - prev.y);
      }
      if (this.points.length < MAX_PREVIEW_POINTS_BUFFER) {
        this.points.push(pt);
      }

      opts.currentStrokeDist = this.strokeTotalDistance;

      this.pipeline.pushStabilizedKnot(
        pt.x,
        pt.y,
        pt.pressure,
        pt.width,
        pt.tiltX ?? 0,
        pt.tiltY ?? 0,
        pt.twist ?? 0,
        pt.timestamp ?? 0,
        Boolean(pt.isCorner),
        padExtra,
        (seg) => {
          if (!ctx) return;
          if (useGpu) {
            emittedSegments.push({
              p0: { ...seg.p0 },
              c1: { ...seg.c1 },
              c2: { ...seg.c2 },
              p3: { ...seg.p3 },
            });
          }
          this.stampRemainderDist = drawBrushCubicBezierSegment(
            ctx,
            seg.p0,
            seg.c1,
            seg.c2,
            seg.p3,
            strokeColor,
            opts,
            this.stampRemainderDist,
            this.dabCounter,
            useGpu ? this.gpuBatch : undefined
          );
        }
      );
    }

    if (ctx && useGpu && this.gpuBatch.length > 0) {
      if (!flushGpuDabs(ctx, this.gpuBatch, strokeColor, opts)) {
        // Fallback replay of failed GPU batch preserving exact dab counter & remainder
        this.stampRemainderDist = preRemainder;
        this.dabCounter.count = preDabCount;
        for (let i = 0; i < emittedSegments.length; i++) {
          const seg = emittedSegments[i];
          this.stampRemainderDist = drawBrushCubicBezierSegment(
            ctx,
            seg.p0,
            seg.c1,
            seg.c2,
            seg.p3,
            strokeColor,
            opts,
            this.stampRemainderDist,
            this.dabCounter
          );
        }
      }
      this.gpuBatch.length = 0;
    }
  }

  /**
   * Re-renders buffered live preview points through StrokePipeline + WebGL after a hash-synced
   * brush tip or texture asset finishes decoding mid-stroke.
   */
  public replayPreview(draftCanvas: HTMLCanvasElement): void {
    if (this.disposed || this.points.length === 0) return;
    const savedPoints = this.points.slice();
    this.points = [savedPoints[0]];
    this.start(draftCanvas);
    if (savedPoints.length > 1) {
      this.appendChunk(savedPoints.slice(1), draftCanvas);
    }
  }

  public dispose(draftCanvas: HTMLCanvasElement | undefined): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearAssetWatchers();
    this.pipeline.abortStroke();
    this.gpuBatch.length = 0;
    this.points.length = 0;

    if (draftCanvas) {
      const ctx = get2DContext(draftCanvas);
      if (ctx) {
        ctx.resetTransform();
        ctx.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
      }
      draftCanvas.style.opacity = '';
    }
  }
}
