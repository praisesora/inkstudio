import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ALL_DOCK_PANEL_IDS, DOCK_PANEL_META } from '../../types/workspace';
import {
  findPanelLocation,
  getPresetLayout,
} from '../workspacePresets';
import { useWorkspaceStore, workspaceStoreActions } from '../../stores/useWorkspaceStore';
import {
  SUB_VIEW_STORAGE_KEY,
  subViewStoreActions,
  useSubViewStore,
} from '../../stores/useSubViewStore';
import { useToolStore } from '../../stores/useToolStore';
import { SparseTileGrid } from '../tileEngine';
import { ViewportCompositor } from '../compositor';
import {
  NavigatorPanel,
  computePanForDocCenter,
  computeViewportQuadInDoc,
  isPointInConvexQuad,
  sliderPosToZoom,
  viewportPointToDoc,
  zoomToSliderPos,
} from '../../components/NavigatorPanel';
import {
  SubViewPanel,
  samplePixelHexFromCanvas,
  subViewPointToImagePixel,
} from '../../components/SubViewPanel';
import { CameraSubscriber, CameraTransformState, CanvasNavigationHandle } from '../../hooks/useCanvasNavigation';
import { CanvasDimensions, LayerItem } from '../../types/editor';

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

class MiniText {
  nodeType = 3;
  nodeName = '#text';
  parentNode: MiniEl | null = null;
  constructor(public nodeValue: string, public ownerDocument: MiniDoc) {}
}

class MiniComment {
  nodeType = 8;
  nodeName = '#comment';
  parentNode: MiniEl | null = null;
  constructor(public nodeValue: string, public ownerDocument: MiniDoc) {}
}

function createMock2DContext(pixelColor: [number, number, number, number] = [255, 64, 32, 255]) {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = pixelColor[0];
        data[i + 1] = pixelColor[1];
        data[i + 2] = pixelColor[2];
        data[i + 3] = pixelColor[3];
      }
      return { data, width: w, height: h };
    }),
    imageSmoothingEnabled: true,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  };
}

class MiniEl extends EventTarget {
  nodeType = 1;
  nodeName: string;
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  parentNode: MiniEl | null = null;
  childNodes: Array<MiniEl | MiniText | MiniComment> = [];
  style: Record<string, string> = {};
  className = '';
  disabled = false;
  value = '';
  width = 200;
  height = 120;
  clientWidth = 200;
  clientHeight = 120;
  attrs = new Map<string, string>();
  private mockCtx: ReturnType<typeof createMock2DContext> | null = null;

  constructor(tag: string, public ownerDocument: MiniDoc) {
    super();
    this.nodeName = tag.toUpperCase();
    this.tagName = tag.toUpperCase();
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get textContent(): string {
    return this.childNodes
      .map((c) => (c instanceof MiniText ? c.nodeValue : c instanceof MiniEl ? c.textContent : ''))
      .join('');
  }

  set textContent(val: string) {
    this.childNodes = val ? [new MiniText(val, this.ownerDocument)] : [];
  }

  getBoundingClientRect() {
    return {
      left: 0,
      top: 0,
      width: this.clientWidth,
      height: this.clientHeight,
      right: this.clientWidth,
      bottom: this.clientHeight,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  }

  setPointerCapture() {}
  releasePointerCapture() {}

  override dispatchEvent(event: Event): boolean {
    if (!event.target) {
      Object.defineProperty(event, 'target', { value: this, configurable: true });
    }
    let cur: MiniEl | null = this;
    while (cur) {
      EventTarget.prototype.dispatchEvent.call(cur, event);
      if (!event.bubbles) break;
      cur = cur.parentNode;
    }
    return !event.defaultPrevented;
  }

  getContext(type: string) {
    if (type === '2d') {
      if (!this.mockCtx) this.mockCtx = createMock2DContext(this.ownerDocument.mockSampleColor);
      return this.mockCtx;
    }
    return null;
  }

  appendChild<T extends MiniEl | MiniText | MiniComment>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends MiniEl | MiniText | MiniComment>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  insertBefore<T extends MiniEl | MiniText | MiniComment>(
    node: T,
    ref: MiniEl | MiniText | MiniComment | null
  ): T {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    if (idx >= 0) this.childNodes.splice(idx, 0, node);
    else this.childNodes.push(node);
    return node;
  }

  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }

  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }

  removeAttribute(k: string) {
    this.attrs.delete(k);
  }

  contains(target: unknown): boolean {
    if (target === this) return true;
    for (const c of this.childNodes) {
      if (c === target) return true;
      if (c instanceof MiniEl && c.contains(target)) return true;
    }
    return false;
  }

  findByAttr(attr: string, value: string): MiniEl | null {
    if (this.getAttribute(attr) === value) return this;
    for (const c of this.childNodes) {
      if (c instanceof MiniEl) {
        const found = c.findByAttr(attr, value);
        if (found) return found;
      }
    }
    return null;
  }
}

interface MiniDoc {
  nodeType: number;
  nodeName: string;
  documentElement: MiniEl;
  body: MiniEl;
  activeElement: MiniEl;
  defaultView: Record<string, unknown>;
  mockSampleColor: [number, number, number, number];
  createElement: (tag: string) => MiniEl;
  createElementNS: (_ns: string, tag: string) => MiniEl;
  createTextNode: (text: string) => MiniText;
  createComment: (text: string) => MiniComment;
  addEventListener: EventTarget['addEventListener'];
  removeEventListener: EventTarget['removeEventListener'];
  dispatchEvent: EventTarget['dispatchEvent'];
}

function installMiniDom(sampleColor: [number, number, number, number] = [52, 168, 83, 255]) {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {
    window: g.window,
    document: g.document,
    HTMLElement: g.HTMLElement,
    Node: g.Node,
    Element: g.Element,
    Image: g.Image,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const winTarget = new EventTarget();
  const docTarget = new EventTarget();

  const mockDoc: MiniDoc = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: null as unknown as MiniEl,
    body: null as unknown as MiniEl,
    activeElement: null as unknown as MiniEl,
    defaultView: null as unknown as Record<string, unknown>,
    mockSampleColor: sampleColor,
    createElement: (tag: string) => new MiniEl(tag, mockDoc),
    createElementNS: (_ns: string, tag: string) => new MiniEl(tag, mockDoc),
    createTextNode: (text: string) => new MiniText(text, mockDoc),
    createComment: (text: string) => new MiniComment(text, mockDoc),
    addEventListener: docTarget.addEventListener.bind(docTarget),
    removeEventListener: docTarget.removeEventListener.bind(docTarget),
    dispatchEvent: docTarget.dispatchEvent.bind(docTarget),
  };

  mockDoc.documentElement = new MiniEl('html', mockDoc);
  mockDoc.body = new MiniEl('body', mockDoc);
  mockDoc.documentElement.appendChild(mockDoc.body);
  mockDoc.activeElement = mockDoc.body;

  class MockImage {
    naturalWidth = 100;
    naturalHeight = 100;
    width = 100;
    height = 100;
    crossOrigin = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private _src = '';
    get src() {
      return this._src;
    }
    set src(val: string) {
      this._src = val;
      if (val && this.onload) {
        this.onload();
      }
    }
  }

  class MockIFrame extends MiniEl {}

  const rafMock = (cb: FrameRequestCallback) => {
    cb(16);
    return 1;
  };
  const cancelRafMock = () => {};

  const mockWin: Record<string, unknown> = {
    innerWidth: 1440,
    innerHeight: 900,
    devicePixelRatio: 1,
    document: mockDoc,
    Node: MiniEl,
    Element: MiniEl,
    HTMLElement: MiniEl,
    SVGElement: MiniEl,
    HTMLIFrameElement: MockIFrame,
    Event,
    CustomEvent,
    addEventListener: winTarget.addEventListener.bind(winTarget),
    removeEventListener: winTarget.removeEventListener.bind(winTarget),
    dispatchEvent: winTarget.dispatchEvent.bind(winTarget),
    requestAnimationFrame: rafMock,
    cancelAnimationFrame: cancelRafMock,
  };
  mockDoc.defaultView = mockWin;

  g.window = mockWin;
  g.document = mockDoc;
  g.HTMLElement = MiniEl;
  g.Node = MiniEl;
  g.Element = MiniEl;
  g.Image = MockImage;
  g.requestAnimationFrame = rafMock;
  g.cancelAnimationFrame = cancelRafMock;

  const container = new MiniEl('div', mockDoc);
  mockDoc.body.appendChild(container);

  return {
    container,
    mockDoc,
    cleanup: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    },
  };
}

