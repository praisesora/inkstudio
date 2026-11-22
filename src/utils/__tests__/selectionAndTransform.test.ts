import { describe, it, expect, vi } from 'vitest';
import {
  expandSelection,
  contractSelection,
  featherSelection,
  invertSelection,
  maskToBounds,
  maskToSvgPath,
  floodSelectWand,
  liftSelectionToFloating,
  clearSelectionInTileGrid,
  clearOutsideSelectionInTileGrid,
  extractSelectionTileSnapshot,
} from '../selectionUtils';
import { SparseTileGrid } from '../tileEngine';
import {
  solveUnitSquareToQuad,
  evaluateHomography,
  createDefaultPerspectiveQuad,
  createDefaultMeshPoints,
  computeMeshSubdivisions,
  evaluateMeshSurface,
  expandTriangleOutward,
  getPointsBounds,
  getMeshSurfaceBounds,
  renderMeshWarp,
} from '../transformEngine';

describe('Selection Boundary Modifiers and Wand', () => {
  it('correctly expands a 10x10 binary mask by 2 pixels', () => {
    const w = 20;
    const h = 20;
    const mask = new Uint8Array(w * h);
    // Draw a 4x4 square in the center (x: 8..11, y: 8..11)
    for (let y = 8; y <= 11; y++) {
      for (let x = 8; x <= 11; x++) {
        mask[y * w + x] = 255;
      }
    }

    const expanded = expandSelection(mask, w, h, 2);
    // Bounds before: 4x4
    const boundsBefore = maskToBounds(mask, w, h);
    expect(boundsBefore).toEqual({ x: 8, y: 8, width: 4, height: 4 });

    // Bounds after: 8x8 (expanded by 2 on all sides)
    const boundsAfter = maskToBounds(expanded, w, h);
    expect(boundsAfter).toEqual({ x: 6, y: 6, width: 8, height: 8 });
  });

  it('correctly contracts an 8x8 square by 2 pixels', () => {
    const w = 20;
    const h = 20;
    const mask = new Uint8Array(w * h);
    for (let y = 6; y <= 13; y++) {
      for (let x = 6; x <= 13; x++) {
        mask[y * w + x] = 255;
      }
    }

    const contracted = contractSelection(mask, w, h, 2);
    const boundsAfter = maskToBounds(contracted, w, h);
    expect(boundsAfter).toEqual({ x: 8, y: 8, width: 4, height: 4 });
  });

  it('inverts an 8-bit selection mask', () => {
    const w = 4;
    const h = 4;
    const mask = new Uint8Array(w * h);
    mask[0] = 255;
    mask[5] = 128;

    const inverted = invertSelection(mask, w, h);
    expect(inverted[0]).toBe(0);
    expect(inverted[1]).toBe(255);
    expect(inverted[5]).toBe(127);
  });

  it('feathers selection mask boundary with Gaussian blur', () => {
    const w = 16;
    const h = 16;
    const mask = new Uint8Array(w * h);
    for (let y = 4; y <= 11; y++) {
      for (let x = 4; x <= 11; x++) {
        mask[y * w + x] = 255;
      }
    }

    const feathered = featherSelection(mask, w, h, 2);
    // Center pixel should remain relatively high
    expect(feathered[8 * w + 8]).toBeGreaterThan(200);
    // Boundary adjacent pixel outside should now have non-zero feathered alpha
    expect(feathered[3 * w + 8]).toBeGreaterThan(0);
    expect(feathered[3 * w + 8]).toBeLessThan(255);
  });

  it('converts mask to closed SVG polygon path', () => {
    const w = 10;
    const h = 10;
    const mask = new Uint8Array(w * h);
    for (let y = 2; y <= 5; y++) {
      for (let x = 2; x <= 5; x++) {
        mask[y * w + x] = 255;
      }
    }
    const svg = maskToSvgPath(mask, w, h);
    expect(svg.startsWith('M ')).toBe(true);
    expect(svg.endsWith('Z')).toBe(true);
  });

  it('flood selects contiguous area with tolerance', () => {
    const w = 10;
    const h = 10;
    const imgData = new Uint8ClampedArray(w * h * 4);
    // Fill all with red (255, 0, 0, 255)
    for (let i = 0; i < w * h; i++) {
      imgData[i * 4] = 255;
      imgData[i * 4 + 1] = 0;
      imgData[i * 4 + 2] = 0;
      imgData[i * 4 + 3] = 255;
    }
    // Set a 2x2 green area
    for (let y = 4; y <= 5; y++) {
      for (let x = 4; x <= 5; x++) {
        const idx = (y * w + x) * 4;
        imgData[idx] = 0;
        imgData[idx + 1] = 255;
        imgData[idx + 2] = 0;
      }
    }

    const wandRes = floodSelectWand(imgData, w, h, 4, 4, {
      tolerance: 10,
      contiguous: true,
      antiAlias: false,
      referMode: 'active',
    });

    expect(wandRes.bounds).toEqual({ x: 4, y: 4, width: 2, height: 2 });
    expect(wandRes.mask[4 * w + 4]).toBe(255);
    expect(wandRes.mask[0]).toBe(0);
  });
});

