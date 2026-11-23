/**
 * Professional Retouch Engine — Smudge, Blur, Dodge, Burn & Clone Stamp
 *
 * Operates directly on SparseTileGrid ROIs with zero full-document canvas allocations.
 * Uses premultiplied alpha math across Smudge/Blur/Clone to prevent dark edge fringes,
 * Rec.709 luminance tonal weighting for Dodge/Burn, and lazy per-tile snapshots for undo.
 */

import type {
  CanvasDimensions,
  DirtyRect,
  LayerItem,
  Point2D,
} from '../types/editor';
import {
  BYTES_32BIT,
  SparseTileGrid,
  TILE_SIZE,
  TileFormat,
  TileSnapshotEntry,
  getTileKey,
  unpack1BitToRGBA,
  unpack8BitToRGBA,
} from './tileEngine';
import { parseHexRgb } from './gradientEngine';
import {
  RgbColor,
  decodeSpectralKSToSrgb,
  encodeSrgbToSpectralKS,
  mixPigmentRgbOut,
} from './colorMixingEngine';

const _smudgeMixOut: RgbColor = { r: 0, g: 0, b: 0 };
const _smudgeReloadOut: RgbColor = { r: 0, g: 0, b: 0 };
const _blurDecodeOut: RgbColor = { r: 0, g: 0, b: 0 };
const _blurMixOut: RgbColor = { r: 0, g: 0, b: 0 };

export type RetouchMode = 'smudge' | 'blur' | 'dodge' | 'burn' | 'clone-stamp';
export type RetouchTonalRange = 'shadows' | 'midtones' | 'highlights';
export type CloneSampleMode = 'active' | 'all-visible';

export interface RetouchSettings {
  mode: RetouchMode;
  size: number; // 2..300 px
  strength: number; // 1..100 %
  hardness: number; // 0..100 %
  spacing: number; // 0.05..0.5
  usePressure: boolean;
  tonalRange: RetouchTonalRange; // Dodge / Burn range
  protectTones: boolean; // Dodge / Burn hue preservation
  smudgeFingerPainting: boolean; // Load primary color at stroke start
  pigmentBlending: boolean; // Physical 7-band Kubelka-Munk spectral pigment blending for Smudge & Blur
  pigmentStrength: number; // 0..100 % Kubelka-Munk pigment blending strength
  cloneAligned: boolean; // Keep relative offset across strokes
  cloneSampleMode: CloneSampleMode; // Active layer vs all visible composited
}

export const DEFAULT_RETOUCH_SETTINGS: RetouchSettings = {
  mode: 'smudge',
  size: 40,
  strength: 50,
  hardness: 45,
  spacing: 0.15,
  usePressure: true,
  tonalRange: 'midtones',
  protectTones: true,
  smudgeFingerPainting: false,
  pigmentBlending: false,
  pigmentStrength: 100,
  cloneAligned: true,
  cloneSampleMode: 'active',
};

export interface RetouchStrokeSession {
  mode: RetouchMode;
  layerId: string;
  targetFormat: TileFormat;
  alphaLock: boolean;
  dimensions: CanvasDimensions;
  selectionMask: Uint8Array | null;
  beforeSnapshot: Map<string, TileSnapshotEntry>;
  dirtyRect: DirtyRect | null;
  lastDabPos: Point2D | null;
  remainderDist: number;
  // Smudge state: premultiplied RGBA float buffer of size dabDim * dabDim * 4
  smudgeBuf: Float32Array | null;
  smudgeDim: number;
  // Clone Stamp state
  cloneOffset: Point2D | null; // source - dest
  cloneSourceTileCache: Map<string, Uint8ClampedArray | null>;
  visibleLayers?: LayerItem[];
  isLayerVisible?: (layer: LayerItem) => boolean;
  getEffectiveOpacity?: (layer: LayerItem) => number;
}

function clamp255(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : v;
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

function mergeDirty(a: DirtyRect | null, b: DirtyRect): DirtyRect {
  if (!a) return { ...b };
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Radial falloff weight in [0, 1] matching hardness in [0, 1].
 */
export function computeBrushFalloff(distNorm: number, hardness: number): number {
  if (distNorm >= 1) return 0;
  if (hardness >= 0.999) return 1;
  if (distNorm <= hardness) return 1;
  const t = (distNorm - hardness) / Math.max(1e-4, 1 - hardness);
  // Smoothstep C1 falloff
  const inv = 1 - t;
  return inv * inv * (3 - 2 * inv);
}

/**
 * Snapshots all tiles intersecting `[x, y, w, h]` lazily before mutation.
 */
function snapshotRoiTiles(
  grid: SparseTileGrid,
  layerId: string,
  x: number,
  y: number,
  w: number,
  h: number,
  beforeSnapshot: Map<string, TileSnapshotEntry>
): void {
  if (w <= 0 || h <= 0) return;
  const minTx = Math.floor(x / TILE_SIZE);
  const maxTx = Math.floor((x + w - 1) / TILE_SIZE);
  const minTy = Math.floor(y / TILE_SIZE);
  const maxTy = Math.floor((y + h - 1) / TILE_SIZE);
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      grid.snapshotSingleTileInto(layerId, tx, ty, beforeSnapshot);
    }
  }
}

