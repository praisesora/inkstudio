import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type PosePresetName = 'standing' | 'action' | 'sitting' | 'fists' | 'relaxed_palm';

export interface HumanoidBones {
  root?: THREE.Bone;
  hips?: THREE.Bone;
  spine?: THREE.Bone;
  chest?: THREE.Bone;
  neck?: THREE.Bone;
  head?: THREE.Bone;
  leftShoulder?: THREE.Bone;
  leftUpperArm?: THREE.Bone;
  leftLowerArm?: THREE.Bone;
  leftHand?: THREE.Bone;
  rightShoulder?: THREE.Bone;
  rightUpperArm?: THREE.Bone;
  rightLowerArm?: THREE.Bone;
  rightHand?: THREE.Bone;
  leftUpperLeg?: THREE.Bone;
  leftLowerLeg?: THREE.Bone;
  leftFoot?: THREE.Bone;
  rightUpperLeg?: THREE.Bone;
  rightLowerLeg?: THREE.Bone;
  rightFoot?: THREE.Bone;
  [key: string]: THREE.Bone | undefined;
}

export interface IKTarget {
  name: 'head' | 'leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot';
  object: THREE.Mesh;
  pole: THREE.Vector3;
}

/**
 * Creates a stylized humanoid drawing mannequin as a THREE.SkinnedMesh.
 * Rigged with standard hierarchy and anime/manga drawing doll proportions.
 */
