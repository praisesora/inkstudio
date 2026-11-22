/**
 * Canvas materialization and thumbnail rendering operations for SparseTileGrid.
 */

import {
  BYTES_32BIT,
  ISparseTileGridHost,
  TILE_SIZE,
  pixelToTileCoord,
} from './types';

export function renderLayerToCanvas(
  host: ISparseTileGridHost,
  layerId: string,
  targetCanvas: HTMLCanvasElement,
  dirtyRect?: { x: number; y: number; width: number; height: number }
): void {
  const ctx = targetCanvas.getContext('2d');
  if (!ctx) return;

  let minX = 0;
  let minY = 0;
  let maxX = targetCanvas.width;
  let maxY = targetCanvas.height;

  if (dirtyRect) {
    minX = Math.max(0, Math.floor(dirtyRect.x));
    minY = Math.max(0, Math.floor(dirtyRect.y));
    maxX = Math.min(targetCanvas.width, Math.ceil(dirtyRect.x + dirtyRect.width));
    maxY = Math.min(targetCanvas.height, Math.ceil(dirtyRect.y + dirtyRect.height));
  }

  if (maxX <= minX || maxY <= minY) return;

  const minTileX = pixelToTileCoord(minX, 0);
  const minTileY = pixelToTileCoord(minY, 0);
  const maxTileX = pixelToTileCoord(maxX - 1, 0);
  const maxTileY = pixelToTileCoord(maxY - 1, 0);

  for (let ty = minTileY; ty <= maxTileY; ty++) {
    const tileDocY = ty * TILE_SIZE;
    const validH = Math.min(TILE_SIZE, targetCanvas.height - tileDocY);
    if (validH <= 0) continue;
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      const tileDocX = tx * TILE_SIZE;
      const validW = Math.min(TILE_SIZE, targetCanvas.width - tileDocX);
      if (validW <= 0) continue;
      const tile = host.getTile(layerId, tx, ty, 0);
      if (!tile) {
        ctx.clearRect(tileDocX, tileDocY, validW, validH);
        continue;
      }

      const rgba = host.getTileAsRGBA(tile);
      if (typeof ImageData !== 'undefined') {
        const clamped = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, BYTES_32BIT);
        const imgData = new ImageData(clamped, TILE_SIZE, TILE_SIZE);
        ctx.putImageData(imgData, tileDocX, tileDocY, 0, 0, validW, validH);
      }
    }
  }
}

/**
 * Populates a temporary (or caller-supplied pooled) HTMLCanvasElement strictly sized to `rect` from tiles.
 * When `targetCanvas` is omitted, caller must release the returned canvas via `releaseTemporaryCanvas(canvas)`.
 */
export function createRegionCanvas(
  host: ISparseTileGridHost,
  layerId: string,
  rect: { x: number; y: number; width: number; height: number },
  targetCanvas?: HTMLCanvasElement | null
): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || rect.width <= 0 || rect.height <= 0) return null;
  const w = Math.max(1, Math.ceil(rect.width));
  const h = Math.max(1, Math.ceil(rect.height));
  const canvas = targetCanvas || document.createElement('canvas');
  const resized = canvas.width !== w || canvas.height !== h;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return canvas;
  if (!resized) {
    if (typeof ctx.resetTransform === 'function') {
      ctx.resetTransform();
    } else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.clearRect(0, 0, w, h);
  }

  if (host.hasLayerTiles(layerId) && typeof ImageData !== 'undefined') {
    const originX = Math.floor(rect.x);
    const originY = Math.floor(rect.y);
    const minTileX = pixelToTileCoord(originX, 0);
    const minTileY = pixelToTileCoord(originY, 0);
    const maxTileX = pixelToTileCoord(originX + w - 1, 0);
    const maxTileY = pixelToTileCoord(originY + h - 1, 0);

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      const tileDocY = ty * TILE_SIZE;
      const interStartY = Math.max(originY, tileDocY);
      const interEndY = Math.min(originY + h, tileDocY + TILE_SIZE);
      const dirtyH = interEndY - interStartY;
      if (dirtyH <= 0) continue;
      const dirtyY = interStartY - tileDocY;

      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const tile = host.getTile(layerId, tx, ty, 0);
        if (!tile) continue;

        const tileDocX = tx * TILE_SIZE;
        const interStartX = Math.max(originX, tileDocX);
        const interEndX = Math.min(originX + w, tileDocX + TILE_SIZE);
        const dirtyW = interEndX - interStartX;
        if (dirtyW <= 0) continue;
        const dirtyX = interStartX - tileDocX;

        const rgba = host.getTileAsRGBA(tile);
        const clamped = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, BYTES_32BIT);
        const imgData = new ImageData(clamped, TILE_SIZE, TILE_SIZE);
        ctx.putImageData(
          imgData,
          tileDocX - originX,
          tileDocY - originY,
          dirtyX,
          dirtyY,
          dirtyW,
          dirtyH
        );
      }
    }
  }
  return canvas;
}

