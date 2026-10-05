import { describe, it, expect } from 'vitest';
import {
  rgbToHsv,
  hsvToRgb,
  applyColorDynamics,
  drawRadialCubicBezierSegment,
  drawRadialDot,
  drawTexturedDot,
  TexturedBrushOptions,
} from '../stampEngine';
import { WebGlBrushEngine } from '../webglBrushEngine';
import { BrushSettings, BrushDynamics, Point } from '../../types/editor';

function createMockCanvas(width: number = 200, height: number = 200) {
  const drawnDabs: { x: number; y: number; width: number; height: number; alpha: number; angle?: number }[] = [];
  const ctx: any = {
    canvas: { width, height },
    globalAlpha: 1.0,
    globalCompositeOperation: 'source-over',
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: (rad: number) => {
      if (drawnDabs.length > 0) {
        drawnDabs[drawnDabs.length - 1].angle = rad;
      }
    },
    drawImage: (_img: any, dx: number, dy: number, dw?: number, dh?: number) => {
      drawnDabs.push({
        x: dx,
        y: dy,
        width: dw || 0,
        height: dh || 0,
        alpha: ctx.globalAlpha,
      });
    },
    clearRect: () => {},
    fillRect: () => {},
    createImageData: (w: number, h: number) => ({
      width: w,
      height: h,
      data: new Uint8ClampedArray(w * h * 4),
    }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: () => {},
  };
  return {
    width,
    height,
    canvas: { width, height },
    getContext: () => ctx,
    ctx,
    drawnDabs,
  };
}

(globalThis as any).document = {
  createElement: () => createMockCanvas(),
};

describe('Brush Dynamics & Multi-Axis Jitter Matrix', () => {
  describe('Color Dynamics & HSV conversions', () => {
    it('converts pure red, green, blue correctly to HSV and back', () => {
      const red = rgbToHsv(1, 0, 0);
      expect(red[0]).toBeCloseTo(0);
      expect(red[1]).toBeCloseTo(1);
      expect(red[2]).toBeCloseTo(1);
      const redRgb = hsvToRgb(red[0], red[1], red[2]);
      expect(redRgb[0]).toBeCloseTo(1);
      expect(redRgb[1]).toBeCloseTo(0);
      expect(redRgb[2]).toBeCloseTo(0);

      const green = rgbToHsv(0, 1, 0);
      expect(green[0]).toBeCloseTo(120);
      expect(green[1]).toBeCloseTo(1);
      expect(green[2]).toBeCloseTo(1);
      const greenRgb = hsvToRgb(green[0], green[1], green[2]);
      expect(greenRgb[0]).toBeCloseTo(0);
      expect(greenRgb[1]).toBeCloseTo(1);
      expect(greenRgb[2]).toBeCloseTo(0);

      const blue = rgbToHsv(0, 0, 1);
      expect(blue[0]).toBeCloseTo(240);
      expect(blue[1]).toBeCloseTo(1);
      expect(blue[2]).toBeCloseTo(1);
      const blueRgb = hsvToRgb(blue[0], blue[1], blue[2]);
      expect(blueRgb[0]).toBeCloseTo(0);
      expect(blueRgb[1]).toBeCloseTo(0);
      expect(blueRgb[2]).toBeCloseTo(1);
    });

    it('returns original color when colorJitterEnabled is false', () => {
      const dynamics: BrushDynamics = {
        sizeJitter: 0,
        angleJitter: 0,
        roundnessJitter: 0,
        scatter: 0,
        scatterBothAxes: false,
        count: 1,
        flowJitter: 0,
        colorJitterEnabled: false,
        hueJitter: 0.5,
        saturationJitter: 0.5,
        brightnessJitter: 0.5,
        foregroundBackgroundJitter: 0.5,
      };

      const result = applyColorDynamics({ r: 0.2, g: 0.4, b: 0.6 }, { r: 1, g: 1, b: 1 }, dynamics);
      expect(result.r).toBeCloseTo(0.2);
      expect(result.g).toBeCloseTo(0.4);
      expect(result.b).toBeCloseTo(0.6);
    });

    it('applies color dynamics when colorJitterEnabled is true', () => {
      const dynamics: BrushDynamics = {
        sizeJitter: 0,
        angleJitter: 0,
        roundnessJitter: 0,
        scatter: 0,
        scatterBothAxes: false,
        count: 1,
        flowJitter: 0,
        colorJitterEnabled: true,
        hueJitter: 0.2,
        saturationJitter: 0.2,
        brightnessJitter: 0.2,
        foregroundBackgroundJitter: 0.3,
      };

      const result = applyColorDynamics({ r: 0.8, g: 0.2, b: 0.2 }, { r: 0.1, g: 0.9, b: 0.1 }, dynamics);
      expect(result.r).toBeGreaterThanOrEqual(0);
      expect(result.r).toBeLessThanOrEqual(1);
      expect(result.g).toBeGreaterThanOrEqual(0);
      expect(result.g).toBeLessThanOrEqual(1);
      expect(result.b).toBeGreaterThanOrEqual(0);
      expect(result.b).toBeLessThanOrEqual(1);
      expect(result.hex).toMatch(/^#[0-9a-f]{6}$/i);
    });
  });

  describe('WebGL Brush Engine generateArcLengthDabs Jitter Matrix', () => {
    const gpuEngine = WebGlBrushEngine.getInstance();
    const p0: Point = { x: 10, y: 10, pressure: 1.0, width: 20 };
    const control: Point = { x: 50, y: 10, pressure: 1.0, width: 20 };
    const p2: Point = { x: 90, y: 10, pressure: 1.0, width: 20 };

    const baseSettings: BrushSettings = {
      size: 20,
      minSizeFactor: 0.2,
      color: '#ff0000',
      opacity: 1.0,
      flow: 0.9,
      spacing: 0.1,
      usePressure: false,
      smoothing: false,
      stabilization: 0,
      hardness: 1.0,
      thickness: 1.0,
    };

    it('emits count dabs per interval', () => {
      const settings1: BrushSettings = {
        ...baseSettings,
        dynamics: {
          sizeJitter: 0,
          angleJitter: 0,
          roundnessJitter: 0,
          scatter: 0,
          scatterBothAxes: false,
          count: 1,
          flowJitter: 0,
          colorJitterEnabled: false,
          hueJitter: 0,
          saturationJitter: 0,
          brightnessJitter: 0,
          foregroundBackgroundJitter: 0,
        },
      };

      const settings3: BrushSettings = {
        ...baseSettings,
        dynamics: {
          ...settings1.dynamics!,
          count: 3,
        },
      };

      const res1 = gpuEngine.generateArcLengthDabs(p0, control, p2, settings1, '#ff0000');
      const res3 = gpuEngine.generateArcLengthDabs(p0, control, p2, settings3, '#ff0000');

      expect(res3.dabs.length).toBe(res1.dabs.length * 3);
    });

    it('applies size jitter variance', () => {
      const settings: BrushSettings = {
        ...baseSettings,
        dynamics: {
          sizeJitter: 0.8,
          angleJitter: 0,
          roundnessJitter: 0,
          scatter: 0,
          scatterBothAxes: false,
          count: 5,
          flowJitter: 0,
          colorJitterEnabled: false,
          hueJitter: 0,
          saturationJitter: 0,
          brightnessJitter: 0,
          foregroundBackgroundJitter: 0,
        },
      };

      const res = gpuEngine.generateArcLengthDabs(p0, control, p2, settings, '#ff0000');
      const widths = res.dabs.map((d) => d.width);
      const minW = Math.min(...widths);
      const maxW = Math.max(...widths);

      expect(widths.length).toBeGreaterThan(10);
      expect(minW).toBeLessThan(maxW);
      expect(minW).toBeGreaterThanOrEqual(0.1);
    });

    it('applies angle jitter variance', () => {
      const settings: BrushSettings = {
        ...baseSettings,
        dynamics: {
          sizeJitter: 0,
          angleJitter: 0.9,
          roundnessJitter: 0,
          scatter: 0,
          scatterBothAxes: false,
          count: 5,
          flowJitter: 0,
          colorJitterEnabled: false,
          hueJitter: 0,
          saturationJitter: 0,
          brightnessJitter: 0,
          foregroundBackgroundJitter: 0,
        },
      };

      const res = gpuEngine.generateArcLengthDabs(p0, control, p2, settings, '#ff0000');
      const angles = res.dabs.map((d) => d.angle);
      const minA = Math.min(...angles);
      const maxA = Math.max(...angles);

      expect(maxA - minA).toBeGreaterThan(0.5);
    });

    it('applies scatter offset along normal', () => {
      // Stroke is horizontal (y = 10), so perpendicular normal is along Y
      const settings: BrushSettings = {
        ...baseSettings,
        dynamics: {
          sizeJitter: 0,
          angleJitter: 0,
          roundnessJitter: 0,
          scatter: 2.0,
          scatterBothAxes: false,
          count: 5,
          flowJitter: 0,
          colorJitterEnabled: false,
          hueJitter: 0,
          saturationJitter: 0,
          brightnessJitter: 0,
          foregroundBackgroundJitter: 0,
        },
      };

      const res = gpuEngine.generateArcLengthDabs(p0, control, p2, settings, '#ff0000');
      const yCoords = res.dabs.map((d) => d.y);
      const minY = Math.min(...yCoords);
      const maxY = Math.max(...yCoords);

      expect(maxY - minY).toBeGreaterThan(5);
    });

    it('applies flow jitter variance', () => {
      const settings: BrushSettings = {
        ...baseSettings,
        dynamics: {
          sizeJitter: 0,
          angleJitter: 0,
          roundnessJitter: 0,
          scatter: 0,
          scatterBothAxes: false,
          count: 5,
          flowJitter: 0.8,
          colorJitterEnabled: false,
          hueJitter: 0,
          saturationJitter: 0,
          brightnessJitter: 0,
          foregroundBackgroundJitter: 0,
        },
      };

      const res = gpuEngine.generateArcLengthDabs(p0, control, p2, settings, '#ff0000');
      const alphas = res.dabs.map((d) => d.alpha);
      const minA = Math.min(...alphas);
      const maxA = Math.max(...alphas);

      expect(minA).toBeLessThan(maxA);
    });

    it('applies color dynamics jitter to dab RGB values', () => {
      const settings: BrushSettings = {
        ...baseSettings,
        secondaryColor: '#00ff00',
        dynamics: {
          sizeJitter: 0,
          angleJitter: 0,
          roundnessJitter: 0,
          scatter: 0,
          scatterBothAxes: false,
          count: 5,
          flowJitter: 0,
          colorJitterEnabled: true,
          hueJitter: 0.5,
          saturationJitter: 0.5,
          brightnessJitter: 0.5,
          foregroundBackgroundJitter: 0.5,
        },
      };

      const res = gpuEngine.generateArcLengthDabs(p0, control, p2, settings, '#ff0000');
      const colors = res.dabs.map((d) => [d.r, d.g, d.b]);
      // Check that not all dabs are identical pure red
      const nonPureRed = colors.some(([r, g, b]) => g > 0.05 || b > 0.05 || r < 0.95);
      expect(nonPureRed).toBe(true);
    });
  });

  describe('Stamp Engine 2D Jitter Matrix Execution', () => {
    it('executes drawRadialCubicBezierSegment with dynamics count and scatter', () => {
      const { ctx, drawnDabs } = createMockCanvas();
      const p0: Point = { x: 10, y: 20, pressure: 1.0, width: 10 };
      const c1: Point = { x: 30, y: 20, pressure: 1.0, width: 10 };
      const c2: Point = { x: 50, y: 20, pressure: 1.0, width: 10 };
      const p3: Point = { x: 70, y: 20, pressure: 1.0, width: 10 };

      const dynamics: BrushDynamics = {
        sizeJitter: 0.5,
        angleJitter: 0.5,
        roundnessJitter: 0.5,
        scatter: 1.5,
        scatterBothAxes: true,
        count: 2,
        flowJitter: 0.5,
        colorJitterEnabled: true,
        hueJitter: 0.2,
        saturationJitter: 0.2,
        brightnessJitter: 0.2,
        foregroundBackgroundJitter: 0.3,
      };

      drawRadialCubicBezierSegment(
        ctx,
        p0,
        c1,
        c2,
        p3,
        '#ff0000',
        1.0,
        1.0,
        0.1,
        false,
        false,
        0,
        1.0,
        0,
        { dynamics, secondaryColor: '#0000ff' }
      );

      expect(drawnDabs.length).toBeGreaterThan(0);
    });

    it('executes drawRadialDot with dynamics jitter', () => {
      const { ctx, drawnDabs } = createMockCanvas();
      const point: Point = { x: 50, y: 50, pressure: 1.0, width: 15 };

      const dynamics: BrushDynamics = {
        sizeJitter: 0.4,
        angleJitter: 0.4,
        roundnessJitter: 0.4,
        scatter: 1.0,
        scatterBothAxes: false,
        count: 3,
        flowJitter: 0.3,
        colorJitterEnabled: true,
        hueJitter: 0.1,
        saturationJitter: 0.1,
        brightnessJitter: 0.1,
        foregroundBackgroundJitter: 0.2,
      };

      drawRadialDot(ctx, point, '#336699', 0.9, 0.8, false, false, {
        dynamics,
        secondaryColor: '#ffffff',
      });

      expect(drawnDabs.length).toBe(3);
    });

    it('executes drawTexturedDot with dynamics count and jitter', () => {
      const { ctx, drawnDabs } = createMockCanvas();
      const point: Point = { x: 40, y: 40, pressure: 1.0, width: 20 };
      const tipImg: any = { naturalWidth: 64, naturalHeight: 64, width: 64, height: 64, src: 'tip.png' };

      const options: TexturedBrushOptions = {
        size: 20,
        dynamics: {
          sizeJitter: 0.5,
          angleJitter: 0.5,
          roundnessJitter: 0.5,
          scatter: 1.2,
          scatterBothAxes: false,
          count: 4,
          flowJitter: 0.4,
          colorJitterEnabled: true,
          hueJitter: 0.2,
          saturationJitter: 0.2,
          brightnessJitter: 0.2,
          foregroundBackgroundJitter: 0.2,
        },
        secondaryColor: '#ffffff',
      };

      drawTexturedDot(ctx, point, '#ff5500', tipImg, options);
      expect(drawnDabs.length).toBe(4);
    });
  });
});
