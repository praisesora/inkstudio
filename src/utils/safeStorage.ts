/**
 * Safe browser storage helpers with QuotaExceededError detection and user toast notification.
 */

type QuotaNotifier = (message: string) => void;

let quotaNotifier: QuotaNotifier | null = null;

export function setStorageQuotaNotifier(notifier: QuotaNotifier | null): void {
  quotaNotifier = notifier;
}

export function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    e.code === 1014
  ) {
    return true;
  }
  if (typeof e.message === 'string' && /quota/i.test(e.message)) {
    return true;
  }
  return false;
}

export function notifyStorageQuotaExceeded(context?: string): void {
  const message = context
    ? `Storage quota exceeded: could not save ${context}. Free up browser storage space.`
    : 'Browser storage quota exceeded. Some local data could not be saved.';
  if (quotaNotifier) {
    try {
      quotaNotifier(message);
    } catch {
      // Ignore notifier failures
    }
  }
}

export function handleIndexedDbError(err: unknown, context?: string): void {
  if (isQuotaExceededError(err)) {
    notifyStorageQuotaExceeded(context);
    console.warn(`IndexedDB quota exceeded${context ? ` (${context})` : ''}:`, err);
    return;
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/not available|not supported/i.test(msg)) {
    return;
  }
  console.warn(`IndexedDB write failed${context ? ` (${context})` : ''}:`, err);
}

export function safeLocalStorageGetItem(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') {
      return null;
    }
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function safeLocalStorageSetItem(key: string, value: string, context?: string): boolean {
  try {
    if (typeof localStorage === 'undefined' || typeof localStorage.setItem !== 'function') {
      return false;
    }
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    if (isQuotaExceededError(err)) {
      notifyStorageQuotaExceeded(context);
    }
    console.warn(`Failed to write localStorage key "${key}"${context ? ` (${context})` : ''}:`, err);
    return false;
  }
}

export function safeLocalStorageRemoveItem(key: string): void {
  try {
    if (typeof localStorage === 'undefined' || typeof localStorage.removeItem !== 'function') {
      return;
    }
    localStorage.removeItem(key);
  } catch {
    // Ignore storage access errors
  }
}
