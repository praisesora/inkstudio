import { describe, it, expect } from 'vitest';
import {
  mmToPixels,
  pixelsToMm,
  createDefaultPageFrame,
  createRectFrame,
  bisectComicFrame,
  divideFramesInFolder,
  isPointInsidePolygon,
  polygonArea,
  triangulatePolygon,
  buildFrameBorderTriangles,
} from '../frameEngine';
import { computeBatchReorderLayers } from '../../hooks/useLayerManager';
import { partitionLayerStack, LayerStackCacheTracker } from '../compositor';
import { LayerItem } from '../../types/editor';

describe('Comic Frame Engine (Koma-wari & Frame Border Folders)', () => {
  it('converts millimeters to pixels accurately at 600 DPI', () => {
    expect(mmToPixels(25.4, 600)).toBeCloseTo(600);
    expect(mmToPixels(3, 600)).toBeCloseTo(70.866, 2);
    expect(mmToPixels(5, 600)).toBeCloseTo(118.11, 2);
    expect(pixelsToMm(600, 600)).toBeCloseTo(25.4);
  });

  it('creates default page frame fitting within document bounds', () => {
    const frame = createDefaultPageFrame('layer-frame', 4961, 7016, 600, 20);
    expect(frame.polygon.length).toBe(4);
    expect(frame.polygon[0].x).toBeGreaterThan(0);
    expect(frame.polygon[1].x).toBeLessThan(4961);
    expect(frame.clipChildren).toBe(true);
  });

  it('bisects a rectangular frame horizontally with exact gutterHorizontal spacing', () => {
    const frame = createRectFrame('folder-1', 100, 100, 800, 800, {
      borderWidth: 4,
      gutterVerticalPx: 70,
      gutterHorizontalPx: 118,
    });

    const result = bisectComicFrame(frame, { x: 50, y: 500 }, { x: 950, y: 500 }, 600);
    expect(result).not.toBeNull();
    if (!result) return;

    const [child1, child2] = result;
    expect(child1.polygon.length).toBe(4);
    expect(child2.polygon.length).toBe(4);

    const maxYTop = Math.min(
      Math.max(...child1.polygon.map((p) => p.y)),
      Math.max(...child2.polygon.map((p) => p.y))
    );
    const minYBottom = Math.max(
      Math.min(...child1.polygon.map((p) => p.y)),
      Math.min(...child2.polygon.map((p) => p.y))
    );

    // Exact gutter spacing = 118px (441 to 559)
    expect(minYBottom - maxYTop).toBeCloseTo(118, 2);
  });

  it('bisects a rectangular frame vertically with exact gutterVertical spacing', () => {
    const frame = createRectFrame('folder-1', 100, 100, 800, 800, {
      borderWidth: 4,
      gutterVerticalPx: 60,
      gutterHorizontalPx: 120,
    });

    const result = bisectComicFrame(frame, { x: 500, y: 50 }, { x: 500, y: 950 }, 600);
    expect(result).not.toBeNull();
    if (!result) return;

    const [child1, child2] = result;
    const maxXLeft = Math.min(
      Math.max(...child1.polygon.map((p) => p.x)),
      Math.max(...child2.polygon.map((p) => p.x))
    );
    const minXRight = Math.max(
      Math.min(...child1.polygon.map((p) => p.x)),
      Math.min(...child2.polygon.map((p) => p.x))
    );

    expect(minXRight - maxXLeft).toBeCloseTo(60, 2);
  });

  it('bisects diagonally via half-plane clipping without vertices protruding outside original bounds', () => {
    const frame = createRectFrame('folder-1', 100, 100, 800, 800, {
      gutterVerticalPx: 40,
      gutterHorizontalPx: 40,
    });

    const result = bisectComicFrame(frame, { x: 50, y: 300 }, { x: 950, y: 700 }, 600);
    expect(result).not.toBeNull();
    if (!result) return;

    for (const child of result) {
      expect(polygonArea(child.polygon)).toBeGreaterThan(1000);
      for (const p of child.polygon) {
        expect(p.x).toBeGreaterThanOrEqual(100 - 1e-3);
        expect(p.x).toBeLessThanOrEqual(900 + 1e-3);
        expect(p.y).toBeGreaterThanOrEqual(100 - 1e-3);
        expect(p.y).toBeLessThanOrEqual(900 + 1e-3);
      }
    }
  });

  it('divides frames in both same-folder and split-folders modes', () => {
    const frame = createRectFrame('folder-1', 100, 100, 800, 800, {
      gutterVerticalPx: 40,
      gutterHorizontalPx: 80,
    });

    const sameRes = divideFramesInFolder(
      [frame],
      { x: 50, y: 500 },
      { x: 950, y: 500 },
      600,
      'same-folder'
    );
    expect(sameRes.divided).toBe(true);
    expect(sameRes.frames).toHaveLength(2);

    const splitRes = divideFramesInFolder(
      [frame],
      { x: 50, y: 500 },
      { x: 950, y: 500 },
      600,
      'split-folders'
    );
    expect(splitRes.divided).toBe(true);
    expect(splitRes.folderGroups).toHaveLength(2);
    expect(splitRes.folderGroups[0]).toHaveLength(1);
    expect(splitRes.folderGroups[1]).toHaveLength(1);

    // Cut outside frame should not divide
    const missRes = divideFramesInFolder(
      [frame],
      { x: 10, y: 10 },
      { x: 50, y: 50 },
      600,
      'same-folder'
    );
    expect(missRes.divided).toBe(false);
    expect(missRes.frames).toHaveLength(1);
  });

  it('triangulates polygons and builds mitered border triangles for GPU stencil compositing', () => {
    const quad = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 0, y: 100 },
    ];
    const fillTris = triangulatePolygon(quad);
    expect(fillTris.length).toBe(12); // 2 triangles * 3 vertices * 2 floats

    const borderTris = buildFrameBorderTriangles(quad, 6);
    expect(borderTris.length).toBe(48); // 4 edges * 2 tris * 3 verts * 2 floats
  });

  it('allows dragging a raster layer inside a frame-folder and keeps frame-folder atomic in compositor', () => {
    const frameFolder: LayerItem = {
      id: 'ff-1',
      name: 'Frame 1',
      type: 'frame-folder',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      locked: false,
      parentId: null,
      comicFrames: [createRectFrame('ff-1', 100, 100, 400, 400)],
    };
    const drawLayer: LayerItem = {
      id: 'layer-draw',
      name: 'Panel Art',
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      locked: false,
      parentId: null,
    };

    const reordered = computeBatchReorderLayers(
      [drawLayer, frameFolder],
      ['layer-draw'],
      'layer-draw',
      'ff-1',
      'inside'
    );

    const moved = reordered.find((l) => l.id === 'layer-draw');
    expect(moved?.parentId).toBe('ff-1');

    // Compositor must keep frame-folder as a single isolated compositing unit containing its child
    const partition = partitionLayerStack(reordered, 'layer-draw');
    expect(partition.activeUnit?.group.baseNode.layer.id).toBe('ff-1');
    expect(partition.activeUnit?.containedLayerIds.has('layer-draw')).toBe(true);

    // Cache tracker must invalidate when comicFrames polygon changes
    const tracker = new LayerStackCacheTracker();
    const eval1 = tracker.evaluate({
      layers: reordered,
      activeLayerId: null,
      transform: { pan: { x: 0, y: 0 }, zoom: 1, rotation: 0 },
      dimensions: { width: 1000, height: 1000, dpi: 600 },
      viewportW: 1000,
      viewportH: 1000,
      dpr: 1,
      getLayerContentVersion: () => 1,
    });
    expect(eval1.belowDirty).toBe(true);

    const updatedFrames = reordered.map((l) =>
      l.id === 'ff-1' ? { ...l, comicFrames: [createRectFrame('ff-1', 120, 120, 360, 360)] } : l
    );
    const eval2 = tracker.evaluate({
      layers: updatedFrames,
      activeLayerId: null,
      transform: { pan: { x: 0, y: 0 }, zoom: 1, rotation: 0 },
      dimensions: { width: 1000, height: 1000, dpi: 600 },
      viewportW: 1000,
      viewportH: 1000,
      dpr: 1,
      getLayerContentVersion: () => 1,
    });
    expect(eval2.belowDirty).toBe(true);
  });

  it('correctly determines whether a point is inside a frame polygon', () => {
    const poly = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];

    expect(isPointInsidePolygon({ x: 50, y: 50 }, poly)).toBe(true);
    expect(isPointInsidePolygon({ x: 150, y: 50 }, poly)).toBe(false);
    expect(isPointInsidePolygon({ x: -10, y: 50 }, poly)).toBe(false);
  });
});
