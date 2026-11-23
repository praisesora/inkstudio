import {
  ALL_BLEND_MODES,
  AdjustmentLayerData,
  AnimationTimeline,
  BlendMode,
  CanvasDimensions,
  ComicFrame,
  DirtyRect,
  ExpressionColor,
  LayerItem,
  LayerStyles,
  LayerType,
  SpeechBalloon,
  TextLayerData,
  VectorStroke,
} from '../types/editor';
import {
  LayerClearableField,
  LayerMaskDataMessage,
  WireLayerItem,
} from '../types/multiplayer';
import { PerspectiveRuler, StraightRuler, VanishingPoint } from '../types/perspective';
import { AnchorPosition, ResizeCanvasOptions } from '../types/settings';
import { get2DContext } from './canvasUtils';
import { releaseTemporaryCanvas } from './tileEngine';

export const MAX_SYNC_LAYERS = 512;
export const MAX_SYNC_VECTOR_STROKES = 20000;
export const MAX_SYNC_COMIC_FRAMES = 256;
export const MAX_SYNC_CANVAS_DIM = 16384;
export const MAX_SYNC_ANIM_FRAMES = 10000;

const ALLOWED_LAYER_TYPES = new Set<LayerType>([
  'raster',
  'folder',
  'frame-folder',
  'vector',
  'frame',
  'adjustment',
  'text',
  'balloon',
]);

const ALLOWED_BLEND_MODES = new Set<BlendMode>(ALL_BLEND_MODES);

const ALLOWED_DOT_SHAPES = new Set(['circle', 'euclidean', 'line', 'diamond']);
const ALLOWED_EXPRESSION_COLORS = new Set<ExpressionColor>(['color', 'gray', 'monochrome']);
const ALLOWED_ANCHORS = new Set<AnchorPosition>([
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
]);

const CLEARABLE_FIELDS_SET = new Set<LayerClearableField>([
  'alphaLocked',
  'clipped',
  'isReference',
  'isToneLayer',
  'toneEnabled',
  'toneFrequency',
  'toneAngle',
  'toneDotShape',
  'toneDensity',
  'toneDensityType',
  'layerColorEnabled',
  'layerColor',
  'layerSubColor',
  'expressionColor',
  'monoThreshold',
  'monoExpressBlack',
  'monoExpressWhite',
  'maskEnabled',
  'maskLinked',
  'maskVersion',
  'hasMask',
  'adjustmentData',
  'styles',
  'vectorStrokes',
  'comicFrames',
  'textData',
  'balloonData',
  'balloons',
  'ownerPeerId',
  'ownerPeerName',
  'reservedByPeerId',
  'reservedByPeerName',
]);

/** Keys compared when detecting semantic layer mutations (excludes transient UI/DOM fields). */
const SYNCED_LAYER_KEYS: ReadonlyArray<keyof WireLayerItem> = [
  'name',
  'type',
  'visible',
  'opacity',
  'blendMode',
  'locked',
  'alphaLocked',
  'clipped',
  'parentId',
  'isReference',
  'isToneLayer',
  'toneEnabled',
  'toneFrequency',
  'toneAngle',
  'toneDotShape',
  'toneDensity',
  'toneDensityType',
  'layerColorEnabled',
  'layerColor',
  'layerSubColor',
  'expressionColor',
  'monoThreshold',
  'monoExpressBlack',
  'monoExpressWhite',
  'maskEnabled',
  'maskLinked',
  'hasMask',
  'adjustmentData',
  'styles',
  'vectorStrokes',
  'comicFrames',
  'textData',
  'balloonData',
  'balloons',
  'ownerPeerId',
  'ownerPeerName',
  'reservedByPeerId',
  'reservedByPeerName',
];

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function clampFinite(val: unknown, min: number, max: number, fallback: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.max(min, Math.min(max, val));
}

function safeString(val: unknown, maxLen: number, fallback = ''): string {
  if (typeof val !== 'string') return fallback;
  return val.length > maxLen ? val.slice(0, maxLen) : val;
}

