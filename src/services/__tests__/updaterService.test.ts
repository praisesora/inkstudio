import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DownloadEvent } from '@tauri-apps/plugin-updater';
import { DEFAULT_APP_SETTINGS } from '../../types/settings';
import {
  selectIsAnyModalOpen,
  uiStoreActions,
  useUiStore,
  useUpdaterStore,
} from '../../stores';
import { updaterService } from '../updaterService';

const mockCheck = vi.fn();
const mockRelaunch = vi.fn();
const mockGetVersion = vi.fn();

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: (...args: unknown[]) => mockCheck(...args),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: (...args: unknown[]) => mockRelaunch(...args),
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: (...args: unknown[]) => mockGetVersion(...args),
}));

interface MockUpdateHandle {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
  downloadAndInstall: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function createMockUpdate(overrides: Partial<MockUpdateHandle> = {}): MockUpdateHandle {
  return {
    version: '1.1.0',
    currentVersion: '1.0.0',
    date: '2026-11-20T00:00:00Z',
    body: '- Added auto-updater\n- Improved brush engine',
    downloadAndInstall: vi.fn(async (onEvent?: (event: DownloadEvent) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 1000 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 400 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 600 } });
      onEvent?.({ event: 'Finished' });
    }),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function setTauriWindow(enabled: boolean): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (enabled) {
    g.window = { __TAURI_INTERNALS__: {} };
  } else {
    g.window = {};
  }
}