describe('Perspective and Mesh Transformation Engine', () => {
  it('solves homography and correctly maps unit square to destination quad', () => {
    const quad = [
      { x: 10, y: 10 },
      { x: 110, y: 10 },
      { x: 110, y: 110 },
      { x: 10, y: 110 },
    ];
    const H = solveUnitSquareToQuad(quad[0], quad[1], quad[2], quad[3]);
    expect(H).not.toBeNull();

    // Map unit corners (0,0), (1,0), (1,1), (0,1)
    const p00 = evaluateHomography(H, 0, 0);
    const p10 = evaluateHomography(H, 1, 0);
    const p11 = evaluateHomography(H, 1, 1);
    const p01 = evaluateHomography(H, 0, 1);

    expect(p00.x).toBeCloseTo(10, 3);
    expect(p00.y).toBeCloseTo(10, 3);
    expect(p10.x).toBeCloseTo(110, 3);
    expect(p10.y).toBeCloseTo(10, 3);
    expect(p11.x).toBeCloseTo(110, 3);
    expect(p11.y).toBeCloseTo(110, 3);
    expect(p01.x).toBeCloseTo(10, 3);
    expect(p01.y).toBeCloseTo(110, 3);
  });

  it('generates exact identity bicubic mesh lattice without rounding distortion', () => {
    const quad = createDefaultPerspectiveQuad(0, 0, 100, 100, 0);
    const mesh = createDefaultMeshPoints(quad, 4, 4);
    expect(mesh.length).toBe(4);
    expect(mesh[0].length).toBe(4);

    // Interior control points must not be rounded (100/3 = 33.333..., not 33)
    expect(mesh[0][1].x).toBeCloseTo(100 / 3, 6);
    expect(mesh[0][2].x).toBeCloseTo(200 / 3, 6);

    for (const u of [0, 0.17, 0.33, 0.5, 0.73, 1]) {
      for (const v of [0, 0.21, 0.5, 0.84, 1]) {
        const pt = evaluateMeshSurface(mesh, u, v);
        expect(pt.x).toBeCloseTo(u * 100, 5);
        expect(pt.y).toBeCloseTo(v * 100, 5);
      }
    }
  });

  it('captures Catmull-Rom overshoot in getMeshSurfaceBounds and avoids 1px clipping in getPointsBounds', () => {
    const b = getPointsBounds([
      { x: 10.6, y: 20.7 },
      { x: 109.2, y: 80.1 },
    ]);
    expect(b.minX).toBe(10);
    expect(b.maxX).toBe(110);
    expect(b.width).toBe(100);
    expect(b.minY).toBe(20);
    expect(b.maxY).toBe(81);
    expect(b.height).toBe(61);

    // Pull inner columns outward so Catmull-Rom bows past outer edge
    const quad = createDefaultPerspectiveQuad(0, 0, 100, 100, 0);
    const mesh = createDefaultMeshPoints(quad, 4, 4);
    mesh[1][1].x -= 40;
    mesh[1][2].x += 40;
    const ctrlBounds = getPointsBounds(mesh.flat());
    const surfBounds = getMeshSurfaceBounds(mesh, 6);
    expect(surfBounds.minX).toBeLessThanOrEqual(ctrlBounds.minX);
    expect(surfBounds.maxX).toBeGreaterThanOrEqual(ctrlBounds.maxX);
    expect(computeMeshSubdivisions(1024, 1024, mesh, true)).toBeGreaterThanOrEqual(10);
  });

  it('expands adjacent quad triangles strictly outward across their shared diagonal', () => {
    const expand = 0.75;
    // Unit quad (0,0)-(100,0)-(100,80)-(0,80) split along (100,0)-(0,80)
    const t1 = expandTriangleOutward(0, 0, 100, 0, 0, 80, expand);
    const t2 = expandTriangleOutward(100, 0, 100, 80, 0, 80, expand);
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();

    // Shared diagonal line: (100, 0) -> (0, 80); unit normal pointing toward t2 (+x, +y)
    const len = Math.hypot(100, 80);
    const nx = 80 / len;
    const ny = 100 / len;
    const signedDistToDiag = (x: number, y: number) => (x - 100) * nx + y * ny;

    // t1 diagonal endpoints (indices 2,3 and 4,5) must shift outward into t2 (+expand)
    expect(signedDistToDiag(t1![2], t1![3])).toBeCloseTo(expand, 5);
    expect(signedDistToDiag(t1![4], t1![5])).toBeCloseTo(expand, 5);

    // t2 diagonal endpoints (indices 0,1 and 4,5) must shift outward into t1 (-expand)
    expect(signedDistToDiag(t2![0], t2![1])).toBeCloseTo(-expand, 5);
    expect(signedDistToDiag(t2![4], t2![5])).toBeCloseTo(-expand, 5);
  });

  it('expands reversed-winding (flipped) triangles outward and rejects degenerate triangles', () => {
    const expand = 0.75;
    // Reversed winding of (0,0)-(100,0)-(0,100) -> (0,0)-(0,100)-(100,0)
    const flipped = expandTriangleOutward(0, 0, 0, 100, 100, 0, expand);
    expect(flipped).not.toBeNull();
    const invSqrt2 = Math.SQRT1_2;
    const dist = (x: number, y: number) => (x + y - 100) * invSqrt2;
    expect(dist(flipped![2], flipped![3])).toBeCloseTo(expand, 5);
    expect(dist(flipped![4], flipped![5])).toBeCloseTo(expand, 5);

    // Collinear / zero-area triangle returns null
    expect(expandTriangleOutward(0, 0, 50, 50, 100, 100, expand)).toBeNull();
  });

  it('falls back to Canvas2D triangle rendering cleanly when WebGL is unavailable', () => {
    const clipCalls: number[][] = [];
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn((x: number, y: number) => clipCalls.push([x, y])),
      lineTo: vi.fn((x: number, y: number) => clipCalls.push([x, y])),
      closePath: vi.fn(),
      clip: vi.fn(),
      transform: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    const src = { width: 100, height: 100 } as HTMLCanvasElement;
    const quad = createDefaultPerspectiveQuad(0, 0, 100, 100, 0);
    const mesh = createDefaultMeshPoints(quad, 3, 3);
    renderMeshWarp(mockCtx, src, mesh, 2);

    // (3-1)*2 = 4 cells per axis -> 16 cells -> 32 triangles -> 96 vertices
    expect(mockCtx.drawImage).toHaveBeenCalledTimes(32);
    expect(clipCalls.length).toBe(96);
    for (const [x, y] of clipCalls) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });
});

