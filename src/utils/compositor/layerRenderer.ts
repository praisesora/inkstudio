import { CanvasDimensions, LayerItem } from '../../types/editor';
import { SparseTileGrid, TILE_SIZE, TileBuffer } from '../tileEngine';
import { parseHexColor } from './bounds';
import { blitFolderTexture } from './effectsPass';
import {
  createFboSurface,
  ensureFboSurfaceSize,
  ensureLayerFbo,
  prepareBackdropFromPingPong,
} from './fboManager';
import { restoreStandardProgram, unbindSceneTextureUnits } from './layerUniforms';
import { drawVisibleTiles, renderActiveDraftForLayer } from './tileDraw';
import { getMaskTexture } from './tileTexturePool';
import {
  BLEND_MODE_MAP,
  CompositorState,
  DocumentBounds,
  OnionSkinCompositorFrame,
  PingPongTarget,
  ViewportTransform,
} from './types';

/**
 * Renders all visible tiles of a single layer onto WebGL2 context using:
 * - TEXTURE_2D_ARRAY + gl.drawArraysInstanced batching when all visible tiles fit in the pool
 * - Safe per-tile TEXTURE_2D fallback on pool overflow
 * - Ping-Pong FBO backdrop sampling for custom blend modes (zero gl.copyTexSubImage2D)
 * - In-stack WYSIWYG live draft stroke compositing
 */
