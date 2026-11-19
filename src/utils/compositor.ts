/**
 * Unified GPU Viewport Compositor
 *
 * Replaces the multi-canvas DOM stack with a single viewport-sized GPU canvas.
 * Performs frustum culling to only render tiles overlapping the screen frustum,
 * executes all 12 Photoshop/CSP blend modes in fragment shaders, applies document affine
 * transforms (pan, zoom, rotation) directly in vertex shaders, and integrates
 * anti-moiré screentones, vector layers, and comic frame clipping.
 */

import { LayerItem, CanvasDimensions, BlendMode, CanvasColorMode, LayerStyles, SoftProofSettings } from '../types/editor';
import { SparseTileGrid, TILE_SIZE, TileBuffer, globalTileGrid, getTileKey } from './tileEngine';
import { getCanvasCompositeOperation } from './canvasUtils';
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
  flipX?: boolean;
  flipY?: boolean;
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
  'pass-through': 12,
  'linear-burn': 13,
  'add-glow': 14,
  'color-dodge-glow': 15,
  divide: 16,
};

export interface LayerTreeNode {
  layer: LayerItem;
  children: LayerTreeNode[];
}

export function buildLayerTree(layers: LayerItem[]): LayerTreeNode[] {
  const nodeMap = new Map<string, LayerTreeNode>();
  for (const layer of layers) {
    nodeMap.set(layer.id, { layer, children: [] });
  }

  const rootNodes: LayerTreeNode[] = [];
  for (const layer of layers) {
    const node = nodeMap.get(layer.id)!;
    if (layer.parentId && nodeMap.has(layer.parentId)) {
      nodeMap.get(layer.parentId)!.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  return rootNodes;
}

export interface TreeNodeRenderGroup {
  baseNode: LayerTreeNode;
  clippedNodes: LayerTreeNode[];
}

export function groupTreeNodesForCompositing(nodesBottomToTop: LayerTreeNode[]): TreeNodeRenderGroup[] {
  const groups: TreeNodeRenderGroup[] = [];
  let currentGroup: TreeNodeRenderGroup | null = null;

  for (const node of nodesBottomToTop) {
    if (node.layer.clipped && currentGroup) {
      currentGroup.clippedNodes.push(node);
    } else {
      currentGroup = {
        baseNode: node,
        clippedNodes: [],
      };
      groups.push(currentGroup);
    }
  }

  return groups;
}

// Fullscreen blit for isolated folder compositing
export const FOLDER_BLIT_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 a_quadPos; // [0, 1] x [0, 1]
out vec2 v_uv;
void main() {
  v_uv = a_quadPos;
  gl_Position = vec4(a_quadPos.x * 2.0 - 1.0, a_quadPos.y * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FOLDER_BLIT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_blitTexture;
uniform sampler2D u_backdropTexture;
uniform int u_hasBackdrop;
uniform int u_blendMode;
uniform float u_blitOpacity;
out vec4 fragColor;

float blendChannelFolder(float b, float s, int mode) {
  if (mode == 1) return b * s; // multiply
  if (mode == 2) return b + s - b * s; // screen
  if (mode == 3) return b < 0.5 ? (2.0 * b * s) : (1.0 - 2.0 * (1.0 - b) * (1.0 - s)); // overlay
  if (mode == 4) return min(b, s); // darken
  if (mode == 5) return max(b, s); // lighten
  if (mode == 6) return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / max(0.0001, 1.0 - s))); // color-dodge
  if (mode == 7) return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / max(0.0001, s))); // color-burn
  if (mode == 8) return s < 0.5 ? (2.0 * b * s) : (1.0 - 2.0 * (1.0 - b) * (1.0 - s)); // hard-light
  if (mode == 9) { // soft-light
    float d = b <= 0.25 ? (((16.0 * b - 12.0) * b + 4.0) * b) : sqrt(max(0.0, b));
    return s <= 0.5 ? (b - (1.0 - 2.0 * s) * b * (1.0 - b)) : (b + (2.0 * s - 1.0) * (d - b));
  }
  if (mode == 10) return abs(b - s); // difference
  if (mode == 11) return b + s - 2.0 * b * s; // exclusion
  if (mode == 13) return max(0.0, b + s - 1.0); // linear-burn
  if (mode == 14) return min(1.0, b + s); // add-glow
  if (mode == 15) return s >= 1.0 ? 1.0 : min(1.0, b / max(0.0001, 1.0 - s)); // color-dodge-glow
  if (mode == 16) return s <= 0.0001 ? 1.0 : clamp(b / s, 0.0, 1.0); // divide
  return s;
}

vec3 evaluateBlendModeFolder(vec3 Cb, vec3 Cs, int mode) {
  return vec3(
    blendChannelFolder(Cb.r, Cs.r, mode),
    blendChannelFolder(Cb.g, Cs.g, mode),
    blendChannelFolder(Cb.b, Cs.b, mode)
  );
}

void main() {
  vec4 srcPremul = texture(u_blitTexture, v_uv);
  float srcA = srcPremul.a * u_blitOpacity;
  if (srcA < 0.002) {
    discard;
  }
  vec3 Cs = srcPremul.a > 0.001 ? clamp(srcPremul.rgb / srcPremul.a, 0.0, 1.0) : vec3(0.0);
  if (u_hasBackdrop == 1 && u_blendMode != 0 && u_blendMode != 12) {
    vec4 dstPremul = texture(u_backdropTexture, v_uv);
    vec3 Cb = dstPremul.a > 0.001 ? clamp(dstPremul.rgb / dstPremul.a, 0.0, 1.0) : vec3(1.0);
    vec3 blended = evaluateBlendModeFolder(Cb, Cs, u_blendMode);
    Cs = mix(Cs, blended, dstPremul.a);
  }
  fragColor = vec4(Cs * srcA, srcA);
}
`;

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
uniform vec2 u_flip;
uniform float u_dpr;

out vec2 v_texCoord;
out vec2 v_docCoord;

void main() {
  v_texCoord = a_quadPos;

  // Position within document space
  vec2 docPos = u_tileOrigin + a_quadPos * u_tileSize;
  v_docCoord = docPos;

  // Center document around (0, 0) and apply non-destructive view flip
  vec2 centered = (docPos - u_docDimensions * 0.5) * u_flip;

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
uniform sampler2D u_backdropTexture;
uniform int u_hasBackdrop;
uniform vec2 u_viewportSize;
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

// CSP Expression Color Uniforms (0: color, 1: gray, 2: monochrome)
uniform int u_expressionMode;
uniform float u_monoThreshold;
uniform int u_monoExpressBlack;
uniform int u_monoExpressWhite;

out vec4 fragColor;

float fractVal(float x) {
  return x - floor(x);
}

float blendChannel(float b, float s, int mode) {
  if (mode == 1) return b * s; // multiply
  if (mode == 2) return b + s - b * s; // screen
  if (mode == 3) return b < 0.5 ? (2.0 * b * s) : (1.0 - 2.0 * (1.0 - b) * (1.0 - s)); // overlay
  if (mode == 4) return min(b, s); // darken
  if (mode == 5) return max(b, s); // lighten
  if (mode == 6) return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / max(0.0001, 1.0 - s))); // color-dodge
  if (mode == 7) return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / max(0.0001, s))); // color-burn
  if (mode == 8) return s < 0.5 ? (2.0 * b * s) : (1.0 - 2.0 * (1.0 - b) * (1.0 - s)); // hard-light
  if (mode == 9) { // soft-light (W3C / Photoshop)
    float d = b <= 0.25 ? (((16.0 * b - 12.0) * b + 4.0) * b) : sqrt(max(0.0, b));
    return s <= 0.5 ? (b - (1.0 - 2.0 * s) * b * (1.0 - b)) : (b + (2.0 * s - 1.0) * (d - b));
  }
  if (mode == 10) return abs(b - s); // difference
  if (mode == 11) return b + s - 2.0 * b * s; // exclusion
  if (mode == 13) return max(0.0, b + s - 1.0); // linear-burn (CSP / Krita)
  if (mode == 14) return min(1.0, b + s); // add-glow (CSP / Krita)
  if (mode == 15) return s >= 1.0 ? 1.0 : min(1.0, b / max(0.0001, 1.0 - s)); // color-dodge-glow (CSP)
  if (mode == 16) return s <= 0.0001 ? 1.0 : clamp(b / s, 0.0, 1.0); // divide (CSP / Krita)
  return s;
}

vec3 evaluateBlendMode(vec3 Cb, vec3 Cs, int mode) {
  return vec3(
    blendChannel(Cb.r, Cs.r, mode),
    blendChannel(Cb.g, Cs.g, mode),
    blendChannel(Cb.b, Cs.b, mode)
  );
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

  vec4 rawTex = texture(u_tileTexture, v_texCoord);

  if (rawTex.a < 0.002) {
    discard;
  }

  vec4 texColor = vec4(clamp(rawTex.rgb / rawTex.a, 0.0, 1.0), rawTex.a);
  vec4 finalColor = texColor;

  if (u_expressionMode == 1) {
    float gLum = dot(finalColor.rgb, vec3(0.299, 0.587, 0.114));
    finalColor.rgb = vec3(gLum);
  } else if (u_expressionMode == 2) {
    float mLum = dot(finalColor.rgb, vec3(0.299, 0.587, 0.114));
    float monoHi = clamp(0.18 * sqrt(max(0.01, u_zoom)) + 0.04, 0.06, 0.25);
    float monoAlpha = u_zoom >= 0.99
      ? step(0.5, finalColor.a)
      : smoothstep(0.02, monoHi, finalColor.a);
    if (mLum < u_monoThreshold) {
      if (u_monoExpressBlack == 1) {
        finalColor = vec4(0.0, 0.0, 0.0, monoAlpha);
      } else {
        discard;
      }
    } else {
      if (u_monoExpressWhite == 1) {
        finalColor = vec4(1.0, 1.0, 1.0, monoAlpha);
      } else {
        discard;
      }
    }
  }

  if (u_toneEnabled == 1) {
    finalColor = evaluateScreentone(finalColor, v_docCoord);
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

  if (u_hasBackdrop == 1 && u_blendMode != 0 && u_blendMode != 12) {
    vec2 screenUV = clamp(gl_FragCoord.xy / max(vec2(1.0), u_viewportSize), 0.0, 1.0);
    vec4 dstPremul = texture(u_backdropTexture, screenUV);
    vec3 Cb = dstPremul.a > 0.001 ? clamp(dstPremul.rgb / dstPremul.a, 0.0, 1.0) : vec3(1.0);
    vec3 Cs = clamp(finalColor.rgb, 0.0, 1.0);
    vec3 blended = evaluateBlendMode(Cb, Cs, u_blendMode);
    finalColor.rgb = mix(Cs, blended, dstPremul.a);
  }

  fragColor = vec4(finalColor.rgb * finalColor.a, finalColor.a);
}
`;

// Instanced Vertex Shader: Batched tile rendering via TEXTURE_2D_ARRAY + drawArraysInstanced
export const COMPOSITOR_INSTANCED_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_quadPos; // [0, 1] x [0, 1]
in vec3 a_instanceData; // xy = tileOrigin in document space, z = TEXTURE_2D_ARRAY slice index
uniform vec2 u_tileSize; // tile size in document space (TILE_SIZE << lod)
uniform vec2 u_docDimensions;
uniform vec2 u_viewportSize;
uniform vec2 u_pan;
uniform float u_zoom;
uniform float u_rotationRad;
uniform vec2 u_flip;
uniform float u_dpr;

out vec2 v_texCoord;
out vec2 v_docCoord;
flat out float v_sliceIndex;

void main() {
  v_texCoord = a_quadPos;
  v_sliceIndex = a_instanceData.z;

  vec2 docPos = a_instanceData.xy + a_quadPos * u_tileSize;
  v_docCoord = docPos;

  vec2 centered = (docPos - u_docDimensions * 0.5) * u_flip;

  float cosR = cos(u_rotationRad);
  float sinR = sin(u_rotationRad);
  vec2 rotated = vec2(
    centered.x * cosR - centered.y * sinR,
    centered.x * sinR + centered.y * cosR
  );

  vec2 screenPos = (u_pan + rotated * u_zoom) * u_dpr;

  vec2 clipPos = vec2(
    (2.0 * screenPos.x / u_viewportSize.x) - 1.0,
    1.0 - (2.0 * screenPos.y / u_viewportSize.y)
  );

  gl_Position = vec4(clipPos, 0.0, 1.0);
}
`;

// Instanced Fragment Shader: Samples TEXTURE_2D_ARRAY slice for batched single-draw-call layer rendering
export const COMPOSITOR_INSTANCED_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec2 v_texCoord;
in vec2 v_docCoord;
flat in float v_sliceIndex;

uniform sampler2DArray u_tileArrayTexture;
uniform sampler2D u_backdropTexture;
uniform int u_hasBackdrop;
uniform vec2 u_viewportSize;
uniform float u_layerOpacity;
uniform int u_blendMode;

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

// CSP Expression Color Uniforms (0: color, 1: gray, 2: monochrome)
uniform int u_expressionMode;
uniform float u_monoThreshold;
uniform int u_monoExpressBlack;
uniform int u_monoExpressWhite;

out vec4 fragColor;

float fractVal(float x) {
  return x - floor(x);
}

float blendChannel(float b, float s, int mode) {
  if (mode == 1) return b * s;
  if (mode == 2) return b + s - b * s;
  if (mode == 3) return b < 0.5 ? (2.0 * b * s) : (1.0 - 2.0 * (1.0 - b) * (1.0 - s));
  if (mode == 4) return min(b, s);
  if (mode == 5) return max(b, s);
  if (mode == 6) return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / max(0.0001, 1.0 - s)));
  if (mode == 7) return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / max(0.0001, s)));
  if (mode == 8) return s < 0.5 ? (2.0 * b * s) : (1.0 - 2.0 * (1.0 - b) * (1.0 - s));
  if (mode == 9) {
    float d = b <= 0.25 ? (((16.0 * b - 12.0) * b + 4.0) * b) : sqrt(max(0.0, b));
    return s <= 0.5 ? (b - (1.0 - 2.0 * s) * b * (1.0 - b)) : (b + (2.0 * s - 1.0) * (d - b));
  }
  if (mode == 10) return abs(b - s);
  if (mode == 11) return b + s - 2.0 * b * s;
  if (mode == 13) return max(0.0, b + s - 1.0);
  if (mode == 14) return min(1.0, b + s);
  if (mode == 15) return s >= 1.0 ? 1.0 : min(1.0, b / max(0.0001, 1.0 - s));
  if (mode == 16) return s <= 0.0001 ? 1.0 : clamp(b / s, 0.0, 1.0);
  return s;
}

vec3 evaluateBlendMode(vec3 Cb, vec3 Cs, int mode) {
  return vec3(
    blendChannel(Cb.r, Cs.r, mode),
    blendChannel(Cb.g, Cs.g, mode),
    blendChannel(Cb.b, Cs.b, mode)
  );
}

vec4 evaluateScreentone(vec4 srcColor, vec2 docCoord) {
  if (srcColor.a < 0.0039) {
    return vec4(0.0);
  }

  float density;
  if (u_toneDensityType == 0) {
    density = clamp(u_toneDensity * srcColor.a, 0.0, 1.0);
  } else {
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
    spot = 1.0 - 2.0 * abs(u);
  } else if (u_toneDotShape == 3) {
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
  float halfSpan = min(0.25, 0.75 / cellSize);
  float coverage = clamp(diff / (2.0 * halfSpan) + 0.5, 0.0, 1.0);
  vec4 halftoneColor = vec4(0.0, 0.0, 0.0, coverage);

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

vec4 sampleTileStraight(vec2 uv, int slice) {
  if (u_zoom >= 2.0) {
    ivec2 coord = clamp(ivec2(floor(uv * 256.0)), ivec2(0), ivec2(255));
    return texelFetch(u_tileArrayTexture, ivec3(coord, slice), 0);
  }
  vec2 texCoord = uv * 256.0 - 0.5;
  ivec2 base = ivec2(floor(texCoord));
  vec2 f = texCoord - vec2(base);
  ivec2 c0 = clamp(base, ivec2(0), ivec2(255));
  ivec2 c1 = clamp(base + ivec2(1), ivec2(0), ivec2(255));

  vec4 t00 = texelFetch(u_tileArrayTexture, ivec3(c0.x, c0.y, slice), 0);
  vec4 t10 = texelFetch(u_tileArrayTexture, ivec3(c1.x, c0.y, slice), 0);
  vec4 t01 = texelFetch(u_tileArrayTexture, ivec3(c0.x, c1.y, slice), 0);
  vec4 t11 = texelFetch(u_tileArrayTexture, ivec3(c1.x, c1.y, slice), 0);

  vec4 pm00 = vec4(t00.rgb * t00.a, t00.a);
  vec4 pm10 = vec4(t10.rgb * t10.a, t10.a);
  vec4 pm01 = vec4(t01.rgb * t01.a, t01.a);
  vec4 pm11 = vec4(t11.rgb * t11.a, t11.a);

  vec4 pm = mix(mix(pm00, pm10, f.x), mix(pm01, pm11, f.x), f.y);
  if (pm.a < 0.002) {
    return vec4(0.0);
  }
  return vec4(clamp(pm.rgb / pm.a, 0.0, 1.0), pm.a);
}

void main() {
  int slice = int(v_sliceIndex + 0.5);
  vec4 texColor = sampleTileStraight(v_texCoord, slice);

  if (texColor.a < 0.002) {
    discard;
  }

  vec4 finalColor = texColor;

  if (u_expressionMode == 1) {
    float gLum = dot(finalColor.rgb, vec3(0.299, 0.587, 0.114));
    finalColor.rgb = vec3(gLum);
  } else if (u_expressionMode == 2) {
    float mLum = dot(finalColor.rgb, vec3(0.299, 0.587, 0.114));
    float monoAlpha = u_zoom >= 0.99 ? step(0.5, finalColor.a) : finalColor.a;
    if (mLum < u_monoThreshold) {
      if (u_monoExpressBlack == 1) {
        finalColor = vec4(0.0, 0.0, 0.0, monoAlpha);
      } else {
        discard;
      }
    } else {
      if (u_monoExpressWhite == 1) {
        finalColor = vec4(1.0, 1.0, 1.0, monoAlpha);
      } else {
        discard;
      }
    }
  }

  if (u_toneEnabled == 1) {
    finalColor = evaluateScreentone(finalColor, v_docCoord);
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

  if (u_hasBackdrop == 1 && u_blendMode != 0 && u_blendMode != 12) {
    vec2 screenUV = clamp(gl_FragCoord.xy / max(vec2(1.0), u_viewportSize), 0.0, 1.0);
    vec4 dstPremul = texture(u_backdropTexture, screenUV);
    vec3 Cb = dstPremul.a > 0.001 ? clamp(dstPremul.rgb / dstPremul.a, 0.0, 1.0) : vec3(1.0);
    vec3 Cs = clamp(finalColor.rgb, 0.0, 1.0);
    vec3 blended = evaluateBlendMode(Cb, Cs, u_blendMode);
    finalColor.rgb = mix(Cs, blended, dstPremul.a);
  }

  fragColor = vec4(finalColor.rgb * finalColor.a, finalColor.a);
}
`;

// Viewport-Space Draft Vertex Shader: Maps a viewport-sized Canvas2D draft overlay 1:1 to screen
// while reconstructing exact document coordinates for screentone & layer mask evaluation in-stack.
export const VIEWPORT_DRAFT_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_quadPos; // [0, 1] x [0, 1] (0,0 = top-left of viewport)
uniform vec2 u_docDimensions;
uniform vec2 u_viewportSize;
uniform vec2 u_pan;
uniform float u_zoom;
uniform float u_rotationRad;
uniform vec2 u_flip;
uniform float u_dpr;

out vec2 v_texCoord;
out vec2 v_docCoord;

