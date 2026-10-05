/**
 * LRU Tile-Delta Undo/Redo Disk Caching Engine
 *
 * Designed for 600 DPI professional manga documents (4961 x 7016 px, 70MP double spreads).
 * Instead of keeping dozens of multi-megabyte ImageData frames in V8 heap memory,
 * this engine keeps only the most recent steps in RAM, seamlessly offloading
 * older tile-delta states to high-speed temporary disk storage via Tauri v2 Rust IPC.
 */

import { TileDelta, HistoryItem } from '../types/editor';
import { serializeTileDeltas, deserializeTileDeltas } from './tileEngine';

export const MAX_RAM_UNDO_STEPS = 15;

export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as any).__TAURI_INTERNALS__ ||
    (window as any).__TAURI__ ||
    (window as any).isTauri
  );
}

export class UndoCacheManager {
  private sessionId: string;
  private ramItems: Set<string> = new Set();
  private diskCachedIds: Set<string> = new Set();

  constructor(sessionId?: string) {
    this.sessionId = sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Register a history item and enforce the in-memory LRU budget.
   */
  public async registerStep(item: HistoryItem, allHistory: HistoryItem[]): Promise<void> {
    if (!item.tileDeltas || item.tileDeltas.length === 0) return;

    this.ramItems.add(item.id);

    // If RAM budget is exceeded, offload the oldest in-memory steps to disk
    if (this.ramItems.size > MAX_RAM_UNDO_STEPS) {
      // Find oldest items in allHistory that are still in ramItems
      for (const oldItem of allHistory) {
        if (oldItem.id !== item.id && this.ramItems.has(oldItem.id) && oldItem.tileDeltas) {
          await this.offloadToDisk(oldItem);
          this.ramItems.delete(oldItem.id);
          if (this.ramItems.size <= MAX_RAM_UNDO_STEPS) break;
        }
      }
    }
  }

  /**
   * Offload a single history item's tile deltas to disk via Tauri IPC.
   */
  public async offloadToDisk(item: HistoryItem): Promise<void> {
    if (!item.tileDeltas || item.tileDeltas.length === 0) return;

    if (isTauriEnvironment()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const serialized = serializeTileDeltas(item.tileDeltas);
        await invoke('save_undo_tile_cache', {
          sessionId: this.sessionId,
          stateId: item.id,
          data: Array.from(serialized),
        });
        this.diskCachedIds.add(item.id);
        // Free memory in RAM
        item.tileDeltas = undefined;
      } catch (err) {
        console.warn('[UndoCache] Failed to offload tile deltas to disk:', err);
      }
    }
  }

  /**
   * Retrieve tile deltas for a history item, restoring from disk if necessary.
   */
  public async resolveDeltas(item: HistoryItem): Promise<TileDelta[] | null> {
    if (item.tileDeltas && item.tileDeltas.length > 0) {
      return item.tileDeltas;
    }

    if (this.diskCachedIds.has(item.id) && isTauriEnvironment()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const rawData = await invoke<number[]>('load_undo_tile_cache', {
          sessionId: this.sessionId,
          stateId: item.id,
        });
        if (rawData && rawData.length > 0) {
          const u8 = new Uint8Array(rawData);
          const deltas = deserializeTileDeltas(u8);
          // Re-populate item
          item.tileDeltas = deltas;
          this.ramItems.add(item.id);
          return deltas;
        }
      } catch (err) {
        console.warn('[UndoCache] Failed to restore tile deltas from disk:', err);
      }
    }

    return null;
  }

  /**
   * Clear all disk cached states for this session.
   */
  public async clearCache(): Promise<void> {
    this.ramItems.clear();
    this.diskCachedIds.clear();
    if (isTauriEnvironment()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('clear_undo_tile_cache', { sessionId: this.sessionId });
      } catch (err) {
        console.warn('[UndoCache] Failed to clear disk cache:', err);
      }
    }
  }
}

// Global default undo cache manager instance
export const globalUndoCache = new UndoCacheManager();
