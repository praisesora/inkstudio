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
} from '../selectionUtils';
import {
  solveUnitSquareToQuad,
  evaluateHomography,
  createDefaultPerspectiveQuad,
  createDefaultMeshPoints,
  evaluateMeshSurface,
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

  it('generates bicubic mesh lattice and samples surface', () => {
    const quad = createDefaultPerspectiveQuad(0, 0, 100, 100, 0);
    const mesh = createDefaultMeshPoints(quad, 4, 4);
    expect(mesh.length).toBe(4);
    expect(mesh[0].length).toBe(4);

    const mid = evaluateMeshSurface(mesh, 0.5, 0.5);
    expect(mid.x).toBeCloseTo(50, 1);
    expect(mid.y).toBeCloseTo(50, 1);
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
