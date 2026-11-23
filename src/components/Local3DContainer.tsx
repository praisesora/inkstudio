import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LayerItem, LTConversionSettings, ToolType } from '../types/editor';
import { PerspectiveRuler } from '../types/perspective';
import { CanvasNavigationHandle } from '../hooks/useCanvasNavigation';
import { screenToCanvas } from '../utils/canvasUtils';
import { calculatePerspectiveFromCamera } from '../utils/perspectiveMath';
import {
  bake3DToRasterLayer,
  bake3DToLineAndTone,
  createSafeWebGLRenderer,
  disposeThreeResources,
} from '../services/bake3DService';
import { performanceManager } from '../utils/performanceManager';
import {
  findHumanoidBones,
  solveTwoBoneIK,
  createIKHandles,
  syncIKHandlesToBones,
  applyPosePreset,
  HumanoidBones,
  PosePresetName,
} from '../utils/mannequin3D';
import {
  BonePoseSnapshot,
  Camera3DPreset,
  mapScreenDeltaToCanvasDelta,
  resolve3DPointerAction,
  resolve3DWheelAction,
  Resolved3DPointerAction,
  Scene3DHistoryStack,
  Scene3DSnapshot,
  Shading3DMode,
  snapAngleDeg,
  snapPositionCoord,
  snapScaleFactor,
  sphericalLightToVector,
  Tool3DMode,
} from '../utils/tool3DRules';
import {
  Model3DTransformState,
  scene3DBridge,
  store3DActions,
  toolStoreActions,
  use3DStore,
} from '../stores';
import { Csp3DToolbar } from './Csp3DToolbar';
import { LTExtractionModal, LTPreviewBuffers } from './LTExtractionModal';
import { Upload, Box } from 'lucide-react';

export type ShadingMode = Shading3DMode;
export type GizmoMode = 'none' | 'rotate' | 'translate' | 'scale';

export interface Local3DContainerProps {
  dimensions: { width: number; height: number; dpi?: number };
  viewportRef?: React.RefObject<HTMLDivElement | null>;
  navigation?: CanvasNavigationHandle;
  zoom?: number;
  pan?: { x: number; y: number };
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  activeTool?: ToolType;
  isSpaceDown?: boolean;
  isOpen: boolean;
  initialFile?: File | null;
  onClose: () => void;
  onInsertRasterLayer: (layer: LayerItem, canvas: HTMLCanvasElement) => void;
  onBakeSuccess?: (layer: LayerItem) => void;
  perspectiveRuler?: PerspectiveRuler | null;
  onUpdatePerspectiveRuler?: (ruler: PerspectiveRuler | null) => void;
}

const DEFAULT_CAMERA_POS = new THREE.Vector3(0, 1.35, 3.8);
const DEFAULT_CAMERA_TARGET = new THREE.Vector3(0, 0.85, 0);

