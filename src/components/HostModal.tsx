import React, { useState, useEffect, useRef } from 'react';
import {
  SessionHostInfo,
  CollabPeer,
  CollabRole,
  ConnectionStatus,
} from '../types/multiplayer';
import {
  Users,
  Copy,
  Check,
  Power,
  Wifi,
  Shield,
  X,
  User,
  Globe,
  Loader2,
  Link2,
  LogOut,
  AlertTriangle,
  Ban,
  UserX,
  RefreshCw,
} from 'lucide-react';

interface HostModalProps {
  isOpen: boolean;
  onClose: () => void;
  isHost: boolean;
  isConnected: boolean;
  connectionStatus?: ConnectionStatus;
  reconnectAttempt?: number;
  myRole?: CollabRole;
  hostInfo: SessionHostInfo | null;
  peers: CollabPeer[];
  bannedPeerIds?: string[];
  myPeer: CollabPeer;
  onUpdateMyName: (name: string) => void;
  onStartHosting: (
    roomName: string,
    port: number,
    hostNickname?: string,
    isGlobal?: boolean,
    onStatus?: (status: string) => void
  ) => Promise<any>;
  onStopHosting: () => void;
  onJoinByInviteUrl: (rawUrl: string, nickname?: string, persistName?: boolean) => Promise<boolean>;
  onLeaveRoom: () => void;
  onSetPeerRole?: (peerId: string | number, role: 'editor' | 'viewer') => void;
  onKickPeer?: (peerId: string | number) => void;
  onBanPeer?: (peerId: string | number) => void;
  onUnbanPeer?: (peerId: string | number) => void;
  showToast: (msg: string) => void;
}

function defaultStudioName(name: string): string {
  const clean = (name || '').trim();
  return clean ? `${clean}'s Studio` : 'Ink Studio Session';
}

