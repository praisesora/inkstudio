/**
 * Multi-Resolution Mipmap Downsampling (2x2 Child Tiles -> 1 Parent LOD Tile)
 * and on-demand LOD 1..3 pyramid generation / invalidation.
 */

import {
  packRGBATo1Bit,
  packRGBATo8Bit,
  unpack1BitToRGBA,
  unpack8BitToRGBA,
} from './pixelCodec';
import {
  BYTES_1BIT,
  BYTES_32BIT,
  BYTES_8BIT,
  ISparseTileGridHost,
  TILE_PIXELS,
  TILE_SIZE,
  TileBuffer,
  TileFormat,
  allocateTileVersion,
  createTileBuffer,
  getTileByteSize,
  getTileKey,
  isLittleEndian,
  parseTileKey,
  unpackTileCoordX,
  unpackTileCoordY,
} from './types';

const _downsampleRgbaScratch = new Uint8ClampedArray(BYTES_32BIT);
const _downsampleRgbaView = new Uint8Array(_downsampleRgbaScratch.buffer);
const _downsample8BitScratch = new Uint8Array(BYTES_8BIT);
const _downsample1BitScratch = new Uint8Array(BYTES_1BIT);

// Precomputed 256-entry LUT mapping an 8-bit 1-bit-row byte to a 4-bit downsampled nibble (2x1 horizontal OR)
const _lut1BitByteToNibble = (() => {
  const lut = new Uint8Array(256);
  for (let b = 0; b < 256; b++) {
    let nib = 0;
    if (b & 0xc0) nib |= 0x08;
    if (b & 0x30) nib |= 0x04;
    if (b & 0x0c) nib |= 0x02;
    if (b & 0x03) nib |= 0x01;
    lut[b] = nib;
  }
  return lut;
})();

// Fast 2-bit popcount and coverage RGBA LUT for box-filtering monochrome-1bit -> color-32bit LOD tiles
const _pop2 = new Uint8Array([0, 1, 1, 2]);
const _monoCovU32 = new Uint32Array(
  isLittleEndian
    ? [0x00000000, 0x40000000, 0x80000000, 0xbf000000, 0xff000000]
    : [0x00000000, 0x00000040, 0x00000080, 0x000000bf, 0x000000ff]
);

/**
 * Downsample 4 child tiles (2x2 cluster) at LOD k-1 into a single destination tile at LOD k.
 * Reuses pre-allocated scratch buffers for zero 256KB heap allocations during zoom-out LOD builds.
 */
