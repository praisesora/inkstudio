import { describe, it, expect } from 'vitest';
import {
  processAffineTransformChunks,
  processPerspectiveTransformChunks,
  resolveLosslessAffineSpec,
  type PixelBuffer,
} from '../transformEngine';
import { SparseTileGrid } from '../tileEngine';
import { ERASER_PRESET_ID } from '../brushPresetManager';
import { useToolStore, toolStoreActions } from '../../stores';

function makeBuffer(width: number, height: number): PixelBuffer {
  return {
    data: new Uint8ClampedArray(width * height * 4),
    width,
    height,
  };
}

function setPx(buf: PixelBuffer, x: number, y: number, r: number, g: number, b: number, a: number) {
  const off = (y * buf.width + x) * 4;
  buf.data[off] = r;
  buf.data[off + 1] = g;
  buf.data[off + 2] = b;
  buf.data[off + 3] = a;
}

function getPx(buf: PixelBuffer, x: number, y: number): [number, number, number, number] {
  const off = (y * buf.width + x) * 4;
  return [buf.data[off], buf.data[off + 1], buf.data[off + 2], buf.data[off + 3]];
}

function runAffineToBuffer(
  src: PixelBuffer,
  params: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    flipH: boolean;
    flipV: boolean;
  },
  docW: number,
  docH: number,
  chunkSize = 64
): PixelBuffer {
  const out = makeBuffer(docW, docH);
  processAffineTransformChunks(
    src,
    params,
    { x: 0, y: 0, width: docW, height: docH },
    chunkSize,
    (chunk, cx, cy, cw, ch) => {
      for (let y = 0; y < ch; y++) {
        const srcOff = y * cw * 4;
        const dstOff = ((cy + y) * docW + cx) * 4;
        out.data.set(chunk.subarray(srcOff, srcOff + cw * 4), dstOff);
      }
    }
  );
  return out;
}

