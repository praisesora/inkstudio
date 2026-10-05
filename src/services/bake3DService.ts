import * as THREE from 'three';
import { LayerItem, BlendMode } from '../types/editor';
import { multiplayerService } from './multiplayerService';
import { applyScreentoneCPU } from '../utils/screentoneEngine';

export interface Bake3DOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  dimensions: { width: number; height: number };
  activeRenderer?: THREE.WebGLRenderer | null;
  layerName?: string;
  opacity?: number;
  blendMode?: BlendMode;
  onInsertLayer?: (layer: LayerItem, canvas: HTMLCanvasElement) => void;
  onBroadcastLayer?: (layer: LayerItem, dataUrl: string) => void;
}

export interface Bake3DResult {
  layer: LayerItem;
  canvas: HTMLCanvasElement;
  dataUrl: string;
}

/**
 * Traverses a material and releases any associated GPU texture memory.
 */
function disposeMaterialTextures(material: THREE.Material): void {
  const mat = material as any;
  for (const key of Object.keys(mat)) {
    const val = mat[key];
    if (val && typeof val === 'object' && val.isTexture && typeof val.dispose === 'function') {
      val.dispose();
    }
  }
  material.dispose();
}

/**
 * Aggressive recursive memory deallocation for Three.js scene graphs,
 * geometries, textures, materials, and WebGL rendering contexts.
 */
export function disposeThreeResources(
  scene?: THREE.Scene | THREE.Object3D | null,
  renderer?: THREE.WebGLRenderer | null
): void {
  if (scene) {
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        if (mesh.geometry) {
          mesh.geometry.dispose();
        }
        if (mesh.material) {
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => disposeMaterialTextures(m));
          } else {
            disposeMaterialTextures(mesh.material);
          }
        }
      }

      const line = obj as THREE.Line;
      if (line.isLine && line.geometry) {
        line.geometry.dispose();
      }

      const points = obj as THREE.Points;
      if (points.isPoints && points.geometry) {
        points.geometry.dispose();
      }
    });

    while (scene.children.length > 0) {
      scene.remove(scene.children[0]);
    }
  }

  if (renderer) {
    renderer.dispose();
  }

  if (typeof THREE.Cache !== 'undefined') {
    THREE.Cache.clear();
  }
}

/**
 * Captures the 3D scene from the current camera projection at target document resolution,
 * writes the rendered frame buffer directly into a standard 2D canvas layer, disposes of all 3D memory,
 * and broadcasts the flattened 2D layer to multiplayer peers.
 */
