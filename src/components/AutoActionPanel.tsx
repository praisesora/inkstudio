import React, { useState } from 'react';
import {
  Play,
  Circle,
  Square,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Download,
  Upload,
  FolderPlus,
} from 'lucide-react';
import {
  AutoAction,
  exportAutoActionSetsJson,
  importAutoActionSetsJson,
} from '../utils/autoActionEngine';
import { autoActionStoreActions, useAutoActionStore } from '../stores';
import { downloadFile } from '../utils/saveManager';

export interface AutoActionPanelProps {
  hasOpenDocument: boolean;
  onPlayAction: (action: AutoAction) => void;
  showToast?: (msg: string) => void;
}

export const AutoActionPanel: React.FC<AutoActionPanelProps> = React.memo(
  ({ hasOpenDocument, onPlayAction, showToast }) => {
    const sets = useAutoActionStore((s) => s.sets);
    const activeSetId = useAutoActionStore((s) => s.activeSetId);
    const selectedActionId = useAutoActionStore((s) => s.selectedActionId);
    const isRecording = useAutoActionStore((s) => s.isRecording);
    const recordingActionId = useAutoActionStore((s) => s.recordingActionId);
    const isPlaying = useAutoActionStore((s) => s.isPlaying);

    const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
    const [newActionName, setNewActionName] = useState('');

    const activeSet = sets.find((s) => s.id === activeSetId) ?? sets[0];
    const selectedAction =
      activeSet?.actions.find((a) => a.id === selectedActionId) ?? activeSet?.actions[0] ?? null;

    const toggleExpand = (id: string) => {
      setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
    };

    const handleCreateAction = () => {
      const created = autoActionStoreActions.createAction(newActionName || undefined);
      setNewActionName('');
      setExpandedIds((prev) => ({ ...prev, [created.id]: true }));
    };

    const handleCreateSet = () => {
      const name = `Action Set ${sets.length + 1}`;
      autoActionStoreActions.createSet(name);
      showToast?.(`Created set "${name}"`);
    };

    const handleToggleRecord = () => {
      if (isRecording) {
        autoActionStoreActions.stopRecording();
        showToast?.('Auto Action recording stopped');
      } else {
        const id = autoActionStoreActions.startRecording(selectedAction?.id);
        setExpandedIds((prev) => ({ ...prev, [id]: true }));
        showToast?.('Recording Auto Action steps...');
      }
    };

    const handleExportJson = () => {
      const json = exportAutoActionSetsJson(sets);
      downloadFile(new Blob([json], { type: 'application/json' }), 'inkstudio-auto-actions.json', 'application/json');
      showToast?.('Exported Auto Action sets');
    };

    const handleImportJson = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const text = await file.text();
          const imported = importAutoActionSetsJson(text);
          autoActionStoreActions.replaceSets(imported);
          showToast?.(`Imported ${imported.length} Auto Action set(s)`);
        } catch (err) {
          showToast?.(err instanceof Error ? err.message : 'Failed to import Auto Actions');
        }
      };
      input.click();
    };

    return (
      <div className="flex flex-col h-full w-full bg-[#202020] text-[#e5e5e5] select-none overflow-hidden">
        {/* Set Selector & Toolbar */}
        <div className="p-2 border-b border-[#2c2c2c] space-y-1.5 shrink-0">
          <div className="flex items-center gap-1">
            <select
              value={activeSet?.id ?? ''}
              onChange={(e) => autoActionStoreActions.selectSet(e.target.value)}
              className="flex-1 bg-[#161616] text-[11px] text-[#e5e5e5] px-1.5 py-1 rounded border border-[#2c2c2c] min-w-0"
            >
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleCreateSet}
              title="New Action Set"
              className="p-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
            >
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleImportJson}
              title="Import Action Sets (.json)"
              className="p-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleExportJson}
              title="Export Action Sets (.json)"
              className="p-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex items-center gap-1">
            <input
              type="text"
              value={newActionName}
              onChange={(e) => setNewActionName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateAction();
              }}
              placeholder="New action name..."
              className="flex-1 bg-[#161616] text-[11px] text-[#e5e5e5] px-2 py-1 rounded border border-[#2c2c2c] min-w-0 focus:outline-none focus:border-[var(--accent-border)]"
            />
            <button
              type="button"
              onClick={handleCreateAction}
              title="Create Auto Action"
              className="p-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[#e5e5e5] cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Recording Status Banner */}
        {isRecording && (
          <div className="px-2.5 py-1 bg-rose-500/15 border-b border-rose-500/30 flex items-center justify-between text-[10px] text-rose-300 shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
              <span>Recording commands...</span>
            </div>
            <button
              type="button"
              onClick={() => autoActionStoreActions.stopRecording()}
              className="px-1.5 py-0.5 rounded bg-rose-500/25 hover:bg-rose-500/40 text-rose-100 cursor-pointer"
            >
              Stop
            </button>
          </div>
        )}

        {/* Action List */}
        <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
          {!activeSet || activeSet.actions.length === 0 ? (
            <div className="text-[11px] text-[#8a8a8a] text-center py-6">
              No actions in this set. Click + to create one.
            </div>
          ) : (
            activeSet.actions.map((action) => {
              const isSelected = action.id === selectedAction?.id;
              const isExpanded = Boolean(expandedIds[action.id]);
              const isRecThis = isRecording && recordingActionId === action.id;

              return (
                <div
                  key={action.id}
                  className={`rounded border transition-colors ${
                    isSelected
                      ? 'bg-[#2c2c2c] border-[#3a3a3a]'
                      : 'bg-[#161616] border-[#262626] hover:border-[#2c2c2c]'
                  }`}
                >
                  <div
                    onClick={() => autoActionStoreActions.selectAction(action.id)}
                    className="flex items-center gap-1 px-1.5 py-1.5 cursor-pointer"
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(action.id);
                      }}
                      className="text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                    </button>

                    <span className="flex-1 text-[11px] font-medium truncate">
                      {action.name}
                    </span>

                    <span className="text-[9px] font-mono text-[#8a8a8a] mr-1">
                      {action.steps.length}
                    </span>

                    {isRecThis && (
                      <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse mr-0.5" />
                    )}

                    <button
                      type="button"
                      disabled={!hasOpenDocument || isPlaying || action.steps.length === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlayAction(action);
                      }}
                      title="Play Auto Action"
                      className="p-1 rounded bg-[#161616] hover:bg-[var(--accent)] hover:text-[var(--accent-contrast)] text-[#e5e5e5] disabled:opacity-35 cursor-pointer transition-colors"
                    >
                      <Play className="w-3 h-3" />
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        autoActionStoreActions.deleteAction(action.id);
                      }}
                      title="Delete Action"
                      className="p-1 rounded hover:bg-rose-500/20 text-[#8a8a8a] hover:text-rose-400 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="px-2 pb-1.5 pt-1 space-y-1 border-t border-[#2c2c2c]">
                      {action.steps.length === 0 ? (
                        <div className="text-[10px] text-[#8a8a8a] italic py-1">
                          Empty. Press Record and perform layer/filter commands.
                        </div>
                      ) : (
                        action.steps.map((step) => (
                          <div
                            key={step.id}
                            className="flex items-center gap-1.5 text-[10px] text-[#d4d4d4] bg-[#202020] rounded px-1.5 py-1"
                          >
                            <input
                              type="checkbox"
                              checked={step.enabled !== false}
                              onChange={() =>
                                autoActionStoreActions.toggleStepEnabled(action.id, step.id)
                              }
                              className="cursor-pointer"
                            />
                            <span
                              className={`flex-1 truncate ${
                                step.enabled === false ? 'line-through opacity-50' : ''
                              }`}
                            >
                              {step.label}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                autoActionStoreActions.deleteStep(action.id, step.id)
                              }
                              className="text-[#777777] hover:text-rose-400 cursor-pointer"
                              title="Remove step"
                            >
                              <Trash2 className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Bottom Transport Bar */}
        <div className="p-2 border-t border-[#2c2c2c] flex items-center justify-between gap-1.5 shrink-0 bg-[#161616]">
          <button
            type="button"
            disabled={!hasOpenDocument || isPlaying}
            onClick={handleToggleRecord}
            className={`flex-1 py-1.5 px-2 rounded text-[11px] font-medium flex items-center justify-center gap-1.5 cursor-pointer transition-colors disabled:opacity-40 ${
              isRecording
                ? 'bg-red-500/90 hover:bg-red-500 text-white'
                : 'bg-[#2a2a2a] hover:bg-[#363636] text-[#e5e5e5]'
            }`}
          >
            {isRecording ? (
              <>
                <Square className="w-3 h-3 fill-current" />
                <span>Stop</span>
              </>
            ) : (
              <>
                <Circle className="w-3 h-3 text-red-400 fill-red-400" />
                <span>Record</span>
              </>
            )}
          </button>

          <button
            type="button"
            disabled={!hasOpenDocument || isPlaying || !selectedAction || selectedAction.steps.length === 0}
            onClick={() => selectedAction && onPlayAction(selectedAction)}
            className="flex-1 py-1.5 px-2 rounded text-[11px] font-medium bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 flex items-center justify-center gap-1.5 cursor-pointer transition-opacity disabled:opacity-40"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>Play</span>
          </button>
        </div>
      </div>
    );
  }
);

AutoActionPanel.displayName = 'AutoActionPanel';
