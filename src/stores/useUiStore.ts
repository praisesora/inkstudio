import { AppSettings, loadAppSettings, saveAppSettings } from '../types/settings';
import { CrashedSessionInfo } from '../services/recoveryService';
import { TonalCorrectionType, ProcessingBounds } from '../utils/tonalEngine';
import { createStore } from './createStore';

export interface TonalModalState {
  isOpen: boolean;
  type: TonalCorrectionType;
  targetLayerId: string;
  beforeImageData: ImageData | null;
  selectionMask: Uint8Array | null;
  bounds: ProcessingBounds;
}

export interface AdjustmentModalState {
  isOpen: boolean;
  layerId?: string;
  initialType?: 'curves' | 'gradient-map' | 'levels' | 'color-balance';
}

export interface LayerStylesModalState {
  isOpen: boolean;
  layerId?: string;
}

export interface UiStoreState {
  appView: 'home' | 'workspace';
  leftPanelWidth: number;
  isLeftPanelHidden: boolean;
  rightSidebarWidth: number;
  isRightSidebarHidden: boolean;
  isWebtoonMode: boolean;
  is3DLayerOpen: boolean;
  initial3DFile: File | null;
  appSettings: AppSettings;

  // Modals
  isNewCanvasModalOpen: boolean;
  isResizeCanvasModalOpen: boolean;
  isSettingsModalOpen: boolean;
  isToneModalOpen: boolean;
  isMangaEffectsModalOpen: boolean;
  isWebtoonExportModalOpen: boolean;
  isTimelapseExportModalOpen: boolean;
  isRecoveryModalOpen: boolean;
  crashedSessions: CrashedSessionInfo[];
  tonalModalState: TonalModalState;
  adjustmentModalState: AdjustmentModalState;
  layerStylesModalState: LayerStylesModalState;

  // Transient feedback
  isLoadingFile: boolean;
  loadingStatus: string;
  toastMessage: string | null;
}

const DEFAULT_TONAL_MODAL_STATE: TonalModalState = {
  isOpen: false,
  type: 'brightness-contrast',
  targetLayerId: '',
  beforeImageData: null,
  selectionMask: null,
  bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
};

function readStoredNumber(key: string, fallback: number): number {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  } catch {
    // Ignore storage errors
  }
  return fallback;
}

const createInitialUiState = (): UiStoreState => ({
  appView: 'workspace',
  leftPanelWidth: readStoredNumber('ink_left_panel_width_v3', 118),
  isLeftPanelHidden: false,
  rightSidebarWidth: readStoredNumber('ink_right_sidebar_width_v3', 162),
  isRightSidebarHidden: false,
  isWebtoonMode: false,
  is3DLayerOpen: false,
  initial3DFile: null,
  appSettings: loadAppSettings(),

  isNewCanvasModalOpen: false,
  isResizeCanvasModalOpen: false,
  isSettingsModalOpen: false,
  isToneModalOpen: false,
  isMangaEffectsModalOpen: false,
  isWebtoonExportModalOpen: false,
  isTimelapseExportModalOpen: false,
  isRecoveryModalOpen: false,
  crashedSessions: [],
  tonalModalState: { ...DEFAULT_TONAL_MODAL_STATE },
  adjustmentModalState: { isOpen: false },
  layerStylesModalState: { isOpen: false },

  isLoadingFile: false,
  loadingStatus: '',
  toastMessage: null,
});

