import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INITIAL_APP_DIALOG_STATE,
  INITIAL_FILTER_MODAL_STATE,
  selectIsAnyModalOpen,
  uiStoreActions,
  useUiStore,
} from '../../stores';
import { ConfirmDialogModal } from '../../components/ConfirmDialogModal';
import { FilterModal } from '../../components/FilterModal';

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
  public value = '';
  public checked = false;
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
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends MiniNode>(child: T, ref: MiniNode | null): T {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    const idx = this.childNodes.indexOf(ref);
    child.parentNode = this;
    if (idx === -1) {
      this.childNodes.push(child);
    } else {
      this.childNodes.splice(idx, 0, child);
    }
    return child;
  }

  removeChild<T extends MiniNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
    if (name === 'class') this.className = String(value);
    if (name === 'disabled') this.disabled = true;
    if (name === 'value') this.value = String(value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name === 'disabled') this.disabled = false;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }

  override dispatchEvent(event: Event): boolean {
    const path: EventTarget[] = [];
    let cur: MiniElement | null = this;
    while (cur) {
      path.push(cur);
      cur = cur.parentNode;
    }
    path.push(this.ownerDocument);
    if (this.ownerDocument.defaultView) {
      path.push(this.ownerDocument.defaultView);
    }

    Object.defineProperty(event, 'target', { value: this, configurable: true });
    for (const node of path) {
      Object.defineProperty(event, 'currentTarget', { value: node, configurable: true });
      EventTarget.prototype.dispatchEvent.call(node, event);
      if (event.cancelBubble) break;
    }
    return !event.defaultPrevented;
  }
}

class MiniDocument extends EventTarget {
  public nodeType = 9;
  public nodeName = '#document';
  public defaultView: EventTarget | null = null;
  public documentElement: MiniElement;
  public body: MiniElement;
  public activeElement: MiniElement | null = null;

  constructor() {
    super();
    this.documentElement = new MiniElement('html', this);
    this.body = new MiniElement('body', this);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string): MiniElement {
    return new MiniElement(tag, this);
  }

  createElementNS(_ns: string, tag: string): MiniElement {
    return new MiniElement(tag, this);
  }

  createTextNode(text: string): MiniTextNode {
    return new MiniTextNode(text, this);
  }

  createComment(text: string): MiniCommentNode {
    return new MiniCommentNode(text, this);
  }
}

function findElements(root: MiniElement, pred: (el: MiniElement) => boolean): MiniElement[] {
  const result: MiniElement[] = [];
  const walk = (el: MiniElement) => {
    if (pred(el)) result.push(el);
    for (const child of el.childNodes) {
      if (child instanceof MiniElement) walk(child);
    }
  };
  walk(root);
  return result;
}

function findButtonByText(root: MiniElement, label: string): MiniElement | undefined {
  return findElements(
    root,
    (el) => el.tagName === 'BUTTON' && el.textContent.trim() === label
  )[0];
}

