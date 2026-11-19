/**
 * Production-Grade Fault-Tolerant Crash Recovery & Auto-Save System (WAL Architecture)
 *
 * Implements Write-Ahead Logging (WAL) with zero latency impact on stylus inking (120-240 Hz).
 * Provides atomic checkpoints, binary framing headers, CRC32 checksums, and rapid crash recovery.
 */

import { deflateSync, inflateSync } from 'fflate';
import {
  TileDelta,
  VectorStroke,
  LayerItem,
  CanvasColorMode,
} from '../types/editor';
import {
  globalTileGrid,
  SparseTileGrid,
  serializeTileDeltas,
  deserializeTileDeltas,
  serializeSparseTileGrid,
  deserializeSparseTileGrid,
} from '../utils/tileEngine';
import { documentStore } from '../utils/documentStore';

export const WAL_MAGIC_BYTES = new Uint8Array([0x49, 0x4e, 0x4b, 0x57]); // 'INKW'
export const WAL_ENTRY_STROKE_TILE_DELTA = 1;
export const WAL_ENTRY_VECTOR_STROKE = 2;
export const WAL_ENTRY_LAYER_MUTATION = 3;

export const CHECKPOINT_STROKE_THRESHOLD = 25; // Trigger checkpoint after 25-30 completed strokes
export const CHECKPOINT_IDLE_TIMEOUT_MS = 30000; // Trigger checkpoint after 30 seconds of idle

// IEEE 802.3 standard CRC-32 lookup table
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

/**
 * Computes standard IEEE 802.3 CRC32 checksum for arbitrary byte arrays.
 */
export function computeCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface WalFrame {
  entryType: number;
  payload: Uint8Array;
}

/**
 * Packs a WAL entry into atomic framing header:
 * [Magic: 4 bytes (0x494E4B57 "INKW")][EntryType: 1 byte][PayloadLength: 4 bytes (u32 LE)][CRC32: 4 bytes][Payload]
 */
export function formatWalFrame(entryType: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(13 + payload.length);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  frame[0] = 0x49; // 'I'
  frame[1] = 0x4e; // 'N'
  frame[2] = 0x4b; // 'K'
  frame[3] = 0x57; // 'W'

  frame[4] = entryType;
  view.setUint32(5, payload.length, true);

  const crc = computeCrc32(payload);
  view.setUint32(9, crc, true);

  frame.set(payload, 13);
  return frame;
}

/**
 * Parses all valid binary chunks from a WAL stream, safely discarding incomplete or corrupted trailing bytes.
 */
export function parseWalFrames(buffer: Uint8Array): {
  validFrames: WalFrame[];
  corruptedTail: boolean;
} {
  const validFrames: WalFrame[] = [];
  let offset = 0;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  while (offset + 13 <= buffer.length) {
    if (
      buffer[offset] !== 0x49 ||
      buffer[offset + 1] !== 0x4e ||
      buffer[offset + 2] !== 0x4b ||
      buffer[offset + 3] !== 0x57
    ) {
      return { validFrames, corruptedTail: true };
    }

    const entryType = buffer[offset + 4];
    const payloadLen = view.getUint32(offset + 5, true);
    const expectedCrc = view.getUint32(offset + 9, true);

    if (offset + 13 + payloadLen > buffer.length) {
      // Incomplete trailing chunk from sudden crash mid-write
      return { validFrames, corruptedTail: true };
    }

    const payload = buffer.subarray(offset + 13, offset + 13 + payloadLen);
    const actualCrc = computeCrc32(payload);
    if (actualCrc !== expectedCrc) {
      // CRC32 mismatch from corrupted tail
      return { validFrames, corruptedTail: true };
    }

    validFrames.push({ entryType, payload: new Uint8Array(payload) });
    offset += 13 + payloadLen;
  }

  const hasRemainingBytes = offset < buffer.length;
  return { validFrames, corruptedTail: hasRemainingBytes };
}

export interface DocumentManifest {
  sessionId: string;
  documentName: string;
  width: number;
  height: number;
  dpi: number;
  colorMode: CanvasColorMode;
  layers: LayerItem[];
  activeLayerId: string;
  timestamp: number;
}

export interface CrashedSessionInfo {
  session_id: string;
  timestamp: number;
  pid: number;
  manifest_json?: string | null;
  has_thumbnail: boolean;
  thumbnail_data_url?: string | null;
}

export interface WalEntryData {
  entry_type: number;
  payload: number[] | Uint8Array;
}

