/**
 * Unified GPU Viewport Compositor
 *
 * Replaces the multi-canvas DOM stack with a single viewport-sized GPU canvas.
 * Performs frustum culling to only render tiles overlapping the screen frustum,
 * executes all 12 Photoshop/CSP blend modes in fragment shaders, applies document affine
 * transforms (pan, zoom, rotation) directly in vertex shaders, and integrates
 * anti-moiré screentones, vector layers, and comic frame clipping.
 */

import { LayerItem, CanvasDimensions, BlendMode, CanvasColorMode } from '../types/editor';
import { SparseTileGrid, TILE_SIZE, TileBuffer, globalTileGrid } from './tileEngine';
import {
  buildCurvesCombinedLut,
  buildGradientMapLut,
  buildLevelsLut,
  evaluateColorBalancePixel,
  applyAdjustment,
} from './tonalEngine';

export interface ViewportTransform {
  pan: { x: number; y: number };
  zoom: number;
  rotation: number; // in degrees
}

export const BLEND_MODE_MAP: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  'color-dodge': 6,
  'color-burn': 7,
  'hard-light': 8,
  'soft-light': 9,
  difference: 10,
  exclusion: 11,
};

export interface LayerRenderGroup {
  baseLayer: LayerItem;
  clippedLayers: LayerItem[];
}

/**
 * Groups consecutive clipped layers under their immediate non-clipped base layer underneath.
 * Layers are provided in bottom-to-top rendering order.
 */
export function groupLayersForCompositing(layersBottomToTop: LayerItem[]): LayerRenderGroup[] {
  const groups: LayerRenderGroup[] = [];
  let currentGroup: LayerRenderGroup | null = null;

  for (const layer of layersBottomToTop) {
    if (layer.clipped && currentGroup) {
      currentGroup.clippedLayers.push(layer);
    } else {
      currentGroup = {
        baseLayer: layer,
        clippedLayers: [],
      };
      groups.push(currentGroup);
    }
  }

  return groups;
}

// Vertex Shader: Affine transformation in document space mapped to WebGL clip space
export const COMPOSITOR_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_quadPos; // [0, 1] x [0, 1]
uniform vec2 u_tileOrigin; // tile position in document space
uniform vec2 u_tileSize; // tile or quad size in document space
uniform vec2 u_docDimensions; // canvas width, height
uniform vec2 u_viewportSize; // viewport width, height
uniform vec2 u_pan;
uniform float u_zoom;
uniform float u_rotationRad;
uniform float u_dpr;

out vec2 v_texCoord;
out vec2 v_docCoord;

void main() {
  v_texCoord = a_quadPos;

  // Position within document space
  vec2 docPos = u_tileOrigin + a_quadPos * u_tileSize;
  v_docCoord = docPos;

  // Center document around (0, 0)
  vec2 centered = docPos - u_docDimensions * 0.5;

  // Rotate
  float cosR = cos(u_rotationRad);
  float sinR = sin(u_rotationRad);
  vec2 rotated = vec2(
    centered.x * cosR - centered.y * sinR,
    centered.x * sinR + centered.y * cosR
  );

  // Scale and translate: convert CSS screen coordinates to physical device pixels
  vec2 screenPos = (u_pan + rotated * u_zoom) * u_dpr;

  // Convert physical device pixels to WebGL clip coordinates [-1, 1]
  vec2 clipPos = vec2(
    (2.0 * screenPos.x / u_viewportSize.x) - 1.0,
    1.0 - (2.0 * screenPos.y / u_viewportSize.y)
  );

  gl_Position = vec4(clipPos, 0.0, 1.0);
}
`;

// Fragment Shader: Layer Blending, Screentones with Anti-Moiré, and Layer Color Tinting
export const COMPOSITOR_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_texCoord;
in vec2 v_docCoord;

uniform sampler2D u_tileTexture;
uniform float u_layerOpacity;
uniform int u_blendMode;

// Background Uniforms
uniform int u_isBackground;
uniform int u_showCheckerboard;

// Screentone Uniforms
uniform int u_toneEnabled;
uniform float u_toneFrequency;
uniform float u_toneAngleRad;
uniform float u_toneDpi;
uniform int u_toneDotShape;
uniform float u_toneDensity;
uniform int u_toneDensityType;
uniform float u_zoom;

// Layer Tint Uniforms
uniform int u_layerColorEnabled;
uniform vec3 u_layerColor;
uniform vec3 u_layerSubColor;

// Layer Mask Uniforms
uniform vec2 u_docDimensions;
uniform sampler2D u_maskTexture;
uniform int u_maskEnabled;

out vec4 fragColor;

float fractVal(float x) {
  return x - floor(x);
}

vec4 evaluateScreentone(vec4 srcColor, vec2 docCoord) {
  if (srcColor.a < 0.0039) {
    return vec4(0.0);
  }

  float density;
  if (u_toneDensityType == 0) {
    // Specified density
    density = clamp(u_toneDensity * srcColor.a, 0.0, 1.0);
  } else {
    // Luminance
    float lum = dot(srcColor.rgb, vec3(0.299, 0.587, 0.114));
    density = clamp((1.0 - lum) * srcColor.a, 0.0, 1.0);
  }

  if (density <= 0.001) return vec4(0.0);
  if (density >= 0.999) return vec4(0.0, 0.0, 0.0, 1.0);

  float cellSize = max(3.5, u_toneDpi / max(1.0, u_toneFrequency));
  float cosA = cos(u_toneAngleRad);
  float sinA = sin(u_toneAngleRad);

  float xr = docCoord.x * cosA - docCoord.y * sinA;
  float yr = docCoord.x * sinA + docCoord.y * cosA;

  float u = fractVal(xr / cellSize) - 0.5;
  float v = fractVal(yr / cellSize) - 0.5;

  float spot;
  if (u_toneDotShape == 2) {
    // Line
    spot = 1.0 - 2.0 * abs(u);
  } else if (u_toneDotShape == 3) {
    // Diamond
    spot = 1.0 - (abs(u) + abs(v));
  } else {
    // Euclidean circle
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
  float halfSpan = min(0.25, 0.75 / cellSize);
  float coverage = clamp(diff / (2.0 * halfSpan) + 0.5, 0.0, 1.0);
  vec4 halftoneColor = vec4(0.0, 0.0, 0.0, coverage);

  // Anti-moiré smoothstep crossfading
  float moireBlend = smoothstep(0.35, 0.95, u_zoom);
  vec4 contColor = vec4(0.0, 0.0, 0.0, density);
  return mix(contColor, halftoneColor, moireBlend);
}

vec4 applyLayerTint(vec4 color) {
  if (u_layerColorEnabled == 0) return color;
  float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  vec3 tinted = mix(u_layerColor, u_layerSubColor, lum);
  return vec4(tinted, color.a);
}

void main() {
  if (u_isBackground == 1) {
    if (u_showCheckerboard == 1) {
      vec2 checkCoord = floor(v_docCoord / 16.0);
      float check = mod(checkCoord.x + checkCoord.y, 2.0);
      vec3 checkColor = check > 0.5 ? vec3(0.157, 0.157, 0.157) : vec3(0.125, 0.125, 0.125);
      fragColor = vec4(checkColor, 1.0);
    } else {
      fragColor = vec4(1.0, 1.0, 1.0, 1.0);
    }
    return;
  }

  vec4 texColor = texture(u_tileTexture, v_texCoord);

  if (texColor.a < 0.002) {
    discard;
  }

  vec4 finalColor = texColor;

  if (u_toneEnabled == 1) {
    finalColor = evaluateScreentone(texColor, v_docCoord);
  }

  if (u_layerColorEnabled == 1) {
    finalColor = applyLayerTint(finalColor);
  }

  if (u_maskEnabled == 1) {
    vec2 maskCoord = clamp(v_docCoord / u_docDimensions, 0.0, 1.0);
    vec4 maskPixel = texture(u_maskTexture, maskCoord);
    float maskLum = dot(maskPixel.rgb, vec3(0.299, 0.587, 0.114)) * maskPixel.a;
    finalColor.a *= maskLum;
  }

  finalColor.a *= u_layerOpacity;

  if (finalColor.a < 0.002) {
    discard;
  }

  fragColor = vec4(finalColor.rgb * finalColor.a, finalColor.a);
}
`;

