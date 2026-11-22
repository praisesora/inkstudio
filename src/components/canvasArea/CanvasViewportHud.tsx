import React from 'react';
import { Smartphone, Archive } from 'lucide-react';
import { TipOutline } from '../../utils/brushOutline';
import { toolStoreActions, useToolStore } from '../../stores';
import { StraightRulerOverlay } from '../StraightRulerOverlay';
import { PerspectiveRulerOverlay } from '../PerspectiveRulerOverlay';
import { SmartphoneViewportSimulator } from '../SmartphoneViewportSimulator';
import { AnimationTimeline } from '../AnimationTimeline';
import { CanvasAreaProps } from './types';

export interface CanvasViewportHudProps {
  canvasProps: CanvasAreaProps;
  cursorRingRef: React.RefObject<HTMLDivElement | null>;
  pointerStatRef: React.RefObject<HTMLDivElement | null>;
  livePan: { x: number; y: number };
  liveZoom: number;
  liveRotation: number;
  liveFlipX: boolean;
  liveFlipY: boolean;
  cursorWidth: number;
  cursorHeight: number;
  totalAngleDeg: number;
  isCustomTip: boolean;
  isSquare: boolean;
  tipOutline: TipOutline | null;
  isResizingBrush: boolean;
  resizePreviewX: number;
  resizePreviewY: number;
  quickPalettePos: { x: number; y: number } | null;
  setQuickPalettePos: React.Dispatch<React.SetStateAction<{ x: number; y: number } | null>>;
}

export const CanvasViewportHud: React.FC<CanvasViewportHudProps> = ({
  canvasProps,
  cursorRingRef,
  pointerStatRef,
  livePan,
  liveZoom,
  liveRotation,
  liveFlipX,
  liveFlipY,
  cursorWidth,
  cursorHeight,
  totalAngleDeg,
  isCustomTip,
  isSquare,
  tipOutline,
  isResizingBrush,
  resizePreviewX,
  resizePreviewY,
  quickPalettePos,
  setQuickPalettePos,
}) => {
  const {
    viewportRef,
    dimensions,
    navigation,
    straightRuler = null,
    onUpdateStraightRuler,
    perspectiveRuler = null,
    onUpdatePerspectiveRuler,
    activeLockedAxis = null,
    isDrawing = false,
    brushSettings,
    onUpdateBrushSettings,
    onUndo,
    onRedo,
    onFlipHorizontal,
    isWebtoonMode = false,
    onToggleWebtoonMode,
    onOpenWebtoonExport,
    showCursorCoordinates = false,
    showPressureInStatusBar = false,
    animationTimeline = null,
    onUpdateAnimationTimeline,
    layers,
    tileGrid,
    onAddAnimationCel,
    onDeleteAnimationCel,
    onSelectCelLayer,
    isExternalFileDropActive = false,
  } = canvasProps;

  return (
    <>
      {/* Interactive Straight Ruler Overlay */}
      {straightRuler && straightRuler.enabled && onUpdateStraightRuler && (
        <StraightRulerOverlay
          ruler={straightRuler}
          onUpdateRuler={onUpdateStraightRuler}
          onCloseRuler={() => onUpdateStraightRuler({ ...straightRuler, enabled: false })}
          dimensions={dimensions}
          pan={livePan}
          zoom={liveZoom}
          rotation={liveRotation}
          flipX={liveFlipX}
          flipY={liveFlipY}
          navigation={navigation}
          viewportRef={viewportRef}
        />
      )}

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
          tileGrid={tileGrid}
          dimensions={dimensions}
          onAddCel={onAddAnimationCel || (() => {})}
          onDeleteCel={onDeleteAnimationCel || (() => {})}
          onSelectCelLayer={onSelectCelLayer}
        />
      )}

      {isExternalFileDropActive && (
        <div
          data-testid="canvas-file-drop-overlay"
          className="pointer-events-none absolute inset-2 z-50 rounded-md border-2 border-dashed border-[var(--accent)] bg-[var(--accent)]/8 flex items-center justify-center"
        >
          <div className="px-3.5 py-2 rounded-md bg-[#161616]/95 border border-[var(--accent)]/60 text-xs font-medium text-[#f5f5f5] shadow-xl">
            Drop image to import as layer
          </div>
        </div>
      )}
    </>
  );
};
