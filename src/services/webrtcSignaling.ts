/**
 * Zero-Cost Pluggable WebRTC Signaling Client.
 *
 * Exchanges ONLY small SDP offer/answer and ICE candidate envelopes (zero drawing traffic).
 * Every room channel is scoped and authenticated by a SHA-256 hash of
 * `"inkstudio-p2p-v1:" + roomCode + ":" + roomSecret` so unrelated peers cannot hijack a room.
 */

export type SignalingMessageType = 'offer' | 'answer' | 'ice' | 'room-full' | 'bye';

export interface SignalingEnvelope {
  v: 1;
  type: SignalingMessageType;
  roomHash: string;
  mid: string;
  fromPeerId: string;
  toPeerId?: string;
  sdp?: string;
  sdpType?: 'offer' | 'answer';
  candidate?: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
  };
  reason?: string;
  ts: number;
}

export interface P2pRoomCredentials {
  roomCode: string; // e.g. "INK-7429"
  roomSecret: string; // e.g. "K8P2M9"
  joinCode: string; // e.g. "INK-7429-K8P2M9"
  roomHash: string; // 64-char SHA-256 hex
}

export interface ISignalingClient {
  connect(): Promise<void>;
  send(msg: Omit<SignalingEnvelope, 'v' | 'roomHash' | 'mid' | 'ts'>): void;
  onMessage(handler: (msg: SignalingEnvelope) => void): () => void;
  onError(handler: (err: Error) => void): () => void;
  close(): void;
}

export interface SignalingClientOptions {
  roomHash: string;
  peerId: string;
  customSignalingUrl?: string;
  relayUrls?: string[];
  connectTimeoutMs?: number;
}

export const DEFAULT_PUBLIC_SIGNALING_RELAYS: readonly string[] = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

const MAX_SIGNALING_JSON_CHARS = 64 * 1024;
const MAX_SDP_CHARS = 48 * 1024;
const MAX_CANDIDATE_CHARS = 4 * 1024;
const MAX_PEER_ID_CHARS = 128;
const ALLOWED_SIGNALING_TYPES = new Set<SignalingMessageType>([
  'offer',
  'answer',
  'ice',
  'room-full',
  'bye',
]);

const SECRET_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < length; i++) {
      out[i] = Math.floor(Math.random() * 256);
    }
  }
  return out;
}

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function normalizeRoomSecret(raw: string | undefined): string {
  return (raw || '').trim().toUpperCase();
}

/**
 * Pure TypeScript synchronous SHA-256 returning 64-char lowercase hex.
 * Works identically in Tauri WebView, insecure HTTP LAN dev origins, and Node/Vitest.
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256HexSync(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const hiBits = Math.floor(bitLen / 0x100000000);
  const loBits = bitLen >>> 0;
  view.setUint32(paddedLen - 8, hiBits, false);
  view.setUint32(paddedLen - 4, loBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 =
        ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
        ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^
        (w[i - 15] >>> 3);
      const s1 =
        ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
        ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^
        (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((n) => n.toString(16).padStart(8, '0'))
    .join('');
}

export function computeRoomTopicHash(roomCode: string, roomSecret: string = ''): string {
  const normalizedCode = normalizeRoomCode(roomCode);
  const normalizedSecret = normalizeRoomSecret(roomSecret);
  return sha256HexSync(`inkstudio-p2p-v1:${normalizedCode}:${normalizedSecret}`);
}

export function generateP2pRoomCredentials(): P2pRoomCredentials {
  const rb = randomBytes(10);
  // 4-digit human-friendly code: INK-1000 .. INK-9999
  const num = 1000 + (((rb[0] << 8) | rb[1]) % 9000);
  const roomCode = `INK-${num}`;
  // 6-char unambiguous room secret
  let roomSecret = '';
  for (let i = 0; i < 6; i++) {
    roomSecret += SECRET_ALPHABET[rb[2 + i] % SECRET_ALPHABET.length];
  }
  const joinCode = `${roomCode}-${roomSecret}`;
  const roomHash = computeRoomTopicHash(roomCode, roomSecret);
  return { roomCode, roomSecret, joinCode, roomHash };
}

function constantTimeStrEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Strictly validates an untrusted signaling JSON payload against the expected roomHash.
 * Drops malformed, oversized, or cross-room payloads.
 */
