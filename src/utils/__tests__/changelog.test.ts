import { describe, it, expect } from 'vitest';
import {
  getChangelogEntries,
  getChangelogForVersion,
  hasStructuredChangelogMarkdown,
  parseChangelog,
  parseChangelogSections,
} from '../changelog';

describe('changelog parser', () => {
  it('parses bundled CHANGELOG.md including v1.0.1 sections', () => {
    const entries = getChangelogEntries();
    expect(entries.length).toBeGreaterThan(0);

    const v101 = getChangelogForVersion('1.0.1');
    expect(v101).toBeDefined();
    expect(v101?.version).toBe('1.0.1');

    const sectionTitles = v101?.sections.map((s) => s.title);
    expect(sectionTitles).toEqual(['New', 'Improvements', 'Bug Fixes', 'Other']);
    expect(v101?.sections[0].items).toContain('Added Multi-layer Liquify');
    expect(v101?.sections[3].items).toContain('Removed the "Old Vintage" theme');
  });

  it('handles v-prefixed lookup and plain-line items without bullets', () => {
    const sample = `
# Changelog

## [v1.2.3] - 2026-12-01
### New
Added something cool
- Added bullet item
`;
    const parsed = parseChangelog(sample);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].version).toBe('1.2.3');
    expect(parsed[0].sections[0].items).toEqual([
      'Added something cool',
      'Added bullet item',
    ]);
  });

  it('parses standalone release notes bodies for the updater modal', () => {
    const notes = `### New
- Added brush import (\`.inkb\`)

### Bug Fixes
- Fixed micro-freezes`;

    expect(hasStructuredChangelogMarkdown(notes)).toBe(true);
    expect(hasStructuredChangelogMarkdown('Bug fixes and performance improvements.')).toBe(false);

    const sections = parseChangelogSections(notes);
    expect(sections).toEqual([
      { title: 'New', items: ['Added brush import (`.inkb`)'] },
      { title: 'Bug Fixes', items: ['Fixed micro-freezes'] },
    ]);
  });
});
