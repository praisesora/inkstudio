import { BlendMode, CanvasDimensions, LayerItem } from '../../types/editor';
import { SparseTileGrid, globalTileGrid } from '../tileEngine';
import { calculateVisibleDocumentBounds } from './bounds';
import { blitFolderTexture, presentTextureToScreen } from './effectsPass';
import { render2DFallback } from './fallback2d';
import {
  copyFboSurface,
  createFboSurface,
  disposeFboSurface,
  ensureFboSurfaceSize,
  ensurePingPongTarget,
} from './fboManager';
import { renderOnionSkins } from './layerRenderer';
import { buildLayerTree } from './layerTree';
import {
  renderArtboardBackground,
  restoreStandardProgram,
  syncFrameUniforms,
} from './layerUniforms';
import { evictStaleTextures } from './tileTexturePool';
import {
  CompositorOptions,
  CompositorState,
  MAX_TEXTURE_POOL_SIZE,
  ViewportTransform,
} from './types';
import { renderCompositingUnit, renderNodeList } from './unitRenderer';

/**
 * Main Render Pass: Composite all visible layers onto the viewport canvas using:
 * 1. Ping-Pong FBOs (zero gl.copyTexSubImage2D calls for all 16 blend modes, adjustments, & soft proof)
 * 2. Baked Layer Stack Cache (`belowActiveCacheFbo` + `activeUnit` + `aboveActiveCacheFbo`)
 * 3. TEXTURE_2D_ARRAY + gl.drawArraysInstanced tile batching
 */
