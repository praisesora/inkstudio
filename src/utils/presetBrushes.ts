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

let _oilThickTipDataUrl: string | null = null;
export function getOilThickTipDataUrl(): string {
  if (_oilThickTipDataUrl) return _oilThickTipDataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 96, 96);

  // Synthesize realistic hog bristle head with distinct, separated bristle tracks
  // Bristle strands run along X (direction of motion), spaced along Y
  const strandOffsets = [-32, -26, -20, -15, -10, -5, 0, 5, 10, 15, 20, 26, 32];

  strandOffsets.forEach((yOff, idx) => {
    const yCenter = 48 + yOff;
    const strandRadius = Math.abs(yOff) / 36;
    if (strandRadius >= 1.0) return;

    // Outer strands are slightly shorter and thinner
    const lengthFactor = Math.sqrt(1.0 - strandRadius * strandRadius);
    const strandLength = Math.max(16, 52 * lengthFactor);
    const xStart = 48 - strandLength / 2;
    const xEnd = 48 + strandLength / 2;

    const bristleWidth = idx % 2 === 0 ? 3.0 : 2.2;
    const alpha = (0.75 + (idx % 3) * 0.1) * (1.0 - strandRadius * 0.25);

    ctx.save();
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
    ctx.lineWidth = bristleWidth;
    ctx.lineCap = 'round';

    ctx.beginPath();
    // Subtle natural jitter along the fiber
    const wave1 = Math.sin(idx * 1.7) * 1.5;
    ctx.moveTo(xStart, yCenter - wave1);
    ctx.bezierCurveTo(
      48 - 10,
      yCenter + wave1,
      48 + 10,
      yCenter - wave1 * 0.8,
      xEnd,
      yCenter + wave1 * 0.5
    );
    ctx.stroke();

    // Secondary sub-hair for dense natural impasto texture
    if (idx % 2 === 0) {
      ctx.strokeStyle = `rgba(255, 255, 255, ${(alpha * 0.6).toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(xStart + 4, yCenter + 1.8);
      ctx.lineTo(xEnd - 4, yCenter + 1.8);
      ctx.stroke();
    }
    ctx.restore();
  });

  _oilThickTipDataUrl = canvas.toDataURL('image/png');
  return _oilThickTipDataUrl;
}

let _oilGlazeTipDataUrl: string | null = null;
export function getOilGlazeTipDataUrl(): string {
  if (_oilGlazeTipDataUrl) return _oilGlazeTipDataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 96, 96);

  // Soft filbert oval bristle with fine striations
  const grad = ctx.createRadialGradient(48, 48, 2, 48, 48, 42);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.88)');
  grad.addColorStop(0.55, 'rgba(255, 255, 255, 0.6)');
  grad.addColorStop(0.85, 'rgba(255, 255, 255, 0.2)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(48, 48, 42, 30, 0, 0, Math.PI * 2);
  ctx.fill();

  // Fine bristle striations aligned horizontally
  for (let y = 20; y <= 76; y += 3.2) {
    const yNorm = Math.abs(y - 48) / 30;
    if (yNorm < 0.95) {
      const len = Math.sqrt(1 - yNorm * yNorm) * 36;
      ctx.strokeStyle = `rgba(255, 255, 255, ${(0.18 + (y % 5 === 0 ? 0.22 : 0.06)).toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(48 - len, y);
      ctx.lineTo(48 + len, y);
      ctx.stroke();
    }
  }

  _oilGlazeTipDataUrl = canvas.toDataURL('image/png');
  return _oilGlazeTipDataUrl;
}

let _chalkRoughTipDataUrl: string | null = null;
export function getChalkRoughTipDataUrl(): string {
  if (_chalkRoughTipDataUrl) return _chalkRoughTipDataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 64, 64);

  const cx = 32;
  const cy = 32;
  const radius = 25;

  // Porous powdery crumbly chalk texture with deep tooth voids
  for (let x = 4; x < 60; x += 2.2) {
    for (let y = 4; y < 60; y += 2.2) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius) {
        const noise = (Math.sin(x * 12.3 + y * 7.1) * Math.cos(y * 11.2 - x * 5.4) * 0.5 + 0.5);
        if (noise > 0.32) {
          const edgeFalloff = 1.0 - (d / radius) * 0.65;
          const a = Math.min(1.0, noise * edgeFalloff * 1.4);
          ctx.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
          ctx.fillRect(x, y, 2.2, 2.2);
        }
      }
    }
  }

  _chalkRoughTipDataUrl = canvas.toDataURL('image/png');
  return _chalkRoughTipDataUrl;
}

