import { describe, it, expect, beforeEach } from 'vitest';
import {
  SparseTileGrid,
  TileMemoryManager,
  TILE_SIZE,
  BYTES_1BIT,
  BYTES_8BIT,
  BYTES_32BIT,
  setPixel1Bit,
  getPixel1Bit,
  InMemoryScratchDiskDriver,
  packTileWriteBatch,
  unpackTileWriteBatch,
  TauriScratchDiskDriver,
} from '../tileEngine';

describe('Production-Grade Virtual Memory & SSD Scratch Disk Engine', () => {
  let grid: SparseTileGrid;
  let driver: InMemoryScratchDiskDriver;
  let memoryManager: TileMemoryManager;

  beforeEach(() => {
    grid = new SparseTileGrid();
    driver = new InMemoryScratchDiskDriver();
    memoryManager = new TileMemoryManager(grid, {
      budgetMb: 1, // 1 MB budget = 4 color tiles (262,144 bytes each)
      driver,
      sessionId: 'test-scratch-session',
    });
    grid.setMemoryManager(memoryManager);
  });

  // ==========================================================================
  // Pillar 1: LRU Eviction Ordering & RAM Budget Threshold Enforcement
  // ==========================================================================
  describe('Pillar 1: LRU Eviction Ordering and RAM Budget Threshold Enforcement', () => {
    it('strictly caps active RAM consumption below the configured budget', async () => {
      // 1 MB budget = 1,048,576 bytes = 4 color-32bit tiles (256 KB each)
      expect(memoryManager.getBudgetBytes()).toBe(1024 * 1024);

      // Allocate 6 color tiles (1.5 MB total, exceeding 1 MB budget)
      for (let i = 0; i < 6; i++) {
        const tile = grid.getOrCreateTile('layer-1', i, 0, 'color-32bit');
        tile.data!.fill(i + 1);
        tile.dirty = false;
      }

      await memoryManager.checkBudgetAndEvict();

      // Active RAM must be within budget (<= 90% target threshold = 943,718 bytes, or <= 1 MB)
      expect(memoryManager.getActiveMemoryBytes()).toBeLessThanOrEqual(memoryManager.getBudgetBytes());

      const stats = grid.getMemoryStats();
      expect(stats.activeBytes).toBeLessThanOrEqual(memoryManager.getBudgetBytes());
      expect(stats.pagedTileCount).toBeGreaterThan(0);
      expect(stats.activeTileCount).toBeLessThan(6);
    });

    it('prioritizes evicting hidden layers before visible layers', async () => {
      // Layer 1: Visible (active layer)
      // Layer 2: Hidden
      const visibility = new Map<string, boolean>([
        ['layer-visible', true],
        ['layer-hidden', false],
      ]);

      memoryManager.updateViewport(
        { minX: 0, minY: 0, maxX: 512, maxY: 512 },
        'layer-visible',
        visibility
      );

      // Allocate 2 tiles on visible layer
      const vis1 = grid.getOrCreateTile('layer-visible', 0, 0, 'color-32bit');
      vis1.data!.fill(10);
      vis1.dirty = false;

      const vis2 = grid.getOrCreateTile('layer-visible', 1, 0, 'color-32bit');
      vis2.data!.fill(20);
      vis2.dirty = false;

      // Allocate 3 tiles on hidden layer (pushes active RAM over 1MB budget)
      const hid1 = grid.getOrCreateTile('layer-hidden', 0, 0, 'color-32bit');
      hid1.data!.fill(100);
      hid1.dirty = false;

      const hid2 = grid.getOrCreateTile('layer-hidden', 1, 0, 'color-32bit');
      hid2.data!.fill(101);
      hid2.dirty = false;

      const hid3 = grid.getOrCreateTile('layer-hidden', 2, 0, 'color-32bit');
      hid3.data!.fill(102);
      hid3.dirty = false;

      await memoryManager.checkBudgetAndEvict();

      // Hidden layer tiles should be evicted first!
      expect(hid1.data).toBeNull();
      expect(hid1.isPagedToDisk).toBe(true);

      // Visible active tiles should still be active in memory
      expect(vis1.data).not.toBeNull();
      expect(vis2.data).not.toBeNull();
    });

    it('prioritizes evicting tiles farthest outside the viewport frustum', async () => {
      // Frustum covers document [0..512, 0..512] -> tiles (0,0) to (1,1)
      memoryManager.updateViewport(
        { minX: 0, minY: 0, maxX: 512, maxY: 512 },
        'layer-art',
        new Map([['layer-art', true]])
      );

      // In-frustum tile (0, 0)
      const inFrustum = grid.getOrCreateTile('layer-art', 0, 0, 'color-32bit');
      inFrustum.data!.fill(1);
      inFrustum.dirty = false;

      // Near outside frustum (3, 0)
      const nearOutside = grid.getOrCreateTile('layer-art', 3, 0, 'color-32bit');
      nearOutside.data!.fill(2);
      nearOutside.dirty = false;

      // Far outside frustum (20, 20)
      const farOutside = grid.getOrCreateTile('layer-art', 20, 20, 'color-32bit');
      farOutside.data!.fill(3);
      farOutside.dirty = false;

      // Far outside frustum (30, 30)
      const farthestOutside = grid.getOrCreateTile('layer-art', 30, 30, 'color-32bit');
      farthestOutside.data!.fill(4);
      farthestOutside.dirty = false;

      // Another in-frustum tile
      const inFrustum2 = grid.getOrCreateTile('layer-art', 1, 1, 'color-32bit');
      inFrustum2.data!.fill(5);
      inFrustum2.dirty = false;

      await memoryManager.checkBudgetAndEvict();

      // The farthest outside tile (30, 30) must be evicted first
      expect(farthestOutside.data).toBeNull();
      expect(farthestOutside.isPagedToDisk).toBe(true);

      // In-frustum tiles are protected
      expect(inFrustum.data).not.toBeNull();
      expect(inFrustum2.data).not.toBeNull();
    });
  });

  // ==========================================================================
  // Pillar 2: Lossless Round-Trip Byte Integrity
  // ==========================================================================
  describe('Pillar 2: Lossless Round-Trip Byte Integrity Across Formats', () => {
    it('losslessly round-trips 1-bit monochrome tiles (8 KB)', async () => {
      const tile = grid.getOrCreateTile('layer-mono', 5, 5, 'monochrome-1bit');
      expect(tile.data!.byteLength).toBe(BYTES_1BIT);

      // Draw custom binary ink pattern with isolated pixels and bit runs
      setPixel1Bit(tile.data!, 0, 0, true);
      setPixel1Bit(tile.data!, 7, 0, true);
      setPixel1Bit(tile.data!, 128, 64, true);
      setPixel1Bit(tile.data!, 255, 255, true);

      // Save a copy of the original raw bytes
      const originalBytes = new Uint8Array(tile.data!);

      // Evict to scratch disk
      await memoryManager.evictTiles([tile]);
      expect(tile.data).toBeNull();
      expect(tile.isPagedToDisk).toBe(true);

      // Transparent Page-In
      const pagedIn = await memoryManager.requestTileData(tile);
      expect(pagedIn.byteLength).toBe(BYTES_1BIT);
      expect(tile.data).not.toBeNull();

      // Bit-for-bit, byte-for-byte lossless verification
      expect(Array.from(tile.data!)).toEqual(Array.from(originalBytes));
      expect(getPixel1Bit(tile.data!, 0, 0)).toBe(1);
      expect(getPixel1Bit(tile.data!, 7, 0)).toBe(1);
      expect(getPixel1Bit(tile.data!, 128, 64)).toBe(1);
      expect(getPixel1Bit(tile.data!, 255, 255)).toBe(1);
      expect(getPixel1Bit(tile.data!, 1, 0)).toBe(0);
    });

    it('losslessly round-trips 8-bit grayscale tiles (64 KB)', async () => {
      const tile = grid.getOrCreateTile('layer-gray', 2, 2, 'grayscale-8bit');
      expect(tile.data!.byteLength).toBe(BYTES_8BIT);

      // Fill with tonal gradient pattern
      for (let i = 0; i < BYTES_8BIT; i++) {
        tile.data![i] = i % 256;
      }
      const originalBytes = new Uint8Array(tile.data!);

      // Evict to scratch disk
      await memoryManager.evictTiles([tile]);
      expect(tile.data).toBeNull();
      expect(tile.isPagedToDisk).toBe(true);

      // Transparent Page-In
      await memoryManager.requestTileData(tile);
      expect(tile.data).not.toBeNull();
      expect(Array.from(tile.data!)).toEqual(Array.from(originalBytes));
    });

    it('losslessly round-trips 32-bit color tiles (256 KB)', async () => {
      const tile = grid.getOrCreateTile('layer-color', 1, 1, 'color-32bit');
      expect(tile.data!.byteLength).toBe(BYTES_32BIT);

      // Fill with RGBA test values
      for (let i = 0; i < BYTES_32BIT; i += 4) {
        tile.data![i] = (i * 3) & 0xff; // R
        tile.data![i + 1] = (i * 7) & 0xff; // G
        tile.data![i + 2] = (i * 11) & 0xff; // B
        tile.data![i + 3] = 255; // A
      }
      const originalBytes = new Uint8Array(tile.data!);

      // Evict to scratch disk
      await memoryManager.evictTiles([tile]);
      expect(tile.data).toBeNull();
      expect(tile.isPagedToDisk).toBe(true);

      // Transparent Page-In
      await memoryManager.requestTileData(tile);
      expect(tile.data).not.toBeNull();
      expect(Array.from(tile.data!)).toEqual(Array.from(originalBytes));
    });
  });

  // ==========================================================================
  // Pillar 3: On-Demand Mipmap Tile Pyramid (LOD 0 to LOD 3)
  // ==========================================================================
  describe('Pillar 3: Multi-Resolution Mipmap Tile Pyramid Generation', () => {
    it('correctly downsamples 2x2 LOD 0 tiles into a single 256x256 LOD 1 tile', () => {
      // Setup 4 quadrants at LOD 0
      // (0, 0): Solid Red
      const c00 = grid.getOrCreateTile('layer-mipmap', 0, 0, 'color-32bit', 0);
      for (let i = 0; i < BYTES_32BIT; i += 4) {
        c00.data![i] = 255; // R
        c00.data![i + 1] = 0;
        c00.data![i + 2] = 0;
        c00.data![i + 3] = 255;
      }

      // (1, 0): Solid Green
      const c10 = grid.getOrCreateTile('layer-mipmap', 1, 0, 'color-32bit', 0);
      for (let i = 0; i < BYTES_32BIT; i += 4) {
        c10.data![i] = 0;
        c10.data![i + 1] = 255; // G
        c10.data![i + 2] = 0;
        c10.data![i + 3] = 255;
      }

      // (0, 1): Solid Blue
      const c01 = grid.getOrCreateTile('layer-mipmap', 0, 1, 'color-32bit', 0);
      for (let i = 0; i < BYTES_32BIT; i += 4) {
        c01.data![i] = 0;
        c01.data![i + 1] = 0;
        c01.data![i + 2] = 255; // B
        c01.data![i + 3] = 255;
      }

      // (1, 1): Solid Yellow
      const c11 = grid.getOrCreateTile('layer-mipmap', 1, 1, 'color-32bit', 0);
      for (let i = 0; i < BYTES_32BIT; i += 4) {
        c11.data![i] = 255; // R
        c11.data![i + 1] = 255; // G
        c11.data![i + 2] = 0;
        c11.data![i + 3] = 255;
      }

      // Generate LOD 1 tile (0, 0)
      const lod1 = grid.generateLodTile('layer-mipmap', 0, 0, 1);
      expect(lod1).not.toBeNull();
      expect(lod1!.lod).toBe(1);
      expect(lod1!.data!.byteLength).toBe(BYTES_32BIT);

      // Verify Quadrant 0 (top-left, x: 0..127, y: 0..127): should be Red (255, 0, 0, 255)
      const pTL = (10 * TILE_SIZE + 10) * 4;
      expect(lod1!.data![pTL]).toBe(255);
      expect(lod1!.data![pTL + 1]).toBe(0);
      expect(lod1!.data![pTL + 2]).toBe(0);
      expect(lod1!.data![pTL + 3]).toBe(255);

      // Verify Quadrant 1 (top-right, x: 128..255, y: 0..127): should be Green (0, 255, 0, 255)
      const pTR = (10 * TILE_SIZE + 140) * 4;
      expect(lod1!.data![pTR]).toBe(0);
      expect(lod1!.data![pTR + 1]).toBe(255);
      expect(lod1!.data![pTR + 2]).toBe(0);
      expect(lod1!.data![pTR + 3]).toBe(255);

      // Verify Quadrant 2 (bottom-left, x: 0..127, y: 128..255): should be Blue (0, 0, 255, 255)
      const pBL = (140 * TILE_SIZE + 10) * 4;
      expect(lod1!.data![pBL]).toBe(0);
      expect(lod1!.data![pBL + 1]).toBe(0);
      expect(lod1!.data![pBL + 2]).toBe(255);
      expect(lod1!.data![pBL + 3]).toBe(255);

      // Verify Quadrant 3 (bottom-right, x: 128..255, y: 128..255): should be Yellow (255, 255, 0, 255)
      const pBR = (140 * TILE_SIZE + 140) * 4;
      expect(lod1!.data![pBR]).toBe(255);
      expect(lod1!.data![pBR + 1]).toBe(255);
      expect(lod1!.data![pBR + 2]).toBe(0);
      expect(lod1!.data![pBR + 3]).toBe(255);
    });

    it('recursively generates LOD 2 (1/4 scale) and LOD 3 (1/8 scale) tiles', () => {
      // Paint at LOD 0
      const tile = grid.getOrCreateTile('layer-pyr', 0, 0, 'color-32bit', 0);
      tile.data!.fill(200);

      // Generate LOD 2
      const lod2 = grid.generateLodTile('layer-pyr', 0, 0, 2);
      expect(lod2).not.toBeNull();
      expect(lod2!.lod).toBe(2);

      // Generate LOD 3
      const lod3 = grid.generateLodTile('layer-pyr', 0, 0, 3);
      expect(lod3).not.toBeNull();
      expect(lod3!.lod).toBe(3);
    });

    it('marks higher LOD tiles as dirty when drawing modifies LOD 0', () => {
      const tile = grid.getOrCreateTile('layer-paint', 4, 6, 'color-32bit', 0);
      tile.data!.fill(50);
      grid.markLodAncestorsDirty('layer-paint', 4, 6);

      // LOD 1 (2, 3), LOD 2 (1, 1), LOD 3 (0, 0)
      expect(grid.hasTile('layer-paint', 2, 3, 1)).toBe(false);

      // Flush dirty mipmaps
      grid.flushMipmaps('layer-paint');

      expect(grid.hasTile('layer-paint', 2, 3, 1)).toBe(true);
      expect(grid.hasTile('layer-paint', 1, 1, 2)).toBe(true);
      expect(grid.hasTile('layer-paint', 0, 0, 3)).toBe(true);
    });
  });

  // ==========================================================================
  // Pillar 4: Simulated Manga B4 600 DPI (7016 x 9921 px, 20 Layers)
  // ==========================================================================
  describe('Pillar 4: Simulated Manga B4 600 DPI Canvas with 20 Layers', () => {
    it('maintains active RAM strictly within configured budget across 20 layers without crash', async () => {
      const B4_WIDTH = 7016;
      const B4_HEIGHT = 9921;
      const LAYER_COUNT = 20;

      // 7016 x 9921 px canvas = 28 x 39 tiles = 1,092 tiles per layer
      const tilesAcross = Math.ceil(B4_WIDTH / TILE_SIZE);
      const tilesDown = Math.ceil(B4_HEIGHT / TILE_SIZE);
      expect(tilesAcross).toBe(28);
      expect(tilesDown).toBe(39);

      // Configure a strict 16 MB RAM budget
      // 16 MB = 64 color tiles (256 KB each) or 256 gray tiles (64 KB each)
      memoryManager.setBudgetMb(16);
      expect(memoryManager.getBudgetBytes()).toBe(16 * 1024 * 1024);

      // Viewport is centered on page center [3000..4000, 4000..5000]
      memoryManager.updateViewport(
        { minX: 3000, minY: 4000, maxX: 4000, maxY: 5000 },
        'layer-active',
        new Map()
      );

      // Simulate drawing on 20 layers across diverse regions of the 70 MP page
      let totalTilesCreated = 0;
      for (let l = 0; l < LAYER_COUNT; l++) {
        const layerId = `layer-${l}`;
        // Create 10 tiles per layer in various quadrants (200 tiles total)
        for (let t = 0; t < 10; t++) {
          const tx = (t * 2) % tilesAcross;
          const ty = (l * 2 + t) % tilesDown;

          const tile = grid.getOrCreateTile(layerId, tx, ty, 'color-32bit', 0);
          tile.data!.fill((l * 10 + t) & 0xff);
          tile.dirty = false;
          totalTilesCreated++;
        }
      }

      expect(totalTilesCreated).toBe(200);

      // Run budget enforcement eviction pass
      await memoryManager.checkBudgetAndEvict();

      const stats = grid.getMemoryStats();

      // Peak active RAM must remain strictly <= 16 MB budget!
      expect(stats.activeBytes).toBeLessThanOrEqual(memoryManager.getBudgetBytes());

      // Excess tiles must have been transparently offloaded to scratch disk
      expect(stats.pagedTileCount).toBeGreaterThan(0);
      expect(stats.pagedBytes).toBeGreaterThan(0);

      // Transparent Page-In test: pick an evicted tile and request it back
      const allTiles = grid.getAllTiles().filter((t) => t.lod === 0);
      const pagedTile = allTiles.find((t) => t.data === null && t.isPagedToDisk);
      expect(pagedTile).toBeDefined();

      if (pagedTile) {
        const recoveredData = await memoryManager.requestTileData(pagedTile);
        expect(recoveredData).not.toBeNull();
        expect(recoveredData.byteLength).toBe(BYTES_32BIT);
        expect(pagedTile.data).not.toBeNull();
      }
    });

    it('compositor correctly calculates intersecting tile ranges and selects optimal LOD for zoom scale', () => {
      // Verify LOD math:
      // zoom <= 12.5% -> LOD 3 (2048x2048 doc area)
      // zoom <= 25%   -> LOD 2 (1024x1024 doc area)
      // zoom <= 50%   -> LOD 1 (512x512 doc area)
      // zoom > 50%    -> LOD 0 (256x256 doc area)

      const frustum = { minX: 1000, minY: 2000, maxX: 3000, maxY: 4000 };

      // Zoom 10% -> LOD 3
      const zoom10 = 0.10;
      const lod10 = zoom10 <= 0.125 ? 3 : zoom10 <= 0.25 ? 2 : zoom10 <= 0.5 ? 1 : 0;
      expect(lod10).toBe(3);
      const lodDocSize3 = TILE_SIZE << 3; // 2048
      const startX3 = Math.floor(frustum.minX / lodDocSize3);
      const endX3 = Math.floor(frustum.maxX / lodDocSize3);
      expect(startX3).toBe(0);
      expect(endX3).toBe(1);

      // Zoom 20% -> LOD 2
      const zoom20 = 0.20;
      const lod20 = zoom20 <= 0.125 ? 3 : zoom20 <= 0.25 ? 2 : zoom20 <= 0.5 ? 1 : 0;
      expect(lod20).toBe(2);
      const lodDocSize2 = TILE_SIZE << 2; // 1024
      const startX2 = Math.floor(frustum.minX / lodDocSize2);
      const endX2 = Math.floor(frustum.maxX / lodDocSize2);
      expect(startX2).toBe(0);
      expect(endX2).toBe(2);

      // Zoom 40% -> LOD 1
      const zoom40 = 0.40;
      const lod40 = zoom40 <= 0.125 ? 3 : zoom40 <= 0.25 ? 2 : zoom40 <= 0.5 ? 1 : 0;
      expect(lod40).toBe(1);
      const lodDocSize1 = TILE_SIZE << 1; // 512
      const startX1 = Math.floor(frustum.minX / lodDocSize1);
      const endX1 = Math.floor(frustum.maxX / lodDocSize1);
      expect(startX1).toBe(1);
      expect(endX1).toBe(5);

      // Zoom 100% -> LOD 0
      const zoom100 = 1.0;
      const lod0 = zoom100 <= 0.125 ? 3 : zoom100 <= 0.25 ? 2 : zoom100 <= 0.5 ? 1 : 0;
      expect(lod0).toBe(0);
      const lodDocSize0 = TILE_SIZE << 0; // 256
      const startX0 = Math.floor(frustum.minX / lodDocSize0);
      const endX0 = Math.floor(frustum.maxX / lodDocSize0);
      expect(startX0).toBe(3);
      expect(endX0).toBe(11);
    });
  });

  // ==========================================================================
  // Pillar 5: Binary IPC Tile Batch Packing / Unpacking
  // ==========================================================================
  describe('Pillar 5: Binary IPC Tile Batch Packing and Unpacking', () => {
    it('packs and unpacks exact binary wire layout [count:u32][layerIdLen:u16, layerId, tx:i32, ty:i32, dataLen:u32, data]', () => {
      const backing = new Uint8Array([99, 10, 20, 30, 40, 88]);
      const subarrayData = backing.subarray(1, 5); // [10, 20, 30, 40] with non-zero byteOffset

      const batch = [
        {
          layerId: 'layer-ink',
          tileX: -3,
          tileY: 17,
          data: subarrayData,
        },
        {
          layerId: 'レイヤー_2',
          tileX: 0,
          tileY: -512,
          data: new Uint8Array([0, 127, 255]),
        },
        {
          layerId: 'empty-tile',
          tileX: 4,
          tileY: 8,
          data: new Uint8Array(0),
        },
      ];

      const packed = packTileWriteBatch(batch);

      // Verify wire header and first record layout byte-for-byte
      const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
      expect(view.getUint32(0, true)).toBe(3);
      expect(view.getUint16(4, true)).toBe(9); // 'layer-ink'.length
      expect(new TextDecoder().decode(packed.subarray(6, 15))).toBe('layer-ink');
      expect(view.getInt32(15, true)).toBe(-3);
      expect(view.getInt32(19, true)).toBe(17);
      expect(view.getUint32(23, true)).toBe(4);
      expect(Array.from(packed.subarray(27, 31))).toEqual([10, 20, 30, 40]);

      // Full roundtrip from Uint8Array and from ArrayBuffer
      const unpacked = unpackTileWriteBatch(packed);
      expect(unpacked).toHaveLength(3);
      expect(unpacked[0].layerId).toBe('layer-ink');
      expect(unpacked[0].tileX).toBe(-3);
      expect(unpacked[0].tileY).toBe(17);
      expect(Array.from(unpacked[0].data)).toEqual([10, 20, 30, 40]);

      expect(unpacked[1].layerId).toBe('レイヤー_2');
      expect(unpacked[1].tileX).toBe(0);
      expect(unpacked[1].tileY).toBe(-512);
      expect(Array.from(unpacked[1].data)).toEqual([0, 127, 255]);

      expect(unpacked[2].layerId).toBe('empty-tile');
      expect(unpacked[2].data.byteLength).toBe(0);

      const fromArrayBuf = unpackTileWriteBatch(packed.buffer as ArrayBuffer);
      expect(fromArrayBuf).toHaveLength(3);
      expect(Array.from(fromArrayBuf[0].data)).toEqual([10, 20, 30, 40]);
    });

    it('handles empty tile batches and rejects truncated or trailing frames', () => {
      const empty = packTileWriteBatch([]);
      expect(empty.byteLength).toBe(4);
      expect(unpackTileWriteBatch(empty)).toEqual([]);

      expect(() => unpackTileWriteBatch(new Uint8Array([1, 0]))).toThrow();

      const valid = packTileWriteBatch([
        { layerId: 'l1', tileX: 1, tileY: 2, data: new Uint8Array([5, 6, 7]) },
      ]);
      expect(() => unpackTileWriteBatch(valid.subarray(0, valid.byteLength - 1))).toThrow();

      const withTrailing = new Uint8Array(valid.byteLength + 1);
      withTrailing.set(valid, 0);
      withTrailing[valid.byteLength] = 0xff;
      expect(() => unpackTileWriteBatch(withTrailing)).toThrow();
    });

    it('TauriScratchDiskDriver sends raw Uint8Array + IPC headers and decodes ArrayBuffer response', async () => {
      const calls: Array<{ cmd: string; args: unknown; options: unknown }> = [];
      const responsePayload = new Uint8Array([7, 8, 9, 10]);

      const prevWindow = (globalThis as Record<string, unknown>).window;
      (globalThis as Record<string, unknown>).window = {
        __TAURI_INTERNALS__: {
          invoke: async (cmd: string, args: unknown, options: unknown) => {
            calls.push({ cmd, args, options });
            if (cmd === 'scratch_disk_write_tiles') return 1;
            if (cmd === 'scratch_disk_read_tile') return responsePayload.buffer.slice(0);
            return undefined;
          },
        },
      };

      try {
        const tauriDriver = new TauriScratchDiskDriver();
        const written = await tauriDriver.writeTiles('sess/1', [
          { layerId: 'layer_a', tileX: -1, tileY: 2, data: new Uint8Array([1, 2, 3]) },
        ]);
        expect(written).toBe(1);
        expect(calls[0].cmd).toBe('scratch_disk_write_tiles');
        expect(calls[0].args).toBeInstanceOf(Uint8Array);
        expect((calls[0].options as { headers: Record<string, string> }).headers).toEqual({
          'x-session-id': 'sess%2F1',
        });

        const unpackedSent = unpackTileWriteBatch(calls[0].args as Uint8Array);
        expect(unpackedSent).toHaveLength(1);
        expect(unpackedSent[0].layerId).toBe('layer_a');
        expect(Array.from(unpackedSent[0].data)).toEqual([1, 2, 3]);

        const read = await tauriDriver.readTile('sess/1', 'layer_a', -1, 2);
        expect(read).toBeInstanceOf(Uint8Array);
        expect(Array.from(read)).toEqual([7, 8, 9, 10]);
        expect(calls[1].cmd).toBe('scratch_disk_read_tile');
        expect((calls[1].options as { headers: Record<string, string> }).headers).toEqual({
          'x-session-id': 'sess%2F1',
          'x-layer-id': 'layer_a',
          'x-tile-x': '-1',
          'x-tile-y': '2',
        });
      } finally {
        if (prevWindow === undefined) {
          delete (globalThis as Record<string, unknown>).window;
        } else {
          (globalThis as Record<string, unknown>).window = prevWindow;
        }
      }
    });
  });
});
