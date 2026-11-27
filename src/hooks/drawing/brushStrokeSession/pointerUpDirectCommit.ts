import {
  BrushSettings,
  CanvasSelection,
  CspBrushCombineMode,
  DirtyRect,
  LayerItem,
} from '../../../types/editor';
import { SparseTileGrid, TileFormat } from '../../../utils/tileEngine';
import { multiplayerService } from '../../../services/multiplayerService';
import { CubicBezierSegment } from '../../../engine/SplineGenerator';
import { canUseWebGlForBrush, flushGpuDabs } from '../../../engine/BrushEngine';
import { get2DContext } from '../../../utils/canvasUtils';
import { DraftCanvasElement, PushHistoryStepFn } from '../types';
import {
  syncDualBrushRegionToDraft,
  syncStrokePaperTextureRegionToDraft,
} from './strokeHelpers';
import { flushLiveDualSecondaryGpuBatch } from './liveSegmentEmitter';
import { StrokeSessionHelpers, StrokeSessionState } from './types';
import { StrokeHistoryToolType } from './pointerUpSpecialCommit';

export function createRasterPostPresentWork(
  grid: SparseTileGrid,
  beforeSnapshot: Map<string, { format: TileFormat; data: Uint8Array | null }>,
  currentLayerId: string,
  dirtyRect: DirtyRect,
  toolForHistory: StrokeHistoryToolType,
  label: string,
  strokeIdForHistory: string | undefined,
  enqueueHistoryTask: (task: () => void) => void,
  pushHistoryStep: PushHistoryStepFn
): () => void {
  return () => {
    const tileDeltas = grid.computeDeltasFromSnapshot(beforeSnapshot, currentLayerId);
    // Authoritative raster synchronization: emit LZ4 BINARY_TILE immediately before STROKE_FINISH
    if (tileDeltas.length > 0 && multiplayerService.isConnected()) {
      multiplayerService.sendTileDeltas(tileDeltas, grid);
    }
    enqueueHistoryTask(() => {
      pushHistoryStep(
        toolForHistory,
        label,
        null,
        null,
        currentLayerId,
        dirtyRect,
        tileDeltas,
        undefined,
        undefined,
        strokeIdForHistory
      );
    });
  };
}

export interface DirectDraftCommitParams {
  state: StrokeSessionState;
  helpers: Pick<
    StrokeSessionHelpers,
    | 'resolveLiveAntiAlias'
    | 'buildLiveBrushOptions'
    | 'emitLiveSegment'
    | 'buildTouchedTileSpans'
  >;
  grid: SparseTileGrid;
  draftCtx: CanvasRenderingContext2D;
  draftScale: number;
  draftOriginX: number;
  draftOriginY: number;
  dirtyRect: DirtyRect;
  bs: BrushSettings;
  currentLayerId: string;
  activeLayer: LayerItem | undefined;
  targetFormat: TileFormat;
  compositeOp: 'source-over' | 'destination-out' | 'source-atop';
  brushCombineMode?: CspBrushCombineMode;
  pigmentStrength?: number;
  pigmentWhiteGround?: boolean;
  monoOpts?: {
    threshold: number;
    expressBlack: boolean;
    expressWhite: boolean;
  };
  selMaskOpts: {
    mask: NonNullable<CanvasSelection['mask']>;
    bounds: CanvasSelection['bounds'];
  } | null;
  isEraser: boolean;
  isBgEraser: boolean;
  isMonochrome: boolean;
  strokeColor: string;
  tailSegments: CubicBezierSegment[];
  toolForHistory: StrokeHistoryToolType;
  label: string;
  strokeIdForHistory: string | undefined;
  enqueueHistoryTask: (task: () => void) => void;
  pushHistoryStep: PushHistoryStepFn;
}

