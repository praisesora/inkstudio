import { HSV, RGB, hsvToRgb, rgbToHex } from './colorUtils';

export type SphereColorSlot = 'shadow' | 'base' | 'light' | 'rim';

export interface SphereLightingConfig {
  /** Horizontal light angle in degrees (-180..180). Negative = left, positive = right. */
  lightAzimuth: number;
  /** Vertical light elevation in degrees (-80..80). Positive = top. */
  lightElevation: number;
  /** Key light brightness / exposure (0.1 = dim chiaroscuro, 1.0 = neutral, 2.8 = bright key). */
  lightIntensity: number;
  /** Global chroma saturation (0.0 = pure B&W / grayscale, 1.0 = normal, 1.8 = vivid). */
  saturation: number;
  /** Perceptual lighting contrast (0.4 = soft/flat, 1.15 = sculptural default, 2.2 = high contrast). */
  contrast: number;
  /** Surface finish: 0.05 = wet gloss, 0.95 = matte. */
  roughness: number;
  /** Specular highlight intensity (0..1.6). */
  specularStrength: number;
  /** Soft bounce light from below (0..1.2). */
  bounceIntensity: number;
  /** Painterly shadow depth (0..1). */
  shadowDepth: number;
  /** Omnidirectional ambient fill lifting shadows/overall brightness (0..1). */
  ambientIntensity?: number;
  /** How strongly the Light slot color tints the lit body vs neutral white light (0..1). */
  lightTint?: number;
  /** Grazing Fresnel rim / backlight intensity driven by Rim slot color (0..1.5). */
  rimIntensity?: number;
  /** Chromatic subsurface / terminator scatter glow along the shadow boundary (0..1). */
  subsurface?: number;
}

export interface SphereSlotsState {
  shadow: HSV;
  base: HSV;
  light: HSV;
  /** Edge rim / bounce light accent color (optional for backward compatibility). */
  rim?: HSV;
}

export interface SphereMarkerPosition {
  /** Normalized X on sphere projection (-1..1, +right). */
  x: number;
  /** Normalized Y on sphere projection (-1..1, +up). */
  y: number;
}

export interface SphereColorResult {
  hex: string;
  rgb: RGB;
}

export interface SpherePreset {
  id: string;
  label: string;
  swatch?: string;
  lighting: Partial<SphereLightingConfig>;
  slots?: Partial<SphereSlotsState>;
}

export const DEFAULT_SPHERE_LIGHTING: SphereLightingConfig = {
  lightAzimuth: -38,
  lightElevation: 42,
  lightIntensity: 1.0,
  saturation: 1.0,
  contrast: 1.15,
  roughness: 0.44,
  specularStrength: 0.34,
  bounceIntensity: 0.34,
  shadowDepth: 0.84,
  ambientIntensity: 0.08,
  lightTint: 0.28,
  rimIntensity: 0.14,
  subsurface: 0.16,
};

export const DEFAULT_SPHERE_SLOTS: SphereSlotsState = {
  shadow: { h: 215, s: 0.28, v: 0.44 },
  base: { h: 162, s: 0.16, v: 0.62 },
  light: { h: 52, s: 0.14, v: 0.94 },
  rim: { h: 200, s: 0.28, v: 0.82 },
};

