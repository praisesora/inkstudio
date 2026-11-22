import { BlendMode, CanvasDimensions, LayerItem, SoftProofSettings } from '../../types/editor';
import {
  buildCurvesCombinedLut,
  buildGradientMapLut,
  buildLevelsLut,
  evaluateColorBalancePixel,
} from '../tonalEngine';
import { parseHexColor } from './bounds';
import { prepareBackdropFromPingPong } from './fboManager';
import { restoreStandardProgram, unbindSceneTextureUnits } from './layerUniforms';
import { getMaskTexture } from './tileTexturePool';
import { BLEND_MODE_MAP, CompositorState, PingPongTarget, ViewportTransform } from './types';

/**
 * Evaluates non-destructive adjustment layers via Ping-Pong FBO backdrop and version-cached LUT evaluation.
 */
export function renderAdjustmentLayer(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  layer: LayerItem,
  transform: ViewportTransform,
  dimensions: CanvasDimensions,
  viewportW: number,
  viewportH: number,
  dpr: number,
  opacityMultiplier: number = 1.0,
  target: PingPongTarget | null = null,
  preserveStencil: boolean = false
): void {
  if (!state.adjProgram || !layer.adjustmentData || !target) return;

  // 1. Ping-Pong swap to sample accumulated backdrop texture without copyTexSubImage2D
  const backdropTex = prepareBackdropFromPingPong(
    state,
    gl,
    target,
    viewportW,
    viewportH,
    preserveStencil
  );

  // 2. Prepare 256x1 LUT (Cached by AdjustmentLayerData signature)
  if (!state.lutTexture) {
    state.lutTexture = gl.createTexture();
    state.lastLutKey = '';
  }
  const adj = layer.adjustmentData;
  const lutKey = JSON.stringify(adj);

  if (lutKey !== state.lastLutKey) {
    let lutData: Uint8Array;
    let adjMode = 0; // 0 = per-channel, 1 = gradient map

    if (adj.type === 'curves') {
      const { rLut, gLut, bLut } = buildCurvesCombinedLut(adj.curves);
      lutData = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        const off = i * 4;
        lutData[off] = rLut[i];
        lutData[off + 1] = gLut[i];
        lutData[off + 2] = bLut[i];
        lutData[off + 3] = 255;
      }
    } else if (adj.type === 'gradient-map') {
      adjMode = 1;
      const gMap = buildGradientMapLut(adj.stops, adj.interpolation || 'linear');
      lutData = new Uint8Array(gMap.buffer, gMap.byteOffset, gMap.byteLength);
    } else if (adj.type === 'levels') {
      const lLut = buildLevelsLut(
        adj.blackPoint,
        adj.whitePoint,
        adj.gamma,
        adj.outputMin ?? 0,
        adj.outputMax ?? 255
      );
      const ch = adj.channel || 'rgb';
      lutData = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        const off = i * 4;
        lutData[off] = ch === 'rgb' || ch === 'r' ? lLut[i] : i;
        lutData[off + 1] = ch === 'rgb' || ch === 'g' ? lLut[i] : i;
        lutData[off + 2] = ch === 'rgb' || ch === 'b' ? lLut[i] : i;
        lutData[off + 3] = 255;
      }
    } else {
      lutData = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        const [r, g, b] = evaluateColorBalancePixel(i, i, i, adj);
        const off = i * 4;
        lutData[off] = r;
        lutData[off + 1] = g;
        lutData[off + 2] = b;
        lutData[off + 3] = 255;
      }
    }

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, state.lutTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutData);

    state.lastLutKey = lutKey;
    state.lastLutAdjMode = adjMode;
  }

  // 3. Switch to Adjustment Program
  gl.useProgram(state.adjProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
  if (state.aQuadPosLoc >= 0) {
    gl.enableVertexAttribArray(state.aQuadPosLoc);
    gl.vertexAttribPointer(state.aQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
  }

  gl.uniform2f(state.uAdjViewportSizeLoc, viewportW, viewportH);
  gl.uniform2f(state.uAdjDocDimensionsLoc, dimensions.width, dimensions.height);
  gl.uniform2f(state.uAdjPanLoc, transform.pan.x, transform.pan.y);
  gl.uniform1f(state.uAdjZoomLoc, transform.zoom);
  const rotRad = (transform.rotation * Math.PI) / 180;
  gl.uniform1f(state.uAdjRotationRadLoc, rotRad);
  gl.uniform2f(state.uAdjFlipLoc, transform.flipX ? -1.0 : 1.0, transform.flipY ? -1.0 : 1.0);
  gl.uniform1f(state.uAdjDprLoc, dpr);

  gl.uniform2f(state.uAdjTileOriginLoc, 0, 0);
  gl.uniform2f(state.uAdjTileSizeLoc, dimensions.width, dimensions.height);

  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, backdropTex);
  gl.uniform1i(state.uAdjSnapshotLoc, 2);

  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, state.lutTexture);
  gl.uniform1i(state.uAdjLutLoc, 3);

  gl.uniform1i(state.uAdjModeLoc, state.lastLutAdjMode);
  gl.uniform1f(state.uAdjOpacityLoc, layer.opacity * opacityMultiplier);

  const hasMask = Boolean(layer.maskCanvas && layer.maskEnabled !== false);
  gl.uniform1i(state.uAdjMaskEnabledLoc, hasMask ? 1 : 0);
  if (hasMask && layer.maskCanvas) {
    const maskTex = getMaskTexture(state, layer);
    if (maskTex) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, maskTex);
      gl.uniform1i(state.uAdjMaskTextureLoc, 1);
    }
  }

  // Overwrite document region with filtered result
  gl.blendFunc(gl.ONE, gl.ZERO);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // Revert program, unbind backdrop texture to avoid feedback loops, and restore blend func
  unbindSceneTextureUnits(gl);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  restoreStandardProgram(state, gl);
}

