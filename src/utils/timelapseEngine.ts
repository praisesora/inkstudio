/**
 * Time-lapse Recording & Export Engine
 *
 * Captures lightweight throttled WebP/JPEG keyframes after stroke/action commits using
 * SparseTileGrid LOD mipmaps (zero GPU readPixels stall), offloads to Tauri scratch disk
 * when available or enforces bounded RAM thinning in browser, and exports 15s / 30s / 60s / Full
 * videos via MediaRecorder or native FFmpeg (when installed in Tauri).
 */

import { CanvasDimensions, LayerItem } from '../types/editor';
import { ViewportCompositor } from './compositor';
import { SparseTileGrid } from './tileEngine';
import { canvasToBlob } from './saveManager';

export type TimelapseDurationPreset = '15s' | '30s' | '60s' | 'full';
export type TimelapseAspectRatio = 'original' | '16:9' | '9:16' | '1:1';
export type TimelapseResolution = '720p' | '1080p';

export interface TimelapseFrameEntry {
  id: string;
  index: number;
  timestamp: number;
  width: number;
  height: number;
  mimeType: 'image/webp' | 'image/jpeg';
  bytes: number;
  offloadedToDisk: boolean;
  blob?: Blob;
}

export interface TimelapseSessionStats {
  documentId: string;
  enabled: boolean;
  frameCount: number;
  memoryBytes: number;
  diskFrames: number;
}

export interface TimelapseExportOptions {
  duration: TimelapseDurationPreset;
  aspectRatio: TimelapseAspectRatio;
  resolution: TimelapseResolution;
  fps?: number;
  backgroundColor?: string;
  preferFfmpeg?: boolean;
}

export interface TimelapseExportResult {
  blob: Blob;
  mimeType: string;
  extension: string;
  frameCount: number;
  durationSec: number;
}

const DEFAULT_MIN_INTERVAL_MS = 350;
const DEFAULT_MAX_CAPTURE_DIM = 1080;
const DEFAULT_MAX_RAM_BYTES = 48 * 1024 * 1024; // 48 MB RAM cap per document

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/**
 * Computes even-dimension output video size for the chosen aspect ratio & resolution preset.
 */
export function computeTimelapseDimensions(
  srcWidth: number,
  srcHeight: number,
  aspectRatio: TimelapseAspectRatio,
  resolution: TimelapseResolution
): { width: number; height: number } {
  const targetShort = resolution === '1080p' ? 1080 : 720;
  const toEven = (n: number) => Math.max(2, Math.round(n / 2) * 2);

  if (aspectRatio === '16:9') {
    const h = targetShort;
    const w = toEven((h * 16) / 9);
    return { width: w, height: toEven(h) };
  }
  if (aspectRatio === '9:16') {
    const w = targetShort;
    const h = toEven((w * 16) / 9);
    return { width: toEven(w), height: h };
  }
  if (aspectRatio === '1:1') {
    const s = toEven(targetShort);
    return { width: s, height: s };
  }

  // Original aspect ratio fitted inside targetShort on the shorter/bounded side
  const safeW = Math.max(1, srcWidth);
  const safeH = Math.max(1, srcHeight);
  const maxDim = resolution === '1080p' ? 1920 : 1280;
  const scale = Math.min(1, maxDim / Math.max(safeW, safeH));
  return {
    width: toEven(safeW * scale),
    height: toEven(safeH * scale),
  };
}

/**
 * Maps captured frames onto output timeline frame indices for the selected duration preset.
 */
export function sampleTimelapseFrameIndices(
  totalCapturedFrames: number,
  duration: TimelapseDurationPreset,
  fps = 30
): number[] {
  if (totalCapturedFrames <= 0) return [];
  if (totalCapturedFrames === 1) return [0];

  const safeFps = Math.max(1, Math.min(60, fps));
  if (duration === 'full') {
    // Play each captured frame smoothly (at ~10-15 steps/sec -> 2 video frames per capture if short)
    const out: number[] = [];
    const repeat = totalCapturedFrames < safeFps * 5 ? 2 : 1;
    for (let i = 0; i < totalCapturedFrames; i++) {
      for (let r = 0; r < repeat; r++) out.push(i);
    }
    return out;
  }

  const seconds = duration === '15s' ? 15 : duration === '30s' ? 30 : 60;
  const targetOutFrames = Math.max(1, Math.round(seconds * safeFps));
  const indices: number[] = [];
  for (let i = 0; i < targetOutFrames; i++) {
    const ratio = targetOutFrames === 1 ? 1 : i / (targetOutFrames - 1);
    const srcIdx = Math.min(
      totalCapturedFrames - 1,
      Math.floor(ratio * totalCapturedFrames)
    );
    indices.push(srcIdx);
  }
  return indices;
}