export const SPHERE_LIGHTING_PRESETS: SpherePreset[] = [
  {
    id: 'studio',
    label: 'Studio Matte',
    swatch: '#9aa8a0',
    lighting: {
      lightAzimuth: -38,
      lightElevation: 42,
      lightIntensity: 1.05,
      saturation: 1.0,
      contrast: 1.15,
      roughness: 0.44,
      specularStrength: 0.34,
      bounceIntensity: 0.34,
      shadowDepth: 0.84,
      ambientIntensity: 0.14,
      lightTint: 0.28,
      rimIntensity: 0.16,
      subsurface: 0.18,
    },
  },
  {
    id: 'crimson-mood',
    label: 'Crimson Mood',
    swatch: '#c82314',
    lighting: {
      lightAzimuth: -46,
      lightElevation: 34,
      lightIntensity: 1.5,
      saturation: 1.24,
      contrast: 1.48,
      roughness: 0.1,
      specularStrength: 1.1,
      bounceIntensity: 0.22,
      shadowDepth: 0.96,
      ambientIntensity: 0.03,
      lightTint: 0.88,
      rimIntensity: 0.68,
      subsurface: 0.48,
    },
    slots: {
      shadow: { h: 356, s: 0.92, v: 0.12 },
      base: { h: 8, s: 0.8, v: 0.52 },
      light: { h: 7, s: 0.95, v: 1.0 },
      rim: { h: 12, s: 0.96, v: 0.98 },
    },
  },
  {
    id: 'high-key',
    label: 'High-Key Bright',
    swatch: '#f2e8dc',
    lighting: {
      lightAzimuth: -30,
      lightElevation: 46,
      lightIntensity: 1.65,
      saturation: 1.05,
      contrast: 0.96,
      roughness: 0.38,
      specularStrength: 0.45,
      bounceIntensity: 0.62,
      shadowDepth: 0.52,
      ambientIntensity: 0.46,
      lightTint: 0.24,
      rimIntensity: 0.38,
      subsurface: 0.28,
    },
  },
  {
    id: 'warm-cool',
    label: 'Warm / Cool',
    swatch: '#e8b36b',
    lighting: {
      lightAzimuth: -44,
      lightElevation: 48,
      lightIntensity: 1.25,
      saturation: 1.1,
      contrast: 1.25,
      roughness: 0.36,
      specularStrength: 0.48,
      bounceIntensity: 0.4,
      shadowDepth: 0.86,
      ambientIntensity: 0.14,
      lightTint: 0.52,
      rimIntensity: 0.32,
      subsurface: 0.34,
    },
    slots: {
      shadow: { h: 224, s: 0.56, v: 0.38 },
      light: { h: 38, s: 0.46, v: 0.98 },
      rim: { h: 205, s: 0.62, v: 0.9 },
    },
  },
  {
    id: 'neon-dual',
    label: 'Neon Dual-Tone',
    swatch: '#e024a8',
    lighting: {
      lightAzimuth: -48,
      lightElevation: 32,
      lightIntensity: 1.6,
      saturation: 1.35,
      contrast: 1.42,
      roughness: 0.16,
      specularStrength: 0.95,
      bounceIntensity: 0.55,
      shadowDepth: 0.92,
      ambientIntensity: 0.08,
      lightTint: 0.86,
      rimIntensity: 1.1,
      subsurface: 0.45,
    },
    slots: {
      shadow: { h: 256, s: 0.78, v: 0.22 },
      base: { h: 270, s: 0.32, v: 0.52 },
      light: { h: 324, s: 0.92, v: 1.0 },
      rim: { h: 186, s: 0.96, v: 1.0 },
    },
  },
  {
    id: 'sunset-rim',
    label: 'Sunset Rim',
    swatch: '#ff6a2b',
    lighting: {
      lightAzimuth: -58,
      lightElevation: 22,
      lightIntensity: 1.48,
      saturation: 1.22,
      contrast: 1.36,
      roughness: 0.28,
      specularStrength: 0.65,
      bounceIntensity: 0.52,
      shadowDepth: 0.88,
      ambientIntensity: 0.12,
      lightTint: 0.72,
      rimIntensity: 1.05,
      subsurface: 0.64,
    },
    slots: {
      shadow: { h: 274, s: 0.62, v: 0.24 },
      light: { h: 26, s: 0.84, v: 1.0 },
      rim: { h: 16, s: 0.98, v: 1.0 },
    },
  },
  {
    id: 'glossy-wet',
    label: 'Glossy Wet',
    swatch: '#d6dce5',
    lighting: {
      lightAzimuth: -36,
      lightElevation: 44,
      lightIntensity: 1.32,
      saturation: 1.12,
      contrast: 1.34,
      roughness: 0.08,
      specularStrength: 1.25,
      bounceIntensity: 0.36,
      shadowDepth: 0.88,
      ambientIntensity: 0.12,
      lightTint: 0.38,
      rimIntensity: 0.48,
      subsurface: 0.26,
    },
  },
  {
    id: 'chiaroscuro',
    label: 'Dim Chiaroscuro',
    swatch: '#4a3d36',
    lighting: {
      lightAzimuth: -54,
      lightElevation: 36,
      lightIntensity: 0.58,
      saturation: 0.96,
      contrast: 1.55,
      roughness: 0.42,
      specularStrength: 0.4,
      bounceIntensity: 0.22,
      shadowDepth: 0.95,
      ambientIntensity: 0.02,
      lightTint: 0.42,
      rimIntensity: 0.14,
      subsurface: 0.24,
    },
  },
  {
    id: 'bw-value',
    label: 'B&W Value Study',
    swatch: '#8c8c8c',
    lighting: {
      lightAzimuth: -40,
      lightElevation: 44,
      lightIntensity: 1.1,
      saturation: 0,
      contrast: 1.25,
      roughness: 0.48,
      specularStrength: 0.32,
      bounceIntensity: 0.32,
      shadowDepth: 0.88,
      ambientIntensity: 0.12,
      lightTint: 0.2,
      rimIntensity: 0.18,
      subsurface: 0,
    },
  },
];

export const MAX_MARKER_RADIUS = 0.93;

const DEG2RAD = Math.PI / 180;
const LINEAR_LUT_MAX = 4.0;
const LINEAR_LUT_SIZE = 4096;
const LINEAR_LUT_SCALE = (LINEAR_LUT_SIZE - 1) / LINEAR_LUT_MAX;

