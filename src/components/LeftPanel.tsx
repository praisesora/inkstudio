import React, { useState, useRef, useEffect } from 'react';
import {
  Paintbrush,
  Pencil,
  Eraser,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Activity,
  Sparkles,
  X,
  LayoutList,
  Plus,
  Trash2,
  Loader2,
  FolderDown,
  Zap,
  Droplets,
  Palette,
  Square,
  BoxSelect,
  Lasso,
  PaintBucket,
  Type,
  Frame,
  Scaling,
  Pipette,
  Move,
  Maximize2,
  Minimize2,
  RotateCw,
  RotateCcw,
  Undo2,
  CornerUpLeft,
  CornerUpRight,
  Wand2,
  PenTool,
  Feather,
} from 'lucide-react';
import {
  ToolType,
  BrushSettings,
  BrushPresetId,
  CspBrush,
  FillSettings,
  TextSettings,
  FrameSettings,
  LiquifySettings,
  LiquifyMode,
  WandSettings,
} from '../types/editor';
import { LiquifyIcon } from './LiquifyIcon';
import { PENCIL_CONFIGS, PencilGrade } from '../utils/pencilEngine';
import { BrushPreview } from './BrushPreview';
import { parseSutFile } from '../utils/sutParser';
import { WebGlBrushEngine } from '../utils/webglBrushEngine';
import {
  loadCustomBrushes,
  saveCustomBrush,
  deleteCustomBrush,
  getPreloadedTipImage,
  preloadTipImage,
  prepareBrushSettingsForCsp,
} from '../utils/brushStorage';
import {
  BUILTIN_BRUSHES,
  BrushCategory,
} from '../utils/presetBrushes';
import { BrushSizePalette } from './BrushSizePalette';
import {
  getEffectiveBrushSettings,
  getSavedBrushSettings,
  resetBrushSettingsToDefault,
  saveActivePresetId,
  ERASER_PRESET_ID,
} from '../utils/brushPresetManager';

interface LeftPanelProps {
  currentTool: ToolType;
  onSelectTool: (tool: ToolType) => void;
  brushSettings: BrushSettings;
  onUpdateBrushSettings: (newSettings: Partial<BrushSettings>) => void;
  primaryColor: string;
  secondaryColor: string;
  onPrimaryColorChange?: (color: string) => void;
  onSecondaryColorChange?: (color: string) => void;
  onSwapColors: () => void;
  isTransparentColor?: boolean;
  onToggleTransparentColor?: () => void;
  recentColors?: string[];
  width: number;
  onWidthChange: (newWidth: number) => void;
  isHidden: boolean;
  onToggleHidden: () => void;
  fillSettings?: FillSettings;
  onUpdateFillSettings?: (newSettings: Partial<FillSettings>) => void;
  textSettings?: TextSettings;
  onUpdateTextSettings?: (newSettings: Partial<TextSettings>) => void;
  frameSettings?: FrameSettings;
  onUpdateFrameSettings?: (newSettings: Partial<FrameSettings>) => void;
  hasSelection?: boolean;
  onDeselect?: () => void;
  onTransformSelection?: () => void;
  onFillScreentone?: () => void;
  liquifySettings?: LiquifySettings;
  onUpdateLiquifySettings?: (newSettings: Partial<LiquifySettings>) => void;
  wandSettings?: WandSettings;
  onUpdateWandSettings?: (newSettings: Partial<WandSettings>) => void;
  onExpandSelection?: (pixels: number) => void;
  onContractSelection?: (pixels: number) => void;
  onFeatherSelection?: (radius: number) => void;
  onInvertSelection?: () => void;
}

