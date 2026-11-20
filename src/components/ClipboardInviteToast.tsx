import React from 'react';
import { Users, ArrowRight, X } from 'lucide-react';
import { ParsedInviteLink } from '../services/multiplayerService';

interface ClipboardInviteToastProps {
  invite: ParsedInviteLink | null;
  onJoin: (
    host: string,
    port: number,
    roomName: string,
    token?: string,
    isSecure?: boolean
  ) => void;
  onDismiss: () => void;
}

export const ClipboardInviteToast: React.FC<ClipboardInviteToastProps> = ({
  invite,
  onJoin,
  onDismiss,
}) => {
  if (!invite) return null;

  return (
    <div className="fixed top-14 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-4 duration-200">
      <div className="flex items-center space-x-3.5 rounded-lg border border-rose-500/40 bg-[#1e1e1e]/95 backdrop-blur-md px-4 py-3 shadow-[0_10px_35px_rgba(0,0,0,0.65)] text-white">
        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-rose-600/20 text-rose-400 shrink-0">
          <Users className="w-4 h-4" />
        </div>

        <div className="max-w-xs sm:max-w-sm">
          <div className="text-[11px] font-semibold text-rose-400 tracking-wide uppercase">
            Invitation Detected
          </div>
          <div className="text-xs font-medium text-white truncate">
            Room: <span className="font-semibold text-amber-300">"{invite.roomName}"</span>
          </div>
          <div className="text-[10px] text-[#888888] font-mono mt-0.5">
            Host: {invite.host}
            {invite.port && invite.port !== 443 && invite.port !== 80 ? `:${invite.port}` : ''}
          </div>
        </div>

        <div className="flex items-center space-x-2 pl-2">
          <button
            onClick={() =>
              onJoin(invite.host, invite.port, invite.roomName, invite.token, invite.isSecure)
            }
            className="flex items-center space-x-1.5 rounded-md bg-rose-600 hover:bg-rose-500 px-3 py-1.5 text-xs font-semibold text-white transition-colors shadow-sm cursor-pointer"
          >
            <span>Connect</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onDismiss}
            className="p-1 rounded text-[#777777] hover:bg-[#333333] hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
