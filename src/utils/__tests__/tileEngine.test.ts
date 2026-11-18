import { describe, it, expect, beforeEach } from 'vitest';
import {
  SparseTileGrid,
  TILE_SIZE,
  BYTES_1BIT,
  BYTES_8BIT,
  BYTES_32BIT,
  createTileBuffer,
  setPixel1Bit,
  getPixel1Bit,
  packRGBATo1Bit,
  unpack1BitToRGBA,
  serializeTileBuffer,
  deserializeTileBuffer,
  serializeTileDeltas,
  deserializeTileDeltas,
} from '../tileEngine';

describe('Sparse Virtual Tile Engine', () => {
  let grid: SparseTileGrid;

  beforeEach(() => {
    grid = new SparseTileGrid();
  });

  it('allocates zero memory for unpainted canvas space', () => {
    // Canvas is B4 @ 600 DPI: 4961 x 7016 px
    const stats = grid.getMemoryStats();
    expect(stats.tileCount).toBe(0);
    expect(stats.totalBytes).toBe(0);

    // Query unpainted tile
    const tile = grid.getTile('layer-1', 10, 15);
    expect(tile).toBeNull();
  });

  it('correctly creates 1-bit monochrome tiles consuming exactly 8,192 bytes', () => {
    const tile = createTileBuffer('layer-1', 0, 0, 'monochrome-1bit');
    expect(tile.data!.byteLength).toBe(BYTES_1BIT);
    expect(tile.data!.byteLength).toBe(8192);

    // Verify 32x memory reduction compared to 32-bit RGBA
    expect(BYTES_32BIT / BYTES_1BIT).toBe(32);
  });

  it('correctly creates 8-bit grayscale tiles consuming exactly 65,536 bytes', () => {
    const tile = createTileBuffer('layer-1', 0, 0, 'grayscale-8bit');
    expect(tile.data!.byteLength).toBe(BYTES_8BIT);
    expect(tile.data!.byteLength).toBe(65536);
  });

  it('supports bitwise 1-bit pixel read and write', () => {
    const tile = createTileBuffer('layer-1', 0, 0, 'monochrome-1bit');

    // Initially 0
    expect(getPixel1Bit(tile.data!, 0, 0)).toBe(0);
    expect(getPixel1Bit(tile.data!, 7, 0)).toBe(0);
    expect(getPixel1Bit(tile.data!, 8, 0)).toBe(0);
    expect(getPixel1Bit(tile.data!, 255, 255)).toBe(0);

    // Set pixels
    setPixel1Bit(tile.data!, 0, 0, true);
    setPixel1Bit(tile.data!, 7, 0, true);
    setPixel1Bit(tile.data!, 8, 0, true);
    setPixel1Bit(tile.data!, 255, 255, true);

    expect(getPixel1Bit(tile.data!, 0, 0)).toBe(1);
    expect(getPixel1Bit(tile.data!, 7, 0)).toBe(1);
    expect(getPixel1Bit(tile.data!, 8, 0)).toBe(1);
    expect(getPixel1Bit(tile.data!, 255, 255)).toBe(1);

    // Neighboring pixel remains 0
    expect(getPixel1Bit(tile.data!, 1, 0)).toBe(0);
    expect(getPixel1Bit(tile.data!, 6, 0)).toBe(0);
    expect(getPixel1Bit(tile.data!, 254, 255)).toBe(0);

    // Clear pixel
    setPixel1Bit(tile.data!, 7, 0, false);
    expect(getPixel1Bit(tile.data!, 7, 0)).toBe(0);
  });

  it('accurately packs RGBA into 1-bit and unpacks back via 32-bit LUT', () => {
    const rgba = new Uint8ClampedArray(BYTES_32BIT);
    // Draw black ink at (10, 20) and (11, 20)
    const idx1 = (20 * TILE_SIZE + 10) * 4;
    rgba[idx1] = 0; // R
    rgba[idx1 + 1] = 0; // G
    rgba[idx1 + 2] = 0; // B
    rgba[idx1 + 3] = 255; // A

    const idx2 = (20 * TILE_SIZE + 11) * 4;
    rgba[idx2] = 0;
    rgba[idx2 + 1] = 0;
    rgba[idx2 + 2] = 0;
    rgba[idx2 + 3] = 255;

    const bit1Data = new Uint8Array(BYTES_1BIT);
    packRGBATo1Bit(rgba, bit1Data, 128);

    expect(getPixel1Bit(bit1Data, 10, 20)).toBe(1);
    expect(getPixel1Bit(bit1Data, 11, 20)).toBe(1);
    expect(getPixel1Bit(bit1Data, 12, 20)).toBe(0);

    const unpackedRGBA = new Uint8ClampedArray(BYTES_32BIT);
    unpack1BitToRGBA(bit1Data, unpackedRGBA);

    // Unpacked pixel at (10, 20) should have alpha 255 and black color
    expect(unpackedRGBA[idx1 + 3]).toBe(255);
    expect(unpackedRGBA[idx1]).toBe(0);

    // Transparent pixel at (12, 20) should have alpha 0
    const idx3 = (20 * TILE_SIZE + 12) * 4;
    expect(unpackedRGBA[idx3 + 3]).toBe(0);
  });

  it('compresses and decompresses tile buffers via RLE losslessly', () => {
    const tile = createTileBuffer('layer-ink', 2, 3, 'monochrome-1bit');
    setPixel1Bit(tile.data!, 50, 50, true);
    setPixel1Bit(tile.data!, 51, 50, true);
    setPixel1Bit(tile.data!, 52, 50, true);

    const serialized = serializeTileBuffer(tile);
    // Highly sparse tile should compress dramatically
    expect(serialized.length).toBeLessThan(100);

    const deserialized = deserializeTileBuffer('layer-ink', serialized);
    expect(deserialized.tileX).toBe(2);
    expect(deserialized.tileY).toBe(3);
    expect(deserialized.format).toBe('monochrome-1bit');
    expect(getPixel1Bit(deserialized.data!, 50, 50)).toBe(1);
    expect(getPixel1Bit(deserialized.data!, 51, 50)).toBe(1);
    expect(getPixel1Bit(deserialized.data!, 52, 50)).toBe(1);
    expect(getPixel1Bit(deserialized.data!, 53, 50)).toBe(0);
  });

  it('correctly handles multi-tile write and read in SparseTileGrid', () => {
    grid.setLayerFormat('layer-test', 'color-32bit');

    // Create a 100x100 patch spanning across tile boundaries (e.g. from x=200 to 300, y=200 to 300)
    // This touches tiles (0,0), (1,0), (0,1), (1,1)
    const patchWidth = 100;
    const patchHeight = 100;
    const patch = new Uint8ClampedArray(patchWidth * patchHeight * 4);
    patch.fill(128); // Fill with gray

    const bounds = grid.writeImageData(
      'layer-test',
      { data: patch, width: patchWidth, height: patchHeight },
      200,
      200
    );

    expect(bounds.minTileX).toBe(0);
    expect(bounds.maxTileX).toBe(1);
    expect(bounds.minTileY).toBe(0);
    expect(bounds.maxTileY).toBe(1);

    // Exactly 4 tiles should now be allocated
    expect(grid.getLayerTiles('layer-test').length).toBe(4);

    // Reading back from document space
    const read = grid.readImageData('layer-test', 200, 200, 10, 10);
    expect(read.width).toBe(10);
    expect(read.height).toBe(10);
    expect(read.data[0]).toBe(128);
    expect(read.data[1]).toBe(128);
    expect(read.data[2]).toBe(128);
    expect(read.data[3]).toBe(128);

    // Reading unpainted region outside patch should yield zero / transparent
    const emptyRead = grid.readImageData('layer-test', 500, 500, 10, 10);
    expect(emptyRead.data[3]).toBe(0);
  });

  it('correctly tracks tile deltas for undo/redo with snapshot and application', () => {
    grid.setLayerFormat('layer-1', 'monochrome-1bit');

    // Snapshot before drawing (empty)
    const bounds = { x: 10, y: 10, width: 50, height: 50 };
    const snapshot = grid.snapshotTilesInRect('layer-1', bounds);
    expect(snapshot.size).toBe(1);

    // Draw something
    const tile = grid.getOrCreateTile('layer-1', 0, 0, 'monochrome-1bit');
    setPixel1Bit(tile.data!, 10, 10, true);

    // Compute deltas
    const deltas = grid.computeDeltasFromSnapshot(snapshot, 'layer-1', bounds);
    expect(deltas.length).toBe(1);
    expect(deltas[0].beforeData).toBeNull();
    expect(deltas[0].afterData).not.toBeNull();

    // Serialize and deserialize deltas
    const bytes = serializeTileDeltas(deltas);
    expect(bytes.length).toBeGreaterThan(0);
    const restoredDeltas = deserializeTileDeltas(bytes);
    expect(restoredDeltas.length).toBe(1);
    expect(restoredDeltas[0].key).toBe('layer-1:0:0');
    expect(restoredDeltas[0].format).toBe('monochrome-1bit');

    // Undo: should revert to beforeData (which is null -> tile deleted)
    grid.applyTileDeltas(restoredDeltas, 'undo');
    expect(grid.getTile('layer-1', 0, 0)).toBeNull();

    // Redo: should re-apply afterData
    grid.applyTileDeltas(restoredDeltas, 'redo');
    const redoTile = grid.getTile('layer-1', 0, 0);
    expect(redoTile).not.toBeNull();
    expect(getPixel1Bit(redoTile!.data!, 10, 10)).toBe(1);
  });
});

