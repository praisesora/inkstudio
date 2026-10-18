import { FilterType } from '../types/editor';

export interface GaussianBlurParams {
  radius: number; // Blur radius in pixels (1 to 100)
}

export interface MotionBlurParams {
  distance: number;  // Distance in pixels (1 to 100)
  angle: number;     // Angle in degrees (0 to 360)
}

export interface UnsharpMaskParams {
  radius: number;    // Radius in pixels (0.5 to 20)
  amount: number;    // Amount factor (0.1 to 5.0, e.g. 1.0 = 100%)
  threshold?: number;// Threshold (0 to 255, default: 0)
}

export interface FilmGrainParams {
  intensity: number;      // Intensity percentage (0 to 100)
  size?: number;          // Grain particle size in pixels (1 to 10, default: 1)
  monochromatic?: boolean;// True for B&W grain, false for RGB chromatic noise
  seed?: number;          // Optional PRNG seed
}

/**
 * Calculates optimal 3-pass box blur radii that approximate Gaussian blur with sigma.
 * Based on Peter Kovesi's fast box blur approximation (Central Limit Theorem).
 */
function boxesForGauss(sigma: number, n: number = 3): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;

  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);

  const sizes: number[] = [];
  for (let i = 0; i < n; i++) {
    sizes.push(i < m ? wl : wu);
  }
  return sizes;
}

/**
 * 1D Horizontal Box Blur pass using sliding window accumulator (O(N) runtime).
 */
function boxBlurHorizontal(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  w: number,
  h: number,
  r: number
): void {
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    let ti = rowOffset * 4;
    let li = rowOffset;
    let ri = rowOffset + r;

    const fvR = src[rowOffset * 4];
    const fvG = src[rowOffset * 4 + 1];
    const fvB = src[rowOffset * 4 + 2];
    const fvA = src[rowOffset * 4 + 3];

    const lvR = src[(rowOffset + w - 1) * 4];
    const lvG = src[(rowOffset + w - 1) * 4 + 1];
    const lvB = src[(rowOffset + w - 1) * 4 + 2];
    const lvA = src[(rowOffset + w - 1) * 4 + 3];

    let valR = (r + 1) * fvR;
    let valG = (r + 1) * fvG;
    let valB = (r + 1) * fvB;
    let valA = (r + 1) * fvA;

    for (let j = 0; j < r; j++) {
      const idx = (rowOffset + Math.min(w - 1, j)) * 4;
      valR += src[idx];
      valG += src[idx + 1];
      valB += src[idx + 2];
      valA += src[idx + 3];
    }

    for (let j = 0; j <= r; j++) {
      const rIdx = (rowOffset + Math.min(w - 1, ri++ - rowOffset)) * 4;
      valR += src[rIdx] - fvR;
      valG += src[rIdx + 1] - fvG;
      valB += src[rIdx + 2] - fvB;
      valA += src[rIdx + 3] - fvA;
      dst[ti] = Math.round(valR * iarr);
      dst[ti + 1] = Math.round(valG * iarr);
      dst[ti + 2] = Math.round(valB * iarr);
      dst[ti + 3] = Math.round(valA * iarr);
      ti += 4;
    }

    for (let j = r + 1; j < w - r; j++) {
      const rIdx = (rowOffset + (ri++ - rowOffset)) * 4;
      const lIdx = (rowOffset + (li++ - rowOffset)) * 4;
      valR += src[rIdx] - src[lIdx];
      valG += src[rIdx + 1] - src[lIdx + 1];
      valB += src[rIdx + 2] - src[lIdx + 2];
      valA += src[rIdx + 3] - src[lIdx + 3];
      dst[ti] = Math.round(valR * iarr);
      dst[ti + 1] = Math.round(valG * iarr);
      dst[ti + 2] = Math.round(valB * iarr);
      dst[ti + 3] = Math.round(valA * iarr);
      ti += 4;
    }

    for (let j = w - r; j < w; j++) {
      const lIdx = (rowOffset + Math.max(0, li++ - rowOffset)) * 4;
      valR += lvR - src[lIdx];
      valG += lvG - src[lIdx + 1];
      valB += lvB - src[lIdx + 2];
      valA += lvA - src[lIdx + 3];
      dst[ti] = Math.round(valR * iarr);
      dst[ti + 1] = Math.round(valG * iarr);
      dst[ti + 2] = Math.round(valB * iarr);
      dst[ti + 3] = Math.round(valA * iarr);
      ti += 4;
    }
  }
}

