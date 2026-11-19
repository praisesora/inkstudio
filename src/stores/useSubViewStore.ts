import { createStore } from './createStore';
import {
  handleIndexedDbError,
  safeLocalStorageGetItem,
  safeLocalStorageSetItem,
} from '../utils/safeStorage';

export const SUB_VIEW_STORAGE_KEY = 'ink_studio_subview_v1';
const SUB_VIEW_DB_NAME = 'InkStudioSubViewDB';
const SUB_VIEW_DB_VERSION = 1;
const SUB_VIEW_IMAGE_STORE = 'subview_images';

export interface SubViewTransform {
  zoom: number;
  pan: { x: number; y: number };
  rotation: number; // degrees
  flipX: boolean;
}

export interface SubViewImageItem {
  id: string;
  name: string;
  src: string; // data: URL stored in IndexedDB (empty until hydrated or if evicted)
  width: number;
  height: number;
  zoom: number;
  pan: { x: number; y: number };
  rotation: number;
  flipX: boolean;
  /** True until first fit-to-container calculation is performed for this item */
  needsInitialFit?: boolean;
}

export interface SubViewStoreState {
  items: SubViewImageItem[];
  activeId: string | null;
  autoEyedropper: boolean;
  manualEyedropper: boolean;
  showList: boolean;
}

interface PersistedSubViewPayload {
  version: 1;
  activeId: string | null;
  autoEyedropper: boolean;
  showList: boolean;
  items: Array<{
    id: string;
    name: string;
    width: number;
    height: number;
    zoom: number;
    pan: { x: number; y: number };
    rotation: number;
    flipX: boolean;
    needsInitialFit?: boolean;
  }>;
}

interface SubViewImageRecord {
  id: string;
  src: string;
}

export const SUB_VIEW_MIN_ZOOM = 0.05;
export const SUB_VIEW_MAX_ZOOM = 16.0;

function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.max(SUB_VIEW_MIN_ZOOM, Math.min(SUB_VIEW_MAX_ZOOM, z));
}

function isSafeImageSrc(src: unknown): src is string {
  if (typeof src !== 'string' || !src) return false;
  if (src.startsWith('data:image/')) return true;
  if (src.startsWith('blob:')) return false;
  return false;
}

function openSubViewDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb =
      typeof indexedDB !== 'undefined'
        ? indexedDB
        : typeof window !== 'undefined'
          ? window.indexedDB
          : undefined;
    if (!idb) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = idb.open(SUB_VIEW_DB_NAME, SUB_VIEW_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(SUB_VIEW_IMAGE_STORE)) {
        db.createObjectStore(SUB_VIEW_IMAGE_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSubViewImageToIdb(id: string, src: string): Promise<void> {
  if (!id || !isSafeImageSrc(src)) return;
  try {
    const db = await openSubViewDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SUB_VIEW_IMAGE_STORE, 'readwrite');
      const req = tx.objectStore(SUB_VIEW_IMAGE_STORE).put({ id, src } satisfies SubViewImageRecord);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    handleIndexedDbError(err, 'Sub View reference image');
  }
}

export async function deleteSubViewImageFromIdb(id: string): Promise<void> {
  if (!id) return;
  try {
    const db = await openSubViewDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SUB_VIEW_IMAGE_STORE, 'readwrite');
      tx.objectStore(SUB_VIEW_IMAGE_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore delete failures when IDB is unavailable
  }
}

export async function clearSubViewImagesFromIdb(): Promise<void> {
  try {
    const db = await openSubViewDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SUB_VIEW_IMAGE_STORE, 'readwrite');
      tx.objectStore(SUB_VIEW_IMAGE_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore clear failures when IDB is unavailable
  }
}

export async function loadSubViewImagesFromIdb(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const db = await openSubViewDB();
    const records = await new Promise<SubViewImageRecord[]>((resolve, reject) => {
      const tx = db.transaction(SUB_VIEW_IMAGE_STORE, 'readonly');
      const req = tx.objectStore(SUB_VIEW_IMAGE_STORE).getAll();
      req.onsuccess = () => resolve((req.result as SubViewImageRecord[]) || []);
      req.onerror = () => reject(req.error);
    });
    for (const rec of records) {
      if (rec && typeof rec.id === 'string' && isSafeImageSrc(rec.src)) {
        map.set(rec.id, rec.src);
      }
    }
  } catch {
    // IDB unavailable
  }
  return map;
}

