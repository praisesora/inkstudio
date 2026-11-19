/**
 * Per-Document Tile Grid & Undo Session Store
 *
 * Isolates SparseTileGrid, Undo history, and UndoCacheManager per open document tab.
 * Enforces a shared RAM budget across all open documents, automatically offloading
 * inactive documents' tiles and undo deltas to scratch disk without clearing or
 * re-slicing tiles on tab switches.
 */

import { HistoryItem } from '../types/editor';
import {
  SparseTileGrid,
  IScratchDiskDriver,
  createDefaultScratchDiskDriver,
  globalTileGrid,
  releaseTemporaryCanvas,
} from './tileEngine';
import { UndoCacheManager, MAX_RAM_UNDO_STEPS } from './undoCache';

export interface DocumentStoreOptions {
  totalTileBudgetMb?: number;
  sharedUndoRamStepsBudget?: number;
  scratchDiskDriver?: IScratchDiskDriver;
  offloadInactiveUndoOnSwitch?: boolean;
}

export class TileGridSession {
  public readonly documentId: string;
  public readonly tileGrid: SparseTileGrid;
  public readonly undoCache: UndoCacheManager;
  public history: HistoryItem[] = [];
  public historyIndex: number = -1;
  public readonly layerCanvases: Map<string, HTMLCanvasElement> = new Map();
  public readonly layerSourceCanvases: Map<string, HTMLCanvasElement> = new Map();
  public lastAccessedAt: number;
  public isActive: boolean = false;
  private disposed: boolean = false;

  constructor(
    documentId: string,
    options?: {
      budgetMb?: number;
      driver?: IScratchDiskDriver;
      onMemoryChanged?: () => void;
    }
  ) {
    this.documentId = documentId;
    this.lastAccessedAt = Date.now();
    this.tileGrid = new SparseTileGrid({
      sessionId: documentId,
      budgetMb: options?.budgetMb ?? 1024,
      driver: options?.driver,
      onMemoryChanged: options?.onMemoryChanged,
    });
    this.undoCache = new UndoCacheManager(documentId);
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public touch(): void {
    this.lastAccessedAt = Date.now();
  }

  /**
   * Releases any transiently materialized display canvases (safe because SparseTileGrid
   * is the authoritative pixel store; source canvases for non-destructive effects are preserved).
   */
  public releaseTransientDisplayCanvases(): number {
    let released = 0;
    for (const [layerId, canvas] of Array.from(this.layerCanvases.entries())) {
      if (this.layerSourceCanvases.has(layerId)) continue;
      releaseTemporaryCanvas(canvas);
      this.layerCanvases.delete(layerId);
      released++;
    }
    return released;
  }

  /**
   * Releases a single layer's tiles and any temporary/source canvases.
   */
  public clearLayerResources(layerId: string): void {
    const display = this.layerCanvases.get(layerId);
    if (display) {
      releaseTemporaryCanvas(display);
      this.layerCanvases.delete(layerId);
    }
    const source = this.layerSourceCanvases.get(layerId);
    if (source) {
      releaseTemporaryCanvas(source);
      this.layerSourceCanvases.delete(layerId);
    }
    this.tileGrid.clearLayer(layerId);
  }

  /**
   * Resets history & clears this document's undo cache without affecting other documents.
   */
  public async resetHistory(): Promise<void> {
    this.history = [];
    this.historyIndex = -1;
    await this.undoCache.clearCache();
  }

  /**
   * Permanently disposes all tiles, scratch disk state, undo cache, and canvases for this tab.
   */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.isActive = false;

    for (const canvas of this.layerCanvases.values()) {
      releaseTemporaryCanvas(canvas);
    }
    this.layerCanvases.clear();

    for (const canvas of this.layerSourceCanvases.values()) {
      releaseTemporaryCanvas(canvas);
    }
    this.layerSourceCanvases.clear();

    this.history = [];
    this.historyIndex = -1;

    this.tileGrid.clearAll();
    const mm = this.tileGrid.getMemoryManager();
    await Promise.all([
      mm ? mm.clear().catch(() => {}) : Promise.resolve(),
      this.undoCache.clearCache().catch(() => {}),
    ]);
  }
}

export class DocumentStore {
  private sessions: Map<string, TileGridSession> = new Map();
  private activeDocumentId: string | null = null;
  private totalTileBudgetBytes: number;
  private sharedUndoRamStepsBudget: number;
  private driver: IScratchDiskDriver;
  private offloadInactiveUndoOnSwitch: boolean;
  private tileBudgetPromise: Promise<void> | null = null;
  private needsAnotherTileBudgetPass: boolean = false;

