/**
 * Pixel-buffer I/O operations for SparseTileGrid:
 * writing and reading arbitrary RGBA rectangles across sparse tiles.
 */

import { packRGBATo8Bit, unpack1BitToRGBA, unpack8BitToRGBA } from './pixelCodec';
import {
  BYTES_32BIT,
  ISparseTileGridHost,
  TILE_SIZE,
  TileBuffer,
  TileFormat,
  allocateTileVersion,
  getTileByteSize,
  pixelToTileCoord,
} from './types';

export function getTilesInBounds(
  host: ISparseTileGridHost,
  layerId: string,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  lod: number = 0
): TileBuffer[] {
  if (lod === 0 && !host.hasLayerTiles(layerId)) {
    return [];
  }
  const minTileX = pixelToTileCoord(minX, lod);
  const minTileY = pixelToTileCoord(minY, lod);
  const maxTileX = pixelToTileCoord(maxX, lod);
  const maxTileY = pixelToTileCoord(maxY, lod);

  const result: TileBuffer[] = [];
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      if (lod > 0 && !host.hasPopulatedLodTile(layerId, tx, ty, lod)) {
        const direct = host.getTile(layerId, tx, ty, lod);
        if (direct) result.push(direct);
        continue;
      }
      let tile = host.getTile(layerId, tx, ty, lod);
      if (lod > 0 && (!tile || host.isLodTileDirty(layerId, tx, ty, lod))) {
        tile = host.generateLodTile(layerId, tx, ty, lod);
      }
      if (tile) {
        result.push(tile);
      }
    }
  }
  return result;
}

export function getIntersectingCoords(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  lod: number = 0
): Array<{ tileX: number; tileY: number }> {
  const minTileX = pixelToTileCoord(minX, lod);
  const minTileY = pixelToTileCoord(minY, lod);
  const maxTileX = pixelToTileCoord(maxX, lod);
  const maxTileY = pixelToTileCoord(maxY, lod);

  const coords: Array<{ tileX: number; tileY: number }> = [];
  for (let ty = minTileY; ty <= maxTileY; ty++) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      coords.push({ tileX: tx, tileY: ty });
    }
  }
  return coords;
}

/**
 * Transparently returns a 256x256 RGBA Uint8ClampedArray for WebGL texture upload or 2D blitting.
 * If tile data is paged to disk, kicks off an asynchronous fetch without freezing rendering.
 */
export function getTileAsRGBA(host: ISparseTileGridHost, tile: TileBuffer): Uint8ClampedArray {
  if (tile.data === null) {
    const memoryManager = host.getMemoryManager();
    if (tile.isPagedToDisk && memoryManager) {
      void memoryManager.requestTileData(tile);
    }
    host.scratchRGBA.fill(0);
    return host.scratchRGBA;
  }

  if (tile.format === 'color-32bit') {
    return new Uint8ClampedArray(tile.data.buffer, tile.data.byteOffset, BYTES_32BIT);
  }
  if (tile.format === 'monochrome-1bit') {
    unpack1BitToRGBA(tile.data, host.scratchRGBA);
    return host.scratchRGBA;
  }
  // 8-bit grayscale
  unpack8BitToRGBA(tile.data, host.scratchRGBA);
  return host.scratchRGBA;
}

/**
 * Writes an ImageData or RGBA buffer into the sparse tile grid.
 * Only allocates tiles that actually intersect the drawn rectangle.
 */
