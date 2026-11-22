/**
 * Unified GPU Viewport Compositor
 *
 * Replaces the multi-canvas DOM stack with a single viewport-sized GPU canvas.
 * Performs frustum culling to only render tiles overlapping the screen frustum,
 * executes all 12 Photoshop/CSP blend modes in fragment shaders, applies document affine
 * transforms (pan, zoom, rotation) directly in vertex shaders, and integrates
 * anti-moiré screentones, vector layers, and comic frame clipping.
 */

import { CanvasDimensions, LayerItem } from '../types/editor';
import { SparseTileGrid, TILE_SIZE, globalTileGrid } from './tileEngine';
import { calculateVisibleDocumentBounds } from './compositor/bounds';
import { disposeFboSurface, disposePingPongTarget } from './compositor/fboManager';
import { initGL, resetGLStateOnContextLost } from './compositor/glInit';
import { renderLowResPreview } from './compositor/previewRenderer';
import { renderFrame } from './compositor/renderFrame';
import { LayerStackCacheTracker } from './compositor/stackCache';
import {
  invalidateMaskTexture,
  invalidateTileTextures,
} from './compositor/tileTexturePool';
import {
  CompositorOptions,
  CompositorState,
  DEFAULT_ARRAY_POOL_LAYERS,
  ViewportTransform,
} from './compositor/types';

export {
  BLEND_MODE_MAP,
  type ViewportTransform,
  type OnionSkinCompositorFrame,
  type CompositorOptions,
} from './compositor/types';

export {
  type LayerTreeNode,
  buildLayerTree,
  type TreeNodeRenderGroup,
  groupTreeNodesForCompositing,
  type LayerRenderGroup,
  groupLayersForCompositing,
  type CompositingUnit,
  type AboveSliceStrategy,
  type LayerStackPartition,
  flattenLayerTreeToUnits,
  isUnitNormalAssociative,
  canSingleUnitBakeWithBlendMode,
  partitionLayerStack,
} from './compositor/layerTree';

export {
  FRAME_POLY_VERTEX_SHADER,
  FRAME_POLY_FRAGMENT_SHADER,
  FOLDER_BLIT_VERTEX_SHADER,
  FOLDER_BLIT_FRAGMENT_SHADER,
  COMPOSITOR_VERTEX_SHADER,
  COMPOSITOR_FRAGMENT_SHADER,
  VIEWPORT_DRAFT_VERTEX_SHADER,
} from './compositor/shaders/coreShaders';

export {
  COMPOSITOR_INSTANCED_VERTEX_SHADER,
  COMPOSITOR_INSTANCED_FRAGMENT_SHADER,
} from './compositor/shaders/instancedShaders';

export {
  ADJUSTMENT_FRAGMENT_SHADER,
  hasActiveLayerStyles,
  LAYER_STYLES_VERTEX_SHADER,
  LAYER_STYLES_FRAGMENT_SHADER,
} from './compositor/shaders/effectShaders';

export {
  SOFT_PROOF_VERTEX_SHADER,
  SOFT_PROOF_FRAGMENT_SHADER,
} from './compositor/shaders/softProofShaders';

export {
  type LayerStackCacheInput,
  type LayerStackCacheEvaluation,
  LayerStackCacheTracker,
} from './compositor/stackCache';

export { calculateVisibleDocumentBounds } from './compositor/bounds';