export function loadSubViewState(): SubViewStoreState {
  const fallback: SubViewStoreState = {
    items: [],
    activeId: null,
    autoEyedropper: true,
    manualEyedropper: false,
    showList: false,
  };

  try {
    const raw = safeLocalStorageGetItem(SUB_VIEW_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return fallback;

    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const items: SubViewImageItem[] = [];
    const legacyInlineImages: Array<{ id: string; src: string }> = [];
    const seen = new Set<string>();

    for (const entry of rawItems) {
      if (!entry || typeof entry !== 'object') continue;
      const r = entry as Record<string, unknown>;
      const id = typeof r.id === 'string' && r.id.trim() ? r.id : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const name = typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 120) : 'Reference';
      const legacySrc = isSafeImageSrc(r.src) ? r.src : '';
      if (legacySrc) {
        legacyInlineImages.push({ id, src: legacySrc });
      }
      const width = typeof r.width === 'number' && Number.isFinite(r.width) && r.width > 0 ? Math.round(r.width) : 0;
      const height = typeof r.height === 'number' && Number.isFinite(r.height) && r.height > 0 ? Math.round(r.height) : 0;
      const zoom = clampZoom(typeof r.zoom === 'number' ? r.zoom : 1);
      const panRec = r.pan && typeof r.pan === 'object' ? (r.pan as Record<string, unknown>) : null;
      const panX = panRec && typeof panRec.x === 'number' && Number.isFinite(panRec.x) ? panRec.x : 0;
      const panY = panRec && typeof panRec.y === 'number' && Number.isFinite(panRec.y) ? panRec.y : 0;
      const rotation = typeof r.rotation === 'number' && Number.isFinite(r.rotation) ? r.rotation : 0;
      const flipX = Boolean(r.flipX);

      items.push({
        id,
        name,
        src: legacySrc,
        width,
        height,
        zoom,
        pan: { x: panX, y: panY },
        rotation,
        flipX,
        needsInitialFit: typeof r.needsInitialFit === 'boolean' ? r.needsInitialFit : !panX && !panY && zoom === 1,
      });
    }

    const activeId =
      typeof parsed.activeId === 'string' && items.some((i) => i.id === parsed.activeId)
        ? parsed.activeId
        : items[0]?.id ?? null;

    const state: SubViewStoreState = {
      items,
      activeId,
      autoEyedropper: typeof parsed.autoEyedropper === 'boolean' ? parsed.autoEyedropper : true,
      manualEyedropper: false,
      showList: typeof parsed.showList === 'boolean' ? parsed.showList : false,
    };

    // Migrate any legacy inline data URLs out of localStorage into IndexedDB immediately
    if (legacyInlineImages.length > 0) {
      saveSubViewState(state);
      for (const img of legacyInlineImages) {
        void saveSubViewImageToIdb(img.id, img.src);
      }
    }

    return state;
  } catch {
    return fallback;
  }
}

/**
 * Persists only lightweight Sub View metadata and IDs to localStorage.
 * Image data URLs live exclusively in IndexedDB.
 */
export function saveSubViewState(state: SubViewStoreState): void {
  const payload: PersistedSubViewPayload = {
    version: 1,
    activeId: state.activeId,
    autoEyedropper: state.autoEyedropper,
    showList: state.showList,
    items: state.items.map((item) => ({
      id: item.id,
      name: item.name,
      width: item.width,
      height: item.height,
      zoom: item.zoom,
      pan: item.pan,
      rotation: item.rotation,
      flipX: item.flipX,
      needsInitialFit: item.needsInitialFit,
    })),
  };

  safeLocalStorageSetItem(SUB_VIEW_STORAGE_KEY, JSON.stringify(payload), 'Sub View layout');
}

export const useSubViewStore = createStore<SubViewStoreState>(loadSubViewState);

/**
 * Hydrates Sub View item image payloads from IndexedDB into the store.
 */
export async function hydrateSubViewImages(): Promise<void> {
  const imageMap = await loadSubViewImagesFromIdb();
  if (imageMap.size === 0) return;

  useSubViewStore.setState((prev) => {
    let changed = false;
    const nextItems = prev.items.map((item) => {
      if (!item.src) {
        const stored = imageMap.get(item.id);
        if (stored) {
          changed = true;
          return { ...item, src: stored };
        }
      }
      return item;
    });
    return changed ? { items: nextItems } : prev;
  });
}

