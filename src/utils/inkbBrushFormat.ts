import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import {
  ALL_BLEND_MODES,
  BlendMode,
  BristleProfilePreset,
  BristleSettings,
  BrushCategory,
  BrushDynamics,
  BrushRenderMode,
  BrushSettings,
  CspAngleDynamicsMode,
  CspBlendTipsMode,
  CspBrush,
  CspPaperTextureMode,
  CspSensorConfig,
  CspSpraySettings,
  CspSubTip,
  CspTaperSettings,
  CspTipFlipMode,
  GrainMappingMode,
  ImpastoSettings,
  NaturalMixingMode,
  NaturalPaintSettings,
  SurfaceTextureId,
} from '../types/editor';
import { getEffectiveBrushSettings } from './brushPresetManager';
import {
  deleteCustomBrush,
  getCachedCustomBrushes,
  loadCustomBrushes,
  prepareBrushSettingsForCsp,
  saveCustomBrush,
} from './brushStorage';
import { parseSutFile } from './sutParser';
import { toolStoreActions } from '../stores';

export const INKB_FORMAT = 'inkb';
export const INKB_VERSION = 2;
export const INKB_EXTENSION = '.inkb';

const MAX_INKB_FILE_BYTES = 25 * 1024 * 1024;
const MAX_INKB_JSON_BYTES = 32 * 1024 * 1024;
const MAX_SUB_TIPS = 32;
const MAX_CURVE_POINTS = 64;
const SAFE_RASTER_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i;

const VALID_SUBTIP_ORDERS = new Set(['random', 'sequential', 'direction', 'reverse']);
const VALID_ANGLE_DYNAMICS = new Set<CspAngleDynamicsMode>([
  'none',
  'direction',
  'tilt',
  'twist',
  'random',
  'direction-random',
]);
const VALID_FLIP_MODES = new Set<CspTipFlipMode>(['none', 'random', 'alternate']);
const VALID_BLEND_TIPS = new Set<CspBlendTipsMode>(['normal', 'darken', 'compare']);
const VALID_MIXING_MODES = new Set<NaturalMixingMode>([
  'blend',
  'running_color',
  'smear',
  'impasto_mix',
]);
const VALID_TEXTURE_MODES = new Set<CspPaperTextureMode>([
  'multiply',
  'subtract',
  'compare',
  'overlay',
  'outline',
]);
const VALID_RENDER_MODES = new Set<BrushRenderMode>(['stamp', 'bristle-ribbon', 'bristle-hybrid']);
const VALID_GRAIN_MAPPING_MODES = new Set<GrainMappingMode>([
  'canvas-locked',
  'brush-aligned',
  'stroke-flow',
  'random-per-stroke',
]);
const VALID_SURFACE_TEXTURES = new Set<SurfaceTextureId>([
  'linen-canvas',
  'coarse-burlap',
  'fine-cotton',
  'cold-press-watercolor',
  'rough-pastel',
  'gesso-board',
  'stipple-grain',
]);
const VALID_BRISTLE_PROFILES = new Set<BristleProfilePreset>([
  'round',
  'flat',
  'filbert',
  'fan',
  'rake',
  'knife',
  'custom',
]);
const VALID_CATEGORIES = new Set<BrushCategory | 'custom'>([
  'pen',
  'sketch',
  'brush',
  'natural-paint',
  'custom',
]);
const VALID_BLEND_MODES = new Set<BlendMode>(ALL_BLEND_MODES);

interface InkbArchivePayload {
  format: typeof INKB_FORMAT;
  version: number;
  exportedAt: number;
  brush: Partial<CspBrush>;
}

