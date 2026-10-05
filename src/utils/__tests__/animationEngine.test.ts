import { describe, it, expect } from 'vitest';
import {
  createDefaultAnimationTimeline,
  setFrameCel,
  removeFrameCel,
  getOnionSkinFrames,
  renderAnimationFrame,
  exportAnimationToPngZip,
  exportAnimationToGif,
  exportAnimationToApng,
} from '../animationEngine';
import { LayerItem } from '../../types/editor';

const DUMMY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

class MockCanvas {
  width = 100;
  height = 100;
  getContext(_type: string) {
    return {
      clearRect: () => {},
      drawImage: () => {},
      fillRect: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
      }),
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      fillStyle: '#000000',
    };
  }
  toDataURL(_type = 'image/png') {
    return DUMMY_PNG_DATA_URL;
  }
}

if (typeof (globalThis as any).HTMLCanvasElement === 'undefined') {
  (globalThis as any).HTMLCanvasElement = MockCanvas;
}

if (typeof (globalThis as any).document === 'undefined') {
  (globalThis as any).document = {
    createElement: (tag: string) => {
      if (tag === 'canvas') return new MockCanvas();
      return {};
    },
    body: {
      appendChild: () => {},
      removeChild: () => {},
    },
  };
}

describe('2D Animation Engine & Export Pipeline', () => {
  const dummyLayer: LayerItem = {
    id: 'layer-1',
    name: 'Cel 1',
    type: 'raster',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    locked: false,
    collapsed: false,
    parentId: null,
  };

  it('initializes default timeline with proper onion skin settings', () => {
    const tl = createDefaultAnimationTimeline([dummyLayer]);
    expect(tl.fps).toBe(12);
    expect(tl.totalFrames).toBe(24);
    expect(tl.currentFrame).toBe(0);
    expect(tl.cels[0]).toBe('layer-1');
    expect(tl.onionSkin.enabled).toBe(true);
    expect(tl.onionSkin.prevTint).toBe('#00bcd4'); // Cyan
    expect(tl.onionSkin.nextTint).toBe('#ec4899'); // Magenta
  });

  it('maps and removes frame cels cleanly', () => {
    let tl = createDefaultAnimationTimeline();
    tl = setFrameCel(tl, 5, 'layer-cel-5');
    expect(tl.cels[5]).toBe('layer-cel-5');

    tl = removeFrameCel(tl, 5);
    expect(tl.cels[5]).toBeUndefined();
  });

  it('calculates progressive opacity falloff for colored onion skinning', () => {
    let tl = createDefaultAnimationTimeline();
    tl = setFrameCel(tl, 0, 'cel-0');
    tl = setFrameCel(tl, 1, 'cel-1');
    tl = setFrameCel(tl, 2, 'cel-2');
    tl = setFrameCel(tl, 3, 'cel-3');
    tl = setFrameCel(tl, 4, 'cel-4');

    // At frame 2, prev frames are 1 and 0, next frames are 3 and 4
    tl.currentFrame = 2;
    tl.onionSkin.prevFrames = 2;
    tl.onionSkin.nextFrames = 2;
    tl.onionSkin.opacity = 0.4;

    const onionFrames = getOnionSkinFrames(tl);
    expect(onionFrames.length).toBe(4);

    const prev1 = onionFrames.find((f) => f.frame === 1);
    const prev0 = onionFrames.find((f) => f.frame === 0);
    expect(prev1).toBeDefined();
    expect(prev0).toBeDefined();

    // Prior frame closest to current has higher opacity than furthest
    expect(prev1!.opacity).toBeGreaterThan(prev0!.opacity);
    expect(prev1!.tint).toBe('#00bcd4');

    const next3 = onionFrames.find((f) => f.frame === 3);
    const next4 = onionFrames.find((f) => f.frame === 4);
    expect(next3).toBeDefined();
    expect(next4).toBeDefined();
    expect(next3!.opacity).toBeGreaterThan(next4!.opacity);
    expect(next3!.tint).toBe('#ec4899');
  });

  it('renders a frame onto offscreen canvas', () => {
    const tl = createDefaultAnimationTimeline([dummyLayer]);
    const canvases = new Map<string, HTMLCanvasElement>();

    const c = document.createElement('canvas');
    c.width = 100;
    c.height = 100;
    canvases.set('layer-1', c);

    const rendered = renderAnimationFrame(0, tl, [dummyLayer], canvases, { width: 100, height: 100 }, false);
    expect(rendered).toBeInstanceOf(HTMLCanvasElement);
    expect(rendered.width).toBe(100);
    expect(rendered.height).toBe(100);
  });

  it('exports animation as a valid zipped numbered PNG sequence', async () => {
    const tl = createDefaultAnimationTimeline([dummyLayer]);
    tl.totalFrames = 3; // test 3 frames
    const canvases = new Map<string, HTMLCanvasElement>();
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    canvases.set('layer-1', c);

    const zipBlob = await exportAnimationToPngZip(tl, [dummyLayer], canvases, { width: 32, height: 32 });
    expect(zipBlob).toBeInstanceOf(Blob);
    expect(zipBlob.type).toBe('application/zip');
    expect(zipBlob.size).toBeGreaterThan(0);
  });

  it('exports animation as a valid animated GIF Blob', async () => {
    const tl = createDefaultAnimationTimeline([dummyLayer]);
    tl.totalFrames = 2;
    const canvases = new Map<string, HTMLCanvasElement>();
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    canvases.set('layer-1', c);

    const gifBlob = await exportAnimationToGif(tl, [dummyLayer], canvases, { width: 16, height: 16 });
    expect(gifBlob).toBeInstanceOf(Blob);
    expect(gifBlob.type).toBe('image/gif');
    expect(gifBlob.size).toBeGreaterThan(0);
  });

  it('exports animation as a valid Animated PNG (APNG) Blob', async () => {
    const tl = createDefaultAnimationTimeline([dummyLayer]);
    tl.totalFrames = 2;
    const canvases = new Map<string, HTMLCanvasElement>();
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    canvases.set('layer-1', c);

    const apngBlob = await exportAnimationToApng(tl, [dummyLayer], canvases, { width: 16, height: 16 });
    expect(apngBlob).toBeInstanceOf(Blob);
    expect(apngBlob.type).toBe('image/png');
    expect(apngBlob.size).toBeGreaterThan(0);
  });
});
