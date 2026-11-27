export type CollabTransportKind = 'ws' | 'webrtc-host' | 'webrtc-guest';

export interface ICollabTransport {
  readonly kind: CollabTransportKind;
  isOpen(): boolean;
  getBufferedAmount(): number;
  sendText(text: string): void;
  sendBinary(data: ArrayBuffer | Uint8Array): void;
  sendBinaryTo?(targetPeerId: string | number, data: ArrayBuffer | Uint8Array): void;
  close(): void;
  onTextMessage(handler: (text: string) => void): () => void;
  onBinaryMessage(handler: (data: ArrayBuffer) => void): () => void;
  onClose(handler: (reason?: string) => void): () => void;
  onError(handler: (err: Error | Event) => void): () => void;
}

/**
 * Lightweight binary framing/chunking header for RTCDataChannel transport.
 *
 * Frame layout (16 bytes header + payload slice):
 *   [0..1]   Magic bytes: 'I' (0x49), 'C' (0x43)  (distinct from 'I','N' wire packets)
 *   [2]      Payload kind: 0x01 = UTF-8 JSON text, 0x02 = raw binary ArrayBuffer
 *   [3]      Flags (reserved, 0x00)
 *   [4..7]   messageId (Uint32 LE)
 *   [8..11]  chunkIndex (Uint32 LE, 0 .. totalChunks - 1)
 *   [12..15] totalChunks (Uint32 LE, 1 .. MAX_CHUNKS_PER_MESSAGE)
 *   [16..]   Chunk payload bytes (<= maxChunkPayloadBytes, default 48 KB)
 */
export const CHUNK_MAGIC_0 = 0x49; // 'I'
export const CHUNK_MAGIC_1 = 0x43; // 'C'
export const CHUNK_KIND_TEXT = 0x01;
export const CHUNK_KIND_BINARY = 0x02;
export const CHUNK_HEADER_BYTES = 16;

/** Safe default chunk payload size (48 KB) well below Android WebView / browser SCTP limits. */
export const DEFAULT_CHUNK_PAYLOAD_BYTES = 48 * 1024;
/** Maximum reassembled message size (16 MB, matching multiplayerService binary ceiling). */
export const MAX_REASSEMBLED_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Safety cap on chunk count per message. */
export const MAX_CHUNKS_PER_MESSAGE = 1024;
/** Maximum concurrent incomplete reassembly buffers per peer. */
export const MAX_INFLIGHT_REASSEMBLY = 64;
/** Timeout before stale incomplete chunk buffers are evicted. */
export const REASSEMBLY_TIMEOUT_MS = 30_000;

export type ReassembledTransportMessage =
  | { kind: 'text'; text: string }
  | { kind: 'binary'; data: ArrayBuffer };

const sharedTextEncoder = new TextEncoder();
const sharedTextDecoder = new TextDecoder();

export function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * Splits a text (JSON) or binary ('IN...') payload into 1 or more framed chunks
 * sized <= `maxChunkPayloadBytes` (+ 16 byte header).
 */
export function encodeTransportFrames(
  kind: 'text' | 'binary',
  payload: string | ArrayBuffer | Uint8Array,
  messageId: number,
  maxChunkPayloadBytes: number = DEFAULT_CHUNK_PAYLOAD_BYTES
): Uint8Array[] {
  const safeChunkSize = Math.max(256, Math.min(256 * 1024, Math.floor(maxChunkPayloadBytes)));
  const rawBytes =
    kind === 'text'
      ? sharedTextEncoder.encode(typeof payload === 'string' ? payload : '')
      : toUint8Array(payload as ArrayBuffer | Uint8Array);

  if (rawBytes.byteLength > MAX_REASSEMBLED_MESSAGE_BYTES) {
    throw new Error(
      `Transport payload exceeds ${MAX_REASSEMBLED_MESSAGE_BYTES} byte safety ceiling`
    );
  }

  const totalChunks = Math.max(1, Math.ceil(rawBytes.byteLength / safeChunkSize));
  if (totalChunks > MAX_CHUNKS_PER_MESSAGE) {
    throw new Error(`Transport payload requires too many chunks (${totalChunks})`);
  }

  const kindByte = kind === 'text' ? CHUNK_KIND_TEXT : CHUNK_KIND_BINARY;
  const msgIdU32 = messageId >>> 0;
  const frames: Uint8Array[] = new Array(totalChunks);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * safeChunkSize;
    const end = Math.min(rawBytes.byteLength, start + safeChunkSize);
    const sliceLen = end - start;
    const frame = new Uint8Array(CHUNK_HEADER_BYTES + sliceLen);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

    frame[0] = CHUNK_MAGIC_0;
    frame[1] = CHUNK_MAGIC_1;
    frame[2] = kindByte;
    frame[3] = 0;
    view.setUint32(4, msgIdU32, true);
    view.setUint32(8, i >>> 0, true);
    view.setUint32(12, totalChunks >>> 0, true);

    if (sliceLen > 0) {
      frame.set(rawBytes.subarray(start, end), CHUNK_HEADER_BYTES);
    }
    frames[i] = frame;
  }

  return frames;
}

interface PendingAssembly {
  kindByte: number;
  totalChunks: number;
  receivedCount: number;
  totalBytes: number;
  chunks: Array<Uint8Array | undefined>;
  createdAt: number;
}

