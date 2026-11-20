import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater';
import { version as PACKAGE_VERSION } from '../../package.json';
import { isTauriEnvironment } from '../hooks/useMultiplayer';
import { uiStoreActions, useUiStore } from '../stores/useUiStore';
import { updaterStoreActions, useUpdaterStore } from '../stores/useUpdaterStore';

export interface CheckForUpdatesOptions {
  silent?: boolean;
}

let pendingUpdate: Update | null = null;
let isCheckInFlight = false;
let isDownloadInFlight = false;

function formatErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  if (typeof err === 'string' && err.trim()) {
    return err.trim();
  }
  return fallback;
}

async function disposePendingUpdate(): Promise<void> {
  const existing = pendingUpdate;
  pendingUpdate = null;
  if (existing) {
    try {
      await existing.close();
    } catch {
      // Ignore disposal errors from already-closed updater resources
    }
  }
}

export async function resolveCurrentVersion(): Promise<string> {
  if (!isTauriEnvironment()) {
    useUpdaterStore.setState({ currentVersion: PACKAGE_VERSION });
    return PACKAGE_VERSION;
  }

  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    const runtimeVersion = await getVersion();
    const resolved = runtimeVersion?.trim() || PACKAGE_VERSION;
    useUpdaterStore.setState({ currentVersion: resolved });
    return resolved;
  } catch {
    useUpdaterStore.setState({ currentVersion: PACKAGE_VERSION });
    return PACKAGE_VERSION;
  }
}

export async function checkForUpdates(
  options: CheckForUpdatesOptions = {}
): Promise<boolean> {
  const { silent = false } = options;

  if (!isTauriEnvironment()) {
    return false;
  }

  const currentState = useUpdaterStore.getState();
  if (
    isCheckInFlight ||
    isDownloadInFlight ||
    currentState.status === 'checking' ||
    currentState.status === 'downloading'
  ) {
    return false;
  }

  const appSettings = useUiStore.getState().appSettings;
  if (silent && !appSettings.autoCheckUpdates) {
    return false;
  }

  const prevStatus = currentState.status;
  isCheckInFlight = true;

  useUpdaterStore.setState({
    status: 'checking',
    errorMessage: null,
  });

  try {
    await resolveCurrentVersion();

    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();

    await disposePendingUpdate();

    if (update) {
      pendingUpdate = update;
      const latestSettings = useUiStore.getState().appSettings;
      const isSkippedInSilentMode =
        silent &&
        Boolean(latestSettings.skippedUpdateVersion) &&
        update.version === latestSettings.skippedUpdateVersion;
      const modalCurrentlyOpen = useUpdaterStore.getState().isModalOpen;

      useUpdaterStore.setState({
        status: 'available',
        currentVersion: update.currentVersion || useUpdaterStore.getState().currentVersion,
        availableVersion: update.version,
        releaseDate: update.date ?? null,
        releaseNotes: update.body ?? null,
        downloadedBytes: 0,
        totalBytes: null,
        progressPercent: 0,
        errorMessage: null,
        isBannerDismissed: isSkippedInSilentMode || modalCurrentlyOpen,
      });

      if (!silent && !modalCurrentlyOpen) {
        uiStoreActions.showToast(`Update v${update.version} is available`);
      }

      return true;
    }

    useUpdaterStore.setState({
      status: 'up-to-date',
      availableVersion: null,
      releaseDate: null,
      releaseNotes: null,
      downloadedBytes: 0,
      totalBytes: null,
      progressPercent: 0,
      errorMessage: null,
      isBannerDismissed: true,
    });

    if (!silent) {
      uiStoreActions.showToast('Ink Studio is up to date');
    }

    return false;
  } catch (err: unknown) {
    const message = formatErrorMessage(err, 'Unable to check for updates');

    if (silent) {
      console.warn('[Updater] Silent update check failed:', err);
      useUpdaterStore.setState({
        status: prevStatus,
        errorMessage: null,
      });
    } else {
      console.warn('[Updater] Update check failed:', err);
      useUpdaterStore.setState({
        status: 'error',
        errorMessage: message,
      });
      uiStoreActions.showToast(`Update check failed: ${message}`);
    }

    return false;
  } finally {
    isCheckInFlight = false;
  }
}

