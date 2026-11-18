import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Paintbrush,
  Pencil,
  Eraser,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Loader2,
  FolderDown,
  Palette,
  Square,
  BoxSelect,
  Lasso,
  PaintBucket,
  Type,
  Frame,
  Scaling,
  Pipette,
  Maximize2,
  Minimize2,
  RotateCcw,
  Wand2,
  PenTool,
  Feather,
  MessageSquare,
  Spline,
  Sparkles,
} from 'lucide-react';
import {
  ToolType,
  BrushSettings,
  BrushPresetId,
  CspBrush,
  BrushDynamics,
  DEFAULT_BRUSH_DYNAMICS,
  FillSettings,
  TextSettings,
  FrameSettings,
  LiquifySettings,
  LiquifyMode,
  WandSettings,
  BalloonSettings,
  VectorEditSettings,
  CspAngleDynamicsMode,
  CspBlendTipsMode,
  CspPaperTextureMode,
  CspTipFlipMode,
  CspTaperSettings,
  CspSpraySettings,
} from '../types/editor';
import { LiquifyIcon } from './LiquifyIcon';
import { parseSutFile } from '../utils/sutParser';
import {
  loadCustomBrushes,
  getCachedCustomBrushes,
  saveCustomBrush,
  saveCustomBrushDebounced,
  deleteCustomBrush,
  preloadTipImage,
  prepareBrushSettingsForCsp,
  CUSTOM_BRUSHES_CHANGED_EVENT,
} from '../utils/brushStorage';
import { resolveBrushTipImage } from '../utils/brushOutline';
import { BUILTIN_BRUSHES, BrushCategory } from '../utils/presetBrushes';
import {
  getEffectiveBrushSettings,
  getSavedBrushSettings,
  resetBrushSettingsToDefault,
  saveActivePresetId,
  ERASER_PRESET_ID,
} from '../utils/brushPresetManager';
import { renderBrushStrokePreview } from '../utils/brushPreview';
import { CSP_PRESSURE_CURVE_PRESETS } from '../engine/CspBrushEngine';

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
  balloonSettings?: BalloonSettings;
  onUpdateBalloonSettings?: (newSettings: Partial<BalloonSettings>) => void;
  vectorEditSettings?: VectorEditSettings;
  onUpdateVectorEditSettings?: (newSettings: Partial<VectorEditSettings>) => void;
  onOpenMangaEffects?: () => void;
  wandSettings?: WandSettings;
  onUpdateWandSettings?: (newSettings: Partial<WandSettings>) => void;
  onExpandSelection?: (pixels: number) => void;
  onContractSelection?: (pixels: number) => void;
  onFeatherSelection?: (radius: number) => void;
  onInvertSelection?: () => void;
}

interface CompactSliderProps {
  label: string;
  valueLabel: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (val: number) => void;
}

