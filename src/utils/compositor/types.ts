import {
  LayerItem,
  CanvasDimensions,
  BlendMode,
  CanvasColorMode,
  SoftProofSettings,
} from '../../types/editor';
import { SparseTileGrid } from '../tileEngine';

export const DEFAULT_ARRAY_POOL_LAYERS = 512;
export const MAX_TEXTURE_POOL_SIZE = 2048;

export interface ViewportTransform {
  pan: { x: number; y: number };
  zoom: number;
  rotation: number; // in degrees
  flipX?: boolean;
  flipY?: boolean;
}

export const BLEND_MODE_MAP: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  'color-dodge': 6,
  'color-burn': 7,
  'hard-light': 8,
  'soft-light': 9,
  difference: 10,
  exclusion: 11,
  'pass-through': 12,
  'linear-burn': 13,
  'add-glow': 14,
  'color-dodge-glow': 15,
  divide: 16,
  'vivid-light': 17,
  'linear-light': 18,
  'pin-light': 19,
  'hard-mix': 20,
  subtract: 21,
  'darker-color': 22,
  'lighter-color': 23,
  hue: 24,
  saturation: 25,
  color: 26,
  luminosity: 27,
};

export interface LayerTreeNode {
  layer: LayerItem;
  children: LayerTreeNode[];
}

export interface TreeNodeRenderGroup {
  baseNode: LayerTreeNode;
  clippedNodes: LayerTreeNode[];
}

export interface LayerRenderGroup {
  baseLayer: LayerItem;
  clippedLayers: LayerItem[];
}

export interface OnionSkinCompositorFrame {
  layerId: string;
  tint: string;
  opacity: number;
}

export interface CompositorOptions {
  dimensions: CanvasDimensions;
  colorMode?: CanvasColorMode;
  showCheckerboard?: boolean;
  transparentBackground?: boolean;
  bypassStackCache?: boolean;
  devicePixelRatio?: number;
  onionSkinFrames?: OnionSkinCompositorFrame[];
  softProof?: SoftProofSettings;
  // Active layer identifier for Baked Layer Stack Cache partitioning (below / active / above)
  activeLayerId?: string | null;
  // WYSIWYG In-Stack Live Stroke Compositing
  activeDraftCanvas?: HTMLCanvasElement | null;
  activeDraftLayerId?: string | null;
  activeDraftDirtyRect?: { x: number; y: number; width: number; height: number } | null;
  activeDraftVersion?: number;
  activeDraftSpace?: 'document' | 'viewport';
  activeDraftOpacity?: number;
  activeDraftMonochrome?: boolean;
}

export interface CompositingUnit {
  /** Base node and its clipped siblings at this compositing level */
  group: TreeNodeRenderGroup;
  /** Accumulated opacity from enclosing pass-through folders */
  inheritedOpacity: number;
  /** All layer IDs contained in this unit (base, clipped siblings, and folder descendants) */
  containedLayerIds: Set<string>;
}

export type AboveSliceStrategy = 'empty' | 'baked-normal' | 'baked-single-blend' | 'mixed';

export interface LayerStackPartition {
  /** Units strictly below the active unit (always safe to bake into belowActiveCacheFbo) */
  belowUnits: CompositingUnit[];
  /** The active unit containing activeLayerId, or null if none/hidden */
  activeUnit: CompositingUnit | null;
  /** Units above active that must render dynamically (non-associative blend modes / adjustments) */
  aboveDynamicUnits: CompositingUnit[];
  /** Units above activeDynamicUnits that can be baked into aboveActiveCacheFbo */
  aboveCachedUnits: CompositingUnit[];
  /** How aboveActiveCacheFbo should be composited over (below + active + aboveDynamic) */
  aboveStrategy: AboveSliceStrategy;
  /** Blend mode for aboveActiveCacheFbo when aboveStrategy === 'baked-single-blend' */
  aboveCacheBlendMode: BlendMode;
}