function clampNum(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

function optNum(val: unknown, min: number, max: number): number | undefined {
  if (typeof val !== 'number' || !Number.isFinite(val)) return undefined;
  return Math.max(min, Math.min(max, val));
}

function optBool(val: unknown): boolean | undefined {
  return typeof val === 'boolean' ? val : undefined;
}

function sanitizeDataUrl(val: unknown): string | undefined {
  if (typeof val !== 'string' || val.length > 16 * 1024 * 1024) return undefined;
  return SAFE_RASTER_DATA_URL_RE.test(val) ? val : undefined;
}

function sanitizeCurve(val: unknown): [number, number][] | undefined {
  if (!Array.isArray(val) || val.length === 0 || val.length > MAX_CURVE_POINTS) return undefined;
  const out: [number, number][] = [];
  for (const pt of val) {
    if (
      Array.isArray(pt) &&
      pt.length === 2 &&
      typeof pt[0] === 'number' &&
      typeof pt[1] === 'number' &&
      Number.isFinite(pt[0]) &&
      Number.isFinite(pt[1])
    ) {
      out.push([Math.max(0, Math.min(1, pt[0])), Math.max(0, Math.min(1, pt[1]))]);
    }
  }
  return out.length >= 2 ? out : undefined;
}

function sanitizeSensor(val: unknown): CspSensorConfig | undefined {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
  const s = val as Record<string, unknown>;
  const out: CspSensorConfig = {};
  if (typeof s.usePressure === 'boolean') out.usePressure = s.usePressure;
  const pMin = optNum(s.pressureMin, 0, 1);
  if (pMin !== undefined) out.pressureMin = pMin;
  const pCurve = sanitizeCurve(s.pressureCurve);
  if (pCurve) out.pressureCurve = pCurve;
  if (typeof s.useTilt === 'boolean') out.useTilt = s.useTilt;
  const tMin = optNum(s.tiltMin, 0, 1);
  if (tMin !== undefined) out.tiltMin = tMin;
  if (typeof s.useTiltAzimuth === 'boolean') out.useTiltAzimuth = s.useTiltAzimuth;
  if (typeof s.useBarrelTwist === 'boolean') out.useBarrelTwist = s.useBarrelTwist;
  const twMin = optNum(s.twistMin, 0, 1);
  if (twMin !== undefined) out.twistMin = twMin;
  if (typeof s.useVelocity === 'boolean') out.useVelocity = s.useVelocity;
  const vMin = optNum(s.velocityMin, 0, 1);
  if (vMin !== undefined) out.velocityMin = vMin;
  if (typeof s.invertVelocity === 'boolean') out.invertVelocity = s.invertVelocity;
  if (typeof s.useDistance === 'boolean') out.useDistance = s.useDistance;
  const dMin = optNum(s.distanceMin, 0, 1);
  if (dMin !== undefined) out.distanceMin = dMin;
  const dMax = optNum(s.distanceMaxPx, 10, 10000);
  if (dMax !== undefined) out.distanceMaxPx = dMax;
  if (typeof s.useRandom === 'boolean') out.useRandom = s.useRandom;
  const rMin = optNum(s.randomMin, 0, 1);
  if (rMin !== undefined) out.randomMin = rMin;
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeBristle(val: unknown): BristleSettings | undefined {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
  const b = val as Record<string, unknown>;
  const profile =
    typeof b.profile === 'string' && VALID_BRISTLE_PROFILES.has(b.profile as BristleProfilePreset)
      ? (b.profile as BristleProfilePreset)
      : 'filbert';
  return {
    profile,
    count: Math.round(clampNum(b.count, 4, 64, 28)),
    clumping: clampNum(b.clumping, 0, 1, 0.35),
    stiffness: clampNum(b.stiffness, 0, 1, 0.6),
    length: clampNum(b.length, 0.2, 2.0, 1.0),
    splay: clampNum(b.splay, 0, 1, 0.3),
    irregularity: clampNum(b.irregularity, 0, 1, 0.35),
    edgeRidge: optNum(b.edgeRidge, 0, 1),
  };
}

function sanitizeNaturalPaint(val: unknown): NaturalPaintSettings | undefined {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
  const n = val as Record<string, unknown>;
  return {
    enabled: Boolean(n.enabled),
    spatialMixing: Boolean(n.spatialMixing),
    pigmentMixingStrength: clampNum(n.pigmentMixingStrength, 0, 1, 0.85),
    paintLoad: clampNum(n.paintLoad, 0, 1, 0.85),
    depletionRate: clampNum(n.depletionRate, 0, 1, 0.25),
    wetness: clampNum(n.wetness, 0, 1, 0.5),
    viscosity: clampNum(n.viscosity, 0, 1, 0.5),
    autoClean: typeof n.autoClean === 'boolean' ? n.autoClean : true,
    chargePerPressure: clampNum(n.chargePerPressure, 0, 1, 0.45),
    dryBrush: clampNum(n.dryBrush, 0, 1, 0.3),
    granulation: optNum(n.granulation, 0, 1),
    penetrationCurve: sanitizeCurve(n.penetrationCurve),
  };
}

function sanitizeImpasto(val: unknown): ImpastoSettings | undefined {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
  const imp = val as Record<string, unknown>;
  return {
    enabled: Boolean(imp.enabled),
    depth: clampNum(imp.depth, 0, 1, 0.55),
    bristleRelief: clampNum(imp.bristleRelief, 0, 1, 0.6),
    gloss: clampNum(imp.gloss, 0, 1, 0.45),
    reliefContrast: clampNum(imp.reliefContrast, 0, 1, 0.55),
    lightAzimuth: clampNum(imp.lightAzimuth, 0, 360, 315),
    lightElevation: clampNum(imp.lightElevation, 5, 85, 42),
  };
}

function sanitizeSpray(val: unknown): CspSpraySettings | undefined {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
  const s = val as Record<string, unknown>;
  if (typeof s.enabled !== 'boolean') return undefined;
  return {
    enabled: s.enabled,
    size: clampNum(s.size, 0, 1000, 10),
    density: clampNum(s.density, 0, 100, 5),
    bias: clampNum(s.bias, -100, 100, 0),
  };
}

function sanitizeTaper(val: unknown): CspTaperSettings | undefined {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
  const t = val as Record<string, unknown>;
  return {
    useIn: optBool(t.useIn),
    inLength: clampNum(t.inLength, 0, 2000, 0),
    inRatio: clampNum(t.inRatio, 0, 1, 0),
    useOut: optBool(t.useOut),
    outLength: clampNum(t.outLength, 0, 2000, 0),
    outRatio: clampNum(t.outRatio, 0, 1, 0),
    inOutType: optNum(t.inOutType, 0, 10),
    inOutBySpeed: optBool(t.inOutBySpeed),
    startingSharpness: optNum(t.startingSharpness, 0, 1),
    endingSharpness: optNum(t.endingSharpness, 0, 1),
    affectSize: optBool(t.affectSize),
    affectDensity: optBool(t.affectDensity),
    affectOpacity: optBool(t.affectOpacity),
    affectAmountOfPaint: optBool(t.affectAmountOfPaint),
    minAmountRatio: optNum(t.minAmountRatio, 0, 1),
    affectDensityOfPaint: optBool(t.affectDensityOfPaint),
    minPaintDensityRatio: optNum(t.minPaintDensityRatio, 0, 1),
    affectLoad: optBool(t.affectLoad),
    minSizeRatio: optNum(t.minSizeRatio, 0, 1),
    minDensityRatio: optNum(t.minDensityRatio, 0, 1),
  };
}

function sanitizeDynamics(val: unknown): BrushDynamics | undefined {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
  const d = val as Record<string, unknown>;
  return {
    sizeJitter: clampNum(d.sizeJitter, 0, 1, 0),
    angleJitter: clampNum(d.angleJitter, 0, 1, 0),
    roundnessJitter: clampNum(d.roundnessJitter, 0, 1, 0),
    scatter: clampNum(d.scatter, 0, 5, 0),
    scatterBothAxes: Boolean(d.scatterBothAxes),
    count: Math.round(clampNum(d.count, 1, 10, 1)),
    flowJitter: clampNum(d.flowJitter, 0, 1, 0),
    colorJitterEnabled: Boolean(d.colorJitterEnabled),
    hueJitter: clampNum(d.hueJitter, 0, 1, 0),
    saturationJitter: clampNum(d.saturationJitter, 0, 1, 0),
    brightnessJitter: clampNum(d.brightnessJitter, 0, 1, 0),
    temperatureJitter: optNum(d.temperatureJitter, 0, 1),
    foregroundBackgroundJitter: clampNum(d.foregroundBackgroundJitter, 0, 1, 0),
  };
}

function sanitizeSubTips(val: unknown): CspSubTip[] | undefined {
  if (!Array.isArray(val) || val.length === 0) return undefined;
  const out: CspSubTip[] = [];
  for (const item of val.slice(0, MAX_SUB_TIPS)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const st = item as Record<string, unknown>;
    const dataUrl = sanitizeDataUrl(st.dataUrl);
    if (!dataUrl) continue;
    out.push({
      dataUrl,
      width: Math.round(clampNum(st.width, 1, 4096, 128)),
      height: Math.round(clampNum(st.height, 1, 4096, 128)),
      isColor: optBool(st.isColor),
    });
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeBrushName(raw: unknown, fallbackFileName?: string): string {
  const base =
    typeof raw === 'string' && raw.trim()
      ? raw.trim()
      : (fallbackFileName || 'Brush').replace(/\.inkb$/i, '').trim();
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80).trim();
  return cleaned || 'Imported Brush';
}

export function sanitizeBrushFileName(name: string): string {
  const cleaned = name
    .replace(/\.inkb$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const safeBase = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'brush';
  return `${safeBase}${INKB_EXTENSION}`;
}

/**
 * Converts any active or listed brush (built-in or custom) into a self-contained CspBrush
 * suitable for serialization to a `.inkb` file.
 */
export function buildExportableBrush(
  presetId: string,
  customBrushes?: CspBrush[],
  liveSettings?: Partial<BrushSettings>
): CspBrush {
  const effective = getEffectiveBrushSettings(presetId, customBrushes);
  const list = customBrushes && customBrushes.length > 0 ? customBrushes : getCachedCustomBrushes();
  const existingCustom = list.find((b) => b.id === presetId);
  const merged: Partial<BrushSettings> = {
    ...effective,
    ...(liveSettings && liveSettings.preset === presetId ? liveSettings : {}),
  };

  const name = sanitizeBrushName(merged.brushName || existingCustom?.name || presetId);

  return {
    id: existingCustom?.id || `inkb-${presetId}`,
    name,
    category: existingCustom?.category,
    badge: 'INKB',
    desc: existingCustom?.desc,
    tipDataUrl: merged.customTipDataUrl ?? existingCustom?.tipDataUrl,
    tipWidth: existingCustom?.tipWidth,
    tipHeight: existingCustom?.tipHeight,
    secondaryTipDataUrl: merged.dualTipDataUrl ?? existingCustom?.secondaryTipDataUrl,
    secondaryTipWidth: existingCustom?.secondaryTipWidth,
    secondaryTipHeight: existingCustom?.secondaryTipHeight,
    subTips: merged.subTips ?? existingCustom?.subTips,
    subTipOrder: merged.subTipOrder ?? existingCustom?.subTipOrder,
    size: clampNum(merged.size, 0.5, 2000, 12),
    minSizeFactor: clampNum(merged.minSizeFactor, 0, 1, 0.1),
    opacity: clampNum(merged.opacity, 0.01, 1, 1),
    flow: clampNum(merged.flow, 0.01, 1, 1),
    spacing: clampNum(merged.spacing, 0.01, 5, 0.05),
    hardness: clampNum(merged.hardness, 0, 1, 0.9),
    thickness: clampNum(merged.thickness, 0.05, 1, 1),
    thicknessVertical: merged.thicknessVertical,
    angle: clampNum(merged.customTipAngle ?? existingCustom?.angle, -360, 360, 0),
    angleDynamics: merged.customTipAngleDynamics ?? existingCustom?.angleDynamics,
    rotationRandomScale: merged.customTipRotationRandomScale ?? existingCustom?.rotationRandomScale,
    flipH: merged.flipH,
    flipV: merged.flipV,
    antiAlias: merged.antiAlias,
    usePressure: merged.usePressure ?? true,
    useTilt: merged.useTilt,
    tiltScale: merged.tiltScale,
    useVelocity: merged.useVelocity,
    smoothing: merged.smoothing ?? true,
    stabilization: clampNum(merged.stabilization, 0, 50, 10),
    postCorrection: merged.postCorrection,
    sharpCorners: merged.sharpCorners,
    pressureCurve: merged.pressureCurve,
    velocityCurve: merged.velocityCurve,
    brushDensity: merged.brushDensity,
    adjustDensityByGap: merged.adjustDensityByGap,
    blendTipsMode: merged.blendTipsMode,
    brushCombineMode: merged.brushCombineMode,
    sizeSensor: merged.sizeSensor,
    opacitySensor: merged.opacitySensor,
    densitySensor: merged.densitySensor,
    bristleSplaySensor: merged.bristleSplaySensor,
    paintLoadSensor: merged.paintLoadSensor,
    grainPenetrationSensor: merged.grainPenetrationSensor,
    angleSensor: merged.angleSensor,
    scatterSensor: merged.scatterSensor,
    colorMixing: merged.colorMixing,
    perceptualMixing: merged.perceptualMixing,
    amountOfPaint: merged.amountOfPaint,
    densityOfPaint: merged.densityOfPaint,
    colorStretch: merged.colorStretch,
    mixingMode: merged.mixingMode,
    wetEdge: merged.wetEdge,
    wetEdgeRadius: merged.wetEdgeRadius,
    wetEdgeAlphaPower: merged.wetEdgeAlphaPower,
    wetEdgeValuePower: merged.wetEdgeValuePower,
    paperTexture: merged.paperTexture ?? existingCustom?.paperTexture,
    surfaceTextureId: merged.surfaceTextureId ?? existingCustom?.surfaceTextureId,
    grainMappingMode: merged.grainMappingMode ?? existingCustom?.grainMappingMode,
    textureDensity: merged.textureDensity ?? merged.grain,
    paperTextureMode: merged.paperTextureMode,
    paperTextureBrightness: merged.paperTextureBrightness,
    paperTextureContrast: merged.paperTextureContrast,
    paperTextureApplyEachPlot: merged.paperTextureApplyEachPlot,
    paperTextureInverted: merged.paperTextureInverted,
    paperTextureScale: merged.paperTextureScale,
    paperTextureRotate: merged.paperTextureRotate,
    dualBrush: merged.dualBrush,
    dualBrushCompositeMode: merged.dualBrushCompositeMode,
    dualSize: merged.dualSize,
    dualSpacing: merged.dualSpacing,
    dualScatter: merged.dualScatter,
    dualAngle: merged.dualAngle,
    dualScale: merged.dualScale,
    dualSurfaceTextureId: merged.dualSurfaceTextureId,
    dualGrainDepth: merged.dualGrainDepth,
    spray: merged.spray,
    taper: merged.taper,
    isRibbon: merged.isRibbon,
    isColorTip: merged.isColorTip,
    pressureCurveGamma: merged.pressureCurveGamma,
    velocityDynamics: merged.velocityDynamics,
    dynamics: merged.dynamics,
    renderMode: merged.renderMode,
    bristle: merged.bristle,
    naturalPaint: merged.naturalPaint,
    impasto: merged.impasto,
    importedAt: Date.now(),
  };
}

/**
 * Serializes a brush into a compressed `.inkb` binary archive.
 */
export function serializeInkbBrush(brush: CspBrush): Uint8Array {
  const payload: InkbArchivePayload = {
    format: INKB_FORMAT,
    version: INKB_VERSION,
    exportedAt: Date.now(),
    brush: {
      ...brush,
      badge: 'INKB',
    },
  };
  const jsonBytes = strToU8(JSON.stringify(payload));
  return zipSync({ 'brush.json': jsonBytes }, { level: 6 });
}

/**
 * Parses and strictly validates an `.inkb` brush file (ZIP-packed or raw JSON).
 */
export function parseInkbFile(buffer: ArrayBuffer, fileName: string = 'Brush.inkb'): CspBrush {
  if (!buffer || buffer.byteLength === 0) {
    throw new Error('Invalid .inkb file: file is empty.');
  }
  if (buffer.byteLength > MAX_INKB_FILE_BYTES) {
    throw new Error('Invalid .inkb file: exceeds 25 MB safety limit.');
  }

  const bytes = new Uint8Array(buffer);
  let jsonText: string;

  // Detect ZIP magic header ("PK\x03\x04") vs raw UTF-8 JSON
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes, {
        filter: (file) => file.name === 'brush.json' && file.originalSize <= MAX_INKB_JSON_BYTES,
      });
    } catch {
      throw new Error('Invalid .inkb file: corrupted archive.');
    }
    const entry = entries['brush.json'];
    if (!entry || entry.byteLength === 0 || entry.byteLength > MAX_INKB_JSON_BYTES) {
      throw new Error('Invalid .inkb file: missing or oversized brush.json.');
    }
    jsonText = strFromU8(entry);
  } else {
    if (bytes.byteLength > MAX_INKB_JSON_BYTES) {
      throw new Error('Invalid .inkb file: payload too large.');
    }
    jsonText = strFromU8(bytes);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('Invalid .inkb file: malformed JSON payload.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid .inkb file: root must be an object.');
  }

  const root = parsed as Record<string, unknown>;
  if (root.format !== INKB_FORMAT) {
    throw new Error('Invalid .inkb file: unrecognized format header.');
  }
  if (typeof root.version !== 'number' || root.version < 1 || root.version > INKB_VERSION) {
    throw new Error(`Unsupported .inkb brush version: ${String(root.version)}`);
  }

  const rawBrush = root.brush;
  if (!rawBrush || typeof rawBrush !== 'object' || Array.isArray(rawBrush)) {
    throw new Error('Invalid .inkb file: missing brush definition.');
  }
  const b = rawBrush as Record<string, unknown>;

  const name = sanitizeBrushName(b.name, fileName);
  const idSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  return {
    id: `inkb-${idSuffix}`,
    name,
    category:
      typeof b.category === 'string' && VALID_CATEGORIES.has(b.category as BrushCategory | 'custom')
        ? (b.category as BrushCategory | 'custom')
        : undefined,
    badge: 'INKB',
    desc: typeof b.desc === 'string' ? b.desc.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) : undefined,
    tipDataUrl: sanitizeDataUrl(b.tipDataUrl),
    tipWidth: optNum(b.tipWidth, 1, 4096),
    tipHeight: optNum(b.tipHeight, 1, 4096),
    secondaryTipDataUrl: sanitizeDataUrl(b.secondaryTipDataUrl),
    secondaryTipWidth: optNum(b.secondaryTipWidth, 1, 4096),
    secondaryTipHeight: optNum(b.secondaryTipHeight, 1, 4096),
    subTips: sanitizeSubTips(b.subTips),
    subTipOrder:
      typeof b.subTipOrder === 'string' && VALID_SUBTIP_ORDERS.has(b.subTipOrder)
        ? (b.subTipOrder as CspBrush['subTipOrder'])
        : undefined,
    size: clampNum(b.size, 0.5, 2000, 12),
    minSizeFactor: clampNum(b.minSizeFactor, 0, 1, 0.1),
    opacity: clampNum(b.opacity, 0.01, 1, 1),
    flow: clampNum(b.flow, 0.01, 1, 1),
    spacing: clampNum(b.spacing, 0.01, 5, 0.05),
    hardness: clampNum(b.hardness, 0, 1, 0.9),
    thickness: clampNum(b.thickness, 0.05, 1, 1),
    thicknessVertical: optBool(b.thicknessVertical),
    angle: clampNum(b.angle, -360, 360, 0),
    angleDynamics:
      typeof b.angleDynamics === 'string' &&
      VALID_ANGLE_DYNAMICS.has(b.angleDynamics as CspAngleDynamicsMode)
        ? (b.angleDynamics as CspAngleDynamicsMode)
        : undefined,
    rotationRandomScale: optNum(b.rotationRandomScale, 0, 1),
    flipH:
      typeof b.flipH === 'string' && VALID_FLIP_MODES.has(b.flipH as CspTipFlipMode)
        ? (b.flipH as CspTipFlipMode)
        : undefined,
    flipV:
      typeof b.flipV === 'string' && VALID_FLIP_MODES.has(b.flipV as CspTipFlipMode)
        ? (b.flipV as CspTipFlipMode)
        : undefined,
    antiAlias: optNum(b.antiAlias, 0, 3),
    usePressure: typeof b.usePressure === 'boolean' ? b.usePressure : true,
    useTilt: optBool(b.useTilt),
    tiltScale: optNum(b.tiltScale, 0, 2),
    useVelocity: optBool(b.useVelocity),
    smoothing: typeof b.smoothing === 'boolean' ? b.smoothing : true,
    stabilization: clampNum(b.stabilization, 0, 50, 10),
    postCorrection: optNum(b.postCorrection, 0, 5),
    sharpCorners: optBool(b.sharpCorners),
    pressureCurve: sanitizeCurve(b.pressureCurve),
    velocityCurve: sanitizeCurve(b.velocityCurve),
    brushDensity: optNum(b.brushDensity, 0, 1),
    adjustDensityByGap: optBool(b.adjustDensityByGap),
    blendTipsMode:
      typeof b.blendTipsMode === 'string' &&
      VALID_BLEND_TIPS.has(b.blendTipsMode as CspBlendTipsMode)
        ? (b.blendTipsMode as CspBlendTipsMode)
        : undefined,
    brushCombineMode:
      typeof b.brushCombineMode === 'string' &&
      VALID_BLEND_MODES.has(b.brushCombineMode as BlendMode)
        ? (b.brushCombineMode as BlendMode)
        : undefined,
    sizeSensor: sanitizeSensor(b.sizeSensor),
    opacitySensor: sanitizeSensor(b.opacitySensor),
    densitySensor: sanitizeSensor(b.densitySensor),
    bristleSplaySensor: sanitizeSensor(b.bristleSplaySensor),
    paintLoadSensor: sanitizeSensor(b.paintLoadSensor),
    grainPenetrationSensor: sanitizeSensor(b.grainPenetrationSensor),
    angleSensor: sanitizeSensor(b.angleSensor),
    scatterSensor: sanitizeSensor(b.scatterSensor),
    colorMixing: optBool(b.colorMixing),
    perceptualMixing: optBool(b.perceptualMixing),
    amountOfPaint: optNum(b.amountOfPaint, 0, 1),
    densityOfPaint: optNum(b.densityOfPaint, 0, 1),
    colorStretch: optNum(b.colorStretch, 0, 1),
    mixingMode:
      typeof b.mixingMode === 'string' && VALID_MIXING_MODES.has(b.mixingMode as NaturalMixingMode)
        ? (b.mixingMode as CspBrush['mixingMode'])
        : undefined,
    wetEdge: optNum(b.wetEdge, 0, 1),
    wetEdgeRadius: optNum(b.wetEdgeRadius, 0, 100),
    wetEdgeAlphaPower: optNum(b.wetEdgeAlphaPower, 0, 10),
    wetEdgeValuePower: optNum(b.wetEdgeValuePower, 0, 10),
    paperTexture: sanitizeDataUrl(b.paperTexture),
    surfaceTextureId:
      typeof b.surfaceTextureId === 'string' &&
      VALID_SURFACE_TEXTURES.has(b.surfaceTextureId as SurfaceTextureId)
        ? (b.surfaceTextureId as SurfaceTextureId)
        : undefined,
    grainMappingMode:
      typeof b.grainMappingMode === 'string' &&
      VALID_GRAIN_MAPPING_MODES.has(b.grainMappingMode as GrainMappingMode)
        ? (b.grainMappingMode as GrainMappingMode)
        : undefined,
    textureDensity: optNum(b.textureDensity, 0, 1),
    paperTextureMode:
      typeof b.paperTextureMode === 'string' &&
      VALID_TEXTURE_MODES.has(b.paperTextureMode as CspPaperTextureMode)
        ? (b.paperTextureMode as CspPaperTextureMode)
        : undefined,
    paperTextureBrightness: optNum(b.paperTextureBrightness, -100, 100),
    paperTextureContrast: optNum(b.paperTextureContrast, -100, 100),
    paperTextureApplyEachPlot: optBool(b.paperTextureApplyEachPlot),
    paperTextureScale: optNum(b.paperTextureScale, 0.05, 20),
    paperTextureRotate: optNum(b.paperTextureRotate, -360, 360),
    paperTextureInverted: optBool(b.paperTextureInverted),
    dualBrush: optBool(b.dualBrush),
    dualBrushCompositeMode:
      typeof b.dualBrushCompositeMode === 'string' ? b.dualBrushCompositeMode.slice(0, 32) : undefined,
    dualSize: optNum(b.dualSize, 0.5, 2000),
    dualSpacing: optNum(b.dualSpacing, 0.01, 5),
    dualScatter: optNum(b.dualScatter, 0, 5),
    dualAngle: optNum(b.dualAngle, -360, 360),
    dualScale: optNum(b.dualScale, 0.05, 10),
    dualSurfaceTextureId:
      typeof b.dualSurfaceTextureId === 'string' &&
      VALID_SURFACE_TEXTURES.has(b.dualSurfaceTextureId as SurfaceTextureId)
        ? (b.dualSurfaceTextureId as SurfaceTextureId)
        : undefined,
    dualGrainDepth: optNum(b.dualGrainDepth, 0, 1),
    spray: sanitizeSpray(b.spray),
    taper: sanitizeTaper(b.taper),
    isRibbon: optBool(b.isRibbon),
    isColorTip: optBool(b.isColorTip),
    pressureCurveGamma: optNum(b.pressureCurveGamma, 0.1, 5),
    velocityDynamics: optBool(b.velocityDynamics),
    dynamics: sanitizeDynamics(b.dynamics),
    renderMode:
      typeof b.renderMode === 'string' && VALID_RENDER_MODES.has(b.renderMode as BrushRenderMode)
        ? (b.renderMode as BrushRenderMode)
        : undefined,
    bristle: sanitizeBristle(b.bristle),
    naturalPaint: sanitizeNaturalPaint(b.naturalPaint),
    impasto: sanitizeImpasto(b.impasto),
    importedAt: Date.now(),
  };
}

