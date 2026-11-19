import {
  CommandActionId,
  DockPanelId,
  PersistedWorkspaceState,
  QuickAccessItem,
  QuickAccessViewMode,
  WorkspaceLayout,
  WorkspacePresetId,
} from '../types/workspace';
import {
  DEFAULT_COMMAND_BAR_IDS,
  DEFAULT_QUICK_ACCESS_ITEMS,
  MovePanelTarget,
  cloneLayout,
  getPresetLayout,
  loadWorkspaceState,
  movePanelInLayout,
  resizeColumnInLayout,
  resizeGroupSplitInLayout,
  saveWorkspaceState,
  setGroupActivePanelInLayout,
  toggleColumnCollapsedInLayout,
  togglePanelInLayout,
} from '../utils/workspacePresets';
import { createStore } from './createStore';
import { useUiStore } from './useUiStore';

export interface WorkspaceStoreState {
  activePreset: WorkspacePresetId;
  layout: WorkspaceLayout;
  savedCustomLayout: WorkspaceLayout | null;
  palettesHidden: boolean;
  openPopover: { colId: string; panelId: DockPanelId } | null;
  quickAccessItems: QuickAccessItem[];
  quickAccessViewMode: QuickAccessViewMode;
  commandBarIds: CommandActionId[];
  showStatusBar: boolean;
  showDocumentTabs: boolean;
  showCommandBar: boolean;
}

const createInitialWorkspaceState = (): WorkspaceStoreState => {
  const loaded = loadWorkspaceState();
  return {
    activePreset: loaded.activePreset,
    layout: loaded.layout,
    savedCustomLayout: loaded.savedCustomLayout,
    palettesHidden: false,
    openPopover: null,
    quickAccessItems: loaded.quickAccessItems,
    quickAccessViewMode: loaded.quickAccessViewMode,
    commandBarIds: loaded.commandBarIds,
    showStatusBar: loaded.showStatusBar,
    showDocumentTabs: loaded.showDocumentTabs,
    showCommandBar: loaded.showCommandBar,
  };
};

export const useWorkspaceStore = createStore<WorkspaceStoreState>(createInitialWorkspaceState);

function persistCurrentWorkspace(): void {
  const s = useWorkspaceStore.getState();
  const payload: PersistedWorkspaceState = {
    version: 1,
    activePreset: s.activePreset,
    layout: s.layout,
    savedCustomLayout: s.savedCustomLayout,
    quickAccessItems: s.quickAccessItems,
    quickAccessViewMode: s.quickAccessViewMode,
    commandBarIds: s.commandBarIds,
    showStatusBar: s.showStatusBar,
    showDocumentTabs: s.showDocumentTabs,
    showCommandBar: s.showCommandBar,
  };
  saveWorkspaceState(payload);
}

