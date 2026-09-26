import * as THREE from 'three';
import { LayerItem, BlendMode } from '../types/editor';
import { multiplayerService } from './multiplayerService';

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
