import React, { useState } from 'react';
import { Sparkles, Globe, Monitor, ArrowRight, X } from 'lucide-react';
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-md rounded-xl border border-[#444444] bg-[#1e1e1e] p-6 shadow-2xl text-white">
        <button
          onClick={onDismiss}
          className="absolute top-4 right-4 rounded p-1 text-[#888888] hover:bg-[#333333] hover:text-white transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Header Icon */}
        <div className="flex items-center space-x-3 mb-5">
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-[#2a2a2a] border border-[#3e3e3e] shadow-md">
            <Sparkles className="w-5 h-5 text-[#cccccc]" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white">Ink Studio Collab</h2>
            <p className="text-xs text-[#999999]">Real-time collaborative drawing</p>
          </div>
        </div>

        {/* Room Info Card */}
        <div className="rounded-lg border border-[#333333] bg-[#282828] p-3.5 mb-5 space-y-1">
          <div className="text-[11px] font-medium text-[#aaaaaa]">Connecting to canvas:</div>
          <div className="text-sm font-semibold text-white">"{invite.roomName}"</div>
          <div className="text-[11px] text-[#777777] font-mono">
            Host: {invite.host}{invite.port && invite.port !== 443 && invite.port !== 80 ? `:${invite.port}` : ''}
          </div>
        </div>

        {/* Name input */}
        <div className="mb-5">
          <label className="block text-xs font-medium text-[#cccccc] mb-1.5">
            Your nickname on canvas:
          </label>
          <input
            type="text"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="Enter nickname..."
            className="w-full rounded-md border border-[#3e3e3e] bg-[#141414] px-3.5 py-2 text-sm text-white focus:border-[#007acc] focus:outline-hidden"
          />
        </div>

        {/* Action Buttons */}
        <div className="space-y-2.5">
          <button
            onClick={handleJoinBrowser}
            className="w-full flex items-center justify-between rounded-lg border border-[#3e3e3e] bg-[#2a2a2a] hover:bg-[#333333] hover:border-[#4e4e4e] px-4 py-3 text-sm font-semibold text-white transition-colors shadow-sm cursor-pointer"
          >
            <div className="flex items-center space-x-2.5">
              <Globe className="w-4 h-4" />
              <span>Continue directly in browser</span>
            </div>
            <ArrowRight className="w-4 h-4" />
          </button>

          <button
            onClick={handleOpenInApp}
            className="w-full flex items-center justify-between rounded-lg border border-[#3e3e3e] bg-[#2a2a2a] hover:bg-[#333333] px-4 py-2.5 text-xs font-medium text-[#e0e0e0] transition-colors cursor-pointer"
          >
            <div className="flex items-center space-x-2.5">
              <Monitor className="w-4 h-4 text-emerald-400" />
              <span>Open in Ink Studio App (.exe)</span>
            </div>
          </button>
        </div>

        <div className="mt-4 text-center">
          <span className="text-[11px] text-[#777777]">
            Drawing in browser requires no installation and supports graphic tablets and styluses!
          </span>
        </div>
      </div>
    </div>
  );
};
