import {
  Point,
  BrushSettings,
  ToolType,
  SurfaceTextureId,
  ImpastoSettings,
  DualBrushCompositeMode,
  CspPaperTextureMode,
} from '../types/editor';
import { getSurfaceTextureHeightField, SURFACE_TEXTURE_SIZE } from '../utils/proceduralBrushTips';
import { performanceManager } from '../utils/performanceManager';
import {
  PIGMENT_GLSL_WEBGL1,
  getPigmentLutTexture,
  invalidatePigmentLutTexture,
} from '../utils/pigmentEngine';
import { dualBrushCompositeModeToIndex } from './DualBrushEngine';

export function paperTextureModeToIndex(mode?: CspPaperTextureMode): number {
  switch (mode) {
    case 'multiply':
      return 1;
    case 'compare':
      return 2;
    case 'overlay':
      return 3;
    case 'outline':
      return 4;
    case 'normal':
      return 5;
    case 'color-burn':
      return 6;
    case 'linear-burn':
      return 7;
    case 'height':
      return 8;
    case 'subtract':
    default:
      return 0;
  }
}

export interface GpuInfo {
  isSupported: boolean;
  renderer: string;
  vendor: string;
  glVersion: string;
}

export interface GpuDab {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  pressure: number;
  strokeDist: number;
  flipX?: number;
  flipY?: number;
  tipIndex?: number;
  /** Optional per-dab paper texture density override (0..1) from CSP TextureDensityEffector. */
  grainDensity?: number;
}

export const RIBBON_VERTEX_STRIDE = 9;

