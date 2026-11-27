import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SparseTileGrid, TILE_SIZE } from '../tileEngine';
import { documentStore } from '../documentStore';
import {
  useDrawingHistory,
  UseDrawingHistoryResult,
} from '../../hooks/drawing/useDrawingHistory';
import {
  DraftCanvasElement,
  LastStrokeEndState,
} from '../../hooks/drawing/types';
import {
  prepareRawDraftCanvasForStrokeTexture,
  resetAndClearOffscreenDraftCanvas,
} from '../../hooks/drawing/brushStrokeSession/strokeHelpers';
import { createInitialStrokeSessionState } from '../../hooks/drawing/brushStrokeSession/types';
import {
  NativeTabletBridgeState,
  processNativeTabletBatch,
} from '../../hooks/drawing/brushStrokeSession/nativeTabletBridge';
import type { LayerItem } from '../../types/editor';

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

function paintPixelAndCaptureDeltas(
  grid: SparseTileGrid,
  layerId: string,
  x: number,
  y: number,
  rgba: [number, number, number, number]
) {
  const dirty = { x, y, width: 4, height: 4 };
  const before = grid.snapshotTilesInRect(layerId, dirty);
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  grid.writeImageData(layerId, { data, width: 4, height: 4 }, x, y, 'color-32bit');
  const deltas = grid.computeDeltasFromSnapshot(before, layerId);
  return { dirty, deltas };
}

function readPixel(grid: SparseTileGrid, layerId: string, x: number, y: number): [number, number, number, number] {
  const tile = grid.getTile(layerId, Math.floor(x / TILE_SIZE), Math.floor(y / TILE_SIZE), 0);
  if (!tile) return [0, 0, 0, 0];
  const rgba = grid.getTileAsRGBA(tile);
  const lx = x % TILE_SIZE;
  const ly = y % TILE_SIZE;
  const idx = (ly * TILE_SIZE + lx) * 4;
  return [rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3]];
}