export interface LayerStackCacheInput {
  layers: LayerItem[];
  activeLayerId?: string | null;
  viewportW: number;
  viewportH: number;
  dpr: number;
  dimensions: CanvasDimensions;
  transform: ViewportTransform;
  showCheckerboard?: boolean;
  transparentBackground?: boolean;
  colorMode?: CanvasColorMode;
  onionSkinFrames?: OnionSkinCompositorFrame[];
  getLayerContentVersion: (layerId: string) => number;
  getMaskInvalidationEpoch?: (layerId: string) => number;
  gridEpoch?: number;
  gridId?: number;
}

export interface LayerStackCacheEvaluation {
  partition: LayerStackPartition;
  belowSignature: string;
  aboveSignature: string;
  belowDirty: boolean;
  aboveDirty: boolean;
}

export interface LayerStackCacheTrackerLike {
  evaluate(input: LayerStackCacheInput): LayerStackCacheEvaluation;
  commit(belowSignature: string, aboveSignature: string): void;
  invalidateAll(): void;
  invalidateBelow(): void;
  invalidateAbove(): void;
  getLastSignatures(): { below: string | null; above: string | null };
}

export interface FboSurface {
  fbo: WebGLFramebuffer;
  texture: WebGLTexture;
  stencilRb: WebGLRenderbuffer | null;
  width: number;
  height: number;
}

export interface PingPongTarget {
  surfaces: [FboSurface, FboSurface];
  activeIndex: 0 | 1;
}

export interface LayerUniformLocs {
  uDocDimensions: WebGLUniformLocation | null;
  uViewportSize: WebGLUniformLocation | null;
  uPan: WebGLUniformLocation | null;
  uZoom: WebGLUniformLocation | null;
  uRotationRad: WebGLUniformLocation | null;
  uFlip: WebGLUniformLocation | null;
  uDpr: WebGLUniformLocation | null;
  uBackdropTexture: WebGLUniformLocation | null;
  uHasBackdrop: WebGLUniformLocation | null;
  uLayerOpacity: WebGLUniformLocation | null;
  uBlendMode: WebGLUniformLocation | null;
  uToneEnabled: WebGLUniformLocation | null;
  uToneFrequency: WebGLUniformLocation | null;
  uToneAngleRad: WebGLUniformLocation | null;
  uToneDpi: WebGLUniformLocation | null;
  uToneDotShape: WebGLUniformLocation | null;
  uToneDensity: WebGLUniformLocation | null;
  uToneDensityType: WebGLUniformLocation | null;
  uLayerColorEnabled: WebGLUniformLocation | null;
  uLayerColor: WebGLUniformLocation | null;
  uLayerSubColor: WebGLUniformLocation | null;
  uMaskTexture: WebGLUniformLocation | null;
  uMaskEnabled: WebGLUniformLocation | null;
  uExpressionMode: WebGLUniformLocation | null;
  uMonoThreshold: WebGLUniformLocation | null;
  uMonoExpressBlack: WebGLUniformLocation | null;
  uMonoExpressWhite: WebGLUniformLocation | null;
}

export interface ArrayPoolSlot {
  sliceIndex: number;
  currentKey: string | null;
  version: number;
  lastUsed: number;
  lastBatchTick: number;
}

export interface Texture2DPoolSlot {
  texture: WebGLTexture;
  currentKey: string | null;
  version: number;
  lastUsed: number;
  filterTier?: number;
  hasStorage?: boolean;
  hasMipmap?: boolean;
}

export interface MaskTextureCacheEntry {
  texture: WebGLTexture;
  version: number;
  width: number;
  height: number;
}

export interface FrameState {
  viewportW: number;
  viewportH: number;
  dpr: number;
  dimensions: CanvasDimensions;
  transform: ViewportTransform;
  rotRad: number;
}

export interface DocumentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CompositorState {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext | null;
  program: WebGLProgram | null;
  quadBuffer: WebGLBuffer | null;

