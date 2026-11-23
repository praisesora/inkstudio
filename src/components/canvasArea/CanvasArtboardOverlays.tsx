import React from 'react';
import { buildShapeSvgPaths, isOpenShape, resolveShapeFillColor } from '../../utils/shapeEngine';
import { SelectionOverlay } from '../SelectionOverlay';
import { TransformOverlay } from '../TransformOverlay';
import { TextEditorOverlay } from '../TextEditorOverlay';
import { SpeechBalloonOverlay } from '../SpeechBalloonOverlay';
import { Local3DContainer } from '../Local3DContainer';
import { GradientOverlay } from '../GradientOverlay';
import { PenPathOverlay } from '../PenPathOverlay';
import { CanvasAreaProps, formatArtboardTransform } from './types';

export interface CanvasArtboardOverlaysProps {
  canvasProps: CanvasAreaProps;
  artboardRef: React.RefObject<HTMLDivElement | null>;
  livePan: { x: number; y: number };
  liveZoom: number;
  liveRotation: number;
  liveFlipX: boolean;
  liveFlipY: boolean;
  handleCanvasPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  handleCanvasPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  handleCanvasPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  handleCanvasPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
  handleContextMenu: (e: React.MouseEvent<HTMLElement>) => void;
  canvasCursorStyle: React.CSSProperties;
}

