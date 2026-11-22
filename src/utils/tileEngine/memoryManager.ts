/**
 * TileMemoryManager: LRU tile RAM budgeting, tiered eviction to SSD scratch disk,
 * and transparent async page-in.
 */

import { yieldToMain } from '../asyncCompression';
import {
  IScratchDiskDriver,
  TileWritePayload,
  createDefaultScratchDiskDriver,
} from './scratchDriver';
import {
  ISparseTileGridMemoryHost,
  TileBuffer,
  allocateTileVersion,
  getTileByteSize,
  getTileKey,
  pixelToTileCoord,
} from './types';

export interface TileMemoryManagerOptions {
  budgetMb?: number;
  driver?: IScratchDiskDriver;
  sessionId?: string;
  onMemoryChanged?: () => void;
}

export class TileMemoryManager {
  private sessionId: string;
  private budgetBytes: number;
  private activeBytes: number = 0;
  private grid: ISparseTileGridMemoryHost;
  private driver: IScratchDiskDriver;
  private viewportFrustum: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  private activeLayerId: string | null = null;
  private layerVisibility: Map<string, boolean> = new Map();
  private inFlightPageIns: Map<string, Promise<Uint8Array>> = new Map();
  private evictionPromise: Promise<void> | null = null;
  private needsAnotherEvictionPass: boolean = false;
  private onMemoryChanged?: () => void;

