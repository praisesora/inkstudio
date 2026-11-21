import { describe, it, expect, vi } from 'vitest';
import {
  SparseTileGrid,
  TileMemoryManager,
  InMemoryScratchDiskDriver,
  serializeSparseTileGrid,
  serializeSparseTileGridAsync,
  deserializeSparseTileGrid,
  serializeTileDeltas,
  serializeTileDeltasAsync,
  deserializeTileDeltas,
  BYTES_32BIT,
} from '../tileEngine';
import { deflateAsync, inflateAsync, zlibAsync, unzlibAsync } from '../asyncCompression';
import { UndoCacheManager } from '../undoCache';
import type { HistoryItem, TileDelta } from '../../types/editor';

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe('Main-thread freeze prevention & async background pipelines', () => {
  it('async deflate/inflate and zlib/unzlib round-trip cleanly and enforce maxOutputBytes', async () => {
    const src = new Uint8Array(64 * 1024);
    for (let i = 0; i < src.length; i++) src[i] = (i * 31) & 0xff;

    const deflated = await deflateAsync(src, { level: 1, transfer: false });
    const inflated = await inflateAsync(deflated);
    expect(uint8Equal(inflated, src)).toBe(true);

    const zlibbed = await zlibAsync(src, { level: 1, transfer: false });
    const unzlibbed = await unzlibAsync(zlibbed);
    expect(uint8Equal(unzlibbed, src)).toBe(true);

    await expect(
      unzlibAsync(zlibbed, { maxOutputBytes: 1024 })
    ).rejects.toThrow(/safety ceiling/i);
  });

  it('serializeSparseTileGridAsync produces byte-identical output to sync version and supports cooperative abort', async () => {
    const grid = new SparseTileGrid();
    for (let i = 0; i < 40; i++) {
      const t = grid.getOrCreateTile(i % 2 === 0 ? 'layer-a' : 'layer-b', i, 0, 'color-32bit');
      t.data![0] = (i + 1) & 0xff;
      t.data![3] = 255;
    }

    const syncBytes = serializeSparseTileGrid(grid);
    const asyncBytes = await serializeSparseTileGridAsync(grid, { chunkBudgetMs: 0 });
    expect(asyncBytes).not.toBeNull();
    expect(uint8Equal(asyncBytes!, syncBytes)).toBe(true);

    const restored = new SparseTileGrid();
    deserializeSparseTileGrid(restored, asyncBytes!);
    expect(restored.getTile('layer-a', 0, 0)?.data?.[0]).toBe(1);
    expect(restored.getTile('layer-b', 39, 0)?.data?.[0]).toBe(40);

    // Cooperative abort mid-serialization when user resumes drawing
    let checks = 0;
    const aborted = await serializeSparseTileGridAsync(grid, {
      chunkBudgetMs: 0,
      shouldAbort: () => ++checks >= 3,
    });
    expect(aborted).toBeNull();
  });

  it('serializeTileDeltasAsync produces byte-identical output for large delta arrays', async () => {
    const deltas: TileDelta[] = [];
    for (let i = 0; i < 24; i++) {
      const before = new Uint8Array(BYTES_32BIT);
      const after = new Uint8Array(BYTES_32BIT);
      before[0] = i;
      after[0] = 255 - i;
      deltas.push({
        key: `layer-1:${i}:0`,
        format: 'color-32bit',
        beforeData: before,
        afterData: after,
      });
    }

    const syncBytes = serializeTileDeltas(deltas);
    const asyncBytes = await serializeTileDeltasAsync(deltas, 0);
    expect(uint8Equal(asyncBytes, syncBytes)).toBe(true);

    const decoded = deserializeTileDeltas(asyncBytes);
    expect(decoded).toHaveLength(24);
    expect(decoded[23].afterData?.[0]).toBe(255 - 23);
  });

  it('TileMemoryManager chunks large evictions into <= 32 tiles per batch and handles driver failure without spinning', async () => {
    const grid = new SparseTileGrid();
    const driver = new InMemoryScratchDiskDriver();
    const writeSpy = vi.spyOn(driver, 'writeTiles');

    const mm = new TileMemoryManager(grid, {
      budgetMb: 100,
      driver,
      sessionId: 'chunk-evict-test',
    });
    grid.setMemoryManager(mm);

    const tiles = [];
    for (let i = 0; i < 70; i++) {
      const t = grid.getOrCreateTile('layer-1', i, 0, 'monochrome-1bit');
      t.data![0] = i & 0xff;
      tiles.push(t);
    }

    await mm.evictTiles(tiles);

    // 70 tiles with batch size 32 => 3 batches (32 + 32 + 6)
    expect(writeSpy).toHaveBeenCalledTimes(3);
    expect(writeSpy.mock.calls[0][1].length).toBe(32);
    expect(writeSpy.mock.calls[1][1].length).toBe(32);
    expect(writeSpy.mock.calls[2][1].length).toBe(6);
    expect(tiles.every((t) => t.data === null && t.isPagedToDisk)).toBe(true);

    // Driver failure during checkBudgetAndEvict must terminate cleanly instead of spinning
    const failingDriver = new InMemoryScratchDiskDriver();
    vi.spyOn(failingDriver, 'writeTiles').mockRejectedValue(new Error('Disk full'));
    const failGrid = new SparseTileGrid();
    const failMm = new TileMemoryManager(failGrid, {
      budgetMb: 1,
      driver: failingDriver,
      sessionId: 'fail-evict-test',
    });
    failGrid.setMemoryManager(failMm);
    for (let i = 0; i < 6; i++) {
      failGrid.getOrCreateTile('layer-1', i, 0, 'color-32bit');
    }
    await expect(failMm.checkBudgetAndEvict()).resolves.toBeUndefined();
  });

  it('UndoCacheManager coalesces concurrent offloads and avoids wiping deltas requested mid-offload', async () => {
    const cache = new UndoCacheManager('race-test');
    const data = new Uint8Array(BYTES_32BIT);
    data[0] = 77;
    const item: HistoryItem = {
      id: 'step-race',
      type: 'brush',
      label: 'Stroke',
      timestamp: Date.now(),
      timeFormatted: '12:00:00',
      thumbnailUrl: '',
      layerId: 'layer-1',
      tileDeltas: [{ key: 'layer-1:0:0', format: 'color-32bit', beforeData: null, afterData: data }],
    };

    // Start concurrent offload and immediate resolveDeltas
    const offloadP1 = cache.offloadToDisk(item);
    const offloadP2 = cache.offloadToDisk(item);
    const resolved = await cache.resolveDeltas(item);
    await Promise.all([offloadP1, offloadP2]);

    expect(resolved).not.toBeNull();
    expect(resolved![0].afterData?.[0]).toBe(77);
    // Deltas must remain intact in RAM because resolveDeltas requested them during offload
    expect(item.tileDeltas).toBeDefined();
  });
});
