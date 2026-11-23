import * as THREE from 'three';
import { LayerItem, BlendMode } from '../types/editor';
import { documentStore } from '../utils/documentStore';
import { performanceManager } from '../utils/performanceManager';
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
  disposeOnComplete?: boolean;
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

export interface SafeWebGLRendererOptions {
  canvas?: HTMLCanvasElement;
  alpha?: boolean;
  antialias?: boolean;
  preserveDrawingBuffer?: boolean;
  powerPreference?: WebGLPowerPreference;
}

function isWebGLContextLike(
  ctx: unknown
): ctx is WebGLRenderingContext | WebGL2RenderingContext {
  return (
    Boolean(ctx) &&
    typeof ctx === 'object' &&
    typeof (ctx as WebGLRenderingContext).getShaderPrecisionFormat === 'function'
  );
}

function hasUsableShaderPrecision(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
    return false;
  }
  try {
    const check = (shaderType: number): boolean =>
      gl.getShaderPrecisionFormat(shaderType, gl.HIGH_FLOAT) !== null ||
      gl.getShaderPrecisionFormat(shaderType, gl.MEDIUM_FLOAT) !== null ||
      gl.getShaderPrecisionFormat(shaderType, gl.LOW_FLOAT) !== null;
    return check(gl.VERTEX_SHADER) && check(gl.FRAGMENT_SHADER);
  } catch {
    return false;
  }
}

/**
 * Safely creates a Three.js WebGLRenderer by pre-acquiring and validating a non-lost
 * WebGL2/WebGL1 context with working shader precision formats. Prevents Three.js
 * `Cannot read properties of null (reading 'precision')` crashes under StrictMode,
 * context loss, or driver GPU-switching fallbacks.
 */
