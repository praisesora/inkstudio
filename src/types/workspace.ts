import { BrushPresetId, ToolType } from './editor';

export type DockPanelId =
  | 'tools'
  | 'subtool'
  | 'tool-property'
  | 'brush-size'
  | 'navigator'
  | 'sub-view'
  | 'color'
  | 'layers'
  | 'history'
  | 'quick-access';

export type DockSide = 'left' | 'right';

export type WorkspacePresetId =
  | 'default-illustration'
  | 'manga-studio'
  | 'minimalist-tablet'
  | 'custom';

export interface DockGroup {
  id: string;
  panelIds: DockPanelId[];
  activePanelId: DockPanelId;
  heightRatio: number;
}

export interface DockColumn {
  id: string;
  width: number;
  collapsed: boolean;
  groups: DockGroup[];
}

export interface WorkspaceLayout {
  leftDocks: DockColumn[];
  rightDocks: DockColumn[];
}

export type CommandActionId =
  | 'undo'
  | 'redo'
  | 'save'
  | 'save-as'
  | 'new-layer'
  | 'duplicate-layer'
  | 'clear-layer'
  | 'merge-down'
  | 'flip-h'
  | 'flip-v'
  | 'reset-zoom'
  | 'reset-rotation'
  | 'transform'
  | 'deselect'
  | 'toggle-palettes'
  | 'swap-colors'
  | 'transparent-ink';

export type QuickAccessItemKind = 'command' | 'tool' | 'color' | 'brush';

export interface QuickAccessItem {
  id: string;
  kind: QuickAccessItemKind;
  label: string;
  commandId?: CommandActionId;
  toolId?: ToolType;
  color?: string;
  brushPresetId?: BrushPresetId;
}

export type QuickAccessViewMode = 'grid' | 'list';

export interface PersistedWorkspaceState {
  version: 1;
  activePreset: WorkspacePresetId;
  layout: WorkspaceLayout;
  savedCustomLayout: WorkspaceLayout | null;
  quickAccessItems: QuickAccessItem[];
  quickAccessViewMode: QuickAccessViewMode;
  commandBarIds: CommandActionId[];
  showStatusBar: boolean;
  showDocumentTabs: boolean;
  showCommandBar: boolean;
}

export interface DockPanelMeta {
  id: DockPanelId;
  title: string;
  shortTitle: string;
  defaultSide: DockSide;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

export const ALL_DOCK_PANEL_IDS: DockPanelId[] = [
  'tools',
  'subtool',
  'tool-property',
  'brush-size',
  'navigator',
  'sub-view',
  'color',
  'layers',
  'history',
  'quick-access',
];

export const DOCK_PANEL_META: Record<DockPanelId, DockPanelMeta> = {
  tools: {
    id: 'tools',
    title: 'Tool',
    shortTitle: 'Tool',
    defaultSide: 'left',
    defaultWidth: 46,
    minWidth: 44,
    maxWidth: 96,
  },
  subtool: {
    id: 'subtool',
    title: 'Sub Tool',
    shortTitle: 'Sub',
    defaultSide: 'left',
    defaultWidth: 196,
    minWidth: 140,
    maxWidth: 340,
  },
  'tool-property': {
    id: 'tool-property',
    title: 'Tool Property',
    shortTitle: 'Prop',
    defaultSide: 'left',
    defaultWidth: 196,
    minWidth: 148,
    maxWidth: 340,
  },
  'brush-size': {
    id: 'brush-size',
    title: 'Brush Size',
    shortTitle: 'Size',
    defaultSide: 'left',
    defaultWidth: 196,
    minWidth: 148,
    maxWidth: 340,
  },
  navigator: {
    id: 'navigator',
    title: 'Navigator',
    shortTitle: 'Nav',
    defaultSide: 'right',
    defaultWidth: 224,
    minWidth: 176,
    maxWidth: 380,
  },
  'sub-view': {
    id: 'sub-view',
    title: 'Sub View',
    shortTitle: 'SubView',
    defaultSide: 'right',
    defaultWidth: 224,
    minWidth: 176,
    maxWidth: 400,
  },
  color: {
    id: 'color',
    title: 'Color Wheel',
    shortTitle: 'Color',
    defaultSide: 'right',
    defaultWidth: 224,
    minWidth: 168,
    maxWidth: 360,
  },
  layers: {
    id: 'layers',
    title: 'Layer',
    shortTitle: 'Layer',
    defaultSide: 'right',
    defaultWidth: 224,
    minWidth: 176,
    maxWidth: 380,
  },
  history: {
    id: 'history',
    title: 'History',
    shortTitle: 'Hist',
    defaultSide: 'right',
    defaultWidth: 224,
    minWidth: 160,
    maxWidth: 340,
  },
  'quick-access': {
    id: 'quick-access',
    title: 'Quick Access',
    shortTitle: 'Quick',
    defaultSide: 'right',
    defaultWidth: 184,
    minWidth: 136,
    maxWidth: 320,
  },
};

export interface CommandCatalogEntry {
  id: CommandActionId;
  label: string;
  shortLabel: string;
  shortcut?: string;
}

export const COMMAND_CATALOG: CommandCatalogEntry[] = [
  { id: 'save', label: 'Save', shortLabel: 'Save', shortcut: 'Ctrl+S' },
  { id: 'save-as', label: 'Save As', shortLabel: 'Save As', shortcut: 'Ctrl+Shift+S' },
  { id: 'undo', label: 'Undo', shortLabel: 'Undo', shortcut: 'Ctrl+Z' },
  { id: 'redo', label: 'Redo', shortLabel: 'Redo', shortcut: 'Ctrl+Y' },
  { id: 'flip-h', label: 'Flip Horizontal', shortLabel: 'Flip H', shortcut: 'Shift+H' },
  { id: 'flip-v', label: 'Flip Vertical', shortLabel: 'Flip V', shortcut: 'Shift+V' },
  { id: 'clear-layer', label: 'Clear Layer', shortLabel: 'Clear' },
  { id: 'merge-down', label: 'Merge Down', shortLabel: 'Merge' },
  { id: 'new-layer', label: 'New Layer', shortLabel: 'New Lyr', shortcut: 'Ctrl+Shift+N' },
  { id: 'duplicate-layer', label: 'Duplicate Layer', shortLabel: 'Dup Lyr', shortcut: 'Ctrl+J' },
  { id: 'transform', label: 'Free Transform', shortLabel: 'Transf', shortcut: 'Ctrl+T' },
  { id: 'deselect', label: 'Deselect', shortLabel: 'Desel', shortcut: 'Ctrl+D' },
  { id: 'reset-zoom', label: 'Reset Zoom', shortLabel: 'Fit', shortcut: 'Ctrl+0' },
  { id: 'reset-rotation', label: 'Reset Rotation', shortLabel: '0°', shortcut: 'Ctrl+Alt+0' },
  { id: 'swap-colors', label: 'Swap Colors', shortLabel: 'Swap', shortcut: 'X' },
  { id: 'transparent-ink', label: 'Transparent Ink', shortLabel: 'Transp', shortcut: 'C' },
  { id: 'toggle-palettes', label: 'Hide/Show Palettes', shortLabel: 'Palettes', shortcut: 'Tab' },
];

export const WORKSPACE_PRESET_LABELS: Record<WorkspacePresetId, string> = {
  'default-illustration': 'Default Illustration',
  'manga-studio': 'Manga Studio',
  'minimalist-tablet': 'Minimalist Tablet',
  custom: 'Custom',
};
