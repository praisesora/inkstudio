import React, { useState, useRef, useEffect, useCallback } from 'react';
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
  Play,
} from 'lucide-react';
import { CanvasColorMode, CspBrush } from '../types/editor';
import { ThemePreset } from '../types/settings';
import {
  DOCK_PANEL_META,
  DockColumn,
  DockGroup,
  DockPanelId,
  DockSide,
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
import { AutoActionPanel, AutoActionPanelProps } from './AutoActionPanel';
import { WorkspaceCommandHandlers } from './CommandBar';

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
  themePreset: ThemePreset;
  draggingPanelId: DockPanelId | null;
  onStartDragPanel: (panelId: DockPanelId) => void;
  onEndDragPanel: () => void;
  renderPanelBody: (panelId: DockPanelId, containerWidth: number) => React.ReactNode;
}

const DockGroupView: React.FC<DockGroupViewProps> = React.memo(({
  side,
  col,
  group,
  themePreset,
  draggingPanelId,
  onStartDragPanel,
  onEndDragPanel,
  renderPanelBody,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isDragOverTab, setIsDragOverTab] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const isVintage = themePreset === 'vintage-manga';

  useEffect(() => {
    if (!menuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleOutside);
    return () => window.removeEventListener('mousedown', handleOutside);
  }, [menuOpen]);

  const activePanelId = group.panelIds.includes(group.activePanelId)
    ? group.activePanelId
    : group.panelIds[0];

  const isCompactToolOnly =
    col.width <= 64 && group.panelIds.length === 1 && group.panelIds[0] === 'tools';

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
      data-testid={`dock-group-${group.id}`}
      style={{ flexGrow: group.heightRatio, flexBasis: 0 }}
      className={`flex flex-col min-h-[72px] overflow-hidden ${
        isVintage ? 'bg-[#363638]' : 'bg-[#202020]'
      }`}
    >
      {/* Palette Tab Header Bar (Draggable!) */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setIsDragOverTab(true);
        }}
        onDragLeave={() => setIsDragOverTab(false)}
        onDrop={handleDropOnTabs}
        className={`h-6 flex items-center justify-between px-1 shrink-0 select-none relative transition-colors ${
          isDragOverTab
            ? 'bg-[var(--accent-subtle)] ring-1 ring-inset ring-[var(--accent)]'
            : isVintage
            ? 'bg-gradient-to-b from-[#49494d] to-[#3a3a3d] border-b border-[#232325]'
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
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DND_PANEL_MIME, pid);
                  e.dataTransfer.setData('text/plain', pid);
                  e.dataTransfer.effectAllowed = 'move';
                  onStartDragPanel(pid);
                }}
                onDragEnd={onEndDragPanel}
                onClick={() => workspaceStoreActions.setGroupActivePanel(col.id, group.id, pid)}
                data-testid={`dock-tab-${pid}`}
                title={`${meta.title} — Drag tab to move palette`}
                className={`h-5 px-1.5 rounded-sm flex items-center gap-1 text-[10px] transition-colors shrink-0 cursor-grab active:cursor-grabbing ${
                  isActive
                    ? isVintage
                      ? 'bg-[#337bb5] text-white font-medium'
                      : 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                    : isVintage
                    ? 'text-[#b0b0b6] hover:text-white hover:bg-[#4e4e52]'
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

        {/* Palette Options Menu (1-click Move Left/Right, New Column, Collapse, Hide) */}
        {!isCompactToolOnly && (
          <div className="relative shrink-0" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              data-testid={`dock-menu-btn-${activePanelId}`}
              title="Palette Dock Options"
              className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
            >
              <MoreHorizontal className="w-3 h-3" />
            </button>

            {menuOpen && (
              <div
                className={`absolute top-6 ${
                  side === 'left' ? 'left-0' : 'right-0'
                } w-44 rounded-md shadow-2xl p-1 z-50 text-[11px] ${
                  isVintage
                    ? 'bg-[#333336] border border-[#202022] text-[#e5e5e5]'
                    : 'bg-[#202020] border border-white/[0.1] text-[#e5e5e5]'
                }`}
              >
                <div className="px-2 py-0.5 text-[10px] text-[#8a8a8a] truncate">
                  {DOCK_PANEL_META[activePanelId].title}
                </div>
                <div className="my-0.5 h-px bg-white/[0.08]" />

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
              </div>
            )}
          </div>
        )}
      </div>

      {/* Active Panel Content */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {renderPanelBody(activePanelId, col.width)}
      </div>
    </div>
  );
});
DockGroupView.displayName = 'DockGroupView';

interface DockColumnViewProps {
  side: DockSide;
  col: DockColumn;
  themePreset: ThemePreset;
  draggingPanelId: DockPanelId | null;
  onStartDragPanel: (panelId: DockPanelId) => void;
  onEndDragPanel: () => void;
  renderPanelBody: (panelId: DockPanelId, containerWidth: number) => React.ReactNode;
}

const DockColumnView: React.FC<DockColumnViewProps> = React.memo(({
  side,
  col,
  themePreset,
  draggingPanelId,
  onStartDragPanel,
  onEndDragPanel,
  renderPanelBody,
}) => {
  const openPopover = useWorkspaceStore((s) => s.openPopover);
  const colRef = useRef<HTMLDivElement>(null);
  const [dragOverSplitIdx, setDragOverSplitIdx] = useState<number | null>(null);
  const isVintage = themePreset === 'vintage-manga';

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

    return (
      <div
        data-testid={`dock-column-${col.id}`}
        data-collapsed="true"
        className={`relative w-[30px] h-full flex flex-col items-center py-1 gap-1 shrink-0 select-none z-20 ${
          isVintage
            ? 'bg-[#333336] border-x border-[#232325]'
            : 'bg-[#1c1c1c] border-x border-white/[0.04]'
        }`}
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
            return (
              <button
                key={pid}
                type="button"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DND_PANEL_MIME, pid);
                  e.dataTransfer.setData('text/plain', pid);
                  onStartDragPanel(pid);
                }}
                onDragEnd={onEndDragPanel}
                onClick={() => workspaceStoreActions.togglePopover(col.id, pid)}
                data-testid={`collapsed-tab-${pid}`}
                title={`${meta.title} (Click to pop out)`}
                aria-pressed={isOpen}
                className={`relative w-6 h-7 rounded flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                  isOpen
                    ? isVintage
                      ? 'bg-[#337bb5] text-white'
                      : 'bg-[#2c2c2c] text-[var(--accent)]'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                }`}
              >
                {isOpen && (
                  <span
                    className={`absolute top-1 bottom-1 w-[2px] rounded-full ${
                      side === 'left' ? 'left-0' : 'right-0'
                    }`}
                    style={{ backgroundColor: isVintage ? '#38bdf8' : 'var(--accent)' }}
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
            className={`absolute top-1 bottom-1 z-40 flex flex-col rounded-md shadow-[0_12px_36px_rgba(0,0,0,0.75)] overflow-hidden ${
              side === 'left' ? 'left-[32px]' : 'right-[32px]'
            } ${
              isVintage
                ? 'bg-[#363638] border border-[#202022]'
                : 'bg-[#202020] border border-white/[0.12]'
            }`}
          >
            <div
              className={`h-7 px-2 flex items-center justify-between shrink-0 ${
                isVintage
                  ? 'bg-gradient-to-b from-[#49494d] to-[#3a3a3d] border-b border-[#232325]'
                  : 'bg-[#1a1a1a] border-b border-white/[0.08]'
              }`}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                {renderPanelIcon(activePopoverPanelId, 'w-3.5 h-3.5 text-[var(--accent)]')}
                <span className="text-[11px] font-medium text-[#e5e5e5] truncate">
                  {DOCK_PANEL_META[activePopoverPanelId].title}
                </span>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
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
      style={{ width: col.width }}
      className={`relative h-full flex flex-col shrink-0 overflow-hidden z-10 ${
        isVintage ? 'bg-[#262628]' : 'bg-[#161616]'
      }`}
    >
      {/* Slim CSP Column Collapse Bar */}
      <div
        className={`h-4 px-1 flex items-center shrink-0 ${
          side === 'left' ? 'justify-end' : 'justify-start'
        } ${
          isVintage
            ? 'bg-[#2e2e31] border-b border-[#202022]'
            : 'bg-[#181818] border-b border-white/[0.04]'
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
              themePreset={themePreset}
              draggingPanelId={draggingPanelId}
              onStartDragPanel={onStartDragPanel}
              onEndDragPanel={onEndDragPanel}
              renderPanelBody={renderPanelBody}
            />

            {idx < col.groups.length - 1 && (
              <div
                onPointerDown={(e) => handleStartGroupSplitResize(e, grp, col.groups[idx + 1])}
                title="Drag to resize stacked palettes"
                className={`h-1 shrink-0 cursor-row-resize transition-colors ${
                  isVintage
                    ? 'bg-[#232325] hover:bg-[#38bdf8]/60'
                    : 'bg-[#161616] hover:bg-[var(--accent)]/50'
                }`}
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

export const DockWorkspace: React.FC<DockWorkspaceProps> = React.memo(({
  themePreset,
  colorMode,
  commandHandlers,
  onDeselect,
  onTransformSelection,
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
  const workspaceRef = useRef<HTMLDivElement>(null);

  const isVintage = themePreset === 'vintage-manga';

  // Close collapsed-strip popover on Escape or outside click on canvas
  useEffect(() => {
    if (!openPopover) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') workspaceStoreActions.closePopover();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [openPopover]);

  const handleStartDragPanel = useCallback((panelId: DockPanelId) => {
    setDraggingPanelId(panelId);
  }, []);

  const handleEndDragPanel = useCallback(() => {
    setDraggingPanelId(null);
    setEdgeDropSide(null);
  }, []);

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
    (panelId: DockPanelId, containerWidth: number): React.ReactNode => {
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
        case 'color':
          return (
            <RightSidebarColorSection
              colorMode={colorMode}
              containerWidth={containerWidth}
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
      onContractSelection,
      onDeselect,
      onExpandSelection,
      onFeatherSelection,
      onInvertSelection,
      onToggleTransparentColor,
      onTransformSelection,
      setCustomBrushes,
      themePreset,
    ]
  );

  return (
    <div
      ref={workspaceRef}
      data-testid="dock-workspace"
      data-palettes-hidden={String(palettesHidden)}
      className={`flex flex-1 min-h-0 overflow-hidden relative gap-px ${
        isVintage ? 'bg-[#232325]' : 'bg-[#161616]'
      }`}
    >
      {/* Left Dock Zone */}
      {!palettesHidden && (
        <div
          data-testid="left-dock-zone"
          className="flex h-full shrink-0 gap-px relative z-20"
        >
          {layout.leftDocks.map((col) => (
            <DockColumnView
              key={col.id}
              side="left"
              col={col}
              themePreset={themePreset}
              draggingPanelId={draggingPanelId}
              onStartDragPanel={handleStartDragPanel}
              onEndDragPanel={handleEndDragPanel}
              renderPanelBody={renderPanelBody}
            />
          ))}

          {/* Left-side New Column Drop Zone while dragging */}
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
          data-testid="right-dock-zone"
          className="flex h-full shrink-0 gap-px relative z-20"
        >
          {/* Right-side New Column Drop Zone while dragging */}
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

          {layout.rightDocks.map((col) => (
            <DockColumnView
              key={col.id}
              side="right"
              col={col}
              themePreset={themePreset}
              draggingPanelId={draggingPanelId}
              onStartDragPanel={handleStartDragPanel}
              onEndDragPanel={handleEndDragPanel}
              renderPanelBody={renderPanelBody}
            />
          ))}
        </div>
      )}
    </div>
  );
});

DockWorkspace.displayName = 'DockWorkspace';
