import { buildBlendModeGlsl } from './blendModesGlsl';
import { buildScreentoneGlsl } from './screentoneGlsl';

// Document-Space Solid Polygon Shaders for Frame Border Folder Stencil Clipping & Borders
export const FRAME_POLY_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_docPos;
uniform vec2 u_docDimensions;
uniform vec2 u_viewportSize;
uniform vec2 u_pan;
uniform float u_zoom;
uniform float u_rotationRad;
uniform vec2 u_flip;
uniform float u_dpr;

void main() {
  vec2 centered = (a_docPos - u_docDimensions * 0.5) * u_flip;
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

export const FRAME_POLY_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec4 u_color;
out vec4 fragColor;

void main() {
  fragColor = vec4(u_color.rgb * u_color.a, u_color.a);
}
`;

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

${buildBlendModeGlsl('Folder')}

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

${buildBlendModeGlsl()}

${buildScreentoneGlsl()}

vec4 applyLayerTint(vec4 color) {
  if (u_layerColorEnabled == 0) return color;
  float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  vec3 tinted = mix(u_layerColor, u_layerSubColor, lum);
  return vec4(tinted, color.a);
}

void main() {
  if (u_isBackground == 1) {
    vec2 outsideDoc = max(vec2(0.0) - v_docCoord, v_docCoord - u_docDimensions);
    if (outsideDoc.x > 0.0 || outsideDoc.y > 0.0) {
      float safeZoom = max(0.01, u_zoom);
      vec2 outsidePx = outsideDoc * safeZoom;
      float borderDist = max(outsidePx.x, outsidePx.y);
      if (borderDist <= 1.0) {
        fragColor = vec4(0.086, 0.086, 0.086, 1.0);
        return;
      }
      vec2 shadowCoord = v_docCoord - vec2(0.0, 10.0 / safeZoom);
      vec2 shadowOutside = max(vec2(0.0) - shadowCoord, shadowCoord - u_docDimensions);
      float shadowDist = length(shadowOutside * safeZoom);
      float shadowA = 0.55 * exp(-shadowDist * shadowDist / 520.0) * smoothstep(48.0, 0.0, shadowDist);
      if (shadowA < 0.002) {
        discard;
      }
      fragColor = vec4(0.0, 0.0, 0.0, shadowA);
      return;
    }
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
    if (u_maskEnabled == 1) {
      vec2 maskCoord = clamp(v_docCoord / u_docDimensions, 0.0, 1.0);
      vec4 maskPixel = texture(u_maskTexture, maskCoord);
      float maskLum = dot(maskPixel.rgb, vec3(0.299, 0.587, 0.114)) * maskPixel.a;
      finalColor.a *= maskLum;
    }
    finalColor.a *= u_layerOpacity;
    finalColor = evaluateScreentone(finalColor, v_docCoord);
    if (u_layerColorEnabled == 1) {
      finalColor = applyLayerTint(finalColor);
    }
  } else {
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
  }

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