export interface RecoveryReplayData {
  session_id: string;
  manifest_json: string;
  base_snapshot?: number[] | Uint8Array | null;
  wal_entries: WalEntryData[];
}

const _recoveryEncoder = new TextEncoder();
const _recoveryDecoder = new TextDecoder();

function toExactUint8Array(u8: Uint8Array): Uint8Array {
  return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8 : u8.slice();
}

/**
 * Packs a checkpoint payload into a raw binary frame:
 * `[manifestLen:u32][snapshotLen:u32][thumbLen:u32][manifestUtf8][baseSnapshot][thumbnailPng]` (LE)
 */
export function packRecoveryCheckpointPayload(
  manifestJson: string,
  baseSnapshot: Uint8Array,
  thumbnailPng: Uint8Array
): Uint8Array {
  const manifestBytes = _recoveryEncoder.encode(manifestJson);
  const total = 12 + manifestBytes.byteLength + baseSnapshot.byteLength + thumbnailPng.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  view.setUint32(0, manifestBytes.byteLength, true);
  view.setUint32(4, baseSnapshot.byteLength, true);
  view.setUint32(8, thumbnailPng.byteLength, true);

  let offset = 12;
  out.set(manifestBytes, offset);
  offset += manifestBytes.byteLength;
  out.set(baseSnapshot, offset);
  offset += baseSnapshot.byteLength;
  out.set(thumbnailPng, offset);

  return out;
}

/**
 * Unpacks a binary checkpoint frame back into its components.
 */
