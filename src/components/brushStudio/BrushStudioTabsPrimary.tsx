import React, { useMemo, useRef } from 'react';
import { Upload, Trash2, Plus } from 'lucide-react';
import type {
  BristleProfilePreset,
  BristleSettings,
  BrushRenderMode,
  BrushSettings,
  CspAngleDynamicsMode,
  CspPaperTextureMode,
  CspTaperSettings,
  CspTipFlipMode,
  GrainMappingMode,
  SurfaceTextureId,
} from '../../types/editor';
import {
  DEFAULT_BRISTLE_SETTINGS,
  DEFAULT_NATURAL_PAINT_SETTINGS,
} from '../../types/editor';
import {
  generateNaturalTipByProfile,
  getSurfaceTextureDataUrl,
  SURFACE_TEXTURE_CATALOG,
} from '../../utils/proceduralBrushTips';
import { getPreloadedBuiltinTipImage } from '../../utils/presetBrushes';
import { PressureCurveEditor } from '../PressureCurveEditor';
import {
  readImageFileAsDataUrl,
  StudioSegmented,
  StudioSlider,
  StudioToggle,
} from './BrushStudioControls';

export interface BrushStudioTabProps {
  bs: BrushSettings;
  onPatch: (patch: Partial<BrushSettings>) => void;
}

const DEFAULT_TAPER: CspTaperSettings = {
  useIn: false,
  inLength: 24,
  inRatio: 0.9,
  useOut: false,
  outLength: 32,
  outRatio: 0.9,
  startingSharpness: 0.8,
  endingSharpness: 0.8,
  affectSize: true,
  affectDensity: false,
  affectOpacity: false,
  affectLoad: true,
};

