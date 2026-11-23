import { ToolType } from '../types/editor';

export type Tool3DMode =
  | 'smart'
  | 'model-rotate'
  | 'model-rotate-yaw'
  | 'model-rotate-roll'
  | 'model-move'
  | 'model-plane-move'
  | 'model-scale'
  | 'camera-orbit'
  | 'camera-pan'
  | 'camera-zoom';

export type Gizmo3DMode = 'rotate' | 'translate' | 'scale' | 'none';
export type Gizmo3DSpace = 'local' | 'world';
export type Shading3DMode = 'shaded' | 'smooth' | 'toon' | 'wireframe' | 'silhouette';
export type Camera3DPreset = 'front' | 'threeQuarter' | 'side' | 'back' | 'top' | 'lowAngle';

export type Resolved3DPointerAction =
  | 'pass-through-2d'
  | 'gizmo-drag'
  | 'ik-select'
  | 'camera-orbit'
  | 'camera-pan'
  | 'camera-zoom'
  | 'model-rotate'
  | 'model-rotate-yaw'
  | 'model-rotate-roll'
  | 'model-move'
  | 'model-plane-move'
  | 'model-scale';

export interface Pointer3DResolutionInput {
  activeTool: ToolType;
  isSpaceDown: boolean;
  isReferenceVisible: boolean;
  button: number; // 0 = left, 1 = middle, 2 = right
  altKey: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  activeMode: Tool3DMode;
  gizmoMode: Gizmo3DMode;
  isGizmoHit: boolean;
  isIKHandleHit: boolean;
  isModelHit: boolean;
  hasModel: boolean;
}

