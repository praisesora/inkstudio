import React, { useCallback, useEffect } from 'react';
import { HelpCircle, Loader2, X } from 'lucide-react';
import { uiStoreActions, useDocumentStore, useUiStore } from '../stores';
import {
  SaveDocumentResult,
  cancelAppClose,
  finalizeAppClose,
  findNextPendingDirtyIndex,
  formatCanvasDisplayName,
} from '../utils/appCloseFlow';

export interface CloseConfirmModalProps {
  onSaveDocumentById: (docId: string) => Promise<SaveDocumentResult>;
  onFinalizeClose?: () => Promise<void>;
}

export const CloseConfirmModal: React.FC<CloseConfirmModalProps> = React.memo(
  ({ onSaveDocumentById, onFinalizeClose }) => {
    const prompt = useUiStore((s) => s.appClosePrompt);
    const documents = useDocumentStore((s) => s.documents);

    const runFinalize = useCallback(async () => {
      if (onFinalizeClose) {
        await onFinalizeClose();
      } else {
        await finalizeAppClose();
      }
    }, [onFinalizeClose]);

    const handleCancel = useCallback(() => {
      cancelAppClose();
    }, []);

    useEffect(() => {
      if (!prompt.isOpen) return;
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && !useUiStore.getState().appClosePrompt.isBusy) {
          e.preventDefault();
          e.stopPropagation();
          cancelAppClose();
        }
      };
      window.addEventListener('keydown', handleKeyDown, true);
      return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [prompt.isOpen]);

    const advanceOrFinalize = useCallback(
      async (afterIndex: number, pendingDocIds: string[]) => {
        const latestDocs = useDocumentStore.getState().documents;
        const nextIdx = findNextPendingDirtyIndex(pendingDocIds, afterIndex, latestDocs);
        if (nextIdx >= 0) {
          uiStoreActions.setAppClosePrompt((prev) => ({
            ...prev,
            step: 'per-canvas',
            currentIndex: nextIdx,
            isBusy: false,
          }));
        } else {
          await runFinalize();
        }
      },
      [runFinalize]
    );

    const handleConfirmChanges = useCallback(async () => {
      const state = useUiStore.getState().appClosePrompt;
      if (state.isBusy) return;
      const latestDocs = useDocumentStore.getState().documents;
      const stillDirtyIds = state.pendingDocIds.filter((id) =>
        latestDocs.some((d) => d.id === id && d.isDirty)
      );
      if (stillDirtyIds.length === 0) {
        await runFinalize();
        return;
      }
      uiStoreActions.setAppClosePrompt({
        isOpen: true,
        step: 'per-canvas',
        pendingDocIds: stillDirtyIds,
        currentIndex: 0,
        isBusy: false,
      });
    }, [runFinalize]);

    const handleDiscardAll = useCallback(async () => {
      if (useUiStore.getState().appClosePrompt.isBusy) return;
      await runFinalize();
    }, [runFinalize]);

    const handleSaveCurrent = useCallback(async () => {
      const state = useUiStore.getState().appClosePrompt;
      if (state.isBusy || state.step !== 'per-canvas') return;

      const targetDocId = state.pendingDocIds[state.currentIndex];
      if (!targetDocId) {
        await runFinalize();
        return;
      }

      uiStoreActions.setAppClosePrompt((prev) => ({ ...prev, isBusy: true }));
      const result = await onSaveDocumentById(targetDocId);
      if (result === 'saved') {
        await advanceOrFinalize(state.currentIndex, state.pendingDocIds);
      } else {
        // Keep modal open on the same canvas if user canceled the Save dialog or save failed.
        uiStoreActions.setAppClosePrompt((prev) =>
          prev.isOpen ? { ...prev, isBusy: false } : prev
        );
      }
    }, [advanceOrFinalize, onSaveDocumentById, runFinalize]);

    const handleDoNotSaveCurrent = useCallback(async () => {
      const state = useUiStore.getState().appClosePrompt;
      if (state.isBusy || state.step !== 'per-canvas') return;
      await advanceOrFinalize(state.currentIndex, state.pendingDocIds);
    }, [advanceOrFinalize]);

    if (!prompt.isOpen) return null;

    const currentDocId = prompt.pendingDocIds[prompt.currentIndex];
    const currentDoc = currentDocId ? documents.find((d) => d.id === currentDocId) : undefined;
    const currentDocName = formatCanvasDisplayName(currentDoc?.name);
    const totalPending = prompt.pendingDocIds.length;
    const stepKey = `${prompt.step}-${prompt.currentIndex}`;

    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-confirm-modal-title"
        data-testid="close-confirm-modal"
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 select-none"
      >
        <div className="bg-[#202020] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.85)] w-full max-w-[430px] overflow-hidden text-xs text-[#e5e5e5] border border-[#2c2c2c]">
          {/* Title Bar */}
          <div className="h-9 px-3.5 flex items-center justify-between bg-[#161616] border-b border-[#2c2c2c]">
            <div className="flex items-center gap-2 min-w-0">
              <span
                id="close-confirm-modal-title"
                className="text-xs font-medium text-[#e5e5e5] tracking-wide"
              >
                Ink Studio
              </span>
              {prompt.step === 'per-canvas' && totalPending > 1 && (
                <span className="text-[10px] font-mono text-[#8a8a8a] bg-[#262626] px-1.5 py-0.5 rounded">
                  {prompt.currentIndex + 1} / {totalPending}
                </span>
              )}
            </div>
            {!prompt.isBusy && (
              <button
                type="button"
                onClick={handleCancel}
                aria-label="Cancel close"
                title="Cancel (Esc)"
                className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Body */}
          <div className="px-5 py-5 flex items-start gap-3.5">
            <div className="w-9 h-9 rounded-full bg-[#2a2a2a] border border-[#3a3a3a] flex items-center justify-center shrink-0 mt-0.5 text-[#bdbdbd]">
              <HelpCircle className="w-5 h-5" />
            </div>

            <div className="flex-1 min-w-0 space-y-1 text-[12.5px] leading-relaxed text-[#e5e5e5]">
              {prompt.step === 'confirm-quit' && (
                <p>Are you sure you want to close Ink Studio?</p>
              )}

              {prompt.step === 'summary' && (
                <>
                  <p>
                    There are <span className="font-semibold text-white">{totalPending}</span>{' '}
                    canvases with unsaved changes.
                  </p>
                  <p className="text-[#c8c8c8]">
                    Do you want to confirm these changes before closing?
                  </p>
                </>
              )}

              {prompt.step === 'per-canvas' && (
                <p className="break-words">
                  <span className="font-semibold text-white">{currentDocName}</span> has been
                  changed. Do you want to save it?
                </p>
              )}
            </div>
          </div>

          {/* Actions */}
          <div
            key={stepKey}
            className="px-4 py-3 bg-[#161616] border-t border-[#2c2c2c] flex items-center justify-end gap-2"
          >
            {prompt.step === 'confirm-quit' && (
              <>
                <button
                  type="button"
                  autoFocus
                  disabled={prompt.isBusy}
                  onClick={() => void handleDiscardAll()}
                  className="px-3.5 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-50 font-medium transition-opacity cursor-pointer inline-flex items-center gap-1.5"
                >
                  {prompt.isBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Close</span>
                </button>
                <button
                  type="button"
                  disabled={prompt.isBusy}
                  onClick={handleCancel}
                  className="px-3.5 py-1.5 rounded bg-[#2a2a2a] hover:bg-[#363636] disabled:opacity-50 text-[#e5e5e5] transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </>
            )}

            {prompt.step === 'summary' && (
              <>
                <button
                  type="button"
                  autoFocus
                  disabled={prompt.isBusy}
                  onClick={() => void handleConfirmChanges()}
                  className="px-3.5 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-50 font-medium transition-opacity cursor-pointer"
                >
                  Confirm changes...
                </button>
                <button
                  type="button"
                  disabled={prompt.isBusy}
                  onClick={() => void handleDiscardAll()}
                  className="px-3.5 py-1.5 rounded bg-[#2a2a2a] hover:bg-[#363636] disabled:opacity-50 text-[#e5e5e5] transition-colors cursor-pointer inline-flex items-center gap-1.5"
                >
                  {prompt.isBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>Discard changes</span>
                </button>
                <button
                  type="button"
                  disabled={prompt.isBusy}
                  onClick={handleCancel}
                  className="px-3.5 py-1.5 rounded bg-[#2a2a2a] hover:bg-[#363636] disabled:opacity-50 text-[#e5e5e5] transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </>
            )}

            {prompt.step === 'per-canvas' && (
              <>
                <button
                  type="button"
                  autoFocus
                  disabled={prompt.isBusy}
                  onClick={() => void handleSaveCurrent()}
                  className="px-4 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-50 font-medium transition-opacity cursor-pointer inline-flex items-center gap-1.5"
                >
                  {prompt.isBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>{prompt.isBusy ? 'Saving...' : 'Save'}</span>
                </button>
                <button
                  type="button"
                  disabled={prompt.isBusy}
                  onClick={() => void handleDoNotSaveCurrent()}
                  className="px-3.5 py-1.5 rounded bg-[#2a2a2a] hover:bg-[#363636] disabled:opacity-50 text-[#e5e5e5] transition-colors cursor-pointer"
                >
                  Do Not Save
                </button>
                <button
                  type="button"
                  disabled={prompt.isBusy}
                  onClick={handleCancel}
                  className="px-3.5 py-1.5 rounded bg-[#2a2a2a] hover:bg-[#363636] disabled:opacity-50 text-[#e5e5e5] transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
);

CloseConfirmModal.displayName = 'CloseConfirmModal';