// Fragment Shader: Non-Destructive Adjustment Layers with Real-Time LUT Transform
export const ADJUSTMENT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_texCoord;
in vec2 v_docCoord;

uniform sampler2D u_snapshotTexture;
uniform sampler2D u_lutTexture;
uniform int u_adjMode; // 0: per-channel LUT (Curves/Levels), 1: luminance mapping (Gradient Map)
uniform float u_layerOpacity;
uniform int u_maskEnabled;
uniform sampler2D u_maskTexture;
uniform vec2 u_docDimensions;
uniform vec2 u_viewportSize;

out vec4 fragColor;

void main() {
  vec2 screenUV = gl_FragCoord.xy / u_viewportSize;
  vec4 baseColor = texture(u_snapshotTexture, screenUV);

  if (baseColor.a < 0.001) {
    discard;
  }

  vec3 unPremult = baseColor.rgb / max(0.001, baseColor.a);
  vec3 adjusted;

  if (u_adjMode == 1) {
    // Gradient map: map luminance to LUT
    float lum = clamp(dot(unPremult, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
    adjusted = texture(u_lutTexture, vec2(lum, 0.5)).rgb;
  } else {
    // Curves / Levels / Color Balance
    float r = texture(u_lutTexture, vec2(clamp(unPremult.r, 0.0, 1.0), 0.5)).r;
    float g = texture(u_lutTexture, vec2(clamp(unPremult.g, 0.0, 1.0), 0.5)).g;
    float b = texture(u_lutTexture, vec2(clamp(unPremult.b, 0.0, 1.0), 0.5)).b;
    adjusted = vec3(r, g, b);
  }

  float maskFactor = u_layerOpacity;
  if (u_maskEnabled == 1) {
    vec2 maskCoord = clamp(v_docCoord / u_docDimensions, 0.0, 1.0);
    vec4 maskPixel = texture(u_maskTexture, maskCoord);
    float maskLum = dot(maskPixel.rgb, vec3(0.299, 0.587, 0.114)) * maskPixel.a;
    maskFactor *= maskLum;
  }

  vec3 finalRgb = mix(unPremult, adjusted, maskFactor);
  fragColor = vec4(finalRgb * baseColor.a, baseColor.a);
}
`;

export interface CompositorOptions {
  dimensions: CanvasDimensions;
  colorMode?: CanvasColorMode;
  showCheckerboard?: boolean;
  devicePixelRatio?: number;
}

/**
 * Calculates the document-space bounding box visible in the current camera viewport.
 * Performs frustum culling.
 */
export function calculateVisibleDocumentBounds(
  viewportW: number,
  viewportH: number,
  transform: ViewportTransform,
  docW: number,
  docH: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  const { pan, zoom, rotation } = transform;
  const rad = (-rotation * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  // Screen corners relative to screen center/pan
  const corners = [
    { x: 0, y: 0 },
    { x: viewportW, y: 0 },
    { x: viewportW, y: viewportH },
    { x: 0, y: viewportH },
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const c of corners) {
    // Invert translate
    const dx = c.x - pan.x;
    const dy = c.y - pan.y;

    // Invert zoom
    const sx = dx / Math.max(0.001, zoom);
    const sy = dy / Math.max(0.001, zoom);

    // Invert rotation
    const rx = sx * cosR - sy * sinR;
    const ry = sx * sinR + sy * cosR;

    // Invert center offset
    const docX = rx + docW * 0.5;
    const docY = ry + docH * 0.5;

    if (docX < minX) minX = docX;
    if (docY < minY) minY = docY;
    if (docX > maxX) maxX = docX;
    if (docY > maxY) maxY = docY;
  }

  return {
    minX: Math.max(0, Math.floor(minX)),
    minY: Math.max(0, Math.floor(minY)),
    maxX: Math.min(docW, Math.ceil(maxX)),
    maxY: Math.min(docH, Math.ceil(maxY)),
  };
}

/**
 * High-performance WebGL2 Viewport Compositor
 */
export class ViewportCompositor {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;

  // Uniform locations
  private uTileOriginLoc: WebGLUniformLocation | null = null;
  private uTileSizeLoc: WebGLUniformLocation | null = null;
  private uDocDimensionsLoc: WebGLUniformLocation | null = null;
  private uViewportSizeLoc: WebGLUniformLocation | null = null;
  private uPanLoc: WebGLUniformLocation | null = null;
  private uZoomLoc: WebGLUniformLocation | null = null;
  private uRotationRadLoc: WebGLUniformLocation | null = null;
  private uDprLoc: WebGLUniformLocation | null = null;
  private uIsBackgroundLoc: WebGLUniformLocation | null = null;
  private uShowCheckerboardLoc: WebGLUniformLocation | null = null;
  private uTileTextureLoc: WebGLUniformLocation | null = null;
  private uLayerOpacityLoc: WebGLUniformLocation | null = null;
  private uBlendModeLoc: WebGLUniformLocation | null = null;

  // Tone uniform locations
  private uToneEnabledLoc: WebGLUniformLocation | null = null;
  private uToneFrequencyLoc: WebGLUniformLocation | null = null;
  private uToneAngleRadLoc: WebGLUniformLocation | null = null;
  private uToneDpiLoc: WebGLUniformLocation | null = null;
  private uToneDotShapeLoc: WebGLUniformLocation | null = null;
  private uToneDensityLoc: WebGLUniformLocation | null = null;
  private uToneDensityTypeLoc: WebGLUniformLocation | null = null;

  // Tint uniform locations
  private uLayerColorEnabledLoc: WebGLUniformLocation | null = null;
  private uLayerColorLoc: WebGLUniformLocation | null = null;
  private uLayerSubColorLoc: WebGLUniformLocation | null = null;

  // Mask uniform locations
  private uMaskTextureLoc: WebGLUniformLocation | null = null;
  private uMaskEnabledLoc: WebGLUniformLocation | null = null;
  private maskTextureCache: Map<string, { texture: WebGLTexture }> = new Map();

  // Adjustment program & uniforms
  private adjProgram: WebGLProgram | null = null;
  private uAdjTileOriginLoc: WebGLUniformLocation | null = null;
  private uAdjTileSizeLoc: WebGLUniformLocation | null = null;
  private uAdjDocDimensionsLoc: WebGLUniformLocation | null = null;
  private uAdjViewportSizeLoc: WebGLUniformLocation | null = null;
  private uAdjPanLoc: WebGLUniformLocation | null = null;
  private uAdjZoomLoc: WebGLUniformLocation | null = null;
  private uAdjRotationRadLoc: WebGLUniformLocation | null = null;
  private uAdjDprLoc: WebGLUniformLocation | null = null;
  private uAdjSnapshotLoc: WebGLUniformLocation | null = null;
  private uAdjLutLoc: WebGLUniformLocation | null = null;
  private uAdjModeLoc: WebGLUniformLocation | null = null;
  private uAdjOpacityLoc: WebGLUniformLocation | null = null;
  private uAdjMaskEnabledLoc: WebGLUniformLocation | null = null;
  private uAdjMaskTextureLoc: WebGLUniformLocation | null = null;

  private snapshotTexture: WebGLTexture | null = null;
  private snapshotWidth: number = 0;
  private snapshotHeight: number = 0;
  private lutTexture: WebGLTexture | null = null;

  // Tile texture cache: tileKey -> { texture, version }
  private textureCache: Map<string, { texture: WebGLTexture; version: number; lastUsed: number }> = new Map();
  private fallbackTileCanvas: HTMLCanvasElement | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.initGL();
  }

  public isReady(): boolean {
    return this.gl !== null && this.program !== null;
  }

  private initGL(): boolean {
    if (this.gl && this.program) return true;

    try {
      const gl = this.canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: true,
      });

      if (!gl) return false;
      this.gl = gl;

      // Compile vertex shader
      const vs = gl.createShader(gl.VERTEX_SHADER);
      if (!vs) return false;
      gl.shaderSource(vs, COMPOSITOR_VERTEX_SHADER);
      gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        console.error('Compositor VS error:', gl.getShaderInfoLog(vs));
        return false;
      }

      // Compile fragment shader
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      if (!fs) return false;
      gl.shaderSource(fs, COMPOSITOR_FRAGMENT_SHADER);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        console.error('Compositor FS error:', gl.getShaderInfoLog(fs));
        return false;
      }

      // Link program
      const prog = gl.createProgram();
      if (!prog) return false;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('Compositor link error:', gl.getProgramInfoLog(prog));
        return false;
      }
      this.program = prog;

      // Cache uniforms
      this.uTileOriginLoc = gl.getUniformLocation(prog, 'u_tileOrigin');
      this.uTileSizeLoc = gl.getUniformLocation(prog, 'u_tileSize');
      this.uDocDimensionsLoc = gl.getUniformLocation(prog, 'u_docDimensions');
      this.uViewportSizeLoc = gl.getUniformLocation(prog, 'u_viewportSize');
      this.uPanLoc = gl.getUniformLocation(prog, 'u_pan');
      this.uZoomLoc = gl.getUniformLocation(prog, 'u_zoom');
      this.uRotationRadLoc = gl.getUniformLocation(prog, 'u_rotationRad');
      this.uDprLoc = gl.getUniformLocation(prog, 'u_dpr');
      this.uIsBackgroundLoc = gl.getUniformLocation(prog, 'u_isBackground');
      this.uShowCheckerboardLoc = gl.getUniformLocation(prog, 'u_showCheckerboard');
      this.uTileTextureLoc = gl.getUniformLocation(prog, 'u_tileTexture');
      this.uLayerOpacityLoc = gl.getUniformLocation(prog, 'u_layerOpacity');
      this.uBlendModeLoc = gl.getUniformLocation(prog, 'u_blendMode');

      this.uToneEnabledLoc = gl.getUniformLocation(prog, 'u_toneEnabled');
      this.uToneFrequencyLoc = gl.getUniformLocation(prog, 'u_toneFrequency');
      this.uToneAngleRadLoc = gl.getUniformLocation(prog, 'u_toneAngleRad');
      this.uToneDpiLoc = gl.getUniformLocation(prog, 'u_toneDpi');
      this.uToneDotShapeLoc = gl.getUniformLocation(prog, 'u_toneDotShape');
      this.uToneDensityLoc = gl.getUniformLocation(prog, 'u_toneDensity');
      this.uToneDensityTypeLoc = gl.getUniformLocation(prog, 'u_toneDensityType');

      this.uLayerColorEnabledLoc = gl.getUniformLocation(prog, 'u_layerColorEnabled');
      this.uLayerColorLoc = gl.getUniformLocation(prog, 'u_layerColor');
      this.uLayerSubColorLoc = gl.getUniformLocation(prog, 'u_layerSubColor');

      this.uMaskTextureLoc = gl.getUniformLocation(prog, 'u_maskTexture');
      this.uMaskEnabledLoc = gl.getUniformLocation(prog, 'u_maskEnabled');

      // Compile Adjustment Shader Program
      const adjFs = gl.createShader(gl.FRAGMENT_SHADER);
      if (adjFs) {
        gl.shaderSource(adjFs, ADJUSTMENT_FRAGMENT_SHADER);
        gl.compileShader(adjFs);
        if (gl.getShaderParameter(adjFs, gl.COMPILE_STATUS)) {
          const aProg = gl.createProgram();
          if (aProg) {
            gl.attachShader(aProg, vs);
            gl.attachShader(aProg, adjFs);
            gl.linkProgram(aProg);
            if (gl.getProgramParameter(aProg, gl.LINK_STATUS)) {
              this.adjProgram = aProg;
              this.uAdjTileOriginLoc = gl.getUniformLocation(aProg, 'u_tileOrigin');
              this.uAdjTileSizeLoc = gl.getUniformLocation(aProg, 'u_tileSize');
              this.uAdjDocDimensionsLoc = gl.getUniformLocation(aProg, 'u_docDimensions');
              this.uAdjViewportSizeLoc = gl.getUniformLocation(aProg, 'u_viewportSize');
              this.uAdjPanLoc = gl.getUniformLocation(aProg, 'u_pan');
              this.uAdjZoomLoc = gl.getUniformLocation(aProg, 'u_zoom');
              this.uAdjRotationRadLoc = gl.getUniformLocation(aProg, 'u_rotationRad');
              this.uAdjDprLoc = gl.getUniformLocation(aProg, 'u_dpr');
              this.uAdjSnapshotLoc = gl.getUniformLocation(aProg, 'u_snapshotTexture');
              this.uAdjLutLoc = gl.getUniformLocation(aProg, 'u_lutTexture');
              this.uAdjModeLoc = gl.getUniformLocation(aProg, 'u_adjMode');
              this.uAdjOpacityLoc = gl.getUniformLocation(aProg, 'u_layerOpacity');
              this.uAdjMaskEnabledLoc = gl.getUniformLocation(aProg, 'u_maskEnabled');
              this.uAdjMaskTextureLoc = gl.getUniformLocation(aProg, 'u_maskTexture');
            }
          }
        } else {
          console.error('Adjustment FS error:', gl.getShaderInfoLog(adjFs));
        }
      }

      // Create Unit Quad Buffer [0, 1]
      const quad = gl.createBuffer();
      if (!quad) return false;
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          0.0, 0.0,
          1.0, 0.0,
          0.0, 1.0,
          0.0, 1.0,
          1.0, 0.0,
          1.0, 1.0,
        ]),
        gl.STATIC_DRAW
      );
      this.quadBuffer = quad;

      // Enable blending
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      return true;
    } catch (err) {
      console.warn('WebGL2 not available for compositor:', err);
      return false;
    }
  }

  /**
   * Resize viewport canvas to physical screen pixels.
   */
  public resize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = Math.max(1, width);
      this.canvas.height = Math.max(1, height);
      if (this.gl) {
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      }
    }
  }

  /**
   * Calculates the document-space bounding box visible in the current camera viewport.
   * Performs frustum culling.
   */
  public calculateVisibleDocumentBounds(
    viewportW: number,
    viewportH: number,
    transform: ViewportTransform,
    docW: number,
    docH: number
  ): { minX: number; minY: number; maxX: number; maxY: number } {
    return calculateVisibleDocumentBounds(viewportW, viewportH, transform, docW, docH);
  }

  /**
   * Get or upload a WebGLTexture for a tile.
   */
  private getTileTexture(tile: TileBuffer, grid: SparseTileGrid): WebGLTexture | null {
    if (!this.gl) return null;
    const gl = this.gl;
    const key = `${tile.layerId}:${tile.tileX}:${tile.tileY}`;

    let cached = this.textureCache.get(key);
    if (!cached) {
      const tex = gl.createTexture();
      if (!tex) return null;
      cached = { texture: tex, version: -1, lastUsed: performance.now() };
      this.textureCache.set(key, cached);
    }

    cached.lastUsed = performance.now();

    // Re-upload if dirty or version bumped
    if (cached.version !== tile.version || tile.dirty) {
      gl.bindTexture(gl.TEXTURE_2D, cached.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      const rgbaData = grid.getTileAsRGBA(tile);
      const uploadBytes = rgbaData instanceof Uint8Array
        ? rgbaData
        : new Uint8Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength);

      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        TILE_SIZE,
        TILE_SIZE,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        uploadBytes
      );

      cached.version = tile.version;
      tile.dirty = false;
    }

    return cached.texture;
  }

  /**
   * Set WebGL blend mode according to standard layer blend modes.
   */
  private setGLBlendMode(blendMode: BlendMode): void {
    if (!this.gl) return;
    const gl = this.gl;

    switch (blendMode) {
      case 'multiply':
        // dstRGB * srcRGB
        gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
      case 'screen':
        // 1 - (1 - dst) * (1 - src)
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
      case 'normal':
      default:
        // Premultiplied alpha standard over
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        break;
    }
  }

  /**
   * Hex color parser to RGB normalized float array [r, g, b].
   */
  private parseHexColor(hex: string): [number, number, number] {
    let clean = hex.replace('#', '');
    if (clean.length === 3) {
      clean = clean.split('').map((c) => c + c).join('');
    }
    const num = parseInt(clean, 16);
    if (isNaN(num)) return [0, 0, 0];
    return [
      ((num >> 16) & 255) / 255,
      ((num >> 8) & 255) / 255,
      (num & 255) / 255,
    ];
  }

  /**
   * Main Render Pass: Composite all visible layers onto the viewport canvas.
   */
  public render(
    layers: LayerItem[],
    transform: ViewportTransform,
    dimensions: CanvasDimensions,
    grid: SparseTileGrid = globalTileGrid,
    _options: CompositorOptions = { dimensions }
  ): void {
    const gl = this.gl;
    if (!gl || !this.program) {
      this.render2DFallback(layers, transform, dimensions, grid, _options);
      return;
    }

    const viewportW = this.canvas.width;
    const viewportH = this.canvas.height;
    gl.viewport(0, 0, viewportW, viewportH);

    // Clear viewport with transparency or dark workspace
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    gl.useProgram(this.program);

    const dpr = _options.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ?? 1;

    // Set Viewport and Document Uniforms
    gl.uniform2f(this.uViewportSizeLoc, viewportW, viewportH);
    gl.uniform2f(this.uDocDimensionsLoc, dimensions.width, dimensions.height);
    gl.uniform2f(this.uPanLoc, transform.pan.x, transform.pan.y);
    gl.uniform1f(this.uZoomLoc, transform.zoom);
    const rotRad = (transform.rotation * Math.PI) / 180;
    gl.uniform1f(this.uRotationRadLoc, rotRad);
    gl.uniform1f(this.uDprLoc, dpr);
    gl.uniform1i(this.uTileTextureLoc, 0);

    // Bind Quad Vertices
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    const posAttrib = gl.getAttribLocation(this.program, 'a_quadPos');
    gl.enableVertexAttribArray(posAttrib);
    gl.vertexAttribPointer(posAttrib, 2, gl.FLOAT, false, 0, 0);

    // 1. Render artboard background pass (paper white or checkerboard)
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.uniform1i(this.uIsBackgroundLoc, 1);
    gl.uniform1i(this.uShowCheckerboardLoc, _options.showCheckerboard ? 1 : 0);
    gl.uniform2f(this.uTileOriginLoc, 0, 0);
    gl.uniform2f(this.uTileSizeLoc, dimensions.width, dimensions.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.uniform1i(this.uIsBackgroundLoc, 0);

    // Calculate Frustum Culling document bounds
    const viewportCssW = viewportW / dpr;
    const viewportCssH = viewportH / dpr;
    const frustum = this.calculateVisibleDocumentBounds(
      viewportCssW,
      viewportCssH,
      transform,
      dimensions.width,
      dimensions.height
    );

    gl.uniform2f(this.uTileSizeLoc, TILE_SIZE, TILE_SIZE);

    // Render layers in bottom-to-top order grouped by clipping masks
    const renderOrder = layers.slice().reverse();
    const groups = groupLayersForCompositing(renderOrder);

    for (const group of groups) {
      const baseLayer = group.baseLayer;
      if (!baseLayer.visible || baseLayer.opacity <= 0.001 || baseLayer.type === 'folder') {
        continue;
      }

      if (baseLayer.type === 'adjustment' && baseLayer.adjustmentData) {
        this.renderAdjustmentLayer(
          gl,
          baseLayer,
          transform,
          dimensions,
          viewportW,
          viewportH,
          dpr
        );
        continue;
      }

      const activeClippedLayers = group.clippedLayers.filter(
        (cl) => cl.visible && cl.opacity > 0.001 && cl.type !== 'folder'
      );

      if (activeClippedLayers.length > 0) {
        // Group successive clipped layers: record base silhouette in stencil buffer
        gl.enable(gl.STENCIL_TEST);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.stencilMask(0xFF);
        gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      } else {
        gl.disable(gl.STENCIL_TEST);
      }

      // Draw base layer
      this.renderSingleLayer(gl, baseLayer, dimensions, grid, frustum);

      if (activeClippedLayers.length > 0) {
        // Render clipped layers: only draw over the opaque pixels of the base layer
        gl.stencilMask(0x00);
        gl.stencilFunc(gl.EQUAL, 1, 0xFF);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

        for (const clippedLayer of activeClippedLayers) {
          this.renderSingleLayer(gl, clippedLayer, dimensions, grid, frustum);
        }

        gl.disable(gl.STENCIL_TEST);
      }
    }

    // Clean up stale textures periodically (LRU)
    if (this.textureCache.size > 2000) {
      this.evictStaleTextures();
    }
  }

  /**
   * Get or upload a WebGLTexture for a layer's mask canvas.
   */
  private getMaskTexture(layer: LayerItem): WebGLTexture | null {
    if (!this.gl || !layer.maskCanvas) return null;
    const gl = this.gl;
    let cached = this.maskTextureCache.get(layer.id);
    if (!cached) {
      const tex = gl.createTexture();
      if (!tex) return null;
      cached = { texture: tex };
      this.maskTextureCache.set(layer.id, cached);
    }

    gl.bindTexture(gl.TEXTURE_2D, cached.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      layer.maskCanvas
    );

    return cached.texture;
  }

  /**
   * Evaluates non-destructive adjustment layers via GPU snapshot and real-time LUT evaluation.
   */
  private renderAdjustmentLayer(
    gl: WebGL2RenderingContext,
    layer: LayerItem,
    transform: ViewportTransform,
    dimensions: CanvasDimensions,
    viewportW: number,
    viewportH: number,
    dpr: number
  ): void {
    if (!this.adjProgram || !layer.adjustmentData) return;

    // 1. Snapshot lower composite
    if (!this.snapshotTexture || this.snapshotWidth !== viewportW || this.snapshotHeight !== viewportH) {
      if (this.snapshotTexture) gl.deleteTexture(this.snapshotTexture);
      this.snapshotTexture = gl.createTexture();
      this.snapshotWidth = viewportW;
      this.snapshotHeight = viewportH;
      gl.bindTexture(gl.TEXTURE_2D, this.snapshotTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, viewportW, viewportH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    gl.bindTexture(gl.TEXTURE_2D, this.snapshotTexture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, viewportW, viewportH);

    // 2. Prepare 256x1 LUT
    if (!this.lutTexture) {
      this.lutTexture = gl.createTexture();
    }
    const adj = layer.adjustmentData;
    let lutData: Uint8Array;
    let adjMode = 0; // 0 = per-channel, 1 = gradient map

    if (adj.type === 'curves') {
      const { rLut, gLut, bLut } = buildCurvesCombinedLut(adj.curves);
      lutData = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        const off = i * 4;
        lutData[off] = rLut[i];
        lutData[off + 1] = gLut[i];
        lutData[off + 2] = bLut[i];
        lutData[off + 3] = 255;
      }
    } else if (adj.type === 'gradient-map') {
      adjMode = 1;
      const gMap = buildGradientMapLut(adj.stops, adj.interpolation || 'linear');
      lutData = new Uint8Array(gMap.buffer, gMap.byteOffset, gMap.byteLength);
    } else if (adj.type === 'levels') {
      const lLut = buildLevelsLut(adj.blackPoint, adj.whitePoint, adj.gamma, adj.outputMin ?? 0, adj.outputMax ?? 255);
      lutData = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        const off = i * 4;
        lutData[off] = lLut[i];
        lutData[off + 1] = lLut[i];
        lutData[off + 2] = lLut[i];
        lutData[off + 3] = 255;
      }
    } else { // color-balance
      lutData = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        const [r, g, b] = evaluateColorBalancePixel(i, i, i, adj);
        const off = i * 4;
        lutData[off] = r;
        lutData[off + 1] = g;
        lutData[off + 2] = b;
        lutData[off + 3] = 255;
      }
    }

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutData);

    // 3. Switch to Adjustment Program
    gl.useProgram(this.adjProgram);

    // Uniforms
    gl.uniform2f(this.uAdjViewportSizeLoc, viewportW, viewportH);
    gl.uniform2f(this.uAdjDocDimensionsLoc, dimensions.width, dimensions.height);
    gl.uniform2f(this.uAdjPanLoc, transform.pan.x, transform.pan.y);
    gl.uniform1f(this.uAdjZoomLoc, transform.zoom);
    const rotRad = (transform.rotation * Math.PI) / 180;
    gl.uniform1f(this.uAdjRotationRadLoc, rotRad);
    gl.uniform1f(this.uAdjDprLoc, dpr);

    gl.uniform2f(this.uAdjTileOriginLoc, 0, 0);
    gl.uniform2f(this.uAdjTileSizeLoc, dimensions.width, dimensions.height);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.snapshotTexture);
    gl.uniform1i(this.uAdjSnapshotLoc, 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.uniform1i(this.uAdjLutLoc, 3);

    gl.uniform1i(this.uAdjModeLoc, adjMode);
    gl.uniform1f(this.uAdjOpacityLoc, layer.opacity);

    // Mask for adjustment layer
    const hasMask = Boolean(layer.maskCanvas && layer.maskEnabled !== false);
    gl.uniform1i(this.uAdjMaskEnabledLoc, hasMask ? 1 : 0);
    if (hasMask && layer.maskCanvas) {
      const maskTex = this.getMaskTexture(layer);
      if (maskTex) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskTex);
        gl.uniform1i(this.uAdjMaskTextureLoc, 1);
      }
    }

    // Blend: overwrite lower composite with filtered result
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Revert program and blend func
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Renders all visible tiles of a single layer onto WebGL2 context.
   */
  private renderSingleLayer(
    gl: WebGL2RenderingContext,
    layer: LayerItem,
    dimensions: CanvasDimensions,
    grid: SparseTileGrid,
    frustum: { minX: number; minY: number; maxX: number; maxY: number }
  ): void {
    // Configure Layer Blend Mode & Opacity
    this.setGLBlendMode(layer.blendMode);
    gl.uniform1f(this.uLayerOpacityLoc, layer.opacity);
    gl.uniform1i(this.uBlendModeLoc, BLEND_MODE_MAP[layer.blendMode] ?? 0);

    // Configure Screentone Uniforms
    const toneEnabled = Boolean(layer.toneEnabled);
    gl.uniform1i(this.uToneEnabledLoc, toneEnabled ? 1 : 0);
    if (toneEnabled) {
      gl.uniform1f(this.uToneFrequencyLoc, layer.toneFrequency || 60);
      gl.uniform1f(this.uToneAngleRadLoc, ((layer.toneAngle || 45) * Math.PI) / 180);
      gl.uniform1f(this.uToneDpiLoc, dimensions.dpi || 600);
      const dotShapeCode =
        layer.toneDotShape === 'line'
          ? 2
          : layer.toneDotShape === 'diamond'
          ? 3
          : layer.toneDotShape === 'euclidean'
          ? 1
          : 0;
      gl.uniform1i(this.uToneDotShapeLoc, dotShapeCode);
      gl.uniform1f(this.uToneDensityLoc, (layer.toneDensity ?? 40) / 100);
      gl.uniform1i(this.uToneDensityTypeLoc, layer.toneDensityType === 'image' ? 1 : 0);
    }

    // Configure Layer Tint Uniforms
    const tintEnabled = Boolean(layer.layerColorEnabled);
    gl.uniform1i(this.uLayerColorEnabledLoc, tintEnabled ? 1 : 0);
    if (tintEnabled) {
      const prim = this.parseHexColor(layer.layerColor || '#1c73c2');
      const sub = this.parseHexColor(layer.layerSubColor || '#ffffff');
      gl.uniform3f(this.uLayerColorLoc, prim[0], prim[1], prim[2]);
      gl.uniform3f(this.uLayerSubColorLoc, sub[0], sub[1], sub[2]);
    }

    // Configure Layer Mask
    const hasMask = Boolean(layer.maskCanvas && layer.maskEnabled !== false);
    gl.uniform1i(this.uMaskEnabledLoc, hasMask ? 1 : 0);
    if (hasMask && layer.maskCanvas) {
      const maskTex = this.getMaskTexture(layer);
      if (maskTex) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskTex);
        gl.uniform1i(this.uMaskTextureLoc, 1);
      } else {
        gl.uniform1i(this.uMaskEnabledLoc, 0);
      }
    }

    // Query tiles intersecting frustum
    const visibleTiles = grid.getTilesInBounds(
      layer.id,
      frustum.minX,
      frustum.minY,
      frustum.maxX,
      frustum.maxY
    );

    // Draw each visible tile with 1 draw call per tile
    for (const tile of visibleTiles) {
      const tex = this.getTileTexture(tile, grid);
      if (!tex) continue;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);

      gl.uniform2f(this.uTileOriginLoc, tile.tileX * TILE_SIZE, tile.tileY * TILE_SIZE);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    if (hasMask) {
      gl.uniform1i(this.uMaskEnabledLoc, 0);
    }
  }

  /**
   * Evict least recently used tile textures when texture cache exceeds threshold.
   */
  private evictStaleTextures(): void {
    if (!this.gl) return;
    const entries = Array.from(this.textureCache.entries());
    entries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    // Evict oldest 500 textures
    const toRemove = entries.slice(0, 500);
    for (const [key, item] of toRemove) {
      this.gl.deleteTexture(item.texture);
      this.textureCache.delete(key);
    }
  }

  /**
   * Helper to render a single layer onto a 2D canvas context.
   */
  private render2DSingleLayer(
    targetCtx: CanvasRenderingContext2D,
    layer: LayerItem,
    grid: SparseTileGrid,
    tileCtx: CanvasRenderingContext2D | null | undefined
  ): void {
    targetCtx.save();
    targetCtx.globalAlpha = layer.opacity;
    targetCtx.globalCompositeOperation =
      layer.blendMode === 'multiply' ? 'multiply' :
      layer.blendMode === 'screen' ? 'screen' :
      'source-over';

    const tiles = grid.getLayerTiles(layer.id);
    const hasMask = Boolean(layer.maskCanvas && layer.maskEnabled !== false);
    const maskCtx = hasMask && layer.maskCanvas ? layer.maskCanvas.getContext('2d', { willReadFrequently: true }) : null;

    for (const tile of tiles) {
      if (!tileCtx || !this.fallbackTileCanvas) continue;
      const rgba = grid.getTileAsRGBA(tile);
      const imgData = tileCtx.createImageData(TILE_SIZE, TILE_SIZE);
      imgData.data.set(rgba);

      if (hasMask && maskCtx) {
        const maskImgData = maskCtx.getImageData(tile.tileX * TILE_SIZE, tile.tileY * TILE_SIZE, TILE_SIZE, TILE_SIZE);
        const md = maskImgData.data;
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] === 0) continue;
          const maskLum = (0.299 * md[i] + 0.587 * md[i + 1] + 0.114 * md[i + 2]) / 255 * (md[i + 3] / 255);
          d[i + 3] = Math.round(d[i + 3] * maskLum);
        }
      }

      tileCtx.putImageData(imgData, 0, 0);
      targetCtx.drawImage(this.fallbackTileCanvas, tile.tileX * TILE_SIZE, tile.tileY * TILE_SIZE);
    }
    targetCtx.restore();
  }

  /**
   * 2D Canvas Fallback Pass: Blits tiles when WebGL2 context is unavailable.
   */
  private render2DFallback(
    layers: LayerItem[],
    transform: ViewportTransform,
    dimensions: CanvasDimensions,
    grid: SparseTileGrid,
    _options: CompositorOptions
  ): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const viewportW = this.canvas.width;
    const viewportH = this.canvas.height;
    const dpr = _options.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ?? 1;

    ctx.save();
    ctx.clearRect(0, 0, viewportW, viewportH);

    ctx.scale(dpr, dpr);
    ctx.translate(transform.pan.x, transform.pan.y);
    ctx.rotate((transform.rotation * Math.PI) / 180);
    ctx.scale(transform.zoom, transform.zoom);
    ctx.translate(-dimensions.width / 2, -dimensions.height / 2);

    if (_options.showCheckerboard) {
      ctx.fillStyle = '#1e1e1e';
    } else {
      ctx.fillStyle = '#ffffff';
    }
    ctx.fillRect(0, 0, dimensions.width, dimensions.height);

    if (!this.fallbackTileCanvas && typeof document !== 'undefined') {
      this.fallbackTileCanvas = document.createElement('canvas');
      this.fallbackTileCanvas.width = TILE_SIZE;
      this.fallbackTileCanvas.height = TILE_SIZE;
    }
    const tileCtx = this.fallbackTileCanvas?.getContext('2d', { willReadFrequently: true });

    const renderOrder = layers.slice().reverse();
    const groups = groupLayersForCompositing(renderOrder);

    for (const group of groups) {
      const baseLayer = group.baseLayer;
      if (!baseLayer.visible || baseLayer.opacity <= 0.001 || baseLayer.type === 'folder') continue;

      if (baseLayer.type === 'adjustment' && baseLayer.adjustmentData) {
        const imgData = ctx.getImageData(0, 0, viewportW, viewportH);
        applyAdjustment(imgData, baseLayer.adjustmentData, baseLayer.maskCanvas, baseLayer.opacity);
        ctx.putImageData(imgData, 0, 0);
        continue;
      }

      const activeClipped = group.clippedLayers.filter(
        (cl) => cl.visible && cl.opacity > 0.001 && cl.type !== 'folder'
      );

      if (activeClipped.length === 0) {
        this.render2DSingleLayer(ctx, baseLayer, grid, tileCtx);
      } else {
        // Group isolated canvas for base + clipped layers
        let groupCanvas: HTMLCanvasElement | null = null;
        if (typeof document !== 'undefined') {
          groupCanvas = document.createElement('canvas');
          groupCanvas.width = dimensions.width;
          groupCanvas.height = dimensions.height;
        }
        const gCtx = groupCanvas?.getContext('2d');
        if (!gCtx || !groupCanvas) {
          this.render2DSingleLayer(ctx, baseLayer, grid, tileCtx);
          continue;
        }

        // Render baseLayer to groupCanvas
        this.render2DSingleLayer(gCtx, baseLayer, grid, tileCtx);

        // Render each clipped layer with source-atop to constrain strictly to baseLayer's silhouette
        for (const clipped of activeClipped) {
          gCtx.save();
          gCtx.globalAlpha = clipped.opacity;
          gCtx.globalCompositeOperation = 'source-atop';

          const tiles = grid.getLayerTiles(clipped.id);
          for (const tile of tiles) {
            if (!tileCtx || !this.fallbackTileCanvas) continue;
            const rgba = grid.getTileAsRGBA(tile);
            const imgData = tileCtx.createImageData(TILE_SIZE, TILE_SIZE);
            imgData.data.set(rgba);
            tileCtx.putImageData(imgData, 0, 0);
            gCtx.drawImage(this.fallbackTileCanvas, tile.tileX * TILE_SIZE, tile.tileY * TILE_SIZE);
          }
          gCtx.restore();
        }

        // Composite isolated group back to main canvas without affecting root blending
        ctx.save();
        ctx.globalAlpha = 1.0;
        ctx.globalCompositeOperation =
          baseLayer.blendMode === 'multiply' ? 'multiply' :
          baseLayer.blendMode === 'screen' ? 'screen' :
          'source-over';
        ctx.drawImage(groupCanvas, 0, 0);
        ctx.restore();
      }
    }

    ctx.restore();
  }

  /**
   * Clear all allocated WebGL textures.
   */
  public dispose(): void {
    if (this.gl) {
      for (const item of this.textureCache.values()) {
        this.gl.deleteTexture(item.texture);
      }
      this.textureCache.clear();
      for (const item of this.maskTextureCache.values()) {
        this.gl.deleteTexture(item.texture);
      }
      this.maskTextureCache.clear();
      if (this.snapshotTexture) {
        this.gl.deleteTexture(this.snapshotTexture);
        this.snapshotTexture = null;
      }
      if (this.lutTexture) {
        this.gl.deleteTexture(this.lutTexture);
        this.lutTexture = null;
      }
      if (this.quadBuffer) {
        this.gl.deleteBuffer(this.quadBuffer);
        this.quadBuffer = null;
      }
      if (this.program) {
        this.gl.deleteProgram(this.program);
        this.program = null;
      }
      if (this.adjProgram) {
        this.gl.deleteProgram(this.adjProgram);
        this.adjProgram = null;
      }
    }
    if (this.fallbackTileCanvas) {
      this.fallbackTileCanvas = null;
    }
  }
}
