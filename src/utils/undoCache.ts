/**
 * LRU Tile-Delta Undo/Redo Disk Caching Engine
 *
 * Designed for 600 DPI professional manga documents (4961 x 7016 px, 70MP double spreads).
 * Keeps only the most recent steps in RAM, seamlessly offloading older tile-delta states
 * to temporary disk storage via Tauri v2 Rust IPC or zlib-compressed RAM buffers.
 */

import { zlibSync, unzlibSync } from 'fflate';
import { TileDelta, HistoryItem } from '../types/editor';
import { serializeTileDeltas, serializeTileDeltasAsync, deserializeTileDeltas } from './tileEngine';
import { zlibAsync, unzlibAsync, yieldToMain } from './asyncCompression';

export const MAX_RAM_UNDO_STEPS = 15;
const MAX_DECOMPRESSED_UNDO_BYTES = 128 * 1024 * 1024;

export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as any).__TAURI_INTERNALS__ ||
    (window as any).__TAURI__ ||
    (window as any).isTauri
  );
}

/**
 * Compresses serialized tile deltas using fast level-1 zlib compression.
 */
export function compressTileDeltasPayload(deltas: TileDelta[]): Uint8Array {
  const serialized = serializeTileDeltas(deltas);
  return zlibSync(serialized, { level: 1 });
}

/**
 * Decompresses and deserializes tile deltas (supports both zlib-compressed and raw payloads).
 */
export function decompressTileDeltasPayload(payload: Uint8Array): TileDelta[] {
  if (payload.length >= 2 && payload[0] === 0x78) {
    try {
      const raw = unzlibSync(payload);
      if (raw.byteLength <= MAX_DECOMPRESSED_UNDO_BYTES) {
        return deserializeTileDeltas(raw);
      }
    } catch {
      // Fallback if byte 0 happened to be 0x78 in an uncompressed stream
    }
  }
  return deserializeTileDeltas(payload);
}

/**
 * Off-main-thread async variant of compressTileDeltasPayload (uses pooled Web Worker).
 */
export async function compressTileDeltasPayloadAsync(deltas: TileDelta[]): Promise<Uint8Array> {
  const serialized = await serializeTileDeltasAsync(deltas);
  return zlibAsync(serialized, { level: 1, transfer: true });
}

/**
 * Off-main-thread async variant of decompressTileDeltasPayload (uses pooled Web Worker).
 */
export async function decompressTileDeltasPayloadAsync(payload: Uint8Array): Promise<TileDelta[]> {
  if (payload.length >= 2 && payload[0] === 0x78) {
    try {
      const raw = await unzlibAsync(payload, { maxOutputBytes: MAX_DECOMPRESSED_UNDO_BYTES });
      if (raw.byteLength <= MAX_DECOMPRESSED_UNDO_BYTES) {
        return deserializeTileDeltas(raw);
      }
    } catch {
      // Fallback if byte 0 happened to be 0x78 in an uncompressed stream
    }
  }
  return deserializeTileDeltas(payload);
}

export class UndoCacheManager {
  private sessionId: string;
  private ramItems: Set<string> = new Set();
  private diskCachedIds: Set<string> = new Set();
  private compressedRamCache: Map<string, Uint8Array> = new Map();
  private inFlightOffloads: Map<string, Promise<void>> = new Map();
  private keepInRamIds: Set<string> = new Set();
  private invokePromise: Promise<typeof import('@tauri-apps/api/core').invoke> | null = null;

  private getInvoke(): Promise<typeof import('@tauri-apps/api/core').invoke> {
    if (!this.invokePromise) {
      this.invokePromise = import('@tauri-apps/api/core').then((m) => m.invoke);
    }
    return this.invokePromise;
  }

