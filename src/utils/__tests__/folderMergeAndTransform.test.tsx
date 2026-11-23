import { act, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useLayerManager,
  getFolderDescendantIds,
  computeMergeFolderLayers,
} from '../../hooks/useLayerManager';
import { useDrawingHistory } from '../../hooks/drawing/useDrawingHistory';
import { useSelectionTools } from '../../hooks/drawing/useSelectionTools';
import {
  resolveTransformTargetLayers,
  getTransformPreviewLayerState,
} from '../transformEngine';
import { SparseTileGrid } from '../tileEngine';
import type { CanvasDimensions, LayerItem } from '../../types/editor';

// Lightweight in-memory 2D Canvas shim so pixel transforms & region canvases execute real pixel ops in Node Vitest
class ShimImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(dataOrW: Uint8ClampedArray | number, widthOrH: number, height?: number) {
    if (typeof dataOrW === 'number') {
      this.width = dataOrW;
      this.height = widthOrH;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
    } else {
      this.data = dataOrW;
      this.width = widthOrH;
      this.height = height ?? Math.floor(dataOrW.length / (4 * widthOrH));
    }
  }
}

class ShimCanvas2DContext {
  canvas: ShimCanvasElement;
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  imageSmoothingEnabled = true;
  imageSmoothingQuality = 'high';
  private tx = 0;
  private ty = 0;
  private sx = 1;
  private sy = 1;
  private stack: Array<{
    tx: number;
    ty: number;
    sx: number;
    sy: number;
    globalAlpha: number;
    globalCompositeOperation: string;
  }> = [];

  constructor(canvas: ShimCanvasElement) {
    this.canvas = canvas;
  }

  save() {
    this.stack.push({
      tx: this.tx,
      ty: this.ty,
      sx: this.sx,
      sy: this.sy,
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation,
    });
  }

  restore() {
    const prev = this.stack.pop();
    if (prev) {
      this.tx = prev.tx;
      this.ty = prev.ty;
      this.sx = prev.sx;
      this.sy = prev.sy;
      this.globalAlpha = prev.globalAlpha;
      this.globalCompositeOperation = prev.globalCompositeOperation;
    }
  }

  setTransform(_a: number, _b: number, _c: number, _d: number, e: number, f: number) {
    this.tx = e;
    this.ty = f;
    this.sx = 1;
    this.sy = 1;
  }

  resetTransform() {
    this.tx = 0;
    this.ty = 0;
    this.sx = 1;
    this.sy = 1;
  }

  translate(x: number, y: number) {
    this.tx += x * this.sx;
    this.ty += y * this.sy;
  }

  rotate(_rad: number) {
    // Supported for zero-rotation affine tests
  }

  scale(x: number, y: number) {
    this.sx *= x;
    this.sy *= y;
  }

  createImageData(w: number, h: number): ShimImageData {
    return new ShimImageData(w, h);
  }

  clearRect(x: number, y: number, w: number, h: number) {
    const buf = this.canvas.pixels;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(cw, Math.ceil(x + w));
    const y1 = Math.min(ch, Math.ceil(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const off = (py * cw + px) * 4;
        buf[off] = 0;
        buf[off + 1] = 0;
        buf[off + 2] = 0;
        buf[off + 3] = 0;
      }
    }
  }

  putImageData(
    img: ShimImageData,
    dx: number,
    dy: number,
    dirtyX = 0,
    dirtyY = 0,
    dirtyW = img.width,
    dirtyH = img.height
  ) {
    const dst = this.canvas.pixels;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    for (let sy = dirtyY; sy < dirtyY + dirtyH; sy++) {
      const py = Math.floor(dy + sy);
      if (py < 0 || py >= ch || sy < 0 || sy >= img.height) continue;
      for (let sx = dirtyX; sx < dirtyX + dirtyW; sx++) {
        const px = Math.floor(dx + sx);
        if (px < 0 || px >= cw || sx < 0 || sx >= img.width) continue;
        const sOff = (sy * img.width + sx) * 4;
        const dOff = (py * cw + px) * 4;
        dst[dOff] = img.data[sOff];
        dst[dOff + 1] = img.data[sOff + 1];
        dst[dOff + 2] = img.data[sOff + 2];
        dst[dOff + 3] = img.data[sOff + 3];
      }
    }
  }

