// Soft Proofing and Gamut Warning Post-Processing Shaders
export const SOFT_PROOF_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 a_quadPos; // [0, 1] x [0, 1]
out vec2 v_uv;
void main() {
  v_uv = a_quadPos;
  gl_Position = vec4(a_quadPos.x * 2.0 - 1.0, a_quadPos.y * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const SOFT_PROOF_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_sceneTexture;
uniform int u_standard; // 0: japan-color-2001, 1: us-web-coated-swop, 2: iso-coated-v2
uniform int u_proofEnabled; // 1 or 0
uniform int u_gamutWarning; // 1 or 0
uniform vec3 u_gamutWarningColor;

out vec4 fragColor;

// sRGB to Linear RGB
vec3 srgbToLinear(vec3 c) {
  return mix(
    c / 12.92,
    pow((c + 0.055) / 1.055, vec3(2.4)),
    step(vec3(0.04045), c)
  );
}

// Linear RGB to sRGB
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(
    c * 12.92,
    1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), c)
  );
}

// Linear sRGB to CIE XYZ (D65)
vec3 linearToXyz(vec3 rgb) {
  return vec3(
    dot(rgb, vec3(0.4124564, 0.3575761, 0.1804375)),
    dot(rgb, vec3(0.2126729, 0.7151522, 0.0721750)),
    dot(rgb, vec3(0.0193339, 0.1191920, 0.9503041))
  );
}

// CIE XYZ (D65) to CIE Lab
float fLab(float t) {
  const float delta = 6.0 / 29.0;
  const float delta3 = delta * delta * delta;
  return (t > delta3) ? pow(t, 1.0 / 3.0) : (t / (3.0 * delta * delta) + 4.0 / 29.0);
}

vec3 xyzToLab(vec3 xyz) {
  vec3 white = vec3(0.95047, 1.0, 1.08883);
  vec3 v = xyz / white;
  float fx = fLab(v.x);
  float fy = fLab(v.y);
  float fz = fLab(v.z);
  return vec3(
    116.0 * fy - 16.0,
    500.0 * (fx - fy),
    200.0 * (fy - fz)
  );
}

vec3 srgbToLab(vec3 srgb) {
  vec3 lin = srgbToLinear(clamp(srgb, 0.0, 1.0));
  vec3 xyz = linearToXyz(lin);
  return xyzToLab(xyz);
}

// CMYK soft-proofing simulation polynomial
vec3 simulateCmyk(vec3 srgb, int standard) {
  vec3 linRgb = srgbToLinear(clamp(srgb, 0.0, 1.0));
  float c0 = 1.0 - linRgb.r;
  float m0 = 1.0 - linRgb.g;
  float y0 = 1.0 - linRgb.b;

  // Standard 0: Japan Color 2001 (high saturation, clean cyans, TAC ~350%)
  // Standard 1: US Web Coated (SWOP) (warm stock, heavy black, lower gamut, TAC ~300%)
  // Standard 2: ISO Coated v2 (FOGRA39) (balanced European inks, TAC ~330%)
  float tacLimit = 3.5;
  float tvi = 0.14;
  float gcrExp = 1.4;
  float ucrFactor = 0.80;

  vec3 densC = vec3(1.42, 0.17, 0.07);
  vec3 densM = vec3(0.06, 1.35, 0.15);
  vec3 densY = vec3(0.02, 0.04, 1.25);
  vec3 densK = vec3(1.80, 1.80, 1.78);
  vec3 paperReflect = vec3(0.96, 0.96, 0.97);

  if (standard == 1) {
    tacLimit = 3.0;
    tvi = 0.20;
    gcrExp = 1.15;
    ucrFactor = 0.90;
    densC = vec3(1.28, 0.24, 0.14);
    densM = vec3(0.08, 1.22, 0.22);
    densY = vec3(0.03, 0.07, 1.15);
    densK = vec3(1.65, 1.65, 1.62);
    paperReflect = vec3(0.94, 0.93, 0.88);
  } else if (standard == 2) {
    tacLimit = 3.3;
    tvi = 0.16;
    gcrExp = 1.3;
    ucrFactor = 0.85;
    densC = vec3(1.36, 0.19, 0.09);
    densM = vec3(0.07, 1.30, 0.17);
    densY = vec3(0.02, 0.05, 1.20);
    densK = vec3(1.72, 1.72, 1.70);
    paperReflect = vec3(0.95, 0.95, 0.94);
  }

  // Black generation (GCR)
  float k0 = min(c0, min(m0, y0));
  float k = pow(k0, gcrExp);

  // Under Color Removal
  float denom = max(0.001, 1.0 - k * 0.35);
  float c1 = clamp((c0 - k * ucrFactor) / denom, 0.0, 1.0);
  float m1 = clamp((m0 - k * ucrFactor) / denom, 0.0, 1.0);
  float y1 = clamp((y0 - k * ucrFactor) / denom, 0.0, 1.0);

  // Apply TAC limit
  float totalInk = c1 + m1 + y1 + k;
  if (totalInk > tacLimit) {
    float scale = (tacLimit - k) / max(0.001, totalInk - k);
    c1 *= scale;
    m1 *= scale;
    y1 *= scale;
  }

  // Tone Value Increase (dot gain)
  c1 += 4.0 * tvi * c1 * (1.0 - c1);
  m1 += 4.0 * tvi * m1 * (1.0 - m1);
  y1 += 4.0 * tvi * y1 * (1.0 - y1);
  k  += 4.0 * tvi * k  * (1.0 - k);

  c1 = clamp(c1, 0.0, 1.0);
  m1 = clamp(m1, 0.0, 1.0);
  y1 = clamp(y1, 0.0, 1.0);
  k  = clamp(k, 0.0, 1.0);

  // Inter-ink trapping
  float cmTrap = c1 * m1 * 0.12;
  float cyTrap = c1 * y1 * 0.10;
  float myTrap = m1 * y1 * 0.10;

  vec3 totalDensity = c1 * densC + m1 * densM + y1 * densY + k * densK
                    - cmTrap * (densC + densM) * 0.2
                    - cyTrap * (densC + densY) * 0.2
                    - myTrap * (densM + densY) * 0.2;

  // Subtractive reflectance with paper tint and gloss minimum clamp
  vec3 reflectance = paperReflect * exp(-totalDensity * 2.302585);
  reflectance += vec3(0.012);

  return linearToSrgb(reflectance);
}

void main() {
  vec4 sceneColor = texture(u_sceneTexture, v_uv);

  if (sceneColor.a < 0.002) {
    fragColor = sceneColor;
    return;
  }

  // Unpremultiply alpha for true color evaluation
  vec3 rgb = sceneColor.rgb / sceneColor.a;

  // Soft proof simulation
  vec3 proofRgb = simulateCmyk(rgb, u_standard);

  // Gamut evaluation in CIE Lab space
  vec3 labOrig = srgbToLab(rgb);
  vec3 labProof = srgbToLab(proofRgb);

  // Delta-E (CIE76): normalized scale where 100 Lab units = 1.0 (deltaE = norm / 100.0)
  vec3 dLab = labOrig - labProof;
  float deltaE = length(dLab) / 100.0;

  bool isOutOfGamut = (deltaE > 0.05);

  vec3 outRgb = rgb;
  if (u_proofEnabled == 1) {
    outRgb = proofRgb;
  }

  if (u_gamutWarning == 1 && isOutOfGamut) {
    outRgb = u_gamutWarningColor;
  }

  fragColor = vec4(outRgb * sceneColor.a, sceneColor.a);
}
`;