export function validateSignalingMessage(
  raw: unknown,
  expectedRoomHash: string
): SignalingEnvelope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  if (obj.v !== 1) return null;
  if (typeof obj.type !== 'string' || !ALLOWED_SIGNALING_TYPES.has(obj.type as SignalingMessageType)) {
    return null;
  }
  if (
    typeof obj.roomHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(obj.roomHash) ||
    !constantTimeStrEqual(obj.roomHash, expectedRoomHash)
  ) {
    return null;
  }
  if (
    typeof obj.fromPeerId !== 'string' ||
    obj.fromPeerId.trim().length === 0 ||
    obj.fromPeerId.length > MAX_PEER_ID_CHARS
  ) {
    return null;
  }
  if (
    obj.toPeerId !== undefined &&
    (typeof obj.toPeerId !== 'string' || obj.toPeerId.length > MAX_PEER_ID_CHARS)
  ) {
    return null;
  }
  if (typeof obj.mid !== 'string' || obj.mid.length === 0 || obj.mid.length > 64) {
    return null;
  }
  if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) {
    return null;
  }

  const type = obj.type as SignalingMessageType;
  const out: SignalingEnvelope = {
    v: 1,
    type,
    roomHash: obj.roomHash,
    mid: obj.mid,
    fromPeerId: obj.fromPeerId,
    ...(obj.toPeerId ? { toPeerId: obj.toPeerId } : {}),
    ts: obj.ts,
  };

  if (type === 'offer' || type === 'answer') {
    if (
      typeof obj.sdp !== 'string' ||
      obj.sdp.length === 0 ||
      obj.sdp.length > MAX_SDP_CHARS
    ) {
      return null;
    }
    out.sdp = obj.sdp;
    out.sdpType = type;
  } else if (type === 'ice') {
    if (!obj.candidate || typeof obj.candidate !== 'object' || Array.isArray(obj.candidate)) {
      return null;
    }
    const cand = obj.candidate as Record<string, unknown>;
    if (typeof cand.candidate !== 'string' || cand.candidate.length > MAX_CANDIDATE_CHARS) {
      return null;
    }
    out.candidate = {
      candidate: cand.candidate,
      sdpMid: typeof cand.sdpMid === 'string' || cand.sdpMid === null ? cand.sdpMid : undefined,
      sdpMLineIndex:
        typeof cand.sdpMLineIndex === 'number' || cand.sdpMLineIndex === null
          ? cand.sdpMLineIndex
          : undefined,
      usernameFragment:
        typeof cand.usernameFragment === 'string' || cand.usernameFragment === null
          ? cand.usernameFragment
          : undefined,
    };
  } else if (type === 'room-full' || type === 'bye') {
    if (typeof obj.reason === 'string') {
      out.reason = obj.reason.slice(0, 200);
    }
  }

  return out;
}

function makeMessageId(): string {
  const b = randomBytes(6);
  let hex = '';
  for (let i = 0; i < b.length; i++) {
    hex += b[i].toString(16).padStart(2, '0');
  }
  return `${Date.now().toString(36)}-${hex}`;
}

// --- Minimal dependency-free MQTT v3.1.1 over WebSocket codec (QoS 0 pub/sub) ---

const mqttEncoder = new TextEncoder();
const mqttDecoder = new TextDecoder();

function encodeMqttRemainingLength(len: number): number[] {
  const out: number[] = [];
  let x = len;
  do {
    let encodedByte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) encodedByte |= 0x80;
    out.push(encodedByte);
  } while (x > 0);
  return out;
}

