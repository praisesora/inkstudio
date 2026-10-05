import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadRecentDocuments,
  saveRecentDocument,
  toggleStarDocument,
  removeRecentDocument,
  permanentlyDeleteDocument,
  formatFileSize,
  RecentDocument,
} from '../recentDocumentsManager';

describe('recentDocumentsManager', () => {
  beforeEach(() => {
    const storage: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => storage[k] || null,
      setItem: (k: string, v: string) => {
        storage[k] = String(v);
      },
      removeItem: (k: string) => {
        delete storage[k];
      },
      clear: () => {
        Object.keys(storage).forEach((k) => delete storage[k]);
      },
    };
  });

  it('formats file sizes accurately', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1048576)).toBe('1.0 MB');
    expect(formatFileSize(4404019)).toBe('4.2 MB');
  });

  it('returns empty array when no documents are stored', async () => {
    const docs = await loadRecentDocuments();
    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBe(0);
  });

  it('saves and updates recent documents correctly', async () => {
    const newDoc: RecentDocument = {
      id: 'test-doc-123',
      title: 'Manga_Test.sora',
      path: 'C:\\Users\\Test\\Manga_Test.sora',
      size: 2048000,
      isStarred: false,
      lastOpened: Date.now(),
    };

    await saveRecentDocument(newDoc);
    const docs = await loadRecentDocuments();
    const found = docs.find((d) => d.id === 'test-doc-123');
    expect(found).toBeDefined();
    expect(found?.title).toBe('Manga_Test.sora');
  });

  it('toggles star state of documents', async () => {
    const testDoc: RecentDocument = {
      id: 'star-toggle-doc',
      title: 'Star_Test.sora',
      path: 'C:\\Users\\Test\\Star_Test.sora',
      size: 1024,
      isStarred: false,
      lastOpened: Date.now(),
    };
    await saveRecentDocument(testDoc);
    const newStarred = await toggleStarDocument(testDoc.id);
    expect(newStarred).toBe(true);
    const unstarred = await toggleStarDocument(testDoc.id);
    expect(unstarred).toBe(false);
  });

  it('removes documents from app list', async () => {
    const testDoc: RecentDocument = {
      id: 'doc-to-remove',
      title: 'Remove_Test.sora',
      path: 'C:\\Users\\Test\\Remove_Test.sora',
      size: 1024,
      isStarred: false,
      lastOpened: Date.now(),
    };
    await saveRecentDocument(testDoc);
    await removeRecentDocument(testDoc.id);
    const docs = await loadRecentDocuments();
    expect(docs.find((d) => d.id === testDoc.id)).toBeUndefined();
  });

  it('handles permanent delete calls gracefully', async () => {
    const testDoc: RecentDocument = {
      id: 'doc-to-perm-delete',
      title: 'Temp.sora',
      path: 'C:\\Invalid\\NonExistent\\Temp.sora',
      size: 1024,
      isStarred: false,
      lastOpened: Date.now(),
    };
    await saveRecentDocument(testDoc);
    const res = await permanentlyDeleteDocument(testDoc);
    expect(res.success).toBe(true);
    const docs = await loadRecentDocuments();
    expect(docs.find((d) => d.id === testDoc.id)).toBeUndefined();
  });
});
