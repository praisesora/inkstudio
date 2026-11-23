import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useDocumentLifecycle,
  UseDocumentLifecycleParams,
} from '../../components/DocumentLifecycleManager';
import {
  documentStoreActions,
  uiStoreActions,
  useDocumentStore,
  useUiStore,
} from '../../stores';
import { DocumentTab, LayerItem } from '../../types/editor';
import { RecentDocument } from '../recentDocumentsManager';
import { SparseTileGrid } from '../tileEngine';

const mockOpenFile = vi.fn();

vi.mock('../imageLoader', () => ({
  openFile: (...args: unknown[]) => mockOpenFile(...args),
}));

vi.mock('../recentDocumentsManager', () => ({
  saveRecentDocument: vi.fn().mockResolvedValue(undefined),
}));

// Minimal DOM shim matching the repo's node-environment React test setup
class MiniNode {
  public parentNode: MiniElement | null = null;
  constructor(
    public nodeType: number,
    public nodeName: string,
    public ownerDocument: MiniDocument
  ) {}
}

class MiniElement extends EventTarget {
  public nodeType = 1;
  public nodeName: string;
  public tagName: string;
  public namespaceURI = 'http://www.w3.org/1999/xhtml';
  public parentNode: MiniElement | null = null;
  public childNodes: Array<MiniElement | MiniNode> = [];
  public style: Record<string, string> = {};
  constructor(tag: string, public ownerDocument: MiniDocument) {
    super();
    this.nodeName = tag.toUpperCase();
    this.tagName = tag.toUpperCase();
  }
  appendChild<T extends MiniElement | MiniNode>(child: T): T {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild<T extends MiniElement | MiniNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
}

class MiniDocument extends EventTarget {
  public nodeType = 9;
  public defaultView: unknown = globalThis;
  public documentElement: MiniElement;
  public body: MiniElement;
  constructor() {
    super();
    this.documentElement = new MiniElement('html', this);
    this.body = new MiniElement('body', this);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag: string): MiniElement {
    return new MiniElement(tag, this);
  }
  createTextNode(): MiniNode {
    return new MiniNode(3, '#text', this);
  }
  createComment(): MiniNode {
    return new MiniNode(8, '#comment', this);
  }
}

describe('Home screen direct file opening', () => {
  let root: Root | null = null;
  let container: MiniElement | null = null;
  let hookApi: ReturnType<typeof useDocumentLifecycle> | null = null;

  const baseLayer: LayerItem = {
    id: 'layer-1',
    name: 'Layer 1',
    type: 'raster',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    locked: false,
    parentId: null,
  };

  const makeParams = (): UseDocumentLifecycleParams => ({
    layers: [baseLayer],
    activeLayer: baseLayer,
    activeLayerId: 'layer-1',
    getEffectiveOpacity: () => 1,
    isLayerEffectivelyVisible: () => true,
    setActiveLayerId: vi.fn(),
    resetToNewCanvas: vi.fn(() => ({ layers: [baseLayer], activeLayerId: 'layer-1' })),
    setDefaultToneFrequency: vi.fn(),
    clearDocument: vi.fn(),
    loadDocument: vi.fn(),
    switchDocumentSession: vi.fn(),
    resizeCanvas: vi.fn(),
    copyLayer: vi.fn(() => null),
    pasteLayer: vi.fn(async () => ({ success: false })),
    deleteLayer: vi.fn(),
    pasteLayerFromFile: vi.fn(async () => 'Pasted'),
    resetZoomAndCenter: vi.fn(),
    resetHistory: vi.fn(),
    pushHistoryStep: vi.fn(),
    showToast: vi.fn(),
  });

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const miniDoc = new MiniDocument();
    (globalThis as Record<string, unknown>).document = miniDoc;
    (globalThis as Record<string, unknown>).window = globalThis;
    (globalThis as Record<string, unknown>).HTMLElement = MiniElement;
    (globalThis as Record<string, unknown>).HTMLIFrameElement = class HTMLIFrameElement {};
    (globalThis as Record<string, unknown>).Element = MiniElement;
    (globalThis as Record<string, unknown>).Node = MiniNode;
    container = miniDoc.createElement('div');
    miniDoc.body.appendChild(container);
    root = createRoot(container as unknown as HTMLElement);

    documentStoreActions.setDocuments([]);
    documentStoreActions.setActiveDocumentId(null);
    documentStoreActions.setSavedFileInfo(null);
    uiStoreActions.setAppView('home');
    mockOpenFile.mockReset();
    hookApi = null;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container = null;
  });

