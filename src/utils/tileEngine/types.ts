/**
 * Core tile constants, types, coordinate helpers, and internal host contracts
 * for the Sparse Virtual Tile Engine.
 */

export const TILE_SIZE = 256;
export const TILE_PIXELS = TILE_SIZE * TILE_SIZE; // 65,536 pixels
export const BYTES_1BIT = TILE_PIXELS >> 3; // 8,192 bytes (8 KB)
export const BYTES_8BIT = TILE_PIXELS; // 65,536 bytes (64 KB)
export const BYTES_32BIT = TILE_PIXELS << 2; // 262,144 bytes (256 KB)

export type TileFormat = 'monochrome-1bit' | 'grayscale-8bit' | 'color-32bit';

export interface TileBuffer {
  layerId: string;
  tileX: number;
  tileY: number;
  format: TileFormat;
  data: Uint8Array | null; // null when paged out to disk
  dirty: boolean;
  version: number;
  isPagedToDisk: boolean;
  lastAccessTimestamp: number;
  lod: number; // 0 = 1:1 (256x256 doc area), 1 = 1/2 (512x512), 2 = 1/4 (1024x1024), 3 = 1/8 (2048x2048)
  solidColorU32?: number; // When defined on a color-32bit tile, all 65,536 pixels share this exact U32 RGBA value
}

export interface TileSnapshotEntry {
  format: TileFormat;
  data: Uint8Array | null;
}

export interface TileMemoryStats {
  totalBytes: number;
  activeBytes: number;
  pagedBytes: number;
  tileCount: number;
  activeTileCount: number;
  pagedTileCount: number;
  formatCounts: Record<TileFormat, number>;
  lodCounts: Record<number, number>;
}

export function getTileByteSize(format: TileFormat): number {
  if (format === 'monochrome-1bit') return BYTES_1BIT;
  if (format === 'grayscale-8bit') return BYTES_8BIT;
  return BYTES_32BIT;
}

// System endianness detection for 32-bit operations
export const isLittleEndian = (() => {
  if (typeof ArrayBuffer === 'undefined') return true;
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = 0x11223344;
  return new Uint8Array(buf)[0] === 0x44;
})();

// Default binary colors in system byte order
// Black ink: RGBA(0, 0, 0, 255)
export const INK_BLACK_U32 = isLittleEndian ? 0xff000000 : 0x000000ff;
// Transparent: RGBA(0, 0, 0, 0)
export const TRANSPARENT_U32 = 0x00000000;
// Paper white: RGBA(255, 255, 255, 255)
export const PAPER_WHITE_U32 = 0xffffffff;

/**
 * Get tile coordinate from document pixel coordinate.
 */
export function pixelToTileCoord(pixel: number, lod: number = 0): number {
  const tileSizeDoc = TILE_SIZE << lod;
  return Math.floor(pixel / tileSizeDoc);
}

/**
 * Spatial hash map key for tiles.
 * LOD 0 produces backwards-compatible key: `${layerId}:${tileX}:${tileY}`.
 * LOD > 0 produces: `${layerId}:${lod}:${tileX}:${tileY}`.
 */
export function getTileKey(layerId: string, tileX: number, tileY: number, lod: number = 0): string {
  return lod === 0 ? `${layerId}:${tileX}:${tileY}` : `${layerId}:${lod}:${tileX}:${tileY}`;
}

/**
 * Parse spatial hash map key into components.
 */
export function parseTileKey(key: string): { layerId: string; tileX: number; tileY: number; lod: number } {
  const parts = key.split(':');
  if (parts.length === 4) {
    return {
      layerId: parts[0],
      lod: parseInt(parts[1], 10),
      tileX: parseInt(parts[2], 10),
      tileY: parseInt(parts[3], 10),
    };
  }
  return {
    layerId: parts[0],
    tileX: parseInt(parts[1], 10),
    tileY: parseInt(parts[2], 10),
    lod: 0,
  };
}

let nextGlobalTileVersion = 1;

export function allocateTileVersion(): number {
  return ++nextGlobalTileVersion;
}

export function reserveTileVersion(version: number): void {
  if (Number.isFinite(version) && version > nextGlobalTileVersion) {
    nextGlobalTileVersion = Math.floor(version);
  }
}

/**
 * Allocate a new TileBuffer with zero-initialized memory.
 */
export function createTileBuffer(
  layerId: string,
  tileX: number,
  tileY: number,
  format: TileFormat,
  lod: number = 0
): TileBuffer {
  const size = getTileByteSize(format);

  return {
    layerId,
    tileX,
    tileY,
    format,
    data: new Uint8Array(size),
    dirty: true,
    version: allocateTileVersion(),
    isPagedToDisk: false,
    lastAccessTimestamp: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    lod,
  };
}

