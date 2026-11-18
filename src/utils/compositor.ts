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

  vec4 texColor = texture(u_tileTexture, v_texCoord);

  if (texColor.a < 0.002) {
    discard;
  }

  vec4 finalColor = texColor;

  if (u_expressionMode == 1) {
    float gLum = dot(finalColor.rgb, vec3(0.299, 0.587, 0.114));
    finalColor.rgb = vec3(gLum);
  } else if (u_expressionMode == 2) {
    float mLum = dot(finalColor.rgb, vec3(0.299, 0.587, 0.114));
    if (mLum < u_monoThreshold) {
      if (u_monoExpressBlack == 1) {
        finalColor = vec4(0.0, 0.0, 0.0, step(0.1, finalColor.a));
      } else {
        discard;
      }
    } else {
      if (u_monoExpressWhite == 1) {
        finalColor = vec4(1.0, 1.0, 1.0, step(0.1, finalColor.a));
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
  // WYSIWYG In-Stack Live Stroke Compositing
  activeDraftCanvas?: HTMLCanvasElement | null;
  activeDraftLayerId?: string | null;
  activeDraftDirtyRect?: { x: number; y: number; width: number; height: number } | null;
  activeDraftVersion?: number;
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
  private uBackdropTextureLoc: WebGLUniformLocation | null = null;
  private uHasBackdropLoc: WebGLUniformLocation | null = null;
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

  // Cached attribute locations (eliminates per-frame gl.getAttribLocation stalls)
  private aQuadPosLoc: number = -1;
  private aStylesQuadPosLoc: number = -1;
  private aBlitQuadPosLoc: number = -1;
  private aProofQuadPosLoc: number = -1;
  private contextLost: boolean = false;
  private onContextLostHandler: ((e: Event) => void) | null = null;
  private onContextRestoredHandler: (() => void) | null = null;

  // Mask uniform locations & version-tracked cache
  private uMaskTextureLoc: WebGLUniformLocation | null = null;
  private uMaskEnabledLoc: WebGLUniformLocation | null = null;
  private uExpressionModeLoc: WebGLUniformLocation | null = null;
  private uMonoThresholdLoc: WebGLUniformLocation | null = null;
  private uMonoExpressBlackLoc: WebGLUniformLocation | null = null;
  private uMonoExpressWhiteLoc: WebGLUniformLocation | null = null;
  private maskTextureCache: Map<
    string,
    { texture: WebGLTexture; version: number; width: number; height: number }
  > = new Map();

  // Live in-stack draft stroke texture cache
  private draftTexture: WebGLTexture | null = null;
  private draftTexWidth: number = 0;
  private draftTexHeight: number = 0;
  private lastDraftVersion: number = -1;
  private currentOptions: CompositorOptions | null = null;
  private currentZoom: number = 1.0;

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
  private lastLutKey: string = '';
  private lastLutAdjMode: number = 0;

  // Layer Styles program, FBO & uniforms
  private stylesProgram: WebGLProgram | null = null;
  private stylesQuadBuffer: WebGLBuffer | null = null;
  private layerFbo: WebGLFramebuffer | null = null;
  private layerTexture: WebGLTexture | null = null;
  private layerFboWidth: number = 0;
  private layerFboHeight: number = 0;

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

  // Folder compositing blit program, uniforms, & FBOs
  private blitProgram: WebGLProgram | null = null;
  private uBlitTextureLoc: WebGLUniformLocation | null = null;
  private uBlitBackdropTextureLoc: WebGLUniformLocation | null = null;
  private uBlitHasBackdropLoc: WebGLUniformLocation | null = null;
  private uBlitBlendModeLoc: WebGLUniformLocation | null = null;
  private uBlitOpacityLoc: WebGLUniformLocation | null = null;
  private folderFbos: {
    fbo: WebGLFramebuffer;
    texture: WebGLTexture;
    stencilRb: WebGLRenderbuffer | null;
    width: number;
    height: number;
  }[] = [];

  // Soft proofing program, uniforms, & snapshot texture
  private softProofProgram: WebGLProgram | null = null;
  private uProofSceneTextureLoc: WebGLUniformLocation | null = null;
  private uProofStandardLoc: WebGLUniformLocation | null = null;
  private uProofEnabledLoc: WebGLUniformLocation | null = null;
  private uProofGamutWarningLoc: WebGLUniformLocation | null = null;
  private uProofGamutWarningColorLoc: WebGLUniformLocation | null = null;
  private proofSnapshotTexture: WebGLTexture | null = null;
  private proofSnapshotWidth: number = 0;
  private proofSnapshotHeight: number = 0;

  // Pre-allocated WebGL Texture Pool for dynamic texture streaming
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
        this.adjProgram = null;
        this.stylesProgram = null;
        this.blitProgram = null;
        this.softProofProgram = null;
        this.texturePool = [];
        this.activePoolByKey.clear();
        this.maskTextureCache.clear();
        this.folderFbos = [];
        this.layerFbo = null;
        this.layerTexture = null;
        this.snapshotTexture = null;
        this.lutTexture = null;
        this.draftTexture = null;
        this.proofSnapshotTexture = null;
      };
      this.onContextRestoredHandler = () => {
        this.contextLost = false;
        this.initGL();
        globalTileGrid.notifyChange(true);
      };
      canvas.addEventListener('webglcontextlost', this.onContextLostHandler, false);
      canvas.addEventListener('webglcontextrestored', this.onContextRestoredHandler, false);
    }
    this.initGL();
  }

  public isReady(): boolean {
    return !this.contextLost && this.gl !== null && this.program !== null;
  }

  /**
   * Explicitly invalidate a cached layer mask texture (or all masks if layerId omitted).
   */
  public invalidateMaskTexture(layerId?: string): void {
    if (layerId) {
      const item = this.maskTextureCache.get(layerId);
      if (item) item.version = -1;
    } else {
      for (const item of this.maskTextureCache.values()) {
        item.version = -1;
      }
    }
  }

  /**
   * Explicitly invalidate and clear all cached tile textures in the pool.
   */
  public invalidateTileTextures(): void {
    if (this.gl) {
      for (const slot of this.texturePool) {
        this.gl.deleteTexture(slot.texture);
      }
    }
    this.texturePool = [];
    this.activePoolByKey.clear();
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
      this.uBackdropTextureLoc = gl.getUniformLocation(prog, 'u_backdropTexture');
      this.uHasBackdropLoc = gl.getUniformLocation(prog, 'u_hasBackdrop');
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
      this.uExpressionModeLoc = gl.getUniformLocation(prog, 'u_expressionMode');
      this.uMonoThresholdLoc = gl.getUniformLocation(prog, 'u_monoThreshold');
      this.uMonoExpressBlackLoc = gl.getUniformLocation(prog, 'u_monoExpressBlack');
      this.uMonoExpressWhiteLoc = gl.getUniformLocation(prog, 'u_monoExpressWhite');
      this.aQuadPosLoc = gl.getAttribLocation(prog, 'a_quadPos');

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

      // Compile Folder Blit Shader Program
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
   * Get or upload a WebGLTexture from the pre-allocated texture pool with adaptive zoom filtering.
   * Only tiles currently intersecting the screen frustum are uploaded to GPU memory.
   */
  private getTileTexture(tile: TileBuffer, grid: SparseTileGrid): WebGLTexture | null {
    if (!this.gl) return null;
    const gl = this.gl;
    const key = getTileKey(tile.layerId, tile.tileX, tile.tileY, tile.lod ?? 0);
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

    // Re-upload if dirty or version bumped
    if (slot.version !== tile.version || tile.dirty) {
      gl.bindTexture(gl.TEXTURE_2D, slot.texture);

      const rgbaData = grid.getTileAsRGBA(tile);
      const uploadBytes =
        rgbaData instanceof Uint8Array
          ? rgbaData
          : new Uint8Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength);

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
          uploadBytes
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
          uploadBytes
        );
        slot.hasStorage = true;
      }

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
   * Captures the current framebuffer into `this.snapshotTexture` for programmable GLSL blend modes.
   */
  private ensureBackdropSnapshot(gl: WebGL2RenderingContext, viewportW: number, viewportH: number): WebGLTexture | null {
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
    return this.snapshotTexture;
  }

  /**
   * Set WebGL blend mode and snapshot backdrop when programmable blending is active.
   * Because COMPOSITOR_FRAGMENT_SHADER outputs:
   *   fragColor = vec4(mix(Cs, B(Cb, Cs), dstA) * srcA, srcA)
   * standard premultiplied Porter-Duff (gl.ONE, gl.ONE_MINUS_SRC_ALPHA) produces the exact
   * W3C / Clip Studio Paint composited result for all 16 blend modes!
   */
  private setGLBlendMode(blendMode: BlendMode): void {
    if (!this.gl) return;
    const gl = this.gl;
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const modeCode = BLEND_MODE_MAP[blendMode] ?? 0;
    if (modeCode !== 0 && modeCode !== 12 && this.canvas.width > 0 && this.canvas.height > 0) {
      const backdropTex = this.ensureBackdropSnapshot(gl, this.canvas.width, this.canvas.height);
      if (backdropTex) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, backdropTex);
        gl.uniform1i(this.uBackdropTextureLoc, 2);
        gl.uniform1i(this.uHasBackdropLoc, 1);
        gl.activeTexture(gl.TEXTURE0);
        return;
      }
    }
    gl.uniform1i(this.uHasBackdropLoc, 0);
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
    this.currentOptions = _options;
    this.currentZoom = transform.zoom;

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
    gl.uniform1i(this.uHasBackdropLoc, 0);

    // Bind Quad Vertices using cached attribute location
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    if (this.aQuadPosLoc >= 0) {
      gl.enableVertexAttribArray(this.aQuadPosLoc);
      gl.vertexAttribPointer(this.aQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
    }

    // 1. Render artboard background pass (paper white or checkerboard)
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.uniform1i(this.uIsBackgroundLoc, 1);
    gl.uniform1i(this.uExpressionModeLoc, 0);
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

    // Dynamic Frustum Culling & Memory Budget Sync
    const layerVis = new Map<string, boolean>();
    for (const l of layers) {
      layerVis.set(l.id, l.visible);
    }
    grid.getMemoryManager()?.updateViewport(frustum, _options.activeDraftLayerId, layerVis);

    // 2. Render colored onion skin cels if active in animation mode
    if (_options.onionSkinFrames && _options.onionSkinFrames.length > 0) {
      for (const onion of _options.onionSkinFrames) {
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
          this.renderSingleLayer(gl, virtualOnionLayer, dimensions, grid, frustum);
        }
      }
    }

    // 3. Render layer hierarchy: Folders support 'pass-through' and isolated blend modes
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

    // 4. CMYK Soft Proofing and Gamut Warning post-processing pass
    if (_options.softProof && (_options.softProof.enabled || _options.softProof.gamutWarning)) {
      this.applySoftProofPass(gl, viewportW, viewportH, _options.softProof);
    }

    // Prune mask textures belonging to deleted layers
    if (this.maskTextureCache.size > layers.length) {
      for (const cachedLayerId of Array.from(this.maskTextureCache.keys())) {
        if (!layerVis.has(cachedLayerId)) {
          const entry = this.maskTextureCache.get(cachedLayerId);
          if (entry) gl.deleteTexture(entry.texture);
          this.maskTextureCache.delete(cachedLayerId);
        }
      }
    }

    // Clean up stale textures if pool exceeded limit
    if (this.texturePool.length > ViewportCompositor.MAX_TEXTURE_POOL_SIZE) {
      this.evictStaleTextures();
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
    currentFbo: WebGLFramebuffer | null,
    depth: number,
    inheritedOpacity: number
  ): void {
    const siblingsBottomToTop = nodes.slice().reverse();
    const groups = groupTreeNodesForCompositing(siblingsBottomToTop);

    for (const group of groups) {
      const baseNode = group.baseNode;
      const baseLayer = baseNode.layer;
      if (!baseLayer.visible || baseLayer.opacity <= 0.001) {
        continue;
      }

      if (baseLayer.type === 'folder') {
        const isPassThrough = baseLayer.blendMode === 'pass-through';
        if (isPassThrough) {
          // Pass-through: children blend directly with background layers below using their own individual blend modes
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
            currentFbo,
            depth,
            inheritedOpacity * baseLayer.opacity
          );
        } else {
          // Isolated: children render into isolated offscreen texture, then blend with folder's blend mode
          const folderFboItem = this.ensureFolderFbo(depth, viewportW, viewportH);
          if (!folderFboItem) continue;

          gl.bindFramebuffer(gl.FRAMEBUFFER, folderFboItem.fbo);
          gl.viewport(0, 0, viewportW, viewportH);
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
            folderFboItem.fbo,
            depth + 1,
            1.0
          );

          // Restore previous framebuffer and blit isolated folder texture
          gl.bindFramebuffer(gl.FRAMEBUFFER, currentFbo);
          gl.viewport(0, 0, viewportW, viewportH);

          this.blitFolderTexture(
            gl,
            folderFboItem.texture,
            baseLayer.blendMode,
            baseLayer.opacity * inheritedOpacity,
            viewportW,
            viewportH
          );
        }
        continue;
      }

      const activeClippedLayers = group.clippedNodes
        .map((n) => n.layer)
        .filter((cl) => cl.visible && cl.opacity > 0.001 && cl.type !== 'folder');

      const baseEffectiveOpacity = inheritedOpacity;

      if (baseLayer.type === 'adjustment' && baseLayer.adjustmentData) {
        this.renderAdjustmentLayer(
          gl,
          baseLayer,
          transform,
          dimensions,
          viewportW,
          viewportH,
          dpr,
          baseEffectiveOpacity
        );
        continue;
      }

      const baseHasStyles = hasActiveLayerStyles(baseLayer.styles);

      if (activeClippedLayers.length > 0) {
        // Group successive clipped layers: record base silhouette in stencil buffer
        gl.enable(gl.STENCIL_TEST);
        gl.clear(gl.STENCIL_BUFFER_BIT);
        gl.stencilMask(0xFF);
        gl.stencilFunc(gl.ALWAYS, 1, 0xFF);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);

        if (baseHasStyles) {
          // Record base layer silhouette in stencil without writing colors to canvas
          gl.colorMask(false, false, false, false);
          this.renderSingleLayer(gl, baseLayer, dimensions, grid, frustum, baseEffectiveOpacity);
          gl.colorMask(true, true, true, true);

          // Draw base layer with styles (don't overwrite stencil with shadow/glow)
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
            currentFbo
          );
          gl.stencilMask(0xFF);
        } else {
          this.renderSingleLayer(gl, baseLayer, dimensions, grid, frustum, baseEffectiveOpacity);
        }

        // Render clipped layers: only draw over the opaque pixels of the base layer
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
              currentFbo
            );
          } else {
            this.renderSingleLayer(gl, clippedLayer, dimensions, grid, frustum, baseEffectiveOpacity);
          }
        }

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
            currentFbo
          );
        } else {
          this.renderSingleLayer(gl, baseLayer, dimensions, grid, frustum, baseEffectiveOpacity);
        }
      }
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
   * Evaluates non-destructive adjustment layers via GPU snapshot and version-cached LUT evaluation.
   */
  private renderAdjustmentLayer(
    gl: WebGL2RenderingContext,
    layer: LayerItem,
    transform: ViewportTransform,
    dimensions: CanvasDimensions,
    viewportW: number,
    viewportH: number,
    dpr: number,
    opacityMultiplier: number = 1.0
  ): void {
    if (!this.adjProgram || !layer.adjustmentData) return;

    // 1. Snapshot lower composite
    this.ensureBackdropSnapshot(gl, viewportW, viewportH);

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

      this.lastLutKey = lutKey;
      this.lastLutAdjMode = adjMode;
    }

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

    gl.uniform1i(this.uAdjModeLoc, this.lastLutAdjMode);
    gl.uniform1f(this.uAdjOpacityLoc, layer.opacity * opacityMultiplier);

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
   * Also composites any in-progress WYSIWYG draft stroke targeting this layer.
   */
  private renderSingleLayer(
    gl: WebGL2RenderingContext,
    layer: LayerItem,
    dimensions: CanvasDimensions,
    grid: SparseTileGrid,
    frustum: { minX: number; minY: number; maxX: number; maxY: number },
    opacityMultiplier: number = 1.0
  ): void {
    // Configure Layer Blend Mode & Opacity
    this.setGLBlendMode(layer.blendMode);
    gl.uniform1f(this.uLayerOpacityLoc, layer.opacity * opacityMultiplier);
    gl.uniform1i(this.uBlendModeLoc, BLEND_MODE_MAP[layer.blendMode] ?? 0);

    // Configure Expression Color Uniforms
    const isBgLayer = layer.id === 'layer-bg' || layer.id.startsWith('layer-bg');
    const exprMode = isBgLayer
      ? 0
      : layer.expressionColor === 'monochrome'
      ? 2
      : layer.expressionColor === 'gray'
      ? 1
      : 0;
    gl.uniform1i(this.uExpressionModeLoc, exprMode);
    if (exprMode === 2) {
      gl.uniform1f(this.uMonoThresholdLoc, (layer.monoThreshold ?? 128) / 255.0);
      gl.uniform1i(this.uMonoExpressBlackLoc, layer.monoExpressBlack !== false ? 1 : 0);
      gl.uniform1i(this.uMonoExpressWhiteLoc, layer.monoExpressWhite !== false ? 1 : 0);
    }

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

    // Adaptive LOD Selection & Frustum Culling:
    // Select LOD 1 when zoom <= 50%, LOD 2 when zoom <= 25%, LOD 3 when zoom <= 12.5%
    const targetLod =
      this.currentZoom <= 0.125 ? 3 :
      this.currentZoom <= 0.25 ? 2 :
      this.currentZoom <= 0.5 ? 1 : 0;

    const lodScale = 1 << targetLod;
    const lodTileDocSize = TILE_SIZE * lodScale;

    // Convert screen viewport bounding box in canvas coordinates to intersecting tile ranges
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

    gl.uniform2f(this.uTileSizeLoc, lodTileDocSize, lodTileDocSize);

    // Draw each visible intersecting tile with 1 draw call per tile
    for (const tile of visibleTiles) {
      const tex = this.getTileTexture(tile, grid);
      if (!tex) continue;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);

      gl.uniform2f(this.uTileOriginLoc, tile.tileX * lodTileDocSize, tile.tileY * lodTileDocSize);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // WYSIWYG In-Stack Live Stroke Compositing:
    // If an active brush stroke is targeting this exact layer, composite it right here in the stack
    // so upper layers, blend modes, clipping masks, screentones, and layer tinting apply in real time!
    const opts = this.currentOptions;
    if (opts?.activeDraftLayerId === layer.id && opts.activeDraftCanvas) {
      this.renderActiveDraftForLayer(gl, opts.activeDraftCanvas, dimensions, opts.activeDraftVersion);
      gl.uniform2f(this.uTileSizeLoc, TILE_SIZE, TILE_SIZE);
    }

    if (hasMask) {
      gl.uniform1i(this.uMaskEnabledLoc, 0);
    }
    gl.uniform1i(this.uHasBackdropLoc, 0);
  }

  /**
   * Uploads and renders the active draft canvas in-stack for the active layer.
   */
  private renderActiveDraftForLayer(
    gl: WebGL2RenderingContext,
    draftCanvas: HTMLCanvasElement,
    dimensions: CanvasDimensions,
    draftVersion?: number
  ): void {
    if (draftCanvas.width <= 0 || draftCanvas.height <= 0) return;
    if (!this.draftTexture) {
      this.draftTexture = gl.createTexture();
    }
    if (!this.draftTexture) return;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.draftTexture);

    const ver = draftVersion ?? -1;
    if (
      ver === -1 ||
      ver !== this.lastDraftVersion ||
      this.draftTexWidth !== draftCanvas.width ||
      this.draftTexHeight !== draftCanvas.height
    ) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this.currentZoom >= 2.0 ? gl.NEAREST : gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, draftCanvas);
      this.draftTexWidth = draftCanvas.width;
      this.draftTexHeight = draftCanvas.height;
      this.lastDraftVersion = ver;
    }

    gl.uniform2f(this.uTileOriginLoc, 0, 0);
    gl.uniform2f(this.uTileSizeLoc, dimensions.width, dimensions.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
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
   * Ensures an offscreen framebuffer and texture exist for isolated folder compositing.
   */
  private ensureFolderFbo(depth: number, width: number, height: number): { fbo: WebGLFramebuffer; texture: WebGLTexture } | null {
    if (!this.gl) return null;
    const gl = this.gl;

    while (this.folderFbos.length <= depth) {
      const fbo = gl.createFramebuffer();
      const texture = gl.createTexture();
      const stencilRb = typeof gl.createRenderbuffer === 'function' ? gl.createRenderbuffer() : null;
      if (!fbo || !texture) return null;
      this.folderFbos.push({ fbo, texture, stencilRb, width: 0, height: 0 });
    }

    const item = this.folderFbos[depth];
    if (item.width !== width || item.height !== height) {
      const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

      gl.bindTexture(gl.TEXTURE_2D, item.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

      gl.bindFramebuffer(gl.FRAMEBUFFER, item.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, item.texture, 0);

      if (item.stencilRb && typeof gl.bindRenderbuffer === 'function') {
        gl.bindRenderbuffer(gl.RENDERBUFFER, item.stencilRb);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, width, height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, item.stencilRb);
      }

      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);

      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.error('Folder FBO incomplete:', status);
        return null;
      }

      item.width = width;
      item.height = height;
    }

    return item;
  }

  /**
   * Blits an isolated folder offscreen texture back to the current framebuffer
   * with the folder's blend mode and opacity.
   */
  private blitFolderTexture(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    blendMode: BlendMode,
    opacity: number,
    viewportW: number,
    viewportH: number
  ): void {
    if (!this.blitProgram) return;

    gl.viewport(0, 0, viewportW, viewportH);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const modeCode = BLEND_MODE_MAP[blendMode] ?? 0;
    let hasBackdrop = 0;
    if (modeCode !== 0 && modeCode !== 12 && viewportW > 0 && viewportH > 0) {
      const backdropTex = this.ensureBackdropSnapshot(gl, viewportW, viewportH);
      if (backdropTex) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, backdropTex);
        hasBackdrop = 1;
      }
    }

    gl.useProgram(this.blitProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stylesQuadBuffer);
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

    // Restore standard program and quad buffer
    if (this.program) {
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      if (this.aQuadPosLoc >= 0) {
        gl.enableVertexAttribArray(this.aQuadPosLoc);
        gl.vertexAttribPointer(this.aQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
      }
    }
  }

  /**
   * Post-processing pass: CMYK Soft Proofing and Gamut Warning.
   */
  private applySoftProofPass(
    gl: WebGL2RenderingContext,
    viewportW: number,
    viewportH: number,
    settings: SoftProofSettings
  ): void {
    if (!this.softProofProgram) return;

    // 1. Prepare snapshot texture for current viewport
    if (!this.proofSnapshotTexture || this.proofSnapshotWidth !== viewportW || this.proofSnapshotHeight !== viewportH) {
      if (this.proofSnapshotTexture) gl.deleteTexture(this.proofSnapshotTexture);
      this.proofSnapshotTexture = gl.createTexture();
      this.proofSnapshotWidth = viewportW;
      this.proofSnapshotHeight = viewportH;
      gl.bindTexture(gl.TEXTURE_2D, this.proofSnapshotTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, viewportW, viewportH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    // 2. Snapshot rendered viewport backbuffer into texture
    gl.bindTexture(gl.TEXTURE_2D, this.proofSnapshotTexture);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, viewportW, viewportH);

    // 3. Switch to Soft Proof Post-Processing Program
    gl.useProgram(this.softProofProgram);

    // 4. Set uniforms
    const standardIndex = settings.standard === 'japan-color-2001' ? 0 : settings.standard === 'us-web-coated-swop' ? 1 : 2;
    gl.uniform1i(this.uProofStandardLoc, standardIndex);
    gl.uniform1i(this.uProofEnabledLoc, settings.enabled ? 1 : 0);
    gl.uniform1i(this.uProofGamutWarningLoc, settings.gamutWarning ? 1 : 0);

    const warnRgb = this.parseHexColor(settings.gamutWarningColor || '#7f7f7f');
    gl.uniform3f(this.uProofGamutWarningColorLoc, warnRgb[0], warnRgb[1], warnRgb[2]);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.proofSnapshotTexture);
    gl.uniform1i(this.uProofSceneTextureLoc, 0);

    // 5. Draw fullscreen quad to replace backbuffer with proofed output
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

    // 6. Reset state back to compositor defaults
    gl.enable(gl.BLEND);
    if (this.program) {
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      if (this.aQuadPosLoc >= 0) {
        gl.enableVertexAttribArray(this.aQuadPosLoc);
        gl.vertexAttribPointer(this.aQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
      }
    }
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
    currentFbo: WebGLFramebuffer | null = null
  ): void {
    if (!this.ensureLayerFbo(viewportW, viewportH) || !this.stylesProgram) {
      this.renderSingleLayer(gl, layer, dimensions, grid, frustum, opacityMultiplier);
      return;
    }

    const styles = layer.styles;
    if (!styles) {
      this.renderSingleLayer(gl, layer, dimensions, grid, frustum, opacityMultiplier);
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
    gl.viewport(0, 0, viewportW, viewportH);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const virtualLayer: LayerItem = { ...layer, opacity: 1.0, blendMode: 'normal' };
    this.renderSingleLayer(gl, virtualLayer, dimensions, grid, expandedFrustum, 1.0);

    // 2. Restore active target framebuffer (folder FBO or default screen canvas)
    gl.bindFramebuffer(gl.FRAMEBUFFER, currentFbo);
    gl.viewport(0, 0, viewportW, viewportH);

    // 3. Set layer blend mode
    this.setGLBlendMode(layer.blendMode);

    // 4. Activate styles program and bind uniforms
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

    // Stroke uniforms
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

    // Outer Glow uniforms
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

    // Drop Shadow uniforms
    const shadow = styles.dropShadow;
    const shadowActive = Boolean(shadow?.enabled && shadow.opacity > 0);
    gl.uniform1i(this.uStylesShadowEnabledLoc, shadowActive ? 1 : 0);
    if (shadowActive && shadow) {
      const rad = ((shadow.angle || 0) * Math.PI) / 180;
      const distPx = (shadow.distance || 0) * transform.zoom * dpr;
      const dx = Math.cos(rad) * distPx;
      const dy = Math.sin(rad) * distPx;
      gl.uniform2f(this.uStylesShadowOffsetLoc, dx, -dy);
      const shadowBlurPx = (shadow.blur || 0) * transform.zoom * dpr;
      gl.uniform1f(this.uStylesShadowBlurLoc, shadowBlurPx);
      const [dr, dg, db] = this.parseHexColor(shadow.color || '#000000');
      gl.uniform4f(this.uStylesShadowColorLoc, dr, dg, db, shadow.opacity);
      gl.uniform1f(this.uStylesShadowSpreadLoc, (shadow.spread || 0) / 100);
    }

    // 5. Draw fullscreen quad
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 6. Restore standard program and quad buffer
    if (this.program) {
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      if (this.aQuadPosLoc >= 0) {
        gl.enableVertexAttribArray(this.aQuadPosLoc);
        gl.vertexAttribPointer(this.aQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
      }
    }
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

    // Draw main layer content
    drawTiles(targetCtx);

    // WYSIWYG 2D fallback in-stack live draft compositing
    const opts = this.currentOptions;
    if (opts?.activeDraftLayerId === layer.id && opts.activeDraftCanvas) {
      targetCtx.drawImage(opts.activeDraftCanvas, 0, 0);
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

    const tree = buildLayerTree(layers);
    this.render2DNodeList(ctx, tree, dimensions, grid, tileCtx, 1.0);

    ctx.restore();
  }

  /**
   * Clear all allocated WebGL textures.
   */
  public dispose(): void {
    if (this.gl) {
      this.invalidateTileTextures();
      for (const item of this.maskTextureCache.values()) {
        this.gl.deleteTexture(item.texture);
      }
      this.maskTextureCache.clear();
      if (this.draftTexture) {
        this.gl.deleteTexture(this.draftTexture);
        this.draftTexture = null;
      }
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
      if (this.stylesProgram) {
        this.gl.deleteProgram(this.stylesProgram);
        this.stylesProgram = null;
      }
      if (this.blitProgram) {
        this.gl.deleteProgram(this.blitProgram);
        this.blitProgram = null;
      }
      if (this.softProofProgram) {
        this.gl.deleteProgram(this.softProofProgram);
        this.softProofProgram = null;
      }
      if (this.proofSnapshotTexture) {
        this.gl.deleteTexture(this.proofSnapshotTexture);
        this.proofSnapshotTexture = null;
      }
      for (const item of this.folderFbos) {
        this.gl.deleteFramebuffer(item.fbo);
        this.gl.deleteTexture(item.texture);
        if (item.stencilRb && typeof this.gl.deleteRenderbuffer === 'function') {
          this.gl.deleteRenderbuffer(item.stencilRb);
        }
      }
      this.folderFbos = [];
      if (this.layerFbo) {
        this.gl.deleteFramebuffer(this.layerFbo);
        this.layerFbo = null;
      }
      if (this.layerTexture) {
        this.gl.deleteTexture(this.layerTexture);
        this.layerTexture = null;
      }
      if (this.stylesQuadBuffer) {
        this.gl.deleteBuffer(this.stylesQuadBuffer);
        this.stylesQuadBuffer = null;
      }
    }
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
