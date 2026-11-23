import { safeLocalStorageSetItem } from './safeStorage';
import {
  ALL_DOCK_PANEL_IDS,
  COMMAND_CATALOG,
  CommandActionId,
  DOCK_PANEL_META,
  DockColumn,
  DockGroup,
  DockPanelId,
  DockSide,
  PersistedWorkspaceState,
  QuickAccessItem,
  QuickAccessViewMode,
  WorkspaceLayout,
  WorkspacePresetId,
} from '../types/workspace';

export const WORKSPACE_STORAGE_KEY = 'ink_studio_workspace_v1';

const VALID_PANEL_SET = new Set<string>(ALL_DOCK_PANEL_IDS);
const VALID_COMMAND_SET = new Set<string>(COMMAND_CATALOG.map((c) => c.id));

export const DEFAULT_ILLUSTRATION_LAYOUT: WorkspaceLayout = {
  leftDocks: [
    {
      id: 'col-left-tools',
      width: 46,
      collapsed: false,
      groups: [
        {
          id: 'grp-tools',
          panelIds: ['tools'],
          activePanelId: 'tools',
          heightRatio: 1,
        },
      ],
    },
    {
      id: 'col-left-brushes',
      width: 204,
      collapsed: false,
      groups: [
        {
          id: 'grp-subtool',
          panelIds: ['subtool'],
          activePanelId: 'subtool',
          heightRatio: 0.34,
        },
        {
          id: 'grp-tool-prop',
          panelIds: ['tool-property'],
          activePanelId: 'tool-property',
          heightRatio: 0.38,
        },
        {
          id: 'grp-brush-size',
          panelIds: ['brush-size'],
          activePanelId: 'brush-size',
          heightRatio: 0.28,
        },
      ],
    },
  ],
  rightDocks: [
    {
      id: 'col-right-quick',
      width: 180,
      collapsed: true,
      groups: [
        {
          id: 'grp-quick-access',
          panelIds: ['quick-access'],
          activePanelId: 'quick-access',
          heightRatio: 1,
        },
      ],
    },
    {
      id: 'col-right-main',
      width: 224,
      collapsed: false,
      groups: [
        {
          id: 'grp-navigator-subview',
          panelIds: ['navigator', 'sub-view', 'info'],
          activePanelId: 'navigator',
          heightRatio: 0.26,
        },
        {
          id: 'grp-color',
          panelIds: ['color'],
          activePanelId: 'color',
          heightRatio: 0.26,
        },
        {
          id: 'grp-layers-history',
          panelIds: ['layers', 'history', 'auto-actions'],
          activePanelId: 'layers',
          heightRatio: 0.48,
        },
      ],
    },
  ],
};

export const MANGA_STUDIO_LAYOUT: WorkspaceLayout = {
  leftDocks: [
    {
      id: 'col-manga-tools',
      width: 46,
      collapsed: false,
      groups: [
        {
          id: 'grp-manga-tools',
          panelIds: ['tools'],
          activePanelId: 'tools',
          heightRatio: 1,
        },
      ],
    },
    {
      id: 'col-manga-ink',
      width: 196,
      collapsed: false,
      groups: [
        {
          id: 'grp-manga-subtool',
          panelIds: ['subtool'],
          activePanelId: 'subtool',
          heightRatio: 0.45,
        },
        {
          id: 'grp-manga-size',
          panelIds: ['brush-size'],
          activePanelId: 'brush-size',
          heightRatio: 0.55,
        },
      ],
    },
    {
      id: 'col-manga-prop',
      width: 184,
      collapsed: true,
      groups: [
        {
          id: 'grp-manga-prop',
          panelIds: ['tool-property'],
          activePanelId: 'tool-property',
          heightRatio: 1,
        },
      ],
    },
  ],
  rightDocks: [
    {
      id: 'col-manga-quick',
      width: 168,
      collapsed: false,
      groups: [
        {
          id: 'grp-manga-quick',
          panelIds: ['quick-access'],
          activePanelId: 'quick-access',
          heightRatio: 0.65,
        },
        {
          id: 'grp-manga-color',
          panelIds: ['color'],
          activePanelId: 'color',
          heightRatio: 0.35,
        },
      ],
    },
    {
      id: 'col-manga-layers',
      width: 232,
      collapsed: false,
      groups: [
        {
          id: 'grp-manga-nav-subview',
          panelIds: ['navigator', 'sub-view', 'info'],
          activePanelId: 'navigator',
          heightRatio: 0.26,
        },
        {
          id: 'grp-manga-layers',
          panelIds: ['layers'],
          activePanelId: 'layers',
          heightRatio: 0.5,
        },
        {
          id: 'grp-manga-history',
          panelIds: ['history'],
          activePanelId: 'history',
          heightRatio: 0.24,
        },
      ],
    },
  ],
};

