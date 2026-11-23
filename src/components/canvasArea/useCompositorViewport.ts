import React, { useEffect, useMemo, useRef } from 'react';
import {
  AnimationTimeline as AnimationTimelineType,
  CanvasColorMode,
  CanvasDimensions,
  LayerItem,
  SoftProofSettings,
} from '../../types/editor';
import { CanvasNavigationHandle } from '../../hooks/useCanvasNavigation';
import { ViewportCompositor } from '../../utils/compositor';
import { SparseTileGrid } from '../../utils/tileEngine';
import { getOnionSkinFrames } from '../../utils/animationEngine';
import {
  CursorConfig,
  formatArtboardTransform,
  formatCursorRingTransform,
} from './types';

export interface UseCompositorViewportParams {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  onViewportReady?: (viewport: HTMLDivElement) => void;
  artboardRef: React.RefObject<HTMLDivElement | null>;
  cursorRingRef: React.RefObject<HTMLDivElement | null>;
  cursorConfigRef: React.MutableRefObject<CursorConfig>;
  lastPointerPosRef: React.MutableRefObject<{ x: number; y: number } | null>;
  effectiveDraftCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  effectivePredictedCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  navigation?: CanvasNavigationHandle;
  layers: LayerItem[];
  animationTimeline: AnimationTimelineType | null;
  pan: { x: number; y: number };
  zoom: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  livePan: { x: number; y: number };
  liveZoom: number;
  liveRotation: number;
  liveFlipX: boolean;
  liveFlipY: boolean;
  dimensions: CanvasDimensions;
  showCheckerboard: boolean;
  hasOpenDocument: boolean;
  softProofSettings?: SoftProofSettings;
  activeLayerId?: string;
  brushOpacity?: number;
  colorMode: CanvasColorMode;
  tileGrid: SparseTileGrid;
}