  getImageData(x: number, y: number, w: number, h: number): ShimImageData {
    const out = new Uint8ClampedArray(w * h * 4);
    const src = this.canvas.pixels;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    for (let py = 0; py < h; py++) {
      const sy = y0 + py;
      if (sy < 0 || sy >= ch) continue;
      for (let px = 0; px < w; px++) {
        const sx = x0 + px;
        if (sx < 0 || sx >= cw) continue;
        const sOff = (sy * cw + sx) * 4;
        const dOff = (py * w + px) * 4;
        out[dOff] = src[sOff];
        out[dOff + 1] = src[sOff + 1];
        out[dOff + 2] = src[sOff + 2];
        out[dOff + 3] = src[sOff + 3];
      }
    }
    return new ShimImageData(out, w, h);
  }

  drawImage(
    src: ShimCanvasElement,
    dx: number,
    dy: number,
    dw?: number,
    dh?: number
  ) {
    if (!src || !src.pixels) return;
    const sw = src.width;
    const sh = src.height;
    const drawW = dw ?? sw;
    const drawH = dh ?? sh;
    if (sw <= 0 || sh <= 0 || drawW <= 0 || drawH <= 0) return;

    const dst = this.canvas.pixels;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const alpha = Math.max(0, Math.min(1, this.globalAlpha));

    for (let py = 0; py < Math.ceil(drawH); py++) {
      const sy = Math.min(sh - 1, Math.floor((py / drawH) * sh));
      const worldY = Math.floor(this.ty + (dy + py) * this.sy);
      if (worldY < 0 || worldY >= ch) continue;

      for (let px = 0; px < Math.ceil(drawW); px++) {
        const sx = Math.min(sw - 1, Math.floor((px / drawW) * sw));
        const worldX = Math.floor(this.tx + (dx + px) * this.sx);
        if (worldX < 0 || worldX >= cw) continue;

        const sOff = (sy * sw + sx) * 4;
        const sA = (src.pixels[sOff + 3] / 255) * alpha;
        if (sA <= 0) continue;

        const dOff = (worldY * cw + worldX) * 4;
        const dA = dst[dOff + 3] / 255;
        const outA = sA + dA * (1 - sA);
        if (outA > 0) {
          dst[dOff] = Math.round((src.pixels[sOff] * sA + dst[dOff] * dA * (1 - sA)) / outA);
          dst[dOff + 1] = Math.round((src.pixels[sOff + 1] * sA + dst[dOff + 1] * dA * (1 - sA)) / outA);
          dst[dOff + 2] = Math.round((src.pixels[sOff + 2] * sA + dst[dOff + 2] * dA * (1 - sA)) / outA);
          dst[dOff + 3] = Math.round(outA * 255);
        }
      }
    }
  }
}

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
  getContext(_type?: string): any {
    return null;
  }
}

class ShimCanvasElement extends ShimNode {
  private _width = 0;
  private _height = 0;
  pixels = new Uint8ClampedArray(0);
  private ctx2d: ShimCanvas2DContext | null = null;
  private enable2d: boolean;

  constructor(doc?: any, enable2d = true) {
    super('CANVAS', doc);
    this.enable2d = enable2d;
  }

  get width() {
    return this._width;
  }
  set width(v: number) {
    this._width = Math.max(0, Math.floor(v));
    this.pixels = new Uint8ClampedArray(this._width * this._height * 4);
  }
  get height() {
    return this._height;
  }
  set height(v: number) {
    this._height = Math.max(0, Math.floor(v));
    this.pixels = new Uint8ClampedArray(this._width * this._height * 4);
  }

  getContext(type?: string): any {
    if (type === '2d' && this.enable2d) {
      if (!this.ctx2d) this.ctx2d = new ShimCanvas2DContext(this);
      return this.ctx2d;
    }
    return null;
  }

  toDataURL() {
    return 'data:image/png;base64,';
  }
}

function installDomShim(enable2d = true) {
  const doc: any = new ShimNode('#document');
  doc.nodeType = 9;
  doc.activeElement = null;
  doc.createElement = (tag: string) =>
    tag.toLowerCase() === 'canvas' ? new ShimCanvasElement(doc, enable2d) : new ShimNode(tag, doc);
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
  (globalThis as any).ImageData = ShimImageData;
  return doc;
}

function makeLayer(
  id: string,
  overrides: Partial<LayerItem> = {}
): LayerItem {
  const type = overrides.type ?? 'raster';
  return {
    id,
    name: overrides.name ?? id,
    type,
    visible: true,
    opacity: 1,
    blendMode: type === 'folder' ? 'pass-through' : 'normal',
    locked: false,
    collapsed: false,
    parentId: null,
    thumbnailUrl: '',
    ...overrides,
  };
}

