import React, { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SparseTileGrid } from '../tileEngine';
import {
  executeFloodFillOnTileGrid,
  executeLassoFillOnTileGrid,
} from '../floodFill';
import { fillSelectionInTileGrid } from '../selectionUtils';
import { createSelectionMask } from '../tonalEngine';
import { useLayerManager } from '../../hooks/useLayerManager';
import { useDrawingHistory, PushHistoryStepFn } from '../../hooks/drawing';
import { isEditableTarget } from '../../components/GlobalShortcutListener';
import type { CanvasDimensions, CanvasSelection, LayerItem } from '../../types/editor';

class ShimNode extends EventTarget {
  nodeType = 1;
  nodeName = 'DIV';
  tagName = 'DIV';
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  ownerDocument: any;
  parentNode: any = null;
  childNodes: any[] = [];
  style: Record<string, string> = {};
  isContentEditable = false;
  type = '';
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

const DIMS: CanvasDimensions = { width: 256, height: 256, dpi: 300 };

function makeTriangleLasso(): CanvasSelection {
  const polygon = [
    { x: 40, y: 40 },
    { x: 180, y: 40 },
    { x: 110, y: 180 },
  ];
  return {
    type: 'lasso',
    bounds: { x: 40, y: 40, width: 140, height: 140 },
    polygon,
  };
}

function paintSolidRect(
  grid: SparseTileGrid,
  layerId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: [number, number, number, number]
) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  grid.writeImageData(layerId, { data, width: w, height: h }, x, y, 'color-32bit', true);
}

function readPixel(
  grid: SparseTileGrid,
  layerId: string,
  x: number,
  y: number
): [number, number, number, number] {
  const img = grid.readImageData(layerId, x, y, 1, 1);
  return [img.data[0], img.data[1], img.data[2], img.data[3]];
}

