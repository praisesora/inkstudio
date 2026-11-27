import React, { useRef, useCallback, useEffect } from 'react';
import {
  ToolType,
  BrushSettings,
  Point,
  CanvasColorMode,
  LayerItem,
} from '../../types/editor';
import { CubicBezierSegment } from '../../engine/SplineGenerator';
import { BrushRenderOptions } from '../../engine/BrushEngine';
import { GpuDab } from '../../engine/WebGlBrushEngine';
import { ConstraintAxis } from '../../types/perspective';
import { useToolStore, toolStoreActions } from '../../stores';
import { recoveryService } from '../../services/recoveryService';
import { isNativeRustAvailable } from '../../utils/nativeBackend';
import {
  startNativeTablet,
  subscribeNativeTablet,
} from '../../utils/nativeTabletInput';
import {
  NativeTabletBridgeState,
  processNativeTabletBatch,
} from './brushStrokeSession/nativeTabletBridge';
import {
  StrokeSessionHelpers,
  StrokeSessionState,
  TouchedTileSpan,
  UseBrushStrokeSessionParams,
  UseBrushStrokeSessionResult,
  createInitialStrokeSessionState,
} from './brushStrokeSession/types';
import {
  abortActiveStrokeSession,
  buildTouchedTileSpansFromSet,
  clearPredictedCanvasSurface,
  computeCanvasPoint,
  createLiveBrushOptions,
  dispatchPointerStatThrottled,
  emitConstraintAxisChangeIfNeeded,
  getPredictedCanvasElement,
  getViewportRectCached,
  markTouchedTilesInRect,
  resolveEffectiveOpacitySensorValue,
  resolveLiveAntiAliasValue,
  resolveStrokeColorValue,
} from './brushStrokeSession/strokeHelpers';
import {
  emitLiveSegmentToDraft,
  renderPredictedStrokeOverlay,
} from './brushStrokeSession/liveSegmentEmitter';
import { runFlushPendingPoints } from './brushStrokeSession/flushPendingPoints';
import { runPointerDown } from './brushStrokeSession/pointerDownHandler';
import {
  runPointerEnter,
  runPointerLeave,
  runPointerMove,
} from './brushStrokeSession/pointerMoveHandler';
import { runPointerUp } from './brushStrokeSession/pointerUpHandler';

export type {
  UseBrushStrokeSessionParams,
  UseBrushStrokeSessionResult,
} from './brushStrokeSession/types';

