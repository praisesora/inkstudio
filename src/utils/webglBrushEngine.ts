import { Point, BrushSettings, ToolType } from '../types/editor';
import { applyColorDynamics } from './stampEngine';

/**
 * Information about the host video card powering the WebGL brush engine.
 */
export interface GpuInfo {
  isSupported: boolean;
  renderer: string;
  vendor: string;
  glVersion: string;
}

/**
 * GPU Dab instance for batch drawing.
 */
export interface GpuDab {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number; // in radians
  r: number;
  g: number;
  b: number;
  alpha: number;
  pressure: number;
  strokeDist: number;
}

// -------------------------------------------------------------
// Shaders for GPU Video Card Execution (Track B: Instanced Dabs)
// -------------------------------------------------------------

const VERTEX_SHADER_SRC = `
precision highp float;

attribute vec2 a_quadVertex; // [-0.5, 0.5] quad
attribute vec2 a_center;     // dab center in canvas pixels
attribute vec2 a_size;       // width, height
attribute float a_angle;     // rotation in radians
attribute vec4 a_color;      // dab color rgba
attribute float a_alpha;     // dab stamp flow / alpha
attribute float a_pressure;  // stylus pressure
attribute float a_strokeDist;// cumulative stroke distance

uniform vec2 u_canvasResolution;

varying vec2 v_uv;
varying vec2 v_localPos;
varying vec4 v_color;
varying float v_alpha;
varying float v_pressure;
varying float v_strokeDist;
varying vec2 v_worldPos;

void main() {
  v_uv = a_quadVertex + 0.5;
  v_localPos = a_quadVertex * 2.0; // [-1.0, 1.0]
  v_color = a_color;
  v_alpha = a_alpha;
  v_pressure = a_pressure;
  v_strokeDist = a_strokeDist;

  // Rotate quad vertex
  float cosA = cos(a_angle);
  float sinA = sin(a_angle);
  vec2 scaled = a_quadVertex * a_size;
  vec2 rotated = vec2(
    scaled.x * cosA - scaled.y * sinA,
    scaled.x * sinA + scaled.y * cosA
  );

  vec2 worldPixelPos = a_center + rotated;
  v_worldPos = worldPixelPos;

  // Convert pixel coordinates [0, W] x [0, H] to WebGL clip space [-1, 1] x [1, -1]
  vec2 clipPos = (worldPixelPos / u_canvasResolution) * 2.0 - 1.0;
  clipPos.y = -clipPos.y; // Invert Y for canvas coordinate system

  gl_Position = vec4(clipPos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SRC = `
precision highp float;

varying vec2 v_uv;
varying vec2 v_localPos;
varying vec4 v_color;
varying float v_alpha;
varying float v_pressure;
varying float v_strokeDist;
varying vec2 v_worldPos;

uniform bool u_hasTipTexture;
uniform sampler2D u_tipTexture;

uniform bool u_hasDualTipTexture;
uniform sampler2D u_dualTipTexture;
uniform int u_dualBlendMode;     // 0: multiply, 1: subtract, 2: darken, 3: overlay, 4: screen

uniform float u_hardness;        // 0.05 to 1.0
uniform float u_wetEdge;         // 0.0 to 1.0 (CSP Watercolor Water Edge)
uniform float u_paperGrain;      // 0.0 to 1.0 (CSP Paper Tooth)
uniform float u_grainScale;      // scale of paper texture

uniform bool u_colorMixing;      // CSP Color Mixing active
uniform bool u_perceptualMixing; // OKLab + Kubelka-Munk spectral pigment mixing
uniform bool u_hasCanvasTexture;
uniform sampler2D u_canvasTexture;
uniform vec2 u_canvasResolution;
uniform float u_amountOfPaint;   // 0.0 to 1.0 (CSP Amount of Paint)
uniform float u_densityOfPaint;  // 0.0 to 1.0 (CSP Density of Paint)
uniform float u_colorStretch;    // 0.0 to 1.0 (CSP Color Stretch)
uniform bool u_isEraser;
uniform bool u_isBgEraser;

// Procedural multi-frequency paper grain tooth
float getPaperGrain(vec2 p) {
  vec2 coord = p * (0.08 * u_grainScale);
  float n1 = sin(coord.x * 3.1415 + coord.y * 1.7) * cos(coord.y * 2.718 - coord.x * 0.9);
  float n2 = sin(coord.x * 7.3 - coord.y * 5.1) * cos(coord.x * 4.2 + coord.y * 8.3);
  float n3 = sin(coord.x * 15.1 + coord.y * 11.7);
  return clamp((n1 * 0.5 + n2 * 0.35 + n3 * 0.15) * 0.5 + 0.5, 0.0, 1.0);
}

// Perceptual Kubelka-Munk + Spectral Yellow-Blue Pigment Mixing on GPU
vec3 mixPigmentsGpu(vec3 c1, vec3 c2, float w2) {
  float w1 = 1.0 - w2;
  vec3 l1 = pow(max(c1, vec3(0.0)), vec3(2.2));
  vec3 l2 = pow(max(c2, vec3(0.0)), vec3(2.2));

  vec3 abs1 = vec3(1.0) - sqrt(l1);
  vec3 abs2 = vec3(1.0) - sqrt(l2);
  vec3 mixAbs = abs1 * w1 + abs2 * w2;
  vec3 sub = pow(max(vec3(0.0), vec3(1.0) - mixAbs), vec3(2.0));

  // Spectral Yellow + Blue -> Green transmittance coupling
  float y1 = max(0.0, min(l1.r, l1.g) - l1.b);
  float y2 = max(0.0, min(l2.r, l2.g) - l2.b);
  float b1 = max(0.0, l1.b - l1.r);
  float b2 = max(0.0, l2.b - l2.r);
  float ybCross = (y1 * b2 + y2 * b1) * 4.0 * w1 * w2;
  if (ybCross > 0.001) {
    sub.g = min(1.0, sub.g + ybCross * 0.55);
    sub.r = max(0.0, sub.r * (1.0 - ybCross * 0.45));
    sub.b = max(0.0, sub.b * (1.0 - ybCross * 0.45));
  }

  return clamp(pow(max(sub, vec3(0.0)), vec3(1.0 / 2.2)), 0.0, 1.0);
}