/**
 * Releases an HTMLCanvasElement's backing store immediately so Chromium/WebView2 reclaims RAM.
 */
export function releaseTemporaryCanvas(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // Ignore read-only or detached mock canvases in tests
  }
}

const TILE_COORD_BIAS = 32768;
const TILE_COORD_STRIDE = 65536;

export function packTileCoord(tx: number, ty: number): number {
  return (ty + TILE_COORD_BIAS) * TILE_COORD_STRIDE + (tx + TILE_COORD_BIAS);
}

export function unpackTileCoordX(packed: number): number {
  return (packed % TILE_COORD_STRIDE) - TILE_COORD_BIAS;
}

export function unpackTileCoordY(packed: number): number {
  return Math.floor(packed / TILE_COORD_STRIDE) - TILE_COORD_BIAS;
}

/**
 * Minimal grid contract consumed by TileMemoryManager to avoid circular module imports.
 */
export interface ISparseTileGridMemoryHost {
  tilesIterable(): IterableIterator<TileBuffer>;
  bumpLayerVersion(layerId: string): void;
  notifyChange(immediate?: boolean): void;
}

/**
 * Minimal memory-manager contract consumed by internal tileEngine helper modules.
 */
export interface ITileMemoryManagerHost {
  touchTile(tile: TileBuffer): void;
  notifyTileAllocated(tile: TileBuffer): void;
  notifyTileFreed(tile: TileBuffer): void;
  requestTileData(tile: TileBuffer): Promise<Uint8Array>;
}

/**
 * Internal host contract implemented by SparseTileGrid for modular tile operations.
 */
export interface ISparseTileGridHost extends ISparseTileGridMemoryHost {
  readonly tiles: Map<string, TileBuffer>;
  readonly layerLod0Tiles: Map<string, Set<TileBuffer>>;
  readonly layerLodOccupancy: Map<string, [Map<number, number>, Map<number, number>, Map<number, number>]>;
  readonly layerFormats: Map<string, TileFormat>;
  readonly ingestedLayers: Set<string>;
  readonly dirtyLodTiles: Set<string>;
  readonly layerVersions: Map<string, number>;
  readonly scratchRGBA: Uint8ClampedArray;
  readonly writeScratchRGBA: Uint8ClampedArray;
  getThumbCanvas(): HTMLCanvasElement | null;
  setThumbCanvas(canvas: HTMLCanvasElement | null): void;
  getMemoryManager(): ITileMemoryManagerHost | null;
  incrementGridEpochAndContentVersion(): void;
  registerLod0Tile(tile: TileBuffer): void;
  unregisterLod0Tile(tile: TileBuffer): void;
  hasLayerTiles(layerId: string): boolean;
  hasPopulatedLodTile(layerId: string, tileX: number, tileY: number, lod: number): boolean;
  setLayerFormat(layerId: string, format: TileFormat): void;
  getLayerFormat(layerId: string): TileFormat;
  getTile(layerId: string, tileX: number, tileY: number, lod?: number): TileBuffer | null;
  getOrCreateTile(layerId: string, tileX: number, tileY: number, format?: TileFormat, lod?: number): TileBuffer;
  setTile(layerId: string, tileX: number, tileY: number, tile: TileBuffer): void;
  deleteTile(layerId: string, tileX: number, tileY: number, lod?: number): void;
  getLayerTiles(layerId: string, lod?: number): TileBuffer[];
  getTileAsRGBA(tile: TileBuffer): Uint8ClampedArray;
  isLodTileDirty(layerId: string, tileX: number, tileY: number, lod: number): boolean;
  markLodAncestorsDirty(layerId: string, tileX: number, tileY: number): void;
  generateLodTile(layerId: string, lodTx: number, lodTy: number, targetLod: number): TileBuffer | null;
  getOrBuildLod3Tiles(layerId: string): TileBuffer[];
  writeImageData(
    layerId: string,
    imgData: { data: Uint8ClampedArray | Uint8Array; width: number; height: number },
    destX: number,
    destY: number,
    format?: TileFormat,
    suppressNotify?: boolean
  ): { minTileX: number; minTileY: number; maxTileX: number; maxTileY: number };
  renderLayerToCanvas(
    layerId: string,
    targetCanvas: HTMLCanvasElement,
    dirtyRect?: { x: number; y: number; width: number; height: number }
  ): void;
  fillLayerSolidWhite(layerId: string, width: number, height: number, format?: TileFormat): void;
  clearLayer(layerId: string): void;
  clearAll(): void;
}
