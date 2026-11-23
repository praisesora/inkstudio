export const BASE_IDLE_TIMEOUT_MS = 25_000; // Default threshold before cadence samples arrive
export const MIN_ADAPTIVE_IDLE_MS = 15_000; // Fast sketching cadence -> pauses promptly (~15-18s)
export const MAX_ADAPTIVE_IDLE_MS = 60_000; // Deliberate painting cadence -> allows up to 60s between strokes
export const CADENCE_WINDOW_SIZE = 8; // Rolling window of recent inter-action intervals
/**
 * Maximum time supporting non-edit interactions (pan/zoom/color pick/shortcuts)
 * may sustain an already-active session without a fresh canvas or layer edit.
 */
export const MAX_NON_EDIT_SUSTAIN_MS = 90_000;
export const TICK_INTERVAL_MS = 1_000;
/**
 * Maximum allowable gap between two consecutive ticks before assuming OS sleep,
 * tab throttling, or process suspension. Protects against adding hours when a
 * laptop wakes from sleep.
 */
export const MAX_SLEEP_GAP_MS = 5_000;

export type WorkTimeStatus = 'recording' | 'idle' | 'inactive';

export interface DocumentWorkTimeEntry {
  documentId: string;
  accumulatedMs: number;
  sessionMs: number;
}

export interface ArtworkTimeSnapshot {
  documentId: string | null;
  accumulatedMs: number;
  sessionMs: number;
  status: WorkTimeStatus;
  effectiveIdleTimeoutMs: number;
  windowFocused: boolean;
}

export interface ArtworkTimeTrackerOptions {
  now?: () => number;
  baseIdleTimeoutMs?: number;
  minAdaptiveIdleMs?: number;
  maxAdaptiveIdleMs?: number;
  maxNonEditSustainMs?: number;
  tickIntervalMs?: number;
  maxSleepGapMs?: number;
}

/**
 * Validates and normalizes persisted artwork work-time milliseconds.
 * Returns a non-negative safe integer (0 for invalid/missing values).
 */
export function sanitizeWorkTimeMs(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  const maxReasonableMs = 100 * 365 * 24 * 60 * 60 * 1000;
  return Math.min(maxReasonableMs, Math.round(raw));
}

/**
 * Extracts `workTimeMs` from a serialized manifest or legacy payload, supporting
 * both primary (`workTimeMs`) and fallback field names if present.
 */
export function extractWorkTimeMsFromManifest(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const candidate =
    rec.workTimeMs !== undefined
      ? rec.workTimeMs
      : rec.artworkTimeMs !== undefined
        ? rec.artworkTimeMs
        : rec.elapsedTimeMs;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
    return undefined;
  }
  return sanitizeWorkTimeMs(candidate);
}

/**
 * Splits milliseconds into exact non-negative `{ hours, minutes, seconds }`.
 */
export function splitWorkTimeMs(ms: number): { hours: number; minutes: number; seconds: number } {
  const safeMs = sanitizeWorkTimeMs(ms);
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return { hours, minutes, seconds };
}

/**
 * Formats duration as fixed-width `HH:MM:SS` (e.g. `03:15:42` or `102:05:09`).
 */
export function formatWorkTimeClock(ms: number): string {
  const { hours, minutes, seconds } = splitWorkTimeMs(ms);
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Formats duration as human-readable hours & minutes (e.g. `3h 15m`, `42m`, `0m`).
 */
export function formatWorkTimeHoursMinutes(ms: number): string {
  const { hours, minutes } = splitWorkTimeMs(ms);
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m`;
}

/**
 * Builds a minimal standards-compliant Adobe XMP XML packet embedding Ink Studio's
 * tracked artwork work time for `.psd` / `.psb` round-trip persistence.
 */
export function buildInkStudioXmpMetadata(workTimeMs: number): string {
  const safeMs = sanitizeWorkTimeMs(workTimeMs);
  return (
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:inkstudio="http://inkstudio.app/ns/1.0/">` +
    `<inkstudio:WorkTimeMs>${safeMs}</inkstudio:WorkTimeMs>` +
    `</rdf:Description>` +
    `</rdf:RDF>` +
    `</x:xmpmeta>` +
    `<?xpacket end="w"?>`
  );
}