function createMockNavigation(initial?: Partial<CameraTransformState>) {
  const subs = new Set<CameraSubscriber>();
  const state: CameraTransformState = {
    pan: initial?.pan ?? { x: 400, y: 300 },
    zoom: initial?.zoom ?? 1,
    rotation: initial?.rotation ?? 0,
    flipX: initial?.flipX ?? false,
    flipY: initial?.flipY ?? false,
  };

  const panRef = { current: { ...state.pan } };
  const zoomRef = { current: state.zoom };
  const rotationRef = { current: state.rotation };
  const flipXRef = { current: state.flipX };
  const flipYRef = { current: state.flipY };

  const emit = () => {
    const cam: CameraTransformState = {
      pan: { ...panRef.current },
      zoom: zoomRef.current,
      rotation: rotationRef.current,
      flipX: flipXRef.current,
      flipY: flipYRef.current,
    };
    subs.forEach((fn) => fn(cam));
  };

  const setPanLive = vi.fn((next: { x: number; y: number }, _commit?: boolean) => {
    panRef.current = { ...next };
    emit();
  });
  const setZoomLive = vi.fn((z: number, _commit?: boolean) => {
    zoomRef.current = z;
    emit();
  });
  const rotateBy = vi.fn((delta: number) => {
    rotationRef.current += delta;
    emit();
  });
  const commitCameraState = vi.fn();

  const handle: CanvasNavigationHandle = {
    panRef,
    zoomRef,
    rotationRef,
    flipXRef,
    flipYRef,
    getCameraState: () => ({
      pan: { ...panRef.current },
      zoom: zoomRef.current,
      rotation: rotationRef.current,
      flipX: flipXRef.current,
      flipY: flipYRef.current,
    }),
    subscribeCamera: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    setPanLive,
    setZoomLive,
    rotateBy,
    commitCameraState,
  };

  return { handle, setPanLive, setZoomLive, rotateBy, commitCameraState, emit };
}

describe('Navigator & Sub View Dock Integration and Presets', () => {
  const prevStorage = (globalThis as unknown as Record<string, unknown>).localStorage;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
    useWorkspaceStore.reset();
    useSubViewStore.reset();
  });

  afterEach(() => {
    if (prevStorage === undefined) {
      delete (globalThis as unknown as Record<string, unknown>).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: prevStorage,
        configurable: true,
        writable: true,
      });
    }
  });

  it('registers navigator and sub-view in dock metadata and all three workspace presets', () => {
    expect(ALL_DOCK_PANEL_IDS).toContain('navigator');
    expect(ALL_DOCK_PANEL_IDS).toContain('sub-view');
    expect(DOCK_PANEL_META.navigator.title).toBe('Navigator');
    expect(DOCK_PANEL_META['sub-view'].title).toBe('Sub View');

    for (const preset of ['default-illustration', 'manga-studio', 'minimalist-tablet'] as const) {
      const layout = getPresetLayout(preset);
      expect(findPanelLocation(layout, 'navigator')).not.toBeNull();
      expect(findPanelLocation(layout, 'sub-view')).not.toBeNull();
    }
  });

  it('supports docking, moving, hiding, and persisting navigator and sub-view across reload', () => {
    workspaceStoreActions.movePanel('navigator', { side: 'left' });
    workspaceStoreActions.movePanel('sub-view', { side: 'left' });
    expect(findPanelLocation(useWorkspaceStore.getState().layout, 'navigator')?.side).toBe('left');
    expect(findPanelLocation(useWorkspaceStore.getState().layout, 'sub-view')?.side).toBe('left');

    useWorkspaceStore.reset();
    expect(findPanelLocation(useWorkspaceStore.getState().layout, 'navigator')?.side).toBe('left');
    expect(findPanelLocation(useWorkspaceStore.getState().layout, 'sub-view')?.side).toBe('left');
  });
});

