import { CanvasDimensions, CanvasSelection, LayerItem, isFolderLikeLayer } from '../types/editor';
import { isNativeRustAvailable, liquifyStepNative } from './nativeBackend';
import {
  BYTES_32BIT,
  SparseTileGrid,
  TILE_SIZE,
  TileFormat,
  TileSnapshotEntry,
  getTileKey,
  pixelToTileCoord,
  unpack1BitToRGBA,
  unpack8BitToRGBA,
} from './tileEngine';

export type LiquifyMode =
  | 'push'
  | 'expand'
  | 'pinch'
  | 'push-left'
  | 'push-right'
  | 'twirl-cw'
  | 'twirl-ccw'
  | 'reconstruct';

export interface LiquifySettings {
  mode: LiquifyMode;
  size: number; // 5 to 500 px
  strength: number; // 1 to 100
  hardness: number; // 0 to 100
  usePressure: boolean;
  multiLayer?: boolean;
}

export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LiquifyStepParams {
  canvas: HTMLCanvasElement;
  sourceCanvas?: HTMLCanvasElement | null;
  cx: number;
  cy: number;
  prevX: number;
  prevY: number;
  settings: LiquifySettings;
  pressure?: number;
  initialImageData?: ImageData | null;
  selectionMask?: Uint8Array | null;
  useGpu?: boolean;
}

export const LIQUIFY_VERTEX_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

export const LIQUIFY_FRAGMENT_SHADER = `
  precision highp float;
  varying vec2 v_uv;
  uniform sampler2D u_sourceTex;
  uniform vec2 u_roiOrigin;
  uniform vec2 u_roiSize;
  uniform vec2 u_center;
  uniform vec2 u_pushDir;
  uniform float u_vLen;
  uniform float u_radius;
  uniform float u_hardness;
  uniform float u_strength;
  uniform int u_mode; // 0: push, 1: push-left, 2: push-right, 3: expand, 4: pinch, 5: twirl-cw, 6: twirl-ccw

  void main() {
    // Convert v_uv (with WebGL Y-flip accounted for) to canvas pixel coordinates
    vec2 localPos = vec2(v_uv.x * u_roiSize.x, (1.0 - v_uv.y) * u_roiSize.y);
    vec2 canvasPos = u_roiOrigin + localPos;
    vec2 delta = canvasPos - u_center;
    float distSq = dot(delta, delta);
    float radiusSq = u_radius * u_radius;

    if (distSq >= radiusSq) {
      gl_FragColor = texture2D(u_sourceTex, vec2(v_uv.x, 1.0 - v_uv.y));
      return;
    }

    float dist = sqrt(distSq);
    float u = dist / u_radius;
    float t = 1.0 - u * u;
    float weight = (1.0 - u_hardness) * (t * t) + u_hardness * t;

    vec2 srcCanvas = canvasPos;
    if (u_mode == 0) {
      float pushAmount = u_vLen * u_strength * weight;
      srcCanvas = canvasPos - u_pushDir * pushAmount;
    } else if (u_mode == 1) {
      float pushAmount = max(1.5, u_vLen) * u_strength * weight;
      srcCanvas = canvasPos + vec2(u_pushDir.y, -u_pushDir.x) * pushAmount;
    } else if (u_mode == 2) {
      float pushAmount = max(1.5, u_vLen) * u_strength * weight;
      srcCanvas = canvasPos + vec2(-u_pushDir.y, u_pushDir.x) * pushAmount;
    } else if (u_mode == 3) {
      float factor = u_strength * weight * 0.3;
      srcCanvas = u_center + delta * (1.0 - factor);
    } else if (u_mode == 4) {
      float factor = u_strength * weight * 0.3;
      srcCanvas = u_center + delta * (1.0 + factor);
    } else if (u_mode == 5 || u_mode == 6) {
      float signDir = (u_mode == 5) ? 1.0 : -1.0;
      float theta = signDir * (u_strength * 0.45) * weight;
      float cosT = cos(theta);
      float sinT = sin(theta);
      srcCanvas = u_center + vec2(delta.x * cosT + delta.y * sinT, -delta.x * sinT + delta.y * cosT);
    }

    vec2 sampleLocal = clamp(srcCanvas - u_roiOrigin, vec2(0.0), u_roiSize - vec2(1.0));
    vec2 sampleUv = sampleLocal / u_roiSize;
    gl_FragColor = texture2D(u_sourceTex, sampleUv);
  }
`;

export class WebGlLiquifyEngine {
  private static instance: WebGlLiquifyEngine | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private roiStagingCanvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private sourceTex: WebGLTexture | null = null;
  private gpuReady = false;

  public static getInstance(): WebGlLiquifyEngine {
    if (!WebGlLiquifyEngine.instance) {
      WebGlLiquifyEngine.instance = new WebGlLiquifyEngine();
    }
    return WebGlLiquifyEngine.instance;
  }