let subViewIdSeq = 1;
export function createSubViewItemId(): string {
  subViewIdSeq += 1;
  return `sv-${Date.now().toString(36)}-${subViewIdSeq}`;
}

function persist(): void {
  saveSubViewState(useSubViewStore.getState());
}

export const subViewStoreActions = {
  addImages(newItems: Array<{ name: string; src: string; width: number; height: number; id?: string }>): void {
    if (newItems.length === 0) return;
    const prepared: SubViewImageItem[] = newItems.map((item) => ({
      id: item.id || createSubViewItemId(),
      name: item.name.slice(0, 120) || 'Reference',
      src: item.src,
      width: Math.max(1, Math.round(item.width)),
      height: Math.max(1, Math.round(item.height)),
      zoom: 1,
      pan: { x: 0, y: 0 },
      rotation: 0,
      flipX: false,
      needsInitialFit: true,
    }));

    useSubViewStore.setState((prev) => ({
      items: [...prev.items, ...prepared],
      activeId: prepared[prepared.length - 1].id,
    }));
    persist();
    for (const item of prepared) {
      void saveSubViewImageToIdb(item.id, item.src);
    }
  },

  removeImage(id: string): void {
    useSubViewStore.setState((prev) => {
      const idx = prev.items.findIndex((i) => i.id === id);
      if (idx < 0) return prev;
      const nextItems = prev.items.filter((i) => i.id !== id);
      let nextActive = prev.activeId;
      if (prev.activeId === id) {
        const fallbackIdx = Math.min(idx, nextItems.length - 1);
        nextActive = fallbackIdx >= 0 ? nextItems[fallbackIdx].id : null;
      }
      return { items: nextItems, activeId: nextActive };
    });
    persist();
    void deleteSubViewImageFromIdb(id);
  },

  clearAll(): void {
    useSubViewStore.setState({ items: [], activeId: null });
    persist();
    void clearSubViewImagesFromIdb();
  },

  selectImage(id: string): void {
    useSubViewStore.setState((prev) => {
      if (!prev.items.some((i) => i.id === id) || prev.activeId === id) return prev;
      return { activeId: id };
    });
    persist();
  },

  stepActive(delta: -1 | 1): void {
    useSubViewStore.setState((prev) => {
      if (prev.items.length <= 1) return prev;
      const idx = prev.items.findIndex((i) => i.id === prev.activeId);
      const safeIdx = idx < 0 ? 0 : idx;
      const nextIdx = (safeIdx + delta + prev.items.length) % prev.items.length;
      return { activeId: prev.items[nextIdx].id };
    });
    persist();
  },

  updateImageTransform(
    id: string,
    patch: Partial<SubViewTransform> & { needsInitialFit?: boolean },
    shouldPersist = true
  ): void {
    useSubViewStore.setState((prev) => ({
      items: prev.items.map((item) => {
        if (item.id !== id) return item;
        return {
          ...item,
          zoom: patch.zoom !== undefined ? clampZoom(patch.zoom) : item.zoom,
          pan: patch.pan !== undefined ? { x: patch.pan.x, y: patch.pan.y } : item.pan,
          rotation: patch.rotation !== undefined && Number.isFinite(patch.rotation) ? patch.rotation : item.rotation,
          flipX: patch.flipX !== undefined ? patch.flipX : item.flipX,
          needsInitialFit: patch.needsInitialFit !== undefined ? patch.needsInitialFit : item.needsInitialFit,
        };
      }),
    }));
    if (shouldPersist) persist();
  },

  replaceImageSrc(id: string, src: string, width: number, height: number): void {
    useSubViewStore.setState((prev) => ({
      items: prev.items.map((item) =>
        item.id === id
          ? {
              ...item,
              src,
              width: Math.max(1, Math.round(width)),
              height: Math.max(1, Math.round(height)),
              needsInitialFit: true,
            }
          : item
      ),
    }));
    persist();
    void saveSubViewImageToIdb(id, src);
  },

  setAutoEyedropper(enabled: boolean): void {
    useSubViewStore.setState({ autoEyedropper: enabled });
    persist();
  },

  toggleAutoEyedropper(): void {
    useSubViewStore.setState((prev) => ({ autoEyedropper: !prev.autoEyedropper }));
    persist();
  },

  setManualEyedropper(enabled: boolean): void {
    useSubViewStore.setState({ manualEyedropper: enabled });
  },

  toggleShowList(): void {
    useSubViewStore.setState((prev) => ({ showList: !prev.showList }));
    persist();
  },
};
