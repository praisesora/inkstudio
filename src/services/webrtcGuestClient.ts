import {
  ChunkReassembler,
  ICollabTransport,
  sendFramedOverDataChannel,
} from './collabTransport';
import {
  buildIceServers,
  WEBRTC_DATACHANNEL_LABEL,
  WebRtcTurnConfig,
} from './webrtcHostHub';
import {
  createSignalingClient,
  ISignalingClient,
  SignalingEnvelope,
} from './webrtcSignaling';

export interface WebRtcGuestClientOptions {
  roomHash: string;
  peerId: string;
  turnConfig?: WebRtcTurnConfig;
  customSignalingUrl?: string;
  signalingClient?: ISignalingClient;
  connectTimeoutMs?: number;
}

/**
 * WebRTC Star-Topology Guest Client.
 *
 * Exchanges SDP offer/answer & ICE via the pluggable zero-cost signaling client,
 * then opens a reliable ordered RTCDataChannel carrying 48 KB framed JSON + binary
 * packets directly to/from the Host Hub.
 */
export class WebRtcGuestClient implements ICollabTransport {
  public readonly kind = 'webrtc-guest' as const;

  public readonly roomHash: string;
  private readonly peerId: string;
  private readonly iceServers: RTCIceServer[];
  private readonly connectTimeoutMs: number;
  private readonly signaling: ISignalingClient;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private reassembler = new ChunkReassembler();
  private remoteDescSet = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private localIceCandidates: NonNullable<SignalingEnvelope['candidate']>[] = [];
  private hostSignalingPeerId: string | null = null;

  private textHandlers = new Set<(text: string) => void>();
  private binaryHandlers = new Set<(data: ArrayBuffer) => void>();
  private closeHandlers = new Set<(reason?: string) => void>();
  private errorHandlers = new Set<(err: Error | Event) => void>();

  private unsubSignaling: (() => void) | null = null;
  private offerRetryTimer: ReturnType<typeof setInterval> | null = null;
  private signalingCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextMsgId = 1;
  private closed = false;
  private hasNotifiedClose = false;

  constructor(options: WebRtcGuestClientOptions) {
    this.roomHash = options.roomHash;
    this.peerId = options.peerId;
    this.iceServers = buildIceServers(options.turnConfig);
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
    this.signaling =
      options.signalingClient ??
      createSignalingClient({
        roomHash: options.roomHash,
        peerId: options.peerId,
        customSignalingUrl: options.customSignalingUrl,
      });
  }

  private allocMessageId = (): number => {
    this.nextMsgId = (this.nextMsgId + 1) >>> 0;
    if (this.nextMsgId === 0) this.nextMsgId = 1;
    return this.nextMsgId;
  };

