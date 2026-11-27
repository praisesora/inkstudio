/**
 * In-place brush stroke compositing directly onto LOD 0 sparse tiles.
 * Supports all 28+ CSP/Photoshop BrushCombineMode blend modes, behind (destination-over),
 * clear (destination-out), compare-density, alpha-lock (source-atop), and selection masks.
 */

import type { CspBrushCombineMode } from '../../types/editor';
import {
  compositePigmentOverPixelInto,
  isPigmentCompatibleCombineMode,
} from '../pigmentEngine';
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
  brushCombineMode?: CspBrushCombineMode;
  opacity: number;
  /** Physical Kubelka-Munk pigment compositing strength [0..1]. 0 = standard RGB compositing. */
  pigmentStrength?: number;
  /** True when painting on a layer over a visible white/light paper ground (enables optical pigment dilution on transparent pixels). */
  pigmentWhiteGround?: boolean;
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

// ============================================================================
// Exact CPU implementation of all CSP / Photoshop / W3C Blend Modes
// Matches `src/utils/compositor/shaders/blendModesGlsl.ts` 1-to-1.
// ============================================================================

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

function blendLum(r: number, g: number, b: number): number {
  return 0.3 * r + 0.59 * g + 0.11 * b;
}

function blendSat(r: number, g: number, b: number): number {
  const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
  const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
  return mx - mn;
}

function clipColorInto(r: number, g: number, b: number, out: [number, number, number]): void {
  const l = clamp01(blendLum(r, g, b));
  const n = r < g ? (r < b ? r : b) : g < b ? g : b;
  const x = r > g ? (r > b ? r : b) : g > b ? g : b;
  let cr = r;
  let cg = g;
  let cb = b;
  if (n < 0) {
    const denom = Math.max(0.0001, l - n);
    cr = l + ((cr - l) * l) / denom;
    cg = l + ((cg - l) * l) / denom;
    cb = l + ((cb - l) * l) / denom;
  }
  if (x > 1) {
    const denom = Math.max(0.0001, x - l);
    cr = l + ((cr - l) * (1 - l)) / denom;
    cg = l + ((cg - l) * (1 - l)) / denom;
    cb = l + ((cb - l) * (1 - l)) / denom;
  }
  out[0] = clamp01(cr);
  out[1] = clamp01(cg);
  out[2] = clamp01(cb);
}

function setLumInto(
  r: number,
  g: number,
  b: number,
  l: number,
  out: [number, number, number]
): void {
  const d = l - blendLum(r, g, b);
  clipColorInto(r + d, g + d, b + d, out);
}

function setSatInto(
  r: number,
  g: number,
  b: number,
  s: number,
  out: [number, number, number]
): void {
  const cMin = r < g ? (r < b ? r : b) : g < b ? g : b;
  const cMax = r > g ? (r > b ? r : b) : g > b ? g : b;
  const delta = cMax - cMin;
  if (delta <= 0.0001) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return;
  }
  const scale = s / delta;
  out[0] = (r - cMin) * scale;
  out[1] = (g - cMin) * scale;
  out[2] = (b - cMin) * scale;
}

function blendChannel(b: number, s: number, mode: CspBrushCombineMode): number {
  switch (mode) {
    case 'multiply':
      return b * s;
    case 'screen':
      return b + s - b * s;
    case 'overlay':
      return b < 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
    case 'darken':
      return b < s ? b : s;
    case 'lighten':
      return b > s ? b : s;
    case 'color-dodge':
      return b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1.0, b / Math.max(0.0001, 1.0 - s));
    case 'color-burn':
      return b >= 1 ? 1 : s <= 0 ? 0 : 1.0 - Math.min(1.0, (1.0 - b) / Math.max(0.0001, s));
    case 'hard-light':
      return s < 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
    case 'soft-light': {
      const d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : Math.sqrt(Math.max(0, b));
      return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (d - b);
    }
    case 'difference':
      return Math.abs(b - s);
    case 'exclusion':
      return b + s - 2.0 * b * s;
    case 'linear-burn':
      return Math.max(0, b + s - 1.0);
    case 'add':
    case 'add-glow':
      return Math.min(1.0, b + s);
    case 'color-dodge-glow':
      return s >= 1 ? 1 : Math.min(1.0, b / Math.max(0.0001, 1.0 - s));
    case 'divide':
      return s <= 0.0001 ? 1.0 : clamp01(b / s);
    case 'vivid-light':
      if (s <= 0.5) {
        const s2 = 2.0 * s;
        return s2 <= 0 ? 0 : b >= 1 ? 1 : 1.0 - Math.min(1.0, (1.0 - b) / Math.max(0.0001, s2));
      } else {
        const s2 = 2.0 * (s - 0.5);
        return s2 >= 1 ? 1 : b <= 0 ? 0 : Math.min(1.0, b / Math.max(0.0001, 1.0 - s2));
      }
    case 'linear-light':
      return clamp01(b + 2.0 * s - 1.0);
    case 'pin-light':
      return s <= 0.5 ? Math.min(b, 2.0 * s) : Math.max(b, 2.0 * (s - 0.5));
    case 'hard-mix':
      return b + s >= 1.0 ? 1.0 : 0.0;
    case 'subtract':
      return Math.max(0, b - s);
    default:
      return s;
  }
}