  constructor(grid: ISparseTileGridMemoryHost, options?: TileMemoryManagerOptions) {
    this.grid = grid;
    const mb = options?.budgetMb ?? 1024;
    this.budgetBytes = Math.max(1, mb) * 1024 * 1024;
    this.sessionId = options?.sessionId || `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.driver = options?.driver || createDefaultScratchDiskDriver();
    this.onMemoryChanged = options?.onMemoryChanged;
    void this.driver.init(this.sessionId);
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getDriver(): IScratchDiskDriver {
    return this.driver;
  }

  public setDriver(driver: IScratchDiskDriver): void {
    this.driver = driver;
    void this.driver.init(this.sessionId);
  }

  public setBudgetMb(mb: number): void {
    this.budgetBytes = Math.max(1, mb) * 1024 * 1024;
    void this.checkBudgetAndEvict();
  }

  public getBudgetBytes(): number {
    return this.budgetBytes;
  }

  public getActiveMemoryBytes(): number {
    return this.activeBytes;
  }

  public updateViewport(
    frustum: { minX: number; minY: number; maxX: number; maxY: number } | null,
    activeLayerId?: string | null,
    layerVisibility?: Map<string, boolean>
  ): void {
    this.viewportFrustum = frustum;
    if (activeLayerId !== undefined) this.activeLayerId = activeLayerId;
    if (layerVisibility !== undefined) this.layerVisibility = layerVisibility;
  }

  public notifyTileAllocated(tile: TileBuffer): void {
    if (tile.data !== null) {
      this.activeBytes += tile.data.byteLength;
      tile.lastAccessTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (tile.lod === 0) {
        if (this.onMemoryChanged) {
          this.onMemoryChanged();
        } else {
          void this.checkBudgetAndEvict();
        }
      }
    }
  }

  public notifyTileFreed(tile: TileBuffer): void {
    if (tile.data !== null) {
      this.activeBytes = Math.max(0, this.activeBytes - tile.data.byteLength);
    }
  }

  public touchTile(tile: TileBuffer): void {
    tile.lastAccessTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /**
   * Transparent Page-In: Asynchronously loads and decompresses a tile from scratch disk.
   */
  public async requestTileData(tile: TileBuffer): Promise<Uint8Array> {
    if (tile.data !== null) {
      this.touchTile(tile);
      return tile.data;
    }

    if (!tile.isPagedToDisk) {
      const size = getTileByteSize(tile.format);
      tile.data = new Uint8Array(size);
      this.notifyTileAllocated(tile);
      return tile.data;
    }

    const key = getTileKey(tile.layerId, tile.tileX, tile.tileY, tile.lod);
    let inFlight = this.inFlightPageIns.get(key);
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const raw = await this.driver.readTile(this.sessionId, tile.layerId, tile.tileX, tile.tileY);
          if (tile.data === null) {
            tile.data = raw;
            this.activeBytes += raw.byteLength;
          }
          tile.isPagedToDisk = true;
          tile.dirty = true;
          tile.version = allocateTileVersion();
          this.touchTile(tile);
          void this.checkBudgetAndEvict();
          this.grid.bumpLayerVersion(tile.layerId);
          this.grid.notifyChange();
          return tile.data;
        } finally {
          this.inFlightPageIns.delete(key);
        }
      })();
      this.inFlightPageIns.set(key, inFlight);
    }
    return inFlight;
  }

  /**
   * Evaluates memory consumption against the configured RAM budget.
   * Runs an LRU eviction pass prioritizing hidden layers, outside frustum, and inactive layers.
   */
  public async checkBudgetAndEvict(): Promise<void> {
    if (this.evictionPromise) {
      this.needsAnotherEvictionPass = true;
      return this.evictionPromise;
    }

    if (this.activeBytes <= this.budgetBytes) {
      return;
    }

    this.evictionPromise = (async () => {
      try {
        while (this.activeBytes > this.budgetBytes) {
          this.needsAnotherEvictionPass = false;
          const evictedCount = await this.performEvictionPass();
          if (evictedCount === 0) {
            break;
          }
          if (!this.needsAnotherEvictionPass && this.activeBytes <= this.budgetBytes) {
            break;
          }
        }
      } finally {
        this.evictionPromise = null;
        this.needsAnotherEvictionPass = false;
      }
    })();

    return this.evictionPromise;
  }

  private static readonly MAX_EVICT_BATCH_TILES = 32;

  private async performEvictionPass(): Promise<number> {
    // 1. First drop any in-memory LOD > 0 tiles (they can always be re-downsampled on demand with 0 IO)
    let droppedLodBytes = 0;
    for (const tile of this.grid.tilesIterable()) {
      if (tile.lod > 0 && tile.data !== null) {
        this.activeBytes -= tile.data.byteLength;
        droppedLodBytes += tile.data.byteLength;
        tile.data = null;
        tile.dirty = true;
        tile.version = allocateTileVersion();
      }
    }

    if (this.activeBytes <= this.budgetBytes) {
      return droppedLodBytes > 0 ? 1 : 0;
    }

    // 2. Gather candidate LOD 0 tiles with active data
    const candidates: TileBuffer[] = [];
    for (const tile of this.grid.tilesIterable()) {
      if (tile.lod === 0 && tile.data !== null) {
        candidates.push(tile);
      }
    }

    if (candidates.length === 0) {
      return droppedLodBytes > 0 ? 1 : 0;
    }

    const frustum = this.viewportFrustum;
    const activeLayer = this.activeLayerId;
    const layerVis = this.layerVisibility;

    // 3. Score candidate eviction priority
    const scored = candidates.map((tile) => {
      const isHidden = layerVis.get(tile.layerId) === false;
      const isInactiveLayer = activeLayer !== null && tile.layerId !== activeLayer;

      let frustumDist = 0;
      if (frustum) {
        const minTx = pixelToTileCoord(frustum.minX, 0);
        const maxTx = pixelToTileCoord(frustum.maxX, 0);
        const minTy = pixelToTileCoord(frustum.minY, 0);
        const maxTy = pixelToTileCoord(frustum.maxY, 0);

        const dx = tile.tileX < minTx ? minTx - tile.tileX : tile.tileX > maxTx ? tile.tileX - maxTx : 0;
        const dy = tile.tileY < minTy ? minTy - tile.tileY : tile.tileY > maxTy ? tile.tileY - maxTy : 0;
        frustumDist = dx * dx + dy * dy;
      }

      let tier = 2;
      if (isHidden) {
        tier = 0; // Tier 0: Hidden layer tiles (evict first)
      } else if (frustumDist > 0) {
        tier = 1; // Tier 1: Outside viewport frustum (farthest first)
      } else if (isInactiveLayer) {
        tier = 2; // Tier 2: Inside frustum, but inactive layer (LRU)
      } else {
        tier = 3; // Tier 3: Inside frustum and active drawing layer (protected, evicted last if needed)
      }

      return {
        tile,
        tier,
        frustumDist,
        lastAccess: tile.lastAccessTimestamp,
      };
    });

    scored.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.tier === 1 && a.frustumDist !== b.frustumDist) {
        return b.frustumDist - a.frustumDist; // Farthest distance outside frustum first
      }
      return a.lastAccess - b.lastAccess; // Oldest access timestamp first
    });

    // 4. Batch evict until within 90% of budget
    const targetBytes = this.budgetBytes * 0.9;
    const toEvict: TileBuffer[] = [];
    let projectedBytes = this.activeBytes;

    for (const item of scored) {
      if (projectedBytes <= targetBytes) break;
      toEvict.push(item.tile);
      projectedBytes -= item.tile.data?.byteLength || 0;
    }

    if (toEvict.length > 0) {
      try {
        await this.evictTiles(toEvict);
        return toEvict.length;
      } catch (err) {
        console.warn('[TileMemoryManager] Eviction write failed; aborting pass:', err);
        return 0;
      }
    }

    return droppedLodBytes > 0 ? 1 : 0;
  }

  public async evictTiles(tiles: TileBuffer[]): Promise<void> {
    if (tiles.length === 0) return;

    const batchSize = TileMemoryManager.MAX_EVICT_BATCH_TILES;
    for (let start = 0; start < tiles.length; start += batchSize) {
      const end = Math.min(tiles.length, start + batchSize);
      const payloads: TileWritePayload[] = [];
      const validTiles: TileBuffer[] = [];

      for (let i = start; i < end; i++) {
        const tile = tiles[i];
        if (tile.data !== null) {
          payloads.push({
            layerId: tile.layerId,
            tileX: tile.tileX,
            tileY: tile.tileY,
            data: tile.data,
          });
          validTiles.push(tile);
        }
      }

      if (payloads.length > 0) {
        await this.driver.writeTiles(this.sessionId, payloads);
        for (const tile of validTiles) {
          if (tile.data) {
            this.activeBytes = Math.max(0, this.activeBytes - tile.data.byteLength);
            tile.data = null;
            tile.isPagedToDisk = true;
            tile.dirty = false;
          }
        }
      }

      if (end < tiles.length) {
        await yieldToMain();
      }
    }
  }

  /**
   * Drops all cached LOD > 0 tiles and evicts up to `bytesToFree` of LOD 0 tiles to scratch disk.
   * Used by DocumentStore to cooperatively reclaim RAM from inactive document tabs.
   */
  public async evictBytesToDisk(bytesToFree: number): Promise<number> {
    if (bytesToFree <= 0 || this.activeBytes <= 0) return 0;
    let freed = 0;

    // 1. Drop regenerable LOD > 0 tiles first (zero disk I/O)
    for (const tile of this.grid.tilesIterable()) {
      if (tile.lod > 0 && tile.data !== null) {
        const sz = tile.data.byteLength;
        this.activeBytes = Math.max(0, this.activeBytes - sz);
        freed += sz;
        tile.data = null;
        tile.dirty = true;
        tile.version = allocateTileVersion();
      }
    }

    if (freed >= bytesToFree) return freed;

    // 2. Evict LOD 0 tiles oldest-first to scratch disk
    const lod0: TileBuffer[] = [];
    for (const tile of this.grid.tilesIterable()) {
      if (tile.lod === 0 && tile.data !== null) {
        lod0.push(tile);
      }
    }
    lod0.sort((a, b) => a.lastAccessTimestamp - b.lastAccessTimestamp);

    const toEvict: TileBuffer[] = [];
    for (const tile of lod0) {
      if (freed >= bytesToFree) break;
      toEvict.push(tile);
      freed += tile.data?.byteLength || 0;
    }

    if (toEvict.length > 0) {
      await this.evictTiles(toEvict);
    }

    return freed;
  }

  /**
   * Offloads all in-memory tiles of this document to scratch disk.
   */
  public async evictAllToDisk(): Promise<number> {
    return this.evictBytesToDisk(this.activeBytes);
  }

  public async clear(): Promise<void> {
    this.inFlightPageIns.clear();
    this.activeBytes = 0;
    await this.driver.clear(this.sessionId);
  }
}