export interface Wheel3DResolutionInput {
  activeTool: ToolType;
  isSpaceDown: boolean;
  isReferenceVisible: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export interface Behavior3DRuleDoc {
  gesture: string;
  action: string;
}

/**
 * Canonical user-facing behavior rules for the 3D Tool (Clip Studio Paint Advanced 3D style).
 */
export const TOOL_3D_BEHAVIOR_RULES: readonly Behavior3DRuleDoc[] = [
  { gesture: 'Left-Drag Model / Gizmo', action: 'Rotate, Move, or Scale object' },
  { gesture: 'Left-Drag Background', action: 'Orbit 3D camera (Smart mode)' },
  { gesture: 'Right-Drag or Wheel', action: 'Zoom 3D camera in / out' },
  { gesture: 'Middle-Drag', action: 'Pan 3D camera' },
  { gesture: 'Alt + Left-Drag', action: 'Orbit camera from any mode' },
  { gesture: 'Hold Shift', action: 'Snap rotation (15°), scale (10%), or move' },
  { gesture: 'Ctrl+Z / Ctrl+Y', action: 'Undo / Redo any 3D manipulation' },
  { gesture: 'Click Joint Sphere', action: 'Select & pose IK limb directly' },
  { gesture: 'Space + Drag / Ctrl+Wheel', action: 'Pan / zoom the 2D canvas' },
  { gesture: 'Switch to Brush (B)', action: 'Draw directly over live 3D reference' },
];

/**
 * Deterministic pointer-down routing rule table for the 3D viewport.
 *
 * Priority order:
 * 1. If 3D reference is hidden, active tool is not '3d', or Space is held -> pass through to 2D canvas.
 * 2. Active 3D Transform Gizmo handle hit -> 'gizmo-drag' (never moves camera).
 * 3. Middle mouse button -> 'camera-pan'.
 * 4. Right mouse button -> 'camera-zoom'.
 * 5. Alt + Left button -> 'camera-orbit' (quick inspect from any sub-mode).
 * 6. Left button on an IK handle sphere -> 'ik-select'.
 * 7. Left button in 'smart' mode:
 *    - On model -> maps from gizmoMode ('translate' -> model-move, 'scale' -> model-scale, else model-rotate).
 *    - On empty space -> 'camera-orbit'.
 * 8. Left button in an explicit mode -> executes that mode (falling back to camera-orbit if no model is loaded for model-* modes).
 */
export function resolve3DPointerAction(input: Pointer3DResolutionInput): Resolved3DPointerAction {
  if (!input.isReferenceVisible || input.activeTool !== '3d' || input.isSpaceDown) {
    return 'pass-through-2d';
  }

  if (input.button === 0 && input.isGizmoHit && !input.altKey) {
    return 'gizmo-drag';
  }

  if (input.button === 1) {
    return 'camera-pan';
  }

  if (input.button === 2) {
    return 'camera-zoom';
  }

  if (input.button !== 0) {
    return 'pass-through-2d';
  }

  if (input.altKey) {
    return 'camera-orbit';
  }

  if (input.isIKHandleHit) {
    return 'ik-select';
  }

  if (input.activeMode === 'smart') {
    if (input.hasModel && input.isModelHit) {
      if (input.gizmoMode === 'translate') return 'model-move';
      if (input.gizmoMode === 'scale') return 'model-scale';
      return 'model-rotate';
    }
    return 'camera-orbit';
  }

  if (input.activeMode.startsWith('model-') && !input.hasModel) {
    return 'camera-orbit';
  }

  return input.activeMode;
}

/**
 * Deterministic mouse wheel routing for 3D viewport.
 * - Ctrl/Meta + Wheel or Space held or non-3D tool -> 2D canvas zoom.
 * - Unmodified Wheel while 3D tool is active -> 3D camera dolly zoom.
 */
export function resolve3DWheelAction(
  input: Wheel3DResolutionInput
): 'camera-zoom' | 'pass-through-2d' {
  if (
    !input.isReferenceVisible ||
    input.activeTool !== '3d' ||
    input.isSpaceDown ||
    input.ctrlKey ||
    input.metaKey
  ) {
    return 'pass-through-2d';
  }
  return 'camera-zoom';
}

/**
 * Converts a screen-space pointer delta (dx, dy) into the artboard's unrotated, unflipped
 * coordinate frame so dragging right on screen always rotates/moves visually right,
 * even when the 2D canvas is rotated or mirrored.
 */
export function mapScreenDeltaToCanvasDelta(
  dx: number,
  dy: number,
  canvasRotationDeg: number,
  flipX: boolean,
  flipY: boolean
): { dx: number; dy: number } {
  const rad = (-canvasRotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return {
    dx: flipX ? -rx : rx,
    dy: flipY ? -ry : ry,
  };
}

/**
 * Snaps an angle in degrees to the nearest step (default 15°).
 */
export function snapAngleDeg(angleDeg: number, stepDeg = 15): number {
  if (!Number.isFinite(angleDeg) || stepDeg <= 0) return angleDeg;
  return Math.round(angleDeg / stepDeg) * stepDeg;
}

/**
 * Snaps a scale factor to the nearest step (default 0.1 = 10%), clamped to [min, max].
 */
export function snapScaleFactor(scale: number, step = 0.1, min = 0.05, max = 10): number {
  const safe = Number.isFinite(scale) ? scale : 1;
  if (step <= 0) return Math.max(min, Math.min(max, safe));
  const snapped = Math.round(safe / step) * step;
  return Math.max(min, Math.min(max, snapped));
}

/**
 * Snaps a world position coordinate to the nearest grid step (default 0.1).
 */
export function snapPositionCoord(value: number, step = 0.1): number {
  if (!Number.isFinite(value) || step <= 0) return value;
  return Math.round(value / step) * step;
}

/**
 * Shared single-source-of-truth conversion from spherical light angles to a 3D unit vector
 * or world-space position. Used identically by LightSourceWidget and Local3DContainer so the
 * shaded sphere UI always matches the 3D scene lighting.
 */
export function sphericalLightToVector(
  azimuthDeg: number,
  elevationDeg: number,
  isBacklit: boolean,
  distance = 1
): { x: number; y: number; z: number } {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const y = Math.sin(el);
  const hyp = Math.cos(el);
  const x = hyp * Math.sin(az);
  let z = hyp * Math.cos(az);
  if (isBacklit) {
    z = -Math.abs(z);
  }
  const len = Math.hypot(x, y, z) || 1;
  return {
    x: (x / len) * distance,
    y: (y / len) * distance,
    z: (z / len) * distance,
  };
}

export interface KeyLight3DSettings {
  enabled: boolean;
  azimuth: number; // 0..360 deg
  elevation: number; // -85..85 deg
  intensity: number; // 0..3
  color: string;
  isBacklit: boolean;
}

export interface RimLight3DSettings {
  enabled: boolean;
  azimuth: number; // 0..360 deg
  elevation: number; // -85..85 deg
  intensity: number; // 0..3
  color: string;
}

export interface Scene3DLightingSettings {
  keyLight: KeyLight3DSettings;
  rimLight: RimLight3DSettings;
  ambientIntensity: number; // 0..1.5
  ambientColor: string;
  castGroundShadow: boolean;
  shadowOpacity: number; // 0.05..0.85
}

export const DEFAULT_3D_LIGHTING: Scene3DLightingSettings = {
  keyLight: {
    enabled: true,
    azimuth: 40,
    elevation: 45,
    intensity: 1.4,
    color: '#ffffff',
    isBacklit: false,
  },
  rimLight: {
    enabled: true,
    azimuth: 225,
    elevation: 25,
    intensity: 0.55,
    color: '#93c5fd',
  },
  ambientIntensity: 0.55,
  ambientColor: '#ffffff',
  castGroundShadow: true,
  shadowOpacity: 0.32,
};

export interface BonePoseSnapshot {
  q: [number, number, number, number];
  p?: [number, number, number];
}

export interface Scene3DSnapshot {
  modelPosition: [number, number, number];
  modelQuaternion: [number, number, number, number];
  modelScale: [number, number, number];
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
  cameraFov: number;
  perspective: number;
  lighting: Scene3DLightingSettings;
  shadingMode: Shading3DMode;
  materialRoughness: number;
  toonOutline: boolean;
  opacity: number;
  showGrid: boolean;
  bones?: Record<string, BonePoseSnapshot>;
}

function cloneSnapshot(s: Scene3DSnapshot): Scene3DSnapshot {
  const bonesCopy: Record<string, BonePoseSnapshot> | undefined = s.bones
    ? Object.fromEntries(
        Object.entries(s.bones).map(([k, v]) => [
          k,
          {
            q: [...v.q] as [number, number, number, number],
            ...(v.p ? { p: [...v.p] as [number, number, number] } : {}),
          },
        ])
      )
    : undefined;

  return {
    modelPosition: [...s.modelPosition],
    modelQuaternion: [...s.modelQuaternion],
    modelScale: [...s.modelScale],
    cameraPosition: [...s.cameraPosition],
    cameraTarget: [...s.cameraTarget],
    cameraFov: s.cameraFov,
    perspective: s.perspective,
    lighting: {
      keyLight: { ...s.lighting.keyLight },
      rimLight: { ...s.lighting.rimLight },
      ambientIntensity: s.lighting.ambientIntensity,
      ambientColor: s.lighting.ambientColor,
      castGroundShadow: s.lighting.castGroundShadow,
      shadowOpacity: s.lighting.shadowOpacity,
    },
    shadingMode: s.shadingMode,
    materialRoughness: s.materialRoughness,
    toonOutline: s.toonOutline,
    opacity: s.opacity,
    showGrid: s.showGrid,
    ...(bonesCopy ? { bones: bonesCopy } : {}),
  };
}

function approxArrEqual(a: readonly number[], b: readonly number[], eps = 1e-4): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > eps) return false;
  }
  return true;
}