  private constructor() {
    if (typeof document === 'undefined') return;
    try {
      this.canvas = document.createElement('canvas');
      this.roiStagingCanvas = document.createElement('canvas');
      const gl = (this.canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true }) ||
        this.canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true })) as WebGLRenderingContext | null;
      if (!gl) return;
      this.gl = gl;

      const vs = gl.createShader(gl.VERTEX_SHADER);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      if (!vs || !fs) return;
      gl.shaderSource(vs, LIQUIFY_VERTEX_SHADER);
      gl.compileShader(vs);
      gl.shaderSource(fs, LIQUIFY_FRAGMENT_SHADER);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS) || !gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        return;
      }

      const prog = gl.createProgram();
      if (!prog) return;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
      this.program = prog;

      this.quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW
      );

      this.sourceTex = gl.createTexture();
      this.gpuReady = true;
    } catch {
      this.gpuReady = false;
    }
  }

  public isAvailable(): boolean {
    return this.gpuReady && this.gl !== null && this.program !== null;
  }

  public executeStep(
    targetCanvas: HTMLCanvasElement,
    targetCtx: CanvasRenderingContext2D,
    sourceCanvas: HTMLCanvasElement | null | undefined,
    minX: number,
    minY: number,
    roiW: number,
    roiH: number,
    cx: number,
    cy: number,
    ux: number,
    uy: number,
    vLen: number,
    radius: number,
    hardnessFactor: number,
    strengthFactor: number,
    mode: LiquifyMode
  ): boolean {
    if (!this.isAvailable() || !this.gl || !this.program || !this.canvas || !this.roiStagingCanvas || !this.sourceTex) {
      return false;
    }

    const modeMap: Record<string, number> = {
      push: 0,
      'push-left': 1,
      'push-right': 2,
      expand: 3,
      pinch: 4,
      'twirl-cw': 5,
      'twirl-ccw': 6,
    };
    const modeInt = modeMap[mode];
    if (modeInt === undefined) return false;

    if (this.roiStagingCanvas.width !== roiW || this.roiStagingCanvas.height !== roiH) {
      this.roiStagingCanvas.width = roiW;
      this.roiStagingCanvas.height = roiH;
    }
    const stagingCtx = this.roiStagingCanvas.getContext('2d');
    if (!stagingCtx) return false;
    stagingCtx.clearRect(0, 0, roiW, roiH);
    stagingCtx.drawImage(targetCanvas, minX, minY, roiW, roiH, 0, 0, roiW, roiH);

    if (this.canvas.width !== roiW || this.canvas.height !== roiH) {
      this.canvas.width = roiW;
      this.canvas.height = roiH;
    }

    const gl = this.gl;
    gl.viewport(0, 0, roiW, roiH);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.roiStagingCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.uniform1i(gl.getUniformLocation(this.program, 'u_sourceTex'), 0);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_roiOrigin'), minX, minY);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_roiSize'), roiW, roiH);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_center'), cx, cy);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_pushDir'), ux, uy);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_vLen'), vLen);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_radius'), radius);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_hardness'), hardnessFactor);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_strength'), strengthFactor);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_mode'), modeInt);

    const posLoc = gl.getAttribLocation(this.program, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    targetCtx.save();
    targetCtx.globalCompositeOperation = 'copy';
    targetCtx.beginPath();
    targetCtx.rect(minX, minY, roiW, roiH);
    targetCtx.clip();
    targetCtx.drawImage(this.canvas, 0, 0, roiW, roiH, minX, minY, roiW, roiH);
    targetCtx.restore();

    if (sourceCanvas && sourceCanvas !== targetCanvas) {
      const sCtx = sourceCanvas.getContext('2d');
      if (sCtx) {
        sCtx.save();
        sCtx.globalCompositeOperation = 'copy';
        sCtx.beginPath();
        sCtx.rect(minX, minY, roiW, roiH);
        sCtx.clip();
        sCtx.drawImage(this.canvas, 0, 0, roiW, roiH, minX, minY, roiW, roiH);
        sCtx.restore();
      }
    }

    return true;
  }
}

/**
 * Computes radial falloff weight for liquify deformation.
 * Zero at boundaries (u >= 1), smooth cubic bell curve shaped by hardness.
 */
function computeFalloffWeight(dist: number, radius: number, hardnessFactor: number): number {
  const u = dist / radius;
  if (u >= 1) return 0;
  const t = 1 - u * u;
  // Blend between cubic smoothstep and linear based on hardness
  return (1 - hardnessFactor) * (t * t) + hardnessFactor * t;
}

/**
 * Executes a single localized, bilinear-interpolated liquify deformation step on the target canvas.
 * Uses hardware WebGL shader displacement on large brushes when available, with automatic CPU fallback.
 */