describe('Selection + Screentone, Fill Tool, LOD Invalidation, and Comprehensive Ctrl+Z Undo', () => {
  let root: Root | null = null;

  beforeEach(() => {
    installDomShim();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
  });

  it('fillLayerSolidColor parses rgb(...) strings accurately instead of defaulting to white', () => {
    const grid = new SparseTileGrid();
    grid.fillLayerSolidColor('tone-1', 64, 64, 'rgb(0,0,0)', 'color-32bit');
    expect(readPixel(grid, 'tone-1', 10, 10)).toEqual([0, 0, 0, 255]);

    grid.fillLayerSolidColor('tone-2', 64, 64, 'rgb(120, 120, 120)', 'color-32bit');
    expect(readPixel(grid, 'tone-2', 10, 10)).toEqual([120, 120, 120, 255]);
  });

  it('createSelectionMask and fillSelectionInTileGrid clip strictly inside a lasso polygon even without 2D canvas context', () => {
    const lasso = makeTriangleLasso();
    const mask = createSelectionMask(lasso, DIMS.width, DIMS.height);
    expect(mask).not.toBeNull();
    // Centroid (110, 86) is inside triangle; corner (45, 170) is outside triangle but inside bounding box
    expect(mask![86 * DIMS.width + 110]).toBe(1);
    expect(mask![170 * DIMS.width + 45]).toBe(0);

    const grid = new SparseTileGrid();
    const res = fillSelectionInTileGrid({
      grid,
      layerId: 'layer-1',
      dimensions: DIMS,
      selection: lasso,
      colorCss: '#cc2244',
      targetFormat: 'color-32bit',
    });
    expect(res.tileDeltas.length).toBeGreaterThan(0);
    expect(readPixel(grid, 'layer-1', 110, 86)).toEqual([204, 34, 68, 255]);
    expect(readPixel(grid, 'layer-1', 45, 170)[3]).toBe(0);
  });

  it('executeFloodFillOnTileGrid respects lasso selectionMask, hidden folders, and alphaLock', () => {
    const grid = new SparseTileGrid();
    const lasso = makeTriangleLasso();
    const mask = createSelectionMask(lasso, DIMS.width, DIMS.height);

    // Put a barrier stroke inside a HIDDEN folder — refer-all must ignore it
    paintSolidRect(grid, 'hidden-child', 90, 60, 40, 60, [0, 0, 0, 255]);
    // White background layer
    grid.fillLayerSolidWhite('layer-bg', DIMS.width, DIMS.height, 'color-32bit');

    const layers: LayerItem[] = [
      { id: 'layer-1', name: 'Layer 1', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: false, parentId: null },
      { id: 'folder-hidden', name: 'Hidden Folder', type: 'folder', visible: false, opacity: 1, blendMode: 'pass-through', locked: false, parentId: null },
      { id: 'hidden-child', name: 'Hidden Child', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: false, parentId: 'folder-hidden' },
      { id: 'layer-bg', name: 'Background', type: 'raster', visible: true, opacity: 1, blendMode: 'normal', locked: true, parentId: null },
    ];

    const fillRes = executeFloodFillOnTileGrid({
      grid,
      targetLayerId: 'layer-1',
      layers,
      dimensions: DIMS,
      startX: 110,
      startY: 86,
      fillColorHex: '#2563eb',
      tolerance: 24,
      referMode: 'refer-all',
      options: { selectionMask: mask, antiAlias: false },
    });

    expect(fillRes.modified).toBe(true);
    expect(fillRes.tileDeltas.length).toBeGreaterThan(0);
    // Inside lasso filled (even where hidden-child was)
    expect(readPixel(grid, 'layer-1', 110, 86)).toEqual([37, 99, 235, 255]);
    // Outside lasso untouched
    expect(readPixel(grid, 'layer-1', 45, 170)[3]).toBe(0);
    expect(readPixel(grid, 'layer-1', 10, 10)[3]).toBe(0);

    // Now test alphaLocked: filling over layer-1 should recolor existing pixels without leaking into transparent ones
    const recolorRes = executeFloodFillOnTileGrid({
      grid,
      targetLayerId: 'layer-1',
      layers,
      dimensions: DIMS,
      startX: 110,
      startY: 86,
      fillColorHex: '#ef4444',
      tolerance: 24,
      referMode: 'active',
      options: { alphaLocked: true, antiAlias: false },
    });
    expect(recolorRes.modified).toBe(true);
    expect(readPixel(grid, 'layer-1', 110, 86)).toEqual([239, 68, 68, 255]);
    expect(readPixel(grid, 'layer-1', 45, 170)[3]).toBe(0);
  });

  it('executeLassoFillOnTileGrid clips strictly to active selectionMask', () => {
    const grid = new SparseTileGrid();
    const rectSel: CanvasSelection = {
      type: 'rect',
      bounds: { x: 50, y: 50, width: 60, height: 60 },
    };
    const selMask = createSelectionMask(rectSel, DIMS.width, DIMS.height);

    const res = executeLassoFillOnTileGrid({
      grid,
      targetLayerId: 'layer-1',
      dimensions: DIMS,
      polygon: [
        { x: 10, y: 10 },
        { x: 200, y: 10 },
        { x: 200, y: 200 },
        { x: 10, y: 200 },
      ],
      fillColorHex: '#10b981',
      selectionMask: selMask,
    });

    expect(res.modified).toBe(true);
    expect(readPixel(grid, 'layer-1', 80, 80)).toEqual([16, 185, 129, 255]);
    expect(readPixel(grid, 'layer-1', 20, 20)[3]).toBe(0);
  });

  it('evicts stale LOD 3 mipmap tiles when undoing back to an empty layer (prevents stale thumbnails & Navigator preview)', () => {
    const grid = new SparseTileGrid();
    const beforeSnap = grid.snapshotLayerTiles('layer-1');
    paintSolidRect(grid, 'layer-1', 20, 20, 100, 100, [20, 20, 20, 255]);
    const deltas = grid.computeDeltasFromSnapshot(beforeSnap, 'layer-1', {
      x: 0,
      y: 0,
      width: 256,
      height: 256,
    });
    expect(deltas.length).toBeGreaterThan(0);

    // Populate LOD 3 cache (as Layer Thumbnail and Navigator Preview do)
    const lod3Before = grid.getOrBuildLod3Tiles('layer-1');
    expect(lod3Before.length).toBe(1);

    // Undo back to empty layer
    grid.applyTileDeltas(deltas, 'undo');
    expect(grid.getLayerTiles('layer-1', 0).length).toBe(0);
    // LOD 3 MUST now be empty, never returning the stale pre-undo tile
    expect(grid.getOrBuildLod3Tiles('layer-1').length).toBe(0);
  });

  it('supports full Ctrl+Z / Ctrl+Y undo and redo for screentone, toggleTone with selection, layer CRUD, clear, merge, and rasterize', async () => {
    const grid = new SparseTileGrid();
    let harness!: {
      layerMgr: ReturnType<typeof useLayerManager>;
      history: ReturnType<typeof useDrawingHistory>;
    };

    const Harness: React.FC = () => {
      const pushHistoryStepRef = useRef<PushHistoryStepFn | null>(null);
      const layerMgr = useLayerManager({
        dimensions: DIMS,
        tileGrid: grid,
        pushHistoryStepRef,
      });

      const dimensionsRef = useRef(DIMS);
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
        activeLayerLocked: Boolean(layerMgr.activeLayer?.locked),
        dimensions: DIMS,
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

      pushHistoryStepRef.current = history.pushHistoryStep;
      harness = { layerMgr, history };
      return null;
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<Harness />);
    });

    act(() => {
      harness.layerMgr.resetToNewCanvas(DIMS, '#ffffff', 'color', 60);
      harness.history.resetHistory();
    });

    const initialLayer1Id = harness.layerMgr.activeLayerId;
    expect(harness.layerMgr.layers.length).toBe(2);

    // 1. Screentone with Lasso selection -> Undo removes BOTH pixels AND Screen Tone layer -> Redo restores both
    const lasso = makeTriangleLasso();
    let toneId = '';
    act(() => {
      const res = harness.layerMgr.fillScreentoneSelection(lasso, 40, 60, 45, 'circle', 'specified');
      toneId = res.id;
      harness.history.pushHistoryStep(
        'screentone',
        'Screentone (40%)',
        null,
        null,
        res.id,
        lasso.bounds,
        res.tileDeltas,
        undefined,
        undefined,
        undefined,
        false,
        res.layerTreeDelta
      );
    });
    expect(harness.layerMgr.layers.some((l) => l.id === toneId)).toBe(true);
    expect(readPixel(grid, toneId, 110, 86)[3]).toBe(255);
    expect(readPixel(grid, toneId, 45, 170)[3]).toBe(0);

    await act(async () => {
      await harness.history.jumpToHistoryIndex(harness.history.historyIndex - 1);
    });
    expect(harness.layerMgr.layers.some((l) => l.id === toneId)).toBe(false);
    expect(grid.getLayerTiles(toneId, 0).length).toBe(0);

    await act(async () => {
      await harness.history.jumpToHistoryIndex(harness.history.historyIndex + 1);
    });
    expect(harness.layerMgr.layers.some((l) => l.id === toneId)).toBe(true);
    expect(readPixel(grid, toneId, 110, 86)[3]).toBe(255);

    // 2. Delete Screentone layer -> Undo restores BOTH layer AND pixels
    act(() => {
      harness.layerMgr.deleteLayer(toneId);
    });
    expect(harness.layerMgr.layers.some((l) => l.id === toneId)).toBe(false);
    expect(grid.getLayerTiles(toneId, 0).length).toBe(0);

    await act(async () => {
      await harness.history.jumpToHistoryIndex(harness.history.historyIndex - 1);
    });
    expect(harness.layerMgr.layers.some((l) => l.id === toneId)).toBe(true);
    expect(readPixel(grid, toneId, 110, 86)[3]).toBe(255);

    // 3. toggleTone with active selection on empty Layer 1 -> fills selection AND undoes cleanly
    act(() => {
      harness.layerMgr.toggleTone(initialLayer1Id, lasso);
    });
    const layer1AfterTone = harness.layerMgr.layers.find((l) => l.id === initialLayer1Id);
    expect(layer1AfterTone?.toneEnabled).toBe(true);
    expect(layer1AfterTone?.isToneLayer).toBe(true);
    expect(readPixel(grid, initialLayer1Id, 110, 86)[3]).toBe(255);

    await act(async () => {
      await harness.history.jumpToHistoryIndex(harness.history.historyIndex - 1);
    });
    expect(harness.layerMgr.layers.find((l) => l.id === initialLayer1Id)?.toneEnabled).toBeFalsy();
    expect(grid.getLayerTiles(initialLayer1Id, 0).length).toBe(0);

    // 4. Add Layer, Clear Active Layer, Merge Down, Blend Mode, and Rasterize all undo cleanly
    let addedId = '';
    act(() => {
      const added = harness.layerMgr.addLayer('raster');
      addedId = added.id;
    });
    expect(harness.layerMgr.layers.some((l) => l.id === addedId)).toBe(true);

    act(() => {
      paintSolidRect(grid, addedId, 10, 10, 30, 30, [255, 0, 0, 255]);
      harness.layerMgr.clearActiveLayer();
    });
    expect(readPixel(grid, addedId, 20, 20)[3]).toBe(0);

    await act(async () => {
      await harness.history.jumpToHistoryIndex(harness.history.historyIndex - 1);
    });
    expect(readPixel(grid, addedId, 20, 20)).toEqual([255, 0, 0, 255]);

    // Merge Down onto layer below (toneId)
    act(() => {
      harness.layerMgr.mergeDown(addedId);
    });
    expect(harness.layerMgr.layers.some((l) => l.id === addedId)).toBe(false);
    expect(readPixel(grid, toneId, 20, 20)).toEqual([255, 0, 0, 255]);

    await act(async () => {
      await harness.history.jumpToHistoryIndex(harness.history.historyIndex - 1);
    });
    expect(harness.layerMgr.layers.some((l) => l.id === addedId)).toBe(true);
    expect(readPixel(grid, addedId, 20, 20)).toEqual([255, 0, 0, 255]);
    expect(readPixel(grid, toneId, 20, 20)[3]).toBe(0);

    // Blend Mode undo
    act(() => {
      harness.layerMgr.setBlendMode(addedId, 'multiply');
    });
    expect(harness.layerMgr.layers.find((l) => l.id === addedId)?.blendMode).toBe('multiply');
    await act(async () => {
      await harness.history.jumpToHistoryIndex(harness.history.historyIndex - 1);
    });
    expect(harness.layerMgr.layers.find((l) => l.id === addedId)?.blendMode).toBe('normal');

    // Text layer create + Rasterize -> Undo reverts type back to 'text'
    let textId = '';
    act(() => {
      const tl = harness.layerMgr.upsertTextLayer({
        text: 'Hello',
        fontFamily: 'sans-serif',
        fontSize: 24,
        color: '#000000',
        bold: false,
        italic: false,
        align: 'left',
        outline: false,
        outlineColor: '#ffffff',
        outlineWidth: 0,
        writingMode: 'horizontal-tb',
        lineSpacing: 1.25,
        x: 50,
        y: 50,
      });
      textId = tl.id;
    });
    expect(harness.layerMgr.layers.find((l) => l.id === textId)?.type).toBe('text');

    act(() => {
      harness.layerMgr.rasterizeLayer(textId);
    });
    expect(harness.layerMgr.layers.find((l) => l.id === textId)?.type).toBe('raster');

    await act(async () => {
      await harness.history.jumpToHistoryIndex(harness.history.historyIndex - 1);
    });
    expect(harness.layerMgr.layers.find((l) => l.id === textId)?.type).toBe('text');
  });

  it('isEditableTarget does not block Ctrl+Z / Ctrl+Y when a <select> dropdown has focus', () => {
    const selectEl = document.createElement('select');
    const ctrlZ = { ctrlKey: true, metaKey: false, key: 'z' } as KeyboardEvent;
    const bareB = { ctrlKey: false, metaKey: false, key: 'b' } as KeyboardEvent;
    expect(isEditableTarget(selectEl, ctrlZ)).toBe(false);
    expect(isEditableTarget(selectEl, bareB)).toBe(true);

    const textInput = document.createElement('input');
    (textInput as any).type = 'text';
    expect(isEditableTarget(textInput, ctrlZ)).toBe(true);
  });
});
