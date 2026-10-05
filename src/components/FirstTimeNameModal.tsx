import React, { useState } from 'react';
import { User, Check } from 'lucide-react';

interface FirstTimeNameModalProps {
  isOpen: boolean;
  onSaveName: (name: string) => void;
}

export const FirstTimeNameModal: React.FC<FirstTimeNameModalProps> = ({
  isOpen,
  onSaveName,
}) => {
  const [name, setName] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalName = name.trim() || 'Artist';
    onSaveName(finalName);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 select-none">
      <div className="bg-[#444447] border border-[#242426] rounded-[2px] shadow-[0_8px_24px_rgba(0,0,0,0.7)] w-full max-w-sm overflow-hidden text-[#d6d6da]">
        {/* Title Bar */}
        <div className="px-4 py-2 border-b border-[#242426] bg-gradient-to-b from-[#525255] to-[#3e3e40] flex items-center space-x-2">
          <User className="w-3.5 h-3.5 text-[#93c5fd]" />
          <h2 className="text-xs font-semibold text-[#f0f0f4] tracking-wide">
            Artist Profile
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="user-name-input" className="block text-xs font-medium text-[#cccccc]">
              Display Name
            </label>
            <input
              id="user-name-input"
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Artist"
              maxLength={40}
              className="w-full px-2.5 py-1.5 bg-[#2b2b2e] border border-[#1e1e20] rounded-[2px] text-xs text-[#f0f0f4] placeholder-[#707075] outline-none focus:border-[#4a8fc7] shadow-[inset_1px_1px_2px_rgba(0,0,0,0.5)]"
            />
            <p className="text-[10px] text-[#8c8c92]">
              Configures session metadata. Editable anytime in Preferences.
            </p>
          </div>

          <div className="flex items-center justify-end space-x-2 pt-2 border-t border-[#363639]">
            <button
              type="submit"
              className="flex items-center space-x-1 px-4 py-1.5 rounded-[2px] bg-gradient-to-b from-[#56565a] to-[#424245] hover:from-[#626266] hover:to-[#4b4b4e] border border-[#242426] text-xs font-medium text-[#f0f0f4] shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_1px_1px_rgba(0,0,0,0.3)] cursor-pointer"
            >
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span>Continue</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
