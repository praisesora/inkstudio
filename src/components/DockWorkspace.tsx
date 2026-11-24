import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronsLeft,
  ChevronsRight,
  Paintbrush,
  Sliders,
  CircleDot,
  Palette,
  Layers,
  History,
  Zap,
  Wrench,
  MoreHorizontal,
  ArrowLeftToLine,
  ArrowRightToLine,
  X,
  PanelLeft,
  PanelRight,
  Eye,
  Compass,
  Images,
  Info,
  Play,
  PinOff,
  Minus,
} from 'lucide-react';
import { CanvasColorMode, CspBrush } from '../types/editor';
import { ThemePreset } from '../types/settings';
import {
  DOCK_PANEL_META,
  DockColumn,
  DockGroup,
  DockPanelId,
  DockSide,
  WorkspaceLayout,
} from '../types/workspace';
import {
  CUSTOM_BRUSHES_CHANGED_EVENT,
  getCachedCustomBrushes,
  loadCustomBrushes,
  preloadTipImage,
} from '../utils/brushStorage';
import {
  DEFAULT_BRUSH_PRESET_ID,
  ERASER_PRESET_ID,
  getEffectiveBrushSettings,
  resetBrushSettingsToDefault,
} from '../utils/brushPresetManager';
import {
  toolStoreActions,
  useToolStore,
  useWorkspaceStore,
  workspaceStoreActions,
} from '../stores';
import { ToolStrip } from './ToolStrip';
import { SubToolList } from './SubToolList';
import { ToolPropertyInspector } from './ToolPropertyInspector';
import { BrushSizePalette } from './BrushSizePalette';
import { RightSidebar, RightSidebarColorSection, RightSidebarProps } from './RightSidebar';
import { QuickAccessPanel } from './QuickAccessPanel';
import { NavigatorPanel, NavigatorPanelProps } from './NavigatorPanel';
import { SubViewPanel } from './SubViewPanel';
import { InfoPanel } from './InfoPanel';
import { AutoActionPanel, AutoActionPanelProps } from './AutoActionPanel';
import { WorkspaceCommandHandlers } from './CommandBar';
import { FloatingPanelWindow, FLOATING_HEADER_HEIGHT } from './FloatingPanelWindow';

const DND_PANEL_MIME = 'application/x-inkstudio-panel';

export function renderPanelIcon(panelId: DockPanelId, className = 'w-3.5 h-3.5'): React.ReactNode {
  switch (panelId) {
    case 'tools':
      return <Wrench className={className} />;
    case 'subtool':
      return <Paintbrush className={className} />;
    case 'tool-property':
      return <Sliders className={className} />;
    case 'brush-size':
      return <CircleDot className={className} />;
    case 'navigator':
      return <Compass className={className} />;
    case 'sub-view':
      return <Images className={className} />;
    case 'info':
      return <Info className={className} />;
    case 'color':
      return <Palette className={className} />;
    case 'layers':
      return <Layers className={className} />;
    case 'history':
      return <History className={className} />;
    case 'quick-access':
      return <Zap className={className} />;
    case 'auto-actions':
      return <Play className={className} />;
  }
}

function useSharedCustomBrushes(): [CspBrush[], React.Dispatch<React.SetStateAction<CspBrush[]>>] {
  const [customBrushes, setCustomBrushes] = useState<CspBrush[]>(() => getCachedCustomBrushes());

  useEffect(() => {
    let active = true;
    loadCustomBrushes().then((brushes) => {
      if (!active) return;
      setCustomBrushes(brushes);
      for (const b of brushes) {
        if (b.tipDataUrl) preloadTipImage(b.tipDataUrl).catch(() => {});
        if (b.secondaryTipDataUrl) preloadTipImage(b.secondaryTipDataUrl).catch(() => {});
        if (b.subTips) {
          for (const st of b.subTips) {
            if (st.dataUrl) preloadTipImage(st.dataUrl).catch(() => {});
          }
        }
        if (b.paperTexture) preloadTipImage(b.paperTexture).catch(() => {});
      }
    });
    const handleChanged = () => setCustomBrushes([...getCachedCustomBrushes()]);
    window.addEventListener(CUSTOM_BRUSHES_CHANGED_EVENT, handleChanged);
    return () => {
      active = false;
      window.removeEventListener(CUSTOM_BRUSHES_CHANGED_EVENT, handleChanged);
    };
  }, []);

  return [customBrushes, setCustomBrushes];
}

/** Isolated BrushSizePalette wrapper so brush size changes never re-render dock chrome or layers */
const BrushSizeDockedContent: React.FC<{ themePreset: ThemePreset }> = React.memo(
  ({ themePreset }) => {
    const size = useToolStore((s) => s.brushSettings.size);
    const brushName = useToolStore((s) => s.brushSettings.brushName);
    const preset = useToolStore((s) => s.brushSettings.preset);
    const tool = useToolStore((s) => s.tool);

    const activePresetId =
      tool === 'eraser' ? ERASER_PRESET_ID : preset || DEFAULT_BRUSH_PRESET_ID;

    const handleSelectSize = useCallback((nextSize: number) => {
      toolStoreActions.updateBrushSettings({ size: nextSize });
    }, []);

    const handleResetSize = useCallback(() => {
      const defaults = getEffectiveBrushSettings(activePresetId);
      if (defaults.size !== undefined) {
        toolStoreActions.updateBrushSettings({ size: defaults.size });
      }
    }, [activePresetId]);

    const handleResetAll = useCallback(() => {
      const restored = resetBrushSettingsToDefault(activePresetId, getCachedCustomBrushes());
      toolStoreActions.updateBrushSettings(restored);
    }, [activePresetId]);

    return (
      <BrushSizePalette
        currentSize={size}
        onSelectSize={handleSelectSize}
        activeBrushName={brushName || (tool === 'eraser' ? 'Eraser' : String(preset || 'Brush'))}
        tool={tool}
        presetId={activePresetId}
        onResetSizeToDefault={handleResetSize}
        onResetAllSettings={handleResetAll}
        themePreset={themePreset}
      />
    );
  }
);
BrushSizeDockedContent.displayName = 'BrushSizeDockedContent';

export interface DockWorkspaceProps {
  themePreset: ThemePreset;
  colorMode: CanvasColorMode;
  commandHandlers: WorkspaceCommandHandlers;
  // Tool / selection callbacks
  onDeselect?: () => void;
  onTransformSelection?: () => void;
  onClearSelection?: () => void;
  onDeleteOutsideSelection?: () => void;
  onCutSelection?: () => void;
  onCopySelection?: () => void;
  onPasteSelection?: () => void;
  onMoveSelectionToNewLayer?: () => void;
  onExpandSelection?: (pixels: number) => void;
  onContractSelection?: (pixels: number) => void;
  onFeatherSelection?: (radius: number) => void;
  onInvertSelection?: () => void;
  onToggleTransparentColor?: () => void;
  // Layer & history props forwarded cleanly to RightSidebar docked panels
  layerSidebarProps: Omit<RightSidebarProps, 'width' | 'onWidthChange' | 'hideColorPanel' | 'dockedMode'>;
  // Navigator palette props
  navigatorProps?: Omit<NavigatorPanelProps, 'themePreset'>;
  // Auto Actions palette props
  autoActionProps?: AutoActionPanelProps;
  // Center canvas area (DocumentTabBar + CanvasArea + StatusBar)
  children: React.ReactNode;
}