describe('Ctrl+Z Ghost Stroke & Rapid-Draw Regression Suite', () => {
  let root: Root | null = null;
  let container: any = null;

  beforeEach(() => {
    vi.restoreAllMocks();
    const doc = installDomShim();
    container = doc.createElement('div');
    doc.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
  });

  it('applies in-RAM Ctrl+Z undo/redo synchronously, clears lastStrokeEndRef, and handles rapid double Ctrl+Z without dropping presses', () => {
    const sessionId = `sync-undo-test-${Date.now()}`;
    const sess = documentStore.getOrCreateSession(sessionId);
    const grid = sess.tileGrid;
    const dims = { width: 512, height: 512, dpi: 300 };
    const layer: LayerItem = {
      id: 'layer-1',
      name: 'Sketch',
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      locked: false,
      parentId: null,
    };

    const dimsRef = { current: dims };
    const activeLayerIdRef = { current: 'layer-1' };
    const colorModeRef = { current: 'color' as const };
    const layersRef = { current: [layer] as LayerItem[] | undefined };
    const onUpdateMaskThumbnailRef = { current: undefined };
    const isDrawingRef = { current: false };
    const lastStrokeEndRef = {
      current: { x: 100, y: 100, pressure: 0.5, width: 6, layerId: 'layer-1' } as LastStrokeEndState | null,
    };
    const abortActiveStrokeRef = { current: vi.fn() };
    const onUpdateLayerThumbnail = vi.fn();

    let hookApi: UseDrawingHistoryResult | null = null;
    const Harness: React.FC = () => {
      hookApi = useDrawingHistory({
        activeSessionId: sessionId,
        tileGrid: grid,
        activeLayerId: 'layer-1',
        activeLayerLocked: false,
        dimensions: dims,
        dimensionsRef: dimsRef,
        activeLayerIdRef,
        colorModeRef,
        layersRef,
        onUpdateLayerThumbnail,
        onUpdateMaskThumbnailRef,
        isDrawingRef,
        lastStrokeEndRef,
        abortActiveStrokeRef,
      });
      return null;
    };

    act(() => {
      root!.render(<Harness />);
    });
    expect(hookApi).not.toBeNull();

    act(() => {
      const s1 = paintPixelAndCaptureDeltas(grid, 'layer-1', 10, 10, [255, 0, 0, 255]);
      hookApi!.pushHistoryStep('brush', 'Stroke 1', null, null, 'layer-1', s1.dirty, s1.deltas);
      const s2 = paintPixelAndCaptureDeltas(grid, 'layer-1', 40, 40, [0, 0, 255, 255]);
      hookApi!.pushHistoryStep('brush', 'Stroke 2', null, null, 'layer-1', s2.dirty, s2.deltas);
    });

    expect(readPixel(grid, 'layer-1', 10, 10)).toEqual([255, 0, 0, 255]);
    expect(readPixel(grid, 'layer-1', 40, 40)).toEqual([0, 0, 255, 255]);

    // Single synchronous undo — MUST take effect immediately without awaiting any microtask!
    act(() => {
      hookApi!.undo();
      expect(readPixel(grid, 'layer-1', 40, 40)).toEqual([0, 0, 0, 0]);
      expect(readPixel(grid, 'layer-1', 10, 10)).toEqual([255, 0, 0, 255]);
      expect(lastStrokeEndRef.current).toBeNull();
    });

    // Redo then rapid double Ctrl+Z in the exact same synchronous tick — neither press may be dropped!
    act(() => {
      hookApi!.redo();
      expect(readPixel(grid, 'layer-1', 40, 40)).toEqual([0, 0, 255, 255]);

      hookApi!.undo();
      hookApi!.undo();
      expect(readPixel(grid, 'layer-1', 40, 40)).toEqual([0, 0, 0, 0]);
      expect(readPixel(grid, 'layer-1', 10, 10)).toEqual([0, 0, 0, 0]);
    });

    void sess.resetHistory();
  });

  it('tracks pendingTargetIndex for rapid double Ctrl+Z even when history steps are offloaded to compressed RAM', async () => {
    const sessionId = `async-undo-test-${Date.now()}`;
    const sess = documentStore.getOrCreateSession(sessionId);
    const grid = sess.tileGrid;
    const dims = { width: 512, height: 512, dpi: 300 };
    const layer: LayerItem = {
      id: 'layer-1',
      name: 'Sketch',
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      locked: false,
      parentId: null,
    };

    const dimsRef = { current: dims };
    const activeLayerIdRef = { current: 'layer-1' };
    const colorModeRef = { current: 'color' as const };
    const layersRef = { current: [layer] as LayerItem[] | undefined };
    const onUpdateMaskThumbnailRef = { current: undefined };
    const isDrawingRef = { current: false };
    const lastStrokeEndRef = { current: null as LastStrokeEndState | null };
    const abortActiveStrokeRef = { current: vi.fn() };

    let hookApi: UseDrawingHistoryResult | null = null;
    const Harness: React.FC = () => {
      hookApi = useDrawingHistory({
        activeSessionId: sessionId,
        tileGrid: grid,
        activeLayerId: 'layer-1',
        activeLayerLocked: false,
        dimensions: dims,
        dimensionsRef: dimsRef,
        activeLayerIdRef,
        colorModeRef,
        layersRef,
        onUpdateLayerThumbnail: vi.fn(),
        onUpdateMaskThumbnailRef,
        isDrawingRef,
        lastStrokeEndRef,
        abortActiveStrokeRef,
      });
      return null;
    };

    act(() => {
      root!.render(<Harness />);
    });

    act(() => {
      const s1 = paintPixelAndCaptureDeltas(grid, 'layer-1', 10, 10, [10, 20, 30, 255]);
      hookApi!.pushHistoryStep('brush', 'Stroke 1', null, null, 'layer-1', s1.dirty, s1.deltas);
      const s2 = paintPixelAndCaptureDeltas(grid, 'layer-1', 50, 50, [40, 50, 60, 255]);
      hookApi!.pushHistoryStep('brush', 'Stroke 2', null, null, 'layer-1', s2.dirty, s2.deltas);
    });

    // Force-offload both steps so jumpToHistoryIndex must take the async decompression path
    await sess.undoCache.offloadAllToDisk(sess.history);
    expect(sess.history[1].tileDeltas).toBeUndefined();
    expect(sess.history[2].tileDeltas).toBeUndefined();

    // Fire two Ctrl+Z presses back-to-back before the first async decompression finishes
    await act(async () => {
      hookApi!.undo();
      hookApi!.undo();
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(readPixel(grid, 'layer-1', 50, 50)).toEqual([0, 0, 0, 0]);
    expect(readPixel(grid, 'layer-1', 10, 10)).toEqual([0, 0, 0, 0]);

    void sess.resetHistory();
  });

  it('keeps save/restore clip stack balanced on rawDraftCanvas across strokes so clearRect is never clipped', () => {
    const state = createInitialStrokeSessionState();
    const ops: string[] = [];
    let saveDepth = 0;

    const mockCtx = {
      save: () => {
        saveDepth++;
        ops.push(`save:${saveDepth}`);
      },
      restore: () => {
        saveDepth = Math.max(0, saveDepth - 1);
        ops.push(`restore:${saveDepth}`);
      },
      resetTransform: () => ops.push('resetTransform'),
      clearRect: () => ops.push(`clearRect@depth:${saveDepth}`),
      setTransform: () => ops.push('setTransform'),
      beginPath: () => {},
      rect: () => {},
      clip: () => {},
    } as unknown as CanvasRenderingContext2D;

    const rawCanvas = {
      width: 512,
      height: 512,
      getContext: () => mockCtx,
    } as unknown as DraftCanvasElement;
    state.rawDraftCanvas = rawCanvas;

    const draftCanvas = {
      width: 512,
      height: 512,
      __draftScale: 1,
      __draftDocRect: { x: 0, y: 0, width: 512, height: 512 },
    } as unknown as DraftCanvasElement;

    // Stroke 1 start -> clearRect runs at depth 0, then clip saved at depth 1
    prepareRawDraftCanvasForStrokeTexture(state, draftCanvas, { width: 512, height: 512 }, null);
    expect(saveDepth).toBe(1);
    expect(ops).toContain('clearRect@depth:0');

    // Stroke 1 end -> restore runs before clearRect (back to depth 0)
    ops.length = 0;
    resetAndClearOffscreenDraftCanvas(state.rawDraftCanvas as DraftCanvasElement);
    expect(saveDepth).toBe(0);
    expect(ops).toContain('clearRect@depth:0');

    // Stroke 2 start -> even if pointerUp was bypassed, preparing again restores before clearing
    prepareRawDraftCanvasForStrokeTexture(state, draftCanvas, { width: 512, height: 512 }, null);
    ops.length = 0;
    prepareRawDraftCanvasForStrokeTexture(state, draftCanvas, { width: 512, height: 512 }, null);
    expect(saveDepth).toBe(1);
    expect(ops).toContain('clearRect@depth:0');
  });

  it('resyncs nativeTabletBridge on next phase=1 pen-down after an external Ctrl+Z stroke abort', () => {
    const bridge: NativeTabletBridgeState = {
      nativeStrokeActive: true, // Simulates WinTab stroke aborted externally by Ctrl+Z before phase=3 arrived
      prevToolBeforeEraserFlip: null,
    };
    const onPointerDown = vi.fn();
    const onPointerMove = vi.fn();
    const onPointerUp = vi.fn();
    const onHover = vi.fn();

    processNativeTabletBatch(
      [
        {
          clientX: 200,
          clientY: 200,
          pressure: 0.4,
          tiltX: 0,
          tiltY: 0,
          twist: 0,
          buttons: 1,
          phase: 1,
          timestamp: 100,
          backend: 1,
        },
      ],
      bridge,
      { shift: false, alt: false },
      {
        getTool: () => 'brush',
        selectTool: vi.fn(),
        isDisabled: () => false,
        isStrokeActive: () => false, // Session was aborted by Ctrl+Z
        isPointOverCanvasViewport: () => true,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onHover,
      }
    );

    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onPointerMove).toHaveBeenCalledTimes(0);
    expect(bridge.nativeStrokeActive).toBe(true);
  });
});