void main() {
  v_texCoord = a_quadPos;

  vec2 clipPos = vec2(a_quadPos.x * 2.0 - 1.0, 1.0 - a_quadPos.y * 2.0);
  vec2 screenPos = a_quadPos * u_viewportSize;
  vec2 cssScreen = screenPos / max(0.0001, u_dpr);
  vec2 unscaled = (cssScreen - u_pan) / max(0.0001, u_zoom);

  float cosR = cos(u_rotationRad);
  float sinR = sin(u_rotationRad);
  vec2 unrotated = vec2(
    unscaled.x * cosR + unscaled.y * sinR,
    -unscaled.x * sinR + unscaled.y * cosR
  );

  v_docCoord = unrotated * u_flip + u_docDimensions * 0.5;
  gl_Position = vec4(clipPos, 0.0, 1.0);
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

export function hasActiveLayerStyles(styles?: LayerStyles): boolean {
  if (!styles) return false;
  const hasStroke = Boolean(styles.stroke?.enabled && styles.stroke.size > 0 && styles.stroke.opacity > 0);
  const hasShadow = Boolean(styles.dropShadow?.enabled && styles.dropShadow.opacity > 0);
  const hasGlow = Boolean(styles.outerGlow?.enabled && styles.outerGlow.opacity > 0);
  return hasStroke || hasShadow || hasGlow;
}

// Vertex Shader: Fullscreen quad for Layer Styles post-processing
export const LAYER_STYLES_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_quadPos; // [0, 1] x [0, 1]
out vec2 v_uv;

void main() {
  v_uv = a_quadPos;
  gl_Position = vec4(a_quadPos.x * 2.0 - 1.0, a_quadPos.y * 2.0 - 1.0, 0.0, 1.0);
}
`;

// Fragment Shader: Real-Time Non-Destructive Stroke, Outer Glow, and Drop Shadow
export const LAYER_STYLES_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;

uniform sampler2D u_layerTexture;
uniform vec2 u_viewportSize;
uniform float u_layerOpacity;

// Stroke Uniforms
uniform int u_strokeEnabled;
uniform float u_strokeSize; // in physical screen pixels
uniform vec4 u_strokeColor; // rgba (includes stroke opacity)
uniform int u_strokePosition; // 0: outside, 1: inside, 2: center

// Outer Glow Uniforms
uniform int u_glowEnabled;
uniform vec4 u_glowColor; // rgba (includes glow opacity)
uniform float u_glowBlur; // in physical screen pixels
uniform float u_glowSpread; // 0.0 to 1.0

// Drop Shadow Uniforms
uniform int u_shadowEnabled;
uniform vec4 u_shadowColor; // rgba (includes shadow opacity)
uniform vec2 u_shadowOffset; // in physical screen pixels (dx, dy)
uniform float u_shadowBlur; // in physical screen pixels
uniform float u_shadowSpread; // 0.0 to 1.0

out vec4 fragColor;

// 16 Poisson disk sample offsets
const vec2 POISSON_KERNEL[16] = vec2[](
  vec2(-0.326212, -0.405805),
  vec2(-0.840144, -0.073580),
  vec2(-0.695914,  0.457137),
  vec2(-0.203345,  0.620716),
  vec2( 0.962340, -0.194983),
  vec2( 0.473434, -0.480026),
  vec2( 0.519456,  0.767022),
  vec2( 0.185461, -0.893124),
  vec2( 0.507431,  0.064425),
  vec2( 0.896420,  0.412458),
  vec2(-0.321940, -0.932615),
  vec2(-0.791559, -0.597705),
  vec2(-0.504245, -0.007671),
  vec2( 0.052445,  0.375489),
  vec2( 0.284245, -0.052445),
  vec2(-0.052445, -0.284245)
);

float computeStrokeCoverage(vec2 uv, float centerAlpha, float R, int position, vec2 texel) {
  if (R <= 0.0) return 0.0;

  // Outside stroke
  if (position == 0) {
    if (centerAlpha >= 0.99) return 0.0;
    float minInsideDist = R + 1.0;
    for (int i = 0; i < 16; i++) {
      float ang = float(i) * 0.39269908;
      vec2 dir = vec2(cos(ang), sin(ang));
      for (int j = 1; j <= 4; j++) {
        float dist = R * (float(j) / 4.0);
        vec2 sUv = uv + dir * (dist * texel);
        if (texture(u_layerTexture, sUv).a > 0.5) {
          if (dist < minInsideDist) minInsideDist = dist;
          break;
        }
      }
    }
    if (minInsideDist <= R) {
      return clamp(R - minInsideDist + 1.0, 0.0, 1.0) * (1.0 - centerAlpha);
    }
    return 0.0;
  }

  // Inside stroke
  if (position == 1) {
    if (centerAlpha < 0.01) return 0.0;
    float minOutsideDist = R + 1.0;
    for (int i = 0; i < 16; i++) {
      float ang = float(i) * 0.39269908;
      vec2 dir = vec2(cos(ang), sin(ang));
      for (int j = 1; j <= 4; j++) {
        float dist = R * (float(j) / 4.0);
        vec2 sUv = uv + dir * (dist * texel);
        if (texture(u_layerTexture, sUv).a < 0.5) {
          if (dist < minOutsideDist) minOutsideDist = dist;
          break;
        }
      }
    }
    if (minOutsideDist <= R) {
      return clamp(R - minOutsideDist + 1.0, 0.0, 1.0) * centerAlpha;
    }
    return 0.0;
  }

  // Center stroke (half outside, half inside)
  float halfR = max(0.5, R * 0.5);
  if (centerAlpha < 0.5) {
    float minInsideDist = halfR + 1.0;
    for (int i = 0; i < 16; i++) {
      float ang = float(i) * 0.39269908;
      vec2 dir = vec2(cos(ang), sin(ang));
      for (int j = 1; j <= 4; j++) {
        float dist = halfR * (float(j) / 4.0);
        vec2 sUv = uv + dir * (dist * texel);
        if (texture(u_layerTexture, sUv).a >= 0.5) {
          if (dist < minInsideDist) minInsideDist = dist;
          break;
        }
      }
    }
    if (minInsideDist <= halfR) {
      return clamp(halfR - minInsideDist + 1.0, 0.0, 1.0);
    }
    return 0.0;
  } else {
    float minOutsideDist = halfR + 1.0;
    for (int i = 0; i < 16; i++) {
      float ang = float(i) * 0.39269908;
      vec2 dir = vec2(cos(ang), sin(ang));
      for (int j = 1; j <= 4; j++) {
        float dist = halfR * (float(j) / 4.0);
        vec2 sUv = uv + dir * (dist * texel);
        if (texture(u_layerTexture, sUv).a < 0.5) {
          if (dist < minOutsideDist) minOutsideDist = dist;
          break;
        }
      }
    }
    if (minOutsideDist <= halfR) {
      return clamp(halfR - minOutsideDist + 1.0, 0.0, 1.0);
    }
    return 0.0;
  }
}

void main() {
  vec2 texel = 1.0 / u_viewportSize;
  vec4 centerSample = texture(u_layerTexture, v_uv);
  float centerAlpha = centerSample.a;

  // 1. Drop Shadow Pass
  float shadowAlpha = 0.0;
  if (u_shadowEnabled == 1) {
    vec2 shadowUV = v_uv - u_shadowOffset * texel;
    if (u_shadowBlur <= 0.5) {
      shadowAlpha = texture(u_layerTexture, shadowUV).a;
    } else {
      float rad = max(1.0, u_shadowBlur);
      float accum = 0.0;
      for (int k = 0; k < 16; k++) {
        vec2 sUv = shadowUV + POISSON_KERNEL[k] * (rad * texel);
        accum += texture(u_layerTexture, sUv).a;
      }
      accum /= 16.0;
      float spreadFactor = max(0.01, 1.0 - u_shadowSpread * 0.95);
      shadowAlpha = clamp(accum / spreadFactor, 0.0, 1.0);
    }
    shadowAlpha *= u_shadowColor.a;
  }

  // 2. Outer Glow Pass
  float glowAlpha = 0.0;
  if (u_glowEnabled == 1 && centerAlpha < 0.99) {
    float rad = max(1.0, u_glowBlur);
    float accum = 0.0;
    for (int k = 0; k < 16; k++) {
      vec2 sUv = v_uv + POISSON_KERNEL[k] * (rad * texel);
      accum += texture(u_layerTexture, sUv).a;
    }
    accum /= 16.0;
    float spreadFactor = max(0.01, 1.0 - u_glowSpread * 0.95);
    float glowVal = clamp(accum / spreadFactor, 0.0, 1.0);
    glowAlpha = glowVal * (1.0 - centerAlpha) * u_glowColor.a;
  }

  // 3. Stroke Pass
  float strokeCov = 0.0;
  if (u_strokeEnabled == 1) {
    strokeCov = computeStrokeCoverage(v_uv, centerAlpha, u_strokeSize, u_strokePosition, texel);
  }

  // Composite layers in standard Photoshop order: Drop Shadow -> Outer Glow -> Outside Stroke -> Layer Body -> Inside Stroke
  vec4 composite = vec4(0.0);

  // Drop Shadow
  if (u_shadowEnabled == 1 && shadowAlpha > 0.001) {
    composite = vec4(u_shadowColor.rgb * shadowAlpha, shadowAlpha);
  }

  // Outer Glow
  if (u_glowEnabled == 1 && glowAlpha > 0.001) {
    vec4 glow = vec4(u_glowColor.rgb * glowAlpha, glowAlpha);
    composite = glow + composite * (1.0 - glow.a);
  }

  // Outside / Outer Center Stroke
  bool isOutsideOrCenter = (u_strokePosition == 0 || (u_strokePosition == 2 && centerAlpha < 0.5));
  if (u_strokeEnabled == 1 && isOutsideOrCenter && strokeCov > 0.001) {
    float sA = strokeCov * u_strokeColor.a;
    vec4 strk = vec4(u_strokeColor.rgb * sA, sA);
    composite = strk + composite * (1.0 - strk.a);
  }

  // Layer Content
  if (centerSample.a > 0.001) {
    composite = centerSample + composite * (1.0 - centerSample.a);
  }

  // Inside / Inner Center Stroke
  bool isInsideOrCenter = (u_strokePosition == 1 || (u_strokePosition == 2 && centerAlpha >= 0.5));
  if (u_strokeEnabled == 1 && isInsideOrCenter && strokeCov > 0.001) {
    float sA = strokeCov * u_strokeColor.a;
    vec4 strk = vec4(u_strokeColor.rgb * sA, sA);
    composite = strk + composite * (1.0 - strk.a);
  }

  // Overall Layer Opacity
  composite *= u_layerOpacity;

  if (composite.a < 0.002) {
    discard;
  }

  fragColor = composite;
}
`;

// Soft Proofing and Gamut Warning Post-Processing Shaders
export const SOFT_PROOF_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 a_quadPos; // [0, 1] x [0, 1]
out vec2 v_uv;
void main() {
  v_uv = a_quadPos;
  gl_Position = vec4(a_quadPos.x * 2.0 - 1.0, a_quadPos.y * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const SOFT_PROOF_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_sceneTexture;
uniform int u_standard; // 0: japan-color-2001, 1: us-web-coated-swop, 2: iso-coated-v2
uniform int u_proofEnabled; // 1 or 0
uniform int u_gamutWarning; // 1 or 0
uniform vec3 u_gamutWarningColor;

out vec4 fragColor;

// sRGB to Linear RGB
vec3 srgbToLinear(vec3 c) {
  return mix(
    c / 12.92,
    pow((c + 0.055) / 1.055, vec3(2.4)),
    step(vec3(0.04045), c)
  );
}

// Linear RGB to sRGB
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(
    c * 12.92,
    1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), c)
  );
}

// Linear sRGB to CIE XYZ (D65)
vec3 linearToXyz(vec3 rgb) {
  return vec3(
    dot(rgb, vec3(0.4124564, 0.3575761, 0.1804375)),
    dot(rgb, vec3(0.2126729, 0.7151522, 0.0721750)),
    dot(rgb, vec3(0.0193339, 0.1191920, 0.9503041))
  );
}

// CIE XYZ (D65) to CIE Lab
float fLab(float t) {
  const float delta = 6.0 / 29.0;
  const float delta3 = delta * delta * delta;
  return (t > delta3) ? pow(t, 1.0 / 3.0) : (t / (3.0 * delta * delta) + 4.0 / 29.0);
}

vec3 xyzToLab(vec3 xyz) {
  vec3 white = vec3(0.95047, 1.0, 1.08883);
  vec3 v = xyz / white;
  float fx = fLab(v.x);
  float fy = fLab(v.y);
  float fz = fLab(v.z);
  return vec3(
    116.0 * fy - 16.0,
    500.0 * (fx - fy),
    200.0 * (fy - fz)
  );
}

vec3 srgbToLab(vec3 srgb) {
  vec3 lin = srgbToLinear(clamp(srgb, 0.0, 1.0));
  vec3 xyz = linearToXyz(lin);
  return xyzToLab(xyz);
}

// CMYK soft-proofing simulation polynomial
vec3 simulateCmyk(vec3 srgb, int standard) {
  vec3 linRgb = srgbToLinear(clamp(srgb, 0.0, 1.0));
  float c0 = 1.0 - linRgb.r;
  float m0 = 1.0 - linRgb.g;
  float y0 = 1.0 - linRgb.b;

  // Standard 0: Japan Color 2001 (high saturation, clean cyans, TAC ~350%)
  // Standard 1: US Web Coated (SWOP) (warm stock, heavy black, lower gamut, TAC ~300%)
  // Standard 2: ISO Coated v2 (FOGRA39) (balanced European inks, TAC ~330%)
  float tacLimit = 3.5;
  float tvi = 0.14;
  float gcrExp = 1.4;
  float ucrFactor = 0.80;

  vec3 densC = vec3(1.42, 0.17, 0.07);
  vec3 densM = vec3(0.06, 1.35, 0.15);
  vec3 densY = vec3(0.02, 0.04, 1.25);
  vec3 densK = vec3(1.80, 1.80, 1.78);
  vec3 paperReflect = vec3(0.96, 0.96, 0.97);

  if (standard == 1) {
    tacLimit = 3.0;
    tvi = 0.20;
    gcrExp = 1.15;
    ucrFactor = 0.90;
    densC = vec3(1.28, 0.24, 0.14);
    densM = vec3(0.08, 1.22, 0.22);
    densY = vec3(0.03, 0.07, 1.15);
    densK = vec3(1.65, 1.65, 1.62);
    paperReflect = vec3(0.94, 0.93, 0.88);
  } else if (standard == 2) {
    tacLimit = 3.3;
    tvi = 0.16;
    gcrExp = 1.3;
    ucrFactor = 0.85;
    densC = vec3(1.36, 0.19, 0.09);
    densM = vec3(0.07, 1.30, 0.17);
    densY = vec3(0.02, 0.05, 1.20);
    densK = vec3(1.72, 1.72, 1.70);
    paperReflect = vec3(0.95, 0.95, 0.94);
  }

  // Black generation (GCR)
  float k0 = min(c0, min(m0, y0));
  float k = pow(k0, gcrExp);

  // Under Color Removal
  float denom = max(0.001, 1.0 - k * 0.35);
  float c1 = clamp((c0 - k * ucrFactor) / denom, 0.0, 1.0);
  float m1 = clamp((m0 - k * ucrFactor) / denom, 0.0, 1.0);
  float y1 = clamp((y0 - k * ucrFactor) / denom, 0.0, 1.0);

  // Apply TAC limit
  float totalInk = c1 + m1 + y1 + k;
  if (totalInk > tacLimit) {
    float scale = (tacLimit - k) / max(0.001, totalInk - k);
    c1 *= scale;
    m1 *= scale;
    y1 *= scale;
  }

  // Tone Value Increase (dot gain)
  c1 += 4.0 * tvi * c1 * (1.0 - c1);
  m1 += 4.0 * tvi * m1 * (1.0 - m1);
  y1 += 4.0 * tvi * y1 * (1.0 - y1);
  k  += 4.0 * tvi * k  * (1.0 - k);

  c1 = clamp(c1, 0.0, 1.0);
  m1 = clamp(m1, 0.0, 1.0);
  y1 = clamp(y1, 0.0, 1.0);
  k  = clamp(k, 0.0, 1.0);

  // Inter-ink trapping
  float cmTrap = c1 * m1 * 0.12;
  float cyTrap = c1 * y1 * 0.10;
  float myTrap = m1 * y1 * 0.10;

  vec3 totalDensity = c1 * densC + m1 * densM + y1 * densY + k * densK
                    - cmTrap * (densC + densM) * 0.2
                    - cyTrap * (densC + densY) * 0.2
                    - myTrap * (densM + densY) * 0.2;

  // Subtractive reflectance with paper tint and gloss minimum clamp
  vec3 reflectance = paperReflect * exp(-totalDensity * 2.302585);
  reflectance += vec3(0.012);

  return linearToSrgb(reflectance);
}

