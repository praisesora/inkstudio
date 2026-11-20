import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  CanvasDimensions,
  BrushSettings,
  LayerItem,
  CanvasSelection,
  TransformSession,
  TextSettings,
  ToolType,
  LiquifySettings,
  SpeechBalloon,
  SoftProofSettings,
  CanvasColorMode,
} from '../types/editor';
import { ROTATE_CURSOR_CSS, CanvasNavigationHandle } from '../hooks/useCanvasNavigation';
import { SelectionOverlay } from './SelectionOverlay';
import { TransformOverlay } from './TransformOverlay';
import { TextEditorOverlay } from './TextEditorOverlay';
import { SpeechBalloonOverlay } from './SpeechBalloonOverlay';
import { SmartphoneViewportSimulator } from './SmartphoneViewportSimulator';
import { PerspectiveRulerOverlay } from './PerspectiveRulerOverlay';
import { PerspectiveRuler, ConstraintAxis } from '../types/perspective';
import { Local3DContainer } from './Local3DContainer';
import { ViewportCompositor } from '../utils/compositor';
import { SparseTileGrid, globalTileGrid } from '../utils/tileEngine';
import { getBrushTipOutline, resolveBrushTipImage, TipOutline } from '../utils/brushOutline';
import { preloadTipImage } from '../utils/brushStorage';
import { Smartphone, Archive } from 'lucide-react';
import { AnimationTimeline } from './AnimationTimeline';
import { AnimationTimeline as AnimationTimelineType } from '../types/editor';
import { getOnionSkinFrames } from '../utils/animationEngine';
import { FloatingBrushPill } from './FloatingBrushPill';
import { screenToCanvas } from '../utils/canvasUtils';
import {
  resolveHeldKeyModifierAction,
  resolvePointerModifierAction,
} from '../utils/shortcutManager';
import { toolStoreActions, useToolStore, useUiStore } from '../stores';
import { ModifierAction } from '../types/settings';

const PIPETTE_CURSOR_CSS = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cg stroke='%23000000' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round' fill='none'%3E%3Cpath d='m14 7 3 3'/%3E%3Cpath d='M16.6 5.6a2.12 2.12 0 0 1 3 3L7 20.6 2 22l1.4-5L16.6 5.6z'/%3E%3C/g%3E%3Cg stroke='%23ffffff' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' fill='none'%3E%3Cpath d='m14 7 3 3'/%3E%3Cpath d='M16.6 5.6a2.12 2.12 0 0 1 3 3L7 20.6 2 22l1.4-5L16.6 5.6z'/%3E%3C/g%3E%3C/svg%3E") 2 22, crosshair`;

interface CanvasAreaProps {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  dimensions: CanvasDimensions;
  brushSettings: BrushSettings;
  onUpdateBrushSettings: (newSettings: Partial<BrushSettings>) => void;
  zoom: number;
  pan: { x: number; y: number };
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
  navigation?: CanvasNavigationHandle;
  isSpaceDown: boolean;
  isShiftDown: boolean;
  isRotateModifier: boolean;
  isPanning: boolean;
  isRotating: boolean;
  isZoomDragging?: boolean;
  onStartPan: (e: React.PointerEvent) => void;
  onStartRotate: (e: React.PointerEvent) => void;
  onStartZoomDrag?: (e: React.PointerEvent) => void;
  onSampleColor?: (pt: { x: number; y: number }) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onFlipHorizontal?: () => void;
  isHovering: boolean;
  cursorPos: { x: number; y: number } | null;
  onPointerDown: (e: React.PointerEvent<HTMLElement>, coalesced?: PointerEvent[]) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>, coalesced?: PointerEvent[], predicted?: PointerEvent[]) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  predictedCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  layers: LayerItem[];
  layerCanvasesRef?: React.MutableRefObject<Map<string, HTMLCanvasElement>>;
  registerLayerCanvas: (id: string, canvas: HTMLCanvasElement | null) => void;
  getEffectiveOpacity: (layer: LayerItem) => number;
  isLayerEffectivelyVisible: (layer: LayerItem) => boolean;
  interactionRef: React.RefObject<HTMLDivElement | null>;
  showCheckerboard?: boolean;
  hasOpenDocument?: boolean;
  draftCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  strokeCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  peers?: import('../types/multiplayer').CollabPeer[];
  activePings?: Array<{ id: string; x: number; y: number; color: string; name: string }>;
  remoteDraftCanvasesRef?: React.MutableRefObject<Map<string | number, HTMLCanvasElement>>;
  tool?: ToolType;
  selection?: CanvasSelection | null;
  onDeselect?: () => void;
  onTransformSelection?: () => void;
  onFillScreentone?: () => void;
  onFillColor?: () => void;
  onClearSelection?: () => void;
  onInvertSelection?: () => void;
  onExpandSelection?: (pixels: number) => void;
  onContractSelection?: (pixels: number) => void;
  onFeatherSelection?: (radius: number) => void;
  transformSession?: TransformSession | null;
  onUpdateTransformSession?: (updater: (prev: TransformSession) => TransformSession) => void;
  onApplyTransform?: () => void;
  onCancelTransform?: () => void;
  textSession?: { x: number; y: number; settings: TextSettings } | null;
  onUpdateTextSettings?: (updater: (prev: TextSettings) => TextSettings) => void;
  onMoveTextSession?: (x: number, y: number) => void;
  onConfirmText?: () => void;
  onCancelText?: () => void;
  perspectiveRuler?: PerspectiveRuler | null;
  onUpdatePerspectiveRuler?: (ruler: PerspectiveRuler | null) => void;
  activeLockedAxis?: ConstraintAxis | null;
  isDrawing?: boolean;
  is3DLayerOpen?: boolean;
  initial3DFile?: File | null;
  onClose3DLayer?: () => void;
  onInsertRasterLayer?: (layer: LayerItem, canvas: HTMLCanvasElement) => void;
  onBake3DSuccess?: (layer: LayerItem) => void;
  liquifySettings?: LiquifySettings;
  onUpdateLiquifySettings?: (newSettings: Partial<LiquifySettings>) => void;
  primaryColor?: string;
  onSwapColors?: () => void;
  showCursorCoordinates?: boolean;
  showPressureInStatusBar?: boolean;
  isWebtoonMode?: boolean;
  onToggleWebtoonMode?: () => void;
  onOpenWebtoonExport?: () => void;
  activeBalloon?: SpeechBalloon | null;
  onUpdateBalloon?: (updater: (prev: SpeechBalloon) => SpeechBalloon) => void;
  onConfirmBalloon?: () => void;
  onDeleteBalloon?: () => void;
  frameDragPreview?: { mode: 'create' | 'divide'; start: { x: number; y: number }; end: { x: number; y: number } } | null;
  animationTimeline?: AnimationTimelineType | null;
  onUpdateAnimationTimeline?: (timeline: AnimationTimelineType) => void;
  onAddAnimationCel?: (frameIndex: number) => void;
  onDeleteAnimationCel?: (frameIndex: number) => void;
  onSelectCelLayer?: (layerId: string) => void;
  softProofSettings?: SoftProofSettings;
  onViewportReady?: (viewport: HTMLDivElement) => void;
  activeLayerId?: string;
  colorMode?: CanvasColorMode;
  tileGrid?: SparseTileGrid;
}

