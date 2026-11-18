import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LayerItem, LTConversionSettings } from '../types/editor';
import { PerspectiveRuler } from '../types/perspective';
import { calculatePerspectiveFromCamera } from '../utils/perspectiveMath';
import { bake3DToRasterLayer, bake3DToLineAndTone, disposeThreeResources } from '../services/bake3DService';
import {
  createProceduralMannequin,
  findHumanoidBones,
  solveTwoBoneIK,
  createIKHandles,
  applyPosePreset,
  HumanoidBones,
  PosePresetName,
} from '../utils/mannequin3D';
import { Csp3DToolbar, Csp3DToolMode } from './Csp3DToolbar';
import { LightSourceWidget, LightSettings } from './LightSourceWidget';
import {
  Sun,
  Layers,
  RotateCcw,
  CheckCircle2,
  X,
  Upload,
  Grid,
  Camera,
  Compass,
  Move,
  Rotate3d,
  User,
  Sliders,
  Sparkles,
  Link,
} from 'lucide-react';

export type ShadingMode = 'shaded' | 'smooth' | 'silhouette';
export type GizmoMode = 'none' | 'rotate' | 'translate';

export interface Local3DContainerProps {
  dimensions: { width: number; height: number };
  zoom?: number;
  pan?: { x: number; y: number };
  rotation?: number;
  isOpen: boolean;
  initialFile?: File | null;
  onClose: () => void;
  onInsertRasterLayer: (layer: LayerItem, canvas: HTMLCanvasElement) => void;
  onBakeSuccess?: (layer: LayerItem) => void;
  perspectiveRuler?: PerspectiveRuler | null;
  onUpdatePerspectiveRuler?: (ruler: PerspectiveRuler | null) => void;
}

