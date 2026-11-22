import { CspBrush, BrushSettings } from '../types/editor';
import {
  handleIndexedDbError,
  safeLocalStorageGetItem,
  safeLocalStorageSetItem,
} from './safeStorage';

const DB_NAME = 'InkStudioBrushesDB';
const DB_VERSION = 1;
const STORE_NAME = 'csp_brushes';
export const BRUSH_INDEX_LS_KEY = 'ink_studio_custom_brushes';

export const CUSTOM_BRUSHES_CHANGED_EVENT = 'ink-custom-brushes-changed';

// In-memory cache of decoded HTMLImageElements for zero-latency painting
const tipImageCache = new Map<string, HTMLImageElement>();

// In-memory registry of loaded custom brushes so tool switches (E -> B) never lose .sut presets
let _cachedCustomBrushes: CspBrush[] = [];
let _hasLoadedCustomBrushes = false;
const _debouncedBrushSaves = new Map<string, ReturnType<typeof setTimeout>>();

function emitCustomBrushesChanged(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(CUSTOM_BRUSHES_CHANGED_EVENT));
  }
}

function hasHeavyBrushAssets(brush: CspBrush): boolean {
  return Boolean(
    brush.tipDataUrl ||
    brush.secondaryTipDataUrl ||
    brush.paperTexture ||
    (brush.subTips && brush.subTips.length > 0)
  );
}

/**
 * Strips heavy base64 data URLs so only lightweight settings/IDs ever touch localStorage.
 */
function stripHeavyBrushAssets(brush: CspBrush): CspBrush {
  const {
    tipDataUrl: _tip,
    secondaryTipDataUrl: _sec,
    subTips: _subs,
    paperTexture: _tex,
    ...lightweight
  } = brush;
  return lightweight;
}

function preloadAllBrushAssets(brush: CspBrush): void {
  if (brush.tipDataUrl) {
    preloadTipImage(brush.tipDataUrl).catch(() => {});
  }
  if (brush.secondaryTipDataUrl) {
    preloadTipImage(brush.secondaryTipDataUrl).catch(() => {});
  }
  if (brush.subTips) {
    for (const st of brush.subTips) {
      if (st.dataUrl) preloadTipImage(st.dataUrl).catch(() => {});
    }
  }
  if (brush.paperTexture) {
    preloadTipImage(brush.paperTexture).catch(() => {});
  }
}

/**
 * Synchronous accessor for cached custom brushes.
 */
export function getCachedCustomBrushes(): CspBrush[] {
  if (!_hasLoadedCustomBrushes) {
    const fallback = loadLightweightIndexFromLocalStorage();
    if (fallback.length > 0) {
      _cachedCustomBrushes = fallback;
      _hasLoadedCustomBrushes = true;
    }
  }
  return _cachedCustomBrushes;
}

/**
 * Resets in-memory brush cache (intended for unit tests).
 */
export function resetBrushStorageCache(): void {
  for (const timer of _debouncedBrushSaves.values()) {
    clearTimeout(timer);
  }
  _debouncedBrushSaves.clear();
  _cachedCustomBrushes = [];
  _hasLoadedCustomBrushes = false;
}

/**
 * Preloads an image element from a data URL and caches it.
 */
