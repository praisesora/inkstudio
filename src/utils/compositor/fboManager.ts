import { restoreStandardProgram, unbindSceneTextureUnits } from './layerUniforms';
import { CompositorState, FboSurface, PingPongTarget } from './types';

export { unbindSceneTextureUnits };

export function createFboSurface(
  gl: WebGL2RenderingContext,
  withStencil: boolean = true
): FboSurface | null {
  const fbo = gl.createFramebuffer();
  const texture = gl.createTexture();
  if (!fbo || !texture) {
    if (fbo) gl.deleteFramebuffer(fbo);
    if (texture) gl.deleteTexture(texture);
    return null;
  }
  const stencilRb =
    withStencil && typeof gl.createRenderbuffer === 'function' ? gl.createRenderbuffer() : null;
  return { fbo, texture, stencilRb, width: 0, height: 0 };
}

export function ensureFboSurfaceSize(
  gl: WebGL2RenderingContext,
  surface: FboSurface,
  width: number,
  height: number
): boolean {
  if (surface.width === width && surface.height === height) {
    return true;
  }

  const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

  gl.bindTexture(gl.TEXTURE_2D, surface.texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  gl.bindFramebuffer(gl.FRAMEBUFFER, surface.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, surface.texture, 0);

  if (surface.stencilRb && typeof gl.bindRenderbuffer === 'function') {
    gl.bindRenderbuffer(gl.RENDERBUFFER, surface.stencilRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, surface.stencilRb);
  }

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);

  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('Compositor FBO surface incomplete:', status);
    return false;
  }

  surface.width = width;
  surface.height = height;
  return true;
}

export function disposeFboSurface(gl: WebGL2RenderingContext, surface: FboSurface | null): void {
  if (!surface) return;
  gl.deleteFramebuffer(surface.fbo);
  gl.deleteTexture(surface.texture);
  if (surface.stencilRb && typeof gl.deleteRenderbuffer === 'function') {
    gl.deleteRenderbuffer(surface.stencilRb);
  }
}

export function disposePingPongTarget(
  gl: WebGL2RenderingContext,
  target: PingPongTarget | null
): void {
  if (!target) return;
  disposeFboSurface(gl, target.surfaces[0]);
  disposeFboSurface(gl, target.surfaces[1]);
}

export function ensurePingPongTarget(
  gl: WebGL2RenderingContext,
  existing: PingPongTarget | null,
  width: number,
  height: number
): PingPongTarget | null {
  let target = existing;
  if (!target) {
    const s0 = createFboSurface(gl, true);
    const s1 = createFboSurface(gl, true);
    if (!s0 || !s1) {
      disposeFboSurface(gl, s0);
      disposeFboSurface(gl, s1);
      return null;
    }
    target = { surfaces: [s0, s1], activeIndex: 0 };
  }
  if (
    !ensureFboSurfaceSize(gl, target.surfaces[0], width, height) ||
    !ensureFboSurfaceSize(gl, target.surfaces[1], width, height)
  ) {
    return null;
  }
  return target;
}

export function ensureFolderPingPong(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  depth: number,
  width: number,
  height: number
): PingPongTarget | null {
  while (state.folderPingPongs.length <= depth) {
    const created = ensurePingPongTarget(gl, null, width, height);
    if (!created) return null;
    state.folderPingPongs.push(created);
  }
  const target = ensurePingPongTarget(gl, state.folderPingPongs[depth], width, height);
  if (!target) return null;
  state.folderPingPongs[depth] = target;
  return target;
}

/**
 * Fast GPU-to-GPU FBO copy via gl.blitFramebuffer (with fullscreen quad fallback).
 * Eliminates all gl.copyTexSubImage2D calls and preserves stencil buffer when requested.
 */
export function copyFboSurface(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  src: FboSurface,
  dst: FboSurface,
  width: number,
  height: number,
  copyStencil: boolean = false
): void {
  if (
    typeof gl.blitFramebuffer === 'function' &&
    gl.READ_FRAMEBUFFER !== undefined &&
    gl.DRAW_FRAMEBUFFER !== undefined
  ) {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
    const mask = copyStencil && src.stencilRb && dst.stencilRb
      ? (gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
      : gl.COLOR_BUFFER_BIT;
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, mask, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, width, height);
    return;
  }

  // Fallback: fullscreen quad copy using blitProgram (zero copyTexSubImage2D)
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
  gl.viewport(0, 0, width, height);
  gl.clearColor(0.0, 0.0, 0.0, 0.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!state.blitProgram) return;

  const stencilWasEnabled = gl.isEnabled(gl.STENCIL_TEST);
  if (stencilWasEnabled) gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.BLEND);

  gl.useProgram(state.blitProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.stylesQuadBuffer || state.quadBuffer);
  if (state.aBlitQuadPosLoc >= 0) {
    gl.enableVertexAttribArray(state.aBlitQuadPosLoc);
    gl.vertexAttribPointer(state.aBlitQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, src.texture);
  gl.uniform1i(state.uBlitTextureLoc, 0);
  gl.uniform1i(state.uBlitBackdropTextureLoc, 2);
  gl.uniform1i(state.uBlitHasBackdropLoc, 0);
  gl.uniform1i(state.uBlitBlendModeLoc, 0);
  gl.uniform1f(state.uBlitOpacityLoc, 1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  unbindSceneTextureUnits(gl);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  if (stencilWasEnabled) gl.enable(gl.STENCIL_TEST);
  restoreStandardProgram(state, gl);
}

/**
 * Swaps Ping-Pong FBOs for a programmable blend / adjustment pass:
 * copies current surface -> opposite surface and returns current surface's immutable texture as backdrop.
 * ZERO gl.copyTexSubImage2D calls!
 */
export function prepareBackdropFromPingPong(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  target: PingPongTarget,
  viewportW: number,
  viewportH: number,
  preserveStencil: boolean
): WebGLTexture {
  const src = target.surfaces[target.activeIndex];
  const nextIdx: 0 | 1 = target.activeIndex === 0 ? 1 : 0;
  const dst = target.surfaces[nextIdx];

  copyFboSurface(state, gl, src, dst, viewportW, viewportH, preserveStencil);
  target.activeIndex = nextIdx;
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
  gl.viewport(0, 0, viewportW, viewportH);

  return src.texture;
}

/**
 * Ensures an offscreen framebuffer and texture exist for isolated layer style / eraser rendering.
 */
export function ensureLayerFbo(
  state: CompositorState,
  width: number,
  height: number
): boolean {
  if (!state.gl) return false;
  const gl = state.gl;

  if (
    state.layerFbo &&
    state.layerTexture &&
    state.layerFboWidth === width &&
    state.layerFboHeight === height
  ) {
    return true;
  }

  const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;

  if (!state.layerFbo) {
    state.layerFbo = gl.createFramebuffer();
  }
  if (!state.layerTexture) {
    state.layerTexture = gl.createTexture();
  }

  state.layerFboWidth = width;
  state.layerFboHeight = height;

  gl.bindTexture(gl.TEXTURE_2D, state.layerTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  gl.bindFramebuffer(gl.FRAMEBUFFER, state.layerFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.layerTexture, 0);

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);

  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('Layer FBO incomplete:', status);
    return false;
  }

  return true;
}