export function writeImageData(
  host: ISparseTileGridHost,
  layerId: string,
  imgData: { data: Uint8ClampedArray | Uint8Array; width: number; height: number },
  destX: number,
  destY: number,
  format?: TileFormat,
  suppressNotify: boolean = false
): { minTileX: number; minTileY: number; maxTileX: number; maxTileY: number } {
  host.ingestedLayers.add(layerId);
  if (format) {
    host.setLayerFormat(layerId, format);
  }
  const targetFormat = format || host.getLayerFormat(layerId);
  const w = imgData.width;
  const h = imgData.height;
  if (w <= 0 || h <= 0) {
    return { minTileX: 0, minTileY: 0, maxTileX: 0, maxTileY: 0 };
  }

  const minTileX = pixelToTileCoord(destX, 0);
  const minTileY = pixelToTileCoord(destY, 0);
  const maxTileX = pixelToTileCoord(destX + w - 1, 0);
  const maxTileY = pixelToTileCoord(destY + h - 1, 0);

  const tileScratch = host.writeScratchRGBA;
  const srcData = imgData.data;
  const src32 =
    srcData.byteOffset % 4 === 0 && srcData.byteLength >= w * h * 4
      ? new Uint32Array(srcData.buffer, srcData.byteOffset, w * h)
      : null;
  const memoryManager = host.getMemoryManager();

  for (let ty = minTileY; ty <= maxTileY; ty++) {
    const tileDocY = ty * TILE_SIZE;
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      const tileDocX = tx * TILE_SIZE;

      const srcStartX = Math.max(0, tileDocX - destX);
      const srcStartY = Math.max(0, tileDocY - destY);
      const srcEndX = Math.min(w, tileDocX + TILE_SIZE - destX);
      const srcEndY = Math.min(h, tileDocY + TILE_SIZE - destY);

      if (srcStartX >= srcEndX || srcStartY >= srcEndY) continue;

      let existingTile = host.getTile(layerId, tx, ty, 0);
      if (!existingTile) {
        let hasNonZero = false;
        if (src32 !== null) {
          outer32: for (let sy = srcStartY; sy < srcEndY; sy++) {
            const rowOff = sy * w;
            for (let sx = rowOff + srcStartX, end = rowOff + srcEndX; sx < end; sx++) {
              if (src32[sx] !== 0) {
                hasNonZero = true;
                break outer32;
              }
            }
          }
        } else {
          outer: for (let sy = srcStartY; sy < srcEndY; sy++) {
            let idx = (sy * w + srcStartX) * 4;
            const endIdx = (sy * w + srcEndX) * 4;
            for (; idx < endIdx; idx += 4) {
              if (srcData[idx + 3] !== 0 || srcData[idx] !== 0 || srcData[idx + 1] !== 0 || srcData[idx + 2] !== 0) {
                hasNonZero = true;
                break outer;
              }
            }
          }
        }
        if (!hasNonZero) continue;
        existingTile = host.getOrCreateTile(layerId, tx, ty, targetFormat, 0);
      }

      const tile = existingTile;
      if (tile.format !== targetFormat) {
        if (tile.data !== null) {
          memoryManager?.notifyTileFreed(tile);
        }
        tile.format = targetFormat;
        tile.data = new Uint8Array(getTileByteSize(targetFormat));
        memoryManager?.notifyTileAllocated(tile);
      } else if (tile.data === null) {
        tile.data = new Uint8Array(getTileByteSize(tile.format));
        memoryManager?.notifyTileAllocated(tile);
      }

      if (tile.format === 'color-32bit') {
        for (let sy = srcStartY; sy < srcEndY; sy++) {
          const tileLocalY = destY + sy - tileDocY;
          const tileLocalX = destX + srcStartX - tileDocX;
          const copyWidth = srcEndX - srcStartX;

          const srcByteOffset = (sy * w + srcStartX) * 4;
          const tileByteOffset = (tileLocalY * TILE_SIZE + tileLocalX) * 4;

          tile.data.set(
            srcData.subarray(srcByteOffset, srcByteOffset + copyWidth * 4),
            tileByteOffset
          );
        }
      } else if (tile.format === 'monochrome-1bit') {
        const dst = tile.data;
        const localStartX = destX + srcStartX - tileDocX;
        const copyWidth = srcEndX - srcStartX;
        const localEndX = localStartX + copyWidth;

        for (let sy = srcStartY; sy < srcEndY; sy++) {
          const tileLocalY = destY + sy - tileDocY;
          const rowByteBase = tileLocalY << 5; // TILE_SIZE / 8 = 32
          let lx = localStartX;
          let srcPixIdx = sy * w + srcStartX;
          let srcOff = srcPixIdx << 2;

          // Leading unaligned pixels before an 8-pixel boundary
          if ((lx & 7) !== 0) {
            const byteIdx = rowByteBase + (lx >> 3);
            let byteVal = dst[byteIdx];
            const stop = Math.min(localEndX, (lx + 7) & ~7);
            while (lx < stop) {
              const mask = 1 << (7 - (lx & 7));
              const a = srcData[srcOff + 3];
              if (
                a >= 24 &&
                srcData[srcOff] * 299 + srcData[srcOff + 1] * 587 + srcData[srcOff + 2] * 114 < 128000
              ) {
                byteVal |= mask;
              } else {
                byteVal &= ~mask;
              }
              lx++;
              srcPixIdx++;
              srcOff += 4;
            }
            dst[byteIdx] = byteVal;
          }

          // Full 8-pixel aligned bytes
          while (lx + 8 <= localEndX) {
            const byteIdx = rowByteBase + (lx >> 3);
            if (
              src32 !== null &&
              (src32[srcPixIdx] |
                src32[srcPixIdx + 1] |
                src32[srcPixIdx + 2] |
                src32[srcPixIdx + 3] |
                src32[srcPixIdx + 4] |
                src32[srcPixIdx + 5] |
                src32[srcPixIdx + 6] |
                src32[srcPixIdx + 7]) === 0
            ) {
              dst[byteIdx] = 0;
              lx += 8;
              srcPixIdx += 8;
              srcOff += 32;
              continue;
            }
            let byteVal = 0;
            for (let bit = 7; bit >= 0; bit--) {
              const a = srcData[srcOff + 3];
              if (
                a >= 24 &&
                srcData[srcOff] * 299 + srcData[srcOff + 1] * 587 + srcData[srcOff + 2] * 114 < 128000
              ) {
                byteVal |= 1 << bit;
              }
              srcOff += 4;
            }
            dst[byteIdx] = byteVal;
            lx += 8;
            srcPixIdx += 8;
          }

          // Trailing unaligned pixels
          if (lx < localEndX) {
            const byteIdx = rowByteBase + (lx >> 3);
            let byteVal = dst[byteIdx];
            while (lx < localEndX) {
              const mask = 1 << (7 - (lx & 7));
              const a = srcData[srcOff + 3];
              if (
                a >= 24 &&
                srcData[srcOff] * 299 + srcData[srcOff + 1] * 587 + srcData[srcOff + 2] * 114 < 128000
              ) {
                byteVal |= mask;
              } else {
                byteVal &= ~mask;
              }
              lx++;
              srcOff += 4;
            }
            dst[byteIdx] = byteVal;
          }
        }
      } else {
        unpack8BitToRGBA(tile.data, tileScratch);
        for (let sy = srcStartY; sy < srcEndY; sy++) {
          const tileLocalY = destY + sy - tileDocY;
          const tileLocalX = destX + srcStartX - tileDocX;
          const copyWidth = srcEndX - srcStartX;

          const srcByteOffset = (sy * w + srcStartX) * 4;
          const tileByteOffset = (tileLocalY * TILE_SIZE + tileLocalX) * 4;

          tileScratch.set(
            srcData.subarray(srcByteOffset, srcByteOffset + copyWidth * 4),
            tileByteOffset
          );
        }
        packRGBATo8Bit(tileScratch, tile.data);
      }

      tile.solidColorU32 = undefined;
      tile.dirty = true;
      tile.version = allocateTileVersion();
      host.markLodAncestorsDirty(layerId, tx, ty);
    }
  }

  host.bumpLayerVersion(layerId);
  if (!suppressNotify) {
    host.notifyChange();
  }
  return { minTileX, minTileY, maxTileX, maxTileY };
}

