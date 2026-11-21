/**
 * Off-Main-Thread Pooled Compression Worker Client
 *
 * Moves heavy fflate deflate/zlib/inflate/unzlib operations (WAL checkpoints,
 * stroke deltas, undo cache offload) onto a reusable Web Worker with zero-copy
 * ArrayBuffer transfer so the UI thread never stalls on large canvases.
 */

import { deflateSync, inflateSync, zlibSync, unzlibSync } from 'fflate';
import type {
  CompressionOp,
  CompressionRequest,
  CompressionResponse,
} from '../workers/compression.worker';

export type CompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface AsyncCompressionOptions {
  level?: CompressionLevel;
  /** When true and input owns an exact ArrayBuffer, transfers ownership to avoid copying. */
  transfer?: boolean;
  /** Optional safety ceiling for decompression output size. */
  maxOutputBytes?: number;
}

interface PendingJob {
  resolve: (data: Uint8Array) => void;
  reject: (err: Error) => void;
}

let sharedWorker: Worker | null = null;
let workerDisabled = false;
let nextJobId = 1;
const pendingJobs = new Map<number, PendingJob>();

let yieldChannel: MessageChannel | null = null;
const yieldQueue: Array<() => void> = [];

/**
 * Yields control back to the event loop as a low-latency macrotask so pending
 * pointer/tap/paint events execute promptly without Windows 15.6ms setTimeout stalls.
 */
export function yieldToMain(): Promise<void> {
  if (typeof window !== 'undefined' && typeof MessageChannel !== 'undefined') {
    if (!yieldChannel) {
      yieldChannel = new MessageChannel();
      yieldChannel.port1.onmessage = () => {
        const next = yieldQueue.shift();
        if (next) next();
      };
    }
    return new Promise((resolve) => {
      yieldQueue.push(resolve);
      yieldChannel!.port2.postMessage(null);
    });
  }
  const g = globalThis as unknown as { setImmediate?: (cb: () => void) => void };
  if (typeof g.setImmediate === 'function') {
    return new Promise((resolve) => {
      g.setImmediate!(resolve);
    });
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function rejectAllPending(reason: Error): void {
  const entries = Array.from(pendingJobs.values());
  pendingJobs.clear();
  for (const job of entries) {
    job.reject(reason);
  }
}

function canUseCompressionWorker(): boolean {
  if (workerDisabled) return false;
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return false;
  return true;
}

function getOrCreateWorker(): Worker | null {
  if (!canUseCompressionWorker()) return null;
  if (sharedWorker) return sharedWorker;

  try {
    const worker = new Worker(
      new URL('../workers/compression.worker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (event: MessageEvent<CompressionResponse>) => {
      const msg = event.data;
      const pending = pendingJobs.get(msg.id);
      if (!pending) return;
      pendingJobs.delete(msg.id);
      if (msg.ok && msg.data) {
        pending.resolve(msg.data);
      } else {
        pending.reject(new Error(msg.error || 'Compression worker failed'));
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      const err = new Error(event.message || 'Compression worker crashed');
      if (sharedWorker === worker) {
        sharedWorker = null;
      }
      worker.terminate();
      workerDisabled = true;
      rejectAllPending(err);
    };

    sharedWorker = worker;
    return worker;
  } catch {
    workerDisabled = true;
    return null;
  }
}

function runFallbackSync(
  op: CompressionOp,
  data: Uint8Array,
  options?: AsyncCompressionOptions
): Uint8Array {
  let result: Uint8Array;
  if (op === 'deflate') {
    result = deflateSync(data, { level: options?.level ?? 1 });
  } else if (op === 'zlib') {
    result = zlibSync(data, { level: options?.level ?? 1 });
  } else if (op === 'inflate') {
    result = inflateSync(data);
  } else {
    result = unzlibSync(data);
  }
  if (options?.maxOutputBytes !== undefined && result.byteLength > options.maxOutputBytes) {
    throw new Error(`Decompressed payload exceeds safety ceiling (${options.maxOutputBytes} bytes)`);
  }
  return result;
}

function dispatchToWorker(
  op: CompressionOp,
  data: Uint8Array,
  options?: AsyncCompressionOptions
): Promise<Uint8Array> {
  const worker = getOrCreateWorker();
  if (!worker) {
    return Promise.resolve().then(() => runFallbackSync(op, data, options));
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    const id = nextJobId++;
    pendingJobs.set(id, { resolve, reject });

    const isExactArrayBuffer =
      data.buffer instanceof ArrayBuffer &&
      data.byteOffset === 0 &&
      data.byteLength === data.buffer.byteLength;

    let payload: Uint8Array;
    let transferables: Transferable[] | undefined;

    if (options?.transfer) {
      payload = isExactArrayBuffer ? data : data.slice();
      transferables = [payload.buffer as ArrayBuffer];
    } else {
      // Clone only if we cannot transfer caller's buffer without neutering it
      payload = data.slice();
      transferables = [payload.buffer as ArrayBuffer];
    }

    const request: CompressionRequest = {
      id,
      op,
      data: payload,
      level: options?.level,
      maxOutputBytes: options?.maxOutputBytes,
    };

    try {
      worker.postMessage(request, transferables);
    } catch {
      pendingJobs.delete(id);
      if (sharedWorker === worker) {
        sharedWorker = null;
      }
      try {
        worker.terminate();
      } catch {
        // Ignore terminate errors
      }
      workerDisabled = true;
      try {
        resolve(runFallbackSync(op, data, options));
      } catch (fallbackErr) {
        reject(fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)));
      }
    }
  });
}

export function deflateAsync(
  data: Uint8Array,
  options?: AsyncCompressionOptions
): Promise<Uint8Array> {
  return dispatchToWorker('deflate', data, options);
}

export function inflateAsync(
  data: Uint8Array,
  options?: AsyncCompressionOptions
): Promise<Uint8Array> {
  return dispatchToWorker('inflate', data, options);
}

export function zlibAsync(
  data: Uint8Array,
  options?: AsyncCompressionOptions
): Promise<Uint8Array> {
  return dispatchToWorker('zlib', data, options);
}

export function unzlibAsync(
  data: Uint8Array,
  options?: AsyncCompressionOptions
): Promise<Uint8Array> {
  return dispatchToWorker('unzlib', data, options);
}

export function disposeCompressionWorker(): void {
  if (sharedWorker) {
    sharedWorker.terminate();
    sharedWorker = null;
  }
  rejectAllPending(new Error('Compression worker disposed'));
  workerDisabled = false;
}