/**
 * Creates a new retouch stroke session.
 */
export function createRetouchStrokeSession(params: {
  mode: RetouchMode;
  layerId: string;
  targetFormat: TileFormat;
  alphaLock: boolean;
  dimensions: CanvasDimensions;
  selectionMask: Uint8Array | null;
  cloneOffset?: Point2D | null;
  visibleLayers?: LayerItem[];
  isLayerVisible?: (layer: LayerItem) => boolean;
  getEffectiveOpacity?: (layer: LayerItem) => number;
}): RetouchStrokeSession {
  return {
    mode: params.mode,
    layerId: params.layerId,
    targetFormat: params.targetFormat,
    alphaLock: params.alphaLock,
    dimensions: params.dimensions,
    selectionMask: params.selectionMask,
    beforeSnapshot: new Map<string, TileSnapshotEntry>(),
    dirtyRect: null,
    lastDabPos: null,
    remainderDist: 0,
    smudgeBuf: null,
    smudgeDim: 0,
    cloneOffset: params.cloneOffset ? { ...params.cloneOffset } : null,
    cloneSourceTileCache: new Map<string, Uint8ClampedArray | null>(),
    visibleLayers: params.visibleLayers,
    isLayerVisible: params.isLayerVisible,
    getEffectiveOpacity: params.getEffectiveOpacity,
  };
}

function readCachedPreStrokeTile(
  grid: SparseTileGrid,
  session: RetouchStrokeSession,
  layerId: string,
  tx: number,
  ty: number
): Uint8ClampedArray | null {
  const key = getTileKey(layerId, tx, ty, 0);
  if (session.cloneSourceTileCache.has(key)) {
    return session.cloneSourceTileCache.get(key) ?? null;
  }

  // Prefer pre-stroke snapshot if this tile was already mutated during the current stroke
  const snap = session.beforeSnapshot.get(key);
  if (snap) {
    if (!snap.data) {
      session.cloneSourceTileCache.set(key, null);
      return null;
    }
    const rgba = new Uint8ClampedArray(BYTES_32BIT);
    if (snap.format === 'color-32bit') {
      rgba.set(snap.data);
    } else if (snap.format === 'monochrome-1bit') {
      unpack1BitToRGBA(snap.data, rgba);
    } else {
      unpack8BitToRGBA(snap.data, rgba);
    }
    session.cloneSourceTileCache.set(key, rgba);
    return rgba;
  }

  const tile = grid.getTile(layerId, tx, ty, 0);
  if (!tile || !tile.data) {
    session.cloneSourceTileCache.set(key, null);
    return null;
  }
  const rgba = new Uint8ClampedArray(BYTES_32BIT);
  if (tile.format === 'color-32bit') {
    rgba.set(tile.data);
  } else if (tile.format === 'monochrome-1bit') {
    unpack1BitToRGBA(tile.data, rgba);
  } else {
    unpack8BitToRGBA(tile.data, rgba);
  }
  session.cloneSourceTileCache.set(key, rgba);
  return rgba;
}

function samplePreStrokePixel(
  grid: SparseTileGrid,
  session: RetouchStrokeSession,
  px: number,
  py: number,
  sampleMode: CloneSampleMode,
  out: [number, number, number, number]
): void {
  const docW = session.dimensions.width;
  const docH = session.dimensions.height;
  if (px < 0 || py < 0 || px >= docW || py >= docH) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    return;
  }
  const tx = Math.floor(px / TILE_SIZE);
  const ty = Math.floor(py / TILE_SIZE);
  const lx = px - tx * TILE_SIZE;
  const ly = py - ty * TILE_SIZE;
  const off = (ly * TILE_SIZE + lx) * 4;

  if (sampleMode === 'active' || !session.visibleLayers) {
    const rgba = readCachedPreStrokeTile(grid, session, session.layerId, tx, ty);
    if (!rgba) {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
      return;
    }
    out[0] = rgba[off];
    out[1] = rgba[off + 1];
    out[2] = rgba[off + 2];
    out[3] = rgba[off + 3];
    return;
  }

  // Composite all visible layers bottom-to-top (layers array is top-to-bottom)
  let accR = 0;
  let accG = 0;
  let accB = 0;
  let accA = 0;
  const layers = session.visibleLayers;
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (l.type === 'folder' || l.type === 'frame-folder' || l.type === 'adjustment') continue;
    if (session.isLayerVisible && !session.isLayerVisible(l)) continue;
    const rgba = readCachedPreStrokeTile(grid, session, l.id, tx, ty);
    if (!rgba) continue;
    const saRaw = rgba[off + 3];
    if (saRaw === 0) continue;
    const op = session.getEffectiveOpacity ? session.getEffectiveOpacity(l) : (l.opacity ?? 1);
    const sa = (saRaw / 255) * op;
    const inv = 1 - sa;
    accR = rgba[off] * sa + accR * inv;
    accG = rgba[off + 1] * sa + accG * inv;
    accB = rgba[off + 2] * sa + accB * inv;
    accA = sa + accA * inv;
  }

  if (accA <= 1e-6) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
  } else {
    out[0] = clamp255(Math.round(accR / accA));
    out[1] = clamp255(Math.round(accG / accA));
    out[2] = clamp255(Math.round(accB / accA));
    out[3] = clamp255(Math.round(accA * 255));
  }
}

