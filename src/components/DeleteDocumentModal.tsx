import React from 'react';
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
  if (!isOpen || !document) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 select-none"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="bg-[#444447] border border-[#242426] rounded-[2px] shadow-[0_8px_24px_rgba(0,0,0,0.7)] w-full max-w-md overflow-hidden text-[#d6d6da]">
        {/* Title Bar */}
        <div className="px-3.5 py-2 border-b border-[#242426] bg-gradient-to-b from-[#525255] to-[#3e3e40] flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Trash2 className="w-3.5 h-3.5 text-rose-400" />
            <span className="text-xs font-semibold text-[#f0f0f4] tracking-wide">
              Delete Document
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-0.5 rounded-[2px] text-[#a0a0a5] hover:text-white hover:bg-[#525255] transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3.5 text-xs">
          {/* Target File Info */}
          <div className="bg-[#2b2b2e] border border-[#1e1e20] rounded-[2px] p-2.5 flex items-center space-x-3 shadow-[inset_1px_1px_2px_rgba(0,0,0,0.4)]">
            <div className="w-10 h-10 bg-[#202022] border border-[#1a1a1c] overflow-hidden shrink-0 flex items-center justify-center rounded-[1px]">
              {document.coverUrl ? (
                <img
                  src={document.coverUrl}
                  alt={document.title}
                  className="w-full h-full object-cover"
                />
              ) : (
                <FileText className="w-5 h-5 text-[#6c6c72]" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-[#f0f0f4] truncate" title={document.title}>
                {document.title}
              </div>
              <div className="text-[10px] text-[#8c8c92] font-mono truncate" title={document.path}>
                {formatFileSize(document.size)} • {document.path}
              </div>
            </div>
          </div>

          <p className="text-[11px] text-[#a0a0a5]">
            Select action:
          </p>

          {/* Action 1: Remove from list */}
          <button
            type="button"
            onClick={() => onHideFromApp(document)}
            className="w-full flex items-start space-x-2.5 p-2.5 rounded-[2px] border border-[#2b2b2e] bg-[#3a3a3d] hover:bg-[#46464a] hover:border-[#525256] text-left transition-colors cursor-pointer"
          >
            <EyeOff className="w-4 h-4 text-[#93c5fd] shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-[#f0f0f4]">
                Remove from Recent List
              </div>
              <div className="text-[10px] text-[#8c8c92] mt-0.5">
                Removes entry from the studio. Keeps the file intact on disk.
              </div>
            </div>
          </button>

          {/* Action 2: Permanently delete */}
          <button
            type="button"
            onClick={() => onPermanentlyDelete(document)}
            className="w-full flex items-start space-x-2.5 p-2.5 rounded-[2px] border border-rose-900/50 bg-[#3d2c2f] hover:bg-[#4a3438] hover:border-rose-700/60 text-left transition-colors cursor-pointer"
          >
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-rose-200">
                Permanently Delete from Disk
              </div>
              <div className="text-[10px] text-rose-300/70 mt-0.5">
                Erases file permanently from storage. Cannot be undone.
              </div>
            </div>
          </button>
        </div>

        {/* Footer */}
        <div className="px-4 py-2 bg-[#3a3a3d] border-t border-[#242426] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 rounded-[2px] text-xs font-medium bg-gradient-to-b from-[#56565a] to-[#424245] hover:from-[#626266] hover:to-[#4b4b4e] border border-[#242426] text-[#d6d6da] shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
