import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DocumentStore } from '../documentStore';
import {
  InMemoryScratchDiskDriver,
  SparseTileGrid,
  TILE_SIZE,
  BYTES_32BIT,
} from '../tileEngine';
import { LayerStackCacheTracker } from '../compositor';
import { createCanvasThumbnail } from '../canvasUtils';
import { computeBatchDeleteLayers } from '../../hooks/useLayerManager';
import { HistoryItem, LayerItem } from '../../types/editor';

function makeSolidPatch(width: number, height: number, r: number, g: number, b: number, a: number = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { data, width, height };
}

function createHistoryItem(id: string, layerId: string, deltas: HistoryItem['tileDeltas']): HistoryItem {
  return {
    id,
    type: 'brush',
    label: 'Stroke',
    timestamp: Date.now(),
    timeFormatted: '12:00:00',
    thumbnailUrl: '',
    layerId,
    tileDeltas: deltas,
  };
}

describe('Per-Document Isolation, Shared RAM Budgets & Sparse Tile Memory Optimization', () => {
  let driver: InMemoryScratchDiskDriver;
  let store: DocumentStore;

  beforeEach(() => {
    driver = new InMemoryScratchDiskDriver();
    store = new DocumentStore({
      totalTileBudgetMb: 2, // 2 MB shared budget for deterministic eviction tests
      sharedUndoRamStepsBudget: 4,
      scratchDiskDriver: driver,
      offloadInactiveUndoOnSwitch: true,
    });
  });

  afterEach(async () => {
    await store.clearAllSessions();
  });

  it('isolates tiles and Undo state between two documents with identical layer IDs', async () => {
    const docA = store.setActiveDocument('doc-A')!;
    const docB = store.getOrCreateSession('doc-B');

    // Draw red patch on doc-A:layer-1
    const beforeA = docA.tileGrid.snapshotTilesInRect('layer-1', { x: 0, y: 0, width: 32, height: 32 });
    docA.tileGrid.writeImageData('layer-1', makeSolidPatch(32, 32, 220, 20, 20, 255), 0, 0, 'color-32bit');
    const deltasA = docA.tileGrid.computeDeltasFromSnapshot(beforeA, 'layer-1', { x: 0, y: 0, width: 32, height: 32 });
    const stepA = createHistoryItem('hist-a-1', 'layer-1', deltasA);
    docA.history.push(stepA);
    docA.historyIndex = 0;
    await store.registerUndoStep('doc-A', stepA);

    // Switch to doc-B and draw blue patch on doc-B:layer-1
    store.setActiveDocument('doc-B');
    const beforeB = docB.tileGrid.snapshotTilesInRect('layer-1', { x: 0, y: 0, width: 32, height: 32 });
    docB.tileGrid.writeImageData('layer-1', makeSolidPatch(32, 32, 10, 40, 240, 255), 0, 0, 'color-32bit');
    const deltasB = docB.tileGrid.computeDeltasFromSnapshot(beforeB, 'layer-1', { x: 0, y: 0, width: 32, height: 32 });
    const stepB = createHistoryItem('hist-b-1', 'layer-1', deltasB);
    docB.history.push(stepB);
    docB.historyIndex = 0;
    await store.registerUndoStep('doc-B', stepB);

    // Undo on doc-B must ONLY revert doc-B; doc-A remains red and untouched
    const resolvedB = await docB.undoCache.resolveDeltas(stepB);
    expect(resolvedB).not.toBeNull();
    docB.tileGrid.applyTileDeltas(resolvedB!, 'undo');

    const pixelB = docB.tileGrid.readImageData('layer-1', 5, 5, 1, 1).data;
    expect(Array.from(pixelB)).toEqual([0, 0, 0, 0]);

    const pixelA = docA.tileGrid.readImageData('layer-1', 5, 5, 1, 1).data;
    expect(Array.from(pixelA)).toEqual([220, 20, 20, 255]);
    expect(docA.history.length).toBe(1);

    // Switch back to doc-A and verify its offloaded undo deltas restore cleanly and undo works
    store.setActiveDocument('doc-A');
    const resolvedA = await docA.undoCache.resolveDeltas(stepA);
    expect(resolvedA).not.toBeNull();
    docA.tileGrid.applyTileDeltas(resolvedA!, 'undo');

    const pixelAAfterUndo = docA.tileGrid.readImageData('layer-1', 5, 5, 1, 1).data;
    expect(Array.from(pixelAAfterUndo)).toEqual([0, 0, 0, 0]);

    // Redo on doc-B independently restores blue without touching doc-A
    docB.tileGrid.applyTileDeltas(resolvedB!, 'redo');
    const pixelBAfterRedo = docB.tileGrid.readImageData('layer-1', 5, 5, 1, 1).data;
    expect(Array.from(pixelBAfterRedo)).toEqual([10, 40, 240, 255]);
    expect(Array.from(docA.tileGrid.readImageData('layer-1', 5, 5, 1, 1).data)).toEqual([0, 0, 0, 0]);
  });

  it('switches across 3 open A4 600 DPI (10+ layers) documents instantaneously with zero ingestCanvas or clearAll calls', () => {
    const docs = ['doc-a4-1', 'doc-a4-2', 'doc-a4-3'].map((id, docIdx) => {
      const session = store.getOrCreateSession(id);
      for (let l = 0; l < 12; l++) {
        const layerId = `layer-${l}`;
        session.tileGrid.setLayerFormat(layerId, 'color-32bit');
        session.tileGrid.markLayerIngested(layerId);
        // Paint sparse stroke tiles in each layer on A4 600 DPI (4961 x 7016)
        session.tileGrid.writeImageData(
          layerId,
          makeSolidPatch(64, 64, (docIdx + 1) * 50, l * 15, 200, 255),
          l * 300,
          l * 400,
          'color-32bit',
          true
        );
      }
      return session;
    });

    const ingestSpies = docs.map((s) => vi.spyOn(s.tileGrid, 'ingestCanvas'));
    const clearAllSpies = docs.map((s) => vi.spyOn(s.tileGrid, 'clearAll'));
    const clearLayerSpies = docs.map((s) => vi.spyOn(s.tileGrid, 'clearLayer'));

    const t0 = performance.now();
    for (let round = 0; round < 10; round++) {
      store.setActiveDocument('doc-a4-1');
      expect(store.getActiveTileGrid()).toBe(docs[0].tileGrid);
      store.setActiveDocument('doc-a4-2');
      expect(store.getActiveTileGrid()).toBe(docs[1].tileGrid);
      store.setActiveDocument('doc-a4-3');
      expect(store.getActiveTileGrid()).toBe(docs[2].tileGrid);
    }
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(100);
    for (const spy of ingestSpies) expect(spy).not.toHaveBeenCalled();
    for (const spy of clearAllSpies) expect(spy).not.toHaveBeenCalled();
    for (const spy of clearLayerSpies) expect(spy).not.toHaveBeenCalled();

    // Verify each document retained its exact tiles intact
    expect(docs[0].tileGrid.readImageData('layer-3', 910, 1210, 1, 1).data[0]).toBe(50);
    expect(docs[1].tileGrid.readImageData('layer-3', 910, 1210, 1, 1).data[0]).toBe(100);
    expect(docs[2].tileGrid.readImageData('layer-3', 910, 1210, 1, 1).data[0]).toBe(150);
  });

  it('automatically offloads inactive document Undo deltas and evicts inactive document tiles first under shared RAM budget', async () => {
    // 1 MB shared budget = 4 RGBA tiles (256 KB each)
    store.setTileBudgetMb(1);

    const docA = store.setActiveDocument('doc-inactive')!;
    // Allocate 3 RGBA tiles (768 KB) in docA
    for (let tx = 0; tx < 3; tx++) {
      const before = docA.tileGrid.snapshotTilesInRect('layer-1', { x: tx * TILE_SIZE, y: 0, width: 16, height: 16 });
      docA.tileGrid.writeImageData('layer-1', makeSolidPatch(16, 16, 100 + tx, 50, 50, 255), tx * TILE_SIZE, 0, 'color-32bit');
      const deltas = docA.tileGrid.computeDeltasFromSnapshot(before, 'layer-1', { x: tx * TILE_SIZE, y: 0, width: 16, height: 16 });
      const item = createHistoryItem(`undo-a-${tx}`, 'layer-1', deltas);
      docA.history.push(item);
      docA.historyIndex = docA.history.length - 1;
      await store.registerUndoStep('doc-inactive', item);
    }

    expect(docA.undoCache.getRamStepCount()).toBe(3);

    // Switch to docB -> docA becomes inactive and its undo steps auto-offload
    const docB = store.setActiveDocument('doc-active')!;
    // Allow microtasks from setActiveDocument's offloadAllToDisk to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(docA.undoCache.getRamStepCount()).toBe(0);
    expect(docA.history.every((h) => h.tileDeltas === undefined)).toBe(true);
    expect(docA.history.every((h) => docA.undoCache.isOffloaded(h.id))).toBe(true);

    // Allocate 3 RGBA tiles (768 KB) in active docB -> total = 1.5 MB > 1 MB shared budget
    for (let tx = 0; tx < 3; tx++) {
      docB.tileGrid.writeImageData('layer-1', makeSolidPatch(16, 16, 20, 200, 20, 255), tx * TILE_SIZE, 0, 'color-32bit');
    }

    await store.enforceSharedTileBudget();

    // Inactive docA must have been paged to scratch disk first; active docB stays in RAM
    const statsA = docA.tileGrid.getMemoryStats();
    const statsB = docB.tileGrid.getMemoryStats();
    expect(statsA.pagedTileCount).toBeGreaterThan(0);
    expect(statsB.activeTileCount).toBe(3);
    expect(store.getTotalActiveTileBytes()).toBeLessThanOrEqual(store.getTileBudgetBytes());
  });

  it('allocates zero full-size HTMLCanvasElements and zero tile bytes for 20 empty raster layers on 6000x8000', () => {
    const doc = store.setActiveDocument('doc-6000x8000')!;

    // Create 20 new empty raster layers (no backing HTMLCanvasElement created)
    const layers: LayerItem[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `raster-empty-${i}`;
      doc.tileGrid.setLayerFormat(id, 'color-32bit');
      doc.tileGrid.markLayerIngested(id);
      layers.push({
        id,
        name: `Layer ${i + 1}`,
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
      });
    }

    expect('layerCanvases' in doc).toBe(false);
    expect('layerSourceCanvases' in doc).toBe(false);
    const stats = doc.tileGrid.getMemoryStats();
    expect(stats.tileCount).toBe(0);
    expect(stats.activeBytes).toBe(0);

    // Drawing a small 40x40 stroke on layer 5 allocates ONLY 1 tile (256 KB), not 20 * 192 MB
    doc.tileGrid.writeImageData('raster-empty-5', makeSolidPatch(40, 40, 0, 0, 0, 255), 100, 100, 'color-32bit');
    const afterStroke = doc.tileGrid.getMemoryStats();
    expect(afterStroke.tileCount).toBe(1);
    expect(afterStroke.activeBytes).toBe(BYTES_32BIT);
    expect('layerCanvases' in doc).toBe(false);

    // Batch-deleting layers cleans up tiles cleanly
    const delRes = computeBatchDeleteLayers(layers, ['raster-empty-5', 'raster-empty-6'], 'raster-empty-5');
    expect(delRes.deletedIds).toContain('raster-empty-5');
    for (const delId of delRes.deletedIds) {
      doc.clearLayerResources(delId);
    }
    expect(doc.tileGrid.getMemoryStats().tileCount).toBe(0);
    expect(doc.tileGrid.getMemoryStats().activeBytes).toBe(0);
  });

  it('cleans up all tiles, undo cache, and temporary buffers when closing a document tab', async () => {
    const doc = store.setActiveDocument('doc-closable')!;
    const before = doc.tileGrid.snapshotTilesInRect('layer-1', { x: 0, y: 0, width: 64, height: 64 });
    doc.tileGrid.writeImageData('layer-1', makeSolidPatch(64, 64, 255, 0, 128, 255), 0, 0, 'color-32bit');
    const deltas = doc.tileGrid.computeDeltasFromSnapshot(before, 'layer-1', { x: 0, y: 0, width: 64, height: 64 });
    const item = createHistoryItem('close-step-1', 'layer-1', deltas);
    doc.history.push(item);
    doc.historyIndex = 0;
    await store.registerUndoStep('doc-closable', item);

    await store.closeSession('doc-closable');

    expect(store.hasSession('doc-closable')).toBe(false);
    expect(doc.isDisposed()).toBe(true);
    expect(doc.tileGrid.getMemoryStats().tileCount).toBe(0);
    expect(doc.tileGrid.getMemoryStats().activeBytes).toBe(0);
    expect(doc.undoCache.getRamStepCount()).toBe(0);
    expect(doc.undoCache.getCompressedRamCount()).toBe(0);
    expect('layerCanvases' in doc).toBe(false);
  });

  it('builds and samples layer thumbnails directly from LOD 3 tiles without reading a full-size canvas', () => {
    const grid = new SparseTileGrid();
    // Write a 64x64 stroke on a 7016x9921 (600 DPI B4) layer
    grid.writeImageData('ink-layer', makeSolidPatch(64, 64, 15, 25, 35, 255), 512, 512, 'color-32bit');

    // Before thumbnail generation, LOD 3 has not been built yet
    expect(grid.getLayerTiles('ink-layer', 3).length).toBe(0);

    // Build LOD 3 tiles on demand via getOrBuildLod3Tiles & createCanvasThumbnail
    const lod3Tiles = grid.getOrBuildLod3Tiles('ink-layer');
    expect(lod3Tiles.length).toBe(1);
    expect(lod3Tiles[0].lod).toBe(3);
    expect(lod3Tiles[0].tileX).toBe(0);
    expect(lod3Tiles[0].tileY).toBe(0);

    // Verify createCanvasThumbnail accepts the SparseTileGrid descriptor cleanly (safe in Node & DOM)
    const thumbSpy = vi.spyOn(grid, 'generateThumbnail');
    createCanvasThumbnail({ grid, layerId: 'ink-layer', dimensions: { width: 7016, height: 9921 } }, true);
    expect(thumbSpy).toHaveBeenCalledWith('ink-layer', 60, 85, { width: 7016, height: 9921 }, true);
  });

  it('invalidates ViewportCompositor LayerStackCacheTracker when switching SparseTileGrid instances', () => {
    const tracker = new LayerStackCacheTracker();
    const gridA = new SparseTileGrid();
    const gridB = new SparseTileGrid();
    expect(gridA.getGridId()).not.toBe(gridB.getGridId());

    const layers: LayerItem[] = [
      { id: 'layer-1', name: 'Layer 1', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: false, parentId: null },
      { id: 'layer-bg', name: 'Background', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: true, parentId: null },
    ];

    const evalA = tracker.evaluate({
      layers,
      activeLayerId: 'layer-1',
      viewportW: 1280,
      viewportH: 720,
      dpr: 1,
      dimensions: { width: 2048, height: 2048, dpi: 300 },
      transform: { pan: { x: 0, y: 0 }, zoom: 1, rotation: 0 },
      getLayerContentVersion: () => 1,
      gridEpoch: gridA.getGridEpoch(),
      gridId: gridA.getGridId(),
    });
    expect(evalA.belowDirty).toBe(true);
    tracker.commit(evalA.belowSignature, evalA.aboveSignature);

    // Same grid -> cache stays clean
    const evalA2 = tracker.evaluate({
      layers,
      activeLayerId: 'layer-1',
      viewportW: 1280,
      viewportH: 720,
      dpr: 1,
      dimensions: { width: 2048, height: 2048, dpi: 300 },
      transform: { pan: { x: 0, y: 0 }, zoom: 1, rotation: 0 },
      getLayerContentVersion: () => 1,
      gridEpoch: gridA.getGridEpoch(),
      gridId: gridA.getGridId(),
    });
    expect(evalA2.belowDirty).toBe(false);

    // Switching to gridB (even with identical layer IDs and versions) immediately invalidates cache
    const evalB = tracker.evaluate({
      layers,
      activeLayerId: 'layer-1',
      viewportW: 1280,
      viewportH: 720,
      dpr: 1,
      dimensions: { width: 2048, height: 2048, dpi: 300 },
      transform: { pan: { x: 0, y: 0 }, zoom: 1, rotation: 0 },
      getLayerContentVersion: () => 1,
      gridEpoch: gridB.getGridEpoch(),
      gridId: gridB.getGridId(),
    });
    expect(evalB.belowDirty).toBe(true);
  });
});