function paintRect(
  grid: SparseTileGrid,
  layerId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a = 255
) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  grid.writeImageData(layerId, { data, width: w, height: h }, x, y, 'color-32bit');
}

describe('Folder Merge Pure Logic', () => {
  it('collects direct and nested descendants and replaces folder with a single raster layer at exact stack index', () => {
    const layers: LayerItem[] = [
      makeLayer('top', { name: 'Top' }),
      makeLayer('f1', {
        name: 'Character',
        type: 'folder',
        opacity: 0.8,
        blendMode: 'pass-through',
        clipped: true,
        visible: true,
      }),
      makeLayer('c1', { name: 'Lineart', parentId: 'f1' }),
      makeLayer('sub', { name: 'Colors', type: 'folder', parentId: 'f1' }),
      makeLayer('c2', { name: 'Flat', parentId: 'sub' }),
      makeLayer('c3', { name: 'Shade', parentId: 'sub' }),
      makeLayer('bg', { name: 'Background' }),
    ];

    expect(getFolderDescendantIds(layers, 'f1')).toEqual(['c1', 'sub', 'c2', 'c3']);

    const plan = computeMergeFolderLayers(layers, 'f1', 'merged-char');
    expect(plan).not.toBeNull();
    if (!plan) return;

    expect(plan.mergedLayer.id).toBe('merged-char');
    expect(plan.mergedLayer.type).toBe('raster');
    expect(plan.mergedLayer.name).toBe('Character');
    expect(plan.mergedLayer.opacity).toBe(0.8);
    expect(plan.mergedLayer.blendMode).toBe('normal'); // pass-through -> normal
    expect(plan.mergedLayer.clipped).toBe(true);
    expect(plan.mergedLayer.parentId).toBeNull();
    expect(plan.nextLayers.map((l) => l.id)).toEqual(['top', 'merged-char', 'bg']);
  });

  it('preserves isolated folder blend mode, parentId, visibility, and rejects locked or non-folder targets', () => {
    const layers: LayerItem[] = [
      makeLayer('outer', { type: 'folder' }),
      makeLayer('inner', {
        name: 'Shadows',
        type: 'folder',
        parentId: 'outer',
        blendMode: 'multiply',
        opacity: 0.65,
        visible: false,
      }),
      makeLayer('child', { parentId: 'inner' }),
      makeLayer('locked-folder', { type: 'folder', locked: true }),
      makeLayer('plain', { type: 'raster' }),
    ];

    const plan = computeMergeFolderLayers(layers, 'inner', 'merged-shadows');
    expect(plan).not.toBeNull();
    expect(plan?.mergedLayer.blendMode).toBe('multiply');
    expect(plan?.mergedLayer.parentId).toBe('outer');
    expect(plan?.mergedLayer.opacity).toBe(0.65);
    expect(plan?.mergedLayer.visible).toBe(false);

    expect(computeMergeFolderLayers(layers, 'locked-folder')).toBeNull();
    expect(computeMergeFolderLayers(layers, 'plain')).toBeNull();
  });

  it('supports merging an empty folder or a frame-folder into a single raster layer', () => {
    const layers: LayerItem[] = [
      makeLayer('empty-f', { name: 'Empty Group', type: 'folder' }),
      makeLayer('frame-f', { name: 'Panel 1', type: 'frame-folder', blendMode: 'normal' }),
      makeLayer('panel-art', { parentId: 'frame-f' }),
    ];

    const emptyPlan = computeMergeFolderLayers(layers, 'empty-f', 'merged-empty');
    expect(emptyPlan?.descendantIds).toEqual([]);
    expect(emptyPlan?.nextLayers.map((l) => l.id)).toEqual(['merged-empty', 'frame-f', 'panel-art']);

    const framePlan = computeMergeFolderLayers(layers, 'frame-f', 'merged-frame');
    expect(framePlan?.descendantIds).toEqual(['panel-art']);
    expect(framePlan?.mergedLayer.type).toBe('raster');
    expect(framePlan?.nextLayers.map((l) => l.id)).toEqual(['empty-f', 'merged-frame']);
  });
});