/**
 * Stateful per-peer chunk reassembler with bounds, duplicate, and timeout protection.
 */
export class ChunkReassembler {
  private pending = new Map<number, PendingAssembly>();
  private readonly maxMessageBytes: number;
  private readonly maxInflight: number;
  private readonly timeoutMs: number;

  constructor(options?: {
    maxMessageBytes?: number;
    maxInflight?: number;
    timeoutMs?: number;
  }) {
    this.maxMessageBytes = options?.maxMessageBytes ?? MAX_REASSEMBLED_MESSAGE_BYTES;
    this.maxInflight = options?.maxInflight ?? MAX_INFLIGHT_REASSEMBLY;
    this.timeoutMs = options?.timeoutMs ?? REASSEMBLY_TIMEOUT_MS;
  }

  public getPendingCount(): number {
    return this.pending.size;
  }

  public clear(): void {
    this.pending.clear();
  }

  public pruneExpired(nowMs: number = Date.now()): void {
    for (const [id, entry] of this.pending.entries()) {
      if (nowMs - entry.createdAt > this.timeoutMs) {
        this.pending.delete(id);
      }
    }
  }

  public pushFrame(
    frameData: ArrayBuffer | Uint8Array,
    nowMs: number = Date.now()
  ): ReassembledTransportMessage | null {
    const bytes = toUint8Array(frameData);
    if (bytes.byteLength < CHUNK_HEADER_BYTES) return null;
    if (bytes[0] !== CHUNK_MAGIC_0 || bytes[1] !== CHUNK_MAGIC_1) return null;

    const kindByte = bytes[2];
    if (kindByte !== CHUNK_KIND_TEXT && kindByte !== CHUNK_KIND_BINARY) return null;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const messageId = view.getUint32(4, true);
    const chunkIndex = view.getUint32(8, true);
    const totalChunks = view.getUint32(12, true);

    if (
      totalChunks === 0 ||
      totalChunks > MAX_CHUNKS_PER_MESSAGE ||
      chunkIndex >= totalChunks
    ) {
      return null;
    }

    const payloadSlice = bytes.subarray(CHUNK_HEADER_BYTES);
    if (payloadSlice.byteLength > this.maxMessageBytes) {
      this.pending.delete(messageId);
      return null;
    }

    // Fast path for single-chunk messages (avoids pending map overhead for strokes/cursors)
    if (totalChunks === 1) {
      this.pending.delete(messageId);
      if (kindByte === CHUNK_KIND_TEXT) {
        return { kind: 'text', text: sharedTextDecoder.decode(payloadSlice) };
      }
      const copy = new Uint8Array(payloadSlice.byteLength);
      copy.set(payloadSlice);
      return { kind: 'binary', data: copy.buffer };
    }

    let entry = this.pending.get(messageId);
    if (!entry) {
      this.pruneExpired(nowMs);
      if (this.pending.size >= this.maxInflight) {
        const oldestKey = this.pending.keys().next().value;
        if (oldestKey !== undefined) {
          this.pending.delete(oldestKey);
        }
      }
      entry = {
        kindByte,
        totalChunks,
        receivedCount: 0,
        totalBytes: 0,
        chunks: new Array<Uint8Array | undefined>(totalChunks),
        createdAt: nowMs,
      };
      this.pending.set(messageId, entry);
    } else if (entry.totalChunks !== totalChunks || entry.kindByte !== kindByte) {
      // Mismatched header for an in-flight messageId — discard corrupt buffer
      this.pending.delete(messageId);
      return null;
    }

    // Ignore duplicate chunk indices safely
    if (entry.chunks[chunkIndex] !== undefined) {
      return null;
    }

    const nextTotalBytes = entry.totalBytes + payloadSlice.byteLength;
    if (nextTotalBytes > this.maxMessageBytes) {
      this.pending.delete(messageId);
      return null;
    }

    const chunkCopy = new Uint8Array(payloadSlice.byteLength);
    chunkCopy.set(payloadSlice);
    entry.chunks[chunkIndex] = chunkCopy;
    entry.receivedCount += 1;
    entry.totalBytes = nextTotalBytes;

    if (entry.receivedCount < entry.totalChunks) {
      return null;
    }

    this.pending.delete(messageId);

    const combined = new Uint8Array(entry.totalBytes);
    let offset = 0;
    for (let i = 0; i < entry.totalChunks; i++) {
      const part = entry.chunks[i];
      if (!part) return null;
      combined.set(part, offset);
      offset += part.byteLength;
    }

    if (entry.kindByte === CHUNK_KIND_TEXT) {
      return { kind: 'text', text: sharedTextDecoder.decode(combined) };
    }
    return { kind: 'binary', data: combined.buffer };
  }
}

/**
 * Helper to send a framed text or binary payload over an open RTCDataChannel.
 */
export function sendFramedOverDataChannel(
  dc: Pick<RTCDataChannel, 'readyState' | 'send'>,
  kind: 'text' | 'binary',
  payload: string | ArrayBuffer | Uint8Array,
  nextMessageId: () => number,
  maxChunkPayloadBytes: number = DEFAULT_CHUNK_PAYLOAD_BYTES
): boolean {
  if (dc.readyState !== 'open') return false;
  const frames = encodeTransportFrames(kind, payload, nextMessageId(), maxChunkPayloadBytes);
  for (const frame of frames) {
    dc.send(frame as unknown as ArrayBuffer);
  }
  return true;
}
