import React, { useState, useRef, useEffect } from 'react';
import {
  Save,
  Undo2,
  Redo2,
  FlipHorizontal,
  FlipVertical,
  Eraser,
  Layers,
  Plus,
  Copy,
  Scaling,
  X,
  Maximize2,
  RotateCcw,
  ArrowLeftRight,
  EyeOff,
  Eye,
  SlidersHorizontal,
  LayoutGrid,
  ChevronDown,
  ChevronUp,
  Check,
  Sparkles,
} from 'lucide-react';
import {
  COMMAND_CATALOG,
  CommandActionId,
  WORKSPACE_PRESET_LABELS,
  WorkspacePresetId,
} from '../types/workspace';
import { ThemePreset } from '../types/settings';
import { useWorkspaceStore, workspaceStoreActions } from '../stores';

export interface WorkspaceCommandHandlers {
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onSave?: () => void;
  onSaveAs?: () => void;
  onNewLayer?: () => void;
  onDuplicateLayer?: () => void;
  onClearLayer?: () => void;
  onMergeDown?: () => void;
  onFlipHorizontal?: () => void;
  onFlipVertical?: () => void;
  flipX?: boolean;
  flipY?: boolean;
  onResetZoom?: () => void;
  onResetRotation?: () => void;
  onTransform?: () => void;
  onDeselect?: () => void;
  onSwapColors?: () => void;
  onToggleTransparentColor?: () => void;
  hasOpenDocument: boolean;
}

export function renderCommandIcon(id: CommandActionId, palettesHidden = false): React.ReactNode {
  const cls = 'w-3.5 h-3.5 shrink-0';
  switch (id) {
    case 'save':
    case 'save-as':
      return <Save className={cls} />;
    case 'undo':
      return <Undo2 className={cls} />;
    case 'redo':
      return <Redo2 className={cls} />;
    case 'flip-h':
      return <FlipHorizontal className={cls} />;
    case 'flip-v':
      return <FlipVertical className={cls} />;
    case 'clear-layer':
      return <Eraser className={cls} />;
    case 'merge-down':
      return <Layers className={cls} />;
    case 'new-layer':
      return <Plus className={cls} />;
    case 'duplicate-layer':
      return <Copy className={cls} />;
    case 'transform':
      return <Scaling className={cls} />;
    case 'deselect':
      return <X className={cls} />;
    case 'reset-zoom':
      return <Maximize2 className={cls} />;
    case 'reset-rotation':
      return <RotateCcw className={cls} />;
    case 'swap-colors':
      return <ArrowLeftRight className={cls} />;
    case 'transparent-ink':
      return <Sparkles className={cls} />;
    case 'toggle-palettes':
      return palettesHidden ? <Eye className={cls} /> : <EyeOff className={cls} />;
    default:
      return <Sparkles className={cls} />;
  }
}

export function executeWorkspaceCommand(
  id: CommandActionId,
  handlers: WorkspaceCommandHandlers
): void {
  switch (id) {
    case 'undo':
      if (handlers.canUndo) handlers.onUndo();
      break;
    case 'redo':
      if (handlers.canRedo) handlers.onRedo();
      break;
    case 'save':
      handlers.onSave?.();
      break;
    case 'save-as':
      handlers.onSaveAs?.();
      break;
    case 'new-layer':
      handlers.onNewLayer?.();
      break;
    case 'duplicate-layer':
      handlers.onDuplicateLayer?.();
      break;
    case 'clear-layer':
      handlers.onClearLayer?.();
      break;
    case 'merge-down':
      handlers.onMergeDown?.();
      break;
    case 'flip-h':
      handlers.onFlipHorizontal?.();
      break;
    case 'flip-v':
      handlers.onFlipVertical?.();
      break;
    case 'reset-zoom':
      handlers.onResetZoom?.();
      break;
    case 'reset-rotation':
      handlers.onResetRotation?.();
      break;
    case 'transform':
      handlers.onTransform?.();
      break;
    case 'deselect':
      handlers.onDeselect?.();
      break;
    case 'swap-colors':
      handlers.onSwapColors?.();
      break;
    case 'transparent-ink':
      handlers.onToggleTransparentColor?.();
      break;
    case 'toggle-palettes':
      workspaceStoreActions.togglePalettesHidden();
      break;
  }
}

export function isCommandDisabled(
  id: CommandActionId,
  handlers: WorkspaceCommandHandlers
): boolean {
  if (id === 'toggle-palettes' || id === 'swap-colors' || id === 'transparent-ink') return false;
  if (!handlers.hasOpenDocument) return true;
  if (id === 'undo') return !handlers.canUndo;
  if (id === 'redo') return !handlers.canRedo;
  return false;
}

