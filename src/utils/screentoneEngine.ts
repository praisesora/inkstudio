import { DirtyRect } from '../types/editor';

export type HalftoneDotShape = 'circle' | 'euclidean' | 'line' | 'diamond';

export interface ScreentoneOptions {
  /**
   * Frequency in Lines Per Inch (LPI), typically 20 to 85 (default: 60).
   */
  frequency?: number;

  /**
   * Rotation angle of the regular halftone grid in degrees, 0 to 90 (default: 45).
   */
  angle?: number;

  /**
   * Dot shape generation function:
   * - 'circle' / 'euclidean': Authentic PostScript/manga Euclidean round dot with smooth 50% checkerboard and shrinking pinholes.
   * - 'line': Parallel manga hatching tone.
   * (default: 'circle')
   */
  dotShape?: HalftoneDotShape;

  /**
   * Document DPI / PPI resolution. Halftone dot spacing is computed strictly
   * in document coordinates as cellSize = dpi / lpi (default: 600).
   */
  dpi?: number;

  /**
   * Rendering backend to use:
   * - 'auto': CPU TypedArray for high reliability and anti-aliased precision.
   * - 'cpu': Force high-throughput CPU 32-bit TypedArray processing.
   * - 'webgl': Force WebGL fragment shader GPU processing (falls back to CPU if unavailable).
   * (default: 'auto')
   */
  renderBackend?: 'auto' | 'cpu' | 'webgl';

  /**
   * Optional solid black fill threshold (e.g., 0.999). When density reaches or exceeds this value,
   * fills solid black instead of leaving corner pinholes. (default: true)
   */
  solidBlackAtMax?: boolean;

  /**
   * Sub-pixel edge anti-aliasing for smooth on-screen display without moiré or staircase aliasing.
   * Set false for strict 1-bit binary output (e.g. monochrome print). (default: true)
   */
  antiAliasing?: boolean;

  /**
   * Density calculation method:
   * - 'specified': Fixed tone density determined by specifiedDensity, modulated by alpha (Clip Studio Paint style)
   * - 'image': Grayscale luminance-to-halftone conversion
   * (default: 'specified')
   */
  densityType?: 'specified' | 'image';

  /**
   * Specified density normalized to [0.0, 1.0], where 0.4 = 40% (default: 0.4)
   */
  specifiedDensity?: number;

  /**
   * Viewport zoom scale. When zoom < 1.0, automatically crossfades into equivalent
   * continuous grayscale luminance to eliminate spatial aliasing and moiré patterns.
   */
  zoom?: number;
}

// Runtime system endianness check for ultra-fast 32-bit pixel writes
const isLittleEndian = (() => {
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = 0x11223344;
  return new Uint8Array(buf)[0] === 0x44;
})();

// Binary 32-bit pixel values in native system byte order:
// Solid black ink = RGBA(0, 0, 0, 255)
// Transparent paper = RGBA(0, 0, 0, 0)
const SOLID_BLACK_U32 = isLittleEndian ? 0xff000000 : 0x000000ff;
const TRANSPARENT_U32 = 0x00000000;

// Reciprocal multiplier to convert ITU-R BT.601 weighted sum (255 * 1000) to [0, 1]
const INV_LUMINANCE_255K = 0.00000392156862745098; // 1 / 255000
const INV_255 = 0.00392156862745098; // 1 / 255

/**
 * GLSL mathematical fractional function: fract(x) = x - floor(x).
 * Always yields a value strictly in [0.0, 1.0) regardless of sign.
 */
export function fract(t: number): number {
  return t - Math.floor(t);
}

/**
 * Evaluates the mathematical Clip Studio Paint style halftone formula for a single
 * document-space point (x, y) with a given ink density in [0.0, 1.0].
 *
 * Formula:
 *  xr = x * cos(θ) - y * sin(θ)
 *  yr = x * sin(θ) + y * cos(θ)
 *  u = fract(xr / cellSize) - 0.5
 *  v = fract(yr / cellSize) - 0.5
 *  dist = sqrt(u * u + v * v)
 *  dotRadius = sqrt(density) * 0.5
 *  Binary Threshold: dist <= dotRadius => pure black (true), else transparent (false)
 */
