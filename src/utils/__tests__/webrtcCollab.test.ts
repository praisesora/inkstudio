import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CHUNK_HEADER_BYTES,
  ChunkReassembler,
  DEFAULT_CHUNK_PAYLOAD_BYTES,
  ICollabTransport,
  encodeTransportFrames,
} from '../../services/collabTransport';
import {
  computeRoomTopicHash,
  decodeMqttPackets,
  encodeMqttConnect,
  encodeMqttPublish,
  encodeMqttSubscribe,
  generateP2pRoomCredentials,
  sha256HexSync,
  validateSignalingMessage,
  ISignalingClient,
  SignalingEnvelope,
} from '../../services/webrtcSignaling';
import {
  BINARY_MAGIC_0,
  BINARY_MAGIC_1,
  buildP2pShareUrl,
  multiplayerService,
  parseCollabTarget,
  parseInviteUrl,
} from '../../services/multiplayerService';
import {
  DEFAULT_WEBRTC_ICE_SERVERS,
  WebRtcHostHub,
  buildIceServers,
} from '../../services/webrtcHostHub';
import { WebRtcGuestClient } from '../../services/webrtcGuestClient';
import type { CollabPeer, MultiplayerMessage } from '../../types/multiplayer';
import type { TileBuffer } from '../tileEngine';

describe('WebRTC Framing & Chunking (collabTransport.ts)', () => {
  it('round-trips small text and binary messages in a single frame', () => {
    const reassembler = new ChunkReassembler();

    const text = JSON.stringify({ type: 'CURSOR_MOVE', peerId: 'p1', x: 120, y: 240 });
    const textFrames = encodeTransportFrames('text', text, 1);
    expect(textFrames).toHaveLength(1);
    expect(textFrames[0].byteLength).toBeGreaterThan(CHUNK_HEADER_BYTES);

    const decodedText = reassembler.pushFrame(textFrames[0]);
    expect(decodedText).toEqual({ kind: 'text', text });

    // Binary Ink Studio packet ('I', 'N', ...)
    const binPayload = new Uint8Array([BINARY_MAGIC_0, BINARY_MAGIC_1, 0x01, 0x02, 0x03, 0xfe, 0xff]);
    const binFrames = encodeTransportFrames('binary', binPayload, 2);
    expect(binFrames).toHaveLength(1);

    const decodedBin = reassembler.pushFrame(binFrames[0]);
    expect(decodedBin?.kind).toBe('binary');
    if (decodedBin?.kind === 'binary') {
      expect(Array.from(new Uint8Array(decodedBin.data))).toEqual(Array.from(binPayload));
    }
  });

  it('splits large multi-MB binary snapshots into 48 KB chunks and reassembles cleanly', () => {
    const size = 1_250_000; // ~1.25 MB LZ4 canvas snapshot
    const payload = new Uint8Array(size);
    payload[0] = BINARY_MAGIC_0; // 'I'
    payload[1] = BINARY_MAGIC_1; // 'N'
    for (let i = 2; i < size; i++) {
      payload[i] = (i * 31 + 7) & 0xff;
    }

    const frames = encodeTransportFrames('binary', payload, 42);
    const expectedChunks = Math.ceil(size / DEFAULT_CHUNK_PAYLOAD_BYTES);
    expect(frames).toHaveLength(expectedChunks);
    expect(expectedChunks).toBeGreaterThan(20);

    for (const f of frames) {
      expect(f.byteLength).toBeLessThanOrEqual(CHUNK_HEADER_BYTES + DEFAULT_CHUNK_PAYLOAD_BYTES);
    }

    const reassembler = new ChunkReassembler();
    let result = null;
    for (let i = 0; i < frames.length; i++) {
      result = reassembler.pushFrame(frames[i]);
      if (i < frames.length - 1) {
        expect(result).toBeNull();
      }
    }

    expect(result?.kind).toBe('binary');
    if (result?.kind === 'binary') {
      const out = new Uint8Array(result.data);
      expect(out.byteLength).toBe(size);
      expect(out[0]).toBe(BINARY_MAGIC_0);
      expect(out[1]).toBe(BINARY_MAGIC_1);
      expect(out[123456]).toBe(payload[123456]);
      expect(out[size - 1]).toBe(payload[size - 1]);
    }
    expect(reassembler.getPendingCount()).toBe(0);
  });

  it('handles out-of-order, interleaved messageIds, duplicate chunks, and UTF-8 JSON', () => {
    const bigJson = JSON.stringify({
      type: 'DOC_SYNC_RESPONSE',
      name: 'Ink Studio — 世界',
      blob: 'あいうえお-'.repeat(4000),
    });
    const framesA = encodeTransportFrames('text', bigJson, 100, 1024);
    const framesB = encodeTransportFrames('text', 'hello-'.repeat(500), 200, 1024);
    expect(framesA.length).toBeGreaterThan(3);
    expect(framesB.length).toBeGreaterThan(2);

    const reassembler = new ChunkReassembler();
    expect(reassembler.pushFrame(framesA[2])).toBeNull();
    expect(reassembler.pushFrame(framesB[1])).toBeNull();
    expect(reassembler.pushFrame(framesA[2])).toBeNull(); // duplicate
    expect(reassembler.pushFrame(framesA[0])).toBeNull();

    let completedB: ReturnType<ChunkReassembler['pushFrame']> = null;
    for (let i = 0; i < framesB.length; i++) {
      if (i === 1) continue;
      completedB = reassembler.pushFrame(framesB[i]);
    }
    expect(completedB).toEqual({ kind: 'text', text: 'hello-'.repeat(500) });

    let completedA: ReturnType<ChunkReassembler['pushFrame']> = null;
    for (let i = 1; i < framesA.length; i++) {
      if (i === 2) continue;
      completedA = reassembler.pushFrame(framesA[i]);
    }
    expect(completedA).toEqual({ kind: 'text', text: bigJson });
    expect(reassembler.getPendingCount()).toBe(0);
  });

  it('rejects malformed headers and prunes expired partial messages', () => {
    const reassembler = new ChunkReassembler();

    expect(reassembler.pushFrame(new Uint8Array([0x49, 0x43]))).toBeNull();
    const badMagic = new Uint8Array(CHUNK_HEADER_BYTES + 4);
    badMagic[0] = 0x00;
    badMagic[1] = 0x00;
    expect(reassembler.pushFrame(badMagic)).toBeNull();

    const partialFrames = encodeTransportFrames('text', 'x'.repeat(2500), 99, 1024);
    expect(partialFrames.length).toBe(3);
    expect(reassembler.pushFrame(partialFrames[0], 1000)).toBeNull();
    expect(reassembler.getPendingCount()).toBe(1);

    reassembler.pruneExpired(10_000);
    expect(reassembler.getPendingCount()).toBe(1);

    reassembler.pruneExpired(40_000);
    expect(reassembler.getPendingCount()).toBe(0);
  });
});

