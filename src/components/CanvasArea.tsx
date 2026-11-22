import React, { useState, useRef } from 'react';
import { globalTileGrid } from '../utils/tileEngine';
import { FloatingBrushPill } from './FloatingBrushPill';
import { ModifierAction } from '../types/settings';
import {
  CanvasAreaProps,
  extractCoalescedEvents,
  getCursorStyle,
} from './canvasArea/types';
import { useCanvasEffects } from './canvasArea/useCanvasEffects';
import { useCompositorViewport } from './canvasArea/useCompositorViewport';
import { useCanvasPointerHandlers } from './canvasArea/useCanvasPointerHandlers';
import { CanvasArtboardOverlays } from './canvasArea/CanvasArtboardOverlays';
import { CanvasViewportHud } from './canvasArea/CanvasViewportHud';

export { extractCoalescedEvents };

export const CanvasArea: React.FC<CanvasAreaProps> = React.memo((props) => {
  const {
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
    onPointerDown,
    onPointerMove,
    onPointerUp,
    layers,
    showCheckerboard = true,
    hasOpenDocument = true,
    draftCanvasRef,
    strokeCanvasRef,
    predictedCanvasRef,
    tool = 'brush',
    liquifySettings,
    onUpdateLiquifySettings,
    primaryColor = '#000000',
    onSwapColors,
    showCursorCoordinates = false,
    showPressureInStatusBar = false,
    animationTimeline = null,
    softProofSettings,
    activeLayerId,
    colorMode = 'color',
    tileGrid = globalTileGrid,
  } = props;

  const effectiveDraftCanvasRef = draftCanvasRef || strokeCanvasRef;
  const localPredictedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const effectivePredictedCanvasRef = predictedCanvasRef || localPredictedCanvasRef;

  const activeLayer = layers.find((l) => l.id === activeLayerId);
  const isMonochromeActive = colorMode === 'monochrome' || activeLayer?.expressionColor === 'monochrome' || brushSettings.antiAlias === 0;

  // Dynamic cursor dimensions according to brush tip shape, aspect ratio, and thickness
  const liveCamera = navigation
    ? navigation.getCameraState()
    : { pan, zoom, rotation, flipX, flipY };
  const liveZoom = liveCamera.zoom;
  const livePan = liveCamera.pan;
  const liveRotation = liveCamera.rotation;
  const liveFlipX = liveCamera.flipX;
  const liveFlipY = liveCamera.flipY;

  // Dynamic on-canvas brush resizing via configured modifier (default Ctrl + Alt + Drag or Shift + Alt + Drag)
  const [heldModifierAction, setHeldModifierAction] = useState<ModifierAction>('none');
  const [isResizingBrush, setIsResizingBrush] = useState(false);
  const [quickPalettePos, setQuickPalettePos] = useState<{ x: number; y: number } | null>(null);
  const resizeOriginRef = useRef<{ clientX: number; clientY: number }>({ clientX: 0, clientY: 0 });
  const resizeStartSettingsRef = useRef<{ size: number; hardness: number }>({
    size: brushSettings.size,
    hardness: brushSettings.hardness ?? 1.0,
  });

  const artboardRef = useRef<HTMLDivElement | null>(null);

  const {
    tipOutline,
    isCustomTip,
    isSquare,
    cursorWidth,
    cursorHeight,
    totalAngleDeg,
    cursorConfigRef,
    lastPointerPosRef,
    cursorRingRef,
    pointerStatRef,
  } = useCanvasEffects({
    viewportRef,
    brushSettings,
    onUpdateBrushSettings,
    liquifySettings,
    onUpdateLiquifySettings,
    tool,
    liveZoom,
    liveRotation,
    liveFlipX,
    liveFlipY,
    isSpaceDown,
    isPanning,
    isRotating,
    isZoomDragging,
    isRotateModifier,
    hasOpenDocument,
    showCursorCoordinates,
    showPressureInStatusBar,
    heldModifierAction,
    setHeldModifierAction,
    isResizingBrush,
    setIsResizingBrush,
    quickPalettePos,
    setQuickPalettePos,
    resizeOriginRef,
    resizeStartSettingsRef,
  });

  const { viewportCanvasRef } = useCompositorViewport({
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
    brushOpacity: brushSettings.opacity,
    colorMode,
    tileGrid,
  });

  const {
    handleViewportPointerDown,
    handleCanvasPointerDown,
    handleCanvasPointerMove,
    handleCanvasPointerUp,
    handleCanvasPointerCancel,
    handleContextMenu,
  } = useCanvasPointerHandlers({
    viewportRef,
    dimensions,
    brushSettings,
    liquifySettings,
    tool,
    navigation,
    pan,
    zoom,
    rotation,
    flipX,
    flipY,
    isSpaceDown,
    quickPalettePos,
    setQuickPalettePos,
    setIsResizingBrush,
    resizeOriginRef,
    resizeStartSettingsRef,
    onStartPan,
    onStartRotate,
    onStartZoomDrag,
    onSampleColor,
    onUndo,
    onSwapColors,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  });

  const cursorStyleBase = {
    isResizingBrush,
    heldModifierAction,
    isZoomDragging,
    isRotating,
    isRotateModifier,
    isPanning,
    isSpaceDown,
    tool,
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
      data-drop-zone="canvas"
      onPointerDown={handleViewportPointerDown}
      onContextMenu={handleContextMenu}
      className="flex-1 bg-[#161616] overflow-hidden relative select-none canvas-viewport"
      style={{
        touchAction: 'none',
        ...getCursorStyle({ ...cursorStyleBase, isOverCanvas: false }),
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
      <CanvasArtboardOverlays
        canvasProps={props}
        artboardRef={artboardRef}
        livePan={livePan}
        liveZoom={liveZoom}
        liveRotation={liveRotation}
        liveFlipX={liveFlipX}
        liveFlipY={liveFlipY}
        handleCanvasPointerDown={handleCanvasPointerDown}
        handleCanvasPointerMove={handleCanvasPointerMove}
        handleCanvasPointerUp={handleCanvasPointerUp}
        handleCanvasPointerCancel={handleCanvasPointerCancel}
        handleContextMenu={handleContextMenu}
        canvasCursorStyle={getCursorStyle({ ...cursorStyleBase, isOverCanvas: true })}
      />

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

      {/* Viewport-Space Overlays & HUD */}
      <CanvasViewportHud
        canvasProps={props}
        cursorRingRef={cursorRingRef}
        pointerStatRef={pointerStatRef}
        livePan={livePan}
        liveZoom={liveZoom}
        liveRotation={liveRotation}
        liveFlipX={liveFlipX}
        liveFlipY={liveFlipY}
        cursorWidth={cursorWidth}
        cursorHeight={cursorHeight}
        totalAngleDeg={totalAngleDeg}
        isCustomTip={isCustomTip}
        isSquare={isSquare}
        tipOutline={tipOutline}
        isResizingBrush={isResizingBrush}
        resizePreviewX={resizePreviewX}
        resizePreviewY={resizePreviewY}
        quickPalettePos={quickPalettePos}
        setQuickPalettePos={setQuickPalettePos}
      />
    </main>
  );
});

CanvasArea.displayName = 'CanvasArea';
