import { describe, it, expect } from 'vitest';
import {
  normalizeRulerAngle,
  snapAngleToStep,
  createDefaultStraightRuler,
  getStraightRulerDirection,
  projectPointOntoLine,
  StraightRulerSnapSession,
} from '../straightRulerMath';
import { useDocumentStore, documentStoreActions } from '../../stores';

describe('Straight Ruler Math & Store', () => {
  it('normalizes angles cleanly into (-180, 180] and snaps to step increments', () => {
    expect(normalizeRulerAngle(0)).toBe(0);
    expect(normalizeRulerAngle(180)).toBe(180);
    expect(normalizeRulerAngle(-180)).toBe(180);
    expect(normalizeRulerAngle(270)).toBe(-90);
    expect(normalizeRulerAngle(-270)).toBe(90);
    expect(normalizeRulerAngle(540)).toBe(180);

    expect(snapAngleToStep(7, 15)).toBe(0);
    expect(snapAngleToStep(8, 15)).toBe(15);
    expect(snapAngleToStep(-22, 15)).toBe(-15);
    expect(snapAngleToStep(44, 15)).toBe(45);
  });

  it('projects points accurately along rotated straight ruler lines', () => {
    const dir45 = getStraightRulerDirection(45);
    expect(dir45.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(dir45.y).toBeCloseTo(Math.SQRT1_2, 6);

    const proj = projectPointOntoLine({ x: 100, y: 0 }, { x: 0, y: 0 }, dir45);
    expect(proj.x).toBeCloseTo(50, 6);
    expect(proj.y).toBeCloseTo(50, 6);
  });

  it('snaps directly onto ruler edge within the edge band and parallel outside it', () => {
    const ruler = createDefaultStraightRuler(500, 400);
    ruler.angle = 0; // horizontal line y = 400
    const session = new StraightRulerSnapSession();

    // Near ruler edge (distance = 8px <= 26px band): snaps onto y = 400
    const startEdge = session.startStroke({ x: 520, y: 408 }, ruler, 1.0);
    expect(startEdge.snapped).toBe(true);
    expect(startEdge.x).toBeCloseTo(520, 6);
    expect(startEdge.y).toBeCloseTo(400, 6);

    const moveEdge = session.processPoint({ x: 650, y: 445 }, ruler);
    expect(moveEdge.snapped).toBe(true);
    expect(moveEdge.x).toBeCloseTo(650, 6);
    expect(moveEdge.y).toBeCloseTo(400, 6);
    session.endStroke();

    // Far from ruler edge (distance = 120px > 26px band): draws parallel line at y = 520
    const startParallel = session.startStroke({ x: 300, y: 520 }, ruler, 1.0);
    expect(startParallel.snapped).toBe(true);
    expect(startParallel.x).toBeCloseTo(300, 6);
    expect(startParallel.y).toBeCloseTo(520, 6);

    const moveParallel = session.processPoint({ x: 480, y: 555 }, ruler);
    expect(moveParallel.snapped).toBe(true);
    expect(moveParallel.x).toBeCloseTo(480, 6);
    expect(moveParallel.y).toBeCloseTo(520, 6);
    session.endStroke();
  });

  it('respects rotated ruler angle, disabled/snap-off states, and Alt override', () => {
    const ruler = createDefaultStraightRuler(200, 200);
    ruler.angle = 90; // vertical line x = 200
    const session = new StraightRulerSnapSession();

    const start = session.startStroke({ x: 205, y: 100 }, ruler, 1.0);
    expect(start.snapped).toBe(true);
    expect(start.x).toBeCloseTo(200, 6);
    expect(start.y).toBeCloseTo(100, 6);

    // Alt temporarily overrides snapping
    const rawWithAlt = session.processPoint({ x: 245, y: 310 }, ruler, true);
    expect(rawWithAlt).toEqual({ x: 245, y: 310, snapped: false });

    // Without Alt, snaps back to vertical line x = 200
    const snapped = session.processPoint({ x: 245, y: 310 }, ruler, false);
    expect(snapped.snapped).toBe(true);
    expect(snapped.x).toBeCloseTo(200, 6);
    expect(snapped.y).toBeCloseTo(310, 6);
    session.endStroke();

    // Disabled or snapEnabled=false passes through unchanged
    const disabled = { ...ruler, enabled: false };
    expect(session.startStroke({ x: 123, y: 456 }, disabled, 1.0)).toEqual({
      x: 123,
      y: 456,
      snapped: false,
    });

    const snapOff = { ...ruler, snapEnabled: false };
    expect(session.startStroke({ x: 123, y: 456 }, snapOff, 1.0)).toEqual({
      x: 123,
      y: 456,
      snapped: false,
    });
  });

  it('toggles, rotates, and locks StraightRuler cleanly in useDocumentStore', () => {
    useDocumentStore.reset();
    expect(useDocumentStore.getState().straightRuler).toBeNull();

    const created = documentStoreActions.toggleStraightRuler(600, 400);
    expect(created.enabled).toBe(true);
    expect(created.locked).toBe(false);
    expect(created.x).toBe(600);
    expect(created.y).toBe(400);

    documentStoreActions.setStraightRuler((prev) =>
      prev ? { ...prev, angle: 30, locked: true } : null
    );
    const updated = useDocumentStore.getState().straightRuler!;
    expect(updated.angle).toBe(30);
    expect(updated.locked).toBe(true);

    const toggledOff = documentStoreActions.toggleStraightRuler();
    expect(toggledOff.enabled).toBe(false);
    expect(toggledOff.angle).toBe(30);
    expect(toggledOff.locked).toBe(true);

    const toggledOn = documentStoreActions.toggleStraightRuler();
    expect(toggledOn.enabled).toBe(true);
    expect(toggledOn.angle).toBe(30);
  });
});
