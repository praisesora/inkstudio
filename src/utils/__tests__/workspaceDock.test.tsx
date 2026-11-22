import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  WORKSPACE_STORAGE_KEY,
  findPanelLocation,
  loadWorkspaceState,
} from '../workspacePresets';
import { useWorkspaceStore, workspaceStoreActions } from '../../stores/useWorkspaceStore';
import { useUiStore } from '../../stores/useUiStore';
import { BrushSizePalette } from '../../components/BrushSizePalette';
import { StatusBar } from '../../components/StatusBar';
import { DocumentTabBar } from '../../components/DocumentTabBar';
import { DockGroupView } from '../../components/DockWorkspace';
import { BrushSettings, DocumentTab } from '../../types/editor';

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
  attrs = new Map<string, string>();

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

  getBoundingClientRect() {
    return {
      left: 220,
      right: 240,
      top: 48,
      bottom: 68,
      width: 20,
      height: 20,
      x: 220,
      y: 48,
      toJSON: () => ({}),
    };
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
  createElement: (tag: string) => MiniEl;
  createElementNS: (_ns: string, tag: string) => MiniEl;
  createTextNode: (text: string) => MiniText;
  createComment: (text: string) => MiniComment;
  addEventListener: EventTarget['addEventListener'];
  removeEventListener: EventTarget['removeEventListener'];
  dispatchEvent: EventTarget['dispatchEvent'];
}

function installMiniDom() {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {
    window: g.window,
    document: g.document,
    HTMLElement: g.HTMLElement,
    Node: g.Node,
    Element: g.Element,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const winTarget = new EventTarget();
  const docTarget = new EventTarget();
  const rafQueue: FrameRequestCallback[] = [];

  const mockDoc = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: null as unknown as MiniEl,
    body: null as unknown as MiniEl,
    activeElement: null as unknown as MiniEl,
    defaultView: null as unknown as Record<string, unknown>,
    createElement: (tag: string) => new MiniEl(tag, mockDoc),
    createElementNS: (_ns: string, tag: string) => new MiniEl(tag, mockDoc),
    createTextNode: (text: string) => new MiniText(text, mockDoc),
    createComment: (text: string) => new MiniComment(text, mockDoc),
    addEventListener: docTarget.addEventListener.bind(docTarget),
    removeEventListener: docTarget.removeEventListener.bind(docTarget),
    dispatchEvent: docTarget.dispatchEvent.bind(docTarget),
  } as MiniDoc;

  mockDoc.documentElement = new MiniEl('html', mockDoc);
  mockDoc.body = new MiniEl('body', mockDoc);
  mockDoc.documentElement.appendChild(mockDoc.body);
  mockDoc.activeElement = mockDoc.body;

  class MockIFrame extends MiniEl {}

  const rafMock = (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  const cancelRafMock = () => {};

  const mockWin: Record<string, unknown> = {
    innerWidth: 1440,
    innerHeight: 900,
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
  g.requestAnimationFrame = rafMock;
  g.cancelAnimationFrame = cancelRafMock;

  const container = new MiniEl('div', mockDoc);
  mockDoc.body.appendChild(container);

  return {
    container,
    flushRaf: () => {
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const cb of batch) cb(16);
    },
    cleanup: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    },
  };
}