export function extractCoalescedEvents(e: React.PointerEvent<HTMLElement>): PointerEvent[] {
  const native = e.nativeEvent;
  if (!native) return [];
  // Per W3C Pointer Events spec, pointerdown represents a single contact event;
  // some Windows/WebView2 stylus drivers emit stale or DPI-offset coalesced packets on pointerdown.
  if (native.type === 'pointerdown') {
    return [native];
  }
  if (typeof native.getCoalescedEvents === 'function') {
    try {
      const coalesced = native.getCoalescedEvents();
      if (coalesced && coalesced.length > 0) {
        const last = coalesced[coalesced.length - 1];
        // Guard against Chromium/WebView2 Windows Ink DPI coordinate-space mismatch where
        // getCoalescedEvents() diverges from the dispatching PointerEvent's clientX/clientY.
        if (
          last &&
          Number.isFinite(last.clientX) &&
          Number.isFinite(last.clientY) &&
          Math.hypot(last.clientX - native.clientX, last.clientY - native.clientY) <= 1.5
        ) {
          return coalesced as unknown as PointerEvent[];
        }
      }
    } catch {}
  }
  return [native];
}

function extractPredictedEvents(e: React.PointerEvent<HTMLElement>): PointerEvent[] {
  const native = e.nativeEvent;
  if (native && typeof native.getPredictedEvents === 'function') {
    try {
      const predicted = native.getPredictedEvents();
      if (predicted && predicted.length > 0) {
        return predicted as unknown as PointerEvent[];
      }
    } catch {}
  }
  return [];
}

function formatArtboardTransform(
  pan: { x: number; y: number },
  zoom: number,
  rotation: number,
  flipX: boolean,
  flipY: boolean,
  dimensions: CanvasDimensions
): string {
  const sx = (flipX ? -1 : 1) * zoom;
  const sy = (flipY ? -1 : 1) * zoom;
  return `translate3d(${pan.x}px, ${pan.y}px, 0) rotate(${rotation}deg) scale(${sx}, ${sy}) translate3d(${-dimensions.width / 2}px, ${-dimensions.height / 2}px, 0)`;
}

function formatCursorRingTransform(
  x: number,
  y: number,
  rotation: number,
  flipX: boolean,
  flipY: boolean,
  tipAngleDeg: number
): string {
  const fx = flipX ? -1 : 1;
  const fy = flipY ? -1 : 1;
  return `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) rotate(${rotation}deg) scale(${fx}, ${fy}) rotate(${tipAngleDeg}deg)`;
}