export const HostModal: React.FC<HostModalProps> = ({
  isOpen,
  onClose,
  isHost,
  isConnected,
  connectionStatus = isConnected ? 'connected' : 'disconnected',
  reconnectAttempt = 0,
  myRole = isHost ? 'host' : 'editor',
  hostInfo,
  peers,
  bannedPeerIds = [],
  myPeer,
  onUpdateMyName,
  onStartHosting,
  onStopHosting,
  onJoinByInviteUrl,
  onLeaveRoom,
  onSetPeerRole,
  onKickPeer,
  onBanPeer,
  onUnbanPeer,
  showToast,
}) => {
  const [activeTab, setActiveTab] = useState<'host' | 'join'>('host');
  const [nickname, setNickname] = useState(myPeer.name || 'Artist');
  const [roomName, setRoomName] = useState(() => defaultStudioName(myPeer.name));
  const [port, setPort] = useState(30303);
  const [isGlobal, setIsGlobal] = useState(true);
  const [joinUrl, setJoinUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedLocal, setCopiedLocal] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [startStatus, setStartStatus] = useState('');
  const [startError, setStartError] = useState<string | null>(null);

  const nicknameEditedRef = useRef(false);
  const roomNameEditedRef = useRef(false);

  // Sync nickname & default room name when OS username resolves or Preferences changes
  useEffect(() => {
    if (!nicknameEditedRef.current && myPeer.name) {
      setNickname(myPeer.name);
    }
    if (!roomNameEditedRef.current && myPeer.name) {
      setRoomName(defaultStudioName(myPeer.name));
    }
  }, [myPeer.name]);

  // Reset transient error when modal re-opens
  useEffect(() => {
    if (isOpen) {
      setStartError(null);
    }
  }, [isOpen]);

  // Escape key closes modal
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleCopyLink = async () => {
    if (!hostInfo?.inviteUrl) return;
    try {
      await navigator.clipboard.writeText(hostInfo.inviteUrl);
      setCopied(true);
      showToast('Invite link copied.');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('Failed to copy to clipboard.');
    }
  };

  const handleCopyLocalLink = async () => {
    if (!hostInfo?.localInviteUrl) return;
    try {
      await navigator.clipboard.writeText(hostInfo.localInviteUrl);
      setCopiedLocal(true);
      showToast('Local LAN link copied.');
      setTimeout(() => setCopiedLocal(false), 2000);
    } catch {
      showToast('Failed to copy to clipboard.');
    }
  };

  const handleStart = async (overrideGlobal?: boolean) => {
    const useGlobal = overrideGlobal !== undefined ? overrideGlobal : isGlobal;
    setIsStarting(true);
    setStartError(null);
    setStartStatus(useGlobal ? 'Starting Worldwide Tunnel...' : 'Starting Local Server...');
    try {
      const resolvedName = nickname.trim() || myPeer.name || 'Artist';
      if (nicknameEditedRef.current && resolvedName !== myPeer.name) {
        onUpdateMyName(resolvedName);
      }
      const resolvedRoom = roomName.trim() || defaultStudioName(resolvedName);
      await onStartHosting(resolvedRoom, port, resolvedName, useGlobal, (status) => {
        setStartStatus(status);
      });
    } catch (err: any) {
      const msg = err?.message || (typeof err === 'string' ? err : 'Failed to start server');
      setStartError(msg);
    } finally {
      setIsStarting(false);
      setStartStatus('');
    }
  };

  const handleJoinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedUrl = joinUrl.trim();
    if (!trimmedUrl) {
      showToast('Paste a room invite link first.');
      return;
    }
    setIsJoining(true);
    try {
      const resolvedName = nickname.trim() || myPeer.name || 'Artist';
      if (nicknameEditedRef.current && resolvedName !== myPeer.name) {
        onUpdateMyName(resolvedName);
      }
      const ok = await onJoinByInviteUrl(trimmedUrl, resolvedName, nicknameEditedRef.current);
      if (ok) {
        setJoinUrl('');
        onClose();
      }
    } finally {
      setIsJoining(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="host-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 select-none"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md rounded-lg border border-[#2c2c2c] bg-[#202020] shadow-[0_24px_64px_rgba(0,0,0,0.85)] text-[#e5e5e5] overflow-hidden"
      >
        {/* Header */}
        <div className="h-11 px-4 flex items-center justify-between border-b border-[#2c2c2c] bg-[#161616]">
          <div className="flex items-center gap-2.5 min-w-0">
            <Users className="w-4 h-4 text-[var(--accent)] shrink-0" />
            <div className="min-w-0">
              <h3 id="host-modal-title" className="text-xs font-medium text-[#e5e5e5] leading-tight">
                Collaborative Drawing
              </h3>
              <p className="text-[10px] text-[#8a8a8a] truncate">
                {connectionStatus === 'reconnecting'
                  ? `Reconnecting (attempt ${reconnectAttempt || 1})...`
                  : isConnected
                    ? isHost
                      ? 'Hosting active session'
                      : `Connected as ${myRole === 'viewer' ? 'Viewer (Read-Only)' : 'Editor'}`
                    : 'Host or join a live canvas session'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Cancel (Esc)"
            className="w-6 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:bg-[#2c2c2c] hover:text-[#e5e5e5] transition-colors cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {connectionStatus === 'reconnecting' ? (
            <div className="space-y-4">
              <div className="rounded-md border border-amber-500/35 bg-amber-500/10 p-3.5 flex items-start space-x-3">
                <RefreshCw className="w-4 h-4 text-amber-400 shrink-0 mt-0.5 animate-spin" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-amber-300">
                    Reconnecting to Session...
                  </div>
                  <div className="text-[11px] text-[#b5b5b5] mt-0.5 truncate">
                    Room: <span className="text-[#e5e5e5] font-medium">{hostInfo?.roomName || 'Studio'}</span>{' '}
                    (attempt {reconnectAttempt || 1})
                  </div>
                  <div className="text-[10px] text-[#8a8a8a] mt-1">
                    Session state is preserved. Missed tiles and layer updates will catch up automatically.
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (isHost) {
                    onStopHosting();
                  } else {
                    onLeaveRoom();
                  }
                  onClose();
                }}
                className="w-full flex items-center justify-center gap-2 rounded border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 py-2 text-xs font-medium text-red-400 transition-colors cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>{isHost ? 'Stop Session' : 'Cancel & Leave'}</span>
              </button>
            </div>
          ) : isConnected && isHost ? (
            // Active Host View
            <div className="space-y-4">
              {hostInfo?.isGlobal ? (
                <div className="rounded-md border border-[var(--accent-border)] bg-[#161616] p-3.5 flex items-start gap-3">
                  <Globe className="w-4 h-4 text-[var(--accent)] shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-[#e5e5e5]">
                      Worldwide Cloudflare Tunnel Active
                    </div>
                    <div className="text-[11px] text-[#8a8a8a] mt-0.5">
                      Room: <span className="text-[#e5e5e5] font-medium">{hostInfo?.roomName}</span> —
                      anyone on any network can join via link in browser or desktop app.
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3.5 flex items-start gap-3">
                  <Wifi className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-emerald-300">
                      Local Wi-Fi Server Active
                    </div>
                    <div className="text-[11px] text-[#b5b5b5] mt-0.5">
                      Room: <span className="text-[#e5e5e5] font-medium">{hostInfo?.roomName}</span>{' '}
                      (port {hostInfo?.port})
                    </div>
                  </div>
                </div>
              )}

              {/* Shareable Link Box */}
              <div>
                <label className="block text-[11px] font-medium text-[#8a8a8a] mb-1.5 flex items-center justify-between">
                  <span>
                    {hostInfo?.isGlobal
                      ? 'Worldwide Invite Link (Browser or Desktop App)'
                      : 'Local Wi-Fi Invite Link'}
                  </span>
                  {hostInfo?.isGlobal && (
                    <span className="text-[10px] text-[var(--accent)] font-mono flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      <span>HTTPS + WSS</span>
                    </span>
                  )}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={hostInfo?.inviteUrl || ''}
                    className="flex-1 rounded border border-[#2c2c2c] bg-[#161616] px-3 py-1.5 text-xs text-[#e5e5e5] font-mono select-all focus:outline-hidden"
                  />
                  <button
                    type="button"
                    onClick={handleCopyLink}
                    className="flex items-center gap-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 px-3 py-1.5 text-xs font-medium transition-opacity shrink-0 cursor-pointer"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>

                {hostInfo?.isGlobal && hostInfo.localInviteUrl && (
                  <div className="mt-2 pt-2 border-t border-[#2c2c2c] flex items-center justify-between text-[10px] text-[#8a8a8a]">
                    <span className="truncate">
                      Local LAN:{' '}
                      <span className="font-mono text-[#b5b5b5]">{hostInfo.localInviteUrl}</span>
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyLocalLink}
                      className="text-[#b5b5b5] hover:text-[#e5e5e5] underline cursor-pointer ml-2 shrink-0"
                    >
                      {copiedLocal ? 'Copied' : 'Copy Local'}
                    </button>
                  </div>
                )}

                <p className="text-[10px] text-[#8a8a8a] mt-1.5 leading-relaxed">
                  Share this link to open directly in a browser or paste it into the Join tab in the
                  desktop app.
                </p>
              </div>

              {/* Connected Peers List */}
              <div>
                <div className="text-[11px] font-medium text-[#8a8a8a] mb-1.5 flex items-center justify-between">
                  <span>Participants on Canvas ({peers.length + 1})</span>
                </div>
                <div className="rounded-md border border-[#2c2c2c] bg-[#161616] max-h-36 overflow-y-auto divide-y divide-[#252525]">
                  <div className="flex items-center justify-between px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: myPeer.color }}
                      />
                      <span className="font-medium text-[#e5e5e5]">{myPeer.name} (You)</span>
                    </div>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
                      Host
                    </span>
                  </div>

                  {peers.map((peer) => {
                    const peerRole = peer.role === 'viewer' ? 'viewer' : 'editor';
                    return (
                      <div
                        key={peer.id}
                        className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <div
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: peer.color }}
                          />
                          <span className="text-[#d4d4d4] truncate">{peer.name}</span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {onSetPeerRole ? (
                            <select
                              aria-label={`Role for ${peer.name}`}
                              value={peerRole}
                              onChange={(e) =>
                                onSetPeerRole(
                                  peer.id,
                                  e.target.value === 'viewer' ? 'viewer' : 'editor'
                                )
                              }
                              className="rounded border border-[#2c2c2c] bg-[#202020] px-1.5 py-0.5 text-[10px] text-[#e5e5e5] focus:outline-hidden cursor-pointer"
                            >
                              <option value="editor">Editor</option>
                              <option value="viewer">Viewer</option>
                            </select>
                          ) : (
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#262626] text-[#8a8a8a] capitalize">
                              {peerRole}
                            </span>
                          )}
                          {onKickPeer && (
                            <button
                              type="button"
                              onClick={() => onKickPeer(peer.id)}
                              title={`Kick ${peer.name}`}
                              className="p-1 rounded text-[#8a8a8a] hover:text-amber-300 hover:bg-amber-500/15 transition-colors cursor-pointer"
                            >
                              <UserX className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {onBanPeer && (
                            <button
                              type="button"
                              onClick={() => onBanPeer(peer.id)}
                              title={`Ban ${peer.name}`}
                              className="p-1 rounded text-[#8a8a8a] hover:text-red-400 hover:bg-red-500/15 transition-colors cursor-pointer"
                            >
                              <Ban className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {bannedPeerIds.length > 0 && (
                <div>
                  <div className="text-[11px] font-medium text-[#8a8a8a] mb-1.5">
                    Banned Peers ({bannedPeerIds.length})
                  </div>
                  <div className="rounded-md border border-[#2c2c2c] bg-[#161616] max-h-24 overflow-y-auto divide-y divide-[#252525]">
                    {bannedPeerIds.map((pid) => (
                      <div
                        key={pid}
                        className="flex items-center justify-between px-3 py-1.5 text-[11px]"
                      >
                        <span className="font-mono text-[#8a8a8a] truncate">{pid}</span>
                        {onUnbanPeer && (
                          <button
                            type="button"
                            onClick={() => onUnbanPeer(pid)}
                            className="text-[10px] text-[var(--accent)] hover:underline ml-2 shrink-0 cursor-pointer"
                          >
                            Unban
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Stop Button */}
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => {
                    onStopHosting();
                    onClose();
                  }}
                  className="w-full flex items-center justify-center gap-2 rounded border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 py-2 text-xs font-medium text-red-400 transition-colors cursor-pointer"
                >
                  <Power className="w-3.5 h-3.5" />
                  <span>Stop Collaborative Session</span>
                </button>
              </div>
            </div>
          ) : isConnected ? (
            // Active Guest View
            <div className="space-y-4">
              <div className="rounded-md border border-[var(--accent-border)] bg-[#161616] p-3.5 flex items-start gap-3">
                <Globe className="w-4 h-4 text-[var(--accent)] shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-[#e5e5e5]">Connected to Session</div>
                  <div className="text-[11px] text-[#8a8a8a] mt-0.5 truncate">
                    Room:{' '}
                    <span className="text-[#e5e5e5] font-medium">
                      {hostInfo?.roomName || 'Studio'}
                    </span>
                  </div>
                  {hostInfo?.localIp && (
                    <div className="text-[10px] text-[#8a8a8a] font-mono truncate mt-0.5">
                      {hostInfo.localIp}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="text-[11px] font-medium text-[#8a8a8a] mb-1.5">
                  Participants on Canvas ({peers.length + 1})
                </div>
                <div className="rounded-md border border-[#2c2c2c] bg-[#161616] max-h-40 overflow-y-auto divide-y divide-[#252525]">
                  <div className="flex items-center justify-between px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: myPeer.color }}
                      />
                      <span className="font-medium text-[#e5e5e5]">{myPeer.name} (You)</span>
                    </div>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded capitalize ${
                        myRole === 'viewer'
                          ? 'bg-[#262626] text-[#8a8a8a]'
                          : 'bg-emerald-500/15 text-emerald-300'
                      }`}
                    >
                      {myRole}
                    </span>
                  </div>
                  {peers.map((peer) => (
                    <div
                      key={peer.id}
                      className="flex items-center justify-between px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: peer.color }}
                        />
                        <span className="text-[#d4d4d4]">{peer.name}</span>
                      </div>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#262626] text-[#8a8a8a] capitalize">
                        {peer.isHost ? 'Host' : peer.role || 'Editor'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => {
                    onLeaveRoom();
                    onClose();
                  }}
                  className="w-full flex items-center justify-center gap-2 rounded border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 py-2 text-xs font-medium text-red-400 transition-colors cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Leave Session</span>
                </button>
              </div>
            </div>
          ) : (
            // Disconnected: Host / Join Tabs
            <div className="space-y-4">
              <div className="grid grid-cols-2 rounded-md border border-[#2c2c2c] bg-[#161616] p-0.5">
                <button
                  type="button"
                  onClick={() => setActiveTab('host')}
                  className={`rounded py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                    activeTab === 'host'
                      ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                      : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                  }`}
                >
                  Host Session
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('join')}
                  className={`rounded py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                    activeTab === 'join'
                      ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                      : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                  }`}
                >
                  Join via Link
                </button>
              </div>

              <div>
                <label className="text-[11px] font-medium text-[#b5b5b5] mb-1.5 flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5 text-[#8a8a8a]" />
                  <span>Your Nickname</span>
                </label>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => {
                    nicknameEditedRef.current = true;
                    setNickname(e.target.value);
                  }}
                  maxLength={40}
                  placeholder="Your name"
                  className="w-full rounded border border-[#2c2c2c] bg-[#161616] px-3 py-2 text-xs text-[#e5e5e5] focus:border-[var(--accent-border)] focus:outline-hidden"
                />
              </div>

              {activeTab === 'host' ? (
                <>
                  <div>
                    <label className="block text-[11px] font-medium text-[#b5b5b5] mb-1.5">
                      Room / Canvas Name
                    </label>
                    <input
                      type="text"
                      value={roomName}
                      onChange={(e) => {
                        roomNameEditedRef.current = true;
                        setRoomName(e.target.value);
                      }}
                      placeholder="Ink Studio Session"
                      className="w-full rounded border border-[#2c2c2c] bg-[#161616] px-3 py-2 text-xs text-[#e5e5e5] focus:border-[var(--accent-border)] focus:outline-hidden"
                    />
                  </div>

                  {/* Network Mode Switcher */}
                  <div>
                    <label className="block text-[11px] font-medium text-[#b5b5b5] mb-1.5">
                      Connection Mode
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setIsGlobal(true);
                          setStartError(null);
                        }}
                        className={`flex items-start gap-2 rounded-md border p-2.5 text-left transition-colors cursor-pointer ${
                          isGlobal
                            ? 'border-[var(--accent-border)] bg-[var(--accent-subtle)] text-[#e5e5e5]'
                            : 'border-[#2c2c2c] bg-[#161616] text-[#8a8a8a] hover:border-[#3a3a3a] hover:text-[#e5e5e5]'
                        }`}
                      >
                        <Globe
                          className={`w-4 h-4 shrink-0 mt-0.5 ${isGlobal ? 'text-[var(--accent)]' : 'text-[#8a8a8a]'}`}
                        />
                        <div>
                          <div className="text-xs font-medium">Worldwide (Internet)</div>
                          <div className="text-[10px] opacity-75">Cloudflare Tunnel</div>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setIsGlobal(false);
                          setStartError(null);
                        }}
                        className={`flex items-start gap-2 rounded-md border p-2.5 text-left transition-colors cursor-pointer ${
                          !isGlobal
                            ? 'border-[var(--accent-border)] bg-[var(--accent-subtle)] text-[#e5e5e5]'
                            : 'border-[#2c2c2c] bg-[#161616] text-[#8a8a8a] hover:border-[#3a3a3a] hover:text-[#e5e5e5]'
                        }`}
                      >
                        <Wifi
                          className={`w-4 h-4 shrink-0 mt-0.5 ${!isGlobal ? 'text-[var(--accent)]' : 'text-[#8a8a8a]'}`}
                        />
                        <div>
                          <div className="text-xs font-medium">Local Network Only</div>
                          <div className="text-[10px] opacity-75">Same Wi-Fi network</div>
                        </div>
                      </button>
                    </div>
                  </div>

                  {!isGlobal && (
                    <div>
                      <label className="block text-[11px] font-medium text-[#b5b5b5] mb-1.5">
                        Local Port
                      </label>
                      <input
                        type="number"
                        value={port}
                        onChange={(e) => setPort(Number(e.target.value))}
                        className="w-full rounded border border-[#2c2c2c] bg-[#161616] px-3 py-2 text-xs text-[#e5e5e5] focus:border-[var(--accent-border)] focus:outline-hidden font-mono"
                      />
                      <p className="text-[10px] text-[#8a8a8a] mt-1">
                        Default is 30303. Works over local Wi-Fi or virtual LAN (Tailscale).
                      </p>
                    </div>
                  )}

                  {startError && (
                    <div className="rounded-md border border-red-500/35 bg-red-500/10 p-3 text-[11px] text-red-300 space-y-2">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
                        <span className="break-words">{startError}</span>
                      </div>
                      {isGlobal && (
                        <button
                          type="button"
                          onClick={() => {
                            setIsGlobal(false);
                            void handleStart(false);
                          }}
                          className="text-[11px] text-[#e5e5e5] underline hover:text-white cursor-pointer"
                        >
                          Start Local Wi-Fi Server instead
                        </button>
                      )}
                    </div>
                  )}

                  <div className="rounded-md border border-[#2c2c2c] bg-[#161616] p-3 text-[11px] text-[#8a8a8a] space-y-1">
                    <div className="flex items-center gap-1.5 text-[#e5e5e5] font-medium">
                      <Shield className="w-3.5 h-3.5 text-[#8a8a8a]" />
                      <span>
                        {isGlobal ? 'Encrypted Worldwide Tunnel' : 'Local Wi-Fi Access'}
                      </span>
                    </div>
                    <p className="leading-relaxed">
                      {isGlobal
                        ? 'Launches a Cloudflare HTTPS/WSS tunnel (HTTP/2 over port 443) so friends on any network can join in a browser or desktop app.'
                        : 'Reachable only by devices on the same Wi-Fi network or virtual LAN (e.g. Tailscale).'}
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={isStarting}
                    onClick={() => void handleStart()}
                    className="w-full flex items-center justify-center gap-2 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 py-2 text-xs font-medium transition-opacity disabled:opacity-50 cursor-pointer"
                  >
                    {isStarting ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>
                          {startStatus ||
                            (isGlobal ? 'Starting Worldwide Tunnel...' : 'Starting Server...')}
                        </span>
                      </>
                    ) : (
                      <>
                        {isGlobal ? (
                          <Globe className="w-3.5 h-3.5" />
                        ) : (
                          <Users className="w-3.5 h-3.5" />
                        )}
                        <span>Start Server &amp; Copy Link</span>
                      </>
                    )}
                  </button>
                </>
              ) : (
                <form onSubmit={handleJoinSubmit} className="space-y-4">
                  <div>
                    <label className="text-[11px] font-medium text-[#b5b5b5] mb-1.5 flex items-center gap-1.5">
                      <Link2 className="w-3.5 h-3.5 text-[#8a8a8a]" />
                      <span>Invite Link</span>
                    </label>
                    <input
                      type="text"
                      value={joinUrl}
                      onChange={(e) => setJoinUrl(e.target.value)}
                      placeholder="https://....trycloudflare.com/?room=...&token=..."
                      className="w-full rounded border border-[#2c2c2c] bg-[#161616] px-3 py-2 text-xs text-[#e5e5e5] font-mono focus:border-[var(--accent-border)] focus:outline-hidden"
                    />
                    <p className="text-[10px] text-[#8a8a8a] mt-1">
                      Paste the full worldwide or LAN invite link shared by the host.
                    </p>
                  </div>

                  <button
                    type="submit"
                    disabled={isJoining || !joinUrl.trim()}
                    className="w-full flex items-center justify-center gap-2 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 py-2 text-xs font-medium transition-opacity disabled:opacity-50 cursor-pointer"
                  >
                    {isJoining ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Connecting...</span>
                      </>
                    ) : (
                      <>
                        <Link2 className="w-3.5 h-3.5" />
                        <span>Join Session</span>
                      </>
                    )}
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