describe('Folder Transform Target Resolution', () => {
  const layers: LayerItem[] = [
    makeLayer('folder-main', { type: 'folder', opacity: 0.8 }),
    makeLayer('l-top', { parentId: 'folder-main', opacity: 0.5 }),
    makeLayer('sub-open', { type: 'folder', parentId: 'folder-main', opacity: 0.5 }),
    makeLayer('l-nested', { parentId: 'sub-open', visible: true }),
    makeLayer('l-hidden', { parentId: 'sub-open', visible: false }),
    makeLayer('l-locked-child', { parentId: 'folder-main', locked: true }),
    makeLayer('sub-locked', { type: 'folder', parentId: 'folder-main', locked: true }),
    makeLayer('l-in-locked-sub', { parentId: 'sub-locked' }),
    makeLayer('l-adj', { type: 'adjustment', parentId: 'folder-main' }),
    makeLayer('folder-locked', { type: 'folder', locked: true }),
    makeLayer('l-in-locked', { parentId: 'folder-locked' }),
    makeLayer('folder-empty', { type: 'folder' }),
    makeLayer('frame-folder', { type: 'frame-folder' }),
    makeLayer('l-frame-art', { parentId: 'frame-folder' }),
    makeLayer('l-outside'),
  ];

  it('recursively resolves all unlocked raster layers inside a selected folder while skipping locked descendants', () => {
    const folderMain = layers.find((l) => l.id === 'folder-main')!;
    const res = resolveTransformTargetLayers(layers, folderMain, ['folder-main']);
    expect(res.includesFolder).toBe(true);
    expect(res.blockedReason).toBeUndefined();
    expect(res.targetLayers.map((l) => l.id)).toEqual(['l-top', 'l-nested', 'l-hidden']);
  });

  it('blocks locked folders and empty folders with specific reasons', () => {
    const lockedFolder = layers.find((l) => l.id === 'folder-locked')!;
    const lockedRes = resolveTransformTargetLayers(layers, lockedFolder, ['folder-locked']);
    expect(lockedRes.targetLayers).toEqual([]);
    expect(lockedRes.blockedReason).toBe('locked');

    const emptyFolder = layers.find((l) => l.id === 'folder-empty')!;
    const emptyRes = resolveTransformTargetLayers(layers, emptyFolder, ['folder-empty']);
    expect(emptyRes.targetLayers).toEqual([]);
    expect(emptyRes.blockedReason).toBe('empty-folder');
  });

  it('resolves frame-folders and multi-selections mixing folders and individual layers without duplicates', () => {
    const frameFolder = layers.find((l) => l.id === 'frame-folder')!;
    const frameRes = resolveTransformTargetLayers(layers, frameFolder, ['frame-folder']);
    expect(frameRes.targetLayers.map((l) => l.id)).toEqual(['l-frame-art']);

    const folderMain = layers.find((l) => l.id === 'folder-main')!;
    const multiRes = resolveTransformTargetLayers(layers, folderMain, [
      'folder-main',
      'l-top',
      'l-outside',
    ]);
    expect(multiRes.includesFolder).toBe(true);
    expect(multiRes.targetLayers.map((l) => l.id)).toEqual([
      'l-top',
      'l-nested',
      'l-hidden',
      'l-outside',
    ]);
  });

  it('computes accurate preview visibility and nested opacity relative to selected folder root', () => {
    const layerMap = new Map(layers.map((l) => [l.id, l]));
    const roots = new Set(['folder-main']);

    const topState = getTransformPreviewLayerState(layerMap.get('l-top')!, layerMap, roots);
    expect(topState.visible).toBe(true);
    expect(topState.opacity).toBeCloseTo(0.4, 5); // 0.5 * 0.8

    const nestedState = getTransformPreviewLayerState(layerMap.get('l-nested')!, layerMap, roots);
    expect(nestedState.visible).toBe(true);
    expect(nestedState.opacity).toBeCloseTo(0.4, 5); // 1 * 0.5 * 0.8

    const hiddenState = getTransformPreviewLayerState(layerMap.get('l-hidden')!, layerMap, roots);
    expect(hiddenState.visible).toBe(false);
  });
});