export function unpackRecoveryCheckpointPayload(buffer: ArrayBuffer | Uint8Array): {
  manifestJson: string;
  baseSnapshot: Uint8Array;
  thumbnailPng: Uint8Array;
} {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 12) {
    throw new Error('Truncated recovery checkpoint header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const manifestLen = view.getUint32(0, true);
  const snapshotLen = view.getUint32(4, true);
  const thumbLen = view.getUint32(8, true);

  if (12 + manifestLen + snapshotLen + thumbLen !== bytes.byteLength) {
    throw new Error('Recovery checkpoint payload size mismatch');
  }

  let offset = 12;
  const manifestJson = _recoveryDecoder.decode(bytes.subarray(offset, offset + manifestLen));
  offset += manifestLen;
  const baseSnapshot = bytes.slice(offset, offset + snapshotLen);
  offset += snapshotLen;
  const thumbnailPng = bytes.slice(offset, offset + thumbLen);

  return { manifestJson, baseSnapshot, thumbnailPng };
}

/**
 * Encodes `RecoveryReplayData` into the binary `INKR` frame matching Rust `recovery::encode_replay_data`.
 */
export function encodeRecoveryReplayData(data: RecoveryReplayData): Uint8Array {
  const sidBytes = _recoveryEncoder.encode(data.session_id);
  const manifestBytes = _recoveryEncoder.encode(data.manifest_json);
  const hasSnapshot = data.base_snapshot !== null && data.base_snapshot !== undefined;
  const snapBytes = hasSnapshot
    ? data.base_snapshot instanceof Uint8Array
      ? data.base_snapshot
      : new Uint8Array(data.base_snapshot!)
    : new Uint8Array(0);
  const walPayloads = data.wal_entries.map((e) =>
    e.payload instanceof Uint8Array ? e.payload : new Uint8Array(e.payload)
  );

  let total = 4 + 4 + sidBytes.byteLength + 4 + manifestBytes.byteLength + 1 + 4 + snapBytes.byteLength + 4;
  for (const p of walPayloads) {
    total += 5 + p.byteLength;
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  // Magic 'INKR'
  out[0] = 0x49;
  out[1] = 0x4e;
  out[2] = 0x4b;
  out[3] = 0x52;

  let offset = 4;
  view.setUint32(offset, sidBytes.byteLength, true);
  offset += 4;
  out.set(sidBytes, offset);
  offset += sidBytes.byteLength;

  view.setUint32(offset, manifestBytes.byteLength, true);
  offset += 4;
  out.set(manifestBytes, offset);
  offset += manifestBytes.byteLength;

  out[offset++] = hasSnapshot ? 1 : 0;
  view.setUint32(offset, snapBytes.byteLength, true);
  offset += 4;
  if (snapBytes.byteLength > 0) {
    out.set(snapBytes, offset);
    offset += snapBytes.byteLength;
  }

  view.setUint32(offset, data.wal_entries.length, true);
  offset += 4;
  for (let i = 0; i < data.wal_entries.length; i++) {
    out[offset++] = data.wal_entries[i].entry_type & 0xff;
    const p = walPayloads[i];
    view.setUint32(offset, p.byteLength, true);
    offset += 4;
    out.set(p, offset);
    offset += p.byteLength;
  }

  return out;
}

/**
 * Decodes a binary `INKR` response returned by `recovery_load_session_data`.
 */
export function decodeRecoveryReplayData(buffer: ArrayBuffer | Uint8Array): RecoveryReplayData {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (
    bytes.byteLength < 17 ||
    bytes[0] !== 0x49 ||
    bytes[1] !== 0x4e ||
    bytes[2] !== 0x4b ||
    bytes[3] !== 0x52
  ) {
    throw new Error('Invalid recovery replay binary frame');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 4;

  const readU32 = (): number => {
    if (offset + 4 > bytes.byteLength) throw new Error('Truncated recovery replay frame');
    const v = view.getUint32(offset, true);
    offset += 4;
    return v;
  };

  const sidLen = readU32();
  if (offset + sidLen > bytes.byteLength) throw new Error('Truncated replay session_id');
  const session_id = _recoveryDecoder.decode(bytes.subarray(offset, offset + sidLen));
  offset += sidLen;

  const manifestLen = readU32();
  if (offset + manifestLen > bytes.byteLength) throw new Error('Truncated replay manifest');
  const manifest_json = _recoveryDecoder.decode(bytes.subarray(offset, offset + manifestLen));
  offset += manifestLen;

  if (offset >= bytes.byteLength) throw new Error('Truncated replay snapshot flag');
  const hasSnapshot = bytes[offset++] !== 0;

  const snapLen = readU32();
  if (offset + snapLen > bytes.byteLength) throw new Error('Truncated replay snapshot');
  const base_snapshot = hasSnapshot ? bytes.subarray(offset, offset + snapLen) : null;
  offset += snapLen;

  const walCount = readU32();
  if (walCount > Math.floor((bytes.byteLength - offset) / 5)) {
    throw new Error('Truncated replay WAL entries');
  }
  const wal_entries: WalEntryData[] = new Array(walCount);
  for (let i = 0; i < walCount; i++) {
    if (offset >= bytes.byteLength) throw new Error('Truncated WAL entry type');
    const entry_type = bytes[offset++];
    const payloadLen = readU32();
    if (offset + payloadLen > bytes.byteLength) throw new Error('Truncated WAL entry payload');
    const payload = bytes.subarray(offset, offset + payloadLen);
    offset += payloadLen;
    wal_entries[i] = { entry_type, payload };
  }

  if (offset !== bytes.byteLength) {
    throw new Error('Unexpected trailing bytes in recovery replay frame');
  }

  return {
    session_id,
    manifest_json,
    base_snapshot,
    wal_entries,
  };
}

export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as any).__TAURI_INTERNALS__ ||
    (window as any).__TAURI__ ||
    (window as any).isTauri
  );
}

class RecoveryService {
  private currentSessionId: string | null = null;
  private strokesSinceCheckpoint: number = 0;
  private idleCheckpointTimer: any = null;
  private layerMutationDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isCheckpointing: boolean = false;

  private stripLayerTransientFields(layers?: LayerItem[]): LayerItem[] {
    if (!layers) return [];
    return layers.map(({ maskCanvas: _mc, maskThumbnailUrl: _mt, ...rest }) => ({
      ...rest,
      thumbnailUrl: '',
    }));
  }

  private manifestProvider: (() => DocumentManifest | null) | null = null;
  private thumbnailProvider: (() => Promise<Uint8Array | null>) | null = null;

  public getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Initializes or binds an active recovery session for a document tab.
   */
  public async initSession(
    sessionId: string,
    manifestProvider: () => DocumentManifest | null,
    thumbnailProvider?: () => Promise<Uint8Array | null>
  ): Promise<void> {
    const isSameSession = this.currentSessionId === sessionId;
    this.currentSessionId = sessionId;
    this.manifestProvider = manifestProvider;
    if (thumbnailProvider) {
      this.thumbnailProvider = thumbnailProvider;
    }

    if (isSameSession) {
      return;
    }

    this.strokesSinceCheckpoint = 0;

    if (this.idleCheckpointTimer) {
      clearTimeout(this.idleCheckpointTimer);
      this.idleCheckpointTimer = null;
    }

    if (!isTauriEnvironment()) return;

    try {
      const rawManifest = manifestProvider();
      const safeManifest = rawManifest
        ? {
            ...rawManifest,
            layers: this.stripLayerTransientFields(rawManifest.layers),
          }
        : {};
      const manifestJson = JSON.stringify(safeManifest);
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('recovery_init_session', {
        sessionId,
        manifestJson,
      });
    } catch (err) {
      console.warn('[RecoveryService] Failed to init session in Rust backend:', err);
    }
  }