function applySmudgeDab(
  grid: SparseTileGrid,
  session: RetouchStrokeSession,
  cx: number,
  cy: number,
  radius: number,
  strength: number,
  hardness: number,
  primaryColor: string,
  fingerPainting: boolean,
  pigmentBlending: boolean = false,
  pigmentStrength: number = 1.0
): DirtyRect | null {
  const docW = session.dimensions.width;
  const docH = session.dimensions.height;
  const rCeil = Math.max(1, Math.ceil(radius));
  const dim = rCeil * 2 + 1;
  const ix0 = Math.round(cx) - rCeil;
  const iy0 = Math.round(cy) - rCeil;

  const rx0 = Math.max(0, ix0);
  const ry0 = Math.max(0, iy0);
  const rx1 = Math.min(docW, ix0 + dim);
  const ry1 = Math.min(docH, iy0 + dim);
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;
  if (rw <= 0 || rh <= 0) return null;

  const roi = grid.readImageData(session.layerId, rx0, ry0, rw, rh);
  const data = roi.data;

  // Initialize pickup buffer on first dab of stroke
  if (!session.smudgeBuf || session.smudgeDim !== dim) {
    const buf = new Float32Array(dim * dim * 4);
    const [pr, pg, pb] = parseHexRgb(primaryColor);

    for (let dy = 0; dy < dim; dy++) {
      const gy = iy0 + dy;
      const inY = gy >= ry0 && gy < ry1;
      for (let dx = 0; dx < dim; dx++) {
        const gx = ix0 + dx;
        const bIdx = (dy * dim + dx) * 4;
        if (fingerPainting) {
          buf[bIdx] = pr;
          buf[bIdx + 1] = pg;
          buf[bIdx + 2] = pb;
          buf[bIdx + 3] = 255;
        } else if (inY && gx >= rx0 && gx < rx1) {
          const rIdx = ((gy - ry0) * rw + (gx - rx0)) * 4;
          const a = data[rIdx + 3] / 255;
          buf[bIdx] = data[rIdx] * a;
          buf[bIdx + 1] = data[rIdx + 1] * a;
          buf[bIdx + 2] = data[rIdx + 2] * a;
          buf[bIdx + 3] = data[rIdx + 3];
        }
      }
    }
    session.smudgeBuf = buf;
    session.smudgeDim = dim;
    if (!fingerPainting) {
      return null; // Pickup only on initial touch
    }
  }

  snapshotRoiTiles(grid, session.layerId, rx0, ry0, rw, rh, session.beforeSnapshot);

  const buf = session.smudgeBuf;
  const selMask = session.selectionMask;
  const invR = 1 / Math.max(1, radius);
  const alphaLock = session.alphaLock;
  const str = clamp01(strength);
  let touched = false;

  for (let py = ry0; py < ry1; py++) {
    const by = py - iy0;
    const distY = py + 0.5 - cy;
    const selRow = py * docW;
    const roiRow = (py - ry0) * rw;

    for (let px = rx0; px < rx1; px++) {
      const bx = px - ix0;
      const distX = px + 0.5 - cx;
      const dNorm = Math.hypot(distX, distY) * invR;
      if (dNorm >= 1) continue;

      let w = computeBrushFalloff(dNorm, hardness) * str;
      if (selMask) {
        const m = selMask[selRow + px];
        if (m === 0) continue;
        w *= m / 255;
      }
      if (w <= 1e-4) continue;

      const rIdx = (roiRow + (px - rx0)) * 4;
      const bIdx = (by * dim + bx) * 4;

      const dstA = data[rIdx + 3];
      if (alphaLock && dstA === 0) continue;

      const dstANorm = dstA / 255;
      const dstPR = data[rIdx] * dstANorm;
      const dstPG = data[rIdx + 1] * dstANorm;
      const dstPB = data[rIdx + 2] * dstANorm;

      const srcPR = buf[bIdx];
      const srcPG = buf[bIdx + 1];
      const srcPB = buf[bIdx + 2];
      const srcA = buf[bIdx + 3];

      const invW = 1 - w;
      const outA = alphaLock ? dstA : dstA * invW + srcA * w;
      let outPR: number;
      let outPG: number;
      let outPB: number;
      let outR = 0;
      let outG = 0;
      let outB = 0;

      const usePigment = pigmentBlending && pigmentStrength > 0.005 && dstA > 0.5 && srcA > 0.5;
      if (usePigment) {
        const invSrcA = 255 / srcA;
        const srcR = srcPR * invSrcA;
        const srcG = srcPG * invSrcA;
        const srcB = srcPB * invSrcA;
        const colorW = (srcA * w) / Math.max(1e-4, dstA * invW + srcA * w);
        mixPigmentRgbOut(
          data[rIdx],
          data[rIdx + 1],
          data[rIdx + 2],
          srcR,
          srcG,
          srcB,
          colorW,
          pigmentStrength,
          _smudgeMixOut
        );
        outR = _smudgeMixOut.r;
        outG = _smudgeMixOut.g;
        outB = _smudgeMixOut.b;
        const outANorm = outA / 255;
        outPR = outR * outANorm;
        outPG = outG * outANorm;
        outPB = outB * outANorm;
      } else {
        outPR = dstPR * invW + srcPR * w;
        outPG = dstPG * invW + srcPG * w;
        outPB = dstPB * invW + srcPB * w;
        if (outA > 0.5) {
          const invOutA = 255 / outA;
          outR = outPR * invOutA;
          outG = outPG * invOutA;
          outB = outPB * invOutA;
        }
      }

      if (outA <= 0.5) {
        data[rIdx] = 0;
        data[rIdx + 1] = 0;
        data[rIdx + 2] = 0;
        data[rIdx + 3] = 0;
      } else {
        data[rIdx] = clamp255(Math.round(outR));
        data[rIdx + 1] = clamp255(Math.round(outG));
        data[rIdx + 2] = clamp255(Math.round(outB));
        data[rIdx + 3] = clamp255(Math.round(outA));
      }

      // Reload pickup buffer from blended canvas pixel (prevents rapid fadeout while picking up new pigment)
      const pickupRate = 1 - str * 0.88;
      const invPickup = 1 - pickupRate;
      const nextBufA = srcA * invPickup + outA * pickupRate;
      if (usePigment && nextBufA > 0.5) {
        const invSrcA = 255 / srcA;
        const reloadColorW = (outA * pickupRate) / Math.max(1e-4, srcA * invPickup + outA * pickupRate);
        mixPigmentRgbOut(
          srcPR * invSrcA,
          srcPG * invSrcA,
          srcPB * invSrcA,
          outR,
          outG,
          outB,
          reloadColorW,
          pigmentStrength,
          _smudgeReloadOut
        );
        const nextANorm = nextBufA / 255;
        buf[bIdx] = _smudgeReloadOut.r * nextANorm;
        buf[bIdx + 1] = _smudgeReloadOut.g * nextANorm;
        buf[bIdx + 2] = _smudgeReloadOut.b * nextANorm;
        buf[bIdx + 3] = nextBufA;
      } else {
        buf[bIdx] = srcPR * invPickup + outPR * pickupRate;
        buf[bIdx + 1] = srcPG * invPickup + outPG * pickupRate;
        buf[bIdx + 2] = srcPB * invPickup + outPB * pickupRate;
        buf[bIdx + 3] = nextBufA;
      }
      touched = true;
    }
  }

  if (!touched) return null;
  grid.writeImageData(session.layerId, roi, rx0, ry0, session.targetFormat, true);
  return { x: rx0, y: ry0, width: rw, height: rh };
}

