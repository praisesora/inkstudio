import React, { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import {
  LayerStyles,
  LayerStyleStroke,
  LayerStyleDropShadow,
  LayerStyleOuterGlow,
} from '../types/editor';

export interface LayerStylesModalProps {
  isOpen: boolean;
  initialStyles?: LayerStyles;
  layerName?: string;
  onClose: () => void;
  onApply: (styles: LayerStyles) => void;
}

export const DEFAULT_STROKE: LayerStyleStroke = {
  enabled: false,
  size: 4,
  color: '#000000',
  position: 'outside',
  opacity: 1,
};

export const DEFAULT_DROP_SHADOW: LayerStyleDropShadow = {
  enabled: false,
  color: '#000000',
  opacity: 0.75,
  angle: 120,
  distance: 8,
  blur: 10,
  spread: 0,
};

export const DEFAULT_OUTER_GLOW: LayerStyleOuterGlow = {
  enabled: false,
  color: '#ffe600',
  opacity: 0.75,
  blur: 15,
  spread: 10,
};

type StyleTab = 'stroke' | 'dropShadow' | 'outerGlow';

export const LayerStylesModal: React.FC<LayerStylesModalProps> = ({
  isOpen,
  initialStyles,
  layerName = 'Layer',
  onClose,
  onApply,
}) => {
  const [activeTab, setActiveTab] = useState<StyleTab>('stroke');

  const [stroke, setStroke] = useState<LayerStyleStroke>(() => ({
    ...DEFAULT_STROKE,
    ...(initialStyles?.stroke || {}),
  }));

  const [dropShadow, setDropShadow] = useState<LayerStyleDropShadow>(() => ({
    ...DEFAULT_DROP_SHADOW,
    ...(initialStyles?.dropShadow || {}),
  }));

  const [outerGlow, setOuterGlow] = useState<LayerStyleOuterGlow>(() => ({
    ...DEFAULT_OUTER_GLOW,
    ...(initialStyles?.outerGlow || {}),
  }));

  // Modal dragging support
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ startX: number; startY: number; initX: number; initY: number }>({
    startX: 0,
    startY: 0,
    initX: 0,
    initY: 0,
  });

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Sync state when opening modal
  useEffect(() => {
    if (isOpen) {
      setStroke({
        ...DEFAULT_STROKE,
        ...(initialStyles?.stroke || {}),
      });
      setDropShadow({
        ...DEFAULT_DROP_SHADOW,
        ...(initialStyles?.dropShadow || {}),
      });
      setOuterGlow({
        ...DEFAULT_OUTER_GLOW,
        ...(initialStyles?.outerGlow || {}),
      });
      // Center modal dialog
      setPos({ x: 0, y: 0 });
    }
  }, [isOpen, initialStyles]);

  // Live Swatch Preview Renderer
  useEffect(() => {
    if (!isOpen) return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Checkerboard background
    const tileSize = 8;
    for (let y = 0; y < h; y += tileSize) {
      for (let x = 0; x < w; x += tileSize) {
        ctx.fillStyle = ((x / tileSize + y / tileSize) % 2 === 0) ? '#28282b' : '#1f1f22';
        ctx.fillRect(x, y, tileSize, tileSize);
      }
    }

    ctx.save();
    const cx = w / 2;
    const cy = h / 2;

    // Draw Drop Shadow
    if (dropShadow.enabled && dropShadow.opacity > 0) {
      ctx.save();
      const rad = ((dropShadow.angle || 0) * Math.PI) / 180;
      ctx.shadowColor = dropShadow.color || '#000000';
      ctx.shadowBlur = dropShadow.blur || 0;
      ctx.shadowOffsetX = Math.cos(rad) * (dropShadow.distance || 0);
      ctx.shadowOffsetY = Math.sin(rad) * (dropShadow.distance || 0);
      ctx.globalAlpha = dropShadow.opacity;
      drawPreviewShape(ctx, cx, cy);
      ctx.restore();
    }

    // Draw Outer Glow
    if (outerGlow.enabled && outerGlow.opacity > 0) {
      ctx.save();
      ctx.shadowColor = outerGlow.color || '#ffe600';
      ctx.shadowBlur = outerGlow.blur || 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.globalAlpha = outerGlow.opacity;
      drawPreviewShape(ctx, cx, cy);
      ctx.restore();
    }

    // Draw Outside Stroke
    if (stroke.enabled && stroke.size > 0 && stroke.opacity > 0 && stroke.position === 'outside') {
      ctx.save();
      ctx.strokeStyle = stroke.color || '#000000';
      ctx.lineWidth = stroke.size * 2;
      ctx.lineJoin = 'round';
      ctx.globalAlpha = stroke.opacity;
      strokePreviewShape(ctx, cx, cy);
      ctx.restore();
    }

    // Draw Center Stroke under shape
    if (stroke.enabled && stroke.size > 0 && stroke.opacity > 0 && stroke.position === 'center') {
      ctx.save();
      ctx.strokeStyle = stroke.color || '#000000';
      ctx.lineWidth = stroke.size;
      ctx.lineJoin = 'round';
      ctx.globalAlpha = stroke.opacity;
      strokePreviewShape(ctx, cx, cy);
      ctx.restore();
    }

    // Draw Shape Body
    ctx.save();
    ctx.fillStyle = '#3b82f6';
    drawPreviewShape(ctx, cx, cy);
    ctx.restore();

    // Draw Inside Stroke
    if (stroke.enabled && stroke.size > 0 && stroke.opacity > 0 && stroke.position === 'inside') {
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = stroke.color || '#000000';
      ctx.lineWidth = stroke.size * 2;
      ctx.lineJoin = 'round';
      ctx.globalAlpha = stroke.opacity;
      strokePreviewShape(ctx, cx, cy);
      ctx.restore();
    }

    ctx.restore();
  }, [isOpen, stroke, dropShadow, outerGlow]);

  function drawPreviewShape(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
    ctx.beginPath();
    ctx.arc(cx, cy, 28, 0, Math.PI * 2);
    ctx.fill();
  }

  function strokePreviewShape(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
    ctx.beginPath();
    ctx.arc(cx, cy, 28, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Keyboard shortcut handlers (Escape = Close, Enter = OK)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        handleConfirm();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, stroke, dropShadow, outerGlow]);

  const handlePointerDown = (e: React.PointerEvent) => {
    isDraggingRef.current = true;
    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initX: pos.x,
      initY: pos.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.startX;
    const dy = e.clientY - dragStartRef.current.startY;
    setPos({
      x: dragStartRef.current.initX + dx,
      y: dragStartRef.current.initY + dy,
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    isDraggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore pointer release failure
    }
  };

  const handleResetDefaults = () => {
    if (activeTab === 'stroke') setStroke(DEFAULT_STROKE);
    else if (activeTab === 'dropShadow') setDropShadow(DEFAULT_DROP_SHADOW);
    else if (activeTab === 'outerGlow') setOuterGlow(DEFAULT_OUTER_GLOW);
  };

  const handleConfirm = () => {
    onApply({
      stroke,
      dropShadow,
      outerGlow,
    });
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="layer-styles-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 select-none"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[640px] max-w-[95vw] bg-[#202020] border border-[#2c2c2c] rounded-lg shadow-[0_24px_64px_rgba(0,0,0,0.85)] flex flex-col text-[#e5e5e5] overflow-hidden"
        style={{
          transform: `translate(${pos.x}px, ${pos.y}px)`,
        }}
      >
        {/* Header / Title Bar */}
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className="h-9 flex items-center justify-between px-3.5 bg-[#161616] border-b border-[#2c2c2c] cursor-move text-xs font-medium"
        >
          <span id="layer-styles-modal-title" className="text-[#e5e5e5]">
            Layer Style — {layerName}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Cancel (Esc)"
            className="w-6 h-6 flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] rounded transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Modal Body: Left category sidebar + Right parameter panel */}
        <div className="flex flex-1 min-h-[380px] text-xs">
          {/* Left Column: Styles Checklist */}
          <div className="w-48 bg-[#161616] border-r border-[#2c2c2c] p-2 flex flex-col justify-between">
            <div className="space-y-1">
              <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-[#8a8a8a]">
                Styles
              </div>

              {/* Stroke Item */}
              <div
                onClick={() => setActiveTab('stroke')}
                className={`flex items-center space-x-2 px-2.5 py-2 rounded cursor-pointer transition-colors ${
                  activeTab === 'stroke'
                    ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                    : 'hover:bg-[#202020] text-[#8a8a8a]'
                }`}
              >
                <input
                  type="checkbox"
                  checked={stroke.enabled}
                  onChange={(e) => {
                    e.stopPropagation();
                    setStroke((s) => ({ ...s, enabled: e.target.checked }));
                  }}
                  className="cursor-pointer"
                />
                <span className="flex-1 truncate">Stroke</span>
              </div>

              {/* Drop Shadow Item */}
              <div
                onClick={() => setActiveTab('dropShadow')}
                className={`flex items-center space-x-2 px-2.5 py-2 rounded cursor-pointer transition-colors ${
                  activeTab === 'dropShadow'
                    ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                    : 'hover:bg-[#202020] text-[#8a8a8a]'
                }`}
              >
                <input
                  type="checkbox"
                  checked={dropShadow.enabled}
                  onChange={(e) => {
                    e.stopPropagation();
                    setDropShadow((s) => ({ ...s, enabled: e.target.checked }));
                  }}
                  className="cursor-pointer"
                />
                <span className="flex-1 truncate">Drop Shadow</span>
              </div>

              {/* Outer Glow Item */}
              <div
                onClick={() => setActiveTab('outerGlow')}
                className={`flex items-center space-x-2 px-2.5 py-2 rounded cursor-pointer transition-colors ${
                  activeTab === 'outerGlow'
                    ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                    : 'hover:bg-[#202020] text-[#8a8a8a]'
                }`}
              >
                <input
                  type="checkbox"
                  checked={outerGlow.enabled}
                  onChange={(e) => {
                    e.stopPropagation();
                    setOuterGlow((s) => ({ ...s, enabled: e.target.checked }));
                  }}
                  className="cursor-pointer"
                />
                <span className="flex-1 truncate">Outer Glow</span>
              </div>
            </div>

            {/* Interactive Swatch Preview Canvas */}
            <div className="pt-2 border-t border-white/[0.06] flex flex-col items-center">
              <span className="text-[10px] text-[#8a8a8a] mb-1 font-mono">Preview</span>
              <canvas
                ref={previewCanvasRef}
                width={100}
                height={100}
                className="w-24 h-24 rounded border border-white/[0.08] bg-[#202020]"
              />
            </div>
          </div>

          {/* Right Column: Parameters for the selected category */}
          <div className="flex-1 p-5 overflow-y-auto space-y-4">
            {/* --- STROKE OPTIONS --- */}
            {activeTab === 'stroke' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
                  <span className="font-medium text-[#e5e5e5]">Stroke Options</span>
                  <label className="flex items-center space-x-1.5 cursor-pointer text-[#8a8a8a]">
                    <input
                      type="checkbox"
                      checked={stroke.enabled}
                      onChange={(e) => setStroke((s) => ({ ...s, enabled: e.target.checked }))}
                    />
                    <span className="text-xs">Enable Stroke</span>
                  </label>
                </div>

                {/* Structure / Size */}
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-[#8a8a8a]">Size</span>
                    <span className="font-mono text-[#e5e5e5]">{stroke.size} px</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="100"
                    value={stroke.size}
                    onChange={(e) => setStroke((s) => ({ ...s, size: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>

                {/* Position */}
                <div className="space-y-1">
                  <span className="text-[#8a8a8a] block">Position</span>
                  <div className="grid grid-cols-3 gap-1 bg-[#161616] p-1 rounded border border-white/[0.06]">
                    {(['outside', 'inside', 'center'] as const).map((pos) => (
                      <button
                        key={pos}
                        onClick={() => setStroke((s) => ({ ...s, position: pos }))}
                        className={`py-1 text-center capitalize rounded transition-colors cursor-pointer ${
                          stroke.position === pos
                            ? 'bg-[var(--accent)] text-[var(--accent-contrast)] font-medium'
                            : 'hover:bg-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5]'
                        }`}
                      >
                        {pos}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Opacity */}
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-[#8a8a8a]">Opacity</span>
                    <span className="font-mono text-[#e5e5e5]">{Math.round(stroke.opacity * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={stroke.opacity}
                    onChange={(e) => setStroke((s) => ({ ...s, opacity: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>

                {/* Color */}
                <div className="space-y-1">
                  <span className="text-[#8a8a8a] block">Color</span>
                  <div className="flex items-center space-x-2">
                    <input
                      type="color"
                      value={stroke.color}
                      onChange={(e) => setStroke((s) => ({ ...s, color: e.target.value }))}
                      className="w-7 h-7 rounded border border-white/[0.1] bg-transparent cursor-pointer"
                    />
                    <input
                      type="text"
                      value={stroke.color}
                      onChange={(e) => setStroke((s) => ({ ...s, color: e.target.value }))}
                      className="w-24 px-2 py-1 bg-[#161616] border border-white/[0.08] rounded font-mono text-xs text-[#e5e5e5]"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* --- DROP SHADOW OPTIONS --- */}
            {activeTab === 'dropShadow' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
                  <span className="font-medium text-[#e5e5e5]">Drop Shadow Options</span>
                  <label className="flex items-center space-x-1.5 cursor-pointer text-[#8a8a8a]">
                    <input
                      type="checkbox"
                      checked={dropShadow.enabled}
                      onChange={(e) => setDropShadow((s) => ({ ...s, enabled: e.target.checked }))}
                    />
                    <span className="text-xs">Enable Shadow</span>
                  </label>
                </div>

                {/* Color & Opacity */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <span className="text-[#8a8a8a] block">Color</span>
                    <div className="flex items-center space-x-2">
                      <input
                        type="color"
                        value={dropShadow.color}
                        onChange={(e) => setDropShadow((s) => ({ ...s, color: e.target.value }))}
                        className="w-7 h-7 rounded border border-white/[0.1] bg-transparent cursor-pointer"
                      />
                      <input
                        type="text"
                        value={dropShadow.color}
                        onChange={(e) => setDropShadow((s) => ({ ...s, color: e.target.value }))}
                        className="w-20 px-2 py-1 bg-[#161616] border border-white/[0.08] rounded font-mono text-xs text-[#e5e5e5]"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-[#8a8a8a]">Opacity</span>
                      <span className="font-mono text-[#e5e5e5]">{Math.round(dropShadow.opacity * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={dropShadow.opacity}
                      onChange={(e) => setDropShadow((s) => ({ ...s, opacity: Number(e.target.value) }))}
                      className="w-full"
                    />
                  </div>
                </div>

                {/* Angle */}
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-[#8a8a8a]">Angle</span>
                    <span className="font-mono text-[#e5e5e5]">{dropShadow.angle}°</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="360"
                    value={dropShadow.angle}
                    onChange={(e) => setDropShadow((s) => ({ ...s, angle: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>

                {/* Distance */}
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-[#8a8a8a]">Distance</span>
                    <span className="font-mono text-[#e5e5e5]">{dropShadow.distance} px</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={dropShadow.distance}
                    onChange={(e) => setDropShadow((s) => ({ ...s, distance: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>

                {/* Spread */}
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-[#8a8a8a]">Spread</span>
                    <span className="font-mono text-[#e5e5e5]">{dropShadow.spread}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={dropShadow.spread}
                    onChange={(e) => setDropShadow((s) => ({ ...s, spread: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>

                {/* Size / Blur */}
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-[#8a8a8a]">Size (Blur)</span>
                    <span className="font-mono text-[#e5e5e5]">{dropShadow.blur} px</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={dropShadow.blur}
                    onChange={(e) => setDropShadow((s) => ({ ...s, blur: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>
              </div>
            )}

            {/* --- OUTER GLOW OPTIONS --- */}
            {activeTab === 'outerGlow' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
                  <span className="font-medium text-[#e5e5e5]">Outer Glow Options</span>
                  <label className="flex items-center space-x-1.5 cursor-pointer text-[#8a8a8a]">
                    <input
                      type="checkbox"
                      checked={outerGlow.enabled}
                      onChange={(e) => setOuterGlow((s) => ({ ...s, enabled: e.target.checked }))}
                    />
                    <span className="text-xs">Enable Glow</span>
                  </label>
                </div>

                {/* Color & Opacity */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <span className="text-[#8a8a8a] block">Color</span>
                    <div className="flex items-center space-x-2">
                      <input
                        type="color"
                        value={outerGlow.color}
                        onChange={(e) => setOuterGlow((s) => ({ ...s, color: e.target.value }))}
                        className="w-7 h-7 rounded border border-white/[0.1] bg-transparent cursor-pointer"
                      />
                      <input
                        type="text"
                        value={outerGlow.color}
                        onChange={(e) => setOuterGlow((s) => ({ ...s, color: e.target.value }))}
                        className="w-20 px-2 py-1 bg-[#161616] border border-white/[0.08] rounded font-mono text-xs text-[#e5e5e5]"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-[#8a8a8a]">Opacity</span>
                      <span className="font-mono text-[#e5e5e5]">{Math.round(outerGlow.opacity * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={outerGlow.opacity}
                      onChange={(e) => setOuterGlow((s) => ({ ...s, opacity: Number(e.target.value) }))}
                      className="w-full"
                    />
                  </div>
                </div>

                {/* Spread */}
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-[#8a8a8a]">Spread</span>
                    <span className="font-mono text-[#e5e5e5]">{outerGlow.spread}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={outerGlow.spread}
                    onChange={(e) => setOuterGlow((s) => ({ ...s, spread: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>

                {/* Size / Blur */}
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <span className="text-[#8a8a8a]">Size (Blur)</span>
                    <span className="font-mono text-[#e5e5e5]">{outerGlow.blur} px</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={outerGlow.blur}
                    onChange={(e) => setOuterGlow((s) => ({ ...s, blur: Number(e.target.value) }))}
                    className="w-full"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#161616] border-t border-[#2c2c2c]">
          <button
            type="button"
            onClick={handleResetDefaults}
            className="px-3 py-1.5 text-xs text-[#8a8a8a] hover:text-[#e5e5e5] bg-[#202020] hover:bg-[#2c2c2c] rounded border border-[#2c2c2c] transition-colors cursor-pointer"
          >
            Reset Category
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs font-medium text-[#e5e5e5] bg-[#2a2a2a] hover:bg-[#363636] rounded transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className="px-4 py-1.5 text-xs font-medium bg-[var(--accent)] text-[var(--accent-contrast)] hover:opacity-90 rounded transition-opacity cursor-pointer"
            >
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