export async function downloadAndInstallUpdate(): Promise<boolean> {
  if (!isTauriEnvironment()) {
    return false;
  }

  const currentState = useUpdaterStore.getState();
  if (isDownloadInFlight || currentState.status === 'downloading') {
    return false;
  }

  if (!pendingUpdate) {
    const message = 'No pending update found. Please check for updates again.';
    useUpdaterStore.setState({
      status: 'error',
      errorMessage: message,
    });
    uiStoreActions.showToast(message);
    return false;
  }

  isDownloadInFlight = true;
  let downloadedBytes = 0;
  let totalBytes: number | null = null;

  useUpdaterStore.setState({
    status: 'downloading',
    downloadedBytes: 0,
    totalBytes: null,
    progressPercent: 0,
    errorMessage: null,
    isBannerDismissed: true,
  });

  try {
    const updateHandle = pendingUpdate;

    await updateHandle.downloadAndInstall((event: DownloadEvent) => {
      switch (event.event) {
        case 'Started': {
          totalBytes =
            typeof event.data.contentLength === 'number' && event.data.contentLength > 0
              ? event.data.contentLength
              : null;
          downloadedBytes = 0;
          useUpdaterStore.setState({
            totalBytes,
            downloadedBytes: 0,
            progressPercent: 0,
          });
          break;
        }
        case 'Progress': {
          const chunk =
            typeof event.data.chunkLength === 'number' && event.data.chunkLength > 0
              ? event.data.chunkLength
              : 0;
          downloadedBytes += chunk;
          const progressPercent =
            totalBytes && totalBytes > 0
              ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
              : 0;
          useUpdaterStore.setState({
            downloadedBytes,
            progressPercent,
          });
          break;
        }
        case 'Finished': {
          useUpdaterStore.setState({
            downloadedBytes: totalBytes ?? downloadedBytes,
            progressPercent: 100,
          });
          break;
        }
      }
    });

    useUpdaterStore.setState({
      status: 'ready',
      progressPercent: 100,
      errorMessage: null,
    });

    await disposePendingUpdate();

    // On Windows (NSIS passive mode), the installer may exit the app automatically during
    // downloadAndInstall. On macOS/Linux (and Windows if still alive), explicitly relaunch.
    try {
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (relaunchErr: unknown) {
      console.warn('[Updater] Automatic relaunch did not complete:', relaunchErr);
      uiStoreActions.showToast('Update installed — please restart Ink Studio to apply it');
    }

    return true;
  } catch (err: unknown) {
    const message = formatErrorMessage(err, 'Failed to download and install update');
    console.warn('[Updater] Download/install failed:', err);
    useUpdaterStore.setState({
      status: 'error',
      errorMessage: message,
    });
    uiStoreActions.showToast(`Update failed: ${message}`);
    return false;
  } finally {
    isDownloadInFlight = false;
  }
}

export function skipAvailableVersion(): void {
  const { availableVersion } = useUpdaterStore.getState();
  if (availableVersion) {
    const currentSettings = useUiStore.getState().appSettings;
    uiStoreActions.updateAppSettings({
      ...currentSettings,
      skippedUpdateVersion: availableVersion,
    });
  }
  useUpdaterStore.setState({
    isBannerDismissed: true,
    isModalOpen: false,
  });
}

export function dismissBanner(): void {
  updaterStoreActions.dismissBanner();
}

export function openUpdateModal(): void {
  updaterStoreActions.openUpdateModal();
}

export function closeUpdateModal(): void {
  updaterStoreActions.closeUpdateModal();
}

export function scheduleStartupUpdateCheck(delayMs = 4500): () => void {
  if (!isTauriEnvironment()) {
    return () => {};
  }

  void resolveCurrentVersion();

  const timer = setTimeout(() => {
    void checkForUpdates({ silent: true });
  }, delayMs);

  return () => {
    clearTimeout(timer);
  };
}

export async function resetUpdaterService(): Promise<void> {
  isCheckInFlight = false;
  isDownloadInFlight = false;
  await disposePendingUpdate();
  updaterStoreActions.reset();
}

export const updaterService = {
  resolveCurrentVersion,
  checkForUpdates,
  downloadAndInstallUpdate,
  skipAvailableVersion,
  dismissBanner,
  openUpdateModal,
  closeUpdateModal,
  scheduleStartupUpdateCheck,
  resetUpdaterService,
};
