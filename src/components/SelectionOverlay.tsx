import React, { useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  CanvasSelection,
  CanvasDimensions,
} from '../types/editor';
import {
  X,
  Trash2,
  RotateCcw,
  Scissors,
  Copy,
  ClipboardPaste,
  Layers,
  Crop,
  Maximize2,
  Minimize2,
  Feather,
} from 'lucide-react';
import { maskToSvgPath } from '../utils/selectionUtils';

interface SelectionOverlayProps {
  selection: CanvasSelection | null;
  dimensions: CanvasDimensions;
  zoom: number;
  flipX?: boolean;
  flipY?: boolean;
  onDeselect: () => void;
  onTransformSelection: () => void;
  onFillScreentone: () => void;
  onFillColor: () => void;
  onClearSelection: () => void;
  onDeleteOutsideSelection?: () => void;
  onCutSelection?: () => void;
  onCopySelection?: () => void;
  onPasteSelection?: () => void;
  onMoveSelectionToNewLayer?: () => void;
  onInvertSelection: () => void;
  onExpandSelection?: (pixels: number) => void;
  onContractSelection?: (pixels: number) => void;
  onFeatherSelection?: (radius: number) => void;
}

export const SelectionOverlay: React.FC<SelectionOverlayProps> = ({
  selection,
  dimensions,
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
}) => {
  const floatingCanvasContainerRef = useRef<HTMLDivElement>(null);

  // Synchronize floating canvas DOM node
  useEffect(() => {
    const container = floatingCanvasContainerRef.current;
    if (!container) return;
    container.innerHTML = '';
    if (selection?.floating?.canvas) {
      container.appendChild(selection.floating.canvas);
    }
  }, [selection?.floating?.canvas]);

  const { bounds, type, polygon, floating, mask, maskWidth, maskHeight, svgPath } = selection || {};

  // Build SVG path for marching ants
  const pathD = useMemo(() => {
    if (!selection) return '';
    if (svgPath) return svgPath;
    if (mask) {
      const mw = maskWidth || dimensions.width;
      const mh = maskHeight || dimensions.height;
      return maskToSvgPath(mask, mw, mh);
    }
    if (type === 'rect' && bounds) {
      return `M ${bounds.x} ${bounds.y} H ${bounds.x + bounds.width} V ${bounds.y + bounds.height} H ${bounds.x} Z`;
    }
    if (type === 'lasso' && polygon && polygon.length > 2) {
      return `M ${polygon[0].x} ${polygon[0].y} ` + polygon.slice(1).map((p) => `L ${p.x} ${p.y}`).join(' ') + ' Z';
    }
    return '';
  }, [selection, svgPath, mask, maskWidth, maskHeight, type, bounds, polygon, dimensions.width, dimensions.height]);

  if (!selection || !bounds) return null;

  return (
    <>
      {/* 1. Floating Selected Pixels Canvas */}
      {floating && (
        <div
          ref={floatingCanvasContainerRef}
          className="absolute pointer-events-none z-22"
          style={{
            left: `${floating.x}px`,
            top: `${floating.y}px`,
            width: `${floating.canvas.width}px`,
            height: `${floating.canvas.height}px`,
          }}
        />
      )}

      {/* 2. Marching Ants Selection Border SVG */}
      <svg
        className="absolute inset-0 pointer-events-none z-24 overflow-visible"
        width={dimensions.width}
        height={dimensions.height}
        viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
      >
        <defs>
          <style>
            {`
              @keyframes marchingAnts {
                from { stroke-dashoffset: 0; }
                to { stroke-dashoffset: 16; }
              }
              .marching-ants-black {
                stroke: #000000;
                stroke-width: 1.5;
                fill: rgba(92, 225, 230, 0.12);
              }
              .marching-ants-white {
                stroke: #ffffff;
                stroke-width: 1.5;
                stroke-dasharray: 4 4;
                animation: marchingAnts 1s linear infinite;
              }
            `}
          </style>
        </defs>

        {pathD && (
          <>
            <path d={pathD} className="marching-ants-black" />
            <path d={pathD} className="marching-ants-white" fill="none" />
          </>
        )}
      </svg>

      {/* 3. Unified Selection Action Bar (Single viewport-anchored launcher) */}
      {createPortal(
        <div
          className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 max-w-[95vw] bg-[#202020]/95 backdrop-blur-md border border-white/[0.1] rounded-md shadow-2xl px-2 py-1 flex flex-wrap items-center justify-center gap-1 select-none text-[11px] text-[#e5e5e5]"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={onDeselect}
            title="Deselect (Ctrl+D)"
            className="px-1.5 py-1 text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded flex items-center gap-1 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            <span>Deselect</span>
          </button>

          <button
            type="button"
            onClick={onInvertSelection}
            title="Invert Selection (Ctrl+Shift+I)"
            className="px-1.5 py-1 text-[#cccccc] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded flex items-center gap-1 transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Invert</span>
          </button>

          <button
            type="button"
            onClick={() => onExpandSelection?.(5)}
            title="Expand Selection (+5px)"
            className="p-1 text-[#cccccc] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onContractSelection?.(5)}
            title="Contract Selection (-5px)"
            className="p-1 text-[#cccccc] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onFeatherSelection?.(5)}
            title="Feather Selection (5px)"
            className="p-1 text-[#cccccc] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
          >
            <Feather className="w-3.5 h-3.5" />
          </button>

          <div className="w-px h-4 bg-white/[0.08]" />

          {onCutSelection && (
            <button
              type="button"
              onClick={onCutSelection}
              title="Cut Selection (Ctrl+X)"
              className="px-1.5 py-1 text-[#e5e5e5] hover:bg-[#2c2c2c] rounded flex items-center gap-1 transition-colors cursor-pointer"
            >
              <Scissors className="w-3.5 h-3.5" />
              <span>Cut</span>
            </button>
          )}

          {onCopySelection && (
            <button
              type="button"
              onClick={onCopySelection}
              title="Copy Selection (Ctrl+C)"
              className="px-1.5 py-1 text-[#e5e5e5] hover:bg-[#2c2c2c] rounded flex items-center gap-1 transition-colors cursor-pointer"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>Copy</span>
            </button>
          )}

          {onPasteSelection && (
            <button
              type="button"
              onClick={onPasteSelection}
              title="Paste to New Layer (Ctrl+V)"
              className="px-1.5 py-1 text-[#e5e5e5] hover:bg-[#2c2c2c] rounded flex items-center gap-1 transition-colors cursor-pointer"
            >
              <ClipboardPaste className="w-3.5 h-3.5" />
              <span>Paste</span>
            </button>
          )}

          {onMoveSelectionToNewLayer && (
            <button
              type="button"
              onClick={onMoveSelectionToNewLayer}
              title="Move Selected Section to New Layer (Ctrl+Shift+J)"
              className="px-1.5 py-1 text-[var(--accent)] hover:bg-[#2c2c2c] rounded flex items-center gap-1 font-medium transition-colors cursor-pointer"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>To Layer</span>
            </button>
          )}

          <div className="w-px h-4 bg-white/[0.08]" />

          <button
            type="button"
            onClick={onClearSelection}
            title="Delete Selected Section (Del)"
            className="px-1.5 py-1 text-[#cccccc] hover:text-rose-400 hover:bg-[#2c2c2c] rounded flex items-center gap-1 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Delete</span>
          </button>

          {onDeleteOutsideSelection && (
            <button
              type="button"
              onClick={onDeleteOutsideSelection}
              title="Delete Outside Selected Section"
              className="px-1.5 py-1 text-[#cccccc] hover:text-rose-400 hover:bg-[#2c2c2c] rounded flex items-center gap-1 transition-colors cursor-pointer"
            >
              <Crop className="w-3.5 h-3.5" />
              <span>Del Outside</span>
            </button>
          )}

          <div className="w-px h-4 bg-white/[0.08]" />

          <button
            type="button"
            onClick={onFillColor}
            title="Fill with Foreground Color"
            className="px-2 py-1 text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
          >
            Fill
          </button>

          <button
            type="button"
            onClick={onFillScreentone}
            title="Fill Screentone into New Layer"
            className="px-2 py-1 bg-[var(--accent-subtle)] hover:bg-[#2c2c2c] text-[var(--accent)] border border-[var(--accent-border)] rounded transition-colors cursor-pointer font-medium"
          >
            Screentone
          </button>

          <button
            type="button"
            onClick={onTransformSelection}
            title="Transform Selection (Ctrl+T)"
            className="px-2 py-1 text-[#e5e5e5] hover:bg-[#2c2c2c] rounded font-medium transition-colors cursor-pointer"
          >
            Transform
          </button>
        </div>,
        document.body
      )}
    </>
  );
};
