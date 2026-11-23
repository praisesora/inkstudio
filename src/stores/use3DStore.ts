import { createStore } from './createStore';
import {
  Camera3DPreset,
  DEFAULT_3D_LIGHTING,
  Gizmo3DMode,
  Gizmo3DSpace,
  Scene3DLightingSettings,
  Shading3DMode,
  Tool3DMode,
} from '../utils/tool3DRules';
import { PosePresetName } from '../utils/mannequin3D';
import { LTConversionSettings } from '../types/editor';

export interface Model3DTransformState {
  position: [number, number, number];
  rotation: [number, number, number]; // degrees
  scale: [number, number, number]; // multiplier (1 = 100%)
  uniformScale: boolean;
}

export const INITIAL_MODEL_3D_TRANSFORM: Model3DTransformState = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  uniformScale: true,
};

export interface Scene3DStoreState {
  activeMode: Tool3DMode;
  gizmoMode: Gizmo3DMode;
  gizmoSpace: Gizmo3DSpace;
  snapEnabled: boolean;
  isReferenceVisible: boolean;
  loadedModelName: string | null;
  modelKind: 'none' | 'imported';
  isMannequinActive: boolean;
  activeIKHandle: string | null;
  showIKHandles: boolean;
  isBaking: boolean;
  canUndo3D: boolean;
  canRedo3D: boolean;
  modelTransform: Model3DTransformState;
  lighting: Scene3DLightingSettings;
  shadingMode: Shading3DMode;
  materialRoughness: number; // 0.1..1.0
  toonOutline: boolean;
  opacity: number; // 0.1..1.0
  showGrid: boolean;
  perspective: number; // 0.3..2.5 dolly zoom factor
  fov: number; // 18..95 deg
  syncCameraPerspective: boolean;
  previousToolBefore3D: string | null;
}

const cloneDefaultLighting = (): Scene3DLightingSettings => ({
  keyLight: { ...DEFAULT_3D_LIGHTING.keyLight },
  rimLight: { ...DEFAULT_3D_LIGHTING.rimLight },
  ambientIntensity: DEFAULT_3D_LIGHTING.ambientIntensity,
  ambientColor: DEFAULT_3D_LIGHTING.ambientColor,
  castGroundShadow: DEFAULT_3D_LIGHTING.castGroundShadow,
  shadowOpacity: DEFAULT_3D_LIGHTING.shadowOpacity,
});

const createInitial3DState = (): Scene3DStoreState => ({
  activeMode: 'smart',
  gizmoMode: 'rotate',
  gizmoSpace: 'local',
  snapEnabled: false,
  isReferenceVisible: true,
  loadedModelName: null,
  modelKind: 'none',
  isMannequinActive: false,
  activeIKHandle: null,
  showIKHandles: true,
  isBaking: false,
  canUndo3D: false,
  canRedo3D: false,
  modelTransform: {
    position: [...INITIAL_MODEL_3D_TRANSFORM.position],
    rotation: [...INITIAL_MODEL_3D_TRANSFORM.rotation],
    scale: [...INITIAL_MODEL_3D_TRANSFORM.scale],
    uniformScale: true,
  },
  lighting: cloneDefaultLighting(),
  shadingMode: 'shaded',
  materialRoughness: 0.4,
  toonOutline: false,
  opacity: 0.92,
  showGrid: true,
  perspective: 1.0,
  fov: 45,
  syncCameraPerspective: false,
  previousToolBefore3D: null,
});

export const use3DStore = createStore<Scene3DStoreState>(createInitial3DState);