interface DockGroupViewProps {
  side: DockSide;
  col: DockColumn;
  group: DockGroup;
  groupIndex?: number;
  themePreset: ThemePreset;
  draggingPanelId: DockPanelId | null;
  onStartDragPanel: (panelId: DockPanelId) => void;
  onEndDragPanel: () => void;
  onStartPointerTabDrag?: (
    e: React.PointerEvent<HTMLButtonElement>,
    panelId: DockPanelId,
    colId: string,
    groupId: string,
    groupPanelCount: number
  ) => void;
  renderPanelBody: (
    panelId: DockPanelId,
    containerWidth: number,
    containerHeight?: number
  ) => React.ReactNode;
}

export const DockGroupView: React.FC<DockGroupViewProps> = React.memo(({
  side,
  col,
  group,
  groupIndex = 0,
  themePreset: _themePreset,
  draggingPanelId,
  onStartDragPanel,
  onEndDragPanel,
  onStartPointerTabDrag,
  renderPanelBody,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [isDragOverTab, setIsDragOverTab] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerBtnRef = useRef<HTMLButtonElement>(null);
  const portalMenuRef = useRef<HTMLDivElement>(null);
  const groupRootRef = useRef<HTMLDivElement>(null);

  const computeMenuPosition = useCallback(() => {
    const btn = triggerBtnRef.current;
    if (!btn || typeof window === 'undefined') return null;
    const rect = btn.getBoundingClientRect();
    const menuWidth = 184;
    const estMenuHeight = 196;
    const pad = 8;

    // Right-align to the button on the right dock; on the left dock prefer extending rightwards
    // out from the button (above the canvas) while clamping cleanly inside the viewport.
    let left = side === 'left' ? rect.left : rect.right - menuWidth;
    if (left + menuWidth > window.innerWidth - pad) {
      left = rect.right - menuWidth;
    }
    left = Math.max(pad, Math.min(window.innerWidth - menuWidth - pad, left));

    let top = rect.bottom + 4;
    if (top + estMenuHeight > window.innerHeight - pad && rect.top - estMenuHeight - 4 >= pad) {
      top = rect.top - estMenuHeight - 4;
    } else {
      top = Math.max(pad, Math.min(window.innerHeight - estMenuHeight - pad, top));
    }

    return { top, left };
  }, [side]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current?.contains(target) ||
        portalMenuRef.current?.contains(target)
      ) {
        return;
      }
      setMenuOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const handleReposition = () => {
      const next = computeMenuPosition();
      if (next) setMenuPos(next);
      else setMenuOpen(false);
    };
    window.addEventListener('mousedown', handleOutside);
    window.addEventListener('keydown', handleKey);
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      window.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [menuOpen, computeMenuPosition]);

  const activePanelId = group.panelIds.includes(group.activePanelId)
    ? group.activePanelId
    : group.panelIds[0];

  const isCollapsed = Boolean(group.collapsed);
  const isCompactToolOnly =
    col.width <= 64 && group.panelIds.length === 1 && group.panelIds[0] === 'tools';

  const handleDetachActivePanel = useCallback(() => {
    const rect = groupRootRef.current?.getBoundingClientRect();
    const meta = DOCK_PANEL_META[activePanelId];
    if (rect && typeof window !== 'undefined') {
      const offsetX = side === 'left' ? rect.right + 16 : rect.left - meta.defaultFloatWidth - 16;
      workspaceStoreActions.detachPanel(activePanelId, {
        x: offsetX,
        y: Math.max(44, rect.top),
      });
    } else {
      workspaceStoreActions.detachPanel(activePanelId);
    }
  }, [activePanelId, side]);

  const handleDropOnTabs = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOverTab(false);
    const rawId =
      (e.dataTransfer.getData(DND_PANEL_MIME) as DockPanelId) ||
      (e.dataTransfer.getData('text/plain') as DockPanelId) ||
      draggingPanelId;
    if (rawId && DOCK_PANEL_META[rawId]) {
      workspaceStoreActions.movePanel(rawId, {
        side,
        targetColId: col.id,
        targetGroupId: group.id,
      });
    }
    onEndDragPanel();
  };

  return (
    <div
      ref={groupRootRef}
      data-testid={`dock-group-${group.id}`}
      data-collapsed={String(isCollapsed)}
      data-drop-group={`${side}|${col.id}|${group.id}|${groupIndex}`}
      style={
        isCollapsed
          ? { flexGrow: 0, flexBasis: 'auto' }
          : { flexGrow: group.heightRatio, flexBasis: 0 }
      }
      className={`flex flex-col overflow-hidden bg-[#202020] ${
        isCollapsed ? 'shrink-0' : 'min-h-[72px]'
      }`}
    >
      {/* Palette Tab Header Bar (Draggable to dock or detach!) */}
      <div
        data-drop-tab-bar={`${side}|${col.id}|${group.id}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setIsDragOverTab(true);
        }}
        onDragLeave={() => setIsDragOverTab(false)}
        onDrop={handleDropOnTabs}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement)?.closest?.('button')) return;
          workspaceStoreActions.toggleGroupCollapsed(col.id, group.id);
        }}
        className={`h-6 flex items-center justify-between px-1 shrink-0 select-none relative transition-colors ${
          isDragOverTab
            ? 'bg-[var(--accent-subtle)] ring-1 ring-inset ring-[var(--accent)]'
            : 'bg-[#1a1a1a] border-b border-white/[0.06]'
        }`}
      >
        <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto no-scrollbar h-full">
          {group.panelIds.map((pid) => {
            const meta = DOCK_PANEL_META[pid];
            const isActive = pid === activePanelId;
            return (
              <button
                key={pid}
                type="button"
                draggable={!onStartPointerTabDrag}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  onStartPointerTabDrag?.(e, pid, col.id, group.id, group.panelIds.length);
                }}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DND_PANEL_MIME, pid);
                  e.dataTransfer.setData('text/plain', pid);
                  e.dataTransfer.effectAllowed = 'move';
                  onStartDragPanel(pid);
                }}
                onDragEnd={onEndDragPanel}
                onClick={() => workspaceStoreActions.setGroupActivePanel(col.id, group.id, pid)}
                data-testid={`dock-tab-${pid}`}
                title={`${meta.title} — Drag tab to move or detach palette`}
                className={`h-5 ${isCompactToolOnly ? 'px-1' : 'px-1.5'} rounded-sm flex items-center gap-1 text-[10px] transition-colors shrink-0 cursor-grab active:cursor-grabbing ${
                  isActive
                    ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#262626]'
                }`}
              >
                {renderPanelIcon(pid, 'w-3 h-3 shrink-0')}
                {!isCompactToolOnly && (
                  <span className="truncate max-w-[84px]">
                    {group.panelIds.length > 1 ? meta.shortTitle : meta.title}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Upper-right Palette Controls: Compact Tool Detach OR Detach + Minimize (-) + Options Menu */}
        {isCompactToolOnly ? (
          <button
            type="button"
            data-testid="dock-detach-btn-tools"
            onClick={handleDetachActivePanel}
            title="Detach & Float Tool Panel"
            aria-label="Detach Tool panel"
            className="w-4 h-4 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer shrink-0"
          >
            <PinOff className="w-2.5 h-2.5" />
          </button>
        ) : (
          <div className="flex items-center gap-0.5 shrink-0" ref={menuRef}>
            <button
              type="button"
              data-testid={`dock-detach-btn-${activePanelId}`}
              onClick={handleDetachActivePanel}
              title="Detach & Float Palette"
              aria-label={`Detach ${DOCK_PANEL_META[activePanelId].title}`}
              className="w-4 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
            >
              <PinOff className="w-2.5 h-2.5" />
            </button>

            <button
              type="button"
              data-testid={`dock-collapse-group-btn-${activePanelId}`}
              onClick={() => workspaceStoreActions.toggleGroupCollapsed(col.id, group.id)}
              title={isCollapsed ? 'Expand Panel' : 'Hide / Collapse Panel'}
              aria-label={
                isCollapsed
                  ? `Expand ${DOCK_PANEL_META[activePanelId].title}`
                  : `Hide ${DOCK_PANEL_META[activePanelId].title}`
              }
              aria-expanded={!isCollapsed}
              className={`w-4 h-5 rounded flex items-center justify-center cursor-pointer transition-colors ${
                isCollapsed
                  ? 'text-[var(--accent)] bg-[#2c2c2c]'
                  : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
              }`}
            >
              <Minus className="w-2.5 h-2.5" />
            </button>

            <button
              ref={triggerBtnRef}
              type="button"
              onClick={() => {
                setMenuOpen((prev) => {
                  if (!prev) {
                    setMenuPos(computeMenuPosition());
                    return true;
                  }
                  return false;
                });
              }}
              data-testid={`dock-menu-btn-${activePanelId}`}
              title="Palette Dock Options"
              className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
            >
              <MoreHorizontal className="w-3 h-3" />
            </button>

            {menuOpen &&
              typeof document !== 'undefined' &&
              createPortal(
                <div
                  ref={portalMenuRef}
                  data-testid={`dock-menu-popover-${activePanelId}`}
                  style={{
                    position: 'fixed',
                    top: menuPos?.top ?? 0,
                    left: menuPos?.left ?? 0,
                  }}
                  className="w-48 rounded-md shadow-2xl p-1 z-[1000] text-[11px] bg-[#202020] border border-white/[0.1] text-[#e5e5e5]"
                >
                  <div className="px-2 py-0.5 text-[10px] text-[#8a8a8a] truncate">
                    {DOCK_PANEL_META[activePanelId].title}
                  </div>
                  <div className="my-0.5 h-px bg-white/[0.08]" />

                  <button
                    type="button"
                    data-testid={`detach-float-${activePanelId}`}
                    onClick={() => {
                      handleDetachActivePanel();
                      setMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer text-left"
                  >
                    <PinOff className="w-3 h-3 text-[var(--accent)]" />
                    <span>Detach &amp; Float Palette</span>
                  </button>

                  {side === 'right' ? (
                    <button
                      type="button"
                      data-testid={`move-to-left-${activePanelId}`}
                      onClick={() => {
                        workspaceStoreActions.movePanel(activePanelId, { side: 'left' });
                        setMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer text-left"
                    >
                      <ArrowLeftToLine className="w-3 h-3 text-[var(--accent)]" />
                      <span>Move to Left Dock</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid={`move-to-right-${activePanelId}`}
                      onClick={() => {
                        workspaceStoreActions.movePanel(activePanelId, { side: 'right' });
                        setMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer text-left"
                    >
                      <ArrowRightToLine className="w-3 h-3 text-[var(--accent)]" />
                      <span>Move to Right Dock</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      workspaceStoreActions.movePanel(activePanelId, { side });
                      setMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer text-left"
                  >
                    {side === 'left' ? (
                      <PanelLeft className="w-3 h-3 text-[#8a8a8a]" />
                    ) : (
                      <PanelRight className="w-3 h-3 text-[#8a8a8a]" />
                    )}
                    <span>Move to New Column</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      workspaceStoreActions.toggleColumnCollapsed(col.id, true);
                      setMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer text-left"
                  >
                    {side === 'left' ? (
                      <ChevronsLeft className="w-3 h-3 text-[#8a8a8a]" />
                    ) : (
                      <ChevronsRight className="w-3 h-3 text-[#8a8a8a]" />
                    )}
                    <span>Collapse Dock Strip</span>
                  </button>

                  <div className="my-0.5 h-px bg-white/[0.08]" />

                  <button
                    type="button"
                    onClick={() => {
                      workspaceStoreActions.togglePanelVisibility(activePanelId);
                      setMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[#2c2c2c] text-rose-400 cursor-pointer text-left"
                  >
                    <X className="w-3 h-3" />
                    <span>Close Palette</span>
                  </button>
                </div>,
                document.body
              )}
          </div>
        )}
      </div>

      {/* Active Panel Content (hidden when collapsed via "-") */}
      {!isCollapsed && (
        <div
          data-testid={`dock-group-body-${activePanelId}`}
          className="flex-1 min-h-0 overflow-hidden flex flex-col"
        >
          {renderPanelBody(activePanelId, col.width)}
        </div>
      )}
    </div>
  );
});
DockGroupView.displayName = 'DockGroupView';

interface DockColumnViewProps {
  side: DockSide;
  col: DockColumn;
  colIndex: number;
  themePreset: ThemePreset;
  draggingPanelId: DockPanelId | null;
  onStartDragPanel: (panelId: DockPanelId) => void;
  onEndDragPanel: () => void;
  onStartPointerTabDrag: (
    e: React.PointerEvent<HTMLButtonElement>,
    panelId: DockPanelId,
    colId: string,
    groupId: string,
    groupPanelCount: number
  ) => void;
  renderPanelBody: (
    panelId: DockPanelId,
    containerWidth: number,
    containerHeight?: number
  ) => React.ReactNode;
}

const DockColumnView: React.FC<DockColumnViewProps> = React.memo(({
  side,
  col,
  colIndex,
  themePreset,
  draggingPanelId,
  onStartDragPanel,
  onEndDragPanel,
  onStartPointerTabDrag,
  renderPanelBody,
}) => {
  const openPopover = useWorkspaceStore((s) => s.openPopover);
  const colRef = useRef<HTMLDivElement>(null);
  const [dragOverSplitIdx, setDragOverSplitIdx] = useState<number | null>(null);

  const activePopoverPanelId =
    col.collapsed && openPopover?.colId === col.id ? openPopover.panelId : null;

  const handleStartColumnResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = col.width;
    const handleMove = (ev: PointerEvent) => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
      workspaceStoreActions.resizeColumn(col.id, startWidth + delta);
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  const handleStartGroupSplitResize = (
    e: React.PointerEvent,
    topGroup: DockGroup,
    bottomGroup: DockGroup
  ) => {
    e.preventDefault();
    const colEl = colRef.current;
    if (!colEl) return;
    const totalHeight = Math.max(120, colEl.getBoundingClientRect().height);
    const totalRatioSum = col.groups.reduce((acc, g) => acc + g.heightRatio, 0) || 1;
    const pairSum = topGroup.heightRatio + bottomGroup.heightRatio;
    const startY = e.clientY;
    const startTopRatio = topGroup.heightRatio;

    const handleMove = (ev: PointerEvent) => {
      const deltaRatio = ((ev.clientY - startY) / totalHeight) * totalRatioSum;
      const minRatio = Math.min(0.15 * totalRatioSum, pairSum * 0.25);
      const nextTop = Math.max(minRatio, Math.min(pairSum - minRatio, startTopRatio + deltaRatio));
      const nextBottom = pairSum - nextTop;
      workspaceStoreActions.resizeGroupSplit(
        col.id,
        topGroup.id,
        bottomGroup.id,
        nextTop,
        nextBottom
      );
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  const handleDropNewGroup = (e: React.DragEvent, insertIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverSplitIdx(null);
    const rawId =
      (e.dataTransfer.getData(DND_PANEL_MIME) as DockPanelId) ||
      (e.dataTransfer.getData('text/plain') as DockPanelId) ||
      draggingPanelId;
    if (rawId && DOCK_PANEL_META[rawId]) {
      workspaceStoreActions.movePanel(rawId, {
        side,
        targetColId: col.id,
        insertGroupIndex: insertIndex,
      });
    }
    onEndDragPanel();
  };

  // Collapsed CSP Tab Strip mode
  if (col.collapsed) {
    const allPanelIds = col.groups.flatMap((g) => g.panelIds);
    const popoverWidth = Math.max(204, col.width);
    const firstGroupId = col.groups[0]?.id ?? '';

    return (
      <div
        data-testid={`dock-column-${col.id}`}
        data-collapsed="true"
        data-drop-collapsed-col={`${side}|${col.id}|${firstGroupId}`}
        className="relative w-[30px] h-full flex flex-col items-center py-1 gap-1 shrink-0 select-none z-20 bg-[#1c1c1c] border-x border-white/[0.04]"
      >
        {/* Expand Column Button */}
        <button
          type="button"
          onClick={() => workspaceStoreActions.toggleColumnCollapsed(col.id, false)}
          data-testid={`dock-expand-${col.id}`}
          title="Expand Dock Column"
          className="w-6 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer shrink-0"
        >
          {side === 'left' ? (
            <ChevronsRight className="w-3.5 h-3.5" />
          ) : (
            <ChevronsLeft className="w-3.5 h-3.5" />
          )}
        </button>

        <div className="w-4 h-px bg-white/[0.08] shrink-0" />

        {/* Vertical Icon Tab Strip */}
        <div className="flex flex-col items-center gap-1 flex-1 overflow-y-auto no-scrollbar w-full px-0.5">
          {allPanelIds.map((pid) => {
            const meta = DOCK_PANEL_META[pid];
            const isOpen = activePopoverPanelId === pid;
            const ownerGrp = col.groups.find((g) => g.panelIds.includes(pid));
            return (
              <button
                key={pid}
                type="button"
                onPointerDown={(e) => {
                  if (e.button !== 0 || !ownerGrp) return;
                  onStartPointerTabDrag(e, pid, col.id, ownerGrp.id, ownerGrp.panelIds.length);
                }}
                onClick={() => workspaceStoreActions.togglePopover(col.id, pid)}
                data-testid={`collapsed-tab-${pid}`}
                title={`${meta.title} (Click to pop out, drag to move or detach)`}
                aria-pressed={isOpen}
                className={`relative w-6 h-7 rounded flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                  isOpen
                    ? 'bg-[#2c2c2c] text-[var(--accent)]'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                }`}
              >
                {isOpen && (
                  <span
                    className={`absolute top-1 bottom-1 w-[2px] rounded-full ${
                      side === 'left' ? 'left-0' : 'right-0'
                    }`}
                    style={{ backgroundColor: 'var(--accent)' }}
                  />
                )}
                {renderPanelIcon(pid, 'w-3.5 h-3.5')}
              </button>
            );
          })}
        </div>

        {/* CSP Pop-out Floating Palette Popover */}
        {activePopoverPanelId && (
          <div
            data-testid={`dock-popover-${activePopoverPanelId}`}
            style={{ width: popoverWidth }}
            className={`absolute top-1 bottom-1 z-40 flex flex-col rounded-md shadow-[0_12px_36px_rgba(0,0,0,0.75)] overflow-hidden bg-[#202020] border border-white/[0.12] ${
              side === 'left' ? 'left-[32px]' : 'right-[32px]'
            }`}
          >
            <div className="h-7 px-2 flex items-center justify-between shrink-0 bg-[#1a1a1a] border-b border-white/[0.08]">
              <div className="flex items-center gap-1.5 min-w-0">
                {renderPanelIcon(activePopoverPanelId, 'w-3.5 h-3.5 text-[var(--accent)]')}
                <span className="text-[11px] font-medium text-[#e5e5e5] truncate">
                  {DOCK_PANEL_META[activePopoverPanelId].title}
                </span>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  onClick={() => workspaceStoreActions.detachPanel(activePopoverPanelId)}
                  title="Detach & Float Palette"
                  className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-white hover:bg-[#2c2c2c] cursor-pointer"
                >
                  <PinOff className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => workspaceStoreActions.toggleColumnCollapsed(col.id, false)}
                  title="Expand & Pin Column"
                  className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-white hover:bg-[#2c2c2c] cursor-pointer"
                >
                  {side === 'left' ? (
                    <ChevronsRight className="w-3 h-3" />
                  ) : (
                    <ChevronsLeft className="w-3 h-3" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => workspaceStoreActions.closePopover()}
                  title="Dismiss Popover (Esc)"
                  className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-white hover:bg-[#2c2c2c] cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
              {renderPanelBody(activePopoverPanelId, popoverWidth)}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Expanded Dock Column mode
  return (
    <div
      ref={colRef}
      data-testid={`dock-column-${col.id}`}
      data-collapsed="false"
      data-drop-col={`${side}|${col.id}|${colIndex}`}
      style={{ width: col.width }}
      className="relative h-full flex flex-col shrink-0 overflow-hidden z-10 bg-[#161616]"
    >
      {/* Slim CSP Column Collapse Bar */}
      <div
        className={`h-4 px-1 flex items-center shrink-0 bg-[#181818] border-b border-white/[0.04] ${
          side === 'left' ? 'justify-end' : 'justify-start'
        }`}
      >
        <button
          type="button"
          onClick={() => workspaceStoreActions.toggleColumnCollapsed(col.id, true)}
          data-testid={`dock-collapse-${col.id}`}
          title="Collapse Dock Column to Icon Strip"
          className="h-3.5 px-1 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
        >
          {side === 'left' ? (
            <ChevronsLeft className="w-3 h-3" />
          ) : (
            <ChevronsRight className="w-3 h-3" />
          )}
        </button>
      </div>

      {/* Stacked Palette Groups with Horizontal Splitters */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {col.groups.map((grp, idx) => (
          <React.Fragment key={grp.id}>
            {draggingPanelId && (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverSplitIdx(idx);
                }}
                onDragLeave={() => setDragOverSplitIdx(null)}
                onDrop={(e) => handleDropNewGroup(e, idx)}
                className={`h-1.5 shrink-0 transition-all ${
                  dragOverSplitIdx === idx ? 'h-3 bg-[var(--accent)]/40' : 'bg-transparent'
                }`}
              />
            )}

            <DockGroupView
              side={side}
              col={col}
              group={grp}
              groupIndex={idx}
              themePreset={themePreset}
              draggingPanelId={draggingPanelId}
              onStartDragPanel={onStartDragPanel}
              onEndDragPanel={onEndDragPanel}
              onStartPointerTabDrag={onStartPointerTabDrag}
              renderPanelBody={renderPanelBody}
            />

            {idx < col.groups.length - 1 && (
              <div
                onPointerDown={(e) => handleStartGroupSplitResize(e, grp, col.groups[idx + 1])}
                title="Drag to resize stacked palettes"
                className="h-1 shrink-0 cursor-row-resize transition-colors bg-[#161616] hover:bg-[var(--accent)]/50"
              />
            )}
          </React.Fragment>
        ))}

        {/* Bottom drop zone for stacking a dragged palette at the bottom of this column */}
        {draggingPanelId && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOverSplitIdx(col.groups.length);
            }}
            onDragLeave={() => setDragOverSplitIdx(null)}
            onDrop={(e) => handleDropNewGroup(e, col.groups.length)}
            className={`h-2 shrink-0 transition-all ${
              dragOverSplitIdx === col.groups.length
                ? 'h-5 bg-[var(--accent)]/40 border-t border-[var(--accent)]'
                : 'bg-transparent'
            }`}
          />
        )}
      </div>

      {/* Vertical Column Resize Splitter */}
      <div
        onPointerDown={handleStartColumnResize}
        title="Drag to resize dock column"
        className={`absolute top-0 bottom-0 w-1 cursor-col-resize transition-colors z-30 ${
          side === 'left' ? 'right-0' : 'left-0'
        } hover:bg-[var(--accent)]/50`}
      />
    </div>
  );
});
DockColumnView.displayName = 'DockColumnView';

interface PreviewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type DockDropTarget =
  | {
      kind: 'dock-tab';
      side: DockSide;
      targetColId: string;
      targetGroupId: string;
      previewRect: PreviewRect;
      label: string;
    }
  | {
      kind: 'dock-split';
      side: DockSide;
      targetColId: string;
      insertGroupIndex: number;
      previewRect: PreviewRect;
      label: string;
    }
  | {
      kind: 'dock-column';
      side: DockSide;
      insertColumnIndex: number;
      previewRect: PreviewRect;
      label: string;
    }
  | {
      kind: 'floating-tab';
      targetFloatingId: string;
      previewRect: PreviewRect;
      label: string;
    }
  | {
      kind: 'self-noop';
    };

interface PointerDragSource {
  kind: 'docked-tab' | 'floating-window' | 'floating-tab';
  panelId: DockPanelId;
  sourceFloatingId?: string;
  sourceColId?: string;
  sourceGroupId?: string;
  sourceGroupPanelCount?: number;
}

interface ActivePointerDragUi {
  source: PointerDragSource;
  pointerX: number;
  pointerY: number;
  dropTarget: DockDropTarget | null;
}

function detectDockDropTarget(
  clientX: number,
  clientY: number,
  workspaceEl: HTMLDivElement | null,
  leftDockEl: HTMLDivElement | null,
  rightDockEl: HTMLDivElement | null,
  layout: WorkspaceLayout,
  source: PointerDragSource
): DockDropTarget | null {
  if (typeof document === 'undefined') return null;

  // 1. Check other floating panel headers (merge as tab into another floating panel)
  const floatingHeaders = Array.from(
    document.querySelectorAll<HTMLElement>('[data-drop-floating-header]')
  );
  let bestFloatingMatch: { id: string; z: number; rect: DOMRect } | null = null;
  for (const el of floatingHeaders) {
    const fId = el.getAttribute('data-drop-floating-header');
    if (!fId || fId === source.sourceFloatingId) continue;
    const rect = el.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top - 4 &&
      clientY <= rect.bottom + 6
    ) {
      const fp = (layout.floatingPanels ?? []).find((p) => p.id === fId);
      const z = fp?.zIndex ?? 0;
      if (!bestFloatingMatch || z >= bestFloatingMatch.z) {
        bestFloatingMatch = { id: fId, z, rect };
      }
    }
  }
  if (bestFloatingMatch) {
    const targetFp = (layout.floatingPanels ?? []).find((p) => p.id === bestFloatingMatch!.id);
    const title = targetFp ? DOCK_PANEL_META[targetFp.activePanelId].title : 'Panel';
    return {
      kind: 'floating-tab',
      targetFloatingId: bestFloatingMatch.id,
      previewRect: {
        left: bestFloatingMatch.rect.left,
        top: bestFloatingMatch.rect.top,
        width: bestFloatingMatch.rect.width,
        height: bestFloatingMatch.rect.height,
      },
      label: `Group with ${title}`,
    };
  }

  if (!workspaceEl) return null;
  const wsRect = workspaceEl.getBoundingClientRect();
  if (clientY < wsRect.top - 12 || clientY > wsRect.bottom + 12) return null;

  // 2. Extreme outer workspace left / right edges -> create outermost dock column
  const outerEdgeWidth = 22;
  if (clientX >= wsRect.left - 8 && clientX <= wsRect.left + outerEdgeWidth) {
    return {
      kind: 'dock-column',
      side: 'left',
      insertColumnIndex: 0,
      previewRect: {
        left: wsRect.left + 2,
        top: wsRect.top + 4,
        width: 28,
        height: Math.max(40, wsRect.height - 8),
      },
      label: 'Dock Left Edge',
    };
  }
  if (clientX <= wsRect.right + 8 && clientX >= wsRect.right - outerEdgeWidth) {
    return {
      kind: 'dock-column',
      side: 'right',
      insertColumnIndex: layout.rightDocks.length,
      previewRect: {
        left: wsRect.right - 30,
        top: wsRect.top + 4,
        width: 28,
        height: Math.max(40, wsRect.height - 8),
      },
      label: 'Dock Right Edge',
    };
  }

  // 3. Collapsed dock column strips
  const collapsedCols = Array.from(
    workspaceEl.querySelectorAll<HTMLElement>('[data-drop-collapsed-col]')
  );
  for (const el of collapsedCols) {
    const rect = el.getBoundingClientRect();
    if (
      clientX >= rect.left - 6 &&
      clientX <= rect.right + 6 &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      const raw = el.getAttribute('data-drop-collapsed-col') || '';
      const [sideStr, colId, firstGroupId] = raw.split('|');
      if ((sideStr === 'left' || sideStr === 'right') && colId && firstGroupId) {
        return {
          kind: 'dock-tab',
          side: sideStr,
          targetColId: colId,
          targetGroupId: firstGroupId,
          previewRect: {
            left: rect.left,
            top: rect.top + 2,
            width: rect.width,
            height: Math.max(40, rect.height - 4),
          },
          label: 'Dock to Strip',
        };
      }
    }
  }

  // 4. Column seams for inserting a new column between existing columns
  const expandedCols = Array.from(workspaceEl.querySelectorAll<HTMLElement>('[data-drop-col]'));
  for (const el of expandedCols) {
    const rect = el.getBoundingClientRect();
    if (clientY < rect.top || clientY > rect.bottom) continue;
    const raw = el.getAttribute('data-drop-col') || '';
    const [sideStr, , idxStr] = raw.split('|');
    const colIdx = parseInt(idxStr, 10);
    if ((sideStr !== 'left' && sideStr !== 'right') || isNaN(colIdx)) continue;

    if (sideStr === 'left' && Math.abs(clientX - rect.right) <= 8) {
      return {
        kind: 'dock-column',
        side: 'left',
        insertColumnIndex: colIdx + 1,
        previewRect: {
          left: rect.right - 5,
          top: rect.top + 4,
          width: 10,
          height: Math.max(40, rect.height - 8),
        },
        label: 'New Left Column',
      };
    }
    if (sideStr === 'right' && Math.abs(clientX - rect.left) <= 8) {
      return {
        kind: 'dock-column',
        side: 'right',
        insertColumnIndex: colIdx,
        previewRect: {
          left: rect.left - 5,
          top: rect.top + 4,
          width: 10,
          height: Math.max(40, rect.height - 8),
        },
        label: 'New Right Column',
      };
    }
  }

  // 5. Expanded dock groups (tab bar / top stack / bottom stack / center merge as tab)
  const groups = Array.from(workspaceEl.querySelectorAll<HTMLElement>('[data-drop-group]'));
  for (const el of groups) {
    const rect = el.getBoundingClientRect();
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      const raw = el.getAttribute('data-drop-group') || '';
      const [sideStr, colId, groupId, idxStr] = raw.split('|');
      const groupIdx = parseInt(idxStr, 10);
      if ((sideStr !== 'left' && sideStr !== 'right') || !colId || !groupId || isNaN(groupIdx)) {
        continue;
      }

      // If dragging the sole panel of this group over itself, keep docked (avoid accidental self-detach)
      if (
        source.kind === 'docked-tab' &&
        source.sourceGroupId === groupId &&
        source.sourceGroupPanelCount === 1
      ) {
        return { kind: 'self-noop' };
      }

      const relY = (clientY - rect.top) / Math.max(1, rect.height);
      const isOverHeader = clientY <= rect.top + 26;
      if (isOverHeader) {
        return {
          kind: 'dock-tab',
          side: sideStr,
          targetColId: colId,
          targetGroupId: groupId,
          previewRect: {
            left: rect.left + 1,
            top: rect.top + 1,
            width: Math.max(24, rect.width - 2),
            height: 24,
          },
          label: 'Add as Tab',
        };
      }
      if (relY < 0.28) {
        return {
          kind: 'dock-split',
          side: sideStr,
          targetColId: colId,
          insertGroupIndex: groupIdx,
          previewRect: {
            left: rect.left + 2,
            top: rect.top + 2,
            width: Math.max(24, rect.width - 4),
            height: Math.max(18, Math.min(44, rect.height * 0.28)),
          },
          label: 'Stack Above',
        };
      }
      if (relY > 0.72) {
        return {
          kind: 'dock-split',
          side: sideStr,
          targetColId: colId,
          insertGroupIndex: groupIdx + 1,
          previewRect: {
            left: rect.left + 2,
            top: rect.bottom - Math.max(18, Math.min(44, rect.height * 0.28)) - 2,
            width: Math.max(24, rect.width - 4),
            height: Math.max(18, Math.min(44, rect.height * 0.28)),
          },
          label: 'Stack Below',
        };
      }
      return {
        kind: 'dock-tab',
        side: sideStr,
        targetColId: colId,
        targetGroupId: groupId,
        previewRect: {
          left: rect.left + 2,
          top: rect.top + 2,
          width: Math.max(24, rect.width - 4),
          height: Math.max(24, rect.height - 4),
        },
        label: 'Add as Tab',
      };
    }
  }

  // 6. Inner dock zone edges (beside left dock / right dock into canvas) -> new column
  if (leftDockEl && layout.leftDocks.length > 0) {
    const ldRect = leftDockEl.getBoundingClientRect();
    if (clientX > ldRect.right && clientX <= ldRect.right + 26) {
      return {
        kind: 'dock-column',
        side: 'left',
        insertColumnIndex: layout.leftDocks.length,
        previewRect: {
          left: ldRect.right + 2,
          top: wsRect.top + 4,
          width: 24,
          height: Math.max(40, wsRect.height - 8),
        },
        label: 'New Left Column',
      };
    }
  }
  if (rightDockEl && layout.rightDocks.length > 0) {
    const rdRect = rightDockEl.getBoundingClientRect();
    if (clientX < rdRect.left && clientX >= rdRect.left - 26) {
      return {
        kind: 'dock-column',
        side: 'right',
        insertColumnIndex: 0,
        previewRect: {
          left: rdRect.left - 26,
          top: wsRect.top + 4,
          width: 24,
          height: Math.max(40, wsRect.height - 8),
        },
        label: 'New Right Column',
      };
    }
  }

  return null;
}

export const DockWorkspace: React.FC<DockWorkspaceProps> = React.memo(({
  themePreset,
  colorMode,
  commandHandlers,
  onDeselect,
  onTransformSelection,
  onClearSelection,
  onDeleteOutsideSelection,
  onCutSelection,
  onCopySelection,
  onPasteSelection,
  onMoveSelectionToNewLayer,
  onExpandSelection,
  onContractSelection,
  onFeatherSelection,
  onInvertSelection,
  onToggleTransparentColor,
  layerSidebarProps,
  navigatorProps,
  autoActionProps,
  children,
}) => {
  const layout = useWorkspaceStore((s) => s.layout);
  const palettesHidden = useWorkspaceStore((s) => s.palettesHidden);
  const openPopover = useWorkspaceStore((s) => s.openPopover);

  const [customBrushes, setCustomBrushes] = useSharedCustomBrushes();
  const [draggingPanelId, setDraggingPanelId] = useState<DockPanelId | null>(null);
  const [edgeDropSide, setEdgeDropSide] = useState<DockSide | null>(null);
  const [pointerDragUi, setPointerDragUi] = useState<ActivePointerDragUi | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const leftDockRef = useRef<HTMLDivElement>(null);
  const rightDockRef = useRef<HTMLDivElement>(null);

  const floatingPanels = layout.floatingPanels ?? [];

  // Close collapsed-strip popover on Escape
  useEffect(() => {
    if (!openPopover) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') workspaceStoreActions.closePopover();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [openPopover]);

  // Keep all floating panels safely inside the viewport when the window resizes
  useEffect(() => {
    if (floatingPanels.length === 0) return;
    const handleResize = () => {
      const fps = useWorkspaceStore.getState().layout.floatingPanels ?? [];
      for (const fp of fps) {
        workspaceStoreActions.moveFloatingPanel(fp.id, fp.x, fp.y, false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [floatingPanels.length]);

  const handleStartDragPanel = useCallback((panelId: DockPanelId) => {
    setDraggingPanelId(panelId);
  }, []);

  const handleEndDragPanel = useCallback(() => {
    setDraggingPanelId(null);
    setEdgeDropSide(null);
  }, []);

  // Unified pointer drag: drag any docked tab (or tab from a multi-tab floating panel)
  // to another dock location, another floating panel, or onto the open screen to detach & float!
  const startTabPointerDrag = useCallback(
    (
      e: React.PointerEvent<HTMLButtonElement>,
      panelId: DockPanelId,
      source: PointerDragSource
    ) => {
      if (e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      let active = false;
      let latestTarget: DockDropTarget | null = null;

      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKeyDown);
        setPointerDragUi(null);
      };

      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape' && active) {
          ev.preventDefault();
          cleanup();
        }
      };

      const onMove = (ev: PointerEvent) => {
        const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (!active) {
          if (dist < 6) return;
          active = true;
        }
        const currentLayout = useWorkspaceStore.getState().layout;
        latestTarget = detectDockDropTarget(
          ev.clientX,
          ev.clientY,
          workspaceRef.current,
          leftDockRef.current,
          rightDockRef.current,
          currentLayout,
          source
        );
        setPointerDragUi({
          source,
          pointerX: ev.clientX,
          pointerY: ev.clientY,
          dropTarget: latestTarget,
        });
      };

      const onCancel = () => {
        cleanup();
      };

      const onUp = (ev: PointerEvent) => {
        const wasActive = active;
        const finalTarget = latestTarget;
        cleanup();
        if (!wasActive) return;

        if (!finalTarget) {
          const meta = DOCK_PANEL_META[panelId];
          workspaceStoreActions.detachPanel(panelId, {
            x: ev.clientX - Math.round(meta.defaultFloatWidth / 2),
            y: ev.clientY - Math.round(FLOATING_HEADER_HEIGHT / 2),
          });
          return;
        }

        if (finalTarget.kind === 'self-noop') return;

        if (finalTarget.kind === 'dock-tab') {
          workspaceStoreActions.movePanel(panelId, {
            side: finalTarget.side,
            targetColId: finalTarget.targetColId,
            targetGroupId: finalTarget.targetGroupId,
          });
        } else if (finalTarget.kind === 'dock-split') {
          workspaceStoreActions.movePanel(panelId, {
            side: finalTarget.side,
            targetColId: finalTarget.targetColId,
            insertGroupIndex: finalTarget.insertGroupIndex,
          });
        } else if (finalTarget.kind === 'dock-column') {
          workspaceStoreActions.movePanel(panelId, {
            side: finalTarget.side,
            insertColumnIndex: finalTarget.insertColumnIndex,
          });
        } else if (finalTarget.kind === 'floating-tab') {
          workspaceStoreActions.mergePanelIntoFloating(panelId, finalTarget.targetFloatingId);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKeyDown);
    },
    []
  );

  const handleStartDockedTabDrag = useCallback(
    (
      e: React.PointerEvent<HTMLButtonElement>,
      panelId: DockPanelId,
      colId: string,
      groupId: string,
      groupPanelCount: number
    ) => {
      startTabPointerDrag(e, panelId, {
        kind: 'docked-tab',
        panelId,
        sourceColId: colId,
        sourceGroupId: groupId,
        sourceGroupPanelCount: groupPanelCount,
      });
    },
    [startTabPointerDrag]
  );

  const handleStartFloatingTabDrag = useCallback(
    (
      e: React.PointerEvent<HTMLButtonElement>,
      panelId: DockPanelId,
      floatingId: string
    ) => {
      startTabPointerDrag(e, panelId, {
        kind: 'floating-tab',
        panelId,
        sourceFloatingId: floatingId,
      });
    },
    [startTabPointerDrag]
  );

  // Dragging a floating panel by its title bar: moves freely at 60fps AND snaps/reattaches
  // when dropped onto any dock zone or another floating panel's title bar!
  const handleStartFloatingHeaderDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, floatingId: string) => {
      if (e.button !== 0) return;
      const fp = (useWorkspaceStore.getState().layout.floatingPanels ?? []).find(
        (f) => f.id === floatingId
      );
      if (!fp) return;

      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startY = e.clientY;
      const origX = fp.x;
      const origY = fp.y;
      const source: PointerDragSource = {
        kind: 'floating-window',
        panelId: fp.activePanelId,
        sourceFloatingId: floatingId,
      };
      let active = false;
      let latestTarget: DockDropTarget | null = null;

      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKeyDown);
        setPointerDragUi(null);
      };

      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape' && active) {
          ev.preventDefault();
          workspaceStoreActions.moveFloatingPanel(floatingId, origX, origY, false);
          cleanup();
        }
      };

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!active) {
          if (Math.hypot(dx, dy) < 4) return;
          active = true;
        }
        workspaceStoreActions.moveFloatingPanel(floatingId, origX + dx, origY + dy, false);
        const currentLayout = useWorkspaceStore.getState().layout;
        latestTarget = detectDockDropTarget(
          ev.clientX,
          ev.clientY,
          workspaceRef.current,
          leftDockRef.current,
          rightDockRef.current,
          currentLayout,
          source
        );
        setPointerDragUi({
          source,
          pointerX: ev.clientX,
          pointerY: ev.clientY,
          dropTarget: latestTarget,
        });
      };

      const onCancel = () => {
        if (active) {
          workspaceStoreActions.moveFloatingPanel(floatingId, origX, origY, false);
        }
        cleanup();
      };

      const onUp = (ev: PointerEvent) => {
        const wasActive = active;
        const finalTarget = latestTarget;
        cleanup();
        if (!wasActive) return;

        if (!finalTarget || finalTarget.kind === 'self-noop') {
          workspaceStoreActions.moveFloatingPanel(
            floatingId,
            origX + (ev.clientX - startX),
            origY + (ev.clientY - startY),
            true
          );
          return;
        }

        if (finalTarget.kind === 'dock-tab') {
          workspaceStoreActions.dockFloatingPanel(floatingId, {
            side: finalTarget.side,
            targetColId: finalTarget.targetColId,
            targetGroupId: finalTarget.targetGroupId,
          });
        } else if (finalTarget.kind === 'dock-split') {
          workspaceStoreActions.dockFloatingPanel(floatingId, {
            side: finalTarget.side,
            targetColId: finalTarget.targetColId,
            insertGroupIndex: finalTarget.insertGroupIndex,
          });
        } else if (finalTarget.kind === 'dock-column') {
          workspaceStoreActions.dockFloatingPanel(floatingId, {
            side: finalTarget.side,
            insertColumnIndex: finalTarget.insertColumnIndex,
          });
        } else if (finalTarget.kind === 'floating-tab') {
          const latestFp = (useWorkspaceStore.getState().layout.floatingPanels ?? []).find(
            (f) => f.id === floatingId
          );
          if (latestFp) {
            for (const pid of [...latestFp.panelIds]) {
              workspaceStoreActions.mergePanelIntoFloating(pid, finalTarget.targetFloatingId);
            }
          }
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKeyDown);
    },
    []
  );

  const handleDropEdge = (e: React.DragEvent, side: DockSide) => {
    e.preventDefault();
    const rawId =
      (e.dataTransfer.getData(DND_PANEL_MIME) as DockPanelId) ||
      (e.dataTransfer.getData('text/plain') as DockPanelId) ||
      draggingPanelId;
    if (rawId && DOCK_PANEL_META[rawId]) {
      workspaceStoreActions.movePanel(rawId, {
        side,
        insertColumnIndex: side === 'left' ? layout.leftDocks.length : 0,
      });
    }
    handleEndDragPanel();
  };

  const renderPanelBody = useCallback(
    (panelId: DockPanelId, containerWidth: number, containerHeight?: number): React.ReactNode => {
      switch (panelId) {
        case 'tools':
          return (
            <ToolStrip
              fluid
              onTransformSelection={onTransformSelection}
              onToggleTransparentColor={onToggleTransparentColor}
            />
          );
        case 'subtool':
          return (
            <div className="flex flex-col h-full min-h-0 overflow-hidden bg-[#202020]">
              <SubToolList
                customBrushes={customBrushes}
                setCustomBrushes={setCustomBrushes}
              />
            </div>
          );
        case 'tool-property':
          return (
            <div className="flex flex-col h-full min-h-0 overflow-hidden bg-[#202020]">
              <ToolPropertyInspector
                width={containerWidth}
                customBrushes={customBrushes}
                setCustomBrushes={setCustomBrushes}
                onDeselect={onDeselect}
                onTransformSelection={onTransformSelection}
                onClearSelection={onClearSelection}
                onDeleteOutsideSelection={onDeleteOutsideSelection}
                onCutSelection={onCutSelection}
                onCopySelection={onCopySelection}
                onPasteSelection={onPasteSelection}
                onMoveSelectionToNewLayer={onMoveSelectionToNewLayer}
                onExpandSelection={onExpandSelection}
                onContractSelection={onContractSelection}
                onFeatherSelection={onFeatherSelection}
                onInvertSelection={onInvertSelection}
              />
            </div>
          );
        case 'brush-size':
          return <BrushSizeDockedContent themePreset={themePreset} />;
        case 'navigator':
          return navigatorProps ? (
            <NavigatorPanel {...navigatorProps} themePreset={themePreset} />
          ) : null;
        case 'sub-view':
          return <SubViewPanel colorMode={colorMode} themePreset={themePreset} />;
        case 'info':
          return (
            <InfoPanel
              layers={layerSidebarProps.layers}
              colorMode={colorMode}
              themePreset={themePreset}
            />
          );
        case 'color':
          return (
            <RightSidebarColorSection
              colorMode={colorMode}
              containerWidth={containerWidth}
              containerHeight={containerHeight}
              fullHeight
            />
          );
        case 'layers':
          return (
            <RightSidebar
              {...layerSidebarProps}
              hideColorPanel
              dockedMode="layers"
            />
          );
        case 'history':
          return (
            <RightSidebar
              {...layerSidebarProps}
              hideColorPanel
              dockedMode="history"
            />
          );
        case 'quick-access':
          return (
            <QuickAccessPanel
              handlers={commandHandlers}
              themePreset={themePreset}
            />
          );
        case 'auto-actions':
          return autoActionProps ? (
            <AutoActionPanel {...autoActionProps} />
          ) : null;
      }
    },
    [
      autoActionProps,
      colorMode,
      commandHandlers,
      customBrushes,
      layerSidebarProps,
      navigatorProps,
      onClearSelection,
      onContractSelection,
      onCopySelection,
      onCutSelection,
      onDeleteOutsideSelection,
      onDeselect,
      onExpandSelection,
      onFeatherSelection,
      onInvertSelection,
      onMoveSelectionToNewLayer,
      onPasteSelection,
      onToggleTransparentColor,
      onTransformSelection,
      setCustomBrushes,
      themePreset,
    ]
  );

  const visibleDropTarget =
    pointerDragUi?.dropTarget && pointerDragUi.dropTarget.kind !== 'self-noop'
      ? pointerDragUi.dropTarget
      : null;

  return (
    <div
      ref={workspaceRef}
      data-testid="dock-workspace"
      data-palettes-hidden={String(palettesHidden)}
      className="flex flex-1 min-h-0 overflow-hidden relative gap-px bg-[#161616]"
    >
      {/* Left Dock Zone */}
      {!palettesHidden && (
        <div
          ref={leftDockRef}
          data-testid="left-dock-zone"
          className="flex h-full shrink-0 gap-px relative z-20"
        >
          {layout.leftDocks.map((col, colIdx) => (
            <DockColumnView
              key={col.id}
              side="left"
              col={col}
              colIndex={colIdx}
              themePreset={themePreset}
              draggingPanelId={draggingPanelId}
              onStartDragPanel={handleStartDragPanel}
              onEndDragPanel={handleEndDragPanel}
              onStartPointerTabDrag={handleStartDockedTabDrag}
              renderPanelBody={renderPanelBody}
            />
          ))}

          {/* Left-side New Column Drop Zone while HTML5-dragging */}
          {draggingPanelId && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setEdgeDropSide('left');
              }}
              onDragLeave={() => setEdgeDropSide(null)}
              onDrop={(e) => handleDropEdge(e, 'left')}
              className={`w-4 h-full transition-all flex items-center justify-center ${
                edgeDropSide === 'left'
                  ? 'w-8 bg-[var(--accent-subtle)] border-2 border-dashed border-[var(--accent)]'
                  : 'bg-[var(--accent-subtle)]/30'
              }`}
              title="Drop to create new Left Dock column"
            />
          )}
        </div>
      )}

      {/* Center Canvas Column (DocumentTabBar + CanvasArea + StatusBar) */}
      <div
        className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden relative"
        onMouseDown={() => {
          if (openPopover) workspaceStoreActions.closePopover();
        }}
      >
        {children}

        {/* Unobtrusive Restore Palettes Pill when hidden via Tab */}
        {palettesHidden && (
          <button
            type="button"
            onClick={() => workspaceStoreActions.setPalettesHidden(false)}
            data-testid="restore-palettes-pill"
            title="Show Palettes (Tab)"
            className="absolute top-2 right-2 z-30 h-6 px-2 rounded-full bg-[#202020]/90 hover:bg-[#2c2c2c] border border-white/[0.12] text-[10px] text-[#cccccc] hover:text-white flex items-center gap-1 shadow-lg cursor-pointer"
          >
            <Eye className="w-3 h-3 text-[var(--accent)]" />
            <span>Show Palettes (Tab)</span>
          </button>
        )}
      </div>

      {/* Right Dock Zone */}
      {!palettesHidden && (
        <div
          ref={rightDockRef}
          data-testid="right-dock-zone"
          className="flex h-full shrink-0 gap-px relative z-20"
        >
          {/* Right-side New Column Drop Zone while HTML5-dragging */}
          {draggingPanelId && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setEdgeDropSide('right');
              }}
              onDragLeave={() => setEdgeDropSide(null)}
              onDrop={(e) => handleDropEdge(e, 'right')}
              className={`w-4 h-full transition-all flex items-center justify-center ${
                edgeDropSide === 'right'
                  ? 'w-8 bg-[var(--accent-subtle)] border-2 border-dashed border-[var(--accent)]'
                  : 'bg-[var(--accent-subtle)]/30'
              }`}
              title="Drop to create new Right Dock column"
            />
          )}

          {layout.rightDocks.map((col, colIdx) => (
            <DockColumnView
              key={col.id}
              side="right"
              col={col}
              colIndex={colIdx}
              themePreset={themePreset}
              draggingPanelId={draggingPanelId}
              onStartDragPanel={handleStartDragPanel}
              onEndDragPanel={handleEndDragPanel}
              onStartPointerTabDrag={handleStartDockedTabDrag}
              renderPanelBody={renderPanelBody}
            />
          ))}
        </div>
      )}

      {/* Freely Floating Detached Panels (Portaled to document.body, non-blocking) */}
      {!palettesHidden &&
        floatingPanels.map((fp) => (
          <FloatingPanelWindow
            key={fp.id}
            panel={fp}
            isDragging={
              pointerDragUi?.source.kind === 'floating-window' &&
              pointerDragUi.source.sourceFloatingId === fp.id
            }
            isDockTargetActive={
              pointerDragUi?.source.kind === 'floating-window' &&
              pointerDragUi.source.sourceFloatingId === fp.id &&
              Boolean(visibleDropTarget)
            }
            isMergeTabTarget={
              visibleDropTarget?.kind === 'floating-tab' &&
              visibleDropTarget.targetFloatingId === fp.id
            }
            renderPanelIcon={renderPanelIcon}
            renderPanelBody={renderPanelBody}
            onStartHeaderDrag={handleStartFloatingHeaderDrag}
            onStartTabDrag={handleStartFloatingTabDrag}
          />
        ))}

      {/* Live Dock Drop Preview Overlay while dragging a panel */}
      {visibleDropTarget &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            data-testid="dock-drop-preview"
            style={{
              position: 'fixed',
              left: visibleDropTarget.previewRect.left,
              top: visibleDropTarget.previewRect.top,
              width: visibleDropTarget.previewRect.width,
              height: visibleDropTarget.previewRect.height,
              zIndex: 49,
            }}
            className="pointer-events-none rounded-sm border-2 border-[var(--accent)] bg-[var(--accent-subtle)] shadow-[0_0_18px_rgba(var(--accent-rgb),0.32)] flex items-center justify-center transition-all duration-75"
          >
            <span className="px-2 py-0.5 rounded bg-[#161616]/90 border border-[var(--accent-border)] text-[10px] font-medium text-[#f5f5f5] whitespace-nowrap shadow">
              {visibleDropTarget.label}
            </span>
          </div>,
          document.body
        )}

      {/* Floating Drag Ghost Pill when dragging a docked tab or splitting a floating tab */}
      {pointerDragUi &&
        pointerDragUi.source.kind !== 'floating-window' &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            data-testid="panel-drag-ghost"
            style={{
              position: 'fixed',
              left: pointerDragUi.pointerX + 12,
              top: pointerDragUi.pointerY + 12,
              zIndex: 49,
            }}
            className="pointer-events-none flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#1a1a1a]/95 border border-white/[0.18] shadow-[0_10px_28px_rgba(0,0,0,0.75)] text-[11px] text-[#f0f0f0] select-none"
          >
            {renderPanelIcon(pointerDragUi.source.panelId, 'w-3.5 h-3.5 text-[var(--accent)]')}
            <span className="font-medium">
              {DOCK_PANEL_META[pointerDragUi.source.panelId].title}
            </span>
            <span className="text-[10px] text-[#9e9e9e] border-l border-white/[0.1] pl-1.5">
              {visibleDropTarget
                ? visibleDropTarget.label
                : pointerDragUi.dropTarget?.kind === 'self-noop'
                  ? 'Drag outside to float'
                  : 'Release to float'}
            </span>
          </div>,
          document.body
        )}
    </div>
  );
});

DockWorkspace.displayName = 'DockWorkspace';
