import { CanvasDimensions, LayerItem, resolveToneDensityType } from '../../types/editor';
import { parseHexColor } from './bounds';
import { CompositorState, LayerUniformLocs } from './types';

/**
 * Unbinds offscreen FBO textures from TEXTURE0 and TEXTURE2 so no texture attached
 * to the next bound DRAW_FRAMEBUFFER can trigger a WebGL2 feedback loop error.
 */
export function unbindSceneTextureUnits(gl: WebGL2RenderingContext): void {
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

export function restoreStandardProgram(
  state: CompositorState,
  gl: WebGL2RenderingContext
): void {
  if (state.program) {
    gl.useProgram(state.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
    if (state.aQuadPosLoc >= 0) {
      gl.enableVertexAttribArray(state.aQuadPosLoc);
      gl.vertexAttribPointer(state.aQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
    }
  }
}

export function syncFrameUniforms(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  locs: LayerUniformLocs
): void {
  const fs = state.currentFrameState;
  if (!fs) return;
  gl.uniform2f(locs.uViewportSize, fs.viewportW, fs.viewportH);
  gl.uniform2f(locs.uDocDimensions, fs.dimensions.width, fs.dimensions.height);
  gl.uniform2f(locs.uPan, fs.transform.pan.x, fs.transform.pan.y);
  gl.uniform1f(locs.uZoom, fs.transform.zoom);
  gl.uniform1f(locs.uRotationRad, fs.rotRad);
  gl.uniform2f(locs.uFlip, fs.transform.flipX ? -1.0 : 1.0, fs.transform.flipY ? -1.0 : 1.0);
  gl.uniform1f(locs.uDpr, fs.dpr);
}

export function applyLayerUniforms(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  locs: LayerUniformLocs,
  layer: LayerItem,
  dimensions: CanvasDimensions,
  effectiveOpacity: number,
  modeCode: number,
  backdropTex: WebGLTexture | null,
  maskTex: WebGLTexture | null
): void {
  gl.uniform1f(locs.uLayerOpacity, effectiveOpacity);
  gl.uniform1i(locs.uBlendMode, modeCode);

  // Always bind distinct sampler units (mask = 1, backdrop = 2) so sampler2D never
  // collides with sampler2DArray on unit 0 in WebGL2.
  gl.uniform1i(locs.uBackdropTexture, 2);
  gl.uniform1i(locs.uMaskTexture, 1);

  if (backdropTex && modeCode !== 0 && modeCode !== 12) {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, backdropTex);
    gl.uniform1i(locs.uHasBackdrop, 1);
  } else {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.uniform1i(locs.uHasBackdrop, 0);
  }

  // Expression Color Uniforms
  const isBgLayer = layer.id === 'layer-bg' || layer.id.startsWith('layer-bg');
  const docColorMode = state.currentOptions?.colorMode;
  const exprMode = isBgLayer
    ? 0
    : layer.expressionColor === 'monochrome' || docColorMode === 'monochrome'
    ? 2
    : layer.expressionColor === 'gray' || docColorMode === 'grayscale'
    ? 1
    : 0;
  gl.uniform1i(locs.uExpressionMode, exprMode);
  if (exprMode === 2) {
    gl.uniform1f(locs.uMonoThreshold, (layer.monoThreshold ?? 128) / 255.0);
    gl.uniform1i(locs.uMonoExpressBlack, layer.monoExpressBlack !== false ? 1 : 0);
    gl.uniform1i(locs.uMonoExpressWhite, layer.monoExpressWhite !== false ? 1 : 0);
  }

  // Screentone Uniforms
  const toneEnabled = Boolean(layer.toneEnabled);
  gl.uniform1i(locs.uToneEnabled, toneEnabled ? 1 : 0);
  if (toneEnabled) {
    gl.uniform1f(locs.uToneFrequency, layer.toneFrequency ?? 60);
    gl.uniform1f(locs.uToneAngleRad, ((layer.toneAngle ?? 45) * Math.PI) / 180);
    gl.uniform1f(locs.uToneDpi, dimensions.dpi || 600);
    const dotShapeCode =
      layer.toneDotShape === 'line'
        ? 2
        : layer.toneDotShape === 'diamond'
        ? 3
        : layer.toneDotShape === 'euclidean'
        ? 1
        : 0;
    gl.uniform1i(locs.uToneDotShape, dotShapeCode);
    gl.uniform1f(locs.uToneDensity, (layer.toneDensity ?? 40) / 100);
    gl.uniform1i(locs.uToneDensityType, resolveToneDensityType(layer) === 'image' ? 1 : 0);
  }

  // Layer Tint Uniforms
  const tintEnabled = Boolean(layer.layerColorEnabled);
  gl.uniform1i(locs.uLayerColorEnabled, tintEnabled ? 1 : 0);
  if (tintEnabled) {
    const prim = parseHexColor(layer.layerColor || '#1c73c2');
    const sub = parseHexColor(layer.layerSubColor || '#ffffff');
    gl.uniform3f(locs.uLayerColor, prim[0], prim[1], prim[2]);
    gl.uniform3f(locs.uLayerSubColor, sub[0], sub[1], sub[2]);
  }

  // Layer Mask Uniforms
  if (maskTex) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.uniform1i(locs.uMaskEnabled, 1);
  } else {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.uniform1i(locs.uMaskEnabled, 0);
  }

  gl.activeTexture(gl.TEXTURE0);
}

export function renderArtboardBackground(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  dimensions: CanvasDimensions,
  showCheckerboard: boolean,
  drawShadow: boolean = true
): void {
  if (!state.program || !state.stdLocs) return;
  unbindSceneTextureUnits(gl);
  restoreStandardProgram(state, gl);
  syncFrameUniforms(state, gl, state.stdLocs);
  gl.uniform1i(state.uTileTextureLoc, 0);
  gl.uniform1i(state.stdLocs.uMaskTexture, 1);
  gl.uniform1i(state.stdLocs.uBackdropTexture, 2);
  gl.uniform1i(state.stdLocs.uMaskEnabled, 0);
  gl.uniform1i(state.stdLocs.uHasBackdrop, 0);
  gl.blendFunc(gl.ONE, drawShadow ? gl.ONE_MINUS_SRC_ALPHA : gl.ZERO);
  gl.uniform1i(state.uIsBackgroundLoc, 1);
  gl.uniform1i(state.stdLocs.uExpressionMode, 0);
  gl.uniform1i(state.uShowCheckerboardLoc, showCheckerboard ? 1 : 0);
  if (drawShadow) {
    const marginDoc = 56 / Math.max(0.01, state.currentZoom);
    gl.uniform2f(state.uTileOriginLoc, -marginDoc, -marginDoc);
    gl.uniform2f(
      state.uTileSizeLoc,
      dimensions.width + marginDoc * 2,
      dimensions.height + marginDoc * 2
    );
  } else {
    gl.uniform2f(state.uTileOriginLoc, 0, 0);
    gl.uniform2f(state.uTileSizeLoc, dimensions.width, dimensions.height);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.uniform1i(state.uIsBackgroundLoc, 0);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}