describe('End-to-End Folder Merge and Folder Transform with SparseTileGrid & Undo/Redo', () => {
  let root: Root | null = null;
  let container: any = null;

  beforeEach(() => {
    const doc = installDomShim(true);
    container = doc.createElement('div');
    doc.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container = null;
  });

  it('merges a folder with nested layers into one raster layer and fully supports Undo and Redo', async () => {
    const grid = new SparseTileGrid();
    const dims: CanvasDimensions = { width: 128, height: 128 };
    let layerMgrApi: ReturnType<typeof useLayerManager> | null = null;
    let historyApi: ReturnType<typeof useDrawingHistory> | null = null;

    function Harness() {
      const pushHistoryRef = useRef<any>(null);
      const layerMgr = useLayerManager({
        dimensions: dims,
        tileGrid: grid,
        pushHistoryStepRef: pushHistoryRef,
      });

      const dimsRef = useRef(dims);
      const activeLayerIdRef = useRef(layerMgr.activeLayerId);
      activeLayerIdRef.current = layerMgr.activeLayerId;
      const colorModeRef = useRef<'color' | 'grayscale' | 'monochrome'>('color');
      const layersRef = useRef<LayerItem[] | undefined>(layerMgr.layers);
      layersRef.current = layerMgr.layers;
      const applyTreeRef = useRef(layerMgr.applyLayerTreeDelta);
      applyTreeRef.current = layerMgr.applyLayerTreeDelta;
      const updateMaskRef = useRef(layerMgr.updateMaskThumbnail);
      updateMaskRef.current = layerMgr.updateMaskThumbnail;
      const isDrawingRef = useRef(false);
      const lastStrokeEndRef = useRef(null);
      const abortRef = useRef(() => {});

      const history = useDrawingHistory({
        tileGrid: grid,
        activeLayerId: layerMgr.activeLayerId,
        activeLayerLocked: false,
        dimensions: dims,
        dimensionsRef: dimsRef,
        activeLayerIdRef,
        colorModeRef,
        layersRef,
        onUpdateLayerThumbnail: layerMgr.updateLayerThumbnail,
        onApplyLayerTreeDeltaRef: applyTreeRef,
        onUpdateMaskThumbnailRef: updateMaskRef,
        isDrawingRef,
        lastStrokeEndRef,
        abortActiveStrokeRef: abortRef,
      });

      pushHistoryRef.current = history.pushHistoryStep;
      layerMgrApi = layerMgr;
      historyApi = history;
      return null;
    }

    root = createRoot(container);
    act(() => {
      root!.render(<Harness />);
    });

    const initialLayers: LayerItem[] = [
      makeLayer('folder-1', { name: 'Hero', type: 'folder', opacity: 0.75, blendMode: 'pass-through' }),
      makeLayer('child-top', { name: 'Top Blue', parentId: 'folder-1', opacity: 1 }),
      makeLayer('sub-1', { name: 'Sub', type: 'folder', parentId: 'folder-1' }),
      makeLayer('child-bottom', { name: 'Bottom Red', parentId: 'sub-1', opacity: 1 }),
      makeLayer('child-hidden', { name: 'Hidden Green', parentId: 'folder-1', visible: false }),
      makeLayer('outside', { name: 'Outside' }),
    ];

    // Paint non-overlapping & overlapping squares on children
    paintRect(grid, 'child-bottom', 10, 10, 20, 20, 255, 0, 0, 255); // Red at (10..30, 10..30)
    paintRect(grid, 'child-top', 20, 10, 20, 20, 0, 0, 255, 255); // Blue at (20..40, 10..30)
    paintRect(grid, 'child-hidden', 50, 50, 10, 10, 0, 255, 0, 255); // Hidden green at (50..60, 50..60)
    paintRect(grid, 'outside', 80, 80, 10, 10, 255, 255, 0, 255); // Outside yellow

    act(() => {
      layerMgrApi!.setLayers(initialLayers);
      layerMgrApi!.setActiveLayerId('folder-1');
    });

    let mergeRes: ReturnType<ReturnType<typeof useLayerManager>['mergeFolder']> = null;
    act(() => {
      mergeRes = layerMgrApi!.mergeFolder('folder-1', 'merged-hero');
    });

    expect(mergeRes).toEqual({
      mergedLayerId: 'merged-hero',
      removedFolderId: 'folder-1',
      removedDescendantIds: ['child-top', 'sub-1', 'child-bottom', 'child-hidden'],
    });
    expect(layerMgrApi!.layers.map((l) => l.id)).toEqual(['merged-hero', 'outside']);
    expect(layerMgrApi!.activeLayerId).toBe('merged-hero');

    const mergedMeta = layerMgrApi!.layers[0];
    expect(mergedMeta.name).toBe('Hero');
    expect(mergedMeta.type).toBe('raster');
    expect(mergedMeta.opacity).toBe(0.75);
    expect(mergedMeta.blendMode).toBe('normal');

    // Verify composited pixels on merged-hero
    expect(grid.getPixelRGBA('merged-hero', 15, 15)).toEqual([255, 0, 0, 255]); // Red from child-bottom
    expect(grid.getPixelRGBA('merged-hero', 25, 15)).toEqual([0, 0, 255, 255]); // Blue over Red from child-top
    expect(grid.getPixelRGBA('merged-hero', 55, 55)).toEqual([0, 0, 0, 0]); // Hidden green excluded
    expect(grid.getPixelRGBA('outside', 85, 85)).toEqual([255, 255, 0, 255]); // Outside untouched
    expect(grid.hasLayerTiles('child-top')).toBe(false);
    expect(grid.hasLayerTiles('child-bottom')).toBe(false);
    expect(grid.hasLayerTiles('child-hidden')).toBe(false);

    // Undo Merge Folder -> restores folder, all descendants, and all pixels
    await act(async () => {
      await historyApi!.jumpToHistoryIndex(historyApi!.historyIndex - 1);
    });

    expect(layerMgrApi!.layers.map((l) => l.id)).toEqual(initialLayers.map((l) => l.id));
    expect(layerMgrApi!.activeLayerId).toBe('folder-1');
    expect(grid.hasLayerTiles('merged-hero')).toBe(false);
    expect(grid.getPixelRGBA('child-bottom', 15, 15)).toEqual([255, 0, 0, 255]);
    expect(grid.getPixelRGBA('child-top', 25, 15)).toEqual([0, 0, 255, 255]);
    expect(grid.getPixelRGBA('child-hidden', 55, 55)).toEqual([0, 255, 0, 255]);

    // Redo Merge Folder -> re-applies merged raster layer and its pixels
    await act(async () => {
      await historyApi!.jumpToHistoryIndex(historyApi!.historyIndex + 1);
    });

    expect(layerMgrApi!.layers.map((l) => l.id)).toEqual(['merged-hero', 'outside']);
    expect(layerMgrApi!.activeLayerId).toBe('merged-hero');
    expect(grid.getPixelRGBA('merged-hero', 15, 15)).toEqual([255, 0, 0, 255]);
    expect(grid.getPixelRGBA('merged-hero', 25, 15)).toEqual([0, 0, 255, 255]);
  });

  it('applies Transform to all layers inside a selected folder, supports Cancel, and commits atomically for Undo/Redo', async () => {
    const grid = new SparseTileGrid();
    const dims: CanvasDimensions = { width: 160, height: 160 };
    const toasts: string[] = [];

    const layers: LayerItem[] = [
      makeLayer('folder-art', { name: 'Art Folder', type: 'folder' }),
      makeLayer('layer-a', { name: 'Layer A', parentId: 'folder-art' }),
      makeLayer('sub-folder', { name: 'Nested', type: 'folder', parentId: 'folder-art' }),
      makeLayer('layer-b', { name: 'Layer B', parentId: 'sub-folder' }),
      makeLayer('layer-outside', { name: 'Outside' }),
    ];

    // Layer A: red square at (10..20, 10..20)
    // Layer B: blue square at (30..40, 30..40)
    // Outside: green square at (100..110, 100..110)
    paintRect(grid, 'layer-a', 10, 10, 10, 10, 255, 0, 0, 255);
    paintRect(grid, 'layer-b', 30, 30, 10, 10, 0, 0, 255, 255);
    paintRect(grid, 'layer-outside', 100, 100, 10, 10, 0, 255, 0, 255);

    let selApi: ReturnType<typeof useSelectionTools> | null = null;
    let historyApi: ReturnType<typeof useDrawingHistory> | null = null;
    const pushHistorySpy = vi.fn();

    function Harness() {
      const dimsRef = useRef(dims);
      const activeLayerIdRef = useRef('folder-art');
      const colorModeRef = useRef<'color' | 'grayscale' | 'monochrome'>('color');
      const layersRef = useRef<LayerItem[] | undefined>(layers);
      const updateMaskRef = useRef<((id: string) => void) | undefined>(undefined);
      const isDrawingRef = useRef(false);
      const lastStrokeEndRef = useRef(null);
      const abortRef = useRef(() => {});

      const history = useDrawingHistory({
        tileGrid: grid,
        activeLayerId: 'folder-art',
        activeLayerLocked: false,
        dimensions: dims,
        dimensionsRef: dimsRef,
        activeLayerIdRef,
        colorModeRef,
        layersRef,
        onUpdateLayerThumbnail: () => {},
        onUpdateMaskThumbnailRef: updateMaskRef,
        isDrawingRef,
        lastStrokeEndRef,
        abortActiveStrokeRef: abortRef,
      });

      const wrappedPush: typeof history.pushHistoryStep = (...args) => {
        pushHistorySpy(...args);
        history.pushHistoryStep(...args);
      };

      const selectionTools = useSelectionTools({
        dimensions: dims,
        colorMode: 'color',
        layers,
        activeLayer: layers[0], // folder-art is selected!
        activeLayerId: 'folder-art',
        selectedLayerIds: ['folder-art'],
        tileGrid: grid,
        updateLayerThumbnail: () => {},
        pushHistoryStep: wrappedPush,
        showToast: (m) => toasts.push(m),
      });

      selApi = selectionTools;
      historyApi = history;
      return null;
    }

    root = createRoot(container);
    act(() => {
      root!.render(<Harness />);
    });

    // 1. Start transform on selected folder
    act(() => {
      selApi!.handleStartTransform();
    });

    expect(selApi!.transformSession?.active).toBe(true);
    expect(selApi!.transformSession?.layerIds).toEqual(['layer-a', 'layer-b']);
    // Original pixels lifted/cleared from both child layers while outside layer stays intact
    expect(grid.getPixelRGBA('layer-a', 15, 15)).toEqual([0, 0, 0, 0]);
    expect(grid.getPixelRGBA('layer-b', 35, 35)).toEqual([0, 0, 0, 0]);
    expect(grid.getPixelRGBA('layer-outside', 105, 105)).toEqual([0, 255, 0, 255]);

    // 2. Cancel transform -> restores both child layers identically
    act(() => {
      selApi!.handleCancelTransform();
    });

    expect(selApi!.transformSession).toBeNull();
    expect(grid.getPixelRGBA('layer-a', 15, 15)).toEqual([255, 0, 0, 255]);
    expect(grid.getPixelRGBA('layer-b', 35, 35)).toEqual([0, 0, 255, 255]);
    expect(pushHistorySpy).not.toHaveBeenCalled();

    // 3. Start again, translate by (+20, +15), and Apply
    act(() => {
      selApi!.handleStartTransform();
    });
    expect(selApi!.transformSession?.active).toBe(true);

    act(() => {
      selApi!.setTransformSession((prev) =>
        prev ? { ...prev, x: prev.x + 20, y: prev.y + 15 } : null
      );
    });

    act(() => {
      selApi!.handleApplyTransform();
    });

    expect(selApi!.transformSession).toBeNull();
    // Both child layers translated by (+20, +15)
    expect(grid.getPixelRGBA('layer-a', 15, 15)).toEqual([0, 0, 0, 0]);
    expect(grid.getPixelRGBA('layer-a', 35, 30)).toEqual([255, 0, 0, 255]);
    expect(grid.getPixelRGBA('layer-b', 35, 35)).toEqual([0, 0, 0, 0]);
    expect(grid.getPixelRGBA('layer-b', 55, 50)).toEqual([0, 0, 255, 255]);
    // Outside layer completely untouched
    expect(grid.getPixelRGBA('layer-outside', 105, 105)).toEqual([0, 255, 0, 255]);
    // Recorded as ONE atomic history step
    expect(pushHistorySpy).toHaveBeenCalledTimes(1);

    // 4. Single Undo restores BOTH child layers simultaneously
    await act(async () => {
      await historyApi!.jumpToHistoryIndex(historyApi!.historyIndex - 1);
    });

    expect(grid.getPixelRGBA('layer-a', 15, 15)).toEqual([255, 0, 0, 255]);
    expect(grid.getPixelRGBA('layer-a', 35, 30)).toEqual([0, 0, 0, 0]);
    expect(grid.getPixelRGBA('layer-b', 35, 35)).toEqual([0, 0, 255, 255]);
    expect(grid.getPixelRGBA('layer-b', 55, 50)).toEqual([0, 0, 0, 0]);

    // 5. Single Redo re-applies transform to BOTH child layers simultaneously
    await act(async () => {
      await historyApi!.jumpToHistoryIndex(historyApi!.historyIndex + 1);
    });

    expect(grid.getPixelRGBA('layer-a', 35, 30)).toEqual([255, 0, 0, 255]);
    expect(grid.getPixelRGBA('layer-b', 55, 50)).toEqual([0, 0, 255, 255]);
    expect(toasts).toEqual([]);
  });

  it('transforms a folder containing a single child raster layer cleanly', () => {
    const grid = new SparseTileGrid();
    const dims: CanvasDimensions = { width: 128, height: 128 };

    const layers: LayerItem[] = [
      makeLayer('folder-single', { name: 'Single Folder', type: 'folder' }),
      makeLayer('only-child', { name: 'Only Child', parentId: 'folder-single' }),
    ];
    paintRect(grid, 'only-child', 10, 10, 12, 12, 200, 100, 50, 255);

    let selApi: ReturnType<typeof useSelectionTools> | null = null;
    const pushHistorySpy = vi.fn();

    function Harness() {
      selApi = useSelectionTools({
        dimensions: dims,
        colorMode: 'color',
        layers,
        activeLayer: layers[0],
        activeLayerId: 'folder-single',
        selectedLayerIds: ['folder-single'],
        tileGrid: grid,
        updateLayerThumbnail: () => {},
        pushHistoryStep: pushHistorySpy,
        showToast: () => {},
      });
      return null;
    }

    root = createRoot(container);
    act(() => {
      root!.render(<Harness />);
    });

    act(() => {
      selApi!.handleStartTransform();
    });
    expect(selApi!.transformSession?.active).toBe(true);
    expect(selApi!.transformSession?.layerId).toBe('only-child');

    act(() => {
      selApi!.setTransformSession((prev) =>
        prev ? { ...prev, x: prev.x + 15, y: prev.y + 10 } : null
      );
    });
    act(() => {
      selApi!.handleApplyTransform();
    });

    expect(grid.getPixelRGBA('only-child', 12, 12)).toEqual([0, 0, 0, 0]);
    expect(grid.getPixelRGBA('only-child', 30, 25)).toEqual([200, 100, 50, 255]);
    expect(pushHistorySpy).toHaveBeenCalledTimes(1);
  });

  it('transforms only the selected region across all layers in a folder when a selection is active', () => {
    const grid = new SparseTileGrid();
    const dims: CanvasDimensions = { width: 128, height: 128 };

    const layers: LayerItem[] = [
      makeLayer('folder-sel', { name: 'Folder Sel', type: 'folder' }),
      makeLayer('sel-a', { name: 'A', parentId: 'folder-sel' }),
      makeLayer('sel-b', { name: 'B', parentId: 'folder-sel' }),
    ];
    // Paint two 10x10 squares on each layer: one inside selection (10..20) and one outside (80..90)
    paintRect(grid, 'sel-a', 10, 10, 10, 10, 255, 0, 0, 255);
    paintRect(grid, 'sel-a', 80, 80, 10, 10, 255, 0, 0, 255);
    paintRect(grid, 'sel-b', 10, 10, 10, 10, 0, 0, 255, 255);
    paintRect(grid, 'sel-b', 80, 80, 10, 10, 0, 0, 255, 255);

    let selApi: ReturnType<typeof useSelectionTools> | null = null;
    const pushHistorySpy = vi.fn();

    function Harness() {
      selApi = useSelectionTools({
        dimensions: dims,
        colorMode: 'color',
        layers,
        activeLayer: layers[0],
        activeLayerId: 'folder-sel',
        selectedLayerIds: ['folder-sel'],
        tileGrid: grid,
        updateLayerThumbnail: () => {},
        pushHistoryStep: pushHistorySpy,
        showToast: () => {},
      });
      return null;
    }

    root = createRoot(container);
    act(() => {
      root!.render(<Harness />);
    });

    // Set a rectangular selection around (8..22, 8..22)
    act(() => {
      selApi!.setSelection({
        type: 'rect',
        bounds: { x: 8, y: 8, width: 14, height: 14 },
      });
    });

    act(() => {
      selApi!.handleStartTransform();
    });
    expect(selApi!.transformSession?.active).toBe(true);
    expect(selApi!.transformSession?.isSelection).toBe(true);
    expect(selApi!.transformSession?.layerIds).toEqual(['sel-a', 'sel-b']);

    // Pixels outside selection stay untouched; pixels inside selection are lifted
    expect(grid.getPixelRGBA('sel-a', 15, 15)).toEqual([0, 0, 0, 0]);
    expect(grid.getPixelRGBA('sel-b', 15, 15)).toEqual([0, 0, 0, 0]);
    expect(grid.getPixelRGBA('sel-a', 85, 85)).toEqual([255, 0, 0, 255]);
    expect(grid.getPixelRGBA('sel-b', 85, 85)).toEqual([0, 0, 255, 255]);

    // Move selection by (+30, +0) and apply
    act(() => {
      selApi!.setTransformSession((prev) => (prev ? { ...prev, x: prev.x + 30 } : null));
    });
    act(() => {
      selApi!.handleApplyTransform();
    });

    expect(grid.getPixelRGBA('sel-a', 45, 15)).toEqual([255, 0, 0, 255]);
    expect(grid.getPixelRGBA('sel-b', 45, 15)).toEqual([0, 0, 255, 255]);
    expect(grid.getPixelRGBA('sel-a', 85, 85)).toEqual([255, 0, 0, 255]);
    expect(grid.getPixelRGBA('sel-b', 85, 85)).toEqual([0, 0, 255, 255]);
    expect(pushHistorySpy).toHaveBeenCalledTimes(1);
  });
});