export function downsample2x2ToParentTile(
  childTiles: [TileBuffer | null, TileBuffer | null, TileBuffer | null, TileBuffer | null],
  dstTile: TileBuffer
): boolean {
  const c0 = childTiles[0];
  const c1 = childTiles[1];
  const c2 = childTiles[2];
  const c3 = childTiles[3];
  if (
    (!c0 || c0.data === null) &&
    (!c1 || c1.data === null) &&
    (!c2 || c2.data === null) &&
    (!c3 || c3.data === null)
  ) {
    dstTile.solidColorU32 = undefined;
    return false;
  }

  if (!dstTile.data) {
    dstTile.data = new Uint8Array(getTileByteSize(dstTile.format));
  }

  const format = dstTile.format;
  const dst = dstTile.data;
  dstTile.solidColorU32 = undefined;

  // Fast path #1: All 4 child tiles are identical solid color-32bit tiles (e.g. solid white paper)
  if (
    format === 'color-32bit' &&
    c0 && c1 && c2 && c3 &&
    c0.solidColorU32 !== undefined &&
    c0.solidColorU32 === c1.solidColorU32 &&
    c0.solidColorU32 === c2.solidColorU32 &&
    c0.solidColorU32 === c3.solidColorU32
  ) {
    const dst32 = new Uint32Array(dst.buffer, dst.byteOffset, TILE_PIXELS);
    dst32.fill(c0.solidColorU32);
    dstTile.solidColorU32 = c0.solidColorU32;
    dstTile.dirty = false;
    dstTile.version++;
    return true;
  }

  dst.fill(0);
  const dst32 = format === 'color-32bit'
    ? new Uint32Array(dst.buffer, dst.byteOffset, TILE_PIXELS)
    : null;

  for (let q = 0; q < 4; q++) {
    const child = childTiles[q];
    if (!child || !child.data) continue;

    let childData = child.data;
    const xBase = (q & 1) ? 128 : 0;
    const yBase = (q >= 2) ? 128 : 0;

    if (format === 'color-32bit') {
      // Fast path #2: Uniform solid quadrant
      if (child.solidColorU32 !== undefined && dst32) {
        const fillU32 = child.solidColorU32;
        for (let ly = 0; ly < 128; ly++) {
          const rowStart = (yBase + ly) * TILE_SIZE + xBase;
          dst32.fill(fillU32, rowStart, rowStart + 128);
        }
        continue;
      }

      if (child.format === 'monochrome-1bit' && dst32) {
        // Fast zero-unpack 2x2 bit-counting box filter: 1-bit ink -> anti-aliased black coverage RGBA
        for (let ly = 0; ly < 128; ly++) {
          const sy0 = ly << 1;
          const srcRow0 = sy0 << 5;
          const srcRow1 = (sy0 + 1) << 5;
          const dstRowBase = (yBase + ly) * TILE_SIZE + xBase;
          for (let bx = 0; bx < 32; bx++) {
            const b0 = childData[srcRow0 + bx];
            const b1 = childData[srcRow1 + bx];
            if ((b0 | b1) === 0) continue;
            const outOff = dstRowBase + (bx << 2);
            dst32[outOff] = _monoCovU32[_pop2[(b0 >> 6) & 3] + _pop2[(b1 >> 6) & 3]];
            dst32[outOff + 1] = _monoCovU32[_pop2[(b0 >> 4) & 3] + _pop2[(b1 >> 4) & 3]];
            dst32[outOff + 2] = _monoCovU32[_pop2[(b0 >> 2) & 3] + _pop2[(b1 >> 2) & 3]];
            dst32[outOff + 3] = _monoCovU32[_pop2[b0 & 3] + _pop2[b1 & 3]];
          }
        }
        continue;
      } else if (child.format === 'monochrome-1bit') {
        unpack1BitToRGBA(childData, _downsampleRgbaScratch);
        childData = _downsampleRgbaView;
      } else if (child.format === 'grayscale-8bit') {
        unpack8BitToRGBA(childData, _downsampleRgbaScratch);
        childData = _downsampleRgbaView;
      }
      for (let ly = 0; ly < 128; ly++) {
        const sy0 = ly << 1;
        const dy = yBase + ly;
        const dstRowOffset = dy * TILE_SIZE + xBase;
        const srcRowOffset0 = sy0 * TILE_SIZE;
        const srcRowOffset1 = (sy0 + 1) * TILE_SIZE;

        for (let lx = 0; lx < 128; lx++) {
          const sx0 = lx << 1;
          const p00 = (srcRowOffset0 + sx0) << 2;
          const p10 = p00 + 4;
          const p01 = (srcRowOffset1 + sx0) << 2;
          const p11 = p01 + 4;

          const a0 = childData[p00 + 3];
          const a1 = childData[p10 + 3];
          const a2 = childData[p01 + 3];
          const a3 = childData[p11 + 3];
          const sumA = a0 + a1 + a2 + a3;

          if (sumA === 0) {
            continue; // dst is already zero-initialized
          }
          const outIdx = (dstRowOffset + lx) << 2;
          if (sumA === 1020) {
            dst[outIdx] = (childData[p00] + childData[p10] + childData[p01] + childData[p11] + 2) >> 2;
            dst[outIdx + 1] = (childData[p00 + 1] + childData[p10 + 1] + childData[p01 + 1] + childData[p11 + 1] + 2) >> 2;
            dst[outIdx + 2] = (childData[p00 + 2] + childData[p10 + 2] + childData[p01 + 2] + childData[p11 + 2] + 2) >> 2;
            dst[outIdx + 3] = 255;
          } else {
            const halfA = sumA >> 1;
            dst[outIdx + 3] = sumA >> 2;
            dst[outIdx] = ((childData[p00] * a0 + childData[p10] * a1 + childData[p01] * a2 + childData[p11] * a3 + halfA) / sumA) | 0;
            dst[outIdx + 1] = ((childData[p00 + 1] * a0 + childData[p10 + 1] * a1 + childData[p01 + 1] * a2 + childData[p11 + 1] * a3 + halfA) / sumA) | 0;
            dst[outIdx + 2] = ((childData[p00 + 2] * a0 + childData[p10 + 2] * a1 + childData[p01 + 2] * a2 + childData[p11 + 2] * a3 + halfA) / sumA) | 0;
          }
        }
      }
    } else if (format === 'grayscale-8bit') {
      if (child.format === 'color-32bit') {
        packRGBATo8Bit(childData, _downsample8BitScratch);
        childData = _downsample8BitScratch;
      } else if (child.format === 'monochrome-1bit') {
        unpack1BitToRGBA(childData, _downsampleRgbaScratch);
        packRGBATo8Bit(_downsampleRgbaScratch, _downsample8BitScratch);
        childData = _downsample8BitScratch;
      }
      for (let ly = 0; ly < 128; ly++) {
        const sy0 = ly << 1;
        const sy1 = sy0 + 1;
        const dy = yBase + ly;
        const dstRowOffset = dy * TILE_SIZE;
        const srcRowOffset0 = sy0 * TILE_SIZE;
        const srcRowOffset1 = sy1 * TILE_SIZE;

        for (let lx = 0; lx < 128; lx++) {
          const sx0 = lx << 1;
          const sx1 = sx0 + 1;
          const dx = xBase + lx;

          const v00 = childData[srcRowOffset0 + sx0];
          const v10 = childData[srcRowOffset0 + sx1];
          const v01 = childData[srcRowOffset1 + sx0];
          const v11 = childData[srcRowOffset1 + sx1];

          dst[dstRowOffset + dx] = (v00 + v10 + v01 + v11) >> 2;
        }
      }
    } else {
      if (child.format === 'color-32bit') {
        packRGBATo1Bit(childData, _downsample1BitScratch);
        childData = _downsample1BitScratch;
      } else if (child.format === 'grayscale-8bit') {
        unpack8BitToRGBA(childData, _downsampleRgbaScratch);
        packRGBATo1Bit(_downsampleRgbaScratch, _downsample1BitScratch);
        childData = _downsample1BitScratch;
      }
      const dstByteBaseX = xBase >> 3;
      for (let ly = 0; ly < 128; ly++) {
        const sy0 = ly << 1;
        const srcRow0 = sy0 << 5;
        const srcRow1 = (sy0 + 1) << 5;
        const dstRow = ((yBase + ly) << 5) + dstByteBaseX;

        for (let bx = 0; bx < 16; bx++) {
          const sBx = bx << 1;
          const comb0 = childData[srcRow0 + sBx] | childData[srcRow1 + sBx];
          const comb1 = childData[srcRow0 + sBx + 1] | childData[srcRow1 + sBx + 1];
          dst[dstRow + bx] = (_lut1BitByteToNibble[comb0] << 4) | _lut1BitByteToNibble[comb1];
        }
      }
    }
  }

  dstTile.dirty = false;
  dstTile.version++;
  return true;
}

