import React, { useEffect, useState } from 'react';
import { Users, Globe, Monitor, ArrowRight, User, X } from 'lucide-react';
import { isTauriEnvironment } from '../hooks/useMultiplayer';
import { DEEP_LINK_SCHEME, ParsedInviteLink } from '../services/multiplayerService';
import { NICKNAME_CUSTOMIZED_STORAGE_KEY, NICKNAME_STORAGE_KEY } from '../types/settings';
import { safeLocalStorageSetItem } from '../utils/safeStorage';

interface WebLandingModalProps {
  invite: ParsedInviteLink | null;
  onJoinInBrowser: (
    name: string,
    host: string,
    port: number,
    roomName: string,
    token?: string,
    isSecure?: boolean,
    persistName?: boolean
  ) => void;
  onDismiss: () => void;
}

export const WebLandingModal: React.FC<WebLandingModalProps> = ({
  invite,
  onJoinInBrowser,
  onDismiss,
}) => {
  const [userName, setUserName] = useState(() => {
    if (typeof window === 'undefined') return '';
    try {
      const customized = localStorage.getItem(NICKNAME_CUSTOMIZED_STORAGE_KEY) === '1';
      const saved = (localStorage.getItem(NICKNAME_STORAGE_KEY) || '').trim();
      return customized && saved && saved !== 'Guest' ? saved : '';
    } catch {
      return '';
    }
  });
  const isTauri = isTauriEnvironment();
  const isVisible = Boolean(invite) && !isTauri;

  useEffect(() => {
    if (!isVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isVisible, onDismiss]);

  // If running inside desktop Tauri app, don't show the web browser welcome banner
  if (!invite || isTauri) return null;

  const trimmedName = userName.trim();
  const hostDisplay = `${invite.host}${
    invite.port && invite.port !== 443 && invite.port !== 80 ? `:${invite.port}` : ''
  }`;

  const handleOpenInApp = () => {
    const tokenPart = invite.token ? `&token=${encodeURIComponent(invite.token)}` : '';
    const protoPart = invite.isSecure ? '&protocol=https' : '';
    const deepLink = `${DEEP_LINK_SCHEME}//join?host=${encodeURIComponent(invite.host)}&port=${invite.port}&room=${encodeURIComponent(invite.roomName)}${tokenPart}${protoPart}`;
    window.location.href = deepLink;
  };

  const handleJoinWithNickname = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!trimmedName) {
      handlePlayAsGuest();
      return;
    }
    safeLocalStorageSetItem(NICKNAME_STORAGE_KEY, trimmedName, 'artist name');
    safeLocalStorageSetItem(NICKNAME_CUSTOMIZED_STORAGE_KEY, '1', 'artist name flag');
    onJoinInBrowser(
      trimmedName,
      invite.host,
      invite.port,
      invite.roomName,
      invite.token,
      invite.isSecure,
      true
    );
  };

  const handlePlayAsGuest = () => {
    onJoinInBrowser(
      'Guest',
      invite.host,
      invite.port,
      invite.roomName,
      invite.token,
      invite.isSecure,
      false
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="web-landing-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 select-none"
      onClick={onDismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-[#2c2c2c] bg-[#202020] shadow-[0_24px_64px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden text-xs text-[#e5e5e5]"
      >
        {/* Header */}
        <div className="h-10 px-4 flex items-center justify-between bg-[#161616] border-b border-[#2c2c2c] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Users className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
            <h2 id="web-landing-modal-title" className="text-xs font-medium text-[#e5e5e5] truncate">
              Ink Studio Collab
            </h2>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer shrink-0"
            title="Close (Esc)"
            aria-label="Close connection dialog"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Room Info Card */}
          <div className="rounded border border-[#2c2c2c] bg-[#161616] p-3.5 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-[#8a8a8a]">
                Connecting to Canvas
              </span>
              {invite.isSecure && (
                <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#202020] border border-[#2c2c2c] text-[#a0a0a0]">
                  HTTPS · WSS
                </span>
              )}
            </div>
            <div className="text-sm font-semibold text-[#e5e5e5] truncate" title={invite.roomName}>
              {invite.roomName}
            </div>
            <div
              className="text-[11px] text-[#8a8a8a] font-mono truncate select-text"
              title={hostDisplay}
            >
              Host: {hostDisplay}
            </div>
          </div>

          <form onSubmit={handleJoinWithNickname} className="space-y-4">
            {/* Name input */}
            <div className="space-y-1.5">
              <label
                htmlFor="web-landing-nickname"
                className="flex items-center justify-between text-[11px] font-medium text-[#e5e5e5]"
              >
                <span>Choose a Nickname</span>
                <span className="font-normal text-[#8a8a8a]">Optional</span>
              </label>
              <input
                id="web-landing-nickname"
                type="text"
                autoFocus
                maxLength={40}
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Enter nickname..."
                className="w-full rounded bg-[#161616] px-3 py-2 text-xs text-[#e5e5e5] placeholder-[#8a8a8a]/50"
              />
            </div>

            {/* Action Buttons */}
            <div className="space-y-2">
              <button
                type="submit"
                className="w-full flex items-center justify-between gap-2 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 px-3.5 py-2 text-xs font-medium transition-opacity cursor-pointer"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Globe className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">
                    {trimmedName ? `Join as "${trimmedName}"` : 'Join in Browser'}
                  </span>
                </span>
                <ArrowRight className="w-3.5 h-3.5 shrink-0" />
              </button>

              <button
                type="button"
                onClick={handlePlayAsGuest}
                className="w-full flex items-center justify-between gap-2 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-[#2c2c2c] px-3.5 py-2 text-xs font-medium text-[#e5e5e5] transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-2">
                  <User className="w-3.5 h-3.5 text-[#8a8a8a]" />
                  <span>Play as Guest</span>
                </span>
                <ArrowRight className="w-3.5 h-3.5 text-[#8a8a8a]" />
              </button>

              <button
                type="button"
                onClick={handleOpenInApp}
                className="w-full flex items-center justify-between gap-2 rounded bg-[#161616] hover:bg-[#2c2c2c] border border-[#2c2c2c] px-3.5 py-2 text-xs font-medium text-[#d4d4d4] hover:text-[#e5e5e5] transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-2">
                  <Monitor className="w-3.5 h-3.5 text-[var(--accent)]" />
                  <span>Launch Desktop Client (.exe)</span>
                </span>
                <ArrowRight className="w-3.5 h-3.5 text-[#8a8a8a]" />
              </button>
            </div>
          </form>
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-[#161616] border-t border-[#2c2c2c] text-center">
          <span className="text-[10px] text-[#737373]">
            Supports graphic tablets, stylus pressure, and real-time synchronization.
          </span>
        </div>
      </div>
    </div>
  );
};