function encodeMqttString(str: string): Uint8Array {
  const utf8 = mqttEncoder.encode(str);
  const out = new Uint8Array(2 + utf8.length);
  out[0] = (utf8.length >>> 8) & 0xff;
  out[1] = utf8.length & 0xff;
  out.set(utf8, 2);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function encodeMqttConnect(clientId: string, keepAliveSec = 30): Uint8Array {
  const protoName = encodeMqttString('MQTT');
  const varHeader = concatBytes([
    protoName,
    new Uint8Array([0x04, 0x02, (keepAliveSec >>> 8) & 0xff, keepAliveSec & 0xff]),
  ]);
  const payload = encodeMqttString(clientId);
  const remLen = encodeMqttRemainingLength(varHeader.length + payload.length);
  return concatBytes([new Uint8Array([0x10, ...remLen]), varHeader, payload]);
}

export function encodeMqttSubscribe(packetId: number, topic: string): Uint8Array {
  const topicBytes = encodeMqttString(topic);
  const body = concatBytes([
    new Uint8Array([(packetId >>> 8) & 0xff, packetId & 0xff]),
    topicBytes,
    new Uint8Array([0x00]), // QoS 0
  ]);
  const remLen = encodeMqttRemainingLength(body.length);
  return concatBytes([new Uint8Array([0x82, ...remLen]), body]);
}

export function encodeMqttPublish(topic: string, textPayload: string): Uint8Array {
  const topicBytes = encodeMqttString(topic);
  const payloadBytes = mqttEncoder.encode(textPayload);
  const remLen = encodeMqttRemainingLength(topicBytes.length + payloadBytes.length);
  return concatBytes([new Uint8Array([0x30, ...remLen]), topicBytes, payloadBytes]);
}

export function decodeMqttPackets(
  buf: Uint8Array
): Array<{ packetType: number; topic?: string; payload?: string }> {
  const results: Array<{ packetType: number; topic?: string; payload?: string }> = [];
  let offset = 0;

  while (offset + 2 <= buf.length) {
    const headerByte = buf[offset];
    const packetType = (headerByte >>> 4) & 0x0f;
    const qos = (headerByte >>> 1) & 0x03;

    let multiplier = 1;
    let remLen = 0;
    let idx = offset + 1;
    let digit = 0;
    let validVarInt = false;

    while (idx < buf.length && multiplier <= 128 * 128 * 128) {
      digit = buf[idx++];
      remLen += (digit & 0x7f) * multiplier;
      if ((digit & 0x80) === 0) {
        validVarInt = true;
        break;
      }
      multiplier *= 128;
    }
    if (!validVarInt || idx + remLen > buf.length) break;

    const packetEnd = idx + remLen;
    if (packetType === 3) {
      // PUBLISH
      if (idx + 2 <= packetEnd) {
        const topicLen = (buf[idx] << 8) | buf[idx + 1];
        idx += 2;
        if (idx + topicLen <= packetEnd) {
          const topic = mqttDecoder.decode(buf.subarray(idx, idx + topicLen));
          idx += topicLen;
          if (qos > 0) idx += 2; // skip packetId for QoS 1/2
          if (idx <= packetEnd) {
            const payload = mqttDecoder.decode(buf.subarray(idx, packetEnd));
            results.push({ packetType, topic, payload });
          }
        }
      }
    } else {
      results.push({ packetType });
    }

    offset = packetEnd;
  }

  return results;
}

/**
 * Default zero-setup public multi-relay WSS signaling adapter.
 * Connects to free public MQTT-over-WSS brokers in parallel for automatic failover
 * and deduplicates envelopes by `mid`.
 */
export class PublicMultiRelaySignalingClient implements ISignalingClient {
  private readonly roomHash: string;
  private readonly peerId: string;
  private readonly relayUrls: readonly string[];
  private readonly connectTimeoutMs: number;
  private readonly topic: string;

  private sockets = new Map<string, WebSocket>();
  private readyRelays = new Set<string>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectAttempts = new Map<string, number>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private messageHandlers = new Set<(msg: SignalingEnvelope) => void>();
  private errorHandlers = new Set<(err: Error) => void>();
  private seenMids = new Set<string>();
  private pendingOutgoing: string[] = [];
  private hasEverConnected = false;
  private closed = false;

  constructor(options: SignalingClientOptions) {
    this.roomHash = options.roomHash;
    this.peerId = options.peerId;
    this.relayUrls =
      options.relayUrls && options.relayUrls.length > 0
        ? options.relayUrls
        : DEFAULT_PUBLIC_SIGNALING_RELAYS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 12_000;
    this.topic = `inkstudio/sig/v1/${this.roomHash}`;
  }

  private scheduleRelayReconnect(relayUrl: string): void {
    if (this.closed || !this.hasEverConnected) return;
    if (this.reconnectTimers.has(relayUrl) || this.sockets.has(relayUrl)) return;

    const attempt = (this.reconnectAttempts.get(relayUrl) ?? 0) + 1;
    this.reconnectAttempts.set(relayUrl, attempt);
    const delayMs = Math.min(30_000, 2_000 * Math.pow(2, Math.min(attempt - 1, 4)));

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(relayUrl);
      if (this.closed) return;
      this.openRelaySocket(relayUrl);
    }, delayMs);
    this.reconnectTimers.set(relayUrl, timer);
  }

  private openRelaySocket(
    relayUrl: string,
    onInitialReady?: (url: string) => void,
    onInitialFailed?: (url: string) => void
  ): void {
    if (this.closed) return;
    const prevTimer = this.reconnectTimers.get(relayUrl);
    if (prevTimer) {
      clearTimeout(prevTimer);
      this.reconnectTimers.delete(relayUrl);
    }

    try {
      const ws = new WebSocket(relayUrl, 'mqtt');
      ws.binaryType = 'arraybuffer';
      this.sockets.set(relayUrl, ws);

      ws.onopen = () => {
        if (this.closed) {
          ws.close();
          return;
        }
        const clientId = `ink-${this.peerId.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}-${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        ws.send(encodeMqttConnect(clientId, 30) as unknown as ArrayBuffer);
      };

      ws.onmessage = async (ev) => {
        if (this.closed) return;
        try {
          const rawBuf =
            ev.data instanceof ArrayBuffer
              ? new Uint8Array(ev.data)
              : ev.data instanceof Blob
                ? new Uint8Array(await ev.data.arrayBuffer())
                : null;
          if (!rawBuf) return;

          const packets = decodeMqttPackets(rawBuf);
          for (const pkt of packets) {
            if (pkt.packetType === 2) {
              // CONNACK -> subscribe to roomHash topic
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(encodeMqttSubscribe(1, this.topic) as unknown as ArrayBuffer);
              }
            } else if (pkt.packetType === 9) {
              // SUBACK -> relay ready
              this.reconnectAttempts.delete(relayUrl);
              this.readyRelays.add(relayUrl);
              this.flushPending();
              onInitialReady?.(relayUrl);
            } else if (pkt.packetType === 3 && pkt.topic === this.topic && pkt.payload) {
              this.handleIncomingPayload(pkt.payload);
            }
          }
        } catch {
          // ignore malformed relay frames
        }
      };

      ws.onerror = () => {
        if (!this.readyRelays.has(relayUrl)) {
          onInitialFailed?.(relayUrl);
        }
      };

      ws.onclose = () => {
        const wasCurrent = this.sockets.get(relayUrl) === ws;
        if (wasCurrent) {
          this.readyRelays.delete(relayUrl);
          this.sockets.delete(relayUrl);
        }
        onInitialFailed?.(relayUrl);
        if (!this.closed && this.hasEverConnected) {
          this.scheduleRelayReconnect(relayUrl);
        }
      };
    } catch {
      onInitialFailed?.(relayUrl);
      if (!this.closed && this.hasEverConnected) {
        this.scheduleRelayReconnect(relayUrl);
      }
    }
  }

  public connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Signaling client already closed'));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const failedRelays = new Set<string>();

      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(
            new Error(
              'Could not reach public WebRTC signaling relays. Check your internet connection or configure a custom signaling Worker URL.'
            )
          );
        }
      }, this.connectTimeoutMs);

      const markReady = (relayUrl: string) => {
        this.hasEverConnected = true;
        this.readyRelays.add(relayUrl);
        this.flushPending();
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          this.startKeepAlive();
          resolve();
        }
      };

      const markFailed = (relayUrl: string) => {
        if (settled) return;
        failedRelays.add(relayUrl);
        if (failedRelays.size >= this.relayUrls.length) {
          settled = true;
          clearTimeout(timeoutId);
          reject(new Error('All public WebRTC signaling relays failed to connect.'));
        }
      };

      for (const relayUrl of this.relayUrls) {
        this.openRelaySocket(relayUrl, markReady, markFailed);
      }
    });
  }

  private startKeepAlive(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      const ping = new Uint8Array([0xc0, 0x00]);
      for (const [url, ws] of this.sockets.entries()) {
        if (this.readyRelays.has(url) && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(ping as unknown as ArrayBuffer);
          } catch {
            // ignore
          }
        }
      }
    }, 20_000);
  }

  private flushPending(): void {
    if (this.pendingOutgoing.length === 0 || this.readyRelays.size === 0) return;
    const queued = this.pendingOutgoing.splice(0, this.pendingOutgoing.length);
    for (const json of queued) {
      this.publishRaw(json);
    }
  }

  private publishRaw(json: string): void {
    const packet = encodeMqttPublish(this.topic, json);
    for (const [url, ws] of this.sockets.entries()) {
      if (this.readyRelays.has(url) && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(packet as unknown as ArrayBuffer);
        } catch {
          // ignore single relay failure
        }
      }
    }
  }

  private handleIncomingPayload(rawText: string): void {
    if (rawText.length > MAX_SIGNALING_JSON_CHARS) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return;
    }
    const env = validateSignalingMessage(parsed, this.roomHash);
    if (!env) return;
    if (env.fromPeerId === this.peerId) return;
    if (env.toPeerId && env.toPeerId !== this.peerId) return;
    if (this.seenMids.has(env.mid)) return;

    this.seenMids.add(env.mid);
    if (this.seenMids.size > 512) {
      const oldest = this.seenMids.values().next().value;
      if (oldest !== undefined) this.seenMids.delete(oldest);
    }

    this.messageHandlers.forEach((h) => h(env));
  }

  public send(msg: Omit<SignalingEnvelope, 'v' | 'roomHash' | 'mid' | 'ts'>): void {
    if (this.closed) return;
    const full: SignalingEnvelope = {
      ...msg,
      v: 1,
      roomHash: this.roomHash,
      mid: makeMessageId(),
      ts: Date.now(),
    };
    const json = JSON.stringify(full);
    if (json.length > MAX_SIGNALING_JSON_CHARS) return;
    if (this.readyRelays.size === 0) {
      if (this.pendingOutgoing.length < 64) {
        this.pendingOutgoing.push(json);
      }
      return;
    }
    this.publishRaw(json);
  }

  public onMessage(handler: (msg: SignalingEnvelope) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  public onError(handler: (err: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  public close(): void {
    this.closed = true;
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const ws of this.sockets.values()) {
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();
    this.readyRelays.clear();
    this.pendingOutgoing = [];
  }
}

/**
 * Custom Cloudflare Worker WebSocket signaling adapter.
 * Connects to `wss://<worker-domain>/signal?roomHash=<64-hex>&peerId=<peerId>`
 * matching `docs/cloudflare-signaling-worker.js`.
 */
export class CustomWorkerSignalingClient implements ISignalingClient {
  private readonly roomHash: string;
  private readonly peerId: string;
  private readonly workerUrl: string;
  private readonly connectTimeoutMs: number;
  private ws: WebSocket | null = null;
  private messageHandlers = new Set<(msg: SignalingEnvelope) => void>();
  private errorHandlers = new Set<(err: Error) => void>();
  private closed = false;

  constructor(options: SignalingClientOptions & { customSignalingUrl: string }) {
    this.roomHash = options.roomHash;
    this.peerId = options.peerId;
    this.workerUrl = options.customSignalingUrl.trim();
    this.connectTimeoutMs = options.connectTimeoutMs ?? 12_000;
  }

  public connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Signaling client already closed'));
    }

    let finalUrl: string;
    try {
      const parsed = new URL(this.workerUrl);
      if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
        return Promise.reject(new Error('Custom signaling URL must use wss:// or https://'));
      }
      parsed.searchParams.set('roomHash', this.roomHash);
      parsed.searchParams.set('peerId', this.peerId);
      finalUrl = parsed.toString();
    } catch {
      return Promise.reject(new Error('Invalid custom signaling Worker URL'));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.ws?.close();
          reject(new Error('Timed out connecting to custom signaling server'));
        }
      }, this.connectTimeoutMs);

      try {
        const ws = new WebSocket(finalUrl);
        this.ws = ws;

        ws.onopen = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            resolve();
          }
        };

        ws.onmessage = (ev) => {
          if (this.closed || typeof ev.data !== 'string') return;
          if (ev.data.length > MAX_SIGNALING_JSON_CHARS) return;
          try {
            const raw = JSON.parse(ev.data) as unknown;
            const env = validateSignalingMessage(raw, this.roomHash);
            if (!env) return;
            if (env.fromPeerId === this.peerId) return;
            if (env.toPeerId && env.toPeerId !== this.peerId) return;
            this.messageHandlers.forEach((h) => h(env));
          } catch {
            // ignore
          }
        };

        ws.onerror = () => {
          const err = new Error('Custom signaling server connection error');
          this.errorHandlers.forEach((h) => h(err));
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            reject(err);
          }
        };

        ws.onclose = () => {
          if (this.ws === ws) this.ws = null;
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            reject(new Error('Custom signaling server closed before ready'));
          }
        };
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        reject(err instanceof Error ? err : new Error('Failed to open signaling WebSocket'));
      }
    });
  }

  public send(msg: Omit<SignalingEnvelope, 'v' | 'roomHash' | 'mid' | 'ts'>): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const full: SignalingEnvelope = {
      ...msg,
      v: 1,
      roomHash: this.roomHash,
      mid: makeMessageId(),
      ts: Date.now(),
    };
    const json = JSON.stringify(full);
    if (json.length > MAX_SIGNALING_JSON_CHARS) return;
    this.ws.send(json);
  }

  public onMessage(handler: (msg: SignalingEnvelope) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  public onError(handler: (err: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  public close(): void {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}

export function createSignalingClient(options: SignalingClientOptions): ISignalingClient {
  const customUrl = (options.customSignalingUrl || '').trim();
  if (customUrl) {
    return new CustomWorkerSignalingClient({ ...options, customSignalingUrl: customUrl });
  }
  return new PublicMultiRelaySignalingClient(options);
}
