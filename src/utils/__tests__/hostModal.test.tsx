import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostModal } from '../../components/HostModal';
import { SettingsModal } from '../../components/SettingsModal';
import { DEFAULT_APP_SETTINGS } from '../../types/settings';
import type { CollabPeer } from '../../types/multiplayer';

class TestTextNode {
  public nodeType = 3;
  public nodeName = '#text';
  public parentNode: TestElement | null = null;
  constructor(
    public nodeValue: string,
    public ownerDocument: TestDocument
  ) {}
}

class TestElement extends EventTarget {
  public nodeType = 1;
  public nodeName: string;
  public tagName: string;
  public namespaceURI = 'http://www.w3.org/1999/xhtml';
  public parentNode: TestElement | null = null;
  public childNodes: Array<TestElement | TestTextNode> = [];
  public style: Record<string, string> = {};
  public attributes = new Map<string, string>();
  public value = '';
  public disabled = false;
  public type = '';
  public placeholder = '';
  public className = '';

  constructor(
    tag: string,
    public ownerDocument: TestDocument
  ) {
    super();
    this.nodeName = tag.toUpperCase();
    this.tagName = this.nodeName;
  }

  appendChild<T extends TestElement | TestTextNode>(child: T): T {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends TestElement | TestTextNode>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    child.parentNode = null;
    return child;
  }

  insertBefore<T extends TestElement | TestTextNode>(child: T, ref: TestElement | TestTextNode | null): T {
    child.parentNode = this;
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    if (idx >= 0) this.childNodes.splice(idx, 0, child);
    else this.childNodes.push(child);
    return child;
  }

  setAttribute(name: string, val: string) {
    this.attributes.set(name, String(val));
    if (name === 'placeholder') this.placeholder = String(val);
    if (name === 'type') this.type = String(val);
    if (name === 'value') this.value = String(val);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? this.attributes.get(name)! : null;
  }

  get textContent(): string {
    return this.childNodes
      .map((c) => (c instanceof TestTextNode ? c.nodeValue : c.textContent))
      .join('');
  }

  set textContent(v: string) {
    this.childNodes = [];
    if (v) this.appendChild(new TestTextNode(v, this.ownerDocument));
  }

