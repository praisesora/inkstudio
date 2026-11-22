import { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useLayerManager, applyLayerTreeDelta } from '../../hooks/useLayerManager';
import { useDrawingHistory } from '../../hooks/drawing/useDrawingHistory';
import { createRectFrame } from '../frameEngine';
import { SparseTileGrid, getTileKey, TILE_SIZE } from '../tileEngine';
import type { CanvasDimensions, LayerItem, LayerTreeDelta, TileDelta } from '../../types/editor';

// Minimal DOM shim for React 19 createRoot in Vitest Node environment
class ShimNode extends EventTarget {
  nodeType = 1;
  nodeName = 'DIV';
  tagName = 'DIV';
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  ownerDocument: any;
  parentNode: any = null;
  childNodes: any[] = [];
  style: Record<string, string> = {};
  constructor(tag = 'DIV', doc?: any) {
    super();
    this.nodeName = tag.toUpperCase();
    this.tagName = this.nodeName;
    this.ownerDocument = doc ?? null;
  }
  appendChild(c: any) {
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  removeChild(c: any) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  insertBefore(c: any, ref: any) {
    c.parentNode = this;
    const i = this.childNodes.indexOf(ref);
    if (i >= 0) this.childNodes.splice(i, 0, c);
    else this.childNodes.push(c);
    return c;
  }
  getContext() {
    return null;
  }
}

function installDomShim() {
  const doc: any = new ShimNode('#document');
  doc.nodeType = 9;
  doc.activeElement = null;
  doc.createElement = (tag: string) => new ShimNode(tag, doc);
  doc.createTextNode = (txt: string) => {
    const n: any = new ShimNode('#text', doc);
    n.nodeType = 3;
    n.nodeValue = txt;
    return n;
  };
  doc.documentElement = new ShimNode('HTML', doc);
  doc.body = new ShimNode('BODY', doc);
  const win: any = new EventTarget();
  win.document = doc;
  doc.defaultView = win;
  class HTMLIFrameElementShim extends ShimNode {}
  win.HTMLElement = ShimNode;
  win.HTMLIFrameElement = HTMLIFrameElementShim;
  win.Element = ShimNode;
  win.Node = ShimNode;
  win.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
  win.cancelAnimationFrame = (id: any) => clearTimeout(id);
  win.navigator = {};
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = win;
  (globalThis as any).document = doc;
  (globalThis as any).HTMLElement = ShimNode;
  (globalThis as any).HTMLIFrameElement = HTMLIFrameElementShim;
  (globalThis as any).Element = ShimNode;
  (globalThis as any).Node = ShimNode;
  return doc;
}

function paintTestTile(grid: SparseTileGrid, layerId: string, r: number, g: number, b: number): TileDelta[] {
  const tile = grid.getOrCreateTile(layerId, 0, 0, 'color-32bit', 0);
  const beforeData = tile.data ? new Uint8Array(tile.data) : null;
  if (!tile.data) {
    tile.data = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  }
  tile.data[0] = r;
  tile.data[1] = g;
  tile.data[2] = b;
  tile.data[3] = 255;
  tile.dirty = true;
  grid.bumpLayerVersion(layerId);

  return [
    {
      key: getTileKey(layerId, 0, 0, 0),
      format: 'color-32bit',
      beforeData,
      afterData: new Uint8Array(tile.data),
    },
  ];
}

describe('Frame Border Ctrl+Z Undo / Redo', () => {
  describe('applyLayerTreeDelta pure helper', () => {
    it('removes added frame folder and child layer on undo while preserving unrelated layers, and restores on redo', () => {
      const layer1: LayerItem = {
        id: 'layer-1',
        name: 'Layer 1',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
      };
      const bg: LayerItem = {
        id: 'layer-bg',
        name: 'Background',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
      };
      const frameFolder: LayerItem = {
        id: 'ff-1',
        name: 'Frame 1',
        type: 'frame-folder',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
        comicFrames: [createRectFrame('ff-1', 50, 50, 400, 400)],
      };
      const panelLayer: LayerItem = {
        id: 'raster-panel-1',
        name: 'Panel Layer',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: 'ff-1',
      };
      const userAddedSketch: LayerItem = {
        id: 'layer-sketch',
        name: 'Sketch',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
      };
      const userAddedChildInFrame: LayerItem = {
        id: 'layer-extra-in-frame',
        name: 'Extra Panel Art',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: 'ff-1',
      };

      const delta: LayerTreeDelta = {
        addedLayers: [frameFolder, panelLayer],
        insertBeforeLayerId: 'layer-1',
        insertIndex: 0,
        beforeActiveLayerId: 'layer-1',
        afterActiveLayerId: 'raster-panel-1',
      };

      const currentLayers = [
        userAddedSketch,
        frameFolder,
        panelLayer,
        userAddedChildInFrame,
        layer1,
        bg,
      ];

      const undone = applyLayerTreeDelta(currentLayers, 'raster-panel-1', delta, 'undo');
      expect(undone.removedLayerIds).toEqual(['ff-1', 'raster-panel-1']);
      expect(undone.nextLayers.map((l) => l.id)).toEqual([
        'layer-sketch',
        'layer-extra-in-frame',
        'layer-1',
        'layer-bg',
      ]);
      // Surviving manually-added child must not retain a dangling parentId
      expect(
        undone.nextLayers.find((l) => l.id === 'layer-extra-in-frame')?.parentId
      ).toBeNull();
      expect(undone.nextActiveLayerId).toBe('layer-1');

      // Redo reinserts right before anchor layer-1
      const redone = applyLayerTreeDelta(undone.nextLayers, 'layer-1', delta, 'redo');
      expect(redone.addedLayers.map((l) => l.id)).toEqual(['ff-1', 'raster-panel-1']);
      expect(redone.nextLayers.map((l) => l.id)).toEqual([
        'layer-sketch',
        'layer-extra-in-frame',
        'ff-1',
        'raster-panel-1',
        'layer-1',
        'layer-bg',
      ]);
      expect(redone.nextActiveLayerId).toBe('raster-panel-1');

      // Idempotent redo does not duplicate layers
      const redoneAgain = applyLayerTreeDelta(redone.nextLayers, 'raster-panel-1', delta, 'redo');
      expect(redoneAgain.nextLayers.map((l) => l.id)).toEqual(redone.nextLayers.map((l) => l.id));
    });
  });

  describe('useLayerManager + useDrawingHistory integration', () => {
    let doc: any;
    let container: any;
    let root: Root;
    let grid: SparseTileGrid;
    let latestState: {
      layerMgr: ReturnType<typeof useLayerManager>;
      history: ReturnType<typeof useDrawingHistory>;
    };

    const dims: CanvasDimensions = { width: 1000, height: 1000, dpi: 600 };

    function TestHarness() {
      const layerMgr = useLayerManager({ dimensions: dims, tileGrid: grid });
      const dimensionsRef = useRef(dims);
      dimensionsRef.current = dims;
      const activeLayerIdRef = useRef(layerMgr.activeLayerId);
      activeLayerIdRef.current = layerMgr.activeLayerId;
      const colorModeRef = useRef<'color' | 'grayscale' | 'monochrome'>('color');
      const layersRef = useRef<LayerItem[] | undefined>(layerMgr.layers);
      layersRef.current = layerMgr.layers;
      const onApplyLayerTreeDeltaRef = useRef(layerMgr.applyLayerTreeDelta);
      onApplyLayerTreeDeltaRef.current = layerMgr.applyLayerTreeDelta;
      const onUpdateMaskThumbnailRef = useRef<((id: string) => void) | undefined>(undefined);
      const isDrawingRef = useRef(false);
      const lastStrokeEndRef = useRef(null);
      const abortActiveStrokeRef = useRef(() => {});

      const history = useDrawingHistory({
        tileGrid: grid,
        activeLayerId: layerMgr.activeLayerId,
        activeLayerLocked: false,
        dimensions: dims,
        dimensionsRef,
        activeLayerIdRef,
        colorModeRef,
        layersRef,
        onUpdateLayerThumbnail: layerMgr.updateLayerThumbnail,
        onApplyLayerTreeDeltaRef,
        onUpdateMaskThumbnailRef,
        isDrawingRef,
        lastStrokeEndRef,
        abortActiveStrokeRef,
      });

      latestState = { layerMgr, history };
      return null;
    }

    beforeEach(async () => {
      doc = installDomShim();
      container = doc.createElement('div');
      doc.body.appendChild(container);
      grid = new SparseTileGrid();
      root = createRoot(container);
      await act(async () => {
        root.render(<TestHarness />);
      });
      // Seed standard initial canvas layers (Layer 1 + Background)
      await act(async () => {
        latestState.layerMgr.resetToNewCanvas(dims, '#ffffff', 'color');
      });
      await act(async () => {
        latestState.history.resetHistory();
      });
    });

    afterEach(async () => {
      await act(async () => {
        root.unmount();
      });
    });

    it('removes a newly created frame border on Ctrl+Z (undo) and restores it on Ctrl+Y (redo)', async () => {
      const initialLayerIds = latestState.layerMgr.layers.map((l) => l.id);
      const initialActiveId = latestState.layerMgr.activeLayerId;
      expect(initialLayerIds.length).toBeGreaterThanOrEqual(2);

      const frame = createRectFrame('', 100, 100, 600, 600, { borderWidth: 4 });
      let createdFolderId = '';
      let createdChildId = '';

      await act(async () => {
        const { folder, childLayer, layerTreeDelta } = latestState.layerMgr.createFrameFolder(
          [frame],
          undefined,
          true
        );
        createdFolderId = folder.id;
        createdChildId = childLayer!.id;
        latestState.history.pushHistoryStep(
          'frame',
          'Create Frame Folder',
          null,
          null,
          folder.id,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          layerTreeDelta
        );
      });

      expect(latestState.layerMgr.layers.some((l) => l.id === createdFolderId)).toBe(true);
      expect(latestState.layerMgr.layers.some((l) => l.id === createdChildId)).toBe(true);
      expect(latestState.layerMgr.activeLayerId).toBe(createdChildId);
      expect(latestState.history.canUndo).toBe(true);

      // Ctrl+Z: undo removes the frame border folder & its panel layer
      await act(async () => {
        latestState.history.undo();
        await Promise.resolve();
      });

      expect(latestState.layerMgr.layers.some((l) => l.id === createdFolderId)).toBe(false);
      expect(latestState.layerMgr.layers.some((l) => l.id === createdChildId)).toBe(false);
      expect(latestState.layerMgr.layers.map((l) => l.id)).toEqual(initialLayerIds);
      expect(latestState.layerMgr.activeLayerId).toBe(initialActiveId);
      expect(latestState.history.canRedo).toBe(true);

      // Ctrl+Y: redo restores the frame border folder & its panel layer
      await act(async () => {
        latestState.history.redo();
        await Promise.resolve();
      });

      const restoredFolder = latestState.layerMgr.layers.find((l) => l.id === createdFolderId);
      expect(restoredFolder).toBeDefined();
      expect(restoredFolder?.comicFrames).toHaveLength(1);
      expect(latestState.layerMgr.layers.some((l) => l.id === createdChildId)).toBe(true);
      expect(latestState.layerMgr.activeLayerId).toBe(createdChildId);
    });

    it('interleaves frame creation with brush strokes across multi-step undo, redo, and history jump', async () => {
      const initialActiveId = latestState.layerMgr.activeLayerId;
      const frame = createRectFrame('', 100, 100, 600, 600);
      let folderId = '';
      let panelId = '';

      await act(async () => {
        const { folder, childLayer, layerTreeDelta } = latestState.layerMgr.createFrameFolder(
          [frame],
          undefined,
          true
        );
        folderId = folder.id;
        panelId = childLayer!.id;
        latestState.history.pushHistoryStep(
          'frame',
          'Create Frame Folder',
          null,
          null,
          folder.id,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          layerTreeDelta
        );
      });

      // Draw a stroke inside the panel layer
      await act(async () => {
        const deltas = paintTestTile(grid, panelId, 200, 40, 20);
        latestState.history.pushHistoryStep(
          'brush',
          'Pen Stroke',
          null,
          null,
          panelId,
          { x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE },
          deltas
        );
      });

      expect(grid.getTile(panelId, 0, 0, 0)?.data?.[0]).toBe(200);

      // Jump all the way back to New Document (index 0): undoes stroke AND removes frame border
      await act(async () => {
        await latestState.history.jumpToHistoryIndex(0);
      });

      expect(latestState.layerMgr.layers.some((l) => l.id === folderId)).toBe(false);
      expect(latestState.layerMgr.layers.some((l) => l.id === panelId)).toBe(false);
      expect(latestState.layerMgr.activeLayerId).toBe(initialActiveId);
      expect(grid.getTile(panelId, 0, 0, 0)).toBeNull();

      // Jump all the way forward (index 2): restores frame border, panel layer, AND painted stroke
      await act(async () => {
        await latestState.history.jumpToHistoryIndex(2);
      });

      expect(latestState.layerMgr.layers.some((l) => l.id === folderId)).toBe(true);
      expect(latestState.layerMgr.layers.some((l) => l.id === panelId)).toBe(true);
      expect(grid.getTile(panelId, 0, 0, 0)?.data?.[0]).toBe(200);
    });

    it('undoes and redoes Divide Frame Border in same-folder mode', async () => {
      const frame = createRectFrame('', 100, 100, 800, 800, {
        gutterVerticalPx: 40,
        gutterHorizontalPx: 80,
      });
      let folderId = '';

      await act(async () => {
        const { folder, layerTreeDelta } = latestState.layerMgr.createFrameFolder(
          [frame],
          undefined,
          true
        );
        folderId = folder.id;
        latestState.history.pushHistoryStep(
          'frame',
          'Create Frame Folder',
          null,
          null,
          folder.id,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          layerTreeDelta
        );
      });

      await act(async () => {
        const res = latestState.layerMgr.divideFrameFolder(
          folderId,
          { x: 50, y: 500 },
          { x: 950, y: 500 },
          600,
          'same-folder'
        );
        expect(res.divided).toBe(true);
        latestState.history.pushHistoryStep(
          'frame',
          'Divide Frame Border',
          null,
          null,
          folderId,
          undefined,
          res.tileDeltas,
          undefined,
          undefined,
          undefined,
          undefined,
          res.layerTreeDelta
        );
      });

      expect(
        latestState.layerMgr.layers.find((l) => l.id === folderId)?.comicFrames
      ).toHaveLength(2);

      // 1st Ctrl+Z: reverts divide back to 1 frame
      await act(async () => {
        latestState.history.undo();
        await Promise.resolve();
      });

      expect(
        latestState.layerMgr.layers.find((l) => l.id === folderId)?.comicFrames
      ).toHaveLength(1);

      // 2nd Ctrl+Z: removes the frame folder completely
      await act(async () => {
        latestState.history.undo();
        await Promise.resolve();
      });

      expect(latestState.layerMgr.layers.some((l) => l.id === folderId)).toBe(false);

      // Redo twice: restores folder, then restores 2 divided frames
      await act(async () => {
        await latestState.history.jumpToHistoryIndex(2);
      });

      expect(
        latestState.layerMgr.layers.find((l) => l.id === folderId)?.comicFrames
      ).toHaveLength(2);
    });

    it('undoes and redoes Divide Frame Folder in split-folders mode including cloned child tiles', async () => {
      const frame = createRectFrame('', 100, 100, 800, 800, {
        gutterVerticalPx: 40,
        gutterHorizontalPx: 80,
      });
      let folderId = '';
      let panelId = '';

      await act(async () => {
        const { folder, childLayer, layerTreeDelta } = latestState.layerMgr.createFrameFolder(
          [frame],
          undefined,
          true
        );
        folderId = folder.id;
        panelId = childLayer!.id;
        latestState.history.pushHistoryStep(
          'frame',
          'Create Frame Folder',
          null,
          null,
          folder.id,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          layerTreeDelta
        );
      });

      // Paint pixel onto panel layer so split-folders clones actual tile data
      await act(async () => {
        const deltas = paintTestTile(grid, panelId, 33, 144, 255);
        latestState.history.pushHistoryStep(
          'brush',
          'Panel Ink',
          null,
          null,
          panelId,
          { x: 0, y: 0, width: TILE_SIZE, height: TILE_SIZE },
          deltas
        );
      });

      let splitFolderBId = '';
      let clonedChildId = '';

      await act(async () => {
        const res = latestState.layerMgr.divideFrameFolder(
          folderId,
          { x: 50, y: 500 },
          { x: 950, y: 500 },
          600,
          'split-folders'
        );
        expect(res.divided).toBe(true);
        splitFolderBId = res.layerTreeDelta?.addedLayers?.[0]?.id ?? '';
        clonedChildId = res.layerTreeDelta?.addedLayers?.[1]?.id ?? '';
        latestState.history.pushHistoryStep(
          'frame',
          'Divide Frame Folder',
          null,
          null,
          folderId,
          undefined,
          res.tileDeltas,
          undefined,
          undefined,
          undefined,
          undefined,
          res.layerTreeDelta
        );
      });

      expect(splitFolderBId).not.toBe('');
      expect(clonedChildId).not.toBe('');
      expect(latestState.layerMgr.layers.some((l) => l.id === splitFolderBId)).toBe(true);
      expect(grid.getTile(clonedChildId, 0, 0, 0)?.data?.[1]).toBe(144);

      // Undo split-folders: removes Folder B + cloned child, clears cloned tiles, restores original Frame A bounds
      await act(async () => {
        latestState.history.undo();
        await Promise.resolve();
      });

      expect(latestState.layerMgr.layers.some((l) => l.id === splitFolderBId)).toBe(false);
      expect(latestState.layerMgr.layers.some((l) => l.id === clonedChildId)).toBe(false);
      expect(grid.getTile(clonedChildId, 0, 0, 0)).toBeNull();
      const restoredA = latestState.layerMgr.layers.find((l) => l.id === folderId);
      expect(restoredA?.comicFrames?.[0]?.polygon).toEqual(frame.polygon);

      // Redo split-folders: restores Folder B + cloned child + cloned pixel data
      await act(async () => {
        latestState.history.redo();
        await Promise.resolve();
      });

      expect(latestState.layerMgr.layers.some((l) => l.id === splitFolderBId)).toBe(true);
      expect(latestState.layerMgr.layers.some((l) => l.id === clonedChildId)).toBe(true);
      expect(grid.getTile(clonedChildId, 0, 0, 0)?.data?.[1]).toBe(144);
    });

    it('supports collaborative selectiveUndo for removing a created frame border', async () => {
      const initialActiveId = latestState.layerMgr.activeLayerId;
      const frame = createRectFrame('', 100, 100, 500, 500);
      let folderId = '';
      let panelId = '';

      await act(async () => {
        const { folder, childLayer, layerTreeDelta } = latestState.layerMgr.createFrameFolder(
          [frame],
          undefined,
          true
        );
        folderId = folder.id;
        panelId = childLayer!.id;
        latestState.history.pushHistoryStep(
          'frame',
          'Create Frame Folder',
          null,
          null,
          folder.id,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          layerTreeDelta
        );
      });

      await act(async () => {
        await latestState.history.selectiveUndo('local');
      });

      expect(latestState.layerMgr.layers.some((l) => l.id === folderId)).toBe(false);
      expect(latestState.layerMgr.layers.some((l) => l.id === panelId)).toBe(false);
      expect(latestState.layerMgr.activeLayerId).toBe(initialActiveId);
    });
  });
});