/** Strips prototype-pollution keys and enforces max recursion depth. */
function cloneSafeJson<T>(val: unknown, depth = 0): T | undefined {
  if (depth > 12) return undefined;
  if (val === null || typeof val === 'boolean') return val as T;
  if (typeof val === 'number') return (Number.isFinite(val) ? val : 0) as T;
  if (typeof val === 'string') return (val.length > 65536 ? val.slice(0, 65536) : val) as T;
  if (Array.isArray(val)) {
    const out: unknown[] = [];
    for (let i = 0; i < val.length; i++) {
      out.push(cloneSafeJson(val[i], depth + 1));
    }
    return out as T;
  }
  if (typeof val === 'object') {
    const src = val as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      if (FORBIDDEN_KEYS.has(k)) continue;
      const v = cloneSafeJson(src[k], depth + 1);
      if (v !== undefined) out[k] = v;
    }
    return out as T;
  }
  return undefined;
}

export function deepEqualWireValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualWireValue(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);

  let countA = 0;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    if (objA[k] === undefined) continue;
    countA++;
    if (!deepEqualWireValue(objA[k], objB[k])) return false;
  }
  let countB = 0;
  for (let i = 0; i < keysB.length; i++) {
    if (objB[keysB[i]] !== undefined) countB++;
  }
  return countA === countB;
}

/**
 * Strips DOM/UI fields (`maskCanvas`, `thumbnailUrl`, `maskThumbnailUrl`, `collapsed`, `maskVersion`)
 * to produce a clean canonical wire layer object.
 */
export function serializeLayerForWire(layer: LayerItem): WireLayerItem {
  const {
    maskCanvas,
    thumbnailUrl: _thumb,
    maskThumbnailUrl: _mThumb,
    collapsed: _collapsed,
    maskVersion: _mVer,
    ...rest
  } = layer;

  const wire: WireLayerItem = {
    ...rest,
    hasMask: Boolean(maskCanvas || (layer as WireLayerItem).hasMask),
  };

  if (!wire.hasMask) {
    delete wire.hasMask;
  }
  return wire;
}

export function sanitizeWireLayer(raw: unknown): WireLayerItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const id = safeString(src.id, 256).trim();
  if (!id) return null;

  const type: LayerType = ALLOWED_LAYER_TYPES.has(src.type as LayerType)
    ? (src.type as LayerType)
    : 'raster';
  const blendMode: BlendMode = ALLOWED_BLEND_MODES.has(src.blendMode as BlendMode)
    ? (src.blendMode as BlendMode)
    : type === 'folder'
      ? 'pass-through'
      : 'normal';

  const parentId =
    src.parentId === null || src.parentId === undefined
      ? null
      : safeString(src.parentId, 256) || null;

  const base: WireLayerItem = {
    id,
    name: safeString(src.name, 256, 'Layer'),
    type,
    visible: src.visible !== false,
    opacity: clampFinite(src.opacity, 0, 1, 1),
    blendMode,
    locked: Boolean(src.locked),
    parentId: parentId === id ? null : parentId,
  };

  const patch = sanitizeWireLayerPatch(src);
  return { ...base, ...patch, id, type, blendMode, parentId: base.parentId };
}