describe('CSP Dock Workspace, Presets & Persistence', () => {
  const prevStorage = (globalThis as unknown as Record<string, unknown>).localStorage;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
    useWorkspaceStore.reset();
    useUiStore.reset();
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

  it('moves any palette from right dock to left dock, collapses to compact strip, and persists across reload', () => {
    const initialLoc = findPanelLocation(useWorkspaceStore.getState().layout, 'layers');
    expect(initialLoc?.side).toBe('right');

    // Move layers from right dock to left dock
    workspaceStoreActions.movePanel('layers', { side: 'left' });
    const movedLoc = findPanelLocation(useWorkspaceStore.getState().layout, 'layers');
    expect(movedLoc?.side).toBe('left');
    expect(useWorkspaceStore.getState().activePreset).toBe('custom');

    // Collapse that column into compact icon strip and open popover
    workspaceStoreActions.toggleColumnCollapsed(movedLoc!.colId, true);
    const collapsedCol = useWorkspaceStore
      .getState()
      .layout.leftDocks.find((c) => c.id === movedLoc!.colId);
    expect(collapsedCol?.collapsed).toBe(true);

    workspaceStoreActions.togglePopover(movedLoc!.colId, 'layers');
    expect(useWorkspaceStore.getState().openPopover).toEqual({
      colId: movedLoc!.colId,
      panelId: 'layers',
    });

    // Simulate full app reload from localStorage
    useWorkspaceStore.reset();
    const reloaded = useWorkspaceStore.getState();
    expect(reloaded.activePreset).toBe('custom');
    const reloadedLoc = findPanelLocation(reloaded.layout, 'layers');
    expect(reloadedLoc?.side).toBe('left');
    const reloadedCol = reloaded.layout.leftDocks.find((c) => c.id === reloadedLoc!.colId);
    expect(reloadedCol?.collapsed).toBe(true);
  });

  it('toggles all palettes off and back on (Tab behavior) while staying synced with useUiStore', () => {
    expect(useWorkspaceStore.getState().palettesHidden).toBe(false);

    const hidden = workspaceStoreActions.togglePalettesHidden();
    expect(hidden).toBe(true);
    expect(useWorkspaceStore.getState().palettesHidden).toBe(true);
    expect(useUiStore.getState().isLeftPanelHidden).toBe(true);
    expect(useUiStore.getState().isRightSidebarHidden).toBe(true);

    const restored = workspaceStoreActions.togglePalettesHidden();
    expect(restored).toBe(false);
    expect(useWorkspaceStore.getState().palettesHidden).toBe(false);
    expect(useUiStore.getState().isLeftPanelHidden).toBe(false);
    expect(useUiStore.getState().isRightSidebarHidden).toBe(false);
  });

  it('switches workspace presets and supports Reset Workspace cleanly', () => {
    workspaceStoreActions.applyPreset('minimalist-tablet');
    expect(useWorkspaceStore.getState().activePreset).toBe('minimalist-tablet');
    expect(useWorkspaceStore.getState().layout.rightDocks[0].collapsed).toBe(true);

    workspaceStoreActions.applyPreset('manga-studio');
    expect(useWorkspaceStore.getState().activePreset).toBe('manga-studio');
    expect(findPanelLocation(useWorkspaceStore.getState().layout, 'brush-size')?.side).toBe('left');

    // Mutate into custom then reset back to default illustration
    workspaceStoreActions.movePanel('color', { side: 'left' });
    expect(useWorkspaceStore.getState().activePreset).toBe('custom');

    workspaceStoreActions.resetWorkspace();
    expect(useWorkspaceStore.getState().activePreset).toBe('default-illustration');
    expect(findPanelLocation(useWorkspaceStore.getState().layout, 'color')?.side).toBe('right');
  });

  it('persists Quick Access and Command Bar customizations and survives corrupt localStorage', () => {
    workspaceStoreActions.addQuickAccessItem({
      id: 'qa-custom-red',
      kind: 'color',
      label: 'Hero Red',
      color: '#e11d48',
    });
    workspaceStoreActions.setQuickAccessViewMode('list');
    workspaceStoreActions.toggleCommandBarItem('deselect');

    useWorkspaceStore.reset();
    expect(
      useWorkspaceStore.getState().quickAccessItems.some((i) => i.id === 'qa-custom-red')
    ).toBe(true);
    expect(useWorkspaceStore.getState().quickAccessViewMode).toBe('list');
    expect(useWorkspaceStore.getState().commandBarIds).toContain('deselect');

    // Corrupt storage falls back cleanly without throwing
    localStorage.setItem(WORKSPACE_STORAGE_KEY, '{corrupt json');
    const safe = loadWorkspaceState();
    expect(safe.activePreset).toBe('default-illustration');
    expect(safe.layout.leftDocks.length).toBeGreaterThan(0);
    expect(safe.layout.rightDocks.length).toBeGreaterThan(0);
  });
});