function applyBlurDab(
  grid: SparseTileGrid,
  session: RetouchStrokeSession,
  cx: number,
  cy: number,
  radius: number,
  strength: number,
  hardness: number,
  pigmentBlending: boolean = false,
  pigmentStrength: number = 1.0
): DirtyRect | null {
  const docW = session.dimensions.width;
  const docH = session.dimensions.height;
  const blurK = Math.max(1, Math.min(6, Math.round(1 + strength * 4)));
  const rCeil = Math.max(1, Math.ceil(radius));

  const rx0 = Math.max(0, Math.floor(cx - rCeil));
  const ry0 = Math.max(0, Math.floor(cy - rCeil));
  const rx1 = Math.min(docW, Math.ceil(cx + rCeil));
  const ry1 = Math.min(docH, Math.ceil(cy + rCeil));
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;
  if (rw <= 0 || rh <= 0) return null;

  // Read padded source ROI for border-artifact-free convolution
  const px0 = Math.max(0, rx0 - blurK);
  const py0 = Math.max(0, ry0 - blurK);
  const px1 = Math.min(docW, rx1 + blurK);
  const py1 = Math.min(docH, ry1 + blurK);
  const pw = px1 - px0;
  const ph = py1 - py0;

  const srcRoi = grid.readImageData(session.layerId, px0, py0, pw, ph);
  const srcData = srcRoi.data;

  const usePigment = pigmentBlending && pigmentStrength > 0.005;
  const kSize = blurK * 2 + 1;
  const invK = 1 / kSize;

  // Convert to premultiplied Float32 for fringe-free separable box blur
  const premul = new Float32Array(pw * ph * 4);
  const horiz = new Float32Array(pw * ph * 4);
  for (let i = 0; i < pw * ph; i++) {
    const o = i * 4;
    const a = srcData[o + 3] / 255;
    premul[o] = srcData[o] * a;
    premul[o + 1] = srcData[o + 1] * a;
    premul[o + 2] = srcData[o + 2] * a;
    premul[o + 3] = srcData[o + 3];
  }

  // Optional 10-channel premultiplied Kubelka-Munk K/S + residual buffers for true spectral pigment blur
  let specPremul: Float32Array | null = null;
  let specHoriz: Float32Array | null = null;
  if (usePigment) {
    specPremul = new Float32Array(pw * ph * 10);
    specHoriz = new Float32Array(pw * ph * 10);
    const tmpSpec = new Float32Array(10);
    for (let i = 0; i < pw * ph; i++) {
      const o = i * 4;
      const a = srcData[o + 3] / 255;
      if (a > 0) {
        encodeSrgbToSpectralKS(srcData[o], srcData[o + 1], srcData[o + 2], tmpSpec, 0);
        const so = i * 10;
        for (let c = 0; c < 10; c++) {
          specPremul[so + c] = tmpSpec[c] * a;
        }
      }
    }
  }

  // Horizontal pass
  const sRowSum = usePigment ? new Float32Array(10) : null;
  for (let y = 0; y < ph; y++) {
    const rowBase = y * pw;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sa = 0;
    if (sRowSum) sRowSum.fill(0);
    for (let k = -blurK; k <= blurK; k++) {
      const sx = k < 0 ? 0 : k >= pw ? pw - 1 : k;
      const o = (rowBase + sx) * 4;
      sr += premul[o];
      sg += premul[o + 1];
      sb += premul[o + 2];
      sa += premul[o + 3];
      if (sRowSum && specPremul) {
        const so = (rowBase + sx) * 10;
        for (let c = 0; c < 10; c++) sRowSum[c] += specPremul[so + c];
      }
    }
    for (let x = 0; x < pw; x++) {
      const o = (rowBase + x) * 4;
      horiz[o] = sr * invK;
      horiz[o + 1] = sg * invK;
      horiz[o + 2] = sb * invK;
      horiz[o + 3] = sa * invK;
      if (sRowSum && specHoriz) {
        const so = (rowBase + x) * 10;
        for (let c = 0; c < 10; c++) specHoriz[so + c] = sRowSum[c] * invK;
      }

      const remX = x - blurK < 0 ? 0 : x - blurK;
      const addX = x + blurK + 1 >= pw ? pw - 1 : x + blurK + 1;
      const ro = (rowBase + remX) * 4;
      const ao = (rowBase + addX) * 4;
      sr += premul[ao] - premul[ro];
      sg += premul[ao + 1] - premul[ro + 1];
      sb += premul[ao + 2] - premul[ro + 2];
      sa += premul[ao + 3] - premul[ro + 3];
      if (sRowSum && specPremul) {
        const rso = (rowBase + remX) * 10;
        const aso = (rowBase + addX) * 10;
        for (let c = 0; c < 10; c++) sRowSum[c] += specPremul[aso + c] - specPremul[rso + c];
      }
    }
  }

  // Vertical pass only over inner destination ROI
  const outRoi = grid.readImageData(session.layerId, rx0, ry0, rw, rh);
  const outData = outRoi.data;
  const selMask = session.selectionMask;
  const invR = 1 / Math.max(1, radius);
  const alphaLock = session.alphaLock;
  const blendStr = clamp01(strength);
  let touched = false;

  snapshotRoiTiles(grid, session.layerId, rx0, ry0, rw, rh, session.beforeSnapshot);

  const sColSum = usePigment ? new Float32Array(10) : null;
  const sColDec = usePigment ? new Float32Array(10) : null;

  for (let lx = 0; lx < rw; lx++) {
    const sx = rx0 - px0 + lx;
    const gx = rx0 + lx;
    const distX = gx + 0.5 - cx;

    const startY = ry0 - py0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sa = 0;
    if (sColSum) sColSum.fill(0);
    for (let k = -blurK; k <= blurK; k++) {
      const sy = Math.max(0, Math.min(ph - 1, startY + k));
      const o = (sy * pw + sx) * 4;
      sr += horiz[o];
      sg += horiz[o + 1];
      sb += horiz[o + 2];
      sa += horiz[o + 3];
      if (sColSum && specHoriz) {
        const so = (sy * pw + sx) * 10;
        for (let c = 0; c < 10; c++) sColSum[c] += specHoriz[so + c];
      }
    }

    for (let ly = 0; ly < rh; ly++) {
      const gy = ry0 + ly;
      const curY = startY + ly;
      const br = sr * invK;
      const bg = sg * invK;
      const bb = sb * invK;
      const ba = sa * invK;

      let pigBlurR = 0;
      let pigBlurG = 0;
      let pigBlurB = 0;
      const hasPigBlur = Boolean(sColSum && sColDec && ba > 0.5);
      if (hasPigBlur && sColSum && sColDec) {
        const invAlphaNorm = 1 / ((ba / 255) * kSize);
        for (let c = 0; c < 10; c++) {
          sColDec[c] = sColSum[c] * invAlphaNorm;
        }
        decodeSpectralKSToSrgb(sColDec, 0, _blurDecodeOut);
        const invBa = 255 / ba;
        const regBlurR = br * invBa;
        const regBlurG = bg * invBa;
        const regBlurB = bb * invBa;
        pigBlurR = regBlurR + (_blurDecodeOut.r - regBlurR) * pigmentStrength;
        pigBlurG = regBlurG + (_blurDecodeOut.g - regBlurG) * pigmentStrength;
        pigBlurB = regBlurB + (_blurDecodeOut.b - regBlurB) * pigmentStrength;
      }

      const remY = Math.max(0, curY - blurK);
      const addY = Math.min(ph - 1, curY + blurK + 1);
      const ro = (remY * pw + sx) * 4;
      const ao = (addY * pw + sx) * 4;
      sr += horiz[ao] - horiz[ro];
      sg += horiz[ao + 1] - horiz[ro + 1];
      sb += horiz[ao + 2] - horiz[ro + 2];
      sa += horiz[ao + 3] - horiz[ro + 3];
      if (sColSum && specHoriz) {
        const rso = (remY * pw + sx) * 10;
        const aso = (addY * pw + sx) * 10;
        for (let c = 0; c < 10; c++) sColSum[c] += specHoriz[aso + c] - specHoriz[rso + c];
      }

      const distY = gy + 0.5 - cy;
      const dNorm = Math.hypot(distX, distY) * invR;
      if (dNorm >= 1) continue;

      let w = computeBrushFalloff(dNorm, hardness) * blendStr;
      if (selMask) {
        const m = selMask[gy * docW + gx];
        if (m === 0) continue;
        w *= m / 255;
      }
      if (w <= 1e-4) continue;

      const oIdx = (ly * rw + lx) * 4;
      const dstA = outData[oIdx + 3];
      if (alphaLock && dstA === 0) continue;

      const invW = 1 - w;
      const finalA = alphaLock ? dstA : dstA * invW + ba * w;

      if (finalA <= 0.5) {
        outData[oIdx] = 0;
        outData[oIdx + 1] = 0;
        outData[oIdx + 2] = 0;
        outData[oIdx + 3] = 0;
      } else if (hasPigBlur && dstA > 0.5) {
        const colorW = (ba * w) / Math.max(1e-4, dstA * invW + ba * w);
        mixPigmentRgbOut(
          outData[oIdx],
          outData[oIdx + 1],
          outData[oIdx + 2],
          pigBlurR,
          pigBlurG,
          pigBlurB,
          colorW,
          pigmentStrength,
          _blurMixOut
        );
        outData[oIdx] = clamp255(Math.round(_blurMixOut.r));
        outData[oIdx + 1] = clamp255(Math.round(_blurMixOut.g));
        outData[oIdx + 2] = clamp255(Math.round(_blurMixOut.b));
        outData[oIdx + 3] = clamp255(Math.round(finalA));
      } else {
        const dstANorm = dstA / 255;
        const finalPR = outData[oIdx] * dstANorm * invW + br * w;
        const finalPG = outData[oIdx + 1] * dstANorm * invW + bg * w;
        const finalPB = outData[oIdx + 2] * dstANorm * invW + bb * w;
        const invA = 255 / finalA;
        outData[oIdx] = clamp255(Math.round(finalPR * invA));
        outData[oIdx + 1] = clamp255(Math.round(finalPG * invA));
        outData[oIdx + 2] = clamp255(Math.round(finalPB * invA));
        outData[oIdx + 3] = clamp255(Math.round(finalA));
      }
      touched = true;
    }
  }

  if (!touched) return null;
  grid.writeImageData(session.layerId, outRoi, rx0, ry0, session.targetFormat, true);
  return { x: rx0, y: ry0, width: rw, height: rh };
}

