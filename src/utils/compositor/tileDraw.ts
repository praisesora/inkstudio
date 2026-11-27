import { CanvasDimensions, LayerItem } from '../../types/editor';
import { SparseTileGrid, TILE_SIZE, TileBuffer } from '../tileEngine';
import { applyLayerUniforms, restoreStandardProgram, syncFrameUniforms } from './layerUniforms';
import { getOrUploadArrayTileSlice, getTileTexture } from './tileTexturePool';
import { CompositorState } from './types';

/**
 * Fallback per-tile TEXTURE_2D draw loop when visible tile count exceeds TEXTURE_2D_ARRAY pool capacity.
 */
export function drawTilesFallback2D(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  visibleTiles: TileBuffer[],
  grid: SparseTileGrid,
  layer: LayerItem,
  dimensions: CanvasDimensions,
  lodTileDocSize: number,
  effectiveOpacity: number,
  modeCode: number,
  backdropTex: WebGLTexture | null,
  maskTex: WebGLTexture | null
): void {
  if (!state.stdLocs) return;
  restoreStandardProgram(state, gl);
  syncFrameUniforms(state, gl, state.stdLocs);
  gl.uniform1i(state.uTileTextureLoc, 0);
  gl.uniform1i(state.uIsBackgroundLoc, 0);
  applyLayerUniforms(
    state,
    gl,
    state.stdLocs,
    layer,
    dimensions,
    effectiveOpacity,
    modeCode,
    backdropTex,
    maskTex
  );
  gl.uniform2f(state.uTileSizeLoc, lodTileDocSize, lodTileDocSize);

  const forceCrispNearest =
    (Boolean(layer.toneEnabled) || layer.expressionColor === 'monochrome') && state.currentZoom >= 0.99;

  for (const tile of visibleTiles) {
    const tex = getTileTexture(state, tile, grid, forceCrispNearest);
    if (!tex) continue;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform2f(state.uTileOriginLoc, tile.tileX * lodTileDocSize, tile.tileY * lodTileDocSize);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

/**
 * Unified tile draw path used by both normal layers and isolated live Eraser/Alpha-Lock FBOs.
 * Batches via TEXTURE_2D_ARRAY + drawArraysInstanced and orphans instanceBuffer via STREAM_DRAW
 * to prevent ANGLE/D3D11 instance attribute read-after-write hazards across consecutive draws.
 */
export function drawVisibleTiles(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  visibleTiles: TileBuffer[],
  grid: SparseTileGrid,
  layer: LayerItem,
  dimensions: CanvasDimensions,
  lodTileDocSize: number,
  effectiveOpacity: number,
  modeCode: number,
  backdropTex: WebGLTexture | null,
  maskTex: WebGLTexture | null
): void {
  const canBatch =
    visibleTiles.length > 0 &&
    state.instancedProgram !== null &&
    state.instancedLocs !== null &&
    state.tileArrayTexture !== null &&
    state.instanceBuffer !== null &&
    visibleTiles.length <= state.arrayPoolCapacity;

  if (
    canBatch &&
    state.instancedProgram &&
    state.instancedLocs &&
    state.tileArrayTexture &&
    state.instanceBuffer
  ) {
    const batchTick = ++state.arrayBatchCounter;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, state.tileArrayTexture);

    const forceCrispNearest =
      (Boolean(layer.toneEnabled) || layer.expressionColor === 'monochrome') && state.currentZoom >= 0.99;
    const desiredTier =
      forceCrispNearest
        ? 2
        : state.filteringQuality === 'smooth'
          ? 1
          : state.filteringQuality === 'pixelated'
            ? 2
            : state.currentZoom < 0.99
              ? 0
              : state.currentZoom < 2.0
                ? 1
                : 2;
    if (state.arrayPoolFilterTier !== desiredTier) {
      const filter = desiredTier <= 1 ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, filter);
      state.arrayPoolFilterTier = desiredTier;
    }

    let instanceCount = 0;
    let overflowed = false;
    for (let i = 0; i < visibleTiles.length; i++) {
      const tile = visibleTiles[i];
      const sliceIdx = getOrUploadArrayTileSlice(state, gl, tile, grid, batchTick);
      if (sliceIdx < 0) {
        overflowed = true;
        break;
      }
      const off = instanceCount * 3;
      state.instanceFloatScratch[off] = tile.tileX * lodTileDocSize;
      state.instanceFloatScratch[off + 1] = tile.tileY * lodTileDocSize;
      state.instanceFloatScratch[off + 2] = sliceIdx;
      instanceCount++;
    }

    if (!overflowed && instanceCount > 0) {
      gl.useProgram(state.instancedProgram);
      syncFrameUniforms(state, gl, state.instancedLocs);
      gl.uniform2f(state.uInstTileSizeLoc, lodTileDocSize, lodTileDocSize);
      gl.uniform1i(state.uInstTileArrayLoc, 0);
      applyLayerUniforms(
        state,
        gl,
        state.instancedLocs,
        layer,
        dimensions,
        effectiveOpacity,
        modeCode,
        backdropTex,
        maskTex
      );

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, state.tileArrayTexture);

      if (state.instancedVao) {
        gl.bindVertexArray(state.instancedVao);
      } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
        if (state.aInstQuadPosLoc >= 0) {
          gl.enableVertexAttribArray(state.aInstQuadPosLoc);
          gl.vertexAttribPointer(state.aInstQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
          gl.vertexAttribDivisor(state.aInstQuadPosLoc, 0);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, state.instanceBuffer);
        if (state.aInstDataLoc >= 0) {
          gl.enableVertexAttribArray(state.aInstDataLoc);
          gl.vertexAttribPointer(state.aInstDataLoc, 3, gl.FLOAT, false, 0, 0);
          gl.vertexAttribDivisor(state.aInstDataLoc, 1);
        }
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, state.instanceBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        state.instanceFloatScratch.subarray(0, instanceCount * 3),
        gl.STREAM_DRAW
      );
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount);

      if (state.instancedVao) {
        gl.bindVertexArray(null);
      } else if (state.aInstDataLoc >= 0) {
        gl.vertexAttribDivisor(state.aInstDataLoc, 0);
        gl.disableVertexAttribArray(state.aInstDataLoc);
      }
      restoreStandardProgram(state, gl);
      return;
    }
  }

  drawTilesFallback2D(
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

/**
 * Uploads or updates `state.draftTexture` from `draftCanvas` if version or dimensions changed.
 * Returns `true` when `state.draftTexture` is ready to bind.
 */
export function uploadActiveDraftTexture(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  draftCanvas: HTMLCanvasElement,
  draftVersion?: number,
  draftSpace: 'document' | 'viewport' = 'document'
): boolean {
  if (draftCanvas.width <= 0 || draftCanvas.height <= 0) return false;
  if ((draftCanvas as any).__draftHasContent === false) return false;
  if (!state.draftTexture) {
    state.draftTexture = gl.createTexture();
  }
  if (!state.draftTexture) return false;

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.draftTexture);

  const ver = draftVersion ?? -1;
  const hasGenerateMipmap = typeof gl.generateMipmap === 'function';
  // Only rebuild full draft mipmap pyramid below 50% zoom where trilinear minification prevents aliasing;
  // at 50%-100% zoom, hardware GL_LINEAR is sharp and skips a costly 38MB mipmap rebuild every frame!
  const needsMipmap = hasGenerateMipmap && draftSpace === 'document' && state.currentZoom < 0.5;
  const sizeChanged =
    state.draftTexWidth !== draftCanvas.width || state.draftTexHeight !== draftCanvas.height;
  const activeDraftLayerId = state.currentOptions?.activeDraftLayerId ?? null;
  const forceFullUpload = Boolean(
    sizeChanged ||
      state.draftTexWidth === 0 ||
      state.draftNeedsFullUpload ||
      (draftCanvas as any).__draftForceFullUpload === true ||
      state.lastDraftLayerId !== activeDraftLayerId
  );

  if (ver === -1 || ver !== state.lastDraftVersion || forceFullUpload) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      needsMipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR
    );
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    const frameDirty = (draftCanvas as any).__draftFrameDirtyRect as
      | { x: number; y: number; width: number; height: number }
      | null
      | undefined;
    if (frameDirty !== undefined) {
      (draftCanvas as any).__draftFrameDirtyRect = null;
    }
    if (!forceFullUpload && !sizeChanged && state.draftTexWidth > 0 && typeof gl.texSubImage2D === 'function') {
      let uploadedSubRect = false;
      if (
        frameDirty &&
        frameDirty.width > 0 &&
        frameDirty.height > 0 &&
        frameDirty.width * frameDirty.height < draftCanvas.width * draftCanvas.height * 0.5 &&
        typeof document !== 'undefined'
      ) {
        const dx = Math.max(0, Math.min(draftCanvas.width - 1, frameDirty.x | 0));
        const dy = Math.max(0, Math.min(draftCanvas.height - 1, frameDirty.y | 0));
        const dw = Math.max(1, Math.min(draftCanvas.width - dx, Math.ceil(frameDirty.width)));
        const dh = Math.max(1, Math.min(draftCanvas.height - dy, Math.ceil(frameDirty.height)));
        try {
          if (!state.draftUploadCanvas) {
            state.draftUploadCanvas = document.createElement('canvas');
          }
          if (state.draftUploadCanvas.width !== dw || state.draftUploadCanvas.height !== dh) {
            state.draftUploadCanvas.width = dw;
            state.draftUploadCanvas.height = dh;
          }
          const subCtx = state.draftUploadCanvas.getContext('2d');
          if (subCtx && typeof subCtx.drawImage === 'function') {
            subCtx.clearRect(0, 0, dw, dh);
            subCtx.drawImage(draftCanvas, dx, dy, dw, dh, 0, 0, dw, dh);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, dx, dy, gl.RGBA, gl.UNSIGNED_BYTE, state.draftUploadCanvas);
            uploadedSubRect = true;
          }
        } catch {
          uploadedSubRect = false;
        }
      }
      if (!uploadedSubRect) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, draftCanvas);
      }
    } else {
      // Full texture replacement orphans any stale GPU backing from a prior/undone stroke
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, draftCanvas);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (needsMipmap) {
      gl.generateMipmap(gl.TEXTURE_2D);
      state.draftHasMipmap = true;
    } else {
      state.draftHasMipmap = false;
    }
    state.draftTexWidth = draftCanvas.width;
    state.draftTexHeight = draftCanvas.height;
    state.draftNeedsFullUpload = false;
    state.lastDraftLayerId = activeDraftLayerId;
    if ((draftCanvas as any).__draftForceFullUpload) {
      (draftCanvas as any).__draftForceFullUpload = false;
    }
    state.lastDraftVersion = ver;
  } else {
    if (needsMipmap && !state.draftHasMipmap) {
      gl.generateMipmap(gl.TEXTURE_2D);
      state.draftHasMipmap = true;
    }
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      needsMipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR
    );
  }
  const draftMagFilter =
    state.filteringQuality === 'smooth'
      ? gl.LINEAR
      : state.filteringQuality === 'pixelated'
        ? gl.NEAREST
        : state.currentZoom >= 2.0
          ? gl.NEAREST
          : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, draftMagFilter);
  return true;
}

