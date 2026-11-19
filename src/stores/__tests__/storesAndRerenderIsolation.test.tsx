import React, { Profiler, act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createStore,
  shallowEqual,
  useToolStore,
  toolStoreActions,
  useDocumentStore,
  documentStoreActions,
  selectHasOpenDocument,
  useUiStore,
  uiStoreActions,
  selectIsAnyModalOpen,
} from '../index';
import { Header } from '../../components/Header';
import { RightSidebar, RightSidebarColorSection } from '../../components/RightSidebar';
import { ToolStrip } from '../../components/ToolStrip';
import { LayerItem, MenuSection } from '../../types/editor';

interface MiniNode {
  nodeType: number;
  nodeName: string;
  parentNode: MiniElement | null;
  ownerDocument: MiniDocument;
}

class MiniTextNode implements MiniNode {
  public nodeType = 3;
  public nodeName = '#text';
  public nodeValue: string;
  public parentNode: MiniElement | null = null;
  public ownerDocument: MiniDocument;

  constructor(text: string, ownerDocument: MiniDocument) {
    this.nodeValue = text;
    this.ownerDocument = ownerDocument;
  }
}

class MiniCommentNode implements MiniNode {
  public nodeType = 8;
  public nodeName = '#comment';
  public nodeValue: string;
  public parentNode: MiniElement | null = null;
  public ownerDocument: MiniDocument;

  constructor(text: string, ownerDocument: MiniDocument) {
    this.nodeValue = text;
    this.ownerDocument = ownerDocument;
  }
}

class MiniElement extends EventTarget implements MiniNode {
  public nodeType = 1;
  public nodeName: string;
  public tagName: string;
  public namespaceURI = 'http://www.w3.org/1999/xhtml';
  public ownerDocument: MiniDocument;
  public parentNode: MiniElement | null = null;
  public childNodes: MiniNode[] = [];
  public style: Record<string, string> = {};
  public isContentEditable = false;
  public clientWidth = 220;
  public clientHeight = 600;
  public width = 160;
  public height = 160;
  public value = '';
  public checked = false;
  public disabled = false;
  public className = '';
  public selected = false;
  public defaultSelected = false;
  private attrs = new Map<string, string>();

  get options(): MiniElement[] {
    const out: MiniElement[] = [];
    const walk = (nodes: MiniNode[]) => {
      for (const n of nodes) {
        if (n instanceof MiniElement) {
          if (n.tagName === 'OPTION') out.push(n);
          walk(n.childNodes);
        }
      }
    };
    walk(this.childNodes);
    return out;
  }

  constructor(tag: string, ownerDocument: MiniDocument) {
    super();
    this.nodeName = tag.toUpperCase();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }

  appendChild<T extends MiniNode>(child: T): T {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends MiniNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  insertBefore<T extends MiniNode>(newNode: T, refNode: MiniNode | null): T {
    if (newNode.parentNode) {
      newNode.parentNode.removeChild(newNode);
    }
    newNode.parentNode = this;
    const idx = refNode ? this.childNodes.indexOf(refNode) : -1;
    if (idx >= 0) {
      this.childNodes.splice(idx, 0, newNode);
    } else {
      this.childNodes.push(newNode);
    }
    return newNode;
  }

  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }

  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }

  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }

  contains(target: MiniNode | null): boolean {
    if (!target) return false;
    if (target === this) return true;
    for (const c of this.childNodes) {
      if (c === target) return true;
      if (c instanceof MiniElement && c.contains(target)) return true;
    }
    return false;
  }

  getBoundingClientRect(): DOMRect {
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
    } as DOMRect;
  }

  getContext(): Record<string, unknown> {
    const noop = () => {};
    return {
      clearRect: noop,
      fillRect: noop,
      strokeRect: noop,
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      arc: noop,
      fill: noop,
      stroke: noop,
      save: noop,
      restore: noop,
      scale: noop,
      translate: noop,
      rotate: noop,
      setTransform: noop,
      resetTransform: noop,
      drawImage: noop,
      putImageData: noop,
      createImageData: (w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      }),
      getImageData: (
        _x: number,
        _y: number,
        w: number,
        h: number
      ) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      }),
      createLinearGradient: () => ({ addColorStop: noop }),
      createRadialGradient: () => ({ addColorStop: noop }),
      createConicGradient: () => ({ addColorStop: noop }),
      clip: noop,
      rect: noop,
      quadraticCurveTo: noop,
      bezierCurveTo: noop,
      setLineDash: noop,
      fillText: noop,
      strokeText: noop,
      measureText: () => ({ width: 0 }),
    };
  }
}

