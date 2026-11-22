import React, { useState, useRef } from 'react';
import { Droplets, Download, Upload, RotateCcw, Copy, Save } from 'lucide-react';
import type {
  BrushCategory,
  BrushDynamics,
  BrushSettings,
  CspSensorConfig,
  ImpastoSettings,
  NaturalMixingMode,
  NaturalPaintSettings,
} from '../../types/editor';
import {
  DEFAULT_BRUSH_DYNAMICS,
  DEFAULT_IMPASTO_SETTINGS,
  DEFAULT_NATURAL_PAINT_SETTINGS,
} from '../../types/editor';
import { cleanDirtyBrush } from '../../utils/colorMixingEngine';
import { LightSourceWidget } from '../LightSourceWidget';
import { PressureCurveEditor } from '../PressureCurveEditor';
import {
  StudioSegmented,
  StudioSlider,
  StudioToggle,
} from './BrushStudioControls';
import type { BrushStudioTabProps } from './BrushStudioTabsPrimary';

export const NaturalPaintMixingTab: React.FC<BrushStudioTabProps> = ({ bs, onPatch }) => {
  const np: NaturalPaintSettings = {
    ...DEFAULT_NATURAL_PAINT_SETTINGS,
    ...(bs.naturalPaint || {}),
  };

  const patchNp = (p: Partial<NaturalPaintSettings>) => {
    onPatch({
      naturalPaint: { ...np, ...p },
      colorMixing: p.enabled !== undefined ? p.enabled : bs.colorMixing,
    });
  };

  return (
    <div className="space-y-4">
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2.5">
        <StudioToggle
          label="Enable Natural Paint & Wet Mixing"
          description="Physical per-bristle pigment mixing, load capacity & dry-brush"
          checked={Boolean(np.enabled || bs.colorMixing)}
          onChange={(v) =>
            onPatch({
              colorMixing: v,
              naturalPaint: { ...np, enabled: v },
              renderMode: v && (bs.renderMode ?? 'stamp') === 'stamp' ? 'bristle-ribbon' : bs.renderMode,
            })
          }
        />

        <StudioSegmented<NaturalMixingMode>
          label="Mixing Mode"
          value={bs.mixingMode ?? 'impasto_mix'}
          options={[
            { id: 'blend', label: 'Blend' },
            { id: 'running_color', label: 'Running' },
            { id: 'smear', label: 'Smear' },
            { id: 'impasto_mix', label: 'Impasto Mix' },
          ]}
          onChange={(m) => onPatch({ mixingMode: m })}
        />

        <StudioToggle
          label="Per-Bristle Spatial Mixing"
          description="Each bristle picks up & drags its own local canvas color streak"
          checked={np.spatialMixing}
          onChange={(v) => patchNp({ spatialMixing: v })}
        />
      </div>

      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2.5">
        <div className="text-[11px] font-medium text-[#e5e5e5]">Pigment & Reservoir Physics</div>
        <StudioSlider
          label="Kubelka-Munk Pigment Strength"
          value={Math.round(np.pigmentMixingStrength * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(np.pigmentMixingStrength * 100)}%`}
          onChange={(v) => patchNp({ pigmentMixingStrength: v / 100 })}
        />
        <StudioSlider
          label="Paint Load (0% = Pure Blender)"
          value={Math.round(np.paintLoad * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(np.paintLoad * 100)}%`}
          onChange={(v) =>
            onPatch({
              amountOfPaint: v / 100,
              naturalPaint: { ...np, paintLoad: v / 100 },
            })
          }
        />
        <StudioSlider
          label="Depletion Rate (Dry-Brush Exhaustion)"
          value={Math.round(np.depletionRate * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(np.depletionRate * 100)}%`}
          onChange={(v) => patchNp({ depletionRate: v / 100 })}
        />
        <StudioSlider
          label="Wetness / Canvas Pickup"
          value={Math.round(np.wetness * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(np.wetness * 100)}%`}
          onChange={(v) => patchNp({ wetness: v / 100 })}
        />
        <StudioSlider
          label="Viscosity (Mixing Resistance)"
          value={Math.round(np.viscosity * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(np.viscosity * 100)}%`}
          onChange={(v) => patchNp({ viscosity: v / 100 })}
        />
        <StudioSlider
          label="Color Stretch"
          value={Math.round((bs.colorStretch ?? 0.65) * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round((bs.colorStretch ?? 0.65) * 100)}%`}
          onChange={(v) => onPatch({ colorStretch: v / 100 })}
        />
        <StudioSlider
          label="Charge per Pressure"
          value={Math.round(np.chargePerPressure * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(np.chargePerPressure * 100)}%`}
          onChange={(v) => patchNp({ chargePerPressure: v / 100 })}
        />

        <div className="pt-1 border-t border-white/[0.06] flex items-center justify-between gap-2">
          <div className="flex-1">
            <StudioToggle
              label="Auto-Clean Brush After Stroke"
              description="Off = dirty brush keeps picked-up pigment across strokes"
              checked={np.autoClean}
              onChange={(v) => patchNp({ autoClean: v })}
            />
          </div>
          {!np.autoClean && (
            <button
              type="button"
              onClick={() => cleanDirtyBrush(bs.preset)}
              className="px-2 py-1 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[10px] text-sky-300 flex items-center gap-1 cursor-pointer shrink-0"
            >
              <Droplets className="w-3 h-3" />
              <span>Clean Now</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export const ImpastoWetEdgeTab: React.FC<BrushStudioTabProps> = ({ bs, onPatch }) => {
  const imp: ImpastoSettings = { ...DEFAULT_IMPASTO_SETTINGS, ...(bs.impasto || {}) };
  const np: NaturalPaintSettings = {
    ...DEFAULT_NATURAL_PAINT_SETTINGS,
    ...(bs.naturalPaint || {}),
  };

  const patchImp = (p: Partial<ImpastoSettings>) => {
    onPatch({ impasto: { ...imp, ...p } });
  };

  return (
    <div className="space-y-4">
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2.5">
        <StudioToggle
          label="Enable 3D Impasto Relief"
          description="Real-time paint heightmap with directional lighting & specular sheen"
          checked={imp.enabled}
          onChange={(v) => patchImp({ enabled: v })}
        />

        <StudioSlider
          label="Impasto Depth"
          value={Math.round(imp.depth * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(imp.depth * 100)}%`}
          onChange={(v) => patchImp({ depth: v / 100 })}
        />
        <StudioSlider
          label="Bristle Groove Relief"
          value={Math.round(imp.bristleRelief * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(imp.bristleRelief * 100)}%`}
          onChange={(v) => patchImp({ bristleRelief: v / 100 })}
        />
        <StudioSlider
          label="Gloss / Oil Sheen"
          value={Math.round(imp.gloss * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(imp.gloss * 100)}%`}
          onChange={(v) => patchImp({ gloss: v / 100 })}
        />
        <StudioSlider
          label="Relief Lighting Contrast"
          value={Math.round(imp.reliefContrast * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(imp.reliefContrast * 100)}%`}
          onChange={(v) => patchImp({ reliefContrast: v / 100 })}
        />
      </div>

      {/* Directional Light Gizmo (Reuses InkStudio LightSourceWidget) */}
      <div className="space-y-2">
        <LightSourceWidget
          embedded
          settings={{
            azimuth: imp.lightAzimuth,
            elevation: imp.lightElevation,
            intensity: 1.2,
            ambientIntensity: 0.7,
            color: '#ffffff',
            isBacklit: false,
          }}
          onChange={(next) =>
            patchImp({
              lightAzimuth: Math.max(0, Math.min(360, next.azimuth)),
              lightElevation: Math.max(5, Math.min(85, next.elevation)),
            })
          }
          onReset={() => patchImp({ lightAzimuth: 315, lightElevation: 42 })}
        />
      </div>

      {/* Watercolor Wet Edge & Paper-Valley Granulation */}
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2.5">
        <div className="text-[11px] font-medium text-[#e5e5e5]">Watercolor Wet Edge & Granulation</div>
        <StudioSlider
          label="Wet Edge Strength"
          value={Math.round((bs.wetEdge ?? 0) * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round((bs.wetEdge ?? 0) * 100)}%`}
          onChange={(v) => onPatch({ wetEdge: v / 100 })}
        />
        <StudioSlider
          label="Wet Edge Radius"
          value={Number((bs.wetEdgeRadius ?? 3.0).toFixed(1))}
          min={1}
          max={8}
          step={0.5}
          valueLabel={`${(bs.wetEdgeRadius ?? 3.0).toFixed(1)}px`}
          onChange={(v) => onPatch({ wetEdgeRadius: v })}
        />
        <StudioSlider
          label="Paper-Valley Granulation"
          value={Math.round((np.granulation ?? 0) * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round((np.granulation ?? 0) * 100)}%`}
          onChange={(v) => onPatch({ naturalPaint: { ...np, granulation: v / 100 } })}
        />
      </div>
    </div>
  );
};

type SensorTargetKey =
  | 'sizeSensor'
  | 'opacitySensor'
  | 'densitySensor'
  | 'bristleSplaySensor'
  | 'paintLoadSensor'
  | 'grainPenetrationSensor'
  | 'angleSensor'
  | 'scatterSensor';

const SENSOR_TARGETS: Array<{ key: SensorTargetKey; label: string }> = [
  { key: 'sizeSensor', label: 'Size' },
  { key: 'opacitySensor', label: 'Opacity' },
  { key: 'densitySensor', label: 'Flow / Density' },
  { key: 'bristleSplaySensor', label: 'Bristle Splay' },
  { key: 'paintLoadSensor', label: 'Paint Load' },
  { key: 'grainPenetrationSensor', label: 'Grain Penetration' },
  { key: 'angleSensor', label: 'Angle' },
  { key: 'scatterSensor', label: 'Scatter' },
];

export const DynamicsSensorMatrixTab: React.FC<BrushStudioTabProps> = ({ bs, onPatch }) => {
  const [selectedTarget, setSelectedTarget] = useState<SensorTargetKey>('sizeSensor');
  const dyn: BrushDynamics = { ...DEFAULT_BRUSH_DYNAMICS, ...(bs.dynamics || {}) };
  const sensor: CspSensorConfig = bs[selectedTarget] || {};

  const patchSensor = (p: Partial<CspSensorConfig>) => {
    onPatch({ [selectedTarget]: { ...sensor, ...p } } as Partial<BrushSettings>);
  };

  const patchDyn = (p: Partial<BrushDynamics>) => {
    onPatch({ dynamics: { ...dyn, ...p } });
  };

  return (
    <div className="space-y-4">
      {/* Unified Sensor Matrix Target Selector */}
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2.5">
        <div className="text-[11px] font-medium text-[#e5e5e5]">Sensor-to-Property Matrix</div>
        <div className="grid grid-cols-2 gap-1">
          {SENSOR_TARGETS.map((t) => {
            const cfg = bs[t.key];
            const activeCount = cfg
              ? [
                  cfg.usePressure,
                  cfg.useTilt,
                  cfg.useBarrelTwist,
                  cfg.useVelocity,
                  cfg.useDistance,
                  cfg.useRandom,
                ].filter(Boolean).length
              : 0;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setSelectedTarget(t.key)}
                className={`px-2 py-1 rounded text-[10px] flex items-center justify-between cursor-pointer ${
                  selectedTarget === t.key
                    ? 'bg-[#2c2c2c] text-[#f5f5f5] border border-[var(--accent)]/60'
                    : 'bg-[#121212] text-[#8a8a8a] hover:text-[#e5e5e5]'
                }`}
              >
                <span>{t.label}</span>
                {activeCount > 0 && (
                  <span className="px-1 rounded bg-[var(--accent)]/25 text-[9px] text-[#e5e5e5]">
                    {activeCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="pt-2 border-t border-white/[0.06] space-y-2">
          <StudioToggle
            label="Stylus Pressure"
            checked={Boolean(sensor.usePressure)}
            onChange={(v) => patchSensor({ usePressure: v })}
          />
          {sensor.usePressure && (
            <StudioSlider
              label="Minimum at Zero Pressure"
              value={Math.round((sensor.pressureMin ?? 0) * 100)}
              min={0}
              max={100}
              valueLabel={`${Math.round((sensor.pressureMin ?? 0) * 100)}%`}
              onChange={(v) => patchSensor({ pressureMin: v / 100 })}
            />
          )}

          <StudioToggle
            label="Tilt Altitude"
            checked={Boolean(sensor.useTilt)}
            onChange={(v) => {
              patchSensor({ useTilt: v });
              if (v && !bs.useTilt) onPatch({ useTilt: true });
            }}
          />
          <StudioToggle
            label="Tilt Azimuth"
            checked={Boolean(sensor.useTiltAzimuth)}
            onChange={(v) => patchSensor({ useTiltAzimuth: v })}
          />
          <StudioToggle
            label="Barrel Twist"
            checked={Boolean(sensor.useBarrelTwist)}
            onChange={(v) => patchSensor({ useBarrelTwist: v })}
          />
          <StudioToggle
            label="Stroke Velocity"
            checked={Boolean(sensor.useVelocity)}
            onChange={(v) => patchSensor({ useVelocity: v })}
          />
          <StudioToggle
            label="Stroke Distance"
            checked={Boolean(sensor.useDistance)}
            onChange={(v) => patchSensor({ useDistance: v })}
          />
          <StudioToggle
            label="Random Variance"
            checked={Boolean(sensor.useRandom)}
            onChange={(v) => patchSensor({ useRandom: v })}
          />
        </div>

        <div className="pt-2 border-t border-white/[0.06]">
          <div className="text-[10px] text-[#8a8a8a] mb-1.5">Response Curve</div>
          <PressureCurveEditor
            value={{
              enabled: true,
              preset: 'custom',
              points: sensor.pressureCurve ?? bs.pressureCurve ?? [
                [0, 0],
                [1, 1],
              ],
            }}
            onChange={(next) => {
              patchSensor({ pressureCurve: next.points });
              if (selectedTarget === 'sizeSensor') {
                onPatch({ pressureCurve: next.points });
              }
            }}
          />
        </div>
      </div>

      {/* Jitter & Color Dynamics */}
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2.5">
        <div className="text-[11px] font-medium text-[#e5e5e5]">Stamp & Color Jitter</div>
        <StudioSlider
          label="Size Jitter"
          value={Math.round(dyn.sizeJitter * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(dyn.sizeJitter * 100)}%`}
          onChange={(v) => patchDyn({ sizeJitter: v / 100 })}
        />
        <StudioSlider
          label="Angle Jitter"
          value={Math.round(dyn.angleJitter * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(dyn.angleJitter * 100)}%`}
          onChange={(v) => patchDyn({ angleJitter: v / 100 })}
        />
        <StudioSlider
          label="Scatter"
          value={Math.round(dyn.scatter * 100)}
          min={0}
          max={250}
          valueLabel={`${Math.round(dyn.scatter * 100)}%`}
          onChange={(v) => patchDyn({ scatter: v / 100 })}
        />
        <StudioToggle
          label="Enable Color Dynamics"
          checked={dyn.colorJitterEnabled}
          onChange={(v) => patchDyn({ colorJitterEnabled: v })}
        />
        {dyn.colorJitterEnabled && (
          <>
            <StudioSlider
              label="Hue Jitter"
              value={Math.round(dyn.hueJitter * 100)}
              min={0}
              max={100}
              valueLabel={`${Math.round(dyn.hueJitter * 100)}%`}
              onChange={(v) => patchDyn({ hueJitter: v / 100 })}
            />
            <StudioSlider
              label="Saturation Jitter"
              value={Math.round(dyn.saturationJitter * 100)}
              min={0}
              max={100}
              valueLabel={`${Math.round(dyn.saturationJitter * 100)}%`}
              onChange={(v) => patchDyn({ saturationJitter: v / 100 })}
            />
            <StudioSlider
              label="Lightness Jitter"
              value={Math.round(dyn.brightnessJitter * 100)}
              min={0}
              max={100}
              valueLabel={`${Math.round(dyn.brightnessJitter * 100)}%`}
              onChange={(v) => patchDyn({ brightnessJitter: v / 100 })}
            />
            <StudioSlider
              label="Temperature (Warm / Cool) Jitter"
              value={Math.round((dyn.temperatureJitter ?? 0) * 100)}
              min={0}
              max={100}
              valueLabel={`${Math.round((dyn.temperatureJitter ?? 0) * 100)}%`}
              onChange={(v) => patchDyn({ temperatureJitter: v / 100 })}
            />
            <StudioSlider
              label="Foreground / Background Mix"
              value={Math.round(dyn.foregroundBackgroundJitter * 100)}
              min={0}
              max={100}
              valueLabel={`${Math.round(dyn.foregroundBackgroundJitter * 100)}%`}
              onChange={(v) => patchDyn({ foregroundBackgroundJitter: v / 100 })}
            />
          </>
        )}
      </div>
    </div>
  );
};

export interface AboutPresetsTabProps extends BrushStudioTabProps {
  brushName: string;
  onBrushNameChange: (name: string) => void;
  category: BrushCategory | 'custom';
  onCategoryChange: (cat: BrushCategory | 'custom') => void;
  description: string;
  onDescriptionChange: (desc: string) => void;
  onResetDefault: () => void;
  onSaveAsNewPreset: () => void;
  onDuplicateBrush: () => void;
  onExportInkb: () => void;
  onImportInkb: (file: File) => void;
}

export const AboutPresetsTab: React.FC<AboutPresetsTabProps> = ({
  brushName,
  onBrushNameChange,
  category,
  onCategoryChange,
  description,
  onDescriptionChange,
  onResetDefault,
  onSaveAsNewPreset,
  onDuplicateBrush,
  onExportInkb,
  onImportInkb,
}) => {
  const importRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-4">
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-3">
        <div className="space-y-1">
          <label className="text-[11px] text-[#a3a3a3]">Brush Name</label>
          <input
            type="text"
            value={brushName}
            onChange={(e) => onBrushNameChange(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded bg-[#111111] border border-white/10 text-[12px] text-[#f5f5f5] focus:outline-none focus:border-[var(--accent)]"
          />
        </div>

        <div className="space-y-1">
          <label className="text-[11px] text-[#a3a3a3]">Category</label>
          <select
            value={category}
            onChange={(e) => onCategoryChange(e.target.value as BrushCategory | 'custom')}
            className="w-full px-2.5 py-1.5 rounded bg-[#111111] border border-white/10 text-[12px] text-[#f5f5f5]"
          >
            <option value="natural-paint">Natural Paint</option>
            <option value="brush">Brush</option>
            <option value="sketch">Sketch</option>
            <option value="pen">Pen</option>
            <option value="custom">Custom</option>
          </select>
        </div>

        <div className="space-y-1">
          <label className="text-[11px] text-[#a3a3a3]">Description</label>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="Describe this brush's physical feel, bristle setup, or surface interaction..."
            className="w-full px-2.5 py-1.5 rounded bg-[#111111] border border-white/10 text-[11px] text-[#e5e5e5] resize-none focus:outline-none focus:border-[var(--accent)]"
          />
        </div>
      </div>

      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2">
        <div className="text-[11px] font-medium text-[#e5e5e5]">Preset Actions</div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onSaveAsNewPreset}
            className="px-2.5 py-1.5 rounded bg-[var(--accent)] hover:opacity-90 text-[11px] font-medium text-white flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" />
            <span>Save as New Preset</span>
          </button>
          <button
            type="button"
            onClick={onDuplicateBrush}
            className="px-2.5 py-1.5 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[11px] text-[#e5e5e5] flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>Duplicate</span>
          </button>
          <button
            type="button"
            onClick={onExportInkb}
            className="px-2.5 py-1.5 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[11px] text-[#e5e5e5] flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export .inkb v2</span>
          </button>
          <button
            type="button"
            onClick={() => importRef.current?.click()}
            className="px-2.5 py-1.5 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[11px] text-[#e5e5e5] flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Import .inkb / .sut</span>
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".inkb,.sut"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImportInkb(f);
              e.target.value = '';
            }}
          />
        </div>
        <button
          type="button"
          onClick={onResetDefault}
          className="w-full px-2.5 py-1.5 rounded bg-[#242424] hover:bg-red-500/20 text-[11px] text-[#a3a3a3] hover:text-red-300 flex items-center justify-center gap-1.5 cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Reset Active Brush to Default</span>
        </button>
      </div>
    </div>
  );
};