describe('Transform Brush Stroke Quality Pipeline', () => {
  it('preserves straight-alpha anti-aliased stroke edges bit-identically on integer translate', () => {
    const src = makeBuffer(16, 16);
    // Low-alpha anti-aliased colored stroke edge pixels that Canvas2D premultiplication would corrupt
    setPx(src, 4, 5, 235, 92, 148, 7);
    setPx(src, 5, 5, 235, 92, 148, 128);
    setPx(src, 6, 5, 235, 92, 148, 255);
    setPx(src, 7, 5, 19, 211, 87, 3);

    const out = runAffineToBuffer(
      src,
      { x: 10, y: 12, width: 16, height: 16, rotation: 0, flipH: false, flipV: false },
      48,
      48
    );

    expect(getPx(out, 14, 17)).toEqual([235, 92, 148, 7]);
    expect(getPx(out, 15, 17)).toEqual([235, 92, 148, 128]);
    expect(getPx(out, 16, 17)).toEqual([235, 92, 148, 255]);
    expect(getPx(out, 17, 17)).toEqual([19, 211, 87, 3]);
    expect(getPx(out, 4, 5)).toEqual([0, 0, 0, 0]);
  });

  it('performs bit-exact 90/180/270 rotations and flips on odd x even dimensions with zero 0.5px blur', () => {
    // Odd width (25) x even height (24): previously caused a 0.5px shift blur on 90/270 rotations
    const src = makeBuffer(25, 24);
    for (let x = 2; x <= 22; x++) {
      setPx(src, x, 10, 20, 40, 220, 255);
    }

    const spec90 = resolveLosslessAffineSpec(25, 24, {
      x: 10,
      y: 10,
      width: 25,
      height: 24,
      rotation: 90,
      flipH: false,
      flipV: false,
    });
    expect(spec90).not.toBeNull();
    expect(spec90!.destWidth).toBe(24);
    expect(spec90!.destHeight).toBe(25);

    const out90 = runAffineToBuffer(
      src,
      { x: 10, y: 10, width: 25, height: 24, rotation: 90, flipH: false, flipV: false },
      64,
      64
    );

    // Every single stroke pixel must remain crisp alpha=255 with zero partial-alpha blur pixels
    let opaqueCount = 0;
    let semiAlphaCount = 0;
    for (let i = 3; i < out90.data.length; i += 4) {
      if (out90.data[i] === 255) opaqueCount++;
      else if (out90.data[i] > 0) semiAlphaCount++;
    }
    expect(opaqueCount).toBe(21);
    expect(semiAlphaCount).toBe(0);

    // 4 consecutive 90-degree rotations around the same integer box must stay 100% lossless
    const out180 = runAffineToBuffer(
      src,
      { x: 10, y: 10, width: 25, height: 24, rotation: 180, flipH: true, flipV: false },
      64,
      64
    );
    let opaque180 = 0;
    let semi180 = 0;
    for (let i = 3; i < out180.data.length; i += 4) {
      if (out180.data[i] === 255) opaque180++;
      else if (out180.data[i] > 0) semi180++;
    }
    expect(opaque180).toBe(21);
    expect(semi180).toBe(0);
  });

  it('keeps rotated bright colored strokes crisp without dark premultiply fringing or alpha halos', () => {
    const src = makeBuffer(64, 64);
    // Crisp 4px-wide bright yellow brush stroke on transparent background
    for (let x = 12; x <= 52; x++) {
      for (let y = 30; y <= 33; y++) {
        setPx(src, x, y, 255, 240, 40, 255);
      }
    }

    const out = runAffineToBuffer(
      src,
      { x: 10, y: 10, width: 64, height: 64, rotation: 23, flipH: false, flipV: false },
      96,
      96
    );

    let peakAlpha = 0;
    let strongCorePixels = 0;
    let minYellowRedOnVisibleEdge = 255;

    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 96; x++) {
        const [r, g, b, a] = getPx(out, x, y);
        if (a > peakAlpha) peakAlpha = a;
        if (a >= 250) strongCorePixels++;
        if (a >= 20) {
          // Straight-alpha RGB on anti-aliased edges must NOT darken toward black
          if (r < minYellowRedOnVisibleEdge) minYellowRedOnVisibleEdge = r;
          expect(g).toBeGreaterThanOrEqual(230);
          expect(b).toBeLessThanOrEqual(50);
        }
      }
    }

    expect(peakAlpha).toBe(255);
    expect(strongCorePixels).toBeGreaterThan(70);
    expect(minYellowRedOnVisibleEdge).toBeGreaterThanOrEqual(245);
  });

  it('upscales high-contrast strokes cleanly with Anti-Ringing Lanczos-3 (zero overshoot halo)', () => {
    // Black stroke drawn over opaque white paper
    const src = makeBuffer(32, 32);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const isStroke = x >= 14 && x <= 17 && y >= 6 && y <= 25;
        if (isStroke) setPx(src, x, y, 20, 20, 20, 255);
        else setPx(src, x, y, 240, 240, 240, 255);
      }
    }

    // 2.5x upscale (32 -> 80)
    const out = runAffineToBuffer(
      src,
      { x: 0, y: 0, width: 80, height: 80, rotation: 0, flipH: false, flipV: false },
      80,
      80
    );

    // Anti-ringing clamp ensures no pixel overshoots above 240 (white bg) or below 20 (ink)
    let minVal = 255;
    let maxVal = 0;
    for (let y = 10; y < 70; y++) {
      for (let x = 10; x < 70; x++) {
        const [r, , , a] = getPx(out, x, y);
        expect(a).toBe(255);
        if (r < minVal) minVal = r;
        if (r > maxVal) maxVal = r;
      }
    }
    expect(minVal).toBeGreaterThanOrEqual(20);
    expect(maxVal).toBeLessThanOrEqual(240);

    // Verify sharp transition across the stroke edge (center of stroke stays dark = 20)
    expect(getPx(out, 40, 40)[0]).toBe(20);
    // Surrounding paper stays clean = 240 (zero ringing dip!)
    expect(getPx(out, 20, 40)[0]).toBe(240);
  });

  it('preserves continuity of thin 2px brush strokes across heavy 4x and 6x downscaling', () => {
    const src = makeBuffer(240, 240);
    // Draw a crisp 2px-wide horizontal black line across y = 120..121
    for (let x = 16; x < 224; x++) {
      setPx(src, x, 120, 0, 0, 0, 255);
      setPx(src, x, 121, 0, 0, 0, 255);
    }

    // 4x downscale (240 -> 60)
    const out4x = runAffineToBuffer(
      src,
      { x: 0, y: 0, width: 60, height: 60, rotation: 0, flipH: false, flipV: false },
      60,
      60
    );
    // Every column along the scaled stroke (x = 8..52) must have continuous visible ink
    for (let x = 8; x <= 52; x++) {
      let colMaxAlpha = 0;
      for (let y = 26; y <= 34; y++) {
        colMaxAlpha = Math.max(colMaxAlpha, getPx(out4x, x, y)[3]);
      }
      expect(colMaxAlpha).toBeGreaterThanOrEqual(90);
    }

    // 6x downscale (240 -> 40, exercises separable 1D pre-downsampler)
    const out6x = runAffineToBuffer(
      src,
      { x: 0, y: 0, width: 40, height: 40, rotation: 0, flipH: false, flipV: false },
      40,
      40
    );
    for (let x = 6; x <= 34; x++) {
      let colMaxAlpha = 0;
      for (let y = 16; y <= 24; y++) {
        colMaxAlpha = Math.max(colMaxAlpha, getPx(out6x, x, y)[3]);
      }
      expect(colMaxAlpha).toBeGreaterThanOrEqual(60);
    }
  });

  it('commits Perspective Quad losslessly on identity shift and crisply on projective warp', () => {
    const src = makeBuffer(32, 32);
    for (let x = 6; x <= 26; x++) {
      setPx(src, x, 15, 255, 80, 120, 255);
      setPx(src, x, 16, 255, 80, 120, 15);
    }

    // Exact integer translation quad -> bit-exact lossless copy
    const outId = makeBuffer(64, 64);
    processPerspectiveTransformChunks(
      src,
      [
        { x: 10, y: 12 },
        { x: 42, y: 12 },
        { x: 42, y: 44 },
        { x: 10, y: 44 },
      ],
      { x: 0, y: 0, width: 64, height: 64 },
      64,
      16,
      (chunk, cx, cy, cw, ch) => {
        for (let y = 0; y < ch; y++) {
          outId.data.set(chunk.subarray(y * cw * 4, (y + 1) * cw * 4), ((cy + y) * 64 + cx) * 4);
        }
      }
    );
    expect(getPx(outId, 16, 27)).toEqual([255, 80, 120, 255]);
    expect(getPx(outId, 16, 28)).toEqual([255, 80, 120, 15]);

    // Projective perspective warp (keystone taper)
    const outPersp = makeBuffer(80, 80);
    processPerspectiveTransformChunks(
      src,
      [
        { x: 16, y: 10 },
        { x: 64, y: 14 },
        { x: 70, y: 66 },
        { x: 10, y: 62 },
      ],
      { x: 0, y: 0, width: 80, height: 80 },
      64,
      16,
      (chunk, cx, cy, cw, ch) => {
        for (let y = 0; y < ch; y++) {
          outPersp.data.set(chunk.subarray(y * cw * 4, (y + 1) * cw * 4), ((cy + y) * 80 + cx) * 4);
        }
      }
    );

    let peakA = 0;
    for (let i = 3; i < outPersp.data.length; i += 4) {
      if (outPersp.data[i] > peakA) peakA = outPersp.data[i];
    }
    expect(peakA).toBe(255);
  });

  it('restores the user brush preset cleanly when leaving Transform after Eraser', () => {
    toolStoreActions.selectTool('brush');
    const originalPreset = useToolStore.getState().brushSettings.preset;

    // Switch to eraser, then enter transform via setToolRaw('transform')
    toolStoreActions.selectTool('eraser');
    expect(useToolStore.getState().brushSettings.preset).toBe(ERASER_PRESET_ID);
    toolStoreActions.setToolRaw('transform');

    // Exiting transform via selectTool('brush') must restore the user's real brush preset
    toolStoreActions.selectTool('brush');
    expect(useToolStore.getState().tool).toBe('brush');
    expect(useToolStore.getState().brushSettings.preset).toBe(originalPreset);
  });

  it('commits lossless affine pixels directly to SparseTileGrid with exact straight alpha', () => {
    const grid = new SparseTileGrid();
    const src = makeBuffer(20, 20);
    setPx(src, 5, 5, 180, 60, 240, 11);
    setPx(src, 6, 5, 180, 60, 240, 255);

    processAffineTransformChunks(
      src,
      { x: 30, y: 40, width: 20, height: 20, rotation: 0, flipH: false, flipV: false },
      { x: 28, y: 38, width: 24, height: 24 },
      64,
      (chunk, cx, cy, cw, ch) => {
        grid.compositeStrokeToTiles({
          layerId: 'layer-1',
          strokeData: { data: chunk, width: cw, height: ch },
          destX: cx,
          destY: cy,
          format: 'color-32bit',
          compositeOp: 'source-over',
          opacity: 1.0,
          suppressNotify: true,
        });
      }
    );

    expect(Array.from(grid.getPixelRGBA('layer-1', 35, 45))).toEqual([180, 60, 240, 11]);
    expect(Array.from(grid.getPixelRGBA('layer-1', 36, 45))).toEqual([180, 60, 240, 255]);
  });
});