  function mountLifecycle(params: UseDocumentLifecycleParams) {
    function Harness() {
      hookApi = useDocumentLifecycle(params);
      return null;
    }
    act(() => {
      root!.render(React.createElement(Harness));
    });
  }

  it('switches directly from home screen to workspace when opening a file via handleProcessFile', async () => {
    const params = makeParams();
    mountLifecycle(params);

    mockOpenFile.mockResolvedValue({
      name: 'sketch.ink',
      dimensions: { width: 1200, height: 800, dpi: 300 },
      colorMode: 'color',
      layers: [baseLayer],
      tileGrid: new SparseTileGrid(),
    });

    const file = new File([new Uint8Array([1, 2, 3])], 'sketch.ink');
    expect(useUiStore.getState().appView).toBe('home');

    await act(async () => {
      await hookApi!.handleProcessFile(file);
    });

    expect(useUiStore.getState().appView).toBe('workspace');
    expect(useDocumentStore.getState().documents).toHaveLength(1);
    expect(useDocumentStore.getState().activeDocumentId).toBe(
      useDocumentStore.getState().documents[0].id
    );
  });

  it('opens a recent document directly in workspace using its persisted FileSystemFileHandle', async () => {
    const params = makeParams();
    mountLifecycle(params);

    mockOpenFile.mockResolvedValue({
      name: 'chapter1.ink',
      dimensions: { width: 1600, height: 2400, dpi: 600 },
      colorMode: 'color',
      layers: [baseLayer],
      tileGrid: new SparseTileGrid(),
    });

    const file = new File([new Uint8Array([4, 5, 6])], 'chapter1.ink');
    const mockHandle = {
      name: 'chapter1.ink',
      queryPermission: vi.fn(async () => 'granted' as const),
      getFile: vi.fn(async () => file),
    };

    const recent: RecentDocument = {
      id: 'recent-doc-1',
      title: 'chapter1.ink',
      path: 'InkStudio\\chapter1.ink',
      size: 4096,
      lastOpened: Date.now(),
      isStarred: true,
      isSaved: true,
      fileType: '.ink',
      handle: mockHandle,
    };

    await act(async () => {
      await hookApi!.handleSelectWelcomeDocument(recent);
    });

    expect(mockHandle.getFile).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().appView).toBe('workspace');
    expect(useDocumentStore.getState().activeDocumentId).toBe('recent-doc-1');
    expect(useDocumentStore.getState().savedFileInfo?.handle).toBe(mockHandle);
  });

  it('focuses an already-open tab directly in workspace when clicked from home screen', async () => {
    const params = makeParams();
    const existingTab: DocumentTab = {
      id: 'open-doc-42',
      name: 'existing.ink',
      dimensions: { width: 1000, height: 1000, dpi: 300 },
      colorMode: 'color',
      layers: [baseLayer],
      activeLayerId: 'layer-1',
    };
    documentStoreActions.setDocuments([existingTab]);
    documentStoreActions.setActiveDocumentId('open-doc-42');
    uiStoreActions.setAppView('home');

    mountLifecycle(params);

    const recent: RecentDocument = {
      id: 'open-doc-42',
      title: 'existing.ink',
      path: 'InkStudio\\existing.ink',
      size: 2048,
      lastOpened: Date.now(),
      isStarred: false,
      isSaved: true,
    };

    await act(async () => {
      await hookApi!.handleSelectWelcomeDocument(recent);
    });

    expect(useUiStore.getState().appView).toBe('workspace');
    expect(useDocumentStore.getState().documents).toHaveLength(1);
    expect(mockOpenFile).not.toHaveBeenCalled();
  });
});
