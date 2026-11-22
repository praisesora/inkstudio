import React, { Profiler, act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  useCanvasNavigation,
  MIN_ZOOM,
  MAX_ZOOM,
  NAV_STATE_COMMIT_DEBOUNCE_MS,
  CAMERA_CHANGE_EVENT,
  CameraTransformState,
  CanvasNavigationHandle,
} from '../../hooks/useCanvasNavigation';
import {
  screenToCanvas,
  clientToDocument,
  canvasToScreen,
  getCanvasToViewportMatrix,
  getVisibleCanvasBounds,
} from '../canvasUtils';
import { SparseTileGrid } from '../tileEngine';
import { StrokePipeline } from '../../engine/StrokePipeline';

/**
 * Lightweight DOM shim for running React 19 createRoot + Profiler + DOM events in Vitest Node environment.
 */
class MiniElement extends EventTarget {
  public nodeType = 1;
  public nodeName: string;
  public tagName: string;
  public namespaceURI = 'http://www.w3.org/1999/xhtml';
  public ownerDocument: any;
  public parentNode: any = null;
  public childNodes: any[] = [];
  public style: Record<string, string> = {};
  public isContentEditable = false;
  public clientWidth = 1200;
  public clientHeight = 900;
  private attrs = new Map<string, string>();
  private rect = {
    left: 100,
    top: 50,
    width: 1200,
    height: 900,
    right: 1300,
    bottom: 950,
    x: 100,
    y: 50,
    toJSON: () => ({}),
  };

  constructor(tag: string, ownerDocument: any) {
    super();
    this.nodeName = tag.toUpperCase();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  appendChild(child: any) {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: any) {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  insertBefore(newNode: any, refNode: any) {
    if (newNode.parentNode) {
      newNode.parentNode.removeChild(newNode);
    }
    newNode.parentNode = this;
    const idx = refNode ? this.childNodes.indexOf(refNode) : -1;
    if (idx >= 0) {
      this.childNodes.splice(idx, 0, newNode);
    } else {
      this.childNodes.push(newNode);
    }
    return newNode;
  }

  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
  }

  removeAttribute(k: string) {
    this.attrs.delete(k);
  }

  getBoundingClientRect(): DOMRect {
    return {
      ...this.rect,
      width: this.clientWidth,
      height: this.clientHeight,
      right: this.rect.left + this.clientWidth,
      bottom: this.rect.top + this.clientHeight,
    } as DOMRect;
  }
}

class MiniTextNode {
  public nodeType = 3;
  public nodeName = '#text';
  public nodeValue: string;
  public ownerDocument: any;
  public parentNode: any = null;

  constructor(text: string, ownerDocument: any) {
    this.nodeValue = text;
    this.ownerDocument = ownerDocument;
  }
}

class MiniCommentNode {
  public nodeType = 8;
  public nodeName = '#comment';
  public nodeValue: string;
  public ownerDocument: any;
  public parentNode: any = null;

  constructor(text: string, ownerDocument: any) {
    this.nodeValue = text;
    this.ownerDocument = ownerDocument;
  }
}

interface RafQueueController {
  flushNextFrame: () => void;
  flushAllFrames: () => void;
  pendingCount: () => number;
}

function installMiniDomEnvironment(): {
  container: MiniElement;
  raf: RafQueueController;
  cleanup: () => void;
} {
  const prevGlobals: Record<string, any> = {
    window: (globalThis as any).window,
    document: (globalThis as any).document,
    navigator: (globalThis as any).navigator,
    HTMLElement: (globalThis as any).HTMLElement,
    ResizeObserver: (globalThis as any).ResizeObserver,
    requestAnimationFrame: (globalThis as any).requestAnimationFrame,
    cancelAnimationFrame: (globalThis as any).cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as any).IS_REACT_ACT_ENVIRONMENT,
  };

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

  const winTarget = new EventTarget();
  const docTarget = new EventTarget();

