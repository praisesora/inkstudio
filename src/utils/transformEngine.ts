import { DirtyRect, LayerItem, Point2D, isFolderLikeLayer } from '../types/editor';
import {
  PixelBuffer,
  isExactQuadTranslation,
  lanczos3Weight,
  renderLosslessAffineChunk,
} from './transformResampler';

export {
  type PixelBuffer,
  type AffineTransformParams,
  type LosslessAffineSpec,
  lanczos3Weight,
  resolveLosslessAffineSpec,
  renderLosslessAffineChunk,
  resampleAffineChunkCpu,
  extractCanvasPixelBuffer,
  processAffineTransformChunks,
} from './transformResampler';

/**
 * Computes the 3x3 projective transformation (homography) parameters
 * mapping unit square [0,1]^2 to quadrilateral (p0, p1, p2, p3).
 * Uses Heckbert's closed-form algorithm.
 */
export function solveUnitSquareToQuad(
  p0: Point2D,
  p1: Point2D,
  p2: Point2D,
  p3: Point2D
): { a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number } {
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const sx = p0.x - p1.x + p2.x - p3.x;

  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sy = p0.y - p1.y + p2.y - p3.y;

  if (Math.abs(sx) < 1e-7 && Math.abs(sy) < 1e-7) {
    // Affine mapping
    return {
      a: p1.x - p0.x,
      b: p3.x - p0.x,
      c: p0.x,
      d: p1.y - p0.y,
      e: p3.y - p0.y,
      f: p0.y,
      g: 0,
      h: 0,
    };
  }

  const det = dx1 * dy2 - dy1 * dx2;
  const g = Math.abs(det) > 1e-7 ? (sx * dy2 - sy * dx2) / det : 0;
  const h = Math.abs(det) > 1e-7 ? (dx1 * sy - dy1 * sx) / det : 0;

  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
}

/**
 * Maps normalized coordinates (u, v) in [0, 1]^2 to target coordinates (x, y)
 * using solved homography.
 */
export function evaluateHomography(
  h: { a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number },
  u: number,
  v: number
): Point2D {
  const denom = h.g * u + h.h * v + 1;
  const safeDenom = Math.abs(denom) < 1e-5 ? (denom < 0 ? -1e-5 : 1e-5) : denom;
  return {
    x: (h.a * u + h.b * v + h.c) / safeDenom,
    y: (h.d * u + h.e * v + h.f) / safeDenom,
  };
}

/**
 * 1D Catmull-Rom spline evaluation passing through p1 and p2.
 */
function catmullRom1D(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/**
 * Evaluates 2D Catmull-Rom surface point at normalized parameter (u, v) in [0, 1]^2.
 */
export function evaluateMeshSurface(
  meshPoints: Point2D[][],
  u: number,
  v: number
): Point2D {
  const rows = meshPoints.length;
  const cols = meshPoints[0]?.length || 0;
  if (rows < 2 || cols < 2) return { x: 0, y: 0 };

  const clampedU = Math.max(0, Math.min(1, u));
  const clampedV = Math.max(0, Math.min(1, v));

  const scaledU = clampedU * (cols - 1);
  const colIdx = Math.min(Math.floor(scaledU), cols - 2);
  const t = scaledU - colIdx;

  const scaledV = clampedV * (rows - 1);
  const rowIdx = Math.min(Math.floor(scaledV), rows - 2);
  const s = scaledV - rowIdx;

  // Helper to get control point with linear phantom extrapolation beyond borders.
  // Clamping borders to edge points halves the boundary Catmull-Rom tangent and warps
  // even an unmodified mesh by ~1.5% across outer cells.
  const getP = (r: number, c: number): Point2D => {
    const getRowP = (rr: number, cc: number): Point2D => {
      if (cc < 0) {
        const a = meshPoints[rr][0];
        const b = meshPoints[rr][1];
        return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
      }
      if (cc >= cols) {
        const a = meshPoints[rr][cols - 1];
        const b = meshPoints[rr][cols - 2];
        return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
      }
      return meshPoints[rr][cc];
    };

    if (r < 0) {
      const a = getRowP(0, c);
      const b = getRowP(1, c);
      return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
    }
    if (r >= rows) {
      const a = getRowP(rows - 1, c);
      const b = getRowP(rows - 2, c);
      return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
    }
    return getRowP(r, c);
  };

  // Interpolate 4 row spans across u
  const rowPoints: Point2D[] = [];
  for (let r = rowIdx - 1; r <= rowIdx + 2; r++) {
    const p0 = getP(r, colIdx - 1);
    const p1 = getP(r, colIdx);
    const p2 = getP(r, colIdx + 1);
    const p3 = getP(r, colIdx + 2);

    rowPoints.push({
      x: catmullRom1D(p0.x, p1.x, p2.x, p3.x, t),
      y: catmullRom1D(p0.y, p1.y, p2.y, p3.y, t),
    });
  }

  // Interpolate across v
  return {
    x: catmullRom1D(rowPoints[0].x, rowPoints[1].x, rowPoints[2].x, rowPoints[3].x, s),
    y: catmullRom1D(rowPoints[0].y, rowPoints[1].y, rowPoints[2].y, rowPoints[3].y, s),
  };
}

/**
 * Offsets all three edges of a triangle strictly outward along their unit normals
 * by `expand` pixels (with miter clamping for acute vertices).
 * Returns null for degenerate triangles.
 */
export function expandTriangleOutward(
  dx0: number,
  dy0: number,
  dx1: number,
  dy1: number,
  dx2: number,
  dy2: number,
  expand = 0.75
): [number, number, number, number, number, number] | null {
  const e0x = dx1 - dx0;
  const e0y = dy1 - dy0;
  const e1x = dx2 - dx1;
  const e1y = dy2 - dy1;
  const e2x = dx0 - dx2;
  const e2y = dy0 - dy2;

  const area2 = e0x * (dy2 - dy0) - e0y * (dx2 - dx0);
  if (Math.abs(area2) < 1e-6) return null;

  const l0 = Math.hypot(e0x, e0y);
  const l1 = Math.hypot(e1x, e1y);
  const l2 = Math.hypot(e2x, e2y);
  if (l0 < 1e-6 || l1 < 1e-6 || l2 < 1e-6) return null;

  const w = area2 > 0 ? 1 : -1;
  // Outward unit normals for each edge in y-down screen coordinates
  const n0x = (w * e0y) / l0;
  const n0y = (-w * e0x) / l0;
  const n1x = (w * e1y) / l1;
  const n1y = (-w * e1x) / l1;
  const n2x = (w * e2y) / l2;
  const n2y = (-w * e2x) / l2;

  // Miter intersection of each vertex's two adjacent offset edges
  const d0 = Math.max(0.05, 1 + n2x * n0x + n2y * n0y);
  const d1 = Math.max(0.05, 1 + n0x * n1x + n0y * n1y);
  const d2 = Math.max(0.05, 1 + n1x * n2x + n1y * n2y);

  return [
    dx0 + (expand * (n2x + n0x)) / d0,
    dy0 + (expand * (n2y + n0y)) / d0,
    dx1 + (expand * (n0x + n1x)) / d1,
    dy1 + (expand * (n0y + n1y)) / d1,
    dx2 + (expand * (n1x + n2x)) / d2,
    dy2 + (expand * (n1y + n2y)) / d2,
  ];
}

/**
 * Renders an affine-mapped triangle from sourceCanvas onto destination context.
 */
export function drawAffineTriangle(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  sx0: number, sy0: number,
  sx1: number, sy1: number,
  sx2: number, sy2: number,
  dx0: number, dy0: number,
  dx1: number, dy1: number,
  dx2: number, dy2: number
): void {
  const du1 = sx1 - sx0;
  const du2 = sx2 - sx0;
  const dv1 = sy1 - sy0;
  const dv2 = sy2 - sy0;
  const det = du1 * dv2 - du2 * dv1;
  if (Math.abs(det) < 1e-6) return;

  const expanded = expandTriangleOutward(dx0, dy0, dx1, dy1, dx2, dy2, 0.75);
  if (!expanded) return;

  const dx1_0 = dx1 - dx0;
  const dx2_0 = dx2 - dx0;
  const dy1_0 = dy1 - dy0;
  const dy2_0 = dy2 - dy0;

  const a = (dx1_0 * dv2 - dx2_0 * dv1) / det;
  const c = (du1 * dx2_0 - du2 * dx1_0) / det;
  const e = dx0 - a * sx0 - c * sy0;

  const b = (dy1_0 * dv2 - dy2_0 * dv1) / det;
  const d = (du1 * dy2_0 - du2 * dy1_0) / det;
  const f = dy0 - b * sx0 - d * sy0;

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) {
    ctx.imageSmoothingQuality = 'high';
  }
  ctx.beginPath();
  ctx.moveTo(expanded[0], expanded[1]);
  ctx.lineTo(expanded[2], expanded[3]);
  ctx.lineTo(expanded[4], expanded[5]);
  ctx.closePath();
  ctx.clip();

  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.restore();
}

