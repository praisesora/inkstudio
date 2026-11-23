import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_3D_LIGHTING,
  mapScreenDeltaToCanvasDelta,
  resolve3DPointerAction,
  resolve3DWheelAction,
  Scene3DHistoryStack,
  Scene3DSnapshot,
  snapAngleDeg,
  snapPositionCoord,
  snapScaleFactor,
  sphericalLightToVector,
  TOOL_3D_BEHAVIOR_RULES,
} from '../tool3DRules';
import {
  createIKHandles,
  createProceduralMannequin,
  solveTwoBoneIK,
  syncIKHandlesToBones,
} from '../mannequin3D';
import { DEFAULT_COMMANDS } from '../shortcutManager';
import { store3DActions, use3DStore } from '../../stores';

function makeSnapshot(overrides: Partial<Scene3DSnapshot> = {}): Scene3DSnapshot {
  return {
    modelPosition: [0, 0, 0],
    modelQuaternion: [0, 0, 0, 1],
    modelScale: [1, 1, 1],
    cameraPosition: [0, 1.35, 3.8],
    cameraTarget: [0, 0.85, 0],
    cameraFov: 45,
    perspective: 1.0,
    lighting: {
      keyLight: { ...DEFAULT_3D_LIGHTING.keyLight },
      rimLight: { ...DEFAULT_3D_LIGHTING.rimLight },
      ambientIntensity: DEFAULT_3D_LIGHTING.ambientIntensity,
      ambientColor: DEFAULT_3D_LIGHTING.ambientColor,
      castGroundShadow: DEFAULT_3D_LIGHTING.castGroundShadow,
      shadowOpacity: DEFAULT_3D_LIGHTING.shadowOpacity,
    },
    shadingMode: 'shaded',
    materialRoughness: 0.4,
    toonOutline: false,
    opacity: 0.92,
    showGrid: true,
    ...overrides,
  };
}

describe('3D Tool Behavior Rules & Pointer Routing', () => {
  const baseInput = {
    activeTool: '3d' as const,
    isSpaceDown: false,
    isReferenceVisible: true,
    button: 0,
    altKey: false,
    activeMode: 'smart' as const,
    gizmoMode: 'rotate' as const,
    isGizmoHit: false,
    isIKHandleHit: false,
    isModelHit: false,
    hasModel: true,
  };

  it('passes pointer events through to 2D canvas when another tool is selected or Space is held', () => {
    expect(resolve3DPointerAction({ ...baseInput, activeTool: 'brush' })).toBe('pass-through-2d');
    expect(resolve3DPointerAction({ ...baseInput, isSpaceDown: true })).toBe('pass-through-2d');
    expect(resolve3DPointerAction({ ...baseInput, isReferenceVisible: false })).toBe('pass-through-2d');
  });

  it('gives top priority to active gizmo handles on left click', () => {
    expect(resolve3DPointerAction({ ...baseInput, isGizmoHit: true, isModelHit: true })).toBe(
      'gizmo-drag'
    );
  });

  it('routes middle, right, and Alt+left clicks consistently to camera controls from any mode', () => {
    expect(resolve3DPointerAction({ ...baseInput, button: 1, activeMode: 'model-scale' })).toBe(
      'camera-pan'
    );
    expect(resolve3DPointerAction({ ...baseInput, button: 2, activeMode: 'model-move' })).toBe(
      'camera-zoom'
    );
    expect(
      resolve3DPointerAction({ ...baseInput, button: 0, altKey: true, isGizmoHit: true })
    ).toBe('camera-orbit');
  });

  it('selects IK handle spheres directly when clicked', () => {
    expect(resolve3DPointerAction({ ...baseInput, isIKHandleHit: true, isModelHit: true })).toBe(
      'ik-select'
    );
  });

  it('implements Clip Studio Smart mode: drag model transforms by gizmo mode, drag background orbits camera', () => {
    expect(
      resolve3DPointerAction({ ...baseInput, isModelHit: true, gizmoMode: 'rotate' })
    ).toBe('model-rotate');
    expect(
      resolve3DPointerAction({ ...baseInput, isModelHit: true, gizmoMode: 'translate' })
    ).toBe('model-move');
    expect(
      resolve3DPointerAction({ ...baseInput, isModelHit: true, gizmoMode: 'scale' })
    ).toBe('model-scale');
    expect(resolve3DPointerAction({ ...baseInput, isModelHit: false })).toBe('camera-orbit');
  });

  it('respects explicit transform/camera sub-modes and falls back to orbit when no model is loaded', () => {
    expect(resolve3DPointerAction({ ...baseInput, activeMode: 'model-scale' })).toBe('model-scale');
    expect(resolve3DPointerAction({ ...baseInput, activeMode: 'camera-pan' })).toBe('camera-pan');
    expect(
      resolve3DPointerAction({ ...baseInput, activeMode: 'model-rotate', hasModel: false })
    ).toBe('camera-orbit');
  });

  it('routes unmodified wheel to 3D camera zoom and Ctrl/Meta+wheel to 2D canvas zoom', () => {
    expect(
      resolve3DWheelAction({
        activeTool: '3d',
        isSpaceDown: false,
        isReferenceVisible: true,
        ctrlKey: false,
        metaKey: false,
      })
    ).toBe('camera-zoom');

    expect(
      resolve3DWheelAction({
        activeTool: '3d',
        isSpaceDown: false,
        isReferenceVisible: true,
        ctrlKey: true,
        metaKey: false,
      })
    ).toBe('pass-through-2d');

    expect(
      resolve3DWheelAction({
        activeTool: 'brush',
        isSpaceDown: false,
        isReferenceVisible: true,
        ctrlKey: false,
        metaKey: false,
      })
    ).toBe('pass-through-2d');
  });

  it('defines user-facing behavior rules and registers the 3D tool shortcut', () => {
    expect(TOOL_3D_BEHAVIOR_RULES.length).toBeGreaterThanOrEqual(6);
    const cmd = DEFAULT_COMMANDS.find((c) => c.id === 'tool.3d');
    expect(cmd).toBeDefined();
    expect(cmd?.toolId).toBe('3d');
    expect(cmd?.defaultShortcut).toBe('K');
  });
});

