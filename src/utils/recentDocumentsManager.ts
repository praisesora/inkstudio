// Recent & Starred Documents Manager with IndexedDB persistence and disk removal

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
}

const DB_NAME = 'InkStudioRecentDocsDB';
const DB_VERSION = 1;
const STORE_NAME = 'recent_documents';
const LS_BACKUP_KEY = 'inkstudio_recent_docs_backup';

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

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
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

export async function loadRecentDocuments(): Promise<RecentDocument[]> {
  // Purge unsaved and legacy sample docs from localStorage
  try {
    const raw = localStorage.getItem(LS_BACKUP_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const cleaned = parsed.filter(isActualSavedDocument);
        localStorage.setItem(LS_BACKUP_KEY, JSON.stringify(cleaned));
      }
    }
  } catch {
    // ignore
  }

  try {
    const db = await openDB();
    return new Promise((resolve) => {
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

function getFallbackDocs(): RecentDocument[] {
  try {
    const raw = localStorage.getItem(LS_BACKUP_KEY);
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
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(fullDoc);
  } catch {
    // fallback to localStorage
    const current = getFallbackDocs().filter((d) => d.id !== fullDoc.id);
    localStorage.setItem(LS_BACKUP_KEY, JSON.stringify([fullDoc, ...current]));
  }
}

export async function toggleStarDocument(id: string): Promise<boolean> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
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
      localStorage.setItem(LS_BACKUP_KEY, JSON.stringify(current));
      return target.isStarred;
    }
    return false;
  }
}

export async function removeRecentDocument(id: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
  } catch {
    // ignore
  }
  const current = getFallbackDocs().filter((d) => d.id !== id);
  localStorage.setItem(LS_BACKUP_KEY, JSON.stringify(current));
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