/**
 * Ensures mipmap tiles at `targetLod` (0..3) exist and are up-to-date for all populated regions of `layerId`.
 */
export function getOrBuildLodTiles(
  host: ISparseTileGridHost,
  layerId: string,
  targetLod: number
): TileBuffer[] {
  const lod = Math.max(0, Math.min(3, Math.floor(targetLod)));
  if (lod === 0) {
    return host.getLayerTiles(layerId);
  }

  const occ = host.layerLodOccupancy.get(layerId);
  const lodOccMap = occ ? occ[lod - 1] : null;
  if (!lodOccMap || lodOccMap.size === 0) {
    return host.getLayerTiles(layerId, lod);
  }

  const result: TileBuffer[] = [];
  for (const packed of lodOccMap.keys()) {
    const tx = unpackTileCoordX(packed);
    const ty = unpackTileCoordY(packed);
    let tile = host.getTile(layerId, tx, ty, lod);
    if (!tile || tile.data === null || isLodTileDirty(host, layerId, tx, ty, lod)) {
      tile = generateLodTile(host, layerId, tx, ty, lod);
    }
    if (tile && tile.data !== null) {
      result.push(tile);
    }
  }
  return result;
}

export function isLodTileDirty(
  host: ISparseTileGridHost,
  layerId: string,
  tileX: number,
  tileY: number,
  lod: number
): boolean {
  if (lod <= 0) return false;
  return host.dirtyLodTiles.has(getTileKey(layerId, tileX, tileY, lod));
}

