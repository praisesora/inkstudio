import { BrushPresetId, BrushSettings } from '../types/editor';

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
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 64, 64);
  ctx.fillStyle = '#ffffff';
  // Crisp square with 1px smooth edge for anti-aliasing
  ctx.fillRect(4, 4, 56, 56);
  _squareTipDataUrl = canvas.toDataURL('image/png');
  return _squareTipDataUrl;
}

// Preloaded images cache
const preloadedTipImages = new Map<string, HTMLImageElement>();
export function getPreloadedBuiltinTipImage(dataUrl: string): HTMLImageElement | undefined {
  if (preloadedTipImages.has(dataUrl)) {
    return preloadedTipImages.get(dataUrl);
  }
  const img = new Image();
  img.src = dataUrl;
  preloadedTipImages.set(dataUrl, img);
  return img;
}

// Eagerly generate and preload built-in brush tip textures at startup
if (typeof document !== 'undefined') {
  try {
    const square = getSquareTipDataUrl();
    if (square) getPreloadedBuiltinTipImage(square);
  } catch (err) {
    console.warn('Failed to eagerly initialize brush tips:', err);
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
      smoothing: true,
      stabilization: 15,
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
      smoothing: true,
      stabilization: 15,
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
      smoothing: true,
      stabilization: 15,
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
      smoothing: true,
      stabilization: 15,
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
      minSizeFactor: 0.05,
      flow: 1.0,
      opacity: 1.0,
      hardness: 1.0,
      spacing: 0.035,
      stabilization: 20,
      usePressure: true,
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
      spacing: 0.03,
      stabilization: 24,
      usePressure: true,
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
      spacing: 0.04,
      stabilization: 18,
      usePressure: true,
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
      spacing: 0.05,
      stabilization: 15,
      usePressure: true,
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
      spacing: 0.05,
      stabilization: 10,
      usePressure: true,
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
      spacing: 0.045,
      stabilization: 12,
      usePressure: true,
      smoothing: true,
      customTipAngle: 0,
      customTipAngleDynamics: 'none',
      colorMixing: true, // Also supports subtle blending if desired
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
    tipImage = getPreloadedBuiltinTipImage(tipDataUrl);
  }

  return {
    preset: def.id,
    brushName: def.name,
    customTipDataUrl: tipDataUrl,
    customTipImage: tipImage,
    ...def.settings,
  };
}
