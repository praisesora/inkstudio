/**
 * Large-Canvas Virtual Memory and SSD Scratch Disk Engine
 * Sparse Virtual Tile Engine & Color Expression System
 *
 * Designed for 600 DPI professional manga production (B4: 7016 x 9921 px, ~70 MP)
 * and Webtoons (800 x 50,000+ px) with zero allocation for empty space, multi-format pixel packing
 * (1-bit monochrome at 8KB, 8-bit grayscale at 64KB, 32-bit RGBA at 256KB),
 * LRU tile memory budgeting with transparent background SSD scratch paging via Rust LZ4,
 * and an on-demand multi-resolution Mipmap Tile Pyramid (LOD 0 to LOD 3).
 */

import type { BlendMode, CanvasDimensions, DirtyRect, TileDelta } from '../types/editor';
import { TileMemoryManager, type TileMemoryManagerOptions } from './tileEngine/memoryManager';
import * as mipmapOps from './tileEngine/mipmap';
import { type CompositeStrokeOptions, compositeStrokeToTiles as compositeStrokeOp } from './tileEngine/strokeComposite';
import * as tileFillOps from './tileEngine/tileFill';
import * as tileIOOps from './tileEngine/tileIO';
import * as tileOps from './tileEngine/tileOps';
import * as tileRenderOps from './tileEngine/tileRender';
import * as tileSnapshotOps from './tileEngine/tileSnapshots';
import {
  BYTES_32BIT,
  type ISparseTileGridHost,
  type TileBuffer,
  type TileFormat,
  type TileMemoryStats,
  type TileSnapshotEntry,
  createTileBuffer,
  getTileKey,
  packTileCoord,
} from './tileEngine/types';

export {
  TILE_SIZE,
  TILE_PIXELS,
  BYTES_1BIT,
  BYTES_8BIT,
  BYTES_32BIT,
  getTileByteSize,
  isLittleEndian,
  INK_BLACK_U32,
  TRANSPARENT_U32,
  PAPER_WHITE_U32,
  pixelToTileCoord,
  getTileKey,
  parseTileKey,
  allocateTileVersion,
  reserveTileVersion,
  createTileBuffer,
  releaseTemporaryCanvas,
} from './tileEngine/types';
export type { TileFormat, TileBuffer, TileMemoryStats, TileSnapshotEntry } from './tileEngine/types';
export type { TileDelta } from '../types/editor';
export * from './tileEngine/pixelCodec';
export { downsample2x2ToParentTile } from './tileEngine/mipmap';
export * from './tileEngine/scratchDriver';
export * from './tileEngine/memoryManager';
export type { CompositeStrokeOptions } from './tileEngine/strokeComposite';
export * from './tileEngine/serialization';

let nextSparseTileGridId = 1;

/**
 * Sparse Virtual Tile Grid
 *
 * Sole authoritative backing store for all layer pixel data in Ink Studio.
 * Completely deprecates multi-gigabyte full-sized DOM layer canvases.
 */
export class SparseTileGrid {
  private readonly gridId: number = nextSparseTileGridId++;
  private tiles: Map<string, TileBuffer> = new Map();
  private layerLod0Tiles: Map<string, Set<TileBuffer>> = new Map();
  private layerLodOccupancy: Map<string, [Map<number, number>, Map<number, number>, Map<number, number>]> = new Map();
  private layerFormats: Map<string, TileFormat> = new Map();
  private ingestedLayers: Set<string> = new Set();
  private dirtyLodTiles: Set<string> = new Set();
  private scratchRGBA: Uint8ClampedArray = new Uint8ClampedArray(BYTES_32BIT);
  private writeScratchRGBA: Uint8ClampedArray = new Uint8ClampedArray(BYTES_32BIT);
  private thumbCanvas: HTMLCanvasElement | null = null;
  private listeners: Set<(immediate?: boolean) => void> = new Set();
  private memoryManager: TileMemoryManager | null = null;
  private layerVersions: Map<string, number> = new Map();
  private globalVersionCounter: number = 1;
  private contentVersion: number = 1;
  private gridEpoch: number = 0;
  private readonly host: ISparseTileGridHost;