export async function bake3DToRasterLayer(options: Bake3DOptions): Promise<Bake3DResult> {
  const {
    scene,
    camera,
    dimensions,
    activeRenderer,
    layerName = '3D Layer',
    opacity = 1,
    blendMode = 'normal',
    onInsertLayer,
    onBroadcastLayer,
  } = options;

  const targetWidth = Math.max(1, Math.round(dimensions.width));
  const targetHeight = Math.max(1, Math.round(dimensions.height));

  // 1. Off-screen render buffer matching target document resolution and aspect ratio
  const offscreenRenderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });

  // Clamp offscreen renderer size to GPU maximum texture capability to avoid GL_OUT_OF_MEMORY
  const maxGlSize = offscreenRenderer.capabilities.maxTextureSize || 4096;
  let renderWidth = targetWidth;
  let renderHeight = targetHeight;
  if (renderWidth > maxGlSize || renderHeight > maxGlSize) {
    const scale = maxGlSize / Math.max(renderWidth, renderHeight);
    renderWidth = Math.max(1, Math.round(renderWidth * scale));
    renderHeight = Math.max(1, Math.round(renderHeight * scale));
  }

  offscreenRenderer.setSize(renderWidth, renderHeight, false);
  offscreenRenderer.setPixelRatio(1);
  offscreenRenderer.setClearColor(0x000000, 0);

  // Synchronize camera projection aspect ratio with document geometry
  const renderCamera = camera.clone();
  if ('aspect' in renderCamera) {
    (renderCamera as THREE.PerspectiveCamera).aspect = targetWidth / targetHeight;
    (renderCamera as THREE.PerspectiveCamera).updateProjectionMatrix();
  } else if ('left' in renderCamera) {
    (renderCamera as THREE.OrthographicCamera).updateProjectionMatrix();
  }

  offscreenRenderer.render(scene, renderCamera);

  // 2. Transfer WebGL frame buffer to standard 2D document layer
  const rasterCanvas = document.createElement('canvas');
  rasterCanvas.width = targetWidth;
  rasterCanvas.height = targetHeight;

  const ctx = rasterCanvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) {
    disposeThreeResources(null, offscreenRenderer);
    throw new Error('Unable to create 2D canvas context for 3D rasterization');
  }

  ctx.drawImage(offscreenRenderer.domElement, 0, 0, targetWidth, targetHeight);
  const dataUrl = rasterCanvas.toDataURL('image/png');

  // 3. Immediate Memory Cleanup: Free WebGL contexts, VRAM buffers, and scene graph
  disposeThreeResources(scene, offscreenRenderer);
  if (activeRenderer) {
    disposeThreeResources(null, activeRenderer);
  }

  // 4. Construct standard document raster layer
  const layerId = `raster-3d-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const layer: LayerItem = {
    id: layerId,
    name: layerName,
    type: 'raster',
    visible: true,
    opacity,
    blendMode,
    locked: false,
    collapsed: false,
    parentId: null,
    thumbnailUrl: dataUrl,
  };

  // Local insertion into layer manager
  if (onInsertLayer) {
    onInsertLayer(layer, rasterCanvas);
  }

  // 5. Multiplayer Broadcast: Send standard 2D raster pixels, zero 3D overhead
  if (onBroadcastLayer) {
    onBroadcastLayer(layer, dataUrl);
  } else if (multiplayerService.isConnected()) {
    multiplayerService.sendLayerAdd(layer, dataUrl);
  }

  return { layer, canvas: rasterCanvas, dataUrl };
}

export interface Bake3DLTOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  dimensions: { width: number; height: number };
  activeRenderer?: THREE.WebGLRenderer | null;
  baseLayerName?: string;
  lineThreshold?: number; // 0.15 to 0.6 (default: 0.28)
  toneBands?: 2 | 3; // 2 or 3 bands (default: 2)
  toneFrequencies?: [number, number]; // Lines per inch [shadow, midtone]
  toneAngles?: [number, number]; // Halftone grid angles [shadow, midtone]
  toneDensities?: [number, number]; // Density percentage [shadow, midtone]
  disposeOnComplete?: boolean;
  onInsertLayers?: (layers: LayerItem[], canvases: HTMLCanvasElement[]) => void;
  onBroadcastLayer?: (layer: LayerItem, dataUrl: string) => void;
}

export interface Bake3DLTResult {
  lineLayer: LayerItem;
  lineCanvas: HTMLCanvasElement;
  toneLayers: LayerItem[];
  toneCanvases: HTMLCanvasElement[];
}

const isLittleEndian = (() => {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = 0x11223344;
  return new Uint8Array(buf)[0] === 0x44;
})();
const SOLID_BLACK_U32 = isLittleEndian ? 0xff000000 : 0x000000ff;

/**
 * 3D LT Line & Screentone Extraction (3D-to-2D line extraction).
 *
 * Renders custom depth, normal, and diffuse passes from the 3D scene, runs a Sobel
 * edge-detection filter for crisp black lineart, and quantizes diffuse lighting into
 * 2 or 3 luminance bands converted to manga screentone layers via screentoneEngine.
 */
export async function bake3DToLineAndTone(options: Bake3DLTOptions): Promise<Bake3DLTResult> {
  const {
    scene,
    camera,
    dimensions,
    activeRenderer,
    baseLayerName = '3D',
    lineThreshold = 0.28,
    toneBands = 2,
    toneFrequencies = [55, 60],
    toneAngles = [45, 60],
    toneDensities = [0.45, 0.2],
    disposeOnComplete = true,
    onInsertLayers,
    onBroadcastLayer,
  } = options;

  const targetWidth = Math.max(1, Math.round(dimensions.width));
  const targetHeight = Math.max(1, Math.round(dimensions.height));

  const offscreenRenderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });

  const maxGlSize = offscreenRenderer.capabilities.maxTextureSize || 4096;
  let renderWidth = targetWidth;
  let renderHeight = targetHeight;
  if (renderWidth > maxGlSize || renderHeight > maxGlSize) {
    const scale = maxGlSize / Math.max(renderWidth, renderHeight);
    renderWidth = Math.max(1, Math.round(renderWidth * scale));
    renderHeight = Math.max(1, Math.round(renderHeight * scale));
  }

  offscreenRenderer.setSize(renderWidth, renderHeight, false);
  offscreenRenderer.setPixelRatio(1);
  offscreenRenderer.setClearColor(0x000000, 0);

  const renderCamera = camera.clone();
  if ('aspect' in renderCamera) {
    (renderCamera as THREE.PerspectiveCamera).aspect = targetWidth / targetHeight;
    (renderCamera as THREE.PerspectiveCamera).updateProjectionMatrix();
  } else if ('left' in renderCamera) {
    (renderCamera as THREE.OrthographicCamera).updateProjectionMatrix();
  }

  // Preserve original mesh materials for safe restoration
  const savedMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      savedMaterials.set(mesh, mesh.material);
    }
  });

  // Helper to capture offscreen WebGL buffer to 2D canvas imageData
  const captureRenderPass = (): Uint8ClampedArray => {
    const canvas = document.createElement('canvas');
    canvas.width = renderWidth;
    canvas.height = renderHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Failed to acquire 2D context for pass extraction');
    ctx.drawImage(offscreenRenderer.domElement, 0, 0, renderWidth, renderHeight);
    return ctx.getImageData(0, 0, renderWidth, renderHeight).data;
  };

  // 1. Normal Pass
  const normalMat = new THREE.MeshNormalMaterial();
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.material = normalMat;
    }
  });
  offscreenRenderer.render(scene, renderCamera);
  const normalData = captureRenderPass();

  // 2. Depth Pass
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.material = depthMat;
    }
  });
  offscreenRenderer.render(scene, renderCamera);
  const depthData = captureRenderPass();

  // 3. Diffuse Lighting Pass (restore original materials)
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && savedMaterials.has(mesh)) {
      mesh.material = savedMaterials.get(mesh)!;
    }
  });
  offscreenRenderer.render(scene, renderCamera);
  const diffuseData = captureRenderPass();

  // 4. Sobel Edge Detection Filter
  const lineCanvas = document.createElement('canvas');
  lineCanvas.width = targetWidth;
  lineCanvas.height = targetHeight;

  const tempLineCanvas = document.createElement('canvas');
  tempLineCanvas.width = renderWidth;
  tempLineCanvas.height = renderHeight;
  const tempLineCtx = tempLineCanvas.getContext('2d')!;
  const lineImageData = tempLineCtx.createImageData(renderWidth, renderHeight);
  const lineData32 = new Uint32Array(lineImageData.data.buffer);

  const w = renderWidth;
  const h = renderHeight;

  for (let y = 1; y < h - 1; y++) {
    const rowOffset = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = (rowOffset + x) * 4;
      const alpha = normalData[idx + 3];

      if (alpha === 0) continue; // background

      // Check outer silhouette against 4-neighborhood
      const leftA = normalData[(rowOffset + x - 1) * 4 + 3];
      const rightA = normalData[(rowOffset + x + 1) * 4 + 3];
      const topA = normalData[((y - 1) * w + x) * 4 + 3];
      const bottomA = normalData[((y + 1) * w + x) * 4 + 3];

      if (leftA === 0 || rightA === 0 || topA === 0 || bottomA === 0) {
        lineData32[rowOffset + x] = SOLID_BLACK_U32;
        continue;
      }

      // Sobel operator on Normal components
      // Row -1
      const n00_r = normalData[((y - 1) * w + (x - 1)) * 4];
      const n00_g = normalData[((y - 1) * w + (x - 1)) * 4 + 1];
      const n00_b = normalData[((y - 1) * w + (x - 1)) * 4 + 2];
      const n10_r = normalData[((y - 1) * w + x) * 4];
      const n10_g = normalData[((y - 1) * w + x) * 4 + 1];
      const n10_b = normalData[((y - 1) * w + x) * 4 + 2];
      const n20_r = normalData[((y - 1) * w + (x + 1)) * 4];
      const n20_g = normalData[((y - 1) * w + (x + 1)) * 4 + 1];
      const n20_b = normalData[((y - 1) * w + (x + 1)) * 4 + 2];

      // Row 0
      const n01_r = normalData[(rowOffset + (x - 1)) * 4];
      const n01_g = normalData[(rowOffset + (x - 1)) * 4 + 1];
      const n01_b = normalData[(rowOffset + (x - 1)) * 4 + 2];
      const n21_r = normalData[(rowOffset + (x + 1)) * 4];
      const n21_g = normalData[(rowOffset + (x + 1)) * 4 + 1];
      const n21_b = normalData[(rowOffset + (x + 1)) * 4 + 2];

      // Row +1
      const n02_r = normalData[((y + 1) * w + (x - 1)) * 4];
      const n02_g = normalData[((y + 1) * w + (x - 1)) * 4 + 1];
      const n02_b = normalData[((y + 1) * w + (x - 1)) * 4 + 2];
      const n12_r = normalData[((y + 1) * w + x) * 4];
      const n12_g = normalData[((y + 1) * w + x) * 4 + 1];
      const n12_b = normalData[((y + 1) * w + x) * 4 + 2];
      const n22_r = normalData[((y + 1) * w + (x + 1)) * 4];
      const n22_g = normalData[((y + 1) * w + (x + 1)) * 4 + 1];
      const n22_b = normalData[((y + 1) * w + (x + 1)) * 4 + 2];

      const gx_r = -n00_r + n20_r - 2 * n01_r + 2 * n21_r - n02_r + n22_r;
      const gy_r = -n00_r - 2 * n10_r - n20_r + n02_r + 2 * n12_r + n22_r;

      const gx_g = -n00_g + n20_g - 2 * n01_g + 2 * n21_g - n02_g + n22_g;
      const gy_g = -n00_g - 2 * n10_g - n20_g + n02_g + 2 * n12_g + n22_g;

      const gx_b = -n00_b + n20_b - 2 * n01_b + 2 * n21_b - n02_b + n22_b;
      const gy_b = -n00_b - 2 * n10_b - n20_b + n02_b + 2 * n12_b + n22_b;

      const normEdge = Math.hypot(gx_r, gy_r) + Math.hypot(gx_g, gy_g) + Math.hypot(gx_b, gy_b);

      // Sobel operator on Depth
      const d00 = depthData[((y - 1) * w + (x - 1)) * 4];
      const d10 = depthData[((y - 1) * w + x) * 4];
      const d20 = depthData[((y - 1) * w + (x + 1)) * 4];
      const d01 = depthData[(rowOffset + (x - 1)) * 4];
      const d21 = depthData[(rowOffset + (x + 1)) * 4];
      const d02 = depthData[((y + 1) * w + (x - 1)) * 4];
      const d12 = depthData[((y + 1) * w + x) * 4];
      const d22 = depthData[((y + 1) * w + (x + 1)) * 4];

      const gx_d = -d00 + d20 - 2 * d01 + 2 * d21 - d02 + d22;
      const gy_d = -d00 - 2 * d10 - d20 + d02 + 2 * d12 + d22;
      const depthEdge = Math.hypot(gx_d, gy_d);

      const totalEdge = (normEdge / 255.0) * 0.45 + (depthEdge / 255.0) * 2.2;

      if (totalEdge > lineThreshold) {
        lineData32[rowOffset + x] = SOLID_BLACK_U32;
      }
    }
  }

  tempLineCtx.putImageData(lineImageData, 0, 0);
  const lineCtx = lineCanvas.getContext('2d')!;
  lineCtx.drawImage(tempLineCanvas, 0, 0, targetWidth, targetHeight);

  // 5. Diffuse Lighting Quantization into 2 or 3 luminance bands
  const maskCanvasShadow = document.createElement('canvas');
  maskCanvasShadow.width = renderWidth;
  maskCanvasShadow.height = renderHeight;
  const shadowCtx = maskCanvasShadow.getContext('2d')!;
  const shadowImageData = shadowCtx.createImageData(renderWidth, renderHeight);
  const shadowData32 = new Uint32Array(shadowImageData.data.buffer);

  let maskCanvasMidtone: HTMLCanvasElement | null = null;
  let midtoneCtx: CanvasRenderingContext2D | null = null;
  let midtoneImageData: ImageData | null = null;
  let midtoneData32: Uint32Array | null = null;

  if (toneBands === 3) {
    maskCanvasMidtone = document.createElement('canvas');
    maskCanvasMidtone.width = renderWidth;
    maskCanvasMidtone.height = renderHeight;
    midtoneCtx = maskCanvasMidtone.getContext('2d')!;
    midtoneImageData = midtoneCtx.createImageData(renderWidth, renderHeight);
    midtoneData32 = new Uint32Array(midtoneImageData.data.buffer);
  }

  for (let i = 0; i < renderWidth * renderHeight; i++) {
    const pIdx = i * 4;
    const a = diffuseData[pIdx + 3];
    if (a === 0 || lineData32[i] !== 0) continue; // skip background and lineart

    const r = diffuseData[pIdx];
    const g = diffuseData[pIdx + 1];
    const b = diffuseData[pIdx + 2];
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;

    if (toneBands === 2) {
      if (lum < 0.54) {
        shadowData32[i] = SOLID_BLACK_U32;
      }
    } else {
      if (lum < 0.35) {
        shadowData32[i] = SOLID_BLACK_U32;
      } else if (lum < 0.72 && midtoneData32) {
        midtoneData32[i] = SOLID_BLACK_U32;
      }
    }
  }

  shadowCtx.putImageData(shadowImageData, 0, 0);
  if (midtoneCtx && midtoneImageData) {
    midtoneCtx.putImageData(midtoneImageData, 0, 0);
  }

  // 6. Convert diffuse bands to manga screentone layers using screentoneEngine
  const toneCanvases: HTMLCanvasElement[] = [];
  const toneLayers: LayerItem[] = [];

  // Shadow Screentone Layer
  const shadowToneRenderCanvas = document.createElement('canvas');
  shadowToneRenderCanvas.width = renderWidth;
  shadowToneRenderCanvas.height = renderHeight;
  applyScreentoneCPU(maskCanvasShadow, shadowToneRenderCanvas, {
    frequency: toneFrequencies[0],
    angle: toneAngles[0],
    specifiedDensity: toneDensities[0],
    densityType: 'specified',
    dpi: 600,
    antiAliasing: true,
  });

  const finalShadowCanvas = document.createElement('canvas');
  finalShadowCanvas.width = targetWidth;
  finalShadowCanvas.height = targetHeight;
  const fShadowCtx = finalShadowCanvas.getContext('2d')!;
  fShadowCtx.drawImage(shadowToneRenderCanvas, 0, 0, targetWidth, targetHeight);
  toneCanvases.push(finalShadowCanvas);

  const shadowDataUrl = finalShadowCanvas.toDataURL('image/png');
  const shadowLayer: LayerItem = {
    id: `raster-lt-shadow-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    name: `${baseLayerName} Shadow Tone (LT)`,
    type: 'raster',
    visible: true,
    opacity: 1,
    blendMode: 'multiply',
    locked: false,
    collapsed: false,
    parentId: null,
    thumbnailUrl: shadowDataUrl,
    toneEnabled: true,
    toneFrequency: toneFrequencies[0],
    toneAngle: toneAngles[0],
    toneDensity: Math.round(toneDensities[0] * 100),
    toneDensityType: 'specified',
  };
  toneLayers.push(shadowLayer);

  // Optional Midtone Screentone Layer (for 3 bands)
  if (toneBands === 3 && maskCanvasMidtone) {
    const midToneRenderCanvas = document.createElement('canvas');
    midToneRenderCanvas.width = renderWidth;
    midToneRenderCanvas.height = renderHeight;
    applyScreentoneCPU(maskCanvasMidtone, midToneRenderCanvas, {
      frequency: toneFrequencies[1],
      angle: toneAngles[1],
      specifiedDensity: toneDensities[1],
      densityType: 'specified',
      dpi: 600,
      antiAliasing: true,
    });

    const finalMidtoneCanvas = document.createElement('canvas');
    finalMidtoneCanvas.width = targetWidth;
    finalMidtoneCanvas.height = targetHeight;
    const fMidtoneCtx = finalMidtoneCanvas.getContext('2d')!;
    fMidtoneCtx.drawImage(midToneRenderCanvas, 0, 0, targetWidth, targetHeight);
    toneCanvases.push(finalMidtoneCanvas);

    const midtoneDataUrl = finalMidtoneCanvas.toDataURL('image/png');
    const midtoneLayer: LayerItem = {
      id: `raster-lt-midtone-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      name: `${baseLayerName} Midtone Tone (LT)`,
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'multiply',
      locked: false,
      collapsed: false,
      parentId: null,
      thumbnailUrl: midtoneDataUrl,
      toneEnabled: true,
      toneFrequency: toneFrequencies[1],
      toneAngle: toneAngles[1],
      toneDensity: Math.round(toneDensities[1] * 100),
      toneDensityType: 'specified',
    };
    toneLayers.push(midtoneLayer);
  }

  // 7. Lineart Layer
  const lineDataUrl = lineCanvas.toDataURL('image/png');
  const lineLayer: LayerItem = {
    id: `raster-lt-line-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    name: `${baseLayerName} Lineart (LT)`,
    type: 'raster',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    locked: false,
    collapsed: false,
    parentId: null,
    thumbnailUrl: lineDataUrl,
  };

  // Clean up WebGL resources
  if (disposeOnComplete) {
    disposeThreeResources(scene, offscreenRenderer);
    if (activeRenderer) {
      disposeThreeResources(null, activeRenderer);
    }
  } else {
    offscreenRenderer.dispose();
  }

  const allLayers = [...toneLayers, lineLayer];
  const allCanvases = [...toneCanvases, lineCanvas];

  if (onInsertLayers) {
    onInsertLayers(allLayers, allCanvases);
  }

  if (onBroadcastLayer) {
    onBroadcastLayer(lineLayer, lineDataUrl);
    toneLayers.forEach((l, i) => onBroadcastLayer(l, toneCanvases[i].toDataURL('image/png')));
  } else if (multiplayerService.isConnected()) {
    multiplayerService.sendLayerAdd(lineLayer, lineDataUrl);
    toneLayers.forEach((l, i) => multiplayerService.sendLayerAdd(l, toneCanvases[i].toDataURL('image/png')));
  }

  return {
    lineLayer,
    lineCanvas,
    toneLayers,
    toneCanvases,
  };
}