export function sanitizeWireLayerPatch(raw: unknown): Partial<WireLayerItem> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<WireLayerItem> = {};

  if (typeof src.name === 'string') out.name = safeString(src.name, 256);
  if (ALLOWED_LAYER_TYPES.has(src.type as LayerType)) out.type = src.type as LayerType;
  if (typeof src.visible === 'boolean') out.visible = src.visible;
  if (typeof src.opacity === 'number' && Number.isFinite(src.opacity)) {
    out.opacity = clampFinite(src.opacity, 0, 1, 1);
  }
  if (ALLOWED_BLEND_MODES.has(src.blendMode as BlendMode)) {
    out.blendMode = src.blendMode as BlendMode;
  }
  if (typeof src.locked === 'boolean') out.locked = src.locked;
  if (typeof src.alphaLocked === 'boolean') out.alphaLocked = src.alphaLocked;
  if (typeof src.clipped === 'boolean') out.clipped = src.clipped;
  if (src.parentId === null || typeof src.parentId === 'string') {
    out.parentId = src.parentId === null ? null : safeString(src.parentId, 256) || null;
  }
  if (typeof src.isReference === 'boolean') out.isReference = src.isReference;

  // Screentone
  if (typeof src.isToneLayer === 'boolean') out.isToneLayer = src.isToneLayer;
  if (typeof src.toneEnabled === 'boolean') out.toneEnabled = src.toneEnabled;
  if (typeof src.toneFrequency === 'number' && Number.isFinite(src.toneFrequency)) {
    out.toneFrequency = Math.round(clampFinite(src.toneFrequency, 20, 85, 60));
  }
  if (typeof src.toneAngle === 'number' && Number.isFinite(src.toneAngle)) {
    out.toneAngle = Math.round(clampFinite(src.toneAngle, 0, 90, 45));
  }
  if (typeof src.toneDotShape === 'string' && ALLOWED_DOT_SHAPES.has(src.toneDotShape)) {
    out.toneDotShape = src.toneDotShape as WireLayerItem['toneDotShape'];
  }
  if (typeof src.toneDensity === 'number' && Number.isFinite(src.toneDensity)) {
    out.toneDensity = Math.round(clampFinite(src.toneDensity, 1, 100, 40));
  }
  if (src.toneDensityType === 'specified' || src.toneDensityType === 'image') {
    out.toneDensityType = src.toneDensityType;
  }

  // Layer Color Tint
  if (typeof src.layerColorEnabled === 'boolean') out.layerColorEnabled = src.layerColorEnabled;
  if (typeof src.layerColor === 'string') out.layerColor = safeString(src.layerColor, 64);
  if (typeof src.layerSubColor === 'string') out.layerSubColor = safeString(src.layerSubColor, 64);

  // Expression Color
  if (ALLOWED_EXPRESSION_COLORS.has(src.expressionColor as ExpressionColor)) {
    out.expressionColor = src.expressionColor as ExpressionColor;
  }
  if (typeof src.monoThreshold === 'number' && Number.isFinite(src.monoThreshold)) {
    out.monoThreshold = Math.round(clampFinite(src.monoThreshold, 1, 255, 128));
  }
  if (typeof src.monoExpressBlack === 'boolean') out.monoExpressBlack = src.monoExpressBlack;
  if (typeof src.monoExpressWhite === 'boolean') out.monoExpressWhite = src.monoExpressWhite;

  // Layer Mask flags
  if (typeof src.maskEnabled === 'boolean') out.maskEnabled = src.maskEnabled;
  if (typeof src.maskLinked === 'boolean') out.maskLinked = src.maskLinked;
  if (typeof src.hasMask === 'boolean') out.hasMask = src.hasMask;

  // Structured non-destructive data (prototype-safe deep clone + caps)
  if (src.adjustmentData && typeof src.adjustmentData === 'object') {
    const safeAdj = cloneSafeJson<AdjustmentLayerData>(src.adjustmentData);
    if (
      safeAdj &&
      (safeAdj.type === 'curves' ||
        safeAdj.type === 'gradient-map' ||
        safeAdj.type === 'levels' ||
        safeAdj.type === 'color-balance')
    ) {
      out.adjustmentData = safeAdj;
    }
  }
  if (src.styles && typeof src.styles === 'object') {
    const safeStyles = cloneSafeJson<LayerStyles>(src.styles);
    if (safeStyles) out.styles = safeStyles;
  }
  if (Array.isArray(src.vectorStrokes) && src.vectorStrokes.length <= MAX_SYNC_VECTOR_STROKES) {
    const safeStrokes = cloneSafeJson<VectorStroke[]>(src.vectorStrokes);
    if (safeStrokes) out.vectorStrokes = safeStrokes;
  }
  if (Array.isArray(src.comicFrames) && src.comicFrames.length <= MAX_SYNC_COMIC_FRAMES) {
    const safeFrames = cloneSafeJson<ComicFrame[]>(src.comicFrames);
    if (safeFrames) out.comicFrames = safeFrames;
  }
  if (src.textData && typeof src.textData === 'object') {
    const safeText = cloneSafeJson<TextLayerData>(src.textData);
    if (safeText && typeof safeText.text === 'string') out.textData = safeText;
  }
  if (src.balloonData && typeof src.balloonData === 'object') {
    const safeBalloon = cloneSafeJson<SpeechBalloon>(src.balloonData);
    if (safeBalloon && safeBalloon.bounds) out.balloonData = safeBalloon;
  }
  if (Array.isArray(src.balloons) && src.balloons.length <= 256) {
    const safeBalloons = cloneSafeJson<SpeechBalloon[]>(src.balloons);
    if (safeBalloons) out.balloons = safeBalloons;
  }
  if (typeof src.ownerPeerId === 'string' || typeof src.ownerPeerId === 'number') {
    out.ownerPeerId =
      typeof src.ownerPeerId === 'string' ? safeString(src.ownerPeerId, 128) : src.ownerPeerId;
  }
  if (typeof src.ownerPeerName === 'string') {
    out.ownerPeerName = safeString(src.ownerPeerName, 64);
  }
  if (typeof src.reservedByPeerId === 'string' || typeof src.reservedByPeerId === 'number') {
    out.reservedByPeerId =
      typeof src.reservedByPeerId === 'string'
        ? safeString(src.reservedByPeerId, 128)
        : src.reservedByPeerId;
  }
  if (typeof src.reservedByPeerName === 'string') {
    out.reservedByPeerName = safeString(src.reservedByPeerName, 64);
  }

  return out;
}