function createInitialCompositorState(
  canvas: HTMLCanvasElement,
  preserveDrawingBuffer: boolean
): CompositorState {
  return {
    canvas,
    gl: null,
    program: null,
    quadBuffer: null,
    uTileOriginLoc: null,
    uTileSizeLoc: null,
    uIsBackgroundLoc: null,
    uShowCheckerboardLoc: null,
    uTileTextureLoc: null,
    stdLocs: null,
    instancedProgram: null,
    instancedLocs: null,
    uInstTileSizeLoc: null,
    uInstTileArrayLoc: null,
    aInstQuadPosLoc: -1,
    aInstDataLoc: -1,
    instancedVao: null,
    instanceBuffer: null,
    instanceFloatScratch: new Float32Array(DEFAULT_ARRAY_POOL_LAYERS * 3),
    tileArrayTexture: null,
    arrayPoolCapacity: 0,
    arrayPoolFilterTier: -1,
    arrayPoolSlots: [],
    freeArraySlots: [],
    arrayPoolByKey: new Map(),
    arrayAccessCounter: 0,
    arrayBatchCounter: 0,
    uploadPremulScratch: new Uint8Array(TILE_SIZE * TILE_SIZE * 4),
    preserveDrawingBuffer,
    viewportDraftProgram: null,
    viewportDraftLocs: null,
    uViewportDraftTileTexLoc: null,
    uViewportDraftIsBgLoc: null,
    aViewportDraftQuadPosLoc: -1,
    aQuadPosLoc: -1,
    aStylesQuadPosLoc: -1,
    aBlitQuadPosLoc: -1,
    aProofQuadPosLoc: -1,
    contextLost: false,
    onContextLostHandler: null,
    onContextRestoredHandler: null,
    maskTextureCache: new Map(),
    maskInvalidationEpochs: new Map(),
    globalMaskEpochCounter: 0,
    draftTexture: null,
    draftTexWidth: 0,
    draftTexHeight: 0,
    draftHasMipmap: false,
    lastDraftVersion: -1,
    currentOptions: null,
    currentZoom: 1.0,
    currentFrameState: null,
    adjProgram: null,
    uAdjTileOriginLoc: null,
    uAdjTileSizeLoc: null,
    uAdjDocDimensionsLoc: null,
    uAdjViewportSizeLoc: null,
    uAdjPanLoc: null,
    uAdjZoomLoc: null,
    uAdjRotationRadLoc: null,
    uAdjFlipLoc: null,
    uAdjDprLoc: null,
    uAdjSnapshotLoc: null,
    uAdjLutLoc: null,
    uAdjModeLoc: null,
    uAdjOpacityLoc: null,
    uAdjMaskEnabledLoc: null,
    uAdjMaskTextureLoc: null,
    lutTexture: null,
    lastLutKey: '',
    lastLutAdjMode: 0,
    stylesProgram: null,
    stylesQuadBuffer: null,
    layerFbo: null,
    layerTexture: null,
    layerFboWidth: 0,
    layerFboHeight: 0,
    layerStylesOutFbo: null,
    uStylesLayerTextureLoc: null,
    uStylesViewportSizeLoc: null,
    uStylesLayerOpacityLoc: null,
    uStylesStrokeEnabledLoc: null,
    uStylesStrokeSizeLoc: null,
    uStylesStrokeColorLoc: null,
    uStylesStrokePositionLoc: null,
    uStylesGlowEnabledLoc: null,
    uStylesGlowColorLoc: null,
    uStylesGlowBlurLoc: null,
    uStylesGlowSpreadLoc: null,
    uStylesShadowEnabledLoc: null,
    uStylesShadowColorLoc: null,
    uStylesShadowOffsetLoc: null,
    uStylesShadowBlurLoc: null,
    uStylesShadowSpreadLoc: null,
    blitProgram: null,
    uBlitTextureLoc: null,
    uBlitBackdropTextureLoc: null,
    uBlitHasBackdropLoc: null,
    uBlitBlendModeLoc: null,
    uBlitOpacityLoc: null,
    framePolyProgram: null,
    framePolyBuffer: null,
    aFramePolyDocPosLoc: -1,
    uFramePolyDocDimensionsLoc: null,
    uFramePolyViewportSizeLoc: null,
    uFramePolyPanLoc: null,
    uFramePolyZoomLoc: null,
    uFramePolyRotationRadLoc: null,
    uFramePolyFlipLoc: null,
    uFramePolyDprLoc: null,
    uFramePolyColorLoc: null,
    scenePingPong: null,
    folderPingPongs: [],
    belowActiveCacheFbo: null,
    aboveActiveCacheFbo: null,
    stackCache: new LayerStackCacheTracker(),
    stackCacheStats: { belowRebuilds: 0, aboveRebuilds: 0, cacheHits: 0 },
    softProofProgram: null,
    uProofSceneTextureLoc: null,
    uProofStandardLoc: null,
    uProofEnabledLoc: null,
    uProofGamutWarningLoc: null,
    uProofGamutWarningColorLoc: null,
    textureAccessCounter: 0,
    texturePool: [],
    activePoolByKey: new Map(),
    fallbackTileCanvas: null,
    lastRenderedGrid: null,
  };
}