const MESH_VERTEX_SHADER_ES1 = `
  attribute vec2 a_pos;
  attribute vec2 a_uv;
  uniform vec2 u_origin;
  uniform vec2 u_size;
  varying vec2 v_uv;
  void main() {
    vec2 norm = (a_pos - u_origin) / u_size;
    gl_Position = vec4(norm.x * 2.0 - 1.0, 1.0 - norm.y * 2.0, 0.0, 1.0);
    v_uv = a_uv;
  }
`;

const MESH_FRAGMENT_SHADER_ES1 = `
  precision highp float;
  uniform sampler2D u_tex;
  uniform vec2 u_texSize;
  varying vec2 v_uv;

  vec4 cubicWeights(float f) {
    float f2 = f * f;
    float f3 = f2 * f;
    return vec4(
      -0.5 * f + f2 - 0.5 * f3,
      1.0 - 2.5 * f2 + 1.5 * f3,
      0.5 * f + 2.0 * f2 - 1.5 * f3,
      -0.5 * f2 + 0.5 * f3
    );
  }

  vec4 fetchTexel(float x, float y, vec2 invSize) {
    if (x < 0.0 || x >= u_texSize.x || y < 0.0 || y >= u_texSize.y) {
      return vec4(0.0);
    }
    return texture2D(u_tex, vec2((x + 0.5) * invSize.x, (y + 0.5) * invSize.y));
  }

  vec4 fetchRow(vec2 base, float dy, vec4 wx, vec2 invSize) {
    float y = base.y + dy;
    return fetchTexel(base.x - 1.0, y, invSize) * wx.x
         + fetchTexel(base.x,       y, invSize) * wx.y
         + fetchTexel(base.x + 1.0, y, invSize) * wx.z
         + fetchTexel(base.x + 2.0, y, invSize) * wx.w;
  }

  void main() {
    vec2 texPos = v_uv * u_texSize - 0.5;
    vec2 base = floor(texPos);
    vec2 f = texPos - base;
    vec4 wx = cubicWeights(f.x);
    vec4 wy = cubicWeights(f.y);
    vec2 invSize = 1.0 / u_texSize;

    vec4 c = fetchRow(base, -1.0, wx, invSize) * wy.x
           + fetchRow(base,  0.0, wx, invSize) * wy.y
           + fetchRow(base,  1.0, wx, invSize) * wy.z
           + fetchRow(base,  2.0, wx, invSize) * wy.w;

    vec4 n00 = fetchTexel(base.x,       base.y,       invSize);
    vec4 n10 = fetchTexel(base.x + 1.0, base.y,       invSize);
    vec4 n01 = fetchTexel(base.x,       base.y + 1.0, invSize);
    vec4 n11 = fetchTexel(base.x + 1.0, base.y + 1.0, invSize);
    vec4 lo = min(min(n00, n10), min(n01, n11));
    vec4 hi = max(max(n00, n10), max(n01, n11));
    c = clamp(c, lo, hi);

    float a = clamp(c.a, 0.0, 1.0);
    vec3 rgb = clamp(c.rgb, vec3(0.0), vec3(a));
    gl_FragColor = vec4(rgb, a);
  }
`;

const MESH_VERTEX_SHADER_ES3 = `#version 300 es
  in vec2 a_pos;
  in vec2 a_uv;
  uniform vec2 u_origin;
  uniform vec2 u_size;
  uniform float u_flipY;
  out vec2 v_uv;
  void main() {
    vec2 norm = (a_pos - u_origin) / u_size;
    gl_Position = vec4(norm.x * 2.0 - 1.0, (norm.y * 2.0 - 1.0) * u_flipY, 0.0, 1.0);
    v_uv = a_uv;
  }
`;

