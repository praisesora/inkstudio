import React from 'react';
import { ChangelogEntry } from '../utils/changelog';

export interface ChangelogBoxProps {
  entry: ChangelogEntry;
  maxHeightClass?: string;
}

const SECTION_BADGE_CLASSES: Record<string, string> = {
  new: 'text-emerald-400',
  improvements: 'text-sky-400',
  'bug fixes': 'text-amber-400',
  other: 'text-[#a0a0a0]',
};

const INLINE_CODE_RE = /(`[^`]+`)/g;

/**
 * Safely render inline backtick code spans (e.g. `.inkb`, `.csp`) as styled <code> tags
 * without using dangerouslySetInnerHTML.
 */
function renderInlineCode(text: string): React.ReactNode {
  const parts = text.split(INLINE_CODE_RE);
  if (parts.length === 1) {
    return text;
  }

  return parts.map((part, idx) => {
    if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={idx}
          className="font-mono text-[10px] px-1 py-0.5 rounded bg-[#242424] border border-[#323232] text-[#e5e5e5]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

/**
 * Scrollable changelog card rendering categorized release notes from CHANGELOG.md.
 */
export const ChangelogBox: React.FC<ChangelogBoxProps> = ({
  entry,
  maxHeightClass = 'max-h-44',
}) => {
  return (
    <div
      className={`bg-[#161616] rounded border border-[#2c2c2c] p-3 ${maxHeightClass} overflow-y-auto space-y-3 select-text`}
    >
      {entry.sections.map((section, sectionIdx) => {
        const titleColor =
          SECTION_BADGE_CLASSES[section.title.toLowerCase()] ?? 'text-[#d4d4d4]';
        return (
          <div key={`${section.title || 'items'}-${sectionIdx}`} className="space-y-1">
            {section.title && (
              <div className={`text-[10px] font-semibold uppercase tracking-wider ${titleColor}`}>
                {section.title}
              </div>
            )}
            <ul className="space-y-1 pl-3.5 list-disc text-[11px] text-[#c8c8c8] leading-relaxed">
              {section.items.map((item, idx) => (
                <li key={`${section.title}-${idx}`}>{renderInlineCode(item)}</li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
};