export function sanitizeClearedFields(raw: unknown): LayerClearableField[] {
  if (!Array.isArray(raw)) return [];
  const out: LayerClearableField[] = [];
  for (let i = 0; i < raw.length && out.length < 64; i++) {
    const f = raw[i];
    if (typeof f === 'string' && CLEARABLE_FIELDS_SET.has(f as LayerClearableField)) {
      out.push(f as LayerClearableField);
    }
  }
  return out;
}

export function sanitizeWireLayerTree(raw: unknown): WireLayerItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SYNC_LAYERS) return null;
  const out: WireLayerItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item = sanitizeWireLayer(raw[i]);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  if (out.length === 0) return null;

  // Break invalid parent references & cycles
  const byId = new Map(out.map((l) => [l.id, l]));
  for (const layer of out) {
    if (!layer.parentId) continue;
    if (!byId.has(layer.parentId)) {
      layer.parentId = null;
      continue;
    }
    const visited = new Set<string>([layer.id]);
    let curr: WireLayerItem | undefined = byId.get(layer.parentId);
    while (curr) {
      if (visited.has(curr.id)) {
        layer.parentId = null;
        break;
      }
      visited.add(curr.id);
      curr = curr.parentId ? byId.get(curr.parentId) : undefined;
    }
  }
  return out;
}

