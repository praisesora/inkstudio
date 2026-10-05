import { describe, it, expect } from 'vitest';
import {
  evaluateHalftoneDot,
  fract,
} from '../screentoneEngine';

describe('Anti-Moiré Manga Screentone GPU & CPU Pipeline', () => {
  it('evaluates Euclidean manga dot spot formula correctly', () => {
    const cosA = Math.cos(Math.PI / 4);
    const sinA = Math.sin(Math.PI / 4);
    const cellSize = 10; // 600 DPI / 60 LPI

    // Center of a cell (xr = cellSize * 0.5) with 50% density should be black ink
    const centerX = cellSize * 0.5 * cosA;
    const centerY = cellSize * 0.5 * sinA;
    const isInk = evaluateHalftoneDot(centerX, centerY, 0.5, cellSize, cosA, sinA, 'circle');
    expect(isInk).toBe(true);

    // Far corner of cell (u = 0.5, v = 0.5) with 10% density should be white paper
    const isInkCorner = evaluateHalftoneDot(0, 0, 0.1, cellSize, cosA, sinA, 'circle');
    expect(isInkCorner).toBe(false);
  });

  it('fract function strictly yields [0.0, 1.0)', () => {
    expect(fract(0.5)).toBeCloseTo(0.5);
    expect(fract(1.0)).toBeCloseTo(0.0);
    expect(fract(-0.25)).toBeCloseTo(0.75);
    expect(fract(-1.5)).toBeCloseTo(0.5);
  });
});
