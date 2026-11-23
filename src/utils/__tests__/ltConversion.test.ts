import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

function createMockCanvas(width = 64, height = 64) {
  let pixels = new Uint8ClampedArray(width * height * 4);
  const canvas: any = {
    get width() {
      return width;
    },
    set width(v: number) {
      width = v;
      pixels = new Uint8ClampedArray(width * height * 4);
    },
    get height() {
      return height;
    },
    set height(v: number) {
      height = v;
      pixels = new Uint8ClampedArray(width * height * 4);
    },
    getData: () => pixels,
    getContext: () => ({
      imageSmoothingEnabled: true,
      createImageData: (w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      }),
      getImageData: (x: number, y: number, w: number, h: number) => {
        const out = new Uint8ClampedArray(w * h * 4);
        let hasAny = false;
        for (let i = 3; i < pixels.length; i += 4) {
          if (pixels[i] !== 0) {
            hasAny = true;
            break;
          }
        }
        if (!hasAny) {
          // Default diffuse buffer with two shadow bands: left half mid-gray (lum ~ 0.47), right half deep shadow (lum ~ 0.20)
          for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
              const i = (row * w + col) * 4;
              const v = col < w / 2 ? 120 : 50;
              out[i] = v;
              out[i + 1] = v;
              out[i + 2] = v;
              out[i + 3] = 255;
            }
          }
          return { width: w, height: h, data: out };
        }
        for (let row = 0; row < h; row++) {
          const srcStart = ((y + row) * width + x) * 4;
          out.set(pixels.subarray(srcStart, srcStart + w * 4), row * w * 4);
        }
        return { width: w, height: h, data: out };
      },
      putImageData: (img: ImageData, x: number, y: number) => {
        for (let row = 0; row < img.height; row++) {
          const dstStart = ((y + row) * width + x) * 4;
          const srcStart = row * img.width * 4;
          pixels.set(img.data.subarray(srcStart, srcStart + img.width * 4), dstStart);
        }
      },
      drawImage: (src: any) => {
        if (src && typeof src.getData === 'function') {
          const srcData: Uint8ClampedArray = src.getData();
          if (srcData.length === pixels.length) {
            pixels.set(srcData);
          }
        }
      },
      fillRect: () => {},
      clearRect: () => {},
    }),
    toDataURL: () => 'data:image/png;base64,mock',
  };
  return canvas;
}

(globalThis as any).document = {
  createElement: (tag: string) => {
    if (tag === 'canvas') return createMockCanvas(64, 64);
    return {};
  },
};

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>();
  class MockWebGLRenderer {
    capabilities = { maxTextureSize: 4096 };
    domElement: any;
    constructor() {
      this.domElement = createMockCanvas(64, 64);
    }
    setSize(w: number, h: number) {
      this.domElement.width = w;
      this.domElement.height = h;
    }
    setPixelRatio() {}
    setClearColor() {}
    setRenderTarget() {}
    clear() {}
    render() {}
    dispose() {}
  }
  return {
    ...actual,
    WebGLRenderer: MockWebGLRenderer,
  };
});

import { bake3DToLineAndTone } from '../../services/bake3DService';

