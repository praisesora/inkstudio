import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { zipSync } from 'fflate';
import {
  ArtworkTimeTracker,
  buildInkStudioXmpMetadata,
  extractWorkTimeMsFromPsdBuffer,
  extractWorkTimeMsFromXmp,
  formatWorkTimeClock,
  formatWorkTimeHoursMinutes,
  sanitizeWorkTimeMs,
} from '../artworkTimeTracker';
import { parseInkProject, serializeDocument, serializeInkProject } from '../saveManager';
import { openFile } from '../imageLoader';
import { migrateLegacySoraBytes } from '../legacySoraMigrator';
import { parsePsdFile } from '../psdParser';
import { SparseTileGrid } from '../tileEngine';
import { LayerItem } from '../../types/editor';
import {
  WORKSPACE_STORAGE_KEY,
  findPanelLocation,
  loadWorkspaceState,
} from '../workspacePresets';
import { useWorkspaceStore, workspaceStoreActions } from '../../stores/useWorkspaceStore';
import { useDocumentStore, documentStoreActions } from '../../stores/useDocumentStore';
import { useToolStore } from '../../stores/useToolStore';
import { InfoPanel } from '../../components/InfoPanel';

const THREE_HOURS_FIFTEEN_MIN_MS = (3 * 60 + 15) * 60 * 1000; // 11,700,000 ms

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

class MiniText {
  nodeType = 3;
  nodeName = '#text';
  parentNode: MiniEl | null = null;
  constructor(public nodeValue: string, public ownerDocument: MiniDoc) {}
}

class MiniComment {
  nodeType = 8;
  nodeName = '#comment';
  parentNode: MiniEl | null = null;
  constructor(public nodeValue: string, public ownerDocument: MiniDoc) {}
}

class MiniEl extends EventTarget {
  nodeType = 1;
  nodeName: string;
  tagName: string;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  parentNode: MiniEl | null = null;
  childNodes: Array<MiniEl | MiniText | MiniComment> = [];
  style: Record<string, string> = {};
  className = '';
  disabled = false;
  value = '';
  attrs = new Map<string, string>();

  constructor(tag: string, public ownerDocument: MiniDoc) {
    super();
    this.nodeName = tag.toUpperCase();
    this.tagName = tag.toUpperCase();
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get textContent(): string {
    return this.childNodes
      .map((c) => (c instanceof MiniText ? c.nodeValue : c instanceof MiniEl ? c.textContent : ''))
      .join('');
  }

  set textContent(val: string) {
    this.childNodes = val ? [new MiniText(val, this.ownerDocument)] : [];
  }

  appendChild<T extends MiniEl | MiniText | MiniComment>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild<T extends MiniEl | MiniText | MiniComment>(child: T): T {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  insertBefore<T extends MiniEl | MiniText | MiniComment>(
    node: T,
    ref: MiniEl | MiniText | MiniComment | null
  ): T {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    if (idx >= 0) this.childNodes.splice(idx, 0, node);
    else this.childNodes.push(node);
    return node;
  }

  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }

  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }

  removeAttribute(k: string) {
    this.attrs.delete(k);
  }

  findByAttr(attr: string, value: string): MiniEl | null {
    if (this.getAttribute(attr) === value) return this;
    for (const c of this.childNodes) {
      if (c instanceof MiniEl) {
        const found = c.findByAttr(attr, value);
        if (found) return found;
      }
    }
    return null;
  }

  findByTag(tag: string): MiniEl | null {
    if (this.tagName === tag.toUpperCase()) return this;
    for (const c of this.childNodes) {
      if (c instanceof MiniEl) {
        const found = c.findByTag(tag);
        if (found) return found;
      }
    }
    return null;
  }
}

interface MiniDoc {
  nodeType: number;
  nodeName: string;
  documentElement: MiniEl;
  body: MiniEl;
  activeElement: MiniEl;
  defaultView: Record<string, unknown>;
  createElement: (tag: string) => MiniEl;
  createElementNS: (_ns: string, tag: string) => MiniEl;
  createTextNode: (text: string) => MiniText;
  createComment: (text: string) => MiniComment;
  addEventListener: EventTarget['addEventListener'];
  removeEventListener: EventTarget['removeEventListener'];
  dispatchEvent: EventTarget['dispatchEvent'];
}