let _chalkPastelTipDataUrl: string | null = null;
export function getChalkPastelTipDataUrl(): string {
  if (_chalkPastelTipDataUrl) return _chalkPastelTipDataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 64, 64);

  // Soft rounded chalk stick shape
  ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
  ctx.beginPath();
  ctx.roundRect(8, 8, 48, 48, 12);
  ctx.fill();

  // Internal porous powder texture
  for (let x = 10; x < 54; x += 2.8) {
    for (let y = 10; y < 54; y += 2.8) {
      const n = (Math.sin(x * 9.1 + y * 6.3) * 0.5 + 0.5);
      if (n > 0.38) {
        ctx.fillStyle = `rgba(255, 255, 255, ${(n * 0.7).toFixed(2)})`;
        ctx.fillRect(x, y, 2.6, 2.6);
      }
    }
  }

  _chalkPastelTipDataUrl = canvas.toDataURL('image/png');
  return _chalkPastelTipDataUrl;
}

let _smudgeTipDataUrl: string | null = null;
export function getSmudgeTipDataUrl(): string {
  if (_smudgeTipDataUrl) return _smudgeTipDataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 64, 64);

  // Feathered blender tip with soft Gaussian core for creamy paint smearing
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 29);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  grad.addColorStop(0.4, 'rgba(255, 255, 255, 0.75)');
  grad.addColorStop(0.75, 'rgba(255, 255, 255, 0.3)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0)');

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(32, 32, 29, 0, Math.PI * 2);
  ctx.fill();

  _smudgeTipDataUrl = canvas.toDataURL('image/png');
  return _smudgeTipDataUrl;
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

