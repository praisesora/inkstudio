/**
 * Content-addressed brush asset synchronization (tip, dualTip, paperTexture, subTips).
 * Strips inline base64 data URLs and DOM HTMLImageElements from STROKE_START, replacing them
 * with 128-bit content hashes and binary BRUSH_ASSET_DATA transfers verified by hash.
 */

import type { BrushSettings, CspSubTip } from '../types/editor';
import type { BrushAssetRefs, SubTipAssetRef } from '../types/multiplayer';

export const MAX_BRUSH_ASSET_BYTES = 2 * 1024 * 1024; // 2 MB per asset ceiling
export const MAX_CACHED_BRUSH_ASSETS = 128;
export const MAX_SUB_TIPS_PER_BRUSH = 16;

const ALLOWED_MIMES = new Set(['image/png', 'image/webp', 'image/jpeg']);
const HASH_RE = /^[0-9a-f]{32}$/;

export interface BrushAssetRecord {
  hash: string;
  mime: string;
  bytes: Uint8Array;
  image: HTMLImageElement | null;
  objectUrl: string | null;
  ready: boolean;
}

const assetByHash = new Map<string, BrushAssetRecord>();
const hashByDataUrl = new Map<string, string>();
const readyListeners = new Map<string, Set<(img: HTMLImageElement) => void>>();

/**
 * Deterministic, synchronous 128-bit content hash (4 independent mixed FNV-1a/avalanche lanes)
 * encoded as 32 lowercase hex chars. Fast enough for pointerdown without async races.
 */
export function computeBrushAssetHash(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0x9e3779b9;
  let h4 = 0x85ebca6b;

  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    const b = bytes[i];
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ ((b + i) & 0xff), 0x85ebca6b);
    h3 = Math.imul(h3 ^ (b ^ (i >>> 8)), 0xc2b2ae35);
    h4 = Math.imul(h4 ^ ((b * 31 + i) & 0xff), 0x27d4eb2f);
  }

  // Mix length and final avalanche
  h1 ^= len;
  h2 ^= len * 3;
  h3 ^= len * 7;
  h4 ^= len * 13;

  const mix32 = (v: number): number => {
    v ^= v >>> 16;
    v = Math.imul(v, 0x85ebca6b);
    v ^= v >>> 13;
    v = Math.imul(v, 0xc2b2ae35);
    v ^= v >>> 16;
    return v >>> 0;
  };

  return (
    mix32(h1 ^ h3).toString(16).padStart(8, '0') +
    mix32(h2 ^ h4).toString(16).padStart(8, '0') +
    mix32(h3 ^ h2).toString(16).padStart(8, '0') +
    mix32(h4 ^ h1).toString(16).padStart(8, '0')
  );
}

export function isValidBrushAssetHash(hash: unknown): hash is string {
  return typeof hash === 'string' && HASH_RE.test(hash);
}

export function isAllowedBrushAssetMime(mime: unknown): mime is string {
  return typeof mime === 'string' && ALLOWED_MIMES.has(mime);
}

function decodeBase64ToBytes(b64: string): Uint8Array | null {
  try {
    if (typeof atob !== 'function') return null;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function parseImageDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  if (!dataUrl.startsWith('data:')) return null;
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx <= 5) return null;
  const meta = dataUrl.slice(5, commaIdx);
  if (!meta.endsWith(';base64')) return null;
  const mime = meta.slice(0, -7).toLowerCase();
  if (!ALLOWED_MIMES.has(mime)) return null;
  const b64 = dataUrl.slice(commaIdx + 1);
  // Rough pre-check before decoding to avoid allocating huge buffers
  if (b64.length * 0.76 > MAX_BRUSH_ASSET_BYTES + 16) return null;
  const bytes = decodeBase64ToBytes(b64);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_BRUSH_ASSET_BYTES) {
    return null;
  }
  return { mime, bytes };
}

function evictIfNeeded(): void {
  while (assetByHash.size >= MAX_CACHED_BRUSH_ASSETS) {
    const oldestKey = assetByHash.keys().next().value;
    if (!oldestKey) break;
    const evicted = assetByHash.get(oldestKey);
    assetByHash.delete(oldestKey);
    if (evicted?.objectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(evicted.objectUrl);
      } catch {
        // ignore revoke errors
      }
    }
  }
}

function notifyAssetReady(hash: string, img: HTMLImageElement): void {
  const listeners = readyListeners.get(hash);
  if (!listeners || listeners.size === 0) return;
  for (const cb of listeners) {
    try {
      cb(img);
    } catch {
      // isolate callback failures
    }
  }
  readyListeners.delete(hash);
}