export function renderFrame(
  state: CompositorState,
  layers: LayerItem[],
  transform: ViewportTransform,
  dimensions: CanvasDimensions,
  grid: SparseTileGrid = globalTileGrid,
  _options: CompositorOptions = { dimensions }
): void {
  state.lastRenderedGrid = grid;
  const gl = state.gl;
  state.currentOptions = _options;
  state.currentZoom = transform.zoom;

  if (!gl || !state.program || !state.stdLocs) {
    render2DFallback(state, layers, transform, dimensions, grid, _options);
    return;
  }

  const viewportW = Math.max(1, state.canvas.width);
  const viewportH = Math.max(1, state.canvas.height);
  const dpr = _options.devicePixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1) ?? 1;
  const rotRad = (transform.rotation * Math.PI) / 180;

  state.currentFrameState = {
    viewportW,
    viewportH,
    dpr,
    dimensions,
    transform,
    rotRad,
  };

  // Calculate Frustum Culling document bounds
  const viewportCssW = viewportW / dpr;
  const viewportCssH = viewportH / dpr;
  const frustum = calculateVisibleDocumentBounds(
    viewportCssW,
    viewportCssH,
    transform,
    dimensions.width,
    dimensions.height
  );

  // Dynamic Frustum Culling & Memory Budget Sync (reuse persistent Map — zero per-frame allocation)
  const activeLayerId = _options.activeLayerId ?? _options.activeDraftLayerId ?? null;
  const layerVis = state.layerVisScratch;
  layerVis.clear();
  for (let i = 0; i < layers.length; i++) {
    layerVis.set(layers[i].id, layers[i].visible);
  }
  grid.getMemoryManager()?.updateViewport(frustum, activeLayerId, layerVis);

  // Ensure Ping-Pong Scene FBOs & Baked Layer Stack Cache FBOs
  const scenePP = ensurePingPongTarget(gl, state.scenePingPong, viewportW, viewportH);
  state.scenePingPong = scenePP;

  const bypassStackCache = Boolean(_options.bypassStackCache);
  let belowCacheReady = false;
  let aboveCacheReady = false;
  if (bypassStackCache) {
    if (state.belowActiveCacheFbo) {
      disposeFboSurface(gl, state.belowActiveCacheFbo);
      state.belowActiveCacheFbo = null;
      state.stackCache.invalidateAll();
    }
    if (state.aboveActiveCacheFbo) {
      disposeFboSurface(gl, state.aboveActiveCacheFbo);
      state.aboveActiveCacheFbo = null;
      state.stackCache.invalidateAll();
    }
  } else if (scenePP) {
    if (!state.belowActiveCacheFbo) {
      state.belowActiveCacheFbo = createFboSurface(gl, false);
    }
    if (state.belowActiveCacheFbo) {
      belowCacheReady = ensureFboSurfaceSize(gl, state.belowActiveCacheFbo, viewportW, viewportH);
    }
    if (!state.aboveActiveCacheFbo) {
      state.aboveActiveCacheFbo = createFboSurface(gl, false);
    }
    if (state.aboveActiveCacheFbo) {
      aboveCacheReady = ensureFboSurfaceSize(gl, state.aboveActiveCacheFbo, viewportW, viewportH);
    }
  }

  if (bypassStackCache && scenePP) {
    restoreStandardProgram(state, gl);
    syncFrameUniforms(state, gl, state.stdLocs);
    gl.uniform1i(state.uTileTextureLoc, 0);
    gl.uniform1i(state.stdLocs.uHasBackdrop, 0);

    scenePP.activeIndex = 0;
    const surf = scenePP.surfaces[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, surf.fbo);
    gl.viewport(0, 0, viewportW, viewportH);
    gl.disable(gl.STENCIL_TEST);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    if (!_options.transparentBackground) {
      renderArtboardBackground(state, gl, dimensions, Boolean(_options.showCheckerboard), false);
    }
    renderOnionSkins(state, gl, layers, _options.onionSkinFrames, dimensions, grid, frustum, scenePP);

    const tree = buildLayerTree(layers);
    renderNodeList(
      state,
      gl,
      tree,
      dimensions,
      grid,
      frustum,
      viewportW,
      viewportH,
      transform,
      dpr,
      scenePP,
      0,
      1.0
    );

    presentTextureToScreen(
      state,
      gl,
      scenePP.surfaces[scenePP.activeIndex].texture,
      viewportW,
      viewportH,
      _options.softProof
    );
  } else if (
    scenePP &&
    belowCacheReady &&
    aboveCacheReady &&
    state.belowActiveCacheFbo &&
    state.aboveActiveCacheFbo
  ) {
    // Evaluate Baked Layer Stack Cache invalidation (below / active / above)
    const cacheEval = state.stackCache.evaluate({
      layers,
      activeLayerId,
      viewportW,
      viewportH,
      dpr,
      dimensions,
      transform,
      showCheckerboard: Boolean(_options.showCheckerboard),
      transparentBackground: Boolean(_options.transparentBackground),
      colorMode: _options.colorMode,
      onionSkinFrames: _options.onionSkinFrames,
      getLayerContentVersion: (id) =>
        typeof grid.getLayerVersion === 'function' ? grid.getLayerVersion(id) : 0,
      getMaskInvalidationEpoch: (id) => state.maskInvalidationEpochs.get(id) ?? 0,
      gridEpoch: typeof grid.getGridEpoch === 'function' ? grid.getGridEpoch() : 0,
      gridId: typeof grid.getGridId === 'function' ? grid.getGridId() : 0,
    });

    const { partition } = cacheEval;
    restoreStandardProgram(state, gl);
    syncFrameUniforms(state, gl, state.stdLocs);
    gl.uniform1i(state.uTileTextureLoc, 0);
    gl.uniform1i(state.stdLocs.uHasBackdrop, 0);

    // Step 1: Rebuild aboveActiveCacheFbo ONLY when upper slice metadata/content/camera changed
    if (cacheEval.aboveDirty && partition.aboveCachedUnits.length > 0) {
      scenePP.activeIndex = 0;
      const surf = scenePP.surfaces[0];
      gl.bindFramebuffer(gl.FRAMEBUFFER, surf.fbo);
      gl.viewport(0, 0, viewportW, viewportH);
      gl.disable(gl.STENCIL_TEST);
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

      const overrideRootBlend = partition.aboveStrategy === 'baked-single-blend';
      for (const unit of partition.aboveCachedUnits) {
        renderCompositingUnit(
          state,
          gl,
          unit,
          dimensions,
          grid,
          frustum,
          viewportW,
          viewportH,
          transform,
          dpr,
          scenePP,
          0,
          overrideRootBlend
        );
      }

      copyFboSurface(
        state,
        gl,
        scenePP.surfaces[scenePP.activeIndex],
        state.aboveActiveCacheFbo,
        viewportW,
        viewportH,
        false
      );
      state.stackCacheStats.aboveRebuilds++;
    }

    // Step 2: Populate scenePP with below slice (either rebuild belowActiveCacheFbo or fast GPU blit)
    if (cacheEval.belowDirty) {
      scenePP.activeIndex = 0;
      const surf = scenePP.surfaces[0];
      gl.bindFramebuffer(gl.FRAMEBUFFER, surf.fbo);
      gl.viewport(0, 0, viewportW, viewportH);
      gl.disable(gl.STENCIL_TEST);
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

      if (!_options.transparentBackground) {
        renderArtboardBackground(state, gl, dimensions, Boolean(_options.showCheckerboard));
      }
      renderOnionSkins(state, gl, layers, _options.onionSkinFrames, dimensions, grid, frustum, scenePP);

      for (const unit of partition.belowUnits) {
        renderCompositingUnit(
          state,
          gl,
          unit,
          dimensions,
          grid,
          frustum,
          viewportW,
          viewportH,
          transform,
          dpr,
          scenePP,
          0,
          false
        );
      }

      copyFboSurface(
        state,
        gl,
        scenePP.surfaces[scenePP.activeIndex],
        state.belowActiveCacheFbo,
        viewportW,
        viewportH,
        false
      );
      // Ensure scenePP's current surface remains bound for activeUnit
      gl.bindFramebuffer(gl.FRAMEBUFFER, scenePP.surfaces[scenePP.activeIndex].fbo);
      gl.viewport(0, 0, viewportW, viewportH);
      state.stackCacheStats.belowRebuilds++;
    } else {
      scenePP.activeIndex = 0;
      copyFboSurface(
        state,
        gl,
        state.belowActiveCacheFbo,
        scenePP.surfaces[0],
        viewportW,
        viewportH,
        false
      );
      if (!cacheEval.aboveDirty) {
        state.stackCacheStats.cacheHits++;
      }
    }

    // Step 3: Render active unit (+ live activeDraftCanvas in-stack!)
    if (partition.activeUnit) {
      renderCompositingUnit(
        state,
        gl,
        partition.activeUnit,
        dimensions,
        grid,
        frustum,
        viewportW,
        viewportH,
        transform,
        dpr,
        scenePP,
        0,
        false
      );
    }

    // Step 4: Render any dynamic non-associative upper units (via Ping-Pong FBOs, zero copyTexSubImage2D)
    for (const unit of partition.aboveDynamicUnits) {
      renderCompositingUnit(
        state,
        gl,
        unit,
        dimensions,
        grid,
        frustum,
        viewportW,
        viewportH,
        transform,
        dpr,
        scenePP,
        0,
        false
      );
    }

    // Step 5: Composite baked aboveActiveCacheFbo (1 single quad / 1 ping-pong blend pass)
    if (partition.aboveCachedUnits.length > 0) {
      const aboveBlend: BlendMode =
        partition.aboveStrategy === 'baked-single-blend'
          ? partition.aboveCacheBlendMode
          : 'normal';
      blitFolderTexture(
        state,
        gl,
        state.aboveActiveCacheFbo.texture,
        aboveBlend,
        1.0,
        viewportW,
        viewportH,
        scenePP,
        false
      );
    }

    state.stackCache.commit(cacheEval.belowSignature, cacheEval.aboveSignature);

    // Step 6: Present final composited Ping-Pong surface to screen (with optional CMYK soft proofing)
    presentTextureToScreen(
      state,
      gl,
      scenePP.surfaces[scenePP.activeIndex].texture,
      viewportW,
      viewportH,
      _options.softProof
    );
  } else {
    // Safe fallback when offscreen FBOs are unsupported in a minimal WebGL context
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, viewportW, viewportH);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    if (!_options.transparentBackground) {
      renderArtboardBackground(state, gl, dimensions, Boolean(_options.showCheckerboard), false);
    }
    renderOnionSkins(state, gl, layers, _options.onionSkinFrames, dimensions, grid, frustum, null);

    const tree = buildLayerTree(layers);
    renderNodeList(
      state,
      gl,
      tree,
      dimensions,
      grid,
      frustum,
      viewportW,
      viewportH,
      transform,
      dpr,
      null,
      0,
      1.0
    );
  }

  // Prune mask textures belonging to deleted layers
  if (state.maskTextureCache.size > layers.length) {
    for (const cachedLayerId of Array.from(state.maskTextureCache.keys())) {
      if (!layerVis.has(cachedLayerId)) {
        const entry = state.maskTextureCache.get(cachedLayerId);
        if (entry) gl.deleteTexture(entry.texture);
        state.maskTextureCache.delete(cachedLayerId);
        state.maskInvalidationEpochs.delete(cachedLayerId);
      }
    }
  }

  // Clean up stale textures if fallback pool exceeded limit
  const maxPool = state.maxTexturePoolSize || MAX_TEXTURE_POOL_SIZE;
  if (state.texturePool.length > maxPool) {
    evictStaleTextures(state);
  }
}
