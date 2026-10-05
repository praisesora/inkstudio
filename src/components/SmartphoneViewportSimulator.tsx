import React, { useState, useRef } from 'react';
import { Smartphone, X, GripHorizontal } from 'lucide-react';

interface SmartphoneViewportSimulatorProps {
  visible: boolean;
  onToggleVisible: () => void;
  viewportWidth?: number;
  viewportHeight?: number;
}

export const SmartphoneViewportSimulator: React.FC<SmartphoneViewportSimulatorProps> = ({
  visible,
  onToggleVisible,
}) => {
  // Mobile phone mockup dimensions (standard 9:16 smartphone viewport)
  const phoneWidth = 360;
  const phoneHeight = 640;

  // Floating position (defaults to bottom-right or center)
  const [position, setPosition] = useState<{ x: number; y: number }>(() => ({
    x: Math.max(20, (window.innerWidth - phoneWidth) / 2),
    y: Math.max(20, (window.innerHeight - phoneHeight) / 2),
  }));

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ clientX: number; clientY: number; initX: number; initY: number }>({
    clientX: 0,
    clientY: 0,
    initX: 0,
    initY: 0,
  });

  if (!visible) return null;

  const handlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    isDraggingRef.current = true;
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      initX: position.x,
      initY: position.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.clientX;
    const dy = e.clientY - dragStartRef.current.clientY;
    setPosition({
      x: Math.round(dragStartRef.current.initX + dx),
      y: Math.round(dragStartRef.current.initY + dy),
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isDraggingRef.current) {
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      isDraggingRef.current = false;
    }
  };

  return (
    <div
      className="fixed z-40 select-none pointer-events-none"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${phoneWidth}px`,
        height: `${phoneHeight}px`,
      }}
    >
      {/* Smartphone Outer Chassis & Bezel */}
      <div className="relative w-full h-full rounded-[42px] border-[5px] border-[#383a42]/80 ring-1 ring-white/20 shadow-[0_25px_60px_-15px_rgba(0,0,0,0.7)] flex flex-col overflow-hidden pointer-events-auto">
        {/* Dynamic Island / Camera Notch */}
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className="absolute top-2.5 left-1/2 -translate-x-1/2 w-28 h-6 bg-black/90 rounded-full flex items-center justify-between px-3 cursor-move z-30 shadow-md group"
          title="Drag to reposition smartphone preview frame"
        >
          <div className="w-2.5 h-2.5 rounded-full bg-[#111111] border border-[#222222] ring-1 ring-cyan-500/20" />
          <GripHorizontal className="w-3.5 h-3.5 text-[#555555] group-hover:text-white transition-colors" />
          <div className="w-2 h-2 rounded-full bg-[#16202c]" />
        </div>

        {/* Top Status Bar Mockup */}
        <div className="w-full h-8 pt-1.5 px-6 flex items-center justify-between text-[11px] font-semibold text-white/90 z-20 pointer-events-none bg-gradient-to-b from-black/40 to-transparent">
          <span>9:41</span>
          <div className="flex items-center space-x-1.5 text-[10px]">
            <span>5G</span>
            <div className="w-5 h-2.5 rounded-xs border border-white/80 p-0.5 flex items-center">
              <div className="h-full w-full bg-white/90 rounded-xs" />
            </div>
            <button
              type="button"
              onClick={onToggleVisible}
              className="text-white/60 hover:text-white transition-colors pointer-events-auto ml-1 p-0.5"
              title="Hide Viewport Simulator"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Translucent Cutout Viewport showing Canvas through */}
        <div className="flex-1 w-full relative pointer-events-none">
          {/* Subtle 9:16 guide overlay */}
          <div className="absolute inset-0 border border-cyan-400/30 rounded-lg pointer-events-none" />

          {/* Webtoon Reader Badge */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-3 py-1 bg-black/60 backdrop-blur-md rounded-full border border-white/10 text-[10px] text-cyan-300 font-medium flex items-center space-x-1.5 shadow-lg">
            <Smartphone className="w-3 h-3 text-cyan-400" />
            <span>9:16 Webtoon Simulator</span>
          </div>
        </div>

        {/* Bottom Home Indicator Bar */}
        <div className="w-full h-5 flex items-center justify-center pb-1.5 z-20 pointer-events-none bg-gradient-to-t from-black/40 to-transparent">
          <div className="w-32 h-1 bg-white/70 rounded-full" />
        </div>
      </div>
    </div>
  );
};