export interface TexturedRibbonMeshInput {
  vertices: Float32Array;
  vertexCount: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const VERTEX_SHADER_SRC = `
precision highp float;

attribute vec2 a_quadVertex;
attribute vec2 a_center;
attribute vec2 a_size;
attribute float a_angle;
attribute vec4 a_color;
attribute float a_alpha;
attribute float a_pressure;
attribute float a_strokeDist;
attribute vec2 a_flip;
attribute float a_tipIndex;

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
varying float v_angle;
varying float v_tipIndex;

void main() {
  vec2 flipSign = vec2(a_flip.x == 0.0 ? 1.0 : a_flip.x, a_flip.y == 0.0 ? 1.0 : a_flip.y);
  v_uv = a_quadVertex * flipSign + 0.5;
  v_localPos = a_quadVertex * 2.0;
  v_color = a_color;
  v_alpha = a_alpha;
  v_pressure = a_pressure;
  v_strokeDist = a_strokeDist;
  v_size = a_size;
  v_angle = a_angle;
  v_tipIndex = a_tipIndex;

  float cosA = cos(a_angle);
  float sinA = sin(a_angle);
  vec2 scaled = a_quadVertex * a_size;
  vec2 rotated = vec2(
    scaled.x * cosA - scaled.y * sinA,
    scaled.x * sinA + scaled.y * cosA
  );

  vec2 worldPixelPos = a_center + rotated;
  v_worldPos = worldPixelPos;

  vec2 clipPos = ((worldPixelPos - u_dirtyOffset) / u_canvasResolution) * 2.0 - 1.0;
  clipPos.y = -clipPos.y;

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
varying float v_angle;
varying float v_tipIndex;

uniform bool u_hasTipTexture;
uniform bool u_isColorTip;
uniform bool u_isDualToneTip;
uniform vec3 u_secondaryColor;
uniform sampler2D u_tipTexture;
uniform vec2 u_tipAtlasGrid;

uniform int u_antiAlias;
uniform float u_hardness;
uniform float u_wetEdge;
uniform float u_paperGrain;
uniform float u_grainScale;
uniform float u_grainRotateRad;
uniform int u_grainMappingMode;
uniform vec2 u_grainRandomOffset;
uniform float u_grainRandomRot;
uniform float u_dryBrush;
uniform float u_paintLoad;
uniform int u_paperMode;
uniform float u_paperBrightness;
uniform float u_paperContrast;
uniform bool u_paperInvert;
uniform bool u_paperPreserveDensity;
uniform bool u_paperEmphasizeDensity;
uniform bool u_hasPaperTex;
uniform sampler2D u_paperTexture;
uniform vec2 u_paperTexSize;

uniform bool u_colorMixing;
uniform bool u_perceptualMixing;
uniform float u_pigmentStrength;
uniform sampler2D u_pigmentLut;
uniform bool u_hasCanvasTexture;
uniform sampler2D u_canvasTexture;
uniform vec2 u_canvasResolution;
uniform vec2 u_docResolution;
uniform float u_amountOfPaint;
uniform float u_densityOfPaint;
uniform float u_colorStretch;
uniform bool u_isEraser;
uniform bool u_isBgEraser;

float samplePaperTooth(vec2 worldPos) {
  vec2 baseP = worldPos;
  if (u_grainMappingMode == 1) {
    // brush-aligned: rotate & scale with local dab coordinates
    baseP = v_localPos * max(v_size.x, v_size.y) * 0.5;
  } else if (u_grainMappingMode == 2) {
    // stroke-flow: u = arcLength, v = across-width
    baseP = vec2(v_strokeDist + v_localPos.x * v_size.x * 0.5, v_localPos.y * v_size.y * 0.5);
  } else if (u_grainMappingMode == 3) {
    // random-per-stroke: deterministic random offset + rotation
    float rc = cos(u_grainRandomRot);
    float rs = sin(u_grainRandomRot);
    baseP = vec2(worldPos.x * rc - worldPos.y * rs, worldPos.x * rs + worldPos.y * rc) + u_grainRandomOffset;
  }

  float invScale = 1.0 / max(0.05, u_grainScale);
  float c = cos(u_grainRotateRad);
  float s = sin(u_grainRotateRad);
  vec2 rotP = vec2(baseP.x * c - baseP.y * s, baseP.x * s + baseP.y * c) * invScale;

  float g = 0.5;
  if (u_hasPaperTex) {
    vec2 uv = fract(rotP / max(vec2(1.0), u_paperTexSize));
    vec4 pSample = texture2D(u_paperTexture, uv);
    float lum = dot(pSample.rgb, vec3(0.299, 0.587, 0.114));
    // Composite over white: handles both CSP black-on-transparent paper textures (RGB=0, A=density)
    // and opaque grayscale heightmaps seamlessly without alpha-threshold cliffs.
    g = mix(1.0, lum, pSample.a);
  } else {
    vec2 coord = rotP * 0.09;
    float n1 = sin(coord.x * 3.1415 + coord.y * 1.7) * cos(coord.y * 2.718 - coord.x * 0.9);
    float n2 = sin(coord.x * 7.3 - coord.y * 5.1) * cos(coord.x * 4.2 + coord.y * 8.3);
    g = clamp((n1 * 0.6 + n2 * 0.4) * 0.5 + 0.5, 0.0, 1.0);
  }

  if (u_paperInvert) {
    g = 1.0 - g;
  }
  if (u_paperEmphasizeDensity) {
    g = clamp((g - 0.5) * 2.2 + 0.35, 0.0, 1.0);
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

${PIGMENT_GLSL_WEBGL1}

void main() {
  float dist = length(v_localPos);
  vec3 rgb = v_color.rgb;

  float tipAlpha = 1.0;
  if (u_hasTipTexture) {
    vec2 sampleUv = v_uv;
    if (u_tipAtlasGrid.x > 1.0 || u_tipAtlasGrid.y > 1.0) {
      float cols = max(1.0, u_tipAtlasGrid.x);
      float rows = max(1.0, u_tipAtlasGrid.y);
      float idx = floor(max(0.0, v_tipIndex) + 0.5);
      float col = mod(idx, cols);
      float row = floor(idx / cols);
      vec2 cellSize = vec2(1.0 / cols, 1.0 / rows);
      vec2 inset = cellSize * 0.004;
      sampleUv = vec2(col, row) * cellSize + inset + clamp(v_uv, 0.0, 1.0) * (cellSize - inset * 2.0);
    }
    vec4 tex = texture2D(u_tipTexture, sampleUv);
    tipAlpha = tex.a;
    if (u_isColorTip) {
      rgb = tex.rgb;
    } else if (u_isDualToneTip) {
      float lum = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
      rgb = mix(v_color.rgb, u_secondaryColor, lum);
    }
    if (u_antiAlias == 0) {
      tipAlpha = tipAlpha >= 0.5 ? 1.0 : 0.0;
    }
  } else {
    if (dist > 1.0) {
      discard;
    }
    if (u_antiAlias == 0) {
      tipAlpha = dist <= 1.0 ? 1.0 : 0.0;
    } else {
      float aaPx = u_antiAlias == 1 ? 1.3 : (u_antiAlias == 3 ? 3.8 : 2.2);
      float minDim = max(0.85, min(v_size.x, v_size.y));
      float aa = clamp(aaPx / minDim, 0.015, 0.92);
      float clampedH = clamp(u_hardness, 0.0, 1.0);
      if (clampedH <= 0.05) {
        tipAlpha = 0.5 * (1.0 + cos(min(1.0, dist) * 3.14159265));
      } else {
        float edge = min(clampedH, 1.0 - aa);
        tipAlpha = 1.0 - smoothstep(edge, 1.0, dist);
      }
    }
  }

  if (tipAlpha <= 0.002) {
    discard;
  }

  // Modulate brush tip profile (0..1) BEFORE scaling by per-dab flow (matching CSP TextureForPlot=1 & CPU/SpatialTipMixer)
  float dabPaperGrain = v_color.a >= 0.0 ? v_color.a : u_paperGrain;
  if (dabPaperGrain > 0.001 || u_dryBrush > 0.001) {
    float g = samplePaperTooth(v_worldPos);
    float p = clamp(v_pressure, 0.0, 1.0);
    float heavyExcess = max(0.0, (p - 0.52) / 0.48);
    float penetration = min(0.92, (p * 0.28 + heavyExcess * heavyExcess * 0.64) * (0.45 + 0.55 * clamp(u_paintLoad, 0.0, 1.0)));
    float effDensity = u_paperPreserveDensity
      ? max(dabPaperGrain, u_dryBrush * 0.85)
      : max(dabPaperGrain, u_dryBrush * 0.85) * (1.0 - penetration * 0.85);

    if (u_dryBrush > 0.01) {
      float cutoff = u_dryBrush * (1.0 - penetration * 0.86) * 0.78;
      float tooth = smoothstep(cutoff - 0.06, cutoff + 0.14, g);
      tipAlpha *= mix(1.0, tooth, clamp(u_dryBrush + dabPaperGrain * 0.5, 0.0, 1.0));
    } else if (u_paperMode == 1) {
      // multiply
      tipAlpha *= (1.0 - effDensity * (1.0 - g));
    } else if (u_paperMode == 2) {
      // compare
      float contactHeight = g * (0.22 + 0.78 * tipAlpha);
      float cutoff = effDensity * 0.68;
      float tooth = smoothstep(cutoff - 0.05, cutoff + 0.16, contactHeight);
      tipAlpha *= tooth;
    } else if (u_paperMode == 3) {
      // overlay
      float dMod = tipAlpha * (1.0 - effDensity * 0.32 * (1.0 - g));
      float ov = dMod < 0.5 ? (2.0 * dMod * g) : (1.0 - 2.0 * (1.0 - dMod) * (1.0 - g));
      tipAlpha = clamp(mix(tipAlpha, ov, effDensity), 0.0, 1.0);
    } else if (u_paperMode == 4) {
      // outline
      float edgeFactor = 4.0 * tipAlpha * (1.0 - tipAlpha);
      tipAlpha *= (1.0 - effDensity * (1.0 - g) * (0.35 + 0.65 * edgeFactor));
    } else if (u_paperMode == 5) {
      // normal
      float sil = min(1.0, tipAlpha * 4.0);
      tipAlpha = clamp(tipAlpha * (1.0 - effDensity) + g * sil * effDensity, 0.0, 1.0);
    } else if (u_paperMode == 6) {
      // color-burn
      float burned = g <= 0.001 ? 0.0 : max(0.0, 1.0 - (1.0 - tipAlpha) / g);
      tipAlpha = clamp(mix(tipAlpha, burned, effDensity), 0.0, 1.0);
    } else if (u_paperMode == 7) {
      // linear-burn
      float burned = max(0.0, tipAlpha + g - 1.0);
      tipAlpha = clamp(mix(tipAlpha, burned, effDensity), 0.0, 1.0);
    } else if (u_paperMode == 8) {
      // height
      float sil = min(1.0, tipAlpha * 4.0);
      float relief = clamp((tipAlpha + g - 0.5) * 1.6, 0.0, 1.0) * sil;
      tipAlpha = clamp(tipAlpha * (1.0 - effDensity) + relief * effDensity, 0.0, 1.0);
    } else {
      // 0: subtract
      float sub = (1.0 - g) * effDensity * (u_paperPreserveDensity ? 1.0 : (1.0 - penetration * 0.5));
      tipAlpha = max(0.0, tipAlpha - sub);
    }

    if (tipAlpha <= 0.002) {
      discard;
    }
  }

  float finalAlpha = clamp(tipAlpha * v_alpha, 0.0, 1.0);

  if (u_colorMixing && u_hasCanvasTexture && !u_isEraser) {
    vec2 docRes = max(vec2(1.0), u_docResolution);
    vec2 canvasUv = clamp(v_worldPos / docRes, 0.0, 1.0);
    vec4 canvasColor = texture2D(u_canvasTexture, canvasUv);

    if (canvasColor.a > 0.02) {
      float stretchDistLimit = max(20.0, u_colorStretch * 600.0);
      float stretchDecay = exp(-v_strokeDist / stretchDistLimit);
      float effectiveAmount = u_amountOfPaint >= 0.995
        ? 1.0
        : clamp(mix(u_amountOfPaint, 1.0, (1.0 - stretchDecay) * 0.35), 0.02, 1.0);
      if (u_perceptualMixing && u_pigmentStrength > 0.005) {
        rgb = mixPigmentsGpu(canvasColor.rgb, rgb, effectiveAmount, u_pigmentStrength);
      } else {
        rgb = mix(canvasColor.rgb, rgb, effectiveAmount);
      }
      finalAlpha *= mix(0.65, 1.0, u_densityOfPaint);
    }
  }

  finalAlpha = clamp(finalAlpha, 0.0, 1.0);
  if (u_antiAlias == 0) {
    finalAlpha = finalAlpha >= 0.5 ? 1.0 : 0.0;
    if (finalAlpha <= 0.0) discard;
  }

  if (u_isBgEraser) {
    gl_FragColor = vec4(1.0 * finalAlpha, 1.0 * finalAlpha, 1.0 * finalAlpha, finalAlpha);
  } else if (u_isEraser) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, finalAlpha);
  } else {
    gl_FragColor = vec4(rgb * finalAlpha, finalAlpha);
  }
}
`;

const IMPASTO_VERTEX_SHADER_SRC = `
precision highp float;
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const DUAL_COMBINE_FRAGMENT_SHADER_SRC = `
precision highp float;

varying vec2 v_uv;

uniform sampler2D u_primaryTex;
uniform sampler2D u_secondaryTex;
uniform vec2 u_uvScale;
uniform int u_combineMode;

float combineDualAlpha(float a1, float a2, int mode) {
  if (a1 <= 0.0001) return 0.0;
  float p1 = clamp(a1, 0.0, 1.0);
  float p2 = clamp(a2, 0.0, 1.0);
  if (mode == 0) {
    // multiply
    return p1 * p2;
  } else if (mode == 1) {
    // darken
    return min(p1, p2);
  } else if (mode == 2) {
    // subtract
    return max(0.0, p1 - p2);
  } else if (mode == 3) {
    // compare-density
    float sil = min(1.0, p1 * 4.0);
    return max(p1, p2 * sil);
  } else if (mode == 4) {
    // linear-burn
    return max(0.0, p1 + p2 - 1.0);
  } else if (mode == 5) {
    // color-burn
    return p2 <= 0.0001 ? 0.0 : max(0.0, 1.0 - (1.0 - p1) / p2);
  } else if (mode == 6) {
    // height
    float h = p1 + p2 - 1.0;
    float t = clamp(h * 4.0, 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
  } else if (mode == 7) {
    // overlay
    return p1 < 0.5 ? (2.0 * p1 * p2) : (1.0 - 2.0 * (1.0 - p1) * (1.0 - p2));
  } else if (mode == 8) {
    // screen
    float sil = min(1.0, p1 * 4.0);
    float eff2 = p2 * sil;
    return p1 + eff2 - p1 * eff2;
  } else if (mode == 9) {
    // lighten
    float sil = min(1.0, p1 * 4.0);
    return max(p1, p2 * sil);
  } else if (mode == 10) {
    // hard-mix
    return (p1 + p2 >= 1.0) ? 1.0 : 0.0;
  } else if (mode == 11) {
    // normal
    float sil = min(1.0, p1 * 4.0);
    float eff2 = p2 * sil;
    return p1 + eff2 * (1.0 - p1);
  }
  return p1 * p2;
}

void main() {
  vec2 uv = v_uv * u_uvScale;
  vec4 p = texture2D(u_primaryTex, uv);
  float a1 = clamp(p.a, 0.0, 1.0);
  if (a1 <= 0.0001) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec3 rgb = clamp(p.rgb / a1, 0.0, 1.0);
  float a2 = clamp(texture2D(u_secondaryTex, uv).a, 0.0, 1.0);
  float outA = clamp(combineDualAlpha(a1, a2, u_combineMode), 0.0, 1.0);
  gl_FragColor = vec4(rgb * outA, outA);
}
`;

const IMPASTO_FRAGMENT_SHADER_SRC = `
precision highp float;

varying vec2 v_uv;

uniform sampler2D u_colorTex;
uniform sampler2D u_heightTex;
uniform vec2 u_texelSize;
uniform vec3 u_lightDir;
uniform float u_depth;
uniform float u_gloss;
uniform float u_contrast;
uniform float u_granulation;
uniform float u_wetEdge;

float sampleH(vec2 uv) {
  return texture2D(u_heightTex, clamp(uv, vec2(0.0), vec2(1.0))).r;
}

void main() {
  vec4 base = texture2D(u_colorTex, v_uv);
  float alpha = base.a;
  if (alpha <= 0.003) {
    discard;
  }

  vec3 rgb = base.rgb;
  vec4 hCenter = texture2D(u_heightTex, v_uv);
  float hC = hCenter.r;
  float tooth = hCenter.g;

  if (u_granulation > 0.01) {
    float valley = 1.0 - tooth;
    rgb *= (1.0 - valley * u_granulation * 0.34);
    alpha = min(1.0, alpha * (0.82 + valley * u_granulation * 0.42));
  }

  if (u_wetEdge > 0.01) {
    vec2 step2 = u_texelSize * 2.0;
    float avgA = (
      texture2D(u_colorTex, v_uv + vec2(-step2.x, 0.0)).a +
      texture2D(u_colorTex, v_uv + vec2(step2.x, 0.0)).a +
      texture2D(u_colorTex, v_uv + vec2(0.0, -step2.y)).a +
      texture2D(u_colorTex, v_uv + vec2(0.0, step2.y)).a
    ) * 0.25;
    float rim = max(0.0, alpha - avgA) * 2.5;
    if (rim > 0.02) {
      rgb *= max(0.45, 1.0 - rim * u_wetEdge * 0.42);
      alpha = min(1.0, alpha * (1.0 + rim * u_wetEdge * 0.55));
    }
  }

  if (u_depth > 0.01) {
    float tx = u_texelSize.x;
    float ty = u_texelSize.y;

    float hTL = sampleH(v_uv + vec2(-tx, -ty));
    float hT  = sampleH(v_uv + vec2(0.0, -ty));
    float hTR = sampleH(v_uv + vec2(tx, -ty));
    float hL  = sampleH(v_uv + vec2(-tx, 0.0));
    float hR  = sampleH(v_uv + vec2(tx, 0.0));
    float hBL = sampleH(v_uv + vec2(-tx, ty));
    float hB  = sampleH(v_uv + vec2(0.0, ty));
    float hBR = sampleH(v_uv + vec2(tx, ty));

    float gx = (hTR + 2.0 * hR + hBR) - (hTL + 2.0 * hL + hBL);
    float gy = (hBL + 2.0 * hB + hBR) - (hTL + 2.0 * hT + hTR);

    float reliefScale = 3.8 + u_depth * 8.6;
    vec3 N = normalize(vec3(-gx * reliefScale, -gy * reliefScale, 1.0));
    vec3 L = normalize(u_lightDir);

    float slopeMask = min(1.0, length(vec2(gx, gy)) * 2.6);
    float diffAmp = 0.34 + u_contrast * 0.58;
    float rawDiff = dot(N, L) - L.z;
    float diffuseDelta = rawDiff * diffAmp;

    float avgH = (hT + hB + hL + hR + (hTL + hTR + hBL + hBR) * 0.5) / 6.0;
    float concavity = max(0.0, avgH - hC);
    float ao = min(0.42, concavity * (1.1 + u_contrast * 1.9));
    float shadeMult = clamp(1.0 + diffuseDelta - ao, 0.46, 1.42);

    float litSlope = max(0.0, rawDiff) * slopeMask;
    float keyLift = litSlope * (0.22 + u_gloss * 0.34) * (0.45 + u_contrast * 0.55) * 0.45;

    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float nDotH = max(0.0, dot(N, H));
    float satinSpec = pow(nDotH, 10.0 + u_gloss * 10.0) * (0.12 + u_gloss * 0.24) * (0.45 + u_depth * 0.65) * slopeMask * 0.55;
    float crispSpec = pow(nDotH, 36.0 + u_gloss * 56.0) * u_gloss * (0.28 + u_depth * 0.56) * slopeMask;
    float totalSpec = keyLift + satinSpec + crispSpec;

    rgb = clamp(rgb * shadeMult + vec3(totalSpec, totalSpec * 0.985, totalSpec * 0.95), 0.0, 1.0);
  }

  gl_FragColor = vec4(rgb * alpha, alpha);
}
`;

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

const TEXTURED_RIBBON_VERTEX_SHADER_SRC = `
precision highp float;

attribute vec2 a_pos;
attribute vec2 a_uv;
attribute float a_alpha;
attribute float a_pressure;
attribute float a_tipIndex;
attribute vec2 a_edgeInfo;

uniform vec2 u_canvasResolution;
uniform vec2 u_dirtyOffset;

varying vec2 v_uv;
varying float v_alpha;
varying float v_pressure;
varying float v_tipIndex;
varying vec2 v_edgeInfo;
varying vec2 v_worldPos;

void main() {
  v_uv = a_uv;
  v_alpha = a_alpha;
  v_pressure = a_pressure;
  v_tipIndex = a_tipIndex;
  v_edgeInfo = a_edgeInfo;
  v_worldPos = a_pos;

  vec2 clipPos = ((a_pos - u_dirtyOffset) / u_canvasResolution) * 2.0 - 1.0;
  clipPos.y = -clipPos.y;

  gl_Position = vec4(clipPos, 0.0, 1.0);
}
`;

const TEXTURED_RIBBON_FRAGMENT_SHADER_SRC = `
precision highp float;

varying vec2 v_uv;
varying float v_alpha;
varying float v_pressure;
varying float v_tipIndex;
varying vec2 v_edgeInfo;
varying vec2 v_worldPos;

uniform bool u_hasTipTexture;
uniform sampler2D u_tipTexture;
uniform vec2 u_tipAtlasGrid;
uniform bool u_isColorTip;
uniform bool u_isDualToneTip;
uniform vec3 u_primaryColor;
uniform vec3 u_secondaryColor;
uniform int u_antiAlias;

uniform float u_paperGrain;
uniform float u_grainScale;
uniform float u_grainRotateRad;
uniform int u_paperMode;
uniform float u_paperBrightness;
uniform float u_paperContrast;
uniform bool u_paperInvert;
uniform bool u_paperPreserveDensity;
uniform bool u_paperEmphasizeDensity;
uniform bool u_hasPaperTex;
uniform sampler2D u_paperTexture;
uniform vec2 u_paperTexSize;

uniform bool u_isEraser;
uniform bool u_isBgEraser;

float sampleRibbonPaperTooth(vec2 worldPos) {
  float invScale = 1.0 / max(0.05, u_grainScale);
  float c = cos(u_grainRotateRad);
  float s = sin(u_grainRotateRad);
  vec2 rotP = vec2(worldPos.x * c - worldPos.y * s, worldPos.x * s + worldPos.y * c) * invScale;

  float g = 0.5;
  if (u_hasPaperTex) {
    vec2 uv = fract(rotP / max(vec2(1.0), u_paperTexSize));
    vec4 pSample = texture2D(u_paperTexture, uv);
    float lum = dot(pSample.rgb, vec3(0.299, 0.587, 0.114));
    g = mix(1.0, lum, pSample.a);
  } else {
    vec2 coord = rotP * 0.09;
    float n1 = sin(coord.x * 3.1415 + coord.y * 1.7) * cos(coord.y * 2.718 - coord.x * 0.9);
    float n2 = sin(coord.x * 7.3 - coord.y * 5.1) * cos(coord.x * 4.2 + coord.y * 8.3);
    g = clamp((n1 * 0.6 + n2 * 0.4) * 0.5 + 0.5, 0.0, 1.0);
  }

  if (u_paperInvert) {
    g = 1.0 - g;
  }
  if (u_paperEmphasizeDensity) {
    g = clamp((g - 0.5) * 2.2 + 0.35, 0.0, 1.0);
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

void main() {
  if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) {
    discard;
  }

  vec3 rgb = u_primaryColor;
  float tipAlpha = 1.0;

  if (u_hasTipTexture) {
    vec2 sampleUv = v_uv;
    if (u_tipAtlasGrid.x > 1.0 || u_tipAtlasGrid.y > 1.0) {
      float cols = max(1.0, u_tipAtlasGrid.x);
      float rows = max(1.0, u_tipAtlasGrid.y);
      float idx = floor(max(0.0, v_tipIndex) + 0.5);
      float col = mod(idx, cols);
      float row = floor(idx / cols);
      vec2 cellSize = vec2(1.0 / cols, 1.0 / rows);
      vec2 inset = cellSize * 0.004;
      sampleUv = vec2(col, row) * cellSize + inset + clamp(v_uv, 0.0, 1.0) * (cellSize - inset * 2.0);
    }
    vec4 tex = texture2D(u_tipTexture, sampleUv);
    tipAlpha = tex.a;
    if (!u_isEraser && !u_isBgEraser) {
      if (u_isColorTip) {
        rgb = tex.rgb;
      } else if (u_isDualToneTip) {
        float lum = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
        rgb = mix(u_primaryColor, u_secondaryColor, lum);
      }
    }
  } else {
    tipAlpha = 1.0 - smoothstep(0.85, 1.0, abs(v_edgeInfo.x));
  }

  if (u_antiAlias == 0) {
    tipAlpha = tipAlpha >= 0.5 ? 1.0 : 0.0;
  } else {
    float edgePx = u_antiAlias == 1 ? 0.65 : (u_antiAlias == 3 ? 1.85 : 1.15);
    float edgeUv = clamp(edgePx / max(1.0, v_edgeInfo.y), 0.0, 0.45);
    if (edgeUv > 0.0001) {
      float edgeMask = 1.0 - smoothstep(1.0 - edgeUv * 2.0, 1.0, abs(v_edgeInfo.x));
      tipAlpha *= edgeMask;
    }
  }

  if (tipAlpha <= 0.002) {
    discard;
  }

  // Modulate ribbon tip profile (0..1) BEFORE scaling by per-vertex flow (matching CSP TextureForPlot=1 & CPU)
  if (u_paperGrain > 0.005) {
    float g = sampleRibbonPaperTooth(v_worldPos);
    float p = clamp(v_pressure, 0.0, 1.0);
    float heavyExcess = max(0.0, (p - 0.52) / 0.48);
    float penetration = min(0.92, p * 0.28 + heavyExcess * heavyExcess * 0.64);
    float effDensity = u_paperPreserveDensity
      ? u_paperGrain
      : u_paperGrain * (1.0 - penetration * 0.85);

    if (u_paperMode == 1) {
      tipAlpha *= (1.0 - effDensity * (1.0 - g));
    } else if (u_paperMode == 2) {
      float contactHeight = g * (0.22 + 0.78 * tipAlpha);
      float cutoff = effDensity * 0.68;
      float tooth = smoothstep(cutoff - 0.05, cutoff + 0.16, contactHeight);
      tipAlpha *= tooth;
    } else if (u_paperMode == 3) {
      float dMod = tipAlpha * (1.0 - effDensity * 0.32 * (1.0 - g));
      float ov = dMod < 0.5 ? (2.0 * dMod * g) : (1.0 - 2.0 * (1.0 - dMod) * (1.0 - g));
      tipAlpha = clamp(mix(tipAlpha, ov, effDensity), 0.0, 1.0);
    } else if (u_paperMode == 4) {
      float edgeFactor = 4.0 * tipAlpha * (1.0 - tipAlpha);
      tipAlpha *= (1.0 - effDensity * (1.0 - g) * (0.35 + 0.65 * edgeFactor));
    } else if (u_paperMode == 5) {
      float sil = min(1.0, tipAlpha * 4.0);
      tipAlpha = clamp(tipAlpha * (1.0 - effDensity) + g * sil * effDensity, 0.0, 1.0);
    } else if (u_paperMode == 6) {
      float burned = g <= 0.001 ? 0.0 : max(0.0, 1.0 - (1.0 - tipAlpha) / g);
      tipAlpha = clamp(mix(tipAlpha, burned, effDensity), 0.0, 1.0);
    } else if (u_paperMode == 7) {
      float burned = max(0.0, tipAlpha + g - 1.0);
      tipAlpha = clamp(mix(tipAlpha, burned, effDensity), 0.0, 1.0);
    } else if (u_paperMode == 8) {
      float sil = min(1.0, tipAlpha * 4.0);
      float relief = clamp((tipAlpha + g - 0.5) * 1.6, 0.0, 1.0) * sil;
      tipAlpha = clamp(tipAlpha * (1.0 - effDensity) + relief * effDensity, 0.0, 1.0);
    } else {
      float sub = (1.0 - g) * effDensity * (u_paperPreserveDensity ? 1.0 : (1.0 - penetration * 0.5));
      tipAlpha = max(0.0, tipAlpha - sub);
    }

    if (tipAlpha <= 0.002) {
      discard;
    }
  }

  float finalAlpha = clamp(tipAlpha * v_alpha, 0.0, 1.0);

  finalAlpha = clamp(finalAlpha, 0.0, 1.0);
  if (u_antiAlias == 0) {
    finalAlpha = finalAlpha >= 0.5 ? 1.0 : 0.0;
    if (finalAlpha <= 0.0) discard;
  }

  if (u_isBgEraser) {
    gl_FragColor = vec4(finalAlpha, finalAlpha, finalAlpha, finalAlpha);
  } else if (u_isEraser) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, finalAlpha);
  } else {
    gl_FragColor = vec4(rgb * finalAlpha, finalAlpha);
  }
}
`;

const MAX_TILE_CHUNK = 2048;

/**
 * WebGL1/WebGL2 GPU hardware brush rasterizer.
 * Executes instanced dab batches and ribbon meshes with zero per-draw driver queries.
 */
export class WebGlBrushEngine {
  private static instance: WebGlBrushEngine | null = null;
  private static builtinGrainTable: Uint8Array | null = null;
  private static builtinGrainSize: number = 512;

  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private ribbonProgram: WebGLProgram | null = null;
  private texturedRibbonProgram: WebGLProgram | null = null;
  private impastoProgram: WebGLProgram | null = null;
  private dualCombineProgram: WebGLProgram | null = null;
  private isGpuAvailable = false;
  private gpuInfo: GpuInfo = {
    isSupported: false,
    renderer: 'CPU Fallback',
    vendor: 'Standard',
    glVersion: 'None',
  };

  private aQuadVertexLoc = -1;
  private aCenterLoc = -1;
  private aSizeLoc = -1;
  private aAngleLoc = -1;
  private aColorLoc = -1;
  private aAlphaLoc = -1;
  private aPressureLoc = -1;
  private aStrokeDistLoc = -1;
  private aFlipLoc = -1;
  private aTipIndexLoc = -1;

  private uCanvasResolutionLoc: WebGLUniformLocation | null = null;
  private uDocResolutionLoc: WebGLUniformLocation | null = null;
  private uDirtyOffsetLoc: WebGLUniformLocation | null = null;
  private uHasTipTextureLoc: WebGLUniformLocation | null = null;
  private uIsColorTipLoc: WebGLUniformLocation | null = null;
  private uIsDualToneTipLoc: WebGLUniformLocation | null = null;
  private uSecondaryColorLoc: WebGLUniformLocation | null = null;
  private uTipTextureLoc: WebGLUniformLocation | null = null;
  private uTipAtlasGridLoc: WebGLUniformLocation | null = null;
  private uAntiAliasLoc: WebGLUniformLocation | null = null;
  private uHardnessLoc: WebGLUniformLocation | null = null;
  private uWetEdgeLoc: WebGLUniformLocation | null = null;
  private uPaperGrainLoc: WebGLUniformLocation | null = null;
  private uGrainScaleLoc: WebGLUniformLocation | null = null;
  private uGrainRotateRadLoc: WebGLUniformLocation | null = null;
  private uGrainMappingModeLoc: WebGLUniformLocation | null = null;
  private uGrainRandomOffsetLoc: WebGLUniformLocation | null = null;
  private uGrainRandomRotLoc: WebGLUniformLocation | null = null;
  private uDryBrushLoc: WebGLUniformLocation | null = null;
  private uPaintLoadLoc: WebGLUniformLocation | null = null;
  private uPaperModeLoc: WebGLUniformLocation | null = null;
  private uPaperBrightnessLoc: WebGLUniformLocation | null = null;
  private uPaperContrastLoc: WebGLUniformLocation | null = null;
  private uPaperInvertLoc: WebGLUniformLocation | null = null;
  private uPaperPreserveDensityLoc: WebGLUniformLocation | null = null;
  private uPaperEmphasizeDensityLoc: WebGLUniformLocation | null = null;
  private uHasPaperTexLoc: WebGLUniformLocation | null = null;
  private uPaperTextureLoc: WebGLUniformLocation | null = null;
  private uPaperTexSizeLoc: WebGLUniformLocation | null = null;
  private uColorMixingLoc: WebGLUniformLocation | null = null;
  private uPerceptualMixingLoc: WebGLUniformLocation | null = null;
  private uPigmentStrengthLoc: WebGLUniformLocation | null = null;
  private uPigmentLutLoc: WebGLUniformLocation | null = null;
  private uHasCanvasTextureLoc: WebGLUniformLocation | null = null;
  private uCanvasTextureLoc: WebGLUniformLocation | null = null;
  private uAmountOfPaintLoc: WebGLUniformLocation | null = null;
  private uDensityOfPaintLoc: WebGLUniformLocation | null = null;
  private uColorStretchLoc: WebGLUniformLocation | null = null;
  private uIsEraserLoc: WebGLUniformLocation | null = null;
  private uIsBgEraserLoc: WebGLUniformLocation | null = null;

  private uRibbonCanvasResolutionLoc: WebGLUniformLocation | null = null;
  private uRibbonDirtyOffsetLoc: WebGLUniformLocation | null = null;
  private aRibbonPosLoc = -1;
  private aRibbonNormalDistLoc = -1;
  private aRibbonColorLoc = -1;
  private aRibbonWidthLoc = -1;

  // Textured CSP Ribbon Program locations & buffer
  private aTexRibPosLoc = -1;
  private aTexRibUvLoc = -1;
  private aTexRibAlphaLoc = -1;
  private aTexRibPressureLoc = -1;
  private aTexRibTipIndexLoc = -1;
  private aTexRibEdgeInfoLoc = -1;
  private uTexRibCanvasResolutionLoc: WebGLUniformLocation | null = null;
  private uTexRibDirtyOffsetLoc: WebGLUniformLocation | null = null;
  private uTexRibHasTipTextureLoc: WebGLUniformLocation | null = null;
  private uTexRibTipTextureLoc: WebGLUniformLocation | null = null;
  private uTexRibTipAtlasGridLoc: WebGLUniformLocation | null = null;
  private uTexRibIsColorTipLoc: WebGLUniformLocation | null = null;
  private uTexRibIsDualToneTipLoc: WebGLUniformLocation | null = null;
  private uTexRibPrimaryColorLoc: WebGLUniformLocation | null = null;
  private uTexRibSecondaryColorLoc: WebGLUniformLocation | null = null;
  private uTexRibAntiAliasLoc: WebGLUniformLocation | null = null;
  private uTexRibPaperGrainLoc: WebGLUniformLocation | null = null;
  private uTexRibGrainScaleLoc: WebGLUniformLocation | null = null;
  private uTexRibGrainRotateRadLoc: WebGLUniformLocation | null = null;
  private uTexRibPaperModeLoc: WebGLUniformLocation | null = null;
  private uTexRibPaperBrightnessLoc: WebGLUniformLocation | null = null;
  private uTexRibPaperContrastLoc: WebGLUniformLocation | null = null;
  private uTexRibPaperInvertLoc: WebGLUniformLocation | null = null;
  private uTexRibPaperPreserveDensityLoc: WebGLUniformLocation | null = null;
  private uTexRibPaperEmphasizeDensityLoc: WebGLUniformLocation | null = null;
  private uTexRibHasPaperTexLoc: WebGLUniformLocation | null = null;
  private uTexRibPaperTextureLoc: WebGLUniformLocation | null = null;
  private uTexRibPaperTexSizeLoc: WebGLUniformLocation | null = null;
  private uTexRibIsEraserLoc: WebGLUniformLocation | null = null;
  private uTexRibIsBgEraserLoc: WebGLUniformLocation | null = null;
  private texturedRibbonBuffer: WebGLBuffer | null = null;

  // Impasto Relief Post-Pass locations & resources
  private aImpastoPosLoc = -1;
  private uImpastoColorTexLoc: WebGLUniformLocation | null = null;
  private uImpastoHeightTexLoc: WebGLUniformLocation | null = null;
  private uImpastoTexelSizeLoc: WebGLUniformLocation | null = null;
  private uImpastoLightDirLoc: WebGLUniformLocation | null = null;
  private uImpastoDepthLoc: WebGLUniformLocation | null = null;
  private uImpastoGlossLoc: WebGLUniformLocation | null = null;
  private uImpastoContrastLoc: WebGLUniformLocation | null = null;
  private uImpastoGranulationLoc: WebGLUniformLocation | null = null;
  private uImpastoWetEdgeLoc: WebGLUniformLocation | null = null;
  private fullQuadBuffer: WebGLBuffer | null = null;
  private impastoColorTex: WebGLTexture | null = null;
  private impastoHeightTex: WebGLTexture | null = null;

  private tipTexturesMap = new Map<string, WebGLTexture>();
  private multiTipAtlasCache = new Map<string, { tex: WebGLTexture; cols: number; rows: number }>();
  private surfaceTexturesMap = new Map<SurfaceTextureId, WebGLTexture>();
  private builtinPaperTexture: WebGLTexture | null = null;
  private canvasLayerTexture: WebGLTexture | null = null;
  private canvasLayerWidth = 0;
  private canvasLayerHeight = 0;
  private canvasLayerSource: HTMLCanvasElement | null = null;

  private dabFbo: WebGLFramebuffer | null = null;
  private dabFboTex: WebGLTexture | null = null;
  private dabFboWidth = 0;
  private dabFboHeight = 0;

  // Dual Brush two-pass FBO & fullscreen combine shader locations
  private aDualCombinePosLoc = -1;
  private uDualCombinePrimaryTexLoc: WebGLUniformLocation | null = null;
  private uDualCombineSecondaryTexLoc: WebGLUniformLocation | null = null;
  private uDualCombineUvScaleLoc: WebGLUniformLocation | null = null;
  private uDualCombineModeLoc: WebGLUniformLocation | null = null;
  private dualPrimaryFbo: WebGLFramebuffer | null = null;
  private dualPrimaryTex: WebGLTexture | null = null;
  private dualSecondaryFbo: WebGLFramebuffer | null = null;
  private dualSecondaryTex: WebGLTexture | null = null;
  private dualFboWidth = 0;
  private dualFboHeight = 0;

  private quadVertexBuffer: WebGLBuffer | null = null;
  private extInstanced: {
    drawArraysInstanced: (mode: number, first: number, count: number, instanceCount: number) => void;
    vertexAttribDivisor: (index: number, divisor: number) => void;
  } | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private instanceArray: Float32Array = new Float32Array(4096 * 15);
  private secondaryInstanceBuffer: WebGLBuffer | null = null;
  private secondaryInstanceArray: Float32Array = new Float32Array(2048 * 15);
  private blendMaxEnum: number | null = null;

  private ribbonBuffer: WebGLBuffer | null = null;
  private ribbonArray: Float32Array = new Float32Array(1024 * 8);

  public static setBuiltinPaperGrain(table: Uint8Array, size: number): void {
    WebGlBrushEngine.builtinGrainTable = table;
    WebGlBrushEngine.builtinGrainSize = size;
    if (WebGlBrushEngine.instance?.gl && !WebGlBrushEngine.instance.builtinPaperTexture) {
      WebGlBrushEngine.instance.uploadBuiltinPaperTexture(WebGlBrushEngine.instance.gl);
    }
  }

  private activePowerPreference: WebGLPowerPreference = 'high-performance';

  private constructor() {
    this.initCanvasAndGl();
  }

  private initCanvasAndGl() {
    const perf = performanceManager.getConfig();
    if (perf.renderBackend === 'canvas2d' || !perf.gpuBrushAcceleration) {
      this.isGpuAvailable = false;
      this.gpuInfo = {
        isSupported: false,
        renderer: 'CPU Fallback (GPU Brush Disabled)',
        vendor: 'Standard',
        glVersion: 'None',
      };
      return;
    }
    this.activePowerPreference = perf.gpuPowerPreference || 'high-performance';

    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = 1024;
      c.height = 1024;
      this.canvas = c;
      if (typeof c.addEventListener === 'function') {
        c.addEventListener('webglcontextlost', (ev) => {
          ev.preventDefault();
          this.isGpuAvailable = false;
          this.clearTextureMapsState();
        });
        c.addEventListener('webglcontextrestored', () => {
          this.initGl();
        });
      }
      this.initGl();
    }
  }

  private clearTextureMapsState() {
    invalidatePigmentLutTexture(this.gl, false);
    this.tipTexturesMap.clear();
    this.multiTipAtlasCache.clear();
    this.surfaceTexturesMap.clear();
    this.builtinPaperTexture = null;
    this.canvasLayerTexture = null;
    this.canvasLayerWidth = 0;
    this.canvasLayerHeight = 0;
    this.canvasLayerSource = null;
    this.impastoColorTex = null;
    this.impastoHeightTex = null;
    this.dabFbo = null;
    this.dabFboTex = null;
    this.dabFboWidth = 0;
    this.dabFboHeight = 0;
    this.dualPrimaryFbo = null;
    this.dualPrimaryTex = null;
    this.dualSecondaryFbo = null;
    this.dualSecondaryTex = null;
    this.dualFboWidth = 0;
    this.dualFboHeight = 0;
  }

  /**
   * Releases cached brush tip/surface/layer textures to immediately reclaim GPU VRAM.
   */
  public releaseCaches(): void {
    const gl = this.gl;
    if (gl) {
      for (const tex of this.tipTexturesMap.values()) gl.deleteTexture(tex);
      for (const entry of this.multiTipAtlasCache.values()) gl.deleteTexture(entry.tex);
      for (const tex of this.surfaceTexturesMap.values()) gl.deleteTexture(tex);
      if (this.canvasLayerTexture) gl.deleteTexture(this.canvasLayerTexture);
      if (this.impastoColorTex) gl.deleteTexture(this.impastoColorTex);
      if (this.impastoHeightTex) gl.deleteTexture(this.impastoHeightTex);
      if (this.dualPrimaryTex) gl.deleteTexture(this.dualPrimaryTex);
      if (this.dualSecondaryTex) gl.deleteTexture(this.dualSecondaryTex);
      if (this.dualPrimaryFbo) gl.deleteFramebuffer(this.dualPrimaryFbo);
      if (this.dualSecondaryFbo) gl.deleteFramebuffer(this.dualSecondaryFbo);
    }
    this.tipTexturesMap.clear();
    this.multiTipAtlasCache.clear();
    this.surfaceTexturesMap.clear();
    this.canvasLayerTexture = null;
    this.canvasLayerWidth = 0;
    this.canvasLayerHeight = 0;
    this.canvasLayerSource = null;
    this.impastoColorTex = null;
    this.impastoHeightTex = null;
    this.dualPrimaryTex = null;
    this.dualSecondaryTex = null;
    this.dualPrimaryFbo = null;
    this.dualSecondaryFbo = null;
    this.dualFboWidth = 0;
    this.dualFboHeight = 0;
  }

  /**
   * Reconfigures GPU brush engine when renderBackend, gpuPowerPreference, or gpuBrushAcceleration changes.
   */
  public reconfigureFromPerformance(): void {
    const perf = performanceManager.getConfig();
    const shouldEnable = perf.renderBackend !== 'canvas2d' && perf.gpuBrushAcceleration;
    const nextPower: WebGLPowerPreference = perf.gpuPowerPreference || 'high-performance';

    if (!shouldEnable) {
      this.releaseCaches();
      if (this.gl) {
        this.gl.getExtension?.('WEBGL_lose_context')?.loseContext?.();
      }
      this.gl = null;
      this.program = null;
      this.ribbonProgram = null;
      this.texturedRibbonProgram = null;
      this.texturedRibbonBuffer = null;
      this.impastoProgram = null;
      this.dualCombineProgram = null;
      this.canvas = null;
      this.isGpuAvailable = false;
      this.clearTextureMapsState();
      this.gpuInfo = {
        isSupported: false,
        renderer: 'CPU Fallback (GPU Brush Disabled)',
        vendor: 'Standard',
        glVersion: 'None',
      };
      return;
    }

    if (this.isGpuAvailable && this.activePowerPreference === nextPower) {
      return;
    }

    this.releaseCaches();
    if (this.gl) {
      this.gl.getExtension?.('WEBGL_lose_context')?.loseContext?.();
    }
    this.gl = null;
    this.program = null;
    this.ribbonProgram = null;
    this.texturedRibbonProgram = null;
    this.texturedRibbonBuffer = null;
    this.impastoProgram = null;
    this.dualCombineProgram = null;
    this.canvas = null;
    this.isGpuAvailable = false;
    this.clearTextureMapsState();
    this.initCanvasAndGl();
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
        powerPreference: this.activePowerPreference,
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

      this.gpuInfo = { isSupported: true, renderer, vendor, glVersion };

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
            this.aQuadVertexLoc = gl.getAttribLocation(program, 'a_quadVertex');
            this.aCenterLoc = gl.getAttribLocation(program, 'a_center');
            this.aSizeLoc = gl.getAttribLocation(program, 'a_size');
            this.aAngleLoc = gl.getAttribLocation(program, 'a_angle');
            this.aColorLoc = gl.getAttribLocation(program, 'a_color');
            this.aAlphaLoc = gl.getAttribLocation(program, 'a_alpha');
            this.aPressureLoc = gl.getAttribLocation(program, 'a_pressure');
            this.aStrokeDistLoc = gl.getAttribLocation(program, 'a_strokeDist');
            this.aFlipLoc = gl.getAttribLocation(program, 'a_flip');
            this.aTipIndexLoc = gl.getAttribLocation(program, 'a_tipIndex');

            this.uCanvasResolutionLoc = gl.getUniformLocation(program, 'u_canvasResolution');
            this.uDocResolutionLoc = gl.getUniformLocation(program, 'u_docResolution');
            this.uDirtyOffsetLoc = gl.getUniformLocation(program, 'u_dirtyOffset');
            this.uHasTipTextureLoc = gl.getUniformLocation(program, 'u_hasTipTexture');
            this.uIsColorTipLoc = gl.getUniformLocation(program, 'u_isColorTip');
            this.uIsDualToneTipLoc = gl.getUniformLocation(program, 'u_isDualToneTip');
            this.uSecondaryColorLoc = gl.getUniformLocation(program, 'u_secondaryColor');
            this.uTipTextureLoc = gl.getUniformLocation(program, 'u_tipTexture');
            this.uTipAtlasGridLoc = gl.getUniformLocation(program, 'u_tipAtlasGrid');
            this.uAntiAliasLoc = gl.getUniformLocation(program, 'u_antiAlias');
            this.uHardnessLoc = gl.getUniformLocation(program, 'u_hardness');
            this.uWetEdgeLoc = gl.getUniformLocation(program, 'u_wetEdge');
            this.uPaperGrainLoc = gl.getUniformLocation(program, 'u_paperGrain');
            this.uGrainScaleLoc = gl.getUniformLocation(program, 'u_grainScale');
            this.uGrainRotateRadLoc = gl.getUniformLocation(program, 'u_grainRotateRad');
            this.uGrainMappingModeLoc = gl.getUniformLocation(program, 'u_grainMappingMode');
            this.uGrainRandomOffsetLoc = gl.getUniformLocation(program, 'u_grainRandomOffset');
            this.uGrainRandomRotLoc = gl.getUniformLocation(program, 'u_grainRandomRot');
            this.uDryBrushLoc = gl.getUniformLocation(program, 'u_dryBrush');
            this.uPaintLoadLoc = gl.getUniformLocation(program, 'u_paintLoad');
            this.uPaperModeLoc = gl.getUniformLocation(program, 'u_paperMode');
            this.uPaperBrightnessLoc = gl.getUniformLocation(program, 'u_paperBrightness');
            this.uPaperContrastLoc = gl.getUniformLocation(program, 'u_paperContrast');
            this.uPaperInvertLoc = gl.getUniformLocation(program, 'u_paperInvert');
            this.uPaperPreserveDensityLoc = gl.getUniformLocation(program, 'u_paperPreserveDensity');
            this.uPaperEmphasizeDensityLoc = gl.getUniformLocation(program, 'u_paperEmphasizeDensity');
            this.uHasPaperTexLoc = gl.getUniformLocation(program, 'u_hasPaperTex');
            this.uPaperTextureLoc = gl.getUniformLocation(program, 'u_paperTexture');
            this.uPaperTexSizeLoc = gl.getUniformLocation(program, 'u_paperTexSize');
            this.uColorMixingLoc = gl.getUniformLocation(program, 'u_colorMixing');
            this.uPerceptualMixingLoc = gl.getUniformLocation(program, 'u_perceptualMixing');
            this.uPigmentStrengthLoc = gl.getUniformLocation(program, 'u_pigmentStrength');
            this.uPigmentLutLoc = gl.getUniformLocation(program, 'u_pigmentLut');
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

      const trVs = this.compileShader(gl.VERTEX_SHADER, TEXTURED_RIBBON_VERTEX_SHADER_SRC);
      const trFs = this.compileShader(gl.FRAGMENT_SHADER, TEXTURED_RIBBON_FRAGMENT_SHADER_SRC);
      if (trVs && trFs) {
        const trProgram = gl.createProgram();
        if (trProgram) {
          gl.attachShader(trProgram, trVs);
          gl.attachShader(trProgram, trFs);
          gl.linkProgram(trProgram);
          if (gl.getProgramParameter(trProgram, gl.LINK_STATUS)) {
            this.texturedRibbonProgram = trProgram;
            this.aTexRibPosLoc = gl.getAttribLocation(trProgram, 'a_pos');
            this.aTexRibUvLoc = gl.getAttribLocation(trProgram, 'a_uv');
            this.aTexRibAlphaLoc = gl.getAttribLocation(trProgram, 'a_alpha');
            this.aTexRibPressureLoc = gl.getAttribLocation(trProgram, 'a_pressure');
            this.aTexRibTipIndexLoc = gl.getAttribLocation(trProgram, 'a_tipIndex');
            this.aTexRibEdgeInfoLoc = gl.getAttribLocation(trProgram, 'a_edgeInfo');

            this.uTexRibCanvasResolutionLoc = gl.getUniformLocation(trProgram, 'u_canvasResolution');
            this.uTexRibDirtyOffsetLoc = gl.getUniformLocation(trProgram, 'u_dirtyOffset');
            this.uTexRibHasTipTextureLoc = gl.getUniformLocation(trProgram, 'u_hasTipTexture');
            this.uTexRibTipTextureLoc = gl.getUniformLocation(trProgram, 'u_tipTexture');
            this.uTexRibTipAtlasGridLoc = gl.getUniformLocation(trProgram, 'u_tipAtlasGrid');
            this.uTexRibIsColorTipLoc = gl.getUniformLocation(trProgram, 'u_isColorTip');
            this.uTexRibIsDualToneTipLoc = gl.getUniformLocation(trProgram, 'u_isDualToneTip');
            this.uTexRibPrimaryColorLoc = gl.getUniformLocation(trProgram, 'u_primaryColor');
            this.uTexRibSecondaryColorLoc = gl.getUniformLocation(trProgram, 'u_secondaryColor');
            this.uTexRibAntiAliasLoc = gl.getUniformLocation(trProgram, 'u_antiAlias');
            this.uTexRibPaperGrainLoc = gl.getUniformLocation(trProgram, 'u_paperGrain');
            this.uTexRibGrainScaleLoc = gl.getUniformLocation(trProgram, 'u_grainScale');
            this.uTexRibGrainRotateRadLoc = gl.getUniformLocation(trProgram, 'u_grainRotateRad');
            this.uTexRibPaperModeLoc = gl.getUniformLocation(trProgram, 'u_paperMode');
            this.uTexRibPaperBrightnessLoc = gl.getUniformLocation(trProgram, 'u_paperBrightness');
            this.uTexRibPaperContrastLoc = gl.getUniformLocation(trProgram, 'u_paperContrast');
            this.uTexRibPaperInvertLoc = gl.getUniformLocation(trProgram, 'u_paperInvert');
            this.uTexRibPaperPreserveDensityLoc = gl.getUniformLocation(trProgram, 'u_paperPreserveDensity');
            this.uTexRibPaperEmphasizeDensityLoc = gl.getUniformLocation(trProgram, 'u_paperEmphasizeDensity');
            this.uTexRibHasPaperTexLoc = gl.getUniformLocation(trProgram, 'u_hasPaperTex');
            this.uTexRibPaperTextureLoc = gl.getUniformLocation(trProgram, 'u_paperTexture');
            this.uTexRibPaperTexSizeLoc = gl.getUniformLocation(trProgram, 'u_paperTexSize');
            this.uTexRibIsEraserLoc = gl.getUniformLocation(trProgram, 'u_isEraser');
            this.uTexRibIsBgEraserLoc = gl.getUniformLocation(trProgram, 'u_isBgEraser');
          }
        }
      }

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

      const iVs = this.compileShader(gl.VERTEX_SHADER, IMPASTO_VERTEX_SHADER_SRC);
      const iFs = this.compileShader(gl.FRAGMENT_SHADER, IMPASTO_FRAGMENT_SHADER_SRC);
      if (iVs && iFs) {
        const iProgram = gl.createProgram();
        if (iProgram) {
          gl.attachShader(iProgram, iVs);
          gl.attachShader(iProgram, iFs);
          gl.linkProgram(iProgram);
          if (gl.getProgramParameter(iProgram, gl.LINK_STATUS)) {
            this.impastoProgram = iProgram;
            this.aImpastoPosLoc = gl.getAttribLocation(iProgram, 'a_pos');
            this.uImpastoColorTexLoc = gl.getUniformLocation(iProgram, 'u_colorTex');
            this.uImpastoHeightTexLoc = gl.getUniformLocation(iProgram, 'u_heightTex');
            this.uImpastoTexelSizeLoc = gl.getUniformLocation(iProgram, 'u_texelSize');
            this.uImpastoLightDirLoc = gl.getUniformLocation(iProgram, 'u_lightDir');
            this.uImpastoDepthLoc = gl.getUniformLocation(iProgram, 'u_depth');
            this.uImpastoGlossLoc = gl.getUniformLocation(iProgram, 'u_gloss');
            this.uImpastoContrastLoc = gl.getUniformLocation(iProgram, 'u_contrast');
            this.uImpastoGranulationLoc = gl.getUniformLocation(iProgram, 'u_granulation');
            this.uImpastoWetEdgeLoc = gl.getUniformLocation(iProgram, 'u_wetEdge');
          }
        }
      }

      this.fullQuadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fullQuadBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW
      );

      const dcVs = this.compileShader(gl.VERTEX_SHADER, IMPASTO_VERTEX_SHADER_SRC);
      const dcFs = this.compileShader(gl.FRAGMENT_SHADER, DUAL_COMBINE_FRAGMENT_SHADER_SRC);
      if (dcVs && dcFs) {
        const dcProgram = gl.createProgram();
        if (dcProgram) {
          gl.attachShader(dcProgram, dcVs);
          gl.attachShader(dcProgram, dcFs);
          gl.linkProgram(dcProgram);
          if (gl.getProgramParameter(dcProgram, gl.LINK_STATUS)) {
            this.dualCombineProgram = dcProgram;
            this.aDualCombinePosLoc = gl.getAttribLocation(dcProgram, 'a_pos');
            this.uDualCombinePrimaryTexLoc = gl.getUniformLocation(dcProgram, 'u_primaryTex');
            this.uDualCombineSecondaryTexLoc = gl.getUniformLocation(dcProgram, 'u_secondaryTex');
            this.uDualCombineUvScaleLoc = gl.getUniformLocation(dcProgram, 'u_uvScale');
            this.uDualCombineModeLoc = gl.getUniformLocation(dcProgram, 'u_combineMode');
          }
        }
      }

      this.ribbonBuffer = gl.createBuffer();
      this.texturedRibbonBuffer = gl.createBuffer();

      if ('drawArraysInstanced' in gl) {
        this.extInstanced = {
          drawArraysInstanced: (mode, first, count, instanceCount) => {
            (gl as WebGL2RenderingContext).drawArraysInstanced(mode, first, count, instanceCount);
          },
          vertexAttribDivisor: (index, divisor) => {
            (gl as WebGL2RenderingContext).vertexAttribDivisor(index, divisor);
          },
        };
      } else if (typeof gl.getExtension === 'function') {
        const ext = gl.getExtension('ANGLE_instanced_arrays');
        if (ext) {
          this.extInstanced = {
            drawArraysInstanced: (mode, first, count, instanceCount) => {
              ext.drawArraysInstancedANGLE(mode, first, count, instanceCount);
            },
            vertexAttribDivisor: (index, divisor) => {
              ext.vertexAttribDivisorANGLE(index, divisor);
            },
          };
        }
      }
      this.instanceBuffer = gl.createBuffer();
      this.secondaryInstanceBuffer = gl.createBuffer();

      if (WebGlBrushEngine.builtinGrainTable) {
        this.uploadBuiltinPaperTexture(gl);
      }

      this.blendMaxEnum = null;
      if ('MAX' in gl && typeof (gl as WebGL2RenderingContext).MAX === 'number') {
        this.blendMaxEnum = (gl as WebGL2RenderingContext).MAX;
      } else if (typeof gl.getExtension === 'function') {
        const minMaxExt = gl.getExtension('EXT_blend_minmax');
        if (minMaxExt && typeof minMaxExt.MAX_EXT === 'number') {
          this.blendMaxEnum = minMaxExt.MAX_EXT;
        }
      }

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      this.isGpuAvailable =
        this.program !== null || this.ribbonProgram !== null || this.texturedRibbonProgram !== null;
    } catch {
      this.isGpuAvailable = false;
    }
  }

  private uploadBuiltinPaperTexture(gl: WebGLRenderingContext): void {
    const table = WebGlBrushEngine.builtinGrainTable;
    const size = WebGlBrushEngine.builtinGrainSize;
    if (!table) return;
    try {
      const tex = gl.createTexture();
      if (!tex) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, size, size, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, table);
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

  public isTexturedRibbonAvailable(): boolean {
    return this.isAvailable() && this.texturedRibbonProgram !== null && this.texturedRibbonBuffer !== null;
  }

  public supportsBlendMax(): boolean {
    return this.isAvailable() && this.blendMaxEnum !== null;
  }

  private ensureDabFbo(width: number, height: number): boolean {
    const gl = this.gl;
    if (!gl || !('blitFramebuffer' in gl)) return false;
    if (this.dabFbo && this.dabFboTex && this.dabFboWidth === width && this.dabFboHeight === height) {
      return true;
    }
    if (!this.dabFbo) this.dabFbo = gl.createFramebuffer();
    if (!this.dabFboTex) this.dabFboTex = gl.createTexture();
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

  private ensureDualFbos(width: number, height: number): boolean {
    const gl = this.gl;
    if (!gl || !this.dualCombineProgram || !this.fullQuadBuffer) return false;
    if (
      this.dualPrimaryFbo &&
      this.dualPrimaryTex &&
      this.dualSecondaryFbo &&
      this.dualSecondaryTex &&
      this.dualFboWidth >= width &&
      this.dualFboHeight >= height
    ) {
      return true;
    }

    const targetW = Math.max(width, this.dualFboWidth, 256);
    const targetH = Math.max(height, this.dualFboHeight, 256);

    if (!this.dualPrimaryFbo) this.dualPrimaryFbo = gl.createFramebuffer();
    if (!this.dualPrimaryTex) this.dualPrimaryTex = gl.createTexture();
    if (!this.dualSecondaryFbo) this.dualSecondaryFbo = gl.createFramebuffer();
    if (!this.dualSecondaryTex) this.dualSecondaryTex = gl.createTexture();
    if (
      !this.dualPrimaryFbo ||
      !this.dualPrimaryTex ||
      !this.dualSecondaryFbo ||
      !this.dualSecondaryTex
    ) {
      return false;
    }

    const setupTarget = (fbo: WebGLFramebuffer, tex: WebGLTexture): boolean => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, targetW, targetH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    };

    const ok1 = setupTarget(this.dualPrimaryFbo, this.dualPrimaryTex);
    const ok2 = ok1 && setupTarget(this.dualSecondaryFbo, this.dualSecondaryTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    if (!ok2) {
      this.dualFboWidth = 0;
      this.dualFboHeight = 0;
      return false;
    }
    this.dualFboWidth = targetW;
    this.dualFboHeight = targetH;
    return true;
  }

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
    const texW = image.naturalWidth || image.width || 0;
    const texH = image.naturalHeight || image.height || 0;
    const isPow2 = texW > 0 && texH > 0 && (texW & (texW - 1)) === 0 && (texH & (texH - 1)) === 0;
    const isWebGL2 = 'blitFramebuffer' in gl;
    const wrap = repeatWrap && (isPow2 || isWebGL2) ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (!repeatWrap && isPow2 && typeof gl.generateMipmap === 'function') {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.tipTexturesMap.set(cacheKey, tex);
    return tex;
  }

  /**
   * Builds and caches a 2D texture atlas packing up to 32 sub-tips so multi-tip brushes
   * render in a single GPU instanced draw call via `a_tipIndex`.
   */
  public getOrCreateMultiTipAtlas(
    images: HTMLImageElement[]
  ): { tex: WebGLTexture; cols: number; rows: number } | null {
    if (!this.gl || !images || images.length <= 1 || typeof document === 'undefined') return null;
    const ready = images.filter((im) => im && im.complete !== false && (im.naturalWidth || im.width) > 0).slice(0, 32);
    if (ready.length <= 1) return null;

    const key = ready.map((im) => `${im.naturalWidth || im.width}x${im.naturalHeight || im.height}:${im.src.slice(-24)}`).join('|');
    const cached = this.multiTipAtlasCache.get(key);
    if (cached) return cached;

    const count = ready.length;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    const cellSize = 128;

    const atlasCanvas = document.createElement('canvas');
    atlasCanvas.width = cols * cellSize;
    atlasCanvas.height = rows * cellSize;
    const aCtx = atlasCanvas.getContext('2d');
    if (!aCtx) return null;

    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      aCtx.drawImage(ready[i], col * cellSize, row * cellSize, cellSize, cellSize);
    }

    const gl = this.gl;
    if (this.multiTipAtlasCache.size >= 16) {
      const oldestKey = this.multiTipAtlasCache.keys().next().value;
      if (oldestKey) {
        const old = this.multiTipAtlasCache.get(oldestKey);
        if (old) gl.deleteTexture(old.tex);
        this.multiTipAtlasCache.delete(oldestKey);
      }
    }

    const tex = gl.createTexture();
    if (!tex) return null;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const entry = { tex, cols, rows };
    this.multiTipAtlasCache.set(key, entry);
    return entry;
  }

  /**
   * Uploads and caches one of the 7 built-in 512x512 seamless surface heightmaps as a repeat-wrapped GPU texture.
   */
  public getOrCreateSurfaceTexture(id: SurfaceTextureId): WebGLTexture | null {
    if (!this.gl) return null;
    const cached = this.surfaceTexturesMap.get(id);
    if (cached) return cached;

    const gl = this.gl;
    const field = getSurfaceTextureHeightField(id);
    const tex = gl.createTexture();
    if (!tex) return null;

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      SURFACE_TEXTURE_SIZE,
      SURFACE_TEXTURE_SIZE,
      0,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      field
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);

    this.surfaceTexturesMap.set(id, tex);
    return tex;
  }

  /**
   * Uploads or incrementally updates the underlying canvas texture for GPU wet mixing.
   * When dirty bounds are supplied and dimensions match, updates ONLY the dirty sub-rect
   * via `texSubImage2D` (avoiding full-4K `texImage2D` uploads per frame).
   */
  public uploadCanvasTexture(
    sourceCanvas: HTMLCanvasElement,
    dirtyRect?: { x: number; y: number; width: number; height: number }
  ): WebGLTexture | null {
    if (!this.gl) return null;
    const gl = this.gl;

    if (!this.canvasLayerTexture) {
      this.canvasLayerTexture = gl.createTexture();
    }
    const tex = this.canvasLayerTexture;
    if (!tex) return null;

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    const dimsMatch =
      this.canvasLayerSource === sourceCanvas &&
      this.canvasLayerWidth === sourceCanvas.width &&
      this.canvasLayerHeight === sourceCanvas.height;

    if (
      dimsMatch &&
      dirtyRect &&
      dirtyRect.width > 0 &&
      dirtyRect.height > 0 &&
      dirtyRect.width < sourceCanvas.width * 0.65 &&
      dirtyRect.height < sourceCanvas.height * 0.65 &&
      typeof document !== 'undefined'
    ) {
      const rx = Math.max(0, Math.floor(dirtyRect.x));
      const ry = Math.max(0, Math.floor(dirtyRect.y));
      const rw = Math.min(sourceCanvas.width - rx, Math.ceil(dirtyRect.width));
      const rh = Math.min(sourceCanvas.height - ry, Math.ceil(dirtyRect.height));
      if (rw > 0 && rh > 0) {
        const subCanvas = document.createElement('canvas');
        subCanvas.width = rw;
        subCanvas.height = rh;
        const sCtx = subCanvas.getContext('2d');
        if (sCtx) {
          sCtx.drawImage(sourceCanvas, rx, ry, rw, rh, 0, 0, rw, rh);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, rx, ry, gl.RGBA, gl.UNSIGNED_BYTE, subCanvas);
          return tex;
        }
      }
    }

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    this.canvasLayerSource = sourceCanvas;
    this.canvasLayerWidth = sourceCanvas.width;
    this.canvasLayerHeight = sourceCanvas.height;

    return tex;
  }

  /**
   * Executes the WebGL 3D Impasto Relief Shading Post-Pass (3x3 Sobel normals, directional
   * diffuse ridge shading, Blinn-Phong gloss specular, micro-AO, and watercolor granulation)
   * over a dirty rectangle and composites it onto `targetCtx`.
   */
  public applyImpastoReliefGpu(
    targetCtx: CanvasRenderingContext2D,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    colorRgba: Uint8Array,
    heightToothRgba: Uint8Array,
    impasto: ImpastoSettings,
    granulation: number = 0,
    wetEdge: number = 0,
    replaceRegion: boolean = false,
    opacity: number = 1.0,
    compositeOp: GlobalCompositeOperation = 'source-over'
  ): boolean {
    const canvas = this.canvas;
    const gl = this.gl;
    if (
      !this.isAvailable() ||
      !gl ||
      !canvas ||
      !this.impastoProgram ||
      !this.fullQuadBuffer ||
      rw <= 0 ||
      rh <= 0 ||
      rw > MAX_TILE_CHUNK ||
      rh > MAX_TILE_CHUNK
    ) {
      return false;
    }

    if (canvas.width < rw || canvas.height < rh) {
      canvas.width = Math.max(canvas.width, rw, 512);
      canvas.height = Math.max(canvas.height, rh, 512);
    }

    if (!this.impastoColorTex) this.impastoColorTex = gl.createTexture();
    if (!this.impastoHeightTex) this.impastoHeightTex = gl.createTexture();
    if (!this.impastoColorTex || !this.impastoHeightTex) return false;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.impastoColorTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, rw, rh, 0, gl.RGBA, gl.UNSIGNED_BYTE, colorRgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.impastoHeightTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, rw, rh, 0, gl.RGBA, gl.UNSIGNED_BYTE, heightToothRgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);

    const viewY = Math.max(0, canvas.height - rh);
    gl.viewport(0, viewY, rw, rh);
    if (typeof gl.scissor === 'function') {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, viewY, rw, rh);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.impastoProgram);
    gl.uniform1i(this.uImpastoColorTexLoc, 0);
    gl.uniform1i(this.uImpastoHeightTexLoc, 1);
    gl.uniform2f(this.uImpastoTexelSizeLoc, 1.0 / rw, 1.0 / rh);

    const az = (impasto.lightAzimuth * Math.PI) / 180;
    const el = (Math.max(5, Math.min(85, impasto.lightElevation)) * Math.PI) / 180;
    gl.uniform3f(
      this.uImpastoLightDirLoc,
      Math.cos(az) * Math.cos(el),
      Math.sin(az) * Math.cos(el),
      Math.sin(el)
    );
    gl.uniform1f(this.uImpastoDepthLoc, impasto.enabled ? impasto.depth : 0.0);
    gl.uniform1f(this.uImpastoGlossLoc, impasto.gloss);
    gl.uniform1f(this.uImpastoContrastLoc, impasto.reliefContrast);
    gl.uniform1f(this.uImpastoGranulationLoc, granulation);
    gl.uniform1f(this.uImpastoWetEdgeLoc, wetEdge);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.fullQuadBuffer);
    gl.enableVertexAttribArray(this.aImpastoPosLoc);
    gl.vertexAttribPointer(this.aImpastoPosLoc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(this.aImpastoPosLoc);

    if (typeof gl.scissor === 'function') {
      gl.disable(gl.SCISSOR_TEST);
    }

    targetCtx.save();
    if (replaceRegion) {
      targetCtx.clearRect(rx, ry, rw, rh);
    }
    targetCtx.globalCompositeOperation = compositeOp;
    targetCtx.globalAlpha = Math.max(0, Math.min(1, opacity));
    targetCtx.drawImage(canvas, 0, 0, rw, rh, rx, ry, rw, rh);
    targetCtx.restore();
    return true;
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
    targetCtx.globalCompositeOperation = isBgEraser ? 'source-over' : isEraser ? 'destination-out' : 'source-over';
    targetCtx.globalAlpha = 1.0;
    targetCtx.drawImage(canvas, 0, 0, dw, dh, sx, sy, dw, dh);
    targetCtx.restore();

    return true;
  }

  /**
   * Renders a CSP textured ribbon triangle mesh (`BrushRibbon = 1`) via the dedicated
   * textured ribbon WebGL program with multi-tip atlas, dual-tone tinting, world-space
   * paper grain modulation, and tiled chunking for arbitrarily large canvases.
   */
  public renderTexturedRibbonMesh(
    targetCtx: CanvasRenderingContext2D,
    mesh: TexturedRibbonMeshInput,
    settings: BrushSettings & { alphaLocked?: boolean; isBgEraser?: boolean },
    primaryColor: string,
    tool: ToolType
  ): boolean {
    const canvas = this.canvas;
    const gl = this.gl;
    if (
      !this.isTexturedRibbonAvailable() ||
      !gl ||
      !canvas ||
      !this.texturedRibbonProgram ||
      !this.texturedRibbonBuffer ||
      mesh.vertexCount < 3
    ) {
      return false;
    }

    const pad = 2;
    const fullDirtyX = Math.floor(mesh.bounds.minX - pad);
    const fullDirtyY = Math.floor(mesh.bounds.minY - pad);
    const fullDirtyMaxX = Math.ceil(mesh.bounds.maxX + pad);
    const fullDirtyMaxY = Math.ceil(mesh.bounds.maxY + pad);
    const totalW = Math.max(0, fullDirtyMaxX - fullDirtyX);
    const totalH = Math.max(0, fullDirtyMaxY - fullDirtyY);
    if (totalW <= 0 || totalH <= 0) return false;

    const chunkWMax = Math.min(MAX_TILE_CHUNK, totalW);
    const chunkHMax = Math.min(MAX_TILE_CHUNK, totalH);
    if (canvas.width < chunkWMax || canvas.height < chunkHMax) {
      canvas.width = Math.max(canvas.width, chunkWMax, 512);
      canvas.height = Math.max(canvas.height, chunkHMax, 512);
    }

    const useOffscreenFbo = this.ensureDabFbo(canvas.width, canvas.height);

    const isTransparentInk = Boolean(settings.isTransparentInk);
    const isBgEraser = Boolean(settings.isBgEraser);
    const isEraser = (tool === 'eraser' || isTransparentInk) && !isBgEraser;
    const isAlphaLocked = Boolean(settings.alphaLocked);
    const aaMode = Math.max(0, Math.min(3, Math.round(settings.antiAlias ?? 2)));

    const primRgb = this.parseColor(isBgEraser ? '#ffffff' : primaryColor);
    const secRgb = this.parseColor(settings.secondaryColor ?? '#ffffff');

    gl.useProgram(this.texturedRibbonProgram);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniform3f(this.uTexRibPrimaryColorLoc, primRgb.r, primRgb.g, primRgb.b);
    gl.uniform3f(this.uTexRibSecondaryColorLoc, secRgb.r, secRgb.g, secRgb.b);
    gl.uniform1i(this.uTexRibAntiAliasLoc, aaMode);
    gl.uniform1i(this.uTexRibIsEraserLoc, isEraser ? 1 : 0);
    gl.uniform1i(this.uTexRibIsBgEraserLoc, isBgEraser ? 1 : 0);

    // Bind tip texture or multi-tip atlas
    let tipTex: WebGLTexture | null = null;
    let atlasCols = 1;
    let atlasRows = 1;
    if (settings.subTipImages && settings.subTipImages.length > 1) {
      const atlas = this.getOrCreateMultiTipAtlas(settings.subTipImages);
      if (atlas) {
        tipTex = atlas.tex;
        atlasCols = atlas.cols;
        atlasRows = atlas.rows;
      }
    }
    if (!tipTex && settings.customTipImage) {
      tipTex = this.getOrCreateTipTexture(settings.customTipImage, false);
    }
    const isColorTip = Boolean(settings.isColorTip || settings.subTips?.[0]?.isColor);
    const isDualToneTip = !isColorTip && Boolean(settings.isDualToneTip || settings.subTips?.[0]?.isDualToneTip);

    gl.uniform2f(this.uTexRibTipAtlasGridLoc, atlasCols, atlasRows);
    if (tipTex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tipTex);
      if (aaMode === 0) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      }
      gl.uniform1i(this.uTexRibTipTextureLoc, 0);
      gl.uniform1i(this.uTexRibHasTipTextureLoc, 1);
      gl.uniform1i(this.uTexRibIsColorTipLoc, isColorTip ? 1 : 0);
      gl.uniform1i(this.uTexRibIsDualToneTipLoc, isDualToneTip ? 1 : 0);
    } else {
      gl.uniform1i(this.uTexRibHasTipTextureLoc, 0);
      gl.uniform1i(this.uTexRibIsColorTipLoc, 0);
      gl.uniform1i(this.uTexRibIsDualToneTipLoc, 0);
    }

    // Paper texture uniforms
    const paperDensity = Math.max(0, Math.min(1, settings.grain ?? settings.textureDensity ?? 0));
    gl.uniform1f(this.uTexRibPaperGrainLoc, paperDensity);
    gl.uniform1f(this.uTexRibGrainScaleLoc, settings.paperTextureScale ?? 1.0);
    gl.uniform1f(this.uTexRibGrainRotateRadLoc, ((settings.paperTextureRotate ?? 0) * Math.PI) / 180);

    const pMode = paperTextureModeToIndex(settings.paperTextureMode);
    gl.uniform1i(this.uTexRibPaperModeLoc, pMode);
    gl.uniform1f(this.uTexRibPaperBrightnessLoc, (settings.paperTextureBrightness ?? 0) / 100.0);
    gl.uniform1f(this.uTexRibPaperContrastLoc, (settings.paperTextureContrast ?? 0) / 100.0);
    gl.uniform1i(this.uTexRibPaperInvertLoc, settings.paperTextureInverted ? 1 : 0);
    const preserveDensity =
      settings.paperTextureApplyEachPlot !== undefined && !settings.grainPenetrationSensor?.usePressure;
    gl.uniform1i(this.uTexRibPaperPreserveDensityLoc, preserveDensity ? 1 : 0);
    gl.uniform1i(this.uTexRibPaperEmphasizeDensityLoc, settings.paperTextureEmphasizeDensity ? 1 : 0);

    if (paperDensity > 0.005) {
      if (!this.builtinPaperTexture && WebGlBrushEngine.builtinGrainTable) {
        this.uploadBuiltinPaperTexture(gl);
      }
      let paperTex: WebGLTexture | null = null;
      let paperW = WebGlBrushEngine.builtinGrainSize;
      let paperH = WebGlBrushEngine.builtinGrainSize;
      if (settings.paperTextureImage && (settings.paperTextureImage.naturalWidth || settings.paperTextureImage.width)) {
        paperTex = this.getOrCreateTipTexture(settings.paperTextureImage, true);
        paperW = settings.paperTextureImage.naturalWidth || settings.paperTextureImage.width || paperW;
        paperH = settings.paperTextureImage.naturalHeight || settings.paperTextureImage.height || paperH;
      } else if (settings.surfaceTextureId) {
        paperTex = this.getOrCreateSurfaceTexture(settings.surfaceTextureId);
        paperW = SURFACE_TEXTURE_SIZE;
        paperH = SURFACE_TEXTURE_SIZE;
      } else {
        paperTex = this.builtinPaperTexture;
      }
      if (paperTex) {
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, paperTex);
        gl.uniform1i(this.uTexRibPaperTextureLoc, 3);
        gl.uniform1i(this.uTexRibHasPaperTexLoc, 1);
        gl.uniform2f(this.uTexRibPaperTexSizeLoc, paperW, paperH);
      } else {
        gl.uniform1i(this.uTexRibHasPaperTexLoc, 0);
      }
    } else {
      gl.uniform1i(this.uTexRibHasPaperTexLoc, 0);
    }

    // Upload triangle mesh vertices
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texturedRibbonBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      mesh.vertices.subarray(0, mesh.vertexCount * RIBBON_VERTEX_STRIDE),
      gl.DYNAMIC_DRAW
    );

    const byteStride = RIBBON_VERTEX_STRIDE * 4;
    if (this.aTexRibPosLoc >= 0) {
      gl.enableVertexAttribArray(this.aTexRibPosLoc);
      gl.vertexAttribPointer(this.aTexRibPosLoc, 2, gl.FLOAT, false, byteStride, 0);
    }
    if (this.aTexRibUvLoc >= 0) {
      gl.enableVertexAttribArray(this.aTexRibUvLoc);
      gl.vertexAttribPointer(this.aTexRibUvLoc, 2, gl.FLOAT, false, byteStride, 2 * 4);
    }
    if (this.aTexRibAlphaLoc >= 0) {
      gl.enableVertexAttribArray(this.aTexRibAlphaLoc);
      gl.vertexAttribPointer(this.aTexRibAlphaLoc, 1, gl.FLOAT, false, byteStride, 4 * 4);
    }
    if (this.aTexRibPressureLoc >= 0) {
      gl.enableVertexAttribArray(this.aTexRibPressureLoc);
      gl.vertexAttribPointer(this.aTexRibPressureLoc, 1, gl.FLOAT, false, byteStride, 5 * 4);
    }
    if (this.aTexRibTipIndexLoc >= 0) {
      gl.enableVertexAttribArray(this.aTexRibTipIndexLoc);
      gl.vertexAttribPointer(this.aTexRibTipIndexLoc, 1, gl.FLOAT, false, byteStride, 6 * 4);
    }
    if (this.aTexRibEdgeInfoLoc >= 0) {
      gl.enableVertexAttribArray(this.aTexRibEdgeInfoLoc);
      gl.vertexAttribPointer(this.aTexRibEdgeInfoLoc, 2, gl.FLOAT, false, byteStride, 7 * 4);
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
    targetCtx.globalAlpha = Math.max(0, Math.min(1, settings.opacity ?? 1.0));
    if (aaMode === 0) {
      targetCtx.imageSmoothingEnabled = false;
    }

    const chunkCols = Math.ceil(totalW / MAX_TILE_CHUNK);
    const chunkRows = Math.ceil(totalH / MAX_TILE_CHUNK);

    for (let row = 0; row < chunkRows; row++) {
      const cy = fullDirtyY + row * MAX_TILE_CHUNK;
      const dh = Math.min(MAX_TILE_CHUNK, fullDirtyMaxY - cy);
      if (dh <= 0) continue;
      for (let col = 0; col < chunkCols; col++) {
        const cx = fullDirtyX + col * MAX_TILE_CHUNK;
        const dw = Math.min(MAX_TILE_CHUNK, fullDirtyMaxX - cx);
        if (dw <= 0) continue;

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

        gl.uniform2f(this.uTexRibCanvasResolutionLoc, dw, dh);
        if (this.uTexRibDirtyOffsetLoc) {
          gl.uniform2f(this.uTexRibDirtyOffsetLoc, cx, cy);
        }

        gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);

        if (typeof gl.scissor === 'function') {
          gl.disable(gl.SCISSOR_TEST);
        }

        if (useOffscreenFbo && this.dabFbo) {
          const gl2 = gl as WebGL2RenderingContext;
          gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, this.dabFbo);
          gl2.bindFramebuffer(gl2.DRAW_FRAMEBUFFER, null);
          gl2.blitFramebuffer(0, viewY, dw, viewY + dh, 0, viewY, dw, viewY + dh, gl2.COLOR_BUFFER_BIT, gl2.NEAREST);
          gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
        }

        targetCtx.drawImage(canvas, 0, 0, dw, dh, cx, cy, dw, dh);
      }
    }

    targetCtx.restore();

    if (this.aTexRibPosLoc >= 0) gl.disableVertexAttribArray(this.aTexRibPosLoc);
    if (this.aTexRibUvLoc >= 0) gl.disableVertexAttribArray(this.aTexRibUvLoc);
    if (this.aTexRibAlphaLoc >= 0) gl.disableVertexAttribArray(this.aTexRibAlphaLoc);
    if (this.aTexRibPressureLoc >= 0) gl.disableVertexAttribArray(this.aTexRibPressureLoc);
    if (this.aTexRibTipIndexLoc >= 0) gl.disableVertexAttribArray(this.aTexRibTipIndexLoc);
    if (this.aTexRibEdgeInfoLoc >= 0) gl.disableVertexAttribArray(this.aTexRibEdgeInfoLoc);

    if (tipTex && aaMode === 0) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tipTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    return true;
  }

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

    const stride = 15;
    const requiredFloats = dabs.length * stride;
    if (this.instanceArray.length < requiredFloats) {
      this.instanceArray = new Float32Array(Math.max(requiredFloats, this.instanceArray.length * 2));
    }
    const arr = this.instanceArray;
    const aaMode = settings.antiAlias ?? 2;
    const minRenderDim = aaMode === 0 ? 1.0 : 0.75;

    for (let i = 0; i < dabs.length; i++) {
      const d = dabs[i];
      const renderW = Math.max(minRenderDim, d.width);
      const renderH = Math.max(minRenderDim, d.height);
      const scaleW = d.width < minRenderDim ? Math.max(0.04, d.width / renderW) : 1.0;
      const scaleH = d.height < minRenderDim ? Math.max(0.04, d.height / renderH) : 1.0;
      const effAlpha =
        d.width >= minRenderDim && d.height >= minRenderDim
          ? d.alpha
          : Math.max(0.003, Math.min(1.0, d.alpha * scaleW * scaleH));

      const offset = i * stride;
      arr[offset + 0] = d.x;
      arr[offset + 1] = d.y;
      arr[offset + 2] = renderW;
      arr[offset + 3] = renderH;
      arr[offset + 4] = d.angle;
      arr[offset + 5] = d.r;
      arr[offset + 6] = d.g;
      arr[offset + 7] = d.b;
      arr[offset + 8] = d.grainDensity !== undefined ? d.grainDensity : -1.0;
      arr[offset + 9] = effAlpha;
      arr[offset + 10] = d.pressure;
      arr[offset + 11] = d.strokeDist;
      arr[offset + 12] = d.flipX ?? 1.0;
      arr[offset + 13] = d.flipY ?? 1.0;
      arr[offset + 14] = d.tipIndex ?? 0.0;
    }

    if (this.instanceBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, requiredFloats), gl.DYNAMIC_DRAW);
    }

    gl.useProgram(this.program);
    const isColorTip = Boolean(settings.isColorTip || (settings.subTips && settings.subTips[0]?.isColor));
    const isDualToneTip = !isColorTip && Boolean(settings.isDualToneTip || (settings.subTips && settings.subTips[0]?.isDualToneTip));
    const useMaxBlend =
      this.blendMaxEnum !== null &&
      !isEraser &&
      !isBgEraser &&
      !settings.colorMixing &&
      !isColorTip &&
      !isDualToneTip &&
      !settings.dynamics?.colorJitterEnabled &&
      (settings.blendTipsMode === 'compare' ||
        (settings.paperTextureApplyEachPlot === false && Boolean(settings.opacitySensor?.usePressure)));
    if (useMaxBlend && this.blendMaxEnum !== null) {
      gl.blendEquation(this.blendMaxEnum);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    if (this.uDocResolutionLoc) {
      const docW = underlyingCanvas ? underlyingCanvas.width : Math.max(1, _canvasWidth);
      const docH = underlyingCanvas ? underlyingCanvas.height : Math.max(1, _canvasHeight);
      gl.uniform2f(this.uDocResolutionLoc, docW, docH);
    }

    gl.uniform1i(this.uAntiAliasLoc, aaMode);
    gl.uniform1f(this.uHardnessLoc, settings.hardness ?? 1.0);
    gl.uniform1f(this.uWetEdgeLoc, settings.wetEdge ?? 0.0);

    const paperDensity = settings.grain ?? (settings.textureDensity ?? 0.0);
    const dryBrush = settings.naturalPaint?.dryBrush ?? 0.0;
    const paintLoad = settings.naturalPaint?.paintLoad ?? 1.0;
    gl.uniform1f(this.uPaperGrainLoc, paperDensity);
    gl.uniform1f(this.uGrainScaleLoc, settings.paperTextureScale ?? 1.0);
    gl.uniform1f(this.uGrainRotateRadLoc, ((settings.paperTextureRotate ?? 0) * Math.PI) / 180);
    const gmMode =
      settings.grainMappingMode === 'brush-aligned'
        ? 1
        : settings.grainMappingMode === 'stroke-flow'
        ? 2
        : settings.grainMappingMode === 'random-per-stroke'
        ? 3
        : 0;
    if (this.uGrainMappingModeLoc) gl.uniform1i(this.uGrainMappingModeLoc, gmMode);
    if (this.uGrainRandomOffsetLoc) {
      const seed = dabs.length > 0 ? Math.abs(Math.sin(dabs[0].x * 12.9898 + dabs[0].y * 78.233)) : 0;
      gl.uniform2f(this.uGrainRandomOffsetLoc, seed * 256, ((seed * 397) % 1) * 256);
    }
    if (this.uGrainRandomRotLoc) {
      const seedR = dabs.length > 0 ? Math.abs(Math.cos(dabs[0].x * 39.346 + dabs[0].y * 11.135)) * Math.PI * 2 : 0;
      gl.uniform1f(this.uGrainRandomRotLoc, seedR);
    }
    if (this.uDryBrushLoc) gl.uniform1f(this.uDryBrushLoc, dryBrush);
    if (this.uPaintLoadLoc) gl.uniform1f(this.uPaintLoadLoc, paintLoad);

    const pMode = paperTextureModeToIndex(settings.paperTextureMode);
    gl.uniform1i(this.uPaperModeLoc, pMode);
    gl.uniform1f(this.uPaperBrightnessLoc, (settings.paperTextureBrightness ?? 0) / 100.0);
    gl.uniform1f(this.uPaperContrastLoc, (settings.paperTextureContrast ?? 0) / 100.0);
    gl.uniform1i(this.uPaperInvertLoc, settings.paperTextureInverted ? 1 : 0);
    const preserveDensity =
      Boolean(settings.textureDensitySensor) ||
      (settings.paperTextureApplyEachPlot !== undefined && !settings.grainPenetrationSensor?.usePressure);
    if (this.uPaperPreserveDensityLoc) {
      gl.uniform1i(this.uPaperPreserveDensityLoc, preserveDensity ? 1 : 0);
    }
    if (this.uPaperEmphasizeDensityLoc) {
      gl.uniform1i(this.uPaperEmphasizeDensityLoc, settings.paperTextureEmphasizeDensity ? 1 : 0);
    }
    gl.uniform1i(this.uIsEraserLoc, isEraser ? 1 : 0);
    gl.uniform1i(this.uIsBgEraserLoc, isBgEraser ? 1 : 0);

    if (paperDensity > 0.001 || dryBrush > 0.001 || Boolean(settings.textureDensitySensor)) {
      if (!this.builtinPaperTexture && WebGlBrushEngine.builtinGrainTable) {
        this.uploadBuiltinPaperTexture(gl);
      }
      let paperTex: WebGLTexture | null = null;
      let paperW = WebGlBrushEngine.builtinGrainSize;
      let paperH = WebGlBrushEngine.builtinGrainSize;
      if (settings.paperTextureImage && (settings.paperTextureImage.naturalWidth || settings.paperTextureImage.width)) {
        paperTex = this.getOrCreateTipTexture(settings.paperTextureImage, true);
        paperW = settings.paperTextureImage.naturalWidth || settings.paperTextureImage.width || paperW;
        paperH = settings.paperTextureImage.naturalHeight || settings.paperTextureImage.height || paperH;
      } else if (settings.surfaceTextureId) {
        paperTex = this.getOrCreateSurfaceTexture(settings.surfaceTextureId);
        paperW = SURFACE_TEXTURE_SIZE;
        paperH = SURFACE_TEXTURE_SIZE;
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

    let tipTex: WebGLTexture | null = null;
    let atlasCols = 1;
    let atlasRows = 1;
    if (settings.subTipImages && settings.subTipImages.length > 1) {
      const atlas = this.getOrCreateMultiTipAtlas(settings.subTipImages);
      if (atlas) {
        tipTex = atlas.tex;
        atlasCols = atlas.cols;
        atlasRows = atlas.rows;
      }
    }
    if (!tipTex && settings.customTipImage) {
      tipTex = this.getOrCreateTipTexture(settings.customTipImage, false);
    }
    const secRgb = this.parseColor(settings.secondaryColor ?? '#ffffff');
    if (this.uSecondaryColorLoc) {
      gl.uniform3f(this.uSecondaryColorLoc, secRgb.r, secRgb.g, secRgb.b);
    }
    if (this.uTipAtlasGridLoc) {
      gl.uniform2f(this.uTipAtlasGridLoc, atlasCols, atlasRows);
    }
    if (tipTex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tipTex);
      gl.uniform1i(this.uTipTextureLoc, 0);
      gl.uniform1i(this.uHasTipTextureLoc, 1);
      gl.uniform1i(this.uIsColorTipLoc, isColorTip ? 1 : 0);
      if (this.uIsDualToneTipLoc) {
        gl.uniform1i(this.uIsDualToneTipLoc, isDualToneTip ? 1 : 0);
      }
    } else {
      gl.uniform1i(this.uHasTipTextureLoc, 0);
      gl.uniform1i(this.uIsColorTipLoc, 0);
      if (this.uIsDualToneTipLoc) {
        gl.uniform1i(this.uIsDualToneTipLoc, 0);
      }
    }

    const enableColorMix = Boolean(settings.colorMixing) && underlyingCanvas !== undefined;
    gl.uniform1i(this.uColorMixingLoc, enableColorMix ? 1 : 0);
    gl.uniform1i(this.uPerceptualMixingLoc, settings.perceptualMixing !== false ? 1 : 0);
    if (this.uPigmentStrengthLoc) {
      const pStr = settings.perceptualMixing === false ? 0.0 : (settings.naturalPaint?.pigmentMixingStrength ?? 1.0);
      gl.uniform1f(this.uPigmentStrengthLoc, Math.max(0, Math.min(1, pStr)));
    }
    if (this.uPigmentLutLoc) {
      const lutTex = getPigmentLutTexture(gl);
      if (lutTex) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, lutTex);
        gl.uniform1i(this.uPigmentLutLoc, 2);
      }
    }

    if (enableColorMix && underlyingCanvas) {
      const canvasTex = this.uploadCanvasTexture(underlyingCanvas, {
        x: fullDirtyX,
        y: fullDirtyY,
        width: totalW,
        height: totalH,
      });
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
      if (this.aTipIndexLoc >= 0) {
        gl.enableVertexAttribArray(this.aTipIndexLoc);
        gl.vertexAttribPointer(this.aTipIndexLoc, 1, gl.FLOAT, false, byteStride, 14 * 4);
        this.extInstanced.vertexAttribDivisor(this.aTipIndexLoc, 1);
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

    const chunkCols = Math.ceil(totalW / MAX_TILE_CHUNK);
    const chunkRows = Math.ceil(totalH / MAX_TILE_CHUNK);
    const isMultiChunk = chunkCols > 1 || chunkRows > 1;
    let cMinX: Float32Array | null = null;
    let cMinY: Float32Array | null = null;
    let cMaxX: Float32Array | null = null;
    let cMaxY: Float32Array | null = null;

    if (isMultiChunk) {
      const chunkCount = chunkCols * chunkRows;
      cMinX = new Float32Array(chunkCount).fill(Infinity);
      cMinY = new Float32Array(chunkCount).fill(Infinity);
      cMaxX = new Float32Array(chunkCount).fill(-Infinity);
      cMaxY = new Float32Array(chunkCount).fill(-Infinity);

      for (let i = 0; i < dabs.length; i++) {
        const off = i * stride;
        const dx = arr[off];
        const dy = arr[off + 1];
        const rad = Math.max(arr[off + 2], arr[off + 3]) * 0.75 + 4;
        const x0 = dx - rad;
        const y0 = dy - rad;
        const x1 = dx + rad;
        const y1 = dy + rad;

        const col0 = Math.max(0, Math.floor((x0 - fullDirtyX) / MAX_TILE_CHUNK));
        const col1 = Math.min(chunkCols - 1, Math.floor((x1 - fullDirtyX) / MAX_TILE_CHUNK));
        const row0 = Math.max(0, Math.floor((y0 - fullDirtyY) / MAX_TILE_CHUNK));
        const row1 = Math.min(chunkRows - 1, Math.floor((y1 - fullDirtyY) / MAX_TILE_CHUNK));

        for (let r = row0; r <= row1; r++) {
          const rowBase = r * chunkCols;
          for (let c = col0; c <= col1; c++) {
            const idx = rowBase + c;
            if (x0 < cMinX[idx]) cMinX[idx] = x0;
            if (y0 < cMinY[idx]) cMinY[idx] = y0;
            if (x1 > cMaxX[idx]) cMaxX[idx] = x1;
            if (y1 > cMaxY[idx]) cMaxY[idx] = y1;
          }
        }
      }
    }

    for (let row = 0; row < chunkRows; row++) {
      const cy = fullDirtyY + row * MAX_TILE_CHUNK;
      const chunkMaxY = Math.min(fullDirtyMaxY, cy + MAX_TILE_CHUNK);
      for (let col = 0; col < chunkCols; col++) {
        const cx = fullDirtyX + col * MAX_TILE_CHUNK;
        const chunkMaxX = Math.min(fullDirtyMaxX, cx + MAX_TILE_CHUNK);

        let rx = cx;
        let ry = cy;
        let dw = chunkMaxX - cx;
        let dh = chunkMaxY - cy;

        if (isMultiChunk && cMinX && cMinY && cMaxX && cMaxY) {
          const idx = row * chunkCols + col;
          if (cMinX[idx] >= cMaxX[idx] || cMinY[idx] >= cMaxY[idx]) continue;
          rx = Math.max(cx, Math.floor(cMinX[idx]));
          ry = Math.max(cy, Math.floor(cMinY[idx]));
          const rxEnd = Math.min(chunkMaxX, Math.ceil(cMaxX[idx]));
          const ryEnd = Math.min(chunkMaxY, Math.ceil(cMaxY[idx]));
          dw = rxEnd - rx;
          dh = ryEnd - ry;
          if (dw <= 0 || dh <= 0) continue;
        }

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
          gl.uniform2f(this.uDirtyOffsetLoc, rx, ry);
        }

        if (useInstanced && this.extInstanced) {
          this.extInstanced.drawArraysInstanced(gl.TRIANGLES, 0, 6, dabs.length);
        } else {
          for (let i = 0; i < dabs.length; i++) {
            const offset = i * stride;
            gl.vertexAttrib2f(this.aCenterLoc, arr[offset], arr[offset + 1]);
            gl.vertexAttrib2f(this.aSizeLoc, arr[offset + 2], arr[offset + 3]);
            gl.vertexAttrib1f(this.aAngleLoc, arr[offset + 4]);
            gl.vertexAttrib4f(this.aColorLoc, arr[offset + 5], arr[offset + 6], arr[offset + 7], arr[offset + 8]);
            gl.vertexAttrib1f(this.aAlphaLoc, arr[offset + 9]);
            gl.vertexAttrib1f(this.aPressureLoc, arr[offset + 10]);
            gl.vertexAttrib1f(this.aStrokeDistLoc, arr[offset + 11]);
            if (this.aFlipLoc >= 0) {
              gl.vertexAttrib2f(this.aFlipLoc, arr[offset + 12], arr[offset + 13]);
            }
            if (this.aTipIndexLoc >= 0) {
              gl.vertexAttrib1f(this.aTipIndexLoc, arr[offset + 14]);
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
          gl2.blitFramebuffer(0, viewY, dw, viewY + dh, 0, viewY, dw, viewY + dh, gl2.COLOR_BUFFER_BIT, gl2.NEAREST);
          gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
        }

        targetCtx.drawImage(canvas, 0, 0, dw, dh, rx, ry, dw, dh);
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
      if (this.aTipIndexLoc >= 0) {
        this.extInstanced.vertexAttribDivisor(this.aTipIndexLoc, 0);
        gl.disableVertexAttribArray(this.aTipIndexLoc);
      }
      gl.disableVertexAttribArray(this.aCenterLoc);
      gl.disableVertexAttribArray(this.aSizeLoc);
      gl.disableVertexAttribArray(this.aAngleLoc);
      gl.disableVertexAttribArray(this.aColorLoc);
      gl.disableVertexAttribArray(this.aAlphaLoc);
      gl.disableVertexAttribArray(this.aPressureLoc);
      gl.disableVertexAttribArray(this.aStrokeDistLoc);
    }

    if (useMaxBlend) {
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    return true;
  }

  private packDabsIntoFloatArray(
    dabs: GpuDab[],
    aaMode: number,
    existing: Float32Array
  ): { array: Float32Array; floatCount: number } {
    const stride = 15;
    const requiredFloats = dabs.length * stride;
    let arr = existing;
    if (arr.length < requiredFloats) {
      arr = new Float32Array(Math.max(requiredFloats, arr.length * 2));
    }
    const minRenderDim = aaMode === 0 ? 1.0 : 0.75;
    for (let i = 0; i < dabs.length; i++) {
      const d = dabs[i];
      const renderW = Math.max(minRenderDim, d.width);
      const renderH = Math.max(minRenderDim, d.height);
      const scaleW = d.width < minRenderDim ? Math.max(0.04, d.width / renderW) : 1.0;
      const scaleH = d.height < minRenderDim ? Math.max(0.04, d.height / renderH) : 1.0;
      const effAlpha =
        d.width >= minRenderDim && d.height >= minRenderDim
          ? d.alpha
          : Math.max(0.003, Math.min(1.0, d.alpha * scaleW * scaleH));

      const offset = i * stride;
      arr[offset + 0] = d.x;
      arr[offset + 1] = d.y;
      arr[offset + 2] = renderW;
      arr[offset + 3] = renderH;
      arr[offset + 4] = d.angle;
      arr[offset + 5] = d.r;
      arr[offset + 6] = d.g;
      arr[offset + 7] = d.b;
      arr[offset + 8] = d.grainDensity !== undefined ? d.grainDensity : -1.0;
      arr[offset + 9] = effAlpha;
      arr[offset + 10] = d.pressure;
      arr[offset + 11] = d.strokeDist;
      arr[offset + 12] = d.flipX ?? 1.0;
      arr[offset + 13] = d.flipY ?? 1.0;
      arr[offset + 14] = d.tipIndex ?? 0.0;
    }
    return { array: arr, floatCount: requiredFloats };
  }

  private configureDabPassUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    dabs: GpuDab[],
    settings: BrushSettings & { alphaLocked?: boolean; isBgEraser?: boolean },
    isEraser: boolean,
    isBgEraser: boolean,
    canvasWidth: number,
    canvasHeight: number,
    fullDirtyX: number,
    fullDirtyY: number,
    totalW: number,
    totalH: number,
    underlyingCanvas?: HTMLCanvasElement
  ): boolean {
    const aaMode = settings.antiAlias ?? 2;
    const isColorTip = Boolean(settings.isColorTip || (settings.subTips && settings.subTips[0]?.isColor));
    const isDualToneTip = !isColorTip && Boolean(settings.isDualToneTip || (settings.subTips && settings.subTips[0]?.isDualToneTip));
    const useMaxBlend =
      this.blendMaxEnum !== null &&
      !isEraser &&
      !isBgEraser &&
      !settings.colorMixing &&
      !isColorTip &&
      !isDualToneTip &&
      !settings.dynamics?.colorJitterEnabled &&
      (settings.blendTipsMode === 'compare' ||
        (settings.paperTextureApplyEachPlot === false && Boolean(settings.opacitySensor?.usePressure)));
    gl.enable(gl.BLEND);
    if (useMaxBlend && this.blendMaxEnum !== null) {
      gl.blendEquation(this.blendMaxEnum);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    if (this.uDocResolutionLoc) {
      const docW = underlyingCanvas ? underlyingCanvas.width : Math.max(1, canvasWidth);
      const docH = underlyingCanvas ? underlyingCanvas.height : Math.max(1, canvasHeight);
      gl.uniform2f(this.uDocResolutionLoc, docW, docH);
    }

    gl.uniform1i(this.uAntiAliasLoc, aaMode);
    gl.uniform1f(this.uHardnessLoc, settings.hardness ?? 1.0);
    gl.uniform1f(this.uWetEdgeLoc, settings.wetEdge ?? 0.0);

    const paperDensity = settings.grain ?? (settings.textureDensity ?? 0.0);
    const dryBrush = settings.naturalPaint?.dryBrush ?? 0.0;
    const paintLoad = settings.naturalPaint?.paintLoad ?? 1.0;
    gl.uniform1f(this.uPaperGrainLoc, paperDensity);
    gl.uniform1f(this.uGrainScaleLoc, settings.paperTextureScale ?? 1.0);
    gl.uniform1f(this.uGrainRotateRadLoc, ((settings.paperTextureRotate ?? 0) * Math.PI) / 180);
    const gmMode =
      settings.grainMappingMode === 'brush-aligned'
        ? 1
        : settings.grainMappingMode === 'stroke-flow'
        ? 2
        : settings.grainMappingMode === 'random-per-stroke'
        ? 3
        : 0;
    if (this.uGrainMappingModeLoc) gl.uniform1i(this.uGrainMappingModeLoc, gmMode);
    if (this.uGrainRandomOffsetLoc) {
      const seed = dabs.length > 0 ? Math.abs(Math.sin(dabs[0].x * 12.9898 + dabs[0].y * 78.233)) : 0;
      gl.uniform2f(this.uGrainRandomOffsetLoc, seed * 256, ((seed * 397) % 1) * 256);
    }
    if (this.uGrainRandomRotLoc) {
      const seedR = dabs.length > 0 ? Math.abs(Math.cos(dabs[0].x * 39.346 + dabs[0].y * 11.135)) * Math.PI * 2 : 0;
      gl.uniform1f(this.uGrainRandomRotLoc, seedR);
    }
    if (this.uDryBrushLoc) gl.uniform1f(this.uDryBrushLoc, dryBrush);
    if (this.uPaintLoadLoc) gl.uniform1f(this.uPaintLoadLoc, paintLoad);

    const pMode = paperTextureModeToIndex(settings.paperTextureMode);
    gl.uniform1i(this.uPaperModeLoc, pMode);
    gl.uniform1f(this.uPaperBrightnessLoc, (settings.paperTextureBrightness ?? 0) / 100.0);
    gl.uniform1f(this.uPaperContrastLoc, (settings.paperTextureContrast ?? 0) / 100.0);
    gl.uniform1i(this.uPaperInvertLoc, settings.paperTextureInverted ? 1 : 0);
    const preserveDensity =
      Boolean(settings.textureDensitySensor) ||
      (settings.paperTextureApplyEachPlot !== undefined && !settings.grainPenetrationSensor?.usePressure);
    if (this.uPaperPreserveDensityLoc) {
      gl.uniform1i(this.uPaperPreserveDensityLoc, preserveDensity ? 1 : 0);
    }
    if (this.uPaperEmphasizeDensityLoc) {
      gl.uniform1i(this.uPaperEmphasizeDensityLoc, settings.paperTextureEmphasizeDensity ? 1 : 0);
    }
    gl.uniform1i(this.uIsEraserLoc, isEraser ? 1 : 0);
    gl.uniform1i(this.uIsBgEraserLoc, isBgEraser ? 1 : 0);

    if (paperDensity > 0.001 || dryBrush > 0.001 || Boolean(settings.textureDensitySensor)) {
      if (!this.builtinPaperTexture && WebGlBrushEngine.builtinGrainTable) {
        this.uploadBuiltinPaperTexture(gl);
      }
      let paperTex: WebGLTexture | null = null;
      let paperW = WebGlBrushEngine.builtinGrainSize;
      let paperH = WebGlBrushEngine.builtinGrainSize;
      if (settings.paperTextureImage && (settings.paperTextureImage.naturalWidth || settings.paperTextureImage.width)) {
        paperTex = this.getOrCreateTipTexture(settings.paperTextureImage, true);
        paperW = settings.paperTextureImage.naturalWidth || settings.paperTextureImage.width || paperW;
        paperH = settings.paperTextureImage.naturalHeight || settings.paperTextureImage.height || paperH;
      } else if (settings.surfaceTextureId) {
        paperTex = this.getOrCreateSurfaceTexture(settings.surfaceTextureId);
        paperW = SURFACE_TEXTURE_SIZE;
        paperH = SURFACE_TEXTURE_SIZE;
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

    let tipTex: WebGLTexture | null = null;
    let atlasCols = 1;
    let atlasRows = 1;
    if (settings.subTipImages && settings.subTipImages.length > 1) {
      const atlas = this.getOrCreateMultiTipAtlas(settings.subTipImages);
      if (atlas) {
        tipTex = atlas.tex;
        atlasCols = atlas.cols;
        atlasRows = atlas.rows;
      }
    }
    if (!tipTex && settings.customTipImage) {
      tipTex = this.getOrCreateTipTexture(settings.customTipImage, false);
    }
    const secRgb = this.parseColor(settings.secondaryColor ?? '#ffffff');
    if (this.uSecondaryColorLoc) {
      gl.uniform3f(this.uSecondaryColorLoc, secRgb.r, secRgb.g, secRgb.b);
    }
    if (this.uTipAtlasGridLoc) {
      gl.uniform2f(this.uTipAtlasGridLoc, atlasCols, atlasRows);
    }
    if (tipTex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tipTex);
      gl.uniform1i(this.uTipTextureLoc, 0);
      gl.uniform1i(this.uHasTipTextureLoc, 1);
      gl.uniform1i(this.uIsColorTipLoc, isColorTip ? 1 : 0);
      if (this.uIsDualToneTipLoc) {
        gl.uniform1i(this.uIsDualToneTipLoc, isDualToneTip ? 1 : 0);
      }
    } else {
      gl.uniform1i(this.uHasTipTextureLoc, 0);
      gl.uniform1i(this.uIsColorTipLoc, 0);
      if (this.uIsDualToneTipLoc) {
        gl.uniform1i(this.uIsDualToneTipLoc, 0);
      }
    }

    const enableColorMix = Boolean(settings.colorMixing) && underlyingCanvas !== undefined;
    gl.uniform1i(this.uColorMixingLoc, enableColorMix ? 1 : 0);
    gl.uniform1i(this.uPerceptualMixingLoc, settings.perceptualMixing !== false ? 1 : 0);
    if (this.uPigmentStrengthLoc) {
      const pStr = settings.perceptualMixing === false ? 0.0 : (settings.naturalPaint?.pigmentMixingStrength ?? 1.0);
      gl.uniform1f(this.uPigmentStrengthLoc, Math.max(0, Math.min(1, pStr)));
    }
    if (this.uPigmentLutLoc) {
      const lutTex = getPigmentLutTexture(gl);
      if (lutTex) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, lutTex);
        gl.uniform1i(this.uPigmentLutLoc, 2);
      }
    }

    if (enableColorMix && underlyingCanvas) {
      const canvasTex = this.uploadCanvasTexture(underlyingCanvas, {
        x: fullDirtyX,
        y: fullDirtyY,
        width: totalW,
        height: totalH,
      });
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

    return useMaxBlend;
  }

  private bindDabAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    instanceBuf: WebGLBuffer | null,
    useInstanced: boolean
  ): void {
    const stride = 15;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVertexBuffer);
    gl.enableVertexAttribArray(this.aQuadVertexLoc);
    gl.vertexAttribPointer(this.aQuadVertexLoc, 2, gl.FLOAT, false, 0, 0);

    if (useInstanced && this.extInstanced && instanceBuf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuf);
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
      if (this.aTipIndexLoc >= 0) {
        gl.enableVertexAttribArray(this.aTipIndexLoc);
        gl.vertexAttribPointer(this.aTipIndexLoc, 1, gl.FLOAT, false, byteStride, 14 * 4);
        this.extInstanced.vertexAttribDivisor(this.aTipIndexLoc, 1);
      }
    }
  }

  private unbindDabAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    useInstanced: boolean
  ): void {
    gl.disableVertexAttribArray(this.aQuadVertexLoc);
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
      if (this.aTipIndexLoc >= 0) {
        this.extInstanced.vertexAttribDivisor(this.aTipIndexLoc, 0);
        gl.disableVertexAttribArray(this.aTipIndexLoc);
      }
      gl.disableVertexAttribArray(this.aCenterLoc);
      gl.disableVertexAttribArray(this.aSizeLoc);
      gl.disableVertexAttribArray(this.aAngleLoc);
      gl.disableVertexAttribArray(this.aColorLoc);
      gl.disableVertexAttribArray(this.aAlphaLoc);
      gl.disableVertexAttribArray(this.aPressureLoc);
      gl.disableVertexAttribArray(this.aStrokeDistLoc);
    }
  }

  private drawBoundDabs(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    dabCount: number,
    arr: Float32Array,
    useInstanced: boolean
  ): void {
    if (dabCount <= 0) return;
    if (useInstanced && this.extInstanced) {
      this.extInstanced.drawArraysInstanced(gl.TRIANGLES, 0, 6, dabCount);
      return;
    }
    const stride = 15;
    for (let i = 0; i < dabCount; i++) {
      const offset = i * stride;
      gl.vertexAttrib2f(this.aCenterLoc, arr[offset], arr[offset + 1]);
      gl.vertexAttrib2f(this.aSizeLoc, arr[offset + 2], arr[offset + 3]);
      gl.vertexAttrib1f(this.aAngleLoc, arr[offset + 4]);
      gl.vertexAttrib4f(this.aColorLoc, arr[offset + 5], arr[offset + 6], arr[offset + 7], arr[offset + 8]);
      gl.vertexAttrib1f(this.aAlphaLoc, arr[offset + 9]);
      gl.vertexAttrib1f(this.aPressureLoc, arr[offset + 10]);
      gl.vertexAttrib1f(this.aStrokeDistLoc, arr[offset + 11]);
      if (this.aFlipLoc >= 0) {
        gl.vertexAttrib2f(this.aFlipLoc, arr[offset + 12], arr[offset + 13]);
      }
      if (this.aTipIndexLoc >= 0) {
        gl.vertexAttrib1f(this.aTipIndexLoc, arr[offset + 14]);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  /**
   * True two-pass Clip Studio Paint Dual Brush GPU renderer:
   * - Pass 1 renders `primaryDabs` into `dualPrimaryFbo`
   * - Pass 2 renders `secondaryDabs` into `dualSecondaryFbo`
   * - Combine Pass executes a single fullscreen FBO shader combining primary RGBA
   *   and secondary density `a2` with `compositeMode` and composites onto `targetCtx`.
   */
  public renderDualBrushDabsToContext(
    targetCtx: CanvasRenderingContext2D,
    primaryDabs: GpuDab[],
    primarySettings: BrushSettings & { alphaLocked?: boolean; isBgEraser?: boolean },
    secondaryDabs: GpuDab[],
    secondarySettings: BrushSettings,
    compositeMode: DualBrushCompositeMode,
    tool: ToolType,
    canvasWidth: number,
    canvasHeight: number,
    underlyingCanvas?: HTMLCanvasElement
  ): boolean {
    const canvas = this.canvas;
    const gl = this.gl;
    if (
      !this.isAvailable() ||
      !gl ||
      !canvas ||
      !this.program ||
      !this.dualCombineProgram ||
      !this.fullQuadBuffer ||
      primaryDabs.length === 0
    ) {
      return false;
    }

    const isTransparentInk = Boolean(primarySettings.isTransparentInk);
    const isEraser = tool === 'eraser' || isTransparentInk;
    const isBgEraser =
      Boolean(primarySettings.isBgEraser) || (tool === 'eraser' && targetCtx.fillStyle === '#ffffff');
    const isAlphaLocked = Boolean(primarySettings.alphaLocked);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < primaryDabs.length; i++) {
      const d = primaryDabs[i];
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
    if (totalW <= 0 || totalH <= 0) return false;

    const chunkWMax = Math.min(MAX_TILE_CHUNK, totalW);
    const chunkHMax = Math.min(MAX_TILE_CHUNK, totalH);
    if (canvas.width < chunkWMax || canvas.height < chunkHMax) {
      canvas.width = Math.max(canvas.width, chunkWMax, 512);
      canvas.height = Math.max(canvas.height, chunkHMax, 512);
    }

    if (!this.ensureDualFbos(chunkWMax, chunkHMax)) {
      return false;
    }

    const aaMode = primarySettings.antiAlias ?? 2;
    const packedPrimary = this.packDabsIntoFloatArray(primaryDabs, aaMode, this.instanceArray);
    this.instanceArray = packedPrimary.array;
    if (this.instanceBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.instanceArray.subarray(0, packedPrimary.floatCount), gl.DYNAMIC_DRAW);
    }

    const secAaMode = secondarySettings.antiAlias ?? aaMode;
    const packedSecondary = this.packDabsIntoFloatArray(
      secondaryDabs,
      secAaMode,
      this.secondaryInstanceArray
    );
    this.secondaryInstanceArray = packedSecondary.array;
    if (this.secondaryInstanceBuffer && secondaryDabs.length > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.secondaryInstanceBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.secondaryInstanceArray.subarray(0, packedSecondary.floatCount),
        gl.DYNAMIC_DRAW
      );
    }

    const useInstancedPrimary = Boolean(this.extInstanced && this.instanceBuffer);
    const useInstancedSecondary = Boolean(this.extInstanced && this.secondaryInstanceBuffer);
    const modeIdx = dualBrushCompositeModeToIndex(compositeMode);

    const compositeOp: GlobalCompositeOperation = isBgEraser
      ? 'source-over'
      : isEraser
      ? 'destination-out'
      : isAlphaLocked
      ? 'source-atop'
      : 'source-over';

    targetCtx.save();
    targetCtx.globalCompositeOperation = compositeOp;
    targetCtx.globalAlpha = Math.max(0, Math.min(1, primarySettings.opacity ?? 1.0));
    if (aaMode === 0) {
      targetCtx.imageSmoothingEnabled = false;
    }

    const chunkCols = Math.ceil(totalW / MAX_TILE_CHUNK);
    const chunkRows = Math.ceil(totalH / MAX_TILE_CHUNK);

    for (let row = 0; row < chunkRows; row++) {
      const cy = fullDirtyY + row * MAX_TILE_CHUNK;
      const dh = Math.min(MAX_TILE_CHUNK, fullDirtyMaxY - cy);
      if (dh <= 0) continue;
      for (let col = 0; col < chunkCols; col++) {
        const cx = fullDirtyX + col * MAX_TILE_CHUNK;
        const dw = Math.min(MAX_TILE_CHUNK, fullDirtyMaxX - cx);
        if (dw <= 0) continue;

        // Pass 1: Primary stroke into dualPrimaryFbo at (0, 0, dw, dh)
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.dualPrimaryFbo);
        gl.viewport(0, 0, dw, dh);
        if (typeof gl.scissor === 'function') {
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(0, 0, dw, dh);
        }
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.program);
        this.configureDabPassUniforms(
          gl,
          primaryDabs,
          primarySettings,
          isEraser,
          isBgEraser,
          canvasWidth,
          canvasHeight,
          fullDirtyX,
          fullDirtyY,
          totalW,
          totalH,
          underlyingCanvas
        );
        gl.uniform2f(this.uCanvasResolutionLoc, dw, dh);
        if (this.uDirtyOffsetLoc) {
          gl.uniform2f(this.uDirtyOffsetLoc, cx, cy);
        }
        this.bindDabAttributes(gl, this.instanceBuffer, useInstancedPrimary);
        this.drawBoundDabs(gl, primaryDabs.length, this.instanceArray, useInstancedPrimary);
        this.unbindDabAttributes(gl, useInstancedPrimary);

        // Pass 2: Secondary stroke into dualSecondaryFbo at (0, 0, dw, dh)
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.dualSecondaryFbo);
        gl.viewport(0, 0, dw, dh);
        if (typeof gl.scissor === 'function') {
          gl.scissor(0, 0, dw, dh);
        }
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        if (secondaryDabs.length > 0) {
          gl.useProgram(this.program);
          this.configureDabPassUniforms(
            gl,
            secondaryDabs,
            secondarySettings,
            false,
            false,
            canvasWidth,
            canvasHeight,
            fullDirtyX,
            fullDirtyY,
            totalW,
            totalH,
            undefined
          );
          gl.uniform2f(this.uCanvasResolutionLoc, dw, dh);
          if (this.uDirtyOffsetLoc) {
            gl.uniform2f(this.uDirtyOffsetLoc, cx, cy);
          }
          this.bindDabAttributes(gl, this.secondaryInstanceBuffer, useInstancedSecondary);
          this.drawBoundDabs(
            gl,
            secondaryDabs.length,
            this.secondaryInstanceArray,
            useInstancedSecondary
          );
          this.unbindDabAttributes(gl, useInstancedSecondary);
        }

        // Combine Pass: single fullscreen quad shader combining dualPrimaryTex + dualSecondaryTex
        const viewY = Math.max(0, canvas.height - dh);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, viewY, dw, dh);
        if (typeof gl.scissor === 'function') {
          gl.scissor(0, viewY, dw, dh);
        }
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.disable(gl.BLEND);
        gl.useProgram(this.dualCombineProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.dualPrimaryTex);
        gl.uniform1i(this.uDualCombinePrimaryTexLoc, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.dualSecondaryTex);
        gl.uniform1i(this.uDualCombineSecondaryTexLoc, 1);
        gl.uniform2f(
          this.uDualCombineUvScaleLoc,
          dw / Math.max(1, this.dualFboWidth),
          dh / Math.max(1, this.dualFboHeight)
        );
        gl.uniform1i(this.uDualCombineModeLoc, modeIdx);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.fullQuadBuffer);
        gl.enableVertexAttribArray(this.aDualCombinePosLoc);
        gl.vertexAttribPointer(this.aDualCombinePosLoc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.disableVertexAttribArray(this.aDualCombinePosLoc);

        if (typeof gl.scissor === 'function') {
          gl.disable(gl.SCISSOR_TEST);
        }
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        targetCtx.drawImage(canvas, 0, 0, dw, dh, cx, cy, dw, dh);
      }
    }

    targetCtx.restore();
    return true;
  }
}
