import { CollabRole } from '../types/multiplayer';
import {
  ChunkReassembler,
  ICollabTransport,
  sendFramedOverDataChannel,
  toUint8Array,
} from './collabTransport';
import {
  createSignalingClient,
  ISignalingClient,
  SignalingEnvelope,
} from './webrtcSignaling';

export const WEBRTC_DATACHANNEL_LABEL = 'inkstudio-collab';
export const MAX_WEBRTC_PEERS = 8;

export const DEFAULT_WEBRTC_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export interface WebRtcTurnConfig {
  turnUrl?: string;
  turnUsername?: string;
  turnCredential?: string;
}

export function buildIceServers(turn?: WebRtcTurnConfig): RTCIceServer[] {
  const servers: RTCIceServer[] = DEFAULT_WEBRTC_ICE_SERVERS.map((s) => ({ ...s }));
  const url = (turn?.turnUrl || '').trim();
  if (url && /^(turns?:)/i.test(url)) {
    const entry: RTCIceServer = { urls: url };
    if (turn?.turnUsername?.trim()) entry.username = turn.turnUsername.trim();
    if (turn?.turnCredential?.trim()) entry.credential = turn.turnCredential.trim();
    servers.push(entry);
  }
  return servers;
}

const BINARY_MAGIC_0 = 0x49; // 'I'
const BINARY_MAGIC_1 = 0x4e; // 'N'
const CODE_STROKE_START = 0x01;
const CODE_STROKE_FINISH = 0x03;
const CODE_TILE_DELTA = 0x04;
const CODE_CURSOR_MOVE = 0x05;
const CODE_BRUSH_ASSET_REQUEST = 0x08;
const CODE_LAYER_MASK_DATA = 0x09;

const DISCONNECTED_GRACE_MS = 5_000;
const sharedTextDecoder = new TextDecoder();

interface LayerLockMeta {
  ownerPeerId?: string;
  reservedByPeerId?: string;
}

type SignalingIceCandidate = NonNullable<SignalingEnvelope['candidate']>;

const VIEWER_ALLOWED_JSON_TYPES = new Set<string>([
  'JOIN_REQUEST',
  'DOC_SYNC_REQUEST',
  'CURSOR_MOVE',
  'CANVAS_PING',
  'BRUSH_ASSET_REQUEST',
  'PEER_LEFT',
]);

const HOST_ONLY_MODERATION_TYPES = new Set<string>([
  'PEER_ROLE_UPDATE',
  'PEER_KICK',
  'PEER_BAN',
  'PEER_UNBAN',
]);

const HOST_ONLY_CONSUME_TYPES = new Set<string>(['JOIN_REQUEST', 'DOC_SYNC_REQUEST']);

const UNICAST_FROM_HOST_TYPES = new Set<string>([
  'JOIN_ACCEPTED',
  'DOC_SYNC_RESPONSE',
  'ACCESS_DENIED',
  'BRUSH_ASSET_REQUEST',
]);

interface GuestConnection {
  signalingPeerId: string;
  appPeerId: string | null;
  joined: boolean;
  role: Exclude<CollabRole, 'host'>;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  reassembler: ChunkReassembler;
  remoteDescSet: boolean;
  pendingIce: RTCIceCandidateInit[];
  localIceCandidates: SignalingIceCandidate[];
  lastAnswerSdp: string | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

export interface WebRtcHostHubOptions {
  roomHash: string;
  hostPeerId: string;
  turnConfig?: WebRtcTurnConfig;
  customSignalingUrl?: string;
  signalingClient?: ISignalingClient;
  maxPeers?: number;
}

/**
 * Authoritative Star-Topology WebRTC Host Hub.
 *
 * The Host tablet/browser accepts up to 8 concurrent RTCDataChannel guest connections,
 * enforces Host / Editor / Viewer roles, relays live strokes/tiles/layers/cursors across peers,
 * and plugs directly into `multiplayerService` via `ICollabTransport`.
 */
export class WebRtcHostHub implements ICollabTransport {
  public readonly kind = 'webrtc-host' as const;

