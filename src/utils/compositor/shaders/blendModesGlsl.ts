/**
 * Shared GLSL ES 3.00 blend mode routines for all WebGL2 compositor fragment shaders.
 * Implements all 28 Ink Studio / Photoshop / CSP blend modes (codes 0..27):
 *   0: normal           10: difference       20: hard-mix
 *   1: multiply         11: exclusion        21: subtract
 *   2: screen           12: pass-through     22: darker-color
 *   3: overlay          13: linear-burn      23: lighter-color
 *   4: darken           14: add-glow         24: hue
 *   5: lighten          15: color-dodge-glow 25: saturation
 *   6: color-dodge      16: divide           26: color
 *   7: color-burn       17: vivid-light      27: luminosity
 *   8: hard-light       18: linear-light
 *   9: soft-light       19: pin-light
 */
export function buildBlendModeGlsl(suffix: string = ''): string {
  return `
float blendLum${suffix}(vec3 c) {
  return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
}

vec3 clipColor${suffix}(vec3 c) {
  float l = clamp(blendLum${suffix}(c), 0.0, 1.0);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) {
    c = l + ((c - l) * l) / max(0.0001, l - n);
  }
  if (x > 1.0) {
    c = l + ((c - l) * (1.0 - l)) / max(0.0001, x - l);
  }
  return clamp(c, 0.0, 1.0);
}

vec3 setLum${suffix}(vec3 c, float l) {
  float d = l - blendLum${suffix}(c);
  return clipColor${suffix}(c + vec3(d));
}

float blendSat${suffix}(vec3 c) {
  return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
}

vec3 setSat${suffix}(vec3 c, float s) {
  float cMin = min(min(c.r, c.g), c.b);
  float cMax = max(max(c.r, c.g), c.b);
  float delta = cMax - cMin;
  if (delta <= 0.0001) {
    return vec3(0.0);
  }
  return ((c - cMin) * s) / delta;
}

float blendChannel${suffix}(float b, float s, int mode) {
  if (mode == 1) return b * s; // multiply
  if (mode == 2) return b + s - b * s; // screen
  if (mode == 3) return b < 0.5 ? (2.0 * b * s) : (1.0 - 2.0 * (1.0 - b) * (1.0 - s)); // overlay
  if (mode == 4) return min(b, s); // darken
  if (mode == 5) return max(b, s); // lighten
  if (mode == 6) return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / max(0.0001, 1.0 - s))); // color-dodge
  if (mode == 7) return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / max(0.0001, s))); // color-burn
  if (mode == 8) return s < 0.5 ? (2.0 * b * s) : (1.0 - 2.0 * (1.0 - b) * (1.0 - s)); // hard-light
  if (mode == 9) { // soft-light (W3C / Photoshop)
    float d = b <= 0.25 ? (((16.0 * b - 12.0) * b + 4.0) * b) : sqrt(max(0.0, b));
    return s <= 0.5 ? (b - (1.0 - 2.0 * s) * b * (1.0 - b)) : (b + (2.0 * s - 1.0) * (d - b));
  }
  if (mode == 10) return abs(b - s); // difference
  if (mode == 11) return b + s - 2.0 * b * s; // exclusion
  if (mode == 13) return max(0.0, b + s - 1.0); // linear-burn
  if (mode == 14) return min(1.0, b + s); // add-glow
  if (mode == 15) return s >= 1.0 ? 1.0 : min(1.0, b / max(0.0001, 1.0 - s)); // color-dodge-glow
  if (mode == 16) return s <= 0.0001 ? 1.0 : clamp(b / s, 0.0, 1.0); // divide
  if (mode == 17) { // vivid-light
    if (s <= 0.5) {
      float s2 = 2.0 * s;
      return s2 <= 0.0 ? 0.0 : (b >= 1.0 ? 1.0 : 1.0 - min(1.0, (1.0 - b) / max(0.0001, s2)));
    } else {
      float s2 = 2.0 * (s - 0.5);
      return s2 >= 1.0 ? 1.0 : (b <= 0.0 ? 0.0 : min(1.0, b / max(0.0001, 1.0 - s2)));
    }
  }
  if (mode == 18) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0); // linear-light
  if (mode == 19) return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * (s - 0.5)); // pin-light
  if (mode == 20) return step(1.0, b + s); // hard-mix
  if (mode == 21) return max(0.0, b - s); // subtract
  return s;
}

vec3 evaluateBlendMode${suffix}(vec3 Cb, vec3 Cs, int mode) {
  if (mode == 22) return blendLum${suffix}(Cs) < blendLum${suffix}(Cb) ? Cs : Cb; // darker-color
  if (mode == 23) return blendLum${suffix}(Cs) > blendLum${suffix}(Cb) ? Cs : Cb; // lighter-color
  if (mode == 24) return setLum${suffix}(setSat${suffix}(Cs, blendSat${suffix}(Cb)), blendLum${suffix}(Cb)); // hue
  if (mode == 25) return setLum${suffix}(setSat${suffix}(Cb, blendSat${suffix}(Cs)), blendLum${suffix}(Cb)); // saturation
  if (mode == 26) return setLum${suffix}(Cs, blendLum${suffix}(Cb)); // color
  if (mode == 27) return setLum${suffix}(Cb, blendLum${suffix}(Cs)); // luminosity
  return vec3(
    blendChannel${suffix}(Cb.r, Cs.r, mode),
    blendChannel${suffix}(Cb.g, Cs.g, mode),
    blendChannel${suffix}(Cb.b, Cs.b, mode)
  );
}
`;
}