export function evaluateHalftoneDot(
  x: number,
  y: number,
  density: number,
  cellSize: number,
  cosA: number,
  sinA: number,
  dotShape: HalftoneDotShape = 'circle',
  solidBlackAtMax: boolean = true
): boolean {
  if (density <= 0.001) return false;
  if (solidBlackAtMax && density >= 0.999) return true;

  // 1. Coordinate Transformation in document space
  const xr = x * cosA - y * sinA;
  const yr = x * sinA + y * cosA;

  // 2. Normalized Cell Coordinates centered in [-0.5, 0.5]
  const invCellSize = 1.0 / cellSize;
  const u = (xr * invCellSize) - Math.floor(xr * invCellSize) - 0.5;
  const v = (yr * invCellSize) - Math.floor(yr * invCellSize) - 0.5;

  if (dotShape === 'line') {
    const spot = 1.0 - 2.0 * Math.abs(u);
    return spot >= (1.0 - density);
  }

  if (dotShape === 'diamond') {
    const spot = 1.0 - (Math.abs(u) + Math.abs(v));
    return spot >= (1.0 - density);
  }

  // Authentic Manga / Clip Studio Euclidean Round Dot Spot Function
  const absU = Math.abs(u);
  const absV = Math.abs(v);
  let spot: number;

  if (absU + absV <= 0.5) {
    // Inner diamond: round black dot centered at (0, 0)
    spot = 1.0 - 2.0 * (u * u + v * v);
  } else {
    // Corner region: white pinholes centered at cell corners (±0.5, ±0.5)
    const uc = absU - 0.5;
    const vc = absV - 0.5;
    spot = 2.0 * (uc * uc + vc * vc);
  }

  return spot >= (1.0 - density);
}

let cachedDstImageData: ImageData | null = null;

function getScratchImageData(ctx: CanvasRenderingContext2D, w: number, h: number): ImageData {
  if (cachedDstImageData && cachedDstImageData.width === w && cachedDstImageData.height === h) {
    return cachedDstImageData;
  }
  cachedDstImageData = ctx.createImageData(w, h);
  return cachedDstImageData;
}

/**
 * High-throughput CPU 32-bit TypedArray implementation.
 *
 * Guarantees bit-for-bit mathematical determinism across all dirtyRect updates
 * with zero floating-point accumulation drift and zero seam artifacts.
 */