const _blendScratchSat: [number, number, number] = [0, 0, 0];

/**
 * Evaluates any CSP/Photoshop color blend mode in normalized [0..1] RGB space.
 */
export function evaluateCpuBlendModeInto(
  br: number,
  bg: number,
  bb: number,
  sr: number,
  sg: number,
  sb: number,
  mode: CspBrushCombineMode,
  out: [number, number, number]
): void {
  switch (mode) {
    case 'darker-color':
      if (blendLum(sr, sg, sb) < blendLum(br, bg, bb)) {
        out[0] = sr;
        out[1] = sg;
        out[2] = sb;
      } else {
        out[0] = br;
        out[1] = bg;
        out[2] = bb;
      }
      return;
    case 'lighter-color':
      if (blendLum(sr, sg, sb) > blendLum(br, bg, bb)) {
        out[0] = sr;
        out[1] = sg;
        out[2] = sb;
      } else {
        out[0] = br;
        out[1] = bg;
        out[2] = bb;
      }
      return;
    case 'hue':
      setSatInto(sr, sg, sb, blendSat(br, bg, bb), _blendScratchSat);
      setLumInto(_blendScratchSat[0], _blendScratchSat[1], _blendScratchSat[2], blendLum(br, bg, bb), out);
      return;
    case 'saturation':
      setSatInto(br, bg, bb, blendSat(sr, sg, sb), _blendScratchSat);
      setLumInto(_blendScratchSat[0], _blendScratchSat[1], _blendScratchSat[2], blendLum(br, bg, bb), out);
      return;
    case 'color':
      setLumInto(sr, sg, sb, blendLum(br, bg, bb), out);
      return;
    case 'luminosity':
      setLumInto(br, bg, bb, blendLum(sr, sg, sb), out);
      return;
    default:
      out[0] = blendChannel(br, sr, mode);
      out[1] = blendChannel(bg, sg, mode);
      out[2] = blendChannel(bb, sb, mode);
  }
}

export function isCustomBrushCombineMode(mode?: CspBrushCombineMode): boolean {
  return Boolean(mode && mode !== 'normal' && mode !== 'pass-through');
}

const _blendRgbOut: [number, number, number] = [0, 0, 0];

/**
 * Composites a single RGBA pixel with full CSP `BrushCombineMode` + Porter-Duff semantics.
 * Writes [outR, outG, outB, outA] (0..255) into `out`.
 */
