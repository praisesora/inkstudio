import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  useMultiplayer,
  computeReconnectDelayMs,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from '../../hooks/useMultiplayer';
import {
  multiplayerService,
  sanitizeIncomingJsonMessage,
} from '../../services/multiplayerService';
import {
  canDeleteLayer,
  canEditLayer,
  canMutateCanvas,
  canToggleLayerOwnerLock,
  filterDeletableLayerIds,
  validateIncomingRemoteMutation,
} from '../collabPermissions';
import { documentStore } from '../documentStore';
import type { LayerItem } from '../../types/editor';
import type { CollabPeer, MultiplayerMessage, TileStreamMessage } from '../../types/multiplayer';

// Minimal DOM shim for React 19 createRoot in Vitest Node environment
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
  win.location = { protocol: 'http:', hostname: '127.0.0.1', href: 'http://127.0.0.1/' };
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
  return { doc, win };
}

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  static nextFail = false;

  url: string;
  binaryType = 'arraybuffer';
  readyState = 0;
  bufferedAmount = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: any }) => void) | null = null;
  onclose: ((ev: { reason?: string }) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (MockWebSocket.nextFail) {
        MockWebSocket.nextFail = false;
        this.readyState = MockWebSocket.CLOSED;
        this.onerror?.(new Event('error'));
        this.onclose?.({ reason: 'offline' });
      } else {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.();
      }
    });
  }

  send(data: any) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateDrop() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ reason: 'network drop' });
  }

  simulateJson(obj: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function makeLayer(overrides: Partial<LayerItem> = {}): LayerItem {
  return {
    id: overrides.id ?? 'layer-1',
    name: overrides.name ?? 'Layer 1',
    type: overrides.type ?? 'raster',
    visible: overrides.visible ?? true,
    opacity: overrides.opacity ?? 1,
    blendMode: overrides.blendMode ?? 'normal',
    locked: overrides.locked ?? false,
    parentId: overrides.parentId ?? null,
    ...overrides,
  };
}

describe('Exponential Backoff Calculation', () => {
  it('grows exponentially, respects max cap, applies +/-20% jitter, and calls rng once', () => {
    const rngSpy = vi.fn(() => 0.5); // 0.8 + 0.4 * 0.5 = 1.0x
    expect(computeReconnectDelayMs(1, rngSpy)).toBe(RECONNECT_BASE_DELAY_MS);
    expect(rngSpy).toHaveBeenCalledTimes(1);

    expect(computeReconnectDelayMs(2, () => 0.5)).toBe(2000);
    expect(computeReconnectDelayMs(3, () => 0.5)).toBe(4000);
    expect(computeReconnectDelayMs(4, () => 0.5)).toBe(8000);
    expect(computeReconnectDelayMs(5, () => 0.5)).toBe(16000);
    expect(computeReconnectDelayMs(6, () => 0.5)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(computeReconnectDelayMs(12, () => 1.0)).toBe(RECONNECT_MAX_DELAY_MS);

    expect(computeReconnectDelayMs(1, () => 0)).toBe(800);
    expect(computeReconnectDelayMs(1, () => 1)).toBe(1200);
  });
});

describe('Room Roles, Owner Locking & Accidental Deletion Protection', () => {
  const aliceLayer = makeLayer({
    id: 'l-alice',
    name: 'Alice Ink',
    ownerPeerId: 'alice',
    ownerPeerName: 'Alice',
  });
  const bobLayer = makeLayer({
    id: 'l-bob',
    name: 'Bob Sketch',
    ownerPeerId: 'bob',
    ownerPeerName: 'Bob',
    reservedByPeerId: 'bob',
    reservedByPeerName: 'Bob',
  });
  const folder = makeLayer({
    id: 'f-1',
    name: 'Shared Folder',
    type: 'folder',
    ownerPeerId: 'alice',
    ownerPeerName: 'Alice',
  });
  const bobChild = makeLayer({
    id: 'l-bob-child',
    name: 'Bob Child',
    parentId: 'f-1',
    ownerPeerId: 'bob',
    ownerPeerName: 'Bob',
  });
  const allLayers = [aliceLayer, bobLayer, folder, bobChild];

  it('enforces Viewer read-only across edits, locks, and deletes', () => {
    expect(canMutateCanvas('host')).toBe(true);
    expect(canMutateCanvas('editor')).toBe(true);
    expect(canMutateCanvas('viewer')).toBe(false);

    expect(canEditLayer(aliceLayer, 'alice', 'viewer').allowed).toBe(false);
    expect(canToggleLayerOwnerLock(aliceLayer, 'alice', 'viewer').allowed).toBe(false);
    expect(canDeleteLayer('l-alice', allLayers, 'alice', 'viewer').allowed).toBe(false);
  });

  it('enforces layer locking by owner while allowing owner & Host', () => {
    expect(canEditLayer(bobLayer, 'alice', 'editor').allowed).toBe(false);
    expect(canEditLayer(bobLayer, 'bob', 'editor').allowed).toBe(true);
    expect(canEditLayer(bobLayer, 'host-1', 'host').allowed).toBe(true);

    // Non-owner Editor cannot unlock Bob's layer or lock Alice's layer
    expect(canToggleLayerOwnerLock(bobLayer, 'alice', 'editor').allowed).toBe(false);
    expect(canToggleLayerOwnerLock(aliceLayer, 'bob', 'editor').allowed).toBe(false);
    // Owner and Host can lock/unlock
    expect(canToggleLayerOwnerLock(bobLayer, 'bob', 'editor').allowed).toBe(true);
    expect(canToggleLayerOwnerLock(aliceLayer, 'alice', 'editor').allowed).toBe(true);
    expect(canToggleLayerOwnerLock(bobLayer, 'host-1', 'host').allowed).toBe(true);
  });

  it('prevents accidental deletion of other users layers including nested folder children', () => {
    // Alice can delete her own unshared layer
    expect(canDeleteLayer('l-alice', allLayers, 'alice', 'editor').allowed).toBe(true);
    // Alice cannot delete Bob's layer
    expect(canDeleteLayer('l-bob', allLayers, 'alice', 'editor').allowed).toBe(false);
    // Alice cannot delete her own folder if it contains Bob's child layer!
    const folderCheck = canDeleteLayer('f-1', allLayers, 'alice', 'editor');
    expect(folderCheck.allowed).toBe(false);
    expect(folderCheck.blockedLayerId).toBe('l-bob-child');
    // Host can override and delete
    expect(canDeleteLayer('f-1', allLayers, 'host-1', 'host').allowed).toBe(true);

    // Multi-select filter spares Bob's layer while allowing Alice's
    const filtered = filterDeletableLayerIds(['l-alice', 'l-bob'], allLayers, 'alice', 'editor');
    expect(filtered.allowedIds).toEqual(['l-alice']);
    expect(filtered.blockedReasons.length).toBe(1);
  });

  it('validates incoming remote mutations for defense-in-depth', () => {
    const viewerPeer: CollabPeer = { id: 'v1', name: 'Viewer', color: '#fff', role: 'viewer' };
    const editorPeer: CollabPeer = { id: 'alice', name: 'Alice', color: '#0f0', role: 'editor' };
    const hostPeer: CollabPeer = { id: 'host-1', name: 'Host', color: '#00f', isHost: true, role: 'host' };

    const deleteBobMsg: MultiplayerMessage = {
      type: 'LAYER_DELETE',
      senderId: 'alice',
      layerId: 'l-bob',
    };
    expect(validateIncomingRemoteMutation(deleteBobMsg, editorPeer, allLayers).allowed).toBe(false);
    expect(
      validateIncomingRemoteMutation({ ...deleteBobMsg, senderId: 'host-1' }, hostPeer, allLayers).allowed
    ).toBe(true);

    const viewerTileMsg: TileStreamMessage = {
      type: 'BINARY_TILE',
      senderId: 'v1',
      layerId: 'l-alice',
      tileX: 0,
      tileY: 0,
      format: 'color-32bit',
      version: 1,
      data: new Uint8Array([1, 2, 3, 4]),
    };
    expect(validateIncomingRemoteMutation(viewerTileMsg, viewerPeer, allLayers).allowed).toBe(false);

    const spoofRoleMsg: MultiplayerMessage = {
      type: 'PEER_ROLE_UPDATE',
      senderId: 'alice',
      targetPeerId: 'bob',
      role: 'viewer',
    };
    expect(validateIncomingRemoteMutation(spoofRoleMsg, editorPeer, allLayers).allowed).toBe(false);
  });

  it('sanitizes incoming role/kick/ban/access-denied JSON messages strictly', () => {
    expect(
      sanitizeIncomingJsonMessage({ type: 'PEER_ROLE_UPDATE', targetPeerId: 'p1', role: 'viewer' })
    ).toEqual({
      type: 'PEER_ROLE_UPDATE',
      senderId: undefined,
      targetPeerId: 'p1',
      role: 'viewer',
    });
    expect(
      sanitizeIncomingJsonMessage({ type: 'PEER_ROLE_UPDATE', targetPeerId: 'p1', role: 'superadmin' })
    ).toBeNull();
    expect(
      sanitizeIncomingJsonMessage({ type: 'PEER_BAN', targetPeerId: 'p2', reason: 'Spam' })
    ).toMatchObject({ type: 'PEER_BAN', targetPeerId: 'p2', reason: 'Spam' });
    expect(
      sanitizeIncomingJsonMessage({ type: 'ACCESS_DENIED', code: 'BANNED', reason: 'No access' })
    ).toMatchObject({ type: 'ACCESS_DENIED', code: 'BANNED', reason: 'No access' });
  });
});

describe('useMultiplayer Auto-Reconnect, Seq Catch-Up & Moderation', () => {
  let root: Root | null = null;
  let container: any;
  const origWs = (globalThis as any).WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    MockWebSocket.nextFail = false;
    (globalThis as any).WebSocket = MockWebSocket;
    const { doc } = installDomShim();
    container = doc.createElement('div');
    multiplayerService.disconnect();
    documentStore.getActiveTileGrid().clearAll();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    multiplayerService.disconnect();
    (globalThis as any).WebSocket = origWs;
    vi.useRealTimers();
  });

  it('auto-reconnects with exponential backoff, preserves session, and catches up missed seqs/tiles', async () => {
    const toasts: string[] = [];
    const layerActions: MultiplayerMessage[] = [];
    let api!: ReturnType<typeof useMultiplayer>;

    function Harness() {
      api = useMultiplayer({
        dimensions: { width: 512, height: 512 },
        colorMode: 'color',
        layers: [makeLayer({ id: 'l1' })],
        onRemoteLayerAction: (m) => layerActions.push(m),
        showToast: (m) => toasts.push(m),
      });
      return null;
    }

    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(Harness));
    });

    await act(async () => {
      const ok = await api.joinRoom('127.0.0.1', 30303, 'Studio', 'Alice', 'secret');
      expect(ok).toBe(true);
    });

    const ws1 = MockWebSocket.instances[0];
    expect(ws1).toBeDefined();

    // Receive initial ROOM_INFO + sequenced op seq=10
    await act(async () => {
      ws1.simulateJson({ type: 'ROOM_INFO', clientId: 2, roomName: 'Studio', serverSeq: 5 });
      ws1.simulateJson({
        type: 'JOIN_ACCEPTED',
        seq: 6,
        targetPeerId: api.myPeer.id,
        roomName: 'Studio',
        peers: [{ id: 'host-1', name: 'Host', color: '#fff', isHost: true, role: 'host' }],
        hostId: 'host-1',
        docDimensions: { width: 512, height: 512 },
        colorMode: 'color',
        assignedRole: 'editor',
      });
      ws1.simulateJson({
        type: 'LAYER_RENAME',
        seq: 10,
        senderId: 'host-1',
        layerId: 'l1',
        newName: 'Before Drop',
      });
    });

    expect(api.isConnected).toBe(true);
    expect(api.connectionStatus).toBe('connected');
    expect(api.peers.length).toBe(1);

    // Unexpected network drop -> MUST NOT reset hostInfo / session; enters reconnecting
    await act(async () => {
      ws1.simulateDrop();
    });

    expect(api.isConnected).toBe(false);
    expect(api.connectionStatus).toBe('reconnecting');
    expect(api.hostInfo?.roomName).toBe('Studio');
    expect(api.reconnectAttempt).toBe(1);

    // First reconnect attempt fails -> backoff schedules attempt 2
    MockWebSocket.nextFail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(api.connectionStatus).toBe('reconnecting');
    expect(api.reconnectAttempt).toBe(2);

    // Second reconnect attempt succeeds and sends JOIN_REQUEST with isReconnect + sinceSeq: 10
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(api.isConnected).toBe(true);
    expect(api.connectionStatus).toBe('connected');
    expect(api.reconnectAttempt).toBe(0);

    const wsReconnected = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    const joinSent = JSON.parse(wsReconnected.sent[0]);
    expect(joinSent.type).toBe('JOIN_REQUEST');
    expect(joinSent.isReconnect).toBe(true);
    expect(joinSent.sinceSeq).toBe(10);

    // Server replays missed op seq=11 after reconnect
    await act(async () => {
      wsReconnected.simulateJson({
        type: 'LAYER_RENAME',
        seq: 11,
        senderId: 'host-1',
        layerId: 'l1',
        newName: 'Caught Up',
      });
    });
    expect(layerActions.some((m) => m.type === 'LAYER_RENAME' && (m as any).newName === 'Caught Up')).toBe(true);
  });

  it('halts auto-reconnect immediately when kicked or banned via ACCESS_DENIED', async () => {
    const toasts: string[] = [];
    let api!: ReturnType<typeof useMultiplayer>;

    function Harness() {
      api = useMultiplayer({
        dimensions: { width: 512, height: 512 },
        colorMode: 'color',
        layers: [makeLayer({ id: 'l1' })],
        showToast: (m) => toasts.push(m),
      });
      return null;
    }

    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(Harness));
    });

    await act(async () => {
      await api.joinRoom('127.0.0.1', 30303, 'Studio', 'Bob', 'secret');
    });

    const ws1 = MockWebSocket.instances[0];
    await act(async () => {
      ws1.simulateJson({
        type: 'ACCESS_DENIED',
        code: 'BANNED',
        targetPeerId: api.myPeer.id,
        reason: 'You are banned from this room',
      });
    });

    expect(api.isConnected).toBe(false);
    expect(api.connectionStatus).toBe('disconnected');
    expect(api.hostInfo).toBeNull();
    expect(toasts).toContain('You are banned from this room');

    // Advancing timers must NOT spawn any reconnect sockets
    const countAfterBan = MockWebSocket.instances.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(MockWebSocket.instances.length).toBe(countAfterBan);
  });

  it('updates local role to viewer on PEER_ROLE_UPDATE and blocks outgoing mutations', async () => {
    const toasts: string[] = [];
    let api!: ReturnType<typeof useMultiplayer>;

    function Harness() {
      api = useMultiplayer({
        dimensions: { width: 512, height: 512 },
        colorMode: 'color',
        layers: [makeLayer({ id: 'l1' })],
        showToast: (m) => toasts.push(m),
      });
      return null;
    }

    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(Harness));
    });

    await act(async () => {
      await api.joinRoom('127.0.0.1', 30303, 'Studio', 'Guest1', 'secret');
    });
    const ws1 = MockWebSocket.instances[0];

    await act(async () => {
      ws1.simulateJson({
        type: 'JOIN_ACCEPTED',
        seq: 1,
        targetPeerId: api.myPeer.id,
        roomName: 'Studio',
        peers: [{ id: 'host-1', name: 'Host', color: '#fff', isHost: true, role: 'host' }],
        hostId: 'host-1',
        docDimensions: { width: 512, height: 512 },
        colorMode: 'color',
        assignedRole: 'editor',
      });
      ws1.simulateJson({
        type: 'PEER_ROLE_UPDATE',
        seq: 2,
        senderId: 'host-1',
        targetPeerId: api.myPeer.id,
        role: 'viewer',
      });
    });

    expect(api.myRole).toBe('viewer');
    expect(multiplayerService.getLocalRole()).toBe('viewer');

    const sentBefore = ws1.sent.length;
    multiplayerService.sendLayerDelete('l1');
    multiplayerService.sendLayerRename('l1', 'Hacked');
    expect(ws1.sent.length).toBe(sentBefore);
  });
});
