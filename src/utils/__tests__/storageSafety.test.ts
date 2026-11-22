import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CspBrush } from '../../types/editor';
import {
  BRUSH_INDEX_LS_KEY,
  deleteCustomBrush,
  loadCustomBrushes,
  resetBrushStorageCache,
  saveCustomBrush,
} from '../brushStorage';
import {
  RECENT_DOCS_LS_KEY,
  RecentDocument,
  loadRecentDocuments,
  saveRecentDocument,
} from '../recentDocumentsManager';
import {
  SUB_VIEW_STORAGE_KEY,
  hydrateSubViewImages,
  subViewStoreActions,
  useSubViewStore,
} from '../../stores/useSubViewStore';
import { useUiStore, uiStoreActions } from '../../stores/useUiStore';
import { safeLocalStorageSetItem } from '../safeStorage';

function createFakeIndexedDB() {
  const databases = new Map<string, Map<string, Map<string, any>>>();

  const makeRequest = <T,>(exec: () => T) => {
    const req: any = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    queueMicrotask(() => {
      try {
        req.result = exec();
        req.onsuccess?.({ target: req });
      } catch (err) {
        req.error = err;
        req.onerror?.({ target: req });
      }
    });
    return req;
  };

  return {
    open(name: string) {
      const req: any = {
        result: undefined,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => {
        let stores = databases.get(name);
        const isNew = !stores;
        if (!stores) {
          stores = new Map();
          databases.set(name, stores);
        }

        const db: any = {
          objectStoreNames: {
            contains: (storeName: string) => stores!.has(storeName),
          },
          createObjectStore: (storeName: string) => {
            if (!stores!.has(storeName)) stores!.set(storeName, new Map());
            return {
              createIndex: () => {},
            };
          },
          transaction: (storeNames: string | string[]) => {
            const first = Array.isArray(storeNames) ? storeNames[0] : storeNames;
            const tx: any = {
              error: null,
              oncomplete: null,
              onerror: null,
              objectStore: (sName: string = first) => {
                if (!stores!.has(sName)) stores!.set(sName, new Map());
                const map = stores!.get(sName)!;
                return {
                  getAll: () => makeRequest(() => Array.from(map.values()).map((v) => structuredClone(v))),
                  get: (key: string) => makeRequest(() => (map.has(key) ? structuredClone(map.get(key)) : undefined)),
                  put: (val: any) =>
                    makeRequest(() => {
                      map.set(val.id, structuredClone(val));
                      return val.id;
                    }),
                  delete: (key: string) =>
                    makeRequest(() => {
                      map.delete(key);
                    }),
                  clear: () =>
                    makeRequest(() => {
                      map.clear();
                    }),
                };
              },
            };
            // Fire tx.oncomplete after queued store operations finish
            queueMicrotask(() => {
              queueMicrotask(() => {
                tx.oncomplete?.();
              });
            });
            return tx;
          },
        };

        req.result = db;
        if (isNew) {
          req.onupgradeneeded?.({ target: req });
        }
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
}

function createMemoryStorage(options?: { throwQuota?: boolean }): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      if (options?.throwQuota) {
        const err = new Error('Quota exceeded');
        err.name = 'QuotaExceededError';
        throw err;
      }
      store.set(key, String(value));
    },
  };
}

describe('Storage Safety, IndexedDB Migration & QuotaExceededError Handling', () => {
  const prevStorage = (globalThis as Record<string, unknown>).localStorage;
  const prevIndexedDB = (globalThis as Record<string, unknown>).indexedDB;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'indexedDB', {
      value: createFakeIndexedDB(),
      configurable: true,
      writable: true,
    });
    resetBrushStorageCache();
    useSubViewStore.reset();
    uiStoreActions.clearToast();
  });

  afterEach(() => {
    uiStoreActions.clearToast();
    if (prevStorage === undefined) {
      delete (globalThis as Record<string, unknown>).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: prevStorage,
        configurable: true,
        writable: true,
      });
    }
    if (prevIndexedDB === undefined) {
      delete (globalThis as Record<string, unknown>).indexedDB;
    } else {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: prevIndexedDB,
        configurable: true,
        writable: true,
      });
    }
  });

  it('stores custom brush data URLs only in IndexedDB and keeps localStorage lightweight', async () => {
    const heavyTip = 'data:image/png;base64,' + 'A'.repeat(20_000);
    const heavyPaper = 'data:image/png;base64,' + 'B'.repeat(15_000);
    const brush: CspBrush = {
      id: 'csp-heavy-1',
      name: 'Heavy Inker',
      tipDataUrl: heavyTip,
      secondaryTipDataUrl: heavyTip,
      subTips: [{ dataUrl: heavyTip, width: 64, height: 64 }],
      paperTexture: heavyPaper,
      size: 24,
      minSizeFactor: 0.1,
      opacity: 1,
      flow: 1,
      spacing: 0.05,
      hardness: 0.9,
      thickness: 1,
      angle: 0,
      usePressure: true,
      smoothing: true,
      stabilization: 12,
      importedAt: Date.now(),
    };

    await saveCustomBrush(brush);

    const lsRaw = localStorage.getItem(BRUSH_INDEX_LS_KEY) || '';
    expect(lsRaw).toContain('csp-heavy-1');
    expect(lsRaw).not.toContain('data:image/');
    expect(lsRaw.length).toBeLessThan(1000);

    // Reload from IndexedDB after clearing memory cache
    resetBrushStorageCache();
    const loaded = await loadCustomBrushes();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].tipDataUrl).toBe(heavyTip);
    expect(loaded[0].paperTexture).toBe(heavyPaper);
    expect(loaded[0].subTips?.[0].dataUrl).toBe(heavyTip);

    await deleteCustomBrush('csp-heavy-1');
    resetBrushStorageCache();
    expect(await loadCustomBrushes()).toHaveLength(0);
  });

  it('migrates legacy heavy brushes out of localStorage into IndexedDB on load', async () => {
    const legacyTip = 'data:image/png;base64,' + 'Z'.repeat(8000);
    localStorage.setItem(
      BRUSH_INDEX_LS_KEY,
      JSON.stringify([
        {
          id: 'csp-legacy-1',
          name: 'Legacy Pen',
          tipDataUrl: legacyTip,
          size: 12,
          minSizeFactor: 0.2,
          opacity: 1,
          flow: 1,
          spacing: 0.06,
          hardness: 1,
          thickness: 1,
          angle: 0,
          usePressure: true,
          smoothing: true,
          stabilization: 10,
          importedAt: 1000,
        },
      ])
    );

    const loaded = await loadCustomBrushes();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].tipDataUrl).toBe(legacyTip);

    // localStorage must now be purged of data URLs
    const cleanedLs = localStorage.getItem(BRUSH_INDEX_LS_KEY) || '';
    expect(cleanedLs).toContain('csp-legacy-1');
    expect(cleanedLs).not.toContain('data:image/');
  });

  it('stores SubView reference images in IndexedDB, keeping only lightweight metadata in localStorage', async () => {
    const heavyRef = 'data:image/png;base64,' + 'R'.repeat(30_000);
    subViewStoreActions.addImages([
      { id: 'sv-1', name: 'pose_ref.png', src: heavyRef, width: 800, height: 600 },
    ]);

    const lsRaw = localStorage.getItem(SUB_VIEW_STORAGE_KEY) || '';
    expect(lsRaw).toContain('sv-1');
    expect(lsRaw).toContain('pose_ref.png');
    expect(lsRaw).not.toContain('data:image/');
    expect(lsRaw.length).toBeLessThan(500);

    // Let async IDB write settle
    await new Promise((r) => setTimeout(r, 10));

    // Simulate reload: reset store (reads metadata from localStorage), then hydrate images from IDB
    useSubViewStore.reset();
    expect(useSubViewStore.getState().items[0].src).toBe('');

    await hydrateSubViewImages();
    expect(useSubViewStore.getState().items[0].src).toBe(heavyRef);

    // Clearing removes from IDB too
    subViewStoreActions.clearAll();
    await new Promise((r) => setTimeout(r, 10));
    useSubViewStore.reset();
    await hydrateSubViewImages();
    expect(useSubViewStore.getState().items).toHaveLength(0);
  });

  it('keeps recent document thumbnails in IndexedDB and strips coverUrl from localStorage fallback', async () => {
    const heavyThumb = 'data:image/jpeg;base64,' + 'T'.repeat(12_000);
    const doc: RecentDocument = {
      id: 'recent-1',
      title: 'Chapter1.ink',
      path: 'C:\\Art\\Chapter1.ink',
      size: 2_500_000,
      coverUrl: heavyThumb,
      lastOpened: Date.now(),
      isStarred: true,
      isSaved: true,
      fileType: '.ink',
    };

    // Seed legacy localStorage entry with coverUrl to test migration + strip
    localStorage.setItem(RECENT_DOCS_LS_KEY, JSON.stringify([doc]));

    const loaded = await loadRecentDocuments();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].coverUrl).toBe(heavyThumb);

    // localStorage must be stripped of coverUrl
    const lsRaw = localStorage.getItem(RECENT_DOCS_LS_KEY) || '';
    expect(lsRaw).toContain('recent-1');
    expect(lsRaw).not.toContain('data:image/');

    // Also test direct fallback when IndexedDB is unavailable
    delete (globalThis as Record<string, unknown>).indexedDB;
    await saveRecentDocument({
      ...doc,
      id: 'recent-2',
      title: 'Chapter2.ink',
      coverUrl: heavyThumb,
    });
    const fallbackRaw = localStorage.getItem(RECENT_DOCS_LS_KEY) || '';
    expect(fallbackRaw).toContain('recent-2');
    expect(fallbackRaw).not.toContain('data:image/');
  });

  it('handles QuotaExceededError gracefully without throwing and displays a toast notification', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMemoryStorage({ throwQuota: true }),
      configurable: true,
      writable: true,
    });

    expect(useUiStore.getState().toastMessage).toBeNull();

    const ok = safeLocalStorageSetItem('test_key', 'payload', 'Sub View layout');
    expect(ok).toBe(false);

    const toast = useUiStore.getState().toastMessage;
    expect(toast).toBeTruthy();
    expect(toast).toMatch(/storage quota exceeded/i);
    expect(toast).toContain('Sub View layout');
  });
});