describe('NavigatorPanel Geometry, Throttled Preview & Smooth Pan', () => {
  const dims: CanvasDimensions = { width: 1000, height: 800, dpi: 300 };

  it('computes exact viewport quad and inverse pan under rotation, flipX, and flipY', () => {
    const cases: CameraTransformState[] = [
      { pan: { x: 400, y: 300 }, zoom: 1, rotation: 0, flipX: false, flipY: false },
      { pan: { x: 250, y: 180 }, zoom: 2.5, rotation: 37, flipX: false, flipY: false },
      { pan: { x: 520, y: 310 }, zoom: 1.5, rotation: -45, flipX: true, flipY: false },
      { pan: { x: 310, y: 420 }, zoom: 0.75, rotation: 120, flipX: true, flipY: true },
    ];

    for (const cam of cases) {
      const quad = computeViewportQuadInDoc(800, 600, cam, dims);
      const centerDoc = viewportPointToDoc(400, 300, cam, dims);
      expect(isPointInConvexQuad(centerDoc, quad)).toBe(true);

      // Inverse pan: asking to center on targetDoc=(200, 150) must map (400, 300) back to (200, 150)
      const targetDoc = { x: 200, y: 150 };
      const nextPan = computePanForDocCenter(targetDoc, 800, 600, cam, dims);
      const verify = viewportPointToDoc(400, 300, { ...cam, pan: nextPan }, dims);
      expect(verify.x).toBeCloseTo(targetDoc.x, 4);
      expect(verify.y).toBeCloseTo(targetDoc.y, 4);
    }

    // Zoom slider roundtrip
    expect(sliderPosToZoom(zoomToSliderPos(1.0))).toBeCloseTo(1.0, 2);
    expect(sliderPosToZoom(zoomToSliderPos(4.0))).toBeCloseTo(4.0, 1);
  });

  it('throttles low-LOD preview composites (~200ms) and pans main canvas via setPanLive on drag', () => {
    vi.useFakeTimers();
    const dom = installMiniDom();
    let root: Root | null = null;
    const renderPreviewSpy = vi
      .spyOn(ViewportCompositor, 'renderLowResPreview')
      .mockImplementation(() => {});

    try {
      const grid = new SparseTileGrid();
      const nav = createMockNavigation({ pan: { x: 400, y: 300 }, zoom: 2, rotation: 0 });
      const viewportEl = { clientWidth: 800, clientHeight: 600 } as HTMLDivElement;
      const viewportRef = { current: viewportEl };
      const layers: LayerItem[] = [
        {
          id: 'layer-1',
          name: 'Ink',
          type: 'raster',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          locked: false,
          alphaLocked: false,
          clipped: false,
          parentId: null,
        },
      ];

      const onFit = vi.fn();
      const onZoom100 = vi.fn();
      const onFlipH = vi.fn();
      const onFlipV = vi.fn();

      act(() => {
        root = createRoot(dom.container as unknown as Element);
        root.render(
          <NavigatorPanel
            viewportRef={viewportRef}
            navigation={nav.handle}
            dimensions={dims}
            layers={layers}
            tileGrid={grid}
            showCheckerboard={false}
            zoom={2}
            rotation={0}
            flipX={false}
            flipY={false}
            onZoomIn={vi.fn()}
            onZoomOut={vi.fn()}
            onFitToScreen={onFit}
            onZoomActualSize={onZoom100}
            onRotateLeft={vi.fn()}
            onRotateRight={vi.fn()}
            onResetRotation={vi.fn()}
            onToggleFlipHorizontal={onFlipH}
            onToggleFlipVertical={onFlipV}
            throttleMs={200}
          />
        );
      });

      // Initial render happened once
      expect(renderPreviewSpy).toHaveBeenCalledTimes(1);

      // Burst 15 rapid tile updates during fast strokes -> must be coalesced by 200ms throttle
      act(() => {
        for (let i = 0; i < 15; i++) {
          grid.notifyChange(false);
        }
      });
      expect(renderPreviewSpy).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(220);
      });
      expect(renderPreviewSpy).toHaveBeenCalledTimes(2);

      // Drag on Navigator stage to pan main canvas smoothly via setPanLive
      const stage = dom.container.findByAttr('data-testid', 'navigator-preview-stage');
      expect(stage).not.toBeNull();

      act(() => {
        stage!.dispatchEvent(
          Object.assign(new Event('pointerdown', { bubbles: true }), {
            button: 0,
            pointerId: 1,
            clientX: 30,
            clientY: 30,
          })
        );
        stage!.dispatchEvent(
          Object.assign(new Event('pointermove', { bubbles: true }), {
            button: 0,
            pointerId: 1,
            clientX: 140,
            clientY: 85,
          })
        );
        stage!.dispatchEvent(
          Object.assign(new Event('pointerup', { bubbles: true }), {
            button: 0,
            pointerId: 1,
            clientX: 140,
            clientY: 85,
          })
        );
      });

      expect(nav.setPanLive).toHaveBeenCalled();
      expect(nav.commitCameraState).toHaveBeenCalledTimes(1);

      // Verify compact control bar buttons
      const fitBtn = dom.container.findByAttr('data-testid', 'nav-fit-screen');
      const z100Btn = dom.container.findByAttr('data-testid', 'nav-zoom-100');
      const flipHBtn = dom.container.findByAttr('data-testid', 'nav-flip-h');
      const flipVBtn = dom.container.findByAttr('data-testid', 'nav-flip-v');
      act(() => {
        fitBtn!.dispatchEvent(new Event('click', { bubbles: true }));
        z100Btn!.dispatchEvent(new Event('click', { bubbles: true }));
        flipHBtn!.dispatchEvent(new Event('click', { bubbles: true }));
        flipVBtn!.dispatchEvent(new Event('click', { bubbles: true }));
      });
      expect(onFit).toHaveBeenCalledTimes(1);
      expect(onZoom100).toHaveBeenCalledTimes(1);
      expect(onFlipH).toHaveBeenCalledTimes(1);
      expect(onFlipV).toHaveBeenCalledTimes(1);
    } finally {
      renderPreviewSpy.mockRestore();
      if (root) {
        act(() => {
          root?.unmount();
        });
      }
      dom.cleanup();
      vi.useRealTimers();
    }
  });
});