export const store3DActions = {
  setActiveMode(activeMode: Tool3DMode): void {
    use3DStore.setState({ activeMode });
  },

  setGizmoMode(gizmoMode: Gizmo3DMode): void {
    use3DStore.setState({ gizmoMode });
  },

  setGizmoSpace(gizmoSpace: Gizmo3DSpace): void {
    use3DStore.setState({ gizmoSpace });
  },

  setSnapEnabled(snapEnabled: boolean): void {
    use3DStore.setState({ snapEnabled });
  },

  setReferenceVisible(isReferenceVisible: boolean): void {
    use3DStore.setState({ isReferenceVisible });
  },

  toggleReferenceVisible(): void {
    use3DStore.setState((prev) => ({ isReferenceVisible: !prev.isReferenceVisible }));
  },

  setLoadedModel(
    loadedModelName: string | null,
    modelKind: 'none' | 'imported',
    isMannequinActive: boolean
  ): void {
    use3DStore.setState({
      loadedModelName,
      modelKind,
      isMannequinActive,
      activeIKHandle: null,
    });
  },

  setActiveIKHandle(activeIKHandle: string | null): void {
    use3DStore.setState({ activeIKHandle });
  },

  setShowIKHandles(showIKHandles: boolean): void {
    use3DStore.setState({ showIKHandles });
  },

  setIsBaking(isBaking: boolean): void {
    use3DStore.setState({ isBaking });
  },

  setHistoryFlags(canUndo3D: boolean, canRedo3D: boolean): void {
    use3DStore.setState({ canUndo3D, canRedo3D });
  },

  setModelTransform(patch: Partial<Model3DTransformState>): void {
    use3DStore.setState((prev) => ({
      modelTransform: { ...prev.modelTransform, ...patch },
    }));
  },

  updateLighting(patch: Partial<Scene3DLightingSettings>): void {
    use3DStore.setState((prev) => ({
      lighting: { ...prev.lighting, ...patch },
    }));
  },

  updateKeyLight(patch: Partial<Scene3DLightingSettings['keyLight']>): void {
    use3DStore.setState((prev) => ({
      lighting: {
        ...prev.lighting,
        keyLight: { ...prev.lighting.keyLight, ...patch },
      },
    }));
  },

  updateRimLight(patch: Partial<Scene3DLightingSettings['rimLight']>): void {
    use3DStore.setState((prev) => ({
      lighting: {
        ...prev.lighting,
        rimLight: { ...prev.lighting.rimLight, ...patch },
      },
    }));
  },

  resetLighting(): void {
    use3DStore.setState({ lighting: cloneDefaultLighting() });
  },

  setShadingMode(shadingMode: Shading3DMode): void {
    use3DStore.setState({ shadingMode });
  },

  setMaterialRoughness(materialRoughness: number): void {
    use3DStore.setState({ materialRoughness: Math.max(0.08, Math.min(1.0, materialRoughness)) });
  },

  setToonOutline(toonOutline: boolean): void {
    use3DStore.setState({ toonOutline });
  },

  setOpacity(opacity: number): void {
    use3DStore.setState({ opacity: Math.max(0.1, Math.min(1.0, opacity)) });
  },

  setShowGrid(showGrid: boolean): void {
    use3DStore.setState({ showGrid });
  },

  setPerspective(perspective: number, fov?: number): void {
    use3DStore.setState((prev) => ({
      perspective,
      fov: fov ?? prev.fov,
    }));
  },

  setFov(fov: number): void {
    use3DStore.setState({ fov: Math.max(15, Math.min(105, fov)) });
  },

  setSyncCameraPerspective(syncCameraPerspective: boolean): void {
    use3DStore.setState({ syncCameraPerspective });
  },

  setPreviousToolBefore3D(previousToolBefore3D: string | null): void {
    use3DStore.setState({ previousToolBefore3D });
  },

  resetSceneMeta(): void {
    use3DStore.setState({
      loadedModelName: null,
      modelKind: 'none',
      isMannequinActive: false,
      activeIKHandle: null,
      isBaking: false,
      canUndo3D: false,
      canRedo3D: false,
      isReferenceVisible: true,
      modelTransform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        uniformScale: true,
      },
    });
  },
};

export interface Scene3DCommandBridge {
  triggerFilePicker?: () => void;
  loadFile?: (file: File) => void;
  applyNumericTransform?: (next: Model3DTransformState) => void;
  applyTransformDelta?: (mode: Tool3DMode, dx: number, dy: number, snap?: boolean) => void;
  rotateModelYaw?: (degrees: number) => void;
  snapToGround?: () => void;
  resetModelTransform?: () => void;
  resetCamera?: () => void;
  setCameraPreset?: (preset: Camera3DPreset) => void;
  applyPerspectiveDollyZoom?: (factor: number) => void;
  applyPosePreset?: (preset: PosePresetName) => void;
  selectIKTarget?: (targetName: string | null) => void;
  syncPerspectiveRulerNow?: () => void;
  bakeTo2D?: (closeAfter?: boolean) => Promise<void>;
  extractLineAndTone?: (settings?: LTConversionSettings) => Promise<void>;
  commitHistoryNow?: () => void;
  undo?: () => boolean;
  redo?: () => boolean;
  canUndo?: () => boolean;
  canRedo?: () => boolean;
}

export const scene3DBridge: Scene3DCommandBridge = {};