interface MiniDocument {
  nodeType: number;
  nodeName: string;
  documentElement: MiniElement;
  body: MiniElement;
  activeElement: MiniElement;
  defaultView: Record<string, unknown>;
  createElement: (tag: string) => MiniElement;
  createElementNS: (_ns: string, tag: string) => MiniElement;
  createTextNode: (text: string) => MiniTextNode;
  createComment: (text: string) => MiniCommentNode;
  querySelector: () => null;
  addEventListener: EventTarget['addEventListener'];
  removeEventListener: EventTarget['removeEventListener'];
  dispatchEvent: EventTarget['dispatchEvent'];
}

function installMiniDom(): { container: MiniElement; cleanup: () => void } {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {
    window: g.window,
    document: g.document,
    HTMLElement: g.HTMLElement,
    Node: g.Node,
    Element: g.Element,
    ResizeObserver: g.ResizeObserver,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
  };

  g.IS_REACT_ACT_ENVIRONMENT = true;
  const winTarget = new EventTarget();
  const docTarget = new EventTarget();

  const mockDoc = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: null as unknown as MiniElement,
    body: null as unknown as MiniElement,
    activeElement: null as unknown as MiniElement,
    defaultView: null as unknown as Record<string, unknown>,
    createElement: (tag: string) => new MiniElement(tag, mockDoc),
    createElementNS: (_ns: string, tag: string) => new MiniElement(tag, mockDoc),
    createTextNode: (text: string) => new MiniTextNode(text, mockDoc),
    createComment: (text: string) => new MiniCommentNode(text, mockDoc),
    querySelector: () => null,
    addEventListener: docTarget.addEventListener.bind(docTarget),
    removeEventListener: docTarget.removeEventListener.bind(docTarget),
    dispatchEvent: docTarget.dispatchEvent.bind(docTarget),
  } as MiniDocument;

  mockDoc.documentElement = new MiniElement('html', mockDoc);
  mockDoc.body = new MiniElement('body', mockDoc);
  mockDoc.documentElement.appendChild(mockDoc.body);
  mockDoc.activeElement = mockDoc.body;

  class MockHTMLIFrameElement extends MiniElement {}
  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  let rafSeq = 1;
  const rafMock = (_cb: FrameRequestCallback) => rafSeq++;
  const cancelRafMock = (_id: number) => {};

  const mockWin: Record<string, unknown> = {
    innerWidth: 1600,
    innerHeight: 900,
    devicePixelRatio: 1,
    document: mockDoc,
    Node: MiniElement,
    Element: MiniElement,
    HTMLElement: MiniElement,
    SVGElement: MiniElement,
    HTMLIFrameElement: MockHTMLIFrameElement,
    Event,
    CustomEvent,
    addEventListener: winTarget.addEventListener.bind(winTarget),
    removeEventListener: winTarget.removeEventListener.bind(winTarget),
    dispatchEvent: winTarget.dispatchEvent.bind(winTarget),
    requestAnimationFrame: rafMock,
    cancelAnimationFrame: cancelRafMock,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  mockDoc.defaultView = mockWin;

  g.window = mockWin;
  g.document = mockDoc;
  g.HTMLElement = MiniElement;
  g.Node = MiniElement;
  g.Element = MiniElement;
  g.ResizeObserver = MockResizeObserver;
  g.requestAnimationFrame = rafMock;
  g.cancelAnimationFrame = cancelRafMock;

  const container = new MiniElement('div', mockDoc);
  mockDoc.body.appendChild(container);

  return {
    container,
    cleanup: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete g[k];
        } else {
          g[k] = v;
        }
      }
    },
  };
}