export function areScene3DSnapshotsEqual(a: Scene3DSnapshot, b: Scene3DSnapshot): boolean {
  if (
    !approxArrEqual(a.modelPosition, b.modelPosition) ||
    !approxArrEqual(a.modelQuaternion, b.modelQuaternion) ||
    !approxArrEqual(a.modelScale, b.modelScale) ||
    !approxArrEqual(a.cameraPosition, b.cameraPosition) ||
    !approxArrEqual(a.cameraTarget, b.cameraTarget) ||
    Math.abs(a.cameraFov - b.cameraFov) > 1e-3 ||
    Math.abs(a.perspective - b.perspective) > 1e-3 ||
    a.shadingMode !== b.shadingMode ||
    Math.abs(a.materialRoughness - b.materialRoughness) > 1e-3 ||
    a.toonOutline !== b.toonOutline ||
    Math.abs(a.opacity - b.opacity) > 1e-3 ||
    a.showGrid !== b.showGrid
  ) {
    return false;
  }

  const la = a.lighting;
  const lb = b.lighting;
  if (
    la.keyLight.enabled !== lb.keyLight.enabled ||
    la.keyLight.azimuth !== lb.keyLight.azimuth ||
    la.keyLight.elevation !== lb.keyLight.elevation ||
    Math.abs(la.keyLight.intensity - lb.keyLight.intensity) > 1e-3 ||
    la.keyLight.color.toLowerCase() !== lb.keyLight.color.toLowerCase() ||
    la.keyLight.isBacklit !== lb.keyLight.isBacklit ||
    la.rimLight.enabled !== lb.rimLight.enabled ||
    la.rimLight.azimuth !== lb.rimLight.azimuth ||
    la.rimLight.elevation !== lb.rimLight.elevation ||
    Math.abs(la.rimLight.intensity - lb.rimLight.intensity) > 1e-3 ||
    la.rimLight.color.toLowerCase() !== lb.rimLight.color.toLowerCase() ||
    Math.abs(la.ambientIntensity - lb.ambientIntensity) > 1e-3 ||
    la.ambientColor.toLowerCase() !== lb.ambientColor.toLowerCase() ||
    la.castGroundShadow !== lb.castGroundShadow ||
    Math.abs(la.shadowOpacity - lb.shadowOpacity) > 1e-3
  ) {
    return false;
  }

  const aKeys = a.bones ? Object.keys(a.bones) : [];
  const bKeys = b.bones ? Object.keys(b.bones) : [];
  if (aKeys.length !== bKeys.length) return false;
  if (a.bones && b.bones) {
    for (const key of aKeys) {
      const ba = a.bones[key];
      const bb = b.bones[key];
      if (!bb) return false;
      if (!approxArrEqual(ba.q, bb.q)) return false;
      if (ba.p && bb.p && !approxArrEqual(ba.p, bb.p)) return false;
      if (Boolean(ba.p) !== Boolean(bb.p)) return false;
    }
  }

  return true;
}

