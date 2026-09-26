import React, { useState, useEffect, useRef } from 'react';
import {
  CanvasDimensions,
  BrushSettings,
  LayerItem,
  CanvasSelection,
  TransformSession,
  TextSettings,
  ToolType,
  LiquifySettings,
} from '../types/editor';
import { ROTATE_CURSOR_CSS } from '../hooks/useCanvasNavigation';
import { SelectionOverlay } from './SelectionOverlay';
import { TransformOverlay } from './TransformOverlay';
import { TextEditorOverlay } from './TextEditorOverlay';
import { PerspectiveRulerOverlay } from './PerspectiveRulerOverlay';
import { PerspectiveRuler, ConstraintAxis } from '../types/perspective';
import { Local3DContainer } from './Local3DContainer';

const PIPETTE_CURSOR_CSS = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cg stroke='%23000000' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round' fill='none'%3E%3Cpath d='m14 7 3 3'/%3E%3Cpath d='M16.6 5.6a2.12 2.12 0 0 1 3 3L7 20.6 2 22l1.4-5L16.6 5.6z'/%3E%3C/g%3E%3Cg stroke='%23ffffff' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' fill='none'%3E%3Cpath d='m14 7 3 3'/%3E%3Cpath d='M16.6 5.6a2.12 2.12 0 0 1 3 3L7 20.6 2 22l1.4-5L16.6 5.6z'/%3E%3C/g%3E%3C/svg%3E") 2 22, crosshair`;

interface CanvasAreaProps {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  dimensions: CanvasDimensions;
  brushSettings: BrushSettings;
  onUpdateBrushSettings: (newSettings: Partial<BrushSettings>) => void;
  zoom: number;
  pan: { x: number; y: number };
  rotation: number;
  isSpaceDown: boolean;
  isShiftDown: boolean;
  isRotateModifier: boolean;
  isPanning: boolean;
  isRotating: boolean;
  onStartPan: (e: React.PointerEvent) => void;
  onStartRotate: (e: React.PointerEvent) => void;
  isHovering: boolean;
  cursorPos: { x: number; y: number } | null;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  layers: LayerItem[];
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
}