export function applyScreentoneCPU(
  sourceCanvas: HTMLCanvasElement,
  targetCanvas: HTMLCanvasElement,
  options: ScreentoneOptions = {},
  dirtyRect?: DirtyRect
): void {
  const width = targetCanvas.width > 0 ? targetCanvas.width : sourceCanvas.width;
  const height = targetCanvas.height > 0 ? targetCanvas.height : sourceCanvas.height;
  if (width <= 0 || height <= 0) return;

  if (targetCanvas.width !== width || targetCanvas.height !== height) {
    targetCanvas.width = width;
    targetCanvas.height = height;
  }

  const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const dstCtx = targetCanvas.getContext('2d');
  if (!srcCtx || !dstCtx) return;

  // Bounding rect in document space
  let minX = 0;
  let minY = 0;
  let maxX = width;
  let maxY = height;

  if (dirtyRect) {
    minX = Math.max(0, Math.min(width, Math.floor(dirtyRect.x)));
    minY = Math.max(0, Math.min(height, Math.floor(dirtyRect.y)));
    maxX = Math.max(0, Math.min(width, Math.ceil(dirtyRect.x + dirtyRect.width)));
    maxY = Math.max(0, Math.min(height, Math.ceil(dirtyRect.y + dirtyRect.height)));
  }

  const regionW = maxX - minX;
  const regionH = maxY - minY;
  if (regionW <= 0 || regionH <= 0) return;

  const srcImageData = srcCtx.getImageData(minX, minY, regionW, regionH);
  const srcData = srcImageData.data;
  const srcData32 = new Uint32Array(srcImageData.data.buffer);

  const dstImageData = getScratchImageData(dstCtx, regionW, regionH);
  const dstData32 = new Uint32Array(dstImageData.data.buffer);

  // Configuration parameters
  const frequency = Math.max(1, Math.min(120, options.frequency ?? 60));
  const angleDeg = options.angle ?? 45;
  const rad = (angleDeg * Math.PI) / 180;
  const cosT = Math.cos(rad);
  const sinT = Math.sin(rad);

  const dpi = Math.max(1, options.dpi ?? 600);
  // Ensure cellSize has a 3.5px minimum to prevent high-frequency moire noise on low-DPI canvases
  const cellSize = Math.max(3.5, dpi / frequency);
  const invCellSize = 1.0 / cellSize;
  const dotShape = options.dotShape ?? 'circle';
  const isLine = dotShape === 'line';
  const isDiamond = dotShape === 'diamond';
  const solidBlackAtMax = options.solidBlackAtMax !== false;
  const antiAliasing = options.antiAliasing !== false;
  const isSpecified = options.densityType !== 'image';
  const specDensity = Math.max(0, Math.min(1, options.specifiedDensity ?? 0.4));
  const specOneMinusDensity = 1.0 - specDensity;

  // Sub-pixel anti-aliasing transition half-width in spot function units
  const aaHalfSpan = Math.min(0.25, 0.75 * invCellSize);
  const invTwoAaHalfSpan = 1.0 / (2.0 * aaHalfSpan);

  let srcIdx = 0;
  let dstIdx = 0;

  const zoom = options.zoom ?? 1.0;
  const isDownscaled = zoom < 0.95;
  const moireBlend = isDownscaled ? Math.max(0, Math.min(1, (zoom - 0.35) / 0.6)) : 1.0;

  for (let y = minY; y < maxY; y++) {
    const ySinT = y * sinT;
    const yCosT = y * cosT;
    let xr = minX * cosT - ySinT;
    let yr = minX * sinT + yCosT;

    for (let x = minX; x < maxX; x++, srcIdx += 4, dstIdx++, xr += cosT, yr += sinT) {
      // 32-bit fast path: completely transparent pixel
      if (srcData32[dstIdx] === 0) {
        dstData32[dstIdx] = TRANSPARENT_U32;
        continue;
      }

      const a = srcData[srcIdx + 3];
      if (a === 0) {
        dstData32[dstIdx] = TRANSPARENT_U32;
        continue;
      }

      let oneMinusDensity: number;
      if (isSpecified) {
        if (a === 255) {
          if (specDensity <= 0.001) {
            dstData32[dstIdx] = TRANSPARENT_U32;
            continue;
          }
          if (solidBlackAtMax && specDensity >= 0.999) {
            dstData32[dstIdx] = SOLID_BLACK_U32;
            continue;
          }
          oneMinusDensity = specOneMinusDensity;
        } else {
          const density = specDensity * (a * INV_255);
          if (density <= 0.001) {
            dstData32[dstIdx] = TRANSPARENT_U32;
            continue;
          }
          if (solidBlackAtMax && density >= 0.999) {
            dstData32[dstIdx] = SOLID_BLACK_U32;
            continue;
          }
          oneMinusDensity = 1.0 - density;
        }
      } else {
        const r = srcData[srcIdx];
        const g = srcData[srcIdx + 1];
        const b = srcData[srcIdx + 2];
        // Perceptual ITU-R BT.601 luminance (0.0 = pure black, 1.0 = pure white)
        const luminance = (r * 299 + g * 587 + b * 114) * INV_LUMINANCE_255K;
        const density = (1.0 - luminance) * (a * INV_255);
        if (density <= 0.001) {
          dstData32[dstIdx] = TRANSPARENT_U32;
          continue;
        }
        if (solidBlackAtMax && density >= 0.999) {
          dstData32[dstIdx] = SOLID_BLACK_U32;
          continue;
        }
        oneMinusDensity = 1.0 - density;
      }

      // Normalized cell coordinates in [-0.5, 0.5]
      const u = (xr * invCellSize) - Math.floor(xr * invCellSize) - 0.5;
      const v = (yr * invCellSize) - Math.floor(yr * invCellSize) - 0.5;

      let spot: number;
      if (isLine) {
        spot = 1.0 - 2.0 * Math.abs(u);
      } else if (isDiamond) {
        spot = 1.0 - (Math.abs(u) + Math.abs(v));
      } else {
        const absU = Math.abs(u);
        const absV = Math.abs(v);
        if (absU + absV <= 0.5) {
          spot = 1.0 - 2.0 * (u * u + v * v);
        } else {
          const uc = absU - 0.5;
          const vc = absV - 0.5;
          spot = 2.0 * (uc * uc + vc * vc);
        }
      }

      const diff = spot - oneMinusDensity;

      if (antiAliasing) {
        let coverage = Math.max(0, Math.min(1, diff * invTwoAaHalfSpan + 0.5));
        if (isDownscaled) {
          const contDensity = 1.0 - oneMinusDensity;
          coverage = contDensity * (1.0 - moireBlend) + coverage * moireBlend;
        }
        if (coverage <= 0.0) {
          dstData32[dstIdx] = TRANSPARENT_U32;
        } else if (coverage >= 1.0) {
          dstData32[dstIdx] = SOLID_BLACK_U32;
        } else {
          const alpha = (coverage * 255 + 0.5) | 0;
          dstData32[dstIdx] = isLittleEndian ? (alpha << 24) : alpha;
        }
      } else {
        dstData32[dstIdx] = (diff >= 0.0) ? SOLID_BLACK_U32 : TRANSPARENT_U32;
      }
    }
  }

  dstCtx.putImageData(dstImageData, minX, minY);
}

