import React, { useState } from 'react';
import { X, Plus, File } from 'lucide-react';
import { DocumentTab } from '../types/editor';
import { ThemePreset } from '../types/settings';

export interface DocumentTabBarProps {
  documents: DocumentTab[];
  activeDocumentId: string | null;
  onSelectDocument: (id: string) => void;
  onCloseDocument: (id: string) => void;
  onNewDocument: () => void;
  onRenameDocument?: (id: string, newName: string) => void;
  themePreset?: ThemePreset;
}

export const DocumentTabBar: React.FC<DocumentTabBarProps> = React.memo(({
  documents,
  activeDocumentId,
  onSelectDocument,
  onCloseDocument,
  onNewDocument,
  onRenameDocument,
  themePreset: _themePreset = 'modern',
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');

  const handleStartRename = (e: React.MouseEvent, doc: DocumentTab) => {
    e.stopPropagation();
    setEditingId(doc.id);
    setEditingName(doc.name);
  };

  const handleFinishRename = (id: string) => {
    if (editingName.trim() && onRenameDocument) {
      onRenameDocument(id, editingName.trim());
    }
    setEditingId(null);
  };

  return (
    <div
      data-testid="document-tab-bar"
      data-theme-preset="modern"
      className="h-7 flex items-center px-1.5 select-none z-20 shrink-0 overflow-x-auto no-scrollbar bg-[#1a1a1a] border-b border-white/[0.06]"
    >
      <div className="flex items-center space-x-1 h-full py-0.5">
        {documents.map((doc) => {
          const isActive = doc.id === activeDocumentId;
          const isDirty = Boolean(doc.isDirty);

          return (
            <div
              key={doc.id}
              onClick={() => onSelectDocument(doc.id)}
              onDoubleClick={(e) => handleStartRename(e, doc)}
              title={`${doc.name}${isDirty ? ' *' : ''} (${doc.dimensions.width}×${doc.dimensions.height}px)`}
              className={`group relative h-full flex items-center space-x-1.5 px-2.5 rounded text-[11px] cursor-pointer transition-colors ${
                isActive
                  ? 'bg-[#262626] text-[#e5e5e5] font-medium border border-white/[0.08]'
                  : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 border border-transparent'
              }`}
            >
              <File
                className={`w-3 h-3 shrink-0 ${
                  isActive ? 'text-[var(--accent)]' : 'text-[#666666]'
                }`}
              />

              {editingId === doc.id ? (
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={() => handleFinishRename(doc.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleFinishRename(doc.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  className="bg-[#161616] text-[#e5e5e5] text-[11px] px-1 py-0.5 rounded-sm outline-none border border-[var(--accent)] w-28"
                />
              ) : (
                <span className="truncate max-w-[160px] tracking-normal">
                  {doc.name}
                  {isDirty && (
                    <span
                      data-testid={`dirty-indicator-${doc.id}`}
                      className="ml-0.5 text-[var(--accent)] font-bold"
                      title="Unsaved changes"
                    >
                      *
                    </span>
                  )}
                </span>
              )}

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseDocument(doc.id);
                }}
                aria-label={`Close ${doc.name}`}
                title="Close file"
                className={`p-0.5 rounded transition-colors cursor-pointer ${
                  isActive
                    ? 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-white/10'
                    : 'text-transparent group-hover:text-[#8a8a8a] hover:!text-[#e5e5e5] hover:bg-white/10'
                }`}
              >
                <X className="w-3 h-3" />
              </button>

              {isActive && (
                <div className="absolute bottom-0 left-2 right-2 h-[2px] bg-[var(--accent)] rounded-full" />
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onNewDocument}
        aria-label="New Document"
        title="Create New File (Ctrl+N)"
        className="ml-1 p-1 rounded transition-colors flex items-center justify-center shrink-0 cursor-pointer text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  );
});

DocumentTabBar.displayName = 'DocumentTabBar';