/**
 * 1D Vertical Box Blur pass using sliding window accumulator (O(N) runtime).
 */
function boxBlurVertical(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  w: number,
  h: number,
  r: number
): void {
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    let ti = x * 4;
    let li = ti;
    let ri = ti + r * w * 4;

    const fvR = src[ti];
    const fvG = src[ti + 1];
    const fvB = src[ti + 2];
    const fvA = src[ti + 3];

    const bottomIdx = (x + (h - 1) * w) * 4;
    const lvR = src[bottomIdx];
    const lvG = src[bottomIdx + 1];
    const lvB = src[bottomIdx + 2];
    const lvA = src[bottomIdx + 3];

    let valR = (r + 1) * fvR;
    let valG = (r + 1) * fvG;
    let valB = (r + 1) * fvB;
    let valA = (r + 1) * fvA;

    for (let j = 0; j < r; j++) {
      const idx = (x + Math.min(h - 1, j) * w) * 4;
      valR += src[idx];
      valG += src[idx + 1];
      valB += src[idx + 2];
      valA += src[idx + 3];
    }

    for (let j = 0; j <= r; j++) {
      const rIdx = (x + Math.min(h - 1, Math.floor(ri / (w * 4)))) * 4;
      ri += w * 4;
      valR += src[rIdx] - fvR;
      valG += src[rIdx + 1] - fvG;
      valB += src[rIdx + 2] - fvB;
      valA += src[rIdx + 3] - fvA;
      dst[ti] = Math.round(valR * iarr);
      dst[ti + 1] = Math.round(valG * iarr);
      dst[ti + 2] = Math.round(valB * iarr);
      dst[ti + 3] = Math.round(valA * iarr);
      ti += w * 4;
    }

    for (let j = r + 1; j < h - r; j++) {
      valR += src[ri] - src[li];
      valG += src[ri + 1] - src[li + 1];
      valB += src[ri + 2] - src[li + 2];
      valA += src[ri + 3] - src[li + 3];
      ri += w * 4;
      li += w * 4;
      dst[ti] = Math.round(valR * iarr);
      dst[ti + 1] = Math.round(valG * iarr);
      dst[ti + 2] = Math.round(valB * iarr);
      dst[ti + 3] = Math.round(valA * iarr);
      ti += w * 4;
    }

    for (let j = h - r; j < h; j++) {
      const lIdx = (x + Math.max(0, Math.floor(li / (w * 4)))) * 4;
      li += w * 4;
      valR += lvR - src[lIdx];
      valG += lvG - src[lIdx + 1];
      valB += lvB - src[lIdx + 2];
      valA += lvA - src[lIdx + 3];
      dst[ti] = Math.round(valR * iarr);
      dst[ti + 1] = Math.round(valG * iarr);
      dst[ti + 2] = Math.round(valB * iarr);
      dst[ti + 3] = Math.round(valA * iarr);
      ti += w * 4;
    }
  }
}

/**
 * Separable 3-pass Gaussian Blur in O(N) runtime regardless of radius size.
 */
export function applyGaussianBlur(imageData: ImageData, radius: number): ImageData {
  const r = Math.max(0.1, radius);
  const w = imageData.width;
  const h = imageData.height;

  const output = new ImageData(w, h);
  const temp = new Uint8ClampedArray(imageData.data);
  const buf = new Uint8ClampedArray(imageData.data.length);

  const bxs = boxesForGauss(r, 3);

  // Pass 1
  boxBlurHorizontal(temp, buf, w, h, (bxs[0] - 1) / 2);
  boxBlurVertical(buf, temp, w, h, (bxs[0] - 1) / 2);

  // Pass 2
  boxBlurHorizontal(temp, buf, w, h, (bxs[1] - 1) / 2);
  boxBlurVertical(buf, temp, w, h, (bxs[1] - 1) / 2);

  // Pass 3
  boxBlurHorizontal(temp, buf, w, h, (bxs[2] - 1) / 2);
  boxBlurVertical(buf, output.data, w, h, (bxs[2] - 1) / 2);

  return output;
}

