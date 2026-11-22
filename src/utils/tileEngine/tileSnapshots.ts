/**
 * Layer lifecycle, memory statistics, tile snapshots, undo/redo delta diffing,
 * and full-grid snapshot restoration for SparseTileGrid.
 */

import type { TileDelta } from '../../types/editor';
import {
  ISparseTileGridHost,
  TileBuffer,
  TileFormat,
  TileMemoryStats,
  TileSnapshotEntry,
  allocateTileVersion,
  getTileByteSize,
  getTileKey,
  packTileCoord,
  parseTileKey,
  pixelToTileCoord,
  reserveTileVersion,
} from './types';

export function registerLod0Tile(host: ISparseTileGridHost, tile: TileBuffer): void {
  if ((tile.lod ?? 0) !== 0) return;
  let set = host.layerLod0Tiles.get(tile.layerId);
  if (!set) {
    set = new Set<TileBuffer>();
    host.layerLod0Tiles.set(tile.layerId, set);
  }
  if (set.has(tile)) return;
  set.add(tile);

  let occ = host.layerLodOccupancy.get(tile.layerId);
  if (!occ) {
    occ = [new Map<number, number>(), new Map<number, number>(), new Map<number, number>()];
    host.layerLodOccupancy.set(tile.layerId, occ);
  }
  let tx = tile.tileX;
  let ty = tile.tileY;
  for (let i = 0; i < 3; i++) {
    tx = tx >> 1;
    ty = ty >> 1;
    const pk = packTileCoord(tx, ty);
    occ[i].set(pk, (occ[i].get(pk) ?? 0) + 1);
  }
}

export function unregisterLod0Tile(host: ISparseTileGridHost, tile: TileBuffer): void {
  if ((tile.lod ?? 0) !== 0) return;
  const set = host.layerLod0Tiles.get(tile.layerId);
  if (!set || !set.delete(tile)) return;
  if (set.size === 0) {
    host.layerLod0Tiles.delete(tile.layerId);
  }

  const occ = host.layerLodOccupancy.get(tile.layerId);
  if (!occ) return;
  let tx = tile.tileX;
  let ty = tile.tileY;
  for (let i = 0; i < 3; i++) {
    tx = tx >> 1;
    ty = ty >> 1;
    const pk = packTileCoord(tx, ty);
    const next = (occ[i].get(pk) ?? 0) - 1;
    if (next <= 0) {
      occ[i].delete(pk);
    } else {
      occ[i].set(pk, next);
    }
  }
  if (set.size === 0) {
    host.layerLodOccupancy.delete(tile.layerId);
  }
}

export function clearLayer(host: ISparseTileGridHost, layerId: string): void {
  host.ingestedLayers.delete(layerId);
  host.layerLod0Tiles.delete(layerId);
  host.layerLodOccupancy.delete(layerId);
  const memoryManager = host.getMemoryManager();
  const prefix = `${layerId}:`;
  const toDelete: string[] = [];
  for (const [key, tile] of host.tiles.entries()) {
    if (key.startsWith(prefix)) {
      toDelete.push(key);
      if (memoryManager) {
        memoryManager.notifyTileFreed(tile);
      }
    }
  }
  for (const key of toDelete) {
    host.tiles.delete(key);
    host.dirtyLodTiles.delete(key);
  }
  host.bumpLayerVersion(layerId);
  host.notifyChange();
}

export function cloneLayer(host: ISparseTileGridHost, srcLayerId: string, dstLayerId: string): void {
  host.clearLayer(dstLayerId);
  host.ingestedLayers.add(dstLayerId);
  host.setLayerFormat(dstLayerId, host.getLayerFormat(srcLayerId));
  const memoryManager = host.getMemoryManager();
  const srcTiles = host.getLayerTiles(srcLayerId, 0);
  for (const srcTile of srcTiles) {
    if (!srcTile.data && srcTile.isPagedToDisk && memoryManager) {
      void memoryManager.requestTileData(srcTile);
    }
    const clonedData = srcTile.data ? new Uint8Array(srcTile.data.length) : new Uint8Array(getTileByteSize(srcTile.format));
    if (srcTile.data) clonedData.set(srcTile.data);

    const clonedTile: TileBuffer = {
      layerId: dstLayerId,
      tileX: srcTile.tileX,
      tileY: srcTile.tileY,
      format: srcTile.format,
      data: clonedData,
      dirty: true,
      version: allocateTileVersion(),
      isPagedToDisk: false,
      lastAccessTimestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      lod: 0,
      solidColorU32: srcTile.solidColorU32,
    };
    host.setTile(dstLayerId, srcTile.tileX, srcTile.tileY, clonedTile);
  }
}