export function drawFramePolygonTriangles(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  vertices: Float32Array,
  r: number,
  g: number,
  b: number,
  a: number,
  dimensions: CanvasDimensions,
  viewportW: number,
  viewportH: number,
  transform: ViewportTransform,
  dpr: number
): void {
  if (!state.framePolyProgram || !state.framePolyBuffer || vertices.length < 6) return;
  gl.useProgram(state.framePolyProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.framePolyBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
  if (state.aFramePolyDocPosLoc >= 0) {
    gl.enableVertexAttribArray(state.aFramePolyDocPosLoc);
    gl.vertexAttribPointer(state.aFramePolyDocPosLoc, 2, gl.FLOAT, false, 0, 0);
  }
  gl.uniform2f(state.uFramePolyDocDimensionsLoc, dimensions.width, dimensions.height);
  gl.uniform2f(state.uFramePolyViewportSizeLoc, viewportW, viewportH);
  gl.uniform2f(state.uFramePolyPanLoc, transform.pan.x, transform.pan.y);
  gl.uniform1f(state.uFramePolyZoomLoc, transform.zoom);
  gl.uniform1f(state.uFramePolyRotationRadLoc, (transform.rotation * Math.PI) / 180);
  gl.uniform2f(state.uFramePolyFlipLoc, transform.flipX ? -1.0 : 1.0, transform.flipY ? -1.0 : 1.0);
  gl.uniform1f(state.uFramePolyDprLoc, dpr);
  gl.uniform4f(state.uFramePolyColorLoc, r, g, b, a);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 2);
  restoreStandardProgram(state, gl);
}

/**
 * Blits an isolated folder or baked cache texture onto the active Ping-Pong target
 * with full programmable blend mode support and zero gl.copyTexSubImage2D calls.
 */
