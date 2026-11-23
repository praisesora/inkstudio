import React, { useEffect } from 'react';
import { Trash2, EyeOff, AlertTriangle, X, FileText } from 'lucide-react';
import { RecentDocument, formatFileSize } from '../utils/recentDocumentsManager';

interface DeleteDocumentModalProps {
  isOpen: boolean;
  document: RecentDocument | null;
  onClose: () => void;
  onHideFromApp: (doc: RecentDocument) => void;
  onPermanentlyDelete: (doc: RecentDocument) => void;
}

export const DeleteDocumentModal: React.FC<DeleteDocumentModalProps> = ({
  isOpen,
  document,
  onClose,
  onHideFromApp,
  onPermanentlyDelete,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose]);

  if (!isOpen || !document) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-document-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 select-none"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#202020] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.85)] w-full max-w-[430px] overflow-hidden text-xs text-[#e5e5e5] border border-[#2c2c2c]"
      >
        {/* Title Bar */}
        <div className="h-9 px-3.5 flex items-center justify-between bg-[#161616] border-b border-[#2c2c2c]">
          <div className="flex items-center gap-2 min-w-0">
            <Trash2 className="w-3.5 h-3.5 text-red-400 shrink-0" />
            <span
              id="delete-document-modal-title"
              className="text-xs font-medium text-[#e5e5e5] tracking-wide"
            >
              Delete Document
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Cancel (Esc)"
            className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3">
          {/* Target File Info */}
          <div className="bg-[#161616] border border-[#2c2c2c] rounded-md p-2.5 flex items-center gap-3">
            <div className="w-11 h-11 bg-[#202020] border border-[#2c2c2c] overflow-hidden shrink-0 flex items-center justify-center rounded">
              {document.coverUrl ? (
                <img
                  src={document.coverUrl}
                  alt={document.title}
                  className="w-full h-full object-cover"
                />
              ) : (
                <FileText className="w-4 h-4 text-[#8a8a8a]" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-[#e5e5e5] truncate" title={document.title}>
                {document.title}
              </div>
              <div className="text-[10px] text-[#8a8a8a] font-mono truncate mt-0.5" title={document.path}>
                {formatFileSize(document.size)} • {document.path}
              </div>
            </div>
          </div>

          <div className="text-[11px] font-medium text-[#8a8a8a] uppercase tracking-wider pt-0.5">
            Select action
          </div>

          <div className="space-y-2">
            {/* Action 1: Remove from list */}
            <button
              type="button"
              onClick={() => onHideFromApp(document)}
              className="w-full flex items-start gap-3 p-3 rounded-md bg-[#262626] hover:bg-[#2c2c2c] border border-[#2c2c2c] hover:border-[#3a3a3a] text-left transition-colors cursor-pointer"
            >
              <div className="w-7 h-7 rounded bg-[#161616] border border-[#2c2c2c] flex items-center justify-center shrink-0 text-[#8a8a8a]">
                <EyeOff className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-[#e5e5e5]">
                  Remove from Recent List
                </div>
                <div className="text-[11px] text-[#8a8a8a] mt-0.5 leading-snug">
                  Removes entry from the studio. Keeps the file intact on disk.
                </div>
              </div>
            </button>

            {/* Action 2: Permanently delete */}
            <button
              type="button"
              onClick={() => onPermanentlyDelete(document)}
              className="w-full flex items-start gap-3 p-3 rounded-md bg-red-500/[0.08] hover:bg-red-500/[0.14] border border-red-500/25 hover:border-red-500/45 text-left transition-colors cursor-pointer"
            >
              <div className="w-7 h-7 rounded bg-red-500/15 border border-red-500/25 flex items-center justify-center shrink-0 text-red-400">
                <AlertTriangle className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-red-300">
                  Permanently Delete from Disk
                </div>
                <div className="text-[11px] text-red-300/70 mt-0.5 leading-snug">
                  Erases file permanently from storage. Cannot be undone.
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-[#161616] border-t border-[#2c2c2c] flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded bg-[#2a2a2a] hover:bg-[#363636] text-xs font-medium text-[#e5e5e5] transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