  constructor(sessionId?: string) {
    this.sessionId = sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getDocumentId(): string {
    return this.sessionId;
  }

  public getRamStepCount(): number {
    return this.ramItems.size;
  }

  public getDiskCachedCount(): number {
    return this.diskCachedIds.size;
  }

  public getCompressedRamCount(): number {
    return this.compressedRamCache.size;
  }

  public getCompressedRamBytes(): number {
    let total = 0;
    for (const buf of this.compressedRamCache.values()) {
      total += buf.byteLength;
    }
    return total;
  }

  public isOffloaded(itemId: string): boolean {
    return this.diskCachedIds.has(itemId) || this.compressedRamCache.has(itemId);
  }

  /**
   * Prunes orphaned history IDs evicted by redo branching or the 50-step cap.
   */
  private pruneOrphanedIds(allHistory: HistoryItem[]): void {
    const validIds = new Set<string>();
    for (let i = 0; i < allHistory.length; i++) {
      validIds.add(allHistory[i].id);
    }
    for (const id of Array.from(this.ramItems)) {
      if (!validIds.has(id)) this.ramItems.delete(id);
    }
    for (const id of Array.from(this.compressedRamCache.keys())) {
      if (!validIds.has(id)) this.compressedRamCache.delete(id);
    }
    for (const id of Array.from(this.diskCachedIds)) {
      if (!validIds.has(id)) this.diskCachedIds.delete(id);
    }
  }

  /**
   * Register a history item and enforce the in-memory LRU budget.
   */
  public async registerStep(
    item: HistoryItem,
    allHistory: HistoryItem[],
    maxRamSteps: number = MAX_RAM_UNDO_STEPS
  ): Promise<void> {
    this.pruneOrphanedIds(allHistory);
    if (!item.tileDeltas || item.tileDeltas.length === 0) return;

    this.ramItems.add(item.id);

    if (this.ramItems.size > maxRamSteps) {
      for (const oldItem of allHistory) {
        if (oldItem.id !== item.id && this.ramItems.has(oldItem.id) && oldItem.tileDeltas) {
          await this.offloadToDisk(oldItem);
          this.ramItems.delete(oldItem.id);
          if (this.ramItems.size <= maxRamSteps) break;
        }
      }
    }
  }

  /**
   * Offloads all in-RAM tile deltas for this document to scratch disk (or compressed cache).
   * Used when switching away from a document tab or when reclaiming shared RAM budget.
   */
  public async offloadAllToDisk(allHistory: HistoryItem[], maxCount?: number): Promise<number> {
    this.pruneOrphanedIds(allHistory);
    let offloaded = 0;
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let sliceStart = now();

    for (const item of allHistory) {
      if (maxCount !== undefined && offloaded >= maxCount) break;
      if (item.tileDeltas && item.tileDeltas.length > 0) {
        await this.offloadToDisk(item);
        this.ramItems.delete(item.id);
        offloaded++;
        if (now() - sliceStart >= 16) {
          await yieldToMain();
          sliceStart = now();
        }
      }
    }
    return offloaded;
  }

  /**
   * Offload a single history item's tile deltas to disk via Tauri IPC (with off-main-thread Worker zlib),
   * or to a compact zlib-compressed RAM buffer when running in a browser environment.
   */
  public async offloadToDisk(item: HistoryItem): Promise<void> {
    if (!item.tileDeltas || item.tileDeltas.length === 0) return;

    const existing = this.inFlightOffloads.get(item.id);
    if (existing) {
      return existing;
    }

    this.keepInRamIds.delete(item.id);
    const deltasToOffload = item.tileDeltas;

    const job = (async () => {
      const compressed = await compressTileDeltasPayloadAsync(deltasToOffload);

      if (isTauriEnvironment()) {
        try {
          const invoke = await this.getInvoke();
          const payload =
            compressed.byteOffset === 0 && compressed.byteLength === compressed.buffer.byteLength
              ? compressed
              : compressed.slice();
          await invoke('save_undo_tile_cache', payload, {
            headers: {
              'x-session-id': encodeURIComponent(this.sessionId),
              'x-state-id': encodeURIComponent(item.id),
            },
          });
          this.diskCachedIds.add(item.id);
          if (!this.keepInRamIds.delete(item.id)) {
            this.ramItems.delete(item.id);
            item.tileDeltas = undefined;
          }
          return;
        } catch (err) {
          console.warn('[UndoCache] Failed to offload tile deltas to disk, using compressed RAM fallback:', err);
        }
      }

      this.compressedRamCache.set(item.id, compressed);
      if (!this.keepInRamIds.delete(item.id)) {
        this.ramItems.delete(item.id);
        item.tileDeltas = undefined;
      }
    })().finally(() => {
      this.inFlightOffloads.delete(item.id);
    });

    this.inFlightOffloads.set(item.id, job);
    return job;
  }

  /**
   * Retrieve tile deltas for a history item, restoring from compressed RAM or disk if necessary.
   */
  public async resolveDeltas(item: HistoryItem): Promise<TileDelta[] | null> {
    if (item.tileDeltas && item.tileDeltas.length > 0) {
      if (this.inFlightOffloads.has(item.id)) {
        this.keepInRamIds.add(item.id);
      }
      return item.tileDeltas;
    }

    const inFlight = this.inFlightOffloads.get(item.id);
    if (inFlight) {
      await inFlight;
      if (item.tileDeltas && item.tileDeltas.length > 0) {
        return item.tileDeltas;
      }
    }

    const compressedInRam = this.compressedRamCache.get(item.id);
    if (compressedInRam) {
      const deltas = await decompressTileDeltasPayloadAsync(compressedInRam);
      this.compressedRamCache.delete(item.id);
      item.tileDeltas = deltas;
      this.ramItems.add(item.id);
      return deltas;
    }

    if (this.diskCachedIds.has(item.id) && isTauriEnvironment()) {
      try {
        const invoke = await this.getInvoke();
        const rawData = await invoke<ArrayBuffer | Uint8Array | number[]>('load_undo_tile_cache', undefined, {
          headers: {
            'x-session-id': encodeURIComponent(this.sessionId),
            'x-state-id': encodeURIComponent(item.id),
          },
        });
        if (rawData) {
          const u8 =
            rawData instanceof Uint8Array
              ? rawData
              : rawData instanceof ArrayBuffer
              ? new Uint8Array(rawData)
              : new Uint8Array(rawData);
          if (u8.length > 0) {
            const deltas = await decompressTileDeltasPayloadAsync(u8);
            item.tileDeltas = deltas;
            this.ramItems.add(item.id);
            return deltas;
          }
        }
      } catch (err) {
        console.warn('[UndoCache] Failed to restore tile deltas from disk:', err);
      }
    }

    return null;
  }

  /**
   * Clear all disk and compressed cached states for this session.
   */
  public async clearCache(): Promise<void> {
    this.ramItems.clear();
    this.diskCachedIds.clear();
    this.compressedRamCache.clear();
    this.inFlightOffloads.clear();
    this.keepInRamIds.clear();
    if (isTauriEnvironment()) {
      try {
        const invoke = await this.getInvoke();
        await invoke('clear_undo_tile_cache', { sessionId: this.sessionId });
      } catch (err) {
        console.warn('[UndoCache] Failed to clear disk cache:', err);
      }
    }
  }
}

export const globalUndoCache = new UndoCacheManager();
