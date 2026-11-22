import { LayerStyles } from '../../../types/editor';

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