export function createProceduralMannequin(): {
  group: THREE.Group;
  skinnedMesh: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  bones: HumanoidBones;
} {
  const group = new THREE.Group();
  group.name = 'HumanoidMannequin';

  // 1. Build Bone Hierarchy
  const hips = new THREE.Bone();
  hips.name = 'Hips';
  hips.position.set(0, 0.95, 0);

  const spine = new THREE.Bone();
  spine.name = 'Spine';
  spine.position.set(0, 0.2, 0);
  hips.add(spine);

  const chest = new THREE.Bone();
  chest.name = 'Chest';
  chest.position.set(0, 0.22, 0);
  spine.add(chest);

  const neck = new THREE.Bone();
  neck.name = 'Neck';
  neck.position.set(0, 0.18, 0);
  chest.add(neck);

  const head = new THREE.Bone();
  head.name = 'Head';
  head.position.set(0, 0.15, 0);
  neck.add(head);

  // Left Arm
  const leftShoulder = new THREE.Bone();
  leftShoulder.name = 'LeftShoulder';
  leftShoulder.position.set(0.18, 0.14, 0);
  chest.add(leftShoulder);

  const leftUpperArm = new THREE.Bone();
  leftUpperArm.name = 'LeftUpperArm';
  leftUpperArm.position.set(0.12, 0, 0);
  leftShoulder.add(leftUpperArm);

  const leftLowerArm = new THREE.Bone();
  leftLowerArm.name = 'LeftLowerArm';
  leftLowerArm.position.set(0, -0.28, 0);
  leftUpperArm.add(leftLowerArm);

  const leftHand = new THREE.Bone();
  leftHand.name = 'LeftHand';
  leftHand.position.set(0, -0.26, 0);
  leftLowerArm.add(leftHand);

  // Right Arm
  const rightShoulder = new THREE.Bone();
  rightShoulder.name = 'RightShoulder';
  rightShoulder.position.set(-0.18, 0.14, 0);
  chest.add(rightShoulder);

  const rightUpperArm = new THREE.Bone();
  rightUpperArm.name = 'RightUpperArm';
  rightUpperArm.position.set(-0.12, 0, 0);
  rightShoulder.add(rightUpperArm);

  const rightLowerArm = new THREE.Bone();
  rightLowerArm.name = 'RightLowerArm';
  rightLowerArm.position.set(0, -0.28, 0);
  rightUpperArm.add(rightLowerArm);

  const rightHand = new THREE.Bone();
  rightHand.name = 'RightHand';
  rightHand.position.set(0, -0.26, 0);
  rightLowerArm.add(rightHand);

  // Left Leg
  const leftUpperLeg = new THREE.Bone();
  leftUpperLeg.name = 'LeftUpperLeg';
  leftUpperLeg.position.set(0.12, -0.05, 0);
  hips.add(leftUpperLeg);

  const leftLowerLeg = new THREE.Bone();
  leftLowerLeg.name = 'LeftLowerLeg';
  leftLowerLeg.position.set(0, -0.42, 0);
  leftUpperLeg.add(leftLowerLeg);

  const leftFoot = new THREE.Bone();
  leftFoot.name = 'LeftFoot';
  leftFoot.position.set(0, -0.42, 0.04);
  leftLowerLeg.add(leftFoot);

  // Right Leg
  const rightUpperLeg = new THREE.Bone();
  rightUpperLeg.name = 'RightUpperLeg';
  rightUpperLeg.position.set(-0.12, -0.05, 0);
  hips.add(rightUpperLeg);

  const rightLowerLeg = new THREE.Bone();
  rightLowerLeg.name = 'RightLowerLeg';
  rightLowerLeg.position.set(0, -0.42, 0);
  rightUpperLeg.add(rightLowerLeg);

  const rightFoot = new THREE.Bone();
  rightFoot.name = 'RightFoot';
  rightFoot.position.set(0, -0.42, 0.04);
  rightLowerLeg.add(rightFoot);

  const boneList = [
    hips, // 0
    spine, // 1
    chest, // 2
    neck, // 3
    head, // 4
    leftShoulder, // 5
    leftUpperArm, // 6
    leftLowerArm, // 7
    leftHand, // 8
    rightShoulder, // 9
    rightUpperArm, // 10
    rightLowerArm, // 11
    rightHand, // 12
    leftUpperLeg, // 13
    leftLowerLeg, // 14
    leftFoot, // 15
    rightUpperLeg, // 16
    rightLowerLeg, // 17
    rightFoot, // 18
  ];

  const bonesMap: HumanoidBones = {
    hips,
    spine,
    chest,
    neck,
    head,
    leftShoulder,
    leftUpperArm,
    leftLowerArm,
    leftHand,
    rightShoulder,
    rightUpperArm,
    rightLowerArm,
    rightHand,
    leftUpperLeg,
    leftLowerLeg,
    leftFoot,
    rightUpperLeg,
    rightLowerLeg,
    rightFoot,
  };

  // 2. Build segmented mannequin meshes bound to bones
  const geometries: THREE.BufferGeometry[] = [];

  const addPart = (
    rawGeom: THREE.BufferGeometry,
    boneIndex: number,
    offset: THREE.Vector3,
    rot?: THREE.Euler,
    scale?: THREE.Vector3
  ) => {
    const geom = rawGeom.clone();
    rawGeom.dispose();
    if (scale) geom.scale(scale.x, scale.y, scale.z);
    if (rot) geom.applyQuaternion(new THREE.Quaternion().setFromEuler(rot));
    geom.translate(offset.x, offset.y, offset.z);

    const count = geom.attributes.position.count;
    const skinIndices = new Float32Array(count * 4);
    const skinWeights = new Float32Array(count * 4);

    for (let i = 0; i < count; i++) {
      skinIndices[i * 4] = boneIndex;
      skinIndices[i * 4 + 1] = 0;
      skinIndices[i * 4 + 2] = 0;
      skinIndices[i * 4 + 3] = 0;

      skinWeights[i * 4] = 1.0;
      skinWeights[i * 4 + 1] = 0.0;
      skinWeights[i * 4 + 2] = 0.0;
      skinWeights[i * 4 + 3] = 0.0;
    }

    geom.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndices, 4));
    geom.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeights, 4));
    geometries.push(geom);
  };

  // World bone base positions for geometry placement
  // Pelvis / Hips
  addPart(new THREE.CylinderGeometry(0.14, 0.11, 0.16, 16), 0, new THREE.Vector3(0, 0.95, 0));
  // Spine (Mid Torso)
  addPart(new THREE.CylinderGeometry(0.13, 0.12, 0.18, 16), 1, new THREE.Vector3(0, 1.15, 0));
  // Chest
  addPart(new THREE.CylinderGeometry(0.16, 0.13, 0.22, 16), 2, new THREE.Vector3(0, 1.35, 0));
  // Neck
  addPart(new THREE.CylinderGeometry(0.06, 0.07, 0.12, 12), 3, new THREE.Vector3(0, 1.55, 0));
  // Head (Egg/Stylized drawing doll head with face plane)
  addPart(
    new THREE.SphereGeometry(0.12, 16, 16),
    4,
    new THREE.Vector3(0, 1.72, 0),
    undefined,
    new THREE.Vector3(0.9, 1.15, 1.05)
  );

  // Limbs
  // Left Arm
  addPart(new THREE.SphereGeometry(0.07, 12, 12), 5, new THREE.Vector3(0.24, 1.45, 0)); // Shoulder joint
  addPart(new THREE.CylinderGeometry(0.05, 0.045, 0.26, 12), 6, new THREE.Vector3(0.3, 1.28, 0)); // Upper Arm
  addPart(new THREE.SphereGeometry(0.05, 12, 12), 6, new THREE.Vector3(0.3, 1.14, 0)); // Elbow joint
  addPart(new THREE.CylinderGeometry(0.045, 0.04, 0.24, 12), 7, new THREE.Vector3(0.3, 1.0, 0)); // Forearm
  addPart(new THREE.BoxGeometry(0.04, 0.1, 0.08), 8, new THREE.Vector3(0.3, 0.82, 0)); // Hand

  // Right Arm
  addPart(new THREE.SphereGeometry(0.07, 12, 12), 9, new THREE.Vector3(-0.24, 1.45, 0));
  addPart(new THREE.CylinderGeometry(0.05, 0.045, 0.26, 12), 10, new THREE.Vector3(-0.3, 1.28, 0));
  addPart(new THREE.SphereGeometry(0.05, 12, 12), 10, new THREE.Vector3(-0.3, 1.14, 0));
  addPart(new THREE.CylinderGeometry(0.045, 0.04, 0.24, 12), 11, new THREE.Vector3(-0.3, 1.0, 0));
  addPart(new THREE.BoxGeometry(0.04, 0.1, 0.08), 12, new THREE.Vector3(-0.3, 0.82, 0));

  // Left Leg
  addPart(new THREE.SphereGeometry(0.075, 12, 12), 0, new THREE.Vector3(0.12, 0.9, 0)); // Hip joint
  addPart(new THREE.CylinderGeometry(0.07, 0.06, 0.38, 14), 13, new THREE.Vector3(0.12, 0.68, 0)); // Thigh
  addPart(new THREE.SphereGeometry(0.06, 12, 12), 13, new THREE.Vector3(0.12, 0.48, 0)); // Knee joint
  addPart(new THREE.CylinderGeometry(0.058, 0.045, 0.38, 14), 14, new THREE.Vector3(0.12, 0.28, 0)); // Calf
  addPart(new THREE.BoxGeometry(0.08, 0.06, 0.18), 15, new THREE.Vector3(0.12, 0.05, 0.04)); // Foot

  // Right Leg
  addPart(new THREE.SphereGeometry(0.075, 12, 12), 0, new THREE.Vector3(-0.12, 0.9, 0));
  addPart(new THREE.CylinderGeometry(0.07, 0.06, 0.38, 14), 16, new THREE.Vector3(-0.12, 0.68, 0));
  addPart(new THREE.SphereGeometry(0.06, 12, 12), 16, new THREE.Vector3(-0.12, 0.48, 0));
  addPart(new THREE.CylinderGeometry(0.058, 0.045, 0.38, 14), 17, new THREE.Vector3(-0.12, 0.28, 0));
  addPart(new THREE.BoxGeometry(0.08, 0.06, 0.18), 18, new THREE.Vector3(-0.12, 0.05, 0.04));

  const mergedGeometry = BufferGeometryUtils.mergeGeometries(geometries);
  for (const g of geometries) {
    g.dispose();
  }
  mergedGeometry.computeVertexNormals();

  // CSP Mannequin Clay Material
  const material = new THREE.MeshStandardMaterial({
    color: 0xd8dde3,
    roughness: 0.38,
    metalness: 0.08,
  });

  const skinnedMesh = new THREE.SkinnedMesh(mergedGeometry, material);
  const skeleton = new THREE.Skeleton(boneList);

  skinnedMesh.add(hips);
  skinnedMesh.bind(skeleton);
  skinnedMesh.castShadow = true;
  skinnedMesh.receiveShadow = true;

  group.add(skinnedMesh);

  return {
    group,
    skinnedMesh,
    skeleton,
    bones: bonesMap,
  };
}