describe('WebRTC Signaling Crypto, Validation & MQTT Codec (webrtcSignaling.ts)', () => {
  it('computes RFC-compliant SHA-256 hex digests and deterministic room topic hashes', () => {
    expect(sha256HexSync('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(sha256HexSync('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );

    const h1 = computeRoomTopicHash('INK-7429', 'K8P2M9');
    const h2 = computeRoomTopicHash(' ink-7429 ', 'k8p2m9');
    const hDiffSecret = computeRoomTopicHash('INK-7429', 'XXXXXX');
    const hDiffCode = computeRoomTopicHash('INK-7430', 'K8P2M9');

    expect(h1).toHaveLength(64);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(hDiffSecret);
    expect(h1).not.toBe(hDiffCode);
  });

  it('generates human-friendly INK-XXXX credentials and join codes', () => {
    const creds = generateP2pRoomCredentials();
    expect(creds.roomCode).toMatch(/^INK-\d{4}$/);
    expect(creds.roomSecret).toMatch(/^[A-Z2-9]{6}$/);
    expect(creds.joinCode).toBe(`${creds.roomCode}-${creds.roomSecret}`);
    expect(creds.roomHash).toBe(computeRoomTopicHash(creds.roomCode, creds.roomSecret));
  });

  it('validates signaling envelopes strictly against roomHash and schema constraints', () => {
    const roomHash = computeRoomTopicHash('INK-7429', 'K8P2M9');
    const wrongHash = computeRoomTopicHash('INK-7429', 'WRONG1');

    const validOffer = {
      v: 1,
      roomHash,
      mid: 'msg-1',
      type: 'offer',
      fromPeerId: 'guest-1',
      sdp: 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\n',
      ts: Date.now(),
    };
    expect(validateSignalingMessage(validOffer, roomHash)).toMatchObject({
      v: 1,
      type: 'offer',
      roomHash,
      fromPeerId: 'guest-1',
      sdpType: 'offer',
    });

    // Cross-room hijack attempt
    expect(
      validateSignalingMessage(
        {
          v: 1,
          roomHash: wrongHash,
          mid: 'msg-2',
          type: 'offer',
          fromPeerId: 'attacker',
          sdp: 'v=0\r\n',
          ts: Date.now(),
        },
        roomHash
      )
    ).toBeNull();

    // Oversized SDP rejected
    expect(
      validateSignalingMessage(
        { v: 1, roomHash, mid: 'm6', type: 'offer', fromPeerId: 'g1', sdp: 'a'.repeat(70_000), ts: 1 },
        roomHash
      )
    ).toBeNull();

    // Unknown message type rejected
    expect(
      validateSignalingMessage(
        { v: 1, roomHash, mid: 'm5', type: 'eval', fromPeerId: 'g1', ts: 1 },
        roomHash
      )
    ).toBeNull();
  });

  it('encodes and decodes MQTT v3.1.1 CONNECT, SUBSCRIBE, and PUBLISH packets cleanly', () => {
    const connectPkt = encodeMqttConnect('ink-desktop-client');
    expect(connectPkt[0]).toBe(0x10);

    const subPkt = encodeMqttSubscribe(1, 'inkstudio/sig/v1/abcdef');
    expect(subPkt[0]).toBe(0x82);

    const topic = 'inkstudio/sig/v1/0123456789abcdef';
    const largePayload = JSON.stringify({ sdp: 'v=0\r\n' + 'a=candidate:'.repeat(40) });
    const pubPkt = encodeMqttPublish(topic, largePayload);
    const pubPkt2 = encodeMqttPublish(topic, '{"type":"bye"}');

    const combined = new Uint8Array(pubPkt.length + pubPkt2.length);
    combined.set(pubPkt, 0);
    combined.set(pubPkt2, pubPkt.length);

    const packets = decodeMqttPackets(combined);
    expect(packets).toHaveLength(2);
    expect(packets[0]).toEqual({ packetType: 3, topic, payload: largePayload });
    expect(packets[1]).toEqual({ packetType: 3, topic, payload: '{"type":"bye"}' });
    expect(decodeMqttPackets(pubPkt.slice(0, 10))).toEqual([]);
  });
});

describe('Room-Code & Invite-Link Routing (parseCollabTarget & parseInviteUrl)', () => {
  it('routes short P2P room codes and tablet P2P invite links to WebRTC P2P', () => {
    // Combined code (case-insensitive)
    expect(parseCollabTarget('ink-7429-k8p2m9')).toMatchObject({
      kind: 'p2p',
      roomCode: 'INK-7429',
      roomSecret: 'K8P2M9',
      joinCode: 'INK-7429-K8P2M9',
      roomName: 'INK-7429',
    });

    // Bare code (separate passcode)
    expect(parseCollabTarget('INK-7429')).toMatchObject({
      kind: 'p2p',
      roomCode: 'INK-7429',
      roomSecret: '',
      joinCode: 'INK-7429',
      roomName: 'INK-7429',
    });

    // Tablet deep-link P2P invite
    expect(
      parseCollabTarget('inkstudio://p2p?code=INK-5511&secret=ABC234&room=Tablet%20Canvas')
    ).toMatchObject({
      kind: 'p2p',
      roomCode: 'INK-5511',
      roomSecret: 'ABC234',
      joinCode: 'INK-5511-ABC234',
      roomName: 'Tablet Canvas',
    });

    // HTTPS web P2P invite with custom signaling URL
    expect(
      parseCollabTarget(
        'https://inkstudio.app/?p2p=INK-4400&secret=Q7R8S9&room=Collab&sig=wss%3A%2F%2Fsig.example.workers.dev%2Fsignal'
      )
    ).toMatchObject({
      kind: 'p2p',
      roomCode: 'INK-4400',
      roomSecret: 'Q7R8S9',
      joinCode: 'INK-4400-Q7R8S9',
      roomName: 'Collab',
      signalingUrl: 'wss://sig.example.workers.dev/signal',
    });

    // buildP2pShareUrl round-trip
    const shareUrl = buildP2pShareUrl(
      'INK-8123',
      'M4N5P6',
      'PC Studio',
      'wss://sig.example.workers.dev/signal'
    );
    expect(parseCollabTarget(shareUrl)).toMatchObject({
      kind: 'p2p',
      roomCode: 'INK-8123',
      roomSecret: 'M4N5P6',
      joinCode: 'INK-8123-M4N5P6',
      roomName: 'PC Studio',
      signalingUrl: 'wss://sig.example.workers.dev/signal',
    });
  });

  it('continues routing ws://, wss://, trycloudflare.com, and LAN HTTP links to WebSocket', () => {
    const cfHttp = parseCollabTarget(
      'https://warm-ink-1234.trycloudflare.com/?room=Studio&token=tok1'
    );
    expect(cfHttp).toMatchObject({
      kind: 'ws',
      host: 'warm-ink-1234.trycloudflare.com',
      port: 443,
      roomName: 'Studio',
      token: 'tok1',
      isSecure: true,
    });

    // Bare trycloudflare.com URL without ?room=
    const cfBare = parseCollabTarget('https://quick-room.trycloudflare.com/');
    expect(cfBare).toMatchObject({
      kind: 'ws',
      host: 'quick-room.trycloudflare.com',
      port: 443,
      isSecure: true,
    });

    // Direct wss:// URL with custom path
    const directWss = parseCollabTarget('wss://relay.example.com:8443/custom/ws?room=Art&token=abc');
    expect(directWss).toMatchObject({
      kind: 'ws',
      host: 'relay.example.com',
      port: 8443,
      roomName: 'Art',
      token: 'abc',
      isSecure: true,
      wsPath: '/custom/ws',
    });

    // Local LAN ws:// and http:// URLs
    const lanWs = parseCollabTarget('ws://192.168.1.40:30303/ws?token=lan1');
    expect(lanWs).toMatchObject({
      kind: 'ws',
      host: '192.168.1.40',
      port: 30303,
      token: 'lan1',
      isSecure: false,
    });

    const lanHttp = parseInviteUrl('http://192.168.1.40:30303/?room=LAN&token=lan2');
    expect(lanHttp).toMatchObject({
      host: '192.168.1.40',
      port: 30303,
      roomName: 'LAN',
      token: 'lan2',
      isSecure: false,
    });

    // Invalid inputs
    expect(parseCollabTarget('not a room code')).toBeNull();
    expect(parseCollabTarget('')).toBeNull();
  });
});

describe('Binary & JSON Wire Compatibility over ICollabTransport & WebRTC Hub/Guest', () => {
  const origRTCPeerConnection = globalThis.RTCPeerConnection;

  afterEach(() => {
    multiplayerService.disconnect();
    if (origRTCPeerConnection === undefined) {
      delete (globalThis as Record<string, unknown>).RTCPeerConnection;
    } else {
      globalThis.RTCPeerConnection = origRTCPeerConnection;
    }
  });

  it('includes public Google + Cloudflare STUN servers and optional TURN config', () => {
    const defaultIce = buildIceServers();
    expect(defaultIce).toEqual(DEFAULT_WEBRTC_ICE_SERVERS);

    const withTurn = buildIceServers({
      turnUrl: 'turns:turn.example.com:5349',
      turnUsername: 'ink',
      turnCredential: 'secret',
    });
    expect(withTurn).toHaveLength(DEFAULT_WEBRTC_ICE_SERVERS.length + 1);
    expect(withTurn[withTurn.length - 1]).toEqual({
      urls: 'turns:turn.example.com:5349',
      username: 'ink',
      credential: 'secret',
    });
  });

  it('round-trips JSON and binary (LZ4 tile delta + stroke + cursor) packets via multiplayerService.attachTransport', () => {
    const sentTexts: string[] = [];
    const sentBinaries: Uint8Array[] = [];
    const textListeners = new Set<(text: string) => void>();
    const binaryListeners = new Set<(data: ArrayBuffer) => void>();
    const closeListeners = new Set<(reason?: string) => void>();
    let open = true;

    const loopbackTransport: ICollabTransport = {
      kind: 'webrtc-guest',
      isOpen: () => open,
      getBufferedAmount: () => 0,
      sendText: (text: string) => {
        sentTexts.push(text);
        // Loop back through ChunkReassembler to simulate real WebRTC DataChannel framing
        const frames = encodeTransportFrames('text', text, sentTexts.length);
        const reassembler = new ChunkReassembler();
        for (const frame of frames) {
          const out = reassembler.pushFrame(frame);
          if (out?.kind === 'text') {
            textListeners.forEach((h) => h(out.text));
          }
        }
      },
      sendBinary: (data: ArrayBuffer | Uint8Array) => {
        const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
        sentBinaries.push(bytes);
        const frames = encodeTransportFrames('binary', bytes, 1000 + sentBinaries.length);
        const reassembler = new ChunkReassembler();
        for (const frame of frames) {
          const out = reassembler.pushFrame(frame);
          if (out?.kind === 'binary') {
            binaryListeners.forEach((h) => h(out.data));
          }
        }
      },
      close: () => {
        if (!open) return;
        open = false;
        closeListeners.forEach((h) => h('closed'));
      },
      onTextMessage: (h) => {
        textListeners.add(h);
        return () => textListeners.delete(h);
      },
      onBinaryMessage: (h) => {
        binaryListeners.add(h);
        return () => binaryListeners.delete(h);
      },
      onClose: (h) => {
        closeListeners.add(h);
        return () => closeListeners.delete(h);
      },
      onError: () => () => {},
    };

    const received: MultiplayerMessage[] = [];
    const unsub = multiplayerService.onMessage((msg) => received.push(msg));

    const peer: CollabPeer = {
      id: 'desktop-peer-1',
      name: 'DesktopArtist',
      color: '#3b82f6',
      role: 'editor',
    };

    multiplayerService.attachTransport(loopbackTransport, peer, { sendJoinRequest: true });
    expect(multiplayerService.isConnected()).toBe(true);
    expect(multiplayerService.getTransportKind()).toBe('webrtc-guest');

    // Verify automatic JOIN_REQUEST over WebRTC text frame
    expect(received.some((m) => m.type === 'JOIN_REQUEST')).toBe(true);

    // Send JSON layer rename
    multiplayerService.sendLayerRename('layer-1', 'Lineart');
    const renameMsg = received.find((m) => m.type === 'LAYER_RENAME');
    expect(renameMsg).toMatchObject({
      type: 'LAYER_RENAME',
      layerId: 'layer-1',
      newName: 'Lineart',
    });

    // Send binary stroke chunk ('I','N', CODE_STROKE_CHUNK)
    multiplayerService.sendStrokeChunk('stroke-abc', [
      { x: 10, y: 20, pressure: 0.75, width: 12, timestamp: 1000 },
      { x: 25.5, y: 40.25, pressure: 0.9, width: 14, timestamp: 1016 },
    ]);
    const chunkMsg = received.find((m) => m.type === 'STROKE_CHUNK');
    expect(chunkMsg).toBeDefined();
    if (chunkMsg?.type === 'STROKE_CHUNK') {
      expect(chunkMsg.strokeId).toBe('stroke-abc');
      expect(chunkMsg.points).toHaveLength(2);
      expect(chunkMsg.points[0].x).toBeCloseTo(10, 3);
      expect(chunkMsg.points[1].pressure).toBeCloseTo(0.9, 3);
    }

    // Send binary LZ4 tile delta ('I','N', CODE_TILE_DELTA) — full 256x256 RGBA tile (262,144 bytes)
    const tileBytes = new Uint8Array(256 * 256 * 4);
    for (let i = 0; i < tileBytes.length; i += 4) {
      tileBytes[i] = 255;
      tileBytes[i + 1] = 128;
      tileBytes[i + 2] = 64;
      tileBytes[i + 3] = 255;
    }
    const tile: TileBuffer = {
      layerId: 'layer-1',
      tileX: 2,
      tileY: 3,
      format: 'color-32bit',
      version: 5,
      data: tileBytes,
      dirty: true,
      isPagedToDisk: false,
      lastAccessTimestamp: 0,
      lod: 0,
    };
    multiplayerService.sendTileDelta('layer-1', tile);
    const tileMsg = received.find((m) => m.type === 'BINARY_TILE');
    expect(tileMsg).toBeDefined();
    if (tileMsg?.type === 'BINARY_TILE') {
      expect(tileMsg.layerId).toBe('layer-1');
      expect(tileMsg.tileX).toBe(2);
      expect(tileMsg.tileY).toBe(3);
      expect(tileMsg.version).toBe(5);
      expect(tileMsg.data?.byteLength).toBe(tileBytes.byteLength);
      expect(tileMsg.data?.[0]).toBe(255);
      expect(tileMsg.data?.[1]).toBe(128);
    }

    unsub();
  });

  it('connects WebRtcHostHub and WebRtcGuestClient end-to-end and enforces roles on binary & JSON traffic', async () => {
    const roomHash = computeRoomTopicHash('INK-9001', 'XYZ234');

    // In-memory signaling bus linking Host Hub and Guest Client
    const signalingBus = new Set<{ peerId: string; cb: (env: SignalingEnvelope) => void }>();
    const createMockSignaling = (peerId: string): ISignalingClient => ({
      connect: vi.fn().mockResolvedValue(undefined),
      send: (env) => {
        const full: SignalingEnvelope = {
          ...env,
          v: 1,
          roomHash,
          mid: `m-${Math.random().toString(36).slice(2)}`,
          ts: Date.now(),
        };
        queueMicrotask(() => {
          for (const sub of signalingBus) {
            if (sub.peerId === full.fromPeerId) continue;
            if (full.toPeerId && full.toPeerId !== sub.peerId) continue;
            sub.cb(full);
          }
        });
      },
      onMessage: (cb) => {
        const entry = { peerId, cb };
        signalingBus.add(entry);
        return () => signalingBus.delete(entry);
      },
      onError: () => () => {},
      close: vi.fn(),
    });

    // Paired FakeDataChannel / FakeRTCPeerConnection wiring Guest <-> Host
    class PairedDataChannel {
      readyState: RTCDataChannelState = 'connecting';
      binaryType: BinaryType = 'arraybuffer';
      bufferedAmount = 0;
      peerChannel: PairedDataChannel | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;

      open() {
        this.readyState = 'open';
        this.onopen?.();
      }
      send(data: ArrayBuffer | Uint8Array) {
        if (this.readyState !== 'open' || !this.peerChannel || this.peerChannel.readyState !== 'open') {
          return;
        }
        const copy =
          data instanceof Uint8Array
            ? new Uint8Array(data)
            : new Uint8Array(data.slice(0));
        this.peerChannel.onmessage?.({ data: copy.buffer });
      }
      close() {
        this.readyState = 'closed';
        this.onclose?.();
      }
    }

    let guestPcRef: FakePeerConnection | null = null;
    class FakePeerConnection {
      connectionState: RTCPeerConnectionState = 'new';
      localDescription: RTCSessionDescriptionInit | null = null;
      onicecandidate: ((ev: { candidate: null }) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      ondatachannel: ((ev: { channel: PairedDataChannel }) => void) | null = null;
      dc: PairedDataChannel | null = null;

      createDataChannel() {
        const dc = new PairedDataChannel();
        this.dc = dc;
        guestPcRef = this;
        return dc;
      }
      async createOffer() {
        return { type: 'offer' as const, sdp: 'v=0\r\noffer\r\n' };
      }
      async setLocalDescription(desc: RTCSessionDescriptionInit) {
        this.localDescription = desc;
      }
      async setRemoteDescription(desc: RTCSessionDescriptionInit) {
        if (desc.type === 'answer' && this.dc) {
          this.connectionState = 'connected';
          this.dc.open();
        }
      }
      async createAnswer() {
        // Pair host DC with guest DC
        const hostDc = new PairedDataChannel();
        if (guestPcRef?.dc) {
          hostDc.peerChannel = guestPcRef.dc;
          guestPcRef.dc.peerChannel = hostDc;
        }
        hostDc.readyState = 'open';
        this.connectionState = 'connected';
        this.ondatachannel?.({ channel: hostDc });
        return { type: 'answer' as const, sdp: 'v=0\r\nanswer\r\n' };
      }
      async addIceCandidate() {}
      close() {
        this.connectionState = 'closed';
      }
    }

    (globalThis as Record<string, unknown>).RTCPeerConnection = FakePeerConnection;

    const hub = new WebRtcHostHub({
      roomHash,
      hostPeerId: 'android-host',
      signalingClient: createMockSignaling('android-host'),
    });
    const hostReceivedTexts: string[] = [];
    const hostReceivedBinaries: ArrayBuffer[] = [];
    hub.onTextMessage((t) => hostReceivedTexts.push(t));
    hub.onBinaryMessage((b) => hostReceivedBinaries.push(b));
    await hub.start();

    const guest = new WebRtcGuestClient({
      roomHash,
      peerId: 'desktop-guest',
      signalingClient: createMockSignaling('desktop-guest'),
    });
    const guestReceivedTexts: string[] = [];
    guest.onTextMessage((t) => guestReceivedTexts.push(t));
    await guest.connect();

    expect(guest.isOpen()).toBe(true);
    expect(hub.getConnectedGuestCount()).toBe(1);

    // Guest sends JOIN_REQUEST -> received by Host with authoritative seq
    guest.sendText(
      JSON.stringify({
        type: 'JOIN_REQUEST',
        senderId: 'desktop-guest',
        peer: { id: 'desktop-guest', name: 'DesktopGuest', color: '#10b981' },
      })
    );
    expect(hostReceivedTexts).toHaveLength(1);
    expect(JSON.parse(hostReceivedTexts[0])).toMatchObject({
      type: 'JOIN_REQUEST',
      senderId: 'desktop-guest',
      seq: 1,
    });

    // Guest sends binary packet (CODE_STROKE_START) -> accepted while editor
    const strokeBin = new Uint8Array([BINARY_MAGIC_0, BINARY_MAGIC_1, 0x01, 0, 0, 0, 0, 0, 0, 0, 0]);
    guest.sendBinary(strokeBin);
    expect(hostReceivedBinaries).toHaveLength(1);

    // Host demotes guest to viewer
    hub.sendText(
      JSON.stringify({
        type: 'PEER_ROLE_UPDATE',
        senderId: 'android-host',
        targetPeerId: 'desktop-guest',
        role: 'viewer',
      })
    );

    // Viewer tries to send binary stroke -> blocked with ACCESS_DENIED (VIEWER_READONLY)
    hostReceivedBinaries.length = 0;
    guestReceivedTexts.length = 0;
    guest.sendBinary(strokeBin);
    expect(hostReceivedBinaries).toHaveLength(0);
    expect(guestReceivedTexts).toHaveLength(1);
    expect(JSON.parse(guestReceivedTexts[0])).toMatchObject({
      type: 'ACCESS_DENIED',
      code: 'VIEWER_READONLY',
    });

    guest.close();
    hub.close();
  });

  it('stamps authoritative monotonic seq on binary packets, unicasts via sendBinaryTo, and enforces layer locks', async () => {
    const roomHash = computeRoomTopicHash('INK-9002', 'ABC345');
    const signalingListeners = new Set<(env: SignalingEnvelope) => void>();
    const mockSignaling: ISignalingClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(),
      onMessage: (cb) => {
        signalingListeners.add(cb);
        return () => signalingListeners.delete(cb);
      },
      onError: () => () => {},
      close: vi.fn(),
    };

    class FakeDataChannel {
      readyState: RTCDataChannelState = 'open';
      binaryType: BinaryType = 'arraybuffer';
      bufferedAmount = 0;
      sent: ArrayBuffer[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      send(data: ArrayBuffer) {
        this.sent.push(data);
      }
      close() {
        this.readyState = 'closed';
      }
    }

    const createdPcs: Array<{
      dc: FakeDataChannel;
      ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null;
    }> = [];
    class FakePeerConnection {
      connectionState: RTCPeerConnectionState = 'connected';
      onicecandidate: ((ev: { candidate: null }) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;
      dc = new FakeDataChannel();
      constructor() {
        createdPcs.push(this);
      }
      async setRemoteDescription() {}
      async createAnswer() {
        return { type: 'answer', sdp: 'v=0\r\nanswer\r\n' };
      }
      async setLocalDescription() {}
      async addIceCandidate() {}
      close() {
        this.connectionState = 'closed';
      }
    }

    (globalThis as Record<string, unknown>).RTCPeerConnection = FakePeerConnection;

    const hub = new WebRtcHostHub({
      roomHash,
      hostPeerId: 'host-1',
      signalingClient: mockSignaling,
    });
    const hostBinaries: ArrayBuffer[] = [];
    hub.onBinaryMessage((b) => hostBinaries.push(b));
    await hub.start();

    for (const gid of ['guest-a', 'guest-b']) {
      for (const listener of signalingListeners) {
        listener({
          v: 1,
          mid: `offer-${gid}`,
          roomHash,
          type: 'offer',
          fromPeerId: gid,
          sdp: 'v=0\r\noffer\r\n',
          ts: Date.now(),
        });
      }
    }
    await new Promise((r) => setTimeout(r, 0));

    const dcA = createdPcs[0].dc;
    const dcB = createdPcs[1].dc;
    createdPcs[0].ondatachannel?.({ channel: dcA });
    createdPcs[1].ondatachannel?.({ channel: dcB });

    const sendText = (dc: FakeDataChannel, id: number, payload: object) => {
      for (const f of encodeTransportFrames('text', JSON.stringify(payload), id)) {
        dc.onmessage?.({ data: f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) });
      }
    };
    const sendBin = (dc: FakeDataChannel, id: number, bytes: Uint8Array) => {
      for (const f of encodeTransportFrames('binary', bytes, id)) {
        dc.onmessage?.({ data: f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) });
      }
    };
    const makeTileBin = (layerId: string, clientLamport: number): Uint8Array => {
      const lid = new TextEncoder().encode(layerId);
      const payloadLen = 2 + lid.length + 4;
      const pkt = new Uint8Array(11 + payloadLen);
      const v = new DataView(pkt.buffer);
      pkt[0] = 0x49;
      pkt[1] = 0x4e;
      pkt[2] = 0x04; // CODE_TILE_DELTA
      v.setUint32(3, clientLamport, true);
      v.setUint32(7, payloadLen, true);
      v.setUint16(11, lid.length, true);
      pkt.set(lid, 13);
      return pkt;
    };

    // 1. Pre-join binary tile is rejected before JOIN_REQUEST
    sendBin(dcA, 1, makeTileBin('layer-1', 50));
    expect(hostBinaries).toHaveLength(0);

    // Join both guests
    sendText(dcA, 2, { type: 'JOIN_REQUEST', peer: { id: 'guest-a', name: 'A', color: '#111' } });
    sendText(dcB, 3, { type: 'JOIN_REQUEST', peer: { id: 'guest-b', name: 'B', color: '#222' } });
    dcA.sent.length = 0;
    dcB.sent.length = 0;

    // 2. Host unicasts binary tile to guest-b only -> guest-a receives nothing, guest-b gets stamped seq
    hub.sendBinaryTo('guest-b', makeTileBin('layer-1', 999));
    expect(dcA.sent).toHaveLength(0);
    expect(dcB.sent).toHaveLength(1);
    const reB = new ChunkReassembler();
    const msgB = reB.pushFrame(dcB.sent[0]);
    expect(msgB?.kind).toBe('binary');
    const hostUnicastSeq =
      msgB?.kind === 'binary' ? new DataView(msgB.data).getUint32(3, true) : 0;
    expect(hostUnicastSeq).toBeGreaterThan(0);
    expect(hostUnicastSeq).not.toBe(999);

    // 3. Guest A sends binary tile with low Lamport (1) -> Hub stamps monotonic seq > hostUnicastSeq
    dcB.sent.length = 0;
    sendBin(dcA, 4, makeTileBin('layer-1', 1));
    expect(hostBinaries).toHaveLength(1);
    const stampedSeq = new DataView(hostBinaries[0]).getUint32(3, true);
    expect(stampedSeq).toBeGreaterThan(hostUnicastSeq);

    // 4. Host locks layer-1 to guest-a -> guest-b binary tile on layer-1 is rejected with LAYER_LOCKED
    hub.sendText(
      JSON.stringify({
        type: 'LAYER_UPDATE',
        layerId: 'layer-1',
        patch: { reservedByPeerId: 'guest-a' },
      })
    );
    hostBinaries.length = 0;
    dcB.sent.length = 0;
    sendBin(dcB, 5, makeTileBin('layer-1', 100));
    expect(hostBinaries).toHaveLength(0);
    expect(dcB.sent.length).toBeGreaterThan(0);
    const denied = new ChunkReassembler().pushFrame(dcB.sent[0]);
    expect(denied?.kind).toBe('text');
    if (denied?.kind === 'text') {
      expect(JSON.parse(denied.text).code).toBe('LAYER_LOCKED');
    }

    hub.close();
  });
});
