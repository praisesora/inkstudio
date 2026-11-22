import { LayerItem } from '../../types/editor';
import { SparseTileGrid, TILE_SIZE, TileBuffer, getTileKey } from '../tileEngine';
import { premultiplyTileBytes } from './bounds';
import { CompositorState, MAX_TEXTURE_POOL_SIZE } from './types';

/**
 * Explicitly invalidate a cached layer mask texture (or all masks if layerId omitted).
 */
export function invalidateMaskTexture(state: CompositorState, layerId?: string): void {
  const nextEpoch = ++state.globalMaskEpochCounter;
  if (layerId) {
    const item = state.maskTextureCache.get(layerId);
    if (item) item.version = -1;
    state.maskInvalidationEpochs.set(layerId, nextEpoch);
  } else {
    for (const [id, item] of state.maskTextureCache.entries()) {
      item.version = -1;
      state.maskInvalidationEpochs.set(id, nextEpoch);
    }
    state.stackCache.invalidateAll();
  }
}

/**
 * Explicitly invalidate and clear all cached tile textures in both TEXTURE_2D and TEXTURE_2D_ARRAY pools.
 */
export function invalidateTileTextures(state: CompositorState): void {
  if (state.gl) {
    for (const slot of state.texturePool) {
      state.gl.deleteTexture(slot.texture);
    }
  }
  state.texturePool = [];
  state.activePoolByKey.clear();
  state.freeArraySlots = [];
  for (let i = state.arrayPoolSlots.length - 1; i >= 0; i--) {
    const slot = state.arrayPoolSlots[i];
    slot.currentKey = null;
    slot.version = -1;
    slot.lastUsed = 0;
    slot.lastBatchTick = 0;
    state.freeArraySlots.push(slot);
  }
  state.arrayPoolByKey.clear();
  state.stackCache.invalidateAll();
}

/**
 * Allocates or updates a slice inside the TEXTURE_2D_ARRAY pool.
 * Never evicts slices pinned by the current batchTick.
 */
export function getOrUploadArrayTileSlice(
  state: CompositorState,
  gl: WebGL2RenderingContext,
  tile: TileBuffer,
  grid: SparseTileGrid,
  batchTick: number
): number {
  const gridId = typeof grid.getGridId === 'function' ? grid.getGridId() : 0;
  const key = `${gridId}:${getTileKey(tile.layerId, tile.tileX, tile.tileY, tile.lod ?? 0)}`;
  const accessTick = ++state.arrayAccessCounter;
  let slot = state.arrayPoolByKey.get(key);

  if (slot) {
    // O(1) LRU promotion via JS Map insertion order
    state.arrayPoolByKey.delete(key);
    state.arrayPoolByKey.set(key, slot);
  } else {
    if (state.freeArraySlots.length > 0) {
      slot = state.freeArraySlots.pop()!;
    } else {
      // Evict oldest unpinned slot from front of Map (O(1) amortized)
      for (const candidate of state.arrayPoolByKey.values()) {
        if (candidate.lastBatchTick !== batchTick) {
          slot = candidate;
          break;
        }
      }
      if (!slot) return -1;
      if (slot.currentKey) {
        state.arrayPoolByKey.delete(slot.currentKey);
      }
    }
    slot.currentKey = key;
    slot.version = -1;
    state.arrayPoolByKey.set(key, slot);
  }

  slot.lastUsed = accessTick;
  slot.lastBatchTick = batchTick;

  if (slot.version !== tile.version) {
    const rgbaData = grid.getTileAsRGBA(tile);
    const srcBytes =
      rgbaData instanceof Uint8Array
        ? rgbaData
        : new Uint8Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength);

    // Premultiply once on upload into reusable scratch buffer (TileBuffer remains straight-alpha;
    // UNPACK_PREMULTIPLY_ALPHA_WEBGL stays false for WebGL2 spec compliance on texSubImage3D).
    const uploadBytes = premultiplyTileBytes(srcBytes, tile, state.uploadPremulScratch);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      slot.sliceIndex,
      TILE_SIZE,
      TILE_SIZE,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      uploadBytes
    );

    slot.version = tile.version;
  }

  return slot.sliceIndex;
}

/**
 * Get or upload a WebGLTexture from the fallback TEXTURE_2D pool with adaptive zoom filtering.
 * Uses gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true) directly — zero CPU premultiply loop!
 */
