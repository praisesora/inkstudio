import { describe, it, expect } from 'vitest';
import {
  createDefaultSpeechBalloon,
  getBalloonHandles,
  hitTestBalloon,
} from '../balloonEngine';

describe('Speech Balloon Engine', () => {
  it('creates a default speech balloon with vector tail', () => {
    const balloon = createDefaultSpeechBalloon(100, 150, 200, 120, 'ellipse');

    expect(balloon.shape).toBe('ellipse');
    expect(balloon.bounds.x).toBe(100);
    expect(balloon.bounds.y).toBe(150);
    expect(balloon.bounds.width).toBe(200);
    expect(balloon.bounds.height).toBe(120);

    expect(balloon.tail).toBeDefined();
    expect(balloon.tail.start.x).toBe(200);
    expect(balloon.tail.tip.y).toBeGreaterThan(balloon.bounds.y + balloon.bounds.height);
  });

  it('generates interactive resize and tail handles', () => {
    const balloon = createDefaultSpeechBalloon(50, 50, 100, 100, 'rounded-rect');
    const handles = getBalloonHandles(balloon);

    expect(handles.length).toBeGreaterThanOrEqual(12);
    const tipHandle = handles.find((h) => h.id === 'tail-tip');
    expect(tipHandle).toBeDefined();
    expect(tipHandle?.x).toBe(balloon.tail.tip.x);
    expect(tipHandle?.y).toBe(balloon.tail.tip.y);
  });

  it('correctly hit tests balloon bounds', () => {
    const balloon = createDefaultSpeechBalloon(100, 100, 200, 200, 'thought');

    expect(hitTestBalloon(balloon, { x: 150, y: 150 })).toBe(true);
    expect(hitTestBalloon(balloon, { x: 50, y: 50 })).toBe(false);
    expect(hitTestBalloon(balloon, { x: 400, y: 400 })).toBe(false);
  });
});