export const Local3DContainer: React.FC<Local3DContainerProps> = ({
  dimensions,
  zoom: _zoom,
  pan: _pan,
  rotation: _rotation = 0,
  isOpen,
  initialFile,
  onClose,
  onInsertRasterLayer,
  onBakeSuccess,
  perspectiveRuler,
  onUpdatePerspectiveRuler,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadedFileKeyRef = useRef<string | null>(null);

  // Local Three.js state references
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const transformControlsRef = useRef<TransformControls | null>(null);
  const transformHelperRef = useRef<THREE.Object3D | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const modelRootRef = useRef<THREE.Group | null>(null);
  const keyLightRef = useRef<THREE.DirectionalLight | null>(null);
  const ambientLightRef = useRef<THREE.AmbientLight | null>(null);
  const hemiLightRef = useRef<THREE.HemisphereLight | null>(null);
  const gridHelperRef = useRef<THREE.GridHelper | null>(null);
  const mannequinBonesRef = useRef<HumanoidBones | null>(null);
  const ikHandlesRef = useRef<Record<string, THREE.Mesh> | null>(null);
  const ikHandlesContainerRef = useRef<THREE.Group | null>(null);

  // Interaction State
  const [activeToolMode, setActiveToolMode] = useState<Csp3DToolMode>('camera-orbit');
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('none');
  const [showGrid, setShowGrid] = useState<boolean>(true);
  const [showLightPanel, setShowLightPanel] = useState<boolean>(false);
  const [showCameraPresets, setShowCameraPresets] = useState<boolean>(false);
  const [isMannequinActive, setIsMannequinActive] = useState<boolean>(false);
  const [showPoseDrawer, setShowPoseDrawer] = useState<boolean>(false);
  const [showLTModal, setShowLTModal] = useState<boolean>(false);
  const [syncCameraPerspective, setSyncCameraPerspective] = useState<boolean>(true);
  const syncCameraPerspectiveRef = useRef<boolean>(syncCameraPerspective);
  syncCameraPerspectiveRef.current = syncCameraPerspective;
  const onUpdatePerspectiveRulerRef = useRef(onUpdatePerspectiveRuler);
  onUpdatePerspectiveRulerRef.current = onUpdatePerspectiveRuler;
  const perspectiveRulerRef = useRef(perspectiveRuler);
  perspectiveRulerRef.current = perspectiveRuler;
  const [activeIKHandle, setActiveIKHandle] = useState<string | null>(null);
  const [ltLineThreshold, setLtLineThreshold] = useState<number>(0.28);
  const [ltToneBands, setLtToneBands] = useState<2 | 3>(2);

  // Viewport Settings
  const [opacity, setOpacity] = useState<number>(0.85);
  const [shadingMode, setShadingMode] = useState<ShadingMode>('shaded');
  const [perspective, setPerspective] = useState<number>(1.0); // 0.2 to 2.5 (Dolly Zoom)
  const [isBaking, setIsBaking] = useState<boolean>(false);
  const [loadedFileName, setLoadedFileName] = useState<string | null>(null);

  // Light Source Settings
  const [lightSettings, setLightSettings] = useState<LightSettings>({
    azimuth: 45,
    elevation: 45,
    intensity: 1.5,
    ambientIntensity: 0.65,
    color: '#ffffff',
    isBacklit: false,
  });

  // Drag interaction state on canvas
  const canvasDragRef = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    button: number;
  } | null>(null);

  // Traverse and dispose cached procedural 3D materials and smoothed geometries
  const disposeMeshUserData = useCallback((obj: THREE.Object3D) => {
    obj.traverse((child) => {
      const m = child as THREE.Mesh;
      if (m.isMesh) {
        if (m.userData.smoothGeometry) {
          m.userData.smoothGeometry.dispose();
          m.userData.smoothGeometry = null;
        }
        if (m.userData.silhouetteMaterial) {
          m.userData.silhouetteMaterial.dispose();
          m.userData.silhouetteMaterial = null;
        }
        if (m.userData.smoothMaterial) {
          if (Array.isArray(m.userData.smoothMaterial)) {
            m.userData.smoothMaterial.forEach((mat: THREE.Material) => mat.dispose());
          } else {
            m.userData.smoothMaterial.dispose();
          }
          m.userData.smoothMaterial = null;
        }
      }
    });
  }, []);

  // Apply visual shading mode: Shaded, Advanced Smooth Shading, or Silhouette
  const applyShading = useCallback((mode: ShadingMode) => {
    if (!modelRootRef.current) return;

    modelRootRef.current.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;

      if (!mesh.userData.origGeometry) {
        mesh.userData.origGeometry = mesh.geometry;
      }
      if (!mesh.userData.origMaterial) {
        mesh.userData.origMaterial = mesh.material;
      }

      if (mode === 'silhouette') {
        if (mesh.userData.origGeometry && mesh.geometry !== mesh.userData.origGeometry) {
          mesh.geometry = mesh.userData.origGeometry;
        }
        if (!mesh.userData.silhouetteMaterial) {
          mesh.userData.silhouetteMaterial = new THREE.MeshBasicMaterial({
            color: 0x111827,
          });
        }
        mesh.material = mesh.userData.silhouetteMaterial;
      } else if (mode === 'smooth') {
        // 1. Advanced Geometry Normal Smoothing (vertex welding + creased normals)
        if (!mesh.userData.smoothGeometry && mesh.userData.origGeometry) {
          try {
            const merged = BufferGeometryUtils.mergeVertices(mesh.userData.origGeometry.clone(), 1e-4);
            mesh.userData.smoothGeometry = BufferGeometryUtils.toCreasedNormals(merged, (55 * Math.PI) / 180);
          } catch (err) {
            console.warn('[3D] Smooth geometry calculation fallback:', err);
            const fallback = mesh.userData.origGeometry.clone();
            fallback.computeVertexNormals();
            mesh.userData.smoothGeometry = fallback;
          }
        }

        if (mesh.userData.smoothGeometry) {
          mesh.geometry = mesh.userData.smoothGeometry;
        }

        // 2. Material Smoothing with studio PBR highlights
        const makeSmoothMat = (mat: THREE.Material): THREE.Material => {
          const smooth = mat.clone();
          if ('flatShading' in smooth) {
            (smooth as any).flatShading = false;
          }
          if ('roughness' in smooth && typeof (smooth as any).roughness === 'number') {
            (smooth as any).roughness = Math.max(0.2, (smooth as any).roughness * 0.9);
          }
          smooth.needsUpdate = true;
          return smooth;
        };

        if (!mesh.userData.smoothMaterial) {
          if (mesh.userData.hasCustomMaterial && mesh.userData.origMaterial) {
            if (Array.isArray(mesh.userData.origMaterial)) {
              mesh.userData.smoothMaterial = mesh.userData.origMaterial.map(makeSmoothMat);
            } else {
              mesh.userData.smoothMaterial = makeSmoothMat(mesh.userData.origMaterial);
            }
          } else {
            mesh.userData.smoothMaterial = new THREE.MeshStandardMaterial({
              color: 0xdee2e6,
              roughness: 0.32,
              metalness: 0.05,
              flatShading: false,
            });
          }
        }
        mesh.material = mesh.userData.smoothMaterial;
      } else {
        // 'shaded' mode: Restore original geometry and material
        if (mesh.userData.origGeometry && mesh.geometry !== mesh.userData.origGeometry) {
          mesh.geometry = mesh.userData.origGeometry;
        }

        if (mesh.userData.origMaterial && mesh.userData.hasCustomMaterial) {
          mesh.material = mesh.userData.origMaterial;
        } else {
          mesh.material = new THREE.MeshStandardMaterial({
            color: 0xe2e8f0,
            roughness: 0.35,
            metalness: 0.1,
          });
        }
      }
    });
  }, []);

  // Update TransformControls attachment when model changes
  const updateGizmoTarget = useCallback(() => {
    if (!transformControlsRef.current) return;
    if (modelRootRef.current && gizmoMode !== 'none') {
      transformControlsRef.current.attach(modelRootRef.current);
      if (transformHelperRef.current) transformHelperRef.current.visible = true;
    } else {
      transformControlsRef.current.detach();
      if (transformHelperRef.current) transformHelperRef.current.visible = false;
    }
  }, [gizmoMode]);

  // Initialize Three.js scene strictly locally with clamped resolution
  useEffect(() => {
    if (!isOpen || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const docAspect = dimensions.width / Math.max(1, dimensions.height);

    const MAX_PREVIEW = 1920;
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

    canvas.width = previewW;
    canvas.height = previewH;

    // 1. Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // 2. Perspective Camera
    const camera = new THREE.PerspectiveCamera(45, docAspect, 0.05, 500);
    camera.position.set(0, 0.5, 3.8);
    cameraRef.current = camera;

    // 3. WebGL Renderer
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    renderer.setSize(previewW, previewH, false);
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    rendererRef.current = renderer;

    // 4. Ground Grid Helper (Clip Studio Paint style floor grid)
    const gridHelper = new THREE.GridHelper(8, 16, 0x3b82f6, 0x334155);
    gridHelper.position.y = 0;
    scene.add(gridHelper);
    gridHelperRef.current = gridHelper;

    // 5. Lighting Setup
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x475569, 0.7);
    scene.add(hemiLight);
    hemiLightRef.current = hemiLight;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambientLight);
    ambientLightRef.current = ambientLight;

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
    keyLight.position.set(2.5, 4, 3);
    scene.add(keyLight);
    keyLightRef.current = keyLight;

    const rimLight = new THREE.DirectionalLight(0x60a5fa, 0.6);
    rimLight.position.set(-3, 2, -3);
    scene.add(rimLight);

    // 6. OrbitControls for navigation
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0.3, 0);
    controls.addEventListener('change', () => {
      if (syncCameraPerspectiveRef.current && onUpdatePerspectiveRulerRef.current && cameraRef.current) {
        const ruler = calculatePerspectiveFromCamera(
          cameraRef.current,
          dimensions.width,
          dimensions.height,
          perspectiveRulerRef.current
        );
        onUpdatePerspectiveRulerRef.current(ruler);
      }
    });
    controlsRef.current = controls;

    // 7. TransformControls for 3D In-Scene Gizmo Rings
    const transformControls = new TransformControls(camera, canvas);
    transformControls.size = 0.85;
    transformControls.setSpace('local');
    const transformHelper = transformControls.getHelper();
    transformHelper.visible = false;
    scene.add(transformHelper);

    transformControls.addEventListener('dragging-changed', (event: any) => {
      if (controlsRef.current) {
        controlsRef.current.enabled = !event.value;
      }
    });

    transformControls.addEventListener('objectChange', () => {
      const targetObj = transformControls.object;
      if (targetObj && targetObj.name.startsWith('IKHandle_') && mannequinBonesRef.current) {
        const handleName = targetObj.name.replace('IKHandle_', '');
        const bones = mannequinBonesRef.current;
        const targetPos = targetObj.position;
        if (handleName === 'leftHand' && bones.leftUpperArm && bones.leftLowerArm && bones.leftHand) {
          solveTwoBoneIK(bones.leftUpperArm, bones.leftLowerArm, bones.leftHand, targetPos, new THREE.Vector3(0.6, 1.2, -0.4));
        } else if (handleName === 'rightHand' && bones.rightUpperArm && bones.rightLowerArm && bones.rightHand) {
          solveTwoBoneIK(bones.rightUpperArm, bones.rightLowerArm, bones.rightHand, targetPos, new THREE.Vector3(-0.6, 1.2, -0.4));
        } else if (handleName === 'leftFoot' && bones.leftUpperLeg && bones.leftLowerLeg && bones.leftFoot) {
          solveTwoBoneIK(bones.leftUpperLeg, bones.leftLowerLeg, bones.leftFoot, targetPos, new THREE.Vector3(0.12, 0.48, 0.5));
        } else if (handleName === 'rightFoot' && bones.rightUpperLeg && bones.rightLowerLeg && bones.rightFoot) {
          solveTwoBoneIK(bones.rightUpperLeg, bones.rightLowerLeg, bones.rightFoot, targetPos, new THREE.Vector3(-0.12, 0.48, 0.5));
        } else if (handleName === 'head' && bones.neck && bones.head) {
          bones.head.lookAt(targetPos);
          bones.head.updateMatrixWorld(true);
        }
      }
    });

    transformControlsRef.current = transformControls;
    transformHelperRef.current = transformHelper;

    // 8. Render Loop
    let running = true;
    const animate = () => {
      if (!running) return;
      try {
        controls.update();
        renderer.render(scene, camera);
      } catch (err) {
        console.warn('[3D Render Loop Error]:', err);
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

    return () => {
      running = false;
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      if (modelRootRef.current) {
        disposeMeshUserData(modelRootRef.current);
      }
      transformControls.dispose();
      controls.dispose();
      disposeThreeResources(scene, renderer);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      controlsRef.current = null;
      transformControlsRef.current = null;
      transformHelperRef.current = null;
      modelRootRef.current = null;
      loadedFileKeyRef.current = null;
    };
  }, [isOpen, dimensions.width, dimensions.height, disposeMeshUserData]);

  // Synchronize Gizmo Mode (Rotate, Translate, None)
  useEffect(() => {
    if (!transformControlsRef.current || !transformHelperRef.current) return;
    if (gizmoMode === 'none') {
      transformControlsRef.current.detach();
      transformHelperRef.current.visible = false;
    } else {
      transformControlsRef.current.setMode(gizmoMode);
      if (modelRootRef.current) {
        transformControlsRef.current.attach(modelRootRef.current);
        transformHelperRef.current.visible = true;
      }
    }
  }, [gizmoMode]);

  // Synchronize Floor Grid Visibility
  useEffect(() => {
    if (gridHelperRef.current) {
      gridHelperRef.current.visible = showGrid;
    }
  }, [showGrid]);

  // Synchronize Key Light & Ambient Light from lightSettings
  useEffect(() => {
    if (keyLightRef.current) {
      const az = (lightSettings.azimuth * Math.PI) / 180;
      const el = (lightSettings.elevation * Math.PI) / 180;
      const dist = 5;
      const y = Math.sin(el) * dist;
      const hyp = Math.cos(el) * dist;
      const x = Math.sin(az) * hyp;
      const z = (lightSettings.isBacklit ? -1 : 1) * Math.cos(az) * hyp;

      keyLightRef.current.position.set(x, y, z);
      keyLightRef.current.intensity = lightSettings.intensity * 1.5;
      keyLightRef.current.color.set(lightSettings.color);
    }
    if (ambientLightRef.current) {
      ambientLightRef.current.intensity = lightSettings.ambientIntensity * 0.65;
    }
    if (hemiLightRef.current) {
      hemiLightRef.current.intensity = lightSettings.ambientIntensity * 0.5;
    }
  }, [lightSettings]);

  // Execute unified 3D Transformation (used by both direct toolbar drag & canvas drag)
  const applyTransformDelta = useCallback(
    (mode: Csp3DToolMode, deltaX: number, deltaY: number) => {
      const camera = cameraRef.current;
      const model = modelRootRef.current;
      const controls = controlsRef.current;
      if (!camera || !controls) return;

      switch (mode) {
        case 'camera-orbit': {
          const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
          const spherical = new THREE.Spherical().setFromVector3(offset);
          const orbitSpeed = 0.007;
          spherical.theta -= deltaX * orbitSpeed;
          spherical.phi = Math.max(0.01, Math.min(Math.PI - 0.01, spherical.phi - deltaY * orbitSpeed));
          offset.setFromSpherical(spherical);
          camera.position.copy(controls.target).add(offset);
          camera.lookAt(controls.target);
          controls.update();
          break;
        }

        case 'camera-pan': {
          const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
          const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
          const dist = camera.position.distanceTo(controls.target);
          const panSpeed = 0.0014 * dist;

          const panOffset = new THREE.Vector3()
            .addScaledVector(camRight, -deltaX * panSpeed)
            .addScaledVector(camUp, deltaY * panSpeed);

          camera.position.add(panOffset);
          controls.target.add(panOffset);
          controls.update();
          break;
        }

        case 'camera-zoom': {
          const zoomSpeed = 0.012;
          const toTarget = new THREE.Vector3().subVectors(camera.position, controls.target);
          const currentDist = toTarget.length();
          const newDist = Math.max(0.4, Math.min(50, currentDist * (1 + deltaY * zoomSpeed)));
          toTarget.setLength(newDist);
          camera.position.copy(controls.target).add(toTarget);
          controls.update();
          break;
        }

        case 'model-move': {
          if (!model) return;
          const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
          const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
          const dist = camera.position.distanceTo(model.position);
          const moveSpeed = 0.0016 * dist;

          model.position.addScaledVector(camRight, deltaX * moveSpeed);
          model.position.addScaledVector(camUp, -deltaY * moveSpeed);
          break;
        }

        case 'model-rotate-free': {
          if (!model) return;
          const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
          const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
          const rotSpeed = 0.008;

          const qYaw = new THREE.Quaternion().setFromAxisAngle(camUp, deltaX * rotSpeed);
          const qPitch = new THREE.Quaternion().setFromAxisAngle(camRight, deltaY * rotSpeed);

          model.quaternion.premultiply(qYaw).premultiply(qPitch);
          break;
        }

        case 'model-rotate-yaw': {
          if (!model) return;
          const worldUp = new THREE.Vector3(0, 1, 0);
          const rotSpeed = 0.01;
          const q = new THREE.Quaternion().setFromAxisAngle(worldUp, deltaX * rotSpeed);
          model.quaternion.premultiply(q);
          break;
        }

        case 'model-rotate-roll': {
          if (!model) return;
          const camDir = new THREE.Vector3();
          camera.getWorldDirection(camDir);
          const rotSpeed = 0.01;
          const q = new THREE.Quaternion().setFromAxisAngle(camDir, deltaX * rotSpeed);
          model.quaternion.premultiply(q);
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
          const planeSpeed = 0.002 * dist;

          model.position.addScaledVector(right, deltaX * planeSpeed);
          model.position.addScaledVector(forward, -deltaY * planeSpeed);
          break;
        }
      }
    },
    []
  );

  // Magnet Action: Drop model flush to floor plane Y=0 (Clip Studio Paint style)
  const handleSnapToGround = useCallback(() => {
    if (!modelRootRef.current) return;
    modelRootRef.current.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(modelRootRef.current);
    if (Number.isFinite(box.min.y)) {
      modelRootRef.current.position.y -= box.min.y;
      modelRootRef.current.updateMatrixWorld(true);
    }
  }, []);

  // Reset Model Transform: Position (0, 0.3, 0), zero rotation
  const handleResetModelTransform = useCallback(() => {
    if (!modelRootRef.current) return;
    modelRootRef.current.position.set(0, 0.3, 0);
    modelRootRef.current.quaternion.identity();
    modelRootRef.current.scale.set(1, 1, 1);
    modelRootRef.current.updateMatrixWorld(true);
  }, []);

  // Perspective (Dolly Zoom) Adjustment (Clip Studio Paint style perspective distortion)
  const applyPerspectiveDollyZoom = useCallback((factor: number) => {
    if (!cameraRef.current || !controlsRef.current) return;
    const camera = cameraRef.current;
    const controls = controlsRef.current;

    const baseFovRad = (45 * Math.PI) / 180;
    const newTan = factor * Math.tan(baseFovRad / 2);
    const newFovDeg = Math.min(105, Math.max(15, (2 * Math.atan(newTan) * 180) / Math.PI));

    const toTarget = new THREE.Vector3().subVectors(camera.position, controls.target);
    const currentDist = toTarget.length();
    const oldFovRad = (camera.fov * Math.PI) / 360;
    const newFovRad = (newFovDeg * Math.PI) / 360;

    const targetDist = Math.max(0.5, (currentDist * Math.tan(oldFovRad)) / Math.tan(newFovRad));
    toTarget.setLength(targetDist);

    camera.position.copy(controls.target).add(toTarget);
    camera.fov = newFovDeg;
    camera.updateProjectionMatrix();
    controls.update();

    setPerspective(factor);
  }, []);

  // Camera Angle Presets
  const setCameraPreset = useCallback(
    (presetName: 'front' | 'side' | 'top' | 'threeQuarter' | 'lowAngle' | 'back') => {
      if (!cameraRef.current || !controlsRef.current) return;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      const target = controls.target.clone();
      const dist = 3.8;

      switch (presetName) {
        case 'front':
          camera.position.set(target.x, target.y + 0.2, target.z + dist);
          break;
        case 'side':
          camera.position.set(target.x - dist, target.y + 0.2, target.z);
          break;
        case 'top':
          camera.position.set(target.x, target.y + dist, target.z + 0.05);
          break;
        case 'threeQuarter':
          camera.position.set(target.x + dist * 0.7, target.y + dist * 0.45, target.z + dist * 0.7);
          break;
        case 'lowAngle':
          camera.position.set(target.x + dist * 0.5, target.y - dist * 0.35, target.z + dist * 0.8);
          break;
        case 'back':
          camera.position.set(target.x, target.y + 0.2, target.z - dist);
          break;
      }
      camera.lookAt(target);
      controls.update();
      setShowCameraPresets(false);
    },
    []
  );

  // Quick Model Yaw Rotations
  const rotateModelYaw = useCallback((degrees: number) => {
    if (!modelRootRef.current) return;
    const rad = (degrees * Math.PI) / 180;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rad);
    modelRootRef.current.quaternion.premultiply(q);
  }, []);

  // Canvas Pointer Events: Route dragging based on CSP active tool
  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const isModelMode =
      activeToolMode === 'model-move' ||
      activeToolMode === 'model-rotate-free' ||
      activeToolMode === 'model-rotate-yaw' ||
      activeToolMode === 'model-rotate-roll' ||
      activeToolMode === 'model-plane-move';

    // If active tool is a model transform or if not left-clicking, handle accordingly
    if (isModelMode && e.button === 0) {
      if (controlsRef.current) controlsRef.current.enabled = false;
      const canvas = canvasRef.current;
      if (canvas) canvas.setPointerCapture(e.pointerId);

      canvasDragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        button: e.button,
      };
    } else {
      // Camera mode: let OrbitControls manage it, but ensure enabled
      if (controlsRef.current) controlsRef.current.enabled = true;
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canvasDragRef.current) return;
    const dx = e.clientX - canvasDragRef.current.lastX;
    const dy = e.clientY - canvasDragRef.current.lastY;
    canvasDragRef.current.lastX = e.clientX;
    canvasDragRef.current.lastY = e.clientY;

    if (dx !== 0 || dy !== 0) {
      applyTransformDelta(activeToolMode, dx, dy);
    }
  };

  const handleCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (canvasDragRef.current) {
      try {
        canvasRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      canvasDragRef.current = null;
      if (controlsRef.current) controlsRef.current.enabled = true;
    }
  };

  // Handle Loading 3D Model from File (.glb, .gltf, .obj)
  const loadFromFile = useCallback(
    (file: File) => {
      if (!sceneRef.current) return;

      const fileName = file.name.toLowerCase();

      const fitAndAttach = (model: THREE.Group | THREE.Object3D) => {
        if (modelRootRef.current && sceneRef.current) {
          if (transformControlsRef.current) transformControlsRef.current.detach();
          disposeMeshUserData(modelRootRef.current);
          disposeThreeResources(modelRootRef.current, null);
          sceneRef.current.remove(modelRootRef.current);
          modelRootRef.current = null;
        }

        const toRemove: THREE.Object3D[] = [];
        model.traverse((child) => {
          if ((child as any).isCamera || (child as any).isLight) {
            toRemove.push(child);
          }
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh && mesh.material) {
            mesh.userData.origGeometry = mesh.geometry;
            mesh.userData.origMaterial = mesh.material;
            mesh.userData.hasCustomMaterial = true;

            if (Array.isArray(mesh.material)) {
              mesh.material.forEach((m) => {
                m.side = THREE.DoubleSide;
                if ((m as any).transmission !== undefined && (m as any).transmission > 0) {
                  m.transparent = true;
                  if (m.opacity < 0.25) m.opacity = 0.85;
                }
              });
            } else {
              mesh.material.side = THREE.DoubleSide;
              if ((mesh.material as any).transmission !== undefined && (mesh.material as any).transmission > 0) {
                mesh.material.transparent = true;
                if (mesh.material.opacity < 0.25) mesh.material.opacity = 0.85;
              }
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
        const targetDim = 2.4;
        const scale = Number.isFinite(maxDim) && maxDim > 0.0001 ? targetDim / maxDim : 1;

        const wrapper = new THREE.Group();
        model.position.set(-center.x, -center.y, -center.z);
        wrapper.scale.setScalar(scale);
        wrapper.position.set(0, 0.3, 0);
        wrapper.add(model);

        modelRootRef.current = wrapper;
        if (sceneRef.current) {
          sceneRef.current.add(wrapper);
        }
        setLoadedFileName(file.name);
        applyShading(shadingMode);
        updateGizmoTarget();

        // Detect humanoid skinned mesh hierarchy
        if (ikHandlesContainerRef.current && sceneRef.current) {
          disposeThreeResources(ikHandlesContainerRef.current, null);
          sceneRef.current.remove(ikHandlesContainerRef.current);
          ikHandlesContainerRef.current = null;
          ikHandlesRef.current = null;
        }
        const detectedBones = findHumanoidBones(model);
        if (detectedBones.hips || detectedBones.leftHand || detectedBones.rightHand || detectedBones.head) {
          mannequinBonesRef.current = detectedBones;
          setIsMannequinActive(true);
          const { container: handlesContainer, handles } = createIKHandles();
          ikHandlesRef.current = handles;
          ikHandlesContainerRef.current = handlesContainer;
          sceneRef.current?.add(handlesContainer);
        } else {
          mannequinBonesRef.current = null;
          setIsMannequinActive(false);
        }

        if (cameraRef.current && controlsRef.current) {
          cameraRef.current.position.set(0, 0.5, 3.8);
          controlsRef.current.target.set(0, 0.3, 0);
          controlsRef.current.update();
        }
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
    [applyShading, disposeMeshUserData, shadingMode, updateGizmoTarget]
  );

  useEffect(() => {
    if (initialFile && isOpen && sceneRef.current) {
      const fileKey = `${initialFile.name}-${initialFile.size}-${initialFile.lastModified}`;
      if (loadedFileKeyRef.current !== fileKey) {
        loadedFileKeyRef.current = fileKey;
        loadFromFile(initialFile);
      }
    }
  }, [initialFile, isOpen, loadFromFile]);

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

  const handleResetCamera = () => {
    if (!cameraRef.current || !controlsRef.current) return;
    cameraRef.current.position.set(0, 0.5, 3.8);
    cameraRef.current.fov = 45;
    cameraRef.current.updateProjectionMatrix();
    controlsRef.current.target.set(0, 0.3, 0);
    controlsRef.current.update();
    setPerspective(1.0);
  };

  // Load procedural humanoid drawing mannequin
  const loadProceduralMannequin = useCallback(() => {
    if (!sceneRef.current) return;
    if (modelRootRef.current) {
      if (transformControlsRef.current) transformControlsRef.current.detach();
      disposeMeshUserData(modelRootRef.current);
      disposeThreeResources(modelRootRef.current, null);
      sceneRef.current.remove(modelRootRef.current);
      modelRootRef.current = null;
    }
    if (ikHandlesContainerRef.current) {
      disposeThreeResources(ikHandlesContainerRef.current, null);
      sceneRef.current.remove(ikHandlesContainerRef.current);
      ikHandlesContainerRef.current = null;
      ikHandlesRef.current = null;
    }

    const { group, bones } = createProceduralMannequin();
    const { container: handlesContainer, handles } = createIKHandles();

    mannequinBonesRef.current = bones;
    ikHandlesRef.current = handles;
    ikHandlesContainerRef.current = handlesContainer;

    group.position.set(0, 0, 0);
    modelRootRef.current = group;
    sceneRef.current.add(group);
    sceneRef.current.add(handlesContainer);

    setLoadedFileName('Mannequin (Rigged)');
    setIsMannequinActive(true);
    applyShading(shadingMode);

    if (cameraRef.current && controlsRef.current) {
      cameraRef.current.position.set(0, 1.1, 3.2);
      controlsRef.current.target.set(0, 0.9, 0);
      controlsRef.current.update();
    }
  }, [applyShading, disposeMeshUserData, shadingMode]);

  // Select an IK Target limb to manipulate
  const selectIKTarget = useCallback((targetName: string | null) => {
    setActiveIKHandle(targetName);
    if (!transformControlsRef.current || !ikHandlesRef.current) return;
    if (targetName && ikHandlesRef.current[targetName]) {
      const handleMesh = ikHandlesRef.current[targetName];
      transformControlsRef.current.setMode('translate');
      transformControlsRef.current.attach(handleMesh);
      if (transformHelperRef.current) transformHelperRef.current.visible = true;
    } else {
      transformControlsRef.current.detach();
      if (transformHelperRef.current) transformHelperRef.current.visible = false;
    }
  }, []);

  // Apply Pose Presets (Standing, Action, Sitting, Fists, Relaxed Palm)
  const handleApplyPreset = useCallback((preset: PosePresetName) => {
    if (!mannequinBonesRef.current) return;
    applyPosePreset(mannequinBonesRef.current, preset);
    if (ikHandlesRef.current) {
      const updateHandle = (name: string, bone?: THREE.Bone) => {
        if (bone && ikHandlesRef.current![name]) {
          const wp = new THREE.Vector3();
          bone.getWorldPosition(wp);
          ikHandlesRef.current![name].position.copy(wp);
        }
      };
      updateHandle('head', mannequinBonesRef.current.head);
      updateHandle('leftHand', mannequinBonesRef.current.leftHand);
      updateHandle('rightHand', mannequinBonesRef.current.rightHand);
      updateHandle('leftFoot', mannequinBonesRef.current.leftFoot);
      updateHandle('rightFoot', mannequinBonesRef.current.rightFoot);
    }
  }, []);

  // 3D LT Lineart & Screentone Extraction (3D-to-2D Line Extraction)
  const handleExtractLineAndTone = async (settings?: LTConversionSettings) => {
    if (!sceneRef.current || !cameraRef.current || !modelRootRef.current || isBaking) return;
    setIsBaking(true);
    setShowLTModal(false);

    try {
      if (transformHelperRef.current) transformHelperRef.current.visible = false;
      if (gridHelperRef.current) gridHelperRef.current.visible = false;
      if (ikHandlesContainerRef.current) ikHandlesContainerRef.current.visible = false;

      const effectiveLineWidth = settings?.lineWidth ?? 1;
      const effectiveThreshold = settings?.lineThreshold ?? ltLineThreshold;
      const effectiveToneCount = settings?.toneCount ?? ltToneBands;
      const modelDisplayName = loadedFileName
        ? loadedFileName.replace(/\.[^/.]+$/, '')
        : isMannequinActive
        ? 'Mannequin'
        : '3D Model';
      const targetFolderName = settings?.folderName?.trim() || `3D Extraction [${modelDisplayName}]`;

      await bake3DToLineAndTone({
        scene: sceneRef.current,
        camera: cameraRef.current,
        dimensions,
        activeRenderer: rendererRef.current,
        modelName: modelDisplayName,
        targetFolderName,
        lineWidth: effectiveLineWidth,
        lineThreshold: effectiveThreshold,
        toneCount: effectiveToneCount,
        antiAliasing: true,
        disposeOnComplete: true,
        onInsertLayers: (layers, canvases) => {
          // Insert in reverse order so folder layer ends up at top in layer list
          for (let i = layers.length - 1; i >= 0; i--) {
            onInsertRasterLayer(layers[i], canvases[i]);
          }
        },
      });

      onClose();
    } catch (err) {
      console.error('[3D] Failed to extract line & tone:', err);
      setIsBaking(false);
      if (gridHelperRef.current) gridHelperRef.current.visible = showGrid;
      if (transformHelperRef.current && gizmoMode !== 'none') transformHelperRef.current.visible = true;
      if (ikHandlesContainerRef.current) ikHandlesContainerRef.current.visible = true;
    }
  };

  // Bake 3D to 2D Layer (Ensuring Gizmos & Grids are NOT baked into layer)
  const handleBakeTo2D = async () => {
    if (!sceneRef.current || !cameraRef.current || !modelRootRef.current || isBaking) return;
    setIsBaking(true);

    try {
      // Temporarily hide helper gizmo, ground grid, and IK handles
      if (transformHelperRef.current) transformHelperRef.current.visible = false;
      if (gridHelperRef.current) gridHelperRef.current.visible = false;
      if (ikHandlesContainerRef.current) ikHandlesContainerRef.current.visible = false;

      const result = await bake3DToRasterLayer({
        scene: sceneRef.current,
        camera: cameraRef.current,
        dimensions,
        activeRenderer: rendererRef.current,
        layerName: loadedFileName ? `3D (${loadedFileName})` : '3D Model',
        opacity,
        blendMode: 'normal',
        onInsertLayer: (layer, rasterCanvas) => {
          onInsertRasterLayer(layer, rasterCanvas);
        },
      });

      onBakeSuccess?.(result.layer);
      onClose();
    } catch (err) {
      console.error('[3D] Failed to rasterize 3D layer:', err);
      setIsBaking(false);
      if (gridHelperRef.current) gridHelperRef.current.visible = showGrid;
      if (transformHelperRef.current && gizmoMode !== 'none') transformHelperRef.current.visible = true;
      if (ikHandlesContainerRef.current) ikHandlesContainerRef.current.visible = true;
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* 3D WebGL Canvas Layer */}
      <div
        ref={mountRef}
        className="absolute inset-0 pointer-events-auto z-30 select-none overflow-visible"
        style={{
          width: `${dimensions.width}px`,
          height: `${dimensions.height}px`,
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onDrop={(e) => {
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
        <canvas
          ref={canvasRef}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          className={`w-full h-full block ${
            activeToolMode.startsWith('camera')
              ? 'cursor-grab active:cursor-grabbing'
              : activeToolMode === 'model-rotate-free'
              ? 'cursor-crosshair'
              : 'cursor-move'
          }`}
          style={{
            opacity,
            imageRendering: 'auto',
          }}
        />

        {/* Empty state prompt if no model is loaded */}
        {!loadedFileName && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-[#181b20]/90 border border-white/10 backdrop-blur-md rounded-xl px-8 py-6 flex flex-col items-center space-y-3 pointer-events-auto shadow-2xl text-center">
              <div className="w-12 h-12 rounded-full bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-400">
                <Upload className="w-6 h-6" />
              </div>
              <div>
                <p className="text-sm font-medium text-white">Import 3D Model</p>
                <p className="text-xs text-gray-400 mt-1">Drag and drop .glb, .gltf, or .obj file, or click upload</p>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded text-xs font-medium transition-colors shadow-lg shadow-purple-900/30"
                >
                  Upload Model
                </button>
                <button
                  type="button"
                  onClick={loadProceduralMannequin}
                  className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-medium transition-colors shadow-lg shadow-blue-900/30 flex items-center space-x-1.5"
                >
                  <User className="w-3.5 h-3.5" />
                  <span>Insert 3D Mannequin</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floating Clip Studio Paint 3D HUD (Rendered via Portal) */}
      {createPortal(
        <div className="fixed inset-x-0 top-12 pointer-events-none z-50 flex flex-col items-center select-none space-y-2">
          {/* 1. Main Clip Studio Paint 3D Launcher Toolbar */}
          <div className="pointer-events-auto shadow-2xl flex items-center space-x-2">
            <Csp3DToolbar
              activeMode={activeToolMode}
              onSelectMode={(mode) => setActiveToolMode(mode)}
              onDirectDrag={(mode, dx, dy) => applyTransformDelta(mode, dx, dy)}
              onSnapToGround={handleSnapToGround}
              onResetModelTransform={handleResetModelTransform}
              onExtractLineAndTone={handleExtractLineAndTone}
              isExtracting={isBaking}
              modelName={loadedFileName || (isMannequinActive ? 'Mannequin' : '3D Model')}
            />

            {/* Quick Turn Buttons */}
            <div className="flex items-center space-x-0.5 bg-[#1b1e24]/95 border border-[#3b82f6]/40 rounded-lg p-1 text-[11px] text-gray-300">
              <button
                type="button"
                onClick={() => rotateModelYaw(-90)}
                title="Turn 90° Left"
                className="px-1.5 py-1 rounded hover:bg-white/10 text-sky-400 font-mono"
              >
                ↶ 90°
              </button>
              <button
                type="button"
                onClick={() => rotateModelYaw(90)}
                title="Turn 90° Right"
                className="px-1.5 py-1 rounded hover:bg-white/10 text-sky-400 font-mono"
              >
                ↷ 90°
              </button>
              <button
                type="button"
                onClick={() => rotateModelYaw(180)}
                title="Flip Model 180°"
                className="px-1.5 py-1 rounded hover:bg-white/10 text-sky-400 font-mono"
              >
                180°
              </button>
            </div>
          </div>

          {/* 2. Secondary Comprehensive Controls Toolbar */}
          <div
            className="pointer-events-auto bg-[#181b20]/95 backdrop-blur-md border border-[#3b82f6]/40 shadow-2xl rounded-lg px-3 py-1.5 flex items-center space-x-2.5 text-xs text-[#cccccc]"
            onPointerDown={(e) => e.stopPropagation()}
          >
            {/* Model & Mannequin Upload / Preset Button */}
            <div className="flex items-center space-x-1.5 bg-[#252830] rounded px-2 py-1 border border-white/10">
              <span className="text-[10px] uppercase font-semibold text-gray-400">Model</span>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="Upload 3D Model (.glb, .gltf, .obj)"
                className={`p-1 px-2 rounded transition-colors flex items-center space-x-1.5 ${
                  loadedFileName && !isMannequinActive
                    ? 'bg-purple-600 text-white hover:bg-purple-500'
                    : 'bg-purple-600/30 text-purple-300 hover:bg-purple-600 hover:text-white'
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                <span className="text-[10px] font-medium max-w-[100px] truncate">
                  {loadedFileName || 'Upload'}
                </span>
              </button>
              <button
                type="button"
                onClick={loadProceduralMannequin}
                title="Load Rigged Humanoid Drawing Mannequin"
                className={`p-1 px-2 rounded transition-colors flex items-center space-x-1.5 ${
                  isMannequinActive
                    ? 'bg-blue-600 text-white hover:bg-blue-500'
                    : 'bg-blue-600/30 text-blue-300 hover:bg-blue-600 hover:text-white'
                }`}
              >
                <User className="w-3.5 h-3.5" />
                <span className="text-[10px] font-medium">Mannequin</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".glb,.gltf,.obj"
                className="hidden"
                onChange={handleFileUpload}
              />
            </div>

            {/* Poses Drawer Trigger (Standing, Action, Sitting, Fists, Relaxed Palm) */}
            {isMannequinActive && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowPoseDrawer(!showPoseDrawer)}
                  className={`flex items-center space-x-1 px-2 py-1 rounded border border-white/10 text-[10px] transition-colors ${
                    showPoseDrawer ? 'bg-amber-600 text-white' : 'bg-[#252830] text-amber-300 hover:bg-white/10'
                  }`}
                  title="Humanoid Pose Presets"
                >
                  <Sliders className="w-3.5 h-3.5" />
                  <span>Poses</span>
                </button>

                {showPoseDrawer && (
                  <div className="absolute top-full mt-1.5 left-0 bg-[#1b1e24] border border-[#f59e0b]/40 rounded-lg p-2 shadow-2xl z-50 flex flex-col space-y-1.5 w-44">
                    <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-1">
                      Pose Presets
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        handleApplyPreset('standing');
                        setShowPoseDrawer(false);
                      }}
                      className="text-left px-2 py-1 rounded text-[11px] hover:bg-white/10 text-gray-200 flex items-center justify-between"
                    >
                      <span>Heroic Standing</span>
                      <span className="text-[9px] text-gray-500 font-mono">Neutral</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handleApplyPreset('action');
                        setShowPoseDrawer(false);
                      }}
                      className="text-left px-2 py-1 rounded text-[11px] hover:bg-white/10 text-gray-200 flex items-center justify-between"
                    >
                      <span>Manga Action</span>
                      <span className="text-[9px] text-orange-400 font-mono">Combat</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handleApplyPreset('sitting');
                        setShowPoseDrawer(false);
                      }}
                      className="text-left px-2 py-1 rounded text-[11px] hover:bg-white/10 text-gray-200 flex items-center justify-between"
                    >
                      <span>Seated Pose</span>
                      <span className="text-[9px] text-sky-400 font-mono">Rest</span>
                    </button>
                    <div className="border-t border-white/10 my-0.5" />
                    <button
                      type="button"
                      onClick={() => {
                        handleApplyPreset('fists');
                        setShowPoseDrawer(false);
                      }}
                      className="text-left px-2 py-1 rounded text-[11px] hover:bg-white/10 text-gray-200 flex items-center justify-between"
                    >
                      <span>Hand Fists</span>
                      <span className="text-[9px] text-gray-400 font-mono">Clenched</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        handleApplyPreset('relaxed_palm');
                        setShowPoseDrawer(false);
                      }}
                      className="text-left px-2 py-1 rounded text-[11px] hover:bg-white/10 text-gray-200 flex items-center justify-between"
                    >
                      <span>Relaxed Palm</span>
                      <span className="text-[9px] text-gray-400 font-mono">Open</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* IK Limbs Selector */}
            {isMannequinActive && (
              <div className="flex items-center space-x-1 bg-[#252830] rounded px-1.5 py-1 border border-white/10">
                <span className="text-[10px] uppercase font-semibold text-gray-400 mr-1">IK</span>
                {(['head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot'] as const).map((limb) => (
                  <button
                    key={limb}
                    type="button"
                    onClick={() => selectIKTarget(activeIKHandle === limb ? null : limb)}
                    title={`Manipulate ${limb} IK handle`}
                    className={`px-1.5 py-0.5 rounded text-[10px] capitalize transition-colors ${
                      activeIKHandle === limb ? 'bg-cyan-600 text-white font-medium' : 'text-gray-400 hover:bg-white/10'
                    }`}
                  >
                    {limb === 'leftHand'
                      ? 'L-Hand'
                      : limb === 'rightHand'
                      ? 'R-Hand'
                      : limb === 'leftFoot'
                      ? 'L-Foot'
                      : limb === 'rightFoot'
                      ? 'R-Foot'
                      : 'Head'}
                  </button>
                ))}
              </div>
            )}

            {/* 3D Gizmo Rings Mode (Rotate / Translate / Off) */}
            <div className="flex items-center space-x-1 bg-[#252830] rounded px-1.5 py-1 border border-white/10">
              <span className="text-[10px] uppercase font-semibold text-gray-400 mr-1">Gizmo</span>
              <button
                type="button"
                onClick={() => setGizmoMode(gizmoMode === 'rotate' ? 'none' : 'rotate')}
                title="Toggle 3D Rotation Rings"
                className={`p-1 rounded flex items-center space-x-1 ${
                  gizmoMode === 'rotate' ? 'bg-amber-600 text-white' : 'hover:bg-white/10 text-gray-300'
                }`}
              >
                <Rotate3d className="w-3.5 h-3.5" />
                <span className="text-[10px]">Rings</span>
              </button>
              <button
                type="button"
                onClick={() => setGizmoMode(gizmoMode === 'translate' ? 'none' : 'translate')}
                title="Toggle 3D Translation Arrows"
                className={`p-1 rounded flex items-center space-x-1 ${
                  gizmoMode === 'translate' ? 'bg-amber-600 text-white' : 'hover:bg-white/10 text-gray-300'
                }`}
              >
                <Move className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Perspective (Dolly Zoom - Clip Studio Paint style) */}
            <div className="flex items-center space-x-1.5 bg-[#252830] rounded px-2 py-1 border border-white/10">
              <Compass className="w-3 h-3 text-sky-400" />
              <span className="text-[10px] text-gray-400" title="Exaggerates or flattens perspective distortion">
                Perspective
              </span>
              <input
                type="range"
                min="0.3"
                max="2.5"
                step="0.05"
                value={perspective}
                onChange={(e) => applyPerspectiveDollyZoom(parseFloat(e.target.value))}
                className="w-16 accent-sky-400 cursor-pointer h-1.5"
                title="Adjust perspective foreshortening (Dolly Zoom)"
              />
              <span className="text-[10px] font-mono w-7 text-right">{perspective.toFixed(1)}x</span>
            </div>

            {/* Camera Presets Menu */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowCameraPresets(!showCameraPresets)}
                className="flex items-center space-x-1 bg-[#252830] hover:bg-white/10 px-2 py-1 rounded border border-white/10 text-sky-400 text-[10px]"
                title="Camera Angle Presets"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>Angle</span>
              </button>

              {showCameraPresets && (
                <div className="absolute top-full mt-1.5 left-0 bg-[#1b1e24] border border-[#3b82f6]/40 rounded-lg p-1.5 shadow-2xl z-50 flex flex-col space-y-1 w-32">
                  <button
                    onClick={() => setCameraPreset('front')}
                    className="text-left px-2 py-1 rounded text-[11px] hover:bg-white/10 text-gray-200"
                  >
                    Front View
                  </button>
                  <button
                    onClick={() => setCameraPreset('threeQuarter')}
                    className="text-left px-2 py-1 rounded text-[11px] hover:bg-white/10 text-gray-200"
                  >
                    3/4 Perspective
                  </button>
                  <button
                    onClick={() => setCameraPreset('side')}
                    className="text-left px-2 py-1 rounded text-[11px] hover:bg-white/10 text-gray-200"
                  >
                    Side Profile
                  </button>
                  <button
                    onClick={() => setCameraPreset('top')}
                    className="text-left px-2 py-1 rounded text-[11px] hover:bg-white/10 text-gray-200"
                  >
                    Top (Bird's Eye)
                  </button>
                  <button
                    onClick={() => setCameraPreset('lowAngle')}
                    className="text-left px-2 py-1 rounded text-[11px] hover:bg-white/10 text-gray-200"
                  >
                    Low Angle (Worm)
                  </button>
                  <button
                    onClick={() => setCameraPreset('back')}
                    className="text-left px-2 py-1 rounded text-[11px] hover:bg-white/10 text-gray-200"
                  >
                    Back View
                  </button>
                </div>
              )}
            </div>

            {/* Shading Mode */}
            <div className="flex items-center space-x-1 bg-[#252830] rounded px-1.5 py-1 border border-white/10">
              <span className="text-[10px] uppercase font-semibold text-gray-400 mr-1">Shade</span>
              {(['shaded', 'smooth', 'silhouette'] as ShadingMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setShadingMode(mode);
                    applyShading(mode);
                  }}
                  className={`px-1.5 py-0.5 rounded text-[10px] capitalize transition-colors ${
                    shadingMode === mode ? 'bg-blue-600 text-white font-medium' : 'text-gray-400 hover:bg-white/10'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>

            {/* Floor Grid Toggle */}
            <button
              type="button"
              onClick={() => setShowGrid(!showGrid)}
              title="Toggle Ground Perspective Grid"
              className={`p-1.5 rounded transition-colors ${
                showGrid ? 'bg-sky-600/30 text-sky-300 ring-1 ring-sky-400' : 'text-gray-400 hover:bg-white/10'
              }`}
            >
              <Grid className="w-3.5 h-3.5" />
            </button>

            {/* Light Source Panel Toggle */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowLightPanel(!showLightPanel)}
                title="Configure 3D Light Source"
                className={`p-1.5 rounded transition-colors flex items-center space-x-1 ${
                  showLightPanel
                    ? 'bg-amber-500/30 text-amber-300 ring-1 ring-amber-400'
                    : 'text-amber-400 hover:bg-white/10'
                }`}
              >
                <Sun className="w-3.5 h-3.5" />
                <span className="text-[10px]">Light</span>
              </button>

              {showLightPanel && (
                <div className="absolute top-full mt-2 right-0 z-50">
                  <LightSourceWidget
                    settings={lightSettings}
                    onChange={(s) => setLightSettings(s)}
                    onReset={() =>
                      setLightSettings({
                        azimuth: 45,
                        elevation: 45,
                        intensity: 1.5,
                        ambientIntensity: 0.65,
                        color: '#ffffff',
                        isBacklit: false,
                      })
                    }
                  />
                </div>
              )}
            </div>

            {/* Local Opacity */}
            <div className="flex items-center space-x-1 bg-[#252830] rounded px-1.5 py-1 border border-white/10">
              <Layers className="w-3 h-3 text-gray-400" />
              <input
                type="range"
                min="0.1"
                max="1"
                step="0.05"
                value={opacity}
                onChange={(e) => setOpacity(parseFloat(e.target.value))}
                className="w-14 accent-blue-500 cursor-pointer h-1.5"
              />
              <span className="text-[10px] font-mono">{Math.round(opacity * 100)}%</span>
            </div>

            {/* Reset Camera */}
            <button
              onClick={handleResetCamera}
              title="Reset Camera View"
              className="p-1.5 text-gray-400 hover:text-white hover:bg-white/10 rounded transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>

            {/* Perspective Ruler Camera Sync Toggle */}
            <button
              type="button"
              onClick={() => {
                const nextSync = !syncCameraPerspective;
                setSyncCameraPerspective(nextSync);
                if (nextSync && cameraRef.current && onUpdatePerspectiveRuler) {
                  const ruler = calculatePerspectiveFromCamera(
                    cameraRef.current,
                    dimensions.width,
                    dimensions.height,
                    perspectiveRuler
                  );
                  onUpdatePerspectiveRuler(ruler);
                }
              }}
              title="Synchronize 3D camera with document Perspective Ruler"
              className={`p-1.5 px-2 rounded transition-colors flex items-center space-x-1 ${
                syncCameraPerspective
                  ? 'bg-cyan-600/30 text-cyan-300 ring-1 ring-cyan-400'
                  : 'text-gray-400 hover:bg-white/10'
              }`}
            >
              <Link className="w-3.5 h-3.5" />
              <span className="text-[10px]">Ruler Sync</span>
            </button>

            {/* 3D LT Line & Screentone Extraction */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowLTModal(!showLTModal)}
                disabled={isBaking || !modelRootRef.current}
                title="Extract Lineart and Screentones from 3D Model (LT Conversion)"
                className="flex items-center space-x-1 bg-purple-600 hover:bg-purple-500 text-white font-medium px-2.5 py-1 rounded shadow-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                <span className="text-xs">LT Convert</span>
              </button>

              {showLTModal && (
                <div className="absolute top-full mt-2 right-0 bg-[#1b1e24] border border-purple-500/40 rounded-xl p-3 shadow-2xl z-50 flex flex-col space-y-2.5 w-60">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-purple-300 flex items-center space-x-1">
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>LT Line & Tone Extraction</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowLTModal(false)}
                      className="text-gray-400 hover:text-white"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="flex flex-col space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-gray-300">
                      <span>Line Sensitivity</span>
                      <span className="font-mono text-cyan-400">{Math.round((1 - ltLineThreshold) * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="0.6"
                      step="0.02"
                      value={ltLineThreshold}
                      onChange={(e) => setLtLineThreshold(parseFloat(e.target.value))}
                      className="w-full accent-purple-500 cursor-pointer h-1.5"
                    />
                  </div>

                  <div className="flex flex-col space-y-1">
                    <span className="text-[11px] text-gray-300">Screentone Quantization</span>
                    <div className="flex space-x-2">
                      <button
                        type="button"
                        onClick={() => setLtToneBands(2)}
                        className={`flex-1 py-1 rounded text-[10px] font-medium transition-colors ${
                          ltToneBands === 2
                            ? 'bg-purple-600 text-white'
                            : 'bg-white/5 text-gray-400 hover:bg-white/10'
                        }`}
                      >
                        2 Bands (Shadow)
                      </button>
                      <button
                        type="button"
                        onClick={() => setLtToneBands(3)}
                        className={`flex-1 py-1 rounded text-[10px] font-medium transition-colors ${
                          ltToneBands === 3
                            ? 'bg-purple-600 text-white'
                            : 'bg-white/5 text-gray-400 hover:bg-white/10'
                        }`}
                      >
                        3 Bands (Deep/Mid)
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      handleExtractLineAndTone({
                        lineWidth: 1,
                        lineThreshold: ltLineThreshold,
                        toneCount: ltToneBands,
                        folderName: '',
                      })
                    }
                    disabled={isBaking}
                    className="w-full py-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-medium rounded text-xs transition-colors shadow-lg flex items-center justify-center space-x-1.5"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Extract Line & Tone</span>
                  </button>
                </div>
              )}
            </div>

            {/* Bake to 2D Layer */}
            <button
              type="button"
              onClick={handleBakeTo2D}
              disabled={isBaking || !modelRootRef.current}
              title={!modelRootRef.current ? 'Upload a model to convert to layer' : 'Convert to 2D Layer'}
              className="flex items-center space-x-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-3 py-1 rounded shadow-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span className="text-xs">{isBaking ? 'Baking...' : 'Convert to 2D Layer'}</span>
            </button>

            {/* Close */}
            <button
              onClick={onClose}
              title="Close 3D Viewport"
              className="p-1 text-gray-400 hover:text-red-400 hover:bg-white/10 rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
