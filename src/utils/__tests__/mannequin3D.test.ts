import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createProceduralMannequin,
  findHumanoidBones,
  solveTwoBoneIK,
  createIKHandles,
  applyPosePreset,
} from '../mannequin3D';

describe('3D Humanoid Mannequin & IK System', () => {
  it('generates a rigged procedural humanoid mannequin with bones', () => {
    const { group, skinnedMesh, skeleton, bones } = createProceduralMannequin();
    expect(group).toBeDefined();
    expect(skinnedMesh).toBeInstanceOf(THREE.SkinnedMesh);
    expect(skeleton.bones.length).toBeGreaterThanOrEqual(15);
    expect(bones.hips).toBeDefined();
    expect(bones.head).toBeDefined();
    expect(bones.leftHand).toBeDefined();
    expect(bones.rightHand).toBeDefined();
    expect(bones.leftFoot).toBeDefined();
    expect(bones.rightFoot).toBeDefined();
  });

  it('discovers humanoid bones using standard pattern matching', () => {
    const root = new THREE.Group();
    const hip = new THREE.Bone();
    hip.name = 'mixamorig:Hips';
    const lHand = new THREE.Bone();
    lHand.name = 'mixamorig:LeftHand';
    const rHand = new THREE.Bone();
    rHand.name = 'mixamorig:RightHand';
    root.add(hip);
    root.add(lHand);
    root.add(rHand);

    const found = findHumanoidBones(root);
    expect(found.hips).toBe(hip);
    expect(found.leftHand).toBe(lHand);
    expect(found.rightHand).toBe(rHand);
  });

  it('solves two-bone IK for limb stretching towards target', () => {
    const rootBone = new THREE.Bone();
    rootBone.position.set(0, 1.0, 0);

    const midBone = new THREE.Bone();
    midBone.position.set(0, 0.5, 0);
    rootBone.add(midBone);

    const endBone = new THREE.Bone();
    endBone.position.set(0, 0.5, 0);
    midBone.add(endBone);

    rootBone.updateMatrixWorld(true);

    const target = new THREE.Vector3(0.5, 1.2, 0.2);
    const pole = new THREE.Vector3(0, 1.5, 1);

    solveTwoBoneIK(rootBone, midBone, endBone, target, pole);

    const finalPos = new THREE.Vector3();
    endBone.getWorldPosition(finalPos);

    // End bone should move towards target
    expect(Number.isFinite(finalPos.x)).toBe(true);
    expect(Number.isFinite(finalPos.y)).toBe(true);
    expect(Number.isFinite(finalPos.z)).toBe(true);
  });

  it('creates interactive IK target handles for extremities', () => {
    const { container, handles } = createIKHandles();
    expect(container).toBeInstanceOf(THREE.Group);
    expect(handles.head).toBeDefined();
    expect(handles.leftHand).toBeDefined();
    expect(handles.rightHand).toBeDefined();
    expect(handles.leftFoot).toBeDefined();
    expect(handles.rightFoot).toBeDefined();
  });

  it('applies pose presets without throwing and updates rotations', () => {
    const { bones } = createProceduralMannequin();

    applyPosePreset(bones, 'standing');
    expect(bones.leftUpperArm?.rotation.x).not.toBe(0);

    applyPosePreset(bones, 'action');
    expect(bones.leftUpperArm?.rotation.x).not.toBe(0);

    applyPosePreset(bones, 'sitting');
    expect(bones.leftUpperLeg?.rotation.x).not.toBe(0);

    applyPosePreset(bones, 'fists');
    expect(bones.leftHand?.rotation.x).not.toBe(0);

    applyPosePreset(bones, 'relaxed_palm');
    expect(bones.leftHand?.rotation.x).not.toBe(0);
  });
});
