import React, { useState } from 'react';
import {
  LayoutGrid,
  List,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  RotateCcw,
  Paintbrush,
  Eraser,
  Pipette,
  PaintBucket,
  BoxSelect,
  Lasso,
  Wand2,
  Type,
  Frame,
  MessageSquare,
  Spline,
  Scaling,
  SlidersHorizontal,
  Palette,
  PenTool,
  Shapes,
} from 'lucide-react';
import { ToolType } from '../types/editor';
import { ThemePreset } from '../types/settings';
import { COMMAND_CATALOG, CommandActionId, QuickAccessItem } from '../types/workspace';
import { BUILTIN_BRUSHES } from '../utils/presetBrushes';
import {
  NEUTRAL_BRUSH_DEFAULTS,
  getEffectiveBrushSettings,
  migrateLegacyPresetId,
  saveActivePresetId,
} from '../utils/brushPresetManager';
import {
  toolStoreActions,
  useToolStore,
  useWorkspaceStore,
  workspaceStoreActions,
} from '../stores';
import {
  WorkspaceCommandHandlers,
  executeWorkspaceCommand,
  isCommandActive,
  isCommandDisabled,
  renderCommandIcon,
} from './CommandBar';
import { LiquifyIcon } from './LiquifyIcon';

const QUICK_TOOL_CATALOG: Array<{ id: ToolType; label: string }> = [
  { id: 'brush', label: 'Brush' },
  { id: 'eraser', label: 'Eraser' },
  { id: 'pipette', label: 'Eyedropper' },
  { id: 'liquify', label: 'Liquify' },
  { id: 'fill', label: 'Fill Bucket' },
  { id: 'shape', label: 'Shapes' },
  { id: 'select-rect', label: 'Marquee' },
  { id: 'select-lasso', label: 'Lasso' },
  { id: 'select-wand', label: 'Magic Wand' },
  { id: 'select-pen', label: 'Selection Pen' },
  { id: 'transform', label: 'Transform' },
  { id: 'text', label: 'Text' },
  { id: 'frame', label: 'Frame Border' },
  { id: 'balloon', label: 'Speech Balloon' },
  { id: 'vector-edit', label: 'Correct Line' },
];

function renderToolIcon(tool: ToolType): React.ReactNode {
  const cls = 'w-3.5 h-3.5 shrink-0';
  switch (tool) {
    case 'brush':
      return <Paintbrush className={cls} />;
    case 'eraser':
      return <Eraser className={cls} />;
    case 'pipette':
      return <Pipette className={cls} />;
    case 'liquify':
      return <LiquifyIcon className={cls} />;
    case 'fill':
      return <PaintBucket className={cls} />;
    case 'shape':
      return <Shapes className={cls} />;
    case 'select-rect':
      return <BoxSelect className={cls} />;
    case 'select-lasso':
      return <Lasso className={cls} />;
    case 'select-wand':
      return <Wand2 className={cls} />;
    case 'select-pen':
    case 'select-eraser':
      return <PenTool className={cls} />;
    case 'transform':
      return <Scaling className={cls} />;
    case 'text':
      return <Type className={cls} />;
    case 'frame':
      return <Frame className={cls} />;
    case 'balloon':
      return <MessageSquare className={cls} />;
    case 'vector-edit':
      return <Spline className={cls} />;
    default:
      return <Paintbrush className={cls} />;
  }
}

export interface QuickAccessPanelProps {
  handlers: WorkspaceCommandHandlers;
  themePreset?: ThemePreset;
}