export function createSafeWebGLRenderer(
  options: SafeWebGLRendererOptions = {}
): THREE.WebGLRenderer {
  const alpha = options.alpha ?? true;
  const antialias = options.antialias ?? performanceManager.getConfig().preview3DAntialias;
  const preserveDrawingBuffer = options.preserveDrawingBuffer ?? true;
  const preferredPower =
    options.powerPreference ?? performanceManager.getConfig().gpuPowerPreference ?? 'high-performance';

  const attempts: Array<{ antialias: boolean; powerPreference?: WebGLPowerPreference }> = [
    { antialias, powerPreference: preferredPower },
    { antialias, powerPreference: 'default' },
    { antialias: false, powerPreference: 'default' },
  ];

  let lastError: unknown = null;
  let sawRealWebGLContext = false;

  for (const attempt of attempts) {
    const targetCanvas = options.canvas ?? document.createElement('canvas');
    const ctxAttrs: WebGLContextAttributes = {
      alpha,
      antialias: attempt.antialias,
      preserveDrawingBuffer,
      depth: true,
      stencil: false,
      failIfMajorPerformanceCaveat: false,
      ...(attempt.powerPreference ? { powerPreference: attempt.powerPreference } : {}),
    };

    const rawCtx =
      targetCanvas.getContext('webgl2', ctxAttrs) || targetCanvas.getContext('webgl', ctxAttrs);

    if (!isWebGLContextLike(rawCtx)) {
      if (options.canvas) break;
      continue;
    }

    sawRealWebGLContext = true;
    if (!hasUsableShaderPrecision(rawCtx)) {
      if (options.canvas) {
        // Passed canvas already holds a lost/broken context; cannot switch context attributes on it
        break;
      }
      continue;
    }

    try {
      return new THREE.WebGLRenderer({
        canvas: targetCanvas,
        context: rawCtx,
        alpha,
        antialias: attempt.antialias,
        preserveDrawingBuffer,
        powerPreference: attempt.powerPreference,
      });
    } catch (err) {
      lastError = err;
      if (options.canvas) break;
    }
  }

  // Fallback for mocked/headless environments where canvas.getContext does not return a WebGL context
  if (!sawRealWebGLContext) {
    try {
      return new THREE.WebGLRenderer({
        ...(options.canvas ? { canvas: options.canvas } : {}),
        alpha,
        antialias,
        preserveDrawingBuffer,
        powerPreference: preferredPower,
      });
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    lastError instanceof Error
      ? `WebGL initialization failed: ${lastError.message}`
      : 'Unable to initialize a valid WebGL context for 3D rendering.'
  );
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
      if (line.isLine) {
        if (line.geometry) line.geometry.dispose();
        if (line.material) {
          if (Array.isArray(line.material)) line.material.forEach((m) => disposeMaterialTextures(m));
          else disposeMaterialTextures(line.material);
        }
      }

      const points = obj as THREE.Points;
      if (points.isPoints) {
        if (points.geometry) points.geometry.dispose();
        if (points.material) {
          if (Array.isArray(points.material)) points.material.forEach((m) => disposeMaterialTextures(m));
          else disposeMaterialTextures(points.material);
        }
      }
    });

    while (scene.children.length > 0) {
      scene.remove(scene.children[0]);
    }
  }

  if (renderer) {
    try {
      if (typeof renderer.forceContextLoss === 'function') {
        renderer.forceContextLoss();
      }
    } catch {}
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
    disposeOnComplete = true,
    onInsertLayer,
    onBroadcastLayer,
  } = options;

  const targetWidth = Math.max(1, Math.round(dimensions.width));
  const targetHeight = Math.max(1, Math.round(dimensions.height));

  // 1. Off-screen render buffer matching target document resolution and aspect ratio
  let offscreenRenderer: THREE.WebGLRenderer;
  let reusedActiveRenderer = false;
  const savedActiveSize = new THREE.Vector2();
  try {
    offscreenRenderer = createSafeWebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
  } catch (err) {
    if (activeRenderer && hasUsableShaderPrecision(activeRenderer.getContext())) {
      offscreenRenderer = activeRenderer;
      offscreenRenderer.getSize(savedActiveSize);
      reusedActiveRenderer = true;
    } else {
      throw err;
    }
  }

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
  if (activeRenderer && 'toneMapping' in activeRenderer && 'toneMapping' in offscreenRenderer) {
    offscreenRenderer.toneMapping = activeRenderer.toneMapping;
    offscreenRenderer.toneMappingExposure = activeRenderer.toneMappingExposure;
  }
  if (offscreenRenderer.shadowMap && activeRenderer?.shadowMap) {
    offscreenRenderer.shadowMap.enabled = activeRenderer.shadowMap.enabled;
    offscreenRenderer.shadowMap.type = activeRenderer.shadowMap.type;
  }

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
    if (!reusedActiveRenderer) {
      disposeThreeResources(null, offscreenRenderer);
    }
    throw new Error('Unable to create 2D canvas context for 3D rasterization');
  }

  ctx.drawImage(offscreenRenderer.domElement, 0, 0, targetWidth, targetHeight);
  const dataUrl = rasterCanvas.toDataURL('image/png');

  // 3. Memory Cleanup: Free offscreen WebGL context; preserve live scene if disposeOnComplete=false
  if (disposeOnComplete) {
    disposeThreeResources(scene, offscreenRenderer);
    if (activeRenderer && !reusedActiveRenderer) {
      disposeThreeResources(null, activeRenderer);
    }
  } else if (reusedActiveRenderer) {
    if (savedActiveSize.x > 0 && savedActiveSize.y > 0) {
      offscreenRenderer.setSize(savedActiveSize.x, savedActiveSize.y, false);
    }
  } else {
    disposeThreeResources(null, offscreenRenderer);
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

  // 5. Multiplayer Broadcast: Send layer metadata + LZ4 BINARY_TILE raster pixels (no base64 data URLs)
  if (onBroadcastLayer) {
    onBroadcastLayer(layer, dataUrl);
  } else if (multiplayerService.isConnected()) {
    multiplayerService.sendLayerAdd(layer);
    multiplayerService.streamLayerTiles(layer.id, documentStore.getActiveTileGrid());
  }

  return { layer, canvas: rasterCanvas, dataUrl };
}