export const CanvasArea: React.FC<CanvasAreaProps> = React.memo(({
  viewportRef,
  onViewportReady,
  dimensions,
  brushSettings,
  onUpdateBrushSettings,
  zoom,
  pan,
  rotation,
  flipX = false,
  flipY = false,
  navigation,
  isSpaceDown,
  isRotateModifier,
  isPanning,
  isRotating,
  isZoomDragging = false,
  onStartPan,
  onStartRotate,
  onStartZoomDrag,
  onSampleColor,
  onUndo,
  onRedo,
  onFlipHorizontal,
  isWebtoonMode = false,
  onToggleWebtoonMode,
  onOpenWebtoonExport,
  activeBalloon = null,
  onUpdateBalloon,
  onConfirmBalloon,
  onDeleteBalloon,
  frameDragPreview = null,
  isHovering: _isHovering,
  cursorPos: _cursorPos,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerEnter,
  onPointerLeave,
  layers,
  layerCanvasesRef,
  registerLayerCanvas: _registerLayerCanvas,
  getEffectiveOpacity: _getEffectiveOpacity,
  isLayerEffectivelyVisible: _isLayerEffectivelyVisible,
  interactionRef,
  showCheckerboard = true,
  hasOpenDocument = true,
  draftCanvasRef,
  strokeCanvasRef,
  predictedCanvasRef,
  peers = [],
  activePings = [],
  remoteDraftCanvasesRef,
  tool = 'brush',
  selection = null,
  onDeselect,
  onTransformSelection,
  onFillScreentone,
  onFillColor,
  onClearSelection,
  onInvertSelection,
  onExpandSelection,
  onContractSelection,
  onFeatherSelection,
  transformSession = null,
  onUpdateTransformSession,
  onApplyTransform,
  onCancelTransform,
  textSession = null,
  onUpdateTextSettings,
  onMoveTextSession,
  onConfirmText,
  onCancelText,
  perspectiveRuler = null,
  onUpdatePerspectiveRuler,
  activeLockedAxis = null,
  isDrawing = false,
  is3DLayerOpen = false,
  initial3DFile = null,
  onClose3DLayer,
  onInsertRasterLayer,
  onBake3DSuccess,
  liquifySettings,
  onUpdateLiquifySettings,
  primaryColor = '#000000',
  onSwapColors,
  showCursorCoordinates = false,
  showPressureInStatusBar = false,
  animationTimeline = null,
  onUpdateAnimationTimeline,
  onAddAnimationCel,
  onDeleteAnimationCel,
  onSelectCelLayer,
  softProofSettings,
  activeLayerId,
  colorMode = 'color',
  tileGrid = globalTileGrid,
}) => {
  const tileGridRef = useRef<SparseTileGrid>(tileGrid);
  tileGridRef.current = tileGrid;

  const effectiveDraftCanvasRef = draftCanvasRef || strokeCanvasRef;
  const localPredictedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const effectivePredictedCanvasRef = predictedCanvasRef || localPredictedCanvasRef;

  const activeLayer = layers.find((l) => l.id === activeLayerId);
  const isMonochromeActive = colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome' || brushSettings.antiAlias === 0;

  // Resolve tip image and extract vector outline silhouette
  const activeTipImage = resolveBrushTipImage(brushSettings);
  const [tipOutline, setTipOutline] = useState<TipOutline | null>(() => {
    return activeTipImage ? getBrushTipOutline(activeTipImage) : null;
  });

  useEffect(() => {
    let isCancelled = false;

    if (activeTipImage) {
      if (activeTipImage.complete && activeTipImage.naturalWidth > 0) {
        setTipOutline(getBrushTipOutline(activeTipImage));
      } else {
        const handleLoad = () => {
          if (!isCancelled) {
            setTipOutline(getBrushTipOutline(activeTipImage));
          }
        };
        activeTipImage.addEventListener('load', handleLoad, { once: true });
      }
      return () => {
        isCancelled = true;
      };
    }

    if (brushSettings.customTipDataUrl) {
      preloadTipImage(brushSettings.customTipDataUrl)
        .then((img) => {
          if (!isCancelled) {
            setTipOutline(getBrushTipOutline(img));
          }
        })
        .catch(() => {
          if (!isCancelled) {
            setTipOutline(null);
          }
        });
      return () => {
        isCancelled = true;
      };
    }

    setTipOutline(null);
  }, [activeTipImage, brushSettings.customTipDataUrl, brushSettings.preset]);

  // Dynamic cursor dimensions according to brush tip shape, aspect ratio, and thickness
  const liveCamera = navigation
    ? navigation.getCameraState()
    : { pan, zoom, rotation, flipX, flipY };
  const liveZoom = liveCamera.zoom;
  const livePan = liveCamera.pan;
  const liveRotation = liveCamera.rotation;
  const liveFlipX = liveCamera.flipX;
  const liveFlipY = liveCamera.flipY;

  const isCustomTip = Boolean(tipOutline && (tool === 'brush' || tool === 'eraser'));
  const isSquare = brushSettings.preset === 'square-digital' && !tipOutline;
  const tipAspect = isCustomTip && tipOutline ? tipOutline.height / tipOutline.width : 1.0;

  const activeToolSize = tool === 'liquify' && liquifySettings ? liquifySettings.size : brushSettings.size;
  const cursorBaseWidth = Math.max(4, activeToolSize * liveZoom);
  const thicknessRatio = tool === 'brush' ? (brushSettings.thickness ?? 1.0) : 1.0;
  const thicknessVertical = Boolean(brushSettings.thicknessVertical && tool === 'brush');
  const tipAngleDeg = tool === 'brush' ? (brushSettings.customTipAngle ?? 0) : 0;

  const cursorWidth = thicknessVertical
    ? Math.max(2, cursorBaseWidth * thicknessRatio)
    : cursorBaseWidth;
  const cursorHeight = thicknessVertical
    ? Math.max(2, cursorBaseWidth * tipAspect)
    : Math.max(2, cursorBaseWidth * tipAspect * thicknessRatio);

  // Brush tip rotation: tip angle relative to canvas + viewport canvas rotation
  const totalAngleDeg = tipAngleDeg + liveRotation;
  const cursorConfigRef = useRef({
    activeToolSize,
    tipAspect,
    thicknessRatio,
    thicknessVertical,
    tipAngleDeg,
    rotation: liveRotation,
    flipX: liveFlipX,
    flipY: liveFlipY,
  });
  cursorConfigRef.current = {
    activeToolSize,
    tipAspect,
    thicknessRatio,
    thicknessVertical,
    tipAngleDeg,
    rotation: liveRotation,
    flipX: liveFlipX,
    flipY: liveFlipY,
  };
  const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null);

  // Dynamic on-canvas brush resizing via configured modifier (default Ctrl + Alt + Drag or Shift + Alt + Drag)
  const [heldModifierAction, setHeldModifierAction] = useState<ModifierAction>('none');
  const [isResizingBrush, setIsResizingBrush] = useState(false);
  const [quickPalettePos, setQuickPalettePos] = useState<{ x: number; y: number } | null>(null);
  const tempEraserPrevToolRef = useRef<ToolType | null>(null);
  const resizeOriginRef = useRef<{ clientX: number; clientY: number }>({ clientX: 0, clientY: 0 });
  const resizeStartSettingsRef = useRef<{ size: number; hardness: number }>({
    size: brushSettings.size,
    hardness: brushSettings.hardness ?? 1.0,
  });

  // Zero-latency direct DOM cursor preview element & artboard container
  const artboardRef = useRef<HTMLDivElement | null>(null);
  const cursorRingRef = useRef<HTMLDivElement | null>(null);
  const pointerStatRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!showCursorCoordinates && !showPressureInStatusBar) return;
    let rafId = 0;
    const handlePointerStat = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const el = pointerStatRef.current;
        if (!el || !detail) return;
        const parts: string[] = [];
        if (showCursorCoordinates && detail.x !== null && detail.x !== undefined) {
          parts.push(`${detail.x}, ${detail.y}`);
        }
        if (showPressureInStatusBar && detail.pressure > 0) {
          parts.push(`${Math.round(detail.pressure * 100)}%`);
        }
        el.textContent = parts.join('  ·  ');
      });
    };
    window.addEventListener('canvas-pointer-stat', handlePointerStat);
    return () => {
      window.removeEventListener('canvas-pointer-stat', handlePointerStat);
      cancelAnimationFrame(rafId);
    };
  }, [showCursorCoordinates, showPressureInStatusBar]);

  // Update cursor rotation/flip in-place when viewport rotates/flips or brush tip angle changes while hovering
  useEffect(() => {
    const ring = cursorRingRef.current;
    const pos = lastPointerPosRef.current;
    if (ring && pos && ring.style.display !== 'none') {
      const cfg = cursorConfigRef.current;
      ring.style.transform = formatCursorRingTransform(
        pos.x,
        pos.y,
        cfg.rotation,
        cfg.flipX,
        cfg.flipY,
        cfg.tipAngleDeg
      );
    }
  }, [tipAngleDeg, liveRotation, liveFlipX, liveFlipY]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let cachedRect: DOMRect | null = viewport.getBoundingClientRect();
    const updateRect = () => {
      if (viewport) cachedRect = viewport.getBoundingClientRect();
    };

    window.addEventListener('resize', updateRect);
    window.addEventListener('scroll', updateRect, true);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateRect) : null;
    ro?.observe(viewport);

    const updateCursorRingPos = (e: PointerEvent, forceRefreshRect: boolean = false) => {
      const ring = cursorRingRef.current;
      if (!ring) return;

      if (
        isSpaceDown ||
        isPanning ||
        isRotating ||
        isZoomDragging ||
        isRotateModifier ||
        isResizingBrush ||
        heldModifierAction === 'brush-size' ||
        heldModifierAction === 'pan' ||
        heldModifierAction === 'rotate' ||
        heldModifierAction === 'zoom-drag' ||
        (tool !== 'brush' && tool !== 'eraser' && tool !== 'liquify' && tool !== 'select-pen' && tool !== 'select-eraser')
      ) {
        ring.style.display = 'none';
        return;
      }

      if (forceRefreshRect || !cachedRect) updateRect();
      if (!cachedRect) return;

      const x = e.clientX - cachedRect.left;
      const y = e.clientY - cachedRect.top;

      if (x < 0 || x > cachedRect.width || y < 0 || y > cachedRect.height) {
        ring.style.display = 'none';
        return;
      }

      lastPointerPosRef.current = { x, y };
      const cfg = cursorConfigRef.current;
      ring.style.transform = formatCursorRingTransform(
        x,
        y,
        cfg.rotation,
        cfg.flipX,
        cfg.flipY,
        cfg.tipAngleDeg
      );
      if (ring.style.display !== 'block') {
        ring.style.display = 'block';
      }
    };

    const handleWindowPointerMove = (e: PointerEvent) => {
      updateCursorRingPos(e, false);
    };

    const handleViewportPointerEnterOrDown = (e: PointerEvent) => {
      updateCursorRingPos(e, true);
    };

    const handlePointerLeave = () => {
      lastPointerPosRef.current = null;
      if (cursorRingRef.current) {
        cursorRingRef.current.style.display = 'none';
      }
    };

    viewport.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    viewport.addEventListener('pointerdown', handleViewportPointerEnterOrDown, { passive: true });
    viewport.addEventListener('pointerenter', handleViewportPointerEnterOrDown, { passive: true });
    viewport.addEventListener('pointerleave', handlePointerLeave, { passive: true });

    return () => {
      window.removeEventListener('resize', updateRect);
      window.removeEventListener('scroll', updateRect, true);
      ro?.disconnect();
      viewport.removeEventListener('pointermove', handleWindowPointerMove);
      viewport.removeEventListener('pointerdown', handleViewportPointerEnterOrDown);
      viewport.removeEventListener('pointerenter', handleViewportPointerEnterOrDown);
      viewport.removeEventListener('pointerleave', handlePointerLeave);
    };
  }, [isSpaceDown, isPanning, isRotating, isZoomDragging, isRotateModifier, isResizingBrush, heldModifierAction, viewportRef, tool, hasOpenDocument]);

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
    brushOpacity: brushSettings.opacity ?? 1.0,
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
    brushOpacity: brushSettings.opacity ?? 1.0,
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
            cfg.tipAngleDeg
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
  }, [effectiveLayers, layers, pan, zoom, rotation, flipX, flipY, dimensions, showCheckerboard, onionSkinFrames, softProofSettings, activeLayerId, brushSettings.opacity, colorMode, tileGrid]);

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

  // Track held modifier key combinations globally according to Modifier Key Settings
  useEffect(() => {
    const syncHeldAction = (e: KeyboardEvent, spaceOverride?: boolean) => {
      const action = resolveHeldKeyModifierAction(
        {
          ctrl: e.ctrlKey || e.metaKey,
          shift: e.shiftKey,
          alt: e.altKey,
          space: spaceOverride !== undefined ? spaceOverride : isSpaceDown,
        },
        useUiStore.getState().appSettings.modifierKeys
      );
      setHeldModifierAction(action);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && quickPalettePos) {
        setQuickPalettePos(null);
      }
      syncHeldAction(e, e.code === 'Space' ? true : undefined);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      syncHeldAction(e, e.code === 'Space' ? false : undefined);
    };

    const handleBlur = () => {
      setHeldModifierAction('none');
      setIsResizingBrush(false);
      setQuickPalettePos(null);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [isSpaceDown, quickPalettePos]);

  // Handle active brush resizing window drag listeners
  useEffect(() => {
    if (!isResizingBrush) return;

    let rafId: number | null = null;
    let pendingSize = resizeStartSettingsRef.current.size;
    let pendingHardness = resizeStartSettingsRef.current.hardness;

    const commitResize = () => {
      rafId = null;
      if (tool === 'liquify' && onUpdateLiquifySettings) {
        onUpdateLiquifySettings({ size: Math.round(pendingSize) });
      } else {
        onUpdateBrushSettings({ size: pendingSize, hardness: pendingHardness });
      }
    };

    const handleWindowPointerMove = (e: PointerEvent) => {
      const dx = e.clientX - resizeOriginRef.current.clientX;
      const dy = resizeOriginRef.current.clientY - e.clientY;

      // Exponential + linear hybrid sensitivity for 0.5px..1000px precision (CSP-style)
      const baseSize = Math.max(0.5, resizeStartSettingsRef.current.size);
      const rawSize = baseSize * Math.exp(dx * 0.006) + dx * 0.15;
      const clampedSize = Math.max(0.5, Math.min(1000, rawSize));
      pendingSize = clampedSize < 10 ? Math.round(clampedSize * 10) / 10 : Math.round(clampedSize);

      pendingHardness = Math.max(
        0.05,
        Math.min(
          1.0,
          Math.round((resizeStartSettingsRef.current.hardness + dy * 0.004) * 100) / 100
        )
      );

      if (rafId === null) {
        rafId = requestAnimationFrame(commitResize);
      }
    };

    const handleWindowPointerUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        commitResize();
      }
      setIsResizingBrush(false);
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [isResizingBrush, onUpdateBrushSettings, onUpdateLiquifySettings, tool]);

  const releaseExternalFocus = () => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return;
    if (viewportRef.current?.contains(active)) return;
    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') {
      active.blur();
    }
  };

  // Start brush resizing drag
  const startBrushResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizingBrush(true);
    resizeOriginRef.current = { clientX: e.clientX, clientY: e.clientY };
    resizeStartSettingsRef.current = {
      size: tool === 'liquify' && liquifySettings ? liquifySettings.size : brushSettings.size,
      hardness: brushSettings.hardness ?? 1.0,
    };
  };

  // Start continuous eyedropper sampling for modifier buttons (e.g. Right Click / Barrel Button)
  const startModifierEyedropper = (e: React.PointerEvent) => {
    if (!onSampleColor || !viewportRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    const sampleAtClient = (clientX: number, clientY: number) => {
      const vp = viewportRef.current;
      if (!vp) return;
      const rect = vp.getBoundingClientRect();
      const cam = navigation
        ? navigation.getCameraState()
        : { pan, zoom, rotation, flipX, flipY };
      const pt = screenToCanvas(
        clientX,
        clientY,
        rect,
        cam.pan,
        cam.zoom,
        cam.rotation,
        dimensions,
        cam.flipX,
        cam.flipY
      );
      onSampleColor(pt);
    };

    sampleAtClient(e.clientX, e.clientY);

    const handleMove = (ev: PointerEvent) => {
      sampleAtClient(ev.clientX, ev.clientY);
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
    window.addEventListener('pointermove', handleMove, { passive: true });
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  };

  // Open floating Quick Palette near cursor when mapped to 'quick-palette'
  const openQuickPaletteAt = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const x = Math.max(12, Math.min(rect.width - 210, e.clientX - rect.left));
    const y = Math.max(12, Math.min(rect.height - 150, e.clientY - rect.top));
    setQuickPalettePos({ x, y });
  };

  // Dispatch a resolved ModifierAction; returns true if the event was consumed
  const dispatchModifierAction = (
    action: ModifierAction,
    e: React.PointerEvent<HTMLElement>,
    allowDrawingPassThrough: boolean
  ): boolean => {
    switch (action) {
      case 'pan':
        onStartPan(e);
        return true;
      case 'rotate':
        onStartRotate(e);
        return true;
      case 'zoom-drag':
        if (onStartZoomDrag) {
          onStartZoomDrag(e);
          return true;
        }
        return false;
      case 'brush-size':
        startBrushResize(e);
        return true;
      case 'eyedropper':
        if (e.button !== 0 || !allowDrawingPassThrough) {
          startModifierEyedropper(e);
          return true;
        }
        // When button 0 + Alt is held, GlobalShortcutListener already switched tool to pipette,
        // or if not, sample directly via startModifierEyedropper
        if (tool !== 'pipette') {
          startModifierEyedropper(e);
          return true;
        }
        return false;
      case 'temp-eraser': {
        if (!allowDrawingPassThrough) return false;
        const cur = useToolStore.getState().tool;
        if (cur !== 'eraser') {
          tempEraserPrevToolRef.current = cur;
          toolStoreActions.selectTool('eraser');
        }
        return false; // let stroke begin on eraser
      }
      case 'undo':
        e.preventDefault();
        e.stopPropagation();
        onUndo?.();
        return true;
      case 'swap-colors':
        e.preventDefault();
        e.stopPropagation();
        onSwapColors?.();
        return true;
      case 'quick-palette':
        openQuickPaletteAt(e);
        return true;
      case 'straight-line':
      case 'none':
      default:
        return false;
    }
  };

  // Viewport background pointer down (clicking gray area to pan, rotate, zoom, resize, or quick palette)
  const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    releaseExternalFocus();
    if (quickPalettePos) setQuickPalettePos(null);

    const modSettings = useUiStore.getState().appSettings.modifierKeys;
    const resolved = resolvePointerModifierAction(
      {
        button: e.button,
        pointerType: e.pointerType,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        isSpaceDown,
      },
      modSettings
    );
    if (resolved && dispatchModifierAction(resolved.action, e, false)) {
      return;
    }
  };

  // Canvas pointer down: resolve Modifier Key Settings first, otherwise dispatch drawing/tool stroke
  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    releaseExternalFocus();
    if (quickPalettePos) setQuickPalettePos(null);

    const modSettings = useUiStore.getState().appSettings.modifierKeys;
    const resolved = resolvePointerModifierAction(
      {
        button: e.button,
        pointerType: e.pointerType,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        isSpaceDown,
      },
      modSettings
    );

    if (resolved) {
      if (dispatchModifierAction(resolved.action, e, true)) {
        return;
      }
    }

    if (e.button === 0) {
      e.preventDefault();
    } else {
      return;
    }

    const coalesced = extractCoalescedEvents(e);
    (e as any).coalescedEvents = coalesced;
    if (e.nativeEvent) {
      (e.nativeEvent as any).coalescedEvents = coalesced;
    }
    onPointerDown(e, coalesced);
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const coalesced = extractCoalescedEvents(e);
    const predicted = extractPredictedEvents(e);
    (e as any).coalescedEvents = coalesced;
    (e as any).predictedEvents = predicted;
    if (e.nativeEvent) {
      (e.nativeEvent as any).coalescedEvents = coalesced;
      (e.nativeEvent as any).predictedEvents = predicted;
    }
    onPointerMove(e, coalesced, predicted);
  };

  const handleCanvasPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    onPointerUp(e);
    if (tempEraserPrevToolRef.current !== null) {
      const prev = tempEraserPrevToolRef.current;
      tempEraserPrevToolRef.current = null;
      toolStoreActions.selectTool(prev);
    }
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    const modSettings = useUiStore.getState().appSettings.modifierKeys;
    if (modSettings.rightClick !== 'none' || modSettings.stylusButton1 !== 'none') {
      e.preventDefault();
    }
  };

  // Determine cursor based on active mode
  const getCursorStyle = (isOverCanvas: boolean): React.CSSProperties => {
    if (isResizingBrush || heldModifierAction === 'brush-size') {
      return { cursor: 'ew-resize' };
    }
    if (isZoomDragging || heldModifierAction === 'zoom-drag') {
      return { cursor: 'zoom-in' };
    }
    if (isRotating || isRotateModifier || heldModifierAction === 'rotate') {
      return { cursor: ROTATE_CURSOR_CSS };
    }
    if (isPanning) {
      return { cursor: 'grabbing' };
    }
    if (isSpaceDown || heldModifierAction === 'pan') {
      return { cursor: 'grab' };
    }
    if (tool === 'pipette' || heldModifierAction === 'eyedropper') {
      return { cursor: PIPETTE_CURSOR_CSS };
    }
    if (tool === 'text') {
      return { cursor: 'text' };
    }
    if (tool === 'select-rect' || tool === 'select-lasso' || tool === 'select-wand' || tool === 'fill' || tool === 'frame') {
      return { cursor: 'crosshair' };
    }
    if (tool === 'liquify') {
      return { cursor: isOverCanvas ? 'none' : 'default' };
    }
    if (tool === 'transform') {
      return { cursor: 'default' };
    }
    if (tool === 'brush' || tool === 'eraser' || tool === 'select-pen' || tool === 'select-eraser') {
      return { cursor: isOverCanvas ? 'none' : 'default' };
    }
    return { cursor: isOverCanvas ? 'crosshair' : 'default' };
  };

  // Viewport bounds for positioning floating preview
  const viewportRect = isResizingBrush ? viewportRef.current?.getBoundingClientRect() : null;
  const resizePreviewX = viewportRect
    ? resizeOriginRef.current.clientX - viewportRect.left
    : pan.x;
  const resizePreviewY = viewportRect
    ? resizeOriginRef.current.clientY - viewportRect.top
    : pan.y;

  // If no document is open, display an empty canvas workspace
  if (!hasOpenDocument) {
    return (
      <main
        ref={viewportRef}
        className="flex-1 bg-[#161616] overflow-hidden relative select-none"
      />
    );
  }

  const showFloatingPill =
    tool === 'brush' ||
    tool === 'eraser' ||
    tool === 'liquify' ||
    tool === 'select-pen' ||
    tool === 'select-eraser';

  return (
    <main
      ref={viewportRef}
      onPointerDown={handleViewportPointerDown}
      onContextMenu={handleContextMenu}
      className="flex-1 bg-[#161616] overflow-hidden relative select-none canvas-viewport"
      style={{
        touchAction: 'none',
        ...getCursorStyle(false),
      }}
    >
      {/* Sleek Floating Pill Slider near Canvas Edge for Brush Size & Opacity */}
      {showFloatingPill && (
        <FloatingBrushPill
          tool={tool}
          brushSettings={brushSettings}
          onUpdateBrushSettings={onUpdateBrushSettings}
          liquifySettings={liquifySettings}
          onUpdateLiquifySettings={onUpdateLiquifySettings}
          primaryColor={primaryColor}
          onSwapColors={onSwapColors}
          zoom={zoom}
        />
      )}
      {/* Unified GPU Viewport Canvas (WebGL2 with Frustum Culling & Shaders) */}
      <canvas
        ref={viewportCanvasRef}
        className="absolute inset-0 pointer-events-none z-10"
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
        }}
      />

      {/* Artboard Container with 2D Affine Transformation (Pan, Zoom, Rotation, and Non-Destructive View Flip) */}
      <div
        ref={artboardRef}
        className="absolute origin-top-left select-none z-20"
        style={{
          width: dimensions.width,
          height: dimensions.height,
          transform: formatArtboardTransform(
            livePan,
            liveZoom,
            liveRotation,
            liveFlipX,
            liveFlipY,
            dimensions
          ),
          transformOrigin: '0 0',
          willChange: 'transform',
          backgroundColor: 'transparent',
          backgroundImage: 'none',
        }}
      >
        {/* Remote Peer Live Stroke Draft Overlay Canvases */}
        {peers.map((peer) => (
          <canvas
            key={`peer-canvas-${peer.id}`}
            ref={(el) => {
              if (remoteDraftCanvasesRef) {
                if (el) remoteDraftCanvasesRef.current.set(peer.id, el);
                else remoteDraftCanvasesRef.current.delete(peer.id);
              }
            }}
            width={dimensions.width}
            height={dimensions.height}
            className="absolute inset-0 block pointer-events-none z-15"
            style={{ imageRendering: zoom > 1 ? 'pixelated' : 'auto' }}
          />
        ))}

        {/* Remote Peer Ghost Cursors with Nametag Badges */}
        {peers.map((peer) => {
          if (peer.x === undefined || peer.y === undefined) return null;
          return (
            <div
              key={`peer-cursor-${peer.id}`}
              className="absolute pointer-events-none transition-transform duration-75 ease-out z-25 select-none -translate-x-1/2 -translate-y-1/2"
              style={{
                left: `${peer.x}px`,
                top: `${peer.y}px`,
              }}
            >
              {/* Colored Cursor Ring */}
              <div
                className="w-3.5 h-3.5 rounded-full border-2 border-white shadow-md animate-in fade-in"
                style={{ backgroundColor: peer.color }}
              />
              {/* Floating Nametag Pill */}
              <div
                className="absolute top-4 left-2 px-1.5 py-0.5 rounded text-[10px] font-semibold text-white shadow-lg whitespace-nowrap flex items-center space-x-1 pointer-events-none"
                style={{
                  backgroundColor: peer.color,
                  transform: `scale(${liveFlipX ? -1 : 1}, ${liveFlipY ? -1 : 1})`,
                }}
              >
                <span>{peer.name}</span>
                {peer.isDrawing && <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />}
              </div>
            </div>
          );
        })}

        {/* Canvas Radar Pings */}
        {activePings.map((ping) => (
          <div
            key={ping.id}
            className="absolute pointer-events-none z-30 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${ping.x}px`, top: `${ping.y}px` }}
          >
            <div
              className="w-12 h-12 rounded-full border-2 animate-ping"
              style={{ borderColor: ping.color }}
            />
            <div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full shadow-md"
              style={{ backgroundColor: ping.color }}
            />
            <div
              className="absolute top-5 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded text-[10px] font-bold text-white whitespace-nowrap shadow-md"
              style={{
                backgroundColor: ping.color,
                transform: `scale(${liveFlipX ? -1 : 1}, ${liveFlipY ? -1 : 1})`,
              }}
            >
              {ping.name}
            </div>
          </div>
        ))}

        {/* Selection Overlay */}
        {selection && (
          <SelectionOverlay
            selection={selection}
            dimensions={dimensions}
            zoom={liveZoom}
            flipX={liveFlipX}
            flipY={liveFlipY}
            onDeselect={onDeselect || (() => {})}
            onTransformSelection={onTransformSelection || (() => {})}
            onFillScreentone={onFillScreentone || (() => {})}
            onFillColor={onFillColor || (() => {})}
            onClearSelection={onClearSelection || (() => {})}
            onInvertSelection={onInvertSelection || (() => {})}
            onExpandSelection={onExpandSelection}
            onContractSelection={onContractSelection}
            onFeatherSelection={onFeatherSelection}
          />
        )}

        {/* Free Transform Overlay */}
        {transformSession?.active && (
          <TransformOverlay
            session={transformSession}
            zoom={liveZoom}
            rotation={liveRotation}
            flipX={liveFlipX}
            flipY={liveFlipY}
            onUpdateSession={onUpdateTransformSession || (() => {})}
            onApply={onApplyTransform || (() => {})}
            onCancel={onCancelTransform || (() => {})}
          />
        )}

        {/* Manga Text Editor Overlay */}
        {textSession && (
          <TextEditorOverlay
            x={textSession.x}
            y={textSession.y}
            settings={textSession.settings}
            zoom={liveZoom}
            rotation={liveRotation}
            flipX={liveFlipX}
            flipY={liveFlipY}
            onUpdateSettings={onUpdateTextSettings || (() => {})}
            onMove={onMoveTextSession || (() => {})}
            onConfirm={onConfirmText || (() => {})}
            onCancel={onCancelText || (() => {})}
          />
        )}

        {/* Parametric Speech Balloon Overlay */}
        {activeBalloon && (
          <SpeechBalloonOverlay
            balloon={activeBalloon}
            zoom={liveZoom}
            rotation={liveRotation}
            flipX={liveFlipX}
            flipY={liveFlipY}
            onUpdateBalloon={onUpdateBalloon || (() => {})}
            onConfirmBalloon={onConfirmBalloon || (() => {})}
            onDeleteBalloon={onDeleteBalloon || (() => {})}
          />
        )}

        {/* Frame Border Folder Create / Divide Live Preview */}
        {frameDragPreview && (
          <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none z-35">
            {frameDragPreview.mode === 'create' ? (
              <rect
                x={Math.min(frameDragPreview.start.x, frameDragPreview.end.x)}
                y={Math.min(frameDragPreview.start.y, frameDragPreview.end.y)}
                width={Math.abs(frameDragPreview.end.x - frameDragPreview.start.x)}
                height={Math.abs(frameDragPreview.end.y - frameDragPreview.start.y)}
                fill="rgba(0, 188, 212, 0.08)"
                stroke="#00bcd4"
                strokeWidth={2 / liveZoom}
                strokeDasharray={`${6 / liveZoom},${4 / liveZoom}`}
              />
            ) : (
              <>
                <line
                  x1={frameDragPreview.start.x}
                  y1={frameDragPreview.start.y}
                  x2={frameDragPreview.end.x}
                  y2={frameDragPreview.end.y}
                  stroke="#00e5ff"
                  strokeWidth={2.5 / liveZoom}
                  strokeDasharray={`${8 / liveZoom},${4 / liveZoom}`}
                />
                <circle
                  cx={frameDragPreview.start.x}
                  cy={frameDragPreview.start.y}
                  r={4 / liveZoom}
                  fill="#00e5ff"
                />
                <circle
                  cx={frameDragPreview.end.x}
                  cy={frameDragPreview.end.y}
                  r={4 / liveZoom}
                  fill="#00e5ff"
                />
              </>
            )}
          </svg>
        )}

        {/* Local-Only 3D Viewport Ghost Layer (Strictly Client-Side Isolated State) */}
        {is3DLayerOpen && onClose3DLayer && onInsertRasterLayer && (
          <Local3DContainer
            dimensions={dimensions}
            zoom={zoom}
            pan={pan}
            rotation={rotation}
            isOpen={is3DLayerOpen}
            initialFile={initial3DFile}
            onClose={onClose3DLayer}
            onInsertRasterLayer={onInsertRasterLayer}
            onBakeSuccess={onBake3DSuccess}
            perspectiveRuler={perspectiveRuler}
            onUpdatePerspectiveRuler={onUpdatePerspectiveRuler}
          />
        )}

        {/* Top Transparent Interaction Surface capturing Stylus / Mouse Pointer Events */}
        <div
          ref={interactionRef}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handleCanvasPointerUp}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onContextMenu={handleContextMenu}
          className="absolute inset-0 block touch-none z-20"
          style={{
            ...getCursorStyle(true),
          }}
        />
      </div>

      {/* Offscreen Active Draft/Stroke Backing Canvas (composited in-stack inside ViewportCompositor at activeLayerId) */}
      <canvas
        ref={effectiveDraftCanvasRef}
        className="absolute inset-0 pointer-events-none z-25"
        style={{
          width: '100%',
          height: '100%',
          opacity: 0,
          visibility: 'hidden',
          display: 'block',
        }}
      />

      {/* Temporary Stroke Head Prediction Canvas (cleared on actual hardware events) */}
      <canvas
        ref={effectivePredictedCanvasRef}
        className="absolute inset-0 pointer-events-none z-26 predicted-overlay-canvas"
        style={{
          width: '100%',
          height: '100%',
          opacity: brushSettings.opacity ?? 1.0,
          display: 'block',
          filter: isMonochromeActive && liveZoom >= 0.99 ? 'url(#ink-monochrome-threshold)' : undefined,
        }}
      />

      {/* SVG 1-bit Discrete Binary Threshold Filter for Manga WYSIWYG */}
      <svg className="absolute w-0 h-0 pointer-events-none overflow-hidden" aria-hidden="true">
        <defs>
          <filter id="ink-monochrome-threshold" colorInterpolationFilters="sRGB">
            <feComponentTransfer>
              <feFuncA type="discrete" tableValues="0 1" />
            </feComponentTransfer>
          </filter>
        </defs>
      </svg>

      {/* Interactive Perspective Ruler Overlay Layer (Clip Studio Paint style) */}
      {perspectiveRuler && onUpdatePerspectiveRuler && (
        <PerspectiveRulerOverlay
          ruler={perspectiveRuler}
          onUpdateRuler={onUpdatePerspectiveRuler}
          onRemoveRuler={() => onUpdatePerspectiveRuler(null)}
          dimensions={dimensions}
          pan={livePan}
          zoom={liveZoom}
          rotation={liveRotation}
          flipX={liveFlipX}
          flipY={liveFlipY}
          navigation={navigation}
          viewportRef={viewportRef}
          activeLockedAxis={activeLockedAxis}
          isDrawing={isDrawing}
        />
      )}

      {/* Dynamic Dual-Tone Brush Silhouette Outline Cursor (CSP / Photoshop style) */}
      <div
        ref={cursorRingRef}
        className="pointer-events-none absolute top-0 left-0 z-30 select-none"
        style={{
          display: 'none',
          width: `${cursorWidth}px`,
          height: `${cursorHeight}px`,
          willChange: 'transform',
          transformOrigin: 'center center',
        }}
      >
        <svg
          viewBox={isCustomTip && tipOutline ? tipOutline.viewBox : '0 0 100 100'}
          className="w-full h-full overflow-visible pointer-events-none select-none"
          style={{ display: 'block' }}
        >
          {isCustomTip && tipOutline ? (
            <>
              <path
                d={tipOutline.path}
                fill="none"
                stroke="rgba(255, 255, 255, 0.85)"
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={tipOutline.path}
                fill="none"
                stroke="rgba(0, 0, 0, 0.85)"
                strokeWidth="1"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </>
          ) : isSquare ? (
            <>
              <rect
                x="1"
                y="1"
                width="98"
                height="98"
                fill="none"
                stroke="rgba(255, 255, 255, 0.85)"
                strokeWidth="2.5"
                vectorEffect="non-scaling-stroke"
              />
              <rect
                x="1"
                y="1"
                width="98"
                height="98"
                fill="none"
                stroke="rgba(0, 0, 0, 0.85)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </>
          ) : (
            <>
              <ellipse
                cx="50"
                cy="50"
                rx="49.5"
                ry="49.5"
                fill="none"
                stroke="rgba(255, 255, 255, 0.85)"
                strokeWidth="2.5"
                vectorEffect="non-scaling-stroke"
              />
              <ellipse
                cx="50"
                cy="50"
                rx="49.5"
                ry="49.5"
                fill="none"
                stroke="rgba(0, 0, 0, 0.85)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
        </svg>
      </div>

      {/* Floating Visual Preview for On-Canvas Brush Resizing (Ctrl + Alt + Drag) */}
      {isResizingBrush && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 z-50 flex items-center justify-center"
          style={{
            left: `${resizePreviewX}px`,
            top: `${resizePreviewY}px`,
            width: `${cursorWidth}px`,
            height: `${cursorHeight}px`,
            transform: `translate(-50%, -50%) rotate(${totalAngleDeg}deg)`,
            transformOrigin: 'center center',
          }}
        >
          {isCustomTip && tipOutline ? (
            <svg
              viewBox={tipOutline.viewBox}
              className="w-full h-full overflow-visible pointer-events-none"
              style={{ display: 'block' }}
            >
              <path
                d={tipOutline.path}
                fill="rgba(239, 68, 68, 0.35)"
                stroke="rgba(255, 255, 255, 0.95)"
                strokeWidth="2.5"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={tipOutline.path}
                fill="none"
                stroke="rgba(0, 0, 0, 0.9)"
                strokeWidth="1"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          ) : (
            <>
              {/* Outer diameter & hardness preview circle */}
              <div
                className={`w-full h-full ${isSquare ? 'rounded-none' : 'rounded-full'} border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.8),0_4px_16px_rgba(0,0,0,0.5)] transition-[width,height] duration-75`}
                style={{
                  background:
                    (brushSettings.hardness ?? 1.0) < 0.98
                      ? `radial-gradient(circle, rgba(239, 68, 68, 0.45) 0%, rgba(239, 68, 68, 0.45) ${Math.round(
                          (brushSettings.hardness ?? 1.0) * 100
                        )}%, rgba(239, 68, 68, 0.05) 100%)`
                      : 'rgba(239, 68, 68, 0.38)',
                }}
              />

              {/* Inner hardness boundary indicator if soft brush */}
              {(brushSettings.hardness ?? 1.0) < 0.98 && (
                <div
                  className={`absolute ${isSquare ? 'rounded-none' : 'rounded-full'} border border-dashed border-white/80 pointer-events-none`}
                  style={{
                    width: `${Math.max(2, cursorWidth * (brushSettings.hardness ?? 1.0))}px`,
                    height: `${Math.max(2, cursorHeight * (brushSettings.hardness ?? 1.0))}px`,
                  }}
                />
              )}
            </>
          )}

          {/* Floating HUD Tooltip Card */}
          <div
            className="absolute top-full mt-3 bg-[#202020] text-[#e5e5e5] px-3 py-1.5 rounded-md shadow-[0_8px_24px_rgba(0,0,0,0.65)] flex flex-col items-center pointer-events-none whitespace-nowrap min-w-36"
            style={{ zIndex: 60 }}
          >
            <div className="flex items-center gap-2 text-[11px] font-mono font-medium text-[#e5e5e5]">
              <span>Size {brushSettings.size}px</span>
              <span className="text-[#8a8a8a]">·</span>
              <span>Hard {Math.round((brushSettings.hardness ?? 1.0) * 100)}%</span>
            </div>
          </div>
        </div>
      )}

      {/* Floating Quick Palette Popover (triggered by modifier mapped to 'quick-palette') */}
      {quickPalettePos && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          className="absolute z-50 bg-[#202020] border border-white/10 rounded-md shadow-[0_12px_32px_rgba(0,0,0,0.75)] p-2.5 w-48 space-y-2 text-[11px] text-[#e5e5e5] select-none"
          style={{ left: `${quickPalettePos.x}px`, top: `${quickPalettePos.y}px` }}
        >
          <div className="flex items-center justify-between text-[10px] text-[#8a8a8a] uppercase tracking-wider">
            <span>Quick Palette</span>
            <button
              type="button"
              onClick={() => setQuickPalettePos(null)}
              className="hover:text-[#e5e5e5] cursor-pointer px-1"
            >
              ×
            </button>
          </div>
          <div className="grid grid-cols-6 gap-1">
            {useToolStore.getState().recentColors.slice(0, 12).map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => {
                  toolStoreActions.setPrimaryColor(hex);
                  setQuickPalettePos(null);
                }}
                className="w-6 h-6 rounded border border-white/15 cursor-pointer"
                style={{ backgroundColor: hex }}
                title={hex}
              />
            ))}
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] text-[#8a8a8a]">
              <span>Size</span>
              <span className="font-mono text-[#e5e5e5]">{brushSettings.size}px</span>
            </div>
            <input
              type="range"
              min="1"
              max="300"
              value={Math.round(brushSettings.size)}
              onChange={(e) => onUpdateBrushSettings({ size: Number(e.target.value) })}
              className="w-full"
            />
          </div>
          <div className="grid grid-cols-3 gap-1 pt-0.5">
            <button
              type="button"
              onClick={() => {
                onUndo?.();
                setQuickPalettePos(null);
              }}
              className="px-1.5 py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] cursor-pointer"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => {
                onRedo?.();
                setQuickPalettePos(null);
              }}
              className="px-1.5 py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] cursor-pointer"
            >
              Redo
            </button>
            <button
              type="button"
              onClick={() => {
                onFlipHorizontal?.();
                setQuickPalettePos(null);
              }}
              className="px-1.5 py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] cursor-pointer"
            >
              Flip H
            </button>
          </div>
        </div>
      )}

      {/* Floating Webtoon Mode Controls (only shown when Webtoon Mode is active) */}
      {isWebtoonMode && (
        <div className="absolute top-3 right-3 z-40 flex items-center gap-1.5 select-none">
          <button
            onClick={onToggleWebtoonMode}
            className="px-2.5 py-1 rounded-full text-[11px] font-medium flex items-center gap-1.5 bg-[#202020] hover:bg-[#2c2c2c] text-[#e5e5e5] shadow-lg transition-colors cursor-pointer"
            title="Exit Webtoon Studio Mode"
          >
            <Smartphone className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span>Exit Webtoon</span>
          </button>

          {onOpenWebtoonExport && (
            <button
              onClick={onOpenWebtoonExport}
              className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-[#202020] hover:bg-[#2c2c2c] text-[#e5e5e5] flex items-center gap-1.5 shadow-lg transition-colors cursor-pointer"
              title="Export Chapter Slices (.zip)"
            >
              <Archive className="w-3.5 h-3.5 text-[#8a8a8a]" />
              <span>Export Slices</span>
            </button>
          )}
        </div>
      )}

      {/* Subtle Zero-Height Canvas Coordinate / Pressure Readout (only shown if bottom StatusBar is hidden) */}
      {false && (showCursorCoordinates || showPressureInStatusBar) && (
        <div
          ref={pointerStatRef}
          className="pointer-events-none absolute bottom-2 right-3 z-30 text-[10px] font-mono text-[#8a8a8a]/70 select-none"
        />
      )}

      {/* Smartphone Viewport Simulator in Webtoon Mode */}
      {isWebtoonMode && (
        <SmartphoneViewportSimulator
          visible={true}
          onToggleVisible={onToggleWebtoonMode || (() => {})}
        />
      )}

      {/* 2D Frame-by-Frame Animation Timeline Scrubber Dock */}
      {animationTimeline && onUpdateAnimationTimeline && (
        <AnimationTimeline
          timeline={animationTimeline}
          onChangeTimeline={onUpdateAnimationTimeline}
          layers={layers}
          layerCanvasesMap={layerCanvasesRef?.current || new Map()}
          dimensions={dimensions}
          onAddCel={onAddAnimationCel || (() => {})}
          onDeleteCel={onDeleteAnimationCel || (() => {})}
          onSelectCelLayer={onSelectCelLayer}
        />
      )}
    </main>
  );
});

CanvasArea.displayName = 'CanvasArea';