describe('SubViewPanel Reference Management, Transforms & CORS-Safe Eyedropper', () => {
  const prevStorage = (globalThis as unknown as Record<string, unknown>).localStorage;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
    useSubViewStore.reset();
    useToolStore.reset();
  });

  afterEach(() => {
    if (prevStorage === undefined) {
      delete (globalThis as unknown as Record<string, unknown>).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: prevStorage,
        configurable: true,
        writable: true,
      });
    }
  });

  it('inverse-maps Sub View pointer coordinates accurately under pan, zoom, rotation, and flipX', () => {
    // Center of stage (100, 70) maps to center pixel (50, 50) of a 100x100 image
    expect(
      subViewPointToImagePixel(100, 70, 200, 140, 100, 100, {
        zoom: 1,
        pan: { x: 0, y: 0 },
        rotation: 0,
        flipX: false,
      })
    ).toEqual({ x: 50, y: 50 });

    // With flipX=true, +10px right of center maps to -10px in image X (40, 50)
    expect(
      subViewPointToImagePixel(110, 70, 200, 140, 100, 100, {
        zoom: 1,
        pan: { x: 0, y: 0 },
        rotation: 0,
        flipX: true,
      })
    ).toEqual({ x: 40, y: 50 });

    // Outside bounds returns null
    expect(
      subViewPointToImagePixel(0, 0, 200, 140, 20, 20, {
        zoom: 1,
        pan: { x: 0, y: 0 },
        rotation: 0,
        flipX: false,
      })
    ).toBeNull();
  });

  it('samples hex color cleanly and catches CORS SecurityError without throwing', () => {
    const okCanvas = {
      width: 10,
      height: 10,
      getContext: () => ({
        getImageData: () => ({ data: new Uint8ClampedArray([18, 52, 86, 255]) }),
      }),
    } as unknown as HTMLCanvasElement;
    expect(samplePixelHexFromCanvas(okCanvas, 2, 2)).toBe('#123456');

    const transparentCanvas = {
      width: 10,
      height: 10,
      getContext: () => ({
        getImageData: () => ({ data: new Uint8ClampedArray([255, 0, 0, 0]) }),
      }),
    } as unknown as HTMLCanvasElement;
    expect(samplePixelHexFromCanvas(transparentCanvas, 2, 2)).toBeNull();

    const taintedCanvas = {
      width: 10,
      height: 10,
      getContext: () => ({
        getImageData: () => {
          throw new Error('SecurityError: tainted canvas');
        },
      }),
    } as unknown as HTMLCanvasElement;
    expect(samplePixelHexFromCanvas(taintedCanvas, 2, 2)).toBeNull();
  });

  it('loads multiple references, persists session metadata, transforms independently, and sets primaryColor on eyedropper click', () => {
    const dom = installMiniDom([52, 168, 83, 255]); // #34a853
    let root: Root | null = null;

    try {
      subViewStoreActions.addImages([
        { id: 'ref-1', name: 'character_sheet.png', src: 'data:image/png;base64,AAA', width: 100, height: 100 },
        { id: 'ref-2', name: 'palette_study.png', src: 'data:image/png;base64,BBB', width: 100, height: 100 },
      ]);

      expect(useSubViewStore.getState().items.length).toBe(2);
      expect(useSubViewStore.getState().activeId).toBe('ref-2');

      act(() => {
        root = createRoot(dom.container as unknown as Element);
        root.render(<SubViewPanel colorMode="color" themePreset="modern" />);
      });

      expect(dom.container.findByAttr('data-testid', 'subview-counter')?.textContent).toBe('2/2');

      // Navigate to previous reference (<)
      act(() => {
        dom.container
          .findByAttr('data-testid', 'subview-prev-btn')!
          .dispatchEvent(new Event('click', { bubbles: true }));
      });
      expect(useSubViewStore.getState().activeId).toBe('ref-1');
      expect(dom.container.findByAttr('data-testid', 'subview-counter')?.textContent).toBe('1/2');

      // Independent transform controls: rotate + flipH
      act(() => {
        dom.container
          .findByAttr('data-testid', 'subview-rotate-right')!
          .dispatchEvent(new Event('click', { bubbles: true }));
        dom.container
          .findByAttr('data-testid', 'subview-flip-h')!
          .dispatchEvent(new Event('click', { bubbles: true }));
      });
      const activeAfterTransform = useSubViewStore.getState().items.find((i) => i.id === 'ref-1')!;
      expect(activeAfterTransform.rotation).toBe(15);
      expect(activeAfterTransform.flipX).toBe(true);

      // Clicking reference image in Auto Eyedropper mode immediately updates active brush primaryColor
      expect(useToolStore.getState().primaryColor).toBe('#000000');
      const stage = dom.container.findByAttr('data-testid', 'subview-stage');
      expect(stage).not.toBeNull();
      act(() => {
        stage!.dispatchEvent(
          Object.assign(new Event('pointerdown', { bubbles: true }), {
            button: 0,
            pointerId: 1,
            clientX: 100,
            clientY: 60,
          })
        );
      });
      expect(useToolStore.getState().primaryColor).toBe('#34a853');
      expect(useToolStore.getState().brushSettings.color).toBe('#34a853');

      // Persist across reload
      expect(localStorage.getItem(SUB_VIEW_STORAGE_KEY)).toBeTruthy();
      act(() => {
        useSubViewStore.reset();
      });
      expect(useSubViewStore.getState().items.length).toBe(2);
      expect(useSubViewStore.getState().activeId).toBe('ref-1');
      expect(useSubViewStore.getState().items[0].flipX).toBe(true);
      expect(useSubViewStore.getState().items[0].rotation).toBe(15);
    } finally {
      if (root) {
        act(() => {
          root?.unmount();
        });
      }
      dom.cleanup();
    }
  });
});
