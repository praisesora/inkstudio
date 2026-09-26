import React, { useState, useRef, useEffect } from 'react';
import {
  Palette,
  Layers,
  History,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Plus,
  Trash2,
  Undo2,
  Redo2,
  Paintbrush,
  Eraser,
  Folder,
  FolderOpen,
  FolderPlus,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Copy,
  FolderInput,
  FolderOutput,
  Box,
} from 'lucide-react';
import { HistoryItemMeta, LayerItem, BlendMode, ToolType, CanvasColorMode, ExpressionColor } from '../types/editor';
import { BLEND_MODES } from '../utils/canvasUtils';
import { ColorPanel } from './ColorPanel';

interface RightSidebarProps {
  primaryColor: string;
  secondaryColor: string;
  onPrimaryColorChange: (color: string, commit?: boolean) => void;
  onSecondaryColorChange: (color: string, commit?: boolean) => void;
  onSwapColors: () => void;
  recentColors: string[];
  historyList: HistoryItemMeta[];
  historyIndex: number;
  onJumpToHistory: (index: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  // Multi-layer management props
  layers: LayerItem[];
  activeLayerId: string;
  onSelectLayer: (id: string) => void;
  onAddLayer: (type?: 'raster' | 'folder') => void;
  onOpen3DLayer?: () => void;
  onDuplicateLayer: (id: string) => void;
  onDeleteLayer: (id: string) => void;
  onToggleVisibility: (id: string) => void;
  onSetOpacity: (id: string, opacity: number) => void;
  onSetBlendMode: (id: string, blendMode: BlendMode) => void;
  onToggleLock: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onRenameLayer: (id: string, name: string) => void;
  onMoveLayer: (id: string, direction: 'up' | 'down') => void;
  onMoveLayerToFolder: (id: string, targetFolderId: string | null) => void;
  onReorderLayers?: (draggedId: string, targetId: string, position: 'above' | 'below' | 'inside') => void;
  // Tone (Screentone) Effect Props
  onToggleTone?: (id: string) => void;
  onSetToneFrequency?: (id: string, frequency: number) => void;
  onSetToneAngle?: (id: string, angle: number) => void;
  onSetToneDotShape?: (id: string, dotShape: 'circle' | 'euclidean') => void;
  // Clip Studio Paint Layer Color (Tint) & Expression Color Props
  onToggleLayerColor?: (id: string) => void;
  onSetLayerColor?: (id: string, color: string) => void;
  onSetLayerSubColor?: (id: string, color: string) => void;
  onSetLayerExpressionColor?: (id: string, mode: ExpressionColor) => void;
  onSetLayerMonoThreshold?: (id: string, threshold: number) => void;
  onSetLayerMonoExpressMode?: (id: string, expressBlack: boolean, expressWhite: boolean) => void;
  onApplyExpressionColor?: (id: string) => void;
  onApplyLayerColor?: (id: string) => void;
  width?: number;
  onWidthChange?: (newWidth: number) => void;
  colorMode?: CanvasColorMode;
  currentTool?: ToolType;
  onSelectTool?: (tool: ToolType) => void;
  hasOpenDocument?: boolean;
  onNewCanvas?: () => void;
  onOpenFile?: () => void;
}

// Clip Studio Paint style Screentone / Halftone icon
const ScreentoneIcon: React.FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
    <circle cx="3.5" cy="3.5" r="1.5" />
    <circle cx="12.5" cy="3.5" r="1.5" />
    <circle cx="8" cy="8" r="2.2" />
    <circle cx="3.5" cy="12.5" r="1.5" />
    <circle cx="12.5" cy="12.5" r="1.5" />
  </svg>
);

// Clip Studio Paint style Expression Color icons matching the screenshot
export const CspColorIcon: React.FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 16 16" className={className} fill="none">
    <circle cx="8" cy="5.2" r="3.2" fill="#ef4444" />
    <circle cx="5.2" cy="10.8" r="3.2" fill="#22c55e" />
    <circle cx="10.8" cy="10.8" r="3.2" fill="#3b82f6" />
    <circle cx="8" cy="8.6" r="1.5" fill="#f59e0b" opacity="0.85" />
  </svg>
);

export const CspGrayIcon: React.FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 16 16" className={className}>
    <circle cx="8" cy="8" r="6" fill="#888888" stroke="#333333" strokeWidth="0.8" />
    <path d="M 8 2 A 6 6 0 0 0 3.76 12.24 L 12.24 3.76 A 6 6 0 0 0 8 2 Z" fill="#444444" />
    <line x1="3.76" y1="12.24" x2="12.24" y2="3.76" stroke="#222222" strokeWidth="0.8" />
  </svg>
);

export const CspMonoIcon: React.FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg viewBox="0 0 16 16" className={className}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1" fill="#1e1e1e" stroke="#555555" strokeWidth="0.8" />
    <polygon points="2.5,13.5 13.5,13.5 2.5,2.5" fill="#d4d4d4" />
    <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" stroke="#444444" strokeWidth="0.8" />
  </svg>
);

export const CspLayerColorIcon: React.FC<{ className?: string; color?: string }> = ({
  className = 'w-3.5 h-3.5',
  color = '#1c73c2',
}) => (
  <svg viewBox="0 0 16 16" className={className}>
    <rect x="2" y="3.5" width="8" height="8" rx="1" fill={color} stroke="#333333" strokeWidth="0.8" />
    <rect x="6" y="6.5" width="8" height="6.5" rx="1" fill="#ffffff" stroke="#333333" strokeWidth="0.8" />
  </svg>
);