/**
 * Directional Motion Blur convolution filter.
 */
export function applyMotionBlur(
  imageData: ImageData,
  distance: number,
  angle: number
): ImageData {
  const dist = Math.max(1, distance);
  const w = imageData.width;
  const h = imageData.height;
  const src = imageData.data;
  const output = new ImageData(w, h);
  const dst = output.data;

  const rad = (angle * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  const halfSteps = Math.max(1, Math.floor(dist / 2));
  const numSamples = halfSteps * 2 + 1;
  const invSamples = 1 / numSamples;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let s = -halfSteps; s <= halfSteps; s++) {
        const factor = s * (dist / numSamples);
        const sx = Math.max(0, Math.min(w - 1, Math.round(x + cosA * factor)));
        const sy = Math.max(0, Math.min(h - 1, Math.round(y + sinA * factor)));
        const idx = (sy * w + sx) * 4;

        accR += src[idx];
        accG += src[idx + 1];
        accB += src[idx + 2];
        accA += src[idx + 3];
      }

      const outIdx = (y * w + x) * 4;
      dst[outIdx] = Math.round(accR * invSamples);
      dst[outIdx + 1] = Math.round(accG * invSamples);
      dst[outIdx + 2] = Math.round(accB * invSamples);
      dst[outIdx + 3] = Math.round(accA * invSamples);
    }
  }

  return output;
}

/**
 * Unsharp Mask Filter: Output = Original + (Original - Blurred) * Amount.
 */
export function applyUnsharpMask(
  imageData: ImageData,
  radius: number,
  amount: number,
  threshold: number = 0
): ImageData {
  const blurred = applyGaussianBlur(imageData, radius);
  const w = imageData.width;
  const h = imageData.height;
  const total = w * h;
  const src = imageData.data;
  const blr = blurred.data;
  const output = new ImageData(w, h);
  const dst = output.data;

  const safeThresh = Math.max(0, threshold);

  for (let p = 0; p < total; p++) {
    const i = p * 4;
    const diffR = src[i] - blr[i];
    const diffG = src[i + 1] - blr[i + 1];
    const diffB = src[i + 2] - blr[i + 2];

    const maxDiff = Math.max(Math.abs(diffR), Math.abs(diffG), Math.abs(diffB));

    if (maxDiff >= safeThresh) {
      dst[i] = Math.max(0, Math.min(255, Math.round(src[i] + diffR * amount)));
      dst[i + 1] = Math.max(0, Math.min(255, Math.round(src[i + 1] + diffG * amount)));
      dst[i + 2] = Math.max(0, Math.min(255, Math.round(src[i + 2] + diffB * amount)));
    } else {
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
    }
    dst[i + 3] = src[i + 3];
  }

  return output;
}

/**
 * High-performance PRNG (Mulberry32) for deterministic procedural grain.
 */
function createPrng(seed: number) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Procedural Film Grain Filter (Monochromatic / Chromatic, with Particle Size scaling).
 */