const MESH_FRAGMENT_SHADER_ES3 = `#version 300 es
  precision highp float;
  uniform sampler2D u_tex;
  uniform vec2 u_texSize;
  uniform int u_outputStraight;
  in vec2 v_uv;
  out vec4 outColor;

  const float PI = 3.14159265358979323846;

  float lanczos3(float x) {
    float ax = abs(x);
    if (ax < 1e-5) return 1.0;
    if (ax >= 3.0) return 0.0;
    float pix = PI * ax;
    return (3.0 * sin(pix) * sin(pix * (1.0 / 3.0))) / (pix * pix);
  }

  vec4 fetchPremul(int ix, int iy, ivec2 texSizeI) {
    if (ix < 0 || ix >= texSizeI.x || iy < 0 || iy >= texSizeI.y) {
      return vec4(0.0);
    }
    vec4 s = texelFetch(u_tex, ivec2(ix, iy), 0);
    return vec4(s.rgb * s.a, s.a);
  }

  vec4 sampleBilinearPremul(vec2 texPos, ivec2 texSizeI) {
    vec2 base = floor(texPos);
    vec2 f = texPos - base;
    int bx = int(base.x);
    int by = int(base.y);
    vec4 c00 = fetchPremul(bx,     by,     texSizeI);
    vec4 c10 = fetchPremul(bx + 1, by,     texSizeI);
    vec4 c01 = fetchPremul(bx,     by + 1, texSizeI);
    vec4 c11 = fetchPremul(bx + 1, by + 1, texSizeI);
    return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
  }

  vec4 sampleLanczos3AR(vec2 uv, ivec2 texSizeI, bool antiRing) {
    vec2 texPos = uv * u_texSize - 0.5;
    vec2 base = floor(texPos);
    vec2 f = texPos - base;
    int bx = int(base.x);
    int by = int(base.y);

    float wx[6];
    float wy[6];
    float sumWx = 0.0;
    float sumWy = 0.0;
    for (int i = 0; i < 6; i++) {
      float offset = float(i - 2);
      float w1 = lanczos3(offset - f.x);
      float w2 = lanczos3(offset - f.y);
      wx[i] = w1;
      wy[i] = w2;
      sumWx += w1;
      sumWy += w2;
    }
    float invSumWx = abs(sumWx) > 1e-6 ? 1.0 / sumWx : 1.0;
    float invSumWy = abs(sumWy) > 1e-6 ? 1.0 / sumWy : 1.0;

    vec4 c = vec4(0.0);
    for (int j = 0; j < 6; j++) {
      int iy = by + j - 2;
      vec4 rowAcc = vec4(0.0);
      for (int i = 0; i < 6; i++) {
        rowAcc += fetchPremul(bx + i - 2, iy, texSizeI) * (wx[i] * invSumWx);
      }
      c += rowAcc * (wy[j] * invSumWy);
    }

    if (antiRing) {
      vec4 n00 = fetchPremul(bx,     by,     texSizeI);
      vec4 n10 = fetchPremul(bx + 1, by,     texSizeI);
      vec4 n01 = fetchPremul(bx,     by + 1, texSizeI);
      vec4 n11 = fetchPremul(bx + 1, by + 1, texSizeI);
      vec4 lo = min(min(n00, n10), min(n01, n11));
      vec4 hi = max(max(n00, n10), max(n01, n11));
      c = clamp(c, lo, hi);
    }

    float a = clamp(c.a, 0.0, 1.0);
    return vec4(clamp(c.rgb, vec3(0.0), vec3(a)), a);
  }

  void main() {
    ivec2 texSizeI = ivec2(u_texSize + 0.5);
    vec2 du = dFdx(v_uv);
    vec2 dv = dFdy(v_uv);
    float footprintX = length(du * u_texSize);
    float footprintY = length(dv * u_texSize);
    float footprint = max(footprintX, footprintY);

    vec4 premul;
    if (footprint <= 1.25) {
      premul = sampleLanczos3AR(v_uv, texSizeI, true);
    } else if (footprint <= 2.25) {
      vec4 acc =
        sampleLanczos3AR(v_uv + du * -0.375 + dv * -0.125, texSizeI, false) +
        sampleLanczos3AR(v_uv + du *  0.125 + dv * -0.375, texSizeI, false) +
        sampleLanczos3AR(v_uv + du *  0.375 + dv *  0.125, texSizeI, false) +
        sampleLanczos3AR(v_uv + du * -0.125 + dv *  0.375, texSizeI, false);
      vec4 res = acc * 0.25;
      float a = clamp(res.a, 0.0, 1.0);
      premul = vec4(clamp(res.rgb, vec3(0.0), vec3(a)), a);
    } else {
      // Adaptive Jacobian-scaled anisotropic supersampling for heavy downscaling (>2.25x)
      int nx = clamp(int(ceil(footprintX)), 2, 6);
      int ny = clamp(int(ceil(footprintY)), 2, 6);
      float invNx = 1.0 / float(nx);
      float invNy = 1.0 / float(ny);
      vec4 acc = vec4(0.0);
      for (int sy = 0; sy < 6; sy++) {
        if (sy >= ny) break;
        float fy = (float(sy) + 0.5) * invNy - 0.5;
        for (int sx = 0; sx < 6; sx++) {
          if (sx >= nx) break;
          float fx = (float(sx) + 0.5) * invNx - 0.5;
          vec2 sampleUv = v_uv + du * fx + dv * fy;
          acc += sampleBilinearPremul(sampleUv * u_texSize - 0.5, texSizeI);
        }
      }
      vec4 res = acc * (invNx * invNy);
      float a = clamp(res.a, 0.0, 1.0);
      premul = vec4(clamp(res.rgb, vec3(0.0), vec3(a)), a);
    }

    if (u_outputStraight == 1) {
      if (premul.a <= 1e-4) {
        discard;
      }
      outColor = vec4(clamp(premul.rgb / premul.a, 0.0, 1.0), premul.a);
    } else {
      outColor = premul;
    }
  }
`;

class WebGlMeshWarpRenderer {
  private static instance: WebGlMeshWarpRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private isWebGl2 = false;
  private program: WebGLProgram | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private texture: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private fboTexture: WebGLTexture | null = null;
  private fboW = 0;
  private fboH = 0;
  private posLoc = -1;
  private uvLoc = -1;
  private originLoc: WebGLUniformLocation | null = null;
  private sizeLoc: WebGLUniformLocation | null = null;
  private texSizeLoc: WebGLUniformLocation | null = null;
  private texLoc: WebGLUniformLocation | null = null;
  private flipYLoc: WebGLUniformLocation | null = null;
  private outputStraightLoc: WebGLUniformLocation | null = null;
  private maxDim = 0;
  private vertexData = new Float32Array(0);
  private ready = false;

  static getInstance(): WebGlMeshWarpRenderer {
    if (!WebGlMeshWarpRenderer.instance) {
      WebGlMeshWarpRenderer.instance = new WebGlMeshWarpRenderer();
    }
    return WebGlMeshWarpRenderer.instance;
  }

  private constructor() {
    this.init();
  }

