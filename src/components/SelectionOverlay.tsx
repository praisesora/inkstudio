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
  onInvertSelection: () => void;
  onExpandSelection?: (pixels: number) => void;
  onContractSelection?: (pixels: number) => void;
  onFeatherSelection?: (radius: number) => void;
}

export const SelectionOverlay: React.FC<SelectionOverlayProps> = ({
  selection,
  dimensions,
  zoom,
  flipX = false,
  flipY = false,
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
  const fx = flipX ? -1 : 1;
  const fy = flipY ? -1 : 1;

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
          transform: `translate(-50%, calc(-100% - ${8 * invZoom}px)) scale(${fx * invZoom}, ${fy * invZoom})`,
          transformOrigin: 'bottom center',
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="bg-[#202020]/95 backdrop-blur-md border border-white/[0.1] rounded-md shadow-2xl px-1.5 py-1 flex items-center space-x-1 whitespace-nowrap text-[11px] text-[#e5e5e5]">
          <button
            onClick={() => onExpandSelection?.(5)}
            title="Expand Selection (+5px)"
            className="px-1.5 py-0.5 text-[#cccccc] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded cursor-pointer transition-colors"
          >
            Expand
          </button>

          <button
            onClick={() => onContractSelection?.(5)}
            title="Contract Selection (-5px)"
            className="px-1.5 py-0.5 text-[#cccccc] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded cursor-pointer transition-colors"
          >
            Contract
          </button>

          <button
            onClick={() => onFeatherSelection?.(5)}
            title="Feather Selection (5px)"
            className="px-1.5 py-0.5 text-[#cccccc] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded cursor-pointer transition-colors"
          >
            Feather
          </button>

          <div className="w-px h-3.5 bg-white/[0.08]" />

          <button
            onClick={onInvertSelection}
            title="Invert Selection (Ctrl+Shift+I)"
            className="px-1.5 py-0.5 text-[#cccccc] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded cursor-pointer transition-colors"
          >
            Invert
          </button>

          <button
            onClick={onTransformSelection}
            title="Transform Selection (Ctrl+T)"
            className="px-1.5 py-0.5 text-[var(--accent)] hover:bg-[#2c2c2c] rounded font-medium cursor-pointer transition-colors"
          >
            Transform
          </button>

          <button
            onClick={onDeselect}
            title="Deselect (Ctrl+D)"
            className="p-1 text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded cursor-pointer transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 4. Selection Launcher Bar (Fixed at bottom center of viewport) */}
      {createPortal(
        <div
          className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 bg-[#202020]/95 backdrop-blur-md border border-white/[0.1] rounded-md shadow-2xl px-2 py-1 flex items-center space-x-1.5 select-none text-[11px]"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={onDeselect}
            title="Deselect (Ctrl+D)"
            className="px-2 py-1 text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
          >
            Deselect
          </button>

          <div className="w-px h-4 bg-white/[0.08]" />

          <button
            onClick={onFillScreentone}
            title="Fill Screentone into New Layer"
            className="px-2 py-1 bg-[var(--accent-subtle)] hover:bg-[#2c2c2c] text-[var(--accent)] border border-[var(--accent-border)] rounded transition-colors cursor-pointer font-medium"
          >
            Screentone
          </button>

          <button
            onClick={onTransformSelection}
            title="Transform Selection (Ctrl+T)"
            className="px-2 py-1 text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
          >
            Transform
          </button>

          <button
            onClick={onFillColor}
            title="Fill with Foreground Color (Alt+Del)"
            className="px-2 py-1 text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
          >
            Fill
          </button>

          <button
            onClick={onClearSelection}
            title="Clear / Delete Selected Pixels (Del)"
            className="p-1 text-[#8a8a8a] hover:text-rose-400 hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onInvertSelection}
            title="Invert Selection (Ctrl+Shift+I)"
            className="p-1 text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>,
        document.body
      )}
    </>
  );
};