export const CanvasArtboardOverlays: React.FC<CanvasArtboardOverlaysProps> = ({
  canvasProps,
  artboardRef,
  livePan,
  liveZoom,
  liveRotation,
  liveFlipX,
  liveFlipY,
  handleCanvasPointerDown,
  handleCanvasPointerMove,
  handleCanvasPointerUp,
  handleCanvasPointerCancel,
  handleContextMenu,
  canvasCursorStyle,
}) => {
  const {
    interactionRef,
    dimensions,
    zoom,
    peers = [],
    activePings = [],
    remoteDraftCanvasesRef,
    selection = null,
    onDeselect,
    onTransformSelection,
    onFillScreentone,
    onFillColor,
    onClearSelection,
    onDeleteOutsideSelection,
    onCutSelection,
    onCopySelection,
    onPasteSelection,
    onMoveSelectionToNewLayer,
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
    activeBalloon = null,
    onUpdateBalloon,
    onConfirmBalloon,
    onDeleteBalloon,
    frameDragPreview = null,
    shapeDragPreview = null,
    gradientDragPreview = null,
    gradientMesh = null,
    gradientSettings,
    onApplyGradientMesh,
    onCancelGradientMesh,
    retouchSettings,
    cloneSourceIndicator = null,
    penSession = null,
    penSettings,
    onCommitPenPath,
    onCancelPenPath,
    onToggleClosePenPath,
    tool = 'brush',
    primaryColor = '#000000',
    secondaryColor = '#ffffff',
    is3DLayerOpen = false,
    initial3DFile = null,
    onClose3DLayer,
    onInsertRasterLayer,
    onBake3DSuccess,
    perspectiveRuler = null,
    onUpdatePerspectiveRuler,
    onPointerEnter,
    onPointerLeave,
  } = canvasProps;

  return (
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
          onDeleteOutsideSelection={onDeleteOutsideSelection}
          onCutSelection={onCutSelection}
          onCopySelection={onCopySelection}
          onPasteSelection={onPasteSelection}
          onMoveSelectionToNewLayer={onMoveSelectionToNewLayer}
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

      {/* Live Geometric Shape Placement Preview */}
      {shapeDragPreview && (() => {
        const { geom, mainPath, arrowHeadPath } = buildShapeSvgPaths(shapeDragPreview);
        const s = shapeDragPreview.settings;
        const open = isOpenShape(s.shape);
        const strokeColor = primaryColor || '#000000';
        const fillColor = resolveShapeFillColor(s, strokeColor, secondaryColor);
        const shouldFill = !open && (s.mode === 'fill' || s.mode === 'both');
        const shouldStroke = open || s.mode === 'stroke' || s.mode === 'both';
        const dashArray = s.dashed ? `${Math.max(1, s.dashLength)} ${Math.max(1, s.dashGap)}` : undefined;
        const invZoom = 1 / Math.max(0.05, liveZoom);
        const readoutText = open
          ? `${Math.round(geom.length)}px · ${Math.round(geom.angleDeg)}°`
          : `${Math.round(geom.width)} × ${Math.round(geom.height)}px`;
        return (
          <>
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none z-30 overflow-visible"
              viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
            >
              {mainPath && (
                <path
                  d={mainPath}
                  fill={shouldFill ? fillColor : 'none'}
                  stroke={shouldStroke ? strokeColor : 'none'}
                  strokeWidth={Math.max(1, s.strokeWidth)}
                  strokeLinecap={s.lineCap}
                  strokeLinejoin={s.lineJoin}
                  strokeDasharray={dashArray}
                  opacity={Math.max(0.05, Math.min(1, s.opacity))}
                />
              )}
              {arrowHeadPath && (
                <path
                  d={arrowHeadPath}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={Math.max(1, s.strokeWidth)}
                  strokeLinecap={s.lineCap}
                  strokeLinejoin={s.lineJoin}
                  opacity={Math.max(0.05, Math.min(1, s.opacity))}
                />
              )}
              {!open && geom.width > 1 && geom.height > 1 && (
                <rect
                  x={geom.x}
                  y={geom.y}
                  width={geom.width}
                  height={geom.height}
                  fill="none"
                  stroke="#e5e5e5"
                  strokeOpacity={0.55}
                  strokeWidth={1 * invZoom}
                  strokeDasharray={`${4 * invZoom} ${3 * invZoom}`}
                />
              )}
            </svg>
            <div
              className="absolute pointer-events-none z-30 px-1.5 py-0.5 rounded bg-[#161616]/90 border border-white/15 text-[#e5e5e5] font-mono text-[10px] whitespace-nowrap"
              style={{
                left: `${geom.x2}px`,
                top: `${geom.y2}px`,
                transform: `translate(${10 * invZoom}px, ${10 * invZoom}px) scale(${invZoom})`,
                transformOrigin: 'top left',
              }}
            >
              {readoutText}
            </div>
          </>
        );
      })()}

      {/* Live Gradient Guide & Interactive Mesh Gradient Overlay */}
      {(gradientDragPreview || gradientMesh) && (
        <GradientOverlay
          dimensions={dimensions}
          zoom={liveZoom}
          flipX={liveFlipX}
          flipY={liveFlipY}
          dragPreview={gradientDragPreview}
          mesh={gradientMesh}
          opacity={gradientSettings?.opacity ?? 1}
          onApplyMesh={onApplyGradientMesh}
          onCancelMesh={onCancelGradientMesh}
        />
      )}

      {/* Clone Stamp Source Anchor & Live Sample Crosshair */}
      {tool === 'retouch' &&
        retouchSettings?.mode === 'clone-stamp' &&
        cloneSourceIndicator &&
        cloneSourceIndicator.anchor.x > -9000 && (() => {
          const invZoom = 1 / Math.max(0.05, liveZoom);
          const pt = cloneSourceIndicator.liveSamplePos || cloneSourceIndicator.anchor;
          const r = Math.max(6 * invZoom, (retouchSettings.size * 0.5));
          return (
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none z-35 overflow-visible"
              viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
            >
              <circle
                cx={pt.x}
                cy={pt.y}
                r={r}
                fill="none"
                stroke="#ffffff"
                strokeOpacity={0.75}
                strokeWidth={1.2 * invZoom}
                strokeDasharray={`${4 * invZoom} ${3 * invZoom}`}
              />
              <line
                x1={pt.x - 8 * invZoom}
                y1={pt.y}
                x2={pt.x + 8 * invZoom}
                y2={pt.y}
                stroke="#38bdf8"
                strokeWidth={1.6 * invZoom}
              />
              <line
                x1={pt.x}
                y1={pt.y - 8 * invZoom}
                x2={pt.x}
                y2={pt.y + 8 * invZoom}
                stroke="#38bdf8"
                strokeWidth={1.6 * invZoom}
              />
            </svg>
          );
        })()}

      {/* True Cubic Bézier Pen Tool Interactive Overlay */}
      {penSession && penSettings && (
        <PenPathOverlay
          dimensions={dimensions}
          zoom={liveZoom}
          flipX={liveFlipX}
          flipY={liveFlipY}
          session={penSession}
          settings={penSettings}
          primaryColor={primaryColor}
          secondaryColor={secondaryColor}
          onCommit={onCommitPenPath}
          onCancel={onCancelPenPath}
          onToggleClose={onToggleClosePenPath}
        />
      )}

      {/* Local-Only 3D Viewport Reference Stage (Interactive with 3D Tool, Pass-Through with 2D Tools) */}
      {is3DLayerOpen && onClose3DLayer && onInsertRasterLayer && (
        <Local3DContainer
          dimensions={dimensions}
          viewportRef={canvasProps.viewportRef}
          navigation={canvasProps.navigation}
          zoom={liveZoom}
          pan={livePan}
          rotation={liveRotation}
          flipX={liveFlipX}
          flipY={liveFlipY}
          activeTool={tool}
          isSpaceDown={canvasProps.isSpaceDown}
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
        onPointerCancel={handleCanvasPointerCancel}
        onLostPointerCapture={handleCanvasPointerCancel}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onContextMenu={handleContextMenu}
        className="absolute inset-0 block touch-none z-20"
        style={{
          ...canvasCursorStyle,
        }}
      />
    </div>
  );
};
