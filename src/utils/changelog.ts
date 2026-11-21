import changelogRaw from '../../CHANGELOG.md?raw';

export interface ChangelogSection {
  title: string;
  items: string[];
}

export interface ChangelogEntry {
  version: string;
  sections: ChangelogSection[];
  rawBody: string;
}

const VERSION_HEADING_RE = /^##\s+\[?v?([0-9]+\.[0-9]+\.[0-9]+(?:-[^\s\]]+)?)\]?(?:\s+.*)?$/i;
const SECTION_HEADING_RE = /^###\s+(.+)$/;
const BULLET_PREFIX_RE = /^[-*]\s+/;

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

/**
 * Parse a single release body (without a `## vX.Y.Z` heading) into categorized sections.
 * Useful for rendering updater `latest.json` notes with the same layout as CHANGELOG.md.
 */
export function parseChangelogSections(markdownBody: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  const lines = markdownBody.replace(/\r\n/g, '\n').split('\n');
  let currentSection: ChangelogSection | null = null;

  const flushSection = () => {
    if (currentSection && currentSection.items.length > 0) {
      sections.push(currentSection);
    }
    currentSection = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Ignore top-level version heading if a caller accidentally passes one
    if (VERSION_HEADING_RE.test(trimmed)) {
      continue;
    }

    const sectionMatch = SECTION_HEADING_RE.exec(trimmed);
    if (sectionMatch) {
      flushSection();
      currentSection = {
        title: sectionMatch[1].trim(),
        items: [],
      };
      continue;
    }

    if (!currentSection) {
      currentSection = { title: '', items: [] };
    }

    currentSection.items.push(trimmed.replace(BULLET_PREFIX_RE, '').trim());
  }

  flushSection();
  return sections;
}

/**
 * Check whether a release body contains structured Markdown sections (`### Heading`)
 * or bullet list items (`- ...` / `* ...`).
 */
export function hasStructuredChangelogMarkdown(markdownBody: string): boolean {
  const lines = markdownBody.replace(/\r\n/g, '\n').split('\n');
  return lines.some((line) => {
    const trimmed = line.trim();
    return SECTION_HEADING_RE.test(trimmed) || BULLET_PREFIX_RE.test(trimmed);
  });
}

/**
 * Parse a Markdown changelog document grouped by `## vX.Y.Z` version headings
 * and `### Category` subheadings.
 */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  let currentEntry: ChangelogEntry | null = null;
  let currentSection: ChangelogSection | null = null;
  let rawLines: string[] = [];

  const flushSection = () => {
    if (currentEntry && currentSection && currentSection.items.length > 0) {
      currentEntry.sections.push(currentSection);
    }
    currentSection = null;
  };

  const flushEntry = () => {
    flushSection();
    if (currentEntry) {
      currentEntry.rawBody = rawLines.join('\n').trim();
      entries.push(currentEntry);
    }
    currentEntry = null;
    rawLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const versionMatch = VERSION_HEADING_RE.exec(trimmed);
    if (versionMatch) {
      flushEntry();
      currentEntry = {
        version: versionMatch[1],
        sections: [],
        rawBody: '',
      };
      continue;
    }

    if (!currentEntry) {
      continue;
    }

    rawLines.push(line);

    const sectionMatch = SECTION_HEADING_RE.exec(trimmed);
    if (sectionMatch) {
      flushSection();
      currentSection = {
        title: sectionMatch[1].trim(),
        items: [],
      };
      continue;
    }

    if (!trimmed) {
      continue;
    }

    if (!currentSection) {
      currentSection = { title: 'Changes', items: [] };
    }

    currentSection.items.push(trimmed.replace(BULLET_PREFIX_RE, '').trim());
  }

  flushEntry();
  return entries;
}

let cachedEntries: ChangelogEntry[] | null = null;

/** Return all parsed changelog entries from the root CHANGELOG.md file. */
export function getChangelogEntries(): ChangelogEntry[] {
  if (!cachedEntries) {
    cachedEntries = parseChangelog(changelogRaw);
  }
  return cachedEntries;
}

/** Find changelog entry matching the given semver string, or the latest entry if omitted. */
export function getChangelogForVersion(version?: string): ChangelogEntry | undefined {
  const entries = getChangelogEntries();
  if (!version) {
    return entries[0];
  }
  const target = normalizeVersion(version);
  return entries.find((entry) => normalizeVersion(entry.version) === target);
}