export function readImageData(
  host: ISparseTileGridHost,
  layerId: string,
  x: number,
  y: number,
  width: number,
  height: number
): { data: Uint8ClampedArray; width: number; height: number } {
  const outData = new Uint8ClampedArray(width * height * 4);
  if (width <= 0 || height <= 0) return { data: outData, width, height };

  const minTileX = pixelToTileCoord(x, 0);
  const minTileY = pixelToTileCoord(y, 0);
  const maxTileX = pixelToTileCoord(x + width - 1, 0);
  const maxTileY = pixelToTileCoord(y + height - 1, 0);

  for (let ty = minTileY; ty <= maxTileY; ty++) {
    const tileDocY = ty * TILE_SIZE;
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      const tile = host.getTile(layerId, tx, ty, 0);
      if (!tile) continue;

      const tileDocX = tx * TILE_SIZE;
      const tileRGBA = host.getTileAsRGBA(tile);

      const interStartX = Math.max(x, tileDocX);
      const interStartY = Math.max(y, tileDocY);
      const interEndX = Math.min(x + width, tileDocX + TILE_SIZE);
      const interEndY = Math.min(y + height, tileDocY + TILE_SIZE);

      for (let py = interStartY; py < interEndY; py++) {
        const tileLocalY = py - tileDocY;
        const tileLocalX = interStartX - tileDocX;
        const outLocalY = py - y;
        const outLocalX = interStartX - x;
        const copyWidth = interEndX - interStartX;

        const tileOffset = (tileLocalY * TILE_SIZE + tileLocalX) * 4;
        const outOffset = (outLocalY * width + outLocalX) * 4;

        outData.set(tileRGBA.subarray(tileOffset, tileOffset + copyWidth * 4), outOffset);
      }
    }
  }

  return { data: outData, width, height };
}