/**
 * High-performance WebGL2 Viewport Compositor
 */
export class ViewportCompositor {
  private state: CompositorState;

  constructor(canvas: HTMLCanvasElement, options?: { preserveDrawingBuffer?: boolean }) {
    this.state = createInitialCompositorState(canvas, Boolean(options?.preserveDrawingBuffer));
    if (typeof canvas.addEventListener === 'function') {
      this.state.onContextLostHandler = (e: Event) => {
        e.preventDefault();
        resetGLStateOnContextLost(this.state);
      };
      this.state.onContextRestoredHandler = () => {
        this.state.contextLost = false;
        initGL(this.state);
        (this.state.lastRenderedGrid || globalTileGrid).notifyChange(true);
      };
      canvas.addEventListener('webglcontextlost', this.state.onContextLostHandler, false);
      canvas.addEventListener('webglcontextrestored', this.state.onContextRestoredHandler, false);
    }
    initGL(this.state);
  }

  public isReady(): boolean {
    return !this.state.contextLost && this.state.gl !== null && this.state.program !== null;
  }

  public getCanvas(): HTMLCanvasElement {
    return this.state.canvas;
  }

  public getMaxTextureSize(): number {
    if (!this.state.gl) return 2048;
    const maxTex = Number(this.state.gl.getParameter(this.state.gl.MAX_TEXTURE_SIZE)) || 2048;
    const maxRb = Number(this.state.gl.getParameter(this.state.gl.MAX_RENDERBUFFER_SIZE)) || maxTex;
    return Math.max(256, Math.min(maxTex, maxRb));
  }

  public getStackCacheStats(): { belowRebuilds: number; aboveRebuilds: number; cacheHits: number } {
    return { ...this.state.stackCacheStats };
  }

  /**
   * Explicitly invalidate baked layer stack caches.
   */
  public invalidateStackCache(): void {
    this.state.stackCache.invalidateAll();
  }

  /**
   * Explicitly invalidate a cached layer mask texture (or all masks if layerId omitted).
   */
  public invalidateMaskTexture(layerId?: string): void {
    invalidateMaskTexture(this.state, layerId);
  }

  /**
   * Explicitly invalidate and clear all cached tile textures in both TEXTURE_2D and TEXTURE_2D_ARRAY pools.
   */
  public invalidateTileTextures(): void {
    invalidateTileTextures(this.state);
  }

  /**
   * Resize viewport canvas to physical screen pixels.
   */
  public resize(width: number, height: number): void {
    const nextW = Math.max(1, width);
    const nextH = Math.max(1, height);
    if (this.state.canvas.width !== nextW || this.state.canvas.height !== nextH) {
      this.state.canvas.width = nextW;
      this.state.canvas.height = nextH;
      this.state.stackCache.invalidateAll();
      if (this.state.gl) {
        this.state.gl.viewport(0, 0, this.state.canvas.width, this.state.canvas.height);
      }
    }
  }

  /**
   * Calculates the document-space bounding box visible in the current camera viewport.
   * Performs frustum culling.
   */
  public calculateVisibleDocumentBounds(
    viewportW: number,
    viewportH: number,
    transform: ViewportTransform,
    docW: number,
    docH: number
  ): { minX: number; minY: number; maxX: number; maxY: number } {
    return calculateVisibleDocumentBounds(viewportW, viewportH, transform, docW, docH);
  }

  /**
   * Main Render Pass: Composite all visible layers onto the viewport canvas using:
   * 1. Ping-Pong FBOs (zero gl.copyTexSubImage2D calls for all 16 blend modes, adjustments, & soft proof)
   * 2. Baked Layer Stack Cache (`belowActiveCacheFbo` + `activeUnit` + `aboveActiveCacheFbo`)
   * 3. TEXTURE_2D_ARRAY + gl.drawArraysInstanced tile batching
   */
  public render(
    layers: LayerItem[],
    transform: ViewportTransform,
    dimensions: CanvasDimensions,
    grid: SparseTileGrid = globalTileGrid,
    _options: CompositorOptions = { dimensions }
  ): void {
    renderFrame(this.state, layers, transform, dimensions, grid, _options);
  }