export function sanitizePerspectiveRuler(raw: unknown): PerspectiveRuler | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.type !== '1-point' && r.type !== '2-point' && r.type !== '3-point') return undefined;
  if (!Array.isArray(r.vps) || r.vps.length === 0 || r.vps.length > 3) return undefined;

  const vps: VanishingPoint[] = [];
  for (let i = 0; i < r.vps.length; i++) {
    const vp = r.vps[i] as Record<string, unknown>;
    if (!vp || typeof vp !== 'object') return undefined;
    if (vp.id !== 'vp1' && vp.id !== 'vp2' && vp.id !== 'vp3') return undefined;
    if (typeof vp.x !== 'number' || !Number.isFinite(vp.x)) return undefined;
    if (typeof vp.y !== 'number' || !Number.isFinite(vp.y)) return undefined;
    vps.push({
      id: vp.id,
      x: clampFinite(vp.x, -1_000_000, 1_000_000, 0),
      y: clampFinite(vp.y, -1_000_000, 1_000_000, 0),
      label: safeString(vp.label, 32, vp.id.toUpperCase()),
      color: safeString(vp.color, 32, '#38bdf8'),
    });
  }

  const gridRaw = (r.grid && typeof r.grid === 'object' ? r.grid : {}) as Record<string, unknown>;
  const plane =
    gridRaw.plane === 'ground' ||
    gridRaw.plane === 'wall-left' ||
    gridRaw.plane === 'wall-right' ||
    gridRaw.plane === 'all'
      ? gridRaw.plane
      : 'ground';

  return {
    id: safeString(r.id, 128, 'perspective-ruler'),
    type: r.type,
    enabled: Boolean(r.enabled),
    locked: Boolean(r.locked),
    snapEnabled: Boolean(r.snapEnabled),
    vps,
    horizonAngle: clampFinite(r.horizonAngle, -360, 360, 0),
    guideRayCount: Math.round(clampFinite(r.guideRayCount, 1, 64, 12)),
    grid: {
      enabled: Boolean(gridRaw.enabled),
      density: Math.round(clampFinite(gridRaw.density, 2, 100, 12)),
      plane,
      opacity: clampFinite(gridRaw.opacity, 0, 1, 0.35),
    },
  };
}

export function sanitizeStraightRuler(raw: unknown): StraightRuler | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.x !== 'number' || !Number.isFinite(r.x)) return undefined;
  if (typeof r.y !== 'number' || !Number.isFinite(r.y)) return undefined;
  return {
    enabled: Boolean(r.enabled),
    x: clampFinite(r.x, -1_000_000, 1_000_000, 0),
    y: clampFinite(r.y, -1_000_000, 1_000_000, 0),
    angle: clampFinite(r.angle, -360, 360, 0),
    locked: Boolean(r.locked),
    snapEnabled: Boolean(r.snapEnabled),
  };
}

export function sanitizeAnimationTimeline(raw: unknown): AnimationTimeline | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const t = raw as Record<string, unknown>;
  const totalFrames = Math.round(clampFinite(t.totalFrames, 1, MAX_SYNC_ANIM_FRAMES, 24));
  const celsRaw = t.cels && typeof t.cels === 'object' ? (t.cels as Record<string, unknown>) : {};
  const cels: Record<number, string> = {};
  let celCount = 0;
  for (const key of Object.keys(celsRaw)) {
    if (celCount >= MAX_SYNC_ANIM_FRAMES) break;
    const frameIdx = Number(key);
    const layerId = celsRaw[key];
    if (
      Number.isInteger(frameIdx) &&
      frameIdx >= 0 &&
      frameIdx < MAX_SYNC_ANIM_FRAMES &&
      typeof layerId === 'string' &&
      layerId.length > 0 &&
      layerId.length <= 256
    ) {
      cels[frameIdx] = layerId;
      celCount++;
    }
  }
  const os = (t.onionSkin && typeof t.onionSkin === 'object'
    ? t.onionSkin
    : {}) as Record<string, unknown>;

  return {
    fps: Math.round(clampFinite(t.fps, 1, 120, 12)),
    totalFrames,
    currentFrame: Math.round(clampFinite(t.currentFrame, 0, totalFrames - 1, 0)),
    cels,
    onionSkin: {
      enabled: Boolean(os.enabled),
      prevFrames: Math.round(clampFinite(os.prevFrames, 0, 10, 1)),
      nextFrames: Math.round(clampFinite(os.nextFrames, 0, 10, 1)),
      prevTint: safeString(os.prevTint, 32, '#ef4444'),
      nextTint: safeString(os.nextTint, 32, '#3b82f6'),
      opacity: clampFinite(os.opacity, 0, 1, 0.3),
    },
    isPlaying: false,
    loop: t.loop !== false,
  };
}