  private compileProgram(
    gl: WebGLRenderingContext,
    vsSrc: string,
    fsSrc: string
  ): WebGLProgram | null {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) return null;

    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (
      !gl.getShaderParameter(vs, gl.COMPILE_STATUS) ||
      !gl.getShaderParameter(fs, gl.COMPILE_STATUS)
    ) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }
    return program;
  }

  private init(): void {
    this.ready = false;
    if (typeof document === 'undefined') return;
    try {
      const canvas = document.createElement('canvas');
      const attrs: WebGLContextAttributes = {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
      };
      const gl2 = canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null;
      const gl = (gl2 || canvas.getContext('webgl', attrs)) as WebGLRenderingContext | null;
      if (!gl) return;

      const es3Prog = gl2 ? this.compileProgram(gl, MESH_VERTEX_SHADER_ES3, MESH_FRAGMENT_SHADER_ES3) : null;
      const program = es3Prog || this.compileProgram(gl, MESH_VERTEX_SHADER_ES1, MESH_FRAGMENT_SHADER_ES1);
      if (!program) return;

      const vertexBuffer = gl.createBuffer();
      const texture = gl.createTexture();
      const posLoc = gl.getAttribLocation(program, 'a_pos');
      const uvLoc = gl.getAttribLocation(program, 'a_uv');
      if (!vertexBuffer || !texture || posLoc < 0 || uvLoc < 0) {
        if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
        if (texture) gl.deleteTexture(texture);
        gl.deleteProgram(program);
        return;
      }

      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const maxVp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | number[] | null;
      const maxVpDim = maxVp ? Math.min(maxVp[0], maxVp[1]) : maxTex;

      this.canvas = canvas;
      this.gl = gl;
      this.isWebGl2 = Boolean(es3Prog && gl2);
      this.program = program;
      this.vertexBuffer = vertexBuffer;
      this.texture = texture;
      if (this.isWebGl2) {
        this.fbo = gl.createFramebuffer();
        this.fboTexture = gl.createTexture();
      }
      this.posLoc = posLoc;
      this.uvLoc = uvLoc;
      this.originLoc = gl.getUniformLocation(program, 'u_origin');
      this.sizeLoc = gl.getUniformLocation(program, 'u_size');
      this.texSizeLoc = gl.getUniformLocation(program, 'u_texSize');
      this.texLoc = gl.getUniformLocation(program, 'u_tex');
      this.flipYLoc = gl.getUniformLocation(program, 'u_flipY');
      this.outputStraightLoc = gl.getUniformLocation(program, 'u_outputStraight');
      this.maxDim = Math.min(maxTex || 4096, maxVpDim || 4096);
      this.ready = true;
    } catch {
      this.ready = false;
    }
  }

  private fillGridVertices(grid: Point2D[][], totalRows: number, totalCols: number): number {
    const vertexCount = totalRows * totalCols * 6;
    const neededFloats = vertexCount * 4;
    if (this.vertexData.length < neededFloats) {
      this.vertexData = new Float32Array(neededFloats);
    }

    const buf = this.vertexData;
    let offset = 0;
    for (let j = 0; j < totalRows; j++) {
      const v0 = j / totalRows;
      const v1 = (j + 1) / totalRows;
      const row0 = grid[j];
      const row1 = grid[j + 1];
      for (let i = 0; i < totalCols; i++) {
        const u0 = i / totalCols;
        const u1 = (i + 1) / totalCols;
        const p00 = row0[i];
        const p10 = row0[i + 1];
        const p11 = row1[i + 1];
        const p01 = row1[i];

        // Triangle 1: (0,0) - (1,0) - (0,1)
        buf[offset++] = p00.x; buf[offset++] = p00.y; buf[offset++] = u0; buf[offset++] = v0;
        buf[offset++] = p10.x; buf[offset++] = p10.y; buf[offset++] = u1; buf[offset++] = v0;
        buf[offset++] = p01.x; buf[offset++] = p01.y; buf[offset++] = u0; buf[offset++] = v1;

        // Triangle 2: (1,0) - (1,1) - (0,1)
        buf[offset++] = p10.x; buf[offset++] = p10.y; buf[offset++] = u1; buf[offset++] = v0;
        buf[offset++] = p11.x; buf[offset++] = p11.y; buf[offset++] = u1; buf[offset++] = v1;
        buf[offset++] = p01.x; buf[offset++] = p01.y; buf[offset++] = u0; buf[offset++] = v1;
      }
    }
    return vertexCount;
  }

  private ensureFbo(gl: WebGL2RenderingContext, w: number, h: number): boolean {
    if (!this.fbo || !this.fboTexture) return false;
    if (this.fboW === w && this.fboH === h) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      return true;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.fboTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTexture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.fboW = 0;
      this.fboH = 0;
      return false;
    }
    this.fboW = w;
    this.fboH = h;
    return true;
  }

  renderGrid(
    ctx: CanvasRenderingContext2D,
    sourceCanvas: HTMLCanvasElement,
    grid: Point2D[][],
    totalRows: number,
    totalCols: number
  ): boolean {
    if (!this.ready || !this.gl || !this.canvas || !this.program || !this.vertexBuffer || !this.texture) {
      return false;
    }
    const gl = this.gl;
    if (gl.isContextLost()) {
      this.ready = false;
      return false;
    }

    const sw = sourceCanvas.width;
    const sh = sourceCanvas.height;
    if (sw <= 0 || sh <= 0 || sw > this.maxDim || sh > this.maxDim) return false;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let j = 0; j <= totalRows; j++) {
      const row = grid[j];
      for (let i = 0; i <= totalCols; i++) {
        const p = row[i];
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }

    let originX = Math.floor(minX) - 1;
    let originY = Math.floor(minY) - 1;
    let endX = Math.ceil(maxX) + 1;
    let endY = Math.ceil(maxY) + 1;

    if (
      ctx.canvas &&
      ctx.canvas.width > 0 &&
      ctx.canvas.height > 0 &&
      typeof ctx.getTransform === 'function'
    ) {
      const m = ctx.getTransform();
      if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) {
        originX = Math.max(Math.floor(-m.e), originX);
        originY = Math.max(Math.floor(-m.f), originY);
        endX = Math.min(Math.ceil(ctx.canvas.width - m.e), endX);
        endY = Math.min(Math.ceil(ctx.canvas.height - m.f), endY);
      }
    }

    const outW = endX - originX;
    const outH = endY - originY;
    if (outW <= 0 || outH <= 0) return true;
    if (outW > this.maxDim || outH > this.maxDim) return false;

    const vertexCount = this.fillGridVertices(grid, totalRows, totalCols);
    const neededFloats = vertexCount * 4;

    if (this.canvas.width !== outW) this.canvas.width = outW;
    if (this.canvas.height !== outH) this.canvas.height = outH;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // WebGL2 ES3 shader performs exact float premultiplication; ES1 expects premultiplied upload
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !this.isWebGl2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.uniform1i(this.texLoc, 0);
    gl.uniform2f(this.originLoc, originX, originY);
    gl.uniform2f(this.sizeLoc, outW, outH);
    gl.uniform2f(this.texSizeLoc, sw, sh);
    if (this.flipYLoc) gl.uniform1f(this.flipYLoc, -1.0);
    if (this.outputStraightLoc) gl.uniform1i(this.outputStraightLoc, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData.subarray(0, neededFloats), gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.posLoc);
    gl.vertexAttribPointer(this.posLoc, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.uvLoc);
    gl.vertexAttribPointer(this.uvLoc, 2, gl.FLOAT, false, 16, 8);

    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

    ctx.drawImage(this.canvas, originX, originY);
    return true;
  }

  /**
   * Renders a deformed mesh/perspective grid directly from straight-alpha pixels into straight-alpha
   * RGBA chunks via WebGL2 FBO + readPixels (zero Canvas 2D round-trip, single texture upload).
   */
  renderGridToChunks(
    source: PixelBuffer,
    grid: Point2D[][],
    totalRows: number,
    totalCols: number,
    destRect: DirtyRect,
    chunkSize: number,
    onChunk: (chunkData: Uint8ClampedArray, cx: number, cy: number, cw: number, ch: number) => void
  ): boolean {
    if (
      !this.ready ||
      !this.isWebGl2 ||
      !this.gl ||
      !this.program ||
      !this.vertexBuffer ||
      !this.texture ||
      !this.fbo ||
      !this.fboTexture
    ) {
      return false;
    }
    const gl = this.gl as WebGL2RenderingContext;
    if (gl.isContextLost()) {
      this.ready = false;
      return false;
    }

    const sw = source.width;
    const sh = source.height;
    if (sw <= 0 || sh <= 0 || sw > this.maxDim || sh > this.maxDim || chunkSize > this.maxDim) {
      return false;
    }

    for (let j = 0; j <= totalRows; j++) {
      const row = grid[j];
      for (let i = 0; i <= totalCols; i++) {
        if (!Number.isFinite(row[i].x) || !Number.isFinite(row[i].y)) return false;
      }
    }

    const vertexCount = this.fillGridVertices(grid, totalRows, totalCols);
    const neededFloats = vertexCount * 4;
    const srcBytes =
      source.data instanceof Uint8Array
        ? source.data
        : new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength);

    // Upload source texture ONCE across all chunks (straight alpha, float premul in shader)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, srcBytes);

    gl.useProgram(this.program);
    gl.uniform1i(this.texLoc, 0);
    gl.uniform2f(this.texSizeLoc, sw, sh);
    if (this.flipYLoc) gl.uniform1f(this.flipYLoc, 1.0);
    if (this.outputStraightLoc) gl.uniform1i(this.outputStraightLoc, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertexData.subarray(0, neededFloats), gl.STREAM_DRAW);
    gl.enableVertexAttribArray(this.posLoc);
    gl.vertexAttribPointer(this.posLoc, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.uvLoc);
    gl.vertexAttribPointer(this.uvLoc, 2, gl.FLOAT, false, 16, 8);

    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    const x1 = destRect.x + destRect.width;
    const y1 = destRect.y + destRect.height;

    try {
      for (let cy = destRect.y; cy < y1; cy += chunkSize) {
        const ch = Math.min(chunkSize, y1 - cy);
        for (let cx = destRect.x; cx < x1; cx += chunkSize) {
          const cw = Math.min(chunkSize, x1 - cx);
          if (!this.ensureFbo(gl, cw, ch)) return false;

          gl.viewport(0, 0, cw, ch);
          gl.uniform2f(this.originLoc, cx, cy);
          gl.uniform2f(this.sizeLoc, cw, ch);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.texture);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLES, 0, vertexCount);

          const rawBytes = new Uint8Array(cw * ch * 4);
          gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, rawBytes);
          const clamped = new Uint8ClampedArray(
            rawBytes.buffer,
            rawBytes.byteOffset,
            rawBytes.byteLength
          );
          onChunk(clamped, cx, cy, cw, ch);
        }
      }
      return true;
    } catch {
      return false;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }
}