function decodeAssetImage(record: BrushAssetRecord, existingImage?: HTMLImageElement): void {
  if (existingImage && existingImage.complete && (existingImage.naturalWidth || existingImage.width) > 0) {
    record.image = existingImage;
    record.ready = true;
    notifyAssetReady(record.hash, existingImage);
    return;
  }
  if (typeof Image === 'undefined') return;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  const markReady = () => {
    if ((img.naturalWidth || img.width) > 0) {
      record.image = img;
      record.ready = true;
      notifyAssetReady(record.hash, img);
    }
  };
  img.onload = markReady;

  if (
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  ) {
    const blobBytes = new Uint8Array(record.bytes.byteLength);
    blobBytes.set(record.bytes);
    const blob = new Blob([blobBytes], { type: record.mime });
    const objUrl = URL.createObjectURL(blob);
    record.objectUrl = objUrl;
    img.src = objUrl;
  } else {
    return;
  }

  record.image = img;
  if (typeof img.decode === 'function') {
    img.decode().then(markReady).catch(() => {});
  }
}

function registerLocalDataUrl(
  dataUrl: string | undefined,
  existingImage?: HTMLImageElement
): BrushAssetRecord | null {
  if (!dataUrl) return null;
  const cachedHash = hashByDataUrl.get(dataUrl);
  if (cachedHash) {
    const existing = assetByHash.get(cachedHash);
    if (existing) {
      if (!existing.ready && existingImage?.complete && (existingImage.naturalWidth || existingImage.width) > 0) {
        existing.image = existingImage;
        existing.ready = true;
      }
      return existing;
    }
  }

  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) return null;

  const hash = computeBrushAssetHash(parsed.bytes);
  hashByDataUrl.set(dataUrl, hash);

  const existing = assetByHash.get(hash);
  if (existing) return existing;

  evictIfNeeded();
  const record: BrushAssetRecord = {
    hash,
    mime: parsed.mime,
    bytes: parsed.bytes,
    image: null,
    objectUrl: null,
    ready: false,
  };
  assetByHash.set(hash, record);
  decodeAssetImage(record, existingImage);
  return record;
}

/**
 * Strips inline base64 URLs and non-serializable HTMLImageElements from BrushSettings,
 * returning compact hash references and the unique binary asset records for transport.
 */
export function prepareBrushSettingsForWire(bs: BrushSettings): {
  wireSettings: BrushSettings;
  assetRefs?: BrushAssetRefs;
  assets: BrushAssetRecord[];
} {
  const assetsByHash = new Map<string, BrushAssetRecord>();
  const refs: BrushAssetRefs = {};

  const tipRec = registerLocalDataUrl(bs.customTipDataUrl, bs.customTipImage);
  if (tipRec) {
    refs.tipHash = tipRec.hash;
    assetsByHash.set(tipRec.hash, tipRec);
  }

  const dualRec = registerLocalDataUrl(bs.dualTipDataUrl, bs.dualTipImage);
  if (dualRec) {
    refs.dualTipHash = dualRec.hash;
    assetsByHash.set(dualRec.hash, dualRec);
  }

  const paperRec = registerLocalDataUrl(bs.paperTexture, bs.paperTextureImage);
  if (paperRec) {
    refs.paperTextureHash = paperRec.hash;
    assetsByHash.set(paperRec.hash, paperRec);
  }

  if (bs.subTips && bs.subTips.length > 0) {
    const subRefs: SubTipAssetRef[] = [];
    const limit = Math.min(bs.subTips.length, MAX_SUB_TIPS_PER_BRUSH);
    for (let i = 0; i < limit; i++) {
      const st = bs.subTips[i];
      const rec = registerLocalDataUrl(st.dataUrl, bs.subTipImages?.[i]);
      if (rec) {
        subRefs.push({
          hash: rec.hash,
          width: st.width,
          height: st.height,
          isColor: st.isColor,
        });
        assetsByHash.set(rec.hash, rec);
      }
    }
    if (subRefs.length > 0) {
      refs.subTipHashes = subRefs;
    }
  }

  const {
    customTipDataUrl: _tipUrl,
    customTipImage: _tipImg,
    dualTipDataUrl: _dualUrl,
    dualTipImage: _dualImg,
    paperTexture: _paperUrl,
    paperTextureImage: _paperImg,
    subTips: _subTips,
    subTipImages: _subImgs,
    ...clean
  } = bs;

  const hasRefs = Boolean(
    refs.tipHash || refs.dualTipHash || refs.paperTextureHash || refs.subTipHashes?.length
  );

  return {
    wireSettings: clean as BrushSettings,
    assetRefs: hasRefs ? refs : undefined,
    assets: Array.from(assetsByHash.values()),
  };
}

/**
 * Verifies hash integrity and registers a binary brush asset received from a remote peer.
 */
export function registerRemoteBrushAsset(
  hash: string,
  mime: string,
  bytes: Uint8Array
): boolean {
  if (!isValidBrushAssetHash(hash)) return false;
  if (!isAllowedBrushAssetMime(mime)) return false;
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_BRUSH_ASSET_BYTES) {
    return false;
  }

  const actualHash = computeBrushAssetHash(bytes);
  if (actualHash !== hash) {
    return false;
  }

  const existing = assetByHash.get(hash);
  if (existing) {
    if (!existing.ready && !existing.image) {
      decodeAssetImage(existing);
    }
    return true;
  }

  evictIfNeeded();
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);

  const record: BrushAssetRecord = {
    hash,
    mime,
    bytes: ownedBytes,
    image: null,
    objectUrl: null,
    ready: false,
  };
  assetByHash.set(hash, record);
  decodeAssetImage(record);
  return true;
}