export const MINIMALIST_TABLET_LAYOUT: WorkspaceLayout = {
  leftDocks: [
    {
      id: 'col-tablet-tools',
      width: 46,
      collapsed: false,
      groups: [
        {
          id: 'grp-tablet-tools',
          panelIds: ['tools'],
          activePanelId: 'tools',
          heightRatio: 1,
        },
      ],
    },
    {
      id: 'col-tablet-left-strip',
      width: 210,
      collapsed: true,
      groups: [
        {
          id: 'grp-tablet-brush',
          panelIds: ['subtool', 'tool-property', 'brush-size', 'color'],
          activePanelId: 'subtool',
          heightRatio: 1,
        },
      ],
    },
  ],
  rightDocks: [
    {
      id: 'col-tablet-right-strip',
      width: 224,
      collapsed: true,
      groups: [
        {
          id: 'grp-tablet-layers',
          panelIds: ['navigator', 'sub-view', 'info', 'layers', 'history', 'auto-actions', 'quick-access'],
          activePanelId: 'layers',
          heightRatio: 1,
        },
      ],
    },
  ],
};

export const DEFAULT_QUICK_ACCESS_ITEMS: QuickAccessItem[] = [
  { id: 'qa-flip-h', kind: 'command', label: 'Flip Horizontal', commandId: 'flip-h' },
  { id: 'qa-clear-layer', kind: 'command', label: 'Clear Layer', commandId: 'clear-layer' },
  { id: 'qa-merge-down', kind: 'command', label: 'Merge Down', commandId: 'merge-down' },
  { id: 'qa-save', kind: 'command', label: 'Save', commandId: 'save' },
  { id: 'qa-undo', kind: 'command', label: 'Undo', commandId: 'undo' },
  { id: 'qa-redo', kind: 'command', label: 'Redo', commandId: 'redo' },
  { id: 'qa-new-layer', kind: 'command', label: 'New Layer', commandId: 'new-layer' },
  { id: 'qa-reset-zoom', kind: 'command', label: 'Reset Zoom', commandId: 'reset-zoom' },
  { id: 'qa-tool-brush', kind: 'tool', label: 'Brush', toolId: 'brush' },
  { id: 'qa-tool-eraser', kind: 'tool', label: 'Eraser', toolId: 'eraser' },
  { id: 'qa-color-black', kind: 'color', label: 'Ink Black', color: '#000000' },
  { id: 'qa-color-white', kind: 'color', label: 'Paper White', color: '#ffffff' },
];

export const DEFAULT_COMMAND_BAR_IDS: CommandActionId[] = [
  'save',
  'undo',
  'redo',
  'flip-h',
  'flip-v',
  'clear-layer',
  'merge-down',
  'toggle-palettes',
];

export function cloneLayout(layout: WorkspaceLayout): WorkspaceLayout {
  return {
    leftDocks: layout.leftDocks.map((col) => ({
      ...col,
      groups: col.groups.map((g) => ({
        ...g,
        panelIds: [...g.panelIds],
      })),
    })),
    rightDocks: layout.rightDocks.map((col) => ({
      ...col,
      groups: col.groups.map((g) => ({
        ...g,
        panelIds: [...g.panelIds],
      })),
    })),
  };
}

export function getPresetLayout(preset: Exclude<WorkspacePresetId, 'custom'>): WorkspaceLayout {
  switch (preset) {
    case 'manga-studio':
      return cloneLayout(MANGA_STUDIO_LAYOUT);
    case 'minimalist-tablet':
      return cloneLayout(MINIMALIST_TABLET_LAYOUT);
    case 'default-illustration':
    default:
      return cloneLayout(DEFAULT_ILLUSTRATION_LAYOUT);
  }
}

export function listVisiblePanelIds(layout: WorkspaceLayout): Set<DockPanelId> {
  const out = new Set<DockPanelId>();
  for (const col of [...layout.leftDocks, ...layout.rightDocks]) {
    for (const grp of col.groups) {
      for (const pid of grp.panelIds) {
        out.add(pid);
      }
    }
  }
  return out;
}