/**
 * Triggers a save dialog (or browser download fallback) for a `[brush].inkb` file.
 */
export async function exportBrushToInkbFile(
  brush: CspBrush
): Promise<{ exported: boolean; fileName: string }> {
  const bytes = serializeInkbBrush(brush);
  const suggestedName = sanitizeBrushFileName(brush.name);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: 'Ink Studio Brush (.inkb)',
            accept: { 'application/octet-stream': [INKB_EXTENSION] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { exported: true, fileName: handle.name || suggestedName };
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError') {
        return { exported: false, fileName: suggestedName };
      }
      // Fall through to anchor download
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { exported: true, fileName: suggestedName };
}

export function isSupportedBrushFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith(INKB_EXTENSION) || lower.endsWith('.sut');
}

/**
 * Unified brush importer supporting both `.inkb` (Ink Studio Brush) and `.sut` (CSP).
 */
export async function importBrushFile(file: File): Promise<CspBrush> {
  const lower = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();
  const parsedBrush = lower.endsWith(INKB_EXTENSION)
    ? parseInkbFile(buffer, file.name)
    : await parseSutFile(buffer, file.name);

  const existing = (await loadCustomBrushes()).filter(
    (b) => b.name.toLowerCase() === parsedBrush.name.toLowerCase() || b.id === parsedBrush.id
  );
  for (const old of existing) {
    await deleteCustomBrush(old.id).catch(() => {});
  }

  await saveCustomBrush(parsedBrush);
  toolStoreActions.setToolRaw('brush');
  const fullSettings = await prepareBrushSettingsForCsp(parsedBrush);
  toolStoreActions.updateBrushSettings(fullSettings);
  return parsedBrush;
}