export function getMemoryStats(host: ISparseTileGridHost): TileMemoryStats {
  let totalBytes = 0;
  let activeBytes = 0;
  let pagedBytes = 0;
  let activeTileCount = 0;
  let pagedTileCount = 0;

  const formatCounts: Record<TileFormat, number> = {
    'monochrome-1bit': 0,
    'grayscale-8bit': 0,
    'color-32bit': 0,
  };
  const lodCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };

  for (const tile of host.tiles.values()) {
    const bSize = getTileByteSize(tile.format);
    totalBytes += bSize;
    lodCounts[tile.lod ?? 0] = (lodCounts[tile.lod ?? 0] || 0) + 1;

    if (tile.data !== null) {
      activeBytes += tile.data.byteLength;
      activeTileCount++;
      formatCounts[tile.format]++;
    } else if (tile.isPagedToDisk) {
      pagedBytes += bSize;
      pagedTileCount++;
    }
  }

  return {
    totalBytes,
    activeBytes,
    pagedBytes,
    tileCount: host.tiles.size,
    activeTileCount,
    pagedTileCount,
    formatCounts,
    lodCounts,
  };
}

export function snapshotLayerTiles(
  host: ISparseTileGridHost,
  layerId: string
): Map<string, TileSnapshotEntry> {
  const snapshot = new Map<string, TileSnapshotEntry>();
  for (const tile of host.getLayerTiles(layerId, 0)) {
    const key = getTileKey(layerId, tile.tileX, tile.tileY, 0);
    if (tile.data) {
      const copy = new Uint8Array(tile.data.length);
      copy.set(tile.data);
      snapshot.set(key, { format: tile.format, data: copy });
    } else {
      snapshot.set(key, { format: tile.format, data: null });
    }
  }
  return snapshot;
}

export function snapshotTilesInRect(
  host: ISparseTileGridHost,
  layerId: string,
  bounds: { x: number; y: number; width: number; height: number }
): Map<string, TileSnapshotEntry> {
  const snapshot = new Map<string, TileSnapshotEntry>();
  if (bounds.width <= 0 || bounds.height <= 0) return snapshot;

  const minTileX = pixelToTileCoord(bounds.x, 0);
  const minTileY = pixelToTileCoord(bounds.y, 0);
  const maxTileX = pixelToTileCoord(bounds.x + bounds.width - 1, 0);
  const maxTileY = pixelToTileCoord(bounds.y + bounds.height - 1, 0);

  const layerFormat = host.getLayerFormat(layerId);

  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      const key = getTileKey(layerId, tx, ty, 0);
      const tile = host.getTile(layerId, tx, ty, 0);
      if (tile && tile.data) {
        const copy = new Uint8Array(tile.data.length);
        copy.set(tile.data);
        snapshot.set(key, { format: tile.format, data: copy });
      } else {
        snapshot.set(key, { format: layerFormat, data: null });
      }
    }
  }

  return snapshot;
}

