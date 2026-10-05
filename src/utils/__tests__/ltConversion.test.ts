import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

function createMockCanvas(width = 64, height = 64) {
  const canvas: any = {
    width,
    height,
    getContext: () => ({
      createImageData: (w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      }),
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(w * h * 4);
        // Fill diffuse buffer with mid-gray (lum ~ 0.5) so tone layers trigger
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 100;
          data[i + 1] = 100;
          data[i + 2] = 100;
          data[i + 3] = 255;
        }
        return { width: w, height: h, data };
      },
      putImageData: () => {},
      drawImage: () => {},
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
});