interface InternalSession {
  documentId: string;
  enabled: boolean;
  frames: TimelapseFrameEntry[];
  nextIndex: number;
  lastCaptureAt: number;
  pendingCapture: boolean;
  memoryBytes: number;
}

export class TimelapseRecorderManager {
  private sessions = new Map<string, InternalSession>();
  private captureCanvas: HTMLCanvasElement | null = null;
  private listeners = new Set<() => void>();
  private minIntervalMs: number;
  private maxCaptureDim: number;
  private maxRamBytes: number;

  constructor(options?: {
    minIntervalMs?: number;
    maxCaptureDim?: number;
    maxRamBytes?: number;
  }) {
    this.minIntervalMs = options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxCaptureDim = options?.maxCaptureDim ?? DEFAULT_MAX_CAPTURE_DIM;
    this.maxRamBytes = options?.maxRamBytes ?? DEFAULT_MAX_RAM_BYTES;
  }

  private getOrCreate(documentId: string): InternalSession {
    let sess = this.sessions.get(documentId);
    if (!sess) {
      sess = {
        documentId,
        enabled: false,
        frames: [],
        nextIndex: 0,
        lastCaptureAt: 0,
        pendingCapture: false,
        memoryBytes: 0,
      };
      this.sessions.set(documentId, sess);
    }
    return sess;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  public isRecording(documentId: string | null): boolean {
    if (!documentId) return false;
    return this.sessions.get(documentId)?.enabled ?? false;
  }

  public setRecording(documentId: string, enabled: boolean): void {
    const sess = this.getOrCreate(documentId);
    if (sess.enabled === enabled) return;
    sess.enabled = enabled;
    this.notify();
  }

  public toggleRecording(documentId: string): boolean {
    const sess = this.getOrCreate(documentId);
    sess.enabled = !sess.enabled;
    this.notify();
    return sess.enabled;
  }

  public getStats(documentId: string | null): TimelapseSessionStats {
    if (!documentId) {
      return {
        documentId: '',
        enabled: false,
        frameCount: 0,
        memoryBytes: 0,
        diskFrames: 0,
      };
    }
    const sess = this.sessions.get(documentId);
    if (!sess) {
      return {
        documentId,
        enabled: false,
        frameCount: 0,
        memoryBytes: 0,
        diskFrames: 0,
      };
    }
    const diskFrames = sess.frames.filter((f) => f.offloadedToDisk).length;
    return {
      documentId,
      enabled: sess.enabled,
      frameCount: sess.frames.length,
      memoryBytes: sess.memoryBytes,
      diskFrames,
    };
  }

  public getFrames(documentId: string): TimelapseFrameEntry[] {
    return this.sessions.get(documentId)?.frames ?? [];
  }

  public async clearSession(documentId: string): Promise<void> {
    const sess = this.sessions.get(documentId);
    if (sess) {
      sess.frames = [];
      sess.nextIndex = 0;
      sess.memoryBytes = 0;
      sess.lastCaptureAt = 0;
    }
    if (isTauriRuntime()) {
      await invokeTauri('timelapse_clear', { sessionId: documentId }).catch(() => {});
    }
    this.notify();
  }

  /**
   * Captures a throttled low/medium-res WebP/JPEG snapshot of the composited document.
   */
  public async captureKeyframe(
    documentId: string,
    layers: LayerItem[],
    dimensions: CanvasDimensions,
    tileGrid: SparseTileGrid,
    force = false
  ): Promise<boolean> {
    const sess = this.sessions.get(documentId);
    if (!sess || !sess.enabled) return false;
    if (typeof document === 'undefined' || dimensions.width <= 0 || dimensions.height <= 0) {
      return false;
    }

    const now = Date.now();
    if (!force && (sess.pendingCapture || now - sess.lastCaptureAt < this.minIntervalMs)) {
      return false;
    }

    sess.pendingCapture = true;
    sess.lastCaptureAt = now;

    try {
      const scale = Math.min(
        1,
        this.maxCaptureDim / Math.max(dimensions.width, dimensions.height)
      );
      const outW = Math.max(2, Math.round((dimensions.width * scale) / 2) * 2);
      const outH = Math.max(2, Math.round((dimensions.height * scale) / 2) * 2);

      if (!this.captureCanvas) {
        this.captureCanvas = document.createElement('canvas');
      }
      this.captureCanvas.width = outW;
      this.captureCanvas.height = outH;

      ViewportCompositor.renderLowResPreview(
        this.captureCanvas,
        layers,
        dimensions,
        tileGrid,
        { showCheckerboard: false }
      );

      let mimeType: 'image/webp' | 'image/jpeg' = 'image/webp';
      let blob: Blob;
      try {
        blob = await canvasToBlob(this.captureCanvas, 'image/webp', 0.82);
        if (blob.type !== 'image/webp') {
          mimeType = 'image/jpeg';
        }
      } catch {
        mimeType = 'image/jpeg';
        blob = await canvasToBlob(this.captureCanvas, 'image/jpeg', 0.82);
      }

      const idx = sess.nextIndex++;
      const entry: TimelapseFrameEntry = {
        id: `tl-${documentId}-${idx}`,
        index: idx,
        timestamp: now,
        width: outW,
        height: outH,
        mimeType,
        bytes: blob.size,
        offloadedToDisk: false,
        blob,
      };

      // Offload to Tauri scratch disk when available to keep RAM usage near zero
      if (isTauriRuntime()) {
        try {
          const buf = new Uint8Array(await blob.arrayBuffer());
          await invokeTauri('timelapse_write_frame', {
            sessionId: documentId,
            frameIndex: idx,
            ext: mimeType === 'image/webp' ? 'webp' : 'jpg',
            data: Array.from(buf),
          });
          entry.offloadedToDisk = true;
          entry.blob = undefined;
        } catch {
          sess.memoryBytes += entry.bytes;
        }
      } else {
        sess.memoryBytes += entry.bytes;
      }

      sess.frames.push(entry);

      // Browser memory throttling: thin alternating middle frames if RAM cap exceeded
      if (!isTauriRuntime() && sess.memoryBytes > this.maxRamBytes && sess.frames.length > 8) {
        const thinned: TimelapseFrameEntry[] = [];
        let bytes = 0;
        for (let i = 0; i < sess.frames.length; i++) {
          const f = sess.frames[i];
          const keep = i === 0 || i === sess.frames.length - 1 || i % 2 === 0;
          if (keep) {
            thinned.push(f);
            bytes += f.offloadedToDisk ? 0 : f.bytes;
          }
        }
        sess.frames = thinned;
        sess.memoryBytes = bytes;
      }

      this.notify();
      return true;
    } finally {
      sess.pendingCapture = false;
    }
  }

  /**
   * Resolves a frame entry into a Blob (reading back from Tauri scratch disk if offloaded).
   */
  public async loadFrameBlob(
    documentId: string,
    frame: TimelapseFrameEntry
  ): Promise<Blob | null> {
    if (frame.blob) return frame.blob;
    if (frame.offloadedToDisk && isTauriRuntime()) {
      try {
        const bytes = await invokeTauri<number[]>('timelapse_read_frame', {
          sessionId: documentId,
          frameIndex: frame.index,
          ext: frame.mimeType === 'image/webp' ? 'webp' : 'jpg',
        });
        return new Blob([new Uint8Array(bytes)], { type: frame.mimeType });
      } catch {
        return null;
      }
    }
    return null;
  }

  public async checkFfmpegAvailable(): Promise<boolean> {
    if (!isTauriRuntime()) return false;
    try {
      return await invokeTauri<boolean>('timelapse_check_ffmpeg', {});
    } catch {
      return false;
    }
  }

  /**
   * Renders captured keyframes into a downloadable WebM or MP4 video.
   */
  public async exportVideo(
    documentId: string,
    options: TimelapseExportOptions,
    onProgress?: (progress: number) => void
  ): Promise<TimelapseExportResult> {
    const sess = this.sessions.get(documentId);
    if (!sess || sess.frames.length === 0) {
      throw new Error('No time-lapse frames recorded for this document.');
    }

    const fps = options.fps ?? 30;
    const firstFrame = sess.frames[0];
    const targetDims = computeTimelapseDimensions(
      firstFrame.width,
      firstFrame.height,
      options.aspectRatio,
      options.resolution
    );
    const sampledIndices = sampleTimelapseFrameIndices(
      sess.frames.length,
      options.duration,
      fps
    );
    const bgColor = options.backgroundColor || '#ffffff';

    // Try native FFmpeg export in Tauri when requested and frames are on disk
    if (
      options.preferFfmpeg &&
      isTauriRuntime() &&
      sess.frames.every((f) => f.offloadedToDisk)
    ) {
      const hasFfmpeg = await this.checkFfmpegAvailable();
      if (hasFfmpeg) {
        onProgress?.(0.2);
        const mp4Bytes = await invokeTauri<number[]>('timelapse_export_ffmpeg', {
          sessionId: documentId,
          frameIndices: sampledIndices.map((idx) => sess.frames[idx].index),
          ext: firstFrame.mimeType === 'image/webp' ? 'webp' : 'jpg',
          fps,
          width: targetDims.width,
          height: targetDims.height,
        });
        onProgress?.(1);
        return {
          blob: new Blob([new Uint8Array(mp4Bytes)], { type: 'video/mp4' }),
          mimeType: 'video/mp4',
          extension: '.mp4',
          frameCount: sampledIndices.length,
          durationSec: sampledIndices.length / fps,
        };
      }
    }

    // Browser / WebView MediaRecorder video pipeline
    if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined') {
      throw new Error('Video recording is not supported in this environment.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetDims.width;
    canvas.height = targetDims.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create 2D context for time-lapse export.');

    const candidateMimes = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];
    const mimeType =
      candidateMimes.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    const extension = mimeType.includes('mp4') ? '.mp4' : '.webm';

    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: options.resolution === '1080p' ? 6_000_000 : 3_500_000,
    });

    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };

    const stoppedPromise = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
      recorder.onerror = () => reject(new Error('MediaRecorder encoding failed.'));
    });

    // Cache decoded ImageBitmaps by source frame index to avoid redundant decodes on repeated frames
    const imageCache = new Map<number, HTMLImageElement>();
    const loadImage = async (srcIdx: number): Promise<HTMLImageElement | null> => {
      const cached = imageCache.get(srcIdx);
      if (cached) return cached;
      const frame = sess.frames[srcIdx];
      if (!frame) return null;
      const blob = await this.loadFrameBlob(documentId, frame);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      const img = await new Promise<HTMLImageElement | null>((resolve) => {
        const el = new Image();
        el.onload = () => {
          URL.revokeObjectURL(url);
          resolve(el);
        };
        el.onerror = () => {
          URL.revokeObjectURL(url);
          resolve(null);
        };
        el.src = url;
      });
      if (img) {
        if (imageCache.size > 12) {
          const firstKey = imageCache.keys().next().value;
          if (firstKey !== undefined) imageCache.delete(firstKey);
        }
        imageCache.set(srcIdx, img);
      }
      return img;
    };

    recorder.start();
    const frameIntervalMs = Math.max(16, Math.round(1000 / fps));

    for (let i = 0; i < sampledIndices.length; i++) {
      const srcIdx = sampledIndices[i];
      const img = await loadImage(srcIdx);

      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, targetDims.width, targetDims.height);

      if (img) {
        const scale = Math.min(
          targetDims.width / Math.max(1, img.naturalWidth || img.width),
          targetDims.height / Math.max(1, img.naturalHeight || img.height)
        );
        const drawW = (img.naturalWidth || img.width) * scale;
        const drawH = (img.naturalHeight || img.height) * scale;
        const dx = (targetDims.width - drawW) * 0.5;
        const dy = (targetDims.height - drawH) * 0.5;
        ctx.drawImage(img, dx, dy, drawW, drawH);
      }

      onProgress?.((i + 1) / sampledIndices.length);
      await new Promise((r) => setTimeout(r, frameIntervalMs));
    }

    recorder.stop();
    const blob = await stoppedPromise;
    stream.getTracks().forEach((t) => t.stop());

    return {
      blob,
      mimeType,
      extension,
      frameCount: sampledIndices.length,
      durationSec: sampledIndices.length / fps,
    };
  }
}

export const globalTimelapseManager = new TimelapseRecorderManager();