/**
 * Discovers and maps humanoid bones from any loaded 3D GLTF/FBX model
 * based on standard naming conventions (Mixamo, Blender, Three.js, etc.).
 */
export function findHumanoidBones(root: THREE.Object3D): HumanoidBones {
  const bones: HumanoidBones = {};

  const nameMatchPatterns: Array<[keyof HumanoidBones, RegExp]> = [
    ['head', /head|kubi_atama/i],
    ['neck', /neck|kubi/i],
    ['chest', /chest|upper_chest|spine1|spine01/i],
    ['spine', /spine|spine00/i],
    ['hips', /hip|hips|pelvis|waist/i],

    ['leftHand', /left.*hand|hand.*l|l_hand|wrist.*l|leftwrist/i],
    ['leftLowerArm', /left.*fore.*arm|forearm.*l|l_forearm|elbow.*l|leftlowerarm/i],
    ['leftUpperArm', /left.*arm|arm.*l|l_arm|leftupperarm/i],
    ['leftShoulder', /left.*shoulder|shoulder.*l|l_shoulder|clavicle.*l/i],

    ['rightHand', /right.*hand|hand.*r|r_hand|wrist.*r|rightwrist/i],
    ['rightLowerArm', /right.*fore.*arm|forearm.*r|r_forearm|elbow.*r|rightlowerarm/i],
    ['rightUpperArm', /right.*arm|arm.*r|r_arm|rightupperarm/i],
    ['rightShoulder', /right.*shoulder|shoulder.*r|r_shoulder|clavicle.*r/i],

    ['leftFoot', /left.*foot|foot.*l|l_foot|ankle.*l|leftankle/i],
    ['leftLowerLeg', /left.*leg|leg.*l|l_leg|shin.*l|knee.*l|leftlowerleg/i],
    ['leftUpperLeg', /left.*up.*leg|upleg.*l|l_upleg|thigh.*l|leftupperleg/i],

    ['rightFoot', /right.*foot|foot.*r|r_foot|ankle.*r|rightankle/i],
    ['rightLowerLeg', /right.*leg|leg.*r|r_leg|shin.*r|knee.*r|rightlowerleg/i],
    ['rightUpperLeg', /right.*up.*leg|upleg.*r|r_upleg|thigh.*r|rightupperleg/i],
  ];

  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      const bone = obj as THREE.Bone;
      const lower = bone.name.toLowerCase();

      for (const [key, pattern] of nameMatchPatterns) {
        if (!bones[key] && pattern.test(lower)) {
          bones[key] = bone;
        }
      }
    }
  });

  return bones;
}