export function compositeBrushPixelInto(
  dr: number,
  dg: number,
  db: number,
  da: number,
  sr: number,
  sg: number,
  sb: number,
  effA: number,
  compositeOp: 'source-over' | 'destination-out' | 'source-atop',
  combineMode: CspBrushCombineMode | undefined,
  out: [number, number, number, number]
): void {
  const mode: CspBrushCombineMode = combineMode ?? 'normal';

  if (compositeOp === 'destination-out' || mode === 'clear') {
    if (da === 0) {
      out[0] = dr;
      out[1] = dg;
      out[2] = db;
      out[3] = 0;
      return;
    }
    if (effA >= 255) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
    } else {
      const outA = Math.round(da * (1 - effA / 255));
      if (outA <= 0) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        out[3] = 0;
      } else {
        out[0] = dr;
        out[1] = dg;
        out[2] = db;
        out[3] = outA;
      }
    }
    return;
  }

  if (mode === 'behind') {
    // CSP Behind = Porter-Duff destination-over
    if (compositeOp === 'source-atop') {
      // Alpha-locked behind cannot paint onto transparent pixels and cannot change opaque front pixels
      if (da === 0 || da >= 255) {
        out[0] = dr;
        out[1] = dg;
        out[2] = db;
        out[3] = da;
        return;
      }
      const dA = da / 255;
      const sA = effA / 255;
      const rem = (1 - dA) * sA;
      const denom = dA + rem;
      if (denom > 0) {
        const inv = 1 / denom;
        out[0] = Math.round((dr * dA + sr * rem) * inv);
        out[1] = Math.round((dg * dA + sg * rem) * inv);
        out[2] = Math.round((db * dA + sb * rem) * inv);
      } else {
        out[0] = dr;
        out[1] = dg;
        out[2] = db;
      }
      out[3] = da;
      return;
    }
    if (da >= 255) {
      out[0] = dr;
      out[1] = dg;
      out[2] = db;
      out[3] = da;
      return;
    }
    if (da === 0) {
      out[0] = sr;
      out[1] = sg;
      out[2] = sb;
      out[3] = effA;
      return;
    }
    const dA = da / 255;
    const sA = effA / 255;
    const invDA = 1 - dA;
    const compA = dA + sA * invDA;
    const invOut = 1 / compA;
    out[0] = Math.round((dr * dA + sr * sA * invDA) * invOut);
    out[1] = Math.round((dg * dA + sg * sA * invDA) * invOut);
    out[2] = Math.round((db * dA + sb * sA * invDA) * invOut);
    out[3] = Math.round(compA * 255);
    return;
  }

  if (mode === 'compare-density') {
    if (compositeOp === 'source-atop' && da === 0) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
      return;
    }
    if (da === 0) {
      out[0] = sr;
      out[1] = sg;
      out[2] = sb;
      out[3] = effA;
      return;
    }
    const sA = effA / 255;
    const dA = da / 255;
    const dstWeight = dA * (1 - sA);
    const denom = sA + dstWeight;
    if (denom <= 1e-6) {
      out[0] = dr;
      out[1] = dg;
      out[2] = db;
      out[3] = da;
      return;
    }
    const invDenom = 1 / denom;
    out[0] = Math.round((sr * sA + dr * dstWeight) * invDenom);
    out[1] = Math.round((sg * sA + dg * dstWeight) * invDenom);
    out[2] = Math.round((sb * sA + db * dstWeight) * invDenom);
    out[3] = compositeOp === 'source-atop' ? da : Math.max(effA, da);
    return;
  }

  const isStandardNormal = mode === 'normal' || mode === 'pass-through';

  if (compositeOp === 'source-atop') {
    if (da === 0) {
      out[0] = dr;
      out[1] = dg;
      out[2] = db;
      out[3] = 0;
      return;
    }
    const sA = effA / 255;
    if (isStandardNormal) {
      if (effA >= 255) {
        out[0] = sr;
        out[1] = sg;
        out[2] = sb;
        out[3] = da;
      } else {
        const inv = 1 - sA;
        out[0] = Math.round(sr * sA + dr * inv);
        out[1] = Math.round(sg * sA + dg * inv);
        out[2] = Math.round(sb * sA + db * inv);
        out[3] = da;
      }
      return;
    }
    evaluateCpuBlendModeInto(dr / 255, dg / 255, db / 255, sr / 255, sg / 255, sb / 255, mode, _blendRgbOut);
    const inv = 1 - sA;
    out[0] = Math.round(_blendRgbOut[0] * 255 * sA + dr * inv);
    out[1] = Math.round(_blendRgbOut[1] * 255 * sA + dg * inv);
    out[2] = Math.round(_blendRgbOut[2] * 255 * sA + db * inv);
    out[3] = da;
    return;
  }

  // Standard source-over with optional CSP color blend mode
  if (da === 0) {
    out[0] = sr;
    out[1] = sg;
    out[2] = sb;
    out[3] = effA;
    return;
  }

  if (isStandardNormal) {
    if (effA >= 255) {
      out[0] = sr;
      out[1] = sg;
      out[2] = sb;
      out[3] = 255;
      return;
    }
    const sA = effA / 255;
    const dA = da / 255;
    const invSA = 1 - sA;
    const compA = sA + dA * invSA;
    if (compA > 0) {
      const invOut = 1 / compA;
      out[0] = Math.round((sr * sA + dr * dA * invSA) * invOut);
      out[1] = Math.round((sg * sA + dg * dA * invSA) * invOut);
      out[2] = Math.round((sb * sA + db * dA * invSA) * invOut);
      out[3] = Math.round(compA * 255);
    } else {
      out[0] = dr;
      out[1] = dg;
      out[2] = db;
      out[3] = da;
    }
    return;
  }

  // W3C Compositing & Blending Level 1 formula for non-normal blend modes:
  // Cr = (1 - dA) * Cs + dA * B(Cb, Cs)
  // Co * Ao = sA * Cr + (1 - sA) * dA * Cb
  // Ao = sA + dA * (1 - sA)
  const sA = effA / 255;
  const dA = da / 255;
  const invSA = 1 - sA;
  const invDA = 1 - dA;
  const compA = sA + dA * invSA;
  const inv255 = 1 / 255;
  const srN = sr * inv255;
  const sgN = sg * inv255;
  const sbN = sb * inv255;
  const drN = dr * inv255;
  const dgN = dg * inv255;
  const dbN = db * inv255;

  evaluateCpuBlendModeInto(drN, dgN, dbN, srN, sgN, sbN, mode, _blendRgbOut);

  const crR = invDA * srN + dA * _blendRgbOut[0];
  const crG = invDA * sgN + dA * _blendRgbOut[1];
  const crB = invDA * sbN + dA * _blendRgbOut[2];

  if (compA > 0) {
    const invOut = 255 / compA;
    out[0] = Math.max(0, Math.min(255, Math.round((sA * crR + invSA * dA * drN) * invOut)));
    out[1] = Math.max(0, Math.min(255, Math.round((sA * crG + invSA * dA * dgN) * invOut)));
    out[2] = Math.max(0, Math.min(255, Math.round((sA * crB + invSA * dA * dbN) * invOut)));
    out[3] = Math.max(0, Math.min(255, Math.round(compA * 255)));
  } else {
    out[0] = dr;
    out[1] = dg;
    out[2] = db;
    out[3] = da;
  }
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
    brushCombineMode,
    monochrome,
    selectionMask,
    snapshotOut,
    suppressNotify = false,
  } = options;
  const opacity = Math.max(0, Math.min(1, options.opacity));
  const w = strokeData.width;
  const h = strokeData.height;
  if (w <= 0 || h <= 0 || opacity <= 0.001) return false;

  const effectiveCombineMode: CspBrushCombineMode =
    compositeOp === 'destination-out' ? 'clear' : brushCombineMode ?? 'normal';
  const useCustomBlend = isCustomBrushCombineMode(effectiveCombineMode);
  const isEraseOp = compositeOp === 'destination-out' || effectiveCombineMode === 'clear';
  const pigmentStrength = Math.max(0, Math.min(1, options.pigmentStrength ?? 0));
  const pigmentWhiteGround = Boolean(options.pigmentWhiteGround);
  const usePigmentComposite =
    pigmentStrength > 0.005 && !isEraseOp && isPigmentCompatibleCombineMode(effectiveCombineMode);

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
  const pxOut: [number, number, number, number] = [0, 0, 0, 0];

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
      if ((isEraseOp || compositeOp === 'source-atop') && (!existingTile || !existingTile.data)) {
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

            if (isEraseOp) {
              if (effA >= 128) {
                dst[byteIdx] &= ~mask;
              }
            } else if (effectiveCombineMode === 'behind') {
              const hadInk = (dst[byteIdx] & mask) !== 0;
              if (!hadInk && compositeOp !== 'source-atop') {
                const r = srcData[srcOff];
                const g = srcData[srcOff + 1];
                const b = srcData[srcOff + 2];
                const lum = (19595 * r + 38470 * g + 7471 * b + 32768) >> 16;
                if (effA >= 128 && lum < monoThresh && monoExpressBlack) {
                  dst[byteIdx] |= mask;
                }
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

            if (usePigmentComposite) {
              compositePigmentOverPixelInto(
                outR,
                outG,
                outB,
                da,
                sr,
                sg,
                sb,
                effA,
                pigmentStrength,
                pigmentWhiteGround,
                compositeOp,
                effectiveCombineMode,
                pxOut
              );
              outR = pxOut[0];
              outG = pxOut[1];
              outB = pxOut[2];
              outA = pxOut[3];
            } else if (useCustomBlend) {
              compositeBrushPixelInto(
                outR,
                outG,
                outB,
                da,
                sr,
                sg,
                sb,
                effA,
                compositeOp,
                effectiveCombineMode,
                pxOut
              );
              outR = pxOut[0];
              outG = pxOut[1];
              outB = pxOut[2];
              outA = pxOut[3];
            } else if (compositeOp === 'destination-out') {
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
            if (effA <= 0) continue;
            compositeBrushPixelInto(
              tileScratch[dstOff],
              tileScratch[dstOff + 1],
              tileScratch[dstOff + 2],
              tileScratch[dstOff + 3],
              srcData[srcOff],
              srcData[srcOff + 1],
              srcData[srcOff + 2],
              effA,
              compositeOp,
              effectiveCombineMode,
              pxOut
            );
            tileScratch[dstOff] = pxOut[0];
            tileScratch[dstOff + 1] = pxOut[1];
            tileScratch[dstOff + 2] = pxOut[2];
            tileScratch[dstOff + 3] = pxOut[3];
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
