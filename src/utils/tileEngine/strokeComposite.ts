/**
 * In-place brush stroke compositing directly onto LOD 0 sparse tiles.
 */

import { packRGBATo1Bit, packRGBATo8Bit, unpack8BitToRGBA } from './pixelCodec';
import {
  ISparseTileGridHost,
  TILE_SIZE,
  TileFormat,
  allocateTileVersion,
  getTileByteSize,
  getTileKey,
  pixelToTileCoord,
} from './types';

export interface CompositeStrokeOptions {
  layerId: string;
  strokeData: { data: Uint8ClampedArray | Uint8Array; width: number; height: number };
  destX: number;
  destY: number;
  format: TileFormat;
  compositeOp: 'source-over' | 'destination-out' | 'source-atop';
  opacity: number;
  monochrome?: {
    threshold: number;
    expressBlack: boolean;
    expressWhite: boolean;
  };
  selectionMask?: {
    mask: Uint8Array;
    bounds: { x: number; y: number; width: number; height: number };
  } | null;
  snapshotOut?: Map<string, { format: TileFormat; data: Uint8Array | null }>;
  suppressNotify?: boolean;
}

/**
 * Composites an isolated stroke RGBA buffer directly onto LOD 0 tiles in-place,
 * avoiding full-region canvas allocation, existing-tile unpacking, and separate
 * binarization passes. Records pre-edit tile snapshots into `snapshotOut` only
 * for tiles with non-zero stroke pixels.
 */