function renderDeformedGrid(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  grid: Point2D[][],
  totalRows: number,
  totalCols: number
): void {
  if (WebGlMeshWarpRenderer.getInstance().renderGrid(ctx, sourceCanvas, grid, totalRows, totalCols)) {
    return;
  }

  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  for (let j = 0; j < totalRows; j++) {
    const v0 = (j / totalRows) * sh;
    const v1 = ((j + 1) / totalRows) * sh;
    for (let i = 0; i < totalCols; i++) {
      const u0 = (i / totalCols) * sw;
      const u1 = ((i + 1) / totalCols) * sw;

      const p00 = grid[j][i];
      const p10 = grid[j][i + 1];
      const p11 = grid[j + 1][i + 1];
      const p01 = grid[j + 1][i];

      drawAffineTriangle(
        ctx, sourceCanvas,
        u0, v0, u1, v0, u0, v1,
        p00.x, p00.y, p10.x, p10.y, p01.x, p01.y
      );

      drawAffineTriangle(
        ctx, sourceCanvas,
        u1, v0, u1, v1, u0, v1,
        p10.x, p10.y, p11.x, p11.y, p01.x, p01.y
      );
    }
  }
}

/**
 * Renders sourceCanvas deformed into a Perspective Quad using homography triangle slicing.
 */
export function renderPerspectiveQuad(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  quad: [Point2D, Point2D, Point2D, Point2D],
  subdivisions = 16
): void {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  if (sw <= 0 || sh <= 0 || subdivisions <= 0) return;

  const homography = solveUnitSquareToQuad(quad[0], quad[1], quad[2], quad[3]);

  const grid: Point2D[][] = [];
  for (let j = 0; j <= subdivisions; j++) {
    const row: Point2D[] = [];
    const v = j / subdivisions;
    for (let i = 0; i <= subdivisions; i++) {
      const u = i / subdivisions;
      row.push(evaluateHomography(homography, u, v));
    }
    grid.push(row);
  }

  renderDeformedGrid(ctx, sourceCanvas, grid, subdivisions, subdivisions);
}

/**
 * Renders sourceCanvas deformed via 2D Catmull-Rom Bicubic Mesh Lattice.
 */
export function renderMeshWarp(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  meshPoints: Point2D[][],
  subPerCell = 4
): void {
  const sw = sourceCanvas.width;
  const sh = sourceCanvas.height;
  if (sw <= 0 || sh <= 0 || subPerCell <= 0) return;

  const rows = meshPoints.length;
  const cols = meshPoints[0]?.length || 0;
  if (rows < 2 || cols < 2) return;

  const totalCols = (cols - 1) * subPerCell;
  const totalRows = (rows - 1) * subPerCell;

  const grid: Point2D[][] = [];
  for (let j = 0; j <= totalRows; j++) {
    const row: Point2D[] = [];
    const v = j / totalRows;
    for (let i = 0; i <= totalCols; i++) {
      const u = i / totalCols;
      row.push(evaluateMeshSurface(meshPoints, u, v));
    }
    grid.push(row);
  }

  renderDeformedGrid(ctx, sourceCanvas, grid, totalRows, totalCols);
}

/**
 * Checks if a Catmull-Rom mesh lattice is an exact unmodified integer translation of (sw x sh).
 */
function isExactMeshTranslation(
  meshPoints: Point2D[][],
  sw: number,
  sh: number
): { x: number; y: number } | null {
  const rows = meshPoints.length;
  const cols = meshPoints[0]?.length || 0;
  if (rows < 2 || cols < 2) return null;
  const originX = Math.round(meshPoints[0][0].x);
  const originY = Math.round(meshPoints[0][0].y);
  for (let r = 0; r < rows; r++) {
    const v = r / (rows - 1);
    const expectedY = originY + v * sh;
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      const expectedX = originX + u * sw;
      const p = meshPoints[r][c];
      if (Math.abs(p.x - expectedX) > 1e-4 || Math.abs(p.y - expectedY) > 1e-4) {
        return null;
      }
    }
  }
  return { x: originX, y: originY };
}

/**
 * High-precision CPU inverse-homography perspective chunk resampler using
 * float-premultiplied Anti-Ringing Lanczos-3 and footprint-scaled downsampling.
 */