export function sanitizeCanvasResize(
  raw: unknown
): { dimensions: CanvasDimensions; options: ResizeCanvasOptions } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const d = m.dimensions as Record<string, unknown> | undefined;
  const o = m.options as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object') return null;

  if (
    typeof d.width !== 'number' ||
    !Number.isFinite(d.width) ||
    d.width < 1 ||
    d.width > MAX_SYNC_CANVAS_DIM ||
    typeof d.height !== 'number' ||
    !Number.isFinite(d.height) ||
    d.height < 1 ||
    d.height > MAX_SYNC_CANVAS_DIM
  ) {
    return null;
  }
  const width = Math.round(d.width);
  const height = Math.round(d.height);
  const dpi = d.dpi !== undefined ? Math.round(clampFinite(d.dpi, 36, 2400, 300)) : undefined;

  const anchor: AnchorPosition = ALLOWED_ANCHORS.has(o?.anchor as AnchorPosition)
    ? (o!.anchor as AnchorPosition)
    : 'center';

  return {
    dimensions: { width, height, dpi },
    options: {
      width,
      height,
      dpi,
      scaleContent: Boolean(o?.scaleContent),
      anchor,
      backgroundColor: safeString(o?.backgroundColor, 64, '#ffffff'),
    },
  };
}

// --- Deterministic Layer Tree Diff ---

export type LayerTreeDiff =
  | { kind: 'none' }
  | {
      kind: 'single-update';
      layerId: string;
      patch: Partial<WireLayerItem>;
      clearedFields: LayerClearableField[];
      maskCreated: boolean;
      maskRemoved: boolean;
      rasterized: boolean;
    }
  | {
      kind: 'tree-sync';
      layers: WireLayerItem[];
      addedLayerIds: string[];
      removedLayerIds: string[];
      maskCreatedIds: string[];
      maskRemovedIds: string[];
    };

export function diffWireLayerTrees(
  prev: WireLayerItem[],
  next: WireLayerItem[]
): LayerTreeDiff {
  const sameOrderAndIds =
    prev.length === next.length && prev.every((l, i) => l.id === next[i].id);

  if (sameOrderAndIds) {
    let changedIdx = -1;
    let changedCount = 0;

    for (let i = 0; i < prev.length; i++) {
      const a = prev[i];
      const b = next[i];
      let layerChanged = false;
      for (let k = 0; k < SYNCED_LAYER_KEYS.length; k++) {
        const key = SYNCED_LAYER_KEYS[k];
        if (!deepEqualWireValue(a[key], b[key])) {
          layerChanged = true;
          break;
        }
      }
      if (layerChanged) {
        changedIdx = i;
        changedCount++;
        if (changedCount > 1) break;
      }
    }

    if (changedCount === 0) return { kind: 'none' };

    if (changedCount === 1) {
      const a = prev[changedIdx];
      const b = next[changedIdx];
      const patch: Partial<WireLayerItem> = {};
      const clearedFields: LayerClearableField[] = [];

      for (let k = 0; k < SYNCED_LAYER_KEYS.length; k++) {
        const key = SYNCED_LAYER_KEYS[k];
        if (!deepEqualWireValue(a[key], b[key])) {
          if (b[key] === undefined) {
            if (CLEARABLE_FIELDS_SET.has(key as LayerClearableField)) {
              clearedFields.push(key as LayerClearableField);
            }
          } else {
            (patch as Record<string, unknown>)[key] = b[key];
          }
        }
      }

      const maskCreated = !a.hasMask && Boolean(b.hasMask);
      const maskRemoved = Boolean(a.hasMask) && !b.hasMask;
      const rasterized =
        b.type === 'raster' && (a.type === 'text' || a.type === 'balloon' || a.type === 'vector');

      return {
        kind: 'single-update',
        layerId: b.id,
        patch,
        clearedFields,
        maskCreated,
        maskRemoved,
        rasterized,
      };
    }
  }

  // Structural change (add, delete, reorder, group, duplicate, merge, batch edit)
  const prevById = new Map(prev.map((l) => [l.id, l]));
  const nextById = new Map(next.map((l) => [l.id, l]));

  const addedLayerIds: string[] = [];
  const removedLayerIds: string[] = [];
  const maskCreatedIds: string[] = [];
  const maskRemovedIds: string[] = [];

  for (const l of next) {
    const old = prevById.get(l.id);
    if (!old) {
      addedLayerIds.push(l.id);
      if (l.hasMask) maskCreatedIds.push(l.id);
    } else {
      if (!old.hasMask && l.hasMask) maskCreatedIds.push(l.id);
      if (old.hasMask && !l.hasMask) maskRemovedIds.push(l.id);
    }
  }
  for (const l of prev) {
    if (!nextById.has(l.id)) {
      removedLayerIds.push(l.id);
    }
  }

  return {
    kind: 'tree-sync',
    layers: next,
    addedLayerIds,
    removedLayerIds,
    maskCreatedIds,
    maskRemovedIds,
  };
}

