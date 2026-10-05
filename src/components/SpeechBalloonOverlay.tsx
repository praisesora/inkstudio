import React, { useRef, useState } from 'react';
import { SpeechBalloon } from '../types/editor';
import {
  MessageSquare,
  Sparkles,
  Cloud,
  Square,
  Check,
  Trash2,
} from 'lucide-react';
import { getBalloonHandles, BalloonHandle } from '../utils/balloonEngine';

interface SpeechBalloonOverlayProps {
  balloon: SpeechBalloon | null;
  zoom: number;
  onUpdateBalloon: (updater: (prev: SpeechBalloon) => SpeechBalloon) => void;
  onConfirmBalloon: () => void;
  onDeleteBalloon: () => void;
}

export const SpeechBalloonOverlay: React.FC<SpeechBalloonOverlayProps> = ({
  balloon,
  zoom,
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

    const dx = (e.clientX - startX) / zoom;
    const dy = (e.clientY - startY) / zoom;

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
        className="absolute pointer-events-auto bg-[#1e1f22] border border-[#383a40] rounded-md shadow-2xl p-2.5 w-72 text-xs text-[#cccccc] flex flex-col space-y-2 select-none"
        style={{
          left: `${bounds.x + bounds.width + 15}px`,
          top: `${bounds.y}px`,
          transform: `scale(${zoom > 0 ? 1 / zoom : 1})`,
          transformOrigin: 'top left',
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#2b2d31] pb-1.5">
          <div className="flex items-center space-x-1.5 text-white font-medium">
            <MessageSquare className="w-3.5 h-3.5 text-cyan-400" />
            <span>Speech Balloon</span>
          </div>
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setActiveTab('shape')}
              className={`px-1.5 py-0.5 rounded text-[10px] ${
                activeTab === 'shape' ? 'bg-[#2b2d31] text-white' : 'text-[#888888]'
              }`}
            >
              Shape
            </button>
            <button
              onClick={() => setActiveTab('text')}
              className={`px-1.5 py-0.5 rounded text-[10px] ${
                activeTab === 'text' ? 'bg-[#2b2d31] text-white' : 'text-[#888888]'
              }`}
            >
              Text
            </button>
          </div>
        </div>

        {activeTab === 'shape' ? (
          <div className="space-y-2">
            <div>
              <label className="text-[10px] text-[#888888] block mb-1">Shape Preset:</label>
              <div className="grid grid-cols-4 gap-1">
                <button
                  onClick={() => onUpdateBalloon((p) => ({ ...p, shape: 'ellipse' }))}
                  className={`p-1 rounded flex flex-col items-center border ${
                    balloon.shape === 'ellipse'
                      ? 'border-cyan-400 bg-cyan-500/10 text-cyan-300'
                      : 'border-[#2e3036] text-[#888888] hover:text-white'
                  }`}
                  title="Ellipse (Standard)"
                >
                  <div className="w-4 h-3 rounded-full border border-current my-0.5" />
                  <span className="text-[9px]">Ellipse</span>
                </button>

                <button
                  onClick={() => onUpdateBalloon((p) => ({ ...p, shape: 'rounded-rect' }))}
                  className={`p-1 rounded flex flex-col items-center border ${
                    balloon.shape === 'rounded-rect'
                      ? 'border-cyan-400 bg-cyan-500/10 text-cyan-300'
                      : 'border-[#2e3036] text-[#888888] hover:text-white'
                  }`}
                  title="Rounded Rectangle"
                >
                  <Square className="w-3.5 h-3.5 my-0.5" />
                  <span className="text-[9px]">Box</span>
                </button>

                <button
                  onClick={() => onUpdateBalloon((p) => ({ ...p, shape: 'jagged-flash' }))}
                  className={`p-1 rounded flex flex-col items-center border ${
                    balloon.shape === 'jagged-flash'
                      ? 'border-cyan-400 bg-cyan-500/10 text-cyan-300'
                      : 'border-[#2e3036] text-[#888888] hover:text-white'
                  }`}
                  title="Jagged Flash (Shout / Action)"
                >
                  <Sparkles className="w-3.5 h-3.5 my-0.5 text-amber-400" />
                  <span className="text-[9px]">Flash</span>
                </button>

                <button
                  onClick={() => onUpdateBalloon((p) => ({ ...p, shape: 'thought' }))}
                  className={`p-1 rounded flex flex-col items-center border ${
                    balloon.shape === 'thought'
                      ? 'border-cyan-400 bg-cyan-500/10 text-cyan-300'
                      : 'border-[#2e3036] text-[#888888] hover:text-white'
                  }`}
                  title="Thought Bubble (Cloud)"
                >
                  <Cloud className="w-3.5 h-3.5 my-0.5 text-sky-400" />
                  <span className="text-[9px]">Thought</span>
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[#888888]">Border Width:</span>
              <div className="flex items-center space-x-1">
                <input
                  type="range"
                  min={1}
                  max={12}
                  value={balloon.strokeWidth}
                  onChange={(e) =>
                    onUpdateBalloon((p) => ({ ...p, strokeWidth: Number(e.target.value) }))
                  }
                  className="w-24 accent-cyan-400"
                />
                <span className="font-mono text-cyan-400 w-6 text-right">
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
              className="w-full bg-[#141517] text-white text-xs border border-[#383a40] rounded p-1.5 focus:border-cyan-500 focus:outline-none resize-none"
            />

            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[#888888]">Direction:</span>
              <div className="flex space-x-1">
                <button
                  onClick={() => onUpdateBalloon((p) => ({ ...p, vertical: false }))}
                  className={`px-2 py-0.5 rounded text-[10px] ${
                    !balloon.vertical
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                      : 'bg-[#141517] text-[#888888]'
                  }`}
                >
                  Horizontal
                </button>
                <button
                  onClick={() => onUpdateBalloon((p) => ({ ...p, vertical: true }))}
                  className={`px-2 py-0.5 rounded text-[10px] ${
                    balloon.vertical
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                      : 'bg-[#141517] text-[#888888]'
                  }`}
                >
                  Vertical 縦
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[#888888]">Font Size:</span>
              <div className="flex items-center space-x-1">
                <input
                  type="range"
                  min={12}
                  max={72}
                  value={balloon.fontSize}
                  onChange={(e) =>
                    onUpdateBalloon((p) => ({ ...p, fontSize: Number(e.target.value) }))
                  }
                  className="w-24 accent-cyan-400"
                />
                <span className="font-mono text-cyan-400 w-6 text-right">{balloon.fontSize}px</span>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between pt-1.5 border-t border-[#2b2d31]">
          <button
            onClick={onDeleteBalloon}
            className="p-1 text-rose-400 hover:bg-rose-500/20 rounded transition-colors"
            title="Delete Balloon"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={onConfirmBalloon}
            className="px-2.5 py-1 bg-[#234b3e] hover:bg-[#2b604f] text-[#55eaab] border border-[#2e6e58] rounded text-xs font-semibold flex items-center space-x-1"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Apply Balloon</span>
          </button>
        </div>
      </div>
    </div>
  );
};