export function applyLiquifyStep(params: LiquifyStepParams): DirtyRect | null {
  const {
    canvas,
    sourceCanvas,
    cx,
    cy,
    prevX,
    prevY,
    settings,
    pressure = 1.0,
    initialImageData,
    selectionMask,
    useGpu = true,
  } = params;

  const width = canvas.width;
  const height = canvas.height;
  const radius = Math.max(2, Math.round(settings.size / 2));
  const radiusSq = radius * radius;

  // Maximum displacement padding to ensure subpixel backward sampling stays within ROI
  const pad = Math.min(32, Math.max(4, Math.ceil(radius * 0.2)));
  const minX = Math.max(0, Math.floor(cx - radius - pad));
  const minY = Math.max(0, Math.floor(cy - radius - pad));
  const maxX = Math.min(width, Math.ceil(cx + radius + pad));
  const maxY = Math.min(height, Math.ceil(cy + radius + pad));

  const roiW = maxX - minX;
  const roiH = maxY - minY;
  if (roiW <= 0 || roiH <= 0) return null;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const hardnessFactor = Math.max(0, Math.min(1, settings.hardness / 100));
  const effectivePressure = settings.usePressure ? Math.max(0.1, pressure) : 1.0;
  const strengthFactor = (settings.strength / 100) * effectivePressure;

  const vx = cx - prevX;
  const vy = cy - prevY;
  const vLen = Math.hypot(vx, vy);

  // Direction unit vector for push modes
  let ux = 0;
  let uy = 0;
  if (vLen > 0.0001) {
    ux = vx / vLen;
    uy = vy / vLen;
  }

  const mode = settings.mode;
  const isPushMode = mode === 'push' || mode === 'push-left' || mode === 'push-right';
  if (isPushMode && vLen < 0.0001) {
    return null;
  }

  // Hardware WebGL fast path for large Liquify brushes
  if (useGpu && !selectionMask && mode !== 'reconstruct' && roiW * roiH >= 64 * 64) {
    const gpuLiquify = WebGlLiquifyEngine.getInstance();
    if (
      gpuLiquify.executeStep(
        canvas,
        ctx,
        sourceCanvas,
        minX,
        minY,
        roiW,
        roiH,
        cx,
        cy,
        ux,
        uy,
        vLen,
        radius,
        hardnessFactor,
        strengthFactor,
        mode
      )
    ) {
      return { x: minX, y: minY, width: roiW, height: roiH };
    }
  }

  const srcImageData = ctx.getImageData(minX, minY, roiW, roiH);
  const src = srcImageData.data;

  // Clone source buffer for destination write
  const dstImageData = ctx.createImageData(roiW, roiH);
  const dst = dstImageData.data;
  dst.set(src);

  // Pre-calculate twirl angles if in twirl mode
  const twirlBaseAngle = (mode === 'twirl-cw' ? 1 : -1) * (strengthFactor * 0.45);

  const initData = initialImageData?.data;
  const initW = initialImageData?.width ?? width;


  for (let ry = 0; ry < roiH; ry++) {
    const py = minY + ry;
    const dy = py - cy;
    const rowOffset = ry * roiW * 4;

    for (let rx = 0; rx < roiW; rx++) {
      const px = minX + rx;
      const dx = px - cx;
      const distSq = dx * dx + dy * dy;

      if (distSq >= radiusSq) {
        continue;
      }

      // Check selection mask
      if (selectionMask && selectionMask[py * width + px] === 0) {
        continue;
      }

      const dist = Math.sqrt(distSq);
      const weight = computeFalloffWeight(dist, radius, hardnessFactor);
      if (weight <= 0) continue;

      const dstIdx = rowOffset + rx * 4;

      if (mode === 'reconstruct') {
        if (!initData) continue;
        const alpha = Math.min(1, strengthFactor * weight * 0.35);
        const initIdx = (py * initW + px) * 4;
        dst[dstIdx] = Math.round(dst[dstIdx] * (1 - alpha) + initData[initIdx] * alpha);
        dst[dstIdx + 1] = Math.round(dst[dstIdx + 1] * (1 - alpha) + initData[initIdx + 1] * alpha);
        dst[dstIdx + 2] = Math.round(dst[dstIdx + 2] * (1 - alpha) + initData[initIdx + 2] * alpha);
        dst[dstIdx + 3] = Math.round(dst[dstIdx + 3] * (1 - alpha) + initData[initIdx + 3] * alpha);
        continue;
      }

      let srcCanvasX = px;
      let srcCanvasY = py;

      if (mode === 'push') {
        // Displace along stroke vector
        const pushAmount = vLen * strengthFactor * weight;
        srcCanvasX = px - ux * pushAmount;
        srcCanvasY = py - uy * pushAmount;
      } else if (mode === 'push-left') {
        // Displace perpendicular left (-uy, ux)
        const pushAmount = Math.max(1.5, vLen) * strengthFactor * weight;
        srcCanvasX = px + uy * pushAmount;
        srcCanvasY = py - ux * pushAmount;
      } else if (mode === 'push-right') {
        // Displace perpendicular right (uy, -ux)
        const pushAmount = Math.max(1.5, vLen) * strengthFactor * weight;
        srcCanvasX = px - uy * pushAmount;
        srcCanvasY = py + ux * pushAmount;
      } else if (mode === 'expand') {
        // Push outward (backward mapping pulls from closer to center)
        const factor = strengthFactor * weight * 0.3;
        srcCanvasX = cx + dx * (1 - factor);
        srcCanvasY = cy + dy * (1 - factor);
      } else if (mode === 'pinch') {
        // Pull inward (backward mapping pulls from further from center)
        const factor = strengthFactor * weight * 0.3;
        srcCanvasX = cx + dx * (1 + factor);
        srcCanvasY = cy + dy * (1 + factor);
      } else if (mode === 'twirl-cw' || mode === 'twirl-ccw') {
        const theta = twirlBaseAngle * weight;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        // Inverse rotation
        srcCanvasX = cx + dx * cosT + dy * sinT;
        srcCanvasY = cy - dx * sinT + dy * cosT;
      }

      // Convert from global canvas coords to ROI local coords for sampling
      const localSx = Math.max(0, Math.min(roiW - 1.0001, srcCanvasX - minX));
      const localSy = Math.max(0, Math.min(roiH - 1.0001, srcCanvasY - minY));

      const x0 = Math.floor(localSx);
      const y0 = Math.floor(localSy);
      const x1 = Math.min(roiW - 1, x0 + 1);
      const y1 = Math.min(roiH - 1, y0 + 1);

      const fx = localSx - x0;
      const fy = localSy - y0;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * roiW + x0) * 4;
      const i10 = (y0 * roiW + x1) * 4;
      const i01 = (y1 * roiW + x0) * 4;
      const i11 = (y1 * roiW + x1) * 4;

      dst[dstIdx] = Math.round(w00 * src[i00] + w10 * src[i10] + w01 * src[i01] + w11 * src[i11]);
      dst[dstIdx + 1] = Math.round(w00 * src[i00 + 1] + w10 * src[i10 + 1] + w01 * src[i01 + 1] + w11 * src[i11 + 1]);
      dst[dstIdx + 2] = Math.round(w00 * src[i00 + 2] + w10 * src[i10 + 2] + w01 * src[i01 + 2] + w11 * src[i11 + 2]);
      dst[dstIdx + 3] = Math.round(w00 * src[i00 + 3] + w10 * src[i10 + 3] + w01 * src[i01 + 3] + w11 * src[i11 + 3]);
    }
  }

  ctx.putImageData(dstImageData, minX, minY);

  // Synchronize secondary / source canvas if present
  if (sourceCanvas && sourceCanvas !== canvas) {
    const sCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    sCtx?.putImageData(dstImageData, minX, minY);
  }

  return { x: minX, y: minY, width: roiW, height: roiH };
}

