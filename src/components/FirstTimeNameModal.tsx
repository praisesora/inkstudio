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
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-time-name-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 select-none"
    >
      <div className="bg-[#202020] border border-[#2c2c2c] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.85)] w-full max-w-[400px] overflow-hidden text-xs text-[#e5e5e5]">
        {/* Title Bar */}
        <div className="h-9 px-3.5 bg-[#161616] border-b border-[#2c2c2c] flex items-center gap-2">
          <User className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
          <h2 id="first-time-name-title" className="text-xs font-medium text-[#e5e5e5] tracking-wide">
            Artist Profile
          </h2>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="p-4 space-y-2">
            <label htmlFor="user-name-input" className="block text-[11px] font-medium text-[#e5e5e5]">
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
              className="w-full px-3 py-2 bg-[#161616] border border-[#2c2c2c] rounded text-xs text-[#e5e5e5] placeholder-[#8a8a8a]/60 focus:border-[var(--accent-border)] outline-none"
            />
            <p className="text-[11px] text-[#8a8a8a]">
              Configures session metadata. Editable anytime in Preferences.
            </p>
          </div>

          <div className="px-4 py-2.5 bg-[#161616] border-t border-[#2c2c2c] flex items-center justify-end">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 text-xs font-medium transition-opacity cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Continue</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