export const ShapeBristlesTab: React.FC<BrushStudioTabProps> = ({ bs, onPatch }) => {
  const tipInputRef = useRef<HTMLInputElement>(null);
  const subTipInputRef = useRef<HTMLInputElement>(null);
  const bristle: BristleSettings = { ...DEFAULT_BRISTLE_SETTINGS, ...(bs.bristle || {}) };
  const renderMode: BrushRenderMode = bs.renderMode ?? 'stamp';

  const patchBristle = (p: Partial<BristleSettings>) => {
    onPatch({ bristle: { ...bristle, ...p } });
  };

  const applyProfilePreset = (profile: BristleProfilePreset) => {
    if (profile === 'custom') {
      patchBristle({ profile: 'custom' });
      return;
    }
    const url = generateNaturalTipByProfile(profile);
    const img = url ? getPreloadedBuiltinTipImage(url) : undefined;
    onPatch({
      bristle: { ...bristle, profile },
      customTipDataUrl: url || bs.customTipDataUrl,
      customTipImage: img || bs.customTipImage,
    });
  };

  const handleUploadTip = async (file: File) => {
    try {
      const res = await readImageFileAsDataUrl(file);
      onPatch({
        customTipDataUrl: res.dataUrl,
        customTipImage: res.image,
        bristle: { ...bristle, profile: 'custom' },
      });
    } catch {
      // ignore invalid image
    }
  };

  const handleAddSubTip = async (file: File) => {
    try {
      const res = await readImageFileAsDataUrl(file);
      const nextSubs = [
        ...(bs.subTips || []),
        { dataUrl: res.dataUrl, width: res.width, height: res.height, isColor: false },
      ].slice(0, 16);
      const nextImgs = [...(bs.subTipImages || []), res.image].slice(0, 16);
      onPatch({
        subTips: nextSubs,
        subTipImages: nextImgs,
        customTipDataUrl: bs.customTipDataUrl || res.dataUrl,
        customTipImage: bs.customTipImage || res.image,
      });
    } catch {
      // ignore
    }
  };

  const removeSubTip = (idx: number) => {
    const nextSubs = (bs.subTips || []).filter((_, i) => i !== idx);
    const nextImgs = (bs.subTipImages || []).filter((_, i) => i !== idx);
    onPatch({
      subTips: nextSubs.length > 0 ? nextSubs : undefined,
      subTipImages: nextImgs.length > 0 ? nextImgs : undefined,
    });
  };

  return (
    <div className="space-y-4">
      <StudioSegmented<BrushRenderMode>
        label="Render Mode"
        value={renderMode}
        options={[
          { id: 'stamp', label: 'Stamp' },
          { id: 'bristle-ribbon', label: 'Bristle Ribbon' },
          { id: 'bristle-hybrid', label: 'Bristle Hybrid' },
        ]}
        onChange={(mode) =>
          onPatch({
            renderMode: mode,
            naturalPaint:
              mode !== 'stamp'
                ? { ...DEFAULT_NATURAL_PAINT_SETTINGS, ...(bs.naturalPaint || {}), enabled: true }
                : bs.naturalPaint,
          })
        }
      />

      <StudioSegmented<BristleProfilePreset>
        label="Brush Tip Profile"
        value={bristle.profile}
        options={[
          { id: 'round', label: 'Round' },
          { id: 'flat', label: 'Flat' },
          { id: 'filbert', label: 'Filbert' },
          { id: 'fan', label: 'Fan' },
          { id: 'rake', label: 'Rake' },
          { id: 'knife', label: 'Knife' },
          { id: 'custom', label: 'Custom' },
        ]}
        onChange={applyProfilePreset}
      />

      {/* Primary Tip Preview & Upload */}
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] flex items-center gap-3">
        <div className="w-12 h-12 rounded bg-[#0f0f0f] border border-white/10 flex items-center justify-center overflow-hidden shrink-0">
          {bs.customTipDataUrl ? (
            <img src={bs.customTipDataUrl} alt="Tip" className="w-10 h-10 object-contain" />
          ) : (
            <div className="w-7 h-7 rounded-full bg-white/80" />
          )}
        </div>
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="text-[11px] text-[#e5e5e5] font-medium">Primary Tip Shape</div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => tipInputRef.current?.click()}
              className="px-2 py-1 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[10px] text-[#e5e5e5] flex items-center gap-1 cursor-pointer"
            >
              <Upload className="w-3 h-3" />
              <span>Upload PNG</span>
            </button>
            {bs.customTipDataUrl && (
              <button
                type="button"
                onClick={() => onPatch({ customTipDataUrl: undefined, customTipImage: undefined })}
                className="px-2 py-1 rounded bg-[#242424] hover:bg-red-500/20 text-[10px] text-[#a3a3a3] hover:text-red-300 cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>
        </div>
        <input
          ref={tipInputRef}
          type="file"
          accept="image/png,image/webp,image/jpeg"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUploadTip(f);
            e.target.value = '';
          }}
        />
      </div>

      {/* Multi-Tip List */}
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-[#e5e5e5]">
            Multi-Tip Atlas ({bs.subTips?.length ?? 0})
          </span>
          <button
            type="button"
            onClick={() => subTipInputRef.current?.click()}
            className="px-2 py-0.5 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[10px] text-[#e5e5e5] flex items-center gap-1 cursor-pointer"
          >
            <Plus className="w-3 h-3" />
            <span>Add Tip</span>
          </button>
          <input
            ref={subTipInputRef}
            type="file"
            accept="image/png,image/webp,image/jpeg"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleAddSubTip(f);
              e.target.value = '';
            }}
          />
        </div>
        {bs.subTips && bs.subTips.length > 0 && (
          <>
            <div className="flex flex-wrap gap-1.5">
              {bs.subTips.map((st, idx) => (
                <div
                  key={idx}
                  className="relative group w-9 h-9 rounded bg-[#0f0f0f] border border-white/10 flex items-center justify-center overflow-hidden"
                >
                  <img src={st.dataUrl} alt="" className="w-7 h-7 object-contain" />
                  <button
                    type="button"
                    onClick={() => removeSubTip(idx)}
                    className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 flex items-center justify-center text-red-400 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
            <StudioSegmented<'random' | 'sequential' | 'direction' | 'reverse'>
              label="Sub-Tip Order"
              value={bs.subTipOrder ?? 'sequential'}
              options={[
                { id: 'sequential', label: 'Sequential' },
                { id: 'random', label: 'Random' },
                { id: 'direction', label: 'Direction' },
                { id: 'reverse', label: 'Reverse' },
              ]}
              onChange={(order) => onPatch({ subTipOrder: order })}
            />
          </>
        )}
      </div>

      {/* Procedural Bristle Parameters */}
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2.5">
        <div className="text-[11px] font-medium text-[#e5e5e5]">Procedural Bristle Architecture</div>
        <StudioSlider
          label="Bristle Count"
          value={bristle.count}
          min={4}
          max={64}
          valueLabel={`${bristle.count} strands`}
          onChange={(v) => patchBristle({ count: v })}
        />
        <StudioSlider
          label="Bristle Clumping"
          value={Math.round(bristle.clumping * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(bristle.clumping * 100)}%`}
          onChange={(v) => patchBristle({ clumping: v / 100 })}
        />
        <StudioSlider
          label="Stiffness"
          value={Math.round(bristle.stiffness * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(bristle.stiffness * 100)}%`}
          onChange={(v) => patchBristle({ stiffness: v / 100 })}
        />
        <StudioSlider
          label="Pressure / Tilt Splay"
          value={Math.round(bristle.splay * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(bristle.splay * 100)}%`}
          onChange={(v) => patchBristle({ splay: v / 100 })}
        />
        <StudioSlider
          label="Strand Irregularity"
          value={Math.round(bristle.irregularity * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(bristle.irregularity * 100)}%`}
          onChange={(v) => patchBristle({ irregularity: v / 100 })}
        />
        <StudioSlider
          label="Edge Ridge Buildup"
          value={Math.round((bristle.edgeRidge ?? 0.2) * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round((bristle.edgeRidge ?? 0.2) * 100)}%`}
          onChange={(v) => patchBristle({ edgeRidge: v / 100 })}
        />
      </div>

      {/* Geometry & Orientation */}
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2.5">
        <div className="text-[11px] font-medium text-[#e5e5e5]">Tip Geometry</div>
        <StudioSlider
          label="Hardness"
          value={Math.round((bs.hardness ?? 0.9) * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round((bs.hardness ?? 0.9) * 100)}%`}
          onChange={(v) => onPatch({ hardness: v / 100 })}
        />
        <StudioSlider
          label="Thickness (Aspect)"
          value={Math.round((bs.thickness ?? 1.0) * 100)}
          min={5}
          max={100}
          valueLabel={`${Math.round((bs.thickness ?? 1.0) * 100)}%`}
          onChange={(v) => onPatch({ thickness: v / 100 })}
        />
        <StudioSlider
          label="Tip Angle"
          value={Math.round(bs.customTipAngle ?? 0)}
          min={-180}
          max={180}
          valueLabel={`${Math.round(bs.customTipAngle ?? 0)}°`}
          onChange={(v) => onPatch({ customTipAngle: v })}
        />
        <StudioSegmented<CspAngleDynamicsMode>
          label="Angle Dynamics"
          value={bs.customTipAngleDynamics ?? 'none'}
          options={[
            { id: 'none', label: 'Fixed' },
            { id: 'direction', label: 'Stroke' },
            { id: 'tilt', label: 'Tilt' },
            { id: 'twist', label: 'Twist' },
            { id: 'random', label: 'Random' },
          ]}
          onChange={(v) => onPatch({ customTipAngleDynamics: v })}
        />
        <div className="grid grid-cols-2 gap-2">
          <StudioSegmented<CspTipFlipMode>
            label="Flip Horizontal"
            value={bs.flipH ?? 'none'}
            options={[
              { id: 'none', label: 'Off' },
              { id: 'alternate', label: 'Alt' },
              { id: 'random', label: 'Rand' },
            ]}
            onChange={(v) => onPatch({ flipH: v })}
          />
          <StudioSegmented<CspTipFlipMode>
            label="Flip Vertical"
            value={bs.flipV ?? 'none'}
            options={[
              { id: 'none', label: 'Off' },
              { id: 'alternate', label: 'Alt' },
              { id: 'random', label: 'Rand' },
            ]}
            onChange={(v) => onPatch({ flipV: v })}
          />
        </div>
      </div>
    </div>
  );
};

export const StrokeTaperTab: React.FC<BrushStudioTabProps> = ({ bs, onPatch }) => {
  const taper: CspTaperSettings = { ...DEFAULT_TAPER, ...(bs.taper || {}) };
  const patchTaper = (p: Partial<CspTaperSettings>) => onPatch({ taper: { ...taper, ...p } });

  return (
    <div className="space-y-4">
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2.5">
        <div className="text-[11px] font-medium text-[#e5e5e5]">Stroke Path & Smoothing</div>
        <StudioSlider
          label="Spacing"
          value={Math.round((bs.spacing ?? 0.06) * 100)}
          min={2}
          max={100}
          valueLabel={`${Math.round((bs.spacing ?? 0.06) * 100)}%`}
          onChange={(v) => onPatch({ spacing: v / 100 })}
        />
        <StudioSlider
          label="Streamline / Stabilization"
          value={Math.round(bs.stabilization ?? 10)}
          min={0}
          max={50}
          valueLabel={`${Math.round(bs.stabilization ?? 10)}`}
          onChange={(v) => onPatch({ stabilization: v })}
        />
        <StudioSlider
          label="Post-Correction"
          value={Math.round(bs.postCorrection ?? 0)}
          min={0}
          max={5}
          valueLabel={`${Math.round(bs.postCorrection ?? 0)}`}
          onChange={(v) => onPatch({ postCorrection: v })}
        />
        <StudioToggle
          label="Sharp Angles"
          description="Preserve crisp corners instead of rounding"
          checked={bs.sharpCorners !== false}
          onChange={(v) => onPatch({ sharpCorners: v })}
        />
      </div>

      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2.5">
        <div className="text-[11px] font-medium text-[#e5e5e5]">Taper In & Taper Out</div>
        <StudioToggle
          label="Enable Taper In"
          checked={Boolean(taper.useIn)}
          onChange={(v) => patchTaper({ useIn: v })}
        />
        {taper.useIn && (
          <>
            <StudioSlider
              label="Taper In Length"
              value={Math.round(taper.inLength)}
              min={4}
              max={200}
              valueLabel={`${Math.round(taper.inLength)}px`}
              onChange={(v) => patchTaper({ inLength: v })}
            />
            <StudioSlider
              label="Start Sharpness"
              value={Math.round((taper.startingSharpness ?? 0.8) * 100)}
              min={0}
              max={100}
              valueLabel={`${Math.round((taper.startingSharpness ?? 0.8) * 100)}%`}
              onChange={(v) => patchTaper({ startingSharpness: v / 100 })}
            />
          </>
        )}

        <StudioToggle
          label="Enable Taper Out"
          checked={Boolean(taper.useOut)}
          onChange={(v) => patchTaper({ useOut: v })}
        />
        {taper.useOut && (
          <>
            <StudioSlider
              label="Taper Out Length"
              value={Math.round(taper.outLength)}
              min={4}
              max={250}
              valueLabel={`${Math.round(taper.outLength)}px`}
              onChange={(v) => patchTaper({ outLength: v })}
            />
            <StudioSlider
              label="End Sharpness"
              value={Math.round((taper.endingSharpness ?? 0.8) * 100)}
              min={0}
              max={100}
              valueLabel={`${Math.round((taper.endingSharpness ?? 0.8) * 100)}%`}
              onChange={(v) => patchTaper({ endingSharpness: v / 100 })}
            />
          </>
        )}

        <div className="pt-1 border-t border-white/[0.06] space-y-1">
          <StudioToggle
            label="Affect Size"
            checked={taper.affectSize !== false}
            onChange={(v) => patchTaper({ affectSize: v })}
          />
          <StudioToggle
            label="Affect Density / Opacity"
            checked={Boolean(taper.affectDensity || taper.affectOpacity)}
            onChange={(v) => patchTaper({ affectDensity: v, affectOpacity: v })}
          />
          <StudioToggle
            label="Affect Paint Load (Dry Tail)"
            checked={taper.affectLoad !== false}
            onChange={(v) => patchTaper({ affectLoad: v })}
          />
        </div>
      </div>
    </div>
  );
};

export const TextureGrainTab: React.FC<BrushStudioTabProps> = ({ bs, onPatch }) => {
  const texInputRef = useRef<HTMLInputElement>(null);
  const natural = { ...DEFAULT_NATURAL_PAINT_SETTINGS, ...(bs.naturalPaint || {}) };

  const thumbnails = useMemo(
    () =>
      SURFACE_TEXTURE_CATALOG.map((meta) => ({
        ...meta,
        url: getSurfaceTextureDataUrl(meta.id),
      })),
    []
  );

  const selectBuiltinTexture = (id: SurfaceTextureId) => {
    const url = getSurfaceTextureDataUrl(id);
    const img = url ? getPreloadedBuiltinTipImage(url) : undefined;
    onPatch({
      surfaceTextureId: id,
      paperTexture: url || undefined,
      paperTextureImage: img,
      grain: Math.max(bs.grain ?? bs.textureDensity ?? 0, 0.35),
      textureDensity: Math.max(bs.grain ?? bs.textureDensity ?? 0, 0.35),
    });
  };

  const handleUploadTexture = async (file: File) => {
    try {
      const res = await readImageFileAsDataUrl(file);
      onPatch({
        paperTexture: res.dataUrl,
        paperTextureImage: res.image,
        grain: Math.max(bs.grain ?? bs.textureDensity ?? 0, 0.45),
        textureDensity: Math.max(bs.grain ?? bs.textureDensity ?? 0, 0.45),
      });
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-4">
      {/* Built-in 512x512 Seamless Surface Texture Gallery */}
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-[#e5e5e5]">Surface Texture Library (512×512)</span>
          <button
            type="button"
            onClick={() => texInputRef.current?.click()}
            className="px-2 py-0.5 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[10px] text-[#e5e5e5] flex items-center gap-1 cursor-pointer"
          >
            <Upload className="w-3 h-3" />
            <span>Import PNG/WebP</span>
          </button>
          <input
            ref={texInputRef}
            type="file"
            accept="image/png,image/webp,image/jpeg"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUploadTexture(f);
              e.target.value = '';
            }}
          />
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {thumbnails.map((tex) => {
            const active = bs.surfaceTextureId === tex.id;
            return (
              <button
                key={tex.id}
                type="button"
                onClick={() => selectBuiltinTexture(tex.id)}
                title={tex.desc}
                className={`p-1 rounded border text-left transition-colors cursor-pointer ${
                  active
                    ? 'border-[var(--accent)] bg-[#2c2c2c]'
                    : 'border-white/[0.08] bg-[#121212] hover:border-white/25'
                }`}
              >
                <div className="w-full aspect-square rounded overflow-hidden bg-[#1e1e1e] mb-1">
                  {tex.url && (
                    <img src={tex.url} alt={tex.label} className="w-full h-full object-cover" />
                  )}
                </div>
                <div className="text-[9px] text-[#e5e5e5] truncate">{tex.label}</div>
              </button>
            );
          })}
        </div>
      </div>

      <StudioSegmented<GrainMappingMode>
        label="Spatial Grain Mapping"
        value={bs.grainMappingMode ?? 'canvas-locked'}
        options={[
          { id: 'canvas-locked', label: 'Canvas-Locked' },
          { id: 'brush-aligned', label: 'Brush-Aligned' },
          { id: 'stroke-flow', label: 'Stroke-Flow' },
          { id: 'random-per-stroke', label: 'Random' },
        ]}
        onChange={(m) => onPatch({ grainMappingMode: m })}
      />

      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2.5">
        <StudioSlider
          label="Grain Depth / Intensity"
          value={Math.round((bs.grain ?? bs.textureDensity ?? 0) * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round((bs.grain ?? bs.textureDensity ?? 0) * 100)}%`}
          onChange={(v) => onPatch({ grain: v / 100, textureDensity: v / 100 })}
        />
        <StudioSlider
          label="Dry-Brush Valley Cutoff"
          value={Math.round(natural.dryBrush * 100)}
          min={0}
          max={100}
          valueLabel={`${Math.round(natural.dryBrush * 100)}%`}
          onChange={(v) => onPatch({ naturalPaint: { ...natural, dryBrush: v / 100 } })}
        />
        <StudioSlider
          label="Scale"
          value={Math.round((bs.paperTextureScale ?? 1.0) * 100)}
          min={20}
          max={300}
          valueLabel={`${Math.round((bs.paperTextureScale ?? 1.0) * 100)}%`}
          onChange={(v) => onPatch({ paperTextureScale: v / 100 })}
        />
        <StudioSlider
          label="Rotation"
          value={Math.round(bs.paperTextureRotate ?? 0)}
          min={-180}
          max={180}
          valueLabel={`${Math.round(bs.paperTextureRotate ?? 0)}°`}
          onChange={(v) => onPatch({ paperTextureRotate: v })}
        />
        <StudioSlider
          label="Contrast"
          value={Math.round(bs.paperTextureContrast ?? 0)}
          min={-80}
          max={80}
          valueLabel={`${Math.round(bs.paperTextureContrast ?? 0)}`}
          onChange={(v) => onPatch({ paperTextureContrast: v })}
        />
        <StudioSlider
          label="Brightness"
          value={Math.round(bs.paperTextureBrightness ?? 0)}
          min={-50}
          max={50}
          valueLabel={`${Math.round(bs.paperTextureBrightness ?? 0)}`}
          onChange={(v) => onPatch({ paperTextureBrightness: v })}
        />
        <StudioSegmented<CspPaperTextureMode>
          label="Texture Blend Mode"
          value={bs.paperTextureMode ?? 'compare'}
          options={[
            { id: 'compare', label: 'Compare' },
            { id: 'multiply', label: 'Multiply' },
            { id: 'subtract', label: 'Subtract' },
            { id: 'overlay', label: 'Overlay' },
            { id: 'outline', label: 'Outline' },
          ]}
          onChange={(v) => onPatch({ paperTextureMode: v })}
        />
        <StudioToggle
          label="Invert Texture"
          checked={Boolean(bs.paperTextureInverted)}
          onChange={(v) => onPatch({ paperTextureInverted: v })}
        />
      </div>

      {/* Dual Grain Secondary Surface */}
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2.5">
        <div className="text-[11px] font-medium text-[#e5e5e5]">Secondary Dual Grain</div>
        <select
          value={bs.dualSurfaceTextureId || ''}
          onChange={(e) =>
            onPatch({
              dualSurfaceTextureId: (e.target.value || undefined) as SurfaceTextureId | undefined,
            })
          }
          className="w-full px-2 py-1 rounded bg-[#121212] border border-white/10 text-[11px] text-[#e5e5e5]"
        >
          <option value="">None</option>
          {SURFACE_TEXTURE_CATALOG.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        {bs.dualSurfaceTextureId && (
          <StudioSlider
            label="Dual Grain Depth"
            value={Math.round((bs.dualGrainDepth ?? 0.35) * 100)}
            min={0}
            max={100}
            valueLabel={`${Math.round((bs.dualGrainDepth ?? 0.35) * 100)}%`}
            onChange={(v) => onPatch({ dualGrainDepth: v / 100 })}
          />
        )}
      </div>

      {/* Pressure-to-Penetration Curve */}
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-2">
        <div className="text-[11px] font-medium text-[#e5e5e5]">Pressure-to-Valley Penetration Curve</div>
        <PressureCurveEditor
          value={{
            enabled: true,
            preset: 'custom',
            points: natural.penetrationCurve ?? [
              [0, 0],
              [1, 1],
            ],
          }}
          onChange={(next) =>
            onPatch({
              naturalPaint: {
                ...natural,
                penetrationCurve: next.points,
              },
            })
          }
        />
      </div>
    </div>
  );
};

export const DualBrushTab: React.FC<BrushStudioTabProps> = ({ bs, onPatch }) => {
  const dualInputRef = useRef<HTMLInputElement>(null);

  const handleUploadDualTip = async (file: File) => {
    try {
      const res = await readImageFileAsDataUrl(file);
      onPatch({
        dualBrush: true,
        dualTipDataUrl: res.dataUrl,
        dualTipImage: res.image,
      });
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-4">
      <div className="p-2.5 rounded bg-[#181818] border border-white/[0.06] space-y-3">
        <StudioToggle
          label="Enable Dual Brush Compositing"
          description="Modulate primary tip with a secondary tip shape"
          checked={Boolean(bs.dualBrush)}
          onChange={(v) => onPatch({ dualBrush: v })}
        />

        {bs.dualBrush && (
          <>
            <div className="flex items-center gap-3 pt-1">
              <div className="w-12 h-12 rounded bg-[#0f0f0f] border border-white/10 flex items-center justify-center overflow-hidden shrink-0">
                {bs.dualTipDataUrl ? (
                  <img src={bs.dualTipDataUrl} alt="Dual Tip" className="w-10 h-10 object-contain" />
                ) : (
                  <span className="text-[9px] text-[#6e6e6e]">None</span>
                )}
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => dualInputRef.current?.click()}
                    className="px-2 py-1 rounded bg-[#2c2c2c] hover:bg-[#383838] text-[10px] text-[#e5e5e5] flex items-center gap-1 cursor-pointer"
                  >
                    <Upload className="w-3 h-3" />
                    <span>Upload Secondary Tip</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const url = generateNaturalTipByProfile('rake');
                      const img = url ? getPreloadedBuiltinTipImage(url) : undefined;
                      onPatch({ dualTipDataUrl: url, dualTipImage: img });
                    }}
                    className="px-2 py-1 rounded bg-[#242424] hover:bg-[#323232] text-[10px] text-[#cccccc] cursor-pointer"
                  >
                    Use Rake Tip
                  </button>
                </div>
              </div>
              <input
                ref={dualInputRef}
                type="file"
                accept="image/png,image/webp,image/jpeg"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUploadDualTip(f);
                  e.target.value = '';
                }}
              />
            </div>

            <StudioSegmented<'multiply' | 'subtract' | 'darken' | 'overlay' | 'screen'>
              label="Composite Blend Mode"
              value={
                ((bs.dualBrushCompositeMode as
                  | 'multiply'
                  | 'subtract'
                  | 'darken'
                  | 'overlay'
                  | 'screen') || 'multiply')
              }
              options={[
                { id: 'multiply', label: 'Multiply' },
                { id: 'subtract', label: 'Subtract' },
                { id: 'darken', label: 'Darken' },
                { id: 'overlay', label: 'Overlay' },
                { id: 'screen', label: 'Screen' },
              ]}
              onChange={(v) => onPatch({ dualBrushCompositeMode: v })}
            />

            <StudioSlider
              label="Dual Scale"
              value={Math.round((bs.dualScale ?? 1.0) * 100)}
              min={20}
              max={300}
              valueLabel={`${Math.round((bs.dualScale ?? 1.0) * 100)}%`}
              onChange={(v) => onPatch({ dualScale: v / 100 })}
            />
            <StudioSlider
              label="Dual Angle"
              value={Math.round(bs.dualAngle ?? 0)}
              min={-180}
              max={180}
              valueLabel={`${Math.round(bs.dualAngle ?? 0)}°`}
              onChange={(v) => onPatch({ dualAngle: v })}
            />
            <StudioSlider
              label="Dual Scatter"
              value={Math.round((bs.dualScatter ?? 0) * 100)}
              min={0}
              max={200}
              valueLabel={`${Math.round((bs.dualScatter ?? 0) * 100)}%`}
              onChange={(v) => onPatch({ dualScatter: v / 100 })}
            />
            <StudioSlider
              label="Dual Spacing"
              value={Math.round((bs.dualSpacing ?? 0.1) * 100)}
              min={2}
              max={100}
              valueLabel={`${Math.round((bs.dualSpacing ?? 0.1) * 100)}%`}
              onChange={(v) => onPatch({ dualSpacing: v / 100 })}
            />
          </>
        )}
      </div>
    </div>
  );
};