  private dispatchWalEntry(
    sessionId: string,
    entryType: number,
    compressed: Uint8Array,
    label: string
  ): void {
    if (!isTauriEnvironment()) return;
    const payload = toExactUint8Array(compressed);
    import('@tauri-apps/api/core').then(({ invoke }) => {
      void invoke('recovery_append_wal_entry', payload, {
        headers: {
          'x-session-id': encodeURIComponent(sessionId),
          'x-entry-type': String(entryType),
        },
      }).catch((err) => {
        console.warn(`[RecoveryService] Non-blocking WAL ${label} append error:`, err);
      });
    });
  }

  /**
   * Asynchronously appends a completed stroke's tile deltas or vector deltas to journal.wal without blocking UI.
   */
  public logStrokeDelta(
    sessionId: string,
    tileDeltas?: TileDelta[],
    vectorDelta?: { before: VectorStroke[]; after: VectorStroke[] },
    layerId?: string
  ): void {
    const activeId = sessionId || this.currentSessionId;
    if (!activeId) return;

    // 1. Dispatch tile deltas
    if (tileDeltas && tileDeltas.length > 0) {
      try {
        const serialized = serializeTileDeltas(tileDeltas);
        const compressed = deflateSync(serialized, { level: 1 }); // Ultra-fast compression (<0.3ms)
        this.dispatchWalEntry(activeId, WAL_ENTRY_STROKE_TILE_DELTA, compressed, 'tile');
      } catch (err) {
        console.warn('[RecoveryService] Error serializing stroke tile delta:', err);
      }
    }

    // 2. Dispatch vector stroke deltas
    if (vectorDelta && vectorDelta.after && vectorDelta.after.length > 0) {
      try {
        const payloadData = {
          layerId,
          strokes: vectorDelta.after,
        };
        const jsonBytes = _recoveryEncoder.encode(JSON.stringify(payloadData));
        const compressed = deflateSync(jsonBytes, { level: 1 });
        this.dispatchWalEntry(activeId, WAL_ENTRY_VECTOR_STROKE, compressed, 'vector');
      } catch (err) {
        console.warn('[RecoveryService] Error serializing vector stroke delta:', err);
      }
    }

    // Increment checkpoint stroke counter and defer full grid snapshot to idle timer so active drawing never freezes
    this.strokesSinceCheckpoint++;
    this.resetIdleCheckpointTimer(activeId);
  }

  /**
   * Logs layer structure changes (add, delete, reorder, visibility, opacity, blendMode).
   */
  public logLayerMutation(
    sessionId: string,
    mutationType: string,
    layers: LayerItem[],
    activeLayerId?: string
  ): void {
    const activeId = sessionId || this.currentSessionId;
    if (!activeId) return;

    const flushMutation = () => {
      try {
        const payloadData = {
          mutationType,
          layers: this.stripLayerTransientFields(layers),
          activeLayerId,
          timestamp: Date.now(),
        };
        const jsonBytes = _recoveryEncoder.encode(JSON.stringify(payloadData));
        const compressed = deflateSync(jsonBytes, { level: 1 });
        this.dispatchWalEntry(activeId, WAL_ENTRY_LAYER_MUTATION, compressed, 'layer mutation');
      } catch (err) {
        console.warn('[RecoveryService] Error logging layer mutation:', err);
      }
    };

    const isContinuous =
      mutationType === 'opacity' ||
      mutationType === 'set-opacity' ||
      mutationType === 'tone' ||
      mutationType === 'layer-color';

    if (isContinuous) {
      if (this.layerMutationDebounceTimer) {
        clearTimeout(this.layerMutationDebounceTimer);
      }
      this.layerMutationDebounceTimer = setTimeout(() => {
        this.layerMutationDebounceTimer = null;
        flushMutation();
      }, 250);
    } else {
      if (this.layerMutationDebounceTimer) {
        clearTimeout(this.layerMutationDebounceTimer);
        this.layerMutationDebounceTimer = null;
      }
      flushMutation();
    }

    this.resetIdleCheckpointTimer(activeId);
  }

