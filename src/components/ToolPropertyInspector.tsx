import React, { useState, useRef, useEffect } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Scaling,
  Maximize2,
  Minimize2,
  RotateCcw,
  Feather,
} from 'lucide-react';
import {
  BrushSettings,
  BrushPresetId,
  CspBrush,
  BrushDynamics,
  DEFAULT_BRUSH_DYNAMICS,
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
} from '../types/editor';
import { isOpenShape } from '../utils/shapeEngine';
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
import { useToolStore, toolStoreActions, useUiStore, uiStoreActions } from '../stores';

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
    const balloonSettings = useToolStore((s) => s.balloonSettings);
    const vectorEditSettings = useToolStore((s) => s.vectorEditSettings);
    const wandSettings = useToolStore((s) => s.wandSettings);
    const isHidden = useUiStore((s) => s.isLeftPanelHidden);

    const [openAccordion, setOpenAccordion] = useState<InspectorAccordionId | null>(null);
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);

    const isBrushOrEraser = currentTool === 'brush' || currentTool === 'eraser';

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
            opacity: brushSettings.opacity,
            grain: brushSettings.grain,
            paperTextureMode: brushSettings.paperTextureMode,
            paperTextureScale: brushSettings.paperTextureScale,
            paperTextureContrast: brushSettings.paperTextureContrast,
            paperTextureBrightness: brushSettings.paperTextureBrightness,
            paperTextureInverted: brushSettings.paperTextureInverted,
            hardness: brushSettings.hardness,
            spacing: brushSettings.spacing,
            minSizeFactor: brushSettings.minSizeFactor,
            usePressure: brushSettings.usePressure,
            color: currentTool === 'eraser' ? '#e5e5e5' : '#ececec',
            backgroundColor: '#161616',
            tool: currentTool === 'eraser' ? 'eraser' : 'brush',
            customTipImage: resolvedTip,
            customTipAngle: brushSettings.customTipAngle,
            customTipAngleDynamics: brushSettings.customTipAngleDynamics,
            thickness: brushSettings.thickness,
            thicknessVertical: brushSettings.thicknessVertical,
            flipH: brushSettings.flipH,
            flipV: brushSettings.flipV,
            blendTipsMode: brushSettings.blendTipsMode,
            adjustDensityByGap: brushSettings.adjustDensityByGap,
            antiAlias: brushSettings.antiAlias,
            pressureCurve: brushSettings.pressureCurve,
            spray: brushSettings.spray,
            dynamics: brushSettings.dynamics,
            colorMixing: brushSettings.colorMixing,
            amountOfPaint: brushSettings.amountOfPaint,
            densityOfPaint: brushSettings.densityOfPaint,
            colorStretch: brushSettings.colorStretch,
            wetEdge: brushSettings.wetEdge,
          },
          true
        );
      };
      const rafId = requestAnimationFrame(drawPreview);
      return () => {
        cancelAnimationFrame(rafId);
        loadListenerCleanup?.();
      };
    }, [isHidden, isBrushOrEraser, width, currentTool, brushSettings]);

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
          mixingMode: newSettings.mixingMode ?? activeCustomBrush.mixingMode,
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

    return (
      <>
        {/* Live S-Curve Stroke Preview + Quick Size/Opacity Bar */}
        <div className="shrink-0 bg-[#1b1b1b] border-t border-[#2a2a2a] px-2 py-1.5 space-y-1.5">
          <canvas ref={previewCanvasRef} className="w-full h-8 rounded bg-[#161616] block" />
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