interface MockPixelCanvas {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  setTransformCalls: number[][];
  getContext: (type: string) => unknown;
}

function createMockPixelCanvas(width = 16, height = 16): MockPixelCanvas {
  let w = width;
  let h = height;
  let buf = new Uint8ClampedArray(w * h * 4);
  const setTransformCalls: number[][] = [];
  let gco = 'source-over';

  const ctx = {
    get globalCompositeOperation() {
      return gco;
    },
    set globalCompositeOperation(v: string) {
      gco = v;
    },
    fillStyle: '#000000',
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn((...args: number[]) => {
      setTransformCalls.push(args);
    }),
    createImageData(iw: number, ih: number) {
      return { width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) };
    },
    getImageData(sx: number, sy: number, sw: number, sh: number) {
      const out = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y++) {
        const srcY = sy + y;
        if (srcY < 0 || srcY >= h) continue;
        for (let x = 0; x < sw; x++) {
          const srcX = sx + x;
          if (srcX < 0 || srcX >= w) continue;
          const sOff = (srcY * w + srcX) * 4;
          const dOff = (y * sw + x) * 4;
          out[dOff] = buf[sOff];
          out[dOff + 1] = buf[sOff + 1];
          out[dOff + 2] = buf[sOff + 2];
          out[dOff + 3] = buf[sOff + 3];
        }
      }
      return { width: sw, height: sh, data: out };
    },
    putImageData(img: { width: number; height: number; data: Uint8ClampedArray }, dx: number, dy: number) {
      for (let y = 0; y < img.height; y++) {
        const ty = dy + y;
        if (ty < 0 || ty >= h) continue;
        for (let x = 0; x < img.width; x++) {
          const tx = dx + x;
          if (tx < 0 || tx >= w) continue;
          const sOff = (y * img.width + x) * 4;
          const dOff = (ty * w + tx) * 4;
          buf[dOff] = img.data[sOff];
          buf[dOff + 1] = img.data[sOff + 1];
          buf[dOff + 2] = img.data[sOff + 2];
          buf[dOff + 3] = img.data[sOff + 3];
        }
      }
    },
    clearRect(rx: number, ry: number, rw: number, rh: number) {
      for (let y = Math.max(0, ry); y < Math.min(h, ry + rh); y++) {
        for (let x = Math.max(0, rx); x < Math.min(w, rx + rw); x++) {
          const off = (y * w + x) * 4;
          buf[off] = 0;
          buf[off + 1] = 0;
          buf[off + 2] = 0;
          buf[off + 3] = 0;
        }
      }
    },
    drawImage(src: MockPixelCanvas, dx: number, dy: number) {
      for (let y = 0; y < src.height; y++) {
        const ty = dy + y;
        if (ty < 0 || ty >= h) continue;
        for (let x = 0; x < src.width; x++) {
          const tx = dx + x;
          if (tx < 0 || tx >= w) continue;
          const sOff = (y * src.width + x) * 4;
          const dOff = (ty * w + tx) * 4;
          const sa = src.data[sOff + 3] / 255;
          if (gco === 'destination-in') {
            buf[dOff + 3] = Math.round(buf[dOff + 3] * sa);
          } else if (gco === 'destination-out') {
            buf[dOff + 3] = Math.round(buf[dOff + 3] * (1 - sa));
            if (buf[dOff + 3] === 0) {
              buf[dOff] = 0;
              buf[dOff + 1] = 0;
              buf[dOff + 2] = 0;
            }
          } else {
            buf[dOff] = src.data[sOff];
            buf[dOff + 1] = src.data[sOff + 1];
            buf[dOff + 2] = src.data[sOff + 2];
            buf[dOff + 3] = src.data[sOff + 3];
          }
        }
      }
    },
  };

  const canvas: MockPixelCanvas = {
    get width() {
      return w;
    },
    set width(v: number) {
      w = v;
      buf = new Uint8ClampedArray(Math.max(0, w * h * 4));
    },
    get height() {
      return h;
    },
    set height(v: number) {
      h = v;
      buf = new Uint8ClampedArray(Math.max(0, w * h * 4));
    },
    get data() {
      return buf;
    },
    setTransformCalls,
    getContext: () => ctx,
  };
  return canvas;
}