export const workspaceStoreActions = {
  applyPreset(preset: WorkspacePresetId): void {
    const prev = useWorkspaceStore.getState();
    const nextLayout =
      preset === 'custom'
        ? cloneLayout(prev.savedCustomLayout ?? prev.layout)
        : getPresetLayout(preset);
    useWorkspaceStore.setState({
      activePreset: preset,
      layout: nextLayout,
      openPopover: null,
      palettesHidden: false,
    });
    useUiStore.setState({ isLeftPanelHidden: false, isRightSidebarHidden: false });
    persistCurrentWorkspace();
  },

  resetWorkspace(): void {
    const prev = useWorkspaceStore.getState();
    const basePreset: Exclude<WorkspacePresetId, 'custom'> =
      prev.activePreset === 'custom' ? 'default-illustration' : prev.activePreset;
    const nextLayout = getPresetLayout(basePreset);
    useWorkspaceStore.setState({
      activePreset: basePreset,
      layout: nextLayout,
      openPopover: null,
      palettesHidden: false,
      showStatusBar: true,
      showDocumentTabs: true,
      showCommandBar: true,
    });
    useUiStore.setState({ isLeftPanelHidden: false, isRightSidebarHidden: false });
    persistCurrentWorkspace();
  },

  saveAsCustomPreset(): void {
    const prev = useWorkspaceStore.getState();
    useWorkspaceStore.setState({
      activePreset: 'custom',
      savedCustomLayout: cloneLayout(prev.layout),
    });
    persistCurrentWorkspace();
  },

  movePanel(panelId: DockPanelId, target: MovePanelTarget): void {
    useWorkspaceStore.setState((prev) => {
      const nextLayout = movePanelInLayout(prev.layout, panelId, target);
      return {
        layout: nextLayout,
        activePreset: 'custom',
        savedCustomLayout: cloneLayout(nextLayout),
        openPopover: null,
      };
    });
    persistCurrentWorkspace();
  },

  setGroupActivePanel(colId: string, groupId: string, panelId: DockPanelId): void {
    useWorkspaceStore.setState((prev) => ({
      layout: setGroupActivePanelInLayout(prev.layout, colId, groupId, panelId),
    }));
    persistCurrentWorkspace();
  },

  toggleColumnCollapsed(colId: string, forceValue?: boolean): void {
    useWorkspaceStore.setState((prev) => {
      const nextLayout = toggleColumnCollapsedInLayout(prev.layout, colId, forceValue);
      return {
        layout: nextLayout,
        activePreset: 'custom',
        savedCustomLayout: cloneLayout(nextLayout),
        openPopover: prev.openPopover?.colId === colId ? null : prev.openPopover,
      };
    });
    persistCurrentWorkspace();
  },

  resizeColumn(colId: string, width: number): void {
    useWorkspaceStore.setState((prev) => {
      const nextLayout = resizeColumnInLayout(prev.layout, colId, width);
      if (nextLayout === prev.layout) return prev;
      return {
        layout: nextLayout,
        savedCustomLayout:
          prev.activePreset === 'custom' ? cloneLayout(nextLayout) : prev.savedCustomLayout,
      };
    });
    persistCurrentWorkspace();
  },

  resizeGroupSplit(
    colId: string,
    topGroupId: string,
    bottomGroupId: string,
    topRatio: number,
    bottomRatio: number
  ): void {
    useWorkspaceStore.setState((prev) => {
      const nextLayout = resizeGroupSplitInLayout(
        prev.layout,
        colId,
        topGroupId,
        bottomGroupId,
        topRatio,
        bottomRatio
      );
      return {
        layout: nextLayout,
        savedCustomLayout:
          prev.activePreset === 'custom' ? cloneLayout(nextLayout) : prev.savedCustomLayout,
      };
    });
    persistCurrentWorkspace();
  },

  togglePanelVisibility(panelId: DockPanelId): void {
    useWorkspaceStore.setState((prev) => {
      const nextLayout = togglePanelInLayout(prev.layout, panelId);
      return {
        layout: nextLayout,
        activePreset: 'custom',
        savedCustomLayout: cloneLayout(nextLayout),
        openPopover: prev.openPopover?.panelId === panelId ? null : prev.openPopover,
      };
    });
    persistCurrentWorkspace();
  },

  setPalettesHidden(hidden: boolean): void {
    useWorkspaceStore.setState({ palettesHidden: hidden, openPopover: null });
    useUiStore.setState({ isLeftPanelHidden: hidden, isRightSidebarHidden: hidden });
  },

  togglePalettesHidden(): boolean {
    const next = !useWorkspaceStore.getState().palettesHidden;
    workspaceStoreActions.setPalettesHidden(next);
    return next;
  },

  togglePopover(colId: string, panelId: DockPanelId): void {
    useWorkspaceStore.setState((prev) => {
      if (prev.openPopover && prev.openPopover.colId === colId && prev.openPopover.panelId === panelId) {
        return { openPopover: null };
      }
      return { openPopover: { colId, panelId } };
    });
  },

  closePopover(): void {
    if (useWorkspaceStore.getState().openPopover !== null) {
      useWorkspaceStore.setState({ openPopover: null });
    }
  },

  // Quick Access customization
  addQuickAccessItem(item: QuickAccessItem): void {
    useWorkspaceStore.setState((prev) => ({
      quickAccessItems: [...prev.quickAccessItems, item],
    }));
    persistCurrentWorkspace();
  },

  removeQuickAccessItem(id: string): void {
    useWorkspaceStore.setState((prev) => ({
      quickAccessItems: prev.quickAccessItems.filter((item) => item.id !== id),
    }));
    persistCurrentWorkspace();
  },

  moveQuickAccessItem(id: string, direction: -1 | 1): void {
    useWorkspaceStore.setState((prev) => {
      const idx = prev.quickAccessItems.findIndex((item) => item.id === id);
      const nextIdx = idx + direction;
      if (idx < 0 || nextIdx < 0 || nextIdx >= prev.quickAccessItems.length) return prev;
      const copy = [...prev.quickAccessItems];
      const [moved] = copy.splice(idx, 1);
      copy.splice(nextIdx, 0, moved);
      return { quickAccessItems: copy };
    });
    persistCurrentWorkspace();
  },

  setQuickAccessViewMode(mode: QuickAccessViewMode): void {
    useWorkspaceStore.setState({ quickAccessViewMode: mode });
    persistCurrentWorkspace();
  },

  resetQuickAccessItems(): void {
    useWorkspaceStore.setState({
      quickAccessItems: DEFAULT_QUICK_ACCESS_ITEMS.map((x) => ({ ...x })),
    });
    persistCurrentWorkspace();
  },

  // Command Bar customization
  toggleCommandBarItem(commandId: CommandActionId): void {
    useWorkspaceStore.setState((prev) => {
      const exists = prev.commandBarIds.includes(commandId);
      const next = exists
        ? prev.commandBarIds.filter((id) => id !== commandId)
        : [...prev.commandBarIds, commandId];
      return { commandBarIds: next };
    });
    persistCurrentWorkspace();
  },

  moveCommandBarItem(commandId: CommandActionId, direction: -1 | 1): void {
    useWorkspaceStore.setState((prev) => {
      const idx = prev.commandBarIds.indexOf(commandId);
      const nextIdx = idx + direction;
      if (idx < 0 || nextIdx < 0 || nextIdx >= prev.commandBarIds.length) return prev;
      const copy = [...prev.commandBarIds];
      const [moved] = copy.splice(idx, 1);
      copy.splice(nextIdx, 0, moved);
      return { commandBarIds: copy };
    });
    persistCurrentWorkspace();
  },

  resetCommandBar(): void {
    useWorkspaceStore.setState({ commandBarIds: [...DEFAULT_COMMAND_BAR_IDS] });
    persistCurrentWorkspace();
  },

  setShowStatusBar(show: boolean): void {
    useWorkspaceStore.setState({ showStatusBar: show });
    persistCurrentWorkspace();
  },

  setShowDocumentTabs(show: boolean): void {
    useWorkspaceStore.setState({ showDocumentTabs: show });
    persistCurrentWorkspace();
  },

  setShowCommandBar(show: boolean): void {
    useWorkspaceStore.setState({ showCommandBar: show });
    persistCurrentWorkspace();
  },
};