export function computeDeltasFromSnapshot(
  host: ISparseTileGridHost,
  beforeSnapshot: Map<string, TileSnapshotEntry>,
  layerId: string,
  bounds?: { x: number; y: number; width: number; height: number }
): TileDelta[] {
  const deltas: TileDelta[] = [];
  const keysToCheck = new Set<string>(beforeSnapshot.keys());

  if (beforeSnapshot.size === 0 && bounds && bounds.width > 0 && bounds.height > 0) {
    const minTileX = pixelToTileCoord(bounds.x, 0);
    const minTileY = pixelToTileCoord(bounds.y, 0);
    const maxTileX = pixelToTileCoord(bounds.x + bounds.width - 1, 0);
    const maxTileY = pixelToTileCoord(bounds.y + bounds.height - 1, 0);
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        keysToCheck.add(getTileKey(layerId, tx, ty, 0));
      }
    }
  }

  for (const key of keysToCheck) {
    if (beforeSnapshot.size > 0 && !beforeSnapshot.has(key)) continue;
    const before = beforeSnapshot.get(key);
    const { tileX, tileY } = parseTileKey(key);
    const currentTile = host.getTile(layerId, tileX, tileY, 0);

    const beforeData = before ? before.data : null;
    const currentData = currentTile && currentTile.data ? currentTile.data : null;
    const format = currentTile ? currentTile.format : (before ? before.format : host.getLayerFormat(layerId));

    if (beforeData === null && currentData === null) continue;

    let changed = false;
    if ((beforeData === null) !== (currentData === null)) {
      changed = true;
    } else if (beforeData && currentData) {
      if (beforeData.byteLength !== currentData.byteLength) {
        changed = true;
      } else if (
        beforeData.byteLength % 4 === 0 &&
        beforeData.byteOffset % 4 === 0 &&
        currentData.byteOffset % 4 === 0
      ) {
        const len32 = beforeData.byteLength >>> 2;
        const b32 = new Uint32Array(beforeData.buffer, beforeData.byteOffset, len32);
        const c32 = new Uint32Array(currentData.buffer, currentData.byteOffset, len32);
        for (let i = 0; i < len32; i++) {
          if (b32[i] !== c32[i]) {
            changed = true;
            break;
          }
        }
      } else {
        for (let i = 0; i < beforeData.byteLength; i++) {
          if (beforeData[i] !== currentData[i]) {
            changed = true;
            break;
          }
        }
      }
    }

    if (changed) {
      deltas.push({
        key,
        format,
        beforeData,
        afterData: currentData ? new Uint8Array(currentData) : null,
      });
    }
  }

  return deltas;
}

export function applyTileDeltas(
  host: ISparseTileGridHost,
  deltas: TileDelta[],
  direction: 'undo' | 'redo'
): void {
  const memoryManager = host.getMemoryManager();
  for (const delta of deltas) {
    const { layerId, tileX, tileY } = parseTileKey(delta.key);
    const targetData = direction === 'undo' ? delta.beforeData : delta.afterData;

    if (!targetData) {
      host.deleteTile(layerId, tileX, tileY, 0);
    } else {
      let tile = host.getTile(layerId, tileX, tileY, 0);
      if (!tile) {
        tile = host.getOrCreateTile(layerId, tileX, tileY, delta.format, 0);
      }
      if (!tile.data || tile.data.byteLength !== targetData.byteLength) {
        if (tile.data) {
          memoryManager?.notifyTileFreed(tile);
        }
        tile.data = new Uint8Array(targetData.length);
        memoryManager?.notifyTileAllocated(tile);
      }
      tile.data.set(targetData);
      tile.solidColorU32 = undefined;
      tile.format = delta.format;
      host.setLayerFormat(layerId, delta.format);
      tile.dirty = true;
      tile.version = allocateTileVersion();
      host.markLodAncestorsDirty(layerId, tileX, tileY);
      host.bumpLayerVersion(layerId);
    }
  }
  host.notifyChange();
}

export function clearAll(host: ISparseTileGridHost): void {
  const memoryManager = host.getMemoryManager();
  if (memoryManager) {
    for (const tile of host.tiles.values()) {
      memoryManager.notifyTileFreed(tile);
    }
  }
  host.tiles.clear();
  host.layerLod0Tiles.clear();
  host.layerLodOccupancy.clear();
  host.layerFormats.clear();
  host.ingestedLayers.clear();
  host.dirtyLodTiles.clear();
  host.layerVersions.clear();
  host.incrementGridEpochAndContentVersion();
  host.notifyChange(true);
}

export function restoreFromSnapshot(
  host: ISparseTileGridHost,
  tiles: TileBuffer[],
  layerFormats?: Map<string, TileFormat>
): void {
  host.clearAll();
  const memoryManager = host.getMemoryManager();
  if (layerFormats) {
    for (const [layerId, fmt] of layerFormats.entries()) {
      host.layerFormats.set(layerId, fmt);
    }
  }
  for (const tile of tiles) {
    if (tile.version > 0) {
      reserveTileVersion(tile.version);
    } else {
      tile.version = allocateTileVersion();
    }
    tile.dirty = true;
    host.tiles.set(getTileKey(tile.layerId, tile.tileX, tile.tileY, tile.lod ?? 0), tile);
    if ((tile.lod ?? 0) === 0) {
      host.registerLod0Tile(tile);
    }
    if (memoryManager) {
      memoryManager.notifyTileAllocated(tile);
    }
    if ((tile.lod ?? 0) === 0) {
      host.bumpLayerVersion(tile.layerId);
    }
  }
  host.notifyChange(true);
}
