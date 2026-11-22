/**
 * Scratch Disk Driver interface, binary IPC batch codec,
 * and Tauri v2 / In-Memory driver implementations.
 */

export interface TileWritePayload {
  layerId: string;
  tileX: number;
  tileY: number;
  data: Uint8Array;
}

export interface IScratchDiskDriver {
  init(sessionId: string): Promise<void>;
  writeTiles(sessionId: string, tiles: TileWritePayload[]): Promise<number>;
  readTile(sessionId: string, layerId: string, tileX: number, tileY: number): Promise<Uint8Array>;
  clear(sessionId: string): Promise<void>;
}

export function isTauriEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    (window as any).__TAURI_INTERNALS__ ||
    (window as any).__TAURI__ ||
    (window as any).isTauri
  );
}

const _tileBatchEncoder = new TextEncoder();
const _tileBatchDecoder = new TextDecoder();
const MIN_TILE_BATCH_RECORD_BYTES = 14; // layerIdLen(u16) + tx(i32) + ty(i32) + dataLen(u32)

/**
 * Packs a batch of tiles into a compact little-endian binary frame for raw Tauri IPC:
 * `[count:u32][layerIdLen:u16, layerId(utf8), tx:i32, ty:i32, dataLen:u32, data]...`
 */
export function packTileWriteBatch(tiles: TileWritePayload[]): Uint8Array {
  const encodedIds: Uint8Array[] = new Array(tiles.length);
  let totalBytes = 4;

  for (let i = 0; i < tiles.length; i++) {
    const idBytes = _tileBatchEncoder.encode(tiles[i].layerId);
    if (idBytes.byteLength > 0xffff) {
      throw new Error(`Layer ID exceeds u16 byte length limit: ${tiles[i].layerId}`);
    }
    encodedIds[i] = idBytes;
    totalBytes += MIN_TILE_BATCH_RECORD_BYTES + idBytes.byteLength + tiles[i].data.byteLength;
  }

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, tiles.length, true);

  let offset = 4;
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    const idBytes = encodedIds[i];

    view.setUint16(offset, idBytes.byteLength, true);
    offset += 2;

    out.set(idBytes, offset);
    offset += idBytes.byteLength;

    view.setInt32(offset, t.tileX, true);
    offset += 4;

    view.setInt32(offset, t.tileY, true);
    offset += 4;

    view.setUint32(offset, t.data.byteLength, true);
    offset += 4;

    out.set(t.data, offset);
    offset += t.data.byteLength;
  }

  return out;
}

/**
 * Unpacks a compact binary tile batch frame back into TileWritePayload entries.
 */
export function unpackTileWriteBatch(buffer: Uint8Array | ArrayBuffer): TileWritePayload[] {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 4) {
    throw new Error('Truncated tile batch header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count > Math.floor((bytes.byteLength - 4) / MIN_TILE_BATCH_RECORD_BYTES)) {
    throw new Error('Truncated tile batch payload');
  }

  const tiles: TileWritePayload[] = new Array(count);
  let offset = 4;

  for (let i = 0; i < count; i++) {
    if (offset + 2 > bytes.byteLength) {
      throw new Error('Truncated tile record layerIdLen');
    }
    const idLen = view.getUint16(offset, true);
    offset += 2;

    if (offset + idLen + 12 > bytes.byteLength) {
      throw new Error('Truncated tile record metadata');
    }
    const layerId = _tileBatchDecoder.decode(bytes.subarray(offset, offset + idLen));
    offset += idLen;

    const tileX = view.getInt32(offset, true);
    offset += 4;
    const tileY = view.getInt32(offset, true);
    offset += 4;
    const dataLen = view.getUint32(offset, true);
    offset += 4;

    if (offset + dataLen > bytes.byteLength) {
      throw new Error('Truncated tile record data');
    }
    const data = bytes.slice(offset, offset + dataLen);
    offset += dataLen;

    tiles[i] = { layerId, tileX, tileY, data };
  }

  if (offset !== bytes.byteLength) {
    throw new Error('Unexpected trailing bytes in tile batch payload');
  }

  return tiles;
}

/**
 * Production Tauri v2 Rust Scratch Disk Driver.
 * Direct raw binary IPC with high-throughput LZ4 compression and atomic file index tables.
 */
export class TauriScratchDiskDriver implements IScratchDiskDriver {
  private invokePromise: Promise<typeof import('@tauri-apps/api/core').invoke> | null = null;

  private getInvoke(): Promise<typeof import('@tauri-apps/api/core').invoke> {
    if (!this.invokePromise) {
      this.invokePromise = import('@tauri-apps/api/core').then((m) => m.invoke);
    }
    return this.invokePromise;
  }

  public async init(sessionId: string): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke('scratch_disk_init', { sessionId });
  }

  public async writeTiles(sessionId: string, tiles: TileWritePayload[]): Promise<number> {
    if (tiles.length === 0) return 0;
    const invoke = await this.getInvoke();
    const packed = packTileWriteBatch(tiles);
    return invoke<number>('scratch_disk_write_tiles', packed, {
      headers: {
        'x-session-id': encodeURIComponent(sessionId),
      },
    });
  }

  public async readTile(sessionId: string, layerId: string, tileX: number, tileY: number): Promise<Uint8Array> {
    const invoke = await this.getInvoke();
    const raw = await invoke<ArrayBuffer | Uint8Array | number[]>('scratch_disk_read_tile', undefined, {
      headers: {
        'x-session-id': encodeURIComponent(sessionId),
        'x-layer-id': encodeURIComponent(layerId),
        'x-tile-x': String(tileX),
        'x-tile-y': String(tileY),
      },
    });
    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    return new Uint8Array(raw);
  }

  public async clear(sessionId: string): Promise<void> {
    const invoke = await this.getInvoke();
    await invoke('scratch_disk_clear', { sessionId });
  }
}

/**
 * High-speed In-Memory / Fallback Scratch Disk Driver.
 * Used during automated Vitest suites and pure browser previews without Tauri.
 */
export class InMemoryScratchDiskDriver implements IScratchDiskDriver {
  private storage: Map<string, Uint8Array> = new Map();

  public async init(sessionId: string): Promise<void> {
    await this.clear(sessionId);
  }

  public async writeTiles(sessionId: string, tiles: TileWritePayload[]): Promise<number> {
    for (const t of tiles) {
      const copy = new Uint8Array(t.data.byteLength);
      copy.set(t.data);
      this.storage.set(`${sessionId}:${t.layerId}:${t.tileX}:${t.tileY}`, copy);
    }
    return tiles.length;
  }

  public async readTile(sessionId: string, layerId: string, tileX: number, tileY: number): Promise<Uint8Array> {
    const key = `${sessionId}:${layerId}:${tileX}:${tileY}`;
    const found = this.storage.get(key);
    if (!found) {
      throw new Error(`Tile not found on in-memory scratch disk: ${key}`);
    }
    const copy = new Uint8Array(found.byteLength);
    copy.set(found);
    return copy;
  }

  public async clear(sessionId: string): Promise<void> {
    const prefix = `${sessionId}:`;
    for (const key of Array.from(this.storage.keys())) {
      if (key.startsWith(prefix)) {
        this.storage.delete(key);
      }
    }
  }
}

export function createDefaultScratchDiskDriver(): IScratchDiskDriver {
  return isTauriEnvironment() ? new TauriScratchDiskDriver() : new InMemoryScratchDiskDriver();
}
