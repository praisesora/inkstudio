import React, { useState, useEffect } from 'react';
import {
  FilePlus,
  FolderOpen,
  Search,
  X,
  Star,
  Trash2,
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
  themePreset = 'vintage-manga',
}) => {
  const displayName = userName?.trim() || 'Artist';
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
    showToast(newStarred ? `Starred: ${doc.title}` : `Unstarred: ${doc.title}`);
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
    showToast(
      result.success
        ? `Deleted "${doc.title}"`
        : `Removed from list (file not found on disk)`
    );
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
  const regularDocs = filtered;

  if (themePreset === 'modern') {
    return (
      <div className="flex-1 flex flex-col h-full bg-[#0c0d12] text-white/90 overflow-y-auto select-none font-sans">
        {/* Top Utility Header */}
        <div className="border-b border-white/[0.08] bg-[#121318]/90 backdrop-blur-md px-8 py-3.5 shrink-0">
          <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
            <div className="flex items-center space-x-3">
              <span className="w-2.5 h-2.5 rounded-full bg-[var(--modern-accent)] shadow-[0_0_8px_var(--modern-accent)]" />
              <span className="text-sm font-semibold tracking-tight text-white">
                Ink Studio
              </span>
              <span className="text-white/20">/</span>
              <span className="text-xs text-white/50">Recent Documents</span>
            </div>

            <div className="flex items-center space-x-2.5">
              <button
                type="button"
                onClick={onNewDocument}
                className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-[var(--modern-accent)] hover:brightness-110 active:scale-[0.98] text-xs font-medium text-white shadow-sm transition-all cursor-pointer"
              >
                <FilePlus className="w-3.5 h-3.5" />
                <span>New Canvas</span>
              </button>

              <button
                type="button"
                onClick={onOpenFile}
                className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] active:scale-[0.98] border border-white/10 text-xs font-medium text-white/90 transition-all cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5 text-white/70" />
                <span>Open File...</span>
              </button>
            </div>
          </div>
        </div>

        {/* Main Container */}
        <div className="max-w-6xl w-full mx-auto p-8 space-y-8 flex-1">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-white">
              Welcome back, {displayName}
            </h1>
          </div>

          {/* Search Bar */}
          <div className="flex items-center justify-between gap-4 pb-3 border-b border-white/[0.06]">
            <div className="relative w-80">
              <Search className="w-3.5 h-3.5 text-white/40 absolute left-3 top-2.5 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter files..."
                className="w-full pl-9 pr-8 py-1.5 text-xs bg-white/[0.04] border border-white/[0.08] rounded-lg text-white placeholder-white/40 outline-none focus:border-[var(--modern-accent)] focus:ring-1 focus:ring-[var(--modern-accent)] transition-all"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-2 text-white/40 hover:text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <div className="text-[11px] font-mono text-white/40">
              {filtered.length} {filtered.length === 1 ? 'file' : 'files'}
            </div>
          </div>

          {/* Starred Section */}
          {starredDocs.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center space-x-2 text-xs font-semibold text-white/70 uppercase tracking-wider">
                <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
                <span>Favorites ({starredDocs.length})</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3.5">
                {starredDocs.map((doc) => (
                  <ModernDocCard
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

          {/* Recent Section */}
          <section className="space-y-3">
            <div className="text-xs font-semibold text-white/70 uppercase tracking-wider">
              All Documents ({regularDocs.length})
            </div>

            {regularDocs.length === 0 ? (
              <div className="border border-dashed border-white/10 bg-white/[0.02] p-10 text-center rounded-xl">
                <p className="text-xs text-white/40">
                  {cleanQuery
                    ? 'No documents matched the filter.'
                    : 'No recent documents found.'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3.5">
                {regularDocs.map((doc) => (
                  <ModernDocCard
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

        {/* Delete Confirmation Modal */}
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
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[#3c3c3f] text-[#d6d6da] overflow-y-auto select-none font-sans">
      {/* Top Utility Header */}
      <div className="border-b border-[#242426] bg-[#444447] px-6 py-3 shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <span className="text-sm font-semibold text-[#f0f0f4] tracking-wide">
              Ink Studio
            </span>
            <span className="text-[#68686d]">|</span>
            <span className="text-xs text-[#a0a0a5]">Recent Work</span>
          </div>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={onNewDocument}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-[2px] bg-gradient-to-b from-[#58585c] to-[#424245] hover:from-[#626266] hover:to-[#4b4b4e] active:from-[#3a3a3d] active:to-[#2e2e30] border border-[#242426] text-xs font-medium text-[#f0f0f4] shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_1px_rgba(0,0,0,0.3)] cursor-pointer"
            >
              <FilePlus className="w-3.5 h-3.5 text-[#93c5fd]" />
              <span>New Canvas</span>
            </button>

            <button
              type="button"
              onClick={onOpenFile}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-[2px] bg-gradient-to-b from-[#58585c] to-[#424245] hover:from-[#626266] hover:to-[#4b4b4e] active:from-[#3a3a3d] active:to-[#2e2e30] border border-[#242426] text-xs font-medium text-[#f0f0f4] shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_1px_rgba(0,0,0,0.3)] cursor-pointer"
            >
              <FolderOpen className="w-3.5 h-3.5 text-[#facc15]" />
              <span>Open File...</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Container */}
      <div className="max-w-6xl w-full mx-auto p-6 space-y-6 flex-1">
        <div>
          <h1 className="text-base font-semibold text-[#f0f0f4] tracking-wide">
            Welcome back, {displayName}
          </h1>
        </div>

        {/* Search Bar */}
        <div className="flex items-center justify-between gap-4 pb-2 border-b border-[#2d2d30]">
          <div className="relative w-72">
            <Search className="w-3.5 h-3.5 text-[#737378] absolute left-2.5 top-2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter files..."
              className="w-full pl-8 pr-7 py-1 text-xs bg-[#2b2b2e] border border-[#1e1e20] rounded-[2px] text-[#f0f0f4] placeholder-[#707075] outline-none focus:border-[#4a8fc7] shadow-[inset_1px_1px_2px_rgba(0,0,0,0.5)]"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-2 text-[#88888d] hover:text-white"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className="text-[11px] font-mono text-[#8c8c92]">
            {filtered.length} {filtered.length === 1 ? 'file' : 'files'}
          </div>
        </div>

        {/* Starred Section */}
        {starredDocs.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center space-x-1.5 text-xs font-semibold text-[#c8c8cc] uppercase tracking-wider">
              <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400" />
              <span>Favorites ({starredDocs.length})</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {starredDocs.map((doc) => (
                <VintageDocCard
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

        {/* Recent Section */}
        <section className="space-y-3">
          <div className="text-xs font-semibold text-[#c8c8cc] uppercase tracking-wider">
            All Documents ({regularDocs.length})
          </div>

          {regularDocs.length === 0 ? (
            <div className="border border-dashed border-[#333336] bg-[#323235] p-8 text-center rounded-[2px]">
              <p className="text-xs text-[#8c8c92]">
                {cleanQuery
                  ? 'No documents matched the filter.'
                  : 'No recent documents found.'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {regularDocs.map((doc) => (
                <VintageDocCard
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

      {/* Delete Confirmation Modal */}
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

interface VintageDocCardProps {
  doc: RecentDocument;
  onSelect: () => void;
  onToggleStar: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
}

const VintageDocCard: React.FC<VintageDocCardProps> = ({
  doc,
  onSelect,
  onToggleStar,
  onDelete,
}) => {
  return (
    <div
      onClick={onSelect}
      className="group relative flex flex-col bg-[#444447] border border-[#242426] hover:border-[#5a5a60] rounded-[2px] p-2 cursor-pointer shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-colors"
      title={`${doc.title}\n${doc.path}`}
    >
      {/* Thumbnail Area */}
      <div className="relative aspect-[4/3] bg-[#222224] border border-[#1a1a1c] overflow-hidden flex items-center justify-center rounded-[1px] mb-2 shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)]">
        {doc.coverUrl ? (
          <img
            src={doc.coverUrl}
            alt={doc.title}
            className="w-full h-full object-cover select-none pointer-events-none"
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-[#58585d] space-y-1">
            <FileText className="w-6 h-6" />
            <span className="text-[9px] font-mono uppercase">{doc.fileType || 'CANVAS'}</span>
          </div>
        )}

        {/* Quick Actions (top corners) */}
        <div className="absolute top-1 left-1 flex items-center space-x-1">
          <button
            type="button"
            onClick={onToggleStar}
            title={doc.isStarred ? 'Remove favorite' : 'Add favorite'}
            className={`w-5 h-5 rounded-[2px] border flex items-center justify-center transition-colors cursor-pointer ${
              doc.isStarred
                ? 'bg-[#252528] border-[#38383c] text-amber-400'
                : 'bg-[#252528]/80 border-[#38383c] text-[#77777c] opacity-0 group-hover:opacity-100 hover:text-amber-400 hover:border-[#555]'
            }`}
          >
            <Star
              className={`w-3 h-3 ${doc.isStarred ? 'fill-amber-400' : ''}`}
            />
          </button>
        </div>

        <div className="absolute top-1 right-1">
          <button
            type="button"
            onClick={onDelete}
            title="Delete file options"
            className="w-5 h-5 rounded-[2px] bg-[#252528]/80 border border-[#38383c] text-[#88888d] hover:text-rose-400 hover:border-rose-900 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Meta */}
      <div className="min-w-0 space-y-0.5">
        <div className="text-xs font-medium text-[#f0f0f4] truncate group-hover:text-[#93c5fd]">
          {doc.title}
        </div>
        <div className="flex items-center justify-between text-[10px] text-[#8a8a90] font-mono">
          <span>{formatFileSize(doc.size)}</span>
          <span className="uppercase text-[9px] px-1 py-0.2 bg-[#2d2d30] border border-[#222224] rounded-[1px] text-[#aaa]">
            {doc.fileType || 'CANVAS'}
          </span>
        </div>
      </div>
    </div>
  );
};

const ModernDocCard: React.FC<VintageDocCardProps> = ({
  doc,
  onSelect,
  onToggleStar,
  onDelete,
}) => {
  return (
    <div
      onClick={onSelect}
      className="group relative flex flex-col bg-[#14151b] hover:bg-[#1a1b24] border border-white/[0.08] hover:border-[var(--modern-accent-border)] rounded-xl p-3 cursor-pointer transition-all duration-150 shadow-xs hover:shadow-lg hover:-translate-y-0.5"
      title={`${doc.title}\n${doc.path}`}
    >
      {/* Thumbnail Area */}
      <div className="relative aspect-[4/3] bg-[#0c0d12] border border-white/[0.04] overflow-hidden flex items-center justify-center rounded-lg mb-2.5">
        {doc.coverUrl ? (
          <img
            src={doc.coverUrl}
            alt={doc.title}
            className="w-full h-full object-cover select-none pointer-events-none group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-white/30 space-y-1">
            <FileText className="w-6 h-6 stroke-[1.5]" />
            <span className="text-[9px] font-mono uppercase tracking-wider text-white/40">{doc.fileType || 'CANVAS'}</span>
          </div>
        )}

        {/* Quick Actions (top corners) */}
        <div className="absolute top-1.5 left-1.5 flex items-center space-x-1">
          <button
            type="button"
            onClick={onToggleStar}
            title={doc.isStarred ? 'Remove favorite' : 'Add favorite'}
            className={`w-6 h-6 rounded-md flex items-center justify-center transition-all cursor-pointer ${
              doc.isStarred
                ? 'bg-black/60 text-amber-400 backdrop-blur-xs'
                : 'bg-black/50 text-white/40 opacity-0 group-hover:opacity-100 hover:text-amber-400 backdrop-blur-xs'
            }`}
          >
            <Star className={`w-3.5 h-3.5 ${doc.isStarred ? 'fill-amber-400' : ''}`} />
          </button>
        </div>

        <div className="absolute top-1.5 right-1.5">
          <button
            type="button"
            onClick={onDelete}
            title="Delete file options"
            className="w-6 h-6 rounded-md bg-black/50 hover:bg-rose-950/80 text-white/40 hover:text-rose-300 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all backdrop-blur-xs cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Meta */}
      <div className="min-w-0 space-y-1">
        <div className="text-xs font-medium text-white/90 truncate group-hover:text-[var(--modern-accent)] transition-colors">
          {doc.title}
        </div>
        <div className="flex items-center justify-between text-[10px] text-white/40 font-mono">
          <span>{formatFileSize(doc.size)}</span>
          <span className="uppercase text-[9px] px-1.5 py-0.5 bg-white/[0.05] border border-white/[0.06] rounded font-mono text-white/60">
            {doc.fileType || 'CANVAS'}
          </span>
        </div>
      </div>
    </div>
  );
};