/**
 * Bounded linear Undo / Redo snapshot stack for all 3D scene manipulations
 * (transform, camera, lighting, shading, and mannequin IK/pose).
 */
export class Scene3DHistoryStack {
  private entries: Scene3DSnapshot[] = [];
  private index = -1;
  private readonly maxEntries: number;

  constructor(maxEntries = 60) {
    this.maxEntries = Math.max(2, maxEntries);
  }

  reset(initialSnapshot: Scene3DSnapshot): void {
    this.entries = [cloneSnapshot(initialSnapshot)];
    this.index = 0;
  }

  clear(): void {
    this.entries = [];
    this.index = -1;
  }

  push(snapshot: Scene3DSnapshot): boolean {
    if (this.index >= 0 && areScene3DSnapshotsEqual(this.entries[this.index], snapshot)) {
      return false;
    }
    if (this.index < this.entries.length - 1) {
      this.entries = this.entries.slice(0, this.index + 1);
    }
    this.entries.push(cloneSnapshot(snapshot));
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    this.index = this.entries.length - 1;
    return true;
  }

  canUndo(): boolean {
    return this.index > 0;
  }

  canRedo(): boolean {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }

  undo(): Scene3DSnapshot | null {
    if (!this.canUndo()) return null;
    this.index -= 1;
    return cloneSnapshot(this.entries[this.index]);
  }

  redo(): Scene3DSnapshot | null {
    if (!this.canRedo()) return null;
    this.index += 1;
    return cloneSnapshot(this.entries[this.index]);
  }

  get length(): number {
    return this.entries.length;
  }

  get currentIndex(): number {
    return this.index;
  }
}