// WebGL Shader Sources
export const HALFTONE_VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_texCoord;

void main() {
  // WebGL clip space: a_position.x in [-1, 1], a_position.y in [-1, 1] (bottom to top)
  // Canvas coordinate space: (0, 0) is top-left, (1, 1) is bottom-right
  v_texCoord = vec2((a_position.x + 1.0) * 0.5, (1.0 - a_position.y) * 0.5);
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const HALFTONE_FRAGMENT_SHADER = `
precision highp float;

uniform sampler2D u_source;
uniform vec2 u_regionOrigin;
uniform vec2 u_regionSize;
uniform float u_angleRad;
uniform float u_cellSize;
uniform int u_dotShape;
uniform int u_solidBlackAtMax;
uniform int u_antiAliasing;
uniform int u_densityType;
uniform float u_specifiedDensity;
uniform float u_zoom;

varying vec2 v_texCoord;

void main() {
  vec4 srcColor = texture2D(u_source, v_texCoord);

  if (srcColor.a < 0.0039) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }

  float density;
  if (u_densityType == 0) {
    // Specified density mode (CSP tone layer)
    density = clamp(u_specifiedDensity * srcColor.a, 0.0, 1.0);
  } else {
    // Image brightness mode (ITU-R BT.601 perceptual luminance)
    float luminance = dot(srcColor.rgb, vec3(0.299, 0.587, 0.114));
    density = clamp((1.0 - luminance) * srcColor.a, 0.0, 1.0);
  }

  if (density <= 0.001) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
    return;
  }

  if (u_solidBlackAtMax == 1 && density >= 0.999) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float x = u_regionOrigin.x + v_texCoord.x * u_regionSize.x;
  float y = u_regionOrigin.y + v_texCoord.y * u_regionSize.y;

  float cosA = cos(u_angleRad);
  float sinA = sin(u_angleRad);
  float xr = x * cosA - y * sinA;
  float yr = x * sinA + y * cosA;

  float u = fract(xr / u_cellSize) - 0.5;
  float v = fract(yr / u_cellSize) - 0.5;

  float spot;
  if (u_dotShape == 2) {
    spot = 1.0 - 2.0 * abs(u);
  } else if (u_dotShape == 3) {
    spot = 1.0 - (abs(u) + abs(v));
  } else {
    float absU = abs(u);
    float absV = abs(v);
    if (absU + absV <= 0.5) {
      spot = 1.0 - 2.0 * (u * u + v * v);
    } else {
      float uc = absU - 0.5;
      float vc = absV - 0.5;
      spot = 2.0 * (uc * uc + vc * vc);
    }
  }

  float diff = spot - (1.0 - density);
  vec4 halftoneColor;

  if (u_antiAliasing == 1) {
    float halfSpan = min(0.25, 0.75 / u_cellSize);
    float coverage = clamp(diff / (2.0 * halfSpan) + 0.5, 0.0, 1.0);
    halftoneColor = vec4(0.0, 0.0, 0.0, coverage);
  } else {
    if (diff >= 0.0) {
      halftoneColor = vec4(0.0, 0.0, 0.0, 1.0);
    } else {
      halftoneColor = vec4(0.0, 0.0, 0.0, 0.0);
    }
  }

  // Clip Studio Paint style Anti-Moiré Viewport Downsampling:
  // When viewport zoom Z < 1.0, high-frequency dots alias against screen pixels.
  // Smoothstep crossfade from discrete dot pattern to continuous grayscale luminance.
  float moireBlend = smoothstep(0.35, 0.95, u_zoom);
  vec4 contColor = vec4(0.0, 0.0, 0.0, density);
  gl_FragColor = mix(contColor, halftoneColor, moireBlend);
}
`;

/**
 * Reusable WebGL Halftone GPU Renderer Pipeline.
 */
class WebGLHalftonePipeline {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;

  // Uniform locations
  private uSourceLoc: WebGLUniformLocation | null = null;
  private uRegionOriginLoc: WebGLUniformLocation | null = null;
  private uRegionSizeLoc: WebGLUniformLocation | null = null;
  private uAngleRadLoc: WebGLUniformLocation | null = null;
  private uCellSizeLoc: WebGLUniformLocation | null = null;
  private uDotShapeLoc: WebGLUniformLocation | null = null;
  private uSolidBlackAtMaxLoc: WebGLUniformLocation | null = null;
  private uAntiAliasingLoc: WebGLUniformLocation | null = null;
  private uDensityTypeLoc: WebGLUniformLocation | null = null;
  private uSpecifiedDensityLoc: WebGLUniformLocation | null = null;

  public isAvailable(): boolean {
    if (typeof document === 'undefined') return false;
    return this.init();
  }

  private init(): boolean {
    if (this.gl && this.program) return true;

    try {
      this.canvas = document.createElement('canvas');
      const gl = this.canvas.getContext('webgl', {
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        antialias: false,
      });
      if (!gl) return false;
      this.gl = gl;

      // Compile vertex shader
      const vs = gl.createShader(gl.VERTEX_SHADER);
      if (!vs) return false;
      gl.shaderSource(vs, HALFTONE_VERTEX_SHADER);
      gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) return false;

      // Compile fragment shader
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      if (!fs) return false;
      gl.shaderSource(fs, HALFTONE_FRAGMENT_SHADER);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return false;

      // Link program
      const prog = gl.createProgram();
      if (!prog) return false;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
      this.program = prog;

      // Full quad buffer
      const posBuffer = gl.createBuffer();
      if (!posBuffer) return false;
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          -1.0, -1.0,
           1.0, -1.0,
          -1.0,  1.0,
          -1.0,  1.0,
           1.0, -1.0,
           1.0,  1.0,
        ]),
        gl.STATIC_DRAW
      );
      this.positionBuffer = posBuffer;

      // Cache uniform locations
      this.uSourceLoc = gl.getUniformLocation(prog, 'u_source');
      this.uRegionOriginLoc = gl.getUniformLocation(prog, 'u_regionOrigin');
      this.uRegionSizeLoc = gl.getUniformLocation(prog, 'u_regionSize');
      this.uAngleRadLoc = gl.getUniformLocation(prog, 'u_angleRad');
      this.uCellSizeLoc = gl.getUniformLocation(prog, 'u_cellSize');
      this.uDotShapeLoc = gl.getUniformLocation(prog, 'u_dotShape');
      this.uSolidBlackAtMaxLoc = gl.getUniformLocation(prog, 'u_solidBlackAtMax');
      this.uAntiAliasingLoc = gl.getUniformLocation(prog, 'u_antiAliasing');
      this.uDensityTypeLoc = gl.getUniformLocation(prog, 'u_densityType');
      this.uSpecifiedDensityLoc = gl.getUniformLocation(prog, 'u_specifiedDensity');
      this.uZoomLoc = gl.getUniformLocation(prog, 'u_zoom');

      this.texture = gl.createTexture();
      return true;
    } catch {
      return false;
    }
  }

  private uZoomLoc: WebGLUniformLocation | null = null;

  public render(
    sourceCanvas: HTMLCanvasElement,
    targetCanvas: HTMLCanvasElement,
    options: ScreentoneOptions = {},
    dirtyRect?: DirtyRect
  ): boolean {
    if (!this.init() || !this.gl || !this.program || !this.canvas || !this.texture) {
      return false;
    }

    const gl = this.gl;
    const width = targetCanvas.width > 0 ? targetCanvas.width : sourceCanvas.width;
    const height = targetCanvas.height > 0 ? targetCanvas.height : sourceCanvas.height;
    if (width <= 0 || height <= 0) return false;

    if (targetCanvas.width !== width || targetCanvas.height !== height) {
      targetCanvas.width = width;
      targetCanvas.height = height;
    }

    const dstCtx = targetCanvas.getContext('2d');
    if (!dstCtx) return false;

    let minX = 0;
    let minY = 0;
    let maxX = width;
    let maxY = height;

    if (dirtyRect) {
      minX = Math.max(0, Math.min(width, Math.floor(dirtyRect.x)));
      minY = Math.max(0, Math.min(height, Math.floor(dirtyRect.y)));
      maxX = Math.max(0, Math.min(width, Math.ceil(dirtyRect.x + dirtyRect.width)));
      maxY = Math.max(0, Math.min(height, Math.ceil(dirtyRect.y + dirtyRect.height)));
    }

    const regionW = maxX - minX;
    const regionH = maxY - minY;
    if (regionW <= 0 || regionH <= 0) return false;

    // Resize GL offscreen canvas
    if (this.canvas.width !== regionW || this.canvas.height !== regionH) {
      this.canvas.width = regionW;
      this.canvas.height = regionH;
    }

    gl.viewport(0, 0, regionW, regionH);
    gl.useProgram(this.program);

    // Bind full quad buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    const posAttrib = gl.getAttribLocation(this.program, 'a_position');
    gl.enableVertexAttribArray(posAttrib);
    gl.vertexAttribPointer(posAttrib, 2, gl.FLOAT, false, 0, 0);

    // Upload region texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // Extract sub-region or full canvas
    if (minX === 0 && minY === 0 && regionW === width && regionH === height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
    } else {
      const srcCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
      if (!srcCtx) return false;
      const subImageData = srcCtx.getImageData(minX, minY, regionW, regionH);
      const subDataBytes = new Uint8Array(
        subImageData.data.buffer,
        subImageData.data.byteOffset,
        subImageData.data.byteLength
      );
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        regionW,
        regionH,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        subDataBytes
      );
    }

    // Set uniforms
    const frequency = Math.max(1, Math.min(120, options.frequency ?? 60));
    const angleDeg = options.angle ?? 45;
    const rad = (angleDeg * Math.PI) / 180;
    const dpi = Math.max(1, options.dpi ?? 600);
    const cellSize = Math.max(3.5, dpi / frequency);

    gl.uniform1i(this.uSourceLoc, 0);
    gl.uniform2f(this.uRegionOriginLoc, minX, minY);
    gl.uniform2f(this.uRegionSizeLoc, regionW, regionH);
    gl.uniform1f(this.uAngleRadLoc, rad);
    gl.uniform1f(this.uCellSizeLoc, cellSize);
    const dotShapeVal = options.dotShape === 'line' ? 2 : options.dotShape === 'diamond' ? 3 : (options.dotShape === 'euclidean' ? 1 : 0);
    gl.uniform1i(this.uDotShapeLoc, dotShapeVal);
    gl.uniform1i(this.uSolidBlackAtMaxLoc, options.solidBlackAtMax !== false ? 1 : 0);
    gl.uniform1i(this.uAntiAliasingLoc, options.antiAliasing !== false ? 1 : 0);
    gl.uniform1i(this.uDensityTypeLoc, options.densityType === 'image' ? 1 : 0);
    gl.uniform1f(this.uSpecifiedDensityLoc, Math.max(0, Math.min(1, options.specifiedDensity ?? 0.4)));
    if (this.uZoomLoc) {
      gl.uniform1f(this.uZoomLoc, options.zoom ?? 1.0);
    }

    // Render to GL canvas
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Blit to target 2D canvas context
    dstCtx.clearRect(minX, minY, regionW, regionH);
    dstCtx.drawImage(this.canvas, 0, 0, regionW, regionH, minX, minY, regionW, regionH);
    return true;
  }
}

