import React, { useMemo, useState } from 'react';
import {
  mixPigmentsWithStrength,
  parseColorToRgb,
  rgbToHex,
} from '../utils/colorMixingEngine';

export interface PigmentBlendControlProps {
  /** Whether physical spectral pigment blending is active (false = Regular RGB). */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** Pigment blending strength in [0, 1] (optional — omit to hide strength slider). */
  strength?: number;
  onStrengthChange?: (strength: number) => void;
  /** Optional active foreground / background colors for the live FG -> BG swatch option. */
  primaryColor?: string;
  secondaryColor?: string;
  /** Section heading label (defaults to "Color Blending"). */
  label?: string;
  /** Slider label when Pigment mode is active (defaults to "Pigment Strength"). */
  strengthLabel?: string;
  /** Layout density matching either ToolPropertyInspector ('compact') or BrushStudioModal ('studio'). */
  variant?: 'compact' | 'studio';
  /** Whether to show the live Regular vs Pigment gradient preview bar (defaults to true). */
  showPreview?: boolean;
}

interface SwatchPair {
  id: string;
  label: string;
  c1: string;
  c2: string;
}

const DEFAULT_PAIRS: readonly SwatchPair[] = [
  { id: 'blue-yellow', label: 'Blue + Yellow', c1: '#0084ff', c2: '#fff000' },
  { id: 'green-magenta', label: 'Green + Magenta', c1: '#28ff00', c2: '#ff00a6' },
  { id: 'sky-cream', label: 'Sky + Cream', c1: '#4fa8ff', c2: '#fffef0' },
];

const PREVIEW_STEPS = 14;

/**
 * Computes a CSS linear-gradient string directly from Ink Studio's 7-band Kubelka-Munk
 * spectral pigment engine so the UI swatch matches canvas blending 1:1.
 */