export interface Bake3DLTOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  dimensions: { width: number; height: number; dpi?: number };
  dpi?: number;
  activeRenderer?: THREE.WebGLRenderer | null;
  modelName?: string;
  targetFolderName?: string;
  baseLayerName?: string;
  lineWidth?: number; // 1 to 5 (default: 1)
  lineThreshold?: number; // 0.05 to 0.8 (default: 0.28)
  toneCount?: number; // 0 to 4 tone layers (default: 2; 0 = outline only)
  toneBands?: 2 | 3; // Backward-compatibility alias for toneCount
  toneFrequencies?: number[]; // Lines per inch [light, deep, ...] (default: 60)
  toneAngles?: number[]; // Halftone grid angles (default: 45° for all tiers)
  toneDensities?: number[]; // Density normalized [0-1] (e.g. [0.20, 0.45])
  antiAliasing?: boolean; // default: false for crisp 1-bit CSP manga lineart
  disposeOnComplete?: boolean;
  previewOnly?: boolean;
  onInsertLayers?: (layers: LayerItem[], canvases: HTMLCanvasElement[]) => void;
  onBroadcastLayer?: (layer: LayerItem, dataUrl: string) => void;
}

export interface Bake3DLTResult {
  folderLayer: LayerItem;
  lineLayer: LayerItem;
  lineCanvas: HTMLCanvasElement;
  toneLayers: LayerItem[];
  toneCanvases: HTMLCanvasElement[];
  allLayers: LayerItem[];
  allCanvases: HTMLCanvasElement[];
}

const isLittleEndian = (() => {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = 0x11223344;
  return new Uint8Array(buf)[0] === 0x44;
})();
const SOLID_BLACK_U32 = isLittleEndian ? 0xff000000 : 0x000000ff;

const sobelVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const sobelFragmentShader = `
  varying vec2 vUv;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform vec2 uResolution;
  uniform float uThreshold;
  uniform float uLineWidth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform int uIsPerspective;
  uniform int uAntiAliasing;

  float readDepth(vec2 coord) {
    float z = texture2D(tDepth, coord).r;
    if (z >= 1.0) return 1.0;
    if (uIsPerspective == 1) {
      return (2.0 * uCameraNear) / (uCameraFar + uCameraNear - z * (uCameraFar - uCameraNear));
    }
    return z;
  }

  float evaluateEdgeAt(vec2 uv, vec2 px) {
    vec4 centerNorm = texture2D(tNormal, uv);
    if (centerNorm.a < 0.5) {
      return 0.0;
    }

    vec2 uvL = uv + vec2(-px.x, 0.0);
    vec2 uvR = uv + vec2(px.x, 0.0);
    vec2 uvT = uv + vec2(0.0, px.y);
    vec2 uvB = uv + vec2(0.0, -px.y);

    vec4 sL = texture2D(tNormal, uvL);
    vec4 sR = texture2D(tNormal, uvR);
    vec4 sT = texture2D(tNormal, uvT);
    vec4 sB = texture2D(tNormal, uvB);

    // Crisp outer silhouette against transparent background
    if (sL.a < 0.5 || sR.a < 0.5 || sT.a < 0.5 || sB.a < 0.5) {
      return 10.0;
    }

    // Angular normal crease detection (eliminates blurry smudging on smooth curved surfaces)
    vec3 nC = normalize(centerNorm.rgb * 2.0 - 1.0);
    vec3 nL = normalize(sL.rgb * 2.0 - 1.0);
    vec3 nR = normalize(sR.rgb * 2.0 - 1.0);
    vec3 nT = normalize(sT.rgb * 2.0 - 1.0);
    vec3 nB = normalize(sB.rgb * 2.0 - 1.0);

    float creaseH = max(1.0 - clamp(dot(nC, nL), -1.0, 1.0), 1.0 - clamp(dot(nC, nR), -1.0, 1.0));
    float creaseV = max(1.0 - clamp(dot(nC, nT), -1.0, 1.0), 1.0 - clamp(dot(nC, nB), -1.0, 1.0));
    float normalEdge = max(creaseH, creaseV);

    // Second-order depth Laplacian: zero on tilted flat planes, sharp spike on true occlusion steps
    float dC = readDepth(uv);
    float dL = readDepth(uvL);
    float dR = readDepth(uvR);
    float dT = readDepth(uvT);
    float dB = readDepth(uvB);
    float depthLap = abs(dL + dR - 2.0 * dC) + abs(dT + dB - 2.0 * dC);
    float depthEdge = depthLap * 90.0;

    return normalEdge * 1.15 + depthEdge;
  }

  void main() {
    vec2 px = 1.0 / max(vec2(1.0), uResolution);
    float maxEdge = evaluateEdgeAt(vUv, px);

    // Crisp morphological dilation for lineWidth > 1 (solid stroke, zero hollow/double-edge artifacts)
    if (uLineWidth > 1.5 && maxEdge <= uThreshold) {
      float radius = min(2.5, uLineWidth * 0.5);
      for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
          if (dx == 0 && dy == 0) continue;
          vec2 off = vec2(float(dx), float(dy));
          if (length(off) <= radius) {
            float e = evaluateEdgeAt(vUv + off * px, px);
            if (e > maxEdge) maxEdge = e;
          }
        }
      }
    }

    if (maxEdge > uThreshold) {
      if (uAntiAliasing == 1) {
        float alpha = smoothstep(uThreshold, uThreshold + 0.08, maxEdge);
        gl_FragColor = alpha >= 0.15 ? vec4(0.0, 0.0, 0.0, alpha) : vec4(0.0, 0.0, 0.0, 0.0);
      } else {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      }
    } else {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    }
  }
`;

const displayVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const displayFragmentShader = `
  varying vec2 vUv;
  uniform sampler2D tSource;
  void main() {
    gl_FragColor = texture2D(tSource, vUv);
  }
`;

/**
 * 3D Model LT Conversion (Automatic Line Art & Screentone Extraction).
 *
 * Renders Three.js scene to offscreen render targets:
 * - Target A: Depth texture + Surface normal buffer
 * - Target B: Diffuse lighting buffer (grayscale luminance)
 * Runs a GLSL fragment Sobel pass for crisp silhouettes and creases ("3D Outline"),
 * quantizes diffuse lighting into 1 to 4 screentoned shadow tiers, and groups
 * all layers into a manga folder "3D Extraction [Model Name]".
 */
export async function bake3DToLineAndTone(options: Bake3DLTOptions): Promise<Bake3DLTResult> {
  const {
    scene,
    camera,
    dimensions,
    dpi,
    activeRenderer,
    modelName,
    targetFolderName,
    baseLayerName = '3D Model',
    lineWidth = 1,
    lineThreshold = 0.28,
    toneCount: explicitToneCount,
    toneBands,
    toneFrequencies,
    toneAngles,
    toneDensities,
    antiAliasing = false,
    disposeOnComplete = true,
    previewOnly = false,
    onInsertLayers,
    onBroadcastLayer,
  } = options;

  const effectiveDisposeOnComplete = previewOnly ? false : disposeOnComplete;
  const targetWidth = Math.max(1, Math.round(dimensions.width));
  const targetHeight = Math.max(1, Math.round(dimensions.height));
  const resolvedDpi = Math.max(1, dpi ?? dimensions.dpi ?? 600);
  const resolvedToneCount = Math.max(0, Math.min(4, Math.round(explicitToneCount ?? toneBands ?? 2)));

  let offscreenRenderer: THREE.WebGLRenderer;
  let reusedActiveRenderer = false;
  const savedActiveSize = new THREE.Vector2();
  try {
    offscreenRenderer = createSafeWebGLRenderer({
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
  } catch (err) {
    if (activeRenderer && hasUsableShaderPrecision(activeRenderer.getContext())) {
      offscreenRenderer = activeRenderer;
      offscreenRenderer.getSize(savedActiveSize);
      reusedActiveRenderer = true;
    } else {
      throw err;
    }
  }

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
  if (activeRenderer && 'toneMapping' in activeRenderer && 'toneMapping' in offscreenRenderer) {
    offscreenRenderer.toneMapping = activeRenderer.toneMapping;
    offscreenRenderer.toneMappingExposure = activeRenderer.toneMappingExposure;
  }
  if (offscreenRenderer.shadowMap && activeRenderer?.shadowMap) {
    offscreenRenderer.shadowMap.enabled = activeRenderer.shadowMap.enabled;
    offscreenRenderer.shadowMap.type = activeRenderer.shadowMap.type;
  }

  const renderCamera = camera.clone();
  let isPerspective = 1;
  let cameraNear = 0.1;
  let cameraFar = 1000;

  if ('isPerspectiveCamera' in renderCamera && renderCamera.isPerspectiveCamera) {
    const pCam = renderCamera as THREE.PerspectiveCamera;
    pCam.aspect = targetWidth / targetHeight;
    pCam.updateProjectionMatrix();
    cameraNear = pCam.near;
    cameraFar = pCam.far;
    isPerspective = 1;
  } else if ('isOrthographicCamera' in renderCamera && renderCamera.isOrthographicCamera) {
    const oCam = renderCamera as THREE.OrthographicCamera;
    oCam.updateProjectionMatrix();
    cameraNear = oCam.near;
    cameraFar = oCam.far;
    isPerspective = 0;
  }

  // Preserve original materials for restoring after normal pass (skipping helpers/hidden meshes)
  const savedMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const hiddenHelpers: THREE.Object3D[] = [];
  scene.traverse((obj) => {
    if (obj.userData?.is3DHelper && obj.visible) {
      hiddenHelpers.push(obj);
      obj.visible = false;
      return;
    }
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh && !mesh.userData?.is3DHelper) {
      savedMaterials.set(mesh, mesh.material);
    }
  });

  // 1. Offscreen Render Target A: Depth Texture + Surface Normal Buffer
  const targetA = new THREE.WebGLRenderTarget(renderWidth, renderHeight, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthTexture: new THREE.DepthTexture(renderWidth, renderHeight, THREE.UnsignedIntType),
  });

  const normalMat = new THREE.MeshNormalMaterial();
  const targetB = new THREE.WebGLRenderTarget(renderWidth, renderHeight, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  });

  try {
    for (const mesh of savedMaterials.keys()) {
      mesh.material = normalMat;
    }

    offscreenRenderer.setRenderTarget(targetA);
    offscreenRenderer.clear();
    offscreenRenderer.render(scene, renderCamera);

    // 2. Offscreen Render Target B: Diffuse Lighting Buffer
    for (const [mesh, origMat] of savedMaterials.entries()) {
      mesh.material = origMat;
    }

    offscreenRenderer.setRenderTarget(targetB);
    offscreenRenderer.clear();
    offscreenRenderer.render(scene, renderCamera);
  } finally {
    for (const [mesh, origMat] of savedMaterials.entries()) {
      mesh.material = origMat;
    }
    for (const helper of hiddenHelpers) {
      helper.visible = true;
    }
  }

  // 3. GLSL Fragment Sobel Edge Detection Pass over Target A (Normals + Depth)
  const lineTarget = new THREE.WebGLRenderTarget(renderWidth, renderHeight, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
  });

  const postScene = new THREE.Scene();
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);

  const sobelMaterial = new THREE.ShaderMaterial({
    vertexShader: sobelVertexShader,
    fragmentShader: sobelFragmentShader,
    uniforms: {
      tNormal: { value: targetA.texture },
      tDepth: { value: targetA.depthTexture },
      uResolution: { value: new THREE.Vector2(renderWidth, renderHeight) },
      uThreshold: { value: lineThreshold },
      uLineWidth: { value: lineWidth },
      uCameraNear: { value: cameraNear },
      uCameraFar: { value: cameraFar },
      uIsPerspective: { value: isPerspective },
      uAntiAliasing: { value: antiAliasing ? 1 : 0 },
    },
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });

  const sobelQuad = new THREE.Mesh(quadGeo, sobelMaterial);
  postScene.add(sobelQuad);

  offscreenRenderer.setRenderTarget(lineTarget);
  offscreenRenderer.clear();
  offscreenRenderer.render(postScene, postCamera);

  // Transfer rendered line target to lineCanvas at target document dimensions
  const lineCanvas = document.createElement('canvas');
  lineCanvas.width = targetWidth;
  lineCanvas.height = targetHeight;
  const lineCtx = lineCanvas.getContext('2d', { willReadFrequently: true })!;

  const displayMaterial = new THREE.ShaderMaterial({
    vertexShader: displayVertexShader,
    fragmentShader: displayFragmentShader,
    uniforms: { tSource: { value: lineTarget.texture } },
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  sobelQuad.material = displayMaterial;

  offscreenRenderer.setRenderTarget(null);
  offscreenRenderer.clear();
  offscreenRenderer.render(postScene, postCamera);
  lineCtx.imageSmoothingEnabled = false;
  lineCtx.drawImage(offscreenRenderer.domElement, 0, 0, targetWidth, targetHeight);

  // 4. Capture Diffuse Lighting Buffer for Shadow Tier Posterization
  displayMaterial.uniforms.tSource.value = targetB.texture;
  offscreenRenderer.setRenderTarget(null);
  offscreenRenderer.clear();
  offscreenRenderer.render(postScene, postCamera);

  const diffuseCanvas = document.createElement('canvas');
  diffuseCanvas.width = renderWidth;
  diffuseCanvas.height = renderHeight;
  const diffCtx = diffuseCanvas.getContext('2d', { willReadFrequently: true })!;
  diffCtx.imageSmoothingEnabled = false;
  diffCtx.drawImage(offscreenRenderer.domElement, 0, 0, renderWidth, renderHeight);
  const diffImageData = diffCtx.getImageData(0, 0, renderWidth, renderHeight);
  const diffData = diffImageData.data;

  // Group Folder Name Resolution
  const rawModelName = modelName || baseLayerName || 'Model';
  const cleanModelName = rawModelName.replace(/\.[^/.]+$/, '').trim();
  const folderName = targetFolderName?.trim() || `3D Extraction [${cleanModelName}]`;
  const folderId = `folder-lt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;

  // 5. Posterize Diffuse Lighting into 1 to 4 Mutually Exclusive Manga Screentone Shadow Tiers
  // Each pixel belongs to at most ONE shadow band at uniform 45° angle (Clip Studio Paint style),
  // eliminating overlapping-band moiré and preserving exact requested tone densities.
  type ToneTierDef = {
    minLum: number;
    maxLum: number;
    density: number;
    frequency: number;
    angle: number;
    name: string;
  };

  const tierConfigs: ToneTierDef[] = [];
  if (resolvedToneCount === 0) {
    // Lineart-only extraction
  } else if (resolvedToneCount === 1) {
    tierConfigs.push({
      minLum: -1.0,
      maxLum: 0.45,
      density: toneDensities?.[0] ?? 0.45,
      frequency: toneFrequencies?.[0] ?? 60,
      angle: toneAngles?.[0] ?? 45,
      name: '3D Tone (Deep)',
    });
  } else if (resolvedToneCount === 2) {
    tierConfigs.push(
      {
        minLum: 0.35,
        maxLum: 0.65,
        density: toneDensities?.[0] ?? 0.20,
        frequency: toneFrequencies?.[0] ?? 60,
        angle: toneAngles?.[0] ?? 45,
        name: '3D Tone 1 (Light)',
      },
      {
        minLum: -1.0,
        maxLum: 0.35,
        density: toneDensities?.[1] ?? 0.45,
        frequency: toneFrequencies?.[1] ?? 60,
        angle: toneAngles?.[1] ?? 45,
        name: '3D Tone 2 (Deep)',
      }
    );
  } else if (resolvedToneCount === 3) {
    tierConfigs.push(
      {
        minLum: 0.45,
        maxLum: 0.70,
        density: toneDensities?.[0] ?? 0.15,
        frequency: toneFrequencies?.[0] ?? 60,
        angle: toneAngles?.[0] ?? 45,
        name: '3D Tone 1 (Light)',
      },
      {
        minLum: 0.25,
        maxLum: 0.45,
        density: toneDensities?.[1] ?? 0.30,
        frequency: toneFrequencies?.[1] ?? 60,
        angle: toneAngles?.[1] ?? 45,
        name: '3D Tone 2 (Mid)',
      },
      {
        minLum: -1.0,
        maxLum: 0.25,
        density: toneDensities?.[2] ?? 0.50,
        frequency: toneFrequencies?.[2] ?? 60,
        angle: toneAngles?.[2] ?? 45,
        name: '3D Tone 3 (Deep)',
      }
    );
  } else {
    // 4 Tone Layers
    tierConfigs.push(
      {
        minLum: 0.55,
        maxLum: 0.75,
        density: toneDensities?.[0] ?? 0.10,
        frequency: toneFrequencies?.[0] ?? 60,
        angle: toneAngles?.[0] ?? 45,
        name: '3D Tone 1 (Light)',
      },
      {
        minLum: 0.35,
        maxLum: 0.55,
        density: toneDensities?.[1] ?? 0.25,
        frequency: toneFrequencies?.[1] ?? 60,
        angle: toneAngles?.[1] ?? 45,
        name: '3D Tone 2 (Mid-Light)',
      },
      {
        minLum: 0.18,
        maxLum: 0.35,
        density: toneDensities?.[2] ?? 0.40,
        frequency: toneFrequencies?.[2] ?? 60,
        angle: toneAngles?.[2] ?? 45,
        name: '3D Tone 3 (Mid-Deep)',
      },
      {
        minLum: -1.0,
        maxLum: 0.18,
        density: toneDensities?.[3] ?? 0.55,
        frequency: toneFrequencies?.[3] ?? 60,
        angle: toneAngles?.[3] ?? 45,
        name: '3D Tone 4 (Deep)',
      }
    );
  }

  const toneCanvases: HTMLCanvasElement[] = [];
  const toneLayers: LayerItem[] = [];

  for (let t = 0; t < tierConfigs.length; t++) {
    const tier = tierConfigs[t];
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = renderWidth;
    maskCanvas.height = renderHeight;
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })!;
    const maskImageData = maskCtx.createImageData(renderWidth, renderHeight);
    const maskData32 = new Uint32Array(maskImageData.data.buffer);

    for (let i = 0; i < renderWidth * renderHeight; i++) {
      const pIdx = i * 4;
      const alpha = diffData[pIdx + 3];
      // Threshold alpha cleanly at 128 to prevent darkened transparent silhouette fringes.
      // Do NOT cut out outline pixels: "3D Outline" sits above tone layers, so keeping solid
      // tone masks underneath prevents white/gray halos around lines.
      if (alpha < 128) continue;

      const r = diffData[pIdx];
      const g = diffData[pIdx + 1];
      const b = diffData[pIdx + 2];
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;

      if (lum >= tier.minLum && lum < tier.maxLum) {
        maskData32[i] = SOLID_BLACK_U32;
      }
    }

    maskCtx.putImageData(maskImageData, 0, 0);

    const finalToneCanvas = document.createElement('canvas');
    finalToneCanvas.width = targetWidth;
    finalToneCanvas.height = targetHeight;
    const finalToneCtx = finalToneCanvas.getContext('2d')!;
    finalToneCtx.imageSmoothingEnabled = false;

    if (previewOnly) {
      // Live 2D modal preview composites toneCanvases directly without the WebGL compositor,
      // so render crisp 1-bit binary screentone dots at preview resolution.
      const toneRenderCanvas = document.createElement('canvas');
      toneRenderCanvas.width = renderWidth;
      toneRenderCanvas.height = renderHeight;
      applyScreentoneCPU(maskCanvas, toneRenderCanvas, {
        frequency: tier.frequency,
        angle: tier.angle,
        dotShape: 'circle',
        specifiedDensity: tier.density,
        densityType: 'specified',
        dpi: resolvedDpi,
        antiAliasing: false,
      });
      finalToneCtx.drawImage(toneRenderCanvas, 0, 0, targetWidth, targetHeight);
    } else {
      // Extracted tone layers are non-destructive Clip Studio Paint tone layers (toneEnabled: true):
      // store the crisp solid-black shadow mask so the compositor renders the 1-bit halftone dots
      // ONCE at exact document DPI (eliminating double-screentoning blur & moiré artifacts).
      finalToneCtx.drawImage(maskCanvas, 0, 0, targetWidth, targetHeight);
    }
    toneCanvases.push(finalToneCanvas);

    const toneDataUrl = previewOnly ? '' : finalToneCanvas.toDataURL('image/png');
    const toneLayer: LayerItem = {
      id: `raster-lt-tone-${t + 1}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      name: tier.name,
      type: 'raster',
      visible: true,
      opacity: 1,
      blendMode: 'multiply',
      locked: false,
      collapsed: false,
      parentId: folderId,
      thumbnailUrl: toneDataUrl,
      isToneLayer: true,
      toneEnabled: true,
      toneFrequency: tier.frequency,
      toneAngle: tier.angle,
      toneDotShape: 'circle',
      toneDensity: Math.round(tier.density * 100),
      toneDensityType: 'specified',
    };
    toneLayers.push(toneLayer);
  }

  // 6. Outline Layer ("3D Outline")
  const lineDataUrl = previewOnly ? '' : lineCanvas.toDataURL('image/png');
  const lineLayer: LayerItem = {
    id: `raster-lt-line-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    name: '3D Outline',
    type: 'raster',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    locked: false,
    collapsed: false,
    parentId: folderId,
    thumbnailUrl: lineDataUrl,
    expressionColor: antiAliasing ? 'gray' : 'monochrome',
  };

  // 7. Folder Group Layer: "3D Extraction [Model Name]"
  const folderLayer: LayerItem = {
    id: folderId,
    name: folderName,
    type: 'folder',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    locked: false,
    collapsed: false,
    parentId: null,
  };

  // 8. Immediate Cleanup of Offscreen WebGL Resources
  normalMat.dispose();
  quadGeo.dispose();
  sobelMaterial.dispose();
  displayMaterial.dispose();
  targetA.texture.dispose();
  targetA.depthTexture?.dispose();
  targetA.dispose();
  targetB.texture.dispose();
  targetB.dispose();
  lineTarget.texture.dispose();
  lineTarget.dispose();

  if (effectiveDisposeOnComplete) {
    disposeThreeResources(scene, offscreenRenderer);
    if (activeRenderer && !reusedActiveRenderer) {
      disposeThreeResources(null, activeRenderer);
    }
  } else if (reusedActiveRenderer) {
    offscreenRenderer.setRenderTarget(null);
    if (savedActiveSize.x > 0 && savedActiveSize.y > 0) {
      offscreenRenderer.setSize(savedActiveSize.x, savedActiveSize.y, false);
    }
  } else {
    try {
      if (typeof offscreenRenderer.forceContextLoss === 'function') {
        offscreenRenderer.forceContextLoss();
      }
    } catch {}
    offscreenRenderer.dispose();
  }

  // Render and Stack Hierarchy:
  // Folder containing: 3D Outline on top, then Deep shadow tones below, then Light shadow tone
  // In `layers` stack: [folderLayer, lineLayer, toneLayerDeep, ..., toneLayerLight]
  // In reverse order for compositor: Tone 1 -> Tone 2 -> Lineart
  const toneLayersStackOrder = [...toneLayers].reverse();
  const toneCanvasesStackOrder = [...toneCanvases].reverse();

  const folderCanvas = document.createElement('canvas');
  folderCanvas.width = 1;
  folderCanvas.height = 1;

  const allLayers: LayerItem[] = [folderLayer, lineLayer, ...toneLayersStackOrder];
  const allCanvases: HTMLCanvasElement[] = [folderCanvas, lineCanvas, ...toneCanvasesStackOrder];

  if (!previewOnly && onInsertLayers) {
    onInsertLayers(allLayers, allCanvases);
  }

  if (!previewOnly) {
    if (onBroadcastLayer) {
      onBroadcastLayer(folderLayer, '');
      onBroadcastLayer(lineLayer, lineDataUrl);
      toneLayersStackOrder.forEach((l, i) => onBroadcastLayer(l, toneCanvasesStackOrder[i].toDataURL('image/png')));
    } else if (multiplayerService.isConnected()) {
      const activeGrid = documentStore.getActiveTileGrid();
      multiplayerService.sendLayerAdd(folderLayer);
      multiplayerService.sendLayerAdd(lineLayer);
      multiplayerService.streamLayerTiles(lineLayer.id, activeGrid);
      toneLayersStackOrder.forEach((l) => {
        multiplayerService.sendLayerAdd(l);
        multiplayerService.streamLayerTiles(l.id, activeGrid);
      });
    }
  }

  return {
    folderLayer,
    lineLayer,
    lineCanvas,
    toneLayers,
    toneCanvases,
    allLayers,
    allCanvases,
  };
}

