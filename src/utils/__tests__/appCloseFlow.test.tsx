import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentTab } from '../../types/editor';
import {
  documentStoreActions,
  selectIsAnyModalOpen,
  uiStoreActions,
  useDocumentStore,
  useUiStore,
} from '../../stores';
import {
  _resetAppCloseFlowForTests,
  cancelAppClose,
  computeInitialClosePromptState,
  finalizeAppClose,
  findNextPendingDirtyIndex,
  formatCanvasDisplayName,
  getUnsavedDocumentIds,
  isFinalizingAppClose,
  requestAppClose,
  SaveDocumentResult,
} from '../appCloseFlow';
import { CloseConfirmModal } from '../../components/CloseConfirmModal';

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
  public disabled = false;
  public className = '';
  public isContentEditable = false;
  private attrs = new Map<string, string>();

  constructor(tag: string, ownerDocument: MiniDocument) {
    super();
    this.nodeName = tag.toUpperCase();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }

  get textContent(): string {
    return this.childNodes
      .map((n) => (n instanceof MiniTextNode ? n.nodeValue : n instanceof MiniElement ? n.textContent : ''))
      .join('');
  }

  set textContent(val: string) {
    this.childNodes = val ? [new MiniTextNode(val, this.ownerDocument)] : [];
  }

  appendChild<T extends MiniNode>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
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
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    newNode.parentNode = this;
    if (!refNode) {
      this.childNodes.push(newNode);
      return newNode;
    }
    const idx = this.childNodes.indexOf(refNode);
    if (idx < 0) this.childNodes.push(newNode);
    else this.childNodes.splice(idx, 0, newNode);
    return newNode;
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
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  focus() {}
  blur() {}
}

class MiniDocument extends EventTarget {
  public nodeType = 9;
  public nodeName = '#document';
  public defaultView: any;
  public body: MiniElement;
  public documentElement: MiniElement;
  public activeElement: MiniElement | null = null;

  constructor(win: any) {
    super();
    this.defaultView = win;
    this.documentElement = new MiniElement('html', this);
    this.body = new MiniElement('body', this);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string) {
    return new MiniElement(tag, this);
  }
  createElementNS(_ns: string, tag: string) {
    return new MiniElement(tag, this);
  }
  createTextNode(text: string) {
    return new MiniTextNode(text, this);
  }
  createComment(text: string) {
    return new MiniCommentNode(text, this);
  }
}

function findButtons(root: MiniElement): MiniElement[] {
  const out: MiniElement[] = [];
  const walk = (node: MiniNode) => {
    if (node instanceof MiniElement) {
      if (node.tagName === 'BUTTON') out.push(node);
      for (const child of node.childNodes) walk(child);
    }
  };
  walk(root);
  return out;
}

function clickButtonByText(root: MiniElement, label: string): void {
  const btn = findButtons(root).find((b) => b.textContent.trim() === label);
  if (!btn) {
    const labels = findButtons(root).map((b) => b.textContent.trim());
    throw new Error(`Button "${label}" not found. Available: ${labels.join(', ')}`);
  }
  const ev = new Event('click', { bubbles: true, cancelable: true });
  // Bubble manually up the MiniElement parent chain so React 19 root listener receives it
  Object.defineProperty(ev, 'target', { value: btn, enumerable: true });
  let cur: any = btn;
  while (cur) {
    cur.dispatchEvent(ev);
    cur = cur.parentNode;
  }
}

function makeDoc(id: string, name: string, isDirty: boolean): DocumentTab {
  return {
    id,
    name,
    isDirty,
    dimensions: { width: 800, height: 600, dpi: 300 },
    colorMode: 'color',
    layers: [],
    activeLayerId: '',
  };
}

