import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SPHERE_LIGHTING,
  DEFAULT_SPHERE_SLOTS,
  MAX_MARKER_RADIUS,
  SPHERE_LIGHTING_PRESETS,
  buildSphereGeometryLut,
  clampMarkerPosition,
  evaluateSphereColor,
  projectSphereMarker,
  renderSphereFromLut,
  updateSphereLightingLut,
} from '../sphereColorMath';
import { rgbToHex } from '../colorUtils';

describe('sphereColorMath', () => {
  it('produces bright highlight, base midtone, and painterly chromatic shadow (not black)', () => {
    const slots = {
      shadow: { h: 225, s: 0.65, v: 0.5 }, // vivid cool blue shadow
      base: { h: 150, s: 0.3, v: 0.65 },   // sage base
      light: { h: 45, s: 0.25, v: 0.98 },  // warm highlight
    };

    const highlight = evaluateSphereColor({ x: -0.45, y: 0.55 }, slots, DEFAULT_SPHERE_LIGHTING);
    const midtone = evaluateSphereColor({ x: 0, y: 0 }, slots, DEFAULT_SPHERE_LIGHTING);
    const shadow = evaluateSphereColor({ x: 0.65, y: -0.45 }, slots, DEFAULT_SPHERE_LIGHTING);

    const lum = (c: { r: number; g: number; b: number }) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    expect(lum(highlight.rgb)).toBeGreaterThan(lum(midtone.rgb));
    expect(lum(midtone.rgb)).toBeGreaterThan(lum(shadow.rgb));

    // Shadow must be deeply sculpted like reference (not washed out) yet painterly blue-tinted (not black)
    expect(lum(shadow.rgb)).toBeGreaterThan(8);
    expect(lum(shadow.rgb)).toBeLessThan(70);
    expect(shadow.rgb.b).toBeGreaterThan(shadow.rgb.r);

    // HEX and RGB stay strictly synchronized
    expect(highlight.hex).toBe(rgbToHex(highlight.rgb.r, highlight.rgb.g, highlight.rgb.b));
    expect(midtone.hex).toBe(rgbToHex(midtone.rgb.r, midtone.rgb.g, midtone.rgb.b));
    expect(shadow.hex).toBe(rgbToHex(shadow.rgb.r, shadow.rgb.g, shadow.rgb.b));
  });

  it('adds soft bounce light along the bottom shadow edge when enabled', () => {
    const noBounce = evaluateSphereColor(
      { x: 0.25, y: -0.82 },
      DEFAULT_SPHERE_SLOTS,
      { ...DEFAULT_SPHERE_LIGHTING, bounceIntensity: 0 }
    );
    const withBounce = evaluateSphereColor(
      { x: 0.25, y: -0.82 },
      DEFAULT_SPHERE_SLOTS,
      { ...DEFAULT_SPHERE_LIGHTING, bounceIntensity: 0.55 }
    );

    const sum = (c: { r: number; g: number; b: number }) => c.r + c.g + c.b;
    expect(sum(withBounce.rgb)).toBeGreaterThan(sum(noBounce.rgb));
  });

  it('dynamically shifts sphere shading when shadow, base, or light hue changes', () => {
    const warmShadow = evaluateSphereColor(
      { x: 0.68, y: -0.4 },
      { ...DEFAULT_SPHERE_SLOTS, shadow: { h: 10, s: 0.7, v: 0.5 } },
      DEFAULT_SPHERE_LIGHTING
    );
    const coolShadow = evaluateSphereColor(
      { x: 0.68, y: -0.4 },
      { ...DEFAULT_SPHERE_SLOTS, shadow: { h: 220, s: 0.7, v: 0.5 } },
      DEFAULT_SPHERE_LIGHTING
    );
    expect(warmShadow.rgb.r).toBeGreaterThan(coolShadow.rgb.r);
    expect(coolShadow.rgb.b).toBeGreaterThan(warmShadow.rgb.b);
  });

  it('foreshortens the 3D marker disc into an ellipse near edges and clamps drag coordinates', () => {
    const center = projectSphereMarker({ x: 0, y: 0 }, 240, 0.465, DEFAULT_SPHERE_LIGHTING);
    const edge = projectSphereMarker({ x: 0.85, y: 0 }, 240, 0.465, DEFAULT_SPHERE_LIGHTING);

    expect(center.rx).toBeCloseTo(center.ry, 3);
    expect(center.extrudeShift).toBeCloseTo(0, 3);

    expect(edge.ry).toBeLessThan(edge.rx * 0.6);
    expect(edge.extrudeShift).toBeGreaterThan(2);

    const clamped = clampMarkerPosition(2.5, -2.5);
    expect(Math.hypot(clamped.x, clamped.y)).toBeCloseTo(MAX_MARKER_RADIUS, 5);
  });

  it('matches LUT rendered canvas pixels with evaluateSphereColor at center within dither tolerance', () => {
    const size = 120;
    const lut = buildSphereGeometryLut(size, size, 0.465);
    updateSphereLightingLut(lut, DEFAULT_SPHERE_LIGHTING);

    const buffer = new Uint8ClampedArray(size * size * 4);
    const mockCtx = {
      createImageData: vi.fn((w: number, h: number) => ({
        width: w,
        height: h,
        data: buffer,
      })),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    renderSphereFromLut(mockCtx, lut, DEFAULT_SPHERE_SLOTS, DEFAULT_SPHERE_LIGHTING);
    expect(mockCtx.putImageData).toHaveBeenCalledTimes(1);

    const cx = Math.floor(size / 2);
    const cy = Math.floor(size / 2);
    const offset = (cy * size + cx) * 4;
    const centerEval = evaluateSphereColor({ x: 0, y: 0 }, DEFAULT_SPHERE_SLOTS, DEFAULT_SPHERE_LIGHTING);

    expect(Math.abs(buffer[offset] - centerEval.rgb.r)).toBeLessThanOrEqual(3);
    expect(Math.abs(buffer[offset + 1] - centerEval.rgb.g)).toBeLessThanOrEqual(3);
    expect(Math.abs(buffer[offset + 2] - centerEval.rgb.b)).toBeLessThanOrEqual(3);
    expect(buffer[offset + 3]).toBe(255);
  });

  it('adjusts light brightness/dimness via lightIntensity across the sphere', () => {
    const dim = evaluateSphereColor(
      { x: -0.25, y: 0.3 },
      DEFAULT_SPHERE_SLOTS,
      { ...DEFAULT_SPHERE_LIGHTING, lightIntensity: 0.25 }
    );
    const neutral = evaluateSphereColor(
      { x: -0.25, y: 0.3 },
      DEFAULT_SPHERE_SLOTS,
      { ...DEFAULT_SPHERE_LIGHTING, lightIntensity: 1.0 }
    );
    const bright = evaluateSphereColor(
      { x: -0.25, y: 0.3 },
      DEFAULT_SPHERE_SLOTS,
      { ...DEFAULT_SPHERE_LIGHTING, lightIntensity: 1.85 }
    );

    const lum = (c: { r: number; g: number; b: number }) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    expect(lum(dim.rgb)).toBeLessThan(lum(neutral.rgb));
    expect(lum(neutral.rgb)).toBeLessThan(lum(bright.rgb));
  });

  it('produces pure neutral grayscale across all lighting zones when saturation is 0 (B&W mode)', () => {
    const vividSlots = {
      shadow: { h: 240, s: 0.85, v: 0.45 },
      base: { h: 12, s: 0.8, v: 0.7 },
      light: { h: 55, s: 0.7, v: 0.98 },
    };
    const bwConfig = { ...DEFAULT_SPHERE_LIGHTING, saturation: 0 };

    for (const pt of [
      { x: -0.45, y: 0.5 },
      { x: 0, y: 0 },
      { x: 0.65, y: -0.45 },
    ]) {
      const res = evaluateSphereColor(pt, vividSlots, bwConfig);
      expect(res.rgb.r).toBe(res.rgb.g);
      expect(res.rgb.g).toBe(res.rgb.b);
    }
  });

  it('adjusts tonal spread and shadow depth via contrast', () => {
    const lum = (c: { r: number; g: number; b: number }) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    const lowCtrHi = evaluateSphereColor({ x: -0.4, y: 0.5 }, DEFAULT_SPHERE_SLOTS, {
      ...DEFAULT_SPHERE_LIGHTING,
      contrast: 0.5,
    });
    const lowCtrSh = evaluateSphereColor({ x: 0.65, y: -0.45 }, DEFAULT_SPHERE_SLOTS, {
      ...DEFAULT_SPHERE_LIGHTING,
      contrast: 0.5,
    });
    const highCtrHi = evaluateSphereColor({ x: -0.4, y: 0.5 }, DEFAULT_SPHERE_SLOTS, {
      ...DEFAULT_SPHERE_LIGHTING,
      contrast: 1.8,
    });
    const highCtrSh = evaluateSphereColor({ x: 0.65, y: -0.45 }, DEFAULT_SPHERE_SLOTS, {
      ...DEFAULT_SPHERE_LIGHTING,
      contrast: 1.8,
    });

    const lowSpread = lum(lowCtrHi.rgb) - lum(lowCtrSh.rgb);
    const highSpread = lum(highCtrHi.rgb) - lum(highCtrSh.rgb);

    expect(lum(highCtrSh.rgb)).toBeLessThan(lum(lowCtrSh.rgb));
    expect(highSpread).toBeGreaterThan(lowSpread);
  });

  it('produces vivid non-dim colored key lighting via lightTint (Crimson Mood)', () => {
    const crimson = SPHERE_LIGHTING_PRESETS.find((p) => p.id === 'crimson-mood');
    expect(crimson).toBeDefined();

    const lighting = { ...DEFAULT_SPHERE_LIGHTING, ...crimson!.lighting };
    const slots = {
      ...DEFAULT_SPHERE_SLOTS,
      ...crimson!.slots,
    };

    const spec = evaluateSphereColor({ x: -0.35, y: 0.3 }, slots, lighting);
    const lit = evaluateSphereColor({ x: -0.5, y: 0.08 }, slots, lighting);
    const shadow = evaluateSphereColor({ x: 0.65, y: -0.45 }, slots, lighting);

    // Crisp bright wet highlight peak
    expect(spec.rgb.r).toBeGreaterThan(230);
    // Vivid saturated red lit diffuse zone (not dim, not washed out gray)
    expect(lit.rgb.r).toBeGreaterThan(175);
    expect(lit.rgb.r - lit.rgb.g).toBeGreaterThan(100);
    // Deep dramatic crimson shadow (low luminance, distinctly red-shifted)
    const lum = (c: { r: number; g: number; b: number }) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    expect(lum(shadow.rgb)).toBeLessThan(45);
    expect(shadow.rgb.r).toBeLessThan(105);
    expect(shadow.rgb.r).toBeGreaterThan(shadow.rgb.b);
  });

  it('lifts dimness via ambientIntensity and illuminates silhouette edges via rim slot', () => {
    const lum = (c: { r: number; g: number; b: number }) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

    const darkAmb = evaluateSphereColor({ x: 0.5, y: -0.35 }, DEFAULT_SPHERE_SLOTS, {
      ...DEFAULT_SPHERE_LIGHTING,
      ambientIntensity: 0,
    });
    const brightAmb = evaluateSphereColor({ x: 0.5, y: -0.35 }, DEFAULT_SPHERE_SLOTS, {
      ...DEFAULT_SPHERE_LIGHTING,
      ambientIntensity: 0.75,
    });
    expect(lum(brightAmb.rgb)).toBeGreaterThan(lum(darkAmb.rgb) + 40);

    const cyanRimSlots = {
      ...DEFAULT_SPHERE_SLOTS,
      rim: { h: 185, s: 0.98, v: 1.0 },
    };
    const noRim = evaluateSphereColor({ x: 0.92, y: -0.1 }, cyanRimSlots, {
      ...DEFAULT_SPHERE_LIGHTING,
      rimIntensity: 0,
    });
    const strongRim = evaluateSphereColor({ x: 0.92, y: -0.1 }, cyanRimSlots, {
      ...DEFAULT_SPHERE_LIGHTING,
      rimIntensity: 1.2,
    });
    expect(strongRim.rgb.b).toBeGreaterThan(noRim.rgb.b + 40);
    expect(strongRim.rgb.g).toBeGreaterThan(noRim.rgb.g + 40);
  });

  it('adds warm chromatic glow along the terminator via subsurface and stays LUT-synced', () => {
    const crimson = SPHERE_LIGHTING_PRESETS.find((p) => p.id === 'crimson-mood')!;
    const slots = { ...DEFAULT_SPHERE_SLOTS, ...crimson.slots };
    const noSss = evaluateSphereColor({ x: 0.35, y: -0.2 }, slots, {
      ...DEFAULT_SPHERE_LIGHTING,
      ...crimson.lighting,
      subsurface: 0,
    });
    const withSss = evaluateSphereColor({ x: 0.35, y: -0.2 }, slots, {
      ...DEFAULT_SPHERE_LIGHTING,
      ...crimson.lighting,
      subsurface: 0.9,
    });
    expect(withSss.rgb.r).toBeGreaterThan(noSss.rgb.r);

    // Verify LUT render matches evaluateSphereColor under Crimson Mood (all 7 factors active)
    const size = 120;
    const lighting = { ...DEFAULT_SPHERE_LIGHTING, ...crimson.lighting };
    const lut = buildSphereGeometryLut(size, size, 0.465);
    updateSphereLightingLut(lut, lighting);
    const buffer = new Uint8ClampedArray(size * size * 4);
    const mockCtx = {
      createImageData: vi.fn((w: number, h: number) => ({ width: w, height: h, data: buffer })),
      putImageData: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    renderSphereFromLut(mockCtx, lut, slots, lighting);
    const cx = Math.floor(size / 2);
    const cy = Math.floor(size / 2);
    const offset = (cy * size + cx) * 4;
    const centerEval = evaluateSphereColor({ x: 0, y: 0 }, slots, lighting);

    expect(Math.abs(buffer[offset] - centerEval.rgb.r)).toBeLessThanOrEqual(3);
    expect(Math.abs(buffer[offset + 1] - centerEval.rgb.g)).toBeLessThanOrEqual(3);
    expect(Math.abs(buffer[offset + 2] - centerEval.rgb.b)).toBeLessThanOrEqual(3);
  });
});