export function useBrushStrokeSession(
  params: UseBrushStrokeSessionParams
): UseBrushStrokeSessionResult {
  const {
    disabled,
    activeSessionId,
    viewportRef,
    interactionRef,
    isDrawingRef,
    panRef,
    zoomRef,
    rotationRef,
    flipXRef,
    flipYRef,
    toolOverrideRef,
    brushSettingsOverrideRef,
    dimensionsRef,
    isMaskModeRef,
    effectiveDraftCanvasRef,
    predictedCanvasRef,
    activeTileGridRef,
    onActiveConstraintAxisChangeRef,
  } = params;

  const paramsRef = useRef<UseBrushStrokeSessionParams>(params);
  paramsRef.current = params;

  const sessionStateRef = useRef<StrokeSessionState | null>(null);
  if (!sessionStateRef.current) {
    sessionStateRef.current = createInitialStrokeSessionState();
  }

  const getTool = useCallback(
    (): ToolType => toolOverrideRef.current ?? useToolStore.getState().tool,
    [toolOverrideRef]
  );

  const getBrushSettings = useCallback(
    (): BrushSettings =>
      brushSettingsOverrideRef.current ?? useToolStore.getState().brushSettings,
    [brushSettingsOverrideRef]
  );

  const getPredictedCanvas = useCallback(
    (): HTMLCanvasElement | null => getPredictedCanvasElement(predictedCanvasRef),
    [predictedCanvasRef]
  );

  const clearPredictedCanvas = useCallback(() => {
    clearPredictedCanvasSurface(sessionStateRef.current!, getPredictedCanvas);
  }, [getPredictedCanvas]);

  const emitConstraintAxisChange = useCallback(
    (newAxis: ConstraintAxis | null) => {
      emitConstraintAxisChangeIfNeeded(
        sessionStateRef.current!,
        onActiveConstraintAxisChangeRef,
        newAxis
      );
    },
    [onActiveConstraintAxisChangeRef]
  );

  const markTouchedTiles = useCallback(
    (minX: number, minY: number, maxX: number, maxY: number) => {
      markTouchedTilesInRect(
        dimensionsRef.current,
        sessionStateRef.current!.touchedTiles,
        minX,
        minY,
        maxX,
        maxY
      );
    },
    [dimensionsRef]
  );

  const getViewportRect = useCallback(
    (): DOMRect | null => getViewportRectCached(sessionStateRef.current!, viewportRef),
    [viewportRef]
  );

  useEffect(() => {
    const handleResize = () => {
      sessionStateRef.current!.cachedViewportRect = null;
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && viewportRef.current) {
      ro = new ResizeObserver(handleResize);
      ro.observe(viewportRef.current);
    }
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
      ro?.disconnect();
      const state = sessionStateRef.current!;
      if (state.clearDraftRaf !== null) {
        cancelAnimationFrame(state.clearDraftRaf);
      }
      if (state.drawRafId !== null) {
        cancelAnimationFrame(state.drawRafId);
      }
      recoveryService.setDrawingActive(false);
    };
  }, [viewportRef, disabled, activeSessionId]);

  const dispatchPointerStat = useCallback(
    (x: number | null, y: number | null, pressure: number) => {
      dispatchPointerStatThrottled(sessionStateRef.current!, x, y, pressure);
    },
    []
  );

  const nativeBridgeStateRef = useRef<NativeTabletBridgeState>({
    nativeStrokeActive: false,
    prevToolBeforeEraserFlip: null,
  });

  const abortActiveStroke = useCallback(() => {
    abortActiveStrokeSession(
      { isDrawingRef, effectiveDraftCanvasRef, activeTileGridRef, interactionRef },
      sessionStateRef.current!,
      clearPredictedCanvas,
      emitConstraintAxisChange
    );
    const bridge = nativeBridgeStateRef.current;
    bridge.nativeStrokeActive = false;
    if (bridge.prevToolBeforeEraserFlip !== null) {
      const prev = bridge.prevToolBeforeEraserFlip;
      bridge.prevToolBeforeEraserFlip = null;
      toolStoreActions.selectTool(prev);
    }
  }, [
    activeTileGridRef,
    clearPredictedCanvas,
    effectiveDraftCanvasRef,
    emitConstraintAxisChange,
    interactionRef,
    isDrawingRef,
  ]);

  const getCanvasPoint = useCallback(
    (e: React.PointerEvent<HTMLElement> | PointerEvent): Point =>
      computeCanvasPoint(
        e,
        { dimensionsRef, panRef, zoomRef, rotationRef, flipXRef, flipYRef },
        getViewportRect,
        getBrushSettings
      ),
    [dimensionsRef, flipXRef, flipYRef, getBrushSettings, getViewportRect, panRef, rotationRef, zoomRef]
  );

  const resolveEffectiveOpacitySensor = useCallback(
    (bs: BrushSettings, isMonochrome: boolean, isEraser: boolean) =>
      resolveEffectiveOpacitySensorValue(bs, isMonochrome, isEraser),
    []
  );

  const resolveLiveAntiAlias = useCallback(
    (bs: BrushSettings, isMonochrome: boolean, scale: number): number | undefined =>
      resolveLiveAntiAliasValue(bs, isMonochrome, scale),
    []
  );

  const buildTouchedTileSpans = useCallback(
    (sx: number, sy: number, dw: number, dh: number): TouchedTileSpan[] =>
      buildTouchedTileSpansFromSet(sessionStateRef.current!.touchedTiles, sx, sy, dw, dh),
    []
  );

  const buildLiveBrushOptions = useCallback(
    (
      bs: BrushSettings,
      strokeFlow: number,
      strokeSpacing: number,
      strokeHardness: number,
      isMonochrome: boolean,
      canvas: HTMLCanvasElement | null,
      activeLayer: LayerItem | undefined,
      isEraser: boolean,
      isBgEraser: boolean,
      isolatedPass: boolean = false,
      effectiveAntiAlias?: number
    ): BrushRenderOptions =>
      createLiveBrushOptions(
        sessionStateRef.current!,
        bs,
        strokeFlow,
        strokeSpacing,
        strokeHardness,
        isMonochrome,
        canvas,
        activeLayer,
        isEraser,
        isBgEraser,
        isolatedPass,
        effectiveAntiAlias
      ),
    []
  );

  const resolveStrokeColor = useCallback(
    (
      bs: BrushSettings,
      isEraser: boolean,
      isBgEraser: boolean,
      isMonochrome: boolean,
      mode: CanvasColorMode
    ): string =>
      resolveStrokeColorValue(isMaskModeRef.current, bs, isEraser, isBgEraser, isMonochrome, mode),
    [isMaskModeRef]
  );

  const helpersRef = useRef<StrokeSessionHelpers | null>(null);

  const emitLiveSegment = useCallback(
    (
      draftCtx: CanvasRenderingContext2D,
      seg: CubicBezierSegment,
      bs: BrushSettings,
      strokeColor: string,
      strokeHardness: number,
      strokeFlow: number,
      strokeSpacing: number,
      isMonochrome: boolean,
      isEraser: boolean,
      isBgEraser: boolean,
      useWireframeEraser: boolean,
      canvas: HTMLCanvasElement | null,
      activeLayer: LayerItem | undefined,
      gpuBatch: GpuDab[] | undefined,
      precomputedBrushOpts?: BrushRenderOptions
    ) => {
      emitLiveSegmentToDraft(
        sessionStateRef.current!,
        paramsRef.current,
        helpersRef.current!,
        draftCtx,
        seg,
        bs,
        strokeColor,
        strokeHardness,
        strokeFlow,
        strokeSpacing,
        isMonochrome,
        isEraser,
        isBgEraser,
        useWireframeEraser,
        canvas,
        activeLayer,
        gpuBatch,
        precomputedBrushOpts
      );
    },
    []
  );

  const renderPredictedStroke = useCallback((predEvents: PointerEvent[], vRect: DOMRect) => {
    renderPredictedStrokeOverlay(
      sessionStateRef.current!,
      paramsRef.current,
      helpersRef.current!,
      predEvents,
      vRect
    );
  }, []);

  const flushPendingPoints = useCallback((skipDisplayArg?: boolean | number) => {
    runFlushPendingPoints(
      sessionStateRef.current!,
      paramsRef.current,
      helpersRef.current!,
      skipDisplayArg
    );
  }, []);

  helpersRef.current = {
    getTool,
    getBrushSettings,
    getPredictedCanvas,
    clearPredictedCanvas,
    emitConstraintAxisChange,
    markTouchedTiles,
    getViewportRect,
    dispatchPointerStat,
    abortActiveStroke,
    getCanvasPoint,
    resolveEffectiveOpacitySensor,
    resolveLiveAntiAlias,
    buildTouchedTileSpans,
    buildLiveBrushOptions,
    resolveStrokeColor,
    emitLiveSegment,
    renderPredictedStroke,
    flushPendingPoints,
  };

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, coalescedEvents?: PointerEvent[]) => {
      runPointerDown(
        sessionStateRef.current!,
        paramsRef.current,
        helpersRef.current!,
        e,
        coalescedEvents
      );
    },
    []
  );

  const handlePointerMove = useCallback(
    (
      e: React.PointerEvent<HTMLElement>,
      coalescedEvents?: PointerEvent[],
      predictedEvents?: PointerEvent[]
    ) => {
      runPointerMove(
        sessionStateRef.current!,
        paramsRef.current,
        helpersRef.current!,
        e,
        coalescedEvents,
        predictedEvents
      );
    },
    []
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    runPointerUp(sessionStateRef.current!, paramsRef.current, helpersRef.current!, e);
  }, []);

  const handlePointerEnter = useCallback(() => {
    runPointerEnter(sessionStateRef.current!, viewportRef, dispatchPointerStat);
  }, [dispatchPointerStat, viewportRef]);

  const handlePointerLeave = useCallback(() => {
    runPointerLeave(isDrawingRef, dispatchPointerStat);
  }, [dispatchPointerStat, isDrawingRef]);

  // Native low-latency Windows tablet input bridge (WinTab / Windows Ink via Rust Channel).
  // Bypasses browser PointerEvents for brush/eraser pen strokes on Tauri desktop.
  useEffect(() => {
    if (!isNativeRustAvailable()) return;

    const bridgeState = nativeBridgeStateRef.current;
    bridgeState.nativeStrokeActive = false;
    bridgeState.prevToolBeforeEraserFlip = null;
    const modKeys = { shift: false, alt: false };

    const onKeyDown = (ev: KeyboardEvent) => {
      modKeys.shift = ev.shiftKey;
      modKeys.alt = ev.altKey;
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      modKeys.shift = ev.shiftKey;
      modKeys.alt = ev.altKey;
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);

    const isPointOverCanvasViewport = (x: number, y: number): boolean => {
      const vp = viewportRef.current;
      if (!vp) return false;
      const rect = vp.getBoundingClientRect();
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
      const topEl = typeof document !== 'undefined' ? document.elementFromPoint(x, y) : null;
      if (!topEl) return true;
      if (!vp.contains(topEl)) return false;
      // Do not hijack clicks on floating UI pills / buttons inside viewport
      if (topEl.closest('button, input, select, textarea, [data-floating-ui]')) return false;
      return true;
    };

    void startNativeTablet('auto');

    const unsubscribe = subscribeNativeTablet((batch) => {
      const state = sessionStateRef.current;
      const helpers = helpersRef.current;
      if (!state || !helpers) return;

      processNativeTabletBatch(batch, bridgeState, modKeys, {
        getTool: helpers.getTool,
        selectTool: (tool) => toolStoreActions.selectTool(tool),
        isDisabled: () => paramsRef.current.disabled,
        isStrokeActive: () => paramsRef.current.isDrawingRef.current,
        isPointOverCanvasViewport,
        onPointerDown: (evt) => runPointerDown(state, paramsRef.current, helpers, evt),
        onPointerMove: (lastEvt, coalesced) =>
          runPointerMove(state, paramsRef.current, helpers, lastEvt, coalesced),
        onPointerUp: (evt) => runPointerUp(state, paramsRef.current, helpers, evt),
        onHover: (evt) => {
          const pt = helpers.getCanvasPoint(evt);
          helpers.dispatchPointerStat(pt.x, pt.y, pt.pressure);
        },
      });
    });

    return () => {
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [viewportRef]);

  return {
    abortActiveStroke,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerEnter,
    handlePointerLeave,
  };
}
