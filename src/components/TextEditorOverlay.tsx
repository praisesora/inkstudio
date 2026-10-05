import React, { useRef, useState } from 'react';
import { TextSettings } from '../types/editor';
import {
  Check,
  Bold,
  Italic,
  AlignLeft,
  AlignCenter,
  AlignRight,
  GripHorizontal,
} from 'lucide-react';

interface TextEditorOverlayProps {
  x: number;
  y: number;
  settings: TextSettings;
  zoom: number;
  onUpdateSettings: (updater: (prev: TextSettings) => TextSettings) => void;
  onMove: (newX: number, newY: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export const MANGA_FONTS = [
  { id: "'Neucha', 'Anime Ace', 'Comic Sans MS', sans-serif", label: 'Manga / Anime (RU/EN)' },
  { id: "'Anime Ace', 'Comic Sans MS', sans-serif", label: 'Anime Ace (Comic)' },
  { id: "'Comic Sans MS', cursive, sans-serif", label: 'Comic Sans MS' },
  { id: 'Arial, sans-serif', label: 'Arial' },
  { id: 'Impact, sans-serif', label: 'Impact' },
  { id: "'Times New Roman', serif", label: 'Times New Roman' },
  { id: 'Georgia, serif', label: 'Georgia' },
];

export const TextEditorOverlay: React.FC<TextEditorOverlayProps> = ({
  x,
  y,
  settings,
  zoom,
  onUpdateSettings,
  onMove,
  onConfirm,
  onCancel,
}) => {
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ clientX: number; clientY: number; initX: number; initY: number }>({
    clientX: 0,
    clientY: 0,
    initX: x,
    initY: y,
  });

  const [activeTab, setActiveTab] = useState<'text' | 'style'>('text');

  const handleDragDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    isDraggingRef.current = true;
    dragStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      initX: x,
      initY: y,
    };
  };

  const handleDragMove = (e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;
    const dx = (e.clientX - dragStartRef.current.clientX) / zoom;
    const dy = (e.clientY - dragStartRef.current.clientY) / zoom;
    onMove(Math.round(dragStartRef.current.initX + dx), Math.round(dragStartRef.current.initY + dy));
  };

  const handleDragUp = (e: React.PointerEvent) => {
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
      className="absolute z-40 select-none"
      style={{
        left: `${x}px`,
        top: `${y}px`,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Live Text Preview on Canvas */}
      <div
        className="pointer-events-none mb-2 border border-dashed border-cyan-400/60 p-1.5 min-w-[120px] bg-black/10 rounded"
        style={{
          fontFamily: settings.fontFamily,
          fontSize: `${settings.fontSize}px`,
          fontWeight: settings.bold ? 'bold' : 'normal',
          fontStyle: settings.italic ? 'italic' : 'normal',
          textAlign: settings.align,
          color: settings.color,
          lineHeight: 1.25,
          writingMode: settings.writingMode === 'vertical-rl' ? 'vertical-rl' : 'horizontal-tb',
          textOrientation: 'mixed',
          textShadow: settings.outline
            ? `
                -${settings.outlineWidth}px -${settings.outlineWidth}px 0 ${settings.outlineColor},
                 ${settings.outlineWidth}px -${settings.outlineWidth}px 0 ${settings.outlineColor},
                -${settings.outlineWidth}px  ${settings.outlineWidth}px 0 ${settings.outlineColor},
                 ${settings.outlineWidth}px  ${settings.outlineWidth}px 0 ${settings.outlineColor}
              `
            : 'none',
          whiteSpace: 'pre-wrap',
        }}
      >
        {settings.text || <span className="opacity-40 italic">Type manga text here...</span>}
      </div>

      {/* Floating Tool Panel */}
      <div
        className="w-80 bg-[#1e1f22] border border-[#383a40] rounded-md shadow-2xl overflow-hidden flex flex-col"
        style={{
          transform: `scale(${zoom > 0 ? 1 / zoom : 1})`,
          transformOrigin: 'top left',
        }}
      >
        {/* Header Draggable Bar */}
        <div
          onPointerDown={handleDragDown}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragUp}
          className="bg-[#18191c] px-3 py-1.5 border-b border-[#2b2d31] flex items-center justify-between cursor-move text-xs text-[#999999]"
        >
          <div className="flex items-center space-x-1.5 font-medium text-white">
            <GripHorizontal className="w-3.5 h-3.5 text-[#777777]" />
            <span>Manga Text Tool</span>
          </div>

          <div className="flex items-center space-x-1">
            <button
              onClick={() => setActiveTab('text')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                activeTab === 'text' ? 'bg-[#2b2d31] text-white' : 'text-[#888888] hover:text-[#cccccc]'
              }`}
            >
              Content
            </button>
            <button
              onClick={() => setActiveTab('style')}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                activeTab === 'style' ? 'bg-[#2b2d31] text-white' : 'text-[#888888] hover:text-[#cccccc]'
              }`}
            >
              Style
            </button>
          </div>
        </div>

        {/* Tab 1: Text Content */}
        {activeTab === 'text' && (
          <div className="p-3 space-y-2.5">
            <textarea
              autoFocus
              value={settings.text}
              onChange={(e) => onUpdateSettings((prev) => ({ ...prev, text: e.target.value }))}
              placeholder="Enter text (multiline supported)..."
              rows={3}
              className="w-full bg-[#141517] text-white text-xs border border-[#383a40] rounded p-2 focus:border-cyan-500 focus:outline-none resize-none font-mono"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  onConfirm();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  onCancel();
                }
              }}
            />

            <div className="flex items-center space-x-2">
              <label className="text-[11px] text-[#999999] w-16 shrink-0">Font:</label>
              <select
                value={settings.fontFamily}
                onChange={(e) => onUpdateSettings((prev) => ({ ...prev, fontFamily: e.target.value }))}
                className="flex-1 bg-[#141517] text-white text-xs border border-[#383a40] rounded px-2 py-1 focus:border-cyan-500 focus:outline-none"
              >
                {MANGA_FONTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center space-x-2">
              <label className="text-[11px] text-[#999999] w-16 shrink-0">Size: {settings.fontSize}px</label>
              <input
                type="range"
                min={10}
                max={160}
                value={settings.fontSize}
                onChange={(e) => onUpdateSettings((prev) => ({ ...prev, fontSize: Number(e.target.value) }))}
                className="flex-1 accent-cyan-400"
              />
            </div>
          </div>
        )}

        {/* Tab 2: Style & Manga Bubble Outline */}
        {activeTab === 'style' && (
          <div className="p-3 space-y-3">
            {/* Formatting toggles */}
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-1">
                <button
                  onClick={() => onUpdateSettings((prev) => ({ ...prev, bold: !prev.bold }))}
                  title="Bold"
                  className={`p-1.5 rounded transition-colors ${
                    settings.bold ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'text-[#888888] hover:text-white hover:bg-[#2b2d31]'
                  }`}
                >
                  <Bold className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => onUpdateSettings((prev) => ({ ...prev, italic: !prev.italic }))}
                  title="Italic"
                  className={`p-1.5 rounded transition-colors ${
                    settings.italic ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'text-[#888888] hover:text-white hover:bg-[#2b2d31]'
                  }`}
                >
                  <Italic className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Writing Direction (Horizontal vs Vertical Manga Tate-gaki) */}
              <div className="flex items-center space-x-1 bg-[#141517] p-0.5 rounded border border-[#2b2d31]">
                <button
                  onClick={() => onUpdateSettings((prev) => ({ ...prev, writingMode: 'horizontal-tb' }))}
                  title="Horizontal Layout (Left-to-Right)"
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    settings.writingMode !== 'vertical-rl' ? 'bg-[#2b2d31] text-cyan-300' : 'text-[#888888] hover:text-white'
                  }`}
                >
                  Horiz
                </button>
                <button
                  onClick={() => onUpdateSettings((prev) => ({ ...prev, writingMode: 'vertical-rl' }))}
                  title="Vertical Layout (Manga Tate-gaki: Right-to-Left columns)"
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    settings.writingMode === 'vertical-rl' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' : 'text-[#888888] hover:text-white'
                  }`}
                >
                  Vert 縦
                </button>
              </div>

              {/* Alignments */}
              <div className="flex items-center space-x-1 bg-[#141517] p-0.5 rounded border border-[#2b2d31]">
                <button
                  onClick={() => onUpdateSettings((prev) => ({ ...prev, align: 'left' }))}
                  title="Align Left"
                  className={`p-1 rounded ${settings.align === 'left' ? 'bg-[#2b2d31] text-white' : 'text-[#888888] hover:text-white'}`}
                >
                  <AlignLeft className="w-3 h-3" />
                </button>
                <button
                  onClick={() => onUpdateSettings((prev) => ({ ...prev, align: 'center' }))}
                  title="Align Center"
                  className={`p-1 rounded ${settings.align === 'center' ? 'bg-[#2b2d31] text-white' : 'text-[#888888] hover:text-white'}`}
                >
                  <AlignCenter className="w-3 h-3" />
                </button>
                <button
                  onClick={() => onUpdateSettings((prev) => ({ ...prev, align: 'right' }))}
                  title="Align Right"
                  className={`p-1 rounded ${settings.align === 'right' ? 'bg-[#2b2d31] text-white' : 'text-[#888888] hover:text-white'}`}
                >
                  <AlignRight className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Manga Outline Option */}
            <div className="space-y-1.5 border-t border-[#2b2d31] pt-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[#cccccc] font-medium">Manga Speech Bubble Outline</span>
                <input
                  type="checkbox"
                  checked={settings.outline}
                  onChange={(e) => onUpdateSettings((prev) => ({ ...prev, outline: e.target.checked }))}
                  className="rounded accent-cyan-400 cursor-pointer"
                />
              </div>

              {settings.outline && (
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[11px] text-[#999999]">Outline Width: {settings.outlineWidth}px</span>
                    <input
                      type="range"
                      min={1}
                      max={12}
                      value={settings.outlineWidth}
                      onChange={(e) => onUpdateSettings((prev) => ({ ...prev, outlineWidth: Number(e.target.value) }))}
                      className="w-32 accent-cyan-400"
                    />
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-[11px] text-[#999999]">Outline Color:</span>
                    <button
                      onClick={() => onUpdateSettings((prev) => ({ ...prev, outlineColor: '#ffffff' }))}
                      className={`w-5 h-5 rounded border ${settings.outlineColor === '#ffffff' ? 'border-cyan-400 ring-1 ring-cyan-400' : 'border-[#555555]'}`}
                      style={{ backgroundColor: '#ffffff' }}
                      title="White outline"
                    />
                    <button
                      onClick={() => onUpdateSettings((prev) => ({ ...prev, outlineColor: '#000000' }))}
                      className={`w-5 h-5 rounded border ${settings.outlineColor === '#000000' ? 'border-cyan-400 ring-1 ring-cyan-400' : 'border-[#555555]'}`}
                      style={{ backgroundColor: '#000000' }}
                      title="Black outline"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer Confirm / Cancel */}
        <div className="px-3 py-2 bg-[#18191c] border-t border-[#2b2d31] flex items-center justify-between">
          <span className="text-[10px] text-[#777777]">Ctrl+Enter to Apply</span>
          <div className="flex items-center space-x-2">
            <button
              onClick={onCancel}
              className="px-2.5 py-1 bg-[#2b2d31] hover:bg-[#383a40] text-[#cccccc] rounded text-xs transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="px-3 py-1 bg-[#234b3e] hover:bg-[#2b604f] text-[#55eaab] border border-[#2e6e58] rounded text-xs font-semibold flex items-center space-x-1 transition-colors cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Apply</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