export function compositeStrokeToTiles(
  host: ISparseTileGridHost,
  options: CompositeStrokeOptions
): boolean {
  const {
    layerId,
    strokeData,
    destX,
    destY,
    format: targetFormat,
    compositeOp,
    monochrome,
    selectionMask,
    snapshotOut,
    suppressNotify = false,
  } = options;
  const opacity = Math.max(0, Math.min(1, options.opacity));
  const w = strokeData.width;
  const h = strokeData.height;
  if (w <= 0 || h <= 0 || opacity <= 0.001) return false;

  host.ingestedLayers.add(layerId);
  host.setLayerFormat(layerId, targetFormat);

  const minTileX = pixelToTileCoord(destX, 0);
  const minTileY = pixelToTileCoord(destY, 0);
  const maxTileX = pixelToTileCoord(destX + w - 1, 0);
  const maxTileY = pixelToTileCoord(destY + h - 1, 0);

  const srcData = strokeData.data;
  const src32 =
    srcData.byteOffset % 4 === 0 && srcData.byteLength >= w * h * 4
      ? new Uint32Array(srcData.buffer, srcData.byteOffset, w * h)
      : null;

  const monoThresh = Math.max(1, Math.min(255, monochrome?.threshold ?? 128));
  const monoExpressBlack = monochrome?.expressBlack !== false;
  const hasSelMask = Boolean(selectionMask?.mask);
  const selMask = selectionMask?.mask ?? null;
  const selBx = selectionMask ? Math.floor(selectionMask.bounds.x) : 0;
  const selBy = selectionMask ? Math.floor(selectionMask.bounds.y) : 0;
  const selBw = selectionMask ? Math.ceil(selectionMask.bounds.width) : 0;
  const selBh = selectionMask ? Math.ceil(selectionMask.bounds.height) : 0;
  const fullOpacity = opacity >= 0.999;
  const memoryManager = host.getMemoryManager();

  let anyModified = false;

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

      // Erasing or alpha-locking against an empty tile is a no-op
      if ((compositeOp === 'destination-out' || compositeOp === 'source-atop') && (!existingTile || !existingTile.data)) {
        if (existingTile && existingTile.data === null && existingTile.isPagedToDisk && memoryManager) {
          void memoryManager.requestTileData(existingTile);
        }
        continue;
      }

      // Fast zero-scan: skip tiles where the stroke overlap is completely transparent
      let hasNonZero = false;
      if (src32 !== null) {
        outerZero32: for (let sy = srcStartY; sy < srcEndY; sy++) {
          const rowOff = sy * w;
          for (let sx = rowOff + srcStartX, end = rowOff + srcEndX; sx < end; sx++) {
            if ((src32[sx] >>> 24) !== 0) {
              hasNonZero = true;
              break outerZero32;
            }
          }
        }
      } else {
        outerZero8: for (let sy = srcStartY; sy < srcEndY; sy++) {
          let off = (sy * w + srcStartX) << 2;
          const endOff = (sy * w + srcEndX) << 2;
          for (; off < endOff; off += 4) {
            if (srcData[off + 3] !== 0) {
              hasNonZero = true;
              break outerZero8;
            }
          }
        }
      }
      if (!hasNonZero) continue;

      // Snapshot pre-edit tile state before mutating
      if (snapshotOut) {
        const tileKey = getTileKey(layerId, tx, ty, 0);
        if (!snapshotOut.has(tileKey)) {
          snapshotOut.set(tileKey, {
            format: existingTile ? existingTile.format : targetFormat,
            data: existingTile?.data ? new Uint8Array(existingTile.data) : null,
          });
        }
      }

      const tile = existingTile ?? host.getOrCreateTile(layerId, tx, ty, targetFormat, 0);
      if (tile.format !== targetFormat) {
        const prevRGBA = tile.data ? new Uint8Array(host.getTileAsRGBA(tile)) : null;
        if (tile.data !== null) {
          memoryManager?.notifyTileFreed(tile);
        }
        tile.format = targetFormat;
        tile.data = new Uint8Array(getTileByteSize(targetFormat));
        if (prevRGBA) {
          if (targetFormat === 'color-32bit') {
            tile.data.set(prevRGBA);
          } else if (targetFormat === 'monochrome-1bit') {
            packRGBATo1Bit(prevRGBA, tile.data, monoThresh);
          } else {
            packRGBATo8Bit(prevRGBA, tile.data);
          }
        }
        memoryManager?.notifyTileAllocated(tile);
      } else if (tile.data === null) {
        tile.data = new Uint8Array(getTileByteSize(tile.format));
        memoryManager?.notifyTileAllocated(tile);
      }

      const localStartX = destX + srcStartX - tileDocX;
      const copyWidth = srcEndX - srcStartX;

      if (tile.format === 'monochrome-1bit') {
        const dst = tile.data;
        for (let sy = srcStartY; sy < srcEndY; sy++) {
          const tileLocalY = destY + sy - tileDocY;
          const docY = destY + sy;
          const rowByteBase = tileLocalY << 5;
          let srcOff = (sy * w + srcStartX) << 2;
          const selRowValid = hasSelMask && docY >= selBy && docY < selBy + selBh;
          const selRowOff = selRowValid ? (docY - selBy) * selBw : 0;

          for (let dx = 0; dx < copyWidth; dx++, srcOff += 4) {
            const sa = srcData[srcOff + 3];
            if (sa === 0) continue;

            let effA = fullOpacity ? sa : Math.round(sa * opacity);
            if (hasSelMask) {
              const docX = destX + srcStartX + dx;
              if (!selRowValid || docX < selBx || docX >= selBx + selBw) continue;
              const ma = selMask![selRowOff + (docX - selBx)];
              if (ma === 0) continue;
              if (ma < 255) {
                effA = Math.round((effA * ma) / 255);
              }
            }

            const lx = localStartX + dx;
            const byteIdx = rowByteBase + (lx >> 3);
            const mask = 1 << (7 - (lx & 7));

            if (compositeOp === 'destination-out') {
              if (effA >= 128) {
                dst[byteIdx] &= ~mask;
              }
            } else if (compositeOp === 'source-atop') {
              if ((dst[byteIdx] & mask) === 0) continue;
              const r = srcData[srcOff];
              const g = srcData[srcOff + 1];
              const b = srcData[srcOff + 2];
              const lum = (19595 * r + 38470 * g + 7471 * b + 32768) >> 16;
              const outLum = (lum * effA) / 255;
              if (outLum < monoThresh && monoExpressBlack) {
                dst[byteIdx] |= mask;
              } else {
                dst[byteIdx] &= ~mask;
              }
            } else {
              const hadInk = (dst[byteIdx] & mask) !== 0;
              const r = srcData[srcOff];
              const g = srcData[srcOff + 1];
              const b = srcData[srcOff + 2];
              const lum = (19595 * r + 38470 * g + 7471 * b + 32768) >> 16;
              if (!hadInk) {
                if (effA >= 128 && lum < monoThresh && monoExpressBlack) {
                  dst[byteIdx] |= mask;
                }
              } else {
                const outLum = (lum * effA) / 255;
                if (outLum >= monoThresh || !monoExpressBlack) {
                  dst[byteIdx] &= ~mask;
                }
              }
            }
          }
        }
      } else if (tile.format === 'color-32bit') {
        const dst = tile.data;
        for (let sy = srcStartY; sy < srcEndY; sy++) {
          const tileLocalY = destY + sy - tileDocY;
          const docY = destY + sy;
          let srcOff = (sy * w + srcStartX) << 2;
          let dstOff = (tileLocalY * TILE_SIZE + localStartX) << 2;
          const selRowValid = hasSelMask && docY >= selBy && docY < selBy + selBh;
          const selRowOff = selRowValid ? (docY - selBy) * selBw : 0;

          for (let dx = 0; dx < copyWidth; dx++, srcOff += 4, dstOff += 4) {
            const sa = srcData[srcOff + 3];
            if (sa === 0) continue;

            let effA = fullOpacity ? sa : Math.round(sa * opacity);
            if (effA === 0) continue;

            let maskFrac = 1.0;
            if (hasSelMask) {
              const docX = destX + srcStartX + dx;
              if (!selRowValid || docX < selBx || docX >= selBx + selBw) continue;
              const ma = selMask![selRowOff + (docX - selBx)];
              if (ma === 0) continue;
              if (ma < 255) maskFrac = ma / 255;
            }

            const sr = srcData[srcOff];
            const sg = srcData[srcOff + 1];
            const sb = srcData[srcOff + 2];
            const da = dst[dstOff + 3];

            let outR = dst[dstOff];
            let outG = dst[dstOff + 1];
            let outB = dst[dstOff + 2];
            let outA = da;

            if (compositeOp === 'destination-out') {
              if (da === 0) continue;
              if (effA === 255) {
                outR = 0;
                outG = 0;
                outB = 0;
                outA = 0;
              } else {
                outA = Math.round(da * (1 - effA / 255));
                if (outA === 0) {
                  outR = 0;
                  outG = 0;
                  outB = 0;
                }
              }
            } else if (compositeOp === 'source-atop') {
              if (da === 0) continue;
              if (effA === 255) {
                outR = sr;
                outG = sg;
                outB = sb;
              } else {
                const sA = effA / 255;
                const inv = 1 - sA;
                outR = Math.round(sr * sA + outR * inv);
                outG = Math.round(sg * sA + outG * inv);
                outB = Math.round(sb * sA + outB * inv);
              }
            } else {
              if (effA === 255 || da === 0) {
                outR = sr;
                outG = sg;
                outB = sb;
                outA = effA;
              } else {
                const sA = effA / 255;
                const dA = da / 255;
                const invSA = 1 - sA;
                const compA = sA + dA * invSA;
                if (compA > 0) {
                  const invOut = 1 / compA;
                  outR = Math.round((sr * sA + outR * dA * invSA) * invOut);
                  outG = Math.round((sg * sA + outG * dA * invSA) * invOut);
                  outB = Math.round((sb * sA + outB * dA * invSA) * invOut);
                  outA = Math.round(compA * 255);
                }
              }
            }

            if (maskFrac < 1.0) {
              const invM = 1 - maskFrac;
              const bA = da / 255;
              const aA = outA / 255;
              const mixA = bA * invM + aA * maskFrac;
              if (mixA <= 0.0001) {
                dst[dstOff] = 0;
                dst[dstOff + 1] = 0;
                dst[dstOff + 2] = 0;
                dst[dstOff + 3] = 0;
              } else {
                const invMixA = 1 / mixA;
                dst[dstOff] = Math.round((dst[dstOff] * bA * invM + outR * aA * maskFrac) * invMixA);
                dst[dstOff + 1] = Math.round((dst[dstOff + 1] * bA * invM + outG * aA * maskFrac) * invMixA);
                dst[dstOff + 2] = Math.round((dst[dstOff + 2] * bA * invM + outB * aA * maskFrac) * invMixA);
                dst[dstOff + 3] = Math.round(mixA * 255);
              }
            } else {
              dst[dstOff] = outR;
              dst[dstOff + 1] = outG;
              dst[dstOff + 2] = outB;
              dst[dstOff + 3] = outA;
            }
          }
        }
      } else {
        // grayscale-8bit fallback
        const tileScratch = host.writeScratchRGBA;
        unpack8BitToRGBA(tile.data, tileScratch);
        for (let sy = srcStartY; sy < srcEndY; sy++) {
          const tileLocalY = destY + sy - tileDocY;
          let srcOff = (sy * w + srcStartX) << 2;
          let dstOff = (tileLocalY * TILE_SIZE + localStartX) << 2;
          for (let dx = 0; dx < copyWidth; dx++, srcOff += 4, dstOff += 4) {
            const sa = srcData[srcOff + 3];
            if (sa === 0) continue;
            const effA = fullOpacity ? sa : Math.round(sa * opacity);
            if (compositeOp === 'destination-out') {
              tileScratch[dstOff + 3] = Math.round(tileScratch[dstOff + 3] * (1 - effA / 255));
            } else if (effA > 0) {
              const sA = effA / 255;
              const inv = 1 - sA;
              tileScratch[dstOff] = Math.round(srcData[srcOff] * sA + tileScratch[dstOff] * inv);
              tileScratch[dstOff + 1] = Math.round(srcData[srcOff + 1] * sA + tileScratch[dstOff + 1] * inv);
              tileScratch[dstOff + 2] = Math.round(srcData[srcOff + 2] * sA + tileScratch[dstOff + 2] * inv);
              tileScratch[dstOff + 3] = Math.min(255, Math.round(tileScratch[dstOff + 3] * inv + effA));
            }
          }
        }
        packRGBATo8Bit(tileScratch, tile.data);
      }

      tile.solidColorU32 = undefined;
      tile.dirty = true;
      tile.version = allocateTileVersion();
      host.markLodAncestorsDirty(layerId, tx, ty);
      anyModified = true;
    }
  }

  if (anyModified) {
    host.bumpLayerVersion(layerId);
    if (!suppressNotify) {
      host.notifyChange();
    }
  }
  return anyModified;
}
