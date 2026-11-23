import { buildBlendModeGlsl } from './blendModesGlsl';
import { buildScreentoneGlsl } from './screentoneGlsl';

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

${buildBlendModeGlsl()}

${buildScreentoneGlsl()}

vec4 applyLayerTint(vec4 color) {
  if (u_layerColorEnabled == 0) return color;
  float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  vec3 tinted = mix(u_layerColor, u_layerSubColor, lum);
  return vec4(tinted, color.a);
}

void main() {
  // Single hardware TMU fetch on premultiplied RGBA8 TEXTURE_2D_ARRAY
  vec4 rawTex = texture(u_tileArrayTexture, vec3(v_texCoord, v_sliceIndex));

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
