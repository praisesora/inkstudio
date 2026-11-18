import React, { useState, useEffect } from 'react';
import {
  FilePlus,
  FolderOpen,
  Search,
  X,
  Star,
  FileText,
} from 'lucide-react';
import {
  RecentDocument,
  loadRecentDocuments,
  toggleStarDocument,
  removeRecentDocument,
  permanentlyDeleteDocument,
  formatFileSize,
} from '../utils/recentDocumentsManager';
import { DeleteDocumentModal } from './DeleteDocumentModal';
import { ThemePreset } from '../types/settings';

interface WelcomeScreenProps {
  userName: string;
  onNewDocument: () => void;
  onOpenFile: () => void;
  onSelectRecentDocument?: (doc: RecentDocument) => void;
  showToast: (msg: string) => void;
  themePreset?: ThemePreset;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  userName,
  onNewDocument,
  onOpenFile,
  onSelectRecentDocument,
  showToast,
}) => {
  const [documents, setDocuments] = useState<RecentDocument[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [deleteTargetDoc, setDeleteTargetDoc] = useState<RecentDocument | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState<boolean>(false);

  useEffect(() => {
    let isMounted = true;
    loadRecentDocuments().then((docs) => {
      if (isMounted) setDocuments(docs);
    });
    return () => {
      isMounted = false;
    };
  }, []);

  const handleToggleStar = async (doc: RecentDocument, e: React.MouseEvent) => {
    e.stopPropagation();
    const newStarred = await toggleStarDocument(doc.id);
    setDocuments((prev) =>
      prev.map((d) => (d.id === doc.id ? { ...d, isStarred: newStarred } : d))
    );
    showToast(newStarred ? `Starred ${doc.title}` : `Unstarred ${doc.title}`);
  };

  const handleOpenDelete = (doc: RecentDocument, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTargetDoc(doc);
    setIsDeleteModalOpen(true);
  };

  const handleHideFromApp = async (doc: RecentDocument) => {
    setIsDeleteModalOpen(false);
    await removeRecentDocument(doc.id);
    setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
    setDeleteTargetDoc(null);
    showToast(`Removed "${doc.title}"`);
  };

  const handlePermanentDelete = async (doc: RecentDocument) => {
    setIsDeleteModalOpen(false);
    const result = await permanentlyDeleteDocument(doc);
    setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
    setDeleteTargetDoc(null);
    showToast(result.success ? `Deleted "${doc.title}"` : `Removed from list`);
  };

  const cleanQuery = searchQuery.trim().toLowerCase();
  const filtered = documents.filter((doc) => {
    if (!cleanQuery) return true;
    return (
      doc.title.toLowerCase().includes(cleanQuery) ||
      doc.path.toLowerCase().includes(cleanQuery)
    );
  });

  const starredDocs = filtered.filter((d) => d.isStarred);

  return (
    <div className="flex-1 flex flex-col h-full bg-[#161616] text-[#e5e5e5] overflow-y-auto select-none">
      <div className="max-w-4xl w-full mx-auto px-6 py-10 flex-1 flex flex-col space-y-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-medium text-[#e5e5e5]">
              {userName?.trim() ? `Welcome, ${userName.trim()}` : 'Ink Studio'}
            </h1>
            <p className="text-xs text-[#8a8a8a] mt-0.5">Recent projects and canvases</p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onNewDocument}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded text-xs font-medium transition-opacity hover:opacity-90 cursor-pointer"
              style={{
                backgroundColor: 'var(--accent)',
                color: 'var(--accent-contrast)',
              }}
            >
              <FilePlus className="w-3.5 h-3.5" />
              <span>New Canvas</span>
            </button>

            <button
              type="button"
              onClick={onOpenFile}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-[#202020] hover:bg-[#2c2c2c] text-xs font-medium text-[#e5e5e5] transition-colors cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5 text-[#8a8a8a]" />
              <span>Open...</span>
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative w-full">
          <Search className="w-3.5 h-3.5 text-[#8a8a8a] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search documents..."
            className="w-full pl-9 pr-8 py-2 text-xs bg-[#202020] rounded-md text-[#e5e5e5] placeholder-[#8a8a8a]"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {starredDocs.length > 0 && (
          <section className="space-y-3">
            <div className="text-[11px] font-medium text-[#8a8a8a] uppercase tracking-wider">
              Starred ({starredDocs.length})
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {starredDocs.map((doc) => (
                <DocCard
                  key={`starred-${doc.id}`}
                  doc={doc}
                  onSelect={() =>
                    onSelectRecentDocument ? onSelectRecentDocument(doc) : onOpenFile()
                  }
                  onToggleStar={(e) => handleToggleStar(doc, e)}
                  onDelete={(e) => handleOpenDelete(doc, e)}
                />
              ))}
            </div>
          </section>
        )}

        <section className="space-y-3">
          <div className="text-[11px] font-medium text-[#8a8a8a] uppercase tracking-wider">
            Recent ({filtered.length})
          </div>

          {filtered.length === 0 ? (
            <div className="bg-[#202020] p-8 text-center rounded-md">
              <p className="text-xs text-[#8a8a8a]">
                {cleanQuery ? 'No matching documents.' : 'No recent documents yet.'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {filtered.map((doc) => (
                <DocCard
                  key={`recent-${doc.id}`}
                  doc={doc}
                  onSelect={() =>
                    onSelectRecentDocument ? onSelectRecentDocument(doc) : onOpenFile()
                  }
                  onToggleStar={(e) => handleToggleStar(doc, e)}
                  onDelete={(e) => handleOpenDelete(doc, e)}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <DeleteDocumentModal
        isOpen={isDeleteModalOpen}
        document={deleteTargetDoc}
        onClose={() => {
          setIsDeleteModalOpen(false);
          setDeleteTargetDoc(null);
        }}
        onHideFromApp={handleHideFromApp}
        onPermanentlyDelete={handlePermanentDelete}
      />
    </div>
  );
};

interface DocCardProps {
  doc: RecentDocument;
  onSelect: () => void;
  onToggleStar: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
}

const DocCard: React.FC<DocCardProps> = ({ doc, onSelect, onToggleStar, onDelete }) => (
  <div
    onClick={onSelect}
    className="group relative flex flex-col bg-[#202020] hover:bg-[#2c2c2c] rounded-md p-2.5 cursor-pointer transition-colors"
    title={doc.title}
  >
    <div className="relative aspect-[4/3] bg-[#161616] overflow-hidden flex items-center justify-center rounded mb-2">
      {doc.coverUrl ? (
        <img
          src={doc.coverUrl}
          alt={doc.title}
          className="w-full h-full object-cover select-none pointer-events-none"
        />
      ) : (
        <div className="w-3/4 h-3/4 bg-white rounded-xs flex items-center justify-center text-[#8a8a8a]">
          <FileText className="w-5 h-5" />
        </div>
      )}

      <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleStar}
          className={`w-5 h-5 rounded bg-[#161616]/80 flex items-center justify-center cursor-pointer ${
            doc.isStarred
              ? 'text-[var(--accent)]'
              : 'text-[#8a8a8a] opacity-0 group-hover:opacity-100 hover:text-[#e5e5e5]'
          }`}
        >
          <Star className={`w-3 h-3 ${doc.isStarred ? 'fill-current' : ''}`} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="w-5 h-5 rounded bg-[#161616]/80 text-[#8a8a8a] hover:text-red-400 flex items-center justify-center opacity-0 group-hover:opacity-100 cursor-pointer"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>

    <div className="text-xs font-medium text-[#e5e5e5] truncate">{doc.title}</div>
    <div className="text-[10px] font-mono text-[#8a8a8a] mt-0.5">{formatFileSize(doc.size)}</div>
  </div>
);