export function findPanelLocation(
  layout: WorkspaceLayout,
  panelId: DockPanelId
): { side: DockSide; colId: string; groupId: string } | null {
  for (const side of ['left', 'right'] as const) {
    const cols = side === 'left' ? layout.leftDocks : layout.rightDocks;
    for (const col of cols) {
      for (const grp of col.groups) {
        if (grp.panelIds.includes(panelId)) {
          return { side, colId: col.id, groupId: grp.id };
        }
      }
    }
  }
  return null;
}

function pruneEmptyContainers(columns: DockColumn[]): DockColumn[] {
  return columns
    .map((col) => {
      const nonEmptyGroups = col.groups
        .filter((g) => g.panelIds.length > 0)
        .map((g) => ({
          ...g,
          activePanelId: g.panelIds.includes(g.activePanelId) ? g.activePanelId : g.panelIds[0],
        }));
      if (nonEmptyGroups.length === 0) return null;
      const totalRatio = nonEmptyGroups.reduce((acc, g) => acc + (g.heightRatio || 1), 0) || 1;
      return {
        ...col,
        groups: nonEmptyGroups.map((g) => ({
          ...g,
          heightRatio: Math.max(0.1, (g.heightRatio || 1) / totalRatio),
        })),
      };
    })
    .filter((c): c is DockColumn => c !== null);
}

export function removePanelFromLayout(
  layout: WorkspaceLayout,
  panelId: DockPanelId
): WorkspaceLayout {
  const stripCols = (cols: DockColumn[]) =>
    pruneEmptyContainers(
      cols.map((col) => ({
        ...col,
        groups: col.groups.map((g) => ({
          ...g,
          panelIds: g.panelIds.filter((id) => id !== panelId),
        })),
      }))
    );

  return {
    leftDocks: stripCols(layout.leftDocks),
    rightDocks: stripCols(layout.rightDocks),
  };
}