  constructor(options?: DocumentStoreOptions) {
    const budgetMb = options?.totalTileBudgetMb ?? 1024;
    this.totalTileBudgetBytes = Math.max(1, budgetMb) * 1024 * 1024;
    this.sharedUndoRamStepsBudget = Math.max(1, options?.sharedUndoRamStepsBudget ?? MAX_RAM_UNDO_STEPS);
    this.driver = options?.scratchDiskDriver || createDefaultScratchDiskDriver();
    this.offloadInactiveUndoOnSwitch = options?.offloadInactiveUndoOnSwitch ?? true;
  }

  public getOrCreateSession(documentId: string): TileGridSession {
    let session = this.sessions.get(documentId);
    if (!session || session.isDisposed()) {
      session = new TileGridSession(documentId, {
        budgetMb: Math.max(1, Math.round(this.totalTileBudgetBytes / (1024 * 1024))),
        driver: this.driver,
        onMemoryChanged: () => {
          void this.enforceSharedTileBudget();
        },
      });
      this.sessions.set(documentId, session);
    }
    session.touch();
    return session;
  }

  public getSession(documentId: string | null | undefined): TileGridSession | null {
    if (!documentId) return null;
    const session = this.sessions.get(documentId);
    return session && !session.isDisposed() ? session : null;
  }

  public hasSession(documentId: string): boolean {
    const s = this.sessions.get(documentId);
    return Boolean(s && !s.isDisposed());
  }

  public getActiveDocumentId(): string | null {
    return this.activeDocumentId;
  }

  public getActiveSession(): TileGridSession | null {
    return this.getSession(this.activeDocumentId);
  }

  public getActiveTileGrid(): SparseTileGrid {
    return this.getActiveSession()?.tileGrid ?? globalTileGrid;
  }

  public getAllSessions(): TileGridSession[] {
    return Array.from(this.sessions.values()).filter((s) => !s.isDisposed());
  }

  /**
   * Switches the active document session in O(1) without clearing or re-ingesting tiles.
   * Schedules background offloading for inactive documents under shared RAM budgets.
   */
  public setActiveDocument(documentId: string | null): TileGridSession | null {
    const prevId = this.activeDocumentId;
    if (prevId && prevId !== documentId) {
      const prevSession = this.sessions.get(prevId);
      if (prevSession && !prevSession.isDisposed()) {
        prevSession.isActive = false;
        prevSession.touch();
        prevSession.releaseTransientDisplayCanvases();
        if (this.offloadInactiveUndoOnSwitch) {
          void prevSession.undoCache.offloadAllToDisk(prevSession.history).catch(() => {});
        }
      }
    }

    this.activeDocumentId = documentId;
    if (!documentId) {
      return null;
    }

    const nextSession = this.getOrCreateSession(documentId);
    nextSession.isActive = true;
    nextSession.touch();

    void this.enforceSharedTileBudget();
    void this.enforceSharedUndoBudget();

    return nextSession;
  }

  /**
   * Updates the shared tile RAM budget across all open documents.
   */
  public setTileBudgetMb(mb: number): void {
    const clampedMb = Math.max(1, mb);
    this.totalTileBudgetBytes = clampedMb * 1024 * 1024;
    for (const session of this.sessions.values()) {
      session.tileGrid.getMemoryManager()?.setBudgetMb(clampedMb);
    }
    void this.enforceSharedTileBudget();
  }

  public getTileBudgetBytes(): number {
    return this.totalTileBudgetBytes;
  }

  public setSharedUndoRamStepsBudget(steps: number): void {
    this.sharedUndoRamStepsBudget = Math.max(1, steps);
    void this.enforceSharedUndoBudget();
  }