export const CanvasArea: React.FC<CanvasAreaProps> = React.memo(({
  viewportRef,
  dimensions,
  brushSettings,
  onUpdateBrushSettings,
  zoom,
  pan,
  rotation,
  isSpaceDown,
  isRotateModifier,
  isPanning,
  isRotating,
  onStartPan,
  onStartRotate,
  isHovering: _isHovering,
  cursorPos: _cursorPos,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerEnter,
  onPointerLeave,
  layers,
  registerLayerCanvas,
  getEffectiveOpacity,
  isLayerEffectivelyVisible,
  interactionRef,
  showCheckerboard = true,
  hasOpenDocument = true,
  draftCanvasRef,
  strokeCanvasRef,
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
}) => {

  const effectiveDraftCanvasRef = draftCanvasRef || strokeCanvasRef;
  // Cursor preview diameter scaled to screen pixels
  const activeToolSize = tool === 'liquify' && liquifySettings ? liquifySettings.size : brushSettings.size;
  const cursorDiameter = Math.max(4, activeToolSize * zoom);

  // Dynamic on-canvas brush resizing via Ctrl + Alt + Drag
  const [isCtrlAltDown, setIsCtrlAltDown] = useState(false);
  const [isResizingBrush, setIsResizingBrush] = useState(false);
  const resizeOriginRef = useRef<{ clientX: number; clientY: number }>({ clientX: 0, clientY: 0 });
  const resizeStartSettingsRef = useRef<{ size: number; hardness: number }>({
    size: brushSettings.size,
    hardness: brushSettings.hardness ?? 1.0,
  });

  // Zero-latency direct DOM cursor preview ring
  const cursorRingRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let cachedRect: DOMRect | null = viewport.getBoundingClientRect();
    const updateRect = () => {
      if (viewport) cachedRect = viewport.getBoundingClientRect();
    };

    window.addEventListener('resize', updateRect);

    const handleWindowPointerMove = (e: PointerEvent) => {
      const ring = cursorRingRef.current;
      if (!ring) return;

      if (
        isSpaceDown ||
        isPanning ||
        isRotating ||
        isRotateModifier ||
        isResizingBrush ||
        (tool !== 'brush' && tool !== 'eraser' && tool !== 'liquify')
      ) {
        ring.style.display = 'none';
        return;
      }

      if (!cachedRect) updateRect();
      if (!cachedRect) return;

      const x = e.clientX - cachedRect.left;
      const y = e.clientY - cachedRect.top;

      if (x < 0 || x > cachedRect.width || y < 0 || y > cachedRect.height) {
        ring.style.display = 'none';
        return;
      }

      ring.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      if (ring.style.display !== 'block') {
        ring.style.display = 'block';
      }
    };

    const handlePointerLeave = () => {
      if (cursorRingRef.current) {
        cursorRingRef.current.style.display = 'none';
      }
    };

    viewport.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    viewport.addEventListener('pointerleave', handlePointerLeave, { passive: true });

    return () => {
      window.removeEventListener('resize', updateRect);
      viewport.removeEventListener('pointermove', handleWindowPointerMove);
      viewport.removeEventListener('pointerleave', handlePointerLeave);
    };
  }, [isSpaceDown, isPanning, isRotating, isRotateModifier, isResizingBrush, viewportRef]);

  // Synchronize draft overlay canvas resolution with the screen viewport
  useEffect(() => {
    const updateDraftCanvasSize = () => {
      const viewport = viewportRef.current;
      const draftCanvas = effectiveDraftCanvasRef?.current;
      if (!viewport || !draftCanvas) return;
      const rect = viewport.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.ceil(rect.width * dpr));
      const h = Math.max(1, Math.ceil(rect.height * dpr));
      if (draftCanvas.width !== w || draftCanvas.height !== h) {
        draftCanvas.width = w;
        draftCanvas.height = h;
      }
    };

    updateDraftCanvasSize();
    window.addEventListener('resize', updateDraftCanvasSize);
    return () => window.removeEventListener('resize', updateDraftCanvasSize);
  }, [viewportRef, effectiveDraftCanvasRef]);

  // Track Ctrl + Alt key combinations globally
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey) {
        setIsCtrlAltDown(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && e.altKey)) {
        setIsCtrlAltDown(false);
      }
    };

    const handleBlur = () => {
      setIsCtrlAltDown(false);
      setIsResizingBrush(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  // Handle active brush resizing window drag listeners
  useEffect(() => {
    if (!isResizingBrush) return;

    const handleWindowPointerMove = (e: PointerEvent) => {
      const dx = e.clientX - resizeOriginRef.current.clientX;
      const dy = resizeOriginRef.current.clientY - e.clientY;

      // Horizontal drag: adjusts size (1 to 250px)
      const newSize = Math.max(
        1,
        Math.min(250, Math.round(resizeStartSettingsRef.current.size + dx * 0.75))
      );

      // Vertical drag: adjusts hardness (0.0 to 1.0)
      const newHardness = Math.max(
        0.05,
        Math.min(
          1.0,
          Math.round((resizeStartSettingsRef.current.hardness + dy * 0.004) * 100) / 100
        )
      );

      onUpdateBrushSettings({ size: newSize, hardness: newHardness });
    };

    const handleWindowPointerUp = () => {
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
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [isResizingBrush, onUpdateBrushSettings]);

  // Viewport background pointer down (clicking gray area to pan or rotate)
  const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button === 1) {
      onStartPan(e);
      return;
    }
    if (e.button === 0) {
      if ((e.ctrlKey || e.metaKey) && e.altKey) {
        startBrushResize(e);
        return;
      }
      if (isRotateModifier) {
        onStartRotate(e);
      } else if (isSpaceDown) {
        onStartPan(e);
      }
    }
  };

  // Start brush resizing drag
  const startBrushResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizingBrush(true);
    resizeOriginRef.current = { clientX: e.clientX, clientY: e.clientY };
    resizeStartSettingsRef.current = {
      size: brushSettings.size,
      hardness: brushSettings.hardness ?? 1.0,
    };
  };

  // Canvas pointer down: check for resize, rotate, pan, or normal draw
  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button === 1) {
      onStartPan(e);
      return;
    }
    if (e.button === 0) {
      // Dynamic Brush Resizing shortcut: Ctrl + Alt + Left Click Drag
      if ((e.ctrlKey || e.metaKey) && e.altKey) {
        startBrushResize(e);
        return;
      }
      if (isRotateModifier) {
        onStartRotate(e);
        return;
      }
      if (isSpaceDown) {
        onStartPan(e);
        return;
      }
      e.preventDefault();
    }
    onPointerDown(e);
  };

  // Determine cursor based on active mode
  const getCursorStyle = (isOverCanvas: boolean): React.CSSProperties => {
    if (isResizingBrush || isCtrlAltDown) {
      return { cursor: 'ew-resize' };
    }
    if (isRotating || isRotateModifier) {
      return { cursor: ROTATE_CURSOR_CSS };
    }
    if (isPanning) {
      return { cursor: 'grabbing' };
    }
    if (isSpaceDown) {
      return { cursor: 'grab' };
    }
    if (tool === 'pipette') {
      return { cursor: PIPETTE_CURSOR_CSS };
    }
    if (tool === 'text') {
      return { cursor: 'text' };
    }
    if (tool === 'select-rect' || tool === 'select-lasso' || tool === 'fill' || tool === 'frame') {
      return { cursor: 'crosshair' };
    }
    if (tool === 'liquify') {
      return { cursor: 'crosshair' };
    }
    if (tool === 'transform') {
      return { cursor: 'default' };
    }
    return { cursor: isOverCanvas ? 'crosshair' : 'default' };
  };

  // Viewport bounds for positioning floating preview
  const viewportRect = viewportRef.current?.getBoundingClientRect();
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
        className="flex-1 bg-[#1e1e1e] overflow-hidden relative select-none"
      />
    );
  }

  // Render order: bottom-to-top (reverse of UI list)
  const renderOrderLayers = layers.slice().reverse();

  return (
    <main
      ref={viewportRef}
      onPointerDown={handleViewportPointerDown}
      className="flex-1 bg-[#282828] overflow-hidden relative select-none"
      style={{
        touchAction: 'none',
        ...getCursorStyle(false),
      }}
    >
      {/* Artboard Container with 2D Affine Transformation (Pan, Zoom, and Rotation) */}
      <div
        className="absolute origin-top-left select-none"
        style={{
          width: dimensions.width,
          height: dimensions.height,
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0) rotate(${rotation}deg) scale(${zoom}) translate3d(${-dimensions.width / 2}px, ${-dimensions.height / 2}px, 0)`,
          transformOrigin: '0 0',
          boxShadow: '0 0 0 1px #161616, 0 10px 40px rgba(0, 0, 0, 0.55)',
          willChange: 'transform',
          imageRendering: zoom > 1 ? 'pixelated' : 'auto',
          backgroundColor: '#1c1c1c',
          backgroundImage: showCheckerboard
            ? `conic-gradient(#282828 90deg, #202020 90deg 180deg, #282828 180deg 270deg, #202020 270deg)`
            : 'none',
          backgroundSize: '16px 16px',
        }}
      >
        {/* Layer Canvas Stack rendered from Bottom to Top */}
        {renderOrderLayers.map((layer) => {
          if (layer.type === 'folder') return null;

          return (
            <canvas
              key={layer.id}
              ref={(el) => registerLayerCanvas(layer.id, el)}
              width={dimensions.width}
              height={dimensions.height}
              className="absolute inset-0 block pointer-events-none"
              style={{
                opacity: getEffectiveOpacity(layer),
                mixBlendMode: layer.blendMode,
                display: isLayerEffectivelyVisible(layer) ? 'block' : 'none',
                imageRendering: zoom > 1 ? 'pixelated' : 'auto',
              }}
            />
          );
        })}

        {/* Remote Peer Draft Canvases (rendered per active peer while peer is drawing) */}
        {peers.map((peer) => (
          <canvas
            key={`peer-canvas-${peer.id}`}
            ref={(el) => {
              if (remoteDraftCanvasesRef) {
                if (el) {
                  remoteDraftCanvasesRef.current.set(peer.id, el);
                } else {
                  remoteDraftCanvasesRef.current.delete(peer.id);
                }
              }
            }}
            width={dimensions.width}
            height={dimensions.height}
            className="absolute inset-0 block pointer-events-none z-15"
            style={{
              imageRendering: zoom > 1 ? 'pixelated' : 'auto',
            }}
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
                style={{ backgroundColor: peer.color }}
              >
                <span>{peer.name}</span>
                {peer.isDrawing && <span className="text-[9px]">✏️</span>}
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
              style={{ backgroundColor: ping.color }}
            >
              {ping.name} 📍
            </div>
          </div>
        ))}

        {/* Selection Overlay */}
        {selection && (
          <SelectionOverlay
            selection={selection}
            dimensions={dimensions}
            zoom={zoom}
            onDeselect={onDeselect || (() => {})}
            onTransformSelection={onTransformSelection || (() => {})}
            onFillScreentone={onFillScreentone || (() => {})}
            onFillColor={onFillColor || (() => {})}
            onClearSelection={onClearSelection || (() => {})}
            onInvertSelection={onInvertSelection || (() => {})}
          />
        )}

        {/* Free Transform Overlay */}
        {transformSession?.active && (
          <TransformOverlay
            session={transformSession}
            zoom={zoom}
            rotation={rotation}
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
            zoom={zoom}
            onUpdateSettings={onUpdateTextSettings || (() => {})}
            onMove={onMoveTextSession || (() => {})}
            onConfirm={onConfirmText || (() => {})}
            onCancel={onCancelText || (() => {})}
          />
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
          />
        )}

        {/* Top Transparent Interaction Surface capturing Stylus / Mouse Pointer Events */}

        <div
          ref={interactionRef}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          className="absolute inset-0 block touch-none z-20"
          style={{
            ...getCursorStyle(true),
          }}
        />
      </div>

      {/* Active Draft/Stroke Overlay Canvas matching the Screen Viewport (Clip Studio Paint style) */}
      <canvas
        ref={effectiveDraftCanvasRef}
        className="absolute inset-0 pointer-events-none z-25"
        style={{
          width: '100%',
          height: '100%',
          opacity: brushSettings.opacity ?? 1.0,
          display: 'block',
        }}
      />

      {/* Interactive Perspective Ruler Overlay Layer (Clip Studio Paint style) */}
      {perspectiveRuler && onUpdatePerspectiveRuler && (
        <PerspectiveRulerOverlay
          ruler={perspectiveRuler}
          onUpdateRuler={onUpdatePerspectiveRuler}
          onRemoveRuler={() => onUpdatePerspectiveRuler(null)}
          dimensions={dimensions}
          pan={pan}
          zoom={zoom}
          rotation={rotation}
          viewportRef={viewportRef}
          activeLockedAxis={activeLockedAxis}
          isDrawing={isDrawing}
        />
      )}

      {/* Dynamic Dual-Tone Brush Size Outline Ring (CSP / Photoshop style) */}
      <div
        ref={cursorRingRef}
        className="pointer-events-none absolute top-0 left-0 rounded-full z-30 select-none"
        style={{
          display: 'none',
          width: `${cursorDiameter}px`,
          height: `${cursorDiameter}px`,
          border: '1px solid rgba(0, 0, 0, 0.75)',
          boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.75)',
          willChange: 'transform',
        }}
      />

      {/* Floating Visual Preview Circle for On-Canvas Brush Resizing (Ctrl + Alt + Drag) */}
      {isResizingBrush && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 z-50 flex items-center justify-center"
          style={{
            left: `${resizePreviewX}px`,
            top: `${resizePreviewY}px`,
            width: `${cursorDiameter}px`,
            height: `${cursorDiameter}px`,
          }}
        >
          {/* Outer diameter & hardness preview circle */}
          <div
            className="w-full h-full rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.8),0_4px_16px_rgba(0,0,0,0.5)] transition-[width,height] duration-75"
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
              className="absolute rounded-full border border-dashed border-white/80 pointer-events-none"
              style={{
                width: `${Math.max(2, cursorDiameter * (brushSettings.hardness ?? 1.0))}px`,
                height: `${Math.max(2, cursorDiameter * (brushSettings.hardness ?? 1.0))}px`,
              }}
            />
          )}

          {/* Anchor center crosshair */}
          <div className="absolute w-2 h-2 rounded-full bg-white border border-black pointer-events-none shadow-sm" />

          {/* Floating HUD Tooltip Card */}
          <div
            className="absolute top-full mt-3 bg-[#1e1e1e]/95 backdrop-blur border border-[#444444] text-[#cccccc] px-3.5 py-1.5 rounded-[3px] shadow-2xl flex flex-col items-center pointer-events-none whitespace-nowrap min-w-36"
            style={{ zIndex: 60 }}
          >
            <div className="flex items-center space-x-2.5 text-xs font-mono font-semibold text-white">
              <span className="text-emerald-400">Size: {brushSettings.size}px</span>
              <span className="text-[#555555]">|</span>
              <span className="text-amber-300">
                Hardness: {Math.round((brushSettings.hardness ?? 1.0) * 100)}%
              </span>
            </div>
            <div className="text-[10px] text-[#888888] mt-0.5 font-sans">
              ↔ Drag horizontal: Size • ↕ Vertical: Hardness
            </div>
          </div>
        </div>
      )}
    </main>
  );
});

CanvasArea.displayName = 'CanvasArea';