export const QuickAccessPanel: React.FC<QuickAccessPanelProps> = React.memo(({
  handlers,
  themePreset = 'modern',
}) => {
  const items = useWorkspaceStore((s) => s.quickAccessItems);
  const viewMode = useWorkspaceStore((s) => s.quickAccessViewMode);
  const palettesHidden = useWorkspaceStore((s) => s.palettesHidden);

  const activeTool = useToolStore((s) => s.tool);
  const primaryColor = useToolStore((s) => s.primaryColor);
  const activePresetId = useToolStore((s) => s.activePresetId);
  const activeBrushName = useToolStore((s) => s.brushSettings.brushName);

  const [isEditing, setIsEditing] = useState(false);
  const [addTab, setAddTab] = useState<'command' | 'tool' | 'brush'>('command');

  const handleActivateItem = (item: QuickAccessItem) => {
    if (item.kind === 'command' && item.commandId) {
      executeWorkspaceCommand(item.commandId, handlers);
      return;
    }
    if (item.kind === 'tool' && item.toolId) {
      toolStoreActions.selectTool(item.toolId);
      if (item.toolId === 'transform') handlers.onTransform?.();
      return;
    }
    if (item.kind === 'color' && item.color) {
      toolStoreActions.setPrimaryColor(item.color, true);
      return;
    }
    if (item.kind === 'brush' && item.brushPresetId) {
      const resolvedPresetId = migrateLegacyPresetId(item.brushPresetId);
      toolStoreActions.selectTool('brush');
      saveActivePresetId(resolvedPresetId);
      const effective = getEffectiveBrushSettings(resolvedPresetId);
      toolStoreActions.updateBrushSettings({
        ...NEUTRAL_BRUSH_DEFAULTS,
        ...effective,
        preset: resolvedPresetId,
      });
    }
  };

  const handleAddCurrentColor = () => {
    workspaceStoreActions.addQuickAccessItem({
      id: `qa-color-${Date.now().toString(36)}`,
      kind: 'color',
      label: primaryColor.toUpperCase(),
      color: primaryColor,
    });
  };

  const handleAddCurrentBrush = () => {
    const label = activeBrushName || activePresetId || 'Brush';
    workspaceStoreActions.addQuickAccessItem({
      id: `qa-brush-${Date.now().toString(36)}`,
      kind: 'brush',
      label,
      brushPresetId: activePresetId,
    });
  };

  const handleAddCommand = (commandId: CommandActionId, label: string) => {
    workspaceStoreActions.addQuickAccessItem({
      id: `qa-cmd-${commandId}-${Date.now().toString(36)}`,
      kind: 'command',
      label,
      commandId,
    });
  };

  const handleAddTool = (toolId: ToolType, label: string) => {
    workspaceStoreActions.addQuickAccessItem({
      id: `qa-tool-${toolId}-${Date.now().toString(36)}`,
      kind: 'tool',
      label,
      toolId,
    });
  };

  return (
    <div
      data-testid="quick-access-panel"
      data-theme-preset={themePreset}
      className="flex flex-col h-full min-h-0 select-none text-xs bg-[#202020] text-[#e5e5e5]"
    >
      {/* Toolbar: Grid/List + Edit Mode */}
      <div className="h-7 px-1.5 flex items-center justify-between shrink-0 bg-[#1a1a1a] border-b border-white/[0.06]">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => workspaceStoreActions.setQuickAccessViewMode('grid')}
            title="Grid View"
            className={`w-5 h-5 rounded flex items-center justify-center cursor-pointer ${
              viewMode === 'grid'
                ? 'bg-[#2c2c2c] text-[var(--accent)]'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
            }`}
          >
            <LayoutGrid className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => workspaceStoreActions.setQuickAccessViewMode('list')}
            title="List View"
            className={`w-5 h-5 rounded flex items-center justify-center cursor-pointer ${
              viewMode === 'list'
                ? 'bg-[#2c2c2c] text-[var(--accent)]'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
            }`}
          >
            <List className="w-3 h-3" />
          </button>
        </div>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={handleAddCurrentColor}
            title={`Pin Primary Color (${primaryColor})`}
            className="h-5 px-1 rounded flex items-center gap-1 text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
          >
            <span
              className="w-2.5 h-2.5 rounded-xs border border-white/25"
              style={{ backgroundColor: primaryColor }}
            />
            <Plus className="w-2.5 h-2.5" />
          </button>

          <button
            type="button"
            onClick={() => setIsEditing((v) => !v)}
            title="Customize Quick Access"
            className={`h-5 px-1.5 rounded flex items-center gap-1 text-[10px] transition-colors cursor-pointer ${
              isEditing
                ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
            }`}
          >
            <SlidersHorizontal className="w-3 h-3" />
            <span>{isEditing ? 'Done' : 'Edit'}</span>
          </button>
        </div>
      </div>

      {/* Main Items Area */}
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
        {items.length === 0 ? (
          <div className="p-3 text-center text-[11px] text-[#8a8a8a]">
            No shortcuts. Click Edit to add tools, commands, brushes, or colors.
          </div>
        ) : viewMode === 'grid' && !isEditing ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(46px,1fr))] gap-1">
            {items.map((item) => {
              const disabled =
                item.kind === 'command' && item.commandId
                  ? isCommandDisabled(item.commandId, handlers)
                  : false;
              const active =
                (item.kind === 'command' &&
                  item.commandId &&
                  isCommandActive(item.commandId, handlers, palettesHidden)) ||
                (item.kind === 'tool' && item.toolId === activeTool) ||
                (item.kind === 'brush' &&
                  item.brushPresetId &&
                  migrateLegacyPresetId(item.brushPresetId) === activePresetId &&
                  activeTool === 'brush') ||
                (item.kind === 'color' && item.color?.toLowerCase() === primaryColor.toLowerCase());

              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => handleActivateItem(item)}
                  title={item.label}
                  className={`h-11 px-1 rounded flex flex-col items-center justify-center gap-1 transition-colors ${
                    disabled
                      ? 'opacity-30 cursor-not-allowed bg-[#161616] text-[#8a8a8a]'
                      : active
                      ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent-border)] cursor-pointer'
                      : 'bg-[#161616] hover:bg-[#2c2c2c] text-[#cccccc] hover:text-white border border-transparent cursor-pointer'
                  }`}
                >
                  {item.kind === 'command' && item.commandId && renderCommandIcon(item.commandId, palettesHidden)}
                  {item.kind === 'tool' && item.toolId && renderToolIcon(item.toolId)}
                  {item.kind === 'color' && (
                    <span
                      className="w-4 h-4 rounded-sm border border-white/25"
                      style={{ backgroundColor: item.color }}
                    />
                  )}
                  {item.kind === 'brush' && <Paintbrush className="w-3.5 h-3.5 shrink-0" />}
                  <span className="text-[9px] leading-tight truncate max-w-full">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="space-y-0.5">
            {items.map((item, idx) => {
              const disabled =
                !isEditing && item.kind === 'command' && item.commandId
                  ? isCommandDisabled(item.commandId, handlers)
                  : false;
              const active =
                !isEditing &&
                ((item.kind === 'command' &&
                  item.commandId &&
                  isCommandActive(item.commandId, handlers, palettesHidden)) ||
                  (item.kind === 'tool' && item.toolId === activeTool) ||
                  (item.kind === 'brush' &&
                  item.brushPresetId &&
                  migrateLegacyPresetId(item.brushPresetId) === activePresetId &&
                  activeTool === 'brush') ||
                  (item.kind === 'color' && item.color?.toLowerCase() === primaryColor.toLowerCase()));

              return (
                <div
                  key={item.id}
                  className={`flex items-center gap-1 rounded px-1.5 py-1 transition-colors ${
                    active
                      ? 'bg-[var(--accent-subtle)] text-[var(--accent)]'
                      : 'bg-[#161616] hover:bg-[#2c2c2c] text-[#cccccc]'
                  }`}
                >
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => !isEditing && handleActivateItem(item)}
                    className={`flex-1 min-w-0 flex items-center gap-2 text-left text-[11px] ${
                      disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'
                    }`}
                  >
                    {item.kind === 'command' && item.commandId && renderCommandIcon(item.commandId, palettesHidden)}
                    {item.kind === 'tool' && item.toolId && renderToolIcon(item.toolId)}
                    {item.kind === 'color' && (
                      <span
                        className="w-3.5 h-3.5 rounded-xs border border-white/25 shrink-0"
                        style={{ backgroundColor: item.color }}
                      />
                    )}
                    {item.kind === 'brush' && <Paintbrush className="w-3.5 h-3.5 shrink-0" />}
                    <span className="truncate">{item.label}</span>
                  </button>

                  {isEditing && (
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => workspaceStoreActions.moveQuickAccessItem(item.id, -1)}
                        title="Move Up"
                        className="p-0.5 text-[#8a8a8a] hover:text-white disabled:opacity-25 cursor-pointer"
                      >
                        <ChevronUp className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === items.length - 1}
                        onClick={() => workspaceStoreActions.moveQuickAccessItem(item.id, 1)}
                        title="Move Down"
                        className="p-0.5 text-[#8a8a8a] hover:text-white disabled:opacity-25 cursor-pointer"
                      >
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => workspaceStoreActions.removeQuickAccessItem(item.id)}
                        title="Remove"
                        className="p-0.5 text-[#8a8a8a] hover:text-rose-400 cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add-Item Drawer when Editing */}
      {isEditing && (
        <div className="shrink-0 border-t border-white/[0.08] bg-[#161616] p-1.5 space-y-1.5">
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-0.5">
              {(['command', 'tool', 'brush'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setAddTab(tab)}
                  className={`px-1.5 py-0.5 rounded text-[10px] capitalize cursor-pointer ${
                    addTab === tab
                      ? 'bg-[#2c2c2c] text-white font-medium'
                      : 'text-[#8a8a8a] hover:text-white'
                  }`}
                >
                  {tab}s
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => workspaceStoreActions.resetQuickAccessItems()}
              title="Reset Quick Access to defaults"
              className="p-1 rounded text-[#8a8a8a] hover:text-amber-300 hover:bg-[#2c2c2c] cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleAddCurrentColor}
              className="flex-1 py-1 px-1.5 rounded bg-[#202020] hover:bg-[#2c2c2c] text-[10px] text-[#cccccc] flex items-center justify-center gap-1 cursor-pointer"
            >
              <Palette className="w-3 h-3" />
              <span>+ Color</span>
            </button>
            <button
              type="button"
              onClick={handleAddCurrentBrush}
              className="flex-1 py-1 px-1.5 rounded bg-[#202020] hover:bg-[#2c2c2c] text-[10px] text-[#cccccc] flex items-center justify-center gap-1 cursor-pointer"
            >
              <Paintbrush className="w-3 h-3" />
              <span>+ Brush</span>
            </button>
          </div>

          <div className="max-h-28 overflow-y-auto space-y-0.5">
            {addTab === 'command' &&
              COMMAND_CATALOG.map((cmd) => (
                <button
                  key={cmd.id}
                  type="button"
                  onClick={() => handleAddCommand(cmd.id, cmd.label)}
                  className="w-full flex items-center justify-between px-1.5 py-1 rounded bg-[#202020] hover:bg-[#2c2c2c] text-[10px] text-[#cccccc] hover:text-white cursor-pointer"
                >
                  <span className="flex items-center gap-1.5 truncate">
                    {renderCommandIcon(cmd.id)}
                    <span className="truncate">{cmd.label}</span>
                  </span>
                  <Plus className="w-3 h-3 text-[#8a8a8a] shrink-0" />
                </button>
              ))}

            {addTab === 'tool' &&
              QUICK_TOOL_CATALOG.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleAddTool(t.id, t.label)}
                  className="w-full flex items-center justify-between px-1.5 py-1 rounded bg-[#202020] hover:bg-[#2c2c2c] text-[10px] text-[#cccccc] hover:text-white cursor-pointer"
                >
                  <span className="flex items-center gap-1.5 truncate">
                    {renderToolIcon(t.id)}
                    <span className="truncate">{t.label}</span>
                  </span>
                  <Plus className="w-3 h-3 text-[#8a8a8a] shrink-0" />
                </button>
              ))}

            {addTab === 'brush' &&
              BUILTIN_BRUSHES.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() =>
                    workspaceStoreActions.addQuickAccessItem({
                      id: `qa-brush-${b.id}-${Date.now().toString(36)}`,
                      kind: 'brush',
                      label: b.name,
                      brushPresetId: b.id,
                    })
                  }
                  className="w-full flex items-center justify-between px-1.5 py-1 rounded bg-[#202020] hover:bg-[#2c2c2c] text-[10px] text-[#cccccc] hover:text-white cursor-pointer"
                >
                  <span className="flex items-center gap-1.5 truncate">
                    <Paintbrush className="w-3 h-3 shrink-0" />
                    <span className="truncate">{b.name}</span>
                  </span>
                  <Plus className="w-3 h-3 text-[#8a8a8a] shrink-0" />
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
});

QuickAccessPanel.displayName = 'QuickAccessPanel';
