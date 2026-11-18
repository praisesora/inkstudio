import { BrushPresetId, BrushSettings } from '../types/editor';
import { dabHashFloat } from '../engine/CspBrushEngine';

export type BrushCategory = 'pencil-line' | 'color-paint';

export interface BuiltinBrushDefinition {
  id: BrushPresetId;
  name: string;
  category: BrushCategory;
  categoryName: string;
  badge: string;
  badgeBg: string;
  badgeText: string;
  badgeBorder: string;
  desc: string;
  icon: 'pencil' | 'paintbrush' | 'palette' | 'square';
  settings: Partial<BrushSettings>;
  tipGenerator?: () => string; // Returns Base64 PNG data URL
}

// -------------------------------------------------------------
// Procedural High-Resolution Tip Mask Generators
// -------------------------------------------------------------

let _squareTipDataUrl: string | null = null;
export function getSquareTipDataUrl(): string {
  if (_squareTipDataUrl) return _squareTipDataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof canvas.toDataURL !== 'function') return '';
  ctx.clearRect(0, 0, 64, 64);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(4, 4, 56, 56);
  _squareTipDataUrl = canvas.toDataURL('image/png');
  return _squareTipDataUrl;
}

let _realGPenTipDataUrl: string | null = null;
export function getRealGPenTipDataUrl(): string {
  if (_realGPenTipDataUrl) return _realGPenTipDataUrl;
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof canvas.toDataURL !== 'function' || typeof ctx.createImageData !== 'function') {
    return '';
  }

  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;
  const half = size * 0.5;
  const maxR = half - 3;

  for (let y = 0; y < size; y++) {
    const dy = y - half;
    for (let x = 0; x < size; x++) {
      const dx = x - half;
      const r = Math.hypot(dx, dy) / maxR;
      if (r > 1.08) continue;

      const angleIdx = Math.round(((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * 96);
      const angularTooth =
        (dabHashFloat(angleIdx, 0, 1, 701) - 0.5) * 0.14 +
        (dabHashFloat(Math.floor(angleIdx * 0.5), 1, 2, 709) - 0.5) * 0.1;
      const microGrain = (dabHashFloat(x, y, 3, 719) - 0.5) * 0.12;
      const effEdge = 0.9 + angularTooth + microGrain * 0.5;

      let alpha = 0;
      if (r <= effEdge - 0.08) {
        alpha = 1.0;
      } else if (r < effEdge + 0.08) {
        const t = (effEdge + 0.08 - r) / 0.16;
        alpha = t * t * (3 - 2 * t);
      }

      if (alpha > 0.01) {
        const idx = (y * size + x) * 4;
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = Math.round(alpha * 255);
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  _realGPenTipDataUrl = canvas.toDataURL('image/png');
  return _realGPenTipDataUrl;
}

let _bristleTipDataUrl: string | null = null;
export function getBristleTipDataUrl(): string {
  if (_bristleTipDataUrl) return _bristleTipDataUrl;
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof canvas.toDataURL !== 'function' || typeof ctx.createImageData !== 'function') {
    return '';
  }

  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;
  const half = size * 0.5;
  const maxR = half - 4;

  // Deterministic multi-filament hog-bristle cluster
  const filaments: { cx: number; cy: number; rad: number; str: number }[] = [];
  const count = 42;
  for (let i = 0; i < count; i++) {
    const u = dabHashFloat(i, 11, i, 811);
    const v = dabHashFloat(i, 23, i, 823);
    const rr = maxR * 0.86 * Math.sqrt(u);
    const th = v * Math.PI * 2;
    filaments.push({
      cx: half + rr * Math.cos(th),
      cy: half + rr * Math.sin(th) * 0.68,
      rad: 2.2 + dabHashFloat(i, 37, i, 829) * 3.8,
      str: 0.55 + dabHashFloat(i, 41, i, 839) * 0.45,
    });
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let f = 0; f < filaments.length; f++) {
        const fil = filaments[f];
        const d = Math.hypot(x - fil.cx, y - fil.cy) / fil.rad;
        if (d < 1.0) {
          const w = (1.0 - d) * (1.0 - d) * fil.str;
          if (w > acc) acc = Math.min(1.0, acc * 0.35 + w);
        }
      }
      if (acc > 0.02) {
        const idx = (y * size + x) * 4;
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = Math.min(255, Math.round(acc * 255));
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  _bristleTipDataUrl = canvas.toDataURL('image/png');
  return _bristleTipDataUrl;
}

// Preloaded images cache
const preloadedTipImages = new Map<string, HTMLImageElement>();
export function getPreloadedBuiltinTipImage(dataUrl: string): HTMLImageElement | undefined {
  if (!dataUrl || typeof Image === 'undefined') return undefined;
  if (preloadedTipImages.has(dataUrl)) {
    return preloadedTipImages.get(dataUrl);
  }
  const img = new Image();
  img.src = dataUrl;
  preloadedTipImages.set(dataUrl, img);
  return img;
}

// Eagerly generate and preload built-in brush tip textures at startup
if (typeof document !== 'undefined' && typeof Image !== 'undefined') {
  try {
    const square = getSquareTipDataUrl();
    if (square) getPreloadedBuiltinTipImage(square);
    const realG = getRealGPenTipDataUrl();
    if (realG) getPreloadedBuiltinTipImage(realG);
    const bristle = getBristleTipDataUrl();
    if (bristle) getPreloadedBuiltinTipImage(bristle);
  } catch {
    // Headless test environments may mock document.createElement minimally
  }
}

// -------------------------------------------------------------
// Built-in Brushes Directory organized by Category
// -------------------------------------------------------------

export const BUILTIN_BRUSHES: BuiltinBrushDefinition[] = [
  // ============================================================
  // CATEGORY 1: PENCIL & LINE
  // ============================================================
  {
    id: 'pencil-2b',
    name: 'Pencil (2B)',
    category: 'pencil-line',
    categoryName: 'Pencil & Line',
    badge: '2B',
    badgeBg: 'bg-amber-500/15',
    badgeText: 'text-amber-300',
    badgeBorder: 'border-amber-500/30',
    desc: 'Soft & Black Sketching',
    icon: 'pencil',
    settings: {
      size: 3.5,
      minSizeFactor: 0.25,
      flow: 0.74,
      hardness: 0.8,
      grain: 0.95,
      spacing: 0.08,
      usePressure: true,
      useTilt: true,
      smoothing: true,
      stabilization: 15,
      sharpCorners: true,
      useGpu: true,
    },
  },
  {
    id: 'pencil-4b',
    name: 'Pencil (4B)',
    category: 'pencil-line',
    categoryName: 'Pencil & Line',
    badge: '4B',
    badgeBg: 'bg-orange-500/15',
    badgeText: 'text-orange-300',
    badgeBorder: 'border-orange-500/30',
    desc: 'Extra Soft & Velvety Carbon',
    icon: 'pencil',
    settings: {
      size: 4.5,
      minSizeFactor: 0.2,
      flow: 0.88,
      hardness: 0.7,
      grain: 0.98,
      spacing: 0.08,
      usePressure: true,
      useTilt: true,
      smoothing: true,
      stabilization: 15,
      sharpCorners: true,
      useGpu: true,
    },
  },
  {
    id: 'pencil-hb',
    name: 'Pencil (HB)',
    category: 'pencil-line',
    categoryName: 'Pencil & Line',
    badge: 'HB',
    badgeBg: 'bg-emerald-500/15',
    badgeText: 'text-emerald-300',
    badgeBorder: 'border-emerald-500/30',
    desc: 'Medium Classic',
    icon: 'pencil',
    settings: {
      size: 3.0,
      minSizeFactor: 0.3,
      flow: 0.65,
      hardness: 0.82,
      grain: 0.92,
      spacing: 0.08,
      usePressure: true,
      useTilt: true,
      smoothing: true,
      stabilization: 15,
      sharpCorners: true,
      useGpu: true,
    },
  },
  {
    id: 'pencil-f',
    name: 'Pencil (F)',
    category: 'pencil-line',
    categoryName: 'Pencil & Line',
    badge: 'F',
    badgeBg: 'bg-sky-500/15',
    badgeText: 'text-sky-300',
    badgeBorder: 'border-sky-500/30',
    desc: 'Firm & Fine Lead',
    icon: 'pencil',
    settings: {
      size: 2.5,
      minSizeFactor: 0.35,
      flow: 0.55,
      hardness: 0.85,
      grain: 0.88,
      spacing: 0.08,
      usePressure: true,
      useTilt: true,
      smoothing: true,
      stabilization: 15,
      sharpCorners: true,
      useGpu: true,
    },
  },
  {
    id: 'g-pen',
    name: 'G-Pen (Manga Ink)',
    category: 'pencil-line',
    categoryName: 'Pencil & Line',
    badge: 'Pen',
    badgeBg: 'bg-indigo-500/15',
    badgeText: 'text-indigo-300',
    badgeBorder: 'border-indigo-500/30',
    desc: 'Sharp Pressure Taper & Inking',
    icon: 'paintbrush',
    settings: {
      size: 8,
      minSizeFactor: 0.04,
      flow: 1.0,
      opacity: 1.0,
      hardness: 1.0,
      antiAlias: 2,
      spacing: 0.04,
      stabilization: 20,
      sharpCorners: true,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      useGpu: true,
    },
  },
  {
    id: 'real-g-pen',
    name: 'Real G-Pen (Textured Nib)',
    category: 'pencil-line',
    categoryName: 'Pencil & Line',
    badge: 'Real G',
    badgeBg: 'bg-indigo-500/15',
    badgeText: 'text-indigo-200',
    badgeBorder: 'border-indigo-400/30',
    desc: 'Organic Analog Manga Nib & Tooth',
    icon: 'paintbrush',
    tipGenerator: getRealGPenTipDataUrl,
    settings: {
      size: 9,
      minSizeFactor: 0.03,
      flow: 1.0,
      opacity: 1.0,
      hardness: 1.0,
      antiAlias: 1,
      spacing: 0.045,
      grain: 0.38,
      paperTextureMode: 'subtract',
      customTipAngleDynamics: 'direction',
      stabilization: 18,
      sharpCorners: true,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      useGpu: true,
    },
  },
  {
    id: 'maru-pen',
    name: 'Maru Pen (Mapping Pen)',
    category: 'pencil-line',
    categoryName: 'Pencil & Line',
    badge: 'Maru',
    badgeBg: 'bg-violet-500/15',
    badgeText: 'text-violet-300',
    badgeBorder: 'border-violet-500/30',
    desc: 'Delicate Manga Crosshatching & Hairlines',
    icon: 'paintbrush',
    settings: {
      size: 4.5,
      minSizeFactor: 0.02,
      flow: 1.0,
      opacity: 1.0,
      hardness: 1.0,
      antiAlias: 2,
      spacing: 0.035,
      stabilization: 24,
      sharpCorners: true,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      useGpu: true,
    },
  },
  {
    id: 'turnip-pen',
    name: 'Turnip Pen (Kabura Pen)',
    category: 'pencil-line',
    categoryName: 'Pencil & Line',
    badge: 'Turnip',
    badgeBg: 'bg-teal-500/15',
    badgeText: 'text-teal-300',
    badgeBorder: 'border-teal-500/30',
    desc: 'Uniform Contours & Manga Character Lineart',
    icon: 'paintbrush',
    settings: {
      size: 9.0,
      minSizeFactor: 0.28,
      flow: 1.0,
      opacity: 1.0,
      hardness: 1.0,
      antiAlias: 2,
      spacing: 0.05,
      stabilization: 18,
      sharpCorners: true,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      useGpu: true,
    },
  },
  {
    id: 'calligraphy-pen',
    name: 'Calligraphy Pen',
    category: 'pencil-line',
    categoryName: 'Pencil & Line',
    badge: 'Calli',
    badgeBg: 'bg-fuchsia-500/15',
    badgeText: 'text-fuchsia-300',
    badgeBorder: 'border-fuchsia-500/30',
    desc: '45-Degree Flat Chisel Nib',
    icon: 'paintbrush',
    settings: {
      size: 14,
      minSizeFactor: 0.35,
      flow: 1.0,
      opacity: 1.0,
      hardness: 1.0,
      thickness: 0.22,
      customTipAngle: 45,
      customTipAngleDynamics: 'none',
      antiAlias: 2,
      spacing: 0.035,
      stabilization: 22,
      sharpCorners: true,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      useGpu: true,
    },
  },
  {
    id: 'round',
    name: 'Round Brush',
    category: 'pencil-line',
    categoryName: 'Pencil & Line',
    badge: 'Ink',
    badgeBg: 'bg-blue-500/15',
    badgeText: 'text-blue-300',
    badgeBorder: 'border-blue-500/30',
    desc: 'Smooth Digital Inking',
    icon: 'paintbrush',
    settings: {
      size: 14,
      minSizeFactor: 0.15,
      flow: 0.85,
      opacity: 1.0,
      hardness: 0.9,
      spacing: 0.08,
      stabilization: 15,
      sharpCorners: true,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      useGpu: true,
    },
  },
  // ============================================================
  // CATEGORY 2: COLOR & PAINT
  // ============================================================
  {
    id: 'airbrush-soft',
    name: 'Soft Airbrush',
    category: 'color-paint',
    categoryName: 'Color & Paint',
    badge: 'Air',
    badgeBg: 'bg-pink-500/15',
    badgeText: 'text-pink-300',
    badgeBorder: 'border-pink-500/30',
    desc: 'Silky Gaussian Radial Falloff & Delicate Glaze',
    icon: 'paintbrush',
    settings: {
      size: 48,
      minSizeFactor: 0.35,
      flow: 0.28,
      opacity: 1.0,
      hardness: 0.0,
      spacing: 0.08,
      adjustDensityByGap: true,
      stabilization: 10,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      useGpu: true,
    },
  },
  {
    id: 'spray-tone',
    name: 'Tone Spray Airbrush',
    category: 'color-paint',
    categoryName: 'Color & Paint',
    badge: 'Spray',
    badgeBg: 'bg-rose-500/15',
    badgeText: 'text-rose-300',
    badgeBorder: 'border-rose-500/30',
    desc: 'Crisp Binary Manga Tone Stipple Spray',
    icon: 'paintbrush',
    tipGenerator: getSquareTipDataUrl,
    settings: {
      size: 44,
      minSizeFactor: 0.4,
      flow: 0.95,
      opacity: 1.0,
      hardness: 1.0,
      antiAlias: 0,
      spacing: 0.14,
      spray: {
        enabled: true,
        size: 2,
        density: 12,
        bias: 0.3,
      },
      stabilization: 8,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      useGpu: true,
    },
  },
  {
    id: 'flat-marker',
    name: 'Flat Marker (Copic)',
    category: 'color-paint',
    categoryName: 'Color & Paint',
    badge: 'Marker',
    badgeBg: 'bg-cyan-500/15',
    badgeText: 'text-cyan-300',
    badgeBorder: 'border-cyan-500/30',
    desc: 'Compare-Density Even Wash Chisel Marker',
    icon: 'square',
    settings: {
      size: 28,
      minSizeFactor: 0.65,
      flow: 0.58,
      opacity: 0.78,
      hardness: 0.92,
      thickness: 0.32,
      customTipAngle: 30,
      customTipAngleDynamics: 'none',
      blendTipsMode: 'compare',
      adjustDensityByGap: true,
      spacing: 0.04,
      stabilization: 12,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      useGpu: true,
    },
  },
  {
    id: 'opaque-watercolor',
    name: 'Opaque Watercolor',
    category: 'color-paint',
    categoryName: 'Color & Paint',
    badge: 'Water',
    badgeBg: 'bg-sky-500/15',
    badgeText: 'text-sky-300',
    badgeBorder: 'border-sky-500/30',
    desc: 'Creamy Perceptual OKLab Blending Brush',
    icon: 'palette',
    settings: {
      size: 26,
      minSizeFactor: 0.28,
      flow: 0.74,
      opacity: 1.0,
      hardness: 0.45,
      spacing: 0.06,
      colorMixing: true,
      perceptualMixing: true,
      mixingMode: 'blend',
      amountOfPaint: 0.58,
      densityOfPaint: 0.75,
      colorStretch: 0.68,
      stabilization: 12,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      useGpu: true,
    },
  },
  {
    id: 'transparent-watercolor',
    name: 'Transparent Watercolor',
    category: 'color-paint',
    categoryName: 'Color & Paint',
    badge: 'Wash',
    badgeBg: 'bg-blue-500/15',
    badgeText: 'text-blue-200',
    badgeBorder: 'border-blue-400/30',
    desc: 'Capillary Wet-Edge Rim & Cold-Press Grain',
    icon: 'palette',
    settings: {
      size: 32,
      minSizeFactor: 0.32,
      flow: 0.44,
      opacity: 0.9,
      hardness: 0.35,
      spacing: 0.06,
      blendTipsMode: 'compare',
      adjustDensityByGap: true,
      grain: 0.45,
      paperTextureMode: 'multiply',
      wetEdge: 0.65,
      wetEdgeRadius: 3.5,
      wetEdgeAlphaPower: 35,
      wetEdgeValuePower: 18,
      colorMixing: true,
      perceptualMixing: true,
      mixingMode: 'running_color',
      amountOfPaint: 0.45,
      densityOfPaint: 0.55,
      colorStretch: 0.72,
      stabilization: 12,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      useGpu: true,
    },
  },
  {
    id: 'oil-paint',
    name: 'Thick Oil Paint',
    category: 'color-paint',
    categoryName: 'Color & Paint',
    badge: 'Oil',
    badgeBg: 'bg-amber-500/15',
    badgeText: 'text-amber-300',
    badgeBorder: 'border-amber-500/30',
    desc: 'Directional Hog-Bristle Impasto Mixing',
    icon: 'palette',
    tipGenerator: getBristleTipDataUrl,
    settings: {
      size: 30,
      minSizeFactor: 0.3,
      flow: 0.92,
      opacity: 1.0,
      hardness: 0.95,
      spacing: 0.045,
      customTipAngleDynamics: 'direction',
      grain: 0.25,
      paperTextureMode: 'subtract',
      colorMixing: true,
      perceptualMixing: true,
      mixingMode: 'blend',
      amountOfPaint: 0.74,
      densityOfPaint: 0.88,
      colorStretch: 0.8,
      stabilization: 12,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      useGpu: true,
    },
  },
  {
    id: 'soft-blender',
    name: 'Soft Smudge Blender',
    category: 'color-paint',
    categoryName: 'Color & Paint',
    badge: 'Blend',
    badgeBg: 'bg-purple-500/15',
    badgeText: 'text-purple-300',
    badgeBorder: 'border-purple-500/30',
    desc: 'Zero-Pigment Wet Color Stretch & Blur',
    icon: 'palette',
    settings: {
      size: 36,
      minSizeFactor: 0.5,
      flow: 0.85,
      opacity: 1.0,
      hardness: 0.25,
      spacing: 0.05,
      colorMixing: true,
      perceptualMixing: true,
      mixingMode: 'smear',
      amountOfPaint: 0.0,
      densityOfPaint: 0.0,
      colorStretch: 0.86,
      stabilization: 10,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      useGpu: true,
    },
  },
  {
    id: 'square-digital',
    name: 'Square Color Brush',
    category: 'color-paint',
    categoryName: 'Color & Paint',
    badge: 'Square',
    badgeBg: 'bg-teal-500/15',
    badgeText: 'text-teal-300',
    badgeBorder: 'border-teal-500/30',
    desc: 'Classic Flat Digital Coloring & Hard-Surface Blocking',
    icon: 'square',
    tipGenerator: getSquareTipDataUrl,
    settings: {
      size: 24,
      minSizeFactor: 0.25,
      flow: 0.95,
      opacity: 1.0,
      hardness: 1.0,
      spacing: 0.07,
      stabilization: 12,
      usePressure: true,
      useTilt: false,
      smoothing: true,
      customTipAngle: 0,
      customTipAngleDynamics: 'none',
      colorMixing: true,
      perceptualMixing: true,
      amountOfPaint: 0.88,
      densityOfPaint: 0.95,
      colorStretch: 0.4,
      mixingMode: 'blend',
      useGpu: true,
    },
  },
];

/**
 * Returns the full brush settings for a builtin preset.
 */
export function getBuiltinBrushConfig(presetId: BrushPresetId): Partial<BrushSettings> | null {
  const def = BUILTIN_BRUSHES.find((b) => b.id === presetId);
  if (!def) return null;

  let tipDataUrl: string | undefined = undefined;
  let tipImage: HTMLImageElement | undefined = undefined;

  if (def.tipGenerator) {
    tipDataUrl = def.tipGenerator();
    if (tipDataUrl) {
      tipImage = getPreloadedBuiltinTipImage(tipDataUrl);
    }
  }

  return {
    preset: def.id,
    brushName: def.name,
    customTipDataUrl: tipDataUrl,
    customTipImage: tipImage,
    ...def.settings,
  };
}
