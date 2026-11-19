import { createStore } from './createStore';

export const SUB_VIEW_STORAGE_KEY = 'ink_studio_subview_v1';
const MAX_PERSISTED_SRC_CHARS = 380_000;
const MAX_TOTAL_PERSISTED_CHARS = 1_500_000;

export interface SubViewTransform {
  zoom: number;
  pan: { x: number; y: number };
  rotation: number; // degrees
  flipX: boolean;
}

export interface SubViewImageItem {
  id: string;
  name: string;
  src: string; // data: URL or safe same-origin URL (may be empty if evicted from storage on reload)
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
    src?: string;
    width: number;
    height: number;
    zoom: number;
    pan: { x: number; y: number };
    rotation: number;
    flipX: boolean;
    needsInitialFit?: boolean;
  }>;
}

export const SUB_VIEW_MIN_ZOOM = 0.05;
export const SUB_VIEW_MAX_ZOOM = 16.0;

function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.max(SUB_VIEW_MIN_ZOOM, Math.min(SUB_VIEW_MAX_ZOOM, z));
}

function isSafeImageSrc(src: unknown): src is string {
  if (typeof src !== 'string' || !src) return false;
  // Allow data:image/* (never data:image/svg+xml script vectors when loading raw strings unless standard)
  // and safe local/blob/https URLs
  if (src.startsWith('data:image/')) return true;
  if (src.startsWith('blob:')) return false; // blob URLs do not survive reload
  return false;
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
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(SUB_VIEW_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return fallback;

    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const items: SubViewImageItem[] = [];
    const seen = new Set<string>();

    for (const entry of rawItems) {
      if (!entry || typeof entry !== 'object') continue;
      const r = entry as Record<string, unknown>;
      const id = typeof r.id === 'string' && r.id.trim() ? r.id : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const name = typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 120) : 'Reference';
      const src = isSafeImageSrc(r.src) ? r.src : '';
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
        src,
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

    return {
      items,
      activeId,
      autoEyedropper: typeof parsed.autoEyedropper === 'boolean' ? parsed.autoEyedropper : true,
      manualEyedropper: false,
      showList: typeof parsed.showList === 'boolean' ? parsed.showList : false,
    };
  } catch {
    return fallback;
  }
}

export function saveSubViewState(state: SubViewStoreState): void {
  try {
    if (typeof localStorage === 'undefined') return;

    let budget = MAX_TOTAL_PERSISTED_CHARS;
    const serializedItems = state.items.map((item) => {
      let persistedSrc: string | undefined;
      if (
        item.src.startsWith('data:image/') &&
        item.src.length <= MAX_PERSISTED_SRC_CHARS &&
        item.src.length <= budget
      ) {
        persistedSrc = item.src;
        budget -= item.src.length;
      }
      return {
        id: item.id,
        name: item.name,
        ...(persistedSrc ? { src: persistedSrc } : {}),
        width: item.width,
        height: item.height,
        zoom: item.zoom,
        pan: item.pan,
        rotation: item.rotation,
        flipX: item.flipX,
        needsInitialFit: item.needsInitialFit,
      };
    });

    const payload: PersistedSubViewPayload = {
      version: 1,
      activeId: state.activeId,
      autoEyedropper: state.autoEyedropper,
      showList: state.showList,
      items: serializedItems,
    };

    try {
      localStorage.setItem(SUB_VIEW_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // QuotaExceeded fallback: persist metadata without inline image payloads
      const metadataOnly: PersistedSubViewPayload = {
        ...payload,
        items: payload.items.map(({ src: _omit, ...rest }) => rest),
      };
      localStorage.setItem(SUB_VIEW_STORAGE_KEY, JSON.stringify(metadataOnly));
    }
  } catch {
    // Ignore storage access errors
  }
}

export const useSubViewStore = createStore<SubViewStoreState>(loadSubViewState);

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
  },

  clearAll(): void {
    useSubViewStore.setState({ items: [], activeId: null });
    persist();
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