  /**
   * Lightweight low-LOD composite preview renderer for Navigator & thumbnails.
   * Reads directly from SparseTileGrid mipmap LOD tiles (no WebGL context creation, no GPU readPixels stall).
   */
  public static renderLowResPreview(
    targetCanvas: HTMLCanvasElement,
    layers: LayerItem[],
    dimensions: CanvasDimensions,
    grid: SparseTileGrid = globalTileGrid,
    options: { showCheckerboard?: boolean } = {}
  ): void {
    renderLowResPreview(targetCanvas, layers, dimensions, grid, options);
  }

  /**
   * Clear all allocated WebGL textures, FBOs, buffers, and programs.
   */
  public dispose(): void {
    const s = this.state;
    if (s.gl) {
      const gl = s.gl;
      invalidateTileTextures(s);
      for (const item of s.maskTextureCache.values()) {
        gl.deleteTexture(item.texture);
      }
      s.maskTextureCache.clear();
      s.maskInvalidationEpochs.clear();
      if (s.draftTexture) {
        gl.deleteTexture(s.draftTexture);
        s.draftTexture = null;
      }
      if (s.lutTexture) {
        gl.deleteTexture(s.lutTexture);
        s.lutTexture = null;
      }
      if (s.tileArrayTexture) {
        gl.deleteTexture(s.tileArrayTexture);
        s.tileArrayTexture = null;
      }
      if (s.instanceBuffer) {
        gl.deleteBuffer(s.instanceBuffer);
        s.instanceBuffer = null;
      }
      if (s.instancedVao && typeof gl.deleteVertexArray === 'function') {
        gl.deleteVertexArray(s.instancedVao);
        s.instancedVao = null;
      }
      if (s.quadBuffer) {
        gl.deleteBuffer(s.quadBuffer);
        s.quadBuffer = null;
      }
      if (s.program) {
        gl.deleteProgram(s.program);
        s.program = null;
      }
      if (s.instancedProgram) {
        gl.deleteProgram(s.instancedProgram);
        s.instancedProgram = null;
      }
      if (s.viewportDraftProgram) {
        gl.deleteProgram(s.viewportDraftProgram);
        s.viewportDraftProgram = null;
      }
      if (s.adjProgram) {
        gl.deleteProgram(s.adjProgram);
        s.adjProgram = null;
      }
      if (s.stylesProgram) {
        gl.deleteProgram(s.stylesProgram);
        s.stylesProgram = null;
      }
      if (s.blitProgram) {
        gl.deleteProgram(s.blitProgram);
        s.blitProgram = null;
      }
      if (s.framePolyProgram) {
        gl.deleteProgram(s.framePolyProgram);
        s.framePolyProgram = null;
      }
      if (s.framePolyBuffer) {
        gl.deleteBuffer(s.framePolyBuffer);
        s.framePolyBuffer = null;
      }
      if (s.softProofProgram) {
        gl.deleteProgram(s.softProofProgram);
        s.softProofProgram = null;
      }
      disposePingPongTarget(gl, s.scenePingPong);
      s.scenePingPong = null;
      for (const fpp of s.folderPingPongs) {
        disposePingPongTarget(gl, fpp);
      }
      s.folderPingPongs = [];
      disposeFboSurface(gl, s.belowActiveCacheFbo);
      s.belowActiveCacheFbo = null;
      disposeFboSurface(gl, s.aboveActiveCacheFbo);
      s.aboveActiveCacheFbo = null;
      disposeFboSurface(gl, s.layerStylesOutFbo);
      s.layerStylesOutFbo = null;
      if (s.layerFbo) {
        gl.deleteFramebuffer(s.layerFbo);
        s.layerFbo = null;
      }
      if (s.layerTexture) {
        gl.deleteTexture(s.layerTexture);
        s.layerTexture = null;
      }
      if (s.stylesQuadBuffer) {
        gl.deleteBuffer(s.stylesQuadBuffer);
        s.stylesQuadBuffer = null;
      }
    }
    s.stackCache.invalidateAll();
    if (s.fallbackTileCanvas) {
      s.fallbackTileCanvas = null;
    }
    if (typeof s.canvas.removeEventListener === 'function') {
      if (s.onContextLostHandler) {
        s.canvas.removeEventListener('webglcontextlost', s.onContextLostHandler);
      }
      if (s.onContextRestoredHandler) {
        s.canvas.removeEventListener('webglcontextrestored', s.onContextRestoredHandler);
      }
    }
  }
}
