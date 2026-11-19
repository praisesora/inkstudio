import { Point, BrushSettings, ToolType } from '../types/editor';
import { applyColorDynamics } from './stampEngine';
import { paperGrainTable, GRAIN_SIZE } from './pencilEngine';
import { computeSubpixelDabDimensions, dabHashFloat, resolveTipFlipSigns } from '../engine/CspBrushEngine';

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
  flipX?: number; // +1 or -1
  flipY?: number; // +1 or -1
}

// -------------------------------------------------------------
// Shaders for GPU Video Card Execution (Track B: Instanced CSP Dabs)
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
attribute vec2 a_flip;       // horizontal/vertical UV flip (+1 or -1)

uniform vec2 u_canvasResolution;
uniform vec2 u_dirtyOffset;

varying vec2 v_uv;
varying vec2 v_localPos;
varying vec4 v_color;
varying float v_alpha;
varying float v_pressure;
varying float v_strokeDist;
varying vec2 v_worldPos;
varying vec2 v_size;

void main() {
  vec2 flipSign = vec2(a_flip.x == 0.0 ? 1.0 : a_flip.x, a_flip.y == 0.0 ? 1.0 : a_flip.y);
  v_uv = a_quadVertex * flipSign + 0.5;
  v_localPos = a_quadVertex * 2.0; // [-1.0, 1.0]
  v_color = a_color;
  v_alpha = a_alpha;
  v_pressure = a_pressure;
  v_strokeDist = a_strokeDist;
  v_size = a_size;

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

  // Convert local dirty-rect pixel coordinates [0, dirtyW] x [0, dirtyH] to WebGL clip space [-1, 1] x [1, -1]
  vec2 clipPos = ((worldPixelPos - u_dirtyOffset) / u_canvasResolution) * 2.0 - 1.0;
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
varying vec2 v_size;

uniform bool u_hasTipTexture;
uniform bool u_isColorTip;
uniform sampler2D u_tipTexture;

uniform bool u_hasDualTipTexture;
uniform sampler2D u_dualTipTexture;
uniform int u_dualBlendMode;     // 0: multiply, 1: subtract, 2: darken, 3: overlay, 4: screen

uniform int u_antiAlias;         // 0: None (binary), 1: Weak, 2: Medium, 3: Strong
uniform float u_hardness;        // 0.0 to 1.0
uniform float u_wetEdge;         // 0.0 to 1.0
uniform float u_paperGrain;      // 0.0 to 1.0 (CSP Paper Tooth density)
uniform float u_grainScale;      // scale of paper texture
uniform float u_grainRotateRad;  // rotation of paper texture
uniform int u_paperMode;         // 0: subtract, 1: multiply, 2: compare, 3: overlay, 4: outline
uniform float u_paperBrightness; // [-1.0, 1.0]
uniform float u_paperContrast;   // [-1.0, 1.0]
uniform bool u_paperInvert;
uniform bool u_hasPaperTex;
uniform sampler2D u_paperTexture;
uniform vec2 u_paperTexSize;

uniform bool u_colorMixing;      // CSP Color Mixing active
uniform bool u_perceptualMixing; // OKLab + Kubelka-Munk spectral pigment mixing
uniform bool u_hasCanvasTexture;
uniform sampler2D u_canvasTexture;
uniform vec2 u_canvasResolution;
uniform vec2 u_docResolution;
uniform float u_amountOfPaint;
uniform float u_densityOfPaint;
uniform float u_colorStretch;
uniform bool u_isEraser;
uniform bool u_isBgEraser;

// Evaluates seamless paper grain from uploaded 512x512 cold-press texture or custom paper image
float samplePaperTooth(vec2 worldPos) {
  float invScale = 1.0 / max(0.05, u_grainScale);
  float c = cos(u_grainRotateRad);
  float s = sin(u_grainRotateRad);
  vec2 rotP = vec2(worldPos.x * c - worldPos.y * s, worldPos.x * s + worldPos.y * c) * invScale;

  float g = 0.5;
  if (u_hasPaperTex) {
    vec2 uv = fract(rotP / max(vec2(1.0), u_paperTexSize));
    vec4 pSample = texture2D(u_paperTexture, uv);
    // Support both luminance (R=G=B) and alpha-encoded CSP paper textures
    float lum = dot(pSample.rgb, vec3(0.299, 0.587, 0.114));
    g = pSample.a < 0.98 ? (1.0 - pSample.a) : lum;
  } else {
    vec2 coord = rotP * 0.09;
    float n1 = sin(coord.x * 3.1415 + coord.y * 1.7) * cos(coord.y * 2.718 - coord.x * 0.9);
    float n2 = sin(coord.x * 7.3 - coord.y * 5.1) * cos(coord.x * 4.2 + coord.y * 8.3);
    g = clamp((n1 * 0.6 + n2 * 0.4) * 0.5 + 0.5, 0.0, 1.0);
  }

  if (u_paperInvert) {
    g = 1.0 - g;
  }
  if (abs(u_paperBrightness) > 0.001) {
    g += u_paperBrightness;
  }
  if (abs(u_paperContrast) > 0.001) {
    float cf = pow(max(0.05, 1.0 + u_paperContrast), 2.0);
    g = (g - 0.5) * cf + 0.5;
  }
  return clamp(g, 0.0, 1.0);
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
  vec3 rgb = v_color.rgb;

  // 1. Base tip profile, CSP 4-level Anti-Aliasing, and Color Tip support
  float tipAlpha = 1.0;
  if (u_hasTipTexture) {
    vec4 tex = texture2D(u_tipTexture, v_uv);
    tipAlpha = tex.a;
    if (u_isColorTip) {
      rgb = tex.rgb;
    }
    if (u_antiAlias == 0) {
      tipAlpha = tipAlpha >= 0.5 ? 1.0 : 0.0;
    }
  } else {
    if (dist > 1.0) {
      discard;
    }
    if (u_antiAlias == 0) {
      // Binary 1-bit manga pen (zero feather)
      tipAlpha = dist <= 1.0 ? 1.0 : 0.0;
    } else {
      float aaPx = u_antiAlias == 1 ? 1.3 : (u_antiAlias == 3 ? 3.8 : 2.2);
      float minDim = max(0.85, min(v_size.x, v_size.y));
      float aa = clamp(aaPx / minDim, 0.015, 0.92);
      float clampedH = clamp(u_hardness, 0.0, 1.0);
      if (clampedH <= 0.05) {
        // Silky Gaussian cosine falloff for soft airbrush
        tipAlpha = 0.5 * (1.0 + cos(min(1.0, dist) * 3.14159265));
      } else {
        float edge = min(clampedH, 1.0 - aa);
        tipAlpha = 1.0 - smoothstep(edge, 1.0, dist);
      }
    }
  }

  // 1b. Dual-Brush Texture Modulation
  if (u_hasDualTipTexture) {
    vec4 dualTex = texture2D(u_dualTipTexture, v_uv);
    float dualA = dualTex.a;
    if (u_dualBlendMode == 1) {
      tipAlpha = max(0.0, tipAlpha - (1.0 - dualA));
    } else if (u_dualBlendMode == 2) {
      tipAlpha = min(tipAlpha, dualA);
    } else if (u_dualBlendMode == 3) {
      tipAlpha = tipAlpha < 0.5 ? (2.0 * tipAlpha * dualA) : (1.0 - 2.0 * (1.0 - tipAlpha) * (1.0 - dualA));
    } else if (u_dualBlendMode == 4) {
      tipAlpha = tipAlpha + dualA - tipAlpha * dualA;
    } else {
      tipAlpha *= dualA;
    }
  }

  if (tipAlpha <= 0.002) {
    discard;
  }

  // 2. CSP 5-Mode Paper Grain / Canvas Tooth
  if (u_paperGrain > 0.001) {
    float g = samplePaperTooth(v_worldPos);
    float p = clamp(v_pressure, 0.0, 1.0);
    float heavyExcess = max(0.0, (p - 0.52) / 0.48);
    float penetration = min(0.92, p * 0.28 + heavyExcess * heavyExcess * 0.64);
    float effDensity = u_paperGrain * (1.0 - penetration * 0.85);

    if (u_paperMode == 1) {
      // Multiply
      tipAlpha *= (1.0 - effDensity * (1.0 - g));
    } else if (u_paperMode == 2) {
      // Compare: physical dry-media height-field tooth (true zero in recessed paper valleys)
      float contactHeight = g * (0.22 + 0.78 * tipAlpha);
      float cutoff = effDensity * 0.68;
      float tooth = smoothstep(cutoff - 0.05, cutoff + 0.16, contactHeight);
      tipAlpha *= tooth;
    } else if (u_paperMode == 3) {
      // Overlay
      float ov = tipAlpha < 0.5 ? (2.0 * tipAlpha * g) : (1.0 - 2.0 * (1.0 - tipAlpha) * (1.0 - g));
      tipAlpha = mix(tipAlpha, ov, effDensity);
    } else if (u_paperMode == 4) {
      // Outline
      float edgeFactor = 4.0 * tipAlpha * (1.0 - tipAlpha);
      tipAlpha *= (1.0 - effDensity * (1.0 - g) * (0.35 + 0.65 * edgeFactor));
    } else {
      // Subtract (CSP default valley-fill physics)
      float sub = (1.0 - g) * effDensity * (1.0 - penetration * 0.5);
      tipAlpha = max(0.0, tipAlpha - sub);
    }

    if (tipAlpha <= 0.002) {
      discard;
    }
  }

  // 3. Optional GPU Color Mixing fallback
  if (u_colorMixing && u_hasCanvasTexture && !u_isEraser) {
    vec2 docRes = max(vec2(1.0), u_docResolution);
    vec2 canvasUv = clamp(v_worldPos / docRes, 0.0, 1.0);
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

  // 4. Final Alpha computation
  float finalAlpha = clamp(tipAlpha * v_alpha, 0.0, 1.0);
  if (u_antiAlias == 0) {
    finalAlpha = finalAlpha >= 0.5 ? 1.0 : 0.0;
    if (finalAlpha <= 0.0) discard;
  }

  if (u_isBgEraser) {
    gl_FragColor = vec4(1.0 * finalAlpha, 1.0 * finalAlpha, 1.0 * finalAlpha, finalAlpha);
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
// -------------------------------------------------------------

const RIBBON_VERTEX_SHADER_SRC = `
precision highp float;

attribute vec2 a_pos;
attribute float a_normalDist;
attribute vec4 a_color;
attribute float a_width;

uniform vec2 u_canvasResolution;
uniform vec2 u_dirtyOffset;

varying float v_normalDist;
varying vec4 v_color;
varying float v_width;

void main() {
  v_normalDist = a_normalDist;
  v_color = a_color;
  v_width = a_width;

  vec2 clipPos = ((a_pos - u_dirtyOffset) / u_canvasResolution) * 2.0 - 1.0;
  clipPos.y = -clipPos.y;

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
  float aa = clamp(1.5 / max(1.0, v_width), 0.015, 0.45);
  float alpha = 1.0 - smoothstep(1.0 - aa, 1.0, dist);

  if (alpha <= 0.002) {
    discard;
  }

  float finalAlpha = v_color.a * alpha;
  gl_FragColor = vec4(v_color.rgb * finalAlpha, finalAlpha);
}
`;

const MAX_TILE_CHUNK = 2048;

/**
 * WebGL-accelerated GPU brush engine.
 * Executes authentic Clip Studio Paint brush mathematics on the GPU with zero per-call driver queries.
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

  // Cached Attribute Locations (Instanced Dab) — zero getAttribLocation calls during draw!
  private aQuadVertexLoc: number = -1;
  private aCenterLoc: number = -1;
  private aSizeLoc: number = -1;
  private aAngleLoc: number = -1;
  private aColorLoc: number = -1;
  private aAlphaLoc: number = -1;
  private aPressureLoc: number = -1;
  private aStrokeDistLoc: number = -1;
  private aFlipLoc: number = -1;

  // Cached Uniform Locations (Instanced Dab)
  private uCanvasResolutionLoc: WebGLUniformLocation | null = null;
  private uDocResolutionLoc: WebGLUniformLocation | null = null;
  private uDirtyOffsetLoc: WebGLUniformLocation | null = null;
  private uHasTipTextureLoc: WebGLUniformLocation | null = null;
  private uIsColorTipLoc: WebGLUniformLocation | null = null;
  private uTipTextureLoc: WebGLUniformLocation | null = null;
  private uHasDualTipTextureLoc: WebGLUniformLocation | null = null;
  private uDualTipTextureLoc: WebGLUniformLocation | null = null;
  private uDualBlendModeLoc: WebGLUniformLocation | null = null;
  private uAntiAliasLoc: WebGLUniformLocation | null = null;
  private uHardnessLoc: WebGLUniformLocation | null = null;
  private uWetEdgeLoc: WebGLUniformLocation | null = null;
  private uPaperGrainLoc: WebGLUniformLocation | null = null;
  private uGrainScaleLoc: WebGLUniformLocation | null = null;
  private uGrainRotateRadLoc: WebGLUniformLocation | null = null;
  private uPaperModeLoc: WebGLUniformLocation | null = null;
  private uPaperBrightnessLoc: WebGLUniformLocation | null = null;
  private uPaperContrastLoc: WebGLUniformLocation | null = null;
  private uPaperInvertLoc: WebGLUniformLocation | null = null;
  private uHasPaperTexLoc: WebGLUniformLocation | null = null;
  private uPaperTextureLoc: WebGLUniformLocation | null = null;
  private uPaperTexSizeLoc: WebGLUniformLocation | null = null;
  private uColorMixingLoc: WebGLUniformLocation | null = null;
  private uPerceptualMixingLoc: WebGLUniformLocation | null = null;
  private uHasCanvasTextureLoc: WebGLUniformLocation | null = null;
  private uCanvasTextureLoc: WebGLUniformLocation | null = null;
  private uAmountOfPaintLoc: WebGLUniformLocation | null = null;
  private uDensityOfPaintLoc: WebGLUniformLocation | null = null;
  private uColorStretchLoc: WebGLUniformLocation | null = null;
  private uIsEraserLoc: WebGLUniformLocation | null = null;
  private uIsBgEraserLoc: WebGLUniformLocation | null = null;

  // Cached Locations (Ribbon Mesh)
  private uRibbonCanvasResolutionLoc: WebGLUniformLocation | null = null;
  private uRibbonDirtyOffsetLoc: WebGLUniformLocation | null = null;
  private aRibbonPosLoc: number = -1;
  private aRibbonNormalDistLoc: number = -1;
  private aRibbonColorLoc: number = -1;
  private aRibbonWidthLoc: number = -1;

  // Textures cache
  private tipTexturesMap = new Map<string, WebGLTexture>();
  private builtinPaperTexture: WebGLTexture | null = null;
  private canvasLayerTexture: WebGLTexture | null = null;

  // Offscreen GPU FBO for instanced dab rendering (WebGL2 fast path)
  private dabFbo: WebGLFramebuffer | null = null;
  private dabFboTex: WebGLTexture | null = null;
  private dabFboWidth: number = 0;
  private dabFboHeight: number = 0;

  // Dab geometry & instancing buffers (stride 14 floats)
  private quadVertexBuffer: WebGLBuffer | null = null;
  private extInstanced: {
    drawArraysInstanced: (mode: number, first: number, count: number, instanceCount: number) => void;
    vertexAttribDivisor: (index: number, divisor: number) => void;
  } | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private instanceArray: Float32Array = new Float32Array(4096 * 14);

  // Ribbon geometry buffers (stride 8)
  private ribbonBuffer: WebGLBuffer | null = null;
  private ribbonArray: Float32Array = new Float32Array(1024 * 8);

  private constructor() {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = 1024;
      c.height = 1024;
      this.canvas = c;
      if (typeof c.addEventListener === 'function') {
        c.addEventListener('webglcontextlost', (ev) => {
          ev.preventDefault();
          this.isGpuAvailable = false;
          this.tipTexturesMap.clear();
          this.builtinPaperTexture = null;
          this.canvasLayerTexture = null;
          this.dabFbo = null;
          this.dabFboTex = null;
          this.dabFboWidth = 0;
          this.dabFboHeight = 0;
        });
        c.addEventListener('webglcontextrestored', () => {
          this.initGl();
        });
      }
      this.initGl();
    }
  }

  public static getInstance(): WebGlBrushEngine {
    if (!WebGlBrushEngine.instance) {
      WebGlBrushEngine.instance = new WebGlBrushEngine();
    }
    return WebGlBrushEngine.instance;
  }

  private initGl() {
    if (!this.canvas || typeof this.canvas.getContext !== 'function') {
      this.isGpuAvailable = false;
      return;
    }
    try {
      const glOpts: WebGLContextAttributes = {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
      };

      const gl2 = this.canvas.getContext('webgl2', glOpts) as WebGL2RenderingContext | null;
      const gl = (gl2 ||
        this.canvas.getContext('webgl', glOpts) ||
        this.canvas.getContext('experimental-webgl', glOpts)) as WebGLRenderingContext | null;

      if (!gl || typeof gl.createProgram !== 'function') {
        this.isGpuAvailable = false;
        return;
      }

      this.gl = gl;

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
            // Cache ALL attribute locations once at link time
            this.aQuadVertexLoc = gl.getAttribLocation(program, 'a_quadVertex');
            this.aCenterLoc = gl.getAttribLocation(program, 'a_center');
            this.aSizeLoc = gl.getAttribLocation(program, 'a_size');
            this.aAngleLoc = gl.getAttribLocation(program, 'a_angle');
            this.aColorLoc = gl.getAttribLocation(program, 'a_color');
            this.aAlphaLoc = gl.getAttribLocation(program, 'a_alpha');
            this.aPressureLoc = gl.getAttribLocation(program, 'a_pressure');
            this.aStrokeDistLoc = gl.getAttribLocation(program, 'a_strokeDist');
            this.aFlipLoc = gl.getAttribLocation(program, 'a_flip');

            // Cache ALL uniform locations once at link time
            this.uCanvasResolutionLoc = gl.getUniformLocation(program, 'u_canvasResolution');
            this.uDocResolutionLoc = gl.getUniformLocation(program, 'u_docResolution');
            this.uDirtyOffsetLoc = gl.getUniformLocation(program, 'u_dirtyOffset');
            this.uHasTipTextureLoc = gl.getUniformLocation(program, 'u_hasTipTexture');
            this.uIsColorTipLoc = gl.getUniformLocation(program, 'u_isColorTip');
            this.uTipTextureLoc = gl.getUniformLocation(program, 'u_tipTexture');
            this.uHasDualTipTextureLoc = gl.getUniformLocation(program, 'u_hasDualTipTexture');
            this.uDualTipTextureLoc = gl.getUniformLocation(program, 'u_dualTipTexture');
            this.uDualBlendModeLoc = gl.getUniformLocation(program, 'u_dualBlendMode');
            this.uAntiAliasLoc = gl.getUniformLocation(program, 'u_antiAlias');
            this.uHardnessLoc = gl.getUniformLocation(program, 'u_hardness');
            this.uWetEdgeLoc = gl.getUniformLocation(program, 'u_wetEdge');
            this.uPaperGrainLoc = gl.getUniformLocation(program, 'u_paperGrain');
            this.uGrainScaleLoc = gl.getUniformLocation(program, 'u_grainScale');
            this.uGrainRotateRadLoc = gl.getUniformLocation(program, 'u_grainRotateRad');
            this.uPaperModeLoc = gl.getUniformLocation(program, 'u_paperMode');
            this.uPaperBrightnessLoc = gl.getUniformLocation(program, 'u_paperBrightness');
            this.uPaperContrastLoc = gl.getUniformLocation(program, 'u_paperContrast');
            this.uPaperInvertLoc = gl.getUniformLocation(program, 'u_paperInvert');
            this.uHasPaperTexLoc = gl.getUniformLocation(program, 'u_hasPaperTex');
            this.uPaperTextureLoc = gl.getUniformLocation(program, 'u_paperTexture');
            this.uPaperTexSizeLoc = gl.getUniformLocation(program, 'u_paperTexSize');
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
            this.uRibbonDirtyOffsetLoc = gl.getUniformLocation(rProgram, 'u_dirtyOffset');
            this.aRibbonPosLoc = gl.getAttribLocation(rProgram, 'a_pos');
            this.aRibbonNormalDistLoc = gl.getAttribLocation(rProgram, 'a_normalDist');
            this.aRibbonColorLoc = gl.getAttribLocation(rProgram, 'a_color');
            this.aRibbonWidthLoc = gl.getAttribLocation(rProgram, 'a_width');
          }
        }
      }

      // Static quad vertex buffer
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

      this.ribbonBuffer = gl.createBuffer();

      // Hardware instanced array support
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

      // Upload seamless 512x512 cold-press paper grain texture once at startup
      this.uploadBuiltinPaperTexture(gl);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      this.isGpuAvailable = this.program !== null || this.ribbonProgram !== null;
    } catch {
      this.isGpuAvailable = false;
    }
  }

  private uploadBuiltinPaperTexture(gl: WebGLRenderingContext): void {
    try {
      const tex = gl.createTexture();
      if (!tex) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      // Expand 1-channel 512x512 paperGrainTable to LUMINANCE for WebGL1+2 universal compatibility
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.LUMINANCE,
        GRAIN_SIZE,
        GRAIN_SIZE,
        0,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        paperGrainTable
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      this.builtinPaperTexture = tex;
    } catch {
      this.builtinPaperTexture = null;
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
    if (!this.isGpuAvailable || !this.gl) return false;
    if (typeof this.gl.isContextLost === 'function' && this.gl.isContextLost()) {
      this.isGpuAvailable = false;
      return false;
    }
    return true;
  }

  private ensureDabFbo(width: number, height: number): boolean {
    const gl = this.gl;
    if (!gl || !('blitFramebuffer' in gl)) return false;
    if (this.dabFbo && this.dabFboTex && this.dabFboWidth === width && this.dabFboHeight === height) {
      return true;
    }
    if (!this.dabFbo) {
      this.dabFbo = gl.createFramebuffer();
    }
    if (!this.dabFboTex) {
      this.dabFboTex = gl.createTexture();
    }
    if (!this.dabFbo || !this.dabFboTex) return false;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.dabFboTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.dabFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.dabFboTex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (!complete) {
      this.dabFboWidth = 0;
      this.dabFboHeight = 0;
      return false;
    }
    this.dabFboWidth = width;
    this.dabFboHeight = height;
    return true;
  }

  /**
   * Retrieves or uploads a brush tip or paper texture to GPU memory.
   */
  public getOrCreateTipTexture(image: HTMLImageElement, repeatWrap: boolean = false): WebGLTexture | null {
    if (!this.gl || !image || !image.src) return null;
    if (image.complete === false || (image.naturalWidth || image.width || 0) <= 0) return null;
    const cacheKey = `${repeatWrap ? 'rep:' : 'tip:'}${image.src}`;
    const cached = this.tipTexturesMap.get(cacheKey);
    if (cached) return cached;

    const gl = this.gl;
    if (this.tipTexturesMap.size >= 64) {
      const oldestKey = this.tipTexturesMap.keys().next().value;
      if (oldestKey) {
        const oldTex = this.tipTexturesMap.get(oldestKey);
        if (oldTex) gl.deleteTexture(oldTex);
        this.tipTexturesMap.delete(oldestKey);
      }
    }
    const tex = gl.createTexture();
    if (!tex) return null;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    const wrap = repeatWrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    const texW = image.naturalWidth || image.width || 0;
    const texH = image.naturalHeight || image.height || 0;
    const isPow2 = texW > 0 && texH > 0 && (texW & (texW - 1)) === 0 && (texH & (texH - 1)) === 0;
    if (!repeatWrap && isPow2 && typeof gl.generateMipmap === 'function') {
      // Trilinear mipmapping keeps 128x128 pencil tips crisp and alias-free at 2px-10px sizes
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.tipTexturesMap.set(cacheKey, tex);
    return tex;
  }

  public uploadCanvasTexture(sourceCanvas: HTMLCanvasElement): WebGLTexture | null {
    if (!this.gl) return null;
    const gl = this.gl;

    if (!this.canvasLayerTexture) {
      this.canvasLayerTexture = gl.createTexture();
    }
    const tex = this.canvasLayerTexture;
    if (!tex) return null;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    return tex;
  }

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
    if (color.startsWith('rgb')) {
      const m = color.match(/\(([^)]+)\)/);
      if (m) {
        const parts = m[1].split(',');
        return {
          r: (parseFloat(parts[0]) || 0) / 255,
          g: (parseFloat(parts[1]) || 0) / 255,
          b: (parseFloat(parts[2]) || 0) / 255,
        };
      }
    }
    return { r: 0.1, g: 0.1, b: 0.1 };
  }

  /**
   * Track A: Ribbon Inking Engine
   */
  public renderRibbonSegment(
    targetCtx: CanvasRenderingContext2D,
    p0: Point,
    c1: Point,
    c2: Point,
    p3: Point,
    color: string,
    opacity: number = 1.0,
    _canvasWidth: number,
    _canvasHeight: number,
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

      const px = it * it * it * p0.x + 3 * it * it * t * c1.x + 3 * it * t * t * c2.x + t * t * t * p3.x;
      const py = it * it * it * p0.y + 3 * it * it * t * c1.y + 3 * it * t * t * c2.y + t * t * t * p3.y;

      const dpx = 3 * it * it * (c1.x - p0.x) + 6 * it * t * (c2.x - c1.x) + 3 * t * t * (p3.x - c2.x);
      const dpy = 3 * it * it * (c1.y - p0.y) + 6 * it * t * (c2.y - c1.y) + 3 * t * t * (p3.y - c2.y);
      const speed = Math.hypot(dpx, dpy);

      let nx = 0;
      let ny = 1;
      if (speed > 1e-4) {
        nx = -dpy / speed;
        ny = dpx / speed;
      }

      const w = Math.max(0.5, p0.width + (p3.width - p0.width) * t);
      const halfW = w * 0.5;

      const lx = px + nx * halfW;
      const ly = py + ny * halfW;
      const rx = px - nx * halfW;
      const ry = py - ny * halfW;

      minX = Math.min(minX, lx, rx);
      minY = Math.min(minY, ly, ry);
      maxX = Math.max(maxX, lx, rx);
      maxY = Math.max(maxY, ly, ry);

      arr[vIdx++] = lx;
      arr[vIdx++] = ly;
      arr[vIdx++] = -1.0;
      arr[vIdx++] = w;
      arr[vIdx++] = rgb.r;
      arr[vIdx++] = rgb.g;
      arr[vIdx++] = rgb.b;
      arr[vIdx++] = alpha;

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
    const sx = Math.floor(minX - pad);
    const sy = Math.floor(minY - pad);
    const ex = Math.ceil(maxX + pad);
    const ey = Math.ceil(maxY + pad);
    const dw = Math.min(4096, Math.max(0, ex - sx));
    const dh = Math.min(4096, Math.max(0, ey - sy));

    if (dw <= 0 || dh <= 0) return false;

    if (canvas.width < dw || canvas.height < dh) {
      canvas.width = Math.max(canvas.width, dw, 512);
      canvas.height = Math.max(canvas.height, dh, 512);
    }

    const viewY = Math.max(0, canvas.height - dh);
    gl.viewport(0, viewY, dw, dh);
    if (typeof gl.scissor === 'function') {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, viewY, dw, dh);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.ribbonProgram);
    gl.uniform2f(this.uRibbonCanvasResolutionLoc, dw, dh);
    if (this.uRibbonDirtyOffsetLoc) {
      gl.uniform2f(this.uRibbonDirtyOffsetLoc, sx, sy);
    }

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

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, vertexCount);

    if (typeof gl.scissor === 'function') {
      gl.disable(gl.SCISSOR_TEST);
    }

    gl.disableVertexAttribArray(this.aRibbonPosLoc);
    gl.disableVertexAttribArray(this.aRibbonNormalDistLoc);
    gl.disableVertexAttribArray(this.aRibbonWidthLoc);
    gl.disableVertexAttribArray(this.aRibbonColorLoc);

    targetCtx.save();
    targetCtx.globalCompositeOperation = isBgEraser ? 'source-over' : (isEraser ? 'destination-out' : 'source-over');
    targetCtx.globalAlpha = 1.0;
    targetCtx.drawImage(canvas, 0, 0, dw, dh, sx, sy, dw, dh);
    targetCtx.restore();

    return true;
  }

  /**
   * Track B: GPU Instanced CSP Stamp Engine
   * Supports unlimited document sizes (>4096px via automatic tile chunking),
   * translated offscreen bake canvases, CSP 4-level AA, 5-mode paper tooth, and Compare-Density wash!
   */
  public renderDabsToContext(
    targetCtx: CanvasRenderingContext2D,
    dabs: GpuDab[],
    settings: BrushSettings & { alphaLocked?: boolean; isBgEraser?: boolean },
    tool: ToolType,
    _canvasWidth: number,
    _canvasHeight: number,
    underlyingCanvas?: HTMLCanvasElement
  ): boolean {
    const canvas = this.canvas;
    if (!this.isAvailable() || !this.gl || !canvas || !this.program || dabs.length === 0) {
      return false;
    }

    const gl = this.gl;
    const isTransparentInk = Boolean(settings.isTransparentInk);
    const isEraser = tool === 'eraser' || isTransparentInk;
    const isBgEraser = Boolean(settings.isBgEraser) || (tool === 'eraser' && targetCtx.fillStyle === '#ffffff');
    const isAlphaLocked = Boolean(settings.alphaLocked);

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

    const fullDirtyX = Math.floor(minX);
    const fullDirtyY = Math.floor(minY);
    const fullDirtyMaxX = Math.ceil(maxX);
    const fullDirtyMaxY = Math.ceil(maxY);
    const totalW = Math.max(0, fullDirtyMaxX - fullDirtyX);
    const totalH = Math.max(0, fullDirtyMaxY - fullDirtyY);

    if (totalW <= 0 || totalH <= 0) {
      return false;
    }

    const chunkWMax = Math.min(MAX_TILE_CHUNK, totalW);
    const chunkHMax = Math.min(MAX_TILE_CHUNK, totalH);
    if (canvas.width < chunkWMax || canvas.height < chunkHMax) {
      canvas.width = Math.max(canvas.width, chunkWMax, 512);
      canvas.height = Math.max(canvas.height, chunkHMax, 512);
    }

    const useOffscreenFbo = this.ensureDabFbo(canvas.width, canvas.height);

    // Pack instance buffer once across all dabs (stride 14 floats)
    const stride = 14;
    const requiredFloats = dabs.length * stride;
    if (this.instanceArray.length < requiredFloats) {
      this.instanceArray = new Float32Array(Math.max(requiredFloats, this.instanceArray.length * 2));
    }
    const arr = this.instanceArray;
    const aaMode = settings.antiAlias ?? 2;
    const minRenderDim = aaMode === 0 ? 1.0 : 0.75;

    for (let i = 0; i < dabs.length; i++) {
      const d = dabs[i];
      const sub = computeSubpixelDabDimensions(d.width, d.height, d.alpha, minRenderDim);
      const offset = i * stride;
      arr[offset + 0] = d.x;
      arr[offset + 1] = d.y;
      arr[offset + 2] = sub.renderW;
      arr[offset + 3] = sub.renderH;
      arr[offset + 4] = d.angle;
      arr[offset + 5] = d.r;
      arr[offset + 6] = d.g;
      arr[offset + 7] = d.b;
      arr[offset + 8] = 1.0;
      arr[offset + 9] = sub.effAlpha;
      arr[offset + 10] = d.pressure;
      arr[offset + 11] = d.strokeDist;
      arr[offset + 12] = d.flipX ?? 1.0;
      arr[offset + 13] = d.flipY ?? 1.0;
    }

    if (this.instanceBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, requiredFloats), gl.DYNAMIC_DRAW);
    }

    gl.useProgram(this.program);

    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (this.uDocResolutionLoc) {
      const docW = underlyingCanvas ? underlyingCanvas.width : Math.max(1, _canvasWidth);
      const docH = underlyingCanvas ? underlyingCanvas.height : Math.max(1, _canvasHeight);
      gl.uniform2f(this.uDocResolutionLoc, docW, docH);
    }

    gl.uniform1i(this.uAntiAliasLoc, aaMode);
    gl.uniform1f(this.uHardnessLoc, settings.hardness ?? 1.0);
    gl.uniform1f(this.uWetEdgeLoc, settings.wetEdge ?? 0.0);

    const paperDensity = settings.grain ?? (settings.textureDensity ?? 0.0);
    gl.uniform1f(this.uPaperGrainLoc, paperDensity);
    gl.uniform1f(this.uGrainScaleLoc, settings.paperTextureScale ?? 1.0);
    gl.uniform1f(this.uGrainRotateRadLoc, ((settings.paperTextureRotate ?? 0) * Math.PI) / 180);
    const pMode =
      settings.paperTextureMode === 'multiply'
        ? 1
        : settings.paperTextureMode === 'compare'
        ? 2
        : settings.paperTextureMode === 'overlay'
        ? 3
        : settings.paperTextureMode === 'outline'
        ? 4
        : 0; // subtract default
    gl.uniform1i(this.uPaperModeLoc, pMode);
    gl.uniform1f(this.uPaperBrightnessLoc, (settings.paperTextureBrightness ?? 0) / 100.0);
    gl.uniform1f(this.uPaperContrastLoc, (settings.paperTextureContrast ?? 0) / 100.0);
    gl.uniform1i(this.uPaperInvertLoc, settings.paperTextureInverted ? 1 : 0);
    gl.uniform1i(this.uIsEraserLoc, isEraser ? 1 : 0);
    gl.uniform1i(this.uIsBgEraserLoc, isBgEraser ? 1 : 0);

    // Bind Paper Texture (custom paper image or built-in 512x512 cold-press grain)
    if (paperDensity > 0.001) {
      let paperTex: WebGLTexture | null = null;
      let paperW = GRAIN_SIZE;
      let paperH = GRAIN_SIZE;
      if (settings.paperTextureImage && (settings.paperTextureImage.naturalWidth || settings.paperTextureImage.width)) {
        paperTex = this.getOrCreateTipTexture(settings.paperTextureImage, true);
        paperW = settings.paperTextureImage.naturalWidth || settings.paperTextureImage.width || GRAIN_SIZE;
        paperH = settings.paperTextureImage.naturalHeight || settings.paperTextureImage.height || GRAIN_SIZE;
      } else {
        paperTex = this.builtinPaperTexture;
      }
      if (paperTex) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, paperTex);
        gl.uniform1i(this.uPaperTextureLoc, 3);
        gl.uniform1i(this.uHasPaperTexLoc, 1);
        gl.uniform2f(this.uPaperTexSizeLoc, paperW, paperH);
      } else {
        gl.uniform1i(this.uHasPaperTexLoc, 0);
      }
    } else {
      gl.uniform1i(this.uHasPaperTexLoc, 0);
    }

    // Primary Tip Texture
    let tipTex: WebGLTexture | null = null;
    if (settings.customTipImage) {
      tipTex = this.getOrCreateTipTexture(settings.customTipImage, false);
    }
    const isColorTip = Boolean(settings.isColorTip || (settings.subTips && settings.subTips[0]?.isColor));
    if (tipTex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tipTex);
      gl.uniform1i(this.uTipTextureLoc, 0);
      gl.uniform1i(this.uHasTipTextureLoc, 1);
      gl.uniform1i(this.uIsColorTipLoc, isColorTip ? 1 : 0);
    } else {
      gl.uniform1i(this.uHasTipTextureLoc, 0);
      gl.uniform1i(this.uIsColorTipLoc, 0);
    }

    // Dual-Brush Tip Texture
    let dualTipTex: WebGLTexture | null = null;
    if (settings.dualBrush && settings.dualTipImage) {
      dualTipTex = this.getOrCreateTipTexture(settings.dualTipImage, false);
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

    // Optional GPU Color Mixing
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

    // Setup vertex attributes once across tile chunks
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVertexBuffer);
    gl.enableVertexAttribArray(this.aQuadVertexLoc);
    gl.vertexAttribPointer(this.aQuadVertexLoc, 2, gl.FLOAT, false, 0, 0);

    const useInstanced = Boolean(this.extInstanced && this.instanceBuffer);
    if (useInstanced && this.extInstanced && this.instanceBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      const byteStride = stride * 4;

      gl.enableVertexAttribArray(this.aCenterLoc);
      gl.vertexAttribPointer(this.aCenterLoc, 2, gl.FLOAT, false, byteStride, 0);
      this.extInstanced.vertexAttribDivisor(this.aCenterLoc, 1);

      gl.enableVertexAttribArray(this.aSizeLoc);
      gl.vertexAttribPointer(this.aSizeLoc, 2, gl.FLOAT, false, byteStride, 2 * 4);
      this.extInstanced.vertexAttribDivisor(this.aSizeLoc, 1);

      gl.enableVertexAttribArray(this.aAngleLoc);
      gl.vertexAttribPointer(this.aAngleLoc, 1, gl.FLOAT, false, byteStride, 4 * 4);
      this.extInstanced.vertexAttribDivisor(this.aAngleLoc, 1);

      gl.enableVertexAttribArray(this.aColorLoc);
      gl.vertexAttribPointer(this.aColorLoc, 4, gl.FLOAT, false, byteStride, 5 * 4);
      this.extInstanced.vertexAttribDivisor(this.aColorLoc, 1);

      gl.enableVertexAttribArray(this.aAlphaLoc);
      gl.vertexAttribPointer(this.aAlphaLoc, 1, gl.FLOAT, false, byteStride, 9 * 4);
      this.extInstanced.vertexAttribDivisor(this.aAlphaLoc, 1);

      gl.enableVertexAttribArray(this.aPressureLoc);
      gl.vertexAttribPointer(this.aPressureLoc, 1, gl.FLOAT, false, byteStride, 10 * 4);
      this.extInstanced.vertexAttribDivisor(this.aPressureLoc, 1);

      gl.enableVertexAttribArray(this.aStrokeDistLoc);
      gl.vertexAttribPointer(this.aStrokeDistLoc, 1, gl.FLOAT, false, byteStride, 11 * 4);
      this.extInstanced.vertexAttribDivisor(this.aStrokeDistLoc, 1);

      if (this.aFlipLoc >= 0) {
        gl.enableVertexAttribArray(this.aFlipLoc);
        gl.vertexAttribPointer(this.aFlipLoc, 2, gl.FLOAT, false, byteStride, 12 * 4);
        this.extInstanced.vertexAttribDivisor(this.aFlipLoc, 1);
      }
    }

    const compositeOp: GlobalCompositeOperation = isBgEraser
      ? 'source-over'
      : isEraser
      ? 'destination-out'
      : isAlphaLocked
      ? 'source-atop'
      : 'source-over';

    targetCtx.save();
    targetCtx.globalCompositeOperation = compositeOp;
    targetCtx.globalAlpha = 1.0;
    if (aaMode === 0) {
      targetCtx.imageSmoothingEnabled = false;
    }

    // Tile across dirty bounding box in <= 2048x2048 chunks so 70MP B4 600DPI strokes NEVER clip at 4096px!
    for (let cy = fullDirtyY; cy < fullDirtyMaxY; cy += MAX_TILE_CHUNK) {
      const dh = Math.min(MAX_TILE_CHUNK, fullDirtyMaxY - cy);
      for (let cx = fullDirtyX; cx < fullDirtyMaxX; cx += MAX_TILE_CHUNK) {
        const dw = Math.min(MAX_TILE_CHUNK, fullDirtyMaxX - cx);
        const viewY = Math.max(0, canvas.height - dh);

        if (useOffscreenFbo && this.dabFbo) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.dabFbo);
        }

        gl.viewport(0, viewY, dw, dh);
        if (typeof gl.scissor === 'function') {
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(0, viewY, dw, dh);
        }
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.uniform2f(this.uCanvasResolutionLoc, dw, dh);
        if (this.uDirtyOffsetLoc) {
          gl.uniform2f(this.uDirtyOffsetLoc, cx, cy);
        }

        if (useInstanced && this.extInstanced) {
          this.extInstanced.drawArraysInstanced(gl.TRIANGLES, 0, 6, dabs.length);
        } else {
          for (let i = 0; i < dabs.length; i++) {
            const offset = i * stride;
            gl.vertexAttrib2f(this.aCenterLoc, arr[offset], arr[offset + 1]);
            gl.vertexAttrib2f(this.aSizeLoc, arr[offset + 2], arr[offset + 3]);
            gl.vertexAttrib1f(this.aAngleLoc, arr[offset + 4]);
            gl.vertexAttrib4f(this.aColorLoc, arr[offset + 5], arr[offset + 6], arr[offset + 7], 1.0);
            gl.vertexAttrib1f(this.aAlphaLoc, arr[offset + 9]);
            gl.vertexAttrib1f(this.aPressureLoc, arr[offset + 10]);
            gl.vertexAttrib1f(this.aStrokeDistLoc, arr[offset + 11]);
            if (this.aFlipLoc >= 0) {
              gl.vertexAttrib2f(this.aFlipLoc, arr[offset + 12], arr[offset + 13]);
            }
            gl.drawArrays(gl.TRIANGLES, 0, 6);
          }
        }

        if (typeof gl.scissor === 'function') {
          gl.disable(gl.SCISSOR_TEST);
        }

        if (useOffscreenFbo && this.dabFbo) {
          const gl2 = gl as WebGL2RenderingContext;
          gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, this.dabFbo);
          gl2.bindFramebuffer(gl2.DRAW_FRAMEBUFFER, null);
          gl2.blitFramebuffer(
            0,
            viewY,
            dw,
            viewY + dh,
            0,
            viewY,
            dw,
            viewY + dh,
            gl2.COLOR_BUFFER_BIT,
            gl2.NEAREST
          );
          gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
        }

        targetCtx.drawImage(canvas, 0, 0, dw, dh, cx, cy, dw, dh);
      }
    }

    targetCtx.restore();

    if (useInstanced && this.extInstanced) {
      this.extInstanced.vertexAttribDivisor(this.aCenterLoc, 0);
      this.extInstanced.vertexAttribDivisor(this.aSizeLoc, 0);
      this.extInstanced.vertexAttribDivisor(this.aAngleLoc, 0);
      this.extInstanced.vertexAttribDivisor(this.aColorLoc, 0);
      this.extInstanced.vertexAttribDivisor(this.aAlphaLoc, 0);
      this.extInstanced.vertexAttribDivisor(this.aPressureLoc, 0);
      this.extInstanced.vertexAttribDivisor(this.aStrokeDistLoc, 0);
      if (this.aFlipLoc >= 0) {
        this.extInstanced.vertexAttribDivisor(this.aFlipLoc, 0);
        gl.disableVertexAttribArray(this.aFlipLoc);
      }

      gl.disableVertexAttribArray(this.aCenterLoc);
      gl.disableVertexAttribArray(this.aSizeLoc);
      gl.disableVertexAttribArray(this.aAngleLoc);
      gl.disableVertexAttribArray(this.aColorLoc);
      gl.disableVertexAttribArray(this.aAlphaLoc);
      gl.disableVertexAttribArray(this.aPressureLoc);
      gl.disableVertexAttribArray(this.aStrokeDistLoc);
    }

    return true;
  }

  /**
   * Generates deterministic arc-length sampled sub-pixel dabs along a quadratic Bézier curve.
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
    const spacingRatio = Math.max(0.02, Math.min(1.0, settings.spacing ?? 0.08));
    const flow = settings.brushDensity ?? settings.flow ?? 0.85;
    const aspect =
      settings.customTipImage && settings.customTipImage.naturalWidth
        ? (settings.customTipImage.naturalHeight || 1) / (settings.customTipImage.naturalWidth || 1)
        : 1.0;
    const baseAngleRad = ((settings.customTipAngle ?? 0) * Math.PI) / 180;
    const angleDynamics = settings.customTipAngleDynamics ?? 'none';
    const baseThickness = settings.thickness ?? 1.0;
    const isVertThickness = Boolean(settings.thicknessVertical);

    const chord = Math.hypot(p2.x - p0.x, p2.y - p0.y);
    const avgWidth = Math.max(1, (p0.width + p2.width) / 2);
    const steps = Math.max(8, Math.min(128, Math.ceil(chord / Math.max(0.5, avgWidth * 0.1))));

    let accDist = startDist;
    let strokeDist = cumulativeStrokeDist;

    let prevX = p0.x;
    let prevY = p0.y;
    let dabSeq = 0;

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
      const curWidth = Math.max(0.25, rawWidth);

      const requiredSpacing = Math.max(0.25, curWidth * spacingRatio);

      if (accDist >= requiredSpacing) {
        dabSeq++;
        let baseAngle = baseAngleRad;
        if ((angleDynamics === 'direction' || angleDynamics === 'direction-random') && stepDist > 0.001) {
          baseAngle += Math.atan2(dy, dx);
        }
        if (angleDynamics === 'random' || angleDynamics === 'direction-random') {
          const rScale = settings.customTipRotationRandomScale ?? 1.0;
          baseAngle += (dabHashFloat(curX, curY, dabSeq, 11) - 0.5) * Math.PI * 2 * rScale;
        }

        let tx = 1;
        let ty = 0;
        let nx = 0;
        let ny = 1;
        if (stepDist > 0.001) {
          tx = dx / stepDist;
          ty = dy / stepDist;
          nx = -ty;
          ny = tx;
        }

        for (let k = 0; k < dabCount; k++) {
          const seedIdx = dabSeq * 16 + k;
          let curDabW = curWidth;
          if (sizeJitter > 0) {
            curDabW *= Math.max(0.01, 1.0 - dabHashFloat(curX, curY, seedIdx, 1) * sizeJitter);
          }
          curDabW = Math.max(0.1, curDabW);

          let curDabThickness = baseThickness;
          if (roundnessJitter > 0) {
            curDabThickness *= Math.max(0.05, 1.0 - dabHashFloat(curX, curY, seedIdx, 2) * roundnessJitter);
          }

          let curDabAngle = baseAngle;
          if (angleJitter > 0) {
            curDabAngle += (dabHashFloat(curX, curY, seedIdx, 3) - 0.5) * Math.PI * 2 * angleJitter;
          }

          let curDabX = curX;
          let curDabY = curY;
          if (scatter > 0) {
            const perpDist = (dabHashFloat(curX, curY, seedIdx, 4) * 2 - 1) * curWidth * scatter;
            let sOffX = nx * perpDist;
            let sOffY = ny * perpDist;
            if (scatterBothAxes) {
              const tangDist = (dabHashFloat(curX, curY, seedIdx, 5) * 2 - 1) * curWidth * scatter;
              sOffX += tx * tangDist;
              sOffY += ty * tangDist;
            }
            curDabX += sOffX;
            curDabY += sOffY;
          }

          let curDabAlpha = flow;
          if (flowJitter > 0) {
            curDabAlpha *= Math.max(0.005, 1.0 - dabHashFloat(curX, curY, seedIdx, 6) * flowJitter);
          }

          let dabR = rgb.r;
          let dabG = rgb.g;
          let dabB = rgb.b;
          if (colorJitterEnabled && dynamics && secondaryRgb) {
            let salt = 20;
            const cd = applyColorDynamics(rgb, secondaryRgb, dynamics, () => dabHashFloat(curX, curY, seedIdx, salt++));
            dabR = cd.r;
            dabG = cd.g;
            dabB = cd.b;
          }

          const flips = resolveTipFlipSigns(settings.flipH, settings.flipV, seedIdx, curDabX, curDabY);
          const wOut = isVertThickness ? curDabW * curDabThickness : curDabW;
          const hOut = isVertThickness ? curDabW * aspect : curDabW * aspect * curDabThickness;

          if (settings.spray?.enabled) {
            const pCount = settings.spray.density;
            const pSize = Math.max(1, settings.spray.size);
            const radius = curDabW / 2;
            for (let sp = 0; sp < pCount; sp++) {
              const u1 = dabHashFloat(curDabX, curDabY, seedIdx * 64 + sp, 31);
              const u2 = dabHashFloat(curDabX, curDabY, seedIdx * 64 + sp, 32);
              const r = radius * Math.sqrt(u1) * (1 - (settings.spray.bias || 0) * (1 - u2));
              const th = Math.PI * 2 * dabHashFloat(curDabX, curDabY, seedIdx * 64 + sp, 33);
              dabs.push({
                x: curDabX + r * Math.cos(th),
                y: curDabY + r * Math.sin(th),
                width: isVertThickness ? pSize * curDabThickness : pSize,
                height: isVertThickness ? pSize * aspect : pSize * aspect * curDabThickness,
                angle: curDabAngle,
                r: dabR,
                g: dabG,
                b: dabB,
                alpha: curDabAlpha,
                pressure: effPressure,
                strokeDist,
                flipX: flips.signX,
                flipY: flips.signY,
              });
            }
          } else {
            dabs.push({
              x: curDabX,
              y: curDabY,
              width: wOut,
              height: hOut,
              angle: curDabAngle,
              r: dabR,
              g: dabG,
              b: dabB,
              alpha: curDabAlpha,
              pressure: effPressure,
              strokeDist,
              flipX: flips.signX,
              flipY: flips.signY,
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