export const LeftPanel: React.FC<LeftPanelProps> = React.memo(({
  currentTool,
  onSelectTool,
  brushSettings,
  onUpdateBrushSettings,
  primaryColor,
  secondaryColor,
  onSwapColors,
  isTransparentColor = false,
  onToggleTransparentColor,
  width,
  onWidthChange,
  isHidden,
  onToggleHidden,
  fillSettings,
  onUpdateFillSettings,
  textSettings,
  onUpdateTextSettings,
  frameSettings,
  onUpdateFrameSettings,
  hasSelection: _hasSelection,
  onDeselect,
  onTransformSelection,
  onFillScreentone: _onFillScreentone,
  liquifySettings,
  onUpdateLiquifySettings,
  wandSettings,
  onUpdateWandSettings,
  onExpandSelection,
  onContractSelection,
  onFeatherSelection,
  onInvertSelection,
}) => {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [customBrushes, setCustomBrushes] = useState<CspBrush[]>([]);
  const [isImportingSut, setIsImportingSut] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [isDraggingFileOver, setIsDraggingFileOver] = useState(false);
  const sutInputRef = useRef<HTMLInputElement>(null);
  const gpuInfo = useRef(WebGlBrushEngine.getInstance().getGpuInfo()).current;

  const [selectedCategory, setSelectedCategory] = useState<'all' | BrushCategory | 'csp'>('all');
  const [bottomTab, setBottomTab] = useState<'settings' | 'size'>(() => {
    try {
      const saved = localStorage.getItem('sora_paint_left_bottom_tab');
      return saved === 'size' ? 'size' : 'settings';
    } catch {
      return 'settings';
    }
  });

  const handleSelectBottomTab = (tab: 'settings' | 'size') => {
    setBottomTab(tab);
    try {
      localStorage.setItem('sora_paint_left_bottom_tab', tab);
    } catch {}
  };

  useEffect(() => {
    loadCustomBrushes().then((brushes) => {
      setCustomBrushes(brushes);
      for (const b of brushes) {
        if (b.tipDataUrl) preloadTipImage(b.tipDataUrl).catch(() => {});
        if (b.subTips) {
          for (const st of b.subTips) {
            if (st.dataUrl) preloadTipImage(st.dataUrl).catch(() => {});
          }
        }
        if (b.paperTexture) preloadTipImage(b.paperTexture).catch(() => {});
      }
    });
  }, []);

  const activePreset: BrushPresetId = brushSettings.preset || 'pencil-2b';
  const isPencilActive = currentTool === 'brush' && activePreset.startsWith('pencil');
  const activePencilConfig = isPencilActive ? PENCIL_CONFIGS[activePreset as PencilGrade] : null;
  const activeBuiltinBrush = BUILTIN_BRUSHES.find((b) => b.id === activePreset);

  const isCustomBrushActive =
    currentTool === 'brush' &&
    (activePreset.startsWith('csp-') || (Boolean(brushSettings.customTipDataUrl) && !activeBuiltinBrush));
  const activeCustomBrush = isCustomBrushActive
    ? customBrushes.find((b) => b.id === activePreset)
    : null;

  const activeToolLabel = (() => {
    if (currentTool === 'eraser') return 'Eraser';
    if (currentTool === 'pipette') return 'Eyedropper';
    if (currentTool === 'select-rect') return 'Marquee';
    if (currentTool === 'select-lasso') return 'Lasso';
    if (currentTool === 'select-wand') return 'Magic Wand';
    if (currentTool === 'select-pen') return 'Selection Pen';
    if (currentTool === 'select-eraser') return 'Selection Eraser';
    if (currentTool === 'fill') return 'Fill';
    if (currentTool === 'text') return 'Text';
    if (currentTool === 'frame') return 'Frame Border';
    if (currentTool === 'transform') return 'Transform';
    if (currentTool === 'liquify') return 'Liquify';
    return isPencilActive ? 'Pencil' : brushSettings.brushName || activeCustomBrush?.name || activeBuiltinBrush?.name || 'Drawing';
  })();

  const handleUpdateBrushSettings = (newSettings: Partial<BrushSettings>) => {
    onUpdateBrushSettings(newSettings);
    if (isCustomBrushActive && activeCustomBrush) {
      const updatedBrush: CspBrush = {
        ...activeCustomBrush,
        size: newSettings.size !== undefined ? newSettings.size : activeCustomBrush.size,
        opacity: newSettings.opacity !== undefined ? newSettings.opacity : activeCustomBrush.opacity,
        flow: newSettings.flow !== undefined ? newSettings.flow : activeCustomBrush.flow,
        spacing: newSettings.spacing !== undefined ? newSettings.spacing : activeCustomBrush.spacing,
        hardness: newSettings.hardness !== undefined ? newSettings.hardness : activeCustomBrush.hardness,
        stabilization: newSettings.stabilization !== undefined ? newSettings.stabilization : activeCustomBrush.stabilization,
      };
      setCustomBrushes((prev) => prev.map((b) => (b.id === updatedBrush.id ? updatedBrush : b)));
      saveCustomBrush(updatedBrush).catch(() => {});
    }
  };

  const handleSelectBrushPreset = (presetId: BrushPresetId) => {
    onSelectTool('brush');
    saveActivePresetId(presetId);
    const effective = getEffectiveBrushSettings(presetId, customBrushes);
    onUpdateBrushSettings({
      customTipDataUrl: undefined,
      customTipImage: undefined,
      customTipAngle: 0,
      customTipAngleDynamics: 'none',
      colorMixing: false,
      wetEdge: 0,
      grain: 0,
      ...effective,
      preset: presetId,
    });
  };

  const handleSelectCustomBrush = async (brush: CspBrush) => {
    onSelectTool('brush');
    saveActivePresetId(brush.id);
    const prepared = await prepareBrushSettingsForCsp(brush);
    const saved = getSavedBrushSettings(brush.id);
    onUpdateBrushSettings({
      ...prepared,
      ...saved,
      preset: brush.id,
    });
  };

  const handleImportSut = async (file: File) => {
    setIsImportingSut(true);
    setImportStatus(`Importing ${file.name}...`);
    try {
      const buffer = await file.arrayBuffer();
      const parsedBrush = await parseSutFile(buffer, file.name);

      // Clean out any previously imported brush with matching name or ID to avoid stale cache
      const existing = customBrushes.filter(
        (b) => b.name.toLowerCase() === parsedBrush.name.toLowerCase() || b.id === parsedBrush.id
      );
      for (const old of existing) {
        await deleteCustomBrush(old.id).catch(() => {});
      }

      await saveCustomBrush(parsedBrush);
      setCustomBrushes((prev) => {
        const filtered = prev.filter(
          (b) => b.name.toLowerCase() !== parsedBrush.name.toLowerCase() && b.id !== parsedBrush.id
        );
        return [parsedBrush, ...filtered];
      });
      await handleSelectCustomBrush(parsedBrush);
      setImportStatus(null);
    } catch (err: any) {
      console.error('CSP brush import error:', err);
      alert(err.message || 'Failed to import Clip Studio Paint brush file.');
      setImportStatus(null);
    } finally {
      setIsImportingSut(false);
    }
  };

  const handleDeleteCustomBrush = async (e: React.MouseEvent, brushId: string) => {
    e.stopPropagation();
    if (window.confirm('Delete this imported brush?')) {
      await deleteCustomBrush(brushId);
      setCustomBrushes((prev) => prev.filter((b) => b.id !== brushId));
      if (brushSettings.preset === brushId) {
        handleSelectBrushPreset('pencil-2b');
      }
    }
  };

  // View mode for brushes list: 'preview' (shows authentic CSP S-curve stroke) or 'compact'
  const [brushViewMode, setBrushViewMode] = useState<'preview' | 'compact'>(() => {
    return (localStorage.getItem('sora_paint_brush_view_mode') as 'preview' | 'compact') || 'preview';
  });

  const toggleBrushViewMode = () => {
    setBrushViewMode((prev) => {
      const next = prev === 'preview' ? 'compact' : 'preview';
      localStorage.setItem('sora_paint_brush_view_mode', next);
      return next;
    });
  };

  // Live preview stroke color in Tool Settings: false = neutral white (CSP standard), true = primary color
  const [usePrimaryColorPreview, setUsePrimaryColorPreview] = useState(false);

  // Vertical split between Top (Brushes) and Bottom (Tool Settings)
  const [topHeight, setTopHeight] = useState<number>(() => {
    const saved = localStorage.getItem('sora_paint_left_top_height');
    return saved ? Number(saved) : 255;
  });

  // Dragging states for resizers
  const [isDraggingWidth, setIsDraggingWidth] = useState(false);
  const [isDraggingHeight, setIsDraggingHeight] = useState(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(width);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(topHeight);

  // Resize Width Handler (Right edge of LeftPanel)
  const handleWidthResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingWidth(true);
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = width;
  };

  useEffect(() => {
    if (!isDraggingWidth) return;

    const handlePointerMove = (e: PointerEvent) => {
      const delta = e.clientX - dragStartXRef.current;
      const newWidth = Math.max(180, Math.min(500, Math.round(dragStartWidthRef.current + delta)));
      onWidthChange(newWidth);
    };

    const handlePointerUp = () => {
      setIsDraggingWidth(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isDraggingWidth, onWidthChange]);

  // Resize Height Handler (Divider between Top Brushes and Bottom Tool Settings)
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
      const newHeight = Math.max(80, Math.min(450, Math.round(dragStartHeightRef.current + delta)));
      setTopHeight(newHeight);
      localStorage.setItem('sora_paint_left_top_height', String(newHeight));
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

  const isBrushOrEraser = currentTool === 'brush' || currentTool === 'eraser';

  const renderToolSettings = () => {
    if (currentTool === 'fill') {
      return (
        <div className="flex-1 flex flex-col overflow-y-auto">
          <div className="h-9 px-3 flex items-center justify-between border-b border-[#2b2d31] bg-[#1a1b1e] shrink-0">
            <div className="flex items-center space-x-2">
              <PaintBucket className="w-4 h-4 text-amber-400" />
              <span className="text-xs font-semibold text-white">Fill Tool (G)</span>
            </div>
            <button onClick={onToggleHidden} className="p-1 text-[#828690] hover:text-rose-400 rounded cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-3 space-y-4">
            <div>
              <label className="text-[11px] font-medium text-[#aaaaaa] block mb-1.5">Fill Method:</label>
              <div className="space-y-1">
                <button
                  onClick={() => onUpdateFillSettings?.({ method: 'refer-all' })}
                  className={`w-full px-2.5 py-1.5 rounded text-left text-xs transition-colors cursor-pointer flex items-center justify-between ${
                    fillSettings?.method === 'refer-all'
                      ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] font-medium'
                      : 'bg-[#202226] text-[#aaaaaa] hover:bg-[#282a2e] hover:text-white border border-transparent'
                  }`}
                >
                  <span>Refer to Other Layers</span>
                  <span className="text-[10px] text-[#777777]">All Visible</span>
                </button>

                <button
                  onClick={() => onUpdateFillSettings?.({ method: 'refer-active' })}
                  className={`w-full px-2.5 py-1.5 rounded text-left text-xs transition-colors cursor-pointer flex items-center justify-between ${
                    fillSettings?.method === 'refer-active'
                      ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] font-medium'
                      : 'bg-[#202226] text-[#aaaaaa] hover:bg-[#282a2e] hover:text-white border border-transparent'
                  }`}
                >
                  <span>Refer Only to Editing Layer</span>
                  <span className="text-[10px] text-[#777777]">Editing Layer</span>
                </button>

                <button
                  onClick={() => onUpdateFillSettings?.({ method: 'lasso' })}
                  className={`w-full px-2.5 py-1.5 rounded text-left text-xs transition-colors cursor-pointer flex items-center justify-between ${
                    fillSettings?.method === 'lasso'
                      ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] font-medium'
                      : 'bg-[#202226] text-[#aaaaaa] hover:bg-[#282a2e] hover:text-white border border-transparent'
                  }`}
                >
                  <span>Lasso Fill</span>
                  <span className="text-[10px] text-[#777777]">Enclose & Fill</span>
                </button>
              </div>
            </div>

            {fillSettings?.method !== 'lasso' && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-medium text-[#aaaaaa]">Color Tolerance:</label>
                  <span className="text-xs font-mono text-cyan-400">{fillSettings?.tolerance ?? 32}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={fillSettings?.tolerance ?? 32}
                  onChange={(e) => onUpdateFillSettings?.({ tolerance: Number(e.target.value) })}
                  className="w-full accent-cyan-400"
                />
              </div>
            )}

            <div className="pt-2 border-t border-[#26282c] flex items-center space-x-2">
              <div className="w-5 h-5 rounded border border-[#44464c]" style={{ backgroundColor: primaryColor }} />
              <span className="text-[11px] text-[#aaaaaa]">Fill Color: {primaryColor}</span>
            </div>
          </div>
        </div>
      );
    }

    if (currentTool === 'frame') {
      return (
        <div className="flex-1 flex flex-col overflow-y-auto">
          <div className="h-9 px-3 flex items-center justify-between border-b border-[#2b2d31] bg-[#1a1b1e] shrink-0">
            <div className="flex items-center space-x-2">
              <Frame className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-semibold text-white">Frame Border Tool (F)</span>
            </div>
            <button onClick={onToggleHidden} className="p-1 text-[#828690] hover:text-rose-400 rounded cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-3 space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium text-[#aaaaaa]">Frame Thickness (1 - 100):</label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={frameSettings?.thickness ?? 4}
                  onChange={(e) =>
                    onUpdateFrameSettings?.({
                      thickness: Math.max(1, Math.min(100, Number(e.target.value) || 1)),
                    })
                  }
                  className="w-14 bg-[#141517] text-white text-right px-1.5 py-0.5 rounded border border-[#383a40] text-xs font-mono"
                />
              </div>
              <input
                type="range"
                min={1}
                max={100}
                value={frameSettings?.thickness ?? 4}
                onChange={(e) => onUpdateFrameSettings?.({ thickness: Number(e.target.value) })}
                className="w-full accent-cyan-400"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-[#aaaaaa] block mb-1">Frame Interior:</label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => onUpdateFrameSettings?.({ fillBackground: true })}
                  className={`py-1.5 px-2 rounded text-xs text-center transition-colors cursor-pointer ${
                    frameSettings?.fillBackground
                      ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] font-medium'
                      : 'bg-[#202226] text-[#aaaaaa] hover:bg-[#282a2e] hover:text-white border border-transparent'
                  }`}
                >
                  White Fill
                </button>
                <button
                  onClick={() => onUpdateFrameSettings?.({ fillBackground: false })}
                  className={`py-1.5 px-2 rounded text-xs text-center transition-colors cursor-pointer ${
                    !frameSettings?.fillBackground
                      ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] font-medium'
                      : 'bg-[#202226] text-[#aaaaaa] hover:bg-[#282a2e] hover:text-white border border-transparent'
                  }`}
                >
                  Transparent
                </button>
              </div>
            </div>


            <div className="pt-2 border-t border-[#26282c] flex items-center space-x-2">
              <div className="w-5 h-5 rounded border border-[#44464c]" style={{ backgroundColor: primaryColor }} />
              <span className="text-[11px] text-[#aaaaaa]">Border Color: {primaryColor}</span>
            </div>
          </div>
        </div>
      );
    }

    if (currentTool === 'text') {
      return (
        <div className="flex-1 flex flex-col overflow-y-auto">
          <div className="h-9 px-3 flex items-center justify-between border-b border-[#2b2d31] bg-[#1a1b1e] shrink-0">
            <div className="flex items-center space-x-2">
              <Type className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-semibold text-white">Text Creation Tool (T)</span>
            </div>
            <button onClick={onToggleHidden} className="p-1 text-[#828690] hover:text-rose-400 rounded cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-3 space-y-4">
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-[#aaaaaa]">Manga Font Family:</label>
              <select
                value={textSettings?.fontFamily}
                onChange={(e) => onUpdateTextSettings?.({ fontFamily: e.target.value })}
                className="w-full bg-[#141517] text-white text-xs border border-[#383a40] rounded px-2 py-1.5 focus:border-cyan-500 focus:outline-none"
              >
                <option value="'Neucha', 'Anime Ace', 'Comic Sans MS', sans-serif">Manga / Anime (RU/EN)</option>
                <option value="'Anime Ace', 'Comic Sans MS', sans-serif">Anime Ace (Comic)</option>
                <option value="'Comic Sans MS', cursive, sans-serif">Comic Sans MS</option>
                <option value="Arial, sans-serif">Arial</option>
                <option value="Impact, sans-serif">Impact</option>
                <option value="'Times New Roman', serif">Times New Roman</option>
                <option value="Georgia, serif">Georgia</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium text-[#aaaaaa]">Default Font Size:</label>
                <span className="text-xs font-mono text-cyan-400">{textSettings?.fontSize ?? 28}px</span>
              </div>
              <input
                type="range"
                min={12}
                max={160}
                value={textSettings?.fontSize ?? 28}
                onChange={(e) => onUpdateTextSettings?.({ fontSize: Number(e.target.value) })}
                className="w-full accent-cyan-400"
              />
            </div>

            <div className="pt-2 border-t border-[#26282c] flex items-center space-x-2">
              <div className="w-5 h-5 rounded border border-[#44464c]" style={{ backgroundColor: primaryColor }} />
              <span className="text-[11px] text-[#aaaaaa]">Text Color: {primaryColor}</span>
            </div>
          </div>
        </div>
      );
    }

    const isSelectionTool =
      currentTool === 'select-rect' ||
      currentTool === 'select-lasso' ||
      currentTool === 'select-wand' ||
      currentTool === 'select-pen' ||
      currentTool === 'select-eraser';

    if (isSelectionTool) {
      const activeWand = wandSettings || {
        tolerance: 32,
        contiguous: true,
        antiAlias: true,
        referMode: 'active' as const,
      };

      const selectionTitle =
        currentTool === 'select-rect'
          ? 'Rectangular Marquee (M)'
          : currentTool === 'select-lasso'
          ? 'Lasso Selection (L)'
          : currentTool === 'select-wand'
          ? 'Magic Wand (W)'
          : currentTool === 'select-pen'
          ? 'Selection Pen'
          : 'Selection Eraser';

      return (
        <div className="flex-1 flex flex-col overflow-y-auto">
          <div className="h-9 px-3 flex items-center justify-between border-b border-[#2b2d31] bg-[#1a1b1e] shrink-0">
            <div className="flex items-center space-x-2">
              {currentTool === 'select-rect' && <BoxSelect className="w-4 h-4 text-cyan-400" />}
              {currentTool === 'select-lasso' && <Lasso className="w-4 h-4 text-cyan-400" />}
              {currentTool === 'select-wand' && <Wand2 className="w-4 h-4 text-cyan-400" />}
              {currentTool === 'select-pen' && <PenTool className="w-4 h-4 text-cyan-400" />}
              {currentTool === 'select-eraser' && <Eraser className="w-4 h-4 text-cyan-400" />}
              <span className="text-xs font-semibold text-white">{selectionTitle}</span>
            </div>
            <button onClick={onToggleHidden} className="p-1 text-[#828690] hover:text-rose-400 rounded cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-3 space-y-4">
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-[#aaaaaa] block mb-1">Selection Tool:</label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => onSelectTool('select-rect')}
                  className={`py-1.5 px-2 rounded text-xs text-center transition-colors cursor-pointer flex items-center justify-center space-x-1 ${
                    currentTool === 'select-rect'
                      ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] font-medium'
                      : 'bg-[#202226] text-[#aaaaaa] hover:bg-[#282a2e] hover:text-white border border-transparent'
                  }`}
                >
                  <BoxSelect className="w-3.5 h-3.5" />
                  <span>Marquee</span>
                </button>

                <button
                  onClick={() => onSelectTool('select-lasso')}
                  className={`py-1.5 px-2 rounded text-xs text-center transition-colors cursor-pointer flex items-center justify-center space-x-1 ${
                    currentTool === 'select-lasso'
                      ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] font-medium'
                      : 'bg-[#202226] text-[#aaaaaa] hover:bg-[#282a2e] hover:text-white border border-transparent'
                  }`}
                >
                  <Lasso className="w-3.5 h-3.5" />
                  <span>Lasso</span>
                </button>

                <button
                  onClick={() => onSelectTool('select-wand')}
                  className={`py-1.5 px-2 rounded text-xs text-center transition-colors cursor-pointer flex items-center justify-center space-x-1 ${
                    currentTool === 'select-wand'
                      ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] font-medium'
                      : 'bg-[#202226] text-[#aaaaaa] hover:bg-[#282a2e] hover:text-white border border-transparent'
                  }`}
                >
                  <Wand2 className="w-3.5 h-3.5" />
                  <span>Wand</span>
                </button>

                <button
                  onClick={() => onSelectTool('select-pen')}
                  className={`py-1.5 px-2 rounded text-xs text-center transition-colors cursor-pointer flex items-center justify-center space-x-1 ${
                    currentTool === 'select-pen'
                      ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] font-medium'
                      : 'bg-[#202226] text-[#aaaaaa] hover:bg-[#282a2e] hover:text-white border border-transparent'
                  }`}
                >
                  <PenTool className="w-3.5 h-3.5" />
                  <span>Sel Pen</span>
                </button>

                <button
                  onClick={() => onSelectTool('select-eraser')}
                  className={`col-span-2 py-1.5 px-2 rounded text-xs text-center transition-colors cursor-pointer flex items-center justify-center space-x-1 ${
                    currentTool === 'select-eraser'
                      ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] font-medium'
                      : 'bg-[#202226] text-[#aaaaaa] hover:bg-[#282a2e] hover:text-white border border-transparent'
                  }`}
                >
                  <Eraser className="w-3.5 h-3.5" />
                  <span>Selection Eraser</span>
                </button>
              </div>
            </div>

            {/* Magic Wand Specific Settings */}
            {currentTool === 'select-wand' && (
              <div className="space-y-3 pt-2 border-t border-[#26282c]">
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-[#aaaaaa]">Tolerance:</span>
                    <span className="text-white font-mono">{activeWand.tolerance}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="255"
                    value={activeWand.tolerance}
                    onChange={(e) => onUpdateWandSettings?.({ tolerance: Number(e.target.value) })}
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div className="flex items-center justify-between text-xs py-1">
                  <span className="text-[#cccccc]">Contiguous</span>
                  <input
                    type="checkbox"
                    checked={activeWand.contiguous}
                    onChange={(e) => onUpdateWandSettings?.({ contiguous: e.target.checked })}
                    className="accent-cyan-400 rounded cursor-pointer"
                  />
                </div>

                <div className="flex items-center justify-between text-xs py-1">
                  <span className="text-[#cccccc]">Anti-Aliasing</span>
                  <input
                    type="checkbox"
                    checked={activeWand.antiAlias}
                    onChange={(e) => onUpdateWandSettings?.({ antiAlias: e.target.checked })}
                    className="accent-cyan-400 rounded cursor-pointer"
                  />
                </div>

                <div className="space-y-1">
                  <span className="text-[11px] text-[#aaaaaa] block">Reference Source:</span>
                  <div className="grid grid-cols-3 gap-1">
                    {(['active', 'all', 'reference'] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => onUpdateWandSettings?.({ referMode: mode })}
                        className={`py-1 px-1.5 rounded text-[11px] text-center capitalize cursor-pointer transition-colors ${
                          activeWand.referMode === mode
                            ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] font-medium'
                            : 'bg-[#202226] text-[#aaaaaa] hover:bg-[#282a2e] hover:text-white'
                        }`}
                      >
                        {mode === 'active' ? 'Active' : mode === 'all' ? 'All' : 'Ref Layer'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Selection Pen / Eraser Size */}
            {(currentTool === 'select-pen' || currentTool === 'select-eraser') && (
              <div className="space-y-3 pt-2 border-t border-[#26282c]">
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-[#aaaaaa]">Pen Size:</span>
                    <span className="text-white font-mono">{Math.round(brushSettings.size)} px</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="300"
                    value={brushSettings.size}
                    onChange={(e) => onUpdateBrushSettings({ size: Number(e.target.value) })}
                    className="w-full accent-cyan-400"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-[#aaaaaa]">Stabilization:</span>
                    <span className="text-white font-mono">{brushSettings.stabilization ?? 10}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="50"
                    value={brushSettings.stabilization ?? 10}
                    onChange={(e) => onUpdateBrushSettings({ stabilization: Number(e.target.value) })}
                    className="w-full accent-cyan-400"
                  />
                </div>
              </div>
            )}

            {/* Selection Boundary Modifiers & Actions */}
            <div className="space-y-1.5 pt-2 border-t border-[#26282c]">
              <label className="text-[11px] font-medium text-[#aaaaaa] block mb-1">Boundary Modifiers:</label>
              <div className="grid grid-cols-3 gap-1">
                <button
                  onClick={() => onExpandSelection?.(5)}
                  title="Expand Selection by 5px"
                  className="py-1.5 px-1 bg-[#202226] hover:bg-[#282a2e] text-[#cccccc] hover:text-white rounded text-[11px] transition-colors flex items-center justify-center space-x-1 cursor-pointer border border-[#2f323a]"
                >
                  <Maximize2 className="w-3 h-3 text-cyan-400" />
                  <span>Expand</span>
                </button>

                <button
                  onClick={() => onContractSelection?.(5)}
                  title="Contract Selection by 5px"
                  className="py-1.5 px-1 bg-[#202226] hover:bg-[#282a2e] text-[#cccccc] hover:text-white rounded text-[11px] transition-colors flex items-center justify-center space-x-1 cursor-pointer border border-[#2f323a]"
                >
                  <Minimize2 className="w-3 h-3 text-cyan-400" />
                  <span>Contract</span>
                </button>

                <button
                  onClick={() => onFeatherSelection?.(5)}
                  title="Feather Selection (5px)"
                  className="py-1.5 px-1 bg-[#202226] hover:bg-[#282a2e] text-[#cccccc] hover:text-white rounded text-[11px] transition-colors flex items-center justify-center space-x-1 cursor-pointer border border-[#2f323a]"
                >
                  <Feather className="w-3 h-3 text-cyan-400" />
                  <span>Feather</span>
                </button>
              </div>

              <button
                onClick={onInvertSelection}
                className="w-full py-1.5 px-2 bg-[#202226] hover:bg-[#282a2e] text-[#cccccc] hover:text-white rounded text-xs transition-colors flex items-center justify-center space-x-1.5 cursor-pointer border border-[#2f323a]"
              >
                <RotateCcw className="w-3.5 h-3.5 text-amber-400" />
                <span>Invert Selection (Ctrl+Shift+I)</span>
              </button>

              <button
                onClick={onTransformSelection}
                className="w-full py-1.5 px-2 bg-[#202226] hover:bg-[#282a2e] text-[#cccccc] hover:text-white rounded text-xs transition-colors flex items-center justify-center space-x-1.5 cursor-pointer border border-[#2f323a]"
              >
                <Scaling className="w-3.5 h-3.5 text-emerald-400" />
                <span>Transform Selection (Ctrl+T)</span>
              </button>

              <button
                onClick={onDeselect}
                className="w-full py-1.5 px-2 bg-[#202226] hover:bg-[#282a2e] text-[#cccccc] hover:text-white rounded text-xs transition-colors flex items-center justify-center space-x-1.5 cursor-pointer border border-[#2f323a]"
              >
                <X className="w-3.5 h-3.5 text-red-400" />
                <span>Deselect (Ctrl+D)</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (currentTool === 'transform') {
      return (
        <div className="flex-1 flex flex-col overflow-y-auto">
          <div className="h-9 px-3 flex items-center justify-between border-b border-[#2b2d31] bg-[#1a1b1e] shrink-0">
            <div className="flex items-center space-x-2">
              <Scaling className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-semibold text-white">Free Transform (Ctrl+T)</span>
            </div>
            <button onClick={onToggleHidden} className="p-1 text-[#828690] hover:text-rose-400 rounded cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-3 space-y-4">
            <div className="space-y-1.5">
              <span className="text-[11px] text-[#777777] block">Keyboard Shortcuts:</span>
              <div className="text-[11px] text-[#aaaaaa] space-y-0.5 font-mono">
                <div>• Enter: Apply transform</div>
                <div>• Esc: Cancel transform</div>
                <div>• Shift + Drag: Lock aspect ratio</div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (currentTool === 'liquify') {
      const activeMode = liquifySettings?.mode ?? 'push';
      const size = liquifySettings?.size ?? 80;
      const strength = liquifySettings?.strength ?? 50;
      const hardness = liquifySettings?.hardness ?? 50;
      const usePressure = liquifySettings?.usePressure ?? true;

      const LIQUIFY_SUB_TOOLS: Array<{
        id: LiquifyMode;
        name: string;
        desc: string;
        badge: string;
        icon: React.ReactNode;
      }> = [
        { id: 'push', name: 'Push', desc: 'Distort along stroke direction', badge: 'Move', icon: <Move className="w-3.5 h-3.5" /> },
        { id: 'expand', name: 'Expand', desc: 'Inflate outwards radially', badge: 'Bloat', icon: <Maximize2 className="w-3.5 h-3.5" /> },
        { id: 'pinch', name: 'Pinch', desc: 'Deflate inwards radially', badge: 'Shrink', icon: <Minimize2 className="w-3.5 h-3.5" /> },
        { id: 'push-left', name: 'Push Left', desc: 'Displace left of stroke', badge: 'Left', icon: <CornerUpLeft className="w-3.5 h-3.5" /> },
        { id: 'push-right', name: 'Push Right', desc: 'Displace right of stroke', badge: 'Right', icon: <CornerUpRight className="w-3.5 h-3.5" /> },
        { id: 'twirl-cw', name: 'Twirl Clockwise', desc: 'Rotate pixels clockwise', badge: 'CW', icon: <RotateCw className="w-3.5 h-3.5" /> },
        { id: 'twirl-ccw', name: 'Twirl Counterclockwise', desc: 'Rotate pixels counter-clockwise', badge: 'CCW', icon: <RotateCcw className="w-3.5 h-3.5" /> },
        { id: 'reconstruct', name: 'Reconstruct', desc: 'Restore towards original image', badge: 'Restore', icon: <Undo2 className="w-3.5 h-3.5" /> },
      ];

      return (
        <div className="flex-1 flex flex-col overflow-y-auto">
          {/* Header */}
          <div className="h-8 px-2.5 flex items-center justify-between border-b border-[#2b2d31] bg-[#1a1b1e] shrink-0">
            <div className="flex items-center space-x-1.5">
              <LiquifyIcon className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-semibold tracking-tight text-white">Sub Tool [Liquify]</span>
            </div>
            <button
              onClick={onToggleHidden}
              title="Hide Panel ( [ )"
              className="p-1 text-[#828690] hover:text-rose-400 hover:bg-[#282a2e] rounded transition-colors cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Sub Tools List (Authentic CSP Style matching screenshot) */}
          <div className="p-2 space-y-1 border-b border-[#2b2d31]">
            <div className="text-[10px] uppercase font-semibold tracking-wider text-[#777777] px-1 mb-1">
              Liquify Sub Tools
            </div>
            {LIQUIFY_SUB_TOOLS.map((sub) => {
              const isSelected = activeMode === sub.id;
              return (
                <button
                  key={sub.id}
                  onClick={() => onUpdateLiquifySettings?.({ mode: sub.id })}
                  title={sub.desc}
                  className={`w-full px-2 py-1.5 rounded flex items-center justify-between transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] font-medium shadow-xs'
                      : 'bg-[#202226] text-[#aaaaaa] hover:bg-[#282a2e] hover:text-white border border-transparent'
                  }`}
                >
                  <div className="flex items-center space-x-2 truncate">
                    <LiquifyIcon className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-[#5ce1e6]' : 'text-[#888888]'}`} />
                    <span className="text-xs truncate">{sub.name}</span>
                  </div>
                  <div className="flex items-center space-x-1.5 shrink-0">
                    <span className="text-[9px] uppercase px-1 py-0.5 rounded bg-[#161719] text-[#777777] border border-[#2b2d31]">
                      {sub.badge}
                    </span>
                    <span className={isSelected ? 'text-[#5ce1e6]' : 'text-[#666666]'}>
                      {sub.icon}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Tool Property Section */}
          <div className="p-3 space-y-4">
            <div className="text-[10px] uppercase font-semibold tracking-wider text-[#777777]">
              Tool Property [Liquify]
            </div>

            {/* Size Slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium text-[#aaaaaa]">Brush Size:</label>
                <div className="flex items-center space-x-1">
                  <input
                    type="number"
                    min={5}
                    max={500}
                    value={size}
                    onChange={(e) =>
                      onUpdateLiquifySettings?.({
                        size: Math.max(5, Math.min(500, Number(e.target.value) || 5)),
                      })
                    }
                    className="w-14 bg-[#141517] text-white text-right px-1.5 py-0.5 rounded border border-[#383a40] text-xs font-mono"
                  />
                  <span className="text-[10px] text-[#777777]">px</span>
                </div>
              </div>
              <input
                type="range"
                min={5}
                max={500}
                value={size}
                onChange={(e) => onUpdateLiquifySettings?.({ size: Number(e.target.value) })}
                className="w-full accent-cyan-400"
              />
              {/* Quick size chips */}
              <div className="flex items-center gap-1 pt-0.5 overflow-x-auto no-scrollbar">
                {[20, 50, 80, 120, 200, 350].map((sz) => (
                  <button
                    key={sz}
                    onClick={() => onUpdateLiquifySettings?.({ size: sz })}
                    className={`px-1.5 py-0.5 text-[10px] rounded font-mono transition-colors cursor-pointer ${
                      size === sz
                        ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b]'
                        : 'bg-[#202226] text-[#888888] hover:text-white border border-[#2e3036]'
                    }`}
                  >
                    {sz}
                  </button>
                ))}
              </div>
            </div>

            {/* Strength Slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium text-[#aaaaaa]">Strength (Intensity):</label>
                <div className="flex items-center space-x-1">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={strength}
                    onChange={(e) =>
                      onUpdateLiquifySettings?.({
                        strength: Math.max(1, Math.min(100, Number(e.target.value) || 1)),
                      })
                    }
                    className="w-14 bg-[#141517] text-white text-right px-1.5 py-0.5 rounded border border-[#383a40] text-xs font-mono"
                  />
                  <span className="text-[10px] text-[#777777]">%</span>
                </div>
              </div>
              <input
                type="range"
                min={1}
                max={100}
                value={strength}
                onChange={(e) => onUpdateLiquifySettings?.({ strength: Number(e.target.value) })}
                className="w-full accent-cyan-400"
              />
            </div>

            {/* Hardness Slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-medium text-[#aaaaaa]">Hardness:</label>
                <div className="flex items-center space-x-1">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={hardness}
                    onChange={(e) =>
                      onUpdateLiquifySettings?.({
                        hardness: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                      })
                    }
                    className="w-14 bg-[#141517] text-white text-right px-1.5 py-0.5 rounded border border-[#383a40] text-xs font-mono"
                  />
                  <span className="text-[10px] text-[#777777]">%</span>
                </div>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={hardness}
                onChange={(e) => onUpdateLiquifySettings?.({ hardness: Number(e.target.value) })}
                className="w-full accent-cyan-400"
              />
            </div>

            {/* Pen Pressure sensitivity */}
            <div className="pt-2 border-t border-[#26282c]">
              <label className="flex items-center space-x-2 text-xs text-[#cccccc] cursor-pointer">
                <input
                  type="checkbox"
                  checked={usePressure}
                  onChange={(e) => onUpdateLiquifySettings?.({ usePressure: e.target.checked })}
                  className="rounded border-[#383a40] bg-[#141517] text-cyan-500 focus:ring-0"
                />
                <span>Pen Pressure Sensitivity</span>
              </label>
            </div>

            {/* Reset to Defaults */}
            <div className="pt-2">
              <button
                onClick={() =>
                  onUpdateLiquifySettings?.({
                    mode: 'push',
                    size: 80,
                    strength: 50,
                    hardness: 50,
                    usePressure: true,
                  })
                }
                className="w-full py-1.5 px-2 bg-[#202226] hover:bg-[#282a2e] text-[#888888] hover:text-white rounded text-xs transition-colors flex items-center justify-center space-x-1.5 cursor-pointer border border-[#2f323a]"
              >
                <span>Reset to Defaults</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <div className="flex h-full select-none z-10 shrink-0">
      {/* 1. Far Left Tool Strip */}
      <aside className="w-12 bg-[#1b1c1e] border-r border-[#2b2d31] flex flex-col items-center py-2 z-20 shrink-0">
        <div className="flex flex-col items-center space-y-1 w-full px-1">
          {/* Brush (B) */}
          <button
            onClick={() => {
              onSelectTool('brush');
              if (isHidden) onToggleHidden();
            }}
            title="Brush Tool (B)"
            className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
              currentTool === 'brush'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                : 'text-[#8c9099] hover:text-[#d0d3d9] hover:bg-[#25272a]'
            }`}
          >
            <Paintbrush className="w-4 h-4" />
            <div className="absolute left-11 bg-[#18191b] text-[#cccccc] text-xs px-2 py-1 rounded border border-[#33353b] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-md">
              Brush (B)
            </div>
          </button>

          {/* Eraser (E) */}
          <button
            onClick={() => onSelectTool('eraser')}
            title="Eraser Tool (E)"
            className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
              currentTool === 'eraser'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                : 'text-[#8c9099] hover:text-[#d0d3d9] hover:bg-[#25272a]'
            }`}
          >
            <Eraser className="w-4 h-4" />
            <div className="absolute left-11 bg-[#18191b] text-[#cccccc] text-xs px-2 py-1 rounded border border-[#33353b] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-md">
              Eraser (E)
            </div>
          </button>

          {/* Pipette / Eyedropper (I / Hold Alt) */}
          <button
            onClick={() => onSelectTool('pipette')}
            title="Pipette / Eyedropper (I / Hold Alt)"
            className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
              currentTool === 'pipette'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                : 'text-[#8c9099] hover:text-[#d0d3d9] hover:bg-[#25272a]'
            }`}
          >
            <Pipette className="w-4 h-4" />
            <div className="absolute left-11 bg-[#18191b] text-[#cccccc] text-xs px-2 py-1 rounded border border-[#33353b] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-md">
              Pipette (I / Hold Alt)
            </div>
          </button>

          {/* Liquify Tool (J) */}
          <button
            onClick={() => {
              onSelectTool('liquify');
              if (isHidden) onToggleHidden();
            }}
            title="Liquify Tool (J)"
            className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
              currentTool === 'liquify'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                : 'text-[#8c9099] hover:text-[#d0d3d9] hover:bg-[#25272a]'
            }`}
          >
            <LiquifyIcon className="w-4 h-4" />
            <div className="absolute left-11 bg-[#18191b] text-[#cccccc] text-xs px-2 py-1 rounded border border-[#33353b] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-md">
              Liquify (J)
            </div>
          </button>

          <div className="w-5 h-px bg-[#2b2d31] my-0.5" />

          {/* Transform (Ctrl+T) */}
          <button
            onClick={() => {
              onSelectTool('transform');
              onTransformSelection?.();
            }}
            title="Free Transform (Ctrl+T)"
            className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
              currentTool === 'transform'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                : 'text-[#8c9099] hover:text-[#d0d3d9] hover:bg-[#25272a]'
            }`}
          >
            <Scaling className="w-4 h-4" />
            <div className="absolute left-11 bg-[#18191b] text-[#cccccc] text-xs px-2 py-1 rounded border border-[#33353b] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-md">
              Transform (Ctrl+T)
            </div>
          </button>

          {/* Rectangular Marquee (M) */}
          <button
            onClick={() => onSelectTool('select-rect')}
            title="Rectangular Marquee (M)"
            className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
              currentTool === 'select-rect'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                : 'text-[#8c9099] hover:text-[#d0d3d9] hover:bg-[#25272a]'
            }`}
          >
            <BoxSelect className="w-4 h-4" />
            <div className="absolute left-11 bg-[#18191b] text-[#cccccc] text-xs px-2 py-1 rounded border border-[#33353b] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-md">
              Rect Marquee (M)
            </div>
          </button>

          {/* Lasso Selection (L) */}
          <button
            onClick={() => onSelectTool('select-lasso')}
            title="Lasso Selection (L)"
            className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
              currentTool === 'select-lasso'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                : 'text-[#8c9099] hover:text-[#d0d3d9] hover:bg-[#25272a]'
            }`}
          >
            <Lasso className="w-4 h-4" />
            <div className="absolute left-11 bg-[#18191b] text-[#cccccc] text-xs px-2 py-1 rounded border border-[#33353b] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-md">
              Lasso Tool (L)
            </div>
          </button>

          {/* Magic Wand (W) */}
          <button
            onClick={() => onSelectTool('select-wand')}
            title="Magic Wand (W)"
            className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
              currentTool === 'select-wand'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                : 'text-[#8c9099] hover:text-[#d0d3d9] hover:bg-[#25272a]'
            }`}
          >
            <Wand2 className="w-4 h-4" />
            <div className="absolute left-11 bg-[#18191b] text-[#cccccc] text-xs px-2 py-1 rounded border border-[#33353b] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-md">
              Magic Wand (W)
            </div>
          </button>

          {/* Selection Pen */}
          <button
            onClick={() => onSelectTool('select-pen')}
            title="Selection Pen"
            className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
              currentTool === 'select-pen'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                : 'text-[#8c9099] hover:text-[#d0d3d9] hover:bg-[#25272a]'
            }`}
          >
            <PenTool className="w-4 h-4" />
            <div className="absolute left-11 bg-[#18191b] text-[#cccccc] text-xs px-2 py-1 rounded border border-[#33353b] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-md">
              Selection Pen
            </div>
          </button>

          {/* Selection Eraser */}
          <button
            onClick={() => onSelectTool('select-eraser')}
            title="Selection Eraser"
            className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
              currentTool === 'select-eraser'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                : 'text-[#8c9099] hover:text-[#d0d3d9] hover:bg-[#25272a]'
            }`}
          >
            <Eraser className="w-4 h-4" />
            <div className="absolute left-11 bg-[#18191b] text-[#cccccc] text-xs px-2 py-1 rounded border border-[#33353b] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-md">
              Selection Eraser
            </div>
          </button>

          <div className="w-5 h-px bg-[#2b2d31] my-0.5" />

          {/* Fill Tool (G) */}
          <button
            onClick={() => onSelectTool('fill')}
            title="Fill Tool (G)"
            className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
              currentTool === 'fill'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                : 'text-[#8c9099] hover:text-[#d0d3d9] hover:bg-[#25272a]'
            }`}
          >
            <PaintBucket className="w-4 h-4" />
            <div className="absolute left-11 bg-[#18191b] text-[#cccccc] text-xs px-2 py-1 rounded border border-[#33353b] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-md">
              Fill Tool (G)
            </div>
          </button>

          {/* Text Tool (T) */}
          <button
            onClick={() => onSelectTool('text')}
            title="Text Tool (T)"
            className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
              currentTool === 'text'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                : 'text-[#8c9099] hover:text-[#d0d3d9] hover:bg-[#25272a]'
            }`}
          >
            <Type className="w-4 h-4" />
            <div className="absolute left-11 bg-[#18191b] text-[#cccccc] text-xs px-2 py-1 rounded border border-[#33353b] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-md">
              Text Tool (T)
            </div>
          </button>

          {/* Frame Border Tool (F) */}
          <button
            onClick={() => onSelectTool('frame')}
            title="Frame Border Tool (F)"
            className={`w-9 h-9 rounded flex items-center justify-center transition-colors relative group cursor-pointer ${
              currentTool === 'frame'
                ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                : 'text-[#8c9099] hover:text-[#d0d3d9] hover:bg-[#25272a]'
            }`}
          >
            <Frame className="w-4 h-4" />
            <div className="absolute left-11 bg-[#18191b] text-[#cccccc] text-xs px-2 py-1 rounded border border-[#33353b] opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 shadow-md">
              Frame Border (F)
            </div>
          </button>
        </div>

        {/* Bottom Swatches, Swap Button, and Hide/Show Button */}
        <div className="mt-auto flex flex-col items-center space-y-1.5 pb-2 w-full pt-2 border-t border-[#26282c]">
          {/* Overlapping Primary / Secondary Color Swatches */}
          <div className="relative w-8 h-8">
            {/* Secondary Color Swatch (bottom-right) */}
            <div
              onClick={onSwapColors}
              title={`Secondary Color: ${secondaryColor} (Click or press X to swap)`}
              className="absolute bottom-0 right-0 w-5 h-5 rounded-[1px] border border-[#44464c] cursor-pointer hover:border-white shadow-xs z-0"
              style={{ backgroundColor: secondaryColor }}
            />

            {/* Primary Color Swatch (top-left) */}
            <div
              onClick={() => {
                if (isTransparentColor) {
                  onToggleTransparentColor?.();
                } else {
                  onSwapColors();
                }
              }}
              title={`Primary Active Color: ${primaryColor} (Click to select/swap)`}
              className={`absolute top-0 left-0 w-5 h-5 rounded-[1px] cursor-pointer shadow-md z-10 transition-all ${
                !isTransparentColor
                  ? 'border border-white ring-1 ring-white/40'
                  : 'border border-[#44464c] hover:border-white opacity-80'
              }`}
              style={{ backgroundColor: primaryColor }}
            />
          </div>

          {/* Transparent Color Swatch (Clip Studio Paint style 'C' key toggle) */}
          <div
            onClick={onToggleTransparentColor}
            title="Transparent Ink / Color (C) - Brush as textured eraser"
            className={`w-7 h-3 rounded-[1px] border cursor-pointer relative overflow-hidden transition-all ${
              isTransparentColor
                ? 'border-[#38bdf8] ring-1 ring-[#38bdf8] shadow-xs scale-105'
                : 'border-[#44464c] hover:border-white opacity-80 hover:opacity-100'
            }`}
            style={{
              backgroundImage:
                'linear-gradient(45deg, #777 25%, transparent 25%), linear-gradient(-45deg, #777 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #777 75%), linear-gradient(-45deg, transparent 75%, #777 75%)',
              backgroundSize: '4px 4px',
              backgroundPosition: '0 0, 0 2px, 2px -2px, -2px 0px',
              backgroundColor: '#bbb',
            }}
          />

          {/* Swap Shortcut Button (X) */}
          <button
            onClick={onSwapColors}
            title="Swap Colors (X)"
            className="p-1 text-[#8c9099] hover:text-[#e0e0e0] hover:bg-[#282a2d] rounded transition-colors cursor-pointer"
          >
            <ArrowLeftRight className="w-3 h-3" />
          </button>

          {/* Panel Visibility Toggle Button */}
          <button
            onClick={onToggleHidden}
            title={isHidden ? 'Show Brush Settings ( [ )' : 'Hide Brush Settings ( [ )'}
            className="p-1.5 text-[#8c9099] hover:text-[#5ce1e6] hover:bg-[#282a2d] rounded transition-colors cursor-pointer"
          >
            {isHidden ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
        </div>
      </aside>

      {/* 2. Tool Settings & Brushes Panel (Collapsible & Resizable) */}
      {!isHidden && (
        <aside
          style={{ width }}
          className="relative bg-[#1e2023] border-r border-[#2b2d31] flex flex-col text-[#cccccc] text-xs shrink-0 overflow-hidden"
        >
          {isBrushOrEraser ? (
            <>
              {/* TOP SECTION: Brushes List */}
              <div
                style={{ height: topHeight }}
                className="flex flex-col shrink-0 overflow-hidden border-b border-[#2b2d31]"
              >
            {/* Top Section Header: Sub Tool [Tool] with view toggle & hide button */}
            <div className="h-8 px-2.5 flex items-center justify-between border-b border-[#2b2d31] bg-[#1a1b1e] shrink-0">
              <span className="text-xs font-semibold tracking-tight text-white truncate max-w-[150px]" title={`Sub Tool [${activeToolLabel}]`}>
                Sub Tool [{activeToolLabel}]
              </span>

              <div className="flex items-center space-x-1">
                {/* Import CSP Brush Button */}
                <button
                  onClick={() => sutInputRef.current?.click()}
                  title="Import Clip Studio Paint Brush (.sut)"
                  className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-[#202226] hover:bg-[#2a2e36] text-[#9fa3ad] hover:text-[#5ce1e6] border border-[#2f323a] text-[10px] font-medium transition-colors cursor-pointer"
                >
                  <Plus className="w-3 h-3 text-[#5ce1e6]" />
                  <span>Import .sut</span>
                </button>

                {/* View Mode Toggle (Preview vs Compact) */}
                <button
                  onClick={toggleBrushViewMode}
                  title={brushViewMode === 'preview' ? 'Switch to Compact List View' : 'Switch to Stroke Preview View (CSP Style)'}
                  className={`p-1 rounded transition-colors cursor-pointer ${
                    brushViewMode === 'preview'
                      ? 'text-[#5ce1e6] bg-[#293d45]/40 hover:bg-[#293d45]/70'
                      : 'text-[#828690] hover:text-[#cccccc] hover:bg-[#282a2e]'
                  }`}
                >
                  <LayoutList className="w-3.5 h-3.5" />
                </button>

                <button
                  onClick={onToggleHidden}
                  title="Hide Panel ( [ )"
                  className="p-1 text-[#828690] hover:text-rose-400 hover:bg-[#282a2e] rounded transition-colors cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <input
              type="file"
              ref={sutInputRef}
              accept=".sut"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  handleImportSut(file);
                }
                e.target.value = '';
              }}
            />

            {/* Category Filter Tabs */}
            <div className="px-2 pt-1 pb-1 flex items-center space-x-1 border-b border-[#25272c] overflow-x-auto no-scrollbar shrink-0 bg-[#161719]">
              {[
                { id: 'all', label: 'All' },
                { id: 'pencil-line', label: 'Pencil & Line' },
                { id: 'color-paint', label: 'Color & Paint' },
                { id: 'csp', label: `CSP${customBrushes.length > 0 ? ` (${customBrushes.length})` : ''}` },
              ].map((tab) => {
                const isActive = selectedCategory === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setSelectedCategory(tab.id as any)}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all whitespace-nowrap cursor-pointer ${
                      isActive
                        ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                        : 'text-[#828690] hover:text-[#d0d3d9] hover:bg-[#202226] border border-transparent'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Brushes List: Built-in Categories (Pencil & Line, Color & Paint) + Imported CSP Brushes */}
            <div
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('Files')) {
                  e.preventDefault();
                  setIsDraggingFileOver(true);
                }
              }}
              onDragLeave={() => setIsDraggingFileOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDraggingFileOver(false);
                const files = Array.from(e.dataTransfer.files).filter((f) =>
                  f.name.toLowerCase().endsWith('.sut')
                );
                if (files.length > 0) {
                  for (const f of files) {
                    handleImportSut(f);
                  }
                }
              }}
              className={`flex-1 overflow-y-auto p-2 space-y-1.5 relative ${
                isDraggingFileOver ? 'ring-2 ring-inset ring-[#5ce1e6] bg-[#5ce1e6]/5' : ''
              }`}
            >
              {/* Drag overlay indicator */}
              {isDraggingFileOver && (
                <div className="absolute inset-0 bg-[#161d22]/95 border-2 border-dashed border-[#5ce1e6] rounded z-30 flex flex-col items-center justify-center p-3 text-center pointer-events-none">
                  <FolderDown className="w-6 h-6 text-[#5ce1e6] mb-1 animate-bounce" />
                  <span className="text-xs font-semibold text-white">Drop .sut brush file</span>
                  <span className="text-[10px] text-[#5ce1e6]">Import to Ink Studio</span>
                </div>
              )}

              {/* Importing progress notice */}
              {isImportingSut && (
                <div className="p-2 rounded bg-[#1e2329] border border-[#37444d] text-center text-xs text-[#5ce1e6] flex items-center justify-center space-x-1.5 animate-pulse">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{importStatus || 'Importing Clip Studio Paint Brush...'}</span>
                </div>
              )}

              {/* Category: Pencil & Line */}
              {(selectedCategory === 'all' || selectedCategory === 'pencil-line') && (
                <div className="space-y-1.5">
                  {selectedCategory === 'all' && (
                    <div className="pt-0.5 pb-0.5 px-1 flex items-center justify-between">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-[#757a87]">
                        Pencil & Line
                      </span>
                    </div>
                  )}
                  {BUILTIN_BRUSHES.filter((b) => b.category === 'pencil-line').map((item) => {
                    const isSelected =
                      currentTool === 'brush' &&
                      (brushSettings.preset === item.id || (!brushSettings.preset && item.id === 'pencil-2b'));

                    return (
                      <div
                        key={item.id}
                        onClick={() => handleSelectBrushPreset(item.id)}
                        title={`${item.name} - ${item.desc}`}
                        className={`rounded cursor-pointer transition-colors border ${
                          isSelected
                            ? 'bg-[#293d45] text-white border-[#3e5e6b] shadow-xs'
                            : 'bg-[#1b1c1f]/60 hover:bg-[#232529] text-[#9fa3ad] hover:text-white border-[#27292e]/60 hover:border-[#34373e]'
                        } ${brushViewMode === 'preview' ? 'p-1.5' : 'px-2 py-1.5'}`}
                      >
                        <div className="flex items-center space-x-1.5 min-w-0">
                          {item.icon === 'pencil' ? (
                            <Pencil
                              className={`w-3.5 h-3.5 shrink-0 ${
                                isSelected ? 'text-amber-400' : 'text-[#8c9099]'
                              }`}
                            />
                          ) : (
                            <Paintbrush
                              className={`w-3.5 h-3.5 shrink-0 ${
                                isSelected ? 'text-[#5ce1e6]' : 'text-[#8c9099]'
                              }`}
                            />
                          )}
                          <div className="min-w-0">
                            <span className="font-medium text-xs block truncate leading-tight">
                              {item.name}
                            </span>
                            {brushViewMode === 'compact' && (
                              <span className="text-[10px] text-[#717682] block truncate leading-tight">
                                {item.desc}
                              </span>
                            )}
                          </div>
                        </div>

                        {brushViewMode === 'preview' && (
                          <div
                            className={`mt-1.5 w-full h-7 rounded-[3px] overflow-hidden flex items-center justify-center transition-colors ${
                              isSelected
                                ? 'bg-[#18262b] border border-[#3e5e6b]/40'
                                : 'bg-[#141517] border border-[#24262b]'
                            }`}
                            title={`${item.name} stroke preview`}
                          >
                            <BrushPreview
                              preset={item.id}
                              strokeColor="#ffffff"
                              height={28}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Category: Color & Paint (Soft Airbrush, Square Color Brush) */}
              {(selectedCategory === 'all' || selectedCategory === 'color-paint') && (
                <div className={`space-y-1.5 ${selectedCategory === 'all' ? 'pt-2' : ''}`}>
                  {selectedCategory === 'all' && (
                    <div className="pt-1 pb-0.5 px-1 flex items-center justify-between border-t border-[#26282c]">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-[#757a87]">
                        Color & Paint
                      </span>
                    </div>
                  )}
                  {BUILTIN_BRUSHES.filter((b) => b.category === 'color-paint').map((item) => {
                    const isSelected =
                      currentTool === 'brush' && brushSettings.preset === item.id;

                    return (
                      <div
                        key={item.id}
                        onClick={() => handleSelectBrushPreset(item.id)}
                        className={`rounded cursor-pointer transition-colors border ${
                          isSelected
                            ? 'bg-[#293d45] text-white border-[#3e5e6b] shadow-xs'
                            : 'bg-[#1b1c1f]/60 hover:bg-[#232529] text-[#9fa3ad] hover:text-white border-[#27292e]/60 hover:border-[#34373e]'
                        } ${brushViewMode === 'preview' ? 'p-1.5' : 'px-2.5 py-1.5'}`}
                      >
                        <div className="flex items-center justify-between min-w-0">
                          <div className="flex items-center space-x-1.5 min-w-0">
                            {item.icon === 'palette' ? (
                              <Palette
                                className={`w-3.5 h-3.5 shrink-0 ${
                                  isSelected ? 'text-emerald-400' : 'text-[#8c9099]'
                                }`}
                              />
                            ) : item.icon === 'square' ? (
                              <Square
                                className={`w-3.5 h-3.5 shrink-0 ${
                                  isSelected ? 'text-teal-400' : 'text-[#8c9099]'
                                }`}
                              />
                            ) : (
                              <Paintbrush
                                className={`w-3.5 h-3.5 shrink-0 ${
                                  isSelected ? 'text-[#5ce1e6]' : 'text-[#8c9099]'
                                }`}
                              />
                            )}
                            <div className="min-w-0">
                              <span className="font-medium text-xs block truncate leading-tight">
                                {item.name}
                              </span>
                              {brushViewMode === 'compact' && (
                                <span className="text-[10px] text-[#717682] block truncate leading-tight">
                                  {item.desc}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {brushViewMode === 'preview' && (
                          <div
                            className={`mt-1.5 w-full h-7 rounded-[3px] overflow-hidden flex items-center justify-center transition-colors ${
                              isSelected
                                ? 'bg-[#18262b] border border-[#3e5e6b]/40'
                                : 'bg-[#141517] border border-[#24262b]'
                            }`}
                            title={`${item.name} stroke preview`}
                          >
                            <BrushPreview
                              preset={item.id}
                              strokeColor="#ffffff"
                              height={28}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Category: Clip Studio Paint Imported Brushes */}
              {(selectedCategory === 'all' || selectedCategory === 'csp') && (
                <>
                  {customBrushes.length > 0 ? (
                    <div className={`space-y-1.5 ${selectedCategory === 'all' ? 'pt-2' : ''}`}>
                      {selectedCategory === 'all' && (
                        <div className="pt-1 pb-0.5 px-1 flex items-center justify-between border-t border-[#26282c]">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#757a87]">
                            Clip Studio Paint ({customBrushes.length})
                          </span>
                          <span className="text-[9px] px-1.5 py-0.2 rounded bg-[#5ce1e6]/10 text-[#5ce1e6] font-mono">
                            SUT
                          </span>
                        </div>
                      )}

                      {customBrushes.map((brush) => {
                        const isSelected = currentTool === 'brush' && brushSettings.preset === brush.id;
                        const tipImg = brush.tipDataUrl
                          ? getPreloadedTipImage(brush.tipDataUrl) || undefined
                          : undefined;

                        return (
                          <div
                            key={brush.id}
                            onClick={() => handleSelectCustomBrush(brush)}
                            className={`rounded cursor-pointer transition-colors border group relative ${
                              isSelected
                                ? 'bg-[#293d45] text-white border-[#3e5e6b] shadow-xs'
                                : 'bg-[#1b1c1f]/60 hover:bg-[#232529] text-[#9fa3ad] hover:text-white border-[#27292e]/60 hover:border-[#34373e]'
                            } ${brushViewMode === 'preview' ? 'p-1.5' : 'px-2.5 py-1.5'}`}
                          >
                            <div className="flex items-center justify-between min-w-0">
                              <div className="flex items-center space-x-1.5 min-w-0">
                                {brush.tipDataUrl ? (
                                  <div className="w-4 h-4 rounded-[2px] bg-[#121315] border border-[#2b2d31] flex items-center justify-center overflow-hidden shrink-0">
                                    <img
                                      src={brush.tipDataUrl}
                                      alt=""
                                      className="w-full h-full object-contain brightness-125"
                                    />
                                  </div>
                                ) : (
                                  <Sparkles
                                    className={`w-3.5 h-3.5 shrink-0 ${
                                      isSelected ? 'text-[#5ce1e6]' : 'text-[#8c9099]'
                                    }`}
                                  />
                                )}
                                <div className="min-w-0">
                                  <span className="font-medium text-xs block truncate leading-tight">
                                    {brush.name}
                                  </span>
                                  {brushViewMode === 'compact' && (
                                    <span className="text-[10px] text-[#717682] block truncate leading-tight">
                                      {brush.desc || 'Clip Studio Paint Brush'}
                                    </span>
                                  )}
                                </div>
                              </div>

                              <div className="flex items-center space-x-1 shrink-0 ml-1.5">
                                <button
                                  onClick={(e) => handleDeleteCustomBrush(e, brush.id)}
                                  title="Delete brush"
                                  className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-rose-400 rounded transition-opacity"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            </div>

                            {/* Authentic CSP S-Curve Stroke Preview */}
                            {brushViewMode === 'preview' && (
                              <div
                                className={`mt-1.5 w-full h-7 rounded-[3px] overflow-hidden flex items-center justify-center transition-colors ${
                                  isSelected
                                    ? 'bg-[#18262b] border border-[#3e5e6b]/40'
                                    : 'bg-[#141517] border border-[#24262b]'
                                }`}
                                title={`${brush.name} stroke preview`}
                              >
                                <BrushPreview
                                  preset={brush.id}
                                  settings={brush}
                                  customTipImage={tipImg}
                                  customTipAngle={brush.angle}
                                  strokeColor="#ffffff"
                                  height={28}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : selectedCategory === 'csp' ? (
                    <div className="text-center py-6 px-3 border border-dashed border-[#2d3036] rounded-lg my-2">
                      <FolderDown className="w-6 h-6 text-[#5ce1e6]/60 mx-auto mb-1.5" />
                      <p className="text-xs font-medium text-[#cccccc]">No imported CSP brushes</p>
                      <p className="text-[10px] text-[#717682] mt-0.5 mb-2.5">
                        Drag & drop any Clip Studio Paint .sut file here
                      </p>
                      <button
                        onClick={() => sutInputRef.current?.click()}
                        className="inline-flex items-center space-x-1 px-2.5 py-1 rounded bg-[#202226] hover:bg-[#293d45] text-[#5ce1e6] border border-[#33363e] text-xs font-medium transition-colors cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Select .sut File</span>
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {/* RESIZABLE HORIZONTAL DIVIDER between Brushes and Tool Settings */}
          <div
            onMouseDown={handleHeightResizeMouseDown}
            title="Drag to resize height"
            className="group relative h-1.5 w-full cursor-row-resize flex items-center justify-center shrink-0 hover:bg-[#5ce1e6]/40 transition-colors z-20"
          >
            <div className="w-8 h-0.5 bg-[#3a3d44] group-hover:bg-[#5ce1e6] rounded-full transition-colors" />
          </div>

          {/* BOTTOM SECTION: Tool Property & Brush Size Presets */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Sub-Palette Tabs: Tool Property vs Brush Size */}
            <div className="h-9 px-2 flex items-center justify-between border-b border-[#2b2d31] bg-[#1a1b1e] shrink-0">
              <div className="flex items-center space-x-1">
                <button
                  type="button"
                  onClick={() => handleSelectBottomTab('settings')}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors cursor-pointer truncate max-w-[140px] ${
                    bottomTab === 'settings'
                      ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                      : 'text-[#828690] hover:text-[#cccccc] hover:bg-[#202226] border border-transparent'
                  }`}
                  title={`Tool property [${activeToolLabel}]`}
                >
                  Tool property [{activeToolLabel}]
                </button>
                <button
                  type="button"
                  onClick={() => handleSelectBottomTab('size')}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors flex items-center space-x-1 cursor-pointer ${
                    bottomTab === 'size'
                      ? 'bg-[#293d45] text-[#5ce1e6] border border-[#3e5e6b] shadow-xs'
                      : 'text-[#828690] hover:text-[#cccccc] hover:bg-[#202226] border border-transparent'
                  }`}
                >
                  <span>Brush Size</span>
                  <span className="text-[10px] font-mono text-[#5ce1e6] bg-[#141517] px-1 rounded border border-[#2b2d31]">
                    {brushSettings.size}
                  </span>
                </button>
              </div>
            </div>

            {bottomTab === 'size' ? (
              <BrushSizePalette
                currentSize={brushSettings.size}
                onSelectSize={(newSize) => handleUpdateBrushSettings({ size: newSize })}
                activeBrushName={
                  currentTool === 'eraser'
                    ? 'Eraser'
                    : brushSettings.brushName || activeCustomBrush?.name || activeBuiltinBrush?.name || activePencilConfig?.name || 'Brush'
                }
                tool={currentTool}
                presetId={currentTool === 'eraser' ? ERASER_PRESET_ID : brushSettings.preset}
                onResetSizeToDefault={() => {
                  const def = resetBrushSettingsToDefault(currentTool === 'eraser' ? ERASER_PRESET_ID : (brushSettings.preset || 'pencil-2b'), customBrushes);
                  if (def.size !== undefined) {
                    handleUpdateBrushSettings({ size: def.size });
                  }
                }}
                onResetAllSettings={() => {
                  const def = resetBrushSettingsToDefault(currentTool === 'eraser' ? ERASER_PRESET_ID : (brushSettings.preset || 'pencil-2b'), customBrushes);
                  handleUpdateBrushSettings(def);
                }}
                className="flex-1 overflow-y-auto"
              />
            ) : (
              <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
              {/* Active Tool Name Indicator */}
              <div className="flex items-center justify-between pb-1 text-white font-medium text-xs border-b border-[#26282c]">
                <div className="flex items-center space-x-2 min-w-0">
                  {currentTool === 'brush' ? (
                    isPencilActive ? (
                      <>
                        <Pencil className="w-4 h-4 text-amber-400 shrink-0" />
                        <span className="truncate">{activePencilConfig?.name || 'Pencil'}</span>
                      </>
                    ) : isCustomBrushActive ? (
                      <>
                        <Sparkles className="w-4 h-4 text-[#5ce1e6] shrink-0" />
                        <span className="truncate">
                          {brushSettings.brushName || activeCustomBrush?.name || 'CSP Brush'}
                        </span>
                      </>
                    ) : activeBuiltinBrush ? (
                      <>
                        {activeBuiltinBrush.icon === 'palette' ? (
                          <Palette className="w-4 h-4 text-emerald-400 shrink-0" />
                        ) : activeBuiltinBrush.icon === 'square' ? (
                          <Square className="w-4 h-4 text-teal-400 shrink-0" />
                        ) : (
                          <Paintbrush className="w-4 h-4 text-[#5ce1e6] shrink-0" />
                        )}
                        <span className="truncate">{activeBuiltinBrush.name}</span>
                      </>
                    ) : (
                      <>
                        <Paintbrush className="w-4 h-4 text-[#5ce1e6] shrink-0" />
                        <span className="truncate">Round Brush</span>
                      </>
                    )
                  ) : (
                    <>
                      <Eraser className="w-4 h-4 text-rose-400 shrink-0" />
                      <span>Eraser</span>
                    </>
                  )}
                </div>

                {currentTool === 'brush' && isPencilActive && activePencilConfig && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-amber-500/15 text-amber-300 border border-amber-500/30 uppercase shrink-0">
                    Grade {activePencilConfig.gradeLabel}
                  </span>
                )}
                {currentTool === 'brush' && activeBuiltinBrush && !isPencilActive && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono border uppercase shrink-0 ${activeBuiltinBrush.badgeBg} ${activeBuiltinBrush.badgeText} ${activeBuiltinBrush.badgeBorder}`}>
                    {activeBuiltinBrush.badge}
                  </span>
                )}
                {currentTool === 'brush' && isCustomBrushActive && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 uppercase shrink-0">
                    CSP
                  </span>
                )}
              </div>

              {/* Brush Tip Shape Card (Custom CSP or Procedural Tip) */}
              {brushSettings.customTipDataUrl && (
                <div className="bg-[#141517] border border-[#292b30] rounded p-2 flex items-center space-x-2.5">
                  <div className="w-9 h-9 rounded bg-[#0d0e10] border border-[#2b2d31] flex items-center justify-center overflow-hidden shrink-0">
                    <img
                      src={brushSettings.customTipDataUrl}
                      alt="Tip Shape"
                      className="w-full h-full object-contain filter invert contrast-200"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-[11px] font-medium text-[#cccccc] block truncate">
                      {activeBuiltinBrush ? 'Procedural Tip Shape' : 'Extracted Tip Mask'}
                    </span>
                    <span className="text-[10px] text-[#717682] block truncate">
                      {activeBuiltinBrush
                        ? `${activeBuiltinBrush.name} Mask`
                        : activeCustomBrush?.tipWidth && activeCustomBrush?.tipHeight
                        ? `${activeCustomBrush.tipWidth} × ${activeCustomBrush.tipHeight} px`
                        : 'SUT Tip Bitmap'}
                    </span>
                  </div>
                </div>
              )}

              {/* Dynamic Live Brush Dynamics Preview Card */}
              <div className="bg-[#141517] border border-[#292b30] rounded p-2.5 space-y-1.5 shadow-sm">
                <div className="flex items-center justify-between text-xs text-[#8c9099]">
                  <span className="font-medium text-[#cccccc] flex items-center space-x-1.5 text-[11px]">
                    <Sparkles className="w-3.5 h-3.5 text-[#5ce1e6]" />
                    <span>Live Stroke Preview</span>
                  </span>

                  <button
                    onClick={() => setUsePrimaryColorPreview(!usePrimaryColorPreview)}
                    title={usePrimaryColorPreview ? 'Switch to Neutral White Preview' : 'Switch to Active Color Preview'}
                    className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-[#1f2125] hover:bg-[#282b30] border border-[#33363d] text-[10px] text-[#a0a4ae] hover:text-white transition-colors cursor-pointer"
                  >
                    <span
                      className="w-2 h-2 rounded-full inline-block border border-white/40"
                      style={{ backgroundColor: usePrimaryColorPreview ? primaryColor : '#ffffff' }}
                    />
                    <span>{usePrimaryColorPreview ? 'Color' : 'White'}</span>
                  </button>
                </div>

                {/* S-curve stroke preview canvas */}
                <div className="w-full h-11 rounded bg-[#0d0e10] border border-[#212327] overflow-hidden flex items-center justify-center">
                  <BrushPreview
                    preset={brushSettings.preset}
                    settings={brushSettings}
                    customTipImage={brushSettings.customTipImage}
                    customTipAngle={brushSettings.customTipAngle}
                    tool={currentTool}
                    strokeColor={usePrimaryColorPreview ? primaryColor : '#ffffff'}
                    height={44}
                    isLiveCard={true}
                  />
                </div>

                {/* Live parameters summary */}
                <div className="flex items-center justify-between text-[10px] text-[#6e727d] font-mono px-0.5 pt-0.5">
                  <span>{brushSettings.size}px</span>
                  <span>{Math.round((brushSettings.flow ?? 0.85) * 100)}% flow</span>
                  {isPencilActive ? (
                    <span>{Math.round((brushSettings.grain ?? 0.95) * 100)}% tooth</span>
                  ) : (
                    <span>{Math.round((brushSettings.hardness ?? 1.0) * 100)}% hard</span>
                  )}
                  <span>{Math.round((brushSettings.opacity ?? 1.0) * 100)}% op</span>
                </div>
              </div>

              {/* 1. Size Slider */}
              <div className="space-y-1.5">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#a0a4ae] font-medium">Size</span>
                  <div className="bg-[#151618] border border-[#2e3035] rounded px-2 py-0.5 text-right font-mono text-[#dcdfe6] text-xs min-w-16">
                    {brushSettings.size} px
                  </div>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max={isPencilActive ? 80 : 250}
                  step={isPencilActive ? 0.5 : 1}
                  value={brushSettings.size}
                  onChange={(e) => handleUpdateBrushSettings({ size: Number(e.target.value) })}
                  className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-[#5ce1e6]"
                />

                {/* Quick Presets Row under Size Slider */}
                <div className="pt-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-[#717682] uppercase tracking-wider font-semibold">Presets</span>
                    <button
                      type="button"
                      onClick={() => handleSelectBottomTab('size')}
                      className="text-[10px] text-[#5ce1e6] hover:underline cursor-pointer flex items-center space-x-0.5"
                    >
                      <span>All 40 Presets</span>
                      <ChevronRight className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="grid grid-cols-8 gap-1">
                    {[1, 2, 4, 8, 12, 20, 30, 60].map((sz) => (
                      <button
                        key={sz}
                        type="button"
                        onClick={() => handleUpdateBrushSettings({ size: sz })}
                        className={`py-0.5 rounded text-[10px] font-mono text-center transition-colors cursor-pointer border ${
                          Math.abs(brushSettings.size - sz) < 0.05
                            ? 'bg-[#37485e] border-[#4e6a88] text-white font-bold'
                            : 'bg-[#151618] border-[#292b30] text-[#999fae] hover:text-white hover:bg-[#25282f]'
                        }`}
                      >
                        {sz}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 2. Opacity Slider */}
              <div className="space-y-1.5">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#a0a4ae] font-medium">Opacity</span>
                  <div className="bg-[#151618] border border-[#2e3035] rounded px-2 py-0.5 text-right font-mono text-[#dcdfe6] text-xs min-w-16">
                    {Math.round((brushSettings.opacity ?? 1.0) * 100)}%
                  </div>
                </div>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={Math.round((brushSettings.opacity ?? 1.0) * 100)}
                  onChange={(e) => handleUpdateBrushSettings({ opacity: Number(e.target.value) / 100 })}
                  className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-[#5ce1e6]"
                />
              </div>

              {/* 3. Flow Slider (Graphite Flow Rate) */}
              <div className="space-y-1.5">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#a0a4ae] font-medium">
                    {isPencilActive ? 'Graphite Flow' : 'Flow'}
                  </span>
                  <div className="bg-[#151618] border border-[#2e3035] rounded px-2 py-0.5 text-right font-mono text-[#dcdfe6] text-xs min-w-16">
                    {Math.round((brushSettings.flow ?? 0.85) * 100)}%
                  </div>
                </div>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={Math.round((brushSettings.flow ?? 0.85) * 100)}
                  onChange={(e) => handleUpdateBrushSettings({ flow: Number(e.target.value) / 100 })}
                  className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-[#5ce1e6]"
                />
              </div>

              {/* 3b. Real Paper Grain Tooth Slider (for pencils) */}
              {isPencilActive && (
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center text-xs">
                    <div className="flex items-center space-x-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                      <span className="text-[#a0a4ae] font-medium">Paper Tooth (Grain)</span>
                    </div>
                    <div className="bg-[#151618] border border-[#2e3035] rounded px-2 py-0.5 text-right font-mono text-[#dcdfe6] text-xs min-w-16">
                      {Math.round((brushSettings.grain ?? 0.95) * 100)}%
                    </div>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={Math.round((brushSettings.grain ?? 0.95) * 100)}
                    onChange={(e) => handleUpdateBrushSettings({ grain: Number(e.target.value) / 100 })}
                    className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-amber-400"
                    title="Real Cold-Press Paper Grain: higher values produce richer organic sketchbook tooth"
                  />
                </div>
              )}

              {/* 4. Spacing Slider */}
              <div className="space-y-1.5">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#a0a4ae] font-medium">Spacing</span>
                  <div className="bg-[#151618] border border-[#2e3035] rounded px-2 py-0.5 text-right font-mono text-[#dcdfe6] text-xs min-w-16">
                    {Math.round((brushSettings.spacing ?? 0.1) * 100)}%
                  </div>
                </div>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={Math.round((brushSettings.spacing ?? 0.1) * 100)}
                  onChange={(e) => handleUpdateBrushSettings({ spacing: Number(e.target.value) / 100 })}
                  className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-[#5ce1e6]"
                />
              </div>

              {/* 5. Stabilization Slider */}
              <div className="space-y-1.5">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#a0a4ae] font-medium">Stabilization</span>
                  <div className="bg-[#151618] border border-[#2e3035] rounded px-2 py-0.5 text-right font-mono text-[#dcdfe6] text-xs min-w-16">
                    {brushSettings.stabilization ?? 15}
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={brushSettings.stabilization ?? 15}
                  onChange={(e) => handleUpdateBrushSettings({ stabilization: Number(e.target.value) })}
                  className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-[#5ce1e6]"
                />
              </div>

              {/* 5b. Tip Angle Slider (for CSP / Custom Brushes) */}
              {isCustomBrushActive && brushSettings.customTipDataUrl && (
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-[#a0a4ae] font-medium">Tip Angle</span>
                    <div className="flex items-center space-x-1">
                      <button
                        onClick={() => handleUpdateBrushSettings({ customTipAngle: 0 })}
                        className="text-[10px] text-[#717682] hover:text-[#5ce1e6] px-1.5 py-0.5 rounded bg-[#151618] border border-[#2e3035] transition-colors cursor-pointer"
                        title="Reset Angle to 0°"
                      >
                        0°
                      </button>
                      <div className="bg-[#151618] border border-[#2e3035] rounded px-2 py-0.5 text-right font-mono text-[#dcdfe6] text-xs min-w-14">
                        {Math.round(brushSettings.customTipAngle ?? 0)}°
                      </div>
                    </div>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="360"
                    value={Math.round(brushSettings.customTipAngle ?? 0)}
                    onChange={(e) => handleUpdateBrushSettings({ customTipAngle: Number(e.target.value) })}
                    className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-[#5ce1e6]"
                  />
                </div>
              )}

              {/* Advanced Dynamics Accordion */}
              <div className="pt-2 border-t border-[#2b2d31]">
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="w-full flex items-center justify-between text-xs text-[#8c9099] hover:text-white py-1 transition-colors cursor-pointer"
                >
                  <span>Advanced Dynamics</span>
                  {showAdvanced ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>

                {showAdvanced && (
                  <div className="pt-2 space-y-3">
                    {/* Hardness */}
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-[#8c9099]">Hardness</span>
                        <span className="font-mono text-white">
                          {Math.round((brushSettings.hardness ?? 1.0) * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0.05"
                        max="1.0"
                        step="0.05"
                        value={brushSettings.hardness ?? 1.0}
                        onChange={(e) => handleUpdateBrushSettings({ hardness: Number(e.target.value) })}
                        className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-[#5ce1e6]"
                      />
                    </div>

                    {/* Stylus Pressure Sensitivity */}
                    <div className="flex items-center justify-between py-1">
                      <div className="flex items-center space-x-1.5">
                        <Activity className="w-3.5 h-3.5 text-[#8c9099]" />
                        <span className="text-xs text-[#cccccc]">Stylus Pressure</span>
                      </div>
                      <input
                        type="checkbox"
                        checked={brushSettings.usePressure}
                        onChange={(e) => handleUpdateBrushSettings({ usePressure: e.target.checked })}
                        className="rounded bg-[#1a1b1e] border-[#383a40] text-[#5ce1e6] focus:ring-0 cursor-pointer"
                      />
                    </div>

                    {/* Min Pressure Taper */}
                    {brushSettings.usePressure && (
                      <div className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="text-[#8c9099]">Min Pressure Width</span>
                          <span className="font-mono text-white">
                            {Math.round(brushSettings.minSizeFactor * 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0.05"
                          max="0.8"
                          step="0.05"
                          value={brushSettings.minSizeFactor}
                          onChange={(e) => handleUpdateBrushSettings({ minSizeFactor: Number(e.target.value) })}
                          className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-[#5ce1e6]"
                        />
                      </div>
                    )}

                    {/* Bézier Smoothing */}
                    <div className="flex items-center justify-between py-1">
                      <div className="flex items-center space-x-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-[#8c9099]" />
                        <span className="text-xs text-[#cccccc]">Bézier Smoothing</span>
                      </div>
                      <input
                        type="checkbox"
                        checked={brushSettings.smoothing}
                        onChange={(e) => handleUpdateBrushSettings({ smoothing: e.target.checked })}
                        className="rounded bg-[#1a1b1e] border-[#383a40] text-[#5ce1e6] focus:ring-0 cursor-pointer"
                      />
                    </div>

                    {/* GPU Video Card Hardware Acceleration */}
                    <div className="pt-2 border-t border-[#26282c] space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-1.5">
                          <Zap className="w-3.5 h-3.5 text-[#5ce1e6]" />
                          <span className="text-xs text-[#cccccc] font-medium">Video Card (GPU)</span>
                        </div>
                        <input
                          type="checkbox"
                          checked={brushSettings.useGpu !== false}
                          onChange={(e) => handleUpdateBrushSettings({ useGpu: e.target.checked })}
                          className="rounded bg-[#1a1b1e] border-[#383a40] text-[#5ce1e6] focus:ring-0 cursor-pointer"
                        />
                      </div>
                      <div className="bg-[#121315] border border-[#27292e] rounded p-2 text-[10px] space-y-0.5">
                        <div className="flex items-center justify-between text-[#5ce1e6]">
                          <span className="font-semibold">GPU Shader Core</span>
                          <span className="px-1 py-0.2 rounded bg-[#5ce1e6]/10 text-[9px] font-mono">ACTIVE</span>
                        </div>
                        <div className="text-[#8c9099] truncate font-mono text-[9px]" title={gpuInfo.renderer}>
                          {gpuInfo.renderer || 'Hardware Accelerated Video Card'}
                        </div>
                      </div>
                    </div>

                    {/* CSP Color Mixing */}
                    <div className="pt-2 border-t border-[#26282c] space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-1.5">
                          <Droplets className="w-3.5 h-3.5 text-cyan-400" />
                          <span className="text-xs text-[#cccccc] font-medium">Color Mixing</span>
                          <span className="text-[9px] px-1 py-0.2 rounded bg-cyan-500/15 text-cyan-300 font-mono font-medium">SUBTRACTIVE</span>
                        </div>
                        <input
                          type="checkbox"
                          checked={Boolean(brushSettings.colorMixing)}
                          onChange={(e) => handleUpdateBrushSettings({ colorMixing: e.target.checked })}
                          className="rounded bg-[#1a1b1e] border-[#383a40] text-[#5ce1e6] focus:ring-0 cursor-pointer"
                        />
                      </div>

                      {brushSettings.colorMixing && (
                        <div className="space-y-2.5 pt-1 pl-1 border-l border-[#2e3138]">
                          {/* Mixing Mode: Blend vs Running Color */}
                          <div className="flex rounded bg-[#151618] p-0.5 border border-[#2b2d32]">
                            <button
                              onClick={() => handleUpdateBrushSettings({ mixingMode: 'blend' })}
                              className={`flex-1 py-0.5 text-[10px] rounded transition-colors ${
                                (brushSettings.mixingMode || 'blend') === 'blend'
                                    ? 'bg-[#293d45] text-[#5ce1e6] font-medium shadow-xs'
                                    : 'text-[#828690] hover:text-[#cccccc]'
                              }`}
                            >
                              Blend
                            </button>
                            <button
                              onClick={() => handleUpdateBrushSettings({ mixingMode: 'running_color' })}
                              className={`flex-1 py-0.5 text-[10px] rounded transition-colors ${
                                brushSettings.mixingMode === 'running_color'
                                    ? 'bg-[#293d45] text-[#5ce1e6] font-medium shadow-xs'
                                    : 'text-[#828690] hover:text-[#cccccc]'
                              }`}
                            >
                              Running Color
                            </button>
                          </div>

                          {/* Amount of Paint */}
                          <div className="space-y-1">
                            <div className="flex justify-between text-xs">
                              <span className="text-[#8c9099]">Amount of Paint</span>
                              <span className="font-mono text-white">
                                {Math.round((brushSettings.amountOfPaint ?? 0.7) * 100) === 0
                                  ? '0% (Pure Smudge)'
                                  : `${Math.round((brushSettings.amountOfPaint ?? 0.7) * 100)}%`}
                              </span>
                            </div>
                            <input
                              type="range"
                              min="0"
                              max="100"
                              value={Math.round((brushSettings.amountOfPaint ?? 0.7) * 100)}
                              onChange={(e) => handleUpdateBrushSettings({ amountOfPaint: Number(e.target.value) / 100 })}
                              className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-[#5ce1e6]"
                            />
                          </div>

                          {/* Density of Paint */}
                          <div className="space-y-1">
                            <div className="flex justify-between text-xs">
                              <span className="text-[#8c9099]">Density of Paint</span>
                              <span className="font-mono text-white">
                                {Math.round((brushSettings.densityOfPaint ?? 0.8) * 100)}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min="1"
                              max="100"
                              value={Math.round((brushSettings.densityOfPaint ?? 0.8) * 100)}
                              onChange={(e) => handleUpdateBrushSettings({ densityOfPaint: Number(e.target.value) / 100 })}
                              className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-[#5ce1e6]"
                            />
                          </div>

                          {/* Color Stretch */}
                          <div className="space-y-1">
                            <div className="flex justify-between text-xs">
                              <span className="text-[#8c9099]">Color Stretch</span>
                              <span className="font-mono text-white">
                                {Math.round((brushSettings.colorStretch ?? 0.6) * 100)}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min="1"
                              max="100"
                              value={Math.round((brushSettings.colorStretch ?? 0.6) * 100)}
                              onChange={(e) => handleUpdateBrushSettings({ colorStretch: Number(e.target.value) / 100 })}
                              className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-[#5ce1e6]"
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Wet Edge (Watercolor) */}
                    <div className="space-y-1 pt-2 border-t border-[#26282c]">
                      <div className="flex justify-between text-xs">
                        <span className="text-[#8c9099]">Wet Edge (Watercolor)</span>
                        <span className="font-mono text-white">
                          {Math.round((brushSettings.wetEdge ?? 0) * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={Math.round((brushSettings.wetEdge ?? 0) * 100)}
                        onChange={(e) => handleUpdateBrushSettings({ wetEdge: Number(e.target.value) / 100 })}
                        className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-cyan-400"
                      />
                    </div>

                    {/* Paper Tooth Grain (for non-pencil brushes as well) */}
                    {!isPencilActive && (
                      <div className="space-y-1 pt-1">
                        <div className="flex justify-between text-xs">
                          <span className="text-[#8c9099]">Paper Tooth (Grain)</span>
                          <span className="font-mono text-white">
                            {Math.round((brushSettings.grain ?? 0) * 100)}%
                          </span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={Math.round((brushSettings.grain ?? 0) * 100)}
                          onChange={(e) => handleUpdateBrushSettings({ grain: Number(e.target.value) / 100 })}
                          className="w-full h-1 bg-[#282a2e] rounded appearance-none cursor-pointer accent-amber-400"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        </>
      ) : (
        renderToolSettings()
      )}

          {/* RESIZABLE RIGHT EDGE (Hover gives col-resize; dragging adjusts panel width) */}
          <div
            onMouseDown={handleWidthResizeMouseDown}
            title="Drag to resize brush settings panel width"
            className="group absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-[#5ce1e6]/60 active:bg-[#5ce1e6] transition-colors z-30"
          >
            <div className="w-full h-full opacity-0 group-hover:opacity-100 bg-[#5ce1e6]/60 transition-opacity" />
          </div>
        </aside>
      )}
    </div>
  );
});

LeftPanel.displayName = 'LeftPanel';
