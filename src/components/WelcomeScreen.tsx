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
      <div className="flex-1 flex flex-col h-full bg-[#18191d] text-white/90 overflow-y-auto select-none font-sans">
        {/* Main Content Container matching Reference 1 */}
        <div className="max-w-4xl w-full mx-auto px-6 py-12 flex-1 flex flex-col">
          {/* Header Row: Greeting & Action Buttons */}
          <div className="flex items-start justify-between gap-6 mb-8">
            <div>
              <h1 className="text-3xl font-light tracking-tight text-white/95">
                Welcome back{userName?.trim() ? `, ${userName.trim()}` : ', my Lord'}.
              </h1>
              <p className="text-xs text-white/40 mt-1 font-mono tracking-wide">
                bdt.greeting
              </p>
            </div>

            <div className="flex items-center gap-2.5 shrink-0 pt-1">
              <button
                type="button"
                onClick={onNewDocument}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] active:scale-[0.98] border border-white/10 text-xs font-medium text-white shadow-xs transition-all cursor-pointer"
              >
                <FilePlus className="w-3.5 h-3.5 text-white/90" />
                <span>+ New document</span>
              </button>

              <button
                type="button"
                onClick={onOpenFile}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] active:scale-[0.98] border border-white/10 text-xs font-medium text-white/80 hover:text-white transition-all cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5 text-white/70" />
                <span>Open file...</span>
              </button>
            </div>
          </div>

          {/* Wide Search Bar */}
          <div className="mb-2">
            <div className="relative w-full">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search your documents"
                className="w-full pl-4 pr-10 py-2.5 text-xs bg-[#222328] border border-white/[0.06] rounded-xl text-white placeholder-white/35 outline-none focus:border-white/20 focus:ring-1 focus:ring-white/20 transition-all shadow-inner"
              />
              {searchQuery ? (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-2.5 text-white/40 hover:text-white cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              ) : (
                <Search className="w-3.5 h-3.5 text-white/30 absolute right-3.5 top-3 pointer-events-none" />
              )}
            </div>
          </div>

          <p className="text-[11px] text-white/35 mb-8">
            Removed from Home. Saved files are kept.
          </p>

          {/* Starred Section */}
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-medium text-white/80">Starred</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/50 font-mono">
                {starredDocs.length}
              </span>
            </div>

            {starredDocs.length === 0 ? (
              <p className="text-xs text-white/35">
                Star a document below to keep it close.
              </p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
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
            )}
          </div>

          {/* Recent Documents Section */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-medium text-white/80">Recent documents</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/50 font-mono">
                {regularDocs.length}
              </span>
            </div>

            {regularDocs.length === 0 ? (
              <div className="border border-dashed border-white/10 bg-white/[0.02] p-8 text-center rounded-xl">
                <p className="text-xs text-white/40">
                  {cleanQuery
                    ? 'No documents matched the filter.'
                    : 'No recent documents found.'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
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
          </div>
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
      className="group relative flex flex-col bg-[#222328] hover:bg-[#282930] border border-white/[0.07] hover:border-white/20 rounded-xl p-3 cursor-pointer transition-all duration-150 shadow-md hover:shadow-xl"
      title={`${doc.title}\n${doc.path}`}
    >
      {/* Thumbnail Area - Aspect Square with Checkerboard Canvas Preview */}
      <div
        className="relative aspect-square border border-white/[0.05] overflow-hidden flex items-center justify-center rounded-lg mb-2.5"
        style={{
          background:
            'repeating-conic-gradient(#202126 0% 25%, #17181c 0% 50%) 50% / 12px 12px',
        }}
      >
        {doc.coverUrl ? (
          <img
            src={doc.coverUrl}
            alt={doc.title}
            className="w-full h-full object-cover select-none pointer-events-none group-hover:scale-102 transition-transform duration-200"
          />
        ) : (
          <div className="w-3/4 h-3/4 bg-white/90 rounded-sm shadow-md flex flex-col items-center justify-center text-zinc-400">
            <FileText className="w-6 h-6 stroke-[1.5]" />
          </div>
        )}

        {/* Top Right Quick Actions: Close (X) and Star */}
        <div className="absolute top-1.5 right-1.5 flex items-center space-x-1">
          <button
            type="button"
            onClick={onDelete}
            title="Remove from recents"
            className="w-5 h-5 rounded-md bg-black/60 hover:bg-black/90 text-white/50 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all backdrop-blur-xs cursor-pointer"
          >
            <X className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={onToggleStar}
            title={doc.isStarred ? 'Remove favorite' : 'Add favorite'}
            className={`w-5 h-5 rounded-md flex items-center justify-center transition-all cursor-pointer ${
              doc.isStarred
                ? 'bg-black/70 text-amber-400 backdrop-blur-xs'
                : 'bg-black/60 text-white/50 opacity-0 group-hover:opacity-100 hover:text-amber-400 backdrop-blur-xs'
            }`}
          >
            <Star className={`w-3 h-3 ${doc.isStarred ? 'fill-amber-400' : ''}`} />
          </button>
        </div>
      </div>

      {/* Meta matching Reference 1 */}
      <div className="min-w-0 space-y-0.5">
        <div className="text-xs font-semibold text-white/95 truncate">
          {doc.title}
        </div>
        <div className="text-[10px] text-white/45 truncate">
          Previous session · Last worked on {formatFileSize(doc.size)}
        </div>
        <div className="text-[9px] text-white/30 font-mono truncate">
          {doc.path}
        </div>
      </div>
    </div>
  );
};