  public readonly roomHash: string;
  private readonly hostPeerId: string;
  private readonly iceServers: RTCIceServer[];
  private readonly maxPeers: number;
  private readonly signaling: ISignalingClient;

  private guests = new Map<string, GuestConnection>();
  private layerLocks = new Map<string, LayerLockMeta>();
  private textHandlers = new Set<(text: string) => void>();
  private binaryHandlers = new Set<(data: ArrayBuffer) => void>();
  private closeHandlers = new Set<(reason?: string) => void>();
  private errorHandlers = new Set<(err: Error | Event) => void>();

  private unsubSignaling: (() => void) | null = null;
  private nextMsgId = 1;
  private seq = 0;
  private open = false;
  private closed = false;

  constructor(options: WebRtcHostHubOptions) {
    this.roomHash = options.roomHash;
    this.hostPeerId = options.hostPeerId;
    this.iceServers = buildIceServers(options.turnConfig);
    this.maxPeers = Math.max(1, Math.min(MAX_WEBRTC_PEERS, options.maxPeers ?? MAX_WEBRTC_PEERS));
    this.signaling =
      options.signalingClient ??
      createSignalingClient({
        roomHash: options.roomHash,
        peerId: options.hostPeerId,
        customSignalingUrl: options.customSignalingUrl,
      });
  }

  public async start(): Promise<void> {
    if (this.closed) {
      throw new Error('WebRTC Host Hub has already been closed');
    }
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('WebRTC is not supported in this browser/WebView');
    }

    this.unsubSignaling = this.signaling.onMessage((env) => {
      void this.handleSignalingEnvelope(env);
    });

    await this.signaling.connect();
    this.open = true;
  }

  public isOpen(): boolean {
    return this.open && !this.closed;
  }

  public getConnectedGuestCount(): number {
    let count = 0;
    for (const g of this.guests.values()) {
      if (!g.closed && g.dc?.readyState === 'open') count += 1;
    }
    return count;
  }

  public getBufferedAmount(): number {
    let maxBuffered = 0;
    for (const g of this.guests.values()) {
      if (g.dc && g.dc.readyState === 'open') {
        maxBuffered = Math.max(maxBuffered, g.dc.bufferedAmount || 0);
      }
    }
    return maxBuffered;
  }

  private allocMessageId = (): number => {
    this.nextMsgId = (this.nextMsgId + 1) >>> 0;
    if (this.nextMsgId === 0) this.nextMsgId = 1;
    return this.nextMsgId;
  };

  private findGuestByAppOrSignalingId(peerId: string | number | undefined): GuestConnection | null {
    if (peerId === undefined || peerId === null) return null;
    const target = String(peerId);
    for (const guest of this.guests.values()) {
      if (guest.appPeerId === target || guest.signalingPeerId === target) {
        return guest;
      }
    }
    return null;
  }

  private sendTextToGuest(guest: GuestConnection, text: string): void {
    if (guest.closed || !guest.dc || guest.dc.readyState !== 'open') return;
    try {
      sendFramedOverDataChannel(guest.dc, 'text', text, this.allocMessageId);
    } catch {
      // ignore send failure on closing channel
    }
  }

  private sendBinaryToGuest(guest: GuestConnection, data: ArrayBuffer | Uint8Array): void {
    if (guest.closed || !guest.dc || guest.dc.readyState !== 'open') return;
    try {
      sendFramedOverDataChannel(guest.dc, 'binary', data, this.allocMessageId);
    } catch {
      // ignore send failure on closing channel
    }
  }

  private sendAccessDeniedToGuest(
    guest: GuestConnection,
    code: 'VIEWER_READONLY' | 'FORBIDDEN' | 'LAYER_LOCKED' | 'NOT_OWNER',
    reason: string
  ): void {
    const payload = JSON.stringify({
      type: 'ACCESS_DENIED',
      senderId: this.hostPeerId,
      targetPeerId: guest.appPeerId || guest.signalingPeerId,
      code,
      reason,
    });
    this.sendTextToGuest(guest, payload);
  }