  override dispatchEvent(event: Event): boolean {
    const path: EventTarget[] = [];
    let cur: TestElement | null = this;
    while (cur) {
      path.push(cur);
      cur = cur.parentNode;
    }
    path.push(this.ownerDocument);
    if (this.ownerDocument.defaultView && this.ownerDocument.defaultView instanceof EventTarget) {
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

class TestDocument extends EventTarget {
  public nodeType = 9;
  public activeElement: TestElement | null = null;
  public defaultView: unknown = null;
  public documentElement: TestElement;
  public body: TestElement;

  constructor() {
    super();
    this.documentElement = new TestElement('html', this);
    this.body = new TestElement('body', this);
    this.documentElement.appendChild(this.body);
  }

  createElement(tag: string): TestElement {
    return new TestElement(tag, this);
  }

  createElementNS(_ns: string, tag: string): TestElement {
    return new TestElement(tag, this);
  }

  createTextNode(text: string): TestTextNode {
    return new TestTextNode(text, this);
  }

  createComment(): TestTextNode {
    return new TestTextNode('', this);
  }
}

function findAll(root: TestElement, pred: (el: TestElement) => boolean): TestElement[] {
  const out: TestElement[] = [];
  const walk = (node: TestElement | TestTextNode) => {
    if (node instanceof TestElement) {
      if (pred(node)) out.push(node);
      for (const child of node.childNodes) walk(child);
    }
  };
  walk(root);
  return out;
}

function findByTestId(root: TestElement, testId: string): TestElement | undefined {
  return findAll(root, (el) => el.getAttribute('data-testid') === testId)[0];
}

function clickElement(el: TestElement) {
  const ev = new Event('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
}

describe('HostModal WebRTC P2P default & hierarchy', () => {
  const origWindow = (globalThis as any).window;
  const origDocument = (globalThis as any).document;
  const origHTMLElement = (globalThis as any).HTMLElement;
  const origElement = (globalThis as any).Element;
  const origNode = (globalThis as any).Node;
  const origActEnv = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;

  let doc: TestDocument;
  let container: TestElement;
  let root: Root;

  const basePeer: CollabPeer = {
    id: 'peer-host-1',
    name: 'Sora',
    color: '#3b82f6',
    role: 'host',
  };

  beforeEach(() => {
    doc = new TestDocument();
    const win: any = new EventTarget();
    win.document = doc;
    doc.defaultView = win;
    class HTMLIFrameElementShim extends TestElement {}
    win.HTMLElement = TestElement;
    win.HTMLIFrameElement = HTMLIFrameElementShim;
    win.Element = TestElement;
    win.Node = TestElement;
    win.navigator = {};
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).window = win;
    (globalThis as any).document = doc;
    (globalThis as any).HTMLElement = TestElement;
    (globalThis as any).HTMLIFrameElement = HTMLIFrameElementShim;
    (globalThis as any).Element = TestElement;
    (globalThis as any).Node = TestElement;

    container = doc.createElement('div');
    doc.body.appendChild(container);
    root = createRoot(container as unknown as HTMLElement);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    (globalThis as any).window = origWindow;
    (globalThis as any).document = origDocument;
    (globalThis as any).HTMLElement = origHTMLElement;
    (globalThis as any).Element = origElement;
    (globalThis as any).Node = origNode;
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = origActEnv;
  });

  it('defaults to Worldwide P2P (Room Code) on open, orders cards P2P-first, and calls onStartWebRtcHosting', async () => {
    const onStartHosting = vi.fn().mockResolvedValue({});
    const onStartWebRtcHosting = vi.fn().mockResolvedValue({});

    await act(async () => {
      root.render(
        <HostModal
          isOpen={true}
          onClose={vi.fn()}
          isHost={false}
          isConnected={false}
          hostInfo={null}
          peers={[]}
          myPeer={basePeer}
          onUpdateMyName={vi.fn()}
          onStartHosting={onStartHosting}
          onStartWebRtcHosting={onStartWebRtcHosting}
          onStopHosting={vi.fn()}
          onJoinByInviteUrl={vi.fn().mockResolvedValue(true)}
          onLeaveRoom={vi.fn()}
          showToast={vi.fn()}
        />
      );
    });

    const p2pBtn = findByTestId(container, 'host-mode-p2p-btn');
    const tunnelBtn = findByTestId(container, 'host-mode-tunnel-btn');
    const lanBtn = findByTestId(container, 'host-mode-lan-btn');
    const startBtn = findByTestId(container, 'host-start-btn');

    expect(p2pBtn).toBeDefined();
    expect(tunnelBtn).toBeDefined();
    expect(lanBtn).toBeDefined();
    expect(startBtn).toBeDefined();

    // P2P is selected by default
    expect(p2pBtn!.getAttribute('aria-pressed')).toBe('true');
    expect(tunnelBtn!.getAttribute('aria-pressed')).toBe('false');
    expect(lanBtn!.getAttribute('aria-pressed')).toBe('false');

    // Hierarchy & labels
    expect(p2pBtn!.textContent).toContain('Worldwide P2P (Room Code)');
    expect(p2pBtn!.textContent).toContain('Recommended');
    expect(p2pBtn!.textContent).toContain(
      'Fast direct INK-XXXX code for PC & Android tablets · No setup'
    );
    expect(tunnelBtn!.textContent).toContain('Web Link (Cloudflare Tunnel)');
    expect(tunnelBtn!.textContent).toContain('Browser guests & up to 16 peers');
    expect(lanBtn!.textContent).toContain('Local Network (LAN)');
    expect(lanBtn!.textContent).toContain('Same Wi-Fi network');

    // Full text ordering: P2P card comes above Tunnel and LAN
    const fullText = container.textContent;
    expect(fullText.indexOf('Worldwide P2P (Room Code)')).toBeLessThan(
      fullText.indexOf('Web Link (Cloudflare Tunnel)')
    );
    expect(fullText.indexOf('Web Link (Cloudflare Tunnel)')).toBeLessThan(
      fullText.indexOf('Local Network (LAN)')
    );

    // Primary CTA for P2P
    expect(startBtn!.textContent).toContain('Start Room & Copy Code');

    // Clicking CTA triggers WebRTC P2P hosting, not Cloudflare Tunnel
    await act(async () => {
      clickElement(startBtn!);
    });
    expect(onStartWebRtcHosting).toHaveBeenCalledTimes(1);
    expect(onStartHosting).not.toHaveBeenCalled();
  });

  it('switches CTA when choosing Cloudflare Tunnel and resets back to P2P whenever re-opened', async () => {
    const props = {
      onClose: vi.fn(),
      isHost: false,
      isConnected: false,
      hostInfo: null,
      peers: [],
      myPeer: basePeer,
      onUpdateMyName: vi.fn(),
      onStartHosting: vi.fn().mockResolvedValue({}),
      onStartWebRtcHosting: vi.fn().mockResolvedValue({}),
      onStopHosting: vi.fn(),
      onJoinByInviteUrl: vi.fn().mockResolvedValue(true),
      onLeaveRoom: vi.fn(),
      showToast: vi.fn(),
    };

    await act(async () => {
      root.render(<HostModal {...props} isOpen={true} />);
    });

    // Switch to Cloudflare Tunnel
    const tunnelBtn = findByTestId(container, 'host-mode-tunnel-btn')!;
    await act(async () => {
      clickElement(tunnelBtn);
    });
    expect(findByTestId(container, 'host-mode-tunnel-btn')!.getAttribute('aria-pressed')).toBe('true');
    expect(findByTestId(container, 'host-start-btn')!.textContent).toContain(
      'Start Server & Copy Link'
    );

    // Close and re-open -> resets to P2P default
    await act(async () => {
      root.render(<HostModal {...props} isOpen={false} />);
    });
    await act(async () => {
      root.render(<HostModal {...props} isOpen={true} />);
    });
    expect(findByTestId(container, 'host-mode-p2p-btn')!.getAttribute('aria-pressed')).toBe('true');
    expect(findByTestId(container, 'host-start-btn')!.textContent).toContain(
      'Start Room & Copy Code'
    );
  });

  it('prioritizes Room Code label and placeholder in the Join Room tab', async () => {
    await act(async () => {
      root.render(
        <HostModal
          isOpen={true}
          onClose={vi.fn()}
          isHost={false}
          isConnected={false}
          hostInfo={null}
          peers={[]}
          myPeer={basePeer}
          onUpdateMyName={vi.fn()}
          onStartHosting={vi.fn().mockResolvedValue({})}
          onStartWebRtcHosting={vi.fn().mockResolvedValue({})}
          onStopHosting={vi.fn()}
          onJoinByInviteUrl={vi.fn().mockResolvedValue(true)}
          onLeaveRoom={vi.fn()}
          showToast={vi.fn()}
        />
      );
    });

    const joinTabBtn = findAll(
      container,
      (el) => el.tagName === 'BUTTON' && el.textContent.trim() === 'Join Room'
    )[0];
    expect(joinTabBtn).toBeDefined();

    await act(async () => {
      clickElement(joinTabBtn);
    });

    expect(container.textContent).toContain('Room Code (INK-XXXX...) or Invite Link');
    const input = findByTestId(container, 'join-target-input');
    expect(input).toBeDefined();
    expect(input!.placeholder).toContain('INK-7429-K8P2M9');
    expect(input!.placeholder).toContain('trycloudflare.com');
  });

  it('exposes Collaboration settings tab in SettingsModal with signaling & TURN controls and Reset', async () => {
    const onUpdateSettings = vi.fn();
    const onShowToast = vi.fn();

    await act(async () => {
      root.render(
        <SettingsModal
          isOpen={true}
          onClose={vi.fn()}
          settings={{
            ...DEFAULT_APP_SETTINGS,
            collabSignalingUrl: 'wss://sig.example.workers.dev/signal',
            collabTurnUrl: 'turns:turn.example.com:5349',
            collabTurnUsername: 'sora',
            collabTurnCredential: 'pw',
          }}
          onUpdateSettings={onUpdateSettings}
          onShowToast={onShowToast}
        />
      );
    });

    const collabTabBtn = findAll(
      container,
      (el) => el.tagName === 'BUTTON' && el.textContent.trim() === 'Collaboration'
    )[0];
    expect(collabTabBtn).toBeDefined();

    await act(async () => {
      clickElement(collabTabBtn);
    });

    expect(findByTestId(container, 'settings-collab-nickname')).toBeDefined();
    expect(findByTestId(container, 'settings-collab-signaling-url')?.value).toBe(
      'wss://sig.example.workers.dev/signal'
    );
    expect(findByTestId(container, 'settings-collab-turn-url')?.value).toBe(
      'turns:turn.example.com:5349'
    );
    expect(findByTestId(container, 'settings-collab-turn-username')?.value).toBe('sora');
    expect(findByTestId(container, 'settings-collab-turn-credential')?.value).toBe('pw');

    const resetBtn = findByTestId(container, 'settings-collab-reset-btn')!;
    await act(async () => {
      clickElement(resetBtn);
    });

    expect(onUpdateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        collabSignalingUrl: '',
        collabTurnUrl: '',
        collabTurnUsername: '',
        collabTurnCredential: '',
      })
    );
  });
});
