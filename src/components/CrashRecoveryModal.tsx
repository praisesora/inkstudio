import React, { useState } from 'react';
import {
  RotateCcw,
  Trash2,
  AlertTriangle,
  Layers,
  Calendar,
  Maximize2,
  Cpu,
  FileText,
  Clock,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';
import { CrashedSessionInfo } from '../services/recoveryService';

interface CrashRecoveryModalProps {
  isOpen: boolean;
  sessions: CrashedSessionInfo[];
  onRestore: (session: CrashedSessionInfo) => Promise<void>;
  onDiscard: (session: CrashedSessionInfo) => Promise<void>;
  onClose?: () => void;
}

export const CrashRecoveryModal: React.FC<CrashRecoveryModalProps> = ({
  isOpen,
  sessions,
  onRestore,
  onDiscard,
}) => {
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [isRestoring, setIsRestoring] = useState<boolean>(false);
  const [isDiscarding, setIsDiscarding] = useState<boolean>(false);

  if (!isOpen || sessions.length === 0) return null;

  const currentSession = sessions[selectedIndex] || sessions[0];

  let manifestData: any = null;
  if (currentSession.manifest_json) {
    try {
      manifestData = JSON.parse(currentSession.manifest_json);
    } catch {
      manifestData = null;
    }
  }

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
    setIsRestoring(true);
    try {
      await onRestore(currentSession);
    } finally {
      setIsRestoring(false);
    }
  };

  const handleDiscardClick = async () => {
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 select-none animate-in fade-in duration-150"
    >
      <div className="bg-[#242426] border border-[#3c3c40] rounded-xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden text-xs text-[#d0d0d0]">
        {/* Header Bar */}
        <div className="flex items-center justify-between px-6 py-4 bg-[#2a2a2d] border-b border-[#38383a]">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div>
              <h2 id="crash-recovery-title" className="text-sm font-semibold text-white tracking-wide flex items-center gap-2">
                Restore Unsaved Session?
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" />
                  WAL Protected
                </span>
              </h2>
              <p className="text-[11px] text-[#999999] mt-0.5">
                Ink Studio detected an unexpected application shutdown. Your progress can be restored with zero data loss.
              </p>
            </div>
          </div>
        </div>

        {/* Multiple Sessions Selector (if > 1 session detected) */}
        {sessions.length > 1 && (
          <div className="px-6 py-2 bg-[#1e1e20] border-b border-[#323235] flex items-center gap-2 overflow-x-auto">
            <span className="text-[10px] text-[#888888] font-semibold uppercase tracking-wider shrink-0">
              Sessions:
            </span>
            {sessions.map((s, idx) => (
              <button
                key={s.session_id}
                onClick={() => setSelectedIndex(idx)}
                className={`px-3 py-1 rounded text-xs transition-colors border ${
                  idx === selectedIndex
                    ? 'bg-[#007acc] border-[#007acc] text-white font-medium'
                    : 'bg-[#29292c] border-[#38383c] text-[#a0a0a0] hover:text-white'
                }`}
              >
                Session {idx + 1}
              </button>
            ))}
          </div>
        )}

        {/* Modal Main Content */}
        <div className="p-6 space-y-5">
          {/* Document Preview & Metadata Card */}
          <div className="bg-[#1b1b1d] border border-[#323235] rounded-lg p-4 grid grid-cols-1 md:grid-cols-12 gap-5">
            {/* Visual Thumbnail Preview (5 cols) */}
            <div className="md:col-span-5 flex flex-col items-center justify-center">
              <div className="w-full aspect-square max-w-[210px] bg-[#141416] border border-[#38383c] rounded-md overflow-hidden relative flex items-center justify-center shadow-inner group">
                {currentSession.thumbnail_data_url ? (
                  <img
                    src={currentSession.thumbnail_data_url}
                    alt="Document preview"
                    className="w-full h-full object-contain p-1"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center text-[#666666] p-4 text-center">
                    <Layers className="w-10 h-10 mb-2 opacity-50 text-[#888888]" />
                    <span className="text-[11px] font-medium text-[#888888]">No Snapshot Preview</span>
                    <span className="text-[10px] text-[#555555]">WAL journal entries intact</span>
                  </div>
                )}
                <div className="absolute bottom-2 left-2 bg-black/75 px-1.5 py-0.5 rounded text-[10px] font-mono text-[#aaaaaa] border border-white/10">
                  {width} × {height}
                </div>
              </div>
            </div>

            {/* Metadata Fields (7 cols) */}
            <div className="md:col-span-7 flex flex-col justify-between space-y-3">
              <div>
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-sky-400 shrink-0" />
                  <h3 className="text-sm font-semibold text-white truncate" title={documentName}>
                    {documentName}
                  </h3>
                </div>
                <p className="text-[11px] text-[#777777] font-mono mt-0.5 truncate">
                  ID: {currentSession.session_id}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-[#242427] border border-[#323236] rounded p-2 flex items-center gap-2">
                  <Maximize2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <div>
                    <span className="text-[10px] text-[#888888] block">Canvas Size</span>
                    <span className="font-semibold text-white">{width} × {height}</span>
                  </div>
                </div>

                <div className="bg-[#242427] border border-[#323236] rounded p-2 flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <div>
                    <span className="text-[10px] text-[#888888] block">Resolution</span>
                    <span className="font-semibold text-white">{dpi} DPI</span>
                  </div>
                </div>

                <div className="bg-[#242427] border border-[#323236] rounded p-2 flex items-center gap-2">
                  <Layers className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                  <div>
                    <span className="text-[10px] text-[#888888] block">Layer Tree</span>
                    <span className="font-semibold text-white">{layerCount} {layerCount === 1 ? 'Layer' : 'Layers'}</span>
                  </div>
                </div>

                <div className="bg-[#242427] border border-[#323236] rounded p-2 flex items-center gap-2">
                  <Cpu className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <div>
                    <span className="text-[10px] text-[#888888] block">Color Expression</span>
                    <span className="font-semibold text-white capitalize">{colorMode}</span>
                  </div>
                </div>
              </div>

              {/* Timestamp & Process Info */}
              <div className="bg-[#202022] border border-[#2d2d30] rounded p-2 text-[11px] space-y-1">
                <div className="flex items-center justify-between text-[#888888]">
                  <span className="flex items-center gap-1.5">
                    <Clock className="w-3 h-3 text-[#999999]" />
                    Terminated At:
                  </span>
                  <span className="text-white font-mono">{crashDate}</span>
                </div>
                <div className="flex items-center justify-between text-[#888888]">
                  <span className="flex items-center gap-1.5">
                    <Calendar className="w-3 h-3 text-[#999999]" />
                    Previous PID:
                  </span>
                  <span className="text-[#aaaaaa] font-mono">{currentSession.pid}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Action Footer */}
        <div className="flex items-center justify-between px-6 py-4 bg-[#202022] border-t border-[#343438]">
          <button
            type="button"
            disabled={isRestoring || isDiscarding}
            onClick={handleDiscardClick}
            className="flex items-center gap-2 px-4 py-2 rounded-md text-xs font-medium bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{isDiscarding ? 'Discarding...' : 'Discard & Start Fresh'}</span>
          </button>

          <button
            type="button"
            disabled={isRestoring || isDiscarding}
            onClick={handleRestoreClick}
            className="flex items-center gap-2 px-5 py-2 rounded-md text-xs font-semibold bg-[#007acc] hover:bg-[#008ae6] text-white shadow-md shadow-sky-950/40 border border-[#0090f0]/30 transition-all disabled:opacity-50 cursor-pointer active:scale-98"
          >
            <RotateCcw className={`w-3.5 h-3.5 ${isRestoring ? 'animate-spin' : ''}`} />
            <span>{isRestoring ? 'Restoring Canvas...' : 'Restore Session'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