/**
 * Uploads and renders the active draft canvas in-stack for the active layer.
 * Supports both viewport-space overlays (from CanvasArea) and document-space draft canvases.
 */
export function renderActiveDraftForLayer(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  draftCanvas: HTMLCanvasElement,
  layer: LayerItem,
  dimensions: CanvasDimensions,
  effectiveOpacity: number,
  modeCode: number,
  backdropTex: WebGLTexture | null,
  maskTex: WebGLTexture | null,
  draftVersion?: number,
  draftSpace: 'document' | 'viewport' = 'document',
  isDestinationOutMask: boolean = false
): void {
  if (!uploadActiveDraftTexture(state, gl, draftCanvas, draftVersion, draftSpace)) {
    return;
  }

  let effectiveDraftLayer: LayerItem =
    state.currentOptions?.activeDraftMonochrome && layer.expressionColor !== 'monochrome'
      ? { ...layer, expressionColor: 'monochrome' }
      : layer;

  if (isDestinationOutMask) {
    // Destination-out draft is a pure alpha eraser mask; never modulate it by screentone, tint, or mono ink-channel exclusions
    effectiveDraftLayer = {
      ...effectiveDraftLayer,
      toneEnabled: false,
      layerColorEnabled: false,
      monoExpressBlack: true,
      monoExpressWhite: true,
    };
  }

  if (draftSpace === 'viewport' && state.viewportDraftProgram && state.viewportDraftLocs) {
    gl.useProgram(state.viewportDraftProgram);
    syncFrameUniforms(state, gl, state.viewportDraftLocs);
    gl.uniform1i(state.uViewportDraftTileTexLoc, 0);
    gl.uniform1i(state.uViewportDraftIsBgLoc, 0);
    applyLayerUniforms(
      state,
      gl,
      state.viewportDraftLocs,
      effectiveDraftLayer,
      dimensions,
      effectiveOpacity,
      modeCode,
      backdropTex,
      maskTex
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, state.quadBuffer);
    if (state.aViewportDraftQuadPosLoc >= 0) {
      gl.enableVertexAttribArray(state.aViewportDraftQuadPosLoc);
      gl.vertexAttribPointer(state.aViewportDraftQuadPosLoc, 2, gl.FLOAT, false, 0, 0);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.draftTexture);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    restoreStandardProgram(state, gl);
  } else if (state.stdLocs) {
    const docRect = state.currentOptions?.activeDraftDirtyRect;
    const originX = docRect ? docRect.x : 0;
    const originY = docRect ? docRect.y : 0;
    const spanW = docRect ? docRect.width : dimensions.width;
    const spanH = docRect ? docRect.height : dimensions.height;

    restoreStandardProgram(state, gl);
    syncFrameUniforms(state, gl, state.stdLocs);
    gl.uniform1i(state.uTileTextureLoc, 0);
    gl.uniform1i(state.uIsBackgroundLoc, 0);
    applyLayerUniforms(
      state,
      gl,
      state.stdLocs,
      effectiveDraftLayer,
      dimensions,
      effectiveOpacity,
      modeCode,
      backdropTex,
      maskTex
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.draftTexture);
    gl.uniform2f(state.uTileOriginLoc, originX, originY);
    gl.uniform2f(state.uTileSizeLoc, spanW, spanH);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.uniform2f(state.uTileSizeLoc, TILE_SIZE, TILE_SIZE);
  }
}
