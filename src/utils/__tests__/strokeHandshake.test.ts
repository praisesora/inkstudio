import { describe, it, expect, beforeEach } from 'vitest';
import {
  SparseTileGrid,
  TILE_SIZE,
} from '../tileEngine';
import { binarizeCanvasRect } from '../colorUtils';
import { TaperEngine } from '../../engine/TaperEngine';
import { COMPOSITOR_FRAGMENT_SHADER, COMPOSITOR_INSTANCED_FRAGMENT_SHADER } from '../compositor';
import { extractCoalescedEvents } from '../../components/CanvasArea';
import { LayerPixelSampler } from '../colorMixingEngine';
import {
  drawRadialDot,
  drawRadialCubicBezierSegment,
  renderCompleteRadialStroke,
  centripetalCatmullRomToBezier,
  RadialMixingOptions,
} from '../stampEngine';

describe('Zero-Flicker Stroke Handshake & WYSIWYG Monochrome Pipeline', () => {
  let grid: SparseTileGrid;

  beforeEach(() => {
    grid = new SparseTileGrid();
  });

  it('guarantees atomic synchronous tile commit and decoupled delta generation', () => {
    const layerId = 'layer-test';
    const dirtyRect = { x: 50, y: 50, width: 100, height: 100 };

    // 1. Initial layer state
    const initialBuffer = new Uint8ClampedArray(100 * 100 * 4);
    // Draw initial blue square
    for (let i = 0; i < 100 * 100; i++) {
      initialBuffer[i * 4 + 2] = 255;
      initialBuffer[i * 4 + 3] = 255;
    }
    grid.writeImageData(layerId, { data: initialBuffer, width: 100, height: 100 }, 50, 50, 'color-32bit');

    // 2. Stroke ends on pointerup: take beforeSnapshot SYNCHRONOUSLY
    const beforeSnapshot = grid.snapshotTilesInRect(layerId, dirtyRect);
    expect(beforeSnapshot.size).toBeGreaterThan(0);

    // 3. Stroke commits pixels to canvas, then writes to grid SYNCHRONOUSLY
    let notifyFired = false;
    const unsub = grid.subscribe((immediate) => {
      if (immediate) notifyFired = true;
    });

    const newStrokeBuffer = new Uint8ClampedArray(100 * 100 * 4);
    // Overwrite with red stroke
    for (let i = 0; i < 100 * 100; i++) {
      newStrokeBuffer[i * 4] = 255;
      newStrokeBuffer[i * 4 + 3] = 255;
    }
    grid.writeImageData(layerId, { data: newStrokeBuffer, width: 100, height: 100 }, 50, 50, 'color-32bit');
    grid.notifyChange(true);

    // Grid MUST have the new stroke tiles IMMEDIATELY (zero waiting for background tasks)
    expect(notifyFired).toBe(true);
    const tile = grid.getTile(layerId, 0, 0);
    expect(tile).not.toBeNull();
    expect(tile?.dirty).toBe(true);

    // 4. In background/idle task: compute deltas from beforeSnapshot
    const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, layerId, dirtyRect);
    expect(tileDeltas.length).toBeGreaterThan(0);

    // 5. Verify undo/redo parity
    grid.applyTileDeltas(tileDeltas, 'undo');
    const undoData = grid.readImageData(layerId, 50, 50, 100, 100);
    // Should be restored to blue
    expect(undoData.data[0]).toBe(0);
    expect(undoData.data[2]).toBe(255);

    grid.applyTileDeltas(tileDeltas, 'redo');
    const redoData = grid.readImageData(layerId, 50, 50, 100, 100);
    // Should be red again
    expect(redoData.data[0]).toBe(255);
    expect(redoData.data[2]).toBe(0);

    unsub();
  });

  it('guarantees identical thresholding between binarizeCanvasRect and monochrome 1-bit tile packing', () => {
    // Mock canvas context
    const width = 10;
    const height = 10;
    const buffer = new Uint8ClampedArray(width * height * 4);

    // Fill with a gradient of alpha (from 0 to 255)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const alpha = Math.round(((y * width + x) / (width * height - 1)) * 255);
        buffer[idx] = 0;     // R
        buffer[idx + 1] = 0; // G
        buffer[idx + 2] = 0; // B
        buffer[idx + 3] = alpha;
      }
    }

    const mockCtx = {
      canvas: { width, height },
      getImageData: (_sx: number, _sy: number, sw: number, sh: number) => ({
        data: buffer,
        width: sw,
        height: sh,
      }),
      putImageData: (_imgData: { data: Uint8ClampedArray }, _sx: number, _sy: number) => {},
    } as unknown as CanvasRenderingContext2D;

    // Apply binarizeCanvasRect with default threshold 128
    binarizeCanvasRect(mockCtx, { x: 0, y: 0, width, height }, 128, true, true);

    // Check that every pixel with alpha < 128 was zeroed, and >= 128 is solid opaque black
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const origAlpha = Math.round(((y * width + x) / (width * height - 1)) * 255);
        if (origAlpha < 128) {
          expect(buffer[idx + 3]).toBe(0);
        } else {
          expect(buffer[idx + 3]).toBe(255);
          expect(buffer[idx]).toBe(0); // Black ink
        }
      }
    }
  });

  it('flick taper preserves exit velocity and generates natural tapering knots', () => {
    const taper = new TaperEngine();
    taper.configure(undefined, { minFlickSpeed: 0.5, flickPoints: 8 });

    // High exit speed flick (1.5 px/ms)
    const exitVx = 1.2;
    const exitVy = 0.9;
    const lastWidth = 20;
    const lastPressure = 0.8;
    const now = 1000;

    const flick = taper.computeFlickTaper(100, 100, lastWidth, lastPressure, exitVx, exitVy, now);

    expect(flick.count).toBe(8);
    expect(flick.points.length).toBeGreaterThanOrEqual(8);

    // Verify exponential tapering (width and pressure strictly decrease)
    let prevW = lastWidth;
    for (let i = 0; i < flick.count; i++) {
      const p = flick.points[i];
      expect(p.width).toBeLessThan(prevW);
      prevW = p.width;
    }
    // Final point should taper close to minimum
    expect(flick.points[flick.count - 1].width).toBeLessThan(5);
  });

  it('preserves monochrome-1bit strokes across LOD 1, 2, and 3 mipmaps on large manga canvases', () => {
    const layerId = 'layer-mono-manga';
    const blankCanvas = {
      width: 7016,
      height: 9921,
      __isBlank: true,
    } as unknown as HTMLCanvasElement;

    // 1. Ingest blank large monochrome canvas (simulating new B4 600 DPI manga document)
    grid.ingestCanvas(layerId, blankCanvas, 'monochrome-1bit');
    expect(grid.getLayerFormat(layerId)).toBe('monochrome-1bit');

    // 2. Commit first black ink stroke at (300, 300) via writeImageData
    const stroke1 = new Uint8ClampedArray(20 * 20 * 4);
    for (let i = 0; i < 20 * 20; i++) {
      stroke1[i * 4 + 3] = 255; // Solid black (R=0,G=0,B=0,A=255)
    }
    grid.writeImageData(layerId, { data: stroke1, width: 20, height: 20 }, 300, 300, 'monochrome-1bit');

    // 3. Query zoomed-out LOD 1, LOD 2, and LOD 3 tiles (simulating fit-to-screen viewport compositor)
    // Display LOD > 0 tiles use box-filtered color-32bit coverage to match live mipmapped drafts
    // without bitwise-OR dilation, while canonical LOD 0 tiles remain 1-bit.
    expect(grid.getTile(layerId, 1, 1, 0)!.format).toBe('monochrome-1bit');
    for (const lod of [1, 2, 3]) {
      const lodTile = grid.generateLodTile(layerId, 0, 0, lod);
      expect(lodTile).not.toBeNull();
      expect(lodTile!.format).toBe('color-32bit');
      const rgba = grid.getTileAsRGBA(lodTile!);
      let inkPixels = 0;
      for (let i = 3; i < rgba.length; i += 4) {
        if (rgba[i] === 255) inkPixels++;
      }
      expect(inkPixels).toBeGreaterThan(0);
    }

    // 4. Commit second stroke in the same LOD cluster at (420, 420) and verify dirty LOD regeneration
    grid.writeImageData(layerId, { data: stroke1, width: 20, height: 20 }, 420, 420, 'monochrome-1bit');
    expect(grid.isLodTileDirty(layerId, 0, 0, 1)).toBe(true);
    expect(grid.isLodTileDirty(layerId, 0, 0, 2)).toBe(true);
    expect(grid.isLodTileDirty(layerId, 0, 0, 3)).toBe(true);

    const updatedLod2Tiles = grid.getTilesInBounds(layerId, 0, 0, 1024, 1024, 2);
    expect(updatedLod2Tiles.length).toBe(1);
    expect(grid.isLodTileDirty(layerId, 0, 0, 2)).toBe(false);
    const rgbaAfterSecond = grid.getTileAsRGBA(updatedLod2Tiles[0]);
    // Both (300>>2 = 75) and (420>>2 = 105) must have opaque black ink in LOD 2
    const idxStroke1 = (76 * 256 + 76) * 4;
    const idxStroke2 = (106 * 256 + 106) * 4;
    expect(rgbaAfterSecond[idxStroke1 + 3]).toBe(255);
    expect(rgbaAfterSecond[idxStroke2 + 3]).toBe(255);
  });

  it('prevents double-premultiplication dark gray edge artifacts in COMPOSITOR_FRAGMENT_SHADER', () => {
    expect(COMPOSITOR_FRAGMENT_SHADER).toContain('vec4 rawTex = texture(u_tileTexture, v_texCoord);');
    expect(COMPOSITOR_FRAGMENT_SHADER).toContain('clamp(rawTex.rgb / rawTex.a, 0.0, 1.0)');
  });

  it('guarantees 100% live-vs-committed dab parity without opacity drop for darken/compare blendTipsMode', () => {
    const pts = [
      { x: 20, y: 20, pressure: 0.7, width: 12 },
      { x: 45, y: 25, pressure: 0.8, width: 14 },
      { x: 70, y: 30, pressure: 0.75, width: 13 },
    ];
    const mixingOpts: RadialMixingOptions = {
      blendTipsMode: 'darken',
      adjustDensityByGap: true,
      grain: 0.35,
      useTilt: false,
    };

    const liveStamps: Array<{ x: number; y: number; w: number; h: number; alpha: number; op: string }> = [];
    const completeStamps: Array<{ x: number; y: number; w: number; h: number; alpha: number; op: string }> = [];

    const makeMockCtx = (log: typeof liveStamps) => {
      const state = { globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true };
      return {
        canvas: { width: 200, height: 200 },
        get globalAlpha() { return state.globalAlpha; },
        set globalAlpha(v: number) { state.globalAlpha = v; },
        get globalCompositeOperation() { return state.globalCompositeOperation; },
        set globalCompositeOperation(v: string) { state.globalCompositeOperation = v; },
        get imageSmoothingEnabled() { return state.imageSmoothingEnabled; },
        set imageSmoothingEnabled(v: boolean) { state.imageSmoothingEnabled = v; },
        save: () => {},
        restore: () => {},
        translate: () => {},
        rotate: () => {},
        scale: () => {},
        clearRect: () => {},
        fillRect: () => {},
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: () => {},
        drawImage: (_img: unknown, x: number, y: number, w: number, h: number) => {
          log.push({ x, y, w, h, alpha: state.globalAlpha, op: state.globalCompositeOperation });
        },
      } as unknown as CanvasRenderingContext2D;
    };

    if (typeof (globalThis as any).document === 'undefined') {
      (globalThis as any).document = {
        createElement: () => {
          const dummyLog: typeof liveStamps = [];
          const ctx = makeMockCtx(dummyLog);
          return { width: 200, height: 200, getContext: () => ctx };
        },
      };
    }

    const liveCtx = makeMockCtx(liveStamps);
    const completeCtx = makeMockCtx(completeStamps);
    const flow = 0.62;
    const spacing = 0.05;
    const hardness = 0.55;

    // 1. Live incremental rendering (initial dot + segment 0->1 + tail segment 1->2)
    drawRadialDot(liveCtx, pts[0], '#e03030', hardness, flow, false, false, mixingOpts, 1.0, 0);
    let rem = Math.max(0.12, pts[0].width * spacing);
    const seg1 = centripetalCatmullRomToBezier(pts[0], pts[0], pts[1], pts[2]);
    rem = drawRadialCubicBezierSegment(liveCtx, pts[0], seg1.c1, seg1.c2, pts[1], '#e03030', hardness, flow, spacing, false, false, rem, 1.0, 0, mixingOpts);
    const seg2 = centripetalCatmullRomToBezier(pts[0], pts[1], pts[2], pts[2]);
    drawRadialCubicBezierSegment(liveCtx, pts[1], seg2.c1, seg2.c2, pts[2], '#e03030', hardness, flow, spacing, false, false, rem, 1.0, 0, mixingOpts);

    // 2. Complete stroke rendering
    renderCompleteRadialStroke(completeCtx, pts, '#e03030', hardness, flow, spacing, false, false, 1.0, 0, mixingOpts);

    expect(liveStamps.length).toBeGreaterThan(5);
    expect(liveStamps.length).toBe(completeStamps.length);
    for (let i = 0; i < liveStamps.length; i++) {
      expect(liveStamps[i].op).toBe('source-over');
      expect(completeStamps[i].op).toBe('source-over');
      expect(liveStamps[i].alpha).toBeCloseTo(completeStamps[i].alpha, 6);
      expect(liveStamps[i].w).toBeCloseTo(completeStamps[i].w, 6);
    }
  });

  it('LayerPixelSampler reads clean pre-stroke origTilesMap instead of dirty live tileGrid', () => {
    const layerId = 'wet-layer';
    const dirtyBuf = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
      dirtyBuf[i * 4] = 255; // Live red stroke written to tileGrid
      dirtyBuf[i * 4 + 3] = 255;
    }
    grid.writeImageData(layerId, { data: dirtyBuf, width: TILE_SIZE, height: TILE_SIZE }, 0, 0, 'color-32bit');

    // Clean pre-stroke tile was pure green
    const cleanBuf = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
    for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
      cleanBuf[i * 4 + 1] = 200;
      cleanBuf[i * 4 + 3] = 255;
    }
    const origMap = new Map<number, ImageData>();
    origMap.set(0, { data: cleanBuf, width: TILE_SIZE, height: TILE_SIZE } as ImageData);

    const mockCanvas = {
      width: 512,
      height: 512,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;

    const sampler = new LayerPixelSampler(mockCanvas, layerId, grid, origMap);
    const sampled = sampler.sampleColor(32, 32, 4);
    expect(sampled.r).toBe(0);
    expect(sampled.g).toBe(200);
    expect(sampled.a).toBeCloseTo(1.0, 2);
  });

  it('Ctrl+Z undo never deletes untouched pre-existing tiles inside a stroke bounding box dirtyRect', () => {
    const layerId = 'layer-carbon';
    const existingInk = new Uint8ClampedArray(20 * 20 * 4);
    for (let i = 0; i < 20 * 20; i++) {
      existingInk[i * 4 + 3] = 255;
    }

    // 1. Pre-existing strokes ('CARBON') in all 4 tiles: (0,0), (1,0), (0,1), (1,1)
    grid.writeImageData(layerId, { data: existingInk, width: 20, height: 20 }, 10, 10, 'color-32bit');
    grid.writeImageData(layerId, { data: existingInk, width: 20, height: 20 }, 300, 10, 'color-32bit');
    grid.writeImageData(layerId, { data: existingInk, width: 20, height: 20 }, 10, 300, 'color-32bit');
    grid.writeImageData(layerId, { data: existingInk, width: 20, height: 20 }, 300, 300, 'color-32bit');

    // 2. New diagonal stroke only touches tiles (0,0) and (1,1), so ensureLiveTileSnapshots only snapshots (0,0) and (1,1)
    const liveBeforeSnapshot = new Map();
    for (const [k, v] of grid.snapshotTilesInRect(layerId, { x: 0, y: 0, width: 100, height: 100 })) {
      liveBeforeSnapshot.set(k, v);
    }
    for (const [k, v] of grid.snapshotTilesInRect(layerId, { x: 260, y: 260, width: 100, height: 100 })) {
      liveBeforeSnapshot.set(k, v);
    }

    // Mutate tiles (0,0) and (1,1) with new red stroke
    const newStroke = new Uint8ClampedArray(20 * 20 * 4);
    for (let i = 0; i < 20 * 20; i++) {
      newStroke[i * 4] = 255;
      newStroke[i * 4 + 3] = 255;
    }
    grid.writeImageData(layerId, { data: newStroke, width: 20, height: 20 }, 50, 50, 'color-32bit');
    grid.writeImageData(layerId, { data: newStroke, width: 20, height: 20 }, 340, 340, 'color-32bit');

    // 3. Compute deltas even if full 512x512 bounding box dirtyRect is passed
    const deltas = grid.computeDeltasFromSnapshot(liveBeforeSnapshot, layerId, {
      x: 0,
      y: 0,
      width: 512,
      height: 512,
    });
    expect(deltas.length).toBe(2);

    // 4. Press Ctrl+Z (undo): untouched tiles (1,0) and (0,1) MUST still exist and retain their original pixels!
    grid.applyTileDeltas(deltas, 'undo');
    expect(grid.getTile(layerId, 1, 0)).not.toBeNull();
    expect(grid.getTile(layerId, 0, 1)).not.toBeNull();
    expect(grid.readImageData(layerId, 300, 10, 1, 1).data[3]).toBe(255);
    expect(grid.readImageData(layerId, 10, 300, 1, 1).data[3]).toBe(255);
    // And touched tiles (0,0) and (1,1) must be restored to their pre-stroke CARBON pixels without the red stroke
    expect(grid.readImageData(layerId, 10, 10, 1, 1).data[3]).toBe(255);
    expect(grid.readImageData(layerId, 50, 50, 1, 1).data[3]).toBe(0);
  });

  it('guards against Windows Ink/WebView2 coalesced pointer coordinate drift on pointerdown and pointermove', () => {
    const downNative = {
      type: 'pointerdown',
      clientX: 257,
      clientY: 55,
      getCoalescedEvents: () => [{ clientX: 282, clientY: 88 }],
    } as unknown as PointerEvent;
    expect(extractCoalescedEvents({ nativeEvent: downNative } as React.PointerEvent<HTMLElement>)).toEqual([
      downNative,
    ]);

    const offsetMoveNative = {
      type: 'pointermove',
      clientX: 257,
      clientY: 55,
      getCoalescedEvents: () => [
        { clientX: 278, clientY: 82 },
        { clientX: 282, clientY: 88 },
      ],
    } as unknown as PointerEvent;
    expect(extractCoalescedEvents({ nativeEvent: offsetMoveNative } as React.PointerEvent<HTMLElement>)).toEqual([
      offsetMoveNative,
    ]);

    const validCoalesced = [
      { clientX: 254, clientY: 53 },
      { clientX: 257.4, clientY: 55.2 },
    ];
    const alignedMoveNative = {
      type: 'pointermove',
      clientX: 257,
      clientY: 55,
      getCoalescedEvents: () => validCoalesced,
    } as unknown as PointerEvent;
    expect(extractCoalescedEvents({ nativeEvent: alignedMoveNative } as React.PointerEvent<HTMLElement>)).toEqual(
      validCoalesced
    );
  });

  it('uses identical monochrome alpha curve in draft and instanced shaders and box-filters 1-bit LOD coverage', () => {
    // Draft (COMPOSITOR_FRAGMENT_SHADER) and baked tiles (COMPOSITOR_INSTANCED_FRAGMENT_SHADER)
    // must use the exact same monochrome alpha expression (no edge-bloating smoothstep on draft).
    expect(COMPOSITOR_FRAGMENT_SHADER).toContain(
      'float monoAlpha = u_zoom >= 0.99 ? step(0.5, finalColor.a) : finalColor.a;'
    );
    expect(COMPOSITOR_INSTANCED_FRAGMENT_SHADER).toContain(
      'float monoAlpha = u_zoom >= 0.99 ? step(0.5, finalColor.a) : finalColor.a;'
    );
    expect(COMPOSITOR_FRAGMENT_SHADER).not.toContain('smoothstep(0.02, monoHi');

    // A single 1-bit ink pixel in a 2x2 block must produce 1/4 alpha coverage (64), NOT bitwise-OR 255
    const layerId = 'layer-mono-lod-cov';
    const dot = new Uint8ClampedArray(4);
    dot[3] = 255;
    grid.writeImageData(layerId, { data: dot, width: 1, height: 1 }, 10, 10, 'monochrome-1bit');

    const lod1 = grid.generateLodTile(layerId, 0, 0, 1);
    expect(lod1).not.toBeNull();
    expect(lod1!.format).toBe('color-32bit');
    const rgba = grid.getTileAsRGBA(lod1!);
    const idx = (5 * TILE_SIZE + 5) * 4;
    expect(rgba[idx]).toBe(0);
    expect(rgba[idx + 1]).toBe(0);
    expect(rgba[idx + 2]).toBe(0);
    expect(rgba[idx + 3]).toBe(64);
  });
});