export function buildPigmentPreviewGradient(
  colorA: string,
  colorB: string,
  enabled: boolean,
  strength: number = 1.0
): string {
  const rgbA = parseColorToRgb(colorA);
  const rgbB = parseColorToRgb(colorB);
  const effStrength = enabled ? Math.max(0, Math.min(1, strength)) : 0;
  const stops: string[] = [];

  for (let i = 0; i <= PREVIEW_STEPS; i++) {
    const t = i / PREVIEW_STEPS;
    const mixed = mixPigmentsWithStrength(rgbA, rgbB, t, effStrength);
    const hex = rgbToHex(mixed.r, mixed.g, mixed.b);
    stops.push(`${hex} ${Math.round(t * 100)}%`);
  }

  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

export const PigmentBlendControl: React.FC<PigmentBlendControlProps> = React.memo(
  ({
    enabled,
    onEnabledChange,
    strength = 1.0,
    onStrengthChange,
    primaryColor,
    secondaryColor,
    label = 'Color Blending',
    strengthLabel = 'Pigment Strength',
    variant = 'compact',
    showPreview = true,
  }) => {
    const [pairIndex, setPairIndex] = useState<number>(0);

    const pairs = useMemo<SwatchPair[]>(() => {
      const list: SwatchPair[] = [...DEFAULT_PAIRS];
      if (
        primaryColor &&
        secondaryColor &&
        primaryColor.toLowerCase() !== secondaryColor.toLowerCase()
      ) {
        list.push({
          id: 'fg-bg',
          label: 'FG + BG',
          c1: primaryColor,
          c2: secondaryColor,
        });
      }
      return list;
    }, [primaryColor, secondaryColor]);

    const activePair = pairs[pairIndex % pairs.length] ?? DEFAULT_PAIRS[0];
    const clampedStrength = Math.max(0, Math.min(1, strength));
    const strengthPct = Math.round(clampedStrength * 100);

    const previewGradient = useMemo(
      () =>
        showPreview
          ? buildPigmentPreviewGradient(activePair.c1, activePair.c2, enabled, clampedStrength)
          : '',
      [activePair.c1, activePair.c2, enabled, clampedStrength, showPreview]
    );

    const isStudio = variant === 'studio';

    return (
      <div className={isStudio ? 'space-y-2.5' : 'space-y-1.5'}>
        {/* Header row */}
        <div className="flex items-center justify-between gap-1.5">
          <span
            className={
              isStudio
                ? 'text-[11px] font-medium text-[#d4d4d4]'
                : 'text-[11px] text-[#8a8a8a] truncate'
            }
          >
            {label}
          </span>
          <span
            className={`px-1.5 py-[1px] rounded-full text-[9px] font-medium tracking-wide border transition-colors ${
              enabled
                ? 'bg-emerald-500/12 text-emerald-300 border-emerald-400/25'
                : 'bg-white/[0.04] text-[#7a7a7a] border-white/[0.07]'
            }`}
          >
            {enabled ? 'Spectral' : 'RGB'}
          </span>
        </div>

        {/* Regular vs Pigment segmented switch */}
        <div
          role="radiogroup"
          aria-label={label}
          className={`grid grid-cols-2 gap-0.5 rounded p-0.5 border ${
            isStudio
              ? 'bg-[#141414] border-white/[0.06]'
              : 'bg-[#161616] border-white/[0.05]'
          }`}
        >
          <button
            type="button"
            role="radio"
            aria-checked={!enabled}
            onClick={() => onEnabledChange(false)}
            className={`flex items-center justify-center gap-1.5 rounded transition-all cursor-pointer ${
              isStudio ? 'py-1.5 text-[11px]' : 'py-1 text-[10px]'
            } ${
              !enabled
                ? 'bg-[#2c2c2c] text-[#f2f2f2] font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
                : 'text-[#8a8a8a] hover:text-[#e0e0e0] hover:bg-white/[0.03]'
            }`}
          >
            <span
              className="w-2 h-2 rounded-full shrink-0 border border-white/15"
              style={{
                background: 'linear-gradient(135deg, #3b82f6 0%, #9ca3af 50%, #facc15 100%)',
                opacity: !enabled ? 0.9 : 0.45,
              }}
            />
            <span>Regular</span>
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={enabled}
            onClick={() => onEnabledChange(true)}
            className={`flex items-center justify-center gap-1.5 rounded transition-all cursor-pointer ${
              isStudio ? 'py-1.5 text-[11px]' : 'py-1 text-[10px]'
            } ${
              enabled
                ? 'bg-[#2c2c2c] text-[#f5f5f5] font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.10)] ring-1 ring-emerald-400/25'
                : 'text-[#8a8a8a] hover:text-[#e0e0e0] hover:bg-white/[0.03]'
            }`}
          >
            <span
              className="w-2 h-2 rounded-full shrink-0 border border-white/20"
              style={{
                background: 'linear-gradient(135deg, #0084ff 0%, #34c759 50%, #fff000 100%)',
                boxShadow: enabled ? '0 0 6px rgba(52, 199, 89, 0.55)' : 'none',
                opacity: enabled ? 1 : 0.55,
              }}
            />
            <span>Pigment</span>
          </button>
        </div>

        {/* Live engine-rendered Regular vs Pigment swatch preview */}
        {showPreview && (
          <button
            type="button"
            onClick={() => setPairIndex((i) => (i + 1) % pairs.length)}
            title={`${activePair.label} (${enabled ? `Pigment ${strengthPct}%` : 'Regular RGB'}) — Click to cycle preview colors`}
            className="group relative w-full rounded overflow-hidden border border-white/[0.10] hover:border-white/[0.22] transition-all cursor-pointer block focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
            style={{ height: isStudio ? 22 : 17 }}
          >
            <div
              className="w-full h-full transition-[background] duration-200"
              style={{ background: previewGradient }}
            />
            <div
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'linear-gradient(180deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 45%, rgba(0,0,0,0.18) 100%)',
              }}
            />
            <div className="pointer-events-none absolute inset-x-1.5 inset-y-0 flex items-center justify-between">
              <span className="text-[9px] font-medium text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)] opacity-80 group-hover:opacity-100 transition-opacity">
                {activePair.label}
              </span>
              <span className="text-[8.5px] font-mono uppercase tracking-wider text-white/90 bg-black/35 px-1 rounded backdrop-blur-[2px] opacity-85 group-hover:opacity-100 transition-opacity">
                {enabled ? 'Pigment' : 'Regular'}
              </span>
            </div>
          </button>
        )}

        {/* Pigment Strength slider (only shown when Pigment mode is active & callback provided) */}
        {enabled && onStrengthChange && (
          <div className="space-y-1 pt-0.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className={isStudio ? 'text-[#a3a3a3]' : 'text-[#8a8a8a] truncate'}>
                {strengthLabel}
              </span>
              <span className="font-mono text-[10px] text-[#e5e5e5] ml-1 shrink-0">
                {strengthPct}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={strengthPct}
              onChange={(e) => onStrengthChange(Number(e.target.value) / 100)}
              className={`w-full ${isStudio ? 'accent-[var(--accent)]' : ''}`}
            />
          </div>
        )}
      </div>
    );
  }
);
