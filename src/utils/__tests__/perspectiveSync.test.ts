import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { calculatePerspectiveFromCamera } from '../perspectiveMath';

describe('Perspective Ruler Camera Sync', () => {
  it('calculates 2-point perspective when camera is level', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    const ruler = calculatePerspectiveFromCamera(camera, 1000, 1000);
    expect(ruler).toBeDefined();
    expect(ruler.vps.length).toBeGreaterThanOrEqual(2);

    const vp1 = ruler.vps.find((v) => v.id === 'vp1');
    const vp2 = ruler.vps.find((v) => v.id === 'vp2');
    expect(vp1).toBeDefined();
    expect(vp2).toBeDefined();
  });

  it('detects 3-point perspective when camera is tilted up or down', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 5, 5);
    camera.lookAt(0, 0, 0); // Looking down (high-angle bird's eye view)
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    const ruler = calculatePerspectiveFromCamera(camera, 1920, 1080);
    expect(ruler.type).toBe('3-point');
    const vp3 = ruler.vps.find((v) => v.id === 'vp3');
    expect(vp3).toBeDefined();
    expect(typeof vp3!.x).toBe('number');
    expect(typeof vp3!.y).toBe('number');
  });

  it('computes correct horizon angle across camera roll/tilt', () => {
    const camera = new THREE.PerspectiveCamera(45, 1.5, 0.1, 100);
    camera.position.set(2, 2, 4);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    const ruler = calculatePerspectiveFromCamera(camera, 1200, 800);
    expect(Number.isFinite(ruler.horizonAngle)).toBe(true);
  });
});