let uidSeq = 1;
function makeUid(prefix: string): string {
  uidSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidSeq}`;
}

export interface MovePanelTarget {
  side: DockSide;
  /** Target existing column id, or omit to create a new column on `side` */
  targetColId?: string;
  /** Target existing group id to merge as a tab */
  targetGroupId?: string;
  /** Insert as a new vertical group at index inside `targetColId` */
  insertGroupIndex?: number;
  /** Insert as a brand new dock column at index on `side` */
  insertColumnIndex?: number;
}

export function movePanelInLayout(
  layout: WorkspaceLayout,
  panelId: DockPanelId,
  target: MovePanelTarget
): WorkspaceLayout {
  // No-op if dropping onto the exact same single-panel group
  const current = findPanelLocation(layout, panelId);
  if (
    current &&
    current.side === target.side &&
    current.colId === target.targetColId &&
    current.groupId === target.targetGroupId
  ) {
    return setGroupActivePanelInLayout(layout, current.colId, current.groupId, panelId);
  }

  const cleaned = removePanelFromLayout(layout, panelId);
  const next = cloneLayout(cleaned);
  const targetCols = target.side === 'left' ? next.leftDocks : next.rightDocks;
  const meta = DOCK_PANEL_META[panelId];

  // 1. Merge into an existing group as a tab
  if (target.targetColId && target.targetGroupId) {
    const col = targetCols.find((c) => c.id === target.targetColId);
    const grp = col?.groups.find((g) => g.id === target.targetGroupId);
    if (col && grp) {
      if (!grp.panelIds.includes(panelId)) {
        grp.panelIds.push(panelId);
      }
      grp.activePanelId = panelId;
      // If column was super narrow (e.g. tools 46px) and a regular palette joined it, expand width cleanly
      if (col.width < meta.minWidth) {
        col.width = meta.defaultWidth;
      }
      return next;
    }
  }

  // 2. Insert as a new stacked group inside an existing column
  if (target.targetColId) {
    const col = targetCols.find((c) => c.id === target.targetColId);
    if (col) {
      const idx =
        target.insertGroupIndex !== undefined
          ? Math.max(0, Math.min(col.groups.length, target.insertGroupIndex))
          : col.groups.length;
      const newRatio = 1 / (col.groups.length + 1);
      const scale = 1 - newRatio;
      col.groups = col.groups.map((g) => ({ ...g, heightRatio: g.heightRatio * scale }));
      col.groups.splice(idx, 0, {
        id: makeUid('grp'),
        panelIds: [panelId],
        activePanelId: panelId,
        heightRatio: newRatio,
      });
      if (col.width < meta.minWidth) {
        col.width = meta.defaultWidth;
      }
      return next;
    }
  }

  // 3. Create a new dock column on `target.side`
  const newCol: DockColumn = {
    id: makeUid(`col-${target.side}`),
    width: meta.defaultWidth,
    collapsed: false,
    groups: [
      {
        id: makeUid('grp'),
        panelIds: [panelId],
        activePanelId: panelId,
        heightRatio: 1,
      },
    ],
  };

  if (target.insertColumnIndex !== undefined) {
    const idx = Math.max(0, Math.min(targetCols.length, target.insertColumnIndex));
    targetCols.splice(idx, 0, newCol);
  } else if (target.side === 'left') {
    targetCols.push(newCol);
  } else {
    targetCols.unshift(newCol);
  }

  return next;
}

export function setGroupActivePanelInLayout(
  layout: WorkspaceLayout,
  colId: string,
  groupId: string,
  panelId: DockPanelId
): WorkspaceLayout {
  const mapCols = (cols: DockColumn[]) =>
    cols.map((col) =>
      col.id !== colId
        ? col
        : {
            ...col,
            groups: col.groups.map((g) =>
              g.id !== groupId || !g.panelIds.includes(panelId)
                ? g
                : { ...g, activePanelId: panelId }
            ),
          }
    );

  return {
    leftDocks: mapCols(layout.leftDocks),
    rightDocks: mapCols(layout.rightDocks),
  };
}

export function toggleColumnCollapsedInLayout(
  layout: WorkspaceLayout,
  colId: string,
  forceValue?: boolean
): WorkspaceLayout {
  const mapCols = (cols: DockColumn[]) =>
    cols.map((col) =>
      col.id !== colId
        ? col
        : { ...col, collapsed: forceValue !== undefined ? forceValue : !col.collapsed }
    );

  return {
    leftDocks: mapCols(layout.leftDocks),
    rightDocks: mapCols(layout.rightDocks),
  };
}

export function getColumnWidthBounds(col: DockColumn): { min: number; max: number } {
  const panels = col.groups.flatMap((g) => g.panelIds);
  if (panels.length === 1 && panels[0] === 'tools') {
    return { min: 44, max: 92 };
  }
  let min = 136;
  let max = 380;
  for (const pid of panels) {
    const meta = DOCK_PANEL_META[pid];
    if (meta) {
      if (meta.minWidth > min && pid !== 'tools') min = meta.minWidth;
      if (meta.maxWidth > max) max = meta.maxWidth;
    }
  }
  return { min, max };
}

export function resizeColumnInLayout(
  layout: WorkspaceLayout,
  colId: string,
  requestedWidth: number
): WorkspaceLayout {
  const mapCols = (cols: DockColumn[]) =>
    cols.map((col) => {
      if (col.id !== colId) return col;
      const { min, max } = getColumnWidthBounds(col);
      const clamped = Math.max(min, Math.min(max, Math.round(requestedWidth)));
      if (clamped === col.width) return col;
      return { ...col, width: clamped };
    });

  return {
    leftDocks: mapCols(layout.leftDocks),
    rightDocks: mapCols(layout.rightDocks),
  };
}

export function resizeGroupSplitInLayout(
  layout: WorkspaceLayout,
  colId: string,
  topGroupId: string,
  bottomGroupId: string,
  nextTopRatio: number,
  nextBottomRatio: number
): WorkspaceLayout {
  const mapCols = (cols: DockColumn[]) =>
    cols.map((col) => {
      if (col.id !== colId) return col;
      return {
        ...col,
        groups: col.groups.map((g) => {
          if (g.id === topGroupId) return { ...g, heightRatio: Math.max(0.1, nextTopRatio) };
          if (g.id === bottomGroupId) return { ...g, heightRatio: Math.max(0.1, nextBottomRatio) };
          return g;
        }),
      };
    });

  return {
    leftDocks: mapCols(layout.leftDocks),
    rightDocks: mapCols(layout.rightDocks),
  };
}

export function togglePanelInLayout(
  layout: WorkspaceLayout,
  panelId: DockPanelId
): WorkspaceLayout {
  const existing = findPanelLocation(layout, panelId);
  if (existing) {
    return removePanelFromLayout(layout, panelId);
  }
  const meta = DOCK_PANEL_META[panelId];
  const targetCols = meta.defaultSide === 'left' ? layout.leftDocks : layout.rightDocks;
  const preferredCol = targetCols.find(
    (c) => !(c.groups.length === 1 && c.groups[0].panelIds.length === 1 && c.groups[0].panelIds[0] === 'tools')
  );
  if (preferredCol && panelId !== 'tools') {
    return movePanelInLayout(layout, panelId, {
      side: meta.defaultSide,
      targetColId: preferredCol.id,
      insertGroupIndex: preferredCol.groups.length,
    });
  }
  return movePanelInLayout(layout, panelId, {
    side: meta.defaultSide,
    insertColumnIndex: meta.defaultSide === 'left' ? 0 : targetCols.length,
  });
}

function sanitizeColumns(raw: unknown, seenPanels: Set<DockPanelId>): DockColumn[] {
  if (!Array.isArray(raw)) return [];
  const result: DockColumn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const colId = typeof rec.id === 'string' && rec.id.trim() ? rec.id : makeUid('col');
    const collapsed = Boolean(rec.collapsed);
    const rawGroups = Array.isArray(rec.groups) ? rec.groups : [];
    const groups: DockGroup[] = [];
    for (const gItem of rawGroups) {
      if (!gItem || typeof gItem !== 'object') continue;
      const gRec = gItem as Record<string, unknown>;
      const rawPids = Array.isArray(gRec.panelIds) ? gRec.panelIds : [];
      const panelIds: DockPanelId[] = [];
      for (const pid of rawPids) {
        if (typeof pid === 'string' && VALID_PANEL_SET.has(pid)) {
          const typedPid = pid as DockPanelId;
          if (!seenPanels.has(typedPid)) {
            seenPanels.add(typedPid);
            panelIds.push(typedPid);
          }
        }
      }
      if (panelIds.length === 0) continue;
      const activePanelId =
        typeof gRec.activePanelId === 'string' && panelIds.includes(gRec.activePanelId as DockPanelId)
          ? (gRec.activePanelId as DockPanelId)
          : panelIds[0];
      const heightRatio =
        typeof gRec.heightRatio === 'number' && Number.isFinite(gRec.heightRatio) && gRec.heightRatio > 0
          ? gRec.heightRatio
          : 1;
      groups.push({
        id: typeof gRec.id === 'string' && gRec.id.trim() ? gRec.id : makeUid('grp'),
        panelIds,
        activePanelId,
        heightRatio,
      });
    }
    if (groups.length === 0) continue;
    const tentativeCol: DockColumn = { id: colId, width: 200, collapsed, groups };
    const { min, max } = getColumnWidthBounds(tentativeCol);
    const width =
      typeof rec.width === 'number' && Number.isFinite(rec.width)
        ? Math.max(min, Math.min(max, Math.round(rec.width)))
        : Math.max(min, Math.min(max, 200));
    result.push({ ...tentativeCol, width });
  }
  return pruneEmptyContainers(result);
}

export function sanitizeLayout(raw: unknown): WorkspaceLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const seen = new Set<DockPanelId>();
  const leftDocks = sanitizeColumns(rec.leftDocks, seen);
  const rightDocks = sanitizeColumns(rec.rightDocks, seen);
  if (leftDocks.length === 0 && rightDocks.length === 0) return null;
  return { leftDocks, rightDocks };
}

function sanitizeQuickAccessItems(raw: unknown): QuickAccessItem[] {
  if (!Array.isArray(raw)) return DEFAULT_QUICK_ACCESS_ITEMS.map((x) => ({ ...x }));
  const items: QuickAccessItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id.trim() ? r.id : makeUid('qa');
    const label = typeof r.label === 'string' && r.label.trim() ? r.label.slice(0, 48) : 'Action';
    if (r.kind === 'command' && typeof r.commandId === 'string' && VALID_COMMAND_SET.has(r.commandId)) {
      items.push({ id, kind: 'command', label, commandId: r.commandId as CommandActionId });
    } else if (r.kind === 'tool' && typeof r.toolId === 'string') {
      items.push({ id, kind: 'tool', label, toolId: r.toolId as QuickAccessItem['toolId'] });
    } else if (
      r.kind === 'color' &&
      typeof r.color === 'string' &&
      /^#[0-9a-fA-F]{3,6}$/.test(r.color)
    ) {
      items.push({ id, kind: 'color', label, color: r.color });
    } else if (r.kind === 'brush' && typeof r.brushPresetId === 'string' && r.brushPresetId.trim()) {
      items.push({ id, kind: 'brush', label, brushPresetId: r.brushPresetId });
    }
  }
  return items;
}

function sanitizeCommandBarIds(raw: unknown): CommandActionId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_COMMAND_BAR_IDS];
  const seen = new Set<CommandActionId>();
  const out: CommandActionId[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && VALID_COMMAND_SET.has(item)) {
      const id = item as CommandActionId;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

const AUTO_MIGRATED_PANELS: DockPanelId[] = ['info'];

function attachMigratedPanelToLayout(
  layout: WorkspaceLayout,
  panelId: DockPanelId
): WorkspaceLayout {
  if (findPanelLocation(layout, panelId)) return layout;
  const anchor =
    findPanelLocation(layout, 'navigator') ?? findPanelLocation(layout, 'sub-view');
  if (anchor) {
    const next = cloneLayout(layout);
    const cols = anchor.side === 'left' ? next.leftDocks : next.rightDocks;
    const col = cols.find((c) => c.id === anchor.colId);
    const grp = col?.groups.find((g) => g.id === anchor.groupId);
    if (grp && !grp.panelIds.includes(panelId)) {
      grp.panelIds.push(panelId);
      return next;
    }
  }
  return togglePanelInLayout(layout, panelId);
}

export function createDefaultPersistedWorkspace(): PersistedWorkspaceState {
  return {
    version: 1,
    activePreset: 'default-illustration',
    layout: cloneLayout(DEFAULT_ILLUSTRATION_LAYOUT),
    savedCustomLayout: null,
    quickAccessItems: DEFAULT_QUICK_ACCESS_ITEMS.map((x) => ({ ...x })),
    quickAccessViewMode: 'grid',
    commandBarIds: [...DEFAULT_COMMAND_BAR_IDS],
    showStatusBar: true,
    showDocumentTabs: true,
    showCommandBar: true,
    migratedPanels: [...AUTO_MIGRATED_PANELS],
  };
}

export function loadWorkspaceState(): PersistedWorkspaceState {
  const fallback = createDefaultPersistedWorkspace();
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return fallback;

    const validPresets: WorkspacePresetId[] = [
      'default-illustration',
      'manga-studio',
      'minimalist-tablet',
      'custom',
    ];
    const activePreset: WorkspacePresetId = validPresets.includes(parsed.activePreset as WorkspacePresetId)
      ? (parsed.activePreset as WorkspacePresetId)
      : 'default-illustration';

    const existingMigrated = new Set<DockPanelId>(
      Array.isArray(parsed.migratedPanels)
        ? parsed.migratedPanels.filter(
            (id): id is DockPanelId => typeof id === 'string' && VALID_PANEL_SET.has(id)
          )
        : []
    );

    let layout = sanitizeLayout(parsed.layout) ?? fallback.layout;
    let savedCustomLayout = sanitizeLayout(parsed.savedCustomLayout);
    for (const panelId of AUTO_MIGRATED_PANELS) {
      if (!existingMigrated.has(panelId)) {
        layout = attachMigratedPanelToLayout(layout, panelId);
        if (savedCustomLayout) {
          savedCustomLayout = attachMigratedPanelToLayout(savedCustomLayout, panelId);
        }
        existingMigrated.add(panelId);
      }
    }

    const quickAccessItems = sanitizeQuickAccessItems(parsed.quickAccessItems);
    const quickAccessViewMode: QuickAccessViewMode =
      parsed.quickAccessViewMode === 'list' ? 'list' : 'grid';
    const commandBarIds = sanitizeCommandBarIds(parsed.commandBarIds);

    return {
      version: 1,
      activePreset,
      layout,
      savedCustomLayout,
      quickAccessItems,
      quickAccessViewMode,
      commandBarIds,
      showStatusBar: typeof parsed.showStatusBar === 'boolean' ? parsed.showStatusBar : true,
      showDocumentTabs: typeof parsed.showDocumentTabs === 'boolean' ? parsed.showDocumentTabs : true,
      showCommandBar: typeof parsed.showCommandBar === 'boolean' ? parsed.showCommandBar : true,
      migratedPanels: Array.from(existingMigrated),
    };
  } catch {
    return fallback;
  }
}

export function saveWorkspaceState(state: PersistedWorkspaceState): void {
  safeLocalStorageSetItem(WORKSPACE_STORAGE_KEY, JSON.stringify(state), 'workspace layout');
}
