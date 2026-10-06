import { describe, it, expect } from 'vitest';
import {
  calculateAdaptiveZoom,
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_PRESETS,
  formatZoomPercent,
  VIEWPORT_FIT_PADDING,
} from '../../hooks/useCanvasNavigation';

function createMockViewport(width: number, height: number): HTMLDivElement {
  return {
    clientWidth: width,
    clientHeight: height,
  } as unknown as HTMLDivElement;
}

describe('Canvas Navigation & Adaptive Zoom Engine', () => {
  it('adapts vertically for large manga canvas (e.g. Shueisha 6071 x 8598)', () => {
    const viewport = createMockViewport(1200, 800);
    const mangaDims = { width: 6071, height: 8598, dpi: 600 };

    const zoom = calculateAdaptiveZoom(mangaDims, viewport);

    const expectedAvailH = 800 - VIEWPORT_FIT_PADDING;
    const expectedScaleY = expectedAvailH / 8598;

    expect(zoom).toBeCloseTo(expectedScaleY, 4);
    expect(zoom).toBeLessThan(1.0);
    expect(zoom).toBeGreaterThanOrEqual(MIN_ZOOM);

    // Verify canvas rendered height with padding fits inside viewport
    const renderedHeight = mangaDims.height * zoom;
    expect(renderedHeight).toBeLessThanOrEqual(800 - VIEWPORT_FIT_PADDING);
  });

  it('defaults to 100% (1.0) zoom when canvas fits within viewport', () => {
    const viewport = createMockViewport(1200, 800);
    const smallDims = { width: 500, height: 500, dpi: 300 };

    const zoom = calculateAdaptiveZoom(smallDims, viewport);

    // 100% should be the default zoom rather than scaling up
    expect(zoom).toBe(1.0);
  });

  it('does not treat 100% as the maximum zoom level of the system', () => {
    expect(MAX_ZOOM).toBe(32.0);
    expect(MAX_ZOOM).toBeGreaterThan(1.0);
    expect(MIN_ZOOM).toBeLessThanOrEqual(0.01);
  });

  it('supports zoom presets down to 1% to accommodate high-resolution manga pages', () => {
    expect(ZOOM_PRESETS[0]).toBe(0.01);
    expect(ZOOM_PRESETS).toContain(0.05);
    expect(ZOOM_PRESETS).toContain(0.1);
    expect(ZOOM_PRESETS).toContain(1.0);
    expect(ZOOM_PRESETS[ZOOM_PRESETS.length - 1]).toBe(32.0);
  });

  it('formats fractional and sub-10% zoom levels cleanly', () => {
    expect(formatZoomPercent(1.0)).toBe('100%');
    expect(formatZoomPercent(0.5)).toBe('50%');
    expect(formatZoomPercent(0.0874)).toBe('8.7%');
    expect(formatZoomPercent(0.01)).toBe('1%');
  });

  it('handles empty or zero dimensions gracefully by returning 1.0', () => {
    const viewport = createMockViewport(1200, 800);
    expect(calculateAdaptiveZoom(undefined, viewport)).toBe(1.0);
    expect(calculateAdaptiveZoom({ width: 0, height: 0 }, viewport)).toBe(1.0);
    expect(calculateAdaptiveZoom({ width: 1000, height: 1000 }, null)).toBe(1.0);
  });
});