/**
 * Applies a world-space delta rotation to a bone's local quaternion,
 * accounting for any rotation on the bone's ancestors/root.
 */
function applyWorldRotationDeltaToBone(
  bone: THREE.Bone,
  worldRotDelta: THREE.Quaternion
): void {
  const parentWorldQuat = new THREE.Quaternion();
  if (bone.parent) {
    bone.parent.updateMatrixWorld(true);
    bone.parent.getWorldQuaternion(parentWorldQuat);
  }
  const invParent = parentWorldQuat.clone().invert();
  const localDelta = invParent.multiply(worldRotDelta).multiply(parentWorldQuat);
  bone.quaternion.premultiply(localDelta).normalize();
  bone.updateMatrixWorld(true);
}

/**
 * Closed-form analytic 2-bone Inverse Kinematics (IK) with pole target constraint.
 * Solves root (shoulder/hip) and mid (elbow/knee) joint rotations in real time,
 * properly converting world-space rotations into each bone's parent-local space.
 */
export function solveTwoBoneIK(
  rootBone: THREE.Bone,
  midBone: THREE.Bone,
  endBone: THREE.Bone,
  targetWorldPos: THREE.Vector3,
  poleWorldPos: THREE.Vector3
): void {
  rootBone.updateMatrixWorld(true);
  midBone.updateMatrixWorld(true);
  endBone.updateMatrixWorld(true);

  const rootWorldPos = new THREE.Vector3();
  const midWorldPos = new THREE.Vector3();
  const endWorldPos = new THREE.Vector3();

  rootBone.getWorldPosition(rootWorldPos);
  midBone.getWorldPosition(midWorldPos);
  endBone.getWorldPosition(endWorldPos);

  const l1 = rootWorldPos.distanceTo(midWorldPos);
  const l2 = midWorldPos.distanceTo(endWorldPos);
  const totalLength = l1 + l2;

  if (l1 <= 1e-4 || l2 <= 1e-4) return;

  const toTarget = new THREE.Vector3().subVectors(targetWorldPos, rootWorldPos);
  const rawDist = toTarget.length();
  if (rawDist <= 1e-5) return;

  const minReach = Math.abs(l1 - l2) + 1e-3;
  const maxReach = totalLength - 1e-4;
  const targetDist = Math.max(minReach, Math.min(maxReach, rawDist));
  const targetDir = toTarget.clone().divideScalar(rawDist);

  // Law of Cosines for angle at root joint
  const cosAlpha = Math.max(
    -1.0,
    Math.min(1.0, (l1 * l1 + targetDist * targetDist - l2 * l2) / (2.0 * l1 * targetDist))
  );
  const alpha = Math.acos(cosAlpha);

  // Compute bend plane normal from pole vector
  const toPole = new THREE.Vector3().subVectors(poleWorldPos, rootWorldPos);
  if (toPole.lengthSq() > 1e-6) {
    toPole.normalize();
  } else {
    toPole.set(0, 0, 1);
  }
  let bendNormal = new THREE.Vector3().crossVectors(targetDir, toPole);
  if (bendNormal.lengthSq() < 1e-4) {
    const worldQuat = new THREE.Quaternion();
    rootBone.getWorldQuaternion(worldQuat);
    bendNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(worldQuat).normalize();
  } else {
    bendNormal.normalize();
  }

  // Mid joint direction vector in world coordinates
  const midDir = targetDir
    .clone()
    .applyAxisAngle(bendNormal, alpha)
    .normalize();
  const solvedMidWorldPos = rootWorldPos.clone().addScaledVector(midDir, l1);

  // 1. Orient Root Bone towards solved mid position (in parent-local space)
  const currentLimbDir = new THREE.Vector3().subVectors(midWorldPos, rootWorldPos).normalize();
  const targetLimbDir = new THREE.Vector3().subVectors(solvedMidWorldPos, rootWorldPos).normalize();
  if (currentLimbDir.lengthSq() > 1e-6 && targetLimbDir.lengthSq() > 1e-6) {
    const rotDelta = new THREE.Quaternion().setFromUnitVectors(currentLimbDir, targetLimbDir);
    applyWorldRotationDeltaToBone(rootBone, rotDelta);
  }

  // 2. Re-read updated world positions after root bone rotated, then orient Mid Bone towards target
  midBone.getWorldPosition(midWorldPos);
  endBone.getWorldPosition(endWorldPos);

  const currentEndDir = new THREE.Vector3().subVectors(endWorldPos, midWorldPos).normalize();
  const targetEndDir = new THREE.Vector3().subVectors(targetWorldPos, midWorldPos).normalize();
  if (currentEndDir.lengthSq() > 1e-6 && targetEndDir.lengthSq() > 1e-6) {
    const rotDelta = new THREE.Quaternion().setFromUnitVectors(currentEndDir, targetEndDir);
    applyWorldRotationDeltaToBone(midBone, rotDelta);
  }
}