function tonalRangeWeight(lum: number, range: RetouchTonalRange): number {
  const l = clamp01(lum);
  if (range === 'shadows') {
    const inv = 1 - l;
    return inv * inv;
  }
  if (range === 'highlights') {
    return l * l;
  }
  // Midtones bell curve peaking at 0.5
  return 4 * l * (1 - l);
}

function applyDodgeBurnDab(
  grid: SparseTileGrid,
  session: RetouchStrokeSession,
  mode: 'dodge' | 'burn',
  cx: number,
  cy: number,
  radius: number,
  strength: number,
  hardness: number,
  tonalRange: RetouchTonalRange,
  protectTones: boolean
): DirtyRect | null {
  const docW = session.dimensions.width;
  const docH = session.dimensions.height;
  const rCeil = Math.max(1, Math.ceil(radius));

  const rx0 = Math.max(0, Math.floor(cx - rCeil));
  const ry0 = Math.max(0, Math.floor(cy - rCeil));
  const rx1 = Math.min(docW, Math.ceil(cx + rCeil));
  const ry1 = Math.min(docH, Math.ceil(cy + rCeil));
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;
  if (rw <= 0 || rh <= 0) return null;

  const roi = grid.readImageData(session.layerId, rx0, ry0, rw, rh);
  const data = roi.data;
  const selMask = session.selectionMask;
  const invR = 1 / Math.max(1, radius);
  const exposure = clamp01(strength) * 0.32;
  let touched = false;

  snapshotRoiTiles(grid, session.layerId, rx0, ry0, rw, rh, session.beforeSnapshot);

  for (let ly = 0; ly < rh; ly++) {
    const gy = ry0 + ly;
    const distY = gy + 0.5 - cy;
    const selRow = gy * docW;
    const roiRow = ly * rw;

    for (let lx = 0; lx < rw; lx++) {
      const gx = rx0 + lx;
      const distX = gx + 0.5 - cx;
      const dNorm = Math.hypot(distX, distY) * invR;
      if (dNorm >= 1) continue;

      const idx = (roiRow + lx) * 4;
      if (data[idx + 3] === 0) continue;

      let w = computeBrushFalloff(dNorm, hardness);
      if (selMask) {
        const m = selMask[selRow + gx];
        if (m === 0) continue;
        w *= m / 255;
      }
      if (w <= 1e-4) continue;

      const r = data[idx] / 255;
      const g = data[idx + 1] / 255;
      const b = data[idx + 2] / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const tw = tonalRangeWeight(lum, tonalRange);
      const amt = Math.min(0.85, exposure * w * (0.25 + 0.75 * tw));
      if (amt <= 1e-5) continue;

      let nr: number;
      let ng: number;
      let nb: number;

      if (mode === 'dodge') {
        if (protectTones) {
          // Lift luminance smoothly while scaling RGB proportionally to preserve hue
          const targetLum = Math.min(1, lum + (1 - lum) * amt);
          if (lum > 1e-4) {
            const scale = targetLum / lum;
            nr = Math.min(1, r * scale);
            ng = Math.min(1, g * scale);
            nb = Math.min(1, b * scale);
          } else {
            nr = targetLum;
            ng = targetLum;
            nb = targetLum;
          }
        } else {
          const inv = 1 / Math.max(0.15, 1 - amt);
          nr = Math.min(1, r * inv);
          ng = Math.min(1, g * inv);
          nb = Math.min(1, b * inv);
        }
      } else {
        if (protectTones) {
          const scale = Math.max(0, 1 - amt);
          nr = r * scale;
          ng = g * scale;
          nb = b * scale;
        } else {
          const gamma = 1 + amt * 2.2;
          nr = Math.pow(r, gamma);
          ng = Math.pow(g, gamma);
          nb = Math.pow(b, gamma);
        }
      }

      data[idx] = clamp255(Math.round(nr * 255));
      data[idx + 1] = clamp255(Math.round(ng * 255));
      data[idx + 2] = clamp255(Math.round(nb * 255));
      touched = true;
    }
  }

  if (!touched) return null;
  grid.writeImageData(session.layerId, roi, rx0, ry0, session.targetFormat, true);
  return { x: rx0, y: ry0, width: rw, height: rh };
}

