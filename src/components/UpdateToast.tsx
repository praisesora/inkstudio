import React from 'react';
import { ArrowDownToLine, ArrowRight, X } from 'lucide-react';
import { isTauriEnvironment } from '../hooks/useMultiplayer';
import { updaterService } from '../services/updaterService';
import { useUpdaterStore } from '../stores/useUpdaterStore';

export const UpdateToast: React.FC = () => {
  const status = useUpdaterStore((s) => s.status);
  const availableVersion = useUpdaterStore((s) => s.availableVersion);
  const isBannerDismissed = useUpdaterStore((s) => s.isBannerDismissed);
  const isModalOpen = useUpdaterStore((s) => s.isModalOpen);

  if (!isTauriEnvironment()) return null;
  if (status !== 'available' || !availableVersion || isBannerDismissed || isModalOpen) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-12 right-5 z-50 animate-in fade-in slide-in-from-bottom-4 duration-200 select-none"
    >
      <div className="flex items-center gap-3 rounded-lg border border-[var(--accent-border)] bg-[#202020]/95 backdrop-blur-md px-3.5 py-2.5 shadow-[0_12px_36px_rgba(0,0,0,0.7)] text-[#e5e5e5]">
        <div className="flex items-center justify-center w-7 h-7 rounded-md bg-[#161616] text-[var(--accent)] shrink-0">
          <ArrowDownToLine className="w-3.5 h-3.5" />
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-[#e5e5e5]">
              Update Available
            </span>
            <span className="px-1.5 py-0.5 rounded bg-[#161616] font-mono text-[10px] text-[var(--accent)]">
              v{availableVersion}
            </span>
          </div>
          <div className="text-[10px] text-[#8a8a8a] mt-0.5">
            A new version of Ink Studio is ready to install
          </div>
        </div>

        <div className="flex items-center gap-1.5 pl-1 shrink-0">
          <button
            type="button"
            onClick={() => updaterService.openUpdateModal()}
            className="flex items-center gap-1 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 px-2.5 py-1.5 text-[11px] font-medium transition-opacity cursor-pointer"
          >
            <span>View &amp; Install</span>
            <ArrowRight className="w-3 h-3" />
          </button>

          <button
            type="button"
            onClick={() => updaterService.dismissBanner()}
            className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:bg-[#2c2c2c] hover:text-[#e5e5e5] transition-colors cursor-pointer"
            title="Dismiss notification"
            aria-label="Dismiss update notification"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