/**
 * Materializes a full-layer temporary HTMLCanvasElement from tiles (for export/filters).
 * Caller MUST release it immediately after use via `releaseTemporaryCanvas(canvas)`.
 */
export function exportLayerToCanvas(
  host: ISparseTileGridHost,
  layerId: string,
  width: number,
  height: number
): HTMLCanvasElement | null {
  if (typeof document === 'undefined' || width <= 0 || height <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  if (host.hasLayerTiles(layerId)) {
    host.renderLayerToCanvas(layerId, canvas);
  }
  return canvas;
}

/**
 * Generates a layer thumbnail directly from LOD 3 mipmap tiles (1/8 resolution: 2048px per tile).
 * Completely bypasses full-size canvas allocation and full-resolution pixel reads.
 */
export function generateThumbnail(
  host: ISparseTileGridHost,
  layerId: string,
  thumbWidth: number,
  thumbHeight: number,
  docDimensions: { width: number; height: number },
  preserveAlpha: boolean = true
): string {
  if (typeof document === 'undefined') return '';
  let canvas = host.getThumbCanvas();
  if (!canvas) {
    canvas = document.createElement('canvas');
    host.setThumbCanvas(canvas);
  }
  if (canvas.width !== thumbWidth) canvas.width = thumbWidth;
  if (canvas.height !== thumbHeight) canvas.height = thumbHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  const docW = Math.max(1, docDimensions.width);
  const docH = Math.max(1, docDimensions.height);

  const tiles = host.getOrBuildLod3Tiles(layerId);

  if (tiles.length === 0) {
    if (preserveAlpha) {
      ctx.clearRect(0, 0, thumbWidth, thumbHeight);
      return canvas.toDataURL('image/png');
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, thumbWidth, thumbHeight);
    return canvas.toDataURL('image/jpeg', 0.65);
  }

  const renderLod = 3;
  const lodDocSize = TILE_SIZE << renderLod; // 2048 document pixels per LOD 3 tile
  const thumbImg = ctx.createImageData(thumbWidth, thumbHeight);
  const outData = thumbImg.data;
  if (!preserveAlpha) {
    outData.fill(255);
  }
  const scaleX = docW / thumbWidth;
  const scaleY = docH / thumbHeight;

  for (const tile of tiles) {
    const tileDocX = tile.tileX * lodDocSize;
    const tileDocY = tile.tileY * lodDocSize;

    const x0 = Math.max(0, Math.floor((tileDocX / docW) * thumbWidth));
    const y0 = Math.max(0, Math.floor((tileDocY / docH) * thumbHeight));
    const x1 = Math.min(thumbWidth, Math.ceil(((tileDocX + lodDocSize) / docW) * thumbWidth));
    const y1 = Math.min(thumbHeight, Math.ceil(((tileDocY + lodDocSize) / docH) * thumbHeight));

    if (x0 >= x1 || y0 >= y1) continue;

    const rgba = host.getTileAsRGBA(tile);

    for (let py = y0; py < y1; py++) {
      const docY = (py + 0.5) * scaleY;
      const ly = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(((docY - tileDocY) / lodDocSize) * TILE_SIZE)));
      const ly2 = Math.min(TILE_SIZE - 1, ly + 1);
      for (let px = x0; px < x1; px++) {
        const docX = (px + 0.5) * scaleX;
        const lx = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(((docX - tileDocX) / lodDocSize) * TILE_SIZE)));
        const lx2 = Math.min(TILE_SIZE - 1, lx + 1);

        let srcIdx = (ly * TILE_SIZE + lx) * 4;
        if (rgba[srcIdx + 3] === 0) {
          const alt1 = (ly * TILE_SIZE + lx2) * 4;
          const alt2 = (ly2 * TILE_SIZE + lx) * 4;
          const alt3 = (ly2 * TILE_SIZE + lx2) * 4;
          if (rgba[alt1 + 3] > 0) srcIdx = alt1;
          else if (rgba[alt2 + 3] > 0) srcIdx = alt2;
          else if (rgba[alt3 + 3] > 0) srcIdx = alt3;
        }

        const sa = rgba[srcIdx + 3];
        if (sa > 0) {
          const dstIdx = (py * thumbWidth + px) * 4;
          if (preserveAlpha || sa === 255) {
            outData[dstIdx] = rgba[srcIdx];
            outData[dstIdx + 1] = rgba[srcIdx + 1];
            outData[dstIdx + 2] = rgba[srcIdx + 2];
            outData[dstIdx + 3] = sa;
          } else {
            const a = sa / 255;
            const inv = 1 - a;
            outData[dstIdx] = Math.round(rgba[srcIdx] * a + 255 * inv);
            outData[dstIdx + 1] = Math.round(rgba[srcIdx + 1] * a + 255 * inv);
            outData[dstIdx + 2] = Math.round(rgba[srcIdx + 2] * a + 255 * inv);
            outData[dstIdx + 3] = 255;
          }
        }
      }
    }
  }

  ctx.putImageData(thumbImg, 0, 0);
  return preserveAlpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.65);
}