/**
 * Creates a binary selection mask for active selection.
 */
export function createLiquifySelectionMask(
  selection: CanvasSelection | null,
  width: number,
  height: number
): Uint8Array | null {
  if (!selection) return null;

  if (selection.mask && selection.maskWidth === width && selection.maskHeight === height) {
    const mask = new Uint8Array(width * height);
    const src = selection.mask;
    for (let i = 0; i < src.length; i++) {
      if (src[i] >= 64) mask[i] = 1;
    }
    return mask;
  }

  const mask = new Uint8Array(width * height);
  const { bounds, type, polygon } = selection;

  if (type === 'rect') {
    const x0 = Math.max(0, Math.floor(bounds.x));
    const y0 = Math.max(0, Math.floor(bounds.y));
    const x1 = Math.min(width, Math.ceil(bounds.x + bounds.width));
    const y1 = Math.min(height, Math.ceil(bounds.y + bounds.height));

    for (let y = y0; y < y1; y++) {
      const rowOffset = y * width;
      mask.fill(1, rowOffset + x0, rowOffset + x1);
    }
    return mask;
  }

  if (type === 'lasso' && polygon && polygon.length >= 3) {
    const offCanvas = document.createElement('canvas');
    offCanvas.width = width;
    offCanvas.height = height;
    const ctx = offCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.beginPath();
    ctx.moveTo(polygon[0].x, polygon[0].y);
    for (let i = 1; i < polygon.length; i++) {
      ctx.lineTo(polygon[i].x, polygon[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    const imgData = ctx.getImageData(0, 0, width, height);
    const d = imgData.data;
    const totalPixels = width * height;
    for (let i = 0; i < totalPixels; i++) {
      if (d[i * 4 + 3] > 64) {
        mask[i] = 1;
      }
    }
    return mask;
  }

  return null;
}

function isLayerOrAncestorLocked(layer: LayerItem, layerMap: Map<string, LayerItem>): boolean {
  let current: LayerItem | undefined = layer;
  let guard = 0;
  while (current && guard < 32) {
    if (current.locked) return true;
    if (!current.parentId) break;
    current = layerMap.get(current.parentId);
    guard++;
  }
  return false;
}

function isDescendantOfAny(
  layer: LayerItem,
  ancestorIds: Set<string>,
  layerMap: Map<string, LayerItem>
): boolean {
  let parentId: string | null | undefined = layer.parentId;
  let guard = 0;
  while (parentId && guard < 32) {
    if (ancestorIds.has(parentId)) return true;
    parentId = layerMap.get(parentId)?.parentId;
    guard++;
  }
  return false;
}

/**
 * Resolves the raster layers targeted by a Liquify stroke.
 * - Single-layer mode: active layer only (if visible, unlocked raster).
 * - Multi-layer mode:
 *   - If 2+ layers are explicitly selected: all visible, unlocked raster layers in that selection
 *     (expanding any selected folders to their descendants).
 *   - Else if activeLayer is a folder/frame-folder: all visible, unlocked raster descendants.
 *   - Else: all visible, unlocked raster layers in the document.
 */
export function resolveLiquifyTargetLayers(
  layers: LayerItem[],
  activeLayer: LayerItem | undefined,
  selectedLayerIds: string[],
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean,
  multiLayer: boolean
): LayerItem[] {
  const layerMap = new Map<string, LayerItem>();
  for (const l of layers) {
    layerMap.set(l.id, l);
  }

  const isEditableRaster = (l: LayerItem): boolean =>
    l.type === 'raster' &&
    isLayerEffectivelyVisible(l) &&
    !isLayerOrAncestorLocked(l, layerMap);

  if (!multiLayer) {
    return activeLayer && isEditableRaster(activeLayer) ? [activeLayer] : [];
  }

  if (selectedLayerIds.length > 1) {
    const selectedSet = new Set(selectedLayerIds);
    const selectedFolders = new Set(
      layers.filter((l) => selectedSet.has(l.id) && isFolderLikeLayer(l)).map((l) => l.id)
    );
    return layers.filter(
      (l) =>
        isEditableRaster(l) &&
        (selectedSet.has(l.id) ||
          (selectedFolders.size > 0 && isDescendantOfAny(l, selectedFolders, layerMap)))
    );
  }

  if (activeLayer && isFolderLikeLayer(activeLayer)) {
    const folderSet = new Set([activeLayer.id]);
    return layers.filter(
      (l) => isEditableRaster(l) && isDescendantOfAny(l, folderSet, layerMap)
    );
  }

  return layers.filter(isEditableRaster);
}

export interface TileGridLiquifyStepParams {
  grid: SparseTileGrid;
  layerId: string;
  dimensions: CanvasDimensions;
  targetFormat: TileFormat;
  cx: number;
  cy: number;
  prevX: number;
  prevY: number;
  settings: LiquifySettings;
  pressure?: number;
  beforeTileSnapshot: Map<string, TileSnapshotEntry>;
  selectionMask?: Uint8Array | null;
}

/**
 * Tile-native liquify step: reads ONLY the brush ROI from SparseTileGrid,
 * lazily snapshots touched tiles before first mutation, performs bilinear displacement
 * (or reconstructs from beforeTileSnapshot), and writes ONLY the ROI back to tiles.
 * Zero full-document HTMLCanvasElement allocation.
 */
export function applyLiquifyStepOnTileGrid(params: TileGridLiquifyStepParams): DirtyRect | null {
  const {
    grid,
    layerId,
    dimensions,
    targetFormat,
    cx,
    cy,
    prevX,
    prevY,
    settings,
    pressure = 1.0,
    beforeTileSnapshot,
    selectionMask,
  } = params;

  const width = dimensions.width;
  const height = dimensions.height;
  if (width <= 0 || height <= 0) return null;

  const radius = Math.max(2, Math.round(settings.size / 2));
  const radiusSq = radius * radius;
  const pad = Math.min(32, Math.max(4, Math.ceil(radius * 0.2)));
  const minX = Math.max(0, Math.floor(cx - radius - pad));
  const minY = Math.max(0, Math.floor(cy - radius - pad));
  const maxX = Math.min(width, Math.ceil(cx + radius + pad));
  const maxY = Math.min(height, Math.ceil(cy + radius + pad));

  const roiW = maxX - minX;
  const roiH = maxY - minY;
  if (roiW <= 0 || roiH <= 0) return null;

  const vx = cx - prevX;
  const vy = cy - prevY;
  const vLen = Math.hypot(vx, vy);
  let ux = 0;
  let uy = 0;
  if (vLen > 0.0001) {
    ux = vx / vLen;
    uy = vy / vLen;
  }

  const mode = settings.mode;
  const isPushMode = mode === 'push' || mode === 'push-left' || mode === 'push-right';
  if (isPushMode && vLen < 0.0001) return null;

  const minTx = pixelToTileCoord(minX, 0);
  const minTy = pixelToTileCoord(minY, 0);
  const maxTx = pixelToTileCoord(maxX - 1, 0);
  const maxTy = pixelToTileCoord(maxY - 1, 0);

  // Skip completely empty ROI (unless reconstructing from a non-empty snapshot)
  let hasAnyPixel = false;
  for (let ty = minTy; ty <= maxTy && !hasAnyPixel; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (grid.hasTile(layerId, tx, ty, 0)) {
        hasAnyPixel = true;
        break;
      }
      if (mode === 'reconstruct') {
        const snap = beforeTileSnapshot.get(getTileKey(layerId, tx, ty, 0));
        if (snap && snap.data) {
          hasAnyPixel = true;
          break;
        }
      }
    }
  }
  if (!hasAnyPixel) return null;

  // Snapshot untouched tiles overlapping this ROI lazily before mutating
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      grid.snapshotSingleTileInto(layerId, tx, ty, beforeTileSnapshot);
    }
  }

  const srcBuf = grid.readImageData(layerId, minX, minY, roiW, roiH);
  const src = srcBuf.data;
  const dst = new Uint8ClampedArray(src);

  const hardnessFactor = Math.max(0, Math.min(1, settings.hardness / 100));
  const effectivePressure = settings.usePressure ? Math.max(0.1, pressure) : 1.0;
  const strengthFactor = (settings.strength / 100) * effectivePressure;
  const twirlBaseAngle = (mode === 'twirl-cw' ? 1 : -1) * (strengthFactor * 0.45);

  // Lazy unpacked cache of initial pre-stroke tiles when in reconstruct mode
  let initRoiData: Uint8ClampedArray | null = null;
  if (mode === 'reconstruct') {
    initRoiData = new Uint8ClampedArray(roiW * roiH * 4);
    const scratch = new Uint8ClampedArray(BYTES_32BIT);
    for (let ty = minTy; ty <= maxTy; ty++) {
      const tileDocY = ty * TILE_SIZE;
      for (let tx = minTx; tx <= maxTx; tx++) {
        const snap = beforeTileSnapshot.get(getTileKey(layerId, tx, ty, 0));
        if (!snap || !snap.data) continue;
        let tileRgba: Uint8ClampedArray;
        if (snap.format === 'color-32bit') {
          tileRgba = new Uint8ClampedArray(snap.data.buffer, snap.data.byteOffset, BYTES_32BIT);
        } else if (snap.format === 'monochrome-1bit') {
          unpack1BitToRGBA(snap.data, scratch);
          tileRgba = scratch;
        } else {
          unpack8BitToRGBA(snap.data, scratch);
          tileRgba = scratch;
        }
        const tileDocX = tx * TILE_SIZE;
        const interX0 = Math.max(minX, tileDocX);
        const interY0 = Math.max(minY, tileDocY);
        const interX1 = Math.min(maxX, tileDocX + TILE_SIZE);
        const interY1 = Math.min(maxY, tileDocY + TILE_SIZE);
        const copyW = interX1 - interX0;
        if (copyW <= 0 || interY1 <= interY0) continue;
        for (let py = interY0; py < interY1; py++) {
          const sOff = ((py - tileDocY) * TILE_SIZE + (interX0 - tileDocX)) << 2;
          const dOff = ((py - minY) * roiW + (interX0 - minX)) << 2;
          initRoiData.set(tileRgba.subarray(sOff, sOff + (copyW << 2)), dOff);
        }
      }
    }
  }

  for (let ry = 0; ry < roiH; ry++) {
    const py = minY + ry;
    const dy = py - cy;
    const rowOffset = ry * roiW * 4;

    for (let rx = 0; rx < roiW; rx++) {
      const px = minX + rx;
      const dx = px - cx;
      const distSq = dx * dx + dy * dy;
      if (distSq >= radiusSq) continue;
      if (selectionMask && selectionMask[py * width + px] === 0) continue;

      const dist = Math.sqrt(distSq);
      const weight = computeFalloffWeight(dist, radius, hardnessFactor);
      if (weight <= 0) continue;

      const dstIdx = rowOffset + rx * 4;

      if (mode === 'reconstruct') {
        if (!initRoiData) continue;
        const alpha = Math.min(1, strengthFactor * weight * 0.35);
        dst[dstIdx] = Math.round(dst[dstIdx] * (1 - alpha) + initRoiData[dstIdx] * alpha);
        dst[dstIdx + 1] = Math.round(dst[dstIdx + 1] * (1 - alpha) + initRoiData[dstIdx + 1] * alpha);
        dst[dstIdx + 2] = Math.round(dst[dstIdx + 2] * (1 - alpha) + initRoiData[dstIdx + 2] * alpha);
        dst[dstIdx + 3] = Math.round(dst[dstIdx + 3] * (1 - alpha) + initRoiData[dstIdx + 3] * alpha);
        continue;
      }

      let srcCanvasX = px;
      let srcCanvasY = py;
      if (mode === 'push') {
        const pushAmount = vLen * strengthFactor * weight;
        srcCanvasX = px - ux * pushAmount;
        srcCanvasY = py - uy * pushAmount;
      } else if (mode === 'push-left') {
        const pushAmount = Math.max(1.5, vLen) * strengthFactor * weight;
        srcCanvasX = px + uy * pushAmount;
        srcCanvasY = py - ux * pushAmount;
      } else if (mode === 'push-right') {
        const pushAmount = Math.max(1.5, vLen) * strengthFactor * weight;
        srcCanvasX = px - uy * pushAmount;
        srcCanvasY = py + ux * pushAmount;
      } else if (mode === 'expand') {
        const factor = strengthFactor * weight * 0.3;
        srcCanvasX = cx + dx * (1 - factor);
        srcCanvasY = cy + dy * (1 - factor);
      } else if (mode === 'pinch') {
        const factor = strengthFactor * weight * 0.3;
        srcCanvasX = cx + dx * (1 + factor);
        srcCanvasY = cy + dy * (1 + factor);
      } else if (mode === 'twirl-cw' || mode === 'twirl-ccw') {
        const theta = twirlBaseAngle * weight;
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);
        srcCanvasX = cx + dx * cosT + dy * sinT;
        srcCanvasY = cy - dx * sinT + dy * cosT;
      }

      const localSx = Math.max(0, Math.min(roiW - 1.0001, srcCanvasX - minX));
      const localSy = Math.max(0, Math.min(roiH - 1.0001, srcCanvasY - minY));
      const x0 = Math.floor(localSx);
      const y0 = Math.floor(localSy);
      const x1 = Math.min(roiW - 1, x0 + 1);
      const y1 = Math.min(roiH - 1, y0 + 1);
      const fx = localSx - x0;
      const fy = localSy - y0;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * roiW + x0) * 4;
      const i10 = (y0 * roiW + x1) * 4;
      const i01 = (y1 * roiW + x0) * 4;
      const i11 = (y1 * roiW + x1) * 4;

      dst[dstIdx] = Math.round(w00 * src[i00] + w10 * src[i10] + w01 * src[i01] + w11 * src[i11]);
      dst[dstIdx + 1] = Math.round(w00 * src[i00 + 1] + w10 * src[i10 + 1] + w01 * src[i01 + 1] + w11 * src[i11 + 1]);
      dst[dstIdx + 2] = Math.round(w00 * src[i00 + 2] + w10 * src[i10 + 2] + w01 * src[i01 + 2] + w11 * src[i11 + 2]);
      dst[dstIdx + 3] = Math.round(w00 * src[i00 + 3] + w10 * src[i10 + 3] + w01 * src[i01 + 3] + w11 * src[i11 + 3]);
    }
  }

  grid.writeImageData(layerId, { data: dst, width: roiW, height: roiH }, minX, minY, targetFormat, true);
  return { x: minX, y: minY, width: roiW, height: roiH };
}