function createToonGradientTexture(): THREE.DataTexture {
  // 3-step crisp manga cel shading ramp
  const colors = new Uint8Array([
    85, 85, 95, 255,
    175, 175, 182, 255,
    248, 248, 250, 255,
  ]);
  const tex = new THREE.DataTexture(colors, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export const Local3DContainer: React.FC<Local3DContainerProps> = ({
  dimensions,
  viewportRef,
  navigation,
  zoom = 1,
  pan = { x: 0, y: 0 },
  rotation = 0,
  flipX = false,
  flipY = false,
  activeTool = '3d',
  isSpaceDown = false,
  isOpen,
  initialFile,
  onClose,
  onInsertRasterLayer,
  onBakeSuccess,
  perspectiveRuler,
  onUpdatePerspectiveRuler,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadedFileKeyRef = useRef<string | null>(null);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [sceneReadyVersion, setSceneReadyVersion] = useState<number>(0);
  const [isLTModalOpen, setIsLTModalOpen] = useState<boolean>(false);

  // Store-backed reactive 3D state
  const activeMode = use3DStore((s) => s.activeMode);
  const gizmoMode = use3DStore((s) => s.gizmoMode);
  const gizmoSpace = use3DStore((s) => s.gizmoSpace);
  const snapEnabled = use3DStore((s) => s.snapEnabled);
  const isReferenceVisible = use3DStore((s) => s.isReferenceVisible);
  const loadedModelName = use3DStore((s) => s.loadedModelName);
  const isBaking = use3DStore((s) => s.isBaking);
  const showIKHandles = use3DStore((s) => s.showIKHandles);
  const lighting = use3DStore((s) => s.lighting);
  const shadingMode = use3DStore((s) => s.shadingMode);
  const materialRoughness = use3DStore((s) => s.materialRoughness);
  const toonOutline = use3DStore((s) => s.toonOutline);
  const opacity = use3DStore((s) => s.opacity);
  const showGrid = use3DStore((s) => s.showGrid);
  const syncCameraPerspective = use3DStore((s) => s.syncCameraPerspective);

  // Live refs for zero-stale closures inside native listeners and rAF loops
  const activeToolRef = useRef<ToolType>(activeTool);
  activeToolRef.current = activeTool;
  const isSpaceDownRef = useRef<boolean>(isSpaceDown);
  isSpaceDownRef.current = isSpaceDown;
  const viewportMetaRef = useRef({ zoom, pan, rotation, flipX, flipY, dimensions });
  viewportMetaRef.current = { zoom, pan, rotation, flipX, flipY, dimensions };
  const onUpdatePerspectiveRulerRef = useRef(onUpdatePerspectiveRuler);
  onUpdatePerspectiveRulerRef.current = onUpdatePerspectiveRuler;
  const perspectiveRulerRef = useRef(perspectiveRuler);
  perspectiveRulerRef.current = perspectiveRuler;

  // Three.js scene references
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const cameraTargetRef = useRef<THREE.Vector3>(DEFAULT_CAMERA_TARGET.clone());
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const transformControlsRef = useRef<TransformControls | null>(null);
  const transformHelperRef = useRef<THREE.Object3D | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const modelRootRef = useRef<THREE.Group | null>(null);
  const keyLightRef = useRef<THREE.DirectionalLight | null>(null);
  const rimLightRef = useRef<THREE.DirectionalLight | null>(null);
  const ambientLightRef = useRef<THREE.AmbientLight | null>(null);
  const hemiLightRef = useRef<THREE.HemisphereLight | null>(null);
  const gridHelperRef = useRef<THREE.GridHelper | null>(null);
  const shadowPlaneRef = useRef<THREE.Mesh | null>(null);
  const toonGradientTexRef = useRef<THREE.DataTexture | null>(null);
  const mannequinBonesRef = useRef<HumanoidBones | null>(null);
  const ikHandlesRef = useRef<Record<string, THREE.Mesh> | null>(null);
  const ikHandlesContainerRef = useRef<THREE.Group | null>(null);
  const raycasterRef = useRef<THREE.Raycaster>(new THREE.Raycaster());
  const transformSyncRafRef = useRef<number | null>(null);
  const perspectiveSyncRafRef = useRef<number | null>(null);
  const gizmoSuppressedRef = useRef<boolean>(false);
  const historyStackRef = useRef<Scene3DHistoryStack>(new Scene3DHistoryStack(60));
  const historyDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRestoringHistoryRef = useRef<boolean>(false);

  // Active canvas drag state
  const canvasDragRef = useRef<{
    action: Resolved3DPointerAction;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    accumYawDeg: number;
    accumPitchDeg: number;
    accumRollDeg: number;
    startQuat: THREE.Quaternion | null;
    startScale: THREE.Vector3 | null;
    startPos: THREE.Vector3 | null;
    totalDx: number;
    totalDy: number;
  } | null>(null);

  const is3DToolActive = activeTool === '3d';
  const isInteractive = is3DToolActive && isReferenceVisible && !isSpaceDown;

  // Accurate clientX/clientY -> Three.js NDC [-1, 1] accounting for 2D canvas zoom, pan, rotation, flipX, flipY
  const clientToNDC = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const vp = viewportRef?.current;
      const meta = viewportMetaRef.current;
      if (vp) {
        const vpRect = vp.getBoundingClientRect();
        const cam = navigation
          ? navigation.getCameraState()
          : {
              pan: meta.pan,
              zoom: meta.zoom,
              rotation: meta.rotation,
              flipX: meta.flipX,
              flipY: meta.flipY,
            };
        const pt = screenToCanvas(
          clientX,
          clientY,
          vpRect,
          cam.pan,
          cam.zoom,
          cam.rotation,
          meta.dimensions,
          cam.flipX,
          cam.flipY
        );
        return {
          x: (pt.x / Math.max(1, meta.dimensions.width)) * 2 - 1,
          y: -(pt.y / Math.max(1, meta.dimensions.height)) * 2 + 1,
        };
      }
      const canvas = canvasRef.current;
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        return {
          x: ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
          y: -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
        };
      }
      return { x: 0, y: 0 };
    },
    [navigation, viewportRef]
  );

  // Sync live modelRoot transform back into use3DStore (rAF throttled)
  const scheduleTransformSyncToStore = useCallback(() => {
    if (transformSyncRafRef.current !== null) return;
    transformSyncRafRef.current = requestAnimationFrame(() => {
      transformSyncRafRef.current = null;
      const model = modelRootRef.current;
      if (!model) return;
      const euler = new THREE.Euler().setFromQuaternion(model.quaternion, 'YXZ');
      store3DActions.setModelTransform({
        position: [round2(model.position.x), round2(model.position.y), round2(model.position.z)],
        rotation: [
          round1(THREE.MathUtils.radToDeg(euler.x)),
          round1(THREE.MathUtils.radToDeg(euler.y)),
          round1(THREE.MathUtils.radToDeg(euler.z)),
        ],
        scale: [round2(model.scale.x), round2(model.scale.y), round2(model.scale.z)],
      });
    });
  }, []);

  // Optional throttled perspective ruler sync when explicitly enabled
  const schedulePerspectiveRulerSync = useCallback((force = false) => {
    const shouldSync = force || use3DStore.getState().syncCameraPerspective;
    if (!shouldSync || !onUpdatePerspectiveRulerRef.current || !cameraRef.current) return;
    if (perspectiveSyncRafRef.current !== null) return;
    perspectiveSyncRafRef.current = requestAnimationFrame(() => {
      perspectiveSyncRafRef.current = null;
      if (!cameraRef.current || !onUpdatePerspectiveRulerRef.current) return;
      cameraRef.current.updateMatrixWorld(true);
      const dims = viewportMetaRef.current.dimensions;
      const ruler = calculatePerspectiveFromCamera(
        cameraRef.current,
        dims.width,
        dims.height,
        perspectiveRulerRef.current
      );
      onUpdatePerspectiveRulerRef.current(ruler);
    });
  }, []);

  // --- 3D Undo / Redo Snapshot Helpers (Ctrl+Z / Ctrl+Y) ---
  const syncHistoryFlagsToStore = useCallback(() => {
    const stack = historyStackRef.current;
    store3DActions.setHistoryFlags(stack.canUndo(), stack.canRedo());
  }, []);

  const captureSceneSnapshot = useCallback((): Scene3DSnapshot | null => {
    const camera = cameraRef.current;
    if (!camera) return null;
    const model = modelRootRef.current;
    const target = cameraTargetRef.current;
    const s = use3DStore.getState();

    let bonesSnap: Record<string, BonePoseSnapshot> | undefined;
    if (mannequinBonesRef.current) {
      bonesSnap = {};
      for (const [key, bone] of Object.entries(mannequinBonesRef.current)) {
        if (!bone) continue;
        bonesSnap[key] = {
          q: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
          ...(key === 'hips'
            ? { p: [bone.position.x, bone.position.y, bone.position.z] as [number, number, number] }
            : {}),
        };
      }
    }

    return {
      modelPosition: model ? [model.position.x, model.position.y, model.position.z] : [0, 0, 0],
      modelQuaternion: model
        ? [model.quaternion.x, model.quaternion.y, model.quaternion.z, model.quaternion.w]
        : [0, 0, 0, 1],
      modelScale: model ? [model.scale.x, model.scale.y, model.scale.z] : [1, 1, 1],
      cameraPosition: [camera.position.x, camera.position.y, camera.position.z],
      cameraTarget: [target.x, target.y, target.z],
      cameraFov: camera.fov,
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
      ...(bonesSnap ? { bones: bonesSnap } : {}),
    };
  }, []);

  const commitHistoryNow = useCallback(() => {
    if (isRestoringHistoryRef.current) return;
    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current);
      historyDebounceTimerRef.current = null;
    }
    const snap = captureSceneSnapshot();
    if (!snap) return;
    if (historyStackRef.current.length === 0) {
      historyStackRef.current.reset(snap);
    } else {
      historyStackRef.current.push(snap);
    }
    syncHistoryFlagsToStore();
  }, [captureSceneSnapshot, syncHistoryFlagsToStore]);

  const scheduleDebouncedHistoryCommit = useCallback(() => {
    if (isRestoringHistoryRef.current || historyStackRef.current.length === 0) return;
    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current);
    }
    historyDebounceTimerRef.current = setTimeout(() => {
      historyDebounceTimerRef.current = null;
      commitHistoryNow();
    }, 260);
  }, [commitHistoryNow]);

  const restoreSceneSnapshot = useCallback(
    (snap: Scene3DSnapshot) => {
      isRestoringHistoryRef.current = true;
      try {
        if (modelRootRef.current) {
          modelRootRef.current.position.set(...snap.modelPosition);
          modelRootRef.current.quaternion.set(...snap.modelQuaternion).normalize();
          modelRootRef.current.scale.set(...snap.modelScale);
          modelRootRef.current.updateMatrixWorld(true);
          const euler = new THREE.Euler().setFromQuaternion(modelRootRef.current.quaternion, 'YXZ');
          store3DActions.setModelTransform({
            position: [
              round2(snap.modelPosition[0]),
              round2(snap.modelPosition[1]),
              round2(snap.modelPosition[2]),
            ],
            rotation: [
              round1(THREE.MathUtils.radToDeg(euler.x)),
              round1(THREE.MathUtils.radToDeg(euler.y)),
              round1(THREE.MathUtils.radToDeg(euler.z)),
            ],
            scale: [
              round2(snap.modelScale[0]),
              round2(snap.modelScale[1]),
              round2(snap.modelScale[2]),
            ],
          });
        }

        if (cameraRef.current) {
          cameraTargetRef.current.set(...snap.cameraTarget);
          cameraRef.current.position.set(...snap.cameraPosition);
          cameraRef.current.fov = snap.cameraFov;
          cameraRef.current.updateProjectionMatrix();
          cameraRef.current.lookAt(cameraTargetRef.current);
          schedulePerspectiveRulerSync();
        }

        if (snap.bones && mannequinBonesRef.current) {
          for (const [key, pose] of Object.entries(snap.bones)) {
            const bone = mannequinBonesRef.current[key];
            if (!bone) continue;
            bone.quaternion.set(...pose.q).normalize();
            if (pose.p) {
              bone.position.set(...pose.p);
            }
            bone.updateMatrixWorld(true);
          }
          syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
        } else if (mannequinBonesRef.current) {
          syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
        }

        store3DActions.setPerspective(snap.perspective, Math.round(snap.cameraFov));
        store3DActions.updateLighting({
          keyLight: { ...snap.lighting.keyLight },
          rimLight: { ...snap.lighting.rimLight },
          ambientIntensity: snap.lighting.ambientIntensity,
          ambientColor: snap.lighting.ambientColor,
          castGroundShadow: snap.lighting.castGroundShadow,
          shadowOpacity: snap.lighting.shadowOpacity,
        });
        store3DActions.setShadingMode(snap.shadingMode);
        store3DActions.setMaterialRoughness(snap.materialRoughness);
        store3DActions.setToonOutline(snap.toonOutline);
        store3DActions.setOpacity(snap.opacity);
        store3DActions.setShowGrid(snap.showGrid);
      } finally {
        // Release restoration guard after React effects for the restored store values flush
        queueMicrotask(() => {
          isRestoringHistoryRef.current = false;
        });
      }
      syncHistoryFlagsToStore();
    },
    [schedulePerspectiveRulerSync, syncHistoryFlagsToStore]
  );

  const handleUndo3D = useCallback((): boolean => {
    // Flush any pending debounced slider/wheel edit before stepping back
    if (historyDebounceTimerRef.current) {
      commitHistoryNow();
    }
    const prev = historyStackRef.current.undo();
    if (!prev) {
      syncHistoryFlagsToStore();
      return false;
    }
    restoreSceneSnapshot(prev);
    return true;
  }, [commitHistoryNow, restoreSceneSnapshot, syncHistoryFlagsToStore]);

  const handleRedo3D = useCallback((): boolean => {
    if (historyDebounceTimerRef.current) {
      clearTimeout(historyDebounceTimerRef.current);
      historyDebounceTimerRef.current = null;
    }
    const next = historyStackRef.current.redo();
    if (!next) {
      syncHistoryFlagsToStore();
      return false;
    }
    restoreSceneSnapshot(next);
    return true;
  }, [restoreSceneSnapshot, syncHistoryFlagsToStore]);

  // Dispose cached procedural materials, smoothed geometries, and outline meshes
  const disposeMeshUserData = useCallback((obj: THREE.Object3D) => {
    const outlinesToRemove: THREE.Object3D[] = [];
    obj.traverse((child) => {
      if (child.userData?.is3DOutline) {
        outlinesToRemove.push(child);
      }
      const m = child as THREE.Mesh;
      if (m.isMesh) {
        if (m.userData.smoothGeometry) {
          m.userData.smoothGeometry.dispose();
          m.userData.smoothGeometry = null;
        }
        for (const key of [
          'silhouetteMaterial',
          'shadedMaterial',
          'smoothMaterial',
          'toonMaterial',
          'wireframeMaterial',
        ]) {
          const mat = m.userData[key];
          if (mat) {
            if (Array.isArray(mat)) {
              mat.forEach((item: THREE.Material) => item.dispose());
            } else {
              mat.dispose();
            }
            m.userData[key] = null;
          }
        }
      }
    });
    for (const outline of outlinesToRemove) {
      const m = outline as THREE.Mesh;
      if (m.material && !Array.isArray(m.material)) m.material.dispose();
      outline.parent?.remove(outline);
    }
  }, []);

  // Apply shading mode, material roughness, and optional inverted-hull manga outline
  const applyShadingAndStyle = useCallback(
    (mode: Shading3DMode, roughness: number, enableOutline: boolean) => {
      if (!modelRootRef.current) return;
      const gradTex = toonGradientTexRef.current;

      // Remove existing outline children before rebuilding if needed
      const existingOutlines: THREE.Object3D[] = [];
      modelRootRef.current.traverse((child) => {
        if (child.userData?.is3DOutline) {
          existingOutlines.push(child);
        }
      });
      for (const o of existingOutlines) {
        const m = o as THREE.Mesh;
        if (m.material && !Array.isArray(m.material)) m.material.dispose();
        o.parent?.remove(o);
      }

      const meshesToProcess: THREE.Mesh[] = [];
      modelRootRef.current.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh && !mesh.userData?.is3DHelper && !mesh.userData?.is3DOutline) {
          meshesToProcess.push(mesh);
        }
      });

      for (const mesh of meshesToProcess) {
        const isSkinned = Boolean((mesh as THREE.SkinnedMesh).isSkinnedMesh);
        if (!mesh.userData.origGeometry) {
          mesh.userData.origGeometry = mesh.geometry;
        }
        if (!mesh.userData.origMaterial) {
          mesh.userData.origMaterial = mesh.material;
        }

        const extractBaseColor = (mat: THREE.Material | THREE.Material[]): number => {
          const single = Array.isArray(mat) ? mat[0] : mat;
          if (single && 'color' in single && (single as any).color?.isColor) {
            return (single as any).color.getHex();
          }
          return 0xe2e8f0;
        };

        const extractMap = (mat: THREE.Material | THREE.Material[]): THREE.Texture | null => {
          const single = Array.isArray(mat) ? mat[0] : mat;
          if (single && 'map' in single && (single as any).map) {
            return (single as any).map as THREE.Texture;
          }
          return null;
        };

        if (mode === 'silhouette') {
          if (mesh.userData.origGeometry && mesh.geometry !== mesh.userData.origGeometry) {
            mesh.geometry = mesh.userData.origGeometry;
          }
          if (!mesh.userData.silhouetteMaterial) {
            mesh.userData.silhouetteMaterial = new THREE.MeshBasicMaterial({
              color: 0x111827,
              side: THREE.DoubleSide,
            });
          }
          mesh.material = mesh.userData.silhouetteMaterial;
        } else if (mode === 'wireframe') {
          if (mesh.userData.origGeometry && mesh.geometry !== mesh.userData.origGeometry) {
            mesh.geometry = mesh.userData.origGeometry;
          }
          if (!mesh.userData.wireframeMaterial) {
            mesh.userData.wireframeMaterial = new THREE.MeshStandardMaterial({
              color: 0x38bdf8,
              roughness: 0.5,
              metalness: 0.1,
              wireframe: true,
            });
          }
          mesh.material = mesh.userData.wireframeMaterial;
        } else if (mode === 'toon') {
          if (mesh.userData.origGeometry && mesh.geometry !== mesh.userData.origGeometry) {
            mesh.geometry = mesh.userData.origGeometry;
          }
          if (!mesh.userData.toonMaterial) {
            const baseHex = mesh.userData.hasCustomMaterial
              ? extractBaseColor(mesh.userData.origMaterial)
              : 0xe8edf2;
            const baseMap = mesh.userData.hasCustomMaterial
              ? extractMap(mesh.userData.origMaterial)
              : null;
            mesh.userData.toonMaterial = new THREE.MeshToonMaterial({
              color: baseHex,
              map: baseMap,
              gradientMap: gradTex,
              side: THREE.DoubleSide,
            });
          }
          mesh.material = mesh.userData.toonMaterial;
        } else if (mode === 'smooth') {
          // Never run mergeVertices on SkinnedMesh (would corrupt skinIndex/skinWeight binding!)
          if (!isSkinned && !mesh.userData.smoothGeometry && mesh.userData.origGeometry) {
            try {
              const cloned = mesh.userData.origGeometry.clone();
              const merged = BufferGeometryUtils.mergeVertices(cloned, 1e-4);
              mesh.userData.smoothGeometry = BufferGeometryUtils.toCreasedNormals(
                merged,
                (55 * Math.PI) / 180
              );
            } catch {
              const fallback = mesh.userData.origGeometry.clone();
              fallback.computeVertexNormals();
              mesh.userData.smoothGeometry = fallback;
            }
          }
          if (!isSkinned && mesh.userData.smoothGeometry) {
            mesh.geometry = mesh.userData.smoothGeometry;
          }

          const makeSmoothMat = (mat: THREE.Material): THREE.Material => {
            const smooth = mat.clone();
            if ('flatShading' in smooth) (smooth as any).flatShading = false;
            if ('roughness' in smooth && typeof (smooth as any).roughness === 'number') {
              (smooth as any).roughness = Math.max(0.12, roughness * 0.85);
            }
            smooth.needsUpdate = true;
            return smooth;
          };

          if (!mesh.userData.smoothMaterial) {
            if (mesh.userData.hasCustomMaterial && mesh.userData.origMaterial) {
              mesh.userData.smoothMaterial = Array.isArray(mesh.userData.origMaterial)
                ? mesh.userData.origMaterial.map(makeSmoothMat)
                : makeSmoothMat(mesh.userData.origMaterial);
            } else {
              mesh.userData.smoothMaterial = new THREE.MeshStandardMaterial({
                color: 0xdee4eb,
                roughness: Math.max(0.12, roughness * 0.85),
                metalness: 0.05,
                flatShading: false,
                side: THREE.DoubleSide,
              });
            }
          } else {
            const sm = mesh.userData.smoothMaterial;
            if (Array.isArray(sm)) {
              sm.forEach((m: any) => {
                if (typeof m.roughness === 'number') m.roughness = Math.max(0.12, roughness * 0.85);
              });
            } else if (typeof sm.roughness === 'number') {
              sm.roughness = Math.max(0.12, roughness * 0.85);
            }
          }
          mesh.material = mesh.userData.smoothMaterial;
        } else {
          // 'shaded' studio PBR
          if (mesh.userData.origGeometry && mesh.geometry !== mesh.userData.origGeometry) {
            mesh.geometry = mesh.userData.origGeometry;
          }
          if (mesh.userData.origMaterial && mesh.userData.hasCustomMaterial) {
            mesh.material = mesh.userData.origMaterial;
          } else {
            if (!mesh.userData.shadedMaterial) {
              mesh.userData.shadedMaterial = new THREE.MeshStandardMaterial({
                color: 0xe2e8f0,
                roughness,
                metalness: 0.08,
                side: THREE.DoubleSide,
              });
            } else {
              mesh.userData.shadedMaterial.roughness = roughness;
            }
            mesh.material = mesh.userData.shadedMaterial;
          }
        }

        // Optional inverted-hull manga outline preview (for non-skinned meshes)
        if (enableOutline && !isSkinned && mode !== 'wireframe') {
          const outlineMat = new THREE.MeshBasicMaterial({
            color: 0x0f172a,
            side: THREE.BackSide,
          });
          const outlineMesh = new THREE.Mesh(mesh.geometry, outlineMat);
          outlineMesh.scale.setScalar(1.022);
          outlineMesh.userData.is3DOutline = true;
          outlineMesh.castShadow = false;
          outlineMesh.receiveShadow = false;
          mesh.add(outlineMesh);
        }
      }
    },
    []
  );

  // Sync gizmo attachment to model root (unless an IK handle is currently selected)
  const syncGizmoAttachment = useCallback(() => {
    const tc = transformControlsRef.current;
    const helper = transformHelperRef.current;
    if (!tc || !helper) return;

    const state = use3DStore.getState();
    const canShow = activeToolRef.current === '3d' && state.isReferenceVisible && !isSpaceDownRef.current;

    if (state.activeIKHandle && ikHandlesRef.current?.[state.activeIKHandle]) {
      tc.setMode('translate');
      tc.setSpace('world');
      tc.attach(ikHandlesRef.current[state.activeIKHandle]);
      helper.visible = canShow;
      tc.enabled = canShow;
      return;
    }

    if (state.gizmoMode === 'none' || !modelRootRef.current) {
      tc.detach();
      helper.visible = false;
      tc.enabled = false;
    } else {
      tc.setMode(state.gizmoMode);
      tc.setSpace(state.gizmoSpace);
      tc.attach(modelRootRef.current);
      helper.visible = canShow;
      tc.enabled = canShow;
    }
  }, []);

  // Initialize Three.js scene strictly locally on a fresh canvas per lifecycle
  useEffect(() => {
    if (!isOpen || !canvasHostRef.current) return;

    const host = canvasHostRef.current;
    host.replaceChildren();
    setWebglError(null);

    const docAspect = dimensions.width / Math.max(1, dimensions.height);
    const perf = performanceManager.getConfig();
    const MAX_PREVIEW = perf.preview3DMaxResolution || 1920;
    let previewW = dimensions.width;
    let previewH = dimensions.height;
    if (previewW > MAX_PREVIEW || previewH > MAX_PREVIEW) {
      if (previewW > previewH) {
        previewW = MAX_PREVIEW;
        previewH = Math.max(1, Math.round(MAX_PREVIEW / docAspect));
      } else {
        previewH = MAX_PREVIEW;
        previewW = Math.max(1, Math.round(MAX_PREVIEW * docAspect));
      }
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = createSafeWebGLRenderer({
        alpha: true,
        antialias: perf.preview3DAntialias,
        powerPreference: perf.gpuPowerPreference,
        preserveDrawingBuffer: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to initialize 3D WebGL context.';
      console.error('[3D] Renderer initialization failed:', err);
      setWebglError(msg);
      return;
    }

    const canvas = renderer.domElement;
    canvas.width = previewW;
    canvas.height = previewH;
    canvas.className = 'w-full h-full block';
    canvas.style.imageRendering = 'auto';
    host.appendChild(canvas);
    canvasRef.current = canvas;

    // 1. Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // 2. Perspective Camera
    const camera = new THREE.PerspectiveCamera(use3DStore.getState().fov || 45, docAspect, 0.05, 500);
    camera.position.copy(DEFAULT_CAMERA_POS);
    cameraTargetRef.current.copy(DEFAULT_CAMERA_TARGET);
    camera.lookAt(cameraTargetRef.current);
    cameraRef.current = camera;

    // 3. Configure WebGL Renderer (Shadows + Filmic Tone Mapping)
    renderer.setSize(previewW, previewH, false);
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    if ('toneMapping' in renderer) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
    }
    if (renderer.shadowMap) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    rendererRef.current = renderer;

    // Toon gradient texture
    toonGradientTexRef.current = createToonGradientTexture();

    // 4. Floor Grid Helper (CSP-style studio grid)
    const gridHelper = new THREE.GridHelper(10, 20, 0x3b82f6, 0x334155);
    gridHelper.position.y = 0;
    gridHelper.userData.is3DHelper = true;
    scene.add(gridHelper);
    gridHelperRef.current = gridHelper;

    // 5. Shadow-Catching Ground Plane (Y = 0)
    const shadowGeo = new THREE.PlaneGeometry(14, 14);
    const shadowMat = new THREE.ShadowMaterial({ opacity: 0.32 });
    const shadowPlane = new THREE.Mesh(shadowGeo, shadowMat);
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = 0.001;
    shadowPlane.receiveShadow = true;
    shadowPlane.userData.is3DHelper = true;
    scene.add(shadowPlane);
    shadowPlaneRef.current = shadowPlane;

    // 6. Clip Studio Advanced Dual Lighting Setup
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x475569, 0.45);
    scene.add(hemiLight);
    hemiLightRef.current = hemiLight;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambientLight);
    ambientLightRef.current = ambientLight;

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(3, 4.5, 3.5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 22;
    keyLight.shadow.camera.left = -4;
    keyLight.shadow.camera.right = 4;
    keyLight.shadow.camera.top = 4;
    keyLight.shadow.camera.bottom = -4;
    keyLight.shadow.bias = -0.0005;
    scene.add(keyLight);
    keyLightRef.current = keyLight;

    const rimLight = new THREE.DirectionalLight(0x93c5fd, 0.55);
    rimLight.position.set(-3.5, 2.5, -3.5);
    scene.add(rimLight);
    rimLightRef.current = rimLight;

    // 7. TransformControls for On-Canvas 3D Manipulator (Rotate / Translate / Scale)
    const transformControls = new TransformControls(camera, canvas);
    transformControls.size = 0.85;
    transformControls.setSpace(use3DStore.getState().gizmoSpace);

    // CRITICAL FIX: Override TransformControls pointer projection so gizmos work pixel-perfectly
    // under ANY 2D canvas pan, zoom, rotation, or horizontal/vertical flip!
    (transformControls as any)._getPointer = (event: PointerEvent) => {
      const ndc = clientToNDC(event.clientX, event.clientY);
      return { x: ndc.x, y: ndc.y, button: event.button };
    };

    const transformHelper = transformControls.getHelper();
    transformHelper.userData.is3DHelper = true;
    transformHelper.traverse((child) => {
      child.userData.is3DHelper = true;
    });
    transformHelper.visible = false;
    scene.add(transformHelper);

    transformControls.addEventListener('dragging-changed', (event: any) => {
      if (!event.value) {
        commitHistoryNow();
      }
    });

    transformControls.addEventListener('objectChange', () => {
      const targetObj = transformControls.object;
      if (!targetObj) return;

      if (targetObj.name.startsWith('IKHandle_') && mannequinBonesRef.current) {
        const handleName = targetObj.name.replace('IKHandle_', '');
        const bones = mannequinBonesRef.current;
        const targetPos = targetObj.position.clone();
        const toWorldPole = (localPole: THREE.Vector3) =>
          modelRootRef.current ? modelRootRef.current.localToWorld(localPole.clone()) : localPole;

        if (handleName === 'leftHand' && bones.leftUpperArm && bones.leftLowerArm && bones.leftHand) {
          solveTwoBoneIK(
            bones.leftUpperArm,
            bones.leftLowerArm,
            bones.leftHand,
            targetPos,
            toWorldPole(new THREE.Vector3(0.6, 1.2, -0.5))
          );
        } else if (handleName === 'rightHand' && bones.rightUpperArm && bones.rightLowerArm && bones.rightHand) {
          solveTwoBoneIK(
            bones.rightUpperArm,
            bones.rightLowerArm,
            bones.rightHand,
            targetPos,
            toWorldPole(new THREE.Vector3(-0.6, 1.2, -0.5))
          );
        } else if (handleName === 'leftFoot' && bones.leftUpperLeg && bones.leftLowerLeg && bones.leftFoot) {
          solveTwoBoneIK(
            bones.leftUpperLeg,
            bones.leftLowerLeg,
            bones.leftFoot,
            targetPos,
            toWorldPole(new THREE.Vector3(0.15, 0.5, 0.8))
          );
        } else if (handleName === 'rightFoot' && bones.rightUpperLeg && bones.rightLowerLeg && bones.rightFoot) {
          solveTwoBoneIK(
            bones.rightUpperLeg,
            bones.rightLowerLeg,
            bones.rightFoot,
            targetPos,
            toWorldPole(new THREE.Vector3(-0.15, 0.5, 0.8))
          );
        } else if (handleName === 'head' && bones.head) {
          bones.head.lookAt(targetPos);
          bones.head.updateMatrixWorld(true);
        }
      } else if (targetObj === modelRootRef.current) {
        // Enforce uniform scaling if locked in TransformControls scale mode
        if (
          transformControls.mode === 'scale' &&
          use3DStore.getState().modelTransform.uniformScale
        ) {
          const avg = Math.max(0.05, Math.min(10, (targetObj.scale.x + targetObj.scale.y + targetObj.scale.z) / 3));
          targetObj.scale.setScalar(avg);
        } else if (transformControls.mode === 'scale') {
          targetObj.scale.set(
            Math.max(0.05, Math.min(10, targetObj.scale.x)),
            Math.max(0.05, Math.min(10, targetObj.scale.y)),
            Math.max(0.05, Math.min(10, targetObj.scale.z))
          );
        }
        targetObj.updateMatrixWorld(true);
        syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
        scheduleTransformSyncToStore();
      }
    });

    transformControlsRef.current = transformControls;
    transformHelperRef.current = transformHelper;

    // 8. Render Loop (skips GPU work when hidden or reference toggled off)
    let running = true;
    const animate = () => {
      if (!running) return;
      if ((typeof document === 'undefined' || !document.hidden) && use3DStore.getState().isReferenceVisible) {
        try {
          renderer.render(scene, camera);
        } catch (err) {
          console.warn('[3D Render Loop Error]:', err);
        }
      }
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animate();

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      console.warn('[3D] WebGL context lost.');
      running = false;
    };
    canvas.addEventListener('webglcontextlost', handleContextLost, false);
    const initSnap = captureSceneSnapshot();
    if (initSnap) {
      historyStackRef.current.reset(initSnap);
      syncHistoryFlagsToStore();
    }
    setSceneReadyVersion((v) => v + 1);

    return () => {
      running = false;
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      if (historyDebounceTimerRef.current) {
        clearTimeout(historyDebounceTimerRef.current);
        historyDebounceTimerRef.current = null;
      }
      historyStackRef.current.clear();
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      if (transformSyncRafRef.current) {
        cancelAnimationFrame(transformSyncRafRef.current);
        transformSyncRafRef.current = null;
      }
      if (perspectiveSyncRafRef.current) {
        cancelAnimationFrame(perspectiveSyncRafRef.current);
        perspectiveSyncRafRef.current = null;
      }
      if (modelRootRef.current) {
        disposeMeshUserData(modelRootRef.current);
      }
      if (toonGradientTexRef.current) {
        toonGradientTexRef.current.dispose();
        toonGradientTexRef.current = null;
      }
      transformControls.dispose();
      disposeThreeResources(scene, renderer);
      canvas.remove();
      canvasRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      transformControlsRef.current = null;
      transformHelperRef.current = null;
      modelRootRef.current = null;
      mannequinBonesRef.current = null;
      ikHandlesRef.current = null;
      ikHandlesContainerRef.current = null;
      loadedFileKeyRef.current = null;
    };
  }, [
    isOpen,
    dimensions.width,
    dimensions.height,
    clientToNDC,
    disposeMeshUserData,
    scheduleTransformSyncToStore,
    commitHistoryNow,
    captureSceneSnapshot,
    syncHistoryFlagsToStore,
  ]);

  // Sync Gizmo Mode, Space, Snap, and Tool Interactivity
  useEffect(() => {
    syncGizmoAttachment();
  }, [gizmoMode, gizmoSpace, activeTool, isReferenceVisible, isSpaceDown, sceneReadyVersion, syncGizmoAttachment]);

  useEffect(() => {
    const tc = transformControlsRef.current;
    if (!tc) return;
    tc.setRotationSnap(snapEnabled ? THREE.MathUtils.degToRad(15) : null);
    tc.setTranslationSnap(snapEnabled ? 0.1 : null);
    tc.setScaleSnap(snapEnabled ? 0.1 : null);
  }, [snapEnabled, sceneReadyVersion]);

  // Sync Floor Grid & IK Handle visibility (hide helpers when painting with 2D tools for clean reference view!)
  useEffect(() => {
    if (gridHelperRef.current) {
      gridHelperRef.current.visible = showGrid && is3DToolActive;
    }
    if (ikHandlesContainerRef.current) {
      ikHandlesContainerRef.current.visible = showIKHandles && is3DToolActive;
    }
  }, [showGrid, showIKHandles, is3DToolActive, sceneReadyVersion]);

  // Sync Dual Lighting & Ground Shadow
  useEffect(() => {
    if (keyLightRef.current) {
      const pos = sphericalLightToVector(
        lighting.keyLight.azimuth,
        lighting.keyLight.elevation,
        lighting.keyLight.isBacklit,
        6
      );
      keyLightRef.current.position.set(pos.x, pos.y, pos.z);
      keyLightRef.current.intensity = lighting.keyLight.enabled ? lighting.keyLight.intensity * 1.4 : 0;
      keyLightRef.current.color.set(lighting.keyLight.color);
      keyLightRef.current.castShadow = lighting.keyLight.enabled && lighting.castGroundShadow;
    }
    if (rimLightRef.current) {
      const pos = sphericalLightToVector(
        lighting.rimLight.azimuth,
        lighting.rimLight.elevation,
        false,
        6
      );
      rimLightRef.current.position.set(pos.x, pos.y, pos.z);
      rimLightRef.current.intensity = lighting.rimLight.enabled ? lighting.rimLight.intensity * 1.2 : 0;
      rimLightRef.current.color.set(lighting.rimLight.color);
    }
    if (ambientLightRef.current) {
      ambientLightRef.current.intensity = lighting.ambientIntensity * 0.7;
      ambientLightRef.current.color.set(lighting.ambientColor);
    }
    if (hemiLightRef.current) {
      hemiLightRef.current.intensity = lighting.ambientIntensity * 0.55;
      hemiLightRef.current.color.set(lighting.ambientColor);
    }
    if (shadowPlaneRef.current) {
      shadowPlaneRef.current.visible = lighting.castGroundShadow && lighting.keyLight.enabled;
      const mat = shadowPlaneRef.current.material as THREE.ShadowMaterial;
      mat.opacity = lighting.shadowOpacity;
    }
  }, [lighting, sceneReadyVersion]);

  // Sync Shading Mode, Roughness & Toon Outline
  useEffect(() => {
    applyShadingAndStyle(shadingMode, materialRoughness, toonOutline);
  }, [shadingMode, materialRoughness, toonOutline, applyShadingAndStyle, sceneReadyVersion]);

  // Record history for store-driven lighting, shading, opacity, and grid changes
  useEffect(() => {
    scheduleDebouncedHistoryCommit();
  }, [
    lighting,
    shadingMode,
    materialRoughness,
    toonOutline,
    opacity,
    showGrid,
    scheduleDebouncedHistoryCommit,
  ]);

  // Sync Perspective Ruler when toggle is turned ON
  useEffect(() => {
    if (syncCameraPerspective) {
      schedulePerspectiveRulerSync(true);
    }
  }, [syncCameraPerspective, schedulePerspectiveRulerSync]);

  // Unified Camera & Object Transform Delta Execution (used by BOTH canvas drag & toolbar scrub-drag)
  const applyTransformDelta = useCallback(
    (mode: Tool3DMode | Resolved3DPointerAction, rawDx: number, rawDy: number, snap = false) => {
      const camera = cameraRef.current;
      const model = modelRootRef.current;
      const target = cameraTargetRef.current;
      if (!camera) return;

      const meta = viewportMetaRef.current;
      const camState = navigation
        ? navigation.getCameraState()
        : { rotation: meta.rotation, flipX: meta.flipX, flipY: meta.flipY };
      const { dx, dy } = mapScreenDeltaToCanvasDelta(
        rawDx,
        rawDy,
        camState.rotation,
        camState.flipX,
        camState.flipY
      );

      switch (mode) {
        case 'camera-orbit': {
          const offset = new THREE.Vector3().subVectors(camera.position, target);
          const spherical = new THREE.Spherical().setFromVector3(offset);
          const orbitSpeed = 0.0075;
          spherical.theta -= dx * orbitSpeed;
          spherical.phi = Math.max(0.02, Math.min(Math.PI - 0.02, spherical.phi - dy * orbitSpeed));
          offset.setFromSpherical(spherical);
          camera.position.copy(target).add(offset);
          camera.lookAt(target);
          schedulePerspectiveRulerSync();
          break;
        }

        case 'camera-pan': {
          const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
          const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
          const dist = camera.position.distanceTo(target);
          const panSpeed = 0.0015 * dist;
          const panOffset = new THREE.Vector3()
            .addScaledVector(camRight, -dx * panSpeed)
            .addScaledVector(camUp, dy * panSpeed);
          camera.position.add(panOffset);
          target.add(panOffset);
          camera.lookAt(target);
          schedulePerspectiveRulerSync();
          break;
        }

        case 'camera-zoom': {
          const zoomSpeed = 0.009;
          const toCam = new THREE.Vector3().subVectors(camera.position, target);
          const currentDist = toCam.length();
          const newDist = Math.max(0.45, Math.min(45, currentDist * (1 + dy * zoomSpeed)));
          toCam.setLength(newDist);
          camera.position.copy(target).add(toCam);
          camera.lookAt(target);
          schedulePerspectiveRulerSync();
          break;
        }

        case 'model-move': {
          if (!model) return;
          const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
          const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
          const dist = camera.position.distanceTo(model.position);
          const moveSpeed = 0.0018 * Math.max(1, dist);
          model.position.addScaledVector(camRight, dx * moveSpeed);
          model.position.addScaledVector(camUp, -dy * moveSpeed);
          if (snap) {
            model.position.set(
              snapPositionCoord(model.position.x, 0.1),
              snapPositionCoord(model.position.y, 0.1),
              snapPositionCoord(model.position.z, 0.1)
            );
          }
          model.updateMatrixWorld(true);
          syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
          scheduleTransformSyncToStore();
          break;
        }

        case 'model-plane-move': {
          if (!model) return;
          const forward = new THREE.Vector3();
          camera.getWorldDirection(forward);
          forward.y = 0;
          if (forward.lengthSq() > 0.0001) forward.normalize();
          else forward.set(0, 0, -1);
          const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
          const dist = camera.position.distanceTo(model.position);
          const planeSpeed = 0.002 * Math.max(1, dist);
          model.position.addScaledVector(right, dx * planeSpeed);
          model.position.addScaledVector(forward, -dy * planeSpeed);
          if (snap) {
            model.position.x = snapPositionCoord(model.position.x, 0.1);
            model.position.z = snapPositionCoord(model.position.z, 0.1);
          }
          model.updateMatrixWorld(true);
          syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
          scheduleTransformSyncToStore();
          break;
        }

        case 'model-rotate': {
          if (!model) return;
          const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
          const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
          const rotSpeed = 0.0085;
          const qYaw = new THREE.Quaternion().setFromAxisAngle(camUp, dx * rotSpeed);
          const qPitch = new THREE.Quaternion().setFromAxisAngle(camRight, dy * rotSpeed);
          model.quaternion.premultiply(qYaw).premultiply(qPitch).normalize();
          model.updateMatrixWorld(true);
          syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
          scheduleTransformSyncToStore();
          break;
        }

        case 'model-rotate-yaw': {
          if (!model) return;
          const worldUp = new THREE.Vector3(0, 1, 0);
          const q = new THREE.Quaternion().setFromAxisAngle(worldUp, dx * 0.01);
          model.quaternion.premultiply(q).normalize();
          model.updateMatrixWorld(true);
          syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
          scheduleTransformSyncToStore();
          break;
        }

        case 'model-rotate-roll': {
          if (!model) return;
          const camDir = new THREE.Vector3();
          camera.getWorldDirection(camDir);
          const q = new THREE.Quaternion().setFromAxisAngle(camDir, dx * 0.01);
          model.quaternion.premultiply(q).normalize();
          model.updateMatrixWorld(true);
          syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
          scheduleTransformSyncToStore();
          break;
        }

        case 'model-scale': {
          if (!model) return;
          const delta = (dx - dy) * 0.005;
          const factor = Math.exp(delta);
          const nextX = Math.max(0.05, Math.min(10, model.scale.x * factor));
          const nextY = Math.max(0.05, Math.min(10, model.scale.y * factor));
          const nextZ = Math.max(0.05, Math.min(10, model.scale.z * factor));
          if (snap) {
            model.scale.set(
              snapScaleFactor(nextX),
              snapScaleFactor(nextY),
              snapScaleFactor(nextZ)
            );
          } else {
            model.scale.set(nextX, nextY, nextZ);
          }
          model.updateMatrixWorld(true);
          syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
          scheduleTransformSyncToStore();
          break;
        }
      }
    },
    [navigation, schedulePerspectiveRulerSync, scheduleTransformSyncToStore]
  );

  // Apply numeric transform directly from Tool Property Inspector
  const applyNumericTransform = useCallback(
    (next: Model3DTransformState) => {
      store3DActions.setModelTransform(next);
      const model = modelRootRef.current;
      if (!model) return;
      model.position.set(next.position[0], next.position[1], next.position[2]);
      const euler = new THREE.Euler(
        THREE.MathUtils.degToRad(next.rotation[0]),
        THREE.MathUtils.degToRad(next.rotation[1]),
        THREE.MathUtils.degToRad(next.rotation[2]),
        'YXZ'
      );
      model.quaternion.setFromEuler(euler);
      model.scale.set(
        Math.max(0.05, Math.min(10, next.scale[0])),
        Math.max(0.05, Math.min(10, next.scale[1])),
        Math.max(0.05, Math.min(10, next.scale[2]))
      );
      model.updateMatrixWorld(true);
      syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
      scheduleDebouncedHistoryCommit();
    },
    [scheduleDebouncedHistoryCommit]
  );

  // Magnet Action: Drop model flush to floor plane Y = 0
  const handleSnapToGround = useCallback(() => {
    const model = modelRootRef.current;
    if (!model) return;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    if (Number.isFinite(box.min.y)) {
      model.position.y -= box.min.y;
      model.updateMatrixWorld(true);
      syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
      scheduleTransformSyncToStore();
      commitHistoryNow();
    }
  }, [commitHistoryNow, scheduleTransformSyncToStore]);

  // Reset Model Transform (preserves normalized inner scale!)
  const handleResetModelTransform = useCallback(() => {
    const model = modelRootRef.current;
    if (!model) return;
    model.position.set(0, 0, 0);
    model.quaternion.identity();
    model.scale.set(1, 1, 1);
    model.updateMatrixWorld(true);
    syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
    store3DActions.setModelTransform({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    commitHistoryNow();
  }, [commitHistoryNow]);

  // Quick Model Yaw Rotations
  const rotateModelYaw = useCallback(
    (degrees: number) => {
      const model = modelRootRef.current;
      if (!model) return;
      const q = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        THREE.MathUtils.degToRad(degrees)
      );
      model.quaternion.premultiply(q).normalize();
      model.updateMatrixWorld(true);
      syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
      scheduleTransformSyncToStore();
      commitHistoryNow();
    },
    [commitHistoryNow, scheduleTransformSyncToStore]
  );

  // Perspective (Dolly Zoom) Adjustment
  const applyPerspectiveDollyZoom = useCallback(
    (factor: number) => {
      const camera = cameraRef.current;
      if (!camera) return;
      const target = cameraTargetRef.current;
      const clampedFactor = Math.max(0.3, Math.min(2.5, factor));

      const baseFovRad = THREE.MathUtils.degToRad(45);
      const newTan = clampedFactor * Math.tan(baseFovRad / 2);
      const newFovDeg = Math.min(100, Math.max(16, THREE.MathUtils.radToDeg(2 * Math.atan(newTan))));

      const toCam = new THREE.Vector3().subVectors(camera.position, target);
      const currentDist = toCam.length();
      const oldFovRad = THREE.MathUtils.degToRad(camera.fov) / 2;
      const newFovRad = THREE.MathUtils.degToRad(newFovDeg) / 2;
      const targetDist = Math.max(0.55, Math.min(45, (currentDist * Math.tan(oldFovRad)) / Math.tan(newFovRad)));

      toCam.setLength(targetDist);
      camera.position.copy(target).add(toCam);
      camera.fov = newFovDeg;
      camera.updateProjectionMatrix();
      camera.lookAt(target);
      store3DActions.setPerspective(clampedFactor, Math.round(newFovDeg));
      schedulePerspectiveRulerSync();
      scheduleDebouncedHistoryCommit();
    },
    [scheduleDebouncedHistoryCommit, schedulePerspectiveRulerSync]
  );

  const handleResetCamera = useCallback(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const isMannequin = use3DStore.getState().isMannequinActive;
    cameraTargetRef.current.set(0, isMannequin ? 0.92 : 0.8, 0);
    camera.position.set(0, isMannequin ? 1.25 : 1.35, isMannequin ? 3.4 : 3.8);
    camera.fov = 45;
    camera.updateProjectionMatrix();
    camera.lookAt(cameraTargetRef.current);
    store3DActions.setPerspective(1.0, 45);
    schedulePerspectiveRulerSync();
    commitHistoryNow();
  }, [commitHistoryNow, schedulePerspectiveRulerSync]);

  const setCameraPreset = useCallback(
    (presetName: Camera3DPreset) => {
      const camera = cameraRef.current;
      if (!camera) return;
      const target = cameraTargetRef.current;
      const dist = Math.max(2.0, camera.position.distanceTo(target));

      switch (presetName) {
        case 'front':
          camera.position.set(target.x, target.y + 0.12, target.z + dist);
          break;
        case 'side':
          camera.position.set(target.x - dist, target.y + 0.12, target.z);
          break;
        case 'top':
          camera.position.set(target.x, target.y + dist, target.z + 0.05);
          break;
        case 'threeQuarter':
          camera.position.set(target.x + dist * 0.68, target.y + dist * 0.42, target.z + dist * 0.68);
          break;
        case 'lowAngle':
          camera.position.set(target.x + dist * 0.48, Math.max(0.15, target.y - dist * 0.35), target.z + dist * 0.8);
          break;
        case 'back':
          camera.position.set(target.x, target.y + 0.12, target.z - dist);
          break;
      }
      camera.lookAt(target);
      schedulePerspectiveRulerSync();
      commitHistoryNow();
    },
    [commitHistoryNow, schedulePerspectiveRulerSync]
  );

  // Clean helper to clear previous model & IK handles before attaching a new object
  const clearCurrentModel = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (transformControlsRef.current) {
      transformControlsRef.current.detach();
    }
    if (modelRootRef.current) {
      disposeMeshUserData(modelRootRef.current);
      disposeThreeResources(modelRootRef.current, null);
      scene.remove(modelRootRef.current);
      modelRootRef.current = null;
    }
    if (ikHandlesContainerRef.current) {
      disposeThreeResources(ikHandlesContainerRef.current, null);
      scene.remove(ikHandlesContainerRef.current);
      ikHandlesContainerRef.current = null;
      ikHandlesRef.current = null;
    }
    mannequinBonesRef.current = null;
  }, [disposeMeshUserData]);

  // Attach any normalized model into a clean user-transform root group (scale 1 = 100%)
  const attachNormalizedObject = useCallback(
    (
      innerContent: THREE.Object3D,
      displayName: string,
      kind: 'imported',
      detectedBones: HumanoidBones | null
    ) => {
      const scene = sceneRef.current;
      if (!scene) return;

      const userRoot = new THREE.Group();
      userRoot.name = 'UserModelRoot';
      userRoot.position.set(0, 0, 0);
      userRoot.quaternion.identity();
      userRoot.scale.set(1, 1, 1);
      userRoot.add(innerContent);

      modelRootRef.current = userRoot;
      scene.add(userRoot);
      userRoot.updateMatrixWorld(true);

      const hasBones = Boolean(
        detectedBones &&
          (detectedBones.hips || detectedBones.leftHand || detectedBones.rightHand || detectedBones.head)
      );

      if (hasBones && detectedBones) {
        mannequinBonesRef.current = detectedBones;
        const { container, handles } = createIKHandles();
        ikHandlesRef.current = handles;
        ikHandlesContainerRef.current = container;
        syncIKHandlesToBones(detectedBones, handles);
        container.visible = use3DStore.getState().showIKHandles && activeToolRef.current === '3d';
        scene.add(container);
      } else {
        mannequinBonesRef.current = null;
      }

      store3DActions.setLoadedModel(displayName, kind, hasBones);
      store3DActions.setModelTransform({
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      });

      const s = use3DStore.getState();
      applyShadingAndStyle(s.shadingMode, s.materialRoughness, s.toonOutline);
      syncGizmoAttachment();

      // Frame camera cleanly around the loaded object
      if (cameraRef.current) {
        const box = new THREE.Box3().setFromObject(userRoot);
        const center = new THREE.Vector3(0, 0.85, 0);
        if (!box.isEmpty()) box.getCenter(center);
        cameraTargetRef.current.copy(center);
        cameraRef.current.position.set(center.x, center.y + 0.35, center.z + 3.5);
        cameraRef.current.lookAt(cameraTargetRef.current);
      }

      // Reset 3D undo history baseline to this newly loaded model state
      const baseSnap = captureSceneSnapshot();
      if (baseSnap) {
        historyStackRef.current.reset(baseSnap);
        syncHistoryFlagsToStore();
      }
    },
    [applyShadingAndStyle, captureSceneSnapshot, syncGizmoAttachment, syncHistoryFlagsToStore]
  );

  // Load 3D model from file (.glb, .gltf, .obj)
  const loadFromFile = useCallback(
    (file: File) => {
      if (!sceneRef.current) return;
      const fileName = file.name.toLowerCase();

      const fitAndAttach = (model: THREE.Group | THREE.Object3D) => {
        clearCurrentModel();

        const toRemove: THREE.Object3D[] = [];
        model.traverse((child) => {
          if ((child as any).isCamera || (child as any).isLight) {
            toRemove.push(child);
            return;
          }
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            if (mesh.material) {
              mesh.userData.origGeometry = mesh.geometry;
              mesh.userData.origMaterial = mesh.material;
              mesh.userData.hasCustomMaterial = true;
              const fixMat = (m: THREE.Material) => {
                m.side = THREE.DoubleSide;
                if ((m as any).transmission !== undefined && (m as any).transmission > 0) {
                  m.transparent = true;
                  if (m.opacity < 0.25) m.opacity = 0.85;
                }
              };
              if (Array.isArray(mesh.material)) mesh.material.forEach(fixMat);
              else fixMat(mesh.material);
            }
          }
        });
        toRemove.forEach((obj) => obj.parent?.remove(obj));

        model.position.set(0, 0, 0);
        model.scale.set(1, 1, 1);
        model.rotation.set(0, 0, 0);
        model.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(model);
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);

        const maxDim = Math.max(size.x, size.y, size.z);
        const targetDim = 2.0;
        const normScale = Number.isFinite(maxDim) && maxDim > 0.0001 ? targetDim / maxDim : 1;

        // Inner normalization wrapper: centers X/Z and places bottom flush at Y = 0
        const normalizedWrapper = new THREE.Group();
        normalizedWrapper.name = 'NormalizedModelWrapper';
        model.position.set(-center.x, -box.min.y, -center.z);
        normalizedWrapper.scale.setScalar(normScale);
        normalizedWrapper.add(model);

        const detectedBones = findHumanoidBones(model);
        attachNormalizedObject(normalizedWrapper, file.name, 'imported', detectedBones);
      };

      const blobUrl = URL.createObjectURL(file);
      if (fileName.endsWith('.glb') || fileName.endsWith('.gltf')) {
        const loader = new GLTFLoader();
        loader.load(
          blobUrl,
          (gltf) => {
            URL.revokeObjectURL(blobUrl);
            fitAndAttach(gltf.scene);
          },
          undefined,
          (err) => {
            URL.revokeObjectURL(blobUrl);
            console.error('[3D] GLTF load error:', err);
          }
        );
      } else if (fileName.endsWith('.obj')) {
        const loader = new OBJLoader();
        loader.load(
          blobUrl,
          (obj) => {
            URL.revokeObjectURL(blobUrl);
            fitAndAttach(obj);
          },
          undefined,
          (err) => {
            URL.revokeObjectURL(blobUrl);
            console.error('[3D] OBJ load error:', err);
          }
        );
      }
    },
    [attachNormalizedObject, clearCurrentModel]
  );

  // Select IK target limb (either from clicking sphere on canvas or clicking button in inspector)
  const selectIKTarget = useCallback(
    (targetName: string | null) => {
      store3DActions.setActiveIKHandle(targetName);
      syncGizmoAttachment();
    },
    [syncGizmoAttachment]
  );

  // Apply Pose Preset & keep IK handles glued to updated bone positions
  const handleApplyPreset = useCallback(
    (preset: PosePresetName) => {
      if (!mannequinBonesRef.current) return;
      applyPosePreset(mannequinBonesRef.current, preset);
      syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
      commitHistoryNow();
    },
    [commitHistoryNow]
  );

  // Load initialFile if supplied when opening 3D stage
  useEffect(() => {
    if (initialFile && isOpen && sceneRef.current) {
      const fileKey = `${initialFile.name}-${initialFile.size}-${initialFile.lastModified}`;
      if (loadedFileKeyRef.current !== fileKey) {
        loadedFileKeyRef.current = fileKey;
        loadFromFile(initialFile);
      }
    }
  }, [initialFile, isOpen, loadFromFile, sceneReadyVersion]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const fileKey = `${file.name}-${file.size}-${file.lastModified}`;
      loadedFileKeyRef.current = fileKey;
      loadFromFile(file);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Helper to toggle scene helper objects around baking
  const setHelpersVisible = useCallback((visible: boolean) => {
    const s = use3DStore.getState();
    if (transformHelperRef.current) {
      transformHelperRef.current.visible =
        visible && activeToolRef.current === '3d' && (s.gizmoMode !== 'none' || Boolean(s.activeIKHandle));
    }
    if (gridHelperRef.current) {
      gridHelperRef.current.visible = visible && s.showGrid && activeToolRef.current === '3d';
    }
    if (ikHandlesContainerRef.current) {
      ikHandlesContainerRef.current.visible = visible && s.showIKHandles && activeToolRef.current === '3d';
    }
  }, []);

  // Live preview render for the standalone LT Extraction Modal (fast capped resolution, non-destructive)
  const handleRenderLTPreview = useCallback(
    async (settings: LTConversionSettings): Promise<LTPreviewBuffers | null> => {
      if (!sceneRef.current || !cameraRef.current || !modelRootRef.current) return null;

      const MAX_PREVIEW_DIM = 680;
      const aspect = dimensions.width / Math.max(1, dimensions.height);
      let previewW = dimensions.width;
      let previewH = dimensions.height;
      if (previewW > MAX_PREVIEW_DIM || previewH > MAX_PREVIEW_DIM) {
        if (previewW >= previewH) {
          previewW = MAX_PREVIEW_DIM;
          previewH = Math.max(1, Math.round(MAX_PREVIEW_DIM / aspect));
        } else {
          previewH = MAX_PREVIEW_DIM;
          previewW = Math.max(1, Math.round(MAX_PREVIEW_DIM * aspect));
        }
      }

      const prevShadowVis = shadowPlaneRef.current?.visible ?? false;
      try {
        setHelpersVisible(false);
        if (shadowPlaneRef.current) shadowPlaneRef.current.visible = false;

        const docDpi = dimensions.dpi ?? 600;
        const previewScale = previewW / Math.max(1, dimensions.width);
        const previewDpi = Math.max(72, Math.round(docDpi * previewScale));

        const result = await bake3DToLineAndTone({
          scene: sceneRef.current,
          camera: cameraRef.current,
          dimensions: { width: previewW, height: previewH, dpi: previewDpi },
          dpi: previewDpi,
          activeRenderer: rendererRef.current,
          lineWidth: settings.lineWidth,
          lineThreshold: settings.lineThreshold,
          toneCount: settings.toneCount,
          toneFrequencies: settings.toneFrequencies,
          antiAliasing: settings.antiAliasing ?? false,
          disposeOnComplete: false,
          previewOnly: true,
        });

        return {
          lineCanvas: result.lineCanvas,
          toneCanvases: result.toneCanvases,
        };
      } finally {
        setHelpersVisible(true);
        if (shadowPlaneRef.current) {
          shadowPlaneRef.current.visible = prevShadowVis;
        }
      }
    },
    [dimensions.height, dimensions.width, setHelpersVisible]
  );

  // 3D LT Lineart & Screentone Extraction
  const handleExtractLineAndTone = useCallback(
    async (settings?: LTConversionSettings) => {
      const s = use3DStore.getState();
      if (!sceneRef.current || !cameraRef.current || !modelRootRef.current || s.isBaking) return;
      store3DActions.setIsBaking(true);

      try {
        setHelpersVisible(false);
        if (shadowPlaneRef.current) shadowPlaneRef.current.visible = false;

        const effectiveLineWidth = settings?.lineWidth ?? 1;
        const effectiveThreshold = settings?.lineThreshold ?? 0.28;
        const effectiveToneCount = settings?.toneCount ?? 2;
        const modelDisplayName = s.loadedModelName
          ? s.loadedModelName.replace(/\.[^/.]+$/, '')
          : '3D Model';
        const targetFolderName = settings?.folderName?.trim() || `3D Extraction [${modelDisplayName}]`;

        await bake3DToLineAndTone({
          scene: sceneRef.current,
          camera: cameraRef.current,
          dimensions,
          dpi: dimensions.dpi ?? 600,
          activeRenderer: rendererRef.current,
          modelName: modelDisplayName,
          targetFolderName,
          lineWidth: effectiveLineWidth,
          lineThreshold: effectiveThreshold,
          toneCount: effectiveToneCount,
          toneFrequencies: settings?.toneFrequencies,
          antiAliasing: settings?.antiAliasing ?? false,
          disposeOnComplete: false,
          onInsertLayers: (layers, canvases) => {
            for (let i = layers.length - 1; i >= 0; i--) {
              onInsertRasterLayer(layers[i], canvases[i]);
            }
          },
        });

        store3DActions.setIsBaking(false);
        setIsLTModalOpen(false);
        onClose();
      } catch (err) {
        console.error('[3D] Failed to extract line & tone:', err);
        store3DActions.setIsBaking(false);
        setHelpersVisible(true);
        if (shadowPlaneRef.current) {
          shadowPlaneRef.current.visible =
            use3DStore.getState().lighting.castGroundShadow &&
            use3DStore.getState().lighting.keyLight.enabled;
        }
      }
    },
    [dimensions, onClose, onInsertRasterLayer, setHelpersVisible]
  );

  // Bake 3D view into a standard 2D Raster Layer
  const handleBakeTo2D = useCallback(
    async (closeAfter = true) => {
      const s = use3DStore.getState();
      if (!sceneRef.current || !cameraRef.current || !modelRootRef.current || s.isBaking) return;
      store3DActions.setIsBaking(true);

      try {
        setHelpersVisible(false);
        const result = await bake3DToRasterLayer({
          scene: sceneRef.current,
          camera: cameraRef.current,
          dimensions,
          activeRenderer: rendererRef.current,
          layerName: s.loadedModelName ? `3D (${s.loadedModelName})` : '3D Model',
          opacity: s.opacity,
          blendMode: 'normal',
          disposeOnComplete: false,
          onInsertLayer: (layer, rasterCanvas) => {
            onInsertRasterLayer(layer, rasterCanvas);
          },
        });

        onBakeSuccess?.(result.layer);
        store3DActions.setIsBaking(false);
        if (closeAfter) {
          onClose();
        } else {
          setHelpersVisible(true);
        }
      } catch (err) {
        console.error('[3D] Failed to rasterize 3D layer:', err);
        store3DActions.setIsBaking(false);
        setHelpersVisible(true);
      }
    },
    [dimensions, onBakeSuccess, onClose, onInsertRasterLayer, setHelpersVisible]
  );

  // Register imperative bridge for ToolPropertyInspector & Global Ctrl+Z / Ctrl+Y
  useEffect(() => {
    if (!isOpen) return;
    scene3DBridge.triggerFilePicker = () => fileInputRef.current?.click();
    scene3DBridge.loadFile = loadFromFile;
    scene3DBridge.applyNumericTransform = applyNumericTransform;
    scene3DBridge.applyTransformDelta = applyTransformDelta;
    scene3DBridge.rotateModelYaw = rotateModelYaw;
    scene3DBridge.snapToGround = handleSnapToGround;
    scene3DBridge.resetModelTransform = handleResetModelTransform;
    scene3DBridge.resetCamera = handleResetCamera;
    scene3DBridge.setCameraPreset = setCameraPreset;
    scene3DBridge.applyPerspectiveDollyZoom = applyPerspectiveDollyZoom;
    scene3DBridge.applyPosePreset = handleApplyPreset;
    scene3DBridge.selectIKTarget = selectIKTarget;
    scene3DBridge.syncPerspectiveRulerNow = () => schedulePerspectiveRulerSync(true);
    scene3DBridge.bakeTo2D = handleBakeTo2D;
    scene3DBridge.extractLineAndTone = handleExtractLineAndTone;
    scene3DBridge.commitHistoryNow = commitHistoryNow;
    scene3DBridge.undo = handleUndo3D;
    scene3DBridge.redo = handleRedo3D;
    scene3DBridge.canUndo = () =>
      historyStackRef.current.canUndo() || historyDebounceTimerRef.current !== null;
    scene3DBridge.canRedo = () => historyStackRef.current.canRedo();

    return () => {
      scene3DBridge.triggerFilePicker = undefined;
      scene3DBridge.loadFile = undefined;
      scene3DBridge.applyNumericTransform = undefined;
      scene3DBridge.applyTransformDelta = undefined;
      scene3DBridge.rotateModelYaw = undefined;
      scene3DBridge.snapToGround = undefined;
      scene3DBridge.resetModelTransform = undefined;
      scene3DBridge.resetCamera = undefined;
      scene3DBridge.setCameraPreset = undefined;
      scene3DBridge.applyPerspectiveDollyZoom = undefined;
      scene3DBridge.applyPosePreset = undefined;
      scene3DBridge.selectIKTarget = undefined;
      scene3DBridge.syncPerspectiveRulerNow = undefined;
      scene3DBridge.bakeTo2D = undefined;
      scene3DBridge.extractLineAndTone = undefined;
      scene3DBridge.commitHistoryNow = undefined;
      scene3DBridge.undo = undefined;
      scene3DBridge.redo = undefined;
      scene3DBridge.canUndo = undefined;
      scene3DBridge.canRedo = undefined;
    };
  }, [
    isOpen,
    loadFromFile,
    applyNumericTransform,
    applyTransformDelta,
    rotateModelYaw,
    handleSnapToGround,
    handleResetModelTransform,
    handleResetCamera,
    setCameraPreset,
    applyPerspectiveDollyZoom,
    handleApplyPreset,
    selectIKTarget,
    schedulePerspectiveRulerSync,
    handleBakeTo2D,
    handleExtractLineAndTone,
    commitHistoryNow,
    handleUndo3D,
    handleRedo3D,
  ]);

  // Non-passive Wheel listener: Unmodified wheel dollies 3D camera; Ctrl/Meta+Wheel zooms 2D canvas
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !isOpen) return;

    const handleWheel = (e: WheelEvent) => {
      const wheelAction = resolve3DWheelAction({
        activeTool: activeToolRef.current,
        isSpaceDown: isSpaceDownRef.current,
        isReferenceVisible: use3DStore.getState().isReferenceVisible,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
      });
      if (wheelAction === 'camera-zoom') {
        e.preventDefault();
        e.stopPropagation();
        const delta = Math.sign(e.deltaY) * Math.min(80, Math.abs(e.deltaY));
        applyTransformDelta('camera-zoom', 0, delta * 0.45, false);
        scheduleDebouncedHistoryCommit();
      }
    };

    mount.addEventListener('wheel', handleWheel, { passive: false });
    return () => mount.removeEventListener('wheel', handleWheel);
  }, [isOpen, applyTransformDelta, scheduleDebouncedHistoryCommit]);

  // Arrow-key fine nudge when 3D tool is active (Arrows = move, Shift+Arrows = 15° rotate)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeToolRef.current !== '3d' || !modelRootRef.current) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      ) {
        return;
      }

      if (e.key === 'Escape') {
        if (use3DStore.getState().activeIKHandle) {
          e.preventDefault();
          selectIKTarget(null);
        }
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const model = modelRootRef.current;
        if (e.shiftKey) {
          const stepRad = THREE.MathUtils.degToRad(15);
          if (e.key === 'ArrowLeft') {
            model.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -stepRad));
          } else if (e.key === 'ArrowRight') {
            model.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), stepRad));
          } else if (e.key === 'ArrowUp') {
            model.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -stepRad));
          } else if (e.key === 'ArrowDown') {
            model.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), stepRad));
          }
          model.quaternion.normalize();
        } else {
          const step = 0.08;
          if (e.key === 'ArrowLeft') model.position.x -= step;
          if (e.key === 'ArrowRight') model.position.x += step;
          if (e.key === 'ArrowUp') model.position.y += step;
          if (e.key === 'ArrowDown') model.position.y -= step;
        }
        model.updateMatrixWorld(true);
        syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
        scheduleTransformSyncToStore();
        scheduleDebouncedHistoryCommit();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectIKTarget, scheduleTransformSyncToStore, scheduleDebouncedHistoryCommit]);

  // Capture-phase guard: Alt+Left, Middle-click, or Right-click ALWAYS suppress TransformControls so camera control never gets blocked by gizmo rings
  const handleHostPointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isInteractive) return;
    const tc = transformControlsRef.current;
    if (tc && (e.altKey || e.button !== 0)) {
      tc.enabled = false;
      gizmoSuppressedRef.current = true;
    }
  };

  // Unified deterministic Pointer Down handler (obeys resolve3DPointerAction rules)
  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isInteractive) return;

    const tc = transformControlsRef.current;
    const isGizmoHit = Boolean(tc && tc.enabled && (tc.dragging || tc.axis !== null));
    const state = use3DStore.getState();

    // Raycast IK handles & model meshes in exact canvas NDC space
    let hitIKName: string | null = null;
    let isModelHit = false;
    if (cameraRef.current && !isGizmoHit && e.button === 0 && !e.altKey) {
      const ndc = clientToNDC(e.clientX, e.clientY);
      raycasterRef.current.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), cameraRef.current);

      if (ikHandlesContainerRef.current && ikHandlesContainerRef.current.visible) {
        const ikHits = raycasterRef.current.intersectObjects(ikHandlesContainerRef.current.children, true);
        if (ikHits.length > 0) {
          const found = ikHits[0].object;
          hitIKName =
            found.userData?.ikHandleName || found.parent?.userData?.ikHandleName || null;
        }
      }

      if (!hitIKName && modelRootRef.current) {
        const modelHits = raycasterRef.current.intersectObject(modelRootRef.current, true);
        isModelHit = modelHits.some((h) => !h.object.userData?.is3DHelper);
      }
    }

    const action = resolve3DPointerAction({
      activeTool: activeToolRef.current,
      isSpaceDown: isSpaceDownRef.current,
      isReferenceVisible: state.isReferenceVisible,
      button: e.button,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      activeMode: state.activeMode,
      gizmoMode: state.gizmoMode,
      isGizmoHit,
      isIKHandleHit: Boolean(hitIKName),
      isModelHit,
      hasModel: Boolean(modelRootRef.current),
    });

    if (action === 'pass-through-2d') {
      return;
    }

    e.stopPropagation();

    if (action === 'gizmo-drag') {
      // TransformControls owns this drag cleanly
      return;
    }

    if (action === 'ik-select' && hitIKName) {
      e.preventDefault();
      selectIKTarget(hitIKName);
      return;
    }

    // Begin our unified camera/model drag
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const model = modelRootRef.current;
    canvasDragRef.current = {
      action,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
      accumYawDeg: 0,
      accumPitchDeg: 0,
      accumRollDeg: 0,
      startQuat: model ? model.quaternion.clone() : null,
      startScale: model ? model.scale.clone() : null,
      startPos: model ? model.position.clone() : null,
      totalDx: 0,
      totalDy: 0,
    };
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = canvasDragRef.current;
    if (!drag) return;

    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    drag.totalDx += dx;
    drag.totalDy += dy;

    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3) {
      drag.moved = true;
    }

    const snap = e.shiftKey || use3DStore.getState().snapEnabled;
    const model = modelRootRef.current;
    const camera = cameraRef.current;

    // Clean 15° rotation snapping relative to drag start quaternion when Shift/Snap is active
    if (
      snap &&
      model &&
      camera &&
      drag.startQuat &&
      (drag.action === 'model-rotate' ||
        drag.action === 'model-rotate-yaw' ||
        drag.action === 'model-rotate-roll')
    ) {
      const meta = viewportMetaRef.current;
      const camState = navigation
        ? navigation.getCameraState()
        : { rotation: meta.rotation, flipX: meta.flipX, flipY: meta.flipY };
      const mapped = mapScreenDeltaToCanvasDelta(
        drag.totalDx,
        drag.totalDy,
        camState.rotation,
        camState.flipX,
        camState.flipY
      );
      const degPerPx = 0.55;
      model.quaternion.copy(drag.startQuat);

      if (drag.action === 'model-rotate') {
        const yawDeg = snapAngleDeg(mapped.dx * degPerPx, 15);
        const pitchDeg = snapAngleDeg(mapped.dy * degPerPx, 15);
        const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
        const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
        model.quaternion
          .premultiply(new THREE.Quaternion().setFromAxisAngle(camUp, THREE.MathUtils.degToRad(yawDeg)))
          .premultiply(new THREE.Quaternion().setFromAxisAngle(camRight, THREE.MathUtils.degToRad(pitchDeg)))
          .normalize();
      } else if (drag.action === 'model-rotate-yaw') {
        const yawDeg = snapAngleDeg(mapped.dx * degPerPx, 15);
        model.quaternion
          .premultiply(
            new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(yawDeg))
          )
          .normalize();
      } else if (drag.action === 'model-rotate-roll') {
        const rollDeg = snapAngleDeg(mapped.dx * degPerPx, 15);
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        model.quaternion
          .premultiply(new THREE.Quaternion().setFromAxisAngle(camDir, THREE.MathUtils.degToRad(rollDeg)))
          .normalize();
      }
      model.updateMatrixWorld(true);
      syncIKHandlesToBones(mannequinBonesRef.current, ikHandlesRef.current);
      scheduleTransformSyncToStore();
      return;
    }

    if (dx !== 0 || dy !== 0) {
      applyTransformDelta(drag.action, dx, dy, snap);
    }
  };

  const handleCanvasPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (gizmoSuppressedRef.current) {
      gizmoSuppressedRef.current = false;
      syncGizmoAttachment();
    }

    const drag = canvasDragRef.current;
    if (!drag) return;

    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    // Clicking empty space (without dragging) deselects an active IK handle so model gizmo returns
    if (!drag.moved && drag.action === 'camera-orbit' && use3DStore.getState().activeIKHandle) {
      selectIKTarget(null);
    } else if (drag.moved) {
      commitHistoryNow();
    }

    canvasDragRef.current = null;
  };

  if (!isOpen) return null;

  const cursorClass = !isInteractive
    ? ''
    : activeMode.startsWith('camera') || activeMode === 'smart'
      ? 'cursor-grab active:cursor-grabbing'
      : activeMode === 'model-scale'
        ? 'cursor-nesw-resize'
        : activeMode.startsWith('model-rotate')
          ? 'cursor-crosshair'
          : 'cursor-move';

  return (
    <>
      {/* 3D WebGL Canvas Stage (pointer-events-none when drawing with 2D tools or holding Space!) */}
      <div
        ref={mountRef}
        data-testid="local-3d-stage"
        className={`absolute inset-0 z-30 select-none overflow-visible ${
          isInteractive ? 'pointer-events-auto' : 'pointer-events-none'
        }`}
        style={{
          width: `${dimensions.width}px`,
          height: `${dimensions.height}px`,
          visibility: isReferenceVisible ? 'visible' : 'hidden',
        }}
        onContextMenu={(e) => {
          if (isInteractive) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onDragOver={(e) => {
          if (!isInteractive) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
          if (!isInteractive) return;
          e.preventDefault();
          e.stopPropagation();
          const file = e.dataTransfer.files?.[0];
          if (file) {
            const name = file.name.toLowerCase();
            if (name.endsWith('.glb') || name.endsWith('.gltf') || name.endsWith('.obj')) {
              const fileKey = `${file.name}-${file.size}-${file.lastModified}`;
              loadedFileKeyRef.current = fileKey;
              loadFromFile(file);
            }
          }
        }}
      >
        <div
          ref={canvasHostRef}
          onPointerDownCapture={handleHostPointerDownCapture}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onPointerCancel={handleCanvasPointerUp}
          className={`w-full h-full block ${cursorClass}`}
          style={{ opacity }}
        />

        {webglError && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-[#202020]/95 border border-red-500/40 backdrop-blur-md rounded-lg px-5 py-4 flex flex-col items-center space-y-2.5 pointer-events-auto shadow-2xl text-center max-w-xs">
              <p className="text-xs font-medium text-red-400">3D Viewport Unavailable</p>
              <p className="text-[11px] text-[#8a8a8a] break-words">{webglError}</p>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1 bg-[#2c2c2c] hover:bg-[#383838] text-[#e5e5e5] rounded text-xs cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {/* Quick-Start Empty State (only interactive when 3D tool is active) */}
        {!webglError && !loadedModelName && is3DToolActive && isReferenceVisible && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div
              className="bg-[#202020]/95 border border-white/[0.1] backdrop-blur-md rounded-lg px-5 py-4 flex flex-col items-center space-y-3 pointer-events-auto shadow-2xl text-center w-64"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="w-9 h-9 rounded-md bg-[#161616] border border-white/[0.08] flex items-center justify-center text-[var(--accent)]">
                <Box className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-medium text-[#e5e5e5]">3D Reference Stage</p>
                <p className="text-[11px] text-[#8a8a8a] mt-1">
                  Drop a .glb, .gltf, or .obj 3D model here to begin.
                </p>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 rounded text-xs font-medium transition-opacity cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>Import 3D Model</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Compact On-Canvas Floating 3D Bar & Separate LT Preview Modal (Rendered via Portal) */}
      {createPortal(
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".glb,.gltf,.obj"
            className="hidden"
            onChange={handleFileUpload}
          />
          <Csp3DToolbar
            is3DToolActive={is3DToolActive}
            onActivate3DTool={() => toolStoreActions.selectTool('3d')}
            onDirectDrag={(mode, dx, dy, snap) => applyTransformDelta(mode, dx, dy, snap)}
            onDirectDragEnd={commitHistoryNow}
            onTriggerImport={() => fileInputRef.current?.click()}
            onSnapToGround={handleSnapToGround}
            onUndo={() => {
              handleUndo3D();
            }}
            onRedo={() => {
              handleRedo3D();
            }}
            onOpenLTModal={() => setIsLTModalOpen(true)}
            isLTModalOpen={isLTModalOpen}
            onBakeTo2D={(closeAfter) => {
              void handleBakeTo2D(closeAfter);
            }}
            onClose={onClose}
          />
          <LTExtractionModal
            isOpen={isLTModalOpen}
            modelName={loadedModelName || '3D Model'}
            dimensions={dimensions}
            isExtracting={isBaking}
            onRenderPreview={handleRenderLTPreview}
            onExtract={(settings) => {
              void handleExtractLineAndTone(settings);
            }}
            onClose={() => setIsLTModalOpen(false)}
          />
        </>,
        document.body
      )}
    </>
  );
};