export function blitFolderTexture(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  blendMode: BlendMode,
  opacity: number,
  viewportW: number,
  viewportH: number,
  target: PingPongTarget | null = null,
  preserveStencil: boolean = false
): void {
  if (!state.blitProgram) return;

  const modeCode = BLEND_MODE_MAP[blendMode] ?? 0;
  let hasBackdrop = 0;
  if (modeCode !== 0 && modeCode !== 12 && target && viewportW > 0 && viewportH > 0) {
    const backdropTex = prepareBackdropFromPingPong(
      state,
      gl,
      target,
      viewportW,
      viewportH,
      preserveStencil
    );
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, backdropTex);
    hasBackdrop = 1;
  }

  gl.viewport(0, 0, viewportW, viewportH);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  gl.useProgram(state.blitProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.stylesQuadBuffer || state.quadBuffer);
  if (state.aBlitQuadPosLoc >= 0) {
    gl.enableVertexAttribArray(state.aBlitQuadPosLoc);
    gl.vertexAttribPointer(state.aBlitQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
  }

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(state.uBlitTextureLoc, 0);
  gl.uniform1i(state.uBlitBackdropTextureLoc, 2);
  gl.uniform1i(state.uBlitHasBackdropLoc, hasBackdrop);
  gl.uniform1i(state.uBlitBlendModeLoc, modeCode);
  gl.uniform1f(state.uBlitOpacityLoc, opacity);

  gl.drawArrays(gl.TRIANGLES, 0, 6);

  unbindSceneTextureUnits(gl);
  restoreStandardProgram(state, gl);
}

/**
 * Post-processing pass: CMYK Soft Proofing and Gamut Warning.
 * Samples directly from the Ping-Pong scene FBO texture into the default framebuffer (zero copyTexSubImage2D).
 */
export function applySoftProofPass(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  viewportW: number,
  viewportH: number,
  settings: SoftProofSettings,
  sceneTexture: WebGLTexture
): void {
  if (!state.softProofProgram) return;

  gl.useProgram(state.softProofProgram);

  const standardIndex =
    settings.standard === 'japan-color-2001'
      ? 0
      : settings.standard === 'us-web-coated-swop'
      ? 1
      : 2;
  gl.uniform1i(state.uProofStandardLoc, standardIndex);
  gl.uniform1i(state.uProofEnabledLoc, settings.enabled ? 1 : 0);
  gl.uniform1i(state.uProofGamutWarningLoc, settings.gamutWarning ? 1 : 0);

  const warnRgb = parseHexColor(settings.gamutWarningColor || '#7f7f7f');
  gl.uniform3f(state.uProofGamutWarningColorLoc, warnRgb[0], warnRgb[1], warnRgb[2]);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
  gl.uniform1i(state.uProofSceneTextureLoc, 0);

  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.BLEND);

  const quadBuffer = state.stylesQuadBuffer || state.quadBuffer;
  if (quadBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    if (state.aProofQuadPosLoc >= 0) {
      gl.enableVertexAttribArray(state.aProofQuadPosLoc);
      gl.vertexAttribPointer(state.aProofQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
    }

    gl.viewport(0, 0, viewportW, viewportH);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  unbindSceneTextureUnits(gl);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  restoreStandardProgram(state, gl);
}

export function presentTextureToScreen(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  viewportW: number,
  viewportH: number,
  softProof?: SoftProofSettings
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, viewportW, viewportH);
  gl.disable(gl.STENCIL_TEST);

  if (softProof && (softProof.enabled || softProof.gamutWarning) && state.softProofProgram) {
    applySoftProofPass(state, gl, viewportW, viewportH, softProof, texture);
    return;
  }

  gl.clearColor(0.0, 0.0, 0.0, 0.0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  if (!state.blitProgram) return;
  gl.disable(gl.BLEND);
  gl.useProgram(state.blitProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.stylesQuadBuffer || state.quadBuffer);
  if (state.aBlitQuadPosLoc >= 0) {
    gl.enableVertexAttribArray(state.aBlitQuadPosLoc);
    gl.vertexAttribPointer(state.aBlitQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
  }

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(state.uBlitTextureLoc, 0);
  gl.uniform1i(state.uBlitBackdropTextureLoc, 2);
  gl.uniform1i(state.uBlitHasBackdropLoc, 0);
  gl.uniform1i(state.uBlitBlendModeLoc, 0);
  gl.uniform1f(state.uBlitOpacityLoc, 1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  unbindSceneTextureUnits(gl);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  restoreStandardProgram(state, gl);
}