void main() {
  float dist = length(v_localPos);
  if (dist > 1.0) {
    discard;
  }

  // 1. Base tip profile and hardness
  float tipAlpha = 1.0;
  if (u_hasTipTexture) {
    vec4 tex = texture2D(u_tipTexture, v_uv);
    tipAlpha = tex.a;
  } else {
    // Procedural smooth Hermite profile based on hardness
    float edge = clamp(u_hardness, 0.05, 0.98);
    tipAlpha = 1.0 - smoothstep(edge, 1.0, dist);
  }

  // 1b. Dual-Brush Texture Modulation
  if (u_hasDualTipTexture) {
    vec4 dualTex = texture2D(u_dualTipTexture, v_uv);
    float dualA = dualTex.a;
    if (u_dualBlendMode == 1) {
      tipAlpha = max(0.0, tipAlpha - (1.0 - dualA)); // subtract
    } else if (u_dualBlendMode == 2) {
      tipAlpha = min(tipAlpha, dualA); // darken
    } else if (u_dualBlendMode == 3) {
      tipAlpha = tipAlpha < 0.5 ? (2.0 * tipAlpha * dualA) : (1.0 - 2.0 * (1.0 - tipAlpha) * (1.0 - dualA)); // overlay
    } else if (u_dualBlendMode == 4) {
      tipAlpha = tipAlpha + dualA - tipAlpha * dualA; // screen
    } else {
      tipAlpha *= dualA; // multiply (default)
    }
  }

  if (tipAlpha <= 0.002) {
    discard;
  }

  vec3 rgb = v_color.rgb;

  // 2. CSP Wet Edge (Water Edge - capillary accumulation at stroke perimeter)
  if (u_wetEdge > 0.001) {
    float rim = smoothstep(0.55, 0.94, dist) * (1.0 - smoothstep(0.95, 1.0, dist));
    float edgeBoost = 1.0 + u_wetEdge * 2.2 * rim;
    tipAlpha = clamp(tipAlpha * edgeBoost, 0.0, 1.0);
    rgb = mix(rgb, rgb * 0.72, u_wetEdge * rim * 0.55);
  }

  // 3. CSP Paper Grain / Canvas Tooth
  if (u_paperGrain > 0.001) {
    float tooth = getPaperGrain(v_worldPos);
    float penetration = clamp(v_pressure * 0.75, 0.0, 0.85);
    float grainFactor = clamp(1.0 - u_paperGrain * (1.0 - tooth) * (1.0 - penetration), 0.05, 1.0);
    tipAlpha *= grainFactor;
  }

  // 4. CSP Color Mixing & Smear
  if (u_colorMixing && u_hasCanvasTexture && !u_isEraser) {
    vec2 canvasUv = v_worldPos / u_canvasResolution;
    canvasUv.y = 1.0 - canvasUv.y;
    vec4 canvasColor = texture2D(u_canvasTexture, canvasUv);

    if (canvasColor.a > 0.02) {
      float stretchDistLimit = max(20.0, u_colorStretch * 600.0);
      float stretchDecay = exp(-v_strokeDist / stretchDistLimit);
      float effectiveAmount = clamp(u_amountOfPaint * (1.0 - stretchDecay * 0.7), 0.04, 0.98);
      if (u_perceptualMixing) {
        rgb = mixPigmentsGpu(canvasColor.rgb, rgb, effectiveAmount);
      } else {
        rgb = mix(canvasColor.rgb, rgb, effectiveAmount);
      }
      tipAlpha *= mix(0.65, 1.0, u_densityOfPaint);
    }
  }

  // 5. Final Alpha computation
  float finalAlpha = clamp(tipAlpha * v_alpha, 0.0, 1.0);

  if (u_isBgEraser) {
    gl_FragColor = vec4(1.0, 1.0, 1.0, finalAlpha);
  } else if (u_isEraser) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, finalAlpha);
  } else {
    // Premultiplied alpha for seamless blending
    gl_FragColor = vec4(rgb * finalAlpha, finalAlpha);
  }
}
`;

// -------------------------------------------------------------
// Shaders for Track A: Ribbon Inking Engine (G-Pen / Manga Lines)
// Continuous polygonal triangle strip with analytical distance field SDF
// -------------------------------------------------------------

const RIBBON_VERTEX_SHADER_SRC = `
precision highp float;

attribute vec2 a_pos;        // world pixel position
attribute float a_normalDist;// -1.0 for left, +1.0 for right
attribute vec4 a_color;      // rgba
attribute float a_width;     // pixel width

uniform vec2 u_canvasResolution;

varying float v_normalDist;
varying vec4 v_color;
varying float v_width;

void main() {
  v_normalDist = a_normalDist;
  v_color = a_color;
  v_width = a_width;

  vec2 clipPos = (a_pos / u_canvasResolution) * 2.0 - 1.0;
  clipPos.y = -clipPos.y; // Invert Y for canvas coordinate system

  gl_Position = vec4(clipPos, 0.0, 1.0);
}
`;

const RIBBON_FRAGMENT_SHADER_SRC = `
precision highp float;

varying float v_normalDist;
varying vec4 v_color;
varying float v_width;

