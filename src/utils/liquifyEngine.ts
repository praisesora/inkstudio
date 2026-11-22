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

  vec4 cubicWeights(float f) {
    float f2 = f * f;
    float f3 = f2 * f;
    return vec4(
      -0.5 * f + f2 - 0.5 * f3,
      1.0 - 2.5 * f2 + 1.5 * f3,
      0.5 * f + 2.0 * f2 - 1.5 * f3,
      -0.5 * f2 + 0.5 * f3
    );
  }

  vec4 fetchRow(vec2 base, float dy, vec4 wx, vec2 invSize, vec2 maxIdx) {
    float y = (clamp(base.y + dy, 0.0, maxIdx.y) + 0.5) * invSize.y;
    float x0 = (clamp(base.x - 1.0, 0.0, maxIdx.x) + 0.5) * invSize.x;
    float x1 = (clamp(base.x,       0.0, maxIdx.x) + 0.5) * invSize.x;
    float x2 = (clamp(base.x + 1.0, 0.0, maxIdx.x) + 0.5) * invSize.x;
    float x3 = (clamp(base.x + 2.0, 0.0, maxIdx.x) + 0.5) * invSize.x;
    return texture2D(u_sourceTex, vec2(x0, y)) * wx.x
         + texture2D(u_sourceTex, vec2(x1, y)) * wx.y
         + texture2D(u_sourceTex, vec2(x2, y)) * wx.z
         + texture2D(u_sourceTex, vec2(x3, y)) * wx.w;
  }

  void main() {
    // Exact integer pixel coordinate matching CPU (rx, ry) with WebGL Y-flip accounted for
    vec2 localPos = vec2(v_uv.x * u_roiSize.x, (1.0 - v_uv.y) * u_roiSize.y) - 0.5;
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

    vec2 maxIdx = u_roiSize - 1.0;
    vec2 sampleLocal = clamp(srcCanvas - u_roiOrigin, vec2(0.0), maxIdx);
    vec2 base = floor(sampleLocal);
    vec2 f = sampleLocal - base;
    vec4 wx = cubicWeights(f.x);
    vec4 wy = cubicWeights(f.y);
    vec2 invSize = 1.0 / u_roiSize;

    vec4 c = fetchRow(base, -1.0, wx, invSize, maxIdx) * wy.x
           + fetchRow(base,  0.0, wx, invSize, maxIdx) * wy.y
           + fetchRow(base,  1.0, wx, invSize, maxIdx) * wy.z
           + fetchRow(base,  2.0, wx, invSize, maxIdx) * wy.w;

    float a = clamp(c.a, 0.0, 1.0);
    gl_FragColor = vec4(clamp(c.rgb, vec3(0.0), vec3(a)), a);
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
      const gl = (this.canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true }) ||
        this.canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true })) as WebGLRenderingContext | null;
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
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.roiStagingCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

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
 * Premultiplied linear blend toward a target pixel (used by reconstruct mode to prevent dark fringes).
 */
function blendPremulToward(
  dst: Uint8ClampedArray,
  dstIdx: number,
  target: Uint8ClampedArray,
  targetIdx: number,
  alpha: number
): void {
  const inv = 1 - alpha;
  const dA = dst[dstIdx + 3];
  const tA = target[targetIdx + 3];
  const outA = dA * inv + tA * alpha;
  if (outA <= 0.5) {
    dst[dstIdx] = 0;
    dst[dstIdx + 1] = 0;
    dst[dstIdx + 2] = 0;
    dst[dstIdx + 3] = 0;
    return;
  }
  const invOut = 1 / outA;
  const r = (dst[dstIdx] * dA * inv + target[targetIdx] * tA * alpha) * invOut;
  const g = (dst[dstIdx + 1] * dA * inv + target[targetIdx + 1] * tA * alpha) * invOut;
  const b = (dst[dstIdx + 2] * dA * inv + target[targetIdx + 2] * tA * alpha) * invOut;
  dst[dstIdx] = r <= 0 ? 0 : r >= 255 ? 255 : Math.round(r);
  dst[dstIdx + 1] = g <= 0 ? 0 : g >= 255 ? 255 : Math.round(g);
  dst[dstIdx + 2] = b <= 0 ? 0 : b >= 255 ? 255 : Math.round(b);
  dst[dstIdx + 3] = outA >= 255 ? 255 : Math.round(outA);
}