export const RightSidebar: React.FC<RightSidebarProps> = React.memo(({
  primaryColor,
  secondaryColor,
  onPrimaryColorChange,
  onSecondaryColorChange,
  onSwapColors,
  recentColors,
  colorMode = 'color',
  currentTool = 'brush',
  onSelectTool,
  historyList,
  historyIndex,
  onJumpToHistory,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  layers,
  activeLayerId,
  onSelectLayer,
  onAddLayer,
  onOpen3DLayer,
  onDuplicateLayer,
  onDeleteLayer,
  onToggleVisibility,
  onSetOpacity,
  onSetBlendMode,
  onToggleLock,
  onToggleCollapse,
  onRenameLayer,
  onMoveLayer,
  onMoveLayerToFolder,
  onReorderLayers,
  onToggleTone,
  onSetToneFrequency,
  onSetToneAngle,
  onSetToneDotShape,
  onToggleLayerColor,
  onSetLayerColor,
  onSetLayerSubColor,
  onSetLayerExpressionColor,
  onSetLayerMonoThreshold,
  onSetLayerMonoExpressMode,
  onApplyExpressionColor,
  onApplyLayerColor,
  width = 320,
  onWidthChange,
  hasOpenDocument = true,
  onNewCanvas,
  onOpenFile,
}) => {
  const [bottomTab, setBottomTab] = useState<'layers' | 'history'>('layers');
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [draggedLayerId, setDraggedLayerId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ id: string; position: 'above' | 'below' | 'inside' } | null>(null);
  const [openFolderMenuLayerId, setOpenFolderMenuLayerId] = useState<string | null>(null);
  const [isToneSettingsOpen, setIsToneSettingsOpen] = useState(false);
  const [isLayerColorSettingsOpen, setIsLayerColorSettingsOpen] = useState(false);
  const [isExpressionMenuOpen, setIsExpressionMenuOpen] = useState(false);
  const expressionMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isExpressionMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (expressionMenuRef.current && !expressionMenuRef.current.contains(e.target as Node)) {
        setIsExpressionMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [isExpressionMenuOpen]);

  // Top Section (Color Panel) Height & Resizer
  const [topHeight, setTopHeight] = useState<number>(() => {
    const saved = localStorage.getItem('sora_paint_right_color_height');
    return saved ? Math.max(160, Math.min(500, parseInt(saved, 10))) : 280;
  });
  const [isDraggingHeight, setIsDraggingHeight] = useState(false);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(0);

  const handleHeightResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingHeight(true);
    dragStartYRef.current = e.clientY;
    dragStartHeightRef.current = topHeight;
  };

  useEffect(() => {
    if (!isDraggingHeight) return;

    const handlePointerMove = (e: PointerEvent) => {
      const delta = e.clientY - dragStartYRef.current;
      const newHeight = Math.max(160, Math.min(600, Math.round(dragStartHeightRef.current + delta)));
      setTopHeight(newHeight);
      localStorage.setItem('sora_paint_right_color_height', String(newHeight));
    };

    const handlePointerUp = () => {
      setIsDraggingHeight(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isDraggingHeight]);

  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = width;
  };

  useEffect(() => {
    if (!isResizing) return;

    const handlePointerMove = (e: PointerEvent) => {
      // Dragging left increases width, dragging right decreases width
      const delta = startXRef.current - e.clientX;
      const newWidth = Math.max(220, Math.min(550, Math.round(startWidthRef.current + delta)));
      if (onWidthChange) {
        onWidthChange(newWidth);
      }
    };

    const handlePointerUp = () => {
      setIsResizing(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isResizing, onWidthChange]);

  const activeLayer = hasOpenDocument ? (layers.find((l) => l.id === activeLayerId) || layers[0]) : undefined;
  const folders = layers.filter((l) => l.type === 'folder');

  const startRename = (layer: LayerItem) => {
    setEditingLayerId(layer.id);
    setEditingName(layer.name);
  };

  const finishRename = () => {
    if (editingLayerId && editingName.trim()) {
      onRenameLayer(editingLayerId, editingName.trim());
    }
    setEditingLayerId(null);
  };

  return (
    <aside
      style={{ width }}
      className="relative bg-[#252526] border-l border-[#333333] flex flex-col text-[#cccccc] text-xs select-none z-10 shrink-0 overflow-hidden"
    >
      {/* Resizable Left Edge (Hover gives col-resize; dragging adjusts panel width) */}
      <div
        onMouseDown={handleResizeMouseDown}
        title="Drag to resize panel width"
        className="group absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-[#5ce1e6]/60 active:bg-[#5ce1e6] transition-colors z-30"
      >
        <div className="w-full h-full opacity-0 group-hover:opacity-100 bg-[#5ce1e6]/60 transition-opacity" />
      </div>
      {/* Scrollable Upper Section: Color & Brush Properties */}
      <div style={{ height: topHeight }} className="overflow-y-auto shrink-0 border-b border-[#333333]">
        {/* 1. Full-Featured Color Palette Panel: Color Wheel & Color Slider (Clip Studio Paint style) */}
        <section className="bg-[#252526]">
          <ColorPanel
            primaryColor={primaryColor}
            secondaryColor={secondaryColor}
            onPrimaryColorChange={onPrimaryColorChange}
            onSecondaryColorChange={onSecondaryColorChange}
            onSwapColors={onSwapColors}
            colorMode={colorMode}
            currentTool={currentTool}
            onSelectTool={onSelectTool}
            recentColors={recentColors}
            containerWidth={width}
          />
        </section>
      </div>

      {/* Resizable Horizontal Divider between Color and Layers */}
      <div
        onMouseDown={handleHeightResizeMouseDown}
        title="Drag to resize height"
        className="group relative h-1.5 w-full cursor-row-resize flex items-center justify-center shrink-0 hover:bg-[#5ce1e6]/40 transition-colors z-20 bg-[#1e1e1e]"
      >
        <div className="w-8 h-0.5 bg-[#3a3d44] group-hover:bg-[#5ce1e6] rounded-full transition-colors" />
      </div>

      {/* 3. Bottom Multi-Panel: Full Layer Management & History Stack */}
      <section className="flex-1 min-h-[160px] border-t border-[#333333] flex flex-col bg-[#222223] overflow-hidden">
        {/* Tab Headers */}
        <div className="bg-[#2a2a2a] px-2 py-1.5 border-b border-[#333333] flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setBottomTab('layers')}
              className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-[2px] font-medium transition-colors ${
                bottomTab === 'layers'
                  ? 'bg-[#383838] text-white border border-[#4a4a4a]'
                  : 'text-[#888888] hover:text-[#cccccc]'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Layers</span>
              <span className="text-[10px] font-mono px-1 rounded bg-[#1e1e1e] text-[#aaaaaa]">
                {hasOpenDocument ? layers.length : 0}
              </span>
            </button>

            <button
              onClick={() => setBottomTab('history')}
              className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-[2px] font-medium transition-colors ${
                bottomTab === 'history'
                  ? 'bg-[#383838] text-white border border-[#4a4a4a]'
                  : 'text-[#888888] hover:text-[#cccccc]'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>History</span>
              <span className="text-[10px] font-mono px-1 rounded bg-[#1e1e1e] text-[#aaaaaa]">
                {hasOpenDocument && historyList.length > 0 ? `${historyIndex + 1}/${historyList.length}` : '0/0'}
              </span>
            </button>
          </div>

          {/* Quick Undo / Redo in tab header if history active */}
          {bottomTab === 'history' && (
            <div className="flex items-center space-x-1">
              <button
                onClick={onUndo}
                disabled={!hasOpenDocument || !canUndo}
                title="Undo (Ctrl+Z)"
                className={`p-1 rounded-[2px] transition-colors ${
                  hasOpenDocument && canUndo
                    ? 'text-[#aaaaaa] hover:text-white hover:bg-[#383838]'
                    : 'text-[#444444] cursor-not-allowed'
                }`}
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onRedo}
                disabled={!hasOpenDocument || !canRedo}
                title="Redo (Ctrl+Y)"
                className={`p-1 rounded-[2px] transition-colors ${
                  hasOpenDocument && canRedo
                    ? 'text-[#aaaaaa] hover:text-white hover:bg-[#383838]'
                    : 'text-[#444444] cursor-not-allowed'
                }`}
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Tab Content 1: Comprehensive Layer Management Panel */}
        {bottomTab === 'layers' && (
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {!hasOpenDocument ? (
              <div className="flex-1 flex flex-col items-center justify-center p-4 text-center select-none text-[#777777]">
                <Layers className="w-8 h-8 mb-2 opacity-30 text-[#aaaaaa]" />
                <p className="text-xs text-[#aaaaaa] font-medium">No Project Open</p>
                <p className="text-[11px] text-[#666666] mt-1 max-w-[200px]">
                  Create a new canvas or open a file to manage layers.
                </p>
                {(onNewCanvas || onOpenFile) && (
                  <div className="flex items-center space-x-2 mt-3.5">
                    {onNewCanvas && (
                      <button
                        onClick={onNewCanvas}
                        className="px-2.5 py-1 text-[11px] bg-[#2d2d30] hover:bg-[#38383c] hover:text-white text-[#cccccc] border border-[#3e3e42] rounded-[3px] transition-colors cursor-pointer"
                      >
                        New Canvas
                      </button>
                    )}
                    {onOpenFile && (
                      <button
                        onClick={onOpenFile}
                        className="px-2.5 py-1 text-[11px] bg-[#2d2d30] hover:bg-[#38383c] hover:text-white text-[#cccccc] border border-[#3e3e42] rounded-[3px] transition-colors cursor-pointer"
                      >
                        Open File
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <>
                {/* Active Layer Blend Mode & Opacity Controls */}
                {/* Active Layer Blend Mode, Opacity & Tone Property Controls */}
                {activeLayer && (
                  <div className="px-2.5 py-1.5 bg-[#252526] border-b border-[#333333] flex flex-col space-y-1.5 shrink-0 max-h-[48%] overflow-y-auto">
                    {/* Blend Mode & Opacity */}
                    <div className="flex items-center space-x-2">
                      {/* Blend Mode Dropdown */}
                      <div className="w-1/2">
                        <select
                          value={activeLayer.blendMode}
                          onChange={(e) => onSetBlendMode(activeLayer.id, e.target.value as BlendMode)}
                          className="w-full bg-[#1e1e1e] border border-[#3a3a3a] text-[#cccccc] text-[11px] rounded-[2px] px-1.5 py-0.5 outline-none cursor-pointer hover:border-[#555555]"
                          title="Active Layer Blending Mode"
                        >
                          {BLEND_MODES.map((mode) => (
                            <option key={mode.value} value={mode.value}>
                              {mode.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      {/* Opacity Slider */}
                      <div className="w-1/2 flex items-center space-x-1.5">
                        <span className="text-[10px] text-[#777777]">Op:</span>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={activeLayer.opacity}
                          onChange={(e) => onSetOpacity(activeLayer.id, parseFloat(e.target.value))}
                          className="flex-1 cursor-pointer h-3"
                          title={`Layer Opacity: ${Math.round(activeLayer.opacity * 100)}%`}
                        />
                        <span className="text-[10px] font-mono text-[#aaaaaa] w-7 text-right">
                          {Math.round(activeLayer.opacity * 100)}%
                        </span>
                      </div>
                    </div>

                    {/* Clip Studio Paint Style Effect Toggle & Controls (Tone & Layer Color) */}
                    {activeLayer.type !== 'folder' && (
                      <div className="pt-1 border-t border-[#333333]/70 flex flex-col space-y-1">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-1.5 flex-wrap gap-y-1">
                            <span className="text-[10px] uppercase font-semibold tracking-wider text-[#888888]">Effect:</span>

                            {/* Tone (Screentone) Effect Toggle */}
                            <button
                              type="button"
                              onClick={() => {
                                const willEnable = !activeLayer.toneEnabled;
                                onToggleTone?.(activeLayer.id);
                                if (willEnable) {
                                  setIsToneSettingsOpen(true);
                                }
                              }}
                              title={
                                activeLayer.toneEnabled
                                  ? 'Tone is active (Click to disable and restore smooth drawing)'
                                  : 'Convert Layer to Screentone (Clip Studio Paint style halftone effect)'
                              }
                              className={`flex items-center space-x-1.5 px-2 py-0.5 rounded text-[11px] font-medium transition-all cursor-pointer ${
                                activeLayer.toneEnabled
                                  ? 'bg-amber-500/25 text-amber-300 border border-amber-500/50 shadow-sm'
                                  : 'bg-[#1e1e1e] text-[#888888] hover:text-[#cccccc] hover:bg-[#2a2a2a] border border-[#3a3a3a]'
                              }`}
                            >
                              <ScreentoneIcon className={`w-3 h-3 ${activeLayer.toneEnabled ? 'text-amber-400' : 'text-[#888888]'}`} />
                              <span>Tone</span>
                            </button>

                            {/* Layer Color (Tint) Effect Toggle */}
                            <button
                              type="button"
                              onClick={() => {
                                const willEnable = !activeLayer.layerColorEnabled;
                                onToggleLayerColor?.(activeLayer.id);
                                if (willEnable) {
                                  setIsLayerColorSettingsOpen(true);
                                }
                              }}
                              title={
                                activeLayer.layerColorEnabled
                                  ? 'Layer color tint is active (Click to disable)'
                                  : 'Apply tint to layer (Clip Studio Paint style Layer Color effect)'
                              }
                              className={`flex items-center space-x-1.5 px-2 py-0.5 rounded text-[11px] font-medium transition-all cursor-pointer ${
                                activeLayer.layerColorEnabled
                                  ? 'bg-blue-500/25 text-blue-300 border border-blue-500/50 shadow-sm'
                                  : 'bg-[#1e1e1e] text-[#888888] hover:text-[#cccccc] hover:bg-[#2a2a2a] border border-[#3a3a3a]'
                              }`}
                            >
                              <CspLayerColorIcon className="w-3 h-3" color={activeLayer.layerColor || '#1c73c2'} />
                              <span>Layer color</span>
                            </button>
                          </div>

                          {/* Quick Settings Expand/Collapse Icons */}
                          <div className="flex items-center space-x-1">
                            {activeLayer.toneEnabled && (
                              <button
                                type="button"
                                onClick={() => setIsToneSettingsOpen((prev) => !prev)}
                                title={isToneSettingsOpen ? 'Hide tone settings' : 'Show tone settings'}
                                className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-[#1e1e1e] hover:bg-[#2a2a2a] border border-[#3a3a3a] text-amber-400/90 font-mono text-[10px] transition-colors cursor-pointer"
                              >
                                <span>{activeLayer.toneFrequency ?? 60}L</span>
                                {isToneSettingsOpen ? (
                                  <ChevronUp className="w-3 h-3 text-[#aaaaaa]" />
                                ) : (
                                  <ChevronDown className="w-3 h-3 text-[#aaaaaa]" />
                                )}
                              </button>
                            )}

                            {activeLayer.layerColorEnabled && (
                              <button
                                type="button"
                                onClick={() => setIsLayerColorSettingsOpen((prev) => !prev)}
                                title={isLayerColorSettingsOpen ? 'Hide tint settings' : 'Show tint settings'}
                                className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-[#1e1e1e] hover:bg-[#2a2a2a] border border-[#3a3a3a] text-blue-400/90 font-mono text-[10px] transition-colors cursor-pointer"
                              >
                                <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: activeLayer.layerColor || '#1c73c2' }} />
                                {isLayerColorSettingsOpen ? (
                                  <ChevronUp className="w-3 h-3 text-[#aaaaaa]" />
                                ) : (
                                  <ChevronDown className="w-3 h-3 text-[#aaaaaa]" />
                                )}
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Tone Settings Controls */}
                        {activeLayer.toneEnabled && isToneSettingsOpen && (
                          <div className="p-1.5 bg-[#1b1b1b] rounded border border-[#333333] flex flex-col space-y-1.5 mt-0.5">
                            {/* Frequency (Lines / LPI) */}
                            <div>
                              <div className="flex items-center justify-between text-[10px] mb-0.5">
                                <span className="text-[#999999] font-medium">Frequency (LPI):</span>
                                <span className="font-mono text-amber-300 font-bold">{activeLayer.toneFrequency ?? 60}</span>
                              </div>
                              <input
                                type="range"
                                min="20"
                                max="85"
                                step="1"
                                value={activeLayer.toneFrequency ?? 60}
                                onChange={(e) => onSetToneFrequency?.(activeLayer.id, parseInt(e.target.value, 10))}
                                className="w-full cursor-pointer h-1.5 accent-amber-400"
                              />
                              <div className="flex items-center justify-between text-[8px] text-[#666666] mt-0.5 font-mono">
                                {[28, 42.5, 50, 60, 70, 85].map((preset) => (
                                  <button
                                    key={preset}
                                    type="button"
                                    onClick={() => onSetToneFrequency?.(activeLayer.id, preset)}
                                    className={`hover:text-amber-300 transition-colors ${
                                      (activeLayer.toneFrequency ?? 60) === preset ? 'text-amber-400 font-bold' : ''
                                    }`}
                                  >
                                    {preset}
                                  </button>
                                ))}
                              </div>
                            </div>

                            {/* Angle Slider 0° to 90° */}
                            <div>
                              <div className="flex items-center justify-between text-[10px] mb-0.5">
                                <span className="text-[#999999] font-medium">Angle:</span>
                                <span className="font-mono text-amber-300 font-bold">{activeLayer.toneAngle ?? 45}°</span>
                              </div>
                              <input
                                type="range"
                                min="0"
                                max="90"
                                step="1"
                                value={activeLayer.toneAngle ?? 45}
                                onChange={(e) => onSetToneAngle?.(activeLayer.id, parseInt(e.target.value, 10))}
                                className="w-full cursor-pointer h-1.5 accent-amber-400"
                              />
                              <div className="flex items-center justify-between text-[8px] text-[#666666] mt-0.5 font-mono">
                                {[0, 30, 45, 60, 90].map((preset) => (
                                  <button
                                    key={preset}
                                    type="button"
                                    onClick={() => onSetToneAngle?.(activeLayer.id, preset)}
                                    className={`hover:text-amber-300 transition-colors ${
                                      (activeLayer.toneAngle ?? 45) === preset ? 'text-amber-400 font-bold' : ''
                                    }`}
                                  >
                                    {preset}°
                                  </button>
                                ))}
                              </div>
                            </div>

                            {/* Dot Shape */}
                            <div className="flex items-center justify-between text-[10px]">
                              <span className="text-[#999999] font-medium">Dot Shape:</span>
                              <select
                                value={activeLayer.toneDotShape ?? 'circle'}
                                onChange={(e) => onSetToneDotShape?.(activeLayer.id, e.target.value as 'circle' | 'euclidean')}
                                className="bg-[#252526] border border-[#3a3a3a] text-[#cccccc] text-[10px] rounded px-1.5 py-0.5 outline-none cursor-pointer hover:border-[#555555]"
                              >
                                <option value="circle">Circle (Standard CSP)</option>
                                <option value="euclidean">Euclidean (Classic Halftone)</option>
                              </select>
                            </div>
                          </div>
                        )}

                        {/* Layer Color (Tint) Settings Controls */}
                        {activeLayer.layerColorEnabled && isLayerColorSettingsOpen && (
                          <div className="p-1.5 bg-[#1b1b1b] rounded border border-[#333333] flex flex-col space-y-1.5 mt-0.5">
                            {/* Layer Color (Primary Tint) */}
                            <div className="flex items-center justify-between text-[10px]">
                              <span className="text-[#999999]">Layer color:</span>
                              <div className="flex items-center space-x-1.5">
                                <input
                                  type="color"
                                  value={activeLayer.layerColor || '#1c73c2'}
                                  onChange={(e) => onSetLayerColor?.(activeLayer.id, e.target.value)}
                                  className="w-5 h-4 cursor-pointer bg-transparent border-none p-0 rounded"
                                  title="Pick Layer Color"
                                />
                                <input
                                  type="text"
                                  value={activeLayer.layerColor || '#1c73c2'}
                                  onChange={(e) => onSetLayerColor?.(activeLayer.id, e.target.value)}
                                  className="w-16 bg-[#252526] border border-[#3a3a3a] text-[#cccccc] text-[9px] font-mono px-1 py-0.5 rounded outline-none"
                                />
                              </div>
                            </div>

                            {/* Sub Color (Secondary Tint) */}
                            <div className="flex items-center justify-between text-[10px]">
                              <span className="text-[#999999]">Sub color:</span>
                              <div className="flex items-center space-x-1.5">
                                <input
                                  type="color"
                                  value={activeLayer.layerSubColor || '#ffffff'}
                                  onChange={(e) => onSetLayerSubColor?.(activeLayer.id, e.target.value)}
                                  className="w-5 h-4 cursor-pointer bg-transparent border-none p-0 rounded"
                                  title="Pick Sub Color"
                                />
                                <input
                                  type="text"
                                  value={activeLayer.layerSubColor || '#ffffff'}
                                  onChange={(e) => onSetLayerSubColor?.(activeLayer.id, e.target.value)}
                                  className="w-16 bg-[#252526] border border-[#3a3a3a] text-[#cccccc] text-[9px] font-mono px-1 py-0.5 rounded outline-none"
                                />
                              </div>
                            </div>

                            {/* CSP Classic Presets */}
                            <div className="flex items-center justify-between text-[8px] pt-0.5">
                              <span className="text-[#777777]">Presets:</span>
                              <div className="flex items-center space-x-1 font-mono">
                                {[
                                  { label: 'Cyan', color: '#1c73c2' },
                                  { label: 'Red', color: '#e04b4b' },
                                  { label: 'Sepia', color: '#8a5a36' },
                                  { label: 'Purple', color: '#6355a4' },
                                ].map((preset) => (
                                  <button
                                    key={preset.label}
                                    type="button"
                                    onClick={() => onSetLayerColor?.(activeLayer.id, preset.color)}
                                    className="px-1 py-0.2 rounded bg-[#252526] hover:bg-[#333333] border border-[#444444] text-[8px] text-[#cccccc] cursor-pointer"
                                  >
                                    {preset.label}
                                  </button>
                                ))}
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => onApplyLayerColor?.(activeLayer.id)}
                              className="w-full text-center py-1 px-2 rounded bg-[#252526] hover:bg-[#333333] border border-[#444444] text-blue-300 hover:text-blue-200 text-[10px] font-medium transition-colors cursor-pointer mt-0.5"
                              title="Permanently bake layer color tint into pixels"
                            >
                              Apply tint to layer permanently
                            </button>
                          </div>
                        )}

                        {/* Clip Studio Paint Style ―Expression color― Section */}
                        <div className="pt-1.5 border-t border-[#333333]/70 flex flex-col space-y-1">
                          <div className="text-[10px] text-[#888888] font-medium tracking-wide">
                            ―Expression color―
                          </div>

                          {/* Custom Dropdown matching CSP screenshot */}
                          <div className="relative" ref={expressionMenuRef}>
                            <button
                              type="button"
                              onClick={() => setIsExpressionMenuOpen((prev) => !prev)}
                              className="w-full bg-[#2a2a2a] hover:bg-[#323232] border border-[#444444] rounded px-2 py-1 flex items-center justify-between text-xs text-[#cccccc] cursor-pointer transition-colors shadow-xs"
                              title="Expression color: Color, Gray, or Monochrome"
                            >
                              <div className="flex items-center space-x-2">
                                {(activeLayer.expressionColor || 'color') === 'monochrome' ? (
                                  <CspMonoIcon className="w-3.5 h-3.5" />
                                ) : (activeLayer.expressionColor || 'color') === 'gray' ? (
                                  <CspGrayIcon className="w-3.5 h-3.5" />
                                ) : (
                                  <CspColorIcon className="w-3.5 h-3.5" />
                                )}
                                <span className="capitalize font-medium">
                                  {(activeLayer.expressionColor || 'color') === 'monochrome'
                                    ? 'Monochrome'
                                    : (activeLayer.expressionColor || 'color') === 'gray'
                                    ? 'Gray'
                                    : 'Color'}
                                </span>
                              </div>
                              <ChevronDown className="w-3.5 h-3.5 text-[#888888]" />
                            </button>

                            {/* Dropdown popup with selection background matching CSP screenshot */}
                            {isExpressionMenuOpen && (
                              <div className="absolute top-full left-0 right-0 mt-1 bg-[#252526] border border-[#444444] rounded shadow-2xl z-50 overflow-hidden text-xs py-0.5">
                                {[
                                  { mode: 'color' as ExpressionColor, label: 'Color', icon: <CspColorIcon className="w-3.5 h-3.5" /> },
                                  { mode: 'gray' as ExpressionColor, label: 'Gray', icon: <CspGrayIcon className="w-3.5 h-3.5" /> },
                                  { mode: 'monochrome' as ExpressionColor, label: 'Monochrome', icon: <CspMonoIcon className="w-3.5 h-3.5" /> },
                                ].map((item) => {
                                  const isSelected = (activeLayer.expressionColor || 'color') === item.mode;
                                  return (
                                    <button
                                      key={item.mode}
                                      type="button"
                                      onClick={() => {
                                        onSetLayerExpressionColor?.(activeLayer.id, item.mode);
                                        setIsExpressionMenuOpen(false);
                                      }}
                                      className={`w-full flex items-center space-x-2 px-2.5 py-1.5 cursor-pointer text-left transition-colors ${
                                        isSelected
                                          ? 'bg-[#3b4b61] text-white font-medium'
                                          : 'text-[#cccccc] hover:bg-[#2f3542] hover:text-white'
                                      }`}
                                    >
                                      {item.icon}
                                      <span>{item.label}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>

                          {/* Monochrome Controls when activeLayer.expressionColor === 'monochrome' */}
                          {(activeLayer.expressionColor || 'color') === 'monochrome' && (
                            <div className="p-1.5 bg-[#1b1b1b] rounded border border-[#333333] flex flex-col space-y-1.5 mt-0.5">
                              <div>
                                <div className="flex items-center justify-between text-[10px] mb-0.5">
                                  <span className="text-[#999999]">Color threshold:</span>
                                  <span className="font-mono text-cyan-300 font-bold">{activeLayer.monoThreshold ?? 128}</span>
                                </div>
                                <input
                                  type="range"
                                  min="1"
                                  max="255"
                                  step="1"
                                  value={activeLayer.monoThreshold ?? 128}
                                  onChange={(e) => onSetLayerMonoThreshold?.(activeLayer.id, parseInt(e.target.value, 10))}
                                  className="w-full cursor-pointer h-1.5 accent-cyan-400"
                                />
                              </div>

                              {/* Color to express: Black and White toggles */}
                              <div className="flex items-center justify-between text-[10px]">
                                <span className="text-[#999999]">Color to express:</span>
                                <div className="flex items-center space-x-1.5">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const nextBlack = !(activeLayer.monoExpressBlack ?? true);
                                      onSetLayerMonoExpressMode?.(activeLayer.id, nextBlack, activeLayer.monoExpressWhite ?? true);
                                    }}
                                    title="Express Black pixels (lines/dark tones)"
                                    className={`flex items-center space-x-1 px-1.5 py-0.5 rounded border text-[10px] cursor-pointer transition-colors ${
                                      (activeLayer.monoExpressBlack ?? true)
                                        ? 'bg-[#111111] text-white border-cyan-500/60 font-bold shadow-xs'
                                        : 'bg-[#222222] text-[#666666] border-[#3a3a3a]'
                                    }`}
                                  >
                                    <span className="w-2 h-2 rounded-xs bg-black border border-[#555555] inline-block" />
                                    <span>Black</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const nextWhite = !(activeLayer.monoExpressWhite ?? true);
                                      onSetLayerMonoExpressMode?.(activeLayer.id, activeLayer.monoExpressBlack ?? true, nextWhite);
                                    }}
                                    title="Express White pixels (if disabled, light pixels become transparent paper!)"
                                    className={`flex items-center space-x-1 px-1.5 py-0.5 rounded border text-[10px] cursor-pointer transition-colors ${
                                      (activeLayer.monoExpressWhite ?? true)
                                        ? 'bg-[#333333] text-white border-cyan-500/60 font-bold shadow-xs'
                                        : 'bg-[#222222] text-[#666666] border-[#3a3a3a]'
                                    }`}
                                  >
                                    <span className="w-2 h-2 rounded-xs bg-white border border-[#777777] inline-block" />
                                    <span>White</span>
                                  </button>
                                </div>
                              </div>

                              <button
                                type="button"
                                onClick={() => onApplyExpressionColor?.(activeLayer.id)}
                                className="w-full text-center py-1 px-2 rounded bg-[#252526] hover:bg-[#333333] border border-[#444444] text-cyan-300 hover:text-cyan-200 text-[10px] font-medium transition-colors cursor-pointer mt-1"
                                title="Permanently bake monochrome threshold into this layer"
                              >
                                Apply expression color of preview
                              </button>
                            </div>
                          )}

                          {/* Grayscale Controls when activeLayer.expressionColor === 'gray' */}
                          {(activeLayer.expressionColor || 'color') === 'gray' && (
                            <div className="p-1.5 bg-[#1b1b1b] rounded border border-[#333333] flex flex-col space-y-1 mt-0.5">
                              <div className="text-[10px] text-[#888888]">
                                Converted to 8-bit grayscale (256 shades).
                              </div>
                              <button
                                type="button"
                                onClick={() => onApplyExpressionColor?.(activeLayer.id)}
                                className="w-full text-center py-1 px-2 rounded bg-[#252526] hover:bg-[#333333] border border-[#444444] text-cyan-300 hover:text-cyan-200 text-[10px] font-medium transition-colors cursor-pointer"
                                title="Permanently bake grayscale into this layer"
                              >
                                Apply expression color of preview
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

            {/* Layer Action Bar: Add Layer, Add Folder, Duplicate, Delete, Move Up/Down, Lock */}
            <div className="px-2.5 py-1 bg-[#1e1e1e] border-b border-[#2d2d2d] flex items-center justify-between text-[#888888] shrink-0">
              <div className="flex items-center space-x-1">
                {/* Add Raster Layer */}
                <button
                  onClick={() => onAddLayer('raster')}
                  title="New Layer"
                  className="flex items-center space-x-1 px-1.5 py-0.5 hover:text-white hover:bg-[#333333] rounded-[2px] transition-colors"
                >
                  <Plus className="w-3.5 h-3.5 text-blue-400" />
                  <span className="text-[10px]">Layer</span>
                </button>

                {/* Add Folder */}
                <button
                  onClick={() => onAddLayer('folder')}
                  title="New Folder"
                  className="flex items-center space-x-1 px-1.5 py-0.5 hover:text-white hover:bg-[#333333] rounded-[2px] transition-colors"
                >
                  <FolderPlus className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-[10px]">Folder</span>
                </button>

                {/* Local-Only 3D Viewport Ghost Layer */}
                {onOpen3DLayer && (
                  <button
                    onClick={onOpen3DLayer}
                    title="New 3D Reference Layer (Local Ghost Layer)"
                    className="flex items-center space-x-1 px-1.5 py-0.5 hover:text-white hover:bg-[#333333] rounded-[2px] transition-colors text-purple-400"
                  >
                    <Box className="w-3.5 h-3.5" />
                    <span className="text-[10px]">3D</span>
                  </button>
                )}
              </div>

              <div className="flex items-center space-x-0.5">
                {/* Single-Click Duplicate Active Layer */}
                <button
                  onClick={() => onDuplicateLayer(activeLayerId)}
                  title="Duplicate Layer (Single Click)"
                  className="p-1 text-[#888888] hover:text-white hover:bg-[#333333] rounded-[2px] transition-colors"
                >
                  <Copy className="w-3.5 h-3.5 text-emerald-400" />
                </button>

                {/* Move Up */}
                <button
                  onClick={() => onMoveLayer(activeLayerId, 'up')}
                  title="Move Layer Up"
                  className="p-1 text-[#888888] hover:text-white hover:bg-[#333333] rounded-[2px] transition-colors"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>

                {/* Move Down */}
                <button
                  onClick={() => onMoveLayer(activeLayerId, 'down')}
                  title="Move Layer Down"
                  className="p-1 text-[#888888] hover:text-white hover:bg-[#333333] rounded-[2px] transition-colors"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>

                {/* Toggle Lock */}
                {activeLayer && (
                  <button
                    onClick={() => onToggleLock(activeLayer.id)}
                    title={activeLayer.locked ? 'Unlock Layer' : 'Lock Layer'}
                    className={`p-1 rounded-[2px] transition-colors ${
                      activeLayer.locked ? 'text-amber-400' : 'text-[#888888] hover:text-white'
                    }`}
                  >
                    {activeLayer.locked ? (
                      <Lock className="w-3.5 h-3.5" />
                    ) : (
                      <Unlock className="w-3.5 h-3.5" />
                    )}
                  </button>
                )}

                {/* Delete Active Layer */}
                <button
                  onClick={() => onDeleteLayer(activeLayerId)}
                  title="Delete Layer"
                  className="p-1 text-[#888888] hover:text-rose-400 hover:bg-[#333333] rounded-[2px] transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Scrollable Layer Stack List */}
            <div className="flex-1 overflow-y-auto p-1.5 space-y-1 min-h-0">
              {layers.map((layer) => {
                // If parent folder is collapsed, hide child layers
                if (layer.parentId) {
                  const parentFolder = layers.find((l) => l.id === layer.parentId);
                  if (parentFolder && parentFolder.collapsed) {
                    return null;
                  }
                }

                const isActive = layer.id === activeLayerId;
                const isFolder = layer.type === 'folder';
                const isInsideFolder = !!layer.parentId;
                const isTarget = dropIndicator?.id === layer.id;
                const isDropInside = isTarget && dropIndicator.position === 'inside';
                const isDropAbove = isTarget && dropIndicator.position === 'above';
                const isDropBelow = isTarget && dropIndicator.position === 'below';

                return (
                  <div
                    key={layer.id}
                    draggable={editingLayerId !== layer.id}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', layer.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDraggedLayerId(layer.id);
                    }}
                    onDragEnd={() => {
                      setDraggedLayerId(null);
                      setDropIndicator(null);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!draggedLayerId || draggedLayerId === layer.id) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const yRatio = (e.clientY - rect.top) / rect.height;

                      if (isFolder) {
                        if (yRatio > 0.25 && yRatio < 0.75) {
                          setDropIndicator({ id: layer.id, position: 'inside' });
                        } else if (yRatio <= 0.25) {
                          setDropIndicator({ id: layer.id, position: 'above' });
                        } else {
                          setDropIndicator({ id: layer.id, position: 'below' });
                        }
                      } else {
                        if (yRatio <= 0.5) {
                          setDropIndicator({ id: layer.id, position: 'above' });
                        } else {
                          setDropIndicator({ id: layer.id, position: 'below' });
                        }
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const sourceId = e.dataTransfer.getData('text/plain') || draggedLayerId;
                      if (!sourceId || sourceId === layer.id || !dropIndicator) return;
                      if (onReorderLayers) {
                        onReorderLayers(sourceId, layer.id, dropIndicator.position);
                      }
                      setDropIndicator(null);
                      setDraggedLayerId(null);
                    }}
                    onClick={() => onSelectLayer(layer.id)}
                    className={`group relative flex items-center space-x-1.5 px-2 py-1.5 rounded-[2px] cursor-pointer transition-colors border ${
                      isInsideFolder ? 'ml-4 border-l-2 border-l-[#444444]' : ''
                    } ${
                      isDropInside
                        ? 'border-2 border-amber-400 bg-amber-950/40 shadow-md'
                        : isDropAbove
                        ? 'border-t-2 border-t-blue-500 border-x-transparent border-b-transparent'
                        : isDropBelow
                        ? 'border-b-2 border-b-blue-500 border-x-transparent border-t-transparent'
                        : isActive
                        ? 'bg-[#383838] border-[#555555] text-white shadow-sm'
                        : 'bg-[#242425] hover:bg-[#2b2b2c] border-transparent text-[#cccccc]'
                    }`}
                  >
                    {/* Visibility Eye Toggle */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleVisibility(layer.id);
                      }}
                      title={layer.visible ? 'Hide Layer' : 'Show Layer'}
                      className={`p-0.5 rounded-[2px] transition-colors ${
                        layer.visible
                          ? 'text-[#aaaaaa] hover:text-white'
                          : 'text-[#555555] hover:text-[#888888]'
                      }`}
                    >
                      {layer.visible ? (
                        <Eye className="w-3.5 h-3.5" />
                      ) : (
                        <EyeOff className="w-3.5 h-3.5" />
                      )}
                    </button>

                    {/* Folder Collapse / Expand Chevron */}
                    {isFolder && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleCollapse(layer.id);
                        }}
                        title={layer.collapsed ? 'Expand Folder' : 'Collapse Folder'}
                        className="p-0.5 text-[#888888] hover:text-white"
                      >
                        {layer.collapsed ? (
                          <ChevronRight className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronDown className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}

                    {/* Layer Icon: Folder icon for folders, Layers icon for raster layers */}
                    {isFolder ? (
                      <div className="w-4 h-4 flex items-center justify-center shrink-0 text-amber-400">
                        {layer.collapsed ? (
                          <Folder className="w-4 h-4" />
                        ) : (
                          <FolderOpen className="w-4 h-4" />
                        )}
                      </div>
                    ) : (
                      <div className="w-4 h-4 flex items-center justify-center shrink-0 text-[#888888] group-hover:text-blue-400 transition-colors">
                        <Layers className={`w-3.5 h-3.5 ${isActive ? 'text-blue-400' : ''}`} />
                      </div>
                    )}

                    {/* Live Layer Thumbnail Preview next to Layer Icon (for raster layers) */}
                    {!isFolder && (
                      <div
                        className="w-10 h-7 rounded-[2px] border border-[#484848] overflow-hidden shrink-0 relative flex items-center justify-center shadow-inner"
                        style={{
                          backgroundColor: '#1e1e1e',
                          backgroundImage:
                            layer.id === 'layer-bg'
                              ? 'none'
                              : 'conic-gradient(#2d2d2d 90deg, #1f1f1f 90deg 180deg, #2d2d2d 180deg 270deg, #1f1f1f 270deg)',
                          backgroundSize: '6px 6px',
                        }}
                        title={`Layer content preview for ${layer.name}`}
                      >
                        {layer.thumbnailUrl ? (
                          <img
                            src={layer.thumbnailUrl}
                            alt={layer.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div
                            className="w-full h-full"
                            style={{
                              backgroundColor: layer.id === 'layer-bg' ? '#ffffff' : 'transparent',
                            }}
                          />
                        )}
                      </div>
                    )}

                    {/* Layer Name / Inline Renaming */}
                    <div className="flex-1 min-w-0 flex items-center space-x-1.5">
                      {editingLayerId === layer.id ? (
                        <input
                          type="text"
                          value={editingName}
                          autoFocus
                          onChange={(e) => setEditingName(e.target.value)}
                          onBlur={finishRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') finishRename();
                            if (e.key === 'Escape') setEditingLayerId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="bg-[#1e1e1e] border border-blue-500 rounded px-1 py-0.5 text-xs text-white w-full outline-none"
                        />
                      ) : (
                        <span
                          onDoubleClick={() => startRename(layer)}
                          title={`${layer.name} (Double-click to rename)`}
                          className="text-xs font-medium truncate select-none"
                        >
                          {layer.name}
                        </span>
                      )}

                      {/* Blend Mode Tag if not normal */}
                      {layer.blendMode !== 'normal' && (
                        <span className="text-[9px] px-1 py-0.2 rounded bg-[#1e1e1e] border border-[#3e3e3e] text-indigo-300 font-mono capitalize shrink-0">
                          {layer.blendMode.replace('-', ' ')}
                        </span>
                      )}

                      {/* Opacity Tag if < 100% */}
                      {layer.opacity < 0.99 && (
                        <span className="text-[9px] px-1 py-0.2 rounded bg-[#1e1e1e] text-[#888888] font-mono shrink-0">
                          {Math.round(layer.opacity * 100)}%
                        </span>
                      )}

                      {/* Screentone Indicator Tag */}
                      {layer.toneEnabled && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleTone?.(layer.id);
                          }}
                          className="text-[9px] px-1.5 py-0.5 rounded bg-amber-950/60 border border-amber-600/50 text-amber-300 font-mono flex items-center gap-1 shrink-0 hover:border-amber-400 hover:text-amber-200 transition-colors"
                          title={`Tone: ${layer.toneFrequency ?? 60} LPI, ${layer.toneAngle ?? 45}° (Click to toggle)`}
                        >
                          <ScreentoneIcon className="w-2.5 h-2.5 text-amber-400" />
                          <span>{layer.toneFrequency ?? 60}L</span>
                        </button>
                      )}

                      {/* Layer Color Tint Indicator Tag */}
                      {layer.layerColorEnabled && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleLayerColor?.(layer.id);
                          }}
                          className="text-[9px] px-1.5 py-0.5 rounded bg-blue-950/60 border border-blue-600/50 text-blue-300 font-mono flex items-center gap-1 shrink-0 hover:border-blue-400 hover:text-blue-200 transition-colors cursor-pointer"
                          title={`Tint: ${layer.layerColor || '#1c73c2'} (Click to toggle)`}
                        >
                          <span
                            className="w-2 h-2 rounded-full inline-block shrink-0"
                            style={{ backgroundColor: layer.layerColor || '#1c73c2' }}
                          />
                          <span>Tint</span>
                        </button>
                      )}

                      {/* Expression Color Tag if Gray or Monochrome */}
                      {layer.expressionColor && layer.expressionColor !== 'color' && (
                        <span className="text-[9px] px-1 py-0.2 rounded bg-[#1e1e1e] border border-[#444444] text-cyan-300 font-mono shrink-0">
                          {layer.expressionColor === 'monochrome' ? '1-bit' : 'Gray'}
                        </span>
                      )}
                    </div>

                    {/* Lock Indicator */}
                    {layer.locked && (
                      <Lock className="w-3 h-3 text-[#777777] shrink-0" />
                    )}

                    {/* Hover Quick Actions: Single-Click Duplicate, Move to/from folder, Delete */}
                    <div className="flex items-center space-x-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      {/* Single-Click Duplicate Button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDuplicateLayer(layer.id);
                        }}
                        title="Duplicate (Single Click)"
                        className="p-1 hover:text-emerald-400 hover:bg-[#333333] rounded-[2px]"
                      >
                        <Copy className="w-3 h-3" />
                      </button>

                      {/* Move to folder or move out of folder button */}
                      {isInsideFolder ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onMoveLayerToFolder(layer.id, null);
                          }}
                          title="Move out of Folder"
                          className="p-1 hover:text-amber-400 hover:bg-[#333333] rounded-[2px]"
                        >
                          <FolderOutput className="w-3 h-3" />
                        </button>
                      ) : (
                        folders.length > 0 &&
                        !isFolder && (
                          <div className="relative">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (folders.length === 1) {
                                  onMoveLayerToFolder(layer.id, folders[0].id);
                                } else {
                                  setOpenFolderMenuLayerId(
                                    openFolderMenuLayerId === layer.id ? null : layer.id
                                  );
                                }
                              }}
                              title={
                                folders.length === 1
                                  ? `Move into "${folders[0].name}"`
                                  : 'Move into Folder...'
                              }
                              className="p-1 hover:text-amber-400 hover:bg-[#333333] rounded-[2px]"
                            >
                              <FolderInput className="w-3 h-3" />
                            </button>

                            {/* Dropdown Menu when multiple folders exist */}
                            {openFolderMenuLayerId === layer.id && (
                              <div
                                onClick={(e) => e.stopPropagation()}
                                className="absolute right-0 top-full mt-1 w-40 bg-[#1e1e1e] border border-[#444444] rounded shadow-xl z-50 p-1 text-[11px] space-y-0.5"
                              >
                                <div className="px-2 py-0.5 text-[10px] text-[#888888] font-semibold border-b border-[#2d2d2d]">
                                  Move into:
                                </div>
                                {folders.map((f) => (
                                  <button
                                    key={f.id}
                                    onClick={() => {
                                      onMoveLayerToFolder(layer.id, f.id);
                                      setOpenFolderMenuLayerId(null);
                                    }}
                                    className="w-full text-left flex items-center space-x-1.5 px-2 py-1 rounded hover:bg-[#333333] text-[#cccccc] hover:text-white"
                                  >
                                    <Folder className="w-3 h-3 text-amber-400 shrink-0" />
                                    <span className="truncate">{f.name}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      )}

                      {/* Delete Layer button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteLayer(layer.id);
                        }}
                        title="Delete Layer"
                        className="p-1 hover:text-rose-400 hover:bg-[#333333] rounded-[2px]"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
              </>
            )}
          </div>
        )}

        {/* Tab Content 2: History Stack List */}
        {bottomTab === 'history' && (
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {!hasOpenDocument || historyList.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center p-4 text-center select-none text-[#777777]">
                <History className="w-8 h-8 mb-2 opacity-30 text-[#aaaaaa]" />
                <p className="text-xs text-[#aaaaaa] font-medium">No History</p>
                <p className="text-[11px] text-[#666666] mt-1">
                  {!hasOpenDocument ? 'No project is open.' : 'History will appear as you paint.'}
                </p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-0">
            {historyList.map((item, idx) => {
              const isActive = idx === historyIndex;
              const isPast = idx < historyIndex;
              const isFuture = idx > historyIndex;

              return (
                <div
                  key={item.id}
                  onClick={() => onJumpToHistory(idx)}
                  title={`Jump to step ${idx + 1}: ${item.label} (${item.timeFormatted})`}
                  className={`flex items-center space-x-2.5 px-2 py-1.5 rounded-[2px] cursor-pointer transition-colors ${
                    isActive
                      ? 'bg-[#353535] border border-[#555555] text-white shadow-sm'
                      : isFuture
                      ? 'opacity-35 hover:opacity-75 hover:bg-[#2a2a2a] text-[#777777]'
                      : 'text-[#cccccc] hover:bg-[#2a2a2a]'
                  }`}
                >
                  {/* Step Thumbnail */}
                  <div className="w-9 h-6 rounded-[2px] bg-[#1a1a1a] border border-[#3a3a3a] overflow-hidden shrink-0 flex items-center justify-center">
                    {item.thumbnailUrl ? (
                      <img
                        src={item.thumbnailUrl}
                        alt={item.label}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full bg-white" />
                    )}
                  </div>

                  {/* Step Action Name & Timestamp */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-1.5">
                      {item.type === 'eraser' ? (
                        <Eraser className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      ) : item.type === 'clear' ? (
                        <Trash2 className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                      ) : item.type === 'initial' ? (
                        <Palette className="w-3.5 h-3.5 text-violet-400 shrink-0" />
                      ) : (
                        <Paintbrush className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                      )}
                      <span className="text-xs font-medium truncate">{item.label}</span>
                    </div>
                    <span className="text-[10px] text-[#666666] font-mono block">
                      {item.timeFormatted}
                    </span>
                  </div>

                  {/* Active Indicator Pin */}
                  {isActive && (
                    <div
                      title="Current active state"
                      className="w-2 h-2 rounded-full bg-emerald-400 shrink-0 shadow-[0_0_6px_rgba(52,211,153,0.9)]"
                    />
                  )}
                  {isPast && (
                    <div className="text-[10px] text-[#555555] font-mono shrink-0">
                      #{idx + 1}
                    </div>
                  )}
                </div>
              );
            })}
              </div>
            )}
          </div>
        )}
      </section>
    </aside>
  );
});

RightSidebar.displayName = 'RightSidebar';


