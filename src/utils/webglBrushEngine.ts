import { Point, BrushSettings, ToolType } from '../types/editor';
import { evaluateCspSpline } from './sutParser';

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
interface GpuDab {
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
// Shaders for GPU Video Card Execution
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

uniform float u_hardness;        // 0.05 to 1.0
uniform float u_wetEdge;         // 0.0 to 1.0 (CSP Watercolor Water Edge)
uniform float u_paperGrain;      // 0.0 to 1.0 (CSP Paper Tooth)
uniform float u_grainScale;      // scale of paper texture

uniform bool u_colorMixing;      // CSP Color Mixing active
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

  if (tipAlpha <= 0.002) {
    discard;
  }

  vec3 rgb = v_color.rgb;

  // 2. CSP Wet Edge (Water Edge - capillary accumulation at stroke perimeter)
  if (u_wetEdge > 0.001) {
    // Rim density accumulation curve
    float rim = smoothstep(0.55, 0.94, dist) * (1.0 - smoothstep(0.95, 1.0, dist));
    float edgeBoost = 1.0 + u_wetEdge * 2.2 * rim;
    tipAlpha = clamp(tipAlpha * edgeBoost, 0.0, 1.0);

    // Subtle edge pigment darkening typical of drying watercolor
    rgb = mix(rgb, rgb * 0.72, u_wetEdge * rim * 0.55);
  }

  // 3. CSP Paper Grain / Canvas Tooth
  if (u_paperGrain > 0.001) {
    float tooth = getPaperGrain(v_worldPos);
    // Stylus pressure penetration: hard pressure fills paper troughs, light touches only peaks
    float penetration = clamp(v_pressure * 0.75, 0.0, 0.85);
    float grainFactor = clamp(1.0 - u_paperGrain * (1.0 - tooth) * (1.0 - penetration), 0.05, 1.0);
    tipAlpha *= grainFactor;
  }