describe('3D LT Conversion Service', () => {
  it('performs LT conversion, creating folder, "3D Outline", and screentoned shadow layers', async () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    scene.add(box);

    const onInsertLayers = vi.fn();

    const result = await bake3DToLineAndTone({
      scene,
      camera,
      dimensions: { width: 64, height: 64 },
      modelName: 'Building.obj',
      lineWidth: 2,
      lineThreshold: 0.28,
      toneCount: 2,
      onInsertLayers,
    });

    // 1. Outline Layer
    expect(result.lineLayer).toBeDefined();
    expect(result.lineLayer.name).toBe('3D Outline');
    expect(result.lineLayer.type).toBe('raster');
    expect(result.lineLayer.parentId).toBe(result.folderLayer.id);

    // 2. Folder Group Layer
    expect(result.folderLayer).toBeDefined();
    expect(result.folderLayer.type).toBe('folder');
    expect(result.folderLayer.name).toBe('3D Extraction [Building]');

    // 3. Screentoned Tone Layers
    expect(result.toneLayers.length).toBe(2);
    // Tier 1 (Light Shadow)
    expect(result.toneLayers[0].name).toBe('3D Tone 1 (Light)');
    expect(result.toneLayers[0].toneEnabled).toBe(true);
    expect(result.toneLayers[0].toneFrequency).toBe(60);
    expect(result.toneLayers[0].toneDensity).toBe(20);
    expect(result.toneLayers[0].parentId).toBe(result.folderLayer.id);

    // Tier 2 (Deep Shadow)
    expect(result.toneLayers[1].name).toBe('3D Tone 2 (Deep)');
    expect(result.toneLayers[1].toneEnabled).toBe(true);
    expect(result.toneLayers[1].toneFrequency).toBe(60);
    expect(result.toneLayers[1].toneDensity).toBe(45);
    expect(result.toneLayers[1].parentId).toBe(result.folderLayer.id);

    // 4. Callback execution with all layers and canvases
    expect(onInsertLayers).toHaveBeenCalledTimes(1);
    const [insertedLayers, insertedCanvases] = onInsertLayers.mock.calls[0];
    expect(insertedLayers.length).toBe(4); // folder + line + 2 tone layers
    expect(insertedCanvases.length).toBe(4);
    expect(insertedLayers[0].type).toBe('folder');
  });

  it('supports custom target folder names and 3 tone layers', async () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);

    const result = await bake3DToLineAndTone({
      scene,
      camera,
      dimensions: { width: 32, height: 32 },
      modelName: 'Mannequin',
      targetFolderName: 'Manga BG - Chapter 1',
      toneCount: 3,
    });

    expect(result.folderLayer.name).toBe('Manga BG - Chapter 1');
    expect(result.toneLayers.length).toBe(3);
    expect(result.toneLayers[0].toneDensity).toBe(15);
    expect(result.toneLayers[1].toneDensity).toBe(30);
    expect(result.toneLayers[2].toneDensity).toBe(50);
  });

  it('supports non-destructive previewOnly mode and outline-only extraction (toneCount = 0)', async () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    scene.add(mesh);

    const onInsertLayers = vi.fn();

    const previewRes = await bake3DToLineAndTone({
      scene,
      camera,
      dimensions: { width: 32, height: 32 },
      modelName: 'PreviewModel',
      toneCount: 0,
      previewOnly: true,
      onInsertLayers,
    });

    expect(onInsertLayers).not.toHaveBeenCalled();
    expect(previewRes.lineCanvas).toBeDefined();
    expect(previewRes.toneLayers.length).toBe(0);
    expect(previewRes.toneCanvases.length).toBe(0);
    // Scene graph must remain intact after previewOnly render
    expect(scene.children.length).toBe(1);
  });

  it('prevents double-screentoning, overlapping band moiré, and AA blur in extracted 3D LT layers', async () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    scene.add(mesh);

    const extracted = await bake3DToLineAndTone({
      scene,
      camera,
      dimensions: { width: 64, height: 64, dpi: 600 },
      modelName: 'CrispModel',
      toneCount: 2,
    });

    // Outline defaults to crisp monochrome (no AA gray smudges)
    expect(extracted.lineLayer.expressionColor).toBe('monochrome');

    // All tone tiers default to uniform 45° angle (no 45° vs 60° moiré interference)
    expect(extracted.toneLayers[0].toneAngle).toBe(45);
    expect(extracted.toneLayers[1].toneAngle).toBe(45);
    expect(extracted.toneLayers[0].toneDotShape).toBe('circle');
    expect(extracted.toneLayers[1].toneDotShape).toBe('circle');

    // Extracted tone layers store mutually exclusive solid masks (no pre-baked dots on toneEnabled layers!)
    const lightData: Uint8ClampedArray = (extracted.toneCanvases[0] as any).getData();
    const deepData: Uint8ClampedArray = (extracted.toneCanvases[1] as any).getData();

    let lightSolid = 0;
    let deepSolid = 0;
    let overlapCount = 0;
    for (let i = 0; i < 64 * 64; i++) {
      const aL = lightData[i * 4 + 3];
      const aD = deepData[i * 4 + 3];
      // Strictly binary solid mask pixels (0 or 255)
      expect(aL === 0 || aL === 255).toBe(true);
      expect(aD === 0 || aD === 255).toBe(true);
      if (aL === 255) lightSolid++;
      if (aD === 255) deepSolid++;
      if (aL === 255 && aD === 255) overlapCount++;
    }
    // Left half (32*64 = 2048 px) is light shadow, right half (2048 px) is deep shadow -> zero overlap!
    expect(lightSolid).toBe(32 * 64);
    expect(deepSolid).toBe(32 * 64);
    expect(overlapCount).toBe(0);

    // previewOnly renders crisp 1-bit binary halftone dots (strictly 0 or 255 alpha, no gray blur)
    const preview = await bake3DToLineAndTone({
      scene,
      camera,
      dimensions: { width: 64, height: 64, dpi: 600 },
      modelName: 'CrispModel',
      toneCount: 2,
      previewOnly: true,
    });
    const prevDeep: Uint8ClampedArray = (preview.toneCanvases[1] as any).getData();
    let prevBlack = 0;
    let prevEmptyInDeepRegion = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 32; x < 64; x++) {
        const a = prevDeep[(y * 64 + x) * 4 + 3];
        expect(a === 0 || a === 255).toBe(true);
        if (a === 255) prevBlack++;
        else prevEmptyInDeepRegion++;
      }
    }
    expect(prevBlack).toBeGreaterThan(0);
    expect(prevEmptyInDeepRegion).toBeGreaterThan(0);
  });
});