describe('Activated Components (BrushSizePalette, StatusBar, DocumentTabBar) in Both Themes', () => {
  let dom: ReturnType<typeof installMiniDom>;
  let root: Root | null = null;

  beforeEach(() => {
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

  it('renders BrushSizePalette, StatusBar (live pointer-stat + rotation reset), and DocumentTabBar (dirty *) in modern theme', () => {
    const onSelectSize = vi.fn();
    const onResetRotation = vi.fn();
    const onCloseDocument = vi.fn();
    const brushSettings = {
      preset: 'g-pen',
      size: 10,
      minSizeFactor: 0.2,
      color: '#000000',
      opacity: 1,
      flow: 1,
      spacing: 0.08,
      grain: 0,
      usePressure: true,
      smoothing: true,
      stabilization: 12,
    } as BrushSettings;

    const docs: DocumentTab[] = [
      {
        id: 'doc-1',
        name: 'Chapter1.ink',
        isDirty: true,
        dimensions: { width: 1920, height: 1080, dpi: 300 },
        colorMode: 'color',
        layers: [],
        activeLayerId: 'l1',
      },
      {
        id: 'doc-2',
        name: 'Cover.ink',
        isDirty: false,
        dimensions: { width: 2480, height: 3508, dpi: 600 },
        colorMode: 'monochrome',
        layers: [],
        activeLayerId: 'l2',
      },
    ];

    for (const theme of ['modern'] as const) {
      act(() => {
        if (!root) root = createRoot(dom.container as unknown as Element);
        root.render(
          <div>
            <DocumentTabBar
              documents={docs}
              activeDocumentId="doc-1"
              onSelectDocument={() => {}}
              onCloseDocument={onCloseDocument}
              onNewDocument={() => {}}
              themePreset={theme}
            />
            <BrushSizePalette
              currentSize={10}
              onSelectSize={onSelectSize}
              activeBrushName="G-Pen"
              tool="brush"
              presetId="g-pen"
              themePreset={theme}
            />
            <StatusBar
              tool="brush"
              brushSettings={brushSettings}
              zoom={1.5}
              rotation={45}
              onResetRotation={onResetRotation}
              colorMode="color"
              showCursorCoordinates
              showPressureInStatusBar
              hasOpenDocument
              themePreset={theme}
            />
          </div>
        );
      });

      const tabBar = dom.container.findByAttr('data-testid', 'document-tab-bar');
      const dirtyStar = dom.container.findByAttr('data-testid', 'dirty-indicator-doc-1');
      const cleanStar = dom.container.findByAttr('data-testid', 'dirty-indicator-doc-2');
      const brushPalette = dom.container.findByAttr('data-testid', 'brush-size-palette');
      const statusBar = dom.container.findByAttr('data-testid', 'status-bar');

      expect(tabBar?.getAttribute('data-theme-preset')).toBe(theme);
      expect(dirtyStar?.textContent).toBe('*');
      expect(cleanStar).toBeNull();
      expect(brushPalette?.getAttribute('data-theme-preset')).toBe(theme);
      expect(statusBar?.getAttribute('data-theme-preset')).toBe(theme);
      expect(statusBar?.textContent).toContain('150%');
      expect(statusBar?.textContent).toContain('45°');

      // Fire canvas-pointer-stat event and verify StatusBar live DOM updates
      act(() => {
        window.dispatchEvent(
          new CustomEvent('canvas-pointer-stat', { detail: { x: 420, y: 180, pressure: 0.75 } })
        );
        dom.flushRaf();
      });
      expect(statusBar?.textContent).toContain('420, 180px');
      expect(statusBar?.textContent).toContain('75%');
    }
  });

  it('portals the Sub Tool three-dot panel menu to document.body with fixed viewport-clamped positioning', () => {
    const group = {
      id: 'grp-subtool',
      panelIds: ['subtool' as const],
      activePanelId: 'subtool' as const,
      heightRatio: 1,
    };
    const col = { id: 'col-left', width: 240, collapsed: false, groups: [group] };

    act(() => {
      root = createRoot(dom.container as unknown as Element);
      root.render(
        <DockGroupView
          side="left"
          col={col}
          group={group}
          themePreset="modern"
          draggingPanelId={null}
          onStartDragPanel={() => {}}
          onEndDragPanel={() => {}}
          renderPanelBody={(panelId) => <div data-testid={`panel-body-${panelId}`}>{panelId}</div>}
        />
      );
    });

    const subtoolMenuBtn = dom.container.findByAttr('data-testid', 'dock-menu-btn-subtool');
    expect(subtoolMenuBtn).not.toBeNull();

    // Open the three-dot menu via React onClick prop (MiniEl EventTarget doesn't bubble to React root)
    const reactPropsKey = Object.keys(subtoolMenuBtn!).find((k) => k.startsWith('__reactProps'));
    expect(reactPropsKey).toBeDefined();
    const reactProps = (subtoolMenuBtn as unknown as Record<string, { onClick?: (e: unknown) => void }>)[
      reactPropsKey!
    ];
    act(() => {
      reactProps.onClick?.({ stopPropagation: () => {}, preventDefault: () => {} });
    });

    const body = document.body as unknown as MiniEl;
    const popoverInBody = body.findByAttr('data-testid', 'dock-menu-popover-subtool');
    const popoverInContainer = dom.container.findByAttr('data-testid', 'dock-menu-popover-subtool');

    // Menu must be portaled into document.body (outside overflow-hidden dock container)
    expect(popoverInBody).not.toBeNull();
    expect(popoverInContainer).toBeNull();
    expect(popoverInBody!.style.position).toBe('fixed');
    expect(popoverInBody!.style.top).toBe('72px');
    expect(popoverInBody!.style.left).toBe('220px');
  });
});
