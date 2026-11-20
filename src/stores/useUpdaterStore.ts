import { version as PACKAGE_VERSION } from '../../package.json';
import { createStore } from './createStore';

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'ready'
  | 'error';

export interface UpdaterStoreState {
  status: UpdaterStatus;
  currentVersion: string;
  availableVersion: string | null;
  releaseDate: string | null;
  releaseNotes: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  progressPercent: number;
  errorMessage: string | null;
  isBannerDismissed: boolean;
  isModalOpen: boolean;
}

const createInitialUpdaterState = (): UpdaterStoreState => ({
  status: 'idle',
  currentVersion: PACKAGE_VERSION,
  availableVersion: null,
  releaseDate: null,
  releaseNotes: null,
  downloadedBytes: 0,
  totalBytes: null,
  progressPercent: 0,
  errorMessage: null,
  isBannerDismissed: false,
  isModalOpen: false,
});

export const useUpdaterStore = createStore<UpdaterStoreState>(createInitialUpdaterState);

export const updaterStoreActions = {
  dismissBanner(): void {
    useUpdaterStore.setState({ isBannerDismissed: true });
  },

  openUpdateModal(): void {
    useUpdaterStore.setState({ isModalOpen: true, isBannerDismissed: true });
  },

  closeUpdateModal(): void {
    useUpdaterStore.setState({ isModalOpen: false });
  },

  reset(): void {
    useUpdaterStore.reset();
  },
};