describe('liftSelectionToFloating integrity (no duplication or out-of-bounds artifacts)', () => {
  it('clamps out-of-bounds rect/mask selection, resets CTM, and erases lifted pixels completely', () => {
    const prevDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
      createElement: () => createMockPixelCanvas(1, 1),
    };

    try {
      const target = createMockPixelCanvas(10, 10);
      // Paint a 4x4 purple block at (0..3, 0..3)
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const off = (y * 10 + x) * 4;
          target.data[off] = 144;
          target.data[off + 1] = 93;
          target.data[off + 2] = 156;
          target.data[off + 3] = 255;
        }
      }

      const mask = new Uint8Array(10 * 10);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          mask[y * 10 + x] = 255;
        }
      }

      const lifted = liftSelectionToFloating(target as unknown as HTMLCanvasElement, {
        type: 'wand',
        bounds: { x: -2, y: -2, width: 6, height: 6 },
        mask,
        maskWidth: 10,
        maskHeight: 10,
      });

      expect(lifted).not.toBeNull();
      expect(lifted!.bounds).toEqual({ x: 0, y: 0, width: 4, height: 4 });
      expect(target.setTransformCalls).toContainEqual([1, 0, 0, 1, 0, 0]);

      // Floating canvas must contain the lifted purple pixels
      const floatCanvas = lifted!.floatingCanvas as unknown as MockPixelCanvas;
      expect(floatCanvas.data[3]).toBe(255);
      expect(floatCanvas.data[(3 * 4 + 3) * 4 + 3]).toBe(255);

      // Base layer must have zero leftover alpha inside the lifted region (no duplicate)
      let remainingAlpha = 0;
      for (let i = 3; i < target.data.length; i += 4) {
        remainingAlpha += target.data[i];
      }
      expect(remainingAlpha).toBe(0);
    } finally {
      (globalThis as { document?: unknown }).document = prevDoc;
    }
  });

  it('falls back to rect erase when a non-lasso selection lacks mask dimensions (no duplication)', () => {
    const prevDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
      createElement: () => createMockPixelCanvas(1, 1),
    };

    try {
      const target = createMockPixelCanvas(8, 8);
      for (let y = 2; y < 6; y++) {
        for (let x = 2; x < 6; x++) {
          const off = (y * 8 + x) * 4;
          target.data[off] = 144;
          target.data[off + 3] = 255;
        }
      }

      const lifted = liftSelectionToFloating(target as unknown as HTMLCanvasElement, {
        type: 'wand',
        bounds: { x: 2, y: 2, width: 4, height: 4 },
      });

      expect(lifted).not.toBeNull();
      let remainingAlpha = 0;
      for (let i = 3; i < target.data.length; i += 4) {
        remainingAlpha += target.data[i];
      }
      expect(remainingAlpha).toBe(0);
    } finally {
      (globalThis as { document?: unknown }).document = prevDoc;
    }
  });
});