const CompactSlider: React.FC<CompactSliderProps> = ({
  label,
  valueLabel,
  min,
  max,
  step = 1,
  value,
  onChange,
}) => (
  <div className="space-y-1">
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-[#8a8a8a] truncate">{label}</span>
      <span className="font-mono text-[10px] text-[#e5e5e5] ml-1 shrink-0">{valueLabel}</span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full"
    />
  </div>
);

const LIQUIFY_MODES: Array<{ id: LiquifyMode; label: string }> = [
  { id: 'push', label: 'Push' },
  { id: 'expand', label: 'Expand' },
  { id: 'pinch', label: 'Pinch' },
  { id: 'push-left', label: 'Push Left' },
  { id: 'push-right', label: 'Push Right' },
  { id: 'twirl-cw', label: 'Twirl CW' },
  { id: 'twirl-ccw', label: 'Twirl CCW' },
  { id: 'reconstruct', label: 'Reconstruct' },
];

type InspectorAccordionId = 'ink' | 'tip' | 'stroke' | 'mixing' | 'texture' | 'dynamics';

const DEFAULT_TAPER: CspTaperSettings = {
  useIn: false,
  inLength: 24,
  inRatio: 0.9,
  useOut: false,
  outLength: 32,
  outRatio: 0.9,
  startingSharpness: 0.85,
  endingSharpness: 0.85,
  affectSize: true,
};

const DEFAULT_SPRAY: CspSpraySettings = {
  enabled: false,
  size: 4,
  density: 12,
  bias: 0.5,
};

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
  onDeselect,
  onTransformSelection,
  liquifySettings,
  onUpdateLiquifySettings,
  balloonSettings,
  onUpdateBalloonSettings,
  vectorEditSettings,
  onUpdateVectorEditSettings,
  onOpenMangaEffects,
  wandSettings,
  onUpdateWandSettings,
  onExpandSelection,
  onContractSelection,
  onFeatherSelection,
  onInvertSelection,
}) => {
  const [openAccordion, setOpenAccordion] = useState<InspectorAccordionId | null>(null);
  const [customBrushes, setCustomBrushes] = useState<CspBrush[]>(() => getCachedCustomBrushes());
  const [isImportingSut, setIsImportingSut] = useState(false);
  const [isDraggingFileOver, setIsDraggingFileOver] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<'all' | BrushCategory | 'csp'>('all');
  const sutInputRef = useRef<HTMLInputElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);

  const [isDraggingWidth, setIsDraggingWidth] = useState(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(width);

  const syncCustomBrushes = useCallback(() => {
    loadCustomBrushes().then((brushes) => {
      setCustomBrushes(brushes);
      for (const b of brushes) {
        if (b.tipDataUrl) preloadTipImage(b.tipDataUrl).catch(() => {});
        if (b.secondaryTipDataUrl) preloadTipImage(b.secondaryTipDataUrl).catch(() => {});
        if (b.subTips) {
          for (const st of b.subTips) {
            if (st.dataUrl) preloadTipImage(st.dataUrl).catch(() => {});
          }
        }
        if (b.paperTexture) preloadTipImage(b.paperTexture).catch(() => {});
      }
    });
  }, []);

  useEffect(() => {
    syncCustomBrushes();
    const handleChanged = () => {
      setCustomBrushes([...getCachedCustomBrushes()]);
    };
    window.addEventListener(CUSTOM_BRUSHES_CHANGED_EVENT, handleChanged);
    return () => window.removeEventListener(CUSTOM_BRUSHES_CHANGED_EVENT, handleChanged);
  }, [syncCustomBrushes]);

  useEffect(() => {
    if (!isDraggingWidth) return;
    const handlePointerMove = (e: PointerEvent) => {
      const delta = e.clientX - dragStartXRef.current;
      const newWidth = Math.max(128, Math.min(300, Math.round(dragStartWidthRef.current + delta)));
      onWidthChange(newWidth);
    };
    const handlePointerUp = () => setIsDraggingWidth(false);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isDraggingWidth, onWidthChange]);

  const isBrushOrEraser = currentTool === 'brush' || currentTool === 'eraser';

  // Coalesce live S-curve stroke preview redraws to a single animation frame
  useEffect(() => {
    if (isHidden || !isBrushOrEraser) return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const cssWidth = Math.max(96, width - 16);
    const cssHeight = 32;
    const rafId = requestAnimationFrame(() => {
      const resolvedTip = resolveBrushTipImage(brushSettings);
      renderBrushStrokePreview(
        canvas,
        cssWidth,
        cssHeight,
        {
          preset: brushSettings.preset,
          size: brushSettings.size,
          flow: brushSettings.flow,
          opacity: brushSettings.opacity,
          grain: brushSettings.grain,
          hardness: brushSettings.hardness,
          spacing: brushSettings.spacing,
          minSizeFactor: brushSettings.minSizeFactor,
          usePressure: brushSettings.usePressure,
          color: currentTool === 'eraser' ? '#e5e5e5' : '#ececec',
          backgroundColor: '#161616',
          tool: currentTool === 'eraser' ? 'eraser' : 'brush',
          customTipImage: resolvedTip,
          customTipAngle: brushSettings.customTipAngle,
          thickness: brushSettings.thickness,
          thicknessVertical: brushSettings.thicknessVertical,
          flipH: brushSettings.flipH,
          flipV: brushSettings.flipV,
          blendTipsMode: brushSettings.blendTipsMode,
          adjustDensityByGap: brushSettings.adjustDensityByGap,
          antiAlias: brushSettings.antiAlias,
          pressureCurve: brushSettings.pressureCurve,
          spray: brushSettings.spray,
          colorMixing: brushSettings.colorMixing,
          amountOfPaint: brushSettings.amountOfPaint,
          densityOfPaint: brushSettings.densityOfPaint,
          colorStretch: brushSettings.colorStretch,
          wetEdge: brushSettings.wetEdge,
        },
        true
      );
    });
    return () => cancelAnimationFrame(rafId);
  }, [isHidden, isBrushOrEraser, width, currentTool, brushSettings]);

  const activePreset: BrushPresetId = brushSettings.preset || 'pencil-2b';
  const activeBuiltinBrush = BUILTIN_BRUSHES.find((b) => b.id === activePreset);
  const isCustomBrushActive =
    currentTool === 'brush' &&
    (activePreset.startsWith('csp-') || (Boolean(brushSettings.customTipDataUrl) && !activeBuiltinBrush));
  const activeCustomBrush = isCustomBrushActive
    ? customBrushes.find((b) => b.id === activePreset)
    : null;

  const handleUpdateBrushSettings = (newSettings: Partial<BrushSettings>) => {
    onUpdateBrushSettings(newSettings);
    if (isCustomBrushActive && activeCustomBrush) {
      const updatedBrush: CspBrush = {
        ...activeCustomBrush,
        size: newSettings.size ?? activeCustomBrush.size,
        opacity: newSettings.opacity ?? activeCustomBrush.opacity,
        flow: newSettings.flow ?? activeCustomBrush.flow,
        brushDensity: newSettings.brushDensity ?? newSettings.flow ?? activeCustomBrush.brushDensity,
        adjustDensityByGap: newSettings.adjustDensityByGap ?? activeCustomBrush.adjustDensityByGap,
        blendTipsMode: newSettings.blendTipsMode ?? activeCustomBrush.blendTipsMode,
        spacing: newSettings.spacing ?? activeCustomBrush.spacing,
        hardness: newSettings.hardness ?? activeCustomBrush.hardness,
        thickness: newSettings.thickness ?? activeCustomBrush.thickness,
        thicknessVertical: newSettings.thicknessVertical ?? activeCustomBrush.thicknessVertical,
        antiAlias: newSettings.antiAlias ?? activeCustomBrush.antiAlias,
        stabilization: newSettings.stabilization ?? activeCustomBrush.stabilization,
        postCorrection: newSettings.postCorrection ?? activeCustomBrush.postCorrection,
        sharpCorners: newSettings.sharpCorners ?? activeCustomBrush.sharpCorners,
        angle: newSettings.customTipAngle ?? activeCustomBrush.angle,
        angleDynamics: newSettings.customTipAngleDynamics ?? activeCustomBrush.angleDynamics,
        flipH: newSettings.flipH ?? activeCustomBrush.flipH,
        flipV: newSettings.flipV ?? activeCustomBrush.flipV,
        isRibbon: newSettings.isRibbon ?? activeCustomBrush.isRibbon,
        usePressure: newSettings.usePressure ?? activeCustomBrush.usePressure,
        useTilt: newSettings.useTilt ?? activeCustomBrush.useTilt,
        useVelocity: newSettings.useVelocity ?? activeCustomBrush.useVelocity,
        pressureCurve: newSettings.pressureCurve ?? activeCustomBrush.pressureCurve,
        taper: newSettings.taper ?? activeCustomBrush.taper,
        spray: newSettings.spray ?? activeCustomBrush.spray,
        colorMixing: newSettings.colorMixing ?? activeCustomBrush.colorMixing,
        mixingMode: newSettings.mixingMode ?? activeCustomBrush.mixingMode,
        amountOfPaint: newSettings.amountOfPaint ?? activeCustomBrush.amountOfPaint,
        densityOfPaint: newSettings.densityOfPaint ?? activeCustomBrush.densityOfPaint,
        colorStretch: newSettings.colorStretch ?? activeCustomBrush.colorStretch,
        wetEdge: newSettings.wetEdge ?? activeCustomBrush.wetEdge,
        wetEdgeRadius: newSettings.wetEdgeRadius ?? activeCustomBrush.wetEdgeRadius,
        textureDensity: newSettings.grain ?? activeCustomBrush.textureDensity,
        paperTextureMode: newSettings.paperTextureMode ?? activeCustomBrush.paperTextureMode,
        paperTextureScale: newSettings.paperTextureScale ?? activeCustomBrush.paperTextureScale,
        paperTextureInverted: newSettings.paperTextureInverted ?? activeCustomBrush.paperTextureInverted,
        dynamics: newSettings.dynamics ?? activeCustomBrush.dynamics,
      };
      setCustomBrushes((prev) => prev.map((b) => (b.id === updatedBrush.id ? updatedBrush : b)));
      saveCustomBrushDebounced(updatedBrush);
    }
  };

  const handleUpdateDynamics = (patch: Partial<BrushDynamics>) => {
    const cur = brushSettings.dynamics || DEFAULT_BRUSH_DYNAMICS;
    handleUpdateBrushSettings({ dynamics: { ...cur, ...patch } });
  };

  const handleUpdateTaper = (patch: Partial<CspTaperSettings>) => {
    const cur = brushSettings.taper || DEFAULT_TAPER;
    handleUpdateBrushSettings({ taper: { ...cur, ...patch } });
  };

  const handleUpdateSpray = (patch: Partial<CspSpraySettings>) => {
    const cur = brushSettings.spray || DEFAULT_SPRAY;
    handleUpdateBrushSettings({ spray: { ...cur, ...patch } });
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
      flipH: 'none',
      flipV: 'none',
      isRibbon: false,
      colorMixing: false,
      wetEdge: 0,
      grain: 0,
      spray: undefined,
      taper: undefined,
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
    try {
      const buffer = await file.arrayBuffer();
      const parsedBrush = await parseSutFile(buffer, file.name);
      const existing = customBrushes.filter(
        (b) => b.name.toLowerCase() === parsedBrush.name.toLowerCase() || b.id === parsedBrush.id
      );
      for (const old of existing) {
        await deleteCustomBrush(old.id).catch(() => {});
      }
      await saveCustomBrush(parsedBrush);
      setCustomBrushes((prev) => [
        parsedBrush,
        ...prev.filter(
          (b) => b.name.toLowerCase() !== parsedBrush.name.toLowerCase() && b.id !== parsedBrush.id
        ),
      ]);
      await handleSelectCustomBrush(parsedBrush);
    } catch (err: any) {
      alert(err.message || 'Failed to import Clip Studio Paint brush file.');
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

  const toggleAccordion = (id: InspectorAccordionId) => {
    setOpenAccordion((prev) => (prev === id ? null : id));
  };

  const toolItems: Array<{
    id: ToolType;
    label: string;
    icon: React.ReactNode;
    dividerAfter?: boolean;
    onClick?: () => void;
  }> = [
    {
      id: 'brush',
      label: 'Brush (B)',
      icon: <Paintbrush className="w-3.5 h-3.5" />,
      onClick: () => {
        onSelectTool('brush');
        if (isHidden) onToggleHidden();
      },
    },
    { id: 'eraser', label: 'Eraser (E)', icon: <Eraser className="w-3.5 h-3.5" /> },
    { id: 'pipette', label: 'Eyedropper (I)', icon: <Pipette className="w-3.5 h-3.5" /> },
    {
      id: 'liquify',
      label: 'Liquify (J)',
      icon: <LiquifyIcon className="w-3.5 h-3.5" />,
      dividerAfter: true,
    },
    {
      id: 'transform',
      label: 'Transform (Ctrl+T)',
      icon: <Scaling className="w-3.5 h-3.5" />,
      onClick: () => {
        onSelectTool('transform');
        onTransformSelection?.();
      },
    },
    { id: 'select-rect', label: 'Marquee (M)', icon: <BoxSelect className="w-3.5 h-3.5" /> },
    { id: 'select-lasso', label: 'Lasso (L)', icon: <Lasso className="w-3.5 h-3.5" /> },
    { id: 'select-wand', label: 'Magic Wand (W)', icon: <Wand2 className="w-3.5 h-3.5" /> },
    {
      id: 'select-pen',
      label: 'Selection Pen',
      icon: <PenTool className="w-3.5 h-3.5" />,
      dividerAfter: true,
    },
    { id: 'fill', label: 'Fill (G)', icon: <PaintBucket className="w-3.5 h-3.5" /> },
    { id: 'text', label: 'Text (T)', icon: <Type className="w-3.5 h-3.5" /> },
    { id: 'frame', label: 'Frame Border (F)', icon: <Frame className="w-3.5 h-3.5" /> },
    { id: 'balloon', label: 'Speech Balloon', icon: <MessageSquare className="w-3.5 h-3.5" /> },
    { id: 'vector-edit', label: 'Correct Line', icon: <Spline className="w-3.5 h-3.5" /> },
  ];

  const renderContextualToolPanel = () => {
    if (currentTool === 'fill') {
      const method = fillSettings?.method ?? 'refer-all';
      return (
        <div className="p-2.5 space-y-3 overflow-y-auto flex-1">
          <div className="text-[11px] font-medium text-[#e5e5e5]">Fill</div>
          <div className="space-y-1">
            {(
              [
                { id: 'refer-all', label: 'All Visible' },
                { id: 'refer-active', label: 'Active Layer' },
                { id: 'refer-reference', label: 'Reference Layer' },
                { id: 'lasso', label: 'Lasso Fill' },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onUpdateFillSettings?.({ method: m.id })}
                className={`w-full px-2 py-1 rounded text-left text-[11px] transition-colors cursor-pointer ${
                  method === m.id
                    ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {method !== 'lasso' && (
            <>
              <CompactSlider
                label="Tolerance"
                valueLabel={`${fillSettings?.tolerance ?? 32}`}
                min={0}
                max={100}
                value={fillSettings?.tolerance ?? 32}
                onChange={(v) => onUpdateFillSettings?.({ tolerance: v })}
              />
              <CompactSlider
                label="Close Gap"
                valueLabel={`${fillSettings?.closeGap ?? 0}px`}
                min={0}
                max={20}
                value={fillSettings?.closeGap ?? 0}
                onChange={(v) => onUpdateFillSettings?.({ closeGap: v })}
              />
              <CompactSlider
                label="Area Scaling"
                valueLabel={`${(fillSettings?.areaScale ?? 0) > 0 ? '+' : ''}${fillSettings?.areaScale ?? 0}px`}
                min={-20}
                max={20}
                value={fillSettings?.areaScale ?? 0}
                onChange={(v) => onUpdateFillSettings?.({ areaScale: v })}
              />
              <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                <span>Anti-Alias</span>
                <input
                  type="checkbox"
                  checked={fillSettings?.antiAlias ?? true}
                  onChange={(e) => onUpdateFillSettings?.({ antiAlias: e.target.checked })}
                />
              </label>
            </>
          )}
        </div>
      );
    }

    if (currentTool === 'liquify') {
      const activeMode = liquifySettings?.mode ?? 'push';
      return (
        <div className="p-2 space-y-3 overflow-y-auto flex-1">
          <div className="px-0.5 text-[11px] font-medium text-[#e5e5e5]">Liquify</div>
          <div className="space-y-0.5">
            {LIQUIFY_MODES.map((sub) => (
              <button
                key={sub.id}
                type="button"
                onClick={() => onUpdateLiquifySettings?.({ mode: sub.id })}
                className={`w-full px-2 py-1 rounded text-left text-[11px] transition-colors cursor-pointer ${
                  activeMode === sub.id
                    ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                }`}
              >
                {sub.label}
              </button>
            ))}
          </div>
          <CompactSlider
            label="Size"
            valueLabel={`${liquifySettings?.size ?? 80}px`}
            min={4}
            max={500}
            value={liquifySettings?.size ?? 80}
            onChange={(v) => onUpdateLiquifySettings?.({ size: v })}
          />
          <CompactSlider
            label="Strength"
            valueLabel={`${liquifySettings?.strength ?? 50}%`}
            min={1}
            max={100}
            value={liquifySettings?.strength ?? 50}
            onChange={(v) => onUpdateLiquifySettings?.({ strength: v })}
          />
          <CompactSlider
            label="Hardness"
            valueLabel={`${liquifySettings?.hardness ?? 50}%`}
            min={0}
            max={100}
            value={liquifySettings?.hardness ?? 50}
            onChange={(v) => onUpdateLiquifySettings?.({ hardness: v })}
          />
          <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
            <span>Pressure</span>
            <input
              type="checkbox"
              checked={liquifySettings?.usePressure ?? true}
              onChange={(e) => onUpdateLiquifySettings?.({ usePressure: e.target.checked })}
            />
          </label>
        </div>
      );
    }

    if (
      currentTool === 'select-rect' ||
      currentTool === 'select-lasso' ||
      currentTool === 'select-wand' ||
      currentTool === 'select-pen' ||
      currentTool === 'select-eraser'
    ) {
      const activeWand = wandSettings || {
        tolerance: 32,
        contiguous: true,
        antiAlias: true,
        referMode: 'active' as const,
      };
      return (
        <div className="p-2.5 space-y-3 overflow-y-auto flex-1">
          <div className="text-[11px] font-medium text-[#e5e5e5]">Selection</div>
          <div className="grid grid-cols-2 gap-1">
            {(
              [
                { id: 'select-rect', label: 'Rect' },
                { id: 'select-lasso', label: 'Lasso' },
                { id: 'select-wand', label: 'Wand' },
                { id: 'select-pen', label: 'Pen' },
                { id: 'select-eraser', label: 'Erase' },
              ] as const
            ).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelectTool(s.id)}
                className={`py-1 px-1.5 rounded text-[11px] transition-colors cursor-pointer ${
                  currentTool === s.id
                    ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {(currentTool === 'select-pen' || currentTool === 'select-eraser') && (
            <CompactSlider
              label="Brush Size"
              valueLabel={`${brushSettings.size}px`}
              min={1}
              max={250}
              value={Math.round(brushSettings.size)}
              onChange={(v) => onUpdateBrushSettings({ size: v })}
            />
          )}

          {currentTool === 'select-wand' && (
            <div className="space-y-2.5 pt-1">
              <CompactSlider
                label="Tolerance"
                valueLabel={`${activeWand.tolerance}`}
                min={0}
                max={255}
                value={activeWand.tolerance}
                onChange={(v) => onUpdateWandSettings?.({ tolerance: v })}
              />
              <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                <span>Contiguous</span>
                <input
                  type="checkbox"
                  checked={activeWand.contiguous}
                  onChange={(e) => onUpdateWandSettings?.({ contiguous: e.target.checked })}
                />
              </label>
              <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                <span>Anti-Alias</span>
                <input
                  type="checkbox"
                  checked={activeWand.antiAlias}
                  onChange={(e) => onUpdateWandSettings?.({ antiAlias: e.target.checked })}
                />
              </label>
              <div className="grid grid-cols-3 gap-0.5 bg-[#161616] p-0.5 rounded">
                {(['active', 'all', 'reference'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onUpdateWandSettings?.({ referMode: mode })}
                    className={`py-0.5 rounded text-[10px] capitalize cursor-pointer ${
                      activeWand.referMode === mode
                        ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                        : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                    }`}
                  >
                    {mode === 'reference' ? 'Ref' : mode}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1 pt-1">
            <div className="grid grid-cols-3 gap-1">
              <button
                type="button"
                onClick={() => onExpandSelection?.(5)}
                title="Expand 5px"
                className="py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] flex items-center justify-center cursor-pointer"
              >
                <Maximize2 className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => onContractSelection?.(5)}
                title="Contract 5px"
                className="py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] flex items-center justify-center cursor-pointer"
              >
                <Minimize2 className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => onFeatherSelection?.(5)}
                title="Feather 5px"
                className="py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[#8a8a8a] hover:text-[#e5e5e5] flex items-center justify-center cursor-pointer"
              >
                <Feather className="w-3 h-3" />
              </button>
            </div>
            <button
              type="button"
              onClick={onInvertSelection}
              className="w-full py-1 px-2 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Invert</span>
            </button>
            <button
              type="button"
              onClick={onTransformSelection}
              className="w-full py-1 px-2 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] flex items-center gap-1.5 cursor-pointer"
            >
              <Scaling className="w-3 h-3" />
              <span>Transform</span>
            </button>
            <button
              type="button"
              onClick={onDeselect}
              className="w-full py-1 px-2 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer text-left"
            >
              Deselect
            </button>
          </div>
        </div>
      );
    }

    if (currentTool === 'text') {
      return (
        <div className="p-2.5 space-y-3 overflow-y-auto flex-1">
          <div className="text-[11px] font-medium text-[#e5e5e5]">Text</div>
          <select
            value={textSettings?.fontFamily}
            onChange={(e) => onUpdateTextSettings?.({ fontFamily: e.target.value })}
            className="w-full px-2 py-1 text-[11px]"
          >
            <option value="'Neucha', 'Anime Ace', 'Comic Sans MS', sans-serif">Manga / Anime</option>
            <option value="'Anime Ace', 'Comic Sans MS', sans-serif">Anime Ace</option>
            <option value="Arial, sans-serif">Arial</option>
            <option value="Impact, sans-serif">Impact</option>
            <option value="Georgia, serif">Georgia</option>
          </select>
          <div className="grid grid-cols-2 gap-1 bg-[#161616] p-0.5 rounded">
            <button
              type="button"
              onClick={() => onUpdateTextSettings?.({ writingMode: 'horizontal-tb' })}
              className={`py-1 rounded text-[10px] cursor-pointer ${
                textSettings?.writingMode !== 'vertical-rl'
                  ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                  : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
              }`}
            >
              Horiz
            </button>
            <button
              type="button"
              onClick={() => onUpdateTextSettings?.({ writingMode: 'vertical-rl' })}
              className={`py-1 rounded text-[10px] cursor-pointer ${
                textSettings?.writingMode === 'vertical-rl'
                  ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                  : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
              }`}
            >
              Vert
            </button>
          </div>
          <CompactSlider
            label="Font Size"
            valueLabel={`${textSettings?.fontSize ?? 28}px`}
            min={12}
            max={160}
            value={textSettings?.fontSize ?? 28}
            onChange={(v) => onUpdateTextSettings?.({ fontSize: v })}
          />
        </div>
      );
    }

    if (currentTool === 'frame') {
      return (
        <div className="p-2.5 space-y-3 overflow-y-auto flex-1">
          <div className="text-[11px] font-medium text-[#e5e5e5]">Frame Border</div>
          <CompactSlider
            label="Thickness"
            valueLabel={`${frameSettings?.thickness ?? 4}px`}
            min={1}
            max={100}
            value={frameSettings?.thickness ?? 4}
            onChange={(v) => onUpdateFrameSettings?.({ thickness: v })}
          />
          <div className="grid grid-cols-2 gap-1 bg-[#161616] p-0.5 rounded">
            <button
              type="button"
              onClick={() => onUpdateFrameSettings?.({ fillBackground: true })}
              className={`py-1 rounded text-[10px] cursor-pointer ${
                frameSettings?.fillBackground
                  ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                  : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
              }`}
            >
              White
            </button>
            <button
              type="button"
              onClick={() => onUpdateFrameSettings?.({ fillBackground: false })}
              className={`py-1 rounded text-[10px] cursor-pointer ${
                !frameSettings?.fillBackground
                  ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                  : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
              }`}
            >
              Empty
            </button>
          </div>
        </div>
      );
    }

    if (currentTool === 'balloon') {
      return (
        <div className="p-2.5 space-y-3 overflow-y-auto flex-1">
          <div className="text-[11px] font-medium text-[#e5e5e5]">Balloon</div>
          <div className="space-y-0.5">
            {(['ellipse', 'rounded-rect', 'jagged-flash', 'thought'] as const).map((shape) => (
              <button
                key={shape}
                type="button"
                onClick={() => onUpdateBalloonSettings?.({ shape })}
                className={`w-full px-2 py-1 rounded text-left text-[11px] capitalize cursor-pointer ${
                  balloonSettings?.shape === shape
                    ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                }`}
              >
                {shape.replace('-', ' ')}
              </button>
            ))}
          </div>
          <CompactSlider
            label="Border"
            valueLabel={`${balloonSettings?.strokeWidth ?? 3}px`}
            min={1}
            max={15}
            value={balloonSettings?.strokeWidth ?? 3}
            onChange={(v) => onUpdateBalloonSettings?.({ strokeWidth: v })}
          />
        </div>
      );
    }

    if (currentTool === 'vector-edit') {
      const activeMode = vectorEditSettings?.mode || 'pinch';
      return (
        <div className="p-2.5 space-y-3 overflow-y-auto flex-1">
          <div className="text-[11px] font-medium text-[#e5e5e5]">Correct Line</div>
          <div className="space-y-0.5">
            {(['pinch', 'width', 'simplify'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onUpdateVectorEditSettings?.({ mode: m })}
                className={`w-full px-2 py-1 rounded text-left text-[11px] capitalize cursor-pointer ${
                  activeMode === m
                    ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <CompactSlider
            label="Radius"
            valueLabel={`${vectorEditSettings?.radius ?? 30}px`}
            min={5}
            max={150}
            value={vectorEditSettings?.radius ?? 30}
            onChange={(v) => onUpdateVectorEditSettings?.({ radius: v })}
          />
          {activeMode === 'pinch' && (
            <CompactSlider
              label="Pinch Level"
              valueLabel={`${Math.round((vectorEditSettings?.pinchStrength ?? 0.65) * 100)}%`}
              min={10}
              max={100}
              value={Math.round((vectorEditSettings?.pinchStrength ?? 0.65) * 100)}
              onChange={(v) => onUpdateVectorEditSettings?.({ pinchStrength: v / 100 })}
            />
          )}
          {activeMode === 'width' && (
            <CompactSlider
              label="Adjust Width"
              valueLabel={`${(vectorEditSettings?.widthFactor ?? 1.2) >= 1 ? '+' : ''}${Math.round(((vectorEditSettings?.widthFactor ?? 1.2) - 1) * 100)}%`}
              min={50}
              max={200}
              value={Math.round((vectorEditSettings?.widthFactor ?? 1.2) * 100)}
              onChange={(v) => onUpdateVectorEditSettings?.({ widthFactor: v / 100 })}
            />
          )}
          {activeMode === 'simplify' && (
            <CompactSlider
              label="Simplify"
              valueLabel={`${(vectorEditSettings?.simplifyTolerance ?? 2.0).toFixed(1)}px`}
              min={0.5}
              max={12}
              step={0.5}
              value={vectorEditSettings?.simplifyTolerance ?? 2.0}
              onChange={(v) => onUpdateVectorEditSettings?.({ simplifyTolerance: v })}
            />
          )}
          {onOpenMangaEffects && (
            <button
              type="button"
              onClick={onOpenMangaEffects}
              className="w-full py-1.5 px-2 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[11px] text-[#e5e5e5] cursor-pointer"
            >
              Effect Lines...
            </button>
          )}
        </div>
      );
    }

    return (
      <div className="p-2.5 text-[11px] text-[#8a8a8a]">
        <div className="text-[#e5e5e5] font-medium capitalize mb-1">{currentTool}</div>
        <p className="leading-relaxed">Click or drag directly on the canvas.</p>
      </div>
    );
  };

  const visibleBuiltinBrushes = BUILTIN_BRUSHES.filter((b) => {
    if (selectedCategory === 'all') return true;
    if (selectedCategory === 'csp') return false;
    return b.category === selectedCategory;
  });

  const showCspBrushes = selectedCategory === 'all' || selectedCategory === 'csp';
  const currentAntiAlias = brushSettings.antiAlias ?? 2;

  return (
    <div className="flex h-full select-none z-10 shrink-0 gap-px bg-[#161616]">
      {/* 1. Narrow 44px Tool Strip */}
      <aside className="w-[44px] bg-[#202020] flex flex-col items-center py-1.5 z-20 shrink-0">
        <div className="flex flex-col items-center gap-0.5 w-full px-1">
          {toolItems.map((item) => {
            const isActive = currentTool === item.id;
            return (
              <React.Fragment key={item.id}>
                <button
                  type="button"
                  onClick={() => (item.onClick ? item.onClick() : onSelectTool(item.id))}
                  title={item.label}
                  className={`relative w-8 h-7 rounded flex items-center justify-center transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-[#2c2c2c] text-[var(--accent)]'
                      : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]'
                  }`}
                >
                  {isActive && (
                    <span
                      className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full"
                      style={{ backgroundColor: 'var(--accent)' }}
                    />
                  )}
                  {item.icon}
                </button>
                {item.dividerAfter && <div className="w-4 h-px bg-[#2c2c2c] my-1" />}
              </React.Fragment>
            );
          })}
        </div>

        {/* Bottom Color Swatches & Collapse Toggle */}
        <div className="mt-auto flex flex-col items-center gap-1.5 pt-2 pb-1 w-full">
          <div className="relative w-6 h-6">
            <div
              onClick={onSwapColors}
              title={`Secondary: ${secondaryColor} (X to swap, D to reset)`}
              className="absolute bottom-0 right-0 w-4 h-4 rounded-sm cursor-pointer shadow-[0_0_0_1px_rgba(255,255,255,0.18)]"
              style={{ backgroundColor: secondaryColor }}
            />
            <div
              onClick={() => {
                if (isTransparentColor) onToggleTransparentColor?.();
                else onSwapColors();
              }}
              title={`Primary: ${primaryColor}`}
              className={`absolute top-0 left-0 w-4 h-4 rounded-sm cursor-pointer z-10 ${
                !isTransparentColor
                  ? 'shadow-[0_0_0_1.5px_var(--accent)]'
                  : 'opacity-70 shadow-[0_0_0_1px_rgba(255,255,255,0.2)]'
              }`}
              style={{ backgroundColor: primaryColor }}
            />
          </div>

          <div
            onClick={onToggleTransparentColor}
            title="Transparent Ink (C)"
            className={`w-6 h-2.5 rounded-xs cursor-pointer transition-all ${
              isTransparentColor ? 'shadow-[0_0_0_1.5px_var(--accent)]' : 'opacity-65 hover:opacity-100'
            }`}
            style={{
              backgroundImage: 'repeating-conic-gradient(#777 0% 25%, #ccc 0% 50%)',
              backgroundSize: '4px 4px',
            }}
          />

          <button
            type="button"
            onClick={onSwapColors}
            title="Swap Colors (X)"
            className="w-7 h-6 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            <ArrowLeftRight className="w-3 h-3" />
          </button>

          <button
            type="button"
            onClick={onToggleHidden}
            title={isHidden ? 'Show Panel (Shift+Tab)' : 'Hide Panel (Shift+Tab)'}
            className="w-7 h-7 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] transition-colors cursor-pointer"
          >
            {isHidden ? <PanelLeftOpen className="w-3.5 h-3.5" /> : <PanelLeftClose className="w-3.5 h-3.5" />}
          </button>
        </div>
      </aside>

      {/* 2. CSP Sub-Tool List + Sub-Tool Detail Inspector */}
      {!isHidden && (
        <aside
          style={{ width }}
          className="relative bg-[#202020] flex flex-col text-[#e5e5e5] text-xs shrink-0 overflow-hidden"
        >
          {isBrushOrEraser ? (
            <>
              {/* Category Filter Strip + Import .sut */}
              <div className="px-1.5 py-1.5 flex items-center gap-1 shrink-0">
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value as 'all' | BrushCategory | 'csp')}
                  aria-label="Brush Category"
                  className="flex-1 min-w-0 h-5 bg-[#161616] text-[#e5e5e5] text-[11px] px-1.5 rounded cursor-pointer"
                >
                  <option value="all" className="bg-[#202020]">All Brushes</option>
                  <option value="pencil-line" className="bg-[#202020]">Pencil &amp; Ink</option>
                  <option value="color-paint" className="bg-[#202020]">Color &amp; Paint</option>
                  <option value="csp" className="bg-[#202020]">CSP Imported</option>
                </select>

                <button
                  type="button"
                  onClick={() => sutInputRef.current?.click()}
                  title="Import CSP Brush (.sut)"
                  className="w-5 h-5 rounded flex items-center justify-center text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] shrink-0 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>

              <input
                type="file"
                ref={sutInputRef}
                accept=".sut"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleImportSut(file);
                  e.target.value = '';
                }}
              />

              {/* Compact High-Density Sub-Tool List */}
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
                  for (const f of files) handleImportSut(f);
                }}
                className="flex-1 overflow-y-auto px-1.5 py-0.5 space-y-0.5 relative min-h-[84px]"
              >
                {isDraggingFileOver && (
                  <div className="absolute inset-1 bg-[#161616]/95 rounded flex flex-col items-center justify-center p-2 text-center z-30 pointer-events-none">
                    <FolderDown className="w-4 h-4 text-[var(--accent)] mb-1" />
                    <span className="text-[10px] text-[#e5e5e5]">Drop .sut</span>
                  </div>
                )}

                {isImportingSut && (
                  <div className="px-2 py-1 rounded bg-[#2c2c2c] text-[10px] text-[#e5e5e5] flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span className="truncate">Importing...</span>
                  </div>
                )}

                {visibleBuiltinBrushes.map((item) => {
                  const isSelected =
                    currentTool === 'brush' &&
                    (brushSettings.preset === item.id || (!brushSettings.preset && item.id === 'pencil-2b'));

                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectBrushPreset(item.id)}
                      title={`${item.name} - ${item.desc}`}
                      className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-left transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                          : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                      }`}
                    >
                      {item.icon === 'pencil' ? (
                        <Pencil className="w-3 h-3 shrink-0 opacity-80" />
                      ) : item.icon === 'palette' ? (
                        <Palette className="w-3 h-3 shrink-0 opacity-80" />
                      ) : item.icon === 'square' ? (
                        <Square className="w-3 h-3 shrink-0 opacity-80" />
                      ) : (
                        <Paintbrush className="w-3 h-3 shrink-0 opacity-80" />
                      )}
                      <span className="text-[11px] truncate leading-tight flex-1">{item.name}</span>
                    </button>
                  );
                })}

                {showCspBrushes &&
                  customBrushes.map((brush) => {
                    const isSelected = currentTool === 'brush' && brushSettings.preset === brush.id;
                    return (
                      <div
                        key={brush.id}
                        onClick={() => handleSelectCustomBrush(brush)}
                        title={brush.name}
                        className={`group flex items-center justify-between gap-1 px-2 py-1 rounded cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                            : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          {brush.tipDataUrl ? (
                            <img
                              src={brush.tipDataUrl}
                              alt=""
                              className="w-3 h-3 object-contain shrink-0 brightness-125"
                            />
                          ) : (
                            <Sparkles className="w-3 h-3 shrink-0 opacity-80" />
                          )}
                          <span className="text-[11px] truncate leading-tight">{brush.name}</span>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => handleDeleteCustomBrush(e, brush.id)}
                          title="Delete brush"
                          className="opacity-0 group-hover:opacity-100 text-[#8a8a8a] hover:text-red-400 shrink-0 cursor-pointer"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                        </button>
                      </div>
                    );
                  })}

                {selectedCategory === 'csp' && customBrushes.length === 0 && (
                  <div className="py-4 px-2 text-center space-y-2">
                    <p className="text-[10px] text-[#8a8a8a]">Drop .sut brush file</p>
                    <button
                      type="button"
                      onClick={() => sutInputRef.current?.click()}
                      className="px-2 py-1 rounded bg-[#2c2c2c] text-[10px] text-[#e5e5e5] cursor-pointer"
                    >
                      Import .sut
                    </button>
                  </div>
                )}
              </div>

              {/* Live S-Curve Stroke Preview + Quick Size/Opacity Bar */}
              <div className="shrink-0 bg-[#1b1b1b] border-t border-[#2a2a2a] px-2 py-1.5 space-y-1.5">
                <canvas
                  ref={previewCanvasRef}
                  className="w-full h-8 rounded bg-[#161616] block"
                />
                <CompactSlider
                  label="Brush Size ([ / ])"
                  valueLabel={`${brushSettings.size < 10 ? brushSettings.size.toFixed(1) : Math.round(brushSettings.size)}px`}
                  min={0.5}
                  max={500}
                  step={0.5}
                  value={brushSettings.size}
                  onChange={(v) => handleUpdateBrushSettings({ size: v })}
                />
                <CompactSlider
                  label="Opacity"
                  valueLabel={`${Math.round((brushSettings.opacity ?? 1.0) * 100)}%`}
                  min={1}
                  max={100}
                  value={Math.round((brushSettings.opacity ?? 1.0) * 100)}
                  onChange={(v) => handleUpdateBrushSettings({ opacity: v / 100 })}
                />
              </div>

              {/* CSP Sub-Tool Detail Accordions */}
              <div className="shrink-0 bg-[#161616] pt-px space-y-px max-h-[50%] overflow-y-auto">
                {/* 1. Ink (Brush Density, Gap Compensation, Blend Tips, 4-stage Anti-Alias) */}
                <div className="bg-[#202020]">
                  <button
                    type="button"
                    onClick={() => toggleAccordion('ink')}
                    className="w-full px-2 py-1.5 flex items-center justify-between text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 transition-colors cursor-pointer"
                  >
                    <span>Ink</span>
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-[10px] text-[#e5e5e5]">
                        {Math.round((brushSettings.flow ?? 0.85) * 100)}%
                      </span>
                      {openAccordion === 'ink' ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                    </div>
                  </button>

                  {openAccordion === 'ink' && (
                    <div className="px-2.5 pb-2.5 pt-1 space-y-2.5">
                      <CompactSlider
                        label="Brush Density"
                        valueLabel={`${Math.round((brushSettings.flow ?? 0.85) * 100)}%`}
                        min={1}
                        max={100}
                        value={Math.round((brushSettings.flow ?? 0.85) * 100)}
                        onChange={(v) =>
                          handleUpdateBrushSettings({ flow: v / 100, brushDensity: v / 100 })
                        }
                      />
                      <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                        <span>Adjust by Gap</span>
                        <input
                          type="checkbox"
                          checked={Boolean(brushSettings.adjustDensityByGap)}
                          onChange={(e) =>
                            handleUpdateBrushSettings({ adjustDensityByGap: e.target.checked })
                          }
                        />
                      </label>
                      <div className="space-y-1">
                        <span className="text-[11px] text-[#8a8a8a]">Blend Tips</span>
                        <div className="grid grid-cols-3 gap-0.5 bg-[#161616] p-0.5 rounded">
                          {(
                            [
                              { id: 'normal', label: 'Normal' },
                              { id: 'darken', label: 'Darken' },
                              { id: 'compare', label: 'Compare' },
                            ] as Array<{ id: CspBlendTipsMode; label: string }>
                          ).map((mode) => (
                            <button
                              key={mode.id}
                              type="button"
                              onClick={() => handleUpdateBrushSettings({ blendTipsMode: mode.id })}
                              className={`py-0.5 rounded text-[10px] cursor-pointer ${
                                (brushSettings.blendTipsMode ?? 'normal') === mode.id
                                  ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                                  : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                              }`}
                            >
                              {mode.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1">
                        <span className="text-[11px] text-[#8a8a8a]">Anti-Aliasing</span>
                        <div className="grid grid-cols-4 gap-0.5 bg-[#161616] p-0.5 rounded">
                          {(
                            [
                              { val: 0, label: 'None' },
                              { val: 1, label: 'Weak' },
                              { val: 2, label: 'Med' },
                              { val: 3, label: 'Strong' },
                            ] as const
                          ).map((aa) => (
                            <button
                              key={aa.val}
                              type="button"
                              onClick={() => handleUpdateBrushSettings({ antiAlias: aa.val })}
                              className={`py-0.5 rounded text-[10px] cursor-pointer ${
                                currentAntiAlias === aa.val
                                  ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                                  : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                              }`}
                            >
                              {aa.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* 2. Brush Tip (Hardness, Spacing, Thickness H/V, Angle + Dynamics, Flip H/V, Ribbon) */}
                <div className="bg-[#202020]">
                  <button
                    type="button"
                    onClick={() => toggleAccordion('tip')}
                    className="w-full px-2 py-1.5 flex items-center justify-between text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 transition-colors cursor-pointer"
                  >
                    <span>Brush Tip</span>
                    {openAccordion === 'tip' ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                  </button>

                  {openAccordion === 'tip' && (
                    <div className="px-2.5 pb-2.5 pt-1 space-y-2.5">
                      <CompactSlider
                        label="Hardness"
                        valueLabel={`${Math.round((brushSettings.hardness ?? 1.0) * 100)}%`}
                        min={5}
                        max={100}
                        value={Math.round((brushSettings.hardness ?? 1.0) * 100)}
                        onChange={(v) => handleUpdateBrushSettings({ hardness: v / 100 })}
                      />
                      <CompactSlider
                        label="Gap (Spacing)"
                        valueLabel={`${Math.round((brushSettings.spacing ?? 0.1) * 100)}%`}
                        min={1}
                        max={100}
                        value={Math.round((brushSettings.spacing ?? 0.1) * 100)}
                        onChange={(v) => handleUpdateBrushSettings({ spacing: v / 100 })}
                      />
                      <CompactSlider
                        label="Thickness"
                        valueLabel={`${Math.round((brushSettings.thickness ?? 1.0) * 100)}%`}
                        min={5}
                        max={100}
                        value={Math.round((brushSettings.thickness ?? 1.0) * 100)}
                        onChange={(v) => handleUpdateBrushSettings({ thickness: v / 100 })}
                      />
                      <div className="grid grid-cols-2 gap-0.5 bg-[#161616] p-0.5 rounded">
                        <button
                          type="button"
                          onClick={() => handleUpdateBrushSettings({ thicknessVertical: false })}
                          className={`py-0.5 rounded text-[10px] cursor-pointer ${
                            !brushSettings.thicknessVertical
                              ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                              : 'text-[#8a8a8a]'
                          }`}
                        >
                          Horizontal
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUpdateBrushSettings({ thicknessVertical: true })}
                          className={`py-0.5 rounded text-[10px] cursor-pointer ${
                            brushSettings.thicknessVertical
                              ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                              : 'text-[#8a8a8a]'
                          }`}
                        >
                          Vertical
                        </button>
                      </div>
                      <CompactSlider
                        label="Angle"
                        valueLabel={`${Math.round(brushSettings.customTipAngle ?? 0)}deg`}
                        min={0}
                        max={360}
                        value={Math.round(brushSettings.customTipAngle ?? 0)}
                        onChange={(v) => handleUpdateBrushSettings({ customTipAngle: v })}
                      />
                      <div className="space-y-1">
                        <span className="text-[11px] text-[#8a8a8a]">Angle Dynamics</span>
                        <select
                          value={brushSettings.customTipAngleDynamics ?? 'none'}
                          onChange={(e) =>
                            handleUpdateBrushSettings({
                              customTipAngleDynamics: e.target.value as CspAngleDynamicsMode,
                            })
                          }
                          className="w-full h-6 bg-[#161616] text-[#e5e5e5] text-[10px] px-1.5 rounded cursor-pointer"
                        >
                          <option value="none">None</option>
                          <option value="direction">Direction of Line</option>
                          <option value="tilt">Pen Tilt</option>
                          <option value="twist">Barrel Twist</option>
                          <option value="random">Random</option>
                          <option value="direction-random">Direction + Random</option>
                        </select>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <div className="space-y-0.5">
                          <span className="text-[10px] text-[#8a8a8a]">Flip H</span>
                          <select
                            value={brushSettings.flipH ?? 'none'}
                            onChange={(e) =>
                              handleUpdateBrushSettings({ flipH: e.target.value as CspTipFlipMode })
                            }
                            className="w-full h-5 bg-[#161616] text-[#e5e5e5] text-[10px] px-1 rounded cursor-pointer"
                          >
                            <option value="none">None</option>
                            <option value="random">Random</option>
                            <option value="alternate">Alternate</option>
                          </select>
                        </div>
                        <div className="space-y-0.5">
                          <span className="text-[10px] text-[#8a8a8a]">Flip V</span>
                          <select
                            value={brushSettings.flipV ?? 'none'}
                            onChange={(e) =>
                              handleUpdateBrushSettings({ flipV: e.target.value as CspTipFlipMode })
                            }
                            className="w-full h-5 bg-[#161616] text-[#e5e5e5] text-[10px] px-1 rounded cursor-pointer"
                          >
                            <option value="none">None</option>
                            <option value="random">Random</option>
                            <option value="alternate">Alternate</option>
                          </select>
                        </div>
                      </div>
                      <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                        <span>Ribbon</span>
                        <input
                          type="checkbox"
                          checked={Boolean(brushSettings.isRibbon)}
                          onChange={(e) => handleUpdateBrushSettings({ isRibbon: e.target.checked })}
                        />
                      </label>
                    </div>
                  )}
                </div>

                {/* 3. Stroke & Stabilization */}
                <div className="bg-[#202020]">
                  <button
                    type="button"
                    onClick={() => toggleAccordion('stroke')}
                    className="w-full px-2 py-1.5 flex items-center justify-between text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 transition-colors cursor-pointer"
                  >
                    <span>Stabilization &amp; Stroke</span>
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-[10px] text-[#e5e5e5]">
                        {brushSettings.stabilization ?? 15}
                      </span>
                      {openAccordion === 'stroke' ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                    </div>
                  </button>

                  {openAccordion === 'stroke' && (
                    <div className="px-2.5 pb-2.5 pt-1 space-y-2.5">
                      <CompactSlider
                        label="Stabilization"
                        valueLabel={`${brushSettings.stabilization ?? 15}`}
                        min={0}
                        max={50}
                        value={brushSettings.stabilization ?? 15}
                        onChange={(v) => handleUpdateBrushSettings({ stabilization: v })}
                      />
                      <CompactSlider
                        label="Post-Correction"
                        valueLabel={`${brushSettings.postCorrection ?? 0}`}
                        min={0}
                        max={5}
                        value={brushSettings.postCorrection ?? 0}
                        onChange={(v) => handleUpdateBrushSettings({ postCorrection: v })}
                      />
                      <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                        <span>Sharp Angles</span>
                        <input
                          type="checkbox"
                          checked={brushSettings.sharpCorners ?? true}
                          onChange={(e) =>
                            handleUpdateBrushSettings({ sharpCorners: e.target.checked })
                          }
                        />
                      </label>

                      <div className="grid grid-cols-2 gap-1.5">
                        <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                          <span>Taper In</span>
                          <input
                            type="checkbox"
                            checked={Boolean(brushSettings.taper?.useIn)}
                            onChange={(e) => handleUpdateTaper({ useIn: e.target.checked })}
                          />
                        </label>
                        <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                          <span>Taper Out</span>
                          <input
                            type="checkbox"
                            checked={Boolean(brushSettings.taper?.useOut)}
                            onChange={(e) => handleUpdateTaper({ useOut: e.target.checked })}
                          />
                        </label>
                      </div>
                      {(brushSettings.taper?.useIn || brushSettings.taper?.useOut) && (
                        <CompactSlider
                          label="Taper Length"
                          valueLabel={`${Math.round(brushSettings.taper?.outLength ?? 32)}px`}
                          min={4}
                          max={200}
                          value={Math.round(brushSettings.taper?.outLength ?? 32)}
                          onChange={(v) =>
                            handleUpdateTaper({ inLength: v, outLength: v })
                          }
                        />
                      )}

                      <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                        <span>Pen Pressure</span>
                        <input
                          type="checkbox"
                          checked={brushSettings.usePressure}
                          onChange={(e) =>
                            handleUpdateBrushSettings({ usePressure: e.target.checked })
                          }
                        />
                      </label>
                      {brushSettings.usePressure && (
                        <>
                          <CompactSlider
                            label="Min Width"
                            valueLabel={`${Math.round(brushSettings.minSizeFactor * 100)}%`}
                            min={0}
                            max={95}
                            value={Math.round(brushSettings.minSizeFactor * 100)}
                            onChange={(v) => handleUpdateBrushSettings({ minSizeFactor: v / 100 })}
                          />
                          <div className="space-y-1">
                            <span className="text-[10px] text-[#8a8a8a]">Pressure Curve</span>
                            <div className="grid grid-cols-5 gap-0.5 bg-[#161616] p-0.5 rounded">
                              {(
                                [
                                  { id: 'linear', short: 'Lin' },
                                  { id: 'g-pen', short: 'G' },
                                  { id: 'soft', short: 'Soft' },
                                  { id: 'firm', short: 'Firm' },
                                  { id: 'chisel', short: 'Hard' },
                                ] as const
                              ).map((p) => (
                                <button
                                  key={p.id}
                                  type="button"
                                  title={CSP_PRESSURE_CURVE_PRESETS[p.id]?.label}
                                  onClick={() =>
                                    handleUpdateBrushSettings({
                                      pressureCurve: CSP_PRESSURE_CURVE_PRESETS[p.id]?.points,
                                    })
                                  }
                                  className="py-0.5 rounded text-[9px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer"
                                >
                                  {p.short}
                                </button>
                              ))}
                            </div>
                          </div>
                        </>
                      )}

                      <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                        <span>Stylus Tilt</span>
                        <input
                          type="checkbox"
                          checked={Boolean(brushSettings.useTilt)}
                          onChange={(e) => handleUpdateBrushSettings({ useTilt: e.target.checked })}
                        />
                      </label>
                      <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                        <span>Velocity Dynamics</span>
                        <input
                          type="checkbox"
                          checked={Boolean(brushSettings.useVelocity)}
                          onChange={(e) =>
                            handleUpdateBrushSettings({ useVelocity: e.target.checked })
                          }
                        />
                      </label>
                      <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                        <span>Bezier Smoothing</span>
                        <input
                          type="checkbox"
                          checked={brushSettings.smoothing}
                          onChange={(e) =>
                            handleUpdateBrushSettings({ smoothing: e.target.checked })
                          }
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          const def = resetBrushSettingsToDefault(
                            currentTool === 'eraser'
                              ? ERASER_PRESET_ID
                              : brushSettings.preset || 'pencil-2b',
                            customBrushes
                          );
                          handleUpdateBrushSettings(def);
                        }}
                        className="w-full py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] cursor-pointer"
                      >
                        Reset Brush to Default
                      </button>
                    </div>
                  )}
                </div>

                {/* 4. Color Mixing & Watercolor Edge */}
                <div className="bg-[#202020]">
                  <button
                    type="button"
                    onClick={() => toggleAccordion('mixing')}
                    className="w-full px-2 py-1.5 flex items-center justify-between text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 transition-colors cursor-pointer"
                  >
                    <span>Color Mixing &amp; Edge</span>
                    {openAccordion === 'mixing' ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                  </button>

                  {openAccordion === 'mixing' && (
                    <div className="px-2.5 pb-2.5 pt-1 space-y-2.5">
                      <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                        <span>Color Mixing</span>
                        <input
                          type="checkbox"
                          checked={Boolean(brushSettings.colorMixing)}
                          onChange={(e) =>
                            handleUpdateBrushSettings({ colorMixing: e.target.checked })
                          }
                        />
                      </label>
                      {brushSettings.colorMixing && (
                        <>
                          <div className="grid grid-cols-3 gap-0.5 bg-[#161616] p-0.5 rounded">
                            {(
                              [
                                { id: 'blend', label: 'Blend' },
                                { id: 'running_color', label: 'Running' },
                                { id: 'smear', label: 'Smear' },
                              ] as const
                            ).map((m) => (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => handleUpdateBrushSettings({ mixingMode: m.id })}
                                className={`py-0.5 rounded text-[10px] cursor-pointer ${
                                  (brushSettings.mixingMode || 'blend') === m.id
                                    ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                                    : 'text-[#8a8a8a]'
                                }`}
                              >
                                {m.label}
                              </button>
                            ))}
                          </div>
                          <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                            <span>Perceptual (OKLab)</span>
                            <input
                              type="checkbox"
                              checked={brushSettings.perceptualMixing ?? true}
                              onChange={(e) =>
                                handleUpdateBrushSettings({ perceptualMixing: e.target.checked })
                              }
                            />
                          </label>
                          <CompactSlider
                            label="Amount of Paint"
                            valueLabel={`${Math.round((brushSettings.amountOfPaint ?? 0.7) * 100)}%`}
                            min={0}
                            max={100}
                            value={Math.round((brushSettings.amountOfPaint ?? 0.7) * 100)}
                            onChange={(v) => handleUpdateBrushSettings({ amountOfPaint: v / 100 })}
                          />
                          <CompactSlider
                            label="Density of Paint"
                            valueLabel={`${Math.round((brushSettings.densityOfPaint ?? 0.8) * 100)}%`}
                            min={1}
                            max={100}
                            value={Math.round((brushSettings.densityOfPaint ?? 0.8) * 100)}
                            onChange={(v) => handleUpdateBrushSettings({ densityOfPaint: v / 100 })}
                          />
                          <CompactSlider
                            label="Color Stretch"
                            valueLabel={`${Math.round((brushSettings.colorStretch ?? 0.6) * 100)}%`}
                            min={0}
                            max={100}
                            value={Math.round((brushSettings.colorStretch ?? 0.6) * 100)}
                            onChange={(v) => handleUpdateBrushSettings({ colorStretch: v / 100 })}
                          />
                        </>
                      )}
                      <CompactSlider
                        label="Watercolor Edge"
                        valueLabel={`${Math.round((brushSettings.wetEdge ?? 0) * 100)}%`}
                        min={0}
                        max={100}
                        value={Math.round((brushSettings.wetEdge ?? 0) * 100)}
                        onChange={(v) => handleUpdateBrushSettings({ wetEdge: v / 100 })}
                      />
                      {(brushSettings.wetEdge ?? 0) > 0.01 && (
                        <CompactSlider
                          label="Edge Width"
                          valueLabel={`${brushSettings.wetEdgeRadius ?? 4}px`}
                          min={1}
                          max={20}
                          value={Math.round(brushSettings.wetEdgeRadius ?? 4)}
                          onChange={(v) => handleUpdateBrushSettings({ wetEdgeRadius: v })}
                        />
                      )}
                    </div>
                  )}
                </div>

                {/* 5. Texture & Spraying Effect */}
                <div className="bg-[#202020]">
                  <button
                    type="button"
                    onClick={() => toggleAccordion('texture')}
                    className="w-full px-2 py-1.5 flex items-center justify-between text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 transition-colors cursor-pointer"
                  >
                    <span>Texture &amp; Spray</span>
                    {openAccordion === 'texture' ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                  </button>

                  {openAccordion === 'texture' && (
                    <div className="px-2.5 pb-2.5 pt-1 space-y-2.5">
                      <CompactSlider
                        label="Texture Density"
                        valueLabel={`${Math.round((brushSettings.grain ?? 0) * 100)}%`}
                        min={0}
                        max={100}
                        value={Math.round((brushSettings.grain ?? 0) * 100)}
                        onChange={(v) =>
                          handleUpdateBrushSettings({ grain: v / 100, textureDensity: v / 100 })
                        }
                      />
                      {(brushSettings.grain ?? 0) > 0.005 && (
                        <>
                          <div className="space-y-1">
                            <span className="text-[11px] text-[#8a8a8a]">Texture Mode</span>
                            <select
                              value={brushSettings.paperTextureMode ?? 'subtract'}
                              onChange={(e) =>
                                handleUpdateBrushSettings({
                                  paperTextureMode: e.target.value as CspPaperTextureMode,
                                })
                              }
                              className="w-full h-6 bg-[#161616] text-[#e5e5e5] text-[10px] px-1.5 rounded cursor-pointer"
                            >
                              <option value="subtract">Subtract (Valley Fill)</option>
                              <option value="multiply">Multiply</option>
                              <option value="compare">Compare Density</option>
                              <option value="overlay">Overlay</option>
                              <option value="outline">Outline</option>
                            </select>
                          </div>
                          <CompactSlider
                            label="Texture Scale"
                            valueLabel={`${Math.round((brushSettings.paperTextureScale ?? 1.0) * 100)}%`}
                            min={10}
                            max={400}
                            step={5}
                            value={Math.round((brushSettings.paperTextureScale ?? 1.0) * 100)}
                            onChange={(v) =>
                              handleUpdateBrushSettings({ paperTextureScale: v / 100 })
                            }
                          />
                          <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                            <span>Invert Texture</span>
                            <input
                              type="checkbox"
                              checked={Boolean(brushSettings.paperTextureInverted)}
                              onChange={(e) =>
                                handleUpdateBrushSettings({
                                  paperTextureInverted: e.target.checked,
                                })
                              }
                            />
                          </label>
                        </>
                      )}

                      <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer pt-1">
                        <span>Spraying Effect</span>
                        <input
                          type="checkbox"
                          checked={Boolean(brushSettings.spray?.enabled)}
                          onChange={(e) => handleUpdateSpray({ enabled: e.target.checked })}
                        />
                      </label>
                      {brushSettings.spray?.enabled && (
                        <>
                          <CompactSlider
                            label="Particle Size"
                            valueLabel={`${brushSettings.spray.size ?? 4}px`}
                            min={1}
                            max={80}
                            value={Math.round(brushSettings.spray.size ?? 4)}
                            onChange={(v) => handleUpdateSpray({ size: v })}
                          />
                          <CompactSlider
                            label="Spray Density"
                            valueLabel={`${brushSettings.spray.density ?? 12}`}
                            min={1}
                            max={64}
                            value={Math.round(brushSettings.spray.density ?? 12)}
                            onChange={(v) => handleUpdateSpray({ density: v })}
                          />
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* 6. Dynamics & Jitter */}
                <div className="bg-[#202020]">
                  <button
                    type="button"
                    onClick={() => toggleAccordion('dynamics')}
                    className="w-full px-2 py-1.5 flex items-center justify-between text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 transition-colors cursor-pointer"
                  >
                    <span>Dynamics &amp; Jitter</span>
                    {openAccordion === 'dynamics' ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                  </button>

                  {openAccordion === 'dynamics' && (
                    <div className="px-2.5 pb-2.5 pt-1 space-y-2.5">
                      <CompactSlider
                        label="Size Jitter"
                        valueLabel={`${Math.round((brushSettings.dynamics?.sizeJitter ?? 0) * 100)}%`}
                        min={0}
                        max={100}
                        value={Math.round((brushSettings.dynamics?.sizeJitter ?? 0) * 100)}
                        onChange={(v) => handleUpdateDynamics({ sizeJitter: v / 100 })}
                      />
                      <CompactSlider
                        label="Angle Jitter"
                        valueLabel={`${Math.round((brushSettings.dynamics?.angleJitter ?? 0) * 100)}%`}
                        min={0}
                        max={100}
                        value={Math.round((brushSettings.dynamics?.angleJitter ?? 0) * 100)}
                        onChange={(v) => handleUpdateDynamics({ angleJitter: v / 100 })}
                      />
                      <CompactSlider
                        label="Roundness Jitter"
                        valueLabel={`${Math.round((brushSettings.dynamics?.roundnessJitter ?? 0) * 100)}%`}
                        min={0}
                        max={95}
                        value={Math.round((brushSettings.dynamics?.roundnessJitter ?? 0) * 100)}
                        onChange={(v) => handleUpdateDynamics({ roundnessJitter: v / 100 })}
                      />
                      <CompactSlider
                        label="Scatter"
                        valueLabel={`${(brushSettings.dynamics?.scatter ?? 0).toFixed(1)}x`}
                        min={0}
                        max={5}
                        step={0.1}
                        value={brushSettings.dynamics?.scatter ?? 0}
                        onChange={(v) => handleUpdateDynamics({ scatter: v })}
                      />
                      {(brushSettings.dynamics?.scatter ?? 0) > 0 && (
                        <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                          <span>Scatter Both Axes</span>
                          <input
                            type="checkbox"
                            checked={Boolean(brushSettings.dynamics?.scatterBothAxes)}
                            onChange={(e) =>
                              handleUpdateDynamics({ scatterBothAxes: e.target.checked })
                            }
                          />
                        </label>
                      )}
                      <CompactSlider
                        label="Count"
                        valueLabel={`${brushSettings.dynamics?.count ?? 1}`}
                        min={1}
                        max={10}
                        value={brushSettings.dynamics?.count ?? 1}
                        onChange={(v) => handleUpdateDynamics({ count: v })}
                      />
                      <CompactSlider
                        label="Flow Jitter"
                        valueLabel={`${Math.round((brushSettings.dynamics?.flowJitter ?? 0) * 100)}%`}
                        min={0}
                        max={100}
                        value={Math.round((brushSettings.dynamics?.flowJitter ?? 0) * 100)}
                        onChange={(v) => handleUpdateDynamics({ flowJitter: v / 100 })}
                      />
                      <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                        <span>Color Jitter</span>
                        <input
                          type="checkbox"
                          checked={Boolean(brushSettings.dynamics?.colorJitterEnabled)}
                          onChange={(e) =>
                            handleUpdateDynamics({ colorJitterEnabled: e.target.checked })
                          }
                        />
                      </label>
                      {brushSettings.dynamics?.colorJitterEnabled && (
                        <>
                          <CompactSlider
                            label="Hue"
                            valueLabel={`${Math.round((brushSettings.dynamics?.hueJitter ?? 0) * 100)}%`}
                            min={0}
                            max={100}
                            value={Math.round((brushSettings.dynamics?.hueJitter ?? 0) * 100)}
                            onChange={(v) => handleUpdateDynamics({ hueJitter: v / 100 })}
                          />
                          <CompactSlider
                            label="Saturation"
                            valueLabel={`${Math.round((brushSettings.dynamics?.saturationJitter ?? 0) * 100)}%`}
                            min={0}
                            max={100}
                            value={Math.round((brushSettings.dynamics?.saturationJitter ?? 0) * 100)}
                            onChange={(v) => handleUpdateDynamics({ saturationJitter: v / 100 })}
                          />
                          <CompactSlider
                            label="Brightness"
                            valueLabel={`${Math.round((brushSettings.dynamics?.brightnessJitter ?? 0) * 100)}%`}
                            min={0}
                            max={100}
                            value={Math.round((brushSettings.dynamics?.brightnessJitter ?? 0) * 100)}
                            onChange={(v) => handleUpdateDynamics({ brightnessJitter: v / 100 })}
                          />
                          <CompactSlider
                            label="FG / BG Mix"
                            valueLabel={`${Math.round((brushSettings.dynamics?.foregroundBackgroundJitter ?? 0) * 100)}%`}
                            min={0}
                            max={100}
                            value={Math.round((brushSettings.dynamics?.foregroundBackgroundJitter ?? 0) * 100)}
                            onChange={(v) => handleUpdateDynamics({ foregroundBackgroundJitter: v / 100 })}
                          />
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            renderContextualToolPanel()
          )}

          {/* Subtle Drag Handle on Right Edge */}
          <div
            onMouseDown={(e) => {
              e.preventDefault();
              setIsDraggingWidth(true);
              dragStartXRef.current = e.clientX;
              dragStartWidthRef.current = width;
            }}
            title="Resize brush panel"
            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--accent)]/40 transition-colors z-30"
          />
        </aside>
      )}
    </div>
  );
});

LeftPanel.displayName = 'LeftPanel';
