import { describe, expect, it } from 'vitest';
import {
  buildExportableBrush,
  parseInkbFile,
  sanitizeBrushFileName,
  serializeInkbBrush,
} from '../inkbBrushFormat';
import type { CspBrush } from '../../types/editor';

const SAMPLE_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('inkbBrushFormat', () => {
  it('round-trips a custom brush with tips, curves, and dynamics through .inkb archive', () => {
    const original: CspBrush = {
      id: 'csp-test-1',
      name: 'Ink G-Pen Pro',
      badge: 'INKB',
      desc: 'Sharp manga inking pen',
      tipDataUrl: SAMPLE_PNG_DATA_URL,
      tipWidth: 1,
      tipHeight: 1,
      subTips: [{ dataUrl: SAMPLE_PNG_DATA_URL, width: 1, height: 1, isColor: false }],
      subTipOrder: 'random',
      size: 18,
      minSizeFactor: 0.08,
      opacity: 0.95,
      flow: 0.85,
      spacing: 0.04,
      hardness: 0.92,
      thickness: 0.8,
      angle: 15,
      angleDynamics: 'direction',
      usePressure: true,
      useTilt: true,
      tiltScale: 1.2,
      smoothing: true,
      stabilization: 22,
      pressureCurve: [
        [0, 0],
        [0.4, 0.25],
        [1, 1],
      ],
      colorMixing: true,
      amountOfPaint: 0.7,
      densityOfPaint: 0.8,
      colorStretch: 0.5,
      mixingMode: 'blend',
      wetEdge: 0.3,
      paperTexture: SAMPLE_PNG_DATA_URL,
      textureDensity: 0.4,
      taper: { useIn: true, inLength: 20, inRatio: 0.1, useOut: true, outLength: 30, outRatio: 0.05 },
      spray: { enabled: false, size: 12, density: 4, bias: 0 },
      importedAt: Date.now(),
    };

    const bytes = serializeInkbBrush(original);
    // Compressed ZIP magic header
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);

    const parsed = parseInkbFile(toArrayBuffer(bytes), 'Ink G-Pen Pro.inkb');
    expect(parsed.id.startsWith('inkb-')).toBe(true);
    expect(parsed.name).toBe('Ink G-Pen Pro');
    expect(parsed.size).toBe(18);
    expect(parsed.tipDataUrl).toBe(SAMPLE_PNG_DATA_URL);
    expect(parsed.paperTexture).toBe(SAMPLE_PNG_DATA_URL);
    expect(parsed.subTips?.length).toBe(1);
    expect(parsed.pressureCurve).toEqual(original.pressureCurve);
    expect(parsed.colorMixing).toBe(true);
    expect(parsed.wetEdge).toBe(0.3);
    expect(parsed.taper?.outLength).toBe(30);
  });

  it('builds exportable brush from built-in presets and sanitizes filenames to [brush].inkb', () => {
    const brush = buildExportableBrush('g-pen');
    expect(brush.name).toBeTruthy();
    expect(brush.size).toBeGreaterThan(0);

    expect(sanitizeBrushFileName('My Cool/Brush:1')).toBe('My Cool_Brush_1.inkb');
    expect(sanitizeBrushFileName('G-Pen.inkb')).toBe('G-Pen.inkb');
    expect(sanitizeBrushFileName('   ')).toBe('brush.inkb');
  });

  it('strips unsafe data URLs (SVG/JS) and clamps out-of-range numeric values', () => {
    const hostilePayload = JSON.stringify({
      format: 'inkb',
      version: 1,
      exportedAt: Date.now(),
      brush: {
        name: 'Hostile',
        size: 999999,
        opacity: -5,
        stabilization: 999,
        tipDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
        paperTexture: 'javascript:alert(1)',
        subTips: [{ dataUrl: 'https://evil.example/tip.png', width: 64, height: 64 }],
      },
    });
    const encoded = new TextEncoder().encode(hostilePayload);
    const parsed = parseInkbFile(toArrayBuffer(encoded), 'hostile.inkb');

    expect(parsed.size).toBe(2000);
    expect(parsed.opacity).toBe(0.01);
    expect(parsed.stabilization).toBe(50);
    expect(parsed.tipDataUrl).toBeUndefined();
    expect(parsed.paperTexture).toBeUndefined();
    expect(parsed.subTips).toBeUndefined();
  });

  it('rejects empty, corrupted, or wrong-format payloads', () => {
    expect(() => parseInkbFile(new ArrayBuffer(0))).toThrow();
    expect(() =>
      parseInkbFile(toArrayBuffer(new TextEncoder().encode('{"format":"other","version":1,"brush":{}}')))
    ).toThrow();
    expect(() =>
      parseInkbFile(toArrayBuffer(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff])))
    ).toThrow();
  });
});