/**
 * Synchronizes IK handle meshes to the live world positions of their corresponding bones.
 */
export function syncIKHandlesToBones(
  bones: HumanoidBones | null,
  handles: Record<string, THREE.Mesh> | null
): void {
  if (!bones || !handles) return;
  const wp = new THREE.Vector3();
  const pairs: Array<[string, THREE.Bone | undefined]> = [
    ['head', bones.head],
    ['leftHand', bones.leftHand],
    ['rightHand', bones.rightHand],
    ['leftFoot', bones.leftFoot],
    ['rightFoot', bones.rightFoot],
  ];
  for (const [name, bone] of pairs) {
    const handle = handles[name];
    if (!handle) continue;
    if (bone) {
      bone.updateMatrixWorld(true);
      bone.getWorldPosition(wp);
      handle.position.copy(wp);
      handle.visible = true;
    } else {
      handle.visible = false;
    }
  }
}

/**
 * Creates visual interactive handles for IK target endpoints (hands, feet, head).
 */
export function createIKHandles(): {
  container: THREE.Group;
  handles: Record<string, THREE.Mesh>;
} {
  const container = new THREE.Group();
  container.name = 'IKHandles';
  container.userData.is3DHelper = true;

  const handles: Record<string, THREE.Mesh> = {};

  const handleDefs: Array<{
    name: string;
    color: number;
    size: number;
    initialPos: [number, number, number];
  }> = [
    { name: 'head', color: 0xf59e0b, size: 0.08, initialPos: [0, 1.72, 0] },
    { name: 'leftHand', color: 0x06b6d4, size: 0.07, initialPos: [0.3, 0.82, 0] },
    { name: 'rightHand', color: 0xa855f7, size: 0.07, initialPos: [-0.3, 0.82, 0] },
    { name: 'leftFoot', color: 0x10b981, size: 0.07, initialPos: [0.12, 0.05, 0.04] },
    { name: 'rightFoot', color: 0xec4899, size: 0.07, initialPos: [-0.12, 0.05, 0.04] },
  ];

  for (const def of handleDefs) {
    const geom = new THREE.SphereGeometry(def.size, 16, 16);
    const mat = new THREE.MeshBasicMaterial({
      color: def.color,
      transparent: true,
      opacity: 0.55,
      wireframe: false,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = `IKHandle_${def.name}`;
    mesh.userData.is3DHelper = true;
    mesh.userData.ikHandleName = def.name;
    mesh.position.set(...def.initialPos);
    mesh.renderOrder = 999;

    // Crisp outer ring wireframe for clear hit-target readability
    const wireGeom = new THREE.SphereGeometry(def.size * 1.15, 12, 12);
    const wireMat = new THREE.MeshBasicMaterial({
      color: def.color,
      wireframe: true,
      depthTest: false,
    });
    const wire = new THREE.Mesh(wireGeom, wireMat);
    wire.userData.is3DHelper = true;
    wire.userData.ikHandleName = def.name;
    wire.renderOrder = 1000;
    mesh.add(wire);

    container.add(mesh);
    handles[def.name] = mesh;
  }

  return { container, handles };
}

/**
 * Applies studio pose presets to humanoid mannequin bones.
 */
export function applyPosePreset(bones: HumanoidBones, preset: PosePresetName): void {
  // Reset all bones to identity rotation and restore default hip height first
  for (const key of Object.keys(bones)) {
    const b = bones[key];
    if (b) {
      b.quaternion.identity();
    }
  }
  if (bones.hips) {
    bones.hips.position.set(0, 0.95, 0);
  }

  const rad = (deg: number) => (deg * Math.PI) / 180;

  switch (preset) {
    case 'standing': {
      // Natural upright hero pose: slightly relaxed arms and shoulders
      if (bones.leftUpperArm) bones.leftUpperArm.rotation.set(rad(8), 0, rad(12));
      if (bones.rightUpperArm) bones.rightUpperArm.rotation.set(rad(8), 0, rad(-12));
      if (bones.leftLowerArm) bones.leftLowerArm.rotation.set(rad(-14), 0, 0);
      if (bones.rightLowerArm) bones.rightLowerArm.rotation.set(rad(-14), 0, 0);
      if (bones.leftUpperLeg) bones.leftUpperLeg.rotation.set(0, 0, rad(4));
      if (bones.rightUpperLeg) bones.rightUpperLeg.rotation.set(0, 0, rad(-4));
      break;
    }

    case 'action': {
      // Dynamic manga action battle pose
      if (bones.hips) bones.hips.rotation.set(rad(12), rad(-20), 0);
      if (bones.chest) bones.chest.rotation.set(rad(-8), rad(25), 0);
      if (bones.head) bones.head.rotation.set(rad(-10), rad(-15), 0);

      // Guard arm (Left)
      if (bones.leftUpperArm) bones.leftUpperArm.rotation.set(rad(-45), rad(20), rad(30));
      if (bones.leftLowerArm) bones.leftLowerArm.rotation.set(rad(-85), 0, 0);

      // Cocked punch arm (Right)
      if (bones.rightUpperArm) bones.rightUpperArm.rotation.set(rad(25), rad(-30), rad(-40));
      if (bones.rightLowerArm) bones.rightLowerArm.rotation.set(rad(-110), 0, 0);

      // Deep battle stance legs
      if (bones.leftUpperLeg) bones.leftUpperLeg.rotation.set(rad(-35), rad(-15), rad(10));
      if (bones.leftLowerLeg) bones.leftLowerLeg.rotation.set(rad(60), 0, 0);

      if (bones.rightUpperLeg) bones.rightUpperLeg.rotation.set(rad(25), rad(20), rad(-15));
      if (bones.rightLowerLeg) bones.rightLowerLeg.rotation.set(rad(35), 0, 0);
      break;
    }

    case 'sitting': {
      // Seated pose (90 degree hips, 90 degree knees)
      if (bones.hips) bones.hips.position.y = 0.55;
      if (bones.spine) bones.spine.rotation.set(rad(6), 0, 0);

      if (bones.leftUpperLeg) bones.leftUpperLeg.rotation.set(rad(-85), rad(10), 0);
      if (bones.leftLowerLeg) bones.leftLowerLeg.rotation.set(rad(90), 0, 0);

      if (bones.rightUpperLeg) bones.rightUpperLeg.rotation.set(rad(-85), rad(-10), 0);
      if (bones.rightLowerLeg) bones.rightLowerLeg.rotation.set(rad(90), 0, 0);

      // Hands resting on knees
      if (bones.leftUpperArm) bones.leftUpperArm.rotation.set(rad(-15), 0, rad(12));
      if (bones.leftLowerArm) bones.leftLowerArm.rotation.set(rad(-55), 0, 0);

      if (bones.rightUpperArm) bones.rightUpperArm.rotation.set(rad(-15), 0, rad(-12));
      if (bones.rightLowerArm) bones.rightLowerArm.rotation.set(rad(-55), 0, 0);
      break;
    }

    case 'fists': {
      // Clenched fist rotations on wrists and arm readiness
      if (bones.leftHand) bones.leftHand.rotation.set(rad(-20), rad(10), rad(15));
      if (bones.rightHand) bones.rightHand.rotation.set(rad(-20), rad(-10), rad(-15));
      if (bones.leftLowerArm) bones.leftLowerArm.rotation.set(rad(-35), 0, 0);
      if (bones.rightLowerArm) bones.rightLowerArm.rotation.set(rad(-35), 0, 0);
      break;
    }

    case 'relaxed_palm': {
      // Natural open resting palms
      if (bones.leftHand) bones.leftHand.rotation.set(rad(5), rad(-8), 0);
      if (bones.rightHand) bones.rightHand.rotation.set(rad(5), rad(8), 0);
      if (bones.leftLowerArm) bones.leftLowerArm.rotation.set(rad(-10), 0, 0);
      if (bones.rightLowerArm) bones.rightLowerArm.rotation.set(rad(-10), 0, 0);
      break;
    }
  }

  // Update matrix world for all bones
  for (const key of Object.keys(bones)) {
    const b = bones[key];
    if (b) b.updateMatrixWorld(true);
  }
}