describe('3D Coordinate Delta Mapping, Snapping & Lighting Math', () => {
  it('maps screen drag deltas accurately under canvas rotation and flip', () => {
    const id = mapScreenDeltaToCanvasDelta(10, 0, 0, false, false);
    expect(id.dx).toBeCloseTo(10, 5);
    expect(id.dy).toBeCloseTo(0, 5);

    const flippedX = mapScreenDeltaToCanvasDelta(10, 5, 0, true, false);
    expect(flippedX.dx).toBeCloseTo(-10, 5);
    expect(flippedX.dy).toBeCloseTo(5, 5);

    const rot90 = mapScreenDeltaToCanvasDelta(10, 0, 90, false, false);
    expect(rot90.dx).toBeCloseTo(0, 5);
    expect(rot90.dy).toBeCloseTo(-10, 5);
  });

  it('snaps angles, scale factors, and positions cleanly', () => {
    expect(snapAngleDeg(23, 15)).toBe(30);
    expect(snapAngleDeg(-8, 15)).toBe(-15);
    expect(snapScaleFactor(1.24, 0.1)).toBeCloseTo(1.2, 5);
    expect(snapScaleFactor(0.01, 0.1)).toBeCloseTo(0.05, 5);
    expect(snapPositionCoord(1.36, 0.1)).toBeCloseTo(1.4, 5);
  });

  it('computes unified normalized spherical light vectors for front and backlit modes', () => {
    const front = sphericalLightToVector(0, 0, false, 5);
    expect(front.x).toBeCloseTo(0, 5);
    expect(front.y).toBeCloseTo(0, 5);
    expect(front.z).toBeCloseTo(5, 5);

    const back = sphericalLightToVector(0, 0, true, 5);
    expect(back.z).toBeCloseTo(-5, 5);

    const elevated = sphericalLightToVector(45, 45, false, 1);
    expect(Math.hypot(elevated.x, elevated.y, elevated.z)).toBeCloseTo(1, 5);
  });
});