  private resetIdleCheckpointTimer(sessionId: string): void {
    if (this.idleCheckpointTimer) {
      clearTimeout(this.idleCheckpointTimer);
    }
    this.idleCheckpointTimer = setTimeout(() => {
      this.idleCheckpointTimer = null;
      void this.triggerCheckpoint(sessionId);
    }, CHECKPOINT_IDLE_TIMEOUT_MS);
  }

  /**
   * Executes a full background checkpoint:
   * 1. Compresses full active SparseTileGrid into baseline snapshot.
   * 2. Atomically overwrites base_snapshot.bin.
   * 3. Truncates journal.wal to zero bytes.
   * 4. Updates manifest.json & thumbnail.png.
   */
  public async triggerCheckpoint(sessionId: string): Promise<void> {
    if (this.isCheckpointing) return;
    const activeId = sessionId || this.currentSessionId;
    if (!activeId) return;

    this.isCheckpointing = true;
    if (this.idleCheckpointTimer) {
      clearTimeout(this.idleCheckpointTimer);
      this.idleCheckpointTimer = null;
    }

    try {
      // 1. Snapshot SparseTileGrid for this specific document session
      const targetGrid = documentStore.getSession(activeId)?.tileGrid ?? globalTileGrid;
      const rawSnapshot = serializeSparseTileGrid(targetGrid);
      const compressedSnapshot = deflateSync(rawSnapshot, { level: 4 });

      // 2. Manifest JSON (strip DOM canvas elements before serializing)
      const rawManifest = this.manifestProvider?.() || null;
      const safeManifest = rawManifest
        ? {
            ...rawManifest,
            layers: this.stripLayerTransientFields(rawManifest.layers),
          }
        : {};
      const manifestJson = JSON.stringify(safeManifest);

      // 3. Thumbnail PNG
      let thumbnailPng: Uint8Array = new Uint8Array(0);
      if (this.thumbnailProvider) {
        try {
          const t = await this.thumbnailProvider();
          if (t && t.length > 0) thumbnailPng = new Uint8Array(t);
        } catch (_) {}
      }

      if (isTauriEnvironment()) {
        const { invoke } = await import('@tauri-apps/api/core');
        const checkpointBody = packRecoveryCheckpointPayload(
          manifestJson,
          compressedSnapshot,
          thumbnailPng
        );
        await invoke('recovery_checkpoint', checkpointBody, {
          headers: {
            'x-session-id': encodeURIComponent(activeId),
          },
        });
      }

      this.strokesSinceCheckpoint = 0;
    } catch (err) {
      console.warn('[RecoveryService] Checkpoint failed:', err);
    } finally {
      this.isCheckpointing = false;
    }
  }