export function markLodAncestorsDirty(
  host: ISparseTileGridHost,
  layerId: string,
  tileX: number,
  tileY: number
): void {
  let tx = tileX;
  let ty = tileY;
  for (let lod = 1; lod <= 3; lod++) {
    tx = tx >> 1;
    ty = ty >> 1;
    const key = getTileKey(layerId, tx, ty, lod);
    host.dirtyLodTiles.add(key);
    const existing = host.tiles.get(key);
    if (existing) {
      existing.dirty = true;
    }
  }
}

/**
 * Generates or downsamples a specific LOD tile from its 4 child tiles at LOD - 1.
 */
export function generateLodTile(
  host: ISparseTileGridHost,
  layerId: string,
  lodTx: number,
  lodTy: number,
  targetLod: number
): TileBuffer | null {
  if (targetLod <= 0) {
    return host.getTile(layerId, lodTx, lodTy, 0);
  }

  const key = getTileKey(layerId, lodTx, lodTy, targetLod);
  const memoryManager = host.getMemoryManager();

  // O(1) empty-region fast-out: if no LOD 0 tile exists anywhere under this LOD node,
  // never recurse or allocate a temporary 256KB TileBuffer.
  if (!host.hasPopulatedLodTile(layerId, lodTx, lodTy, targetLod)) {
    const stale = host.tiles.get(key);
    if (stale) {
      memoryManager?.notifyTileFreed(stale);
      host.tiles.delete(key);
    }
    host.dirtyLodTiles.delete(key);
    return null;
  }

  const childLod = targetLod - 1;
  const cX0 = lodTx << 1;
  const cY0 = lodTy << 1;

  let c00 = host.getTile(layerId, cX0, cY0, childLod);
  let c10 = host.getTile(layerId, cX0 + 1, cY0, childLod);
  let c01 = host.getTile(layerId, cX0, cY0 + 1, childLod);
  let c11 = host.getTile(layerId, cX0 + 1, cY0 + 1, childLod);

  if (childLod > 0) {
    if (host.hasPopulatedLodTile(layerId, cX0, cY0, childLod)) {
      if (!c00 || c00.data === null || isLodTileDirty(host, layerId, cX0, cY0, childLod)) {
        c00 = generateLodTile(host, layerId, cX0, cY0, childLod);
      }
    } else {
      c00 = null;
    }
    if (host.hasPopulatedLodTile(layerId, cX0 + 1, cY0, childLod)) {
      if (!c10 || c10.data === null || isLodTileDirty(host, layerId, cX0 + 1, cY0, childLod)) {
        c10 = generateLodTile(host, layerId, cX0 + 1, cY0, childLod);
      }
    } else {
      c10 = null;
    }
    if (host.hasPopulatedLodTile(layerId, cX0, cY0 + 1, childLod)) {
      if (!c01 || c01.data === null || isLodTileDirty(host, layerId, cX0, cY0 + 1, childLod)) {
        c01 = generateLodTile(host, layerId, cX0, cY0 + 1, childLod);
      }
    } else {
      c01 = null;
    }
    if (host.hasPopulatedLodTile(layerId, cX0 + 1, cY0 + 1, childLod)) {
      if (!c11 || c11.data === null || isLodTileDirty(host, layerId, cX0 + 1, cY0 + 1, childLod)) {
        c11 = generateLodTile(host, layerId, cX0 + 1, cY0 + 1, childLod);
      }
    } else {
      c11 = null;
    }
  }

  const firstChild =
    (c00 && c00.data !== null ? c00 : null) ||
    (c10 && c10.data !== null ? c10 : null) ||
    (c01 && c01.data !== null ? c01 : null) ||
    (c11 && c11.data !== null ? c11 : null);

  let tile = host.tiles.get(key);
  if (!firstChild) {
    if (tile) {
      memoryManager?.notifyTileFreed(tile);
      host.tiles.delete(key);
    }
    host.dirtyLodTiles.delete(key);
    return null;
  }

  // Ephemeral display LOD > 0 tiles for monochrome-1bit layers use box-filtered color-32bit
  // coverage instead of bitwise-OR dilation so zoomed-out lines match live mipmapped drafts.
  const format: TileFormat =
    firstChild.format === 'monochrome-1bit' ? 'color-32bit' : firstChild.format;

  let allocatedNew = false;
  if (!tile) {
    tile = createTileBuffer(layerId, lodTx, lodTy, format, targetLod);
    host.tiles.set(key, tile);
    allocatedNew = true;
  } else if (tile.format !== format) {
    if (tile.data !== null) {
      memoryManager?.notifyTileFreed(tile);
    }
    tile.format = format;
    tile.data = new Uint8Array(getTileByteSize(format));
    allocatedNew = true;
  } else if (tile.data === null) {
    allocatedNew = true;
  }

  const success = downsample2x2ToParentTile([c00, c10, c01, c11], tile);
  if (!success) {
    if (!allocatedNew) {
      memoryManager?.notifyTileFreed(tile);
    }
    host.tiles.delete(key);
    host.dirtyLodTiles.delete(key);
    return null;
  }

  if (allocatedNew) {
    memoryManager?.notifyTileAllocated(tile);
  }
  tile.dirty = true;
  tile.version = allocateTileVersion();
  host.dirtyLodTiles.delete(key);
  return tile;
}