describe('Tile-Native Lasso Cut/Copy/Paste and Delete Inside/Outside', () => {
  const fillSolidRect = (
    grid: SparseTileGrid,
    layerId: string,
    x: number,
    y: number,
    w: number,
    h: number,
    rgba: [number, number, number, number],
    format: 'color-32bit' | 'monochrome-1bit' = 'color-32bit'
  ) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = rgba[0];
      data[i * 4 + 1] = rgba[1];
      data[i * 4 + 2] = rgba[2];
      data[i * 4 + 3] = rgba[3];
    }
    grid.writeImageData(layerId, { data, width: w, height: h }, x, y, format, true);
  };

  it('cuts a lasso polygon section from a single layer, pastes into a new layer, and atomically undoes', () => {
    const grid = new SparseTileGrid();
    const dims = { width: 512, height: 512 };
    // Paint a 100x100 red block at (10, 10)
    fillSolidRect(grid, 'layer-1', 10, 10, 100, 100, [220, 40, 60, 255]);

    // Lasso triangle inside the block: (20,20) -> (80,20) -> (20,80)
    const lassoSelection = {
      type: 'lasso' as const,
      bounds: { x: 20, y: 20, width: 60, height: 60 },
      polygon: [
        { x: 20, y: 20 },
        { x: 80, y: 20 },
        { x: 20, y: 80 },
      ],
    };

    // 1. Extract selected pixels
    const snapshot = extractSelectionTileSnapshot({
      grid,
      layerId: 'layer-1',
      dimensions: dims,
      selection: lassoSelection,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.tiles.length).toBe(1);

    // 2. Clear selected pixels from source layer (Cut)
    const cleared = clearSelectionInTileGrid({
      grid,
      layerId: 'layer-1',
      dimensions: dims,
      selection: lassoSelection,
      isBackground: false,
      targetFormat: 'color-32bit',
    });
    expect(cleared.tileDeltas.length).toBeGreaterThan(0);

    // 3. Paste snapshot into new layer
    grid.pasteLayerTilesSnapshot('layer-cut', snapshot!);
    const destDeltas = grid.computeDeltasFromSnapshot(new Map(), 'layer-cut', snapshot!.bounds);
    expect(destDeltas.length).toBeGreaterThan(0);

    // Inside triangle (30, 30): erased from source, present in new layer
    expect(grid.getPixelRGBA('layer-1', 30, 30)[3]).toBe(0);
    expect(Array.from(grid.getPixelRGBA('layer-cut', 30, 30))).toEqual([220, 40, 60, 255]);

    // Outside triangle but inside bounds (70, 70): still in source, empty in new layer
    expect(Array.from(grid.getPixelRGBA('layer-1', 70, 70))).toEqual([220, 40, 60, 255]);
    expect(grid.getPixelRGBA('layer-cut', 70, 70)[3]).toBe(0);

    // Atomic undo restores source and clears new layer
    const combined = [...cleared.tileDeltas, ...destDeltas];
    grid.applyTileDeltas(combined, 'undo');
    expect(Array.from(grid.getPixelRGBA('layer-1', 30, 30))).toEqual([220, 40, 60, 255]);
    expect(grid.getPixelRGBA('layer-cut', 30, 30)[3]).toBe(0);

    // Redo reapplies both
    grid.applyTileDeltas(combined, 'redo');
    expect(grid.getPixelRGBA('layer-1', 30, 30)[3]).toBe(0);
    expect(Array.from(grid.getPixelRGBA('layer-cut', 30, 30))).toEqual([220, 40, 60, 255]);
  });

  it('returns null when extracting an empty selection region', () => {
    const grid = new SparseTileGrid();
    const dims = { width: 256, height: 256 };
    fillSolidRect(grid, 'layer-1', 0, 0, 20, 20, [0, 0, 0, 255]);

    const emptySnap = extractSelectionTileSnapshot({
      grid,
      layerId: 'layer-1',
      dimensions: dims,
      selection: { type: 'rect', bounds: { x: 100, y: 100, width: 40, height: 40 } },
    });
    expect(emptySnap).toBeNull();
  });

  it('deletes outside a lasso selection across multiple tiles and restores on undo', () => {
    const grid = new SparseTileGrid();
    const dims = { width: 600, height: 600 };
    // Paint in tile (0,0) and tile (1,1)
    fillSolidRect(grid, 'layer-1', 10, 10, 100, 100, [10, 200, 30, 255]);
    fillSolidRect(grid, 'layer-1', 300, 300, 50, 50, [10, 200, 30, 255]);

    const lassoSelection = {
      type: 'lasso' as const,
      bounds: { x: 20, y: 20, width: 60, height: 60 },
      polygon: [
        { x: 20, y: 20 },
        { x: 80, y: 20 },
        { x: 20, y: 80 },
      ],
    };

    const { tileDeltas } = clearOutsideSelectionInTileGrid({
      grid,
      layerId: 'layer-1',
      dimensions: dims,
      selection: lassoSelection,
      isBackground: false,
      targetFormat: 'color-32bit',
    });

    expect(tileDeltas.length).toBeGreaterThanOrEqual(2);
    // Inside triangle remains intact
    expect(Array.from(grid.getPixelRGBA('layer-1', 30, 30))).toEqual([10, 200, 30, 255]);
    // Outside triangle in same tile is erased
    expect(grid.getPixelRGBA('layer-1', 70, 70)[3]).toBe(0);
    // Separate tile (1,1) completely outside selection is pruned
    expect(grid.getPixelRGBA('layer-1', 310, 310)[3]).toBe(0);
    expect(grid.getTile('layer-1', 1, 1, 0)).toBeNull();

    // Undo restores both tiles
    grid.applyTileDeltas(tileDeltas, 'undo');
    expect(Array.from(grid.getPixelRGBA('layer-1', 70, 70))).toEqual([10, 200, 30, 255]);
    expect(Array.from(grid.getPixelRGBA('layer-1', 310, 310))).toEqual([10, 200, 30, 255]);
  });

  it('fills outside with white on background layer and preserves feathered mask alpha on normal layer', () => {
    const grid = new SparseTileGrid();
    const dims = { width: 64, height: 64 };
    grid.fillLayerSolidWhite('layer-bg', 64, 64, 'color-32bit');
    fillSolidRect(grid, 'layer-bg', 0, 0, 64, 64, [255, 0, 0, 255]);

    const mask = new Uint8Array(64 * 64);
    for (let y = 16; y < 32; y++) {
      for (let x = 16; x < 32; x++) {
        mask[y * 64 + x] = 255;
      }
    }

    clearOutsideSelectionInTileGrid({
      grid,
      layerId: 'layer-bg',
      dimensions: dims,
      selection: {
        type: 'mask',
        bounds: { x: 16, y: 16, width: 16, height: 16 },
        mask,
        maskWidth: 64,
        maskHeight: 64,
      },
      isBackground: true,
      targetFormat: 'color-32bit',
    });

    // Inside mask stays red; outside becomes opaque white
    expect(Array.from(grid.getPixelRGBA('layer-bg', 20, 20))).toEqual([255, 0, 0, 255]);
    expect(Array.from(grid.getPixelRGBA('layer-bg', 5, 5))).toEqual([255, 255, 255, 255]);
  });

  it('preserves 1-bit monochrome format when extracting a selection', () => {
    const grid = new SparseTileGrid();
    const dims = { width: 128, height: 128 };
    fillSolidRect(grid, 'mono-1', 10, 10, 40, 40, [0, 0, 0, 255], 'monochrome-1bit');

    const snap = extractSelectionTileSnapshot({
      grid,
      layerId: 'mono-1',
      dimensions: dims,
      selection: { type: 'rect', bounds: { x: 15, y: 15, width: 20, height: 20 } },
    });
    expect(snap).not.toBeNull();
    expect(snap!.format).toBe('monochrome-1bit');
    grid.pasteLayerTilesSnapshot('mono-2', snap!);
    expect(grid.getLayerFormat('mono-2')).toBe('monochrome-1bit');
    expect(grid.getPixelRGBA('mono-2', 20, 20)[3]).toBe(255);
    expect(grid.getPixelRGBA('mono-2', 12, 12)[3]).toBe(0);
  });
});
