import { CspBrush, BrushSettings } from '../types/editor';

const DB_NAME = 'SoraPaintBrushesDB';
const DB_VERSION = 1;
const STORE_NAME = 'csp_brushes';

// In-memory cache of decoded HTMLImageElements for zero-latency painting
const tipImageCache = new Map<string, HTMLImageElement>();

/**
 * Preloads an image element from a data URL and caches it.
 */
export function preloadTipImage(dataUrl: string): Promise<HTMLImageElement> {
  const cached = tipImageCache.get(dataUrl);
  if (cached && cached.complete) {
    return Promise.resolve(cached);
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
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB is not supported in this environment.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

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
 */
export async function loadCustomBrushes(): Promise<CspBrush[]> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const transaction = db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const brushes: CspBrush[] = request.result || [];
        // Preload all tip images and paper textures in parallel
        for (const b of brushes) {
          if (b.tipDataUrl) {
            preloadTipImage(b.tipDataUrl).catch(() => {});
          }
          if (b.subTips) {
            for (const st of b.subTips) {
              if (st.dataUrl) preloadTipImage(st.dataUrl).catch(() => {});
            }
          }
          if (b.paperTexture) {
            preloadTipImage(b.paperTexture).catch(() => {});
          }
        }
        resolve(brushes);
      };

      request.onerror = () => {
        resolve(loadFromLocalStorageFallback());
      };
    });
  } catch {
    return loadFromLocalStorageFallback();
  }
}

/**
 * Saves or updates a Clip Studio Paint brush in persistent IndexedDB storage.
 */
export async function saveCustomBrush(brush: CspBrush): Promise<void> {
  // Preload image elements into memory immediately
  if (brush.tipDataUrl) {
    preloadTipImage(brush.tipDataUrl).catch(() => {});
  }
  if (brush.subTips) {
    for (const st of brush.subTips) {
      if (st.dataUrl) preloadTipImage(st.dataUrl).catch(() => {});
    }
  }
  if (brush.paperTexture) {
    preloadTipImage(brush.paperTexture).catch(() => {});
  }

  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(brush);

      request.onsuccess = () => {
        syncToLocalStorageFallback(brush);
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    syncToLocalStorageFallback(brush);
  }
}

/**
 * Deletes a Clip Studio Paint brush from persistent storage.
 */
export async function deleteCustomBrush(brushId: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(brushId);

      request.onsuccess = () => {
        removeFromLocalStorageFallback(brushId);
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  } catch {
    removeFromLocalStorageFallback(brushId);
  }
}

// LocalStorage Fallbacks for resilient redundancy
const LS_KEY = 'sora_paint_custom_brushes';

function loadFromLocalStorageFallback(): CspBrush[] {
  try {
    const data = localStorage.getItem(LS_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function syncToLocalStorageFallback(brush: CspBrush) {
  try {
    const current = loadFromLocalStorageFallback().filter((b) => b.id !== brush.id);
    current.push(brush);
    localStorage.setItem(LS_KEY, JSON.stringify(current));
  } catch {
    // LocalStorage quota may be exceeded with large base64 tips
  }
}

function removeFromLocalStorageFallback(brushId: string) {
  try {
    const current = loadFromLocalStorageFallback().filter((b) => b.id !== brushId);
    localStorage.setItem(LS_KEY, JSON.stringify(current));
  } catch {
    // Ignore
  }
}

/**
 * Assembles fully resolved BrushSettings for a Clip Studio Paint brush,
 * ensuring all tips, sub-tips, curves, paper grain textures, and watercolor wet-edges are preloaded.
 */
export async function prepareBrushSettingsForCsp(brush: CspBrush): Promise<Partial<BrushSettings>> {
  let tipImg: HTMLImageElement | undefined = undefined;
  if (brush.tipDataUrl) {
    tipImg =
      getPreloadedTipImage(brush.tipDataUrl) ||
      (await preloadTipImage(brush.tipDataUrl).catch(() => undefined));
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
    opacity: brush.opacity,
    spacing: brush.spacing,
    hardness: brush.hardness,
    thickness: brush.thickness,
    thicknessVertical: brush.thicknessVertical,
    antiAlias: brush.antiAlias,
    stabilization: brush.stabilization,
    customTipDataUrl: brush.tipDataUrl,
    customTipImage: tipImg,
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
    spray: brush.spray,
    taper: brush.taper,
    isRibbon: brush.isRibbon,
    colorMixing: brush.colorMixing,
    amountOfPaint: brush.amountOfPaint ?? 0.7,
    densityOfPaint: brush.densityOfPaint ?? 0.8,
    colorStretch: brush.colorStretch ?? 0.6,
    mixingMode: brush.mixingMode ?? 'blend',
    wetEdge: brush.wetEdge ?? 0,
    wetEdgeRadius: brush.wetEdgeRadius,
    wetEdgeAlphaPower: brush.wetEdgeAlphaPower,
    wetEdgeValuePower: brush.wetEdgeValuePower,
    grain: brush.textureDensity ?? 0,
    paperTexture: brush.paperTexture,
    paperTextureImage,
    paperTextureScale: brush.paperTextureScale,
    paperTextureRotate: brush.paperTextureRotate,
    useGpu: true,
  };
}