  constructor(memoryManagerOptions?: TileMemoryManagerOptions) {
    this.host = {
      tiles: this.tiles,
      layerLod0Tiles: this.layerLod0Tiles,
      layerLodOccupancy: this.layerLodOccupancy,
      layerFormats: this.layerFormats,
      ingestedLayers: this.ingestedLayers,
      dirtyLodTiles: this.dirtyLodTiles,
      layerVersions: this.layerVersions,
      scratchRGBA: this.scratchRGBA,
      writeScratchRGBA: this.writeScratchRGBA,
      getThumbCanvas: () => this.thumbCanvas,
      setThumbCanvas: (canvas) => { this.thumbCanvas = canvas; },
      getMemoryManager: () => this.memoryManager,
      incrementGridEpochAndContentVersion: () => { this.gridEpoch++; this.contentVersion++; },
      registerLod0Tile: (tile) => tileSnapshotOps.registerLod0Tile(this.host, tile),
      unregisterLod0Tile: (tile) => tileSnapshotOps.unregisterLod0Tile(this.host, tile),
      tilesIterable: () => this.tilesIterable(),
      bumpLayerVersion: (id) => this.bumpLayerVersion(id),
      notifyChange: (imm) => this.notifyChange(imm),
      hasLayerTiles: (id) => this.hasLayerTiles(id),
      hasPopulatedLodTile: (id, tx, ty, lod) => this.hasPopulatedLodTile(id, tx, ty, lod),
      setLayerFormat: (id, fmt) => this.setLayerFormat(id, fmt),
      getLayerFormat: (id) => this.getLayerFormat(id),
      getTile: (id, tx, ty, lod) => this.getTile(id, tx, ty, lod),
      getOrCreateTile: (id, tx, ty, fmt, lod) => this.getOrCreateTile(id, tx, ty, fmt, lod),
      setTile: (id, tx, ty, tile) => this.setTile(id, tx, ty, tile),
      deleteTile: (id, tx, ty, lod) => this.deleteTile(id, tx, ty, lod),
      getLayerTiles: (id, lod) => this.getLayerTiles(id, lod),
      getTileAsRGBA: (tile) => this.getTileAsRGBA(tile),
      isLodTileDirty: (id, tx, ty, lod) => this.isLodTileDirty(id, tx, ty, lod),
      markLodAncestorsDirty: (id, tx, ty) => this.markLodAncestorsDirty(id, tx, ty),
      generateLodTile: (id, tx, ty, lod) => this.generateLodTile(id, tx, ty, lod),
      getOrBuildLod3Tiles: (id) => this.getOrBuildLod3Tiles(id),
      writeImageData: (id, img, dx, dy, fmt, sup) => this.writeImageData(id, img, dx, dy, fmt, sup),
      renderLayerToCanvas: (id, c, r) => this.renderLayerToCanvas(id, c, r),
      fillLayerSolidWhite: (id, w, h, fmt) => this.fillLayerSolidWhite(id, w, h, fmt),
      clearLayer: (id) => this.clearLayer(id),
      clearAll: () => this.clearAll(),
    };
    this.memoryManager = new TileMemoryManager(this, memoryManagerOptions);
  }

  public getGridId(): number {
    return this.gridId;
  }

  public hasLayerTiles(layerId: string): boolean {
    const set = this.layerLod0Tiles.get(layerId);
    return set !== undefined && set.size > 0;
  }

  public hasPopulatedLodTile(layerId: string, tileX: number, tileY: number, lod: number): boolean {
    if (lod <= 0) {
      return this.tiles.has(getTileKey(layerId, tileX, tileY, 0));
    }
    const idx = lod - 1;
    if (idx < 0 || idx > 2) return false;
    const occ = this.layerLodOccupancy.get(layerId);
    return occ !== undefined && (occ[idx].get(packTileCoord(tileX, tileY)) ?? 0) > 0;
  }

  public getContentVersion(): number {
    return this.contentVersion;
  }

  public getLayerVersion(layerId: string): number {
    return this.layerVersions.get(layerId) ?? 0;
  }

  public bumpLayerVersion(layerId: string): void {
    this.layerVersions.set(layerId, ++this.globalVersionCounter);
    this.contentVersion++;
  }

  public getGridEpoch(): number {
    return this.gridEpoch;
  }

  public setMemoryManager(manager: TileMemoryManager | null): void {
    this.memoryManager = manager;
  }

  public getMemoryManager(): TileMemoryManager | null {
    return this.memoryManager;
  }