export function commitDirectDraftToTiles(opts: DirectDraftCommitParams): () => void {
  const {
    state,
    helpers,
    grid,
    draftCtx,
    draftScale,
    draftOriginX,
    draftOriginY,
    dirtyRect,
    bs,
    currentLayerId,
    activeLayer,
    targetFormat,
    compositeOp,
    brushCombineMode,
    pigmentStrength,
    pigmentWhiteGround,
    monoOpts,
    selMaskOpts,
    isEraser,
    isBgEraser,
    isMonochrome,
    strokeColor,
    tailSegments,
    toolForHistory,
    label,
    strokeIdForHistory,
    enqueueHistoryTask,
    pushHistoryStep,
  } = opts;

  const { x: sx, y: sy, width: dw, height: dh } = dirtyRect;

  // Fast path: 1:1 draft canvas already has the rendered stroke; emit only sealed tail segments
  if (tailSegments.length > 0) {
    const strokeHardness = isMonochrome ? 1.0 : bs.hardness ?? 1.0;
    const strokeFlow = isMonochrome ? 1.0 : bs.flow ?? 1.0;
    const strokeSpacing = bs.spacing ?? 0.08;
    const liveAA = helpers.resolveLiveAntiAlias(bs, isMonochrome, draftScale);
    const liveBrushOpts = helpers.buildLiveBrushOptions(
      bs,
      strokeFlow,
      strokeSpacing,
      strokeHardness,
      isMonochrome,
      null,
      activeLayer,
      isEraser,
      isBgEraser,
      true,
      liveAA
    );
    const useGpuTail = canUseWebGlForBrush(liveBrushOpts);
    const gpuBatch = state.frameGpuDabs;
    gpuBatch.length = 0;
    state.dualFrameSecondaryGpuDabs.length = 0;
    const tailDrawCtx =
      state.isDualBrushStroke && state.dualPrimaryCanvas
        ? get2DContext(state.dualPrimaryCanvas) || draftCtx
        : state.isStrokePaperTextureActive && state.rawDraftCanvas
        ? get2DContext(state.rawDraftCanvas) || draftCtx
        : draftCtx;

    for (let i = 0; i < tailSegments.length; i++) {
      helpers.emitLiveSegment(
        tailDrawCtx,
        tailSegments[i],
        bs,
        strokeColor,
        strokeHardness,
        strokeFlow,
        strokeSpacing,
        isMonochrome,
        isEraser,
        isBgEraser,
        false,
        null,
        activeLayer,
        useGpuTail ? gpuBatch : undefined
      );
    }

    if (useGpuTail && gpuBatch.length > 0) {
      const liveColor =
        (isEraser && !isBgEraser) || bs.isTransparentInk ? '#000000' : strokeColor;
      const flushed = flushGpuDabs(tailDrawCtx, gpuBatch, liveColor, liveBrushOpts);
      if (!flushed) {
        for (let i = 0; i < tailSegments.length; i++) {
          helpers.emitLiveSegment(
            tailDrawCtx,
            tailSegments[i],
            bs,
            strokeColor,
            strokeHardness,
            strokeFlow,
            strokeSpacing,
            isMonochrome,
            isEraser,
            isBgEraser,
            false,
            null,
            activeLayer,
            undefined
          );
        }
      }
      gpuBatch.length = 0;
    }

    if (state.isDualBrushStroke && draftCtx.canvas) {
      flushLiveDualSecondaryGpuBatch(state, helpers, bs, isMonochrome, draftScale);
      syncDualBrushRegionToDraft(
        state,
        draftCtx.canvas as DraftCanvasElement,
        draftCtx,
        bs,
        sx,
        sy,
        sx + dw,
        sy + dh
      );
    } else if (state.isStrokePaperTextureActive && draftCtx.canvas) {
      syncStrokePaperTextureRegionToDraft(
        state,
        draftCtx.canvas as DraftCanvasElement,
        draftCtx,
        bs,
        sx,
        sy,
        sx + dw,
        sy + dh
      );
    }
  }

  const beforeSnapshot = new Map<
    string,
    { format: TileFormat; data: Uint8Array | null }
  >();
  const spans = helpers.buildTouchedTileSpans(sx, sy, dw, dh);
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    const spanData = draftCtx.getImageData(
      sp.x - draftOriginX,
      sp.y - draftOriginY,
      sp.width,
      sp.height
    );
    grid.compositeStrokeToTiles({
      layerId: currentLayerId,
      strokeData: spanData,
      destX: sp.x,
      destY: sp.y,
      format: targetFormat,
      compositeOp,
      brushCombineMode,
      opacity: bs.opacity ?? 1.0,
      pigmentStrength,
      pigmentWhiteGround,
      monochrome: monoOpts,
      selectionMask: selMaskOpts,
      snapshotOut: beforeSnapshot,
      suppressNotify: true,
    });
  }

  return createRasterPostPresentWork(
    grid,
    beforeSnapshot,
    currentLayerId,
    dirtyRect,
    toolForHistory,
    label,
    strokeIdForHistory,
    enqueueHistoryTask,
    pushHistoryStep
  );
}