// Exact IEC 61966-2-1 sRGB -> Linear LUT (256 entries)
const SRGB_TO_LINEAR_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = i / 255;
  SRGB_TO_LINEAR_LUT[i] = u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
}

// Base sRGB [0..1] curve for Linear [0..4.0] with C1 soft-shoulder highlight rolloff
const LINEAR_TO_SRGB_FLOAT = new Float32Array(LINEAR_LUT_SIZE);
for (let i = 0; i < LINEAR_LUT_SIZE; i++) {
  const x = (i / (LINEAR_LUT_SIZE - 1)) * LINEAR_LUT_MAX;
  const mapped = x <= 0.82 ? x : 0.82 + 0.18 * (1 - Math.exp(-(x - 0.82) * 3.8));
  const clamped = mapped < 0 ? 0 : mapped > 1 ? 1 : mapped;
  LINEAR_TO_SRGB_FLOAT[i] =
    clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

// Single-entry cached 4096-byte tone LUT with C1 S-curve perceptual contrast (rebuilt only on contrast change, <0.05ms)
let cachedContrastKey = -1;
const TONE_SRGB_LUT = new Uint8Array(LINEAR_LUT_SIZE);

function getToneLut(contrastRaw: number): Uint8Array {
  const contrast = Math.max(0.35, Math.min(2.2, contrastRaw));
  const key = Math.round(contrast * 200);
  if (key === cachedContrastKey) return TONE_SRGB_LUT;
  cachedContrastKey = key;

  if (Math.abs(contrast - 1) < 0.004) {
    for (let i = 0; i < LINEAR_LUT_SIZE; i++) {
      TONE_SRGB_LUT[i] = Math.max(0, Math.min(255, Math.round(LINEAR_TO_SRGB_FLOAT[i] * 255)));
    }
  } else {
    for (let i = 0; i < LINEAR_LUT_SIZE; i++) {
      const s = LINEAR_TO_SRGB_FLOAT[i];
      const curved =
        s < 0.5
          ? 0.5 * Math.pow(Math.max(0, 2 * s), contrast)
          : 1 - 0.5 * Math.pow(Math.max(0, 2 * (1 - s)), contrast);
      TONE_SRGB_LUT[i] = Math.max(0, Math.min(255, Math.round(curved * 255)));
    }
  }
  return TONE_SRGB_LUT;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function clampMarkerPosition(x: number, y: number, maxRadius = MAX_MARKER_RADIUS): SphereMarkerPosition {
  const len = Math.hypot(x, y);
  if (len <= maxRadius || len === 0) {
    return { x, y };
  }
  const scale = maxRadius / len;
  return { x: x * scale, y: y * scale };
}

export function markerToNormal(pos: SphereMarkerPosition): { nx: number; ny: number; nz: number } {
  const clamped = clampMarkerPosition(pos.x, pos.y, 0.999);
  const nz = Math.sqrt(Math.max(0.0001, 1 - clamped.x * clamped.x - clamped.y * clamped.y));
  return { nx: clamped.x, ny: clamped.y, nz };
}

export function getLightVectors(config: SphereLightingConfig) {
  const az = config.lightAzimuth * DEG2RAD;
  const el = config.lightElevation * DEG2RAD;
  const cosEl = Math.cos(el);
  let lx = cosEl * Math.sin(az);
  let ly = Math.sin(el);
  let lz = cosEl * Math.cos(az);
  const lLen = Math.hypot(lx, ly, lz) || 1;
  lx /= lLen;
  ly /= lLen;
  lz /= lLen;

  // Blinn-Phong half vector for view V = (0, 0, 1)
  let hx = lx;
  let hy = ly;
  let hz = lz + 1;
  const hLen = Math.hypot(hx, hy, hz) || 1;
  hx /= hLen;
  hy /= hLen;
  hz /= hLen;

  // Soft bounce light coming from below and slightly opposite the key light
  let bx = -lx * 0.45;
  let by = -0.84;
  let bz = 0.38;
  const bLen = Math.hypot(bx, by, bz) || 1;
  bx /= bLen;
  by /= bLen;
  bz /= bLen;

  return { lx, ly, lz, hx, hy, hz, bx, by, bz };
}

function linearToSrgbByte(lin: number, toneLut: Uint8Array): number {
  if (lin <= 0) return 0;
  if (lin >= LINEAR_LUT_MAX) return 255;
  return toneLut[(lin * LINEAR_LUT_SCALE + 0.5) | 0];
}

function hsvToLinearRgb(hsv: HSV): [number, number, number] {
  const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
  return [
    SRGB_TO_LINEAR_LUT[rgb.r],
    SRGB_TO_LINEAR_LUT[rgb.g],
    SRGB_TO_LINEAR_LUT[rgb.b],
  ];
}

const LIGHT_FACTORS_STRIDE = 7;

interface SphereShaderConstants {
  shadowToneR: number;
  shadowToneG: number;
  shadowToneB: number;
  diffR: number;
  diffG: number;
  diffB: number;
  ambientR: number;
  ambientG: number;
  ambientB: number;
  keyScaleR: number;
  keyScaleG: number;
  keyScaleB: number;
  specTintR: number;
  specTintG: number;
  specTintB: number;
  bounceR: number;
  bounceG: number;
  bounceB: number;
  rimR: number;
  rimG: number;
  rimB: number;
  sssR: number;
  sssG: number;
  sssB: number;
  sat: number;
  toneLut: Uint8Array;
}

function clampFinite(v: number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return n < min ? min : n > max ? max : n;
}

function computeShaderConstants(
  slots: SphereSlotsState,
  config: SphereLightingConfig
): SphereShaderConstants {
  const [br, bg, bb] = hsvToLinearRgb(slots.base);
  const [sr, sg, sb] = hsvToLinearRgb(slots.shadow);
  const [lr, lg, lb] = hsvToLinearRgb(slots.light);
  const [rr, rg, rb] = slots.rim
    ? hsvToLinearRgb(slots.rim)
    : [sr * 0.55 + lr * 0.35 + br * 0.1, sg * 0.55 + lg * 0.35 + bg * 0.1, sb * 0.55 + lb * 0.35 + bb * 0.1];

  const intensity = clampFinite(config.lightIntensity, 1, 0.08, 2.8);
  const sat = clampFinite(config.saturation, 1, 0, 1.85);
  const shadowDepth = clampFinite(config.shadowDepth, 0.84, 0, 1);
  const ambient = clampFinite(config.ambientIntensity, 0.08, 0, 1);
  const lightTint = clampFinite(config.lightTint, 0.28, 0, 1);
  const toneLut = getToneLut(clampFinite(config.contrast, 1.15, 0.35, 2.2));

  const bodyLightScale = 0.26 + 0.74 * intensity;
  const bounceScale = (0.45 + 0.55 * Math.min(1.5, intensity)) * 0.95;

  // Luminance-compensated colored key tint so saturated gels (e.g. crimson/neon) stay bright instead of dim
  const lightLum = Math.max(0.08, 0.2126 * lr + 0.7152 * lg + 0.0722 * lb);
  const normFactor = Math.min(2.2, 0.74 / lightLum);
  const kTintR = Math.max(0.04, 1 + lightTint * (lr * normFactor - 1));
  const kTintG = Math.max(0.04, 1 + lightTint * (lg * normFactor - 1));
  const kTintB = Math.max(0.04, 1 + lightTint * (lb * normFactor - 1));
  const gelWash = lightTint * 0.3 * intensity;

  const shadowScale = (1 - 0.72 * shadowDepth) * (0.5 + 0.5 * Math.min(1.25, intensity));
  const shadowToneR = (br * (0.24 + 0.76 * sr) * 0.48 + sr * 0.52) * shadowScale;
  const shadowToneG = (bg * (0.24 + 0.76 * sg) * 0.48 + sg * 0.52) * shadowScale;
  const shadowToneB = (bb * (0.24 + 0.76 * sb) * 0.48 + sb * 0.52) * shadowScale;

  const litBaseR = br * bodyLightScale * kTintR + lr * gelWash;
  const litBaseG = bg * bodyLightScale * kTintG + lg * gelWash;
  const litBaseB = bb * bodyLightScale * kTintB + lb * gelWash;

  // Perceptual curve keeps default shadows sculpted while allowing full high-key lift
  const ambScale = ambient * ambient * 0.48 + ambient * 0.05;
  const ambientR = (br * 0.68 + lr * 0.18 + sr * 0.14) * ambScale;
  const ambientG = (bg * 0.68 + lg * 0.18 + sg * 0.14) * ambScale;
  const ambientB = (bb * 0.68 + lb * 0.18 + sb * 0.14) * ambScale;

  const bounceR = (rr * 0.64 + sr * 0.24 + br * 0.12) * bounceScale;
  const bounceG = (rg * 0.64 + sg * 0.24 + bg * 0.12) * bounceScale;
  const bounceB = (rb * 0.64 + sb * 0.24 + bb * 0.12) * bounceScale;

  const rimScale = 0.58 + 0.42 * Math.min(1.6, intensity);
  const rimR = rr * rimScale;
  const rimG = rg * rimScale;
  const rimB = rb * rimScale;

  // Subsurface terminator scatter keeps skin/red/saturated lighting glowing across the shadow turn
  const sssScale = 0.26 * (0.45 + 0.55 * intensity);
  const sssR = (br * lr * 1.15 + lr * 0.28 + rr * 0.14) * sssScale;
  const sssG = (bg * lg * 1.15 + lg * 0.28 + rg * 0.14) * sssScale;
  const sssB = (bb * lb * 1.15 + lb * 0.28 + rb * 0.14) * sssScale;

  const keyScaleR = 0.36 * intensity * (br * lr + 0.22 * lr);
  const keyScaleG = 0.36 * intensity * (bg * lg + 0.22 * lg);
  const keyScaleB = 0.36 * intensity * (bb * lb + 0.22 * lb);

  // Dielectric wet specular retains crisp bright core while picking up key hue
  const specTintR = (lr * 0.72 + 0.28) * intensity;
  const specTintG = (lg * 0.72 + 0.28) * intensity;
  const specTintB = (lb * 0.72 + 0.28) * intensity;

  return {
    shadowToneR,
    shadowToneG,
    shadowToneB,
    diffR: litBaseR - shadowToneR,
    diffG: litBaseG - shadowToneG,
    diffB: litBaseB - shadowToneB,
    ambientR,
    ambientG,
    ambientB,
    keyScaleR,
    keyScaleG,
    keyScaleB,
    specTintR,
    specTintG,
    specTintB,
    bounceR,
    bounceG,
    bounceB,
    rimR,
    rimG,
    rimB,
    sssR,
    sssG,
    sssB,
    sat,
    toneLut,
  };
}

/**
 * Evaluates the exact painterly matte/glossy/cinematic color at any normalized disk coordinate (x, y)
 * on the 3D sphere. Matches the LUT pixel shader identically.
 */
export function evaluateSphereColor(
  pos: SphereMarkerPosition,
  slots: SphereSlotsState,
  config: SphereLightingConfig
): SphereColorResult {
  const { nx, ny, nz } = markerToNormal(pos);
  const { lx, ly, lz, hx, hy, hz, bx, by, bz } = getLightVectors(config);

  const ndotl = nx * lx + ny * ly + nz * lz;
  const ndoth = Math.max(0, nx * hx + ny * hy + nz * hz);
  const ndotb = Math.max(0, nx * bx + ny * by + nz * bz);
  const oneMinusNz = 1 - nz;
  const fresnel = Math.pow(oneMinusNz, 2.5);

  const shadowDepth = clampFinite(config.shadowDepth, 0.84, 0, 1);
  const roughness = clampFinite(config.roughness, 0.44, 0.05, 0.95);
  const specStrength = clampFinite(config.specularStrength, 0.34, 0, 1.6);
  const bounceIntensity = clampFinite(config.bounceIntensity, 0.34, 0, 1.2);
  const rimIntensity = clampFinite(config.rimIntensity, 0.14, 0, 1.5);
  const subsurface = clampFinite(config.subsurface, 0.16, 0, 1);

  const litFactor = smoothstep(-0.18, 0.64, ndotl);
  const coreShadow = smoothstep(0.14, -0.58, ndotl) * shadowDepth;
  const highlightDiffuse = Math.pow(Math.max(0, (ndotl + 0.08) / 1.08), 1.75);

  const gloss = 1 - roughness;
  const satinExp = 5 + gloss * 18;
  const specExp = 18 + gloss * gloss * 180;
  const specMask = smoothstep(-0.1, 0.22, ndotl);
  const satinWeight = 0.14 * roughness * Math.min(1, specStrength * 1.4);
  const specW =
    (Math.pow(ndoth, satinExp) * satinWeight +
      Math.pow(ndoth, specExp) * specStrength * (0.85 + gloss * 0.9)) *
    specMask;

  const bounceW =
    Math.pow(ndotb, 2.0) *
    smoothstep(0.12, -0.42, ndotl) *
    bounceIntensity *
    (0.45 + 0.55 * fresnel);

  const rimOpp = smoothstep(0.55, -0.35, ndotl);
  const rimW = Math.pow(oneMinusNz, 3.4) * (0.24 + 0.76 * rimOpp) * rimIntensity;

  const termDelta = (ndotl - 0.04) / 0.28;
  const sssW = Math.exp(-(termDelta * termDelta)) * subsurface * (0.65 + 0.35 * oneMinusNz);

  const coreDip = 1 - 0.68 * coreShadow * Math.max(0.22, 1 - bounceW * 1.45);

  const c = computeShaderConstants(slots, config);

  let linR =
    (c.shadowToneR + c.diffR * litFactor) * coreDip +
    c.ambientR +
    highlightDiffuse * c.keyScaleR +
    specW * c.specTintR +
    bounceW * c.bounceR +
    rimW * c.rimR +
    sssW * c.sssR;
  let linG =
    (c.shadowToneG + c.diffG * litFactor) * coreDip +
    c.ambientG +
    highlightDiffuse * c.keyScaleG +
    specW * c.specTintG +
    bounceW * c.bounceG +
    rimW * c.rimG +
    sssW * c.sssG;
  let linB =
    (c.shadowToneB + c.diffB * litFactor) * coreDip +
    c.ambientB +
    highlightDiffuse * c.keyScaleB +
    specW * c.specTintB +
    bounceW * c.bounceB +
    rimW * c.rimB +
    sssW * c.sssB;

  if (c.sat !== 1) {
    const lum = 0.2126 * linR + 0.7152 * linG + 0.0722 * linB;
    linR = lum + (linR - lum) * c.sat;
    linG = lum + (linG - lum) * c.sat;
    linB = lum + (linB - lum) * c.sat;
  }

  const rgb: RGB = {
    r: linearToSrgbByte(linR, c.toneLut),
    g: linearToSrgbByte(linG, c.toneLut),
    b: linearToSrgbByte(linB, c.toneLut),
  };

  return {
    rgb,
    hex: rgbToHex(rgb.r, rgb.g, rgb.b),
  };
}

/**
 * Precomputed per-pixel geometry & lighting weights for sub-millisecond 60+ FPS sphere redraws.
 * Geometry LUT is rebuilt only on canvas resize; lighting LUT only when light angle/finish changes.
 * Slot Hue/color changes only run the linear blend pass (< 0.7ms).
 */
export interface SphereRenderLut {
  width: number;
  height: number;
  count: number;
  /** Pixel offsets into Uint32Array RGBA buffer */
  pixelIndices: Uint32Array;
  /** Anti-aliased edge alpha (0..255) */
  alphas: Uint8Array;
  /** Packed normals [nx, ny, nz] * count */
  normals: Float32Array;
  /** Ordered 4x4 Bayer dither offset (-0.0018..+0.0018) per interior pixel to remove 8-bit banding */
  dither: Float32Array;
  /** Precomputed lighting factors per pixel: [litFactor, coreDip, highlightDiffuse, specW, bounceW, rimW, sssW] */
  lightFactors: Float32Array;
  /** Cached ImageData + Uint32 view for zero-allocation redraws */
  imageData: ImageData | null;
  u32: Uint32Array | null;
}

// 4x4 Bayer threshold matrix normalized to [-0.5, +0.5]
const BAYER_4X4 = new Float32Array([
  -0.46875, 0.03125, -0.34375, 0.15625,
  0.28125, -0.21875, 0.40625, -0.09375,
  -0.28125, 0.21875, -0.40625, 0.09375,
  0.46875, -0.03125, 0.34375, -0.15625,
]);

export function buildSphereGeometryLut(
  width: number,
  height: number,
  radiusRatio = 0.465
): SphereRenderLut {
  const cx = width * 0.5;
  const cy = height * 0.5;
  const radius = Math.min(width, height) * radiusRatio;
  const aaWidth = 1.25; // smooth analytical anti-aliasing band in device pixels
  const maxDist = radius + aaWidth;
  const maxDistSq = maxDist * maxDist;

  // First pass: count interior + AA edge pixels
  let count = 0;
  for (let py = 0; py < height; py++) {
    const dyPx = cy - (py + 0.5);
    const dySq = dyPx * dyPx;
    if (dySq > maxDistSq) continue;
    for (let px = 0; px < width; px++) {
      const dxPx = px + 0.5 - cx;
      if (dxPx * dxPx + dySq <= maxDistSq) {
        count++;
      }
    }
  }

  const pixelIndices = new Uint32Array(count);
  const alphas = new Uint8Array(count);
  const normals = new Float32Array(count * 3);
  const dither = new Float32Array(count);
  const lightFactors = new Float32Array(count * LIGHT_FACTORS_STRIDE);

  let idx = 0;
  for (let py = 0; py < height; py++) {
    const dyPx = cy - (py + 0.5);
    const dySq = dyPx * dyPx;
    if (dySq > maxDistSq) continue;
    const rowOffset = py * width;
    const bayerRow = (py & 3) << 2;

    for (let px = 0; px < width; px++) {
      const dxPx = px + 0.5 - cx;
      const distSq = dxPx * dxPx + dySq;
      if (distSq > maxDistSq) continue;

      const dist = Math.sqrt(distSq);
      let nx = dxPx / radius;
      let ny = dyPx / radius;
      const rNorm = dist / radius;
      let nz: number;
      if (rNorm >= 1) {
        const inv = 1 / rNorm;
        nx *= inv;
        ny *= inv;
        nz = 0.001;
      } else {
        nz = Math.sqrt(Math.max(0.0001, 1 - nx * nx - ny * ny));
      }

      const alphaFloat = Math.max(0, Math.min(1, (radius + aaWidth * 0.5 - dist) / aaWidth));
      pixelIndices[idx] = rowOffset + px;
      alphas[idx] = Math.round(alphaFloat * 255);
      const nOff = idx * 3;
      normals[nOff] = nx;
      normals[nOff + 1] = ny;
      normals[nOff + 2] = nz;
      dither[idx] = BAYER_4X4[bayerRow | (px & 3)] * 0.0022;
      idx++;
    }
  }

  return {
    width,
    height,
    count,
    pixelIndices,
    alphas,
    normals,
    dither,
    lightFactors,
    imageData: null,
    u32: null,
  };
}

export function updateSphereLightingLut(
  lut: SphereRenderLut,
  config: SphereLightingConfig
): void {
  const { lx, ly, lz, hx, hy, hz, bx, by, bz } = getLightVectors(config);
  const roughness = clampFinite(config.roughness, 0.44, 0.05, 0.95);
  const gloss = 1 - roughness;
  const satinExp = 5 + gloss * 18;
  const specExp = 18 + gloss * gloss * 180;
  const specStrength = clampFinite(config.specularStrength, 0.34, 0, 1.6);
  const satinWeight = 0.14 * roughness * Math.min(1, specStrength * 1.4);
  const specGain = specStrength * (0.85 + gloss * 0.9);
  const bounceIntensity = clampFinite(config.bounceIntensity, 0.34, 0, 1.2);
  const shadowDepth = clampFinite(config.shadowDepth, 0.84, 0, 1);
  const rimIntensity = clampFinite(config.rimIntensity, 0.14, 0, 1.5);
  const subsurface = clampFinite(config.subsurface, 0.16, 0, 1);

  const normals = lut.normals;
  const out = lut.lightFactors;
  const count = lut.count;

  for (let i = 0; i < count; i++) {
    const nOff = i * 3;
    const nx = normals[nOff];
    const ny = normals[nOff + 1];
    const nz = normals[nOff + 2];

    const ndotl = nx * lx + ny * ly + nz * lz;
    const ndoth = Math.max(0, nx * hx + ny * hy + nz * hz);
    const ndotb = Math.max(0, nx * bx + ny * by + nz * bz);
    const oneMinusNz = 1 - nz;
    const fresnel = Math.pow(oneMinusNz, 2.5);

    const litFactor = smoothstep(-0.18, 0.64, ndotl);
    const coreShadow = smoothstep(0.14, -0.58, ndotl) * shadowDepth;
    const highlightDiffuse = Math.pow(Math.max(0, (ndotl + 0.08) / 1.08), 1.75);
    const specMask = smoothstep(-0.1, 0.22, ndotl);
    const specW =
      (Math.pow(ndoth, satinExp) * satinWeight + Math.pow(ndoth, specExp) * specGain) * specMask;
    const bounceW =
      Math.pow(ndotb, 2.0) *
      smoothstep(0.12, -0.42, ndotl) *
      bounceIntensity *
      (0.45 + 0.55 * fresnel);
    const rimOpp = smoothstep(0.55, -0.35, ndotl);
    const rimW = Math.pow(oneMinusNz, 3.4) * (0.24 + 0.76 * rimOpp) * rimIntensity;
    const termDelta = (ndotl - 0.04) / 0.28;
    const sssW = Math.exp(-(termDelta * termDelta)) * subsurface * (0.65 + 0.35 * oneMinusNz);
    const coreDip = 1 - 0.68 * coreShadow * Math.max(0.22, 1 - bounceW * 1.45);

    const fOff = i * LIGHT_FACTORS_STRIDE;
    out[fOff] = litFactor;
    out[fOff + 1] = coreDip;
    out[fOff + 2] = highlightDiffuse;
    out[fOff + 3] = specW;
    out[fOff + 4] = bounceW;
    out[fOff + 5] = rimW;
    out[fOff + 6] = sssW;
  }
}

export function renderSphereFromLut(
  ctx: CanvasRenderingContext2D,
  lut: SphereRenderLut,
  slots: SphereSlotsState,
  config: SphereLightingConfig
): void {
  if (!lut.imageData || lut.imageData.width !== lut.width || lut.imageData.height !== lut.height) {
    lut.imageData = ctx.createImageData(lut.width, lut.height);
    lut.u32 = new Uint32Array(lut.imageData.data.buffer);
  }

  const u32 = lut.u32!;
  const {
    shadowToneR,
    shadowToneG,
    shadowToneB,
    diffR,
    diffG,
    diffB,
    ambientR,
    ambientG,
    ambientB,
    keyScaleR,
    keyScaleG,
    keyScaleB,
    specTintR,
    specTintG,
    specTintB,
    bounceR,
    bounceG,
    bounceB,
    rimR,
    rimG,
    rimB,
    sssR,
    sssG,
    sssB,
    sat,
    toneLut,
  } = computeShaderConstants(slots, config);

  const indices = lut.pixelIndices;
  const alphas = lut.alphas;
  const factors = lut.lightFactors;
  const dither = lut.dither;
  const count = lut.count;
  const applySat = sat !== 1;

  for (let i = 0; i < count; i++) {
    const fOff = i * LIGHT_FACTORS_STRIDE;
    const lit = factors[fOff];
    const dip = factors[fOff + 1];
    const hiDiff = factors[fOff + 2];
    const specW = factors[fOff + 3];
    const bounceW = factors[fOff + 4];
    const rimW = factors[fOff + 5];
    const sssW = factors[fOff + 6];
    const d = dither[i];

    let linR =
      (shadowToneR + diffR * lit) * dip +
      ambientR +
      hiDiff * keyScaleR +
      specW * specTintR +
      bounceW * bounceR +
      rimW * rimR +
      sssW * sssR;
    let linG =
      (shadowToneG + diffG * lit) * dip +
      ambientG +
      hiDiff * keyScaleG +
      specW * specTintG +
      bounceW * bounceG +
      rimW * rimG +
      sssW * sssG;
    let linB =
      (shadowToneB + diffB * lit) * dip +
      ambientB +
      hiDiff * keyScaleB +
      specW * specTintB +
      bounceW * bounceB +
      rimW * rimB +
      sssW * sssB;

    if (applySat) {
      const lum = 0.2126 * linR + 0.7152 * linG + 0.0722 * linB;
      linR = lum + (linR - lum) * sat;
      linG = lum + (linG - lum) * sat;
      linB = lum + (linB - lum) * sat;
    }

    linR += d;
    linG += d;
    linB += d;

    const r = linR <= 0 ? 0 : linR >= LINEAR_LUT_MAX ? 255 : toneLut[(linR * LINEAR_LUT_SCALE + 0.5) | 0];
    const g = linG <= 0 ? 0 : linG >= LINEAR_LUT_MAX ? 255 : toneLut[(linG * LINEAR_LUT_SCALE + 0.5) | 0];
    const b = linB <= 0 ? 0 : linB >= LINEAR_LUT_MAX ? 255 : toneLut[(linB * LINEAR_LUT_SCALE + 0.5) | 0];

    // Little-endian ABGR packing for ImageData Uint32Array
    u32[indices[i]] = (alphas[i] << 24) | (b << 16) | (g << 8) | r;
  }

  ctx.putImageData(lut.imageData, 0, 0);
}

/**
 * Computes exact 3D orthographic projection parameters for the tangent disc/puck marker.
 */
export interface ProjectedMarkerGeometry {
  baseX: number;
  baseY: number;
  rx: number;
  ry: number;
  /** Extrusion shift along local +Y (radial outward direction) */
  extrudeShift: number;
  /** SVG rotation in degrees so local +Y aligns with radial outward vector */
  rotateDeg: number;
  /** Shadow offset in local puck space */
  shadowLocalX: number;
  shadowLocalY: number;
  nz: number;
}

export function projectSphereMarker(
  pos: SphereMarkerPosition,
  sphereSize: number,
  radiusRatio: number,
  config: SphereLightingConfig
): ProjectedMarkerGeometry {
  const { nx, ny, nz } = markerToNormal(pos);
  const cx = sphereSize * 0.5;
  const cy = sphereSize * 0.5;
  const R = sphereSize * radiusRatio;

  const baseX = cx + nx * R;
  const baseY = cy - ny * R;

  const discRadius = R * 0.165;
  const puckHeight = R * 0.044;
  const radialLen = Math.hypot(nx, ny);

  // Tangent axis stays full width; radial axis foreshortens by cos(theta) = nz
  const rx = discRadius;
  const ry = Math.max(discRadius * 0.22, discRadius * nz);
  const extrudeShift = puckHeight * radialLen;

  // Screen-space radial angle: dx = nx, dy = -ny
  const radAngleRad = radialLen > 1e-4 ? Math.atan2(-ny, nx) : 0;
  const rotateDeg = (radAngleRad * 180) / Math.PI - 90;

  // Subtle cast shadow offset opposite to key light, projected into local rotated frame
  const { lx, ly } = getLightVectors(config);
  const shadowWorldX = -lx * puckHeight * 1.15;
  const shadowWorldY = ly * puckHeight * 1.15; // screen Y inverted
  const cosR = Math.cos(-(rotateDeg * DEG2RAD));
  const sinR = Math.sin(-(rotateDeg * DEG2RAD));
  const shadowLocalX = shadowWorldX * cosR - shadowWorldY * sinR;
  const shadowLocalY = shadowWorldX * sinR + shadowWorldY * cosR;

  return {
    baseX,
    baseY,
    rx,
    ry,
    extrudeShift,
    rotateDeg,
    shadowLocalX,
    shadowLocalY,
    nz,
  };
}
