import { DocumentTab } from '../types/editor';
import { isTauriEnvironment } from '../hooks/useMultiplayer';
import { recoveryService } from '../services/recoveryService';
import {
  AppClosePromptState,
  uiStoreActions,
  useDocumentStore,
  useUiStore,
} from '../stores';
import { flushPendingBrushSettingsSave } from './brushPresetManager';

export type SaveDocumentResult = 'saved' | 'canceled' | 'error';

const RECOVERY_CLEANUP_TIMEOUT_MS = 1500;

let finalizingAppClose = false;

export function getUnsavedDocumentIds(documents: readonly DocumentTab[]): string[] {
  return documents.filter((d) => Boolean(d.isDirty)).map((d) => d.id);
}

export function formatCanvasDisplayName(name: string | undefined | null): string {
  const cleaned = (name || '').replace(/\*+$/, '').trim();
  return cleaned || 'Untitled';
}

export function computeInitialClosePromptState(dirtyDocIds: string[]): AppClosePromptState {
  if (dirtyDocIds.length === 0) {
    return {
      isOpen: true,
      step: 'confirm-quit',
      pendingDocIds: [],
      currentIndex: 0,
      isBusy: false,
    };
  }
  if (dirtyDocIds.length === 1) {
    return {
      isOpen: true,
      step: 'per-canvas',
      pendingDocIds: [dirtyDocIds[0]],
      currentIndex: 0,
      isBusy: false,
    };
  }
  return {
    isOpen: true,
    step: 'summary',
    pendingDocIds: [...dirtyDocIds],
    currentIndex: 0,
    isBusy: false,
  };
}

export function findNextPendingDirtyIndex(
  pendingDocIds: readonly string[],
  afterIndex: number,
  documents: readonly DocumentTab[]
): number {
  for (let i = afterIndex + 1; i < pendingDocIds.length; i++) {
    const id = pendingDocIds[i];
    const doc = documents.find((d) => d.id === id);
    if (doc && doc.isDirty) {
      return i;
    }
  }
  return -1;
}

export function isFinalizingAppClose(): boolean {
  return finalizingAppClose;
}

/**
 * Resets internal shutdown guard (for tests).
 */
export function _resetAppCloseFlowForTests(): void {
  finalizingAppClose = false;
}

/**
 * Initiates the app-close confirmation workflow.
 * No-ops if a close prompt is already open or shutdown is already underway.
 */
export function requestAppClose(): boolean {
  if (finalizingAppClose) return false;
  if (useUiStore.getState().appClosePrompt.isOpen) return false;

  const dirtyIds = getUnsavedDocumentIds(useDocumentStore.getState().documents);
  uiStoreActions.setAppClosePrompt(computeInitialClosePromptState(dirtyIds));
  return true;
}

export function cancelAppClose(): boolean {
  if (finalizingAppClose) return false;
  if (useUiStore.getState().appClosePrompt.isBusy) return false;
  uiStoreActions.resetAppClosePrompt();
  return true;
}

export interface FinalizeAppCloseDeps {
  isTauri?: () => boolean;
  destroyTauriWindow?: () => Promise<void>;
  closeBrowserWindow?: () => void;
  closeRecoverySession?: (docId: string) => Promise<void>;
  flushBrushSettings?: () => void;
}

async function destroyNativeWindow(): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().destroy();
}

/**
 * Performs clean shutdown: flushes brush settings, closes active recovery sessions
 * (so intentionally closed/discarded canvases do not trigger crash recovery next launch),
 * and destroys the window.
 */
export async function finalizeAppClose(deps: FinalizeAppCloseDeps = {}): Promise<void> {
  if (finalizingAppClose) return;
  finalizingAppClose = true;

  uiStoreActions.setAppClosePrompt((prev) => ({ ...prev, isBusy: true }));

  const flushBrush = deps.flushBrushSettings ?? flushPendingBrushSettingsSave;
  const closeRecovery =
    deps.closeRecoverySession ?? ((id: string) => recoveryService.closeSession(id));
  const checkTauri = deps.isTauri ?? isTauriEnvironment;

  try {
    flushBrush();

    const openDocIds = useDocumentStore.getState().documents.map((d) => d.id);
    if (openDocIds.length > 0) {
      let timerId: ReturnType<typeof setTimeout> | null = null;
      const cleanupAll = Promise.allSettled(openDocIds.map((id) => closeRecovery(id)));
      const timeout = new Promise<void>((resolve) => {
        timerId = setTimeout(resolve, RECOVERY_CLEANUP_TIMEOUT_MS);
      });
      await Promise.race([cleanupAll, timeout]);
      if (timerId !== null) clearTimeout(timerId);
    }

    if (checkTauri()) {
      const destroy = deps.destroyTauriWindow ?? destroyNativeWindow;
      await destroy();
    } else {
      uiStoreActions.resetAppClosePrompt();
      const closeWin = deps.closeBrowserWindow ?? (() => window.close());
      closeWin();
      // In browsers where window.close() is blocked for user-opened tabs, allow future attempts.
      finalizingAppClose = false;
    }
  } catch (err) {
    console.error('Failed to close application window:', err);
    finalizingAppClose = false;
    uiStoreActions.setAppClosePrompt((prev) => ({ ...prev, isBusy: false }));
    uiStoreActions.showToast('Failed to close window');
  }
}