export function getTileTexture(
  state: CompositorState,
  tile: TileBuffer,
  grid: SparseTileGrid
): WebGLTexture | null {
  if (!state.gl) return null;
  const gl = state.gl;
  const gridId = typeof grid.getGridId === 'function' ? grid.getGridId() : 0;
  const key = `${gridId}:${getTileKey(tile.layerId, tile.tileX, tile.tileY, tile.lod ?? 0)}`;
  const accessTick = ++state.textureAccessCounter;

  let slot = state.activePoolByKey.get(key);

  if (slot) {
    // O(1) LRU promotion via JS Map insertion order
    state.activePoolByKey.delete(key);
    state.activePoolByKey.set(key, slot);
  } else {
    if (state.texturePool.length < MAX_TEXTURE_POOL_SIZE) {
      const tex = gl.createTexture();
      if (!tex) return null;
      slot = {
        texture: tex,
        currentKey: key,
        version: -1,
        lastUsed: accessTick,
        filterTier: -1,
        hasStorage: false,
        hasMipmap: false,
      };
      state.texturePool.push(slot);
      state.activePoolByKey.set(key, slot);
    } else {
      // O(1) LRU eviction from front of activePoolByKey Map
      const oldestEntry = state.activePoolByKey.entries().next();
      if (!oldestEntry.done) {
        slot = oldestEntry.value[1];
        state.activePoolByKey.delete(oldestEntry.value[0]);
      } else {
        slot = state.texturePool[0];
      }
      slot.currentKey = key;
      slot.version = -1;
      slot.lastUsed = accessTick;
      slot.filterTier = -1;
      slot.hasMipmap = false;
      state.activePoolByKey.set(key, slot);
    }
  }

  slot.lastUsed = accessTick;
  const desiredTier = state.currentZoom < 0.99 ? 0 : state.currentZoom < 2.0 ? 1 : 2;

  // Re-upload if version changed (direct GPU unpack premultiplication, zero JS pixel loop)
  if (slot.version !== tile.version) {
    gl.bindTexture(gl.TEXTURE_2D, slot.texture);

    const rgbaData = grid.getTileAsRGBA(tile);
    const srcBytes =
      rgbaData instanceof Uint8Array
        ? rgbaData
        : new Uint8Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (slot.hasStorage && typeof gl.texSubImage2D === 'function') {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        TILE_SIZE,
        TILE_SIZE,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        srcBytes
      );
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        TILE_SIZE,
        TILE_SIZE,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        srcBytes
      );
      slot.hasStorage = true;
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    slot.hasMipmap = false;
    slot.version = tile.version;
    slot.filterTier = -1; // Force filter parameter refresh
  }

  if (slot.filterTier !== desiredTier) {
    gl.bindTexture(gl.TEXTURE_2D, slot.texture);
    if (desiredTier <= 1) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    slot.filterTier = desiredTier;
  }

  return slot.texture;
}

/**
 * Get or upload a WebGLTexture for a layer's mask canvas with dirty-version caching.
 */
export function getMaskTexture(state: CompositorState, layer: LayerItem): WebGLTexture | null {
  if (!state.gl || !layer.maskCanvas) return null;
  const gl = state.gl;
  let cached = state.maskTextureCache.get(layer.id);
  const currentVersion = layer.maskVersion ?? 0;
  const maskW = layer.maskCanvas.width;
  const maskH = layer.maskCanvas.height;

  if (!cached) {
    const tex = gl.createTexture();
    if (!tex) return null;
    cached = { texture: tex, version: -1, width: 0, height: 0 };
    state.maskTextureCache.set(layer.id, cached);
  }

  if (cached.version !== currentVersion || cached.width !== maskW || cached.height !== maskH) {
    gl.bindTexture(gl.TEXTURE_2D, cached.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      layer.maskCanvas
    );

    cached.version = currentVersion;
    cached.width = maskW;
    cached.height = maskH;
  }

  return cached.texture;
}

/**
 * Evict least recently used tile textures when texture pool exceeds threshold.
 */
export function evictStaleTextures(state: CompositorState): void {
  if (!state.gl || state.texturePool.length <= MAX_TEXTURE_POOL_SIZE) return;
  state.texturePool.sort((a, b) => a.lastUsed - b.lastUsed);
  while (state.texturePool.length > MAX_TEXTURE_POOL_SIZE) {
    const slot = state.texturePool.shift();
    if (slot) {
      if (slot.currentKey) state.activePoolByKey.delete(slot.currentKey);
      state.gl.deleteTexture(slot.texture);
    }
  }
}
