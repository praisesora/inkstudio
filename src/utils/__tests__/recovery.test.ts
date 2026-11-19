import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeCrc32,
  formatWalFrame,
  parseWalFrames,
  WAL_ENTRY_STROKE_TILE_DELTA,
  WAL_ENTRY_VECTOR_STROKE,
  WAL_ENTRY_LAYER_MUTATION,
  recoveryService,
  RecoveryReplayData,
  packRecoveryCheckpointPayload,
  unpackRecoveryCheckpointPayload,
  encodeRecoveryReplayData,
  decodeRecoveryReplayData,
} from '../../services/recoveryService';
import {
  SparseTileGrid,
  serializeTileDeltas,
  serializeSparseTileGrid,
  deserializeSparseTileGrid,
} from '../tileEngine';
import { TileDelta } from '../../types/editor';
import { deflateSync } from 'fflate';

describe('Crash Recovery & WAL Architecture Engine', () => {
  describe('CRC32 & Binary Framing Headers', () => {
    it('computes standard IEEE 802.3 CRC32 checksums accurately', () => {
      const testVec = new TextEncoder().encode('123456789');
      const crc = computeCrc32(testVec);
      expect(crc).toBe(0xcbf43926);

      const emptyVec = new Uint8Array(0);
      expect(computeCrc32(emptyVec)).toBe(0x00000000);

      const simple = new Uint8Array([1, 2, 3, 4]);
      expect(computeCrc32(simple)).toBeGreaterThan(0);
    });

    it('serializes WAL frames with atomic 13-byte headers', () => {
      const payload = new Uint8Array([10, 20, 30, 40, 50]);
      const frame = formatWalFrame(WAL_ENTRY_STROKE_TILE_DELTA, payload);

      // Total length: 13 header + 5 payload = 18 bytes
      expect(frame.length).toBe(18);

      // Magic header 'INKW'
      expect(frame[0]).toBe(0x49); // 'I'
      expect(frame[1]).toBe(0x4e); // 'N'
      expect(frame[2]).toBe(0x4b); // 'K'
      expect(frame[3]).toBe(0x57); // 'W'

      // Entry type
      expect(frame[4]).toBe(WAL_ENTRY_STROKE_TILE_DELTA);

      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      // Payload length
      expect(view.getUint32(5, true)).toBe(5);

      // CRC32
      const expectedCrc = computeCrc32(payload);
      expect(view.getUint32(9, true)).toBe(expectedCrc);

      // Payload content
      expect(Array.from(frame.subarray(13))).toEqual([10, 20, 30, 40, 50]);
    });

    it('deserializes multiple contiguous valid WAL frames', () => {
      const p1 = new Uint8Array([1, 2, 3]);
      const p2 = new Uint8Array([4, 5, 6, 7]);
      const p3 = new Uint8Array([8, 9]);

      const f1 = formatWalFrame(WAL_ENTRY_STROKE_TILE_DELTA, p1);
      const f2 = formatWalFrame(WAL_ENTRY_VECTOR_STROKE, p2);
      const f3 = formatWalFrame(WAL_ENTRY_LAYER_MUTATION, p3);

      const combined = new Uint8Array(f1.length + f2.length + f3.length);
      combined.set(f1, 0);
      combined.set(f2, f1.length);
      combined.set(f3, f1.length + f2.length);

      const { validFrames, corruptedTail } = parseWalFrames(combined);

      expect(corruptedTail).toBe(false);
      expect(validFrames.length).toBe(3);

      expect(validFrames[0].entryType).toBe(WAL_ENTRY_STROKE_TILE_DELTA);
      expect(Array.from(validFrames[0].payload)).toEqual([1, 2, 3]);

      expect(validFrames[1].entryType).toBe(WAL_ENTRY_VECTOR_STROKE);
      expect(Array.from(validFrames[1].payload)).toEqual([4, 5, 6, 7]);

      expect(validFrames[2].entryType).toBe(WAL_ENTRY_LAYER_MUTATION);
      expect(Array.from(validFrames[2].payload)).toEqual([8, 9]);
    });

    it('safely discards incomplete tail chunks caused by crash mid-write', () => {
      const p1 = new Uint8Array([10, 20, 30]);
      const f1 = formatWalFrame(WAL_ENTRY_STROKE_TILE_DELTA, p1);

      const p2 = new Uint8Array([40, 50, 60, 70, 80]);
      const f2 = formatWalFrame(WAL_ENTRY_VECTOR_STROKE, p2);

      // Truncate f2 mid-write: include only 13 header bytes + 2 payload bytes (missing 3 bytes)
      const truncatedF2 = f2.subarray(0, 15);

      const combined = new Uint8Array(f1.length + truncatedF2.length);
      combined.set(f1, 0);
      combined.set(truncatedF2, f1.length);

      const { validFrames, corruptedTail } = parseWalFrames(combined);

      // Only the first complete frame is returned; truncated tail is safely discarded
      expect(validFrames.length).toBe(1);
      expect(validFrames[0].entryType).toBe(WAL_ENTRY_STROKE_TILE_DELTA);
      expect(Array.from(validFrames[0].payload)).toEqual([10, 20, 30]);
      expect(corruptedTail).toBe(true);
    });

    it('safely detects and discards corrupted tail chunk with CRC32 mismatch', () => {
      const p1 = new Uint8Array([100, 101, 102]);
      const f1 = formatWalFrame(WAL_ENTRY_STROKE_TILE_DELTA, p1);

      const p2 = new Uint8Array([200, 201, 202, 203]);
      const f2 = formatWalFrame(WAL_ENTRY_STROKE_TILE_DELTA, p2);

      // Corrupt a byte in f2's payload without updating CRC
      f2[14] = 99; // corrupt payload byte

      const combined = new Uint8Array(f1.length + f2.length);
      combined.set(f1, 0);
      combined.set(f2, f1.length);

      const { validFrames, corruptedTail } = parseWalFrames(combined);

      expect(validFrames.length).toBe(1);
      expect(validFrames[0].entryType).toBe(WAL_ENTRY_STROKE_TILE_DELTA);
      expect(Array.from(validFrames[0].payload)).toEqual([100, 101, 102]);
      expect(corruptedTail).toBe(true);
    });
  });

  describe('Replay Ordering Logic on Sparse Tile Grids', () => {
    let grid: SparseTileGrid;

    beforeEach(() => {
      grid = new SparseTileGrid();
    });

    it('serializes and deserializes baseline snapshots accurately', () => {
      const img1 = new Uint8ClampedArray(256 * 256 * 4);
      img1[0] = 255; // Red pixel at (0, 0)
      img1[3] = 255;
      grid.writeImageData('layer-1', { data: img1, width: 256, height: 256 }, 0, 0, 'color-32bit');

      const img2 = new Uint8ClampedArray(256 * 256 * 4);
      img2[1] = 255; // Green pixel at (256, 256)
      img2[3] = 255;
      grid.writeImageData('layer-2', { data: img2, width: 256, height: 256 }, 256, 256, 'color-32bit');

      const snapshotBytes = serializeSparseTileGrid(grid);
      expect(snapshotBytes.length).toBeGreaterThan(0);

      const newGrid = new SparseTileGrid();
      deserializeSparseTileGrid(newGrid, snapshotBytes);

      expect(newGrid.hasTile('layer-1', 0, 0)).toBe(true);
      expect(newGrid.hasTile('layer-2', 1, 1)).toBe(true);
      expect(newGrid.hasTile('layer-1', 1, 1)).toBe(false);

      const tile1 = newGrid.getTile('layer-1', 0, 0);
      expect(tile1?.data![0]).toBe(255);
      expect(tile1?.data![3]).toBe(255);

      const tile2 = newGrid.getTile('layer-2', 1, 1);
      expect(tile2?.data![1]).toBe(255);
      expect(tile2?.data![3]).toBe(255);
    });

    it('replays baseline snapshot followed by sequential WAL stroke deltas in exact order', () => {
      // Step 1: Base state at tile (0, 0)
      const baseData = new Uint8ClampedArray(256 * 256 * 4);
      baseData[0] = 50;
      baseData[3] = 255;
      grid.writeImageData('layer-art', { data: baseData, width: 256, height: 256 }, 0, 0, 'color-32bit');

      const baseSnapshot = serializeSparseTileGrid(grid);

      // Step 2: Stroke 1 modifies pixel 0 to 120
      const stroke1After = new Uint8Array(256 * 256 * 4);
      stroke1After[0] = 120;
      stroke1After[3] = 255;
      const stroke1Delta: TileDelta = {
        key: 'layer-art:0:0',
        format: 'color-32bit',
        beforeData: new Uint8Array(baseData),
        afterData: stroke1After,
      };

      // Step 3: Stroke 2 modifies pixel 0 to 240 and pixel 1 to 180
      const stroke2After = new Uint8Array(256 * 256 * 4);
      stroke2After[0] = 240;
      stroke2After[1] = 180;
      stroke2After[3] = 255;
      const stroke2Delta: TileDelta = {
        key: 'layer-art:0:0',
        format: 'color-32bit',
        beforeData: stroke1After,
        afterData: stroke2After,
      };

      // Package deltas with deflate
      const walPayload1 = deflateSync(serializeTileDeltas([stroke1Delta]));
      const walPayload2 = deflateSync(serializeTileDeltas([stroke2Delta]));

      const replayData: RecoveryReplayData = {
        session_id: 'test-session-123',
        manifest_json: JSON.stringify({
          sessionId: 'test-session-123',
          documentName: 'Manga Page 1',
          width: 3000,
          height: 3000,
          dpi: 600,
          colorMode: 'color',
          layers: [{ id: 'layer-art', name: 'Lineart', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: false, parentId: null }],
          activeLayerId: 'layer-art',
          timestamp: Date.now(),
        }),
        base_snapshot: baseSnapshot,
        wal_entries: [
          { entry_type: WAL_ENTRY_STROKE_TILE_DELTA, payload: walPayload1 },
          { entry_type: WAL_ENTRY_STROKE_TILE_DELTA, payload: walPayload2 },
        ],
      };

      // Target empty grid to simulate fresh launch after crash
      const targetGrid = new SparseTileGrid();
      const result = recoveryService.replaySessionData(replayData, targetGrid);

      expect(result.replayedStrokesCount).toBe(2);
      expect(result.manifest.documentName).toBe('Manga Page 1');
      expect(result.manifest.width).toBe(3000);

      // Verify final tile state reflects sequential stroke application (Stroke 2 was applied after Stroke 1)
      const tile = targetGrid.getTile('layer-art', 0, 0);
      expect(tile).not.toBeNull();
      expect(tile?.data![0]).toBe(240);
      expect(tile?.data![1]).toBe(180);
      expect(tile?.data![3]).toBe(255);
    });

    it('correctly handles layer mutations and vector strokes during WAL replay', () => {
      const manifest = {
        sessionId: 'test-session-vec',
        documentName: 'Vector Manga',
        width: 2000,
        height: 2000,
        dpi: 300,
        colorMode: 'color' as const,
        layers: [
          { id: 'layer-vec', name: 'Vector 1', type: 'vector' as const, visible: true, opacity: 1, blendMode: 'normal' as const, locked: false, parentId: null, vectorStrokes: [] },
        ],
        activeLayerId: 'layer-vec',
        timestamp: Date.now(),
      };

      // 1. Vector stroke entry
      const vecStroke = {
        id: 'stroke-1',
        layerId: 'layer-vec',
        tool: 'brush',
        knots: [{ x: 10, y: 10, pressure: 0.5, width: 5, timestamp: 100 }],
        color: '#000000',
        baseWidth: 5,
        opacity: 1,
        bounds: { minX: 10, minY: 10, maxX: 10, maxY: 10 },
      };
      const vecPayload = deflateSync(new TextEncoder().encode(JSON.stringify({ layerId: 'layer-vec', strokes: [vecStroke] })));

      // 2. Layer mutation entry (added a new background layer)
      const mutationPayload = deflateSync(new TextEncoder().encode(JSON.stringify({
        mutationType: 'add-layer',
        layers: [
          { id: 'layer-bg', name: 'Background', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: false, parentId: null },
          manifest.layers[0],
        ],
        activeLayerId: 'layer-bg',
      })));

      const replayData: RecoveryReplayData = {
        session_id: 'test-session-vec',
        manifest_json: JSON.stringify(manifest),
        base_snapshot: null,
        wal_entries: [
          { entry_type: WAL_ENTRY_VECTOR_STROKE, payload: vecPayload },
          { entry_type: WAL_ENTRY_LAYER_MUTATION, payload: mutationPayload },
        ],
      };

      const targetGrid = new SparseTileGrid();
      const result = recoveryService.replaySessionData(replayData, targetGrid);

      expect(result.replayedStrokesCount).toBe(1);
      expect(result.replayedMutationsCount).toBe(1);
      expect(result.manifest.layers.length).toBe(2);
      expect(result.manifest.layers[0].id).toBe('layer-bg');

      const vecLayer = result.manifest.layers.find((l) => l.id === 'layer-vec');
      expect(vecLayer?.vectorStrokes?.length).toBe(1);
      expect(vecLayer?.vectorStrokes?.[0].id).toBe('stroke-1');
    });

    it('simulates hard kill crash after 15 strokes on 3000x3000 canvas with 3 layers and partial tail discard', () => {
      // 1. Initial 3000x3000 canvas with 3 layers
      const originalGrid = new SparseTileGrid();
      const layers = [
        { id: 'layer-bg', name: 'Paper', type: 'raster' as const, visible: true, opacity: 1, blendMode: 'normal' as const, locked: false, parentId: null },
        { id: 'layer-sketch', name: 'Rough Sketch', type: 'raster' as const, visible: true, opacity: 0.6, blendMode: 'normal' as const, locked: false, parentId: null },
        { id: 'layer-ink', name: 'Line Ink', type: 'raster' as const, visible: true, opacity: 1, blendMode: 'normal' as const, locked: false, parentId: null },
      ];

      // Fill background layer with white
      const bgData = new Uint8ClampedArray(256 * 256 * 4);
      bgData.fill(255);
      originalGrid.writeImageData('layer-bg', { data: bgData, width: 256, height: 256 }, 0, 0, 'color-32bit');

      // 2. Draw 10 strokes on 'layer-sketch'
      for (let i = 0; i < 10; i++) {
        const strokeData = new Uint8ClampedArray(256 * 256 * 4);
        strokeData[i * 4] = (i + 1) * 20; // Distinct pixel values
        strokeData[i * 4 + 3] = 255;
        originalGrid.writeImageData('layer-sketch', { data: strokeData, width: 256, height: 256 }, 0, 0, 'color-32bit');
      }

      // 3. Trigger periodic checkpoint after stroke 10
      const baselineSnapshot = serializeSparseTileGrid(originalGrid);

      // 4. Draw strokes 11 to 15 on 'layer-ink' (these generate WAL delta entries)
      const walFrames: Uint8Array[] = [];
      const deltaBuffers: TileDelta[][] = [];

      for (let i = 10; i < 15; i++) {
        const beforeTile = originalGrid.getTile('layer-ink', 0, 0);
        const beforeData = beforeTile && beforeTile.data ? new Uint8Array(beforeTile.data) : new Uint8Array(256 * 256 * 4);

        const afterData = new Uint8Array(beforeData);
        afterData[(i - 10) * 16] = 255; // Stroke mark
        afterData[(i - 10) * 16 + 1] = (i + 1) * 15;
        afterData[(i - 10) * 16 + 3] = 255;

        originalGrid.writeImageData('layer-ink', { data: new Uint8ClampedArray(afterData), width: 256, height: 256 }, 0, 0, 'color-32bit');

        const delta: TileDelta = {
          key: 'layer-ink:0:0',
          format: 'color-32bit',
          beforeData,
          afterData,
        };
        deltaBuffers.push([delta]);

        const compressed = deflateSync(serializeTileDeltas([delta]));
        const frame = formatWalFrame(WAL_ENTRY_STROKE_TILE_DELTA, compressed);
        walFrames.push(frame);
      }

      // 5. Simulate sudden force kill mid-write on stroke 16 (incomplete WAL frame tail)
      const corruptedPartialFrame = new Uint8Array([0x49, 0x4e, 0x4b, 0x57, 0x01, 0x20, 0x00, 0x00, 0x00, 0x12, 0x34]); // Incomplete 11 bytes

      // Assemble binary journal.wal
      const totalWalLen = walFrames.reduce((acc, f) => acc + f.length, 0) + corruptedPartialFrame.length;
      const journalWal = new Uint8Array(totalWalLen);
      let offset = 0;
      for (const f of walFrames) {
        journalWal.set(f, offset);
        offset += f.length;
      }
      journalWal.set(corruptedPartialFrame, offset);

      // 6. Next launch: Parse journal.wal
      const { validFrames, corruptedTail } = parseWalFrames(journalWal);
      expect(corruptedTail).toBe(true);
      expect(validFrames.length).toBe(5); // Strokes 11-15 recovered; stroke 16 safely discarded

      // 7. Replay session data
      const replayData: RecoveryReplayData = {
        session_id: 'crash-hard-kill-session',
        manifest_json: JSON.stringify({
          sessionId: 'crash-hard-kill-session',
          documentName: 'Acceptance Manga',
          width: 3000,
          height: 3000,
          dpi: 600,
          colorMode: 'color',
          layers,
          activeLayerId: 'layer-ink',
          timestamp: Date.now(),
        }),
        base_snapshot: baselineSnapshot,
        wal_entries: validFrames.map((f) => ({ entry_type: f.entryType, payload: f.payload })),
      };

      const restoredGrid = new SparseTileGrid();
      const replayResult = recoveryService.replaySessionData(replayData, restoredGrid);

      expect(replayResult.replayedStrokesCount).toBe(5);
      expect(replayResult.manifest.documentName).toBe('Acceptance Manga');
      expect(replayResult.manifest.width).toBe(3000);
      expect(replayResult.manifest.height).toBe(3000);
      expect(replayResult.manifest.dpi).toBe(600);
      expect(replayResult.manifest.layers.length).toBe(3);

      // Verify pixel-for-pixel accuracy on restoredGrid against originalGrid
      const restoredBg = restoredGrid.getTile('layer-bg', 0, 0);
      const originalBg = originalGrid.getTile('layer-bg', 0, 0);
      expect(restoredBg?.data).toEqual(originalBg?.data);

      const restoredSketch = restoredGrid.getTile('layer-sketch', 0, 0);
      const originalSketch = originalGrid.getTile('layer-sketch', 0, 0);
      expect(restoredSketch?.data).toEqual(originalSketch?.data);

      const restoredInk = restoredGrid.getTile('layer-ink', 0, 0);
      const originalInk = originalGrid.getTile('layer-ink', 0, 0);
      expect(restoredInk?.data).toEqual(originalInk?.data);
    });
  });

  describe('Binary IPC Framing for Checkpoints and Session Replay', () => {
    it('packs and unpacks checkpoint binary frames losslessly', () => {
      const manifest = JSON.stringify({ documentName: 'Page 1', width: 2480 });
      const snapshot = new Uint8Array([1, 2, 3, 250, 255]);
      const thumb = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

      const packed = packRecoveryCheckpointPayload(manifest, snapshot, thumb);
      const unpacked = unpackRecoveryCheckpointPayload(packed);

      expect(unpacked.manifestJson).toBe(manifest);
      expect(Array.from(unpacked.baseSnapshot)).toEqual([1, 2, 3, 250, 255]);
      expect(Array.from(unpacked.thumbnailPng)).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(() => unpackRecoveryCheckpointPayload(packed.subarray(0, packed.length - 1))).toThrow();
    });

    it('encodes and decodes INKR binary replay responses without JSON byte arrays', () => {
      const replay: RecoveryReplayData = {
        session_id: 'sess-bin-1',
        manifest_json: '{"width":1024}',
        base_snapshot: new Uint8Array([10, 20, 30]),
        wal_entries: [
          { entry_type: WAL_ENTRY_STROKE_TILE_DELTA, payload: new Uint8Array([1, 2, 3, 4]) },
          { entry_type: WAL_ENTRY_LAYER_MUTATION, payload: new Uint8Array([99]) },
        ],
      };

      const encoded = encodeRecoveryReplayData(replay);
      const decoded = decodeRecoveryReplayData(encoded.buffer as ArrayBuffer);

      expect(decoded.session_id).toBe('sess-bin-1');
      expect(decoded.manifest_json).toBe('{"width":1024}');
      expect(decoded.base_snapshot).toBeInstanceOf(Uint8Array);
      expect(Array.from(decoded.base_snapshot as Uint8Array)).toEqual([10, 20, 30]);
      expect(decoded.wal_entries).toHaveLength(2);
      expect(decoded.wal_entries[0].entry_type).toBe(WAL_ENTRY_STROKE_TILE_DELTA);
      expect(Array.from(decoded.wal_entries[0].payload as Uint8Array)).toEqual([1, 2, 3, 4]);
      expect(decoded.wal_entries[1].entry_type).toBe(WAL_ENTRY_LAYER_MUTATION);
      expect(Array.from(decoded.wal_entries[1].payload as Uint8Array)).toEqual([99]);

      const emptySnapEncoded = encodeRecoveryReplayData({
        session_id: 'sess-empty',
        manifest_json: '{}',
        base_snapshot: null,
        wal_entries: [],
      });
      const emptySnapDecoded = decodeRecoveryReplayData(emptySnapEncoded);
      expect(emptySnapDecoded.base_snapshot).toBeNull();
      expect(emptySnapDecoded.wal_entries).toEqual([]);
    });
  });
});