  const mockDoc: any = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: null as any,
    body: null as any,
    activeElement: null as any,
    defaultView: null as any,
    createElement: (tag: string) => new MiniElement(tag, mockDoc),
    createElementNS: (_ns: string, tag: string) => new MiniElement(tag, mockDoc),
    createTextNode: (text: string) => new MiniTextNode(text, mockDoc),
    createComment: (text: string) => new MiniCommentNode(text, mockDoc),
    querySelector: () => null,
    addEventListener: docTarget.addEventListener.bind(docTarget),
    removeEventListener: docTarget.removeEventListener.bind(docTarget),
    dispatchEvent: docTarget.dispatchEvent.bind(docTarget),
  };

  mockDoc.documentElement = new MiniElement('html', mockDoc);
  mockDoc.body = new MiniElement('body', mockDoc);
  mockDoc.documentElement.appendChild(mockDoc.body);
  mockDoc.activeElement = mockDoc.body;

  class MockHTMLIFrameElement extends MiniElement {}

  let nextRafId = 1;
  const rafCallbacks = new Map<number, FrameRequestCallback>();
  let frameTimestamp = 16;

  const requestAnimationFrameMock = (cb: FrameRequestCallback): number => {
    const id = nextRafId++;
    rafCallbacks.set(id, cb);
    return id;
  };

  const cancelAnimationFrameMock = (id: number): void => {
    rafCallbacks.delete(id);
  };

  const mockWin: any = {
    innerWidth: 1600,
    innerHeight: 1000,
    devicePixelRatio: 1,
    document: mockDoc,
    Node: MiniElement,
    Element: MiniElement,
    HTMLElement: MiniElement,
    SVGElement: MiniElement,
    HTMLIFrameElement: MockHTMLIFrameElement,
    Event,
    CustomEvent,
    addEventListener: winTarget.addEventListener.bind(winTarget),
    removeEventListener: winTarget.removeEventListener.bind(winTarget),
    dispatchEvent: winTarget.dispatchEvent.bind(winTarget),
    requestAnimationFrame: requestAnimationFrameMock,
    cancelAnimationFrame: cancelAnimationFrameMock,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  mockDoc.defaultView = mockWin;

  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.defineProperty(globalThis, 'window', { value: mockWin, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: mockDoc, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'HTMLElement', { value: MiniElement, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'ResizeObserver', { value: MockResizeObserver, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: requestAnimationFrameMock,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    value: cancelAnimationFrameMock,
    configurable: true,
    writable: true,
  });

  const container = new MiniElement('div', mockDoc);
  mockDoc.body.appendChild(container);

  const raf: RafQueueController = {
    flushNextFrame: () => {
      const entries = Array.from(rafCallbacks.entries());
      rafCallbacks.clear();
      frameTimestamp += 16.67;
      for (const [, cb] of entries) {
        cb(frameTimestamp);
      }
    },
    flushAllFrames: () => {
      while (rafCallbacks.size > 0) {
        raf.flushNextFrame();
      }
    },
    pendingCount: () => rafCallbacks.size,
  };

  const cleanup = () => {
    for (const [k, v] of Object.entries(prevGlobals)) {
      if (v === undefined) {
        delete (globalThis as any)[k];
      } else {
        Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
      }
    }
  };

  return { container, raf, cleanup };
}

describe('Zero-Rerender Camera Navigation & Non-Destructive View Flip', () => {
  describe('React Profiler Render-Counter Verification (Wheel Zoom & Space+Drag)', () => {
    let env: ReturnType<typeof installMiniDomEnvironment>;
    let root: Root | null = null;

    beforeEach(() => {
      vi.useFakeTimers();
      env = installMiniDomEnvironment();
    });

    afterEach(() => {
      if (root) {
        act(() => {
          root!.unmount();
        });
        root = null;
      }
      env.cleanup();
      vi.useRealTimers();
    });

    it('causes ZERO App re-renders per frame during rapid wheel zoom and Space+Drag, committing state once after gesture completion', () => {
      let appRenderCount = 0;
      let profilerCommitCount = 0;
      let exposedNav: ReturnType<typeof useCanvasNavigation> | null = null;
      const compositorFrames: CameraTransformState[] = [];
      const customEventsReceived: CameraTransformState[] = [];
      let artboardEl: MiniElement | null = null;

      window.addEventListener(CAMERA_CHANGE_EVENT, ((e: CustomEvent<CameraTransformState>) => {
        customEventsReceived.push(e.detail);
      }) as EventListener);

      const MemoCanvasSubscriber = React.memo(function MemoCanvasSubscriber({
        navigation,
        viewportRef,
      }: {
        navigation: CanvasNavigationHandle;
        viewportRef: React.RefObject<HTMLDivElement | null>;
      }) {
        React.useEffect(() => {
          return navigation.subscribeCamera((cam) => {
            compositorFrames.push(cam);
            if (artboardEl) {
              const sx = (cam.flipX ? -1 : 1) * cam.zoom;
              const sy = (cam.flipY ? -1 : 1) * cam.zoom;
              artboardEl.style.transform = `translate3d(${cam.pan.x}px, ${cam.pan.y}px, 0) rotate(${cam.rotation}deg) scale(${sx}, ${sy})`;
            }
          });
        }, [navigation]);

        return (
          <div ref={viewportRef as any}>
            <div
              ref={(el) => {
                artboardEl = el as unknown as MiniElement | null;
              }}
            />
          </div>
        );
      });

      function MockAppRoot() {
        appRenderCount++;
        const nav = useCanvasNavigation({
          dimensions: { width: 1440, height: 900, dpi: 300 },
          activeDocumentId: 'doc-main',
        });
        exposedNav = nav;

        return (
          <div>
            <span data-zoom={nav.zoom} data-flip-x={String(nav.flipX)} />
            <MemoCanvasSubscriber navigation={nav.navigation} viewportRef={nav.viewportRef} />
          </div>
        );
      }

      root = createRoot(env.container as unknown as HTMLElement);
      act(() => {
        root!.render(
          <Profiler
            id="AppRoot"
            onRender={() => {
              profilerCommitCount++;
            }}
          >
            <MockAppRoot />
          </Profiler>
        );
      });

      expect(exposedNav).not.toBeNull();
      const viewportEl = exposedNav!.viewportRef.current as unknown as MiniElement;
      expect(viewportEl).not.toBeNull();

      // Reset counters after initial mount
      appRenderCount = 0;
      profilerCommitCount = 0;
      compositorFrames.length = 0;
      customEventsReceived.length = 0;

      // 1. Simulate 40 rapid wheel zoom events across 40 animation frames (~8ms apart, < 140ms debounce)
      for (let frame = 0; frame < 40; frame++) {
        const wheelEv = new Event('wheel', { bubbles: true, cancelable: true }) as any;
        wheelEv.clientX = 650;
        wheelEv.clientY = 480;
        wheelEv.deltaY = -45;
        wheelEv.deltaMode = 0;
        viewportEl.dispatchEvent(wheelEv);

        env.raf.flushNextFrame();
        vi.advanceTimersByTime(8);
      }

      // CRITICAL ACCEPTANCE CHECK:
      // Root App component MUST NOT re-render on any of the 40 wheel + rAF frames!
      expect(appRenderCount).toBe(0);
      expect(profilerCommitCount).toBe(0);

      // Meanwhile, direct subscriber & CustomEvent updated DOM transform and compositor on every single frame!
      expect(compositorFrames.length).toBe(40);
      expect(customEventsReceived.length).toBe(40);
      expect(exposedNav!.zoomRef.current).toBeGreaterThan(1.0);
      expect(artboardEl!.style.transform).toContain(`scale(${exposedNav!.zoomRef.current}, ${exposedNav!.zoomRef.current})`);

      // React state (`nav.zoom`) has not committed yet because wheel inertia just finished < 140ms ago
      // Advance past debounce window (140ms) -> commits to React UI state ONCE
      act(() => {
        vi.advanceTimersByTime(NAV_STATE_COMMIT_DEBOUNCE_MS + 10);
      });

      expect(appRenderCount).toBe(1);
      expect(profilerCommitCount).toBe(1);
      expect(exposedNav!.zoom).toBeCloseTo(exposedNav!.zoomRef.current, 6);

      // 2. Simulate Space + Drag panning across 50 pointermove + rAF frames
      act(() => {
        const spaceDown = new Event('keydown', { bubbles: true, cancelable: true }) as any;
        spaceDown.code = 'Space';
        spaceDown.key = ' ';
        window.dispatchEvent(spaceDown);
      });
      expect(exposedNav!.isSpaceDown).toBe(true);

      act(() => {
        exposedNav!.startPan({
          clientX: 500,
          clientY: 400,
          preventDefault: () => {},
        } as unknown as PointerEvent);
      });
      expect(exposedNav!.isPanning).toBe(true);

      // Reset render counters right after drag begins to measure all 50 active drag frames
      appRenderCount = 0;
      profilerCommitCount = 0;
      compositorFrames.length = 0;
      const panBeforeDrag = { ...exposedNav!.panRef.current };

      for (let i = 1; i <= 50; i++) {
        const moveEv = new Event('pointermove', { bubbles: true }) as any;
        moveEv.clientX = 500 + i * 4;
        moveEv.clientY = 400 + i * 3;
        window.dispatchEvent(moveEv);

        env.raf.flushNextFrame();
        vi.advanceTimersByTime(16);
      }

      // CRITICAL ACCEPTANCE CHECK:
      // ZERO App re-renders across all 50 frames (800ms > 140ms!) of active Space + Drag panning!
      expect(appRenderCount).toBe(0);
      expect(profilerCommitCount).toBe(0);
      expect(compositorFrames.length).toBe(50);
      expect(exposedNav!.panRef.current).toEqual({
        x: panBeforeDrag.x + 200,
        y: panBeforeDrag.y + 150,
      });

      // Release pointerup -> commits final pan to React state in 1 batched render
      act(() => {
        window.dispatchEvent(new Event('pointerup', { bubbles: true }));
      });

      expect(appRenderCount).toBe(1);
      expect(exposedNav!.isPanning).toBe(false);
      expect(exposedNav!.pan).toEqual({
        x: panBeforeDrag.x + 200,
        y: panBeforeDrag.y + 150,
      });

      // 3. Verify MIN_ZOOM = 0.01 and MAX_ZOOM = 32.0 clamping and resetRotation remain intact
      act(() => {
        exposedNav!.setZoom(999);
      });
      expect(exposedNav!.zoom).toBe(MAX_ZOOM);
      expect(exposedNav!.zoomRef.current).toBe(MAX_ZOOM);

      act(() => {
        exposedNav!.setZoom(0.00001);
      });
      expect(exposedNav!.zoom).toBe(MIN_ZOOM);
      expect(exposedNav!.zoomRef.current).toBe(MIN_ZOOM);

      act(() => {
        exposedNav!.setRotation(33);
      });
      expect(exposedNav!.rotation).toBe(33);
      act(() => {
        exposedNav!.resetRotation();
      });
      expect(exposedNav!.rotation).toBe(0);
      expect(exposedNav!.rotationRef.current).toBe(0);
    });

    it('mirrors viewport non-destructively via toggleFlipHorizontal / toggleFlipVertical / resetViewFlip', () => {
      let exposedNav: ReturnType<typeof useCanvasNavigation> | null = null;
      const dims = { width: 1000, height: 800, dpi: 300 };

      function Host() {
        const nav = useCanvasNavigation({ dimensions: dims, activeDocumentId: 'doc-flip' });
        exposedNav = nav;
        return <div ref={nav.viewportRef as any} />;
      }

      root = createRoot(env.container as unknown as HTMLElement);
      act(() => {
        root!.render(<Host />);
      });

      const viewportEl = exposedNav!.viewportRef.current as unknown as MiniElement;
      const vRect = viewportEl.getBoundingClientRect(); // left=100, top=50, width=1200, height=900

      // Set an arbitrary off-center, zoomed, rotated camera state
      act(() => {
        exposedNav!.setZoom(1.75);
        exposedNav!.setPan({ x: 680, y: 510 });
        exposedNav!.setRotation(28);
      });

      const sampleDocPt = { x: 260, y: 310 };
      const screenBefore = canvasToScreen(
        sampleDocPt.x,
        sampleDocPt.y,
        exposedNav!.panRef.current,
        exposedNav!.zoomRef.current,
        exposedNav!.rotationRef.current,
        dims,
        exposedNav!.flipXRef.current,
        exposedNav!.flipYRef.current
      );

      // Toggle Horizontal View Flip
      act(() => {
        exposedNav!.toggleFlipHorizontal();
      });
      expect(exposedNav!.flipX).toBe(true);
      expect(exposedNav!.flipY).toBe(false);
      expect(exposedNav!.flipXRef.current).toBe(true);

      const screenAfterFlipH = canvasToScreen(
        sampleDocPt.x,
        sampleDocPt.y,
        exposedNav!.panRef.current,
        exposedNav!.zoomRef.current,
        exposedNav!.rotationRef.current,
        dims,
        exposedNav!.flipXRef.current,
        exposedNav!.flipYRef.current
      );

      // Screen position MUST mirror horizontally across viewport center x = 1200 / 2 = 600, keeping same Y!
      expect(screenAfterFlipH.x).toBeCloseTo(1200 - screenBefore.x, 5);
      expect(screenAfterFlipH.y).toBeCloseTo(screenBefore.y, 5);

      // Cursor-to-document mapping at that mirrored screen position MUST hit sampleDocPt!
      const docUnderMirroredCursor = clientToDocument(
        vRect.left + screenAfterFlipH.x,
        vRect.top + screenAfterFlipH.y,
        vRect,
        exposedNav!.panRef.current,
        exposedNav!.zoomRef.current,
        exposedNav!.rotationRef.current,
        dims,
        exposedNav!.flipXRef.current,
        exposedNav!.flipYRef.current
      );
      expect(docUnderMirroredCursor.x).toBeCloseTo(sampleDocPt.x, 5);
      expect(docUnderMirroredCursor.y).toBeCloseTo(sampleDocPt.y, 5);

      // Toggle Vertical View Flip as well (now H+V)
      act(() => {
        exposedNav!.toggleFlipVertical();
      });
      expect(exposedNav!.flipX).toBe(true);
      expect(exposedNav!.flipY).toBe(true);

      const screenAfterFlipHV = canvasToScreen(
        sampleDocPt.x,
        sampleDocPt.y,
        exposedNav!.panRef.current,
        exposedNav!.zoomRef.current,
        exposedNav!.rotationRef.current,
        dims,
        exposedNav!.flipXRef.current,
        exposedNav!.flipYRef.current
      );
      expect(screenAfterFlipHV.x).toBeCloseTo(1200 - screenBefore.x, 5);
      expect(screenAfterFlipHV.y).toBeCloseTo(900 - screenBefore.y, 5);

      // Reset View Flip restores exact pre-flip pan, rotation, and flip flags
      act(() => {
        exposedNav!.resetViewFlip();
      });
      expect(exposedNav!.flipX).toBe(false);
      expect(exposedNav!.flipY).toBe(false);
      expect(exposedNav!.pan.x).toBeCloseTo(680, 5);
      expect(exposedNav!.pan.y).toBeCloseTo(510, 5);
      expect(exposedNav!.rotation).toBeCloseTo(28, 5);
    });

    it('never leaves Space/pan hand cursor stuck on XP-Pen synthetic Space, fast tap, dropped pointerup, or visibilitychange', () => {
      let exposedNav: ReturnType<typeof useCanvasNavigation> | null = null;
      const dims = { width: 1000, height: 800, dpi: 300 };

      function Host() {
        const nav = useCanvasNavigation({ dimensions: dims, activeDocumentId: 'doc-xppen' });
        exposedNav = nav;
        return <div ref={nav.viewportRef as any} />;
      }

      root = createRoot(env.container as unknown as HTMLElement);
      act(() => {
        root!.render(<Host />);
      });

      // 1. XP-Pen synthetic Space (empty code, key === ' ') keydown + repeat + keyup
      act(() => {
        const down1 = new Event('keydown', { bubbles: true, cancelable: true }) as any;
        down1.key = ' ';
        down1.code = '';
        window.dispatchEvent(down1);
      });
      expect(exposedNav!.isSpaceDown).toBe(true);
      expect(exposedNav!.heldModifierAction).toBe('pan');

      act(() => {
        const repeat = new Event('keydown', { bubbles: true, cancelable: true }) as any;
        repeat.key = ' ';
        repeat.code = '';
        repeat.repeat = true;
        window.dispatchEvent(repeat);
      });
      expect(exposedNav!.isSpaceDown).toBe(true);
      expect(exposedNav!.heldModifierAction).toBe('pan');

      act(() => {
        const up = new Event('keyup', { bubbles: true, cancelable: true }) as any;
        up.key = ' ';
        up.code = '';
        window.dispatchEvent(up);
      });
      expect(exposedNav!.isSpaceDown).toBe(false);
      expect(exposedNav!.heldModifierAction).toBe('none');

      // 2. Fast stylus tap: pointerup fires synchronously BEFORE React commits effect
      act(() => {
        exposedNav!.startPan({
          pointerId: 7,
          clientX: 200,
          clientY: 200,
          buttons: 1,
          preventDefault: () => {},
        } as unknown as PointerEvent);
        const upEv = new Event('pointerup', { bubbles: true }) as any;
        upEv.pointerId = 7;
        upEv.buttons = 0;
        window.dispatchEvent(upEv);
      });
      expect(exposedNav!.isPanning).toBe(false);
      expect(document.body.style.cursor).toBe('');

      // 3. Dropped pointerup (pen lifted out of proximity): next hover pointermove with buttons === 0 ends pan
      act(() => {
        exposedNav!.startPan({
          pointerId: 9,
          clientX: 300,
          clientY: 300,
          buttons: 1,
          preventDefault: () => {},
        } as unknown as PointerEvent);
      });
      expect(exposedNav!.isPanning).toBe(true);
      expect(document.body.style.cursor).toBe('grabbing');

      act(() => {
        const hoverMove = new Event('pointermove', { bubbles: true }) as any;
        hoverMove.pointerId = 9;
        hoverMove.clientX = 320;
        hoverMove.clientY = 310;
        hoverMove.buttons = 0;
        window.dispatchEvent(hoverMove);
      });
      expect(exposedNav!.isPanning).toBe(false);
      expect(document.body.style.cursor).toBe('');

      // 4. Tab/window hidden (visibilitychange) clears stuck Space & active pan
      act(() => {
        const down = new Event('keydown', { bubbles: true, cancelable: true }) as any;
        down.code = 'Space';
        down.key = ' ';
        window.dispatchEvent(down);
        exposedNav!.startPan({
          pointerId: 11,
          clientX: 300,
          clientY: 300,
          buttons: 1,
          preventDefault: () => {},
        } as unknown as PointerEvent);
      });
      expect(exposedNav!.isSpaceDown).toBe(true);
      expect(exposedNav!.isPanning).toBe(true);

      act(() => {
        (document as any).hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(exposedNav!.isSpaceDown).toBe(false);
      expect(exposedNav!.isPanning).toBe(false);
      expect(exposedNav!.heldModifierAction).toBe('none');
      expect(document.body.style.cursor).toBe('');
    });
  });

  describe('Flipped View Brush Stroke Precision & Non-Destructive Layer Guarantee', () => {
    it('places brush strokes directly under the cursor in Flip Horizontal / Vertical View without altering existing layer pixels', () => {
      const dims = { width: 1000, height: 800, dpi: 300 };
      const vRect = {
        left: 80,
        top: 40,
        right: 1280,
        bottom: 940,
        width: 1200,
        height: 900,
        x: 80,
        y: 40,
        toJSON: () => ({}),
      } as DOMRect;

      // 1. Create a layer in SparseTileGrid with existing artwork at (200, 300)
      const grid = new SparseTileGrid();
      const layerId = 'layer-ink';
      const landmarkPatch = new Uint8ClampedArray(4 * 4 * 4);
      for (let i = 0; i < 16; i++) {
        landmarkPatch[i * 4] = 20;
        landmarkPatch[i * 4 + 1] = 40;
        landmarkPatch[i * 4 + 2] = 220;
        landmarkPatch[i * 4 + 3] = 255;
      }
      grid.writeImageData(layerId, { data: landmarkPatch, width: 4, height: 4 }, 200, 300, 'color-32bit');

      const flipConfigs = [
        { flipX: true, flipY: false, pan: { x: 560, y: 440 }, zoom: 2.0, rotation: 0 },
        { flipX: true, flipY: false, pan: { x: 615, y: 470 }, zoom: 1.6, rotation: 35 },
        { flipX: false, flipY: true, pan: { x: 590, y: 430 }, zoom: 2.25, rotation: -22 },
        { flipX: true, flipY: true, pan: { x: 640, y: 495 }, zoom: 0.85, rotation: 110 },
      ];

      for (const cfg of flipConfigs) {
        // Verify original layer landmark at (200, 300) is STILL at (200, 300) — never destructively mirrored to (800, 300)
        const existingAt200 = grid.readImageData(layerId, 200, 300, 1, 1);
        expect(existingAt200.data[2]).toBe(220);
        expect(existingAt200.data[3]).toBe(255);
        const mirroredSlot = grid.readImageData(layerId, dims.width - 200 - 4, 300, 1, 1);
        expect(mirroredSlot.data[3]).toBe(0);

        // User moves stylus/mouse to screen client coordinates (clientX=430, clientY=360) and paints a stroke
        const cursorClientX = 430;
        const cursorClientY = 360;
        const expectedViewportX = cursorClientX - vRect.left; // 350
        const expectedViewportY = cursorClientY - vRect.top;  // 320

        const docStrokePt = screenToCanvas(
          cursorClientX,
          cursorClientY,
          vRect,
          cfg.pan,
          cfg.zoom,
          cfg.rotation,
          dims,
          cfg.flipX,
          cfg.flipY
        );

        // 1) Verify canvasToScreen maps the painted document point back to the exact cursor viewport coordinate
        const projectedScreen = canvasToScreen(
          docStrokePt.x,
          docStrokePt.y,
          cfg.pan,
          cfg.zoom,
          cfg.rotation,
          dims,
          cfg.flipX,
          cfg.flipY
        );
        expect(projectedScreen.x).toBeCloseTo(expectedViewportX, 6);
        expect(projectedScreen.y).toBeCloseTo(expectedViewportY, 6);

        // 2) Verify draft/predicted Canvas2D transform matrix (`getCanvasToViewportMatrix`) renders the live stroke at the exact cursor pixel (including HiDPI DPR=2)
        const dpr = 2;
        const mat = getCanvasToViewportMatrix(
          cfg.pan,
          cfg.zoom,
          cfg.rotation,
          dims,
          dpr,
          dpr,
          cfg.flipX,
          cfg.flipY
        );
        const draftDeviceX = mat.a * docStrokePt.x + mat.c * docStrokePt.y + mat.e;
        const draftDeviceY = mat.b * docStrokePt.x + mat.d * docStrokePt.y + mat.f;
        expect(draftDeviceX).toBeCloseTo(expectedViewportX * dpr, 5);
        expect(draftDeviceY).toBeCloseTo(expectedViewportY * dpr, 5);

        // 3) Verify visible canvas bounds contain the document point when cursor is inside the viewport
        const visBounds = getVisibleCanvasBounds(
          vRect,
          cfg.pan,
          cfg.zoom,
          cfg.rotation,
          dims,
          0,
          cfg.flipX,
          cfg.flipY
        );
        if (
          docStrokePt.x >= 0 &&
          docStrokePt.x <= dims.width &&
          docStrokePt.y >= 0 &&
          docStrokePt.y <= dims.height
        ) {
          expect(docStrokePt.x).toBeGreaterThanOrEqual(visBounds.minX);
          expect(docStrokePt.x).toBeLessThanOrEqual(visBounds.maxX);
          expect(docStrokePt.y).toBeGreaterThanOrEqual(visBounds.minY);
          expect(docStrokePt.y).toBeLessThanOrEqual(visBounds.maxY);
        }
      }
    });

    it('transforms coordinates accurately in StrokePipeline when flipX / flipY are enabled', () => {
      const drawnSegments: Array<{ x0: number; y0: number; x3: number; y3: number }> = [];
      const pipeline = new StrokePipeline((_ctx, seg, _color, _width, isProvisional) => {
        if (!isProvisional) {
          drawnSegments.push({
            x0: seg.p0.x,
            y0: seg.p0.y,
            x3: seg.p3.x,
            y3: seg.p3.y,
          });
        }
      });
      pipeline.setStabilizerLevel(0);
      pipeline.bindContexts({} as CanvasRenderingContext2D, {
        resetTransform: () => {},
        clearRect: () => {},
      } as unknown as CanvasRenderingContext2D);

      const view = {
        panX: 0,
        panY: 0,
        zoom: 1,
        rotation: 0,
        canvasWidth: 1000,
        canvasHeight: 800,
        flipX: true,
        flipY: false,
      };

      // Stroke at screen x = 300 (which is 200px left of center 500) -> with flipX=true, document x must be 700 (200px right of center 500)
      const makePtr = (clientX: number, clientY: number, t: number, buttons = 1) =>
        ({
          pointerId: 1,
          pointerType: 'mouse',
          clientX,
          clientY,
          pressure: 0.5,
          buttons,
          timeStamp: t,
        }) as unknown as PointerEvent;

      pipeline.onPointerDown(makePtr(300, 400, 10), view);
      pipeline.onPointerMove(makePtr(280, 400, 26), view);
      pipeline.onPointerMove(makePtr(260, 400, 42), view);
      pipeline.onPointerUp(makePtr(250, 400, 58, 0), view);

      expect(drawnSegments.length).toBeGreaterThan(0);
      expect(drawnSegments[0].x0).toBeCloseTo(700, 0);
      expect(drawnSegments[0].y0).toBeCloseTo(400, 0);
    });
  });
});
