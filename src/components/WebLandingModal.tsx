import React, { useState } from 'react';
import { Users, Globe, Monitor, ArrowRight, X } from 'lucide-react';
import { isTauriEnvironment } from '../hooks/useMultiplayer';

interface WebLandingModalProps {
  invite: {
    roomName: string;
    host: string;
    port: number;
    url: string;
  } | null;
  onJoinInBrowser: (name: string, host: string, port: number, roomName: string) => void;
  onDismiss: () => void;
}

export const WebLandingModal: React.FC<WebLandingModalProps> = ({
  invite,
  onJoinInBrowser,
  onDismiss,
}) => {
  const [userName, setUserName] = useState(() => {
    return (typeof window !== 'undefined' && localStorage.getItem('sora_paint_nickname')) || 'Guest';
  });
  const isTauri = isTauriEnvironment();

  // If running inside desktop Tauri app, don't show the web browser welcome banner
  if (!invite || isTauri) return null;

  const handleOpenInApp = () => {
    // Attempt deep link protocol
    const deepLink = `forsora://join?host=${encodeURIComponent(invite.host)}&port=${invite.port}&room=${encodeURIComponent(invite.roomName)}`;
    window.location.href = deepLink;
  };

  const handleJoinBrowser = () => {
    const finalName = userName.trim() || 'Guest';
    if (typeof window !== 'undefined') {
      localStorage.setItem('sora_paint_nickname', finalName);
    }
    onJoinInBrowser(finalName, invite.host, invite.port, invite.roomName);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 select-none">
      <div className="relative w-full max-w-md rounded-[2px] border border-[#242426] bg-[#444447] p-5 shadow-[0_8px_24px_rgba(0,0,0,0.8)] text-[#d6d6da]">
        <button
          onClick={onDismiss}
          className="absolute top-3 right-3 rounded-[2px] p-1 text-[#99999e] hover:bg-[#525255] hover:text-white transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Header Icon */}
        <div className="flex items-center space-x-2.5 mb-4">
          <div className="flex items-center justify-center w-8 h-8 rounded-[2px] bg-[#363639] border border-[#242426] shadow-xs">
            <Users className="w-4 h-4 text-[#93c5fd]" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[#f0f0f4]">Ink Studio Collab</h2>
            <p className="text-[11px] text-[#8c8c92]">Real-time canvas session</p>
          </div>
        </div>

        {/* Room Info Card */}
        <div className="rounded-[2px] border border-[#242426] bg-[#2b2b2e] p-3 mb-4 space-y-1 shadow-[inset_1px_1px_2px_rgba(0,0,0,0.5)]">
          <div className="text-[11px] font-medium text-[#99999e]">Connecting to canvas:</div>
          <div className="text-xs font-semibold text-[#f0f0f4]">"{invite.roomName}"</div>
          <div className="text-[10px] text-[#808085] font-mono">
            Host: {invite.host}{invite.port && invite.port !== 443 && invite.port !== 80 ? `:${invite.port}` : ''}
          </div>
        </div>

        {/* Name input */}
        <div className="mb-4 space-y-1">
          <label className="block text-xs font-medium text-[#cccccc]">
            Artist Nickname:
          </label>
          <input
            type="text"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="Artist..."
            className="w-full rounded-[2px] border border-[#1e1e20] bg-[#2b2b2e] px-2.5 py-1.5 text-xs text-[#f0f0f4] placeholder-[#707075] outline-none focus:border-[#4a8fc7] shadow-[inset_1px_1px_2px_rgba(0,0,0,0.5)]"
          />
        </div>

        {/* Action Buttons */}
        <div className="space-y-2">
          <button
            onClick={handleJoinBrowser}
            className="w-full flex items-center justify-between rounded-[2px] border border-[#242426] bg-gradient-to-b from-[#56565a] to-[#424245] hover:from-[#626266] hover:to-[#4b4b4e] px-3.5 py-2 text-xs font-medium text-[#f0f0f4] transition-colors shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_1px_rgba(0,0,0,0.3)] cursor-pointer"
          >
            <div className="flex items-center space-x-2">
              <Globe className="w-3.5 h-3.5 text-[#93c5fd]" />
              <span>Connect in Web Browser</span>
            </div>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleOpenInApp}
            className="w-full flex items-center justify-between rounded-[2px] border border-[#242426] bg-gradient-to-b from-[#48484c] to-[#38383b] hover:from-[#525256] hover:to-[#404043] px-3.5 py-2 text-xs font-medium text-[#d0d0d5] transition-colors shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] cursor-pointer"
          >
            <div className="flex items-center space-x-2">
              <Monitor className="w-3.5 h-3.5 text-emerald-400" />
              <span>Launch Desktop Client (.exe)</span>
            </div>
          </button>
        </div>

        <div className="mt-3.5 text-center">
          <span className="text-[10px] text-[#808085]">
            Supports graphic tablets, stylus pressure, and real-time synchronization.
          </span>
        </div>
      </div>
    </div>
  );
};