function applyCloneStampDab(
  grid: SparseTileGrid,
  session: RetouchStrokeSession,
  cx: number,
  cy: number,
  radius: number,
  strength: number,
  hardness: number,
  sampleMode: CloneSampleMode
): DirtyRect | null {
  if (!session.cloneOffset) return null;

  const docW = session.dimensions.width;
  const docH = session.dimensions.height;
  const rCeil = Math.max(1, Math.ceil(radius));

  const rx0 = Math.max(0, Math.floor(cx - rCeil));
  const ry0 = Math.max(0, Math.floor(cy - rCeil));
  const rx1 = Math.min(docW, Math.ceil(cx + rCeil));
  const ry1 = Math.min(docH, Math.ceil(cy + rCeil));
  const rw = rx1 - rx0;
  const rh = ry1 - ry0;
  if (rw <= 0 || rh <= 0) return null;

  snapshotRoiTiles(grid, session.layerId, rx0, ry0, rw, rh, session.beforeSnapshot);

  const roi = grid.readImageData(session.layerId, rx0, ry0, rw, rh);
  const data = roi.data;
  const selMask = session.selectionMask;
  const invR = 1 / Math.max(1, radius);
  const alphaLock = session.alphaLock;
  const opacity = clamp01(strength);
  const offX = Math.round(session.cloneOffset.x);
  const offY = Math.round(session.cloneOffset.y);
  const sampleOut: [number, number, number, number] = [0, 0, 0, 0];
  let touched = false;

  for (let ly = 0; ly < rh; ly++) {
    const gy = ry0 + ly;
    const distY = gy + 0.5 - cy;
    const selRow = gy * docW;
    const roiRow = ly * rw;

    for (let lx = 0; lx < rw; lx++) {
      const gx = rx0 + lx;
      const distX = gx + 0.5 - cx;
      const dNorm = Math.hypot(distX, distY) * invR;
      if (dNorm >= 1) continue;

      let w = computeBrushFalloff(dNorm, hardness) * opacity;
      if (selMask) {
        const m = selMask[selRow + gx];
        if (m === 0) continue;
        w *= m / 255;
      }
      if (w <= 1e-4) continue;

      samplePreStrokePixel(grid, session, gx + offX, gy + offY, sampleMode, sampleOut);
      const srcA = sampleOut[3];
      if (srcA === 0) continue;

      const idx = (roiRow + lx) * 4;
      const dstA = data[idx + 3];
      if (alphaLock && dstA === 0) continue;

      const effSrcA = (srcA / 255) * w;
      if (alphaLock) {
        const inv = 1 - effSrcA;
        data[idx] = clamp255(Math.round(data[idx] * inv + sampleOut[0] * effSrcA));
        data[idx + 1] = clamp255(Math.round(data[idx + 1] * inv + sampleOut[1] * effSrcA));
        data[idx + 2] = clamp255(Math.round(data[idx + 2] * inv + sampleOut[2] * effSrcA));
      } else {
        const dstANorm = dstA / 255;
        const outA = effSrcA + dstANorm * (1 - effSrcA);
        if (outA <= 1e-6) continue;
        const invOutA = 1 / outA;
        const r = (sampleOut[0] * effSrcA + data[idx] * dstANorm * (1 - effSrcA)) * invOutA;
        const g = (sampleOut[1] * effSrcA + data[idx + 1] * dstANorm * (1 - effSrcA)) * invOutA;
        const b = (sampleOut[2] * effSrcA + data[idx + 2] * dstANorm * (1 - effSrcA)) * invOutA;
        data[idx] = clamp255(Math.round(r));
        data[idx + 1] = clamp255(Math.round(g));
        data[idx + 2] = clamp255(Math.round(b));
        data[idx + 3] = clamp255(Math.round(outA * 255));
      }
      touched = true;
    }
  }

  if (!touched) return null;
  grid.writeImageData(session.layerId, roi, rx0, ry0, session.targetFormat, true);
  return { x: rx0, y: ry0, width: rw, height: rh };
}

