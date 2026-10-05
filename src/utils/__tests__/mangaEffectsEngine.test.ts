import { describe, it, expect } from 'vitest';
import {
  renderSaturatedLines,
  renderStreamLines,
  SaturatedLinesOptions,
  StreamLinesOptions,
} from '../mangaEffectsEngine';

describe('Manga Effect Lines Generator Engine', () => {
  it('renders saturated focus lines without throwing errors', () => {
    // Mock minimal Canvas 2D context
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      beginPath: () => calls.push('beginPath'),
      moveTo: () => calls.push('moveTo'),
      lineTo: () => calls.push('lineTo'),
      closePath: () => calls.push('closePath'),
      fill: () => calls.push('fill'),
      fillStyle: '',
      strokeStyle: '',
    } as unknown as CanvasRenderingContext2D;

    const options: SaturatedLinesOptions = {
      centerX: 400,
      centerY: 400,
      innerRadius: 100,
      density: 20,
      spacingJitter: 0.3,
      lengthJitter: 0.2,
      lineWidth: 3,
      color: '#000000',
    };

    renderSaturatedLines(ctx, 800, 800, options);
    expect(calls).toContain('save');
    expect(calls).toContain('restore');
    expect(calls).toContain('fill');
    expect(calls.filter((c) => c === 'fill').length).toBe(20);
  });

  it('renders directional stream lines without throwing errors', () => {
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      beginPath: () => calls.push('beginPath'),
      moveTo: () => calls.push('moveTo'),
      lineTo: () => calls.push('lineTo'),
      closePath: () => calls.push('closePath'),
      fill: () => calls.push('fill'),
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D;

    const options: StreamLinesOptions = {
      angle: 45,
      density: 15,
      lineLength: 300,
      lengthNoise: 0.3,
      thickness: 4,
      thicknessNoise: 0.3,
      gapNoise: 0.2,
      color: '#000000',
    };

    renderStreamLines(ctx, 800, 800, options);
    expect(calls).toContain('save');
    expect(calls).toContain('restore');
    expect(calls.filter((c) => c === 'fill').length).toBe(15);
  });
});