export function isCommandActive(
  id: CommandActionId,
  handlers: WorkspaceCommandHandlers,
  palettesHidden: boolean
): boolean {
  if (id === 'flip-h') return Boolean(handlers.flipX);
  if (id === 'flip-v') return Boolean(handlers.flipY);
  if (id === 'toggle-palettes') return palettesHidden;
  return false;
}

interface CommandBarProps {
  handlers: WorkspaceCommandHandlers;
  themePreset?: ThemePreset;
}

export const CommandBar: React.FC<CommandBarProps> = React.memo(({
  handlers,
  themePreset: _themePreset = 'modern',
}) => {
  const commandBarIds = useWorkspaceStore((s) => s.commandBarIds);
  const showCommandBar = useWorkspaceStore((s) => s.showCommandBar);
  const activePreset = useWorkspaceStore((s) => s.activePreset);
  const palettesHidden = useWorkspaceStore((s) => s.palettesHidden);

  const [isCustomizeOpen, setIsCustomizeOpen] = useState(false);
  const [isPresetMenuOpen, setIsPresetMenuOpen] = useState(false);
  const customizeRef = useRef<HTMLDivElement>(null);
  const presetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isCustomizeOpen && !isPresetMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (isCustomizeOpen && customizeRef.current && !customizeRef.current.contains(target)) {
        setIsCustomizeOpen(false);
      }
      if (isPresetMenuOpen && presetRef.current && !presetRef.current.contains(target)) {
        setIsPresetMenuOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsCustomizeOpen(false);
        setIsPresetMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKey);
    };
  }, [isCustomizeOpen, isPresetMenuOpen]);

  const catalogById = React.useMemo(() => {
    const map = new Map(COMMAND_CATALOG.map((c) => [c.id, c]));
    return map;
  }, []);

  const presets: WorkspacePresetId[] = [
    'default-illustration',
    'manga-studio',
    'minimalist-tablet',
    'custom',
  ];

  return (
    <div
      data-testid="command-bar"
      className="flex items-center gap-1 min-w-0"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Customizable Command Buttons */}
      {showCommandBar && (
        <div className="flex items-center gap-0.5 px-1 h-6 rounded overflow-x-auto no-scrollbar bg-[#161616]">
          {commandBarIds.map((cmdId) => {
            const entry = catalogById.get(cmdId);
            if (!entry) return null;
            const disabled = isCommandDisabled(cmdId, handlers);
            const active = isCommandActive(cmdId, handlers, palettesHidden);

            return (
              <button
                key={cmdId}
                type="button"
                disabled={disabled}
                onClick={() => executeWorkspaceCommand(cmdId, handlers)}
                title={`${entry.label}${entry.shortcut ? ` (${entry.shortcut})` : ''}`}
                aria-label={entry.label}
                aria-pressed={active || undefined}
                className={`w-5 h-5 rounded flex items-center justify-center transition-colors shrink-0 ${
                  disabled
                    ? 'opacity-30 cursor-not-allowed text-[#8a8a8a]'
                    : active
                    ? 'bg-[#2c2c2c] text-[var(--accent)] cursor-pointer'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer'
                }`}
              >
                {renderCommandIcon(cmdId, palettesHidden)}
              </button>
            );
          })}

          {/* Customize Command Bar Button */}
          <div className="relative" ref={customizeRef}>
            <button
              type="button"
              onClick={() => {
                setIsPresetMenuOpen(false);
                setIsCustomizeOpen((v) => !v);
              }}
              title="Customize Command Bar"
              aria-label="Customize Command Bar"
              className={`w-5 h-5 rounded flex items-center justify-center transition-colors cursor-pointer ${
                isCustomizeOpen
                  ? 'bg-[#2c2c2c] text-[var(--accent)]'
                  : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
              }`}
            >
              <SlidersHorizontal className="w-3 h-3" />
            </button>

            {isCustomizeOpen && (
              <div className="fixed top-9 left-1/2 -translate-x-1/2 w-64 rounded-md shadow-2xl p-2 z-50 text-[11px] bg-[#202020] border border-white/[0.1] text-[#e5e5e5]">
                <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-white/[0.08]">
                  <span className="font-medium text-xs">Command Bar</span>
                  <button
                    type="button"
                    onClick={() => workspaceStoreActions.resetCommandBar()}
                    className="text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
                  >
                    Reset
                  </button>
                </div>

                {/* Active order */}
                {commandBarIds.length > 0 && (
                  <div className="mb-2 space-y-0.5 max-h-32 overflow-y-auto">
                    <div className="text-[10px] uppercase tracking-wider text-[#8a8a8a] px-1 mb-0.5">
                      Pinned ({commandBarIds.length})
                    </div>
                    {commandBarIds.map((cid, idx) => {
                      const entry = catalogById.get(cid);
                      if (!entry) return null;
                      return (
                        <div
                          key={cid}
                          className="flex items-center justify-between gap-1 px-1.5 py-0.5 rounded bg-[#161616]"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            {renderCommandIcon(cid)}
                            <span className="truncate">{entry.label}</span>
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => workspaceStoreActions.moveCommandBarItem(cid, -1)}
                              className="p-0.5 text-[#8a8a8a] hover:text-white disabled:opacity-25 cursor-pointer"
                              title="Move left"
                            >
                              <ChevronUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === commandBarIds.length - 1}
                              onClick={() => workspaceStoreActions.moveCommandBarItem(cid, 1)}
                              className="p-0.5 text-[#8a8a8a] hover:text-white disabled:opacity-25 cursor-pointer"
                              title="Move right"
                            >
                              <ChevronDown className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => workspaceStoreActions.toggleCommandBarItem(cid)}
                              className="p-0.5 text-[#8a8a8a] hover:text-rose-400 cursor-pointer"
                              title="Remove"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Toggle all catalog commands */}
                <div className="text-[10px] uppercase tracking-wider text-[#8a8a8a] px-1 mb-0.5">
                  Available Commands
                </div>
                <div className="max-h-44 overflow-y-auto space-y-0.5">
                  {COMMAND_CATALOG.map((entry) => {
                    const pinned = commandBarIds.includes(entry.id);
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => workspaceStoreActions.toggleCommandBarItem(entry.id)}
                        className={`w-full flex items-center justify-between gap-2 px-1.5 py-1 rounded text-left transition-colors cursor-pointer ${
                          pinned
                            ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                            : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                        }`}
                      >
                        <span className="flex items-center gap-1.5 min-w-0">
                          {renderCommandIcon(entry.id)}
                          <span className="truncate">{entry.label}</span>
                        </span>
                        {pinned && <Check className="w-3 h-3 text-[var(--accent)] shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Workspace Preset Selector */}
      <div className="relative shrink-0" ref={presetRef}>
        <button
          type="button"
          onClick={() => {
            setIsCustomizeOpen(false);
            setIsPresetMenuOpen((v) => !v);
          }}
          data-testid="workspace-preset-trigger"
          title="Workspace Presets & Layout"
          className="h-6 px-2 rounded flex items-center gap-1 text-[11px] transition-colors cursor-pointer bg-[#161616] hover:bg-[#2c2c2c] text-[#cccccc] hover:text-white"
        >
          <LayoutGrid className="w-3 h-3 text-[var(--accent)]" />
          <span className="hidden xl:inline max-w-[116px] truncate">
            {WORKSPACE_PRESET_LABELS[activePreset]}
          </span>
          <ChevronDown className="w-3 h-3 text-[#8a8a8a]" />
        </button>

        {isPresetMenuOpen && (
          <div
            data-testid="workspace-preset-menu"
            className="absolute top-7 right-0 w-52 rounded-md shadow-2xl p-1 z-50 text-[11px] bg-[#202020] border border-white/[0.1] text-[#e5e5e5]"
          >
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-[#8a8a8a]">
              Workspace Presets
            </div>
            {presets.map((preset) => {
              const selected = activePreset === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => {
                    workspaceStoreActions.applyPreset(preset);
                    setIsPresetMenuOpen(false);
                  }}
                  className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-left transition-colors cursor-pointer ${
                    selected
                      ? 'bg-[#2c2c2c] text-white font-medium'
                      : 'text-[#cccccc] hover:bg-[#2c2c2c]/60 hover:text-white'
                  }`}
                >
                  <span>{WORKSPACE_PRESET_LABELS[preset]}</span>
                  {selected && <Check className="w-3 h-3 text-[var(--accent)]" />}
                </button>
              );
            })}

            <div className="my-1 h-px bg-white/[0.08]" />

            <button
              type="button"
              onClick={() => {
                workspaceStoreActions.togglePalettesHidden();
                setIsPresetMenuOpen(false);
              }}
              className="w-full flex items-center justify-between px-2 py-1.5 rounded text-left text-[#cccccc] hover:bg-[#2c2c2c]/60 hover:text-white cursor-pointer"
            >
              <span>{palettesHidden ? 'Show Palettes' : 'Hide Palettes'}</span>
              <span className="text-[10px] font-mono text-[#8a8a8a]">Tab</span>
            </button>

            <button
              type="button"
              onClick={() => {
                workspaceStoreActions.resetWorkspace();
                setIsPresetMenuOpen(false);
              }}
              data-testid="reset-workspace-btn"
              className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-left text-amber-300 hover:bg-[#2c2c2c]/60 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset Workspace</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

CommandBar.displayName = 'CommandBar';
