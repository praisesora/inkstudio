import React, { useEffect, useRef, useState } from 'react';
import { SpeechBalloon } from '../types/editor';
import {
  Trash2,
} from 'lucide-react';
import { getBalloonHandles, BalloonHandle, renderSpeechBalloon } from '../utils/balloonEngine';

interface SpeechBalloonOverlayProps {
  balloon: SpeechBalloon | null;
  zoom: number;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  onUpdateBalloon: (updater: (prev: SpeechBalloon) => SpeechBalloon) => void;
  onConfirmBalloon: () => void;
  onDeleteBalloon: () => void;
}

export const SpeechBalloonOverlay: React.FC<SpeechBalloonOverlayProps> = ({
  balloon,
  zoom,
  rotation = 0,
  flipX = false,
  flipY = false,
  onUpdateBalloon,
  onConfirmBalloon,
  onDeleteBalloon,
}) => {
  if (!balloon) return null;

  const dragRef = useRef<{
    activeHandle: string | null;
    startX: number;
    startY: number;
    initialBounds: { x: number; y: number; width: number; height: number };
    initialTail: SpeechBalloon['tail'];
  }>({
    activeHandle: null,
    startX: 0,
    startY: 0,
    initialBounds: { ...balloon.bounds },
    initialTail: { ...balloon.tail },
  });

  const [activeTab, setActiveTab] = useState<'shape' | 'text'>('shape');
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const pad = 120;
  const minX = Math.floor(
    Math.min(
      balloon.bounds.x,
      balloon.tail.start.x,
      balloon.tail.control1.x,
      balloon.tail.control2.x,
      balloon.tail.tip.x
    ) - pad
  );
  const minY = Math.floor(
    Math.min(
      balloon.bounds.y,
      balloon.tail.start.y,
      balloon.tail.control1.y,
      balloon.tail.control2.y,
      balloon.tail.tip.y
    ) - pad
  );
  const maxX = Math.ceil(
    Math.max(
      balloon.bounds.x + balloon.bounds.width,
      balloon.tail.start.x,
      balloon.tail.control1.x,
      balloon.tail.control2.x,
      balloon.tail.tip.x
    ) + pad
  );
  const maxY = Math.ceil(
    Math.max(
      balloon.bounds.y + balloon.bounds.height,
      balloon.tail.start.y,
      balloon.tail.control1.y,
      balloon.tail.control2.y,
      balloon.tail.tip.y
    ) + pad
  );
  const previewW = Math.max(64, maxX - minX);
  const previewH = Math.max(64, maxY - minY);

  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(-minX, -minY);
    renderSpeechBalloon(ctx, balloon);
    ctx.restore();
  }, [balloon, minX, minY, previewW, previewH]);

  const handles: BalloonHandle[] = getBalloonHandles(balloon);

  const handlePointerDown = (handleId: string, e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    dragRef.current = {
      activeHandle: handleId,
      startX: e.clientX,
      startY: e.clientY,
      initialBounds: { ...balloon.bounds },
      initialTail: {
        start: { ...balloon.tail.start },
        control1: { ...balloon.tail.control1 },
        control2: { ...balloon.tail.control2 },
        tip: { ...balloon.tail.tip },
      },
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const { activeHandle, startX, startY, initialBounds, initialTail } = dragRef.current;
    if (!activeHandle) return;

    const dxScreen = e.clientX - startX;
    const dyScreen = e.clientY - startY;
    const rad = (-rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = ((dxScreen * cos - dyScreen * sin) * (flipX ? -1 : 1)) / zoom;
    const dy = ((dxScreen * sin + dyScreen * cos) * (flipY ? -1 : 1)) / zoom;

    onUpdateBalloon((prev) => {
      if (activeHandle === 'tail-tip') {
        return {
          ...prev,
          tail: {
            ...prev.tail,
            tip: {
              ...prev.tail.tip,
              x: Math.round(initialTail.tip.x + dx),
              y: Math.round(initialTail.tip.y + dy),
            },
          },
        };
      }

      if (activeHandle === 'tail-ctrl1') {
        return {
          ...prev,
          tail: {
            ...prev.tail,
            control1: {
              ...prev.tail.control1,
              x: Math.round(initialTail.control1.x + dx),
              y: Math.round(initialTail.control1.y + dy),
            },
          },
        };
      }

      if (activeHandle === 'tail-ctrl2') {
        return {
          ...prev,
          tail: {
            ...prev.tail,
            control2: {
              ...prev.tail.control2,
              x: Math.round(initialTail.control2.x + dx),
              y: Math.round(initialTail.control2.y + dy),
            },
          },
        };
      }

      if (activeHandle === 'tail-start') {
        return {
          ...prev,
          tail: {
            ...prev.tail,
            start: {
              ...prev.tail.start,
              x: Math.round(initialTail.start.x + dx),
              y: Math.round(initialTail.start.y + dy),
            },
          },
        };
      }

      // Body bounding box resize handles
      let { x, y, width, height } = initialBounds;

      if (activeHandle.includes('e')) width = Math.max(40, width + dx);
      if (activeHandle.includes('s')) height = Math.max(40, height + dy);
      if (activeHandle.includes('w')) {
        const newW = Math.max(40, width - dx);
        x = initialBounds.x + (width - newW);
        width = newW;
      }
      if (activeHandle.includes('n')) {
        const newH = Math.max(40, height - dy);
        y = initialBounds.y + (height - newH);
        height = newH;
      }

      return {
        ...prev,
        bounds: {
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height),
        },
      };
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (dragRef.current.activeHandle) {
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      dragRef.current.activeHandle = null;
    }
  };

  const { bounds, tail } = balloon;

  return (
    <div className="absolute inset-0 pointer-events-none z-35">
      {/* Live WYSIWYG Balloon Canvas Preview */}
      <canvas
        ref={previewCanvasRef}
        width={previewW}
        height={previewH}
        className="absolute pointer-events-none"
        style={{
          left: `${minX}px`,
          top: `${minY}px`,
          width: `${previewW}px`,
          height: `${previewH}px`,
        }}
      />

      {/* SVG overlay rendering handles and tail control skeleton */}
      <svg className="w-full h-full overflow-visible pointer-events-none">
        {/* Bounding box guide */}
        <rect
          x={bounds.x}
          y={bounds.y}
          width={bounds.width}
          height={bounds.height}
          fill="none"
          stroke="#00bcd4"
          strokeWidth={1.5 / zoom}
          strokeDasharray={`${4 / zoom},${4 / zoom}`}
        />

        {/* Tail control arm lines */}
        <line
          x1={tail.start.x}
          y1={tail.start.y}
          x2={tail.control1.x}
          y2={tail.control1.y}
          stroke="#00bcd4"
          strokeWidth={1 / zoom}
          strokeDasharray={`${3 / zoom},${3 / zoom}`}
        />
        <line
          x1={tail.tip.x}
          y1={tail.tip.y}
          x2={tail.control2.x}
          y2={tail.control2.y}
          stroke="#00bcd4"
          strokeWidth={1 / zoom}
          strokeDasharray={`${3 / zoom},${3 / zoom}`}
        />
      </svg>

      {/* Interactive Handles */}
      {handles.map((h) => {
        const isTail = h.type.startsWith('tail');
        const size = isTail ? 10 / zoom : 8 / zoom;

        return (
          <div
            key={h.id}
            onPointerDown={(e) => handlePointerDown(h.id, e)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className={`absolute pointer-events-auto rounded-full border shadow-sm transition-transform hover:scale-125 ${
              h.id === 'tail-tip'
                ? 'bg-amber-400 border-white ring-2 ring-amber-500/50'
                : isTail
                ? 'bg-cyan-400 border-white'
                : 'bg-white border-[#00bcd4]'
            }`}
            style={{
              left: `${h.x}px`,
              top: `${h.y}px`,
              width: `${size}px`,
              height: `${size}px`,
              transform: 'translate(-50%, -50%)',
              cursor: h.cursor,
            }}
            title={h.id === 'tail-tip' ? 'Drag Tail Tip' : `Handle: ${h.id}`}
          />
        );
      })}

      {/* Floating Balloon Inspector Panel */}
      <div
        className="absolute pointer-events-auto bg-[#202020]/95 backdrop-blur-md border border-white/[0.1] rounded-md shadow-2xl p-2.5 w-72 text-xs text-[#e5e5e5] flex flex-col space-y-2 select-none"
        style={{
          left: `${bounds.x + bounds.width + 15}px`,
          top: `${bounds.y}px`,
          transform: `scale(${(flipX ? -1 : 1) * (zoom > 0 ? 1 / zoom : 1)}, ${(flipY ? -1 : 1) * (zoom > 0 ? 1 / zoom : 1)})`,
          transformOrigin: 'top left',
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] pb-1.5">
          <span className="text-[#e5e5e5] font-medium">Speech Balloon</span>
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setActiveTab('shape')}
              className={`px-1.5 py-0.5 rounded text-[10px] cursor-pointer ${
                activeTab === 'shape' ? 'bg-[#2c2c2c] text-[#e5e5e5]' : 'text-[#8a8a8a]'
              }`}
            >
              Shape
            </button>
            <button
              onClick={() => setActiveTab('text')}
              className={`px-1.5 py-0.5 rounded text-[10px] cursor-pointer ${
                activeTab === 'text' ? 'bg-[#2c2c2c] text-[#e5e5e5]' : 'text-[#8a8a8a]'
              }`}
            >
              Text
            </button>
          </div>
        </div>

        {activeTab === 'shape' ? (
          <div className="space-y-2">
            <div>
              <label className="text-[10px] text-[#8a8a8a] block mb-1">Shape Preset</label>
              <div className="grid grid-cols-4 gap-1">
                {(
                  [
                    ['ellipse', 'Ellipse'],
                    ['rounded-rect', 'Box'],
                    ['jagged-flash', 'Flash'],
                    ['thought', 'Thought'],
                  ] as const
                ).map(([shapeId, lbl]) => (
                  <button
                    key={shapeId}
                    onClick={() => onUpdateBalloon((p) => ({ ...p, shape: shapeId }))}
                    className={`py-1 rounded text-[10px] border cursor-pointer transition-colors ${
                      balloon.shape === shapeId
                        ? 'border-[var(--accent-border)] bg-[var(--accent-subtle)] text-[var(--accent)] font-medium'
                        : 'border-white/[0.06] bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5]'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[#8a8a8a]">Border Width</span>
              <div className="flex items-center space-x-1.5">
                <input
                  type="range"
                  min={1}
                  max={12}
                  value={balloon.strokeWidth}
                  onChange={(e) =>
                    onUpdateBalloon((p) => ({ ...p, strokeWidth: Number(e.target.value) }))
                  }
                  className="w-24"
                />
                <span className="font-mono text-[#e5e5e5] w-6 text-right">
                  {balloon.strokeWidth}px
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              value={balloon.text}
              onChange={(e) => onUpdateBalloon((p) => ({ ...p, text: e.target.value }))}
              placeholder="Balloon dialogue text..."
              rows={2}
              className="w-full bg-[#161616] text-[#e5e5e5] text-xs border border-white/[0.08] rounded p-1.5 resize-none"
            />

            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[#8a8a8a]">Direction</span>
              <div className="flex space-x-1">
                <button
                  onClick={() => onUpdateBalloon((p) => ({ ...p, vertical: false }))}
                  className={`px-2 py-0.5 rounded text-[10px] cursor-pointer ${
                    !balloon.vertical
                      ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent-border)]'
                      : 'bg-[#161616] text-[#8a8a8a]'
                  }`}
                >
                  Horizontal
                </button>
                <button
                  onClick={() => onUpdateBalloon((p) => ({ ...p, vertical: true }))}
                  className={`px-2 py-0.5 rounded text-[10px] cursor-pointer ${
                    balloon.vertical
                      ? 'bg-[var(--accent-subtle)] text-[var(--accent)] border border-[var(--accent-border)]'
                      : 'bg-[#161616] text-[#8a8a8a]'
                  }`}
                >
                  Vertical
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[#8a8a8a]">Font Size</span>
              <div className="flex items-center space-x-1.5">
                <input
                  type="range"
                  min={12}
                  max={72}
                  value={balloon.fontSize}
                  onChange={(e) =>
                    onUpdateBalloon((p) => ({ ...p, fontSize: Number(e.target.value) }))
                  }
                  className="w-24"
                />
                <span className="font-mono text-[#e5e5e5] w-6 text-right">{balloon.fontSize}px</span>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between pt-1.5 border-t border-white/[0.06]">
          <button
            onClick={onDeleteBalloon}
            className="p-1 text-[#8a8a8a] hover:text-rose-400 hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
            title="Delete Balloon"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onConfirmBalloon}
            className="px-3 py-1 bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 rounded text-xs font-medium transition-opacity cursor-pointer"
          >
            Apply Balloon
          </button>
        </div>
      </div>
    </div>
  );
};