export function getBrushAssetRecord(hash: string): BrushAssetRecord | null {
  if (!isValidBrushAssetHash(hash)) return null;
  return assetByHash.get(hash) ?? null;
}

export function getReadyBrushAssetImage(hash?: string): HTMLImageElement | null {
  if (!hash || !isValidBrushAssetHash(hash)) return null;
  const rec = assetByHash.get(hash);
  if (!rec || !rec.ready || !rec.image) return null;
  return rec.image;
}

export function onBrushAssetReady(
  hash: string,
  cb: (img: HTMLImageElement) => void
): () => void {
  if (!isValidBrushAssetHash(hash)) return () => {};
  const existing = assetByHash.get(hash);
  if (existing?.ready && existing.image) {
    cb(existing.image);
    return () => {};
  }
  let set = readyListeners.get(hash);
  if (!set) {
    set = new Set();
    readyListeners.set(hash, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
    if (set && set.size === 0) {
      readyListeners.delete(hash);
    }
  };
}

/**
 * Hydrates a remote BrushSettings object with decoded HTMLImageElements from the hash cache.
 * Returns lists of missing hashes (need BRUSH_ASSET_REQUEST) and pending hashes (still decoding).
 */
export function hydrateBrushSettingsFromHashes(
  bs: BrushSettings,
  refs?: BrushAssetRefs
): {
  hydrated: BrushSettings;
  missingHashes: string[];
  pendingHashes: string[];
} {
  if (!refs) {
    return { hydrated: bs, missingHashes: [], pendingHashes: [] };
  }

  const missingSet = new Set<string>();
  const pendingSet = new Set<string>();
  const hydrated: BrushSettings = { ...bs };

  const resolveHash = (hash?: string): HTMLImageElement | undefined => {
    if (!hash || !isValidBrushAssetHash(hash)) return undefined;
    const rec = assetByHash.get(hash);
    if (!rec) {
      missingSet.add(hash);
      return undefined;
    }
    if (!rec.ready || !rec.image) {
      pendingSet.add(hash);
      return undefined;
    }
    return rec.image;
  };

  if (refs.tipHash) {
    hydrated.customTipImage = resolveHash(refs.tipHash);
  }
  if (refs.dualTipHash) {
    hydrated.dualTipImage = resolveHash(refs.dualTipHash);
  }
  if (refs.paperTextureHash) {
    hydrated.paperTextureImage = resolveHash(refs.paperTextureHash);
  }
  if (refs.subTipHashes && refs.subTipHashes.length > 0) {
    const subImages: HTMLImageElement[] = [];
    const subTips: CspSubTip[] = [];
    let allReady = true;
    for (const ref of refs.subTipHashes) {
      const img = resolveHash(ref.hash);
      if (!img) {
        allReady = false;
      } else {
        subImages.push(img);
        subTips.push({
          dataUrl: '',
          width: ref.width,
          height: ref.height,
          isColor: ref.isColor,
        });
      }
    }
    if (allReady && subImages.length > 0) {
      hydrated.subTipImages = subImages;
      hydrated.subTips = subTips;
    }
  }

  return {
    hydrated,
    missingHashes: Array.from(missingSet),
    pendingHashes: Array.from(pendingSet),
  };
}

export function sanitizeBrushAssetRefs(raw: unknown): BrushAssetRefs | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as BrushAssetRefs;
  const out: BrushAssetRefs = {};
  if (isValidBrushAssetHash(r.tipHash)) out.tipHash = r.tipHash;
  if (isValidBrushAssetHash(r.dualTipHash)) out.dualTipHash = r.dualTipHash;
  if (isValidBrushAssetHash(r.paperTextureHash)) out.paperTextureHash = r.paperTextureHash;
  if (Array.isArray(r.subTipHashes)) {
    const list: SubTipAssetRef[] = [];
    const limit = Math.min(r.subTipHashes.length, MAX_SUB_TIPS_PER_BRUSH);
    for (let i = 0; i < limit; i++) {
      const item = r.subTipHashes[i];
      if (!item || typeof item !== 'object' || !isValidBrushAssetHash(item.hash)) continue;
      const w = Number.isFinite(item.width) ? Math.max(1, Math.min(2048, Math.round(item.width))) : 64;
      const h = Number.isFinite(item.height) ? Math.max(1, Math.min(2048, Math.round(item.height))) : 64;
      list.push({ hash: item.hash, width: w, height: h, isColor: Boolean(item.isColor) });
    }
    if (list.length > 0) out.subTipHashes = list;
  }
  return out.tipHash || out.dualTipHash || out.paperTextureHash || out.subTipHashes
    ? out
    : undefined;
}

export function resetBrushAssetCache(): void {
  for (const rec of assetByHash.values()) {
    if (rec.objectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(rec.objectUrl);
      } catch {
        // ignore
      }
    }
  }
  assetByHash.clear();
  hashByDataUrl.clear();
  readyListeners.clear();
}