function resamplePerspectiveChunkCpu(
  source: PixelBuffer,
  quad: [Point2D, Point2D, Point2D, Point2D],
  chunkX: number,
  chunkY: number,
  chunkW: number,
  chunkH: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(chunkW * chunkH * 4);
  const sw = source.width;
  const sh = source.height;
  if (sw <= 0 || sh <= 0) return out;

  const H = solveUnitSquareToQuad(quad[0], quad[1], quad[2], quad[3]);
  // Adjugate of 3x3 homography H = [[a,b,c],[d,e,f],[g,h,1]]
  const ia = H.e - H.f * H.h;
  const ib = H.c * H.h - H.b;
  const ic = H.b * H.f - H.c * H.e;
  const id = H.f * H.g - H.d;
  const ie = H.a - H.c * H.g;
  const if_ = H.c * H.d - H.a * H.f;
  const ig = H.d * H.h - H.e * H.g;
  const ih = H.b * H.g - H.a * H.h;
  const ii = H.a * H.e - H.b * H.d;

  const srcData = source.data;
  const wxBuf = new Float32Array(20);
  const wyBuf = new Float32Array(20);

  for (let py = 0; py < chunkH; py++) {
    const docY = chunkY + py + 0.5;
    let dstOff = py * chunkW * 4;
    for (let px = 0; px < chunkW; px++, dstOff += 4) {
      const docX = chunkX + px + 0.5;
      const denom = ig * docX + ih * docY + ii;
      if (Math.abs(denom) < 1e-7) continue;

      const invDenom = 1.0 / denom;
      const numU = ia * docX + ib * docY + ic;
      const numV = id * docX + ie * docY + if_;
      const u = numU * invDenom;
      const v = numV * invDenom;
      if (u < -0.05 || u > 1.05 || v < -0.05 || v > 1.05) continue;

      const sx = u * sw - 0.5;
      const sy = v * sh - 0.5;

      // Exact analytical Jacobian of (sx, sy) with respect to (docX, docY)
      const invD2 = invDenom * invDenom;
      const dsx_dx = ((ia * denom - numU * ig) * invD2) * sw;
      const dsx_dy = ((ib * denom - numU * ih) * invD2) * sw;
      const dsy_dx = ((id * denom - numV * ig) * invD2) * sh;
      const dsy_dy = ((ie * denom - numV * ih) * invD2) * sh;

      const footX = Math.hypot(dsx_dx, dsx_dy);
      const footY = Math.hypot(dsy_dx, dsy_dy);
      const filterScaleX = Math.min(3.0, Math.max(1.0, footX));
      const filterScaleY = Math.min(3.0, Math.max(1.0, footY));
      const supportX = 3.0 * filterScaleX;
      const supportY = 3.0 * filterScaleY;

      if (sx < -supportX || sx > sw - 1 + supportX || sy < -supportY || sy > sh - 1 + supportY) {
        continue;
      }

      const invFX = 1.0 / filterScaleX;
      const invFY = 1.0 / filterScaleY;
      const xStart = Math.ceil(sx - supportX);
      const xEnd = Math.floor(sx + supportX);
      const yStart = Math.ceil(sy - supportY);
      const yEnd = Math.floor(sy + supportY);
      const countX = Math.min(20, Math.max(0, xEnd - xStart + 1));
      const countY = Math.min(20, Math.max(0, yEnd - yStart + 1));
      if (countX <= 0 || countY <= 0) continue;

      let sumWx = 0;
      for (let i = 0; i < countX; i++) {
        const w = lanczos3Weight((xStart + i - sx) * invFX);
        wxBuf[i] = w;
        sumWx += w;
      }
      if (Math.abs(sumWx) < 1e-6) continue;
      const invSumWx = 1.0 / sumWx;
      for (let i = 0; i < countX; i++) wxBuf[i] *= invSumWx;

      let sumWy = 0;
      for (let j = 0; j < countY; j++) {
        const w = lanczos3Weight((yStart + j - sy) * invFY);
        wyBuf[j] = w;
        sumWy += w;
      }
      if (Math.abs(sumWy) < 1e-6) continue;
      const invSumWy = 1.0 / sumWy;
      for (let j = 0; j < countY; j++) wyBuf[j] *= invSumWy;

      let accR = 0, accG = 0, accB = 0, accA = 0;
      for (let j = 0; j < countY; j++) {
        const iy = yStart + j;
        if (iy < 0 || iy >= sh) continue;
        const wy = wyBuf[j];
        if (wy === 0) continue;
        const rowBase = iy * sw;
        let rR = 0, rG = 0, rB = 0, rA = 0;
        for (let i = 0; i < countX; i++) {
          const ix = xStart + i;
          if (ix < 0 || ix >= sw) continue;
          const off = (rowBase + ix) << 2;
          const a = srcData[off + 3];
          if (a === 0) continue;
          const wa = wxBuf[i] * (a * (1 / 255));
          rR += srcData[off] * wa;
          rG += srcData[off + 1] * wa;
          rB += srcData[off + 2] * wa;
          rA += wa;
        }
        accR += rR * wy;
        accG += rG * wy;
        accB += rB * wy;
        accA += rA * wy;
      }

      if (filterScaleX <= 1.25 && filterScaleY <= 1.25) {
        const bx = Math.floor(sx);
        const by = Math.floor(sy);
        let loR = Infinity, hiR = -Infinity;
        let loG = Infinity, hiG = -Infinity;
        let loB = Infinity, hiB = -Infinity;
        let loA = Infinity, hiA = -Infinity;
        for (let ny = by; ny <= by + 1; ny++) {
          const yOk = ny >= 0 && ny < sh;
          const rowBase = ny * sw;
          for (let nx = bx; nx <= bx + 1; nx++) {
            let nr = 0, ng = 0, nb = 0, na = 0;
            if (yOk && nx >= 0 && nx < sw) {
              const o = (rowBase + nx) << 2;
              na = srcData[o + 3] * (1 / 255);
              nr = srcData[o] * na;
              ng = srcData[o + 1] * na;
              nb = srcData[o + 2] * na;
            }
            if (nr < loR) loR = nr; if (nr > hiR) hiR = nr;
            if (ng < loG) loG = ng; if (ng > hiG) hiG = ng;
            if (nb < loB) loB = nb; if (nb > hiB) hiB = nb;
            if (na < loA) loA = na; if (na > hiA) hiA = na;
          }
        }
        if (accR < loR) accR = loR; else if (accR > hiR) accR = hiR;
        if (accG < loG) accG = loG; else if (accG > hiG) accG = hiG;
        if (accB < loB) accB = loB; else if (accB > hiB) accB = hiB;
        if (accA < loA) accA = loA; else if (accA > hiA) accA = hiA;
      }

      if (accA <= 1e-4) continue;
      if (accA > 1.0) accA = 1.0;
      const maxRgb = accA * 255.0;
      if (accR < 0) accR = 0; else if (accR > maxRgb) accR = maxRgb;
      if (accG < 0) accG = 0; else if (accG > maxRgb) accG = maxRgb;
      if (accB < 0) accB = 0; else if (accB > maxRgb) accB = maxRgb;
      const invA = 1.0 / accA;
      out[dstOff] = Math.min(255, Math.max(0, Math.round(accR * invA)));
      out[dstOff + 1] = Math.min(255, Math.max(0, Math.round(accG * invA)));
      out[dstOff + 2] = Math.min(255, Math.max(0, Math.round(accB * invA)));
      out[dstOff + 3] = Math.min(255, Math.max(0, Math.round(accA * 255.0)));
    }
  }

  return out;
}

/**
 * High-precision chunked Perspective Quad commit pipeline (lossless identity -> WebGL2 -> CPU AR-Lanczos3).
 */
