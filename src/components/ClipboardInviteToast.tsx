import React from 'react';
import { Users, ArrowRight, X } from 'lucide-react';
import {
  ParsedCollabTarget,
  ParsedInviteLink,
  ParsedP2pInvite,
} from '../services/multiplayerService';

function isP2pInvite(
  invite: ParsedCollabTarget | ParsedInviteLink
): invite is ParsedP2pInvite {
  return 'kind' in invite && invite.kind === 'p2p';
}

interface ClipboardInviteToastProps {
  invite: ParsedCollabTarget | ParsedInviteLink | null;
  onJoin: (
    host: string,
    port: number,
    roomName: string,
    token?: string,
    isSecure?: boolean
  ) => void;
  onJoinTarget?: (target: ParsedCollabTarget) => void;
  onDismiss: () => void;
}

export const ClipboardInviteToast: React.FC<ClipboardInviteToastProps> = ({
  invite,
  onJoin,
  onJoinTarget,
  onDismiss,
}) => {
  if (!invite) return null;

  const subtitle = isP2pInvite(invite)
    ? `WebRTC P2P · ${invite.joinCode}`
    : `${invite.host}${invite.port && invite.port !== 443 && invite.port !== 80 ? `:${invite.port}` : ''}`;

  const handleConnect = () => {
    if ('kind' in invite && onJoinTarget) {
      onJoinTarget(invite);
      return;
    }
    if (!isP2pInvite(invite)) {
      onJoin(invite.host, invite.port, invite.roomName, invite.token, invite.isSecure);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-14 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-4 duration-200 select-none"
    >
      <div className="flex items-center gap-3 rounded-lg border border-[var(--accent-border)] bg-[#202020]/95 backdrop-blur-md px-3.5 py-2.5 shadow-[0_12px_36px_rgba(0,0,0,0.75)] text-[#e5e5e5]">
        <div className="flex items-center justify-center w-7 h-7 rounded-md bg-[#161616] border border-[#2c2c2c] text-[var(--accent)] shrink-0">
          <Users className="w-3.5 h-3.5" />
        </div>

        <div className="max-w-xs sm:max-w-sm min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold text-[#e5e5e5]">
              Invitation Detected
            </span>
          </div>
          <div className="text-[11px] text-[#d4d4d4] truncate">
            Room: <span className="font-medium text-[#e5e5e5]">"{invite.roomName}"</span>
          </div>
          <div className="text-[10px] text-[#8a8a8a] font-mono truncate">{subtitle}</div>
        </div>

        <div className="flex items-center gap-1.5 pl-1 shrink-0">
          <button
            type="button"
            onClick={handleConnect}
            className="flex items-center justify-center gap-1 min-h-[44px] min-w-[44px] rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 px-3 py-1.5 text-xs font-medium transition-opacity cursor-pointer"
          >
            <span>Connect</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss invitation"
            title="Dismiss"
            className="w-11 h-11 rounded flex items-center justify-center text-[#8a8a8a] hover:bg-[#2c2c2c] hover:text-[#e5e5e5] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