export function renderSingleLayer(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  layer: LayerItem,
  dimensions: CanvasDimensions,
  grid: SparseTileGrid,
  frustum: DocumentBounds,
  opacityMultiplier: number = 1.0,
  target: PingPongTarget | null = null,
  preserveStencil: boolean = false
): void {
  if (!state.stdLocs) return;

  // Adaptive LOD Selection & Frustum Culling
  const targetLod =
    state.currentZoom <= 0.125 ? 3 :
    state.currentZoom <= 0.25 ? 2 :
    state.currentZoom <= 0.5 ? 1 : 0;

  const lodScale = 1 << targetLod;
  const lodTileDocSize = TILE_SIZE * lodScale;

  const startTileX = Math.floor(frustum.minX / lodTileDocSize);
  const endTileX = Math.floor(frustum.maxX / lodTileDocSize);
  const startTileY = Math.floor(frustum.minY / lodTileDocSize);
  const endTileY = Math.floor(frustum.maxY / lodTileDocSize);

  const visibleTiles: TileBuffer[] = [];
  const hasLayerTiles =
    typeof grid.hasLayerTiles === 'function' ? grid.hasLayerTiles(layer.id) : true;
  const hasOccCheck = typeof grid.hasPopulatedLodTile === 'function';

  if (hasLayerTiles) {
    for (let ty = startTileY; ty <= endTileY; ty++) {
      for (let tx = startTileX; tx <= endTileX; tx++) {
        if (targetLod > 0 && hasOccCheck && !grid.hasPopulatedLodTile(layer.id, tx, ty, targetLod)) {
          continue;
        }
        let tile = grid.getTile(layer.id, tx, ty, targetLod);
        if (targetLod > 0 && (!tile || tile.data === null || grid.isLodTileDirty(layer.id, tx, ty, targetLod))) {
          tile = grid.generateLodTile(layer.id, tx, ty, targetLod);
        }
        if (tile) {
          visibleTiles.push(tile);
        }
      }
    }
  }

  const opts = state.currentOptions;
  const draftCanvas = opts?.activeDraftLayerId === layer.id ? opts.activeDraftCanvas : null;
  const hasDraft = Boolean(
    draftCanvas &&
    draftCanvas.width > 0 &&
    draftCanvas.height > 0 &&
    (draftCanvas as any).__draftHasContent !== false
  );
  const draftOp = hasDraft && draftCanvas
    ? ((draftCanvas as any).__draftCompositeOp as GlobalCompositeOperation | undefined)
    : undefined;
  const needsIsolatedDraftFbo =
    hasDraft &&
    draftCanvas !== null &&
    (draftOp === 'destination-out' || draftOp === 'source-atop');

  if (visibleTiles.length === 0 && !hasDraft) {
    return;
  }

  const fs = state.currentFrameState;
  const hasMask = Boolean(layer.maskCanvas && layer.maskEnabled !== false);
  const maskTex = hasMask && layer.maskCanvas ? getMaskTexture(state, layer) : null;
  const effectiveOpacity = layer.opacity * opacityMultiplier;

  // Isolated GPU FBO path for WYSIWYG live Eraser (destination-out) and Alpha Lock (source-atop)
  // Erases/paints strictly against this layer's tiles without affecting underlying layers and with zero getImageData!
  if (
    needsIsolatedDraftFbo &&
    draftCanvas &&
    target &&
    fs &&
    fs.viewportW > 0 &&
    fs.viewportH > 0 &&
    ensureLayerFbo(state, fs.viewportW, fs.viewportH) &&
    state.layerFbo &&
    state.layerTexture &&
    state.blitProgram
  ) {
    const stencilWasEnabled = gl.isEnabled(gl.STENCIL_TEST);
    if (stencilWasEnabled) gl.disable(gl.STENCIL_TEST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, state.layerFbo);
    gl.viewport(0, 0, fs.viewportW, fs.viewportH);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const tonePreAppliesOpacity = Boolean(layer.toneEnabled) && draftOp === 'destination-out';
    if (visibleTiles.length > 0) {
      drawVisibleTiles(
        state,
        gl,
        visibleTiles,
        grid,
        layer,
        dimensions,
        lodTileDocSize,
        tonePreAppliesOpacity ? effectiveOpacity : 1.0,
        0,
        null,
        maskTex
      );
    }

    if (draftOp === 'destination-out') {
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.blendFunc(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    renderActiveDraftForLayer(
      state,
      gl,
      draftCanvas,
      layer,
      dimensions,
      opts?.activeDraftOpacity ?? 1.0,
      0,
      null,
      draftOp === 'destination-out' ? null : maskTex,
      opts?.activeDraftVersion,
      opts?.activeDraftSpace ?? 'document',
      draftOp === 'destination-out'
    );

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.surfaces[target.activeIndex].fbo);
    gl.viewport(0, 0, fs.viewportW, fs.viewportH);
    if (stencilWasEnabled) gl.enable(gl.STENCIL_TEST);

    blitFolderTexture(
      state,
      gl,
      state.layerTexture,
      layer.blendMode,
      tonePreAppliesOpacity ? 1.0 : effectiveOpacity,
      fs.viewportW,
      fs.viewportH,
      target,
      preserveStencil
    );

    if (state.stdLocs) {
      if (maskTex) {
        gl.uniform1i(state.stdLocs.uMaskEnabled, 0);
      }
      gl.uniform1i(state.stdLocs.uHasBackdrop, 0);
    }
    unbindSceneTextureUnits(gl);
    return;
  }

  // Prepare Ping-Pong backdrop if custom blend mode is active (zero copyTexSubImage2D)
  const modeCode = BLEND_MODE_MAP[layer.blendMode] ?? 0;
  let backdropTex: WebGLTexture | null = null;
  if (modeCode !== 0 && modeCode !== 12 && target && fs && fs.viewportW > 0 && fs.viewportH > 0) {
    backdropTex = prepareBackdropFromPingPong(
      state,
      gl,
      target,
      fs.viewportW,
      fs.viewportH,
      preserveStencil
    );
  }

  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  if (visibleTiles.length > 0) {
    drawVisibleTiles(
      state,
      gl,
      visibleTiles,
      grid,
      layer,
      dimensions,
      lodTileDocSize,
      effectiveOpacity,
      modeCode,
      backdropTex,
      maskTex
    );
  }

  // WYSIWYG In-Stack Live Stroke Compositing
  if (hasDraft && draftCanvas) {
    if (draftOp === 'destination-out') {
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    } else if (draftOp === 'source-atop') {
      gl.blendFunc(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    renderActiveDraftForLayer(
      state,
      gl,
      draftCanvas,
      layer,
      dimensions,
      effectiveOpacity * (opts?.activeDraftOpacity ?? 1.0),
      modeCode,
      backdropTex,
      draftOp === 'destination-out' ? null : maskTex,
      opts?.activeDraftVersion,
      opts?.activeDraftSpace ?? 'document',
      draftOp === 'destination-out'
    );
    if (draftOp === 'destination-out' || draftOp === 'source-atop') {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  if (state.stdLocs) {
    if (maskTex) {
      gl.uniform1i(state.stdLocs.uMaskEnabled, 0);
    }
    gl.uniform1i(state.stdLocs.uHasBackdrop, 0);
  }
  unbindSceneTextureUnits(gl);
}

/**
 * Evaluates non-destructive GPU layer styles (Stroke, Drop Shadow, Outer Glow)
 * by rendering the layer into an isolated FBO and processing through LAYER_STYLES_FRAGMENT_SHADER.
 */
export function renderLayerWithStyles(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  layer: LayerItem,
  dimensions: CanvasDimensions,
  grid: SparseTileGrid,
  frustum: DocumentBounds,
  viewportW: number,
  viewportH: number,
  transform: ViewportTransform,
  dpr: number,
  opacityMultiplier: number = 1.0,
  target: PingPongTarget | null = null,
  preserveStencil: boolean = false
): void {
  if (!ensureLayerFbo(state, viewportW, viewportH) || !state.stylesProgram) {
    renderSingleLayer(state, gl, layer, dimensions, grid, frustum, opacityMultiplier, target, preserveStencil);
    return;
  }

  const styles = layer.styles;
  if (!styles) {
    renderSingleLayer(state, gl, layer, dimensions, grid, frustum, opacityMultiplier, target, preserveStencil);
    return;
  }

  let maxStyleMargin = 0;
  if (styles.stroke?.enabled) {
    maxStyleMargin = Math.max(maxStyleMargin, styles.stroke.size || 0);
  }
  if (styles.dropShadow?.enabled) {
    maxStyleMargin = Math.max(maxStyleMargin, (styles.dropShadow.distance || 0) + (styles.dropShadow.blur || 0));
  }
  if (styles.outerGlow?.enabled) {
    maxStyleMargin = Math.max(maxStyleMargin, styles.outerGlow.blur || 0);
  }

  const expandedFrustum = {
    minX: Math.max(0, frustum.minX - maxStyleMargin),
    minY: Math.max(0, frustum.minY - maxStyleMargin),
    maxX: Math.min(dimensions.width, frustum.maxX + maxStyleMargin),
    maxY: Math.min(dimensions.height, frustum.maxY + maxStyleMargin),
  };

  // 1. Render layer into isolated FBO with opacity 1.0 (opacity is modulated by stylesProgram)
  const stencilWasEnabled = gl.isEnabled(gl.STENCIL_TEST);
  if (stencilWasEnabled) gl.disable(gl.STENCIL_TEST);

  gl.bindFramebuffer(gl.FRAMEBUFFER, state.layerFbo);
  gl.viewport(0, 0, viewportW, viewportH);
  gl.clearColor(0.0, 0.0, 0.0, 0.0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const virtualLayer: LayerItem = { ...layer, opacity: 1.0, blendMode: 'normal' };
  renderSingleLayer(state, gl, virtualLayer, dimensions, grid, expandedFrustum, 1.0, null, false);

  // 2. Determine whether custom blend mode requires routing styled output through Ping-Pong blit
  const modeCode = BLEND_MODE_MAP[layer.blendMode] ?? 0;
  const needsCustomBlend = modeCode !== 0 && modeCode !== 12 && target !== null;

  if (needsCustomBlend) {
    if (!state.layerStylesOutFbo) {
      state.layerStylesOutFbo = createFboSurface(gl, false);
    }
    if (state.layerStylesOutFbo && ensureFboSurfaceSize(gl, state.layerStylesOutFbo, viewportW, viewportH)) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, state.layerStylesOutFbo.fbo);
      gl.viewport(0, 0, viewportW, viewportH);
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.blendFunc(gl.ONE, gl.ZERO);
    } else {
      const parentFbo = target ? target.surfaces[target.activeIndex].fbo : null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, parentFbo);
      gl.viewport(0, 0, viewportW, viewportH);
      if (stencilWasEnabled) gl.enable(gl.STENCIL_TEST);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  } else {
    const parentFbo = target ? target.surfaces[target.activeIndex].fbo : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, parentFbo);
    gl.viewport(0, 0, viewportW, viewportH);
    if (stencilWasEnabled) gl.enable(gl.STENCIL_TEST);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  // 3. Activate styles program and bind uniforms
  gl.useProgram(state.stylesProgram);

  gl.bindBuffer(gl.ARRAY_BUFFER, state.stylesQuadBuffer);
  if (state.aStylesQuadPosLoc >= 0) {
    gl.enableVertexAttribArray(state.aStylesQuadPosLoc);
    gl.vertexAttribPointer(state.aStylesQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
  }

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.layerTexture);
  gl.uniform1i(state.uStylesLayerTextureLoc, 0);

  gl.uniform2f(state.uStylesViewportSizeLoc, viewportW, viewportH);
  gl.uniform1f(state.uStylesLayerOpacityLoc, layer.opacity * opacityMultiplier);

  const stroke = styles.stroke;
  const strokeActive = Boolean(stroke?.enabled && stroke.size > 0 && stroke.opacity > 0);
  gl.uniform1i(state.uStylesStrokeEnabledLoc, strokeActive ? 1 : 0);
  if (strokeActive && stroke) {
    const strokePx = stroke.size * transform.zoom * dpr;
    gl.uniform1f(state.uStylesStrokeSizeLoc, strokePx);
    const [sr, sg, sb] = parseHexColor(stroke.color || '#000000');
    gl.uniform4f(state.uStylesStrokeColorLoc, sr, sg, sb, stroke.opacity);
    const posCode = stroke.position === 'inside' ? 1 : stroke.position === 'center' ? 2 : 0;
    gl.uniform1i(state.uStylesStrokePositionLoc, posCode);
  }

  const glow = styles.outerGlow;
  const glowActive = Boolean(glow?.enabled && glow.opacity > 0 && glow.blur > 0);
  gl.uniform1i(state.uStylesGlowEnabledLoc, glowActive ? 1 : 0);
  if (glowActive && glow) {
    const glowBlurPx = glow.blur * transform.zoom * dpr;
    gl.uniform1f(state.uStylesGlowBlurLoc, glowBlurPx);
    const [gr, gg, gb] = parseHexColor(glow.color || '#ffff00');
    gl.uniform4f(state.uStylesGlowColorLoc, gr, gg, gb, glow.opacity);
    gl.uniform1f(state.uStylesGlowSpreadLoc, (glow.spread || 0) / 100);
  }

  const shadow = styles.dropShadow;
  const shadowActive = Boolean(shadow?.enabled && shadow.opacity > 0);
  gl.uniform1i(state.uStylesShadowEnabledLoc, shadowActive ? 1 : 0);
  if (shadowActive && shadow) {
    const rad = ((shadow.angle || 0) * Math.PI) / 180;
    const distPx = (shadow.distance || 0) * transform.zoom * dpr;
    const dx = Math.cos(rad) * distPx * (transform.flipX ? -1 : 1);
    const dy = Math.sin(rad) * distPx * (transform.flipY ? -1 : 1);
    gl.uniform2f(state.uStylesShadowOffsetLoc, dx, -dy);
    const shadowBlurPx = (shadow.blur || 0) * transform.zoom * dpr;
    gl.uniform1f(state.uStylesShadowBlurLoc, shadowBlurPx);
    const [dr, dg, db] = parseHexColor(shadow.color || '#000000');
    gl.uniform4f(state.uStylesShadowColorLoc, dr, dg, db, shadow.opacity);
    gl.uniform1f(state.uStylesShadowSpreadLoc, (shadow.spread || 0) / 100);
  }

  // 4. Draw fullscreen quad
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // 5. If custom blend mode was routed to layerStylesOutFbo, composite onto parent Ping-Pong target
  if (needsCustomBlend && state.layerStylesOutFbo && target) {
    const parentFbo = target.surfaces[target.activeIndex].fbo;
    gl.bindFramebuffer(gl.FRAMEBUFFER, parentFbo);
    gl.viewport(0, 0, viewportW, viewportH);
    if (stencilWasEnabled) gl.enable(gl.STENCIL_TEST);
    blitFolderTexture(
      state,
      gl,
      state.layerStylesOutFbo.texture,
      layer.blendMode,
      1.0,
      viewportW,
      viewportH,
      target,
      preserveStencil
    );
    return;
  }

  // 6. Restore standard program and quad buffer
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  restoreStandardProgram(state, gl);
}

export function renderOnionSkins(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  layers: LayerItem[],
  onionSkinFrames: OnionSkinCompositorFrame[] | undefined,
  dimensions: CanvasDimensions,
  grid: SparseTileGrid,
  frustum: DocumentBounds,
  target: PingPongTarget | null
): void {
  if (!onionSkinFrames || onionSkinFrames.length === 0) return;
  for (const onion of onionSkinFrames) {
    const targetLayer = layers.find((l) => l.id === onion.layerId);
    if (targetLayer && targetLayer.visible) {
      const virtualOnionLayer: LayerItem = {
        ...targetLayer,
        opacity: onion.opacity,
        layerColorEnabled: true,
        layerColor: onion.tint,
        layerSubColor: '#ffffff',
        blendMode: 'normal',
      };
      renderSingleLayer(state, gl, virtualOnionLayer, dimensions, grid, frustum, 1.0, target, false);
    }
  }
}