export function processPerspectiveTransformChunks(
  source: PixelBuffer,
  quad: [Point2D, Point2D, Point2D, Point2D],
  destRect: DirtyRect,
  chunkSize: number,
  subdivisions: number,
  onChunk: (chunkData: Uint8ClampedArray, cx: number, cy: number, cw: number, ch: number) => void
): boolean {
  const sw = source.width;
  const sh = source.height;
  if (sw <= 0 || sh <= 0 || subdivisions <= 0) return false;

  const x1 = destRect.x + destRect.width;
  const y1 = destRect.y + destRect.height;

  const exactShift = isExactQuadTranslation(quad, sw, sh);
  if (exactShift) {
    const spec = {
      quarterTurn: 0 as const,
      flipH: false,
      flipV: false,
      destOriginX: exactShift.x,
      destOriginY: exactShift.y,
      destWidth: sw,
      destHeight: sh,
    };
    for (let cy = destRect.y; cy < y1; cy += chunkSize) {
      const ch = Math.min(chunkSize, y1 - cy);
      for (let cx = destRect.x; cx < x1; cx += chunkSize) {
        const cw = Math.min(chunkSize, x1 - cx);
        onChunk(renderLosslessAffineChunk(source, spec, cx, cy, cw, ch), cx, cy, cw, ch);
      }
    }
    return true;
  }

  const homography = solveUnitSquareToQuad(quad[0], quad[1], quad[2], quad[3]);
  const grid: Point2D[][] = [];
  for (let j = 0; j <= subdivisions; j++) {
    const row: Point2D[] = [];
    const v = j / subdivisions;
    for (let i = 0; i <= subdivisions; i++) {
      const u = i / subdivisions;
      row.push(evaluateHomography(homography, u, v));
    }
    grid.push(row);
  }

  if (
    WebGlMeshWarpRenderer.getInstance().renderGridToChunks(
      source,
      grid,
      subdivisions,
      subdivisions,
      destRect,
      chunkSize,
      onChunk
    )
  ) {
    return true;
  }

  // Exact CPU inverse-homography Anti-Ringing Lanczos-3 fallback
  for (let cy = destRect.y; cy < y1; cy += chunkSize) {
    const ch = Math.min(chunkSize, y1 - cy);
    for (let cx = destRect.x; cx < x1; cx += chunkSize) {
      const cw = Math.min(chunkSize, x1 - cx);
      onChunk(resamplePerspectiveChunkCpu(source, quad, cx, cy, cw, ch), cx, cy, cw, ch);
    }
  }
  return true;
}

/**
 * High-precision chunked Mesh Warp commit pipeline (lossless identity -> WebGL2 straight-alpha FBO).
 * Returns false if WebGL2 is unavailable so caller can fall back to Canvas 2D triangle slicing.
 */
export function processMeshWarpTransformChunks(
  source: PixelBuffer,
  meshPoints: Point2D[][],
  destRect: DirtyRect,
  chunkSize: number,
  subPerCell: number,
  onChunk: (chunkData: Uint8ClampedArray, cx: number, cy: number, cw: number, ch: number) => void
): boolean {
  const sw = source.width;
  const sh = source.height;
  const rows = meshPoints.length;
  const cols = meshPoints[0]?.length || 0;
  if (sw <= 0 || sh <= 0 || subPerCell <= 0 || rows < 2 || cols < 2) return false;

  const exactShift = isExactMeshTranslation(meshPoints, sw, sh);
  if (exactShift) {
    const spec = {
      quarterTurn: 0 as const,
      flipH: false,
      flipV: false,
      destOriginX: exactShift.x,
      destOriginY: exactShift.y,
      destWidth: sw,
      destHeight: sh,
    };
    const x1 = destRect.x + destRect.width;
    const y1 = destRect.y + destRect.height;
    for (let cy = destRect.y; cy < y1; cy += chunkSize) {
      const ch = Math.min(chunkSize, y1 - cy);
      for (let cx = destRect.x; cx < x1; cx += chunkSize) {
        const cw = Math.min(chunkSize, x1 - cx);
        onChunk(renderLosslessAffineChunk(source, spec, cx, cy, cw, ch), cx, cy, cw, ch);
      }
    }
    return true;
  }

  const totalCols = (cols - 1) * subPerCell;
  const totalRows = (rows - 1) * subPerCell;
  const grid: Point2D[][] = [];
  for (let j = 0; j <= totalRows; j++) {
    const row: Point2D[] = [];
    const v = j / totalRows;
    for (let i = 0; i <= totalCols; i++) {
      const u = i / totalCols;
      row.push(evaluateMeshSurface(meshPoints, u, v));
    }
    grid.push(row);
  }

  return WebGlMeshWarpRenderer.getInstance().renderGridToChunks(
    source,
    grid,
    totalRows,
    totalCols,
    destRect,
    chunkSize,
    onChunk
  );
}

/**
 * Creates default 4 perspective corner pins from bounds.
 * Order: [TL, TR, BR, BL]
 */
export function createDefaultPerspectiveQuad(
  x: number,
  y: number,
  width: number,
  height: number,
  rotation = 0
): [Point2D, Point2D, Point2D, Point2D] {
  if (rotation === 0) {
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
  }

  const cx = x + width / 2;
  const cy = y + height / 2;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const rotate = (px: number, py: number): Point2D => {
    const rx = px - cx;
    const ry = py - cy;
    return {
      x: cx + rx * cos - ry * sin,
      y: cy + rx * sin + ry * cos,
    };
  };

  return [
    rotate(x, y),
    rotate(x + width, y),
    rotate(x + width, y + height),
    rotate(x, y + height),
  ];
}

/**
 * Creates a default grid of (rows x cols) control points interpolated from 4 corners.
 * Preserves exact floating-point coordinates so an unmodified mesh is a lossless identity warp.
 */
export function createDefaultMeshPoints(
  quad: [Point2D, Point2D, Point2D, Point2D],
  cols = 4,
  rows = 4
): Point2D[][] {
  const [q0, q1, q2, q3] = quad;
  const points: Point2D[][] = [];

  for (let r = 0; r < rows; r++) {
    const v = rows > 1 ? r / (rows - 1) : 0;
    const row: Point2D[] = [];
    for (let c = 0; c < cols; c++) {
      const u = cols > 1 ? c / (cols - 1) : 0;
      // Bilinear interpolation across corners
      const x = (1 - u) * (1 - v) * q0.x + u * (1 - v) * q1.x + u * v * q2.x + (1 - u) * v * q3.x;
      const y = (1 - u) * (1 - v) * q0.y + u * (1 - v) * q1.y + u * v * q2.y + (1 - u) * v * q3.y;
      row.push({ x, y });
    }
    points.push(row);
  }

  return points;
}

/**
 * Computes adaptive per-cell mesh subdivision count to prevent polygonal faceting
 * and UV shearing on large or sharply curved warps.
 */