export function preloadTipImage(dataUrl: string): Promise<HTMLImageElement> {
  const cached = tipImageCache.get(dataUrl);
  if (cached && cached.complete) {
    return Promise.resolve(cached);
  }
  if (typeof Image === 'undefined') {
    return Promise.reject(new Error('Image constructor unavailable'));
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      tipImageCache.set(dataUrl, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * Synchronous getter for already preloaded tip image.
 */
export function getPreloadedTipImage(dataUrl?: string): HTMLImageElement | null {
  if (!dataUrl) return null;
  return tipImageCache.get(dataUrl) || null;
}

/**
 * Opens or initializes the IndexedDB database.
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb =
      typeof indexedDB !== 'undefined'
        ? indexedDB
        : typeof window !== 'undefined'
          ? window.indexedDB
          : undefined;
    if (!idb) {
      reject(new Error('IndexedDB is not supported in this environment.'));
      return;
    }

    const request = idb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e: IDBVersionChangeEvent) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Loads all imported Clip Studio Paint brushes from persistent IndexedDB storage.
 * Automatically migrates any legacy heavy brush payloads out of localStorage into IndexedDB.
 */
export async function loadCustomBrushes(): Promise<CspBrush[]> {
  const rawLegacy = loadRawFromLocalStorage();
  const hasLegacyHeavy = rawLegacy.some(hasHeavyBrushAssets);

  try {
    const db = await openDB();
    const idbBrushes = await new Promise<CspBrush[]>((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve((request.result as CspBrush[]) || []);
      request.onerror = () => reject(request.error);
    });

    const byId = new Map<string, CspBrush>();
    for (const b of idbBrushes) {
      byId.set(b.id, b);
    }

    // Migrate any legacy brushes that still exist only in localStorage into IndexedDB
    const toMigrate: CspBrush[] = [];
    for (const legacy of rawLegacy) {
      if (!byId.has(legacy.id)) {
        byId.set(legacy.id, legacy);
        toMigrate.push(legacy);
      }
    }

    if (toMigrate.length > 0) {
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction([STORE_NAME], 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          for (const b of toMigrate) {
            store.put(b);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (err) {
        handleIndexedDbError(err, 'custom brush migration');
      }
    }

    const brushes = Array.from(byId.values());
    if (hasLegacyHeavy || toMigrate.length > 0) {
      writeLightweightIndexToLocalStorage(brushes);
    }

    _cachedCustomBrushes = brushes;
    _hasLoadedCustomBrushes = true;
    for (const b of brushes) {
      preloadAllBrushAssets(b);
    }
    return brushes;
  } catch {
    // Strip heavy data URLs from localStorage even if IDB is unavailable
    if (hasLegacyHeavy) {
      writeLightweightIndexToLocalStorage(rawLegacy);
    }
    if (_cachedCustomBrushes.length > 0) {
      _hasLoadedCustomBrushes = true;
      return _cachedCustomBrushes;
    }
    const fallback = rawLegacy.map(stripHeavyBrushAssets);
    _cachedCustomBrushes = fallback;
    _hasLoadedCustomBrushes = true;
    return fallback;
  }
}

/**
 * Saves or updates a Clip Studio Paint brush in persistent IndexedDB storage.
 * Only lightweight metadata/IDs are mirrored to localStorage (never tip/texture data URLs).
 */
export async function saveCustomBrush(brush: CspBrush): Promise<void> {
  preloadAllBrushAssets(brush);
  const existingIdx = _cachedCustomBrushes.findIndex((b) => b.id === brush.id);
  if (existingIdx >= 0) {
    _cachedCustomBrushes = [
      ..._cachedCustomBrushes.slice(0, existingIdx),
      brush,
      ..._cachedCustomBrushes.slice(existingIdx + 1),
    ];
  } else {
    _cachedCustomBrushes = [..._cachedCustomBrushes, brush];
  }
  _hasLoadedCustomBrushes = true;

  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(brush);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } catch (err) {
    handleIndexedDbError(err, `custom brush "${brush.name}"`);
  }

  syncLightweightIndexToLocalStorage(brush);
  emitCustomBrushesChanged();
}

/**
 * Debounced variant of saveCustomBrush so live slider drags do not serialize Base64 blobs at 240Hz.
 */
export function saveCustomBrushDebounced(brush: CspBrush, delayMs: number = 350): void {
  const existingIdx = _cachedCustomBrushes.findIndex((b) => b.id === brush.id);
  if (existingIdx >= 0) {
    _cachedCustomBrushes[existingIdx] = brush;
  } else {
    _cachedCustomBrushes.push(brush);
  }
  _hasLoadedCustomBrushes = true;

  const prevTimer = _debouncedBrushSaves.get(brush.id);
  if (prevTimer) clearTimeout(prevTimer);

  const timer = setTimeout(() => {
    _debouncedBrushSaves.delete(brush.id);
    saveCustomBrush(brush).catch(() => {});
  }, delayMs);
  _debouncedBrushSaves.set(brush.id, timer);
}

/**
 * Deletes a Clip Studio Paint brush from persistent storage.
 */
export async function deleteCustomBrush(brushId: string): Promise<void> {
  const pending = _debouncedBrushSaves.get(brushId);
  if (pending) {
    clearTimeout(pending);
    _debouncedBrushSaves.delete(brushId);
  }
  _cachedCustomBrushes = _cachedCustomBrushes.filter((b) => b.id !== brushId);

  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(brushId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Ignore IDB failure during delete
  }
  removeFromLightweightIndex(brushId);
  emitCustomBrushesChanged();
}

function loadRawFromLocalStorage(): CspBrush[] {
  try {
    const data = safeLocalStorageGetItem(BRUSH_INDEX_LS_KEY);
    if (!data) return [];
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadLightweightIndexFromLocalStorage(): CspBrush[] {
  return loadRawFromLocalStorage().map(stripHeavyBrushAssets);
}

function writeLightweightIndexToLocalStorage(brushes: CspBrush[]): void {
  const lightweight = brushes.map(stripHeavyBrushAssets);
  safeLocalStorageSetItem(BRUSH_INDEX_LS_KEY, JSON.stringify(lightweight), 'custom brush list');
}

function syncLightweightIndexToLocalStorage(brush: CspBrush): void {
  const current = loadLightweightIndexFromLocalStorage().filter((b) => b.id !== brush.id);
  current.push(stripHeavyBrushAssets(brush));
  safeLocalStorageSetItem(BRUSH_INDEX_LS_KEY, JSON.stringify(current), 'custom brush list');
}

function removeFromLightweightIndex(brushId: string): void {
  const current = loadLightweightIndexFromLocalStorage().filter((b) => b.id !== brushId);
  safeLocalStorageSetItem(BRUSH_INDEX_LS_KEY, JSON.stringify(current), 'custom brush list');
}

/**
 * Assembles fully resolved BrushSettings for a Clip Studio Paint brush,
 * ensuring all tips, dual-tips, sub-tips, curves, paper grain textures, and watercolor wet-edges are preloaded.
 */
export async function prepareBrushSettingsForCsp(brush: CspBrush): Promise<Partial<BrushSettings>> {
  let tipImg: HTMLImageElement | undefined = undefined;
  if (brush.tipDataUrl) {
    tipImg =
      getPreloadedTipImage(brush.tipDataUrl) ||
      (await preloadTipImage(brush.tipDataUrl).catch(() => undefined));
  }

  let dualTipImg: HTMLImageElement | undefined = undefined;
  if (brush.secondaryTipDataUrl) {
    dualTipImg =
      getPreloadedTipImage(brush.secondaryTipDataUrl) ||
      (await preloadTipImage(brush.secondaryTipDataUrl).catch(() => undefined));
  }

  let subTipImages: HTMLImageElement[] | undefined = undefined;
  if (brush.subTips && brush.subTips.length > 0) {
    subTipImages = [];
    for (const st of brush.subTips) {
      const img =
        getPreloadedTipImage(st.dataUrl) ||
        (await preloadTipImage(st.dataUrl).catch(() => undefined));
      if (img) subTipImages.push(img);
    }
  }

  let paperTextureImage: HTMLImageElement | undefined = undefined;
  if (brush.paperTexture) {
    paperTextureImage =
      getPreloadedTipImage(brush.paperTexture) ||
      (await preloadTipImage(brush.paperTexture).catch(() => undefined));
  }

  return {
    preset: brush.id,
    brushName: brush.name,
    size: brush.size,
    minSizeFactor: brush.minSizeFactor,
    flow: brush.flow,
    brushDensity: brush.brushDensity,
    adjustDensityByGap: brush.adjustDensityByGap,
    blendTipsMode: brush.blendTipsMode,
    brushCombineMode: brush.brushCombineMode,
    opacity: brush.opacity,
    spacing: brush.spacing,
    hardness: brush.hardness,
    thickness: brush.thickness,
    thicknessVertical: brush.thicknessVertical,
    antiAlias: brush.antiAlias,
    stabilization: brush.stabilization,
    postCorrection: brush.postCorrection,
    sharpCorners: brush.sharpCorners ?? true,
    smoothing: brush.smoothing ?? true,
    customTipDataUrl: brush.tipDataUrl,
    customTipImage: tipImg,
    isColorTip: brush.isColorTip,
    flipH: brush.flipH,
    flipV: brush.flipV,
    customTipAngle: brush.angle,
    customTipAngleDynamics: brush.angleDynamics,
    customTipRotationRandomScale: brush.rotationRandomScale,
    subTips: brush.subTips,
    subTipOrder: brush.subTipOrder,
    subTipImages,
    pressureCurve: brush.pressureCurve,
    velocityCurve: brush.velocityCurve,
    usePressure: brush.usePressure,
    useVelocity: brush.useVelocity,
    useTilt: brush.useTilt ?? false,
    tiltScale: brush.tiltScale,
    sizeSensor: brush.sizeSensor,
    opacitySensor: brush.opacitySensor,
    densitySensor: brush.densitySensor,
    bristleSplaySensor: brush.bristleSplaySensor,
    paintLoadSensor: brush.paintLoadSensor,
    grainPenetrationSensor: brush.grainPenetrationSensor,
    angleSensor: brush.angleSensor,
    scatterSensor: brush.scatterSensor,
    spray: brush.spray,
    taper: brush.taper,
    isRibbon: brush.isRibbon,
    colorMixing: brush.colorMixing,
    perceptualMixing: brush.perceptualMixing ?? true,
    amountOfPaint: brush.amountOfPaint ?? 0.7,
    densityOfPaint: brush.densityOfPaint ?? 0.8,
    colorStretch: brush.colorStretch ?? 0.6,
    mixingMode: brush.mixingMode ?? 'blend',
    wetEdge: brush.wetEdge ?? 0,
    wetEdgeRadius: brush.wetEdgeRadius,
    wetEdgeAlphaPower: brush.wetEdgeAlphaPower,
    wetEdgeValuePower: brush.wetEdgeValuePower,
    grain: brush.textureDensity ?? 0,
    textureDensity: brush.textureDensity,
    paperTexture: brush.paperTexture,
    paperTextureImage,
    surfaceTextureId: brush.surfaceTextureId,
    grainMappingMode: brush.grainMappingMode,
    paperTextureScale: brush.paperTextureScale,
    paperTextureRotate: brush.paperTextureRotate,
    paperTextureMode: brush.paperTextureMode,
    paperTextureBrightness: brush.paperTextureBrightness,
    paperTextureContrast: brush.paperTextureContrast,
    paperTextureApplyEachPlot: brush.paperTextureApplyEachPlot,
    paperTextureInverted: brush.paperTextureInverted,
    dualBrush: brush.dualBrush,
    dualTipDataUrl: brush.secondaryTipDataUrl,
    dualTipImage: dualTipImg,
    dualBrushCompositeMode: (brush.dualBrushCompositeMode as BrushSettings['dualBrushCompositeMode']) || 'multiply',
    dualSize: brush.dualSize,
    dualSpacing: brush.dualSpacing,
    dualScatter: brush.dualScatter,
    dualAngle: brush.dualAngle,
    dualScale: brush.dualScale,
    dualSurfaceTextureId: brush.dualSurfaceTextureId,
    dualGrainDepth: brush.dualGrainDepth,
    dynamics: brush.dynamics,
    renderMode: brush.renderMode,
    bristle: brush.bristle,
    naturalPaint: brush.naturalPaint,
    impasto: brush.impasto,
    useGpu: true,
  };
}
