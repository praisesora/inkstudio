import { describe, it, expect } from 'vitest';
import {
  expandSelection,
  contractSelection,
  featherSelection,
  invertSelection,
  maskToBounds,
  maskToSvgPath,
  floodSelectWand,
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