/**
 * Premultiplied 4x4 Catmull-Rom (Keys a=-0.5) bicubic sample from a flat RGBA buffer.
 * Eliminates bilinear softening and straight-alpha black fringing on brushes and smudges.
 */
function samplePremulBicubicBuffer(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  dst: Uint8ClampedArray,
  dstIdx: number
): void {
  const maxX = w - 1;
  const maxY = h - 1;
  const cx = sx <= 0 ? 0 : sx >= maxX ? maxX : sx;
  const cy = sy <= 0 ? 0 : sy >= maxY ? maxY : sy;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;

  if (fx < 1e-5 && fy < 1e-5) {
    const off = (y0 * w + x0) << 2;
    dst[dstIdx] = src[off];
    dst[dstIdx + 1] = src[off + 1];
    dst[dstIdx + 2] = src[off + 2];
    dst[dstIdx + 3] = src[off + 3];
    return;
  }

  const fx2 = fx * fx;
  const fx3 = fx2 * fx;
  const wx0 = -0.5 * fx + fx2 - 0.5 * fx3;
  const wx1 = 1.0 - 2.5 * fx2 + 1.5 * fx3;
  const wx2 = 0.5 * fx + 2.0 * fx2 - 1.5 * fx3;
  const wx3 = -0.5 * fx2 + 0.5 * fx3;

  const fy2 = fy * fy;
  const fy3 = fy2 * fy;
  const wy0 = -0.5 * fy + fy2 - 0.5 * fy3;
  const wy1 = 1.0 - 2.5 * fy2 + 1.5 * fy3;
  const wy2 = 0.5 * fy + 2.0 * fy2 - 1.5 * fy3;
  const wy3 = -0.5 * fy2 + 0.5 * fy3;

  const ix0 = x0 > 0 ? x0 - 1 : 0;
  const ix1 = x0;
  const ix2 = x0 < maxX ? x0 + 1 : maxX;
  const ix3 = x0 + 2 <= maxX ? x0 + 2 : maxX;

  let sumPR = 0;
  let sumPG = 0;
  let sumPB = 0;
  let sumA = 0;

  for (let row = 0; row < 4; row++) {
    const wy = row === 0 ? wy0 : row === 1 ? wy1 : row === 2 ? wy2 : wy3;
    const rawY = y0 + row - 1;
    const iy = rawY <= 0 ? 0 : rawY >= maxY ? maxY : rawY;
    const rowBase = iy * w;

    const o0 = (rowBase + ix0) << 2;
    const o1 = (rowBase + ix1) << 2;
    const o2 = (rowBase + ix2) << 2;
    const o3 = (rowBase + ix3) << 2;

    const a0 = src[o0 + 3];
    const a1 = src[o1 + 3];
    const a2 = src[o2 + 3];
    const a3 = src[o3 + 3];
    if ((a0 | a1 | a2 | a3) === 0) continue;

    let rPR = 0;
    let rPG = 0;
    let rPB = 0;
    let rA = 0;

    if (a0 !== 0) {
      const wa = wx0 * a0;
      rPR += wa * src[o0];
      rPG += wa * src[o0 + 1];
      rPB += wa * src[o0 + 2];
      rA += wa;
    }
    if (a1 !== 0) {
      const wa = wx1 * a1;
      rPR += wa * src[o1];
      rPG += wa * src[o1 + 1];
      rPB += wa * src[o1 + 2];
      rA += wa;
    }
    if (a2 !== 0) {
      const wa = wx2 * a2;
      rPR += wa * src[o2];
      rPG += wa * src[o2 + 1];
      rPB += wa * src[o2 + 2];
      rA += wa;
    }
    if (a3 !== 0) {
      const wa = wx3 * a3;
      rPR += wa * src[o3];
      rPG += wa * src[o3 + 1];
      rPB += wa * src[o3 + 2];
      rA += wa;
    }

    sumPR += wy * rPR;
    sumPG += wy * rPG;
    sumPB += wy * rPB;
    sumA += wy * rA;
  }

  if (sumA <= 0.5) {
    dst[dstIdx] = 0;
    dst[dstIdx + 1] = 0;
    dst[dstIdx + 2] = 0;
    dst[dstIdx + 3] = 0;
    return;
  }

  const invA = 1 / sumA;
  const r = sumPR * invA;
  const g = sumPG * invA;
  const b = sumPB * invA;
  dst[dstIdx] = r <= 0 ? 0 : r >= 255 ? 255 : Math.round(r);
  dst[dstIdx + 1] = g <= 0 ? 0 : g >= 255 ? 255 : Math.round(g);
  dst[dstIdx + 2] = b <= 0 ? 0 : b >= 255 ? 255 : Math.round(b);
  dst[dstIdx + 3] = sumA >= 255 ? 255 : Math.round(sumA);
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
        blendPremulToward(dst, dstIdx, initData, initIdx, alpha);
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

      samplePremulBicubicBuffer(src, roiW, roiH, srcCanvasX - minX, srcCanvasY - minY, dst, dstIdx);
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
        blendPremulToward(dst, dstIdx, initRoiData, dstIdx, alpha);
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

      samplePremulBicubicBuffer(src, roiW, roiH, srcCanvasX - minX, srcCanvasY - minY, dst, dstIdx);
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

// ---------------------------------------------------------------------------
// Zero-Compound-Blur Accumulated Displacement Field Liquify Pipeline
// ---------------------------------------------------------------------------

const WARP_TILE_SIZE = 128;
const WARP_TILE_SHIFT = 7;
const WARP_TILE_MASK = 127;
const WARP_TILE_FLOATS = WARP_TILE_SIZE * WARP_TILE_SIZE * 2;

function numericTileKey(tx: number, ty: number): number {
  return (ty + 32768) * 65536 + (tx + 32768);
}

export interface LiquifySubStep {
  cx: number;
  cy: number;
  prevX: number;
  prevY: number;
  pressure?: number;
}

/**
 * Sparse 128x128 Float32 inverse-displacement field storing relative source offsets (dx, dy)
 * so every pixel in a Liquify stroke is resampled ONCE from pristine pre-stroke pixels
 * instead of suffering compounded N-step blur.
 * Shared across all target layers during multi-layer Liquify.
 */
export class LiquifyWarpField {
  private tiles = new Map<number, Float32Array>();
  private scratchNext = new Float32Array(0);
  private scratchMask = new Uint8Array(0);
  private tmpDisp: [number, number] = [0, 0];

  public getDisplacement(px: number, py: number, out: [number, number]): void {
    const tile = this.tiles.get(numericTileKey(px >> WARP_TILE_SHIFT, py >> WARP_TILE_SHIFT));
    if (!tile) {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    const idx = (((py & WARP_TILE_MASK) << WARP_TILE_SHIFT) | (px & WARP_TILE_MASK)) << 1;
    out[0] = tile[idx];
    out[1] = tile[idx + 1];
  }

  public sampleDisplacement(
    sx: number,
    sy: number,
    width: number,
    height: number,
    out: [number, number]
  ): void {
    const cx = sx <= 0 ? 0 : sx >= width - 1 ? width - 1 : sx;
    const cy = sy <= 0 ? 0 : sy >= height - 1 ? height - 1 : sy;
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = x0 + 1 < width ? x0 + 1 : x0;
    const y1 = y0 + 1 < height ? y0 + 1 : y0;
    const fx = cx - x0;
    const fy = cy - y0;

    const tx0 = x0 >> WARP_TILE_SHIFT;
    const ty0 = y0 >> WARP_TILE_SHIFT;
    const tx1 = x1 >> WARP_TILE_SHIFT;
    const ty1 = y1 >> WARP_TILE_SHIFT;

    if (tx0 === tx1 && ty0 === ty1) {
      const tile = this.tiles.get(numericTileKey(tx0, ty0));
      if (!tile) {
        out[0] = 0;
        out[1] = 0;
        return;
      }
      const lx0 = x0 & WARP_TILE_MASK;
      const ly0 = y0 & WARP_TILE_MASK;
      const lx1 = x1 & WARP_TILE_MASK;
      const ly1 = y1 & WARP_TILE_MASK;
      const i00 = ((ly0 << WARP_TILE_SHIFT) | lx0) << 1;
      const i10 = ((ly0 << WARP_TILE_SHIFT) | lx1) << 1;
      const i01 = ((ly1 << WARP_TILE_SHIFT) | lx0) << 1;
      const i11 = ((ly1 << WARP_TILE_SHIFT) | lx1) << 1;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      out[0] = w00 * tile[i00] + w10 * tile[i10] + w01 * tile[i01] + w11 * tile[i11];
      out[1] = w00 * tile[i00 + 1] + w10 * tile[i10 + 1] + w01 * tile[i01 + 1] + w11 * tile[i11 + 1];
      return;
    }

    const t00 = this.tiles.get(numericTileKey(tx0, ty0));
    const t10 = this.tiles.get(numericTileKey(tx1, ty0));
    const t01 = this.tiles.get(numericTileKey(tx0, ty1));
    const t11 = this.tiles.get(numericTileKey(tx1, ty1));
    if (!t00 && !t10 && !t01 && !t11) {
      out[0] = 0;
      out[1] = 0;
      return;
    }

    const lx0 = x0 & WARP_TILE_MASK;
    const ly0 = y0 & WARP_TILE_MASK;
    const lx1 = x1 & WARP_TILE_MASK;
    const ly1 = y1 & WARP_TILE_MASK;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;

    let dx = 0;
    let dy = 0;
    if (t00) {
      const i = ((ly0 << WARP_TILE_SHIFT) | lx0) << 1;
      dx += w00 * t00[i];
      dy += w00 * t00[i + 1];
    }
    if (t10) {
      const i = ((ly0 << WARP_TILE_SHIFT) | lx1) << 1;
      dx += w10 * t10[i];
      dy += w10 * t10[i + 1];
    }
    if (t01) {
      const i = ((ly1 << WARP_TILE_SHIFT) | lx0) << 1;
      dx += w01 * t01[i];
      dy += w01 * t01[i + 1];
    }
    if (t11) {
      const i = ((ly1 << WARP_TILE_SHIFT) | lx1) << 1;
      dx += w11 * t11[i];
      dy += w11 * t11[i + 1];
    }
    out[0] = dx;
    out[1] = dy;
  }

  public hasAnyWarp(): boolean {
    return this.tiles.size > 0;
  }

  /**
   * Composes 1..N Liquify sub-steps into the float32 displacement field and returns the
   * union pixel rect that changed.
   */
  public applySubSteps(
    steps: LiquifySubStep[],
    dimensions: CanvasDimensions,
    settings: LiquifySettings,
    selectionMask?: Uint8Array | null
  ): DirtyRect | null {
    const width = dimensions.width;
    const height = dimensions.height;
    if (width <= 0 || height <= 0 || steps.length === 0) return null;

    const radius = Math.max(2, Math.round(settings.size / 2));
    const radiusSq = radius * radius;
    const hardnessFactor = Math.max(0, Math.min(1, settings.hardness / 100));
    const mode = settings.mode;
    const isPushMode = mode === 'push' || mode === 'push-left' || mode === 'push-right';
    const tmp = this.tmpDisp;

    let unionMinX = width;
    let unionMinY = height;
    let unionMaxX = 0;
    let unionMaxY = 0;
    let anyModified = false;

    for (let s = 0; s < steps.length; s++) {
      const step = steps[s];
      const cx = step.cx;
      const cy = step.cy;
      const vx = cx - step.prevX;
      const vy = cy - step.prevY;
      const vLen = Math.hypot(vx, vy);
      if (isPushMode && vLen < 0.0001) continue;

      let ux = 0;
      let uy = 0;
      if (vLen > 0.0001) {
        ux = vx / vLen;
        uy = vy / vLen;
      }

      const effectivePressure = settings.usePressure ? Math.max(0.1, step.pressure ?? 1.0) : 1.0;
      const strengthFactor = (settings.strength / 100) * effectivePressure;
      const twirlBaseAngle = (mode === 'twirl-cw' ? 1 : -1) * (strengthFactor * 0.45);

      const minX = Math.max(0, Math.floor(cx - radius));
      const minY = Math.max(0, Math.floor(cy - radius));
      const maxX = Math.min(width, Math.ceil(cx + radius));
      const maxY = Math.min(height, Math.ceil(cy + radius));
      const roiW = maxX - minX;
      const roiH = maxY - minY;
      if (roiW <= 0 || roiH <= 0) continue;

      const pixelCount = roiW * roiH;
      if (this.scratchNext.length < pixelCount * 2) {
        this.scratchNext = new Float32Array(pixelCount * 2);
      }
      if (this.scratchMask.length < pixelCount) {
        this.scratchMask = new Uint8Array(pixelCount);
      }
      const nextBuf = this.scratchNext;
      const maskBuf = this.scratchMask;
      maskBuf.fill(0, 0, pixelCount);

      let stepModified = false;

      // Read-only pass against this.tiles -> write composed displacement into scratchNext
      for (let ry = 0; ry < roiH; ry++) {
        const py = minY + ry;
        const dy = py - cy;
        const dySq = dy * dy;
        if (dySq >= radiusSq) continue;
        const rowPixelBase = ry * roiW;
        const selRowOff = py * width;

        for (let rx = 0; rx < roiW; rx++) {
          const px = minX + rx;
          const dx = px - cx;
          const distSq = dx * dx + dySq;
          if (distSq >= radiusSq) continue;
          if (selectionMask && selectionMask[selRowOff + px] === 0) continue;

          const dist = Math.sqrt(distSq);
          const weight = computeFalloffWeight(dist, radius, hardnessFactor);
          if (weight <= 0) continue;

          const pIdx = rowPixelBase + rx;
          const fIdx = pIdx << 1;

          if (mode === 'reconstruct') {
            this.getDisplacement(px, py, tmp);
            if (tmp[0] === 0 && tmp[1] === 0) continue;
            const alpha = Math.min(1, strengthFactor * weight * 0.35);
            const keep = 1 - alpha;
            const ndx = tmp[0] * keep;
            const ndy = tmp[1] * keep;
            nextBuf[fIdx] = Math.abs(ndx) < 1e-4 ? 0 : ndx;
            nextBuf[fIdx + 1] = Math.abs(ndy) < 1e-4 ? 0 : ndy;
            maskBuf[pIdx] = 1;
            stepModified = true;
            continue;
          }

          let qx = px;
          let qy = py;
          if (mode === 'push') {
            const pushAmount = vLen * strengthFactor * weight;
            qx = px - ux * pushAmount;
            qy = py - uy * pushAmount;
          } else if (mode === 'push-left') {
            const pushAmount = Math.max(1.5, vLen) * strengthFactor * weight;
            qx = px + uy * pushAmount;
            qy = py - ux * pushAmount;
          } else if (mode === 'push-right') {
            const pushAmount = Math.max(1.5, vLen) * strengthFactor * weight;
            qx = px - uy * pushAmount;
            qy = py + ux * pushAmount;
          } else if (mode === 'expand') {
            const factor = strengthFactor * weight * 0.3;
            qx = cx + dx * (1 - factor);
            qy = cy + dy * (1 - factor);
          } else if (mode === 'pinch') {
            const factor = strengthFactor * weight * 0.3;
            qx = cx + dx * (1 + factor);
            qy = cy + dy * (1 + factor);
          } else if (mode === 'twirl-cw' || mode === 'twirl-ccw') {
            const theta = twirlBaseAngle * weight;
            const cosT = Math.cos(theta);
            const sinT = Math.sin(theta);
            qx = cx + dx * cosT + dy * sinT;
            qy = cy - dx * sinT + dy * cosT;
          }

          this.sampleDisplacement(qx, qy, width, height, tmp);
          let srcX = qx + tmp[0];
          let srcY = qy + tmp[1];
          if (srcX < 0) srcX = 0;
          else if (srcX > width - 1) srcX = width - 1;
          if (srcY < 0) srcY = 0;
          else if (srcY > height - 1) srcY = height - 1;

          nextBuf[fIdx] = srcX - px;
          nextBuf[fIdx + 1] = srcY - py;
          maskBuf[pIdx] = 1;
          stepModified = true;
        }
      }

      if (!stepModified) continue;

      // Scatter updated displacements back into sparse float32 warp tiles
      let cachedKey = -1;
      let cachedTile: Float32Array | null = null;
      for (let ry = 0; ry < roiH; ry++) {
        const py = minY + ry;
        const ty = py >> WARP_TILE_SHIFT;
        const lyShift = (py & WARP_TILE_MASK) << WARP_TILE_SHIFT;
        const rowPixelBase = ry * roiW;

        for (let rx = 0; rx < roiW; rx++) {
          const pIdx = rowPixelBase + rx;
          if (maskBuf[pIdx] === 0) continue;
          const px = minX + rx;
          const tx = px >> WARP_TILE_SHIFT;
          const k = numericTileKey(tx, ty);
          if (k !== cachedKey) {
            cachedKey = k;
            let t = this.tiles.get(k);
            if (!t) {
              t = new Float32Array(WARP_TILE_FLOATS);
              this.tiles.set(k, t);
            }
            cachedTile = t;
          }
          const tIdx = (lyShift | (px & WARP_TILE_MASK)) << 1;
          const fIdx = pIdx << 1;
          cachedTile![tIdx] = nextBuf[fIdx];
          cachedTile![tIdx + 1] = nextBuf[fIdx + 1];
        }
      }

      if (minX < unionMinX) unionMinX = minX;
      if (minY < unionMinY) unionMinY = minY;
      if (maxX > unionMaxX) unionMaxX = maxX;
      if (maxY > unionMaxY) unionMaxY = maxY;
      anyModified = true;
    }

    if (!anyModified || unionMaxX <= unionMinX || unionMaxY <= unionMinY) return null;
    return {
      x: unionMinX,
      y: unionMinY,
      width: unionMaxX - unionMinX,
      height: unionMaxY - unionMinY,
    };
  }

  public clear(): void {
    this.tiles.clear();
    this.scratchNext = new Float32Array(0);
    this.scratchMask = new Uint8Array(0);
  }
}

export interface ResampleWarpLayerParams {
  grid: SparseTileGrid;
  layerId: string;
  dimensions: CanvasDimensions;
  targetFormat: TileFormat;
  warpField: LiquifyWarpField;
  dirtyRect: DirtyRect;
  beforeTileSnapshot: Map<string, TileSnapshotEntry>;
  origRgbaCache: Map<number, Uint8ClampedArray | null>;
}

/**
 * Single-pass premultiplied 4x4 Catmull-Rom bicubic resample of a layer's dirtyRect
 * directly from its pristine pre-stroke tiles using the accumulated LiquifyWarpField.
 * Zero compounded blur and zero dark alpha fringes across arbitrarily long strokes.
 */
export function resampleLayerFromWarpField(params: ResampleWarpLayerParams): DirtyRect | null {
  const {
    grid,
    layerId,
    dimensions,
    targetFormat,
    warpField,
    dirtyRect,
    beforeTileSnapshot,
    origRgbaCache,
  } = params;

  const width = dimensions.width;
  const height = dimensions.height;
  const minX = Math.max(0, dirtyRect.x);
  const minY = Math.max(0, dirtyRect.y);
  const maxX = Math.min(width, dirtyRect.x + dirtyRect.width);
  const maxY = Math.min(height, dirtyRect.y + dirtyRect.height);
  const roiW = maxX - minX;
  const roiH = maxY - minY;
  if (roiW <= 0 || roiH <= 0) return null;

  // Snapshot all destination tiles intersecting dirtyRect BEFORE mutating grid,
  // and prime origRgbaCache so every mutated tile preserves its pristine pre-session pixels
  // across multi-stroke Liquify sessions.
  const minTx = pixelToTileCoord(minX, 0);
  const minTy = pixelToTileCoord(minY, 0);
  const maxTx = pixelToTileCoord(maxX - 1, 0);
  const maxTy = pixelToTileCoord(maxY - 1, 0);

  // Lazy O(1) cache of pristine pre-stroke 256x256 RGBA tiles
  let lastTileKey = -1;
  let lastTile: Uint8ClampedArray | null = null;

  const getOrigTile = (tx: number, ty: number): Uint8ClampedArray | null => {
    const k = numericTileKey(tx, ty);
    if (k === lastTileKey) return lastTile;

    let cached = origRgbaCache.get(k);
    if (cached === undefined) {
      const snap = beforeTileSnapshot.get(getTileKey(layerId, tx, ty, 0));
      if (snap !== undefined) {
        if (!snap.data) {
          cached = null;
        } else if (snap.format === 'color-32bit') {
          cached = new Uint8ClampedArray(snap.data.buffer, snap.data.byteOffset, BYTES_32BIT);
        } else if (snap.format === 'monochrome-1bit') {
          cached = new Uint8ClampedArray(BYTES_32BIT);
          unpack1BitToRGBA(snap.data, cached);
        } else {
          cached = new Uint8ClampedArray(BYTES_32BIT);
          unpack8BitToRGBA(snap.data, cached);
        }
      } else {
        const tile = grid.getTile(layerId, tx, ty, 0);
        if (!tile || !tile.data) {
          cached = null;
        } else {
          const rgba = grid.getTileAsRGBA(tile);
          // Copy so subsequent writes to this tile never corrupt pristine source data
          cached = new Uint8ClampedArray(BYTES_32BIT);
          cached.set(rgba);
        }
      }
      origRgbaCache.set(k, cached);
    }

    lastTileKey = k;
    lastTile = cached;
    return cached;
  };

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      grid.snapshotSingleTileInto(layerId, tx, ty, beforeTileSnapshot);
      getOrigTile(tx, ty);
    }
  }

  const dst = new Uint8ClampedArray(roiW * roiH * 4);
  const maxDocX = width - 1;
  const maxDocY = height - 1;
  const disp: [number, number] = [0, 0];

  for (let ry = 0; ry < roiH; ry++) {
    const py = minY + ry;
    const rowDstBase = ry * roiW * 4;

    for (let rx = 0; rx < roiW; rx++) {
      const px = minX + rx;
      const dstIdx = rowDstBase + (rx << 2);

      warpField.getDisplacement(px, py, disp);
      const dx = disp[0];
      const dy = disp[1];

      // Exact identity fast path (zero loss for untouched or reconstructed pixels)
      if (dx === 0 && dy === 0) {
        const tile = getOrigTile(px >> 8, py >> 8);
        if (tile) {
          const off = (((py & 255) << 8) | (px & 255)) << 2;
          dst[dstIdx] = tile[off];
          dst[dstIdx + 1] = tile[off + 1];
          dst[dstIdx + 2] = tile[off + 2];
          dst[dstIdx + 3] = tile[off + 3];
        }
        continue;
      }

      const rawSx = px + dx;
      const rawSy = py + dy;
      const sx = rawSx <= 0 ? 0 : rawSx >= maxDocX ? maxDocX : rawSx;
      const sy = rawSy <= 0 ? 0 : rawSy >= maxDocY ? maxDocY : rawSy;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;

      if (fx < 1e-5 && fy < 1e-5) {
        const tile = getOrigTile(x0 >> 8, y0 >> 8);
        if (tile) {
          const off = (((y0 & 255) << 8) | (x0 & 255)) << 2;
          dst[dstIdx] = tile[off];
          dst[dstIdx + 1] = tile[off + 1];
          dst[dstIdx + 2] = tile[off + 2];
          dst[dstIdx + 3] = tile[off + 3];
        }
        continue;
      }

      const fx2 = fx * fx;
      const fx3 = fx2 * fx;
      const wx0 = -0.5 * fx + fx2 - 0.5 * fx3;
      const wx1 = 1.0 - 2.5 * fx2 + 1.5 * fx3;
      const wx2 = 0.5 * fx + 2.0 * fx2 - 1.5 * fx3;
      const wx3 = -0.5 * fx2 + 0.5 * fx3;

      const fy2 = fy * fy;
      const fy3 = fy2 * fy;
      const wy0 = -0.5 * fy + fy2 - 0.5 * fy3;
      const wy1 = 1.0 - 2.5 * fy2 + 1.5 * fy3;
      const wy2 = 0.5 * fy + 2.0 * fy2 - 1.5 * fy3;
      const wy3 = -0.5 * fy2 + 0.5 * fy3;

      const lx = x0 & 255;
      const ly = y0 & 255;

      let sumPR = 0;
      let sumPG = 0;
      let sumPB = 0;
      let sumA = 0;

      // Single-tile interior fast path (~97.7% of all pixels: 1 tile lookup, zero clamping)
      if (lx >= 1 && lx <= 253 && ly >= 1 && ly <= 253 && x0 + 2 <= maxDocX && y0 + 2 <= maxDocY) {
        const tile = getOrigTile(x0 >> 8, y0 >> 8);
        if (!tile) continue;

        let baseOff = (((ly - 1) << 8) | (lx - 1)) << 2;
        for (let row = 0; row < 4; row++, baseOff += 1024) {
          const a0 = tile[baseOff + 3];
          const a1 = tile[baseOff + 7];
          const a2 = tile[baseOff + 11];
          const a3 = tile[baseOff + 15];
          if ((a0 | a1 | a2 | a3) === 0) continue;

          const wy = row === 0 ? wy0 : row === 1 ? wy1 : row === 2 ? wy2 : wy3;
          let rPR = 0;
          let rPG = 0;
          let rPB = 0;
          let rA = 0;

          if (a0 !== 0) {
            const wa = wx0 * a0;
            rPR += wa * tile[baseOff];
            rPG += wa * tile[baseOff + 1];
            rPB += wa * tile[baseOff + 2];
            rA += wa;
          }
          if (a1 !== 0) {
            const wa = wx1 * a1;
            rPR += wa * tile[baseOff + 4];
            rPG += wa * tile[baseOff + 5];
            rPB += wa * tile[baseOff + 6];
            rA += wa;
          }
          if (a2 !== 0) {
            const wa = wx2 * a2;
            rPR += wa * tile[baseOff + 8];
            rPG += wa * tile[baseOff + 9];
            rPB += wa * tile[baseOff + 10];
            rA += wa;
          }
          if (a3 !== 0) {
            const wa = wx3 * a3;
            rPR += wa * tile[baseOff + 12];
            rPG += wa * tile[baseOff + 13];
            rPB += wa * tile[baseOff + 14];
            rA += wa;
          }

          sumPR += wy * rPR;
          sumPG += wy * rPG;
          sumPB += wy * rPB;
          sumA += wy * rA;
        }
      } else {
        // Tile-boundary / canvas-edge 4x4 fallback
        const ix0 = x0 > 0 ? x0 - 1 : 0;
        const ix1 = x0;
        const ix2 = x0 < maxDocX ? x0 + 1 : maxDocX;
        const ix3 = x0 + 2 <= maxDocX ? x0 + 2 : maxDocX;

        for (let row = 0; row < 4; row++) {
          const rawY = y0 + row - 1;
          const iy = rawY <= 0 ? 0 : rawY >= maxDocY ? maxDocY : rawY;
          const wy = row === 0 ? wy0 : row === 1 ? wy1 : row === 2 ? wy2 : wy3;
          const ty = iy >> 8;
          const lyOff = (iy & 255) << 8;

          let rPR = 0;
          let rPG = 0;
          let rPB = 0;
          let rA = 0;

          for (let col = 0; col < 4; col++) {
            const ix = col === 0 ? ix0 : col === 1 ? ix1 : col === 2 ? ix2 : ix3;
            const tile = getOrigTile(ix >> 8, ty);
            if (!tile) continue;
            const off = (lyOff | (ix & 255)) << 2;
            const a = tile[off + 3];
            if (a === 0) continue;
            const wx = col === 0 ? wx0 : col === 1 ? wx1 : col === 2 ? wx2 : wx3;
            const wa = wx * a;
            rPR += wa * tile[off];
            rPG += wa * tile[off + 1];
            rPB += wa * tile[off + 2];
            rA += wa;
          }

          sumPR += wy * rPR;
          sumPG += wy * rPG;
          sumPB += wy * rPB;
          sumA += wy * rA;
        }
      }

      if (sumA <= 0.5) continue;
      const invA = 1 / sumA;
      const r = sumPR * invA;
      const g = sumPG * invA;
      const b = sumPB * invA;
      dst[dstIdx] = r <= 0 ? 0 : r >= 255 ? 255 : Math.round(r);
      dst[dstIdx + 1] = g <= 0 ? 0 : g >= 255 ? 255 : Math.round(g);
      dst[dstIdx + 2] = b <= 0 ? 0 : b >= 255 ? 255 : Math.round(b);
      dst[dstIdx + 3] = sumA >= 255 ? 255 : Math.round(sumA);
    }
  }

  grid.writeImageData(layerId, { data: dst, width: roiW, height: roiH }, minX, minY, targetFormat, true);
  return { x: minX, y: minY, width: roiW, height: roiH };
}