  public async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('WebRTC Guest Client already closed');
    }
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('WebRTC is not supported in this browser/WebView');
    }

    await this.signaling.connect();

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const clearTimers = () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (this.offerRetryTimer !== null) {
          clearInterval(this.offerRetryTimer);
          this.offerRetryTimer = null;
        }
      };

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        clearTimers();
        // Close signaling shortly after DataChannel opens (zero ongoing signaling traffic)
        this.signalingCloseTimer = setTimeout(() => {
          this.unsubSignaling?.();
          this.unsubSignaling = null;
          this.signaling.close();
        }, 3_000);
        resolve();
      };

      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        this.closeInternal(false);
        reject(err);
      };

      let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        settleReject(
          new Error(
            'Could not reach the room host. Verify the Room Code/Secret and ensure the host tablet is online.'
          )
        );
      }, this.connectTimeoutMs);

      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      this.pc = pc;

      const dc = pc.createDataChannel(WEBRTC_DATACHANNEL_LABEL, { ordered: true });
      dc.binaryType = 'arraybuffer';
      this.dc = dc;

      dc.onopen = () => {
        settleResolve();
      };

      dc.onmessage = async (msgEv) => {
        if (this.closed) return;
        try {
          const rawBuf =
            msgEv.data instanceof ArrayBuffer
              ? msgEv.data
              : msgEv.data instanceof Blob
                ? await msgEv.data.arrayBuffer()
                : null;
          if (!rawBuf) return;

          const assembled = this.reassembler.pushFrame(rawBuf);
          if (!assembled) return;

          if (assembled.kind === 'text') {
            this.textHandlers.forEach((h) => h(assembled.text));
          } else {
            this.binaryHandlers.forEach((h) => h(assembled.data));
          }
        } catch {
          // drop malformed frame
        }
      };

      dc.onclose = () => {
        if (!settled) {
          settleReject(new Error('Host closed the connection before handshake completed'));
        } else {
          this.emitCloseOnce('Host disconnected from the P2P room');
        }
      };

      dc.onerror = (ev) => {
        this.errorHandlers.forEach((h) => h(ev));
      };

      pc.onicecandidate = (ev) => {
        if (this.closed || !ev.candidate) return;
        const json = ev.candidate.toJSON ? ev.candidate.toJSON() : undefined;
        const candidateStr = json?.candidate ?? ev.candidate.candidate ?? '';
        if (!candidateStr) return;
        const candidateInit: NonNullable<SignalingEnvelope['candidate']> = {
          candidate: candidateStr,
          sdpMid: json?.sdpMid ?? ev.candidate.sdpMid ?? null,
          sdpMLineIndex: json?.sdpMLineIndex ?? ev.candidate.sdpMLineIndex ?? null,
          ...(json?.usernameFragment != null ? { usernameFragment: json.usernameFragment } : {}),
        };
        if (this.localIceCandidates.length < 64) {
          this.localIceCandidates.push(candidateInit);
        }
        this.signaling.send({
          type: 'ice',
          fromPeerId: this.peerId,
          ...(this.hostSignalingPeerId ? { toPeerId: this.hostSignalingPeerId } : {}),
          candidate: candidateInit,
        });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          if (this.disconnectTimer !== null) {
            clearTimeout(this.disconnectTimer);
            this.disconnectTimer = null;
          }
          return;
        }
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          if (!settled) {
            settleReject(
              new Error(
                'WebRTC peer connection failed (strict firewall/NAT). Try configuring an optional TURN server in Settings.'
              )
            );
          } else {
            this.emitCloseOnce('Host disconnected from the P2P room');
          }
        } else if (pc.connectionState === 'disconnected' && settled) {
          if (this.disconnectTimer === null) {
            this.disconnectTimer = setTimeout(() => {
              this.disconnectTimer = null;
              if (!this.closed && this.pc?.connectionState === 'disconnected') {
                this.emitCloseOnce('Host disconnected from the P2P room');
              }
            }, 5_000);
          }
        }
      };

      this.unsubSignaling = this.signaling.onMessage((env: SignalingEnvelope) => {
        void this.handleSignalingEnvelope(env, settleReject);
      });

      // Create & broadcast offer (with periodic retry carrying live gathered SDP & ICE until answer arrives)
      pc.createOffer()
        .then(async (offer) => {
          if (this.closed) return;
          await pc.setLocalDescription(offer);
          const initialSdp = pc.localDescription?.sdp || offer.sdp;
          if (!initialSdp) {
            settleReject(new Error('Failed to generate WebRTC SDP offer'));
            return;
          }

          const sendOffer = () => {
            if (this.closed || this.remoteDescSet) return;
            const liveSdp = pc.localDescription?.sdp || initialSdp;
            this.signaling.send({
              type: 'offer',
              fromPeerId: this.peerId,
              sdp: liveSdp,
              sdpType: 'offer',
            });
            for (const cand of this.localIceCandidates) {
              this.signaling.send({
                type: 'ice',
                fromPeerId: this.peerId,
                candidate: cand,
              });
            }
          };

          sendOffer();
          this.offerRetryTimer = setInterval(sendOffer, 2_500);
        })
        .catch((err) => {
          settleReject(err instanceof Error ? err : new Error('Failed to create WebRTC offer'));
        });
    });
  }

  private async handleSignalingEnvelope(
    env: SignalingEnvelope,
    onFatalError: (err: Error) => void
  ): Promise<void> {
    if (this.closed || !this.pc) return;

    if (env.type === 'room-full') {
      onFatalError(new Error(env.reason || 'Room is full (maximum 8 guests)'));
      return;
    }

    if (env.type === 'bye' && env.fromPeerId === this.hostSignalingPeerId) {
      this.emitCloseOnce(env.reason || 'Host closed the P2P room');
      return;
    }

    if (env.type === 'answer' && env.sdp && !this.remoteDescSet) {
      this.hostSignalingPeerId = env.fromPeerId;
      if (this.offerRetryTimer !== null) {
        clearInterval(this.offerRetryTimer);
        this.offerRetryTimer = null;
      }
      try {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: env.sdp });
        this.remoteDescSet = true;
        for (const cand of this.pendingIce.splice(0)) {
          try {
            await this.pc.addIceCandidate(cand);
          } catch {
            // ignore stale candidate
          }
        }
        // Replay any local ICE candidates gathered before we knew hostSignalingPeerId
        for (const localCand of this.localIceCandidates) {
          this.signaling.send({
            type: 'ice',
            fromPeerId: this.peerId,
            toPeerId: this.hostSignalingPeerId,
            candidate: localCand,
          });
        }
      } catch (err) {
        onFatalError(
          err instanceof Error ? err : new Error('Failed to apply WebRTC answer from host')
        );
      }
      return;
    }

    if (env.type === 'ice' && env.candidate) {
      if (!this.remoteDescSet) {
        if (this.pendingIce.length < 64) {
          this.pendingIce.push(env.candidate);
        }
        return;
      }
      try {
        await this.pc.addIceCandidate(env.candidate);
      } catch {
        // ignore invalid candidate
      }
    }
  }

  private emitCloseOnce(reason?: string): void {
    if (this.hasNotifiedClose) return;
    this.hasNotifiedClose = true;
    this.closeInternal(false);
    this.closeHandlers.forEach((h) => h(reason));
  }

  public isOpen(): boolean {
    return !this.closed && this.dc !== null && this.dc.readyState === 'open';
  }

  public getBufferedAmount(): number {
    return this.dc && this.dc.readyState === 'open' ? this.dc.bufferedAmount || 0 : 0;
  }

  public sendText(text: string): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    sendFramedOverDataChannel(this.dc, 'text', text, this.allocMessageId);
  }

  public sendBinary(data: ArrayBuffer | Uint8Array): void {
    if (!this.dc || this.dc.readyState !== 'open') return;
    sendFramedOverDataChannel(this.dc, 'binary', data, this.allocMessageId);
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

  private closeInternal(sendBye: boolean): void {
    if (this.closed) return;
    this.closed = true;

    if (this.offerRetryTimer !== null) {
      clearInterval(this.offerRetryTimer);
      this.offerRetryTimer = null;
    }
    if (this.signalingCloseTimer !== null) {
      clearTimeout(this.signalingCloseTimer);
      this.signalingCloseTimer = null;
    }
    if (this.disconnectTimer !== null) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    if (sendBye) {
      try {
        this.signaling.send({
          type: 'bye',
          fromPeerId: this.peerId,
          ...(this.hostSignalingPeerId ? { toPeerId: this.hostSignalingPeerId } : {}),
        });
      } catch {
        // ignore
      }
    }

    this.unsubSignaling?.();
    this.unsubSignaling = null;
    this.signaling.close();
    this.reassembler.clear();

    try {
      if (this.dc) {
        this.dc.onopen = null;
        this.dc.onmessage = null;
        this.dc.onclose = null;
        this.dc.onerror = null;
        this.dc.close();
      }
    } catch {
      // ignore
    }
    this.dc = null;

    try {
      if (this.pc) {
        this.pc.onicecandidate = null;
        this.pc.onconnectionstatechange = null;
        this.pc.close();
      }
    } catch {
      // ignore
    }
    this.pc = null;
  }

  public close(): void {
    this.closeInternal(true);
  }
}