  public getTotalActiveTileBytes(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      if (session.isDisposed()) continue;
      total += session.tileGrid.getMemoryManager()?.getActiveMemoryBytes() ?? 0;
    }
    return total;
  }

  public getTotalRamUndoSteps(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      if (session.isDisposed()) continue;
      total += session.undoCache.getRamStepCount();
    }
    return total;
  }

  /**
   * Registers an Undo step on a specific document and enforces the shared Undo RAM budget,
   * prioritizing offloading inactive documents first.
   */
  public async registerUndoStep(documentId: string, item: HistoryItem): Promise<void> {
    const session = this.getSession(documentId);
    if (!session) return;

    await session.undoCache.registerStep(item, session.history, this.sharedUndoRamStepsBudget);
    await this.enforceSharedUndoBudget();
  }

  /**
   * Enforces the shared Undo RAM budget across all open documents.
   * Inactive documents (oldest accessed first) are offloaded to scratch disk first.
   */
  public async enforceSharedUndoBudget(): Promise<void> {
    let totalRamSteps = this.getTotalRamUndoSteps();
    if (totalRamSteps <= this.sharedUndoRamStepsBudget) return;

    // 1. Offload inactive documents first (oldest accessed first)
    const inactive = this.getAllSessions()
      .filter((s) => !s.isActive && s.undoCache.getRamStepCount() > 0)
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

    for (const session of inactive) {
      if (totalRamSteps <= this.sharedUndoRamStepsBudget) break;
      const excess = totalRamSteps - this.sharedUndoRamStepsBudget;
      const offloaded = await session.undoCache.offloadAllToDisk(session.history, excess);
      totalRamSteps -= offloaded;
    }

    // 2. If still over budget, offload oldest steps from active document
    if (totalRamSteps > this.sharedUndoRamStepsBudget) {
      const active = this.getActiveSession();
      if (active) {
        const excess = totalRamSteps - this.sharedUndoRamStepsBudget;
        await active.undoCache.offloadAllToDisk(active.history, excess);
      }
    }
  }

  /**
   * Enforces the shared Tile RAM budget across all open documents.
   * Evicts tiles from inactive documents first (oldest accessed first) to scratch disk,
   * only touching the active document if total active RAM still exceeds budget.
   */
  public async enforceSharedTileBudget(): Promise<void> {
    if (this.tileBudgetPromise) {
      this.needsAnotherTileBudgetPass = true;
      return this.tileBudgetPromise;
    }

    if (this.getTotalActiveTileBytes() <= this.totalTileBudgetBytes) {
      return;
    }

    this.tileBudgetPromise = (async () => {
      try {
        while (this.getTotalActiveTileBytes() > this.totalTileBudgetBytes) {
          this.needsAnotherTileBudgetPass = false;
          const targetBytes = this.totalTileBudgetBytes * 0.9;
          let bytesToFree = this.getTotalActiveTileBytes() - targetBytes;
          let freedTotal = 0;

          // 1. Reclaim from inactive sessions first (LRU by lastAccessedAt)
          const inactive = this.getAllSessions()
            .filter((s) => !s.isActive)
            .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

          for (const session of inactive) {
            if (bytesToFree <= 0) break;
            const mm = session.tileGrid.getMemoryManager();
            if (!mm || mm.getActiveMemoryBytes() <= 0) continue;
            const freed = await mm.evictBytesToDisk(bytesToFree);
            freedTotal += freed;
            bytesToFree -= freed;
          }

          // 2. If still over budget, run active session's own frustum-aware eviction
          if (this.getTotalActiveTileBytes() > this.totalTileBudgetBytes) {
            const active = this.getActiveSession();
            const mm = active?.tileGrid.getMemoryManager();
            if (mm) {
              const before = mm.getActiveMemoryBytes();
              await mm.checkBudgetAndEvict();
              freedTotal += Math.max(0, before - mm.getActiveMemoryBytes());
            }
          }

          if (freedTotal <= 0 && !this.needsAnotherTileBudgetPass) {
            break;
          }
        }
      } finally {
        this.tileBudgetPromise = null;
        this.needsAnotherTileBudgetPass = false;
      }
    })();

    return this.tileBudgetPromise;
  }

  /**
   * Closes and permanently disposes a document session, cleaning up all tiles,
   * scratch disk files, undo cache, and temporary canvases.
   */
  public async closeSession(documentId: string): Promise<void> {
    const session = this.sessions.get(documentId);
    if (!session) return;
    this.sessions.delete(documentId);
    if (this.activeDocumentId === documentId) {
      this.activeDocumentId = null;
    }
    await session.dispose();
  }

  /**
   * Disposes all open sessions (useful for cleanup and test isolation).
   */
  public async clearAllSessions(): Promise<void> {
    const all = Array.from(this.sessions.values());
    this.sessions.clear();
    this.activeDocumentId = null;
    await Promise.all(all.map((s) => s.dispose()));
  }
}

export const documentStore = new DocumentStore();