describe('3D Undo / Redo History Stack (Ctrl+Z / Ctrl+Y)', () => {
  it('undoes and redoes transforms, camera, lighting, shading, and mannequin bone poses', () => {
    const stack = new Scene3DHistoryStack(10);
    const s0 = makeSnapshot({
      bones: { leftUpperArm: { q: [0, 0, 0, 1] } },
    });
    const s1 = makeSnapshot({
      modelPosition: [1, 0.5, -0.2],
      bones: { leftUpperArm: { q: [0, 0, 0, 1] } },
    });
    const s2 = makeSnapshot({
      modelPosition: [1, 0.5, -0.2],
      shadingMode: 'toon',
      lighting: {
        ...s0.lighting,
        keyLight: { ...s0.lighting.keyLight, azimuth: 120, color: '#ffb56b' },
      },
      bones: { leftUpperArm: { q: [0.3, 0, 0, 0.95] } },
    });

    stack.reset(s0);
    expect(stack.canUndo()).toBe(false);
    expect(stack.canRedo()).toBe(false);

    // Duplicate snapshot is deduplicated
    expect(stack.push(makeSnapshot({ bones: { leftUpperArm: { q: [0, 0, 0, 1] } } }))).toBe(false);

    expect(stack.push(s1)).toBe(true);
    expect(stack.push(s2)).toBe(true);
    expect(stack.canUndo()).toBe(true);
    expect(stack.canRedo()).toBe(false);

    const u1 = stack.undo();
    expect(u1?.modelPosition).toEqual([1, 0.5, -0.2]);
    expect(u1?.shadingMode).toBe('shaded');
    expect(stack.canRedo()).toBe(true);

    const u0 = stack.undo();
    expect(u0?.modelPosition).toEqual([0, 0, 0]);
    expect(stack.canUndo()).toBe(false);

    const r1 = stack.redo();
    expect(r1?.modelPosition).toEqual([1, 0.5, -0.2]);

    // Pushing after undo truncates the redo tail
    const sBranch = makeSnapshot({ modelScale: [2, 2, 2] });
    expect(stack.push(sBranch)).toBe(true);
    expect(stack.canRedo()).toBe(false);
    expect(stack.undo()?.modelPosition).toEqual([1, 0.5, -0.2]);
  });

  it('enforces max history capacity', () => {
    const stack = new Scene3DHistoryStack(3);
    stack.reset(makeSnapshot({ modelPosition: [0, 0, 0] }));
    stack.push(makeSnapshot({ modelPosition: [1, 0, 0] }));
    stack.push(makeSnapshot({ modelPosition: [2, 0, 0] }));
    stack.push(makeSnapshot({ modelPosition: [3, 0, 0] }));

    expect(stack.length).toBe(3);
    expect(stack.undo()?.modelPosition[0]).toBe(2);
    expect(stack.undo()?.modelPosition[0]).toBe(1);
    expect(stack.canUndo()).toBe(false);
  });
});

describe('3D Store State & Rotated-Root IK Math', () => {
  it('solves 2-bone IK accurately even when the parent root group is rotated 90 degrees', () => {
    const parentRoot = new THREE.Group();
    parentRoot.rotation.y = Math.PI / 2;

    const rootBone = new THREE.Bone();
    rootBone.position.set(0, 1.0, 0);
    parentRoot.add(rootBone);

    const midBone = new THREE.Bone();
    midBone.position.set(0, -0.5, 0);
    rootBone.add(midBone);

    const endBone = new THREE.Bone();
    endBone.position.set(0, -0.5, 0);
    midBone.add(endBone);

    parentRoot.updateMatrixWorld(true);

    const target = new THREE.Vector3(0.45, 0.7, 0.25);
    const pole = new THREE.Vector3(0, 0.8, -1.0);

    solveTwoBoneIK(rootBone, midBone, endBone, target, pole);

    const solvedEnd = new THREE.Vector3();
    endBone.getWorldPosition(solvedEnd);
    expect(solvedEnd.distanceTo(target)).toBeLessThan(0.05);
  });

  it('syncs IK handles to moved mannequin bone world positions', () => {
    const { group, bones } = createProceduralMannequin();
    const { handles } = createIKHandles();

    group.position.set(1.5, 0.2, -0.5);
    group.updateMatrixWorld(true);
    syncIKHandlesToBones(bones, handles);

    const headWorld = new THREE.Vector3();
    bones.head!.getWorldPosition(headWorld);
    expect(handles.head.position.distanceTo(headWorld)).toBeLessThan(1e-4);
  });

  it('updates and resets 3D store lighting, shading, and history flags cleanly', () => {
    store3DActions.setGizmoMode('scale');
    expect(use3DStore.getState().gizmoMode).toBe('scale');

    store3DActions.updateKeyLight({ intensity: 2.2, color: '#ffb56b' });
    expect(use3DStore.getState().lighting.keyLight.intensity).toBe(2.2);

    store3DActions.setHistoryFlags(true, false);
    expect(use3DStore.getState().canUndo3D).toBe(true);
    expect(use3DStore.getState().canRedo3D).toBe(false);

    store3DActions.resetLighting();
    expect(use3DStore.getState().lighting.keyLight.color).toBe('#ffffff');
    store3DActions.setGizmoMode('rotate');
    store3DActions.setHistoryFlags(false, false);
  });
});
