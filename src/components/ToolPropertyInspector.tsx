import React, { useState, useRef, useEffect } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Scaling,
  Maximize2,
  Minimize2,
  RotateCcw,
  Feather,
  Sliders,
  Scissors,
  Copy,
  ClipboardPaste,
  Layers,
  Trash2,
  Crop,
  AlertTriangle,
} from 'lucide-react';
import {
  BrushSettings,
  BrushPresetId,
  CspBrush,
  BrushDynamics,
  DEFAULT_BRUSH_DYNAMICS,
  DEFAULT_NATURAL_PAINT_SETTINGS,
  LiquifyMode,
  CspAngleDynamicsMode,
  CspBlendTipsMode,
  CspPaperTextureMode,
  CspTipFlipMode,
  CspTaperSettings,
  CspSpraySettings,
  ShapeKind,
  ShapeDrawMode,
  ShapeFillColorMode,
  GradientType,
  GradientRepeatMode,
  GradientBlendMode,
  RetouchMode,
  RetouchTonalRange,
  CloneSampleMode,
  PenToolMode,
} from '../types/editor';
import { isOpenShape } from '../utils/shapeEngine';
import { GRADIENT_PRESETS, resolveGradientStops } from '../utils/gradientEngine';
import { saveCustomBrushDebounced } from '../utils/brushStorage';
import { resolveBrushTipImage } from '../utils/brushOutline';
import { BUILTIN_BRUSHES } from '../utils/presetBrushes';
import {
  resetBrushSettingsToDefault,
  ERASER_PRESET_ID,
  DEFAULT_BRUSH_PRESET_ID,
} from '../utils/brushPresetManager';
import { renderBrushStrokePreview } from '../utils/brushPreview';
import { CSP_PRESSURE_CURVE_PRESETS } from '../engine/BrushEngine';
import {
  useToolStore,
  toolStoreActions,
  interactiveToolBridge,
  useUiStore,
  uiStoreActions,
} from '../stores';
import { Tool3DPropertyInspector } from './Tool3DPropertyInspector';
import { PigmentBlendControl } from './PigmentBlendControl';

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

export interface ToolPropertyInspectorProps {
  width: number;
  customBrushes: CspBrush[];
  setCustomBrushes: React.Dispatch<React.SetStateAction<CspBrush[]>>;
  onDeselect?: () => void;
  onTransformSelection?: () => void;
  onClearSelection?: () => void;
  onDeleteOutsideSelection?: () => void;
  onCutSelection?: () => void;
  onCopySelection?: () => void;
  onPasteSelection?: () => void;
  onMoveSelectionToNewLayer?: () => void;
  onExpandSelection?: (pixels: number) => void;
  onContractSelection?: (pixels: number) => void;
  onFeatherSelection?: (radius: number) => void;
  onInvertSelection?: () => void;
}