export function useCompositorViewport({
  viewportRef,
  onViewportReady,
  artboardRef,
  cursorRingRef,
  cursorConfigRef,
  lastPointerPosRef,
  effectiveDraftCanvasRef,
  effectivePredictedCanvasRef,
  navigation,
  layers,
  animationTimeline,
  pan,
  zoom,
  rotation,
  flipX,
  flipY,
  livePan,
  liveZoom,
  liveRotation,
  liveFlipX,
  liveFlipY,
  dimensions,
  showCheckerboard,
  hasOpenDocument,
  softProofSettings,
  activeLayerId,
  brushOpacity,
  colorMode,
  tileGrid,
}: UseCompositorViewportParams) {
  const tileGridRef = useRef<SparseTileGrid>(tileGrid);
  tileGridRef.current = tileGrid;

  // Compute colored onion skin frames and active cel isolation for animation
  const onionSkinFrames = useMemo(() => {
    if (!animationTimeline || !animationTimeline.onionSkin?.enabled) return [];
    return getOnionSkinFrames(animationTimeline);
  }, [animationTimeline]);

  const effectiveLayers = useMemo(() => {
    if (!animationTimeline) return layers;
    const currentCelId = animationTimeline.cels[animationTimeline.currentFrame];
    const allCelIds = new Set(Object.values(animationTimeline.cels));
    return layers.map((layer) => {
      if (allCelIds.has(layer.id)) {
        return {
          ...layer,
          visible: layer.id === currentCelId && layer.visible,
        };
      }
      return layer;
    });
  }, [layers, animationTimeline]);

  // Unified GPU Viewport Compositor
  const viewportCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<ViewportCompositor | null>(null);
  const viewportCssSizeRef = useRef<{ width: number; height: number } | null>(null);
  const renderParamsRef = useRef({
    effectiveLayers,
    pan: livePan,
    zoom: liveZoom,
    rotation: liveRotation,
    flipX: liveFlipX,
    flipY: liveFlipY,
    dimensions,
    showCheckerboard,
    onionSkinFrames,
    softProofSettings,
    activeLayerId,
    brushOpacity: brushOpacity ?? 1.0,
    effectiveDraftCanvasRef,
  });
  renderParamsRef.current = {
    effectiveLayers,
    pan: livePan,
    zoom: liveZoom,
    rotation: liveRotation,
    flipX: liveFlipX,
    flipY: liveFlipY,
    dimensions,
    showCheckerboard,
    onionSkinFrames,
    softProofSettings,
    activeLayerId,
    brushOpacity: brushOpacity ?? 1.0,
    effectiveDraftCanvasRef,
  };

  const buildCompositorOptions = (rp: typeof renderParamsRef.current, dpr: number) => {
    const vCanvas = viewportCanvasRef.current;
    const cssSize = viewportCssSizeRef.current;
    if (vCanvas && compositorRef.current && cssSize && cssSize.width > 0 && cssSize.height > 0) {
      const expectedW = Math.max(1, Math.round(cssSize.width * dpr));
      const expectedH = Math.max(1, Math.round(cssSize.height * dpr));
      if (vCanvas.width !== expectedW || vCanvas.height !== expectedH) {
        compositorRef.current.resize(expectedW, expectedH);
        const predCanvas = rp.effectiveDraftCanvasRef ? effectivePredictedCanvasRef?.current : null;
        if (predCanvas && (predCanvas.width !== expectedW || predCanvas.height !== expectedH)) {
          predCanvas.width = expectedW;
          predCanvas.height = expectedH;
        }
      }
    }
    const draftCanvas = rp.effectiveDraftCanvasRef?.current ?? null;
    const draftVersion = draftCanvas ? ((draftCanvas as any).__draftVersion ?? 0) : 0;
    const draftSpace = ((draftCanvas as any)?.__draftSpace as 'document' | 'viewport' | undefined) ?? 'viewport';
    const draftDocRect = (draftCanvas as any)?.__draftDocRect ?? null;
    const draftMonochrome = Boolean((draftCanvas as any)?.__draftMonochrome);
    return {
      dimensions: rp.dimensions,
      showCheckerboard: rp.showCheckerboard,
      devicePixelRatio: dpr,
      onionSkinFrames: rp.onionSkinFrames,
      softProof: rp.softProofSettings,
      activeLayerId: rp.activeLayerId ?? null,
      activeDraftLayerId: rp.activeLayerId ?? null,
      activeDraftCanvas: draftCanvas,
      activeDraftDirtyRect: draftSpace === 'document' ? draftDocRect : null,
      activeDraftVersion: draftVersion,
      activeDraftSpace: draftSpace,
      activeDraftOpacity: rp.brushOpacity,
      activeDraftMonochrome: draftMonochrome,
    };
  };

  // Direct zero-React-rerender camera subscription for smooth 60-240Hz pan, zoom, rotation, and view flip
  useEffect(() => {
    if (!navigation) return;
    return navigation.subscribeCamera((cam) => {
      const rp = renderParamsRef.current;
      rp.pan = cam.pan;
      rp.zoom = cam.zoom;
      rp.rotation = cam.rotation;
      rp.flipX = cam.flipX;
      rp.flipY = cam.flipY;

      const cfg = cursorConfigRef.current;
      cfg.rotation = cam.rotation;
      cfg.flipX = cam.flipX;
      cfg.flipY = cam.flipY;

      const artboard = artboardRef.current;
      if (artboard) {
        artboard.style.transform = formatArtboardTransform(
          cam.pan,
          cam.zoom,
          cam.rotation,
          cam.flipX,
          cam.flipY,
          rp.dimensions
        );
      }

      const ring = cursorRingRef.current;
      if (ring) {
        const baseW = Math.max(4, cfg.activeToolSize * cam.zoom);
        const cW = cfg.thicknessVertical
          ? Math.max(2, baseW * cfg.thicknessRatio)
          : baseW;
        const cH = cfg.thicknessVertical
          ? Math.max(2, baseW * cfg.tipAspect)
          : Math.max(2, baseW * cfg.tipAspect * cfg.thicknessRatio);
        ring.style.width = `${cW}px`;
        ring.style.height = `${cH}px`;
        const pos = lastPointerPosRef.current;
        if (pos && ring.style.display !== 'none') {
          ring.style.transform = formatCursorRingTransform(
            pos.x,
            pos.y,
            cam.rotation,
            cam.flipX,
            cam.flipY,
            cfg.tipAngleDeg + (cfg.followDirection ? cfg.dynamicDirDeg ?? 0 : 0)
          );
        }
      }

      if (viewportCanvasRef.current && !compositorRef.current) {
        compositorRef.current = new ViewportCompositor(viewportCanvasRef.current);
      }
      if (compositorRef.current) {
        const dpr = window.devicePixelRatio || 1;
        compositorRef.current.render(
          rp.effectiveLayers,
          {
            pan: cam.pan,
            zoom: cam.zoom,
            rotation: cam.rotation,
            flipX: cam.flipX,
            flipY: cam.flipY,
          },
          rp.dimensions,
          tileGridRef.current,
          buildCompositorOptions(rp, dpr)
        );
      }
    });
  }, [navigation]);

  // Synchronize viewport and draft overlay canvas resolution with the screen viewport
  useEffect(() => {
    let dprMql: MediaQueryList | null = null;

    const updateCanvasSizes = () => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        viewportCssSizeRef.current = { width: rect.width, height: rect.height };
      }
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));

      const draftCanvas = effectiveDraftCanvasRef?.current;
      if (
        draftCanvas &&
        (draftCanvas as any).__draftSpace !== 'document' &&
        (draftCanvas.width !== w || draftCanvas.height !== h)
      ) {
        draftCanvas.width = w;
        draftCanvas.height = h;
        (draftCanvas as any).__draftHasContent = false;
        (draftCanvas as any).__draftVersion = ((draftCanvas as any).__draftVersion || 0) + 1;
      }

      const predCanvas = effectivePredictedCanvasRef?.current;
      if (predCanvas && (predCanvas.width !== w || predCanvas.height !== h)) {
        predCanvas.width = w;
        predCanvas.height = h;
      }

      const vCanvas = viewportCanvasRef.current;
      if (vCanvas) {
        if (compositorRef.current && compositorRef.current.getCanvas() !== vCanvas) {
          compositorRef.current.dispose();
          compositorRef.current = null;
        }
        const sizeChanged = vCanvas.width !== w || vCanvas.height !== h;
        if (sizeChanged || !compositorRef.current) {
          if (!compositorRef.current) {
            vCanvas.width = w;
            vCanvas.height = h;
            compositorRef.current = new ViewportCompositor(vCanvas);
          } else {
            compositorRef.current.resize(w, h);
          }
          const rp = renderParamsRef.current;
          compositorRef.current.render(
            rp.effectiveLayers,
            {
              pan: rp.pan,
              zoom: rp.zoom,
              rotation: rp.rotation,
              flipX: rp.flipX,
              flipY: rp.flipY,
            },
            rp.dimensions,
            tileGridRef.current,
            buildCompositorOptions(rp, dpr)
          );
        }
      }
    };

    const handleDprChange = () => {
      updateCanvasSizes();
      attachDprListener();
    };

    const attachDprListener = () => {
      if (dprMql) {
        dprMql.removeEventListener?.('change', handleDprChange);
        dprMql = null;
      }
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        const curDpr = window.devicePixelRatio || 1;
        dprMql = window.matchMedia(`(resolution: ${curDpr}dppx)`);
        dprMql.addEventListener?.('change', handleDprChange);
      }
    };

    updateCanvasSizes();
    attachDprListener();
    window.addEventListener('resize', updateCanvasSizes);
    const ro = typeof ResizeObserver !== 'undefined' && viewportRef.current
      ? new ResizeObserver(updateCanvasSizes)
      : null;
    if (ro && viewportRef.current) {
      ro.observe(viewportRef.current);
    }
    return () => {
      window.removeEventListener('resize', updateCanvasSizes);
      dprMql?.removeEventListener?.('change', handleDprChange);
      ro?.disconnect();
    };
  }, [viewportRef, effectiveDraftCanvasRef, effectivePredictedCanvasRef, hasOpenDocument]);

  useEffect(() => {
    if (viewportRef.current) {
      onViewportReady?.(viewportRef.current);
      const raf = requestAnimationFrame(() => {
        if (viewportRef.current) {
          onViewportReady?.(viewportRef.current);
        }
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [onViewportReady, viewportRef]);

  // Render scene using Unified GPU Viewport Compositor
  useEffect(() => {
    const vCanvas = viewportCanvasRef.current;
    if (!vCanvas) return;
    if (compositorRef.current && compositorRef.current.getCanvas() !== vCanvas) {
      compositorRef.current.dispose();
      compositorRef.current = null;
    }
    if (!compositorRef.current) {
      compositorRef.current = new ViewportCompositor(vCanvas);
    }

    const dpr = window.devicePixelRatio || 1;
    const rp = renderParamsRef.current;
    compositorRef.current.render(
      effectiveLayers,
      {
        pan: rp.pan,
        zoom: rp.zoom,
        rotation: rp.rotation,
        flipX: rp.flipX,
        flipY: rp.flipY,
      },
      dimensions,
      tileGrid,
      buildCompositorOptions(rp, dpr)
    );
  }, [effectiveLayers, layers, pan, zoom, rotation, flipX, flipY, dimensions, showCheckerboard, onionSkinFrames, softProofSettings, activeLayerId, brushOpacity, colorMode, tileGrid]);

  // Event-Driven Compositor Invalidation via active document's SparseTileGrid subscription
  useEffect(() => {
    let rafId: number | null = null;
    const activeGrid = tileGrid;
    const renderCompositor = () => {
      if (compositorRef.current) {
        const dpr = window.devicePixelRatio || 1;
        const rp = renderParamsRef.current;
        compositorRef.current.render(
          rp.effectiveLayers,
          {
            pan: rp.pan,
            zoom: rp.zoom,
            rotation: rp.rotation,
            flipX: rp.flipX,
            flipY: rp.flipY,
          },
          rp.dimensions,
          activeGrid,
          buildCompositorOptions(rp, dpr)
        );
      }
    };

    const handleGridChange = (immediate?: boolean) => {
      if (immediate) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        renderCompositor();
        return;
      }
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        renderCompositor();
      });
    };

    const unsubscribe = activeGrid.subscribe(handleGridChange);
    return () => {
      unsubscribe();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [tileGrid]);

  useEffect(() => {
    return () => {
      if (compositorRef.current) {
        compositorRef.current.dispose();
        compositorRef.current = null;
      }
    };
  }, []);

  return {
    viewportCanvasRef,
  };
}