  private stampBinarySeq(data: ArrayBuffer | Uint8Array): Uint8Array {
    const src = toUint8Array(data);
    const out = new Uint8Array(src.byteLength);
    out.set(src);
    if (out.byteLength >= 11 && out[0] === BINARY_MAGIC_0 && out[1] === BINARY_MAGIC_1) {
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      view.setUint32(3, ++this.seq, true);
    }
    return out;
  }

  private syncLayerLocksFromWireList(layersRaw: unknown): void {
    if (!Array.isArray(layersRaw)) return;
    const next = new Map<string, LayerLockMeta>();
    for (const item of layersRaw) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.id !== 'string' || !obj.id) continue;
      const ownerPeerId =
        obj.ownerPeerId !== undefined && obj.ownerPeerId !== null && obj.ownerPeerId !== ''
          ? String(obj.ownerPeerId)
          : undefined;
      const reservedByPeerId =
        obj.reservedByPeerId !== undefined &&
        obj.reservedByPeerId !== null &&
        obj.reservedByPeerId !== ''
          ? String(obj.reservedByPeerId)
          : undefined;
      next.set(obj.id, { ownerPeerId, reservedByPeerId });
    }
    this.layerLocks = next;
  }

  private applyLayerLockMutation(parsed: Record<string, unknown>): void {
    const type = typeof parsed.type === 'string' ? parsed.type : '';
    if (type === 'DOC_SYNC_RESPONSE' || type === 'LAYER_TREE_SYNC') {
      this.syncLayerLocksFromWireList(parsed.layers);
      return;
    }
    if (type === 'LAYER_ADD' && parsed.layerItem && typeof parsed.layerItem === 'object') {
      const item = parsed.layerItem as Record<string, unknown>;
      if (typeof item.id === 'string' && item.id) {
        this.layerLocks.set(item.id, {
          ownerPeerId:
            item.ownerPeerId !== undefined && item.ownerPeerId !== null && item.ownerPeerId !== ''
              ? String(item.ownerPeerId)
              : undefined,
          reservedByPeerId:
            item.reservedByPeerId !== undefined &&
            item.reservedByPeerId !== null &&
            item.reservedByPeerId !== ''
              ? String(item.reservedByPeerId)
              : undefined,
        });
      }
      return;
    }
    if (type === 'LAYER_DELETE' && typeof parsed.layerId === 'string') {
      this.layerLocks.delete(parsed.layerId);
      return;
    }
    if (type === 'LAYER_UPDATE' && typeof parsed.layerId === 'string') {
      const existing = this.layerLocks.get(parsed.layerId) || {};
      const next: LayerLockMeta = { ...existing };
      const patch =
        parsed.patch && typeof parsed.patch === 'object'
          ? (parsed.patch as Record<string, unknown>)
          : null;
      const cleared = Array.isArray(parsed.clearedFields) ? parsed.clearedFields : [];
      if (patch) {
        if (patch.ownerPeerId !== undefined && patch.ownerPeerId !== null && patch.ownerPeerId !== '') {
          next.ownerPeerId = String(patch.ownerPeerId);
        }
        if (
          patch.reservedByPeerId !== undefined &&
          patch.reservedByPeerId !== null &&
          patch.reservedByPeerId !== ''
        ) {
          next.reservedByPeerId = String(patch.reservedByPeerId);
        }
      }
      if (cleared.includes('ownerPeerId')) delete next.ownerPeerId;
      if (cleared.includes('reservedByPeerId')) delete next.reservedByPeerId;
      this.layerLocks.set(parsed.layerId, next);
      return;
    }
    if (type === 'PEER_BAN' && parsed.targetPeerId !== undefined && parsed.targetPeerId !== null) {
      const bannedId = String(parsed.targetPeerId);
      for (const meta of this.layerLocks.values()) {
        if (meta.reservedByPeerId === bannedId) {
          delete meta.reservedByPeerId;
        }
      }
    }
  }

  private isLayerLockedForGuest(layerId: string, guestPeerId: string): boolean {
    const meta = this.layerLocks.get(layerId);
    return Boolean(meta?.reservedByPeerId && meta.reservedByPeerId !== guestPeerId);
  }

  private extractBinaryLayerId(bytes: Uint8Array, opcode: number): string | null {
    if (bytes.byteLength < 11) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const payloadLen = view.getUint32(7, true);
    if (11 + payloadLen > bytes.byteLength) return null;

    if (opcode === CODE_TILE_DELTA || opcode === CODE_LAYER_MASK_DATA) {
      if (payloadLen < 2) return null;
      const layerIdLen = view.getUint16(11, true);
      if (layerIdLen === 0 || layerIdLen > 256 || 13 + layerIdLen > 11 + payloadLen) return null;
      return sharedTextDecoder.decode(bytes.subarray(13, 13 + layerIdLen));
    }

    if (opcode === CODE_STROKE_START || opcode === CODE_STROKE_FINISH) {
      try {
        const jsonStr = sharedTextDecoder.decode(bytes.subarray(11, 11 + payloadLen));
        const parsed = JSON.parse(jsonStr) as { layerId?: unknown };
        return typeof parsed?.layerId === 'string' ? parsed.layerId : null;
      } catch {
        return null;
      }
    }

    return null;
  }

  private broadcastText(text: string, excludeSignalingId?: string): void {
    for (const guest of this.guests.values()) {
      if (excludeSignalingId && guest.signalingPeerId === excludeSignalingId) continue;
      this.sendTextToGuest(guest, text);
    }
  }

  private broadcastBinary(data: ArrayBuffer | Uint8Array, excludeSignalingId?: string): void {
    for (const guest of this.guests.values()) {
      if (excludeSignalingId && guest.signalingPeerId === excludeSignalingId) continue;
      this.sendBinaryToGuest(guest, data);
    }
  }

  public sendText(text: string): void {
    if (!this.isOpen()) return;

    let parsed: Record<string, unknown> | null = null;
    try {
      const raw = JSON.parse(text) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        parsed = raw as Record<string, unknown>;
      }
    } catch {
      // send raw
    }

    if (parsed) {
      const type = typeof parsed.type === 'string' ? parsed.type : '';
      const targetPeerId =
        typeof parsed.targetPeerId === 'string' || typeof parsed.targetPeerId === 'number'
          ? String(parsed.targetPeerId)
          : undefined;

      // Stateful Rust server seed is unnecessary in P2P host hub (Host is already live)
      if (targetPeerId === '__server__') {
        return;
      }

      if (type === 'PEER_ROLE_UPDATE' && targetPeerId) {
        const guest = this.findGuestByAppOrSignalingId(targetPeerId);
        if (guest) {
          guest.role = parsed.role === 'viewer' ? 'viewer' : 'editor';
        }
      } else if (type === 'JOIN_ACCEPTED' && targetPeerId) {
        const guest = this.findGuestByAppOrSignalingId(targetPeerId);
        if (guest && (parsed.assignedRole === 'viewer' || parsed.assignedRole === 'editor')) {
          guest.role = parsed.assignedRole;
        }
      }

      this.applyLayerLockMutation(parsed);

      const sequenced =
        typeof parsed.seq === 'number'
          ? text
          : JSON.stringify({ ...parsed, seq: ++this.seq });

      if (
        type === 'PEER_KICK' ||
        type === 'PEER_BAN' ||
        (type === 'ACCESS_DENIED' && (parsed.code === 'BANNED' || parsed.code === 'KICKED'))
      ) {
        const guest = this.findGuestByAppOrSignalingId(targetPeerId);
        if (type === 'ACCESS_DENIED') {
          if (guest) this.sendTextToGuest(guest, sequenced);
        } else {
          this.broadcastText(sequenced);
        }
        if (guest) {
          setTimeout(() => this.removeGuest(guest.signalingPeerId, false), 80);
        }
        return;
      }

      if (targetPeerId && UNICAST_FROM_HOST_TYPES.has(type)) {
        const targetGuest = this.findGuestByAppOrSignalingId(targetPeerId);
        if (targetGuest) {
          this.sendTextToGuest(targetGuest, sequenced);
        }
        return;
      }

      this.broadcastText(sequenced);
      return;
    }

    this.broadcastText(text);
  }

  public sendBinary(data: ArrayBuffer | Uint8Array): void {
    if (!this.isOpen()) return;
    this.broadcastBinary(this.stampBinarySeq(data));
  }

  public sendBinaryTo(targetPeerId: string | number, data: ArrayBuffer | Uint8Array): void {
    if (!this.isOpen()) return;
    const guest = this.findGuestByAppOrSignalingId(targetPeerId);
    if (!guest) return;
    this.sendBinaryToGuest(guest, this.stampBinarySeq(data));
  }

  private async handleSignalingEnvelope(env: SignalingEnvelope): Promise<void> {
    if (this.closed) return;

    if (env.type === 'offer' && env.sdp) {
      const existing = this.guests.get(env.fromPeerId);
      if (existing) {
        if (!existing.closed) {
          if (existing.pc.connectionState === 'connected' || existing.dc?.readyState === 'open') {
            return;
          }
          // Resend answer + gathered host ICE candidates on duplicate offer retries while connecting/new
          if (
            existing.lastAnswerSdp &&
            (existing.pc.connectionState === 'connecting' || existing.pc.connectionState === 'new')
          ) {
            const latestAnswerSdp = existing.pc.localDescription?.sdp || existing.lastAnswerSdp;
            this.signaling.send({
              type: 'answer',
              fromPeerId: this.hostPeerId,
              toPeerId: existing.signalingPeerId,
              sdp: latestAnswerSdp,
              sdpType: 'answer',
            });
            for (const cand of existing.localIceCandidates) {
              this.signaling.send({
                type: 'ice',
                fromPeerId: this.hostPeerId,
                toPeerId: existing.signalingPeerId,
                candidate: cand,
              });
            }
            return;
          }
        }
        this.removeGuest(env.fromPeerId, false);
      }

      if (this.guests.size >= this.maxPeers) {
        this.signaling.send({
          type: 'room-full',
          fromPeerId: this.hostPeerId,
          toPeerId: env.fromPeerId,
          reason: `Room is full (maximum ${this.maxPeers} guests)`,
        });
        return;
      }

      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const guest: GuestConnection = {
        signalingPeerId: env.fromPeerId,
        appPeerId: null,
        joined: false,
        role: 'editor',
        pc,
        dc: null,
        reassembler: new ChunkReassembler(),
        remoteDescSet: false,
        pendingIce: [],
        localIceCandidates: [],
        lastAnswerSdp: null,
        disconnectTimer: null,
        closed: false,
      };
      this.guests.set(env.fromPeerId, guest);

      pc.onicecandidate = (ev) => {
        if (guest.closed || !ev.candidate) return;
        const json = ev.candidate.toJSON ? ev.candidate.toJSON() : undefined;
        const candidateStr = json?.candidate ?? ev.candidate.candidate ?? '';
        if (!candidateStr) return;
        const candidateInit: SignalingIceCandidate = {
          candidate: candidateStr,
          sdpMid: json?.sdpMid ?? ev.candidate.sdpMid ?? null,
          sdpMLineIndex: json?.sdpMLineIndex ?? ev.candidate.sdpMLineIndex ?? null,
          ...(json?.usernameFragment != null ? { usernameFragment: json.usernameFragment } : {}),
        };
        if (guest.localIceCandidates.length < 64) {
          guest.localIceCandidates.push(candidateInit);
        }
        this.signaling.send({
          type: 'ice',
          fromPeerId: this.hostPeerId,
          toPeerId: guest.signalingPeerId,
          candidate: candidateInit,
        });
      };

      pc.onconnectionstatechange = () => {
        if (guest.closed) return;
        if (pc.connectionState === 'connected') {
          if (guest.disconnectTimer !== null) {
            clearTimeout(guest.disconnectTimer);
            guest.disconnectTimer = null;
          }
          return;
        }
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          this.removeGuest(guest.signalingPeerId, true);
        } else if (pc.connectionState === 'disconnected') {
          if (guest.disconnectTimer === null) {
            guest.disconnectTimer = setTimeout(() => {
              guest.disconnectTimer = null;
              if (!guest.closed && pc.connectionState === 'disconnected') {
                this.removeGuest(guest.signalingPeerId, true);
              }
            }, DISCONNECTED_GRACE_MS);
          }
        }
      };

      pc.ondatachannel = (ev) => {
        if (guest.closed) return;
        const dc = ev.channel;
        dc.binaryType = 'arraybuffer';
        guest.dc = dc;

        dc.onmessage = async (msgEv) => {
          if (guest.closed) return;
          try {
            const rawBuf =
              msgEv.data instanceof ArrayBuffer
                ? msgEv.data
                : msgEv.data instanceof Blob
                  ? await msgEv.data.arrayBuffer()
                  : null;
            if (!rawBuf) return;

            const assembled = guest.reassembler.pushFrame(rawBuf);
            if (!assembled) return;

            if (assembled.kind === 'text') {
              this.handleGuestTextMessage(guest, assembled.text);
            } else {
              this.handleGuestBinaryMessage(guest, assembled.data);
            }
          } catch {
            // drop malformed frame
          }
        };

        dc.onclose = () => {
          this.removeGuest(guest.signalingPeerId, true);
        };

        dc.onerror = () => {
          this.removeGuest(guest.signalingPeerId, true);
        };
      };

      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: env.sdp });
        guest.remoteDescSet = true;
        for (const cand of guest.pendingIce.splice(0)) {
          try {
            await pc.addIceCandidate(cand);
          } catch {
            // ignore stale candidate
          }
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const answerSdp = pc.localDescription?.sdp || answer.sdp;
        if (answerSdp) {
          guest.lastAnswerSdp = answerSdp;
          this.signaling.send({
            type: 'answer',
            fromPeerId: this.hostPeerId,
            toPeerId: guest.signalingPeerId,
            sdp: answerSdp,
            sdpType: 'answer',
          });
        }
      } catch (err) {
        this.errorHandlers.forEach((h) =>
          h(err instanceof Error ? err : new Error('Failed to answer WebRTC peer'))
        );
        this.removeGuest(guest.signalingPeerId, false);
      }
      return;
    }

    if (env.type === 'ice' && env.candidate) {
      const guest = this.guests.get(env.fromPeerId);
      if (!guest || guest.closed) return;
      if (!guest.remoteDescSet) {
        if (guest.pendingIce.length < 64) {
          guest.pendingIce.push(env.candidate);
        }
        return;
      }
      try {
        await guest.pc.addIceCandidate(env.candidate);
      } catch {
        // ignore invalid candidate
      }
      return;
    }

    if (env.type === 'bye') {
      this.removeGuest(env.fromPeerId, true);
    }
  }

  private handleGuestTextMessage(guest: GuestConnection, rawText: string): void {
    let parsed: Record<string, unknown>;
    try {
      const raw = JSON.parse(rawText) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      parsed = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof parsed.type === 'string' ? parsed.type : '';
    if (!type) return;

    if (type === 'JOIN_REQUEST' && parsed.peer && typeof parsed.peer === 'object') {
      const peerObj = parsed.peer as Record<string, unknown>;
      if (typeof peerObj.id === 'string' || typeof peerObj.id === 'number') {
        guest.appPeerId = String(peerObj.id);
      }
      guest.joined = true;
    }

    // Strict pre-join & role enforcement on the authoritative Host Hub
    if (!guest.joined && type !== 'JOIN_REQUEST' && type !== 'PEER_LEFT') {
      this.sendAccessDeniedToGuest(guest, 'FORBIDDEN', 'Must join room before sending actions');
      return;
    }

    if (HOST_ONLY_MODERATION_TYPES.has(type)) {
      this.sendAccessDeniedToGuest(guest, 'FORBIDDEN', 'Only the Host can moderate participants');
      return;
    }

    if (guest.role === 'viewer' && !VIEWER_ALLOWED_JSON_TYPES.has(type)) {
      this.sendAccessDeniedToGuest(guest, 'VIEWER_READONLY', 'Viewers have read-only access');
      return;
    }

    const guestPeerId = guest.appPeerId || guest.signalingPeerId;

    // Layer ownership & lock enforcement matching stateful Rust server
    if (type === 'LAYER_DELETE' && typeof parsed.layerId === 'string') {
      const meta = this.layerLocks.get(parsed.layerId);
      if (meta?.reservedByPeerId && meta.reservedByPeerId !== guestPeerId) {
        this.sendAccessDeniedToGuest(guest, 'LAYER_LOCKED', 'Layer is locked by its owner');
        return;
      }
      if (meta?.ownerPeerId && meta.ownerPeerId !== guestPeerId) {
        this.sendAccessDeniedToGuest(guest, 'NOT_OWNER', 'Only the layer owner or Host can delete this layer');
        return;
      }
    } else if (
      (type === 'LAYER_CLEAR' ||
        type === 'LAYER_RENAME' ||
        type === 'LAYER_VISIBILITY' ||
        type === 'LAYER_OPACITY' ||
        type === 'LAYER_UPDATE') &&
      typeof parsed.layerId === 'string'
    ) {
      if (this.isLayerLockedForGuest(parsed.layerId, guestPeerId)) {
        this.sendAccessDeniedToGuest(guest, 'LAYER_LOCKED', 'Layer is locked by its owner');
        return;
      }
      if (type === 'LAYER_UPDATE') {
        const meta = this.layerLocks.get(parsed.layerId);
        const patch =
          parsed.patch && typeof parsed.patch === 'object'
            ? (parsed.patch as Record<string, unknown>)
            : null;
        if (
          patch?.reservedByPeerId !== undefined &&
          patch.reservedByPeerId !== null &&
          patch.reservedByPeerId !== '' &&
          String(patch.reservedByPeerId) !== guestPeerId
        ) {
          this.sendAccessDeniedToGuest(guest, 'FORBIDDEN', 'Cannot lock layer under another peer ID');
          return;
        }
        if (
          meta?.ownerPeerId &&
          meta.ownerPeerId !== guestPeerId &&
          (patch?.ownerPeerId !== undefined ||
            (Array.isArray(parsed.clearedFields) && parsed.clearedFields.includes('ownerPeerId')))
        ) {
          this.sendAccessDeniedToGuest(guest, 'NOT_OWNER', 'Cannot reassign layer ownership');
          return;
        }
      }
    } else if (type === 'LAYER_TREE_SYNC' && Array.isArray(parsed.layers)) {
      const incomingById = new Map<string, Record<string, unknown>>();
      for (const rawItem of parsed.layers) {
        if (rawItem && typeof rawItem === 'object') {
          const item = rawItem as Record<string, unknown>;
          if (typeof item.id === 'string') incomingById.set(item.id, item);
        }
      }
      for (const [layerId, meta] of this.layerLocks.entries()) {
        const nextItem = incomingById.get(layerId);
        if (!nextItem) {
          if (meta.reservedByPeerId && meta.reservedByPeerId !== guestPeerId) {
            this.sendAccessDeniedToGuest(guest, 'LAYER_LOCKED', 'Cannot delete a locked layer');
            return;
          }
          if (meta.ownerPeerId && meta.ownerPeerId !== guestPeerId) {
            this.sendAccessDeniedToGuest(guest, 'NOT_OWNER', 'Cannot delete another user layer');
            return;
          }
        } else if (meta.reservedByPeerId && meta.reservedByPeerId !== guestPeerId) {
          const nextReserved =
            nextItem.reservedByPeerId !== undefined &&
            nextItem.reservedByPeerId !== null &&
            nextItem.reservedByPeerId !== ''
              ? String(nextItem.reservedByPeerId)
              : undefined;
          if (nextReserved !== meta.reservedByPeerId) {
            this.sendAccessDeniedToGuest(guest, 'LAYER_LOCKED', 'Cannot unlock another user layer');
            return;
          }
        }
      }
    }

    this.applyLayerLockMutation(parsed);

    const sequenced = JSON.stringify({
      ...parsed,
      senderId: guest.appPeerId || parsed.senderId || guest.signalingPeerId,
      seq: ++this.seq,
    });

    // Deliver locally to the Host's multiplayerService
    this.textHandlers.forEach((h) => h(sequenced));

    // Relay to all other guests unless this is a Host-consumed handshake message
    if (!HOST_ONLY_CONSUME_TYPES.has(type)) {
      this.broadcastText(sequenced, guest.signalingPeerId);
    }
  }

  private handleGuestBinaryMessage(guest: GuestConnection, buf: ArrayBuffer): void {
    const bytes = toUint8Array(buf);
    if (bytes.byteLength < 11 || bytes[0] !== BINARY_MAGIC_0 || bytes[1] !== BINARY_MAGIC_1) {
      return;
    }

    const opcode = bytes[2];
    const isReadOnlyBinary = opcode === CODE_CURSOR_MOVE || opcode === CODE_BRUSH_ASSET_REQUEST;

    if (!guest.joined && !isReadOnlyBinary) {
      this.sendAccessDeniedToGuest(guest, 'FORBIDDEN', 'Must join room before drawing');
      return;
    }

    if (guest.role === 'viewer' && !isReadOnlyBinary) {
      this.sendAccessDeniedToGuest(guest, 'VIEWER_READONLY', 'Viewers have read-only access');
      return;
    }

    if (
      opcode === CODE_STROKE_START ||
      opcode === CODE_STROKE_FINISH ||
      opcode === CODE_TILE_DELTA ||
      opcode === CODE_LAYER_MASK_DATA
    ) {
      const layerId = this.extractBinaryLayerId(bytes, opcode);
      const guestPeerId = guest.appPeerId || guest.signalingPeerId;
      if (layerId && this.isLayerLockedForGuest(layerId, guestPeerId)) {
        this.sendAccessDeniedToGuest(guest, 'LAYER_LOCKED', 'Layer is locked by its owner');
        return;
      }
    }

    const stamped = this.stampBinarySeq(bytes);
    const stampedBuf = new ArrayBuffer(stamped.byteLength);
    new Uint8Array(stampedBuf).set(stamped);

    // Deliver locally to the Host's multiplayerService
    this.binaryHandlers.forEach((h) => h(stampedBuf));

    // Relay to all other connected guests (star topology)
    this.broadcastBinary(stamped, guest.signalingPeerId);
  }

  private removeGuest(signalingPeerId: string, notifyDisconnect: boolean): void {
    const guest = this.guests.get(signalingPeerId);
    if (!guest || guest.closed) return;
    guest.closed = true;
    if (guest.disconnectTimer !== null) {
      clearTimeout(guest.disconnectTimer);
      guest.disconnectTimer = null;
    }
    this.guests.delete(signalingPeerId);
    guest.reassembler.clear();

    try {
      if (guest.dc) {
        guest.dc.onmessage = null;
        guest.dc.onclose = null;
        guest.dc.onerror = null;
        guest.dc.close();
      }
    } catch {
      // ignore
    }
    try {
      guest.pc.onicecandidate = null;
      guest.pc.ondatachannel = null;
      guest.pc.onconnectionstatechange = null;
      guest.pc.close();
    } catch {
      // ignore
    }

    if (notifyDisconnect && guest.appPeerId && !this.closed) {
      const discJson = JSON.stringify({
        type: 'PEER_DISCONNECTED',
        peerId: guest.appPeerId,
        seq: ++this.seq,
      });
      this.textHandlers.forEach((h) => h(discJson));
      this.broadcastText(discJson);
    }
  }

  public onTextMessage(handler: (text: string) => void): () => void {
    this.textHandlers.add(handler);
    return () => this.textHandlers.delete(handler);
  }

  public onBinaryMessage(handler: (data: ArrayBuffer) => void): () => void {
    this.binaryHandlers.add(handler);
    return () => this.binaryHandlers.delete(handler);
  }

  public onClose(handler: (reason?: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  public onError(handler: (err: Error | Event) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.open = false;

    try {
      this.signaling.send({
        type: 'bye',
        fromPeerId: this.hostPeerId,
        reason: 'Host closed the room',
      });
    } catch {
      // ignore
    }

    for (const id of Array.from(this.guests.keys())) {
      this.removeGuest(id, false);
    }

    this.unsubSignaling?.();
    this.unsubSignaling = null;
    this.signaling.close();
    this.closeHandlers.forEach((h) => h('Host closed the P2P room'));
  }
}
