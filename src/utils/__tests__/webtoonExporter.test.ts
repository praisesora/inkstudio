import { describe, it, expect } from 'vitest';
import { zipSync, unzipSync } from 'fflate';

describe('Webtoon Chapter Slicer & Exporter', () => {
  it('correctly calculates vertical chapter slice counts', () => {
    const totalHeight = 30000;
    const sliceHeight = 1280;
    const expectedSlices = Math.ceil(totalHeight / sliceHeight);

    expect(expectedSlices).toBe(24);
  });

  it('compresses sequential tiles into valid zip archive', () => {
    const mockFiles: Record<string, Uint8Array> = {
      'slice_001.jpg': new Uint8Array([255, 216, 255, 224, 0, 16]),
      'slice_002.jpg': new Uint8Array([255, 216, 255, 224, 0, 16]),
    };

    const zipData = zipSync(mockFiles);
    expect(zipData.length).toBeGreaterThan(0);

    const unzipped = unzipSync(zipData);
    expect(Object.keys(unzipped)).toContain('slice_001.jpg');
    expect(Object.keys(unzipped)).toContain('slice_002.jpg');
  });
});