/**
 * Async tile-native liquify step: offloads ROI bilinear displacement to the
 * Rayon-parallel Rust backend when running in Tauri, falling back to sync JS on Web/Vitest.
 */
export async function applyLiquifyStepOnTileGridAsync(
  params: TileGridLiquifyStepParams
): Promise<DirtyRect | null> {
  if (!isNativeRustAvailable()) {
    return applyLiquifyStepOnTileGrid(params);
  }

  const {
    grid,
    layerId,
    dimensions,
    targetFormat,
    cx,
    cy,
    prevX,
    prevY,
    settings,
    pressure = 1.0,
    beforeTileSnapshot,
    selectionMask,
  } = params;

  const width = dimensions.width;
  const height = dimensions.height;
  if (width <= 0 || height <= 0) return null;

  const radius = Math.max(2, Math.round(settings.size / 2));
  const pad = Math.min(32, Math.max(4, Math.ceil(radius * 0.2)));
  const minX = Math.max(0, Math.floor(cx - radius - pad));
  const minY = Math.max(0, Math.floor(cy - radius - pad));
  const maxX = Math.min(width, Math.ceil(cx + radius + pad));
  const maxY = Math.min(height, Math.ceil(cy + radius + pad));

  const roiW = maxX - minX;
  const roiH = maxY - minY;
  if (roiW <= 0 || roiH <= 0) return null;

  const vx = cx - prevX;
  const vy = cy - prevY;
  const vLen = Math.hypot(vx, vy);
  let ux = 0;
  let uy = 0;
  if (vLen > 0.0001) {
    ux = vx / vLen;
    uy = vy / vLen;
  }

  const mode = settings.mode;
  const isPushMode = mode === 'push' || mode === 'push-left' || mode === 'push-right';
  if (isPushMode && vLen < 0.0001) return null;

  const minTx = pixelToTileCoord(minX, 0);
  const minTy = pixelToTileCoord(minY, 0);
  const maxTx = pixelToTileCoord(maxX - 1, 0);
  const maxTy = pixelToTileCoord(maxY - 1, 0);

  let hasAnyPixel = false;
  for (let ty = minTy; ty <= maxTy && !hasAnyPixel; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (grid.hasTile(layerId, tx, ty, 0)) {
        hasAnyPixel = true;
        break;
      }
      if (mode === 'reconstruct') {
        const snap = beforeTileSnapshot.get(getTileKey(layerId, tx, ty, 0));
        if (snap && snap.data) {
          hasAnyPixel = true;
          break;
        }
      }
    }
  }
  if (!hasAnyPixel) return null;

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      grid.snapshotSingleTileInto(layerId, tx, ty, beforeTileSnapshot);
    }
  }

  const srcBuf = grid.readImageData(layerId, minX, minY, roiW, roiH);
  const hardnessFactor = Math.max(0, Math.min(1, settings.hardness / 100));
  const effectivePressure = settings.usePressure ? Math.max(0.1, pressure) : 1.0;
  const strengthFactor = (settings.strength / 100) * effectivePressure;

  let initRoiData: Uint8ClampedArray | null = null;
  if (mode === 'reconstruct') {
    initRoiData = new Uint8ClampedArray(roiW * roiH * 4);
    const scratch = new Uint8ClampedArray(BYTES_32BIT);
    for (let ty = minTy; ty <= maxTy; ty++) {
      const tileDocY = ty * TILE_SIZE;
      for (let tx = minTx; tx <= maxTx; tx++) {
        const snap = beforeTileSnapshot.get(getTileKey(layerId, tx, ty, 0));
        if (!snap || !snap.data) continue;
        let tileRgba: Uint8ClampedArray;
        if (snap.format === 'color-32bit') {
          tileRgba = new Uint8ClampedArray(snap.data.buffer, snap.data.byteOffset, BYTES_32BIT);
        } else if (snap.format === 'monochrome-1bit') {
          unpack1BitToRGBA(snap.data, scratch);
          tileRgba = scratch;
        } else {
          unpack8BitToRGBA(snap.data, scratch);
          tileRgba = scratch;
        }
        const tileDocX = tx * TILE_SIZE;
        const interX0 = Math.max(minX, tileDocX);
        const interY0 = Math.max(minY, tileDocY);
        const interX1 = Math.min(maxX, tileDocX + TILE_SIZE);
        const interY1 = Math.min(maxY, tileDocY + TILE_SIZE);
        const copyW = interX1 - interX0;
        if (copyW <= 0 || interY1 <= interY0) continue;
        for (let py = interY0; py < interY1; py++) {
          const sOff = ((py - tileDocY) * TILE_SIZE + (interX0 - tileDocX)) << 2;
          const dOff = ((py - minY) * roiW + (interX0 - minX)) << 2;
          initRoiData.set(tileRgba.subarray(sOff, sOff + (copyW << 2)), dOff);
        }
      }
    }
  }

  let selMaskRoi: Uint8Array | null = null;
  if (selectionMask) {
    selMaskRoi = new Uint8Array(roiW * roiH);
    for (let ry = 0; ry < roiH; ry++) {
      const sOff = (minY + ry) * width + minX;
      selMaskRoi.set(selectionMask.subarray(sOff, sOff + roiW), ry * roiW);
    }
  }

  const dst = await liquifyStepNative({
    srcRoi: srcBuf.data,
    initRoi: initRoiData,
    selMaskRoi,
    roiW,
    roiH,
    minX,
    minY,
    cx,
    cy,
    ux,
    uy,
    vLen,
    radius,
    hardness: hardnessFactor,
    strength: strengthFactor,
    mode,
  });

  grid.writeImageData(layerId, { data: dst, width: roiW, height: roiH }, minX, minY, targetFormat, true);
  return { x: minX, y: minY, width: roiW, height: roiH };
}