// --- Mask Grayscale Extraction & Application ---

export interface ExtractedMaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8Array;
  solidValue: number | null;
}

export function extractMaskGrayscaleRect(
  maskCanvas: HTMLCanvasElement,
  rect?: DirtyRect
): ExtractedMaskRect | null {
  const cw = maskCanvas.width;
  const ch = maskCanvas.height;
  if (cw <= 0 || ch <= 0) return null;

  const x = rect ? Math.max(0, Math.min(cw - 1, Math.floor(rect.x))) : 0;
  const y = rect ? Math.max(0, Math.min(ch - 1, Math.floor(rect.y))) : 0;
  const x2 = rect ? Math.max(x + 1, Math.min(cw, Math.ceil(rect.x + rect.width))) : cw;
  const y2 = rect ? Math.max(y + 1, Math.min(ch, Math.ceil(rect.y + rect.height))) : ch;
  const width = x2 - x;
  const height = y2 - y;
  if (width <= 0 || height <= 0) return null;

  const ctx = get2DContext(maskCanvas);
  if (!ctx) return null;

  const rgba = ctx.getImageData(x, y, width, height).data;
  const count = width * height;
  const pixels = new Uint8Array(count);

  let firstVal = -1;
  let isSolid = true;

  for (let i = 0; i < count; i++) {
    const off = i << 2;
    const a = rgba[off + 3];
    const v =
      a === 255
        ? Math.round(0.299 * rgba[off] + 0.587 * rgba[off + 1] + 0.114 * rgba[off + 2])
        : Math.round(
            (0.299 * rgba[off] + 0.587 * rgba[off + 1] + 0.114 * rgba[off + 2]) * (a / 255)
          );
    pixels[i] = v;
    if (firstVal === -1) {
      firstVal = v;
    } else if (isSolid && v !== firstVal) {
      isSolid = false;
    }
  }

  return {
    x,
    y,
    width,
    height,
    pixels,
    solidValue: isSolid && firstVal >= 0 ? firstVal : null,
  };
}

export function createWhiteMaskCanvas(width: number, height: number): HTMLCanvasElement | undefined {
  if (typeof document === 'undefined' || width <= 0 || height <= 0) return undefined;
  const mask = document.createElement('canvas');
  mask.width = width;
  mask.height = height;
  const mCtx = get2DContext(mask);
  if (mCtx) {
    mCtx.fillStyle = '#ffffff';
    mCtx.fillRect(0, 0, width, height);
  }
  return mask;
}

