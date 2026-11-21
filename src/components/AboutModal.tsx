import React, { useEffect, useState } from 'react';
import {
  Bug,
  Check,
  Copy,
  ExternalLink,
  Info,
  RefreshCw,
  X,
} from 'lucide-react';
import { version as APP_VERSION } from '../../package.json';
import { isTauriEnvironment } from '../hooks/useMultiplayer';
import { updaterService } from '../services/updaterService';
import { useUpdaterStore } from '../stores/useUpdaterStore';
import {
  DISCORD_INVITE_URL,
  GITHUB_ISSUES_URL,
  GITHUB_LICENSE_URL,
  GITHUB_REPO_URL,
  openExternalUrl,
} from '../utils/externalLinks';
import { DiscordIcon } from './DiscordIcon';

export interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
  showToast?: (msg: string) => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({
  isOpen,
  onClose,
  showToast,
}) => {
  const isDesktopTauri = isTauriEnvironment();
  const runtimeAppVersion = useUpdaterStore((s) => s.currentVersion);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen && isDesktopTauri) {
      void updaterService.resolveCurrentVersion();
    }
  }, [isOpen, isDesktopTauri]);

  useEffect(() => {
    if (!isOpen) {
      setCopied(false);
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!isOpen) {
    return null;
  }

  const version = runtimeAppVersion || APP_VERSION;
  const envLabel = isDesktopTauri ? 'Desktop' : 'Web';
  const buildInfo = `Ink Studio v${version} (${envLabel})`;

  const handleCopyVersion = async () => {
    try {
      await navigator.clipboard.writeText(buildInfo);
      setCopied(true);
      showToast?.('Copied version info');
    } catch {
      showToast?.('Failed to copy version info');
    }
  };

  const handleCheckUpdates = () => {
    onClose();
    updaterService.openUpdateModal();
    const st = useUpdaterStore.getState().status;
    if (st !== 'downloading' && st !== 'ready') {
      void updaterService.checkForUpdates({ silent: false });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 select-none"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-[#202020] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.8)] w-full max-w-md flex flex-col overflow-hidden text-xs text-[#e5e5e5] border border-[#2c2c2c]"
      >
        {/* Header */}
        <div className="h-10 px-4 flex items-center justify-between bg-[#161616] border-b border-[#2c2c2c] shrink-0">
          <div className="flex items-center gap-2">
            <Info className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span id="about-modal-title" className="text-xs font-medium text-[#e5e5e5]">
              About Ink Studio
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
            title="Close (Esc)"
            aria-label="Close about dialog"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* App identity */}
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-lg bg-[#161616] border border-[#2c2c2c] flex items-center justify-center shrink-0">
              <img
                src="/app-icon.png"
                alt="Ink Studio"
                className="w-8 h-8 object-contain"
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-[#e5e5e5]">Ink Studio</h2>
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#161616] border border-[#2c2c2c] text-[#a0a0a0]">
                  v{version}
                </span>
              </div>
              <p className="text-[11px] text-[#8a8a8a] mt-0.5">
                Drawing software that doesn&apos;t charge you rent.
              </p>
            </div>
          </div>

          {/* Description */}
          <div className="space-y-2 text-[11px] text-[#b5b5b5] leading-relaxed select-text">
            <p>
              Built by Sora because paying a monthly subscription just to draw lines on a screen
              got old. It opens PSD and CSP files, loads .sut brushes, handles layers, manga tools,
              and multiplayer, and mostly behaves itself when you aren&apos;t looking.
            </p>
            <p className="text-[#8a8a8a]">
              No accounts, no telemetry, no forced AI slop, no cloud launcher eating your RAM. Hit
              Ctrl+S anyway. All software is held together by spite and duct tape.
            </p>
          </div>

          {/* Build metadata */}
          <div className="bg-[#161616] rounded border border-[#2c2c2c] divide-y divide-[#252525] text-[11px]">
            <div className="px-3 py-2 flex items-center justify-between gap-2">
              <span className="text-[#8a8a8a]">Build</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[#d4d4d4] select-text">
                  v{version} · {envLabel}
                </span>
                <button
                  type="button"
                  onClick={() => void handleCopyVersion()}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#202020] hover:bg-[#2c2c2c] text-[10px] text-[#a0a0a0] hover:text-[#e5e5e5] transition-colors cursor-pointer"
                  title="Copy version info"
                >
                  {copied ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="px-3 py-2 flex items-center justify-between gap-2">
              <span className="text-[#8a8a8a]">License</span>
              <button
                type="button"
                onClick={() => void openExternalUrl(GITHUB_LICENSE_URL)}
                className="inline-flex items-center gap-1 text-[#d4d4d4] hover:text-[var(--accent)] transition-colors cursor-pointer"
              >
                <span>GNU GPL v3.0</span>
                <ExternalLink className="w-3 h-3 opacity-70" />
              </button>
            </div>

            <div className="px-3 py-2 flex items-center justify-between gap-2">
              <span className="text-[#8a8a8a]">Stack</span>
              <span className="font-mono text-[#a0a0a0]">
                {isDesktopTauri ? 'Tauri · Rust · React · WebGL' : 'React · TypeScript · WebGL'}
              </span>
            </div>
          </div>

          {/* Links & actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void openExternalUrl(GITHUB_REPO_URL)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-[#2c2c2c] text-[11px] text-[#d4d4d4] hover:text-[#e5e5e5] transition-colors cursor-pointer"
            >
              <ExternalLink className="w-3 h-3 text-[#8a8a8a]" />
              <span>Source Code</span>
            </button>

            <button
              type="button"
              onClick={() => void openExternalUrl(GITHUB_ISSUES_URL)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-[#2c2c2c] text-[11px] text-[#d4d4d4] hover:text-[#e5e5e5] transition-colors cursor-pointer"
            >
              <Bug className="w-3 h-3 text-[#8a8a8a]" />
              <span>Report a Bug</span>
            </button>

            <button
              type="button"
              onClick={() => void openExternalUrl(DISCORD_INVITE_URL)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-[#2c2c2c] text-[11px] text-[#d4d4d4] hover:text-[#e5e5e5] transition-colors cursor-pointer"
            >
              <DiscordIcon className="w-3 h-3 text-[#5865F2]" />
              <span>Discord</span>
            </button>

            {isDesktopTauri && (
              <button
                type="button"
                onClick={handleCheckUpdates}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-[#2c2c2c] text-[11px] text-[#d4d4d4] hover:text-[#e5e5e5] transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3 h-3 text-[#8a8a8a]" />
                <span>Updates</span>
              </button>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 bg-[#161616] flex items-center justify-between gap-3 border-t border-[#2c2c2c]">
          <span className="text-[10px] text-[#737373]">
            © 2026 Sora · Provided as-is, no warranty.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 font-medium transition-opacity cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