  // Standard compositor uniform locations
  uTileOriginLoc: WebGLUniformLocation | null;
  uTileSizeLoc: WebGLUniformLocation | null;
  uIsBackgroundLoc: WebGLUniformLocation | null;
  uShowCheckerboardLoc: WebGLUniformLocation | null;
  uTileTextureLoc: WebGLUniformLocation | null;
  stdLocs: LayerUniformLocs | null;

  // Instanced TEXTURE_2D_ARRAY batching program, VAO, buffer, & pool
  instancedProgram: WebGLProgram | null;
  instancedLocs: LayerUniformLocs | null;
  uInstTileSizeLoc: WebGLUniformLocation | null;
  uInstTileArrayLoc: WebGLUniformLocation | null;
  aInstQuadPosLoc: number;
  aInstDataLoc: number;
  instancedVao: WebGLVertexArrayObject | null;
  instanceBuffer: WebGLBuffer | null;
  instanceFloatScratch: Float32Array;
  tileArrayTexture: WebGLTexture | null;
  arrayPoolCapacity: number;
  arrayPoolFilterTier: number;
  arrayPoolSlots: ArrayPoolSlot[];
  freeArraySlots: ArrayPoolSlot[];
  arrayPoolByKey: Map<string, ArrayPoolSlot>;
  arrayAccessCounter: number;
  arrayBatchCounter: number;
  uploadPremulScratch: Uint8Array;
  readonly preserveDrawingBuffer: boolean;

  // Viewport-space draft stroke program (reuses COMPOSITOR_FRAGMENT_SHADER)
  viewportDraftProgram: WebGLProgram | null;
  viewportDraftLocs: LayerUniformLocs | null;
  uViewportDraftTileTexLoc: WebGLUniformLocation | null;
  uViewportDraftIsBgLoc: WebGLUniformLocation | null;
  aViewportDraftQuadPosLoc: number;

  // Cached attribute locations
  aQuadPosLoc: number;
  aStylesQuadPosLoc: number;
  aBlitQuadPosLoc: number;
  aProofQuadPosLoc: number;
  contextLost: boolean;
  onContextLostHandler: ((e: Event) => void) | null;
  onContextRestoredHandler: (() => void) | null;

  // Mask version-tracked cache & invalidation epochs
  maskTextureCache: Map<string, MaskTextureCacheEntry>;
  maskInvalidationEpochs: Map<string, number>;
  globalMaskEpochCounter: number;

  // Live in-stack draft stroke texture cache
  draftTexture: WebGLTexture | null;
  draftTexWidth: number;
  draftTexHeight: number;
  draftHasMipmap: boolean;
  lastDraftVersion: number;
  currentOptions: CompositorOptions | null;
  currentZoom: number;
  currentFrameState: FrameState | null;

  // Adjustment program & uniforms
  adjProgram: WebGLProgram | null;
  uAdjTileOriginLoc: WebGLUniformLocation | null;
  uAdjTileSizeLoc: WebGLUniformLocation | null;
  uAdjDocDimensionsLoc: WebGLUniformLocation | null;
  uAdjViewportSizeLoc: WebGLUniformLocation | null;
  uAdjPanLoc: WebGLUniformLocation | null;
  uAdjZoomLoc: WebGLUniformLocation | null;
  uAdjRotationRadLoc: WebGLUniformLocation | null;
  uAdjFlipLoc: WebGLUniformLocation | null;
  uAdjDprLoc: WebGLUniformLocation | null;
  uAdjSnapshotLoc: WebGLUniformLocation | null;
  uAdjLutLoc: WebGLUniformLocation | null;
  uAdjModeLoc: WebGLUniformLocation | null;
  uAdjOpacityLoc: WebGLUniformLocation | null;
  uAdjMaskEnabledLoc: WebGLUniformLocation | null;
  uAdjMaskTextureLoc: WebGLUniformLocation | null;

  lutTexture: WebGLTexture | null;
  lastLutKey: string;
  lastLutAdjMode: number;