export function applyMaskDataToCanvas(
  existingCanvas: HTMLCanvasElement | undefined,
  dims: CanvasDimensions,
  msg: LayerMaskDataMessage
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const targetW = Math.max(dims.width, msg.isFullReplace ? msg.width : 0);
  const targetH = Math.max(dims.height, msg.isFullReplace ? msg.height : 0);
  if (targetW <= 0 || targetH <= 0) return null;

  let canvas = existingCanvas;
  if (!canvas || canvas.width !== targetW || canvas.height !== targetH) {
    if (canvas) releaseTemporaryCanvas(canvas);
    canvas = createWhiteMaskCanvas(targetW, targetH);
    if (!canvas) return null;
  }

  const ctx = get2DContext(canvas);
  if (!ctx) return null;

  const rx = Math.max(0, Math.min(targetW, msg.x));
  const ry = Math.max(0, Math.min(targetH, msg.y));
  const rw = Math.max(0, Math.min(targetW - rx, msg.width));
  const rh = Math.max(0, Math.min(targetH - ry, msg.height));
  if (rw <= 0 || rh <= 0) return canvas;

  if (msg.solidFill !== undefined) {
    const v = Math.max(0, Math.min(255, Math.round(msg.solidFill)));
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(rx, ry, rw, rh);
    return canvas;
  }

  if (!msg.data || msg.data.byteLength < msg.width * msg.height) return canvas;

  const imgData = ctx.createImageData(rw, rh);
  const dst = imgData.data;
  const src = msg.data;
  const srcStride = msg.width;

  for (let py = 0; py < rh; py++) {
    const srcRow = py * srcStride;
    const dstRow = py * rw;
    for (let px = 0; px < rw; px++) {
      const v = src[srcRow + px];
      const off = (dstRow + px) << 2;
      dst[off] = v;
      dst[off + 1] = v;
      dst[off + 2] = v;
      dst[off + 3] = 255;
    }
  }
  ctx.putImageData(imgData, rx, ry);
  return canvas;
}

// --- Remote Layer Merge Helpers ---

export function mergeRemoteWireLayerIntoLocal(
  local: LayerItem | undefined,
  wire: WireLayerItem,
  dims: CanvasDimensions
): LayerItem {
  const { hasMask, ...wireRest } = wire;
  let maskCanvas = local?.maskCanvas;
  let maskThumbnailUrl = local?.maskThumbnailUrl;
  let maskVersion = local?.maskVersion;

  if (hasMask) {
    if (!maskCanvas) {
      maskCanvas = createWhiteMaskCanvas(dims.width, dims.height);
      maskVersion = 1;
    }
  } else if (maskCanvas) {
    releaseTemporaryCanvas(maskCanvas);
    maskCanvas = undefined;
    maskThumbnailUrl = undefined;
    maskVersion = undefined;
  }

  return {
    ...wireRest,
    collapsed: local?.collapsed ?? false,
    thumbnailUrl: local?.thumbnailUrl ?? '',
    maskCanvas,
    maskThumbnailUrl,
    maskVersion,
    maskEnabled: hasMask ? wire.maskEnabled ?? true : undefined,
    maskLinked: hasMask ? wire.maskLinked ?? true : undefined,
  };
}

export function applyRemoteLayerPatch(
  local: LayerItem,
  patch: Partial<WireLayerItem>,
  clearedFields?: LayerClearableField[],
  dims?: CanvasDimensions
): LayerItem {
  const { hasMask, ...patchRest } = patch;
  const next: LayerItem = {
    ...local,
    ...patchRest,
  };

  if (clearedFields && clearedFields.length > 0) {
    for (const field of clearedFields) {
      if (field === 'hasMask') continue;
      delete (next as unknown as Record<string, unknown>)[field];
    }
  }

  const maskRemoved =
    hasMask === false || (clearedFields !== undefined && clearedFields.includes('hasMask'));
  if (maskRemoved) {
    if (local.maskCanvas) {
      releaseTemporaryCanvas(local.maskCanvas);
    }
    next.maskCanvas = undefined;
    next.maskThumbnailUrl = undefined;
    next.maskVersion = undefined;
    next.maskEnabled = undefined;
    next.maskLinked = undefined;
  } else if (hasMask === true && !local.maskCanvas && dims && dims.width > 0 && dims.height > 0) {
    next.maskCanvas = createWhiteMaskCanvas(dims.width, dims.height);
    next.maskVersion = 1;
    next.maskEnabled = next.maskEnabled ?? true;
    next.maskLinked = next.maskLinked ?? true;
  }

  return next;
}
