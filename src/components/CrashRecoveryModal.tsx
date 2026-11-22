import React, { useEffect, useState } from 'react';
import {
  RotateCcw,
  Trash2,
  AlertTriangle,
  FileText,
  Layers,
  Loader2,
  X,
} from 'lucide-react';
import { CrashedSessionInfo } from '../services/recoveryService';

interface CrashRecoveryModalProps {
  isOpen: boolean;
  sessions: CrashedSessionInfo[];
  onRestore: (session: CrashedSessionInfo) => Promise<void>;
  onDiscard: (session: CrashedSessionInfo) => Promise<void>;
  onClose?: () => void;
}

interface ParsedSessionManifest {
  documentName?: string;
  width?: number;
  height?: number;
  dpi?: number;
  colorMode?: string;
  layers?: unknown[];
}

function parseSessionManifest(manifestJson?: string | null): ParsedSessionManifest | null {
  if (!manifestJson) return null;
  try {
    return JSON.parse(manifestJson) as ParsedSessionManifest;
  } catch {
    return null;
  }
}

export const CrashRecoveryModal: React.FC<CrashRecoveryModalProps> = ({
  isOpen,
  sessions,
  onRestore,
  onDiscard,
  onClose,
}) => {
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [isRestoring, setIsRestoring] = useState<boolean>(false);
  const [isDiscarding, setIsDiscarding] = useState<boolean>(false);

  const isBusy = isRestoring || isDiscarding;

  useEffect(() => {
    if (sessions.length > 0 && selectedIndex >= sessions.length) {
      setSelectedIndex(sessions.length - 1);
    }
  }, [sessions.length, selectedIndex]);

  useEffect(() => {
    if (!isOpen || !onClose) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, isBusy, onClose]);

  if (!isOpen || sessions.length === 0) return null;

  const safeIndex = Math.min(selectedIndex, sessions.length - 1);
  const currentSession = sessions[safeIndex] || sessions[0];
  const manifestData = parseSessionManifest(currentSession.manifest_json);

  const documentName = manifestData?.documentName || 'Untitled Document';
  const width = manifestData?.width || 3000;
  const height = manifestData?.height || 3000;
  const dpi = manifestData?.dpi || 600;
  const colorMode = manifestData?.colorMode || 'color';
  const layerCount = manifestData?.layers?.length || 1;

  const crashDate = currentSession.timestamp
    ? new Date(currentSession.timestamp).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'medium',
      })
    : 'Unknown';

  const handleRestoreClick = async () => {
    if (isBusy) return;
    setIsRestoring(true);
    try {
      await onRestore(currentSession);
    } finally {
      setIsRestoring(false);
    }
  };

  const handleDiscardClick = async () => {
    if (isBusy) return;
    setIsDiscarding(true);
    try {
      await onDiscard(currentSession);
    } finally {
      setIsDiscarding(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="crash-recovery-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 select-none"
    >
      <div className="bg-[#202020] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.8)] border border-[#2c2c2c] w-full max-w-[660px] flex flex-col overflow-hidden text-xs text-[#e5e5e5]">
        {/* Header Bar */}
        <div className="h-10 px-4 flex items-center justify-between gap-3 bg-[#161616] border-b border-[#2c2c2c] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <h2
              id="crash-recovery-title"
              className="text-xs font-medium text-[#e5e5e5] truncate"
            >
              Restore Unsaved Session
            </h2>
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#202020] border border-[#2c2c2c] text-[#a0a0a0] shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
              WAL Protected
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {sessions.length > 1 && (
              <span className="text-[10px] font-mono text-[#8a8a8a] bg-[#262626] px-1.5 py-0.5 rounded">
                {safeIndex + 1} / {sessions.length}
              </span>
            )}
            {onClose && !isBusy && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close recovery dialog"
                title="Close (Esc)"
                className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Multiple Sessions Selector */}
        {sessions.length > 1 && (
          <div className="px-4 py-2 bg-[#1a1a1a] border-b border-[#2c2c2c] flex items-center gap-3 overflow-x-auto no-scrollbar shrink-0">
            <span className="text-[10px] text-[#8a8a8a] font-medium uppercase tracking-wider shrink-0">
              Sessions
            </span>
            <div className="inline-flex items-center gap-0.5 bg-[#161616] p-0.5 rounded border border-[#2c2c2c]">
              {sessions.map((s, idx) => {
                const isActive = idx === safeIndex;
                const sessionManifest = parseSessionManifest(s.manifest_json);
                const sessionTitle = sessionManifest?.documentName || `Session ${idx + 1}`;
                return (
                  <button
                    key={s.session_id}
                    type="button"
                    disabled={isBusy}
                    title={sessionTitle}
                    onClick={() => setSelectedIndex(idx)}
                    className={`px-2.5 py-1 rounded text-[11px] transition-colors cursor-pointer shrink-0 inline-flex items-center gap-1.5 disabled:opacity-50 ${
                      isActive
                        ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                        : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                    }`}
                  >
                    {isActive && (
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />
                    )}
                    <span>Session {idx + 1}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Modal Main Content */}
        <div className="p-5 space-y-4 bg-[#202020]">
          <p className="text-[11px] text-[#8a8a8a] leading-relaxed">
            Ink Studio detected an unexpected shutdown. Your progress can be restored from the recovery journal below.
          </p>

          {/* Document Preview & Metadata Grid */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-stretch">
            {/* Visual Thumbnail Preview (5 cols) */}
            <div className="md:col-span-5 flex flex-col">
              <div
                className="w-full aspect-square bg-[#161616] border border-[#2c2c2c] rounded overflow-hidden relative flex items-center justify-center"
                style={
                  currentSession.thumbnail_data_url
                    ? {
                        backgroundImage:
                          'conic-gradient(#1f1f1f 90deg, #161616 90deg 180deg, #1f1f1f 180deg 270deg, #161616 270deg)',
                        backgroundSize: '12px 12px',
                      }
                    : undefined
                }
              >
                {currentSession.thumbnail_data_url ? (
                  <img
                    src={currentSession.thumbnail_data_url}
                    alt="Document preview"
                    className="w-full h-full object-contain p-1.5"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center p-4 text-center">
                    <Layers className="w-8 h-8 mb-2 text-[#525252]" />
                    <span className="text-[11px] font-medium text-[#8a8a8a]">
                      No Snapshot Preview
                    </span>
                    <span className="text-[10px] text-[#737373] mt-0.5">
                      WAL journal entries intact
                    </span>
                  </div>
                )}
                <div className="absolute bottom-2 left-2 bg-[#161616]/90 border border-[#2c2c2c] px-1.5 py-0.5 rounded text-[10px] font-mono text-[#b5b5b5]">
                  {width} × {height}
                </div>
              </div>
            </div>

            {/* Metadata Fields (7 cols) */}
            <div className="md:col-span-7 flex flex-col justify-between gap-3 min-w-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  <h3
                    className="text-sm font-semibold text-[#e5e5e5] truncate"
                    title={documentName}
                  >
                    {documentName}
                  </h3>
                </div>
                <p
                  className="text-[10px] text-[#737373] font-mono mt-0.5 truncate select-text"
                  title={currentSession.session_id}
                >
                  ID: {currentSession.session_id}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <div className="bg-[#161616] border border-[#2c2c2c] rounded px-2.5 py-2">
                  <span className="text-[10px] text-[#8a8a8a] block">Canvas Size</span>
                  <span className="text-xs font-medium font-mono text-[#e5e5e5]">
                    {width} × {height}
                  </span>
                </div>

                <div className="bg-[#161616] border border-[#2c2c2c] rounded px-2.5 py-2">
                  <span className="text-[10px] text-[#8a8a8a] block">Resolution</span>
                  <span className="text-xs font-medium font-mono text-[#e5e5e5]">{dpi} DPI</span>
                </div>

                <div className="bg-[#161616] border border-[#2c2c2c] rounded px-2.5 py-2">
                  <span className="text-[10px] text-[#8a8a8a] block">Layer Tree</span>
                  <span className="text-xs font-medium text-[#e5e5e5]">
                    {layerCount} {layerCount === 1 ? 'Layer' : 'Layers'}
                  </span>
                </div>

                <div className="bg-[#161616] border border-[#2c2c2c] rounded px-2.5 py-2">
                  <span className="text-[10px] text-[#8a8a8a] block">Color Mode</span>
                  <span className="text-xs font-medium text-[#e5e5e5] capitalize">{colorMode}</span>
                </div>
              </div>

              {/* Timestamp & Process Info */}
              <div className="bg-[#161616] rounded border border-[#2c2c2c] divide-y divide-[#252525] text-[11px]">
                <div className="px-2.5 py-1.5 flex items-center justify-between gap-2">
                  <span className="text-[#8a8a8a]">Terminated At</span>
                  <span className="text-[#d4d4d4] font-mono">{crashDate}</span>
                </div>
                <div className="px-2.5 py-1.5 flex items-center justify-between gap-2">
                  <span className="text-[#8a8a8a]">Previous PID</span>
                  <span className="text-[#a0a0a0] font-mono">{currentSession.pid}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Action Footer */}
        <div className="px-4 py-3 bg-[#161616] border-t border-[#2c2c2c] flex items-center justify-between gap-2 shrink-0">
          <button
            type="button"
            disabled={isBusy}
            onClick={handleDiscardClick}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-[#202020] hover:bg-red-500/15 border border-[#2c2c2c] hover:border-red-500/30 text-red-400/90 hover:text-red-300 transition-colors disabled:opacity-50 cursor-pointer"
          >
            {isDiscarding ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
            <span>{isDiscarding ? 'Discarding...' : 'Discard & Start Fresh'}</span>
          </button>

          <button
            type="button"
            autoFocus
            disabled={isBusy}
            onClick={handleRestoreClick}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded text-xs font-medium bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 disabled:opacity-50 transition-opacity cursor-pointer"
          >
            {isRestoring ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RotateCcw className="w-3.5 h-3.5" />
            )}
            <span>{isRestoring ? 'Restoring Canvas...' : 'Restore Session'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