export function computeMeshSubdivisions(
  sourceWidth: number,
  sourceHeight: number,
  meshPoints: Point2D[][],
  highQuality: boolean
): number {
  const rows = Math.max(2, meshPoints.length);
  const cols = Math.max(2, meshPoints[0]?.length || 2);
  const maxSpan = Math.max(sourceWidth, sourceHeight);
  const cells = Math.max(1, Math.min(rows - 1, cols - 1));
  const targetPxPerSub = highQuality ? 20 : 32;
  const minSub = highQuality ? 10 : 6;
  const maxSub = highQuality ? 20 : 12;
  return Math.max(minSub, Math.min(maxSub, Math.ceil(maxSpan / (cells * targetPxPerSub))));
}

/**
 * Calculates tight bounding box of a perspective quad or mesh point set.
 */
export function getPointsBounds(points: Point2D[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const minXF = Math.floor(minX);
  const minYF = Math.floor(minY);
  const maxXC = Math.ceil(maxX);
  const maxYC = Math.ceil(maxY);

  return {
    minX: minXF,
    minY: minYF,
    maxX: maxXC,
    maxY: maxYC,
    width: Math.max(1, maxXC - minXF),
    height: Math.max(1, maxYC - minYF),
  };
}

/**
 * Calculates tight bounding box of an evaluated Catmull-Rom mesh surface,
 * preventing spline overshoot clipping in preview and final commit.
 */
export function getMeshSurfaceBounds(
  meshPoints: Point2D[][],
  subPerCell = 6
): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  const rows = meshPoints.length;
  const cols = meshPoints[0]?.length || 0;
  if (rows < 2 || cols < 2) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }

  const totalRows = (rows - 1) * subPerCell;
  const totalCols = (cols - 1) * subPerCell;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let j = 0; j <= totalRows; j++) {
    const v = j / totalRows;
    for (let i = 0; i <= totalCols; i++) {
      const u = i / totalCols;
      const p = evaluateMeshSurface(meshPoints, u, v);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  const minXF = Math.floor(minX);
  const minYF = Math.floor(minY);
  const maxXC = Math.ceil(maxX);
  const maxYC = Math.ceil(maxY);

  return {
    minX: minXF,
    minY: minYF,
    maxX: maxXC,
    maxY: maxYC,
    width: Math.max(1, maxXC - minXF),
    height: Math.max(1, maxYC - minYF),
  };
}

export interface ResolveTransformTargetsResult {
  targetLayers: LayerItem[];
  includesFolder: boolean;
  blockedReason?: 'locked' | 'unsupported' | 'empty-folder';
}

export function isLayerOrAncestorLocked(
  layer: LayerItem,
  layerMap: Map<string, LayerItem>
): boolean {
  let curr: LayerItem | undefined = layer;
  const visited = new Set<string>();
  while (curr && !visited.has(curr.id)) {
    if (curr.locked) return true;
    visited.add(curr.id);
    curr = curr.parentId ? layerMap.get(curr.parentId) : undefined;
  }
  return false;
}

function isDescendantOfAnyFolder(
  layer: LayerItem,
  folderIds: Set<string>,
  layerMap: Map<string, LayerItem>
): boolean {
  let parentId = layer.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    if (folderIds.has(parentId)) return true;
    visited.add(parentId);
    parentId = layerMap.get(parentId)?.parentId ?? null;
  }
  return false;
}

/**
 * Resolves all unlocked raster layers targeted by a Free Transform operation.
 * Selecting a folder (or frame-folder) recursively includes all unlocked raster layers
 * within that folder (including nested subfolders). Multi-selection expands any selected
 * folders alongside directly selected raster layers in stack order without duplicates.
 */
export function resolveTransformTargetLayers(
  layers: LayerItem[],
  activeLayer: LayerItem | undefined,
  selectedLayerIds: string[]
): ResolveTransformTargetsResult {
  const layerMap = new Map<string, LayerItem>();
  for (const l of layers) {
    layerMap.set(l.id, l);
  }

  const effectiveSelectedIds =
    selectedLayerIds && selectedLayerIds.length > 0
      ? selectedLayerIds
      : activeLayer
        ? [activeLayer.id]
        : [];

  const selectedItems = effectiveSelectedIds
    .map((id) => layerMap.get(id))
    .filter((l): l is LayerItem => Boolean(l));

  if (selectedItems.length === 0) {
    return { targetLayers: [], includesFolder: false, blockedReason: 'unsupported' };
  }

  if (selectedItems.length === 1) {
    const single = selectedItems[0];
    if (isFolderLikeLayer(single)) {
      if (isLayerOrAncestorLocked(single, layerMap)) {
        return { targetLayers: [], includesFolder: true, blockedReason: 'locked' };
      }
      const folderSet = new Set([single.id]);
      const targets = layers.filter(
        (l) =>
          l.type === 'raster' &&
          !isLayerOrAncestorLocked(l, layerMap) &&
          isDescendantOfAnyFolder(l, folderSet, layerMap)
      );
      if (targets.length === 0) {
        return { targetLayers: [], includesFolder: true, blockedReason: 'empty-folder' };
      }
      return { targetLayers: targets, includesFolder: true };
    }

    if (single.type !== 'raster') {
      return { targetLayers: [], includesFolder: false, blockedReason: 'unsupported' };
    }
    if (isLayerOrAncestorLocked(single, layerMap)) {
      return { targetLayers: [], includesFolder: false, blockedReason: 'locked' };
    }
    return { targetLayers: [single], includesFolder: false };
  }

  const selectedIdSet = new Set(selectedItems.map((l) => l.id));
  const includesFolder = selectedItems.some((l) => isFolderLikeLayer(l));
  const selectedUnlockedFolders = new Set(
    selectedItems
      .filter((l) => isFolderLikeLayer(l) && !isLayerOrAncestorLocked(l, layerMap))
      .map((l) => l.id)
  );

  const targetLayers = layers.filter(
    (l) =>
      l.type === 'raster' &&
      !isLayerOrAncestorLocked(l, layerMap) &&
      (selectedIdSet.has(l.id) ||
        (selectedUnlockedFolders.size > 0 &&
          isDescendantOfAnyFolder(l, selectedUnlockedFolders, layerMap)))
  );

  if (targetLayers.length === 0) {
    const allLocked = selectedItems.every((l) => isLayerOrAncestorLocked(l, layerMap));
    return {
      targetLayers: [],
      includesFolder,
      blockedReason: allLocked ? 'locked' : includesFolder ? 'empty-folder' : 'unsupported',
    };
  }

  return { targetLayers, includesFolder };
}

/**
 * Computes preview visibility and effective opacity for a target layer during a
 * folder / multi-layer transform preview.
 */
export function getTransformPreviewLayerState(
  layer: LayerItem,
  layerMap: Map<string, LayerItem>,
  selectedRootIds: Set<string>
): { visible: boolean; opacity: number } {
  let visible = layer.visible;
  let opacity = layer.opacity;
  let currParentId = layer.parentId;
  const visited = new Set<string>([layer.id]);

  while (currParentId && !visited.has(currParentId)) {
    visited.add(currParentId);
    const parent = layerMap.get(currParentId);
    if (!parent) break;
    opacity *= parent.opacity;
    if (!selectedRootIds.has(parent.id) && !parent.visible) {
      visible = false;
    }
    currParentId = parent.parentId;
  }

  return {
    visible,
    opacity: Math.max(0, Math.min(1, opacity)),
  };
}