  // 4. CSP Color Mixing & Smear (Amount of Paint, Density of Paint, Color Stretch)
  if (u_colorMixing && u_hasCanvasTexture && !u_isEraser) {
    vec2 canvasUv = v_worldPos / u_canvasResolution;
    canvasUv.y = 1.0 - canvasUv.y; // Correct UV flip
    vec4 canvasColor = texture2D(u_canvasTexture, canvasUv);

    if (canvasColor.a > 0.02) {
      // Color Stretch exponential decay along stroke length
      float stretchDistLimit = max(20.0, u_colorStretch * 600.0);
      float stretchDecay = exp(-v_strokeDist / stretchDistLimit);

      // Amount of paint controls ratio of fresh ink vs picked canvas color
      float effectiveAmount = clamp(u_amountOfPaint * (1.0 - stretchDecay * 0.7), 0.04, 0.98);
      rgb = mix(canvasColor.rgb, rgb, effectiveAmount);

      // Density of paint modulates deposition alpha
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

/**
 * WebGL-accelerated GPU brush engine.
 * Computes all cutting-edge CSP brush mathematics directly on the video card!
 */
export class WebGlBrushEngine {
  private static instance: WebGlBrushEngine | null = null;

  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private isGpuAvailable = false;
  private gpuInfo: GpuInfo = {
    isSupported: false,
    renderer: 'CPU Fallback',
    vendor: 'Standard',
    glVersion: 'None',
  };

  // Uniform locations
  private uCanvasResolutionLoc: WebGLUniformLocation | null = null;
  private uHasTipTextureLoc: WebGLUniformLocation | null = null;
  private uTipTextureLoc: WebGLUniformLocation | null = null;
  private uHardnessLoc: WebGLUniformLocation | null = null;
  private uWetEdgeLoc: WebGLUniformLocation | null = null;
  private uPaperGrainLoc: WebGLUniformLocation | null = null;
  private uGrainScaleLoc: WebGLUniformLocation | null = null;
  private uColorMixingLoc: WebGLUniformLocation | null = null;
  private uHasCanvasTextureLoc: WebGLUniformLocation | null = null;
  private uCanvasTextureLoc: WebGLUniformLocation | null = null;
  private uAmountOfPaintLoc: WebGLUniformLocation | null = null;
  private uDensityOfPaintLoc: WebGLUniformLocation | null = null;
  private uColorStretchLoc: WebGLUniformLocation | null = null;
  private uIsEraserLoc: WebGLUniformLocation | null = null;
  private uIsBgEraserLoc: WebGLUniformLocation | null = null;

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

  private constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 1024;
    this.initGl();
  }

  public static getInstance(): WebGlBrushEngine {
    if (!WebGlBrushEngine.instance) {
      WebGlBrushEngine.instance = new WebGlBrushEngine();
    }
    return WebGlBrushEngine.instance;
  }

  /**
   * Initializes the WebGL context and GPU shader program.
   */
  private initGl() {
    try {
      const glOpts: WebGLContextAttributes = {
        alpha: true,
        antialias: true,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance', // Request dedicated GPU/video card
      };

      const gl = (this.canvas.getContext('webgl2', glOpts) ||
        this.canvas.getContext('webgl', glOpts) ||
        this.canvas.getContext('experimental-webgl', glOpts)) as WebGLRenderingContext | null;

      if (!gl) {
        console.warn('WebGL not supported, falling back to Canvas 2D engine.');
        return;
      }

      this.gl = gl;

      // Query host video card information
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      let renderer = 'Generic WebGL GPU';
      let vendor = 'Generic';
      if (ext) {
        renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || renderer;
        vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || vendor;
      }
      const glVersion = gl.getParameter(gl.VERSION) || 'WebGL';

      this.gpuInfo = {
        isSupported: true,
        renderer,
        vendor,
        glVersion,
      };

      // Compile shader pipeline
      const vs = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
      const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);

      if (!vs || !fs) {
        console.error('Failed to compile brush GPU shaders.');
        return;
      }

      const program = gl.createProgram();
      if (!program) return;

      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('GPU Shader program link error:', gl.getProgramInfoLog(program));
        return;
      }

      this.program = program;
      gl.useProgram(program);

      // Cache uniform locations
      this.uCanvasResolutionLoc = gl.getUniformLocation(program, 'u_canvasResolution');
      this.uHasTipTextureLoc = gl.getUniformLocation(program, 'u_hasTipTexture');
      this.uTipTextureLoc = gl.getUniformLocation(program, 'u_tipTexture');
      this.uHardnessLoc = gl.getUniformLocation(program, 'u_hardness');
      this.uWetEdgeLoc = gl.getUniformLocation(program, 'u_wetEdge');
      this.uPaperGrainLoc = gl.getUniformLocation(program, 'u_paperGrain');
      this.uGrainScaleLoc = gl.getUniformLocation(program, 'u_grainScale');
      this.uColorMixingLoc = gl.getUniformLocation(program, 'u_colorMixing');
      this.uHasCanvasTextureLoc = gl.getUniformLocation(program, 'u_hasCanvasTexture');
      this.uCanvasTextureLoc = gl.getUniformLocation(program, 'u_canvasTexture');
      this.uAmountOfPaintLoc = gl.getUniformLocation(program, 'u_amountOfPaint');
      this.uDensityOfPaintLoc = gl.getUniformLocation(program, 'u_densityOfPaint');
      this.uColorStretchLoc = gl.getUniformLocation(program, 'u_colorStretch');
      this.uIsEraserLoc = gl.getUniformLocation(program, 'u_isEraser');
      this.uIsBgEraserLoc = gl.getUniformLocation(program, 'u_isBgEraser');

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
      } else {
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

      this.isGpuAvailable = true;
      console.log(`%c[InkStudio GPU Engine]%c Running on ${renderer} (${vendor}) ${this.extInstanced ? '(Instanced Quad Core)' : ''}`, 'color: #5ce1e6; font-weight: bold;', 'color: #ffffff;');
    } catch (err) {
      console.warn('WebGL initialization exception, using fallback:', err);
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
      console.error('Shader compile error:', this.gl.getShaderInfoLog(shader));
      this.gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  public getGpuInfo(): GpuInfo {
    return this.gpuInfo;
  }

  public isAvailable(): boolean {
    return this.isGpuAvailable && this.gl !== null && this.program !== null;
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
  private parseColor(color: string): { r: number; g: number; b: number } {
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
    // Fallback: neutral dark/black
    return { r: 0.1, g: 0.1, b: 0.1 };
  }

  /**
   * Renders a series of dabs onto a target Canvas2D context using GPU hardware acceleration.
   */
  public renderDabsToContext(
    targetCtx: CanvasRenderingContext2D,
    dabs: GpuDab[],
    settings: BrushSettings,
    tool: ToolType,
    canvasWidth: number,
    canvasHeight: number,
    underlyingCanvas?: HTMLCanvasElement
  ) {
    if (!this.isAvailable() || !this.gl || !this.program || dabs.length === 0) {
      return false;
    }

    const gl = this.gl;
    const isEraser = tool === 'eraser';
    const isBgEraser = isEraser && targetCtx.fillStyle === '#ffffff';

    // Resize GPU canvas if needed
    if (this.canvas.width !== canvasWidth || this.canvas.height !== canvasHeight) {
      this.canvas.width = canvasWidth;
      this.canvas.height = canvasHeight;
    }

    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);

    // Uniforms
    gl.uniform2f(this.uCanvasResolutionLoc, canvasWidth, canvasHeight);
    gl.uniform1f(this.uHardnessLoc, settings.hardness ?? 1.0);
    gl.uniform1f(this.uWetEdgeLoc, settings.wetEdge ?? 0.0);
    gl.uniform1f(this.uPaperGrainLoc, settings.grain ?? (settings.textureDensity ?? 0.0));
    gl.uniform1f(this.uGrainScaleLoc, 1.0);
    gl.uniform1i(this.uIsEraserLoc, isEraser ? 1 : 0);
    gl.uniform1i(this.uIsBgEraserLoc, isBgEraser ? 1 : 0);

    // Tip Texture
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

    // Color Mixing
    const enableColorMix = Boolean(settings.colorMixing) && underlyingCanvas !== undefined;
    gl.uniform1i(this.uColorMixingLoc, enableColorMix ? 1 : 0);

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

    // Set up vertex attribute pointers
    const aQuadVertexLoc = gl.getAttribLocation(this.program, 'a_quadVertex');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVertexBuffer);
    gl.enableVertexAttribArray(aQuadVertexLoc);
    gl.vertexAttribPointer(aQuadVertexLoc, 2, gl.FLOAT, false, 0, 0);

    // Render in batches
    const aCenterLoc = gl.getAttribLocation(this.program, 'a_center');
    const aSizeLoc = gl.getAttribLocation(this.program, 'a_size');
    const aAngleLoc = gl.getAttribLocation(this.program, 'a_angle');
    const aColorLoc = gl.getAttribLocation(this.program, 'a_color');
    const aAlphaLoc = gl.getAttribLocation(this.program, 'a_alpha');
    const aPressureLoc = gl.getAttribLocation(this.program, 'a_pressure');
    const aStrokeDistLoc = gl.getAttribLocation(this.program, 'a_strokeDist');

    if (this.extInstanced && this.instanceBuffer && dabs.length > 0) {
      const stride = 12; // 12 floats per dab
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

      // Clean up divisors
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
      // Fallback per-dab rendering
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

    // Blit hardware-accelerated GPU buffer onto the target 2D context
    targetCtx.save();
    if (isBgEraser) {
      targetCtx.globalCompositeOperation = 'source-over';
    } else if (isEraser) {
      targetCtx.globalCompositeOperation = 'destination-out';
    } else {
      targetCtx.globalCompositeOperation = 'source-over';
    }
    targetCtx.globalAlpha = 1.0;
    targetCtx.drawImage(this.canvas, 0, 0);
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

    const baseSize = settings.size;
    const spacingRatio = Math.max(0.01, Math.min(1.0, settings.spacing ?? 0.08));
    const flow = settings.flow ?? 0.85;
    const aspect =
      settings.customTipImage && settings.customTipImage.naturalWidth
        ? (settings.customTipImage.naturalHeight || 1) / (settings.customTipImage.naturalWidth || 1)
        : 1.0;
    const baseAngleRad = ((settings.customTipAngle ?? 0) * Math.PI) / 180;
    const angleDynamics = settings.customTipAngleDynamics ?? 'none';

    // Adaptive subdivision based on curve length
    const chord = Math.hypot(p2.x - p0.x, p2.y - p0.y);
    const avgWidth = Math.max(1, (p0.width + p2.width) / 2);
    const steps = Math.max(8, Math.min(128, Math.ceil(chord / Math.max(0.5, avgWidth * 0.1))));

    let accDist = startDist;
    let strokeDist = cumulativeStrokeDist;

    let prevX = p0.x;
    let prevY = p0.y;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const invT = 1.0 - t;
      const invT2 = invT * invT;
      const t2 = t * t;
      const twoInvTT = 2.0 * invT * t;

      // Quadratic Bézier point
      const curX = invT2 * p0.x + twoInvTT * control.x + t2 * p2.x;
      const curY = invT2 * p0.y + twoInvTT * control.y + t2 * p2.y;
      const curPressure = invT * p0.pressure + t * p2.pressure;

      // Pressure curve transformation (CSP cubic spline or gamma)
      const effPressure = settings.pressureCurve
        ? evaluateCspSpline(curPressure, settings.pressureCurve)
        : (settings.pressureCurveGamma && settings.pressureCurveGamma !== 1.0
            ? Math.pow(Math.max(0.01, curPressure), settings.pressureCurveGamma)
            : curPressure);

      // Width calculation
      const minFactor = settings.minSizeFactor ?? 0.2;
      const curWidth = Math.max(1, baseSize * (minFactor + (1.0 - minFactor) * effPressure));
      const thickness = settings.thickness ?? 1.0;

      const dx = curX - prevX;
      const dy = curY - prevY;
      const stepDist = Math.hypot(dx, dy);

      accDist += stepDist;
      strokeDist += stepDist;

      const requiredInterval = Math.max(0.8, curWidth * spacingRatio);

      if (accDist >= requiredInterval) {
        let angle = baseAngleRad;
        if (angleDynamics === 'direction' && stepDist > 0.05) {
          angle = Math.atan2(dy, dx) + baseAngleRad;
        } else if (angleDynamics === 'random') {
          angle = baseAngleRad + (Math.random() - 0.5) * Math.PI * 2;
        }

        if (settings.customTipRotationRandomScale) {
          angle += (Math.random() - 0.5) * Math.PI * 2 * settings.customTipRotationRandomScale;
        }

        if (settings.spray?.enabled) {
          const pCount = settings.spray.density;
          const pSize = Math.max(1, settings.spray.size);
          const radius = curWidth / 2;
          for (let sp = 0; sp < pCount; sp++) {
            const u1 = Math.random();
            const u2 = Math.random();
            const r = radius * Math.sqrt(u1) * (1 - (settings.spray.bias || 0) * (1 - u2));
            const th = Math.PI * 2 * Math.random();
            dabs.push({
              x: curX + r * Math.cos(th),
              y: curY + r * Math.sin(th),
              width: pSize,
              height: pSize * aspect * thickness,
              angle,
              r: rgb.r,
              g: rgb.g,
              b: rgb.b,
              alpha: flow,
              pressure: effPressure,
              strokeDist,
            });
          }
        } else {
          dabs.push({
            x: curX,
            y: curY,
            width: curWidth,
            height: curWidth * aspect * thickness,
            angle,
            r: rgb.r,
            g: rgb.g,
            b: rgb.b,
            alpha: flow,
            pressure: effPressure,
            strokeDist,
          });
        }

        accDist = 0;
      }

      prevX = curX;
      prevY = curY;
    }

    return { dabs, remainderDist: accDist, totalStrokeDist: strokeDist };
  }
}