describe('updaterService & useUpdaterStore', () => {
  const originalWindow = (globalThis as unknown as Record<string, unknown>).window;
  const originalLocalStorage = (globalThis as unknown as Record<string, unknown>).localStorage;

  beforeEach(async () => {
    const storage: Record<string, string> = {};
    (globalThis as unknown as Record<string, unknown>).localStorage = {
      getItem: (k: string) => storage[k] ?? null,
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

    mockCheck.mockReset();
    mockRelaunch.mockReset();
    mockGetVersion.mockReset();
    mockGetVersion.mockResolvedValue('1.0.0');
    mockRelaunch.mockResolvedValue(undefined);

    useUiStore.reset();
    uiStoreActions.updateAppSettings({ ...DEFAULT_APP_SETTINGS });
    await updaterService.resetUpdaterService();
    setTauriWindow(true);
  });

  afterEach(async () => {
    await updaterService.resetUpdaterService();
    vi.restoreAllMocks();
    const g = globalThis as unknown as Record<string, unknown>;
    if (originalWindow === undefined) {
      delete g.window;
    } else {
      g.window = originalWindow;
    }
    if (originalLocalStorage === undefined) {
      delete g.localStorage;
    } else {
      g.localStorage = originalLocalStorage;
    }
  });

  it('is a complete no-op outside Tauri runtime', async () => {
    setTauriWindow(false);

    const checkResult = await updaterService.checkForUpdates({ silent: false });
    const installResult = await updaterService.downloadAndInstallUpdate();
    const cancel = updaterService.scheduleStartupUpdateCheck(10);
    cancel();

    expect(checkResult).toBe(false);
    expect(installResult).toBe(false);
    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockRelaunch).not.toHaveBeenCalled();
    expect(mockGetVersion).not.toHaveBeenCalled();
    expect(useUpdaterStore.getState().status).toBe('idle');
  });

  it('silent startup check respects autoCheckUpdates = false', async () => {
    uiStoreActions.updateAppSettings({
      ...DEFAULT_APP_SETTINGS,
      autoCheckUpdates: false,
    });

    const found = await updaterService.checkForUpdates({ silent: true });
    expect(found).toBe(false);
    expect(mockCheck).not.toHaveBeenCalled();
    expect(useUpdaterStore.getState().status).toBe('idle');
  });

  it('silent check suppresses banner when update version matches skippedUpdateVersion', async () => {
    uiStoreActions.updateAppSettings({
      ...DEFAULT_APP_SETTINGS,
      autoCheckUpdates: true,
      skippedUpdateVersion: '1.1.0',
    });
    const update = createMockUpdate({ version: '1.1.0' });
    mockCheck.mockResolvedValueOnce(update);

    const found = await updaterService.checkForUpdates({ silent: true });
    expect(found).toBe(true);
    const state = useUpdaterStore.getState();
    expect(state.status).toBe('available');
    expect(state.availableVersion).toBe('1.1.0');
    expect(state.isBannerDismissed).toBe(true);
    expect(useUiStore.getState().toastMessage).toBeNull();
  });

  it('manual check ignores skippedUpdateVersion, shows update info, and disposes previous Update handle', async () => {
    uiStoreActions.updateAppSettings({
      ...DEFAULT_APP_SETTINGS,
      skippedUpdateVersion: '1.1.0',
    });

    const firstUpdate = createMockUpdate({ version: '1.1.0' });
    const secondUpdate = createMockUpdate({ version: '1.1.0', body: 'Fresh notes' });
    mockCheck.mockResolvedValueOnce(firstUpdate).mockResolvedValueOnce(secondUpdate);

    await updaterService.checkForUpdates({ silent: true });
    expect(useUpdaterStore.getState().isBannerDismissed).toBe(true);

    const foundManual = await updaterService.checkForUpdates({ silent: false });
    expect(foundManual).toBe(true);
    expect(firstUpdate.close).toHaveBeenCalledTimes(1);

    const state = useUpdaterStore.getState();
    expect(state.status).toBe('available');
    expect(state.availableVersion).toBe('1.1.0');
    expect(state.releaseNotes).toBe('Fresh notes');
    expect(state.isBannerDismissed).toBe(false);
    expect(useUiStore.getState().toastMessage).toContain('1.1.0');
  });

  it('manual check reports up-to-date when no newer release exists', async () => {
    mockCheck.mockResolvedValueOnce(null);

    const found = await updaterService.checkForUpdates({ silent: false });
    expect(found).toBe(false);
    expect(useUpdaterStore.getState().status).toBe('up-to-date');
    expect(useUpdaterStore.getState().availableVersion).toBeNull();
    expect(useUiStore.getState().toastMessage).toBe('Ink Studio is up to date');
  });

  it('handles network errors silently in silent mode and surfaces them in manual mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockCheck.mockRejectedValueOnce(new Error('Network offline'));

    const silentResult = await updaterService.checkForUpdates({ silent: true });
    expect(silentResult).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    expect(useUpdaterStore.getState().status).toBe('idle');
    expect(useUpdaterStore.getState().errorMessage).toBeNull();
    expect(useUiStore.getState().toastMessage).toBeNull();

    mockCheck.mockRejectedValueOnce(new Error('DNS lookup failed'));
    const manualResult = await updaterService.checkForUpdates({ silent: false });
    expect(manualResult).toBe(false);
    expect(useUpdaterStore.getState().status).toBe('error');
    expect(useUpdaterStore.getState().errorMessage).toBe('DNS lookup failed');
    expect(useUiStore.getState().toastMessage).toContain('DNS lookup failed');
  });

  it('guards against concurrent update checks', async () => {
    let resolveCheck!: (val: MockUpdateHandle | null) => void;
    mockCheck.mockImplementationOnce(
      () =>
        new Promise<MockUpdateHandle | null>((resolve) => {
          resolveCheck = resolve;
        })
    );

    const first = updaterService.checkForUpdates({ silent: false });
    const second = updaterService.checkForUpdates({ silent: false });

    expect(await second).toBe(false);
    await vi.waitFor(() => {
      expect(mockCheck).toHaveBeenCalledTimes(1);
    });

    resolveCheck(null);
    await first;
    expect(useUpdaterStore.getState().status).toBe('up-to-date');
  });

  it('tracks download progress accurately, transitions to ready, disposes handle, and relaunches', async () => {
    const observedProgress: number[] = [];
    const unsub = useUpdaterStore.subscribe(() => {
      const s = useUpdaterStore.getState();
      if (s.status === 'downloading') {
        observedProgress.push(s.progressPercent);
      }
    });

    const update = createMockUpdate({
      version: '1.2.0',
      downloadAndInstall: vi.fn(async (onEvent?: (e: DownloadEvent) => void) => {
        onEvent?.({ event: 'Started', data: { contentLength: 2000 } });
        onEvent?.({ event: 'Progress', data: { chunkLength: 500 } });
        onEvent?.({ event: 'Progress', data: { chunkLength: 1000 } });
        onEvent?.({ event: 'Progress', data: { chunkLength: 500 } });
        onEvent?.({ event: 'Finished' });
      }),
    });
    mockCheck.mockResolvedValueOnce(update);

    await updaterService.checkForUpdates({ silent: true });
    const installed = await updaterService.downloadAndInstallUpdate();
    unsub();

    expect(installed).toBe(true);
    expect(observedProgress).toContain(25);
    expect(observedProgress).toContain(75);
    expect(observedProgress).toContain(100);
    expect(useUpdaterStore.getState().status).toBe('ready');
    expect(useUpdaterStore.getState().progressPercent).toBe(100);
    expect(useUpdaterStore.getState().downloadedBytes).toBe(2000);
    expect(useUpdaterStore.getState().totalBytes).toBe(2000);
    expect(update.close).toHaveBeenCalledTimes(1);
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });

  it('handles download failure cleanly with error state and toast', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const update = createMockUpdate({
      downloadAndInstall: vi.fn(async () => {
        throw new Error('Signature verification failed');
      }),
    });
    mockCheck.mockResolvedValueOnce(update);

    await updaterService.checkForUpdates({ silent: true });
    const installed = await updaterService.downloadAndInstallUpdate();

    expect(installed).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    expect(useUpdaterStore.getState().status).toBe('error');
    expect(useUpdaterStore.getState().errorMessage).toBe('Signature verification failed');
    expect(useUiStore.getState().toastMessage).toContain('Signature verification failed');
    expect(mockRelaunch).not.toHaveBeenCalled();
  });

  it('skipAvailableVersion persists skippedUpdateVersion and hides modal/banner', async () => {
    const update = createMockUpdate({ version: '1.3.0' });
    mockCheck.mockResolvedValueOnce(update);

    await updaterService.checkForUpdates({ silent: true });
    updaterService.openUpdateModal();
    expect(useUpdaterStore.getState().isModalOpen).toBe(true);
    expect(selectIsAnyModalOpen(useUiStore.getState())).toBe(true);

    updaterService.skipAvailableVersion();
    expect(useUiStore.getState().appSettings.skippedUpdateVersion).toBe('1.3.0');
    expect(useUpdaterStore.getState().isModalOpen).toBe(false);
    expect(useUpdaterStore.getState().isBannerDismissed).toBe(true);
    expect(selectIsAnyModalOpen(useUiStore.getState())).toBe(false);
  });
});