// Eagerly generate and preload all built-in brush tip textures at startup
if (typeof document !== 'undefined') {
  try {
    const square = getSquareTipDataUrl();
    const oilThick = getOilThickTipDataUrl();
    const oilGlaze = getOilGlazeTipDataUrl();
    const chalkRough = getChalkRoughTipDataUrl();
    const chalkPastel = getChalkPastelTipDataUrl();
    const smudge = getSmudgeTipDataUrl();
    [square, oilThick, oilGlaze, chalkRough, chalkPastel, smudge].forEach((url) => {
      if (url) getPreloadedBuiltinTipImage(url);
    });
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
      minSizeFactor: 0.08,
      flow: 1.0,
      opacity: 1.0,
      hardness: 1.0,
      spacing: 0.03,
      stabilization: 20,
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
      hardness: 1.0,
      spacing: 0.06,
      stabilization: 15,
      usePressure: true,
      smoothing: true,
      useGpu: true,
    },
  },

  // ============================================================
  // CATEGORY 2: COLOR & PAINT (Oil, Chalk, Smudge, Square Coloring)
  // ============================================================
  {
    id: 'oil-thick',
    name: 'Thick Oil Paint',
    category: 'color-paint',
    categoryName: 'Color & Paint',
    badge: 'Oil',
    badgeBg: 'bg-rose-500/15',
    badgeText: 'text-rose-300',
    badgeBorder: 'border-rose-500/30',
    desc: 'Authentic Impasto with Natural Bristle Lines',
    icon: 'palette',
    tipGenerator: getOilThickTipDataUrl,
    settings: {
      size: 28,
      minSizeFactor: 0.35,
      flow: 0.92,
      opacity: 1.0,
      hardness: 0.9,
      spacing: 0.07, // Optimal spacing for crisp individual bristle tracks
      stabilization: 12,
      usePressure: true,
      smoothing: true,
      customTipAngle: 0,
      customTipAngleDynamics: 'direction', // Bristles curve naturally with stroke!
      colorMixing: true,
      amountOfPaint: 0.65,
      densityOfPaint: 0.92,
      colorStretch: 0.78,
      mixingMode: 'running_color',
      wetEdge: 0.12,
      grain: 0.15,
      useGpu: true,
    },
  },
  {
    id: 'oil-glaze',
    name: 'Oil Glazing Brush',
    category: 'color-paint',
    categoryName: 'Color & Paint',
    badge: 'Glaze',
    badgeBg: 'bg-purple-500/15',
    badgeText: 'text-purple-300',
    badgeBorder: 'border-purple-500/30',
    desc: 'Wet Blending & Silky Translucent Striations',
    icon: 'palette',
    tipGenerator: getOilGlazeTipDataUrl,
    settings: {
      size: 34,
      minSizeFactor: 0.4,
      flow: 0.72,
      opacity: 0.85,
      hardness: 0.75,
      spacing: 0.06,
      stabilization: 10,
      usePressure: true,
      smoothing: true,
      customTipAngle: 0,
      customTipAngleDynamics: 'direction',
      colorMixing: true,
      amountOfPaint: 0.38,
      densityOfPaint: 0.62,
      colorStretch: 0.86,
      mixingMode: 'running_color',
      wetEdge: 0.2,
      grain: 0.08,
      useGpu: true,
    },
  },
  {
    id: 'blend-smudge',
    name: 'Smooth Smudge & Blender',
    category: 'color-paint',
    categoryName: 'Color & Paint',
    badge: 'Smudge',
    badgeBg: 'bg-cyan-500/15',
    badgeText: 'text-cyan-300',
    badgeBorder: 'border-cyan-500/30',
    desc: 'CSP Wet Paint Smear & Seamless Edge Blending',
    icon: 'palette',
    tipGenerator: getSmudgeTipDataUrl,
    settings: {
      size: 32,
      minSizeFactor: 0.3,
      flow: 0.85,
      opacity: 1.0,
      hardness: 0.65,
      spacing: 0.045,
      stabilization: 12,
      usePressure: true,
      smoothing: true,
      customTipAngle: 0,
      customTipAngleDynamics: 'none',
      colorMixing: true,
      amountOfPaint: 0.0, // PURE SMUDGE: zero fresh pigment, drags existing paint!
      densityOfPaint: 0.88,
      colorStretch: 0.88,
      mixingMode: 'running_color',
      useGpu: true,
    },
  },
  {
    id: 'chalk-rough',
    name: 'Rough Chalk',
    category: 'color-paint',
    categoryName: 'Color & Paint',
    badge: 'Chalk',
    badgeBg: 'bg-yellow-500/15',
    badgeText: 'text-yellow-300',
    badgeBorder: 'border-yellow-500/30',
    desc: 'Powdery Texture on Heavy Tooth',
    icon: 'paintbrush',
    tipGenerator: getChalkRoughTipDataUrl,
    settings: {
      size: 24,
      minSizeFactor: 0.35,
      flow: 0.8,
      opacity: 0.9,
      hardness: 0.92,
      spacing: 0.075,
      stabilization: 8,
      usePressure: true,
      smoothing: true,
      customTipAngle: 0,
      customTipAngleDynamics: 'direction',
      grain: 0.88,
      colorMixing: true,
      amountOfPaint: 0.68,
      densityOfPaint: 0.82,
      colorStretch: 0.55,
      mixingMode: 'blend',
      useGpu: true,
    },
  },
  {
    id: 'chalk-pastel',
    name: 'Pastel Chalk',
    category: 'color-paint',
    categoryName: 'Color & Paint',
    badge: 'Pastel',
    badgeBg: 'bg-lime-500/15',
    badgeText: 'text-lime-300',
    badgeBorder: 'border-lime-500/30',
    desc: 'Soft Pigment for Organic Smudge & Blending',
    icon: 'paintbrush',
    tipGenerator: getChalkPastelTipDataUrl,
    settings: {
      size: 26,
      minSizeFactor: 0.35,
      flow: 0.84,
      opacity: 0.92,
      hardness: 0.78,
      spacing: 0.065,
      stabilization: 10,
      usePressure: true,
      smoothing: true,
      customTipAngle: 0,
      customTipAngleDynamics: 'direction',
      grain: 0.65,
      colorMixing: true,
      amountOfPaint: 0.45,
      densityOfPaint: 0.78,
      colorStretch: 0.72,
      mixingMode: 'running_color',
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