  /**
   * Called upon clean document save (Ctrl+S / Save As) to remove recovery session lock and folder.
   */
  public async markCleanSaved(sessionId: string): Promise<void> {
    const activeId = sessionId || this.currentSessionId;
    if (!activeId) return;

    if (this.idleCheckpointTimer) {
      clearTimeout(this.idleCheckpointTimer);
      this.idleCheckpointTimer = null;
    }
    this.strokesSinceCheckpoint = 0;

    if (isTauriEnvironment()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('recovery_close_session', { sessionId: activeId });
      } catch (err) {
        console.warn('[RecoveryService] Failed to clean up saved recovery session:', err);
      }
    }
  }

  /**
   * Called upon intentional tab closure.
   */
  public async closeSession(sessionId: string): Promise<void> {
    await this.markCleanSaved(sessionId);
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
  }

  /**
   * Scans for any crashed sessions with dead/stale PIDs.
   */
  public async checkForCrashedSessions(): Promise<CrashedSessionInfo[]> {
    if (!isTauriEnvironment()) return [];
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const sessions = await invoke<CrashedSessionInfo[]>('recovery_check_crashed_sessions');
      return sessions || [];
    } catch (err) {
      console.warn('[RecoveryService] Error checking crashed sessions:', err);
      return [];
    }
  }

  /**
   * Discards an unrecovered crashed session directory.
   */
  public async discardCrashedSession(sessionId: string): Promise<void> {
    if (!isTauriEnvironment()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('recovery_close_session', { sessionId });
    } catch (err) {
      console.warn('[RecoveryService] Failed to discard crashed session:', err);
    }
  }

  /**
   * Loads raw snapshot and parsed WAL entries for replaying a crashed session.
   */
  public async loadSessionData(sessionId: string): Promise<RecoveryReplayData> {
    if (!isTauriEnvironment()) {
      throw new Error('Recovery requires Tauri environment');
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke<ArrayBuffer | Uint8Array | RecoveryReplayData>(
      'recovery_load_session_data',
      undefined,
      {
        headers: {
          'x-session-id': encodeURIComponent(sessionId),
        },
      }
    );
    if (raw instanceof ArrayBuffer || raw instanceof Uint8Array) {
      return decodeRecoveryReplayData(raw);
    }
    return raw;
  }

  /**
   * Replays a crashed session and reconstructs state into target tile grid.
   */
  public replaySessionData(
    replayData: RecoveryReplayData,
    targetGrid: SparseTileGrid = globalTileGrid
  ): {
    manifest: DocumentManifest;
    replayedStrokesCount: number;
    replayedMutationsCount: number;
  } {
    targetGrid.clearAll();

    const manifest: DocumentManifest = JSON.parse(replayData.manifest_json);

    // 1. Replay baseline snapshot if present
    if (replayData.base_snapshot) {
      const rawPayload =
        replayData.base_snapshot instanceof Uint8Array
          ? replayData.base_snapshot
          : new Uint8Array(replayData.base_snapshot);

      if (rawPayload.length > 0) {
        let decompressed: Uint8Array;
        // Check if deflate compressed (not raw 'INKG')
        if (
          rawPayload[0] === 0x49 &&
          rawPayload[1] === 0x4e &&
          rawPayload[2] === 0x4b &&
          rawPayload[3] === 0x47
        ) {
          decompressed = rawPayload;
        } else {
          decompressed = inflateSync(rawPayload);
        }
        deserializeSparseTileGrid(targetGrid, decompressed);
      }
    }

    let replayedStrokesCount = 0;
    let replayedMutationsCount = 0;

    // 2. Replay all WAL entries in exact sequential append order
    for (const entry of replayData.wal_entries) {
      const payloadBytes =
        entry.payload instanceof Uint8Array
          ? entry.payload
          : new Uint8Array(entry.payload);

      if (entry.entry_type === WAL_ENTRY_STROKE_TILE_DELTA) {
        try {
          const decompressed = inflateSync(payloadBytes);
          const deltas = deserializeTileDeltas(decompressed);
          targetGrid.applyTileDeltas(deltas, 'redo');
          replayedStrokesCount++;
        } catch (err) {
          console.warn('[RecoveryService] Failed to replay stroke delta entry:', err);
        }
      } else if (entry.entry_type === WAL_ENTRY_VECTOR_STROKE) {
        try {
          const jsonStr = new TextDecoder().decode(inflateSync(payloadBytes));
          const parsed = JSON.parse(jsonStr);
          if (parsed.layerId && parsed.strokes) {
            const targetLayer = manifest.layers.find((l) => l.id === parsed.layerId);
            if (targetLayer) {
              targetLayer.vectorStrokes = parsed.strokes;
            }
          }
          replayedStrokesCount++;
        } catch (err) {
          console.warn('[RecoveryService] Failed to replay vector stroke entry:', err);
        }
      } else if (entry.entry_type === WAL_ENTRY_LAYER_MUTATION) {
        try {
          const jsonStr = new TextDecoder().decode(inflateSync(payloadBytes));
          const parsed = JSON.parse(jsonStr);
          if (parsed.layers) {
            const existingVectors = new Map<string, VectorStroke[]>();
            for (const l of manifest.layers) {
              if (l.vectorStrokes && l.vectorStrokes.length > 0) {
                existingVectors.set(l.id, l.vectorStrokes);
              }
            }
            manifest.layers = parsed.layers.map((l: LayerItem) => {
              if ((!l.vectorStrokes || l.vectorStrokes.length === 0) && existingVectors.has(l.id)) {
                return { ...l, vectorStrokes: existingVectors.get(l.id) };
              }
              return l;
            });
          }
          if (parsed.activeLayerId) {
            manifest.activeLayerId = parsed.activeLayerId;
          }
          replayedMutationsCount++;
        } catch (err) {
          console.warn('[RecoveryService] Failed to replay layer mutation entry:', err);
        }
      }
    }

    targetGrid.notifyChange(true);
    return { manifest, replayedStrokesCount, replayedMutationsCount };
  }
}

export const recoveryService = new RecoveryService();