/**
 * Parses `inkstudio:WorkTimeMs` out of an XMP metadata string (from PSD/PSB).
 */
export function extractWorkTimeMsFromXmp(xmp: string | undefined | null): number | undefined {
  if (!xmp || typeof xmp !== 'string') return undefined;
  const tagMatch = /<inkstudio:WorkTimeMs>\s*(\d+(?:\.\d+)?)\s*<\/inkstudio:WorkTimeMs>/i.exec(xmp);
  if (tagMatch) {
    return sanitizeWorkTimeMs(Number(tagMatch[1]));
  }
  const attrMatch = /inkstudio:WorkTimeMs="(\d+(?:\.\d+)?)"/i.exec(xmp);
  if (attrMatch) {
    return sanitizeWorkTimeMs(Number(attrMatch[1]));
  }
  return undefined;
}

/**
 * Fast fallback scanner for `inkstudio:WorkTimeMs` directly inside a raw PSD/PSB ArrayBuffer
 * (useful when Tauri's native Rust PSD loader parses pixels and doesn't return XMP).
 */
export function extractWorkTimeMsFromPsdBuffer(buffer: ArrayBuffer | Uint8Array): number | undefined {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 64) return undefined;
  const needle = 'inkstudio:WorkTimeMs';
  const needleBytes = new Uint8Array(needle.length);
  for (let i = 0; i < needle.length; i++) {
    needleBytes[i] = needle.charCodeAt(i);
  }
  const limit = bytes.byteLength - needleBytes.length;
  for (let i = 0; i <= limit; i++) {
    if (bytes[i] !== needleBytes[0]) continue;
    let matched = true;
    for (let j = 1; j < needleBytes.length; j++) {
      if (bytes[i + j] !== needleBytes[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const start = Math.max(0, i - 4);
      const end = Math.min(bytes.byteLength, i + 96);
      const snippet = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start, end));
      const parsed = extractWorkTimeMsFromXmp(snippet);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

/**
 * Smart, fully automatic per-document artwork time tracker.
 *
 * Safety & accuracy guarantees:
 * 1. **Action-gated start**: Never counts on file open, cursor hover, or clicking UI
 *    tabs/menus. Counting begins only when the user takes a genuine artwork action
 *    (canvas draw/edit, tile mutation, or layer edit).
 * 2. **Adaptive inactivity timeout**: Observes the artist's recent stroke/edit cadence
 *    and dynamically adapts the idle timeout between 15s (brisk sketching) and 60s
 *    (deliberate painting/shading).
 * 3. **Supporting-interaction sustain cap**: Zooming, panning, color picking, and
 *    shortcuts sustain an already-active session while working, but never start an
 *    idle timer and stop extending if no genuine artwork edit occurs within 90s.
 * 4. **Instant pause on context loss**: Immediately flushes and pauses on window blur,
 *    tab hide, Home screen navigation, or document tab switch.
 * 5. **OS sleep / freeze protection**: Caps anomalous tick jumps (> 5s) so waking a
 *    sleeping laptop never inflates recorded work time.
 */
export class ArtworkTimeTracker {
  private entries = new Map<string, DocumentWorkTimeEntry>();
  private activeDocumentId: string | null = null;
  private workspaceVisible = false;
  private windowFocused = true;
  private isDrawingStroke = false;
  private status: WorkTimeStatus = 'inactive';

  private lastArtworkActionAt: number | null = null;
  private lastActivityAt: number | null = null;
  private lastTickAt: number | null = null;
  private cadenceGapsMs: number[] = [];
  private effectiveIdleTimeoutMs: number;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private readonly nowFn: () => number;
  private readonly baseIdleTimeoutMs: number;
  private readonly minAdaptiveIdleMs: number;
  private readonly maxAdaptiveIdleMs: number;
  private readonly maxNonEditSustainMs: number;
  private readonly tickIntervalMs: number;
  private readonly maxSleepGapMs: number;

  private listeners = new Set<() => void>();
  private version = 0;
  private cachedSnapshotKey = '';
  private cachedSnapshot: ArtworkTimeSnapshot | null = null;

  constructor(options: ArtworkTimeTrackerOptions = {}) {
    this.nowFn =
      options.now ??
      (() =>
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now());
    this.baseIdleTimeoutMs = Math.max(5_000, Math.round(options.baseIdleTimeoutMs ?? BASE_IDLE_TIMEOUT_MS));
    this.minAdaptiveIdleMs = Math.max(5_000, Math.round(options.minAdaptiveIdleMs ?? MIN_ADAPTIVE_IDLE_MS));
    this.maxAdaptiveIdleMs = Math.max(
      this.minAdaptiveIdleMs,
      Math.round(options.maxAdaptiveIdleMs ?? MAX_ADAPTIVE_IDLE_MS)
    );
    this.maxNonEditSustainMs = Math.max(
      this.maxAdaptiveIdleMs,
      Math.round(options.maxNonEditSustainMs ?? MAX_NON_EDIT_SUSTAIN_MS)
    );
    this.effectiveIdleTimeoutMs = this.baseIdleTimeoutMs;
    this.tickIntervalMs = Math.max(50, Math.round(options.tickIntervalMs ?? TICK_INTERVAL_MS));
    this.maxSleepGapMs = Math.max(
      this.tickIntervalMs * 2,
      Math.round(options.maxSleepGapMs ?? MAX_SLEEP_GAP_MS)
    );
  }

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  private startInterval(): void {
    if (this.tickTimer !== null) return;
    this.tickTimer = setInterval(() => {
      this.tick();
    }, this.tickIntervalMs);
  }

  private stopInterval(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private ensureEntry(docId: string): DocumentWorkTimeEntry {
    let entry = this.entries.get(docId);
    if (!entry) {
      entry = {
        documentId: docId,
        accumulatedMs: 0,
        sessionMs: 0,
      };
      this.entries.set(docId, entry);
    }
    return entry;
  }

  private computeNonRecordingStatus(): WorkTimeStatus {
    if (!this.activeDocumentId || !this.workspaceVisible) {
      return 'inactive';
    }
    return 'idle';
  }

  private resetLiveSessionCounters(): void {
    this.isDrawingStroke = false;
    this.lastArtworkActionAt = null;
    this.lastActivityAt = null;
    this.lastTickAt = null;
    this.cadenceGapsMs = [];
    this.effectiveIdleTimeoutMs = this.baseIdleTimeoutMs;
  }

  private updateAdaptiveCadence(gapMs: number): void {
    // Only learn from realistic active inter-action intervals (ignore rapid sub-300ms bursts & long AFK breaks)
    if (gapMs < 300 || gapMs > this.maxAdaptiveIdleMs) {
      return;
    }
    this.cadenceGapsMs.push(gapMs);
    if (this.cadenceGapsMs.length > CADENCE_WINDOW_SIZE) {
      this.cadenceGapsMs.shift();
    }
    if (this.cadenceGapsMs.length < 2) {
      this.effectiveIdleTimeoutMs = this.baseIdleTimeoutMs;
      return;
    }
    // Use 75th-percentile interval so occasional short pauses don't cause premature cutoffs
    const sorted = [...this.cadenceGapsMs].sort((a, b) => a - b);
    const p75Idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.75));
    const typicalGapMs = sorted[p75Idx];
    const computed = Math.round(typicalGapMs * 2.5 + 12_000);
    this.effectiveIdleTimeoutMs = Math.max(
      this.minAdaptiveIdleMs,
      Math.min(this.maxAdaptiveIdleMs, computed)
    );
  }

  private computeIdleDeadline(now: number): number {
    if (this.isDrawingStroke) return now;
    const baseActivity = this.lastActivityAt ?? this.lastTickAt ?? now;
    const activityDeadline = baseActivity + this.effectiveIdleTimeoutMs;
    if (this.lastArtworkActionAt !== null) {
      const hardSustainCap = this.lastArtworkActionAt + this.maxNonEditSustainMs;
      return Math.min(activityDeadline, hardSustainCap);
    }
    return activityDeadline;
  }

  /**
   * Advances accrued time for the active document up to `now`, enforcing the
   * adaptive inactivity deadline, non-edit sustain cap, and OS sleep guard.
   */
  private advanceActiveClock(now: number): boolean {
    if (this.status !== 'recording' || this.lastTickAt === null || !this.activeDocumentId) {
      return false;
    }

    const entry = this.entries.get(this.activeDocumentId);
    if (!entry || !this.workspaceVisible || !this.windowFocused) {
      this.lastTickAt = null;
      this.status = this.computeNonRecordingStatus();
      this.stopInterval();
      return true;
    }

    const dt = now - this.lastTickAt;
    if (!Number.isFinite(dt) || dt <= 0) {
      this.lastTickAt = now;
      return false;
    }

    const idleDeadline = this.computeIdleDeadline(now);

    // Sleep / hibernation / heavy throttling protection
    if (dt > this.maxSleepGapMs) {
      const cappedCredit = Math.min(
        this.tickIntervalMs,
        Math.max(0, idleDeadline - this.lastTickAt)
      );
      if (cappedCredit > 0) {
        entry.accumulatedMs += cappedCredit;
        entry.sessionMs += cappedCredit;
      }
      this.isDrawingStroke = false;
      this.lastTickAt = null;
      this.status = 'idle';
      this.stopInterval();
      return true;
    }

    const effectiveEnd = this.isDrawingStroke ? now : Math.min(now, idleDeadline);
    const delta = Math.max(0, effectiveEnd - this.lastTickAt);
    if (delta > 0) {
      entry.accumulatedMs += delta;
      entry.sessionMs += delta;
    }

    if (!this.isDrawingStroke && now >= idleDeadline) {
      this.lastTickAt = null;
      this.status = 'idle';
      this.stopInterval();
      return true;
    }

    this.lastTickAt = now;
    return delta > 0;
  }

  /**
   * Initializes (or restores from disk/recovery) a document's tracked time.
   * Starts idle and will NOT count until the user takes an artwork action.
   */
  public initDocument(docId: string, initialWorkTimeMs: number = 0): void {
    const safeMs = sanitizeWorkTimeMs(initialWorkTimeMs);
    this.entries.set(docId, {
      documentId: docId,
      accumulatedMs: safeMs,
      sessionMs: 0,
    });
    if (this.activeDocumentId === docId) {
      this.resetLiveSessionCounters();
      this.status = this.computeNonRecordingStatus();
      this.stopInterval();
    }
    this.emit();
  }

  /**
   * Switches active tracking context to `docId`. Flushes any prior active
   * document immediately so tab switching never leaks time between artworks.
   */
  public setActiveDocument(docId: string | null, workspaceVisible?: boolean): void {
    const nextVisible = workspaceVisible ?? this.workspaceVisible;
    const isDocChange = this.activeDocumentId !== docId;
    const isVisChange = this.workspaceVisible !== nextVisible;

    if (!isDocChange && !isVisChange) return;

    if (this.status === 'recording') {
      this.advanceActiveClock(this.nowFn());
    }

    this.activeDocumentId = docId;
    this.workspaceVisible = nextVisible;
    if (docId) {
      this.ensureEntry(docId);
    }

    if (isDocChange || !nextVisible) {
      this.resetLiveSessionCounters();
      this.status = this.computeNonRecordingStatus();
      this.stopInterval();
    }

    this.emit();
  }

  /**
   * Updates whether the workspace canvas is currently active/visible (false on
   * Home screen or during blocking save/load overlays).
   */
  public setWorkspaceVisible(visible: boolean): void {
    if (this.workspaceVisible === visible) return;
    if (!visible && this.status === 'recording') {
      this.advanceActiveClock(this.nowFn());
      this.isDrawingStroke = false;
      this.lastTickAt = null;
      this.lastActivityAt = null;
      this.stopInterval();
    }
    this.workspaceVisible = visible;
    if (!visible || this.status === 'inactive') {
      this.status = this.computeNonRecordingStatus();
    }
    this.emit();
  }

  /**
   * Updates window focus & document visibility state.
   * Losing focus/visibility immediately flushes and pauses tracking.
   * Regaining focus stays idle until the user takes a genuine artwork action.
   */
  public setWindowFocused(focused: boolean): void {
    if (this.windowFocused === focused) return;
    if (!focused) {
      if (this.status === 'recording') {
        this.advanceActiveClock(this.nowFn());
      }
      this.windowFocused = false;
      this.isDrawingStroke = false;
      this.lastTickAt = null;
      this.lastActivityAt = null;
      this.status = this.computeNonRecordingStatus();
      this.stopInterval();
      this.emit();
      return;
    }

    this.windowFocused = true;
    this.emit();
  }

  /**
   * Marks whether a continuous brush/stylus stroke is currently down on canvas.
   * While a stroke is held down, the idle timeout will not interrupt counting.
   */
  public setDrawingActive(active: boolean): void {
    if (active) {
      this.isDrawingStroke = true;
      this.recordArtworkAction();
    } else if (this.isDrawingStroke) {
      this.isDrawingStroke = false;
      this.recordArtworkAction();
    }
  }

  /**
   * Records a genuine artwork action (drawing on canvas, tile/pixel mutation,
   * layer/mask/filter edit). Starts counting from idle or extends active counting,
   * and updates the adaptive cadence model.
   */
  public recordArtworkAction(targetDocId?: string): void {
    const docId = targetDocId ?? this.activeDocumentId;
    if (!docId || docId !== this.activeDocumentId) return;
    if (!this.workspaceVisible || !this.windowFocused) return;

    this.ensureEntry(docId);

    const now = this.nowFn();
    const prevStatus = this.status;

    if (this.status === 'recording') {
      this.advanceActiveClock(now);
    }

    if (this.lastArtworkActionAt !== null) {
      this.updateAdaptiveCadence(now - this.lastArtworkActionAt);
    }

    this.lastArtworkActionAt = now;
    this.lastActivityAt = now;
    this.lastTickAt = now;
    this.status = 'recording';
    this.startInterval();

    if (prevStatus !== 'recording') {
      this.emit();
    }
  }

  /**
   * Alias for `recordArtworkAction` for callers recording direct drawing actions.
   */
  public recordActivity(targetDocId?: string): void {
    this.recordArtworkAction(targetDocId);
  }

  /**
   * Records a supporting workspace interaction (canvas zoom/pan, keyboard shortcut,
   * picking a color/brush/tool).
   *
   * Safety rule: NEVER starts counting when the tracker is idle, and only extends
   * an active session up to `maxNonEditSustainMs` since the last genuine artwork edit.
   */
  public recordSupportingActivity(targetDocId?: string): void {
    const docId = targetDocId ?? this.activeDocumentId;
    if (!docId || docId !== this.activeDocumentId) return;
    if (!this.workspaceVisible || !this.windowFocused) return;
    if (this.status !== 'recording' || this.lastArtworkActionAt === null) {
      return;
    }

    const now = this.nowFn();
    this.advanceActiveClock(now);

    // If advanceActiveClock timed out to idle or hard sustain cap passed, do not wake
    if (this.status !== 'recording') {
      return;
    }
    if (now - this.lastArtworkActionAt >= this.maxNonEditSustainMs) {
      this.lastTickAt = null;
      this.status = 'idle';
      this.stopInterval();
      this.emit();
      return;
    }

    this.lastActivityAt = now;
  }

  /**
   * Periodic heartbeat (or manual step in tests) that commits active elapsed time
   * and transitions to `idle` once inactivity exceeds the adaptive threshold.
   */
  public tick(): void {
    if (this.status !== 'recording') {
      this.stopInterval();
      return;
    }
    const changed = this.advanceActiveClock(this.nowFn());
    if (changed) {
      this.emit();
    }
  }

  /**
   * Immediately flushes any in-flight active milliseconds so reads (e.g. before
   * saving to `.ink` / `.psd` or crash-recovery checkpointing) are exact.
   */
  public flush(docId?: string | null): void {
    if (docId && docId !== this.activeDocumentId) return;
    if (this.status !== 'recording') return;
    const changed = this.advanceActiveClock(this.nowFn());
    if (changed) {
      this.emit();
    }
  }

  /**
   * Returns exact accumulated work time in milliseconds for a document.
   */
  public getWorkTimeMs(docId: string | null | undefined): number {
    if (!docId) return 0;
    if (docId === this.activeDocumentId && this.status === 'recording') {
      this.advanceActiveClock(this.nowFn());
    }
    const entry = this.entries.get(docId);
    return entry ? Math.round(entry.accumulatedMs) : 0;
  }

  public getSessionTimeMs(docId: string | null | undefined): number {
    if (!docId) return 0;
    if (docId === this.activeDocumentId && this.status === 'recording') {
      this.advanceActiveClock(this.nowFn());
    }
    const entry = this.entries.get(docId);
    return entry ? Math.round(entry.sessionMs) : 0;
  }

  public getEffectiveIdleTimeoutMs(): number {
    return this.effectiveIdleTimeoutMs;
  }

  /**
   * Removes tracking state when a document tab is closed.
   */
  public removeDocument(docId: string): void {
    if (this.activeDocumentId === docId) {
      this.activeDocumentId = null;
      this.resetLiveSessionCounters();
      this.status = 'inactive';
      this.stopInterval();
    }
    this.entries.delete(docId);
    this.emit();
  }

  /**
   * Resets all tracker state (intended for tests and clean teardown).
   */
  public resetAll(): void {
    this.stopInterval();
    this.entries.clear();
    this.activeDocumentId = null;
    this.workspaceVisible = false;
    this.windowFocused = true;
    this.resetLiveSessionCounters();
    this.status = 'inactive';
    this.emit();
  }

  /**
   * Returns a referentially-stable snapshot for React's `useSyncExternalStore`.
   */
  public getSnapshot(docId?: string | null): ArtworkTimeSnapshot {
    const targetId = docId !== undefined ? docId : this.activeDocumentId;
    const key = `${this.version}:${targetId ?? ''}`;
    if (this.cachedSnapshot && this.cachedSnapshotKey === key) {
      return this.cachedSnapshot;
    }

    const entry = targetId ? this.entries.get(targetId) : undefined;
    const isActiveTarget = Boolean(targetId && targetId === this.activeDocumentId);
    const status: WorkTimeStatus = !targetId
      ? 'inactive'
      : isActiveTarget
        ? this.status
        : 'idle';

    const snap: ArtworkTimeSnapshot = {
      documentId: targetId ?? null,
      accumulatedMs: entry ? Math.round(entry.accumulatedMs) : 0,
      sessionMs: entry ? Math.round(entry.sessionMs) : 0,
      status,
      effectiveIdleTimeoutMs: this.effectiveIdleTimeoutMs,
      windowFocused: this.windowFocused,
    };

    this.cachedSnapshotKey = key;
    this.cachedSnapshot = snap;
    return snap;
  }

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export const artworkTimeTracker = new ArtworkTimeTracker();
