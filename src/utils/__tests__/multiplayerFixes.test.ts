import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  multiplayerService,
  parseInviteUrl,
  BINARY_MAGIC_0,
  BINARY_MAGIC_1,
  CODE_TILE_DELTA,
  CODE_STROKE_START,
  CODE_STROKE_CHUNK,
  CODE_BRUSH_ASSET_DATA,
  CODE_BRUSH_ASSET_REQUEST,
} from '../../services/multiplayerService';
import { lz4CompressBlock, lz4DecompressBlock } from '../lz4';
import {
  BYTES_32BIT,
  SparseTileGrid,
  TILE_CODEC_EMPTY,
  TILE_CODEC_LZ4,
  createTileBuffer,
  deserializeTileBufferStrict,
  serializeTileBuffer,
  setPixel1Bit,
} from '../tileEngine';
import {
  computeBrushAssetHash,
  hydrateBrushSettingsFromHashes,
  prepareBrushSettingsForWire,
  registerRemoteBrushAsset,
  resetBrushAssetCache,
} from '../brushAssetSync';
import { StrokePipeline } from '../../engine/StrokePipeline';
import { RemoteStrokeSession } from '../../engine/RemoteStrokeRenderer';
import type { BrushSettings, Point } from '../../types/editor';
import type { CubicBezierSegment } from '../../engine/SplineGenerator';