export const useUiStore = createStore<UiStoreState>(createInitialUiState);

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const uiStoreActions = {
  setAppView(appView: 'home' | 'workspace'): void {
    useUiStore.setState({ appView });
  },

  setLeftPanelWidth(w: number): void {
    useUiStore.setState({ leftPanelWidth: w });
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('ink_left_panel_width_v3', String(w));
      }
    } catch {
      // Ignore storage errors
    }
  },

  setRightSidebarWidth(w: number): void {
    useUiStore.setState({ rightSidebarWidth: w });
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('ink_right_sidebar_width_v3', String(w));
      }
    } catch {
      // Ignore storage errors
    }
  },

  setLeftPanelHidden(hidden: boolean): void {
    useUiStore.setState({ isLeftPanelHidden: hidden });
  },

  toggleLeftPanelHidden(): void {
    useUiStore.setState((prev) => ({ isLeftPanelHidden: !prev.isLeftPanelHidden }));
  },

  setRightSidebarHidden(hidden: boolean): void {
    useUiStore.setState({ isRightSidebarHidden: hidden });
  },

  toggleRightSidebarHidden(): void {
    useUiStore.setState((prev) => ({ isRightSidebarHidden: !prev.isRightSidebarHidden }));
  },

  toggleAllPanels(): void {
    useUiStore.setState((prev) => {
      const nextHidden = !(prev.isLeftPanelHidden && prev.isRightSidebarHidden);
      return {
        isLeftPanelHidden: nextHidden,
        isRightSidebarHidden: nextHidden,
      };
    });
  },

  setWebtoonMode(enabled: boolean): void {
    useUiStore.setState({ isWebtoonMode: enabled });
  },

  toggleWebtoonMode(): void {
    useUiStore.setState((prev) => ({ isWebtoonMode: !prev.isWebtoonMode }));
  },

  set3DLayerOpen(open: boolean, initialFile: File | null = null): void {
    useUiStore.setState({
      is3DLayerOpen: open,
      initial3DFile: open ? initialFile : null,
    });
  },

  updateAppSettings(newSettings: AppSettings): void {
    useUiStore.setState({ appSettings: newSettings });
    saveAppSettings(newSettings);
  },

  setNewCanvasModalOpen(open: boolean): void {
    useUiStore.setState({ isNewCanvasModalOpen: open });
  },

  setResizeCanvasModalOpen(open: boolean): void {
    useUiStore.setState({ isResizeCanvasModalOpen: open });
  },

  setSettingsModalOpen(open: boolean): void {
    useUiStore.setState({ isSettingsModalOpen: open });
  },

  setToneModalOpen(open: boolean): void {
    useUiStore.setState({ isToneModalOpen: open });
  },

  setMangaEffectsModalOpen(open: boolean): void {
    useUiStore.setState({ isMangaEffectsModalOpen: open });
  },

  setWebtoonExportModalOpen(open: boolean): void {
    useUiStore.setState({ isWebtoonExportModalOpen: open });
  },

  setTimelapseExportModalOpen(open: boolean): void {
    useUiStore.setState({ isTimelapseExportModalOpen: open });
  },

  setRecoveryModal(open: boolean, sessions?: CrashedSessionInfo[]): void {
    useUiStore.setState((prev) => ({
      isRecoveryModalOpen: open,
      crashedSessions: sessions ?? prev.crashedSessions,
    }));
  },

  setCrashedSessions(
    updater: CrashedSessionInfo[] | ((prev: CrashedSessionInfo[]) => CrashedSessionInfo[])
  ): void {
    useUiStore.setState((prev) => ({
      crashedSessions: typeof updater === 'function' ? updater(prev.crashedSessions) : updater,
    }));
  },

  setTonalModalState(
    updater: TonalModalState | ((prev: TonalModalState) => TonalModalState)
  ): void {
    useUiStore.setState((prev) => ({
      tonalModalState: typeof updater === 'function' ? updater(prev.tonalModalState) : updater,
    }));
  },

  setAdjustmentModalState(adjustmentModalState: AdjustmentModalState): void {
    useUiStore.setState({ adjustmentModalState });
  },

  setLayerStylesModalState(layerStylesModalState: LayerStylesModalState): void {
    useUiStore.setState({ layerStylesModalState });
  },

  setLoading(isLoadingFile: boolean, loadingStatus = ''): void {
    useUiStore.setState({ isLoadingFile, loadingStatus });
  },

  showToast(msg: string): void {
    if (toastTimer) clearTimeout(toastTimer);
    useUiStore.setState({ toastMessage: msg });
    toastTimer = setTimeout(() => {
      toastTimer = null;
      useUiStore.setState({ toastMessage: null });
    }, 3200);
  },

  clearToast(): void {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    useUiStore.setState({ toastMessage: null });
  },
};

export function selectIsAnyModalOpen(state: UiStoreState, isHostModalOpen = false): boolean {
  return (
    state.isNewCanvasModalOpen ||
    state.isResizeCanvasModalOpen ||
    state.isSettingsModalOpen ||
    state.isToneModalOpen ||
    state.isMangaEffectsModalOpen ||
    state.isWebtoonExportModalOpen ||
    state.isTimelapseExportModalOpen ||
    state.isRecoveryModalOpen ||
    state.tonalModalState.isOpen ||
    state.adjustmentModalState.isOpen ||
    state.layerStylesModalState.isOpen ||
    isHostModalOpen
  );
}