  public subscribe(listener: (immediate?: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public notifyChange(immediate?: boolean): void {
    this.listeners.forEach((fn) => fn(immediate));
  }

  public setLayerFormat(layerId: string, format: TileFormat): void {
    this.layerFormats.set(layerId, format);
  }

  public getLayerFormat(layerId: string): TileFormat {
    return this.layerFormats.get(layerId) || 'color-32bit';
  }

  public isLayerIngested(layerId: string): boolean {
    return this.ingestedLayers.has(layerId);
  }

  public markLayerIngested(layerId: string): void {
    this.ingestedLayers.add(layerId);
  }

  public hasTile(layerId: string, tileX: number, tileY: number, lod: number = 0): boolean {
    return this.tiles.has(getTileKey(layerId, tileX, tileY, lod));
  }

  public getTile(layerId: string, tileX: number, tileY: number, lod: number = 0): TileBuffer | null {
    const tile = this.tiles.get(getTileKey(layerId, tileX, tileY, lod)) || null;
    if (tile && this.memoryManager) {
      this.memoryManager.touchTile(tile);
    }
    return tile;
  }

  public getOrCreateTile(
    layerId: string,
    tileX: number,
    tileY: number,
    format?: TileFormat,
    lod: number = 0
  ): TileBuffer {
    const key = getTileKey(layerId, tileX, tileY, lod);
    let tile = this.tiles.get(key);
    if (!tile) {
      const fmt = format || this.getLayerFormat(layerId);
      tile = createTileBuffer(layerId, tileX, tileY, fmt, lod);
      this.tiles.set(key, tile);
      if (lod === 0) tileSnapshotOps.registerLod0Tile(this.host, tile);
      this.memoryManager?.notifyTileAllocated(tile);
    } else if (tile.data === null && tile.isPagedToDisk && this.memoryManager) {
      void this.memoryManager.requestTileData(tile);
    } else {
      this.memoryManager?.touchTile(tile);
    }
    return tile;
  }

  public setTile(layerId: string, tileX: number, tileY: number, tile: TileBuffer): void {
    const key = getTileKey(layerId, tileX, tileY, tile.lod);
    const existing = this.tiles.get(key);
    if (existing) {
      if ((existing.lod ?? 0) === 0) tileSnapshotOps.unregisterLod0Tile(this.host, existing);
      this.memoryManager?.notifyTileFreed(existing);
    }
    this.tiles.set(key, tile);
    if ((tile.lod ?? 0) === 0) tileSnapshotOps.registerLod0Tile(this.host, tile);
    this.memoryManager?.notifyTileAllocated(tile);
    if (tile.lod === 0) {
      this.setLayerFormat(layerId, tile.format);
      this.markLodAncestorsDirty(layerId, tileX, tileY);
      this.bumpLayerVersion(layerId);
    }
    this.notifyChange();
  }

  public deleteTile(layerId: string, tileX: number, tileY: number, lod: number = 0): void {
    const key = getTileKey(layerId, tileX, tileY, lod);
    const tile = this.tiles.get(key);
    if (tile) {
      if ((tile.lod ?? 0) === 0) tileSnapshotOps.unregisterLod0Tile(this.host, tile);
      this.memoryManager?.notifyTileFreed(tile);
      this.tiles.delete(key);
      if (lod === 0) {
        this.markLodAncestorsDirty(layerId, tileX, tileY);
        this.bumpLayerVersion(layerId);
      }
    }
  }

  public getLayerTiles(layerId: string, lod: number = 0): TileBuffer[] {
    if (lod === 0) {
      const set = this.layerLod0Tiles.get(layerId);
      return set ? Array.from(set) : [];
    }
    const result: TileBuffer[] = [];
    for (const tile of this.tiles.values()) {
      if (tile.layerId === layerId && (tile.lod ?? 0) === lod) {
        result.push(tile);
      }
    }
    return result;
  }

  public getTilesInBounds(layerId: string, minX: number, minY: number, maxX: number, maxY: number, lod: number = 0): TileBuffer[] {
    return tileIOOps.getTilesInBounds(this.host, layerId, minX, minY, maxX, maxY, lod);
  }

  public getIntersectingCoords(minX: number, minY: number, maxX: number, maxY: number, lod: number = 0): Array<{ tileX: number; tileY: number }> {
    return tileIOOps.getIntersectingCoords(minX, minY, maxX, maxY, lod);
  }

  public getTileAsRGBA(tile: TileBuffer): Uint8ClampedArray {
    return tileIOOps.getTileAsRGBA(this.host, tile);
  }

  public writeImageData(
    layerId: string,
    imgData: { data: Uint8ClampedArray | Uint8Array; width: number; height: number },
    destX: number,
    destY: number,
    format?: TileFormat,
    suppressNotify: boolean = false
  ): { minTileX: number; minTileY: number; maxTileX: number; maxTileY: number } {
    return tileIOOps.writeImageData(this.host, layerId, imgData, destX, destY, format, suppressNotify);
  }

  public compositeStrokeToTiles(options: CompositeStrokeOptions): boolean {
    return compositeStrokeOp(this.host, options);
  }

  public readImageData(layerId: string, x: number, y: number, width: number, height: number): { data: Uint8ClampedArray; width: number; height: number } {
    return tileIOOps.readImageData(this.host, layerId, x, y, width, height);
  }

  public renderLayerToCanvas(layerId: string, targetCanvas: HTMLCanvasElement, dirtyRect?: { x: number; y: number; width: number; height: number }): void {
    tileRenderOps.renderLayerToCanvas(this.host, layerId, targetCanvas, dirtyRect);
  }

  public createRegionCanvas(layerId: string, rect: { x: number; y: number; width: number; height: number }, targetCanvas?: HTMLCanvasElement | null): HTMLCanvasElement | null {
    return tileRenderOps.createRegionCanvas(this.host, layerId, rect, targetCanvas);
  }

  public exportLayerToCanvas(layerId: string, width: number, height: number): HTMLCanvasElement | null {
    return tileRenderOps.exportLayerToCanvas(this.host, layerId, width, height);
  }

  public getOrBuildLodTiles(layerId: string, targetLod: number): TileBuffer[] {
    return mipmapOps.getOrBuildLodTiles(this.host, layerId, targetLod);
  }

  public getOrBuildLod3Tiles(layerId: string): TileBuffer[] {
    return this.getOrBuildLodTiles(layerId, 3);
  }

  public generateThumbnail(layerId: string, thumbWidth: number, thumbHeight: number, docDimensions: { width: number; height: number }, preserveAlpha: boolean = true): string {
    return tileRenderOps.generateThumbnail(this.host, layerId, thumbWidth, thumbHeight, docDimensions, preserveAlpha);
  }

  public isLodTileDirty(layerId: string, tileX: number, tileY: number, lod: number): boolean {
    return mipmapOps.isLodTileDirty(this.host, layerId, tileX, tileY, lod);
  }

  public markLodAncestorsDirty(layerId: string, tileX: number, tileY: number): void {
    mipmapOps.markLodAncestorsDirty(this.host, layerId, tileX, tileY);
  }

  public generateLodTile(layerId: string, lodTx: number, lodTy: number, targetLod: number): TileBuffer | null {
    return mipmapOps.generateLodTile(this.host, layerId, lodTx, lodTy, targetLod);
  }

  public updateDirtyMipmaps(maxCount: number = 16): number {
    return mipmapOps.updateDirtyMipmaps(this.host, maxCount);
  }

  public flushMipmaps(layerId?: string): void {
    mipmapOps.flushMipmaps(this.host, layerId);
  }

  public fillLayerSolidColor(layerId: string, width: number, height: number, colorCss: string, format?: TileFormat): void {
    tileFillOps.fillLayerSolidColor(this.host, layerId, width, height, colorCss, format);
  }

  public fillLayerSolidWhite(layerId: string, width: number, height: number, format?: TileFormat): void {
    tileFillOps.fillLayerSolidWhite(this.host, layerId, width, height, format);
  }

  public ingestCanvas(layerId: string, canvas: HTMLCanvasElement, format?: TileFormat): void {
    tileFillOps.ingestCanvas(this.host, layerId, canvas, format);
  }

  public clearLayer(layerId: string): void {
    tileSnapshotOps.clearLayer(this.host, layerId);
  }

  public cloneLayer(srcLayerId: string, dstLayerId: string): void {
    tileSnapshotOps.cloneLayer(this.host, srcLayerId, dstLayerId);
  }

  public getMemoryStats(): TileMemoryStats {
    return tileSnapshotOps.getMemoryStats(this.host);
  }

  public snapshotLayerTiles(layerId: string): Map<string, TileSnapshotEntry> {
    return tileSnapshotOps.snapshotLayerTiles(this.host, layerId);
  }

  public snapshotTilesInRect(layerId: string, bounds: { x: number; y: number; width: number; height: number }): Map<string, TileSnapshotEntry> {
    return tileSnapshotOps.snapshotTilesInRect(this.host, layerId, bounds);
  }

  public computeDeltasFromSnapshot(beforeSnapshot: Map<string, TileSnapshotEntry>, layerId: string, bounds?: { x: number; y: number; width: number; height: number }): TileDelta[] {
    return tileSnapshotOps.computeDeltasFromSnapshot(this.host, beforeSnapshot, layerId, bounds);
  }

  public applyTileDeltas(deltas: TileDelta[], direction: 'undo' | 'redo'): void {
    tileSnapshotOps.applyTileDeltas(this.host, deltas, direction);
  }

  public clearAll(): void {
    tileSnapshotOps.clearAll(this.host);
  }

  public tilesIterable(): IterableIterator<TileBuffer> {
    return this.tiles.values();
  }

  public getAllTiles(): TileBuffer[] {
    return Array.from(this.tiles.values());
  }

  public getAllLayerFormats(): Map<string, TileFormat> {
    return new Map(this.layerFormats);
  }

  public restoreFromSnapshot(tiles: TileBuffer[], layerFormats?: Map<string, TileFormat>): void {
    tileSnapshotOps.restoreFromSnapshot(this.host, tiles, layerFormats);
  }

  public getPixelRGBA(
    layerId: string,
    x: number,
    y: number,
    out?: [number, number, number, number]
  ): [number, number, number, number] {
    return tileOps.getPixelRGBA(this.host, layerId, x, y, out);
  }

  public snapshotSingleTileInto(
    layerId: string,
    tileX: number,
    tileY: number,
    snapshotOut: Map<string, TileSnapshotEntry>
  ): void {
    tileOps.snapshotSingleTileInto(this.host, layerId, tileX, tileY, snapshotOut);
  }

  public restoreLayerSnapshot(
    layerId: string,
    snapshot: Map<string, TileSnapshotEntry>,
    suppressNotify: boolean = false
  ): void {
    tileOps.restoreLayerSnapshot(this.host, layerId, snapshot, suppressNotify);
  }

  public getLayerTileBounds(layerId: string, dims: CanvasDimensions): DirtyRect | null {
    return tileOps.getLayerTileBounds(this.host, layerId, dims);
  }

  public getLayerContentBounds(
    layerId: string,
    dims: CanvasDimensions,
    isBackground: boolean = false
  ): DirtyRect | null {
    return tileOps.getLayerContentBounds(this.host, layerId, dims, isBackground);
  }

  public pruneEmptyTiles(layerId: string): number {
    return tileOps.pruneEmptyTiles(this.host, layerId);
  }

  public clearRectInLayer(
    layerId: string,
    rect: DirtyRect,
    fillWhite: boolean = false,
    snapshotOut?: Map<string, TileSnapshotEntry>,
    suppressNotify: boolean = false
  ): void {
    tileOps.clearRectInLayer(this.host, layerId, rect, fillWhite, snapshotOut, suppressNotify);
  }

  public transformLayerTiles(
    layerId: string,
    visitor: (rgba: Uint8ClampedArray, tileX: number, tileY: number) => boolean | void,
    options?: {
      targetFormat?: TileFormat;
      monoThreshold?: number;
      snapshotOut?: Map<string, TileSnapshotEntry>;
      suppressNotify?: boolean;
    }
  ): boolean {
    return tileOps.transformLayerTiles(this.host, layerId, visitor, options);
  }

  public mergeLayersInGrid(
    srcLayerId: string,
    dstLayerId: string,
    options: {
      opacity: number;
      blendMode: BlendMode;
      visible: boolean;
      maskCanvas?: HTMLCanvasElement;
      maskEnabled?: boolean;
      dimensions: CanvasDimensions;
      dstFormat?: TileFormat;
    }
  ): void {
    tileOps.mergeLayersInGrid(this.host, srcLayerId, dstLayerId, options);
  }

  public applyMaskCanvasToLayer(
    layerId: string,
    maskCanvas: HTMLCanvasElement,
    dimensions: CanvasDimensions
  ): void {
    tileOps.applyMaskCanvasToLayer(this.host, layerId, maskCanvas, dimensions);
  }

  public resizeLayerInGrid(
    layerId: string,
    oldDims: CanvasDimensions,
    newDims: CanvasDimensions,
    options: {
      scaleContent: boolean;
      offsetX: number;
      offsetY: number;
      isBackground: boolean;
      backgroundColor: string;
      targetFormat: TileFormat;
    }
  ): void {
    tileOps.resizeLayerInGrid(this.host, layerId, oldDims, newDims, options);
  }

  public copyLayerTilesSnapshot(layerId: string): {
    format: TileFormat;
    tiles: Array<{ tileX: number; tileY: number; format: TileFormat; data: Uint8Array }>;
  } {
    return tileOps.copyLayerTilesSnapshot(this.host, layerId);
  }

  public pasteLayerTilesSnapshot(
    dstLayerId: string,
    snapshot: {
      format: TileFormat;
      tiles: Array<{ tileX: number; tileY: number; format: TileFormat; data: Uint8Array }>;
    }
  ): void {
    tileOps.pasteLayerTilesSnapshot(this.host, dstLayerId, snapshot);
  }
}

// Global sparse tile grid singleton
export const globalTileGrid = new SparseTileGrid();
export const globalTileMemoryManager = globalTileGrid.getMemoryManager()!;