export const ToolPropertyInspector: React.FC<ToolPropertyInspectorProps> = React.memo(
  ({
    width,
    customBrushes,
    setCustomBrushes,
    onDeselect,
    onTransformSelection,
    onClearSelection,
    onDeleteOutsideSelection,
    onCutSelection,
    onCopySelection,
    onPasteSelection,
    onMoveSelectionToNewLayer,
    onExpandSelection,
    onContractSelection,
    onFeatherSelection,
    onInvertSelection,
  }) => {
    const currentTool = useToolStore((s) => s.tool);
    const brushSettings = useToolStore((s) => s.brushSettings);
    const fillSettings = useToolStore((s) => s.fillSettings);
    const textSettings = useToolStore((s) => s.textSettings);
    const frameSettings = useToolStore((s) => s.frameSettings);
    const liquifySettings = useToolStore((s) => s.liquifySettings);
    const shapeSettings = useToolStore((s) => s.shapeSettings);
    const gradientSettings = useToolStore((s) => s.gradientSettings);
    const activeGradientMesh = useToolStore((s) => s.activeGradientMesh);
    const retouchSettings = useToolStore((s) => s.retouchSettings);
    const isPickingCloneSource = useToolStore((s) => s.isPickingCloneSource);
    const cloneSourceAnchor = useToolStore((s) => s.cloneSourceAnchor);
    const penSettings = useToolStore((s) => s.penSettings);
    const activePenPointCount = useToolStore((s) => s.activePenPointCount);
    const activePenClosed = useToolStore((s) => s.activePenClosed);
    const activePenSelectedAnchor = useToolStore((s) => s.activePenSelectedAnchor);
    const primaryColor = useToolStore((s) => s.primaryColor);
    const secondaryColor = useToolStore((s) => s.secondaryColor);
    const balloonSettings = useToolStore((s) => s.balloonSettings);
    const vectorEditSettings = useToolStore((s) => s.vectorEditSettings);
    const wandSettings = useToolStore((s) => s.wandSettings);
    const isHidden = useUiStore((s) => s.isLeftPanelHidden);

    const [openAccordion, setOpenAccordion] = useState<InspectorAccordionId | null>(null);
    const [warningsExpanded, setWarningsExpanded] = useState<boolean>(false);
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);

    const isBrushOrEraser = currentTool === 'brush' || currentTool === 'eraser';

    useEffect(() => {
      setWarningsExpanded(false);
    }, [brushSettings.preset]);

    useEffect(() => {
      if (isHidden || !isBrushOrEraser) return;
      const canvas = previewCanvasRef.current;
      if (!canvas) return;
      const cssWidth = Math.max(96, width - 16);
      const cssHeight = 32;
      let loadListenerCleanup: (() => void) | null = null;
      const drawPreview = () => {
        const resolvedTip = resolveBrushTipImage(brushSettings);
        if (resolvedTip && !resolvedTip.complete) {
          const onLoad = () => drawPreview();
          resolvedTip.addEventListener('load', onLoad, { once: true });
          loadListenerCleanup = () => resolvedTip.removeEventListener('load', onLoad);
        }
        renderBrushStrokePreview(
          canvas,
          cssWidth,
          cssHeight,
          {
            preset: brushSettings.preset,
            size: brushSettings.size,
            flow: brushSettings.flow,
            brushDensity: brushSettings.brushDensity,
            opacity: brushSettings.opacity,
            grain: brushSettings.grain,
            textureDensity: brushSettings.textureDensity,
            paperTexture: brushSettings.paperTexture,
            paperTextureImage: brushSettings.paperTextureImage,
            paperTextureMode: brushSettings.paperTextureMode,
            paperTextureScale: brushSettings.paperTextureScale,
            paperTextureRotate: brushSettings.paperTextureRotate,
            paperTextureOffsetX: brushSettings.paperTextureOffsetX,
            paperTextureOffsetY: brushSettings.paperTextureOffsetY,
            paperTextureContrast: brushSettings.paperTextureContrast,
            paperTextureBrightness: brushSettings.paperTextureBrightness,
            paperTextureApplyEachPlot: brushSettings.paperTextureApplyEachPlot,
            paperTextureEmphasizeDensity: brushSettings.paperTextureEmphasizeDensity,
            paperTextureInverted: brushSettings.paperTextureInverted,
            hardness: brushSettings.hardness,
            spacing: brushSettings.spacing,
            minSizeFactor: brushSettings.minSizeFactor,
            usePressure: brushSettings.usePressure,
            useTilt: brushSettings.useTilt,
            tiltScale: brushSettings.tiltScale,
            useVelocity: brushSettings.useVelocity,
            color: currentTool === 'eraser' ? '#e5e5e5' : '#ececec',
            secondaryColor: secondaryColor || brushSettings.secondaryColor || '#60a5fa',
            backgroundColor: '#161616',
            tool: currentTool === 'eraser' ? 'eraser' : 'brush',
            customTipDataUrl: brushSettings.customTipDataUrl,
            customTipImage: resolvedTip,
            customTipAngle: brushSettings.customTipAngle,
            customTipAngleDynamics: brushSettings.customTipAngleDynamics,
            customTipRotationRandomScale: brushSettings.customTipRotationRandomScale,
            isColorTip: brushSettings.isColorTip,
            isDualToneTip: brushSettings.isDualToneTip,
            isRibbon: brushSettings.isRibbon,
            subTips: brushSettings.subTips,
            subTipOrder: brushSettings.subTipOrder,
            subTipImages: brushSettings.subTipImages,
            thickness: brushSettings.thickness,
            thicknessVertical: brushSettings.thicknessVertical,
            thicknessSensor: brushSettings.thicknessSensor,
            flipH: brushSettings.flipH,
            flipV: brushSettings.flipV,
            blendTipsMode: brushSettings.blendTipsMode,
            brushCombineMode: brushSettings.brushCombineMode,
            adjustDensityByGap: brushSettings.adjustDensityByGap,
            antiAlias: brushSettings.antiAlias,
            pressureCurve: brushSettings.pressureCurve,
            velocityCurve: brushSettings.velocityCurve,
            sizeSensor: brushSettings.sizeSensor,
            opacitySensor: brushSettings.opacitySensor,
            densitySensor: brushSettings.densitySensor,
            intervalSensor: brushSettings.intervalSensor,
            textureDensitySensor: brushSettings.textureDensitySensor,
            angleSensor: brushSettings.angleSensor,
            scatterSensor: brushSettings.scatterSensor,
            spray: brushSettings.spray,
            taper: brushSettings.taper,
            dynamics: brushSettings.dynamics,
            colorMixing: brushSettings.colorMixing,
            perceptualMixing: brushSettings.perceptualMixing,
            amountOfPaint: brushSettings.amountOfPaint,
            densityOfPaint: brushSettings.densityOfPaint,
            colorStretch: brushSettings.colorStretch,
            amountOfPaintSensor: brushSettings.amountOfPaintSensor,
            densityOfPaintSensor: brushSettings.densityOfPaintSensor,
            colorStretchSensor: brushSettings.colorStretchSensor,
            useBlur: brushSettings.useBlur,
            blurStrength: brushSettings.blurStrength,
            mixingMode: brushSettings.mixingMode,
            wetEdge: brushSettings.wetEdge,
            wetEdgeRadius: brushSettings.wetEdgeRadius,
            wetEdgeAlphaPower: brushSettings.wetEdgeAlphaPower,
            wetEdgeValuePower: brushSettings.wetEdgeValuePower,
            dualBrush: brushSettings.dualBrush,
            dualBrushConfig: brushSettings.dualBrushConfig,
            dualBrushCompositeMode: brushSettings.dualBrushCompositeMode,
            dualTipDataUrl: brushSettings.dualTipDataUrl,
            dualTipImage: brushSettings.dualTipImage,
            dualSize: brushSettings.dualSize,
            dualLinkSize: brushSettings.dualLinkSize,
            dualSpacing: brushSettings.dualSpacing,
            dualScatter: brushSettings.dualScatter,
            dualThickness: brushSettings.dualThickness,
            dualThicknessVertical: brushSettings.dualThicknessVertical,
            dualAngle: brushSettings.dualAngle,
            dualAngleDynamics: brushSettings.dualAngleDynamics,
            dualAngleSensor: brushSettings.dualAngleSensor,
            dualHardness: brushSettings.dualHardness,
            dualDensity: brushSettings.dualDensity,
            dualSubTips: brushSettings.dualSubTips,
            dualSubTipImages: brushSettings.dualSubTipImages,
            dualSubTipOrder: brushSettings.dualSubTipOrder,
            dualFlipH: brushSettings.dualFlipH,
            dualFlipV: brushSettings.dualFlipV,
            dualSpray: brushSettings.dualSpray,
            dualIsRibbon: brushSettings.dualIsRibbon,
            dualScale: brushSettings.dualScale,
            renderMode: brushSettings.renderMode,
            bristle: brushSettings.bristle,
            naturalPaint: brushSettings.naturalPaint,
            impasto: brushSettings.impasto,
            surfaceTextureId: brushSettings.surfaceTextureId,
            grainMappingMode: brushSettings.grainMappingMode,
          },
          true
        );
      };
      const rafId = requestAnimationFrame(drawPreview);
      return () => {
        cancelAnimationFrame(rafId);
        loadListenerCleanup?.();
      };
    }, [isHidden, isBrushOrEraser, width, currentTool, brushSettings, secondaryColor]);

    const activePreset: BrushPresetId = brushSettings.preset || DEFAULT_BRUSH_PRESET_ID;
    const activeBuiltinBrush = BUILTIN_BRUSHES.find((b) => b.id === activePreset);
    const isCustomBrushActive =
      currentTool === 'brush' &&
      (activePreset.startsWith('csp-') ||
        (Boolean(brushSettings.customTipDataUrl) && !activeBuiltinBrush));
    const activeCustomBrush = isCustomBrushActive
      ? customBrushes.find((b) => b.id === activePreset)
      : null;

    const handleUpdateBrushSettings = (newSettings: Partial<BrushSettings>) => {
      toolStoreActions.updateBrushSettings(newSettings);
      if (isCustomBrushActive && activeCustomBrush) {
        const updatedBrush: CspBrush = {
          ...activeCustomBrush,
          size: newSettings.size ?? activeCustomBrush.size,
          opacity: newSettings.opacity ?? activeCustomBrush.opacity,
          flow: newSettings.flow ?? activeCustomBrush.flow,
          brushDensity:
            newSettings.brushDensity ?? newSettings.flow ?? activeCustomBrush.brushDensity,
          adjustDensityByGap:
            newSettings.adjustDensityByGap ?? activeCustomBrush.adjustDensityByGap,
          blendTipsMode: newSettings.blendTipsMode ?? activeCustomBrush.blendTipsMode,
          spacing: newSettings.spacing ?? activeCustomBrush.spacing,
          hardness: newSettings.hardness ?? activeCustomBrush.hardness,
          thickness: newSettings.thickness ?? activeCustomBrush.thickness,
          thicknessVertical:
            newSettings.thicknessVertical ?? activeCustomBrush.thicknessVertical,
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
          perceptualMixing: newSettings.perceptualMixing ?? activeCustomBrush.perceptualMixing,
          mixingMode: newSettings.mixingMode ?? activeCustomBrush.mixingMode,
          naturalPaint: newSettings.naturalPaint ?? activeCustomBrush.naturalPaint,
          amountOfPaint: newSettings.amountOfPaint ?? activeCustomBrush.amountOfPaint,
          densityOfPaint: newSettings.densityOfPaint ?? activeCustomBrush.densityOfPaint,
          colorStretch: newSettings.colorStretch ?? activeCustomBrush.colorStretch,
          wetEdge: newSettings.wetEdge ?? activeCustomBrush.wetEdge,
          wetEdgeRadius: newSettings.wetEdgeRadius ?? activeCustomBrush.wetEdgeRadius,
          textureDensity: newSettings.grain ?? activeCustomBrush.textureDensity,
          paperTextureMode: newSettings.paperTextureMode ?? activeCustomBrush.paperTextureMode,
          paperTextureScale: newSettings.paperTextureScale ?? activeCustomBrush.paperTextureScale,
          paperTextureInverted:
            newSettings.paperTextureInverted ?? activeCustomBrush.paperTextureInverted,
          dynamics: newSettings.dynamics ?? activeCustomBrush.dynamics,
        };
        setCustomBrushes((prev) =>
          prev.map((b) => (b.id === updatedBrush.id ? updatedBrush : b))
        );
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

    const toggleAccordion = (id: InspectorAccordionId) => {
      setOpenAccordion((prev) => (prev === id ? null : id));
    };

    if (!isBrushOrEraser) {
      if (currentTool === '3d') {
        return <Tool3DPropertyInspector />;
      }

      if (currentTool === 'fill') {
        const method = fillSettings.method ?? 'refer-all';
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
                  onClick={() => toolStoreActions.updateFillSettings({ method: m.id })}
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
                  valueLabel={`${fillSettings.tolerance ?? 32}`}
                  min={0}
                  max={100}
                  value={fillSettings.tolerance ?? 32}
                  onChange={(v) => toolStoreActions.updateFillSettings({ tolerance: v })}
                />
                <CompactSlider
                  label="Close Gap"
                  valueLabel={`${fillSettings.closeGap ?? 0}px`}
                  min={0}
                  max={20}
                  value={fillSettings.closeGap ?? 0}
                  onChange={(v) => toolStoreActions.updateFillSettings({ closeGap: v })}
                />
                <CompactSlider
                  label="Area Scaling"
                  valueLabel={`${(fillSettings.areaScale ?? 0) > 0 ? '+' : ''}${fillSettings.areaScale ?? 0}px`}
                  min={-20}
                  max={20}
                  value={fillSettings.areaScale ?? 0}
                  onChange={(v) => toolStoreActions.updateFillSettings({ areaScale: v })}
                />
                <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                  <span>Anti-Alias</span>
                  <input
                    type="checkbox"
                    checked={fillSettings.antiAlias ?? true}
                    onChange={(e) =>
                      toolStoreActions.updateFillSettings({ antiAlias: e.target.checked })
                    }
                  />
                </label>
              </>
            )}
          </div>
        );
      }

      if (currentTool === 'gradient') {
        const resolvedStops = resolveGradientStops(gradientSettings, primaryColor, secondaryColor);
        const cssStops = (gradientSettings.reverse ? [...resolvedStops].reverse() : resolvedStops)
          .map((s) => {
            const pct = Math.round((gradientSettings.reverse ? 1 - s.offset : s.offset) * 100);
            return `rgba(${Math.round(s.r)},${Math.round(s.g)},${Math.round(s.b)},${(s.a / 255).toFixed(2)}) ${pct}%`;
          })
          .join(', ');

        const selectedMeshNode =
          activeGradientMesh && activeGradientMesh.selectedNodeIndex !== null
            ? activeGradientMesh.nodes[activeGradientMesh.selectedNodeIndex]
            : null;

        return (
          <div className="p-2 space-y-3 overflow-y-auto flex-1">
            <div className="px-0.5 text-[11px] font-medium text-[#e5e5e5]">Gradient</div>

            <div className="grid grid-cols-3 gap-0.5 bg-[#161616] p-0.5 rounded">
              {(
                [
                  ['linear', 'Linear'],
                  ['radial', 'Radial'],
                  ['mesh', 'Mesh'],
                ] as Array<[GradientType, string]>
              ).map(([t, lbl]) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toolStoreActions.updateGradientSettings({ type: t })}
                  className={`py-1 rounded text-[10px] transition-colors cursor-pointer ${
                    gradientSettings.type === t
                      ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                      : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>

            {gradientSettings.type !== 'mesh' ? (
              <>
                <div
                  className="h-5 rounded border border-white/10"
                  style={{
                    backgroundImage: `linear-gradient(90deg, ${cssStops}), repeating-conic-gradient(#555 0% 25%, #888 0% 50%)`,
                    backgroundSize: '100% 100%, 8px 8px',
                  }}
                />

                <div className="grid grid-cols-2 gap-1">
                  {GRADIENT_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() =>
                        toolStoreActions.updateGradientSettings({
                          useForegroundBackground: Boolean(preset.useForegroundBackground),
                          stops: preset.stops.map((s, idx) => ({
                            id: `stop-${preset.id}-${idx}`,
                            offset: s.offset,
                            color: s.color,
                            opacity: s.opacity,
                          })),
                        })
                      }
                      className="px-1.5 py-1 rounded text-[10px] text-left bg-[#161616] text-[#bdbdbd] hover:text-[#e5e5e5] hover:bg-[#2c2c2c] cursor-pointer truncate"
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>

                <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                  <span>Use FG / BG</span>
                  <input
                    type="checkbox"
                    checked={gradientSettings.useForegroundBackground}
                    onChange={(e) =>
                      toolStoreActions.updateGradientSettings({
                        useForegroundBackground: e.target.checked,
                      })
                    }
                  />
                </label>

                {/* Color Stops Editor */}
                <div className="space-y-1.5 pt-1 border-t border-[#2c2c2c]">
                  <div className="flex items-center justify-between text-[10px] text-[#8a8a8a]">
                    <span>Stops ({gradientSettings.stops.length})</span>
                    <button
                      type="button"
                      onClick={() => {
                        const nextStops = [
                          ...gradientSettings.stops,
                          {
                            id: `stop-${Date.now()}`,
                            offset: 0.5,
                            color: primaryColor || '#38bdf8',
                            opacity: 1,
                          },
                        ];
                        toolStoreActions.updateGradientSettings({
                          useForegroundBackground: false,
                          stops: nextStops,
                        });
                      }}
                      className="px-1.5 py-0.5 rounded bg-[#2c2c2c] text-[#e5e5e5] hover:bg-[#3a3a3a] cursor-pointer"
                    >
                      + Add
                    </button>
                  </div>
                  <div className="space-y-1 max-h-32 overflow-y-auto pr-0.5">
                    {gradientSettings.stops.map((stop, idx) => (
                      <div key={stop.id} className="flex items-center gap-1 text-[10px]">
                        <input
                          type="color"
                          value={stop.color}
                          onChange={(e) => {
                            const next = gradientSettings.stops.map((s, i) =>
                              i === idx ? { ...s, color: e.target.value } : s
                            );
                            toolStoreActions.updateGradientSettings({
                              useForegroundBackground: false,
                              stops: next,
                            });
                          }}
                          className="w-5 h-4 bg-transparent border-0 cursor-pointer shrink-0"
                        />
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={Math.round(stop.offset * 100)}
                          onChange={(e) => {
                            const next = gradientSettings.stops.map((s, i) =>
                              i === idx ? { ...s, offset: Number(e.target.value) / 100 } : s
                            );
                            toolStoreActions.updateGradientSettings({ stops: next });
                          }}
                          className="flex-1 min-w-0"
                          title={`Position: ${Math.round(stop.offset * 100)}%`}
                        />
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={Math.round(stop.opacity * 100)}
                          onChange={(e) => {
                            const val = Math.max(0, Math.min(100, Number(e.target.value))) / 100;
                            const next = gradientSettings.stops.map((s, i) =>
                              i === idx ? { ...s, opacity: val } : s
                            );
                            toolStoreActions.updateGradientSettings({ stops: next });
                          }}
                          className="w-9 px-1 py-0.5 bg-[#161616] text-[#e5e5e5] rounded font-mono text-right"
                          title="Stop Opacity %"
                        />
                        {gradientSettings.stops.length > 2 && (
                          <button
                            type="button"
                            onClick={() =>
                              toolStoreActions.updateGradientSettings({
                                stops: gradientSettings.stops.filter((_, i) => i !== idx),
                              })
                            }
                            className="text-[#8a8a8a] hover:text-red-400 px-0.5 cursor-pointer"
                            title="Remove Stop"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[#8a8a8a]">Repeat</span>
                  <select
                    value={gradientSettings.repeat}
                    onChange={(e) =>
                      toolStoreActions.updateGradientSettings({
                        repeat: e.target.value as GradientRepeatMode,
                      })
                    }
                    className="px-1.5 py-0.5 text-[11px] bg-[#161616] text-[#e5e5e5] rounded cursor-pointer"
                  >
                    <option value="clamp">None</option>
                    <option value="repeat">Repeat</option>
                    <option value="reflect">Reflect</option>
                  </select>
                </div>

                <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                  <span>Reverse</span>
                  <input
                    type="checkbox"
                    checked={gradientSettings.reverse}
                    onChange={(e) =>
                      toolStoreActions.updateGradientSettings({ reverse: e.target.checked })
                    }
                  />
                </label>
              </>
            ) : (
              <div className="space-y-2 pt-1 border-t border-[#2c2c2c]">
                <CompactSlider
                  label="Columns"
                  valueLabel={`${gradientSettings.meshCols}`}
                  min={2}
                  max={6}
                  value={gradientSettings.meshCols}
                  onChange={(v) => toolStoreActions.updateGradientSettings({ meshCols: v })}
                />
                <CompactSlider
                  label="Rows"
                  valueLabel={`${gradientSettings.meshRows}`}
                  min={2}
                  max={6}
                  value={gradientSettings.meshRows}
                  onChange={(v) => toolStoreActions.updateGradientSettings({ meshRows: v })}
                />

                {selectedMeshNode && activeGradientMesh?.selectedNodeIndex !== null && (
                  <div className="space-y-1.5 p-1.5 rounded bg-[#161616]">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-[#8a8a8a]">
                        Node #{activeGradientMesh!.selectedNodeIndex! + 1}
                      </span>
                      <input
                        type="color"
                        value={selectedMeshNode.color}
                        onChange={(e) =>
                          toolStoreActions.updateActiveGradientMeshNode(
                            activeGradientMesh!.selectedNodeIndex!,
                            { color: e.target.value }
                          )
                        }
                        className="w-6 h-5 bg-transparent border-0 cursor-pointer"
                      />
                    </div>
                    <CompactSlider
                      label="Node Opacity"
                      valueLabel={`${Math.round(selectedMeshNode.opacity * 100)}%`}
                      min={0}
                      max={100}
                      value={Math.round(selectedMeshNode.opacity * 100)}
                      onChange={(v) =>
                        toolStoreActions.updateActiveGradientMeshNode(
                          activeGradientMesh!.selectedNodeIndex!,
                          { opacity: v / 100 }
                        )
                      }
                    />
                  </div>
                )}

                <div className="grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    onClick={() => interactiveToolBridge.initGradientMesh?.()}
                    className="py-1 rounded bg-[#2c2c2c] text-[#e5e5e5] text-[10px] hover:bg-[#3a3a3a] cursor-pointer"
                  >
                    {activeGradientMesh ? 'Reset Mesh' : 'Create Mesh'}
                  </button>
                  {activeGradientMesh && (
                    <button
                      type="button"
                      onClick={() => interactiveToolBridge.applyGradientMesh?.()}
                      className="py-1 rounded bg-[var(--accent)] text-[var(--accent-contrast)] text-[10px] font-medium cursor-pointer"
                    >
                      Apply (Enter)
                    </button>
                  )}
                </div>
                {activeGradientMesh && (
                  <button
                    type="button"
                    onClick={() => interactiveToolBridge.cancelGradientMesh?.()}
                    className="w-full py-1 rounded bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] text-[10px] cursor-pointer"
                  >
                    Cancel (Esc)
                  </button>
                )}
              </div>
            )}

            <div className="space-y-2 pt-1 border-t border-[#2c2c2c]">
              <CompactSlider
                label="Opacity"
                valueLabel={`${Math.round(gradientSettings.opacity * 100)}%`}
                min={5}
                max={100}
                value={Math.round(gradientSettings.opacity * 100)}
                onChange={(v) => toolStoreActions.updateGradientSettings({ opacity: v / 100 })}
              />
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[#8a8a8a]">Blend</span>
                <select
                  value={gradientSettings.blendMode}
                  onChange={(e) =>
                    toolStoreActions.updateGradientSettings({
                      blendMode: e.target.value as GradientBlendMode,
                    })
                  }
                  className="px-1.5 py-0.5 text-[11px] bg-[#161616] text-[#e5e5e5] rounded cursor-pointer"
                >
                  <option value="normal">Normal</option>
                  <option value="multiply">Multiply</option>
                  <option value="screen">Screen</option>
                  <option value="overlay">Overlay</option>
                </select>
              </div>
              <div className="pt-1 border-t border-[#2c2c2c]">
                <PigmentBlendControl
                  label="Color Blending"
                  enabled={Boolean(gradientSettings.pigmentBlending)}
                  onEnabledChange={(enabled) =>
                    toolStoreActions.updateGradientSettings({ pigmentBlending: enabled })
                  }
                  primaryColor={primaryColor}
                  secondaryColor={secondaryColor}
                />
              </div>
              <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                <span>Dither</span>
                <input
                  type="checkbox"
                  checked={gradientSettings.dither}
                  onChange={(e) =>
                    toolStoreActions.updateGradientSettings({ dither: e.target.checked })
                  }
                />
              </label>
            </div>
          </div>
        );
      }

      if (currentTool === 'retouch') {
        const retouchModes: Array<{ id: RetouchMode; label: string }> = [
          { id: 'smudge', label: 'Smudge' },
          { id: 'blur', label: 'Blur' },
          { id: 'dodge', label: 'Dodge' },
          { id: 'burn', label: 'Burn' },
          { id: 'clone-stamp', label: 'Clone Stamp' },
        ];
        const strengthLabel =
          retouchSettings.mode === 'dodge' || retouchSettings.mode === 'burn'
            ? 'Exposure'
            : retouchSettings.mode === 'clone-stamp'
              ? 'Opacity'
              : 'Strength';
        return (
          <div className="p-2 space-y-3 overflow-y-auto flex-1">
            <div className="px-0.5 text-[11px] font-medium text-[#e5e5e5]">Retouch</div>
            <div className="space-y-0.5">
              {retouchModes.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toolStoreActions.updateRetouchSettings({ mode: m.id })}
                  className={`w-full px-2 py-1 rounded text-left text-[11px] transition-colors cursor-pointer ${
                    retouchSettings.mode === m.id
                      ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                      : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <CompactSlider
              label="Size"
              valueLabel={`${retouchSettings.size}px`}
              min={2}
              max={300}
              value={retouchSettings.size}
              onChange={(v) => toolStoreActions.updateRetouchSettings({ size: v })}
            />
            <CompactSlider
              label={strengthLabel}
              valueLabel={`${retouchSettings.strength}%`}
              min={1}
              max={100}
              value={retouchSettings.strength}
              onChange={(v) => toolStoreActions.updateRetouchSettings({ strength: v })}
            />
            <CompactSlider
              label="Hardness"
              valueLabel={`${retouchSettings.hardness}%`}
              min={0}
              max={100}
              value={retouchSettings.hardness}
              onChange={(v) => toolStoreActions.updateRetouchSettings({ hardness: v })}
            />
            <CompactSlider
              label="Spacing"
              valueLabel={`${Math.round(retouchSettings.spacing * 100)}%`}
              min={5}
              max={50}
              value={Math.round(retouchSettings.spacing * 100)}
              onChange={(v) => toolStoreActions.updateRetouchSettings({ spacing: v / 100 })}
            />

            <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
              <span>Pressure</span>
              <input
                type="checkbox"
                checked={retouchSettings.usePressure}
                onChange={(e) =>
                  toolStoreActions.updateRetouchSettings({ usePressure: e.target.checked })
                }
              />
            </label>

            {(retouchSettings.mode === 'smudge' || retouchSettings.mode === 'blur') && (
              <div className="space-y-2.5 pt-2 border-t border-[#2c2c2c]">
                <PigmentBlendControl
                  label="Blending"
                  strengthLabel="Pigment Strength"
                  enabled={Boolean(retouchSettings.pigmentBlending)}
                  onEnabledChange={(enabled) =>
                    toolStoreActions.updateRetouchSettings({ pigmentBlending: enabled })
                  }
                  strength={(retouchSettings.pigmentStrength ?? 100) / 100}
                  onStrengthChange={(s) =>
                    toolStoreActions.updateRetouchSettings({
                      pigmentStrength: Math.round(s * 100),
                    })
                  }
                  primaryColor={primaryColor}
                  secondaryColor={secondaryColor}
                />

                {retouchSettings.mode === 'smudge' && (
                  <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer pt-1.5 border-t border-[#2c2c2c]/70">
                    <span>Finger Painting</span>
                    <input
                      type="checkbox"
                      checked={retouchSettings.smudgeFingerPainting}
                      onChange={(e) =>
                        toolStoreActions.updateRetouchSettings({
                          smudgeFingerPainting: e.target.checked,
                        })
                      }
                    />
                  </label>
                )}
              </div>
            )}

            {(retouchSettings.mode === 'dodge' || retouchSettings.mode === 'burn') && (
              <div className="space-y-2 pt-1 border-t border-[#2c2c2c]">
                <div className="space-y-1">
                  <div className="text-[11px] text-[#8a8a8a]">Range</div>
                  <div className="grid grid-cols-3 gap-0.5 bg-[#161616] p-0.5 rounded">
                    {(
                      [
                        ['shadows', 'Shadows'],
                        ['midtones', 'Mid'],
                        ['highlights', 'High'],
                      ] as Array<[RetouchTonalRange, string]>
                    ).map(([r, lbl]) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => toolStoreActions.updateRetouchSettings({ tonalRange: r })}
                        className={`py-1 rounded text-[10px] transition-colors cursor-pointer ${
                          retouchSettings.tonalRange === r
                            ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                            : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                  <span>Protect Tones</span>
                  <input
                    type="checkbox"
                    checked={retouchSettings.protectTones}
                    onChange={(e) =>
                      toolStoreActions.updateRetouchSettings({ protectTones: e.target.checked })
                    }
                  />
                </label>
              </div>
            )}

            {retouchSettings.mode === 'clone-stamp' && (
              <div className="space-y-2 pt-1 border-t border-[#2c2c2c]">
                <button
                  type="button"
                  onClick={() => toolStoreActions.setIsPickingCloneSource(!isPickingCloneSource)}
                  className={`w-full py-1 rounded text-[11px] transition-colors cursor-pointer ${
                    isPickingCloneSource
                      ? 'bg-[var(--accent)] text-[var(--accent-contrast)] font-medium'
                      : 'bg-[#2c2c2c] text-[#e5e5e5] hover:bg-[#3a3a3a]'
                  }`}
                >
                  {isPickingCloneSource ? 'Click Canvas to Set Origin...' : 'Pick Source (Alt+Click)'}
                </button>
                <div className="text-[10px] font-mono text-[#8a8a8a]">
                  {cloneSourceAnchor
                    ? `Origin: ${Math.round(cloneSourceAnchor.x)}, ${Math.round(cloneSourceAnchor.y)}`
                    : 'No source set'}
                </div>
                <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                  <span>Aligned</span>
                  <input
                    type="checkbox"
                    checked={retouchSettings.cloneAligned}
                    onChange={(e) =>
                      toolStoreActions.updateRetouchSettings({ cloneAligned: e.target.checked })
                    }
                  />
                </label>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[#8a8a8a]">Sample</span>
                  <select
                    value={retouchSettings.cloneSampleMode}
                    onChange={(e) =>
                      toolStoreActions.updateRetouchSettings({
                        cloneSampleMode: e.target.value as CloneSampleMode,
                      })
                    }
                    className="px-1.5 py-0.5 text-[11px] bg-[#161616] text-[#e5e5e5] rounded cursor-pointer"
                  >
                    <option value="active">Active Layer</option>
                    <option value="all-visible">All Visible</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        );
      }

      if (currentTool === 'pen') {
        return (
          <div className="p-2 space-y-3 overflow-y-auto flex-1">
            <div className="px-0.5 text-[11px] font-medium text-[#e5e5e5]">Bézier Pen</div>

            <div className="grid grid-cols-2 gap-0.5 bg-[#161616] p-0.5 rounded">
              {(
                [
                  ['draw', 'Draw'],
                  ['edit', 'Edit Nodes'],
                ] as Array<[PenToolMode, string]>
              ).map(([m, lbl]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => toolStoreActions.updatePenSettings({ mode: m })}
                  className={`py-1 rounded text-[10px] transition-colors cursor-pointer ${
                    penSettings.mode === m
                      ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                      : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                  }`}
                >
                  {lbl}
                </button>
              ))}
            </div>

            <CompactSlider
              label="Stroke Width"
              valueLabel={`${penSettings.strokeWidth}px`}
              min={1}
              max={100}
              value={penSettings.strokeWidth}
              onChange={(v) => toolStoreActions.updatePenSettings({ strokeWidth: v })}
            />
            <CompactSlider
              label="Opacity"
              valueLabel={`${Math.round(penSettings.opacity * 100)}%`}
              min={5}
              max={100}
              value={Math.round(penSettings.opacity * 100)}
              onChange={(v) => toolStoreActions.updatePenSettings({ opacity: v / 100 })}
            />

            <div className="space-y-1.5 pt-1 border-t border-[#2c2c2c]">
              <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                <span>Stroke Path</span>
                <input
                  type="checkbox"
                  checked={penSettings.strokeEnabled}
                  onChange={(e) =>
                    toolStoreActions.updatePenSettings({ strokeEnabled: e.target.checked })
                  }
                />
              </label>
              <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                <span>Fill Closed Path</span>
                <input
                  type="checkbox"
                  checked={penSettings.fillEnabled}
                  onChange={(e) =>
                    toolStoreActions.updatePenSettings({ fillEnabled: e.target.checked })
                  }
                />
              </label>
              {penSettings.fillEnabled && (
                <div className="space-y-1.5">
                  <div className="grid grid-cols-3 gap-0.5 bg-[#161616] p-0.5 rounded">
                    {(
                      [
                        ['primary', 'Primary'],
                        ['secondary', 'Sub'],
                        ['custom', 'Custom'],
                      ] as const
                    ).map(([m, lbl]) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => toolStoreActions.updatePenSettings({ fillColorMode: m })}
                        className={`py-1 rounded text-[10px] transition-colors cursor-pointer ${
                          penSettings.fillColorMode === m
                            ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                            : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                        }`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                  {penSettings.fillColorMode === 'custom' && (
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono text-[#8a8a8a]">
                        {penSettings.customFillColor}
                      </span>
                      <input
                        type="color"
                        value={penSettings.customFillColor}
                        onChange={(e) =>
                          toolStoreActions.updatePenSettings({ customFillColor: e.target.value })
                        }
                        className="w-6 h-5 bg-transparent border-0 cursor-pointer"
                      />
                    </div>
                  )}
                </div>
              )}
              <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                <span>Rubber Band</span>
                <input
                  type="checkbox"
                  checked={penSettings.rubberBandPreview}
                  onChange={(e) =>
                    toolStoreActions.updatePenSettings({ rubberBandPreview: e.target.checked })
                  }
                />
              </label>
            </div>

            {activePenPointCount > 0 && (
              <div className="space-y-1.5 pt-1 border-t border-[#2c2c2c]">
                <div className="text-[10px] font-mono text-[#8a8a8a]">
                  Path: {activePenPointCount} anchor{activePenPointCount === 1 ? '' : 's'}
                  {activePenClosed ? ' (Closed)' : ''}
                </div>
                <div className="grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    onClick={() => interactiveToolBridge.toggleClosePenPath?.()}
                    disabled={activePenPointCount < 2}
                    className="py-1 rounded bg-[#2c2c2c] text-[#e5e5e5] text-[10px] disabled:opacity-40 cursor-pointer"
                  >
                    {activePenClosed ? 'Open Path' : 'Close Path'}
                  </button>
                  <button
                    type="button"
                    onClick={() => interactiveToolBridge.toggleSelectedPenAnchorSmooth?.()}
                    disabled={activePenSelectedAnchor === null}
                    className="py-1 rounded bg-[#2c2c2c] text-[#e5e5e5] text-[10px] disabled:opacity-40 cursor-pointer"
                  >
                    Smooth / Corner
                  </button>
                  <button
                    type="button"
                    onClick={() => interactiveToolBridge.deleteSelectedPenAnchor?.()}
                    className="py-1 rounded bg-[#2c2c2c] text-[#e5e5e5] text-[10px] cursor-pointer"
                  >
                    Delete Node
                  </button>
                  <button
                    type="button"
                    onClick={() => interactiveToolBridge.commitPenPath?.()}
                    disabled={activePenPointCount < 2}
                    className="py-1 rounded bg-[var(--accent)] text-[var(--accent-contrast)] text-[10px] font-medium disabled:opacity-40 cursor-pointer"
                  >
                    Commit (Enter)
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => interactiveToolBridge.cancelPenPath?.()}
                  className="w-full py-1 rounded bg-[#161616] text-[#8a8a8a] hover:text-[#e5e5e5] text-[10px] cursor-pointer"
                >
                  Cancel (Esc)
                </button>
              </div>
            )}

            <div className="text-[10px] text-[#707070] leading-relaxed pt-1 border-t border-[#2c2c2c]">
              Click: corner · Drag: handles · Alt+Drag: break · Ctrl: edit nodes · Click curve in Edit: split
            </div>
          </div>
        );
      }

      if (currentTool === 'shape') {
        const openShape = isOpenShape(shapeSettings.shape);
        const shapeOptions: Array<{ id: ShapeKind; label: string }> = [
          { id: 'rectangle', label: 'Rect' },
          { id: 'rounded-rect', label: 'Rounded' },
          { id: 'ellipse', label: 'Ellipse' },
          { id: 'triangle', label: 'Triangle' },
          { id: 'polygon', label: 'Polygon' },
          { id: 'star', label: 'Star' },
          { id: 'line', label: 'Line' },
          { id: 'arrow', label: 'Arrow' },
        ];
        return (
          <div className="p-2 space-y-3 overflow-y-auto flex-1">
            <div className="px-0.5 text-[11px] font-medium text-[#e5e5e5]">Geometric Shape</div>

            <div className="grid grid-cols-2 gap-1">
              {shapeOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => toolStoreActions.updateShapeSettings({ shape: opt.id })}
                  className={`px-2 py-1 rounded text-[11px] text-left transition-colors cursor-pointer ${
                    shapeSettings.shape === opt.id
                      ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                      : 'text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {!openShape && (
              <div className="space-y-1">
                <div className="text-[11px] text-[#8a8a8a]">Style</div>
                <div className="grid grid-cols-3 gap-0.5 bg-[#161616] p-0.5 rounded">
                  {(['stroke', 'fill', 'both'] as ShapeDrawMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => toolStoreActions.updateShapeSettings({ mode: m })}
                      className={`py-1 rounded text-[10px] capitalize transition-colors cursor-pointer ${
                        shapeSettings.mode === m
                          ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                          : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(openShape || shapeSettings.mode !== 'fill') && (
              <CompactSlider
                label="Stroke"
                valueLabel={`${shapeSettings.strokeWidth}px`}
                min={1}
                max={120}
                value={shapeSettings.strokeWidth}
                onChange={(v) => toolStoreActions.updateShapeSettings({ strokeWidth: v })}
              />
            )}

            <CompactSlider
              label="Opacity"
              valueLabel={`${Math.round(shapeSettings.opacity * 100)}%`}
              min={5}
              max={100}
              value={Math.round(shapeSettings.opacity * 100)}
              onChange={(v) => toolStoreActions.updateShapeSettings({ opacity: v / 100 })}
            />

            {!openShape && shapeSettings.mode !== 'stroke' && (
              <div className="space-y-1.5">
                <div className="text-[11px] text-[#8a8a8a]">Fill Color</div>
                <div className="grid grid-cols-3 gap-0.5 bg-[#161616] p-0.5 rounded">
                  {(
                    [
                      ['primary', 'Primary'],
                      ['secondary', 'Sub'],
                      ['custom', 'Custom'],
                    ] as Array<[ShapeFillColorMode, string]>
                  ).map(([m, lbl]) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => toolStoreActions.updateShapeSettings({ fillColorMode: m })}
                      className={`py-1 rounded text-[10px] transition-colors cursor-pointer ${
                        shapeSettings.fillColorMode === m
                          ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                          : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                      }`}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
                {shapeSettings.fillColorMode === 'custom' && (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-[#8a8a8a] font-mono">
                      {shapeSettings.customFillColor}
                    </span>
                    <input
                      type="color"
                      value={shapeSettings.customFillColor}
                      onChange={(e) =>
                        toolStoreActions.updateShapeSettings({ customFillColor: e.target.value })
                      }
                      className="w-6 h-5 bg-transparent border-0 cursor-pointer"
                    />
                  </div>
                )}
              </div>
            )}

            {shapeSettings.shape === 'rounded-rect' && (
              <CompactSlider
                label="Corner Radius"
                valueLabel={`${shapeSettings.cornerRadius}px`}
                min={0}
                max={200}
                value={shapeSettings.cornerRadius}
                onChange={(v) => toolStoreActions.updateShapeSettings({ cornerRadius: v })}
              />
            )}

            {(shapeSettings.shape === 'polygon' || shapeSettings.shape === 'star') && (
              <CompactSlider
                label={shapeSettings.shape === 'star' ? 'Points' : 'Sides'}
                valueLabel={`${shapeSettings.polygonSides}`}
                min={3}
                max={12}
                value={shapeSettings.polygonSides}
                onChange={(v) => toolStoreActions.updateShapeSettings({ polygonSides: v })}
              />
            )}

            {shapeSettings.shape === 'star' && (
              <CompactSlider
                label="Inner Ratio"
                valueLabel={`${Math.round(shapeSettings.starInnerRatio * 100)}%`}
                min={15}
                max={85}
                value={Math.round(shapeSettings.starInnerRatio * 100)}
                onChange={(v) => toolStoreActions.updateShapeSettings({ starInnerRatio: v / 100 })}
              />
            )}

            {(openShape || shapeSettings.mode !== 'fill') && (
              <div className="space-y-2 pt-1 border-t border-[#2c2c2c]">
                <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                  <span>Dashed Line</span>
                  <input
                    type="checkbox"
                    checked={shapeSettings.dashed}
                    onChange={(e) =>
                      toolStoreActions.updateShapeSettings({ dashed: e.target.checked })
                    }
                  />
                </label>
                {shapeSettings.dashed && (
                  <>
                    <CompactSlider
                      label="Dash Length"
                      valueLabel={`${shapeSettings.dashLength}px`}
                      min={2}
                      max={100}
                      value={shapeSettings.dashLength}
                      onChange={(v) => toolStoreActions.updateShapeSettings({ dashLength: v })}
                    />
                    <CompactSlider
                      label="Dash Gap"
                      valueLabel={`${shapeSettings.dashGap}px`}
                      min={2}
                      max={100}
                      value={shapeSettings.dashGap}
                      onChange={(v) => toolStoreActions.updateShapeSettings({ dashGap: v })}
                    />
                  </>
                )}

                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[#8a8a8a]">Cap</span>
                  <select
                    value={shapeSettings.lineCap}
                    onChange={(e) =>
                      toolStoreActions.updateShapeSettings({
                        lineCap: e.target.value as 'round' | 'butt' | 'square',
                      })
                    }
                    className="px-1.5 py-0.5 text-[11px] bg-[#161616] text-[#e5e5e5] rounded cursor-pointer"
                  >
                    <option value="round">Round</option>
                    <option value="butt">Flat</option>
                    <option value="square">Square</option>
                  </select>
                </div>

                {!openShape && (
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-[#8a8a8a]">Corner</span>
                    <select
                      value={shapeSettings.lineJoin}
                      onChange={(e) =>
                        toolStoreActions.updateShapeSettings({
                          lineJoin: e.target.value as 'miter' | 'round' | 'bevel',
                        })
                      }
                      className="px-1.5 py-0.5 text-[11px] bg-[#161616] text-[#e5e5e5] rounded cursor-pointer"
                    >
                      <option value="miter">Sharp</option>
                      <option value="round">Round</option>
                      <option value="bevel">Bevel</option>
                    </select>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1.5 pt-1 border-t border-[#2c2c2c]">
              <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                <span>Anti-aliasing</span>
                <input
                  type="checkbox"
                  checked={shapeSettings.antiAlias}
                  onChange={(e) =>
                    toolStoreActions.updateShapeSettings({ antiAlias: e.target.checked })
                  }
                />
              </label>
              <label
                className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer"
                title="Lock 1:1 aspect ratio or 15° angle increments (or hold Shift while dragging)"
              >
                <span>Constrain (Shift)</span>
                <input
                  type="checkbox"
                  checked={shapeSettings.constrainAspect}
                  onChange={(e) =>
                    toolStoreActions.updateShapeSettings({ constrainAspect: e.target.checked })
                  }
                />
              </label>
              <label
                className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer"
                title="Draw symmetrically from center (or hold Alt while dragging)"
              >
                <span>From Center (Alt)</span>
                <input
                  type="checkbox"
                  checked={shapeSettings.fromCenter}
                  onChange={(e) =>
                    toolStoreActions.updateShapeSettings({ fromCenter: e.target.checked })
                  }
                />
              </label>
            </div>
          </div>
        );
      }

      if (currentTool === 'liquify') {
        const activeMode = liquifySettings.mode ?? 'push';
        return (
          <div className="p-2 space-y-3 overflow-y-auto flex-1">
            <div className="px-0.5 text-[11px] font-medium text-[#e5e5e5]">Liquify</div>
            <div className="space-y-0.5">
              {LIQUIFY_MODES.map((sub) => (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => toolStoreActions.updateLiquifySettings({ mode: sub.id })}
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
              valueLabel={`${liquifySettings.size ?? 80}px`}
              min={4}
              max={500}
              value={liquifySettings.size ?? 80}
              onChange={(v) => toolStoreActions.updateLiquifySettings({ size: v })}
            />
            <CompactSlider
              label="Strength"
              valueLabel={`${liquifySettings.strength ?? 50}%`}
              min={1}
              max={100}
              value={liquifySettings.strength ?? 50}
              onChange={(v) => toolStoreActions.updateLiquifySettings({ strength: v })}
            />
            <CompactSlider
              label="Hardness"
              valueLabel={`${liquifySettings.hardness ?? 50}%`}
              min={0}
              max={100}
              value={liquifySettings.hardness ?? 50}
              onChange={(v) => toolStoreActions.updateLiquifySettings({ hardness: v })}
            />
            <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
              <span>Pressure</span>
              <input
                type="checkbox"
                checked={liquifySettings.usePressure ?? true}
                onChange={(e) =>
                  toolStoreActions.updateLiquifySettings({ usePressure: e.target.checked })
                }
              />
            </label>
            <label
              className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer"
              title="Apply Liquify simultaneously to all visible unlocked layers (or multi-selected layers / active folder)"
            >
              <span>Multi-layer</span>
              <input
                type="checkbox"
                checked={liquifySettings.multiLayer ?? false}
                onChange={(e) =>
                  toolStoreActions.updateLiquifySettings({ multiLayer: e.target.checked })
                }
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
                  onClick={() => toolStoreActions.selectTool(s.id)}
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
                onChange={(v) => toolStoreActions.updateBrushSettings({ size: v })}
              />
            )}

            {currentTool === 'select-wand' && (
              <div className="space-y-2.5 pt-1">
                <CompactSlider
                  label="Tolerance"
                  valueLabel={`${wandSettings.tolerance}`}
                  min={0}
                  max={255}
                  value={wandSettings.tolerance}
                  onChange={(v) => toolStoreActions.updateWandSettings({ tolerance: v })}
                />
                <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                  <span>Contiguous</span>
                  <input
                    type="checkbox"
                    checked={wandSettings.contiguous}
                    onChange={(e) =>
                      toolStoreActions.updateWandSettings({ contiguous: e.target.checked })
                    }
                  />
                </label>
                <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                  <span>Anti-Alias</span>
                  <input
                    type="checkbox"
                    checked={wandSettings.antiAlias}
                    onChange={(e) =>
                      toolStoreActions.updateWandSettings({ antiAlias: e.target.checked })
                    }
                  />
                </label>
                <div className="grid grid-cols-3 gap-0.5 bg-[#161616] p-0.5 rounded">
                  {(['active', 'all', 'reference'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => toolStoreActions.updateWandSettings({ referMode: mode })}
                      className={`py-0.5 rounded text-[10px] capitalize cursor-pointer ${
                        wandSettings.referMode === mode
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
              <div className="grid grid-cols-3 gap-1 pt-1">
                <button
                  type="button"
                  onClick={onCutSelection}
                  title="Cut Selection (Ctrl+X)"
                  className="py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] flex items-center justify-center gap-1 cursor-pointer"
                >
                  <Scissors className="w-3 h-3" />
                  <span>Cut</span>
                </button>
                <button
                  type="button"
                  onClick={onCopySelection}
                  title="Copy Selection (Ctrl+C)"
                  className="py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] flex items-center justify-center gap-1 cursor-pointer"
                >
                  <Copy className="w-3 h-3" />
                  <span>Copy</span>
                </button>
                <button
                  type="button"
                  onClick={onPasteSelection}
                  title="Paste to New Layer (Ctrl+V)"
                  className="py-1 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[10px] text-[#8a8a8a] hover:text-[#e5e5e5] flex items-center justify-center gap-1 cursor-pointer"
                >
                  <ClipboardPaste className="w-3 h-3" />
                  <span>Paste</span>
                </button>
              </div>
              <button
                type="button"
                onClick={onMoveSelectionToNewLayer}
                title="Move Selected Section to New Layer (Ctrl+Shift+J)"
                className="w-full py-1 px-2 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[11px] text-[var(--accent)] hover:text-[#e5e5e5] flex items-center gap-1.5 cursor-pointer"
              >
                <Layers className="w-3 h-3" />
                <span>Move to New Layer</span>
              </button>
              <button
                type="button"
                onClick={onClearSelection}
                title="Delete Selected Section (Del)"
                className="w-full py-1 px-2 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[11px] text-[#8a8a8a] hover:text-rose-400 flex items-center gap-1.5 cursor-pointer"
              >
                <Trash2 className="w-3 h-3" />
                <span>Delete Section</span>
              </button>
              <button
                type="button"
                onClick={onDeleteOutsideSelection}
                title="Delete Outside Selected Section"
                className="w-full py-1 px-2 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[11px] text-[#8a8a8a] hover:text-rose-400 flex items-center gap-1.5 cursor-pointer"
              >
                <Crop className="w-3 h-3" />
                <span>Delete Outside</span>
              </button>
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
              value={textSettings.fontFamily}
              onChange={(e) => toolStoreActions.updateTextSettings({ fontFamily: e.target.value })}
              className="w-full px-2 py-1 text-[11px]"
            >
              <option value="'Neucha', 'Anime Ace', 'Comic Sans MS', sans-serif">
                Manga / Anime
              </option>
              <option value="'Anime Ace', 'Comic Sans MS', sans-serif">Anime Ace</option>
              <option value="Arial, sans-serif">Arial</option>
              <option value="Impact, sans-serif">Impact</option>
              <option value="Georgia, serif">Georgia</option>
            </select>
            <div className="grid grid-cols-2 gap-1 bg-[#161616] p-0.5 rounded">
              <button
                type="button"
                onClick={() => toolStoreActions.updateTextSettings({ writingMode: 'horizontal-tb' })}
                className={`py-1 rounded text-[10px] cursor-pointer ${
                  textSettings.writingMode !== 'vertical-rl'
                    ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                }`}
              >
                Horiz
              </button>
              <button
                type="button"
                onClick={() => toolStoreActions.updateTextSettings({ writingMode: 'vertical-rl' })}
                className={`py-1 rounded text-[10px] cursor-pointer ${
                  textSettings.writingMode === 'vertical-rl'
                    ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                }`}
              >
                Vert
              </button>
            </div>
            <CompactSlider
              label="Font Size"
              valueLabel={`${textSettings.fontSize ?? 28}px`}
              min={12}
              max={160}
              value={textSettings.fontSize ?? 28}
              onChange={(v) => toolStoreActions.updateTextSettings({ fontSize: v })}
            />
          </div>
        );
      }

      if (currentTool === 'object') {
        return (
          <div className="p-2.5 space-y-2.5 overflow-y-auto flex-1">
            <div className="text-[11px] font-medium text-[#e5e5e5]">Object Tool</div>
            <p className="text-[10px] text-[#8a8a8a] leading-relaxed">
              Click any non-destructive Text or Speech Balloon layer on the canvas to reopen its editor without quality loss.
            </p>
          </div>
        );
      }

      if (currentTool === 'frame') {
        const frameMode = frameSettings.mode ?? 'create';
        const divideMode = frameSettings.divideMode ?? 'same-folder';
        return (
          <div className="p-2.5 space-y-3 overflow-y-auto flex-1">
            <div className="text-[11px] font-medium text-[#e5e5e5]">Frame Border Folder</div>
            <div className="grid grid-cols-2 gap-1 bg-[#161616] p-0.5 rounded">
              <button
                type="button"
                onClick={() => toolStoreActions.updateFrameSettings({ mode: 'create' })}
                className={`py-1 rounded text-[10px] cursor-pointer ${
                  frameMode === 'create'
                    ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                }`}
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => toolStoreActions.updateFrameSettings({ mode: 'divide' })}
                className={`py-1 rounded text-[10px] cursor-pointer ${
                  frameMode === 'divide'
                    ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                    : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                }`}
              >
                Divide
              </button>
            </div>

            {frameMode === 'divide' ? (
              <div className="space-y-2.5">
                <div className="text-[10px] text-[#8a8a8a]">Divide Method</div>
                <div className="grid grid-cols-1 gap-1 bg-[#161616] p-0.5 rounded">
                  <button
                    type="button"
                    onClick={() =>
                      toolStoreActions.updateFrameSettings({ divideMode: 'same-folder' })
                    }
                    className={`py-1 px-2 rounded text-left text-[10px] cursor-pointer ${
                      divideMode === 'same-folder'
                        ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                        : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                    }`}
                  >
                    Divide Frame Border (Same Folder)
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      toolStoreActions.updateFrameSettings({ divideMode: 'split-folders' })
                    }
                    className={`py-1 px-2 rounded text-left text-[10px] cursor-pointer ${
                      divideMode === 'split-folders'
                        ? 'bg-[#2c2c2c] text-[#e5e5e5] font-medium'
                        : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                    }`}
                  >
                    Divide Frame Folder (2 Folders)
                  </button>
                </div>
                <CompactSlider
                  label="Vert Gutter"
                  valueLabel={`${(frameSettings.gutterVerticalMm ?? 3.0).toFixed(1)}mm`}
                  min={0.5}
                  max={20}
                  step={0.5}
                  value={frameSettings.gutterVerticalMm ?? 3.0}
                  onChange={(v) => toolStoreActions.updateFrameSettings({ gutterVerticalMm: v })}
                />
                <CompactSlider
                  label="Horiz Gutter"
                  valueLabel={`${(frameSettings.gutterHorizontalMm ?? 5.0).toFixed(1)}mm`}
                  min={0.5}
                  max={25}
                  step={0.5}
                  value={frameSettings.gutterHorizontalMm ?? 5.0}
                  onChange={(v) => toolStoreActions.updateFrameSettings({ gutterHorizontalMm: v })}
                />
              </div>
            ) : (
              <>
                <CompactSlider
                  label="Border Width"
                  valueLabel={`${frameSettings.thickness ?? 4}px`}
                  min={1}
                  max={100}
                  value={frameSettings.thickness ?? 4}
                  onChange={(v) => toolStoreActions.updateFrameSettings({ thickness: v })}
                />
                <CompactSlider
                  label="Vert Gutter"
                  valueLabel={`${(frameSettings.gutterVerticalMm ?? 3.0).toFixed(1)}mm`}
                  min={0.5}
                  max={20}
                  step={0.5}
                  value={frameSettings.gutterVerticalMm ?? 3.0}
                  onChange={(v) => toolStoreActions.updateFrameSettings({ gutterVerticalMm: v })}
                />
                <CompactSlider
                  label="Horiz Gutter"
                  valueLabel={`${(frameSettings.gutterHorizontalMm ?? 5.0).toFixed(1)}mm`}
                  min={0.5}
                  max={25}
                  step={0.5}
                  value={frameSettings.gutterHorizontalMm ?? 5.0}
                  onChange={(v) => toolStoreActions.updateFrameSettings({ gutterHorizontalMm: v })}
                />
                <div className="grid grid-cols-2 gap-1 bg-[#161616] p-0.5 rounded">
                  <button
                    type="button"
                    onClick={() => toolStoreActions.updateFrameSettings({ fillBackground: true })}
                    className={`py-1 rounded text-[10px] cursor-pointer ${
                      frameSettings.fillBackground
                        ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                        : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                    }`}
                  >
                    White
                  </button>
                  <button
                    type="button"
                    onClick={() => toolStoreActions.updateFrameSettings({ fillBackground: false })}
                    className={`py-1 rounded text-[10px] cursor-pointer ${
                      !frameSettings.fillBackground
                        ? 'bg-[#2c2c2c] text-[#e5e5e5]'
                        : 'text-[#8a8a8a] hover:text-[#e5e5e5]'
                    }`}
                  >
                    Empty
                  </button>
                </div>
              </>
            )}
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
                  onClick={() => toolStoreActions.updateBalloonSettings({ shape })}
                  className={`w-full px-2 py-1 rounded text-left text-[11px] capitalize cursor-pointer ${
                    balloonSettings.shape === shape
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
              valueLabel={`${balloonSettings.strokeWidth ?? 3}px`}
              min={1}
              max={15}
              value={balloonSettings.strokeWidth ?? 3}
              onChange={(v) => toolStoreActions.updateBalloonSettings({ strokeWidth: v })}
            />
          </div>
        );
      }

      if (currentTool === 'vector-edit') {
        const activeMode = vectorEditSettings.mode || 'pinch';
        return (
          <div className="p-2.5 space-y-3 overflow-y-auto flex-1">
            <div className="text-[11px] font-medium text-[#e5e5e5]">Correct Line</div>
            <div className="space-y-0.5">
              {(['pinch', 'width', 'simplify'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => toolStoreActions.updateVectorEditSettings({ mode: m })}
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
              valueLabel={`${vectorEditSettings.radius ?? 30}px`}
              min={5}
              max={150}
              value={vectorEditSettings.radius ?? 30}
              onChange={(v) => toolStoreActions.updateVectorEditSettings({ radius: v })}
            />
            {activeMode === 'pinch' && (
              <CompactSlider
                label="Pinch Level"
                valueLabel={`${Math.round((vectorEditSettings.pinchStrength ?? 0.65) * 100)}%`}
                min={10}
                max={100}
                value={Math.round((vectorEditSettings.pinchStrength ?? 0.65) * 100)}
                onChange={(v) =>
                  toolStoreActions.updateVectorEditSettings({ pinchStrength: v / 100 })
                }
              />
            )}
            {activeMode === 'width' && (
              <CompactSlider
                label="Adjust Width"
                valueLabel={`${(vectorEditSettings.widthFactor ?? 1.2) >= 1 ? '+' : ''}${Math.round(((vectorEditSettings.widthFactor ?? 1.2) - 1) * 100)}%`}
                min={50}
                max={200}
                value={Math.round((vectorEditSettings.widthFactor ?? 1.2) * 100)}
                onChange={(v) =>
                  toolStoreActions.updateVectorEditSettings({ widthFactor: v / 100 })
                }
              />
            )}
            {activeMode === 'simplify' && (
              <CompactSlider
                label="Simplify"
                valueLabel={`${(vectorEditSettings.simplifyTolerance ?? 2.0).toFixed(1)}px`}
                min={0.5}
                max={12}
                step={0.5}
                value={vectorEditSettings.simplifyTolerance ?? 2.0}
                onChange={(v) =>
                  toolStoreActions.updateVectorEditSettings({ simplifyTolerance: v })
                }
              />
            )}
            <button
              type="button"
              onClick={() => uiStoreActions.setMangaEffectsModalOpen(true)}
              className="w-full py-1.5 px-2 rounded bg-[#161616] hover:bg-[#2c2c2c] text-[11px] text-[#e5e5e5] cursor-pointer"
            >
              Effect Lines...
            </button>
          </div>
        );
      }

      return (
        <div className="p-2.5 text-[11px] text-[#8a8a8a]">
          <div className="text-[#e5e5e5] font-medium capitalize mb-1">{currentTool}</div>
          <p className="leading-relaxed">Click or drag directly on the canvas.</p>
        </div>
      );
    }

    const currentAntiAlias = brushSettings.antiAlias ?? 2;
    const activeImportWarnings =
      currentTool === 'brush'
        ? activeCustomBrush?.importWarnings?.length
          ? activeCustomBrush.importWarnings
          : brushSettings.importWarnings?.length
            ? brushSettings.importWarnings
            : []
        : [];

    return (
      <>
        {/* Live S-Curve Stroke Preview + Quick Size/Opacity Bar */}
        <div className="shrink-0 bg-[#1b1b1b] border-t border-[#2a2a2a] px-2 py-1.5 space-y-1.5">
          <div className="flex items-center gap-1">
            <canvas ref={previewCanvasRef} className="flex-1 h-8 rounded bg-[#161616] block min-w-0" />
            {currentTool === 'brush' && (
              <button
                type="button"
                onClick={() => uiStoreActions.setBrushStudioModalOpen(true)}
                title="Open Brush Studio"
                className="h-8 px-1.5 rounded bg-[#262626] hover:bg-[#333333] border border-white/[0.08] text-[#d4d4d4] hover:text-white flex items-center gap-1 text-[10px] shrink-0 cursor-pointer"
              >
                <Sliders className="w-3 h-3 text-[var(--accent)]" />
                <span className="hidden sm:inline">Studio</span>
              </button>
            )}
          </div>
          {activeImportWarnings.length > 0 && (
            <div
              data-testid="brush-import-warnings-badge"
              className="rounded bg-amber-500/10 border border-amber-400/25 px-1.5 py-1 text-[10px] text-amber-200"
            >
              <button
                type="button"
                onClick={() => setWarningsExpanded((v) => !v)}
                className="w-full flex items-center justify-between gap-1 text-left cursor-pointer"
                title={activeImportWarnings.join('\n')}
              >
                <span className="flex items-center gap-1 min-w-0">
                  <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                  <span className="truncate font-medium">
                    {activeImportWarnings.length === 1
                      ? '1 CSP import notice'
                      : `${activeImportWarnings.length} CSP import notices`}
                  </span>
                </span>
                {warningsExpanded ? (
                  <ChevronDown className="w-3 h-3 shrink-0 text-amber-300" />
                ) : (
                  <ChevronRight className="w-3 h-3 shrink-0 text-amber-300" />
                )}
              </button>
              {warningsExpanded && (
                <ul className="mt-1 space-y-1 pl-4 list-disc text-[9.5px] leading-snug text-amber-100/90">
                  {activeImportWarnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
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
          {/* 1. Ink */}
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

          {/* 2. Brush Tip */}
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
                    onChange={(v) => handleUpdateTaper({ inLength: v, outLength: v })}
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
                    onChange={(e) => handleUpdateBrushSettings({ smoothing: e.target.checked })}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const def = resetBrushSettingsToDefault(
                      currentTool === 'eraser'
                        ? ERASER_PRESET_ID
                        : brushSettings.preset || DEFAULT_BRUSH_PRESET_ID,
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

          {/* 4. Color Mixing & Blending */}
          <div className="bg-[#202020]">
            <button
              type="button"
              onClick={() => toggleAccordion('mixing')}
              className="w-full px-2 py-1.5 flex items-center justify-between text-[11px] text-[#8a8a8a] hover:text-[#e5e5e5] hover:bg-[#2c2c2c]/60 transition-colors cursor-pointer"
            >
              <span>Blending &amp; Mixing</span>
              <div className="flex items-center gap-1">
                <span
                  className={`px-1.5 py-[1px] rounded-full text-[9px] font-medium border ${
                    (brushSettings.perceptualMixing ?? true)
                      ? 'bg-emerald-500/12 text-emerald-300 border-emerald-400/25'
                      : 'bg-white/[0.04] text-[#8a8a8a] border-white/[0.08]'
                  }`}
                >
                  {(brushSettings.perceptualMixing ?? true) ? 'Pigment' : 'Regular'}
                </span>
                {openAccordion === 'mixing' ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
              </div>
            </button>

            {openAccordion === 'mixing' && (
              <div className="px-2.5 pb-2.5 pt-1 space-y-2.5">
                <PigmentBlendControl
                  label="Color Blending"
                  strengthLabel="Pigment Strength"
                  enabled={brushSettings.perceptualMixing ?? true}
                  onEnabledChange={(enabled) =>
                    handleUpdateBrushSettings({
                      perceptualMixing: enabled,
                    })
                  }
                  strength={brushSettings.naturalPaint?.pigmentMixingStrength ?? 1.0}
                  onStrengthChange={(s) =>
                    handleUpdateBrushSettings({
                      perceptualMixing: true,
                      naturalPaint: {
                        ...DEFAULT_NATURAL_PAINT_SETTINGS,
                        ...(brushSettings.naturalPaint || {}),
                        pigmentMixingStrength: s,
                      },
                    })
                  }
                  primaryColor={primaryColor}
                  secondaryColor={secondaryColor}
                />
                <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer pt-1 border-t border-white/[0.06]">
                  <span>Color Mixing</span>
                  <input
                    type="checkbox"
                    checked={Boolean(brushSettings.colorMixing)}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      handleUpdateBrushSettings({
                        colorMixing: enabled,
                        ...(brushSettings.naturalPaint
                          ? { naturalPaint: { ...brushSettings.naturalPaint, spatialMixing: enabled } }
                          : {}),
                      });
                    }}
                  />
                </label>
                {brushSettings.colorMixing && (
                  <>
                    <div className={`grid ${brushSettings.naturalPaint?.enabled ? 'grid-cols-4' : 'grid-cols-3'} gap-0.5 bg-[#161616] p-0.5 rounded`}>
                      {(brushSettings.naturalPaint?.enabled
                        ? ([
                            { id: 'blend', label: 'Blend' },
                            { id: 'running_color', label: 'Running' },
                            { id: 'impasto_mix', label: 'Impasto' },
                            { id: 'smear', label: 'Smear' },
                          ] as const)
                        : ([
                            { id: 'blend', label: 'Blend' },
                            { id: 'running_color', label: 'Running' },
                            { id: 'smear', label: 'Smear' },
                          ] as const)
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
                    <CompactSlider
                      label="Amount of Paint"
                      valueLabel={`${Math.round((brushSettings.amountOfPaint ?? brushSettings.naturalPaint?.paintLoad ?? 0.7) * 100)}%`}
                      min={0}
                      max={100}
                      value={Math.round((brushSettings.amountOfPaint ?? brushSettings.naturalPaint?.paintLoad ?? 0.7) * 100)}
                      onChange={(v) => {
                        const next = v / 100;
                        handleUpdateBrushSettings({
                          amountOfPaint: next,
                          ...(brushSettings.naturalPaint
                            ? { naturalPaint: { ...brushSettings.naturalPaint, paintLoad: next } }
                            : {}),
                        });
                      }}
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
                    <label className="flex items-center justify-between text-[11px] text-[#8a8a8a] cursor-pointer">
                      <span>Optical Blur</span>
                      <input
                        type="checkbox"
                        checked={Boolean(brushSettings.useBlur)}
                        onChange={(e) => {
                          const enabled = e.target.checked;
                          handleUpdateBrushSettings({
                            useBlur: enabled,
                            ...(enabled && brushSettings.blurStrength === undefined
                              ? { blurStrength: 0.35 }
                              : {}),
                          });
                        }}
                      />
                    </label>
                    {brushSettings.useBlur && (
                      <CompactSlider
                        label="Blur Strength"
                        valueLabel={`${Math.round((brushSettings.blurStrength ?? 0.35) * 100)}%`}
                        min={5}
                        max={100}
                        value={Math.round((brushSettings.blurStrength ?? 0.35) * 100)}
                        onChange={(v) => handleUpdateBrushSettings({ blurStrength: v / 100 })}
                      />
                    )}
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
                        <option value="normal">Normal</option>
                        <option value="multiply">Multiply</option>
                        <option value="subtract">Subtract (Valley Fill)</option>
                        <option value="compare">Compare Density</option>
                        <option value="overlay">Overlay</option>
                        <option value="color-burn">Color Burn</option>
                        <option value="linear-burn">Linear Burn</option>
                        <option value="height">Height</option>
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
                      value={Math.round(
                        (brushSettings.dynamics?.foregroundBackgroundJitter ?? 0) * 100
                      )}
                      onChange={(v) =>
                        handleUpdateDynamics({ foregroundBackgroundJitter: v / 100 })
                      }
                    />
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </>
    );
  }
);

ToolPropertyInspector.displayName = 'ToolPropertyInspector';
