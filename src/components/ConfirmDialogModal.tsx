import React, { useEffect } from 'react';
import { AlertTriangle, HelpCircle, Paintbrush, Trash2, X } from 'lucide-react';
import { uiStoreActions, useUiStore } from '../stores';

export const ConfirmDialogModal: React.FC = React.memo(() => {
  const dialog = useUiStore((s) => s.appDialog);

  useEffect(() => {
    if (!dialog.isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        uiStoreActions.resolveAppDialog(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [dialog.isOpen]);

  if (!dialog.isOpen) return null;

  const isDanger = dialog.variant === 'danger';
  const isAlert = dialog.variant === 'alert';

  const handleCancel = () => {
    uiStoreActions.resolveAppDialog(false);
  };

  const handleConfirm = () => {
    uiStoreActions.resolveAppDialog(true);
  };

  return (
    <div
      role={isAlert ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby="app-confirm-dialog-title"
      data-testid="app-confirm-dialog"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 select-none"
      onClick={handleCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#202020] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.85)] w-full max-w-[420px] overflow-hidden text-xs text-[#e5e5e5] border border-[#2c2c2c]"
      >
        {/* Title Bar */}
        <div className="h-9 px-3.5 flex items-center justify-between bg-[#161616] border-b border-[#2c2c2c]">
          <div className="flex items-center gap-2 min-w-0">
            {isDanger ? (
              <Trash2 className="w-3.5 h-3.5 text-red-400 shrink-0" />
            ) : isAlert ? (
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            ) : (
              <HelpCircle className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
            )}
            <span
              id="app-confirm-dialog-title"
              className="text-xs font-medium text-[#e5e5e5] tracking-wide truncate"
            >
              {dialog.title}
            </span>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            aria-label="Close"
            title="Cancel (Esc)"
            className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          {dialog.preview && (
            <div className="bg-[#161616] border border-[#2c2c2c] rounded-md p-2.5 flex items-center gap-3">
              <div className="w-10 h-10 bg-[#202020] border border-[#2c2c2c] overflow-hidden shrink-0 flex items-center justify-center rounded">
                {dialog.preview.imageUrl ? (
                  <img
                    src={dialog.preview.imageUrl}
                    alt={dialog.preview.title}
                    className="w-7 h-7 object-contain brightness-125"
                  />
                ) : (
                  <Paintbrush className="w-4 h-4 text-[#8a8a8a]" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className="text-xs font-medium text-[#e5e5e5] truncate"
                  title={dialog.preview.title}
                >
                  {dialog.preview.title}
                </div>
                {dialog.preview.subtitle && (
                  <div
                    className="text-[10px] text-[#8a8a8a] truncate mt-0.5"
                    title={dialog.preview.subtitle}
                  >
                    {dialog.preview.subtitle}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex items-start gap-3">
            {!dialog.preview && (
              <div
                className={`w-8 h-8 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${
                  isDanger
                    ? 'bg-red-500/10 border-red-500/25 text-red-400'
                    : isAlert
                      ? 'bg-amber-500/10 border-amber-500/25 text-amber-400'
                      : 'bg-[#2a2a2a] border-[#3a3a3a] text-[#bdbdbd]'
                }`}
              >
                {isDanger ? (
                  <Trash2 className="w-4 h-4" />
                ) : isAlert ? (
                  <AlertTriangle className="w-4 h-4" />
                ) : (
                  <HelpCircle className="w-4 h-4" />
                )}
              </div>
            )}

            <div className="flex-1 min-w-0 space-y-1">
              <p className="text-[12.5px] leading-relaxed text-[#e5e5e5] whitespace-pre-line break-words">
                {dialog.message}
              </p>
              {dialog.detail && (
                <p className="text-[11px] leading-relaxed text-[#8a8a8a] whitespace-pre-line break-words">
                  {dialog.detail}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-[#161616] border-t border-[#2c2c2c] flex items-center justify-end gap-2">
          {!isAlert && (
            <button
              type="button"
              onClick={handleCancel}
              className="px-3.5 py-1.5 rounded bg-[#2a2a2a] hover:bg-[#363636] text-xs font-medium text-[#e5e5e5] transition-colors cursor-pointer"
            >
              {dialog.cancelLabel}
            </button>
          )}
          <button
            type="button"
            autoFocus
            onClick={handleConfirm}
            className={
              isDanger
                ? 'px-3.5 py-1.5 rounded bg-red-500/90 hover:bg-red-500 text-xs font-medium text-white transition-colors cursor-pointer inline-flex items-center gap-1.5'
                : 'px-4 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 text-xs font-medium transition-opacity cursor-pointer'
            }
          >
            {isDanger && <Trash2 className="w-3.5 h-3.5" />}
            <span>{dialog.confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
});

ConfirmDialogModal.displayName = 'ConfirmDialogModal';