function installMiniDom() {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {
    window: g.window,
    document: g.document,
    HTMLElement: g.HTMLElement,
    Node: g.Node,
    Element: g.Element,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const winTarget = new EventTarget();
  const docTarget = new EventTarget();
  const rafQueue: FrameRequestCallback[] = [];

  const mockDoc = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: null as unknown as MiniEl,
    body: null as unknown as MiniEl,
    activeElement: null as unknown as MiniEl,
    defaultView: null as unknown as Record<string, unknown>,
    createElement: (tag: string) => new MiniEl(tag, mockDoc),
    createElementNS: (_ns: string, tag: string) => new MiniEl(tag, mockDoc),
    createTextNode: (text: string) => new MiniText(text, mockDoc),
    createComment: (text: string) => new MiniComment(text, mockDoc),
    addEventListener: docTarget.addEventListener.bind(docTarget),
    removeEventListener: docTarget.removeEventListener.bind(docTarget),
    dispatchEvent: docTarget.dispatchEvent.bind(docTarget),
  } as MiniDoc;

  mockDoc.documentElement = new MiniEl('html', mockDoc);
  mockDoc.body = new MiniEl('body', mockDoc);
  mockDoc.documentElement.appendChild(mockDoc.body);
  mockDoc.activeElement = mockDoc.body;

  class MockIFrame extends MiniEl {}

  const rafMock = (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  const cancelRafMock = () => {};

  const mockWin: Record<string, unknown> = {
    innerWidth: 1440,
    innerHeight: 900,
    document: mockDoc,
    Node: MiniEl,
    Element: MiniEl,
    HTMLElement: MiniEl,
    SVGElement: MiniEl,
    HTMLIFrameElement: MockIFrame,
    Event,
    CustomEvent,
    addEventListener: winTarget.addEventListener.bind(winTarget),
    removeEventListener: winTarget.removeEventListener.bind(winTarget),
    dispatchEvent: winTarget.dispatchEvent.bind(winTarget),
    requestAnimationFrame: rafMock,
    cancelAnimationFrame: cancelRafMock,
  };
  mockDoc.defaultView = mockWin;

  g.window = mockWin;
  g.document = mockDoc;
  g.HTMLElement = MiniEl;
  g.Node = MiniEl;
  g.Element = MiniEl;
  g.requestAnimationFrame = rafMock;
  g.cancelAnimationFrame = cancelRafMock;

  const container = new MiniEl('div', mockDoc);
  mockDoc.body.appendChild(container);

  return {
    container,
    flushRaf: () => {
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const cb of batch) cb(16);
    },
    cleanup: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
    },
  };
}