  // Layer Styles program, FBO & uniforms
  stylesProgram: WebGLProgram | null;
  stylesQuadBuffer: WebGLBuffer | null;
  layerFbo: WebGLFramebuffer | null;
  layerTexture: WebGLTexture | null;
  layerFboWidth: number;
  layerFboHeight: number;
  layerStylesOutFbo: FboSurface | null;

  uStylesLayerTextureLoc: WebGLUniformLocation | null;
  uStylesViewportSizeLoc: WebGLUniformLocation | null;
  uStylesLayerOpacityLoc: WebGLUniformLocation | null;
  uStylesStrokeEnabledLoc: WebGLUniformLocation | null;
  uStylesStrokeSizeLoc: WebGLUniformLocation | null;
  uStylesStrokeColorLoc: WebGLUniformLocation | null;
  uStylesStrokePositionLoc: WebGLUniformLocation | null;
  uStylesGlowEnabledLoc: WebGLUniformLocation | null;
  uStylesGlowColorLoc: WebGLUniformLocation | null;
  uStylesGlowBlurLoc: WebGLUniformLocation | null;
  uStylesGlowSpreadLoc: WebGLUniformLocation | null;
  uStylesShadowEnabledLoc: WebGLUniformLocation | null;
  uStylesShadowColorLoc: WebGLUniformLocation | null;
  uStylesShadowOffsetLoc: WebGLUniformLocation | null;
  uStylesShadowBlurLoc: WebGLUniformLocation | null;
  uStylesShadowSpreadLoc: WebGLUniformLocation | null;

  // Folder / Cache blit program & uniforms
  blitProgram: WebGLProgram | null;
  uBlitTextureLoc: WebGLUniformLocation | null;
  uBlitBackdropTextureLoc: WebGLUniformLocation | null;
  uBlitHasBackdropLoc: WebGLUniformLocation | null;
  uBlitBlendModeLoc: WebGLUniformLocation | null;
  uBlitOpacityLoc: WebGLUniformLocation | null;

  // Frame Border Folder polygon program & dynamic vertex buffer
  framePolyProgram: WebGLProgram | null;
  framePolyBuffer: WebGLBuffer | null;
  aFramePolyDocPosLoc: number;
  uFramePolyDocDimensionsLoc: WebGLUniformLocation | null;
  uFramePolyViewportSizeLoc: WebGLUniformLocation | null;
  uFramePolyPanLoc: WebGLUniformLocation | null;
  uFramePolyZoomLoc: WebGLUniformLocation | null;
  uFramePolyRotationRadLoc: WebGLUniformLocation | null;
  uFramePolyFlipLoc: WebGLUniformLocation | null;
  uFramePolyDprLoc: WebGLUniformLocation | null;
  uFramePolyColorLoc: WebGLUniformLocation | null;

  // Ping-Pong FBOs
  scenePingPong: PingPongTarget | null;
  folderPingPongs: PingPongTarget[];

  // Baked Layer Stack Cache FBOs
  belowActiveCacheFbo: FboSurface | null;
  aboveActiveCacheFbo: FboSurface | null;
  stackCache: LayerStackCacheTrackerLike;
  stackCacheStats: { belowRebuilds: number; aboveRebuilds: number; cacheHits: number };

  // Soft proofing program & uniforms
  softProofProgram: WebGLProgram | null;
  uProofSceneTextureLoc: WebGLUniformLocation | null;
  uProofStandardLoc: WebGLUniformLocation | null;
  uProofEnabledLoc: WebGLUniformLocation | null;
  uProofGamutWarningLoc: WebGLUniformLocation | null;
  uProofGamutWarningColorLoc: WebGLUniformLocation | null;

  // Pre-allocated WebGL2 Texture2D Pool (overflow fallback for TEXTURE_2D_ARRAY)
  textureAccessCounter: number;
  texturePool: Texture2DPoolSlot[];
  activePoolByKey: Map<string, Texture2DPoolSlot>;
  fallbackTileCanvas: HTMLCanvasElement | null;
  lastRenderedGrid: SparseTileGrid | null;
}
