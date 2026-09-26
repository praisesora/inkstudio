import React, { useState } from 'react';
import { SessionHostInfo, CollabPeer } from '../types/multiplayer';
import { Users, Copy, Check, Power, Wifi, Shield, X, User, Globe, Loader2 } from 'lucide-react';

interface HostModalProps {
  isOpen: boolean;
  onClose: () => void;
  isHost: boolean;
  isConnected: boolean;
  hostInfo: SessionHostInfo | null;
  peers: CollabPeer[];
  myPeer: CollabPeer;
  onUpdateMyName: (name: string) => void;
  onStartHosting: (roomName: string, port: number, hostNickname?: string, isGlobal?: boolean) => Promise<any>;
  onStopHosting: () => void;
  showToast: (msg: string) => void;
}

export const HostModal: React.FC<HostModalProps> = ({
  isOpen,
  onClose,
  isHost,
  isConnected,
  hostInfo,
  peers,
  myPeer,
  onUpdateMyName,
  onStartHosting,
  onStopHosting,
  showToast,
}) => {
  const [roomName, setRoomName] = useState("Sora's Studio");
  const [port, setPort] = useState(30303);
  const [nickname, setNickname] = useState(myPeer.name || 'Sora');
  const [isGlobal, setIsGlobal] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copiedLocal, setCopiedLocal] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  if (!isOpen) return null;

  const handleCopyLink = async () => {
    if (!hostInfo?.inviteUrl) return;
    try {
      await navigator.clipboard.writeText(hostInfo.inviteUrl);
      setCopied(true);
      showToast('Link copied!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('Failed to copy to clipboard');
    }
  };

  const handleCopyLocalLink = async () => {
    if (!hostInfo?.localInviteUrl) return;
    try {
      await navigator.clipboard.writeText(hostInfo.localInviteUrl);
      setCopiedLocal(true);
      showToast('Local LAN link copied!');
      setTimeout(() => setCopiedLocal(false), 2000);
    } catch {
      showToast('Failed to copy to clipboard');
    }
  };

  const handleStart = async () => {
    setIsStarting(true);
    try {
      onUpdateMyName(nickname.trim() || 'Sora');
      await onStartHosting(roomName.trim() || "Sora's Studio", port, nickname.trim() || 'Sora', isGlobal);
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
      <div className="relative w-full max-w-md rounded-lg border border-[#444444] bg-[#222222] shadow-2xl text-[#e0e0e0] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#333333] px-5 py-4 bg-[#282828]">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-md bg-[#1e1e1e]/80 border border-[#383838] text-[#cccccc]">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Collaborative Drawing (Host)</h3>
              <p className="text-[11px] text-[#888888]">Local hosting without paid cloud servers</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[#888888] hover:bg-[#333333] hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {isConnected && isHost ? (
            // Active session view
            <div className="space-y-4">
              {hostInfo?.isGlobal ? (
                <div className="rounded-md border border-sky-500/30 bg-sky-500/10 p-3.5 flex items-start space-x-3">
                  <Globe className="w-5 h-5 text-sky-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <div className="text-xs font-semibold text-sky-300">Worldwide Cloudflare Tunnel Active</div>
                    <div className="text-[11px] text-[#aaaaaa] mt-0.5">
                      Room: <span className="text-white font-medium">{hostInfo?.roomName}</span> — anyone in the world can join via link in browser or app.
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3.5 flex items-start space-x-3">
                  <Wifi className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <div className="text-xs font-semibold text-emerald-300">Local Wi-Fi Server Active</div>
                    <div className="text-[11px] text-[#aaaaaa] mt-0.5">
                      Room: <span className="text-white font-medium">{hostInfo?.roomName}</span> (port {hostInfo?.port})
                    </div>
                  </div>
                </div>
              )}

              {/* Shareable Link Box */}
              <div>
                <label className="block text-[11px] font-medium text-[#aaaaaa] mb-1.5 flex items-center justify-between">
                  <span>{hostInfo?.isGlobal ? 'Worldwide Invite Link (Browser or Desktop App):' : 'Local Wi-Fi Invite Link:'}</span>
                  {hostInfo?.isGlobal && (
                    <span className="text-[10px] text-sky-400 font-mono flex items-center space-x-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
                      <span>HTTPS + WSS</span>
                    </span>
                  )}
                </label>
                <div className="flex items-center space-x-2">
                  <input
                    type="text"
                    readOnly
                    value={hostInfo?.inviteUrl || ''}
                    className="flex-1 rounded border border-[#3e3e3e] bg-[#1a1a1a] px-3 py-1.5 text-xs text-white font-mono select-all focus:outline-hidden"
                  />
                  <button
                    onClick={handleCopyLink}
                    className="flex items-center space-x-1.5 rounded border border-[#3e3e3e] bg-[#2a2a2a] hover:bg-[#333333] hover:border-[#4e4e4e] px-3 py-1.5 text-xs font-medium text-white transition-colors shadow-xs shrink-0 cursor-pointer"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'Copied!' : 'Copy'}</span>
                  </button>
                </div>

                {hostInfo?.isGlobal && hostInfo.localInviteUrl && (
                  <div className="mt-2 pt-2 border-t border-[#333333] flex items-center justify-between text-[10px] text-[#888888]">
                    <span>Local LAN: <span className="font-mono text-[#aaaaaa]">{hostInfo.localInviteUrl}</span></span>
                    <button
                      onClick={handleCopyLocalLink}
                      className="text-[#aaaaaa] hover:text-white underline cursor-pointer ml-2"
                    >
                      {copiedLocal ? 'Copied!' : 'Copy Local'}
                    </button>
                  </div>
                )}

                <p className="text-[10px] text-[#777777] mt-1.5 leading-relaxed">
                  💡 Friends can open this link directly in Chrome/Safari on PC, Mac, iPad, or enter it in the Ink Studio desktop app.
                </p>
              </div>

              {/* Connected Peers List */}
              <div>
                <div className="text-xs font-medium text-[#aaaaaa] mb-2 flex items-center justify-between">
                  <span>Participants on Canvas ({peers.length + 1})</span>
                </div>
                <div className="rounded border border-[#333333] bg-[#1a1a1a] max-h-36 overflow-y-auto divide-y divide-[#2a2a2a]">
                  {/* Host (Me) */}
                  <div className="flex items-center justify-between px-3 py-2 text-xs">
                    <div className="flex items-center space-x-2">
                      <div
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{ backgroundColor: myPeer.color }}
                      />
                      <span className="font-medium text-white">{myPeer.name} (You)</span>
                    </div>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
                      Host
                    </span>
                  </div>

                  {/* Guests */}
                  {peers.map((peer) => (
                    <div key={peer.id} className="flex items-center justify-between px-3 py-2 text-xs">
                      <div className="flex items-center space-x-2">
                        <div
                          className="w-3 h-3 rounded-full shrink-0"
                          style={{ backgroundColor: peer.color }}
                        />
                        <span className="text-[#dddddd]">{peer.name}</span>
                      </div>
                      <span className="text-[10px] text-emerald-400 flex items-center space-x-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        <span>Online</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Stop Button */}
              <div className="pt-2">
                <button
                  onClick={() => {
                    onStopHosting();
                    onClose();
                  }}
                  className="w-full flex items-center justify-center space-x-2 rounded border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 py-2 text-xs font-medium text-rose-400 transition-colors cursor-pointer"
                >
                  <Power className="w-3.5 h-3.5" />
                  <span>Stop Collaborative Session</span>
                </button>
              </div>
            </div>
          ) : (
            // Form to start hosting
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-[#cccccc] mb-1.5 flex items-center space-x-1">
                  <User className="w-3.5 h-3.5 text-[#888888]" />
                  <span>Your Nickname</span>
                </label>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="e.g. Sora"
                  className="w-full rounded border border-[#3e3e3e] bg-[#1a1a1a] px-3 py-2 text-xs text-white focus:border-[#007acc] focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#cccccc] mb-1.5">
                  Room / Canvas Name
                </label>
                <input
                  type="text"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  placeholder="e.g. Ink Studio Session"
                  className="w-full rounded border border-[#3e3e3e] bg-[#1a1a1a] px-3 py-2 text-xs text-white focus:border-[#007acc] focus:outline-hidden"
                />
              </div>

              {/* Network Mode Switcher */}
              <div>
                <label className="block text-xs font-medium text-[#cccccc] mb-1.5">
                  Connection Mode
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setIsGlobal(true)}
                    className={`flex items-start space-x-2 rounded-lg border p-2.5 text-left transition-colors cursor-pointer ${
                      isGlobal
                        ? 'border-sky-500 bg-sky-500/10 text-white'
                        : 'border-[#383838] bg-[#1a1a1a] text-[#888888] hover:border-[#484848] hover:text-[#cccccc]'
                    }`}
                  >
                    <Globe className={`w-4 h-4 shrink-0 mt-0.5 ${isGlobal ? 'text-sky-400' : 'text-[#888888]'}`} />
                    <div>
                      <div className="text-xs font-medium">Worldwide (Internet)</div>
                      <div className="text-[10px] opacity-75">Cloudflare Tunnel</div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsGlobal(false)}
                    className={`flex items-start space-x-2 rounded-lg border p-2.5 text-left transition-colors cursor-pointer ${
                      !isGlobal
                        ? 'border-emerald-500 bg-emerald-500/10 text-white'
                        : 'border-[#383838] bg-[#1a1a1a] text-[#888888] hover:border-[#484848] hover:text-[#cccccc]'
                    }`}
                  >
                    <Wifi className={`w-4 h-4 shrink-0 mt-0.5 ${!isGlobal ? 'text-emerald-400' : 'text-[#888888]'}`} />
                    <div>
                      <div className="text-xs font-medium">Local Network Only</div>
                      <div className="text-[10px] opacity-75">Same Wi-Fi network</div>
                    </div>
                  </button>
                </div>
              </div>

              {!isGlobal && (
                <div>
                  <label className="block text-xs font-medium text-[#cccccc] mb-1.5">
                    Local Port
                  </label>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                    className="w-full rounded border border-[#3e3e3e] bg-[#1a1a1a] px-3 py-2 text-xs text-white focus:border-[#007acc] focus:outline-hidden font-mono"
                  />
                  <p className="text-[10px] text-[#777777] mt-1">
                    Default is 30303. Works over local Wi-Fi or virtual LAN (Tailscale).
                  </p>
                </div>
              )}

              <div className="rounded-md border border-[#333333] bg-[#1a1a1a] p-3 text-[11px] text-[#aaaaaa] space-y-1.5">
                <div className="flex items-center space-x-1.5 text-white font-medium">
                  <Shield className="w-3.5 h-3.5 text-[#888888]" />
                  <span>{isGlobal ? '100% Free Worldwide Access' : 'Local Wi-Fi Access'}</span>
                </div>
                <p className="leading-relaxed">
                  {isGlobal
                    ? 'The app automatically launches a secure Cloudflare HTTPS tunnel. A friend from any country can draw with you instantly right in their browser without installing anything.'
                    : 'The server will be reachable only by devices connected to your same home Wi-Fi or virtual LAN (e.g. Tailscale).'}
                </p>
              </div>

              <button
                disabled={isStarting}
                onClick={handleStart}
                className="w-full flex items-center justify-center space-x-2 rounded border border-[#3e3e3e] bg-[#2a2a2a] hover:bg-[#333333] hover:border-[#4e4e4e] py-2.5 text-xs font-semibold text-white transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
              >
                {isStarting ? (
                  <>
                    <Loader2 className="w-4 h-4 text-sky-400 animate-spin" />
                    <span>{isGlobal ? 'Starting Worldwide Tunnel...' : 'Starting Server...'}</span>
                  </>
                ) : (
                  <>
                    {isGlobal ? <Globe className="w-4 h-4 text-sky-400" /> : <Users className="w-4 h-4 text-[#cccccc]" />}
                    <span>Start Server & Copy Link</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