/**
 * Stamps spaced retouch dabs along the segment from `session.lastDabPos` to `targetPt`.
 */
export function applyRetouchStrokeSegment(params: {
  grid: SparseTileGrid;
  session: RetouchStrokeSession;
  pt: Point2D;
  pressure: number;
  settings: RetouchSettings;
  primaryColor: string;
}): DirtyRect | null {
  const { grid, session, pt, pressure, settings, primaryColor } = params;
  const effPressure = settings.usePressure ? Math.max(0.1, Math.min(1, pressure || 1)) : 1;
  const radius = Math.max(1, (settings.size * (0.4 + 0.6 * effPressure)) * 0.5);
  const strength = clamp01((settings.strength / 100) * (0.35 + 0.65 * effPressure));
  const hardness = clamp01(settings.hardness / 100);
  const stepPx = Math.max(1, radius * Math.max(0.05, Math.min(0.5, settings.spacing || 0.15)) * 2);

  const pigmentBlending = Boolean(settings.pigmentBlending);
  const pigmentStrength = clamp01((settings.pigmentStrength ?? 100) / 100);

  const runDab = (dx: number, dy: number): DirtyRect | null => {
    switch (session.mode) {
      case 'smudge':
        return applySmudgeDab(
          grid,
          session,
          dx,
          dy,
          radius,
          strength,
          hardness,
          primaryColor,
          settings.smudgeFingerPainting,
          pigmentBlending,
          pigmentStrength
        );
      case 'blur':
        return applyBlurDab(
          grid,
          session,
          dx,
          dy,
          radius,
          strength,
          hardness,
          pigmentBlending,
          pigmentStrength
        );
      case 'dodge':
      case 'burn':
        return applyDodgeBurnDab(
          grid,
          session,
          session.mode,
          dx,
          dy,
          radius,
          strength,
          hardness,
          settings.tonalRange,
          settings.protectTones
        );
      case 'clone-stamp':
        return applyCloneStampDab(
          grid,
          session,
          dx,
          dy,
          radius,
          strength,
          hardness,
          settings.cloneSampleMode
        );
    }
  };

  let segDirty: DirtyRect | null = null;

  if (!session.lastDabPos) {
    session.lastDabPos = { x: pt.x, y: pt.y };
    session.remainderDist = 0;
    const d = runDab(pt.x, pt.y);
    if (d) {
      segDirty = mergeDirty(segDirty, d);
      session.dirtyRect = mergeDirty(session.dirtyRect, d);
    }
    return segDirty;
  }

  const prev = session.lastDabPos;
  const vx = pt.x - prev.x;
  const vy = pt.y - prev.y;
  const dist = Math.hypot(vx, vy);
  if (dist < 1e-4) return null;

  const ux = vx / dist;
  const uy = vy / dist;
  let traveled = stepPx - session.remainderDist;

  // Guard maximum dabs per pointermove to prevent stalls on sudden jumps
  let dabCount = 0;
  const MAX_DABS_PER_MOVE = 64;
  while (traveled <= dist && dabCount < MAX_DABS_PER_MOVE) {
    const dx = prev.x + ux * traveled;
    const dy = prev.y + uy * traveled;
    const d = runDab(dx, dy);
    if (d) {
      segDirty = mergeDirty(segDirty, d);
      session.dirtyRect = mergeDirty(session.dirtyRect, d);
    }
    traveled += stepPx;
    dabCount++;
  }

  session.remainderDist = Math.max(0, dist - (traveled - stepPx));
  session.lastDabPos = { x: pt.x, y: pt.y };

  return segDirty;
}
