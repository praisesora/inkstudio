import React, { useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  CanvasSelection,
  CanvasDimensions,
} from '../types/editor';
import {
  X,
  Scaling,
  PaintBucket,
  Trash2,
  Sparkles,
  RotateCcw,
  Maximize2,
  Minimize2,
  Feather,
} from 'lucide-react';
import { maskToSvgPath } from '../utils/selectionUtils';

interface SelectionOverlayProps {
  selection: CanvasSelection | null;
  dimensions: CanvasDimensions;
  zoom: number;
  onDeselect: () => void;
  onTransformSelection: () => void;
  onFillScreentone: () => void;
  onFillColor: () => void;
  onClearSelection: () => void;
  onInvertSelection: () => void;
  onExpandSelection?: (pixels: number) => void;
  onContractSelection?: (pixels: number) => void;
  onFeatherSelection?: (radius: number) => void;
}

export const SelectionOverlay: React.FC<SelectionOverlayProps> = ({
  selection,
  dimensions,
  zoom,
  onDeselect,
  onTransformSelection,
  onFillScreentone,
  onFillColor,
  onClearSelection,
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

  const invZoom = zoom > 0 ? 1 / zoom : 1;

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

      {/* 3. Floating Quick-Action Bar directly above active selection */}
      <div
        className="absolute z-26 pointer-events-auto select-none"
        style={{
          left: `${bounds.x + bounds.width / 2}px`,
          top: `${bounds.y}px`,
          transform: `translate(-50%, calc(-100% - ${8 * invZoom}px)) scale(${invZoom})`,
          transformOrigin: 'bottom center',
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="bg-[#18191b] border border-[#33353b] rounded shadow-2xl px-2 py-1 flex items-center space-x-1 whitespace-nowrap text-xs text-[#cccccc]">
          {/* Expand */}
          <button
            onClick={() => onExpandSelection?.(5)}
            title="Expand Selection (+5px)"
            className="px-1.5 py-0.5 hover:text-white hover:bg-[#25272a] rounded flex items-center space-x-1 cursor-pointer transition-colors"
          >
            <Maximize2 className="w-3 h-3 text-cyan-400" />
            <span>Expand</span>
          </button>

          {/* Contract */}
          <button
            onClick={() => onContractSelection?.(5)}
            title="Contract Selection (-5px)"
            className="px-1.5 py-0.5 hover:text-white hover:bg-[#25272a] rounded flex items-center space-x-1 cursor-pointer transition-colors"
          >
            <Minimize2 className="w-3 h-3 text-cyan-400" />
            <span>Contract</span>
          </button>

          {/* Feather */}
          <button
            onClick={() => onFeatherSelection?.(5)}
            title="Feather Selection (5px)"
            className="px-1.5 py-0.5 hover:text-white hover:bg-[#25272a] rounded flex items-center space-x-1 cursor-pointer transition-colors"
          >
            <Feather className="w-3 h-3 text-cyan-400" />
            <span>Feather</span>
          </button>

          <div className="w-px h-3.5 bg-[#33353b]" />

          {/* Invert */}
          <button
            onClick={onInvertSelection}
            title="Invert Selection (Ctrl+Shift+I)"
            className="px-1.5 py-0.5 hover:text-white hover:bg-[#25272a] rounded flex items-center space-x-1 cursor-pointer transition-colors"
          >
            <RotateCcw className="w-3 h-3 text-amber-400" />
            <span>Invert</span>
          </button>

          {/* Transform */}
          <button
            onClick={onTransformSelection}
            title="Transform Selection (Ctrl+T)"
            className="px-1.5 py-0.5 hover:text-white hover:bg-[#25272a] rounded flex items-center space-x-1 cursor-pointer transition-colors"
          >
            <Scaling className="w-3 h-3 text-emerald-400" />
            <span>Transform</span>
          </button>

          {/* Deselect */}
          <button
            onClick={onDeselect}
            title="Deselect (Ctrl+D)"
            className="p-1 hover:text-rose-400 hover:bg-[#25272a] rounded cursor-pointer transition-colors"
          >
            <X className="w-3.5 h-3.5 text-rose-400" />
          </button>
        </div>
      </div>

      {/* 4. CSP-Style Selection Launcher Bar (Fixed at bottom center of viewport) */}
      {createPortal(
        <div
          className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 bg-[#1e1f22] border border-[#383a40] rounded shadow-2xl px-2 py-1.5 flex items-center space-x-1.5 select-none animate-in fade-in slide-in-from-bottom-2 duration-150"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* Deselect */}
          <button
            onClick={onDeselect}
            title="Deselect (Ctrl+D)"
            className="p-1.5 text-[#999999] hover:text-white hover:bg-[#2b2d31] rounded transition-colors cursor-pointer flex items-center space-x-1 text-xs"
          >
            <X className="w-4 h-4 text-red-400" />
            <span className="hidden sm:inline">Deselect</span>
          </button>

          <div className="w-px h-4 bg-[#383a40]" />

          {/* Screen Tone Fill (CSP Halftone Fill) */}
          <button
            onClick={onFillScreentone}
            title="Fill Screentone into New Layer (CSP Tone Effect)"
            className="p-1.5 bg-[#293d45] hover:bg-[#344d57] text-[#5ce1e6] border border-[#3e5e6b] rounded transition-colors cursor-pointer flex items-center space-x-1.5 text-xs font-medium shadow-xs"
          >
            <Sparkles className="w-4 h-4 text-[#5ce1e6]" />
            <span>Screentone Fill</span>
          </button>

          {/* Transform Selection (Ctrl+T) */}
          <button
            onClick={onTransformSelection}
            title="Transform Selection (Ctrl+T)"
            className="p-1.5 text-[#cccccc] hover:text-white hover:bg-[#2b2d31] rounded transition-colors cursor-pointer flex items-center space-x-1 text-xs"
          >
            <Scaling className="w-4 h-4 text-cyan-400" />
            <span>Transform</span>
          </button>

          {/* Fill with Foreground Color */}
          <button
            onClick={onFillColor}
            title="Fill with Foreground Color (Alt+Del)"
            className="p-1.5 text-[#cccccc] hover:text-white hover:bg-[#2b2d31] rounded transition-colors cursor-pointer flex items-center space-x-1 text-xs"
          >
            <PaintBucket className="w-4 h-4 text-amber-400" />
            <span className="hidden sm:inline">Fill</span>
          </button>

          {/* Clear Selection Pixels */}
          <button
            onClick={onClearSelection}
            title="Clear / Delete Selected Pixels (Del)"
            className="p-1.5 text-[#cccccc] hover:text-red-400 hover:bg-[#2b2d31] rounded transition-colors cursor-pointer flex items-center space-x-1 text-xs"
          >
            <Trash2 className="w-4 h-4" />
          </button>

          {/* Invert Selection */}
          <button
            onClick={onInvertSelection}
            title="Invert Selection (Ctrl+Shift+I)"
            className="p-1.5 text-[#cccccc] hover:text-white hover:bg-[#2b2d31] rounded transition-colors cursor-pointer flex items-center space-x-1 text-xs"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>,
        document.body
      )}
    </>
  );
};