describe('External stores (useToolStore, useDocumentStore, useUiStore)', () => {
  beforeEach(() => {
    useToolStore.reset();
    useDocumentStore.reset();
    useUiStore.reset();
  });

  it('createStore notifies only when values actually change and shallowEqual compares objects', () => {
    const store = createStore(() => ({ count: 0, name: 'init' }));
    const spy = vi.fn();
    const unsub = store.subscribe(spy);

    store.setState({ count: 0 });
    expect(spy).toHaveBeenCalledTimes(0);

    store.setState({ count: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(store.getState().count).toBe(1);

    expect(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true);
    expect(shallowEqual({ a: 1, b: 'x' }, { a: 2, b: 'x' })).toBe(false);
    unsub();
  });

  it('useToolStore manages tool switching, brush updates, colors, and transparent ink', () => {
    expect(useToolStore.getState().tool).toBe('brush');

    toolStoreActions.updateBrushSettings({ size: 24, opacity: 0.75 });
    expect(useToolStore.getState().brushSettings.size).toBe(24);
    expect(useToolStore.getState().brushSettings.opacity).toBe(0.75);

    toolStoreActions.setPrimaryColor('#ff0055');
    expect(useToolStore.getState().primaryColor).toBe('#ff0055');
    expect(useToolStore.getState().brushSettings.color).toBe('#ff0055');
    expect(useToolStore.getState().recentColors[0]).toBe('#ff0055');

    toolStoreActions.swapColors();
    expect(useToolStore.getState().primaryColor).toBe('#ffffff');
    expect(useToolStore.getState().secondaryColor).toBe('#ff0055');

    const isTransparent = toolStoreActions.toggleTransparentColor();
    expect(isTransparent).toBe(true);
    expect(useToolStore.getState().isTransparentColor).toBe(true);
    expect(useToolStore.getState().brushSettings.isTransparentInk).toBe(true);

    // Switching to eraser and then picking a primary color returns to brush
    toolStoreActions.selectTool('eraser');
    expect(useToolStore.getState().tool).toBe('eraser');
    toolStoreActions.setPrimaryColor('#112233');
    expect(useToolStore.getState().tool).toBe('brush');
    expect(useToolStore.getState().isTransparentColor).toBe(false);

    // Monochrome mode enforcement
    documentStoreActions.setColorMode('monochrome');
    toolStoreActions.setPrimaryColor('#222222');
    expect(useToolStore.getState().primaryColor).toBe('#000000');

    // Quick modifiers
    toolStoreActions.setQuickModifiers({ isAltActive: true });
    expect(useToolStore.getState().quickModifiers.isAltActive).toBe(true);
  });

  it('useDocumentStore manages tabs, dimensions, active layer, and soft proof metadata', () => {
    expect(selectHasOpenDocument(useDocumentStore.getState())).toBe(false);

    documentStoreActions.setDocuments([
      {
        id: 'doc-1',
        name: 'Manga Page 1',
        dimensions: { width: 2480, height: 3508, dpi: 600 },
        colorMode: 'monochrome',
        layers: [],
        activeLayerId: 'layer-1',
      },
    ]);
    documentStoreActions.setActiveDocumentId('doc-1');
    documentStoreActions.setDimensions({ width: 2480, height: 3508, dpi: 600 });
    documentStoreActions.setActiveLayerId('layer-1');

    expect(selectHasOpenDocument(useDocumentStore.getState())).toBe(true);
    expect(useDocumentStore.getState().dimensions.dpi).toBe(600);
    expect(useDocumentStore.getState().activeLayerId).toBe('layer-1');

    documentStoreActions.toggleSoftProof();
    documentStoreActions.toggleGamutWarning();
    documentStoreActions.setProofStandard('japan-color-2001');
    expect(useDocumentStore.getState().softProofSettings).toMatchObject({
      enabled: true,
      gamutWarning: true,
      standard: 'japan-color-2001',
    });
  });

  it('useUiStore manages modals, panel visibility, and toast lifecycle', () => {
    expect(selectIsAnyModalOpen(useUiStore.getState())).toBe(false);

    uiStoreActions.setSettingsModalOpen(true);
    expect(selectIsAnyModalOpen(useUiStore.getState())).toBe(true);
    uiStoreActions.setSettingsModalOpen(false);
    expect(selectIsAnyModalOpen(useUiStore.getState())).toBe(false);

    uiStoreActions.toggleAllPanels();
    expect(useUiStore.getState().isLeftPanelHidden).toBe(true);
    expect(useUiStore.getState().isRightSidebarHidden).toBe(true);

    uiStoreActions.toggleAllPanels();
    expect(useUiStore.getState().isLeftPanelHidden).toBe(false);
    expect(useUiStore.getState().isRightSidebarHidden).toBe(false);

    uiStoreActions.showToast('Saved');
    expect(useUiStore.getState().toastMessage).toBe('Saved');
    uiStoreActions.clearToast();
    expect(useUiStore.getState().toastMessage).toBeNull();
  });
});

describe('Zero-rerender isolation on brush size and color changes', () => {
  let dom: { container: MiniElement; cleanup: () => void };
  let root: Root | null = null;

  beforeEach(() => {
    useToolStore.reset();
    useDocumentStore.reset();
    useUiStore.reset();
    dom = installMiniDom();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    dom.cleanup();
  });

  it('changing brush size or color triggers ZERO re-renders of Header (menu bar) or RightSidebar (layer list)', () => {
    const noop = () => {};
    const layers: LayerItem[] = [
      {
        id: 'layer-1',
        name: 'Ink Layer',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        collapsed: false,
        parentId: null,
      },
      {
        id: 'layer-bg',
        name: 'Paper',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        collapsed: false,
        parentId: null,
      },
    ];
    const menuSections: MenuSection[] = [
      { id: 'file', label: 'File', items: [{ id: 'f-new', label: 'New', onClick: noop }] },
      { id: 'edit', label: 'Edit', items: [{ id: 'e-undo', label: 'Undo', onClick: noop }] },
    ];

    let headerRenders = 0;
    let layerListRenders = 0;
    let colorPanelRenders = 0;
    let brushObserverRenders = 0;
    let lastObservedSize = 0;
    let lastObservedColor = '';

    const BrushSizeObserver: React.FC = () => {
      brushObserverRenders += 1;
      lastObservedSize = useToolStore((s) => s.brushSettings.size);
      lastObservedColor = useToolStore((s) => s.primaryColor);
      return React.createElement('span', null, `${lastObservedSize}:${lastObservedColor}`);
    };

    const TestShell: React.FC = () =>
      React.createElement(
        'div',
        null,
        React.createElement(
          Profiler,
          {
            id: 'Header',
            onRender: () => {
              headerRenders += 1;
            },
          },
          React.createElement(Header, {
            canUndo: true,
            canRedo: false,
            onUndo: noop,
            onRedo: noop,
            zoom: 1,
            onZoomIn: noop,
            onZoomOut: noop,
            onResetZoom: noop,
            rotation: 0,
            onResetRotation: noop,
            menuSections,
            hasOpenDocument: true,
          })
        ),
        React.createElement(ToolStrip, {}),
        React.createElement(BrushSizeObserver, {}),
        React.createElement(
          Profiler,
          {
            id: 'ColorPanelSection',
            onRender: () => {
              colorPanelRenders += 1;
            },
          },
          React.createElement(RightSidebarColorSection, {
            colorMode: 'color',
            containerWidth: 180,
          })
        ),
        React.createElement(
          Profiler,
          {
            id: 'RightSidebarLayerList',
            onRender: () => {
              layerListRenders += 1;
            },
          },
          React.createElement(RightSidebar, {
            hasOpenDocument: true,
            hideColorPanel: true,
            colorMode: 'color',
            historyList: [],
            historyIndex: -1,
            onJumpToHistory: noop,
            canUndo: false,
            canRedo: false,
            onUndo: noop,
            onRedo: noop,
            layers,
            activeLayerId: 'layer-1',
            selectedLayerIds: ['layer-1'],
            onSelectLayer: noop,
            onAddLayer: noop,
            onDuplicateLayer: noop,
            onDeleteLayer: noop,
            onToggleVisibility: noop,
            onSetOpacity: noop,
            onSetBlendMode: noop,
            onToggleLock: noop,
            onToggleCollapse: noop,
            onRenameLayer: noop,
            onMoveLayerToFolder: noop,
            width: 180,
          })
        )
      );

    act(() => {
      root = createRoot(dom.container as unknown as Element);
      root.render(React.createElement(TestShell));
    });

    expect(headerRenders).toBe(1);
    expect(layerListRenders).toBe(1);
    expect(colorPanelRenders).toBe(1);
    expect(brushObserverRenders).toBe(1);

    // Mutate brush size repeatedly -> neither Header, LayerList, nor ColorPanel should re-render
    act(() => {
      toolStoreActions.updateBrushSettings({ size: 12 });
      toolStoreActions.updateBrushSettings({ size: 48 });
      toolStoreActions.updateBrushSettings({ size: 96, opacity: 0.6 });
    });

    expect(headerRenders).toBe(1);
    expect(layerListRenders).toBe(1);
    expect(colorPanelRenders).toBe(1);

    // Mutate primary color, secondary color, swap colors, toggle transparent ink
    // -> ColorPanel updates, but Header (top menu bar) and LayerList still have ZERO re-renders
    act(() => {
      toolStoreActions.setPrimaryColor('#e11d48');
      toolStoreActions.setSecondaryColor('#2563eb');
      toolStoreActions.swapColors();
      toolStoreActions.toggleTransparentColor();
    });

    expect(lastObservedSize).toBe(96);
    expect(lastObservedColor).toBe('#2563eb');
    expect(brushObserverRenders).toBeGreaterThan(1);
    expect(colorPanelRenders).toBeGreaterThan(1);

    // Critical acceptance check: Header (top menu bar) and RightSidebar (layer list) had ZERO re-renders!
    expect(headerRenders).toBe(1);
    expect(layerListRenders).toBe(1);
  });
});
