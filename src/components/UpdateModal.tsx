import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
  X,
} from 'lucide-react';
import { isTauriEnvironment } from '../hooks/useMultiplayer';
import { updaterService } from '../services/updaterService';
import { useDocumentStore } from '../stores/useDocumentStore';
import { useUpdaterStore } from '../stores/useUpdaterStore';

export interface UpdateModalProps {
  hasActiveCollabSession: boolean;
  onSaveFirst?: () => void;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatReleaseDate(raw: string | null): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export const UpdateModal: React.FC<UpdateModalProps> = ({
  hasActiveCollabSession,
  onSaveFirst,
}) => {
  const isModalOpen = useUpdaterStore((s) => s.isModalOpen);
  const status = useUpdaterStore((s) => s.status);
  const currentVersion = useUpdaterStore((s) => s.currentVersion);
  const availableVersion = useUpdaterStore((s) => s.availableVersion);
  const releaseDate = useUpdaterStore((s) => s.releaseDate);
  const releaseNotes = useUpdaterStore((s) => s.releaseNotes);
  const downloadedBytes = useUpdaterStore((s) => s.downloadedBytes);
  const totalBytes = useUpdaterStore((s) => s.totalBytes);
  const progressPercent = useUpdaterStore((s) => s.progressPercent);
  const errorMessage = useUpdaterStore((s) => s.errorMessage);

  const hasUnsavedChanges = useDocumentStore((s) => s.documents.some((d) => d.isDirty));
  const [confirmingGuard, setConfirmingGuard] = useState(false);

  useEffect(() => {
    if (!isModalOpen || status !== 'available') {
      setConfirmingGuard(false);
    }
  }, [isModalOpen, status]);

  if (!isTauriEnvironment() || !isModalOpen) {
    return null;
  }

  const isBusy = status === 'downloading' || status === 'ready';
  const hasSafetyRisk = hasUnsavedChanges || hasActiveCollabSession;
  const formattedDate = formatReleaseDate(releaseDate);

  const handleClose = () => {
    if (isBusy) return;
    setConfirmingGuard(false);
    updaterService.closeUpdateModal();
  };

  const handleInstallClick = () => {
    const dirtyNow = useDocumentStore.getState().documents.some((d) => d.isDirty);
    if ((dirtyNow || hasActiveCollabSession) && !confirmingGuard) {
      setConfirmingGuard(true);
      return;
    }
    setConfirmingGuard(false);
    void updaterService.downloadAndInstallUpdate();
  };

  const handleSaveFirst = () => {
    setConfirmingGuard(false);
    updaterService.closeUpdateModal();
    onSaveFirst?.();
  };

  const handleLater = () => {
    if (isBusy) return;
    setConfirmingGuard(false);
    updaterService.dismissBanner();
    updaterService.closeUpdateModal();
  };

  const handleSkipVersion = () => {
    if (isBusy) return;
    setConfirmingGuard(false);
    updaterService.skipAvailableVersion();
  };

  const safetyWarningParts: string[] = [];
  if (hasUnsavedChanges) safetyWarningParts.push('unsaved changes');
  if (hasActiveCollabSession) safetyWarningParts.push('an active multiplayer session');
  const safetyWarningLabel = safetyWarningParts.join(' and ');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 select-none"
      onClick={handleClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !isBusy) {
          handleClose();
        }
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#202020] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.8)] w-full max-w-lg flex flex-col overflow-hidden text-xs text-[#e5e5e5] border border-[#2c2c2c]"
      >
        {/* Header */}
        <div className="h-10 px-4 flex items-center justify-between bg-[#161616] shrink-0">
          <div className="flex items-center gap-2">
            <ArrowDownToLine className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span id="update-modal-title" className="text-xs font-medium text-[#e5e5e5]">
              Software Update
            </span>
          </div>
          {!isBusy && (
            <button
              type="button"
              onClick={handleClose}
              className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
              title="Close (Esc)"
              aria-label="Close update modal"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {status === 'checking' && (
            <div className="py-8 flex flex-col items-center justify-center gap-3 text-center">
              <Loader2 className="w-6 h-6 text-[var(--accent)] animate-spin" />
              <div className="space-y-1">
                <div className="text-xs font-medium text-[#e5e5e5]">
                  Checking for updates...
                </div>
                <div className="text-[11px] text-[#8a8a8a] font-mono">
                  Current version: v{currentVersion}
                </div>
              </div>
            </div>
          )}

          {status === 'up-to-date' && (
            <div className="py-6 flex flex-col items-center justify-center gap-3 text-center">
              <div className="w-10 h-10 rounded-full bg-[#161616] flex items-center justify-center text-emerald-400">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-[#e5e5e5]">
                  Ink Studio is up to date
                </div>
                <div className="text-[11px] text-[#8a8a8a] font-mono">
                  v{currentVersion} is the latest available version.
                </div>
              </div>
            </div>
          )}

          {status === 'error' && (
            <div className="space-y-3">
              <div className="p-3.5 rounded bg-[#161616] border border-red-500/30 flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <div className="space-y-1 min-w-0">
                  <div className="text-xs font-medium text-[#e5e5e5]">
                    Update check failed
                  </div>
                  <div className="text-[11px] text-[#8a8a8a] break-words">
                    {errorMessage || 'Unable to reach the update server.'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {status === 'idle' && (
            <div className="py-6 flex flex-col items-center justify-center gap-2 text-center">
              <div className="text-xs font-medium text-[#e5e5e5]">
                Check for Ink Studio updates
              </div>
              <div className="text-[11px] text-[#8a8a8a] font-mono">
                Installed version: v{currentVersion}
              </div>
            </div>
          )}

          {(status === 'available' || status === 'downloading' || status === 'ready') && (
            <>
              {/* Version comparison card */}
              <div className="p-3.5 rounded bg-[#161616] flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="text-[10px] uppercase tracking-wider text-[#8a8a8a]">
                    Version Update
                  </div>
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <span className="text-[#8a8a8a]">v{currentVersion}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-[var(--accent)]" />
                    <span className="text-[#e5e5e5] font-semibold">
                      v{availableVersion}
                    </span>
                  </div>
                </div>
                {formattedDate && (
                  <span className="text-[10px] text-[#8a8a8a] font-mono shrink-0">
                    {formattedDate}
                  </span>
                )}
              </div>

              {/* Scrollable plain-text release notes */}
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-[#e5e5e5]">Release Notes</div>
                <div className="bg-[#161616] rounded p-3 max-h-44 overflow-y-auto border border-[#2c2c2c] select-text">
                  <pre className="whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-[#e5e5e5]/90">
                    {releaseNotes?.trim() || 'Bug fixes and performance improvements.'}
                  </pre>
                </div>
              </div>

              {/* Download progress bar */}
              {(status === 'downloading' || status === 'ready') && (
                <div className="space-y-1.5 bg-[#161616] rounded p-3 border border-[#2c2c2c]">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-[#e5e5e5] font-medium flex items-center gap-1.5">
                      <Loader2 className="w-3.5 h-3.5 text-[var(--accent)] animate-spin" />
                      {status === 'ready'
                        ? 'Installing update & restarting...'
                        : 'Downloading update...'}
                    </span>
                    <span className="font-mono text-[#8a8a8a]">
                      {totalBytes
                        ? `${formatMegabytes(downloadedBytes)} / ${formatMegabytes(totalBytes)} (${progressPercent}%)`
                        : downloadedBytes > 0
                        ? formatMegabytes(downloadedBytes)
                        : `${progressPercent}%`}
                    </span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-[#2c2c2c] overflow-hidden">
                    <div
                      className="h-full bg-[var(--accent)] transition-all duration-150"
                      style={{ width: `${Math.max(2, Math.min(100, progressPercent))}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Safety warning for unsaved changes or active multiplayer session */}
              {status === 'available' && hasSafetyRisk && (
                <div
                  className={`p-3 rounded border flex items-start gap-2.5 ${
                    confirmingGuard
                      ? 'bg-amber-500/15 border-amber-500/50'
                      : 'bg-[#161616] border-amber-500/30'
                  }`}
                >
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div className="space-y-1 text-[11px]">
                    <div className="font-medium text-amber-200">
                      {confirmingGuard
                        ? 'Confirm Restart Before Installing'
                        : 'Active Work Detected'}
                    </div>
                    <p className="text-[#e5e5e5]/85 leading-relaxed">
                      You have {safetyWarningLabel} — save your work before installing, because Ink
                      Studio will restart.
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer actions */}
        <div className="px-4 py-3 bg-[#161616] flex items-center justify-between gap-2 border-t border-[#2c2c2c]">
          {status === 'available' ? (
            confirmingGuard ? (
              <>
                <button
                  type="button"
                  onClick={() => setConfirmingGuard(false)}
                  className="px-2.5 py-1.5 rounded bg-[#202020] hover:bg-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] transition-colors cursor-pointer"
                >
                  Back
                </button>
                <div className="flex items-center gap-2">
                  {hasUnsavedChanges && onSaveFirst && (
                    <button
                      type="button"
                      onClick={handleSaveFirst}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[#e5e5e5] font-medium transition-colors cursor-pointer"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>Save First</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleInstallClick}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-[#161616] font-semibold transition-colors cursor-pointer"
                  >
                    <ArrowDownToLine className="w-3.5 h-3.5" />
                    <span>Install &amp; Restart Anyway</span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleSkipVersion}
                  className="px-2.5 py-1.5 rounded text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
                >
                  Skip This Version
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleLater}
                    className="px-3 py-1.5 rounded bg-[#202020] hover:bg-[#2c2c2c] text-[#e5e5e5] transition-colors cursor-pointer"
                  >
                    Later
                  </button>
                  <button
                    type="button"
                    onClick={handleInstallClick}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 font-medium transition-opacity cursor-pointer"
                  >
                    <ArrowDownToLine className="w-3.5 h-3.5" />
                    <span>Download &amp; Install</span>
                  </button>
                </div>
              </>
            )
          ) : status === 'downloading' || status === 'ready' ? (
            <div className="w-full text-right text-[11px] text-[#8a8a8a]">
              Please keep Ink Studio open until the update completes.
            </div>
          ) : (
            <>
              <div />
              <div className="flex items-center gap-2">
                {(status === 'error' || status === 'up-to-date' || status === 'idle') && (
                  <button
                    type="button"
                    onClick={() => void updaterService.checkForUpdates({ silent: false })}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[#e5e5e5] transition-colors cursor-pointer"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>{status === 'error' ? 'Retry' : 'Check Again'}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-3 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 font-medium transition-opacity cursor-pointer"
                >
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
