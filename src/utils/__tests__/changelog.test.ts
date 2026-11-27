import { describe, it, expect } from 'vitest';
import {
  getChangelogEntries,
  getChangelogForVersion,
  hasStructuredChangelogMarkdown,
  parseChangelog,
  parseChangelogSections,
} from '../changelog';

describe('changelog parser', () => {
  it('parses bundled CHANGELOG.md including v1.0.4, v1.0.3, v1.0.2, and v1.0.1 sections', () => {
    const entries = getChangelogEntries();
    expect(entries.length).toBeGreaterThanOrEqual(4);

    const latest = getChangelogForVersion();
    expect(latest?.version).toBe('1.0.4');

    const v104 = getChangelogForVersion('1.0.4');
    expect(v104).toBeDefined();
    expect(v104?.version).toBe('1.0.4');
    expect(v104?.sections.map((s) => s.title)).toEqual([
      'New',
      'Improvements',
      'Bug Fixes',
    ]);
    expect(v104?.sections[0].items).toContain(
      'Added full Dual Brush support'
    );
    expect(v104?.sections[1].items).toContain(
      'Improved paper texture effects and brush color mixing to feel closer to Clip Studio Paint'
    );
    expect(v104?.sections[2].items).toContain(
      'Fixed ghost strokes briefly reappearing on the canvas when drawing right after pressing `Ctrl+Z`'
    );

    const v103 = getChangelogForVersion('1.0.3');
    expect(v103).toBeDefined();
    expect(v103?.version).toBe('1.0.3');
    expect(v103?.sections.map((s) => s.title)).toEqual([
      'New',
      'Improvements',
      'Bug Fixes',
    ]);
    expect(v103?.sections[0].items).toContain(
      'Added live render engine indicator and one-click memory purge button to the Info Panel'
    );
    expect(v103?.sections[1].items).toContain(
      'Extra fix for importing brushes in the `.sut` extension'
    );
    expect(v103?.sections[2].items).toContain(
      'Fixed `fillLayerSolidColor` failing'
    );

    const v102 = getChangelogForVersion('1.0.2');
    expect(v102).toBeDefined();
    expect(v102?.version).toBe('1.0.2');
    expect(v102?.sections.map((s) => s.title)).toEqual([
      'New',
      'Improvements',
      'Bug Fixes',
    ]);
    expect(v102?.sections[0].items).toContain(
      'Added Auto-Reconnect, Roles, and Access Rights in the Collaborative Room'
    );
    expect(v102?.sections[2].items).toContain(
      'Fixed bug with hand cursor stays on while drawing'
    );

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