void main() {
  vec4 sceneColor = texture(u_sceneTexture, v_uv);

  if (sceneColor.a < 0.002) {
    fragColor = sceneColor;
    return;
  }

  // Unpremultiply alpha for true color evaluation
  vec3 rgb = sceneColor.rgb / sceneColor.a;

  // Soft proof simulation
  vec3 proofRgb = simulateCmyk(rgb, u_standard);

  // Gamut evaluation in CIE Lab space
  vec3 labOrig = srgbToLab(rgb);
  vec3 labProof = srgbToLab(proofRgb);

  // Delta-E (CIE76): normalized scale where 100 Lab units = 1.0 (deltaE = norm / 100.0)
  vec3 dLab = labOrig - labProof;
  float deltaE = length(dLab) / 100.0;

  bool isOutOfGamut = (deltaE > 0.05);

  vec3 outRgb = rgb;
  if (u_proofEnabled == 1) {
    outRgb = proofRgb;
  }

  if (u_gamutWarning == 1 && isOutOfGamut) {
    outRgb = u_gamutWarningColor;
  }

  fragColor = vec4(outRgb * sceneColor.a, sceneColor.a);
}
`;

export interface OnionSkinCompositorFrame {
  layerId: string;
  tint: string;
  opacity: number;
}

export interface CompositorOptions {
  dimensions: CanvasDimensions;
  colorMode?: CanvasColorMode;
  showCheckerboard?: boolean;
  devicePixelRatio?: number;
  onionSkinFrames?: OnionSkinCompositorFrame[];
  softProof?: SoftProofSettings;
  // Active layer identifier for Baked Layer Stack Cache partitioning (below / active / above)
  activeLayerId?: string | null;
  // WYSIWYG In-Stack Live Stroke Compositing
  activeDraftCanvas?: HTMLCanvasElement | null;
  activeDraftLayerId?: string | null;
  activeDraftDirtyRect?: { x: number; y: number; width: number; height: number } | null;
  activeDraftVersion?: number;
  activeDraftSpace?: 'document' | 'viewport';
  activeDraftOpacity?: number;
  activeDraftMonochrome?: boolean;
}

// ============================================================================
// Baked Layer Stack Cache Partitioning & Invalidation Engine
// ============================================================================

export interface CompositingUnit {
  /** Base node and its clipped siblings at this compositing level */
  group: TreeNodeRenderGroup;
  /** Accumulated opacity from enclosing pass-through folders */
  inheritedOpacity: number;
  /** All layer IDs contained in this unit (base, clipped siblings, and folder descendants) */
  containedLayerIds: Set<string>;
}

export type AboveSliceStrategy = 'empty' | 'baked-normal' | 'baked-single-blend' | 'mixed';

export interface LayerStackPartition {
  /** Units strictly below the active unit (always safe to bake into belowActiveCacheFbo) */
  belowUnits: CompositingUnit[];
  /** The active unit containing activeLayerId, or null if none/hidden */
  activeUnit: CompositingUnit | null;
  /** Units above active that must render dynamically (non-associative blend modes / adjustments) */
  aboveDynamicUnits: CompositingUnit[];
  /** Units above activeDynamicUnits that can be baked into aboveActiveCacheFbo */
  aboveCachedUnits: CompositingUnit[];
  /** How aboveActiveCacheFbo should be composited over (below + active + aboveDynamic) */
  aboveStrategy: AboveSliceStrategy;
  /** Blend mode for aboveActiveCacheFbo when aboveStrategy === 'baked-single-blend' */
  aboveCacheBlendMode: BlendMode;
}

export interface LayerStackCacheInput {
  layers: LayerItem[];
  activeLayerId?: string | null;
  viewportW: number;
  viewportH: number;
  dpr: number;
  dimensions: CanvasDimensions;
  transform: ViewportTransform;
  showCheckerboard?: boolean;
  onionSkinFrames?: OnionSkinCompositorFrame[];
  getLayerContentVersion: (layerId: string) => number;
  getMaskInvalidationEpoch?: (layerId: string) => number;
  gridEpoch?: number;
  gridId?: number;
}

export interface LayerStackCacheEvaluation {
  partition: LayerStackPartition;
  belowSignature: string;
  aboveSignature: string;
  belowDirty: boolean;
  aboveDirty: boolean;
}

function collectNodeLayerIds(node: LayerTreeNode, out: Set<string>): void {
  out.add(node.layer.id);
  for (const child of node.children) {
    collectNodeLayerIds(child, out);
  }
}

/**
 * Flattens pass-through folders into a bottom-to-top sequence of atomic compositing units
 * while keeping isolated folders and clipping-mask groups atomic.
 */
export function flattenLayerTreeToUnits(
  nodes: LayerTreeNode[],
  inheritedOpacity: number = 1.0
): CompositingUnit[] {
  const units: CompositingUnit[] = [];
  const siblingsBottomToTop = nodes.slice().reverse();
  const groups = groupTreeNodesForCompositing(siblingsBottomToTop);

  for (const group of groups) {
    const baseLayer = group.baseNode.layer;
    if (!baseLayer.visible || baseLayer.opacity <= 0.001) {
      continue;
    }

    if (baseLayer.type === 'folder' && baseLayer.blendMode === 'pass-through') {
      const nested = flattenLayerTreeToUnits(
        group.baseNode.children,
        inheritedOpacity * baseLayer.opacity
      );
      for (const u of nested) {
        units.push(u);
      }
      continue;
    }

    const containedLayerIds = new Set<string>();
    collectNodeLayerIds(group.baseNode, containedLayerIds);
    for (const cn of group.clippedNodes) {
      collectNodeLayerIds(cn, containedLayerIds);
    }

    units.push({
      group,
      inheritedOpacity,
      containedLayerIds,
    });
  }

  return units;
}

/**
 * Returns true if a compositing unit is strictly Porter-Duff source-over associative
 * with respect to the backdrop below it (safe to pre-bake onto transparent FBO and composite with 'normal').
 */
export function isUnitNormalAssociative(unit: CompositingUnit): boolean {
  const baseLayer = unit.group.baseNode.layer;
  if (baseLayer.type === 'adjustment') {
    return false;
  }
  if (baseLayer.type === 'folder') {
    // Pass-through folders were flattened; an isolated folder isolates its children's blend modes,
    // so it is normal-associative iff the folder's own blend mode is normal.
    return baseLayer.blendMode === 'normal';
  }
  if (baseLayer.blendMode !== 'normal' && baseLayer.blendMode !== 'pass-through') {
    return false;
  }
  for (const cn of unit.group.clippedNodes) {
    const cl = cn.layer;
    if (!cl.visible || cl.opacity <= 0.001 || cl.type === 'folder') continue;
    if (cl.blendMode !== 'normal' && cl.blendMode !== 'pass-through') {
      return false;
    }
  }
  return true;
}

/**
 * Returns the blend mode if a single non-associative unit can be baked onto transparent
 * with 'normal' and composited over (below + active) using a single ping-pong blend pass.
 */
export function canSingleUnitBakeWithBlendMode(unit: CompositingUnit): BlendMode | null {
  const baseLayer = unit.group.baseNode.layer;
  if (baseLayer.type === 'adjustment') {
    return null;
  }
  if (baseLayer.type === 'folder') {
    if (baseLayer.blendMode !== 'normal' && baseLayer.blendMode !== 'pass-through') {
      return baseLayer.blendMode;
    }
    return null;
  }
  const visibleClipped = unit.group.clippedNodes.filter(
    (cn) => cn.layer.visible && cn.layer.opacity > 0.001 && cn.layer.type !== 'folder'
  );
  if (
    visibleClipped.length === 0 &&
    baseLayer.blendMode !== 'normal' &&
    baseLayer.blendMode !== 'pass-through'
  ) {
    return baseLayer.blendMode;
  }
  return null;
}

/**
 * Partitions the visible layer stack into `below`, `active`, and `above` slices relative to `activeLayerId`.
 */
export function partitionLayerStack(
  layers: LayerItem[],
  activeLayerId?: string | null
): LayerStackPartition {
  const tree = buildLayerTree(layers);
  const units = flattenLayerTreeToUnits(tree, 1.0);

  let activeIdx = -1;
  if (activeLayerId) {
    for (let i = 0; i < units.length; i++) {
      if (units[i].containedLayerIds.has(activeLayerId)) {
        activeIdx = i;
        break;
      }
    }
  }

  if (activeIdx === -1) {
    return {
      belowUnits: units,
      activeUnit: null,
      aboveDynamicUnits: [],
      aboveCachedUnits: [],
      aboveStrategy: 'empty',
      aboveCacheBlendMode: 'normal',
    };
  }

  const belowUnits = units.slice(0, activeIdx);
  const activeUnit = units[activeIdx];
  const aboveAll = units.slice(activeIdx + 1);

  if (aboveAll.length === 0) {
    return {
      belowUnits,
      activeUnit,
      aboveDynamicUnits: [],
      aboveCachedUnits: [],
      aboveStrategy: 'empty',
      aboveCacheBlendMode: 'normal',
    };
  }

  let lastNonAssocIdx = -1;
  for (let i = 0; i < aboveAll.length; i++) {
    if (!isUnitNormalAssociative(aboveAll[i])) {
      lastNonAssocIdx = i;
    }
  }

  if (lastNonAssocIdx === -1) {
    return {
      belowUnits,
      activeUnit,
      aboveDynamicUnits: [],
      aboveCachedUnits: aboveAll,
      aboveStrategy: 'baked-normal',
      aboveCacheBlendMode: 'normal',
    };
  }

  if (aboveAll.length === 1) {
    const singleBlend = canSingleUnitBakeWithBlendMode(aboveAll[0]);
    if (singleBlend) {
      return {
        belowUnits,
        activeUnit,
        aboveDynamicUnits: [],
        aboveCachedUnits: aboveAll,
        aboveStrategy: 'baked-single-blend',
        aboveCacheBlendMode: singleBlend,
      };
    }
  }

  return {
    belowUnits,
    activeUnit,
    aboveDynamicUnits: aboveAll.slice(0, lastNonAssocIdx + 1),
    aboveCachedUnits: aboveAll.slice(lastNonAssocIdx + 1),
    aboveStrategy: 'mixed',
    aboveCacheBlendMode: 'normal',
  };
}

function serializeLayerNodeSignature(
  node: LayerTreeNode,
  inheritedOpacity: number,
  getLayerContentVersion: (layerId: string) => number,
  getMaskInvalidationEpoch?: (layerId: string) => number
): string {
  const l = node.layer;
  const contentVer = getLayerContentVersion(l.id);
  const maskEpoch = getMaskInvalidationEpoch ? getMaskInvalidationEpoch(l.id) : 0;
  const stylesSig = hasActiveLayerStyles(l.styles) ? JSON.stringify(l.styles) : '';
  const adjSig = l.type === 'adjustment' && l.adjustmentData ? JSON.stringify(l.adjustmentData) : '';
  const toneSig = l.toneEnabled
    ? `1:${l.toneFrequency ?? 60}:${l.toneAngle ?? 45}:${l.toneDotShape ?? ''}:${l.toneDensity ?? 40}:${l.toneDensityType ?? ''}`
    : '0';
  const tintSig = l.layerColorEnabled
    ? `1:${l.layerColor ?? ''}:${l.layerSubColor ?? ''}`
    : '0';
  const maskSig = l.maskCanvas && l.maskEnabled !== false
    ? `1:${l.maskVersion ?? 0}:${maskEpoch}:${l.maskCanvas.width}x${l.maskCanvas.height}`
    : '0';
  const exprSig = `${l.expressionColor ?? 'color'}:${l.monoThreshold ?? 128}:${l.monoExpressBlack !== false ? 1 : 0}:${l.monoExpressWhite !== false ? 1 : 0}`;

  let sig = `${l.id}|${l.type}|${l.visible ? 1 : 0}|${l.opacity}|${inheritedOpacity}|${l.blendMode}|${l.clipped ? 1 : 0}|v:${contentVer}|m:${maskSig}|t:${toneSig}|c:${tintSig}|e:${exprSig}|s:${stylesSig}|a:${adjSig}`;

  if (node.children.length > 0) {
    const childSigs: string[] = [];
    for (const child of node.children) {
      if (!child.layer.visible || child.layer.opacity <= 0.001) continue;
      childSigs.push(
        serializeLayerNodeSignature(child, 1.0, getLayerContentVersion, getMaskInvalidationEpoch)
      );
    }
    sig += `[${childSigs.join(',')}]`;
  }

  return sig;
}

function serializeUnitSignature(
  unit: CompositingUnit,
  getLayerContentVersion: (layerId: string) => number,
  getMaskInvalidationEpoch?: (layerId: string) => number
): string {
  let sig = serializeLayerNodeSignature(
    unit.group.baseNode,
    unit.inheritedOpacity,
    getLayerContentVersion,
    getMaskInvalidationEpoch
  );
  if (unit.group.clippedNodes.length > 0) {
    const clippedSigs: string[] = [];
    for (const cn of unit.group.clippedNodes) {
      if (!cn.layer.visible || cn.layer.opacity <= 0.001 || cn.layer.type === 'folder') continue;
      clippedSigs.push(
        serializeLayerNodeSignature(cn, unit.inheritedOpacity, getLayerContentVersion, getMaskInvalidationEpoch)
      );
    }
    if (clippedSigs.length > 0) {
      sig += `{clip:${clippedSigs.join(';')}}`;
    }
  }
  return sig;
}

/**
 * Pure invalidation tracker for the Baked Layer Stack Cache (`belowActiveCacheFbo` & `aboveActiveCacheFbo`).
 * Determines independently whether the lower or upper cached FBO needs rebuilding.
 */
export class LayerStackCacheTracker {
  private lastBelowSignature: string | null = null;
  private lastAboveSignature: string | null = null;

  public evaluate(input: LayerStackCacheInput): LayerStackCacheEvaluation {
    const partition = partitionLayerStack(input.layers, input.activeLayerId);

    const { transform, dimensions } = input;
    const viewportSig =
      `${input.viewportW}x${input.viewportH}@${input.dpr}|` +
      `${dimensions.width}x${dimensions.height}@${dimensions.dpi ?? 600}|` +
      `${transform.pan.x},${transform.pan.y},${transform.zoom},${transform.rotation},` +
      `${transform.flipX ? 1 : 0},${transform.flipY ? 1 : 0}|g:${input.gridId ?? 0}|ep:${input.gridEpoch ?? 0}`;

    // Onion skin frames are baked into the below cache right after the artboard background
    let onionSig = '';
    if (input.onionSkinFrames && input.onionSkinFrames.length > 0) {
      const layerMap = new Map<string, LayerItem>();
      for (const l of input.layers) layerMap.set(l.id, l);
      const parts: string[] = [];
      for (const frame of input.onionSkinFrames) {
        const target = layerMap.get(frame.layerId);
        if (target && target.visible) {
          parts.push(
            `${frame.layerId}:${frame.tint}:${frame.opacity}:v${input.getLayerContentVersion(frame.layerId)}`
          );
        }
      }
      onionSig = parts.join(',');
    }

    const belowUnitSigs = partition.belowUnits.map((u) =>
      serializeUnitSignature(u, input.getLayerContentVersion, input.getMaskInvalidationEpoch)
    );
    const belowSignature = `${viewportSig}|cb:${input.showCheckerboard ? 1 : 0}|os:${onionSig}|below:[${belowUnitSigs.join('||')}]`;

    let aboveSignature = '';
    if (partition.aboveCachedUnits.length > 0) {
      const aboveUnitSigs = partition.aboveCachedUnits.map((u) =>
        serializeUnitSignature(u, input.getLayerContentVersion, input.getMaskInvalidationEpoch)
      );
      aboveSignature = `${viewportSig}|strat:${partition.aboveStrategy}:${partition.aboveCacheBlendMode}|above:[${aboveUnitSigs.join('||')}]`;
    }

    const belowDirty = belowSignature !== this.lastBelowSignature;
    const aboveDirty =
      partition.aboveCachedUnits.length > 0 && aboveSignature !== this.lastAboveSignature;

    return {
      partition,
      belowSignature,
      aboveSignature,
      belowDirty,
      aboveDirty,
    };
  }

  public commit(belowSignature: string, aboveSignature: string): void {
    this.lastBelowSignature = belowSignature;
    this.lastAboveSignature = aboveSignature;
  }

  public invalidateAll(): void {
    this.lastBelowSignature = null;
    this.lastAboveSignature = null;
  }

  public invalidateBelow(): void {
    this.lastBelowSignature = null;
  }

  public invalidateAbove(): void {
    this.lastAboveSignature = null;
  }

  public getLastSignatures(): { below: string | null; above: string | null } {
    return { below: this.lastBelowSignature, above: this.lastAboveSignature };
  }
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
  const { pan, zoom, rotation, flipX = false, flipY = false } = transform;
  const rad = (-rotation * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const fx = flipX ? -1 : 1;
  const fy = flipY ? -1 : 1;

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

    // Invert view flip and center offset
    const docX = rx * fx + docW * 0.5;
    const docY = ry * fy + docH * 0.5;

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

interface FboSurface {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  stencilRb: WebGLRenderbuffer | null;
  width: number;
  height: number;
}

interface PingPongTarget {
  surfaces: [FboSurface, FboSurface];
  activeIndex: 0 | 1;
}

interface LayerUniformLocs {
  uDocDimensions: WebGLUniformLocation | null;
  uViewportSize: WebGLUniformLocation | null;
  uPan: WebGLUniformLocation | null;
  uZoom: WebGLUniformLocation | null;
  uRotationRad: WebGLUniformLocation | null;
  uFlip: WebGLUniformLocation | null;
  uDpr: WebGLUniformLocation | null;
  uBackdropTexture: WebGLUniformLocation | null;
  uHasBackdrop: WebGLUniformLocation | null;
  uLayerOpacity: WebGLUniformLocation | null;
  uBlendMode: WebGLUniformLocation | null;
  uToneEnabled: WebGLUniformLocation | null;
  uToneFrequency: WebGLUniformLocation | null;
  uToneAngleRad: WebGLUniformLocation | null;
  uToneDpi: WebGLUniformLocation | null;
  uToneDotShape: WebGLUniformLocation | null;
  uToneDensity: WebGLUniformLocation | null;
  uToneDensityType: WebGLUniformLocation | null;
  uLayerColorEnabled: WebGLUniformLocation | null;
  uLayerColor: WebGLUniformLocation | null;
  uLayerSubColor: WebGLUniformLocation | null;
  uMaskTexture: WebGLUniformLocation | null;
  uMaskEnabled: WebGLUniformLocation | null;
  uExpressionMode: WebGLUniformLocation | null;
  uMonoThreshold: WebGLUniformLocation | null;
  uMonoExpressBlack: WebGLUniformLocation | null;
  uMonoExpressWhite: WebGLUniformLocation | null;
}

interface ArrayPoolSlot {
  sliceIndex: number;
  currentKey: string | null;
  version: number;
  lastUsed: number;
  lastBatchTick: number;
}

/**
 * High-performance WebGL2 Viewport Compositor
 */
export class ViewportCompositor {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;

  // Standard compositor uniform locations
  private uTileOriginLoc: WebGLUniformLocation | null = null;
  private uTileSizeLoc: WebGLUniformLocation | null = null;
  private uIsBackgroundLoc: WebGLUniformLocation | null = null;
  private uShowCheckerboardLoc: WebGLUniformLocation | null = null;
  private uTileTextureLoc: WebGLUniformLocation | null = null;
  private stdLocs: LayerUniformLocs | null = null;

  // Instanced TEXTURE_2D_ARRAY batching program, VAO, buffer, & pool
  private static readonly DEFAULT_ARRAY_POOL_LAYERS = 256;
  private instancedProgram: WebGLProgram | null = null;
  private instancedLocs: LayerUniformLocs | null = null;
  private uInstTileSizeLoc: WebGLUniformLocation | null = null;
  private uInstTileArrayLoc: WebGLUniformLocation | null = null;
  private aInstQuadPosLoc: number = -1;
  private aInstDataLoc: number = -1;
  private instancedVao: WebGLVertexArrayObject | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private instanceFloatScratch: Float32Array = new Float32Array(
    ViewportCompositor.DEFAULT_ARRAY_POOL_LAYERS * 3
  );
  private tileArrayTexture: WebGLTexture | null = null;
  private arrayPoolCapacity: number = 0;
  private arrayPoolFilterTier: number = -1;
  private arrayPoolSlots: ArrayPoolSlot[] = [];
  private arrayPoolByKey: Map<string, ArrayPoolSlot> = new Map();
  private arrayAccessCounter: number = 0;
  private arrayBatchCounter: number = 0;

  // Viewport-space draft stroke program (reuses COMPOSITOR_FRAGMENT_SHADER)
  private viewportDraftProgram: WebGLProgram | null = null;
  private viewportDraftLocs: LayerUniformLocs | null = null;
  private uViewportDraftTileTexLoc: WebGLUniformLocation | null = null;
  private uViewportDraftIsBgLoc: WebGLUniformLocation | null = null;
  private aViewportDraftQuadPosLoc: number = -1;

  // Cached attribute locations (eliminates per-frame gl.getAttribLocation stalls)
  private aQuadPosLoc: number = -1;
  private aStylesQuadPosLoc: number = -1;
  private aBlitQuadPosLoc: number = -1;
  private aProofQuadPosLoc: number = -1;
  private contextLost: boolean = false;
  private onContextLostHandler: ((e: Event) => void) | null = null;
  private onContextRestoredHandler: (() => void) | null = null;

  // Mask version-tracked cache & invalidation epochs
  private maskTextureCache: Map<
    string,
    { texture: WebGLTexture; version: number; width: number; height: number }
  > = new Map();
  private maskInvalidationEpochs: Map<string, number> = new Map();
  private globalMaskEpochCounter: number = 0;

  // Live in-stack draft stroke texture cache
  private draftTexture: WebGLTexture | null = null;
  private draftTexWidth: number = 0;
  private draftTexHeight: number = 0;
  private lastDraftVersion: number = -1;
  private currentOptions: CompositorOptions | null = null;
  private currentZoom: number = 1.0;
  private currentFrameState: {
    viewportW: number;
    viewportH: number;
    dpr: number;
    dimensions: CanvasDimensions;
    transform: ViewportTransform;
    rotRad: number;
  } | null = null;

  // Adjustment program & uniforms
  private adjProgram: WebGLProgram | null = null;
  private uAdjTileOriginLoc: WebGLUniformLocation | null = null;
  private uAdjTileSizeLoc: WebGLUniformLocation | null = null;
  private uAdjDocDimensionsLoc: WebGLUniformLocation | null = null;
  private uAdjViewportSizeLoc: WebGLUniformLocation | null = null;
  private uAdjPanLoc: WebGLUniformLocation | null = null;
  private uAdjZoomLoc: WebGLUniformLocation | null = null;
  private uAdjRotationRadLoc: WebGLUniformLocation | null = null;
  private uAdjFlipLoc: WebGLUniformLocation | null = null;
  private uAdjDprLoc: WebGLUniformLocation | null = null;
  private uAdjSnapshotLoc: WebGLUniformLocation | null = null;
  private uAdjLutLoc: WebGLUniformLocation | null = null;
  private uAdjModeLoc: WebGLUniformLocation | null = null;
  private uAdjOpacityLoc: WebGLUniformLocation | null = null;
  private uAdjMaskEnabledLoc: WebGLUniformLocation | null = null;
  private uAdjMaskTextureLoc: WebGLUniformLocation | null = null;

  private lutTexture: WebGLTexture | null = null;
  private lastLutKey: string = '';
  private lastLutAdjMode: number = 0;

  // Layer Styles program, FBO & uniforms
  private stylesProgram: WebGLProgram | null = null;
  private stylesQuadBuffer: WebGLBuffer | null = null;
  private layerFbo: WebGLFramebuffer | null = null;
  private layerTexture: WebGLTexture | null = null;
  private layerFboWidth: number = 0;
  private layerFboHeight: number = 0;
  private layerStylesOutFbo: FboSurface | null = null;

  private uStylesLayerTextureLoc: WebGLUniformLocation | null = null;
  private uStylesViewportSizeLoc: WebGLUniformLocation | null = null;
  private uStylesLayerOpacityLoc: WebGLUniformLocation | null = null;
  private uStylesStrokeEnabledLoc: WebGLUniformLocation | null = null;
  private uStylesStrokeSizeLoc: WebGLUniformLocation | null = null;
  private uStylesStrokeColorLoc: WebGLUniformLocation | null = null;
  private uStylesStrokePositionLoc: WebGLUniformLocation | null = null;
  private uStylesGlowEnabledLoc: WebGLUniformLocation | null = null;
  private uStylesGlowColorLoc: WebGLUniformLocation | null = null;
  private uStylesGlowBlurLoc: WebGLUniformLocation | null = null;
  private uStylesGlowSpreadLoc: WebGLUniformLocation | null = null;
  private uStylesShadowEnabledLoc: WebGLUniformLocation | null = null;
  private uStylesShadowColorLoc: WebGLUniformLocation | null = null;
  private uStylesShadowOffsetLoc: WebGLUniformLocation | null = null;
  private uStylesShadowBlurLoc: WebGLUniformLocation | null = null;
  private uStylesShadowSpreadLoc: WebGLUniformLocation | null = null;

  // Folder / Cache blit program & uniforms
  private blitProgram: WebGLProgram | null = null;
  private uBlitTextureLoc: WebGLUniformLocation | null = null;
  private uBlitBackdropTextureLoc: WebGLUniformLocation | null = null;
  private uBlitHasBackdropLoc: WebGLUniformLocation | null = null;
  private uBlitBlendModeLoc: WebGLUniformLocation | null = null;
  private uBlitOpacityLoc: WebGLUniformLocation | null = null;

  // Ping-Pong FBOs (eliminates all gl.copyTexSubImage2D calls for custom blend modes)
  private scenePingPong: PingPongTarget | null = null;
  private folderPingPongs: PingPongTarget[] = [];

  // Baked Layer Stack Cache FBOs (below & above active layer)
  private belowActiveCacheFbo: FboSurface | null = null;
  private aboveActiveCacheFbo: FboSurface | null = null;
  private stackCache: LayerStackCacheTracker = new LayerStackCacheTracker();
  private stackCacheStats = { belowRebuilds: 0, aboveRebuilds: 0, cacheHits: 0 };

  // Soft proofing program & uniforms
  private softProofProgram: WebGLProgram | null = null;
  private uProofSceneTextureLoc: WebGLUniformLocation | null = null;
  private uProofStandardLoc: WebGLUniformLocation | null = null;
  private uProofEnabledLoc: WebGLUniformLocation | null = null;
  private uProofGamutWarningLoc: WebGLUniformLocation | null = null;
  private uProofGamutWarningColorLoc: WebGLUniformLocation | null = null;

  // Pre-allocated WebGL2 Texture2D Pool (overflow fallback for TEXTURE_2D_ARRAY)
  private static readonly MAX_TEXTURE_POOL_SIZE = 2048;
  private textureAccessCounter: number = 0;
  private texturePool: Array<{
    texture: WebGLTexture;
    currentKey: string | null;
    version: number;
    lastUsed: number;
    filterTier?: number;
    hasStorage?: boolean;
    hasMipmap?: boolean;
  }> = [];
  private activePoolByKey: Map<
    string,
    {
      texture: WebGLTexture;
      currentKey: string | null;
      version: number;
      lastUsed: number;
      filterTier?: number;
      hasStorage?: boolean;
      hasMipmap?: boolean;
    }
  > = new Map();
  private fallbackTileCanvas: HTMLCanvasElement | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    if (typeof canvas.addEventListener === 'function') {
      this.onContextLostHandler = (e: Event) => {
        e.preventDefault();
        this.contextLost = true;
        this.gl = null;
        this.program = null;
        this.instancedProgram = null;
        this.instancedVao = null;
        this.instanceBuffer = null;
        this.tileArrayTexture = null;
        this.arrayPoolSlots = [];
        this.arrayPoolByKey.clear();
        this.arrayPoolCapacity = 0;
        this.arrayPoolFilterTier = -1;
        this.viewportDraftProgram = null;
        this.adjProgram = null;
        this.stylesProgram = null;
        this.blitProgram = null;
        this.softProofProgram = null;
        this.texturePool = [];
        this.activePoolByKey.clear();
        this.maskTextureCache.clear();
        this.scenePingPong = null;
        this.folderPingPongs = [];
        this.belowActiveCacheFbo = null;
        this.aboveActiveCacheFbo = null;
        this.layerStylesOutFbo = null;
        this.layerFbo = null;
        this.layerTexture = null;
        this.lutTexture = null;
        this.draftTexture = null;
        this.stackCache.invalidateAll();
      };
      this.onContextRestoredHandler = () => {
        this.contextLost = false;
        this.initGL();
        (this.lastRenderedGrid || globalTileGrid).notifyChange(true);
      };
      canvas.addEventListener('webglcontextlost', this.onContextLostHandler, false);
      canvas.addEventListener('webglcontextrestored', this.onContextRestoredHandler, false);
    }
    this.initGL();
  }

  public isReady(): boolean {
    return !this.contextLost && this.gl !== null && this.program !== null;
  }

  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  public getStackCacheStats(): { belowRebuilds: number; aboveRebuilds: number; cacheHits: number } {
    return { ...this.stackCacheStats };
  }

  /**
   * Explicitly invalidate baked layer stack caches.
   */
  public invalidateStackCache(): void {
    this.stackCache.invalidateAll();
  }

  /**
   * Explicitly invalidate a cached layer mask texture (or all masks if layerId omitted).
   */
  public invalidateMaskTexture(layerId?: string): void {
    const nextEpoch = ++this.globalMaskEpochCounter;
    if (layerId) {
      const item = this.maskTextureCache.get(layerId);
      if (item) item.version = -1;
      this.maskInvalidationEpochs.set(layerId, nextEpoch);
    } else {
      for (const [id, item] of this.maskTextureCache.entries()) {
        item.version = -1;
        this.maskInvalidationEpochs.set(id, nextEpoch);
      }
      this.stackCache.invalidateAll();
    }
  }

  /**
   * Explicitly invalidate and clear all cached tile textures in both TEXTURE_2D and TEXTURE_2D_ARRAY pools.
   */
  public invalidateTileTextures(): void {
    if (this.gl) {
      for (const slot of this.texturePool) {
        this.gl.deleteTexture(slot.texture);
      }
    }
    this.texturePool = [];
    this.activePoolByKey.clear();
    for (const slot of this.arrayPoolSlots) {
      slot.currentKey = null;
      slot.version = -1;
      slot.lastUsed = 0;
      slot.lastBatchTick = 0;
    }
    this.arrayPoolByKey.clear();
    this.stackCache.invalidateAll();
  }

  private queryLayerUniformLocs(gl: WebGL2RenderingContext, prog: WebGLProgram): LayerUniformLocs {
    return {
      uDocDimensions: gl.getUniformLocation(prog, 'u_docDimensions'),
      uViewportSize: gl.getUniformLocation(prog, 'u_viewportSize'),
      uPan: gl.getUniformLocation(prog, 'u_pan'),
      uZoom: gl.getUniformLocation(prog, 'u_zoom'),
      uRotationRad: gl.getUniformLocation(prog, 'u_rotationRad'),
      uFlip: gl.getUniformLocation(prog, 'u_flip'),
      uDpr: gl.getUniformLocation(prog, 'u_dpr'),
      uBackdropTexture: gl.getUniformLocation(prog, 'u_backdropTexture'),
      uHasBackdrop: gl.getUniformLocation(prog, 'u_hasBackdrop'),
      uLayerOpacity: gl.getUniformLocation(prog, 'u_layerOpacity'),
      uBlendMode: gl.getUniformLocation(prog, 'u_blendMode'),
      uToneEnabled: gl.getUniformLocation(prog, 'u_toneEnabled'),
      uToneFrequency: gl.getUniformLocation(prog, 'u_toneFrequency'),
      uToneAngleRad: gl.getUniformLocation(prog, 'u_toneAngleRad'),
      uToneDpi: gl.getUniformLocation(prog, 'u_toneDpi'),
      uToneDotShape: gl.getUniformLocation(prog, 'u_toneDotShape'),
      uToneDensity: gl.getUniformLocation(prog, 'u_toneDensity'),
      uToneDensityType: gl.getUniformLocation(prog, 'u_toneDensityType'),
      uLayerColorEnabled: gl.getUniformLocation(prog, 'u_layerColorEnabled'),
      uLayerColor: gl.getUniformLocation(prog, 'u_layerColor'),
      uLayerSubColor: gl.getUniformLocation(prog, 'u_layerSubColor'),
      uMaskTexture: gl.getUniformLocation(prog, 'u_maskTexture'),
      uMaskEnabled: gl.getUniformLocation(prog, 'u_maskEnabled'),
      uExpressionMode: gl.getUniformLocation(prog, 'u_expressionMode'),
      uMonoThreshold: gl.getUniformLocation(prog, 'u_monoThreshold'),
      uMonoExpressBlack: gl.getUniformLocation(prog, 'u_monoExpressBlack'),
      uMonoExpressWhite: gl.getUniformLocation(prog, 'u_monoExpressWhite'),
    };
  }

  private initTileArrayPool(gl: WebGL2RenderingContext): void {
    if (
      typeof gl.texStorage3D !== 'function' ||
      typeof gl.texSubImage3D !== 'function' ||
      typeof gl.drawArraysInstanced !== 'function' ||
      typeof gl.vertexAttribDivisor !== 'function' ||
      !this.quadBuffer
    ) {
      return;
    }

    const instVs = gl.createShader(gl.VERTEX_SHADER);
    const instFs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!instVs || !instFs) return;

    gl.shaderSource(instVs, COMPOSITOR_INSTANCED_VERTEX_SHADER);
    gl.compileShader(instVs);
    gl.shaderSource(instFs, COMPOSITOR_INSTANCED_FRAGMENT_SHADER);
    gl.compileShader(instFs);
    if (
      !gl.getShaderParameter(instVs, gl.COMPILE_STATUS) ||
      !gl.getShaderParameter(instFs, gl.COMPILE_STATUS)
    ) {
      console.error('Instanced tile shader compile error:', gl.getShaderInfoLog(instVs), gl.getShaderInfoLog(instFs));
      return;
    }

    const iProg = gl.createProgram();
    if (!iProg) return;
    gl.attachShader(iProg, instVs);
    gl.attachShader(iProg, instFs);
    gl.linkProgram(iProg);
    if (!gl.getProgramParameter(iProg, gl.LINK_STATUS)) {
      console.error('Instanced tile program link error:', gl.getProgramInfoLog(iProg));
      return;
    }

    const maxLayersParam = Number(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)) || ViewportCompositor.DEFAULT_ARRAY_POOL_LAYERS;
    const capacity = Math.max(1, Math.min(ViewportCompositor.DEFAULT_ARRAY_POOL_LAYERS, maxLayersParam));

    const arrTex = gl.createTexture();
    const instBuf = gl.createBuffer();
    if (!arrTex || !instBuf) {
      if (arrTex) gl.deleteTexture(arrTex);
      if (instBuf) gl.deleteBuffer(instBuf);
      gl.deleteProgram(iProg);
      return;
    }

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, arrTex);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, TILE_SIZE, TILE_SIZE, capacity);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    this.instanceFloatScratch = new Float32Array(capacity * 3);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.instanceFloatScratch.byteLength, gl.DYNAMIC_DRAW);

    this.instancedProgram = iProg;
    this.instancedLocs = this.queryLayerUniformLocs(gl, iProg);
    this.uInstTileSizeLoc = gl.getUniformLocation(iProg, 'u_tileSize');
    this.uInstTileArrayLoc = gl.getUniformLocation(iProg, 'u_tileArrayTexture');
    this.aInstQuadPosLoc = gl.getAttribLocation(iProg, 'a_quadPos');
    this.aInstDataLoc = gl.getAttribLocation(iProg, 'a_instanceData');

    // Immediately bind distinct texture units for sampler2DArray (0) vs sampler2D (1, 2)
    // to prevent WebGL2 GL_INVALID_OPERATION sampler-type collisions on unit 0.
    gl.useProgram(iProg);
    gl.uniform1i(this.uInstTileArrayLoc, 0);
    gl.uniform1i(this.instancedLocs.uMaskTexture, 1);
    gl.uniform1i(this.instancedLocs.uBackdropTexture, 2);
    if (this.program) {
      gl.useProgram(this.program);
    }

    this.tileArrayTexture = arrTex;
    this.instanceBuffer = instBuf;
    this.arrayPoolCapacity = capacity;
    this.arrayPoolFilterTier = 1;
    this.arrayPoolSlots = [];
    this.arrayPoolByKey.clear();
    for (let i = 0; i < capacity; i++) {
      this.arrayPoolSlots.push({
        sliceIndex: i,
        currentKey: null,
        version: -1,
        lastUsed: 0,
        lastBatchTick: 0,
      });
    }

    if (typeof gl.createVertexArray === 'function') {
      const vao = gl.createVertexArray();
      if (vao) {
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        if (this.aInstQuadPosLoc >= 0) {
          gl.enableVertexAttribArray(this.aInstQuadPosLoc);
          gl.vertexAttribPointer(this.aInstQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
          gl.vertexAttribDivisor(this.aInstQuadPosLoc, 0);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
        if (this.aInstDataLoc >= 0) {
          gl.enableVertexAttribArray(this.aInstDataLoc);
          gl.vertexAttribPointer(this.aInstDataLoc, 3, gl.FLOAT, false, 0, 0);
          gl.vertexAttribDivisor(this.aInstDataLoc, 1);
        }
        gl.bindVertexArray(null);
        this.instancedVao = vao;
      }
    }
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
        preserveDrawingBuffer: true,
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

      // Link standard compositor program
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
      this.stdLocs = this.queryLayerUniformLocs(gl, prog);

      // Cache standard-only uniforms
      this.uTileOriginLoc = gl.getUniformLocation(prog, 'u_tileOrigin');
      this.uTileSizeLoc = gl.getUniformLocation(prog, 'u_tileSize');
      this.uIsBackgroundLoc = gl.getUniformLocation(prog, 'u_isBackground');
      this.uShowCheckerboardLoc = gl.getUniformLocation(prog, 'u_showCheckerboard');
      this.uTileTextureLoc = gl.getUniformLocation(prog, 'u_tileTexture');
      this.aQuadPosLoc = gl.getAttribLocation(prog, 'a_quadPos');

      // Compile Viewport-Space Draft Shader Program (shares COMPOSITOR_FRAGMENT_SHADER)
      const draftVs = gl.createShader(gl.VERTEX_SHADER);
      if (draftVs) {
        gl.shaderSource(draftVs, VIEWPORT_DRAFT_VERTEX_SHADER);
        gl.compileShader(draftVs);
        if (gl.getShaderParameter(draftVs, gl.COMPILE_STATUS)) {
          const dProg = gl.createProgram();
          if (dProg) {
            gl.attachShader(dProg, draftVs);
            gl.attachShader(dProg, fs);
            gl.linkProgram(dProg);
            if (gl.getProgramParameter(dProg, gl.LINK_STATUS)) {
              this.viewportDraftProgram = dProg;
              this.viewportDraftLocs = this.queryLayerUniformLocs(gl, dProg);
              this.uViewportDraftTileTexLoc = gl.getUniformLocation(dProg, 'u_tileTexture');
              this.uViewportDraftIsBgLoc = gl.getUniformLocation(dProg, 'u_isBackground');
              this.aViewportDraftQuadPosLoc = gl.getAttribLocation(dProg, 'a_quadPos');
            }
          }
        }
      }

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
              this.uAdjFlipLoc = gl.getUniformLocation(aProg, 'u_flip');
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

      // Compile Layer Styles Shader Program
      const stylesVs = gl.createShader(gl.VERTEX_SHADER);
      const stylesFs = gl.createShader(gl.FRAGMENT_SHADER);
      if (stylesVs && stylesFs) {
        gl.shaderSource(stylesVs, LAYER_STYLES_VERTEX_SHADER);
        gl.compileShader(stylesVs);
        gl.shaderSource(stylesFs, LAYER_STYLES_FRAGMENT_SHADER);
        gl.compileShader(stylesFs);
        if (gl.getShaderParameter(stylesVs, gl.COMPILE_STATUS) && gl.getShaderParameter(stylesFs, gl.COMPILE_STATUS)) {
          const sProg = gl.createProgram();
          if (sProg) {
            gl.attachShader(sProg, stylesVs);
            gl.attachShader(sProg, stylesFs);
            gl.linkProgram(sProg);
            if (gl.getProgramParameter(sProg, gl.LINK_STATUS)) {
              this.stylesProgram = sProg;
              this.aStylesQuadPosLoc = gl.getAttribLocation(sProg, 'a_quadPos');
              this.uStylesLayerTextureLoc = gl.getUniformLocation(sProg, 'u_layerTexture');
              this.uStylesViewportSizeLoc = gl.getUniformLocation(sProg, 'u_viewportSize');
              this.uStylesLayerOpacityLoc = gl.getUniformLocation(sProg, 'u_layerOpacity');
              this.uStylesStrokeEnabledLoc = gl.getUniformLocation(sProg, 'u_strokeEnabled');
              this.uStylesStrokeSizeLoc = gl.getUniformLocation(sProg, 'u_strokeSize');
              this.uStylesStrokeColorLoc = gl.getUniformLocation(sProg, 'u_strokeColor');
              this.uStylesStrokePositionLoc = gl.getUniformLocation(sProg, 'u_strokePosition');
              this.uStylesGlowEnabledLoc = gl.getUniformLocation(sProg, 'u_glowEnabled');
              this.uStylesGlowColorLoc = gl.getUniformLocation(sProg, 'u_glowColor');
              this.uStylesGlowBlurLoc = gl.getUniformLocation(sProg, 'u_glowBlur');
              this.uStylesGlowSpreadLoc = gl.getUniformLocation(sProg, 'u_glowSpread');
              this.uStylesShadowEnabledLoc = gl.getUniformLocation(sProg, 'u_shadowEnabled');
              this.uStylesShadowColorLoc = gl.getUniformLocation(sProg, 'u_shadowColor');
              this.uStylesShadowOffsetLoc = gl.getUniformLocation(sProg, 'u_shadowOffset');
              this.uStylesShadowBlurLoc = gl.getUniformLocation(sProg, 'u_shadowBlur');
              this.uStylesShadowSpreadLoc = gl.getUniformLocation(sProg, 'u_shadowSpread');
            }
          }
        } else {
          console.error('Layer Styles shader compile error:', gl.getShaderInfoLog(stylesFs));
        }
      }

      // Compile Folder / Cache Blit Shader Program
      const blitVs = gl.createShader(gl.VERTEX_SHADER);
      const blitFs = gl.createShader(gl.FRAGMENT_SHADER);
      if (blitVs && blitFs) {
        gl.shaderSource(blitVs, FOLDER_BLIT_VERTEX_SHADER);
        gl.compileShader(blitVs);
        gl.shaderSource(blitFs, FOLDER_BLIT_FRAGMENT_SHADER);
        gl.compileShader(blitFs);
        if (gl.getShaderParameter(blitVs, gl.COMPILE_STATUS) && gl.getShaderParameter(blitFs, gl.COMPILE_STATUS)) {
          const bProg = gl.createProgram();
          if (bProg) {
            gl.attachShader(bProg, blitVs);
            gl.attachShader(bProg, blitFs);
            gl.linkProgram(bProg);
            if (gl.getProgramParameter(bProg, gl.LINK_STATUS)) {
              this.blitProgram = bProg;
              this.aBlitQuadPosLoc = gl.getAttribLocation(bProg, 'a_quadPos');
              this.uBlitTextureLoc = gl.getUniformLocation(bProg, 'u_blitTexture');
              this.uBlitBackdropTextureLoc = gl.getUniformLocation(bProg, 'u_backdropTexture');
              this.uBlitHasBackdropLoc = gl.getUniformLocation(bProg, 'u_hasBackdrop');
              this.uBlitBlendModeLoc = gl.getUniformLocation(bProg, 'u_blendMode');
              this.uBlitOpacityLoc = gl.getUniformLocation(bProg, 'u_blitOpacity');
            }
          }
        }
      }

      // Compile Soft Proof Shader Program
      const proofVs = gl.createShader(gl.VERTEX_SHADER);
      const proofFs = gl.createShader(gl.FRAGMENT_SHADER);
      if (proofVs && proofFs) {
        gl.shaderSource(proofVs, SOFT_PROOF_VERTEX_SHADER);
        gl.compileShader(proofVs);
        gl.shaderSource(proofFs, SOFT_PROOF_FRAGMENT_SHADER);
        gl.compileShader(proofFs);
        if (gl.getShaderParameter(proofVs, gl.COMPILE_STATUS) && gl.getShaderParameter(proofFs, gl.COMPILE_STATUS)) {
          const pProg = gl.createProgram();
          if (pProg) {
            gl.attachShader(pProg, proofVs);
            gl.attachShader(pProg, proofFs);
            gl.linkProgram(pProg);
            if (gl.getProgramParameter(pProg, gl.LINK_STATUS)) {
              this.softProofProgram = pProg;
              this.aProofQuadPosLoc = gl.getAttribLocation(pProg, 'a_quadPos');
              this.uProofSceneTextureLoc = gl.getUniformLocation(pProg, 'u_sceneTexture');
              this.uProofStandardLoc = gl.getUniformLocation(pProg, 'u_standard');
              this.uProofEnabledLoc = gl.getUniformLocation(pProg, 'u_proofEnabled');
              this.uProofGamutWarningLoc = gl.getUniformLocation(pProg, 'u_gamutWarning');
              this.uProofGamutWarningColorLoc = gl.getUniformLocation(pProg, 'u_gamutWarningColor');
            } else {
              console.error('Soft proof link error:', gl.getProgramInfoLog(pProg));
            }
          }
        } else {
          console.error('Soft proof shader compile error:', gl.getShaderInfoLog(proofVs), gl.getShaderInfoLog(proofFs));
        }
      }

      // Create Layer Styles Quad Buffer [0, 1]
      const stylesQuad = gl.createBuffer();
      if (stylesQuad) {
        gl.bindBuffer(gl.ARRAY_BUFFER, stylesQuad);
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
        this.stylesQuadBuffer = stylesQuad;
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

      // Initialize TEXTURE_2D_ARRAY + instanced batch rendering pipeline
      this.initTileArrayPool(gl);

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
    const nextW = Math.max(1, width);
    const nextH = Math.max(1, height);
    if (this.canvas.width !== nextW || this.canvas.height !== nextH) {
      this.canvas.width = nextW;
      this.canvas.height = nextH;
      this.stackCache.invalidateAll();
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

  // ============================================================================
  // Ping-Pong FBO & Offscreen Cache Surface Management
  // ============================================================================

  private createFboSurface(gl: WebGL2RenderingContext, withStencil: boolean = true): FboSurface | null {
    const fbo = gl.createFramebuffer();
    const texture = gl.createTexture();
    if (!fbo || !texture) {
      if (fbo) gl.deleteFramebuffer(fbo);
      if (texture) gl.deleteTexture(texture);
      return null;
    }
    const stencilRb =
      withStencil && typeof gl.createRenderbuffer === 'function' ? gl.createRenderbuffer() : null;
    return { fbo, texture, stencilRb, width: 0, height: 0 };
  }

  private ensureFboSurfaceSize(
    gl: WebGL2RenderingContext,
    surface: FboSurface,
    width: number,
    height: number
  ): boolean {
    if (surface.width === width && surface.height === height) {
      return true;
    }

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

    gl.bindTexture(gl.TEXTURE_2D, surface.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, surface.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, surface.texture, 0);

    if (surface.stencilRb && typeof gl.bindRenderbuffer === 'function') {
      gl.bindRenderbuffer(gl.RENDERBUFFER, surface.stencilRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, surface.stencilRb);
    }

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('Compositor FBO surface incomplete:', status);
      return false;
    }

    surface.width = width;
    surface.height = height;
    return true;
  }

  private ensurePingPongTarget(
    gl: WebGL2RenderingContext,
    existing: PingPongTarget | null,
    width: number,
    height: number
  ): PingPongTarget | null {
    let target = existing;
    if (!target) {
      const s0 = this.createFboSurface(gl, true);
      const s1 = this.createFboSurface(gl, true);
      if (!s0 || !s1) {
        this.disposeFboSurface(gl, s0);
        this.disposeFboSurface(gl, s1);
        return null;
      }
      target = { surfaces: [s0, s1], activeIndex: 0 };
    }
    if (
      !this.ensureFboSurfaceSize(gl, target.surfaces[0], width, height) ||
      !this.ensureFboSurfaceSize(gl, target.surfaces[1], width, height)
    ) {
      return null;
    }
    return target;
  }

  private ensureFolderPingPong(
    gl: WebGL2RenderingContext,
    depth: number,
    width: number,
    height: number
  ): PingPongTarget | null {
    while (this.folderPingPongs.length <= depth) {
      const created = this.ensurePingPongTarget(gl, null, width, height);
      if (!created) return null;
      this.folderPingPongs.push(created);
    }
    const target = this.ensurePingPongTarget(gl, this.folderPingPongs[depth], width, height);
    if (!target) return null;
    this.folderPingPongs[depth] = target;
    return target;
  }

  private disposeFboSurface(gl: WebGL2RenderingContext, surface: FboSurface | null): void {
    if (!surface) return;
    gl.deleteFramebuffer(surface.fbo);
    gl.deleteTexture(surface.texture);
    if (surface.stencilRb && typeof gl.deleteRenderbuffer === 'function') {
      gl.deleteRenderbuffer(surface.stencilRb);
    }
  }

  private disposePingPongTarget(gl: WebGL2RenderingContext, target: PingPongTarget | null): void {
    if (!target) return;
    this.disposeFboSurface(gl, target.surfaces[0]);
    this.disposeFboSurface(gl, target.surfaces[1]);
  }

  /**
   * Fast GPU-to-GPU FBO copy via gl.blitFramebuffer (with fullscreen quad fallback).
   * Eliminates all gl.copyTexSubImage2D calls and preserves stencil buffer when requested.
   */
  private copyFboSurface(
    gl: WebGL2RenderingContext,
    src: FboSurface,
    dst: FboSurface,
    width: number,
    height: number,
    copyStencil: boolean = false
  ): void {
    if (
      typeof gl.blitFramebuffer === 'function' &&
      gl.READ_FRAMEBUFFER !== undefined &&
      gl.DRAW_FRAMEBUFFER !== undefined
    ) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
      const mask = copyStencil && src.stencilRb && dst.stencilRb
        ? (gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
        : gl.COLOR_BUFFER_BIT;
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, mask, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, width, height);
      return;
    }

    // Fallback: fullscreen quad copy using blitProgram (zero copyTexSubImage2D)
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.blitProgram) return;

    const stencilWasEnabled = gl.isEnabled(gl.STENCIL_TEST);
    if (stencilWasEnabled) gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);

    gl.useProgram(this.blitProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stylesQuadBuffer || this.quadBuffer);
    if (this.aBlitQuadPosLoc >= 0) {
      gl.enableVertexAttribArray(this.aBlitQuadPosLoc);
      gl.vertexAttribPointer(this.aBlitQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(this.uBlitTextureLoc, 0);
    gl.uniform1i(this.uBlitBackdropTextureLoc, 2);
    gl.uniform1i(this.uBlitHasBackdropLoc, 0);
    gl.uniform1i(this.uBlitBlendModeLoc, 0);
    gl.uniform1f(this.uBlitOpacityLoc, 1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.unbindSceneTextureUnits(gl);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (stencilWasEnabled) gl.enable(gl.STENCIL_TEST);
    this.restoreStandardProgram(gl);
  }

  /**
   * Unbinds offscreen FBO textures from TEXTURE0 and TEXTURE2 so no texture attached
   * to the next bound DRAW_FRAMEBUFFER can trigger a WebGL2 feedback loop error.
   */
  private unbindSceneTextureUnits(gl: WebGL2RenderingContext): void {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Swaps Ping-Pong FBOs for a programmable blend / adjustment pass:
   * copies current surface -> opposite surface and returns current surface's immutable texture as backdrop.
   * ZERO gl.copyTexSubImage2D calls!
   */
  private prepareBackdropFromPingPong(
    gl: WebGL2RenderingContext,
    target: PingPongTarget,
    viewportW: number,
    viewportH: number,
    preserveStencil: boolean
  ): WebGLTexture {
    const src = target.surfaces[target.activeIndex];
    const nextIdx: 0 | 1 = target.activeIndex === 0 ? 1 : 0;
    const dst = target.surfaces[nextIdx];

    this.copyFboSurface(gl, src, dst, viewportW, viewportH, preserveStencil);
    target.activeIndex = nextIdx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, viewportW, viewportH);

    return src.texture;
  }

  private restoreStandardProgram(gl: WebGL2RenderingContext): void {
    if (this.program) {
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      if (this.aQuadPosLoc >= 0) {
        gl.enableVertexAttribArray(this.aQuadPosLoc);
        gl.vertexAttribPointer(this.aQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
      }
    }
  }

  private syncFrameUniforms(gl: WebGL2RenderingContext, locs: LayerUniformLocs): void {
    const fs = this.currentFrameState;
    if (!fs) return;
    gl.uniform2f(locs.uViewportSize, fs.viewportW, fs.viewportH);
    gl.uniform2f(locs.uDocDimensions, fs.dimensions.width, fs.dimensions.height);
    gl.uniform2f(locs.uPan, fs.transform.pan.x, fs.transform.pan.y);
    gl.uniform1f(locs.uZoom, fs.transform.zoom);
    gl.uniform1f(locs.uRotationRad, fs.rotRad);
    gl.uniform2f(locs.uFlip, fs.transform.flipX ? -1.0 : 1.0, fs.transform.flipY ? -1.0 : 1.0);
    gl.uniform1f(locs.uDpr, fs.dpr);
  }

  private applyLayerUniforms(
    gl: WebGL2RenderingContext,
    locs: LayerUniformLocs,
    layer: LayerItem,
    dimensions: CanvasDimensions,
    effectiveOpacity: number,
    modeCode: number,
    backdropTex: WebGLTexture | null,
    maskTex: WebGLTexture | null
  ): void {
    gl.uniform1f(locs.uLayerOpacity, effectiveOpacity);
    gl.uniform1i(locs.uBlendMode, modeCode);

    // Always bind distinct sampler units (mask = 1, backdrop = 2) so sampler2D never
    // collides with sampler2DArray on unit 0 in WebGL2.
    gl.uniform1i(locs.uBackdropTexture, 2);
    gl.uniform1i(locs.uMaskTexture, 1);

    if (backdropTex && modeCode !== 0 && modeCode !== 12) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, backdropTex);
      gl.uniform1i(locs.uHasBackdrop, 1);
    } else {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.uniform1i(locs.uHasBackdrop, 0);
    }

    // Expression Color Uniforms
    const isBgLayer = layer.id === 'layer-bg' || layer.id.startsWith('layer-bg');
    const exprMode = isBgLayer
      ? 0
      : layer.expressionColor === 'monochrome'
      ? 2
      : layer.expressionColor === 'gray'
      ? 1
      : 0;
    gl.uniform1i(locs.uExpressionMode, exprMode);
    if (exprMode === 2) {
      gl.uniform1f(locs.uMonoThreshold, (layer.monoThreshold ?? 128) / 255.0);
      gl.uniform1i(locs.uMonoExpressBlack, layer.monoExpressBlack !== false ? 1 : 0);
      gl.uniform1i(locs.uMonoExpressWhite, layer.monoExpressWhite !== false ? 1 : 0);
    }

    // Screentone Uniforms
    const toneEnabled = Boolean(layer.toneEnabled);
    gl.uniform1i(locs.uToneEnabled, toneEnabled ? 1 : 0);
    if (toneEnabled) {
      gl.uniform1f(locs.uToneFrequency, layer.toneFrequency || 60);
      gl.uniform1f(locs.uToneAngleRad, ((layer.toneAngle || 45) * Math.PI) / 180);
      gl.uniform1f(locs.uToneDpi, dimensions.dpi || 600);
      const dotShapeCode =
        layer.toneDotShape === 'line'
          ? 2
          : layer.toneDotShape === 'diamond'
          ? 3
          : layer.toneDotShape === 'euclidean'
          ? 1
          : 0;
      gl.uniform1i(locs.uToneDotShape, dotShapeCode);
      gl.uniform1f(locs.uToneDensity, (layer.toneDensity ?? 40) / 100);
      gl.uniform1i(locs.uToneDensityType, layer.toneDensityType === 'image' ? 1 : 0);
    }

    // Layer Tint Uniforms
    const tintEnabled = Boolean(layer.layerColorEnabled);
    gl.uniform1i(locs.uLayerColorEnabled, tintEnabled ? 1 : 0);
    if (tintEnabled) {
      const prim = this.parseHexColor(layer.layerColor || '#1c73c2');
      const sub = this.parseHexColor(layer.layerSubColor || '#ffffff');
      gl.uniform3f(locs.uLayerColor, prim[0], prim[1], prim[2]);
      gl.uniform3f(locs.uLayerSubColor, sub[0], sub[1], sub[2]);
    }

    // Layer Mask Uniforms
    if (maskTex) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, maskTex);
      gl.uniform1i(locs.uMaskEnabled, 1);
    } else {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.uniform1i(locs.uMaskEnabled, 0);
    }

    gl.activeTexture(gl.TEXTURE0);
  }

  // ============================================================================
  // Tile Texture Streaming (Zero-CPU Premultiply via UNPACK_PREMULTIPLY_ALPHA_WEBGL)
  // ============================================================================

  /**
   * Allocates or updates a slice inside the TEXTURE_2D_ARRAY pool using hardware UNPACK_PREMULTIPLY_ALPHA_WEBGL.
   * Never evicts slices pinned by the current batchTick.
   */
  private getOrUploadArrayTileSlice(
    gl: WebGL2RenderingContext,
    tile: TileBuffer,
    grid: SparseTileGrid,
    batchTick: number
  ): number {
    const gridId = typeof grid.getGridId === 'function' ? grid.getGridId() : 0;
    const key = `${gridId}:${getTileKey(tile.layerId, tile.tileX, tile.tileY, tile.lod ?? 0)}`;
    const accessTick = ++this.arrayAccessCounter;
    let slot = this.arrayPoolByKey.get(key);

    if (!slot) {
      let oldestSlot: ArrayPoolSlot | null = null;
      for (let i = 0; i < this.arrayPoolSlots.length; i++) {
        const candidate = this.arrayPoolSlots[i];
        if (candidate.lastBatchTick === batchTick) continue;
        if (candidate.currentKey === null) {
          oldestSlot = candidate;
          break;
        }
        if (!oldestSlot || candidate.lastUsed < oldestSlot.lastUsed) {
          oldestSlot = candidate;
        }
      }
      if (!oldestSlot) return -1;
      slot = oldestSlot;
      if (slot.currentKey) {
        this.arrayPoolByKey.delete(slot.currentKey);
      }
      slot.currentKey = key;
      slot.version = -1;
      this.arrayPoolByKey.set(key, slot);
    }

    slot.lastUsed = accessTick;
    slot.lastBatchTick = batchTick;

    if (slot.version !== tile.version || tile.dirty) {
      const rgbaData = grid.getTileAsRGBA(tile);
      const srcBytes =
        rgbaData instanceof Uint8Array
          ? rgbaData
          : new Uint8Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength);

      // Upload straight-alpha RGBA bytes directly into TEXTURE_2D_ARRAY slice
      // (UNPACK_PREMULTIPLY_ALPHA_WEBGL must be false for texSubImage3D with ArrayBufferView in WebGL2;
      // premultiplied bilinear filtering is performed in 32-bit float inside the fragment shader.)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        0,
        slot.sliceIndex,
        TILE_SIZE,
        TILE_SIZE,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        srcBytes
      );

      slot.version = tile.version;
      tile.dirty = false;
    }

    return slot.sliceIndex;
  }

  /**
   * Get or upload a WebGLTexture from the fallback TEXTURE_2D pool with adaptive zoom filtering.
   * Uses gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true) directly — zero CPU premultiply loop!
   */
  private getTileTexture(tile: TileBuffer, grid: SparseTileGrid): WebGLTexture | null {
    if (!this.gl) return null;
    const gl = this.gl;
    const gridId = typeof grid.getGridId === 'function' ? grid.getGridId() : 0;
    const key = `${gridId}:${getTileKey(tile.layerId, tile.tileX, tile.tileY, tile.lod ?? 0)}`;
    const accessTick = ++this.textureAccessCounter;

    let slot = this.activePoolByKey.get(key);

    if (!slot) {
      if (this.texturePool.length < ViewportCompositor.MAX_TEXTURE_POOL_SIZE) {
        const tex = gl.createTexture();
        if (!tex) return null;
        slot = {
          texture: tex,
          currentKey: key,
          version: -1,
          lastUsed: accessTick,
          filterTier: -1,
          hasStorage: false,
          hasMipmap: false,
        };
        this.texturePool.push(slot);
        this.activePoolByKey.set(key, slot);
      } else {
        // Reuse least recently used texture slot from pool
        let oldestSlot = this.texturePool[0];
        for (let i = 1; i < this.texturePool.length; i++) {
          if (this.texturePool[i].lastUsed < oldestSlot.lastUsed) {
            oldestSlot = this.texturePool[i];
          }
        }
        slot = oldestSlot;
        if (slot.currentKey) {
          this.activePoolByKey.delete(slot.currentKey);
        }
        slot.currentKey = key;
        slot.version = -1;
        slot.lastUsed = accessTick;
        slot.filterTier = -1;
        slot.hasMipmap = false;
        this.activePoolByKey.set(key, slot);
      }
    }

    slot.lastUsed = accessTick;
    const desiredTier = this.currentZoom < 0.99 ? 0 : this.currentZoom < 2.0 ? 1 : 2;

    // Re-upload if dirty or version bumped (direct GPU unpack premultiplication, zero JS pixel loop)
    if (slot.version !== tile.version || tile.dirty) {
      gl.bindTexture(gl.TEXTURE_2D, slot.texture);

      const rgbaData = grid.getTileAsRGBA(tile);
      const srcBytes =
        rgbaData instanceof Uint8Array
          ? rgbaData
          : new Uint8Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength);

      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      if (slot.hasStorage && typeof gl.texSubImage2D === 'function') {
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          0,
          0,
          TILE_SIZE,
          TILE_SIZE,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          srcBytes
        );
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          TILE_SIZE,
          TILE_SIZE,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          srcBytes
        );
        slot.hasStorage = true;
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

      slot.hasMipmap = false;
      slot.version = tile.version;
      slot.filterTier = -1; // Force filter parameter refresh
      tile.dirty = false;
    }

    if (slot.filterTier !== desiredTier) {
      gl.bindTexture(gl.TEXTURE_2D, slot.texture);
      if (desiredTier <= 1) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      }
      slot.filterTier = desiredTier;
    }

    return slot.texture;
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

  private renderArtboardBackground(
    gl: WebGL2RenderingContext,
    dimensions: CanvasDimensions,
    showCheckerboard: boolean
  ): void {
    if (!this.program || !this.stdLocs) return;
    this.unbindSceneTextureUnits(gl);
    this.restoreStandardProgram(gl);
    this.syncFrameUniforms(gl, this.stdLocs);
    gl.uniform1i(this.uTileTextureLoc, 0);
    gl.uniform1i(this.stdLocs.uMaskTexture, 1);
    gl.uniform1i(this.stdLocs.uBackdropTexture, 2);
    gl.uniform1i(this.stdLocs.uMaskEnabled, 0);
    gl.uniform1i(this.stdLocs.uHasBackdrop, 0);
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.uniform1i(this.uIsBackgroundLoc, 1);
    gl.uniform1i(this.stdLocs.uExpressionMode, 0);
    gl.uniform1i(this.uShowCheckerboardLoc, showCheckerboard ? 1 : 0);
    gl.uniform2f(this.uTileOriginLoc, 0, 0);
    gl.uniform2f(this.uTileSizeLoc, dimensions.width, dimensions.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.uniform1i(this.uIsBackgroundLoc, 0);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private renderOnionSkins(
    gl: WebGL2RenderingContext,
    layers: LayerItem[],
    onionSkinFrames: OnionSkinCompositorFrame[] | undefined,
    dimensions: CanvasDimensions,
    grid: SparseTileGrid,
    frustum: { minX: number; minY: number; maxX: number; maxY: number },
    target: PingPongTarget | null
  ): void {
    if (!onionSkinFrames || onionSkinFrames.length === 0) return;
    for (const onion of onionSkinFrames) {
      const targetLayer = layers.find((l) => l.id === onion.layerId);
      if (targetLayer && targetLayer.visible) {
        const virtualOnionLayer: LayerItem = {
          ...targetLayer,
          opacity: onion.opacity,
          layerColorEnabled: true,
          layerColor: onion.tint,
          layerSubColor: '#ffffff',
          blendMode: 'normal',
        };
        this.renderSingleLayer(gl, virtualOnionLayer, dimensions, grid, frustum, 1.0, target, false);
      }
    }
  }

  private presentTextureToScreen(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    viewportW: number,
    viewportH: number,
    softProof?: SoftProofSettings
  ): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, viewportW, viewportH);
    gl.disable(gl.STENCIL_TEST);

    if (softProof && (softProof.enabled || softProof.gamutWarning) && this.softProofProgram) {
      this.applySoftProofPass(gl, viewportW, viewportH, softProof, texture);
      return;
    }

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (!this.blitProgram) return;
    gl.disable(gl.BLEND);
    gl.useProgram(this.blitProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stylesQuadBuffer || this.quadBuffer);
    if (this.aBlitQuadPosLoc >= 0) {
      gl.enableVertexAttribArray(this.aBlitQuadPosLoc);
      gl.vertexAttribPointer(this.aBlitQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.uBlitTextureLoc, 0);
    gl.uniform1i(this.uBlitBackdropTextureLoc, 2);
    gl.uniform1i(this.uBlitHasBackdropLoc, 0);
    gl.uniform1i(this.uBlitBlendModeLoc, 0);
    gl.uniform1f(this.uBlitOpacityLoc, 1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.unbindSceneTextureUnits(gl);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.restoreStandardProgram(gl);
  }

  /**
   * Main Render Pass: Composite all visible layers onto the viewport canvas using:
   * 1. Ping-Pong FBOs (zero gl.copyTexSubImage2D calls for all 16 blend modes, adjustments, & soft proof)
   * 2. Baked Layer Stack Cache (`belowActiveCacheFbo` + `activeUnit` + `aboveActiveCacheFbo`)
   * 3. TEXTURE_2D_ARRAY + gl.drawArraysInstanced tile batching
   */
  private lastRenderedGrid: SparseTileGrid | null = null;

  public render(
    layers: LayerItem[],
    transform: ViewportTransform,
    dimensions: CanvasDimensions,
    grid: SparseTileGrid = globalTileGrid,
    _options: CompositorOptions = { dimensions }
  ): void {
    this.lastRenderedGrid = grid;
    const gl = this.gl;
    this.currentOptions = _options;
    this.currentZoom = transform.zoom;

    if (!gl || !this.program || !this.stdLocs) {
      this.render2DFallback(layers, transform, dimensions, grid, _options);
      return;
    }

    const viewportW = Math.max(1, this.canvas.width);
    const viewportH = Math.max(1, this.canvas.height);
    const dpr = _options.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ?? 1;
    const rotRad = (transform.rotation * Math.PI) / 180;

    this.currentFrameState = {
      viewportW,
      viewportH,
      dpr,
      dimensions,
      transform,
      rotRad,
    };

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

    // Dynamic Frustum Culling & Memory Budget Sync
    const activeLayerId = _options.activeLayerId ?? _options.activeDraftLayerId ?? null;
    const layerVis = new Map<string, boolean>();
    for (const l of layers) {
      layerVis.set(l.id, l.visible);
    }
    grid.getMemoryManager()?.updateViewport(frustum, activeLayerId, layerVis);

    // Ensure Ping-Pong Scene FBOs & Baked Layer Stack Cache FBOs
    const scenePP = this.ensurePingPongTarget(gl, this.scenePingPong, viewportW, viewportH);
    this.scenePingPong = scenePP;

    let belowCacheReady = false;
    let aboveCacheReady = false;
    if (scenePP) {
      if (!this.belowActiveCacheFbo) {
        this.belowActiveCacheFbo = this.createFboSurface(gl, false);
      }
      if (this.belowActiveCacheFbo) {
        belowCacheReady = this.ensureFboSurfaceSize(gl, this.belowActiveCacheFbo, viewportW, viewportH);
      }
      if (!this.aboveActiveCacheFbo) {
        this.aboveActiveCacheFbo = this.createFboSurface(gl, false);
      }
      if (this.aboveActiveCacheFbo) {
        aboveCacheReady = this.ensureFboSurfaceSize(gl, this.aboveActiveCacheFbo, viewportW, viewportH);
      }
    }

    if (scenePP && belowCacheReady && aboveCacheReady && this.belowActiveCacheFbo && this.aboveActiveCacheFbo) {
      // Evaluate Baked Layer Stack Cache invalidation (below / active / above)
      const cacheEval = this.stackCache.evaluate({
        layers,
        activeLayerId,
        viewportW,
        viewportH,
        dpr,
        dimensions,
        transform,
        showCheckerboard: Boolean(_options.showCheckerboard),
        onionSkinFrames: _options.onionSkinFrames,
        getLayerContentVersion: (id) =>
          typeof grid.getLayerVersion === 'function' ? grid.getLayerVersion(id) : 0,
        getMaskInvalidationEpoch: (id) => this.maskInvalidationEpochs.get(id) ?? 0,
        gridEpoch: typeof grid.getGridEpoch === 'function' ? grid.getGridEpoch() : 0,
        gridId: typeof grid.getGridId === 'function' ? grid.getGridId() : 0,
      });

      const { partition } = cacheEval;
      this.restoreStandardProgram(gl);
      this.syncFrameUniforms(gl, this.stdLocs);
      gl.uniform1i(this.uTileTextureLoc, 0);
      gl.uniform1i(this.stdLocs.uHasBackdrop, 0);

      // Step 1: Rebuild aboveActiveCacheFbo ONLY when upper slice metadata/content/camera changed
      if (cacheEval.aboveDirty && partition.aboveCachedUnits.length > 0) {
        scenePP.activeIndex = 0;
        const surf = scenePP.surfaces[0];
        gl.bindFramebuffer(gl.FRAMEBUFFER, surf.fbo);
        gl.viewport(0, 0, viewportW, viewportH);
        gl.disable(gl.STENCIL_TEST);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

        const overrideRootBlend = partition.aboveStrategy === 'baked-single-blend';
        for (const unit of partition.aboveCachedUnits) {
          this.renderCompositingUnit(
            gl,
            unit,
            dimensions,
            grid,
            frustum,
            viewportW,
            viewportH,
            transform,
            dpr,
            scenePP,
            0,
            overrideRootBlend
          );
        }

        this.copyFboSurface(
          gl,
          scenePP.surfaces[scenePP.activeIndex],
          this.aboveActiveCacheFbo,
          viewportW,
          viewportH,
          false
        );
        this.stackCacheStats.aboveRebuilds++;
      }

      // Step 2: Populate scenePP with below slice (either rebuild belowActiveCacheFbo or fast GPU blit)
      if (cacheEval.belowDirty) {
        scenePP.activeIndex = 0;
        const surf = scenePP.surfaces[0];
        gl.bindFramebuffer(gl.FRAMEBUFFER, surf.fbo);
        gl.viewport(0, 0, viewportW, viewportH);
        gl.disable(gl.STENCIL_TEST);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

        this.renderArtboardBackground(gl, dimensions, Boolean(_options.showCheckerboard));
        this.renderOnionSkins(gl, layers, _options.onionSkinFrames, dimensions, grid, frustum, scenePP);

        for (const unit of partition.belowUnits) {
          this.renderCompositingUnit(
            gl,
            unit,
            dimensions,
            grid,
            frustum,
            viewportW,
            viewportH,
            transform,
            dpr,
            scenePP,
            0,
            false
          );
        }

        this.copyFboSurface(
          gl,
          scenePP.surfaces[scenePP.activeIndex],
          this.belowActiveCacheFbo,
          viewportW,
          viewportH,
          false
        );
        // Ensure scenePP's current surface remains bound for activeUnit
        gl.bindFramebuffer(gl.FRAMEBUFFER, scenePP.surfaces[scenePP.activeIndex].fbo);
        gl.viewport(0, 0, viewportW, viewportH);
        this.stackCacheStats.belowRebuilds++;
      } else {
        scenePP.activeIndex = 0;
        this.copyFboSurface(
          gl,
          this.belowActiveCacheFbo,
          scenePP.surfaces[0],
          viewportW,
          viewportH,
          false
        );
        if (!cacheEval.aboveDirty) {
          this.stackCacheStats.cacheHits++;
        }
      }

      // Step 3: Render active unit (+ live activeDraftCanvas in-stack!)
      if (partition.activeUnit) {
        this.renderCompositingUnit(
          gl,
          partition.activeUnit,
          dimensions,
          grid,
          frustum,
          viewportW,
          viewportH,
          transform,
          dpr,
          scenePP,
          0,
          false
        );
      }

      // Step 4: Render any dynamic non-associative upper units (via Ping-Pong FBOs, zero copyTexSubImage2D)
      for (const unit of partition.aboveDynamicUnits) {
        this.renderCompositingUnit(
          gl,
          unit,
          dimensions,
          grid,
          frustum,
          viewportW,
          viewportH,
          transform,
          dpr,
          scenePP,
          0,
          false
        );
      }

      // Step 5: Composite baked aboveActiveCacheFbo (1 single quad / 1 ping-pong blend pass)
      if (partition.aboveCachedUnits.length > 0) {
        const aboveBlend: BlendMode =
          partition.aboveStrategy === 'baked-single-blend'
            ? partition.aboveCacheBlendMode
            : 'normal';
        this.blitFolderTexture(
          gl,
          this.aboveActiveCacheFbo.texture,
          aboveBlend,
          1.0,
          viewportW,
          viewportH,
          scenePP,
          false
        );
      }

      this.stackCache.commit(cacheEval.belowSignature, cacheEval.aboveSignature);

      // Step 6: Present final composited Ping-Pong surface to screen (with optional CMYK soft proofing)
      this.presentTextureToScreen(
        gl,
        scenePP.surfaces[scenePP.activeIndex].texture,
        viewportW,
        viewportH,
        _options.softProof
      );
    } else {
      // Safe fallback when offscreen FBOs are unsupported in a minimal WebGL context
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, viewportW, viewportH);
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

      this.renderArtboardBackground(gl, dimensions, Boolean(_options.showCheckerboard));
      this.renderOnionSkins(gl, layers, _options.onionSkinFrames, dimensions, grid, frustum, null);

      const tree = buildLayerTree(layers);
      this.renderNodeList(
        gl,
        tree,
        dimensions,
        grid,
        frustum,
        viewportW,
        viewportH,
        transform,
        dpr,
        null,
        0,
        1.0
      );
    }

    // Prune mask textures belonging to deleted layers
    if (this.maskTextureCache.size > layers.length) {
      for (const cachedLayerId of Array.from(this.maskTextureCache.keys())) {
        if (!layerVis.has(cachedLayerId)) {
          const entry = this.maskTextureCache.get(cachedLayerId);
          if (entry) gl.deleteTexture(entry.texture);
          this.maskTextureCache.delete(cachedLayerId);
          this.maskInvalidationEpochs.delete(cachedLayerId);
        }
      }
    }

    // Clean up stale textures if fallback pool exceeded limit
    if (this.texturePool.length > ViewportCompositor.MAX_TEXTURE_POOL_SIZE) {
      this.evictStaleTextures();
    }
  }

  /**
   * Renders a single atomic CompositingUnit (an isolated folder, adjustment layer, or base + clipped group)
   * into the active Ping-Pong target.
   */
  private renderCompositingUnit(
    gl: WebGL2RenderingContext,
    unit: CompositingUnit,
    dimensions: CanvasDimensions,
    grid: SparseTileGrid,
    frustum: { minX: number; minY: number; maxX: number; maxY: number },
    viewportW: number,
    viewportH: number,
    transform: ViewportTransform,
    dpr: number,
    target: PingPongTarget | null,
    depth: number,
    overrideRootBlendNormal: boolean
  ): void {
    const group = unit.group;
    const baseNode = group.baseNode;
    const baseLayer = overrideRootBlendNormal
      ? { ...baseNode.layer, blendMode: 'normal' as BlendMode }
      : baseNode.layer;

    if (!baseLayer.visible || baseLayer.opacity <= 0.001) {
      return;
    }

    if (baseLayer.type === 'folder') {
      const folderTarget = this.ensureFolderPingPong(gl, depth, viewportW, viewportH);
      if (!folderTarget) return;

      folderTarget.activeIndex = 0;
      const folderSurf = folderTarget.surfaces[0];
      gl.bindFramebuffer(gl.FRAMEBUFFER, folderSurf.fbo);
      gl.viewport(0, 0, viewportW, viewportH);
      gl.disable(gl.STENCIL_TEST);
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

      this.renderNodeList(
        gl,
        baseNode.children,
        dimensions,
        grid,
        frustum,
        viewportW,
        viewportH,
        transform,
        dpr,
        folderTarget,
        depth + 1,
        1.0
      );

      // Restore parent target framebuffer and blit isolated folder result
      const parentFbo = target ? target.surfaces[target.activeIndex].fbo : null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, parentFbo);
      gl.viewport(0, 0, viewportW, viewportH);

      this.blitFolderTexture(
        gl,
        folderTarget.surfaces[folderTarget.activeIndex].texture,
        baseLayer.blendMode,
        baseLayer.opacity * unit.inheritedOpacity,
        viewportW,
        viewportH,
        target,
        false
      );
      return;
    }

    const activeClippedLayers = group.clippedNodes
      .map((n) => n.layer)
      .filter((cl) => cl.visible && cl.opacity > 0.001 && cl.type !== 'folder');

    const baseEffectiveOpacity = unit.inheritedOpacity;

    if (baseLayer.type === 'adjustment' && baseLayer.adjustmentData) {
      this.renderAdjustmentLayer(
        gl,
        baseLayer,
        transform,
        dimensions,
        viewportW,
        viewportH,
        dpr,
        baseEffectiveOpacity,
        target,
        false
      );
      return;
    }

    const baseHasStyles = hasActiveLayerStyles(baseLayer.styles);

    if (activeClippedLayers.length > 0) {
      // Record base layer silhouette in stencil buffer of the current Ping-Pong surface
      gl.enable(gl.STENCIL_TEST);
      gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.stencilMask(0xFF);
      gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);

      if (baseHasStyles) {
        // Record base layer silhouette in stencil without writing colors
        gl.colorMask(false, false, false, false);
        this.renderSingleLayer(
          gl,
          { ...baseLayer, blendMode: 'normal' },
          dimensions,
          grid,
          frustum,
          baseEffectiveOpacity,
          target,
          true
        );
        gl.colorMask(true, true, true, true);

        // Draw base layer with styles (do not overwrite stencil with shadow/glow)
        gl.stencilMask(0x00);
        this.renderLayerWithStyles(
          gl,
          baseLayer,
          dimensions,
          grid,
          frustum,
          viewportW,
          viewportH,
          transform,
          dpr,
          baseEffectiveOpacity,
          target,
          true
        );
        gl.stencilMask(0xFF);
      } else {
        this.renderSingleLayer(
          gl,
          baseLayer,
          dimensions,
          grid,
          frustum,
          baseEffectiveOpacity,
          target,
          true
        );
      }

      // Render clipped layers: only draw over opaque pixels of base layer (stencil == 1)
      gl.stencilMask(0x00);
      gl.stencilFunc(gl.EQUAL, 1, 0xFF);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);

      for (const clippedLayer of activeClippedLayers) {
        if (hasActiveLayerStyles(clippedLayer.styles)) {
          this.renderLayerWithStyles(
            gl,
            clippedLayer,
            dimensions,
            grid,
            frustum,
            viewportW,
            viewportH,
            transform,
            dpr,
            baseEffectiveOpacity,
            target,
            true
          );
        } else {
          this.renderSingleLayer(
            gl,
            clippedLayer,
            dimensions,
            grid,
            frustum,
            baseEffectiveOpacity,
            target,
            true
          );
        }
      }

      gl.stencilMask(0xFF);
      gl.disable(gl.STENCIL_TEST);
    } else {
      gl.disable(gl.STENCIL_TEST);
      if (baseHasStyles) {
        this.renderLayerWithStyles(
          gl,
          baseLayer,
          dimensions,
          grid,
          frustum,
          viewportW,
          viewportH,
          transform,
          dpr,
          baseEffectiveOpacity,
          target,
          false
        );
      } else {
        this.renderSingleLayer(
          gl,
          baseLayer,
          dimensions,
          grid,
          frustum,
          baseEffectiveOpacity,
          target,
          false
        );
      }
    }
  }

  /**
   * Recursively composite a layer hierarchy, supporting folder pass-through and isolated offscreen rendering.
   */
  private renderNodeList(
    gl: WebGL2RenderingContext,
    nodes: LayerTreeNode[],
    dimensions: CanvasDimensions,
    grid: SparseTileGrid,
    frustum: { minX: number; minY: number; maxX: number; maxY: number },
    viewportW: number,
    viewportH: number,
    transform: ViewportTransform,
    dpr: number,
    target: PingPongTarget | null,
    depth: number,
    inheritedOpacity: number
  ): void {
    const units = flattenLayerTreeToUnits(nodes, inheritedOpacity);
    for (const unit of units) {
      this.renderCompositingUnit(
        gl,
        unit,
        dimensions,
        grid,
        frustum,
        viewportW,
        viewportH,
        transform,
        dpr,
        target,
        depth,
        false
      );
    }
  }

  /**
   * Get or upload a WebGLTexture for a layer's mask canvas with dirty-version caching.
   */
  private getMaskTexture(layer: LayerItem): WebGLTexture | null {
    if (!this.gl || !layer.maskCanvas) return null;
    const gl = this.gl;
    let cached = this.maskTextureCache.get(layer.id);
    const currentVersion = layer.maskVersion ?? 0;
    const maskW = layer.maskCanvas.width;
    const maskH = layer.maskCanvas.height;

    if (!cached) {
      const tex = gl.createTexture();
      if (!tex) return null;
      cached = { texture: tex, version: -1, width: 0, height: 0 };
      this.maskTextureCache.set(layer.id, cached);
    }

    if (cached.version !== currentVersion || cached.width !== maskW || cached.height !== maskH) {
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

      cached.version = currentVersion;
      cached.width = maskW;
      cached.height = maskH;
    }

    return cached.texture;
  }

  /**
   * Evaluates non-destructive adjustment layers via Ping-Pong FBO backdrop and version-cached LUT evaluation.
   */
  private renderAdjustmentLayer(
    gl: WebGL2RenderingContext,
    layer: LayerItem,
    transform: ViewportTransform,
    dimensions: CanvasDimensions,
    viewportW: number,
    viewportH: number,
    dpr: number,
    opacityMultiplier: number = 1.0,
    target: PingPongTarget | null = null,
    preserveStencil: boolean = false
  ): void {
    if (!this.adjProgram || !layer.adjustmentData || !target) return;

    // 1. Ping-Pong swap to sample accumulated backdrop texture without copyTexSubImage2D
    const backdropTex = this.prepareBackdropFromPingPong(gl, target, viewportW, viewportH, preserveStencil);

    // 2. Prepare 256x1 LUT (Cached by AdjustmentLayerData signature)
    if (!this.lutTexture) {
      this.lutTexture = gl.createTexture();
      this.lastLutKey = '';
    }
    const adj = layer.adjustmentData;
    const lutKey = JSON.stringify(adj);

    if (lutKey !== this.lastLutKey) {
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
        const ch = adj.channel || 'rgb';
        lutData = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
          const off = i * 4;
          lutData[off] = ch === 'rgb' || ch === 'r' ? lLut[i] : i;
          lutData[off + 1] = ch === 'rgb' || ch === 'g' ? lLut[i] : i;
          lutData[off + 2] = ch === 'rgb' || ch === 'b' ? lLut[i] : i;
          lutData[off + 3] = 255;
        }
      } else {
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
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutData);

      this.lastLutKey = lutKey;
      this.lastLutAdjMode = adjMode;
    }

    // 3. Switch to Adjustment Program
    gl.useProgram(this.adjProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    if (this.aQuadPosLoc >= 0) {
      gl.enableVertexAttribArray(this.aQuadPosLoc);
      gl.vertexAttribPointer(this.aQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
    }

    gl.uniform2f(this.uAdjViewportSizeLoc, viewportW, viewportH);
    gl.uniform2f(this.uAdjDocDimensionsLoc, dimensions.width, dimensions.height);
    gl.uniform2f(this.uAdjPanLoc, transform.pan.x, transform.pan.y);
    gl.uniform1f(this.uAdjZoomLoc, transform.zoom);
    const rotRad = (transform.rotation * Math.PI) / 180;
    gl.uniform1f(this.uAdjRotationRadLoc, rotRad);
    gl.uniform2f(this.uAdjFlipLoc, transform.flipX ? -1.0 : 1.0, transform.flipY ? -1.0 : 1.0);
    gl.uniform1f(this.uAdjDprLoc, dpr);

    gl.uniform2f(this.uAdjTileOriginLoc, 0, 0);
    gl.uniform2f(this.uAdjTileSizeLoc, dimensions.width, dimensions.height);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, backdropTex);
    gl.uniform1i(this.uAdjSnapshotLoc, 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.uniform1i(this.uAdjLutLoc, 3);

    gl.uniform1i(this.uAdjModeLoc, this.lastLutAdjMode);
    gl.uniform1f(this.uAdjOpacityLoc, layer.opacity * opacityMultiplier);

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

    // Overwrite document region with filtered result
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Revert program, unbind backdrop texture to avoid feedback loops, and restore blend func
    this.unbindSceneTextureUnits(gl);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.restoreStandardProgram(gl);
  }

  /**
   * Renders all visible tiles of a single layer onto WebGL2 context using:
   * - TEXTURE_2D_ARRAY + gl.drawArraysInstanced batching when all visible tiles fit in the pool
   * - Safe per-tile TEXTURE_2D fallback on pool overflow
   * - Ping-Pong FBO backdrop sampling for custom blend modes (zero gl.copyTexSubImage2D)
   * - In-stack WYSIWYG live draft stroke compositing
   */
  private renderSingleLayer(
    gl: WebGL2RenderingContext,
    layer: LayerItem,
    dimensions: CanvasDimensions,
    grid: SparseTileGrid,
    frustum: { minX: number; minY: number; maxX: number; maxY: number },
    opacityMultiplier: number = 1.0,
    target: PingPongTarget | null = null,
    preserveStencil: boolean = false
  ): void {
    if (!this.stdLocs) return;

    // Adaptive LOD Selection & Frustum Culling
    const targetLod =
      this.currentZoom <= 0.125 ? 3 :
      this.currentZoom <= 0.25 ? 2 :
      this.currentZoom <= 0.5 ? 1 : 0;

    const lodScale = 1 << targetLod;
    const lodTileDocSize = TILE_SIZE * lodScale;

    const startTileX = Math.floor(frustum.minX / lodTileDocSize);
    const endTileX = Math.floor(frustum.maxX / lodTileDocSize);
    const startTileY = Math.floor(frustum.minY / lodTileDocSize);
    const endTileY = Math.floor(frustum.maxY / lodTileDocSize);

    const visibleTiles: TileBuffer[] = [];
    for (let ty = startTileY; ty <= endTileY; ty++) {
      for (let tx = startTileX; tx <= endTileX; tx++) {
        let tile = grid.getTile(layer.id, tx, ty, targetLod);
        if (targetLod > 0 && (!tile || grid.isLodTileDirty(layer.id, tx, ty, targetLod))) {
          tile = grid.generateLodTile(layer.id, tx, ty, targetLod);
        }
        if (tile) {
          visibleTiles.push(tile);
        }
      }
    }

    const opts = this.currentOptions;
    const draftCanvas = opts?.activeDraftLayerId === layer.id ? opts.activeDraftCanvas : null;
    const hasDraft = Boolean(
      draftCanvas &&
      draftCanvas.width > 0 &&
      draftCanvas.height > 0 &&
      (draftCanvas as any).__draftHasContent !== false
    );
    const draftOp = hasDraft && draftCanvas
      ? ((draftCanvas as any).__draftCompositeOp as GlobalCompositeOperation | undefined)
      : undefined;
    const needsIsolatedDraftFbo =
      hasDraft &&
      draftCanvas !== null &&
      (draftOp === 'destination-out' || draftOp === 'source-atop');

    if (visibleTiles.length === 0 && !hasDraft) {
      return;
    }

    const fs = this.currentFrameState;
    const hasMask = Boolean(layer.maskCanvas && layer.maskEnabled !== false);
    const maskTex = hasMask && layer.maskCanvas ? this.getMaskTexture(layer) : null;
    const effectiveOpacity = layer.opacity * opacityMultiplier;

    // Isolated GPU FBO path for WYSIWYG live Eraser (destination-out) and Alpha Lock (source-atop)
    // Erases/paints strictly against this layer's tiles without affecting underlying layers and with zero getImageData!
    if (
      needsIsolatedDraftFbo &&
      draftCanvas &&
      target &&
      fs &&
      fs.viewportW > 0 &&
      fs.viewportH > 0 &&
      this.ensureLayerFbo(fs.viewportW, fs.viewportH) &&
      this.layerFbo &&
      this.layerTexture &&
      this.blitProgram
    ) {
      const stencilWasEnabled = gl.isEnabled(gl.STENCIL_TEST);
      if (stencilWasEnabled) gl.disable(gl.STENCIL_TEST);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
      gl.viewport(0, 0, fs.viewportW, fs.viewportH);
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      if (visibleTiles.length > 0) {
        this.drawTilesFallback2D(
          gl,
          visibleTiles,
          grid,
          layer,
          dimensions,
          lodTileDocSize,
          1.0,
          0,
          null,
          maskTex
        );
      }

      if (draftOp === 'destination-out') {
        gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      } else {
        gl.blendFunc(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }

      this.renderActiveDraftForLayer(
        gl,
        draftCanvas,
        layer,
        dimensions,
        opts?.activeDraftOpacity ?? 1.0,
        0,
        null,
        maskTex,
        opts?.activeDraftVersion,
        opts?.activeDraftSpace ?? 'document'
      );

      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.surfaces[target.activeIndex].fbo);
      gl.viewport(0, 0, fs.viewportW, fs.viewportH);
      if (stencilWasEnabled) gl.enable(gl.STENCIL_TEST);

      this.blitFolderTexture(
        gl,
        this.layerTexture,
        layer.blendMode,
        effectiveOpacity,
        fs.viewportW,
        fs.viewportH,
        target,
        preserveStencil
      );

      if (this.stdLocs) {
        if (maskTex) {
          gl.uniform1i(this.stdLocs.uMaskEnabled, 0);
        }
        gl.uniform1i(this.stdLocs.uHasBackdrop, 0);
      }
      this.unbindSceneTextureUnits(gl);
      return;
    }

    // Prepare Ping-Pong backdrop if custom blend mode is active (zero copyTexSubImage2D)
    const modeCode = BLEND_MODE_MAP[layer.blendMode] ?? 0;
    let backdropTex: WebGLTexture | null = null;
    if (modeCode !== 0 && modeCode !== 12 && target && fs && fs.viewportW > 0 && fs.viewportH > 0) {
      backdropTex = this.prepareBackdropFromPingPong(
        gl,
        target,
        fs.viewportW,
        fs.viewportH,
        preserveStencil
      );
    }

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Batched TEXTURE_2D_ARRAY + gl.drawArraysInstanced fast path when all visible tiles fit in pool
    const canBatch =
      visibleTiles.length > 0 &&
      this.instancedProgram !== null &&
      this.instancedLocs !== null &&
      this.tileArrayTexture !== null &&
      this.instanceBuffer !== null &&
      visibleTiles.length <= this.arrayPoolCapacity;

    if (canBatch && this.instancedProgram && this.instancedLocs && this.tileArrayTexture && this.instanceBuffer) {
      const batchTick = ++this.arrayBatchCounter;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tileArrayTexture);

      // Adaptive filter mode for the entire array texture
      const desiredTier = this.currentZoom < 0.99 ? 0 : this.currentZoom < 2.0 ? 1 : 2;
      if (this.arrayPoolFilterTier !== desiredTier) {
        const filter = desiredTier <= 1 ? gl.LINEAR : gl.NEAREST;
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
        this.arrayPoolFilterTier = desiredTier;
      }

      let instanceCount = 0;
      let overflowed = false;
      for (let i = 0; i < visibleTiles.length; i++) {
        const tile = visibleTiles[i];
        const sliceIdx = this.getOrUploadArrayTileSlice(gl, tile, grid, batchTick);
        if (sliceIdx < 0) {
          overflowed = true;
          break;
        }
        const off = instanceCount * 3;
        this.instanceFloatScratch[off] = tile.tileX * lodTileDocSize;
        this.instanceFloatScratch[off + 1] = tile.tileY * lodTileDocSize;
        this.instanceFloatScratch[off + 2] = sliceIdx;
        instanceCount++;
      }

      if (!overflowed && instanceCount > 0) {
        gl.useProgram(this.instancedProgram);
        this.syncFrameUniforms(gl, this.instancedLocs);
        gl.uniform2f(this.uInstTileSizeLoc, lodTileDocSize, lodTileDocSize);
        gl.uniform1i(this.uInstTileArrayLoc, 0);
        this.applyLayerUniforms(
          gl,
          this.instancedLocs,
          layer,
          dimensions,
          effectiveOpacity,
          modeCode,
          backdropTex,
          maskTex
        );

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tileArrayTexture);

        if (this.instancedVao) {
          gl.bindVertexArray(this.instancedVao);
        } else {
          gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
          if (this.aInstQuadPosLoc >= 0) {
            gl.enableVertexAttribArray(this.aInstQuadPosLoc);
            gl.vertexAttribPointer(this.aInstQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(this.aInstQuadPosLoc, 0);
          }
          gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
          if (this.aInstDataLoc >= 0) {
            gl.enableVertexAttribArray(this.aInstDataLoc);
            gl.vertexAttribPointer(this.aInstDataLoc, 3, gl.FLOAT, false, 0, 0);
            gl.vertexAttribDivisor(this.aInstDataLoc, 1);
          }
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceFloatScratch.subarray(0, instanceCount * 3));
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount);

        if (this.instancedVao) {
          gl.bindVertexArray(null);
        } else if (this.aInstDataLoc >= 0) {
          gl.vertexAttribDivisor(this.aInstDataLoc, 0);
          gl.disableVertexAttribArray(this.aInstDataLoc);
        }
        this.restoreStandardProgram(gl);
      } else if (overflowed) {
        this.drawTilesFallback2D(
          gl,
          visibleTiles,
          grid,
          layer,
          dimensions,
          lodTileDocSize,
          effectiveOpacity,
          modeCode,
          backdropTex,
          maskTex
        );
      }
    } else if (visibleTiles.length > 0) {
      // Safe fallback to per-tile TEXTURE_2D pool on overflow or missing WebGL2 array APIs
      this.drawTilesFallback2D(
        gl,
        visibleTiles,
        grid,
        layer,
        dimensions,
        lodTileDocSize,
        effectiveOpacity,
        modeCode,
        backdropTex,
        maskTex
      );
    }

    // WYSIWYG In-Stack Live Stroke Compositing
    if (hasDraft && draftCanvas) {
      if (draftOp === 'destination-out') {
        gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      } else if (draftOp === 'source-atop') {
        gl.blendFunc(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      this.renderActiveDraftForLayer(
        gl,
        draftCanvas,
        layer,
        dimensions,
        effectiveOpacity * (opts?.activeDraftOpacity ?? 1.0),
        modeCode,
        backdropTex,
        maskTex,
        opts?.activeDraftVersion,
        opts?.activeDraftSpace ?? 'document'
      );
      if (draftOp === 'destination-out' || draftOp === 'source-atop') {
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
    }

    if (this.stdLocs) {
      if (maskTex) {
        gl.uniform1i(this.stdLocs.uMaskEnabled, 0);
      }
      gl.uniform1i(this.stdLocs.uHasBackdrop, 0);
    }
    this.unbindSceneTextureUnits(gl);
  }

  /**
   * Fallback per-tile TEXTURE_2D draw loop when visible tile count exceeds TEXTURE_2D_ARRAY pool capacity.
   */
  private drawTilesFallback2D(
    gl: WebGL2RenderingContext,
    visibleTiles: TileBuffer[],
    grid: SparseTileGrid,
    layer: LayerItem,
    dimensions: CanvasDimensions,
    lodTileDocSize: number,
    effectiveOpacity: number,
    modeCode: number,
    backdropTex: WebGLTexture | null,
    maskTex: WebGLTexture | null
  ): void {
    if (!this.stdLocs) return;
    this.restoreStandardProgram(gl);
    this.syncFrameUniforms(gl, this.stdLocs);
    gl.uniform1i(this.uTileTextureLoc, 0);
    gl.uniform1i(this.uIsBackgroundLoc, 0);
    this.applyLayerUniforms(
      gl,
      this.stdLocs,
      layer,
      dimensions,
      effectiveOpacity,
      modeCode,
      backdropTex,
      maskTex
    );
    gl.uniform2f(this.uTileSizeLoc, lodTileDocSize, lodTileDocSize);

    for (const tile of visibleTiles) {
      const tex = this.getTileTexture(tile, grid);
      if (!tex) continue;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform2f(this.uTileOriginLoc, tile.tileX * lodTileDocSize, tile.tileY * lodTileDocSize);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  /**
   * Uploads and renders the active draft canvas in-stack for the active layer.
   * Supports both viewport-space overlays (from CanvasArea) and document-space draft canvases.
   */
  private renderActiveDraftForLayer(
    gl: WebGL2RenderingContext,
    draftCanvas: HTMLCanvasElement,
    layer: LayerItem,
    dimensions: CanvasDimensions,
    effectiveOpacity: number,
    modeCode: number,
    backdropTex: WebGLTexture | null,
    maskTex: WebGLTexture | null,
    draftVersion?: number,
    draftSpace: 'document' | 'viewport' = 'document'
  ): void {
    if (draftCanvas.width <= 0 || draftCanvas.height <= 0) return;
    if ((draftCanvas as any).__draftHasContent === false) return;
    if (!this.draftTexture) {
      this.draftTexture = gl.createTexture();
    }
    if (!this.draftTexture) return;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.draftTexture);

    const ver = draftVersion ?? -1;
    const hasGenerateMipmap = typeof gl.generateMipmap === 'function';
    if (
      ver === -1 ||
      ver !== this.lastDraftVersion ||
      this.draftTexWidth !== draftCanvas.width ||
      this.draftTexHeight !== draftCanvas.height
    ) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        hasGenerateMipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR
      );
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, draftCanvas);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (hasGenerateMipmap) {
        gl.generateMipmap(gl.TEXTURE_2D);
      }
      this.draftTexWidth = draftCanvas.width;
      this.draftTexHeight = draftCanvas.height;
      this.lastDraftVersion = ver;
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.currentZoom >= 2.0 ? gl.NEAREST : gl.LINEAR);

    const effectiveDraftLayer: LayerItem =
      this.currentOptions?.activeDraftMonochrome && layer.expressionColor !== 'monochrome'
        ? { ...layer, expressionColor: 'monochrome' }
        : layer;

    if (draftSpace === 'viewport' && this.viewportDraftProgram && this.viewportDraftLocs) {
      gl.useProgram(this.viewportDraftProgram);
      this.syncFrameUniforms(gl, this.viewportDraftLocs);
      gl.uniform1i(this.uViewportDraftTileTexLoc, 0);
      gl.uniform1i(this.uViewportDraftIsBgLoc, 0);
      this.applyLayerUniforms(
        gl,
        this.viewportDraftLocs,
        effectiveDraftLayer,
        dimensions,
        effectiveOpacity,
        modeCode,
        backdropTex,
        maskTex
      );
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      if (this.aViewportDraftQuadPosLoc >= 0) {
        gl.enableVertexAttribArray(this.aViewportDraftQuadPosLoc);
        gl.vertexAttribPointer(this.aViewportDraftQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.draftTexture);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.restoreStandardProgram(gl);
    } else if (this.stdLocs) {
      const docRect = this.currentOptions?.activeDraftDirtyRect;
      const originX = docRect ? docRect.x : 0;
      const originY = docRect ? docRect.y : 0;
      const spanW = docRect ? docRect.width : dimensions.width;
      const spanH = docRect ? docRect.height : dimensions.height;

      this.restoreStandardProgram(gl);
      this.syncFrameUniforms(gl, this.stdLocs);
      gl.uniform1i(this.uTileTextureLoc, 0);
      gl.uniform1i(this.uIsBackgroundLoc, 0);
      this.applyLayerUniforms(
        gl,
        this.stdLocs,
        effectiveDraftLayer,
        dimensions,
        effectiveOpacity,
        modeCode,
        backdropTex,
        maskTex
      );
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.draftTexture);
      gl.uniform2f(this.uTileOriginLoc, originX, originY);
      gl.uniform2f(this.uTileSizeLoc, spanW, spanH);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.uniform2f(this.uTileSizeLoc, TILE_SIZE, TILE_SIZE);
    }
  }

  /**
   * Ensures an offscreen framebuffer and texture exist for isolated layer style rendering.
   */
  private ensureLayerFbo(width: number, height: number): boolean {
    if (!this.gl) return false;
    const gl = this.gl;

    if (this.layerFbo && this.layerTexture && this.layerFboWidth === width && this.layerFboHeight === height) {
      return true;
    }

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

    if (!this.layerFbo) {
      this.layerFbo = gl.createFramebuffer();
    }
    if (!this.layerTexture) {
      this.layerTexture = gl.createTexture();
    }

    this.layerFboWidth = width;
    this.layerFboHeight = height;

    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.layerTexture, 0);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('Layer FBO incomplete:', status);
      return false;
    }

    return true;
  }

  /**
   * Blits an isolated folder or baked cache texture onto the active Ping-Pong target
   * with full programmable blend mode support and zero gl.copyTexSubImage2D calls.
   */
  private blitFolderTexture(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    blendMode: BlendMode,
    opacity: number,
    viewportW: number,
    viewportH: number,
    target: PingPongTarget | null = null,
    preserveStencil: boolean = false
  ): void {
    if (!this.blitProgram) return;

    const modeCode = BLEND_MODE_MAP[blendMode] ?? 0;
    let hasBackdrop = 0;
    if (modeCode !== 0 && modeCode !== 12 && target && viewportW > 0 && viewportH > 0) {
      const backdropTex = this.prepareBackdropFromPingPong(
        gl,
        target,
        viewportW,
        viewportH,
        preserveStencil
      );
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, backdropTex);
      hasBackdrop = 1;
    }

    gl.viewport(0, 0, viewportW, viewportH);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.blitProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stylesQuadBuffer || this.quadBuffer);
    if (this.aBlitQuadPosLoc >= 0) {
      gl.enableVertexAttribArray(this.aBlitQuadPosLoc);
      gl.vertexAttribPointer(this.aBlitQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(this.uBlitTextureLoc, 0);
    gl.uniform1i(this.uBlitBackdropTextureLoc, 2);
    gl.uniform1i(this.uBlitHasBackdropLoc, hasBackdrop);
    gl.uniform1i(this.uBlitBlendModeLoc, modeCode);
    gl.uniform1f(this.uBlitOpacityLoc, opacity);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.unbindSceneTextureUnits(gl);
    this.restoreStandardProgram(gl);
  }

  /**
   * Post-processing pass: CMYK Soft Proofing and Gamut Warning.
   * Samples directly from the Ping-Pong scene FBO texture into the default framebuffer (zero copyTexSubImage2D).
   */
  private applySoftProofPass(
    gl: WebGL2RenderingContext,
    viewportW: number,
    viewportH: number,
    settings: SoftProofSettings,
    sceneTexture: WebGLTexture
  ): void {
    if (!this.softProofProgram) return;

    gl.useProgram(this.softProofProgram);

    const standardIndex = settings.standard === 'japan-color-2001' ? 0 : settings.standard === 'us-web-coated-swop' ? 1 : 2;
    gl.uniform1i(this.uProofStandardLoc, standardIndex);
    gl.uniform1i(this.uProofEnabledLoc, settings.enabled ? 1 : 0);
    gl.uniform1i(this.uProofGamutWarningLoc, settings.gamutWarning ? 1 : 0);

    const warnRgb = this.parseHexColor(settings.gamutWarningColor || '#7f7f7f');
    gl.uniform3f(this.uProofGamutWarningColorLoc, warnRgb[0], warnRgb[1], warnRgb[2]);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
    gl.uniform1i(this.uProofSceneTextureLoc, 0);

    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);

    const quadBuffer = this.stylesQuadBuffer || this.quadBuffer;
    if (quadBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      if (this.aProofQuadPosLoc >= 0) {
        gl.enableVertexAttribArray(this.aProofQuadPosLoc);
        gl.vertexAttribPointer(this.aProofQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
      }

      gl.viewport(0, 0, viewportW, viewportH);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    this.unbindSceneTextureUnits(gl);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.restoreStandardProgram(gl);
  }

  /**
   * Evaluates non-destructive GPU layer styles (Stroke, Drop Shadow, Outer Glow)
   * by rendering the layer into an isolated FBO and processing through LAYER_STYLES_FRAGMENT_SHADER.
   */
  private renderLayerWithStyles(
    gl: WebGL2RenderingContext,
    layer: LayerItem,
    dimensions: CanvasDimensions,
    grid: SparseTileGrid,
    frustum: { minX: number; minY: number; maxX: number; maxY: number },
    viewportW: number,
    viewportH: number,
    transform: ViewportTransform,
    dpr: number,
    opacityMultiplier: number = 1.0,
    target: PingPongTarget | null = null,
    preserveStencil: boolean = false
  ): void {
    if (!this.ensureLayerFbo(viewportW, viewportH) || !this.stylesProgram) {
      this.renderSingleLayer(gl, layer, dimensions, grid, frustum, opacityMultiplier, target, preserveStencil);
      return;
    }

    const styles = layer.styles;
    if (!styles) {
      this.renderSingleLayer(gl, layer, dimensions, grid, frustum, opacityMultiplier, target, preserveStencil);
      return;
    }

    let maxStyleMargin = 0;
    if (styles.stroke?.enabled) {
      maxStyleMargin = Math.max(maxStyleMargin, styles.stroke.size || 0);
    }
    if (styles.dropShadow?.enabled) {
      maxStyleMargin = Math.max(maxStyleMargin, (styles.dropShadow.distance || 0) + (styles.dropShadow.blur || 0));
    }
    if (styles.outerGlow?.enabled) {
      maxStyleMargin = Math.max(maxStyleMargin, styles.outerGlow.blur || 0);
    }

    const expandedFrustum = {
      minX: Math.max(0, frustum.minX - maxStyleMargin),
      minY: Math.max(0, frustum.minY - maxStyleMargin),
      maxX: Math.min(dimensions.width, frustum.maxX + maxStyleMargin),
      maxY: Math.min(dimensions.height, frustum.maxY + maxStyleMargin),
    };

    // 1. Render layer into isolated FBO with opacity 1.0 (opacity is modulated by stylesProgram)
    const stencilWasEnabled = gl.isEnabled(gl.STENCIL_TEST);
    if (stencilWasEnabled) gl.disable(gl.STENCIL_TEST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
    gl.viewport(0, 0, viewportW, viewportH);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const virtualLayer: LayerItem = { ...layer, opacity: 1.0, blendMode: 'normal' };
    this.renderSingleLayer(gl, virtualLayer, dimensions, grid, expandedFrustum, 1.0, null, false);

    // 2. Determine whether custom blend mode requires routing styled output through Ping-Pong blit
    const modeCode = BLEND_MODE_MAP[layer.blendMode] ?? 0;
    const needsCustomBlend = modeCode !== 0 && modeCode !== 12 && target !== null;

    if (needsCustomBlend) {
      if (!this.layerStylesOutFbo) {
        this.layerStylesOutFbo = this.createFboSurface(gl, false);
      }
      if (this.layerStylesOutFbo && this.ensureFboSurfaceSize(gl, this.layerStylesOutFbo, viewportW, viewportH)) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerStylesOutFbo.fbo);
        gl.viewport(0, 0, viewportW, viewportH);
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.blendFunc(gl.ONE, gl.ZERO);
      } else {
        const parentFbo = target ? target.surfaces[target.activeIndex].fbo : null;
        gl.bindFramebuffer(gl.FRAMEBUFFER, parentFbo);
        gl.viewport(0, 0, viewportW, viewportH);
        if (stencilWasEnabled) gl.enable(gl.STENCIL_TEST);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
    } else {
      const parentFbo = target ? target.surfaces[target.activeIndex].fbo : null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, parentFbo);
      gl.viewport(0, 0, viewportW, viewportH);
      if (stencilWasEnabled) gl.enable(gl.STENCIL_TEST);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    // 3. Activate styles program and bind uniforms
    gl.useProgram(this.stylesProgram);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.stylesQuadBuffer);
    if (this.aStylesQuadPosLoc >= 0) {
      gl.enableVertexAttribArray(this.aStylesQuadPosLoc);
      gl.vertexAttribPointer(this.aStylesQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.layerTexture);
    gl.uniform1i(this.uStylesLayerTextureLoc, 0);

    gl.uniform2f(this.uStylesViewportSizeLoc, viewportW, viewportH);
    gl.uniform1f(this.uStylesLayerOpacityLoc, layer.opacity * opacityMultiplier);

    const stroke = styles.stroke;
    const strokeActive = Boolean(stroke?.enabled && stroke.size > 0 && stroke.opacity > 0);
    gl.uniform1i(this.uStylesStrokeEnabledLoc, strokeActive ? 1 : 0);
    if (strokeActive && stroke) {
      const strokePx = stroke.size * transform.zoom * dpr;
      gl.uniform1f(this.uStylesStrokeSizeLoc, strokePx);
      const [sr, sg, sb] = this.parseHexColor(stroke.color || '#000000');
      gl.uniform4f(this.uStylesStrokeColorLoc, sr, sg, sb, stroke.opacity);
      const posCode = stroke.position === 'inside' ? 1 : stroke.position === 'center' ? 2 : 0;
      gl.uniform1i(this.uStylesStrokePositionLoc, posCode);
    }

    const glow = styles.outerGlow;
    const glowActive = Boolean(glow?.enabled && glow.opacity > 0 && glow.blur > 0);
    gl.uniform1i(this.uStylesGlowEnabledLoc, glowActive ? 1 : 0);
    if (glowActive && glow) {
      const glowBlurPx = glow.blur * transform.zoom * dpr;
      gl.uniform1f(this.uStylesGlowBlurLoc, glowBlurPx);
      const [gr, gg, gb] = this.parseHexColor(glow.color || '#ffff00');
      gl.uniform4f(this.uStylesGlowColorLoc, gr, gg, gb, glow.opacity);
      gl.uniform1f(this.uStylesGlowSpreadLoc, (glow.spread || 0) / 100);
    }

    const shadow = styles.dropShadow;
    const shadowActive = Boolean(shadow?.enabled && shadow.opacity > 0);
    gl.uniform1i(this.uStylesShadowEnabledLoc, shadowActive ? 1 : 0);
    if (shadowActive && shadow) {
      const rad = ((shadow.angle || 0) * Math.PI) / 180;
      const distPx = (shadow.distance || 0) * transform.zoom * dpr;
      const dx = Math.cos(rad) * distPx * (transform.flipX ? -1 : 1);
      const dy = Math.sin(rad) * distPx * (transform.flipY ? -1 : 1);
      gl.uniform2f(this.uStylesShadowOffsetLoc, dx, -dy);
      const shadowBlurPx = (shadow.blur || 0) * transform.zoom * dpr;
      gl.uniform1f(this.uStylesShadowBlurLoc, shadowBlurPx);
      const [dr, dg, db] = this.parseHexColor(shadow.color || '#000000');
      gl.uniform4f(this.uStylesShadowColorLoc, dr, dg, db, shadow.opacity);
      gl.uniform1f(this.uStylesShadowSpreadLoc, (shadow.spread || 0) / 100);
    }

    // 4. Draw fullscreen quad
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 5. If custom blend mode was routed to layerStylesOutFbo, composite onto parent Ping-Pong target
    if (needsCustomBlend && this.layerStylesOutFbo && target) {
      const parentFbo = target.surfaces[target.activeIndex].fbo;
      gl.bindFramebuffer(gl.FRAMEBUFFER, parentFbo);
      gl.viewport(0, 0, viewportW, viewportH);
      if (stencilWasEnabled) gl.enable(gl.STENCIL_TEST);
      this.blitFolderTexture(
        gl,
        this.layerStylesOutFbo.texture,
        layer.blendMode,
        1.0,
        viewportW,
        viewportH,
        target,
        preserveStencil
      );
      return;
    }

    // 6. Restore standard program and quad buffer
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.restoreStandardProgram(gl);
  }


  /**
   * Evict least recently used tile textures when texture pool exceeds threshold.
   */
  private evictStaleTextures(): void {
    if (!this.gl || this.texturePool.length <= ViewportCompositor.MAX_TEXTURE_POOL_SIZE) return;
    this.texturePool.sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.texturePool.length > ViewportCompositor.MAX_TEXTURE_POOL_SIZE) {
      const slot = this.texturePool.shift();
      if (slot) {
        if (slot.currentKey) this.activePoolByKey.delete(slot.currentKey);
        this.gl.deleteTexture(slot.texture);
      }
    }
  }

  /**
   * Helper to render a single layer onto a 2D canvas context.
   */
  private render2DSingleLayer(
    targetCtx: CanvasRenderingContext2D,
    layer: LayerItem,
    grid: SparseTileGrid,
    tileCtx: CanvasRenderingContext2D | null | undefined,
    opacityMultiplier: number = 1.0
  ): void {
    targetCtx.save();
    targetCtx.globalAlpha = Math.max(0, Math.min(1, layer.opacity * opacityMultiplier));
    targetCtx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);

    const tiles = grid.getLayerTiles(layer.id);
    const hasMask = Boolean(layer.maskCanvas && layer.maskEnabled !== false);
    const maskCtx = hasMask && layer.maskCanvas ? layer.maskCanvas.getContext('2d', { willReadFrequently: true }) : null;

    // Helper to render tiles into target context
    const drawTiles = (ctx: CanvasRenderingContext2D) => {
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
        ctx.drawImage(this.fallbackTileCanvas, tile.tileX * TILE_SIZE, tile.tileY * TILE_SIZE);
      }
    };

    const styles = layer.styles;
    const hasStyles = hasActiveLayerStyles(styles);

    // 2D Layer Styles: Draw Drop Shadow
    if (hasStyles && styles?.dropShadow?.enabled && styles.dropShadow.opacity > 0) {
      targetCtx.save();
      const rad = ((styles.dropShadow.angle || 0) * Math.PI) / 180;
      const dist = styles.dropShadow.distance || 0;
      targetCtx.shadowColor = styles.dropShadow.color || '#000000';
      targetCtx.shadowBlur = styles.dropShadow.blur || 0;
      targetCtx.shadowOffsetX = Math.cos(rad) * dist;
      targetCtx.shadowOffsetY = Math.sin(rad) * dist;
      targetCtx.globalAlpha = layer.opacity * opacityMultiplier * styles.dropShadow.opacity;
      drawTiles(targetCtx);
      targetCtx.restore();
    }

    // 2D Layer Styles: Draw Outer Glow
    if (hasStyles && styles?.outerGlow?.enabled && styles.outerGlow.opacity > 0) {
      targetCtx.save();
      targetCtx.shadowColor = styles.outerGlow.color || '#ffff00';
      targetCtx.shadowBlur = styles.outerGlow.blur || 0;
      targetCtx.shadowOffsetX = 0;
      targetCtx.shadowOffsetY = 0;
      targetCtx.globalAlpha = layer.opacity * opacityMultiplier * styles.outerGlow.opacity;
      drawTiles(targetCtx);
      targetCtx.restore();
    }

    // WYSIWYG 2D fallback in-stack live draft compositing
    const opts = this.currentOptions;
    const has2DDraft = Boolean(
      opts?.activeDraftLayerId === layer.id &&
      opts.activeDraftCanvas &&
      (opts.activeDraftCanvas as any).__draftHasContent !== false
    );
    const draftOp2D = has2DDraft && opts?.activeDraftCanvas
      ? ((opts.activeDraftCanvas as any).__draftCompositeOp as GlobalCompositeOperation | undefined)
      : undefined;

    if (
      has2DDraft &&
      opts?.activeDraftCanvas &&
      (draftOp2D === 'destination-out' || draftOp2D === 'source-atop') &&
      typeof document !== 'undefined' &&
      targetCtx.canvas
    ) {
      const iso = document.createElement('canvas');
      iso.width = targetCtx.canvas.width;
      iso.height = targetCtx.canvas.height;
      const isoCtx = iso.getContext('2d');
      if (isoCtx) {
        if (typeof targetCtx.getTransform === 'function' && typeof isoCtx.setTransform === 'function') {
          isoCtx.setTransform(targetCtx.getTransform());
        }
        drawTiles(isoCtx);
        isoCtx.save();
        isoCtx.globalAlpha = opts.activeDraftOpacity ?? 1.0;
        isoCtx.globalCompositeOperation = draftOp2D;
        if (opts.activeDraftSpace === 'viewport' && typeof isoCtx.setTransform === 'function') {
          isoCtx.setTransform(1, 0, 0, 1, 0, 0);
          isoCtx.drawImage(opts.activeDraftCanvas, 0, 0);
        } else if (opts.activeDraftDirtyRect) {
          const dr = opts.activeDraftDirtyRect;
          isoCtx.drawImage(opts.activeDraftCanvas, dr.x, dr.y, dr.width, dr.height);
        } else {
          isoCtx.drawImage(
            opts.activeDraftCanvas,
            0,
            0,
            opts.dimensions?.width ?? opts.activeDraftCanvas.width,
            opts.dimensions?.height ?? opts.activeDraftCanvas.height
          );
        }
        isoCtx.restore();

        targetCtx.save();
        if (typeof targetCtx.setTransform === 'function') {
          targetCtx.setTransform(1, 0, 0, 1, 0, 0);
        }
        targetCtx.drawImage(iso, 0, 0);
        targetCtx.restore();
        targetCtx.restore();
        return;
      }
    }

    // Draw main layer content
    drawTiles(targetCtx);

    if (has2DDraft && opts?.activeDraftCanvas) {
      targetCtx.save();
      targetCtx.globalAlpha *= opts.activeDraftOpacity ?? 1.0;
      if (opts.activeDraftSpace === 'viewport' && typeof targetCtx.setTransform === 'function') {
        targetCtx.setTransform(1, 0, 0, 1, 0, 0);
        targetCtx.drawImage(opts.activeDraftCanvas, 0, 0);
      } else if (opts.activeDraftDirtyRect) {
        const dr = opts.activeDraftDirtyRect;
        targetCtx.drawImage(opts.activeDraftCanvas, dr.x, dr.y, dr.width, dr.height);
      } else {
        targetCtx.drawImage(
          opts.activeDraftCanvas,
          0,
          0,
          opts.dimensions?.width ?? opts.activeDraftCanvas.width,
          opts.dimensions?.height ?? opts.activeDraftCanvas.height
        );
      }
      targetCtx.restore();
    }

    targetCtx.restore();
  }

  /**
   * Recursive tree rendering for 2D fallback context supporting pass-through and isolated folders.
   */
  private render2DNodeList(
    targetCtx: CanvasRenderingContext2D,
    nodes: LayerTreeNode[],
    dimensions: CanvasDimensions,
    grid: SparseTileGrid,
    tileCtx: CanvasRenderingContext2D | null | undefined,
    opacityMultiplier: number = 1.0
  ): void {
    const renderOrder = nodes.slice().reverse();
    const groups = groupTreeNodesForCompositing(renderOrder);

    for (const group of groups) {
      const baseNode = group.baseNode;
      const baseLayer = baseNode.layer;
      if (!baseLayer.visible || baseLayer.opacity <= 0.001) continue;

      if (baseLayer.type === 'folder') {
        const isPassThrough = baseLayer.blendMode === 'pass-through';
        const folderEffectiveOpacity = opacityMultiplier * baseLayer.opacity;

        if (isPassThrough) {
          if (baseNode.children.length > 0) {
            this.render2DNodeList(
              targetCtx,
              baseNode.children,
              dimensions,
              grid,
              tileCtx,
              folderEffectiveOpacity
            );
          }
        } else {
          let folderCanvas: HTMLCanvasElement | null = null;
          if (typeof document !== 'undefined') {
            folderCanvas = document.createElement('canvas');
            folderCanvas.width = dimensions.width;
            folderCanvas.height = dimensions.height;
          }
          const fCtx = folderCanvas?.getContext('2d');
          if (fCtx && folderCanvas) {
            if (baseNode.children.length > 0) {
              this.render2DNodeList(
                fCtx,
                baseNode.children,
                dimensions,
                grid,
                tileCtx,
                1.0
              );
            }
            targetCtx.save();
            targetCtx.globalAlpha = Math.max(0, Math.min(1, folderEffectiveOpacity));
            targetCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
            targetCtx.drawImage(folderCanvas, 0, 0);
            targetCtx.restore();
          }
        }
        continue;
      }

      if (baseLayer.type === 'adjustment' && baseLayer.adjustmentData) {
        const imgData = targetCtx.getImageData(0, 0, dimensions.width, dimensions.height);
        applyAdjustment(imgData, baseLayer.adjustmentData, baseLayer.maskCanvas, baseLayer.opacity * opacityMultiplier);
        targetCtx.putImageData(imgData, 0, 0);
        continue;
      }

      const activeClipped = group.clippedNodes.filter(
        (cn) => cn.layer.visible && cn.layer.opacity > 0.001 && cn.layer.type !== 'folder'
      );

      if (activeClipped.length === 0) {
        this.render2DSingleLayer(targetCtx, baseLayer, grid, tileCtx, opacityMultiplier);
      } else {
        let groupCanvas: HTMLCanvasElement | null = null;
        if (typeof document !== 'undefined') {
          groupCanvas = document.createElement('canvas');
          groupCanvas.width = dimensions.width;
          groupCanvas.height = dimensions.height;
        }
        const gCtx = groupCanvas?.getContext('2d');
        if (!gCtx || !groupCanvas) {
          this.render2DSingleLayer(targetCtx, baseLayer, grid, tileCtx, opacityMultiplier);
          continue;
        }

        this.render2DSingleLayer(gCtx, baseLayer, grid, tileCtx, 1.0);

        for (const clippedNode of activeClipped) {
          const clipped = clippedNode.layer;
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

        targetCtx.save();
        targetCtx.globalAlpha = Math.max(0, Math.min(1, opacityMultiplier));
        targetCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
        targetCtx.drawImage(groupCanvas, 0, 0);
        targetCtx.restore();
      }
    }
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
    ctx.scale(
      (transform.flipX ? -1 : 1) * transform.zoom,
      (transform.flipY ? -1 : 1) * transform.zoom
    );
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

    const tree = buildLayerTree(layers);
    this.render2DNodeList(ctx, tree, dimensions, grid, tileCtx, 1.0);

    ctx.restore();
  }

  private static previewTileCanvas: HTMLCanvasElement | null = null;
  private static previewScratchCanvas: HTMLCanvasElement | null = null;

  /**
   * Lightweight low-LOD composite preview renderer for Navigator & thumbnails.
   * Reads directly from SparseTileGrid mipmap LOD tiles (no WebGL context creation, no GPU readPixels stall).
   */
  public static renderLowResPreview(
    targetCanvas: HTMLCanvasElement,
    layers: LayerItem[],
    dimensions: CanvasDimensions,
    grid: SparseTileGrid = globalTileGrid,
    options: { showCheckerboard?: boolean } = {}
  ): void {
    if (typeof document === 'undefined') return;
    const ctx = targetCanvas.getContext('2d');
    if (!ctx) return;

    const outW = Math.max(1, Math.floor(targetCanvas.width));
    const outH = Math.max(1, Math.floor(targetCanvas.height));
    const docW = Math.max(1, dimensions.width);
    const docH = Math.max(1, dimensions.height);

    // Choose lowest sufficient LOD based on downscale ratio (avoids reading full-res tiles on 4K+ canvases)
    const ratio = Math.max(docW / outW, docH / outH);
    const targetLod = ratio >= 7 ? 3 : ratio >= 3.5 ? 2 : ratio >= 1.8 ? 1 : 0;
    const lodDocSize = TILE_SIZE << targetLod;
    const scaleX = outW / docW;
    const scaleY = outH / docH;

    // 1. Background
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (options.showCheckerboard) {
      const cell = 6;
      ctx.fillStyle = '#202020';
      ctx.fillRect(0, 0, outW, outH);
      ctx.fillStyle = '#2a2a2a';
      for (let y = 0; y < outH; y += cell) {
        const offset = ((y / cell) & 1) * cell;
        for (let x = offset; x < outW; x += cell * 2) {
          ctx.fillRect(x, y, cell, cell);
        }
      }
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, outW, outH);
    }

    if (!ViewportCompositor.previewTileCanvas) {
      ViewportCompositor.previewTileCanvas = document.createElement('canvas');
      ViewportCompositor.previewTileCanvas.width = TILE_SIZE;
      ViewportCompositor.previewTileCanvas.height = TILE_SIZE;
    }
    const tileCanvas = ViewportCompositor.previewTileCanvas;
    const tileCtx = tileCanvas.getContext('2d', { willReadFrequently: true });
    if (!tileCtx) {
      ctx.restore();
      return;
    }

    const drawSingleLayer = (
      dstCtx: CanvasRenderingContext2D,
      layer: LayerItem,
      opacityMul: number,
      compositeOverride?: GlobalCompositeOperation
    ) => {
      const alpha = Math.max(0, Math.min(1, layer.opacity * opacityMul));
      if (alpha <= 0.001) return;

      const tiles = grid.getOrBuildLodTiles(layer.id, targetLod);
      if (tiles.length === 0) return;

      dstCtx.save();
      dstCtx.globalAlpha = alpha;
      dstCtx.globalCompositeOperation = compositeOverride ?? getCanvasCompositeOperation(layer.blendMode);
      dstCtx.imageSmoothingEnabled = true;

      for (const tile of tiles) {
        const rgba = grid.getTileAsRGBA(tile);
        const imgData = tileCtx.createImageData(TILE_SIZE, TILE_SIZE);
        imgData.data.set(rgba);
        tileCtx.putImageData(imgData, 0, 0);

        const dx = tile.tileX * lodDocSize * scaleX;
        const dy = tile.tileY * lodDocSize * scaleY;
        const dw = lodDocSize * scaleX;
        const dh = lodDocSize * scaleY;
        dstCtx.drawImage(tileCanvas, dx, dy, dw, dh);
      }

      dstCtx.restore();
    };

    const renderNodes = (
      dstCtx: CanvasRenderingContext2D,
      nodes: LayerTreeNode[],
      opacityMul: number
    ) => {
      const renderOrder = nodes.slice().reverse();
      const groups = groupTreeNodesForCompositing(renderOrder);

      for (const group of groups) {
        const baseNode = group.baseNode;
        const baseLayer = baseNode.layer;
        if (!baseLayer.visible || baseLayer.opacity <= 0.001) continue;

        if (baseLayer.type === 'folder') {
          const folderOpacity = opacityMul * baseLayer.opacity;
          if (baseLayer.blendMode === 'pass-through') {
            if (baseNode.children.length > 0) {
              renderNodes(dstCtx, baseNode.children, folderOpacity);
            }
          } else {
            const tmp = document.createElement('canvas');
            tmp.width = outW;
            tmp.height = outH;
            const tmpCtx = tmp.getContext('2d');
            if (tmpCtx) {
              if (baseNode.children.length > 0) {
                renderNodes(tmpCtx, baseNode.children, 1.0);
              }
              dstCtx.save();
              dstCtx.globalAlpha = Math.max(0, Math.min(1, folderOpacity));
              dstCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
              dstCtx.drawImage(tmp, 0, 0);
              dstCtx.restore();
            }
          }
          continue;
        }

        if (baseLayer.type === 'adjustment' && baseLayer.adjustmentData) {
          try {
            const imgData = dstCtx.getImageData(0, 0, outW, outH);
            applyAdjustment(imgData, baseLayer.adjustmentData, undefined, baseLayer.opacity * opacityMul);
            dstCtx.putImageData(imgData, 0, 0);
          } catch {
            // Ignore in headless/mock contexts without getImageData
          }
          continue;
        }

        const activeClipped = group.clippedNodes.filter(
          (cn) => cn.layer.visible && cn.layer.opacity > 0.001 && cn.layer.type !== 'folder'
        );

        if (activeClipped.length === 0) {
          drawSingleLayer(dstCtx, baseLayer, opacityMul);
        } else {
          if (!ViewportCompositor.previewScratchCanvas) {
            ViewportCompositor.previewScratchCanvas = document.createElement('canvas');
          }
          const grpCanvas = ViewportCompositor.previewScratchCanvas;
          if (grpCanvas.width !== outW) grpCanvas.width = outW;
          if (grpCanvas.height !== outH) grpCanvas.height = outH;
          const grpCtx = grpCanvas.getContext('2d');
          if (!grpCtx) {
            drawSingleLayer(dstCtx, baseLayer, opacityMul);
            continue;
          }
          grpCtx.clearRect(0, 0, outW, outH);
          drawSingleLayer(grpCtx, baseLayer, 1.0, 'source-over');
          for (const cn of activeClipped) {
            drawSingleLayer(grpCtx, cn.layer, 1.0, 'source-atop');
          }
          dstCtx.save();
          dstCtx.globalAlpha = Math.max(0, Math.min(1, opacityMul));
          dstCtx.globalCompositeOperation = getCanvasCompositeOperation(baseLayer.blendMode);
          dstCtx.drawImage(grpCanvas, 0, 0);
          dstCtx.restore();
        }
      }
    };

    const tree = buildLayerTree(layers);
    renderNodes(ctx, tree, 1.0);
    ctx.restore();
  }

  /**
   * Clear all allocated WebGL textures, FBOs, buffers, and programs.
   */
  public dispose(): void {
    if (this.gl) {
      const gl = this.gl;
      this.invalidateTileTextures();
      for (const item of this.maskTextureCache.values()) {
        gl.deleteTexture(item.texture);
      }
      this.maskTextureCache.clear();
      this.maskInvalidationEpochs.clear();
      if (this.draftTexture) {
        gl.deleteTexture(this.draftTexture);
        this.draftTexture = null;
      }
      if (this.lutTexture) {
        gl.deleteTexture(this.lutTexture);
        this.lutTexture = null;
      }
      if (this.tileArrayTexture) {
        gl.deleteTexture(this.tileArrayTexture);
        this.tileArrayTexture = null;
      }
      if (this.instanceBuffer) {
        gl.deleteBuffer(this.instanceBuffer);
        this.instanceBuffer = null;
      }
      if (this.instancedVao && typeof gl.deleteVertexArray === 'function') {
        gl.deleteVertexArray(this.instancedVao);
        this.instancedVao = null;
      }
      if (this.quadBuffer) {
        gl.deleteBuffer(this.quadBuffer);
        this.quadBuffer = null;
      }
      if (this.program) {
        gl.deleteProgram(this.program);
        this.program = null;
      }
      if (this.instancedProgram) {
        gl.deleteProgram(this.instancedProgram);
        this.instancedProgram = null;
      }
      if (this.viewportDraftProgram) {
        gl.deleteProgram(this.viewportDraftProgram);
        this.viewportDraftProgram = null;
      }
      if (this.adjProgram) {
        gl.deleteProgram(this.adjProgram);
        this.adjProgram = null;
      }
      if (this.stylesProgram) {
        gl.deleteProgram(this.stylesProgram);
        this.stylesProgram = null;
      }
      if (this.blitProgram) {
        gl.deleteProgram(this.blitProgram);
        this.blitProgram = null;
      }
      if (this.softProofProgram) {
        gl.deleteProgram(this.softProofProgram);
        this.softProofProgram = null;
      }
      this.disposePingPongTarget(gl, this.scenePingPong);
      this.scenePingPong = null;
      for (const fpp of this.folderPingPongs) {
        this.disposePingPongTarget(gl, fpp);
      }
      this.folderPingPongs = [];
      this.disposeFboSurface(gl, this.belowActiveCacheFbo);
      this.belowActiveCacheFbo = null;
      this.disposeFboSurface(gl, this.aboveActiveCacheFbo);
      this.aboveActiveCacheFbo = null;
      this.disposeFboSurface(gl, this.layerStylesOutFbo);
      this.layerStylesOutFbo = null;
      if (this.layerFbo) {
        gl.deleteFramebuffer(this.layerFbo);
        this.layerFbo = null;
      }
      if (this.layerTexture) {
        gl.deleteTexture(this.layerTexture);
        this.layerTexture = null;
      }
      if (this.stylesQuadBuffer) {
        gl.deleteBuffer(this.stylesQuadBuffer);
        this.stylesQuadBuffer = null;
      }
    }
    this.stackCache.invalidateAll();
    if (this.fallbackTileCanvas) {
      this.fallbackTileCanvas = null;
    }
    if (typeof this.canvas.removeEventListener === 'function') {
      if (this.onContextLostHandler) {
        this.canvas.removeEventListener('webglcontextlost', this.onContextLostHandler);
      }
      if (this.onContextRestoredHandler) {
        this.canvas.removeEventListener('webglcontextrestored', this.onContextRestoredHandler);
      }
    }
  }
}
