import { TileBuffer } from '../tileEngine';
import { DocumentBounds, ViewportTransform } from './types';

/**
 * Calculates the document-space bounding box visible in the current camera viewport.
 * Performs frustum culling.
 */
export function calculateVisibleDocumentBounds(
  viewportW: number,
  viewportH: number,
  transform: ViewportTransform,
  docW: number,
  docH: number
): DocumentBounds {
  const { pan, zoom, rotation, flipX = false, flipY = false } = transform;
  const rad = (-rotation * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const fx = flipX ? -1 : 1;
  const fy = flipY ? -1 : 1;

  // Screen corners relative to screen center/pan
  const corners = [
    { x: 0, y: 0 },
    { x: viewportW, y: 0 },
    { x: viewportW, y: viewportH },
    { x: 0, y: viewportH },
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const c of corners) {
    // Invert translate
    const dx = c.x - pan.x;
    const dy = c.y - pan.y;

    // Invert zoom
    const sx = dx / Math.max(0.001, zoom);
    const sy = dy / Math.max(0.001, zoom);

    // Invert rotation
    const rx = sx * cosR - sy * sinR;
    const ry = sx * sinR + sy * cosR;

    // Invert view flip and center offset
    const docX = rx * fx + docW * 0.5;
    const docY = ry * fy + docH * 0.5;

    if (docX < minX) minX = docX;
    if (docY < minY) minY = docY;
    if (docX > maxX) maxX = docX;
    if (docY > maxY) maxY = docY;
  }

  return {
    minX: Math.max(0, Math.floor(minX)),
    minY: Math.max(0, Math.floor(minY)),
    maxX: Math.min(docW, Math.ceil(maxX)),
    maxY: Math.min(docH, Math.ceil(maxY)),
  };
}

/**
 * Hex color parser to RGB normalized float array [r, g, b].
 */
export function parseHexColor(hex: string): [number, number, number] {
  let clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean.split('').map((c) => c + c).join('');
  }
  const num = parseInt(clean, 16);
  if (isNaN(num)) return [0, 0, 0];
  return [
    ((num >> 16) & 255) / 255,
    ((num >> 8) & 255) / 255,
    (num & 255) / 255,
  ];
}

/**
 * Premultiplies straight-alpha RGBA tile bytes into a reusable scratch buffer.
 * 1-bit monochrome, 8-bit grayscale, and opaque solid-fill tiles return `srcBytes` directly.
 */
export function premultiplyTileBytes(
  srcBytes: Uint8Array,
  tile: TileBuffer,
  dst: Uint8Array
): Uint8Array {
  // 1-bit monochrome, 8-bit grayscale, and opaque solid-fill tiles only contain alpha 0 or 255
  // so straight-alpha bytes are already premultiplied (zero-copy fast path).
  if (
    tile.format === 'monochrome-1bit' ||
    tile.format === 'grayscale-8bit' ||
    (tile.solidColorU32 !== undefined && srcBytes[3] === 255)
  ) {
    return srcBytes;
  }

  const len = srcBytes.byteLength;
  const src32 = new Uint32Array(srcBytes.buffer, srcBytes.byteOffset, len >> 2);
  const dst32 = new Uint32Array(dst.buffer, dst.byteOffset, len >> 2);

  for (let p = 0, i = 0; i < len; p++, i += 4) {
    const a = srcBytes[i + 3];
    if (a === 255) {
      dst32[p] = src32[p];
    } else if (a === 0) {
      dst32[p] = 0;
    } else {
      dst[i] = ((srcBytes[i] * a + 128) * 257) >> 16;
      dst[i + 1] = ((srcBytes[i + 1] * a + 128) * 257) >> 16;
      dst[i + 2] = ((srcBytes[i + 2] * a + 128) * 257) >> 16;
      dst[i + 3] = a;
    }
  }
  return dst;
}