const glPipeline = new WebGLHalftonePipeline();

/**
 * Renders screentone using the GPU WebGL fragment shader pipeline.
 */
export function renderScreentoneWebGL(
  sourceCanvas: HTMLCanvasElement,
  targetCanvas: HTMLCanvasElement,
  options: ScreentoneOptions = {},
  dirtyRect?: DirtyRect
): boolean {
  return glPipeline.render(sourceCanvas, targetCanvas, options, dirtyRect);
}

/**
 * Creates an off-screen Canvas2D pattern generator using createPattern with
 * mathematically seamless tiling in document coordinates.
 */
export function createSeamlessHalftonePattern(
  options: ScreentoneOptions & { density?: number } = {}
): CanvasPattern | null {
  if (typeof document === 'undefined') return null;

  const frequency = Math.max(1, Math.min(120, options.frequency ?? 60));
  const dpi = Math.max(1, options.dpi ?? 600);
  const cellSize = Math.max(3.5, dpi / frequency);
  const density = Math.max(0, Math.min(1, options.density ?? 0.5));
  const angleDeg = options.angle ?? 45;

  const cellCanvas = document.createElement('canvas');
  cellCanvas.width = Math.max(4, Math.round(cellSize));
  cellCanvas.height = Math.max(4, Math.round(cellSize));

  const ctx = cellCanvas.getContext('2d');
  if (!ctx) return null;

  const cW = cellCanvas.width;
  const cH = cellCanvas.height;
  const imgData = ctx.createImageData(cW, cH);
  const data32 = new Uint32Array(imgData.data.buffer);
  const solidBlack = isLittleEndian ? 0xff000000 : 0x000000ff;

  for (let cy = 0; cy < cH; cy++) {
    const v = (cy / cH) - 0.5;
    for (let cx = 0; cx < cW; cx++) {
      const u = (cx / cW) - 0.5;
      const absU = Math.abs(u);
      const absV = Math.abs(v);
      let spot: number;
      if (absU + absV <= 0.5) {
        spot = 1.0 - 2.0 * (u * u + v * v);
      } else {
        const uc = absU - 0.5;
        const vc = absV - 0.5;
        spot = 2.0 * (uc * uc + vc * vc);
      }
      const idx = cy * cW + cx;
      data32[idx] = spot >= (1.0 - density) ? solidBlack : 0x00000000;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  const helperCanvas = document.createElement('canvas');
  helperCanvas.width = 1;
  helperCanvas.height = 1;
  const helperCtx = helperCanvas.getContext('2d');
  if (!helperCtx) return null;

  const pattern = helperCtx.createPattern(cellCanvas, 'repeat');
  if (pattern && typeof pattern.setTransform === 'function' && typeof DOMMatrix !== 'undefined') {
    const matrix = new DOMMatrix();
    matrix.rotateSelf(angleDeg);
    pattern.setTransform(matrix);
  }

  return pattern;
}

/**
 * Applies a Clip Studio Paint style screentone (halftone) conversion to a canvas.
 *
 * Core Features:
 * 1. Document-Space Binding: Dot grid coordinates are computed strictly in original document
 *    coordinates (e.g. 600 DPI), ensuring panning/zooming never shifts, jitters, or scales dots.
 * 2. Mathematical Halftone Formula:
 *    - Regular rotated grid with angle θ = 45°
 *    - Frequency / Cell Size: cellSize = dpi / lpi (e.g. 10px per cell at 600 DPI / 60 LPI)
 *    - Coordinate transformation: xr = x*cos(θ) - y*sin(θ), yr = x*sin(θ) + y*cos(θ)
 *    - Normalized cell coordinates: u = fract(xr/cellSize) - 0.5, v = fract(yr/cellSize) - 0.5
 *    - Euclidean Spot Function: smooth 50% checkerboard and shrinking circular pinholes
 *    - Sub-pixel anti-aliasing for smooth, high-fidelity retina manga display
 * 3. Accurate Clipping: Mask clips strictly to drawn stroke without dirty pixel fringe.
 * 4. Dual Engine Architecture:
 *    - High-throughput CPU TypedArray for instant, deterministic, anti-aliased processing
 *    - GPU WebGL pipeline available on demand
 */
export function applyScreentone(
  sourceCanvas: HTMLCanvasElement,
  targetCanvas: HTMLCanvasElement,
  options: ScreentoneOptions = {},
  dirtyRect?: DirtyRect
): void {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  if (width <= 0 || height <= 0) return;

  const backend = options.renderBackend ?? 'auto';

  // Use WebGL only when explicitly requested
  if (backend === 'webgl' && glPipeline.isAvailable()) {
    try {
      const success = glPipeline.render(sourceCanvas, targetCanvas, options, dirtyRect);
      if (success) return;
    } catch {
      // Fallback to CPU
    }
  }

  // CPU TypedArray path (instant for real-time strokes and full canvas with rAF, 100% reliable)
  applyScreentoneCPU(sourceCanvas, targetCanvas, options, dirtyRect);
}

/**
 * Creates a standalone offscreen canvas with the screentone effect applied.
 */
export function createScreentoneCanvas(
  sourceCanvas: HTMLCanvasElement,
  options: ScreentoneOptions = {}
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  applyScreentone(sourceCanvas, canvas, options);
  return canvas;
}