// Minimal valid 1x1 PNG encoded as base64
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_B64}`;

describe('Multiplayer Invite URL Parsing', () => {
  it('parses worldwide Cloudflare HTTPS invite links with secure flag and port 443', () => {
    const parsed = parseInviteUrl(
      'https://warm-ink-42.trycloudflare.com/?room=My%20Canvas&token=abc123'
    );
    expect(parsed).toEqual({
      roomName: 'My Canvas',
      host: 'warm-ink-42.trycloudflare.com',
      port: 443,
      url: 'https://warm-ink-42.trycloudflare.com/?room=My%20Canvas&token=abc123',
      token: 'abc123',
      isSecure: true,
    });
  });

  it('parses local LAN HTTP invite links with explicit port', () => {
    const parsed = parseInviteUrl('http://192.168.1.42:30303/?room=LAN%20Room&token=tok999');
    expect(parsed).toEqual({
      roomName: 'LAN Room',
      host: '192.168.1.42',
      port: 30303,
      url: 'http://192.168.1.42:30303/?room=LAN%20Room&token=tok999',
      token: 'tok999',
      isSecure: false,
    });
  });

  it('parses inkstudio:// deep links and rejects legacy forsora:// scheme', () => {
    const parsed = parseInviteUrl(
      'inkstudio://join?host=cool-cat.trycloudflare.com&port=443&room=Collab&token=xyz&protocol=https'
    );
    expect(parsed).toMatchObject({
      roomName: 'Collab',
      host: 'cool-cat.trycloudflare.com',
      port: 443,
      token: 'xyz',
      isSecure: true,
    });

    expect(
      parseInviteUrl(
        'forsora://join?host=cool-cat.trycloudflare.com&port=443&room=Collab&token=xyz&protocol=https'
      )
    ).toBeNull();
  });

  it('rejects invalid or non-room URLs', () => {
    expect(parseInviteUrl('')).toBeNull();
    expect(parseInviteUrl('not-a-url')).toBeNull();
    expect(parseInviteUrl('https://example.com/no-room')).toBeNull();
    expect(parseInviteUrl('javascript:alert(1)')).toBeNull();
  });
});

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe('LZ4 Block Codec & BINARY_TILE Serialization', () => {
  it('compresses and decompresses 256KB RGBA solid-fill tiles with high ratio and exact equality', () => {
    const raw = new Uint8Array(BYTES_32BIT);
    for (let i = 0; i < raw.length; i += 4) {
      raw[i] = 0x1a;
      raw[i + 1] = 0x73;
      raw[i + 2] = 0xe8;
      raw[i + 3] = 0xff;
    }

    const compressed = lz4CompressBlock(raw);
    expect(compressed.byteLength).toBeLessThan(2048);

    const restored = lz4DecompressBlock(compressed, BYTES_32BIT);
    expect(restored).not.toBeNull();
    expect(restored!.byteLength).toBe(BYTES_32BIT);
    expect(bytesEqual(restored!, raw)).toBe(true);
  });

  it('handles tiny, empty, patterned, and incompressible random buffers losslessly', () => {
    expect(lz4DecompressBlock(lz4CompressBlock(new Uint8Array(0)), 0)).toEqual(new Uint8Array(0));

    const tiny = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    expect(lz4DecompressBlock(lz4CompressBlock(tiny), tiny.length)).toEqual(tiny);

    // Pseudo-random incompressible 8KB buffer
    const noisy = new Uint8Array(8192);
    let seed = 0x12345678;
    for (let i = 0; i < noisy.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      noisy[i] = (seed >>> 24) & 0xff;
    }
    expect(lz4DecompressBlock(lz4CompressBlock(noisy), noisy.length)).toEqual(noisy);
  });

  it('rejects malformed or malicious LZ4 payloads (bounds & offset checks)', () => {
    // Zero offset attack
    const zeroOffset = new Uint8Array([0x10, 0xaa, 0x00, 0x00]);
    expect(lz4DecompressBlock(zeroOffset, 10)).toBeNull();

    // Offset larger than already decoded output
    const badOffset = new Uint8Array([0x10, 0xaa, 0x05, 0x00]);
    expect(lz4DecompressBlock(badOffset, 10)).toBeNull();

    // Output overflow / LZ4 bomb beyond declared size
    const valid = lz4CompressBlock(new Uint8Array(1024));
    expect(lz4DecompressBlock(valid, 16)).toBeNull();
    expect(lz4DecompressBlock(valid, 10 * 1024 * 1024, BYTES_32BIT)).toBeNull();
  });

  it('serializes populated tiles with LZ4 and deleted tiles as 14-byte tombstones', () => {
    const tile = createTileBuffer('layer-1', 3, 4, 'monochrome-1bit');
    setPixel1Bit(tile.data!, 12, 18, true);
    const packet = serializeTileBuffer(tile);
    expect(packet[13]).toBe(TILE_CODEC_LZ4);
    expect(packet.byteLength).toBeLessThan(100);

    const decoded = deserializeTileBufferStrict('layer-1', packet);
    expect(decoded).not.toBeNull();
    expect(decoded!.tileX).toBe(3);
    expect(decoded!.tileY).toBe(4);
    expect(decoded!.data).toEqual(tile.data);

    // Tombstone for deleted/cleared tile
    const tombstone = serializeTileBuffer({
      ...tile,
      data: null,
    });
    expect(tombstone.byteLength).toBe(14);
    expect(tombstone[13]).toBe(TILE_CODEC_EMPTY);
    const decodedTomb = deserializeTileBufferStrict('layer-1', tombstone);
    expect(decodedTomb).not.toBeNull();
    expect(decodedTomb!.data).toBeNull();

    // Corrupt tile packet is dropped strictly
    const corrupt = packet.slice();
    corrupt[13] = 0xfe;
    expect(deserializeTileBufferStrict('layer-1', corrupt)).toBeNull();
  });
});

describe('Brush Asset Synchronization via Content Hash', () => {
  beforeEach(() => {
    resetBrushAssetCache();
  });

  it('strips inline base64 data URLs from BrushSettings and emits deterministic hash refs', () => {
    const bs: BrushSettings = {
      size: 16,
      minSizeFactor: 0.1,
      color: '#112233',
      opacity: 0.85,
      flow: 0.9,
      spacing: 0.08,
      usePressure: true,
      smoothing: true,
      stabilization: 10,
      hardness: 0.8,
      customTipDataUrl: TINY_PNG_DATA_URL,
      paperTexture: TINY_PNG_DATA_URL,
    };

    const { wireSettings, assetRefs, assets } = prepareBrushSettingsForWire(bs);
    expect(wireSettings.customTipDataUrl).toBeUndefined();
    expect(wireSettings.paperTexture).toBeUndefined();
    expect(wireSettings.customTipImage).toBeUndefined();
    expect(assetRefs?.tipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(assetRefs?.paperTextureHash).toBe(assetRefs?.tipHash);
    // Identical tip and paper texture deduplicate to a single binary asset
    expect(assets.length).toBe(1);
    expect(computeBrushAssetHash(assets[0].bytes)).toBe(assetRefs!.tipHash);
  });

  it('enforces hash integrity and MIME whitelist on remote brush assets', () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const validHash = computeBrushAssetHash(bytes);

    // Reject tampered hash
    expect(registerRemoteBrushAsset('0'.repeat(32), 'image/png', bytes)).toBe(false);
    // Reject SVG XSS vector
    expect(registerRemoteBrushAsset(validHash, 'image/svg+xml', bytes)).toBe(false);
    // Accept valid hash + allowed MIME
    expect(registerRemoteBrushAsset(validHash, 'image/png', bytes)).toBe(true);

    // Missing hash is reported for on-demand BRUSH_ASSET_REQUEST
    const { missingHashes } = hydrateBrushSettingsFromHashes(
      {
        size: 10,
        minSizeFactor: 0.2,
        color: '#000',
        opacity: 1,
        flow: 1,
        spacing: 0.1,
        usePressure: true,
        smoothing: false,
        stabilization: 0,
        hardness: 1,
      },
      { tipHash: 'f'.repeat(32) }
    );
    expect(missingHashes).toEqual(['f'.repeat(32)]);
  });
});

describe('Multiplayer Binary Protocol & Deterministic Remote StrokePipeline', () => {
  beforeEach(() => {
    resetBrushAssetCache();
  });

  it('decodes STROKE_START (with asset hashes, zero base64), STROKE_CHUNK (tilt/corner), BRUSH_ASSET_DATA, and BINARY_TILE', () => {
    const sentPackets: Uint8Array[] = [];
    const toArrayBuffer = (u8: Uint8Array): ArrayBuffer =>
      u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
    const sendSpy = vi
      .spyOn(multiplayerService, 'sendBinary')
      .mockImplementation((buf) => {
        sentPackets.push(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
      });
    const connSpy = vi.spyOn(multiplayerService, 'isConnected').mockReturnValue(true);
    (multiplayerService as unknown as { currentPeer: unknown }).currentPeer = {
      id: 'peer-a',
      name: 'Alice',
      color: '#ff0000',
    };
    multiplayerService.clearSentAssetHashes();

    const bs: BrushSettings = {
      size: 12,
      minSizeFactor: 0.1,
      color: '#224466',
      opacity: 0.8,
      flow: 0.9,
      spacing: 0.08,
      usePressure: true,
      smoothing: true,
      stabilization: 10,
      hardness: 0.9,
      customTipDataUrl: TINY_PNG_DATA_URL,
    };

    multiplayerService.sendStrokeStart('s-1', 'layer-1', bs, 'brush', {
      x: 10,
      y: 20,
      pressure: 0.7,
      width: 9,
    });

    // First packet must be binary BRUSH_ASSET_DATA, second is stripped STROKE_START
    expect(sentPackets.length).toBe(2);
    expect(sentPackets[0][0]).toBe(BINARY_MAGIC_0);
    expect(sentPackets[0][1]).toBe(BINARY_MAGIC_1);
    expect(sentPackets[0][2]).toBe(CODE_BRUSH_ASSET_DATA);
    expect(sentPackets[1][2]).toBe(CODE_STROKE_START);

    const decodedAsset = multiplayerService.decodeBinaryPacket(toArrayBuffer(sentPackets[0]));
    expect(decodedAsset?.type).toBe('BRUSH_ASSET_DATA');
    const decodedStart = multiplayerService.decodeBinaryPacket(toArrayBuffer(sentPackets[1]));
    expect(decodedStart?.type).toBe('STROKE_START');
    if (decodedStart?.type === 'STROKE_START') {
      expect(decodedStart.brushSettings.customTipDataUrl).toBeUndefined();
      expect(decodedStart.brushAssetRefs?.tipHash).toMatch(/^[0-9a-f]{32}$/);
    }

    // Second stroke with same brush does NOT re-send BRUSH_ASSET_DATA
    sentPackets.length = 0;
    multiplayerService.sendStrokeStart('s-2', 'layer-1', bs, 'brush', {
      x: 15,
      y: 25,
      pressure: 0.6,
      width: 8,
    });
    expect(sentPackets.length).toBe(1);
    expect(sentPackets[0][2]).toBe(CODE_STROKE_START);

    // STROKE_CHUNK preserves tilt, twist, and corner flags
    sentPackets.length = 0;
    multiplayerService.sendStrokeChunk('s-2', [
      { x: 20, y: 30, pressure: 0.8, width: 10, tiltX: -25, tiltY: 40, twist: 90, isCorner: true },
    ]);
    expect(sentPackets[0][2]).toBe(CODE_STROKE_CHUNK);
    const decodedChunk = multiplayerService.decodeBinaryPacket(toArrayBuffer(sentPackets[0]));
    expect(decodedChunk?.type).toBe('STROKE_CHUNK');
    if (decodedChunk?.type === 'STROKE_CHUNK') {
      expect(decodedChunk.points[0].tiltX).toBe(-25);
      expect(decodedChunk.points[0].tiltY).toBe(40);
      expect(decodedChunk.points[0].isCorner).toBe(true);
    }

    // BRUSH_ASSET_REQUEST round-trip
    sentPackets.length = 0;
    const reqHash = 'a'.repeat(32);
    multiplayerService.sendBrushAssetRequest(reqHash, 'peer-b');
    expect(sentPackets[0][2]).toBe(CODE_BRUSH_ASSET_REQUEST);
    const decodedReq = multiplayerService.decodeBinaryPacket(toArrayBuffer(sentPackets[0]));
    expect(decodedReq).toMatchObject({
      type: 'BRUSH_ASSET_REQUEST',
      hash: reqHash,
      targetPeerId: 'peer-b',
    });

    // sendTileDeltas broadcasts LZ4 BINARY_TILEs and deduplicates identical delta batches
    const grid = new SparseTileGrid();
    const beforeSnap = grid.snapshotTilesInRect('layer-1', { x: 0, y: 0, width: 32, height: 32 });
    const img = { data: new Uint8ClampedArray(32 * 32 * 4).fill(200), width: 32, height: 32 };
    grid.writeImageData('layer-1', img, 0, 0, 'color-32bit');
    const deltas = grid.computeDeltasFromSnapshot(beforeSnap, 'layer-1');

    sentPackets.length = 0;
    multiplayerService.sendTileDeltas(deltas, grid);
    expect(sentPackets.length).toBe(1);
    expect(sentPackets[0][2]).toBe(CODE_TILE_DELTA);

    // Calling again with same batch is an idempotent no-op
    multiplayerService.sendTileDeltas(deltas, grid);
    expect(sentPackets.length).toBe(1);

    // Decoded BINARY_TILE restores exact tile pixels
    const decodedTile = multiplayerService.decodeBinaryPacket(toArrayBuffer(sentPackets[0]));
    expect(decodedTile?.type).toBe('BINARY_TILE');
    if (decodedTile?.type === 'BINARY_TILE') {
      expect(decodedTile.layerId).toBe('layer-1');
      expect(decodedTile.tileX).toBe(0);
      expect(decodedTile.tileY).toBe(0);
      expect(bytesEqual(decodedTile.data!, grid.getTile('layer-1', 0, 0, 0)!.data!)).toBe(true);
    }

    sendSpy.mockRestore();
    connSpy.mockRestore();
    (multiplayerService as unknown as { currentPeer: unknown }).currentPeer = null;
  });

  it('produces identical cubic Bezier spline geometry via StrokePipeline.pushStabilizedKnot', () => {
    const pts: Point[] = [
      { x: 10, y: 10, pressure: 0.5, width: 5, timestamp: 0 },
      { x: 30, y: 14, pressure: 0.7, width: 7, timestamp: 16 },
      { x: 60, y: 35, pressure: 0.9, width: 9, timestamp: 32 },
      { x: 95, y: 30, pressure: 0.6, width: 6, timestamp: 48, isCorner: true },
      { x: 110, y: 80, pressure: 0.4, width: 4, timestamp: 64 },
    ];

    const pipeA = new StrokePipeline();
    const pipeB = new StrokePipeline();
    const segsA: CubicBezierSegment[] = [];
    const segsB: CubicBezierSegment[] = [];

    pipeA.beginStroke({ stabilizerLevel: 0, sharpCorners: true, brushSize: 10, color: '#000' });
    pipeB.beginStroke({ stabilizerLevel: 0, sharpCorners: true, brushSize: 10, color: '#000' });
    pipeA.seedKnot(pts[0].x, pts[0].y, pts[0].pressure, pts[0].width, 0, 0, 0, 0, 16);
    pipeB.seedKnot(pts[0].x, pts[0].y, pts[0].pressure, pts[0].width, 0, 0, 0, 0, 16);

    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      pipeA.pushStabilizedKnot(p.x, p.y, p.pressure, p.width, 0, 0, 0, p.timestamp!, Boolean(p.isCorner), 16, (s) => {
        segsA.push({ p0: { ...s.p0 }, c1: { ...s.c1 }, c2: { ...s.c2 }, p3: { ...s.p3 } });
      });
      pipeB.pushStabilizedKnot(p.x, p.y, p.pressure, p.width, 0, 0, 0, p.timestamp!, Boolean(p.isCorner), 16, (s) => {
        segsB.push({ p0: { ...s.p0 }, c1: { ...s.c1 }, c2: { ...s.c2 }, p3: { ...s.p3 } });
      });
    }

    expect(segsA.length).toBeGreaterThanOrEqual(3);
    expect(segsA).toEqual(segsB);
  });

  it('RemoteStrokeSession requests missing brush asset hashes and keeps preview decoupled from SparseTileGrid', () => {
    const requested: string[] = [];
    const missingHash = 'b'.repeat(32);

    const session = new RemoteStrokeSession({
      strokeId: 'remote-1',
      peerId: 'peer-2',
      layerId: 'layer-1',
      tool: 'brush',
      brushSettings: {
        size: 10,
        minSizeFactor: 0.2,
        color: '#000000',
        opacity: 1,
        flow: 1,
        spacing: 0.08,
        usePressure: true,
        smoothing: true,
        stabilization: 0,
        hardness: 1,
        useGpu: true,
      },
      brushAssetRefs: { tipHash: missingHash },
      startPoint: { x: 10, y: 10, pressure: 0.8, width: 8 },
      colorMode: 'color',
      onRequestAsset: (h) => requested.push(h),
    });

    expect(requested).toEqual([missingHash]);
    session.start(undefined);
    session.appendChunk(
      [
        { x: 20, y: 20, pressure: 0.8, width: 8 },
        { x: 35, y: 25, pressure: 0.7, width: 7 },
      ],
      undefined
    );
    expect(session.getPoints().length).toBe(3);
    session.dispose(undefined);
    expect(session.getPoints().length).toBe(0);
  });
});
