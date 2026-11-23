// Recent & Starred Documents Manager with IndexedDB persistence and disk removal
import {
  handleIndexedDbError,
  safeLocalStorageGetItem,
  safeLocalStorageSetItem,
} from './safeStorage';

export interface FileSystemFileHandleLike {
  name: string;
  getFile: () => Promise<File>;
  createWritable?: () => Promise<FileSystemWritableFileStream>;
  queryPermission?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<'granted' | 'denied' | 'prompt'>;
}

export interface RecentDocument {
  id: string;
  title: string;
  path: string;
  size: number; // in bytes
  coverUrl?: string;
  lastOpened: number; // unix timestamp ms
  isStarred: boolean;
  fileType?: string;
  isSaved?: boolean;
  handle?: FileSystemFileHandleLike;
}

const DB_NAME = 'InkStudioRecentDocsDB';
const DB_VERSION = 1;
const STORE_NAME = 'recent_documents';
export const RECENT_DOCS_LS_KEY = 'inkstudio_recent_docs_backup';

export function isActualSavedDocument(doc: RecentDocument): boolean {
  if (!doc) return false;
  if (doc.isSaved === false) return false;
  // Purge legacy sample documents
  if (doc.id.startsWith('sample-doc-')) return false;
  // Purge unsaved dummy canvases generated on canvas creation
  if (doc.size === 524288) return false;
  // Purge unsaved documents with asterisk indicator
  if (doc.title?.endsWith('*')) return false;
  // If explicitly flagged as saved to PC
  if (doc.isSaved === true) return true;
  // Purge legacy records that used dummy relative paths without being explicitly saved
  if (doc.path?.startsWith('InkStudio\\') && doc.size <= 524288) return false;
  return true;
}

/**
 * Strips heavy coverUrl thumbnails and non-JSON-serializable handles so localStorage
 * only ever stores lightweight metadata/IDs.
 */
function stripForLocalStorage(doc: RecentDocument): RecentDocument {
  if (!doc.coverUrl && !doc.handle) return doc;
  const { coverUrl: _omitCover, handle: _omitHandle, ...lightweight } = doc;
  return lightweight;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const idb =
      typeof indexedDB !== 'undefined'
        ? indexedDB
        : typeof window !== 'undefined'
          ? window.indexedDB
          : undefined;
    if (!idb) {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('lastOpened', 'lastOpened', { unique: false });
        store.createIndex('isStarred', 'isStarred', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function writeFallbackDocs(docs: RecentDocument[]): void {
  const stripped = docs.filter(isActualSavedDocument).map(stripForLocalStorage);
  safeLocalStorageSetItem(RECENT_DOCS_LS_KEY, JSON.stringify(stripped), 'recent documents');
}

function getRawFallbackDocs(): RecentDocument[] {
  try {
    const raw = safeLocalStorageGetItem(RECENT_DOCS_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(isActualSavedDocument);
      }
    }
  } catch {
    // ignore
  }
  return [];
}

function getFallbackDocs(): RecentDocument[] {
  return getRawFallbackDocs().map(stripForLocalStorage);
}

export async function loadRecentDocuments(): Promise<RecentDocument[]> {
  // Read any legacy localStorage records (and purge unsaved/thumbnails from localStorage)
  const rawLegacy = getRawFallbackDocs();
  const hasLegacyThumbnails = rawLegacy.some((d) => Boolean(d.coverUrl));
  if (rawLegacy.length > 0 || safeLocalStorageGetItem(RECENT_DOCS_LS_KEY)) {
    writeFallbackDocs(rawLegacy);
  }

  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        let docs = (req.result as RecentDocument[]) || [];
        // Clean out any unsaved or legacy dummy documents from IDB
        const invalidDocs = docs.filter((d) => !isActualSavedDocument(d));
        if (invalidDocs.length > 0) {
          for (const s of invalidDocs) {
            store.delete(s.id);
          }
          docs = docs.filter((d) => isActualSavedDocument(d));
        }

        // Migrate any legacy localStorage docs (including thumbnails) into IDB if missing
        const existingIds = new Set(docs.map((d) => d.id));
        if (hasLegacyThumbnails || rawLegacy.some((d) => !existingIds.has(d.id))) {
          for (const legacy of rawLegacy) {
            if (!existingIds.has(legacy.id)) {
              store.put(legacy);
              docs.push(legacy);
              existingIds.add(legacy.id);
            }
          }
        }

        docs.sort((a, b) => b.lastOpened - a.lastOpened);
        resolve(docs);
      };
      req.onerror = () => {
        resolve(getFallbackDocs());
      };
    });
  } catch {
    return getFallbackDocs();
  }
}

export async function saveRecentDocument(
  doc: Omit<RecentDocument, 'lastOpened'> & { lastOpened?: number }
): Promise<void> {
  // Only persist documents that were actually saved to the PC
  if (doc.isSaved === false || doc.size === 524288 || doc.title?.endsWith('*')) {
    return;
  }

  const fullDoc: RecentDocument = {
    ...doc,
    isSaved: doc.isSaved ?? true,
    lastOpened: doc.lastOpened ?? Date.now(),
  };

  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put(fullDoc);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    if (fullDoc.handle) {
      const { handle: _omitHandle, ...withoutHandle } = fullDoc;
      try {
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          const req = tx.objectStore(STORE_NAME).put(withoutHandle);
          req.onerror = () => reject(req.error);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        return;
      } catch {
        // Fall through to localStorage fallback
      }
    }
    handleIndexedDbError(err, 'recent document thumbnail');
    // Fallback to localStorage without heavy thumbnail payloads or file handles
    const current = getFallbackDocs().filter((d) => d.id !== fullDoc.id);
    writeFallbackDocs([stripForLocalStorage(fullDoc), ...current]);
  }
}

export async function toggleStarDocument(id: string): Promise<boolean> {
  try {
    const db = await openDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => {
        const item = req.result as RecentDocument | undefined;
        if (item) {
          item.isStarred = !item.isStarred;
          store.put(item);
          tx.oncomplete = () => resolve(item.isStarred);
        } else {
          resolve(false);
        }
      };
      req.onerror = () => resolve(false);
    });
  } catch {
    const current = getFallbackDocs();
    const target = current.find((d) => d.id === id);
    if (target) {
      target.isStarred = !target.isStarred;
      writeFallbackDocs(current);
      return target.isStarred;
    }
    return false;
  }
}

export async function removeRecentDocument(id: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  }
  const current = getFallbackDocs().filter((d) => d.id !== id);
  writeFallbackDocs(current);
}

export async function permanentlyDeleteDocument(
  doc: RecentDocument
): Promise<{ success: boolean; error?: string }> {
  let diskSuccess = true;
  let diskError: string | undefined;

  // 1. If running in Tauri, delete file from host PC storage
  if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_file_from_disk', { path: doc.path });
    } catch (err: any) {
      console.warn('Failed to delete file from disk via Tauri:', err);
      diskSuccess = false;
      diskError = err?.message || String(err);
    }
  }

  // 2. Remove from app database
  await removeRecentDocument(doc.id);

  return { success: diskSuccess, error: diskError };
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