describe('ArtworkTimeTracker Smart Adaptive Safety & Accuracy Engine', () => {
  it('formats hours, minutes, seconds, and sanitizes invalid values accurately', () => {
    expect(formatWorkTimeClock(0)).toBe('00:00:00');
    expect(formatWorkTimeClock(THREE_HOURS_FIFTEEN_MIN_MS)).toBe('03:15:00');
    expect(formatWorkTimeClock(THREE_HOURS_FIFTEEN_MIN_MS + 42_000)).toBe('03:15:42');
    expect(formatWorkTimeClock((105 * 3600 + 2 * 60 + 9) * 1000)).toBe('105:02:09');

    expect(formatWorkTimeHoursMinutes(0)).toBe('0m');
    expect(formatWorkTimeHoursMinutes(45 * 60 * 1000)).toBe('45m');
    expect(formatWorkTimeHoursMinutes(THREE_HOURS_FIFTEEN_MIN_MS)).toBe('3h 15m');

    expect(sanitizeWorkTimeMs(-500)).toBe(0);
    expect(sanitizeWorkTimeMs(Number.NaN)).toBe(0);
    expect(sanitizeWorkTimeMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(sanitizeWorkTimeMs('1234')).toBe(0);
    expect(sanitizeWorkTimeMs(1234.6)).toBe(1235);
  });

  it('never starts counting on file open or non-artwork supporting interactions until a genuine artwork action occurs', () => {
    let clock = 10_000;
    const tracker = new ArtworkTimeTracker({
      now: () => clock,
      baseIdleTimeoutMs: 25_000,
    });

    tracker.initDocument('doc-a', THREE_HOURS_FIFTEEN_MIN_MS);
    tracker.setActiveDocument('doc-a', true);

    // Clicking UI panels, zooming, or sitting idle must NOT wake the timer
    for (let s = 0; s < 30; s++) {
      clock += 1_000;
      tracker.recordSupportingActivity();
      tracker.tick();
    }
    expect(tracker.getWorkTimeMs('doc-a')).toBe(THREE_HOURS_FIFTEEN_MIN_MS);
    expect(tracker.getSnapshot('doc-a').status).toBe('idle');

    // Once user draws or edits artwork, counting starts cleanly
    tracker.recordArtworkAction();
    expect(tracker.getSnapshot('doc-a').status).toBe('recording');
    clock += 1_000;
    tracker.tick();
    expect(tracker.getWorkTimeMs('doc-a')).toBe(THREE_HOURS_FIFTEEN_MIN_MS + 1_000);

    tracker.resetAll();
  });

  it('adapts inactivity timeout to fast sketching vs deliberate painting and enforces the non-edit sustain cap', () => {
    // 1. Brisk sketching cadence (strokes every 2s -> adapts down to ~17s idle threshold)
    let fastClock = 1_000;
    const fastTracker = new ArtworkTimeTracker({
      now: () => fastClock,
      baseIdleTimeoutMs: 25_000,
      minAdaptiveIdleMs: 15_000,
      maxAdaptiveIdleMs: 60_000,
      maxNonEditSustainMs: 90_000,
    });
    fastTracker.initDocument('sketch', 0);
    fastTracker.setActiveDocument('sketch', true);

    fastTracker.recordArtworkAction();
    for (let i = 0; i < 6; i++) {
      fastClock += 1_000;
      fastTracker.tick();
      fastClock += 1_000;
      fastTracker.tick();
      fastTracker.recordArtworkAction();
    }
    // 2s * 2.5 + 12s = 17s adaptive timeout
    expect(fastTracker.getEffectiveIdleTimeoutMs()).toBe(17_000);

    // User stops sketching -> pauses automatically after 17s (not 60s)
    for (let s = 0; s < 60; s++) {
      fastClock += 1_000;
      fastTracker.tick();
    }
    expect(fastTracker.getSnapshot('sketch').status).toBe('idle');
    expect(fastTracker.getWorkTimeMs('sketch')).toBe(12_000 + 17_000);
    fastTracker.resetAll();

    // 2. Deliberate painting cadence (strokes every 15s -> adapts up to ~49.5s)
    let slowClock = 1_000;
    const slowTracker = new ArtworkTimeTracker({
      now: () => slowClock,
      baseIdleTimeoutMs: 25_000,
      minAdaptiveIdleMs: 15_000,
      maxAdaptiveIdleMs: 60_000,
      maxNonEditSustainMs: 90_000,
    });
    slowTracker.initDocument('painting', 0);
    slowTracker.setActiveDocument('painting', true);

    slowTracker.recordArtworkAction();
    for (let stroke = 0; stroke < 3; stroke++) {
      for (let s = 0; s < 15; s++) {
        slowClock += 1_000;
        slowTracker.tick();
      }
      slowTracker.recordArtworkAction();
    }
    // 15s * 2.5 + 12s = 49.5s adaptive timeout
    expect(slowTracker.getEffectiveIdleTimeoutMs()).toBe(49_500);

    // 3. Supporting interactions (e.g. panning/zooming) sustain active painting,
    //    but hard-stop once maxNonEditSustainMs (90s) elapses without a real artwork edit
    const timeAtLastEdit = slowTracker.getWorkTimeMs('painting');
    for (let s = 1; s <= 150; s++) {
      slowClock += 1_000;
      slowTracker.tick();
      if (s % 10 === 0) {
        slowTracker.recordSupportingActivity();
      }
    }
    expect(slowTracker.getSnapshot('painting').status).toBe('idle');
    expect(slowTracker.getWorkTimeMs('painting')).toBe(timeAtLastEdit + 90_000);
    slowTracker.resetAll();
  });

  it('pauses immediately on window blur / tab hide and protects against OS sleep jumps', () => {
    let clock = 5_000;
    const tracker = new ArtworkTimeTracker({
      now: () => clock,
      baseIdleTimeoutMs: 25_000,
      tickIntervalMs: 1_000,
      maxSleepGapMs: 5_000,
    });

    tracker.initDocument('doc-a', 10_000);
    tracker.setActiveDocument('doc-a', true);
    tracker.recordArtworkAction();

    clock += 3_000;
    tracker.tick();
    expect(tracker.getWorkTimeMs('doc-a')).toBe(13_000);

    // User alt-tabs away (window blur) for 2 hours
    tracker.setWindowFocused(false);
    expect(tracker.getSnapshot('doc-a').status).toBe('idle');
    clock += 2 * 60 * 60 * 1000;
    tracker.tick();
    expect(tracker.getWorkTimeMs('doc-a')).toBe(13_000);

    // User alt-tabs back without drawing -> stays idle at 13s
    tracker.setWindowFocused(true);
    clock += 10_000;
    tracker.tick();
    expect(tracker.getWorkTimeMs('doc-a')).toBe(13_000);

    // User resumes drawing, then laptop sleeps for 8 hours
    tracker.recordArtworkAction();
    clock += 8 * 60 * 60 * 1000;
    tracker.tick();

    expect(tracker.getWorkTimeMs('doc-a')).toBeLessThanOrEqual(14_000);
    expect(tracker.getSnapshot('doc-a').status).toBe('idle');

    tracker.resetAll();
  });

  it('keeps counting during long continuous strokes and isolates time across multiple open tabs', () => {
    let clock = 1_000;
    const tracker = new ArtworkTimeTracker({
      now: () => clock,
      baseIdleTimeoutMs: 15_000,
      tickIntervalMs: 1_000,
    });

    tracker.initDocument('doc-1', 60_000);
    tracker.initDocument('doc-2', 120_000);
    tracker.setActiveDocument('doc-1', true);

    // Hold a continuous stroke down for 25s (> 15s idle timeout)
    tracker.setDrawingActive(true);
    for (let s = 0; s < 25; s++) {
      clock += 1_000;
      tracker.tick();
    }
    tracker.setDrawingActive(false);
    expect(tracker.getWorkTimeMs('doc-1')).toBe(85_000);
    expect(tracker.getWorkTimeMs('doc-2')).toBe(120_000);

    // Switch to Doc 2 and work for 10s
    tracker.setActiveDocument('doc-2', true);
    tracker.recordArtworkAction();
    for (let s = 0; s < 10; s++) {
      clock += 1_000;
      tracker.tick();
    }
    expect(tracker.getWorkTimeMs('doc-1')).toBe(85_000);
    expect(tracker.getWorkTimeMs('doc-2')).toBe(130_000);

    tracker.resetAll();
  });
});

describe('Work Time Persistence Across .ink, Legacy .sora, and .psd Formats', () => {
  it('saves 3h 15m in .ink format, reopens a day later at 3h 15m, and continues counting on new drawing', async () => {
    const grid = new SparseTileGrid();
    grid.fillLayerSolidWhite('layer-1', 256, 256, 'color-32bit');
    const layers: LayerItem[] = [
      {
        id: 'layer-1',
        name: 'Artwork',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
      },
    ];

    const serialized = await serializeInkProject(
      {
        name: 'Illustration',
        dimensions: { width: 256, height: 256, dpi: 300 },
        colorMode: 'color',
        layers,
        tileGrid: grid,
        getEffectiveOpacity: (l) => l.opacity,
        isLayerEffectivelyVisible: (l) => l.visible,
        workTimeMs: THREE_HOURS_FIFTEEN_MIN_MS,
      },
      grid
    );

    expect(serialized.manifest.workTimeMs).toBe(THREE_HOURS_FIFTEEN_MIN_MS);

    const parsed = await parseInkProject(serialized.bytes);
    expect(parsed.workTimeMs).toBe(THREE_HOURS_FIFTEEN_MIN_MS);

    const reopenedFile = new File([serialized.bytes as BlobPart], 'Illustration.ink', {
      type: 'application/octet-stream',
    });
    const loadedDoc = await openFile(reopenedFile);
    expect(loadedDoc.workTimeMs).toBe(THREE_HOURS_FIFTEEN_MIN_MS);

    let day2Clock = 1_000_000;
    const day2Tracker = new ArtworkTimeTracker({
      now: () => day2Clock,
      baseIdleTimeoutMs: 25_000,
    });
    day2Tracker.initDocument('reopened-doc', loadedDoc.workTimeMs ?? 0);
    day2Tracker.setActiveDocument('reopened-doc', true);

    expect(formatWorkTimeClock(day2Tracker.getWorkTimeMs('reopened-doc'))).toBe('03:15:00');
    expect(formatWorkTimeHoursMinutes(day2Tracker.getWorkTimeMs('reopened-doc'))).toBe('3h 15m');

    day2Tracker.recordArtworkAction();
    for (let s = 0; s < 150; s++) {
      day2Clock += 1_000;
      day2Tracker.tick();
      if (s % 10 === 0) day2Tracker.recordArtworkAction();
    }
    expect(formatWorkTimeClock(day2Tracker.getWorkTimeMs('reopened-doc'))).toBe('03:17:30');
    expect(formatWorkTimeHoursMinutes(day2Tracker.getWorkTimeMs('reopened-doc'))).toBe('3h 17m');
    expect(formatWorkTimeClock(day2Tracker.getSessionTimeMs('reopened-doc'))).toBe('00:02:30');

    day2Tracker.resetAll();
  });

  it('preserves workTimeMs when migrating legacy .sora v1 JSON and .sora v2 ZIP files', async () => {
    const v1Json = JSON.stringify({
      app: 'Sora Paint',
      version: '1.2',
      name: 'Legacy V1 Art',
      dimensions: { width: 512, height: 512, dpi: 300 },
      colorMode: 'color',
      workTimeMs: THREE_HOURS_FIFTEEN_MIN_MS,
      layers: [],
      canvases: {},
      masks: {},
    });
    const v1 = await migrateLegacySoraBytes(v1Json);
    expect(v1.workTimeMs).toBe(THREE_HOURS_FIFTEEN_MIN_MS);

    const v2Zip = zipSync({
      'manifest.json': new TextEncoder().encode(
        JSON.stringify({
          format: 'sora-v2',
          app: 'Ink Studio',
          version: '2.0',
          tileSize: 256,
          name: 'Legacy V2 Art',
          dimensions: { width: 512, height: 512, dpi: 300 },
          colorMode: 'color',
          layers: [],
          layerFormats: {},
          layerTileKeys: {},
          masksMeta: {},
          workTimeMs: THREE_HOURS_FIFTEEN_MIN_MS + 60_000,
          preview: null,
          savedAt: Date.now(),
        })
      ),
    });
    const soraFile = new File([v2Zip as BlobPart], 'legacy.sora', {
      type: 'application/octet-stream',
    });
    const loadedSora = await openFile(soraFile);
    expect(loadedSora.workTimeMs).toBe(THREE_HOURS_FIFTEEN_MIN_MS + 60_000);
  });

  it('embeds and restores workTimeMs in .psd files via XMP metadata', async () => {
    const xmp = buildInkStudioXmpMetadata(THREE_HOURS_FIFTEEN_MIN_MS);
    expect(extractWorkTimeMsFromXmp(xmp)).toBe(THREE_HOURS_FIFTEEN_MIN_MS);

    const grid = new SparseTileGrid();
    grid.fillLayerSolidWhite('l1', 64, 64, 'color-32bit');
    const layers: LayerItem[] = [
      {
        id: 'l1',
        name: 'Layer 1',
        type: 'raster',
        visible: true,
        opacity: 1,
        blendMode: 'normal',
        locked: false,
        parentId: null,
      },
    ];

    const serialized = await serializeDocument(
      {
        name: 'PsdArtwork',
        dimensions: { width: 64, height: 64, dpi: 300 },
        colorMode: 'color',
        layers,
        tileGrid: grid,
        getEffectiveOpacity: (l) => l.opacity,
        isLayerEffectivelyVisible: (l) => l.visible,
        workTimeMs: THREE_HOURS_FIFTEEN_MIN_MS,
      },
      '.psd'
    );

    const buf =
      serialized.data instanceof Blob
        ? await serialized.data.arrayBuffer()
        : serialized.data;

    expect(extractWorkTimeMsFromPsdBuffer(buf)).toBe(THREE_HOURS_FIFTEEN_MIN_MS);

    const parsedPsd = await parsePsdFile(buf, 'PsdArtwork.psd');
    expect(parsedPsd.workTimeMs).toBe(THREE_HOURS_FIFTEEN_MIN_MS);
  });
});

describe('InfoPanel Clean Text-Only UI & Workspace Info Tab Migration', () => {
  const prevStorage = (globalThis as unknown as Record<string, unknown>).localStorage;
  let dom: ReturnType<typeof installMiniDom>;
  let root: Root | null = null;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
    dom = installMiniDom();
    useWorkspaceStore.reset();
    useDocumentStore.reset();
    useToolStore.reset();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    dom.cleanup();
    if (prevStorage === undefined) {
      delete (globalThis as unknown as Record<string, unknown>).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: prevStorage,
        configurable: true,
        writable: true,
      });
    }
  });

  it('includes the Info tab in default presets and migrates legacy saved workspaces once without re-opening if closed', () => {
    const infoLoc = findPanelLocation(useWorkspaceStore.getState().layout, 'info');
    const navLoc = findPanelLocation(useWorkspaceStore.getState().layout, 'navigator');
    expect(infoLoc).not.toBeNull();
    expect(infoLoc?.groupId).toBe(navLoc?.groupId);

    localStorage.setItem(
      WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activePreset: 'custom',
        layout: {
          leftDocks: [],
          rightDocks: [
            {
              id: 'col-right-main',
              width: 224,
              collapsed: false,
              groups: [
                {
                  id: 'grp-navigator-subview',
                  panelIds: ['navigator', 'sub-view'],
                  activePanelId: 'navigator',
                  heightRatio: 1,
                },
              ],
            },
          ],
        },
        savedCustomLayout: null,
        quickAccessItems: [],
        quickAccessViewMode: 'grid',
        commandBarIds: [],
        showStatusBar: true,
        showDocumentTabs: true,
        showCommandBar: true,
      })
    );

    const migrated = loadWorkspaceState();
    expect(findPanelLocation(migrated.layout, 'info')?.groupId).toBe('grp-navigator-subview');

    useWorkspaceStore.reset();
    workspaceStoreActions.togglePanelVisibility('info');
    expect(findPanelLocation(useWorkspaceStore.getState().layout, 'info')).toBeNull();

    useWorkspaceStore.reset();
    expect(findPanelLocation(useWorkspaceStore.getState().layout, 'info')).toBeNull();
  });

  it('renders a simple text-only automatic time counter without manual pause/reset/dropdown controls', () => {
    let clock = 500;
    const tracker = new ArtworkTimeTracker({
      now: () => clock,
      baseIdleTimeoutMs: 25_000,
    });

    documentStoreActions.setActiveDocumentId('doc-ui');
    documentStoreActions.setDimensions({ width: 1920, height: 1080, dpi: 300 });
    tracker.initDocument('doc-ui', THREE_HOURS_FIFTEEN_MIN_MS);
    tracker.setActiveDocument('doc-ui', true);

    act(() => {
      root = createRoot(dom.container as unknown as Element);
      root.render(<InfoPanel tracker={tracker} colorMode="color" layers={[]} />);
    });

    const section = dom.container.findByAttr('data-testid', 'info-work-time-section');
    const clockEl = dom.container.findByAttr('data-testid', 'info-work-time-clock');
    const hmEl = dom.container.findByAttr('data-testid', 'info-work-time-hm');

    expect(clockEl?.textContent).toBe('03:15:00');
    expect(hmEl?.textContent).toBe('3h 15m');
    expect(section?.getAttribute('data-status')).toBe('idle');

    // Pure text-only: no pause, reset, or timeout selector buttons/selects
    expect(section?.findByTag('button')).toBeNull();
    expect(section?.findByTag('select')).toBeNull();

    // Supporting interaction alone does not start counting
    act(() => {
      tracker.recordSupportingActivity();
      clock += 5_000;
      tracker.tick();
    });
    expect(dom.container.findByAttr('data-testid', 'info-work-time-clock')?.textContent).toBe('03:15:00');

    // Genuine artwork action starts counting
    act(() => {
      tracker.recordArtworkAction();
      clock += 5_000;
      tracker.tick();
    });
    expect(dom.container.findByAttr('data-testid', 'info-work-time-clock')?.textContent).toBe('03:15:05');
    expect(dom.container.findByAttr('data-testid', 'info-work-time-section')?.getAttribute('data-status')).toBe('recording');

    // Live cursor stats update without re-render
    act(() => {
      window.dispatchEvent(
        new CustomEvent('canvas-pointer-stat', { detail: { x: 640, y: 360, pressure: 0.5 } })
      );
      dom.flushRaf();
    });
    expect(dom.container.findByAttr('data-testid', 'info-cursor-x')?.textContent).toBe('640');
    expect(dom.container.findByAttr('data-testid', 'info-cursor-y')?.textContent).toBe('360');

    act(() => {
      root?.unmount();
    });
    root = null;
    tracker.resetAll();
  });
});