function clickElement(el: MiniElement): void {
  const evt = new Event('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(evt);
}

describe('ConfirmDialogModal & FilterModal', () => {
  let doc: MiniDocument;
  let win: EventTarget;
  let container: MiniElement;
  let root: Root;

  const prevWindow = (globalThis as Record<string, unknown>).window;
  const prevDocument = (globalThis as Record<string, unknown>).document;
  const prevHTMLElement = (globalThis as Record<string, unknown>).HTMLElement;
  const prevHTMLIFrameElement = (globalThis as Record<string, unknown>).HTMLIFrameElement;
  const prevElement = (globalThis as Record<string, unknown>).Element;
  const prevNode = (globalThis as Record<string, unknown>).Node;
  const prevActEnv = (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const MockHTMLIFrameElement = class HTMLIFrameElement {};
    doc = new MiniDocument();
    win = Object.assign(new EventTarget(), {
      document: doc,
      HTMLElement: MiniElement,
      HTMLIFrameElement: MockHTMLIFrameElement,
      Element: MiniElement,
      Node: MiniElement,
    });
    doc.defaultView = win;
    container = doc.createElement('div');
    doc.body.appendChild(container);

    (globalThis as Record<string, unknown>).window = win;
    (globalThis as Record<string, unknown>).document = doc;
    (globalThis as Record<string, unknown>).HTMLElement = MiniElement;
    (globalThis as Record<string, unknown>).HTMLIFrameElement = MockHTMLIFrameElement;
    (globalThis as Record<string, unknown>).Element = MiniElement;
    (globalThis as Record<string, unknown>).Node = MiniElement;

    useUiStore.setState({
      appDialog: { ...INITIAL_APP_DIALOG_STATE },
      filterModalState: { ...INITIAL_FILTER_MODAL_STATE },
    });

    root = createRoot(container as unknown as Element);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    useUiStore.setState({
      appDialog: { ...INITIAL_APP_DIALOG_STATE },
      filterModalState: { ...INITIAL_FILTER_MODAL_STATE },
    });
    (globalThis as Record<string, unknown>).window = prevWindow;
    (globalThis as Record<string, unknown>).document = prevDocument;
    (globalThis as Record<string, unknown>).HTMLElement = prevHTMLElement;
    (globalThis as Record<string, unknown>).HTMLIFrameElement = prevHTMLIFrameElement;
    (globalThis as Record<string, unknown>).Element = prevElement;
    (globalThis as Record<string, unknown>).Node = prevNode;
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = prevActEnv;
  });

  it('renders brush delete confirmation with preview and resolves true on Delete click', async () => {
    act(() => {
      root.render(<ConfirmDialogModal />);
    });

    let confirmPromise!: Promise<boolean>;
    act(() => {
      confirmPromise = uiStoreActions.confirmDialog({
        variant: 'danger',
        title: 'Delete Brush',
        message: 'Are you sure you want to delete this brush?',
        detail: 'This permanently removes the brush from your library and cannot be undone.',
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        preview: {
          title: 'G-Pen Custom',
          subtitle: 'Imported custom brush',
        },
      });
    });

    expect(selectIsAnyModalOpen(useUiStore.getState())).toBe(true);
    expect(container.textContent).toContain('Delete Brush');
    expect(container.textContent).toContain('G-Pen Custom');
    expect(container.textContent).toContain('Imported custom brush');

    const deleteBtn = findButtonByText(container, 'Delete');
    expect(deleteBtn).toBeDefined();

    act(() => {
      clickElement(deleteBtn!);
    });

    const result = await confirmPromise;
    expect(result).toBe(true);
    expect(useUiStore.getState().appDialog.isOpen).toBe(false);
    expect(selectIsAnyModalOpen(useUiStore.getState())).toBe(false);
  });

  it('resolves false on Cancel click or Escape key', async () => {
    act(() => {
      root.render(<ConfirmDialogModal />);
    });

    let p1!: Promise<boolean>;
    act(() => {
      p1 = uiStoreActions.confirmDialog({
        variant: 'danger',
        title: 'Delete Brush',
        message: 'Delete this brush?',
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
      });
    });

    const cancelBtn = findButtonByText(container, 'Cancel');
    expect(cancelBtn).toBeDefined();
    act(() => {
      clickElement(cancelBtn!);
    });
    expect(await p1).toBe(false);

    let p2!: Promise<boolean>;
    act(() => {
      p2 = uiStoreActions.confirmDialog({
        variant: 'confirm',
        title: 'Confirm Action',
        message: 'Proceed?',
      });
    });

    act(() => {
      const esc = new Event('keydown', { cancelable: true }) as KeyboardEvent;
      Object.defineProperty(esc, 'key', { value: 'Escape' });
      win.dispatchEvent(esc);
    });
    expect(await p2).toBe(false);
  });

  it('renders alertDialog with a single OK button and cancels superseded dialogs', async () => {
    act(() => {
      root.render(<ConfirmDialogModal />);
    });

    let firstPromise!: Promise<boolean>;
    let alertPromise!: Promise<void>;
    act(() => {
      firstPromise = uiStoreActions.confirmDialog({
        title: 'First',
        message: 'First message',
      });
      alertPromise = uiStoreActions.alertDialog({
        title: 'Save Failed',
        message: 'Disk is full.',
      });
    });

    expect(await firstPromise).toBe(false);
    expect(container.textContent).toContain('Save Failed');
    expect(container.textContent).toContain('Disk is full.');
    expect(findButtonByText(container, 'Cancel')).toBeUndefined();

    const okBtn = findButtonByText(container, 'OK');
    expect(okBtn).toBeDefined();
    act(() => {
      clickElement(okBtn!);
    });
    await alertPromise;
    expect(useUiStore.getState().appDialog.isOpen).toBe(false);
  });

  it('opens FilterModal, marks modal open in store, and applies default Gaussian Blur params', () => {
    const onApply = vi.fn();
    const onClose = vi.fn(() => uiStoreActions.closeFilterModal());

    act(() => {
      uiStoreActions.openFilterModal('gaussian-blur');
      root.render(
        <FilterModal
          isOpen={useUiStore.getState().filterModalState.isOpen}
          type={useUiStore.getState().filterModalState.type}
          onClose={onClose}
          onApply={onApply}
        />
      );
    });

    expect(selectIsAnyModalOpen(useUiStore.getState())).toBe(true);
    expect(container.textContent).toContain('Gaussian Blur');

    const applyBtn = findButtonByText(container, 'Apply');
    expect(applyBtn).toBeDefined();
    act(() => {
      clickElement(applyBtn!);
    });

    expect(onApply).toHaveBeenCalledWith('gaussian-blur', { radius: 5 });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(selectIsAnyModalOpen(useUiStore.getState())).toBe(false);
  });
});
