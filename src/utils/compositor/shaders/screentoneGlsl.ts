/**
 * Shared GLSL 300 es Screentone Evaluator for WebGL2 Compositor Shaders
 * (used by both COMPOSITOR_FRAGMENT_SHADER and COMPOSITOR_INSTANCED_FRAGMENT_SHADER).
 *
 * Implements Clip Studio Paint style 1-bit binary screentones using a rational integer-lattice
 * halftone basis (a, b) with exact integer modulo arithmetic:
 * - At 100%+ zoom (u_zoom >= 0.99) and GPU export: 100% pure 1-bit binary black/transparent pixels
 *   snapped to discrete document pixels, with bit-for-bit identical uniform dots across the entire canvas.
 * - Below 100% zoom (u_zoom < 0.99): 2x2 supersampled coverage of the exact 1-bit pattern with smooth
 *   low-zoom anti-moiré convergence when screen pixels approach the halftone cell pitch.
 */
export function buildScreentoneGlsl(): string {
  return `
float evalScreentoneInkAtPixel(vec2 docPx, float density, float a, float b, float denom) {
  float xr = docPx.x * a - docPx.y * b;
  float yr = docPx.x * b + docPx.y * a;
  float u = (mod(xr, denom) / denom) - 0.5;
  float v = (mod(yr, denom) / denom) - 0.5;

  if (u_toneDotShape == 2) {
    // Line (parallel manga hatching)
    return (1.0 - 2.0 * abs(u)) >= (1.0 - density) ? 1.0 : 0.0;
  } else if (u_toneDotShape == 3) {
    // Diamond (area-calibrated)
    float dThresh = density <= 0.5
      ? (1.0 - sqrt(0.5 * density))
      : sqrt(0.5 * (1.0 - density));
    return (1.0 - (abs(u) + abs(v))) >= dThresh ? 1.0 : 0.0;
  } else if (u_toneDotShape == 1) {
    // Smooth continuous Euclidean dot (area-calibrated cosine spot)
    float spot = 0.5 + 0.25 * (cos(6.2831853 * u) + cos(6.2831853 * v));
    float eu = density <= 0.5 ? (2.0 * density) : (2.0 * (1.0 - density));
    float eOff = 0.78539816 * eu - 0.28539816 * eu * eu;
    float eThresh = density <= 0.5 ? (1.0 - eOff) : eOff;
    return spot >= eThresh ? 1.0 : 0.0;
  } else {
    // Clip Studio Paint standard Circle dot (exact geometric round dot)
    float rDot = density <= 0.78539816
      ? sqrt(density * 0.31830989)
      : (0.70710678 - 0.20710678 * pow(max(0.0, (1.0 - density) / 0.21460184), 0.43));
    return (u * u + v * v) <= (rDot * rDot + 0.000001) ? 1.0 : 0.0;
  }
}

vec4 evaluateScreentone(vec4 srcColor, vec2 docCoord) {
  if (srcColor.a < 0.0039) {
    return vec4(0.0);
  }

  float density;
  if (u_toneDensityType == 0) {
    // Specified density (dedicated CSP tone layer)
    density = clamp(u_toneDensity * srcColor.a, 0.0, 1.0);
  } else {
    // Image brightness luminance mode
    float lum = dot(srcColor.rgb, vec3(0.299, 0.587, 0.114));
    density = clamp((1.0 - lum) * srcColor.a, 0.0, 1.0);
  }

  if (density <= 0.001) return vec4(0.0);
  if (density >= 0.999) return vec4(0.0, 0.0, 0.0, 1.0);

  float cellSize = max(3.5, u_toneDpi / max(1.0, u_toneFrequency));
  float cosA = cos(u_toneAngleRad);
  float sinA = sin(u_toneAngleRad);

  float a = floor(cellSize * cosA + 0.5);
  float b = floor(cellSize * sinA + 0.5);
  float denom = a * a + b * b;
  if (denom < 4.0) {
    float fb = max(2.0, floor(cellSize + 0.5));
    if (abs(cosA) >= abs(sinA)) {
      a = cosA >= 0.0 ? fb : -fb;
      b = 0.0;
    } else {
      a = 0.0;
      b = sinA >= 0.0 ? fb : -fb;
    }
    denom = a * a + b * b;
  }

  // At 100%+ zoom (and 1:1 GPU export), emit strictly 1-bit binary Clip Studio Paint pixels
  if (u_zoom >= 0.99) {
    float ink = evalScreentoneInkAtPixel(floor(docCoord), density, a, b, denom);
    return vec4(0.0, 0.0, 0.0, ink);
  }

  // Below 100% zoom: 2x2 supersampled coverage of the exact 1-bit binary lattice
  vec2 dx = dFdx(docCoord);
  vec2 dy = dFdy(docCoord);
  float s0 = evalScreentoneInkAtPixel(floor(docCoord - 0.25 * dx - 0.25 * dy), density, a, b, denom);
  float s1 = evalScreentoneInkAtPixel(floor(docCoord + 0.25 * dx - 0.25 * dy), density, a, b, denom);
  float s2 = evalScreentoneInkAtPixel(floor(docCoord - 0.25 * dx + 0.25 * dy), density, a, b, denom);
  float s3 = evalScreentoneInkAtPixel(floor(docCoord + 0.25 * dx + 0.25 * dy), density, a, b, denom);
  float ssCoverage = 0.25 * (s0 + s1 + s2 + s3);

  // Only transition to continuous average tone when a screen pixel approaches the cell pitch
  float cellPx = sqrt(denom);
  float footprint = max(length(dx), length(dy));
  float moireBlend = 1.0 - smoothstep(cellPx * 0.35, cellPx * 0.85, footprint);
  return vec4(0.0, 0.0, 0.0, mix(density, ssCoverage, moireBlend));
}
`;
}