/**
 * Progressively downsamples up to `maxCount` dirty mipmap tiles.
 */
export function updateDirtyMipmaps(host: ISparseTileGridHost, maxCount: number = 16): number {
  let count = 0;
  const keys = Array.from(host.dirtyLodTiles);

  // Process lower LODs (LOD 1) before higher LODs (LOD 2, 3)
  keys.sort((a, b) => {
    const pa = parseTileKey(a);
    const pb = parseTileKey(b);
    return pa.lod - pb.lod;
  });

  for (const key of keys) {
    if (count >= maxCount) break;
    host.dirtyLodTiles.delete(key);
    const { layerId, tileX, tileY, lod } = parseTileKey(key);
    generateLodTile(host, layerId, tileX, tileY, lod);
    count++;
  }

  return count;
}

/**
 * Flushes all pending dirty mipmap tiles immediately.
 */
export function flushMipmaps(host: ISparseTileGridHost, layerId?: string): void {
  const keys = Array.from(host.dirtyLodTiles);
  keys.sort((a, b) => {
    const pa = parseTileKey(a);
    const pb = parseTileKey(b);
    return pa.lod - pb.lod;
  });

  for (const key of keys) {
    const { layerId: lId, tileX, tileY, lod } = parseTileKey(key);
    if (!layerId || lId === layerId) {
      host.dirtyLodTiles.delete(key);
      generateLodTile(host, lId, tileX, tileY, lod);
    }
  }
}