export function applyFilmGrain(
  imageData: ImageData,
  intensity: number,
  size: number = 1,
  monochromatic: boolean = true,
  seed: number = 1337
): ImageData {
  const w = imageData.width;
  const h = imageData.height;
  const src = imageData.data;
  const output = new ImageData(w, h);
  const dst = output.data;

  const prng = createPrng(seed);
  const scale = (intensity / 100) * 128;
  const grainSize = Math.max(1, Math.min(10, Math.round(size)));

  if (grainSize === 1) {
    const totalPixels = w * h;
    for (let p = 0; p < totalPixels; p++) {
      const i = p * 4;
      if (src[i + 3] === 0) {
        dst[i + 3] = 0;
        continue;
      }

      if (monochromatic) {
        // Uniform noise mapped to [-1, 1]
        const noise = (prng() * 2 - 1) * scale;
        dst[i] = Math.max(0, Math.min(255, Math.round(src[i] + noise)));
        dst[i + 1] = Math.max(0, Math.min(255, Math.round(src[i + 1] + noise)));
        dst[i + 2] = Math.max(0, Math.min(255, Math.round(src[i + 2] + noise)));
      } else {
        const nR = (prng() * 2 - 1) * scale;
        const nG = (prng() * 2 - 1) * scale;
        const nB = (prng() * 2 - 1) * scale;
        dst[i] = Math.max(0, Math.min(255, Math.round(src[i] + nR)));
        dst[i + 1] = Math.max(0, Math.min(255, Math.round(src[i + 1] + nG)));
        dst[i + 2] = Math.max(0, Math.min(255, Math.round(src[i + 2] + nB)));
      }
      dst[i + 3] = src[i + 3];
    }
  } else {
    // Clustered grain blocks for custom particle size
    const blocksW = Math.ceil(w / grainSize);
    const blocksH = Math.ceil(h / grainSize);
    const noiseMap = new Float32Array(blocksW * blocksH * (monochromatic ? 1 : 3));

    for (let i = 0; i < noiseMap.length; i++) {
      noiseMap[i] = (prng() * 2 - 1) * scale;
    }

    for (let y = 0; y < h; y++) {
      const by = Math.floor(y / grainSize);
      const bRow = by * blocksW;
      const rowOffset = y * w;

      for (let x = 0; x < w; x++) {
        const bx = Math.floor(x / grainSize);
        const bIdx = bRow + bx;
        const i = (rowOffset + x) * 4;

        if (src[i + 3] === 0) {
          dst[i + 3] = 0;
          continue;
        }

        if (monochromatic) {
          const noise = noiseMap[bIdx];
          dst[i] = Math.max(0, Math.min(255, Math.round(src[i] + noise)));
          dst[i + 1] = Math.max(0, Math.min(255, Math.round(src[i + 1] + noise)));
          dst[i + 2] = Math.max(0, Math.min(255, Math.round(src[i + 2] + noise)));
        } else {
          const cIdx = bIdx * 3;
          dst[i] = Math.max(0, Math.min(255, Math.round(src[i] + noiseMap[cIdx])));
          dst[i + 1] = Math.max(0, Math.min(255, Math.round(src[i + 1] + noiseMap[cIdx + 1])));
          dst[i + 2] = Math.max(0, Math.min(255, Math.round(src[i + 2] + noiseMap[cIdx + 2])));
        }
        dst[i + 3] = src[i + 3];
      }
    }
  }

  return output;
}

export const FILTER_VERTEX_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_uv;
  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

export const GAUSSIAN_BLUR_FRAGMENT_SHADER = `
  precision highp float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform vec2 u_dir; // (1.0/width, 0.0) or (0.0, 1.0/height)
  uniform float u_radius;

  void main() {
    float sigma = max(0.5, u_radius * 0.5);
    float twoSigmaSq = 2.0 * sigma * sigma;
    vec4 acc = vec4(0.0);
    float weightSum = 0.0;

    for (int i = -24; i <= 24; i++) {
      float fi = float(i);
      if (abs(fi) > u_radius) continue;
      float w = exp(-(fi * fi) / twoSigmaSq);
      acc += texture2D(u_tex, clamp(v_uv + u_dir * fi, 0.0, 1.0)) * w;
      weightSum += w;
    }

    gl_FragColor = acc / max(0.0001, weightSum);
  }
`;

export const MOTION_BLUR_FRAGMENT_SHADER = `
  precision highp float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  uniform vec2 u_stepVec;
  uniform int u_halfSteps;

  void main() {
    vec4 acc = vec4(0.0);
    float count = 0.0;
    for (int i = -32; i <= 32; i++) {
      if (i < -u_halfSteps || i > u_halfSteps) continue;
      vec2 sampleUv = clamp(v_uv + u_stepVec * float(i), 0.0, 1.0);
      acc += texture2D(u_tex, sampleUv);
      count += 1.0;
    }
    gl_FragColor = acc / max(1.0, count);
  }
`;

export class WebGlFilterEngine {
  private static instance: WebGlFilterEngine | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private gaussProgram: WebGLProgram | null = null;
  private motionProgram: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private texA: WebGLTexture | null = null;
  private texB: WebGLTexture | null = null;
  private fboA: WebGLFramebuffer | null = null;
  private gpuReady = false;

  public static getInstance(): WebGlFilterEngine {
    if (!WebGlFilterEngine.instance) {
      WebGlFilterEngine.instance = new WebGlFilterEngine();
    }
    return WebGlFilterEngine.instance;
  }

