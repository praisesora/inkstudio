import React from 'react';

interface LiquifyIconProps {
  className?: string;
}

export const LiquifyIcon: React.FC<LiquifyIconProps> = ({ className = 'w-4 h-4' }) => {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M3 13.5c4.5 2.5 10.5 2.5 18 0" />
      <path d="M9 3c2 5 2 13 0 18" />
      <path d="M15 3c2.5 4.5 2.5 13.5 0 18" />
    </svg>
  );
};