void main() {
  float dist = abs(v_normalDist);
  // Analytical SDF sub-pixel antialiasing
  float aa = clamp(1.5 / max(1.0, v_width), 0.015, 0.45);
  float alpha = 1.0 - smoothstep(1.0 - aa, 1.0, dist);

  if (alpha <= 0.002) {
    discard;
  }

  float finalAlpha = v_color.a * alpha;
  gl_FragColor = vec4(v_color.rgb * finalAlpha, finalAlpha);
}
`;

/**
 * WebGL-accelerated GPU brush engine.
 * Computes all cutting-edge CSP brush mathematics directly on the video card!
 */
export class WebGlBrushEngine {
  private static instance: WebGlBrushEngine | null = null;

  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private ribbonProgram: WebGLProgram | null = null;
  private isGpuAvailable = false;
  private gpuInfo: GpuInfo = {
    isSupported: false,
    renderer: 'CPU Fallback',
    vendor: 'Standard',
    glVersion: 'None',
  };

  // Uniform locations (Instanced Stamp)
  private uCanvasResolutionLoc: WebGLUniformLocation | null = null;
  private uHasTipTextureLoc: WebGLUniformLocation | null = null;
  private uTipTextureLoc: WebGLUniformLocation | null = null;
  private uHasDualTipTextureLoc: WebGLUniformLocation | null = null;
  private uDualTipTextureLoc: WebGLUniformLocation | null = null;
  private uDualBlendModeLoc: WebGLUniformLocation | null = null;
  private uHardnessLoc: WebGLUniformLocation | null = null;
  private uWetEdgeLoc: WebGLUniformLocation | null = null;
  private uPaperGrainLoc: WebGLUniformLocation | null = null;
  private uGrainScaleLoc: WebGLUniformLocation | null = null;
  private uColorMixingLoc: WebGLUniformLocation | null = null;
  private uPerceptualMixingLoc: WebGLUniformLocation | null = null;
  private uHasCanvasTextureLoc: WebGLUniformLocation | null = null;
  private uCanvasTextureLoc: WebGLUniformLocation | null = null;
  private uAmountOfPaintLoc: WebGLUniformLocation | null = null;
  private uDensityOfPaintLoc: WebGLUniformLocation | null = null;
  private uColorStretchLoc: WebGLUniformLocation | null = null;
  private uIsEraserLoc: WebGLUniformLocation | null = null;
  private uIsBgEraserLoc: WebGLUniformLocation | null = null;

  // Uniform locations (Ribbon Mesh)
  private uRibbonCanvasResolutionLoc: WebGLUniformLocation | null = null;
  private aRibbonPosLoc: number = -1;
  private aRibbonNormalDistLoc: number = -1;
  private aRibbonColorLoc: number = -1;
  private aRibbonWidthLoc: number = -1;

  // Textures cache
  private tipTexturesMap = new Map<string, WebGLTexture>();
  private canvasLayerTexture: WebGLTexture | null = null;

  // Dab geometry & instancing buffers
  private quadVertexBuffer: WebGLBuffer | null = null;
  private extInstanced: {
    drawArraysInstanced: (mode: number, first: number, count: number, instanceCount: number) => void;
    vertexAttribDivisor: (index: number, divisor: number) => void;
  } | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private instanceArray: Float32Array = new Float32Array(4096 * 12);

  // Ribbon geometry buffers (stride 8: x, y, normalDist, width, r, g, b, a)
  private ribbonBuffer: WebGLBuffer | null = null;
  private ribbonArray: Float32Array = new Float32Array(1024 * 8);

  private constructor() {
    if (typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.canvas.width = 1024;
      this.canvas.height = 1024;
      this.initGl();
    }
  }

  public static getInstance(): WebGlBrushEngine {
    if (!WebGlBrushEngine.instance) {
      WebGlBrushEngine.instance = new WebGlBrushEngine();
    }
    return WebGlBrushEngine.instance;
  }

  /**
   * Initializes the WebGL context and GPU shader programs.
   */
  private initGl() {
    if (!this.canvas) {
      this.isGpuAvailable = false;
      return;
    }
    try {
      const glOpts: WebGLContextAttributes = {
        alpha: true,
        antialias: true,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
      };

      const gl = (this.canvas.getContext('webgl2', glOpts) ||
        this.canvas.getContext('webgl', glOpts) ||
        this.canvas.getContext('experimental-webgl', glOpts)) as WebGLRenderingContext | null;

      if (!gl || typeof gl.createProgram !== 'function') {
        this.isGpuAvailable = false;
        return;
      }

      this.gl = gl;

      // Query host video card information
      let renderer = 'Generic WebGL GPU';
      let vendor = 'Generic';
      if (typeof gl.getExtension === 'function') {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) {
          renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || renderer;
          vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || vendor;
        }
      }
      const glVersion = (typeof gl.getParameter === 'function' && gl.getParameter(gl.VERSION)) || 'WebGL';

      this.gpuInfo = {
        isSupported: true,
        renderer,
        vendor,
        glVersion,
      };

      // 1. Compile Instanced Dab shader pipeline
      const vs = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
      const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);

      if (vs && fs) {
        const program = gl.createProgram();
        if (program) {
          gl.attachShader(program, vs);
          gl.attachShader(program, fs);
          gl.linkProgram(program);
          if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
            this.program = program;
            this.uCanvasResolutionLoc = gl.getUniformLocation(program, 'u_canvasResolution');
            this.uHasTipTextureLoc = gl.getUniformLocation(program, 'u_hasTipTexture');
            this.uTipTextureLoc = gl.getUniformLocation(program, 'u_tipTexture');
            this.uHasDualTipTextureLoc = gl.getUniformLocation(program, 'u_hasDualTipTexture');
            this.uDualTipTextureLoc = gl.getUniformLocation(program, 'u_dualTipTexture');
            this.uDualBlendModeLoc = gl.getUniformLocation(program, 'u_dualBlendMode');
            this.uHardnessLoc = gl.getUniformLocation(program, 'u_hardness');
            this.uWetEdgeLoc = gl.getUniformLocation(program, 'u_wetEdge');
            this.uPaperGrainLoc = gl.getUniformLocation(program, 'u_paperGrain');
            this.uGrainScaleLoc = gl.getUniformLocation(program, 'u_grainScale');
            this.uColorMixingLoc = gl.getUniformLocation(program, 'u_colorMixing');
            this.uPerceptualMixingLoc = gl.getUniformLocation(program, 'u_perceptualMixing');
            this.uHasCanvasTextureLoc = gl.getUniformLocation(program, 'u_hasCanvasTexture');
            this.uCanvasTextureLoc = gl.getUniformLocation(program, 'u_canvasTexture');
            this.uAmountOfPaintLoc = gl.getUniformLocation(program, 'u_amountOfPaint');
            this.uDensityOfPaintLoc = gl.getUniformLocation(program, 'u_densityOfPaint');
            this.uColorStretchLoc = gl.getUniformLocation(program, 'u_colorStretch');
            this.uIsEraserLoc = gl.getUniformLocation(program, 'u_isEraser');
            this.uIsBgEraserLoc = gl.getUniformLocation(program, 'u_isBgEraser');
          }
        }
      }

      // 2. Compile Track A Ribbon shader pipeline
      const rVs = this.compileShader(gl.VERTEX_SHADER, RIBBON_VERTEX_SHADER_SRC);
      const rFs = this.compileShader(gl.FRAGMENT_SHADER, RIBBON_FRAGMENT_SHADER_SRC);

      if (rVs && rFs) {
        const rProgram = gl.createProgram();
        if (rProgram) {
          gl.attachShader(rProgram, rVs);
          gl.attachShader(rProgram, rFs);
          gl.linkProgram(rProgram);
          if (gl.getProgramParameter(rProgram, gl.LINK_STATUS)) {
            this.ribbonProgram = rProgram;
            this.uRibbonCanvasResolutionLoc = gl.getUniformLocation(rProgram, 'u_canvasResolution');
            this.aRibbonPosLoc = gl.getAttribLocation(rProgram, 'a_pos');
            this.aRibbonNormalDistLoc = gl.getAttribLocation(rProgram, 'a_normalDist');
            this.aRibbonColorLoc = gl.getAttribLocation(rProgram, 'a_color');
            this.aRibbonWidthLoc = gl.getAttribLocation(rProgram, 'a_width');
          }
        }
      }

      // Create static quad vertex buffer: two triangles forming [-0.5, 0.5] quad
      const quadVertices = new Float32Array([
        -0.5, -0.5,
         0.5, -0.5,
        -0.5,  0.5,
        -0.5,  0.5,
         0.5, -0.5,
         0.5,  0.5,
      ]);
      this.quadVertexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

      // Create ribbon dynamic vertex buffer
      this.ribbonBuffer = gl.createBuffer();

      // Initialize hardware instanced array support
      if ('drawArraysInstanced' in gl) {
        this.extInstanced = {
          drawArraysInstanced: (mode: number, first: number, count: number, instanceCount: number) => {
            (gl as any).drawArraysInstanced(mode, first, count, instanceCount);
          },
          vertexAttribDivisor: (index: number, divisor: number) => {
            (gl as any).vertexAttribDivisor(index, divisor);
          },
        };
      } else if (typeof gl.getExtension === 'function') {
        const ext = gl.getExtension('ANGLE_instanced_arrays');
        if (ext) {
          this.extInstanced = {
            drawArraysInstanced: (mode: number, first: number, count: number, instanceCount: number) => {
              ext.drawArraysInstancedANGLE(mode, first, count, instanceCount);
            },
            vertexAttribDivisor: (index: number, divisor: number) => {
              ext.vertexAttribDivisorANGLE(index, divisor);
            },
          };
        }
      }
      this.instanceBuffer = gl.createBuffer();

      // Configure standard alpha blending
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      this.isGpuAvailable = this.program !== null || this.ribbonProgram !== null;
    } catch {
      this.isGpuAvailable = false;
    }
  }

  private compileShader(type: number, src: string): WebGLShader | null {
    if (!this.gl) return null;
    const shader = this.gl.createShader(type);
    if (!shader) return null;
    this.gl.shaderSource(shader, src);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      this.gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  public getGpuInfo(): GpuInfo {
    return this.gpuInfo;
  }

  public isAvailable(): boolean {
    return this.isGpuAvailable && this.gl !== null;
  }

  /**
   * Retrieves or uploads a brush tip texture to GPU memory.
   */
  public getOrCreateTipTexture(image: HTMLImageElement): WebGLTexture | null {
    if (!this.gl || !image || !image.src) return null;
    const cached = this.tipTexturesMap.get(image.src);
    if (cached) return cached;

    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) return null;

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.tipTexturesMap.set(image.src, tex);
    return tex;
  }

  /**
   * Synchronizes underlying canvas layer texture for real-time CSP color mixing.
   */
  public uploadCanvasTexture(sourceCanvas: HTMLCanvasElement): WebGLTexture | null {
    if (!this.gl) return null;
    const gl = this.gl;

    if (!this.canvasLayerTexture) {
      this.canvasLayerTexture = gl.createTexture();
    }
    const tex = this.canvasLayerTexture;
    if (!tex) return null;

    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    return tex;
  }

  /**
   * Parses hex or rgb color string into normalized RGB [0, 1].
   */
  public parseColor(color: string): { r: number; g: number; b: number } {
    if (color.startsWith('#')) {
      let hex = color.slice(1);
      if (hex.length === 3) {
        hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      }
      const num = parseInt(hex, 16);
      return {
        r: ((num >> 16) & 255) / 255,
        g: ((num >> 8) & 255) / 255,
        b: (num & 255) / 255,
      };
    }
    return { r: 0.1, g: 0.1, b: 0.1 };
  }

  /**
   * Track A: Ribbon Inking Engine (G-Pen, Manga Inking, Clean Vector/Raster Lines)
   * Evaluates spline into continuous polygonal triangle strip (gl.TRIANGLE_STRIP)
   * with normal extrusion and analytical distance field (SDF) antialiasing.
   */
  public renderRibbonSegment(
    targetCtx: CanvasRenderingContext2D,
    p0: Point,
    c1: Point,
    c2: Point,
    p3: Point,
    color: string,
    opacity: number = 1.0,
    canvasWidth: number,
    canvasHeight: number,
    isEraser: boolean = false,
    isBgEraser: boolean = false
  ): boolean {
    const canvas = this.canvas;
    if (!this.isAvailable() || !this.gl || !canvas || !this.ribbonProgram || !this.ribbonBuffer) {
      return false;
    }

    const gl = this.gl;
    const chord = Math.hypot(p3.x - p0.x, p3.y - p0.y);
    const avgW = Math.max(0.5, (p0.width + p3.width) * 0.5);
    const steps = Math.max(8, Math.min(48, Math.ceil(chord / Math.max(1.0, avgW * 0.25))));

    // Stride 8: [x, y, normalDist, width, r, g, b, a]
    const vertexCount = (steps + 1) * 2;
    const requiredFloats = vertexCount * 8;
    if (this.ribbonArray.length < requiredFloats) {
      this.ribbonArray = new Float32Array(Math.max(requiredFloats, this.ribbonArray.length * 2));
    }
    const arr = this.ribbonArray;

    const rgb = isBgEraser ? { r: 1, g: 1, b: 1 } : this.parseColor(color);
    const alpha = Math.max(0.01, Math.min(1.0, opacity));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    let vIdx = 0;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const it = 1 - t;

      // Position along cubic Bézier
      const px = it * it * it * p0.x + 3 * it * it * t * c1.x + 3 * it * t * t * c2.x + t * t * t * p3.x;
      const py = it * it * it * p0.y + 3 * it * it * t * c1.y + 3 * it * t * t * c2.y + t * t * t * p3.y;

      // Derivative (tangent)
      const dpx = 3 * it * it * (c1.x - p0.x) + 6 * it * t * (c2.x - c1.x) + 3 * t * t * (p3.x - c2.x);
      const dpy = 3 * it * it * (c1.y - p0.y) + 6 * it * t * (c2.y - c1.y) + 3 * t * t * (p3.y - c2.y);
      const speed = Math.hypot(dpx, dpy);

      let nx = 0;
      let ny = 1;
      if (speed > 1e-4) {
        nx = -dpy / speed;
        ny = dpx / speed;
      }

      // Interpolated stroke width
      const w = Math.max(0.5, p0.width + (p3.width - p0.width) * t);
      const halfW = w * 0.5;

      // Left vertex
      const lx = px + nx * halfW;
      const ly = py + ny * halfW;
      // Right vertex
      const rx = px - nx * halfW;
      const ry = py - ny * halfW;

      // Update dirty bounding box
      minX = Math.min(minX, lx, rx);
      minY = Math.min(minY, ly, ry);
      maxX = Math.max(maxX, lx, rx);
      maxY = Math.max(maxY, ly, ry);

      // Left vertex (normalDist = -1.0)
      arr[vIdx++] = lx;
      arr[vIdx++] = ly;
      arr[vIdx++] = -1.0;
      arr[vIdx++] = w;
      arr[vIdx++] = rgb.r;
      arr[vIdx++] = rgb.g;
      arr[vIdx++] = rgb.b;
      arr[vIdx++] = alpha;

      // Right vertex (normalDist = +1.0)
      arr[vIdx++] = rx;
      arr[vIdx++] = ry;
      arr[vIdx++] = 1.0;
      arr[vIdx++] = w;
      arr[vIdx++] = rgb.r;
      arr[vIdx++] = rgb.g;
      arr[vIdx++] = rgb.b;
      arr[vIdx++] = alpha;
    }

    const pad = 4;
    const sx = Math.max(0, Math.floor(minX - pad));
    const sy = Math.max(0, Math.floor(minY - pad));
    const ex = Math.min(canvasWidth, Math.ceil(maxX + pad));
    const ey = Math.min(canvasHeight, Math.ceil(maxY + pad));
    const dw = ex - sx;
    const dh = ey - sy;

    if (dw <= 0 || dh <= 0) return false;

    // Resize GPU canvas if needed
    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
    }

    gl.viewport(0, 0, canvasWidth, canvasHeight);
    if (typeof gl.scissor === 'function') {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(sx, Math.max(0, canvasHeight - ey), dw, dh);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.ribbonProgram);
    gl.uniform2f(this.uRibbonCanvasResolutionLoc, canvasWidth, canvasHeight);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.ribbonBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, requiredFloats), gl.DYNAMIC_DRAW);

    const byteStride = 8 * 4;
    gl.enableVertexAttribArray(this.aRibbonPosLoc);
    gl.vertexAttribPointer(this.aRibbonPosLoc, 2, gl.FLOAT, false, byteStride, 0);

    gl.enableVertexAttribArray(this.aRibbonNormalDistLoc);
    gl.vertexAttribPointer(this.aRibbonNormalDistLoc, 1, gl.FLOAT, false, byteStride, 2 * 4);

    gl.enableVertexAttribArray(this.aRibbonWidthLoc);
    gl.vertexAttribPointer(this.aRibbonWidthLoc, 1, gl.FLOAT, false, byteStride, 3 * 4);

    gl.enableVertexAttribArray(this.aRibbonColorLoc);
    gl.vertexAttribPointer(this.aRibbonColorLoc, 4, gl.FLOAT, false, byteStride, 4 * 4);

    // Render continuous triangle strip
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, vertexCount);

    if (typeof gl.scissor === 'function') {
      gl.disable(gl.SCISSOR_TEST);
    }

    gl.disableVertexAttribArray(this.aRibbonPosLoc);
    gl.disableVertexAttribArray(this.aRibbonNormalDistLoc);
    gl.disableVertexAttribArray(this.aRibbonWidthLoc);
    gl.disableVertexAttribArray(this.aRibbonColorLoc);

    // Blit hardware GPU dirty rect onto target context
    targetCtx.save();
    if (isBgEraser) {
      targetCtx.globalCompositeOperation = 'source-over';
    } else if (isEraser) {
      targetCtx.globalCompositeOperation = 'destination-out';
    } else {
      targetCtx.globalCompositeOperation = 'source-over';
    }
    targetCtx.globalAlpha = 1.0;
    targetCtx.drawImage(canvas, sx, sy, dw, dh, sx, sy, dw, dh);
    targetCtx.restore();

    return true;
  }

  /**
   * Track B: GPU Instanced Stamp Engine (Pencils, Dry Brushes, Textured Tips)
   * Batches thousands of textured dabs into a single GPU draw call per frame.
   */
  public renderDabsToContext(
    targetCtx: CanvasRenderingContext2D,
    dabs: GpuDab[],
    settings: BrushSettings,
    tool: ToolType,
    canvasWidth: number,
    canvasHeight: number,
    underlyingCanvas?: HTMLCanvasElement
  ): boolean {
    const canvas = this.canvas;
    if (!this.isAvailable() || !this.gl || !canvas || !this.program || dabs.length === 0) {
      return false;
    }

    const gl = this.gl;
    const isEraser = tool === 'eraser';
    const isBgEraser = isEraser && targetCtx.fillStyle === '#ffffff';

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < dabs.length; i++) {
      const d = dabs[i];
      const rad = Math.max(d.width, d.height) * 0.75 + 4;
      if (d.x - rad < minX) minX = d.x - rad;
      if (d.y - rad < minY) minY = d.y - rad;
      if (d.x + rad > maxX) maxX = d.x + rad;
      if (d.y + rad > maxY) maxY = d.y + rad;
    }

    const dirtyX = Math.max(0, Math.floor(minX));
    const dirtyY = Math.max(0, Math.floor(minY));
    const dirtyMaxX = Math.min(canvasWidth, Math.ceil(maxX));
    const dirtyMaxY = Math.min(canvasHeight, Math.ceil(maxY));
    const dirtyW = Math.max(0, dirtyMaxX - dirtyX);
    const dirtyH = Math.max(0, dirtyMaxY - dirtyY);

    if (dirtyW <= 0 || dirtyH <= 0) {
      return false;
    }

    // Resize GPU canvas if needed
    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
    }

    gl.viewport(0, 0, canvasWidth, canvasHeight);
    if (typeof gl.scissor === 'function') {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(dirtyX, Math.max(0, canvasHeight - dirtyMaxY), dirtyW, dirtyH);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);

    gl.uniform2f(this.uCanvasResolutionLoc, canvasWidth, canvasHeight);
    gl.uniform1f(this.uHardnessLoc, settings.hardness ?? 1.0);
    gl.uniform1f(this.uWetEdgeLoc, settings.wetEdge ?? 0.0);
    gl.uniform1f(this.uPaperGrainLoc, settings.grain ?? (settings.textureDensity ?? 0.0));
    gl.uniform1f(this.uGrainScaleLoc, settings.paperTextureScale ?? 1.0);
    gl.uniform1i(this.uIsEraserLoc, isEraser ? 1 : 0);
    gl.uniform1i(this.uIsBgEraserLoc, isBgEraser ? 1 : 0);

    // Primary Tip Texture
    let tipTex: WebGLTexture | null = null;
    if (settings.customTipImage) {
      tipTex = this.getOrCreateTipTexture(settings.customTipImage);
    }
    if (tipTex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tipTex);
      gl.uniform1i(this.uTipTextureLoc, 0);
      gl.uniform1i(this.uHasTipTextureLoc, 1);
    } else {
      gl.uniform1i(this.uHasTipTextureLoc, 0);
    }

    // Dual-Brush Tip Texture Modulation
    let dualTipTex: WebGLTexture | null = null;
    if (settings.dualBrush && settings.dualTipImage) {
      dualTipTex = this.getOrCreateTipTexture(settings.dualTipImage);
    }
    if (dualTipTex) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, dualTipTex);
      gl.uniform1i(this.uDualTipTextureLoc, 2);
      gl.uniform1i(this.uHasDualTipTextureLoc, 1);
      const dualMode =
        settings.dualBrushCompositeMode === 'subtract'
          ? 1
          : settings.dualBrushCompositeMode === 'darken'
          ? 2
          : settings.dualBrushCompositeMode === 'overlay'
          ? 3
          : settings.dualBrushCompositeMode === 'screen'
          ? 4
          : 0;
      gl.uniform1i(this.uDualBlendModeLoc, dualMode);
    } else {
      gl.uniform1i(this.uHasDualTipTextureLoc, 0);
    }

    // Color Mixing (OKLab + Kubelka-Munk perceptual pigment mixing by default)
    const enableColorMix = Boolean(settings.colorMixing) && underlyingCanvas !== undefined;
    gl.uniform1i(this.uColorMixingLoc, enableColorMix ? 1 : 0);
    gl.uniform1i(this.uPerceptualMixingLoc, settings.perceptualMixing !== false ? 1 : 0);

    if (enableColorMix && underlyingCanvas) {
      const canvasTex = this.uploadCanvasTexture(underlyingCanvas);
      if (canvasTex) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, canvasTex);
        gl.uniform1i(this.uCanvasTextureLoc, 1);
        gl.uniform1i(this.uHasCanvasTextureLoc, 1);
        gl.uniform1f(this.uAmountOfPaintLoc, settings.amountOfPaint ?? 0.7);
        gl.uniform1f(this.uDensityOfPaintLoc, settings.densityOfPaint ?? 0.8);
        gl.uniform1f(this.uColorStretchLoc, settings.colorStretch ?? 0.6);
      } else {
        gl.uniform1i(this.uHasCanvasTextureLoc, 0);
      }
    } else {
      gl.uniform1i(this.uHasCanvasTextureLoc, 0);
    }

    const aQuadVertexLoc = gl.getAttribLocation(this.program, 'a_quadVertex');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVertexBuffer);
    gl.enableVertexAttribArray(aQuadVertexLoc);
    gl.vertexAttribPointer(aQuadVertexLoc, 2, gl.FLOAT, false, 0, 0);

    const aCenterLoc = gl.getAttribLocation(this.program, 'a_center');
    const aSizeLoc = gl.getAttribLocation(this.program, 'a_size');
    const aAngleLoc = gl.getAttribLocation(this.program, 'a_angle');
    const aColorLoc = gl.getAttribLocation(this.program, 'a_color');
    const aAlphaLoc = gl.getAttribLocation(this.program, 'a_alpha');
    const aPressureLoc = gl.getAttribLocation(this.program, 'a_pressure');
    const aStrokeDistLoc = gl.getAttribLocation(this.program, 'a_strokeDist');

    if (this.extInstanced && this.instanceBuffer && dabs.length > 0) {
      const stride = 12;
      const requiredFloats = dabs.length * stride;
      if (this.instanceArray.length < requiredFloats) {
        this.instanceArray = new Float32Array(Math.max(requiredFloats, this.instanceArray.length * 2));
      }
      const arr = this.instanceArray;
      for (let i = 0; i < dabs.length; i++) {
        const d = dabs[i];
        const offset = i * stride;
        arr[offset + 0] = d.x;
        arr[offset + 1] = d.y;
        arr[offset + 2] = d.width;
        arr[offset + 3] = d.height;
        arr[offset + 4] = d.angle;
        arr[offset + 5] = d.r;
        arr[offset + 6] = d.g;
        arr[offset + 7] = d.b;
        arr[offset + 8] = 1.0;
        arr[offset + 9] = d.alpha;
        arr[offset + 10] = d.pressure;
        arr[offset + 11] = d.strokeDist;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, requiredFloats), gl.DYNAMIC_DRAW);

      const byteStride = stride * 4;

      gl.enableVertexAttribArray(aCenterLoc);
      gl.vertexAttribPointer(aCenterLoc, 2, gl.FLOAT, false, byteStride, 0);
      this.extInstanced.vertexAttribDivisor(aCenterLoc, 1);

      gl.enableVertexAttribArray(aSizeLoc);
      gl.vertexAttribPointer(aSizeLoc, 2, gl.FLOAT, false, byteStride, 2 * 4);
      this.extInstanced.vertexAttribDivisor(aSizeLoc, 1);

      gl.enableVertexAttribArray(aAngleLoc);
      gl.vertexAttribPointer(aAngleLoc, 1, gl.FLOAT, false, byteStride, 4 * 4);
      this.extInstanced.vertexAttribDivisor(aAngleLoc, 1);

      gl.enableVertexAttribArray(aColorLoc);
      gl.vertexAttribPointer(aColorLoc, 4, gl.FLOAT, false, byteStride, 5 * 4);
      this.extInstanced.vertexAttribDivisor(aColorLoc, 1);

      gl.enableVertexAttribArray(aAlphaLoc);
      gl.vertexAttribPointer(aAlphaLoc, 1, gl.FLOAT, false, byteStride, 9 * 4);
      this.extInstanced.vertexAttribDivisor(aAlphaLoc, 1);

      gl.enableVertexAttribArray(aPressureLoc);
      gl.vertexAttribPointer(aPressureLoc, 1, gl.FLOAT, false, byteStride, 10 * 4);
      this.extInstanced.vertexAttribDivisor(aPressureLoc, 1);

      gl.enableVertexAttribArray(aStrokeDistLoc);
      gl.vertexAttribPointer(aStrokeDistLoc, 1, gl.FLOAT, false, byteStride, 11 * 4);
      this.extInstanced.vertexAttribDivisor(aStrokeDistLoc, 1);

      this.extInstanced.drawArraysInstanced(gl.TRIANGLES, 0, 6, dabs.length);

      this.extInstanced.vertexAttribDivisor(aCenterLoc, 0);
      this.extInstanced.vertexAttribDivisor(aSizeLoc, 0);
      this.extInstanced.vertexAttribDivisor(aAngleLoc, 0);
      this.extInstanced.vertexAttribDivisor(aColorLoc, 0);
      this.extInstanced.vertexAttribDivisor(aAlphaLoc, 0);
      this.extInstanced.vertexAttribDivisor(aPressureLoc, 0);
      this.extInstanced.vertexAttribDivisor(aStrokeDistLoc, 0);

      gl.disableVertexAttribArray(aCenterLoc);
      gl.disableVertexAttribArray(aSizeLoc);
      gl.disableVertexAttribArray(aAngleLoc);
      gl.disableVertexAttribArray(aColorLoc);
      gl.disableVertexAttribArray(aAlphaLoc);
      gl.disableVertexAttribArray(aPressureLoc);
      gl.disableVertexAttribArray(aStrokeDistLoc);
    } else {
      for (const dab of dabs) {
        gl.vertexAttrib2f(aCenterLoc, dab.x, dab.y);
        gl.vertexAttrib2f(aSizeLoc, dab.width, dab.height);
        gl.vertexAttrib1f(aAngleLoc, dab.angle);
        gl.vertexAttrib4f(aColorLoc, dab.r, dab.g, dab.b, 1.0);
        gl.vertexAttrib1f(aAlphaLoc, dab.alpha);
        gl.vertexAttrib1f(aPressureLoc, dab.pressure);
        gl.vertexAttrib1f(aStrokeDistLoc, dab.strokeDist);

        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    }

    if (typeof gl.scissor === 'function') {
      gl.disable(gl.SCISSOR_TEST);
    }

    targetCtx.save();
    if (isBgEraser) {
      targetCtx.globalCompositeOperation = 'source-over';
    } else if (isEraser) {
      targetCtx.globalCompositeOperation = 'destination-out';
    } else {
      targetCtx.globalCompositeOperation = 'source-over';
    }
    targetCtx.globalAlpha = 1.0;
    targetCtx.drawImage(canvas, dirtyX, dirtyY, dirtyW, dirtyH, dirtyX, dirtyY, dirtyW, dirtyH);
    targetCtx.restore();

    return true;
  }

  /**
   * Generates arc-length sampled sub-pixel dabs along a Bézier curve.
   */
  public generateArcLengthDabs(
    p0: Point,
    control: Point,
    p2: Point,
    settings: BrushSettings,
    color: string,
    startDist: number = 0,
    cumulativeStrokeDist: number = 0
  ): { dabs: GpuDab[]; remainderDist: number; totalStrokeDist: number } {
    const dabs: GpuDab[] = [];
    const rgb = this.parseColor(color);
    const spacingRatio = Math.max(0.06, Math.min(1.0, settings.spacing ?? 0.08));
    const flow = settings.flow ?? 0.85;
    const aspect =
      settings.customTipImage && settings.customTipImage.naturalWidth
        ? (settings.customTipImage.naturalHeight || 1) / (settings.customTipImage.naturalWidth || 1)
        : 1.0;
    const baseAngleRad = ((settings.customTipAngle ?? 0) * Math.PI) / 180;
    const angleDynamics = settings.customTipAngleDynamics ?? 'none';

    const chord = Math.hypot(p2.x - p0.x, p2.y - p0.y);
    const avgWidth = Math.max(1, (p0.width + p2.width) / 2);
    const steps = Math.max(8, Math.min(128, Math.ceil(chord / Math.max(0.5, avgWidth * 0.1))));

    let accDist = startDist;
    let strokeDist = cumulativeStrokeDist;

    let prevX = p0.x;
    let prevY = p0.y;

    const dynamics = settings.dynamics;
    const dabCount = Math.max(1, Math.min(10, Math.round(dynamics?.count ?? 1)));
    const sizeJitter = Math.max(0, Math.min(1, dynamics?.sizeJitter ?? 0));
    const angleJitter = Math.max(0, Math.min(1, dynamics?.angleJitter ?? 0));
    const roundnessJitter = Math.max(0, Math.min(1, dynamics?.roundnessJitter ?? 0));
    const scatter = Math.max(0, Math.min(5, dynamics?.scatter ?? 0));
    const scatterBothAxes = Boolean(dynamics?.scatterBothAxes);
    const flowJitter = Math.max(0, Math.min(1, dynamics?.flowJitter ?? 0));
    const colorJitterEnabled = Boolean(dynamics?.colorJitterEnabled);
    const secondaryRgb = colorJitterEnabled ? this.parseColor(settings.secondaryColor || '#ffffff') : null;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const it = 1 - t;

      const curX = it * it * p0.x + 2 * it * t * control.x + t * t * p2.x;
      const curY = it * it * p0.y + 2 * it * t * control.y + t * t * p2.y;

      const dx = curX - prevX;
      const dy = curY - prevY;
      const stepDist = Math.hypot(dx, dy);

      accDist += stepDist;
      strokeDist += stepDist;

      const effPressure = p0.pressure + (p2.pressure - p0.pressure) * t;
      const rawWidth = p0.width + (p2.width - p0.width) * t;
      const curWidth = Math.max(0.5, rawWidth);

      const requiredSpacing = Math.max(0.5, curWidth * spacingRatio);

      if (accDist >= requiredSpacing) {
        let baseAngle = baseAngleRad;
        if (angleDynamics === 'direction' && stepDist > 0.001) {
          baseAngle += Math.atan2(dy, dx);
        } else if (angleDynamics === 'random' && settings.customTipRotationRandomScale) {
          baseAngle += (Math.random() - 0.5) * Math.PI * 2 * settings.customTipRotationRandomScale;
        }

        let tx = 0;
        let ty = 0;
        let nx = 0;
        let ny = 0;
        if (stepDist > 0.001) {
          tx = dx / stepDist;
          ty = dy / stepDist;
          nx = -ty;
          ny = tx;
        } else {
          nx = 0;
          ny = 1;
          tx = 1;
          ty = 0;
        }

        for (let k = 0; k < dabCount; k++) {
          let curDabW = curWidth;
          if (sizeJitter > 0) {
            curDabW *= Math.max(0.01, 1.0 - Math.random() * sizeJitter);
          }
          curDabW = Math.max(0.1, curDabW);

          let curDabThickness = 1.0;
          if (roundnessJitter > 0) {
            curDabThickness *= Math.max(0.05, 1.0 - Math.random() * roundnessJitter);
          }

          let curDabAngle = baseAngle;
          if (angleJitter > 0) {
            curDabAngle += (Math.random() - 0.5) * Math.PI * 2 * angleJitter;
          }

          let curDabX = curX;
          let curDabY = curY;
          if (scatter > 0) {
            const perpDist = (Math.random() * 2 - 1) * curWidth * scatter;
            let sOffX = nx * perpDist;
            let sOffY = ny * perpDist;
            if (scatterBothAxes) {
              const tangDist = (Math.random() * 2 - 1) * curWidth * scatter;
              sOffX += tx * tangDist;
              sOffY += ty * tangDist;
            }
            curDabX += sOffX;
            curDabY += sOffY;
          }

          let curDabAlpha = flow;
          if (flowJitter > 0) {
            curDabAlpha *= Math.max(0.005, 1.0 - Math.random() * flowJitter);
          }

          let dabR = rgb.r;
          let dabG = rgb.g;
          let dabB = rgb.b;
          if (colorJitterEnabled && dynamics && secondaryRgb) {
            const cd = applyColorDynamics(rgb, secondaryRgb, dynamics);
            dabR = cd.r;
            dabG = cd.g;
            dabB = cd.b;
          }

          if (settings.spray?.enabled) {
            const pCount = settings.spray.density;
            const pSize = Math.max(1, settings.spray.size);
            const radius = curDabW / 2;
            for (let sp = 0; sp < pCount; sp++) {
              const u1 = Math.random();
              const u2 = Math.random();
              const r = radius * Math.sqrt(u1) * (1 - (settings.spray.bias || 0) * (1 - u2));
              const th = Math.PI * 2 * Math.random();
              dabs.push({
                x: curDabX + r * Math.cos(th),
                y: curDabY + r * Math.sin(th),
                width: pSize,
                height: pSize * aspect * curDabThickness,
                angle: curDabAngle,
                r: dabR,
                g: dabG,
                b: dabB,
                alpha: curDabAlpha,
                pressure: effPressure,
                strokeDist,
              });
            }
          } else {
            dabs.push({
              x: curDabX,
              y: curDabY,
              width: curDabW,
              height: curDabW * aspect * curDabThickness,
              angle: curDabAngle,
              r: dabR,
              g: dabG,
              b: dabB,
              alpha: curDabAlpha,
              pressure: effPressure,
              strokeDist,
            });
          }
        }

        accDist = 0;
      }

      prevX = curX;
      prevY = curY;
    }

    return { dabs, remainderDist: accDist, totalStrokeDist: strokeDist };
  }
}