  private constructor() {
    if (typeof document === 'undefined') return;
    try {
      this.canvas = document.createElement('canvas');
      const gl = (this.canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true }) ||
        this.canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true })) as WebGLRenderingContext | null;
      if (!gl) return;
      this.gl = gl;

      this.gaussProgram = this.compileProgram(gl, FILTER_VERTEX_SHADER, GAUSSIAN_BLUR_FRAGMENT_SHADER);
      this.motionProgram = this.compileProgram(gl, FILTER_VERTEX_SHADER, MOTION_BLUR_FRAGMENT_SHADER);
      if (!this.gaussProgram || !this.motionProgram) return;

      this.quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW
      );

      this.texA = gl.createTexture();
      this.texB = gl.createTexture();
      this.fboA = gl.createFramebuffer();
      this.gpuReady = true;
    } catch {
      this.gpuReady = false;
    }
  }

  private compileProgram(gl: WebGLRenderingContext, vsSrc: string, fsSrc: string): WebGLProgram | null {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) return null;
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS) || !gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      return null;
    }
    const prog = gl.createProgram();
    if (!prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    return prog;
  }

  public isAvailable(): boolean {
    return this.gpuReady && this.gl !== null;
  }

  public renderGaussianBlurToCanvas(targetCanvas: HTMLCanvasElement, radius: number): boolean {
    if (!this.isAvailable() || !this.gl || !this.canvas || !this.gaussProgram || !this.texA || !this.texB || !this.fboA) {
      return false;
    }
    const w = targetCanvas.width;
    const h = targetCanvas.height;
    if (w <= 0 || h <= 0 || radius > 24) return false;

    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    // Upload source canvas to texA
    gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, targetCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Allocate texB for horizontal pass FBO
    gl.bindTexture(gl.TEXTURE_2D, this.texB);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texB, 0);

    gl.viewport(0, 0, w, h);
    gl.useProgram(this.gaussProgram);

    const posLoc = gl.getAttribLocation(this.gaussProgram, 'a_position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Pass 1: Horizontal into texB
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texA);
    gl.uniform1i(gl.getUniformLocation(this.gaussProgram, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(this.gaussProgram, 'u_dir'), 1.0 / w, 0.0);
    gl.uniform1f(gl.getUniformLocation(this.gaussProgram, 'u_radius'), radius);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 2: Vertical to default framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.texB);
    gl.uniform2f(gl.getUniformLocation(this.gaussProgram, 'u_dir'), 0.0, 1.0 / h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const ctx = targetCanvas.getContext('2d');
    if (!ctx) return false;
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.canvas, 0, 0);
    ctx.restore();
    return true;
  }
}

/**
 * Universal dispatcher for convolution filters.
 */
export function applyFilter(
  imageData: ImageData,
  type: FilterType,
  params: any
): ImageData {
  switch (type) {
    case 'gaussian-blur': {
      const p = params as GaussianBlurParams;
      return applyGaussianBlur(imageData, p.radius || 5);
    }
    case 'motion-blur': {
      const p = params as MotionBlurParams;
      return applyMotionBlur(imageData, p.distance || 15, p.angle || 0);
    }
    case 'unsharp-mask': {
      const p = params as UnsharpMaskParams;
      return applyUnsharpMask(imageData, p.radius || 2, p.amount || 1.5, p.threshold || 0);
    }
    case 'film-grain': {
      const p = params as FilmGrainParams;
      return applyFilmGrain(
        imageData,
        p.intensity || 25,
        p.size || 1,
        p.monochromatic ?? true,
        p.seed || 1337
      );
    }
    default:
      return imageData;
  }
}

/**
 * Applies a filter directly to an HTMLCanvasElement, using WebGL2 GPU acceleration when supported.
 */
export function applyFilterToCanvas(
  canvas: HTMLCanvasElement,
  type: FilterType,
  params: any
): boolean {
  if (type === 'gaussian-blur') {
    const p = params as GaussianBlurParams;
    const gpuFilter = WebGlFilterEngine.getInstance();
    if (gpuFilter.isAvailable() && gpuFilter.renderGaussianBlurToCanvas(canvas, p.radius || 5)) {
      return true;
    }
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const filtered = applyFilter(imgData, type, params);
  ctx.putImageData(filtered, 0, 0);
  return true;
}