describe('App Close Confirmation & Multi-Canvas Save Flow', () => {
  let prevWindow: any;
  let prevDocument: any;
  let prevActEnv: any;
  let miniWin: EventTarget & Record<string, any>;
  let miniDoc: MiniDocument;
  let container: MiniElement;
  let root: Root | null = null;

  beforeEach(() => {
    prevWindow = (globalThis as any).window;
    prevDocument = (globalThis as any).document;
    prevActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;

    miniWin = Object.assign(new EventTarget(), {
      close: vi.fn(),
      HTMLElement: MiniElement,
      HTMLIFrameElement: class HTMLIFrameElement {},
      Element: MiniElement,
      Node: MiniElement,
    });
    miniDoc = new MiniDocument(miniWin);
    miniWin.document = miniDoc;
    (globalThis as any).window = miniWin;
    (globalThis as any).document = miniDoc;
    (globalThis as any).HTMLElement = MiniElement;
    (globalThis as any).HTMLIFrameElement = miniWin.HTMLIFrameElement;
    (globalThis as any).Element = MiniElement;
    (globalThis as any).Node = MiniElement;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

    container = miniDoc.createElement('div');
    miniDoc.body.appendChild(container);

    _resetAppCloseFlowForTests();
    useDocumentStore.reset();
    useUiStore.reset();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    _resetAppCloseFlowForTests();
    useDocumentStore.reset();
    useUiStore.reset();
    (globalThis as any).window = prevWindow;
    (globalThis as any).document = prevDocument;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
  });

  it('computes initial prompt step for 0, 1, and multiple unsaved canvases', () => {
    expect(computeInitialClosePromptState([])).toEqual({
      isOpen: true,
      step: 'confirm-quit',
      pendingDocIds: [],
      currentIndex: 0,
      isBusy: false,
    });

    expect(computeInitialClosePromptState(['doc-1'])).toEqual({
      isOpen: true,
      step: 'per-canvas',
      pendingDocIds: ['doc-1'],
      currentIndex: 0,
      isBusy: false,
    });

    expect(computeInitialClosePromptState(['doc-1', 'doc-2'])).toEqual({
      isOpen: true,
      step: 'summary',
      pendingDocIds: ['doc-1', 'doc-2'],
      currentIndex: 0,
      isBusy: false,
    });

    expect(formatCanvasDisplayName('Untitled*')).toBe('Untitled');
    expect(formatCanvasDisplayName('Comic 20261122')).toBe('Comic 20261122');
    expect(formatCanvasDisplayName('***')).toBe('Untitled');
  });

  it('extracts dirty IDs, finds next pending dirty index, and prevents duplicate close prompts', () => {
    const docs = [
      makeDoc('a', 'Clean', false),
      makeDoc('b', 'Dirty 1', true),
      makeDoc('c', 'Dirty 2', true),
    ];
    documentStoreActions.setDocuments(docs);

    expect(getUnsavedDocumentIds(docs)).toEqual(['b', 'c']);
    expect(findNextPendingDirtyIndex(['b', 'c'], 0, docs)).toBe(1);
    expect(findNextPendingDirtyIndex(['b', 'c'], 1, docs)).toBe(-1);

    expect(requestAppClose()).toBe(true);
    expect(useUiStore.getState().appClosePrompt.step).toBe('summary');
    expect(selectIsAnyModalOpen(useUiStore.getState())).toBe(true);

    // Duplicate close request while modal is open is ignored
    expect(requestAppClose()).toBe(false);

    expect(cancelAppClose()).toBe(true);
    expect(useUiStore.getState().appClosePrompt.isOpen).toBe(false);
  });

  it('asks for quit confirmation even with 0 unsaved canvases and closes only when confirmed', async () => {
    documentStoreActions.setDocuments([makeDoc('clean-1', 'Saved.ink', false)]);
    const onSaveDocumentById = vi.fn(async (): Promise<SaveDocumentResult> => 'saved');
    const onFinalizeClose = vi.fn(async () => {
      uiStoreActions.resetAppClosePrompt();
    });

    await act(async () => {
      root = createRoot(container as unknown as Element);
      root.render(
        <CloseConfirmModal
          onSaveDocumentById={onSaveDocumentById}
          onFinalizeClose={onFinalizeClose}
        />
      );
      requestAppClose();
    });

    expect(container.textContent).toContain('Are you sure you want to close Ink Studio?');

    await act(async () => {
      clickButtonByText(container, 'Cancel');
    });
    expect(onFinalizeClose).not.toHaveBeenCalled();
    expect(useUiStore.getState().appClosePrompt.isOpen).toBe(false);

    await act(async () => {
      requestAppClose();
    });
    await act(async () => {
      clickButtonByText(container, 'Close');
    });
    expect(onFinalizeClose).toHaveBeenCalledTimes(1);
    expect(onSaveDocumentById).not.toHaveBeenCalled();
  });

  it('prompts directly for 1 unsaved canvas and keeps modal open if OS Save picker is canceled', async () => {
    documentStoreActions.setDocuments([makeDoc('d1', 'Comic 20261122*', true)]);
    const saveResults: SaveDocumentResult[] = ['canceled', 'saved'];
    const onSaveDocumentById = vi.fn(async (id: string): Promise<SaveDocumentResult> => {
      const next = saveResults.shift() ?? 'saved';
      if (next === 'saved') {
        documentStoreActions.markDocumentDirty(id, false);
      }
      return next;
    });
    const onFinalizeClose = vi.fn(async () => {
      uiStoreActions.resetAppClosePrompt();
    });

    await act(async () => {
      root = createRoot(container as unknown as Element);
      root.render(
        <CloseConfirmModal
          onSaveDocumentById={onSaveDocumentById}
          onFinalizeClose={onFinalizeClose}
        />
      );
      requestAppClose();
    });

    expect(container.textContent).toContain('Comic 20261122 has been changed. Do you want to save it?');

    // First Save click -> user cancels file picker -> must NOT close
    await act(async () => {
      clickButtonByText(container, 'Save');
    });
    expect(onSaveDocumentById).toHaveBeenCalledTimes(1);
    expect(onSaveDocumentById).toHaveBeenCalledWith('d1');
    expect(onFinalizeClose).not.toHaveBeenCalled();
    expect(useUiStore.getState().appClosePrompt.isOpen).toBe(true);
    expect(useUiStore.getState().appClosePrompt.isBusy).toBe(false);

    // Second Save click -> succeeds -> finalizes close
    await act(async () => {
      clickButtonByText(container, 'Save');
    });
    expect(onSaveDocumentById).toHaveBeenCalledTimes(2);
    expect(onFinalizeClose).toHaveBeenCalledTimes(1);
  });

  it('handles multiple unsaved canvases: summary -> Confirm changes -> per-canvas Save / Do Not Save -> close', async () => {
    documentStoreActions.setDocuments([
      makeDoc('d1', 'Page 01*', true),
      makeDoc('d-clean', 'Cover.ink', false),
      makeDoc('d2', 'Page 02*', true),
    ]);

    const onSaveDocumentById = vi.fn(async (id: string): Promise<SaveDocumentResult> => {
      documentStoreActions.markDocumentDirty(id, false);
      return 'saved';
    });
    const onFinalizeClose = vi.fn(async () => {
      uiStoreActions.resetAppClosePrompt();
    });

    await act(async () => {
      root = createRoot(container as unknown as Element);
      root.render(
        <CloseConfirmModal
          onSaveDocumentById={onSaveDocumentById}
          onFinalizeClose={onFinalizeClose}
        />
      );
      requestAppClose();
    });

    // Step 1: Summary prompt for 2 dirty canvases
    expect(container.textContent).toContain('There are 2 canvases with unsaved changes.');
    expect(container.textContent).toContain('Confirm changes...');
    expect(container.textContent).toContain('Discard changes');

    // Click "Confirm changes..." -> enters per-canvas prompt for Page 01 (1 / 2)
    await act(async () => {
      clickButtonByText(container, 'Confirm changes...');
    });
    expect(container.textContent).toContain('1 / 2');
    expect(container.textContent).toContain('Page 01 has been changed. Do you want to save it?');

    // Save Page 01 -> advances to Page 02 (2 / 2)
    await act(async () => {
      clickButtonByText(container, 'Save');
    });
    expect(onSaveDocumentById).toHaveBeenCalledWith('d1');
    expect(onFinalizeClose).not.toHaveBeenCalled();
    expect(container.textContent).toContain('2 / 2');
    expect(container.textContent).toContain('Page 02 has been changed. Do you want to save it?');

    // Skip saving Page 02 -> finalizes app close
    await act(async () => {
      clickButtonByText(container, 'Do Not Save');
    });
    expect(onSaveDocumentById).toHaveBeenCalledTimes(1);
    expect(onFinalizeClose).toHaveBeenCalledTimes(1);
  });

  it('closes immediately when user clicks Discard changes on multi-canvas summary', async () => {
    documentStoreActions.setDocuments([
      makeDoc('d1', 'Canvas A', true),
      makeDoc('d2', 'Canvas B', true),
    ]);
    const onSaveDocumentById = vi.fn(async (): Promise<SaveDocumentResult> => 'saved');
    const onFinalizeClose = vi.fn(async () => {
      uiStoreActions.resetAppClosePrompt();
    });

    await act(async () => {
      root = createRoot(container as unknown as Element);
      root.render(
        <CloseConfirmModal
          onSaveDocumentById={onSaveDocumentById}
          onFinalizeClose={onFinalizeClose}
        />
      );
      requestAppClose();
    });

    await act(async () => {
      clickButtonByText(container, 'Discard changes');
    });

    expect(onSaveDocumentById).not.toHaveBeenCalled();
    expect(onFinalizeClose).toHaveBeenCalledTimes(1);
  });

  it('finalizeAppClose flushes settings, closes all recovery sessions, and destroys Tauri window', async () => {
    documentStoreActions.setDocuments([
      makeDoc('doc-a', 'A', true),
      makeDoc('doc-b', 'B', false),
    ]);

    const flushBrushSettings = vi.fn();
    const closeRecoverySession = vi.fn(async () => {});
    const destroyTauriWindow = vi.fn(async () => {});

    await finalizeAppClose({
      isTauri: () => true,
      flushBrushSettings,
      closeRecoverySession,
      destroyTauriWindow,
    });

    expect(flushBrushSettings).toHaveBeenCalledTimes(1);
    expect(closeRecoverySession).toHaveBeenCalledTimes(2);
    expect(closeRecoverySession).toHaveBeenCalledWith('doc-a');
    expect(closeRecoverySession).toHaveBeenCalledWith('doc-b');
    expect(destroyTauriWindow).toHaveBeenCalledTimes(1);
    expect(isFinalizingAppClose()).toBe(true);
  });
});
