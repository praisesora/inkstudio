import React, { useState, useRef, useEffect } from 'react';
import {
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Plus,
  Trash2,
  Undo2,
  Redo2,
  Folder,
  FolderOpen,
  FolderPlus,
  ChevronRight,
  ChevronDown,
  Copy,
  Box,
  Compass,
  Link2,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import {
  HistoryItemMeta,
  LayerItem,
  BlendMode,
  ToolType,
  CanvasColorMode,
  ExpressionColor,
} from '../types/editor';
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
  layers: LayerItem[];
  activeLayerId: string;
  selectedLayerIds?: string[];
  onSelectLayer: (id: string) => void;
  onToggleLayerSelection?: (id: string, isShift: boolean, isCtrl: boolean) => void;
  onGroupSelectedLayers?: () => void;
  onDeleteSelectedLayers?: () => void;
  onAddLayer: (type?: 'raster' | 'folder') => void;
  onOpen3DLayer?: () => void;
  onDuplicateLayer: (id: string) => void;
  onDeleteLayer: (id: string) => void;
  onToggleVisibility: (id: string) => void;
  onSetOpacity: (id: string, opacity: number) => void;
  onSetBlendMode: (id: string, blendMode: BlendMode) => void;
  onToggleLock: (id: string) => void;
  onToggleAlphaLock?: (id: string) => void;
  onToggleClipping?: (id: string) => void;
  onToggleCollapse: (id: string) => void;
  onRenameLayer: (id: string, name: string) => void;
  onMoveLayer?: (id: string, direction: 'up' | 'down') => void;
  onMoveLayerToFolder: (id: string, targetFolderId: string | null) => void;
  activeEditTarget?: 'layer' | 'mask';
  onSelectEditTarget?: (target: 'layer' | 'mask') => void;
  onAddLayerMask?: (layerId: string) => void;
  onRemoveLayerMask?: (layerId: string, apply?: boolean) => void;
  onToggleLayerMask?: (layerId: string) => void;
  onToggleMaskLinked?: (layerId: string) => void;
  onOpenAdjustmentModal?: (
    layerId?: string,
    initialType?: 'curves' | 'gradient-map' | 'levels' | 'color-balance'
  ) => void;
  onOpenLayerStylesModal?: (layerId: string) => void;
  onReorderLayers?: (draggedId: string, targetId: string, position: 'above' | 'below' | 'inside') => void;
  onToggleReferenceLayer?: (id: string) => void;
  onToggleTone?: (id: string) => void;
  onSetToneFrequency?: (id: string, frequency: number) => void;
  onSetToneAngle?: (id: string, angle: number) => void;
  onSetToneDotShape?: (id: string, dotShape: 'circle' | 'euclidean') => void;
  onSetToneDensity?: (id: string, density: number) => void;
  onSetToneDensityType?: (id: string, densityType: 'specified' | 'image') => void;
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

const ClipToLayerIcon: React.FC<{ className?: string }> = ({ className = 'w-3 h-3' }) => (
  <svg viewBox="0 0 16 16" fill="currentColor" className={className}>
    <path d="M3 2v6a2 2 0 0 0 2 2h4.5v2.5L14 9l-4.5-3.5V8H5V2H3z" />
  </svg>
);

const AlphaLockIcon: React.FC<{ className?: string }> = ({ className = 'w-3 h-3' }) => (
  <svg viewBox="0 0 16 16" className={className} fill="none">
    <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
    <rect x="2.5" y="2.5" width="5.5" height="5.5" fill="currentColor" opacity="0.35" />
    <rect x="8" y="8" width="5.5" height="5.5" fill="currentColor" opacity="0.35" />
    <rect x="5.5" y="7.5" width="5" height="4.5" rx="1" fill="currentColor" />
    <path d="M6.5 7.5V6a1.5 1.5 0 0 1 3 0v1.5" stroke="currentColor" strokeWidth="1.2" />
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
  selectedLayerIds,
  onSelectLayer,
  onToggleLayerSelection,
  onGroupSelectedLayers,
  onDeleteSelectedLayers,
  onAddLayer,
  onOpen3DLayer,
  onDuplicateLayer,
  onDeleteLayer,
  onToggleVisibility,
  onSetOpacity,
  onSetBlendMode,
  onToggleLock,
  onToggleAlphaLock,
  onToggleClipping,
  onToggleCollapse,
  onRenameLayer,
  onReorderLayers,
  activeEditTarget = 'layer',
  onSelectEditTarget,
  onAddLayerMask,
  onRemoveLayerMask,
  onToggleLayerMask,
  onToggleMaskLinked,
  onOpenAdjustmentModal,
  onOpenLayerStylesModal,
  onToggleReferenceLayer,
  onToggleTone,
  onSetToneFrequency,
  onSetToneAngle,
  onSetToneDotShape,
  onSetToneDensity,
  onSetToneDensityType,
  onToggleLayerColor,
  onSetLayerColor,
  onSetLayerSubColor,
  onSetLayerExpressionColor,
  onSetLayerMonoThreshold,
  onSetLayerMonoExpressMode,
  onApplyExpressionColor,
  onApplyLayerColor,
  width = 176,
  onWidthChange,
  hasOpenDocument = true,
  onNewCanvas,
  onOpenFile,
}) => {
  const [bottomTab, setBottomTab] = useState<'layers' | 'history'>('layers');
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>('');
  const [draggedLayerId, setDraggedLayerId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    id: string;
    position: 'above' | 'below' | 'inside';
  } | null>(null);

  // Tucked collapsible accordions for advanced layer settings
  const [isExpressionAccordionOpen, setIsExpressionAccordionOpen] = useState(false);
  const [isEffectsAccordionOpen, setIsEffectsAccordionOpen] = useState(false);

  const [contextMenu, setContextMenu] = useState<{ layerId: string; x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('pointerdown', handleOutsideClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handleOutsideClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  useEffect(() => {
    if (!isResizing) return;
    const handlePointerMove = (e: PointerEvent) => {
      const delta = startXRef.current - e.clientX;
      const newWidth = Math.max(164, Math.min(360, Math.round(startWidthRef.current + delta)));
      onWidthChange?.(newWidth);
    };
    const handlePointerUp = () => setIsResizing(false);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isResizing, onWidthChange]);

  const activeLayer = hasOpenDocument ? layers.find((l) => l.id === activeLayerId) || layers[0] : undefined;

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

  const layerListContainerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ active: boolean; layerId: string | null; startX: number; startY: number }>({
    active: false,
    layerId: null,
    startX: 0,
    startY: 0,
  });
  const dropIndicatorRef = useRef<{ id: string; position: 'above' | 'below' | 'inside' } | null>(null);
  const justDraggedRef = useRef<boolean>(false);

  useEffect(() => {
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, []);

  const handleLayerPointerDown = (e: React.PointerEvent<HTMLDivElement>, layerId: string) => {
    if (e.button !== 0 || editingLayerId !== null) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, [data-no-drag]')) return;

    dragRef.current = { active: false, layerId, startX: e.clientX, startY: e.clientY };
    dropIndicatorRef.current = null;

    let autoScrollTimer: number | null = null;
    const stopAutoScroll = () => {
      if (autoScrollTimer !== null) {
        window.clearInterval(autoScrollTimer);
        autoScrollTimer = null;
      }
    };

    const handlePointerMove = (moveEvt: PointerEvent) => {
      const dx = moveEvt.clientX - dragRef.current.startX;
      const dy = moveEvt.clientY - dragRef.current.startY;

      if (!dragRef.current.active) {
        if (dx * dx + dy * dy >= 16) {
          dragRef.current.active = true;
          setDraggedLayerId(layerId);
          document.body.style.userSelect = 'none';
          document.body.style.cursor = 'grabbing';
        } else {
          return;
        }
      }

      const container = layerListContainerRef.current;
      if (container) {
        const cRect = container.getBoundingClientRect();
        const topDist = moveEvt.clientY - cRect.top;
        const bottomDist = cRect.bottom - moveEvt.clientY;
        stopAutoScroll();
        if (topDist < 32 && topDist > -30 && container.scrollTop > 0) {
          autoScrollTimer = window.setInterval(() => {
            container.scrollTop -= 7;
          }, 16);
        } else if (
          bottomDist < 32 &&
          bottomDist > -30 &&
          container.scrollTop + container.clientHeight < container.scrollHeight
        ) {
          autoScrollTimer = window.setInterval(() => {
            container.scrollTop += 7;
          }, 16);
        }
      }

      const hovered = document.elementFromPoint(moveEvt.clientX, moveEvt.clientY) as HTMLElement | null;
      const row = hovered?.closest('[data-layer-id]') as HTMLElement | null;
      if (!row) {
        if (dropIndicatorRef.current) {
          dropIndicatorRef.current = null;
          setDropIndicator(null);
        }
        return;
      }

      const draggedIds =
        selectedLayerIds && selectedLayerIds.includes(layerId) ? selectedLayerIds : [layerId];
      const targetId = row.dataset.layerId;
      if (!targetId || draggedIds.includes(targetId)) {
        if (dropIndicatorRef.current) {
          dropIndicatorRef.current = null;
          setDropIndicator(null);
        }
        return;
      }

      const targetLayer = layers.find((l) => l.id === targetId);
      if (!targetLayer) return;

      let isDescendant = false;
      for (const dId of draggedIds) {
        const draggedItem = layers.find((l) => l.id === dId);
        if (draggedItem?.type === 'folder') {
          let curr: LayerItem | undefined = targetLayer;
          while (curr) {
            if (curr.id === dId) {
              isDescendant = true;
              break;
            }
            curr = layers.find((l) => l.id === curr?.parentId);
          }
        }
        if (isDescendant) break;
      }
      if (isDescendant) return;

      const rect = row.getBoundingClientRect();
      const yRatio = (moveEvt.clientY - rect.top) / rect.height;
      let position: 'above' | 'below' | 'inside';
      if (targetLayer.type === 'folder') {
        position = yRatio > 0.25 && yRatio < 0.75 ? 'inside' : yRatio <= 0.25 ? 'above' : 'below';
      } else {
        position = yRatio <= 0.5 ? 'above' : 'below';
      }

      const nextIndicator = { id: targetId, position };
      dropIndicatorRef.current = nextIndicator;
      setDropIndicator(nextIndicator);
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      stopAutoScroll();
      document.body.style.userSelect = '';
      document.body.style.cursor = '';

      if (dragRef.current.active) {
        justDraggedRef.current = true;
        setTimeout(() => {
          justDraggedRef.current = false;
        }, 100);

        const currentIndicator = dropIndicatorRef.current;
        const draggedIds =
          selectedLayerIds && selectedLayerIds.includes(layerId) ? selectedLayerIds : [layerId];
        if (currentIndicator && !draggedIds.includes(currentIndicator.id) && onReorderLayers) {
          onReorderLayers(layerId, currentIndicator.id, currentIndicator.position);
        }
      }

      dragRef.current = { active: false, layerId: null, startX: 0, startY: 0 };
      dropIndicatorRef.current = null;
      setDraggedLayerId(null);
      setDropIndicator(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  };

  return (
    <aside
      style={{ width }}
      className="relative bg-[#161616] flex flex-col gap-px text-[#e5e5e5] text-xs select-none z-10 shrink-0 overflow-hidden"
    >
      {/* Left Resize Seam */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          setIsResizing(true);
          startXRef.current = e.clientX;
          startWidthRef.current = width;
        }}
        title="Resize sidebar"
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--accent)]/40 transition-colors z-30"
      />

      {/* 1. Compact Color Wheel (<= 30% of sidebar height) */}
      <section className="h-[28%] max-h-[30%] shrink-0 overflow-hidden bg-[#202020]">
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

      {/* 2. Spacious Layers Panel (>= 70% of sidebar height) */}
      <section className="flex-1 min-h-[70%] flex flex-col bg-[#202020] overflow-hidden">
        {/* Header Bar: Layers / History Switch + Quick Layer Actions */}
        <div className="h-7 px-1.5 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setBottomTab('layers')}
              className={`px-1.5 py-0.5 rounded text-[11px] transition-colors cursor-pointer ${
                bottomTab === 'layers'
                  ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                  : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
              }`}
            >
              Layers
            </button>
            <button
              type="button"
              onClick={() => setBottomTab('history')}
              className={`px-1.5 py-0.5 rounded text-[11px] transition-colors cursor-pointer ${
                bottomTab === 'history'
                  ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                  : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
              }`}
            >
              History
            </button>
          </div>

          {bottomTab === 'layers' && hasOpenDocument && (
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => onAddLayer('raster')}
                title="New Layer (Ctrl+Shift+N)"
                className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (onGroupSelectedLayers && selectedLayerIds && selectedLayerIds.length > 1) {
                    onGroupSelectedLayers();
                  } else {
                    onAddLayer('folder');
                  }
                }}
                title="New Folder / Group (Ctrl+G)"
                className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
              >
                <FolderPlus className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (onDeleteSelectedLayers && selectedLayerIds && selectedLayerIds.length > 1) {
                    onDeleteSelectedLayers();
                  } else {
                    onDeleteLayer(activeLayerId);
                  }
                }}
                title="Delete Layer"
                className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-red-400 hover:bg-[#2c2c2c] cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          )}

          {bottomTab === 'history' && (
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={onUndo}
                disabled={!hasOpenDocument || !canUndo}
                title="Undo"
                className={`w-5 h-5 rounded flex items-center justify-center ${
                  hasOpenDocument && canUndo
                    ? 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer'
                    : 'text-[#8a8a8a]/25 cursor-not-allowed'
                }`}
              >
                <Undo2 className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={onRedo}
                disabled={!hasOpenDocument || !canRedo}
                title="Redo"
                className={`w-5 h-5 rounded flex items-center justify-center ${
                  hasOpenDocument && canRedo
                    ? 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer'
                    : 'text-[#8a8a8a]/25 cursor-not-allowed'
                }`}
              >
                <Redo2 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        {/* Layers Content */}
        {bottomTab === 'layers' ? (
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {!hasOpenDocument ? (
              <div className="flex-1 flex flex-col items-center justify-center p-4 text-center text-[#8a8a8a]">
                <p className="text-[11px] mb-2">No canvas open</p>
                <div className="flex items-center gap-1.5">
                  {onNewCanvas && (
                    <button
                      type="button"
                      onClick={onNewCanvas}
                      className="px-2.5 py-1 rounded bg-[#2c2c2c] text-[11px] text-[#e5e5e5] cursor-pointer"
                    >
                      New
                    </button>
                  )}
                  {onOpenFile && (
                    <button
                      type="button"
                      onClick={onOpenFile}
                      className="px-2.5 py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
                    >
                      Open
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                {activeLayer && (
                  <div className="px-2 pb-1.5 space-y-1.5 shrink-0">
                    {/* Quick Access: Blend Mode & Layer Opacity */}
                    <div className="flex items-center gap-1.5">
                      <select
                        value={activeLayer.blendMode}
                        onChange={(e) => onSetBlendMode(activeLayer.id, e.target.value as BlendMode)}
                        className="w-[46%] min-w-0 h-6 bg-[#161616] text-[#e5e5e5] text-[11px] px-1.5 rounded cursor-pointer truncate"
                        title="Blend Mode"
                      >
                        {BLEND_MODES.map((mode) => (
                          <option key={mode.value} value={mode.value} className="bg-[#202020] text-[#e5e5e5]">
                            {mode.label}
                          </option>
                        ))}
                      </select>

                      <div className="flex-1 min-w-0 flex items-center gap-1 bg-[#161616] rounded px-1.5 h-6">
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={activeLayer.opacity}
                          onChange={(e) => onSetOpacity(activeLayer.id, parseFloat(e.target.value))}
                          className="flex-1 min-w-0"
                          title={`Layer Opacity: ${Math.round(activeLayer.opacity * 100)}%`}
                        />
                        <span className="text-[10px] font-mono text-[#8a8a8a] w-7 text-right shrink-0">
                          {Math.round(activeLayer.opacity * 100)}%
                        </span>
                      </div>
                    </div>

                    {/* Quick Layer Property Flags */}
                    <div className="flex items-center justify-between gap-0.5">
                      <div className="flex items-center gap-0.5">
                        {activeLayer.type !== 'folder' && (
                          <button
                            type="button"
                            onClick={() => onToggleAlphaLock?.(activeLayer.id)}
                            title="Lock Transparent Pixels (Alpha Lock)"
                            className={`w-5 h-5 rounded flex items-center justify-center transition-colors cursor-pointer ${
                              activeLayer.alphaLocked
                                ? 'bg-[#2c2c2c] text-[var(--accent)]'
                                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                            }`}
                          >
                            <AlphaLockIcon />
                          </button>
                        )}
                        {activeLayer.id !== 'layer-bg' && (
                          <button
                            type="button"
                            onClick={() => onToggleClipping?.(activeLayer.id)}
                            title="Clip to Layer Below"
                            className={`w-5 h-5 rounded flex items-center justify-center transition-colors cursor-pointer ${
                              activeLayer.clipped
                                ? 'bg-[#2c2c2c] text-[var(--accent)]'
                                : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                            }`}
                          >
                            <ClipToLayerIcon />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onToggleReferenceLayer?.(activeLayer.id)}
                          title="Reference Layer"
                          className={`w-5 h-5 rounded flex items-center justify-center transition-colors cursor-pointer ${
                            activeLayer.isReference
                              ? 'bg-[#2c2c2c] text-[var(--accent)]'
                              : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                          }`}
                        >
                          <Compass className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggleLock(activeLayer.id)}
                          title={activeLayer.locked ? 'Unlock Layer' : 'Lock Layer'}
                          className={`w-5 h-5 rounded flex items-center justify-center transition-colors cursor-pointer ${
                            activeLayer.locked
                              ? 'bg-[#2c2c2c] text-[var(--accent)]'
                              : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                          }`}
                        >
                          {activeLayer.locked ? (
                            <Lock className="w-3 h-3" />
                          ) : (
                            <Unlock className="w-3 h-3" />
                          )}
                        </button>
                      </div>

                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => onDuplicateLayer(activeLayer.id)}
                          title="Duplicate Layer (Ctrl+J)"
                          className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                        {onOpen3DLayer && (
                          <button
                            type="button"
                            onClick={onOpen3DLayer}
                            title="3D Reference Layer"
                            className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
                          >
                            <Box className="w-3 h-3" />
                          </button>
                        )}
                        {onOpenLayerStylesModal &&
                          activeLayer.type !== 'folder' &&
                          activeLayer.type !== 'adjustment' && (
                            <button
                              type="button"
                              onClick={() => onOpenLayerStylesModal(activeLayer.id)}
                              title="Layer Styles (fx)"
                              className="h-5 px-1 rounded text-[10px] font-mono text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
                            >
                              fx
                            </button>
                          )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Spacious Scrollable Layer Stack */}
                <div
                  ref={layerListContainerRef}
                  className="flex-1 overflow-y-auto px-1.5 py-0.5 space-y-0.5 min-h-0"
                >
                  {layers.map((layer) => {
                    if (layer.parentId) {
                      const parentFolder = layers.find((l) => l.id === layer.parentId);
                      if (parentFolder?.collapsed) return null;
                    }

                    const isActive = layer.id === activeLayerId;
                    const isSelected = selectedLayerIds ? selectedLayerIds.includes(layer.id) : isActive;
                    const isFolder = layer.type === 'folder';
                    const isInsideFolder = Boolean(layer.parentId);
                    const isTarget = dropIndicator?.id === layer.id;
                    const isDropInside = isTarget && dropIndicator.position === 'inside';
                    const isDropAbove = isTarget && dropIndicator.position === 'above';
                    const isDropBelow = isTarget && dropIndicator.position === 'below';
                    const isBeingDragged =
                      draggedLayerId === layer.id ||
                      (draggedLayerId !== null &&
                        Boolean(selectedLayerIds?.includes(draggedLayerId)) &&
                        Boolean(selectedLayerIds?.includes(layer.id)));

                    const hasStyles = Boolean(
                      (layer.styles?.stroke?.enabled && layer.styles.stroke.size > 0) ||
                        (layer.styles?.dropShadow?.enabled && layer.styles.dropShadow.opacity > 0) ||
                        (layer.styles?.outerGlow?.enabled && layer.styles.outerGlow.opacity > 0)
                    );

                    return (
                      <div
                        key={layer.id}
                        data-layer-id={layer.id}
                        onPointerDown={(e) => handleLayerPointerDown(e, layer.id)}
                        onClick={(e) => {
                          if (justDraggedRef.current) return;
                          if (onToggleLayerSelection) {
                            onToggleLayerSelection(layer.id, e.shiftKey, e.ctrlKey || e.metaKey);
                          } else {
                            onSelectLayer(layer.id);
                          }
                          if (activeEditTarget === 'mask' && !layer.maskCanvas && layer.maskEnabled === undefined) {
                            onSelectEditTarget?.('layer');
                          }
                        }}
                        onDoubleClick={() => {
                          if (layer.type === 'adjustment') {
                            onOpenAdjustmentModal?.(layer.id, layer.adjustmentData?.type);
                          } else {
                            startRename(layer);
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (selectedLayerIds && !selectedLayerIds.includes(layer.id)) {
                            onToggleLayerSelection
                              ? onToggleLayerSelection(layer.id, false, false)
                              : onSelectLayer(layer.id);
                          }
                          setContextMenu({ layerId: layer.id, x: e.clientX, y: e.clientY });
                        }}
                        className={`group relative flex items-center gap-1.5 px-1.5 py-1 rounded transition-colors select-none ${
                          isInsideFolder ? 'ml-3' : ''
                        } ${layer.clipped ? 'ml-2.5' : ''} ${
                          isDropInside
                            ? 'bg-[#2c2c2c] ring-1 ring-[var(--accent)]'
                            : isSelected
                            ? isActive
                              ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                              : 'bg-[#2c2c2c]/65 text-[#e5e5e5]'
                            : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/45'
                        } ${isBeingDragged ? 'opacity-40 cursor-grabbing' : 'cursor-grab'}`}
                      >
                        {isActive && (
                          <span
                            className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full"
                            style={{ backgroundColor: 'var(--accent)' }}
                          />
                        )}

                        {isDropAbove && (
                          <div
                            className="absolute -top-0.5 left-0 right-0 h-[2px] rounded-full z-30 pointer-events-none"
                            style={{ backgroundColor: 'var(--accent)' }}
                          />
                        )}
                        {isDropBelow && (
                          <div
                            className="absolute -bottom-0.5 left-0 right-0 h-[2px] rounded-full z-30 pointer-events-none"
                            style={{ backgroundColor: 'var(--accent)' }}
                          />
                        )}

                        {/* Visibility Toggle */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleVisibility(layer.id);
                          }}
                          title={layer.visible ? 'Hide Layer' : 'Show Layer'}
                          className={`p-0.5 rounded transition-colors shrink-0 cursor-pointer ${
                            layer.visible
                              ? 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                              : 'text-[#8a8a8a]/30 hover:text-[#8a8a8a]'
                          }`}
                        >
                          {layer.visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                        </button>

                        {/* Folder Controls or Thumbnail */}
                        {isFolder ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleCollapse(layer.id);
                            }}
                            className="flex items-center gap-0.5 text-[#8a8a8a] hover:text-[#e5e5e5] shrink-0 cursor-pointer"
                          >
                            {layer.collapsed ? (
                              <ChevronRight className="w-3 h-3" />
                            ) : (
                              <ChevronDown className="w-3 h-3" />
                            )}
                            {layer.collapsed ? (
                              <Folder className="w-3.5 h-3.5" />
                            ) : (
                              <FolderOpen className="w-3.5 h-3.5" />
                            )}
                          </button>
                        ) : (
                          <div className="flex items-center gap-1 shrink-0">
                            {layer.type === 'adjustment' ? (
                              <div
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectLayer(layer.id);
                                  onSelectEditTarget?.('layer');
                                }}
                                className="w-6 h-5 rounded-xs bg-[#161616] flex items-center justify-center shrink-0"
                              >
                                <SlidersHorizontal className="w-3 h-3 text-[var(--accent)]" />
                              </div>
                            ) : (
                              <div
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectLayer(layer.id);
                                  onSelectEditTarget?.('layer');
                                }}
                                className={`w-6 h-5 rounded-xs overflow-hidden shrink-0 relative ${
                                  isActive && activeEditTarget !== 'mask'
                                    ? 'shadow-[0_0_0_1px_var(--accent)]'
                                    : ''
                                }`}
                                style={{
                                  backgroundColor: '#161616',
                                  backgroundImage:
                                    layer.id === 'layer-bg'
                                      ? 'none'
                                      : 'conic-gradient(#262626 90deg, #1a1a1a 90deg 180deg, #262626 180deg 270deg, #1a1a1a 270deg)',
                                  backgroundSize: '6px 6px',
                                }}
                              >
                                {layer.thumbnailUrl ? (
                                  <img
                                    src={layer.thumbnailUrl}
                                    alt=""
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

                            {(layer.maskCanvas ||
                              layer.maskEnabled !== undefined ||
                              layer.maskThumbnailUrl) && (
                              <div
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectLayer(layer.id);
                                  onSelectEditTarget?.('mask');
                                }}
                                className={`w-5 h-5 rounded-xs overflow-hidden shrink-0 relative bg-black ${
                                  isActive && activeEditTarget === 'mask'
                                    ? 'shadow-[0_0_0_1.5px_var(--accent)]'
                                    : ''
                                }`}
                                title="Layer Mask"
                              >
                                {layer.maskThumbnailUrl ? (
                                  <img
                                    src={layer.maskThumbnailUrl}
                                    alt=""
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <div className="w-full h-full bg-white" />
                                )}
                                {layer.maskEnabled === false && (
                                  <div className="absolute inset-0 flex items-center justify-center">
                                    <div className="w-[140%] h-[1.5px] bg-red-500 rotate-45" />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Layer Name */}
                        <div className="flex-1 min-w-0 flex items-center gap-1">
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
                              className="bg-[#161616] rounded px-1 py-0.5 text-[11px] text-[#e5e5e5] w-full"
                            />
                          ) : (
                            <span
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                startRename(layer);
                              }}
                              title={layer.name}
                              className={`text-[11px] truncate ${
                                isActive ? 'text-[#e5e5e5] font-medium' : ''
                              }`}
                            >
                              {layer.name}
                            </span>
                          )}
                        </div>

                        {/* Compact Metadata Badges */}
                        <div className="flex items-center gap-1 shrink-0 text-[9px] font-mono text-[#8a8a8a]">
                          {layer.clipped && <ClipToLayerIcon className="w-2.5 h-2.5 text-[var(--accent)]" />}
                          {layer.expressionColor && layer.expressionColor !== 'color' && (
                            <span>{layer.expressionColor === 'monochrome' ? '1b' : 'Gr'}</span>
                          )}
                          {layer.toneEnabled && <span>{layer.toneFrequency ?? 60}L</span>}
                          {hasStyles && <span>fx</span>}
                          {layer.opacity < 0.99 && <span>{Math.round(layer.opacity * 100)}%</span>}
                          {layer.locked && <Lock className="w-2.5 h-2.5" />}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Tucked Collapsible Accordions for Advanced Layer Settings */}
                {activeLayer && activeLayer.type !== 'folder' && (
                  <div className="shrink-0 bg-[#161616] pt-px space-y-px max-h-[45%] overflow-y-auto">
                    {/* Accordion 1: Monochrome Expression Color & Color Threshold */}
                    <div className="bg-[#202020]">
                      <button
                        type="button"
                        onClick={() => setIsExpressionAccordionOpen((p) => !p)}
                        className="w-full px-2.5 py-1.5 flex items-center justify-between text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 transition-colors cursor-pointer"
                      >
                        <span>Expression Color</span>
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] font-mono capitalize text-[#e5e5e5]">
                            {activeLayer.expressionColor === 'monochrome'
                              ? 'Mono'
                              : activeLayer.expressionColor || 'Color'}
                          </span>
                          {isExpressionAccordionOpen ? (
                            <ChevronDown className="w-3 h-3" />
                          ) : (
                            <ChevronRight className="w-3 h-3" />
                          )}
                        </div>
                      </button>

                      {isExpressionAccordionOpen && (
                        <div className="px-2.5 pb-2.5 pt-1 space-y-2">
                          <div className="grid grid-cols-3 gap-0.5 bg-[#161616] p-0.5 rounded">
                            {(
                              [
                                { id: 'color', label: 'Color' },
                                { id: 'gray', label: 'Gray' },
                                { id: 'monochrome', label: 'Mono' },
                              ] as const
                            ).map((m) => {
                              const selected = (activeLayer.expressionColor || 'color') === m.id;
                              return (
                                <button
                                  key={m.id}
                                  type="button"
                                  onClick={() => onSetLayerExpressionColor?.(activeLayer.id, m.id)}
                                  className={`py-0.5 rounded text-[10px] cursor-pointer transition-colors ${
                                    selected
                                      ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                                      : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                                  }`}
                                >
                                  {m.label}
                                </button>
                              );
                            })}
                          </div>

                          {(activeLayer.expressionColor || 'color') === 'monochrome' && (
                            <div className="space-y-2">
                              <div className="space-y-1">
                                <div className="flex items-center justify-between text-[11px]">
                                  <span className="text-[#8a8a8a]">Color Threshold</span>
                                  <span className="font-mono text-[10px] text-[#e5e5e5]">
                                    {activeLayer.monoThreshold ?? 128}
                                  </span>
                                </div>
                                <input
                                  type="range"
                                  min="1"
                                  max="255"
                                  value={activeLayer.monoThreshold ?? 128}
                                  onChange={(e) =>
                                    onSetLayerMonoThreshold?.(activeLayer.id, parseInt(e.target.value, 10))
                                  }
                                  className="w-full"
                                />
                              </div>

                              <div className="flex items-center justify-between text-[10px]">
                                <span className="text-[#8a8a8a]">Express</span>
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      onSetLayerMonoExpressMode?.(
                                        activeLayer.id,
                                        !(activeLayer.monoExpressBlack ?? true),
                                        activeLayer.monoExpressWhite ?? true
                                      )
                                    }
                                    className={`px-1.5 py-0.5 rounded cursor-pointer ${
                                      (activeLayer.monoExpressBlack ?? true)
                                        ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                                        : 'bg-[#161616] text-[#8a8a8a]'
                                    }`}
                                  >
                                    Black
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      onSetLayerMonoExpressMode?.(
                                        activeLayer.id,
                                        activeLayer.monoExpressBlack ?? true,
                                        !(activeLayer.monoExpressWhite ?? true)
                                      )
                                    }
                                    className={`px-1.5 py-0.5 rounded cursor-pointer ${
                                      (activeLayer.monoExpressWhite ?? true)
                                        ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                                        : 'bg-[#161616] text-[#8a8a8a]'
                                    }`}
                                  >
                                    White
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}

                          {(activeLayer.expressionColor || 'color') !== 'color' && (
                            <button
                              type="button"
                              onClick={() => onApplyExpressionColor?.(activeLayer.id)}
                              className="w-full py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
                            >
                              Apply Expression Color
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Accordion 2: Screentone & Layer Tint */}
                    <div className="bg-[#202020]">
                      <button
                        type="button"
                        onClick={() => setIsEffectsAccordionOpen((p) => !p)}
                        className="w-full px-2.5 py-1.5 flex items-center justify-between text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 transition-colors cursor-pointer"
                      >
                        <span>Tone & Tint</span>
                        {isEffectsAccordionOpen ? (
                          <ChevronDown className="w-3 h-3" />
                        ) : (
                          <ChevronRight className="w-3 h-3" />
                        )}
                      </button>

                      {isEffectsAccordionOpen && (
                        <div className="px-2.5 pb-2.5 pt-1 space-y-2.5">
                          <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                            <span>Screentone</span>
                            <input
                              type="checkbox"
                              checked={Boolean(activeLayer.toneEnabled)}
                              onChange={() => onToggleTone?.(activeLayer.id)}
                            />
                          </label>

                          {activeLayer.toneEnabled && (
                            <div className="space-y-2">
                              <select
                                value={activeLayer.toneDensityType ?? 'specified'}
                                onChange={(e) =>
                                  onSetToneDensityType?.(
                                    activeLayer.id,
                                    e.target.value as 'specified' | 'image'
                                  )
                                }
                                className="w-full h-6 px-1.5 text-[10px]"
                              >
                                <option value="specified">Specified Density</option>
                                <option value="image">Image Brightness</option>
                              </select>

                              {(activeLayer.toneDensityType ?? 'specified') === 'specified' && (
                                <div className="space-y-1">
                                  <div className="flex justify-between text-[10px]">
                                    <span className="text-[#8a8a8a]">Density</span>
                                    <span className="font-mono text-[#e5e5e5]">
                                      {activeLayer.toneDensity ?? 40}%
                                    </span>
                                  </div>
                                  <input
                                    type="range"
                                    min="1"
                                    max="100"
                                    value={activeLayer.toneDensity ?? 40}
                                    onChange={(e) =>
                                      onSetToneDensity?.(activeLayer.id, parseInt(e.target.value, 10))
                                    }
                                    className="w-full"
                                  />
                                </div>
                              )}

                              <div className="space-y-1">
                                <div className="flex justify-between text-[10px]">
                                  <span className="text-[#8a8a8a]">Frequency</span>
                                  <span className="font-mono text-[#e5e5e5]">
                                    {activeLayer.toneFrequency ?? 60} LPI
                                  </span>
                                </div>
                                <input
                                  type="range"
                                  min="20"
                                  max="85"
                                  value={activeLayer.toneFrequency ?? 60}
                                  onChange={(e) =>
                                    onSetToneFrequency?.(activeLayer.id, parseInt(e.target.value, 10))
                                  }
                                  className="w-full"
                                />
                              </div>

                              <div className="space-y-1">
                                <div className="flex justify-between text-[10px]">
                                  <span className="text-[#8a8a8a]">Angle</span>
                                  <span className="font-mono text-[#e5e5e5]">
                                    {activeLayer.toneAngle ?? 45}°
                                  </span>
                                </div>
                                <input
                                  type="range"
                                  min="0"
                                  max="90"
                                  value={activeLayer.toneAngle ?? 45}
                                  onChange={(e) =>
                                    onSetToneAngle?.(activeLayer.id, parseInt(e.target.value, 10))
                                  }
                                  className="w-full"
                                />
                              </div>

                              <select
                                value={activeLayer.toneDotShape ?? 'circle'}
                                onChange={(e) =>
                                  onSetToneDotShape?.(
                                    activeLayer.id,
                                    e.target.value as 'circle' | 'euclidean'
                                  )
                                }
                                className="w-full h-6 px-1.5 text-[10px]"
                              >
                                <option value="circle">Circle Dot</option>
                                <option value="euclidean">Euclidean Dot</option>
                              </select>
                            </div>
                          )}

                          <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                            <span>Layer Tint</span>
                            <input
                              type="checkbox"
                              checked={Boolean(activeLayer.layerColorEnabled)}
                              onChange={() => onToggleLayerColor?.(activeLayer.id)}
                            />
                          </label>

                          {activeLayer.layerColorEnabled && (
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between text-[10px]">
                                <span className="text-[#8a8a8a]">Main</span>
                                <input
                                  type="color"
                                  value={activeLayer.layerColor || '#1c73c2'}
                                  onChange={(e) => onSetLayerColor?.(activeLayer.id, e.target.value)}
                                  className="w-5 h-4 bg-transparent cursor-pointer"
                                />
                              </div>
                              <div className="flex items-center justify-between text-[10px]">
                                <span className="text-[#8a8a8a]">Sub</span>
                                <input
                                  type="color"
                                  value={activeLayer.layerSubColor || '#ffffff'}
                                  onChange={(e) => onSetLayerSubColor?.(activeLayer.id, e.target.value)}
                                  className="w-5 h-4 bg-transparent cursor-pointer"
                                />
                              </div>
                              <button
                                type="button"
                                onClick={() => onApplyLayerColor?.(activeLayer.id)}
                                className="w-full py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
                              >
                                Apply Tint
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          /* History Tab */
          <div className="flex-1 overflow-y-auto px-1.5 py-1 space-y-0.5 min-h-0">
            {!hasOpenDocument || historyList.length === 0 ? (
              <div className="p-4 text-center text-[11px] text-[#8a8a8a]">No history</div>
            ) : (
              historyList.map((item, idx) => {
                const isActive = idx === historyIndex;
                const isFuture = idx > historyIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onJumpToHistory(idx)}
                    className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-left text-[11px] transition-colors cursor-pointer ${
                      isActive
                        ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                        : isFuture
                        ? 'opacity-40 hover:opacity-80 text-[#8a8a8a]'
                        : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/50'
                    }`}
                  >
                    <span className="truncate">{item.label}</span>
                    <span className="text-[9px] font-mono text-[#8a8a8a] shrink-0">
                      {item.timeFormatted}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </section>

      {/* Right-Click Context Menu */}
      {contextMenu &&
        (() => {
          const targetLayer = layers.find((l) => l.id === contextMenu.layerId);
          if (!targetLayer) return null;
          const hasMask = Boolean(
            targetLayer.maskCanvas ||
              targetLayer.maskEnabled !== undefined ||
              targetLayer.maskThumbnailUrl
          );
          const isAdj = targetLayer.type === 'adjustment';

          return (
            <div
              ref={contextMenuRef}
              className="fixed z-50 min-w-44 bg-[#202020] rounded-md shadow-[0_12px_32px_rgba(0,0,0,0.7)] p-1 text-[11px] text-[#e5e5e5] select-none"
              style={{
                left: Math.max(10, Math.min(contextMenu.x, window.innerWidth - 190)),
                top: Math.max(10, Math.min(contextMenu.y, window.innerHeight - 320)),
              }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="px-2.5 py-1 text-[10px] text-[#8a8a8a] truncate">
                {targetLayer.name}
              </div>
              <div className="my-0.5 h-px bg-[#2c2c2c]" />

              {targetLayer.type !== 'folder' && (
                <>
                  {!hasMask ? (
                    <button
                      type="button"
                      onClick={() => {
                        onAddLayerMask?.(targetLayer.id);
                        setContextMenu(null);
                      }}
                      className="w-full text-left px-2.5 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer"
                    >
                      Add Layer Mask
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          onToggleLayerMask?.(targetLayer.id);
                          setContextMenu(null);
                        }}
                        className="w-full text-left px-2.5 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer"
                      >
                        {targetLayer.maskEnabled === false ? 'Enable Mask' : 'Disable Mask'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onToggleMaskLinked?.(targetLayer.id);
                          setContextMenu(null);
                        }}
                        className="w-full text-left px-2.5 py-1 rounded hover:bg-[#2c2c2c] flex items-center justify-between cursor-pointer"
                      >
                        <span>{targetLayer.maskLinked === false ? 'Link Mask' : 'Unlink Mask'}</span>
                        <Link2 className="w-3 h-3 text-[#8a8a8a]" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onRemoveLayerMask?.(targetLayer.id);
                          setContextMenu(null);
                        }}
                        className="w-full text-left px-2.5 py-1 rounded hover:bg-[#2c2c2c] text-red-400 cursor-pointer"
                      >
                        Delete Mask
                      </button>
                    </>
                  )}
                  <div className="my-0.5 h-px bg-[#2c2c2c]" />
                </>
              )}

              {isAdj && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenAdjustmentModal?.(targetLayer.id, targetLayer.adjustmentData?.type);
                    setContextMenu(null);
                  }}
                  className="w-full text-left px-2.5 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer"
                >
                  Edit Adjustment...
                </button>
              )}

              {onOpenAdjustmentModal && (
                <>
                  {(['curves', 'levels', 'gradient-map', 'color-balance'] as const).map((adjType) => (
                    <button
                      key={adjType}
                      type="button"
                      onClick={() => {
                        onOpenAdjustmentModal(undefined, adjType);
                        setContextMenu(null);
                      }}
                      className="w-full text-left px-2.5 py-1 rounded hover:bg-[#2c2c2c] capitalize cursor-pointer"
                    >
                      New {adjType.replace('-', ' ')}...
                    </button>
                  ))}
                  <div className="my-0.5 h-px bg-[#2c2c2c]" />
                </>
              )}

              {targetLayer.type !== 'folder' &&
                targetLayer.type !== 'adjustment' &&
                onOpenLayerStylesModal && (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenLayerStylesModal(targetLayer.id);
                      setContextMenu(null);
                    }}
                    className="w-full text-left px-2.5 py-1 rounded hover:bg-[#2c2c2c] flex items-center gap-1.5 cursor-pointer"
                  >
                    <Sparkles className="w-3 h-3 text-[#8a8a8a]" />
                    <span>Layer Styles...</span>
                  </button>
                )}

              {onGroupSelectedLayers && (
                <button
                  type="button"
                  onClick={() => {
                    onGroupSelectedLayers();
                    setContextMenu(null);
                  }}
                  className="w-full text-left px-2.5 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer"
                >
                  Group (Ctrl+G)
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  onDuplicateLayer(targetLayer.id);
                  setContextMenu(null);
                }}
                className="w-full text-left px-2.5 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer"
              >
                Duplicate
              </button>

              <button
                type="button"
                onClick={() => {
                  startRename(targetLayer);
                  setContextMenu(null);
                }}
                className="w-full text-left px-2.5 py-1 rounded hover:bg-[#2c2c2c] cursor-pointer"
              >
                Rename
              </button>

              {targetLayer.id !== 'layer-bg' && (
                <button
                  type="button"
                  onClick={() => {
                    if (onDeleteSelectedLayers && selectedLayerIds && selectedLayerIds.length > 1) {
                      onDeleteSelectedLayers();
                    } else {
                      onDeleteLayer(targetLayer.id);
                    }
                    setContextMenu(null);
                  }}
                  className="w-full text-left px-2.5 py-1 rounded hover:bg-[#2c2c2c] text-red-400 cursor-pointer"
                >
                  Delete
                </button>
              )}
            </div>
          );
        })()}
    </aside>
  );
});

RightSidebar.displayName = 'RightSidebar';
